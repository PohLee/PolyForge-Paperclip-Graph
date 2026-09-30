/**
 * The plugin-UI read surface: every key in `DATA_KEYS`.
 *
 * ## Why the identity check looks different here
 *
 * `ctx.data.register` receives `(params)` only — no authenticated actor and no host-resolved
 * company. The `companyId` in `params` is therefore a **caller-controlled string**, and
 * treating it as authorization is the cross-tenant read that REQ-NFR-02 forbids.
 *
 * The bridge cannot fix that at the SDK layer (it holds no `companies.read`, so it cannot even
 * prove a company id is real), so it does the next best thing and states it plainly:
 *
 * * Aggregate reads (`health`, `graph-library`, `runtime-runs`, `integration-health`) return
 *   data only for a company the bridge has *already worked for* — proven by rows in its own
 *   store. A fabricated company id yields an empty result, not another tenant's data.
 * * Object reads (`run-snapshot`, `run-events`, `issue-views`, `run-tab`, `migration-preview`)
 *   re-resolve the target from the bridge's bindings and compare its **recorded** scope to the
 *   requested one. A cross-scope read is denied and counted, not silently empty.
 *
 * No human actor is ever asserted for a UI read: the Core is told `actorType: "system"` with
 * the company in scope, so a read can never be attributed to a person who did not perform it.
 * Actions (`bridge/actions.ts`) are different — they do receive the host's authenticated actor
 * and do assert it.
 *
 * Every response says which side produced a status. `IssueView` in particular keeps
 * `issueStatus` and `graphStatus` side by side, because conflating them is how a dragged issue
 * becomes a passed node.
 */

import { CoreOutboxPump } from "../outbox/core-outbox.js";
import {
  DATA_KEYS,
  PROJECTED_ISSUE_STATUSES,
  projectIssueStatus,
} from "@polyforge/protocol";
import type {
  ActorAssertion,
  DataKey,
  GraphLibraryItem,
  HealthData,
  IssueView,
  MigrationPreview,
  NodeView,
  RunListItem,
  RunSnapshot,
  Scope,
} from "@polyforge/protocol";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { BridgeConfig, ConfigRegistry } from "../config.js";
import type { BridgeLogger } from "../logger.js";
import type { BridgeStore } from "../store.js";
import type { BridgeMetrics } from "../metrics.js";
import type { RuntimeClient } from "../runtime-client.js";
import { createPorts, type BridgeDeps, type DeliveryRecorder, type PortBundle } from "../ports/index.js";
import type { AdmissionGate } from "../admission.js";
import { AdmissionGate as AdmissionGateImpl } from "../admission.js";
import type { Router } from "../router.js";
import { Router as RouterImpl } from "../router.js";
import type { Reconciler } from "../reconciler.js";
import { Reconciler as ReconcilerImpl } from "../reconciler.js";
import type { Inbox } from "../events/inbox.js";
import type { OutboxPump } from "../outbox/delivery.js";
import type { CapabilityMatcher } from "../capabilities.js";
import { DISPATCH_BINDING_KIND, RUN_BINDING_KIND, WORK_UNIT_BINDING_KIND } from "../ports/work-management.js";
import { BridgeError, ScopeViolationError } from "../errors.js";

/** Everything one company's bridge needs. Built once per company by `worker.ts`. */
export interface CompanyContext {
  readonly companyId: string;
  readonly ctx: PluginContext;
  readonly config: BridgeConfig;
  readonly logger: BridgeLogger;
  readonly runtime: RuntimeClient | null;
  readonly store: BridgeStore;
  readonly metrics: BridgeMetrics;
  readonly ports: PortBundle;
  readonly admission: AdmissionGate;
  readonly router: Router;
  readonly reconciler: Reconciler;
  /**
   * Claims and delivers this company's slice of the Core's outbound queue.
   *
   * Per company because the Core scopes its outbox by company *and* project, and per pass it is
   * given one project: a claim that names the wrong pair is refused, and a claim that names no
   * project is refused too.
   */
  readonly coreOutbox: CoreOutboxPump;
  readonly inbox: Inbox;
  readonly pump: OutboxPump;
  readonly deliveries: DeliveryRecorder;
  readonly capabilitiesMatcher: CapabilityMatcher;
  readonly configRegistry: ConfigRegistry;
}

/** The process-level collaborators a company bundle is built from. */
export interface BridgeFactory {
  readonly ctx: PluginContext;
  readonly store: BridgeStore;
  readonly metrics: BridgeMetrics;
  readonly capabilities: CapabilityMatcher;
  readonly inbox: Inbox;
  readonly deliveries: DeliveryRecorder;
  readonly pump: OutboxPump;
  readonly logger: BridgeLogger;
  readonly registry: ConfigRegistry;
  /** Injected so a test can supply a fake Runtime; production passes the real factory. */
  readonly makeRuntime: (config: BridgeConfig, companyId: string) => RuntimeClient;
}

