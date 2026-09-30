"""Honest readiness, and the two background loops.

AT-27 (a crash before or after a commit reconciles; a second recovery changes nothing) and the
operational half of AT-11: a run that cannot make progress must say so rather than look healthy.

The health assertions are about the *transition*, not a single value: an instance is expected to
report ``read_only``, then ``degraded`` once work is queued, then ``ready`` once it is drained,
and ``blocked`` the moment its store is unusable. A fixed-status assertion would pass against an
implementation that never changes.
"""

from __future__ import annotations

import copy
import time
import unittest
from datetime import UTC, datetime, timedelta

from polyforge.core import ids
from polyforge.core.errors import ErrorCode
from polyforge.graph_library import load_graph
from polyforge.services.runtime_api import RuntimeService, ServiceConfig
from polyforge.services.runtime_api.app import _OutboxReaperLoop, _ReconcilerLoop
from services.polyforge.tests.runtime_api.fixtures import (
    ISSUER,
    SECRET,
    RuntimeApiCase,
    allow_rule,
    grant,
)


def design_graph() -> dict:
    return copy.deepcopy(load_graph("design"))


def work_order(start_intent: str) -> dict:
    return {
        "commandId": ids.new_id("command"),
        "idempotencyKey": f"admission:{start_intent}:design.start",
        "startIntentId": start_intent,
        "graphId": "design",
        "graphVersion": 1,
        "entrypoint": "design.start",
        "rootIssueRef": {"provider": "paperclip", "kind": "issue", "id": "issue-1"},
        "inputSnapshot": {"requirement_baseline": {"id": "rb-1"}},
        "requiredFacts": {
            "requirement_acceptance": {
                "source": "imp-1",
                "sourceRevision": "rev-7",
                "contentHash": "sha256:" + "ab" * 32,
            }
        },
        "policyRules": [allow_rule()],
        "definition": design_graph(),
    }


