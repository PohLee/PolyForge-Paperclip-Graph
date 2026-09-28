"""Policy baseline tests.

AT-18: a graph may not weaken the baseline policy set, and the baseline itself is a versioned
artefact the compiler pins into a run closure rather than a set of conventions.
"""

from __future__ import annotations

import unittest

from polyforge.core.compiler.policy_catalog import (
    CEILINGS,
    DEFAULT_POLICY_REF_VERSIONS,
    POLICY_CATALOG_VERSION,
    baseline_refs,
    catalog_versions,
    check_definition_policy,
    dominators_from,
    is_known_ref,
    ref_version,
    resolve_pins,
)
from polyforge.core.compiler.validate import ISSUE_CODES, validate_definition
from polyforge.graph_library import load_graph


def _codes(definition, **kwargs) -> set[str]:
    return {violation.code for violation in check_definition_policy(definition, **kwargs)}


class CatalogTest(unittest.TestCase):
    """The catalogue is a versioned, append-only artefact."""

    def test_the_catalogue_names_itself(self):
        self.assertEqual(POLICY_CATALOG_VERSION, "polyforge-policy-catalog/1.0.0")

    def test_every_baseline_ref_has_a_positive_version(self):
        self.assertEqual(set(baseline_refs()), set(DEFAULT_POLICY_REF_VERSIONS))
        for ref, version in catalog_versions().items():
            with self.subTest(ref=ref):
                self.assertGreaterEqual(version, 1)
                self.assertTrue(is_known_ref(ref))
                self.assertEqual(ref_version(ref), version)

    def test_the_baseline_covers_the_four_required_controls(self):
        refs = set(baseline_refs())
        self.assertIn("policy.independent_review_before_quality_gate", refs)
        self.assertIn("policy.permission_gate_before_side_effect", refs)
        self.assertIn("policy.human_only_decision_for_gates", refs)
        self.assertIn("policy.budget_and_authority_ceilings", refs)
        self.assertIn("policy.deny_precedence", refs)

    def test_resolve_pins_never_returns_below_the_baseline(self):
        definition = {"policyRefs": ["policy.independent_review_before_quality_gate@1"]}
        self.assertEqual(
            resolve_pins(definition)["policy.independent_review_before_quality_gate"],
            ref_version("policy.independent_review_before_quality_gate"),
        )

    def test_resolve_pins_accepts_a_newer_version(self):
        definition = {"policyRefs": ["policy.deny_precedence@7"]}
        self.assertEqual(resolve_pins(definition)["policy.deny_precedence"], 7)

    def test_resolve_pins_ignores_an_unknown_ref(self):
        self.assertEqual(resolve_pins({"policyRefs": ["policy.unknown"]}), catalog_versions())


class CeilingTest(unittest.TestCase):
    """Every ceiling is a refusal, not advice."""

    def test_quorum_above_the_ceiling(self):
        definition = load_graph("verification")
        definition["nodes"]["verification_join"]["join"] = {
            "semantics": "quorum",
            "quorum": CEILINGS["maxQuorumSize"] + 1,
            "inputs": ["qa_execute", "regression_run", "security_review_verify"],
        }
        self.assertIn("POLICY_WEAKENED", _codes(definition))

    def test_entry_fan_out_above_the_ceiling(self):
        definition = load_graph("verification")
        definition["entrypoints"]["verification.start"]["startNodes"] = [
            f"node_{index}" for index in range(CEILINGS["maxEntryStartNodes"] + 1)
        ]
        self.assertIn("POLICY_WEAKENED", _codes(definition))

    def test_a_declared_child_depth_above_the_ceiling(self):
        definition = load_graph("verification")
        definition["nodes"]["qa_execute"]["subgraph"] = {
            "graphId": "requirement",
            "entrypoint": "requirement.start",
            "depth": CEILINGS["maxSubgraphDepth"] + 1,
        }
        self.assertIn("POLICY_WEAKENED", _codes(definition))

    def test_at_the_ceiling_is_fine(self):
        definition = load_graph("verification")
        definition["nodes"]["qa_execute"]["retryBudget"] = {"maxAttempts": CEILINGS["maxAttemptsPerNode"]}
        self.assertNotIn("POLICY_WEAKENED", _codes(definition))

    def test_authorization_ttl_is_declared_in_the_catalogue(self):
        self.assertIn("authorizationTtlSeconds", CEILINGS)


