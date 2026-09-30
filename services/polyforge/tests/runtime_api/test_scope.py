"""Tenant isolation across the wire.

AT-03 (root/child/workspace/agent refs stay inside one scope; cross-scope access is refused) and
AT-29 (cross-company reads, events, artifacts and API access are all refused).

The property under test is not "a 403 happens"; it is *which* 403. A cross-scope read of an
object the caller already holds the id of must not be a 404, because a 404 either lies (the
object exists) or confirms the caller's guess. The only honest answer is "not yours", and that
is what ``403 SCOPE_VIOLATION`` says.
"""

from __future__ import annotations

import copy
import unittest

from polyforge.core import ids
from polyforge.core.errors import ErrorCode
from polyforge.graph_library import load_graph
from services.polyforge.tests.runtime_api.fixtures import (
    PROJECT_B,
    SCOPE_A,
    SCOPE_B,
    RuntimeApiCase,
    agent_actor,
    allow_rule,
    grant,
)


def design_graph() -> dict:
    """The shipped ``design`` graph, narrowed to the evaluator refs this Core registers.

    The Core ships four evaluators and refuses an unknown one (``ESCALATE``, never a pass), so
    the library's ``threat_model_review_v2`` would make the gate unreachable on purpose rather
    than by design. Narrowing the ref keeps the authored graph honest about what this build can
    evaluate and keeps the human decision it declares.
    """
    graph = copy.deepcopy(load_graph("design"))
    graph["nodes"]["design_gate"]["evaluatorRefs"] = ["contract_schema_v1"]
    graph["nodes"]["design_gate"]["humanDecision"] = {
        "required": True,
        "semanticKind": "design_acceptance",
        "question": "Accept the design?",
        "options": [{"id": "accept", "label": "Accept"}],
    }
    return graph


def admit_request(start_intent: str, *, graph: dict, scope: dict | None = None) -> dict:
    return {
        "commandId": ids.new_id("command"),
        "idempotencyKey": f"admission:{start_intent}:design.start",
        "correlationId": f"corr-{start_intent}",
        "startIntentId": start_intent,
        "graphId": "design",
        "graphVersion": 1,
        "entrypoint": "design.start",
        "rootIssueRef": {"provider": "paperclip", "kind": "issue", "id": f"issue-{start_intent}"},
        "inputSnapshot": {"requirement_baseline": {"id": "rb-1"}},
        "requiredFacts": {
            "requirement_acceptance": {
                "source": "imp-1",
                "sourceRevision": "rev-7",
                "contentHash": "sha256:" + "ab" * 32,
            }
        },
        "policyRules": [allow_rule((scope or SCOPE_A)["projectRef"])],
        "definition": graph,
    }


class ScopeIsolationCase(RuntimeApiCase):
    """A run in ``SCOPE_A`` the tests then try to reach from ``SCOPE_B``."""

    def setUp(self) -> None:
        super().setUp()
        grant(self.db, "agent-designer", "design.coordinate")
        grant(self.db, "agent-architect", "architecture.design")
        status, body, _ = self.client.call(
            "POST", "/v1/work-orders", admit_request("scope-1", graph=design_graph())
        )
        self.assertEqual(status, 201, msg=body)
        self.run_id = str(body["runId"])


class CrossScopeReadTests(ScopeIsolationCase):
    """AT-03, AT-29: a run in another scope is refused, never hidden and never served."""

    def test_reading_another_companys_run_is_a_scope_violation(self) -> None:
        status, body, _ = self.client.call(
            "GET", f"/v1/runs/{self.run_id}", scope=SCOPE_B, actor=agent_actor("agent-b")
        )
        error = self.assertError(status, body, ErrorCode.SCOPE_VIOLATION.value)
        # The Core nests its own detail payload under a ``details`` key here, so the transport
        # asserts on the message rather than on a detail shape the Core owns.
        self.assertIn("belongs to a different company/project", error["message"])

    def test_the_refusal_is_not_a_404_that_confirms_existence(self) -> None:
        """A 404 for an id the caller holds is a lie; a 404 for an invented id is honest."""
        real_status, real_body, _ = self.client.call(
            "GET", f"/v1/runs/{self.run_id}", scope=SCOPE_B
        )
        fake_status, fake_body, _ = self.client.call(
            "GET", "/v1/runs/run_does_not_exist", scope=SCOPE_B
        )
        self.assertEqual(real_status, 403, msg=real_body)
        self.assertEqual(fake_status, 404, msg=fake_body)
        self.assertNotEqual(real_body["error"]["code"], fake_body["error"]["code"])

    def test_listing_runs_only_returns_the_callers_scope(self) -> None:
        status, body, _ = self.client.call("GET", "/v1/runs", scope=SCOPE_B)
        self.assertEqual(status, 200, msg=body)
        self.assertEqual(body["runs"], [])

    def test_reading_another_companys_events_is_a_scope_violation(self) -> None:
        status, body, _ = self.client.call(
            "GET", f"/v1/runs/{self.run_id}/events", scope=SCOPE_B
        )
        self.assertError(status, body, ErrorCode.SCOPE_VIOLATION.value)

    def test_reading_another_companys_current_contract_is_a_scope_violation(self) -> None:
        status, body, _ = self.client.call(
            "GET", f"/v1/runs/{self.run_id}/current", scope=SCOPE_B, actor=agent_actor("agent-b")
        )
        self.assertError(status, body, ErrorCode.SCOPE_VIOLATION.value)

    def test_writing_to_another_companys_run_is_a_scope_violation(self) -> None:
        # The capability check runs before the scope check, so the actor needs the capability it
        # would need for its own run: otherwise this would be testing the capability check.
        grant(self.db, "agent-b", "run.control", scope=SCOPE_B)
        status, body, _ = self.client.call(
            "POST",
            f"/v1/runs/{self.run_id}/commands",
            {"commandId": ids.new_id("command"), "command": "pause", "reason": "not mine"},
            scope=SCOPE_B,
            actor=agent_actor("agent-b"),
        )
        self.assertError(status, body, ErrorCode.SCOPE_VIOLATION.value)

    def test_an_event_intake_for_another_companys_run_is_a_scope_violation(self) -> None:
        status, body, _ = self.client.call(
            "POST",
            "/v1/events",
            {
                "type": "pf.execution.observed",
                "runId": self.run_id,
                "sourceEventId": "x-1",
                "payload": {"nodeId": "architecture", "status": "done"},
            },
            scope=SCOPE_B,
        )
        self.assertError(status, body, ErrorCode.SCOPE_VIOLATION.value)

    def test_a_refusal_read_is_about_another_project_in_the_same_company(self) -> None:
        status, body, _ = self.client.call(
            "GET",
            f"/v1/runs/{self.run_id}",
            scope={"companyRef": SCOPE_A["companyRef"], "projectRef": PROJECT_B},
        )
        self.assertError(status, body, ErrorCode.SCOPE_VIOLATION.value)


