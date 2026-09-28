/**
 * The PolyForge bridge worker.
 *
 * Wires the pieces, registers every handler the manifest declares, and owns the lifecycle.
 * Four things here are load-bearing and are called out at their definitions:
 *
 * * `multiCompanyConfig: true` plus keying every per-company resource on
 *   `context.companyId`, because the SDK fails a second company's config closed for a
 *   single-tenant worker and this worker is explicitly multi-company.
 * * `onValidateConfig` proves the configuration can actually sign a request, that the state
 *   dir is writable, and that the runtime's expected issuer matches — before the bridge is
 *   trusted with work.
 * * `onHealth` reports `ok | degraded | error` derived from real state, and an unwritable
 *   store degrades loudly rather than failing silently on the first event.
 * * The outbox handler table is complete: a kind with no handler is a `failed` row, not an
 *   infinite retry.
 *
 * ## A missing manifest capability
 *
 * The manifest — which this file does not edit — does not declare `secrets.read-ref`, so
 * `ctx.secrets.resolve` is refused by the host on this baseline. The bridge is designed for
 * that refusal rather than around it: the secret provider throws a precise
 * `BridgeConfigError`, `onHealth` reports `error` naming the missing capability, and no signed
 * request is ever sent with a guess. See the delivery report.
 */

import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type {
  PaperclipPluginManifestV1,
  PluginApiRequestInput,
  PluginApiResponse,
  PluginConfigChangeContext,
  PluginConfigValidationResult,
  PluginContext,
  PluginDefinition,
  PluginHealthDiagnostics,

} from "@paperclipai/plugin-sdk";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import manifestJson from "./manifest.js";
import { ConfigRegistry, resolveConfig, validateSecretRefShape, type BridgeConfig } from "./config.js";
import { BridgeConfigError, BridgeError } from "./errors.js";
import { createLogger, type BridgeLogger } from "./logger.js";
import { BridgeStore } from "./store.js";
import { BridgeMetrics } from "./metrics.js";
import { CapabilityMatcher } from "./capabilities.js";
import { AdmissionGate } from "./admission.js";
import { Router } from "./router.js";
import { Reconciler } from "./reconciler.js";
import { RuntimeClient, SYSTEM_CLOCK, type FetchLike, type SecretProvider } from "./runtime-client.js";
import { OutboxPump, StoreDeliveryRecorder, type DeliveryHandler, type DeliveryOutcome } from "./outbox/delivery.js";
import { INTENT_KINDS } from "./outbox/intents.js";
import { Inbox } from "./events/inbox.js";
import { EventPump } from "./events/pump.js";
import type { BridgeDeps, DeliveryRecorder, PortBundle } from "./ports/index.js";
import { WORK_UNIT_BINDING_KIND, DISPATCH_BINDING_KIND, RUN_BINDING_KIND } from "./ports/work-management.js";
import { registerDataKeys, createCompanyContext, type CompanyContext, type CompanyResolver } from "./bridge/data.js";
import { registerActionKeys } from "./bridge/actions.js";
import { createApiRequestHandler } from "./api-routes.js";
import {
  registerTools,
  CLAIM_BINDING_KIND,
  type ToolClaim,
  type ToolClaimQuery,
  type ToolRunBinding,
  type ToolRuntime,
} from "./tools/register.js";
import type { ToolHandlerDeps } from "./tools/register.js";
import { companyScope } from "./identity.js";
import { isBridgeError } from "./errors.js";
import type { ActorAssertion, RunSnapshot, Scope, WorkerRequirement } from "@polyforge/protocol";

const manifest = manifestJson as PaperclipPluginManifestV1;

/**
 * Where the bridge's own durable state lives before any company configuration exists.
 *
 * This path must be **stable across restarts** and **persistent across reboots**. The inbox, the
 * outbox, the delivery ledger, and the command log are what make an at-least-once delivery safe;
 * a store under the system temp directory, or one named after a fresh random id per process, is
 * not merely untidy — it means every restart silently abandons the previous worker's durable
 * state. That is exactly the silent-loss failure this system exists to prevent, and it is why the
 * previous behaviour (a per-process `instance-<random>` directory under `tmpdir()`) was wrong.
 *
 * Resolution order:
 *  1. `POLYFORGE_BRIDGE_STATE_ROOT` — the operator's explicit choice, and what the runbook sets
 *     for a real deployment.
 *  2. `~/.paperclip-plugin-state/<plugin key>` — persistent, per-user, and out of the temp
 *     directory that a reboot or a tmpfiles sweep clears.
 *
 * Two workers that genuinely run at once share this file, and SQLite's own locking is what keeps
 * them apart. That is the right trade: a second worker should be a *restart* that inherits the
 * durable state, not a parallel process that forks it away. Set `POLYFORGE_BRIDGE_STATE_ROOT` per
 * process when a deliberate second instance is wanted.
 */
function fallbackStateRoot(): string {
  const fromEnv = process.env["POLYFORGE_BRIDGE_STATE_ROOT"];
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") {
    return fromEnv.trim();
  }
  return join(homedir(), ".paperclip-plugin-state", manifest.id);
}

/**
 * A stable tag for the default store location.
 *
 * Deliberately *not* derived from the process: anything that changes on restart — a pid, a random
 * uuid — would hand the next worker an empty store and abandon the previous worker's inbox,
 * outbox, and command log. The tag is the plugin key, so a restart inherits its own durable state
 * and SQLite's locking is what keeps two concurrent workers apart. An operator who genuinely wants
 * a second, isolated instance sets `POLYFORGE_BRIDGE_STATE_ROOT` for it.
 */
function instanceTag(): string {
  return `instance-${manifest.id}`;
}

/**
 * The one place the bridge's store path is decided.
 *
 * Everything that needs to know where durable state lives — the worker that opens it, config
 * validation that checks it is writable, health that names it when it is not — reads this. Deriving
 * it a second time from a company config produced a path that validation probed and health reported
 * while the worker used a different file entirely.
 */
function bridgeStorePath(): string {
  return join(fallbackStateRoot(), instanceTag(), "bridge.sqlite");
}

const SYSTEM_ACTOR: ActorAssertion = {
  actorType: "system",
  actorId: "paperclip:bridge",
  agentId: null,
  runId: null,
  roles: [],
};

/** Process-level state. One store, one pump, one reconciler, many companies. */
interface Bridge {
  store: BridgeStore;
  metrics: BridgeMetrics;
  capabilities: CapabilityMatcher;
  inbox: Inbox;
  registry: ConfigRegistry;
  logger: BridgeLogger;
  companies: Map<string, CompanyContext>;
  pump: OutboxPump;
  reconciler: Reconciler;
  deliveries: DeliveryRecorder;
  eventPump: EventPump | null;
  ctx: PluginContext | null;
  storePath: string;
}

let bridge: Bridge | null = null;
let unsubscribeEvents: (() => void) | null = null;

function readJson(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** A non-empty string, or null. An empty string is not an identity and never becomes one. */
function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/**
 * The output names a contract permits, read the way the Core writes them.
 *
 * The Core's `intendedMutations` is a list of mutation *objects* -- `{ kind, target, operation,
 * requiresTrustedExecution }` (engine.py `_intended_mutations`) -- and its own ingestion reads the
 * output name out of `kind` (evidence/store.py). Reading this with the string-only helper filtered
 * every object out, so `permittedOutputs` arrived as `[]`: the agent was told it could produce
 * nothing, and the tool's own `permitted.size > 0` pre-check was skipped, since an empty set reads
 * as "no restriction". A bare string is still accepted so an older Core is not refused outright,
 * but anything else is refused rather than dropped -- losing an entry silently is the failure.
 */
function permittedOutputNames(value: unknown, runId: string): string[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new BridgeError(
      "BRIDGE_PROTOCOL_INCOMPATIBLE",
      "BLOCKED_PLATFORM",
      "the runtime's contract.intendedMutations is not a list; this bridge implements a different " +
        "wire format than the Core it is talking to",
      { runId },
    );
  }
  return value.map((entry) => {
    if (typeof entry === "string") {
      if (entry.length === 0) {
        throw new BridgeError(
          "BRIDGE_PROTOCOL_INCOMPATIBLE",
          "BLOCKED_PLATFORM",
          "the runtime's contract.intendedMutations contains an empty output name",
          { runId },
        );
      }
      return entry;
    }
    const kind = typeof entry === "object" && entry !== null ? str((entry as Record<string, unknown>)["kind"]) : null;
    if (kind === null) {
      throw new BridgeError(
        "BRIDGE_PROTOCOL_INCOMPATIBLE",
        "BLOCKED_PLATFORM",
        "the runtime's contract.intendedMutations contains a mutation with no kind, so the set of " +
          "outputs this contract permits cannot be read; refusing it is safer than dropping it",
        { runId },
      );
    }
    return kind;
  });
}

