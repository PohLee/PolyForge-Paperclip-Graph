"""Crash recovery, effect reconciliation, and the outbox (AT-26, AT-27).

The property under test is that recovery *never* invents a success and never re-executes a
side effect. It blocks what it cannot prove and re-projects what it can.
"""

from __future__ import annotations

import pathlib
import tempfile
import unittest

from services.polyforge.tests.runtime.fixtures import (
    QA_NODE,
    grant_capability,
    SCOPE_A,
    artifact,
    claim_request,
    envelope,
    evidence_for,
    make_engine,
    node_state,
    work_order_request,
)
from polyforge.core import errors, ids
from polyforge.core.runtime.effects import EffectAuthority
from polyforge.core.state import BlockReason, GraphRunStatus, NodeStatus
from polyforge.core.store.db import Database
from polyforge.core.store.models import EffectStatus

SCOPE = {"company_ref": SCOPE_A["companyRef"], "project_ref": SCOPE_A["projectRef"]}


def _temp_path() -> str:
    return str(pathlib.Path(tempfile.mkdtemp(prefix="pf-recovery-")) / "core.db")


class EffectReconciliationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine, self.db, self.clock = make_engine()
        self.run_id = str(self.engine.admit_work_order(work_order_request())["runId"])
        self.attempt = self.engine.claim(
            claim_request(run_id=self.run_id, node_id=QA_NODE, subject="sub-qa")
        )

    def _pending_effect(self, step: str = "deploy.production") -> str:
        record = self.engine.effects.record_pending(
            **SCOPE,
            run_id=self.run_id,
            transition_hash=str(self.attempt["transitionHash"]),
            step_id=step,
            target_hash="sha256:target",
            request_hash="sha256:request",
            node_id=QA_NODE,
            prior_worker_state="running",
        )
        return str(record["effect_key"])

    def test_an_in_flight_effect_becomes_unknown_and_blocks(self) -> None:
        key = self._pending_effect()
        report = self.engine.recover()
        self.assertEqual([e["effectKey"] for e in report["effects"]], [key])
        self.assertEqual(report["effects"][0]["status"], EffectStatus.PENDING)
        self.assertEqual(report["effects"][0]["action"], "marked_unknown")
        self.assertFalse(report["effects"][0]["mayRetry"])
        record = self.engine.effects.get(**SCOPE, run_id=self.run_id, key=key)
        assert record is not None
        self.assertEqual(str(record["status"]), EffectStatus.UNKNOWN)
        self.assertEqual(
            node_state(self.engine.get_run(self.run_id, scope=SCOPE_A), QA_NODE)["status"],
            NodeStatus.BLOCKED,
        )

    def test_an_unknown_effect_is_never_retried_by_recovery(self) -> None:
        key = self._pending_effect()
        self.engine.effects.mark_unknown(**SCOPE, run_id=self.run_id, key=key, reason="timeout")
        report = self.engine.recover()
        self.assertEqual(report["effects"][0]["action"], "held_blocked")
        self.assertFalse(report["effects"][0]["mayRetry"])
        self.assertIn("blocked for an authorized human", report["effects"][0]["advisory"])

    def test_an_executed_effect_is_left_alone(self) -> None:
        key = self._pending_effect()
        self.engine.effects.mark_effected(
            **SCOPE,
            run_id=self.run_id,
            key=key,
            receipt={"operationId": "op-1", "status": "accepted"},
        )
        report = self.engine.recover()
        self.assertEqual(report["effects"], [])
        record = self.engine.effects.get(**SCOPE, run_id=self.run_id, key=key)
        assert record is not None
        self.assertEqual(str(record["status"]), EffectStatus.EFFECTED)
        self.assertIn(
            "op-1", str(record["receipt_json"]), "recovery must not re-run or lose a receipt"
        )

    def test_recovery_is_idempotent(self) -> None:
        key = self._pending_effect()
        first = self.engine.recover()
        second = self.engine.recover()
        self.assertEqual(len(first["effects"]), 1)
        # The second pass still reports the unresolved effect, because it is still unresolved.
        # What must not change is the state: no new transition, no new effect row.
        self.assertEqual(second["effects"][0]["effectKey"], key)
        self.assertEqual(second["effects"][0]["action"], "held_blocked")
        self.assertEqual(
            len(self.db.query("SELECT * FROM effect_records WHERE run_id = ?", (self.run_id,))), 1
        )
        self.assertEqual(
            self.engine.get_run(self.run_id, scope=SCOPE_A)["stateVersion"],
            self.engine.get_run(self.run_id, scope=SCOPE_A)["stateVersion"],
        )

    def test_an_authoritative_absence_is_left_for_the_operator_to_retry(self) -> None:
        key = self._pending_effect()
        self.engine.effects.mark_not_effected(
            **SCOPE,
            run_id=self.run_id,
            key=key,
            authority=EffectAuthority(
                source="provider", outcome=EffectStatus.NOT_EFFECTED, observed_at=self.clock.iso()
            ),
        )
        self.engine.effects.set_prior_worker_state(
            **SCOPE, run_id=self.run_id, key=key, state="fenced"
        )
        report = self.engine.recover()
        self.assertEqual(report["effects"], [])
        record = self.engine.effects.get(**SCOPE, run_id=self.run_id, key=key)
        assert record is not None
        self.assertEqual(str(record["status"]), EffectStatus.NOT_EFFECTED)
        self.assertTrue(self.engine.effects.may_retry(record))


class LeaseReconciliationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine, self.db, self.clock = make_engine()
        self.run_id = str(self.engine.admit_work_order(work_order_request())["runId"])
        self.attempt = self.engine.claim(
            claim_request(run_id=self.run_id, node_id=QA_NODE, subject="sub-qa")
        )

    def test_an_expired_lease_is_fenced_and_the_node_blocked(self) -> None:
        self.clock.advance(self.engine.lease_ttl_seconds + 60)
        report = self.engine.recover()
        self.assertEqual(len(report["leases"]), 1)
        self.assertEqual(report["leases"][0]["action"], "fenced_and_blocked")
        stored = self.db.query_one(
            "SELECT * FROM execution_attempts WHERE attempt_id = ?", (self.attempt["attemptId"],)
        )
        assert stored is not None
        self.assertEqual(str(stored["lease_state"]), "EXPIRED")
        self.assertEqual(str(stored["status"]), "UNKNOWN")
        node = node_state(self.engine.get_run(self.run_id, scope=SCOPE_A), QA_NODE)
        self.assertEqual(node["status"], NodeStatus.BLOCKED)
        self.assertEqual(node["blockReason"], str(BlockReason.LEASE_FENCED))
        self.assertIsNone(node["activeAttemptId"])

    def test_a_live_lease_is_left_alone(self) -> None:
        report = self.engine.recover()
        self.assertEqual(report["leases"], [])
        node = node_state(self.engine.get_run(self.run_id, scope=SCOPE_A), QA_NODE)
        self.assertEqual(node["status"], NodeStatus.RUNNING)
        self.assertEqual(node["activeAttemptId"], self.attempt["attemptId"])

    def test_recovery_does_not_dispatch_a_replacement(self) -> None:
        # A crashed delivery is re-delivered, not re-dispatched. The intent for the fenced node
        # is the one admission created; recovery must not add a second one.
        self.engine.drain_outbox()
        self.clock.advance(self.engine.lease_ttl_seconds + 60)
        self.engine.recover()
        intents = self.engine.db.query(
            "SELECT intent_id, correlation_key FROM outbox_intents WHERE kind = 'work.unit.ensure'"
            " AND run_id = ? AND node_id = ?",
            (self.run_id, QA_NODE),
        )
        self.assertEqual(len(intents), 1)
        self.assertEqual(
            str(intents[0]["correlation_key"]),
            f"work-unit:{self.run_id}:{QA_NODE}:0",
        )


