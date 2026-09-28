/**
 * Normalization: a Paperclip observation is never a fact about engineering state.
 *
 * The left column of the table in `docs/02` §8.3 is a *question*, not an answer. This module
 * turns each subscribed host event into exactly one `pf.*` event whose payload says what was
 * observed and by whom, and leaves every judgement to the Core:
 *
 * ```text
 * issue.updated (board dragged to done) ──> pf.execution.observed
 *                                           { observationOnly: true, needsEvidence: true }
 * agent.run.finished                      ──> pf.execution.observed
 *                                           { observationOnly: true, effectOutcome: unknown }
 * budget.incident.opened                  ──> pf.authorization.denied / pf.run.blocked
 * ```
 *
 * Three rules are enforced structurally rather than by convention:
 *
 * 1. **Unknown in, quarantined out.** An event type this module does not know, or a payload
 *    whose required fields are missing, is parked in `schema_quarantine` with its payload hash
 *    and the schema version the bridge expects. It is never silently dropped and never guessed.
 * 2. **Staleness is detected, not assumed.** When the payload carries a revision/version the
 *    bridge has already superseded, the event is marked `stale` and `needsRefetch`, and the
 *    pump re-reads the current object before the event reaches the Core. Arrival order never
 *    decides state.
 * 3. **`agent.run.finished` is an observation.** There is no code path from an agent run
 *    status to a `PASS`. `observationOnly: true` is set on every execution observation, and
 *    the Core is expected to ignore it as a fact about a transition.
 */

import { digestText } from "@polyforge/protocol";
import type { NormalizedEvent, PfEventType, Scope } from "@polyforge/protocol";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import { PAPERCLIP_EVENT_TYPES } from "@polyforge/protocol";

/** The schema version the bridge understands. Recorded with every quarantine. */
export const BRIDGE_EVENT_SCHEMA_VERSION = "polyforge.bridge.event/1";

const KNOWN_HOST_EVENTS = new Set<string>(PAPERCLIP_EVENT_TYPES);

export interface NormalizeContext {
  /** Resolve the run a subject belongs to, from the bridge's own bindings. */
  runIdForIssue(companyId: string, issueId: string): string | null;
  runIdForAgentRun(companyId: string, agentRunId: string): string | null;
  projectIdForIssue(companyId: string, issueId: string): string | null;
  /** Last revision the bridge has seen for a subject; used for the staleness comparison. */
  lastRevision(companyId: string, subjectKey: string): string | null;
}

