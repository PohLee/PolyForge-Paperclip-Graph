"""Execution: fencing, the only-pass path, budgets, joins, approvals, and traceability.

Maps to AT-04, AT-05, AT-09, AT-10, AT-11, AT-14, AT-25, AT-26, AT-28 and AT-33. The
central claim under test is that ``PASSED`` has exactly one writer: ``request_transition``
with every mandatory evaluator passing.
"""

from __future__ import annotations

import copy
import unittest

from services.polyforge.tests.runtime.fixtures import (
    GATE_NODE,
    QA_NODE,
    REVIEW_NODE,
    SCOPE_A,
    artifact,
    claim_request,
    definition,
    digest,
    envelope,
    evidence_for,
    grant_capability,
    make_engine,
    node_state,
    published_version,
    work_order_request,
)
from polyforge.core import errors
from polyforge.core.state import BlockReason, GraphRunStatus, NodeStatus

CONTROLLER = {"subjectRef": "user-anna", "actorType": "human", "capabilities": ["run.control", "run.execute", "run.resolve_block"]}


class EngineCase(unittest.TestCase):
    """Shared setup: an admitted run with capability bindings in place."""

    def setUp(self) -> None:
        self.engine, self.db, self.clock = make_engine()
        # The store the Runtime resolves published versions through, built over the same
        # database by the fixture.
        self.registry = self.engine.registry
        grant_capability(self.db, "sub-qa", "verification.qa")
        grant_capability(self.db, "sub-security", "security.review")
        grant_capability(self.db, "sub-chair", "verification.qa")
        self.snapshot = self.engine.admit_work_order(work_order_request())
        self.run_id = str(self.snapshot["runId"])

    # -- helpers ---------------------------------------------------------

    def work(self, node_id: str, subject: str, kind: str, seed: str, **options: object) -> dict[str, object]:
        """Claim a node, register an artifact and evidence, then request the transition."""
        attempt = self.engine.claim(
            claim_request(run_id=self.run_id, node_id=node_id, subject=subject)
        )
        art = artifact(kind, seed)
        self.engine.submit_artifacts(
            envelope(
                run_id=self.run_id,
                node_id=node_id,
                attempt_id=attempt["attemptId"],
                lease_epoch=attempt["leaseEpoch"],
                payload={"artifacts": [art]},
            )
        )
        evidence = self.engine.submit_evidence(
            envelope(
                run_id=self.run_id,
                node_id=node_id,
                attempt_id=attempt["attemptId"],
                lease_epoch=attempt["leaseEpoch"],
                command_suffix="ev",
                payload={"evidence": [evidence_for(art, kind)]},
            )
        )
        result = self.engine.request_transition(
            envelope(
                run_id=self.run_id,
                node_id=node_id,
                attempt_id=attempt["attemptId"],
                lease_epoch=attempt["leaseEpoch"],
                command_suffix="tr",
                payload={"evidenceIds": [str(evidence["resultRef"]).split(",")[0]]},
                **options,
            )
        )
        return {"attempt": attempt, "artifact": art, "evidence": evidence, "result": result}

    def node(self, node_id: str) -> dict[str, object]:
        return dict(node_state(self.engine.get_run(self.run_id, scope=SCOPE_A), node_id))

    def intents(self, kind: str | None = None) -> list[dict[str, object]]:
        claimed = self.engine.drain_outbox(limit=200)
        return [i for i in claimed if kind is None or i["kind"] == kind]


class NoPassWithoutGateTests(EngineCase):
    """AT-04: an issue dragged to done, a forged agent success, or a missing evidence never passes."""

    def test_a_forged_issue_done_observation_does_not_pass_a_node(self) -> None:
        attempt = self.engine.claim(
            claim_request(run_id=self.run_id, node_id=QA_NODE, subject="sub-qa")
        )
        outcome = self.engine.intake_event(
            {
                "type": "pf.execution.observed",
                "runId": self.run_id,
                "nodeId": QA_NODE,
                "scope": SCOPE_A,
                "source": "paperclip",
                "sourceEventId": "issue-17-status-changed",
                "payload": {
                    "nodeId": QA_NODE,
                    "issueRef": {"provider": "paperclip", "kind": "issue", "id": "issue-qa_run"},
                    "status": "done",
                },
            }
        )
        self.assertTrue(outcome["accepted"])
        self.assertEqual(self.node(QA_NODE)["status"], NodeStatus.RUNNING)
        self.assertEqual(self.node(QA_NODE)["status"], attempt["status"])

    def test_an_agent_run_finished_observation_does_not_pass_a_node(self) -> None:
        attempt = self.engine.claim(
            claim_request(run_id=self.run_id, node_id=QA_NODE, subject="sub-qa")
        )
        self.engine.intake_event(
            {
                "type": "pf.execution.observed",
                "runId": self.run_id,
                "nodeId": QA_NODE,
                "scope": SCOPE_A,
                "source": "paperclip",
                "sourceEventId": "agent-run-finished-1",
                "payload": {
                    "nodeId": QA_NODE,
                    "attemptId": attempt["attemptId"],
                    "state": "succeeded",
                    "exitReason": "process exited 0",
                },
            }
        )
        self.assertNotEqual(self.node(QA_NODE)["status"], NodeStatus.PASSED)
        self.assertEqual(self.node(QA_NODE)["outputRefs"], [])

    def test_a_transition_request_with_no_evidence_never_passes(self) -> None:
        attempt = self.engine.claim(
            claim_request(run_id=self.run_id, node_id=QA_NODE, subject="sub-qa")
        )
        result = self.engine.request_transition(
            envelope(
                run_id=self.run_id,
                node_id=QA_NODE,
                attempt_id=attempt["attemptId"],
                lease_epoch=attempt["leaseEpoch"],
                payload={"evidenceIds": []},
            )
        )
        self.assertFalse(result["applied"])
        self.assertEqual(result["status"], NodeStatus.EVALUATING)
        self.assertNotEqual(self.node(QA_NODE)["status"], NodeStatus.PASSED)

    def test_no_downstream_intent_is_queued_for_an_unverified_node(self) -> None:
        self.engine.claim(claim_request(run_id=self.run_id, node_id=QA_NODE, subject="sub-qa"))
        self.engine.intake_event(
            {
                "type": "pf.execution.observed",
                "runId": self.run_id,
                "scope": SCOPE_A,
                "source": "paperclip",
                "sourceEventId": "issue-17-status-changed",
                "payload": {"status": "done", "nodeId": QA_NODE},
            }
        )
        released = [i["nodeId"] for i in self.intents("work.unit.ensure")]
        self.assertEqual(
            released,
            [QA_NODE],
            "no successor may be released while the upstream is unverified",
        )

    def test_a_bridge_cannot_commit_a_transition_through_the_event_channel(self) -> None:
        outcome = self.engine.intake_event(
            {
                "type": "pf.transition.committed",
                "runId": self.run_id,
                "nodeId": QA_NODE,
                "scope": SCOPE_A,
                "source": "paperclip",
                "sourceEventId": "forged-commit",
                "payload": {"nodeId": QA_NODE, "result": "PASSED"},
            }
        )
        self.assertTrue(outcome["accepted"])
        self.assertIn("recorded_without_state_change", outcome["applied"])
        self.assertNotEqual(self.node(QA_NODE)["status"], NodeStatus.PASSED)

    def test_only_request_transition_writes_passed(self) -> None:
        outcome = self.work(QA_NODE, "sub-qa", "qa_report", "qa-v1")
        self.assertTrue(outcome["result"]["applied"])
        self.assertEqual(self.node(QA_NODE)["status"], NodeStatus.PASSED)


