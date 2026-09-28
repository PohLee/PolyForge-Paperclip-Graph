"""Every shipped graph must validate, compile deterministically, and stay honest.

This is the standing check behind REQ-UI-01's library view: a graph that stops satisfying
the baseline cannot ship in this package. It also pins the properties the families are
designed around — capability contracts instead of agent ids, a retry budget on every loop,
a permission gate ahead of every side effect, and independence on every review node.
"""

from __future__ import annotations

import copy
import json
import unittest

from polyforge.core.compiler.compile import compile_definition, graph_loops
from polyforge.core.compiler.policy_catalog import CEILINGS, catalog_versions
from polyforge.core.compiler.validate import validate_definition
from polyforge.core.errors import ErrorCode, PolyForgeError
from polyforge.core.gates.evaluators_domain import DOMAIN_EVALUATORS
from polyforge.core.runtime.planner import build_plan
from polyforge.core.state import NodeKind
from polyforge.graph_library import (
    CAPABILITY_VERSIONS,
    EVALUATOR_VERSIONS,
    GRAPH_LIBRARY,
    all_definitions,
    dependency_lock_for,
    library_graph_ids,
    load_graph,
)

_EXPECTED = {
    "requirement": ({"requirement.start"}, 5),
    "design": ({"design.start", "design.security_review", "design.resume_review"}, 3),
    "implementation": ({"implementation.start"}, 6),
    "verification": ({"verification.start"}, 5),
    "release": ({"release.start"}, 3),
}


class LibraryShapeTest(unittest.TestCase):
    """The library surface itself."""

    def test_the_five_families_are_registered(self):
        self.assertEqual(set(GRAPH_LIBRARY), set(_EXPECTED))
        self.assertEqual(library_graph_ids(), frozenset(_EXPECTED))

    def test_load_graph_raises_not_found_for_an_unknown_id(self):
        with self.assertRaises(PolyForgeError) as caught:
            load_graph("not_a_family")
        self.assertEqual(caught.exception.code, ErrorCode.NOT_FOUND)
        self.assertIn("known", caught.exception.details)

    def test_each_call_returns_a_fresh_copy(self):
        first = load_graph("design")
        first["nodes"]["architecture"]["timeoutSeconds"] = 1
        self.assertNotEqual(load_graph("design")["nodes"]["architecture"]["timeoutSeconds"], 1)

    def test_all_definitions_matches_the_builders(self):
        everything = all_definitions()
        self.assertEqual(sorted(everything), sorted(_EXPECTED))
        for graph_id, definition in everything.items():
            with self.subTest(graph=graph_id):
                self.assertEqual(definition, load_graph(graph_id))

    def test_the_declared_key_is_the_graph_id(self):
        for graph_id, definition in all_definitions().items():
            with self.subTest(graph=graph_id):
                self.assertEqual(definition["graphId"], graph_id)
                self.assertEqual(definition["schemaVersion"], 1)


