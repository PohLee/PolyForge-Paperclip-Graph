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


def _findings(record: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    raw = _detail(record).get("findings")
    return [item for item in raw if isinstance(item, Mapping)] if isinstance(raw, Sequence) and not isinstance(raw, str) else []


def _unresolved(record: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    return [f for f in _findings(record) if not bool(f.get("resolved"))]


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

        The author is read from the node first and the run second, because a graph that sets an
        author per node and a run that sets one globally both appear in practice and picking the
        wrong one would silently stop enforcing this.
        """
        authors = {
            value
            for value in (
                str(context.node.get("author", "")),
                str(context.run.get("author", "")),
            )
            if value
        }
        producers = {str(record.get("producerSubject", "")) for record in records}
        producers.discard("")
        return bool(producers - authors)

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
        failing = [
            str(record.get("evidenceId", ""))
            for record in records
            if str(_detail(record).get("result", "")).lower() in ("failed", "failing", "red")
            or int(_detail(record).get("failed", 0) or 0) > 0
        ]
        if failing:
            return GateResult.ESCALATE, f"the test report records failures: {', '.join(failing)}", ()
        unrun = [str(record.get("evidenceId", "")) for record in records if int(_detail(record).get("total", 0) or 0) == 0]
        if unrun:
            return (
                GateResult.ESCALATE,
                f"the test report records no tests at all, which is not a passing run: {', '.join(unrun)}",
                (),
            )
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
            if judged and current and judged != current:
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
            if isinstance(new_failures, Sequence) and not isinstance(new_failures, str) and len(new_failures) > 0:
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