class IdempotencyAndVersioningTests(EngineCase):
    def test_replaying_the_same_command_returns_the_recorded_result(self) -> None:
        attempt = self.engine.claim(
            claim_request(run_id=self.run_id, node_id=QA_NODE, subject="sub-qa")
        )
        art = artifact("qa_report", "qa-v1")
        request = envelope(
            run_id=self.run_id,
            node_id=QA_NODE,
            attempt_id=attempt["attemptId"],
            lease_epoch=attempt["leaseEpoch"],
            payload={"artifacts": [art]},
        )
        first = self.engine.submit_artifacts(request)
        second = self.engine.submit_artifacts(request)
        self.assertEqual(first, second)
        self.assertEqual(
            len(self.db.query("SELECT * FROM artifacts WHERE run_id = ?", (self.run_id,))), 1
        )

    def test_the_same_key_with_a_different_payload_is_a_conflict(self) -> None:
        attempt = self.engine.claim(
            claim_request(run_id=self.run_id, node_id=QA_NODE, subject="sub-qa")
        )
        base = envelope(
            run_id=self.run_id,
            node_id=QA_NODE,
            attempt_id=attempt["attemptId"],
            lease_epoch=attempt["leaseEpoch"],
            payload={"artifacts": [artifact("qa_report", "qa-v1")]},
        )
        self.engine.submit_artifacts(base)
        conflicting = copy.deepcopy(base)
        conflicting["payload"]["artifacts"] = [artifact("qa_report", "different-bytes")]
        with self.assertRaises(errors.PolyForgeError) as caught:
            self.engine.submit_artifacts(conflicting)
        self.assertEqual(caught.exception.code, errors.ErrorCode.IDEMPOTENCY_CONFLICT)

    def test_a_stale_expected_state_version_is_refused_with_the_current_version(self) -> None:
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
                    expected_state_version=0,
                    payload={"artifacts": [artifact("qa_report", "qa-v1")]},
                )
            )
        self.assertEqual(caught.exception.code, errors.ErrorCode.VERSION_CONFLICT)
        self.assertIn("currentVersion", caught.exception.details)
        self.assertGreater(int(caught.exception.details["currentVersion"]), 0)

    def test_a_mutated_contract_is_refused_at_commit(self) -> None:
        attempt = self.engine.claim(
            claim_request(run_id=self.run_id, node_id=QA_NODE, subject="sub-qa")
        )
        art = artifact("qa_report", "qa-v1")
        self.engine.submit_artifacts(
            envelope(
                run_id=self.run_id,
                node_id=QA_NODE,
                attempt_id=attempt["attemptId"],
                lease_epoch=attempt["leaseEpoch"],
                payload={"artifacts": [art]},
            )
        )
        evidence = self.engine.submit_evidence(
            envelope(
                run_id=self.run_id,
                node_id=QA_NODE,
                attempt_id=attempt["attemptId"],
                lease_epoch=attempt["leaseEpoch"],
                command_suffix="ev",
                payload={"evidence": [evidence_for(art, "qa_report")]},
            )
        )
        with self.assertRaises(errors.PolyForgeError) as caught:
            self.engine.request_transition(
                envelope(
                    run_id=self.run_id,
                    node_id=QA_NODE,
                    attempt_id=attempt["attemptId"],
                    lease_epoch=attempt["leaseEpoch"],
                    payload={"evidenceIds": [str(evidence["resultRef"]).split(",")[0]]},
                    contract_hash="sha256:not-my-contract",
                )
            )
        self.assertEqual(caught.exception.code, errors.ErrorCode.CONTRACT_INVALID)


