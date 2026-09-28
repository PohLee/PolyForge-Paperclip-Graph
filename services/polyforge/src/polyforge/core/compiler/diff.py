"""Semantic diff between two graph definitions.

Responsibility: describe what actually changed between two versions in the terms the
migration flow needs — which nodes, which edges, which policy pins — and, crucially,
decide whether a PASS recorded against the old version may be carried forward.

Invariants
----------
* Cosmetic changes are not semantic. Layout is excluded from the node fingerprint, so
  dragging a node on the canvas produces an empty diff and never invalidates evidence.
* ``invalidates_evidence`` is conservative by construction. It is true when a node was
  removed, when any node's semantics, inputs or evaluators changed, when the policy set
  changed, or when a gate was **added**. A brand new gate has no PASS to inherit, so the
  migration must actually run it (REQ-MIG-04).
* A node's fingerprint includes its incident edges. A predecessor that changed changes
  this node's effective inputs even when the node body is untouched, and an evidence set
  that was valid for the old input is not valid for the new one.
* Removing a node is reported, never applied. Deleting a node from a definition says
  nothing about the external effects it already caused; those records stay in the effect
  ledger (docs/02-TECHNICAL-PLAN.md section 11).
* The diff is pure: it reads its two arguments and returns a value. Version numbers are
  carried through for display and are supplied by the caller, which is the only place
  that knows what they mean.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping, Sequence

from polyforge.core import hashing
from polyforge.core.state import NodeKind

__all__ = ["SemanticDiff", "edge_identity", "node_fingerprint", "semantic_diff"]


@dataclass(slots=True)
class SemanticDiff:
    """Mirrors ``SemanticDiff`` in ``packages/protocol/src/api.ts``."""

    graph_id: str
    from_version: int | None = None
    to_version: int | None = None
    added_nodes: list[str] = field(default_factory=list)
    removed_nodes: list[str] = field(default_factory=list)
    changed_nodes: list[str] = field(default_factory=list)
    added_edges: list[str] = field(default_factory=list)
    removed_edges: list[str] = field(default_factory=list)
    policy_changes: list[str] = field(default_factory=list)
    invalidates_evidence: bool = False

    @property
    def is_noop(self) -> bool:
        return not (
            self.added_nodes
            or self.removed_nodes
            or self.changed_nodes
            or self.added_edges
            or self.removed_edges
            or self.policy_changes
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "graphId": self.graph_id,
            "fromVersion": self.from_version,
            "toVersion": self.to_version,
            "addedNodes": list(self.added_nodes),
            "removedNodes": list(self.removed_nodes),
            "changedNodes": list(self.changed_nodes),
            "addedEdges": list(self.added_edges),
            "removedEdges": list(self.removed_edges),
            "policyChanges": list(self.policy_changes),
            "invalidatesEvidence": self.invalidates_evidence,
        }

    @classmethod
    def from_dict(cls, body: Mapping[str, Any]) -> "SemanticDiff":
        return cls(
            graph_id=str(body.get("graphId") or ""),
            from_version=body.get("fromVersion"),
            to_version=body.get("toVersion"),
            added_nodes=list(body.get("addedNodes") or ()),
            removed_nodes=list(body.get("removedNodes") or ()),
            changed_nodes=list(body.get("changedNodes") or ()),
            added_edges=list(body.get("addedEdges") or ()),
            removed_edges=list(body.get("removedEdges") or ()),
            policy_changes=list(body.get("policyChanges") or ()),
            invalidates_evidence=bool(body.get("invalidatesEvidence")),
        )


def edge_identity(edge: Mapping[str, Any]) -> str:
    """Readable, stable edge identity. A guard change is a remove plus an add."""
    guard = edge.get("guard")
    base = f"{edge.get('from')}->{edge.get('to')}"
    return f"{base}[{guard}]" if isinstance(guard, str) and guard else base


def _edges(definition: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    raw = definition.get("edges")
    if not isinstance(raw, list):
        return []
    return [edge for edge in raw if isinstance(edge, Mapping)]


def _nodes(definition: Mapping[str, Any]) -> dict[str, Mapping[str, Any]]:
    raw = definition.get("nodes")
    if not isinstance(raw, Mapping):
        return {}
    return {key: value for key, value in raw.items() if isinstance(value, Mapping)}


def node_fingerprint(
    node_id: str,
    node: Mapping[str, Any],
    incoming: Sequence[str],
    outgoing: Sequence[str],
) -> str:
    """Content hash of a node's *meaning*: its body plus its incident edges.

    Layout is excluded by name (REQ-GRAPH-02), and incident edges are included so that a
    changed predecessor or successor changes the fingerprint of this node too.
    """
    return hashing.hash_domain(
        "pf.node",
        {
            "node": hashing.strip_for_hash(dict(node), frozenset({"layout"})),
            "incoming": sorted(incoming),
            "outgoing": sorted(outgoing),
        },
    )


def _incidence(definition: Mapping[str, Any]) -> tuple[dict[str, list[str]], dict[str, list[str]]]:
    incoming: dict[str, list[str]] = {}
    outgoing: dict[str, list[str]] = {}
    for edge in _edges(definition):
        src = str(edge.get("from"))
        dst = str(edge.get("to"))
        incoming.setdefault(dst, []).append(edge_identity(edge))
        outgoing.setdefault(src, []).append(edge_identity(edge))
    return incoming, outgoing


def _policy_changes(
    before: Mapping[str, Any], after: Mapping[str, Any]
) -> list[str]:
    old = sorted(str(item) for item in before.get("policyRefs") or ())
    new = sorted(str(item) for item in after.get("policyRefs") or ())
    changes: list[str] = []
    for ref in new:
        if ref not in old:
            changes.append(f"+{ref}")
    for ref in old:
        if ref not in new:
            changes.append(f"-{ref}")
    return changes


def semantic_diff(
    from_definition: Mapping[str, Any] | None,
    to_definition: Mapping[str, Any] | None,
    *,
    from_version: int | None = None,
    to_version: int | None = None,
) -> SemanticDiff:
    """Diff two definitions. ``None`` is treated as an empty graph.

    ``from_version`` / ``to_version`` are pass-through labels; the caller that resolved
    them owns the mapping between those numbers and the definitions it passed in.
    """
    before: Mapping[str, Any] = from_definition or {}
    after: Mapping[str, Any] = to_definition or {}

    graph_id = str(after.get("graphId") or before.get("graphId") or "")
    old_nodes = _nodes(before)
    new_nodes = _nodes(after)
    old_in, old_out = _incidence(before)
    new_in, new_out = _incidence(after)

    added = sorted(set(new_nodes) - set(old_nodes))
    removed = sorted(set(old_nodes) - set(new_nodes))
    changed = [
        nid
        for nid in sorted(set(new_nodes) & set(old_nodes))
        if node_fingerprint(nid, old_nodes[nid], old_in.get(nid, ()), old_out.get(nid, ()))
        != node_fingerprint(nid, new_nodes[nid], new_in.get(nid, ()), new_out.get(nid, ()))
    ]

    old_edges = {edge_identity(edge) for edge in _edges(before)}
    new_edges = {edge_identity(edge) for edge in _edges(after)}

    policy_changes = _policy_changes(before, after)

    # A new gate has no evidence of its own, so it must be evaluated for real. Adding one
    # is the classic way a migration would otherwise let work skip a control.
    added_gates = [
        nid
        for nid in added
        if new_nodes[nid].get("kind") == NodeKind.GATE.value
    ]
    invalidates = bool(removed or changed or policy_changes or added_gates)

    return SemanticDiff(
        graph_id=graph_id,
        from_version=from_version,
        to_version=to_version,
        added_nodes=added,
        removed_nodes=removed,
        changed_nodes=changed,
        added_edges=sorted(new_edges - old_edges),
        removed_edges=sorted(old_edges - new_edges),
        policy_changes=policy_changes,
        invalidates_evidence=invalidates,
    )
