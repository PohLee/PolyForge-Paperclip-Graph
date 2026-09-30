"""Every served route, its documented status, and the error mapping.

Covers the parts of ``docs/05-PROTOCOL.md`` section 3 that are about the *transport* rather
than about engineering behaviour: that each route answers with the status it is documented to,
that a ``PolyForgeError`` reaches the wire as its own code and status, and that the event
cursor is monotonic and gap free.

The error-mapping test drives the mapping directly rather than through handlers, because the
property is "every code in ``ERROR_STATUS`` maps to its own status", and a handler can only
ever produce a few of them.
"""

from __future__ import annotations

import copy
import json
import unittest

from polyforge.core import errors, ids
from polyforge.core.errors import ERROR_CODES, ERROR_STATUS, ErrorCode
from polyforge.graph_library import load_graph
from polyforge.services.runtime_api import errors as apierrors
from polyforge.services.runtime_api.router import ENDPOINTS, API_BASE_PATH, Router
from services.polyforge.tests.runtime_api.fixtures import (
    AUTHOR,
    RuntimeApiCase,
    agent_actor,
    allow_rule,
    grant,
)

AUTHOR_ACTOR = {"actorType": "human", "actorId": AUTHOR, "roles": ["polyforge.author"]}
PUBLISHER_ACTOR = {
    "actorType": "human",
    "actorId": AUTHOR,
    "roles": ["polyforge.author", "polyforge.publisher"],
}


def design_graph() -> dict:
    return copy.deepcopy(load_graph("design"))