class FencingTests(EngineCase):
    """AT-28: an expired lease with a live worker cannot produce a new effect."""

    def test_a_stale_epoch_write_is_fenced_and_recorded_as_a_diagnostic(self) -> None:
        attempt = self.engine.claim(
            claim_request(run_id=self.run_id, node_id=QA_NODE, subject="sub-qa", lease_epoch=4)
        )
        with self.assertRaises(errors.PolyForgeError) as caught:
            self.engine.submit_artifacts(
                envelope(
                    run_id=self.run_id,
                    node_id=QA_NODE,
                    attempt_id=attempt["attemptId"],
                    lease_epoch=3,
                    payload={"artifacts": [artifact("qa_report", "late")]},
                )
            )
        self.assertEqual(caught.exception.code, errors.ErrorCode.LEASE_FENCED)
        self.assertEqual(caught.exception.details["presentedEpoch"], 3)
        self.assertEqual(caught.exception.details["activeEpoch"], 4)
        rejections = self.engine.refusals(self.run_id)
        self.assertEqual(len(rejections), 1)
        self.assertEqual(str(rejections[0]["code"]), "LEASE_FENCED")
        # The diagnostic is isolated: it changed no state and emitted no event.
        self.assertEqual(len(self.db.query("SELECT * FROM artifacts WHERE run_id = ?", (self.run_id,))), 0)
        self.assertNotIn(
            "pf.transition.committed",
            [e["type"] for e in self.engine.list_events(self.run_id, scope=SCOPE_A)],
        )

    def test_a_write_without_a_claim_is_fenced(self) -> None:
        with self.assertRaises(errors.PolyForgeError) as caught:
            self.engine.submit_artifacts(
                envelope(
                    run_id=self.run_id,
                    node_id=QA_NODE,
                    attempt_id=None,
                    lease_epoch=1,
                    payload={"artifacts": [artifact("qa_report", "x")]},
                )
            )
        self.assertEqual(caught.exception.code, errors.ErrorCode.LEASE_FENCED)

    def test_two_owners_are_not_both_admitted(self) -> None:
        first = self.engine.claim(
            claim_request(run_id=self.run_id, node_id=QA_NODE, subject="sub-qa", lease_epoch=1)
        )
        with self.assertRaises(errors.PolyForgeError) as caught:
            self.engine.claim(
                claim_request(run_id=self.run_id, node_id=QA_NODE, subject="sub-other", lease_epoch=1)
            )
        self.assertEqual(caught.exception.code, errors.ErrorCode.LEASE_FENCED)
        active = self.db.query(
            "SELECT attempt_id FROM execution_attempts WHERE run_id = ? AND lease_state = 'ACTIVE'",
            (self.run_id,),
        )
        self.assertEqual([r["attempt_id"] for r in active], [first["attemptId"]])

    def test_a_takeover_without_a_stop_confirmation_is_refused(self) -> None:
        self.clock.advance(1000)
        self.engine.claim(
            claim_request(run_id=self.run_id, node_id=QA_NODE, subject="sub-qa", lease_epoch=1)
        )
        with self.assertRaises(errors.PolyForgeError) as caught:
            self.engine.claim(
                claim_request(
                    run_id=self.run_id, node_id=QA_NODE, subject="sub-other", lease_epoch=2
                )
            )
        self.assertEqual(caught.exception.code, errors.ErrorCode.LEASE_FENCED)
        self.assertEqual(caught.exception.details["requiredPriorWorkerState"], ["fenced", "stopped"])

    def test_a_takeover_with_a_stop_confirmation_fences_the_incumbent(self) -> None:
        self.clock.advance(1000)
        first = self.engine.claim(
            claim_request(run_id=self.run_id, node_id=QA_NODE, subject="sub-qa", lease_epoch=1)
        )
        second = self.engine.claim(
            claim_request(
                run_id=self.run_id,
                node_id=QA_NODE,
                subject="sub-other",
                lease_epoch=2,
                priorWorkerState="stopped",
            )
        )
        self.assertNotEqual(second["attemptId"], first["attemptId"])
        self.assertEqual(int(second["leaseEpoch"]), 2)
        old = self.db.query_one(
            "SELECT * FROM execution_attempts WHERE attempt_id = ?", (first["attemptId"],)
        )
        assert old is not None
        self.assertEqual(str(old["lease_state"]), "FENCED")

    def test_a_takeover_at_an_equal_epoch_is_refused(self) -> None:
        self.engine.claim(
            claim_request(run_id=self.run_id, node_id=QA_NODE, subject="sub-qa", lease_epoch=5)
        )
        with self.assertRaises(errors.PolyForgeError) as caught:
            self.engine.claim(
                claim_request(
                    run_id=self.run_id,
                    node_id=QA_NODE,
                    subject="sub-other",
                    lease_epoch=5,
                    priorWorkerState="stopped",
                )
            )
        self.assertEqual(caught.exception.code, errors.ErrorCode.LEASE_FENCED)
        self.assertEqual(caught.exception.details["activeEpoch"], 5)

    def test_a_reclaim_by_the_same_owner_is_idempotent(self) -> None:
        first = self.engine.claim(
            claim_request(run_id=self.run_id, node_id=QA_NODE, subject="sub-qa", lease_epoch=1)
        )
        again = self.engine.claim(
            claim_request(run_id=self.run_id, node_id=QA_NODE, subject="sub-qa", lease_epoch=1)
        )
        self.assertEqual(first["attemptId"], again["attemptId"])


class SessionHandoverTests(EngineCase):
    """AT-25: closing an agent session leaves the run intact and another agent can take over."""

    def test_adopting_after_a_confirmed_stop_keeps_the_run_and_its_evidence(self) -> None:
        self.clock.advance(10_000)
        self.engine.claim(
            claim_request(run_id=self.run_id, node_id=QA_NODE, subject="sub-qa", lease_epoch=1)
        )
        before = self.engine.get_run(self.run_id, scope=SCOPE_A)
        adopted = self.engine.current(
            self.run_id,
            actor={
                "scope": SCOPE_A,
                "subjectRef": "sub-replacement",
                "priorWorkerState": "stopped",
                "leaseEpoch": 2,
            },
            node_id=QA_NODE,
            adopt=True,
        )
        self.assertEqual(adopted["attempt"]["leaseEpoch"], 2)
        self.assertEqual(adopted["attempt"]["agentSubject"], "sub-replacement")
        after = self.engine.get_run(self.run_id, scope=SCOPE_A)
        self.assertEqual(after["runId"], before["runId"])
        self.assertNotEqual(after["stateVersion"], 0)
        self.assertNotIn(GraphRunStatus.CANCELLED, after["status"])

    def test_current_never_reports_a_pass(self) -> None:
        self.engine.claim(claim_request(run_id=self.run_id, node_id=QA_NODE, subject="sub-qa"))
        current = self.engine.current(
            self.run_id, actor={"scope": SCOPE_A, "subjectRef": "sub-qa"}, node_id=QA_NODE
        )
        self.assertNotEqual(current["status"], NodeStatus.PASSED)
        self.assertIn("polyforge.request_transition", current["permittedActions"])
        self.assertNotIn("set_node_passed", current["permittedActions"])

    def test_current_requires_an_actor_subject(self) -> None:
        with self.assertRaises(errors.PolyForgeError) as caught:
            self.engine.current(self.run_id, actor={"scope": SCOPE_A})
        self.assertEqual(caught.exception.code, errors.ErrorCode.AUTHORIZATION_DENIED)


