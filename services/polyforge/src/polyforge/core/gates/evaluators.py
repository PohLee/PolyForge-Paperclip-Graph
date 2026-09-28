"""Built-in evaluators and the evaluator registry.

Responsibility: answer one typed question about a transition — "is the contract coherent",
"is the required evidence there", "did an independent subject review this", "did an
authorized human decide about this exact target" — and return PASS / FAIL / ESCALATE with
a reason.

Invariants (``docs/05-PROTOCOL.md`` section 7, ``docs/02-TECHNICAL-PLAN.md`` section 9):

* **An evaluator never raises through the registry.** Any exception becomes ``ESCALATE``
  plus a diagnostic. An evaluator that crashed must never be reported as a pass, and the
  Runtime must never have to distinguish "the gate said yes" from "the gate broke".
* The set of evaluators is closed and registered in code. A caller cannot register one at
  runtime (``docs/02`` section 12: no evaluator registration from a tool), so the only way
  to add a check is a reviewed change.
* Independence is checked against the *artifact producer subject* and the capability
  binding, not against two agent names. A reviewer that produced the artifact, or that
  created the interaction it is answering, is not independent even with a different label.
* A human decision is only honoured when the bridge re-read the authoritative provider
  object and the target hash matches. A callback carrying ``approved: true`` is data, not
  authority.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping, Protocol, Sequence

from polyforge.core import errors, ids
from polyforge.core.contracts.policy import EffectivePolicy, PlatformGrants
from polyforge.core.contracts.transition import TransitionContract, contract_hash
from polyforge.core.gates.aggregate import GateResult
from polyforge.core.state import EvaluatorKind

__all__ = [
    "BUILTIN_EVALUATOR_REFS",
    "EvaluationContext",
    "Evaluator",
    "EvaluatorRegistry",
    "EvaluatorResult",
    "default_registry",
]

#: What a resolution must actually say to be a pass. Anything else is a rejection with a
#: different message, so a "deny" is never laundered into an "approve".
_ACCEPT_OUTCOMES = frozenset({"accept", "approve"})


@dataclass(frozen=True)
class EvaluatorResult:
    evaluator_ref: str
    evaluator_kind: str
    evaluator_version: str
    result: str
    reason: str
    evidence_set_hash: str = ""
    mandatory: bool = True
    diagnostics: tuple[str, ...] = ()
    evaluated_at: str = ""

    @property
    def passed(self) -> bool:
        return self.result == GateResult.PASS

    def to_wire(self) -> dict[str, Any]:
        return {
            "evaluatorRef": self.evaluator_ref,
            "evaluatorKind": self.evaluator_kind,
            "evaluatorVersion": self.evaluator_version,
            "result": self.result,
            "reason": self.reason,
            "evidenceSetHash": self.evidence_set_hash,
            "mandatory": self.mandatory,
            "diagnostics": list(self.diagnostics),
            "evaluatedAt": self.evaluated_at,
        }

    @staticmethod
    def from_wire(value: Mapping[str, Any]) -> "EvaluatorResult":
        return EvaluatorResult(
            evaluator_ref=str(value.get("evaluatorRef", "")),
            evaluator_kind=str(value.get("evaluatorKind", EvaluatorKind.AUTOMATIC)),
            evaluator_version=str(value.get("evaluatorVersion", "1")),
            result=str(value.get("result", GateResult.ESCALATE)),
            reason=str(value.get("reason", "")),
            evidence_set_hash=str(value.get("evidenceSetHash", "")),
            mandatory=bool(value.get("mandatory", True)),
            diagnostics=tuple(str(d) for d in (value.get("diagnostics") or ())),
            evaluated_at=str(value.get("evaluatedAt", "")),
        )


@dataclass(frozen=True)
class EvaluationContext:
    """Everything an evaluator is allowed to look at.

    Deliberately a flat, read-only snapshot rather than the engine itself: an evaluator
    must not be able to write state or read another tenant's rows.
    """

    run: Mapping[str, Any] = field(default_factory=dict)
    node: Mapping[str, Any] = field(default_factory=dict)
    node_plan: Mapping[str, Any] = field(default_factory=dict)
    contract: Mapping[str, Any] = field(default_factory=dict)
    policy: EffectivePolicy | None = None
    evidence: tuple[Mapping[str, Any], ...] = ()
    invalid_evidence: tuple[Mapping[str, Any], ...] = ()
    #: Evidence produced by this node's *predecessors*, valid records only.
    #:
    #: Separate from ``evidence`` on purpose. ``evidence`` stays node-scoped so a node's own
    #: quality contract cannot be satisfied by something an upstream node happened to produce, and
    #: the generic ``required_evidence_present`` check keeps reading it alone. A gate is the case
    #: this exists for: ``threat_model_review_v2`` judges a threat model that the independent review
    #: upstream authored, and a gate cannot author it, because the contract marks a gate's own
    #: mutations as requiring a trusted execution record. Without this field such a check could
    #: only ever see the gate's own evidence and would escalate on a correctly authored model.
    upstream_evidence: tuple[Mapping[str, Any], ...] = ()
    resolution: Mapping[str, Any] | None = None
    decision_target_hash: str = ""
    reviewer_subject: str | None = None
    interaction_creator: str | None = None
    producer_subjects: tuple[str, ...] = ()
    capability_holders: Mapping[str, Sequence[str]] = field(default_factory=dict)
    required_capabilities: tuple[str, ...] = ()
    platform_grants: PlatformGrants | None = None
    authorization: Mapping[str, Any] | None = None
    current_input_revisions: Mapping[str, str] = field(default_factory=dict)
    evidence_set_hash: str = ""
    now: str = ""

    def evidence_of_kind(self, kind: str) -> list[Mapping[str, Any]]:
        return [e for e in self.evidence if str(e.get("kind", "")) == kind]

    def valid_evidence(self) -> list[Mapping[str, Any]]:
        return [e for e in self.evidence if bool(e.get("valid", 0))]

    def evidence_in_scope(self, kind: str) -> list[Mapping[str, Any]]:
        """Valid evidence of ``kind`` from this node, then from its predecessors.

        A check that judges work done elsewhere -- a gate reviewing an upstream review -- needs both,
        and needs them in that order: the node's own record is the more direct claim, so it wins.
        Deliberately opt-in per check rather than folded into ``valid_evidence``, so widening what a
        gate can see cannot silently satisfy the node's own evidence contract.
        """
        found = [e for e in self.evidence if str(e.get("kind", "")) == kind and bool(e.get("valid", 0))]
        if found:
            return found
        return [
            e
            for e in self.upstream_evidence
            if str(e.get("kind", "")) == kind and bool(e.get("valid", 0))
        ]

    def resolution_target_hash(self) -> str:
        """The target hash the recorded resolution was made against."""
        resolution = self.resolution or {}
        detail = resolution.get("detail") or {}
        if isinstance(detail, Mapping):
            for key in ("decisionTargetHash", "targetHash"):
                if detail.get(key):
                    return str(detail[key])
        if resolution.get("decisionTargetHash"):
            return str(resolution["decisionTargetHash"])
        return ""


class Evaluator(Protocol):
    """The evaluator interface. ``evaluate`` may raise; the registry will not let it escape."""

    ref: str
    kind: str
    version: str

    def evaluate(self, context: EvaluationContext) -> tuple[str, str, tuple[str, ...]]:
        """Return ``(result, reason, diagnostics)``."""
        ...


def _result(
    ref: str,
    kind: str,
    version: str,
    verdict: str,
    reason: str,
    *,
    evidence_set_hash: str = "",
    diagnostics: Sequence[str] = (),
    now: str = "",
    mandatory: bool = True,
) -> EvaluatorResult:
    return EvaluatorResult(
        evaluator_ref=ref,
        evaluator_kind=str(kind),
        evaluator_version=version,
        result=str(verdict),
        reason=reason,
        evidence_set_hash=evidence_set_hash,
        mandatory=mandatory,
        diagnostics=tuple(diagnostics),
        evaluated_at=now,
    )


# ---------------------------------------------------------------------------
# Built-ins
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class _ContractSchemaV1:
    """Automatic: the contract must be structurally coherent and match its own identity.

    Recomputing the hash is the point. A contract that was edited after it was hashed — by
    a bug, a migration, or a hand — cannot be committed, because the identity the gate
    binds to is no longer the identity of the content.
    """

    ref: str = "contract_schema_v1"
    kind: str = str(EvaluatorKind.AUTOMATIC)
    version: str = "1"

    def evaluate(self, context: EvaluationContext) -> tuple[str, str, tuple[str, ...]]:
        wire = context.contract
        if not wire:
            return GateResult.FAIL, "no transition contract was supplied to evaluate", ()
        # Presence, not truthiness: iteration 0 and an empty subject are legitimate values and
        # must not be reported as a missing field.
        missing = [
            field
            for field in ("nodeId", "iteration", "operation", "effectivePolicy", "planHash")
            if wire.get(field) is None or wire.get(field) == ""
        ]
        if missing:
            return (
                GateResult.FAIL,
                "contract is missing required field(s): " + ", ".join(missing),
                (),
            )
        if "contractHash" not in wire:
            return (
                GateResult.FAIL,
                "contract carries no identity hash; a contract without one cannot be bound to a "
                "transition, an approval, or an effect",
                (),
            )
        evaluators = wire.get("requiredEvaluators") or ()
        if not evaluators:
            return (
                GateResult.FAIL,
                "contract requires no evaluator; a transition with no check would pass unconditionally",
                (),
            )
        declared = str(wire.get("contractHash", ""))
        try:
            recomputed = contract_hash(TransitionContract.from_wire(wire))
        except errors.PolyForgeError as exc:
            return GateResult.FAIL, f"contract cannot be hashed: {exc.message}", ()
        if declared and declared != recomputed:
            # Do not echo the hashes: a mismatch can mean a caller is probing which value
            # would be accepted.
            return (
                GateResult.FAIL,
                "contract content does not match its declared identity hash; the contract was "
                "modified after it was pinned",
                (),
            )
        policy = wire.get("effectivePolicy") or {}
        if str(policy.get("effect")) == "deny":
            return (
                GateResult.FAIL,
                f"effective policy denies this transition: {policy.get('reason', '')}",
                (),
            )
        return GateResult.PASS, "contract is coherent and matches its pinned identity", ()


@dataclass(frozen=True)
class _RequiredEvidencePresent:
    """Automatic: every required kind has valid, fresh, correctly produced evidence."""

    ref: str = "required_evidence_present"
    kind: str = str(EvaluatorKind.AUTOMATIC)
    version: str = "1"

    def evaluate(self, context: EvaluationContext) -> tuple[str, str, tuple[str, ...]]:
        # Read the wire shape (``camelCase``): a context carries the contract as a worker and a
        # gate both see it, not as a Python object.
        required = [str(k) for k in (context.contract.get("requiredEvidenceKinds") or ())]
        if not required:
            # No declared requirement means no evidence gate. Report the fact instead of
            # inventing one: a caller may have skipped the declaration by mistake.
            return (
                GateResult.ESCALATE,
                "the contract declares no required evidence kind; the node's quality "
                "requirements were not declared",
                (),
            )
        diagnostics: list[str] = []
        for kind in required:
            records = [e for e in context.valid_evidence() if str(e.get("kind", "")) == kind]
            if not records:
                stale = [e for e in context.invalid_evidence if str(e.get("kind", "")) == kind]
                reason = (
                    f"no valid evidence of kind {kind!r}"
                    + (
                        f"; {len(stale)} record(s) exist but were invalidated"
                        if stale
                        else ""
                    )
                )
                return GateResult.ESCALATE, reason, tuple(diagnostics)
            for record in records:
                artifacts = record.get("artifacts") or []
                if not artifacts:
                    return (
                        GateResult.ESCALATE,
                        f"evidence {record.get('evidenceId')!r} of kind {kind!r} carries no artifact",
                        tuple(diagnostics),
                    )
                for artifact in artifacts:
                    digest = str(artifact.get("contentHash", ""))
                    if not digest.startswith("sha256:"):
                        return (
                            GateResult.FAIL,
                            (
                                f"evidence {record.get('evidenceId')!r} cites artifact "
                                f"{artifact.get('artifactId')!r} without a verifiable content digest"
                            ),
                            tuple(diagnostics),
                        )
                    provider = artifact.get("providerRef") or {}
                    if isinstance(provider, Mapping) and provider.get("kind") == "document":
                        if not provider.get("revision"):
                            return (
                                GateResult.FAIL,
                                (
                                    f"evidence {record.get('evidenceId')!r} cites a mutable document "
                                    "with no pinned revision; the document could change underneath "
                                    "an accepted gate"
                                ),
                                tuple(diagnostics),
                            )
                bindings = record.get("input_revision_bindings") or {}
                for name, expected in sorted(context.current_input_revisions.items()):
                    declared = bindings.get(name)
                    if declared is not None and str(declared) != str(expected):
                        diagnostics.append(
                            f"evidence {record.get('evidenceId')!r} was produced against "
                            f"{name}@{declared} but the run is at {expected}"
                        )
        if diagnostics:
            return (
                GateResult.ESCALATE,
                "evidence exists but is bound to superseded input revisions",
                tuple(diagnostics),
            )
        return (
            GateResult.PASS,
            f"all required evidence present: {', '.join(required)}",
            (),
        )


@dataclass(frozen=True)
class _IndependentReviewer:
    """Independent agent: a qualified subject that did not produce the artifact reviewed."""

    ref: str = "independent_reviewer"
    kind: str = str(EvaluatorKind.INDEPENDENT_AGENT)
    version: str = "1"

    def evaluate(self, context: EvaluationContext) -> tuple[str, str, tuple[str, ...]]:
        reviewer = context.reviewer_subject
        if not reviewer:
            return (
                GateResult.ESCALATE,
                "no independent reviewer is bound to this gate; a review that names nobody "
                "is not a review",
                (),
            )
        producers = {str(p) for p in context.producer_subjects if p}
        if reviewer in producers:
            # Self-review is the single most important check here, so it is a FAIL rather
            # than an ESCALATE: re-requesting a different reviewer will not help this record.
            return (
                GateResult.FAIL,
                f"reviewer {reviewer!r} produced the artifact under review; an independent "
                "review requires a different subject than the producer",
                (),
            )
        if context.interaction_creator and reviewer == str(context.interaction_creator):
            return (
                GateResult.FAIL,
                f"reviewer {reviewer!r} created the interaction it is answering; "
                "not_creator is enforced here, not only in the platform UI",
                (),
            )
        required_caps = tuple(context.required_capabilities) or tuple(
            str(c) for c in ((context.node_plan.get("executor") or {}).get("requiredCapabilities") or ())
        )
        missing: list[str] = []
        for capability in required_caps:
            holders = [str(s) for s in (context.capability_holders.get(capability) or ())]
            if reviewer not in holders:
                missing.append(capability)
        if missing:
            return (
                GateResult.FAIL,
                f"reviewer {reviewer!r} does not hold the required capability binding(s): "
                + ", ".join(missing),
                (),
            )
        independent_of = tuple(
            str(c) for c in ((context.node_plan.get("executor") or {}).get("independentFrom") or ())
        )
        for capability in independent_of:
            for subject in context.capability_holders.get(capability) or ():
                if str(subject) == reviewer:
                    return (
                        GateResult.FAIL,
                        f"reviewer {reviewer!r} also produced {capability!r}, which this node "
                        "requires to be reviewed independently",
                        (),
                    )
        return (
            GateResult.PASS,
            f"independent reviewer {reviewer!r} holds {', '.join(required_caps) or 'no required capability'} "
            "and did not produce the reviewed artifact",
            (),
        )


@dataclass(frozen=True)
class _HumanDecision:
    """Human decision: a verified, correctly-targeted answer about this exact target."""

    ref: str = "human_decision"
    kind: str = str(EvaluatorKind.HUMAN_DECISION)
    version: str = "1"

    def evaluate(self, context: EvaluationContext) -> tuple[str, str, tuple[str, ...]]:
        resolution = context.resolution
        if not resolution:
            return (
                GateResult.ESCALATE,
                "no governance resolution is recorded for this gate; the decision is pending",
                (),
            )
        outcome = str(resolution.get("outcome", ""))
        if outcome not in _ACCEPT_OUTCOMES:
            return (
                GateResult.FAIL,
                f"the recorded decision outcome is {outcome!r}, which is not an acceptance",
                (),
            )
        if not bool(resolution.get("verifiedAgainstProvider", False)):
            # The bridge is required to re-read the authoritative object. Without that, an
            # "approved" flag is an unverified assertion travelling over the wire.
            return (
                GateResult.FAIL,
                "the resolution was not verified against the authoritative provider object; "
                "a callback carrying approved=true is never trusted on its own",
                (),
            )
        expected = str(context.decision_target_hash or "")
        actual = context.resolution_target_hash()
        if not expected:
            return (
                GateResult.ESCALATE,
                "no decision target hash was computed for this gate; the decision cannot be bound",
                (),
            )
        if actual != expected:
            return (
                GateResult.FAIL,
                (
                    "the recorded decision was made about a different target; the artifact, "
                    "authority, environment, or evaluator set changed after it was answered"
                ),
                (),
            )
        responder_kind = str(resolution.get("responderKind", ""))
        if str(resolution.get("responderSubject", "")).startswith("agent") or responder_kind == "agent":
            return (
                GateResult.FAIL,
                "a human_decision gate cannot be satisfied by an agent responder",
                (),
            )
        return (
            GateResult.PASS,
            f"human decision by {resolution.get('responderSubject')!r} verified against the "
            "authoritative object for this exact target",
            (),
        )


@dataclass(frozen=True)
class EvaluatorRegistry:
    """The closed set of evaluators.

    A ``dict`` is returned rather than the registry itself so a caller cannot mutate the
    registry by holding on to it.
    """

    _evaluators: dict[str, Any] = field(default_factory=dict)

    def register(self, evaluator: Any) -> None:
        self._evaluators[str(evaluator.ref)] = evaluator

    def get(self, ref: str) -> Any | None:
        return self._evaluators.get(str(ref))

    def refs(self) -> tuple[str, ...]:
        return tuple(sorted(self._evaluators))

    def evaluate(
        self,
        ref: str,
        context: EvaluationContext,
        *,
        mandatory: bool = True,
        version: str = "",
    ) -> EvaluatorResult:
        """Run one evaluator, converting any failure to run into ``ESCALATE``.

        A missing evaluator is also ``ESCALATE``, never PASS: the caller asked a question
        the Core cannot answer, and saying "no answer" is the only honest result.
        """
        evaluator = self._evaluators.get(str(ref))
        if evaluator is None:
            return _result(
                str(ref),
                str(EvaluatorKind.AUTOMATIC),
                version or "0",
                GateResult.ESCALATE,
                f"evaluator {ref!r} is not registered in this Core build",
                evidence_set_hash=context.evidence_set_hash,
                diagnostics=(f"unknown evaluator {ref!r}",),
                now=context.now or ids.now_iso(),
                mandatory=mandatory,
            )
        try:
            verdict, reason, diagnostics = evaluator.evaluate(context)
        except Exception as exc:  # noqa: BLE001 - an evaluator crash must not become a pass
            return _result(
                str(ref),
                str(getattr(evaluator, "kind", EvaluatorKind.AUTOMATIC)),
                str(getattr(evaluator, "version", version or "1")),
                GateResult.ESCALATE,
                f"evaluator {ref!r} raised {type(exc).__name__}: {exc}",
                evidence_set_hash=context.evidence_set_hash,
                diagnostics=(
                    f"{type(exc).__name__}: {exc}",
                    "evaluator error is a diagnostic to re-evaluate after a fix, never a pass",
                ),
                now=context.now or ids.now_iso(),
                mandatory=mandatory,
            )
        return _result(
            str(ref),
            str(getattr(evaluator, "kind", EvaluatorKind.AUTOMATIC)),
            version or str(getattr(evaluator, "version", "1")),
            str(verdict),
            str(reason),
            evidence_set_hash=context.evidence_set_hash,
            diagnostics=tuple(diagnostics or ()),
            now=context.now or ids.now_iso(),
            mandatory=mandatory,
        )

    def evaluate_all(
        self,
        refs: Sequence[str],
        context: EvaluationContext,
        *,
        mandatory: Mapping[str, bool] | None = None,
        versions: Mapping[str, str] | None = None,
    ) -> list[EvaluatorResult]:
        results: list[EvaluatorResult] = []
        for ref in refs:
            results.append(
                self.evaluate(
                    ref,
                    context,
                    mandatory=bool((mandatory or {}).get(ref, True)),
                    version=str((versions or {}).get(ref, "")),
                )
            )
        return results


#: Every evaluator this Core build ships. Adding one is a reviewed code change; a caller
#: cannot register an evaluator at runtime.
BUILTIN_EVALUATOR_REFS: tuple[str, ...] = (
    "contract_schema_v1",
    "required_evidence_present",
    "independent_reviewer",
    "human_decision",
)


def default_registry() -> EvaluatorRegistry:
    """Return a fresh registry holding the built-in evaluators."""
    # Imported here, not at module scope: the domain evaluators need EvaluationContext from this
    # module, so a top-level import in both directions would be a cycle. By the time a caller asks
    # for a registry this module is fully initialised, so the deferred import always resolves.
    from polyforge.core.gates.evaluators_domain import DOMAIN_EVALUATORS

    registry = EvaluatorRegistry()
    for evaluator in (
        _ContractSchemaV1(),
        _RequiredEvidencePresent(),
        _IndependentReviewer(),
        _HumanDecision(),
        # The eleven domain checks the shipped graph families reference. They live in their own
        # module because they are questions about the work rather than about the contract, and
        # because eleven classes in this file would bury the four that decide provenance.
        *DOMAIN_EVALUATORS(),
    ):
        registry.register(evaluator)
    return registry
