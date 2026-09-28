"""Validation tests: the structural and policy refusals of AT-18.

AT-18 requires that a bad schema, a dangling edge, a missing terminal outcome, an unbounded
loop, a missing gate, a weakened policy and a side entry missing its facts are all
rejected — and that one input always produces one result.
"""

from __future__ import annotations

import copy
import json
import unittest

from polyforge.core.compiler.validate import ISSUE_CODES, definition_hash, validate_definition
from polyforge.graph_library import GRAPH_LIBRARY, load_graph

def _codes(definition) -> set[str]:
    return {issue.code for issue in validate_definition(definition).issues}


def _bypass_graph() -> dict:
    """A gated branch and an ungated branch that meet in a short-circuiting join.

    ``work`` can only be released by passing ``guard``, but the join can also be satisfied
    by ``fast_path`` alone, which never touches the gate.
    """
    return {
        "schemaVersion": 1,
        "graphId": "bypass",
        "name": "bypass",
        "entrypoints": {
            "bypass.start": {
                "key": "bypass.start",
                "inputs": ["seed"],
                "requiresFacts": [],
                "coordinator": {"requiredCapabilities": ["design.coordinate"]},
                "startNodes": ["root"],
                "exports": ["merged"],
            }
        },
        "nodes": {
            "root": {
                "id": "root",
                "kind": "deterministic",
                "inputs": {"seed": "seed"},
                "produces": ["root_output"],
            },
            "work": {
                "id": "work",
                "kind": "deterministic",
                "inputs": {"from_root": "root_output"},
                "produces": ["work_output"],
            },
            "guard": {
                "id": "guard",
                "kind": "gate",
                "evaluatorRefs": ["some_check_v1"],
                "humanDecision": {"required": True, "semanticKind": "release_authorization"},
                "inputs": {"work": "work_output"},
                "produces": ["guard_decision"],
            },
            "fast_path": {
                "id": "fast_path",
                "kind": "deterministic",
                "inputs": {"from_root": "root_output"},
                "produces": ["fast_output"],
            },
            "merge": {
                "id": "merge",
                "kind": "deterministic",
                "join": {"semantics": "any", "inputs": ["guard", "fast_path"]},
                "produces": ["merged"],
            },
        },
        "edges": [
            {"from": "root", "to": "work"},
            {"from": "work", "to": "guard"},
            {"from": "root", "to": "fast_path"},
            {"from": "guard", "to": "merge"},
            {"from": "fast_path", "to": "merge"},
        ],
        "policyRefs": ["policy.independent_review_before_quality_gate"],
    }


class SchemaShapeTest(unittest.TestCase):
    """AT-18: a bad schema is refused instead of half-compiled."""

    def test_library_definitions_are_valid(self):
        for graph_id in sorted(GRAPH_LIBRARY):
            with self.subTest(graph=graph_id):
                report = validate_definition(load_graph(graph_id))
                self.assertTrue(report.ok, [i.to_dict() for i in report.issues if i.severity == "error"])

    def test_non_object_definition(self):
        report = validate_definition(["not", "a", "graph"])
        self.assertFalse(report.ok)
        self.assertIn("SCHEMA_INVALID", _codes(["not", "a", "graph"]))

    def test_unsupported_schema_version(self):
        definition = load_graph("design")
        definition["schemaVersion"] = 99
        self.assertIn("SCHEMA_VERSION_UNSUPPORTED", _codes(definition))

    def test_missing_nodes_or_edges(self):
        definition = load_graph("design")
        del definition["nodes"]
        definition["edges"] = {}
        codes = _codes(definition)
        self.assertIn("NODES_INVALID", codes)
        self.assertIn("EDGES_INVALID", codes)