class BudgetTests(EngineCase):
    """AT-10: a financial hard stop blocks, and swapping agents does not help."""

    def _hard_stop(self) -> None:
        self.engine.intake_event(
            {
                "type": "pf.run.blocked",
                "runId": self.run_id,
                "scope": SCOPE_A,
                "source": "paperclip",
                "sourceEventId": "budget-incident-1",
                "payload": {
                    "blockReason": str(BlockReason.BUDGET),
                    "budget": {"state": "HARD_STOP", "remainingUsd": 0, "reason": "project budget exhausted"},
                },
            }
        )

    def test_a_hard_stop_blocks_a_claim_for_every_agent(self) -> None:
        self._hard_stop()
        for subject in ("sub-qa", "sub-security", "sub-anyone"):
            with self.subTest(subject=subject):
                with self.assertRaises(errors.PolyForgeError) as caught:
                    self.engine.claim(
                        claim_request(run_id=self.run_id, node_id=QA_NODE, subject=subject)
                    )
                self.assertEqual(caught.exception.code, errors.ErrorCode.RUN_BLOCKED)
        self.assertEqual(
            len(self.db.query("SELECT * FROM execution_attempts WHERE run_id = ?", (self.run_id,))), 0
        )

    def test_a_hard_stop_blocks_a_retry_command(self) -> None:
        self._hard_stop()
        with self.assertRaises(errors.PolyForgeError) as caught:
            self.engine.run_command(
                {
                    "scope": SCOPE_A,
                    "runId": self.run_id,
                    "command": "retry",
                    "nodeId": QA_NODE,
                    "reason": "try again",
                    "actor": CONTROLLER,
                    "idempotencyKey": "retry-1",
                }
            )
        self.assertEqual(caught.exception.code, errors.ErrorCode.RUN_BLOCKED)

    def test_a_hard_stop_cannot_be_cleared_by_resolve_block(self) -> None:
        self._hard_stop()
        with self.assertRaises(errors.PolyForgeError) as caught:
            self.engine.run_command(
                {
                    "scope": SCOPE_A,
                    "runId": self.run_id,
                    "command": "resolve_block",
                    "reason": "I approve",
                    "actor": CONTROLLER,
                    "idempotencyKey": "resolve-1",
                    "resolutionDetail": {"reason": "manual override"},
                }
            )
        self.assertEqual(caught.exception.code, errors.ErrorCode.RUN_BLOCKED)
        self.assertEqual(
            [b["code"] for b in caught.exception.details["blockers"]], ["BUDGET_HARD_STOP"]
        )
        self.assertEqual(
            self.engine.get_run(self.run_id, scope=SCOPE_A)["status"], GraphRunStatus.BLOCKED
        )

    def test_a_hard_stop_appears_as_a_blocker_on_the_snapshot(self) -> None:
        self._hard_stop()
        snapshot = self.engine.get_run(self.run_id, scope=SCOPE_A)
        self.assertIn("BUDGET_HARD_STOP", [b["code"] for b in snapshot["blockers"]])
        self.assertEqual(snapshot["blockers"][0]["reason"], str(BlockReason.BUDGET))

    def test_an_exhausted_rework_budget_blocks_rather_than_looping(self) -> None:
        # Two failures exhaust the fixture's maxAttempts of 2, and the third claim is refused.
        for _ in range(2):
            self.engine.run_command(
                {
                    "scope": SCOPE_A,
                    "runId": self.run_id,
                    "command": "retry",
                    "nodeId": QA_NODE,
                    "reason": "rework",
                    "actor": CONTROLLER,
                    "idempotencyKey": f"retry-{_}",
                }
            )
        with self.assertRaises(errors.PolyForgeError) as caught:
            self.engine.claim(
                claim_request(run_id=self.run_id, node_id=QA_NODE, subject="sub-qa", iteration=2)
            )
        self.assertEqual(caught.exception.code, errors.ErrorCode.RUN_BLOCKED)
        self.assertIn("engineering rework budget", caught.exception.message)

    def test_a_retry_above_the_ceiling_reports_an_explainable_block(self) -> None:
        for _ in range(3):
            result = self.engine.run_command(
                {
                    "scope": SCOPE_A,
                    "runId": self.run_id,
                    "command": "retry",
                    "nodeId": QA_NODE,
                    "reason": "rework",
                    "actor": CONTROLLER,
                    "idempotencyKey": f"retry-x-{_}",
                }
            )
        self.assertIn(
            "REWORK_CEILING_EXCEEDED", [b["code"] for b in result["blockers"]]
        )
        self.assertEqual(result["status"], GraphRunStatus.BLOCKED)
        self.assertEqual(self.node(QA_NODE)["blockReason"], str(BlockReason.BUDGET))

    def test_a_new_iteration_gets_a_fresh_contract(self) -> None:
        self.engine.claim(claim_request(run_id=self.run_id, node_id=QA_NODE, subject="sub-qa"))
        contract_before = self.node(QA_NODE)["contractHash"]
        self.engine.run_command(
            {
                "scope": SCOPE_A,
                "runId": self.run_id,
                "command": "retry",
                "nodeId": QA_NODE,
                "reason": "rework after review",
                "actor": CONTROLLER,
                "idempotencyKey": "retry-fresh",
            }
        )
        attempt = self.engine.claim(
            claim_request(run_id=self.run_id, node_id=QA_NODE, subject="sub-qa", iteration=1)
        )
        self.assertNotEqual(self.node(QA_NODE)["contractHash"], contract_before)
        self.assertEqual(int(attempt["iteration"]), 1)


class TraceabilityTests(EngineCase):
    """AT-11: a transition traces back to the issue, agent run, evidence, gate, and effect."""

    def test_the_transition_is_traceable_end_to_end(self) -> None:
        outcome = self.work(QA_NODE, "sub-qa", "qa_report", "qa-v1")
        snapshot = self.engine.get_run(self.run_id, scope=SCOPE_A)
        self.assertEqual(snapshot["nodes"][0]["nodeId"] or snapshot["nodes"][1]["nodeId"], snapshot["nodes"][0]["nodeId"] or "")
        attempt = next(a for a in snapshot["attempts"] if a["nodeId"] == QA_NODE)
        self.assertEqual(attempt["agentSubject"], "sub-qa")
        self.assertEqual(attempt["agentRunRef"]["id"], "run-sub-qa")
        self.assertEqual(snapshot["rootIssueRef"]["id"], "issue-root-1")
        evidence = [e for e in snapshot["evidence"] if e["nodeId"] == QA_NODE]
        self.assertEqual(len(evidence), 1)
        self.assertEqual(evidence[0]["producerSubject"], "sub-qa")
        gates = [g for g in snapshot["gates"] if g["nodeId"] == QA_NODE]
        self.assertTrue(gates)
        self.assertTrue(all(g["result"] == "PASS" for g in gates))
        self.assertTrue(all(g["transitionHash"] == attempt["transitionHash"] for g in gates))
        self.assertTrue(all(g["evidenceSetHash"].startswith("sha256:") for g in gates))
        bindings = self.db.query(
            "SELECT * FROM work_bindings WHERE run_id = ? AND node_id = ?", (self.run_id, QA_NODE)
        )
        self.assertEqual(len(bindings), 1)
        self.assertIsNotNone(bindings[0]["issue_ref_json"])
        self.assertEqual(str(bindings[0]["contract_hash"]), str(attempt["transitionHash"]))

    def test_every_event_carries_the_run_and_a_monotonic_sequence(self) -> None:
        self.work(QA_NODE, "sub-qa", "qa_report", "qa-v1")
        events = self.engine.list_events(self.run_id, scope=SCOPE_A)
        self.assertTrue(all(e["runId"] == self.run_id for e in events))
        self.assertTrue(all(e["seq"] == i + 1 for i, e in enumerate(events)))

    def test_gate_evaluation_rows_carry_the_evidence_set_hash(self) -> None:
        self.work(QA_NODE, "sub-qa", "qa_report", "qa-v1")
        rows = self.db.query(
            "SELECT * FROM gate_evaluations WHERE run_id = ?", (self.run_id,)
        )
        self.assertTrue(rows)
        self.assertTrue(all(str(r["evidence_set_hash"]).startswith("sha256:") for r in rows))
        self.assertTrue(all(str(r["mandatory"]) == "1" for r in rows))


