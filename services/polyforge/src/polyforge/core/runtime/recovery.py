"""Crash and restart reconciliation.

Responsibility: after a process dies, put the durable state back into a state an operator can
reason about — without inventing a success, re-running an effect, or resurrecting a worker
that may still be running.

Invariants (``docs/05-PROTOCOL.md`` section 10, ``docs/02-TECHNICAL-PLAN.md`` sections 7.4
and 10.1):

* **An UNKNOWN effect blocks; it never retries.** Only an authoritative non-occurrence plus a
  fenced prior worker permits another attempt, and neither of those is something recovery can
  assume.
* **An expired lease becomes UNKNOWN, not READY.** Expiry means "check". A replacement worker
  is only admissible once the platform confirms the old one stopped, so recovery fences the
  attempt and blocks the node rather than queueing a new dispatch.
* **Committed work is never re-executed.** Recovery only reads committed state, repairs
  derived state, and blocks what it cannot prove. An effect already recorded ``EFFECTED``
  stays effected; the projection is retried, not the work.
* Everything it does is idempotent, so running recovery twice changes nothing the second time.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from polyforge.core.state import AttemptStatus, BlockReason, GraphRunStatus, NodeStatus
from polyforge.core.store.db import dumps
from polyforge.core.store.models import EffectStatus

__all__ = ["EffectReconciliation", "LeaseReconciliation", "RecoveryReport", "recover_runtime"]


@dataclass(frozen=True)
class EffectReconciliation:
    effect_key: str
    run_id: str
    status: str
    action: str
    may_retry: bool
    advisory: str


@dataclass(frozen=True)
class LeaseReconciliation:
    attempt_id: str
    run_id: str
    node_id: str
    lease_epoch: int
    prior_worker_state: str
    action: str


@dataclass(frozen=True)
class RecoveryReport:
    effects: list[EffectReconciliation] = field(default_factory=list)
    leases: list[LeaseReconciliation] = field(default_factory=list)
    outbox: list[dict[str, Any]] = field(default_factory=list)
    nodes_blocked: int = 0
    runs_blocked: list[str] = field(default_factory=list)

    def to_wire(self) -> dict[str, Any]:
        return {
            "effects": [
                {
                    "effectKey": e.effect_key,
                    "runId": e.run_id,
                    "status": e.status,
                    "action": e.action,
                    "mayRetry": e.may_retry,
                    "advisory": e.advisory,
                }
                for e in self.effects
            ],
            "leases": [
                {
                    "attemptId": l.attempt_id,
                    "runId": l.run_id,
                    "nodeId": l.node_id,
                    "leaseEpoch": l.lease_epoch,
                    "priorWorkerState": l.prior_worker_state,
                    "action": l.action,
                }
                for l in self.leases
            ],
            "outbox": self.outbox,
            "nodesBlocked": self.nodes_blocked,
            "runsBlocked": self.runs_blocked,
        }


def _reconcile_effects(engine: Any) -> tuple[list[EffectReconciliation], set[tuple[str, str]]]:
    """Move every non-terminal or unknown effect to a state that is safe to reason about."""
    reconciled: list[EffectReconciliation] = []
    blocked_nodes: set[tuple[str, str]] = set()
    rows = engine.db.query(
        "SELECT * FROM effect_records WHERE status IN (?, ?)",
        (EffectStatus.UNKNOWN, EffectStatus.PENDING),
    )
    now = engine._now()
    for row in rows:
        run_id = str(row["run_id"])
        key = str(row["effect_key"])
        scope = (str(row["company_ref"]), str(row["project_ref"]))
        if str(row["status"]) == EffectStatus.PENDING:
            # A PENDING effect means the process died between "asked" and "answered". There is
            # no receipt, so there is no evidence of occurrence: it becomes UNKNOWN, which
            # blocks. Recovery must not assume the worst *or* the best.
            engine.effects.mark_unknown(
                company_ref=scope[0],
                project_ref=scope[1],
                run_id=run_id,
                key=key,
                reason="the Core restarted while this effect was in flight; no receipt was recorded, "
                "so its outcome must be reconciled authoritatively before any retry",
            )
            action = "marked_unknown"
        else:
            action = "held_blocked"
        may_retry = engine.effects.may_retry(row)
        reconciled.append(
            EffectReconciliation(
                effect_key=key,
                run_id=run_id,
                status=str(row["status"]),
                action=action,
                may_retry=may_retry,
                advisory=engine.effects.retry_advisory(row),
            )
        )
        node_id = row["node_id"]
        if node_id:
            blocked_nodes.add((run_id, str(node_id)))
    if blocked_nodes:
        for run_id, node_id in sorted(blocked_nodes):
            engine.db.execute(
                "UPDATE node_executions SET status = ?, block_reason = ?, wait_reason = ?,"
                " updated_at = ? WHERE run_id = ? AND node_id = ? AND status NOT IN ('PASSED','SKIPPED')",
                (
                    NodeStatus.BLOCKED,
                    str(BlockReason.EFFECT_UNKNOWN),
                    "an external effect outcome is unknown; only an authoritative non-occurrence "
                    "permits another attempt",
                    now,
                    run_id,
                    node_id,
                ),
            )
    return reconciled, blocked_nodes


def _reconcile_leases(engine: Any) -> tuple[list[LeaseReconciliation], set[tuple[str, str]]]:
    """Fence expired leases. A new worker is only admissible on a confirmed stop."""
    reconciled: list[LeaseReconciliation] = []
    blocked_nodes: set[tuple[str, str]] = set()
    now = engine._now()
    rows = engine.db.query(
        "SELECT * FROM execution_attempts WHERE lease_state = 'ACTIVE'"
        " AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?"
        " AND status IN ('PREPARED','RUNNING','CHECKPOINTED')",
        (now,),
    )
    for row in rows:
        run_id = str(row["run_id"])
        node_id = str(row["node_id"])
        # The old worker may still be executing. Fence it and block the node; do not hand the
        # work to anyone else until the platform says the worker is gone.
        engine.db.execute(
            "UPDATE execution_attempts SET lease_state = 'EXPIRED', status = ?, updated_at = ?"
            " WHERE attempt_id = ?",
            (AttemptStatus.UNKNOWN, now, str(row["attempt_id"])),
        )
        engine.db.execute(
            "UPDATE node_executions SET status = ?, block_reason = ?, active_attempt_id = NULL,"
            " wait_reason = ?, updated_at = ? WHERE run_id = ? AND node_id = ?",
            (
                NodeStatus.BLOCKED,
                str(BlockReason.LEASE_FENCED),
                "the previous worker's lease expired without a stop confirmation; a replacement "
                "attempt is admissible only once the platform confirms it is stopped or fenced",
                now,
                run_id,
                node_id,
            ),
        )
        engine._emit(
            run_id,
            "pf.execution.unknown",
            {
                "nodeId": node_id,
                "attemptId": str(row["attempt_id"]),
                "leaseEpoch": int(row["lease_epoch"]),
                "reason": "lease expired during recovery; the worker may still be running",
            },
        )
        blocked_nodes.add((run_id, node_id))
        reconciled.append(
            LeaseReconciliation(
                attempt_id=str(row["attempt_id"]),
                run_id=run_id,
                node_id=node_id,
                lease_epoch=int(row["lease_epoch"]),
                prior_worker_state="unknown",
                action="fenced_and_blocked",
            )
        )
    return reconciled, blocked_nodes


def _reconcile_outbox(engine: Any) -> list[dict[str, Any]]:
    """Return stuck deliveries to the queue, or stop after the attempt ceiling.

    Bounded exponential backoff with jitter between attempts, per the failure-handling rules.
    A crashed delivery is a redelivery, never a re-execution: the intent carries the same
    correlation key, so the platform side is create-or-get.
    """
    import random

    now = engine._now()
    requeued: list[dict[str, Any]] = []
    rows = engine.db.query(
        "SELECT * FROM outbox_intents WHERE state IN ('CLAIMED','QUEUED')"
        " AND claim_owner IS NOT NULL AND claim_expires_at IS NOT NULL"
        " AND claim_expires_at <= ?",
        (now,),
    )
    for row in rows:
        attempts = int(row["delivery_attempts"])
        ceiling = int(row["max_delivery_attempts"])
        if attempts >= ceiling:
            engine.db.execute(
                "UPDATE outbox_intents SET state = 'BLOCKED', claim_owner = NULL,"
                " claim_expires_at = NULL, error_json = ?, updated_at = ? WHERE intent_id = ?",
                (
                    dumps({"reason": "delivery attempts exhausted during recovery"}),
                    now,
                    str(row["intent_id"]),
                ),
            )
            if row["run_id"]:
                engine._emit(
                    str(row["run_id"]),
                    "pf.run.blocked",
                    {
                        "intentId": str(row["intent_id"]),
                        "blockReason": str(BlockReason.PLATFORM),
                        "code": "OUTBOX_DELIVERY_EXHAUSTED",
                        "message": (
                            f"intent {row['intent_id']} exhausted {ceiling} delivery attempts; it is "
                            "stopped for an operator rather than retried forever"
                        ),
                    },
                )
            requeued.append(
                {
                    "intentId": str(row["intent_id"]),
                    "state": "BLOCKED",
                    "deliveryAttempts": attempts,
                    "reason": "attempt ceiling reached",
                }
            )
            continue
        delay = min(300, 2 ** min(attempts, 8)) + random.uniform(0, 1)
        engine.db.execute(
            "UPDATE outbox_intents SET state = 'QUEUED', claim_owner = NULL,"
            " claim_expires_at = NULL, next_attempt_at = ?, updated_at = ? WHERE intent_id = ?",
            (engine._later(delay), now, str(row["intent_id"])),
        )
        requeued.append(
            {
                "intentId": str(row["intent_id"]),
                "state": "QUEUED",
                "deliveryAttempts": attempts,
                "retryInSeconds": round(delay, 3),
                "reason": "claim expired before a delivery report arrived",
            }
        )
    return requeued


def recover_runtime(engine: Any) -> RecoveryReport:
    """Run every reconciliation pass and report exactly what was reconciled."""
    effects, effect_nodes = _reconcile_effects(engine)
    leases, lease_nodes = _reconcile_leases(engine)
    outbox = _reconcile_outbox(engine)
    blocked_nodes = effect_nodes | lease_nodes
    now = engine._now()
    runs_blocked: list[str] = []
    for run_id, node_id in sorted(blocked_nodes):
        row = engine.db.query_one("SELECT * FROM graph_runs WHERE run_id = ?", (run_id,))
        if row is None:
            continue
        if str(row["status"]) not in (
            GraphRunStatus.COMPLETED,
            GraphRunStatus.FAILED,
            GraphRunStatus.CANCELLED,
        ):
            engine.db.execute(
                "UPDATE graph_runs SET status = ?, block_reason = ?, updated_at = ?"
                " WHERE run_id = ?",
                (str(GraphRunStatus.BLOCKED), str(BlockReason.EFFECT_UNKNOWN), now, run_id),
            )
            if run_id not in runs_blocked:
                runs_blocked.append(run_id)
    if runs_blocked or blocked_nodes:
        # One state-version bump for the recovery pass, so a client polling for changes
        # notices that the run's status moved without pretending the work moved.
        for run_id in sorted({r for r, _ in blocked_nodes}):
            engine._bump(run_id)
    return RecoveryReport(
        effects=effects,
        leases=leases,
        outbox=outbox,
        nodes_blocked=len(blocked_nodes),
        runs_blocked=runs_blocked,
    )
