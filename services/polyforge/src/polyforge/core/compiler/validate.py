"""Structural, contract and policy validation of a ``GraphDefinition``.

Responsibility: answer one question — may this definition be compiled and published? —
and answer it with a complete, addressable list of issues. ``validate_definition`` never
stops at the first problem (REQ-GRAPH-04) and never mutates its input.

Invariants
----------
* Total function. A malformed definition yields a report with ``ok=False`` and the
  offending paths; it does not raise, because the editor renders the same report for a
  hand-typed definition and for a YAML import.
* Every issue carries a JSON ``path`` (``$.nodes.architecture.executor``) that locates the
  offending node, edge or field (REQ-UI-02).
* Security-relevant refusals are errors, never warnings: a missing permission gate, a
  join that routes around a mandatory gate, a weakened policy baseline, a self-recursive
  subgraph, or a side entry that cannot prove its prerequisite facts.
* ``definitionHash`` is ``hash_domain("pf.definition", ...)`` over the definition with
  layout and wall-clock bookkeeping excluded (docs/05-PROTOCOL.md section 2), so two
  structurally identical definitions validate to the same identity regardless of the
  editor's canvas positions.
* The same definition always produces the same report ordering: issues are sorted by
  ``(path, code)`` before being returned.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Final, Mapping, Sequence

from polyforge import SCHEMA_VERSION
from polyforge.core import hashing
from polyforge.core.compiler.policy_catalog import (
    CEILINGS,
    check_definition_policy,
    dominators_from,
)
from polyforge.core.state import JoinSemantics, NodeKind

__all__ = [
    "ISSUE_CODES",
    "MAX_SUBGRAPH_DEPTH",
    "ValidationIssue",
    "ValidationReport",
    "definition_hash",
    "validate_definition",
]

#: A child graph may nest at most this many levels deep. Beyond it, a run could create
#: children faster than an operator can see them.
MAX_SUBGRAPH_DEPTH: Final[int] = int(CEILINGS["maxSubgraphDepth"])

_ERROR: Final[str] = "error"
_WARNING: Final[str] = "warning"

#: Every code this module can emit. The HTTP layer surfaces these verbatim, so the list is
#: part of the contract and must stay in sync with the checks below.
ISSUE_CODES: Final[tuple[str, ...]] = (
    # document / schema shape
    "SCHEMA_INVALID",
    "SCHEMA_VERSION_UNSUPPORTED",
    "GRAPH_ID_INVALID",
    "ENTRYPOINTS_INVALID",
    "NODES_INVALID",
    "EDGES_INVALID",
    # node identity and kind
    "NODE_ID_MISMATCH",
    "DUPLICATE_NODE_ID",
    "NODE_KIND_INVALID",
    "NODE_OPERATION_MISSING",
    "NODE_OPERATION_INVALID",
    "NODE_EXECUTOR_MISSING",
    "NODE_CAPABILITY_MISSING",
    "NODE_TIMEOUT_INVALID",
    # typed inputs / outputs / facts
    "NODE_INPUT_SLOT_INVALID",
    "NODE_INPUT_UNDECLARED",
    "NODE_REQUIRES_UNDECLARED",
    "NODE_OUTPUT_INVALID",
    "NODE_FACT_NAME_INVALID",
    "NODE_FACT_PRODUCER_AMBIGUOUS",
    # topology
    "EDGE_ENDPOINT_UNKNOWN",
    "EDGE_SELF_LOOP",
    "EDGE_DUPLICATE",
    "EDGE_GUARD_INVALID",
    "NODE_ISOLATED",
    "NODE_UNREACHABLE",
    "UNBOUNDED_CYCLE",
    "MANDATORY_GATE_BYPASS",
    # joins, loops, budgets
    "JOIN_SEMANTICS_INVALID",
    "JOIN_QUORUM_INVALID",
    "JOIN_INPUTS_MISMATCH",
    "RETRY_BUDGET_INVALID",
    # gates, evaluators, decisions, permissions
    "EVALUATOR_REF_MISSING",
    "EVALUATOR_REF_INVALID",
    "HUMAN_DECISION_INVALID",
    "PERMISSION_GATE_INVALID",
    "MISSING_PERMISSION_GATE",
    # entrypoints
    "ENTRYPOINT_KEY_INVALID",
    "ENTRYPOINT_START_EMPTY",
    "ENTRYPOINT_START_UNKNOWN",
    "ENTRYPOINT_EXPORTS_EMPTY",
    "ENTRYPOINT_EXPORT_UNDECLARED",
    "ENTRYPOINT_FACT_INVALID",
    "ENTRYPOINT_COORDINATOR_MISSING",
    "ENTRYPOINT_COORDINATOR_CAPABILITY_MISSING",
    "ENTRYPOINT_RESUME_POLICY_INVALID",
    "SIDEB_ENTRY_GATE_BYPASS",
    # subgraphs
    "SUBGRAPH_REFERENCE_UNRESOLVED",
    "SUBGRAPH_ENTRYPOINT_UNKNOWN",
    "SUBGRAPH_INPUT_UNSATISFIED",
    "SUBGRAPH_BUDGET_UNDECLARED",
    "SUBGRAPH_RECURSION",
    "SUBGRAPH_DEPTH_EXCEEDED",
    # policy catalog
    "POLICY_UNKNOWN_REF",
    "POLICY_WEAKENED",
    "POLICY_UNSATISFIED",
    # advisory only
    "LAYOUT_IN_DEFINITION",
)

_NODE_KINDS: Final[frozenset[str]] = frozenset(kind.value for kind in NodeKind)
_JOIN_SEMANTICS: Final[frozenset[str]] = frozenset(value.value for value in JoinSemantics)


@dataclass(frozen=True, slots=True)
class ValidationIssue:
    """One addressable defect. Mirrors ``ValidationIssue`` in ``packages/protocol/src/api.ts``."""

    severity: str
    code: str
    path: str
    message: str

    def to_dict(self) -> dict[str, str]:
        return {
            "severity": self.severity,
            "code": self.code,
            "path": self.path,
            "message": self.message,
        }


@dataclass(slots=True)
class ValidationReport:
    """The result of validating one definition at one draft revision.

    ``revision`` and ``draft_id`` are optional because the compiler and the graph library
    validate definitions that are not attached to a draft. The HTTP layer always fills
    them, which is what makes the wire shape match ``ValidationReport`` exactly.
    """

    ok: bool
    issues: list[ValidationIssue]
    definition_hash: str
    revision: int | None = None
    draft_id: str | None = None

    @property
    def errors(self) -> list[ValidationIssue]:
        return [issue for issue in self.issues if issue.severity == _ERROR]

    def code_set(self) -> frozenset[str]:
        return frozenset(issue.code for issue in self.issues)

    def for_draft(self, draft_id: str, revision: int) -> "ValidationReport":
        """The same report stamped with the draft it belongs to.

        A report produced by the compiler or the library carries no draft identity; the
        publish path needs one, and stamping it here keeps ``draftId``/``revision`` from
        being forgotten at the call site.
        """
        return ValidationReport(
            ok=self.ok,
            issues=list(self.issues),
            definition_hash=self.definition_hash,
            revision=int(revision),
            draft_id=draft_id,
        )

    def to_dict(self) -> dict[str, Any]:
        body: dict[str, Any] = {
            "ok": self.ok,
            "issues": [issue.to_dict() for issue in self.issues],
            "definitionHash": self.definition_hash,
        }
        if self.draft_id is not None:
            body["draftId"] = self.draft_id
        if self.revision is not None:
            body["revision"] = self.revision
        return body

    @classmethod
    def from_dict(cls, body: Mapping[str, Any]) -> "ValidationReport":
        return cls(
            ok=bool(body.get("ok")),
            issues=[ValidationIssue(**issue) for issue in body.get("issues") or ()],
            definition_hash=str(body.get("definitionHash") or ""),
            revision=body.get("revision"),
            draft_id=body.get("draftId"),
        )


def definition_hash(definition: Mapping[str, Any]) -> str:
    """``pf.definition`` digest: canonical definition, layout and timestamps excluded.

    ``layout`` is stripped here rather than in the caller because REQ-GRAPH-02 requires
    that moving a node on the canvas never changes the execution identity.
    """
    return hashing.hash_domain(
        "pf.definition", hashing.strip_for_hash(dict(definition), frozenset({"layout"}))
    )


def _library_graphs() -> Mapping[str, dict]:
    """The shipped library, resolved lazily so the compiler has no import cycle."""
    try:
        from polyforge.graph_library import all_definitions
    except Exception:  # pragma: no cover - library is part of the same distribution
        return {}
    return all_definitions()


def _edge_list(definition: Mapping[str, Any]) -> list[tuple[str, str, str | None]]:
    edges: list[tuple[str, str, str | None]] = []
    raw = definition.get("edges")
    if not isinstance(raw, list):
        return edges
    for edge in raw:
        if not isinstance(edge, Mapping):
            continue
        guard = edge.get("guard")
        edges.append(
            (
                str(edge.get("from")) if edge.get("from") is not None else "",
                str(edge.get("to")) if edge.get("to") is not None else "",
                guard if isinstance(guard, str) and guard else None,
            )
        )
    return edges


def _string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, str) and item]


def _attempt_count(node: Mapping[str, Any]) -> int | None:
    budget = node.get("retryBudget")
    if not isinstance(budget, Mapping):
        return None
    value = budget.get("maxAttempts")
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value


class _Collector:
    """Accumulates issues in discovery order, then hands them out deterministically."""

    __slots__ = ("_issues",)

    def __init__(self) -> None:
        self._issues: list[ValidationIssue] = []

    def error(self, code: str, path: str, message: str) -> None:
        self._issues.append(ValidationIssue(_ERROR, code, path, message))

    def warn(self, code: str, path: str, message: str) -> None:
        self._issues.append(ValidationIssue(_WARNING, code, path, message))

    def add(self, issue: ValidationIssue) -> None:
        self._issues.append(issue)

    def sorted(self) -> list[ValidationIssue]:
        return sorted(self._issues, key=lambda issue: (issue.path, issue.code, issue.message))


def _validate_document(definition: Any, out: _Collector) -> dict:
    if not isinstance(definition, Mapping):
        out.error("SCHEMA_INVALID", "$", "graph definition must be a JSON object")
        return {}
    if not isinstance(definition.get("schemaVersion"), int) or isinstance(
        definition.get("schemaVersion"), bool
    ):
        out.error("SCHEMA_INVALID", "$.schemaVersion", "schemaVersion must be an integer")
    elif int(definition["schemaVersion"]) != SCHEMA_VERSION:
        out.error(
            "SCHEMA_VERSION_UNSUPPORTED",
            "$.schemaVersion",
            f"schemaVersion {definition['schemaVersion']} is not supported; this Core speaks {SCHEMA_VERSION}",
        )
    graph_id = definition.get("graphId")
    if not isinstance(graph_id, str) or not graph_id.strip():
        out.error("GRAPH_ID_INVALID", "$.graphId", "graphId must be a non-empty string")
    if not isinstance(definition.get("name"), str) or not definition.get("name"):
        out.error("SCHEMA_INVALID", "$.name", "name must be a non-empty string")
    if not isinstance(definition.get("nodes"), Mapping):
        out.error("NODES_INVALID", "$.nodes", "nodes must be an object keyed by node id")
    if not isinstance(definition.get("entrypoints"), Mapping):
        out.error("ENTRYPOINTS_INVALID", "$.entrypoints", "entrypoints must be an object keyed by entrypoint key")
    if not isinstance(definition.get("edges"), list):
        out.error("EDGES_INVALID", "$.edges", "edges must be an array")
    if not isinstance(definition.get("policyRefs"), list):
        out.error("SCHEMA_INVALID", "$.policyRefs", "policyRefs must be an array of policy refs")
    return dict(definition)


def _validate_node_identities(nodes: Mapping[str, Any], out: _Collector) -> None:
    declared: dict[str, str] = {}
    for key in nodes:
        node = nodes[key]
        if not isinstance(key, str) or not key.strip():
            out.error("NODE_ID_MISMATCH", "$.nodes", "node keys must be non-empty strings")
            continue
        if not isinstance(node, Mapping):
            out.error("SCHEMA_INVALID", f"$.nodes.{key}", "node must be a JSON object")
            continue
        node_id = node.get("id")
        if node_id is None:
            continue
        if not isinstance(node_id, str) or not node_id.strip():
            out.error("NODE_ID_MISMATCH", f"$.nodes.{key}.id", "node id must be a non-empty string")
            continue
        if node_id != key:
            out.error(
                "NODE_ID_MISMATCH",
                f"$.nodes.{key}.id",
                f"node id '{node_id}' does not match its key '{key}'; edges and entrypoints address nodes by key",
            )
        if node_id in declared:
            out.error(
                "DUPLICATE_NODE_ID",
                f"$.nodes.{key}.id",
                f"node id '{node_id}' is already declared by '{declared[node_id]}'",
            )
        else:
            declared[node_id] = key


def _validate_node_shape(nodes: Mapping[str, Any], out: _Collector) -> dict[str, dict]:
    producers: dict[str, str] = {}
    outputs: set[str] = set()
    for key in sorted(nodes):
        node = nodes[key]
        if not isinstance(node, Mapping):
            continue
        path = f"$.nodes.{key}"
        kind = node.get("kind")
        if kind not in _NODE_KINDS:
            out.error("NODE_KIND_INVALID", f"{path}.kind", f"node kind '{kind}' is not a NodeKind")
            continue

        if kind == NodeKind.AGENT_OPERATION.value:
            operation = node.get("operation")
            if not isinstance(operation, Mapping):
                out.error(
                    "NODE_OPERATION_MISSING",
                    f"{path}.operation",
                    "an agent_operation node must bind an operation contract",
                )
            else:
                version = operation.get("version")
                if not isinstance(operation.get("id"), str) or not operation.get("id"):
                    out.error("NODE_OPERATION_INVALID", f"{path}.operation.id", "operation.id must be a non-empty string")
                if isinstance(version, bool) or not isinstance(version, int) or int(version) < 1:
                    out.error(
                        "NODE_OPERATION_INVALID",
                        f"{path}.operation.version",
                        "operation.version must be a positive integer",
                    )
            executor = node.get("executor")
            if not isinstance(executor, Mapping):
                out.error("NODE_EXECUTOR_MISSING", f"{path}.executor", "an agent_operation node must declare its executor requirements")
            else:
                capabilities = executor.get("requiredCapabilities")
                if not _string_list(capabilities):
                    out.error(
                        "NODE_CAPABILITY_MISSING",
                        f"{path}.executor.requiredCapabilities",
                        "an executor must require at least one capability contract; an agent id is never an authorization (REQ-ENTRY-04)",
                    )
                for index, role in enumerate(_string_list(executor.get("preferredRoles")) + _string_list(executor.get("fallbackRoles"))):
                    if not role.strip():
                        out.error("SCHEMA_INVALID", f"{path}.executor.roles[{index}]", "role names must be non-empty")
                independent = executor.get("independentFrom")
                if independent is not None and not _string_list(independent):
                    out.error(
                        "SCHEMA_INVALID",
                        f"{path}.executor.independentFrom",
                        "independentFrom must be a non-empty list of capability refs or omit the key",
                    )

        for field in ("produces", "outputs"):
            raw = node.get(field)
            if raw is None:
                continue
            if not isinstance(raw, list):
                code = "NODE_OUTPUT_INVALID" if field == "outputs" else "NODE_FACT_NAME_INVALID"
                out.error(code, f"{path}.{field}", f"{field} must be an array of names")
                continue
            for index, item in enumerate(raw):
                if not isinstance(item, str) or not item.strip():
                    code = "NODE_OUTPUT_INVALID" if field == "outputs" else "NODE_FACT_NAME_INVALID"
                    out.error(code, f"{path}.{field}[{index}]", f"{field} entries must be non-empty names")
                    continue
                if field == "outputs":
                    if item in outputs:
                        out.error("NODE_OUTPUT_INVALID", f"{path}.outputs[{index}]", f"output type '{item}' is declared more than once")
                    outputs.add(item)
                elif item in producers:
                    out.error(
                        "NODE_FACT_PRODUCER_AMBIGUOUS",
                        f"{path}.produces[{index}]",
                        f"fact '{item}' is already produced by '{producers[item]}'; a fact with two producers has no traceable origin",
                    )
                else:
                    producers[item] = key

        inputs = node.get("inputs")
        if inputs is not None:
            if not isinstance(inputs, Mapping):
                out.error("NODE_INPUT_SLOT_INVALID", f"{path}.inputs", "inputs must be an object mapping slot name to fact name")
            else:
                for slot, fact in inputs.items():
                    if not isinstance(slot, str) or not slot.strip():
                        out.error("NODE_INPUT_SLOT_INVALID", f"{path}.inputs", "input slot names must be non-empty strings")
                    if not isinstance(fact, str) or not fact.strip():
                        out.error(
                            "NODE_INPUT_UNDECLARED",
                            f"{path}.inputs.{slot}",
                            "an input slot must name the fact it consumes",
                        )

        requires = node.get("requires")
        if requires is not None and not isinstance(requires, list):
            out.error("SCHEMA_INVALID", f"{path}.requires", "requires must be an array of fact names")

        timeout = node.get("timeoutSeconds")
        if timeout is not None and (isinstance(timeout, bool) or not isinstance(timeout, int) or int(timeout) <= 0):
            out.error("NODE_TIMEOUT_INVALID", f"{path}.timeoutSeconds", "timeoutSeconds must be a positive integer")

        attempts = _attempt_count(node)
        if attempts is not None and (attempts < 1 or attempts > CEILINGS["maxAttemptsPerNode"]):
            out.error(
                "RETRY_BUDGET_INVALID",
                f"{path}.retryBudget.maxAttempts",
                f"retry budget must be between 1 and {CEILINGS['maxAttemptsPerNode']}",
            )

        _validate_join(node, key, path, out)
        _validate_evaluators(node, key, path, out)
        _validate_human_decision(node, key, path, out)
        _validate_permission(node, key, path, out)
        if node.get("layout") is not None:
            out.warn(
                "LAYOUT_IN_DEFINITION",
                f"{path}.layout",
                "layout is stripped from definitionHash; store canvas geometry in GraphLayout so editing it cannot change an execution identity",
            )
    return producers


def _validate_join(node: Mapping[str, Any], key: str, path: str, out: _Collector) -> None:
    join = node.get("join")
    if join is None:
        return
    if not isinstance(join, Mapping):
        out.error("JOIN_SEMANTICS_INVALID", f"{path}.join", "join must be an object")
        return
    semantics = join.get("semantics")
    if semantics not in _JOIN_SEMANTICS:
        out.error("JOIN_SEMANTICS_INVALID", f"{path}.join.semantics", f"join semantics '{semantics}' is not all/any/quorum")
    inputs = join.get("inputs")
    if not isinstance(inputs, list) or not _string_list(inputs):
        out.error("JOIN_INPUTS_MISMATCH", f"{path}.join.inputs", "join.inputs must list the node ids this join waits for")
        return
    if len(set(inputs)) != len(inputs):
        out.error("JOIN_INPUTS_MISMATCH", f"{path}.join.inputs", "join.inputs must not repeat a node id")
    if semantics == JoinSemantics.QUORUM.value:
        quorum = join.get("quorum")
        if isinstance(quorum, bool) or not isinstance(quorum, int):
            out.error("JOIN_QUORUM_INVALID", f"{path}.join.quorum", "a quorum join must declare quorum")
        elif int(quorum) < 1 or int(quorum) > len(inputs):
            out.error(
                "JOIN_QUORUM_INVALID",
                f"{path}.join.quorum",
                f"quorum {quorum} must be between 1 and the number of declared inputs ({len(inputs)})",
            )


def _validate_evaluators(node: Mapping[str, Any], key: str, path: str, out: _Collector) -> None:
    refs = node.get("evaluatorRefs")
    human = node.get("humanDecision")
    if refs is None and human is None and node.get("kind") == NodeKind.GATE.value:
        out.error(
            "EVALUATOR_REF_MISSING",
            f"{path}.evaluatorRefs",
            "a gate must name at least one evaluator or a required human decision; an unevaluated gate would pass by default",
        )
        return
    if refs is None:
        return
    if not isinstance(refs, list) or not _string_list(refs):
        out.error("EVALUATOR_REF_INVALID", f"{path}.evaluatorRefs", "evaluatorRefs must be a non-empty array of evaluator refs")
        return
    seen: set[str] = set()
    for index, ref in enumerate(refs):
        if not isinstance(ref, str):
            out.error("EVALUATOR_REF_INVALID", f"{path}.evaluatorRefs[{index}]", "evaluator refs must be strings")
            continue
        if ref in seen:
            out.error("EVALUATOR_REF_INVALID", f"{path}.evaluatorRefs[{index}]", f"evaluator '{ref}' is listed twice")
        seen.add(ref)
        name, _, version = ref.partition("@")
        if not name.strip():
            out.error("EVALUATOR_REF_INVALID", f"{path}.evaluatorRefs[{index}]", "evaluator ref must name an evaluator")
        if version and not version.isdigit():
            out.error("EVALUATOR_REF_INVALID", f"{path}.evaluatorRefs[{index}]", "evaluator version must be numeric when present")
    if node.get("kind") != NodeKind.GATE.value:
        out.error("EVALUATOR_REF_INVALID", f"{path}.evaluatorRefs", "evaluatorRefs belong on a gate node")


def _validate_human_decision(node: Mapping[str, Any], key: str, path: str, out: _Collector) -> None:
    decision = node.get("humanDecision")
    if decision is None:
        return
    if not isinstance(decision, Mapping):
        out.error("HUMAN_DECISION_INVALID", f"{path}.humanDecision", "humanDecision must be an object")
        return
    if not isinstance(decision.get("required"), bool):
        out.error("HUMAN_DECISION_INVALID", f"{path}.humanDecision.required", "humanDecision.required must be a boolean")
    if not isinstance(decision.get("semanticKind"), str) or not decision.get("semanticKind"):
        out.error(
            "HUMAN_DECISION_INVALID",
            f"{path}.humanDecision.semanticKind",
            "humanDecision.semanticKind must name the engineering decision being asked for",
        )


def _validate_permission(node: Mapping[str, Any], key: str, path: str, out: _Collector) -> None:
    gate = node.get("permissionGate")
    if gate is None:
        return
    if not isinstance(gate, Mapping):
        out.error("PERMISSION_GATE_INVALID", f"{path}.permissionGate", "permissionGate must be an object")
        return
    for field in ("action", "resource"):
        value = gate.get(field)
        if not isinstance(value, str) or not value.strip():
            out.error(
                "PERMISSION_GATE_INVALID",
                f"{path}.permissionGate.{field}",
                f"permissionGate.{field} must name the exact {field} an authorization would cover",
            )


def _validate_edges(definition: Mapping[str, Any], nodes: Mapping[str, Any], out: _Collector) -> list[tuple[str, str, str | None]]:
    raw = definition.get("edges")
    valid: list[tuple[str, str, str | None]] = []
    if not isinstance(raw, list):
        return valid
    seen: set[tuple[str, str, str | None]] = set()
    for index, edge in enumerate(raw):
        path = f"$.edges[{index}]"
        if not isinstance(edge, Mapping):
            out.error("EDGES_INVALID", path, "an edge must be an object with from and to")
            continue
        src = edge.get("from")
        dst = edge.get("to")
        if not isinstance(src, str) or not isinstance(dst, str) or not src or not dst:
            out.error("EDGES_INVALID", path, "from and to must be non-empty node ids")
            continue
        guard = edge.get("guard")
        if guard is not None and (not isinstance(guard, str) or not guard):
            out.error("EDGE_GUARD_INVALID", f"{path}.guard", "a guard must be a non-empty string when present")
        if src == dst:
            out.error("EDGE_SELF_LOOP", path, f"node '{src}' cannot depend on itself")
            continue
        if src not in nodes:
            out.error("EDGE_ENDPOINT_UNKNOWN", f"{path}.from", f"edge source '{src}' is not a declared node")
            continue
        if dst not in nodes:
            out.error("EDGE_ENDPOINT_UNKNOWN", f"{path}.to", f"edge target '{dst}' is not a declared node")
            continue
        identity = (src, dst, guard if isinstance(guard, str) and guard else None)
        if identity in seen:
            out.error("EDGE_DUPLICATE", path, f"edge {src} -> {dst} is declared more than once")
            continue
        seen.add(identity)
        valid.append(identity)
    return valid


def _is_gate(node: Any) -> bool:
    return isinstance(node, Mapping) and node.get("kind") == NodeKind.GATE.value


def _ancestors(nodes: Mapping[str, Any], edges: Sequence[tuple[str, str, str | None]]) -> dict[str, set[str]]:
    incoming: dict[str, set[str]] = {nid: set() for nid in nodes}
    for src, dst, _ in edges:
        incoming[dst].add(src)
    resolved: dict[str, set[str]] = {}
    for nid in nodes:
        seen: set[str] = set()
        stack = list(incoming.get(nid, ()))
        while stack:
            current = stack.pop()
            if current in seen:
                continue
            seen.add(current)
            stack.extend(incoming.get(current, ()))
        resolved[nid] = seen
    return resolved


def _reachable_from(starts: Sequence[str], nodes: Mapping[str, Any], edges: Sequence[tuple[str, str, str | None]]) -> set[str]:
    outgoing: dict[str, list[str]] = {nid: [] for nid in nodes}
    for src, dst, _ in edges:
        outgoing[src].append(dst)
    seen: set[str] = set()
    stack = [nid for nid in starts if nid in nodes]
    while stack:
        current = stack.pop()
        if current in seen:
            continue
        seen.add(current)
        stack.extend(outgoing.get(current, ()))
    return seen


def _cycle_members(nodes: Mapping[str, Any], edges: Sequence[tuple[str, str, str | None]]) -> set[str]:
    """Nodes that can reach themselves, i.e. every node on a cycle."""
    return {nid for nid, parents in _ancestors(nodes, edges).items() if nid in parents}


def _validate_reachability(
    definition: Mapping[str, Any],
    nodes: Mapping[str, Any],
    edges: Sequence[tuple[str, str, str | None]],
    out: _Collector,
) -> dict[str, set[str]]:
    entrypoints = definition.get("entrypoints")
    reachable: set[str] = set()
    if isinstance(entrypoints, Mapping):
        for key in sorted(entrypoints):
            entry = entrypoints[key]
            starts = _string_list(entry.get("startNodes")) if isinstance(entry, Mapping) else []
            reachable |= _reachable_from(starts, nodes, edges)
    degree: dict[str, int] = {nid: 0 for nid in nodes}
    for src, dst, _ in edges:
        degree[src] = degree.get(src, 0) + 1
        degree[dst] = degree.get(dst, 0) + 1
    for nid in sorted(nodes):
        if degree.get(nid, 0) == 0:
            out.error("NODE_ISOLATED", f"$.nodes.{nid}", f"node '{nid}' has no edges; it can never run")
        elif nid not in reachable:
            out.error(
                "NODE_UNREACHABLE",
                f"$.nodes.{nid}",
                f"node '{nid}' is not reachable from any entrypoint start node",
            )

    looping = _cycle_members(nodes, edges)
    for nid in sorted(looping):
        node = nodes.get(nid)
        if not isinstance(node, Mapping):
            continue
        attempts = _attempt_count(node)
        if attempts is None:
            out.error(
                "UNBOUNDED_CYCLE",
                f"$.nodes.{nid}.retryBudget",
                f"node '{nid}' is on a cycle and declares no retryBudget; the run would have no terminal outcome",
            )
    return _ancestors(nodes, edges)


def _validate_fact_flow(
    definition: Mapping[str, Any],
    nodes: Mapping[str, Any],
    edges: Sequence[tuple[str, str, str | None]],
    ancestors: Mapping[str, set[str]],
    producers: Mapping[str, str],
    out: _Collector,
) -> None:
    entrypoints = definition.get("entrypoints") or {}
    entry_inputs: dict[str, set[str]] = {}
    for key, entry in entrypoints.items():
        if not isinstance(entry, Mapping):
            continue
        starts = _string_list(entry.get("startNodes"))
        for node_id in _reachable_from(starts, nodes, edges):
            entry_inputs.setdefault(node_id, set()).update(_string_list(entry.get("inputs")))

    external: set[str] = set()
    for entry in entrypoints.values():
        if isinstance(entry, Mapping):
            external.update(_string_list(entry.get("requiresFacts")))

    for nid in sorted(nodes):
        node = nodes[nid]
        if not isinstance(node, Mapping):
            continue
        available = set(entry_inputs.get(nid, set()))
        for ancestor in ancestors.get(nid, set()):
            ancestor_node = nodes.get(ancestor)
            if isinstance(ancestor_node, Mapping):
                available.update(_string_list(ancestor_node.get("produces")))
        inputs = node.get("inputs")
        if isinstance(inputs, Mapping):
            for slot, fact in inputs.items():
                if not isinstance(fact, str) or not fact.strip():
                    continue
                if fact in available:
                    continue
                if fact in producers:
                    out.error(
                        "NODE_INPUT_UNDECLARED",
                        f"$.nodes.{nid}.inputs.{slot}",
                        (
                            f"fact '{fact}' is produced by '{producers[fact]}' but that node is not an "
                            f"ancestor of '{nid}'; add the edge instead of importing the fact silently"
                        ),
                    )
                else:
                    out.error(
                        "NODE_INPUT_UNDECLARED",
                        f"$.nodes.{nid}.inputs.{slot}",
                        f"fact '{fact}' is not produced by any node reachable before '{nid}'",
                    )
        requires = node.get("requires")
        if isinstance(requires, list):
            for index, fact in enumerate(requires):
                if not isinstance(fact, str) or not fact.strip():
                    out.error("NODE_FACT_NAME_INVALID", f"$.nodes.{nid}.requires[{index}]", "requires entries must be fact names")
                    continue
                if fact in producers or fact in available or fact in external:
                    continue
                out.error(
                    "NODE_REQUIRES_UNDECLARED",
                    f"$.nodes.{nid}.requires[{index}]",
                    f"precondition '{fact}' has no producer in this graph and no entrypoint supplies it",
                )


def _validate_permission_gates(
    definition: Mapping[str, Any],
    nodes: Mapping[str, Any],
    edges: Sequence[tuple[str, str, str | None]],
    out: _Collector,
) -> None:
    entrypoints = definition.get("entrypoints") or {}
    guarded: dict[str, set[str]] = {nid: set() for nid in nodes}
    for key in sorted(entrypoints):
        entry = entrypoints[key]
        if not isinstance(entry, Mapping):
            continue
        starts = _string_list(entry.get("startNodes"))
        dom = dominators_from(nodes, edges, starts)
        for nid, dominators in dom.items():
            guarded[nid] = guarded.get(nid, set()) | {
                d
                for d in dominators
                if d != nid and isinstance(nodes.get(d), Mapping) and nodes[d].get("permissionGate") is not None
            }
    for nid in sorted(nodes):
        node = nodes[nid]
        if not isinstance(node, Mapping) or node.get("kind") != NodeKind.EXTERNAL_EFFECT.value:
            continue
        if not guarded.get(nid):
            out.error(
                "MISSING_PERMISSION_GATE",
                f"$.nodes.{nid}",
                (
                    f"external effect '{nid}' can be reached without a permission gate; an authorization "
                    "must precede every side effect (REQ-GOV-05)"
                ),
            )


def _validate_mandatory_gates(
    definition: Mapping[str, Any],
    nodes: Mapping[str, Any],
    edges: Sequence[tuple[str, str, str | None]],
    out: _Collector,
) -> None:
    """A short-circuiting join may not be used to route around a mandatory gate.

    ``docs/05-PROTOCOL.md`` section 7: a graph's own ``all``/``any``/``quorum`` semantics
    cannot bypass a gate marked mandatory. Only the short-circuiting joins can: an ``all``
    join waits for every input, so a gated branch cannot be skipped by it. An ``any`` or
    ``quorum`` join that mixes a gate-protected branch with an unprotected one may pass on
    the unprotected branch while the protected branch's gate never ran.
    """
    entrypoints = definition.get("entrypoints") or {}
    for key in sorted(entrypoints):
        entry = entrypoints[key]
        if not isinstance(entry, Mapping):
            continue
        starts = _string_list(entry.get("startNodes"))
        if not starts:
            continue
        dom = dominators_from(nodes, edges, starts)
        for nid in sorted(nodes):
            node = nodes[nid]
            if not isinstance(node, Mapping):
                continue
            join = node.get("join")
            if not isinstance(join, Mapping):
                continue
            semantics = join.get("semantics")
            if semantics not in (JoinSemantics.ANY.value, JoinSemantics.QUORUM.value):
                continue
            declared = [i for i in _string_list(join.get("inputs")) if i in dom]
            if len(declared) < 2:
                declared = sorted(dom.get(nid, set()) - {nid})
            if len(declared) < 2:
                continue
            gates: set[str] = set()
            for source in declared:
                gates |= {d for d in dom.get(source, set()) if _is_gate(nodes.get(d))}
            if not gates:
                continue
            unprotected = [
                source
                for source in declared
                if not any(gate in dom.get(source, set()) for gate in gates)
            ]
            if unprotected:
                out.error(
                    "MANDATORY_GATE_BYPASS",
                    f"$.nodes.{nid}.join",
                    (
                        f"{semantics} join '{nid}' for entrypoint '{key}' mixes gate-protected branch(es) "
                        f"{sorted(gates)} with unprotected {unprotected}; the join can pass without the gate"
                    ),
                )


def _validate_entrypoints(
    definition: Mapping[str, Any],
    nodes: Mapping[str, Any],
    edges: Sequence[tuple[str, str, str | None]],
    out: _Collector,
) -> None:
    entrypoints = definition.get("entrypoints")
    if not isinstance(entrypoints, Mapping) or not entrypoints:
        out.error("ENTRYPOINTS_INVALID", "$.entrypoints", "a graph must declare at least one entrypoint")
        return
    for key in sorted(entrypoints):
        path = f"$.entrypoints.{key}"
        entry = entrypoints[key]
        if not isinstance(key, str) or not key.strip():
            out.error("ENTRYPOINT_KEY_INVALID", "$.entrypoints", "entrypoint keys must be non-empty strings")
            continue
        if not isinstance(entry, Mapping):
            out.error("ENTRYPOINTS_INVALID", path, "an entrypoint must be a JSON object")
            continue
        starts = entry.get("startNodes")
        if not isinstance(starts, list) or not _string_list(starts):
            out.error("ENTRYPOINT_START_EMPTY", f"{path}.startNodes", "an entrypoint must name the nodes it may start")
        else:
            for index, node_id in enumerate(starts):
                if not isinstance(node_id, str) or node_id not in nodes:
                    out.error(
                        "ENTRYPOINT_START_UNKNOWN",
                        f"{path}.startNodes[{index}]",
                        f"start node '{node_id}' is not a declared node",
                    )
        inputs = entry.get("inputs")
        if inputs is not None and not isinstance(inputs, list):
            out.error("SCHEMA_INVALID", f"{path}.inputs", "entrypoint inputs must be an array of fact names")
        facts = entry.get("requiresFacts")
        if facts is not None:
            if not isinstance(facts, list):
                out.error("SCHEMA_INVALID", f"{path}.requiresFacts", "requiresFacts must be an array of fact names")
            else:
                for index, fact in enumerate(facts):
                    if not isinstance(fact, str) or not fact.strip():
                        out.error("ENTRYPOINT_FACT_INVALID", f"{path}.requiresFacts[{index}]", "requiresFacts entries must be fact names")
        coordinator = entry.get("coordinator")
        if not isinstance(coordinator, Mapping):
            out.error(
                "ENTRYPOINT_COORDINATOR_MISSING",
                f"{path}.coordinator",
                "an entrypoint must declare its coordinator requirement (REQ-ENTRY-02)",
            )
        elif not _string_list(coordinator.get("requiredCapabilities")):
            out.error(
                "ENTRYPOINT_COORDINATOR_CAPABILITY_MISSING",
                f"{path}.coordinator.requiredCapabilities",
                "a coordinator requirement must name at least one capability contract",
            )
        exports = entry.get("exports")
        if not isinstance(exports, list) or not _string_list(exports):
            out.error(
                "ENTRYPOINT_EXPORTS_EMPTY",
                f"{path}.exports",
                "an entrypoint must declare the facts it promises to produce",
            )
        else:
            reachable = _reachable_from(_string_list(starts), nodes, edges)
            available: set[str] = set()
            for node_id in sorted(reachable):
                node = nodes.get(node_id)
                if isinstance(node, Mapping):
                    available.update(_string_list(node.get("produces")))
            for index, fact in enumerate(exports):
                if not isinstance(fact, str) or not fact.strip():
                    out.error("ENTRYPOINT_FACT_INVALID", f"{path}.exports[{index}]", "exports entries must be fact names")
                    continue
                if fact not in available:
                    out.error(
                        "ENTRYPOINT_EXPORT_UNDECLARED",
                        f"{path}.exports[{index}]",
                        (
                            f"export '{fact}' is not produced by any node reachable from this entrypoint; "
                            "an entry may only promise what it actually delivers"
                        ),
                    )
        resume = entry.get("resumePolicy")
        if resume is not None:
            if not isinstance(resume, Mapping):
                out.error("ENTRYPOINT_RESUME_POLICY_INVALID", f"{path}.resumePolicy", "resumePolicy must be an object")
            else:
                flag = resume.get("reExecutionRequiresNewGeneration")
                if not isinstance(flag, bool):
                    out.error(
                        "ENTRYPOINT_RESUME_POLICY_INVALID",
                        f"{path}.resumePolicy.reExecutionRequiresNewGeneration",
                        "reExecutionRequiresNewGeneration must be an explicit boolean",
                    )
                kinds = resume.get("allowedCheckpointKinds")
                if kinds is not None and (not isinstance(kinds, list) or not _string_list(kinds)):
                    out.error(
                        "ENTRYPOINT_RESUME_POLICY_INVALID",
                        f"{path}.resumePolicy.allowedCheckpointKinds",
                        "allowedCheckpointKinds must be a non-empty list of checkpoint kinds",
                    )
        _validate_side_entry(path, key, entry, nodes, edges, out)


def _validate_side_entry(
    path: str,
    key: str,
    entry: Mapping[str, Any],
    nodes: Mapping[str, Any],
    edges: Sequence[tuple[str, str, str | None]],
    out: _Collector,
) -> None:
    """A side entry may not skip a gate silently.

    When a start node sits strictly downstream of a gate, the entry has to prove the gate
    outcome with a required fact that the gate itself produces. Without that binding a
    caller could enter after the gate and inherit a PASS nobody earned (REQ-ENTRY-02).

    A gate that the start node can also *reach* is feedback, not a skip: that is the
    declared rework loop, and the gate does run before the entry's work does.
    """
    starts = [nid for nid in _string_list(entry.get("startNodes")) if nid in nodes]
    if not starts:
        return
    ancestors = _ancestors(nodes, edges)
    required = set(_string_list(entry.get("requiresFacts")))
    for start in starts:
        for ancestor in sorted(ancestors.get(start, set())):
            gate = nodes.get(ancestor)
            if not isinstance(gate, Mapping) or gate.get("kind") != NodeKind.GATE.value:
                continue
            if start in ancestors.get(ancestor, set()):
                continue
            vouched = set(_string_list(gate.get("produces")))
            if not (vouched & required):
                out.error(
                    "SIDEB_ENTRY_GATE_BYPASS",
                    f"{path}.requiresFacts",
                    (
                        f"entrypoint '{key}' starts at '{start}', downstream of gate '{ancestor}', but "
                        f"requires no fact the gate produces {sorted(vouched)}"
                    ),
                )


def _validate_subgraphs(
    definition: Mapping[str, Any],
    nodes: Mapping[str, Any],
    known_graphs: Mapping[str, Mapping[str, Any]],
    out: _Collector,
) -> None:
    graph_id = definition.get("graphId")
    for nid in sorted(nodes):
        node = nodes[nid]
        if not isinstance(node, Mapping):
            continue
        subgraph = node.get("subgraph")
        if subgraph is None:
            continue
        path = f"$.nodes.{nid}.subgraph"
        if not isinstance(subgraph, Mapping):
            out.error("SUBGRAPH_REFERENCE_UNRESOLVED", path, "subgraph must be an object with graphId and entrypoint")
            continue
        child_id = subgraph.get("graphId")
        entrypoint = subgraph.get("entrypoint")
        if not isinstance(child_id, str) or not child_id:
            out.error("SUBGRAPH_REFERENCE_UNRESOLVED", f"{path}.graphId", "subgraph.graphId must name a graph")
            continue
        if not isinstance(entrypoint, str) or not entrypoint:
            out.error("SUBGRAPH_ENTRYPOINT_UNKNOWN", f"{path}.entrypoint", "subgraph.entrypoint must name an entrypoint of the child graph")
            continue
        if child_id == graph_id:
            out.error(
                "SUBGRAPH_RECURSION",
                f"{path}.graphId",
                "a graph may not invoke itself; child creation would never terminate",
            )
            continue
        child = known_graphs.get(child_id)
        if child is None:
            out.error(
                "SUBGRAPH_REFERENCE_UNRESOLVED",
                f"{path}.graphId",
                f"subgraph '{child_id}' is not known to the registry, so its contract cannot be checked",
            )
            continue
        child_entrypoints = child.get("entrypoints")
        if not isinstance(child_entrypoints, Mapping) or entrypoint not in child_entrypoints:
            out.error(
                "SUBGRAPH_ENTRYPOINT_UNKNOWN",
                f"{path}.entrypoint",
                f"child graph '{child_id}' has no entrypoint '{entrypoint}'",
            )
        else:
            # The child's input contract is a promise the parent has to keep, so it is
            # checked here rather than discovered at dispatch time.
            child_entry = child_entrypoints[entrypoint]
            supplied = {str(value) for value in (node.get("inputs") or {}).values()}
            for index, fact in enumerate(
                _string_list(child_entry.get("inputs")) if isinstance(child_entry, Mapping) else []
            ):
                if fact not in supplied:
                    out.error(
                        "SUBGRAPH_INPUT_UNSATISFIED",
                        f"{path}.entrypoint",
                        (
                            f"child entrypoint '{child_id}.{entrypoint}' requires input '{fact}', which "
                            f"node '{nid}' does not bind"
                        ),
                    )
        if _attempt_count(node) is None:
            out.error(
                "SUBGRAPH_BUDGET_UNDECLARED",
                f"$.nodes.{nid}.retryBudget",
                (
                    f"subgraph node '{nid}' declares no retryBudget, so its invocation generation count is "
                    "unbounded; a child run must be capped (REQ-ENTRY-06)"
                ),
            )

    _validate_subgraph_depth(definition, known_graphs, out)


def _validate_subgraph_depth(
    definition: Mapping[str, Any], known_graphs: Mapping[str, Mapping[str, Any]], out: _Collector
) -> None:
    graph_id = str(definition.get("graphId") or "")
    if graph_id not in known_graphs:
        known_graphs = {**known_graphs, graph_id: definition}

    def children(node: Mapping[str, Any]) -> list[str]:
        result: list[str] = []
        if isinstance(node, Mapping):
            subgraph = node.get("subgraph")
            if isinstance(subgraph, Mapping) and isinstance(subgraph.get("graphId"), str):
                result.append(subgraph["graphId"])
        return result

    def walk(current: str, path: str, depth: int, chain: tuple[str, ...]) -> None:
        if depth > MAX_SUBGRAPH_DEPTH:
            out.error(
                "SUBGRAPH_DEPTH_EXCEEDED",
                path,
                f"child graph nesting exceeds the depth ceiling {MAX_SUBGRAPH_DEPTH}: {' -> '.join(chain)}",
            )
            return
        target = known_graphs.get(current)
        if target is None:
            return
        node_map = target.get("nodes")
        if not isinstance(node_map, Mapping):
            return
        for node_id in sorted(node_map):
            for child_id in children(node_map[node_id]):
                if child_id in chain or child_id == current:
                    out.error(
                        "SUBGRAPH_RECURSION",
                        f"$.nodes.{node_id}.subgraph.graphId",
                        f"child graph cycle {' -> '.join((*chain, child_id))} would create children without bound",
                    )
                    continue
                walk(child_id, f"$.nodes.{node_id}.subgraph.graphId", depth + 1, (*chain, child_id))

    walk(graph_id, "$.nodes", 1, (graph_id,))


def _validate_join_inputs_against_edges(
    definition: Mapping[str, Any], nodes: Mapping[str, Any], edges: Sequence[tuple[str, str, str | None]], out: _Collector
) -> None:
    actual: dict[str, set[str]] = {nid: set() for nid in nodes}
    for src, dst, _ in edges:
        actual.setdefault(dst, set()).add(src)
    for nid in sorted(nodes):
        node = nodes[nid]
        if not isinstance(node, Mapping):
            continue
        join = node.get("join")
        if not isinstance(join, Mapping):
            continue
        declared = _string_list(join.get("inputs"))
        if not declared:
            continue
        wired = actual.get(nid, set())
        missing = sorted(wired - set(declared))
        extra = sorted(set(declared) - wired)
        if missing:
            out.error(
                "JOIN_INPUTS_MISMATCH",
                f"$.nodes.{nid}.join.inputs",
                f"join does not declare incoming node(s) {missing}; a join that ignores an edge is a gate bypass",
            )
        if extra:
            out.error(
                "JOIN_INPUTS_MISMATCH",
                f"$.nodes.{nid}.join.inputs",
                f"join declares input(s) {extra} that have no edge into '{nid}'",
            )


def validate_definition(
    definition: Any,
    *,
    policy_catalog: Mapping[str, Mapping[str, Any]] | None = None,
    known_graphs: Mapping[str, Mapping[str, Any]] | None = None,
) -> ValidationReport:
    """Validate ``definition`` and return every issue found.

    ``policy_catalog`` replaces the shipped baseline specs (keyed by ref). ``known_graphs``
    supplies the child definitions a ``subgraph`` node may reference; when omitted the
    shipped graph library is used, so a library graph validates standalone.
    """
    out = _Collector()
    document = _validate_document(definition, out)
    # The digest is computed from whatever we were given, so a caller can match a report
    # against a draft even when the definition is too broken to validate further.
    subject = definition if isinstance(definition, Mapping) else {}
    digest = definition_hash(document or subject)

    if not document:
        return ValidationReport(ok=False, issues=out.sorted(), definition_hash=digest)

    nodes = document.get("nodes")
    entrypoints = document.get("entrypoints")
    if not isinstance(nodes, Mapping) or not isinstance(entrypoints, Mapping):
        return ValidationReport(ok=False, issues=out.sorted(), definition_hash=digest)

    resolved_graphs = dict(known_graphs) if known_graphs is not None else dict(_library_graphs())

    _validate_node_identities(nodes, out)
    producers = _validate_node_shape(nodes, out)
    edges = _validate_edges(document, nodes, out)
    ancestors = _validate_reachability(document, nodes, edges, out)
    _validate_fact_flow(document, nodes, edges, ancestors, producers, out)
    _validate_permission_gates(document, nodes, edges, out)
    _validate_mandatory_gates(document, nodes, edges, out)
    _validate_join_inputs_against_edges(document, nodes, edges, out)
    _validate_subgraphs(document, nodes, resolved_graphs, out)
    _validate_entrypoints(document, nodes, edges, out)

    for violation in check_definition_policy(document, catalog=policy_catalog):
        out.add(
            ValidationIssue(violation.severity, violation.code, violation.path, violation.message)
        )

    issues = out.sorted()
    return ValidationReport(
        ok=not any(issue.severity == _ERROR for issue in issues),
        issues=issues,
        definition_hash=digest,
    )
