"""HTTP-layer test fixtures.

Responsibility: give every test in this package a running service, a signing client, and a
scope, so each test states only the property it is asserting.

Two clocks, deliberately:

* the **engine** runs on an injected :class:`~polyforge.core.ids.FrozenClock`, so run state,
  lease expiry, and recovery are deterministic and no test reads a wall clock;
* the **authenticator** reads real time, because replay arithmetic is a security property and a
  frozen clock would make a stale-timestamp test untestable.

That split is also the truth: hop two measures elapsed real time, hop three reasons about
durable timestamps.
"""

from __future__ import annotations

import atexit
import json
import threading
import unittest
import urllib.error
import urllib.request
from typing import Any, Mapping, Sequence

from polyforge.core import ids
from polyforge.core.contracts.policy import PolicyRule
from polyforge.core.registry.store import RegistryStore
from polyforge.core.runtime.engine import RuntimeEngine
from polyforge.core.store.db import Database
from polyforge.services.runtime_api import RuntimeService, ServiceConfig
from polyforge.services.runtime_api.auth import sign_headers
from polyforge.services.runtime_api.router import Request, signed_path
from polyforge.services.runtime_api.server import create_server

__all__ = [
    "AUDIENCE",
    "COMPANY_A",
    "COMPANY_B",
    "ISSUER",
    "PROJECT_A",
    "PROJECT_B",
    "SCOPE_A",
    "SCOPE_B",
    "SECRET",
    "RuntimeApiCase",
    "SignedClient",
    "allow_rule",
    "grant",
    "human_actor",
    "agent_actor",
    "system_actor",
]

ISSUER = "bridge-test-1"
SECRET = "test-shared-secret-0123456789abcdef"
AUDIENCE = "polyforge-runtime"

COMPANY_A = "company-a"
COMPANY_B = "company-b"
PROJECT_A = "project-a"
PROJECT_B = "project-b"
SCOPE_A = {"companyRef": COMPANY_A, "projectRef": PROJECT_A}
SCOPE_B = {"companyRef": COMPANY_B, "projectRef": PROJECT_B}

#: Identities the fixtures use. The human/publisher pair is what makes a publish reachable:
#: a draft cannot be reviewed by its own author, so two distinct humans are required.
AUTHOR = "user-anna"
REVIEWER = "user-bob"
OPERATOR = "system-operator"


def agent_actor(actor_id: str = "agent-1", **extra: Any) -> dict[str, Any]:
    body = {"actorType": "agent", "actorId": actor_id, "agentId": actor_id, "roles": []}
    body.update(extra)
    return body


def human_actor(actor_id: str = AUTHOR, roles: Sequence[str] = ("polyforge.author",)) -> dict[str, Any]:
    return {"actorType": "human", "actorId": actor_id, "roles": list(roles)}


def system_actor(actor_id: str = OPERATOR, roles: Sequence[str] = ("polyforge.operator",)) -> dict[str, Any]:
    return {"actorType": "system", "actorId": actor_id, "roles": list(roles)}


def allow_rule(project_ref: str = PROJECT_A, *, rule_id: str = "allow-test") -> dict[str, Any]:
    """A governed allow rule. Naming a policy grants nothing, so a run must carry one."""
    return PolicyRule(
        rule_id=rule_id,
        effect="allow",
        project_ref=project_ref,
        version="1",
        reason="the test project is authorised for this graph",
    ).to_wire()


def grant(
    database: Database,
    subject: str,
    capability: str,
    *,
    scope: Mapping[str, str] = SCOPE_A,
    revoked: bool = False,
) -> str:
    """Insert a capability binding. These rows are the grants the Core authorises against."""
    binding_id = ids.new_id("binding")
    now = ids.now_iso()
    database.execute(
        "INSERT INTO capability_bindings (binding_id, company_ref, project_ref, subject_ref,"
        " provider_ref_json, capability_ref, capability_contract_version, entrypoints_json,"
        " resource_ceiling_json, review_provenance_json, revoked, created_at, updated_at)"
        " VALUES (?,?,?,?,?,?,?,'[]',NULL,NULL,?,?,?)",
        (
            binding_id,
            scope["companyRef"],
            scope["projectRef"],
            subject,
            json.dumps({"provider": "paperclip", "kind": "agent", "id": subject}),
            capability,
            "1",
            1 if revoked else 0,
            now,
            now,
        ),
    )
    return binding_id


