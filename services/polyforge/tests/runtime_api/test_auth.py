"""The trust boundary: signature, window, nonce, and the actor-forgery guard.

AT-13 (a worker can never assert a human or forge an approval) and AT-29 (a cross-company
request is refused). Every case here is a *rejection*: the boundary is only as good as the
refusals it makes, so each test states the reason it expects as well as the code.
"""

from __future__ import annotations

import json
import unittest
from datetime import UTC, datetime, timedelta

from polyforge.core.errors import ERROR_STATUS, ErrorCode
from polyforge.services.runtime_api.auth import (
    ActorAssertion,
    AuthContext,
    AuthFailure,
    NonceCache,
    RequestAuthenticator,
    canonical_request_bytes,
    encode_b64url,
    sign_headers,
)
from polyforge.services.runtime_api.config import ConfigurationError, ServiceConfig
from services.polyforge.tests.runtime_api.fixtures import (
    AUDIENCE,
    ISSUER,
    PROJECT_A,
    SCOPE_A,
    SECRET,
    RuntimeApiCase,
    agent_actor,
    human_actor,
)

HEALTH = "/v1/health"


def _iso(offset_seconds: float = 0.0) -> str:
    return (
        (datetime.now(UTC) + timedelta(seconds=offset_seconds))
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


class SignatureRejectionTests(RuntimeApiCase):
    """AT-13, AT-29: a request that does not verify against the received bytes is refused."""

    def test_a_correctly_signed_request_is_accepted(self) -> None:
        status, body, headers = self.client.call("GET", HEALTH)
        self.assertEqual(status, 200, msg=body)
        self.assertEqual(body["status"], "ready", msg=body)
        self.assertIn("X-PF-Correlation-Id", headers)

    def test_a_missing_signature_header_is_refused(self) -> None:
        signed = self.client.headers("GET", HEALTH, b"")
        del signed["X-PF-Signature"]
        status, body, _ = self.client.call("GET", HEALTH, headers=signed, sign=False)
        error = self.assertError(status, body, ErrorCode.AUTHORIZATION_DENIED.value)
        self.assertEqual(error["details"]["reason"], "missing_header")
        self.assertIn("X-PF-Signature", error["details"]["missingHeaders"])

    def test_a_missing_issuer_header_is_refused(self) -> None:
        signed = self.client.headers("GET", HEALTH, b"")
        del signed["X-PF-Issuer"]
        status, body, _ = self.client.call("GET", HEALTH, headers=signed, sign=False)
        error = self.assertError(status, body, ErrorCode.AUTHORIZATION_DENIED.value)
        self.assertEqual(error["details"]["reason"], "missing_header")

    def test_no_headers_at_all_is_refused(self) -> None:
        status, body, _ = self.client.call("GET", HEALTH, sign=False)
        self.assertError(status, body, ErrorCode.AUTHORIZATION_DENIED.value)

    def test_a_tampered_signature_is_refused(self) -> None:
        signed = self.client.headers("GET", HEALTH, b"")
        good = signed["X-PF-Signature"]
        signed["X-PF-Signature"] = good[:-1] + ("0" if good[-1] != "0" else "1")
        status, body, _ = self.client.call("GET", HEALTH, headers=signed, sign=False)
        error = self.assertError(status, body, ErrorCode.AUTHORIZATION_DENIED.value)
        self.assertEqual(error["details"]["reason"], "bad_signature")

    def test_a_signature_from_the_wrong_secret_is_refused(self) -> None:
        signed = self.client.headers("GET", HEALTH, b"")
        signed["X-PF-Signature"] = sign_headers(
            secret="a-different-secret-0123456789abcd",
            method="GET",
            path=HEALTH,
            body=b"",
            issuer=ISSUER,
            actor=agent_actor(),
            scope=SCOPE_A,
            timestamp=signed["X-PF-Timestamp"],
            nonce=signed["X-PF-Nonce"],
            audience=AUDIENCE,
        ).signature
        status, body, _ = self.client.call("GET", HEALTH, headers=signed, sign=False)
        error = self.assertError(status, body, ErrorCode.AUTHORIZATION_DENIED.value)
        self.assertEqual(error["details"]["reason"], "bad_signature")

    def test_an_unknown_issuer_is_refused(self) -> None:
        signed = self.client.headers("GET", HEALTH, b"")
        signed["X-PF-Issuer"] = "some-other-bridge"
        status, body, _ = self.client.call("GET", HEALTH, headers=signed, sign=False)
        error = self.assertError(status, body, ErrorCode.AUTHORIZATION_DENIED.value)
        self.assertEqual(error["details"]["reason"], "unknown_issuer")
        self.assertEqual(error["details"]["presentedIssuer"], "some-other-bridge")

    def test_an_unknown_audience_is_refused(self) -> None:
        status, body, _ = self.client.call("GET", HEALTH, audience="some-other-service")
        error = self.assertError(status, body, ErrorCode.AUTHORIZATION_DENIED.value)
        self.assertEqual(error["details"]["reason"], "unknown_audience")

    def test_a_malformed_signature_is_refused_before_any_comparison(self) -> None:
        signed = self.client.headers("GET", HEALTH, b"")
        signed["X-PF-Signature"] = "v2=deadbeef"
        status, body, _ = self.client.call("GET", HEALTH, headers=signed, sign=False)
        error = self.assertError(status, body, ErrorCode.AUTHORIZATION_DENIED.value)
        self.assertEqual(error["details"]["reason"], "malformed_signature")

    def test_a_stale_timestamp_is_refused(self) -> None:
        status, body, _ = self.client.call("GET", HEALTH, timestamp=_iso(-3600))
        error = self.assertError(status, body, ErrorCode.AUTHORIZATION_DENIED.value)
        self.assertEqual(error["details"]["reason"], "stale_timestamp")
        self.assertEqual(error["details"]["replayWindowSeconds"], 120)

    def test_a_future_timestamp_beyond_the_window_is_refused(self) -> None:
        status, body, _ = self.client.call("GET", HEALTH, timestamp=_iso(3600))
        error = self.assertError(status, body, ErrorCode.AUTHORIZATION_DENIED.value)
        self.assertEqual(error["details"]["reason"], "stale_timestamp")

    def test_a_naive_timestamp_without_an_offset_is_refused(self) -> None:
        naive = datetime.now(UTC).replace(tzinfo=None).isoformat(timespec="milliseconds")
        status, body, _ = self.client.call("GET", HEALTH, timestamp=naive)
        error = self.assertError(status, body, ErrorCode.AUTHORIZATION_DENIED.value)
        self.assertEqual(error["details"]["reason"], "malformed_timestamp")

    def test_a_replayed_nonce_is_refused(self) -> None:
        nonce = self.client._nonce()
        status, body, _ = self.client.call("GET", HEALTH, nonce=nonce)
        self.assertEqual(status, 200)
        self.assertFalse(body.get("replayed"), msg="a served response is never a replay")
        replay_status, body, _ = self.client.call("GET", HEALTH, nonce=nonce)
        error = self.assertError(replay_status, body, ErrorCode.AUTHORIZATION_DENIED.value)
        self.assertEqual(error["details"]["reason"], "nonce_replay")
        self.assertTrue(error["details"]["replayed"])

    def test_a_replay_of_the_same_nonce_onto_another_path_is_still_a_replay(self) -> None:
        """The signature is checked first, so the nonce is only ever spent by a real request."""
        nonce = self.client._nonce()
        self.client.call("GET", HEALTH, nonce=nonce)
        status, body, _ = self.client.call("GET", "/v1/runs", nonce=nonce)
        self.assertError(status, body, ErrorCode.AUTHORIZATION_DENIED.value)

    def test_a_replay_of_the_same_signed_request_onto_another_path_is_refused(self) -> None:
        """The signature covers the path, so a captured admission cannot be replayed as a pause."""
        payload = json.dumps({"command": "pause", "reason": "x"}).encode("utf-8")
        signed = self.client.headers("POST", "/v1/work-orders", payload)
        status, body, _ = self.client.call(
            "POST", "/v1/runs/run_x/commands", headers=signed, sign=False
        )
        error = self.assertError(status, body, ErrorCode.AUTHORIZATION_DENIED.value)
        self.assertEqual(error["details"]["reason"], "bad_signature")

    def test_a_replay_with_a_mutated_body_is_refused(self) -> None:
        """The digest covers the exact received bytes, so a swapped body cannot verify."""
        original = json.dumps({"reason": "operator asked"}).encode("utf-8")
        signed = self.client.headers(
            "POST", "/v1/runs/run_x/commands", original, actor=human_actor()
        )
        mutated = json.dumps({"reason": "approved by nobody"}).encode("utf-8")
        status, body, _ = self.client.call(
            "POST", "/v1/runs/run_x/commands", raw_body=mutated, headers=signed, sign=False
        )
        error = self.assertError(status, body, ErrorCode.AUTHORIZATION_DENIED.value)
        self.assertEqual(error["details"]["reason"], "bad_signature")

    def test_a_replay_onto_another_actor_is_refused(self) -> None:
        signed = self.client.headers("GET", HEALTH, b"", actor=human_actor("user-anna"))
        signed["X-PF-Actor"] = encode_b64url(human_actor("user-mallory"))
        status, body, _ = self.client.call("GET", HEALTH, headers=signed, sign=False)
        error = self.assertError(status, body, ErrorCode.AUTHORIZATION_DENIED.value)
        self.assertEqual(error["details"]["reason"], "bad_signature")

    def test_a_replay_onto_another_scope_is_refused(self) -> None:
        signed = self.client.headers("GET", HEALTH, b"")
        signed["X-PF-Scope"] = encode_b64url(
            {"companyRef": "company-b", "projectRef": "project-b"}
        )
        status, body, _ = self.client.call("GET", HEALTH, headers=signed, sign=False)
        error = self.assertError(status, body, ErrorCode.AUTHORIZATION_DENIED.value)
        self.assertEqual(error["details"]["reason"], "bad_signature")

    def test_a_malformed_actor_assertion_is_refused(self) -> None:
        signed = self.client.headers("GET", HEALTH, b"")
        signed["X-PF-Actor"] = encode_b64url({"actorType": "wizard", "actorId": "x"})
        status, body, _ = self.client.call("GET", HEALTH, headers=signed, sign=False)
        error = self.assertError(status, body, ErrorCode.AUTHORIZATION_DENIED.value)
        self.assertEqual(error["details"]["reason"], "malformed_actor")

    def test_an_actor_assertion_without_an_id_is_refused(self) -> None:
        signed = self.client.headers("GET", HEALTH, b"")
        signed["X-PF-Actor"] = encode_b64url({"actorType": "agent", "actorId": ""})
        status, body, _ = self.client.call("GET", HEALTH, headers=signed, sign=False)
        error = self.assertError(status, body, ErrorCode.AUTHORIZATION_DENIED.value)
        self.assertEqual(error["details"]["reason"], "malformed_actor")

    def test_a_scope_without_a_company_is_refused(self) -> None:
        signed = self.client.headers("GET", HEALTH, b"")
        signed["X-PF-Scope"] = encode_b64url({"companyRef": "", "projectRef": PROJECT_A})
        status, body, _ = self.client.call("GET", HEALTH, headers=signed, sign=False)
        error = self.assertError(status, body, ErrorCode.AUTHORIZATION_DENIED.value)
        self.assertEqual(error["details"]["reason"], "malformed_scope")

    def test_a_malformed_nonce_is_refused(self) -> None:
        signed = self.client.headers("GET", HEALTH, b"")
        signed["X-PF-Nonce"] = "short"
        status, body, _ = self.client.call("GET", HEALTH, headers=signed, sign=False)
        error = self.assertError(status, body, ErrorCode.AUTHORIZATION_DENIED.value)
        self.assertEqual(error["details"]["reason"], "malformed_nonce")


class BodyForgeryTests(RuntimeApiCase):
    """AT-13: a body may not set an identity, and a body may not name another tenant.

    These are the two controls that make "the Core never reads a company or actor id from a
    request body" a property of the service rather than a convention in the handler.
    """

    def test_a_body_carrying_actor_id_is_refused(self) -> None:
        status, body, _ = self.client.call(
            "POST",
            "/v1/work-orders",
            {
                "startIntentId": "i-1",
                "graphId": "design",
                "entrypoint": "design.start",
                "actorId": "user-root",
            },
        )
        error = self.assertError(status, body, ErrorCode.CONTRACT_INVALID.value)
        self.assertIn("$.actorId", error["details"]["offendingFields"])

    def test_a_body_carrying_actor_type_human_is_refused(self) -> None:
        status, body, _ = self.client.call(
            "POST",
            "/v1/work-orders",
            {
                "startIntentId": "i-2",
                "graphId": "design",
                "entrypoint": "design.start",
                "actorType": "human",
            },
        )
        error = self.assertError(status, body, ErrorCode.CONTRACT_INVALID.value)
        self.assertIn("$.actorType", error["details"]["offendingFields"])

    def test_a_body_carrying_actor_user_id_is_refused(self) -> None:
        status, body, _ = self.client.call(
            "POST",
            "/v1/work-orders",
            {"startIntentId": "i-3", "actorUserId": "user-root"},
        )
        error = self.assertError(status, body, ErrorCode.CONTRACT_INVALID.value)
        self.assertIn("$.actorUserId", error["details"]["offendingFields"])

    def test_a_body_carrying_approved_is_refused(self) -> None:
        status, body, _ = self.client.call(
            "POST", "/v1/work-orders", {"startIntentId": "i-4", "approved": True}
        )
        error = self.assertError(status, body, ErrorCode.CONTRACT_INVALID.value)
        self.assertIn("$.approved", error["details"]["offendingFields"])

    def test_a_body_carrying_record_approval_is_refused(self) -> None:
        status, body, _ = self.client.call(
            "POST", "/v1/work-orders", {"startIntentId": "i-5", "record_approval": "yes"}
        )
        error = self.assertError(status, body, ErrorCode.CONTRACT_INVALID.value)
        self.assertIn("$.record_approval", error["details"]["offendingFields"])

    def test_a_nested_actor_in_a_command_payload_is_refused(self) -> None:
        """A shallow scan would be a hole: the same forgery, one level down."""
        status, body, _ = self.client.call(
            "POST",
            "/v1/work-orders",
            {
                "startIntentId": "i-6",
                "graphId": "design",
                "entrypoint": "design.start",
                "policyRules": [{"name": "p", "rules": [{"actor": {"actorType": "human"}}]}],
            },
        )
        error = self.assertError(status, body, ErrorCode.CONTRACT_INVALID.value)
        self.assertIn(
            "$.policyRules[0].rules[0].actor", error["details"]["offendingFields"]
        )

    def test_a_body_naming_another_company_is_a_scope_violation(self) -> None:
        status, body, _ = self.client.call(
            "POST",
            "/v1/work-orders",
            {
                "startIntentId": "i-7",
                "graphId": "design",
                "entrypoint": "design.start",
                "companyRef": "company-b",
            },
        )
        error = self.assertError(status, body, ErrorCode.SCOPE_VIOLATION.value)
        self.assertEqual(error["details"]["assertedScope"], SCOPE_A)
        self.assertIn({"field": "companyRef", "expected": "company-a"}, error["details"]["offendingFields"])

    def test_a_body_naming_another_project_is_a_scope_violation(self) -> None:
        status, body, _ = self.client.call(
            "POST",
            "/v1/work-orders",
            {"startIntentId": "i-8", "projectRef": "project-b"},
        )
        self.assertError(status, body, ErrorCode.SCOPE_VIOLATION.value)

    def test_a_nested_scope_that_disagrees_is_a_scope_violation(self) -> None:
        status, body, _ = self.client.call(
            "POST",
            "/v1/work-orders",
            {"startIntentId": "i-9", "scope": {"companyRef": "company-b", "projectRef": "project-b"}},
        )
        error = self.assertError(status, body, ErrorCode.SCOPE_VIOLATION.value)
        self.assertIn({"field": "scope.companyRef", "expected": "company-a"}, error["details"]["offendingFields"])

    def test_a_body_echoing_the_asserted_scope_is_accepted(self) -> None:
        """Echoing the scope back is not a forgery; refusing it would break a reasonable client."""
        status, body, _ = self.client.call(
            "GET", "/v1/runs", {"scope": dict(SCOPE_A)}
        )
        self.assertIn(status, (200, 400), msg=body)


class NonceCacheTests(unittest.TestCase):
    """The replay cache is fed by the network, so it is bounded and TTL'd."""

    def test_a_nonce_can_only_be_spent_once(self) -> None:
        cache = NonceCache(max_entries=8, ttl_seconds=60.0)
        self.assertTrue(cache.spend("n" * 16, now=0.0))
        self.assertFalse(cache.spend("n" * 16, now=0.0))

    def test_the_cache_is_bounded(self) -> None:
        cache = NonceCache(max_entries=4, ttl_seconds=60.0)
        for index in range(50):
            cache.spend(f"nonce{index:012d}", now=0.0)
        self.assertLessEqual(len(cache), 4)

    def test_an_expired_nonce_leaves_the_cache(self) -> None:
        cache = NonceCache(max_entries=8, ttl_seconds=10.0)
        self.assertTrue(cache.spend("n" * 16, now=0.0))
        # Still inside the TTL, so still refused: expiry is what frees it, not a later read.
        self.assertTrue(cache.seen("n" * 16, now=9.0))
        self.assertFalse(cache.seen("n" * 16, now=11.0))
        self.assertEqual(len(cache), 0)

    def test_eviction_under_pressure_does_not_grow_without_limit(self) -> None:
        cache = NonceCache(max_entries=16, ttl_seconds=3600.0)
        for index in range(10_000):
            cache.spend(f"nonce{index:012d}", now=float(index))
        self.assertLessEqual(len(cache), 16)


class CanonicalRequestTests(unittest.TestCase):
    """The signed string, pinned so the TypeScript bridge has something exact to match."""

    def test_the_canonical_object_has_exactly_nine_sorted_keys(self) -> None:
        raw = canonical_request_bytes(
            audience=AUDIENCE,
            method="post",
            path="/work-orders",
            body_hash="sha256:" + "ab" * 32,
            timestamp="2026-01-01T00:00:00.000Z",
            nonce="nonce-1",
            issuer=ISSUER,
            actor=agent_actor(),
            scope=SCOPE_A,
        )
        self.assertEqual(
            raw.decode("utf-8"),
            '{"actor":{"actorId":"agent-1","actorType":"agent","agentId":"agent-1","roles":[]},'
            '"audience":"polyforge-runtime","bodyHash":"sha256:' + "ab" * 32 + '",'
            f'"issuer":"{ISSUER}","method":"POST","nonce":"nonce-1","path":"/work-orders",'
            '"scope":{"companyRef":"company-a","projectRef":"project-a"},'
            '"timestamp":"2026-01-01T00:00:00.000Z"}',
        )

    def test_the_method_is_upper_cased(self) -> None:
        upper = canonical_request_bytes(
            audience=AUDIENCE, method="POST", path="/x", body_hash="sha256:" + "ab" * 32,
            timestamp="t", nonce="n", issuer=ISSUER, actor=agent_actor(), scope=SCOPE_A,
        )
        lower = canonical_request_bytes(
            audience=AUDIENCE, method="post", path="/x", body_hash="sha256:" + "ab" * 32,
            timestamp="t", nonce="n", issuer=ISSUER, actor=agent_actor(), scope=SCOPE_A,
        )
        self.assertEqual(upper, lower)

    def test_the_query_string_is_inside_the_signed_path(self) -> None:
        without = canonical_request_bytes(
            audience=AUDIENCE, method="GET", path="/runs", body_hash="sha256:" + "ab" * 32,
            timestamp="t", nonce="n", issuer=ISSUER, actor=agent_actor(), scope=SCOPE_A,
        )
        with_query = canonical_request_bytes(
            audience=AUDIENCE, method="GET", path="/runs?limit=5", body_hash="sha256:" + "ab" * 32,
            timestamp="t", nonce="n", issuer=ISSUER, actor=agent_actor(), scope=SCOPE_A,
        )
        self.assertNotEqual(without, with_query)

    def test_sign_headers_emits_the_documented_header_names(self) -> None:
        signed = sign_headers(
            secret=SECRET, method="GET", path="/health", body=b"", issuer=ISSUER,
            actor=agent_actor(), scope=SCOPE_A, timestamp="2026-01-01T00:00:00.000Z",
            nonce="nonce-1", audience=AUDIENCE,
        )
        self.assertEqual(
            sorted(signed.headers),
            [
                "X-PF-Actor",
                "X-PF-Audience",
                "X-PF-Issuer",
                "X-PF-Nonce",
                "X-PF-Scope",
                "X-PF-Signature",
                "X-PF-Timestamp",
            ],
        )
        self.assertTrue(signed.signature.startswith("v1="))
        self.assertEqual(len(signed.signature), 3 + 64)


class ActorAssertionTests(unittest.TestCase):
    def test_only_the_three_documented_actor_types_decode(self) -> None:
        for actor_type in ("human", "agent", "system"):
            self.assertIsNotNone(ActorAssertion.from_wire({"actorType": actor_type, "actorId": "x"}))
        for actor_type in ("worker", "ADMIN", "", "root"):
            self.assertIsNone(ActorAssertion.from_wire({"actorType": actor_type, "actorId": "x"}))

    def test_an_assertion_without_an_id_does_not_decode(self) -> None:
        self.assertIsNone(ActorAssertion.from_wire({"actorType": "agent", "actorId": "  "}))
        self.assertIsNone(ActorAssertion.from_wire({"actorType": "agent"}))
        self.assertIsNone(ActorAssertion.from_wire("not-an-object"))

    def test_a_wire_round_trip_preserves_every_field(self) -> None:
        original = ActorAssertion("agent", "agent-7", agent_id="a7", run_id="r7", roles=("qa",))
        self.assertEqual(ActorAssertion.from_wire(original.to_wire()), original)


class AuthenticatorConstructionTests(unittest.TestCase):
    """Construction refuses what cannot be repaired later from inside a request."""

    def test_an_empty_secret_is_refused(self) -> None:
        with self.assertRaises(Exception):
            RequestAuthenticator(issuer=ISSUER, secret="")

    def test_an_empty_issuer_is_refused(self) -> None:
        with self.assertRaises(Exception):
            RequestAuthenticator(issuer="", secret=SECRET)

    def test_no_allowed_audience_is_refused(self) -> None:
        with self.assertRaises(Exception):
            RequestAuthenticator(issuer=ISSUER, secret=SECRET, allowed_audience=())

    def test_a_list_of_issuers_is_refused(self) -> None:
        with self.assertRaises(Exception) as caught:
            RequestAuthenticator(issuer="bridge-a,bridge-b", secret=SECRET)
        self.assertIn("exactly one bridge issuer", str(caught.exception))

    def test_a_zero_window_is_refused(self) -> None:
        with self.assertRaises(Exception):
            RequestAuthenticator(issuer=ISSUER, secret=SECRET, replay_window_seconds=0)

    def test_a_config_with_no_secret_never_starts(self) -> None:
        with self.assertRaises(ConfigurationError) as caught:
            ServiceConfig(bridge_issuer=ISSUER, bridge_secret="").validate()
        self.assertIn("POLYFORGE_BRIDGE_SECRET", str(caught.exception))

    def test_a_config_with_no_issuer_never_starts(self) -> None:
        with self.assertRaises(ConfigurationError) as caught:
            ServiceConfig(bridge_issuer="", bridge_secret=SECRET).validate()
        self.assertIn("POLYFORGE_BRIDGE_ISSUER", str(caught.exception))

    def test_the_secret_never_appears_in_a_repr_or_a_public_dict(self) -> None:
        config = ServiceConfig(bridge_issuer=ISSUER, bridge_secret=SECRET)
        self.assertNotIn(SECRET, repr(config))
        self.assertNotIn(SECRET, str(config))
        self.assertNotIn(SECRET, json.dumps(config.to_public_dict()))


class AuthContextTests(unittest.TestCase):
    def test_the_context_exposes_the_scope_and_the_subject(self) -> None:
        context = AuthContext(
            issuer=ISSUER,
            actor=ActorAssertion("human", "user-anna", roles=("polyforge.author",)),
            scope=dict(SCOPE_A),
            nonce="n" * 16,
            timestamp="2026-01-01T00:00:00.000Z",
        )
        self.assertEqual(context.company_ref, "company-a")
        self.assertEqual(context.project_ref, "project-a")
        self.assertEqual(context.subject_ref, "user-anna")
        self.assertTrue(context.is_human)
        self.assertFalse(context.replayed)
        self.assertEqual(context.to_wire()["scope"], SCOPE_A)


class AuthFailureTests(unittest.TestCase):
    def test_a_failure_is_a_core_error_with_a_machine_reason(self) -> None:
        failure = AuthFailure("nonce_replay", "refused", intentId="x")
        self.assertEqual(failure.code, ErrorCode.AUTHORIZATION_DENIED)
        self.assertEqual(failure.status, ERROR_STATUS[ErrorCode.AUTHORIZATION_DENIED])
        self.assertEqual(failure.details["reason"], "nonce_replay")
        self.assertEqual(failure.to_body()["error"]["code"], "AUTHORIZATION_DENIED")


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
