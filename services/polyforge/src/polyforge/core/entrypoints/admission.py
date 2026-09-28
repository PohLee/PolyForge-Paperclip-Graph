"""EntryPoint admission: may this run start here, with these facts, under these bindings?

Responsibility: the single gate between a start intent and a ``GraphRun`` (REQ-ENTRY-02,
REQ-ENTRY-03, REQ-ENTRY-04). It answers with a structured refusal, never with a guess.

Invariants
----------
* Every *precondition* failure is a :class:`Blocker` with a stable ``code`` and a
  ``BlockReason``; admission never raises for one, because the caller has to render every
  reason at once, and it never partially admits. An unknown entrypoint key is not a
  precondition but a routing error, so it raises ``NOT_FOUND``.
* **A prerequisite fact is only a fact with provenance.** An imported fact must carry
  ``source``, ``sourceRevision`` and ``contentHash``. A side entry that skipped a gate
  would otherwise be able to walk in by asserting the gate's outcome itself, so an
  unprovenanced fact is refused rather than trusted.
* **A fallback never weakens.** ``preferredRoles`` and ``fallbackRoles`` select a worker;
  they are not authorization. A binding qualifies only when it actually carries every
  required capability, whether it matched by role or not, and it may not be bound to a
  different entrypoint than the one being admitted.
* **Re-execution needs a new generation.** With
  ``resumePolicy.reExecutionRequiresNewGeneration`` set, a resume that claims completed
  work must present a higher invocation generation. An old PASS is never inherited across
  a re-execution, and a gate in ``completedNodeIds`` is the strictest case of that.
* **Side entries may not skip a gate.** When a start node sits downstream of a gate, the
  entry must have required a fact that the gate produces.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Final, Mapping, Sequence

from polyforge.core.errors import bad_request, not_found
from polyforge.core.state import BlockReason, NodeKind

__all__ = [
    "AdmissionResult",
    "admit",
    "check_fact_provenance",
    "resolve_coordinator",
]

_DIGEST_PATTERN: Final[re.Pattern[str]] = re.compile(r"^sha256:[0-9a-f]{64}$")
_PROVENANCE_FIELDS: Final[tuple[str, str, str]] = ("source", "sourceRevision", "contentHash")


@dataclass(frozen=True, slots=True)
class Blocker:
    """One reason admission refused. Shape matches ``Blocker`` in ``api.ts``."""

    code: str
    reason: str
    message: str
    detail: Mapping[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        body: dict[str, Any] = {"code": self.code, "reason": self.reason, "message": self.message}
        if self.detail:
            body["detail"] = dict(self.detail)
        return body


@dataclass(slots=True)
class AdmissionResult:
    """The outcome of one admission attempt."""

    ok: bool
    blockers: list[Blocker] = field(default_factory=list)
    required_facts: list[str] = field(default_factory=list)
    resolved_entrypoint: dict[str, Any] | None = None
    coordinator_requirement: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "blockers": [blocker.to_dict() for blocker in self.blockers],
            "requiredFacts": list(self.required_facts),
            "resolvedEntrypoint": dict(self.resolved_entrypoint) if self.resolved_entrypoint else None,
            "coordinatorRequirement": dict(self.coordinator_requirement) if self.coordinator_requirement else None,
        }


def check_fact_provenance(fact: str, evidence: Any) -> str | None:
    """Return a refusal reason for an unprovenanced fact, or ``None`` when it is sound."""
    if not isinstance(evidence, Mapping):
        return f"fact '{fact}' was supplied without provenance; an imported prerequisite must name its source, revision and content hash"
    for name in _PROVENANCE_FIELDS:
        value = evidence.get(name)
        if not isinstance(value, str) or not value.strip():
            return f"fact '{fact}' provenance is missing '{name}'"
    digest = str(evidence["contentHash"])
    if not _DIGEST_PATTERN.match(digest):
        return f"fact '{fact}' contentHash '{digest}' is not a sha256 digest"
    return None


def _ancestor_map(nodes: Mapping[str, Any], edges: Sequence[tuple[str, str]]) -> dict[str, set[str]]:
    """Transitive predecessors per node. Cycles included: a rework loop is a cycle."""
    incoming: dict[str, set[str]] = {nid: set() for nid in nodes}
    for src, dst in edges:
        incoming.setdefault(dst, set()).add(src)
    resolved: dict[str, set[str]] = {}
    for nid in nodes:
        seen: set[str] = set()
        stack = list(incoming.get(nid, ()))
        while stack:
            current = stack.pop()
            if current in seen or current not in nodes:
                continue
            seen.add(current)
            stack.extend(incoming.get(current, ()))
        resolved[nid] = seen
    return resolved


def _resolve_coordinator(
    requirement: Mapping[str, Any],
    entrypoint_key: str,
    bindings: Sequence[Mapping[str, Any]],
) -> tuple[dict[str, Any], list[Blocker]]:
    """Pick a coordinator binding without letting a role preference substitute for a capability."""
    required = [str(item) for item in requirement.get("requiredCapabilities") or () if item]
    satisfied_by: str | None = None
    considered: list[str] = []
    for binding in bindings:
        if not isinstance(binding, Mapping):
            continue
        subject = str(binding.get("subjectRef") or binding.get("subject") or "")
        considered.append(subject or "<unbound>")
        allowed = binding.get("entrypoints")
        if isinstance(allowed, list) and allowed and entrypoint_key not in [str(item) for item in allowed]:
            # A capability binding scoped to other entrypoints is not a wildcard grant.
            continue
        contracts = binding.get("capabilityContracts")
        if isinstance(contracts, Mapping):
            provided = {str(name) for name, version in contracts.items()}
        else:
            provided = {str(item) for item in binding.get("capabilities") or ()}
        missing = [capability for capability in required if capability not in provided]
        if missing:
            continue
        if subject:
            satisfied_by = subject
            break
    resolved = {
        "requiredCapabilities": required,
        "preferredRoles": [str(item) for item in requirement.get("preferredRoles") or ()],
        "fallbackRoles": [str(item) for item in requirement.get("fallbackRoles") or ()],
        "satisfiedBy": satisfied_by,
    }
    if satisfied_by is not None:
        return resolved, []
    return resolved, [
        Blocker(
            "COORDINATOR_CAPABILITY_UNSATISFIED",
            str(BlockReason.AUTHORIZATION),
            (
                f"no supplied capability binding covers every coordinator capability {required} for "
                f"entrypoint '{entrypoint_key}'; a role preference or fallback cannot substitute for a capability"
            ),
            detail={"requiredCapabilities": required, "consideredSubjects": considered},
        )
    ]


def admit(
    definition: Any,
    entrypoint_key: str,
    *,
    input_snapshot: Mapping[str, Any],
    required_facts: Mapping[str, Any] | None = None,
    capability_bindings: Sequence[Mapping[str, Any]] | None = None,
    policy_catalog: Mapping[str, Mapping[str, Any]] | None = None,
    resume_context: Mapping[str, Any] | None = None,
) -> AdmissionResult:
    """Decide whether a run may be admitted at ``entrypoint_key``.

    ``required_facts`` maps a fact name to ``{source, sourceRevision, contentHash}``.
    ``capability_bindings`` are the caller-visible capability grants, each of which may
    carry ``subjectRef``, ``capabilityContracts``/``capabilities`` and optional
    ``entrypoints`` restriction. ``resume_context`` carries ``checkpointKind``,
    ``completedNodeIds`` and ``invocationGeneration`` for a controlled resume.
    ``policy_catalog`` is accepted for call-shape compatibility with the compiler; the
    baseline itself was already enforced at validation time, so a graph that reached here
    is at or above the baseline by construction.
    """
    del policy_catalog  # baseline enforcement happens in validate_definition; see docstring

    blockers: list[Blocker] = []
    if not isinstance(definition, Mapping):
        raise bad_request("graph definition must be an object", field="definition")
    if not isinstance(input_snapshot, Mapping):
        raise bad_request("input_snapshot must be an object", field="input_snapshot")
    if required_facts is not None and not isinstance(required_facts, Mapping):
        raise bad_request("required_facts must be an object", field="required_facts")
    if capability_bindings is not None and not isinstance(capability_bindings, (list, tuple)):
        raise bad_request("capability_bindings must be a list", field="capability_bindings")

    entrypoints = definition.get("entrypoints")
    entry = entrypoints.get(entrypoint_key) if isinstance(entrypoints, Mapping) else None
    if not isinstance(entry, Mapping):
        raise not_found(
            "entrypoint does not exist on this graph",
            graphId=definition.get("graphId"),
            entrypoint=entrypoint_key,
        )

    nodes = definition.get("nodes") if isinstance(definition.get("nodes"), Mapping) else {}
    edges = [
        (str(edge.get("from")), str(edge.get("to")))
        for edge in definition.get("edges") or ()
        if isinstance(edge, Mapping) and edge.get("from") and edge.get("to")
    ]

    required = [str(item) for item in entry.get("requiresFacts") or () if item]
    supplied_facts = dict(required_facts or {})

    for name in [str(item) for item in entry.get("inputs") or () if item]:
        if name not in input_snapshot:
            blockers.append(
                Blocker(
                    "ENTRYPOINT_INPUT_MISSING",
                    str(BlockReason.DEPENDENCY),
                    f"entrypoint '{entrypoint_key}' requires input '{name}' and the snapshot does not carry it",
                    detail={"input": name},
                )
            )

    for name in required:
        if name not in supplied_facts:
            blockers.append(
                Blocker(
                    "FACT_MISSING",
                    str(BlockReason.GOVERNANCE),
                    f"entrypoint '{entrypoint_key}' requires fact '{name}' and it was not supplied",
                    detail={"fact": name},
                )
            )
            continue
        reason = check_fact_provenance(name, supplied_facts[name])
        if reason is not None:
            blockers.append(
                Blocker(
                    "FACT_PROVENANCE_INVALID",
                    str(BlockReason.GOVERNANCE),
                    (
                        f"{reason}; refusing it would let a side entry assert a gate outcome it never ran"
                    ),
                    detail={"fact": name},
                )
            )

    start_nodes = [str(item) for item in entry.get("startNodes") or () if item]
    for name in start_nodes:
        if name not in nodes:
            blockers.append(
                Blocker(
                    "ENTRYPOINT_START_UNKNOWN",
                    str(BlockReason.DEPENDENCY),
                    f"entrypoint '{entrypoint_key}' starts at unknown node '{name}'",
                    detail={"nodeId": name},
                )
            )
    ancestors = _ancestor_map(nodes, edges)
    for start in start_nodes:
        if start not in nodes:
            continue
        for ancestor in sorted(ancestors.get(start, set())):
            gate = nodes.get(ancestor)
            if not isinstance(gate, Mapping) or gate.get("kind") != NodeKind.GATE.value:
                continue
            if start in ancestors.get(ancestor, set()):
                # The start node can also reach the gate, so the gate is feedback from a
                # declared rework loop rather than an upstream control being skipped.
                continue
            vouched = {str(item) for item in gate.get("produces") or ()}
            if vouched and vouched.issubset(set(required)):
                continue
            blockers.append(
                Blocker(
                    "SIDE_ENTRY_GATE_BYPASS",
                    str(BlockReason.GOVERNANCE),
                    (
                        f"entrypoint '{entrypoint_key}' starts at '{start}', downstream of gate '{ancestor}', "
                        f"without requiring a fact the gate produces {sorted(vouched)}"
                    ),
                    detail={"startNode": start, "gate": ancestor, "gateFacts": sorted(vouched)},
                )
            )

    coordinator = entry.get("coordinator")
    if not isinstance(coordinator, Mapping):
        blockers.append(
            Blocker(
                "COORDINATOR_REQUIREMENT_UNDECLARED",
                str(BlockReason.AUTHORIZATION),
                f"entrypoint '{entrypoint_key}' does not declare a coordinator requirement",
            )
        )
        coordinator_requirement: dict[str, Any] | None = None
    else:
        coordinator_requirement, coordinator_blockers = _resolve_coordinator(
            coordinator, entrypoint_key, list(capability_bindings or ())
        )
        blockers.extend(coordinator_blockers)

    if resume_context is not None:
        blockers.extend(_check_resume(entry, entrypoint_key, nodes, resume_context))

    resolved_entrypoint = None
    if not blockers:
        resolved_entrypoint = {
            "key": entrypoint_key,
            "inputs": [str(item) for item in entry.get("inputs") or () if item],
            "requiresFacts": required,
            "startNodes": start_nodes,
            "exports": [str(item) for item in entry.get("exports") or () if item],
            "coordinator": dict(coordinator) if isinstance(coordinator, Mapping) else {},
            "resumePolicy": dict(entry.get("resumePolicy")) if isinstance(entry.get("resumePolicy"), Mapping) else None,
            "verifiedFacts": {name: dict(supplied_facts[name]) for name in required},
        }

    return AdmissionResult(
        ok=not blockers,
        blockers=blockers,
        required_facts=required,
        resolved_entrypoint=resolved_entrypoint,
        coordinator_requirement=coordinator_requirement,
    )


def _check_resume(
    entry: Mapping[str, Any],
    entrypoint_key: str,
    nodes: Mapping[str, Any],
    context: Mapping[str, Any],
) -> list[Blocker]:
    """Controlled resume: only from a legal checkpoint, and never re-executing under a new claim."""
    blockers: list[Blocker] = []
    policy = entry.get("resumePolicy")
    if not isinstance(policy, Mapping):
        return [
            Blocker(
                "RESUME_NOT_PERMITTED",
                str(BlockReason.GOVERNANCE),
                f"entrypoint '{entrypoint_key}' does not declare a resume policy and cannot be resumed",
            )
        ]
    allowed = [str(item) for item in policy.get("allowedCheckpointKinds") or () if item]
    checkpoint = context.get("checkpointKind")
    if allowed:
        if not isinstance(checkpoint, str) or checkpoint not in allowed:
            blockers.append(
                Blocker(
                    "RESUME_CHECKPOINT_ILLEGAL",
                    str(BlockReason.GOVERNANCE),
                    (
                        f"checkpoint {checkpoint!r} is not one of the legal resume points {allowed} for "
                        f"entrypoint '{entrypoint_key}'"
                    ),
                    detail={"checkpointKind": checkpoint, "allowedCheckpointKinds": allowed},
                )
            )
    generation = context.get("invocationGeneration")
    generation_value = int(generation) if isinstance(generation, int) and not isinstance(generation, bool) else 0
    requires_new = bool(policy.get("reExecutionRequiresNewGeneration"))
    completed = [str(item) for item in context.get("completedNodeIds") or () if item]
    for node_id in completed:
        if node_id not in nodes:
            blockers.append(
                Blocker(
                    "RESUME_UNKNOWN_NODE",
                    str(BlockReason.DEPENDENCY),
                    f"resume claims completed node '{node_id}', which this graph does not contain",
                    detail={"nodeId": node_id},
                )
            )
            continue
        node = nodes.get(node_id)
        is_gate = isinstance(node, Mapping) and node.get("kind") == NodeKind.GATE.value
        if is_gate and generation_value < 1:
            # A recorded gate PASS is exactly the thing a new generation exists to replace.
            blockers.append(
                Blocker(
                    "RESUME_INHERITS_GATE_PASS",
                    str(BlockReason.GOVERNANCE),
                    (
                        f"resume claims gate '{node_id}' already completed; re-execution of a gate needs a new "
                        "invocation generation, otherwise the old PASS would be inherited"
                    ),
                    detail={"nodeId": node_id, "invocationGeneration": generation_value},
                )
            )
    if requires_new and generation_value < 1 and context.get("reexecuting"):
        blockers.append(
            Blocker(
                "RESUME_GENERATION_REQUIRED",
                str(BlockReason.GOVERNANCE),
                (
                    f"entrypoint '{entrypoint_key}' sets reExecutionRequiresNewGeneration; re-executing work "
                    "needs an invocation generation above 0"
                ),
                detail={"invocationGeneration": generation_value},
            )
        )
    return blockers
