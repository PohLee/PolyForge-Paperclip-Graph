"""Planner determinism, join semantics, guards, loops, and child subgraphs (AT-05)."""

from __future__ import annotations

import copy
import unittest

from services.polyforge.tests.runtime.fixtures import definition
from polyforge.core.runtime.planner import (
    build_plan,
    compute_plan_hash,
    evaluate_guard,
    plan_states,
)
from polyforge.core.state import BlockReason, JoinSemantics, NodeStatus


def _diamond() -> dict[str, object]:
    """Two branches into one join, plus a branch that is not on the live path."""
    return {
        "schemaVersion": 1,
        "graphId": "diamond",
        "name": "Diamond",
        "entrypoints": {
            "start": {
                "key": "start",
                "inputs": ["seed"],
                "requiresFacts": [],
                "coordinator": {"requiredCapabilities": []},
                "startNodes": ["left", "right"],
                "exports": ["merged"],
            }
        },
        "nodes": {
            "left": {"id": "left", "kind": "agent_operation", "produces": ["left_out"]},
            "right": {"id": "right", "kind": "agent_operation", "produces": ["right_out"]},
            "merge": {
                "id": "merge",
                "kind": "agent_operation",
                "join": {"semantics": "all", "inputs": ["left", "right"]},
                "produces": ["merged"],
            },
            "orphan": {
                "id": "orphan",
                "kind": "agent_operation",
                "requires": ["never_produced"],
                "produces": ["orphan_out"],
            },
        },
        "edges": [
            {"from": "left", "to": "merge"},
            {"from": "right", "to": "merge"},
            {"from": "left", "to": "orphan"},
        ],
        "policyRefs": [],
    }


def _states(**statuses: str) -> dict[str, dict[str, object]]:
    return {
        node_id: {"status": status, "rework_count": 0, "iteration": 0, "node_id": node_id}
        for node_id, status in statuses.items()
    }


def _plan(graph: dict[str, object]) -> object:
    return build_plan(graph, entrypoint="start")


class PlanHashTests(unittest.TestCase):
    """AT-18: the same inputs produce the same plan hash; a changed draft does not."""

    def test_the_same_definition_compiles_to_the_same_hash(self) -> None:
        first = _plan(_diamond())
        second = _plan(_diamond())
        self.assertEqual(first.plan_hash, second.plan_hash)

    def test_a_tampered_draft_changes_the_hash(self) -> None:
        tampered = copy.deepcopy(_diamond())
        tampered["nodes"]["left"]["produces"] = ["left_out", "extra_out"]
        self.assertNotEqual(_plan(_diamond()).plan_hash, _plan(tampered).plan_hash)

    def test_the_graph_version_is_not_part_of_the_hash(self) -> None:
        first = build_plan(_diamond(), graph_version=3, entrypoint="start")
        second = build_plan(_diamond(), graph_version=4, entrypoint="start")
        self.assertEqual(first.plan_hash, second.plan_hash)
        self.assertEqual(compute_plan_hash(first), first.plan_hash)

    def test_a_different_dependency_lock_changes_the_hash(self) -> None:
        graph = _diamond()
        first = build_plan(graph, entrypoint="start")
        second = build_plan(
            graph,
            entrypoint="start",
            artifact={"planHash": "", "dependencyLockHash": "sha256:other", "closure": {}},
        )
        self.assertNotEqual(first.plan_hash, second.plan_hash)


