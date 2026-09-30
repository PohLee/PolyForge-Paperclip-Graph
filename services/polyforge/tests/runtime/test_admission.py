"""Admission: idempotency, scope isolation, routing, pinning, and determinism.

Maps to AT-02 (replayed start intent), AT-03 and AT-29 (cross-scope refusal), and AT-18
(compile determinism, tampered draft).
"""

from __future__ import annotations

import copy
import unittest

from services.polyforge.tests.runtime.fixtures import (
    ENTRYPOINT,
    QA_NODE,
    SCOPE_A,
    SCOPE_B,
    definition,
    grant_capability,
    make_engine,
    node_state,
    work_order_request,
)
from polyforge.core import errors
from polyforge.core.runtime.engine import RuntimeEngine
from polyforge.core.state import GraphRunStatus, NodeStatus
from polyforge.core.runtime.planner import build_plan
from polyforge.core.store import loads
from polyforge.graph_library.design import definition as design_definition
from polyforge.graph_library.implementation import definition as implementation_definition
from polyforge.graph_library.requirement import definition as requirement_definition


def _count(db: object, table: str) -> int:
    return int(db.query(f"SELECT COUNT(*) AS n FROM {table}")[0]["n"])  # type: ignore[attr-defined]


class IdempotentAdmissionTests(unittest.TestCase):
    """AT-02: 100 replays of the same start intent create exactly one run."""

    def setUp(self) -> None:
        self.engine, self.db, self.clock = make_engine()

    def test_one_hundred_replays_produce_one_run(self) -> None:
        first = self.engine.admit_work_order(work_order_request())
        for _ in range(99):
            replay = self.engine.admit_work_order(work_order_request())
            self.assertEqual(replay["runId"], first["runId"])
        self.assertEqual(_count(self.db, "graph_runs"), 1)
        self.assertEqual(_count(self.db, "work_orders"), 1)
        self.assertEqual(len(self.engine.list_runs(scope=SCOPE_A)), 1)

    def test_a_replay_does_not_move_the_state_version_or_the_event_sequence(self) -> None:
        first = self.engine.admit_work_order(work_order_request())
        replay = self.engine.admit_work_order(work_order_request())
        self.assertEqual(replay["stateVersion"], first["stateVersion"])
        self.assertEqual(replay["eventSequence"], first["eventSequence"])

    def test_the_same_intent_with_a_different_payload_is_a_conflict(self) -> None:
        self.engine.admit_work_order(work_order_request())
        with self.assertRaises(errors.PolyForgeError) as caught:
            self.engine.admit_work_order(
                work_order_request(inputSnapshot={"candidate_artifacts": "a different candidate"})
            )
        self.assertEqual(caught.exception.code, errors.ErrorCode.IDEMPOTENCY_CONFLICT)
        self.assertEqual(_count(self.db, "graph_runs"), 1)

    def test_a_different_entrypoint_is_a_different_identity(self) -> None:
        graph = copy.deepcopy(definition())
        graph["entrypoints"]["verification.retry"] = {
            "key": "verification.retry",
            "inputs": ["candidate_artifacts"],
            "requiresFacts": [],
            "coordinator": {"requiredCapabilities": []},
            "startNodes": [QA_NODE],
            "exports": ["qa_report"],
        }
        first = self.engine.admit_work_order(work_order_request())
        second = self.engine.admit_work_order(
            work_order_request(entrypoint="verification.retry", graph=graph)
        )
        self.assertNotEqual(first["runId"], second["runId"])
        self.assertEqual(_count(self.db, "graph_runs"), 2)

    def test_ordinary_work_creates_no_run_at_all(self) -> None:
        # A non-engineering entry point is the routing decision, and it is made before anything
        # is written: no work order, no run, no events.
        with self.assertRaises(errors.PolyForgeError) as caught:
            self.engine.admit_work_order(work_order_request(entrypoint="task.triage"))
        self.assertEqual(caught.exception.code, errors.ErrorCode.CONTRACT_INVALID)
        self.assertIn("ordinary work continues on the platform", caught.exception.message)
        self.assertEqual(_count(self.db, "graph_runs"), 0)
        self.assertEqual(_count(self.db, "work_orders"), 0)
        self.assertEqual(_count(self.db, "domain_events"), 0)

    def test_a_work_order_without_a_root_issue_is_refused(self) -> None:
        request = work_order_request()
        request.pop("rootIssueRef")
        with self.assertRaises(errors.PolyForgeError) as caught:
            self.engine.admit_work_order(request)
        self.assertEqual(caught.exception.code, errors.ErrorCode.BAD_REQUEST)
        self.assertEqual(_count(self.db, "graph_runs"), 0)

    def test_a_request_without_a_scope_is_refused(self) -> None:
        request = work_order_request()
        request.pop("scope")
        with self.assertRaises(errors.PolyForgeError) as caught:
            self.engine.admit_work_order(request)
        self.assertEqual(caught.exception.code, errors.ErrorCode.SCOPE_VIOLATION)

    def test_a_graph_with_no_policy_rules_authorises_nothing(self) -> None:
        graph = definition()
        graph["policyRefs"] = ["policy.deny_precedence@1"]
        with self.assertRaises(errors.PolyForgeError) as caught:
            # No rules pinned on the request either: naming a policy grants nothing.
            self.engine.admit_work_order(work_order_request(graph=graph, policyRules=[]))
        self.assertEqual(caught.exception.code, errors.ErrorCode.CONTRACT_INVALID)
        self.assertIn("deny-first", caught.exception.message)
        self.assertEqual(_count(self.db, "graph_runs"), 0)

    def test_a_graph_with_no_policy_refs_at_all_authorises_nothing(self) -> None:
        graph = definition()
        graph["policyRefs"] = []
        with self.assertRaises(errors.PolyForgeError) as caught:
            self.engine.admit_work_order(work_order_request(graph=graph))
        self.assertEqual(caught.exception.code, errors.ErrorCode.CONTRACT_INVALID)
        self.assertEqual(_count(self.db, "graph_runs"), 0)

    def test_an_entrypoint_requiring_facts_demands_verifiable_provenance(self) -> None:
        graph = definition()
        graph["entrypoints"][ENTRYPOINT]["requiresFacts"] = ["requirement_baseline"]
        with self.assertRaises(errors.PolyForgeError) as caught:
            self.engine.admit_work_order(
                work_order_request(
                    graph=graph,
                    requiredFacts={"requirement_baseline": {"source": "issue-1"}},
                )
            )
        self.assertEqual(caught.exception.code, errors.ErrorCode.CONTRACT_INVALID)
        self.assertIn("verifiable provenance", caught.exception.message)
        self.assertEqual(_count(self.db, "graph_runs"), 0)

    def test_an_entrypoint_with_satisfied_facts_is_admitted(self) -> None:
        from services.polyforge.tests.runtime.fixtures import digest

        graph = definition()
        graph["entrypoints"][ENTRYPOINT]["requiresFacts"] = ["requirement_baseline"]
        snapshot = self.engine.admit_work_order(
            work_order_request(
                graph=graph,
                requiredFacts={
                    "requirement_baseline": {
                        "source": "issue-1",
                        "sourceRevision": "r3",
                        "contentHash": digest("requirement-baseline"),
                    }
                },
            )
        )
        self.assertEqual(snapshot["status"], GraphRunStatus.ACTIVE)

    def test_a_fact_without_a_verifiable_digest_is_refused(self) -> None:
        graph = definition()
        graph["entrypoints"][ENTRYPOINT]["requiresFacts"] = ["requirement_baseline"]
        with self.assertRaises(errors.PolyForgeError) as caught:
            self.engine.admit_work_order(
                work_order_request(
                    graph=graph,
                    requiredFacts={
                        "requirement_baseline": {
                            "source": "issue-1",
                            "sourceRevision": "r3",
                            "contentHash": "sha256:not-a-real-digest",
                        }
                    },
                )
            )
        self.assertEqual(caught.exception.code, errors.ErrorCode.CONTRACT_INVALID)
        self.assertEqual(_count(self.db, "graph_runs"), 0)

    def test_admission_requires_a_qualified_coordinator(self) -> None:
        # The entry point declares ``verification.coordinate``; with no binding for it the
        # admission is refused and no run exists.
        self.db.execute(
            "UPDATE capability_bindings SET revoked = 1 WHERE capability_ref = ?",
            ("verification.coordinate",),
        )
        with self.assertRaises(errors.PolyForgeError) as caught:
            self.engine.admit_work_order(work_order_request())
        self.assertEqual(caught.exception.code, errors.ErrorCode.CONTRACT_INVALID)
        self.assertIn("coordinator capability", caught.exception.message)
        self.assertEqual(_count(self.db, "graph_runs"), 0)


