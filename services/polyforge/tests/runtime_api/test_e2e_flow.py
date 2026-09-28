"""End to end over a real socket, on an ephemeral port.

AT-04 (only a gate can produce a pass), AT-26 (a replayed delivery produces no second effect),
AT-13/AT-14 (a human decision is only recorded when it was verified against the provider), and
the whole of ``docs/05-PROTOCOL.md`` section 3 exercised the way a bridge would: author,
publish, activate, admit, read, work, decide, observe.

The graph is the shipped ``design`` family with one documented adjustment: the Core registers
four evaluators and refuses an unknown one (``ESCALATE``, never a pass), so the gate names only
refs this build can evaluate while keeping the required human decision the family is about.
"""

from __future__ import annotations

import copy
import json
import unittest
from typing import Any, Mapping

from polyforge.core import ids
from polyforge.core.errors import ErrorCode
from polyforge.graph_library import load_graph
from services.polyforge.tests.runtime_api.fixtures import (
    SCOPE_B,
    RuntimeApiCase,
    agent_actor,
    allow_rule,
    grant,
    http_call,
)

AUTHOR = "user-anna"
REVIEWER = "user-bob"
DESIGNER = "agent-designer"
ARCHITECT = "agent-architect"
SECURITY_REVIEWER = "agent-security"

AUTHOR_ACTOR = {
    "actorType": "human",
    "actorId": AUTHOR,
    "roles": ["polyforge.author", "polyforge.publisher"],
}
REVIEWER_ACTOR = {"actorType": "human", "actorId": REVIEWER, "roles": ["polyforge.author"]}


def design_graph() -> dict:
    """The ``design`` family, unedited, with the human decision this test will answer.

    The evaluator refs are no longer substituted. They used to be replaced with
    ``contract_schema_v1`` because the Core registered nothing else, which meant the flow proved the
    transport worked while proving nothing about the graph an operator would actually run: the
    shipped ``threat_model_review_v2`` was never reached. It is reached now, so this test fails if
    the shipped family stops being runnable as published.
    """
    graph = copy.deepcopy(load_graph("design"))
    graph["nodes"]["design_gate"]["humanDecision"] = {
        "required": True,
        "semanticKind": "design_acceptance",
        "question": "Do you accept this design for the release candidate?",
        "options": [{"id": "accept", "label": "Accept"}],
    }
    return graph


def evidence_detail(kind: str) -> dict[str, Any]:
    """The payload a given evidence kind has to carry for its check to be able to pass.

    Only the kinds whose evaluators read a field need anything here. The rest get a note, which is
    enough: a check that passes on presence alone has told us what it needed to.
    """
    if kind == "threat_model":
        return {
            "note": "one threat considered and carried through to a mitigation",
            "findings": [
                {
                    "id": "TM-1",
                    "title": "the bridge secret is shared by every plugin in the company",
                    "severity": "high",
                    "mitigation": "per-plugin secrets, rotate on uninstall",
                }
            ],
        }
    return {"note": "produced by the worker, verified on ingest"}


def artifact(kind: str, seed: str) -> dict[str, Any]:
    return {
        "kind": kind,
        "contentHash": "sha256:" + seed * 64,
        "mediaType": "application/json",
        "size": 128,
        "source": {"kind": "attachment", "ref": f"attachment:{kind}"},
    }


