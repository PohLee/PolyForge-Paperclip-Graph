"""Deterministic readiness planning.

Responsibility: turn a compiled plan plus the current run state into a decision for every
node — which nodes may be worked now, which are still waiting, which are provably out of
this branch, and which are blocked with an explainable reason.

Invariants (``docs/01-REQUIREMENTS.md`` REQ-WORK-05, ``docs/02-TECHNICAL-PLAN.md``
section 7):

* Only ``READY`` means executable. A node that merely has satisfied predecessors is still
  ``PENDING`` until its declared inputs, required facts, and guard all hold.
* ``READY`` is a statement about *engineering* admissibility only. It authorises the Core to
  emit a work intent; it never authorises a worker, and the platform's own checkout, budget,
  and capability checks still apply before anything runs.
* The planner is pure. Same plan + same state ⇒ byte-identical output. It reads no clock, no
  random source, and no external service, so a replayed command re-derives the same
  readiness instead of inventing new work.
* Join semantics release only legal successors: ``all`` needs every upstream, ``any`` needs
  one, ``quorum`` needs its count — and a failed upstream never satisfies a join.
* ``skipped`` propagates: a successor of a node that is not on any live path is itself not
  on a live path, under ``all`` join.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping

from polyforge import COMPILER_VERSION
from polyforge.core import errors, hashing
from polyforge.core.state import BlockReason, JoinSemantics, NodeKind, NodeStatus

__all__ = [
    "PLAN_HASH_DOMAIN",
    "ExecutionPlan",
    "NodeDecision",
    "PlanNode",
    "build_plan",
    "evaluate_guard",
    "plan_states",
]

PLAN_HASH_DOMAIN = "pf.plan"

#: How the engine names "the run's own inputs" in a node's ``inputs`` map. A graph author
#: writes ``inputs: {candidate_artifacts: run_inputs}`` rather than a magic node id.
RUN_INPUTS = "run_inputs"
ENTRYPOINT = "entrypoint"


@dataclass(frozen=True)
class PlanNode:
    node_id: str
    kind: str
    operation: dict[str, Any] = field(default_factory=dict)
    produces: tuple[str, ...] = ()
    requires: tuple[str, ...] = ()
    inputs: Mapping[str, str] = field(default_factory=dict)
    join_semantics: str = str(JoinSemantics.ALL)
    join_quorum: int = 0
    join_inputs: tuple[str, ...] = ()
    guard: Mapping[str, Any] | str | None = None
    required_capabilities: tuple[str, ...] = ()
    independent_from: tuple[str, ...] = ()
    preferred_roles: tuple[str, ...] = ()
    fallback_roles: tuple[str, ...] = ()
    evaluator_refs: tuple[str, ...] = ()
    human_decision: Mapping[str, Any] | None = None
    subgraph: Mapping[str, Any] | None = None
    permission_gate: Mapping[str, Any] | None = None
    workspace_requirement: Mapping[str, Any] | None = None
    retry_budget: Mapping[str, Any] | None = None
    max_rework: int = 3
    produces_facts: tuple[str, ...] = ()
    exports: tuple[str, ...] = ()

    @property
    def is_gate(self) -> bool:
        return self.kind == str(NodeKind.GATE)

    @property
    def is_subgraph(self) -> bool:
        return self.kind == str(NodeKind.SUBGRAPH)

    def input_producers(self) -> dict[str, str]:
        return dict(self.inputs)

    def to_canonical(self) -> dict[str, Any]:
        return {
            "id": self.node_id,
            "kind": self.kind,
            "operation": dict(self.operation) if self.operation else None,
            "produces": list(self.produces),
            "requires": list(self.requires),
            "inputs": {str(k): str(v) for k, v in sorted(self.inputs.items())},
            "join": {
                "semantics": self.join_semantics,
                "quorum": self.join_quorum,
                "inputs": list(self.join_inputs),
            },
            "guard": self.guard,
            "executor": {
                "requiredCapabilities": list(self.required_capabilities),
                "independentFrom": list(self.independent_from),
                "preferredRoles": list(self.preferred_roles),
                "fallbackRoles": list(self.fallback_roles),
            },
            "evaluatorRefs": list(self.evaluator_refs),
            "humanDecision": dict(self.human_decision) if self.human_decision else None,
            "subgraph": dict(self.subgraph) if self.subgraph else None,
            "permissionGate": dict(self.permission_gate) if self.permission_gate else None,
            "workspaceRequirement": (
                dict(self.workspace_requirement) if self.workspace_requirement else None
            ),
            "retryBudget": dict(self.retry_budget) if self.retry_budget else None,
            "maxRework": self.max_rework,
        }


@dataclass(frozen=True)
class ExecutionPlan:
    graph_id: str
    entrypoint: str
    nodes: Mapping[str, PlanNode]
    edges: tuple[Mapping[str, Any], ...] = ()
    start_nodes: tuple[str, ...] = ()
    export_kinds: tuple[str, ...] = ()
    input_kinds: tuple[str, ...] = ()
    required_facts: tuple[str, ...] = ()
    policy_refs: tuple[str, ...] = ()
    graph_version: int = 0
    plan_hash: str = ""
    definition_hash: str = ""
    dependency_lock_hash: str = ""
    compiler_version: str = COMPILER_VERSION
    closure: Mapping[str, str] = field(default_factory=dict)

    def node(self, node_id: str) -> PlanNode:
        try:
            return self.nodes[str(node_id)]
        except KeyError as exc:
            raise errors.not_found(f"node {node_id!r} is not part of graph {self.graph_id!r}") from exc

    def has_node(self, node_id: str) -> bool:
        return str(node_id) in self.nodes

    @staticmethod
    def _is_feedback_edge(edge: Mapping[str, Any]) -> bool:
        """A rework edge is a transition trigger, not an initial dependency."""
        guard = edge.get("guard")
        if isinstance(guard, str):
            return guard == "rework"
        return isinstance(guard, Mapping) and (
            guard.get("transition") == "rework" or guard.get("event") == "rework"
        )

    def predecessors(self, node_id: str, *, include_feedback: bool = False) -> tuple[str, ...]:
        return tuple(
            sorted(
                {
                    str(e["from"])
                    for e in self.edges
                    if str(e.get("to")) == str(node_id)
                    and (include_feedback or not self._is_feedback_edge(e))
                }
            )
        )

    def successors(self, node_id: str, *, include_feedback: bool = False) -> tuple[str, ...]:
        return tuple(
            sorted(
                {
                    str(e["to"])
                    for e in self.edges
                    if str(e.get("from")) == str(node_id)
                    and (include_feedback or not self._is_feedback_edge(e))
                }
            )
        )

    def ancestors(self, node_id: str) -> tuple[str, ...]:
        """All normal-dependency ancestors, excluding feedback-only rework edges."""
        found: set[str] = set()
        pending = list(self.predecessors(node_id))
        while pending:
            predecessor = pending.pop()
            if predecessor in found:
                continue
            found.add(predecessor)
            pending.extend(self.predecessors(predecessor))
        return tuple(sorted(found))

    def ordered_node_ids(self) -> tuple[str, ...]:
        """Sorted node ids: a stable iteration order is what makes planning reproducible."""
        return tuple(sorted(self.nodes))

    def to_canonical(self) -> dict[str, Any]:
        return {
            "graphId": self.graph_id,
            "entrypoint": self.entrypoint,
            "compilerVersion": self.compiler_version,
            "dependencyLockHash": self.dependency_lock_hash,
            "nodes": [self.nodes[n].to_canonical() for n in self.ordered_node_ids()],
            "edges": [
                {"from": str(e.get("from", "")), "to": str(e.get("to", "")), "guard": e.get("guard")}
                for e in sorted(
                    self.edges, key=lambda e: (str(e.get("from", "")), str(e.get("to", "")))
                )
            ],
            "entrypointSpec": {
                "key": self.entrypoint,
                "startNodes": list(self.start_nodes),
                "exports": list(self.export_kinds),
                "inputs": list(self.input_kinds),
                "requiresFacts": list(self.required_facts),
            },
            "policyRefs": list(self.policy_refs),
        }

    def to_wire(self) -> dict[str, Any]:
        wire = self.to_canonical()
        wire["planHash"] = self.plan_hash or compute_plan_hash(self)
        wire["graphVersion"] = self.graph_version
        wire["definitionHash"] = self.definition_hash
        wire["closure"] = dict(self.closure)
        return wire

    @staticmethod
    def from_wire(value: Mapping[str, Any]) -> "ExecutionPlan":
        nodes: dict[str, PlanNode] = {}
        for raw in value.get("nodes") or ():
            node = _plan_node_from_wire(raw)
            nodes[node.node_id] = node
        spec = value.get("entrypointSpec") or {}
        return ExecutionPlan(
            graph_id=str(value.get("graphId", "")),
            entrypoint=str(value.get("entrypoint") or spec.get("key", "")),
            nodes=nodes,
            edges=tuple(dict(e) for e in (value.get("edges") or ())),
            start_nodes=tuple(str(n) for n in (spec.get("startNodes") or ())),
            export_kinds=tuple(str(n) for n in (spec.get("exports") or ())),
            input_kinds=tuple(str(n) for n in (spec.get("inputs") or ())),
            required_facts=tuple(str(n) for n in (spec.get("requiresFacts") or ())),
            policy_refs=tuple(str(n) for n in (value.get("policyRefs") or ())),
            graph_version=int(value.get("graphVersion", 0)),
            plan_hash=str(value.get("planHash", "")),
            definition_hash=str(value.get("definitionHash", "")),
            dependency_lock_hash=str(value.get("dependencyLockHash", "")),
            compiler_version=str(value.get("compilerVersion", COMPILER_VERSION)),
            closure=dict(value.get("closure") or {}),
        )


@dataclass(frozen=True)
class NodeDecision:
    """What the planner concluded about one node, and why."""

    node_id: str
    status: str
    reason: str
    block_reason: str | None = None
    satisfied_inputs: tuple[str, ...] = ()
    missing_inputs: tuple[str, ...] = ()
    missing_facts: tuple[str, ...] = ()

    @property
    def ready(self) -> bool:
        return self.status == NodeStatus.READY

    def to_wire(self) -> dict[str, Any]:
        return {
            "nodeId": self.node_id,
            "status": self.status,
            "reason": self.reason,
            "blockReason": self.block_reason,
            "satisfiedInputs": list(self.satisfied_inputs),
            "missingInputs": list(self.missing_inputs),
            "missingFacts": list(self.missing_facts),
        }


def compute_plan_hash(plan: ExecutionPlan) -> str:
    """Hash the plan's canonical structure.

    ``graphVersion`` is deliberately excluded: compiling the same definition with the same
    compiler and dependency lock must produce the same hash (REQ-GRAPH-05), and the version
    number is a publication fact rather than part of the execution structure.
    """
    return hashing.hash_domain(PLAN_HASH_DOMAIN, hashing.strip_for_hash(plan.to_canonical()))


def _plan_node_from_wire(raw: Mapping[str, Any]) -> PlanNode:
    executor = raw.get("executor") or {}
    join = raw.get("join") or {}
    retry = raw.get("retryBudget") or {}
    return PlanNode(
        node_id=str(raw.get("id", "")),
        kind=str(raw.get("kind", NodeKind.AGENT_OPERATION)),
        operation=dict(raw.get("operation") or {}),
        produces=tuple(str(p) for p in (raw.get("produces") or ())),
        requires=tuple(str(f) for f in (raw.get("requires") or ())),
        inputs={str(k): str(v) for k, v in (raw.get("inputs") or {}).items()},
        join_semantics=str(join.get("semantics", JoinSemantics.ALL)),
        join_quorum=int(join.get("quorum", 0) or 0),
        join_inputs=tuple(str(i) for i in (join.get("inputs") or ())),
        guard=raw.get("guard"),
        required_capabilities=tuple(str(c) for c in (executor.get("requiredCapabilities") or ())),
        independent_from=tuple(str(c) for c in (executor.get("independentFrom") or ())),
        preferred_roles=tuple(str(c) for c in (executor.get("preferredRoles") or ())),
        fallback_roles=tuple(str(c) for c in (executor.get("fallbackRoles") or ())),
        evaluator_refs=tuple(str(e) for e in (raw.get("evaluatorRefs") or ())),
        human_decision=dict(raw["humanDecision"]) if raw.get("humanDecision") else None,
        subgraph=dict(raw["subgraph"]) if raw.get("subgraph") else None,
        permission_gate=dict(raw["permissionGate"]) if raw.get("permissionGate") else None,
        workspace_requirement=(
            dict(raw["workspaceRequirement"]) if raw.get("workspaceRequirement") else None
        ),
        retry_budget=dict(retry) if retry else None,
        max_rework=int(retry.get("maxAttempts", 3)) if retry else 3,
    )


def build_plan(
    definition: Mapping[str, Any],
    *,
    graph_version: int = 0,
    entrypoint: str | None = None,
    artifact: Mapping[str, Any] | None = None,
) -> ExecutionPlan:
    """Normalize a graph definition into an :class:`ExecutionPlan`.

    ``artifact`` is a compile artifact when one exists; the plan hash and the pinned version
    closure are taken from it so a run records exactly what the compiler produced. Without
    one the plan hash is computed here, deterministically, from the same canonical shape.
    """
    if not isinstance(definition, Mapping):
        raise errors.contract_invalid("a graph definition must be an object")
    graph_id = str(definition.get("graphId", ""))
    if not graph_id:
        raise errors.contract_invalid("a graph definition must declare graphId")

    entrypoints = definition.get("entrypoints") or {}
    key = entrypoint or (sorted(entrypoints)[0] if entrypoints else "")
    spec = entrypoints.get(key) or {}
    if entrypoints and key not in entrypoints:
        raise errors.contract_invalid(
            f"entrypoint {key!r} is not declared by graph {graph_id!r}",
            details={"available": sorted(entrypoints)},
        )

    nodes: dict[str, PlanNode] = {}
    for node_id, raw in (definition.get("nodes") or {}).items():
        payload = dict(raw)
        payload.setdefault("id", node_id)
        node = _plan_node_from_wire(payload)
        if not node.node_id:
            raise errors.contract_invalid(f"node {node_id!r} has no id")
        nodes[node.node_id] = node

    edges = tuple(
        {"from": str(e.get("from", "")), "to": str(e.get("to", "")), "guard": e.get("guard")}
        for e in (definition.get("edges") or ())
    )
    for edge in edges:
        if edge["from"] not in nodes or edge["to"] not in nodes:
            raise errors.contract_invalid(
                f"edge {edge['from']!r} -> {edge['to']!r} references a node the graph does not declare"
            )

    dependency_lock_hash = ""
    plan_hash = ""
    closure: dict[str, str] = {}
    compiler_version = COMPILER_VERSION
    definition_hash = ""
    if artifact:
        plan_hash = str(artifact.get("planHash", ""))
        dependency_lock_hash = str(artifact.get("dependencyLockHash", ""))
        closure = {str(k): str(v) for k, v in (artifact.get("closure") or {}).items()}
        compiler_version = str(artifact.get("compilerVersion", compiler_version))
        definition_hash = str(artifact.get("definitionHash", ""))

    plan = ExecutionPlan(
        graph_id=graph_id,
        entrypoint=key,
        nodes=nodes,
        edges=edges,
        start_nodes=tuple(str(n) for n in (spec.get("startNodes") or ())),
        export_kinds=tuple(str(n) for n in (spec.get("exports") or ())),
        input_kinds=tuple(str(n) for n in (spec.get("inputs") or ())),
        required_facts=tuple(str(f) for f in (spec.get("requiresFacts") or ())),
        policy_refs=tuple(str(p) for p in (definition.get("policyRefs") or ())),
        graph_version=graph_version,
        plan_hash=plan_hash,
        definition_hash=definition_hash,
        dependency_lock_hash=dependency_lock_hash,
        compiler_version=compiler_version,
        closure=closure,
    )
    if not plan.plan_hash:
        plan = ExecutionPlan(**{**_as_kwargs(plan), "plan_hash": compute_plan_hash(plan)})
    return plan


def _as_kwargs(plan: ExecutionPlan) -> dict[str, Any]:
    return {
        "graph_id": plan.graph_id,
        "entrypoint": plan.entrypoint,
        "nodes": plan.nodes,
        "edges": plan.edges,
        "start_nodes": plan.start_nodes,
        "export_kinds": plan.export_kinds,
        "input_kinds": plan.input_kinds,
        "required_facts": plan.required_facts,
        "policy_refs": plan.policy_refs,
        "graph_version": plan.graph_version,
        "plan_hash": plan.plan_hash,
        "definition_hash": plan.definition_hash,
        "dependency_lock_hash": plan.dependency_lock_hash,
        "compiler_version": plan.compiler_version,
        "closure": plan.closure,
    }


def evaluate_guard(
    guard: Mapping[str, Any] | str | None, facts: Mapping[str, Any]
) -> tuple[str, str]:
    """Return ``("holds" | "fails" | "unknown", reason)`` for a node guard.

    ``unknown`` is deliberately distinct from ``fails``: a guard over a fact that has not
    been produced yet means "not decided", and treating that as "false" would silently drop
    a branch.
    """
    if guard is None:
        return "holds", "no guard"
    if isinstance(guard, str):
        if guard in facts:
            return "holds", f"fact {guard!r} is present"
        return "unknown", f"guard fact {guard!r} has not been produced"
    fact = guard.get("fact")
    if not fact:
        return "holds", "guard names no fact"
    if fact not in facts:
        return "unknown", f"guard fact {fact!r} has not been produced"
    value = facts[fact]
    if "equals" in guard:
        if value == guard["equals"]:
            return "holds", f"fact {fact!r} equals {guard['equals']!r}"
        return "fails", f"fact {fact!r} is {value!r}, not {guard['equals']!r}"
    if "notEquals" in guard:
        if value != guard["notEquals"]:
            return "holds", f"fact {fact!r} differs from {guard['notEquals']!r}"
        return "fails", f"fact {fact!r} equals {guard['notEquals']!r}"
    if "present" in guard:
        if bool(guard["present"]) == (value is not None):
            return "holds", f"fact {fact!r} presence is {value is not None}"
        return "fails", f"fact {fact!r} presence does not match"
    return "holds", f"fact {fact!r} is present"


def plan_states(
    plan: ExecutionPlan,
    *,
    node_states: Mapping[str, Mapping[str, Any]],
    available_facts: Mapping[str, Any] | None = None,
    available_exports: Mapping[str, str] | None = None,
    child_runs: Mapping[str, Mapping[str, Any]] | None = None,
) -> dict[str, NodeDecision]:
    """Decide every node's status from the plan and the current state.

    ``node_states`` maps node id to the persisted execution row (only ``status``,
    ``rework_count`` and ``child_run_id`` are read). ``available_exports`` maps an exported
    kind to the digest of what delivered it. Nodes that are already in flight are echoed
    unchanged: readiness is not a state machine, and the engine owns transitions.
    """
    facts: dict[str, Any] = dict(available_facts or {})
    exports: dict[str, str] = dict(available_exports or {})
    children: dict[str, Mapping[str, Any]] = dict(child_runs or {})
    decisions: dict[str, NodeDecision] = {}

    for node_id in plan.ordered_node_ids():
        node = plan.nodes[node_id]
        state = node_states.get(node_id) or {}
        current = str(state.get("status", NodeStatus.PENDING))
        rework = int(state.get("rework_count", 0) or 0)

        if current not in (NodeStatus.PENDING, NodeStatus.REWORK_REQUIRED, NodeStatus.BLOCKED):
            decisions[node_id] = NodeDecision(
                node_id=node_id,
                status=current,
                reason=f"node is already {current}; planning does not disturb an in-flight state",
            )
            continue

        predecessors = plan.predecessors(node_id)
        join_set = predecessors
        if node.join_inputs:
            allowed = set(node.join_inputs)
            join_set = tuple(
                p
                for p in predecessors
                if p in allowed
                or any(node.inputs.get(name) == p for name in allowed if name in node.inputs)
            ) or predecessors

        upstream = {p: str((node_states.get(p) or {}).get("status", NodeStatus.PENDING)) for p in join_set}
        passed = sorted(p for p, s in upstream.items() if s == NodeStatus.PASSED)
        failed = sorted(p for p, s in upstream.items() if s in (NodeStatus.FAILED, NodeStatus.BLOCKED))
        skipped = sorted(p for p, s in upstream.items() if s == NodeStatus.SKIPPED)

        semantics = node.join_semantics
        if predecessors:
            if failed:
                decisions[node_id] = NodeDecision(
                    node_id=node_id,
                    status=NodeStatus.BLOCKED,
                    reason=f"upstream node(s) {', '.join(failed)} did not pass; a failed predecessor is never a satisfied join",
                    block_reason=str(BlockReason.DEPENDENCY),
                )
                continue
            if semantics == str(JoinSemantics.ALL):
                satisfied_join = len(passed) == len(join_set)
            elif semantics == str(JoinSemantics.ANY):
                satisfied_join = bool(passed)
            else:  # quorum
                satisfied_join = len(passed) >= max(1, node.join_quorum)
            if not satisfied_join:
                if skipped and not passed and semantics == str(JoinSemantics.ALL):
                    decisions[node_id] = NodeDecision(
                        node_id=node_id,
                        status=NodeStatus.SKIPPED,
                        reason=f"every upstream contributor was skipped: {', '.join(skipped)}",
                    )
                    continue
                decisions[node_id] = NodeDecision(
                    node_id=node_id,
                    status=NodeStatus.PENDING,
                    reason=(
                        f"join {semantics} is not satisfied: {len(passed)}/{len(join_set)} "
                        f"upstream passed"
                    ),
                    satisfied_inputs=tuple(passed),
                )
                continue

        satisfied: list[str] = []
        missing: list[str] = []
        for input_name, fact_name in sorted(node.inputs.items()):
            # ``inputs`` maps a slot to the fact it consumes. The slot is satisfied when the
            # fact has been delivered under either name, which is the same statement in the
            # two shapes a definition may use.
            if (
                input_name in exports
                or input_name in facts
                or fact_name in exports
                or fact_name in facts
            ):
                satisfied.append(input_name)
            else:
                missing.append(input_name)
        if missing:
            decisions[node_id] = NodeDecision(
                node_id=node_id,
                status=NodeStatus.PENDING,
                reason=(
                    "declared input(s) not yet available: "
                    + ", ".join(missing)
                    + "; a node is only ready when every declared input exists"
                ),
                satisfied_inputs=tuple(satisfied),
                missing_inputs=tuple(missing),
            )
            continue

        missing_facts = tuple(f for f in node.requires if f not in facts)
        if missing_facts:
            decisions[node_id] = NodeDecision(
                node_id=node_id,
                status=NodeStatus.PENDING,
                reason="required fact(s) not satisfied: " + ", ".join(missing_facts),
                satisfied_inputs=tuple(satisfied),
                missing_facts=missing_facts,
            )
            continue

        guard_state, guard_reason = evaluate_guard(node.guard, facts)
        if guard_state == "fails":
            decisions[node_id] = NodeDecision(
                node_id=node_id,
                status=NodeStatus.SKIPPED,
                reason=f"guard selects this branch out: {guard_reason}",
                satisfied_inputs=tuple(satisfied),
            )
            continue
        if guard_state == "unknown":
            decisions[node_id] = NodeDecision(
                node_id=node_id,
                status=NodeStatus.PENDING,
                reason=f"guard is undecided: {guard_reason}",
                satisfied_inputs=tuple(satisfied),
            )
            continue

        if node.is_subgraph:
            child_id = str(state.get("child_run_id") or "")
            child = children.get(child_id) if child_id else None
            if child is None:
                decisions[node_id] = NodeDecision(
                    node_id=node_id,
                    status=NodeStatus.PENDING,
                    reason="child subgraph run has not been created for this invocation",
                    satisfied_inputs=tuple(satisfied),
                )
                continue
            child_status = str(child.get("status", ""))
            if child_status == "COMPLETED":
                child_exports = {str(e) for e in (child.get("exports") or ())}
                # A completed child is not enough: the parent needs the typed exports the child
                # actually verified, checked against what the parent declared it consumes
                # (REQ-ENTRY-06).
                missing_exports = [
                    produced
                    for produced in node.produces
                    if produced not in child_exports
                ] or ([e for e in sorted(child_exports) if e not in exports] if not node.produces else [])
                if missing_exports:
                    decisions[node_id] = NodeDecision(
                        node_id=node_id,
                        status=NodeStatus.PENDING,
                        reason=(
                            "child run completed but its verified export(s) are not available: "
                            + ", ".join(sorted(missing_exports))
                        ),
                        satisfied_inputs=tuple(satisfied),
                    )
                    continue
            elif child_status in ("FAILED", "CANCELLED"):
                decisions[node_id] = NodeDecision(
                    node_id=node_id,
                    status=NodeStatus.BLOCKED,
                    reason=f"child run {child_id} ended {child_status}; a parent never passes on a worker exit alone",
                    block_reason=str(BlockReason.DEPENDENCY),
                    satisfied_inputs=tuple(satisfied),
                )
                continue
            else:
                decisions[node_id] = NodeDecision(
                    node_id=node_id,
                    status=NodeStatus.PENDING,
                    reason=f"child run {child_id} is {child_status or 'not started'}",
                    satisfied_inputs=tuple(satisfied),
                )
                continue

        if rework >= node.max_rework:
            decisions[node_id] = NodeDecision(
                node_id=node_id,
                status=NodeStatus.BLOCKED,
                reason=(
                    f"engineering rework ceiling reached ({rework}/{node.max_rework}); a retry "
                    "budget is a stop, not a suggestion"
                ),
                block_reason=str(BlockReason.BUDGET),
                satisfied_inputs=tuple(satisfied),
            )
            continue

        decisions[node_id] = NodeDecision(
            node_id=node_id,
            status=NodeStatus.READY,
            reason=(
                "all declared inputs exist, required facts hold, and the guard is satisfied"
                if node.inputs or node.requires or node.guard is not None
                else "start node of the entrypoint with no unmet precondition"
            ),
            satisfied_inputs=tuple(satisfied),
        )
    return decisions
