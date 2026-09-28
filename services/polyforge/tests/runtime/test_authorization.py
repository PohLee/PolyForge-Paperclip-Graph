"""Privileged actions: a fresh, exact authorization is required before commit (AT-14, AT-15).

A gate PASS is a statement about engineering results. It is *not* an authorization to act,
and it does not survive the authorization it was granted under changing underneath it.
"""

from __future__ import annotations

import unittest
from typing import Any

from services.polyforge.tests.runtime.fixtures import (
    QA_NODE,
    SCOPE_A,
    artifact,
    claim_request,
    definition,
    envelope,
    evidence_for,
    make_engine,
    node_state,
    work_order_request,
)
from polyforge.core import errors
from polyforge.core.contracts.policy import PolicyEffect, PolicyRule
from polyforge.core.state import BlockReason, NodeStatus


class _GrantingGovernance:
    """A governance port that answers with a caller-supplied authorization status."""

    def __init__(self, status: Any) -> None:
        from polyforge.core.ports.base import AuthorizationStatus

        self.status = status if isinstance(status, AuthorizationStatus) else status
        self.calls: list[dict[str, Any]] = []

    def check_authorization(self, ref: dict[str, Any], action: Any) -> Any:
        self.calls.append({"ref": dict(ref), "action": action.action})
        return self.status

    # The other governance methods are never reached in these tests; refusing keeps a future
    # accidental call from silently passing.
    def __getattr__(self, name: str) -> Any:
        def refuse(*_args: Any, **_kwargs: Any) -> Any:
            raise errors.unsupported(f"test governance port does not implement {name}")

        return refuse


class _Ports:
    def __init__(self, governance: Any) -> None:
        self.governance = governance

    def __getattr__(self, name: str) -> Any:
        def refuse(*_args: Any, **_kwargs: Any) -> Any:
            raise errors.unsupported(f"test ports do not implement {name}")

        return refuse


def _privileged_definition() -> dict[str, Any]:
    """The fixture plus a permission gate on the QA node."""
    graph = definition()
    graph["nodes"][QA_NODE]["permissionGate"] = {
        "action": "qa.publish_report",
        "resource": "qa-report-store",
    }
    graph["nodes"][QA_NODE]["evaluatorRefs"] = [
        "contract_schema_v1",
        "required_evidence_present",
    ]
    return graph


class PermissionGateTests(unittest.TestCase):
    def _reach(self, *, ports: Any = None, payload_extra: dict[str, Any] | None = None) -> tuple[Any, Any, str, Any]:
        engine, db, clock = make_engine(ports=ports)
        run_id = str(
            engine.admit_work_order(
                work_order_request(graph=_privileged_definition(), start_intent_id="privileged-1")
            )["runId"]
        )
        attempt = engine.claim(claim_request(run_id=run_id, node_id=QA_NODE, subject="sub-qa"))
        art = artifact("qa_report", "qa-v1")
        engine.submit_artifacts(
            envelope(
                run_id=run_id,
                node_id=QA_NODE,
                attempt_id=attempt["attemptId"],
                lease_epoch=attempt["leaseEpoch"],
                payload={"artifacts": [art]},
            )
        )
        evidence = engine.submit_evidence(
            envelope(
                run_id=run_id,
                node_id=QA_NODE,
                attempt_id=attempt["attemptId"],
                lease_epoch=attempt["leaseEpoch"],
                command_suffix="ev",
                payload={"evidence": [evidence_for(art, "qa_report")]},
            )
        )
        payload: dict[str, Any] = {
            "evidenceIds": [str(evidence["resultRef"]).split(",")[0]],
            **(payload_extra or {}),
        }
        result = engine.request_transition(
            envelope(
                run_id=run_id,
                node_id=QA_NODE,
                attempt_id=attempt["attemptId"],
                lease_epoch=attempt["leaseEpoch"],
                command_suffix="tr",
                payload=payload,
            )
        )
        return engine, db, run_id, result

    def test_a_permission_gate_blocks_an_unverified_commit(self) -> None:
        engine, db, run_id, result = self._reach()
        self.assertFalse(result["applied"])
        self.assertEqual(
            [b["code"] for b in result["blockers"]], ["PERMISSION_GATE_UNVERIFIED"]
        )
        node = node_state(engine.get_run(run_id, scope=SCOPE_A), QA_NODE)
        self.assertEqual(node["status"], NodeStatus.BLOCKED)
        self.assertEqual(node["blockReason"], str(BlockReason.AUTHORIZATION))

    def test_a_permission_gate_blocks_a_revoked_grant(self) -> None:
        from polyforge.core.contracts.policy import PlatformGrants

        engine, db, run_id, result = self._reach(
            payload_extra={"platformGrants": PlatformGrants(revoked=True).to_wire()}
        )
        self.assertFalse(result["applied"])
        self.assertIn(
            "PERMISSION_GATE_UNVERIFIED", [b["code"] for b in result["blockers"]]
        )

    def test_a_permission_gate_blocks_an_expired_grant(self) -> None:
        from polyforge.core.contracts.policy import PlatformGrants

        engine, db, run_id, result = self._reach(
            payload_extra={"platformGrants": PlatformGrants(expired=True).to_wire()}
        )
        self.assertFalse(result["applied"])
        self.assertIn(
            "PERMISSION_GATE_UNVERIFIED", [b["code"] for b in result["blockers"]]
        )