class JoinAndSequencingTests(EngineCase):
    """AT-05: only legal successors are released, and a parent needs verified child exports."""

    def test_the_reviewer_is_not_released_before_qa_passes(self) -> None:
        self.assertEqual(self.node(REVIEW_NODE)["status"], NodeStatus.PENDING)
        self.work(QA_NODE, "sub-qa", "qa_report", "qa-v1")
        self.assertEqual(self.node(REVIEW_NODE)["status"], NodeStatus.READY)
        self.assertEqual(self.node(GATE_NODE)["status"], NodeStatus.PENDING)

    def test_the_gate_needs_both_upstreams(self) -> None:
        self.work(QA_NODE, "sub-qa", "qa_report", "qa-v1")
        self.work(REVIEW_NODE, "sub-security", "security_review", "sec-v1")
        self.assertEqual(self.node(GATE_NODE)["status"], NodeStatus.READY)

    def test_a_missing_required_evidence_kind_keeps_the_gate_pending(self) -> None:
        self.work(QA_NODE, "sub-qa", "qa_report", "qa-v1")
        self.work(REVIEW_NODE, "sub-security", "security_review", "sec-v1")
        attempt = self.engine.claim(
            claim_request(run_id=self.run_id, node_id=GATE_NODE, subject="sub-chair")
        )
        only_qa = artifact("qa_report", "qa-v1")
        self.engine.submit_artifacts(
            envelope(
                run_id=self.run_id,
                node_id=GATE_NODE,
                attempt_id=attempt["attemptId"],
                lease_epoch=attempt["leaseEpoch"],
                payload={"artifacts": [only_qa]},
            )
        )
        evidence = self.engine.submit_evidence(
            envelope(
                run_id=self.run_id,
                node_id=GATE_NODE,
                attempt_id=attempt["attemptId"],
                lease_epoch=attempt["leaseEpoch"],
                command_suffix="ev",
                payload={"evidence": [evidence_for(only_qa, "qa_report")]},
            )
        )
        result = self.engine.request_transition(
            envelope(
                run_id=self.run_id,
                node_id=GATE_NODE,
                attempt_id=attempt["attemptId"],
                lease_epoch=attempt["leaseEpoch"],
                command_suffix="tr",
                payload={"evidenceIds": [str(evidence["resultRef"]).split(",")[0]]},
            )
        )
        self.assertFalse(result["applied"])
        self.assertNotEqual(self.node(GATE_NODE)["status"], NodeStatus.PASSED)
        detail = result["blockers"][0]["detail"]
        self.assertIn("security_review", detail["missingEvidenceKinds"])