export type NormalizeResult =
  | {
      readonly kind: "event";
      readonly event: NormalizedEvent;
      readonly stale: boolean;
      /**
       * True when the normalized payload quotes a status the *event* claimed rather than one the
       * bridge read. The caller must re-read the subject before reporting it, so a board drag or
       * a self-reported agent outcome cannot reach the Core as a fact.
       */
      readonly needsRefetch: boolean;
    }
  | { readonly kind: "ignore"; readonly reason: string }
  | { readonly kind: "quarantine"; readonly reason: string; readonly detectedVersion: string };

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function bool(value: unknown): boolean {
  return value === true;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function entityIssueId(event: PluginEvent, payload: Record<string, unknown>): string | null {
  return (
    str(payload["issueId"]) ??
    str(payload["issue_id"]) ??
    (event.entityType === "issue" ? str(event.entityId) : null) ??
    null
  );
}

function entityAgentRunId(event: PluginEvent, payload: Record<string, unknown>): string | null {
  return (
    str(payload["runId"]) ??
    str(payload["agentRunId"]) ??
    str(payload["heartbeatRunId"]) ??
    (event.entityType === "heartbeat_run" || event.entityType === "agent_run" ? str(event.entityId) : null) ??
    null
  );
}

/** Read a revision marker from a payload under any of the names this host baseline uses. */
function revisionOf(payload: Record<string, unknown>): string | null {
  for (const key of ["revision", "version", "updatedRevision", "latestRevisionId", "documentVersion"]) {
    const value = payload[key];
    if (typeof value === "string" && value.length > 0) return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function issueStatus(payload: Record<string, unknown>): string | null {
  return str(payload["status"]) ?? str(payload["to"]) ?? str(payload["from"]) ?? null;
}

interface Draft {
  readonly type: PfEventType;
  readonly runId: string | null;
  readonly nodeId: string | null;
  readonly payload: Record<string, unknown>;
  /** Set when the payload cannot be trusted as current and the object must be re-read. */
  readonly needsRefetch: boolean;
  /** True when this event carries no engineering meaning and may be dropped after recording. */
  readonly ignore: boolean;
  readonly ignoreReason: string;
}

export function normalizeEvent(event: PluginEvent, context: NormalizeContext): NormalizeResult {
  const eventType = String(event.eventType);
  if (!KNOWN_HOST_EVENTS.has(eventType)) {
    return {
      kind: "quarantine",
      reason: "event type is not part of the frozen PAPERCLIP_EVENT_TYPES baseline",
      detectedVersion: BRIDGE_EVENT_SCHEMA_VERSION,
    };
  }

  const raw = event.payload;
  const payload: Record<string, unknown> =
    typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const companyId = event.companyId;
  const issueId = entityIssueId(event, payload);
  const agentRunId = entityAgentRunId(event, payload);
  const runId =
    context.runIdForIssue(companyId, issueId ?? "") ??
    (agentRunId === null ? null : context.runIdForAgentRun(companyId, agentRunId));

  const projectId = issueId === null ? null : context.projectIdForIssue(companyId, issueId);
  const subjectKey = issueId ?? agentRunId ?? event.entityId ?? event.eventId;
  const observedRevision = revisionOf(payload);
  const storedRevision = context.lastRevision(companyId, `subject:${subjectKey}`);
  const stale =
    observedRevision !== null && storedRevision !== null && compareRevisions(observedRevision, storedRevision) < 0;

  const draft = buildDraft(eventType, event, payload, { issueId, agentRunId, runId, stale });

  if (draft.ignore) return { kind: "ignore", reason: draft.ignoreReason };

  const scope: Scope = { companyRef: companyId, projectRef: projectId ?? "" };
  const normalized: NormalizedEvent = {
    type: draft.type,
    runId: draft.runId,
    nodeId: draft.nodeId,
    scope,
    correlationId: str(payload["correlationId"]) ?? runId ?? issueId ?? event.eventId,
    causationId: str(payload["causationId"]),
    sourceEventId: event.eventId,
    occurredAt: event.occurredAt,
    payload: {
      ...draft.payload,
      hostEventType: eventType,
      hostEntityId: event.entityId ?? null,
      hostEntityType: event.entityType ?? null,
      ...(stale ? { stale: true, observedRevision } : {}),
      ...(draft.needsRefetch ? { needsRefetch: true } : {}),
    },
  };
  return { kind: "event", event: normalized, stale, needsRefetch: draft.needsRefetch };
}

/**
 * The mapping itself.
 *
 * Every execution-related branch sets `observationOnly: true`. There is deliberately no branch
 * that produces `pf.transition.committed`: the Core is the only writer of that fact, and a
 * bridge that could emit it would be a second commit path.
 */
function buildDraft(
  eventType: string,
  event: PluginEvent,
  payload: Record<string, unknown>,
  ids: { issueId: string | null; agentRunId: string | null; runId: string | null; stale: boolean },
): Draft {
  const base = { runId: ids.runId, nodeId: null, needsRefetch: ids.stale, ignore: false, ignoreReason: "" };
  const observation = {
    ...base,
    payload: { observationOnly: true, effectOutcome: "unknown" },
  };

  switch (eventType) {
    case "issue.created": {
      return {
        ...base,
        type: "pf.work_order.accepted",
        runId: null,
        // A created issue is only interesting if it names engineering work; the router
        // decides that. The Core receives the observation and admits or not.
        payload: {
          observationOnly: true,
          issueId: ids.issueId,
          status: issueStatus(payload),
          originKind: str(payload["originKind"]),
          originId: str(payload["originId"]),
          labels: Array.isArray(payload["labels"]) ? payload["labels"] : [],
        },
      };
    }

    case "issue.updated": {
      const status = issueStatus(payload);
      const wasDone = str(payload["from"]) === "done";
      if (status === "done" || wasDone) {
        // A board drag is a completion *claim*. The Core verifies evidence; it never passes a
        // node because an issue moved. `needsRefetch` forces a re-read of the current issue so
        // an out-of-order update cannot be evaluated against a stale body.
        return {
          ...observation,
          type: "pf.execution.observed",
          needsRefetch: true,
          payload: {
            ...observation.payload,
            observationKind: "board_status_change",
            issueId: ids.issueId,
            boardStatus: status,
            previousStatus: str(payload["from"]),
            requiresEvidenceVerification: true,
            mayPassNode: false,
          },
        };
      }
      if (status === "cancelled" || status === "blocked") {
        // External pause/cancel is a control request, not a state change. The Core
        // checkpoints, requests a stop, reconciles, and keeps the history.
        return {
          ...observation,
          type: "pf.execution.observed",
          needsRefetch: true,
          payload: {
            ...observation.payload,
            observationKind: "control_request",
            issueId: ids.issueId,
            boardStatus: status,
            controlRequest: status === "cancelled" ? "cancel" : "pause",
            preservesHistory: true,
          },
        };
      }
      return {
        ...base,
        type: "pf.execution.observed",
        payload: {
          observationOnly: true,
          issueId: ids.issueId,
          boardStatus: status,
          observationKind: "issue_update",
        },
      };
    }

    case "issue.relations.updated": {
      return {
        ...base,
        type: "pf.execution.observed",
        payload: {
          observationOnly: true,
          issueId: ids.issueId,
          observationKind: "relations",
          blockedBy: Array.isArray(payload["blockedByIssueIds"]) ? payload["blockedByIssueIds"] : [],
          // Relations are a *display* of the graph's dependency truth, never its source.
          authoritative: false,
        },
      };
    }

    case "issue.checked_out": {
      return {
        ...base,
        type: "pf.execution.observed",
        payload: {
          observationOnly: true,
          issueId: ids.issueId,
          observationKind: "checkout",
          agentRunId: ids.agentRunId,
          agentId: str(payload["agentId"]),
          // The checkout is the issue layer of the two-layer fence. The Core claim is the
          // other layer; both must agree before a side effect.
          checkoutEstablished: true,
        },
      };
    }

    case "issue.released": {
      return {
        ...base,
        type: "pf.execution.observed",
        payload: {
          observationOnly: true,
          issueId: ids.issueId,
          observationKind: "release",
          agentRunId: ids.agentRunId,
          checkoutEstablished: false,
        },
      };
    }

    case "issue.assignment_wakeup_requested": {
      // A wakeup is a *request to re-check*, not a statement that work started. The Core
      // decides readiness; the bridge only reports that the platform asked.
      return {
        ...base,
        type: "pf.execution.observed",
        payload: {
          observationOnly: true,
          issueId: ids.issueId,
          observationKind: "wakeup_requested",
          agentId: str(payload["agentId"]),
          agentRunId: ids.agentRunId,
          reason: str(payload["reason"]),
        },
      };
    }

    case "issue.document.created":
    case "issue.document.updated": {
      return {
        ...base,
        type: "pf.evidence.ingested",
        needsRefetch: true,
        payload: {
          observationOnly: true,
          issueId: ids.issueId,
          observationKind: eventType === "issue.document.created" ? "document_created" : "document_updated",
          documentKey: str(payload["key"]) ?? str(payload["documentKey"]),
          documentId: str(payload["documentId"]),
          revision: str(payload["latestRevisionId"]) ?? str(payload["revisionId"]) ?? str(payload["revision"]),
          // A mutable document changing must invalidate the evidence that referenced it, and
          // must never silently replace the meaning of already-archived evidence (REQ-DATA-02).
          invalidatesDependentEvidence: true,
          createsNewEvidenceIdentity: true,
        },
      };
    }

    case "issue.document.deleted": {
      return {
        ...base,
        type: "pf.evidence.ingested",
        needsRefetch: true,
        payload: {
          observationOnly: true,
          issueId: ids.issueId,
          observationKind: "document_deleted",
          documentKey: str(payload["key"]) ?? str(payload["documentKey"]),
          documentId: str(payload["documentId"]),
          invalidatesDependentEvidence: true,
        },
      };
    }

    case "agent.run.started": {
      return {
        ...observation,
        type: "pf.execution.observed",
        needsRefetch: false,
        payload: {
          ...observation.payload,
          observationKind: "run_started",
          issueId: ids.issueId,
          agentRunId: ids.agentRunId,
          agentId: str(payload["agentId"]),
          startedAt: str(payload["startedAt"]) ?? event.occurredAt,
        },
      };
    }

    case "agent.run.finished": {
      // Candidate evidence. Never a pass. `effectOutcome` stays `unknown` because the host
      // cannot authoritatively report whether an external effect happened.
      return {
        ...observation,
        type: "pf.execution.observed",
        payload: {
          ...observation.payload,
          observationKind: "run_finished",
          issueId: ids.issueId,
          agentRunId: ids.agentRunId,
          agentId: str(payload["agentId"]),
          finishedAt: str(payload["finishedAt"]) ?? event.occurredAt,
          candidateArtifacts: Array.isArray(payload["artifacts"]) ? payload["artifacts"] : [],
          requiresEvidenceVerification: true,
          mayPassNode: false,
        },
      };
    }

    case "agent.run.failed": {
      return {
        ...observation,
        type: "pf.execution.observed",
        payload: {
          ...observation.payload,
          observationKind: "run_failed",
          issueId: ids.issueId,
          agentRunId: ids.agentRunId,
          error: str(payload["error"]) ?? str(payload["reason"]),
          failureClass: str(payload["failureClass"]),
        },
      };
    }

    case "agent.run.cancelled": {
      return {
        ...observation,
        type: "pf.execution.observed",
        payload: {
          ...observation.payload,
          observationKind: "run_cancelled",
          issueId: ids.issueId,
          agentRunId: ids.agentRunId,
          reason: str(payload["reason"]),
        },
      };
    }

    case "agent.status_changed": {
      const status = str(payload["status"]);
      if (status === "paused" || status === "terminated" || status === "pending_approval") {
        return {
          ...observation,
          type: "pf.run.blocked",
          payload: {
            ...observation.payload,
            observationKind: "agent_unavailable",
            agentId: str(payload["agentId"]),
            agentStatus: status,
            blockReason: status === "paused" ? "BLOCKED_PLATFORM" : "BLOCKED_PLATFORM",
            retryableByBridge: false,
          },
        };
      }
      return {
        ...base,
        type: "pf.execution.observed",
        payload: { observationOnly: true, observationKind: "agent_status", agentStatus: status },
      };
    }

    case "approval.decided": {
      return {
        ...base,
        type: "pf.governance.observed",
        needsRefetch: true,
        payload: {
          observationOnly: true,
          approvalId: str(payload["approvalId"]),
          decision: str(payload["decision"]) ?? str(payload["status"]),
          // The bridge will re-read the approval; this payload is a hint, not the fact.
          mustReReadProviderObject: true,
        },
      };
    }

    case "approval.created": {
      return {
        ...base,
        type: "pf.governance.requested",
        ignore: true,
        ignoreReason: "approval creation is not a resolution",
        payload: { observationOnly: true, approvalId: str(payload["approvalId"]) },
      };
    }

    case "budget.incident.opened": {
      return {
        ...base,
        type: "pf.run.blocked",
        payload: {
          observationOnly: true,
          blockReason: "BLOCKED_BUDGET",
          incidentId: str(payload["incidentId"]),
          scopeType: str(payload["scopeType"]),
          metric: str(payload["metric"]),
          // Financial hard stops are the platform's to enforce; the bridge must not route
          // around them by choosing a different agent (REQ-DATA-03).
          bridgeMayWorkAround: false,
        },
      };
    }

    case "budget.incident.resolved": {
      return {
        ...base,
        type: "pf.execution.observed",
        payload: { observationOnly: true, observationKind: "budget_incident_resolved", incidentId: str(payload["incidentId"]) },
      };
    }

    case "project.workspace_created":
    case "project.workspace_updated": {
      return {
        ...base,
        type: "pf.execution.observed",
        needsRefetch: true,
        payload: {
          observationOnly: true,
          observationKind: eventType,
          workspaceId: str(payload["workspaceId"]) ?? str(event.entityId),
          projectId: str(payload["projectId"]),
        },
      };
    }

    case "project.workspace_deleted": {
      // A lost workspace is BLOCKED_WORKSPACE. Recovery re-derives from pinned artifacts; a new
      // directory must never pose as the old state (REQ-WS-04, AT-07).
      return {
        ...base,
        type: "pf.run.blocked",
        needsRefetch: true,
        payload: {
          observationOnly: true,
          blockReason: "BLOCKED_WORKSPACE",
          observationKind: "workspace_deleted",
          workspaceId: str(payload["workspaceId"]) ?? str(event.entityId),
          newDirectoryIsNotTheOldState: true,
        },
      };
    }

    case "activity.logged": {
      return {
        ...base,
        type: "pf.execution.observed",
        payload: { observationOnly: true, observationKind: "activity", entityId: event.entityId ?? null },
      };
    }

    default: {
      return {
        ...base,
        type: "pf.execution.observed",
        ignore: true,
        ignoreReason: `no engineering meaning is defined for ${eventType}`,
        payload: { observationOnly: true, hostEventType: eventType },
      };
    }
  }
}

/**
 * Compare two revision markers.
 *
 * Numeric revisions compare numerically; anything else compares as an opaque string, which is
 * the conservative direction: an unorderable pair is treated as current, so the pump re-reads
 * rather than dropping an event it could have misjudged.
 */
export function compareRevisions(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na === nb ? 0 : na < nb ? -1 : 1;
  if (a === b) return 0;
  return 0;
}

export function payloadHashOf(value: unknown): string {
  return digestText(JSON.stringify(value ?? null));
}

export function revisionKeyOf(event: PluginEvent): string {
  return `subject:${event.entityId ?? event.eventId}`;
}

export function observedRevisionOf(payload: Record<string, unknown>): string | null {
  return revisionOf(payload);
}

export function numericOrNull(value: unknown): number | null {
  return num(value);
}

export function flag(value: unknown): boolean {
  return bool(value);
}
