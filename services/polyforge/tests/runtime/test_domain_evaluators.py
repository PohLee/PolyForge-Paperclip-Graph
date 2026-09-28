"""The eleven domain evaluators, and the registry that has to answer for them.

Two things are proven here. The first is coverage: every ref the shipped graph families reference
resolves, so no family can reach a mandatory check and ``ESCALATE`` for want of an implementation.
The second is direction: each check passes on good evidence and escalates on missing, empty, or
failing evidence. The escalating half is the half that matters -- a check that only ever passes is
indistinguishable from one that was never asked anything.
"""

from __future__ import annotations

import unittest

from polyforge.core.gates.aggregate import GateResult
from polyforge.core.gates.evaluators import EvaluationContext, default_registry
from polyforge.core.gates.evaluators_domain import DOMAIN_EVALUATORS
from polyforge.graph_library import EVALUATOR_VERSIONS, all_definitions

GENERIC_REFS = {"contract_schema_v1", "required_evidence_present", "independent_reviewer", "human_decision"}


def evidence(kind: str, detail: dict, *, producer: str = "human:reviewer") -> dict:
    return {
        "evidenceId": f"ev-{kind}",
        "kind": kind,
        "detail": detail,
        "valid": 1,
        "producerSubject": producer,
    }


def check(ref: str):
    """The evaluator with this ref, looked up rather than indexed.

    Indexing a factory's return value would tie every assertion to the order it happens to be
    built in, and a reordering would then fail as a set of unrelated behavioural errors.
    """
    for evaluator in DOMAIN_EVALUATORS():
        if evaluator.ref == ref:
            return evaluator
    raise AssertionError(f"no domain evaluator registered under {ref!r}")


def context(*records: dict, author: str = "agent:builder", **overrides) -> EvaluationContext:
    """A context shaped like the one the engine actually builds.

    The author is credited the way the engine credits it -- through the node's ``assigned_subject``
    and the upstream ``producer_subjects`` it computes from database rows. A free-floating
    ``run.author`` key does not exist in the runtime tables, so a fixture that supplied one let a
    separation check read an author that production could never have provided, and pass on the
    strength of a field that does not exist.
    """
    base = {
        "run": {"runId": "run-1", "graph_id": "g-1", "graph_version": 1, "entrypoint": "build", "status": "ACTIVE"},
        "node": {"nodeId": "node-1", "assigned_subject": author},
        "evidence": tuple(records),
        "now": "2026-01-01T00:00:00Z",
        "decision_target_hash": "rev-1",
        "producer_subjects": (author,) if author else (),
    }
    base.update(overrides)
    return EvaluationContext(**base)


class RegistryCoverageTests(unittest.TestCase):
    def test_every_ref_a_shipped_graph_references_is_registered(self) -> None:
        registry = default_registry()
        referenced: set[str] = set()
        for definition in all_definitions().values():
            for node in definition.get("nodes", {}).values():
                referenced.update(node.get("evaluatorRefs", ()) or ())
        self.assertTrue(referenced, "the graph library declares no evaluator refs at all")
        self.assertEqual(sorted(referenced - set(registry.refs())), [])

    def test_every_declared_evaluator_version_is_registered(self) -> None:
        self.assertEqual(sorted(set(EVALUATOR_VERSIONS) - set(default_registry().refs())), [])

    def test_the_registry_is_the_generic_checks_plus_the_domain_checks(self) -> None:
        self.assertEqual(set(default_registry().refs()), GENERIC_REFS | {e.ref for e in DOMAIN_EVALUATORS()})

    def test_the_domain_module_supplies_exactly_eleven_checks(self) -> None:
        self.assertEqual(len(DOMAIN_EVALUATORS()), 11)

    def test_a_registry_cannot_be_poisoned_by_a_shared_instance(self) -> None:
        # default_registry hands back fresh instances; if it cached them, a caller mutating one
        # evaluator would change every later registry in the process.
        first, second = default_registry(), default_registry()
        self.assertIsNot(first.get("test_report_check_v1"), second.get("test_report_check_v1"))

    def test_no_domain_check_passes_without_evidence(self) -> None:
        for evaluator in DOMAIN_EVALUATORS():
            with self.subTest(ref=evaluator.ref):
                result = evaluator.evaluate(context())
                self.assertEqual(result[0], GateResult.ESCALATE, f"{evaluator.ref} passed on no evidence")
                self.assertTrue(result[1].strip(), f"{evaluator.ref} escalated without saying why")


