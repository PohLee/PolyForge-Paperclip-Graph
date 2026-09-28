/**
 * The durable inbox: deduplicate first, acknowledge second.
 *
 * Every Paperclip event the bridge subscribes to lands here before anything else happens, and
 * the dedupe key is exactly the identity the protocol names: `source + scope + sourceEventId`
 * (docs/05 §8.1). A duplicate is counted and dropped **before** normalization, so 100 replays
 * of one `issue.assignment_wakeup_requested` produce one row, one start intent and one
 * work-order request (AT-02, AT-26).
 *
 * The write uses `INSERT OR IGNORE` rather than a read-then-write, so two workers racing on
 * the same event cannot both decide it is new. That matters because the host can redeliver an
 * event to a restarted worker while the old worker is still draining.
 */

import type { PluginEvent } from "@paperclipai/plugin-sdk";
import type { BridgeStore, InboxRow } from "../store.js";
import type { BridgeMetrics } from "../metrics.js";
import type { BridgeLogger } from "../logger.js";

/** The source identity recorded for every host event. */
export const HOST_SOURCE = "paperclip";

export type InboxStatus =
  | "received"
  | "ignored"
  | "normalized"
  | "queued"
  | "quarantined"
  | "failed";

export interface InboxOutcome {
  readonly row: InboxRow;
  /** True when this exact event was already recorded; no side effect may follow. */
  readonly duplicate: boolean;
}

export class Inbox {
  readonly #store: BridgeStore;
  readonly #metrics: BridgeMetrics;
  readonly #logger: BridgeLogger;

  constructor(store: BridgeStore, metrics: BridgeMetrics, logger: BridgeLogger) {
    this.#store = store;
    this.#metrics = metrics;
    this.#logger = logger;
  }

  /**
   * Persist an event, or report the duplicate.
   *
   * `projectId` is the trusted project for the event's subject when known. It is recorded so a
   * later read can reconstruct the scope; it is never used to *decide* scope, because the
   * deciding comparison happens against the object the host still holds.
   */
  record(event: PluginEvent, projectId: string | null): InboxOutcome {
    const companyId = event.companyId;
    const { row, duplicate } = this.#store.recordInbox({
      source: HOST_SOURCE,
      companyId,
      projectId: projectId ?? "",
      sourceEventId: event.eventId,
      eventType: event.eventType,
      payload: normalisePayload(event),
      occurredAt: event.occurredAt,
    });
    if (duplicate) {
      this.#metrics.bump(companyId, "inboxDuplicates");
      this.#logger.debug("duplicate event suppressed", {
        eventType: event.eventType,
        sourceEventId: event.eventId,
        companyId,
      });
    }
    return { row, duplicate };
  }

  /**
   * Advance an inbox row's state.
   *
   * Takes the identity rather than the event, because the replay path has a row and a
   * sourceEventId but no live `PluginEvent` in hand.
   */
  mark(
    companyId: string,
    sourceEventId: string,
    status: InboxStatus,
    options: { normalized?: unknown; error?: string | null; bumpAttempts?: boolean } = {},
  ): void {
    this.#store.updateInboxStatus(HOST_SOURCE, companyId, sourceEventId, status, options);
  }

  /**
   * Rows that were recorded but never normalized, e.g. because the worker died mid-handler.
   *
   * The reconciler replays these. Replay is safe because re-normalizing an event produces the
   * same `pf.*` event with the same `sourceEventId`, and the Core dedupes intake on
   * `source + scope + sourceEventId` exactly like the bridge does.
   */
  pendingReplay(companyId: string, limit = 200): InboxRow[] {
    return this.#store.listInboxStatuses(companyId, ["received", "failed"], limit);
  }
}

/**
 * The payload as the bridge stores it.
 *
 * Canonical JSON rather than `JSON.stringify` so a replay of a logically identical event
 * produces the same stored hash, which is what makes the quarantine dedupe meaningful.
 * Undefined values are dropped by the canonical encoder, so an absent field and an absent
 * field-with-undefined are the same row.
 */
function normalisePayload(event: PluginEvent): Record<string, unknown> {
  return {
    eventType: event.eventType,
    entityId: event.entityId ?? null,
    entityType: event.entityType ?? null,
    actorType: event.actorType ?? null,
    occurredAt: event.occurredAt,
    payload: event.payload ?? null,
  };
}