def work_order(start_intent: str, **overrides) -> dict:
    body = {
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
    body.update(overrides)
    return body


class RoutingTests(RuntimeApiCase):
    def test_an_unknown_path_is_a_404(self) -> None:
        status, body, _ = self.client.call("GET", "/v1/nope")
        error = self.assertError(status, body, ErrorCode.NOT_FOUND.value)
        self.assertEqual(error["details"]["path"], "/nope")

    def test_a_wrong_method_on_a_real_path_is_a_405(self) -> None:
        status, body, _ = self.client.call("PUT", "/v1/runs")
        self.assertEqual(status, 405, msg=body)
        self.assertIn("allowed", body["error"]["details"])

    def test_a_path_parameter_never_spans_a_separator(self) -> None:
        status, body, _ = self.client.call("GET", "/v1/runs/run/extra")
        self.assertError(status, body, ErrorCode.NOT_FOUND.value)

    def test_an_empty_path_segment_is_not_a_match(self) -> None:
        status, body, _ = self.client.call("GET", "/v1/runs//events")
        self.assertError(status, body, ErrorCode.NOT_FOUND.value)

    def test_every_endpoint_declares_a_handler(self) -> None:
        for endpoint in ENDPOINTS:
            self.assertTrue(
                hasattr(self.service, f"_handle_{endpoint.name}"),
                msg=f"{endpoint.method} {endpoint.path} has no handler",
            )

    def test_every_endpoint_declares_only_known_failure_codes(self) -> None:
        for endpoint in ENDPOINTS:
            for code in endpoint.failure_codes:
                self.assertIn(code, ERROR_CODES, msg=f"{endpoint.name}: {code}")

    def test_a_shutting_down_instance_refuses_with_503(self) -> None:
        self.service.stop()
        status, body, _ = self.client.call("GET", "/v1/runs")
        self.assertError(status, body, ErrorCode.CONTROL_PLANE_UNAVAILABLE.value)


class ErrorMappingTests(unittest.TestCase):
    """``ERROR_STATUS`` is the contract; the transport must not renumber anything."""

    def test_every_core_error_code_maps_to_its_documented_status(self) -> None:
        for code, status in ERROR_STATUS.items():
            exc = errors.PolyForgeError(code, f"synthetic {code.value}")
            response = apierrors.response_for(exc, "cor_test")
            self.assertEqual(response.status, status, msg=code.value)
            body = json.loads(response.body.decode("utf-8"))
            self.assertEqual(body["error"]["code"], code.value)
            self.assertNotIn("details", body["error"])

    def test_details_and_pending_reason_survive_the_mapping(self) -> None:
        exc = errors.PolyForgeError(
            ErrorCode.VERSION_CONFLICT,
            "stale",
            details={"currentVersion": 7},
            pending_reason="awaiting_review",
        )
        body = json.loads(apierrors.response_for(exc, "cor_test").body.decode("utf-8"))
        self.assertEqual(body["error"]["details"]["currentVersion"], 7)
        self.assertEqual(body["error"]["pendingReason"], "awaiting_review")

    def test_an_explicit_status_overrides_the_table(self) -> None:
        exc = errors.PolyForgeError(ErrorCode.UNSUPPORTED, "wrong verb", status=405)
        self.assertEqual(apierrors.response_for(exc, "cor_test").status, 405)

    def test_a_reconcile_required_code_carries_retry_after(self) -> None:
        exc = errors.PolyForgeError(ErrorCode.CONTROL_PLANE_UNAVAILABLE, "down")
        response = apierrors.response_for(exc, "cor_test")
        self.assertIn(("Retry-After", "5"), response.header_map().items())

    def test_an_unexpected_exception_leaks_nothing(self) -> None:
        response = apierrors.internal_error("cor_abc123", exc=KeyError("plan_hash"))
        self.assertEqual(response.status, 500)
        body = json.loads(response.body.decode("utf-8"))
        self.assertEqual(body["error"]["code"], "INTERNAL")
        self.assertEqual(body["error"]["details"], {"correlationId": "cor_abc123"})
        self.assertNotIn("plan_hash", json.dumps(body))
        self.assertNotIn("KeyError", json.dumps(body))

    def test_a_handler_crash_becomes_a_correlation_only_500(self) -> None:
        """The transport's last line of defence, exercised through a real dispatch."""
        case = RuntimeApiCase("run")
        case.setUp()
        try:

            def explode(_ctx: object) -> object:
                raise RuntimeError("the internal shape is not what you think")

            case.service._handle_get_run = explode  # type: ignore[method-assign]
            status, body, headers = case.client.call("GET", "/v1/runs/run_x")
            self.assertEqual(status, 500, msg=body)
            self.assertNotIn("not what you think", json.dumps(body))
            self.assertIn("X-PF-Correlation-Id", headers)
            self.assertEqual(body["error"]["details"]["correlationId"], headers["X-PF-Correlation-Id"])
        finally:
            case.doCleanups()


class MethodAndPathTableTests(unittest.TestCase):
    """The literal table, so a rename is caught here rather than by a client at runtime."""

    def test_a_path_is_served_by_at_most_one_method(self) -> None:
        seen: dict[str, set[str]] = {}
        for endpoint in ENDPOINTS:
            seen.setdefault(endpoint.path, set()).add(endpoint.method)
        for path, methods in seen.items():
            for method in methods:
                matches = [
                    other
                    for other in ENDPOINTS
                    if other.method == method
                    and other.pattern().match(
                        path.replace("{graphId}", "g").replace("{draftId}", "d")
                        .replace("{runId}", "r").replace("{requestId}", "q")
                        .replace("{version}", "1").replace("{intentId}", "i")
                    )
                ]
                self.assertEqual(len(matches), 1, msg=f"{method} {path} matches {len(matches)}")

    def test_a_literal_route_is_never_shadowed_by_a_pattern(self) -> None:
        router = Router(ENDPOINTS)
        for endpoint in ENDPOINTS:
            if "{" in endpoint.path:
                continue
            resolved, params = router.resolve(endpoint.method, endpoint.path)
            self.assertEqual(resolved.path, endpoint.path)
            self.assertEqual(params, {})

    def test_a_resolved_path_keeps_its_parameters(self) -> None:
        router = Router(ENDPOINTS)
        resolved, params = router.resolve("GET", "/runs/run_123")
        self.assertEqual(resolved.name, "get_run")
        self.assertEqual(params, {"runId": "run_123"})

    def test_a_resolved_path_decodes_percent_encoding(self) -> None:
        router = Router(ENDPOINTS)
        _, params = router.resolve("GET", "/graphs/g%20one/drafts")
        self.assertEqual(params, {"graphId": "g one"})

    def test_every_path_is_under_the_api_base(self) -> None:
        for endpoint in ENDPOINTS:
            self.assertTrue(endpoint.full_path.startswith(f"{API_BASE_PATH}/"), msg=endpoint.path)


class DocumentedStatusTests(RuntimeApiCase):
    """Each route answers with the status the table declares."""

    def setUp(self) -> None:
        super().setUp()
        grant(self.db, "agent-designer", "design.coordinate")
        grant(self.db, "agent-architect", "architecture.design")
        grant(self.db, "agent-security", "security.review")
        grant(self.db, "operator-1", "run.control", )

    def _run(self) -> str:
        status, body, _ = self.client.call(
            "POST", "/v1/work-orders", work_order("surface-1", commandId=ids.new_id("command"))
        )
        self.assertEqual(status, 201, msg=body)
        return str(body["runId"])

    def test_authoring_routes_answer_their_documented_status(self) -> None:
        status, draft, headers = self.client.call(
            "POST", "/v1/graphs/design/drafts", {"definition": design_graph()}, actor=AUTHOR_ACTOR
        )
        self.assertEqual(status, 201, msg=draft)
        draft_id = draft["draftId"]
        self.assertEqual(headers["ETag"], '"1"')

        self.assertEqual(self.client.call("GET", "/v1/graphs/design/drafts", actor=AUTHOR_ACTOR)[0], 200)
        self.assertEqual(self.client.call("GET", f"/v1/drafts/{draft_id}")[0], 200)
        patch_status, patched, patch_headers = self.client.call(
            "PATCH",
            f"/v1/drafts/{draft_id}",
            {"definition": design_graph()},
            headers={"If-Match": '"1"'},
            actor=AUTHOR_ACTOR,
        )
        self.assertEqual(patch_status, 200, msg=patched)
        self.assertEqual(patch_headers["ETag"], '"2"')
        self.assertEqual(
            self.client.call("POST", f"/v1/drafts/{draft_id}/validate", actor=AUTHOR_ACTOR)[0], 200
        )
        self.assertEqual(
            self.client.call("POST", f"/v1/drafts/{draft_id}/compile", actor=AUTHOR_ACTOR)[0], 200
        )
        self.assertEqual(
            self.client.call(
                "POST",
                f"/v1/drafts/{draft_id}/reviews",
                {"reviewTargetHash": "sha256:" + "ef" * 32},
                actor={"actorType": "human", "actorId": "user-bob", "roles": ["polyforge.author"]},
            )[0],
            200,
        )
        self.assertEqual(self.client.call("GET", "/v1/graphs/design/versions")[0], 200)
        self.assertEqual(
            self.client.call(
                "POST",
                "/v1/graphs/design/activate",
                {"version": 1, "expectedGeneration": 0},
                actor=PUBLISHER_ACTOR,
            )[0],
            404,
        )
        self.assertEqual(
            self.client.call(
                "POST",
                "/v1/graphs/design/activate",
                {"version": 1},
                actor=PUBLISHER_ACTOR,
            )[0],
            400,
        )
        self.assertEqual(self.client.call("GET", "/v1/graphs/design/diff?to=1")[0], 404)
        self.assertEqual(self.client.call("DELETE", f"/v1/drafts/{draft_id}", actor=AUTHOR_ACTOR)[0], 204)

    def test_execution_read_routes_answer_their_documented_status(self) -> None:
        run_id = self._run()
        self.assertEqual(self.client.call("GET", "/v1/runs")[0], 200)
        self.assertEqual(self.client.call("GET", f"/v1/runs/{run_id}")[0], 200)
        self.assertEqual(self.client.call("GET", f"/v1/runs/{run_id}/events")[0], 200)
        self.assertEqual(self.client.call("GET", f"/v1/runs/{run_id}/refusals")[0], 200)
        self.assertEqual(
            self.client.call(
                "GET",
                f"/v1/runs/{run_id}/current",
                actor=agent_actor("agent-architect"),
            )[0],
            200,
        )
        self.assertEqual(self.client.call("POST", f"/v1/runs/{run_id}/current", {})[0], 405)

    def test_get_current_cannot_be_used_to_take_over_a_worker(self) -> None:
        run_id = self._run()
        status, body, _ = self.client.call(
            "GET",
            f"/v1/runs/{run_id}/current?adopt=true&priorWorkerState=stopped",
            actor=agent_actor("agent-architect"),
        )
        self.assertError(status, body, ErrorCode.BAD_REQUEST.value)
        self.assertEqual(len(self.client.call("GET", f"/v1/runs/{run_id}")[1]["attempts"]), 0)

    def test_a_replacement_claim_without_bridge_stop_observation_is_refused(self) -> None:
        """AT-28: lease expiry alone cannot transfer ownership."""
        run_id = self._run()
        self.client.call(
            "POST",
            f"/v1/runs/{run_id}/claims",
            {
                "commandId": ids.new_id("command"),
                "nodeId": "architecture",
                "iteration": 0,
                "agentSubject": "agent-architect",
            },
        )
        status, body, _ = self.client.call(
            "POST", f"/v1/runs/{run_id}/claims",
            {
                "commandId": ids.new_id("command"),
                "nodeId": "architecture",
                "iteration": 0,
                "agentSubject": "agent-architect-2",
                "leaseEpoch": 2,
            },
            actor=agent_actor("agent-architect-2"),
        )
        self.assertIn(status, (409, 423), msg=body)
        self.assertEqual(len(self.client.call("GET", f"/v1/runs/{run_id}")[1]["attempts"]), 1)

    def test_a_bridge_confirmed_stop_allows_the_replacement_agent_to_claim(self) -> None:
        run_id = self._run()
        self.client.call(
            "POST",
            f"/v1/runs/{run_id}/claims",
            {
                "commandId": ids.new_id("command"),
                "nodeId": "architecture",
                "iteration": 0,
                "agentSubject": "agent-architect",
            },
        )
        status, view, _ = self.client.call(
            "POST",
            f"/v1/runs/{run_id}/claims",
            {
                "commandId": ids.new_id("command"),
                "nodeId": "architecture",
                "iteration": 0,
                "agentSubject": "agent-architect-2",
                "priorWorkerState": "stopped",
                "leaseEpoch": 2,
            },
            actor=agent_actor("agent-architect-2"),
        )
        self.assertEqual(status, 200, msg=view)
        self.assertEqual(int(view["leaseEpoch"]), 2)
        self.assertEqual(view["agentSubject"], "agent-architect-2")

    def test_claim_and_submissions_answer_their_documented_status(self) -> None:
        run_id = self._run()
        status, attempt, _ = self.client.call(
            "POST",
            f"/v1/runs/{run_id}/claims",
            {
                "commandId": ids.new_id("command"),
                "nodeId": "architecture",
                "iteration": 0,
                "agentSubject": "agent-architect",
                "agentRunRef": {"provider": "paperclip", "kind": "agent_run", "id": "ar-1"},
                "issueRef": {"provider": "paperclip", "kind": "issue", "id": "issue-a"},
            },
        )
        self.assertEqual(status, 200, msg=attempt)
        envelope = {
            "commandId": ids.new_id("command"),
            "idempotencyKey": "surface:artifacts:1",
            "nodeId": "architecture",
            "attemptId": attempt["attemptId"],
            "leaseEpoch": attempt["leaseEpoch"],
            "payload": {
                "artifacts": [
                    {
                        "kind": "architecture_spec",
                        "contentHash": "sha256:" + "ab" * 32,
                        "mediaType": "application/json",
                        "size": 64,
                        "source": {"kind": "attachment", "ref": "attachment:a"},
                    }
                ]
            },
        }
        self.assertEqual(
            self.client.call("POST", f"/v1/runs/{run_id}/artifacts", envelope)[0], 200
        )

    def test_a_help_request_is_always_202(self) -> None:
        run_id = self._run()
        status, attempt, _ = self.client.call(
            "POST",
            f"/v1/runs/{run_id}/claims",
            {
                "commandId": ids.new_id("command"),
                "nodeId": "architecture",
                "iteration": 0,
                "agentSubject": "agent-architect",
            },
        )
        self.assertEqual(status, 200, msg=attempt)
        help_status, body, _ = self.client.call(
            "POST",
            f"/v1/runs/{run_id}/help",
            {
                "commandId": ids.new_id("command"),
                "idempotencyKey": "surface:help:1",
                "nodeId": "architecture",
                "attemptId": attempt["attemptId"],
                "leaseEpoch": attempt["leaseEpoch"],
                "payload": {"kind": "clarification", "question": "which API version?"},
            },
        )
        self.assertEqual(help_status, 202, msg=body)
        self.assertIn("commandId", body)
        self.assertNotIn("error", body)

    def test_a_transition_without_the_needed_evidence_is_a_200_escalation(self) -> None:
        """An escalation is a recorded, non-passing outcome, not a transport failure."""
        run_id = self._run()
        status, attempt, _ = self.client.call(
            "POST",
            f"/v1/runs/{run_id}/claims",
            {
                "commandId": ids.new_id("command"),
                "nodeId": "architecture",
                "iteration": 0,
                "agentSubject": "agent-architect",
            },
        )
        self.assertEqual(status, 200, msg=attempt)
        transition_status, body, _ = self.client.call(
            "POST",
            f"/v1/runs/{run_id}/transitions",
            {
                "commandId": ids.new_id("command"),
                "idempotencyKey": "surface:transition:1",
                "nodeId": "architecture",
                "attemptId": attempt["attemptId"],
                "leaseEpoch": attempt["leaseEpoch"],
                "payload": {"evidenceIds": []},
            },
        )
        self.assertEqual(transition_status, 200, msg=body)
        self.assertFalse(body["applied"])
        self.assertTrue(body["blockers"])

    def test_a_stale_lease_epoch_is_a_409_lease_fenced(self) -> None:
        run_id = self._run()
        status, attempt, _ = self.client.call(
            "POST",
            f"/v1/runs/{run_id}/claims",
            {
                "commandId": ids.new_id("command"),
                "nodeId": "architecture",
                "iteration": 0,
                "agentSubject": "agent-architect",
            },
        )
        self.assertEqual(status, 200, msg=attempt)
        fenced_status, body, _ = self.client.call(
            "POST",
            f"/v1/runs/{run_id}/artifacts",
            {
                "commandId": ids.new_id("command"),
                "idempotencyKey": "surface:artifacts:stale",
                "nodeId": "architecture",
                "attemptId": attempt["attemptId"],
                "leaseEpoch": int(attempt["leaseEpoch"]) + 5,
                "payload": {"artifacts": []},
            },
        )
        error = self.assertError(fenced_status, body, ErrorCode.LEASE_FENCED.value)
        self.assertEqual(error["details"]["activeEpoch"], attempt["leaseEpoch"])

    def test_a_stale_expected_state_version_is_a_409_with_the_current_version(self) -> None:
        run_id = self._run()
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
        status, body, _ = self.client.call(
            "POST",
            f"/v1/runs/{run_id}/artifacts",
            {
                "commandId": ids.new_id("command"),
                "idempotencyKey": "surface:artifacts:stale-version",
                "nodeId": "architecture",
                "attemptId": attempt["attemptId"],
                "leaseEpoch": attempt["leaseEpoch"],
                "expectedStateVersion": 1,
                "payload": {"artifacts": []},
            },
        )
        error = self.assertError(status, body, ErrorCode.VERSION_CONFLICT.value)
        self.assertIn("currentVersion", error["details"])

    def test_a_migration_plan_is_a_200_dry_run(self) -> None:
        run_id = self._run()
        status, preview, _ = self.client.call(
            "POST", f"/v1/runs/{run_id}/migrations/plan", {"targetGraphVersion": 2}
        )
        self.assertEqual(status, 200, msg=preview)
        self.assertIn("planHash", preview)
        self.assertEqual(self.db.scalar("SELECT COUNT(*) FROM graph_runs"), 1)

    def test_a_migration_commit_on_a_live_run_is_blocked_with_its_blockers(self) -> None:
        run_id = self._run()
        status, body, _ = self.client.call(
            "POST",
            f"/v1/runs/{run_id}/migrations/commit",
            {"targetGraphVersion": 2, "planHash": "sha256:" + "ab" * 32, "approvalRefs": ["a-1"]},
        )
        error = self.assertError(status, body, ErrorCode.RUN_BLOCKED.value)
        self.assertIn("blockers", error["details"])
        self.assertEqual(self.db.scalar("SELECT COUNT(*) FROM graph_runs"), 1)

    def test_a_migration_commit_is_refused_whatever_it_presents_on_a_live_run(self) -> None:
        run_id = self._run()
        for presented in (
            {"targetGraphVersion": 2, "approvalRefs": ["a-1"]},
            {"targetGraphVersion": 2, "planHash": "sha256:" + "ab" * 32, "approvalRefs": ["a-1"]},
        ):
            status, body, _ = self.client.call(
                "POST", f"/v1/runs/{run_id}/migrations/commit", presented
            )
            self.assertIn(
                status,
                (409, 423),
                msg=f"a live run is not migratable: {body}",
            )
        self.assertEqual(self.db.scalar("SELECT COUNT(*) FROM graph_runs"), 1)

    def test_a_migration_plan_without_a_target_version_is_a_400(self) -> None:
        run_id = self._run()
        status, body, _ = self.client.call("POST", f"/v1/runs/{run_id}/migrations/plan", {})
        self.assertError(status, body, ErrorCode.BAD_REQUEST.value)

    def test_a_run_command_without_the_capability_is_a_403(self) -> None:
        run_id = self._run()
        status, body, _ = self.client.call(
            "POST",
            f"/v1/runs/{run_id}/commands",
            {"commandId": ids.new_id("command"), "command": "pause", "reason": "operator asked"},
            actor=agent_actor("agent-architect"),
        )
        error = self.assertError(status, body, ErrorCode.AUTHORIZATION_DENIED.value)
        self.assertEqual(error["details"]["requiredCapability"], "run.control")

    def test_a_run_command_with_the_capability_is_applied(self) -> None:
        run_id = self._run()
        status, body, _ = self.client.call(
            "POST",
            f"/v1/runs/{run_id}/commands",
            {
                "commandId": ids.new_id("command"),
                "idempotencyKey": "surface:pause:1",
                "command": "pause",
                "reason": "operator asked",
            },
            actor=agent_actor("operator-1"),
        )
        self.assertEqual(status, 200, msg=body)
        self.assertEqual(body["status"], "PAUSED")

    def test_a_run_command_needs_a_reason(self) -> None:
        run_id = self._run()
        status, body, _ = self.client.call(
            "POST",
            f"/v1/runs/{run_id}/commands",
            {"commandId": ids.new_id("command"), "command": "pause"},
            actor=agent_actor("operator-1"),
        )
        self.assertError(status, body, ErrorCode.BAD_REQUEST.value)

    def test_an_unknown_run_command_is_a_400(self) -> None:
        run_id = self._run()
        status, body, _ = self.client.call(
            "POST",
            f"/v1/runs/{run_id}/commands",
            {"commandId": ids.new_id("command"), "command": "detonate", "reason": "no"},
            actor=agent_actor("operator-1"),
        )
        self.assertError(status, body, ErrorCode.BAD_REQUEST.value)

    def test_a_body_naming_a_different_run_than_the_path_is_refused(self) -> None:
        run_id = self._run()
        status, body, _ = self.client.call(
            "POST",
            f"/v1/runs/{run_id}/claims",
            {
                "commandId": ids.new_id("command"),
                "runId": "run_somewhere_else",
                "nodeId": "architecture",
                "iteration": 0,
                "agentSubject": "agent-architect",
            },
        )
        error = self.assertError(status, body, ErrorCode.CONTRACT_INVALID.value)
        self.assertEqual(error["details"]["pathRunId"], run_id)

    def test_an_intake_event_is_202_and_records_without_applying(self) -> None:
        run_id = self._run()
        status, body, _ = self.client.call(
            "POST",
            "/v1/events",
            {
                "type": "pf.execution.observed",
                "runId": run_id,
                "source": "paperclip",
                "sourceEventId": "issue-17-status-changed",
                "payload": {"nodeId": "architecture", "status": "done"},
            },
        )
        self.assertEqual(status, 202, msg=body)
        self.assertTrue(body["accepted"])
        _, snapshot, _ = self.client.call("GET", f"/v1/runs/{run_id}")
        node = next(n for n in snapshot["nodes"] if n["nodeId"] == "architecture")
        self.assertNotEqual(node["status"], "PASSED")

    def test_a_duplicate_intake_event_is_a_no_op(self) -> None:
        run_id = self._run()
        event = {
            "type": "pf.execution.observed",
            "runId": run_id,
            "source": "paperclip",
            "sourceEventId": "agent-run-finished-1",
            "payload": {"nodeId": "architecture", "state": "succeeded"},
        }
        self.assertEqual(self.client.call("POST", "/v1/events", event)[0], 202)
        status, body, _ = self.client.call("POST", "/v1/events", event)
        self.assertEqual(status, 202, msg=body)
        self.assertTrue(body["duplicate"])
        self.assertFalse(body["accepted"])

    def test_an_unknown_event_schema_is_quarantined_not_applied(self) -> None:
        run_id = self._run()
        status, body, _ = self.client.call(
            "POST",
            "/v1/events",
            {
                "type": "pc.something.unpublished",
                "runId": run_id,
                "sourceEventId": "x-1",
                "payload": {"anything": True},
            },
        )
        self.assertEqual(status, 202, msg=body)
        self.assertFalse(body["accepted"])
        self.assertTrue(body["quarantined"])

    def test_the_ops_routes_answer_their_documented_status(self) -> None:
        self.assertEqual(self.client.call("GET", "/v1/health")[0], 200)
        self.assertEqual(self.client.call("GET", "/v1/health/live", sign=False)[0], 200)
        self.assertEqual(self.client.call("GET", "/v1/health/ready")[0], 200)
        self.assertEqual(
            self.client.call(
                "POST",
                "/v1/recover",
                {"commandId": ids.new_id("command")},
                actor={"actorType": "system", "actorId": "operator", "roles": ["polyforge.operator"]},
            )[0],
            200,
        )
        self.assertEqual(self.client.call("GET", "/v1/openapi.json")[0], 200)

    def test_recover_is_operator_only(self) -> None:
        status, body, _ = self.client.call(
            "POST", "/v1/recover", {"commandId": ids.new_id("command")}
        )
        self.assertError(status, body, ErrorCode.AUTHORIZATION_DENIED.value)

    def test_recover_refuses_a_human_caller_even_with_the_role(self) -> None:
        status, body, _ = self.client.call(
            "POST",
            "/v1/recover",
            {"commandId": ids.new_id("command")},
            actor={"actorType": "human", "actorId": "root", "roles": ["polyforge.operator"]},
        )
        self.assertError(status, body, ErrorCode.AUTHORIZATION_DENIED.value)

    def test_a_malformed_json_body_is_a_400(self) -> None:
        status, body, _ = self.client.call(
            "POST", "/v1/work-orders", raw_body=b"{not json"
        )
        self.assertError(status, body, ErrorCode.BAD_REQUEST.value)

    def test_a_non_object_json_body_is_a_400(self) -> None:
        status, body, _ = self.client.call("POST", "/v1/work-orders", raw_body=b"[1, 2, 3]")
        self.assertError(status, body, ErrorCode.BAD_REQUEST.value)

    def test_a_non_numeric_version_segment_is_a_400_not_a_500(self) -> None:
        """A path segment is a string, so it is parsed here and refused as a bad request."""
        status, body, _ = self.client.call("GET", "/v1/graphs/design/versions/abc")
        self.assertError(status, body, ErrorCode.BAD_REQUEST.value)

    def test_a_non_integer_activate_field_is_a_400(self) -> None:
        status, body, _ = self.client.call(
            "POST",
            "/v1/graphs/design/activate",
            {"version": "1", "expectedGeneration": 0},
            actor=PUBLISHER_ACTOR,
        )
        self.assertError(status, body, ErrorCode.BAD_REQUEST.value)

    def test_a_lease_epoch_given_as_a_string_is_a_400(self) -> None:
        run_id = self._run()
        status, body, _ = self.client.call(
            "POST",
            f"/v1/runs/{run_id}/claims",
            {
                "commandId": ids.new_id("command"),
                "nodeId": "architecture",
                "iteration": 0,
                "agentSubject": "agent-architect",
                "leaseEpoch": "2",
            },
            actor=agent_actor("agent-architect"),
        )
        self.assertError(status, body, ErrorCode.BAD_REQUEST.value)

    def test_every_response_carries_a_correlation_id(self) -> None:
        for method, path in (
            ("GET", "/v1/health"),
            ("GET", "/v1/runs"),
            ("GET", "/v1/nope"),
        ):
            _, _, headers = self.client.call(method, path)
            self.assertIn("X-PF-Correlation-Id", headers, msg=path)

    def test_a_caller_supplied_correlation_id_is_echoed(self) -> None:
        _, _, headers = self.client.call(
            "GET", "/v1/health", headers={"X-PF-Correlation-Id": "corr-from-bridge-1"}
        )
        self.assertEqual(headers["X-PF-Correlation-Id"], "corr-from-bridge-1")

    def test_a_malformed_correlation_id_is_replaced_not_rejected(self) -> None:
        _, _, headers = self.client.call(
            "GET", "/v1/health", headers={"X-PF-Correlation-Id": "bad id with spaces and \n newline"}
        )
        self.assertNotEqual(headers["X-PF-Correlation-Id"], "bad id with spaces and \n newline")
        self.assertTrue(headers["X-PF-Correlation-Id"].startswith("cor_"))


class EventCursorTests(RuntimeApiCase):
    """``after`` is a real cursor: monotonic, gap free, and it advances."""

    def setUp(self) -> None:
        super().setUp()
        grant(self.db, "agent-designer", "design.coordinate")
        grant(self.db, "agent-architect", "architecture.design")
        status, body, _ = self.client.call(
            "POST", "/v1/work-orders", work_order("cursor-1", commandId=ids.new_id("command"))
        )
        self.assertEqual(status, 201, msg=body)
        self.run_id = str(body["runId"])
        _, attempt, _ = self.client.call(
            "POST",
            f"/v1/runs/{self.run_id}/claims",
            {
                "commandId": ids.new_id("command"),
                "nodeId": "architecture",
                "iteration": 0,
                "agentSubject": "agent-architect",
            },
        )
        self.attempt = attempt

    def test_events_start_at_one_and_are_contiguous(self) -> None:
        status, page, _ = self.client.call("GET", f"/v1/runs/{self.run_id}/events")
        self.assertEqual(status, 200, msg=page)
        seqs = [event["seq"] for event in page["events"]]
        self.assertEqual(seqs, list(range(1, len(seqs) + 1)))
        self.assertEqual(page["eventSequence"], seqs[-1])

    def test_a_cursor_walks_the_stream_without_a_gap_or_a_repeat(self) -> None:
        seen: list[int] = []
        after = 0
        for _ in range(20):
            _, page, _ = self.client.call(
                "GET", f"/v1/runs/{self.run_id}/events?after={after}&limit=1"
            )
            if not page["events"]:
                break
            seen.extend(event["seq"] for event in page["events"])
            after = page["nextAfter"]
        self.assertEqual(seen, sorted(seen))
        self.assertEqual(len(seen), len(set(seen)))
        self.assertEqual(seen, list(range(1, len(seen) + 1)))

    def test_a_cursor_past_the_end_returns_nothing_and_does_not_move(self) -> None:
        _, snapshot, _ = self.client.call("GET", f"/v1/runs/{self.run_id}")
        cursor = int(snapshot["eventSequence"])
        _, page, _ = self.client.call(
            "GET", f"/v1/runs/{self.run_id}/events?after={cursor}"
        )
        self.assertEqual(page["events"], [])
        self.assertEqual(page["nextAfter"], cursor)
        self.assertEqual(page["eventSequence"], cursor)

    def test_new_events_appear_after_the_cursor(self) -> None:
        _, page, _ = self.client.call("GET", f"/v1/runs/{self.run_id}/events")
        cursor = page["nextAfter"]
        self.client.call(
            "POST",
            f"/v1/runs/{self.run_id}/artifacts",
            {
                "commandId": ids.new_id("command"),
                "idempotencyKey": "cursor:artifacts:1",
                "nodeId": "architecture",
                "attemptId": self.attempt["attemptId"],
                "leaseEpoch": self.attempt["leaseEpoch"],
                "payload": {
                    "artifacts": [
                        {
                            "kind": "architecture_spec",
                            "contentHash": "sha256:" + "ab" * 32,
                            "mediaType": "application/json",
                            "size": 64,
                            "source": {"kind": "attachment", "ref": "attachment:a"},
                        }
                    ]
                },
            },
        )
        _, after_page, _ = self.client.call(
            "GET", f"/v1/runs/{self.run_id}/events?after={cursor}"
        )
        self.assertGreater(after_page["nextAfter"], cursor)
        self.assertTrue(all(e["seq"] > cursor for e in after_page["events"]))

    def test_the_limit_is_honoured(self) -> None:
        _, page, _ = self.client.call("GET", f"/v1/runs/{self.run_id}/events?limit=2")
        self.assertLessEqual(len(page["events"]), 2)
        self.assertEqual(page["after"], 0)

    def test_a_non_numeric_cursor_is_a_400(self) -> None:
        status, body, _ = self.client.call(
            "GET", f"/v1/runs/{self.run_id}/events?after=abc"
        )
        self.assertError(status, body, ErrorCode.BAD_REQUEST.value)

    def test_a_negative_limit_is_a_400(self) -> None:
        status, body, _ = self.client.call(
            "GET", f"/v1/runs/{self.run_id}/events?limit=-1"
        )
        self.assertError(status, body, ErrorCode.BAD_REQUEST.value)

    def test_an_absurd_limit_is_capped_rather_than_refused(self) -> None:
        status, page, _ = self.client.call(
            "GET", f"/v1/runs/{self.run_id}/events?limit=100000"
        )
        self.assertEqual(status, 200, msg=page)

    def test_a_missing_run_is_a_404_not_an_empty_page(self) -> None:
        status, body, _ = self.client.call("GET", "/v1/runs/run_nope/events")
        self.assertError(status, body, ErrorCode.NOT_FOUND.value)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