class RequirementCompletenessTests(unittest.TestCase):
    check = staticmethod(lambda ref="requirement_completeness_v1": check(ref))

    def test_it_escalates_when_no_criteria_are_stated(self) -> None:
        result = self.check().evaluate(context(evidence("requirement_spec", {})))
        self.assertEqual(result[0], GateResult.ESCALATE)
        self.assertIn("no acceptance criteria", result[1])

    def test_it_passes_when_criteria_are_stated(self) -> None:
        record = evidence("requirement_spec", {"acceptanceCriteria": ["AT-01 runs"]})
        self.assertEqual(self.check().evaluate(context(record))[0], GateResult.PASS)

    def test_it_escalates_when_the_author_wrote_their_own_requirement(self) -> None:
        # Independence, not humanity: an agent may author and an agent may review, but not both.
        record = evidence(
            "requirement_spec", {"acceptanceCriteria": ["AT-01"]}, producer="agent:builder"
        )
        result = self.check().evaluate(context(record))
        self.assertEqual(result[0], GateResult.ESCALATE)
        self.assertIn("authored the work", result[1])

    def test_a_different_agent_may_review_it(self) -> None:
        # A human-only rule would make the shipped families unrunnable by an agent team. Humanity is
        # a property a graph states with a humanDecision node; a check should not assume it.
        record = evidence(
            "requirement_spec", {"acceptanceCriteria": ["AT-01"]}, producer="agent:reviewer"
        )
        self.assertEqual(self.check().evaluate(context(record))[0], GateResult.PASS)


class AcceptanceCriteriaReviewTests(unittest.TestCase):
    check = staticmethod(lambda ref="acceptance_criteria_review_v1": check(ref))


    def test_a_dissenting_reviewer_escalates(self) -> None:
        record = evidence("acceptance_criteria_review", {"verdict": "disagree"})
        result = self.check().evaluate(context(record))
        self.assertEqual(result[0], GateResult.ESCALATE)
        self.assertIn("not agreed", result[1])

    def test_an_agreed_review_passes(self) -> None:
        record = evidence("acceptance_criteria_review", {"verdict": "agreed"})
        self.assertEqual(self.check().evaluate(context(record))[0], GateResult.PASS)

    def test_a_review_by_the_author_escalates(self) -> None:
        # The point of the check: the author agreeing with their own criteria proves nothing, so the
        # run's author is excluded from the set of acceptable producers.
        record = evidence("acceptance_criteria_review", {"verdict": "agreed"}, producer="agent:builder")
        result = self.check().evaluate(context(record))
        self.assertEqual(result[0], GateResult.ESCALATE)
        self.assertIn("authored the work", result[1])

    def test_a_different_agent_may_agree(self) -> None:
        record = evidence(
            "acceptance_criteria_review", {"verdict": "agreed"}, producer="agent:reviewer"
        )
        self.assertEqual(self.check().evaluate(context(record))[0], GateResult.PASS)


class ThreatModelReviewTests(unittest.TestCase):
    check = staticmethod(lambda ref="threat_model_review_v2": check(ref))

    def _evaluator(self):
        return self.check()

    def test_an_empty_threat_model_escalates(self) -> None:
        result = self.check().evaluate(context(evidence("threat_model", {"findings": []})))
        self.assertEqual(result[0], GateResult.ESCALATE)
        self.assertIn("names no threats", result[1])

    def test_a_named_threat_passes(self) -> None:
        record = evidence("threat_model", {"findings": [{"id": "T1", "severity": "high"}]})
        self.assertEqual(self.check().evaluate(context(record))[0], GateResult.PASS)


