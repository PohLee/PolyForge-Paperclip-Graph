import type { BridgeLogger } from "../logger.js";
import type { BridgeMetrics } from "../metrics.js";
import type { BridgeStore } from "../store.js";
import type { Scope } from "@polyforge/protocol";
import { bridgeIntentFor, effectKey, knownCoreIntentKinds, type IntentKind } from "./intents.js";
import { mapCoreIntentPayload } from "./core-intent-mapping.js";
import type { CoreOutboxIntent, RuntimeClient } from "../runtime-client.js";

/**
 * Consume the Core's outbound queue.
 *
 * This is the missing half of the delivery chain. The Core enqueues `work.unit.ensure` the moment a
 * node becomes READY, and it never calls the platform itself, so an intent nobody claims is a node
 * that never gets an Issue and never gets worked. The bridge's own `OutboxPump` was draining the
 * bridge's queue the whole time and reporting healthy, which is how this stayed invisible.
 *
 * The loop, per claim:
 *
 *   claim -> map the kind -> persist as a bridge intent -> let the bridge's own pump deliver it
 *         -> acknowledge to the Core
 *
 * The acknowledgement comes last and is derived from the *bridge's* outcome, never from the fact
 * that this loop ran. Telling the Core an intent was `sent` because it was written to a local queue
 * would move a durable obligation into a memory.
 *
 * Idempotence is keyed on the Core's `intentId`, so a claim that is retried after a crash between
 * "persisted" and "acknowledged" produces the same bridge intent rather than a second one.
 */

export interface CoreOutboxDeps {
  readonly client: RuntimeClient;
  readonly store: BridgeStore;
  readonly logger: BridgeLogger;
  readonly metrics: BridgeMetrics;
  readonly actor: { actorType: "system"; actorId: string; roles: string[] };
  /** How many intents to claim per pass. */
  readonly batchSize?: number;
  /**
   * Enqueue one bridge intent. Returns false when the effect key already exists.
   *
   * The shape is the `OutboxPump`'s own `begin`, so the Core's intent lands in exactly the queue the
   * bridge already drains, with the same idempotence and the same durable-before-effect ordering.
   */
  readonly begin: (intent: {
    effectKey: string;
    kind: IntentKind;
    scope: Scope;
    correlationId: string;
    payload: Record<string, unknown>;
    runId?: string | null;
    nodeId?: string | null;
  }) => boolean;
}

export interface CoreOutboxPassResult {
  readonly claimed: number;
  /** Enqueued as a new bridge intent. */
  readonly enqueued: number;
  /** Already present: a re-claim, or a crash between persisting and acknowledging. */
  readonly duplicates: number;
  /** The Core asked for something this build does not carry. Refused, never guessed. */
  readonly unknownKinds: readonly string[];
  readonly acknowledged: number;
  readonly failed: number;
  readonly leaseSeconds: number;
}

export class CoreOutboxPump {
  readonly #deps: CoreOutboxDeps;
  readonly #batchSize: number;

  constructor(deps: CoreOutboxDeps) {
    this.#deps = deps;
    this.#batchSize = deps.batchSize ?? 50;
  }