class HttpFlowCase(RuntimeApiCase):
    """A real server on an ephemeral port, and a client that signs the way the bridge does."""

    def setUp(self) -> None:
        super().setUp()
        self.base_url = self.start_server()
        for subject, capability in (
            (DESIGNER, "design.coordinate"),
            (ARCHITECT, "architecture.design"),
            (SECURITY_REVIEWER, "security.review"),
        ):
            grant(self.db, subject, capability)
        self.run_id = ""

    def call(
        self,
        method: str,
        path: str,
        body: Any = None,
        *,
        actor: Mapping[str, Any] | None = None,
        headers: Mapping[str, str] | None = None,
        scope: Mapping[str, str] | None = None,
    ) -> tuple[int, dict[str, Any], dict[str, str]]:
        payload = b"" if body is None else json.dumps(body).encode("utf-8")
        # `scope` is forwarded so a test can ask what a *different* tenant sees. Without it, the
        # only way to test cross-tenant isolation is to reach past the signed client, which is
        # exactly the kind of shortcut that lets an isolation bug look tested.
        merged = self.client.headers(method, path, payload, actor=actor, scope=scope)
        if headers:
            merged.update(headers)
        return http_call(self.base_url, method, path, body, merged)

    # -- assertions -----------------------------------------------------

    def node(self, node_id: str) -> dict[str, Any]:
        _, snapshot, _ = self.call("GET", f"/v1/runs/{self.run_id}")
        return next(n for n in snapshot["nodes"] if n["nodeId"] == node_id)

    def snapshot(self) -> dict[str, Any]:
        return self.call("GET", f"/v1/runs/{self.run_id}")[1]

    def event_types(self) -> list[str]:
        _, page, _ = self.call("GET", f"/v1/runs/{self.run_id}/events?after=0&limit=200")
        return [event["type"] for event in page["events"]]

    # -- the flow, step by step ----------------------------------------

    def publish_design(self, label: str = "authored over HTTP", generation: int = 0) -> int:
        """Create, edit, validate, compile, review, publish and activate - all over HTTP.

        ``label`` becomes the draft's description, so a second call publishes a genuinely
        different version rather than a copy, and ``generation`` is the pointer CAS the caller
        must present.
        """
        status, draft, headers = self.call(
            "POST", "/v1/graphs/design/drafts", {"definition": design_graph()}, actor=AUTHOR_ACTOR
        )
        self.assertEqual(status, 201, msg=draft)
        self.assertEqual(headers["ETag"], '"1"')
        draft_id = draft["draftId"]

        edited = design_graph()
        edited["description"] = label
        status, patched, headers = self.call(
            "PATCH",
            f"/v1/drafts/{draft_id}",
            {"definition": edited},
            actor=AUTHOR_ACTOR,
            headers={"If-Match": '"1"'},
        )
        self.assertEqual(status, 200, msg=patched)
        self.assertEqual(headers["ETag"], '"2"')

        status, report, _ = self.call("POST", f"/v1/drafts/{draft_id}/validate", actor=AUTHOR_ACTOR)
        self.assertEqual(status, 200, msg=report)
        self.assertTrue(report["ok"], msg=report)
        self.assertEqual(report["revision"], 2)

        status, compiled, _ = self.call(
            "POST", f"/v1/drafts/{draft_id}/compile", actor=AUTHOR_ACTOR
        )
        self.assertEqual(status, 200, msg=compiled)
        self.assertEqual(compiled["revision"], 2)

        status, reviewed, _ = self.call(
            "POST",
            f"/v1/drafts/{draft_id}/reviews",
            {"reviewTargetHash": compiled["planHash"]},
            actor=REVIEWER_ACTOR,
        )
        self.assertEqual(status, 200, msg=reviewed)

        status, version, _ = self.call(
            "POST",
            f"/v1/drafts/{draft_id}/publish",
            {
                "expectedRevision": 2,
                "definitionHash": reviewed["definitionHash"],
                "compilerVersion": compiled["compilerVersion"],
                "planHash": compiled["planHash"],
                "reviewTargetHash": compiled["planHash"],
            },
            actor=AUTHOR_ACTOR,
        )
        self.assertEqual(status, 201, msg=version)

        status, pointer, _ = self.call(
            "POST",
            "/v1/graphs/design/activate",
            {"version": version["version"], "expectedGeneration": generation},
            actor=AUTHOR_ACTOR,
        )
        self.assertEqual(status, 200, msg=pointer)
        self.assertEqual(pointer["generation"], generation + 1)
        return int(version["version"])

    def admit(self, start_intent: str = "e2e-1") -> str:
        """Admit with no inline definition: the run is pinned to the published version."""
        status, snapshot, _ = self.call(
            "POST",
            "/v1/work-orders",
            {
                "commandId": ids.new_id("command"),
                "idempotencyKey": f"admission:{start_intent}:design.start",
                "correlationId": "corr-e2e",
                "startIntentId": start_intent,
                "graphId": "design",
                "entrypoint": "design.start",
                "rootIssueRef": {"provider": "paperclip", "kind": "issue", "id": "issue-e2e"},
                "inputSnapshot": {"requirement_baseline": {"id": "rb-1"}},
                "requiredFacts": {
                    "requirement_gate_passed": {
                        "source": "imp-1",
                        "sourceRevision": "rev-7",
                        "contentHash": "sha256:" + "ab" * 32,
                    }
                },
                "policyRules": [allow_rule()],
            },
        )
        self.assertEqual(status, 201, msg=snapshot)
        self.assertEqual(snapshot["graphVersion"], 1)
        self.assertEqual(snapshot["pins"]["graphVersion"], "1")
        self.assertEqual(snapshot["status"], "ACTIVE")
        self.run_id = str(snapshot["runId"])
        return self.run_id

    def claim(self, node_id: str, subject: str) -> dict[str, Any]:
        status, attempt, _ = self.call(
            "POST",
            f"/v1/runs/{self.run_id}/claims",
            {
                "commandId": ids.new_id("command"),
                "nodeId": node_id,
                "iteration": 0,
                "agentSubject": subject,
                "agentRunRef": {"provider": "paperclip", "kind": "agent_run", "id": f"ar-{subject}"},
                "issueRef": {"provider": "paperclip", "kind": "issue", "id": f"issue-{node_id}"},
            },
            actor=agent_actor(subject),
        )
        self.assertEqual(status, 200, msg=attempt)
        return attempt

    def record(
        self, attempt: Mapping[str, Any], node_id: str, tag: str, kinds: tuple[str, ...]
    ) -> list[str]:
        """Register artifacts and submit evidence against an existing attempt. Returns their ids.

        Split out of ``work`` so a gate can hold evidence before its transition is requested.
        """
        common = {
            "nodeId": node_id,
            "attemptId": attempt["attemptId"],
            "leaseEpoch": attempt["leaseEpoch"],
        }
        artifacts = [
            artifact(kind, "a" if index == 0 else "b") for index, kind in enumerate(kinds)
        ]
        status, registered, _ = self.call(
            "POST",
            f"/v1/runs/{self.run_id}/artifacts",
            {
                **common,
                "commandId": ids.new_id("command"),
                "idempotencyKey": f"{self.run_id}:{node_id}:{tag}:artifacts",
                "payload": {"artifacts": artifacts},
            },
        )
        self.assertEqual(status, 200, msg=registered)
        status, evidence, _ = self.call(
            "POST",
            f"/v1/runs/{self.run_id}/evidence",
            {
                **common,
                "commandId": ids.new_id("command"),
                "idempotencyKey": f"{self.run_id}:{node_id}:{tag}:evidence",
                "payload": {
                    "evidence": [
                        {
                            "kind": kind,
                            "artifacts": [
                                {
                                    "artifactId": f"submitted-{kind}",
                                    "kind": kind,
                                    "contentHash": item["contentHash"],
                                    "mediaType": item["mediaType"],
                                    "size": item["size"],
                                }
                            ],
                            "detail": evidence_detail(kind),
                        }
                        for kind, item in zip(kinds, artifacts, strict=True)
                    ]
                },
            },
        )
        self.assertEqual(status, 200, msg=evidence)
        return list(evidence["resultRef"].split(","))

    def work(
        self, node_id: str, subject: str, kinds: tuple[str, ...], tag: str
    ) -> dict[str, Any]:
        """Claim, register artifacts, submit evidence, request the transition."""
        attempt = self.claim(node_id, subject)
        evidence_ids = self.record(attempt, node_id, tag, kinds)
        common = {
            "nodeId": node_id,
            "attemptId": attempt["attemptId"],
            "leaseEpoch": attempt["leaseEpoch"],
        }
        request = {
            **common,
            "commandId": ids.new_id("command"),
            "idempotencyKey": f"{self.run_id}:{node_id}:{tag}:transition",
            "payload": {
                "evidenceIds": evidence_ids,
                "summary": "work finished",
            },
        }
        # Kept so a replay can present the *same* payload. The same key with a different payload
        # is a 409 by design, and that is a different test.
        self.last_transition_request = request
        status, transition, _ = self.call(
            "POST", f"/v1/runs/{self.run_id}/transitions", request
        )
        self.assertEqual(status, 200, msg=transition)
        return transition

    def arm_design_gate(self) -> dict[str, Any]:
        """Claim the design gate. The threat model it judges was authored upstream."""
        return self.claim("design_gate", DESIGNER)

    def settle_outbox(self, batch: dict[str, Any] | None = None) -> int:
        """Acknowledge every intent in ``batch`` (or in a fresh poll). Returns how many.

        The batch matters: a second poll of a live lease returns nothing, so re-polling instead
        of settling what was already claimed would silently settle nothing.
        """
        if batch is None:
            _, batch, _ = self.call("GET", "/v1/bridge/outbox?limit=50")
        for intent in batch["intents"]:
            status, ack, _ = self.call(
                "POST",
                f"/v1/bridge/outbox/{intent['intentId']}/delivery",
                {"state": "delivered", "receipt": {"providerRef": {"id": intent["intentId"]}}},
            )
            self.assertEqual(status, 200, msg=ack)
        return int(batch["count"])