class TestReportTests(unittest.TestCase):
    check = staticmethod(lambda ref="test_report_check_v1": check(ref))

    def _evaluator(self):
        return self.check()

    def test_a_failing_run_escalates(self) -> None:
        result = self.check().evaluate(context(evidence("test_report", {"total": 10, "failed": 1})))
        self.assertEqual(result[0], GateResult.ESCALATE)
        self.assertIn("records failures", result[1])

    def test_a_run_with_no_tests_is_not_a_pass(self) -> None:
        result = self.check().evaluate(context(evidence("test_report", {"total": 0, "failed": 0})))
        self.assertEqual(result[0], GateResult.ESCALATE)
        self.assertIn("no tests at all", result[1])

    def test_a_negative_total_is_not_a_pass(self) -> None:
        # A count cannot be negative. Reading it as "not zero, therefore tests ran" turned a
        # malformed report into the one answer it must never be able to give.
        result = self.check().evaluate(context(evidence("test_report", {"total": -1, "failed": 0})))
        self.assertEqual(result[0], GateResult.ESCALATE)
        self.assertIn("total", result[1])

    def test_a_total_that_is_not_a_number_is_not_a_pass(self) -> None:
        record = evidence("test_report", {"total": "all", "failed": 0})
        self.assertEqual(self.check().evaluate(context(record))[0], GateResult.ESCALATE)

    def test_a_missing_total_is_not_a_pass(self) -> None:
        record = evidence("test_report", {"failed": 0})
        self.assertEqual(self.check().evaluate(context(record))[0], GateResult.ESCALATE)

    def test_a_green_run_passes(self) -> None:
        self.assertEqual(
            self.check().evaluate(context(evidence("test_report", {"total": 10, "failed": 0})))[0],
            GateResult.PASS,
        )


class ReviewFindingsTests(unittest.TestCase):
    check = staticmethod(lambda ref="review_findings_check_v1": check(ref))

    def _evaluator(self):
        return self.check()

    def test_an_unresolved_finding_escalates(self) -> None:
        record = evidence("code_review", {"findings": [{"id": "F1", "resolved": False}]})
        result = self.check().evaluate(context(record))
        self.assertEqual(result[0], GateResult.ESCALATE)
        self.assertIn("F1", result[1])

    def test_a_resolved_finding_passes(self) -> None:
        record = evidence("code_review", {"findings": [{"id": "F1", "resolved": True}]})
        self.assertEqual(self.check().evaluate(context(record))[0], GateResult.PASS)

    def test_a_review_with_no_findings_at_all_escalates(self) -> None:
        result = self.check().evaluate(context(evidence("code_review", {"findings": []})))
        self.assertEqual(result[0], GateResult.ESCALATE)


class QaReportTests(unittest.TestCase):
    check = staticmethod(lambda ref="qa_report_check_v2": check(ref))

    def _evaluator(self):
        return self.check()

    def test_a_failing_verdict_escalates(self) -> None:
        result = self.check().evaluate(context(evidence("qa_report", {"verdict": "fail"})))
        self.assertEqual(result[0], GateResult.ESCALATE)

    def test_a_verdict_from_an_older_revision_escalates(self) -> None:
        # The reason this check is v2: a green verdict that judged different inputs is not a pass.
        record = evidence("qa_report", {"verdict": "pass", "inputRevision": "rev-0"})
        result = self.check().evaluate(context(record))
        self.assertEqual(result[0], GateResult.ESCALATE)
        self.assertIn("has not been re-run", result[1])

    def test_a_current_verdict_passes(self) -> None:
        record = evidence("qa_report", {"verdict": "pass", "inputRevision": "rev-1"})
        self.assertEqual(self.check().evaluate(context(record))[0], GateResult.PASS)

    def test_a_verdict_that_names_no_input_revision_escalates(self) -> None:
        # The hole the v2 comparison left open: `if judged and current` meant a report that named
        # no input at all skipped the comparison entirely, so omitting the field was strictly better
        # than stating a stale one. Binding is the reason this check exists; it cannot be optional.
        result = self.check().evaluate(context(evidence("qa_report", {"verdict": "pass"})))
        self.assertEqual(result[0], GateResult.ESCALATE)
        self.assertIn("inputRevision", result[1])

    def test_a_verdict_is_not_a_pass_when_there_is_no_trusted_revision_to_bind_to(self) -> None:
        # Without a trusted current revision there is nothing to compare against, so a bare
        # "pass" cannot be checked and must not be accepted as one.
        record = evidence("qa_report", {"verdict": "pass", "inputRevision": "rev-1"})
        result = self.check().evaluate(
            context(record, decision_target_hash="", evidence_set_hash="")
        )
        self.assertEqual(result[0], GateResult.ESCALATE)


