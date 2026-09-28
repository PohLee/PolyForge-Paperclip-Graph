"""The Verification graph: qa, independent security review and regression in parallel.

All three branches must report before acceptance is decided, so the join is ``all``. The
security review branch keeps its independence constraint from the implementation phase, and
acceptance is a human decision: no amount of green CI is an acceptance.
"""

from __future__ import annotations

import copy
from typing import Any, Final

__all__ = ["DEFINITION", "definition"]

_DEFINITION: Final[dict[str, Any]] = {
    "schemaVersion": 1,
    "graphId": "verification",
    "name": "Verification",
    "description": (
        "Independent qa, security review and regression evidence over a pinned candidate, "
        "joined with all-semantics, then a human acceptance gate."
    ),
    "entrypoints": {
        "verification.start": {
            "key": "verification.start",
            "inputs": ["implementation_acceptance"],
            "requiresFacts": ["implementation_gate_passed"],
            "coordinator": {
                "requiredCapabilities": ["verification.coordinate"],
                "preferredRoles": ["qa"],
                "fallbackRoles": ["staff_engineer"],
            },
            "startNodes": ["qa_execute", "security_review_verify", "regression_run"],
            "exports": [
                "qa_report",
                "security_review_report",
                "regression_report",
                "verification_evidence_set",
                "acceptance_decision",
            ],
        }
    },
    "nodes": {
        "qa_execute": {
            "id": "qa_execute",
            "kind": "agent_operation",
            "operation": {"id": "qa.execute", "version": 2},
            "executor": {"requiredCapabilities": ["qa.execute"], "preferredRoles": ["qa"]},
            "inputs": {"candidate": "implementation_acceptance"},
            "produces": ["qa_report"],
            "timeoutSeconds": 28800,
            "retryBudget": {"maxAttempts": 2},
        },
        "security_review_verify": {
            "id": "security_review_verify",
            "kind": "agent_operation",
            "operation": {"id": "security.review", "version": 2},
            "executor": {
                "requiredCapabilities": ["security.review"],
                "preferredRoles": ["security"],
                "independentFrom": ["code.producer"],
            },
            "inputs": {"candidate": "implementation_acceptance"},
            "produces": ["security_review_report"],
            "timeoutSeconds": 14400,
            "retryBudget": {"maxAttempts": 2},
        },
        "regression_run": {
            "id": "regression_run",
            "kind": "agent_operation",
            "operation": {"id": "regression.execute", "version": 1},
            "executor": {
                "requiredCapabilities": ["regression.execute", "qa.execute"],
                "preferredRoles": ["qa"],
            },
            "inputs": {"candidate": "implementation_acceptance"},
            "produces": ["regression_report"],
            "timeoutSeconds": 43200,
            "retryBudget": {"maxAttempts": 2},
        },
        "verification_join": {
            "id": "verification_join",
            "kind": "deterministic",
            "join": {"semantics": "all", "inputs": ["qa_execute", "security_review_verify", "regression_run"]},
            "produces": ["verification_evidence_set"],
            "retryBudget": {"maxAttempts": 2},
        },
        "acceptance_gate": {
            "id": "acceptance_gate",
            "kind": "gate",
            "evaluatorRefs": ["qa_report_check_v2", "security_report_check_v1", "regression_check_v1"],
            "humanDecision": {"required": True, "semanticKind": "verification_acceptance"},
            "requires": ["verification_evidence_set"],
            "produces": ["acceptance_decision"],
            "retryBudget": {"maxAttempts": 2},
        },
    },
    "edges": [
        {"from": "qa_execute", "to": "verification_join"},
        {"from": "security_review_verify", "to": "verification_join"},
        {"from": "regression_run", "to": "verification_join"},
        {"from": "verification_join", "to": "acceptance_gate"},
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
    """A fresh copy of the Verification graph definition."""
    return copy.deepcopy(_DEFINITION)