class TopologyTest(unittest.TestCase):
    """AT-18: dangling edges, self loops, duplicate edges and unreachable nodes."""

    def test_dangling_edge(self):
        definition = load_graph("design")
        definition["edges"].append({"from": "architecture", "to": "nowhere"})
        self.assertIn("EDGE_ENDPOINT_UNKNOWN", _codes(definition))

    def test_self_loop(self):
        definition = load_graph("design")
        definition["edges"].append({"from": "design_gate", "to": "design_gate"})
        self.assertIn("EDGE_SELF_LOOP", _codes(definition))

    def test_duplicate_edge(self):
        definition = load_graph("design")
        definition["edges"].append({"from": "architecture", "to": "security_review"})
        self.assertIn("EDGE_DUPLICATE", _codes(definition))

    def test_unreachable_node(self):
        definition = load_graph("design")
        definition["nodes"]["orphan"] = {
            "id": "orphan",
            "kind": "agent_operation",
            "operation": {"id": "architecture.design", "version": 3},
            "executor": {"requiredCapabilities": ["architecture.design"]},
            "produces": ["orphan_output"],
        }
        definition["edges"].append({"from": "orphan", "to": "design_gate"})
        self.assertIn("NODE_UNREACHABLE", _codes(definition))

    def test_isolated_node(self):
        definition = load_graph("design")
        definition["nodes"]["floating"] = {
            "id": "floating",
            "kind": "deterministic",
            "produces": ["floating_output"],
        }
        self.assertIn("NODE_ISOLATED", _codes(definition))

    def test_node_id_must_match_its_key(self):
        definition = load_graph("design")
        definition["nodes"]["architecture"]["id"] = "architecture_v2"
        self.assertIn("NODE_ID_MISMATCH", _codes(definition))

    def test_duplicate_declared_node_id(self):
        definition = load_graph("design")
        definition["nodes"]["architecture_copy"] = copy.deepcopy(definition["nodes"]["architecture"])
        definition["nodes"]["architecture_copy"]["id"] = "architecture"
        definition["edges"].append({"from": "design_gate", "to": "architecture_copy"})
        self.assertIn("DUPLICATE_NODE_ID", _codes(definition))


class TerminationTest(unittest.TestCase):
    """AT-18: no terminal outcome means an unbounded cycle, which is refused."""

    def test_cycle_without_retry_budget(self):
        definition = load_graph("release")
        definition["edges"].append({"from": "release_quality_gate", "to": "deploy_authorization", "guard": "rework"})
        del definition["nodes"]["release_quality_gate"]["retryBudget"]
        codes = _codes(definition)
        self.assertIn("UNBOUNDED_CYCLE", codes)

    def test_declared_loop_is_accepted(self):
        definition = load_graph("release")
        definition["nodes"]["deploy_authorization"]["retryBudget"] = {"maxAttempts": 2}
        definition["edges"].append({"from": "release_quality_gate", "to": "deploy_authorization", "guard": "rework"})
        report = validate_definition(definition)
        self.assertTrue(report.ok, [i.to_dict() for i in report.issues if i.severity == "error"])

    def test_retry_budget_above_ceiling(self):
        definition = load_graph("design")
        definition["nodes"]["architecture"]["retryBudget"]["maxAttempts"] = 99
        codes = _codes(definition)
        self.assertIn("RETRY_BUDGET_INVALID", codes)
        self.assertIn("POLICY_WEAKENED", codes)