class SecurityReportTests(unittest.TestCase):
    check = staticmethod(lambda ref="security_report_check_v1": check(ref))

    def _evaluator(self):
        return self.check()

    def test_an_unresolved_critical_escalates(self) -> None:
        record = evidence("security_report", {"findings": [{"id": "S1", "severity": "critical", "resolved": False}]})
        self.assertEqual(self.check().evaluate(context(record))[0], GateResult.ESCALATE)

    def test_a_resolved_critical_passes(self) -> None:
        record = evidence("security_report", {"findings": [{"id": "S1", "severity": "critical", "resolved": True}]})
        self.assertEqual(self.check().evaluate(context(record))[0], GateResult.PASS)

    def test_an_unresolved_low_finding_is_below_the_bar(self) -> None:
        record = evidence("security_report", {"findings": [{"id": "S9", "severity": "low", "resolved": False}]})
        self.assertEqual(self.check().evaluate(context(record))[0], GateResult.PASS)

    def test_a_report_with_no_findings_field_is_not_a_clean_scan(self) -> None:
        # `findings` absent is not `findings: []`. An absent field meant the severity walk saw an
        # empty list, found no high or critical issue, and passed a report that had said nothing.
        result = self.check().evaluate(context(evidence("security_report", {})))
        self.assertEqual(result[0], GateResult.ESCALATE)
        self.assertIn("findings", result[1])

    def test_a_report_with_a_malformed_findings_field_escalates(self) -> None:
        record = evidence("security_report", {"findings": "none found"})
        self.assertEqual(self.check().evaluate(context(record))[0], GateResult.ESCALATE)

    def test_an_explicit_zero_finding_scan_passes(self) -> None:
        # The distinction the two tests above draw: a report that states an empty findings list has
        # argued "we looked and there was nothing", and that is a real answer.
        record = evidence("security_report", {"findings": []})
        self.assertEqual(self.check().evaluate(context(record))[0], GateResult.PASS)

    def test_a_finding_that_is_not_an_object_is_not_a_clean_scan(self) -> None:
        # `_findings` used to filter non-mappings out, so `findings: [42]` became an empty list and
        # read as "we looked and found nothing". Dropping an unreadable record is not the same as
        # having no findings, and it is the difference between a report that says nothing and one
        # that says there is nothing to say.
        result = self.check().evaluate(context(evidence("security_report", {"findings": [42]})))
        self.assertEqual(result[0], GateResult.ESCALATE)
        self.assertIn("finding", result[1])

    def test_a_resolved_field_that_is_a_string_is_not_a_resolved_field(self) -> None:
        # `bool("false")` is True in Python, so `"resolved": "false"` marked a critical finding as
        # closed. Only a real boolean says so.
        record = evidence(
            "security_report",
            {"findings": [{"id": "x", "severity": "critical", "resolved": "false"}]},
        )
        self.assertEqual(self.check().evaluate(context(record))[0], GateResult.ESCALATE)

    def test_an_unrecognised_severity_is_not_treated_as_the_lowest_one(self) -> None:
        # An unknown severity ranked 0 -- the same as "info" -- so a finding of `"unknown"`
        # importance passed a check whose entire job is the high and critical band.
        record = evidence(
            "security_report", {"findings": [{"id": "x", "severity": "unknown", "resolved": False}]}
        )
        self.assertEqual(self.check().evaluate(context(record))[0], GateResult.ESCALATE)

    def test_a_finding_with_no_id_is_not_a_reviewable_finding(self) -> None:
        record = evidence("security_report", {"findings": [{"severity": "critical", "resolved": False}]})
        self.assertEqual(self.check().evaluate(context(record))[0], GateResult.ESCALATE)

    def test_a_well_formed_resolved_critical_still_passes(self) -> None:
        # The pass path must survive the tightening, or "reject anything malformed" is just a way
        # of refusing every report.
        record = evidence(
            "security_report", {"findings": [{"id": "S1", "severity": "critical", "resolved": True}]}
        )
        self.assertEqual(self.check().evaluate(context(record))[0], GateResult.PASS)


