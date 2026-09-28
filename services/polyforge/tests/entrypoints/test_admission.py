"""EntryPoint admission tests.

AT-23: a side entry may not skip a gate, and a resume is only legal from a declared
checkpoint. AT-24: capability matching is many-to-many, a fallback cannot substitute for a
capability, and coordinator and executor are separate concerns.
"""

from __future__ import annotations

import copy
import unittest

from polyforge.core.entrypoints.admission import AdmissionResult, admit, check_fact_provenance
from polyforge.core.errors import ErrorCode, PolyForgeError
from polyforge.graph_library import GRAPH_LIBRARY, load_graph

_DIGEST = "sha256:" + "ab" * 32


def _fact(source: str = "imp_9001", revision: str = "rev-7", digest: str = _DIGEST) -> dict:
    return {"source": source, "sourceRevision": revision, "contentHash": digest}


def _binding(subject: str, capabilities: list[str], **extra) -> dict:
    binding = {"subjectRef": subject, "capabilityContracts": {name: 1 for name in capabilities}}
    binding.update(extra)
    return binding


def _codes(result: AdmissionResult) -> set[str]:
    return {blocker.code for blocker in result.blockers}


class HappyPathTest(unittest.TestCase):
    """A well-formed start intent is admitted and reports what it resolved."""

    def test_design_start(self):
        definition = load_graph("design")
        result = admit(
            definition,
            "design.start",
            input_snapshot={"requirement_baseline": "rb-1"},
            required_facts={"requirement_gate_passed": _fact()},
            capability_bindings=[_binding("agent:designer-1", ["design.coordinate"])],
        )
        self.assertTrue(result.ok, [b.to_dict() for b in result.blockers])
        self.assertEqual(result.resolved_entrypoint["startNodes"], ["architecture"])
        self.assertEqual(result.coordinator_requirement["satisfiedBy"], "agent:designer-1")
        self.assertEqual(result.required_facts, ["requirement_gate_passed"])
        self.assertEqual(result.blockers, [])

    def test_every_library_graph_admits_its_main_entry(self):
        bindings = {
            "requirement.start": ["requirement.coordinate"],
            "design.start": ["design.coordinate"],
            "implementation.start": ["implementation.coordinate"],
            "verification.start": ["verification.coordinate"],
            "release.start": ["release.coordinate"],
        }
        for graph_id in sorted(GRAPH_LIBRARY):
            definition = load_graph(graph_id)
            key = f"{graph_id}.start"
            facts = {fact: _fact() for fact in definition["entrypoints"][key]["requiresFacts"]}
            snapshot = {name: f"value-{name}" for name in definition["entrypoints"][key]["inputs"]}
            with self.subTest(graph=graph_id):
                result = admit(
                    definition,
                    key,
                    input_snapshot=snapshot,
                    required_facts=facts,
                    capability_bindings=[_binding("agent:primary", bindings[key])],
                )
                self.assertTrue(result.ok, [b.to_dict() for b in result.blockers])


class InputTest(unittest.TestCase):
    """A declared input the snapshot does not carry blocks admission."""

    def test_missing_input(self):
        result = admit(
            load_graph("design"),
            "design.start",
            input_snapshot={},
            required_facts={"requirement_gate_passed": _fact()},
            capability_bindings=[_binding("agent:designer-1", ["design.coordinate"])],
        )
        self.assertFalse(result.ok)
        self.assertIn("ENTRYPOINT_INPUT_MISSING", _codes(result))
        self.assertIsNone(result.resolved_entrypoint)

    def test_unknown_entrypoint_raises_not_found(self):
        with self.assertRaises(PolyForgeError) as caught:
            admit(load_graph("design"), "design.nope", input_snapshot={})
        self.assertEqual(caught.exception.code, ErrorCode.NOT_FOUND)