class FactFlowTest(unittest.TestCase):
    """AT-18: inputs, outputs and preconditions must name facts somebody can supply."""

    def test_input_from_a_node_that_is_not_an_ancestor(self):
        definition = load_graph("design")
        # design_acceptance is produced downstream, so an upstream node cannot consume it.
        definition["nodes"]["security_review"]["inputs"]["acceptance"] = "design_acceptance"
        self.assertIn("NODE_INPUT_UNDECLARED", _codes(definition))

    def test_input_nobody_produces(self):
        definition = load_graph("design")
        definition["nodes"]["security_review"]["inputs"]["ghost"] = "not_produced_anywhere"
        self.assertIn("NODE_INPUT_UNDECLARED", _codes(definition))

    def test_precondition_without_a_producer(self):
        definition = load_graph("design")
        definition["nodes"]["security_review"]["requires"] = ["unprovenanced_precondition"]
        self.assertIn("NODE_REQUIRES_UNDECLARED", _codes(definition))

    def test_two_producers_for_one_fact(self):
        definition = load_graph("design")
        definition["nodes"]["design_gate"]["produces"] = ["security_review"]
        self.assertIn("NODE_FACT_PRODUCER_AMBIGUOUS", _codes(definition))

    def test_entry_export_nobody_produces(self):
        definition = load_graph("design")
        definition["entrypoints"]["design.start"]["exports"].append("promised_but_never_built")
        self.assertIn("ENTRYPOINT_EXPORT_UNDECLARED", _codes(definition))

    def test_entry_start_node_must_exist(self):
        definition = load_graph("design")
        definition["entrypoints"]["design.start"]["startNodes"] = ["missing_node"]
        codes = _codes(definition)
        self.assertIn("ENTRYPOINT_START_UNKNOWN", codes)
        self.assertIn("NODE_UNREACHABLE", codes)


class JoinSemanticsTest(unittest.TestCase):
    """AT-18: join semantics must be legal and must not ignore an incoming edge."""

    def setUp(self):
        self.definition = load_graph("implementation")
        self.definition["nodes"]["implementation_join"]["join"] = {
            "semantics": "quorum",
            "quorum": 5,
            "inputs": ["backend_impl", "frontend_impl"],
        }

    def test_quorum_above_input_count(self):
        self.assertIn("JOIN_QUORUM_INVALID", _codes(self.definition))

    def test_quorum_below_one(self):
        self.definition["nodes"]["implementation_join"]["join"]["quorum"] = 0
        self.assertIn("JOIN_QUORUM_INVALID", _codes(self.definition))

    def test_unknown_join_semantics(self):
        self.definition["nodes"]["implementation_join"]["join"]["semantics"] = "most"
        self.assertIn("JOIN_SEMANTICS_INVALID", _codes(self.definition))

    def test_join_ignoring_an_incoming_edge_is_a_bypass(self):
        self.definition["nodes"]["implementation_join"]["join"]["inputs"] = ["backend_impl"]
        self.assertIn("JOIN_INPUTS_MISMATCH", _codes(self.definition))

    def test_quorum_within_bounds_is_accepted(self):
        self.definition["nodes"]["implementation_join"]["join"]["quorum"] = 2
        report = validate_definition(self.definition)
        self.assertTrue(report.ok, [i.to_dict() for i in report.issues if i.severity == "error"])


