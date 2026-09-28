/**
 * Authoritative PolyForge state vocabulary.
 *
 * These are the only states the Graph Core may persist. Paperclip issue statuses are a
 * *projection* of these values (see `projectIssueStatus`), never a substitute: an issue
 * dragged to `done` produces a completion observation that still has to clear a gate.
 */

export const GRAPH_RUN_STATUSES = [
  "CREATED",
  "ACTIVE",
  "WAITING",
  "PAUSED",
  "BLOCKED",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
] as const;
export type GraphRunStatus = (typeof GRAPH_RUN_STATUSES)[number];

export const NODE_STATUSES = [
  "PENDING",
  "READY",
  "DISPATCH_REQUESTED",
  "RUNNING",
  "EVIDENCE_READY",
  "EVALUATING",
  "WAITING_GOVERNANCE",
  "PASSED",
  "REWORK_REQUIRED",
  "FAILED",
  "BLOCKED",
  "SKIPPED",
] as const;
export type NodeStatus = (typeof NODE_STATUSES)[number];

export const ATTEMPT_STATUSES = [
  "PREPARED",
  "RUNNING",
  "CHECKPOINTED",
  "EVIDENCE_READY",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "UNKNOWN",
  "RECONCILING",
] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

/** The `BLOCKED` reason vocabulary. Each value is an explainable, non-forgeable cause. */
export const BLOCK_REASONS = [
  "BLOCKED_BUDGET",
  "BLOCKED_PLATFORM",
  "BLOCKED_WORKSPACE",
  "BLOCKED_AUTHORIZATION",
  "BLOCKED_GOVERNANCE",
  "BLOCKED_STALE_INPUT",
  "BLOCKED_EFFECT_UNKNOWN",
  "BLOCKED_DEPENDENCY",
  "BLOCKED_LEASE_FENCED",
  "BLOCKED_SCOPE",
] as const;
export type BlockReason = (typeof BLOCK_REASONS)[number];

export const GATE_RESULTS = ["PASS", "FAIL", "ESCALATE"] as const;
export type GateResult = (typeof GATE_RESULTS)[number];

export const EVALUATOR_KINDS = ["automatic", "independent_agent", "human_decision"] as const;
export type EvaluatorKind = (typeof EVALUATOR_KINDS)[number];

export const NODE_KINDS = [
  "agent_operation",
  "deterministic",
  "gate",
  "subgraph",
  "external_effect",
] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export const JOIN_SEMANTICS = ["all", "any", "quorum"] as const;
export type JoinSemantics = (typeof JOIN_SEMANTICS)[number];

/** Paperclip issue status vocabulary this bridge projects onto. */
export const PROJECTED_ISSUE_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "cancelled",
] as const;
export type ProjectedIssueStatus = (typeof PROJECTED_ISSUE_STATUSES)[number];

/**
 * Status projection table (docs/01-REQUIREMENTS.md REQ-WORK-04, docs/02 §8.4).
 *
 * The source is always explicit in a projection payload so the UI can label where a
 * status came from and never present an unknown value as a pass.
 */
export function projectIssueStatus(
  status: GraphRunStatus | NodeStatus,
  context: { waitingGovernance?: boolean } = {},
): ProjectedIssueStatus | null {
  if (status === "WAITING_GOVERNANCE") {
    return "in_review";
  }
  switch (status) {
    case "PENDING":
      return "backlog";
    case "READY":
    case "DISPATCH_REQUESTED":
      return "todo";
    case "RUNNING":
    case "EVIDENCE_READY":
    case "EVALUATING":
      return "in_progress";
    case "PASSED":
    case "COMPLETED":
      return "done";
    case "CANCELLED":
      return "cancelled";
    case "BLOCKED":
      return "blocked";
    case "FAILED":
      return "blocked";
    case "SKIPPED":
      return "done";
    case "REWORK_REQUIRED":
      return "todo";
    case "CREATED":
    case "ACTIVE":
    case "WAITING":
    case "PAUSED":
      return context.waitingGovernance ? "in_review" : "in_progress";
    default:
      return null;
  }
}
