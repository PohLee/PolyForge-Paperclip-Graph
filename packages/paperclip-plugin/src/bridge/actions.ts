/**
 * The plugin-UI write surface: every key in `ACTION_KEYS`.
 *
 * ## "A hidden button is not authorization" — enforced server-side
 *
 * Every handler re-validates three things before it does anything, regardless of what the UI
 * sent or what it displayed:
 *
 * 1. **Identity.** `context.actor` is host-authenticated and immutable. The actor *type*
 *    decides which keys are even reachable: a governance act — publishing a version, activating
 *    one, starting a run, pausing/cancelling/retrying a run, committing a migration — requires
 *    a board user. An agent or system actor pressing one is refused and counted. That is the
 *    inverse of the UI rule and the same rule: what the client can render is not what the
 *    server allows.
 * 2. **Scope.** `params.companyId` is caller-controlled; `context.actor.companyId` and
 *    `context.companyId` are host-authorized. They must be equal, and the target object's
 *    *recorded* scope must match too.
 * 3. **Version.** Draft saves carry `If-Match` on the revision; publishes carry
 *    `expectedRevision`; migrations compare on `stateVersion`. A stale client gets a conflict,
 *    not a silent overwrite.
 *
 * Deliberately absent from every handler: anything that decides a human approval, responds to
 * an interaction, or asserts a transition. The manifest does not grant those capabilities and
 * no code path here reaches for them (AT-13).
 */

import { ACTION_KEYS } from "@polyforge/protocol";
import type { ActionKey, ActorAssertion } from "@polyforge/protocol";
import type { PluginPerformActionContext } from "@paperclipai/plugin-sdk";
import type { CompanyContext, CompanyResolver } from "./data.js";
import { agentActor, boardActor } from "../identity.js";
import { BridgeError, ScopeViolationError } from "../errors.js";
import { DISPATCH_BINDING_KIND, RUN_BINDING_KIND } from "../ports/work-management.js";

/**
 * Actions only a board user may perform.
 *
 * Recording a review belongs here for the same reason publishing does: both are statements about a
 * human having read something. A review recorded by an agent is not a review, and the Core refuses
 * one — so the bridge refuses it first, with a message that says why.
 */
const HUMAN_ONLY: ReadonlySet<ActionKey> = new Set<ActionKey>([
  "record-draft-review",
  "publish-draft",
  "activate-version",
  "start-run",
  "run-command",
  "plan-migration",
  "commit-migration",
  "retry-node",
]);

