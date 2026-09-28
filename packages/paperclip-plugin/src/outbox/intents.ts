/**
 * Outbox intent vocabulary.
 *
 * An *intent* is the bridge's durable statement that it intends to cause one specific
 * external effect. Its identity is the `effectKey`, and the rule from docs/05 §8.1 applies
 * without exception: the key is derived from the business identity (scope, run, node,
 * iteration, step, target hash) and **never** from a per-attempt random id or a bare attempt
 * number. Two different callers that mean the same effect therefore converge on one row, and
 * a retry can never duplicate the effect.
 *
 * Kinds are grouped by the failure discipline they imply:
 *
 * * `kind: "write"` — a mutation. Backoff is exponential with jitter, the attempt counter is
 *   the *network redelivery* budget, and exhausting it is a permanent `failed`.
 * * `kind: "human_gate"` — an intent whose next step belongs to a person. The pump leaves
 *   these alone entirely, so waiting three days for a human decision costs zero network
 *   attempts and zero engineering rework budget.
 * * `kind: "read"` — a reconciliation read. Never retried aggressively; it runs on the
 *   reconcile job's cadence.
 */

import { stableIdempotencyKey } from "@polyforge/protocol";
import type { Scope } from "@polyforge/protocol";

export const INTENT_KINDS = {
  /** Create the WorkOrder/GraphRun for a Root Issue start intent. */
  workOrderCreate: "work_order.create",
  /** Hand a normalized `pf.*` observation to the Core's event intake. */
  eventIntake: "event.intake",
  /** Materialize (or re-find) the child Issue for a node execution. */
  workUnitEnsure: "work_unit.ensure",
  /** Assign the resolved worker and request a platform wakeup. */
  workUnitDispatch: "work_unit.dispatch",
  /** Project engineering status onto the child Issue. */
  workUnitProjectStatus: "work_unit.project_status",
  /** Ask the platform to stop an execution and report what it can confirm. */
  executionRequestStop: "execution.request_stop",
  /** Inspect an execution and report an observation. Never asserts success. */
  executionInspect: "execution.inspect",
  /** Create the human-only Interaction that carries an engineering decision. */
  governanceInteractionCreate: "governance.interaction.create",
  /** Hand a re-read, hash-matched governance resolution to the Core. */
  governanceRecordResolution: "governance.record_resolution",
  /** Check a granted authorization against one exact action. */
  authorizationCheck: "authorization.check",
  /** Publish or re-read one artifact by content hash. */
  artifactPublish: "artifact.publish",
  /** Acknowledge one Core outbox delivery after its effect is durably applied. */
  coreDeliveryAck: "core.delivery_ack",
  /** Record a committed Core migration and its successor run in the bridge store. */
  migrationApplied: "migration.applied",
} as const;
export type IntentKind = (typeof INTENT_KINDS)[keyof typeof INTENT_KINDS];

/**
 * The Core's outbound intent kinds, and the bridge intent each one becomes.
 *
 * The two vocabularies are deliberately not merged. The Core's names are dotted and domain-level
 * (`work.unit.ensure`); the bridge's are its own (`work_unit.ensure`). Collapsing them into one
 * constant would make it look like a renaming exercise when it is not: the Core emits an intent, the
 * bridge has to decide which *port call* realises it, and that decision is the whole content of the
 * mapping. A kind with no entry here is refused rather than guessed at — silently dropping an
 * unknown kind would let a new Core intent disappear without a trace, which is the failure mode this
 * table exists to prevent.
 */
export const CORE_INTENT_KINDS = {
  "work.unit.ensure": INTENT_KINDS.workUnitEnsure,
  "work.dispatch": INTENT_KINDS.workUnitDispatch,
  "work.stop": INTENT_KINDS.executionRequestStop,
  "status.project": INTENT_KINDS.workUnitProjectStatus,
  "governance.request": INTENT_KINDS.governanceInteractionCreate,
  "governance.decision": INTENT_KINDS.governanceRecordResolution,
  "governance.authorization": INTENT_KINDS.authorizationCheck,
  "artifact.publish": INTENT_KINDS.artifactPublish,
  "effect.deliver": INTENT_KINDS.coreDeliveryAck,
  "migration.applied": INTENT_KINDS.migrationApplied,
} as const satisfies Record<string, IntentKind>;

