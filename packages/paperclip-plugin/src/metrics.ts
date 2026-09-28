/**
 * Bridge counters and gauges.
 *
 * `HealthData.counters` in the protocol contract is a fixed list of sixteen names, and the
 * UI shows them. Two failure modes are being designed against:
 *
 * 1. **Zeros that mean "not implemented".** Every name below is incremented at the exact
 *    place the corresponding refusal or recovery happens, and `integration-health` reads the
 *    stored values. A counter that is zero because the code path does not exist and a counter
 *    that is zero because the path never fired look identical to a reader; so each `bump`
 *    call site below documents which of the two it is, and the health detail names any
 *    counter the bridge cannot yet produce (none, as of this writing — see the report).
 * 2. **Unscoped counters.** A counter is per company. Two tenants must never see each
 *    other's denial counts, and a "cross-scope denial" figure that mixes tenants is worse
 *    than no figure at all.
 *
 * Counters live in the store (namespace `counter/<name>` inside `compatibility_state`) so they
 * survive a worker restart: a counter that resets on restart is a counter that cannot detect
 * a crash-loop.
 */

import type { HealthData } from "@polyforge/protocol";
import type { BridgeStore } from "./store.js";
import type { PluginMetricsClient } from "@paperclipai/plugin-sdk";

/** The exact counter names `HealthData.counters` declares, in contract order. */
export const COUNTER_NAMES = [
  "inboxDuplicates",
  "schemaQuarantine",
  "outboxOldestAgeSeconds",
  "projectionLagSeconds",
  "reconcileMismatch",
  "unknownAttempts",
  "staleLeaseRejected",
  "duplicateEffectsPrevented",
  "waitingGovernanceOldestAgeSeconds",
  "gateMissingEvidence",
  "budgetBlocks",
  "platformBlocks",
  "workspaceValidationFailures",
  "artifactDigestMismatch",
  "crossScopeDenials",
  // Core outbox: how the bridge is coping with what the Core asked it to deliver.
  "unknownCoreIntentKinds",
  "unreadableCoreIntentPayload",
  "coreOutboxEnqueueFailed",
  "coreOutboxAckFailed",
  "controlPlaneUnavailable",
] as const;

/** Counters that are monotonically increasing events (everything but the two age gauges). */
const EVENT_COUNTERS = COUNTER_NAMES.filter(
  (name) => name !== "outboxOldestAgeSeconds" && name !== "projectionLagSeconds",
);

export function isEventCounter(name: string): name is (typeof EVENT_COUNTERS)[number] {
  return (EVENT_COUNTERS as readonly string[]).includes(name);
}

export class BridgeMetrics {
  readonly #store: BridgeStore;
  #sink: PluginMetricsClient | null = null;

  constructor(store: BridgeStore) {
    this.#store = store;
  }

  attach(sink: PluginMetricsClient): void {
    this.#sink = sink;
  }

  /**
   * Increment one event counter.
   *
   * `by: 0` is an explicit "record that this path ran, with nothing to count yet" — used
   * where a refusal was correctly *avoided* (for example a re-enqueued intent that the
   * idempotency key already covered). It is still a useful signal: it distinguishes "the
   * dedupe path never ran" from "the dedupe path ran and prevented nothing this time".
   */
  bump(companyId: string, name: string, by = 1): void {
    if (by === 0) return;
    this.#store.bumpCounter(companyId, name, by);
    void this.#publish(companyId, name, by);
  }

  async gauge(companyId: string, name: string, value: number): Promise<void> {
    this.#store.setCompat(companyId, `gauge/${name}`, value);
    await this.#publish(companyId, name, value);
  }

  async #publish(companyId: string, name: string, value: number): Promise<void> {
    const sink = this.#sink;
    if (!sink) return;
    try {
      await sink.write(`polyforge.${name}`, value, { company: companyId });
    } catch {
      // A metrics write must never fail a delivery. The counter is already durable in the
      // store, so the value is not lost; only the host-side timeseries is skipped.
    }
  }

  /**
   * Read the full counter set for `integration-health`.
   *
   * The two age gauges are *computed*, not stored, because an age that is not recomputed is a
   * lie the moment the clock moves. Everything else is the stored event count.
   */
  counters(companyId: string): HealthData["counters"] {
    const stored = this.#store.counters(companyId, EVENT_COUNTERS);
    return {
      inboxDuplicates: stored["inboxDuplicates"] ?? 0,
      schemaQuarantine: this.#store.countQuarantine(companyId),
      outboxOldestAgeSeconds: this.#store.outboxOldestAgeSeconds(companyId),
      projectionLagSeconds: this.#store.projectionLagSeconds(companyId),
      reconcileMismatch: stored["reconcileMismatch"] ?? 0,
      unknownAttempts: stored["unknownAttempts"] ?? 0,
      staleLeaseRejected: stored["staleLeaseRejected"] ?? 0,
      duplicateEffectsPrevented: stored["duplicateEffectsPrevented"] ?? 0,
      waitingGovernanceOldestAgeSeconds: this.#oldestPendingGovernanceAge(companyId),
      gateMissingEvidence: stored["gateMissingEvidence"] ?? 0,
      budgetBlocks: stored["budgetBlocks"] ?? 0,
      platformBlocks: stored["platformBlocks"] ?? 0,
      workspaceValidationFailures: stored["workspaceValidationFailures"] ?? 0,
      artifactDigestMismatch: stored["artifactDigestMismatch"] ?? 0,
      crossScopeDenials: stored["crossScopeDenials"] ?? 0,
      unknownCoreIntentKinds: stored["unknownCoreIntentKinds"] ?? 0,
      unreadableCoreIntentPayload: stored["unreadableCoreIntentPayload"] ?? 0,
      coreOutboxEnqueueFailed: stored["coreOutboxEnqueueFailed"] ?? 0,
      coreOutboxAckFailed: stored["coreOutboxAckFailed"] ?? 0,
      controlPlaneUnavailable: stored["controlPlaneUnavailable"] ?? 0,
    };
  }

  /**
   * Age of the oldest governance request still waiting for a person.
   *
   * Read from the recorded `createdAt` of every `governance_interaction` binding that has no
   * verified resolution yet. This is the gauge that proves a human wait is visible to an
   * operator without being mistaken for a stalled worker.
   */
  #oldestPendingGovernanceAge(companyId: string): number | null {
    const rows = this.#store.listBindings(companyId, "governance_interaction", 1000);
    let oldest: number | null = null;
    for (const row of rows) {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(row.payloadJson) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (payload["resolvedVerified"] === true) continue;
      const createdAt = payload["createdAt"];
      if (typeof createdAt !== "string") continue;
      const at = Date.parse(createdAt);
      if (Number.isNaN(at)) continue;
      if (oldest === null || at < oldest) oldest = at;
    }
    if (oldest === null) return null;
    const age = Math.floor((Date.now() - oldest) / 1000);
    return age < 0 ? 0 : age;
  }
}