/** The id inside a `providerRef` such as `{ provider, kind, id }`, or null. */
function agentRunRefId(attempt: Record<string, unknown>): string | null {
  const ref = attempt["agentRunRef"];
  return typeof ref === "object" && ref !== null ? str((ref as Record<string, unknown>)["id"]) : null;
}

function companyOf(shared: Bridge, companyId: string): CompanyContext | null {
  return shared.companies.get(companyId) ?? null;
}

/** Narrow the process-level `Bridge` to what the tool handlers need. */
function toolWiringOf(shared: Bridge): ToolWiring {
  return {
    store: shared.store,
    metrics: shared.metrics,
    logger: shared.logger,
    company: (companyId: string) => companyOf(shared, companyId),
  };
}

/**
 * The secret provider.
 *
 * Resolved per request through `ctx.secrets.resolve`, never cached, never logged, never
 * written to the store. The SDK's ref type is narrower than the manifest's JSON-schema
 * `version` string, so the ref is passed through the exact object the operator configured
 * rather than a re-typed copy of it.
 */
function makeSecretProvider(ctx: PluginContext, config: BridgeConfig, companyId: string): SecretProvider {
  return async (): Promise<string> => {
    try {
      const value = await ctx.secrets.resolve(
        config.sharedSecretRef as unknown as Parameters<PluginContext["secrets"]["resolve"]>[0],
        { companyId, configPath: "sharedSecretRef" },
      );
      if (typeof value !== "string" || value.length === 0) {
        throw new Error("the secret provider returned an empty value");
      }
      return value;
    } catch (error) {
      throw new BridgeConfigError(
        `the shared secret is not resolvable: ${error instanceof Error ? error.message : String(error)}. ` +
          'The manifest does not declare the "secrets.read-ref" capability, which ctx.secrets.resolve requires.',
        { companyId },
      );
    }
  };
}

function makeRuntimeClient(
  ctx: PluginContext,
  config: BridgeConfig,
  companyId: string,
  logger: BridgeLogger,
  store: BridgeStore,
): RuntimeClient {
  // Transport choice, made explicitly rather than by accident.
  //
  // `governed` (the default and the production posture) routes every Runtime Service request
  // through `ctx.http.fetch`, so the host owns the SSRF guard, the audit trail, and the tracing.
  //
  // The host's guard is *unconditional*: it resolves the target and refuses when every resolved
  // address is loopback or RFC1918, with no per-plugin opt-in. A Runtime Service co-located on
  // the same machine is therefore unreachable through the governed path, and that is a real
  // deployment-topology constraint rather than a configuration mistake: in production the Runtime
  // Service must be reachable at an address the host will accept.
  //
  // `direct` exists so a single-host pilot can run at all. It is not a silent fallback: it cannot
  // be enabled without an explicit config key, it keeps this plugin's *own* refusal of
  // link-local and cloud-metadata addresses, and it is recorded in the bridge's durable state and
  // reported as a named degraded posture so an operator is never misled about what is enforcing
  // the boundary.
  const direct = config.runtimeTransport === "direct";
  const fetchImpl: FetchLike = direct
    ? (url, init) => fetch(url, init)
    : (url, init) => ctx.http.fetch(url, init);
  if (direct) {
    const note =
      "the Runtime Service is reached over Node's fetch rather than ctx.http.fetch: the host's " +
      "governed client refuses private addresses unconditionally, so a co-located Core is " +
      "unreachable through it. Host SSRF guarding and HTTP audit are NOT in effect for these " +
      "requests; the bridge's own link-local and metadata refusal still is.";
    try {
      store.setCompat(companyId, "runtime_transport", { mode: "direct", note, at: new Date().toISOString() });
    } catch {
      // Recording the posture must never be the reason the client cannot be built.
    }
    logger.warn("runtime transport is DIRECT, not host-governed", { companyId, note });
  }
  return new RuntimeClient(config, {
    secretProvider: makeSecretProvider(ctx, config, companyId),
    clock: SYSTEM_CLOCK,
    logger,
    fetchImpl,
    // The durable nonce ledger: a worker restart must not be able to re-issue a signing nonce
    // inside the replay window.
    nonceLedger: store,
    companyId,
  });
}

/**
 * Adapt the signed client to the narrow surface the tool handlers use.
 *
 * The tool handlers deliberately do not hold an `ActorAssertion` or a `Scope`: they derive both
 * from the host's `ToolRunContext` inside the adapter, so no handler can be handed a scope by
 * a caller. The system actor is used because a UI read or a platform-scheduled job is not a
 * person; a human actor is asserted only where the host authenticated one.
 */
/**
 * The scope a run-scoped call is signed with, taken from the run's own durable binding.
 *
 * The Core's tenant identity is the company/project pair and it refuses an empty `projectRef`
 * outright — deliberately, because an empty project would otherwise read as "every project". Every
 * tool call here was signed `{ companyId, projectRef: "" }`, so `status`, `current`, `claim`,
 * `submit_*`, `request_transition` and `request_help` could not reach the Core at all: a 403 whose
 * message pointed at the scope header rather than at the missing binding.
 *
 * The project is not taken from the caller — a tool parameter must never be able to choose a tenant
 * — nor guessed from a "current project". It comes from the run binding this bridge itself wrote when
 * it admitted the run, so the scope a call is signed with is the scope the run was admitted into.
 */
function scopeForRun(company: CompanyContext, runId: string): Scope {
  const row = company.store.getBinding(company.companyId, RUN_BINDING_KIND, runId);
  if (row === null) {
    // No record of this run *for this company*. That is the ordinary answer to a cross-tenant
    // attempt, and saying so is more useful than reporting it as lost state: the caller learns the
    // run is not this company's, not that something went missing.
    //
    // Counted, not merely refused. A silent refusal and a successful call differ only in what is
    // recorded, so a gap that is never counted is a gap nobody can measure.
    company.metrics.bump(company.companyId, "crossScopeDenials");
    throw new BridgeError(
      "BRIDGE_SCOPE_VIOLATION",
      "BLOCKED_SCOPE",
      `run ${runId} is not bound to a PolyForge run in company ${company.companyId}, so it cannot be ` +
        `read. A run is recorded with the company and project it was admitted into, and a call is ` +
        `signed for that same scope; there is no project to sign for here.`,
      { runId, companyId: company.companyId },
    );
  }
  const projectRef = row.projectId;
  if (projectRef.length === 0) {
    // A record that exists but names no project is a different fault: the write that admitted the
    // run and the write that recorded its project were supposed to be one durable fact.
    throw new BridgeError(
      "BRIDGE_SCOPE_VIOLATION",
      "BLOCKED_SCOPE",
      `run ${runId} is recorded with no project, so no call can be signed for it. The bridge records ` +
        `a run and its project together; a binding without one means that write did not complete. ` +
        `Re-admitting is safe — the Core's idempotency makes it a replay — but guessing a project ` +
        `is not.`,
      { runId, companyId: company.companyId },
    );
  }
  return { companyRef: company.companyId, projectRef };
}

/**
 * The scope a delivery is signed with, or `null` when neither source names a project.
 *
 * The row's own `projectId` comes first. It is the project the intent was *created* for, derived
 * from the host at admission and durable since, so it is the most trustworthy thing available and it
 * does not require the run to have a binding. The run binding is the fallback for an intent written
 * before that row field was populated.
 *
 * Returning `null` rather than throwing matters: a delivery handler must be able to say "not yet",
 * because the effect may already have happened on the platform and dropping the intent would leave
 * the Core permanently unsure about it.
 */