class ScopeIsolationTests(unittest.TestCase):
    """AT-03 and AT-29: cross-company reads and writes are refused."""

    def setUp(self) -> None:
        self.engine, self.db, self.clock = make_engine()
        self.run_id = self.engine.admit_work_order(work_order_request())["runId"]

    def test_a_read_from_another_company_is_refused(self) -> None:
        with self.assertRaises(errors.PolyForgeError) as caught:
            self.engine.get_run(self.run_id, scope=SCOPE_B)
        self.assertEqual(caught.exception.code, errors.ErrorCode.SCOPE_VIOLATION)

    def test_listing_is_scoped(self) -> None:
        self.assertEqual(len(self.engine.list_runs(scope=SCOPE_A)), 1)
        self.assertEqual(self.engine.list_runs(scope=SCOPE_B), [])

    def test_events_are_scoped(self) -> None:
        with self.assertRaises(errors.PolyForgeError) as caught:
            self.engine.list_events(self.run_id, scope=SCOPE_B)
        self.assertEqual(caught.exception.code, errors.ErrorCode.SCOPE_VIOLATION)

    def test_a_claim_from_another_company_is_refused_and_writes_nothing(self) -> None:
        from services.polyforge.tests.runtime.fixtures import claim_request

        with self.assertRaises(errors.PolyForgeError) as caught:
            self.engine.claim(
                claim_request(run_id=self.run_id, node_id=QA_NODE, subject="intruder", scope=SCOPE_B)
            )
        self.assertEqual(caught.exception.code, errors.ErrorCode.SCOPE_VIOLATION)
        self.assertEqual(_count(self.db, "execution_attempts"), 0)

    def test_a_submit_from_another_company_is_refused(self) -> None:
        from services.polyforge.tests.runtime.fixtures import artifact, claim_request, envelope

        attempt = self.engine.claim(
            claim_request(run_id=self.run_id, node_id=QA_NODE, subject="sub-qa")
        )
        with self.assertRaises(errors.PolyForgeError) as caught:
            self.engine.submit_artifacts(
                envelope(
                    run_id=self.run_id,
                    node_id=QA_NODE,
                    attempt_id=attempt["attemptId"],
                    lease_epoch=attempt["leaseEpoch"],
                    scope=SCOPE_B,
                    payload={"artifacts": [artifact("qa_report", "x")]},
                )
            )
        self.assertEqual(caught.exception.code, errors.ErrorCode.SCOPE_VIOLATION)
        self.assertEqual(_count(self.db, "artifacts"), 0)

    def test_a_body_that_names_another_scope_is_refused(self) -> None:
        from services.polyforge.tests.runtime.fixtures import claim_request, envelope

        attempt = self.engine.claim(
            claim_request(run_id=self.run_id, node_id=QA_NODE, subject="sub-qa")
        )
        forged = envelope(
            run_id=self.run_id,
            node_id=QA_NODE,
            attempt_id=attempt["attemptId"],
            lease_epoch=attempt["leaseEpoch"],
            payload={"artifacts": []},
        )
        forged["scope"] = dict(SCOPE_B)
        with self.assertRaises(errors.PolyForgeError) as caught:
            self.engine.submit_artifacts(forged)
        self.assertEqual(caught.exception.code, errors.ErrorCode.SCOPE_VIOLATION)

    def test_current_refuses_an_actor_from_another_company(self) -> None:
        with self.assertRaises(errors.PolyForgeError) as caught:
            self.engine.current(
                self.run_id, actor={"scope": SCOPE_B, "subjectRef": "sub-qa"}
            )
        self.assertEqual(caught.exception.code, errors.ErrorCode.SCOPE_VIOLATION)

    def test_an_unknown_run_id_is_not_found_rather_than_scoped(self) -> None:
        # An id that exists in no scope is a plain 404. Reporting it as a scope violation
        # would claim a scope check happened when nothing was there to check.
        with self.assertRaises(errors.PolyForgeError) as caught:
            self.engine.current(
                "run_does_not_exist", actor={"scope": SCOPE_A, "subjectRef": "sub-qa"}
            )
        self.assertEqual(caught.exception.code, errors.ErrorCode.NOT_FOUND)


class AdmissionShapeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine, self.db, self.clock = make_engine()

    def test_admission_releases_only_the_start_nodes(self) -> None:
        snapshot = self.engine.admit_work_order(work_order_request())
        self.assertEqual(snapshot["status"], GraphRunStatus.ACTIVE)
        self.assertEqual(node_state(snapshot, QA_NODE)["status"], NodeStatus.READY)
        self.assertEqual(node_state(snapshot, "security_review")["status"], NodeStatus.PENDING)
        self.assertEqual(node_state(snapshot, "review_gate")["status"], NodeStatus.PENDING)

    def test_the_run_pins_its_plan_and_policy(self) -> None:
        snapshot = self.engine.admit_work_order(work_order_request())
        pins = snapshot["pins"]
        self.assertTrue(pins["planHash"].startswith("sha256:"))
        self.assertTrue(pins["definitionHash"].startswith("sha256:"))
        self.assertTrue(pins["policyHash"].startswith("sha256:"))
        self.assertTrue(pins["policyRules"])
        self.assertEqual(pins["schemaVersion"], "1")

    def test_admission_emits_the_accepted_event_and_a_work_intent(self) -> None:
        snapshot = self.engine.admit_work_order(work_order_request())
        events = [e["type"] for e in self.engine.list_events(snapshot["runId"], scope=SCOPE_A)]
        self.assertEqual(events[0], "pf.work_order.accepted")
        self.assertIn("pf.node.ready", events)
        intents = self.engine.drain_outbox()
        self.assertEqual([i["kind"] for i in intents], ["work.unit.ensure"])
        self.assertEqual(intents[0]["nodeId"], QA_NODE)

    def test_event_sequence_is_monotonic_per_run(self) -> None:
        snapshot = self.engine.admit_work_order(work_order_request())
        events = self.engine.list_events(snapshot["runId"], scope=SCOPE_A)
        self.assertEqual([e["seq"] for e in events], sorted(e["seq"] for e in events))
        self.assertEqual(len({e["seq"] for e in events}), len(events))
        after = self.engine.list_events(snapshot["runId"], after=events[0]["seq"], scope=SCOPE_A)
        self.assertEqual(after[0]["seq"], events[1]["seq"])

    def test_a_checkpoint_is_written_at_admission(self) -> None:
        snapshot = self.engine.admit_work_order(work_order_request())
        rows = self.db.query(
            "SELECT * FROM graph_checkpoints WHERE run_id = ?", (snapshot["runId"],)
        )
        self.assertEqual(len(rows), 1)
        self.assertEqual(str(rows[0]["plan_hash"]), snapshot["pins"]["planHash"])

    def test_the_same_definition_admitted_twice_under_different_intents_has_one_plan_hash(self) -> None:
        first = self.engine.admit_work_order(work_order_request(start_intent_id="intent-a"))
        second = self.engine.admit_work_order(work_order_request(start_intent_id="intent-b"))
        self.assertEqual(first["pins"]["planHash"], second["pins"]["planHash"])
        self.assertNotEqual(first["runId"], second["runId"])

    def test_a_tampered_draft_produces_a_different_plan_hash(self) -> None:
        tampered = definition()
        tampered["nodes"][QA_NODE]["operation"] = {"id": "verification.qa", "version": 2}
        first = self.engine.admit_work_order(work_order_request(start_intent_id="intent-a"))
        second = self.engine.admit_work_order(
            work_order_request(start_intent_id="intent-b", graph=tampered)
        )
        self.assertNotEqual(first["pins"]["planHash"], second["pins"]["planHash"])