class RegressionTests(unittest.TestCase):
    check = staticmethod(lambda ref="regression_check_v1": check(ref))

    def _evaluator(self):
        return self.check()

    def test_a_new_failure_escalates(self) -> None:
        record = evidence("regression_report", {"newFailures": ["login.spec.ts"]})
        self.assertEqual(self.check().evaluate(context(record))[0], GateResult.ESCALATE)

    def test_a_clean_regression_run_passes(self) -> None:
        record = evidence("regression_report", {"newFailures": []})
        self.assertEqual(self.check().evaluate(context(record))[0], GateResult.PASS)

    def test_a_regression_report_with_no_result_field_is_not_a_clean_run(self) -> None:
        result = self.check().evaluate(context(evidence("regression_report", {})))
        self.assertEqual(result[0], GateResult.ESCALATE)
        self.assertIn("newFailures", result[1])

    def test_a_regression_report_with_a_malformed_result_field_escalates(self) -> None:
        record = evidence("regression_report", {"newFailures": "none"})
        self.assertEqual(self.check().evaluate(context(record))[0], GateResult.ESCALATE)


class IndependentProducerTests(unittest.TestCase):
    """The separation property, read from fields the engine really populates.

    These exist because the previous implementation built its author set from ``node.author`` and
    ``run.author``. Neither exists: the runtime table is ``node_executions``, which carries
    ``assigned_subject`` and no author column, and the engine hands evaluators a run reduced to five
    keys. So the author set was always empty, and "someone other than the author produced this" was
    true of every non-empty producer set -- an unconditional pass wearing a check's clothes.
    """

    check = staticmethod(lambda ref="threat_model_review_v2": check(ref))

    def _threats(self, **kw):
        return evidence("threat_model", {"findings": [{"id": "T1", "severity": "high"}]}, **kw)

    def test_the_node_assigned_subject_counts_as_the_author(self) -> None:
        record = self._threats(producer="agent:builder")
        result = self.check().evaluate(context(record, node={"nodeId": "n", "assigned_subject": "agent:builder"}))
        self.assertEqual(result[0], GateResult.ESCALATE)
        self.assertIn("authored the work", result[1])

    def test_an_upstream_producer_counts_as_the_author(self) -> None:
        record = self._threats(producer="agent:architect")
        result = self.check().evaluate(
            context(record, producer_subjects=("agent:architect", "agent:builder"))
        )
        self.assertEqual(result[0], GateResult.ESCALATE)

    def test_a_producer_among_several_authors_counts_as_the_author(self) -> None:
        # Independence is per-producer, not per-run: a review by one of three upstream subjects is
        # still a review of the work by one of those three.
        record = self._threats(producer="agent:architect")
        result = self.check().evaluate(
            context(record, producer_subjects=("agent:builder", "agent:architect", "agent:qa"))
        )
        self.assertEqual(result[0], GateResult.ESCALATE)

    def test_a_genuinely_independent_producer_passes(self) -> None:
        record = self._threats(producer="agent:security")
        self.assertEqual(
            self.check().evaluate(context(record, producer_subjects=("agent:builder",)))[0],
            GateResult.PASS,
        )

    def test_independence_cannot_be_established_when_no_author_is_known(self) -> None:
        # Nothing names an author, so nothing establishes that the producer is not one. The honest
        # answer is to refuse, which is the direction this module's first rule already points.
        record = self._threats(producer="agent:security")
        result = self.check().evaluate(
            context(record, author="", node={"nodeId": "n"}, producer_subjects=())
        )
        self.assertEqual(result[0], GateResult.ESCALATE)

    def test_the_check_is_not_satisfied_by_a_run_author_key_the_engine_never_sends(self) -> None:
        # The exact shape the engine builds: no author column, a five-key run. The same subject
        # authored the work and produced the report, and this used to pass anyway.
        record = self._threats(producer="agent:builder")
        result = self.check().evaluate(
            context(
                record,
                run={"runId": "run-1", "graph_id": "g-1", "graph_version": 1, "entrypoint": "build", "status": "ACTIVE"},
                node={"nodeId": "n", "assigned_subject": "agent:builder"},
                producer_subjects=("agent:builder",),
            )
        )
        self.assertEqual(result[0], GateResult.ESCALATE)

    def test_a_gate_judging_upstream_work_is_not_being_suspicious_of_itself(self) -> None:
        # `design_gate` runs this check on a threat model the `security_review` node authored, and
        # the graph says so in as many words (design.py): a gate cannot author the thing it judges,
        # so the artifact is deliberately somebody else's. Grading the work of others is the gate's
        # entire purpose, and its separation requirement is expressed by `independentFrom` and the
        # generic independent_reviewer check. Folding upstream producers into this node's author set
        # would make the check unsatisfiable at every gate in the library.
        record = self._threats(producer="agent:security")
        result = self.check().evaluate(
            context(
                evidence=(),
                upstream_evidence=(record,),
                author="",
                node={"nodeId": "design_gate"},
                producer_subjects=("agent:security", "agent-arch"),
            )
        )
        self.assertEqual(result[0], GateResult.PASS)


