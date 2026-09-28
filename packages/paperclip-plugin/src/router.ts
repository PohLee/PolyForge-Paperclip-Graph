/**
 * The router: Root Issue → WorkOrder → GraphRun, and the control-request path back.
 *
 * Two directions, and the asymmetry between them is the point.
 *
 * **Inbound (Paperclip → Core).** An issue that admission accepted becomes exactly one
 * work-order intent in the bridge's outbox, keyed on
 * `scope + startIntentId + entrypoint`. The intent is written durably *before* any HTTP call,
 * so a replay of the same start intent finds the same row and the Core's own
 * `startIntentId` idempotency returns the same run. A hundred replays produce one run; an
 * ordinary issue produces none (AT-02).
 *
 * **Outbound (board → Core).** A board drag, a pause, or a cancel is an *authenticated control
 * request*, not a state change. The router turns it into a `pf.execution.observed` /
 * `pf.run.blocked` observation with `mayPassNode: false`, and the Core is told to checkpoint,
 * request a stop, and reconcile. History is never deleted (REQ-WORK-04, AT-04).
 *
 * The router also refuses the two shapes that look like routing and are not:
 *
 * * **Static blockers from the graph's own structure.** `all`/`any`/`quorum` joins and
 *   conditional branches are *not* translated into `blockedByIssueIds` on every materialized
 *   issue. Only approved work is materialized, and anything shown ahead of its turn stays
 *   non-executable (REQ-WORK-05). `ensureWorkUnit` therefore creates children with no
 *   pre-computed blocker set; the Core decides readiness, and a `todo` child is not
 *   executable until the Core says so.
 * * **A self-report of project identity.** `resolveTrustedProject` reads the issue through the
 *   company-scoped client and then reads its project; a project the host does not have in
 *   that company is a refusal, and the agent's self-reported company is never consulted.
 */

import { stableIdempotencyKey } from "@polyforge/protocol";
import type { ActorAssertion, CommandMeta, Scope } from "@polyforge/protocol";
import type { Issue } from "@paperclipai/plugin-sdk";
import type { BridgeDeps } from "./ports/index.js";
import type { AdmissionDecision } from "./admission.js";
import { INTENT_KINDS, workOrderEffectKey } from "./outbox/intents.js";
import { RUN_BINDING_KIND } from "./ports/work-management.js";
import { BridgeError, UnsupportedCapabilityError } from "./errors.js";
import { companyScope } from "./identity.js";

export interface StartRunRequest {
  readonly companyId: string;
  readonly issueId: string;
  readonly graphId?: string;
  readonly entrypoint?: string;
  readonly actor: ActorAssertion;
  readonly reason: string;
}

export interface StartRunOutcome {
  readonly startIntentId: string;
  readonly effectKey: string;
  /** `false` means an intent with the same effect key already existed: this is a replay. */
  readonly enqueued: boolean;
  readonly trigger: string;
  readonly scope: Scope;
}

export class Router {
  readonly #deps: BridgeDeps;