/**
 * Build the complete bridge for one company.
 *
 * This is the *single* wiring function, called by `worker.ts` and by the plugin's own tests.
 * That is deliberate: a test that re-assembled its own graph of these objects would pass while
 * the production wiring was broken, which is the failure mode harness tests are worst at
 * catching.
 *
 * The port bundle and the reconciler are mutually dependent — a port records a delivery the pump
 * executes, and the reconciler calls a port — so the dependency object carries a `ports()`
 * getter that closes over the bundle being built. That is a construction-cycle break, not a
 * mutable "set later" field a future change could read too early.
 */
export function createCompanyContext(factory: BridgeFactory, companyId: string, raw: Record<string, unknown>): CompanyContext {
  const { ctx, store, metrics, capabilities, inbox, deliveries, pump, registry, logger: baseLogger } = factory;
  const config = registry.load(companyId, raw);
  const logger = baseLogger.child({ companyId });
  const now = (): Date => new Date();

  // The runtime client is built *first* and injected into the dependency object, rather than
  // assigned onto it afterwards. `Reconciler` receives a copy of these fields, so a
  // post-construction assignment would leave the reconciler permanently holding `null` and
  // silently disabling its ability to resolve an ambiguous delivery.
  const runtime = factory.makeRuntime(config, companyId);

  const deps: BridgeDeps = {
    ctx,
    store,
    config,
    logger,
    capabilities,
    metrics,
    deliveries,
    runtime,
    pump,
    reconciler: null as unknown as Reconciler,
    router: null as unknown as Router,
    admission: new AdmissionGateImpl(config, logger, metrics),
    inbox,
    now,
    scope: { companyRef: companyId, projectRef: "" },
    ports: () => portBundle,
  };
  const router = new RouterImpl(deps);
  (deps as { router: Router }).router = router;
  const portBundle: PortBundle = createPorts(deps);
  const reconciler = new ReconcilerImpl({ ...deps, router, reconciler: deps.reconciler });

  // The Core's outbound queue. Built here, with the client and the store in hand, because both are
  // per-company: a claim is scoped by company *and* project, and an intent that names the wrong pair
  // is refused. The `begin` it enqueues through is the *bridge's own* recorder, so a Core intent
  // lands in exactly the queue the bridge already drains, with the same idempotence and the same
  // durable-before-effect ordering.
  const coreOutbox = new CoreOutboxPump({
    client: runtime,
    store,
    logger,
    metrics,
    actor: CORE_OUTBOX_ACTOR,
    begin: (intent) =>
      deliveries.begin({
        effectKey: intent.effectKey,
        kind: intent.kind,
        scope: intent.scope,
        correlationId: intent.correlationId,
        payload: intent.payload,
        runId: intent.runId ?? null,
        nodeId: intent.nodeId ?? null,
      }),
  });

  return {
    companyId,
    ctx,
    config,
    logger,
    runtime,
    store,
    metrics,
    ports: portBundle,
    admission: deps.admission,
    router,
    reconciler,
    coreOutbox,
    inbox,
    pump,
    deliveries,
    capabilitiesMatcher: capabilities,
    configRegistry: registry,
  };
}

/**
 * The actor the bridge asserts when it claims from the Core's own outbox.
 *
 * The Core — not the platform — is the source of these intents, and the bridge is the party the
 * Core already trusts as its single delivery surface. Asserting anything else would mean the
 * acknowledgement came from a principal the Core never authorised to speak for it.
 */
const CORE_OUTBOX_ACTOR = {
  actorType: "system" as const,
  actorId: "paperclip:bridge",
  roles: [] as string[],
};

export type CompanyResolver = (companyId: string) => CompanyContext | null;

/** The actor the bridge asserts for a UI read. Never a human. */
const READ_ACTOR: ActorAssertion = {
  actorType: "system",
  actorId: "paperclip:plugin-ui",
  agentId: null,
  runId: null,
  roles: [],
};

function readActor(): ActorAssertion {
  return { ...READ_ACTOR };
}

function requireCompanyId(params: Record<string, unknown>, key: DataKey): string {
  const value = params["companyId"];
  if (typeof value !== "string" || value.length === 0) {
    throw new BridgeError(
      "BRIDGE_SCOPE_VIOLATION",
      "BLOCKED_SCOPE",
      `${key}: companyId is required and must be a string`,
      { key },
    );
  }
  return value;
}

/**
 * The project a company-scoped read is scoped to.
 *
 * The Core treats the company/project pair as the only tenant identity, so a read that cannot name
 * its project has no honest answer to give. Returning an empty library instead would be a lie the
 * operator has to notice to distrust, so the refusal names the missing field.
 */
