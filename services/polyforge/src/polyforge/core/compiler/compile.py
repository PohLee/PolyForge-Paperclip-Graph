"""Deterministic compilation of a validated ``GraphDefinition`` into an execution plan.

Responsibility: turn one canonical definition plus one dependency lock into the plan and
the pinned version closure a ``GraphRun`` will execute against.

Invariants
----------
* **Determinism.** The same (definition, compiler version, dependency lock, policy inputs)
  produce byte-identical ``planHash`` and ``dependencyLockHash``. There is no wall-clock
  value, no random id, and no dependence on dict insertion order anywhere in the plan:
  the topological order breaks ties by node id, not by the order the editor happened to
  serialise the JSON in.
* **No drift.** The closure pins the schema version, the compiler version, every operation
  ``id@version``, every policy ref and version, every evaluator, every capability contract
  version and every child graph version. A run created from this artifact cannot drift
  when a default version, a skill, a policy or the registry changes (REQ-GRAPH-06).
* **Fail closed.** Anything the closure would have to guess is refused. An unpinned
  capability, operation, evaluator or child graph raises ``CONTRACT_INVALID`` instead of
  being defaulted, because a default version is a silent drift.
* ``planHash`` is ``hash_domain("pf.plan", ...)``; the plan carries no volatile field at
  all, so ``strip_for_hash`` is a belt-and-braces second pass rather than the mechanism.
"""

from __future__ import annotations

from typing import Any, Final, Mapping, Sequence

from polyforge import COMPILER_VERSION, SCHEMA_VERSION
from polyforge.core import hashing
from polyforge.core.compiler.policy_catalog import CEILINGS, catalog_versions
from polyforge.core.errors import ErrorCode, PolyForgeError
from polyforge.core.state import NodeKind

__all__ = [
    "CompileArtifact",
    "CHILD_INVOCATION_DOMAIN",
    "EFFECT_KEY_DOMAIN",
    "PLAN_DOMAIN",
    "DEPENDENCY_LOCK_DOMAIN",
    "compile_definition",
    "dependency_lock_for",
    "graph_loops",
    "required_pins",
    "step_id_for",
    "strongly_connected_components",
    "topological_order",
]

PLAN_DOMAIN: Final[str] = "pf.plan"
DEPENDENCY_LOCK_DOMAIN: Final[str] = "pf.deplock"
EFFECT_KEY_DOMAIN: Final[str] = "pf.effect-key"
CHILD_INVOCATION_DOMAIN: Final[str] = "pf.child-invocation"


class CompileArtifact:
    """Compiled plan plus the complete pin set for runs created from it.

    Mirrors ``CompileArtifact`` in ``packages/protocol/src/api.ts``. ``draft_id`` and
    ``revision`` are optional because the compiler also runs outside a draft (graph
    library self-check, migration dry run); the publish endpoint always fills them.
    """

    __slots__ = (
        "definition_hash",
        "compiler_version",
        "plan_hash",
        "dependency_lock_hash",
        "closure",
        "plan",
        "draft_id",
        "revision",
    )

    def __init__(
        self,
        definition_hash: str,
        compiler_version: str,
        plan_hash: str,
        dependency_lock_hash: str,
        closure: Mapping[str, str],
        plan: Mapping[str, Any],
        draft_id: str | None = None,
        revision: int | None = None,
    ) -> None:
        self.definition_hash = definition_hash
        self.compiler_version = compiler_version
        self.plan_hash = plan_hash
        self.dependency_lock_hash = dependency_lock_hash
        self.closure: dict[str, str] = dict(closure)
        self.plan: dict[str, Any] = dict(plan)
        self.draft_id = draft_id
        self.revision = revision

    def __eq__(self, other: object) -> bool:
        if not isinstance(other, CompileArtifact):
            return NotImplemented
        return (
            self.definition_hash == other.definition_hash
            and self.compiler_version == other.compiler_version
            and self.plan_hash == other.plan_hash
            and self.dependency_lock_hash == other.dependency_lock_hash
            and self.closure == other.closure
            and self.plan == other.plan
        )

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"CompileArtifact(plan_hash={self.plan_hash!r}, graph={self.plan.get('graphId')!r})"

    def to_dict(self) -> dict[str, Any]:
        body: dict[str, Any] = {
            "definitionHash": self.definition_hash,
            "compilerVersion": self.compiler_version,
            "planHash": self.plan_hash,
            "dependencyLockHash": self.dependency_lock_hash,
            "closure": dict(self.closure),
            "plan": dict(self.plan),
        }
        if self.draft_id is not None:
            body["draftId"] = self.draft_id
        if self.revision is not None:
            body["revision"] = self.revision
        return body

    @classmethod
    def from_dict(cls, body: Mapping[str, Any]) -> "CompileArtifact":
        return cls(
            definition_hash=str(body.get("definitionHash") or ""),
            compiler_version=str(body.get("compilerVersion") or ""),
            plan_hash=str(body.get("planHash") or ""),
            dependency_lock_hash=str(body.get("dependencyLockHash") or ""),
            closure=body.get("closure") or {},
            plan=body.get("plan") or {},
            draft_id=body.get("draftId"),
            revision=body.get("revision"),
        )