class HealthTransitionTests(RuntimeApiCase):
    def setUp(self) -> None:
        super().setUp()
        grant(self.db, "agent-designer", "design.coordinate")

    def test_a_fresh_instance_with_no_queue_reports_ready(self) -> None:
        status, body, _ = self.client.call("GET", "/v1/health")
        self.assertEqual(status, 200, msg=body)
        self.assertEqual(body["status"], "ready", msg=body)
        self.assertTrue(body["database"]["ok"])
        self.assertTrue(body["bridge"]["compatible"])
        self.assertEqual(body["bridge"]["expectedIssuer"], ISSUER)
        self.assertEqual(body["instanceRole"], "runtime")
        self.assertTrue(body["acceptingAdmissions"])

    def test_queued_work_degrades_the_report(self) -> None:
        status, admitted, _ = self.client.call(
            "POST", "/v1/work-orders", work_order("health-1")
        )
        self.assertEqual(status, 201, msg=admitted)
        _, health, _ = self.client.call("GET", "/v1/health")
        self.assertEqual(health["status"], "degraded", msg=health)
        self.assertGreater(health["store"]["outboxPending"], 0)
        self.assertTrue(any("awaiting delivery" in issue for issue in health["issues"]))

    def test_draining_the_queue_returns_the_report_to_ready(self) -> None:
        self.client.call("POST", "/v1/work-orders", work_order("health-2"))
        _, batch, _ = self.client.call("GET", "/v1/bridge/outbox?limit=50")
        self.assertGreater(batch["count"], 0)
        for intent in batch["intents"]:
            self.engine.mark_delivery(intent["intentId"], "delivered", receipt={"ok": True})
        _, health, _ = self.client.call("GET", "/v1/health")
        self.assertEqual(health["status"], "ready", msg=health)

    def test_a_read_only_instance_refuses_admissions_and_says_so(self) -> None:
        self.service.config = self.service.config.with_overrides(read_only=True)
        _, health, _ = self.client.call("GET", "/v1/health")
        self.assertEqual(health["status"], "read_only", msg=health)
        self.assertFalse(health["acceptingAdmissions"])
        self.assertTrue(any("read-only" in issue for issue in health["issues"]))
        status, body, _ = self.client.call("POST", "/v1/work-orders", work_order("health-3"))
        self.assertError(status, body, ErrorCode.RUN_BLOCKED.value)

    def test_an_unusable_store_reports_blocked_not_an_exception(self) -> None:
        """A process that cannot read its own state must still answer, with ``blocked``."""
        service = RuntimeService(
            ServiceConfig(
                db="/proc/polyforge-not-a-database/path.db",
                bridge_issuer=ISSUER,
                bridge_secret=SECRET,
            ),
            clock=self.clock,
        )
        try:
            report = service.health()
            self.assertEqual(report["status"], "blocked")
            self.assertFalse(report["database"]["ok"])
            self.assertTrue(report["issues"])
            status, body, _ = self.client.call("GET", "/v1/health")
            self.assertEqual(status, 200, msg=body)
        finally:
            service.stop()

    def test_a_bridge_issuer_mismatch_reports_blocked(self) -> None:
        self.engine.bridge_expected_issuer = "a-different-bridge"
        _, health, _ = self.client.call("GET", "/v1/health")
        self.assertEqual(health["status"], "blocked", msg=health)
        self.assertFalse(health["bridge"]["compatible"])
        self.assertTrue(any("does not match" in issue for issue in health["issues"]))

    def test_liveness_never_depends_on_the_store(self) -> None:
        status, body, _ = self.client.call("GET", "/v1/health/live", sign=False)
        self.assertEqual(status, 200, msg=body)
        self.assertEqual(body["status"], "alive")
        self.assertNotIn("store", body)
        self.assertNotIn("runs", body)

    def test_liveness_answers_for_a_process_whose_store_is_unusable(self) -> None:
        service = RuntimeService(
            ServiceConfig(
                db="/proc/polyforge-not-a-database/path.db",
                bridge_issuer=ISSUER,
                bridge_secret=SECRET,
            ),
            clock=self.clock,
        )
        try:
            self.assertEqual(service.health()["status"], "blocked")
            request = self._request("/v1/health/live")
            response = service.dispatch(request)
            self.assertEqual(response.status, 200)
        finally:
            service.stop()

    def test_readiness_returns_503_for_read_only_and_blocked(self) -> None:
        self.assertEqual(self.client.call("GET", "/v1/health/ready")[0], 200)
        self.service.config = self.service.config.with_overrides(read_only=True)
        status, body, _ = self.client.call("GET", "/v1/health/ready")
        self.assertEqual(status, 503, msg=body)
        self.assertEqual(body["status"], "read_only")

    def test_readiness_stays_200_while_degraded(self) -> None:
        """A backlog does not mean the process cannot serve, so it stays in rotation."""
        self.client.call("POST", "/v1/work-orders", work_order("health-4"))
        status, body, _ = self.client.call("GET", "/v1/health/ready")
        self.assertEqual(status, 200, msg=body)
        self.assertEqual(body["status"], "degraded")

    def test_the_report_names_the_background_loops(self) -> None:
        _, body, _ = self.client.call("GET", "/v1/health")
        self.assertIn("reconciler", body["backgrounds"])
        self.assertIn("outbox", body["backgrounds"])
        self.assertEqual(body["backgrounds"]["outbox"]["mode"], "poll")

    def test_a_service_wires_a_registry_into_an_injected_engine(self) -> None:
        """The engine and the authoring routes must resolve versions in the same store.

        An engine handed in without a registry would otherwise keep resolving versions with no
        authority behind it, so the service hands it the store it built over its own database.
        """
        from polyforge.core.registry.store import RegistryStore
        from polyforge.core.runtime.engine import RuntimeEngine

        service = RuntimeService(
            self.config,
            engine=RuntimeEngine(self.db, clock=self.clock, bridge_issuer=ISSUER),
            database=self.db,
            clock=self.clock,
        )
        try:
            self.assertIsInstance(service.registry, RegistryStore)
            self.assertIs(service.engine.registry, service.registry)
            report = service.health()
            self.assertTrue(report["store"]["registryWired"])
            self.assertNotEqual(report["status"], "blocked")
        finally:
            service.stop()

    def test_health_is_blocked_when_the_registry_is_not_wired(self) -> None:
        """A Core that cannot resolve a published version must not look like a healthy one."""
        self.service._engine.registry = None
        status, health, _ = self.client.call("GET", "/v1/health")
        self.assertEqual(status, 200, msg=health)
        self.assertEqual(health["status"], "blocked")
        self.assertFalse(health["store"]["registryWired"])
        self.assertTrue(any("graph registry" in issue for issue in health["issues"]))
        # And an admission that needs a published version is refused rather than guessed.
        body = work_order("health-5")
        body.pop("definition")
        admitted_status, admission, _ = self.client.call("POST", "/v1/work-orders", body)
        self.assertError(admitted_status, admission, ErrorCode.UNSUPPORTED.value)

    def _request(self, target: str):
        from polyforge.services.runtime_api.router import Request

        return Request.build("GET", target, {}, b"", peer="test")