class RunWorkspacePinTests(unittest.TestCase):
    """Repository pins are exact, run-scoped inputs to code.modify plans."""

    @staticmethod
    def plan():
        return build_plan(implementation_definition(), entrypoint="implementation.start")

    @staticmethod
    def requirement(commit: str = "a" * 40) -> dict[str, object]:
        return {
            "mode": "read_write",
            "repositories": [{"repoRef": "https://example.invalid/repo.git", "baseRef": "refs/heads/main", "commit": commit}],
            "requireReadOnlyForReviewer": False,
        }

    def test_code_modify_plan_requires_a_workspace_pin(self) -> None:
        with self.assertRaises(errors.PolyForgeError) as caught:
            self.engine_requirement(None)
        self.assertEqual(caught.exception.code, errors.ErrorCode.CONTRACT_INVALID)
        self.assertIn("code.modify", caught.exception.message)

    def test_exact_pin_is_overlaid_on_every_code_node_and_changes_plan_hash(self) -> None:
        plan = self.plan()
        pinned = self.engine_requirement(self.requirement("A" * 40))
        requirement = self.requirement()
        self.assertNotEqual(pinned.plan_hash, plan.plan_hash)
        for node_id in ("backend_impl", "frontend_impl"):
            self.assertEqual(pinned.node(node_id).workspace_requirement, requirement)
        self.assertIsNone(pinned.node("implementation_review").workspace_requirement)

    def test_unpinned_or_malformed_commit_is_rejected(self) -> None:
        for commit in (None, "a" * 39, "g" * 40):
            with self.subTest(commit=commit), self.assertRaises(errors.PolyForgeError) as caught:
                value = self.requirement()
                value["repositories"] = [{"repoRef": "repo", "baseRef": "main", "commit": commit}]
                self.engine_requirement(value)
            self.assertEqual(caught.exception.code, errors.ErrorCode.CONTRACT_INVALID)

    def test_unknown_fields_and_multiple_repositories_fail_closed(self) -> None:
        extra = self.requirement()
        extra["ambientAuthority"] = True
        with self.assertRaises(errors.PolyForgeError):
            self.engine_requirement(extra)
        multiple = self.requirement()
        multiple["repositories"] = multiple["repositories"] * 2
        with self.assertRaises(errors.PolyForgeError):
            self.engine_requirement(multiple)

    def test_a_repository_pin_cannot_be_attached_to_a_non_code_graph(self) -> None:
        plan = build_plan(definition(), entrypoint=ENTRYPOINT)
        with self.assertRaises(errors.PolyForgeError) as caught:
            RuntimeEngine._apply_run_workspace_requirement(plan, self.requirement())
        self.assertEqual(caught.exception.code, errors.ErrorCode.CONTRACT_INVALID)

    def engine_requirement(self, value):
        return RuntimeEngine._apply_run_workspace_requirement(self.plan(), value)