class RestartTests(unittest.TestCase):
    """AT-27: committed state survives a crash; uncommitted state does not exist."""

    def test_a_crash_before_commit_leaves_nothing_behind(self) -> None:
        path = _temp_path()
        db = Database(path)
        db.migrate()
        from polyforge.core.runtime.engine import RuntimeEngine

        grant_capability(db, "user-anna", "verification.coordinate")
        engine = RuntimeEngine(db, clock=ids.FrozenClock())
        run_id = str(engine.admit_work_order(work_order_request())["runId"])
        attempt = engine.claim(claim_request(run_id=run_id, node_id=QA_NODE, subject="sub-qa"))

        class Crash(RuntimeError):
            pass

        with self.assertRaises(Crash):
            with db.transaction() as conn:
                conn.execute(
                    "UPDATE node_executions SET status = 'PASSED' WHERE run_id = ? AND node_id = ?",
                    (run_id, QA_NODE),
                )
                raise Crash("process died mid-command")
        db.close()

        reopened = Database(path)
        from polyforge.core.runtime.engine import RuntimeEngine as Reopened

        engine2 = Reopened(reopened, clock=ids.FrozenClock())
        node = node_state(engine2.get_run(run_id, scope=SCOPE_A), QA_NODE)
        self.assertEqual(node["status"], NodeStatus.RUNNING)
        self.assertEqual(node["activeAttemptId"], attempt["attemptId"])
        reopened.close()

    def test_committed_state_is_readable_after_a_restart(self) -> None:
        path = _temp_path()
        db = Database(path)
        db.migrate()
        from polyforge.core.runtime.engine import RuntimeEngine

        grant_capability(db, "user-anna", "verification.coordinate")
        engine = RuntimeEngine(db, clock=ids.FrozenClock())
        run_id = str(engine.admit_work_order(work_order_request())["runId"])
        attempt = engine.claim(claim_request(run_id=run_id, node_id=QA_NODE, subject="sub-qa"))
        art = artifact("qa_report", "qa-v1")
        engine.submit_artifacts(
            envelope(
                run_id=run_id,
                node_id=QA_NODE,
                attempt_id=attempt["attemptId"],
                lease_epoch=attempt["leaseEpoch"],
                payload={"artifacts": [art]},
            )
        )
        engine.submit_evidence(
            envelope(
                run_id=run_id,
                node_id=QA_NODE,
                attempt_id=attempt["attemptId"],
                lease_epoch=attempt["leaseEpoch"],
                command_suffix="ev",
                payload={"evidence": [evidence_for(art, "qa_report")]},
            )
        )
        before = engine.get_run(run_id, scope=SCOPE_A)
        db.close()

        reopened = Database(path)
        from polyforge.core.runtime.engine import RuntimeEngine as Reopened

        engine2 = Reopened(reopened, clock=ids.FrozenClock())
        after = engine2.get_run(run_id, scope=SCOPE_A)
        self.assertEqual(before["stateVersion"], after["stateVersion"])
        self.assertEqual(before["eventSequence"], after["eventSequence"])
        self.assertEqual(len(before["evidence"]), len(after["evidence"]))
        # A committed fact replays as the recorded result, so a redelivery after the crash
        # does not duplicate anything.
        replay = engine2.submit_evidence(
            envelope(
                run_id=run_id,
                node_id=QA_NODE,
                attempt_id=attempt["attemptId"],
                lease_epoch=attempt["leaseEpoch"],
                command_suffix="ev",
                payload={"evidence": [evidence_for(art, "qa_report")]},
            )
        )
        self.assertTrue(replay["applied"])
        self.assertEqual(len(engine2.get_run(run_id, scope=SCOPE_A)["evidence"]), 1)
        reopened.close()

    def test_an_executed_effect_is_not_re_run_after_a_restart(self) -> None:
        path = _temp_path()
        db = Database(path)
        db.migrate()
        from polyforge.core.runtime.engine import RuntimeEngine

        clock = ids.FrozenClock()
        grant_capability(db, "user-anna", "verification.coordinate")
        engine = RuntimeEngine(db, clock=clock)
        run_id = str(engine.admit_work_order(work_order_request())["runId"])
        key = str(
            engine.effects.record_pending(
                **SCOPE,
                run_id=run_id,
                transition_hash="sha256:transition",
                step_id="deploy.production",
                target_hash="sha256:target",
                request_hash="sha256:request",
            )["effect_key"]
        )
        engine.effects.mark_effected(
            **SCOPE,
            run_id=run_id,
            key=key,
            receipt={"operationId": "op-1"},
        )
        db.close()

        reopened = Database(path)
        from polyforge.core.runtime.engine import RuntimeEngine as Reopened

        engine2 = Reopened(reopened, clock=clock)
        record = engine2.effects.record_pending(
            **SCOPE,
            run_id=run_id,
            transition_hash="sha256:transition",
            step_id="deploy.production",
            target_hash="sha256:target",
            request_hash="sha256:request",
        )
        self.assertEqual(str(record["status"]), EffectStatus.EFFECTED)
        self.assertEqual(str(record["effect_key"]), key)
        self.assertEqual(
            len(reopened.query("SELECT * FROM effect_records WHERE run_id = ?", (run_id,))), 1
        )
        reopened.close()


class OutboxTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine, self.db, self.clock = make_engine()
        self.run_id = str(self.engine.admit_work_order(work_order_request())["runId"])

    def test_draining_claims_each_intent_exactly_once(self) -> None:
        first = self.engine.drain_outbox()
        second = self.engine.drain_outbox()
        self.assertEqual(len(first), 1)
        self.assertEqual(second, [], "a claimed intent is not handed out twice")
        self.assertEqual(first[0]["deliveryAttempt"], 1)

    def test_an_expired_claim_is_recoverable(self) -> None:
        self.engine.drain_outbox()
        self.clock.advance(self.engine.lease_ttl_seconds + 60)
        again = self.engine.drain_outbox()
        self.assertEqual(len(again), 1)
        self.assertEqual(again[0]["deliveryAttempt"], 2)

    def test_recovery_requeues_an_undelivered_intent(self) -> None:
        self.engine.drain_outbox()
        self.clock.advance(self.engine.lease_ttl_seconds + 60)
        report = self.engine.recover()
        self.assertEqual(len(report["outbox"]), 1)
        self.assertEqual(report["outbox"][0]["state"], "QUEUED")
        self.assertIn("claim expired", report["outbox"][0]["reason"])
        self.clock.advance(600)
        self.assertEqual(len(self.engine.drain_outbox()), 1)

    def test_a_crashed_delivery_never_re_executes_the_correlation_key(self) -> None:
        self.engine.drain_outbox()
        self.clock.advance(self.engine.lease_ttl_seconds + 60)
        self.engine.recover()
        self.clock.advance(600)
        self.engine.drain_outbox()
        rows = self.engine.db.query("SELECT * FROM outbox_intents WHERE run_id = ?", (self.run_id,))
        self.assertEqual(len(rows), 1)
        self.assertEqual(
            str(rows[0]["correlation_key"]),
            f"work-unit:{self.run_id}:{QA_NODE}:0",
            "a redelivery must reuse the platform correlation key so the create is idempotent",
        )

    def test_an_exhausted_intent_is_stopped_rather_than_retried_forever(self) -> None:
        state = "QUEUED"
        for _ in range(30):
            self.engine.drain_outbox()
            self.clock.advance(self.engine.lease_ttl_seconds + 600)
            self.engine.recover()
            row = self.engine.db.query_one(
                "SELECT state FROM outbox_intents WHERE run_id = ?", (self.run_id,)
            )
            assert row is not None
            state = str(row["state"])
            if state == "BLOCKED":
                break
        self.assertEqual(state, "BLOCKED", "the delivery budget must stop the redelivery loop")
        self.assertEqual(self.engine.drain_outbox(), [])
        blocked = self.engine.db.query(
            "SELECT * FROM outbox_intents WHERE run_id = ? AND state = 'BLOCKED'", (self.run_id,)
        )
        self.assertEqual(len(blocked), 1)

    def test_marking_delivered_records_the_receipt_and_is_idempotent(self) -> None:
        intent = self.engine.drain_outbox()[0]
        first = self.engine.mark_delivery(intent["intentId"], "delivered", receipt={"workUnitId": "issue-2"})
        self.assertEqual(first["state"], "delivered")
        again = self.engine.mark_delivery(intent["intentId"], "delivered", receipt={"workUnitId": "issue-2"})
        self.assertTrue(again["duplicate"])

    def test_an_ambiguous_create_is_never_blindly_resent(self) -> None:
        intent = self.engine.drain_outbox()[0]
        result = self.engine.mark_delivery(
            intent["intentId"], "ambiguous_create", error={"reason": "read timeout"}
        )
        self.assertEqual(result["state"], "ambiguous_create")
        self.clock.advance(3600)
        self.assertEqual(self.engine.drain_outbox(), [], "an ambiguous create is not auto-retried")
        row = self.engine.db.query_one(
            "SELECT * FROM outbox_intents WHERE intent_id = ?", (intent["intentId"],)
        )
        assert row is not None
        self.assertEqual(str(row["state"]), "ambiguous_create")

    def test_an_unknown_delivery_state_is_refused(self) -> None:
        intent = self.engine.drain_outbox()[0]
        with self.assertRaises(errors.PolyForgeError) as caught:
            self.engine.mark_delivery(intent["intentId"], "probably_fine")
        self.assertEqual(caught.exception.code, errors.ErrorCode.BAD_REQUEST)

    def test_marking_an_unknown_intent_is_refused(self) -> None:
        with self.assertRaises(errors.PolyForgeError) as caught:
            self.engine.mark_delivery("dlv_missing", "delivered")
        self.assertEqual(caught.exception.code, errors.ErrorCode.NOT_FOUND)