def step_id_for(graph_id: str, node_id: str) -> str:
    """Stable per-node step id, used as the external-effect identity component.

    It must not contain a run id, attempt number or timestamp: ``pf.effect-key`` combines
    this value with the transition hash so a retry of the *same* transition addresses the
    *same* provider object while a genuinely new effect gets a new transition.
    """
    return f"{graph_id}.{node_id}"


def _adjacency(nodes: Mapping[str, Any], edges: Sequence[tuple[str, str]]) -> dict[str, list[str]]:
    outgoing: dict[str, list[str]] = {nid: [] for nid in nodes}
    for src, dst in edges:
        if src not in nodes or dst not in nodes or src == dst:
            continue
        outgoing[src].append(dst)
    return {nid: sorted(targets) for nid, targets in outgoing.items()}


def strongly_connected_components(
    nodes: Mapping[str, Any], edges: Sequence[tuple[str, str]]
) -> list[list[str]]:
    """Tarjan's SCCs, iterative, with every list and every result order sorted by node id.

    A rework loop is a legal graph shape, so a cycle is not an error: it becomes one
    contiguous block in the plan order and is reported separately as a loop. Determinism
    comes from sorting the adjacency and from processing start nodes in sorted order.
    """
    outgoing = _adjacency(nodes, edges)
    index: dict[str, int] = {}
    low: dict[str, int] = {}
    on_stack: dict[str, bool] = {}
    stack: list[str] = []
    components: list[list[str]] = []
    counter = 0

    for root in sorted(nodes):
        if root in index:
            continue
        index[root] = low[root] = counter
        counter += 1
        stack.append(root)
        on_stack[root] = True
        work: list[tuple[str, Any]] = [(root, iter(outgoing[root]))]
        while work:
            node, children = work[-1]
            descended = False
            for child in children:
                if child not in index:
                    index[child] = low[child] = counter
                    counter += 1
                    stack.append(child)
                    on_stack[child] = True
                    work.append((child, iter(outgoing[child])))
                    descended = True
                    break
                if on_stack.get(child):
                    low[node] = min(low[node], index[child])
            if descended:
                continue
            work.pop()
            if work:
                parent = work[-1][0]
                low[parent] = min(low[parent], low[node])
            if low[node] == index[node]:
                component: list[str] = []
                while True:
                    member = stack.pop()
                    on_stack[member] = False
                    component.append(member)
                    if member == node:
                        break
                components.append(sorted(component))
    # Tarjan finishes components in reverse topological order; sorting by the lowest member
    # id makes the returned order a property of the graph content rather than of traversal
    # history, which is what the plan hash depends on.
    return sorted(components, key=lambda component: (component[0], len(component)))