class SignedClient:
    """Signs and sends one request the way the bridge does.

    The signing path is :func:`polyforge.services.runtime_api.auth.sign_headers` — the same
    function the verifier's canonical encoder is written against — so a test cannot pass by
    agreeing with a buggy implementation of its own bug.
    """

    def __init__(
        self,
        service: RuntimeService,
        *,
        issuer: str = ISSUER,
        secret: str = SECRET,
        audience: str = AUDIENCE,
    ) -> None:
        self.service = service
        self.issuer = issuer
        self.secret = secret
        self.audience = audience
        self._counter = 0

    def _nonce(self) -> str:
        self._counter += 1
        return ids.new_id("nonce").replace("non_", "") + f"{self._counter:04d}"

    def headers(
        self,
        method: str,
        target: str,
        body: bytes,
        *,
        actor: Mapping[str, Any] | None = None,
        scope: Mapping[str, str] | None = None,
        audience: str | None = None,
        timestamp: str | None = None,
        nonce: str | None = None,
    ) -> dict[str, str]:
        signed = sign_headers(
            secret=self.secret,
            method=method,
            # The bridge signs the base-relative target, query included, exactly as the
            # verifier reconstructs it.
            path=signed_path(target),
            body=body,
            issuer=self.issuer,
            actor=dict(actor or agent_actor()),
            # An explicit empty scope means "instance-scoped caller": it must be distinguishable
            # from "the caller did not care", which is why this is a None check and not a
            # truthiness check.
            scope=dict(scope) if scope is not None else dict(SCOPE_A),
            timestamp=timestamp or ids.now_iso(),
            nonce=nonce or self._nonce(),
            audience=self.audience if audience is None else audience,
        )
        return dict(signed.headers)

    def call(
        self,
        method: str,
        path: str,
        body: Any = None,
        *,
        actor: Mapping[str, Any] | None = None,
        scope: Mapping[str, str] | None = None,
        headers: Mapping[str, str] | None = None,
        audience: str | None = None,
        timestamp: str | None = None,
        nonce: str | None = None,
        sign: bool = True,
        raw_body: bytes | None = None,
    ) -> tuple[int, dict[str, Any], dict[str, str]]:
        """Dispatch through the service in-process. Returns ``(status, body, headers)``."""
        payload = raw_body
        if payload is None:
            payload = b"" if body is None else json.dumps(body).encode("utf-8")
        request_headers: dict[str, str] = {"content-type": "application/json"}
        if sign:
            request_headers.update(
                self.headers(
                    method,
                    path,
                    payload,
                    actor=actor,
                    scope=scope,
                    audience=audience,
                    timestamp=timestamp,
                    nonce=nonce,
                )
            )
        if headers:
            request_headers.update(headers)
        request = Request.build(
            method, path, request_headers, payload, peer="test", correlation_id=""
        )
        response = self.service.dispatch(request)
        parsed: dict[str, Any] = {}
        if response.body:
            try:
                parsed = json.loads(response.body.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):  # pragma: no cover
                parsed = {"raw": response.body.decode("utf-8", "replace")}
        return response.status, parsed, response.header_map()

    def error_code(self, status: int, body: Mapping[str, Any]) -> str:
        return str((body.get("error") or {}).get("code", ""))


class RuntimeApiCase(unittest.TestCase):
    """A migrated in-memory Core, a service bound to it, and a signing client.

    The background loops are *not* started by default: a test that asserts a loop's effect
    starts it explicitly, and a test that does not care should not have a thread racing it.
    """

    config_overrides: Mapping[str, Any] = {}
    database_path = ":memory:"

    def setUp(self) -> None:
        self.clock = ids.FrozenClock("2026-01-01T00:00:00.000Z")
        self.db = Database(self.database_path, clock=self.clock)
        self.db.migrate()
        atexit.register(self.db.close)
        self.registry = RegistryStore(self.db, clock=self.clock)
        self.engine = RuntimeEngine(
            self.db,
            clock=self.clock,
            registry=self.registry,
            bridge_issuer=ISSUER,
            bridge_expected_issuer=ISSUER,
        )
        self.config = ServiceConfig(
            db=self.database_path,
            bind="127.0.0.1",
            port=0,
            bridge_issuer=ISSUER,
            bridge_secret=SECRET,
            replay_window_seconds=120,
            allowed_audience=(AUDIENCE,),
            **dict(self.config_overrides),
        )
        self.service = RuntimeService(
            self.config,
            engine=self.engine,
            registry=self.registry,
            database=self.db,
            clock=self.clock,
        )
        self.client = SignedClient(self.service)
        self.addCleanup(self.service.stop)

    # -- assertions -----------------------------------------------------

    def assertError(self, status: int, body: Mapping[str, Any], code: str) -> Mapping[str, Any]:
        self.assertIn("error", body, msg=f"expected an error body, got {body}")
        self.assertEqual(
            (body.get("error") or {}).get("code"), code, msg=f"status={status} body={body}"
        )
        self.assertEqual(status, _expected_status(code), msg=f"body={body}")
        return body["error"]

    # -- server harness -------------------------------------------------

    def start_server(self) -> str:
        """Start a real server on an ephemeral port. Returns its base URL."""

        server = create_server(
            self.config,
            service=self.service,
            bind="127.0.0.1",
            port=0,
            start_background=False,
        )
        thread = threading.Thread(
            target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True
        )
        thread.start()
        stopped = False

        def _stop() -> None:
            nonlocal stopped
            if stopped:
                return
            stopped = True
            # ``shutdown`` first: ``server_close`` alone closes the listening socket, which
            # leaves ``serve_forever`` spinning on a dead selector until the join times out.
            server.shutdown()
            thread.join(5.0)
            server.server_close()

        if not hasattr(self, "_server_stoppers"):
            self._server_stoppers: list[Any] = []
        self._server_stoppers.append(_stop)
        self.addCleanup(_stop)
        return f"http://127.0.0.1:{server.server_address[1]}"


def _expected_status(code: str) -> int:
    from polyforge.core.errors import ERROR_STATUS, ErrorCode

    return ERROR_STATUS[ErrorCode(code)]


def http_call(
    base_url: str,
    method: str,
    path: str,
    body: Any,
    headers: Mapping[str, str],
    timeout: float = 10.0,
) -> tuple[int, dict[str, Any], dict[str, str]]:
    """One request over a real socket, with the failure body parsed out of the error response."""
    data = b"" if body is None else json.dumps(body).encode("utf-8")
    request = urllib.request.Request(base_url + path, data=data, method=method)
    for name, value in headers.items():
        request.add_header(name, value)
    request.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310 - loopback
            raw = response.read()
            parsed = json.loads(raw.decode("utf-8")) if raw else {}
            return response.status, parsed, dict(response.headers)
    except urllib.error.HTTPError as exc:
        # Closed explicitly: a refused request still holds a socket, and a suite of these leaks
        # one descriptor per test until the garbage collector notices.
        with exc:
            raw = exc.read()
            parsed = json.loads(raw.decode("utf-8")) if raw else {}
            return exc.code, parsed, dict(exc.headers)
