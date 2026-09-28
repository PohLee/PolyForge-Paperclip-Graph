"""Gate aggregation.

Responsibility: combine typed evaluator results and the graph's own join semantics into
exactly one of PASS / FAIL / ESCALATE, and make it impossible for a graph to talk its way
past a gate the Core declared mandatory.

Invariants (``docs/05-PROTOCOL.md`` section 7, ``docs/02-TECHNICAL-PLAN.md`` section 9):

* FAIL wins. An aggregation that returned PASS while any evaluator failed would be a
  bypass, and a bypass here is a wrong PASS in production.
* A missing required evaluator or missing required evidence is ``ESCALATE``, never
  ``PASS`` and never ``FAIL``: "we could not check" is a different fact from "the check
  said no", and collapsing them would make a broken gate look like a strict one.
* On a mandatory gate the join semantics cannot help. ``any``/``quorum`` may only make a
  non-mandatory gate stricter in reporting; they never let a mandatory gate skip a required
  evaluator. A graph author writing ``join: any`` is expressing fan-in, not authority to
  ignore a reviewer.
* ``ESCALATE`` is the only result that means "a human or a missing dependency must act".
  It is never a soft PASS.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import Any, Iterable, Sequence

from polyforge.core.state import JoinSemantics

__all__ = ["GateResult", "AggregatedGate", "aggregate_gate"]


class GateResult(StrEnum):
    """The three outcomes. Mirrors ``GATE_RESULTS`` in packages/protocol/src/enums.ts."""

    PASS = "PASS"
    FAIL = "FAIL"
    ESCALATE = "ESCALATE"


@dataclass(frozen=True)
class AggregatedGate:
    gate_id: str
    result: str
    reason: str
    join: str
    mandatory: bool
    evidence_set_hash: str
    missing_evaluators: tuple[str, ...] = ()
    missing_evidence_kinds: tuple[str, ...] = ()
    evaluated_refs: tuple[str, ...] = ()
    diagnostics: tuple[str, ...] = ()

    @property
    def passed(self) -> bool:
        return self.result == GateResult.PASS

    def to_wire(self) -> dict[str, Any]:
        return {
            "gateId": self.gate_id,
            "result": str(self.result),
            "reason": self.reason,
            "join": self.join,
            "mandatory": self.mandatory,
            "evidenceSetHash": self.evidence_set_hash,
            "missingEvaluators": list(self.missing_evaluators),
            "missingEvidenceKinds": list(self.missing_evidence_kinds),
            "evaluatedRefs": list(self.evaluated_refs),
            "diagnostics": list(self.diagnostics),
        }


def _result_of(value: Any) -> str:
    raw = getattr(value, "result", value)
    text = str(raw)
    try:
        return str(GateResult(text))
    except ValueError:
        # An evaluator that returned something outside the vocabulary is treated as a
        # failure to evaluate, not as a pass.
        return str(GateResult.ESCALATE)


def aggregate_gate(
    results: Sequence[Any] | Iterable[Any],
    *,
    join: JoinSemantics | str = JoinSemantics.ALL,
    mandatory: bool = True,
    gate_id: str = "gate",
    required_evaluators: Sequence[str] = (),
    required_evidence_kinds: Sequence[str] = (),
    present_evidence_kinds: Sequence[str] = (),
    evidence_set_hash: str = "",
) -> AggregatedGate:
    """Combine evaluator results into one verdict.

    ``results`` may be :class:`~polyforge.core.gates.evaluators.EvaluatorResult` objects or
    any object exposing ``.result``/``.reason``; the aggregator deliberately does not
    depend on the evaluator module so a new evaluator kind cannot create an import cycle.
    """
    try:
        join_semantics = JoinSemantics(str(join))
    except ValueError:
        join_semantics = JoinSemantics.ALL

    evaluated = list(results or ())
    normalized: list[tuple[str, str, str, tuple[str, ...]]] = []
    for item in evaluated:
        ref = str(getattr(item, "evaluator_ref", getattr(item, "ref", "unknown")))
        verdict = _result_of(item)
        reason = str(getattr(item, "reason", ""))
        diagnostics = tuple(str(d) for d in (getattr(item, "diagnostics", ()) or ()))
        normalized.append((ref, verdict, reason, diagnostics))

    by_ref = {ref: verdict for ref, verdict, _, _ in normalized}
    required = tuple(str(r) for r in required_evaluators)
    missing_evaluators = tuple(ref for ref in required if ref not in by_ref)

    present = {str(k) for k in present_evidence_kinds}
    missing_evidence = tuple(
        str(k) for k in required_evidence_kinds if str(k) not in present
    )

    fails = [(ref, reason, diag) for ref, verdict, reason, diag in normalized if verdict == GateResult.FAIL]
    escalates = [
        (ref, reason, diag)
        for ref, verdict, reason, diag in normalized
        if verdict == GateResult.ESCALATE
    ]
    passes = [ref for ref, verdict, _, _ in normalized if verdict == GateResult.PASS]

    diagnostics: list[str] = []
    for _, _, diag in (*fails, *escalates):
        diagnostics.extend(diag)

    if fails:
        ref, reason, _ = fails[0]
        return AggregatedGate(
            gate_id=gate_id,
            result=GateResult.FAIL,
            reason=f"evaluator {ref} failed: {reason}",
            join=str(join_semantics),
            mandatory=mandatory,
            evidence_set_hash=evidence_set_hash,
            missing_evaluators=missing_evaluators,
            missing_evidence_kinds=missing_evidence,
            evaluated_refs=tuple(by_ref),
            diagnostics=tuple(diagnostics),
        )

    if missing_evaluators:
        return AggregatedGate(
            gate_id=gate_id,
            result=GateResult.ESCALATE,
            reason=(
                "required evaluator(s) produced no result: "
                + ", ".join(missing_evaluators)
                + "; an unevaluated requirement is never a pass"
            ),
            join=str(join_semantics),
            mandatory=mandatory,
            evidence_set_hash=evidence_set_hash,
            missing_evaluators=missing_evaluators,
            missing_evidence_kinds=missing_evidence,
            evaluated_refs=tuple(by_ref),
            diagnostics=tuple(diagnostics),
        )

    if missing_evidence:
        return AggregatedGate(
            gate_id=gate_id,
            result=GateResult.ESCALATE,
            reason="required evidence kind(s) absent: " + ", ".join(missing_evidence),
            join=str(join_semantics),
            mandatory=mandatory,
            evidence_set_hash=evidence_set_hash,
            missing_evaluators=missing_evaluators,
            missing_evidence_kinds=missing_evidence,
            evaluated_refs=tuple(by_ref),
            diagnostics=tuple(diagnostics),
        )

    if escalates:
        ref, reason, _ = escalates[0]
        # An escalation blocks an ``all`` join and any mandatory gate. On a non-mandatory
        # ``any``/``quorum`` gate it is reported as a diagnostic and the join decides, because
        # that is the whole point of expressing ``any`` there.
        blocking = mandatory or join_semantics is JoinSemantics.ALL
        if blocking:
            return AggregatedGate(
                gate_id=gate_id,
                result=GateResult.ESCALATE,
                reason=f"evaluator {ref} escalated: {reason}",
                join=str(join_semantics),
                mandatory=mandatory,
                evidence_set_hash=evidence_set_hash,
                missing_evaluators=missing_evaluators,
                missing_evidence_kinds=missing_evidence,
                evaluated_refs=tuple(by_ref),
                diagnostics=tuple(diagnostics),
            )

    if mandatory:
        # A mandatory gate requires every required evaluator to have passed. The graph's
        # join describes data flow; it does not get to lower the bar here.
        if required:
            not_passed = tuple(ref for ref in required if by_ref.get(ref) != GateResult.PASS)
            if not_passed:
                return AggregatedGate(
                    gate_id=gate_id,
                    result=GateResult.ESCALATE,
                    reason=(
                        "mandatory gate requires "
                        + ", ".join(required)
                        + " to pass; not passing: "
                        + ", ".join(not_passed)
                        + f". join={join_semantics} does not lower a mandatory gate"
                    ),
                    join=str(join_semantics),
                    mandatory=mandatory,
                    evidence_set_hash=evidence_set_hash,
                    missing_evaluators=not_passed,
                    missing_evidence_kinds=missing_evidence,
                    evaluated_refs=tuple(by_ref),
                    diagnostics=tuple(diagnostics),
                )
        else:
            return AggregatedGate(
                gate_id=gate_id,
                result=GateResult.ESCALATE,
                reason="a mandatory gate with no required evaluator would pass unconditionally",
                join=str(join_semantics),
                mandatory=mandatory,
                evidence_set_hash=evidence_set_hash,
                evaluated_refs=tuple(by_ref),
                diagnostics=tuple(diagnostics),
            )

    if join_semantics is JoinSemantics.ALL:
        satisfied = not fails and not escalates
    elif join_semantics is JoinSemantics.ANY:
        satisfied = bool(passes)
    else:  # quorum
        satisfied = len(passes) >= 1
    if not satisfied:
        return AggregatedGate(
            gate_id=gate_id,
            result=GateResult.ESCALATE,
            reason=f"join {join_semantics} is not satisfied by {len(passes)} passing evaluator(s)",
            join=str(join_semantics),
            mandatory=mandatory,
            evidence_set_hash=evidence_set_hash,
            missing_evaluators=missing_evaluators,
            missing_evidence_kinds=missing_evidence,
            evaluated_refs=tuple(by_ref),
            diagnostics=tuple(diagnostics),
        )

    return AggregatedGate(
        gate_id=gate_id,
        result=GateResult.PASS,
        reason=f"all {len(normalized)} evaluator(s) passed",
        join=str(join_semantics),
        mandatory=mandatory,
        evidence_set_hash=evidence_set_hash,
        missing_evaluators=(),
        missing_evidence_kinds=(),
        evaluated_refs=tuple(by_ref),
        diagnostics=tuple(diagnostics),
    )