class ApprovalRuleTests(unittest.TestCase):
    """REQ-GOV-04: an approval binds the exact action, and it is re-checked at commit."""

    def _approving_graph(self) -> dict[str, Any]:
        graph = definition()
        graph["policyRefs"] = [
            {
                "name": "verification.policy",
                "rules": [
                    {
                        "ruleId": "allow-verify",
                        "effect": "allow",
                        "projectRef": "project-a",
                        "version": "1",
                        "reason": "verification may proceed",
                    },
                    {
                        "ruleId": "approve-publish",
                        "effect": "require_approval",
                        "projectRef": "project-a",
                        "transitionRef": "verification.qa_run",
                        "actions": ["node.qa_run.execute"],
                        "requiresHumanApproval": True,
                        "requestedAuthority": "qa.publish",
                        "version": "1",
                        "reason": "publishing a QA report needs a live platform authorization",
                    },
                ],
            }
        ]
        return graph

    def _run_to_transition(
        self, *, ports: Any, payload_extra: dict[str, Any] | None = None
    ) -> tuple[Any, str, Any]:
        from polyforge.core.contracts.policy import PlatformGrants

        engine, db, clock = make_engine(ports=ports)
        run_id = str(
            engine.admit_work_order(
                work_order_request(graph=self._approving_graph(), start_intent_id="approval-1")
            )["runId"]
        )
        attempt = engine.claim(claim_request(run_id=run_id, node_id=QA_NODE, subject="sub-qa"))
        art = artifact("qa_report", "qa-v1")
        engine.submit_artifacts(
            envelope(
                run_id=run_id,
                node_id=QA_NODE,
                attempt_id=attempt["attemptId"],
                lease_epoch=attempt["leaseEpoch"],
                payload={"artifacts": [art]},
            )
        )
        evidence = engine.submit_evidence(
            envelope(
                run_id=run_id,
                node_id=QA_NODE,
                attempt_id=attempt["attemptId"],
                lease_epoch=attempt["leaseEpoch"],
                command_suffix="ev",
                payload={"evidence": [evidence_for(art, "qa_report")]},
            )
        )
        payload: dict[str, Any] = {
            "evidenceIds": [str(evidence["resultRef"]).split(",")[0]],
            "platformGrants": PlatformGrants(
                allowed_authorities=("qa.publish",), capabilities=(), checked_at=clock.iso()
            ).to_wire(),
            **(payload_extra or {}),
        }
        result = engine.request_transition(
            envelope(
                run_id=run_id,
                node_id=QA_NODE,
                attempt_id=attempt["attemptId"],
                lease_epoch=attempt["leaseEpoch"],
                command_suffix="tr",
                payload=payload,
            )
        )
        return engine, run_id, result

    def test_a_missing_verified_result_blocks_before_commit(self) -> None:
        engine, db, _ = make_engine()
        graph = self._approving_graph()
        run_id = str(
            engine.admit_work_order(
                work_order_request(graph=graph, start_intent_id="approval-2")
            )["runId"]
        )
        attempt = engine.claim(claim_request(run_id=run_id, node_id=QA_NODE, subject="sub-qa"))
        art = artifact("qa_report", "qa-v1")
        engine.submit_artifacts(
            envelope(
                run_id=run_id,
                node_id=QA_NODE,
                attempt_id=attempt["attemptId"],
                lease_epoch=attempt["leaseEpoch"],
                payload={"artifacts": [art]},
            )
        )
        evidence = engine.submit_evidence(
            envelope(
                run_id=run_id,
                node_id=QA_NODE,
                attempt_id=attempt["attemptId"],
                lease_epoch=attempt["leaseEpoch"],
                command_suffix="ev",
                payload={"evidence": [evidence_for(art, "qa_report")]},
            )
        )
        # No platformGrants at all: an approval is a moment, not a possession.
        result = engine.request_transition(
            envelope(
                run_id=run_id,
                node_id=QA_NODE,
                attempt_id=attempt["attemptId"],
                lease_epoch=attempt["leaseEpoch"],
                command_suffix="tr",
                payload={"evidenceIds": [str(evidence["resultRef"]).split(",")[0]]},
            )
        )
        self.assertFalse(result["applied"])
        self.assertIn("AUTHORIZATION_STALE", [b["code"] for b in result["blockers"]])
        self.assertIn(
            "an approval is a moment, not a possession", result["blockers"][0]["message"]
        )

    def test_a_non_exact_authorization_blocks(self) -> None:
        from polyforge.core.ports.base import AuthorizationStatus

        governance = _GrantingGovernance(
            AuthorizationStatus(granted=True, reason="approved for another action", exact_match=False)
        )
        engine, run_id, result = self._run_to_transition(
            ports=_Ports(governance),
            payload_extra={
                "authorizationRef": {"provider": "paperclip", "kind": "approval", "id": "ap-1"}
            },
        )
        self.assertFalse(result["applied"])
        self.assertIn("AUTHORIZATION_NOT_EXACT", [b["code"] for b in result["blockers"]])
        self.assertEqual(len(governance.calls), 1)
        self.assertEqual(governance.calls[0]["action"], "node.qa_run.execute")

    def test_a_revoked_authorization_blocks(self) -> None:
        from polyforge.core.ports.base import AuthorizationStatus

        governance = _GrantingGovernance(
            AuthorizationStatus(granted=True, reason="revoked afterwards", exact_match=True, revoked=True)
        )
        engine, run_id, result = self._run_to_transition(
            ports=_Ports(governance),
            payload_extra={
                "authorizationRef": {"provider": "paperclip", "kind": "approval", "id": "ap-1"}
            },
        )
        self.assertFalse(result["applied"])
        self.assertIn("AUTHORIZATION_NOT_EXACT", [b["code"] for b in result["blockers"]])

    def test_an_exact_unexpired_authorization_allows_the_commit(self) -> None:
        from polyforge.core.ports.base import AuthorizationStatus

        governance = _GrantingGovernance(
            AuthorizationStatus(granted=True, reason="exact match", exact_match=True)
        )
        engine, run_id, result = self._run_to_transition(
            ports=_Ports(governance),
            payload_extra={
                "authorizationRef": {"provider": "paperclip", "kind": "approval", "id": "ap-1"}
            },
        )
        self.assertTrue(result["applied"], msg=str(result["blockers"]))
        self.assertEqual(
            node_state(engine.get_run(run_id, scope=SCOPE_A), QA_NODE)["status"],
            NodeStatus.PASSED,
        )

    def test_no_ports_means_no_verifiable_authorization(self) -> None:
        engine, run_id, result = self._run_to_transition(
            ports=None,
            payload_extra={
                "authorizationRef": {"provider": "paperclip", "kind": "approval", "id": "ap-1"}
            },
        )
        self.assertFalse(result["applied"])
        self.assertIn(
            "AUTHORIZATION_UNVERIFIABLE", [b["code"] for b in result["blockers"]]
        )