  /**
   * Resolve the entrypoint an admission will actually use.
   *
   * `requested` is non-empty when the issue body named one, and is trusted only insofar as the
   * Core's own graph definition decides whether it exists. When it is empty — the label- and
   * origin-kind triggers name a graph, not an entrypoint — the bridge asks the Core:
   *
   * * exactly one entrypoint → use it;
   * * none → refuse: the graph cannot be entered;
   * * several → refuse, with the names, because picking one would be a guess about which side
   *   entry an operator meant.
   *
   * The refusal is a `BLOCKED_PLATFORM` blocker rather than a default, because silently choosing
   * an entrypoint is how a run starts down the wrong branch.
   */
  async resolveEntrypoint(scope: Scope, graphId: string, requested: string): Promise<string> {
    if (requested.length > 0) return requested;
    const { runtime, logger } = this.#deps;
    if (runtime === null) {
      throw new BridgeError(
        "BRIDGE_CONFIG_INVALID",
        "BLOCKED_PLATFORM",
        "no runtime client is configured, so the graph's entrypoints cannot be resolved",
        { companyId: scope.companyRef, graphId },
      );
    }
    let entrypoints: string[] = [];
    try {
      // The caller's own scope, not a company-only one. The Core treats the company/project pair as
      // the single tenant identity and refuses an empty `projectRef`, so a company-only scope made
      // this read fail for every issue — and the failure was a scope error several layers from the
      // real cause, which is why admission could not start a run at all.
      const response = await runtime.listGraphs(
        { actorType: "system", actorId: "paperclip:admission", agentId: null, runId: null, roles: [] },
        scope,
      );
      const graphs = Array.isArray(response.graphs) ? response.graphs : [];
      const graph = graphs.find((entry) => (entry as Record<string, unknown>)["graphId"] === graphId);
      const declared = graph === undefined ? null : (graph as Record<string, unknown>)["entrypoints"];
      if (typeof declared === "object" && declared !== null) {
        entrypoints = Object.keys(declared as Record<string, unknown>);
      }
    } catch (error) {
      logger.warn("could not read the graph's entrypoints", {
        graphId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new BridgeError(
        "BRIDGE_UNSUPPORTED",
        "BLOCKED_PLATFORM",
        "the graph's entrypoints could not be read, so no entrypoint can be chosen",
        { graphId },
      );
    }
    if (entrypoints.length === 1) return entrypoints[0]!;
    if (entrypoints.length === 0) {
      throw new BridgeError("BRIDGE_UNSUPPORTED", "BLOCKED_PLATFORM", "the graph declares no entrypoint", {
        graphId,
      });
    }
    throw new BridgeError(
      "BRIDGE_UNSUPPORTED",
      "BLOCKED_PLATFORM",
      "the graph has several entrypoints and the issue names none; add a polyforge:work-order block naming the entrypoint",
      { graphId, entrypoints },
    );
  }

  constructor(deps: BridgeDeps) {
    this.#deps = deps;
  }

  /**
   * Re-derive the trusted project for an issue.
   *
   * Two host reads, both company-scoped: the issue, then its project. If the project is absent
   * from this company the answer is `null`, not a fallback — an issue in a company whose
   * project was deleted must not be admitted into whatever project happens to share its name.
   */
  async resolveTrustedProject(companyId: string, issueId: string): Promise<{ issue: Issue; projectId: string } | null> {
    const { ctx, logger } = this.#deps;
    const issue = await ctx.issues.get(issueId, companyId);
    if (!issue) {
      logger.warn("issue is not visible in the requested company", { issueId, companyId });
      return null;
    }
    if (issue.companyId !== companyId) {
      this.#deps.metrics.bump(companyId, "crossScopeDenials");
      throw new BridgeError("BRIDGE_SCOPE_VIOLATION", "BLOCKED_SCOPE", "issue resolved into a different company", {
        issueId,
        companyId,
        resolvedCompany: issue.companyId,
      });
    }
    if (issue.projectId === null || issue.projectId.length === 0) return null;
    const project = await ctx.projects.get(issue.projectId, companyId);
    if (!project) {
      throw new UnsupportedCapabilityError("projects.read", "the issue's project does not exist in this company", {
        issueId,
        projectId: issue.projectId,
        companyId,
      });
    }
    return { issue, projectId: project.id };
  }

  /**
   * Evaluate admission for an issue and, if admitted, enqueue exactly one work-order intent.
   *
   * This is the only place a GraphRun comes into existence on the Paperclip side, and it
   * writes only an *intent*. Whether a run is created is the Core's decision, reached through
   * its own idempotency check.
   */
  async considerIssue(
    decision: AdmissionDecision,
    actor: ActorAssertion,
    correlationId: string,
  ): Promise<StartRunOutcome | null> {
    if (!decision.admit) return null;
    const { deliveries, store, logger } = this.#deps;

    // The entrypoint is resolved before anything durable is written, so a graph whose
    // entrypoints cannot be decided produces no intent to clean up.
    const entrypoint = await this.resolveEntrypoint(decision.scope, decision.graphId, decision.entrypoint);
    const effectKey = workOrderEffectKey(decision.scope, decision.startIntentId, entrypoint);
    const payload = {
      scope: decision.scope,
      startIntentId: decision.startIntentId,
      graphId: decision.graphId,
      entrypoint,
      rootIssueRef: { provider: "paperclip", kind: "issue", id: decision.rootIssueId },
      inputSnapshot: decision.inputSnapshot,
      // The actor the host authenticated, forwarded so the Core knows *who* admitted the run.
      // The bridge derived it from a host context and a tool parameter cannot reach it, so this
      // is the same assertion the bridge would have signed, not a new claim. It is carried in
      // the intent (durable, company-scoped) rather than re-derived at delivery time, so a
      // delivery that happens minutes later still attributes the admission correctly.
      requestedBy: actor,
    };

    const created = deliveries.begin({
      effectKey,
      kind: INTENT_KINDS.workOrderCreate,
      scope: decision.scope,
      correlationId,
      payload,
    });

    if (!created) {
      logger.info("a work-order intent for this start intent already exists; returning the same run", {
        startIntentId: decision.startIntentId,
        effectKey,
      });
      return {
        startIntentId: decision.startIntentId,
        effectKey,
        enqueued: false,
        trigger: decision.trigger,
        scope: decision.scope,
      };
    }

    store.setCompat(decision.scope.companyRef, `start-intent/${effectKey}`, {
      startIntentId: decision.startIntentId,
      graphId: decision.graphId,
      entrypoint,
      projectId: decision.projectId,
      trigger: decision.trigger,
      actorType: actor.actorType,
      recordedAt: this.#deps.now().toISOString(),
    });

    return {
      startIntentId: decision.startIntentId,
      effectKey,
      enqueued: true,
      trigger: decision.trigger,
      scope: decision.scope,
    };
  }

  /**
   * Entry point for the `start-run` action and the `/work-orders` API route.
   *
   * Requires a human board actor: starting engineering work is a governance act, and an agent
   * that can start its own run can route around admission entirely. The API route's
   * `auth: "board"` is the first gate; this check is the second, and it is the one the plugin
   * controls.
   */
  async startRun(request: StartRunRequest, correlationId: string): Promise<StartRunOutcome> {
    if (request.actor.actorType !== "human") {
      this.#deps.metrics.bump(request.companyId, "crossScopeDenials", 0);
      throw new BridgeError(
        "BRIDGE_SCOPE_VIOLATION",
        "BLOCKED_AUTHORIZATION",
        "starting an engineering run requires a board user; an agent or system actor may not admit work",
        { actorType: request.actor.actorType },
      );
    }

    const resolved = await this.resolveTrustedProject(request.companyId, request.issueId);
    if (!resolved) {
      throw new BridgeError(
        "BRIDGE_SCOPE_VIOLATION",
        "BLOCKED_SCOPE",
        "issue is not visible in the requested company, or has no project",
        { issueId: request.issueId, companyId: request.companyId },
      );
    }

    const admission = this.#deps.admission;
    const decision = admission.evaluate(resolved.issue, request.actor.actorId);
    if (!decision.admit) {
      throw new BridgeError("BRIDGE_UNSUPPORTED", "BLOCKED_PLATFORM", `issue is not an engineering entry: ${decision.reason}`, {
        issueId: request.issueId,
        detail: decision.detail,
      });
    }
    if (request.graphId !== undefined && request.graphId !== decision.graphId) {
      throw new BridgeError(
        "BRIDGE_CONFIG_INVALID",
        "BLOCKED_PLATFORM",
        "the requested graph does not match the graph this issue's entry resolves to",
        { requested: request.graphId, resolved: decision.graphId },
      );
    }
    if (request.entrypoint !== undefined && request.entrypoint.length > 0) {
      const resolvedEntrypoint = await this.resolveEntrypoint(
        decision.scope,
        decision.graphId,
        request.entrypoint,
      );
      if (resolvedEntrypoint !== request.entrypoint) {
        throw new BridgeError(
          "BRIDGE_CONFIG_INVALID",
          "BLOCKED_PLATFORM",
          "the requested entrypoint does not exist on this graph",
          { requested: request.entrypoint, resolved: resolvedEntrypoint },
        );
      }
    }

    const outcome = await this.considerIssue(decision, request.actor, correlationId);
    if (!outcome) {
      throw new BridgeError("BRIDGE_UNSUPPORTED", "BLOCKED_PLATFORM", "admission produced no outcome", {});
    }
    return outcome;
  }

  /**
   * Record the run binding the Core reports back.
   *
   * The binding is what lets a later `issue.updated` for the Root Issue resolve to its run
   * without a reverse index, and it is written with `runId` + `rootIssueId` so the mapping is
   * auditable from either end.
   */
  recordRun(input: {
    scope: Scope;
    runId: string;
    workOrderId: string;
    graphId: string;
    graphVersion: number;
    entrypoint: string;
    rootIssueId: string;
    startIntentId: string;
    pins: Record<string, string>;
  }): void {
    this.#deps.store.putBinding({
      companyId: input.scope.companyRef,
      kind: RUN_BINDING_KIND,
      providerId: input.runId,
      projectId: input.scope.projectRef,
      payload: {
        ...input,
        // `graphVersion` and `pins` are recorded verbatim: an existing run keeps its pins
        // after a new version is published or activated (AT-19, REQ-GRAPH-06).
        recordedAt: this.#deps.now().toISOString(),
      },
    });
  }

  /** Build the `CommandMeta` for an outbound Core command tied to an intent. */
  commandMeta(input: { commandId: string; idempotencyKey: string; correlationId: string; causationId?: string }): CommandMeta {
    return {
      commandId: input.commandId,
      idempotencyKey: stableIdempotencyKey([input.idempotencyKey]),
      correlationId: input.correlationId,
      ...(input.causationId === undefined ? {} : { causationId: input.causationId }),
    };
  }
}