function readProjectId(params: Record<string, unknown>, key: DataKey): string {
  const value = params["projectId"] ?? params["projectRef"];
  if (typeof value !== "string" || value.length === 0) {
    throw new BridgeError(
      "BRIDGE_SCOPE_VIOLATION",
      "BLOCKED_SCOPE",
      `${key}: projectId is required; the Runtime Service scopes every read to a company and a project, ` +
        `and an empty project is refused rather than treated as "all projects"`,
      { key },
    );
  }
  return value;
}

function stringParam(params: Record<string, unknown>, key: string): string | null {
  const value = params[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberParam(params: Record<string, unknown>, key: string, fallback: number): number {
  const value = params[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function registerDataKeys(ctx: PluginContext, resolve: CompanyResolver): void {
  const handle = (key: DataKey) => async (params: Record<string, unknown>): Promise<unknown> => {
    const companyId = requireCompanyId(params, key);
    const company = resolve(companyId);
    if (company === null) {
      // The bridge has never worked for this company. Returning an empty, explicit shape keeps
      // the failure direction safe: a fabricated id reads nothing, including nothing about a
      // real tenant.
      return emptyFor(key, companyId);
    }
    return dispatch(key, company, params);
  };

  for (const key of DATA_KEYS) {
    ctx.data.register(key, handle(key));
  }
}

async function dispatch(key: DataKey, company: CompanyContext, params: Record<string, unknown>): Promise<unknown> {
  switch (key) {
    case "health":
      return healthData(company);
    case "integration-health":
      return integrationHealth(company);
    case "graph-library":
      return graphLibrary(company, params);
    case "graph-draft":
      return graphDraft(company, params);
    case "graph-versions":
      return graphVersions(company, params);
    case "runtime-runs":
      return runtimeRuns(company, params);
    case "run-snapshot":
      return runSnapshot(company, params);
    case "run-events":
      return runEvents(company, params);
    case "issue-views":
      return issueViews(company, params);
    case "project-views":
      return projectViews(company, params);
    case "agent-views":
      return agentViews(company, params);
    case "run-tab":
      return runTab(company, params);
    case "migration-preview":
      return migrationPreview(company, params);
    default: {
      // Exhaustiveness: a new DATA_KEY without a handler must not compile into a silent empty.
      const exhaustive: never = key;
      throw new BridgeError("BRIDGE_UNSUPPORTED", "BLOCKED_PLATFORM", `unhandled data key ${String(exhaustive)}`, {});
    }
  }
}

// ---------------------------------------------------------------------------
// health / integration-health
// ---------------------------------------------------------------------------

/**
 * The integration health document.
 *
 * The counters are the real stored values (see `src/metrics.ts`), not placeholders, and the
 * two age gauges are recomputed on every read so they cannot go stale. `issues` names anything
 * an operator has to act on: an unwritable store, an unreachable Runtime, a quarantined schema
 * batch, a delivery stuck in `ambiguous`.
 */
async function healthData(company: CompanyContext): Promise<HealthData> {
  const { runtime, store, metrics, config, logger } = company;
  const issues: string[] = [];

  const storeCheck = store.checkWritable();
  if (!storeCheck.ok) {
    issues.push(`bridge store is not writable at ${config.storePath}: ${storeCheck.detail ?? "unknown"}`);
  }

  let reachable = false;
  let runtimeStatus: string | null = null;
  let protocolVersion: number | null = null;
  let schemaVersion: number | null = null;
  let compilerVersion: string | null = null;
  let detail: string | null = null;

  if (runtime === null) {
    detail = "no runtime client is configured for this company";
    issues.push(detail);
  } else {
    try {
      const report = await runtime.health(readActor(), { companyRef: company.companyId, projectRef: "" });
      reachable = true;
      runtimeStatus = report.status;
      protocolVersion = report.protocolVersion;
      schemaVersion = report.schemaVersion;
      compilerVersion = report.compilerVersion;
      if (report.bridge.expectedIssuer !== runtime.issuer) {
        issues.push(
          `runtime expects issuer "${report.bridge.expectedIssuer}" but the bridge is configured as "${runtime.issuer}"`,
        );
      }
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error);
      issues.push(`runtime is not reachable: ${detail}`);
    }
  }

  if (config.runtimeTransport === "direct") {
    // Named rather than folded into the reachability line, because the operator has to be able to
    // see *which* boundary is holding the request line. Under `direct` the host's SSRF guard and
    // HTTP audit are not in the path, and a healthy `ready` must not read as "the host is
    // governing this". It is an issue, so it keeps the overall status at `degraded` until someone
    // moves the Runtime Service to an address the host will accept.
    issues.push(
      "the runtime transport is 'direct', so the host's SSRF guard and HTTP audit are not in the " +
        "request path; move the Runtime Service to a non-private address to use the governed client",
    );
  }

  const counters = metrics.counters(company.companyId);
  const oldestOutbox = counters.outboxOldestAgeSeconds;
  if (oldestOutbox !== null && oldestOutbox > 900) {
    issues.push(`oldest queued outbox intent is ${oldestOutbox}s old`);
  }
  const quarantine = store.countQuarantine(company.companyId);
  if (quarantine > 0) {
    issues.push(`${quarantine} event(s) are quarantined for an unknown schema`);
  }
  const ambiguous = store.countDeliveries(company.companyId, "ambiguous");
  if (ambiguous > 0) {
    issues.push(`${ambiguous} delivery operation(s) have an unknown outcome and need reconciliation`);
  }

  const hostCompatible = true;
  const status: HealthData["status"] = !storeCheck.ok
    ? "read_only"
    : !reachable
      ? "degraded"
      : issues.length === 0
        ? "ready"
        : "degraded";

  logger.debug("integration health computed", { status, issueCount: issues.length });

  return {
    status,
    runtime: {
      reachable,
      status: runtimeStatus,
      protocolVersion,
      schemaVersion,
      compilerVersion,
      detail,
    },
    host: {
      serverVersion: null,
      compatible: hostCompatible,
      // The host version is not readable from a plugin on this baseline, so the field is
      // explicitly null with an explanation rather than a fabricated version.
      detail: "the plugin SDK does not expose the host server version; compatibility is checked at install time against minimumHostVersion",
    },
    counters,
    issues,
    checkedAt: new Date().toISOString(),
  };
}

async function integrationHealth(company: CompanyContext): Promise<HealthData> {
  return healthData(company);
}

// ---------------------------------------------------------------------------
// graph library / drafts / versions
// ---------------------------------------------------------------------------

async function graphLibrary(company: CompanyContext, params: Record<string, unknown>): Promise<GraphLibraryItem[]> {
  const { runtime } = company;
  if (runtime === null) return [];
  // The library is project-scoped, and the Core refuses an empty `projectRef` rather than guessing a
  // tenant. An empty string here used to be sent anyway, so the call failed with a scope error that
  // read like a configuration problem. The host passes the project on every project surface; when it
  // does not, the answer is an explicit refusal naming what is missing rather than a silent empty
  // list, which would read as "this company has no graphs".
  const projectId = readProjectId(params, "graph-library");
  const response = await runtime.listGraphs(readActor(), { companyRef: company.companyId, projectRef: projectId });
  const raw = Array.isArray(response.graphs) ? response.graphs : [];
  const items: GraphLibraryItem[] = [];
  for (const entry of raw) {
    const record = entry as Record<string, unknown>;
    const graphId = typeof record["graphId"] === "string" ? record["graphId"] : null;
    if (graphId === null) continue;
    // The Core already answers with the active version and the version count, read through the
    // registry's own pointer. Re-deriving them here cost a second round trip per graph and picked
    // the active version by testing `retired === false`, which no version record carries — so the
    // library rendered every graph with no active version at all. Ask the authority rather than
    // guessing at it a second time.
    const activeVersion = typeof record["activeVersion"] === "number" ? record["activeVersion"] : null;
    const versionCount = typeof record["versionCount"] === "number" ? record["versionCount"] : null;
    const versions = versionCount === null ? await safeVersions(company, projectId, graphId) : null;
    const latestVersion =
      versionCount === null
        ? versions && versions.length > 0
          ? Math.max(...versions.map((version) => version.version))
          : null
        : versionCount;
    const entrypoints = record["entrypoints"];
    items.push({
      graphId,
      name: typeof record["name"] === "string" ? record["name"] : graphId,
      description: typeof record["description"] === "string" ? record["description"] : "",
      activeVersion,
      latestVersion,
      draftCount: typeof record["draftCount"] === "number" ? record["draftCount"] : 0,
      entrypoints:
        typeof entrypoints === "object" && entrypoints !== null ? Object.keys(entrypoints as Record<string, unknown>) : [],
      runCount: typeof record["runCount"] === "number" ? record["runCount"] : 0,
      retired: activeVersion === null && (versionCount ?? 0) > 0,
    });
  }
  return items;
}

async function safeVersions(company: CompanyContext, projectId: string, graphId: string) {
  const { runtime } = company;
  if (runtime === null) return [];
  try {
    const response = await runtime.listVersions(readActor(), { companyRef: company.companyId, projectRef: projectId }, graphId);
    return Array.isArray(response.versions) ? response.versions : [];
  } catch (error) {
    company.logger.warn("could not list graph versions", {
      graphId,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

async function graphDraft(company: CompanyContext, params: Record<string, unknown>): Promise<unknown> {
  const draftId = stringParam(params, "draftId");
  const { runtime } = company;
  if (draftId === null || runtime === null) return { draft: null, definition: null };
  // A draft belongs to a project. The editor reads it through a project surface, so the project is
  // in the parameters; without one the read is refused rather than signed for no project in
  // particular, which is what an empty `projectRef` asks the Core to mean.
  const projectId = readProjectId(params, "graph-draft");
  return runtime.getDraft(readActor(), { companyRef: company.companyId, projectRef: projectId }, draftId);
}

async function graphVersions(company: CompanyContext, params: Record<string, unknown>): Promise<unknown> {
  const graphId = stringParam(params, "graphId");
  if (graphId === null) return { versions: [] };
  const projectId = readProjectId(params, "graph-versions");
  return { versions: await safeVersions(company, projectId, graphId) };
}

// ---------------------------------------------------------------------------
// runs
// ---------------------------------------------------------------------------

async function runtimeRuns(company: CompanyContext, params: Record<string, unknown>): Promise<RunListItem[]> {
  const { runtime, store, ctx } = company;
  if (runtime === null) return [];
  // Runtime requires a company/project pair. The company-level Runs page has no selected project,
  // so enumerate projects from Paperclip and issue one explicitly scoped read per project.
  const projects = await ctx.projects.list({ companyId: company.companyId });
  const limit = numberParam(params, "limit", 50);
  const responses = await Promise.all(projects.map((project) => runtime.listRuns(
    readActor(),
    { companyRef: company.companyId, projectRef: project.id },
    {
      ...(stringParam(params, "graphId") === null ? {} : { graphId: stringParam(params, "graphId") as string }),
      ...(stringParam(params, "status") === null ? {} : { status: stringParam(params, "status") as string }),
      limit,
    },
  )));
  const snapshots = responses.flatMap((response) => Array.isArray(response.runs) ? response.runs : [])
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, limit);
  const items: RunListItem[] = [];
  for (const snapshot of snapshots) {
    const binding = store.getBinding(company.companyId, RUN_BINDING_KIND, snapshot.runId);
    const rootIssueId = binding === null ? null : readJson(binding.payloadJson)["rootIssueId"];
    items.push({
      runId: snapshot.runId,
      graphId: snapshot.graphId,
      graphVersion: snapshot.graphVersion,
      status: snapshot.status,
      entrypoint: snapshot.entrypoint,
      stateVersion: snapshot.stateVersion,
      // The Root Issue ref comes from the bridge's own binding, never from the run payload, so
      // a Core that echoed back an id from another tenant could not redirect the link.
      rootIssueRef:
        typeof rootIssueId === "string" && rootIssueId.length > 0
          ? { provider: "paperclip", kind: "issue", id: rootIssueId }
          : null,
      pendingGovernanceCount: snapshot.pendingGovernance.filter((request) => request.resolvedAt === null).length,
      unknownEffectCount: snapshot.effects.filter((effect) => effect.status === "UNKNOWN").length,
      updatedAt: snapshot.updatedAt,
    });
  }
  return items;
}

async function runSnapshot(company: CompanyContext, params: Record<string, unknown>): Promise<RunSnapshot | null> {
  const runId = stringParam(params, "runId");
  if (runId === null) return null;
  const scope = requireRecordedRunScope(company, runId, "run-snapshot");
  const { runtime } = company;
  if (runtime === null) return null;
  return runtime.getRun(readActor(), scope, runId);
}

/**
 * Re-derive a run's scope from the bridge's own binding and compare it with the request.
 *
 * A run id is a bearer token the UI could carry from another tenant. The binding is the only
 * evidence of which company a run belongs to, so a run with no binding, or one whose recorded
 * company differs from the request, is refused and counted.
 */
function requireRecordedRunScope(company: CompanyContext, runId: string, what: string): Scope {
  const binding = company.store.getBinding(company.companyId, RUN_BINDING_KIND, runId);
  if (binding === null) {
    company.metrics.bump(company.companyId, "crossScopeDenials");
    throw new ScopeViolationError(`${what}: this run is not recorded for the requested company`, {
      runId,
      companyId: company.companyId,
    });
  }
  if (binding.companyId !== company.companyId) {
    company.metrics.bump(company.companyId, "crossScopeDenials");
    throw new ScopeViolationError(`${what}: this run is recorded under a different company`, { runId });
  }
  return { companyRef: company.companyId, projectRef: binding.projectId };
}

async function runEvents(company: CompanyContext, params: Record<string, unknown>): Promise<unknown> {
  const runId = stringParam(params, "runId");
  if (runId === null) return { events: [] };
  const scope = requireRecordedRunScope(company, runId, "run-events");
  const { runtime } = company;
  if (runtime === null) return { events: [] };
  const after = numberParam(params, "after", 0);
  const limit = numberParam(params, "limit", 200);
  return runtime.listEvents(readActor(), scope, runId, after, limit);
}

// ---------------------------------------------------------------------------
// issues / projects / agents
// ---------------------------------------------------------------------------

/**
 * The issue views the board surfaces.
 *
 * `needsEngineeringVerification` is computed from the *host's* current issue status and the
 * Core's node states, so a board drag to `done` on a run with unverified nodes surfaces as
 * "needs verification", never as a pass.
 */
async function issueViews(company: CompanyContext, params: Record<string, unknown>): Promise<IssueView[]> {
  const { ctx, store, runtime } = company;
  const issueId = stringParam(params, "issueId");
  const scope: { companyId: string; projectId: string | null } = {
    companyId: company.companyId,
    projectId: stringParam(params, "projectId"),
  };

  if (issueId !== null) {
    const issue = await ctx.issues.get(issueId, company.companyId);
    if (!issue) {
      company.metrics.bump(company.companyId, "crossScopeDenials");
      throw new ScopeViolationError("issue-views: the issue is not visible in this company", { issueId });
    }
    const runId = runIdForIssue(company, issueId);
    const snapshot = runId !== null && runtime !== null
      ? await runtime.getRun(readActor(), { companyRef: company.companyId, projectRef: issue.projectId ?? "" }, runId)
      : null;
    return [await company.ports.work.issueView(company.companyId, issueId, snapshot)];
  }

  // Default: the Root Issues the bridge knows about, newest binding first.
  const views: IssueView[] = [];
  for (const row of store.listBindings(company.companyId, RUN_BINDING_KIND, 50)) {
    const payload = readJson(row.payloadJson);
    const rootIssueId = payload["rootIssueId"];
    if (typeof rootIssueId !== "string") continue;
    const runId = payload["runId"];
    const snapshot =
      typeof runId === "string" && runtime !== null
        ? await runtime.getRun(readActor(), { companyRef: company.companyId, projectRef: row.projectId }, runId)
        : null;
    views.push(await company.ports.work.issueView(company.companyId, rootIssueId, snapshot));
  }
  void scope;
  return views;
}

function runIdForIssue(company: CompanyContext, issueId: string): string | null {
  for (const kind of [WORK_UNIT_BINDING_KIND, RUN_BINDING_KIND]) {
    for (const row of company.store.listBindings(company.companyId, kind, 2000)) {
      const payload = readJson(row.payloadJson);
      if (payload["issueId"] === issueId || payload["rootIssueId"] === issueId) {
        return typeof payload["runId"] === "string" ? payload["runId"] : null;
      }
    }
  }
  return null;
}

async function projectViews(company: CompanyContext, params: Record<string, unknown>): Promise<unknown> {
  const { ctx, store } = company;
  const projectId = stringParam(params, "projectId");
  const projects = await ctx.projects.list({ companyId: company.companyId });
  const out: unknown[] = [];
  for (const project of projects) {
    if (projectId !== null && project.id !== projectId) continue;
    const workspace = await ctx.projects.getPrimaryWorkspace(project.id, company.companyId);
    const runIds = store
      .listBindings(company.companyId, RUN_BINDING_KIND, 500)
      .filter((row) => row.projectId === project.id)
      .map((row) => readJson(row.payloadJson)["graphId"])
      .filter((value): value is string => typeof value === "string");
    out.push({
      projectId: project.id,
      name: project.name,
      // A workspace is metadata only. The bridge never provisions one, so the UI must not
      // offer a "create workspace" affordance that the bridge cannot honour.
      primaryWorkspace: workspace === null ? null : { id: workspace.id, path: workspace.path, isPrimary: true },
      workspaceMode: company.config.workspaceProviderMode,
      graphIds: [...new Set(runIds)],
    });
  }
  return out;
}

/**
 * The agent roster with its engineering capability bindings.
 *
 * `capabilities` is the *binding*, not `Agent.capabilities`: a free-text field on the agent
 * would make the grant exactly as strong as the string that names it. `blockedFallbacks` is
 * included so the UI can explain why a run did not start.
 */
async function agentViews(company: CompanyContext, params: Record<string, unknown>): Promise<unknown> {
  const { ctx } = company;
  const agents = await ctx.agents.list({ companyId: company.companyId });
  const bindings = company.store.listBindings(company.companyId, "capability_binding", 1000);
  const byAgent = new Map<string, Record<string, unknown>[]>();
  for (const row of bindings) {
    const payload = readJson(row.payloadJson);
    const agentId = payload["agentId"];
    if (typeof agentId !== "string") continue;
    const list = byAgent.get(agentId) ?? [];
    list.push(payload);
    byAgent.set(agentId, list);
  }

  const runId = stringParam(params, "runId");
  const nodeId = stringParam(params, "nodeId");
  const out: unknown[] = [];
  for (const agent of agents) {
    out.push({
      agentId: agent.id,
      name: agent.name,
      role: agent.role,
      status: agent.status,
      platformStatus: agent.status,
      // Labelled separately so the UI can never present a platform string as an engineering one.
      engineeringBindings: byAgent.get(agent.id) ?? [],
      bindingsAreEngineeringScoped: true,
      dispatches: storeDispatches(company, agent.id),
      ...(runId === null || nodeId === null
        ? {}
        : { matcher: company.capabilitiesMatcher.resolve({
              scope: { companyRef: company.companyId, projectRef: agent.id.length > 0 ? "" : "" },
              runId,
              nodeId,
              requiredCapabilities: stringArrayParam(params, "requiredCapabilities"),
              ...(stringArrayParam(params, "preferredRoles").length > 0
                ? { preferredRoles: stringArrayParam(params, "preferredRoles") }
                : {}),
              ...(stringArrayParam(params, "fallbackRoles").length > 0
                ? { fallbackRoles: stringArrayParam(params, "fallbackRoles") }
                : {}),
            }) }),
    });
  }
  return out;
}

function stringArrayParam(params: Record<string, unknown>, key: string): string[] {
  const value = params[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function storeDispatches(company: CompanyContext, agentId: string): unknown[] {
  const out: unknown[] = [];
  for (const row of company.store.listBindings(company.companyId, DISPATCH_BINDING_KIND, 1000)) {
    const payload = readJson(row.payloadJson);
    if (payload["agentId"] !== agentId) continue;
    out.push({
      runId: payload["runId"],
      nodeId: payload["nodeId"],
      iteration: payload["iteration"],
      issueId: payload["issueId"],
      lastObservation: payload["lastObservation"] ?? null,
    });
  }
  return out;
}

/**
 * Everything a run detail tab needs in one round trip.
 *
 * A dropped SSE stream is the normal case, not the exception, so this key is the authoritative
 * snapshot: the stream is only a refresh hint, and the UI is expected to call this after a
 * reconnect (REQ-UI-04, AT-31).
 */
async function runTab(company: CompanyContext, params: Record<string, unknown>): Promise<unknown> {
  const runId = stringParam(params, "runId");
  if (runId === null) return null;
  const scope = requireRecordedRunScope(company, runId, "run-tab");
  const { runtime, store } = company;
  if (runtime === null) return null;
  const snapshot = await runtime.getRun(readActor(), scope, runId);

  const nodes: NodeView[] = snapshot.nodes.map((node) => ({
    nodeId: node.nodeId,
    kind: node.kind,
    status: node.status,
    iteration: node.iteration,
    waitReason: node.waitReason,
    blockReason: node.blockReason,
    requiredCapabilities: node.requiredCapabilities,
    assignedSubject: node.assignedSubject,
    childRunId: node.childRunId,
    contractHash: node.contractHash,
    // The issue status is a *projection*; it is rendered beside the graph status with its
    // source, never merged into it.
    projectedIssueStatus: projectIssueStatus(node.status as Parameters<typeof projectIssueStatus>[0], {
      waitingGovernance: snapshot.pendingGovernance.some((request) => request.resolvedAt === null),
    }),
  }));

  return {
    run: {
      runId: snapshot.runId,
      graphId: snapshot.graphId,
      // The pins are the run's own frozen closure. Publishing them is how an operator can see
      // that this run did *not* drift when a new version was activated (AT-19).
      graphVersion: snapshot.graphVersion,
      pins: snapshot.pins,
      status: snapshot.status,
      stateVersion: snapshot.stateVersion,
      eventSequence: snapshot.eventSequence,
      scope: snapshot.scope,
    },
    nodes,
    attempts: snapshot.attempts,
    evidence: snapshot.evidence,
    gates: snapshot.gates,
    effects: snapshot.effects,
    pendingGovernance: snapshot.pendingGovernance,
    blockers: snapshot.blockers,
    // The authoritative cursor. After an SSE drop the UI fetches from here, not from the last
    // event it happened to see. `authoritative` says so explicitly, because the failure this
    // guards against is a UI that renders a gap-filled view as if it were the truth.
    authoritativeSnapshot: {
      runId: snapshot.runId,
      stateVersion: snapshot.stateVersion,
      eventSequence: snapshot.eventSequence,
    },
    authoritative: true,
    streamIsHintOnly: true,
    projectionLagSeconds: store.projectionLagSeconds(company.companyId),
  };
}

// ---------------------------------------------------------------------------
// migration preview
// ---------------------------------------------------------------------------

/**
 * The dry-run migration preview.
 *
 * Read-only: it asks the Core to compute the plan and reports it. It never commits, and it
 * surfaces `quiescent: false` and the pending-governance list so the UI can refuse to offer a
 * commit button for a run that still has a live worker or an unknown effect (REQ-MIG-03).
 */
async function migrationPreview(company: CompanyContext, params: Record<string, unknown>): Promise<MigrationPreview | null> {
  const runId = stringParam(params, "runId");
  const targetGraphVersion = numberParam(params, "targetGraphVersion", 0);
  if (runId === null || targetGraphVersion === 0) return null;
  const scope = requireRecordedRunScope(company, runId, "migration-preview");
  const { runtime, store } = company;
  if (runtime === null) return null;

  const nodeMappingRaw = params["nodeMapping"];
  const nodeMapping =
    typeof nodeMappingRaw === "object" && nodeMappingRaw !== null ? (nodeMappingRaw as Record<string, string>) : {};
  const preview = await runtime.planMigration(readActor(), scope, runId, {
    runId,
    targetGraphVersion,
    ...(Object.keys(nodeMapping).length > 0 ? { nodeMapping } : {}),
    commandId: `${runId}:migration:plan:${targetGraphVersion}`,
    idempotencyKey: `pf.migration.plan:${runId}:${targetGraphVersion}`,
    correlationId: runId,
  });

  // Enrich with the bridge's own view of quiescence, because the Core cannot see whether a
  // Paperclip execution is still live.
  const ambiguous = store.countDeliveries(company.companyId, "ambiguous");
  const unknownExecutions = countUnknownExecutions(company);
  return {
    ...preview,
    quiescent: preview.quiescent && ambiguous === 0 && unknownExecutions === 0,
    blockers: [
      ...preview.blockers,
      ...(ambiguous > 0
        ? [
            {
              code: "BLOCKED_EFFECT_UNKNOWN",
              reason: "BLOCKED_EFFECT_UNKNOWN",
              message: `${ambiguous} bridge delivery operation(s) have an unknown outcome`,
            },
          ]
        : []),
      ...(unknownExecutions > 0
        ? [
            {
              code: "EXECUTION_UNKNOWN",
              reason: "BLOCKED_EFFECT_UNKNOWN",
              message: `${unknownExecutions} dispatched execution(s) are still unknown`,
            },
          ]
        : []),
    ],
  };
}

function countUnknownExecutions(company: CompanyContext): number {
  let count = 0;
  for (const row of company.store.listBindings(company.companyId, DISPATCH_BINDING_KIND, 1000)) {
    const payload = readJson(row.payloadJson);
    const observation = payload["lastObservation"];
    if (typeof observation === "object" && observation !== null) {
      if ((observation as Record<string, unknown>)["state"] === "unknown") count += 1;
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function emptyFor(key: DataKey, companyId: string): unknown {
  const empty: Record<DataKey, () => unknown> = {
    health: () => ({
      status: "blocked",
      runtime: { reachable: false, status: null, protocolVersion: null, schemaVersion: null, compilerVersion: null, detail: null },
      host: { serverVersion: null, compatible: false, detail: "no bridge configuration for this company" },
      counters: {
        inboxDuplicates: 0,
        schemaQuarantine: 0,
        outboxOldestAgeSeconds: null,
        projectionLagSeconds: null,
        reconcileMismatch: 0,
        unknownAttempts: 0,
        staleLeaseRejected: 0,
        duplicateEffectsPrevented: 0,
        waitingGovernanceOldestAgeSeconds: null,
        gateMissingEvidence: 0,
        budgetBlocks: 0,
        platformBlocks: 0,
        workspaceValidationFailures: 0,
        artifactDigestMismatch: 0,
        crossScopeDenials: 0,
      },
      issues: [`no PolyForge configuration is loaded for company ${companyId}`],
      checkedAt: new Date().toISOString(),
    }),
    "integration-health": () => ({
      status: "blocked",
      runtime: { reachable: false, status: null, protocolVersion: null, schemaVersion: null, compilerVersion: null, detail: null },
      host: { serverVersion: null, compatible: false, detail: "no bridge configuration for this company" },
      counters: {
        inboxDuplicates: 0,
        schemaQuarantine: 0,
        outboxOldestAgeSeconds: null,
        projectionLagSeconds: null,
        reconcileMismatch: 0,
        unknownAttempts: 0,
        staleLeaseRejected: 0,
        duplicateEffectsPrevented: 0,
        waitingGovernanceOldestAgeSeconds: null,
        gateMissingEvidence: 0,
        budgetBlocks: 0,
        platformBlocks: 0,
        workspaceValidationFailures: 0,
        artifactDigestMismatch: 0,
        crossScopeDenials: 0,
      },
      issues: [`no PolyForge configuration is loaded for company ${companyId}`],
      checkedAt: new Date().toISOString(),
    }),
    "graph-library": () => [],
    "graph-draft": () => ({ draft: null, definition: null }),
    "graph-versions": () => ({ versions: [] }),
    "runtime-runs": () => [],
    "run-snapshot": () => null,
    "run-events": () => ({ events: [] }),
    "issue-views": () => [],
    "project-views": () => [],
    "agent-views": () => [],
    "run-tab": () => null,
    "migration-preview": () => null,
  };
  return empty[key]();
}

function readJson(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export { PROJECTED_ISSUE_STATUSES };
