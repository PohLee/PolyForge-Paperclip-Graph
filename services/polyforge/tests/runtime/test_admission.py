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
    make_engine,
    node_state,
    work_order_request,
)
from polyforge.core import errors
from polyforge.core.state import GraphRunStatus, NodeStatus


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


if __name__ == "__main__":
    unittest.main()