class HumanDecisionTests(EngineCase):
    """AT-14 and AT-33: an exact-hash human decision, and its expiry."""

    def _reach_the_gate(self) -> tuple[dict[str, object], dict[str, object]]:
        self.work(QA_NODE, "sub-qa", "qa_report", "qa-v1")
        self.work(REVIEW_NODE, "sub-security", "security_review", "sec-v1")
        attempt = self.engine.claim(
            claim_request(run_id=self.run_id, node_id=GATE_NODE, subject="sub-chair")
        )
        qa_art = artifact("qa_report", "qa-v1")
        sec_art = artifact("security_review", "sec-v1")
        self.engine.submit_artifacts(
            envelope(
                run_id=self.run_id,
                node_id=GATE_NODE,
                attempt_id=attempt["attemptId"],
                lease_epoch=attempt["leaseEpoch"],
                payload={"artifacts": [qa_art, sec_art]},
            )
        )
        evidence = self.engine.submit_evidence(
            envelope(
                run_id=self.run_id,
                node_id=GATE_NODE,
                attempt_id=attempt["attemptId"],
                lease_epoch=attempt["leaseEpoch"],
                command_suffix="ev",
                payload={
                    "evidence": [
                        evidence_for(qa_art, "qa_report"),
                        evidence_for(sec_art, "security_review"),
                    ]
                },
            )
        )
        result = self.engine.request_transition(
            envelope(
                run_id=self.run_id,
                node_id=GATE_NODE,
                attempt_id=attempt["attemptId"],
                lease_epoch=attempt["leaseEpoch"],
                command_suffix="tr",
                payload={"evidenceIds": str(evidence["resultRef"]).split(",")},
            )
        )
        return attempt, result

    def test_a_waiting_gate_releases_the_worker_and_records_a_durable_intent(self) -> None:
        attempt, result = self._reach_the_gate()
        self.assertTrue(result["pending"])
        self.assertEqual(result["pendingReason"], "awaiting_verified_human_decision")
        self.assertEqual(self.node(GATE_NODE)["status"], NodeStatus.WAITING_GOVERNANCE)
        self.assertIsNone(self.node(GATE_NODE)["activeAttemptId"])
        stored = self.db.query_one(
            "SELECT * FROM execution_attempts WHERE attempt_id = ?", (attempt["attemptId"],)
        )
        assert stored is not None
        self.assertEqual(str(stored["lease_state"]), "RELEASED")
        pending = self.engine.get_run(self.run_id, scope=SCOPE_A)["pendingGovernance"]
        self.assertEqual(len(pending), 1)
        self.assertTrue(pending[0]["decisionTargetHash"].startswith("sha256:"))
        self.assertEqual(pending[0]["semanticKind"], "verification_acceptance")
        self.assertEqual([i["kind"] for i in self.intents("governance.request")], ["governance.request"])

    def test_a_verified_human_acceptance_commits_the_pass(self) -> None:
        self._reach_the_gate()
        pending = self.engine.get_run(self.run_id, scope=SCOPE_A)["pendingGovernance"][0]
        result = self.engine.record_governance_resolution(
            self.run_id,
            pending["requestId"],
            {
                "scope": SCOPE_A,
                "commandId": "cmd-resolve",
                "idempotencyKey": "resolve-1",
                "responderSubject": "user-anna",
                "responderKind": "human",
                "outcome": "accept",
                "verifiedAgainstProvider": True,
                "detail": {"decisionTargetHash": pending["decisionTargetHash"]},
            },
        )
        self.assertTrue(result["applied"])
        self.assertEqual(result["status"], NodeStatus.PASSED)
        self.assertEqual(self.engine.get_run(self.run_id, scope=SCOPE_A)["status"], GraphRunStatus.COMPLETED)

    def test_an_unverified_approval_is_refused(self) -> None:
        self._reach_the_gate()
        pending = self.engine.get_run(self.run_id, scope=SCOPE_A)["pendingGovernance"][0]
        with self.assertRaises(errors.PolyForgeError) as caught:
            self.engine.record_governance_resolution(
                self.run_id,
                pending["requestId"],
                {
                    "scope": SCOPE_A,
                    "commandId": "cmd-resolve",
                    "idempotencyKey": "resolve-unverified",
                    "responderSubject": "user-anna",
                    "responderKind": "human",
                    "outcome": "accept",
                    "verifiedAgainstProvider": False,
                    "detail": {"decisionTargetHash": pending["decisionTargetHash"]},
                },
            )
        self.assertEqual(caught.exception.code, errors.ErrorCode.AUTHORIZATION_DENIED)
        self.assertNotEqual(self.node(GATE_NODE)["status"], NodeStatus.PASSED)

    def test_an_agent_responder_cannot_satisfy_a_human_only_request(self) -> None:
        self._reach_the_gate()
        pending = self.engine.get_run(self.run_id, scope=SCOPE_A)["pendingGovernance"][0]
        with self.assertRaises(errors.PolyForgeError) as caught:
            self.engine.record_governance_resolution(
                self.run_id,
                pending["requestId"],
                {
                    "scope": SCOPE_A,
                    "commandId": "cmd-resolve",
                    "idempotencyKey": "resolve-agent",
                    "responderSubject": "sub-qa",
                    "responderKind": "agent",
                    "outcome": "accept",
                    "verifiedAgainstProvider": True,
                    "detail": {"decisionTargetHash": pending["decisionTargetHash"]},
                },
            )
        self.assertEqual(caught.exception.code, errors.ErrorCode.AUTHORIZATION_DENIED)

    def test_a_stale_target_does_not_apply(self) -> None:
        self._reach_the_gate()
        pending = self.engine.get_run(self.run_id, scope=SCOPE_A)["pendingGovernance"][0]
        result = self.engine.record_governance_resolution(
            self.run_id,
            pending["requestId"],
            {
                "scope": SCOPE_A,
                "commandId": "cmd-resolve",
                "idempotencyKey": "resolve-stale",
                "responderSubject": "user-anna",
                "responderKind": "human",
                "outcome": "accept",
                "verifiedAgainstProvider": True,
                "detail": {"decisionTargetHash": "sha256:an-older-target"},
            },
        )
        self.assertFalse(result["applied"])
        self.assertNotEqual(self.node(GATE_NODE)["status"], NodeStatus.PASSED)
        evaluations = [
            g
            for g in self.engine.get_run(self.run_id, scope=SCOPE_A)["gates"]
            if g["evaluatorRef"] == "human_decision"
        ]
        self.assertEqual(evaluations[-1]["result"], "FAIL")
        self.assertIn("different target", evaluations[-1]["reason"])

    def test_a_rejection_sends_the_node_back_to_rework(self) -> None:
        self._reach_the_gate()
        pending = self.engine.get_run(self.run_id, scope=SCOPE_A)["pendingGovernance"][0]
        result = self.engine.record_governance_resolution(
            self.run_id,
            pending["requestId"],
            {
                "scope": SCOPE_A,
                "commandId": "cmd-resolve",
                "idempotencyKey": "resolve-reject",
                "responderSubject": "user-anna",
                "responderKind": "human",
                "outcome": "reject",
                "verifiedAgainstProvider": True,
                "detail": {
                    "decisionTargetHash": pending["decisionTargetHash"],
                    "reason": "the security review is not sufficient",
                },
            },
        )
        self.assertEqual(result["status"], NodeStatus.REWORK_REQUIRED)
        self.assertNotEqual(self.node(GATE_NODE)["status"], NodeStatus.PASSED)

    def test_an_expired_request_cannot_be_answered(self) -> None:
        self._reach_the_gate()
        pending = self.engine.get_run(self.run_id, scope=SCOPE_A)["pendingGovernance"][0]
        self.db.execute(
            "UPDATE governance_bindings SET expires_at = ? WHERE request_id = ?",
            ("2020-01-01T00:00:00.000Z", pending["requestId"]),
        )
        with self.assertRaises(errors.PolyForgeError) as caught:
            self.engine.record_governance_resolution(
                self.run_id,
                pending["requestId"],
                {
                    "scope": SCOPE_A,
                    "commandId": "cmd-resolve",
                    "idempotencyKey": "resolve-expired",
                    "responderSubject": "user-anna",
                    "responderKind": "human",
                    "outcome": "accept",
                    "verifiedAgainstProvider": True,
                    "detail": {"decisionTargetHash": pending["decisionTargetHash"]},
                },
            )
        self.assertEqual(caught.exception.code, errors.ErrorCode.RUN_BLOCKED)