class ValidationTest(unittest.TestCase):
    """Every shipped graph passes the current baseline with no errors."""

    def test_every_graph_validates(self):
        for graph_id, definition in all_definitions().items():
            with self.subTest(graph=graph_id):
                report = validate_definition(definition)
                self.assertTrue(report.ok, [i.to_dict() for i in report.issues])

    def test_entrypoints_and_node_counts_are_what_the_families_design_for(self):
        for graph_id, definition in all_definitions().items():
            expected_entries, expected_nodes = _EXPECTED[graph_id]
            with self.subTest(graph=graph_id):
                self.assertEqual(set(definition["entrypoints"]), expected_entries)
                self.assertEqual(len(definition["nodes"]), expected_nodes)

    def test_every_graph_pins_the_whole_policy_baseline(self):
        for graph_id, definition in all_definitions().items():
            with self.subTest(graph=graph_id):
                self.assertEqual(sorted(definition["policyRefs"]), sorted(catalog_versions()))

    def test_no_graph_references_a_concrete_agent(self):
        for graph_id, definition in all_definitions().items():
            text = json.dumps(definition).lower()
            with self.subTest(graph=graph_id):
                for forbidden in ("agent_id", "agentid", "paperclip_agent", "claude-", "gpt-"):
                    self.assertNotIn(forbidden, text)

    def test_every_executor_requires_a_capability_contract(self):
        for graph_id, definition in all_definitions().items():
            for node_id, node in definition["nodes"].items():
                if node.get("kind") != NodeKind.AGENT_OPERATION.value:
                    continue
                with self.subTest(graph=graph_id, node=node_id):
                    self.assertTrue(node["executor"]["requiredCapabilities"])
                    for capability in node["executor"]["requiredCapabilities"]:
                        self.assertIn(capability, CAPABILITY_VERSIONS)

    def test_every_node_on_a_loop_declares_a_retry_budget(self):
        for graph_id, definition in all_definitions().items():
            for component in graph_loops(
                definition["nodes"],
                [(edge["from"], edge["to"]) for edge in definition["edges"]],
            ):
                for node_id in component:
                    with self.subTest(graph=graph_id, node=node_id):
                        budget = definition["nodes"][node_id].get("retryBudget")
                        self.assertIsNotNone(budget)
                        self.assertLessEqual(budget["maxAttempts"], CEILINGS["maxAttemptsPerNode"])

    def test_a_side_effect_never_retries_blindly(self):
        definition = load_graph("release")
        self.assertEqual(definition["nodes"]["deploy"]["kind"], NodeKind.EXTERNAL_EFFECT.value)
        self.assertEqual(definition["nodes"]["deploy"]["retryBudget"]["maxAttempts"], 1)

    def test_every_permission_gate_names_an_exact_action_and_resource(self):
        for graph_id, definition in all_definitions().items():
            for node_id, node in definition["nodes"].items():
                gate = node.get("permissionGate")
                if gate is None:
                    continue
                with self.subTest(graph=graph_id, node=node_id):
                    self.assertTrue(gate["action"])
                    self.assertTrue(gate["resource"])

    def test_every_review_node_declares_independence(self):
        for graph_id, definition in all_definitions().items():
            for node_id, node in definition["nodes"].items():
                if node.get("operation", {}).get("id", "").endswith(".review"):
                    with self.subTest(graph=graph_id, node=node_id):
                        self.assertTrue(node["executor"]["independentFrom"])

    def test_every_gate_is_human_decided_or_independently_evaluated(self):
        for graph_id, definition in all_definitions().items():
            for node_id, node in definition["nodes"].items():
                if node.get("kind") != NodeKind.GATE.value:
                    continue
                with self.subTest(graph=graph_id, node=node_id):
                    self.assertTrue(node.get("evaluatorRefs") or node.get("humanDecision"))

    def test_every_domain_evaluator_can_see_a_declared_producer_in_its_lineage(self):
        evidence_kinds = {
            evaluator.ref: evaluator.evidence_kind
            for evaluator in DOMAIN_EVALUATORS()
            if getattr(evaluator, "evidence_kind", "")
        }
        for graph_id, definition in all_definitions().items():
            entrypoint = next(iter(definition["entrypoints"]))
            plan = build_plan(definition, entrypoint=entrypoint)
            for node_id, node in definition["nodes"].items():
                if node.get("kind") != NodeKind.GATE.value:
                    continue
                produced = {
                    kind
                    for ancestor in plan.ancestors(node_id)
                    for kind in definition["nodes"][ancestor].get("produces", [])
                }
                for evaluator_ref in node.get("evaluatorRefs", []):
                    evidence_kind = evidence_kinds.get(evaluator_ref)
                    if evidence_kind is None:
                        continue
                    with self.subTest(graph=graph_id, gate=node_id, evaluator=evaluator_ref):
                        self.assertIn(evidence_kind, produced)

    def test_design_models_the_worked_example(self):
        definition = load_graph("design")
        start = definition["entrypoints"]["design.start"]
        self.assertEqual(start["inputs"], ["requirement_baseline"])
        self.assertEqual(start["requiresFacts"], ["requirement_gate_passed"])
        self.assertEqual(start["coordinator"]["requiredCapabilities"], ["design.coordinate"])
        self.assertEqual(start["coordinator"]["fallbackRoles"], ["tech_lead"])
        self.assertEqual(start["startNodes"], ["architecture"])
        self.assertEqual(
            definition["nodes"]["architecture"]["operation"], {"id": "architecture.design", "version": 3}
        )
        self.assertEqual(
            definition["nodes"]["security_review"]["executor"]["independentFrom"],
            ["architecture.producer"],
        )
        self.assertEqual(
            definition["nodes"]["design_gate"]["evaluatorRefs"],
            ["contract_schema_v1", "threat_model_review_v2"],
        )

    def test_the_security_side_entry_does_not_claim_the_whole_family(self):
        definition = load_graph("design")
        side = definition["entrypoints"]["design.security_review"]
        self.assertEqual(side["requiresFacts"], ["architecture_candidate_validated"])
        self.assertEqual(side["startNodes"], ["security_review"])
        self.assertEqual(side["exports"], ["security_review"])
        self.assertNotIn("design_acceptance", side["exports"])

    def test_the_resume_entry_demands_a_new_generation(self):
        resume = load_graph("design")["entrypoints"]["design.resume_review"]
        self.assertTrue(resume["resumePolicy"]["reExecutionRequiresNewGeneration"])
        self.assertTrue(resume["resumePolicy"]["allowedCheckpointKinds"])

    def test_implementation_joins_both_branches_with_all(self):
        definition = load_graph("implementation")
        join = definition["nodes"]["implementation_join"]["join"]
        self.assertEqual(join["semantics"], "all")
        self.assertEqual(sorted(join["inputs"]), ["backend_impl", "frontend_impl"])

    def test_verification_runs_three_branches_in_parallel(self):
        definition = load_graph("verification")
        join = definition["nodes"]["verification_join"]["join"]
        self.assertEqual(
            sorted(join["inputs"]), ["qa_execute", "regression_run", "security_review_verify"]
        )
        self.assertEqual(
            sorted(definition["entrypoints"]["verification.start"]["startNodes"]), sorted(join["inputs"])
        )