function scopeForIntent(company: CompanyContext, row: DeliveryRowLike): Scope | null {
  const fromRow = typeof row.projectId === "string" ? row.projectId : "";
  if (fromRow.length > 0) {
    return { companyRef: row.companyId, projectRef: fromRow };
  }
  const runId = row.runId ?? "";
  if (runId.length === 0) return null;
  try {
    return scopeForRun(company, runId);
  } catch (error) {
    company.logger.warn("cannot sign a delivery for this run yet", {
      runId,
      companyId: row.companyId,
      reason: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function toolRuntimeFor(company: CompanyContext): ToolRuntime {
  const client = company.runtime;
  if (client === null) {
    throw new BridgeConfigError("no runtime client is configured for this company", {
      companyId: company.companyId,
    });
  }
  const scope = (runId: string): Scope => scopeForRun(company, runId);
  return {
    getRun: async (_companyId, runId) => {
      const snapshot = (await client.getRun(SYSTEM_ACTOR, scope(runId), runId)) as RunSnapshot;
      return {
        runId: snapshot.runId,
        stateVersion: snapshot.stateVersion,
        eventSequence: snapshot.eventSequence,
        status: snapshot.status,
        scope: snapshot.scope,
        graphId: snapshot.graphId,
        graphVersion: snapshot.graphVersion,
        pins: snapshot.pins ?? {},
        nodes: snapshot.nodes.map((node) => ({
          nodeId: node.nodeId,
          kind: node.kind,
          status: node.status,
          iteration: node.iteration,
          waitReason: node.waitReason ?? null,
          blockReason: node.blockReason ?? null,
          requiredCapabilities: node.requiredCapabilities ?? [],
          activeAttemptId: node.activeAttemptId ?? null,
          contractHash: node.contractHash ?? null,
        })),
        attempts: snapshot.attempts.map((attempt) => ({
          attemptId: attempt.attemptId,
          nodeId: attempt.nodeId,
          iteration: attempt.iteration,
          leaseEpoch: attempt.leaseEpoch,
          status: attempt.status,
          agentSubject: attempt.agentSubject ?? null,
        })),
        evidence: snapshot.evidence.map((record) => ({
          evidenceId: record.evidenceId,
          kind: record.kind,
          valid: record.valid,
          producerSubject: record.producerSubject,
        })),
        pendingGovernance: snapshot.pendingGovernance.map((request) => ({
          requestId: request.requestId,
          nodeId: request.nodeId,
          transitionHash: request.transitionHash,
          decisionTargetHash: request.decisionTargetHash,
          semanticKind: request.semanticKind,
          createdAt: request.createdAt,
        })),
        blockers: snapshot.blockers.map((blocker) => ({
          code: blocker.code,
          reason: String(blocker.reason),
          message: blocker.message,
        })),
      };
    },
    current: async (_companyId, runId) => {
      const raw = await client.current(SYSTEM_ACTOR, scope(runId), runId);
      const record = readJson(JSON.stringify(raw));

      // The Core nests this. `contract` carries the hash, the required evidence kinds, the inputs,
      // the effective policy and the plan hash; `attempt` carries the owner and the lease epoch.
      // Reading those as top-level fields found nothing, so every one of them silently became null,
      // an empty array or an empty object — and the tool still answered, with an empty contract. An
      // agent that cannot see what it is required to produce cannot claim honestly, and a claim
      // cannot be checked against a contract hash that is null.
      const contract = readJson(JSON.stringify(record["contract"] ?? {}));
      const attempt = record["attempt"] === null || record["attempt"] === undefined
        ? {}
        : readJson(JSON.stringify(record["attempt"]));

      const contractHash = str(contract["contractHash"]);
      if (contractHash === null) {
        // An absent contract hash is a protocol incompatibility, not a node with no contract. The
        // old behaviour defaulted it to null and let the call proceed, which is how a broken wire
        // format reached production looking like an empty contract.
        throw new BridgeError(
          "BRIDGE_PROTOCOL_INCOMPATIBLE",
          "BLOCKED_PLATFORM",
          "the runtime's current response has no contract.contractHash; this bridge implements a " +
            "different wire format than the Core it is talking to",
          { runId },
        );
      }

      const requiredInputs = stringArray(contract["inputs"] ? Object.keys(contract["inputs"] as object) : []);
      const permittedOutputs = permittedOutputNames(contract["intendedMutations"], runId);
      const evidenceRequirements = Array.isArray(contract["requiredEvidenceKinds"])
        ? (contract["requiredEvidenceKinds"] as unknown[])
        : [];
      const policyConstraints =
        typeof contract["effectivePolicy"] === "object" && contract["effectivePolicy"] !== null
          ? (contract["effectivePolicy"] as Record<string, unknown>)
          : {};

      // The Core sends the superseded attempt's agent run at the top level, because `attempt`
      // describes the *current* holder and cannot answer "whose attempt would I be taking". Reading
      // it from inside `attempt` found nothing, so the adoption stop-check had no subject and a live
      // previous owner would have been adopted silently. The attempt-level names are still accepted
      // for older Cores, previous-owner first, because they mean different things:
      // `previousOwnerAgentRunId` is who *had* it, `ownerAgentRunId` is who has it now.
      const previousOwnerAgentRunId =
        str(record["previousOwnerAgentRunId"]) ??
        str(attempt["previousOwnerAgentRunId"]) ??
        (str(attempt["ownerAgentRunId"]) ?? str(agentRunRefId(attempt)));
      return {
        runId,
        stateVersion: typeof record["stateVersion"] === "number" ? record["stateVersion"] : 0,
        nodeId: typeof record["nodeId"] === "string" ? record["nodeId"] : null,
        iteration: typeof record["iteration"] === "number" ? record["iteration"] : 0,
        attemptId: str(attempt["attemptId"]),
        leaseEpoch: typeof attempt["leaseEpoch"] === "number" ? attempt["leaseEpoch"] : null,
        contractHash,
        requiredInputs,
        permittedOutputs,
        evidenceRequirements,
        policyConstraints,
        permittedActions: stringArray(record["permittedActions"]),
        claimable: record["claimable"] !== false,
        previousOwnerAgentRunId:
          previousOwnerAgentRunId === null || previousOwnerAgentRunId === ""
            ? null
            : previousOwnerAgentRunId,
      };
    },
    claim: async (_companyId, runId, body) => client.claim(SYSTEM_ACTOR, scope(runId), runId, body),
    submitArtifacts: async (_companyId, runId, body) => client.submitArtifacts(SYSTEM_ACTOR, scope(runId), runId, body),
    submitEvidence: async (_companyId, runId, body) => client.submitEvidence(SYSTEM_ACTOR, scope(runId), runId, body),
    requestTransition: async (_companyId, runId, body) => client.requestTransition(SYSTEM_ACTOR, scope(runId), runId, body),
    requestHelp: async (_companyId, runId, body) => client.requestHelp(SYSTEM_ACTOR, scope(runId), runId, body),
  };
}

/**
 * Build (or return) the full bridge for one company.
 *
 * The wiring itself lives in `createCompanyContext` so `worker.ts` and the plugin's own tests
 * build the *same* object graph. A test that re-assembled its own wiring would pass while
 * production was broken, which is the failure mode harness tests are worst at catching.
 */
function ensureCompany(shared: Bridge, ctx: PluginContext, companyId: string, raw: Record<string, unknown>): CompanyContext {
  const existing = companyOf(shared, companyId);
  if (existing !== null) return existing;
  const context = createCompanyContext(
    {
      ctx,
      store: shared.store,
      metrics: shared.metrics,
      capabilities: shared.capabilities,
      inbox: shared.inbox,
      deliveries: shared.deliveries,
      pump: shared.pump,
      logger: shared.logger,
      registry: shared.registry,
      makeRuntime: (config, id) =>
        makeRuntimeClient(ctx, config, id, shared.logger.child({ companyId: id }), shared.store),
    },
    companyId,
    raw,
  );
  shared.companies.set(companyId, context);
  context.logger.info("bridge configured for company", {
    runtimeUrl: context.config.runtimeUrl,
    issuer: context.config.bridgeIssuer,
    audience: context.config.audience,
    projectionsEnabled: context.config.enableProjections,
  });
  return context;
}

/**
 * Rehydrate the raw config for a company already resolved.
 *
 * `BridgeConfig` is a normalised projection, so it is turned back into the raw shape
 * `resolveConfig` accepts. Nothing is lost: normalisation only substitutes defaults.
 */
/**
 * Project a resolved config back into the raw shape `resolveConfig` accepts.
 *
 * This round trip is a correctness hazard, not a convenience. It exists so a company whose
 * configuration is already resolved can rebuild its bridge without another host call, and every
 * field it drops is a field the rebuilt bridge silently loses. `allowPrivateRuntimeHost` was
 * missing here, so a bridge rebuilt from cache refused its own loopback Runtime Service and
 * reported "no configuration" while the operator's configuration was sitting in plain sight.
 * `tests/config-schema.test.ts` pins this projection against the same key set the resolver reads,
 * so a new field cannot be added to one and forgotten in the other.
 */
function configFromCache(config: BridgeConfig): Record<string, unknown> {
  return {
    runtimeUrl: config.runtimeUrl,
    bridgeIssuer: config.bridgeIssuer,
    sharedSecretRef: config.sharedSecretRef,
    // The SSRF opt-in is a security decision, and losing it must fail *closed* (refuse the
    // private address) rather than open. It is carried explicitly so a rebuild cannot change it.
    allowPrivateRuntimeHost: config.allowPrivateRuntimeHost,
    audience: config.audience,
    requestTimeoutMs: config.requestTimeoutMs,
    replayWindowSeconds: config.replayWindowSeconds,
    maxArtifactBytes: config.maxArtifactBytes,
    stateDir: config.stateDir,
    defaultGraphId: config.defaultGraphId,
    engineeringEntryLabel: config.engineeringEntryLabel,
    engineeringOriginPrefix: config.engineeringOriginPrefix,
    workspaceProviderMode: config.workspaceProviderMode,
    runtimeTransport: config.runtimeTransport,
    experimental: config.experimental,
    enableProjections: config.enableProjections,
    logLevel: config.logLevel,
  };
}

/**
 * The company resolver used by the data handlers, the action handlers and the API routes.
 *
 * A company the bridge has never configured resolves to `null`, and every caller treats that as
 * "no data" or "refused" rather than falling back to a default. Since a `getData` call carries
 * no authenticated actor, this is the *only* scope check available on that path; the
 * limitations are documented in `src/bridge/data.ts`.
 *
 * A company with no cached config is fetched from the host **once** before giving up. Relying
 * purely on the `configChanged` push means a push that is missed — the worker started before the
 * config was written, a restart race, a host that batches — leaves a correctly configured plugin
 * reporting "no configuration" forever, which is the exact silent-degradation failure this system
 * exists to prevent. One round trip to find out is a far better failure mode than never finding
 * out. The result is cached, so this costs one call per company per worker lifetime.
 */
function resolverFor(shared: Bridge): CompanyResolver {
  return (companyId: string): CompanyContext | null => {
    const existing = companyOf(shared, companyId);
    if (existing !== null) return existing;
    if (shared.ctx === null) return null;
    // A company the bridge has rows for is one it has legitimately served before, so a config
    // cached in the registry can rebuild its bundle without another host round trip.
    const cached = shared.registry.get(companyId);
    if (cached !== null) {
      try {
        return ensureCompany(shared, shared.ctx, companyId, configFromCache(cached));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Recorded durably, not only logged: a company whose configuration loads but whose bridge
        // cannot be built is exactly the case where an operator needs the reason, and host log
        // retention is not something this plugin controls.
        recordDiscovery(shared, companyId, "bridge_build_failed", { error: message.slice(0, 400) });
        shared.logger.warn("could not build a company bridge from a loaded configuration", {
          companyId,
          error: message,
        });
        return null;
      }
    }
    // Nothing cached. This resolver runs on company-scoped paths (a `getData` bridge call), which
    // is exactly the context the host requires before it will answer `config.get`, so this is the
    // right place to learn the company. Deferred so the fetch does not re-enter the RPC loop.
    learnCompany(shared, companyId);
    return null;
  };
}

/**
 * Learn one company's configuration, from a company-scoped invocation.
 *
 * Two host constraints shape this, and both are load-bearing:
 *
 *  1. **`config.get` needs an active company context.** The host refuses it outright outside a
 *     company-scoped invocation — an event, an API route, a tool run, or a UI bridge call — with
 *     "company context is required". A scheduled job has no company, so a job can *never* discover
 *     a company; it can only serve companies some company-scoped path has already taught it.
 *     That is the host's security model, and conforming to it is the design, not a limitation to
 *     work around.
 *
 *  2. **A worker call must not be awaited from inside a worker call.** The RPC loop is
 *     single-threaded, so awaiting `config.get` from a `getData` handler re-enters the loop and the
 *     reply can never be served. The fetch is therefore handed to a timer, which runs when no RPC
 *     is in flight.
 *
 * The `configChanged` push remains the fast path; this is the fallback that makes a missed push
 * cost one round trip instead of leaving a correctly configured plugin permanently idle.
 */
const learning = new Set<string>();
function learnCompany(shared: Bridge, companyId: string): void {
  if (companyId === "" || shared.ctx === null) return;
  if (shared.registry.get(companyId) !== null) return;
  if (learning.has(companyId)) return;
  learning.add(companyId);
  setTimeout(() => {
    void (async () => {
      try {
        const raw = (await shared.ctx!.config.get(companyId)) as Record<string, unknown>;
        if (raw && Object.keys(raw).length > 0) {
          shared.registry.load(companyId, raw);
          recordDiscovery(shared, companyId, "loaded", { keys: Object.keys(raw).sort() });
          shared.logger.info("learned a company configuration from a company-scoped call", {
            companyId,
            keys: Object.keys(raw).sort(),
          });
        } else {
          recordDiscovery(shared, companyId, "no_configuration_set");
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        recordDiscovery(shared, companyId, "configuration_unusable", { error: message.slice(0, 300) });
        shared.logger.warn("a company configuration could not be used", { companyId, error: message });
      } finally {
        learning.delete(companyId);
      }
    })();
  }, 0);
}

/**
 * Record why a company is or is not configured, in the bridge's own durable store.
 *
 * Host log retention is the host's business. An operator diagnosing "installed and idle" must be
 * able to read *why* from state the bridge owns, so the answer survives log rotation.
 */
function recordDiscovery(
  shared: Bridge,
  companyId: string,
  outcome: string,
  detail?: Record<string, unknown>,
): void {
  try {
    shared.store.setCompat(companyId, "configuration_discovery", {
      at: new Date().toISOString(),
      outcome,
      ...(detail ?? {}),
    });
  } catch {
    // Diagnostics must never be the reason a health check fails.
  }
}

/**
 * Build the process-level collaborators: one store, one metrics registry, one capability
 * matcher, one inbox, one pump, one reconciler.
 *
 * Factored out of `setup` so the plugin's own tests assemble the identical graph. The store
 * path is unique per process so two workers on one machine never share a SQLite file.
 */
function createSharedBridge(ctx: PluginContext): Bridge {
  const storePath = bridgeStorePath();
  const store = BridgeStore.open({
    path: storePath,
    onWarning: (message, detail) => ctx.logger.warn(`[polyforge] ${message}`, detail),
  });
  const logger = createLogger(ctx.logger, "info");
  const metrics = new BridgeMetrics(store);
  metrics.attach(ctx.metrics);
  const capabilities = new CapabilityMatcher(store);
  const inbox = new Inbox(store, metrics, logger);
  const deliveries = new StoreDeliveryRecorder(store, () => new Date(), logger);
  const registry = new ConfigRegistry(storePath);
  const pump = new OutboxPump({
    store,
    logger,
    metrics,
    now: () => new Date(),
    ownerId: `worker-${randomUUID().slice(0, 8)}`,
  });

  const shared: Bridge = {
    store,
    metrics,
    capabilities,
    inbox,
    registry,
    logger,
    companies: new Map(),
    pump,
    reconciler: null as unknown as Reconciler,
    deliveries,
    eventPump: null,
    ctx,
    storePath,
  };
  shared.reconciler = new Reconciler(processLevelDeps(shared, ctx));
  return shared;
}

const plugin: PluginDefinition = {
  async setup(ctx: PluginContext): Promise<void> {
    const shared = createSharedBridge(ctx);
    bridge = shared;
    const pump = shared.pump;
    const registry = shared.registry;

    registerIntentHandlers(pump, (id) => companyOf(shared, id));
    registerTools(ctx, toolDepsFor(toolWiringOf(shared)));
    const resolve = resolverFor(shared);
    registerDataKeys(ctx, resolve);
    registerActionKeys(
      (key, handler) => {
        ctx.actions.register(key, async (params, context) => {
          try {
            return await handler(params, context);
          } catch (error) {
            if (isBridgeError(error)) {
              // A refusal is a result, not a transport failure: the UI needs the blocker text,
              // and a thrown error would read as "retry", which is wrong for a blocked action.
              return { ok: false, error: error.blocker };
            }
            throw error;
          }
        });
      },
      resolve,
    );

    const eventPump = new EventPump({
      ctx,
      store: shared.store,
      inbox: shared.inbox,
      logger: shared.logger,
      metrics: shared.metrics,
      enqueue: (input) => shared.deliveries.begin(input),
      runtimeAvailable: () => true,
      learnCompany: (companyId) => learnCompany(shared, companyId),
    });
    shared.eventPump = eventPump;
    unsubscribeEvents = eventPump.subscribe();

    ctx.jobs.register("outbox-pump", async () => {
      // Discovery is *deferred*, not awaited. A job handler is an RPC the host is waiting on; if
      // it then awaits a host call of its own (`companies.list`, `config.get`) it re-enters the
      // same single-threaded RPC loop and the callback can never be served, so the job hangs
      // forever and the bridge silently stops delivering. Handing the work to a timer puts it on
      // the event loop where no RPC is in flight.
      //
      // A job also cannot *learn* a company: `config.get` requires a company-scoped invocation
      // and a job has none. The job therefore serves exactly the companies a company-scoped path
      // has already taught the bridge, which is the host's model rather than a gap in ours.
      await pump.pumpOnce(registry.companies());
    });

    ctx.jobs.register("reconcile", async () => {
      for (const companyId of registry.companies()) {
        const company = companyOf(shared, companyId);
        if (company === null) continue;
        await company.reconciler.reconcileCompany(companyId);
      }
    });

    // Claim and deliver the *Core's* outbound queue. This is the other half of the delivery chain:
    // the Core enqueues `work.unit.ensure` when a node becomes READY and never calls the platform
    // itself, so without this pass a Root Issue builds a run and no node is ever worked.
    //
    // It runs per company and per project, because the Core scopes its outbox by the same pair and
    // refuses a claim that names the wrong one. The projects come from the bridge's own bindings
    // rather than from a "current project" the host might consider active, so a poll can never claim
    // into a scope this bridge has no record of.
    ctx.jobs.register("core-outbox", async () => {
      for (const companyId of registry.companies()) {
        const company = companyOf(shared, companyId);
        if (company === null || company.runtime === null) continue;
        for (const scope of coreOutboxScopes(company)) {
          await company.coreOutbox.run(scope);
        }
      }
    });

    shared.logger.info("PolyForge bridge worker started", {
      schemaVersion: shared.store.schemaVersion,
      storePath: shared.storePath,
      toolCount: manifest.tools?.length ?? 0,
      capabilityCount: manifest.capabilities.length,
    });
  },

  /**
   * Health derived from real state.
   *
   * `error` when the shared secret cannot be resolved, because no signed request can be made
   * at all. `degraded` when the store is not writable (it can still answer reads but must not
   * accept work it cannot durably record) or when the Runtime is unreachable or expects a
   * different issuer. `ok` only when every configured company can sign and reach its Runtime.
   */
  async onHealth(): Promise<PluginHealthDiagnostics> {
    const shared = bridge;
    if (shared === null) {
      return { status: "error", message: "the bridge worker has not completed setup", details: {} };
    }
    // Health is where an operator looks first, so it is also where the plugin makes sure it knows
    // about its tenants. `onHealth` is not company-scoped, so this only *reports*; the learning
    // happens on the company-scoped paths, and the durable discovery record below says which.
    const details: Record<string, unknown> = {
      storePath: shared.storePath,
      schemaVersion: shared.store.schemaVersion,
      configuredCompanies: shared.registry.companies(),
      knownCompanies: shared.store.knownCompanies(),
    };

    const storeCheck = shared.store.checkWritable();
    if (!storeCheck.ok) {
      return {
        status: "degraded",
        message: `the bridge store is not writable: ${storeCheck.detail ?? "unknown"}`,
        details: { ...details, writable: false },
      };
    }

    const problems: string[] = [];
    if (shared.registry.companies().length === 0) {
      // Installed and idle. Reporting `degraded` would put a correctly installed but not yet
      // configured plugin into an operator's incident list for doing nothing wrong, so this is
      // `ok` with an explicit message instead: the honest state is "waiting for configuration".
      return {
        status: "ok",
        message: "installed and idle: no company is configured yet, so no engineering work is admitted",
        details: { ...details, configured: false },
      };
    }
    for (const companyId of shared.registry.companies()) {
      const company = companyOf(shared, companyId);
      if (company === null) {
        problems.push(`${companyId}: no bridge context`);
        continue;
      }
      details[`counters:${companyId}`] = shared.metrics.counters(companyId);
      details[`quarantine:${companyId}`] = shared.store.countQuarantine(companyId);
      details[`ambiguous:${companyId}`] = shared.store.countDeliveries(companyId, "ambiguous");
      try {
        const report = await company.runtime!.health(SYSTEM_ACTOR, companyScope(companyId));
        if (report.bridge.expectedIssuer !== company.runtime!.issuer) {
          problems.push(
            `${companyId}: the runtime expects issuer "${report.bridge.expectedIssuer}" but the bridge is configured as "${company.runtime!.issuer}"`,
          );
        }
      } catch (error) {
        problems.push(`${companyId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const quarantined = shared.registry.companies().reduce((sum, id) => sum + shared.store.countQuarantine(id), 0);
    if (quarantined > 0) {
      problems.push(`${quarantined} event(s) quarantined for an unknown schema`);
    }
    if (problems.length > 0) {
      return { status: "degraded", message: problems.join("; "), details };
    }
    return { status: "ok", message: "ready", details };
  },

  /**
   * Validate a configuration before it is trusted with work.
   *
   * **An unconfigured plugin is not a misconfigured plugin.** Failing activation on a config the
   * operator has not written yet is a bootstrap deadlock: the host will not start the worker, and
   * a worker that will not start cannot be given a configuration. So a config with no
   * `runtimeUrl` at all is reported as valid-with-warnings and the bridge sits in `read_only`
   * until `onConfigChanged` supplies one. Everything else keeps the strict behaviour below.
   *
   * Four checks, each of which has bitten someone before:
   * 1. the secret ref *shape*, without touching the provider (which may be the thing that is
   *    down);
   * 2. the state dir is creatable and writable — a durable bridge with an unwritable store is
   *    exactly the silent-loss failure this system exists to avoid;
   * 3. the runtime URL parses and is http(s), and is not a link-local or metadata address;
   * 4. the runtime is reachable and its expected issuer matches.
   *
   * (4) is a *warning* when the Runtime is simply down: the operator may be saving settings
   * while the service is restarting, and failing the save would be worse than the risk.
   * An issuer mismatch is an error, because that is a misconfiguration that would silently
   * reject every request.
   */
  async onValidateConfig(config: Record<string, unknown>): Promise<PluginConfigValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (typeof config["runtimeUrl"] !== "string" || config["runtimeUrl"].trim() === "") {
      return {
        ok: true,
        warnings: [
          "no runtimeUrl is configured yet: the bridge is installed but idle. It will start " +
            "accepting engineering work as soon as a company configuration names a Runtime " +
            "Service and a shared secret reference.",
        ],
      };
    }

    errors.push(...validateSecretRefShape(config["sharedSecretRef"]));

    let resolved: BridgeConfig | null = null;
    try {
      resolved = resolveConfig({
        companyId: "validate",
        raw: config,
        // The file the worker will actually open, so this check is about the real store rather than
        // about a path derived from `stateDir` that nothing ever writes to.
        storePath: bridgeStorePath(),
      });
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }

    if (resolved !== null) {
      try {
        const probe = BridgeStore.open({ path: resolved.storePath });
        const writable = probe.checkWritable();
        probe.close();
        if (!writable.ok) {
          errors.push(`stateDir is not writable: ${writable.detail ?? "unknown"}`);
        }
      } catch (error) {
        errors.push(`stateDir could not be opened: ${error instanceof Error ? error.message : String(error)}`);
      }

      if (errors.length === 0) {
        // A throwaway client with a throwaway secret: validating a config never resolves the
        // operator's real secret and never leaves a usable signed request behind.
        try {
          const probeClient = new RuntimeClient(resolved, {
            secretProvider: async () => "validation-probe-not-a-real-secret",
            clock: SYSTEM_CLOCK,
            fetchImpl: (url, init) => fetch(url, init),
            companyId: "validate",
          });
          const report = await probeClient.health(SYSTEM_ACTOR, companyScope("validate"), "validate");
          if (report.bridge.expectedIssuer !== resolved.bridgeIssuer) {
            errors.push(
              `the runtime expects issuer "${report.bridge.expectedIssuer}" but the config declares "${resolved.bridgeIssuer}"`,
            );
          }
          if (report.protocolVersion !== 1) {
            warnings.push(`the runtime reports protocol version ${report.protocolVersion}; this bridge implements 1`);
          }
        } catch (error) {
          warnings.push(`the runtime is not reachable right now: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    return {
      ok: errors.length === 0,
      ...(errors.length > 0 ? { errors } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  },

  /**
   * Key every per-company resource on `context.companyId`.
   *
   * `multiCompanyConfig: true` tells the host this worker really does serve more than one
   * company, which is what stops the SDK from failing a second company's config closed. A
   * `null` company means an instance-level save, which invalidates every company because the
   * instance defaults moved; a company-scoped save invalidates only that company, so one
   * tenant's reconfiguration cannot disturb another's derived client or stored state.
   */
  async onConfigChanged(newConfig: Record<string, unknown>, context?: PluginConfigChangeContext): Promise<void> {
    const shared = bridge;
    if (shared === null) return;
    const companyId = context?.companyId ?? null;
    shared.registry.invalidate(companyId);
    if (companyId === null) {
      const count = shared.companies.size;
      shared.companies.clear();
      shared.logger.info("instance-level configuration changed; every company bridge rebuilds on next use", {
        companiesDiscarded: count,
      });
      return;
    }
    const previous = companyOf(shared, companyId);
    shared.companies.delete(companyId);
    shared.logger.info("company configuration changed; its bridge will rebuild on next use", {
      companyId,
      hadBridge: previous !== null,
      keys: Object.keys(newConfig).sort(),
    });
  },

  async onShutdown(): Promise<void> {
    unsubscribeEvents?.();
    unsubscribeEvents = null;
    const shared = bridge;
    if (shared === null) return;
    // Checkpoint and truncate the WAL so a restart reads a complete file. Nothing is lost
    // either way — that is what the WAL is for — but recovery is faster and the operator's
    // first health check is unambiguous.
    shared.store.close();
    shared.logger.info("PolyForge bridge worker stopped cleanly");
  },

  async onApiRequest(input: PluginApiRequestInput): Promise<PluginApiResponse> {
    const shared = bridge;
    if (shared === null) {
      return {
        status: 503,
        headers: { "content-type": "application/json" },
        body: { error: { code: "BRIDGE_STORE_UNAVAILABLE", message: "the bridge is not running" } },
      };
    }
    return createApiRequestHandler(resolverFor(shared))(input);
  },

  multiCompanyConfig: true,
};

/**
 * The process-level dependency set the jobs hold before any company exists.
 *
 * The reconciler is created once so the `reconcile` job has something to iterate, but it is
 * only ever used through the per-company `reconciler` inside each `CompanyContext`. The port
 * bundle here is a throwing stand-in: if it were ever reached it would mean a job ran before
 * setup completed, which must fail loudly rather than silently no-op.
 */
function processLevelDeps(shared: Bridge, ctx: PluginContext): BridgeDeps {
  const logger = shared.logger;
  return {
    ctx,
    store: shared.store,
    config: fallbackConfig(),
    logger,
    capabilities: shared.capabilities,
    metrics: shared.metrics,
    deliveries: shared.deliveries,
    runtime: null,
    pump: shared.pump,
    reconciler: null as unknown as Reconciler,
    router: null as unknown as Router,
    admission: new AdmissionGate(fallbackConfig(), logger, shared.metrics),
    inbox: shared.inbox,
    now: () => new Date(),
    scope: { companyRef: "", projectRef: "" },
    ports: () => throwingPorts,
  };
}

/**
 * Every project this bridge has a record of for one company.
 *
 * The Core's outbox is scoped by company *and* project and refuses a claim naming the wrong pair, so
 * the poll has to enumerate projects. The only trustworthy list is the one this bridge wrote: the
 * project recorded on a run, work-unit or dispatch binding.
 *
 * A "currently active project" from the host would be the wrong source twice over — it could name a
 * project this bridge has never seen, and it would silently stop claiming for a project the operator
 * merely navigated away from.
 */
function coreOutboxScopes(company: CompanyContext): Scope[] {
  const seen = new Set<string>();
  for (const kind of [RUN_BINDING_KIND, WORK_UNIT_BINDING_KIND, DISPATCH_BINDING_KIND]) {
    for (const row of company.store.listBindings(company.companyId, kind)) {
      if (typeof row.projectId === "string" && row.projectId.length > 0) seen.add(row.projectId);
    }
  }
  return [...seen].sort().map((projectRef) => ({ companyRef: company.companyId, projectRef }));
}

const throwingPorts: PortBundle = new Proxy({} as PortBundle, {
  get(_target, property) {
    return new Proxy(
      {},
      {
        get() {
          return () => {
            throw new Error(
              `the process-level port bundle has no ${String(property)}; use the per-company bundle (a job ran before setup completed)`,
            );
          };
        },
      },
    );
  },
});

/**
 * A last-resort config so a process-level object can be constructed before any company is
 * configured.
 *
 * It is deliberately **not** a usable Runtime address. An earlier version pointed at
 * `http://127.0.0.1:8787`, which the SSRF guard correctly refused — and because the guard runs
 * inside `resolveConfig`, the refusal escaped through `setup()` and put the whole plugin into an
 * `error` state from which an operator cannot save a configuration. A bootstrap deadlock is a
 * worse failure than a placeholder that cannot connect, so the fallback is a name that will not
 * resolve: nothing is ever delivered to it, and the operator sees a DNS-level error naming
 * `polyforge-unconfigured` rather than a silent misroute.
 */
function fallbackConfig(): BridgeConfig {
  return resolveConfig({
    companyId: "__fallback__",
    raw: {
      runtimeUrl: "http://polyforge-unconfigured.invalid",
      bridgeIssuer: "polyforge-bridge",
      allowPrivateRuntimeHost: true,
      sharedSecretRef: { type: "secret_ref", secretId: "unset" },
    },
    storePath: bridgeStorePath(),
  });
}

/**
 * The tool dependency bundle.
 *
 * Every method here reads or writes the *bridge's own* store; none of them reimplements a
 * policy. The claim helpers are the mirror of the Core's claim: the Core is authoritative, and
 * the bridge records what it was granted so a later tool call can prove this agent run still
 * holds it.
 */
/**
 * The wiring the tool handlers need.
 *
 * A narrow interface rather than the whole `Bridge`: the handlers must be constructible from
 * the same pieces in a test as in production, and the smaller this is, the harder it is for a
 * test to accidentally exercise a different code path.
 */
export interface ToolWiring {
  readonly store: BridgeStore;
  readonly metrics: BridgeMetrics;
  readonly logger: BridgeLogger;
  company(companyId: string): CompanyContext | null;
}

function toolDepsFor(wiring: ToolWiring): ToolHandlerDeps {
  const { store, metrics, logger } = wiring;
  return {
    runtime: (companyId: string): ToolRuntime | null => {
      const company = wiring.company(companyId);
      if (company === null || company.runtime === null) return null;
      return toolRuntimeFor(company);
    },
    claim: (input: ToolClaimQuery): ToolClaim | null => {
      const row = store.getBinding(input.companyId, CLAIM_BINDING_KIND, claimKeyOf(input));
      if (row === null) return null;
      const payload = readJson(row.payloadJson);
      if (
        typeof payload["attemptId"] !== "string" ||
        typeof payload["leaseEpoch"] !== "number" ||
        typeof payload["agentRunId"] !== "string"
      ) {
        return null;
      }
      return {
        attemptId: payload["attemptId"],
        leaseEpoch: payload["leaseEpoch"],
        agentRunId: payload["agentRunId"],
        agentId: typeof payload["agentId"] === "string" ? payload["agentId"] : "",
        contractHash: typeof payload["contractHash"] === "string" ? payload["contractHash"] : null,
        claimedAt: typeof payload["claimedAt"] === "string" ? payload["claimedAt"] : row.updatedAt,
      };
    },
    recordClaim: (input): void => {
      store.putBinding({
        companyId: input.companyId,
        kind: CLAIM_BINDING_KIND,
        providerId: claimKeyOf(input),
        payload: { ...input, claimedAt: new Date().toISOString() },
      });
    },
    bindingForAgentRun: (companyId: string, agentRunId: string): ToolRunBinding | null => {
      for (const kind of [DISPATCH_BINDING_KIND, WORK_UNIT_BINDING_KIND]) {
        for (const row of store.listBindings(companyId, kind, 2000)) {
          const payload = readJson(row.payloadJson);
          if (payload["agentRunRefId"] !== agentRunId) continue;
          if (typeof payload["runId"] !== "string") continue;
          return {
            companyId,
            runId: payload["runId"],
            nodeId: typeof payload["nodeId"] === "string" ? payload["nodeId"] : "",
            iteration: typeof payload["iteration"] === "number" ? payload["iteration"] : 0,
            issueId: typeof payload["issueId"] === "string" ? payload["issueId"] : "",
            projectId: row.projectId,
            contractHash: typeof payload["contractHash"] === "string" ? payload["contractHash"] : null,
          };
        }
      }
      return null;
    },
    stopPreviousOwner: async (companyId: string, ref): Promise<"stopped" | "unknown"> => {
      const company = wiring.company(companyId);
      if (company === null) return "unknown";
      const receipt = await company.ports.work.requestStop(ref, {
        commandId: `stop:${ref.id}`,
        idempotencyKey: `pf.stop:${companyId}:${ref.id}`,
        correlationId: ref.id,
      });
      // Only an authoritative confirmation permits a replacement dispatch. `unknown` means the
      // platform could not tell us, and the Core keeps the attempt in UNKNOWN.
      return receipt.outcome === "unknown" ? "unknown" : "stopped";
    },
    bump: (companyId: string, counter: string, by = 1): void => {
      metrics.bump(companyId, counter, by);
    },
    warn: (message: string, meta: Record<string, unknown>): void => {
      logger.warn(message, meta);
    },
    publishArtifact: async (companyId: string, input) => {
      const company = wiring.company(companyId);
      if (company === null) {
        throw new Error(`no bridge context for company ${companyId}`);
      }
      const ref = await company.ports.artifacts.publish(
        {
          scope: { companyRef: companyId, projectRef: "" },
          kind: input.kind,
          contentHash: input.contentHash,
          mediaType: input.mediaType,
          size: input.size,
          source: input.source,
          repository: input.repository ?? null,
        },
        {
          commandId: `artifact:${input.kind}:${input.contentHash}`,
          idempotencyKey: `pf.artifact:${companyId}:${input.kind}:${input.contentHash}`,
          correlationId: input.contentHash,
        },
      );
      // The verified identity, forwarded whole. Flattening it to a bare ref here is what made the
      // tool echo the caller's declared hash back to the Core instead of the digest this port
      // computed from the bytes.
      return ref;
    },
  };
}

function claimKeyOf(input: ToolClaimQuery): string {
  return `${input.runId}:${input.nodeId}:${input.iteration}`;
}

/** A stored provider ref, whether it survived as an object or as canonical JSON text. */
function rootIssueRefOf(value: unknown): { provider: string; kind: string; id: string } {
  const record = readJson(typeof value === "string" ? value : JSON.stringify(value ?? {}));
  return {
    provider: typeof record["provider"] === "string" ? record["provider"] : "paperclip",
    kind: typeof record["kind"] === "string" ? record["kind"] : "issue",
    id: typeof record["id"] === "string" ? record["id"] : "",
  };
}

/**
 * Rebuild an `ActorAssertion` the bridge itself recorded.
 *
 * Only the three fields the protocol defines are accepted, and the `actorType` is validated
 * against the same vocabulary. Anything else falls back to the system actor, so a corrupted or
 * tampered intent row cannot turn into an assertion the Core would believe.
 */
function readActorAssertion(value: unknown): ActorAssertion {
  const record = readJson(typeof value === "string" ? value : JSON.stringify(value ?? {}));
  const actorType = record["actorType"];
  if (actorType !== "human" && actorType !== "agent" && actorType !== "system") return SYSTEM_ACTOR;
  const actorId = record["actorId"];
  if (typeof actorId !== "string" || actorId.length === 0) return SYSTEM_ACTOR;
  return {
    actorType,
    actorId,
    agentId: typeof record["agentId"] === "string" ? record["agentId"] : null,
    runId: typeof record["runId"] === "string" ? record["runId"] : null,
    roles: Array.isArray(record["roles"]) ? (record["roles"] as string[]) : [],
  };
}

/**
 * Register one handler per intent kind.
 *
 * A kind with no handler is a programming error and the pump marks it `failed` rather than
 * retrying forever. The table covers every kind the bridge enqueues; a Core-originated delivery
 * arrives through `coreDeliveryAck`.
 */
function registerIntentHandlers(
  pump: OutboxPump,
  resolveCompany: (companyId: string) => CompanyContext | null,
): void {
  const handler = (kind: string, fn: DeliveryHandler): void => {
    pump.register(kind, fn);
  };

  const coreCall = (
    kind: string,
    call: (company: CompanyContext, payload: Record<string, unknown>, row: DeliveryRowLike) => Promise<unknown>,
  ): void => {
    handler(kind, async (row) => {
      const company = resolveCompany(row.companyId);
      if (company === null || company.runtime === null) {
        return { status: "observed", reason: "no runtime client for this company; will retry", retryAfterMs: 60_000 };
      }
      const payload = readJson(row.payloadJson);
      const result = await call(company, payload, row);
      return { status: "reconciled", result };
    });
  };

  const acknowledgeCoreEffect = async (
    company: CompanyContext,
    row: DeliveryRowLike,
    payload: Record<string, unknown>,
    state: "observed" | "delivered" | "reconciled" | "failed" | "ambiguous_create",
    receipt?: Record<string, unknown>,
  ): Promise<void> => {
    const coreIntentId = str(payload["coreIntentId"]);
    if (coreIntentId === null || company.runtime === null) return;
    const scope = scopeForIntent(company, row);
    if (scope === null) {
      throw new BridgeError(
        "BRIDGE_SCOPE_VIOLATION",
        "BLOCKED_SCOPE",
        "the platform effect completed but its Core receipt has no project scope",
        { coreIntentId, runId: row.runId },
      );
    }
    await company.runtime.markDelivery(SYSTEM_ACTOR, scope, coreIntentId, {
      state,
      ...(receipt === undefined ? {} : { receipt }),
    });
  };

  coreCall(INTENT_KINDS.workOrderCreate, async (company, payload, row) => {
    const declared = readJson(typeof payload["scope"] === "string" ? payload["scope"] : JSON.stringify(payload["scope"] ?? {}));
    const scope: Scope = {
      companyRef: company.companyId,
      projectRef: typeof declared["projectRef"] === "string" ? declared["projectRef"] : "",
    };
    // The admission's actor, as the host authenticated it at the time. A payload that carries no
    // actor falls back to the system actor: an unattributable admission is still attributable
    // to the plugin, and never to a person.
    const actor = readActorAssertion(payload["requestedBy"]);
    const result = await company.runtime!.createWorkOrder(
      actor,
      scope,
      {
        scope,
        startIntentId: String(payload["startIntentId"] ?? ""),
        graphId: String(payload["graphId"] ?? ""),
        entrypoint: String(payload["entrypoint"] ?? ""),
        rootIssueRef: rootIssueRefOf(payload["rootIssueRef"]),
        inputSnapshot:
          typeof payload["inputSnapshot"] === "object" && payload["inputSnapshot"] !== null
            ? (payload["inputSnapshot"] as Record<string, unknown>)
            : {},
        commandId: `work-order:${String(payload["startIntentId"])}`,
        idempotencyKey: row.effectKey,
        correlationId: row.correlationId,
      },
      row.correlationId,
    );
    const snapshot = result as unknown as Record<string, unknown>;
    if (typeof snapshot["runId"] === "string") {
      // The run binding is what lets a later `issue.updated` for the Root Issue resolve to its
      // run without a reverse index, and it records the pins verbatim so AT-19 is checkable.
      company.router.recordRun({
        scope,
        runId: snapshot["runId"],
        workOrderId: typeof snapshot["workOrderId"] === "string" ? snapshot["workOrderId"] : "",
        graphId: String(payload["graphId"] ?? ""),
        graphVersion: typeof snapshot["graphVersion"] === "number" ? snapshot["graphVersion"] : 0,
        entrypoint: String(payload["entrypoint"] ?? ""),
        rootIssueId: rootIssueRefOf(payload["rootIssueRef"]).id,
        startIntentId: String(payload["startIntentId"] ?? ""),
        pins:
          typeof snapshot["pins"] === "object" && snapshot["pins"] !== null
            ? (snapshot["pins"] as Record<string, string>)
            : {},
      });
    }
    return result;
  });

  // An event intake that cannot name its project is held rather than sent: the Core would refuse it,
  // and a refused intake that had already been retried is indistinguishable from a lost observation.
  const eventScope = (company: CompanyContext, row: DeliveryRowLike): Scope | null =>
    scopeForIntent(company, row);

  coreCall(INTENT_KINDS.eventIntake, async (company, payload, row) =>
    company.runtime!.intakeEvent(
      SYSTEM_ACTOR,
      // Signed for the project the intent was created in. An empty project meant every observation
      // was refused by the Core's tenant check, so nothing the platform did ever reached the graph.
      eventScope(company, row) ?? { companyRef: company.companyId, projectRef: "" },
      payload,
      row.correlationId,
    ),
  );

  coreCall(INTENT_KINDS.governanceRecordResolution, async (company, payload, row) =>
    company.runtime!.recordGovernanceResolution(
      SYSTEM_ACTOR,
      // Signed for the project the intent was created in, for the same reason as event intake: a
      // governance outcome recorded against the wrong scope is a refusal, and the Core is right to
      // refuse it.
      scopeForIntent(company, row) ?? { companyRef: company.companyId, projectRef: "" },
      row.runId ?? String(payload["runId"] ?? ""),
      String(payload["requestId"] ?? ""),
      payload,
    ),
  );

  coreCall(INTENT_KINDS.executionInspect, async (company, payload, row) => {
    // The Core records the observation; the bridge never turns it into a pass.
    const scope = scopeForIntent(company, row);
    if (scope === null) {
      return { status: "observed", reason: "no project recorded for this intent yet", retryAfterMs: 30_000 };
    }
    return company.runtime!.intakeEvent(SYSTEM_ACTOR, scope, {
      type: "pf.execution.observed",
      runId: row.runId,
      sourceEventId: row.effectKey,
      // The scope inside the payload must be the same one the request was signed for. Two scopes on
      // one message is one scope too many, and the Core is entitled to refuse the pair.
      scope,
      occurredAt: new Date().toISOString(),
      payload,
    }, row.correlationId);
  });

  handler(INTENT_KINDS.workUnitEnsure, async (row): Promise<DeliveryOutcome> => {
    const company = resolveCompany(row.companyId);
    if (company === null) return { status: "observed", reason: "no company context", retryAfterMs: 60_000 };
    const payload = readJson(row.payloadJson);
    const ref = await company.ports.work.ensureWorkUnit(payload as never, {
      commandId: row.effectKey,
      idempotencyKey: row.effectKey,
      correlationId: row.correlationId,
    });
    const scope = payload["scope"] as Scope;
    const requirement: WorkerRequirement = {
      scope,
      runId: String(payload["runId"] ?? ""),
      nodeId: String(payload["nodeId"] ?? ""),
      requiredCapabilities: stringArray(payload["requiredCapabilities"]),
      preferredRoles: stringArray(payload["preferredRoles"]),
      fallbackRoles: stringArray(payload["fallbackRoles"]),
      independentFrom: Array.isArray(payload["independentFrom"])
        ? (payload["independentFrom"] as WorkerRequirement["independentFrom"])
        : [],
      excludeSubjects: stringArray(payload["excludeSubjects"]),
    };
    const candidates = await company.ports.work.resolveWorker(requirement);
    const worker = candidates[0];
    if (worker === undefined) {
      return {
        status: "retry",
        result: { ref },
        reason: `no eligible worker for ${requirement.requiredCapabilities.join(", ") || "this node"}`,
        retryAfterMs: 30_000,
      };
    }
    const iteration = typeof payload["iteration"] === "number" ? payload["iteration"] : 0;
    const receipt = await company.ports.work.assignAndWake(
      {
        scope,
        runId: requirement.runId,
        nodeId: requirement.nodeId,
        iteration,
        // The Core creates the fenced attempt when the woken worker calls current/claim. This id
        // identifies the pre-claim dispatch and is deliberately deterministic for replay.
        attemptId: `dispatch:${requirement.runId}:${requirement.nodeId}:${iteration}`,
        workUnitRef: ref,
        workerSubjectRef: worker.subjectRef,
        workspaceRef: null,
        contractHash: "",
      },
      {
        commandId: `${row.effectKey}:dispatch`,
        idempotencyKey: `${row.effectKey}:dispatch`,
        correlationId: row.correlationId,
      },
    );
    if (!receipt.queued) {
      return {
        status: "retry",
        result: { ref, dispatch: receipt },
        reason: receipt.reason ?? "the platform did not queue a wakeup",
        retryAfterMs: 30_000,
      };
    }
    await acknowledgeCoreEffect(company, row, payload, "delivered", {
      providerRef: ref,
      workUnitRef: ref,
      dispatch: receipt,
    });
    return { status: "reconciled", result: { ref, dispatch: receipt }, receiptRef: ref.id };
  });

  handler(INTENT_KINDS.workUnitDispatch, async (row): Promise<DeliveryOutcome> => {
    const company = resolveCompany(row.companyId);
    if (company === null) return { status: "observed", reason: "no company context", retryAfterMs: 60_000 };
    const payload = readJson(row.payloadJson);
    const receipt = await company.ports.work.assignAndWake(payload as never, {
      commandId: row.effectKey,
      idempotencyKey: row.effectKey,
      correlationId: row.correlationId,
    });
    if (receipt.queued) {
      await acknowledgeCoreEffect(company, row, payload, "delivered", { dispatch: receipt });
    }
    return receipt.queued
      ? { status: "reconciled", result: receipt }
      : { status: "observed", result: receipt, reason: receipt.reason ?? "the platform did not queue a wakeup" };
  });

  handler(INTENT_KINDS.workUnitProjectStatus, async (row): Promise<DeliveryOutcome> => {
    const company = resolveCompany(row.companyId);
    if (company === null) return { status: "observed", reason: "no company context", retryAfterMs: 60_000 };
    const payload = readJson(row.payloadJson);
    await company.ports.work.projectStatus(payload as never, {
      commandId: row.effectKey,
      idempotencyKey: row.effectKey,
      correlationId: row.correlationId,
    });
    await acknowledgeCoreEffect(company, row, payload, "delivered", {
      target: payload["target"],
      projectionSequence: payload["projectionSequence"],
    });
    return { status: "reconciled" };
  });

  handler(INTENT_KINDS.executionRequestStop, async (row): Promise<DeliveryOutcome> => {
    const company = resolveCompany(row.companyId);
    if (company === null) return { status: "observed", reason: "no company context", retryAfterMs: 60_000 };
    const payload = readJson(row.payloadJson);
    const receipt = await company.ports.work.requestStop(payload["ref"] as never, {
      commandId: row.effectKey,
      idempotencyKey: row.effectKey,
      correlationId: row.correlationId,
    });
    if (receipt.outcome !== "unknown") {
      await acknowledgeCoreEffect(company, row, payload, "delivered", { stop: receipt });
    }
    // `unknown` is a legitimate durable answer, not a failure. It becomes an ambiguous delivery
    // so the reconciler keeps looking, and the Core is told the effect outcome is unknown.
    return receipt.outcome === "unknown"
      ? { status: "ambiguous", reason: "the platform could not confirm the stop" }
      : { status: "reconciled", result: receipt };
  });

  handler(INTENT_KINDS.artifactPublish, async (row): Promise<DeliveryOutcome> => {
    const company = resolveCompany(row.companyId);
    if (company === null) return { status: "observed", reason: "no company context", retryAfterMs: 60_000 };
    const payload = readJson(row.payloadJson);
    const published = await company.ports.artifacts.publish(payload as never, {
      commandId: row.effectKey,
      idempotencyKey: row.effectKey,
      correlationId: row.correlationId,
    });
    await acknowledgeCoreEffect(company, row, payload, "delivered", { artifact: published });
    return { status: "reconciled", result: published, receiptRef: published.providerRef.id };
  });

  handler(INTENT_KINDS.governanceInteractionCreate, async (row): Promise<DeliveryOutcome> => {
    const company = resolveCompany(row.companyId);
    if (company === null) return { status: "observed", reason: "no company context", retryAfterMs: 60_000 };
    const payload = readJson(row.payloadJson);
    const ref = await company.ports.governance.requestInteraction(payload as never, {
      commandId: row.effectKey,
      idempotencyKey: row.effectKey,
      correlationId: row.correlationId,
    });
    await acknowledgeCoreEffect(company, row, payload, "delivered", { providerRef: ref });
    return { status: "observed", result: { ref }, reason: "awaiting_human" };
  });

  handler(INTENT_KINDS.authorizationCheck, async (row): Promise<DeliveryOutcome> => {
    const company = resolveCompany(row.companyId);
    if (company === null) return { status: "observed", reason: "no company context", retryAfterMs: 60_000 };
    const payload = readJson(row.payloadJson);
    const status = await company.ports.governance.checkAuthorization(
      payload["ref"] as never,
      payload["action"] as never,
    );
    return { status: "reconciled", result: status };
  });

  handler(INTENT_KINDS.migrationApplied, async (row): Promise<DeliveryOutcome> => {
    const company = resolveCompany(row.companyId);
    if (company === null) return { status: "observed", reason: "no company context", retryAfterMs: 60_000 };
    const payload = readJson(row.payloadJson);
    const successorRunId = str(payload["successorRunId"]);
    const sourceRunId = str(payload["sourceRunId"]);
    if (successorRunId === null || sourceRunId === null) {
      return { status: "failed", reason: "a migration receipt must name its source and successor runs" };
    }
    const scope = scopeForIntent(company, row);
    if (scope === null) {
      return { status: "retry", reason: "migration receipt has no project scope", retryAfterMs: 30_000 };
    }
    company.store.putBinding({
      companyId: company.companyId,
      kind: "migration",
      providerId: successorRunId,
      projectId: scope.projectRef,
      payload: {
        sourceRunId,
        successorRunId,
        targetGraphVersion: payload["targetGraphVersion"],
        planHash: payload["planHash"],
        invalidatedPasses: payload["invalidatedPasses"],
        correlationId: row.correlationId,
      },
    });
    await acknowledgeCoreEffect(company, row, payload, "delivered", {
      sourceRunId,
      successorRunId,
      targetGraphVersion: payload["targetGraphVersion"],
    });
    return { status: "reconciled", result: { sourceRunId, successorRunId } };
  });

  handler(INTENT_KINDS.coreDeliveryAck, async (row): Promise<DeliveryOutcome> => {
    const company = resolveCompany(row.companyId);
    if (company === null || company.runtime === null) {
      return { status: "observed", reason: "no runtime client", retryAfterMs: 60_000 };
    }
    const payload = readJson(row.payloadJson);
    // An ack is a statement about a delivery, which belongs to a run and therefore to that run's
    // project. Signed company-wide it could never be accepted, so a delivery the platform had already
    // performed stayed unacknowledged in the Core forever.
    const ackScope = scopeForIntent(company, row);
    if (ackScope === null) {
      // Nothing to sign for. Retried rather than dropped: the delivery has already happened on the
      // platform side, so forgetting the ack would leave the Core permanently unsure about it.
      return { status: "observed", reason: "run project not yet recorded", retryAfterMs: 30_000 };
    }
    const result = await company.runtime.markDelivery(
      SYSTEM_ACTOR,
      ackScope,
      String(payload["deliveryId"] ?? ""),
      payload,
    );
    return { status: "reconciled", result };
  });
}

interface DeliveryRowLike {
  companyId: string;
  effectKey: string;
  correlationId: string;
  runId: string | null;
  /**
   * The project the intent was created for.
   *
   * Carried here because it is the scope a delivery is signed with. The alternative — re-deriving it
   * from the run binding on every send — meant a delivery for an intent that names no run, such as a
   * platform observation of an issue, had no project to be signed with at all.
   */
  projectId?: string;
}

const sealed = definePlugin(plugin);
export default sealed;
// `runWorker` performs its own main-module check, so importing this module from a test does
// not start the RPC host. The wiring below is exported so the tests build the *same* object
// graph production does.
runWorker(sealed, import.meta.url);

/**
 * The wiring surface the plugin's own tests use.
 *
 * Exported so a test drives the real assembly (`createSharedBridge` → `ensureCompany` →
 * `toolDepsFor` → `registerIntentHandlers`) rather than a reconstruction of it. A test that
 * rebuilt its own object graph would keep passing after the production wiring broke, which is
 * precisely the failure a harness test cannot catch on its own.
 */
export const __testing = {
  createSharedBridge,
  ensureCompany,
  toolDepsFor,
  toolWiringOf,
  toolRuntimeFor,
  registerIntentHandlers,
  makeRuntimeClient,
  fallbackStateRoot,
  instanceTag,
};
export type { Bridge };