class ReconcilerTests(RuntimeApiCase):
    """AT-27: recovery is idempotent, so running it on a timer is safe."""

    def test_two_recover_calls_produce_the_same_state(self) -> None:
        grant(self.db, "agent-designer", "design.coordinate")
        status, admitted, _ = self.client.call(
            "POST", "/v1/work-orders", work_order("recover-1")
        )
        self.assertEqual(status, 201, msg=admitted)
        run_id = str(admitted["runId"])
        first_report = self.service.recover_once()
        after_first = self.client.call("GET", f"/v1/runs/{run_id}")[1]
        second_report = self.service.recover_once()
        after_second = self.client.call("GET", f"/v1/runs/{run_id}")[1]
        self.assertEqual(first_report, second_report)
        self.assertEqual(after_first, after_second)

    def test_recovery_is_idempotent_across_many_passes(self) -> None:
        grant(self.db, "agent-designer", "design.coordinate")
        _, admitted, _ = self.client.call("POST", "/v1/work-orders", work_order("recover-2"))
        run_id = str(admitted["runId"])
        self.service.recover_once()
        baseline = self.client.call("GET", f"/v1/runs/{run_id}")[1]
        for _ in range(5):
            self.service.recover_once()
        self.assertEqual(self.client.call("GET", f"/v1/runs/{run_id}")[1], baseline)

    def test_recovery_does_not_re_run_a_committed_transition(self) -> None:
        grant(self.db, "agent-designer", "design.coordinate")
        grant(self.db, "agent-architect", "architecture.design")
        _, admitted, _ = self.client.call("POST", "/v1/work-orders", work_order("recover-3"))
        run_id = str(admitted["runId"])
        _, attempt, _ = self.client.call(
            "POST",
            f"/v1/runs/{run_id}/claims",
            {
                "commandId": ids.new_id("command"),
                "nodeId": "architecture",
                "iteration": 0,
                "agentSubject": "agent-architect",
            },
        )
        common = {
            "nodeId": "architecture",
            "attemptId": attempt["attemptId"],
            "leaseEpoch": attempt["leaseEpoch"],
        }
        kinds = ("architecture_spec", "api_contract")
        artifacts = [
            {
                "kind": kind,
                "contentHash": "sha256:" + ("ab" if kind == "architecture_spec" else "cd") * 32,
                "mediaType": "application/json",
                "size": 64,
                "source": {"kind": "attachment", "ref": f"attachment:{kind}"},
            }
            for kind in kinds
        ]
        self.client.call(
            "POST",
            f"/v1/runs/{run_id}/artifacts",
            {
                **common,
                "commandId": ids.new_id("command"),
                "idempotencyKey": "recover:artifacts:1",
                "payload": {"artifacts": artifacts},
            },
        )
        _, evidence, _ = self.client.call(
            "POST",
            f"/v1/runs/{run_id}/evidence",
            {
                **common,
                "commandId": ids.new_id("command"),
                "idempotencyKey": "recover:evidence:1",
                "payload": {
                    "evidence": [
                        {
                            "kind": kind,
                            "artifacts": [
                                {
                                    "artifactId": f"submitted-{kind}",
                                    "kind": kind,
                                    "contentHash": artifact["contentHash"],
                                    "mediaType": "application/json",
                                    "size": 64,
                                }
                            ],
                            "detail": {"note": "submitted"},
                        }
                        for kind, artifact in zip(kinds, artifacts, strict=True)
                    ]
                },
            },
        )
        transition_status, transition, _ = self.client.call(
            "POST",
            f"/v1/runs/{run_id}/transitions",
            {
                **common,
                "commandId": ids.new_id("command"),
                "idempotencyKey": "recover:transition:1",
                "payload": {
                    "evidenceIds": list(evidence["resultRef"].split(",")),
                    "summary": "done",
                },
            },
        )
        self.assertEqual(transition_status, 200, msg=transition)
        self.assertTrue(transition["applied"], msg=transition)
        before = self.client.call("GET", f"/v1/runs/{run_id}")[1]
        self.service.recover_once()
        after = self.client.call("GET", f"/v1/runs/{run_id}")[1]
        node = next(n for n in after["nodes"] if n["nodeId"] == "architecture")
        self.assertEqual(node["status"], "PASSED")
        # Nothing moved: no new attempt, no new state version, no re-emitted event.
        self.assertEqual(after["stateVersion"], before["stateVersion"])
        self.assertEqual(after["eventSequence"], before["eventSequence"])
        self.assertEqual(len(after["attempts"]), 1)

    def test_the_reconciler_loop_runs_and_records_its_passes(self) -> None:
        loop = _ReconcilerLoop(self.service, interval=0.02)
        loop.start()
        try:
            deadline = time.monotonic() + 5.0
            while loop.runs < 2 and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertGreaterEqual(loop.runs, 2)
            self.assertIsNone(loop.last_error)
            self.assertIsNotNone(loop.last_run_at)
        finally:
            loop.request_stop()
            loop.join(timeout=5.0)
        self.assertFalse(loop.is_alive())

    def test_a_loop_whose_pass_raises_keeps_going(self) -> None:
        """A transient database error must not end reconciliation forever."""
        calls: list[int] = []

        def boom() -> dict:
            calls.append(1)
            if len(calls) < 3:
                raise RuntimeError("transient")
            return {}

        self.service.recover_once = boom  # type: ignore[method-assign]
        loop = _ReconcilerLoop(self.service, interval=0.01)
        loop.start()
        try:
            deadline = time.monotonic() + 5.0
            while loop.runs < 1 and time.monotonic() < deadline:
                time.sleep(0.01)
        finally:
            loop.request_stop()
            loop.join(timeout=5.0)
        self.assertGreaterEqual(len(calls), 3)
        self.assertIsNone(loop.last_error)

    def test_starting_the_service_starts_both_loops(self) -> None:
        self.service.config = self.service.config.with_overrides(
            reconciler_interval_seconds=0.02, outbox_interval_seconds=0.02
        )
        self.service.start()
        try:
            deadline = time.monotonic() + 5.0
            while (
                not (self.service.reconciler_status()["running"] and self.service.outbox_status()["running"])
                and time.monotonic() < deadline
            ):
                time.sleep(0.01)
            self.assertTrue(self.service.reconciler_status()["running"])
            self.assertTrue(self.service.outbox_status()["running"])
        finally:
            self.service.stop()
        self.assertFalse(self.service.reconciler_status()["running"])