class RequiredFactSourceTests(unittest.TestCase):
    """A fact receipt resolves only from a completed same-project source Gate."""

    def setUp(self) -> None:
        self.engine, self.db, self.clock = make_engine()
        grant_capability(self.db, "user-anna", "requirement.coordinate", scope=SCOPE_A)
        grant_capability(self.db, "user-anna", "design.coordinate", scope=SCOPE_A)

    def _create_requirement_run(self) -> str:
        source = self.engine.admit_work_order(
            work_order_request(
                start_intent_id="source-requirement-run",
                graphId="requirement",
                entrypoint="requirement.start",
                graph=requirement_definition(),
                inputSnapshot={"change_intake": "Implement requested feature"},
            )
        )
        return str(source["runId"])

    def _complete_source_gate(self, run_id: str) -> str:
        output_digest = "sha256:" + "d" * 64
        self.db.execute(
            "UPDATE node_executions SET status = ?, output_digest = ? WHERE run_id = ?",
            (NodeStatus.PASSED, output_digest, run_id),
        )
        self.db.execute(
            "UPDATE graph_runs SET status = ?, state_version = state_version + 1 WHERE run_id = ?",
            (GraphRunStatus.COMPLETED, run_id),
        )
        return output_digest

    def _admit_design(self, run_id: str, **overrides):
        request = work_order_request(
            start_intent_id="design-from-requirement",
            graphId="design",
            entrypoint="design.start",
            graph=design_definition(),
            inputSnapshot={"requirement_baseline": {"artifact": "requirement-baseline"}},
            requiredFactSources={"requirement_acceptance": {"sourceRunId": run_id}},
        )
        request.update(overrides)
        return self.engine.admit_work_order(request)

    def test_core_resolves_and_persists_verified_source_run_provenance(self) -> None:
        source_run_id = self._create_requirement_run()
        digest_value = self._complete_source_gate(source_run_id)

        target = self._admit_design(source_run_id)
        stored = self.db.query_one(
            "SELECT required_facts_json FROM graph_runs WHERE run_id = ?", (target["runId"],)
        )
        fact = loads(stored["required_facts_json"], {})["requirement_acceptance"]
        source = self.db.query_one("SELECT plan_hash, state_version FROM graph_runs WHERE run_id = ?", (source_run_id,))
        self.assertEqual(fact["source"], f"graph-run:{source_run_id}#requirement_gate")
        self.assertEqual(fact["sourceRevision"], f"{source['plan_hash']}@{source['state_version']}")
        self.assertEqual(fact["contentHash"], digest_value)

    def test_an_active_source_run_is_not_a_gate_receipt(self) -> None:
        source_run_id = self._create_requirement_run()
        with self.assertRaises(errors.PolyForgeError) as caught:
            self._admit_design(source_run_id)
        self.assertEqual(caught.exception.code, errors.ErrorCode.CONTRACT_INVALID)
        self.assertIn("COMPLETED", caught.exception.message)
        self.assertEqual(_count(self.db, "graph_runs"), 1)

    def test_a_source_run_from_another_project_is_not_visible_as_a_receipt(self) -> None:
        source_run_id = self._create_requirement_run()
        self._complete_source_gate(source_run_id)
        request = work_order_request(
            start_intent_id="cross-project-design",
            graphId="design",
            entrypoint="design.start",
            graph=design_definition(),
            scope=SCOPE_B,
            inputSnapshot={"requirement_baseline": "baseline"},
            requiredFactSources={"requirement_acceptance": {"sourceRunId": source_run_id}},
        )
        grant_capability(self.db, "user-anna", "design.coordinate", scope=SCOPE_B)
        with self.assertRaises(errors.PolyForgeError) as caught:
            self.engine.admit_work_order(request)
        self.assertEqual(caught.exception.code, errors.ErrorCode.CONTRACT_INVALID)
        self.assertIn("same company and project", caught.exception.message)
        self.assertEqual(_count(self.db, "graph_runs"), 1)

    def test_required_fact_source_does_not_accept_caller_supplied_hashes(self) -> None:
        source_run_id = self._create_requirement_run()
        self._complete_source_gate(source_run_id)
        with self.assertRaises(errors.PolyForgeError) as caught:
            self._admit_design(
                source_run_id,
                requiredFacts={
                    "requirement_acceptance": {
                        "source": "forged",
                        "sourceRevision": "r1",
                        "contentHash": "sha256:" + "0" * 64,
                    }
                },
            )
        self.assertEqual(caught.exception.code, errors.ErrorCode.CONTRACT_INVALID)


if __name__ == "__main__":
    unittest.main()