class AuthoringScopeTests(RuntimeApiCase):
    """A draft belongs to exactly one scope, and reads and writes disagree on purpose."""

    def test_a_draft_is_readable_only_inside_its_scope(self) -> None:
        status, draft, _ = self.client.call(
            "POST",
            "/v1/graphs/design/drafts",
            {"definition": design_graph()},
            actor={
                "actorType": "human",
                "actorId": "user-anna",
                "roles": ["polyforge.author"],
            },
        )
        self.assertEqual(status, 201, msg=draft)
        draft_id = draft["draftId"]

        inside, inside_body, _ = self.client.call("GET", f"/v1/drafts/{draft_id}")
        self.assertEqual(inside, 200, msg=inside_body)
        outside, outside_body, _ = self.client.call("GET", f"/v1/drafts/{draft_id}", scope=SCOPE_B)
        self.assertError(outside, outside_body, ErrorCode.SCOPE_VIOLATION.value)

    def test_listing_drafts_filters_by_scope(self) -> None:
        self.client.call(
            "POST",
            "/v1/graphs/design/drafts",
            {"definition": design_graph()},
            actor={
                "actorType": "human",
                "actorId": "user-anna",
                "roles": ["polyforge.author"],
            },
        )
        status, body, _ = self.client.call("GET", "/v1/graphs/design/drafts", scope=SCOPE_B)
        self.assertEqual(status, 200, msg=body)
        self.assertEqual(body["drafts"], [])

    def test_a_write_to_another_companys_draft_is_not_found(self) -> None:
        """A write reports 404 rather than 403: a write must not be an existence oracle."""
        _, draft, _ = self.client.call(
            "POST",
            "/v1/graphs/design/drafts",
            {"definition": design_graph()},
            actor={
                "actorType": "human",
                "actorId": "user-anna",
                "roles": ["polyforge.author"],
            },
        )
        status, body, _ = self.client.call(
            "PATCH",
            f"/v1/drafts/{draft['draftId']}",
            {"definition": design_graph()},
            headers={"If-Match": '"1"'},
            scope=SCOPE_B,
            actor={
                "actorType": "human",
                "actorId": "user-bob",
                "roles": ["polyforge.author"],
            },
        )
        self.assertError(status, body, ErrorCode.NOT_FOUND.value)

    def test_a_version_from_another_scope_is_not_found(self) -> None:
        status, body, _ = self.client.call(
            "GET", "/v1/graphs/design/versions/1", scope=SCOPE_B
        )
        self.assertError(status, body, ErrorCode.NOT_FOUND.value)


class OutboxScopeTests(RuntimeApiCase):
    """The pull queue is tenant scoped: one company's poll cannot hold another's intents."""

    def test_an_intent_is_only_claimable_inside_its_scope(self) -> None:
        grant(self.db, "agent-designer", "design.coordinate", scope=SCOPE_A)
        grant(self.db, "agent-designer-b", "design.coordinate", scope=SCOPE_B)
        status, body, _ = self.client.call(
            "POST",
            "/v1/work-orders",
            admit_request("outbox-1", graph=design_graph(), scope=SCOPE_A),
        )
        self.assertEqual(status, 201, msg=body)
        status, batch, _ = self.client.call("GET", "/v1/bridge/outbox?limit=50")
        self.assertEqual(status, 200, msg=batch)
        self.assertGreaterEqual(batch["count"], 1)

        status, other, _ = self.client.call(
            "GET", "/v1/bridge/outbox?limit=50", scope=SCOPE_B, actor=agent_actor("agent-b")
        )
        self.assertEqual(status, 200, msg=other)
        self.assertEqual(other["count"], 0, msg=other)

    def test_acknowledging_another_companys_intent_is_a_scope_violation(self) -> None:
        grant(self.db, "agent-designer", "design.coordinate")
        _, body, _ = self.client.call(
            "POST", "/v1/work-orders", admit_request("outbox-2", graph=design_graph())
        )
        _, batch, _ = self.client.call("GET", "/v1/bridge/outbox?limit=50")
        intent_id = batch["intents"][0]["intentId"]
        status, refusal, _ = self.client.call(
            "POST",
            f"/v1/bridge/outbox/{intent_id}/delivery",
            {"state": "delivered", "receipt": {"providerRef": {"id": "x"}}},
            scope=SCOPE_B,
            actor=agent_actor("agent-b"),
        )
        self.assertError(status, refusal, ErrorCode.SCOPE_VIOLATION.value)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
