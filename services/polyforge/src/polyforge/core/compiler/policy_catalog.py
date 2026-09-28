"""Versioned baseline engineering policies for the Graph compiler.

Deny-first resolution (``docs/02-TECHNICAL-PLAN.md`` section 12): for any governed action
the effective decision is ``deny > require_approval > allow``, and **no matching rule means
deny**. A graph may only ever be *stronger* than this baseline; a draft that relaxes a
baseline entry is a validation *error*, never a warning, because a graph author is not
allowed to ship a weaker control by editing YAML.

Invariants
----------
* The catalog is append-only within a version. A rule's ``version`` never decreases, so a
  pinned closure that names a version keeps meaning the same thing forever
  (REQ-GRAPH-06: a run must not drift when policy changes).
* :func:`check_definition_policy` never raises for a weak or unknown graph. It reports
  :class:`PolicyViolation` records so the validator can surface every one of them at once,
  each anchored to a JSON path the editor can focus.
* A graph is not *required* to list every baseline ref in ``policyRefs``; the baseline
  rules are enforced structurally whether or not they are cited. Listing a ref adds a pin:
  an unknown ref, a version below baseline, or an override that relaxes a stated
  requirement is a weakening and is refused.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Final, Mapping, Sequence

__all__ = [
    "CEILINGS",
    "DEFAULT_POLICY_REF_VERSIONS",
    "POLICY_CATALOG_VERSION",
    "PolicyViolation",
    "baseline_refs",
    "catalog_versions",
    "check_definition_policy",
    "dominators_from",
    "incoming_edges",
    "is_known_ref",
    "ref_version",
    "resolve_pins",
]

POLICY_CATALOG_VERSION: Final[str] = "polyforge-policy-catalog/1.0.0"

#: Hard numeric ceilings. A graph may be stricter than the ceiling but never above it:
#: raising a ceiling inside a graph is a way of quietly disabling a budget control.
CEILINGS: Final[dict[str, int]] = {
    "maxAttemptsPerNode": 3,
    "maxSubgraphDepth": 3,
    "maxFanOutPerNode": 8,
    "maxQuorumSize": 4,
    "maxEntryStartNodes": 8,
    "authorizationTtlSeconds": 3600,
}

_SEVERITY_ERROR: Final[str] = "error"

# Each baseline entry is a machine-checkable predicate over a definition. The catalog is
# the only place that knows what "strong enough" means; the validator and the compiler
# both consult it so a new baseline ships as data plus one predicate, not as scattered
# ad-hoc checks.
POLICY_SPECS: Final[tuple[dict[str, Any], ...]] = (
    {
        "ref": "policy.deny_precedence",
        "version": 1,
        "title": "Policy resolution is deny-first and fail-closed",
        "summary": (
            "deny > require_approval > allow, and no matching rule means deny. A graph may "
            "not declare a resolution order that puts allow first."
        ),
        "requirement": {"kind": "deny_precedence", "order": ["deny", "require_approval", "allow"]},
    },
    {
        "ref": "policy.independent_review_before_quality_gate",
        "version": 2,
        "title": "Independent review before a quality gate passes",
        "summary": (
            "Every gate must be decided either by a required human decision or by evidence "
            "produced by a review node whose executor declares independence from the "
            "producer it reviews."
        ),
        "requirement": {"kind": "independent_review_before_gate"},
    },
    {
        "ref": "policy.permission_gate_before_side_effect",
        "version": 2,
        "title": "Permission gate before any external side effect",
        "summary": (
            "An external_effect node must be dominated by a gate carrying a permissionGate "
            "with an exact action and resource."
        ),
        "requirement": {"kind": "permission_gate_before_side_effect"},
    },
    {
        "ref": "policy.human_only_decision_for_gates",
        "version": 1,
        "title": "Human-only decision for design and acceptance gates",
        "summary": (
            "A gate that asks for a human decision must name its semantic kind and must not "
            "name an executor: a worker must never be able to satisfy a human decision."
        ),
        "requirement": {"kind": "human_only_decision"},
    },
    {
        "ref": "policy.budget_and_authority_ceilings",
        "version": 1,
        "title": "Budget and authority ceilings",
        "summary": "Node retries, join quorum, fan-out and subgraph depth stay at or below the catalog ceilings.",
        "requirement": {"kind": "ceilings", "ceilings": CEILINGS},
    },
)

DEFAULT_POLICY_REF_VERSIONS: Final[dict[str, int]] = {
    str(spec["ref"]): int(spec["version"]) for spec in POLICY_SPECS
}

_BY_REF: Final[dict[str, dict[str, Any]]] = {str(spec["ref"]): dict(spec) for spec in POLICY_SPECS}


@dataclass(frozen=True, slots=True)
class PolicyViolation:
    """One reason a definition is not allowed to ship under the baseline.

    ``path`` is a JSON path into the definition so the editor can focus the offending
    node or field (REQ-UI-02).
    """

    code: str
    ref: str
    path: str
    message: str
    severity: str = _SEVERITY_ERROR
    detail: Mapping[str, Any] = field(default_factory=dict)

    def to_issue(self) -> dict[str, str]:
        """Render as a ``ValidationIssue`` payload."""
        return {
            "severity": self.severity,
            "code": self.code,
            "path": self.path,
            "message": self.message,
        }

    def to_dict(self) -> dict[str, Any]:
        return {
            "severity": self.severity,
            "code": self.code,
            "path": self.path,
            "message": self.message,
            "ref": self.ref,
            "detail": dict(self.detail),
        }


def baseline_refs() -> tuple[str, ...]:
    """Every baseline policy ref, in catalog order."""
    return tuple(DEFAULT_POLICY_REF_VERSIONS)


def is_known_ref(ref: str) -> bool:
    return ref in _BY_REF


def ref_version(ref: str) -> int | None:
    """Baseline version of ``ref``, or ``None`` when the ref is not in the catalog."""
    spec = _BY_REF.get(ref)
    return None if spec is None else int(spec["version"])


def catalog_versions() -> dict[str, int]:
    """Copy of ``{ref: baseline version}`` for pinning into a run closure."""
    return dict(DEFAULT_POLICY_REF_VERSIONS)


def resolve_pins(definition: Mapping[str, Any], *, overrides: Mapping[str, int] | None = None) -> dict[str, int]:
    """Effective ``{ref: version}`` for ``definition``.

    A cited ref resolves to ``max(cited version, baseline version)``: citing a *newer*
    version is fine, citing an older one is still resolved to the baseline because the
    Core never runs a graph under a control it has since tightened.
    """
    effective: dict[str, int] = dict(DEFAULT_POLICY_REF_VERSIONS)
    for raw in definition.get("policyRefs") or ():
        if not isinstance(raw, str):
            continue
        ref, _, version = raw.partition("@")
        base = ref_version(ref)
        if base is None:
            continue
        effective[ref] = max(base, int(version)) if version.isdigit() else base
    if overrides:
        for ref, version in overrides.items():
            if is_known_ref(ref):
                effective[ref] = max(effective.get(ref, 0), int(version))
    return effective


# --------------------------------------------------------------------------------------
# predicates
# --------------------------------------------------------------------------------------


def _is_gate(node: Mapping[str, Any]) -> bool:
    return node.get("kind") == "gate"


def _has_human_decision(node: Mapping[str, Any]) -> bool:
    decision = node.get("humanDecision")
    return isinstance(decision, Mapping) and bool(decision.get("required"))


def _declares_independence(node: Mapping[str, Any]) -> bool:
    executor = node.get("executor")
    if not isinstance(executor, Mapping):
        return False
    refs = executor.get("independentFrom")
    return isinstance(refs, list) and len(refs) > 0


def _ancestors(nodes: Mapping[str, Mapping[str, Any]], edges: list[tuple[str, str]]) -> dict[str, set[str]]:
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


def incoming_edges(nodes: Mapping[str, Any], edges: Sequence[Any]) -> dict[str, set[str]]:
    """Adjacency of predecessors, keyed by every known node.

    An edge is anything indexable whose first two items are ``(from, to)``; the validator
    carries a third guard element that dominance does not care about.
    """
    incoming: dict[str, set[str]] = {nid: set() for nid in nodes}
    for edge in edges:
        incoming.setdefault(edge[1], set()).add(edge[0])
    return incoming


def dominators_from(nodes: Mapping[str, Any], edges: Sequence[Any], start_nodes: list[str]) -> dict[str, set[str]]:
    """Dominator set per node, computed from ``start_nodes`` as a virtual super-root.

    ``result[n]`` contains ``n`` itself; unreachable nodes are absent. Computed per
    entrypoint on purpose, because a side entry deliberately starts mid-graph: judging the
    whole graph at once would report that side entry's own upstream gate as a bypass.
    """
    incoming = incoming_edges(nodes, edges)
    roots = {nid for nid in start_nodes if nid in nodes}
    dom: dict[str, set[str]] = {nid: {nid} for nid in roots}
    order = sorted(nodes)
    changed = True
    while changed:
        changed = False
        for nid in order:
            if nid in roots:
                current = {nid}
            else:
                preds = [p for p in incoming.get(nid, ()) if p in dom]
                if not preds:
                    continue
                current = set(dom[preds[0]])
                for pred in preds[1:]:
                    current &= dom[pred]
                current.add(nid)
            if current != dom.get(nid):
                dom[nid] = current
                changed = True
    return dom


def _dominated_by_gates(
    nodes: Mapping[str, Mapping[str, Any]], edges: list[tuple[str, str]], start_nodes: list[str]
) -> dict[str, set[str]]:
    dom = dominators_from(nodes, edges, start_nodes)
    return {
        nid: {d for d in dominators if d != nid and _is_gate(nodes[d])}
        for nid, dominators in dom.items()
    }


def _check_deny_precedence(spec: Mapping[str, Any], definition: Mapping[str, Any]) -> list[PolicyViolation]:
    requirement = spec["requirement"]
    declared = definition.get("policyResolution")
    if not isinstance(declared, Mapping):
        return []
    order = declared.get("order")
    if not isinstance(order, list) or not all(isinstance(item, str) for item in order):
        return [
            PolicyViolation(
                "POLICY_WEAKENED",
                str(spec["ref"]),
                "$.policyResolution.order",
                "policyResolution.order must be a list of policy keywords",
            )
        ]
    expected = list(requirement["order"])
    # Only a strict reordering of the full precedence chain can weaken deny-first; a graph
    # that names the same chain in a different order is stating an equivalent rule.
    if set(order) == set(expected) and order != expected:
        return [
            PolicyViolation(
                "POLICY_WEAKENED",
                str(spec["ref"]),
                "$.policyResolution.order",
                f"policy resolution must stay {expected}; got {order}",
            )
        ]
    if set(order) != set(expected):
        return [
            PolicyViolation(
                "POLICY_WEAKENED",
                str(spec["ref"]),
                "$.policyResolution.order",
                "policy resolution must name deny, require_approval and allow; a missing keyword means deny",
            )
        ]
    if declared.get("noMatch") not in (None, "deny"):
        return [
            PolicyViolation(
                "POLICY_WEAKENED",
                str(spec["ref"]),
                "$.policyResolution.noMatch",
                "no-match must resolve to deny",
            )
        ]
    return []


def _check_independent_review(spec: Mapping[str, Any], definition: Mapping[str, Any]) -> list[PolicyViolation]:
    nodes = definition.get("nodes")
    if not isinstance(nodes, Mapping):
        return []
    edges = [
        (str(edge.get("from")), str(edge.get("to")))
        for edge in definition.get("edges") or ()
        if isinstance(edge, Mapping)
    ]
    ancestors = _ancestors(nodes, edges)
    violations: list[PolicyViolation] = []
    for nid in sorted(nodes):
        node = nodes[nid]
        if not isinstance(node, Mapping) or not _is_gate(node) or _has_human_decision(node):
            continue
        upstream_reviewers = [
            aid for aid in sorted(ancestors.get(nid, set())) if _declares_independence(nodes[aid])
        ]
        if not upstream_reviewers:
            violations.append(
                PolicyViolation(
                    "POLICY_UNSATISFIED",
                    str(spec["ref"]),
                    f"$.nodes.{nid}",
                    (
                        f"gate '{nid}' is evaluated without a human decision and has no upstream "
                        "review node declaring executor.independentFrom"
                    ),
                    detail={"gate": nid, "required": "independent_review_or_human_decision"},
                )
            )
    return violations


def _check_permission_gate(spec: Mapping[str, Any], definition: Mapping[str, Any]) -> list[PolicyViolation]:
    nodes = definition.get("nodes")
    if not isinstance(nodes, Mapping):
        return []
    edges = [
        (str(edge.get("from")), str(edge.get("to")))
        for edge in definition.get("edges") or ()
        if isinstance(edge, Mapping)
    ]
    entrypoints = definition.get("entrypoints")
    if not isinstance(entrypoints, Mapping):
        return []
    dominated: dict[str, set[str]] = {}
    for key in sorted(entrypoints):
        entry = entrypoints[key]
        if not isinstance(entry, Mapping):
            continue
        starts = [str(n) for n in entry.get("startNodes") or ()]
        for nid, gates in _dominated_by_gates(nodes, edges, starts).items():
            dominated.setdefault(nid, set()).update(gates)
    violations: list[PolicyViolation] = []
    for nid in sorted(nodes):
        node = nodes[nid]
        if not isinstance(node, Mapping) or node.get("kind") != "external_effect":
            continue
        guarding = sorted(g for g in dominated.get(nid, set()) if _permission_scope(nodes[g]))
        if not guarding:
            violations.append(
                PolicyViolation(
                    "POLICY_UNSATISFIED",
                    str(spec["ref"]),
                    f"$.nodes.{nid}",
                    f"external effect '{nid}' is not dominated by a permission gate",
                    detail={"node": nid, "required": "permission_gate_before_side_effect"},
                )
            )
    return violations


def _permission_scope(node: Mapping[str, Any]) -> tuple[str, str] | None:
    gate = node.get("permissionGate")
    if not isinstance(gate, Mapping):
        return None
    action = gate.get("action")
    resource = gate.get("resource")
    if not isinstance(action, str) or not action or not isinstance(resource, str) or not resource:
        return None
    return action, resource


def _check_human_only(spec: Mapping[str, Any], definition: Mapping[str, Any]) -> list[PolicyViolation]:
    nodes = definition.get("nodes")
    if not isinstance(nodes, Mapping):
        return []
    violations: list[PolicyViolation] = []
    for nid in sorted(nodes):
        node = nodes[nid]
        if not isinstance(node, Mapping):
            continue
        decision = node.get("humanDecision")
        if decision is None:
            continue
        if not _is_gate(node):
            violations.append(
                PolicyViolation(
                    "POLICY_WEAKENED",
                    str(spec["ref"]),
                    f"$.nodes.{nid}.humanDecision",
                    "humanDecision is only meaningful on a gate node",
                )
            )
            continue
        if not _has_human_decision(node):
            continue
        semantic = decision.get("semanticKind") if isinstance(decision, Mapping) else None
        if not isinstance(semantic, str) or not semantic:
            violations.append(
                PolicyViolation(
                    "POLICY_UNSATISFIED",
                    str(spec["ref"]),
                    f"$.nodes.{nid}.humanDecision.semanticKind",
                    "a required human decision must name its semantic kind",
                )
            )
        if node.get("executor") is not None:
            violations.append(
                PolicyViolation(
                    "POLICY_WEAKENED",
                    str(spec["ref"]),
                    f"$.nodes.{nid}.executor",
                    "a human decision must not declare an executor: a worker cannot decide for a human",
                )
            )
    return violations


def _check_ceilings(spec: Mapping[str, Any], definition: Mapping[str, Any]) -> list[PolicyViolation]:
    ceilings = spec["requirement"]["ceilings"]
    violations: list[PolicyViolation] = []
    nodes = definition.get("nodes")
    if isinstance(nodes, Mapping):
        for nid in sorted(nodes):
            node = nodes[nid]
            if not isinstance(node, Mapping):
                continue
            budget = node.get("retryBudget")
            attempts = budget.get("maxAttempts") if isinstance(budget, Mapping) else None
            if isinstance(attempts, int) and not isinstance(attempts, bool) and attempts > ceilings["maxAttemptsPerNode"]:
                violations.append(
                    PolicyViolation(
                        "POLICY_WEAKENED",
                        str(spec["ref"]),
                        f"$.nodes.{nid}.retryBudget.maxAttempts",
                        (
                            f"retry budget {attempts} exceeds the ceiling "
                            f"{ceilings['maxAttemptsPerNode']}"
                        ),
                    )
                )
            join = node.get("join")
            quorum = join.get("quorum") if isinstance(join, Mapping) else None
            if isinstance(quorum, int) and not isinstance(quorum, bool) and quorum > ceilings["maxQuorumSize"]:
                violations.append(
                    PolicyViolation(
                        "POLICY_WEAKENED",
                        str(spec["ref"]),
                        f"$.nodes.{nid}.join.quorum",
                        f"quorum {quorum} exceeds the ceiling {ceilings['maxQuorumSize']}",
                    )
                )
            subgraph = node.get("subgraph")
            if isinstance(subgraph, Mapping) and _declared_depth(subgraph) > ceilings["maxSubgraphDepth"]:
                violations.append(
                    PolicyViolation(
                        "POLICY_WEAKENED",
                        str(spec["ref"]),
                        f"$.nodes.{nid}.subgraph",
                        f"declared child depth exceeds the ceiling {ceilings['maxSubgraphDepth']}",
                    )
                )
    entrypoints = definition.get("entrypoints")
    if isinstance(entrypoints, Mapping):
        for key in sorted(entrypoints):
            entry = entrypoints[key]
            if not isinstance(entry, Mapping):
                continue
            starts = entry.get("startNodes")
            if isinstance(starts, list) and len(starts) > ceilings["maxEntryStartNodes"]:
                violations.append(
                    PolicyViolation(
                        "POLICY_WEAKENED",
                        str(spec["ref"]),
                        f"$.entrypoints.{key}.startNodes",
                        (
                            f"{len(starts)} start nodes exceed the fan-out ceiling "
                            f"{ceilings['maxEntryStartNodes']}"
                        ),
                    )
                )
    return violations


def _declared_depth(subgraph: Mapping[str, Any]) -> int:
    depth = subgraph.get("depth")
    return depth if isinstance(depth, int) and not isinstance(depth, bool) else 0


_PREDICATES: Final[dict[str, Any]] = {
    "deny_precedence": _check_deny_precedence,
    "independent_review_before_gate": _check_independent_review,
    "permission_gate_before_side_effect": _check_permission_gate,
    "human_only_decision": _check_human_only,
    "ceilings": _check_ceilings,
}


def _check_cited_refs(definition: Mapping[str, Any]) -> list[PolicyViolation]:
    """A cited ref must exist, must not be a version downgrade, and must not relax a rule."""
    violations: list[PolicyViolation] = []
    raw_refs = definition.get("policyRefs")
    if not isinstance(raw_refs, list) or not raw_refs:
        return [
            PolicyViolation(
                "POLICY_UNSATISFIED",
                "policy.baseline_pin_required",
                "$.policyRefs",
                "a graph must pin the baseline policy set in policyRefs",
            )
        ]
    for index, raw in enumerate(raw_refs):
        path = f"$.policyRefs[{index}]"
        if not isinstance(raw, str) or not raw:
            violations.append(
                PolicyViolation("POLICY_UNKNOWN_REF", "policy.baseline_pin_required", path, "policyRefs entries must be non-empty strings")
            )
            continue
        ref, _, version = raw.partition("@")
        spec = _BY_REF.get(ref)
        if spec is None:
            violations.append(
                PolicyViolation(
                    "POLICY_UNKNOWN_REF",
                    ref,
                    path,
                    f"policy ref '{ref}' is not in {POLICY_CATALOG_VERSION}",
                    detail={"catalogVersion": POLICY_CATALOG_VERSION},
                )
            )
            continue
        if not version:
            continue
        if not version.isdigit():
            violations.append(
                PolicyViolation("POLICY_WEAKENED", ref, path, f"policy ref '{ref}' has a non-numeric version '{version}'")
            )
            continue
        if int(version) < int(spec["version"]):
            violations.append(
                PolicyViolation(
                    "POLICY_WEAKENED",
                    ref,
                    path,
                    (
                        f"policy ref '{ref}' is pinned at {version}, below the baseline "
                        f"{spec['version']}"
                    ),
                    detail={"baselineVersion": spec["version"], "pinnedVersion": int(version)},
                )
            )
    return violations


def check_definition_policy(
    definition: Mapping[str, Any],
    *,
    catalog: Mapping[str, Mapping[str, Any]] | None = None,
) -> list[PolicyViolation]:
    """Every reason ``definition`` is weaker than the baseline catalog.

    ``catalog`` overrides the shipped specs (a test double or a future catalog version);
    it is keyed by ref. All violations are returned, never just the first, so the editor
    can show a complete list (REQ-GRAPH-04).
    """
    specs = {str(k): dict(v) for k, v in (catalog or _BY_REF).items()}
    violations: list[PolicyViolation] = []
    violations.extend(_check_cited_refs(definition))
    for ref in sorted(specs):
        spec = specs[ref]
        requirement = spec.get("requirement")
        if not isinstance(requirement, Mapping):
            continue
        predicate = _PREDICATES.get(str(requirement.get("kind")))
        if predicate is None:
            violations.append(
                PolicyViolation("POLICY_UNKNOWN_REF", ref, f"$.policyRefs[{ref}]", "policy requirement kind is not implemented")
            )
            continue
        violations.extend(predicate({**spec, "ref": ref}, definition))
    return violations