class GraphLibraryTests(HttpFlowCase):
    """`GET /v1/graphs`, the read behind the bridge's ``graph-library`` data key.

    Kept out of ``PassPathTests`` on purpose: that class publishes and activates in ``setUp``, so
    reading the library there would start from a graph that already exists and could not show the
    transition from empty to listed, which is the half that was broken.
    """

    def test_an_empty_library_lists_nothing(self) -> None:
        status, body, _ = self.call("GET", "/v1/graphs", actor=AUTHOR_ACTOR)
        self.assertEqual(status, 200)
        self.assertEqual(body["graphs"], [], "a graph that has never been published is not in the library")

    def test_the_library_lists_a_graph_once_it_has_a_published_version(self) -> None:
        # The route is pinned here because the bridge has pointed at it since it was written and it
        # did not exist: every library read through the host failed with "no such route", which reads
        # like a Core outage rather than a missing endpoint.
        self.publish_design()

        status, body, _ = self.call("GET", "/v1/graphs", actor=AUTHOR_ACTOR)
        self.assertEqual(status, 200)
        graphs = body["graphs"]
        self.assertEqual([g["graphId"] for g in graphs], ["design"])
        self.assertEqual(graphs[0]["activeVersion"], 1)
        self.assertEqual(graphs[0]["versionCount"], 1)
        self.assertTrue(graphs[0]["isActive"])

    def test_a_graph_with_only_a_draft_is_not_listed(self) -> None:
        # Listing a half-authored graph next to a published one invites an operator to point a work
        # order at something that was never compiled.
        status, _, _ = self.call(
            "POST",
            "/v1/graphs/design/drafts",
            {"author": "author-1", "baseVersion": None},
            actor=AUTHOR_ACTOR,
        )
        self.assertEqual(status, 201)

        status, body, _ = self.call("GET", "/v1/graphs", actor=AUTHOR_ACTOR)
        self.assertEqual(status, 200)
        self.assertEqual(body["graphs"], [])

    def test_the_library_reports_the_active_version_entrypoints(self) -> None:
        # The bridge decides *where* to enter a graph from this field and nothing else, and it does
        # so before it writes anything durable. When the field was absent the bridge refused with
        # "the graph declares no entrypoint", which is indistinguishable from a graph that genuinely
        # has none — so admission could never start, and the error pointed at the graph rather than
        # at the missing contract.
        self.publish_design()
        status, body, _ = self.call("GET", "/v1/graphs", actor=AUTHOR_ACTOR)
        self.assertEqual(status, 200)
        entry = body["graphs"][0]
        # The shipped `design` graph declares three entrypoints on purpose: entering it is a real
        # choice, not a default. The bridge refuses to pick one on the caller's behalf, so a caller
        # that wants `design.start` has to say so.
        self.assertEqual(
            sorted(entry["entrypoints"]),
            ["design.resume_review", "design.security_review", "design.start"],
        )
        self.assertIsInstance(entry["description"], str)
        # `name` is the graph's own human label, not its id; the library renders it, so an id-shaped
        # fallback would be a silent downgrade rather than a visible error.
        self.assertEqual(entry["name"], "Design")
        self.assertEqual(entry["graphId"], "design")

    def test_the_library_is_scoped_and_never_unions_tenants(self) -> None:
        self.publish_design()
        status, body, _ = self.call(
            "GET",
            "/v1/graphs",
            actor=AUTHOR_ACTOR,
            scope={"companyRef": "company-b", "projectRef": "project-b"},
        )
        self.assertEqual(status, 200)
        self.assertEqual(
            body["graphs"],
            [],
            "another tenant's published graph must not appear in this scope",
        )