def topological_order(nodes: Mapping[str, Any], edges: Sequence[tuple[str, str]]) -> list[str]:
    """Deterministic plan order: condensation order, ties broken by node id.

    The frontier is kept sorted rather than relying on dict or insertion order, which is
    the whole determinism defence for ``planHash``. Nodes inside a cycle are emitted as one
    contiguous sorted block because there is no valid order inside a cycle anyway.
    """
    components = strongly_connected_components(nodes, edges)
    member_of: dict[str, int] = {}
    for position, component in enumerate(components):
        for nid in component:
            member_of[nid] = position
    component_edges: dict[int, set[int]] = {position: set() for position in range(len(components))}
    indegree: dict[int, int] = {position: 0 for position in range(len(components))}
    for src, dst in edges:
        if src not in member_of or dst not in member_of:
            continue
        source, target = member_of[src], member_of[dst]
        if source == target or target in component_edges[source]:
            continue
        component_edges[source].add(target)
        indegree[target] += 1

    def sort_key(position: int) -> tuple[str, int]:
        return (components[position][0], position)

    ready = sorted((p for p, degree in indegree.items() if degree == 0), key=sort_key)
    order: list[str] = []
    while ready:
        current = ready.pop(0)
        order.extend(components[current])
        for target in sorted(component_edges[current], key=sort_key):
            indegree[target] -= 1
            if indegree[target] == 0:
                ready.append(target)
                ready.sort(key=sort_key)
    if len(order) != len(nodes):
        raise PolyForgeError(
            ErrorCode.CONTRACT_INVALID,
            "graph structure could not be ordered; an edge references a node that is not declared",
            details={"ordered": len(order), "declared": len(nodes)},
        )
    return order


def graph_loops(nodes: Mapping[str, Any], edges: Sequence[tuple[str, str]]) -> list[list[str]]:
    """Cycles of more than one node, in plan order. Each carries its own retry budget."""
    return [component for component in strongly_connected_components(nodes, edges) if len(component) > 1]


def required_pins(definition: Mapping[str, Any]) -> dict[str, set[str]]:
    """What a dependency lock has to pin for this definition, grouped by kind.

    Exposed so an API can tell an author exactly which versions are missing instead of
    failing the compile with a generic error.
    """
    pins: dict[str, set[str]] = {
        "capabilities": set(),
        "operations": set(),
        "evaluators": set(),
        "policies": set(),
        "graphs": set(),
    }
    nodes = definition.get("nodes")
    if isinstance(nodes, Mapping):
        for node in nodes.values():
            if not isinstance(node, Mapping):
                continue
            operation = node.get("operation")
            if isinstance(operation, Mapping) and isinstance(operation.get("id"), str):
                pins["operations"].add(operation["id"])
            executor = node.get("executor")
            if isinstance(executor, Mapping):
                for capability in executor.get("requiredCapabilities") or ():
                    if isinstance(capability, str) and capability:
                        pins["capabilities"].add(capability)
            for ref in node.get("evaluatorRefs") or ():
                if isinstance(ref, str) and ref:
                    pins["evaluators"].add(ref)
            subgraph = node.get("subgraph")
            if isinstance(subgraph, Mapping) and isinstance(subgraph.get("graphId"), str):
                pins["graphs"].add(subgraph["graphId"])
    for ref in definition.get("policyRefs") or ():
        if isinstance(ref, str) and ref:
            pins["policies"].add(ref)
    return pins


def _lock_section(lock: Mapping[str, Any], key: str) -> dict[str, Any]:
    section = lock.get(key)
    return dict(section) if isinstance(section, Mapping) else {}


def _resolve_pin(
    kind: str, name: str, section: Mapping[str, Any], *, path: str, baseline: str | None = None
) -> str:
    """Pin ``name`` to a version, refusing to guess."""
    explicit = name.partition("@")
    if explicit[2].isdigit():
        return explicit[2]
    value = section.get(name)
    if isinstance(value, bool) or value is None:
        if baseline is not None:
            return baseline
        raise PolyForgeError(
            ErrorCode.CONTRACT_INVALID,
            f"dependency lock does not pin {kind} '{name}'; a run must not drift on a default version",
            details={"kind": kind, "name": name, "path": path},
        )
    if isinstance(value, int) or isinstance(value, str):
        return str(value)
    raise PolyForgeError(
        ErrorCode.CONTRACT_INVALID,
        f"dependency lock pins {kind} '{name}' with an unusable version {value!r}",
        details={"kind": kind, "name": name, "path": path},
    )


