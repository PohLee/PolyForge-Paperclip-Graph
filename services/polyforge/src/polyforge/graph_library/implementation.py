"""The Implementation graph: plan, parallel backend/frontend branches, join, review, gate.

Both branches are real, independent work, so they join with ``all`` semantics: neither may
be declared done by the presence of the other. The review node declares
``independentFrom: ["code.producer"]`` so the reviewer cannot be the author of the change,
and the gate back-edge to the plan is the declared rework loop.

Every node on that loop, including the deterministic join, carries a ``retryBudget`` so
the run always reaches a terminal outcome within the catalog ceiling.
"""

from __future__ import annotations

import copy
from typing import Any, Final

__all__ = ["DEFINITION", "definition"]

_DEFINITION: Final[dict[str, Any]] = {
    "schemaVersion": 1,
    "graphId": "implementation",
    "name": "Implementation",
    "description": (
        "Implementation plan, parallel backend and frontend work joined with all-semantics, "
        "independent implementation review, then the implementation gate."
    ),
    "entrypoints": {
        "implementation.start": {
            "key": "implementation.start",
            "inputs": ["design_acceptance"],
            "requiresFacts": ["design_gate_passed"],
            "coordinator": {
                "requiredCapabilities": ["implementation.coordinate"],
                "preferredRoles": ["tech_lead"],
                "fallbackRoles": ["engineering_manager"],
            },
            "startNodes": ["implementation_plan"],
            "exports": [
                "backend_commit",
                "unit_test_report",
                "frontend_commit",
                "ui_test_report",
                "test_report",
                "code_review",
                "review_findings",
                "implementation_acceptance",
            ],
        }
    },
    "nodes": {
        "implementation_plan": {
            "id": "implementation_plan",
            "kind": "agent_operation",
            "operation": {"id": "implementation.plan", "version": 1},
            "executor": {
                "requiredCapabilities": ["implementation.plan"],
                "preferredRoles": ["tech_lead"],
            },
            "inputs": {"design": "design_acceptance"},
            "produces": ["implementation_plan"],
            "timeoutSeconds": 10800,
            "retryBudget": {"maxAttempts": 2},
        },
        "backend_impl": {
            "id": "backend_impl",
            "kind": "agent_operation",
            "operation": {"id": "code.modify", "version": 2},
            "executor": {
                "requiredCapabilities": ["code.modify"],
                "preferredRoles": ["backend_engineer"],
            },
            "inputs": {"plan": "implementation_plan"},
            "produces": ["backend_commit", "unit_test_report"],
            "timeoutSeconds": 28800,
            "retryBudget": {"maxAttempts": 3},
        },
        "frontend_impl": {
            "id": "frontend_impl",
            "kind": "agent_operation",
            "operation": {"id": "code.modify", "version": 2},
            "executor": {
                "requiredCapabilities": ["code.modify"],
                "preferredRoles": ["frontend_engineer"],
            },
            "inputs": {"plan": "implementation_plan"},
            "produces": ["frontend_commit", "ui_test_report"],
            "timeoutSeconds": 28800,
            "retryBudget": {"maxAttempts": 3},
        },
        "implementation_join": {
            "id": "implementation_join",
            "kind": "deterministic",
            "join": {"semantics": "all", "inputs": ["backend_impl", "frontend_impl"]},
            "produces": ["candidate_artifact_set"],
            "retryBudget": {"maxAttempts": 2},
        },
        "implementation_review": {
            "id": "implementation_review",
            "kind": "agent_operation",
            "operation": {"id": "implementation.review", "version": 1},
            "executor": {
                "requiredCapabilities": ["implementation.review"],
                "preferredRoles": ["staff_engineer"],
                "independentFrom": ["code.producer"],
            },
            "inputs": {"candidates": "candidate_artifact_set"},
            "produces": ["review_findings", "code_review", "test_report"],
            "timeoutSeconds": 14400,
            "retryBudget": {"maxAttempts": 2},
        },
        "implementation_gate": {
            "id": "implementation_gate",
            "kind": "gate",
            "evaluatorRefs": ["test_report_check_v1", "review_findings_check_v1"],
            "humanDecision": {"required": True, "semanticKind": "implementation_acceptance"},
            "requires": ["candidate_artifact_set"],
            "produces": ["implementation_acceptance"],
            "retryBudget": {"maxAttempts": 2},
        },
    },
    "edges": [
        {"from": "implementation_plan", "to": "backend_impl"},
        {"from": "implementation_plan", "to": "frontend_impl"},
        {"from": "backend_impl", "to": "implementation_join"},
        {"from": "frontend_impl", "to": "implementation_join"},
        {"from": "implementation_join", "to": "implementation_review"},
        {"from": "implementation_review", "to": "implementation_gate"},
        {"from": "implementation_gate", "to": "implementation_plan", "guard": "rework"},
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
    """A fresh copy of the Implementation graph definition."""
    return copy.deepcopy(_DEFINITION)