class DependencyLockTest(unittest.TestCase):
    """A library graph compiles only because its lock is complete."""

    def test_every_lock_pins_what_its_graph_needs(self):
        for graph_id in sorted(GRAPH_LIBRARY):
            definition = load_graph(graph_id)
            lock = dependency_lock_for(graph_id)
            artifact = compile_definition(definition, dependency_lock=lock)
            with self.subTest(graph=graph_id):
                self.assertTrue(artifact.closure["graph.planHash"])
                self.assertEqual(artifact.closure["dependencyLockHash"], artifact.dependency_lock_hash)
                for capability in {
                    name
                    for node in definition["nodes"].values()
                    for name in (node.get("executor") or {}).get("requiredCapabilities", [])
                }:
                    self.assertIn(f"capability.{capability}", artifact.closure)

    def test_the_lock_declares_the_compiler_and_schema(self):
        lock = dependency_lock_for("design")
        self.assertEqual(lock["schemaVersion"], 1)
        self.assertTrue(lock["compilerVersion"].startswith("polyforge-compiler/"))

    def test_evaluator_versions_are_known(self):
        for ref in EVALUATOR_VERSIONS:
            with self.subTest(evaluator=ref):
                self.assertGreaterEqual(EVALUATOR_VERSIONS[ref], 1)

    def test_a_graph_needing_a_child_version_reports_it(self):
        definition = copy.deepcopy(load_graph("verification"))
        definition["nodes"]["qa_execute"]["subgraph"] = {
            "graphId": "requirement",
            "entrypoint": "requirement.start",
        }
        lock = dependency_lock_for("verification")
        with self.assertRaises(PolyForgeError) as caught:
            compile_definition(definition, dependency_lock=lock, known_graphs={"requirement": load_graph("requirement")})
        self.assertEqual(caught.exception.code, ErrorCode.CONTRACT_INVALID)
        self.assertIn("requirement", str(caught.exception))


class DeterminismTest(unittest.TestCase):
    """AT-18 applied to the shipped graphs."""

    def test_two_compiles_of_the_shipped_graph_are_identical(self):
        for graph_id in sorted(GRAPH_LIBRARY):
            definition = load_graph(graph_id)
            lock = dependency_lock_for(graph_id)
            with self.subTest(graph=graph_id):
                first = compile_definition(definition, dependency_lock=lock)
                second = compile_definition(definition, dependency_lock=lock)
                self.assertEqual(first.plan_hash, second.plan_hash)
                self.assertEqual(first.dependency_lock_hash, second.dependency_lock_hash)
                self.assertEqual(first.plan, second.plan)

    def test_a_reserialised_graph_compiles_to_the_same_plan(self):
        for graph_id in sorted(GRAPH_LIBRARY):
            definition = load_graph(graph_id)
            reserialised = json.loads(json.dumps(definition))
            with self.subTest(graph=graph_id):
                self.assertEqual(
                    compile_definition(definition, dependency_lock=dependency_lock_for(graph_id)).plan_hash,
                    compile_definition(reserialised, dependency_lock=dependency_lock_for(graph_id)).plan_hash,
                )

    def test_the_plan_orders_every_node_exactly_once(self):
        for graph_id, definition in all_definitions().items():
            artifact = compile_definition(definition, dependency_lock=dependency_lock_for(graph_id))
            with self.subTest(graph=graph_id):
                self.assertEqual(sorted(artifact.plan["order"]), sorted(definition["nodes"]))
                self.assertEqual(len(artifact.plan["order"]), len(set(artifact.plan["order"])))


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
