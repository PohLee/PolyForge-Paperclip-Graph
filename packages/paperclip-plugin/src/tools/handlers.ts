/**
 * The six `polyforge.*` tool handlers.
 *
 * These are the *protocol entry point* into the durable runtime, not a graph lifecycle. A tool
 * call never owns a GraphRun: it reads current state, submits candidates, or requests an
 * evaluation. What it deliberately cannot do is assert a pass, approve itself, register an
 * evaluator, or mutate the Core directly.
 *
 * ## The two-layer fence every side-effecting tool must clear
 *
 * ```text
 * Paperclip checkout   (ctx.issues.assertCheckoutOwner)  ─┐
 *                                                           ├─> both must agree ─> Core claim
 * Core claim + lease epoch (claim binding, epoch match)  ─┘
 * ```
 *
 * `submit_artifact`, `submit_evidence` and `request_transition` all require an active claim
 * whose `agentRunId` is this tool call's run. A stale owner is `LEASE_FENCED`, counted, and
 * rejected; no claim at all means no contract-level side effect is permitted. The checkout
 * half of the fence is enforced by the work port during dispatch and by the Core at commit
 * time, from the same authenticated run id.
 *
 * ## `current --adopt`
 *
 * Adoption is allowed **only when the previous owner is confirmed stopped**. The bridge asks the
 * work port whether the previous run is already absent or terminal; this SDK baseline has no
 * run-scoped stop operation, so it cannot terminate a live run. Only `confirmed_stopped`,
 * `already_terminal` or `not_found` permits a new claim. `unknown` returns a pending envelope and
 * no claim — a lease expiry is a reason to *check*, never a reason to assume the old worker stopped.
 *
 * The lease epoch is never invented here. The bridge sends the claim, and the Core (the only
 * authority on epochs) returns the new one. The bridge then *verifies the returned epoch
 * actually increased*; a Core that fails to fence is not trusted.
 *
 * ## Speed
 *
 * No handler polls and no handler waits for a human. A gate that needs a decision returns
 * immediately with `pending: true` and a pending reason, and the worker is released.
 */

import { toolEnvelope } from "@polyforge/protocol";
import type { ToolEnvelope } from "@polyforge/protocol";
import type { ToolResult, ToolRunContext } from "@paperclipai/plugin-sdk";
import type {
  ToolArtifactInput,
  ToolClaim,
  ToolClaimQuery,
  ToolCurrentContract,
  ToolHandlerDeps,
  ToolRunBinding,
  ToolRunSnapshot,
  ToolRuntime,
} from "./register.js";
import { CLAIM_BINDING_KIND } from "./register.js";
import { BridgeError } from "../errors.js";

