"""Semantic diff tests: what changed, and what that invalidates.

AT-21 (REQ-MIG-02/04) requires that a changed node, a removed node and a newly added gate
all invalidate previously recorded evidence. AT-19 requires that a version bump which does
not change a node's meaning does not.
"""

from __future__ import annotations

import copy
import unittest

from polyforge.core.compiler.diff import SemanticDiff, edge_identity, node_fingerprint, semantic_diff
from polyforge.graph_library import load_graph


class NoOpDiffTest(unittest.TestCase):
    """Identical definitions, and cosmetic changes, produce an empty diff."""

    def test_identical_definitions(self):
        definition = load_graph("implementation")
        diff = semantic_diff(definition, copy.deepcopy(definition))
        self.assertTrue(diff.is_noop)
        self.assertFalse(diff.invalidates_evidence)
        self.assertEqual(diff.graph_id, "implementation")

    def test_layout_moves_are_not_semantic(self):
        before = load_graph("design")
        after = copy.deepcopy(before)
        after["nodes"]["architecture"]["layout"] = {"x": 640, "y": 480}
        after["nodes"]["design_gate"]["layout"] = {"x": 1, "y": 1}
        diff = semantic_diff(before, after)
        self.assertTrue(diff.is_noop)
        self.assertFalse(diff.invalidates_evidence)

    def test_node_fingerprint_ignores_layout_only(self):
        node = {"id": "n", "kind": "deterministic"}
        moved = {**node, "layout": {"x": 3, "y": 4}}
        self.assertEqual(
            node_fingerprint("n", node, [], []), node_fingerprint("n", moved, [], [])
        )

    def test_from_nothing_is_all_additions(self):
        diff = semantic_diff(None, load_graph("requirement"))
        self.assertEqual(
            diff.added_nodes,
            ["acceptance_review", "analyze", "baseline", "clarify", "requirement_gate"],
        )
        self.assertEqual(diff.removed_nodes, [])
        self.assertTrue(diff.invalidates_evidence)

    def test_to_nothing_is_all_removals(self):
        diff = semantic_diff(load_graph("requirement"), None)
        self.assertEqual(
            diff.removed_nodes,
            ["acceptance_review", "analyze", "baseline", "clarify", "requirement_gate"],
        )
        self.assertTrue(diff.invalidates_evidence)


class NodeChangeTest(unittest.TestCase):
    """AT-21: semantics, inputs, evaluators and neighbours all count as changes."""

    def setUp(self):
        self.before = load_graph("design")

    def _after(self) -> dict:
        return copy.deepcopy(self.before)

    def test_changed_operation_version(self):
        after = self._after()
        after["nodes"]["architecture"]["operation"]["version"] = 4
        diff = semantic_diff(self.before, after)
        self.assertEqual(diff.changed_nodes, ["architecture"])
        self.assertTrue(diff.invalidates_evidence)

    def test_changed_capability(self):
        after = self._after()
        after["nodes"]["security_review"]["executor"]["requiredCapabilities"] = ["security.review", "threat.model"]
        diff = semantic_diff(self.before, after)
        self.assertEqual(diff.changed_nodes, ["security_review"])
        self.assertTrue(diff.invalidates_evidence)

    def test_changed_evaluator_refs(self):
        after = self._after()
        after["nodes"]["design_gate"]["evaluatorRefs"] = ["contract_schema_v1"]
        diff = semantic_diff(self.before, after)
        self.assertEqual(diff.changed_nodes, ["design_gate"])
        self.assertTrue(diff.invalidates_evidence)

    def test_changed_human_decision_kind(self):
        after = self._after()
        after["nodes"]["design_gate"]["humanDecision"]["semanticKind"] = "design_acceptance_v2"
        diff = semantic_diff(self.before, after)
        self.assertEqual(diff.changed_nodes, ["design_gate"])
        self.assertTrue(diff.invalidates_evidence)

    def test_changed_permission_gate_resource(self):
        before = load_graph("release")
        after = copy.deepcopy(before)
        after["nodes"]["deploy_authorization"]["permissionGate"]["resource"] = "other_environment"
        diff = semantic_diff(before, after)
        self.assertEqual(diff.changed_nodes, ["deploy_authorization"])
        self.assertTrue(diff.invalidates_evidence)

    def test_a_new_predecessor_changes_the_node(self):
        before = load_graph("verification")
        after = copy.deepcopy(before)
        after["edges"].append({"from": "regression_run", "to": "qa_execute", "guard": "regression_failed"})
        after["nodes"]["qa_execute"]["retryBudget"] = {"maxAttempts": 2}
        diff = semantic_diff(before, after)
        self.assertEqual(diff.added_edges, ["regression_run->qa_execute[regression_failed]"])
        self.assertEqual(diff.changed_nodes, ["qa_execute", "regression_run"])

    def test_removed_node_invalidates_evidence(self):
        after = self._after()
        del after["nodes"]["security_review"]
        after["edges"] = [{"from": "architecture", "to": "design_gate"}]
        after["nodes"]["design_gate"]["inputs"] = {"architecture": "architecture_spec"}
        diff = semantic_diff(self.before, after)
        self.assertEqual(diff.removed_nodes, ["security_review"])
        self.assertIn("design_gate", diff.changed_nodes)
        self.assertTrue(diff.invalidates_evidence)

    def test_removed_node_keeps_its_edge_itself_in_the_report(self):
        after = self._after()
        del after["nodes"]["security_review"]
        after["edges"] = [{"from": "architecture", "to": "design_gate"}]
        diff = semantic_diff(self.before, after)
        # Both the node and the edges that touched it are reported. Deleting a node from a
        # definition says nothing about the effects it already caused, and the diff never
        # pretends otherwise.
        self.assertEqual(diff.removed_nodes, ["security_review"])
        self.assertEqual(
            diff.removed_edges, ["architecture->security_review", "security_review->design_gate"]
        )
        self.assertEqual(diff.added_edges, ["architecture->design_gate"])


