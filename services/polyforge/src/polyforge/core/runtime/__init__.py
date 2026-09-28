"""Runtime: runs, claims, checkpoints, effects, planning, and recovery.

The engine is the only writer of engineering state. Everything in this package is either a
pure function over a plan and a state (the planner, the effect ledger's retry rule) or a
component the engine calls inside a single transaction.
"""

from __future__ import annotations

from polyforge.core.runtime.effects import (
    EFFECT_KEY_DOMAIN,
    RETRYABLE_PRIOR_WORKER_STATES,
    EffectAuthority,
    EffectLedger,
    effect_key,
)
from polyforge.core.runtime.engine import OUTBOX_KINDS, RuntimeEngine
from polyforge.core.runtime.planner import (
    PLAN_HASH_DOMAIN,
    ExecutionPlan,
    NodeDecision,
    PlanNode,
    build_plan,
    compute_plan_hash,
    evaluate_guard,
    plan_states,
)
from polyforge.core.runtime.recovery import RecoveryReport, recover_runtime

__all__ = [
    "EFFECT_KEY_DOMAIN",
    "OUTBOX_KINDS",
    "PLAN_HASH_DOMAIN",
    "RETRYABLE_PRIOR_WORKER_STATES",
    "EffectAuthority",
    "EffectLedger",
    "ExecutionPlan",
    "NodeDecision",
    "PlanNode",
    "RecoveryReport",
    "RuntimeEngine",
    "build_plan",
    "compute_plan_hash",
    "effect_key",
    "evaluate_guard",
    "plan_states",
    "recover_runtime",
]