class ReadinessTests(unittest.TestCase):
    def setUp(self) -> None:
        self.plan = _plan(_diamond())

    def test_start_nodes_with_satisfied_inputs_become_ready(self) -> None:
        decisions = plan_states(
            self.plan,
            node_states=_states(left="PENDING", right="PENDING", merge="PENDING", orphan="PENDING"),
            available_facts={},
            available_exports={"seed": "sha256:seed"},
        )
        self.assertEqual(decisions["left"].status, NodeStatus.READY)
        self.assertEqual(decisions["right"].status, NodeStatus.READY)

    def test_a_node_missing_a_declared_input_is_not_ready(self) -> None:
        graph = _diamond()
        graph["nodes"]["left"]["inputs"] = {"missing_thing": "run_inputs"}
        plan = build_plan(graph, entrypoint="start")
        decisions = plan_states(
            plan,
            node_states=_states(left="PENDING", right="PENDING", merge="PENDING", orphan="PENDING"),
            available_exports={"seed": "sha256:seed"},
        )
        self.assertEqual(decisions["left"].status, NodeStatus.PENDING)
        self.assertIn("missing_thing", decisions["left"].reason)

    def test_an_unsatisfied_required_fact_is_not_ready(self) -> None:
        decisions = plan_states(
            self.plan,
            node_states=_states(left="PASSED", right="PASSED", merge="PENDING", orphan="PENDING"),
            available_exports={"seed": "sha256:seed"},
        )
        self.assertEqual(decisions["orphan"].status, NodeStatus.PENDING)

    def test_a_start_node_with_an_unsatisfied_fact_reports_the_fact(self) -> None:
        graph = _diamond()
        graph["nodes"]["left"]["requires"] = ["never_produced"]
        plan = build_plan(graph, entrypoint="start")
        decisions = plan_states(
            plan,
            node_states=_states(left="PENDING", right="PENDING", merge="PENDING", orphan="PENDING"),
            available_exports={"seed": "sha256:seed"},
        )
        self.assertEqual(decisions["left"].status, NodeStatus.PENDING)
        self.assertIn("never_produced", decisions["left"].reason)
        self.assertEqual(decisions["left"].missing_facts, ("never_produced",))

    def test_a_satisfied_fact_releases_the_node(self) -> None:
        graph = _diamond()
        graph["nodes"]["left"]["requires"] = ["budget_available"]
        plan = build_plan(graph, entrypoint="start")
        decisions = plan_states(
            plan,
            node_states=_states(left="PENDING", right="PENDING", merge="PENDING", orphan="PENDING"),
            available_facts={"budget_available": True},
            available_exports={"seed": "sha256:seed"},
        )
        self.assertEqual(decisions["left"].status, NodeStatus.READY)

    def test_an_in_flight_node_is_left_alone(self) -> None:
        decisions = plan_states(
            self.plan,
            node_states=_states(left="RUNNING", right="PENDING", merge="PENDING", orphan="PENDING"),
            available_exports={"seed": "sha256:seed"},
        )
        self.assertEqual(decisions["left"].status, NodeStatus.RUNNING)
        self.assertIn("does not disturb", decisions["left"].reason)


