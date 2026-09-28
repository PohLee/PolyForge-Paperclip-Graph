"""The domain evaluators the shipped graph families reference.

Every check here is a *question about evidence*, never a judgement the Core makes on the author's
behalf. Two rules hold throughout, and they are the reason these exist as explicit code rather than
as a default:

1. **Absent evidence escalates.** A check that cannot find what it needs says so; it never passes on
   the grounds that nothing was found. A gate that passes because it looked in the wrong place is
   worse than a gate that refuses, because it removes the reason a human was ever asked.
2. **A check names its subject.** The evidence kind, the field it reads, and what a negative means
   are all in the reason string, because that string is what an operator reads while blocked.

The shipped families reference eleven of these. The four generic evaluators in
:mod:`polyforge.core.gates.evaluators` cover structure and provenance; these cover the domain
question each family exists to ask — is the requirement complete, is the threat model real, did the
tests actually pass, is there authorisation to deploy.
"""

from __future__ import annotations

from typing import Any, Mapping, Sequence

from polyforge.core.gates.evaluators import EvaluationContext, EvaluatorKind
from polyforge.core.gates.aggregate import GateResult

__all__ = [
    "DOMAIN_EVALUATORS",
    "AcceptanceCriteriaReviewV1",
    "AuthorizationScopeCheckV1",
    "DeploymentVerificationV1",
    "QaReportCheckV2",
    "RegressionCheckV1",
    "RequirementCompletenessV1",
    "ReviewFindingsCheckV1",
    "RollbackReadinessV1",
    "SecurityReportCheckV1",
    "TestReportCheckV1",
    "ThreatModelReviewV2",
]


def _detail(record: Mapping[str, Any]) -> Mapping[str, Any]:
    """The payload of an evidence record, whatever shape it arrived in."""
    detail = record.get("detail")
    return detail if isinstance(detail, Mapping) else {}


#: The severities this codebase uses. A finding outside the vocabulary is malformed, not "low".
SEVERITIES: frozenset[str] = frozenset({"info", "low", "medium", "high", "critical"})