class NewGateTest(unittest.TestCase):
    """AT-21 / REQ-MIG-04: adding a gate must make it run; it inherits nothing."""

    def test_added_gate_invalidates_evidence(self):
        before = load_graph("design")
        after = copy.deepcopy(before)
        after["nodes"]["security_gate"] = {
            "id": "security_gate",
            "kind": "gate",
            "evaluatorRefs": ["threat_model_review_v2"],
            "humanDecision": {"required": True, "semanticKind": "security_acceptance"},
        }
        after["edges"].append({"from": "security_review", "to": "security_gate"})
        after["edges"] = [edge for edge in after["edges"] if edge != {"from": "security_review", "to": "design_gate"}]
        after["edges"].append({"from": "security_gate", "to": "design_gate"})
        after["entrypoints"]["design.start"]["exports"].append("security_acceptance")
        after["nodes"]["security_gate"]["produces"] = ["security_acceptance"]
        diff = semantic_diff(before, after)
        self.assertEqual(diff.added_nodes, ["security_gate"])
        self.assertTrue(diff.invalidates_evidence)
        self.assertIn("design_gate", diff.changed_nodes)

    def test_a_typed_output_added_to_a_node_changes_only_that_node(self):
        before = load_graph("release")
        after = copy.deepcopy(before)
        after["nodes"]["deploy"]["outputs"] = ["deployment_receipt.v1"]
        diff = semantic_diff(before, after)
        self.assertEqual(diff.changed_nodes, ["deploy"])
        self.assertEqual(diff.added_nodes, [])
        self.assertTrue(diff.invalidates_evidence)

    def test_added_evaluator_pin_changes_the_gate(self):
        before = load_graph("release")
        after = copy.deepcopy(before)
        after["nodes"]["release_quality_gate"]["evaluatorRefs"].append("smoke_check_v1")
        diff = semantic_diff(before, after)
        self.assertEqual(diff.changed_nodes, ["release_quality_gate"])


class PolicyDiffTest(unittest.TestCase):
    """A policy change invalidates: a gate is judged under its effective policy."""

    def test_added_policy_ref(self):
        before = load_graph("design")
        after = copy.deepcopy(before)
        after["policyRefs"].append("policy.budget_and_authority_ceilings@1")
        diff = semantic_diff(before, after)
        self.assertEqual(diff.policy_changes, ["+policy.budget_and_authority_ceilings@1"])
        self.assertTrue(diff.invalidates_evidence)

    def test_removed_policy_ref(self):
        before = load_graph("design")
        after = copy.deepcopy(before)
        after["policyRefs"] = after["policyRefs"][:-1]
        diff = semantic_diff(before, after)
        self.assertEqual(diff.policy_changes, ["-policy.budget_and_authority_ceilings"])
        self.assertTrue(diff.invalidates_evidence)


class DiffShapeTest(unittest.TestCase):
    """The diff mirrors ``SemanticDiff`` in the TypeScript protocol."""

    def test_edge_identity_keeps_the_guard(self):
        self.assertEqual(edge_identity({"from": "a", "to": "b"}), "a->b")
        self.assertEqual(edge_identity({"from": "a", "to": "b", "guard": "rework"}), "a->b[rework]")

    def test_round_trip_with_version_labels(self):
        diff = semantic_diff(
            load_graph("design"), load_graph("design"), from_version=13, to_version=14
        )
        body = diff.to_dict()
        self.assertEqual(body["fromVersion"], 13)
        self.assertEqual(body["toVersion"], 14)
        self.assertEqual(SemanticDiff.from_dict(body).to_dict(), body)

    def test_diff_is_pure(self):
        before = load_graph("verification")
        snapshot = copy.deepcopy(before)
        semantic_diff(before, load_graph("release"))
        self.assertEqual(before, snapshot)
