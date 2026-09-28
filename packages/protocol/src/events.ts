/**
 * Normalized `pf.*` domain events.
 *
 * Left column: Paperclip observations the bridge subscribes to. Right column: the normalized
 * event the Core understands. An observation is never a fact about engineering state — it is
 * a *request to verify*. Only the Core may commit a transition, and only after checking
 * version, permission, evidence, and the transition contract.
 */

export const PF_EVENT_TYPES = [
  "pf.work_order.accepted",
  "pf.node.ready",
  "pf.node.dispatched",
  "pf.execution.observed",
  "pf.execution.unknown",
  "pf.evidence.ingested",
  "pf.gate.waiting",
  "pf.gate.evaluated",
  "pf.transition.committed",
  "pf.transition.rejected",
  "pf.governance.requested",
  "pf.governance.observed",
  "pf.authorization.denied",
  "pf.effect.unknown",
  "pf.effect.reconciled",
  "pf.run.blocked",
  "pf.run.completed",
  "pf.run.cancelled",
  "pf.checkpoint.written",
  "pf.migration.committed",
] as const;
export type PfEventType = (typeof PF_EVENT_TYPES)[number];

/** Paperclip host events the bridge subscribes to on this fixed baseline. */
export const PAPERCLIP_EVENT_TYPES = [
  "issue.created",
  "issue.updated",
  "issue.relations.updated",
  "issue.checked_out",
  "issue.released",
  "issue.assignment_wakeup_requested",
  "issue.document.created",
  "issue.document.updated",
  "issue.document.deleted",
  "agent.run.started",
  "agent.run.finished",
  "agent.run.failed",
  "agent.run.cancelled",
  "agent.status_changed",
  "approval.created",
  "approval.decided",
  "budget.incident.opened",
  "budget.incident.resolved",
  "project.workspace_created",
  "project.workspace_updated",
  "project.workspace_deleted",
  "activity.logged",
] as const;
export type PaperclipEventType = (typeof PAPERCLIP_EVENT_TYPES)[number];

export interface NormalizedEvent<P = Record<string, unknown>> {
  type: PfEventType;
  runId: string | null;
  nodeId?: string | null;
  scope: { companyRef: string; projectRef: string };
  correlationId: string;
  causationId?: string | null;
  /** The Paperclip event id this observation was derived from, for dedupe. */
  sourceEventId: string;
  occurredAt: string;
  payload: P;
}