  /**
   * One pass. Never throws for a per-intent problem: one unhandled intent must not stop the rest of
   * the queue, and the next pass re-claims anything left unacknowledged.
   */
  async run(scope: Scope): Promise<CoreOutboxPassResult> {
    const { client, logger, metrics } = this.#deps;
    let batch;
    try {
      batch = await client.drainOutbox(this.#deps.actor, scope, { limit: this.#batchSize });
    } catch (error) {
      // The Core being unreachable is the one failure that affects the whole pass. Counted, logged,
      // and rethrown as a normal error so the caller's schedule simply tries again later.
      metrics.bump(scope.companyRef, "controlPlaneUnavailable", 1);
      logger.warn("could not claim the Core's outbound intents", {
        company: scope.companyRef,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        claimed: 0,
        enqueued: 0,
        duplicates: 0,
        unknownKinds: [],
        acknowledged: 0,
        failed: 0,
        leaseSeconds: 0,
      };
    }

    const unknownKinds: string[] = [];
    const refused: string[] = [];
    let enqueued = 0;
    let duplicates = 0;
    let acknowledged = 0;
    let failed = 0;

    for (const intent of batch.intents) {
      const mapped = bridgeIntentFor(intent.kind);
      if (mapped === null) {
        // Refused, and reported. Dropping it quietly would let a Core intent this build cannot
        // honour disappear with no trace; acking it would tell the Core it was delivered when it
        // was not. It is left unacknowledged so the lease expires and it is claimed again once
        // this build knows what it means.
        unknownKinds.push(intent.kind);
        metrics.bump(scope.companyRef, "unknownCoreIntentKinds", 1);
        logger.warn("the Core asked for an intent kind this build does not carry", {
          kind: intent.kind,
          intentId: intent.intentId,
          known: knownCoreIntentKinds(),
        });
        continue;
      }

      // Per-kind mapping. Core messages and provider-neutral port DTOs use different field names
      // for work units, projections, governance requests and stop targets; authenticated scope and
      // correlation data are supplied from the claimed envelope rather than trusted from payload.
      let mappedPayload: Record<string, unknown>;
      try {
        mappedPayload = {
          ...mapCoreIntentPayload(intent.kind, intent.payload, {
            scope,
            correlationId: intent.correlationKey,
          }),
          coreIntentId: intent.intentId,
          coreKind: intent.kind,
        };
      } catch (error) {
        // Refused, and left unacknowledged. Acking it would tell the Core it was delivered when no
        // work unit was ever created; failing it would discard an obligation the Core still owns.
        // Unacknowledged is the only honest state: the lease expires and a build that can read the
        // intent will claim it again.
        refused.push(intent.kind);
        metrics.bump(scope.companyRef, "unreadableCoreIntentPayload", 1);
        logger.error("the Core sent an intent payload this build cannot read", {
          intentId: intent.intentId,
          kind: intent.kind,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      try {
        const created = this.#deps.begin({
          // Keyed on the Core's intent id, so a re-claim is a duplicate rather than a second intent.
          effectKey: effectKey(["core.outbox", scope.companyRef, intent.intentId]),
          kind: mapped,
          scope,
          correlationId: intent.correlationKey,
          payload: mappedPayload,
          runId: intent.runId,
          nodeId: intent.nodeId,
        });
        if (created) {
          enqueued += 1;
        } else {
          duplicates += 1;
        }
      } catch (error) {
        // The intent could not be made durable. That is a `failed` acknowledgement, not a `sent`
        // one: the Core must know it still owns the obligation.
        failed += 1;
        metrics.bump(scope.companyRef, "coreOutboxEnqueueFailed", 1);
        logger.error("could not persist a Core intent as a bridge intent", {
          intentId: intent.intentId,
          kind: intent.kind,
          error: error instanceof Error ? error.message : String(error),
        });
        await this.acknowledge(scope, intent, "failed", {
          error: { code: "BRIDGE_STORE_UNAVAILABLE", message: "the intent could not be made durable" },
        });
        continue;
      }

      // Persisted. `sent` is the honest word here: the Core's obligation has moved into the
      // bridge's durable queue, and the outcome of the actual platform effect is reported later by
      // the bridge's own delivery record, not here.
      const acked = await this.acknowledge(scope, intent, "sent", { enqueued: true });
      if (acked) acknowledged += 1;
    }

    logger.debug("claimed the Core's outbound intents", {
      company: scope.companyRef,
      claimed: batch.intents.length,
      enqueued,
      duplicates,
      unknown: unknownKinds.length,
    });

    return {
      claimed: batch.intents.length,
      enqueued,
      duplicates,
      unknownKinds,
      acknowledged,
      failed,
      leaseSeconds: batch.leaseSeconds,
    };
  }

  /** Acknowledge one intent. A failure to acknowledge is logged, never fatal: the lease expires. */
  async acknowledge(
    scope: Scope,
    intent: CoreOutboxIntent,
    state: "sent" | "failed",
    extra: Record<string, unknown>,
  ): Promise<boolean> {
    try {
      await this.#deps.client.markDelivery(this.#deps.actor, scope, intent.intentId, {
        state,
        receipt: { ...extra, deliveryAttempt: intent.deliveryAttempt },
      });
      return true;
    } catch (error) {
      this.#deps.metrics.bump(scope.companyRef, "coreOutboxAckFailed", 1);
      this.#deps.logger.warn("could not acknowledge a Core intent; its lease will expire", {
        intentId: intent.intentId,
        state,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }
}