class AuthorizationScopeTests(unittest.TestCase):
    check = staticmethod(lambda ref="authorization_scope_check_v1": check(ref))

    def _evaluator(self):
        return self.check()

    def test_the_absence_of_an_authorization_escalates(self) -> None:
        result = self.check().evaluate(context())
        self.assertEqual(result[0], GateResult.ESCALATE)
        self.assertIn("no authorisation covers this action", result[1])

    def test_a_granted_authorization_passes(self) -> None:
        result = self.check().evaluate(
            context(authorization={"state": "granted", "expiresAt": "2027-01-01T00:00:00Z"})
        )
        self.assertEqual(result[0], GateResult.PASS)

    def test_a_revoked_authorization_escalates(self) -> None:
        result = self.check().evaluate(context(authorization={"state": "revoked"}))
        self.assertEqual(result[0], GateResult.ESCALATE)

    def test_an_expired_authorization_escalates(self) -> None:
        result = self.check().evaluate(
            context(authorization={"state": "granted", "expiresAt": "2025-01-01T00:00:00Z"})
        )
        self.assertEqual(result[0], GateResult.ESCALATE)

    def test_a_capability_the_grant_does_not_cover_escalates(self) -> None:
        result = self.check().evaluate(
            context(
                authorization={
                    "state": "granted",
                    "capabilityRefs": ["cap.read"],
                },
                required_capabilities=("cap.deploy",),
            )
        )
        self.assertEqual(result[0], GateResult.ESCALATE)
        self.assertIn("cap.deploy", result[1])


class DeploymentVerificationTests(unittest.TestCase):
    check = staticmethod(lambda ref="deployment_verification_v1": check(ref))

    def _evaluator(self):
        return self.check()

    def test_a_deployment_nobody_could_have_performed_escalates(self) -> None:
        record = evidence("deployment_record", {"verified": True})
        result = self.check().evaluate(
            context(record, required_capabilities=("cap.deploy",), capability_holders={})
        )
        self.assertEqual(result[0], GateResult.ESCALATE)
        self.assertIn("no subject holds the capability", result[1])

    def test_an_unverified_record_escalates(self) -> None:
        record = evidence("deployment_record", {"verified": False})
        self.assertEqual(self.check().evaluate(context(record))[0], GateResult.ESCALATE)

    def test_a_verified_record_with_the_capability_passes(self) -> None:
        record = evidence("deployment_record", {"verified": True})
        result = self.check().evaluate(
            context(record, required_capabilities=("cap.deploy",), capability_holders={"cap.deploy": ("human:ops",)})
        )
        self.assertEqual(result[0], GateResult.PASS)


class RollbackReadinessTests(unittest.TestCase):
    check = staticmethod(lambda ref="rollback_readiness_v1": check(ref))

    def _evaluator(self):
        return self.check()

    def test_an_unrehearsed_plan_escalates(self) -> None:
        record = evidence("rollback_plan", {"procedure": "redeploy previous tag", "rehearsed": False})
        result = self.check().evaluate(context(record))
        self.assertEqual(result[0], GateResult.ESCALATE)
        self.assertIn("never been rehearsed", result[1])

    def test_a_rehearsed_plan_passes(self) -> None:
        record = evidence("rollback_plan", {"procedure": "redeploy previous tag", "rehearsed": True})
        self.assertEqual(self.check().evaluate(context(record))[0], GateResult.PASS)