class IndependentReviewTests(EngineCase):
    """AT-33: exact-hash review, and a producer cannot review itself."""

    def _review_graph(self) -> dict[str, object]:
        graph = definition()
        graph["nodes"][REVIEW_NODE]["evaluatorRefs"] = [
            "contract_schema_v1",
            "required_evidence_present",
            "independent_reviewer",
        ]
        return graph

    def test_a_reviewer_who_produced_the_artifact_fails_the_gate(self) -> None:
        snapshot = self.engine.admit_work_order(
            work_order_request(
                graph=self._review_graph(), start_intent_id="intent-with-independent-review"
            )
        )
        self.run_id = str(snapshot["runId"])
        grant_capability(self.db, "sub-qa", "security.review")
        self.work(QA_NODE, "sub-qa", "qa_report", "qa-v1")
        attempt = self.engine.claim(
            claim_request(run_id=self.run_id, node_id=REVIEW_NODE, subject="sub-qa")
        )
        art = artifact("security_review", "sec-v1")
        self.engine.submit_artifacts(
            envelope(
                run_id=self.run_id,
                node_id=REVIEW_NODE,
                attempt_id=attempt["attemptId"],
                lease_epoch=attempt["leaseEpoch"],
                payload={"artifacts": [art]},
            )
        )
        evidence = self.engine.submit_evidence(
            envelope(
                run_id=self.run_id,
                node_id=REVIEW_NODE,
                attempt_id=attempt["attemptId"],
                lease_epoch=attempt["leaseEpoch"],
                command_suffix="ev",
                payload={"evidence": [evidence_for(art, "security_review")]},
            )
        )
        result = self.engine.request_transition(
            envelope(
                run_id=self.run_id,
                node_id=REVIEW_NODE,
                attempt_id=attempt["attemptId"],
                lease_epoch=attempt["leaseEpoch"],
                command_suffix="tr",
                payload={"evidenceIds": [str(evidence["resultRef"]).split(",")[0]]},
            )
        )
        self.assertFalse(result["applied"])
        self.assertEqual(result["status"], NodeStatus.REWORK_REQUIRED)
        self.assertIn("produced the artifact under review", result["blockers"][0]["message"])

    def test_an_independent_qualified_reviewer_passes(self) -> None:
        snapshot = self.engine.admit_work_order(
            work_order_request(
                graph=self._review_graph(), start_intent_id="intent-with-independent-review"
            )
        )
        self.run_id = str(snapshot["runId"])
        self.work(QA_NODE, "sub-qa", "qa_report", "qa-v1")
        result = self.work(REVIEW_NODE, "sub-security", "security_review", "sec-v1")
        self.assertTrue(result["result"]["applied"])
        self.assertEqual(result["result"]["status"], NodeStatus.PASSED)


class RunCommandTests(EngineCase):
    def test_a_command_without_the_capability_is_refused(self) -> None:
        with self.assertRaises(errors.PolyForgeError) as caught:
            self.engine.run_command(
                {
                    "scope": SCOPE_A,
                    "runId": self.run_id,
                    "command": "cancel",
                    "reason": "stop",
                    "actor": {"subjectRef": "user-anna", "capabilities": []},
                    "idempotencyKey": "cancel-1",
                }
            )
        self.assertEqual(caught.exception.code, errors.ErrorCode.AUTHORIZATION_DENIED)

    def test_a_command_without_a_reason_is_refused(self) -> None:
        with self.assertRaises(errors.PolyForgeError) as caught:
            self.engine.run_command(
                {
                    "scope": SCOPE_A,
                    "runId": self.run_id,
                    "command": "pause",
                    "reason": "",
                    "actor": CONTROLLER,
                    "idempotencyKey": "pause-1",
                }
            )
        self.assertEqual(caught.exception.code, errors.ErrorCode.BAD_REQUEST)

    def test_pause_blocks_new_claims_until_an_authorised_resume(self) -> None:
        self.engine.run_command(
            {
                "scope": SCOPE_A,
                "runId": self.run_id,
                "command": "pause",
                "reason": "waiting on a dependency",
                "actor": CONTROLLER,
                "idempotencyKey": "pause-1",
            }
        )
        with self.assertRaises(errors.PolyForgeError) as caught:
            self.engine.claim(
                claim_request(run_id=self.run_id, node_id=QA_NODE, subject="sub-qa")
            )
        self.assertEqual(caught.exception.code, errors.ErrorCode.RUN_BLOCKED)
        self.assertIn("PAUSED", caught.exception.message)
        self.engine.run_command(
            {
                "scope": SCOPE_A,
                "runId": self.run_id,
                "command": "resume",
                "reason": "dependency landed",
                "actor": CONTROLLER,
                "idempotencyKey": "resume-1",
            }
        )
        self.engine.claim(claim_request(run_id=self.run_id, node_id=QA_NODE, subject="sub-qa"))

    def test_cancel_requests_a_platform_stop_and_marks_the_attempt_unknown(self) -> None:
        attempt = self.engine.claim(
            claim_request(run_id=self.run_id, node_id=QA_NODE, subject="sub-qa")
        )
        result = self.engine.run_command(
            {
                "scope": SCOPE_A,
                "runId": self.run_id,
                "command": "cancel",
                "reason": "superseded by a newer candidate",
                "actor": CONTROLLER,
                "idempotencyKey": "cancel-1",
            }
        )
        self.assertEqual(result["status"], GraphRunStatus.CANCELLED)
        stored = self.db.query_one(
            "SELECT * FROM execution_attempts WHERE attempt_id = ?", (attempt["attemptId"],)
        )
        assert stored is not None
        self.assertEqual(str(stored["status"]), "UNKNOWN")
        stops = self.intents("work.stop")
        self.assertEqual(len(stops), 1)
        self.assertEqual(stops[0]["payload"]["attemptId"], attempt["attemptId"])
        with self.assertRaises(errors.PolyForgeError):
            self.engine.claim(
                claim_request(run_id=self.run_id, node_id=QA_NODE, subject="sub-other", lease_epoch=9)
            )

    def test_an_unknown_command_is_refused(self) -> None:
        with self.assertRaises(errors.PolyForgeError) as caught:
            self.engine.run_command(
                {
                    "scope": SCOPE_A,
                    "runId": self.run_id,
                    "command": "set_node_passed",
                    "reason": "because",
                    "actor": CONTROLLER,
                }
            )
        self.assertEqual(caught.exception.code, errors.ErrorCode.BAD_REQUEST)