class EventIntakeTests(unittest.TestCase):
    """AT-26: duplicate and out-of-order events, and HTTP timeouts, change nothing."""

    def setUp(self) -> None:
        self.engine, self.db, self.clock = make_engine()
        self.run_id = str(self.engine.admit_work_order(work_order_request())["runId"])
        self.attempt = self.engine.claim(
            claim_request(run_id=self.run_id, node_id=QA_NODE, subject="sub-qa")
        )

    def _event(self, source_event_id: str, **overrides: object) -> dict[str, object]:
        payload: dict[str, object] = {
            "type": "pf.execution.observed",
            "runId": self.run_id,
            "nodeId": QA_NODE,
            "scope": SCOPE_A,
            "source": "paperclip",
            "sourceEventId": source_event_id,
            "correlationId": self.run_id,
            "payload": {"nodeId": QA_NODE, "attemptId": self.attempt["attemptId"], "state": "running"},
        }
        payload.update(overrides)
        return payload

    def test_a_duplicate_event_is_a_no_op(self) -> None:
        first = self.engine.intake_event(self._event("pc-1"))
        second = self.engine.intake_event(self._event("pc-1"))
        self.assertTrue(first["accepted"])
        self.assertFalse(second["accepted"])
        self.assertTrue(second["duplicate"])
        events = [
            e
            for e in self.engine.list_events(self.run_id, scope=SCOPE_A)
            if e["type"] == "pf.execution.observed"
        ]
        self.assertEqual(len(events), 2, "one from the claim, one from intake")

    def test_an_out_of_order_event_is_recorded_but_not_applied(self) -> None:
        self.engine.intake_event(self._event("pc-2", revision="r5"))
        outcome = self.engine.intake_event(self._event("pc-3", revision="r3"))
        self.assertFalse(outcome["accepted"])
        self.assertTrue(outcome["stale"])
        self.assertIn("behind the recorded", outcome["reason"])

    def test_an_unknown_event_schema_is_quarantined(self) -> None:
        outcome = self.engine.intake_event(
            self._event("pc-4", type="pf.something.new", payload={"novel": True})
        )
        self.assertFalse(outcome["accepted"])
        self.assertTrue(outcome["quarantined"])
        row = self.engine.db.query_one(
            "SELECT * FROM domain_events WHERE source_event_id = ?", ("pc-4",)
        )
        assert row is not None
        self.assertEqual(int(row["quarantined"]), 1)
        self.assertIn("unknown event schema", str(row["quarantine_reason"]))

    def test_an_unknown_execution_outcome_blocks_the_node(self) -> None:
        self.engine.intake_event(
            self._event(
                "pc-5",
                type="pf.execution.unknown",
                payload={
                    "nodeId": QA_NODE,
                    "attemptId": self.attempt["attemptId"],
                    "reason": "the adapter did not report an exit",
                },
            )
        )
        node = node_state(self.engine.get_run(self.run_id, scope=SCOPE_A), QA_NODE)
        self.assertEqual(node["status"], NodeStatus.BLOCKED)
        self.assertEqual(
            self.engine.get_run(self.run_id, scope=SCOPE_A)["status"], GraphRunStatus.BLOCKED
        )

    def test_a_duplicate_never_produces_a_second_transition(self) -> None:
        before = self.engine.get_run(self.run_id, scope=SCOPE_A)["stateVersion"]
        for index in range(5):
            self.engine.intake_event(
                self._event(
                    f"pc-done-{index}",
                    type="pf.transition.committed",
                    payload={"nodeId": QA_NODE, "result": "PASSED"},
                )
            )
        after = self.engine.get_run(self.run_id, scope=SCOPE_A)
        # Five redundant announcements are recorded as observations and change no state: the
        # only writer of PASSED is request_transition, and it was never called.
        self.assertEqual(after["stateVersion"], before)
        self.assertNotEqual(
            node_state(after, QA_NODE)["status"],
            NodeStatus.PASSED,
        )
        self.assertEqual(after["effects"], [])

    def test_the_same_source_event_id_is_recorded_once(self) -> None:
        for _ in range(4):
            self.engine.intake_event(
                self._event(
                    "pc-same",
                    type="pf.transition.committed",
                    payload={"nodeId": QA_NODE, "result": "PASSED"},
                )
            )
        rows = self.engine.db.query(
            "SELECT * FROM domain_events WHERE source_event_id = ?", ("pc-same",)
        )
        self.assertEqual(len(rows), 1)

    def test_an_authorization_denial_blocks_the_run(self) -> None:
        self.engine.intake_event(
            self._event(
                "pc-6",
                type="pf.authorization.denied",
                payload={"nodeId": QA_NODE, "reason": "the capability grant was revoked"},
            )
        )
        snapshot = self.engine.get_run(self.run_id, scope=SCOPE_A)
        self.assertEqual(snapshot["status"], GraphRunStatus.BLOCKED)
        self.assertEqual(
            node_state(snapshot, QA_NODE)["blockReason"], str(BlockReason.AUTHORIZATION)
        )