def dependency_lock_for(
    definition: Mapping[str, Any],
    *,
    capability_versions: Mapping[str, Any],
    evaluator_versions: Mapping[str, Any] | None = None,
    policy_versions: Mapping[str, Any] | None = None,
    graph_versions: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Build a well-formed dependency lock for ``definition``.

    The compiler itself never defaults a version; this helper is the only place that
    knows the shipped version tables, which is why it lives beside them and is called by
    the graph library and by the test suite.
    """
    pins = required_pins(definition)
    lock: dict[str, Any] = {
        "schemaVersion": SCHEMA_VERSION,
        "compilerVersion": COMPILER_VERSION,
        "capabilities": {name: capability_versions[name] for name in sorted(pins["capabilities"]) if name in capability_versions},
        "operations": {},
        "evaluators": {name: (evaluator_versions or {}).get(name) for name in sorted(pins["evaluators"]) if name in (evaluator_versions or {})},
        "policies": {name: (policy_versions or catalog_versions()).get(name.split("@")[0]) for name in sorted(pins["policies"])},
        "graphs": {name: (graph_versions or {}).get(name) for name in sorted(pins["graphs"])},
    }
    nodes = definition.get("nodes")
    if isinstance(nodes, Mapping):
        for node in nodes.values():
            if isinstance(node, Mapping):
                operation = node.get("operation")
                if isinstance(operation, Mapping) and isinstance(operation.get("id"), str):
                    lock["operations"][operation["id"]] = int(operation.get("version") or 0)
    return lock


def _node_plan(
    graph_id: str,
    node_id: str,
    node: Mapping[str, Any],
    closure: dict[str, str],
    child_plans: dict[str, Any],
) -> dict[str, Any]:
    plan: dict[str, Any] = {
        "nodeId": node_id,
        "kind": node.get("kind"),
        "stepId": step_id_for(graph_id, node_id),
        "inputs": dict(node.get("inputs") or {}),
        "produces": sorted(str(item) for item in node.get("produces") or ()),
        "requires": sorted(str(item) for item in node.get("requires") or ()),
    }
    if node.get("operation") is not None:
        operation = node["operation"]
        plan["operation"] = {"id": operation.get("id"), "version": operation.get("version")}
        plan["operationPin"] = closure.get(f"operation.{operation.get('id')}")
    if node.get("outputs"):
        plan["outputs"] = sorted(str(item) for item in node["outputs"])
    executor = node.get("executor")
    if isinstance(executor, Mapping):
        capabilities = sorted(str(item) for item in executor.get("requiredCapabilities") or ())
        plan["executor"] = {
            "requiredCapabilities": capabilities,
            # The pins travel in the plan so a capability bump changes planHash: the
            # executor that a run may use is part of what the plan authorises.
            "capabilityPins": {name: closure.get(f"capability.{name}") for name in capabilities},
            "preferredRoles": sorted(str(item) for item in executor.get("preferredRoles") or ()),
            "fallbackRoles": sorted(str(item) for item in executor.get("fallbackRoles") or ()),
            "independentFrom": sorted(str(item) for item in executor.get("independentFrom") or ()),
        }
    join = node.get("join")
    if isinstance(join, Mapping):
        plan["join"] = {
            "semantics": join.get("semantics"),
            "quorum": join.get("quorum"),
            "inputs": sorted(str(item) for item in join.get("inputs") or ()),
        }
    if node.get("evaluatorRefs"):
        refs = sorted(str(item) for item in node["evaluatorRefs"])
        plan["evaluatorRefs"] = refs
        plan["evaluatorPins"] = {ref: closure.get(f"evaluator.{ref}") for ref in refs}
    decision = node.get("humanDecision")
    if isinstance(decision, Mapping):
        plan["humanDecision"] = {
            "required": bool(decision.get("required")),
            "semanticKind": decision.get("semanticKind"),
        }
    permission = node.get("permissionGate")
    if isinstance(permission, Mapping):
        plan["permissionGate"] = {"action": permission.get("action"), "resource": permission.get("resource")}
    if node.get("timeoutSeconds") is not None:
        plan["timeoutSeconds"] = node["timeoutSeconds"]
    budget = node.get("retryBudget")
    if isinstance(budget, Mapping):
        plan["retryBudget"] = {"maxAttempts": budget.get("maxAttempts")}
    if node.get("kind") == NodeKind.EXTERNAL_EFFECT.value:
        plan["effectIdentity"] = {
            "domain": EFFECT_KEY_DOMAIN,
            "stepId": step_id_for(graph_id, node_id),
            "composedWith": "transitionHash and the provider request hash at dispatch time",
        }
    if node_id in child_plans:
        plan["subgraph"] = child_plans[node_id]
    return plan


def _subgraph_plan(
    graph_id: str,
    node_id: str,
    node: Mapping[str, Any],
    known_graphs: Mapping[str, Mapping[str, Any]],
    closure: dict[str, str],
) -> dict[str, Any]:
    subgraph = node["subgraph"]
    child_id = str(subgraph.get("graphId"))
    entrypoint = str(subgraph.get("entrypoint"))
    budget = node.get("retryBudget")
    cap = int(budget.get("maxAttempts") or 0) if isinstance(budget, Mapping) else 0
    child = known_graphs.get(child_id) or {}
    child_entry = (child.get("entrypoints") or {}).get(entrypoint) if isinstance(child.get("entrypoints"), Mapping) else None
    required_inputs = sorted(
        str(item) for item in (child_entry.get("inputs") if isinstance(child_entry, Mapping) else ()) or ()
    )
    expected_exports = sorted(
        str(item) for item in (child_entry.get("exports") if isinstance(child_entry, Mapping) else ()) or ()
    )
    supplied = {str(value) for value in (node.get("inputs") or {}).values()}
    return {
        "nodeId": node_id,
        "childGraphId": child_id,
        "childGraphVersionPin": closure.get(f"subgraph.{child_id}"),
        "entrypoint": entrypoint,
        "contract": {
            "requiredInputs": required_inputs,
            "suppliedInputs": [fact for fact in required_inputs if fact in supplied],
            "missingInputs": [fact for fact in required_inputs if fact not in supplied],
            "expectedExports": expected_exports,
        },
        "invocationGenerationCap": cap,
        "childIdentity": {
            "domain": CHILD_INVOCATION_DOMAIN,
            "parentGraphId": graph_id,
            "parentNodeId": node_id,
            "childGraphId": child_id,
            "entrypoint": entrypoint,
            "invocationGeneration": "0..invocationGenerationCap",
            "replay": "same parent + generation + input pin resolves to the same child run; it never creates a second child",
        },
        "completionContract": "parent passes only after every expected export is verified",
    }


def compile_definition(
    definition: Mapping[str, Any],
    *,
    dependency_lock: Mapping[str, Any],
    known_graphs: Mapping[str, Mapping[str, Any]] | None = None,
) -> CompileArtifact:
    """Compile ``definition`` against ``dependency_lock`` into a plan plus a closure.

    The caller is expected to have validated the definition first; this function does not
    repeat the semantic checks, but it *does* refuse to compile anything it cannot pin,
    because an incomplete closure is worse than no compile at all.
    """
    if not isinstance(definition, Mapping):
        raise PolyForgeError(ErrorCode.BAD_REQUEST, "graph definition must be a mapping")
    graph_id = definition.get("graphId")
    if not isinstance(graph_id, str) or not graph_id:
        raise PolyForgeError(ErrorCode.BAD_REQUEST, "graph definition has no graphId")
    if not isinstance(dependency_lock, Mapping):
        raise PolyForgeError(ErrorCode.BAD_REQUEST, "dependency_lock must be a mapping")

    resolved_graphs = dict(known_graphs) if known_graphs is not None else dict(_known_graphs())

    pinned_definition_hash = hashing.hash_domain(
        "pf.definition", hashing.strip_for_hash(dict(definition), frozenset({"layout"}))
    )
    lock_hash = hashing.hash_domain(DEPENDENCY_LOCK_DOMAIN, hashing.strip_for_hash(dict(dependency_lock)))

    capabilities = _lock_section(dependency_lock, "capabilities")
    operations = _lock_section(dependency_lock, "operations")
    evaluators = _lock_section(dependency_lock, "evaluators")
    policies = _lock_section(dependency_lock, "policies")
    graph_pins = _lock_section(dependency_lock, "graphs")

    closure: dict[str, str] = {
        "schemaVersion": str(SCHEMA_VERSION),
        "compilerVersion": str(dependency_lock.get("compilerVersion") or COMPILER_VERSION),
        "graph.id": graph_id,
        "graph.definitionHash": pinned_definition_hash,
        "dependencyLockHash": lock_hash,
    }

    nodes = definition.get("nodes") if isinstance(definition.get("nodes"), Mapping) else {}
    entrypoints = definition.get("entrypoints") if isinstance(definition.get("entrypoints"), Mapping) else {}

    for node_id in sorted(nodes):
        node = nodes[node_id]
        if not isinstance(node, Mapping):
            continue
        operation = node.get("operation")
        if isinstance(operation, Mapping) and isinstance(operation.get("id"), str):
            version = _resolve_pin(
                "operation",
                operation["id"],
                operations,
                path=f"$.nodes.{node_id}.operation",
                baseline=str(operation.get("version")) if str(operation.get("version", "")).isdigit() else None,
            )
            closure[f"operation.{operation['id']}"] = version
        executor = node.get("executor")
        if isinstance(executor, Mapping):
            for capability in sorted(str(item) for item in executor.get("requiredCapabilities") or ()):
                if not capability:
                    continue
                closure[f"capability.{capability}"] = _resolve_pin(
                    "capability", capability, capabilities, path=f"$.nodes.{node_id}.executor"
                )
        for ref in sorted(str(item) for item in node.get("evaluatorRefs") or ()):
            if not ref:
                continue
            closure[f"evaluator.{ref}"] = _resolve_pin(
                "evaluator", ref, evaluators, path=f"$.nodes.{node_id}.evaluatorRefs"
            )
        subgraph = node.get("subgraph")
        if isinstance(subgraph, Mapping) and isinstance(subgraph.get("graphId"), str):
            child_id = subgraph["graphId"]
            closure[f"subgraph.{child_id}"] = _resolve_pin(
                "graph", child_id, graph_pins, path=f"$.nodes.{node_id}.subgraph"
            )

    baselines = catalog_versions()
    for ref in sorted(str(item) for item in definition.get("policyRefs") or ()):
        if not ref:
            continue
        name, _, declared = ref.partition("@")
        baseline = baselines.get(name)
        version = _resolve_pin(
            "policy",
            name,
            policies,
            path="$.policyRefs",
            baseline=None if baseline is None else str(baseline),
        )
        # A plan may never be built on a policy weaker than the catalog baseline, even if
        # the definition asked for it: the validator refuses that graph, and a stale or
        # hand-built definition must not reach a run through the compiler either.
        if baseline is not None and version.isdigit() and int(version) < int(baseline):
            raise PolyForgeError(
                ErrorCode.CONTRACT_INVALID,
                f"policy '{name}' resolved to version {version}, below the catalog baseline {baseline}",
                details={"policy": name, "resolved": version, "baseline": baseline},
            )
        if declared and not declared.isdigit():
            raise PolyForgeError(
                ErrorCode.CONTRACT_INVALID,
                f"policy ref '{ref}' has a non-numeric version",
                details={"policy": name, "version": declared},
            )
        closure[f"policy.{name}"] = f"{name}@{version}"

    edges = [
        (str(edge.get("from")), str(edge.get("to")))
        for edge in definition.get("edges") or ()
        if isinstance(edge, Mapping)
    ]
    order = topological_order(nodes, edges)

    child_plans: dict[str, Any] = {}
    for node_id in sorted(nodes):
        node = nodes[node_id]
        if not isinstance(node, Mapping):
            continue
        subgraph = node.get("subgraph")
        if not isinstance(subgraph, Mapping):
            continue
        child_id = str(subgraph.get("graphId"))
        if child_id not in resolved_graphs:
            raise PolyForgeError(
                ErrorCode.CONTRACT_INVALID,
                f"subgraph node '{node_id}' references unknown graph '{child_id}'",
                details={"nodeId": node_id, "graphId": child_id},
            )
        child_plans[node_id] = _subgraph_plan(graph_id, node_id, node, resolved_graphs, closure)

    plan: dict[str, Any] = {
        "schemaVersion": SCHEMA_VERSION,
        "compilerVersion": COMPILER_VERSION,
        "graphId": graph_id,
        "name": definition.get("name"),
        "definitionHash": pinned_definition_hash,
        "order": order,
        "loops": graph_loops(nodes, edges),
        "nodes": {
            node_id: _node_plan(graph_id, node_id, nodes[node_id], closure, child_plans)
            for node_id in sorted(nodes)
            if isinstance(nodes[node_id], Mapping)
        },
        "edges": [
            {
                "from": str(edge.get("from")),
                "to": str(edge.get("to")),
                "guard": str(edge.get("guard")) if edge.get("guard") else None,
            }
            for edge in definition.get("edges") or ()
            if isinstance(edge, Mapping)
        ],
        "entrypoints": {
            key: _entrypoint_plan(entrypoints[key])
            for key in sorted(entrypoints)
            if isinstance(entrypoints[key], Mapping)
        },
        "policyRefs": sorted(str(item) for item in definition.get("policyRefs") or ()),
        "policyClosure": {f"policy.{k.split('@')[0]}": v for k, v in closure.items() if k.startswith("policy.")},
        "subgraphPlan": child_plans,
        "ceilings": dict(CEILINGS),
    }

    plan_hash = hashing.hash_domain(PLAN_DOMAIN, hashing.strip_for_hash(plan))
    closure["graph.planHash"] = plan_hash

    return CompileArtifact(
        definition_hash=pinned_definition_hash,
        compiler_version=COMPILER_VERSION,
        plan_hash=plan_hash,
        dependency_lock_hash=lock_hash,
        closure=closure,
        plan=plan,
    )


def _entrypoint_plan(entry: Mapping[str, Any]) -> dict[str, Any]:
    coordinator = entry.get("coordinator")
    resume = entry.get("resumePolicy")
    plan: dict[str, Any] = {
        "key": entry.get("key"),
        "inputs": sorted(str(item) for item in entry.get("inputs") or ()),
        "requiresFacts": sorted(str(item) for item in entry.get("requiresFacts") or ()),
        "startNodes": sorted(str(item) for item in entry.get("startNodes") or ()),
        "exports": sorted(str(item) for item in entry.get("exports") or ()),
        "coordinator": {
            "requiredCapabilities": sorted(str(item) for item in (coordinator or {}).get("requiredCapabilities") or ()),
            "preferredRoles": sorted(str(item) for item in (coordinator or {}).get("preferredRoles") or ()),
            "fallbackRoles": sorted(str(item) for item in (coordinator or {}).get("fallbackRoles") or ()),
        }
        if isinstance(coordinator, Mapping)
        else {},
    }
    if isinstance(resume, Mapping):
        plan["resumePolicy"] = {
            "allowedCheckpointKinds": sorted(str(item) for item in resume.get("allowedCheckpointKinds") or ()),
            "reExecutionRequiresNewGeneration": bool(resume.get("reExecutionRequiresNewGeneration")),
        }
    return plan


def _known_graphs() -> Mapping[str, Mapping[str, Any]]:
    try:
        from polyforge.graph_library import all_definitions
    except Exception:  # pragma: no cover - library ships with the package
        return {}
    return all_definitions()