class JoinTests(unittest.TestCase):
    """AT-05: all / any / quorum release only legal successors."""

    def setUp(self) -> None:
        self.graph = _diamond()
        self.plan = build_plan(self.graph, entrypoint="start")
        self.states = _states(left="PASSED", right="PASSED", merge="PENDING", orphan="PENDING")

    def _merge(self, semantics: str, quorum: int = 0, statuses: dict[str, str] | None = None) -> str:
        graph = copy.deepcopy(self.graph)
        graph["nodes"]["merge"]["join"] = {"semantics": semantics, "quorum": quorum}
        plan = build_plan(graph, entrypoint="start")
        states = _states(
            **(
                statuses
                or {"left": "PASSED", "right": "PASSED", "merge": "PENDING", "orphan": "PENDING"}
            )
        )
        decisions = plan_states(
            plan, node_states=states, available_exports={"seed": "sha256:seed"}
        )
        return decisions["merge"].status

    def test_all_join_needs_every_upstream(self) -> None:
        self.assertEqual(self._merge("all"), NodeStatus.READY)
        self.assertEqual(
            self._merge(
                "all", statuses={"left": "PASSED", "right": "PENDING", "merge": "PENDING", "orphan": "PENDING"}
            ),
            NodeStatus.PENDING,
        )

    def test_any_join_needs_only_one_upstream(self) -> None:
        self.assertEqual(
            self._merge(
                "any", statuses={"left": "PASSED", "right": "PENDING", "merge": "PENDING", "orphan": "PENDING"}
            ),
            NodeStatus.READY,
        )

    def test_quorum_join_needs_its_count(self) -> None:
        self.assertEqual(self._merge("quorum", quorum=2), NodeStatus.READY)
        self.assertEqual(
            self._merge(
                "quorum",
                quorum=2,
                statuses={"left": "PASSED", "right": "PENDING", "merge": "PENDING", "orphan": "PENDING"},
            ),
            NodeStatus.PENDING,
        )

    def test_a_failed_upstream_never_satisfies_a_join(self) -> None:
        for semantics in ("all", "any", "quorum"):
            with self.subTest(semantics=semantics):
                self.assertEqual(
                    self._merge(
                        semantics,
                        quorum=1,
                        statuses={
                            "left": "FAILED",
                            "right": "PENDING",
                            "merge": "PENDING",
                            "orphan": "PENDING",
                        },
                    ),
                    NodeStatus.BLOCKED,
                )

    def test_a_skipped_upstream_propagates_under_an_all_join(self) -> None:
        self.assertEqual(
            self._merge(
                "all",
                statuses={"left": "SKIPPED", "right": "SKIPPED", "merge": "PENDING", "orphan": "PENDING"},
            ),
            NodeStatus.SKIPPED,
        )

    def test_a_skipped_upstream_does_not_block_an_any_join_with_a_passed_one(self) -> None:
        self.assertEqual(
            self._merge(
                "any",
                statuses={"left": "PASSED", "right": "SKIPPED", "merge": "PENDING", "orphan": "PENDING"},
            ),
            NodeStatus.READY,
        )


class GuardTests(unittest.TestCase):
    def test_a_guard_over_a_missing_fact_is_undecided_not_false(self) -> None:
        state, reason = evaluate_guard({"fact": "risk", "equals": "high"}, {})
        self.assertEqual(state, "unknown")
        self.assertIn("has not been produced", reason)

    def test_a_false_guard_skips_the_branch(self) -> None:
        state, _ = evaluate_guard({"fact": "risk", "equals": "high"}, {"risk": "low"})
        self.assertEqual(state, "fails")

    def test_a_true_guard_holds(self) -> None:
        state, _ = evaluate_guard({"fact": "risk", "equals": "high"}, {"risk": "high"})
        self.assertEqual(state, "holds")

    def test_a_guard_that_selects_a_branch_out_marks_the_node_skipped(self) -> None:
        graph = _diamond()
        graph["nodes"]["left"]["guard"] = {"fact": "enabled", "equals": True}
        plan = build_plan(graph, entrypoint="start")
        decisions = plan_states(
            plan,
            node_states=_states(left="PENDING", right="PENDING", merge="PENDING", orphan="PENDING"),
            available_facts={"enabled": False},
            available_exports={"seed": "sha256:seed"},
        )
        self.assertEqual(decisions["left"].status, NodeStatus.SKIPPED)
        self.assertIn("selects this branch out", decisions["left"].reason)

    def test_an_undecided_guard_holds_the_node_pending(self) -> None:
        graph = _diamond()
        graph["nodes"]["left"]["guard"] = {"fact": "enabled", "equals": True}
        plan = build_plan(graph, entrypoint="start")
        decisions = plan_states(
            plan,
            node_states=_states(left="PENDING", right="PENDING", merge="PENDING", orphan="PENDING"),
            available_facts={},
            available_exports={"seed": "sha256:seed"},
        )
        self.assertEqual(decisions["left"].status, NodeStatus.PENDING)
        self.assertIn("undecided", decisions["left"].reason)