class PassPathTests(HttpFlowCase):
    """The happy path: author, admit, work, transition, observe."""

    def setUp(self) -> None:
        super().setUp()
        self.publish_design()
        self.admit()

    def test_current_names_the_previous_owner_and_whether_this_caller_may_claim(self) -> None:
        """The two facts a bridge cannot infer, and must not have to guess.

        `previousOwnerAgentRunId` is whose attempt a caller would be taking. `attempt` describes the
        *current* holder, so it cannot answer that, and without it the adoption stop-check has no
        subject: a live previous owner would be adopted silently. `claimable` says whether *this*
        caller may claim, not whether anyone is holding, because an agent run re-entering its own
        live claim has to be able to read it back.

        The bridge read both from a flat response where the Core had never put them and defaulted
        them, while the test harness agreed with the bridge. These assertions are on the Core side so
        neither end can lose the field unnoticed again.
        """
        status, body, _ = self.call(
            "GET", f"/v1/runs/{self.run_id}/current", actor=agent_actor(DESIGNER)
        )
        self.assertEqual(status, 200)
        self.assertIn("previousOwnerAgentRunId", body)
        self.assertIn("claimable", body)
        # Nothing has been claimed yet, so no attempt has been superseded.
        self.assertIsNone(body["previousOwnerAgentRunId"])
        self.assertTrue(body["claimable"], "an unheld node is claimable")

    def test_a_held_node_is_not_claimable_by_another_caller(self) -> None:
        self.claim("architecture", DESIGNER)

        status, body, _ = self.call(
            "GET", f"/v1/runs/{self.run_id}/current", actor=agent_actor(ARCHITECT)
        )
        self.assertEqual(status, 200)
        self.assertFalse(body["claimable"], "a node held by another run is not claimable by this one")

        # The holder itself may still read its own claim back: that is re-entry, not a second claim.
        status, body, _ = self.call(
            "GET", f"/v1/runs/{self.run_id}/current", actor=agent_actor(DESIGNER)
        )
        self.assertEqual(status, 200)
        self.assertTrue(body["claimable"], "the holder must be able to re-enter its own claim")

    def test_the_run_is_pinned_to_the_published_version(self) -> None:
        snapshot = self.snapshot()
        self.assertEqual(snapshot["graphVersion"], 1)
        self.assertEqual(snapshot["scope"]["companyRef"], "company-a")
        self.assertTrue(snapshot["pins"]["planHash"].startswith("sha256:"))

    def test_admission_releases_only_the_start_node(self) -> None:
        self.assertEqual(self.node("architecture")["status"], "READY")
        self.assertEqual(self.node("security_review")["status"], "PENDING")
        self.assertEqual(self.node("design_gate")["status"], "PENDING")

    def test_the_worker_reads_its_contract_and_its_permissions(self) -> None:
        self.claim("architecture", ARCHITECT)
        status, view, _ = self.call(
            "GET",
            f"/v1/runs/{self.run_id}/current?nodeId=architecture",
            actor=agent_actor(ARCHITECT),
        )
        self.assertEqual(status, 200, msg=view)
        self.assertEqual(view["nodeId"], "architecture")
        self.assertTrue(view["contract"]["contractHash"].startswith("sha256:"))
        self.assertIn("baseline", view["inputs"])
        self.assertIn("polyforge.submit_evidence", view["permittedActions"])
        self.assertIsNotNone(view["attempt"])

    def test_a_committed_transition_passes_the_node_and_releases_the_next(self) -> None:
        transition = self.work(
            "architecture", ARCHITECT, ("architecture_spec", "api_contract"), "arch"
        )
        self.assertTrue(transition["applied"], msg=transition)
        self.assertEqual(transition["status"], "PASSED")
        self.assertEqual(self.node("architecture")["status"], "PASSED")
        self.assertEqual(self.node("security_review")["status"], "READY")

    def test_an_observation_alone_never_passes_a_node(self) -> None:
        """AT-04: an issue dragged to done is a record, not a result."""
        self.claim("architecture", ARCHITECT)
        status, observed, _ = self.call(
            "POST",
            "/v1/events",
            {
                "type": "pf.execution.observed",
                "runId": self.run_id,
                "source": "paperclip",
                "sourceEventId": "issue-99-status-changed",
                "payload": {"nodeId": "architecture", "status": "done"},
            },
        )
        self.assertEqual(status, 202, msg=observed)
        self.assertTrue(observed["accepted"])
        self.assertNotEqual(self.node("architecture")["status"], "PASSED")

    def test_a_replayed_event_produces_no_second_record(self) -> None:
        event = {
            "type": "pf.execution.observed",
            "runId": self.run_id,
            "source": "paperclip",
            "sourceEventId": "issue-99-status-changed",
            "payload": {"nodeId": "architecture", "status": "done"},
        }
        self.call("POST", "/v1/events", event)
        before = self.snapshot()["eventSequence"]
        _, duplicate, _ = self.call("POST", "/v1/events", event)
        self.assertTrue(duplicate["duplicate"])
        self.assertEqual(self.snapshot()["eventSequence"], before)

    def test_a_replayed_transition_produces_no_second_pass(self) -> None:
        self.work("architecture", ARCHITECT, ("architecture_spec", "api_contract"), "arch")
        before = self.snapshot()
        status, replay, _ = self.call(
            "POST", f"/v1/runs/{self.run_id}/transitions", dict(self.last_transition_request)
        )
        self.assertEqual(status, 200, msg=replay)
        after = self.snapshot()
        self.assertEqual(after["stateVersion"], before["stateVersion"])
        self.assertEqual(after["eventSequence"], before["eventSequence"])
        self.assertEqual(len(after["attempts"]), 1)

    def test_the_same_key_with_a_different_payload_is_a_conflict(self) -> None:
        """AT-26: only the payload that produced the recorded outcome may read it back."""
        self.work("architecture", ARCHITECT, ("architecture_spec", "api_contract"), "arch")
        altered = dict(self.last_transition_request)
        altered["payload"] = {**altered["payload"], "summary": "a different summary"}
        altered["commandId"] = ids.new_id("command")
        status, body, _ = self.call(
            "POST", f"/v1/runs/{self.run_id}/transitions", altered
        )
        self.assertError(status, body, ErrorCode.IDEMPOTENCY_CONFLICT.value)

    def test_the_event_stream_tells_the_whole_story_in_order(self) -> None:
        self.work("architecture", ARCHITECT, ("architecture_spec", "api_contract"), "arch")
        _, page, _ = self.call("GET", f"/v1/runs/{self.run_id}/events?after=0&limit=200")
        self.assertEqual(
            [event["seq"] for event in page["events"]], list(range(1, len(page["events"]) + 1))
        )
        for expected in (
            "pf.work_order.accepted",
            "pf.node.ready",
            "pf.evidence.ingested",
            "pf.gate.evaluated",
            "pf.transition.committed",
        ):
            self.assertIn(expected, [event["type"] for event in page["events"]])
        self.assertEqual(page["eventSequence"], page["nextAfter"])

    def test_the_bridge_can_drain_and_settle_the_outbox(self) -> None:
        _, batch, _ = self.call("GET", "/v1/bridge/outbox?limit=50")
        self.assertIn("work.unit.ensure", {intent["kind"] for intent in batch["intents"]})
        self.assertGreaterEqual(self.settle_outbox(batch), 1)
        _, health, _ = self.call("GET", "/v1/health")
        self.assertEqual(health["store"]["outboxPending"], 0)

    def test_the_state_survives_a_fresh_connection(self) -> None:
        """Nothing lives in the connection: a new socket sees the same authoritative state."""
        self.work("architecture", ARCHITECT, ("architecture_spec", "api_contract"), "arch")
        snapshot = self.snapshot()
        self.assertEqual(snapshot["status"], "ACTIVE")
        self.assertEqual(self.node("architecture")["status"], "PASSED")
        self.assertEqual(len(snapshot["attempts"]), 1)

    def test_the_whole_run_can_be_driven_to_completion(self) -> None:
        self.work("architecture", ARCHITECT, ("architecture_spec", "api_contract"), "arch")
        self.work("security_review", SECURITY_REVIEWER, ("security_review", "threat_model"), "sec")
        gate = self.arm_design_gate()
        status, decision, _ = self.call(
            "POST",
            f"/v1/runs/{self.run_id}/transitions",
            {
                "nodeId": "design_gate",
                "attemptId": gate["attemptId"],
                "leaseEpoch": gate["leaseEpoch"],
                "commandId": ids.new_id("command"),
                "idempotencyKey": f"{self.run_id}:design_gate:gate:transition",
                "payload": {"evidenceIds": [], "summary": "ready for a decision"},
            },
        )
        self.assertEqual(status, 202, msg=decision)
        self.assertTrue(decision["pending"])
        self.settle_outbox()
        self.assertEqual(self.node("design_gate")["status"], "WAITING_GOVERNANCE")