class PolicyMayNotWidenTests(unittest.TestCase):
    """REQ-GOV-07: a graph may ask for less than the platform grants, never more."""

    def test_a_requested_authority_beyond_the_platform_is_a_deny(self) -> None:
        from polyforge.core.contracts.policy import PlatformGrants, PolicyContext, resolve_policy

        policy = resolve_policy(
            [
                PolicyRule(
                    rule_id="ask-for-too-much",
                    effect=PolicyEffect.ALLOW,
                    project_ref="project-a",
                    requested_authority="production.deploy",
                )
            ],
            PolicyContext(
                project_ref="project-a",
                workflow_ref="verification",
                transition_ref="verification.qa_run",
                action="node.qa_run.execute",
                resource="qa_run",
                environment="production",
            ),
            grants=PlatformGrants(allowed_authorities=("qa.publish",)),
        )
        self.assertTrue(policy.is_denied)

    def test_a_requested_authority_within_the_platform_survives(self) -> None:
        from polyforge.core.contracts.policy import PlatformGrants, PolicyContext, resolve_policy

        policy = resolve_policy(
            [
                PolicyRule(
                    rule_id="ask-within",
                    effect=PolicyEffect.ALLOW,
                    project_ref="project-a",
                    requested_authority="qa.publish",
                )
            ],
            PolicyContext(
                project_ref="project-a",
                workflow_ref="verification",
                transition_ref="verification.qa_run",
                action="node.qa_run.execute",
                resource="qa_run",
                environment="production",
            ),
            grants=PlatformGrants(allowed_authorities=("qa.publish", "production.deploy")),
        )
        self.assertFalse(policy.is_denied)
        self.assertEqual(policy.granted_authority, "qa.publish")
        self.assertTrue(policy.platform_ceiling_applied)


if __name__ == "__main__":
    unittest.main()