class ProvenanceTest(unittest.TestCase):
    """AT-23: an imported prerequisite fact is only a fact with provenance."""

    def _admit(self, evidence):
        return admit(
            load_graph("design"),
            "design.security_review",
            input_snapshot={"architecture_spec": "a-1", "requirement_baseline": "rb-1"},
            required_facts={"architecture_candidate_validated": evidence},
            capability_bindings=[_binding("agent:security-1", ["security.review"])],
        )

    def test_provenanced_fact_is_accepted(self):
        result = self._admit(_fact())
        self.assertTrue(result.ok, [b.to_dict() for b in result.blockers])

    def test_a_bare_claim_is_refused(self):
        result = self._admit("architecture_candidate_validated: true")
        self.assertFalse(result.ok)
        self.assertIn("FACT_PROVENANCE_INVALID", _codes(result))

    def test_every_provenance_field_is_required(self):
        for missing in ("source", "sourceRevision", "contentHash"):
            evidence = _fact()
            del evidence[missing]
            with self.subTest(missing=missing):
                result = self._admit(evidence)
                self.assertIn("FACT_PROVENANCE_INVALID", _codes(result))
                self.assertIn(missing, result.blockers[0].message)

    def test_a_content_hash_that_is_not_a_digest_is_refused(self):
        result = self._admit(_fact(digest="latest"))
        self.assertIn("FACT_PROVENANCE_INVALID", _codes(result))

    def test_a_missing_fact_is_reported_separately(self):
        result = admit(
            load_graph("design"),
            "design.start",
            input_snapshot={"requirement_baseline": "rb-1"},
            required_facts={},
            capability_bindings=[_binding("agent:designer-1", ["design.coordinate"])],
        )
        self.assertIn("FACT_MISSING", _codes(result))

    def test_provenance_helper_reports_the_first_missing_field(self):
        self.assertIsNone(check_fact_provenance("f", _fact()))
        self.assertIn("sourceRevision", check_fact_provenance("f", {"source": "s", "contentHash": _DIGEST}))


class SideEntryTest(unittest.TestCase):
    """AT-23: entering downstream of a gate requires the gate's own fact."""

    def setUp(self):
        self.definition = copy.deepcopy(load_graph("release"))
        self.definition["entrypoints"]["release.post_check"] = {
            "key": "release.post_check",
            "inputs": ["deployment_receipt"],
            "requiresFacts": [],
            "coordinator": {"requiredCapabilities": ["release.coordinate"]},
            "startNodes": ["release_quality_gate"],
            "exports": ["release_quality_decision"],
        }

    def test_side_entry_without_the_gate_fact_is_refused(self):
        result = admit(
            self.definition,
            "release.post_check",
            input_snapshot={"deployment_receipt": "d-1"},
            capability_bindings=[_binding("agent:release-1", ["release.coordinate"])],
        )
        self.assertFalse(result.ok)
        self.assertIn("SIDE_ENTRY_GATE_BYPASS", _codes(result))

    def test_side_entry_with_a_self_asserted_gate_fact_is_still_refused(self):
        self.definition["entrypoints"]["release.post_check"]["requiresFacts"] = ["deployment_authorization"]
        result = admit(
            self.definition,
            "release.post_check",
            input_snapshot={"deployment_receipt": "d-1"},
            required_facts={"deployment_authorization": {"approved": True}},
            capability_bindings=[_binding("agent:release-1", ["release.coordinate"])],
        )
        self.assertIn("FACT_PROVENANCE_INVALID", _codes(result))
        self.assertFalse(result.ok)

    def test_side_entry_with_provenanced_gate_evidence_is_accepted(self):
        self.definition["entrypoints"]["release.post_check"]["requiresFacts"] = ["deployment_authorization"]
        result = admit(
            self.definition,
            "release.post_check",
            input_snapshot={"deployment_receipt": "d-1"},
            required_facts={"deployment_authorization": _fact(source="gov_apr_42")},
            capability_bindings=[_binding("agent:release-1", ["release.coordinate"])],
        )
        self.assertTrue(result.ok, [b.to_dict() for b in result.blockers])