class BoundedLoopTests(unittest.TestCase):
    def test_a_rework_feedback_edge_does_not_block_the_first_iteration(self) -> None:
        graph = _diamond()
        graph["edges"].append({"from": "merge", "to": "left", "guard": "rework"})
        plan = build_plan(graph, entrypoint="start")
        self.assertEqual(plan.predecessors("left"), ())
        self.assertEqual(plan.predecessors("left", include_feedback=True), ("merge",))
        decisions = plan_states(
            plan,
            node_states=_states(left="PENDING", right="PENDING", merge="PENDING", orphan="PENDING"),
            available_exports={"seed": "sha256:seed"},
        )
        self.assertEqual(decisions["left"].status, NodeStatus.READY)

    def test_reaching_the_rework_ceiling_blocks_rather_than_looping(self) -> None:
        graph = _diamond()
        graph["nodes"]["left"]["retryBudget"] = {"maxAttempts": 2}
        plan = build_plan(graph, entrypoint="start")
        states = _states(left="REWORK_REQUIRED", right="PENDING", merge="PENDING", orphan="PENDING")
        states["left"]["rework_count"] = 2
        decisions = plan_states(
            plan, node_states=states, available_exports={"seed": "sha256:seed"}
        )
        self.assertEqual(decisions["left"].status, NodeStatus.BLOCKED)
        self.assertEqual(decisions["left"].block_reason, str(BlockReason.BUDGET))
        self.assertIn("ceiling", decisions["left"].reason)

    def test_one_rework_short_of_the_ceiling_is_still_ready(self) -> None:
        graph = _diamond()
        graph["nodes"]["left"]["retryBudget"] = {"maxAttempts": 2}
        plan = build_plan(graph, entrypoint="start")
        states = _states(left="REWORK_REQUIRED", right="PENDING", merge="PENDING", orphan="PENDING")
        states["left"]["rework_count"] = 1
        decisions = plan_states(
            plan, node_states=states, available_exports={"seed": "sha256:seed"}
        )
        self.assertEqual(decisions["left"].status, NodeStatus.READY)


class ChildSubgraphTests(unittest.TestCase):
    """REQ-ENTRY-06: a parent passes only on a completed child with verified exports."""

    def setUp(self) -> None:
        self.graph = {
            "schemaVersion": 1,
            "graphId": "parent",
            "entrypoints": {
                "start": {
                    "key": "start",
                    "inputs": [],
                    "requiresFacts": [],
                    "coordinator": {"requiredCapabilities": []},
                    "startNodes": ["child"],
                    "exports": ["child_result"],
                }
            },
            "nodes": {
                "child": {
                    "id": "child",
                    "kind": "subgraph",
                    "subgraph": {"graphId": "child-graph", "entrypoint": "child.start"},
                    "produces": ["child_result"],
                }
            },
            "edges": [],
            "policyRefs": [],
        }
        self.plan = build_plan(self.graph, entrypoint="start")

    def _decide(self, child: dict[str, object] | None) -> object:
        states = {"child": {"status": "PENDING", "rework_count": 0, "iteration": 0, "node_id": "child", "child_run_id": "child-run-1"}}
        return plan_states(
            self.plan,
            node_states=states,  # type: ignore[arg-type]
            child_runs={"child-run-1": child} if child else {},
        )["child"]

    def test_a_missing_child_run_holds_the_parent(self) -> None:
        decision = self._decide(None)
        self.assertEqual(decision.status, NodeStatus.PENDING)
        self.assertIn("has not been created", decision.reason)

    def test_a_running_child_holds_the_parent(self) -> None:
        decision = self._decide({"status": "ACTIVE", "exports": []})
        self.assertEqual(decision.status, NodeStatus.PENDING)

    def test_a_completed_child_without_verified_exports_holds_the_parent(self) -> None:
        decision = self._decide({"status": "COMPLETED", "exports": []})
        self.assertEqual(decision.status, NodeStatus.PENDING)
        self.assertIn("verified export", decision.reason)

    def test_a_completed_child_with_verified_exports_releases_the_parent(self) -> None:
        decision = self._decide({"status": "COMPLETED", "exports": ["child_result"]})
        self.assertEqual(decision.status, NodeStatus.READY)

    def test_a_failed_child_blocks_the_parent(self) -> None:
        decision = self._decide({"status": "FAILED", "exports": []})
        self.assertEqual(decision.status, NodeStatus.BLOCKED)
        self.assertIn("never passes on a worker exit alone", decision.reason)


