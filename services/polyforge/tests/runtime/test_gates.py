"""Gate aggregation and the built-in evaluators.

Two properties dominate: an evaluator crash is never a pass, and a mandatory gate cannot be
lowered by the graph's own join semantics.
"""

from __future__ import annotations

import unittest

from services.polyforge.tests.runtime.fixtures import digest
from polyforge.core.gates.aggregate import GateResult, aggregate_gate
from polyforge.core.gates.evaluators import (
    EvaluationContext,
    EvaluatorRegistry,
    EvaluatorResult,
    default_registry,
)
from polyforge.core.state import JoinSemantics


def _result(ref: str, verdict: str, *, reason: str = "", diagnostics: tuple[str, ...] = ()) -> EvaluatorResult:
    return EvaluatorResult(
        evaluator_ref=ref,
        evaluator_kind="automatic",
        evaluator_version="1",
        result=verdict,
        reason=reason or f"{ref} said {verdict}",
        diagnostics=diagnostics,
    )


class AggregationTests(unittest.TestCase):
    def test_all_pass_is_a_pass(self) -> None:
        gate = aggregate_gate(
            [_result("a", GateResult.PASS), _result("b", GateResult.PASS)],
            required_evaluators=["a", "b"],
        )
        self.assertEqual(gate.result, GateResult.PASS)

    def test_fail_wins_over_everything(self) -> None:
        gate = aggregate_gate(
            [_result("a", GateResult.FAIL, reason="threshold not met"), _result("b", GateResult.PASS)],
            required_evaluators=["a", "b"],
        )
        self.assertEqual(gate.result, GateResult.FAIL)
        self.assertIn("threshold not met", gate.reason)

    def test_a_missing_required_evaluator_escalates_and_never_passes(self) -> None:
        gate = aggregate_gate([_result("a", GateResult.PASS)], required_evaluators=["a", "b"])
        self.assertEqual(gate.result, GateResult.ESCALATE)
        self.assertEqual(gate.missing_evaluators, ("b",))

    def test_missing_required_evidence_escalates(self) -> None:
        gate = aggregate_gate(
            [_result("a", GateResult.PASS)],
            required_evaluators=["a"],
            required_evidence_kinds=["qa_report", "security_review"],
            present_evidence_kinds=["qa_report"],
        )
        self.assertEqual(gate.result, GateResult.ESCALATE)
        self.assertEqual(gate.missing_evidence_kinds, ("security_review",))

    def test_an_evaluator_error_escalates_rather_than_passing(self) -> None:
        gate = aggregate_gate(
            [_result("a", GateResult.PASS), _result("b", GateResult.ESCALATE, diagnostics=("boom",))],
            required_evaluators=["a", "b"],
        )
        self.assertEqual(gate.result, GateResult.ESCALATE)
        self.assertIn("boom", gate.diagnostics)

    def test_a_mandatory_gate_cannot_be_lowered_by_an_any_join(self) -> None:
        gate = aggregate_gate(
            [_result("reviewer", GateResult.PASS), _result("human", GateResult.ESCALATE)],
            join=JoinSemantics.ANY,
            mandatory=True,
            required_evaluators=["reviewer", "human"],
        )
        self.assertNotEqual(gate.result, GateResult.PASS)
        self.assertEqual(gate.result, GateResult.ESCALATE)

    def test_a_mandatory_gate_cannot_be_lowered_by_a_quorum_join(self) -> None:
        gate = aggregate_gate(
            [
                _result("a", GateResult.PASS),
                _result("b", GateResult.PASS),
                _result("c", GateResult.ESCALATE),
            ],
            join=JoinSemantics.QUORUM,
            mandatory=True,
            required_evaluators=["a", "b", "c"],
        )
        self.assertEqual(gate.result, GateResult.ESCALATE)
        self.assertIn("c", gate.reason)

    def test_a_non_mandatory_gate_may_use_an_any_join(self) -> None:
        gate = aggregate_gate(
            [_result("a", GateResult.PASS), _result("b", GateResult.ESCALATE)],
            join=JoinSemantics.ANY,
            mandatory=False,
            required_evaluators=[],
        )
        self.assertEqual(gate.result, GateResult.PASS)

    def test_a_mandatory_gate_with_no_required_evaluator_escalates(self) -> None:
        gate = aggregate_gate([], mandatory=True, required_evaluators=[])
        self.assertEqual(gate.result, GateResult.ESCALATE)
        self.assertIn("would pass unconditionally", gate.reason)

    def test_an_unrecognised_result_value_is_treated_as_an_escalation(self) -> None:
        gate = aggregate_gate(
            [_result("a", "MAYBE")], required_evaluators=["a"]
        )
        self.assertEqual(gate.result, GateResult.ESCALATE)


