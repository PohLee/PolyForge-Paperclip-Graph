"""The Requirement graph: intake, clarification, analysis, baseline, requirement gate.

Modelled on the ``Requirement`` row of ``docs/01-REQUIREMENTS.md`` section 7: clarify /
analyze / baseline produce a confirmed requirement with acceptance items, and the family
completes at a requirement gate. The baseline back-edge to ``clarify`` is the declared
rework loop, which is why every node on it carries a ``retryBudget`` — an unbounded cycle
would leave the run with no terminal outcome.
"""

from __future__ import annotations

import copy
from typing import Any, Final

__all__ = ["DEFINITION", "definition"]

_DEFINITION: Final[dict[str, Any]] = {
    "schemaVersion": 1,
    "graphId": "requirement",
    "name": "Requirement",
    "description": (
        "Turns a change intake into a confirmed requirement baseline with acceptance items, "
        "guarded by a human requirement gate."
    ),
    "entrypoints": {
        "requirement.start": {
            "key": "requirement.start",
            "inputs": ["change_intake"],
            "requiresFacts": [],
            "coordinator": {
                "requiredCapabilities": ["requirement.coordinate"],
                "preferredRoles": ["product"],
            },
            "startNodes": ["clarify"],
            "exports": ["clarified_requirements", "analysis_findings", "requirement_baseline", "requirement_acceptance"],
        }
    },
    "nodes": {
        "clarify": {
            "id": "clarify",
            "kind": "agent_operation",
            "operation": {"id": "requirement.clarify", "version": 1},
            "executor": {"requiredCapabilities": ["requirement.clarify"], "preferredRoles": ["product"]},
            "inputs": {"intake": "change_intake"},
            "produces": ["clarified_requirements"],
            "timeoutSeconds": 3600,
            "retryBudget": {"maxAttempts": 2},
        },
        "analyze": {
            "id": "analyze",
            "kind": "agent_operation",
            "operation": {"id": "requirement.analyze", "version": 1},
            "executor": {"requiredCapabilities": ["requirement.analyze"], "preferredRoles": ["product"]},
            "inputs": {"clarified": "clarified_requirements"},
            "produces": ["analysis_findings"],
            "timeoutSeconds": 7200,
            "retryBudget": {"maxAttempts": 2},
        },
        "baseline": {
            "id": "baseline",
            "kind": "agent_operation",
            "operation": {"id": "requirement.baseline", "version": 1},
            "executor": {"requiredCapabilities": ["requirement.baseline"], "preferredRoles": ["product"]},
            "inputs": {"analysis": "analysis_findings"},
            "produces": ["requirement_baseline"],
            "timeoutSeconds": 7200,
            "retryBudget": {"maxAttempts": 2},
        },
        "requirement_gate": {
            "id": "requirement_gate",
            "kind": "gate",
            "evaluatorRefs": ["requirement_completeness_v1", "acceptance_criteria_review_v1"],
            "humanDecision": {"required": True, "semanticKind": "requirement_acceptance"},
            "produces": ["requirement_acceptance"],
            "retryBudget": {"maxAttempts": 2},
        },
    },
    "edges": [
        {"from": "clarify", "to": "analyze"},
        {"from": "analyze", "to": "baseline"},
        {"from": "baseline", "to": "requirement_gate"},
        {"from": "requirement_gate", "to": "clarify", "guard": "rework"},
    ],
    "policyRefs": [
        "policy.deny_precedence",
        "policy.independent_review_before_quality_gate",
        "policy.permission_gate_before_side_effect",
        "policy.human_only_decision_for_gates",
        "policy.budget_and_authority_ceilings",
    ],
}


def definition() -> dict[str, Any]:
    """A fresh copy of the Requirement graph definition.

    A copy per call: callers hand the definition to a validator, an editor, or a store
    that may annotate it, and a shared literal would leak between callers.
    """
    return copy.deepcopy(_DEFINITION)
