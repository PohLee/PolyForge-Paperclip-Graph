"""Compilation tests: determinism, the pinned closure, and bounded child invocation.

AT-18 requires that the same input compiles to the same hash. AT-19 requires that the
closure is complete enough that a run cannot drift when defaults, policy or the registry
change. AT-22 requires bounded fan-out with a stable child identity and no duplicate child
on replay.
"""

from __future__ import annotations

import copy
import json
import unittest

from polyforge import COMPILER_VERSION, SCHEMA_VERSION
from polyforge.core.compiler.compile import (
    CHILD_INVOCATION_DOMAIN,
    EFFECT_KEY_DOMAIN,
    compile_definition,
    dependency_lock_for,
    graph_loops,
    required_pins,
    step_id_for,
    strongly_connected_components,
    topological_order,
)
from polyforge.core.compiler.validate import validate_definition
from polyforge.core.errors import ErrorCode, PolyForgeError
from polyforge.graph_library import (
    CAPABILITY_VERSIONS,
    EVALUATOR_VERSIONS,
    GRAPH_LIBRARY,
    all_definitions,
    dependency_lock_for as library_lock_for,
    load_graph,
)


def _reordered(definition: dict) -> dict:
    """Re-serialise with the object keys in the opposite order at every level."""
    return json.loads(
        json.dumps(definition, sort_keys=False),
        object_pairs_hook=lambda pairs: dict(reversed(pairs)),
    )


class DeterminismTest(unittest.TestCase):
    """AT-18: same input, same hash — twice, and under a different JSON key order."""

    def test_compiling_twice_is_byte_identical(self):
        for graph_id in sorted(GRAPH_LIBRARY):
            with self.subTest(graph=graph_id):
                definition = load_graph(graph_id)
                lock = library_lock_for(graph_id)
                first = compile_definition(definition, dependency_lock=lock)
                second = compile_definition(definition, dependency_lock=lock)
                self.assertEqual(first.plan_hash, second.plan_hash)
                self.assertEqual(first.dependency_lock_hash, second.dependency_lock_hash)
                self.assertEqual(first.closure, second.closure)
                self.assertEqual(first.to_dict(), second.to_dict())

    def test_json_key_order_does_not_change_the_hash(self):
        for graph_id in sorted(GRAPH_LIBRARY):
            with self.subTest(graph=graph_id):
                definition = load_graph(graph_id)
                lock = library_lock_for(graph_id)
                straight = compile_definition(definition, dependency_lock=lock)
                permuted = compile_definition(_reordered(definition), dependency_lock=lock)
                self.assertEqual(straight.plan_hash, permuted.plan_hash)
                self.assertEqual(straight.definition_hash, permuted.definition_hash)
                self.assertEqual(straight.plan["order"], permuted.plan["order"])

    def test_dependency_lock_key_order_does_not_change_the_hash(self):
        definition = load_graph("design")
        lock = library_lock_for("design")
        self.assertEqual(
            compile_definition(definition, dependency_lock=lock).dependency_lock_hash,
            compile_definition(definition, dependency_lock=_reordered(lock)).dependency_lock_hash,
        )

    def test_topological_order_ties_break_on_node_id(self):
        nodes = {"zulu": {}, "alpha": {}, "mike": {}}
        self.assertEqual(topological_order(nodes, [("zulu", "mike")]), ["alpha", "zulu", "mike"])

    def test_a_cycle_becomes_one_contiguous_block(self):
        nodes = {"a": {}, "b": {}, "c": {}, "d": {}, "e": {}}
        edges = [("a", "b"), ("b", "c"), ("c", "a"), ("c", "d"), ("d", "e")]
        order = topological_order(nodes, edges)
        self.assertEqual(order, ["a", "b", "c", "d", "e"])
        self.assertEqual(strongly_connected_components(nodes, edges)[0], ["a", "b", "c"])
        self.assertEqual(graph_loops(nodes, edges), [["a", "b", "c"]])

    def test_plan_reports_no_volatile_field(self):
        artifact = compile_definition(load_graph("design"), dependency_lock=library_lock_for("design"))
        for banned in ("generatedAt", "createdAt", "updatedAt", "startedAt", "draftId", "revision"):
            self.assertNotIn(banned, artifact.plan)
            self.assertNotIn(banned, artifact.plan["nodes"]["architecture"])


