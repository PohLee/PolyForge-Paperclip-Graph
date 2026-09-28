"""Transition contract identity and the decision target hash (AT-18, AT-14).

Two structurally identical contracts must hash identically, any bound change must not, and
the hash must be blind to status and timestamps. These are the properties everything else
depends on: idempotency keys, effect identities, and approval applicability are all derived
from them.
"""

from __future__ import annotations

import unittest

from services.polyforge.tests.runtime.fixtures import PROJECT_A, definition
from polyforge.core import errors
from polyforge.core.contracts.policy import PolicyEffect, PolicyRule, resolve_policy
from polyforge.core.contracts.transition import (
    TransitionContract,
    build_contract,
    contract_hash,
    decision_target_hash,
)
from polyforge.core.runtime.planner import build_plan

RUN_ROW = {
    "run_id": "run-1",
    "company_ref": "c1",
    "project_ref": PROJECT_A,
    "graph_id": "verification",
    "graph_version": 3,
    "definition_hash": "sha256:definition",
    "plan_hash": "sha256:plan",
    "dependency_lock_hash": "sha256:lock",
}

PLAN = build_plan(definition(), graph_version=3, entrypoint="verification.start")
NODE = {
    "node_id": "qa_run",
    "iteration": 0,
    "kind": "agent_operation",
    "status": "READY",
}
NODE_PLAN = PLAN.nodes["qa_run"]


def _policy(effect: PolicyEffect = PolicyEffect.ALLOW) -> object:
    return resolve_policy(
        [PolicyRule(rule_id="r1", effect=effect, project_ref=PROJECT_A)],
        policy_context(),
    )


def policy_context() -> object:
    from polyforge.core.contracts.policy import PolicyContext

    return PolicyContext(
        project_ref=PROJECT_A,
        workflow_ref="verification",
        transition_ref="verification.qa_run",
        action="node.qa_run.execute",
        resource="qa_run",
        environment="production",
    )


def _contract(**overrides: object) -> TransitionContract:
    kwargs: dict[str, object] = {
        "run": RUN_ROW,
        "node": NODE,
        "plan": {"compiler_version": PLAN.compiler_version, "plan_hash": PLAN.plan_hash},
        "node_plan": NODE_PLAN.to_canonical(),
        "policy": _policy(),
        "inputs": {"candidate_artifacts": "sha256:input"},
        "subject": {"nodeKind": "agent_operation"},
        "operation": {"id": "verification.qa", "version": 1},
        "authority": {"action": "node.qa_run.execute", "resource": "qa_run"},
        "environment": {"environment": "production"},
        "mutations": [{"kind": "qa_report", "target": "qa_report", "operation": "produce"}],
        "required_evidence_kinds": ["qa_report"],
        "required_evaluators": [{"ref": "contract_schema_v1", "kind": "automatic", "version": "1"}],
    }
    kwargs.update(overrides)
    return build_contract(**kwargs)  # type: ignore[arg-type]