class OutboxCrashSafetyTests(RuntimeApiCase):
    """AT-27: a claim is a lease, so a bridge that dies mid-delivery loses at most one lease."""

    def setUp(self) -> None:
        super().setUp()
        grant(self.db, "agent-designer", "design.coordinate")

    def _admit(self) -> str:
        status, body, _ = self.client.call(
            "POST", "/v1/work-orders", work_order(f"outbox-{ids.new_id('i')[:8]}")
        )
        self.assertEqual(status, 201, msg=body)
        return str(body["runId"])

    def test_a_claimed_intent_is_not_handed_out_twice_while_the_lease_holds(self) -> None:
        self._admit()
        scope = {"companyRef": "company-a", "projectRef": "project-a"}
        first = self.service.claim_outbox(scope, 50)
        self.assertTrue(first)
        second = self.service.claim_outbox(scope, 50)
        self.assertEqual(
            [i["intentId"] for i in second],
            [],
            msg="a live lease is not a lock the next poll can steal",
        )

    def test_an_expired_claim_returns_to_the_queue(self) -> None:
        self._admit()
        scope = {"companyRef": "company-a", "projectRef": "project-a"}
        claimed = self.service.claim_outbox(scope, 50)
        intent_id = claimed[0]["intentId"]
        past = (
            (datetime.now(UTC) - timedelta(seconds=60))
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z")
        )
        self.db.execute(
            "UPDATE outbox_intents SET claim_expires_at = ? WHERE intent_id = ?", (past, intent_id)
        )
        reaped = self.service.reap_outbox_claims()
        self.assertEqual(reaped, 1)
        row = self.db.query_one("SELECT * FROM outbox_intents WHERE intent_id = ?", (intent_id,))
        self.assertEqual(row["state"], "QUEUED")
        self.assertIsNone(row["claim_owner"])
        reclaimed = self.service.claim_outbox(scope, 50)
        self.assertIn(intent_id, [i["intentId"] for i in reclaimed])
        self.assertEqual(reclaimed[0]["deliveryAttempt"], 2)

    def test_the_reaper_leaves_a_live_lease_alone(self) -> None:
        self._admit()
        claimed = self.service.claim_outbox(
            {"companyRef": "company-a", "projectRef": "project-a"}, 50
        )
        self.assertEqual(self.service.reap_outbox_claims(), 0)
        row = self.db.query_one(
            "SELECT * FROM outbox_intents WHERE intent_id = ?", (claimed[0]["intentId"],)
        )
        self.assertEqual(row["state"], "CLAIMED")

    def test_the_reaper_is_idempotent(self) -> None:
        self._admit()
        self.service.claim_outbox({"companyRef": "company-a", "projectRef": "project-a"}, 50)
        past = (
            (datetime.now(UTC) - timedelta(seconds=60))
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z")
        )
        self.db.execute("UPDATE outbox_intents SET claim_expires_at = ?", (past,))
        self.assertEqual(self.service.reap_outbox_claims(), 1)
        self.assertEqual(self.service.reap_outbox_claims(), 0)

    def test_an_acknowledgement_settles_the_intent(self) -> None:
        self._admit()
        status, batch, _ = self.client.call("GET", "/v1/bridge/outbox?limit=50")
        self.assertEqual(status, 200, msg=batch)
        intent_id = batch["intents"][0]["intentId"]
        ack_status, ack, _ = self.client.call(
            "POST",
            f"/v1/bridge/outbox/{intent_id}/delivery",
            {"state": "delivered", "receipt": {"providerRef": {"id": "issue-1"}}},
        )
        self.assertEqual(ack_status, 200, msg=ack)
        self.assertEqual(ack["state"], "delivered")
        again, duplicate, _ = self.client.call(
            "POST",
            f"/v1/bridge/outbox/{intent_id}/delivery",
            {"state": "delivered", "receipt": {"providerRef": {"id": "issue-1"}}},
        )
        self.assertEqual(again, 200, msg=duplicate)
        self.assertTrue(duplicate["duplicate"])

    def test_an_ambiguous_create_marks_the_effect_unknown_rather_than_retrying(self) -> None:
        self._admit()
        _, batch, _ = self.client.call("GET", "/v1/bridge/outbox?limit=50")
        intent_id = batch["intents"][0]["intentId"]
        status, ack, _ = self.client.call(
            "POST",
            f"/v1/bridge/outbox/{intent_id}/delivery",
            {"state": "ambiguous_create", "error": {"message": "timed out"}},
        )
        self.assertEqual(status, 200, msg=ack)
        self.assertEqual(ack["state"], "ambiguous_create")

    def test_an_unknown_delivery_state_is_a_400(self) -> None:
        self._admit()
        _, batch, _ = self.client.call("GET", "/v1/bridge/outbox?limit=50")
        status, body, _ = self.client.call(
            "POST",
            f"/v1/bridge/outbox/{batch['intents'][0]['intentId']}/delivery",
            {"state": "probably-fine"},
        )
        self.assertError(status, body, ErrorCode.BAD_REQUEST.value)

    def test_an_unknown_intent_is_a_404(self) -> None:
        status, body, _ = self.client.call(
            "POST", "/v1/bridge/outbox/int_nope/delivery", {"state": "delivered"}
        )
        self.assertError(status, body, ErrorCode.NOT_FOUND.value)

    def test_the_outbox_poll_reports_its_lease_length(self) -> None:
        self._admit()
        _, batch, _ = self.client.call("GET", "/v1/bridge/outbox?limit=50")
        self.assertEqual(batch["leaseSeconds"], self.config.outbox_lease_seconds)
        for intent in batch["intents"]:
            self.assertIsNotNone(intent["claimExpiresAt"])
            self.assertEqual(intent["scope"], {"companyRef": "company-a", "projectRef": "project-a"})

    def test_the_outbox_reaper_loop_records_its_lapses(self) -> None:
        self._admit()
        self.service.claim_outbox({"companyRef": "company-a", "projectRef": "project-a"}, 50)
        past = (
            (datetime.now(UTC) - timedelta(seconds=60))
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z")
        )
        self.db.execute("UPDATE outbox_intents SET claim_expires_at = ?", (past,))
        loop = _OutboxReaperLoop(self.service, interval=0.02)
        loop.start()
        try:
            deadline = time.monotonic() + 5.0
            while loop.lapsed < 1 and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertGreaterEqual(loop.lapsed, 1)
        finally:
            loop.request_stop()
            loop.join(timeout=5.0)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