class ClosureTest(unittest.TestCase):
    """AT-19 / REQ-GRAPH-06: the closure pins everything a run depends on."""

    def test_closure_pins_every_identity_class(self):
        artifact = compile_definition(load_graph("implementation"), dependency_lock=library_lock_for("implementation"))
        closure = artifact.closure
        self.assertEqual(closure["schemaVersion"], str(SCHEMA_VERSION))
        self.assertEqual(closure["compilerVersion"], COMPILER_VERSION)
        self.assertEqual(closure["graph.id"], "implementation")
        self.assertEqual(closure["graph.definitionHash"], artifact.definition_hash)
        self.assertEqual(closure["graph.planHash"], artifact.plan_hash)
        self.assertEqual(closure["dependencyLockHash"], artifact.dependency_lock_hash)
        self.assertEqual(closure["operation.code.modify"], "2")
        self.assertEqual(closure["capability.code.modify"], "2")
        self.assertEqual(closure["capability.implementation.review"], "1")
        self.assertEqual(closure["evaluator.review_findings_check_v1"], "1")
        self.assertEqual(closure["policy.policy.deny_precedence"], "policy.deny_precedence@1")
        self.assertEqual(closure["policy.policy.budget_and_authority_ceilings"], "policy.budget_and_authority_ceilings@1")

    def test_closure_covers_every_operation_and_capability_in_the_graph(self):
        definition = load_graph("verification")
        artifact = compile_definition(definition, dependency_lock=library_lock_for("verification"))
        for node in definition["nodes"].values():
            operation = node.get("operation")
            if operation:
                self.assertIn(f"operation.{operation['id']}", artifact.closure)
            executor = node.get("executor")
            for capability in (executor or {}).get("requiredCapabilities", []):
                self.assertIn(f"capability.{capability}", artifact.closure)
            for ref in node.get("evaluatorRefs", []):
                self.assertIn(f"evaluator.{ref}", artifact.closure)

    def test_changing_a_capability_version_changes_the_lock_and_the_closure(self):
        definition = load_graph("design")
        bumped = dict(CAPABILITY_VERSIONS)
        bumped["architecture.design"] = 3
        lock = dependency_lock_for(
            definition, capability_versions=bumped, evaluator_versions=EVALUATOR_VERSIONS
        )
        artifact = compile_definition(definition, dependency_lock=lock)
        self.assertEqual(artifact.closure["capability.architecture.design"], "3")
        baseline = compile_definition(definition, dependency_lock=library_lock_for("design"))
        self.assertNotEqual(artifact.plan_hash, baseline.plan_hash)

    def test_an_unpinned_capability_is_refused_rather_than_defaulted(self):
        definition = load_graph("design")
        lock = library_lock_for("design")
        del lock["capabilities"]["architecture.design"]
        with self.assertRaises(PolyForgeError) as caught:
            compile_definition(definition, dependency_lock=lock)
        self.assertEqual(caught.exception.code, ErrorCode.CONTRACT_INVALID)
        self.assertIn("architecture.design", str(caught.exception))

    def test_an_unpinned_evaluator_is_refused(self):
        definition = load_graph("design")
        lock = library_lock_for("design")
        del lock["evaluators"]["threat_model_review_v2"]
        with self.assertRaises(PolyForgeError) as caught:
            compile_definition(definition, dependency_lock=lock)
        self.assertEqual(caught.exception.code, ErrorCode.CONTRACT_INVALID)

    def test_a_policy_pinned_below_the_baseline_is_refused_by_the_compiler_too(self):
        definition = copy.deepcopy(load_graph("design"))
        definition["policyRefs"] = ["policy.deny_precedence@0"]
        lock = library_lock_for("design")
        lock["policies"] = {"policy.deny_precedence": 0}
        with self.assertRaises(PolyForgeError) as caught:
            compile_definition(definition, dependency_lock=lock)
        self.assertEqual(caught.exception.code, ErrorCode.CONTRACT_INVALID)

    def test_required_pins_reports_what_a_lock_must_contain(self):
        release_pins = required_pins(load_graph("release"))
        self.assertEqual(release_pins["operations"], set())
        # A permission gate has no executor, and an entrypoint coordinator is an admission
        # condition rather than an execution contract, so neither is pinned into the plan.
        self.assertEqual(release_pins["capabilities"], set())
        self.assertIn("deployment_verification_v1", release_pins["evaluators"])
        self.assertIn("policy.deny_precedence", release_pins["policies"])
        self.assertEqual(release_pins["graphs"], set())

        design_pins = required_pins(load_graph("design"))
        self.assertEqual(design_pins["operations"], {"architecture.design", "security.review"})
        self.assertEqual(design_pins["capabilities"], {"architecture.design", "security.review"})


class EffectIdentityTest(unittest.TestCase):
    """REQ-NFR-01: the external effect identity is stable across compiles."""

    def test_step_id_is_stable_and_contains_no_run_identity(self):
        self.assertEqual(step_id_for("release", "deploy"), "release.deploy")
        first = compile_definition(load_graph("release"), dependency_lock=library_lock_for("release"))
        second = compile_definition(load_graph("release"), dependency_lock=library_lock_for("release"))
        identity = first.plan["nodes"]["deploy"]["effectIdentity"]
        self.assertEqual(identity, second.plan["nodes"]["deploy"]["effectIdentity"])
        self.assertEqual(identity["domain"], EFFECT_KEY_DOMAIN)
        self.assertEqual(identity["stepId"], "release.deploy")

    def test_only_external_effect_nodes_carry_an_effect_identity(self):
        artifact = compile_definition(load_graph("release"), dependency_lock=library_lock_for("release"))
        self.assertIn("effectIdentity", artifact.plan["nodes"]["deploy"])
        self.assertNotIn("effectIdentity", artifact.plan["nodes"]["deploy_authorization"])