class ResumeTest(unittest.TestCase):
    """AT-23 / REQ-ENTRY-03: resume only from a legal checkpoint, and re-execution is new."""

    def setUp(self):
        self.definition = load_graph("design")

    def _admit(self, **resume_context):
        return admit(
            self.definition,
            "design.resume_review",
            input_snapshot={"architecture_spec": "a-1"},
            required_facts={"architecture_candidate_validated": _fact()},
            capability_bindings=[_binding("agent:tech-lead-1", ["design.coordinate"])],
            resume_context=resume_context,
        )

    def test_a_legal_checkpoint_is_accepted(self):
        result = self._admit(
            checkpointKind="security_review_pending", completedNodeIds=["architecture"], invocationGeneration=1
        )
        self.assertTrue(result.ok, [b.to_dict() for b in result.blockers])

    def test_an_illegal_checkpoint_is_refused(self):
        result = self._admit(checkpointKind="whatever_the_caller_likes", invocationGeneration=1)
        self.assertFalse(result.ok)
        self.assertIn("RESUME_CHECKPOINT_ILLEGAL", _codes(result))

    def test_a_missing_checkpoint_kind_is_refused(self):
        self.assertIn("RESUME_CHECKPOINT_ILLEGAL", _codes(self._admit(invocationGeneration=1)))

    def test_re_execution_needs_a_new_generation(self):
        result = self._admit(
            checkpointKind="architecture_candidate_validated",
            completedNodeIds=["architecture"],
            invocationGeneration=0,
            reexecuting=True,
        )
        self.assertFalse(result.ok)
        self.assertIn("RESUME_GENERATION_REQUIRED", _codes(result))

    def test_a_gate_pass_is_never_inherited_into_a_new_resume(self):
        result = self._admit(
            checkpointKind="security_review_pending",
            completedNodeIds=["architecture", "design_gate"],
            invocationGeneration=0,
        )
        self.assertFalse(result.ok)
        self.assertIn("RESUME_INHERITS_GATE_PASS", _codes(result))

    def test_a_gate_pass_is_acceptable_once_a_new_generation_exists(self):
        result = self._admit(
            checkpointKind="security_review_pending",
            completedNodeIds=["design_gate"],
            invocationGeneration=1,
            reexecuting=True,
        )
        self.assertTrue(result.ok, [b.to_dict() for b in result.blockers])

    def test_claiming_a_node_this_graph_does_not_have_is_refused(self):
        result = self._admit(
            checkpointKind="security_review_pending", completedNodeIds=["not_a_node"], invocationGeneration=1
        )
        self.assertIn("RESUME_UNKNOWN_NODE", _codes(result))

    def test_an_entry_without_a_resume_policy_cannot_be_resumed(self):
        result = admit(
            self.definition,
            "design.start",
            input_snapshot={"requirement_baseline": "rb-1"},
            required_facts={"requirement_gate_passed": _fact()},
            capability_bindings=[_binding("agent:designer-1", ["design.coordinate"])],
            resume_context={"checkpointKind": "anything", "invocationGeneration": 1},
        )
        self.assertIn("RESUME_NOT_PERMITTED", _codes(result))