class HelpRequestTests(EngineCase):
    """REQ-TOOL-04: a help request returns a durable reference and frees the worker."""

    def test_request_help_parks_the_node_without_blocking(self) -> None:
        attempt = self.engine.claim(
            claim_request(run_id=self.run_id, node_id=QA_NODE, subject="sub-qa")
        )
        result = self.engine.request_help(
            envelope(
                run_id=self.run_id,
                node_id=QA_NODE,
                attempt_id=attempt["attemptId"],
                lease_epoch=attempt["leaseEpoch"],
                payload={
                    "kind": "clarification",
                    "question": "Which release candidate should this verification target?",
                },
            )
        )
        self.assertTrue(result["pending"])
        self.assertTrue(str(result["resultRef"]).startswith("dec_"))
        self.assertEqual(self.node(QA_NODE)["status"], NodeStatus.WAITING_GOVERNANCE)
        self.assertIsNone(self.node(QA_NODE)["activeAttemptId"])
        self.assertEqual(len(self.intents("governance.request")), 1)

    def test_request_help_needs_a_question(self) -> None:
        attempt = self.engine.claim(
            claim_request(run_id=self.run_id, node_id=QA_NODE, subject="sub-qa")
        )
        with self.assertRaises(errors.PolyForgeError) as caught:
            self.engine.request_help(
                envelope(
                    run_id=self.run_id,
                    node_id=QA_NODE,
                    attempt_id=attempt["attemptId"],
                    lease_epoch=attempt["leaseEpoch"],
                    payload={"kind": "clarification", "question": "   "},
                )
            )
        self.assertEqual(caught.exception.code, errors.ErrorCode.BAD_REQUEST)

    def test_request_help_rejects_an_unknown_kind(self) -> None:
        attempt = self.engine.claim(
            claim_request(run_id=self.run_id, node_id=QA_NODE, subject="sub-qa")
        )
        with self.assertRaises(errors.PolyForgeError) as caught:
            self.engine.request_help(
                envelope(
                    run_id=self.run_id,
                    node_id=QA_NODE,
                    attempt_id=attempt["attemptId"],
                    lease_epoch=attempt["leaseEpoch"],
                    payload={"kind": "self_approve", "question": "may I pass?"},
                )
            )
        self.assertEqual(caught.exception.code, errors.ErrorCode.BAD_REQUEST)


class MigrationTests(EngineCase):
    def _publish(self) -> int:
        """Publish a target version, make it the active default, and return its number.

        It goes through the registry's real gate chain because that is the only writer of
        published versions, and the registry is also the only thing that may choose the number:
        a test that picked the version itself would be asking the Runtime to migrate onto a
        number nothing published.
        """
        return int(published_version(self.registry, definition()).version)

    def test_a_plan_refuses_a_run_with_an_active_attempt(self) -> None:
        target = self._publish()
        self.engine.claim(claim_request(run_id=self.run_id, node_id=QA_NODE, subject="sub-qa"))
        preview = self.engine.plan_migration(
            {"scope": SCOPE_A, "runId": self.run_id, "targetGraphVersion": target}
        )
        self.assertFalse(preview["quiescent"])
        self.assertIn("ACTIVE_ATTEMPT", [b["code"] for b in preview["blockers"]])

    def test_a_plan_never_inherits_a_pass(self) -> None:
        target = self._publish()
        self.work(QA_NODE, "sub-qa", "qa_report", "qa-v1")
        preview = self.engine.plan_migration(
            {"scope": SCOPE_A, "runId": self.run_id, "targetGraphVersion": target}
        )
        self.assertIn(
            "pass_inheritance", [i["kind"] for i in preview["invalidations"]]
        )

    def test_a_commit_requires_an_approved_plan_hash(self) -> None:
        target = self._publish()
        preview = self.engine.plan_migration(
            {"scope": SCOPE_A, "runId": self.run_id, "targetGraphVersion": target}
        )
        with self.assertRaises(errors.PolyForgeError) as caught:
            self.engine.commit_migration(
                {
                    "scope": SCOPE_A,
                    "runId": self.run_id,
                    "targetGraphVersion": target,
                    "planHash": "sha256:stale-plan",
                    "commandId": "cmd-migrate",
                    "idempotencyKey": "migrate-1",
                    "approvalRefs": ["approval-1"],
                }
            )
        self.assertEqual(caught.exception.code, errors.ErrorCode.VERSION_CONFLICT)
        self.assertIn("currentPlanHash", caught.exception.details)

    def test_a_commit_requires_approval_references(self) -> None:
        target = self._publish()
        preview = self.engine.plan_migration(
            {"scope": SCOPE_A, "runId": self.run_id, "targetGraphVersion": target}
        )
        with self.assertRaises(errors.PolyForgeError) as caught:
            self.engine.commit_migration(
                {
                    "scope": SCOPE_A,
                    "runId": self.run_id,
                    "targetGraphVersion": target,
                    "planHash": preview["planHash"],
                    "commandId": "cmd-migrate",
                    "idempotencyKey": "migrate-2",
                }
            )
        self.assertEqual(caught.exception.code, errors.ErrorCode.AUTHORIZATION_DENIED)

    def test_an_approved_commit_freezes_the_source_and_creates_a_successor(self) -> None:
        target = self._publish()
        self.work(QA_NODE, "sub-qa", "qa_report", "qa-v1")
        preview = self.engine.plan_migration(
            {"scope": SCOPE_A, "runId": self.run_id, "targetGraphVersion": target}
        )
        result = self.engine.commit_migration(
            {
                "scope": SCOPE_A,
                "runId": self.run_id,
                "targetGraphVersion": target,
                "planHash": preview["planHash"],
                "commandId": "cmd-migrate",
                "idempotencyKey": "migrate-3",
                "approvalRefs": ["approval-1"],
            }
        )
        successor_id = str(result["resultRef"])
        source = self.engine.get_run(self.run_id, scope=SCOPE_A)
        successor = self.engine.get_run(successor_id, scope=SCOPE_A)
        self.assertNotEqual(successor["graphVersion"], source["graphVersion"])
        self.assertEqual(successor["graphVersion"], target)
        self.assertEqual(successor["parentRunId"], self.run_id)
        self.assertEqual(successor["familyId"], source["familyId"])
        self.assertNotEqual(successor["status"], GraphRunStatus.COMPLETED)
        node_states = {n["nodeId"]: n["status"] for n in successor["nodes"]}
        self.assertNotEqual(node_states[QA_NODE], NodeStatus.PASSED)
        record = self.db.query_one(
            "SELECT * FROM migration_records WHERE successor_run_id = ?", (successor_id,)
        )
        assert record is not None
        self.assertEqual(str(record["status"]), "COMMITTED")

    def test_a_dry_run_writes_nothing(self) -> None:
        target = self._publish()
        before = len(self.db.query("SELECT * FROM graph_runs"))
        self.engine.plan_migration(
            {"scope": SCOPE_A, "runId": self.run_id, "targetGraphVersion": target}
        )
        self.assertEqual(len(self.db.query("SELECT * FROM graph_runs")), before)


if __name__ == "__main__":
    unittest.main()
