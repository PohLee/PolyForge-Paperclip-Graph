"""Idempotency, optimistic concurrency, and the event cursor.

AT-26 (a duplicate, a retry, or an out-of-order redelivery produces no second effect) and
AT-17 (concurrent draft updates conflict; a validation/compile/review is bound to an exact
revision). The transport's job here is narrow and important: it must not invent an idempotency
key, and it must not swallow the ``409`` the Core raises.
"""

from __future__ import annotations

import copy
import unittest

from polyforge.core import ids
from polyforge.core.errors import ErrorCode
from polyforge.graph_library import load_graph
from services.polyforge.tests.runtime_api.fixtures import (
    AUTHOR,
    REVIEWER,
    RuntimeApiCase,
    allow_rule,
    grant,
)

AUTHOR_ACTOR = {"actorType": "human", "actorId": AUTHOR, "roles": ["polyforge.author"]}
PUBLISHER_ACTOR = {
    "actorType": "human",
    "actorId": AUTHOR,
    "roles": ["polyforge.author", "polyforge.publisher"],
}
REVIEWER_ACTOR = {"actorType": "human", "actorId": REVIEWER, "roles": ["polyforge.author"]}


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
            "requirement_gate_passed": {
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


class AdmissionIdempotencyTests(RuntimeApiCase):
    """AT-26: the same key and the same payload produce one effect."""

    def setUp(self) -> None:
        super().setUp()
        grant(self.db, "agent-designer", "design.coordinate")

    def test_the_same_key_and_payload_twice_produces_one_run(self) -> None:
        request = work_order("idem-1", commandId=ids.new_id("command"))
        first_status, first, _ = self.client.call("POST", "/v1/work-orders", request)
        second_status, second, _ = self.client.call("POST", "/v1/work-orders", request)
        self.assertEqual(first_status, 201, msg=first)
        self.assertEqual(second_status, 201, msg=second)
        self.assertEqual(second["runId"], first["runId"])
        self.assertEqual(second["stateVersion"], first["stateVersion"])
        self.assertEqual(second["eventSequence"], first["eventSequence"])
        self.assertEqual(self.db.scalar("SELECT COUNT(*) FROM graph_runs"), 1)
        self.assertEqual(self.db.scalar("SELECT COUNT(*) FROM work_orders"), 1)

    def test_a_hundred_replays_produce_one_run(self) -> None:
        request = work_order("idem-2", commandId=ids.new_id("command"))
        run_ids = set()
        for _ in range(100):
            status, body, _ = self.client.call("POST", "/v1/work-orders", request)
            self.assertEqual(status, 201, msg=body)
            run_ids.add(body["runId"])
        self.assertEqual(len(run_ids), 1)
        self.assertEqual(self.db.scalar("SELECT COUNT(*) FROM graph_runs"), 1)

    def test_the_same_key_with_a_different_payload_is_a_conflict(self) -> None:
        first = work_order("idem-3", commandId=ids.new_id("command"))
        self.client.call("POST", "/v1/work-orders", first)
        second = work_order(
            "idem-3",
            commandId=ids.new_id("command"),
            inputSnapshot={"requirement_baseline": {"id": "a-different-baseline"}},
        )
        status, body, _ = self.client.call("POST", "/v1/work-orders", second)
        self.assertError(status, body, ErrorCode.IDEMPOTENCY_CONFLICT.value)
        self.assertEqual(self.db.scalar("SELECT COUNT(*) FROM graph_runs"), 1)

    def test_a_different_intent_creates_a_second_run(self) -> None:
        _, first, _ = self.client.call(
            "POST", "/v1/work-orders", work_order("idem-4a", commandId=ids.new_id("command"))
        )
        _, second, _ = self.client.call(
            "POST", "/v1/work-orders", work_order("idem-4b", commandId=ids.new_id("command"))
        )
        self.assertNotEqual(first["runId"], second["runId"])
        self.assertEqual(self.db.scalar("SELECT COUNT(*) FROM graph_runs"), 2)

    def test_a_body_without_an_explicit_key_still_yields_one_run(self) -> None:
        """The Core derives the admission key from scope + startIntentId + entrypoint.

        The transport must not add a per-attempt key on top of that, because a generated key
        turns every retry into a second work order. So two identical requests that differ only
        in ``commandId`` still collapse onto one run.
        """
        first = work_order("idem-5", commandId=ids.new_id("command"))
        first.pop("idempotencyKey")
        replay = work_order("idem-5", commandId=ids.new_id("command"))
        replay.pop("idempotencyKey")
        first_status, first_body, _ = self.client.call("POST", "/v1/work-orders", first)
        replay_status, replay_body, _ = self.client.call("POST", "/v1/work-orders", replay)
        self.assertEqual(first_status, 201, msg=first_body)
        self.assertEqual(replay_status, 201, msg=replay_body)
        self.assertEqual(replay_body["runId"], first_body["runId"])
        self.assertEqual(self.db.scalar("SELECT COUNT(*) FROM graph_runs"), 1)


class DraftConcurrencyTests(RuntimeApiCase):
    """AT-17: the draft revision is the concurrency token, and a stale one is refused."""

    def _draft(self) -> dict:
        status, body, _ = self.client.call(
            "POST",
            "/v1/graphs/design/drafts",
            {"definition": design_graph()},
            actor=AUTHOR_ACTOR,
        )
        self.assertEqual(status, 201, msg=body)
        return body

    def test_a_draft_carries_its_revision_as_an_etag(self) -> None:
        _, body, headers = self.client.call(
            "POST", "/v1/graphs/design/drafts", {"definition": design_graph()}, actor=AUTHOR_ACTOR
        )
        self.assertEqual(headers["ETag"], '"1"')
        self.assertEqual(body["revision"], 1)

    def test_a_save_with_the_current_revision_bumps_it(self) -> None:
        draft = self._draft()
        graph = design_graph()
        graph["description"] = "an edited design"
        status, body, headers = self.client.call(
            "PATCH",
            f"/v1/drafts/{draft['draftId']}",
            {"definition": graph},
            headers={"If-Match": '"1"'},
            actor=AUTHOR_ACTOR,
        )
        self.assertEqual(status, 200, msg=body)
        self.assertEqual(body["revision"], 2)
        self.assertEqual(headers["ETag"], '"2"')
        self.assertNotEqual(body["definitionHash"], draft["definitionHash"])

    def test_a_stale_if_match_is_a_version_conflict_with_the_current_revision(self) -> None:
        draft = self._draft()
        status, body, _ = self.client.call(
            "PATCH",
            f"/v1/drafts/{draft['draftId']}",
            {"definition": design_graph()},
            headers={"If-Match": '"1"'},
            actor=AUTHOR_ACTOR,
        )
        self.assertEqual(status, 200, msg=body)
        conflict_status, conflict, _ = self.client.call(
            "PATCH",
            f"/v1/drafts/{draft['draftId']}",
            {"definition": design_graph()},
            headers={"If-Match": '"1"'},
            actor=AUTHOR_ACTOR,
        )
        error = self.assertError(conflict_status, conflict, ErrorCode.VERSION_CONFLICT.value)
        self.assertEqual(error["details"]["currentVersion"], 2)

    def test_two_concurrent_updates_produce_exactly_one_winner(self) -> None:
        draft = self._draft()
        winners, conflicts = 0, 0
        for index in range(2):
            graph = design_graph()
            graph["description"] = f"writer {index}"
            status, body, _ = self.client.call(
                "PATCH",
                f"/v1/drafts/{draft['draftId']}",
                {"definition": graph},
                headers={"If-Match": '"1"'},
                actor=AUTHOR_ACTOR,
            )
            if status == 200:
                winners += 1
            else:
                self.assertError(status, body, ErrorCode.VERSION_CONFLICT.value)
                conflicts += 1
        self.assertEqual((winners, conflicts), (1, 1))

    def test_a_missing_if_match_is_refused(self) -> None:
        draft = self._draft()
        status, body, _ = self.client.call(
            "PATCH", f"/v1/drafts/{draft['draftId']}", {"definition": design_graph()}, actor=AUTHOR_ACTOR
        )
        self.assertError(status, body, ErrorCode.BAD_REQUEST.value)
        self.assertIn("If-Match", body["error"]["message"])

    def test_a_malformed_if_match_is_refused(self) -> None:
        draft = self._draft()
        status, body, _ = self.client.call(
            "PATCH",
            f"/v1/drafts/{draft['draftId']}",
            {"definition": design_graph()},
            headers={"If-Match": '"not-a-number"'},
            actor=AUTHOR_ACTOR,
        )
        self.assertError(status, body, ErrorCode.BAD_REQUEST.value)

    def test_a_weak_etag_is_accepted(self) -> None:
        """``W/"3"`` is valid HTTP; refusing it would break a proxy that adds the marker."""
        draft = self._draft()
        status, body, _ = self.client.call(
            "PATCH",
            f"/v1/drafts/{draft['draftId']}",
            {"definition": design_graph()},
            headers={"If-Match": 'W/"1"'},
            actor=AUTHOR_ACTOR,
        )
        self.assertEqual(status, 200, msg=body)

    def test_editing_invalidates_the_earlier_validation_and_compile(self) -> None:
        """The "validated then modified" hole: the chain must describe one revision."""
        draft = self._draft()
        self.client.call("POST", f"/v1/drafts/{draft['draftId']}/validate", actor=AUTHOR_ACTOR)
        graph = design_graph()
        graph["description"] = "edited after validation"
        _, saved, _ = self.client.call(
            "PATCH",
            f"/v1/drafts/{draft['draftId']}",
            {"definition": graph},
            headers={"If-Match": '"1"'},
            actor=AUTHOR_ACTOR,
        )
        self.assertIsNone(saved["validationRef"])
        status, body, _ = self.client.call(
            "POST",
            f"/v1/drafts/{draft['draftId']}/publish",
            {
                "expectedRevision": saved["revision"],
                "definitionHash": draft["definitionHash"],
                "compilerVersion": "polyforge-compiler/1.0.0",
                "planHash": "sha256:" + "cd" * 32,
                "reviewTargetHash": "sha256:" + "ef" * 32,
            },
            actor=PUBLISHER_ACTOR,
        )
        self.assertError(status, body, ErrorCode.VERSION_CONFLICT.value)

    def test_activating_a_stale_generation_is_a_version_conflict(self) -> None:
        draft = self._draft()
        artifact = self._publish(draft)
        status, body, _ = self.client.call(
            "POST",
            "/v1/graphs/design/activate",
            {"version": artifact["version"], "expectedGeneration": 7},
            actor=PUBLISHER_ACTOR,
        )
        error = self.assertError(status, body, ErrorCode.VERSION_CONFLICT.value)
        self.assertEqual(error["details"]["currentVersion"], 0)

    # -- helpers --------------------------------------------------------

    def _publish(self, draft: dict) -> dict:
        report_status, report, _ = self.client.call(
            "POST", f"/v1/drafts/{draft['draftId']}/validate", actor=AUTHOR_ACTOR
        )
        self.assertEqual(report_status, 200, msg=report)
        self.assertTrue(report["ok"], msg=report)
        compile_status, artifact, _ = self.client.call(
            "POST", f"/v1/drafts/{draft['draftId']}/compile", actor=AUTHOR_ACTOR
        )
        self.assertEqual(compile_status, 200, msg=artifact)
        review_status, reviewed, _ = self.client.call(
            "POST",
            f"/v1/drafts/{draft['draftId']}/reviews",
            {"reviewTargetHash": artifact["planHash"]},
            actor=REVIEWER_ACTOR,
        )
        self.assertEqual(review_status, 200, msg=reviewed)
        publish_status, version, _ = self.client.call(
            "POST",
            f"/v1/drafts/{draft['draftId']}/publish",
            {
                "expectedRevision": reviewed["revision"],
                "definitionHash": reviewed["definitionHash"],
                "compilerVersion": artifact["compilerVersion"],
                "planHash": artifact["planHash"],
                "reviewTargetHash": artifact["planHash"],
            },
            actor=PUBLISHER_ACTOR,
        )
        self.assertEqual(publish_status, 201, msg=version)
        return version

    def test_a_full_publish_then_activate_reaches_generation_one(self) -> None:
        version = self._publish(self._draft())
        self.assertEqual(version["version"], 1)
        status, pointer, _ = self.client.call(
            "POST",
            "/v1/graphs/design/activate",
            {"version": version["version"], "expectedGeneration": 0},
            actor=PUBLISHER_ACTOR,
        )
        self.assertEqual(status, 200, msg=pointer)
        self.assertEqual(pointer["generation"], 1)
        self.assertEqual(pointer["version"], 1)

    def test_a_draft_cannot_be_reviewed_by_its_own_author(self) -> None:
        draft = self._draft()
        _, artifact, _ = self.client.call(
            "POST", f"/v1/drafts/{draft['draftId']}/compile", actor=AUTHOR_ACTOR
        )
        status, body, _ = self.client.call(
            "POST",
            f"/v1/drafts/{draft['draftId']}/reviews",
            {"reviewTargetHash": artifact["planHash"]},
            actor=AUTHOR_ACTOR,
        )
        self.assertError(status, body, ErrorCode.AUTHORIZATION_DENIED.value)

    def test_an_agent_cannot_record_a_review(self) -> None:
        draft = self._draft()
        status, body, _ = self.client.call(
            "POST",
            f"/v1/drafts/{draft['draftId']}/reviews",
            {"reviewTargetHash": "sha256:" + "ef" * 32},
            actor={"actorType": "agent", "actorId": "agent-1", "roles": ["polyforge.author"]},
        )
        self.assertError(status, body, ErrorCode.AUTHORIZATION_DENIED.value)

    def test_publishing_without_a_review_is_refused(self) -> None:
        draft = self._draft()
        self.client.call("POST", f"/v1/drafts/{draft['draftId']}/validate", actor=AUTHOR_ACTOR)
        _, artifact, _ = self.client.call(
            "POST", f"/v1/drafts/{draft['draftId']}/compile", actor=AUTHOR_ACTOR
        )
        status, body, _ = self.client.call(
            "POST",
            f"/v1/drafts/{draft['draftId']}/publish",
            {
                "expectedRevision": draft["revision"],
                "definitionHash": draft["definitionHash"],
                "compilerVersion": artifact["compilerVersion"],
                "planHash": artifact["planHash"],
                "reviewTargetHash": artifact["planHash"],
            },
            actor=PUBLISHER_ACTOR,
        )
        self.assertError(status, body, ErrorCode.VERSION_CONFLICT.value)

    def test_a_publish_with_a_wrong_definition_hash_is_refused(self) -> None:
        draft = self._draft()
        self.client.call("POST", f"/v1/drafts/{draft['draftId']}/validate", actor=AUTHOR_ACTOR)
        _, artifact, _ = self.client.call(
            "POST", f"/v1/drafts/{draft['draftId']}/compile", actor=AUTHOR_ACTOR
        )
        self.client.call(
            "POST",
            f"/v1/drafts/{draft['draftId']}/reviews",
            {"reviewTargetHash": artifact["planHash"]},
            actor=REVIEWER_ACTOR,
        )
        status, body, _ = self.client.call(
            "POST",
            f"/v1/drafts/{draft['draftId']}/publish",
            {
                "expectedRevision": draft["revision"],
                "definitionHash": "sha256:" + "00" * 32,
                "compilerVersion": artifact["compilerVersion"],
                "planHash": artifact["planHash"],
                "reviewTargetHash": artifact["planHash"],
            },
            actor=PUBLISHER_ACTOR,
        )
        error = self.assertError(status, body, ErrorCode.VERSION_CONFLICT.value)
        self.assertEqual(error["details"]["currentVersion"], draft["revision"])

    def test_a_published_draft_cannot_be_deleted(self) -> None:
        draft = self._draft()
        self._publish(draft)
        status, body, _ = self.client.call(
            "DELETE", f"/v1/drafts/{draft['draftId']}", actor=AUTHOR_ACTOR
        )
        self.assertError(status, body, ErrorCode.CONTRACT_INVALID.value)

    def test_an_unpublished_draft_can_be_deleted(self) -> None:
        draft = self._draft()
        status, _, _ = self.client.call(
            "DELETE", f"/v1/drafts/{draft['draftId']}", actor=AUTHOR_ACTOR
        )
        self.assertEqual(status, 204)
        status, body, _ = self.client.call("GET", f"/v1/drafts/{draft['draftId']}")
        self.assertError(status, body, ErrorCode.NOT_FOUND.value)


class AuthoringAuthorisationTests(RuntimeApiCase):
    """Authoring is not open to every authenticated caller."""

    def test_an_agent_without_a_graph_role_cannot_create_a_draft(self) -> None:
        status, body, _ = self.client.call(
            "POST", "/v1/graphs/design/drafts", {"definition": design_graph()}
        )
        self.assertError(status, body, ErrorCode.AUTHORIZATION_DENIED.value)

    def test_an_author_cannot_publish_without_the_publisher_role(self) -> None:
        status, body, _ = self.client.call(
            "POST",
            "/v1/graphs/design/drafts",
            {"definition": design_graph()},
            actor=AUTHOR_ACTOR,
        )
        self.assertEqual(status, 201, msg=body)
        status, refusal, _ = self.client.call(
            "POST",
            f"/v1/drafts/{body['draftId']}/publish",
            {
                "expectedRevision": 1,
                "definitionHash": body["definitionHash"],
                "compilerVersion": "polyforge-compiler/1.0.0",
                "planHash": "sha256:" + "cd" * 32,
                "reviewTargetHash": "sha256:" + "ef" * 32,
            },
            actor=AUTHOR_ACTOR,
        )
        self.assertError(status, refusal, ErrorCode.AUTHORIZATION_DENIED.value)

    def test_a_granted_graph_capability_is_accepted_instead_of_a_role(self) -> None:
        grant(self.db, "agent-tooling", "graph.author")
        status, body, _ = self.client.call(
            "POST",
            "/v1/graphs/design/drafts",
            {"definition": design_graph()},
            actor={"actorType": "system", "actorId": "agent-tooling", "roles": []},
        )
        self.assertEqual(status, 201, msg=body)

    def test_a_read_needs_no_author_role(self) -> None:
        status, body, _ = self.client.call("GET", "/v1/graphs/design/drafts")
        self.assertEqual(status, 200, msg=body)
        self.assertEqual(body["drafts"], [])


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