class ContractIdentityTests(unittest.TestCase):
    def test_two_structurally_identical_contracts_hash_identically(self) -> None:
        self.assertEqual(_contract().hash, _contract().hash)

    def test_a_different_run_row_does_not_change_the_identity(self) -> None:
        # A contract is about *what work*, not *which run instance*; the run scopes it in the
        # database instead, so a rebuild of the same structure reuses the same identity.
        other = dict(RUN_ROW, run_id="run-2", work_order_id="wo-2")
        self.assertEqual(_contract().hash, _contract(run=other).hash)

    def test_timestamps_and_storage_handles_are_excluded(self) -> None:
        stamped = _contract(contract_id="tct-a", created_at="2026-01-01T00:00:00.000Z")
        restamped = _contract(contract_id="tct-b", created_at="2026-06-30T12:00:00.000Z")
        self.assertEqual(stamped.hash, restamped.hash)

    def test_a_different_iteration_changes_the_identity(self) -> None:
        self.assertNotEqual(
            _contract().hash, _contract(node={**NODE, "iteration": 1}).hash
        )

    def test_a_different_input_digest_changes_the_identity(self) -> None:
        self.assertNotEqual(
            _contract().hash,
            _contract(inputs={"candidate_artifacts": "sha256:other"}).hash,
        )

    def test_a_different_policy_decision_changes_the_identity(self) -> None:
        denied = _contract(policy=_policy(PolicyEffect.DENY))
        self.assertNotEqual(_contract().hash, denied.hash)

    def test_a_different_authority_or_environment_changes_the_identity(self) -> None:
        self.assertNotEqual(
            _contract().hash,
            _contract(authority={"action": "node.qa_run.execute", "resource": "other"}).hash,
        )
        self.assertNotEqual(
            _contract().hash,
            _contract(environment={"environment": "staging"}).hash,
        )

    def test_a_different_evaluator_version_changes_the_identity(self) -> None:
        self.assertNotEqual(
            _contract().hash,
            _contract(
                required_evaluators=[
                    {"ref": "contract_schema_v1", "kind": "automatic", "version": "2"}
                ]
            ).hash,
        )

    def test_a_wire_round_trip_preserves_the_identity(self) -> None:
        contract = _contract()
        wire = contract.to_wire()
        self.assertEqual(contract_hash(TransitionContract.from_wire(wire)), contract.hash)

    def test_a_contract_without_a_required_evaluator_is_refused(self) -> None:
        with self.assertRaises(errors.PolyForgeError) as caught:
            _contract(required_evaluators=[])
        self.assertEqual(caught.exception.code, errors.ErrorCode.CONTRACT_INVALID)
        self.assertIn("no required evaluator", caught.exception.message)

    def test_an_unknown_evaluator_kind_is_refused(self) -> None:
        with self.assertRaises(errors.PolyForgeError) as caught:
            _contract(required_evaluators=[{"ref": "x", "kind": "vibes", "version": "1"}])
        self.assertEqual(caught.exception.code, errors.ErrorCode.CONTRACT_INVALID)

    def test_a_gate_node_gets_a_stable_synthetic_operation(self) -> None:
        plan = build_plan(definition(), entrypoint="verification.start")
        contract = _contract(
            node={"node_id": "review_gate", "iteration": 0, "kind": "gate"},
            node_plan=plan.nodes["review_gate"].to_canonical(),
            operation={},
        )
        self.assertEqual(contract.operation_id, "node.review_gate")
        self.assertEqual(contract.operation_version, 1)


class DecisionTargetTests(unittest.TestCase):
    """AT-14: an approval is bound to an exact target, and only to that target."""

    def _target(self, **overrides: object) -> str:
        kwargs: dict[str, object] = {
            "gate_id": "review_gate",
            "semantic_kind": "verification_acceptance",
            "transition_hash": "sha256:transition",
            "input_digests": {"qa_report": "sha256:in"},
            "output_digests": {"qa_report": "sha256:out"},
            "policy_hash": "sha256:policy",
            "evaluator_versions": {"human_decision": "1"},
            "options": [{"id": "accept"}],
            "authority": {"action": "node.review_gate.execute"},
            "environment": {"environment": "production"},
        }
        kwargs.update(overrides)
        return decision_target_hash(**kwargs)  # type: ignore[arg-type]

    def test_the_same_target_hashes_identically(self) -> None:
        self.assertEqual(self._target(), self._target())

    def test_a_changed_output_artifact_changes_the_target(self) -> None:
        self.assertNotEqual(
            self._target(), self._target(output_digests={"qa_report": "sha256:other"})
        )

    def test_a_changed_authority_changes_the_target(self) -> None:
        self.assertNotEqual(
            self._target(),
            self._target(authority={"action": "node.review_gate.execute", "resource": "prod-db"}),
        )

    def test_a_changed_environment_changes_the_target(self) -> None:
        self.assertNotEqual(
            self._target(), self._target(environment={"environment": "staging"})
        )

    def test_changed_evaluator_versions_change_the_target(self) -> None:
        self.assertNotEqual(
            self._target(), self._target(evaluator_versions={"human_decision": "2"})
        )

    def test_changed_options_change_the_target(self) -> None:
        self.assertNotEqual(self._target(), self._target(options=[{"id": "reject"}]))

    def test_a_different_gate_is_a_different_target(self) -> None:
        self.assertNotEqual(self._target(), self._target(gate_id="another_gate"))


if __name__ == "__main__":
    unittest.main()