export type CoreIntentKind = keyof typeof CORE_INTENT_KINDS;

/** The bridge intent a Core intent realises, or `null` when this build does not carry it. */
export function bridgeIntentFor(coreKind: string): IntentKind | null {
  const mapped = (CORE_INTENT_KINDS as Record<string, IntentKind>)[coreKind];
  return mapped ?? null;
}

/** Every Core kind this build knows how to deliver. Anything else is refused and counted. */
export function knownCoreIntentKinds(): readonly string[] {
  return Object.keys(CORE_INTENT_KINDS);
}

export type IntentClass = "write" | "human_gate" | "read";

/**
 * Which class each kind belongs to.
 *
 * `governance.interaction.create` is `human_gate` *after* it is observed: the create itself
 * is a write the pump performs once, and the state that then waits is a human decision. The
 * pump therefore performs the create and then leaves the row `observed` for the reconciler.
 */
const INTENT_CLASS: Record<IntentKind, IntentClass> = {
  [INTENT_KINDS.workOrderCreate]: "write",
  [INTENT_KINDS.eventIntake]: "write",
  [INTENT_KINDS.workUnitEnsure]: "write",
  [INTENT_KINDS.workUnitDispatch]: "write",
  [INTENT_KINDS.workUnitProjectStatus]: "write",
  [INTENT_KINDS.executionRequestStop]: "write",
  [INTENT_KINDS.executionInspect]: "read",
  // Creating the interaction is a platform write. The human gate starts only after this handler
  // has durably created the object a person can answer.
  [INTENT_KINDS.governanceInteractionCreate]: "write",
  [INTENT_KINDS.governanceRecordResolution]: "write",
  [INTENT_KINDS.authorizationCheck]: "read",
  [INTENT_KINDS.artifactPublish]: "write",
  [INTENT_KINDS.coreDeliveryAck]: "write",
  [INTENT_KINDS.migrationApplied]: "write",
};

export function intentClass(kind: string): IntentClass {
  return INTENT_CLASS[kind as IntentKind] ?? "write";
}

export interface OutboxIntent {
  readonly kind: IntentKind;
  readonly scope: Scope;
  readonly effectKey: string;
  readonly correlationId: string;
  readonly runId?: string | null;
  readonly nodeId?: string | null;
  readonly payload: unknown;
  /** Force the first attempt at a specific time; used by the reconciler, not by event intake. */
  readonly notBefore?: string;
}

// ---------------------------------------------------------------------------
// Effect keys
//
// Every key includes the company, so two tenants can never collide on one row even when
// their run ids, node ids and iteration numbers happen to be identical.
// ---------------------------------------------------------------------------

/** `scope + startIntentId + entrypoint` (docs/05 §8.1, first admission). */
export function workOrderEffectKey(scope: Scope, startIntentId: string, entrypoint: string): string {
  return stableIdempotencyKey(["pf.work-order", scope.companyRef, scope.projectRef, startIntentId, entrypoint]);
}

/** `source + scope + sourceEventId` (event intake). */
export function eventIntakeEffectKey(scope: Scope, sourceEventId: string): string {
  return stableIdempotencyKey(["pf.event", scope.companyRef, scope.projectRef, sourceEventId]);
}

/** `scope + run + node + iteration` (external work unit). */
export function workUnitEffectKey(scope: Scope, runId: string, nodeId: string, iteration: number): string {
  return stableIdempotencyKey(["pf.work-unit", scope.companyRef, scope.projectRef, runId, nodeId, String(iteration)]);
}

/** External effect: `transitionHash + stepId + targetHash` (docs/05 §8.1). */
export function effectKey(parts: readonly string[]): string {
  return stableIdempotencyKey(["pf.effect", ...parts]);
}

/** Governance request: `transitionHash + semanticGateOrActionId + exactTargetHash`. */
export function governanceEffectKey(transitionHash: string, semanticKind: string, decisionTargetHash: string): string {
  return stableIdempotencyKey(["pf.governance", transitionHash, semanticKind, decisionTargetHash]);
}

/** Projection: `targetRef + projectionSequence`. */
export function projectionEffectKey(targetRef: string, projectionSequence: number): string {
  return stableIdempotencyKey(["pf.projection", targetRef, String(projectionSequence)]);
}
