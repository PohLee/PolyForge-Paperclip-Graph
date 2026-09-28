"""The shipped graph library: five engineering graph families.

Responsibility: hand the Core the graphs a PolyForge deployment starts from, plus the
version tables a dependency lock has to pin to compile them.

Invariants
----------
* Every exported graph is a *real* graph: capability contracts (never Paperclip agent ids),
  a human gate where the family is decided, a ``retryBudget`` on every node that can be on
  a cycle, and a permission gate in front of every external effect. The test suite validates
  and compiles all of them on every run, so a graph that stops satisfying the baseline
  cannot ship in this package.
* ``definition()`` returns a deep copy. Callers annotate definitions; a shared literal
  would leak those annotations between callers and between requests.
* A family is *not* decomposed into a subgraph per role. REQ-ENTRY-01 only makes a
  workflow a subgraph when it has a real ownership and recovery boundary, and
  "clarify" or "read a file" does not. Composition across families happens between
  WorkOrders, each pinned to its own version closure.
* The version tables are the only source of a version number. The compiler never defaults
  one: a capability or evaluator that is missing here is a compile failure, not a guess.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any, Final, Mapping

from polyforge import COMPILER_VERSION, SCHEMA_VERSION
from polyforge.core.compiler.compile import dependency_lock_for as build_dependency_lock
from polyforge.core.compiler.policy_catalog import catalog_versions
from polyforge.core.errors import not_found
from polyforge.graph_library import design, implementation, release, requirement, verification

__all__ = [
    "CAPABILITY_VERSIONS",
    "EVALUATOR_VERSIONS",
    "GRAPH_LIBRARY",
    "all_definitions",
    "dependency_lock_for",
    "dependency_lock_for_definition",
    "library_graph_ids",
    "load_graph",
]

#: Capability contract versions pinned into a run closure. The key is a capability
#: contract name, never an agent identity: swapping the worker that satisfies it must not
#: change a run's pins (REQ-ENTRY-04).
CAPABILITY_VERSIONS: Final[dict[str, int]] = {
    "architecture.design": 2,
    "code.modify": 2,
    "implementation.coordinate": 1,
    "implementation.plan": 1,
    "implementation.review": 1,
    "qa.execute": 2,
    "regression.execute": 1,
    "requirement.analyze": 1,
    "requirement.baseline": 1,
    "requirement.clarify": 1,
    "requirement.coordinate": 1,
    "design.coordinate": 1,
    "release.coordinate": 1,
    "security.review": 2,
    "verification.coordinate": 1,
}

#: Evaluator versions pinned into a run closure.
EVALUATOR_VERSIONS: Final[dict[str, int]] = {
    "acceptance_criteria_review_v1": 1,
    "authorization_scope_check_v1": 1,
    "contract_schema_v1": 1,
    "deployment_verification_v1": 1,
    "qa_report_check_v2": 2,
    "regression_check_v1": 1,
    "requirement_completeness_v1": 1,
    "review_findings_check_v1": 1,
    "rollback_readiness_v1": 1,
    "security_report_check_v1": 1,
    "test_report_check_v1": 1,
    "threat_model_review_v2": 2,
}

GRAPH_LIBRARY: Final[dict[str, Callable[[], dict]]] = {
    "requirement": requirement.definition,
    "design": design.definition,
    "implementation": implementation.definition,
    "verification": verification.definition,
    "release": release.definition,
}


def all_definitions() -> dict[str, dict[str, Any]]:
    """Every library graph, keyed by graph id, as fresh copies."""
    return {graph_id: builder() for graph_id, builder in GRAPH_LIBRARY.items()}


def load_graph(graph_id: str) -> dict[str, Any]:
    """The definition of one library graph, or ``NOT_FOUND`` for an unknown id."""
    builder = GRAPH_LIBRARY.get(graph_id)
    if builder is None:
        raise not_found("graph is not in the library", graphId=graph_id, known=sorted(GRAPH_LIBRARY))
    return builder()


def library_graph_ids() -> frozenset[str]:
    return frozenset(GRAPH_LIBRARY)


def dependency_lock_for(graph_id: str) -> dict[str, Any]:
    """A complete, pinned dependency lock for one library graph.

    The child graph versions are the only thing a caller may have to extend: a graph with
    ``subgraph`` nodes needs a version for each child, and an unpinned child is refused by
    the compiler rather than resolved to a default.
    """
    definition = load_graph(graph_id)
    lock = dependency_lock_for_definition(
        definition,
        capability_versions=CAPABILITY_VERSIONS,
        evaluator_versions=EVALUATOR_VERSIONS,
        policy_versions=catalog_versions(),
    )
    lock["schemaVersion"] = SCHEMA_VERSION
    lock["compilerVersion"] = COMPILER_VERSION
    return lock


def dependency_lock_for_definition(
    definition: Mapping[str, Any],
    *,
    capability_versions: Mapping[str, int] | None = None,
    evaluator_versions: Mapping[str, int] | None = None,
    policy_versions: Mapping[str, int] | None = None,
    graph_versions: Mapping[str, int] | None = None,
) -> dict[str, Any]:
    """Build a dependency lock from the library version tables.

    ``graph_versions`` pins child graph versions and is the one input a caller must supply
    when the definition references a subgraph.
    """
    return build_dependency_lock(
        definition,
        capability_versions=capability_versions if capability_versions is not None else CAPABILITY_VERSIONS,
        evaluator_versions=evaluator_versions if evaluator_versions is not None else EVALUATOR_VERSIONS,
        policy_versions=policy_versions if policy_versions is not None else catalog_versions(),
        graph_versions=graph_versions,
    )