class GateTest(unittest.TestCase):
    """AT-18: a missing gate, a missing permission gate and a self-approving gate are refused."""

    def test_gate_without_evaluator_or_human_decision(self):
        definition = load_graph("design")
        del definition["nodes"]["design_gate"]["evaluatorRefs"]
        del definition["nodes"]["design_gate"]["humanDecision"]
        self.assertIn("EVALUATOR_REF_MISSING", _codes(definition))

    def test_external_effect_without_permission_gate(self):
        definition = load_graph("release")
        definition["edges"] = [{"from": "deploy", "to": "release_quality_gate"}]
        definition["entrypoints"]["release.start"]["startNodes"] = ["deploy"]
        codes = _codes(definition)
        self.assertIn("MISSING_PERMISSION_GATE", codes)
        self.assertIn("POLICY_UNSATISFIED", codes)

    def test_side_entry_skipping_a_gate(self):
        definition = load_graph("release")
        definition["entrypoints"]["release.post_check"] = {
            "key": "release.post_check",
            "inputs": ["deployment_receipt"],
            "requiresFacts": [],
            "coordinator": {"requiredCapabilities": ["release.coordinate"]},
            "startNodes": ["release_quality_gate"],
            "exports": ["release_quality_decision"],
        }
        self.assertIn("SIDEB_ENTRY_GATE_BYPASS", _codes(definition))

    def test_side_entry_declaring_the_gate_fact_is_accepted(self):
        definition = load_graph("release")
        definition["entrypoints"]["release.post_check"] = {
            "key": "release.post_check",
            "inputs": ["deployment_receipt"],
            "requiresFacts": ["deployment_authorization"],
            "coordinator": {"requiredCapabilities": ["release.coordinate"]},
            "startNodes": ["release_quality_gate"],
            "exports": ["release_quality_decision"],
        }
        report = validate_definition(definition)
        self.assertTrue(report.ok, [i.to_dict() for i in report.issues if i.severity == "error"])

    def test_side_entry_faking_the_gate_fact_at_runtime_is_caught_by_admission(self):
        # The static check passes because the entry declares the fact; only the fact's
        # provenance can stop the forgery, which is what admission enforces.
        definition = load_graph("release")
        definition["entrypoints"]["release.post_check"] = {
            "key": "release.post_check",
            "inputs": ["deployment_receipt"],
            "requiresFacts": ["deployment_authorization"],
            "coordinator": {"requiredCapabilities": ["release.coordinate"]},
            "startNodes": ["release_quality_gate"],
            "exports": ["release_quality_decision"],
        }
        self.assertTrue(validate_definition(definition).ok)

    def test_short_circuit_join_cannot_bypass_a_mandatory_gate(self):
        report = validate_definition(_bypass_graph())
        self.assertEqual(report.code_set(), {"MANDATORY_GATE_BYPASS"})
        self.assertFalse(report.ok)

    def test_all_join_cannot_bypass_a_mandatory_gate(self):
        graph = _bypass_graph()
        graph["nodes"]["merge"]["join"]["semantics"] = "all"
        self.assertNotIn("MANDATORY_GATE_BYPASS", _codes(graph))

    def test_human_decision_may_not_declare_an_executor(self):
        definition = load_graph("design")
        definition["nodes"]["design_gate"]["executor"] = {"requiredCapabilities": ["design.coordinate"]}
        self.assertIn("POLICY_WEAKENED", _codes(definition))


class PolicyBaselineTest(unittest.TestCase):
    """AT-18: a graph may not weaken the baseline policy set."""

    def test_unknown_policy_ref(self):
        definition = load_graph("design")
        definition["policyRefs"] = ["policy.made_up_here"]
        self.assertIn("POLICY_UNKNOWN_REF", _codes(definition))

    def test_empty_policy_refs(self):
        definition = load_graph("design")
        definition["policyRefs"] = []
        self.assertIn("POLICY_UNSATISFIED", _codes(definition))

    def test_version_downgrade(self):
        definition = load_graph("design")
        definition["policyRefs"] = ["policy.independent_review_before_quality_gate@1"]
        self.assertIn("POLICY_WEAKENED", _codes(definition))

    def test_weakening_is_an_error_not_a_warning(self):
        definition = load_graph("design")
        definition["policyRefs"] = ["policy.independent_review_before_quality_gate@1"]
        report = validate_definition(definition)
        weakening = [issue for issue in report.issues if issue.code == "POLICY_WEAKENED"]
        self.assertTrue(weakening)
        self.assertTrue(all(issue.severity == "error" for issue in weakening))

    def test_allow_first_resolution_order_is_refused(self):
        definition = load_graph("design")
        definition["policyResolution"] = {"order": ["allow", "require_approval", "deny"], "noMatch": "deny"}
        self.assertIn("POLICY_WEAKENED", _codes(definition))

    def test_no_match_must_be_deny(self):
        definition = load_graph("design")
        definition["policyResolution"] = {"order": ["deny", "require_approval", "allow"], "noMatch": "allow"}
        self.assertIn("POLICY_WEAKENED", _codes(definition))

    def test_canonical_resolution_order_is_accepted(self):
        definition = load_graph("design")
        definition["policyResolution"] = {"order": ["deny", "require_approval", "allow"], "noMatch": "deny"}
        self.assertTrue(validate_definition(definition).ok)

    def test_automatic_gate_without_an_independent_reviewer(self):
        definition = load_graph("design")
        del definition["nodes"]["design_gate"]["humanDecision"]
        del definition["nodes"]["security_review"]["executor"]["independentFrom"]
        self.assertIn("POLICY_UNSATISFIED", _codes(definition))

    def test_automatic_gate_with_an_independent_reviewer_is_accepted(self):
        definition = load_graph("design")
        del definition["nodes"]["design_gate"]["humanDecision"]
        report = validate_definition(definition)
        self.assertTrue(report.ok, [i.to_dict() for i in report.issues if i.severity == "error"])


