/**
 * The event pump: subscribe, deduplicate, normalize, hand to the Core.
 *
 * One handler shape for all twenty-two subscribed host events, in the order the contract
 * requires:
 *
 * ```text
 * receive ─> inbox.record (dedupe) ─> irrelevant? mark ignored, stop
 *         ─> normalize (may quarantine) ─> re-read if stale ─> enqueue event.intake
 * ```
 *
 * The Core receives events through the **outbox**, not through a direct HTTP call from the
 * handler. That is deliberate: a handler that called the Core inline would lose the event if
 * the worker died between "received" and "sent", and would have no record of the intent. Here
 * the inbox row and the outbox row are written in the same store, so "the event was received"
 * and "the event will be delivered" commit together.
 *
 * Staleness re-read: when the payload is older than what the bridge already recorded for the
 * subject, the pump fetches the current object from the host and normalizes *that* instead. An
 * out-of-order delivery therefore converges on the authoritative revision rather than
 * overwriting newer state by arrival order.
 */

import { PAPERCLIP_EVENT_TYPES } from "@polyforge/protocol";
import type { NormalizedEvent, PaperclipEventType, Scope } from "@polyforge/protocol";
import { canonicalJson } from "@polyforge/protocol";
import type { PluginContext, PluginEvent, PluginEventType } from "@paperclipai/plugin-sdk";
import type { BridgeStore } from "../store.js";
import type { BridgeLogger } from "../logger.js";
import type { BridgeMetrics } from "../metrics.js";
import type { Inbox } from "./inbox.js";
import {
  BRIDGE_EVENT_SCHEMA_VERSION,
  normalizeEvent,
  observedRevisionOf,
  revisionKeyOf,
  type NormalizeContext,
} from "./normalize.js";
import { INTENT_KINDS, eventIntakeEffectKey } from "../outbox/intents.js";
import { RUN_BINDING_KIND, WORK_UNIT_BINDING_KIND, DISPATCH_BINDING_KIND } from "../ports/work-management.js";

export interface PumpDeps {
  readonly ctx: PluginContext;
  readonly store: BridgeStore;
  readonly inbox: Inbox;
  readonly logger: BridgeLogger;
  readonly metrics: BridgeMetrics;
  /** Enqueue an outbox intent; `false` means one with the same effect key already exists. */
  enqueue(input: {
    effectKey: string;
    kind: string;
    scope: Scope;
    correlationId: string;
    runId: string | null;
    nodeId: string | null;
    payload: unknown;
  }): boolean;
  /** Whether the Core is currently reachable. When false, events queue in the outbox. */
  runtimeAvailable(): boolean;
  /**
   * Make sure the bridge has this company's configuration.
   *
   * An event handler is a company-scoped invocation, which is exactly the context the host
   * requires before it will answer `config.get` — a scheduled job is not, and cannot learn a
   * company at all. The first event for a company is therefore the natural moment to learn it, and
   * it is the moment work is about to be admitted, so a company that is not configured is caught
   * here rather than at delivery time. Called without awaiting: the implementation defers the
   * host call onto the event loop so the RPC handler is never blocked on a reply to itself.
   */
  learnCompany(companyId: string): void;
}

export interface HandleOutcome {
  readonly recorded: boolean;
  readonly duplicate: boolean;
  readonly normalized: number;
  readonly quarantined: number;
  readonly ignored: number;
  readonly needsRefetch: number;
}

export class EventPump {
  readonly #deps: PumpDeps;
  readonly #unsubscribe: (() => void)[] = [];
  readonly #normalizeContext: NormalizeContext;

