/**
 * `WorkManagementPort` against the Paperclip host.
 *
 * Paperclip owns issue lifecycle, assignment, checkout and the physical invocation of a
 * worker. This port only ever *asks*: it creates a child issue, assigns an agent, requests a
 * wakeup, reads an execution, and projects a status. It never spawns a process and never
 * asserts that work succeeded (docs/02 §2, REQ-WS-05, AT-08).
 *
 * The three behaviours that carry the invariants:
 *
 * * **`ensureWorkUnit` looks up before it creates.** A replay of the same
 *   `scope + run + node + iteration` must find the existing child by
 *   `originKind`/`originId` — the host's own idempotency surface — and only then consider
 *   creating. Creating first and hoping the unique index saves us would make the bridge's own
 *   store the only idempotency mechanism, and the host's copy would be redundant.
 * * **`requestStop` never reports a stop it cannot confirm.** The SDK exposes no
 *   execution-stop API to a plugin on this baseline, so a non-terminal run is reported as
 *   `unknown`. The Core turns that into `UNKNOWN` + reconciliation, which is the only correct
 *   outcome; a "requested, assume it stopped" would let two workers produce effects at once.
 * * **A board drag is an observation.** `projectStatus` writes a status the Core committed.
 *   A status the *board* changed produces an event the pump turns into a completion
 *   observation, never into a pass.
 */

import { projectIssueStatus } from "@polyforge/protocol";
import type {
  CommandMeta,
  DispatchBinding,
  DispatchReceipt,
  ExecutionObservation,
  IssueView,
  NodeView,
  ProviderRefLike,
  RunSnapshot,
  StatusProjection,
  StopReceipt,
  WorkManagementPort,
  WorkerCandidate,
  WorkUnitIntent,
} from "@polyforge/protocol";
import type { Issue } from "@paperclipai/plugin-sdk";
import type { BridgeDeps } from "./index.js";
import { guardScope, providerRef } from "./index.js";
import { INTENT_KINDS, workUnitEffectKey } from "../outbox/intents.js";
import { BridgeError, UnsupportedCapabilityError } from "../errors.js";

/** The `originKind` the bridge owns. Child issues are distinguishable from human work. */
export const CHILD_ISSUE_ORIGIN_KIND = "plugin:polyforge:node" as const;
export const WORK_UNIT_BINDING_KIND = "work_unit" as const;
export const DISPATCH_BINDING_KIND = "dispatch" as const;
export const RUN_BINDING_KIND = "run" as const;
export const ATTEMPT_BINDING_KIND = "attempt" as const;

/** `originId` is `<runId>:<nodeId>:<iteration>`: the identity from docs/05 §8.1. */
export function childOriginId(runId: string, nodeId: string, iteration: number): string {
  return `${runId}:${nodeId}:${iteration}`;
}

export function workUnitBindingId(runId: string, nodeId: string, iteration: number): string {
  return `${runId}:${nodeId}:${iteration}`;
}

export class WorkManagementPortImpl implements WorkManagementPort {
  readonly #deps: BridgeDeps;

  constructor(deps: BridgeDeps) {
    this.#deps = deps;
  }

  // -------------------------------------------------------------------------
  // ensureWorkUnit
  // -------------------------------------------------------------------------