class SubgraphTest(unittest.TestCase):
    """AT-18: child recursion depth and fan-out are bounded and references must resolve."""

    def _parent(self, child_graph_id: str, entrypoint: str = "requirement.start", *, bind_child_input: bool = True) -> dict:
        definition = load_graph("verification")
        definition["nodes"]["qa_execute"]["subgraph"] = {
            "graphId": child_graph_id,
            "entrypoint": entrypoint,
        }
        definition["nodes"]["qa_execute"]["retryBudget"] = {"maxAttempts": 2}
        if bind_child_input:
            definition["nodes"]["qa_execute"]["inputs"]["intake"] = "change_intake"
            definition["entrypoints"]["verification.start"]["inputs"].append("change_intake")
        return definition

    def test_unresolved_subgraph(self):
        self.assertIn("SUBGRAPH_REFERENCE_UNRESOLVED", _codes(self._parent("not_a_published_graph")))

    def test_unknown_child_entrypoint(self):
        self.assertIn("SUBGRAPH_ENTRYPOINT_UNKNOWN", _codes(self._parent("requirement", "requirement.nope")))

    def test_a_child_input_the_parent_never_binds_is_refused(self):
        self.assertIn(
            "SUBGRAPH_INPUT_UNSATISFIED", _codes(self._parent("requirement", bind_child_input=False))
        )

    def test_self_recursion(self):
        self.assertIn("SUBGRAPH_RECURSION", _codes(self._parent("verification")))

    def test_subgraph_without_invocation_cap(self):
        definition = self._parent("requirement")
        del definition["nodes"]["qa_execute"]["retryBudget"]
        self.assertIn("SUBGRAPH_BUDGET_UNDECLARED", _codes(definition))

    def test_resolvable_child_is_accepted(self):
        report = validate_definition(self._parent("requirement"))
        self.assertTrue(report.ok, [i.to_dict() for i in report.issues if i.severity == "error"])

    def test_recursion_beyond_the_depth_ceiling(self):
        chain, known = _chain_graphs(4)
        self.assertIn("SUBGRAPH_DEPTH_EXCEEDED", validate_definition(chain, known_graphs=known).code_set())

    def test_chain_at_the_depth_ceiling_is_accepted(self):
        chain, known = _chain_graphs(3)
        report = validate_definition(chain, known_graphs=known)
        self.assertNotIn("SUBGRAPH_DEPTH_EXCEEDED", report.code_set())

    def test_child_graph_cycle_is_refused(self):
        left, known = _chain_graphs(4)
        known["chain_c"]["nodes"]["child"]["subgraph"] = {"graphId": "chain_b", "entrypoint": "chain_b.start"}
        self.assertIn("SUBGRAPH_RECURSION", validate_definition(left, known_graphs=known).code_set())