class HumanDecisionPathTests(HttpFlowCase):
    """The gate parks on a human, the run waits, and a verified answer re-runs the gate."""

    def setUp(self) -> None:
        super().setUp()
        self.publish_design()
        self.admit()
        self.work("architecture", ARCHITECT, ("architecture_spec", "api_contract"), "arch")
        self.work("security_review", SECURITY_REVIEWER, ("security_review", "threat_model"), "sec")
        self.transition = self.park_on_the_gate()
        # Captured while it is still PENDING: once resolved, the request leaves the pending
        # list, so a later read would find nothing.
        self.request_id = self.snapshot()["pendingGovernance"][0]["requestId"]
        self.target_hash = self.snapshot()["pendingGovernance"][0]["decisionTargetHash"]

    def park_on_the_gate(self) -> dict[str, Any]:
        gate = self.arm_design_gate()
        status, decision, _ = self.call(
            "POST",
            f"/v1/runs/{self.run_id}/transitions",
            {
                "nodeId": "design_gate",
                "attemptId": gate["attemptId"],
                "leaseEpoch": gate["leaseEpoch"],
                "commandId": ids.new_id("command"),
                "idempotencyKey": f"{self.run_id}:design_gate:gate:transition",
                "payload": {"evidenceIds": [], "summary": "ready for a decision"},
            },
        )
        self.assertEqual(status, 202, msg=decision)
        return decision

    def pending(self) -> dict[str, Any]:
        return self.snapshot()["pendingGovernance"][0]

    def resolve(
        self, outcome: str, **overrides: Any
    ) -> tuple[int, dict[str, Any], dict[str, str]]:
        """Resolve, discarding the request that was sent."""
        status, body, _headers, _request = self.resolve_request(outcome, **overrides)
        return status, body

    def resolve_request(
        self, outcome: str, **overrides: Any
    ) -> tuple[int, dict[str, Any], dict[str, str], dict[str, Any]]:
        """Resolve and also return the exact request, so a replay can be byte-identical."""
        request = {
            "commandId": ids.new_id("command"),
            "idempotencyKey": f"e2e:resolution:{outcome}",
            "responderSubject": REVIEWER,
            "responderKind": "human",
            "outcome": outcome,
            "verifiedAgainstProvider": True,
            "detail": {
                "decisionTargetHash": self.target_hash,
                "reason": f"{outcome} after reading the authoritative object",
            },
        }
        request.update(overrides)
        status, body, headers = self.call(
            "POST",
            f"/v1/runs/{self.run_id}/governance/{self.request_id}/resolution",
            request,
            actor=REVIEWER_ACTOR,
        )
        return status, body, headers, request

    def test_the_gate_returns_202_with_the_command_envelope(self) -> None:
        self.assertEqual(self.transition["status"], "WAITING_GOVERNANCE")
        self.assertTrue(self.transition["pending"])
        self.assertEqual(self.transition["pendingReason"], "awaiting_verified_human_decision")
        self.assertIn("commandId", self.transition)
        self.assertNotIn("error", self.transition)

    def test_a_waiting_run_occupies_durable_state_and_no_worker(self) -> None:
        gate = self.node("design_gate")
        self.assertEqual(gate["status"], "WAITING_GOVERNANCE")
        self.assertIsNone(gate["activeAttemptId"])
        self.assertIsNotNone(gate["waitReason"])
        self.assertEqual(self.snapshot()["status"], "WAITING")

    def test_the_request_carries_the_exact_decision_target(self) -> None:
        pending = self.pending()
        self.assertEqual(pending["semanticKind"], "design_acceptance")
        self.assertTrue(pending["decisionTargetHash"].startswith("sha256:"))
        self.assertIsNone(pending["resolvedAt"])
    def test_an_unverified_answer_is_refused(self) -> None:
        """AT-13/AT-14: a callback carrying approved=true is never trusted on its own."""
        status, body = self.resolve("accept", verifiedAgainstProvider=False)
        self.assertError(status, body, ErrorCode.AUTHORIZATION_DENIED.value)
        self.assertEqual(self.node("design_gate")["status"], "WAITING_GOVERNANCE")
        self.assertIsNone(self.pending()["resolvedAt"])

    def test_an_agent_cannot_answer_a_human_only_request(self) -> None:
        status, body = self.resolve("accept", responderSubject=ARCHITECT, responderKind="agent")
        self.assertError(status, body, ErrorCode.AUTHORIZATION_DENIED.value)
        self.assertEqual(self.node("design_gate")["status"], "WAITING_GOVERNANCE")

    def test_a_verified_human_answer_re_evaluates_and_passes(self) -> None:
        status, resolution = self.resolve("accept")
        self.assertEqual(status, 200, msg=resolution)
        self.assertEqual(resolution["status"], "PASSED")
        self.assertEqual(self.node("design_gate")["status"], "PASSED")
        self.assertEqual(self.snapshot()["status"], "COMPLETED")
        # The request leaves the *pending* list once answered; the durable record is the event.
        self.assertIn("pf.governance.observed", self.event_types())

    def test_a_human_rejection_sends_the_node_back_for_rework(self) -> None:
        status, resolution = self.resolve("reject")
        self.assertEqual(status, 200, msg=resolution)
        self.assertEqual(resolution["status"], "REWORK_REQUIRED")

    def test_a_replayed_resolution_returns_the_recorded_outcome(self) -> None:
        """Same key and same payload: the recorded result, and nothing applied twice."""
        status, first, _headers, request = self.resolve_request("accept")
        self.assertEqual(status, 200, msg=first)
        after_first = self.snapshot()
        replay_status, replay, _ = self.call(
            "POST",
            f"/v1/runs/{self.run_id}/governance/{self.request_id}/resolution",
            request,
            actor=REVIEWER_ACTOR,
        )
        self.assertEqual(replay_status, 200, msg=replay)
        self.assertEqual(self.snapshot()["stateVersion"], after_first["stateVersion"])

    def test_an_unknown_governance_request_is_a_404(self) -> None:
        status, body, _ = self.call(
            "POST",
            f"/v1/runs/{self.run_id}/governance/dec_nope/resolution",
            {
                "commandId": ids.new_id("command"),
                "responderSubject": REVIEWER,
                "responderKind": "human",
                "outcome": "accept",
                "verifiedAgainstProvider": True,
            },
            actor=REVIEWER_ACTOR,
        )
        self.assertError(status, body, ErrorCode.NOT_FOUND.value)

    def test_the_waiting_run_emits_the_governance_events(self) -> None:
        types = self.event_types()
        self.assertIn("pf.gate.waiting", types)
        self.assertIn("pf.governance.requested", types)

    def test_a_body_naming_another_company_is_refused_on_the_resolution_route(self) -> None:
        """The body-scope check applies to every route, not just the ones that write state."""
        payload = {
            "commandId": ids.new_id("command"),
            "companyRef": "company-b",
            "responderSubject": REVIEWER,
            "responderKind": "human",
            "outcome": "accept",
            "verifiedAgainstProvider": True,
        }
        raw = json.dumps(payload).encode("utf-8")
        merged = self.client.headers(
            "POST",
            f"/v1/runs/{self.run_id}/governance/{self.request_id}/resolution",
            raw,
            actor=REVIEWER_ACTOR,
            scope=SCOPE_B,
        )
        status, body, _ = http_call(
            self.base_url,
            "POST",
            f"/v1/runs/{self.run_id}/governance/{self.request_id}/resolution",
            payload,
            merged,
        )
        self.assertError(status, body, ErrorCode.SCOPE_VIOLATION.value)