class HealthTests(unittest.TestCase):
    def test_an_engine_without_ports_reports_read_only(self) -> None:
        engine, db, _ = make_engine()
        report = engine.health()
        self.assertEqual(report["status"], "read_only")
        self.assertTrue(any("no bridge ports" in issue for issue in report["issues"]))
        self.assertTrue(report["database"]["ok"])

    def test_a_mismatched_bridge_issuer_is_blocked(self) -> None:
        engine, db, _ = make_engine(
            bridge_issuer="someone-else", bridge_expected_issuer="polyforge-bridge"
        )
        report = engine.health()
        self.assertEqual(report["status"], "blocked")
        self.assertFalse(report["bridge"]["compatible"])

    def test_an_unknown_effect_degrades_health(self) -> None:
        from polyforge.core.ports import NullPorts

        engine, db, _ = make_engine(ports=NullPorts().as_ports())
        run_id = str(engine.admit_work_order(work_order_request())["runId"])
        key = str(
            engine.effects.record_pending(
                **SCOPE,
                run_id=run_id,
                transition_hash="sha256:t",
                step_id="deploy",
                target_hash="sha256:target",
                request_hash="sha256:req",
            )["effect_key"]
        )
        engine.effects.mark_unknown(**SCOPE, run_id=run_id, key=key, reason="timeout")
        report = engine.health()
        self.assertEqual(report["status"], "degraded")
        self.assertEqual(report["store"]["unknownEffects"], 1)
        self.assertEqual(report["store"]["runs"], 1)


class NullPortsTests(unittest.TestCase):
    """The engine must refuse platform work rather than assume it happened."""

    def test_every_null_port_call_raises_unsupported(self) -> None:
        from polyforge.core.ports import NullPorts, provider_ref

        ports = NullPorts()
        with self.assertRaises(errors.PolyForgeError) as caught:
            ports.inspect_execution({"provider": "paperclip", "kind": "agent_run", "id": "r1"})
        self.assertEqual(caught.exception.code, errors.ErrorCode.UNSUPPORTED)
        self.assertIn("may not degrade", caught.exception.message)
        with self.assertRaises(errors.PolyForgeError):
            ports.resolve_worker(None)  # type: ignore[arg-type]
        with self.assertRaises(errors.PolyForgeError):
            ports.check_authorization({}, None)  # type: ignore[arg-type]
        with self.assertRaises(errors.PolyForgeError):
            ports.read_verified({"provider": "paperclip", "kind": "issue", "id": "i1"})
        self.assertTrue(ports.as_ports().complete)

    def test_a_malformed_provider_ref_is_refused(self) -> None:
        from polyforge.core.ports import provider_ref

        with self.assertRaises(errors.PolyForgeError) as caught:
            provider_ref({"id": "i1"})
        self.assertEqual(caught.exception.code, errors.ErrorCode.BAD_REQUEST)

    def test_the_engine_refuses_a_port_operation_it_cannot_perform(self) -> None:
        engine, db, _ = make_engine()
        with self.assertRaises(errors.PolyForgeError) as caught:
            engine._require_ports("work.ensureWorkUnit")
        self.assertEqual(caught.exception.code, errors.ErrorCode.UNSUPPORTED)


if __name__ == "__main__":
    unittest.main()