def _chain_graphs(depth: int) -> tuple[dict, dict[str, dict]]:
    """``depth`` graphs, each invoking the next one through a bounded subgraph node."""
    names = [f"chain_{letter}" for letter in "abcdefgh"]
    known: dict[str, dict] = {}
    for index, name in enumerate(names[:depth]):
        last = index == depth - 1
        nodes: dict = {
            "entry": {
                "id": "entry",
                "kind": "deterministic",
                "produces": ["entry_output"],
                "retryBudget": {"maxAttempts": 1},
            }
        }
        if not last:
            nodes["child"] = {
                "id": "child",
                "kind": "subgraph",
                "subgraph": {"graphId": names[index + 1], "entrypoint": f"{names[index + 1]}.start"},
                "retryBudget": {"maxAttempts": 1},
            }
        else:
            nodes["leaf"] = {"id": "leaf", "kind": "deterministic", "produces": ["leaf_output"]}
        known[name] = {
            "schemaVersion": 1,
            "graphId": name,
            "name": name,
            "entrypoints": {
                f"{name}.start": {
                    "key": f"{name}.start",
                    "inputs": [],
                    "requiresFacts": [],
                    "coordinator": {"requiredCapabilities": ["design.coordinate"]},
                    "startNodes": ["entry"],
                    "exports": ["leaf_output"] if last else [],
                }
            },
            "nodes": nodes,
            "edges": [{"from": "entry", "to": "child"}] if not last else [{"from": "entry", "to": "leaf"}],
            "policyRefs": ["policy.deny_precedence"],
        }
    return known[names[0]], known


class IssueReportingTest(unittest.TestCase):
    """AT-18 / REQ-UI-02: issues are complete, addressable and stable."""

    def test_every_problem_is_collected_not_just_the_first(self):
        definition = load_graph("design")
        definition["schemaVersion"] = 7
        definition["edges"].append({"from": "architecture", "to": "ghost"})
        definition["nodes"]["security_review"]["requires"] = ["unprovable"]
        report = validate_definition(definition)
        codes = report.code_set()
        self.assertGreaterEqual(
            codes,
            {"SCHEMA_VERSION_UNSUPPORTED", "EDGE_ENDPOINT_UNKNOWN", "NODE_REQUIRES_UNDECLARED"},
        )

    def test_every_issue_carries_an_addressable_path(self):
        definition = load_graph("design")
        definition["edges"].append({"from": "architecture", "to": "ghost"})
        report = validate_definition(definition)
        for issue in report.issues:
            self.assertTrue(issue.path.startswith("$"), issue)
            self.assertIn(issue.code, ISSUE_CODES)

    def test_layout_is_excluded_from_the_definition_hash(self):
        definition = load_graph("design")
        moved = json.loads(json.dumps(definition))
        moved["nodes"]["architecture"]["layout"] = {"x": 10, "y": 20}
        moved["nodes"]["design_gate"]["layout"] = {"x": 1, "y": 2}
        self.assertEqual(definition_hash(definition), definition_hash(moved))
        self.assertTrue(validate_definition(moved).ok)
        warnings = [i for i in validate_definition(moved).issues if i.severity == "warning"]
        self.assertIn("LAYOUT_IN_DEFINITION", {issue.code for issue in warnings})

    def test_report_is_deterministic_for_the_same_input(self):
        definition = load_graph("implementation")
        first = validate_definition(definition).to_dict()
        second = validate_definition(json.loads(json.dumps(definition))).to_dict()
        self.assertEqual(first, second)

    def test_report_round_trips(self):
        definition = load_graph("design")
        report = validate_definition(definition)
        from polyforge.core.compiler.validate import ValidationReport

        self.assertEqual(ValidationReport.from_dict(report.to_dict()).to_dict(), report.to_dict())

    def test_a_report_can_be_stamped_with_its_draft(self):
        report = validate_definition(load_graph("design"))
        stamped = report.for_draft("drf_1", 7)
        self.assertEqual(stamped.to_dict()["draftId"], "drf_1")
        self.assertEqual(stamped.to_dict()["revision"], 7)
        self.assertEqual(stamped.definition_hash, report.definition_hash)
        # The unstamped report stays unstamped, so a compiler-side report never invents a draft.
        self.assertNotIn("draftId", report.to_dict())


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
