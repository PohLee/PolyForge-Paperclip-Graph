"""The Design graph, following the worked example in ``docs/02-TECHNICAL-PLAN.md`` 4.1.

``design.start`` runs architecture, then an independent security review, then the design
gate. The other two entrypoints are the controlled ways in from outside:

``design.security_review``
    A side entry for a security reviewer who holds a validated architecture candidate.
    It requires the ``architecture_candidate_validated`` fact *with provenance*, and it
    promises only ``security_review`` — not the whole Design family — so a caller cannot
    read its result as "design finished".

``design.resume_review``
    The REQ-ENTRY-03 controlled recovery entry. It may only resume from a checkpoint the
    graph declares, and re-executing any of it needs a new invocation generation, so an
    arbitrary run can never be jumped into review.
"""

from __future__ import annotations

import copy
from typing import Any, Final

__all__ = ["DEFINITION", "definition"]

_DEFINITION: Final[dict[str, Any]] = {
    "schemaVersion": 1,
    "graphId": "design",
    "name": "Design",
    "description": (
        "Architecture, independent security review and human design acceptance, with a "
        "controlled side entry and a controlled resume entry."
    ),
    "entrypoints": {
        "design.start": {
            "key": "design.start",
            "inputs": ["requirement_baseline"],
            "requiresFacts": ["requirement_gate_passed"],
            "coordinator": {
                "requiredCapabilities": ["design.coordinate"],
                "preferredRoles": ["designer"],
                "fallbackRoles": ["tech_lead"],
            },
            "startNodes": ["architecture"],
            "exports": ["architecture_spec", "api_contract", "security_review", "design_acceptance"],
        },
        "design.security_review": {
            "key": "design.security_review",
            "inputs": ["architecture_spec", "requirement_baseline"],
            "requiresFacts": ["architecture_candidate_validated"],
            "coordinator": {
                "requiredCapabilities": ["security.review"],
                "preferredRoles": ["security"],
            },
            "startNodes": ["security_review"],
            "exports": ["security_review"],
        },
        "design.resume_review": {
            "key": "design.resume_review",
            "inputs": ["architecture_spec"],
            "requiresFacts": ["architecture_candidate_validated"],
            "coordinator": {
                "requiredCapabilities": ["design.coordinate"],
                "preferredRoles": ["tech_lead"],
            },
            "startNodes": ["security_review"],
            "exports": ["security_review", "design_acceptance"],
            "resumePolicy": {
                "allowedCheckpointKinds": ["architecture_candidate_validated", "security_review_pending"],
                "reExecutionRequiresNewGeneration": True,
            },
        },
    },
    "nodes": {
        "architecture": {
            "id": "architecture",
            "kind": "agent_operation",
            "operation": {"id": "architecture.design", "version": 3},
            "executor": {
                "requiredCapabilities": ["architecture.design"],
                "preferredRoles": ["designer"],
            },
            "inputs": {"baseline": "requirement_baseline"},
            "produces": ["architecture_spec", "api_contract"],
            "timeoutSeconds": 14400,
            "retryBudget": {"maxAttempts": 2},
        },
        "security_review": {
            "id": "security_review",
            "kind": "agent_operation",
            "operation": {"id": "security.review", "version": 2},
            "executor": {
                "requiredCapabilities": ["security.review"],
                "preferredRoles": ["security"],
                "independentFrom": ["architecture.producer"],
            },
            "inputs": {"architecture": "architecture_spec"},
            # The threat model is authored here, beside the review that produced it, because the
            # design gate only *judges* it. A gate cannot produce it: the contract marks a gate's own
            # mutations as requiring a trusted execution record, so a gate asserting its own evidence
            # would be refused at ingestion -- the gate would be grading work it had certified.
            "produces": ["security_review", "threat_model"],
            "timeoutSeconds": 10800,
            "retryBudget": {"maxAttempts": 2},
        },
        "design_gate": {
            "id": "design_gate",
            "kind": "gate",
            "evaluatorRefs": ["contract_schema_v1", "threat_model_review_v2"],
            "humanDecision": {"required": True, "semanticKind": "design_acceptance"},
            "produces": ["design_acceptance"],
            "retryBudget": {"maxAttempts": 2},
        },
    },
    "edges": [
        {"from": "architecture", "to": "security_review"},
        {"from": "security_review", "to": "design_gate"},
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
    """A fresh copy of the Design graph definition."""
    return copy.deepcopy(_DEFINITION)
