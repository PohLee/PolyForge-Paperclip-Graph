"""Gates: typed evaluators and their aggregation.

A gate is the only thing that may turn "work finished" into "this node passed". It is a
closed set of evaluators plus one aggregation rule set, and both fail towards
``ESCALATE`` rather than towards ``PASS``.
"""

from __future__ import annotations

from polyforge.core.gates.aggregate import AggregatedGate, GateResult, aggregate_gate
from polyforge.core.gates.evaluators import (
    BUILTIN_EVALUATOR_REFS,
    EvaluationContext,
    Evaluator,
    EvaluatorRegistry,
    EvaluatorResult,
    default_registry,
)

__all__ = [
    "BUILTIN_EVALUATOR_REFS",
    "AggregatedGate",
    "EvaluationContext",
    "Evaluator",
    "EvaluatorRegistry",
    "EvaluatorResult",
    "GateResult",
    "aggregate_gate",
    "default_registry",
]
