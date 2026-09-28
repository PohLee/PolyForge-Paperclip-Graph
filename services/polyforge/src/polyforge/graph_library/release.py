"""The Release graph: authorize, then deploy, then judge the result.

``deploy_authorization`` is a permission gate naming the exact action and resource, and it
dominates ``deploy``, which is an ``external_effect`` node. That ordering is the whole point
(REQ-GOV-05): without an authorization no external effect may happen, and a revoked
authorization does not pretend an already-delivered deployment was undone.

``deploy`` has ``retryBudget.maxAttempts: 1`` on purpose. A deployment whose outcome is
unknown is reconciled against the provider; it is never blindly retried, because a second
try is a second effect.

Publishing this graph requires authorization references, because it contains a permission
gate.
"""

from __future__ import annotations

import copy
from typing import Any, Final

__all__ = ["DEFINITION", "definition"]

_DEFINITION: Final[dict[str, Any]] = {
    "schemaVersion": 1,
    "graphId": "release",
    "name": "Release",
    "description": (
        "Privileged deployment behind an exact permission gate, followed by a quality gate "
        "that judges the delivered result."
    ),
    "entrypoints": {
        "release.start": {
            "key": "release.start",
            "inputs": ["acceptance_decision"],
            "requiresFacts": ["verification_gate_passed"],
            "coordinator": {
                "requiredCapabilities": ["release.coordinate"],
                "preferredRoles": ["release_manager"],
                "fallbackRoles": ["tech_lead"],
            },
            "startNodes": ["deploy_authorization"],
            "exports": ["deployment_authorization", "deployment_receipt", "release_quality_decision"],
        }
    },
    "nodes": {
        "deploy_authorization": {
            "id": "deploy_authorization",
            "kind": "gate",
            "permissionGate": {"action": "deployment.execute", "resource": "target_environment"},
            "evaluatorRefs": ["authorization_scope_check_v1"],
            "humanDecision": {"required": True, "semanticKind": "deployment_authorization"},
            "produces": ["deployment_authorization"],
        },
        "deploy": {
            "id": "deploy",
            "kind": "external_effect",
            "inputs": {"authorization": "deployment_authorization"},
            "produces": ["deployment_receipt"],
            "timeoutSeconds": 3600,
            "retryBudget": {"maxAttempts": 1},
        },
        "release_quality_gate": {
            "id": "release_quality_gate",
            "kind": "gate",
            "evaluatorRefs": ["deployment_verification_v1", "rollback_readiness_v1"],
            "humanDecision": {"required": True, "semanticKind": "release_acceptance"},
            "produces": ["release_quality_decision"],
            "retryBudget": {"maxAttempts": 2},
        },
    },
    "edges": [
        {"from": "deploy_authorization", "to": "deploy"},
        {"from": "deploy", "to": "release_quality_gate"},
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
    """A fresh copy of the Release graph definition."""
    return copy.deepcopy(_DEFINITION)