class ShippedGraphsTest(unittest.TestCase):
    """The library graphs sit at or above the baseline, not merely near it."""

    def test_no_library_graph_weakens_a_baseline(self):
        for graph_id in ("requirement", "design", "implementation", "verification", "release"):
            with self.subTest(graph=graph_id):
                self.assertEqual(_codes(load_graph(graph_id)), set())

    def test_a_custom_catalogue_can_be_injected(self):
        strict = {
            ref: {**spec, "requirement": {"kind": "ceilings", "ceilings": {**CEILINGS, "maxAttemptsPerNode": 1}}}
            for ref, spec in _specs().items()
            if ref == "policy.budget_and_authority_ceilings"
        }
        strict["policy.deny_precedence"] = _specs()["policy.deny_precedence"]
        self.assertIn("POLICY_WEAKENED", _codes(load_graph("design"), catalog=strict))
        self.assertNotIn("POLICY_WEAKENED", _codes(load_graph("design")))

    def test_a_non_mapping_definition_yields_only_a_schema_issue(self):
        report = validate_definition("not a definition")
        self.assertEqual({issue.code for issue in report.issues}, {"SCHEMA_INVALID"})


class IssueCodeContractTest(unittest.TestCase):
    """The HTTP layer surfaces these codes verbatim, so the list has to stay closed."""

    def test_every_policy_code_is_declared_in_the_validator_catalogue(self):
        declared = set(ISSUE_CODES)
        for code in ("POLICY_UNKNOWN_REF", "POLICY_WEAKENED", "POLICY_UNSATISFIED"):
            self.assertIn(code, declared)

    def test_the_declared_codes_are_unique(self):
        self.assertEqual(len(ISSUE_CODES), len(set(ISSUE_CODES)))

    def test_every_emitted_code_is_declared(self):
        for graph_id in ("requirement", "design", "implementation", "verification", "release"):
            for report in (validate_definition(load_graph(graph_id)),):
                for issue in report.issues:
                    with self.subTest(graph=graph_id, code=issue.code):
                        self.assertIn(issue.code, ISSUE_CODES)


class DominatorTest(unittest.TestCase):
    """The dominator helper the permission and bypass rules share."""

    def test_dominators_from_a_single_start(self):
        nodes = {"a": {}, "b": {}, "c": {}}
        edges = [("a", "b"), ("b", "c")]
        dom = dominators_from(nodes, edges, ["a"])
        self.assertEqual(dom["a"], {"a"})
        self.assertEqual(dom["b"], {"a", "b"})
        self.assertEqual(dom["c"], {"a", "b", "c"})

    def test_dominators_with_parallel_branches(self):
        nodes = {"a": {}, "b": {}, "c": {}, "d": {}}
        edges = [("a", "b"), ("a", "c"), ("b", "d"), ("c", "d")]
        dom = dominators_from(nodes, edges, ["a"])
        self.assertEqual(dom["d"], {"a", "d"})

    def test_unreachable_nodes_are_absent(self):
        self.assertEqual(dominators_from({"a": {}, "b": {}}, [], ["a"]), {"a": {"a"}})

    def test_a_cycle_still_terminates(self):
        nodes = {"a": {}, "b": {}}
        dom = dominators_from(nodes, [("a", "b"), ("b", "a")], ["a"])
        # The start node is its own root, so nothing inside its loop dominates it; the other
        # member is dominated by the root.
        self.assertEqual(dom["a"], {"a"})
        self.assertEqual(dom["b"], {"a", "b"})


def _specs() -> dict:
    """The shipped specs, read back through the public helper."""
    from polyforge.core.compiler import policy_catalog

    return {ref: dict(spec) for ref, spec in policy_catalog._BY_REF.items()}  # noqa: SLF001


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