class InvalidEvidenceTests(unittest.TestCase):
    check = staticmethod(lambda ref="test_report_check_v1": check(ref))

    def test_invalidated_evidence_does_not_satisfy_a_check(self) -> None:
        # The engine hands invalidated records over separately, so that is where a stale record
        # belongs; leaving it inside `evidence` would only prove the list gets filtered, which is
        # the engine's job and not this check's.
        stale = evidence("test_report", {"total": 10, "failed": 0})
        result = self.check().evaluate(context(invalid_evidence=(stale,)))
        self.assertEqual(result[0], GateResult.ESCALATE)

    def test_the_reason_names_the_records_that_were_invalidated(self) -> None:
        # An operator needs to know the difference between "nobody wrote a report" and "a report was
        # written and then invalidated", because the remedy is different in each case.
        stale = evidence("test_report", {"total": 1})
        result = self.check().evaluate(context(invalid_evidence=(stale,)))
        self.assertIn("invalidated", result[1])

    def test_a_stale_pass_cannot_rescue_a_failing_report(self) -> None:
        # The invalidation has to win regardless of what the invalidated copy claimed, or a check
        # could be satisfied by evidence the Core has already rejected.
        failing = evidence("qa_report", {"verdict": "fail"})
        stale_pass = evidence("qa_report", {"verdict": "pass"})
        result = self.check().evaluate(context(failing, invalid_evidence=(stale_pass,)))
        self.assertEqual(result[0], GateResult.ESCALATE)


class EvidenceScopeTests(unittest.TestCase):
    """What widening a gate's view to its predecessors must not do.

    The gate could not see the threat model the independent review upstream authored, so
    ``evidence_in_scope`` lets a check read it. That is only safe while the node's own evidence
    contract stays node-scoped: otherwise an upstream node's output would silently satisfy a
    requirement this node never produced, and the gate would be approving work on its behalf.
    """

    check = staticmethod(lambda ref="threat_model_review_v2": check(ref))

    def _upstream_only(self) -> EvaluationContext:
        return context(
            upstream_evidence=(
                evidence("threat_model", {"findings": [{"id": "T1", "severity": "high"}]}),
            )
        )

    def test_a_check_can_read_an_upstream_record(self) -> None:
        result = self.check().evaluate(self._upstream_only())
        self.assertEqual(result[0], GateResult.PASS)

    def test_the_nodes_own_record_wins_over_an_upstream_one(self) -> None:
        # The node's own claim is the more direct one; if it is unusable, falling back to an
        # upstream record would hide that the node said nothing.
        both = context(
            evidence("threat_model", {"findings": []}),
            upstream_evidence=(
                evidence("threat_model", {"findings": [{"id": "T1", "severity": "low"}]}),
            ),
        )
        result = self.check("threat_model_review_v2").evaluate(both)
        self.assertEqual(result[0], GateResult.ESCALATE)
        self.assertIn("names no threats", result[1])

    def test_an_invalid_upstream_record_is_not_a_fallback(self) -> None:
        stale = evidence("threat_model", {"findings": [{"id": "T1"}]})
        result = self.check("threat_model_review_v2").evaluate(
            context(upstream_evidence=(dict(stale, valid=0),))
        )
        self.assertEqual(result[0], GateResult.ESCALATE)

    def test_a_nodes_evidence_contract_is_not_satisfied_by_an_upstream_record(self) -> None:
        # The guarantee that makes the widening safe.
        from polyforge.core.gates.evaluators import _RequiredEvidencePresent

        node_scoped = _RequiredEvidencePresent().evaluate(
            context(
                contract={"requiredEvidenceKinds": ["threat_model"]},
                upstream_evidence=(
                    evidence("threat_model", {"findings": [{"id": "T1"}]}),
                ),
            )
        )
        self.assertEqual(node_scoped[0], GateResult.ESCALATE)
        self.assertIn("no valid evidence of kind 'threat_model'", node_scoped[1])


if __name__ == "__main__":
    unittest.main()