function stringParam(params: Record<string, unknown>, key: string): string | null {
  const value = params[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberParam(params: Record<string, unknown>, key: string): number | null {
  const value = params[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * An integer parameter, accepting the numeric-string form a UI control produces.
 *
 * A revision crosses three boundaries — the editor's state, this action, and the Core's compare —
 * and a checkbox or input will hand it over as a string. Refusing that outright makes the feature
 * unreachable; accepting it with `Number()` would also accept `""` and `" 3 "`, so a blank field
 * would become revision 0 and a compare-and-swap would then succeed against the wrong draft. The
 * value is accepted only if it *is* an integer once parsed, and only if something was there.
 */
function integerParam(params: Record<string, unknown>, key: string): number | null {
  const value = params[key];
  if (typeof value === "number") return Number.isInteger(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function recordParam(params: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = params[key];
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * The three re-validations, in one place so a new action cannot forget one.
 *
 * Returns the resolved company, or throws with a specific reason. Every refusal increments
 * `crossScopeDenials` when it is a scope problem and `platformBlocks` when it is an
 * authorization-shape problem, so the health counters distinguish the two.
 */
function authorise(
  key: ActionKey,
  company: CompanyContext,
  params: Record<string, unknown>,
  context: PluginPerformActionContext,
): ActorAssertion {
  const hostCompany = context.companyId ?? context.actor.companyId ?? "";
  const requestedCompany = stringParam(params, "companyId");
  if (requestedCompany === null) {
    throw new BridgeError("BRIDGE_SCOPE_VIOLATION", "BLOCKED_SCOPE", `${key}: companyId is required`, { key });
  }
  if (requestedCompany !== hostCompany) {
    company.metrics.bump(hostCompany, "crossScopeDenials");
    throw new ScopeViolationError(`${key}: the requested company is not the authenticated company`, {
      requestedCompany,
      hostCompany,
    });
  }
  if (HUMAN_ONLY.has(key) && context.actor.type !== "user") {
    company.metrics.bump(hostCompany, "platformBlocks");
    throw new BridgeError(
      "BRIDGE_SCOPE_VIOLATION",
      "BLOCKED_AUTHORIZATION",
      `${key} requires a board user; this actor is "${context.actor.type}"`,
      { key, actorType: context.actor.type },
    );
  }
  return context.actor.type === "agent" && context.actor.agentId !== null
    ? agentActor({
        agentId: context.actor.agentId,
        runId: context.actor.runId ?? "",
        companyId: hostCompany,
        projectId: "",
      })
    : boardActor(context);
}

function requireRuntime(company: CompanyContext, key: ActionKey) {
  if (company.runtime === null) {
    throw new BridgeError(
      "BRIDGE_CONFIG_INVALID",
      "BLOCKED_PLATFORM",
      `${key}: the PolyForge Runtime Service is not configured for this company`,
      { key },
    );
  }
  return company.runtime;
}

/**
 * Re-derive a run's scope from the bridge's own binding.
 *
 * A run id from the UI is untrusted. The binding is the only evidence of which company owns it,
 * and the target's recorded project must match the request too.
 */
function requireRunScope(company: CompanyContext, runId: string, key: ActionKey, projectId: string | null) {
  const binding = company.store.getBinding(company.companyId, RUN_BINDING_KIND, runId);
  if (binding === null) {
    company.metrics.bump(company.companyId, "crossScopeDenials");
    throw new ScopeViolationError(`${key}: this run is not recorded for the requesting company`, { runId });
  }
  if (projectId !== null && binding.projectId !== projectId) {
    company.metrics.bump(company.companyId, "crossScopeDenials");
    throw new ScopeViolationError(`${key}: this run belongs to another project`, {
      runId,
      bindingProject: binding.projectId,
      requestedProject: projectId,
    });
  }
  return { companyRef: company.companyId, projectRef: binding.projectId };
}

export function registerActionKeys(
  register: (key: ActionKey, handler: (params: Record<string, unknown>, context: PluginPerformActionContext) => Promise<unknown>) => void,
  resolve: CompanyResolver,
): void {
  for (const key of ACTION_KEYS) {
    register(key, async (params, context) => {
      const requested = stringParam(params, "companyId");
      if (requested === null) {
        throw new BridgeError("BRIDGE_SCOPE_VIOLATION", "BLOCKED_SCOPE", `${key}: companyId is required`, { key });
      }
      const company = resolve(requested);
      if (company === null) {
        throw new BridgeError(
          "BRIDGE_SCOPE_VIOLATION",
          "BLOCKED_SCOPE",
          `${key}: no PolyForge configuration is loaded for this company`,
          { key, companyId: requested },
        );
      }
      const actor = authorise(key, company, params, context);
      return perform(key, company, params, actor, context);
    });
  }
}

async function perform(
  key: ActionKey,
  company: CompanyContext,
  params: Record<string, unknown>,
  actor: ActorAssertion,
  context: PluginPerformActionContext,
): Promise<unknown> {
  const { runtime, store, logger, router } = company;
  const projectId = stringParam(params, "projectId");
  const scopeOf = (runId: string) => requireRunScope(company, runId, key, projectId);
  void context;

  switch (key) {
    // -----------------------------------------------------------------------
    // Authoring
    // -----------------------------------------------------------------------
    case "create-draft": {
      const client = requireRuntime(company, key);
      const graphId = stringParam(params, "graphId");
      if (graphId === null) {
        throw new BridgeError("BRIDGE_CONFIG_INVALID", "BLOCKED_PLATFORM", "graphId is required", {});
      }
      const baseVersion = numberParam(params, "baseVersion");
      return client.createDraft(actor, { companyRef: company.companyId, projectRef: projectId ?? "" }, graphId, {
        ...(baseVersion === null ? {} : { baseVersion }),
        commandId: `${graphId}:draft:create:${Date.now()}`,
        idempotencyKey: `pf.draft.create:${company.companyId}:${graphId}:${baseVersion ?? "none"}`,
        correlationId: `${graphId}:${actor.actorId}`,
      });
    }

    case "save-draft": {
      const client = requireRuntime(company, key);
      const draftId = stringParam(params, "draftId");
      const revision = stringParam(params, "revision");
      if (draftId === null || revision === null) {
        throw new BridgeError("BRIDGE_CONFIG_INVALID", "BLOCKED_PLATFORM", "draftId and revision are required", {});
      }
      // `If-Match` carries the revision the client believes it is editing. A stale client gets
      // a 409 from the Core rather than overwriting someone else's edit.
      return client.saveDraft(
        actor,
        { companyRef: company.companyId, projectRef: projectId ?? "" },
        draftId,
        { definition: recordParam(params, "definition") as never, changeSummary: stringParam(params, "changeSummary") ?? undefined },
        revision,
      );
    }

    case "validate-draft": {
      const client = requireRuntime(company, key);
      const draftId = requireDraftId(params, key);
      return client.validateDraft(actor, { companyRef: company.companyId, projectRef: projectId ?? "" }, draftId);
    }

    case "compile-draft": {
      const client = requireRuntime(company, key);
      const draftId = requireDraftId(params, key);
      return client.compileDraft(actor, { companyRef: company.companyId, projectRef: projectId ?? "" }, draftId);
    }

    // -----------------------------------------------------------------------
    // Governance: human-only, compare-and-swap
    // -----------------------------------------------------------------------
    /**
     * Record a human review of one exact target hash.
     *
     * The reviewer is the *asserted* actor, never a body field. A body is the one part of a request
     * the signature does not decide, so a `reviewer: "user-anna"` in the payload would let anyone
     * record a review in anyone else's name — and the Core refuses a body that names an identity
     * anyway, which is the same rule that makes this safe.
     *
     * The action exists because publication requires a review the Core has persisted. The editor's
     * "attest review" control was writing a name into React state and nothing else, so the Core saw
     * no review and refused to publish with "publishing requires a review bound to the current
     * revision" — a message about a step the UI reported as complete.
     */
    case "record-draft-review": {
      const client = requireRuntime(company, key);
      const draftId = requireDraftId(params, key);
      const reviewTargetHash = stringParam(params, "reviewTargetHash");
      if (reviewTargetHash === null) {
        throw new BridgeError(
          "BRIDGE_CONFIG_INVALID",
          "BLOCKED_PLATFORM",
          "reviewTargetHash is required; a review is bound to one exact hash, and a review of " +
            "nothing in particular would authorise a later edit that was never read",
          {},
        );
      }
      return client.recordDraftReview(actor, { companyRef: company.companyId, projectRef: projectId ?? "" }, draftId, {
        reviewTargetHash,
        commandId: `${draftId}:review:${reviewTargetHash}`,
        idempotencyKey: `pf.draft.review:${company.companyId}:${draftId}:${reviewTargetHash}`,
        correlationId: draftId,
        authorizationRefs: Array.isArray(params["authorizationRefs"]) ? params["authorizationRefs"] : [],
      });
    }

    case "publish-draft": {
      const client = requireRuntime(company, key);
      const draftId = requireDraftId(params, key);
      // A draft revision is a monotonic integer and the Core compares it as one. It arrived here
      // as a string, which the Core rejects with "expectedRevision must be an integer" — so the
      // editor's normal Publish path could never succeed. The number is required rather than
      // coerced: a missing revision and a revision of `0` are different facts, and `Number("")` is 0.
      const expectedRevision = integerParam(params, "expectedRevision");
      if (expectedRevision === null) {
        throw new BridgeError(
          "BRIDGE_CONFIG_INVALID",
          "BLOCKED_PLATFORM",
          "expectedRevision is required and must be an integer; publishing is a compare-and-swap " +
            "on the draft's numeric revision",
          {},
        );
      }
      return client.publishDraft(actor, { companyRef: company.companyId, projectRef: projectId ?? "" }, draftId, {
        expectedRevision,
        definitionHash: stringParam(params, "definitionHash") ?? "",
        compilerVersion: stringParam(params, "compilerVersion") ?? "",
        planHash: stringParam(params, "planHash") ?? "",
        reviewTargetHash: stringParam(params, "reviewTargetHash") ?? "",
        authorizationRefs: Array.isArray(params["authorizationRefs"]) ? params["authorizationRefs"] : [],
        commandId: `${draftId}:publish:${expectedRevision}`,
        idempotencyKey: `pf.draft.publish:${company.companyId}:${draftId}:${expectedRevision}`,
        correlationId: draftId,
      });
    }

    case "activate-version": {
      const client = requireRuntime(company, key);
      const graphId = stringParam(params, "graphId");
      const expectedGeneration = numberParam(params, "expectedGeneration");
      if (graphId === null || expectedGeneration === null) {
        throw new BridgeError(
          "BRIDGE_CONFIG_INVALID",
          "BLOCKED_PLATFORM",
          "graphId and expectedGeneration are required; activation is a compare-and-swap on the default pointer",
          {},
        );
      }
      const result = await client.activateVersion(
        actor,
        { companyRef: company.companyId, projectRef: projectId ?? "" },
        graphId,
        {
          graphId,
          version: numberParam(params, "version"),
          expectedGeneration,
          commandId: `${graphId}:activate:${expectedGeneration}`,
          idempotencyKey: `pf.graph.activate:${company.companyId}:${graphId}:${expectedGeneration}`,
          correlationId: graphId,
        },
      );
      logger.info("graph default version activated; existing runs keep their own pins", {
        graphId,
        expectedGeneration,
      });
      return result;
    }

    // -----------------------------------------------------------------------
    // Runtime control: human-only
    // -----------------------------------------------------------------------
    case "start-run": {
      const issueId = stringParam(params, "issueId");
      if (issueId === null) {
        throw new BridgeError("BRIDGE_CONFIG_INVALID", "BLOCKED_PLATFORM", "issueId is required", {});
      }
      const graphId = stringParam(params, "graphId");
      const entrypoint = stringParam(params, "entrypoint");
      const outcome = await router.startRun(
        {
          companyId: company.companyId,
          issueId,
          ...(graphId === null ? {} : { graphId }),
          ...(entrypoint === null ? {} : { entrypoint }),
          actor,
          reason: stringParam(params, "reason") ?? "started from the PolyForge UI",
        },
        `${issueId}:start-run`,
      );
      return { ...outcome, enqueued: outcome.enqueued };
    }

    case "run-command": {
      const client = requireRuntime(company, key);
      const runId = stringParam(params, "runId");
      const command = stringParam(params, "command");
      if (runId === null || command === null) {
        throw new BridgeError("BRIDGE_CONFIG_INVALID", "BLOCKED_PLATFORM", "runId and command are required", {});
      }
      const scope = scopeOf(runId);
      return client.runCommand(actor, scope, runId, {
        runId,
        command,
        ...(stringParam(params, "nodeId") === null ? {} : { nodeId: stringParam(params, "nodeId") as string }),
        reason: stringParam(params, "reason") ?? "issued from the PolyForge UI",
        commandId: `${runId}:${command}:${Date.now()}`,
        idempotencyKey: `pf.run.command:${company.companyId}:${runId}:${command}:${store.getCompat<string | null>(company.companyId, `run-state-version/${runId}`, "0") ?? "0"}`,
        correlationId: runId,
        ...(recordParam(params, "resolutionDetail")["value"] === undefined
          ? {}
          : { resolutionDetail: recordParam(params, "resolutionDetail") }),
      });
    }

    case "retry-node": {
      const client = requireRuntime(company, key);
      const runId = stringParam(params, "runId");
      if (runId === null) {
        throw new BridgeError("BRIDGE_CONFIG_INVALID", "BLOCKED_PLATFORM", "runId is required", {});
      }
      const scope = scopeOf(runId);
      const result = await client.runCommand(actor, scope, runId, {
        runId,
        command: "retry",
        ...(stringParam(params, "nodeId") === null ? {} : { nodeId: stringParam(params, "nodeId") as string }),
        reason: stringParam(params, "reason") ?? "retry requested from the PolyForge UI",
        commandId: `${runId}:retry:${Date.now()}`,
        idempotencyKey: `pf.run.retry:${company.companyId}:${runId}:${stringParam(params, "nodeId") ?? "all"}`,
        correlationId: runId,
      });
      logger.info("retry requested through the Core; the Core owns the rework budget", { runId });
      return result;
    }

    // -----------------------------------------------------------------------
    // Migration
    // -----------------------------------------------------------------------
    case "plan-migration": {
      const client = requireRuntime(company, key);
      const runId = stringParam(params, "runId");
      const targetGraphVersion = numberParam(params, "targetGraphVersion");
      if (runId === null || targetGraphVersion === null) {
        throw new BridgeError(
          "BRIDGE_CONFIG_INVALID",
          "BLOCKED_PLATFORM",
          "runId and targetGraphVersion are required",
          {},
        );
      }
      const scope = scopeOf(runId);
      return client.planMigration(actor, scope, runId, {
        runId,
        targetGraphVersion,
        ...(recordParam(params, "nodeMapping")["__never"] === undefined && Object.keys(recordParam(params, "nodeMapping")).length > 0
          ? { nodeMapping: recordParam(params, "nodeMapping") as Record<string, string> }
          : {}),
        commandId: `${runId}:migration:plan:${targetGraphVersion}`,
        idempotencyKey: `pf.migration.plan:${company.companyId}:${runId}:${targetGraphVersion}`,
        correlationId: runId,
      });
    }

    case "commit-migration": {
      const client = requireRuntime(company, key);
      const runId = stringParam(params, "runId");
      const planHash = stringParam(params, "planHash");
      const stateVersion = numberParam(params, "expectedStateVersion");
      if (runId === null || planHash === null || stateVersion === null) {
        throw new BridgeError(
          "BRIDGE_CONFIG_INVALID",
          "BLOCKED_PLATFORM",
          "runId, planHash and expectedStateVersion are required; a migration commits on a reviewed plan and a CAS",
          {},
        );
      }
      const scope = scopeOf(runId);
      // The bridge adds its own quiescence gate on top of the Core's: an ambiguous delivery or
      // an unknown execution means the source may still be moving, so the commit is refused
      // here rather than trusted to the Core alone.
      const ambiguous = store.countDeliveries(company.companyId, "ambiguous");
      if (ambiguous > 0) {
        company.metrics.bump(company.companyId, "platformBlocks");
        throw new BridgeError(
          "BRIDGE_INTEGRITY_FAILURE",
          "BLOCKED_EFFECT_UNKNOWN",
          "migration is refused while a delivery operation has an unknown outcome",
          { ambiguous },
        );
      }
      return client.commitMigration(actor, scope, runId, {
        runId,
        planHash,
        expectedStateVersion: stateVersion,
        commandId: `${runId}:migration:commit:${planHash}`,
        idempotencyKey: `pf.migration.commit:${company.companyId}:${runId}:${planHash}`,
        correlationId: runId,
      });
    }

    // -----------------------------------------------------------------------
    // Read-only refresh
    // -----------------------------------------------------------------------
    case "refresh": {
      // Deliberately not human-only and deliberately not mutating: it re-reads the
      // authoritative objects for this company and returns the current counters. It is the
      // action a UI calls after a dropped SSE stream, so it must be cheap and safe to call
      // from any actor.
      const runId = stringParam(params, "runId");
      const snapshot =
        runId !== null && runtime !== null
          ? await runtime.getRun(actor, requireRunScope(company, runId, key, projectId), runId)
          : null;
      return {
        refreshedAt: new Date().toISOString(),
        counters: company.metrics.counters(company.companyId),
        snapshot,
        // The UI must treat the stream as a hint only: this cursor is the truth.
        authoritative: true,
      };
    }

    default: {
      const exhaustive: never = key;
      throw new BridgeError("BRIDGE_UNSUPPORTED", "BLOCKED_PLATFORM", `unhandled action key ${String(exhaustive)}`, {});
    }
  }
}

function requireDraftId(params: Record<string, unknown>, key: ActionKey): string {
  const draftId = stringParam(params, "draftId");
  if (draftId === null) {
    throw new BridgeError("BRIDGE_CONFIG_INVALID", "BLOCKED_PLATFORM", `${key}: draftId is required`, {});
  }
  return draftId;
}

export { DISPATCH_BINDING_KIND };