  constructor(deps: PumpDeps) {
    this.#deps = deps;
    this.#normalizeContext = {
      runIdForIssue: (companyId, issueId) => this.#runIdForIssue(companyId, issueId),
      runIdForAgentRun: (companyId, agentRunId) => this.#runIdForAgentRun(companyId, agentRunId),
      projectIdForIssue: (companyId, issueId) => this.#projectIdForIssue(companyId, issueId),
      lastRevision: (companyId, subjectKey) => this.#deps.store.getCompat<string | null>(companyId, subjectKey, null),
    };
  }

  /** Subscribe to the frozen event set. Returns an unsubscribe function for shutdown. */
  subscribe(): () => void {
    for (const eventType of PAPERCLIP_EVENT_TYPES) {
      const unsubscribe = this.#deps.ctx.events.on(
        eventType as PluginEventType,
        async (event) => {
          await this.handle(event);
        },
      );
      this.#unsubscribe.push(unsubscribe);
    }
    return () => {
      for (const off of this.#unsubscribe.splice(0)) off();
    };
  }

  /**
   * Handle one host event.
   *
   * Exposed so the reconciler can replay an inbox row after a crash, and so a test can drive
   * the exact same path the subscription drives.
   */
  async handle(event: PluginEvent): Promise<HandleOutcome> {
    const { store, inbox, logger, metrics } = this.#deps;
    const companyId = event.companyId;
    const projectId = this.#projectIdForEvent(event);
    const outcome: MutableOutcome = { normalized: 0, quarantined: 0, ignored: 0, needsRefetch: 0 };

    // Learn the company before anything else: this handler is a company-scoped invocation, so it
    // is one of the few contexts in which the host will answer `config.get`. Doing it after the
    // durable record would still be correct, but doing it first means an unconfigured company is
    // visible before work is admitted rather than at delivery time.
    this.#deps.learnCompany(companyId);

    // (1) durable first. A duplicate stops here — before any side effect, including any
    // admission decision. This single line is what makes 100 replays produce 1 run.
    const { duplicate } = inbox.record(event, projectId);
    if (duplicate) {
      return {
        recorded: false,
        duplicate: true,
        normalized: 0,
        quarantined: 0,
        ignored: 0,
        needsRefetch: 0,
      };
    }

    // (2) normalize. An unknown schema is quarantined with its hash, never dropped.
    let result = normalizeEvent(event, this.#normalizeContext);
    if (result.kind === "ignore") {
      inbox.mark(companyId, event.eventId, "ignored", { error: result.reason });
      outcome.ignored += 1;
      return { recorded: true, duplicate: false, ...outcome };
    }
    if (result.kind === "quarantine") {
      store.quarantine({
        companyId,
        eventType: String(event.eventType),
        sourceEventId: event.eventId,
        detectedVersion: result.detectedVersion,
        payload: event.payload,
        reason: result.reason,
      });
      metrics.bump(companyId, "platformBlocks", 0);
      inbox.mark(companyId, event.eventId, "quarantined", { error: result.reason });
      outcome.quarantined += 1;
      logger.warn("event quarantined: unknown schema", {
        eventType: event.eventType,
        expectedSchema: BRIDGE_EVENT_SCHEMA_VERSION,
      });
      return { recorded: true, duplicate: false, ...outcome };
    }

    // (3) re-read the subject. Two reasons, and the second is the important one:
    //     * `stale` — an out-of-order delivery must converge on the current object;
    //     * `needsRefetch` — the normalizer saw a payload whose status field is a *claim*
    //       (`issue.updated`'s `to`, an agent's self-reported outcome). Reporting that claim as
    //       the board's status is how a dragged-to-`done` issue becomes a fact the Core reads.
    //       The bridge re-reads so the Core is told what the host holds, and the claim is kept
    //       alongside it as `claimedStatus` for the audit trail.
    let normalized = result.event;
    if (result.stale || result.needsRefetch) {
      outcome.needsRefetch += 1;
      const refetched = await this.#refetchCurrent(event, result.event);
      if (refetched !== null) {
        normalized = refetched;
        inbox.mark(companyId, event.eventId, "normalized", { normalized });
        this.#advanceSubjectRevision(companyId, event, normalized);
        this.#enqueueIntake(normalized, projectId, outcome);
        return { recorded: true, duplicate: false, ...outcome };
      }
    }

    // (4) record the revision we have now observed, so a later older event is detectable.
    this.#advanceSubjectRevision(companyId, event, normalized);
    inbox.mark(companyId, event.eventId, "normalized", { normalized });

    // (5) hand it to the Core through the outbox.
    this.#enqueueIntake(normalized, projectId, outcome);
    return { recorded: true, duplicate: false, ...outcome };
  }

  #enqueueIntake(event: NormalizedEvent, projectId: string | null, outcome: MutableOutcome): void {
    const scope: Scope = { companyRef: event.scope.companyRef, projectRef: projectId ?? event.scope.projectRef };
    const effectKey = eventIntakeEffectKey(scope, event.sourceEventId);
    const created = this.#deps.enqueue({
      effectKey,
      kind: INTENT_KINDS.eventIntake,
      scope,
      correlationId: event.correlationId,
      runId: event.runId,
      nodeId: event.nodeId ?? null,
      payload: event,
    });
    if (created) outcome.normalized += 1;
    this.#deps.inbox.mark(event.scope.companyRef, event.sourceEventId, "queued");
  }

  /**
   * Re-read the current object and re-normalize from it.
   *
   * Returns `null` when the subject is gone or unreadable, in which case the original event is
   * still forwarded (flagged `stale`) so the Core can decide; discarding it would lose the
   * only record that something changed.
   */
  async #refetchCurrent(event: PluginEvent, staleEvent: NormalizedEvent): Promise<NormalizedEvent | null> {
    const { ctx, logger } = this.#deps;
    const issueId = typeof staleEvent.payload["issueId"] === "string" ? (staleEvent.payload["issueId"] as string) : null;
    if (issueId === null) return null;
    const issue = await ctx.issues.get(issueId, event.companyId);
    if (!issue) {
      logger.warn("stale event subject no longer exists; forwarding the stale observation", {
        issueId,
        sourceEventId: event.eventId,
      });
      return { ...staleEvent, payload: { ...staleEvent.payload, stale: true, subjectMissing: true } };
    }
    const replay: PluginEvent = {
      ...event,
      occurredAt: new Date(issue.updatedAt instanceof Date ? issue.updatedAt.getTime() : Date.parse(String(issue.updatedAt))).toISOString(),
      payload: {
        ...(typeof event.payload === "object" && event.payload !== null ? event.payload : {}),
        // The status the host actually holds, which is what normalization reads. What the event
        // claimed is recovered from the pre-refetch payload by `mergeRefetchedPayload`.
        status: issue.status,
        updatedAt:
          issue.updatedAt instanceof Date ? issue.updatedAt.toISOString() : String(issue.updatedAt ?? event.occurredAt),
        refetched: true,
      },
    };
    const result = normalizeEvent(replay, this.#normalizeContext);
    if (result.kind !== "event") return null;
    return {
      ...result.event,
      payload: mergeRefetchedPayload(staleEvent.payload, result.event.payload),
    };
  }

  #advanceSubjectRevision(companyId: string, event: PluginEvent, normalized: NormalizedEvent): void {
    const raw = typeof event.payload === "object" && event.payload !== null ? (event.payload as Record<string, unknown>) : {};
    const revision = observedRevisionOf(raw);
    if (revision !== null) this.#deps.store.setCompat(companyId, revisionKeyOf(event), revision);
    void normalized;
  }

  // -------------------------------------------------------------------------
  // Binding lookups
  // -------------------------------------------------------------------------

  /**
   * The run an issue belongs to, from the bridge's own bindings.
   *
   * There is no reverse index in Paperclip, so a child issue is found through its recorded
   * work-unit binding and a Root Issue through its run binding. An issue with no binding has no
   * run, which is the correct answer for an operational issue.
   */
  #runIdForIssue(companyId: string, issueId: string): string | null {
    if (issueId.length === 0) return null;
    for (const row of this.#deps.store.listBindings(companyId, WORK_UNIT_BINDING_KIND, 2000)) {
      const payload = safeJson(row.payloadJson);
      if (payload["issueId"] === issueId && typeof payload["runId"] === "string") return payload["runId"];
    }
    for (const row of this.#deps.store.listBindings(companyId, RUN_BINDING_KIND, 2000)) {
      const payload = safeJson(row.payloadJson);
      if (payload["rootIssueId"] === issueId && typeof payload["runId"] === "string") return payload["runId"];
    }
    return null;
  }

  #runIdForAgentRun(companyId: string, agentRunId: string): string | null {
    if (agentRunId.length === 0) return null;
    for (const row of this.#deps.store.listBindings(companyId, DISPATCH_BINDING_KIND, 2000)) {
      const payload = safeJson(row.payloadJson);
      if (payload["agentRunRefId"] === agentRunId && typeof payload["runId"] === "string") return payload["runId"];
    }
    return null;
  }

  #projectIdForIssue(companyId: string, issueId: string): string | null {
    if (issueId.length === 0) return null;
    for (const kind of [WORK_UNIT_BINDING_KIND, RUN_BINDING_KIND]) {
      for (const row of this.#deps.store.listBindings(companyId, kind, 2000)) {
        const payload = safeJson(row.payloadJson);
        if (payload["issueId"] === issueId || payload["rootIssueId"] === issueId) {
          return row.projectId.length > 0 ? row.projectId : null;
        }
      }
    }
    return null;
  }

  #projectIdForEvent(event: PluginEvent): string | null {
    const payload =
      typeof event.payload === "object" && event.payload !== null
        ? (event.payload as Record<string, unknown>)
        : {};
    const issueIdValue = typeof payload["issueId"] === "string" ? payload["issueId"] : event.entityId;
    if (event.entityType === "issue" || typeof payload["issueId"] === "string") {
      return issueIdValue === null || issueIdValue === undefined ? null : this.#projectIdForIssue(event.companyId, issueIdValue);
    }
    return null;
  }
}