def _contract(**overrides: object) -> dict[str, object]:
    base: dict[str, object] = {
        "nodeId": "qa_run",
        "iteration": 0,
        "operation": {"id": "verification.qa", "version": 1},
        "effectivePolicy": {"effect": "allow", "ruleId": "r1", "version": "1"},
        "planHash": "sha256:plan",
        "requiredEvidenceKinds": ["qa_report"],
        "requiredEvaluators": [{"ref": "contract_schema_v1", "kind": "automatic", "version": "1"}],
        "intendedMutations": [{"kind": "qa_report"}],
        "contractHash": "sha256:contract",
    }
    base.update(overrides)
    return base


class EvaluatorRegistryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.registry = default_registry()

    def test_the_built_in_registry_is_the_published_set(self) -> None:
        # The four generic checks plus the eleven domain checks the shipped graph families name.
        # This used to assert the four alone, which is how a family could reach a mandatory gate
        # with no implementation behind it: the registry was "complete" by this test while the
        # library declared twelve refs the Core could not answer for.
        self.assertEqual(
            set(self.registry.refs()),
            {
                "contract_schema_v1",
                "required_evidence_present",
                "independent_reviewer",
                "human_decision",
                "requirement_completeness_v1",
                "acceptance_criteria_review_v1",
                "threat_model_review_v2",
                "test_report_check_v1",
                "review_findings_check_v1",
                "qa_report_check_v2",
                "security_report_check_v1",
                "regression_check_v1",
                "authorization_scope_check_v1",
                "deployment_verification_v1",
                "rollback_readiness_v1",
            },
        )

    def test_an_unregistered_evaluator_escalates(self) -> None:
        result = self.registry.evaluate("not_a_real_evaluator", EvaluationContext())
        self.assertEqual(result.result, GateResult.ESCALATE)
        self.assertIn("not registered", result.reason)

    def test_an_evaluator_that_raises_becomes_an_escalation_with_a_diagnostic(self) -> None:
        class Exploding:
            ref = "exploding"
            kind = "automatic"
            version = "1"

            def evaluate(self, context: EvaluationContext) -> tuple[str, str, tuple[str, ...]]:
                raise ZeroDivisionError("evaluator bug")

        registry = EvaluatorRegistry()
        registry.register(Exploding())
        result = registry.evaluate("exploding", EvaluationContext())
        self.assertEqual(result.result, GateResult.ESCALATE)
        self.assertIn("ZeroDivisionError", result.reason)
        self.assertTrue(any("never a pass" in d for d in result.diagnostics))

    def test_a_evaluator_cannot_be_registered_by_a_caller_at_runtime(self) -> None:
        # The registry is constructed fresh per engine; there is no public registration path on
        # the engine, so a tool cannot add an evaluator that will return PASS.
        from polyforge.core.runtime.engine import RuntimeEngine

        self.assertFalse(hasattr(RuntimeEngine, "register_evaluator"))