interface ToolContext {
  readonly runCtx: ToolRunContext;
  readonly params: Record<string, unknown>;
  readonly binding: ToolRunBinding;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringParam(params: Record<string, unknown>, key: string): string | null {
  const value = params[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function boolParam(params: Record<string, unknown>, key: string): boolean {
  return params[key] === true;
}

function stringArrayParam(params: Record<string, unknown>, key: string): string[] {
  const value = params[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function ok(envelope: ToolEnvelope, text: string): ToolResult {
  return { content: text, data: envelope };
}

/**
 * One artifact reference on an evidence candidate, in the Core's own shape.
 *
 * The Core's ingestion admits an artifact only when it carries a well-formed sha256 `contentHash`
 * and an immutable identity, and it resolves the reference by matching that `kind` + `contentHash`
 * against an artifact registered earlier (`evidence/store.py`). A provider ref -- "this lives on
 * some issue, at some id" -- is neither, and carries no digest, so evidence bearing one was refused
 * as `content_hash_invalid` no matter what the worker had actually published. These three fields
 * are what `submit_artifact` already returned from the verified record; passing them through keeps
 * the digest the artifact port compared against the bytes.
 */
function evidenceArtifactRef(artifact: unknown): {
  kind: string;
  contentHash: string;
  source: Record<string, unknown>;
  providerRef: Record<string, unknown>;
} {
  const ref = asRecord(artifact);
  const contentHash = typeof ref["contentHash"] === "string" ? ref["contentHash"] : "";
  const kind = typeof ref["kind"] === "string" ? ref["kind"] : "";
  if (contentHash.length === 0 || kind.length === 0) {
    throw new BridgeError(
      "BRIDGE_INTEGRITY_FAILURE",
      "BLOCKED_STALE_INPUT",
      "an evidence artifact must name its kind and the content hash of bytes that were registered " +
        "by submit_artifact; a provider reference is not an identity and cannot be evidence",
      { kind, hasContentHash: contentHash.length > 0 },
    );
  }
  return {
    kind,
    contentHash,
    source: asRecord(ref["source"]),
    providerRef: asRecord(ref["providerRef"]),
  };
}

/**
 * A refusal.
 *
 * Returned as `ToolResult.error` with the envelope in `data`, so the agent sees both a short
 * message and the machine-readable blockers. Throwing would be surfaced by the host as a
 * transport failure, which loses the durable ids and reads as "retry", which is exactly wrong
 * for a blocked node.
 */
function refuse(envelope: ToolEnvelope, message: string): ToolResult {
  return { content: message, error: message, data: envelope };
}

function isContext(value: ToolContext | ToolResult): value is ToolContext {
  return (value as ToolContext).binding !== undefined;
}

function isToolResult(value: ToolRuntime | ToolResult | { claim: ToolClaim }): value is ToolResult {
  return (value as ToolResult).content !== undefined || (value as ToolResult).error !== undefined;
}

function isClaimGate(value: { claim: ToolClaim } | ToolResult): value is { claim: ToolClaim } {
  return (value as { claim: ToolClaim }).claim !== undefined;
}

export function makeToolHandlers(deps: ToolHandlerDeps) {
  /**
   * Resolve the run this tool call is about, and refuse anything cross-scope.
   *
   * `runId` may be supplied, but it is checked against the agent run's own binding: a tool
   * call for a run this agent was never dispatched to is refused even inside the same company
   * and project. Without that, an agent could operate on a run it merely knows the id of.
   */
  function resolveContext(params: unknown, runCtx: ToolRunContext, requireBinding: boolean): ToolContext | ToolResult {
    const record = asRecord(params);
    const binding = deps.bindingForAgentRun(runCtx.companyId, runCtx.runId);
    const requestedRunId = stringParam(record, "runId");

    if (binding === null) {
      if (requireBinding) {
        const message = "this agent run is not bound to a PolyForge run; no side-effecting tool may be called";
        deps.bump(runCtx.companyId, "crossScopeDenials");
        return refuse(
          toolEnvelope({
            status: "UNBOUND",
            nextSteps: ["Ask the platform to dispatch this run to a PolyForge node work unit."],
            blockers: [{ code: "BRIDGE_RUN_NOT_BOUND", reason: "BLOCKED_SCOPE", message }],
          }),
          message,
        );
      }
      if (requestedRunId === null) {
        const message = "no runId was supplied and this agent run has no bound run";
        return refuse(
          toolEnvelope({
            status: "UNBOUND",
            blockers: [{ code: "BRIDGE_RUN_NOT_BOUND", reason: "BLOCKED_SCOPE", message }],
          }),
          message,
        );
      }
      return {
        runCtx,
        params: record,
        binding: {
          companyId: runCtx.companyId,
          runId: requestedRunId,
          nodeId: "",
          iteration: 0,
          issueId: "",
          projectId: runCtx.projectId,
          contractHash: null,
        },
      };
    }

    if (requestedRunId !== null && requestedRunId !== binding.runId) {
      const message = "the requested runId is not the run this agent run is bound to";
      deps.bump(runCtx.companyId, "crossScopeDenials");
      return refuse(
        toolEnvelope({
          runId: binding.runId,
          status: "SCOPE_VIOLATION",
          blockers: [{ code: "BRIDGE_SCOPE_VIOLATION", reason: "BLOCKED_SCOPE", message }],
        }),
        message,
      );
    }
    if (binding.projectId !== runCtx.projectId) {
      const message = "this agent run's project does not match the bound work unit's project";
      deps.bump(runCtx.companyId, "crossScopeDenials");
      return refuse(
        toolEnvelope({
          runId: binding.runId,
          status: "SCOPE_VIOLATION",
          blockers: [{ code: "BRIDGE_SCOPE_VIOLATION", reason: "BLOCKED_SCOPE", message }],
        }),
        message,
      );
    }
    return { runCtx, params: record, binding };
  }

  function requireRuntime(context: ToolContext): ToolRuntime | ToolResult {
    const runtime = deps.runtime(context.runCtx.companyId);
    if (runtime === null) {
      const message = "the PolyForge Runtime Service is not configured or not reachable for this company";
      return refuse(
        toolEnvelope({
          runId: context.binding.runId,
          status: "BLOCKED",
          blockers: [{ code: "BRIDGE_CONFIG_INVALID", reason: "BLOCKED_PLATFORM", message }],
        }),
        message,
      );
    }
    return runtime;
  }

  /**
   * The claim gate.
   *
   * A missing claim and a fenced claim are different refusals with different recovery: a
   * missing claim means "call `current` first", a fenced claim means "someone else took over
   * and your writes must not land".
   */
  function requireClaim(context: ToolContext, nodeId: string, iteration: number): { claim: ToolClaim } | ToolResult {
    const query: ToolClaimQuery = {
      companyId: context.runCtx.companyId,
      runId: context.binding.runId,
      nodeId,
      iteration,
    };
    const claim = deps.claim(query);
    if (claim === null) {
      const message = "no active PolyForge claim for this attempt; call polyforge.current to establish one";
      return refuse(
        toolEnvelope({
          runId: context.binding.runId,
          status: "NO_CLAIM",
          nextSteps: ["polyforge.current with adopt: true"],
          blockers: [{ code: "BRIDGE_CLAIM_REQUIRED", reason: "BLOCKED_LEASE_FENCED", message }],
        }),
        message,
      );
    }
    if (claim.agentRunId !== context.runCtx.runId) {
      deps.bump(context.runCtx.companyId, "staleLeaseRejected");
      const message = "this attempt is claimed by a different agent run; your writes are fenced";
      return refuse(
        toolEnvelope({
          runId: context.binding.runId,
          status: "LEASE_FENCED",
          blockers: [{ code: "BRIDGE_LEASE_FENCED", reason: "BLOCKED_LEASE_FENCED", message }],
        }),
        message,
      );
    }
    return { claim };
  }

  async function readContract(runtime: ToolRuntime, context: ToolContext): Promise<ToolCurrentContract | ToolResult> {
    try {
      return await runtime.current(context.runCtx.companyId, context.binding.runId);
    } catch (error) {
      const message = `could not read the current contract: ${error instanceof Error ? error.message : String(error)}`;
      return refuse(
        toolEnvelope({
          runId: context.binding.runId,
          status: "UNKNOWN",
          blockers: [{ code: "RUNTIME_UNAVAILABLE", reason: "BLOCKED_PLATFORM", message }],
        }),
        message,
      );
    }
  }

  // -------------------------------------------------------------------------
  // status — read-only
  // -------------------------------------------------------------------------

  /**
   * Read-only summary.
   *
   * It mutates nothing: no outbox intent, no Core command, no issue write. The only write is
   * the bridge's local `command_log` audit row for the read. It never marks anything passed —
   * the envelope's `status` is the Core's own run status, and `assertedPass: false` is
   * explicit so a consumer cannot mistake the reply for a transition.
   */
  async function status(params: unknown, runCtx: ToolRunContext): Promise<ToolResult> {
    const resolved = resolveContext(params, runCtx, false);
    if (!isContext(resolved)) return resolved;
    const context = resolved;
    const nodeId = stringParam(context.params, "nodeId");
    const includeHistory = boolParam(context.params, "includeHistory");
    const runtime = requireRuntime(context);
    if (isToolResult(runtime)) return runtime;

    let snapshot: ToolRunSnapshot;
    try {
      snapshot = await runtime.getRun(context.runCtx.companyId, context.binding.runId);
    } catch (error) {
      const message = `could not read the run: ${error instanceof Error ? error.message : String(error)}`;
      return refuse(
        toolEnvelope({
          runId: context.binding.runId,
          status: "UNKNOWN",
          blockers: [{ code: "RUNTIME_UNAVAILABLE", reason: "BLOCKED_PLATFORM", message }],
        }),
        message,
      );
    }
    if (snapshot.scope.companyRef !== context.runCtx.companyId) {
      deps.bump(context.runCtx.companyId, "crossScopeDenials");
      const message = "the run belongs to a different company";
      return refuse(
        toolEnvelope({
          runId: snapshot.runId,
          status: "SCOPE_VIOLATION",
          blockers: [{ code: "BRIDGE_SCOPE_VIOLATION", reason: "BLOCKED_SCOPE", message }],
        }),
        message,
      );
    }

    const nodes = nodeId === null ? snapshot.nodes : snapshot.nodes.filter((node) => node.nodeId === nodeId);
    // A node sitting in EVIDENCE_READY with no valid evidence on the run is the exact
    // "gate is missing evidence" condition the health contract counts, surfaced here so the
    // agent can see it instead of inferring it from a blocked transition.
    const missingEvidence = nodes
      .filter((node) => node.status === "EVIDENCE_READY")
      .filter(() => !snapshot.evidence.some((record) => record.kind.length > 0 && record.valid))
      .map((node) => node.nodeId);

    const envelope = toolEnvelope({
      runId: snapshot.runId,
      stateVersion: snapshot.stateVersion,
      status: snapshot.status,
      pending: snapshot.pendingGovernance.length > 0,
      pendingReason:
        snapshot.pendingGovernance.length > 0
          ? (snapshot.pendingGovernance[0]?.semanticKind ?? "awaiting_governance")
          : null,
      nextSteps: buildNextSteps(snapshot, nodes[0]?.nodeId ?? null),
      blockers: snapshot.blockers,
      data: {
        graphId: snapshot.graphId,
        graphVersion: snapshot.graphVersion,
        pins: snapshot.pins,
        eventSequence: snapshot.eventSequence,
        nodes,
        ...(includeHistory
          ? {
              history: snapshot.nodes.map((node) => ({
                nodeId: node.nodeId,
                status: node.status,
                iteration: node.iteration,
                attempts: snapshot.attempts.filter((attempt) => attempt.nodeId === node.nodeId),
              })),
            }
          : {}),
        evidence: snapshot.evidence,
        pendingGovernance: snapshot.pendingGovernance,
        gateMissingEvidence: missingEvidence,
        authoritativeStatusSource: "polyforge-core",
        mutatedByThisCall: false,
        assertedPass: false,
      },
    });
    return ok(envelope, `PolyForge run ${snapshot.runId} is ${snapshot.status} (stateVersion ${snapshot.stateVersion}).`);
  }

  // -------------------------------------------------------------------------
  // current — contract + optional adoption
  // -------------------------------------------------------------------------

  async function current(params: unknown, runCtx: ToolRunContext): Promise<ToolResult> {
    const resolved = resolveContext(params, runCtx, false);
    if (!isContext(resolved)) return resolved;
    const context = resolved;
    const adopt = boolParam(context.params, "adopt");
    const runtime = requireRuntime(context);
    if (isToolResult(runtime)) return runtime;

    const contract = await readContract(runtime, context);
    if (!isContract(contract)) return contract;

    const nodeId = stringParam(context.params, "nodeId") ?? contract.nodeId ?? context.binding.nodeId;
    if (nodeId.length === 0) {
      const message = "this agent run has no node bound; there is no contract to read";
      return refuse(
        toolEnvelope({
          runId: context.binding.runId,
          status: "NO_NODE",
          blockers: [{ code: "BRIDGE_RUN_NOT_BOUND", reason: "BLOCKED_SCOPE", message }],
        }),
        message,
      );
    }

    const existing = deps.claim({
      companyId: context.runCtx.companyId,
      runId: context.binding.runId,
      nodeId,
      iteration: contract.iteration,
    });

    if (!adopt) {
      return ok(
        toolEnvelope({
          runId: context.binding.runId,
          stateVersion: contract.stateVersion,
          status: existing === null ? "UNCLAIMED" : "CLAIMED",
          pending: existing === null,
          pendingReason: existing === null ? "no_claim" : null,
          nextSteps:
            existing === null
              ? ["Re-run with adopt: true to claim this attempt."]
              : contract.permittedActions,
          blockers: [],
          data: contractPayload(contract, existing, false),
        }),
        existing === null
          ? "Contract available. Re-run with adopt: true to claim this attempt."
          : "Contract available; this attempt is already claimed.",
      );
    }

    if (!contract.claimable) {
      const message = "the Core reports this attempt is not claimable";
      return refuse(
        toolEnvelope({
          runId: context.binding.runId,
          stateVersion: contract.stateVersion,
          status: "NOT_CLAIMABLE",
          blockers: [{ code: "BRIDGE_LEASE_FENCED", reason: "BLOCKED_LEASE_FENCED", message }],
          data: contractPayload(contract, existing, false),
        }),
        message,
      );
    }

    // Idempotent re-entry. An agent that calls `current --adopt` twice — which is ordinary, not
    // adversarial — must not burn a lease epoch: the epoch bump invalidates the previous attempt,
    // so doing it here would have the bridge invalidating its own live claim and would report
    // "the previous attempt is invalidated" about the very attempt it is still using.
    if (existing !== null && existing.agentRunId === runCtx.runId) {
      return ok(
        toolEnvelope({
          runId: context.binding.runId,
          stateVersion: contract.stateVersion,
          status: "CLAIMED",
          pending: false,
          pendingReason: null,
          nextSteps: contract.permittedActions,
          blockers: [],
          data: {
            ...contractPayload(contract, existing, true),
            claim: {
              bindingKind: CLAIM_BINDING_KIND,
              attemptId: existing.attemptId,
              leaseEpoch: existing.leaseEpoch,
              // Nothing was adopted this time, so nothing was invalidated.
              previousAttemptId: existing.attemptId,
              previousLeaseEpoch: existing.leaseEpoch,
              invalidatesPreviousAttempt: false,
              alreadyHeld: true,
            },
          },
        }),
        `Attempt already claimed at lease epoch ${existing.leaseEpoch} by this agent run.`,
      );
    }

    // Lease expiry is a reason to check, not a reason to assume the old worker stopped.
    let priorWorkerState: "stopped" | undefined;
    if (contract.previousOwnerAgentRunId !== null && contract.previousOwnerAgentRunId !== runCtx.runId) {
      const outcome = await deps.stopPreviousOwner(context.runCtx.companyId, {
        provider: "paperclip",
        kind: "agent_run",
        id: contract.previousOwnerAgentRunId,
      });
      if (outcome === "unknown") {
        deps.bump(context.runCtx.companyId, "staleLeaseRejected");
        const message =
          "the previous owner's execution could not be confirmed stopped, so this attempt is not adopted; the Core will reconcile";
        deps.warn("adoption refused: previous owner stop unconfirmed", {
          runId: context.binding.runId,
          nodeId,
        });
        return refuse(
          toolEnvelope({
            runId: context.binding.runId,
            stateVersion: contract.stateVersion,
            status: "PENDING",
            pending: true,
            pendingReason: "previous_owner_stop_unconfirmed",
            nextSteps: ["Wait for reconciliation; do not retry the side effect."],
            blockers: [{ code: "BRIDGE_LEASE_FENCED", reason: "BLOCKED_LEASE_FENCED", message }],
            data: contractPayload(contract, existing, false),
          }),
          message,
        );
      }
      // Only the bridge derives this assertion after its host adapter reports a terminal,
      // missing, or otherwise confirmed-stopped execution. Tool parameters never carry it.
      priorWorkerState = "stopped";
    }

    const previousEpoch = contract.leaseEpoch ?? 0;
    const expectedEpoch = previousEpoch + 1;
    let claimed;
    try {
      claimed = await runtime.claim(context.runCtx.companyId, context.binding.runId, {
        runId: context.binding.runId,
        nodeId,
        iteration: contract.iteration,
        leaseEpoch: expectedEpoch,
        priorWorkerState,
        agentSubject: `agent:paperclip/${runCtx.agentId}`,
        agentRunRef: { provider: "paperclip", kind: "agent_run", id: runCtx.runId },
        issueRef:
          context.binding.issueId.length > 0
            ? { provider: "paperclip", kind: "issue", id: context.binding.issueId }
            : null,
        contractHash: contract.contractHash ?? context.binding.contractHash ?? "",
        commandId: `${context.binding.runId}:${nodeId}:claim:${runCtx.runId}:${expectedEpoch}`,
        idempotencyKey: `pf.claim:${context.runCtx.companyId}:${context.binding.runId}:${nodeId}:${contract.iteration}:${expectedEpoch}`,
        correlationId: context.binding.runId,
        causationId: runCtx.runId,
      });
    } catch (error) {
      const message = `the claim was refused: ${error instanceof Error ? error.message : String(error)}`;
      return refuse(
        toolEnvelope({
          runId: context.binding.runId,
          stateVersion: contract.stateVersion,
          status: "CLAIM_REFUSED",
          blockers: [{ code: "BRIDGE_LEASE_FENCED", reason: "BLOCKED_LEASE_FENCED", message }],
        }),
        message,
      );
    }

    const grantedEpoch = readEpoch(claimed);
    if (grantedEpoch !== null && grantedEpoch < expectedEpoch) {
      // The Core is the only authority on epochs. A claim returned without the fence advanced
      // leaves the old attempt live, so proceeding could produce two owners of one node.
      deps.bump(context.runCtx.companyId, "staleLeaseRejected");
      const message = "the Core granted a claim without incrementing the lease epoch; the old attempt is not fenced";
      deps.warn("claim granted without an epoch increment", {
        runId: context.binding.runId,
        expectedEpoch,
        grantedEpoch,
      });
      return refuse(
        toolEnvelope({
          runId: context.binding.runId,
          stateVersion: claimed.stateVersion,
          status: "LEASE_NOT_FENCED",
          blockers: [{ code: "BRIDGE_LEASE_FENCED", reason: "BLOCKED_LEASE_FENCED", message }],
        }),
        message,
      );
    }

    // The Core's answer is authoritative. A local claim for this attempt may exist and be stale —
    // a takeover, or a claim recorded before a crash — and reusing it here would leave the bridge
    // presenting an epoch the Core has already moved past, so every later write from the *new*
    // legitimate owner would be fenced by the Core it just granted. The local row is therefore a
    // fallback for a Core that answers without an epoch, never an override.
    const local = deps.claim({
      companyId: context.runCtx.companyId,
      runId: context.binding.runId,
      nodeId,
      iteration: contract.iteration,
    });
    const responseAttemptId = readAttemptId(claimed);
    if (grantedEpoch !== null && !responseAttemptId) {
      deps.bump(context.runCtx.companyId, "staleLeaseRejected");
      const message = "the Core granted a lease epoch without returning the new attempt id";
      deps.warn("claim response omitted its authoritative attempt id", {
        runId: context.binding.runId,
        nodeId,
        grantedEpoch,
      });
      return refuse(
        toolEnvelope({
          runId: context.binding.runId,
          stateVersion: claimed.stateVersion,
          status: "LEASE_NOT_FENCED",
          blockers: [{ code: "BRIDGE_LEASE_FENCED", reason: "BLOCKED_LEASE_FENCED", message }],
        }),
        message,
      );
    }
    const grantedAttemptId = responseAttemptId ?? local?.attemptId ?? contract.attemptId ?? "";
    const stored: ToolClaim =
      grantedEpoch !== null
        ? {
            attemptId: grantedAttemptId,
            leaseEpoch: grantedEpoch,
            agentRunId: runCtx.runId,
            agentId: runCtx.agentId,
            contractHash: contract.contractHash,
            claimedAt: new Date().toISOString(),
          }
        : (local ?? {
            attemptId: contract.attemptId ?? "",
            leaseEpoch: expectedEpoch,
            agentRunId: runCtx.runId,
            agentId: runCtx.agentId,
            contractHash: contract.contractHash,
            claimedAt: new Date().toISOString(),
          });
    deps.recordClaim({
      companyId: context.runCtx.companyId,
      runId: context.binding.runId,
      nodeId,
      iteration: contract.iteration,
      attemptId: stored.attemptId,
      leaseEpoch: stored.leaseEpoch,
      agentRunId: runCtx.runId,
      agentId: runCtx.agentId,
      contractHash: contract.contractHash,
    });

    return ok(
      toolEnvelope({
        runId: context.binding.runId,
        stateVersion: claimed.stateVersion,
        status: claimed.status,
        pending: claimed.pending === true,
        pendingReason: claimed.pendingReason ?? null,
        nextSteps: contract.permittedActions,
        blockers: claimed.blockers ?? [],
        data: {
          ...contractPayload(contract, stored, true),
          claim: {
            bindingKind: CLAIM_BINDING_KIND,
            attemptId: stored.attemptId,
            leaseEpoch: stored.leaseEpoch,
            previousAttemptId: contract.attemptId,
            previousLeaseEpoch: previousEpoch,
            invalidatesPreviousAttempt: true,
          },
        },
      }),
      `Attempt claimed at lease epoch ${stored.leaseEpoch}. The previous attempt is invalidated.`,
    );
  }

  // -------------------------------------------------------------------------
  // submit_artifact
  // -------------------------------------------------------------------------

  /**
   * Register fixed artifact references.
   *
   * The declared digest is *not* trusted: the artifact port reads the bytes through the
   * company-scoped host client, hashes them itself, and refuses a mismatch. A worker therefore
   * cannot make an artifact exist by asserting a hash.
   */
  async function submitArtifact(params: unknown, runCtx: ToolRunContext): Promise<ToolResult> {
    const resolved = resolveContext(params, runCtx, true);
    if (!isContext(resolved)) return resolved;
    const context = resolved;
    const runtime = requireRuntime(context);
    if (isToolResult(runtime)) return runtime;

    const rawArtifacts = Array.isArray(context.params["artifacts"]) ? context.params["artifacts"] : [];
    if (rawArtifacts.length === 0) {
      const message = "artifacts is required and must contain at least one artifact";
      return refuse(
        toolEnvelope({ runId: context.binding.runId, status: "BAD_REQUEST", blockers: [{ code: "BAD_REQUEST", reason: "BLOCKED_PLATFORM", message }] }),
        message,
      );
    }

    const nodeId = stringParam(context.params, "nodeId") ?? context.binding.nodeId;
    const claimGate = requireClaim(context, nodeId, context.binding.iteration);
    if (!isClaimGate(claimGate)) return claimGate;
    const claim = claimGate.claim;

    const contract = await readContract(runtime, context);
    if (!isContract(contract)) return contract;

    const permitted = new Set(contract.permittedOutputs);
    // The Core's artifact DTO, field for field: `contentHash`, `kind`, `source` and `providerRef`.
    // It was being sent as `{ kind, contentHash, ref }`, so `source` never arrived — and `source` is
    // what makes a reference immutable and is what the Core's create-or-verify conflict check reads.
    // Losing it is not cosmetic: without it the same source identity can be re-pointed at different
    // bytes without the Core noticing.
    const published: {
      kind: string;
      contentHash: string;
      source: Record<string, unknown>;
      providerRef: Record<string, unknown>;
    }[] = [];

    for (const entry of rawArtifacts) {
      const artifact = asRecord(entry);
      const kind = typeof artifact["kind"] === "string" ? artifact["kind"] : "";
      if (permitted.size > 0 && !permitted.has(kind)) {
        const message = `artifact kind "${kind}" is not a permitted output of this node's contract`;
        return refuse(
          toolEnvelope({
            runId: context.binding.runId,
            stateVersion: contract.stateVersion,
            status: "CONTRACT_INVALID",
            blockers: [{ code: "CONTRACT_INVALID", reason: "BLOCKED_STALE_INPUT", message }],
          }),
          message,
        );
      }
      const source = asRecord(artifact["source"]);
      const rawSourceKind = source["kind"];
      if (rawSourceKind !== "document" && rawSourceKind !== "inline") {
        const message = `artifact source kind "${String(rawSourceKind ?? "")}" is unsupported; use document or inline`;
        return refuse(
          toolEnvelope({
            runId: context.binding.runId,
            stateVersion: contract.stateVersion,
            status: "ARTIFACT_REFUSED",
            blockers: [{ code: "BRIDGE_UNSUPPORTED", reason: "BLOCKED_PLATFORM", message }],
          }),
          message,
        );
      }
      const sourceKind = rawSourceKind;
      const sourceRef = typeof source["ref"] === "string" ? source["ref"] : undefined;
      // The source is re-scoped to the bound issue. A caller cannot name another issue, and
      // cannot pass a URL or a traversing path (the artifact port refuses those outright).
      const scopedRef =
        sourceRef === undefined
          ? `issue:${context.binding.issueId}`
          : sourceRef.startsWith("issue:")
            ? sourceRef
            : sourceKind === "document"
              ? `issue:${context.binding.issueId}/${sourceRef}`
              : sourceRef;

      const input: ToolArtifactInput = {
        companyId: context.runCtx.companyId,
        kind,
        contentHash: typeof artifact["contentHash"] === "string" ? artifact["contentHash"] : "",
        mediaType: typeof artifact["mediaType"] === "string" ? artifact["mediaType"] : "application/octet-stream",
        size: typeof artifact["size"] === "number" ? artifact["size"] : 0,
        source: {
          kind: sourceKind,
          ref: scopedRef,
          ...(typeof source["body"] === "string" ? { body: source.body } : {}),
        },
        repository: (artifact["repository"] as { repoRef: string; commit: string } | undefined) ?? null,
      };

      try {
        // The verified record, not the caller's declaration. `input.contentHash` is what the caller
        // asked for; the port has already compared it against the bytes and refused on a mismatch,
        // so the digest that goes to the Core is the one this side actually checked.
        const record = await deps.publishArtifact(context.runCtx.companyId, input);
        published.push({
          kind,
          contentHash: record.contentHash,
          source: record.source,
          providerRef: record.providerRef,
        });
      } catch (error) {
        const message = `artifact was refused: ${error instanceof Error ? error.message : String(error)}`;
        deps.bump(context.runCtx.companyId, "artifactDigestMismatch");
        return refuse(
          toolEnvelope({
            runId: context.binding.runId,
            stateVersion: contract.stateVersion,
            status: "ARTIFACT_REFUSED",
            blockers: [{ code: "BRIDGE_INTEGRITY_FAILURE", reason: "BLOCKED_STALE_INPUT", message }],
          }),
          message,
        );
      }
    }

    const result = await runtime.submitArtifacts(context.runCtx.companyId, context.binding.runId, {
      ...mutationEnvelope(context, contract, claim, nodeId),
      payload: { artifacts: published },
    });
    return commandResultToToolResult(result, context.binding.runId, `Registered ${published.length} artifact(s).`);
  }

  // -------------------------------------------------------------------------
  // submit_evidence
  // -------------------------------------------------------------------------

  /**
   * Submit evidence *candidates*.
   *
   * The bridge passes them through and lets the Core's trusted ingestion verify scope,
   * producer, active claim, contract-bound output type, content hash, source revision and
   * freshness. A worker's claim that "tests passed" is a candidate here and becomes evidence
   * only when a trusted source confirms it. The producer is derived from the authenticated
   * `ToolRunContext`, never from a parameter.
   */
  async function submitEvidence(params: unknown, runCtx: ToolRunContext): Promise<ToolResult> {
    const resolved = resolveContext(params, runCtx, true);
    if (!isContext(resolved)) return resolved;
    const context = resolved;
    const runtime = requireRuntime(context);
    if (isToolResult(runtime)) return runtime;

    const rawEvidence = Array.isArray(context.params["evidence"]) ? context.params["evidence"] : [];
    if (rawEvidence.length === 0) {
      const message = "evidence is required and must contain at least one candidate";
      return refuse(
        toolEnvelope({ runId: context.binding.runId, status: "BAD_REQUEST", blockers: [{ code: "BAD_REQUEST", reason: "BLOCKED_PLATFORM", message }] }),
        message,
      );
    }
    const nodeId = stringParam(context.params, "nodeId") ?? context.binding.nodeId;
    const claimGate = requireClaim(context, nodeId, context.binding.iteration);
    if (!isClaimGate(claimGate)) return claimGate;
    const claim = claimGate.claim;

    const contract = await readContract(runtime, context);
    if (!isContract(contract)) return contract;

    // Built before the call so an artifact this shape cannot be reported against this run's
    // contract, in the same envelope every other refusal in this file uses, rather than escaping
    // as an exception the worker cannot read.
    let evidence: Record<string, unknown>[];
    try {
      evidence = rawEvidence.map((entry) => {
        const record = asRecord(entry);
        const artifacts = Array.isArray(record["artifacts"]) ? record["artifacts"] : [];
        return {
          kind: typeof record["kind"] === "string" ? record["kind"] : "",
          producerSubject: `agent:paperclip/${context.runCtx.agentId}`,
          producerRunRef: { provider: "paperclip", kind: "agent_run", id: context.runCtx.runId },
          artifacts: artifacts.map((artifact) => evidenceArtifactRef(artifact)),
          detail: asRecord(record["detail"]),
          inputRevisionBindings: asRecord(record["inputRevisionBindings"]),
          // Nothing a tool submits is valid on arrival; ingestion decides.
          valid: false,
        };
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return refuse(
        toolEnvelope({
          runId: context.binding.runId,
          stateVersion: contract.stateVersion,
          status: "ARTIFACT_REFUSED",
          blockers: [
            { code: "BRIDGE_INTEGRITY_FAILURE", reason: "BLOCKED_STALE_INPUT", message },
          ],
        }),
        message,
      );
    }

    const result = await runtime.submitEvidence(context.runCtx.companyId, context.binding.runId, {
      ...mutationEnvelope(context, contract, claim, nodeId),
      payload: { evidence },
    });
    return commandResultToToolResult(
      result,
      context.binding.runId,
      `Submitted ${rawEvidence.length} evidence candidate(s) for verification.`,
    );
  }

  // -------------------------------------------------------------------------
  // request_transition
  // -------------------------------------------------------------------------

  /**
   * Request evaluation of the current transition.
   *
   * The tool cannot assert `PASS`, cannot supply an approval, and cannot register an
   * evaluator. A gate that needs a human decision returns a durable pending result and the
   * worker is released — there is no long poll.
   */
  async function requestTransition(params: unknown, runCtx: ToolRunContext): Promise<ToolResult> {
    const resolved = resolveContext(params, runCtx, true);
    if (!isContext(resolved)) return resolved;
    const context = resolved;
    const runtime = requireRuntime(context);
    if (isToolResult(runtime)) return runtime;

    const evidenceIds = stringArrayParam(context.params, "evidenceIds");
    if (evidenceIds.length === 0) {
      const message =
        "evidenceIds is required; a transition request must name the evidence it is asking to be judged on";
      return refuse(
        toolEnvelope({ runId: context.binding.runId, status: "BAD_REQUEST", blockers: [{ code: "BAD_REQUEST", reason: "BLOCKED_PLATFORM", message }] }),
        message,
      );
    }
    const nodeId = stringParam(context.params, "nodeId") ?? context.binding.nodeId;
    const claimGate = requireClaim(context, nodeId, context.binding.iteration);
    if (!isClaimGate(claimGate)) return claimGate;
    const claim = claimGate.claim;

    const contract = await readContract(runtime, context);
    if (!isContract(contract)) return contract;

    const summary = stringParam(context.params, "summary");
    const result = await runtime.requestTransition(context.runCtx.companyId, context.binding.runId, {
      ...mutationEnvelope(context, contract, claim, nodeId),
      payload: { evidenceIds, ...(summary === null ? {} : { summary }) },
    });

    return commandResultToToolResult(
      result,
      context.binding.runId,
      result.pending === true
        ? `Transition evaluation is pending: ${result.pendingReason ?? "awaiting a decision"}. The worker is released.`
        : `Transition evaluation result: ${result.status}.`,
    );
  }

  // -------------------------------------------------------------------------
  // request_help
  // -------------------------------------------------------------------------

  /**
   * Create a durable help intent.
   *
   * Never auto-approves, never blocks, never waits. The worker is released the moment the
   * intent is recorded, which is what keeps a human waiting three days from occupying a tool
   * call.
   */
  async function requestHelp(params: unknown, runCtx: ToolRunContext): Promise<ToolResult> {
    const resolved = resolveContext(params, runCtx, true);
    if (!isContext(resolved)) return resolved;
    const context = resolved;
    const runtime = requireRuntime(context);
    if (isToolResult(runtime)) return runtime;

    const kind = stringParam(context.params, "kind");
    const question = stringParam(context.params, "question");
    if (kind === null || question === null) {
      const message = "kind and question are both required";
      return refuse(
        toolEnvelope({ runId: context.binding.runId, status: "BAD_REQUEST", blockers: [{ code: "BAD_REQUEST", reason: "BLOCKED_PLATFORM", message }] }),
        message,
      );
    }
    if (!["clarification", "review", "human_handling"].includes(kind)) {
      const message = "kind must be one of clarification, review, human_handling";
      return refuse(
        toolEnvelope({ runId: context.binding.runId, status: "BAD_REQUEST", blockers: [{ code: "BAD_REQUEST", reason: "BLOCKED_PLATFORM", message }] }),
        message,
      );
    }
    const nodeId = stringParam(context.params, "nodeId") ?? context.binding.nodeId;
    const claimGate = requireClaim(context, nodeId, context.binding.iteration);
    if (!isClaimGate(claimGate)) return claimGate;
    const claim = claimGate.claim;

    const contract = await readContract(runtime, context);
    if (!isContract(contract)) return contract;

    const result = await runtime.requestHelp(context.runCtx.companyId, context.binding.runId, {
      ...mutationEnvelope(context, contract, claim, nodeId),
      payload: {
        kind,
        question,
        context: asRecord(context.params["context"]),
        // The help request names what it is about; it never carries an answer or an approval.
        requestedBy: { subject: `agent:paperclip/${context.runCtx.agentId}`, runId: context.runCtx.runId },
      },
    });
    return commandResultToToolResult(
      result,
      context.binding.runId,
      `Help intent recorded (${kind}). No approval was implied and nothing is waiting on this call.`,
    );
  }

  return {
    status,
    current,
    submit_artifact: submitArtifact,
    submit_evidence: submitEvidence,
    request_transition: requestTransition,
    request_help: requestHelp,
  };
}

function isContract(value: ToolCurrentContract | ToolResult): value is ToolCurrentContract {
  return (value as ToolCurrentContract).contractHash !== undefined || (value as ToolCurrentContract).claimable !== undefined;
}

function contractPayload(
  contract: ToolCurrentContract,
  claim: ToolClaim | null,
  adopted: boolean,
): Record<string, unknown> {
  return {
    nodeId: contract.nodeId,
    iteration: contract.iteration,
    contractHash: contract.contractHash,
    requiredInputs: contract.requiredInputs,
    permittedOutputs: contract.permittedOutputs,
    evidenceRequirements: contract.evidenceRequirements,
    policyConstraints: contract.policyConstraints,
    permittedActions: contract.permittedActions,
    leaseEpoch: claim?.leaseEpoch ?? contract.leaseEpoch,
    attemptId: claim?.attemptId ?? contract.attemptId,
    adopted,
    // Stated so a consumer can see the producer identity is not caller-supplied.
    producerSubjectIsDerivedFromToolRunContext: true,
  };
}

function mutationEnvelope(
  context: ToolContext,
  contract: ToolCurrentContract,
  claim: ToolClaim,
  nodeId: string,
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    // The transition identity is the contract hash plus the fenced attempt, so a retry of the
    // same transition returns the recorded result rather than committing twice.
    commandId: `${context.binding.runId}:${nodeId}:${claim.attemptId}:${claim.leaseEpoch}`,
    idempotencyKey: `pf.transition:${contract.contractHash ?? claim.attemptId}:${claim.attemptId}:${claim.leaseEpoch}`,
    correlationId: context.binding.runId,
    causationId: context.runCtx.runId,
    runId: context.binding.runId,
    nodeId,
    iteration: contract.iteration,
    attemptId: claim.attemptId,
    leaseEpoch: claim.leaseEpoch,
    expectedStateVersion: contract.stateVersion,
    contractHash: contract.contractHash ?? "",
  };
}

function readEpoch(result: ToolCommandResultLike): number | null {
  const value = (result as unknown as Record<string, unknown>)["leaseEpoch"];
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** The attempt the Core granted, when it names one. A Core that does not is tolerated. */
function readAttemptId(result: ToolCommandResultLike): string | null {
  const value = (result as unknown as Record<string, unknown>)["attemptId"];
  return typeof value === "string" && value.length > 0 ? value : null;
}

interface ToolCommandResultLike {
  commandId: string;
  applied: boolean;
  stateVersion: number;
  status: string;
  resultRef?: string;
  pending?: boolean;
  pendingReason?: string;
  blockers?: { code: string; reason: string; message: string }[];
}

function commandResultToToolResult(
  result: ToolCommandResultLike,
  runId: string,
  successText: string,
): ToolResult {
  const envelope = toolEnvelope({
    runId,
    stateVersion: result.stateVersion,
    status: result.status,
    pending: result.pending === true,
    pendingReason: result.pendingReason ?? null,
    nextSteps:
      result.pending === true
        ? ["Wait for the pending decision; do not resubmit the same transition."]
        : result.blockers && result.blockers.length > 0
          ? ["Resolve the blockers; the transition was not committed."]
          : [],
    blockers: result.blockers ?? [],
    data: {
      commandId: result.commandId,
      applied: result.applied,
      resultRef: result.resultRef ?? null,
      // A tool never reports a pass it did not read from the Core.
      assertedPass: false,
    },
  });
  if (result.blockers && result.blockers.length > 0) {
    const message = result.blockers.map((blocker) => blocker.message).join("; ");
    return { content: `${successText} Blocked: ${message}`, error: message, data: envelope };
  }
  return ok(envelope, successText);
}

function buildNextSteps(snapshot: ToolRunSnapshot, nodeId: string | null): string[] {
  if (nodeId !== null) {
    const node = snapshot.nodes.find((entry) => entry.nodeId === nodeId);
    if (!node) return [];
    switch (node.status) {
      case "READY":
        return ["polyforge.current with adopt: true, then do the work."];
      case "RUNNING":
        return ["Submit artifacts, then evidence, then request a transition."];
      case "EVIDENCE_READY":
        return ["polyforge.request_transition with the evidence ids you submitted."];
      case "EVALUATING":
        return ["Wait for the gate; the Core is evaluating."];
      case "WAITING_GOVERNANCE":
        return ["A human decision is required. The worker is released; do not poll."];
      case "REWORK_REQUIRED":
        return ["polyforge.current to read the new contract, then redo the work."];
      case "PASSED":
        return ["Nothing to do for this node."];
      case "BLOCKED":
        return ["Resolve the block reason before doing further work."];
      default:
        return ["polyforge.current to read the contract for this node."];
    }
  }
  if (snapshot.pendingGovernance.length > 0) return ["A human decision is pending."];
  if (snapshot.status === "COMPLETED") return ["The run is complete."];
  return ["polyforge.current to see which node is actionable."];
}