  /**
   * Materialize (or re-find) the child issue that carries one node execution.
   *
   * Order of operations, and why:
   * 1. Scope guard — before any read, so a cross-scope intent never reveals whether the
   *    object exists (existence itself is tenant information).
   * 2. Host lookup by `originKind` + `originId`. This is the authoritative dedupe: it finds
   *    children created by an *earlier bridge process* whose local store was lost.
   * 3. Local binding re-read. If the binding names an issue, re-read the object; if it is
   *    gone, fall through to create (a deleted work unit must be rematerialized, not
   *    silently treated as delivered).
   * 4. Create, then record the binding and mark the delivery reconciled in one store
   *    transaction, so a crash between the create and the record is recoverable by step 2.
   */
  async ensureWorkUnit(intent: WorkUnitIntent, meta: CommandMeta): Promise<ProviderRefLike> {
    const { ctx, store, config, logger, metrics, deliveries } = this.#deps;
    const authenticated = { companyId: intent.scope.companyRef, projectId: intent.scope.projectRef };
    guardScope(intent.scope, authenticated, "ensureWorkUnit", metrics);

    if (intent.projectRef.length === 0) {
      throw new BridgeError(
        "BRIDGE_SCOPE_VIOLATION",
        "BLOCKED_SCOPE",
        "work unit intent has no project; project identity must come from the trusted issue relation",
        { runId: intent.runId, nodeId: intent.nodeId },
      );
    }

    const effectKey = workUnitEffectKey(intent.scope, intent.runId, intent.nodeId, intent.iteration);
    const originId = childOriginId(intent.runId, intent.nodeId, intent.iteration);
    const bindingId = workUnitBindingId(intent.runId, intent.nodeId, intent.iteration);
    const logger2 = logger.child({ correlationId: meta.correlationId, runId: intent.runId, nodeId: intent.nodeId });

    deliveries.begin({
      effectKey,
      kind: INTENT_KINDS.workUnitEnsure,
      scope: intent.scope,
      correlationId: meta.correlationId,
      runId: intent.runId,
      nodeId: intent.nodeId,
      payload: { originId, workUnitKey: bindingId, title: intent.title },
    });
    deliveries.sent(effectKey);

    // (2) authoritative dedupe on the host's own origin surface.
    const existingByOrigin = await ctx.issues.list({
      companyId: intent.scope.companyRef,
      originKind: CHILD_ISSUE_ORIGIN_KIND,
      originId,
    });
    const found = existingByOrigin[0];
    if (found) {
      this.#assertIssueInScope(found, intent, "ensureWorkUnit(existing)");
      this.#recordBinding(intent, found.id, bindingId, originId, meta, null);
      deliveries.observed(effectKey, { issueId: found.id, reused: true });
      deliveries.reconciled(effectKey, "existing work unit re-used");
      logger2.info("re-used an existing child issue for a replayed work unit", { issueId: found.id });
      return providerRef("issue", found.id);
    }

    // (3) local binding, in case a previous create succeeded but the record was lost.
    const binding = store.getBinding(intent.scope.companyRef, WORK_UNIT_BINDING_KIND, bindingId);
    if (binding) {
      const recorded = await ctx.issues.get(String(JSON.parse(binding.payloadJson)["issueId"] ?? ""), intent.scope.companyRef);
      if (recorded) {
        deliveries.reconciled(effectKey, "work unit recovered from the local binding");
        return providerRef("issue", recorded.id);
      }
      logger2.warn("recorded work unit no longer exists; re-materializing", { bindingId });
    }

    // (4) create.
    const projectId = await this.#resolveProjectId(intent);
    const createInput: Parameters<typeof ctx.issues.create>[0] = {
      companyId: intent.scope.companyRef,
      projectId,
      title: intent.title,
      description: this.#describeWorkUnit(intent, originId),
      status: "todo",
      originKind: CHILD_ISSUE_ORIGIN_KIND,
      originId,
      originRunId: intent.runId,
      ...(intent.parentIssueRef ? { parentId: intent.parentIssueRef.id } : {}),
      // No `assigneeUserId` and no human `actor`: the child belongs to the engineering graph,
      // and a human assignee would make it look like human-owned work in the board.
      actor: { actorAgentId: null, actorUserId: null, actorRunId: null },
    };
    if (config.workspaceProviderMode === "inherited" && intent.parentIssueRef) {
      // Inheriting is the host's own workspace policy. The bridge never provisions one and
      // never claims a path it did not receive from the host.
      createInput.inheritExecutionWorkspaceFromIssueId = intent.parentIssueRef.id;
    }

    const created = await ctx.issues.create(createInput);
    this.#recordBinding(intent, created.id, bindingId, originId, meta, created.id);
    deliveries.observed(effectKey, { issueId: created.id, reused: false });
    deliveries.reconciled(effectKey, "work unit created");
    logger2.info("created a child issue for a node execution", { issueId: created.id, originId });
    return providerRef("issue", created.id);
  }