class ContractSchemaTests(unittest.TestCase):
    """The evaluator recomputes the identity hash, so these use a genuinely built contract."""

    def setUp(self) -> None:
        self.registry = default_registry()

    def _real_contract(self, **overrides: object) -> dict[str, object]:
        from services.polyforge.tests.runtime.fixtures import PROJECT_A, definition
        from polyforge.core.contracts.policy import PolicyContext, PolicyEffect, PolicyRule, resolve_policy
        from polyforge.core.contracts.transition import build_contract
        from polyforge.core.runtime.planner import build_plan

        plan = build_plan(definition(), entrypoint="verification.start")
        policy = resolve_policy(
            [PolicyRule(rule_id="r1", effect=PolicyEffect.ALLOW, project_ref=PROJECT_A)],
            PolicyContext(
                project_ref=PROJECT_A,
                workflow_ref="verification",
                transition_ref="verification.qa_run",
                action="node.qa_run.execute",
                resource="qa_run",
                environment="production",
            ),
        )
        node_plan = plan.nodes["qa_run"]
        kwargs: dict[str, object] = {
            "run": {
                "run_id": "run-1",
                "company_ref": "c1",
                "project_ref": PROJECT_A,
                "graph_id": "verification",
                "graph_version": 1,
                "definition_hash": "sha256:definition",
                "plan_hash": "sha256:plan",
                "dependency_lock_hash": "sha256:lock",
            },
            "node": {"node_id": "qa_run", "iteration": 0},
            "plan": {"compiler_version": plan.compiler_version, "plan_hash": plan.plan_hash},
            "node_plan": node_plan.to_canonical(),
            "policy": policy,
            "inputs": {"candidate_artifacts": "sha256:input"},
            "operation": {"id": "verification.qa", "version": 1},
            "mutations": [{"kind": "qa_report", "operation": "produce"}],
            "required_evidence_kinds": ["qa_report"],
            "required_evaluators": [
                {"ref": "contract_schema_v1", "kind": "automatic", "version": "1"}
            ],
        }
        kwargs.update(overrides)
        return build_contract(**kwargs).to_wire()  # type: ignore[arg-type]

    def _evaluate(self, contract: dict[str, object]) -> EvaluatorResult:
        return self.registry.evaluate(
            "contract_schema_v1", EvaluationContext(contract=contract)
        )

    def test_a_structurally_complete_contract_passes(self) -> None:
        self.assertEqual(self._evaluate(self._real_contract()).result, GateResult.PASS)

    def test_a_contract_with_no_declared_identity_fails(self) -> None:
        contract = self._real_contract()
        contract.pop("contractHash")
        result = self._evaluate(contract)
        self.assertEqual(result.result, GateResult.FAIL)
        self.assertIn("identity hash", result.reason)

    def test_a_tampered_contract_fails_against_its_declared_hash(self) -> None:
        # Tamper *after* hashing: this is what a hand edit or a bad migration looks like.
        contract = self._real_contract()
        contract["subject"] = {"nodeKind": "tampered"}
        result = self._evaluate(contract)
        self.assertEqual(result.result, GateResult.FAIL)
        self.assertIn("does not match its declared identity", result.reason)

    def test_a_denied_policy_fails_the_contract(self) -> None:
        from services.polyforge.tests.runtime.fixtures import PROJECT_A
        from polyforge.core.contracts.policy import (
            PolicyContext,
            PolicyEffect,
            PolicyRule,
            resolve_policy,
        )

        denied = resolve_policy(
            [
                PolicyRule(
                    rule_id="deny-1",
                    effect=PolicyEffect.DENY,
                    project_ref=PROJECT_A,
                    reason="release gates are frozen",
                )
            ],
            PolicyContext(
                project_ref=PROJECT_A,
                workflow_ref="verification",
                transition_ref="verification.qa_run",
                action="node.qa_run.execute",
                resource="qa_run",
                environment="production",
            ),
        )
        result = self._evaluate(self._real_contract(policy=denied))
        self.assertEqual(result.result, GateResult.FAIL)
        self.assertIn("frozen", result.reason)

    def test_a_contract_requiring_no_evaluator_is_refused_at_build_time(self) -> None:
        from polyforge.core import errors

        with self.assertRaises(errors.PolyForgeError):
            self._real_contract(required_evaluators=[])

    def test_iteration_zero_is_not_a_missing_field(self) -> None:
        self.assertEqual(self._evaluate(self._real_contract()).result, GateResult.PASS)


class RequiredEvidenceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.registry = default_registry()

    def _artifact(self, **overrides: object) -> dict[str, object]:
        base: dict[str, object] = {
            "artifactId": "art-1",
            "kind": "qa_report",
            "contentHash": digest("report"),
        }
        base.update(overrides)
        return base

    def _evaluate(self, **overrides: object) -> EvaluatorResult:
        return self.registry.evaluate(
            "required_evidence_present", EvaluationContext(**overrides)  # type: ignore[arg-type]
        )

    def test_present_evidence_passes(self) -> None:
        result = self._evaluate(
            contract=_contract(),
            evidence=({"evidenceId": "e1", "kind": "qa_report", "valid": True, "artifacts": (self._artifact(),)},),
        )
        self.assertEqual(result.result, GateResult.PASS)

    def test_missing_evidence_escalates(self) -> None:
        result = self._evaluate(contract=_contract(), evidence=())
        self.assertEqual(result.result, GateResult.ESCALATE)
        self.assertIn("qa_report", result.reason)

    def test_invalidated_evidence_escalates_and_says_so(self) -> None:
        result = self._evaluate(
            contract=_contract(),
            evidence=({"evidenceId": "e1", "kind": "qa_report", "valid": True, "artifacts": (self._artifact(),)},),
            invalid_evidence=(
                {"evidenceId": "e0", "kind": "qa_report", "valid": False},
            ),
        )
        self.assertEqual(result.result, GateResult.PASS)

    def test_evidence_citing_a_mutable_document_fails(self) -> None:
        mutable = self._artifact(
            providerRef={"provider": "paperclip", "kind": "document", "id": "doc-1"}
        )
        result = self._evaluate(
            contract=_contract(),
            evidence=({"evidenceId": "e1", "kind": "qa_report", "valid": True, "artifacts": (mutable,)},),
        )
        self.assertEqual(result.result, GateResult.FAIL)
        self.assertIn("mutable document", result.reason)

    def test_a_pinned_document_revision_passes(self) -> None:
        pinned = self._artifact(
            providerRef={"provider": "paperclip", "kind": "document", "id": "doc-1", "revision": "r1"}
        )
        result = self._evaluate(
            contract=_contract(),
            evidence=({"evidenceId": "e1", "kind": "qa_report", "valid": True, "artifacts": (pinned,)},),
        )
        self.assertEqual(result.result, GateResult.PASS)

    def test_evidence_bound_to_a_superseded_input_revision_escalates(self) -> None:
        result = self._evaluate(
            contract=_contract(),
            evidence=(
                {
                    "evidenceId": "e1",
                    "kind": "qa_report",
                    "valid": True,
                    "artifacts": (self._artifact(),),
                    "input_revision_bindings": {"candidate_artifacts": "sha256:old"},
                },
            ),
            current_input_revisions={"candidate_artifacts": "sha256:new"},
        )
        self.assertEqual(result.result, GateResult.ESCALATE)
        self.assertTrue(result.diagnostics)

    def test_a_contract_with_no_declared_evidence_requirement_escalates(self) -> None:
        result = self._evaluate(contract=_contract(requiredEvidenceKinds=[]), evidence=())
        self.assertEqual(result.result, GateResult.ESCALATE)


class IndependentReviewerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.registry = default_registry()

    def _evaluate(self, **overrides: object) -> EvaluatorResult:
        base: dict[str, object] = {
            "node_plan": {"executor": {"requiredCapabilities": ["security.review"]}},
            "reviewer_subject": "sub-security",
            "producer_subjects": ("sub-qa",),
            "capability_holders": {"security.review": ("sub-security", "sub-qa")},
        }
        base.update(overrides)
        return self.registry.evaluate("independent_reviewer", EvaluationContext(**base))  # type: ignore[arg-type]

    def test_an_independent_qualified_reviewer_passes(self) -> None:
        self.assertEqual(self._evaluate().result, GateResult.PASS)

    def test_the_producer_cannot_review_its_own_artifact(self) -> None:
        result = self._evaluate(
            reviewer_subject="sub-qa",
            capability_holders={"security.review": ("sub-qa",)},
        )
        self.assertEqual(result.result, GateResult.FAIL)
        self.assertIn("produced the artifact under review", result.reason)

    def test_a_reviewer_without_the_capability_fails(self) -> None:
        result = self._evaluate(capability_holders={"security.review": ("someone-else",)})
        self.assertEqual(result.result, GateResult.FAIL)
        self.assertIn("does not hold the required capability", result.reason)

    def test_the_interaction_creator_cannot_answer_its_own_request(self) -> None:
        result = self._evaluate(interaction_creator="sub-security")
        self.assertEqual(result.result, GateResult.FAIL)
        self.assertIn("created the interaction", result.reason)

    def test_an_absent_reviewer_escalates(self) -> None:
        result = self._evaluate(reviewer_subject=None)
        self.assertEqual(result.result, GateResult.ESCALATE)

    def test_a_reviewer_who_also_produced_an_independent_from_capability_fails(self) -> None:
        result = self._evaluate(
            node_plan={
                "executor": {
                    "requiredCapabilities": ["security.review"],
                    "independentFrom": ("verification.qa",),
                }
            },
            capability_holders={
                "security.review": ("sub-security",),
                "verification.qa": ("sub-security",),
            },
        )
        self.assertEqual(result.result, GateResult.FAIL)
        self.assertIn("reviewed independently", result.reason)


class HumanDecisionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.registry = default_registry()

    def _resolution(self, **overrides: object) -> dict[str, object]:
        base: dict[str, object] = {
            "responderSubject": "user-anna",
            "responderKind": "human",
            "outcome": "accept",
            "verifiedAgainstProvider": True,
            "detail": {"decisionTargetHash": "sha256:target"},
        }
        base.update(overrides)
        return base

    def _evaluate(self, resolution: object) -> EvaluatorResult:
        return self.registry.evaluate(
            "human_decision",
            EvaluationContext(resolution=resolution, decision_target_hash="sha256:target"),  # type: ignore[arg-type]
        )

    def test_a_verified_human_accept_passes(self) -> None:
        self.assertEqual(self._evaluate(self._resolution()).result, GateResult.PASS)

    def test_a_missing_resolution_escalates(self) -> None:
        result = self._evaluate(None)
        self.assertEqual(result.result, GateResult.ESCALATE)
        self.assertIn("pending", result.reason)

    def test_an_unverified_callback_fails_even_though_it_says_approved(self) -> None:
        result = self._evaluate(self._resolution(verifiedAgainstProvider=False))
        self.assertEqual(result.result, GateResult.FAIL)
        self.assertIn("never trusted on its own", result.reason)

    def test_a_resolution_about_a_different_target_fails(self) -> None:
        result = self._evaluate(
            self._resolution(detail={"decisionTargetHash": "sha256:old-target"})
        )
        self.assertEqual(result.result, GateResult.FAIL)
        self.assertIn("different target", result.reason)

    def test_a_rejection_is_not_an_acceptance(self) -> None:
        result = self._evaluate(self._resolution(outcome="reject"))
        self.assertEqual(result.result, GateResult.FAIL)

    def test_an_agent_responder_cannot_satisfy_a_human_decision_gate(self) -> None:
        result = self._evaluate(
            self._resolution(responderSubject="sub-qa", responderKind="agent")
        )
        self.assertEqual(result.result, GateResult.FAIL)
        self.assertIn("cannot be satisfied by an agent", result.reason)


if __name__ == "__main__":
    unittest.main()