class DeterminismTests(unittest.TestCase):
    def test_the_same_plan_and_state_produce_the_same_decisions(self) -> None:
        plan = _plan(_diamond())
        first = plan_states(
            plan,
            node_states=_states(left="PASSED", right="PENDING", merge="PENDING", orphan="PENDING"),
            available_exports={"seed": "sha256:seed"},
            available_facts={},
        )
        second = plan_states(
            plan,
            node_states=_states(left="PASSED", right="PENDING", merge="PENDING", orphan="PENDING"),
            available_exports={"seed": "sha256:seed"},
            available_facts={},
        )
        self.assertEqual(
            {k: v.to_wire() for k, v in first.items()},
            {k: v.to_wire() for k, v in second.items()},
        )

    def test_the_planner_does_not_depend_on_node_insertion_order(self) -> None:
        plan = _plan(_diamond())
        forward = _states(left="PASSED", right="PENDING", merge="PENDING", orphan="PENDING")
        backward = dict(reversed(list(forward.items())))
        first = plan_states(plan, node_states=forward, available_exports={"seed": "sha256:seed"})
        second = plan_states(plan, node_states=backward, available_exports={"seed": "sha256:seed"})
        self.assertEqual(
            {k: v.status for k, v in first.items()},
            {k: v.status for k, v in second.items()},
        )

    def test_a_plan_round_trips_through_the_wire(self) -> None:
        plan = _plan(_diamond())
        restored = type(plan).from_wire(plan.to_wire())
        self.assertEqual(restored.plan_hash, plan.plan_hash)
        self.assertEqual(set(restored.nodes), set(plan.nodes))
        self.assertEqual(restored.predecessors("merge"), plan.predecessors("merge"))


class DefinitionValidationTests(unittest.TestCase):
    def test_an_edge_to_an_undeclared_node_is_refused(self) -> None:
        from polyforge.core import errors

        graph = _diamond()
        graph["edges"].append({"from": "left", "to": "nowhere"})
        with self.assertRaises(errors.PolyForgeError) as caught:
            build_plan(graph, entrypoint="start")
        self.assertEqual(caught.exception.code, errors.ErrorCode.CONTRACT_INVALID)

    def test_an_undeclared_entrypoint_is_refused(self) -> None:
        from polyforge.core import errors

        with self.assertRaises(errors.PolyForgeError):
            build_plan(_diamond(), entrypoint="not-a-key")

    def test_a_definition_without_a_graph_id_is_refused(self) -> None:
        from polyforge.core import errors

        with self.assertRaises(errors.PolyForgeError):
            build_plan({"nodes": {}, "edges": []})


class VerificationFixtureTests(unittest.TestCase):
    def test_the_shipped_fixture_only_releases_legal_starters(self) -> None:
        plan = build_plan(definition(), entrypoint="verification.start")
        states = {
            node_id: {"status": "PENDING", "rework_count": 0, "iteration": 0, "node_id": node_id}
            for node_id in plan.nodes
        }
        decisions = plan_states(
            plan,
            node_states=states,
            available_exports={"candidate_artifacts": "sha256:candidate"},
        )
        self.assertEqual(decisions["qa_run"].status, NodeStatus.READY)
        self.assertEqual(decisions["security_review"].status, NodeStatus.PENDING)
        self.assertEqual(decisions["review_gate"].status, NodeStatus.PENDING)


if __name__ == "__main__":
    unittest.main()