class MigrationCommitFlowTests(HttpFlowCase):
    """AT-21 over HTTP: the whole authoring-to-cutover path, and every refusal on the way.

    A run is admitted on the version the registry activated, a second version is published and
    activated, and the commit route must return ``200`` — the target is resolved through the
    registry, which is the only place a published version exists. Each refusal gets its
    documented status so a 423 here is never mistaken for a 404.
    """

    def setUp(self) -> None:
        super().setUp()
        self.source_version = self.publish_design("the version under work")
        self.admit("migrate-e2e-1")
        self.target_version = self.publish_design("the version to migrate onto", generation=1)

    def plan(self, target: int | None = None, **overrides: Any) -> dict[str, Any]:
        body: dict[str, Any] = {"targetGraphVersion": self.target_version if target is None else target}
        body.update(overrides)
        status, preview, _ = self.call(
            "POST", f"/v1/runs/{self.run_id}/migrations/plan", body
        )
        self.assertEqual(status, 200, msg=preview)
        return preview

    def commit(self, preview: Mapping[str, Any], **overrides: Any) -> tuple[int, dict[str, Any]]:
        body: dict[str, Any] = {
            "targetGraphVersion": self.target_version,
            "planHash": preview["planHash"],
            "commandId": ids.new_id("command"),
            "idempotencyKey": f"migrate:{self.run_id}:{preview['planHash'][:16]}",
            "approvalRefs": ["approval-migration-1"],
        }
        body.update(overrides)
        status, result, _ = self.call(
            "POST", f"/v1/runs/{self.run_id}/migrations/commit", body
        )
        return status, result

    def test_a_quiescent_run_is_migrated_onto_the_published_target(self) -> None:
        preview = self.plan()
        self.assertTrue(preview["quiescent"], msg=preview)
        self.assertEqual(preview["sourceGraphVersion"], self.source_version)
        self.assertEqual(preview["targetGraphVersion"], self.target_version)
        self.assertEqual(self.db.scalar("SELECT COUNT(*) FROM graph_runs"), 1)

        status, result = self.commit(preview)

        self.assertEqual(status, 200, msg=result)
        self.assertTrue(result["applied"], msg=result)
        successor_id = str(result["resultRef"])
        successor = self.call("GET", f"/v1/runs/{successor_id}")[1]
        self.assertEqual(successor["graphVersion"], self.target_version)
        self.assertEqual(successor["parentRunId"], self.run_id)
        self.assertEqual(successor["pins"]["migratedFrom"], self.run_id)
        self.assertEqual(self.snapshot()["status"], "PAUSED")
        record = self.db.query_one(
            "SELECT * FROM migration_records WHERE successor_run_id = ?", (successor_id,)
        )
        self.assertIsNotNone(record)
        self.assertEqual(str(record["status"]), "COMMITTED")
        _, batch, _ = self.call("GET", "/v1/bridge/outbox?limit=50")
        self.assertIn(
            "migration.applied", [intent["kind"] for intent in batch["intents"]]
        )

    def test_a_replayed_commit_returns_the_recorded_result(self) -> None:
        preview = self.plan()
        first_status, first = self.commit(preview)
        self.assertEqual(first_status, 200, msg=first)
        replay_status, replay = self.commit(preview)
        self.assertEqual(replay_status, 200, msg=replay)
        self.assertEqual(replay["commandId"], first["commandId"])
        self.assertEqual(replay["resultRef"], first["resultRef"])
        self.assertEqual(self.db.scalar("SELECT COUNT(*) FROM migration_records"), 1)

    def test_a_live_worker_lease_is_a_423(self) -> None:
        preview = self.plan()
        self.claim("architecture", ARCHITECT)
        status, body = self.commit(preview)
        error = self.assertError(status, body, ErrorCode.RUN_BLOCKED.value)
        self.assertIn("ACTIVE_ATTEMPT", [b["code"] for b in error["details"]["blockers"]])
        self.assertEqual(self.db.scalar("SELECT COUNT(*) FROM migration_records"), 0)

    def test_a_source_that_moved_since_the_plan_is_a_409(self) -> None:
        preview = self.plan()
        # The run advances without a live worker: the plan was computed against a state that no
        # longer exists, so the commit is fenced on the plan hash.
        self.work("architecture", ARCHITECT, ("architecture_spec", "api_contract"), "moved")
        status, body = self.commit(preview)
        error = self.assertError(status, body, ErrorCode.VERSION_CONFLICT.value)
        self.assertIn("currentPlanHash", error["details"])
        self.assertEqual(self.db.scalar("SELECT COUNT(*) FROM migration_records"), 0)

    def test_an_unpublished_target_is_a_423_naming_the_version(self) -> None:
        missing = self.target_version + 1
        preview = self.plan(target=missing)
        self.assertIn(
            "TARGET_VERSION_UNKNOWN", [b["code"] for b in preview["blockers"]]
        )
        status, body = self.commit(preview, targetGraphVersion=missing)
        error = self.assertError(status, body, ErrorCode.RUN_BLOCKED.value)
        self.assertIn(
            "TARGET_VERSION_UNKNOWN", [b["code"] for b in error["details"]["blockers"]]
        )

    def test_a_mapping_onto_a_node_the_target_does_not_declare_is_a_423(self) -> None:
        preview = self.plan(nodeMapping={"architecture": "architecture_v2_absent"})
        self.assertIn("NODE_MAPPING_INCOMPLETE", [b["code"] for b in preview["blockers"]])
        status, body = self.commit(
            preview, nodeMapping={"architecture": "architecture_v2_absent"}
        )
        error = self.assertError(status, body, ErrorCode.RUN_BLOCKED.value)
        self.assertIn(
            "NODE_MAPPING_INCOMPLETE", [b["code"] for b in error["details"]["blockers"]]
        )
        self.assertEqual(self.db.scalar("SELECT COUNT(*) FROM graph_runs"), 1)

    def test_a_commit_without_approvals_is_a_403(self) -> None:
        preview = self.plan()
        status, body = self.commit(preview, approvalRefs=[])
        self.assertError(status, body, ErrorCode.AUTHORIZATION_DENIED.value)
        self.assertEqual(self.db.scalar("SELECT COUNT(*) FROM migration_records"), 0)

    def test_the_commit_is_refused_for_another_company(self) -> None:
        preview = self.plan()
        payload = {
            "targetGraphVersion": self.target_version,
            "planHash": preview["planHash"],
            "commandId": ids.new_id("command"),
            "idempotencyKey": "migrate:cross-company",
            "approvalRefs": ["approval-migration-1"],
        }
        raw = json.dumps(payload).encode("utf-8")
        merged = self.client.headers(
            "POST",
            f"/v1/runs/{self.run_id}/migrations/commit",
            raw,
            actor=agent_actor(ARCHITECT),
            scope=SCOPE_B,
        )
        status, body, _ = http_call(
            self.base_url,
            "POST",
            f"/v1/runs/{self.run_id}/migrations/commit",
            payload,
            merged,
        )
        self.assertError(status, body, ErrorCode.SCOPE_VIOLATION.value)
        self.assertEqual(self.db.scalar("SELECT COUNT(*) FROM migration_records"), 0)

    def test_a_pass_is_never_inherited_by_the_successor(self) -> None:
        self.work("architecture", ARCHITECT, ("architecture_spec", "api_contract"), "passed")
        preview = self.plan()
        self.assertIn("pass_inheritance", [i["kind"] for i in preview["invalidations"]])
        status, result = self.commit(preview)
        self.assertEqual(status, 200, msg=result)
        successor = self.call("GET", f"/v1/runs/{result['resultRef']}")[1]
        node = next(n for n in successor["nodes"] if n["nodeId"] == "architecture")
        self.assertNotEqual(node["status"], "PASSED")

    def test_health_reports_the_registry_that_resolved_the_versions(self) -> None:
        status, health, _ = self.client.call("GET", "/v1/health")
        self.assertEqual(status, 200, msg=health)
        self.assertTrue(health["store"]["registryWired"])
        self.assertNotEqual(health["status"], "blocked")


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