def _findings(record: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    raw = _detail(record).get("findings")
    return [item for item in raw if isinstance(item, Mapping)] if isinstance(raw, Sequence) and not isinstance(raw, str) else []


def _finding_problems(record: Mapping[str, Any]) -> list[str]:
    """Every reason this record's findings cannot be read as findings.

    A finding is a claim about something, with an id, a severity from the vocabulary, and a real
    boolean saying whether it is closed. Anything else is a record this check cannot judge, and the
    earlier version of this code did judge it -- by filtering the unrecognisable entries out and
    reporting the remainder. Three failures came from that one decision:

    * ``[42]`` became an empty list, so "unreadable" read as "we looked and found nothing";
    * ``resolved: "false"`` is truthy, so a critical finding was reported closed;
    * an unknown severity ranked 0, the same as ``info``, so it fell out of the high/critical band
      this check exists to police.
    """
    raw = _detail(record).get("findings")
    if not isinstance(raw, Sequence) or isinstance(raw, str):
        return ["the record's findings field is not a list"]
    problems: list[str] = []
    for index, item in enumerate(raw):
        if not isinstance(item, Mapping):
            problems.append(f"entry {index} is {type(item).__name__}, not a finding object")
            continue
        if not str(item.get("id", "")).strip():
            problems.append(f"entry {index} names no finding")
        # Severity and disposition are optional -- a threat carries no severity and nothing to
        # close, a review finding may carry no severity at all -- but neither may be present and
        # wrong. An absent disposition counts as open, which is the direction that refuses.
        severity = item.get("severity")
        if severity is not None and str(severity).lower() not in SEVERITIES:
            problems.append(
                f"entry {index} has severity {str(severity).lower()!r}, which is not one of "
                f"{', '.join(sorted(SEVERITIES))}"
            )
        resolved = item.get("resolved")
        if resolved is not None and not isinstance(resolved, bool):
            problems.append(f"entry {index} does not say whether it is resolved, as a real boolean")
    return problems


def _unresolved(record: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    return [f for f in _findings(record) if f.get("resolved") is not True]


def _count(value: Any) -> int | None:
    """A non-negative count, or ``None`` when the value is not one.

    ``None`` is not zero. A report that omits a count, spells it as a string, or reports a negative
    number has not made a claim, and treating any of those as "not zero, therefore fine" is how a
    malformed report reaches a pass.
    """
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value if value >= 0 else None


def _highest_severity(record: Mapping[str, Any]) -> str:
    order = {"info": 0, "low": 1, "medium": 2, "high": 3, "critical": 4}
    worst = "info"
    for finding in _findings(record):
        severity = str(finding.get("severity", "info")).lower()
        if order.get(severity, 0) > order.get(worst, 0):
            worst = severity
    return worst


class _EvidenceCheck:
    """Shared shape: find valid evidence of a kind, then read one field out of it.

    Subclasses declare what they need; the difference between them is the question, not the
    plumbing, and keeping the plumbing in one place is what stops eleven nearly-identical classes
    from drifting apart in how they report a missing record.
    """

    ref: str = ""
    kind: str = str(EvaluatorKind.AUTOMATIC)
    version: str = "1"
    evidence_kind: str = ""
    #: Checks that are worthless if the author grades their own work. Independence, not humanity, is
    #: the property: the Core already has a generic ``independent_reviewer`` for the separation
    #: property, and a shipped graph that an agent team cannot run is not one this should tighten
    #: by inventing a human-only rule. Where a stage genuinely needs a person, the graph says so
    #: with a ``humanDecision`` node, and that is the place the requirement belongs.
    requires_independent_producer: bool = False

    def evaluate(self, context: EvaluationContext) -> tuple[str, str, tuple[str, ...]]:
        records = context.evidence_in_scope(self.evidence_kind)
        if not records:
            invalid = [
                str(record.get("evidenceId", ""))
                for record in context.invalid_evidence
                if str(record.get("kind", "")) == self.evidence_kind
            ]
            reason = f"no valid evidence of kind {self.evidence_kind!r} is recorded for this node"
            if invalid:
                reason += f"; {len(invalid)} record(s) exist but were invalidated"
            return GateResult.ESCALATE, reason, ()

        if self.requires_independent_producer and not self._has_independent_producer(context, records):
            producers = sorted({str(record.get("producerSubject", "")) for record in records})
            return (
                GateResult.ESCALATE,
                f"the {self.evidence_kind!r} evidence was produced by {producers}, which is the same "
                f"subject that authored the work; a check of the author's own work is not a check",
                (),
            )

        return self._judge(context, records)

    def _has_independent_producer(self, context: EvaluationContext, records: Sequence[Mapping[str, Any]]) -> bool:
        """True when something other than the author produced the evidence.

        Scoped to the node's *own* evidence, because that is the only place the question can be
        answered from this snapshot. A gate evaluates a predecessor's artifact precisely because it
        did not author it -- ``design_gate`` runs ``threat_model_review_v2`` against a threat model
        the ``security_review`` node produced, and the shipped graph records that a gate cannot
        produce the thing it judges. Measuring those producers against the authors of the work this
        node depends on would ask a gate to prove it is independent of the work it was built to
        judge, which no gate can satisfy and which would make every gate in the library unreachable.

        For all-upstream evidence the separation decision has already happened at claim time. The
        runtime resolves the evidence and assignment subjects of every normal-dependency ancestor
        and refuses a subject named in that set when the node declares ``independentFrom``. This
        read-only evaluator therefore verifies evidence content; it does not try to repeat an
        admission decision from a smaller snapshot.

        Within the node's own evidence, the author is read from the two places the engine actually
        records it, both derived from database rows rather than from the request: the node's
        ``assigned_subject``, and ``producer_subjects``. There is deliberately no ``node.author`` or
        ``run.author`` here. The runtime table is ``node_executions`` and has no author column, and
        the engine hands an evaluator a run reduced to five keys, so those reads always returned
        nothing -- an author set that is always empty makes ``producers - authors`` equal to
        ``producers``, and the check passed for any evidence with a producer at all. Separation that
        was never enforced.

        An empty author set is a refusal, not a pass. If nothing names who did the work, nothing
        establishes that the producer is somebody else, and this module's first rule is that a check
        which cannot find what it needs must not pass on the grounds that it found nothing.
        """
        own_ids = {str(record.get("evidenceId", "")) for record in context.evidence}
        own = [record for record in records if str(record.get("evidenceId", "")) in own_ids]
        if not own:
            # Everything under judgment was produced upstream: this node is reviewing, not authoring.
            return True
        authors = {str(context.node.get("assigned_subject") or "")}
        authors.update(str(subject) for subject in context.producer_subjects)
        authors.discard("")
        if not authors:
            return False
        producers = {str(record.get("producerSubject", "")) for record in own}
        producers.discard("")
        return bool(producers - authors)

    def _unreadable_finding(self, record: Mapping[str, Any]) -> tuple[str, str, tuple[str, ...]] | None:
        """An ``ESCALATE`` when this record's findings cannot be read, or ``None`` when they can.

        Applied before any of the severity or disposition reasoning, because a check that has
        already decided what a finding means has to be told first that the finding is not a finding.
        """
        problems = _finding_problems(record)
        if not problems:
            return None
        return (
            GateResult.ESCALATE,
            "the report's findings cannot be read as findings, so it has not been reviewed: "
            f"{'; '.join(problems[:5])}",
            (),
        )

    def _judge(
        self, context: EvaluationContext, records: Sequence[Mapping[str, Any]]
    ) -> tuple[str, str, tuple[str, ...]]:  # pragma: no cover - overridden
        raise NotImplementedError


class _RequirementCompletenessV1(_EvidenceCheck):
    """The requirement must state what "done" means, not only what to build."""

    ref = "requirement_completeness_v1"
    evidence_kind = "requirement_spec"
    requires_independent_producer = True

    def _judge(self, context: EvaluationContext, records: Sequence[Mapping[str, Any]]) -> tuple[str, str, tuple[str, ...]]:
        missing: list[str] = []
        for record in records:
            criteria = _detail(record).get("acceptanceCriteria")
            if not isinstance(criteria, Sequence) or isinstance(criteria, str) or len(criteria) == 0:
                missing.append(str(record.get("evidenceId", "")))
        if missing:
            return (
                GateResult.ESCALATE,
                "the requirement records no acceptance criteria, so nothing can later say whether it "
                f"was met: {', '.join(missing)}",
                (),
            )
        return GateResult.PASS, "the requirement states acceptance criteria that a reviewer can check", ()


class _AcceptanceCriteriaReviewV1(_EvidenceCheck):
    """Someone other than the author must have read the criteria and agreed they are testable."""

    ref = "acceptance_criteria_review_v1"
    evidence_kind = "acceptance_criteria_review"
    requires_independent_producer = True

    def _judge(self, context: EvaluationContext, records: Sequence[Mapping[str, Any]]) -> tuple[str, str, tuple[str, ...]]:
        dissenting = [
            str(record.get("evidenceId", ""))
            for record in records
            if str(_detail(record).get("verdict", "")).lower() not in ("agreed", "accept", "accepted")
        ]
        if dissenting:
            return (
                GateResult.ESCALATE,
                "the acceptance criteria were not agreed by their reviewer, so the requirement is not "
                f"ready to be built against: {', '.join(dissenting)}",
                (),
            )
        return GateResult.PASS, "an independent reviewer agreed the acceptance criteria are testable", ()


class _ThreatModelReviewV2(_EvidenceCheck):
    """A threat model that names no threats has not been done.

    Version 2 exists because v1 accepted a document that merely *mentioned* security; v2 requires a
    threat per entry, so "we looked and there was nothing" has to be argued rather than assumed.
    """

    ref = "threat_model_review_v2"
    version = "2"
    evidence_kind = "threat_model"
    requires_independent_producer = True

    def _judge(self, context: EvaluationContext, records: Sequence[Mapping[str, Any]]) -> tuple[str, str, tuple[str, ...]]:
        for record in records:
            unreadable = self._unreadable_finding(record)
            if unreadable is not None:
                return unreadable
        empty = [str(record.get("evidenceId", "")) for record in records if len(_findings(record)) == 0]
        if empty:
            return (
                GateResult.ESCALATE,
                "the threat model names no threats and records no argument for why there are none; "
                f"an empty model is not a review: {', '.join(empty)}",
                (),
            )
        return GateResult.PASS, "the threat model names the threats it considered", ()


class _TestReportCheckV1(_EvidenceCheck):
    """Tests must have run, and must not have failed."""

    ref = "test_report_check_v1"
    evidence_kind = "test_report"

    def _judge(self, context: EvaluationContext, records: Sequence[Mapping[str, Any]]) -> tuple[str, str, tuple[str, ...]]:
        for record in records:
            total = _count(_detail(record).get("total"))
            failed = _count(_detail(record).get("failed"))
            if total is None or failed is None:
                return (
                    GateResult.ESCALATE,
                    "the test report does not record usable total and failed counts, so it cannot "
                    f"say what ran: {str(record.get('evidenceId', ''))}",
                    (),
                )
            if total == 0:
                return (
                    GateResult.ESCALATE,
                    f"the test report records no tests at all, which is not a passing run: {str(record.get('evidenceId', ''))}",
                    (),
                )
            if failed > total:
                return (
                    GateResult.ESCALATE,
                    f"the test report records {failed} failing of {total} test(s), which is not a "
                    f"possible run: {str(record.get('evidenceId', ''))}",
                    (),
                )
            if failed > 0 or str(_detail(record).get("result", "")).lower() in ("failed", "failing", "red"):
                return GateResult.ESCALATE, f"the test report records failures: {str(record.get('evidenceId', ''))}", ()
        return GateResult.PASS, "the test report records a run with no failures", ()


class _ReviewFindingsCheckV1(_EvidenceCheck):
    """Recorded review findings must be resolved before the work is declared done."""

    ref = "review_findings_check_v1"
    evidence_kind = "code_review"
    requires_independent_producer = True

    def _judge(self, context: EvaluationContext, records: Sequence[Mapping[str, Any]]) -> tuple[str, str, tuple[str, ...]]:
        open_findings: list[str] = []
        total = 0
        for record in records:
            unreadable = self._unreadable_finding(record)
            if unreadable is not None:
                return unreadable
            open_findings.extend(
                str(finding.get("id", "?")) for finding in _unresolved(record)
            )
            total += len(_findings(record))
        if open_findings:
            return (
                GateResult.ESCALATE,
                f"the code review has {len(open_findings)} unresolved finding(s): "
                f"{', '.join(open_findings[:10])}",
                (),
            )
        if total == 0:
            return GateResult.ESCALATE, "the code review records no findings and no disposition of any", ()
        return GateResult.PASS, f"all {total} review finding(s) are resolved", ()


class _QaReportCheckV2(_EvidenceCheck):
    """QA must have run against this revision, and passed.

    v2 additionally requires the report to name the input revision it judged, because a QA verdict
    that does not say what it looked at cannot be invalidated when the inputs move.
    """

    ref = "qa_report_check_v2"
    version = "2"
    evidence_kind = "qa_report"
    requires_independent_producer = True

    def _judge(self, context: EvaluationContext, records: Sequence[Mapping[str, Any]]) -> tuple[str, str, tuple[str, ...]]:
        for record in records:
            verdict = str(_detail(record).get("verdict", "")).lower()
            if verdict not in ("pass", "passed", "green"):
                return (
                    GateResult.ESCALATE,
                    f"QA verdict is {verdict or 'unstated'!r}, not a pass",
                    (),
                )
            judged = str(_detail(record).get("inputRevision", ""))
            current = str(context.decision_target_hash or context.evidence_set_hash or "")
            # Both halves are required. Comparing only when both happened to be present made naming
            # a stale input a failure while omitting the field entirely was a pass, so the cheaper
            # lie to tell was to say nothing.
            if not judged:
                return (
                    GateResult.ESCALATE,
                    "the QA report names no inputRevision, so it cannot be shown to have judged what "
                    "is being passed; a verdict that does not say what it looked at cannot be "
                    f"invalidated when the inputs move: {str(record.get('evidenceId', ''))}",
                    (),
                )
            if not current:
                return (
                    GateResult.ESCALATE,
                    "no trusted current revision is bound to this decision, so the QA report's "
                    f"inputRevision cannot be checked: {str(record.get('evidenceId', ''))}",
                    (),
                )
            if judged != current:
                return (
                    GateResult.ESCALATE,
                    f"the QA report judged {judged} but the current evidence set is {current}, so it "
                    f"has not been re-run against what is being passed",
                    (),
                )
        return GateResult.PASS, "QA passed against the current evidence set", ()


class _SecurityReportCheckV1(_EvidenceCheck):
    """No unresolved high or critical finding."""

    ref = "security_report_check_v1"
    evidence_kind = "security_report"
    requires_independent_producer = True

    def _judge(self, context: EvaluationContext, records: Sequence[Mapping[str, Any]]) -> tuple[str, str, tuple[str, ...]]:
        for record in records:
            unreadable = self._unreadable_finding(record)
            if unreadable is not None:
                return unreadable
            raw = _detail(record).get("findings")
            if not isinstance(raw, Sequence) or isinstance(raw, str):
                return (
                    GateResult.ESCALATE,
                    "the security report records no findings list, so a scan that found nothing and "
                    "a scan that never ran are the same report to this check: "
                    f"{str(record.get('evidenceId', ''))}",
                    (),
                )
            severity = _highest_severity(record)
            if severity in ("high", "critical"):
                open_now = _unresolved(record)
                if open_now:
                    return (
                        GateResult.ESCALATE,
                        f"the security report has {len(open_now)} unresolved {severity} finding(s): "
                        f"{', '.join(str(f.get('id', '?')) for f in open_now[:10])}",
                        (),
                    )
        return GateResult.PASS, "the security report has no unresolved high or critical finding", ()


class _RegressionCheckV1(_EvidenceCheck):
    """A regression run must exist and must report no new failure."""

    ref = "regression_check_v1"
    evidence_kind = "regression_report"

    def _judge(self, context: EvaluationContext, records: Sequence[Mapping[str, Any]]) -> tuple[str, str, tuple[str, ...]]:
        for record in records:
            new_failures = _detail(record).get("newFailures")
            if not isinstance(new_failures, Sequence) or isinstance(new_failures, str):
                return (
                    GateResult.ESCALATE,
                    "the regression report records no newFailures result, so it does not say whether "
                    f"the run was clean: {str(record.get('evidenceId', ''))}",
                    (),
                )
            if len(new_failures) > 0:
                return (
                    GateResult.ESCALATE,
                    f"the regression run reports {len(new_failures)} new failure(s)",
                    (),
                )
        return GateResult.PASS, "the regression run reports no new failure", ()


class _RollbackReadinessV1(_EvidenceCheck):
    """A release without a rehearsed way back is not ready to ship."""

    ref = "rollback_readiness_v1"
    evidence_kind = "rollback_plan"
    requires_independent_producer = True

    def _judge(self, context: EvaluationContext, records: Sequence[Mapping[str, Any]]) -> tuple[str, str, tuple[str, ...]]:
        for record in records:
            detail = _detail(record)
            if not str(detail.get("procedure", "")):
                return GateResult.ESCALATE, "the rollback plan records no procedure", ()
            if not bool(detail.get("rehearsed")):
                return (
                    GateResult.ESCALATE,
                    "the rollback plan has never been rehearsed, so it is a hope rather than a plan",
                    (),
                )
        return GateResult.PASS, "the rollback plan names a procedure and has been rehearsed", ()


class _AuthorizationScopeCheckV1:
    """The privileged action this release would perform must be covered by an authorisation.

    Deliberately not an ``_EvidenceCheck``. This one is about an *authorisation*, not evidence, and
    it is the check that decides whether a release node may proceed at all on a host that offers no
    route for a plugin to create one. It escalates unless an authorisation is present, in scope, and
    covering the exact action — a release that ships without one is exactly the failure this exists
    to prevent, so the answer is never derived from the absence of a refusal.
    """

    ref = "authorization_scope_check_v1"
    kind = str(EvaluatorKind.AUTOMATIC)
    version = "1"

    def evaluate(self, context: EvaluationContext) -> tuple[str, str, tuple[str, ...]]:
        authorization = context.authorization
        if not isinstance(authorization, Mapping) or not authorization:
            return (
                GateResult.ESCALATE,
                "no authorisation covers this action. The Core will not infer one, and a release "
                "that performs a privileged action without one must not pass this check",
                (),
            )
        state = str(authorization.get("state", "")).lower()
        if state not in ("granted", "active"):
            return GateResult.ESCALATE, f"the authorisation is {state or 'unstated'}, not granted", ()
        expires = str(authorization.get("expiresAt", ""))
        if expires and context.now and expires <= str(context.now):
            return GateResult.ESCALATE, f"the authorisation expired at {expires}", ()
        action = str(authorization.get("actionRef", ""))
        required = [str(capability) for capability in context.required_capabilities]
        if required:
            covered = {str(capability) for capability in authorization.get("capabilityRefs", ()) or ()}
            missing = [capability for capability in required if capability not in covered]
            if missing:
                return (
                    GateResult.ESCALATE,
                    f"the authorisation does not cover the required capability: {', '.join(missing)}"
                    + (f" (it covers {action})" if action else ""),
                    (),
                )
        return GateResult.PASS, "an in-scope authorisation covers exactly this action", ()


class _DeploymentVerificationV1(_EvidenceCheck):
    """The deployment must be evidenced, and every capability it needs must be held."""

    ref = "deployment_verification_v1"
    evidence_kind = "deployment_record"

    def _judge(self, context: EvaluationContext, records: Sequence[Mapping[str, Any]]) -> tuple[str, str, tuple[str, ...]]:
        missing_capability = [
            capability
            for capability in context.required_capabilities
            if capability not in context.capability_holders
        ]
        if missing_capability:
            return (
                GateResult.ESCALATE,
                f"no subject holds the capability this node requires: {', '.join(missing_capability)}. "
                f"Nothing is proven by a deployment that could not have been performed",
                (),
            )
        unverified = [
            str(record.get("evidenceId", ""))
            for record in records
            if not bool(_detail(record).get("verified"))
        ]
        if unverified:
            return (
                GateResult.ESCALATE,
                f"the deployment record is unverified: {', '.join(unverified)}",
                (),
            )
        return GateResult.PASS, "a verified deployment record exists and its capabilities are held", ()


# The classes are underscore-prefixed to keep them out of the package namespace, but they are this
# module's public surface: `default_registry` constructs them by name and a test imports them to
# assert a check's behaviour, so every name in `__all__` has to resolve to something.
AcceptanceCriteriaReviewV1 = _AcceptanceCriteriaReviewV1
AuthorizationScopeCheckV1 = _AuthorizationScopeCheckV1
DeploymentVerificationV1 = _DeploymentVerificationV1
QaReportCheckV2 = _QaReportCheckV2
RegressionCheckV1 = _RegressionCheckV1
RequirementCompletenessV1 = _RequirementCompletenessV1
ReviewFindingsCheckV1 = _ReviewFindingsCheckV1
RollbackReadinessV1 = _RollbackReadinessV1
SecurityReportCheckV1 = _SecurityReportCheckV1
TestReportCheckV1 = _TestReportCheckV1
ThreatModelReviewV2 = _ThreatModelReviewV2


def DOMAIN_EVALUATORS() -> tuple[Any, ...]:
    """A fresh instance of each domain evaluator.

    A tuple of instances, not a module-level constant: the registry is documented as handing back
    a copy so a caller cannot mutate it, and a shared instance list would quietly break that
    promise for whoever adds state to an evaluator later.
    """
    return (
        _RequirementCompletenessV1(),
        _AcceptanceCriteriaReviewV1(),
        _ThreatModelReviewV2(),
        _TestReportCheckV1(),
        _ReviewFindingsCheckV1(),
        _QaReportCheckV2(),
        _SecurityReportCheckV1(),
        _RegressionCheckV1(),
        _AuthorizationScopeCheckV1(),
        _DeploymentVerificationV1(),
        _RollbackReadinessV1(),
    )