  #assertIssueInScope(issue: Issue, intent: WorkUnitIntent, what: string): void {
    if (issue.companyId !== intent.scope.companyRef) {
      this.#deps.metrics.bump(intent.scope.companyRef, "crossScopeDenials");
      throw new BridgeError("BRIDGE_SCOPE_VIOLATION", "BLOCKED_SCOPE", `${what}: issue is in another company`, {
        issueId: issue.id,
        issueCompany: issue.companyId,
        scopeCompany: intent.scope.companyRef,
      });
    }
    if (issue.projectId !== intent.projectRef) {
      throw new BridgeError(
        "BRIDGE_SCOPE_VIOLATION",
        "BLOCKED_SCOPE",
        `${what}: issue is in another project than the work order`,
        { issueId: issue.id, issueProject: issue.projectId, scopeProject: intent.projectRef },
      );
    }
  }

  #describeWorkUnit(intent: WorkUnitIntent, originId: string): string {
    const lines = [
      intent.description,
      "",
      "---",
      `PolyForge work unit (projection of engineering state; not the source of truth)`,
      `- run: ${intent.runId}`,
      `- node: ${intent.nodeId}`,
      `- iteration: ${intent.iteration}`,
      `- correlation key: ${originId}`,
    ];
    if (intent.requiredCapabilities.length > 0) {
      lines.push(`- required capabilities: ${intent.requiredCapabilities.join(", ")}`);
    }
    lines.push(
      `- workspace requirement: ${intent.workspaceRequirement.mode}` +
        (intent.workspaceRequirement.requireReadOnlyForReviewer ? " (read-only reviewer)" : ""),
    );
    if (intent.workspaceRequirement.repositories.length > 0) {
      for (const repo of intent.workspaceRequirement.repositories) {
        lines.push(`- repo ${repo.repoRef} @ ${repo.baseRef}${repo.commit ? ` (pinned ${repo.commit})` : ""}`);
      }
    }
    return lines.join("\n");
  }

  /**
   * Resolve the project from the trusted issue→project relation.
   *
   * Three checks, in order, all fail-closed:
   * 1. the project must exist in *this* company through the host's company-scoped read;
   * 2. when the intent names a parent issue, the parent must be in this company **and in the
   *    same project** — this is the trusted relation REQ-WORK-02 requires, and it is what stops
   *    a Core from steering a child issue into a sibling project;
   * 3. the resolved project id is what is written on the child issue, never a value from the
   *    request.
   */
  async #resolveProjectId(intent: WorkUnitIntent): Promise<string> {
    const project = await this.#deps.ctx.projects.get(intent.projectRef, intent.scope.companyRef);
    if (!project) {
      this.#deps.metrics.bump(intent.scope.companyRef, "crossScopeDenials");
      throw new BridgeError(
        "BRIDGE_SCOPE_VIOLATION",
        "BLOCKED_SCOPE",
        "the work order names a project that is not in this company; project identity comes from the issue relation",
        { projectRef: intent.projectRef, companyRef: intent.scope.companyRef },
      );
    }
    if (intent.parentIssueRef !== null) {
      const parent = await this.#deps.ctx.issues.get(intent.parentIssueRef.id, intent.scope.companyRef);
      if (!parent) {
        this.#deps.metrics.bump(intent.scope.companyRef, "crossScopeDenials");
        throw new BridgeError(
          "BRIDGE_SCOPE_VIOLATION",
          "BLOCKED_SCOPE",
          "the parent issue is not in this company",
          { parentIssueId: intent.parentIssueRef.id, companyRef: intent.scope.companyRef },
        );
      }
      if (parent.projectId !== intent.projectRef) {
        this.#deps.metrics.bump(intent.scope.companyRef, "crossScopeDenials");
        throw new BridgeError(
          "BRIDGE_SCOPE_VIOLATION",
          "BLOCKED_SCOPE",
          "the work order names a project the parent issue is not in",
          {
            parentIssueId: parent.id,
            parentProject: parent.projectId,
            requestedProject: intent.projectRef,
          },
        );
      }
    }
    return project.id;
  }

  #recordBinding(
    intent: WorkUnitIntent,
    issueId: string,
    bindingId: string,
    originId: string,
    meta: CommandMeta,
    createdIssueId: string | null,
  ): void {
    // The child's graph pin, copied from the run binding when one has been observed. A child is
    // work belonging to one graph version; recording the version is what makes "this child was
    // created under v13" checkable after a v14 is published, instead of being an assumption.
    const runRow = this.#deps.store.getBinding(
      intent.scope.companyRef,
      RUN_BINDING_KIND,
      intent.runId,
    );
    const runPin = runRow === null ? {} : safeJson(runRow.payloadJson);
    this.#deps.store.putBinding({
      companyId: intent.scope.companyRef,
      kind: WORK_UNIT_BINDING_KIND,
      providerId: bindingId,
      projectId: intent.projectRef,
      payload: {
        runId: intent.runId,
        nodeId: intent.nodeId,
        iteration: intent.iteration,
        issueId,
        originKind: CHILD_ISSUE_ORIGIN_KIND,
        originId,
        correlationKey: intent.correlationKey,
        requiredCapabilities: intent.requiredCapabilities,
        workspaceRequirement: intent.workspaceRequirement,
        ...(runPin["graphVersion"] === undefined ? {} : { graphVersion: runPin["graphVersion"] }),
        ...(runPin["pins"] === undefined ? {} : { pins: runPin["pins"] }),
        commandId: meta.commandId,
        idempotencyKey: meta.idempotencyKey,
        createdIssueId,
        updatedAt: this.#deps.now().toISOString(),
      },
    });
  }

  // -------------------------------------------------------------------------
  // projectStatus
  // -------------------------------------------------------------------------

  /**
   * Write the Core's committed status onto the child issue.
   *
   * Two refusals matter here:
   * * **A stale projection is dropped**, using `projection_offsets`. An out-of-order delivery
   *   must not move a board backwards.
   * * **An unknown status is not projected at all.** `projectIssueStatus` returns `null` for a
   *   value outside the vocabulary; writing "something" in that case would render an unknown
   *   as a pass, which docs/05 §4 and REQ-UI-04 forbid.
   */
  async projectStatus(projection: StatusProjection, meta: CommandMeta): Promise<void> {
    const { ctx, store, config, logger, metrics, deliveries } = this.#deps;
    guardScope(projection.scope, { companyId: projection.scope.companyRef, projectId: projection.scope.projectRef }, "projectStatus", metrics);

    const bindingId = workUnitBindingId(projection.runId, projection.target.id, 0);
    const binding = store.getBinding(projection.scope.companyRef, WORK_UNIT_BINDING_KIND, bindingId);
    const issueId = binding ? String(safeJson(binding.payloadJson)["issueId"] ?? "") : projection.target.id;
    if (issueId.length === 0) {
      logger.warn("projection has no known work unit; nothing to project", {
        runId: projection.runId,
        target: projection.target.id,
      });
      return;
    }

    const effectKey = `pf.projection:${projection.scope.companyRef}:${issueId}:${projection.projectionSequence}`;
    const advanced = store.advanceProjection({
      companyId: projection.scope.companyRef,
      targetKind: "issue",
      targetId: issueId,
      projectionSequence: projection.projectionSequence,
    });
    if (!advanced) {
      // Already applied a newer or equal sequence. Dropping is the whole point: the newest
      // state wins regardless of arrival order.
      metrics.bump(projection.scope.companyRef, "reconcileMismatch", 0);
      logger.debug("dropped a stale status projection", {
        issueId,
        projectionSequence: projection.projectionSequence,
      });
      return;
    }

    const waitingGovernance = projection.nodeStates.some((node) => node.status === "WAITING_GOVERNANCE");
    const sourceStatus =
      projection.status === "ACTIVE" || projection.status === "WAITING" || projection.status === "PAUSED" || projection.status === "CREATED"
        ? projection.nodeStates[0]?.status
        : projection.status;
    const projected = projectIssueStatus(
      (sourceStatus ?? projection.status) as Parameters<typeof projectIssueStatus>[0],
      { waitingGovernance },
    );

    if (!config.enableProjections) {
      logger.info("projections are disabled; recording the offset but not writing the issue", {
        issueId,
        graphStatus: projection.status,
      });
      return;
    }

    if (projected === null) {
      // Unknown status: keep the offset (so the sequence is not replayed) and surface the
      // problem. Rendering an unknown as a pass is the failure this guards.
      metrics.bump(projection.scope.companyRef, "reconcileMismatch");
      logger.warn("refusing to project a status outside the vocabulary", {
        issueId,
        status: projection.status,
        summary: projection.summary,
      });
      return;
    }

    deliveries.begin({
      effectKey,
      kind: INTENT_KINDS.workUnitProjectStatus,
      scope: projection.scope,
      correlationId: projection.correlationId,
      runId: projection.runId,
      payload: { issueId, projected, meta: { commandId: meta.commandId } },
    });
    deliveries.sent(effectKey);

    const current = await ctx.issues.get(issueId, projection.scope.companyRef);
    if (!current) {
      deliveries.failed(effectKey, "work unit no longer exists; reconciliation will re-materialize it");
      logger.warn("cannot project onto a work unit that no longer exists", { issueId });
      return;
    }
    if (current.status === projected) {
      deliveries.reconciled(effectKey, "already at the projected status");
      return;
    }
    await ctx.issues.update(issueId, { status: projected }, projection.scope.companyRef, {
      actorAgentId: null,
      actorUserId: null,
      actorRunId: null,
    });
    deliveries.reconciled(effectKey);
    logger.info("projected engineering status onto the child issue", {
      issueId,
      graphStatus: projection.status,
      issueStatus: projected,
    });
  }

  // -------------------------------------------------------------------------
  // resolveWorker
  // -------------------------------------------------------------------------

  async resolveWorker(requirement: Parameters<WorkManagementPort["resolveWorker"]>[0]): Promise<WorkerCandidate[]> {
    return this.#deps.capabilities.resolveWorker(requirement);
  }

  /** Full resolution report including the blocked fallbacks, for the UI's explanation panel. */
  explainWorker(requirement: Parameters<WorkManagementPort["resolveWorker"]>[0]) {
    return this.#deps.capabilities.resolve(requirement);
  }

  // -------------------------------------------------------------------------
  // assignAndWake
  // -------------------------------------------------------------------------

  /**
   * Assign the resolved agent and ask Paperclip to wake it.
   *
   * `requestWakeup` is the *only* invocation path. There is no `agents.invoke`, no
   * `agent.sessions.*`, and no process spawn anywhere in this file: Paperclip is the sole
   * runtime invoker (REQ-WS-05, AT-08), and a plugin that started a process itself would
   * bypass the platform's budget, checkout and audit.
   */
  async assignAndWake(binding: DispatchBinding, meta: CommandMeta): Promise<DispatchReceipt> {
    const { ctx, store, logger, metrics, deliveries, capabilities } = this.#deps;
    guardScope(binding.scope, { companyId: binding.scope.companyRef, projectId: binding.scope.projectRef }, "assignAndWake", metrics);

    const workUnitId = workUnitBindingId(binding.runId, binding.nodeId, binding.iteration);
    const workUnit = store.getBinding(binding.scope.companyRef, WORK_UNIT_BINDING_KIND, workUnitId);
    const issueId = workUnit ? String(safeJson(workUnit.payloadJson)["issueId"] ?? "") : binding.workUnitRef.id;
    if (issueId.length === 0) {
      throw new BridgeError(
        "BRIDGE_INTEGRITY_FAILURE",
        "BLOCKED_STALE_INPUT",
        "dispatch has no work unit to assign",
        { runId: binding.runId, nodeId: binding.nodeId },
      );
    }

    const effectKey = capabilities.dispatchKey(
      { scope: binding.scope, runId: binding.runId, nodeId: binding.nodeId, requiredCapabilities: [] },
      binding.workerSubjectRef,
      binding.nodeId,
      binding.iteration,
    );
    const logger2 = logger.child({ correlationId: meta.correlationId, runId: binding.runId, nodeId: binding.nodeId });
    deliveries.begin({
      effectKey,
      kind: INTENT_KINDS.workUnitDispatch,
      scope: binding.scope,
      correlationId: meta.correlationId,
      runId: binding.runId,
      nodeId: binding.nodeId,
      payload: { issueId, workerSubjectRef: binding.workerSubjectRef, attemptId: binding.attemptId },
    });
    deliveries.sent(effectKey);

    const issue = await ctx.issues.get(issueId, binding.scope.companyRef);
    if (!issue) {
      deliveries.failed(effectKey, "work unit disappeared before dispatch");
      return {
        workUnitRef: providerRef("issue", issueId),
        workUnitKey: workUnitId,
        agentRunRef: null,
        queued: false,
        reason: "work_unit_missing",
      };
    }

    const agentId = await this.#resolveAgentId(binding.workerSubjectRef, binding.scope.companyRef);
    await ctx.issues.update(issueId, { assigneeAgentId: agentId }, binding.scope.companyRef, {
      actorAgentId: null,
      actorUserId: null,
      actorRunId: null,
    });

    let wake: { queued: boolean; runId: string | null };
    try {
      wake = await ctx.issues.requestWakeup(issueId, binding.scope.companyRef, {
        reason: `PolyForge node ${binding.nodeId} is READY (attempt ${binding.attemptId})`,
        contextSource: "polyforge",
        idempotencyKey: meta.idempotencyKey,
        actorAgentId: null,
        actorUserId: null,
        actorRunId: null,
      });
    } catch (error) {
      // A platform refusal to wake (budget, blocker, terminal status) is a platform block,
      // not a bridge bug. The dispatch is recorded; the Core decides what to do about it.
      metrics.bump(binding.scope.companyRef, "platformBlocks");
      deliveries.observed(effectKey, { queued: false }, { error: error instanceof Error ? error.message : String(error) });
      logger2.warn("platform refused the wakeup", {
        issueId,
        reason: error instanceof Error ? error.message : String(error),
      });
      return {
        workUnitRef: providerRef("issue", issueId),
        workUnitKey: workUnitId,
        agentRunRef: null,
        queued: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }

    const agentRunRef = wake.runId ? providerRef("agent_run", wake.runId) : null;
    store.putBinding({
      companyId: binding.scope.companyRef,
      kind: DISPATCH_BINDING_KIND,
      providerId: workUnitId,
      projectId: binding.scope.projectRef,
      payload: {
        runId: binding.runId,
        nodeId: binding.nodeId,
        iteration: binding.iteration,
        attemptId: binding.attemptId,
        issueId,
        agentId,
        agentRunRefId: wake.runId,
        contractHash: binding.contractHash,
        workspaceRef: binding.workspaceRef,
        dispatchedAt: this.#deps.now().toISOString(),
      },
    });

    deliveries.observed(effectKey, { queued: wake.queued, agentRunId: wake.runId });
    if (wake.queued) {
      deliveries.reconciled(effectKey);
    }
    logger2.info("assigned the worker and requested a platform wakeup", {
      issueId,
      agentId,
      queued: wake.queued,
    });
    return {
      workUnitRef: providerRef("issue", issueId),
      workUnitKey: workUnitId,
      agentRunRef,
      queued: wake.queued,
      ...(wake.queued ? {} : { reason: "platform did not queue a wakeup" }),
    };
  }

  async #resolveAgentId(subjectRef: string, companyId: string): Promise<string> {
    // The subject ref is the key a capability grant is filed under, so that is what is looked up
    // first; an agent id is accepted as a fallback so an operator can bind without a prefix.
    const binding = this.#deps.capabilities.bindingForSubject(companyId, subjectRef);
    if (binding) return binding.agentId;
    const agent = await this.#deps.ctx.agents.get(subjectRef, companyId);
    if (agent) return agent.id;
    throw new UnsupportedCapabilityError("capability_binding", "no capability binding for the resolved subject", {
      subjectRef,
    });
  }

  // -------------------------------------------------------------------------
  // requestStop
  // -------------------------------------------------------------------------

  /**
   * Ask the platform to stop an execution, reporting only what can be confirmed.
   *
   * On this baseline the SDK exposes no plugin-callable execution stop. The three outcomes we
   * *can* establish without one:
   * * the issue is gone → `not_found`
   * * the issue is terminal, so nothing is running → `already_terminal`
   * * otherwise → `unknown`
   *
   * `unknown` is the honest answer and the Core's required one: an unconfirmed stop is
   * `UNKNOWN`, which blocks a replacement dispatch until reconciliation, and is never
   * downgraded to "probably stopped" (docs/05 §6, §10, AT-28).
   */
  async requestStop(ref: ProviderRefLike, meta: CommandMeta): Promise<StopReceipt> {
    const { ctx, logger, metrics, deliveries, store } = this.#deps;
    const companyId = store.findCompanyForProviderRef(ref) ?? "";
    const observedAt = this.#deps.now().toISOString();
    if (companyId.length === 0) {
      logger.warn("requestStop received a ref with no recorded scope; cannot attribute the stop", { ref });
      return { requested: false, outcome: "unknown", observedAt };
    }
    const effectKey = `pf.stop:${companyId}:${ref.kind}:${ref.id}`;
    deliveries.begin({
      effectKey,
      kind: INTENT_KINDS.executionRequestStop,
      scope: { companyRef: companyId, projectRef: "" },
      correlationId: meta.correlationId,
      payload: { ref },
    });

    if (ref.kind === "agent_run" || ref.kind === "issue") {
      const issueId = ref.kind === "issue" ? ref.id : this.#issueIdForAgentRun(companyId, ref.id);
      if (issueId === null) {
        deliveries.observed(effectKey, { outcome: "not_found" });
        return { requested: false, outcome: "not_found", observedAt };
      }
      const issue = await ctx.issues.get(issueId, companyId);
      if (!issue) {
        deliveries.observed(effectKey, { outcome: "not_found" });
        return { requested: false, outcome: "not_found", observedAt };
      }
      if (issue.status === "done" || issue.status === "cancelled") {
        deliveries.observed(effectKey, { outcome: "already_terminal" });
        return { requested: false, outcome: "already_terminal", observedAt };
      }
      const activeRun = issue.activeRun;
      if (activeRun === null || activeRun === undefined) {
        // No live run. That is confirmable: there is nothing executing.
        deliveries.observed(effectKey, { outcome: "confirmed_stopped" });
        return { requested: false, outcome: "confirmed_stopped", observedAt };
      }
      if (isFinishedRunStatus(activeRun.status)) {
        deliveries.observed(effectKey, { outcome: "already_terminal" });
        return { requested: false, outcome: "already_terminal", observedAt };
      }
      // A run is live and the plugin has no stop API. Report `unknown` and count the
      // platform gap so it is visible in health rather than inferred from silence.
      metrics.bump(companyId, "platformBlocks");
      deliveries.observed(
        effectKey,
        { outcome: "unknown" },
        { error: "no plugin-callable execution stop on this host baseline" },
      );
      logger.warn("cannot confirm a stop: the host exposes no execution-stop API to plugins", {
        agentRunId: ref.id,
        issueId,
      });
      return {
        requested: false,
        outcome: "unknown",
        observedAt,
      };
    }

    deliveries.observed(effectKey, { outcome: "unknown" }, { error: `unsupported ref kind ${ref.kind}` });
    logger.warn("requestStop received a ref kind it cannot resolve", { ref });
    return { requested: false, outcome: "unknown", observedAt };
  }

  #issueIdForAgentRun(companyId: string, agentRunId: string): string | null {
    for (const row of this.#deps.store.listBindings(companyId, DISPATCH_BINDING_KIND, 1000)) {
      const payload = safeJson(row.payloadJson);
      if (payload["agentRunRefId"] === agentRunId) return String(payload["issueId"] ?? "");
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // inspectExecution
  // -------------------------------------------------------------------------

  /**
   * Read what the platform can authoritatively say about an execution.
   *
   * `effectOutcome` is deliberately **omitted**. The port contract allows a value only when
   * the provider can authoritatively report whether an effect happened, and Paperclip cannot.
   * Reporting `unknown` explicitly would be a claim; omitting it lets the Core apply its own
   * default of "unknown", which is the correct one. Attachments on the issue are returned as
   * *candidate* artifacts for the Core's ingestion to verify.
   */
  async inspectExecution(ref: ProviderRefLike): Promise<ExecutionObservation> {
    const { ctx, logger, store } = this.#deps;
    const companyId = store.findCompanyForProviderRef(ref) ?? "";
    if (companyId.length === 0) {
      logger.warn("inspectExecution received a ref with no recorded scope", { ref });
      return {
        providerRef: ref,
        state: "unknown",
        startedAt: null,
        finishedAt: null,
        exitReason: "no recorded scope for this provider ref",
        artifacts: [],
      };
    }

    const issueId =
      ref.kind === "issue"
        ? ref.id
        : this.#issueIdForAgentRun(companyId, ref.id) ??
          (this.#findIssueIdForDispatch(companyId, ref.id) ?? null);
    if (issueId === null) {
      return {
        providerRef: ref,
        state: "unknown",
        startedAt: null,
        finishedAt: null,
        exitReason: "no work unit is bound to this provider ref",
        artifacts: [],
      };
    }

    const issue = await ctx.issues.get(issueId, companyId);
    if (!issue) {
      return {
        providerRef: ref,
        state: "unknown",
        startedAt: null,
        finishedAt: null,
        exitReason: "work unit no longer exists",
        artifacts: [],
      };
    }

    // Attachments are deliberately *not* read here. The manifest declares
    // `issue.documents.read` and `issue.comments.read` but not `issue.attachments.read`, and a
    // plugin that calls a capability it never declared is refused by the host — which would turn
    // every execution inspection into a hard failure. An empty list means "not read", and the
    // exit reason says so, rather than implying the execution produced nothing.
    const artifacts: { kind: string; contentHash: string; providerRef?: ProviderRefLike }[] = [];
    const attachmentsUnavailable =
      "artifact attachments were not read: this plugin holds no attachment-read capability";

    const activeRun = issue.activeRun;
    if (activeRun) {
      const state = mapRunStatus(activeRun.status);
      return {
        providerRef: ref,
        state,
        startedAt: toIso(activeRun.startedAt),
        finishedAt: toIso(activeRun.finishedAt),
        // The active-run record carries no error field, so an unexpected status is reported as
        // unknown with the reason spelled out rather than inferred from a missing value.
        exitReason:
          state === "unknown" ? `platform run status is "${activeRun.status}"` : attachmentsUnavailable,
        artifacts,
      };
    }
    if (issue.status === "done" || issue.status === "cancelled") {
      return {
        providerRef: ref,
        state: issue.status === "done" ? "succeeded" : "cancelled",
        startedAt: null,
        finishedAt: toIso(issue.completedAt ?? issue.cancelledAt),
        // The board's status is an observation, not a fact about the effect. The exit reason
        // says so explicitly so the Core cannot read "done" as "the work succeeded".
        exitReason: `board status only; no platform run record to corroborate; ${attachmentsUnavailable}`,
        artifacts,
      };
    }
    return {
      providerRef: ref,
      state: "unknown",
      startedAt: null,
      finishedAt: null,
      exitReason: "no active platform run and the issue is not terminal",
      artifacts,
    };
  }

  #findIssueIdForDispatch(companyId: string, agentRunId: string): string | null {
    return this.#issueIdForAgentRun(companyId, agentRunId);
  }

  // -------------------------------------------------------------------------
  // Read models used by the bridge UI
  // -------------------------------------------------------------------------

  /**
   * Build the `IssueView` the UI shows.
   *
   * The two statuses are kept side by side and never merged: `issueStatus` is what a person
   * sees on the board (read from the host), `graphStatus` is what the Core committed, and
   * `needsEngineeringVerification` is true whenever the board claims more progress than the
   * Core has verified. That flag is the whole of AT-04 on the UI side: a dragged-to-`done`
   * issue with unverified nodes is labelled "needs engineering verification", never "done".
   */
  async issueView(companyId: string, issueId: string, snapshot: RunSnapshot | null): Promise<IssueView> {
    const issue = await this.#deps.ctx.issues.get(issueId, companyId);
    const nodes: NodeView[] = (snapshot?.nodes ?? []).map((node) => ({
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
    }));
    const graphStatus = snapshot?.status ?? null;
    const unverified = nodes.some((node) => node.status !== "PASSED" && node.status !== "SKIPPED");
    return {
      issueId,
      runId: snapshot?.runId ?? null,
      issueStatus: issue?.status ?? null,
      graphStatus,
      graphStatusSource: graphStatus === null ? null : "polyforge",
      needsEngineeringVerification: graphStatus !== null && unverified && issue?.status === "done",
      nodes,
      blockers: (snapshot?.blockers ?? []).map((blocker) => ({
        code: blocker.code,
        reason: blocker.reason,
        message: blocker.message,
      })),
    };
  }
}

function isFinishedRunStatus(status: string): boolean {
  return ["finished", "completed", "failed", "cancelled", "aborted", "error"].includes(status);
}

function mapRunStatus(status: string): ExecutionObservation["state"] {
  switch (status) {
    case "running":
    case "queued":
    case "starting":
      return "running";
    case "finished":
    case "completed":
    case "succeeded":
      return "succeeded";
    case "failed":
    case "error":
      return "failed";
    case "cancelled":
    case "aborted":
      return "cancelled";
    default:
      return "unknown";
  }
}

function toIso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
}

function safeJson(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