interface MutableOutcome {
  normalized: number;
  quarantined: number;
  ignored: number;
  needsRefetch: number;
}

function safeJson(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Payload keys that describe *what the event claimed*, not what the host holds.
 *
 * These are restored after the re-read. Without that, a false `to: "done"` would be laundered
 * into an ordinary `issue_update`: the Core would lose the "someone claims this finished" signal
 * entirely, which is the one thing the observation exists to carry. The status *value* is the
 * host's; the classification is the event's.
 */
const CLASSIFICATION_KEYS = [
  "observationKind",
  "requiresEvidenceVerification",
  "mayPassNode",
  "controlRequest",
  "preservesHistory",
  "previousStatus",
  "candidateArtifacts",
  "effectOutcome",
  "bridgeMayWorkAround",
  "retryableByBridge",
  "newDirectoryIsNotTheOldState",
  "blockReason",
  "claimedStatus",
] as const;

/**
 * Merge a re-read payload over the original.
 *
 * The authoritative values win — `boardStatus` in particular — while the classification keys are
 * carried across unchanged, and both the claim and the re-read are kept so an operator can see
 * what the event said and what was actually true.
 */
function mergeRefetchedPayload(
  original: Record<string, unknown>,
  authoritative: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...original, ...authoritative };
  for (const key of CLASSIFICATION_KEYS) {
    if (original[key] !== undefined) merged[key] = original[key];
  }
  // What the event claimed, before the re-read replaced it. Kept because "the event said done and
  // the issue was not" is exactly the discrepancy an operator needs to see.
  const claimed = original["boardStatus"];
  if (claimed !== undefined) merged["claimedStatus"] = claimed;
  merged["refetchedFromAuthoritativeObject"] = true;
  return merged;
}

export { canonicalJson, type PaperclipEventType };