class CapabilityTest(unittest.TestCase):
    """AT-24: many-to-many matching, and a fallback never substitutes for a capability."""

    def _admit(self, bindings, key="design.start", definition=None):
        return admit(
            definition or load_graph("design"),
            key,
            input_snapshot={"requirement_baseline": "rb-1"},
            required_facts={"requirement_gate_passed": _fact()},
            capability_bindings=bindings,
        )

    def test_one_agent_may_serve_several_entrypoints(self):
        bindings = [_binding("agent:tech-lead-1", ["design.coordinate", "implementation.coordinate"])]
        self.assertTrue(self._admit(bindings).ok)
        result = self._admit(bindings, key="design.security_review", definition=load_graph("design"))
        # The same subject does not magically gain security.review.
        self.assertFalse(result.ok)
        self.assertIn("COORDINATOR_CAPABILITY_UNSATISFIED", _codes(result))

    def test_one_entrypoint_may_have_several_qualified_agents(self):
        first = self._admit([_binding("agent:a", ["design.coordinate"])])
        second = self._admit([_binding("agent:b", ["design.coordinate"])])
        self.assertTrue(first.ok)
        self.assertTrue(second.ok)
        self.assertEqual(first.coordinator_requirement["satisfiedBy"], "agent:a")
        self.assertEqual(second.coordinator_requirement["satisfiedBy"], "agent:b")

    def test_a_fallback_role_without_the_capability_is_blocked(self):
        result = self._admit([_binding("agent:qa-1", ["qa.execute"], role="tech_lead")])
        self.assertFalse(result.ok)
        self.assertIn("COORDINATOR_CAPABILITY_UNSATISFIED", _codes(result))
        self.assertIn("cannot substitute for a capability", result.blockers[0].message)

    def test_a_fallback_role_with_the_capability_is_accepted(self):
        result = self._admit([_binding("agent:tech-lead-7", ["design.coordinate"], role="tech_lead")])
        self.assertTrue(result.ok, [b.to_dict() for b in result.blockers])

    def test_a_binding_scoped_to_other_entrypoints_does_not_qualify(self):
        bindings = [_binding("agent:security-1", ["security.review"], entrypoints=["design.security_review"])]
        result = self._admit(bindings, key="design.security_review", definition=load_graph("design"))
        # It is admitted for the entrypoint it is bound to ...
        with_input = {"architecture_spec": "a-1", "requirement_baseline": "rb-1"}
        admitted = admit(
            load_graph("design"),
            "design.security_review",
            input_snapshot=with_input,
            required_facts={"architecture_candidate_validated": _fact()},
            capability_bindings=bindings,
        )
        self.assertTrue(admitted.ok, [b.to_dict() for b in admitted.blockers])
        # ... and not for one it is not bound to.
        self.assertFalse(result.ok)

    def test_no_bindings_at_all_is_blocked(self):
        result = self._admit([])
        self.assertIn("COORDINATOR_CAPABILITY_UNSATISFIED", _codes(result))

    def test_a_capability_list_binding_shape_is_also_accepted(self):
        bindings = [{"subjectRef": "agent:legacy", "capabilities": ["design.coordinate"]}]
        self.assertTrue(self._admit(bindings).ok)

    def test_coordinator_and_executor_are_separate(self):
        definition = load_graph("implementation")
        result = admit(
            definition,
            "implementation.start",
            input_snapshot={"design_acceptance": "da-1"},
            required_facts={"design_gate_passed": _fact()},
            capability_bindings=[_binding("agent:tech-lead-1", ["implementation.coordinate"])],
        )
        self.assertTrue(result.ok, [b.to_dict() for b in result.blockers])
        # The coordinator capability did not leak into the node executor requirements.
        self.assertNotIn("code.modify", result.coordinator_requirement["requiredCapabilities"])
        self.assertIn(
            "code.modify", definition["nodes"]["backend_impl"]["executor"]["requiredCapabilities"]
        )

    def test_blockers_carry_a_block_reason(self):
        result = self._admit([])
        self.assertEqual(result.blockers[0].reason, "BLOCKED_AUTHORIZATION")
        self.assertIn("detail", result.blockers[0].to_dict())

    def test_result_serialises_for_the_wire(self):
        result = self._admit([_binding("agent:designer-1", ["design.coordinate"])])
        body = result.to_dict()
        self.assertTrue(body["ok"])
        self.assertEqual(body["coordinatorRequirement"]["satisfiedBy"], "agent:designer-1")
        self.assertEqual(body["blockers"], [])
        self.assertEqual(body["requiredFacts"], ["requirement_gate_passed"])

    def test_a_malformed_snapshot_is_a_bad_request(self):
        with self.assertRaises(PolyForgeError) as caught:
            admit(load_graph("design"), "design.start", input_snapshot=["nope"])
        self.assertEqual(caught.exception.code, ErrorCode.BAD_REQUEST)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