class SubgraphExpansionTest(unittest.TestCase):
    """AT-22: bounded fan-out produces a stable child identity and a no-duplicate replay rule."""

    def _parent(self) -> tuple[dict, dict]:
        definition = copy.deepcopy(load_graph("verification"))
        definition["nodes"]["qa_execute"]["subgraph"] = {
            "graphId": "requirement",
            "entrypoint": "requirement.start",
        }
        definition["nodes"]["qa_execute"]["retryBudget"] = {"maxAttempts": 3}
        definition["nodes"]["qa_execute"]["inputs"]["intake"] = "change_intake"
        definition["entrypoints"]["verification.start"]["inputs"].append("change_intake")
        return definition, {"requirement": load_graph("requirement")}

    def test_child_contract_is_expanded(self):
        definition, known = self._parent()
        lock = dependency_lock_for(definition, capability_versions=CAPABILITY_VERSIONS,
                                   evaluator_versions=EVALUATOR_VERSIONS, graph_versions={"requirement": 4})
        artifact = compile_definition(definition, dependency_lock=lock, known_graphs=known)
        plan = artifact.plan["subgraphPlan"]["qa_execute"]
        self.assertEqual(plan["childGraphId"], "requirement")
        self.assertEqual(plan["entrypoint"], "requirement.start")
        self.assertEqual(plan["childGraphVersionPin"], "4")
        self.assertIn("change_intake", plan["contract"]["requiredInputs"])
        self.assertIn("change_intake", plan["contract"]["suppliedInputs"])
        self.assertEqual(plan["contract"]["missingInputs"], [])
        self.assertIn("requirement_acceptance", plan["contract"]["expectedExports"])
        self.assertEqual(plan["invocationGenerationCap"], 3)
        self.assertEqual(plan["childIdentity"]["domain"], CHILD_INVOCATION_DOMAIN)
        self.assertIn("parentNodeId", plan["childIdentity"])

    def test_an_unpinned_child_graph_is_refused(self):
        definition, known = self._parent()
        lock = dependency_lock_for(definition, capability_versions=CAPABILITY_VERSIONS,
                                   evaluator_versions=EVALUATOR_VERSIONS, graph_versions={"requirement": 4})
        del lock["graphs"]
        with self.assertRaises(PolyForgeError) as caught:
            compile_definition(definition, dependency_lock=lock, known_graphs=known)
        self.assertEqual(caught.exception.code, ErrorCode.CONTRACT_INVALID)

    def test_an_unknown_child_graph_is_refused(self):
        definition, _ = self._parent()
        lock = dependency_lock_for(definition, capability_versions=CAPABILITY_VERSIONS,
                                   evaluator_versions=EVALUATOR_VERSIONS, graph_versions={"requirement": 4})
        with self.assertRaises(PolyForgeError) as caught:
            compile_definition(definition, dependency_lock=lock, known_graphs={})
        self.assertEqual(caught.exception.code, ErrorCode.CONTRACT_INVALID)


class ArtifactShapeTest(unittest.TestCase):
    """The artifact mirrors ``CompileArtifact`` in the TypeScript protocol."""

    def test_round_trip(self):
        from polyforge.core.compiler.compile import CompileArtifact

        artifact = compile_definition(load_graph("design"), dependency_lock=library_lock_for("design"))
        restored = CompileArtifact.from_dict(artifact.to_dict())
        self.assertEqual(restored.to_dict(), artifact.to_dict())
        self.assertEqual(restored, artifact)

    def test_plan_carries_every_node_and_edge(self):
        definition = load_graph("verification")
        artifact = compile_definition(definition, dependency_lock=library_lock_for("verification"))
        self.assertEqual(sorted(artifact.plan["nodes"]), sorted(definition["nodes"]))
        self.assertEqual(len(artifact.plan["edges"]), len(definition["edges"]))
        self.assertEqual(sorted(artifact.plan["entrypoints"]), sorted(definition["entrypoints"]))
        self.assertEqual(
            artifact.plan["entrypoints"]["verification.start"]["startNodes"],
            sorted(definition["entrypoints"]["verification.start"]["startNodes"]),
        )

    def test_every_library_graph_validates_before_it_compiles(self):
        for graph_id, definition in all_definitions().items():
            with self.subTest(graph=graph_id):
                report = validate_definition(definition)
                self.assertTrue(report.ok, [i.to_dict() for i in report.issues])
                artifact = compile_definition(definition, dependency_lock=library_lock_for(graph_id))
                self.assertEqual(artifact.definition_hash, report.definition_hash)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
