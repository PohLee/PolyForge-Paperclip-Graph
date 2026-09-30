"""The `/v1` service: request pipeline, endpoint handlers, and background loops.

Responsibility: everything between a verified request and a Core method call, plus the two
loops a process needs to stay honest (crash reconciliation and outbox lease reaping).

Invariants (``docs/05-PROTOCOL.md`` sections 1, 5, 8, 9, 12):

* **Authenticate, then inject, then call, then map.** The pipeline is fixed and in that order.
  ``scope`` is injected from the verified assertion *after* the body has been checked for a
  conflicting one, so no handler can be handed a caller-supplied company. Every handler
  receives a payload that already carries the transport context; none of them read a body
  field for identity.
* **A body that names an identity is refused, not sanitised.** Dropping the field would let a
  caller believe it had asserted something. ``422 CONTRACT_INVALID`` says no.
* **The Core is the only writer of engineering state.** The only statements this module issues
  itself are the schema migration and the outbox lease claim/reap, which are queue bookkeeping
  rather than engineering state; every state change goes through one engine method in one
  Core transaction.
* **Every response is logged with its identifiers and none of its content.**
  ``runId``/``nodeId``/``transition``/``attempt``/``issueRef``/``correlationId`` are enough to
  find the row; the body is a prompt, a diff, or an artifact manifest and is none of the
  operator's business at this level.
* **Health is honest.** ``blocked`` when the database is unusable, the bridge issuer does not
  match, or no graph registry is wired; ``read_only`` when the store answers but admissions are
  switched off, ``degraded`` when there is undelivered work or an unknown effect, ``ready``
  otherwise. It never reports ``ready`` for a process that cannot actually execute work.
* **Background loops are idempotent and stoppable.** ``recover()`` may be run any number of
  times; the outbox reap only moves an *expired* claim back to ``QUEUED``. Both take a stop
  event and join on shutdown, so a graceful stop does not leave a thread writing.
"""

from __future__ import annotations

import logging
import re
import threading
import time
import uuid
from collections.abc import Mapping as AbcMapping
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any, Callable, Final, Mapping, Sequence

from polyforge import COMPILER_VERSION, PROTOCOL_VERSION, SCHEMA_VERSION
from polyforge.core import errors, ids
from polyforge.core.compiler.compile import CompileArtifact, compile_definition
from polyforge.core.compiler.validate import validate_definition
from polyforge.core.errors import ErrorCode, PolyForgeError
from polyforge.core.registry.store import RegistryStore
from polyforge.core.runtime.engine import RuntimeEngine
from polyforge.core.store.db import Database
from polyforge.core.store.models import Scope
from polyforge.services.runtime_api import errors as apierrors
from polyforge.services.runtime_api.auth import AuthContext, RequestAuthenticator
from polyforge.services.runtime_api.config import ServiceConfig
from polyforge.services.runtime_api.router import Endpoint, Request, Response, ROUTER

__all__ = [
    "FORBIDDEN_BODY_FIELDS",
    "ROLE_CAPABILITIES",
    "HandlerContext",
    "HandlerResult",
    "RuntimeService",
    "build_service",
]

logger = logging.getLogger("polyforge.runtime_api")

#: Identity and approval fields a request body may never carry. A worker that can name itself a
#: human has no reason to stop there, so these are refused outright rather than ignored (AT-13:
#: a forged ``actorUserId``, ``approved`` or ``record_approval`` all fail).
FORBIDDEN_BODY_FIELDS: Final[frozenset[str]] = frozenset(
    {
        "actor",
        "actorId",
        "actorType",
        "actorUserId",
        "actorRef",
        "assertActor",
        "approved",
        "recordApproval",
        "record_approval",
        "impersonate",
    }
)

#: Body keys that may *name* a company or project. A value equal to the asserted scope is
#: tolerated so a bridge that echoes the scope back is not broken; a different one is a
#: violation. Identity fields get no such tolerance, which is why they are a separate set.
_SCOPE_BODY_FIELDS: Final[tuple[str, ...]] = ("companyRef", "projectRef", "company", "project")

#: Handlers whose Core method reads ``actor``. Kept beside :meth:`RuntimeService._payload` so
#: the two cannot drift: omitting a name silently strips an identity a Core method needs.
_ACTOR_READING_ENDPOINTS: Final[frozenset[str]] = frozenset(
    {"run_command", "current_contract"}
)

#: Platform roles mapped onto Core capabilities. The platform asserted these roles at hop one;
#: the Core re-checks them here because button visibility is not authorization. Revocable
#: capability contracts are read from the store and unioned in, so a revoked grant is
#: reflected even when a role still implies the capability.
ROLE_CAPABILITIES: Final[dict[str, frozenset[str]]] = {
    "polyforge.operator": frozenset({"run.control", "run.execute", "run.resolve_block"}),
    "polyforge.maintainer": frozenset({"run.control", "run.execute"}),
    "polyforge.viewer": frozenset(),
}

_CORRELATION_RE = re.compile(r"\A[A-Za-z0-9._:@/|-]{1,128}\Z")
_IDENTIFIER_FIELDS: Final[tuple[str, ...]] = ("runId", "nodeId", "attemptId", "issueRef")


def _now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _later(seconds: float) -> str:
    return (
        (datetime.now(UTC) + timedelta(seconds=float(seconds)))
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def _correlation_id(headers: Mapping[str, str]) -> str:
    """Honour a caller-supplied correlation id, or mint one.

    Validated rather than trusted: the value lands in every log line for this request, so an
    unvalidated header would be a log-injection vector. Anything that does not match is
    replaced rather than rejected, because a malformed id must not be able to fail a request.
    """
    supplied = headers.get("x-pf-correlation-id") or headers.get("x-correlation-id")
    if supplied and _CORRELATION_RE.match(supplied.strip()):
        return supplied.strip()
    return f"cor_{uuid.uuid4().hex[:20]}"


def _body_identity_findings(value: Any, path: str = "$") -> list[str]:
    """Every ``$``-path at which a forbidden identity field appears.

    Recursive on purpose: a forged ``actor`` nested inside a command ``payload`` is the same
    forgery as one at the top level, and a shallow scan would be a hole in the one control
    that makes "the Core never reads an actor id from a body" true.
    """
    findings: list[str] = []
    if isinstance(value, AbcMapping):
        for key, item in value.items():
            here = f"{path}.{key}"
            if isinstance(key, str) and key in FORBIDDEN_BODY_FIELDS:
                findings.append(here)
            findings.extend(_body_identity_findings(item, here))
    elif isinstance(value, (list, tuple)):
        for index, item in enumerate(value):
            findings.extend(_body_identity_findings(item, f"{path}[{index}]"))
    return findings


def _body_scope_findings(body: Mapping[str, Any], scope: Mapping[str, str]) -> list[dict[str, Any]]:
    """Any company/project named in the body that disagrees with the asserted scope.

    An *empty* asserted scope means the route is instance-scoped, so the body is not contradicting
    anything: health and operator recovery legitimately operate on the whole deployment. The
    caller still names nothing the transport did not, because the transport named nothing at all.
    """
    findings: list[dict[str, Any]] = []
    if not scope:
        return findings
    for field_name in _SCOPE_BODY_FIELDS:
        if field_name not in body:
            continue
        key = "companyRef" if field_name in ("companyRef", "company") else "projectRef"
        if str(body[field_name]) != str(scope[key]):
            findings.append({"field": field_name, "expected": scope[key]})
    nested = body.get("scope")
    if isinstance(nested, AbcMapping):
        for key in ("companyRef", "projectRef"):
            if key in nested and str(nested[key]) != str(scope[key]):
                findings.append({"field": f"scope.{key}", "expected": scope[key]})
    return findings


def _identifiers(body: Mapping[str, Any] | None) -> dict[str, str]:
    """Pull the loggable identifiers out of a parsed body without logging the body.

    Only scalars and short strings are read, and each is truncated, so a body cannot smuggle a
    prompt or a secret into a log line through this path.
    """
    if not body:
        return {}
    found: dict[str, str] = {}
    for field_name in _IDENTIFIER_FIELDS:
        value = body.get(field_name)
        if isinstance(value, (str, int)) and str(value):
            found[field_name] = str(value)[:120]
    payload = body.get("payload")
    if isinstance(payload, AbcMapping):
        for field_name in _IDENTIFIER_FIELDS:
            if field_name not in found and isinstance(payload.get(field_name), (str, int)):
                found[field_name] = str(payload[field_name])[:120]
    transition = body.get("transition") or body.get("transitionHash")
    if transition is None and isinstance(payload, AbcMapping):
        transition = payload.get("transition") or payload.get("transitionHash")
    if isinstance(transition, (str, int)) and str(transition):
        found["transition"] = str(transition)[:120]
    return found


@dataclass(slots=True)
class HandlerContext:
    """What a handler is given: the request, the verified identity, the path params, the body.

    ``payload`` is a *copy* of the body with ``scope`` and, where the handler needs it,
    ``actor`` already injected. The caller's parsed body is never mutated, so a body that names
    its own scope stays observable in the log without ever being trusted.
    """

    request: Request
    auth: AuthContext | None
    params: Mapping[str, str]
    body: Mapping[str, Any]
    payload: dict[str, Any]
    service: "RuntimeService" = field(repr=False)

    @property
    def scope(self) -> dict[str, str]:
        assert self.auth is not None  # every authenticated route has one
        return dict(self.auth.scope)

    @property
    def actor(self) -> AuthContext:
        assert self.auth is not None
        return self.auth

    @property
    def subject(self) -> str:
        """The asserted subject. The only actor identity any handler may use."""
        return self.actor.subject_ref

    @property
    def correlation_id(self) -> str:
        return self.request.correlation_id

    def actor_view(self) -> dict[str, Any]:
        """The actor as the Core's handlers expect it, with granted capabilities attached.

        ``capabilities`` is not read from the wire. It is the union of the Core's own revocable
        grants for this subject and scope and the capabilities the platform's roles imply, so a
        bridge cannot widen its own authority by asserting a capability in a header.
        """
        return {
            "subjectRef": self.subject,
            "subject": self.subject,
            "actorType": self.actor.actor.actor_type,
            "actorId": self.subject,
            "roles": list(self.actor.actor.roles),
            # The Core reads the scope out of the actor envelope, so it travels with the actor
            # rather than beside it. It is the same injected scope, never a body field.
            "scope": dict(self.scope),
            "capabilities": sorted(
                self.service.capabilities_for(self.subject, self.actor.actor.roles, self.scope)
            ),
        }

    def engine_payload(self) -> dict[str, Any]:
        """The mapping to hand the Core.

        Note what is *not* added: a synthesised ``correlationId``. Several Core commands hash
        their whole request into an idempotency record - ``record_governance_resolution`` is the
        one that bites - so a per-attempt value injected here would make an honest retry of the
        same command hash differently and come back ``409 IDEMPOTENCY_CONFLICT``. Correlation
        belongs to this process's logs; a caller that wants it correlated inside the Core sends
        its own, and the Core treats it as optional everywhere.
        """
        return dict(self.payload)


#: A handler returns a Response; the transport owns the bytes and the correlation header.
HandlerResult = Response


class RuntimeService:
    """One Runtime process: a router, an authenticator, a Core, and two loops.

    The Core, registry, and database are built **lazily** on first use rather than in
    ``__init__``. A process that cannot open its database must still be able to answer
    ``/health`` with ``blocked`` and a reason, and it must still bind its port so an operator
    can see that; refusing to start would leave a supervisor guessing.

    The registry is not optional here. It is the only authority for published versions and the
    active-default pointer, and both the authoring routes and the Core read it — so an engine
    handed in without one is given this service's store, and an instance that still ends up
    without a registry reports ``blocked`` rather than behaving as though no versions exist.
    """

    def __init__(
        self,
        config: ServiceConfig,
        *,
        engine: RuntimeEngine | None = None,
        registry: RegistryStore | None = None,
        database: Database | None = None,
        authenticator: RequestAuthenticator | None = None,
        clock: Any | None = None,
    ) -> None:
        self.config = config
        self._engine = engine
        self._registry = registry
        self._database = database
        self._clock = clock
        self._build_error: BaseException | None = None
        self._build_lock = threading.Lock()
        self.authenticator = authenticator or RequestAuthenticator(
            issuer=config.bridge_issuer,
            secret=config.bridge_secret,
            replay_window_seconds=config.replay_window_seconds,
            allowed_audience=config.allowed_audience,
        )
        self.router = ROUTER
        self.started_at = _now_iso()
        self._started_monotonic = time.monotonic()
        self._stop = threading.Event()
        self._threads: list[threading.Thread] = []
        self._reconciler: "_ReconcilerLoop | None" = None
        self._outbox: "_OutboxReaperLoop | None" = None
        self._grants: tuple[float, dict[str, list[str]]] | None = None
        self._grants_lock = threading.Lock()
        logger.info(
            "runtime_api.configured",
            extra={"pf.event": "runtime_api.configured", "pf.config": config.to_public_dict()},
        )

    # ------------------------------------------------------------------
    # lazily built Core
    # ------------------------------------------------------------------

    @property
    def database(self) -> Database:
        self._ensure_core()
        assert self._database is not None
        return self._database

    @property
    def engine(self) -> RuntimeEngine:
        self._ensure_core()
        assert self._engine is not None
        return self._engine

    @property
    def registry(self) -> RegistryStore:
        self._ensure_core()
        assert self._registry is not None
        return self._registry

    def _ensure_core(self) -> None:
        if self._build_error is not None:
            raise self._build_error
        if self._engine is not None and self._registry is not None and self._database is not None:
            return
        with self._build_lock:
            if self._build_error is not None:
                raise self._build_error
            if self._engine is not None and self._registry is not None and self._database is not None:
                return
            try:
                database = self._database or Database(
                    self.config.db, clock=self._clock, busy_timeout_ms=10_000
                )
                database.migrate()
                registry = self._registry or RegistryStore(database, clock=self._clock)
                engine = self._engine or RuntimeEngine(
                    database,
                    clock=self._clock,
                    registry=registry,
                    # The bridge issuer this process was configured to trust. Health compares
                    # this with the same value, so a misconfigured deployment says ``blocked``
                    # instead of quietly refusing every request with no explanation.
                    bridge_issuer=self.config.bridge_issuer,
                    bridge_expected_issuer=self.config.bridge_issuer,
                    lease_ttl_seconds=self.config.outbox_lease_seconds,
                )
                if getattr(engine, "registry", None) is None:
                    # An injected engine that was built without a registry would otherwise keep
                    # resolving versions with no authority behind it. Handing it the one store
                    # over this service's own database is the wiring, and it happens once, here.
                    engine.registry = registry
            except BaseException as exc:  # noqa: BLE001 - health must describe, not raise
                self._build_error = exc
                logger.error(
                    "runtime_api.core_unavailable",
                    extra={
                        "pf.event": "runtime_api.core_unavailable",
                        "pf.exceptionType": type(exc).__name__,
                    },
                    exc_info=exc,
                )
                raise
            self._database = database
            self._registry = registry
            self._engine = engine

    # ------------------------------------------------------------------
    # background loops
    # ------------------------------------------------------------------

    def start(self) -> None:
        """Start the reconciler and the outbox reaper. Idempotent."""
        if self._stop.is_set():
            return
        if self._reconciler is None:
            self._reconciler = _ReconcilerLoop(self, interval=self.config.reconciler_interval_seconds)
            self._reconciler.start()
            self._threads.append(self._reconciler)
        if self._outbox is None:
            self._outbox = _OutboxReaperLoop(self, interval=self.config.outbox_interval_seconds)
            self._outbox.start()
            self._threads.append(self._outbox)

    def stop(self, *, timeout: float = 5.0) -> None:
        """Signal both loops and wait for them. Safe to call twice."""
        self._stop.set()
        for loop in (self._reconciler, self._outbox):
            if loop is not None:
                loop.request_stop()
        for thread in self._threads:
            if thread.is_alive() and thread is not threading.current_thread():
                thread.join(timeout=timeout)
        self._threads.clear()
        self._reconciler = None
        self._outbox = None
        if self._database is not None:
            try:
                self._database.close()
            except Exception:  # noqa: BLE001 - shutdown must not raise over a closed handle
                logger.debug("runtime_api.database_close_failed", exc_info=True)
        logger.info("runtime_api.stopped", extra={"pf.event": "runtime_api.stopped"})

    @property
    def stopping(self) -> bool:
        return self._stop.is_set()

    def reconciler_status(self) -> dict[str, Any]:
        if self._reconciler is None:
            return {"running": False, "intervalSeconds": self.config.reconciler_interval_seconds}
        return {
            "running": self._reconciler.alive,
            "intervalSeconds": self._reconciler.interval,
            "runs": self._reconciler.runs,
            "lastRunAt": self._reconciler.last_run_at,
            "lastError": self._reconciler.last_error,
        }

    def outbox_status(self) -> dict[str, Any]:
        base: dict[str, Any] = {
            "mode": "poll",
            "leaseSeconds": self.config.outbox_lease_seconds,
        }
        if self._outbox is None:
            base.update({"running": False, "intervalSeconds": self.config.outbox_interval_seconds})
            return base
        base.update(
            {
                "running": self._outbox.alive,
                "intervalSeconds": self._outbox.interval,
                "lastRunAt": self._outbox.last_run_at,
                "lastError": self._outbox.last_error,
                "lapsedClaims": self._outbox.lapsed,
            }
        )
        return base

    # ------------------------------------------------------------------
    # capabilities
    # ------------------------------------------------------------------

    def capabilities_for(
        self, subject: str, roles: Sequence[str], scope: Mapping[str, str]
    ) -> frozenset[str]:
        """Capabilities the Core will hold this subject to. Never read from the request.

        Two sources, unioned: the store's revocable ``capability_bindings`` rows for this
        subject and scope, and the capabilities the platform's roles imply. A read that fails
        contributes nothing, because an unreadable store must never widen authority.
        """
        found: set[str] = set()
        for role in roles:
            found |= ROLE_CAPABILITIES.get(str(role), frozenset())
        try:
            found |= set(self._granted_capabilities(subject, scope))
        except Exception:  # noqa: BLE001 - see above
            logger.warning(
                "capability_lookup_failed",
                extra={"pf.event": "capability_lookup_failed", "pf.subjectRef": subject},
                exc_info=True,
            )
        return frozenset(found)

    def _granted_capabilities(self, subject: str, scope: Mapping[str, str]) -> list[str]:
        """Revocable grants for one subject, cached for a second.

        Cached because a per-request query on every write would put the database on the hot
        path of a fanned-out bridge, and one second is short enough that a revocation takes
        effect promptly while still collapsing a burst.
        """
        key = f"{scope['companyRef']}\x1f{scope['projectRef']}\x1f{subject}"
        now = time.monotonic()
        with self._grants_lock:
            if self._grants is not None and now - self._grants[0] < 1.0 and key in self._grants[1]:
                return list(self._grants[1][key])
        rows = self.database.query(
            "SELECT capability_ref FROM capability_bindings WHERE company_ref = ?"
            " AND project_ref = ? AND subject_ref = ? AND revoked = 0",
            (scope["companyRef"], scope["projectRef"], subject),
        )
        values = sorted({str(row["capability_ref"]) for row in rows})
        with self._grants_lock:
            if self._grants is None or now - self._grants[0] >= 1.0:
                self._grants = (now, {})
            self._grants[1][key] = values
        return list(values)

    # ------------------------------------------------------------------
    # outbox: the pull side
    # ------------------------------------------------------------------

    def claim_outbox(self, scope: Mapping[str, str], limit: int) -> list[dict[str, Any]]:
        """Claim queued outbound intents **for one scope**, as a lease.

        This mirrors :meth:`polyforge.core.runtime.engine.RuntimeEngine.drain_outbox` with a
        tenant filter added. The Core's own drain is process-global because the Core has one
        bridge; this surface has one caller per company/project, so a global claim would let one
        company's poll hold another company's intent and inflate its delivery-attempt count. The
        claim, the lease length and the expiry predicate are identical, so the crash-safety
        property does not depend on which path claimed an intent.
        """
        database = self.database
        now = _now_iso()
        expires = _later(self.config.outbox_lease_seconds)
        owner = ids.process_tag()
        candidates = database.query(
            "SELECT intent_id FROM outbox_intents WHERE company_ref = ? AND project_ref = ?"
            " AND state IN ('QUEUED','CLAIMED')"
            " AND (next_attempt_at IS NULL OR next_attempt_at <= ?)"
            " AND (claim_expires_at IS NULL OR claim_expires_at <= ?)"
            " ORDER BY created_at, intent_id LIMIT ?",
            (scope["companyRef"], scope["projectRef"], now, now, max(1, int(limit))),
        )
        claimed: list[dict[str, Any]] = []
        for candidate in candidates:
            intent_id = str(candidate["intent_id"])
            with database.transaction():
                updated = database.execute(
                    "UPDATE outbox_intents SET state = 'CLAIMED', claim_owner = ?,"
                    " claim_expires_at = ?, delivery_attempts = delivery_attempts + 1,"
                    " updated_at = ? WHERE company_ref = ? AND project_ref = ? AND intent_id = ?"
                    " AND state IN ('QUEUED','CLAIMED')"
                    " AND (claim_expires_at IS NULL OR claim_expires_at <= ?)",
                    (owner, expires, now, scope["companyRef"], scope["projectRef"], intent_id, now),
                )
                if updated != 1:
                    continue
                row = database.query_one(
                    "SELECT * FROM outbox_intents WHERE company_ref = ? AND project_ref = ?"
                    " AND intent_id = ?",
                    (scope["companyRef"], scope["projectRef"], intent_id),
                )
            if row is None:  # pragma: no cover - the CAS just matched this row
                continue
            from polyforge.core.store.db import loads

            claimed.append(
                {
                    "intentId": intent_id,
                    "kind": str(row["kind"]),
                    "runId": row["run_id"],
                    "nodeId": row["node_id"],
                    "scope": {
                        "companyRef": str(row["company_ref"]),
                        "projectRef": str(row["project_ref"]),
                    },
                    "correlationKey": str(row["correlation_key"]),
                    "payload": loads(row["payload_json"], {}),
                    "deliveryAttempt": int(row["delivery_attempts"]),
                    "maxDeliveryAttempts": int(row["max_delivery_attempts"]),
                    "claimExpiresAt": row["claim_expires_at"],
                }
            )
        if claimed:
            logger.info(
                "outbox.claimed",
                extra={
                    "pf.event": "outbox.claimed",
                    "pf.intents": len(claimed),
                    "pf.companyRef": scope["companyRef"],
                    "pf.projectRef": scope["projectRef"],
                },
            )
        return claimed

    def reap_outbox_claims(self) -> int:
        """Return every *expired* outbox claim to ``QUEUED``.

        This is the crash-safety property of the pull-based outbox. An intent claimed and never
        acknowledged would otherwise sit in ``CLAIMED`` until something polled it again; the
        reaper makes the return automatic, so a bridge that dies mid-delivery loses at most one
        lease interval. It only ever moves a claim whose lease has expired, so it cannot steal
        a claim from a live delivery, and it is idempotent: a second run finds nothing expired.
        """
        database = self.database
        now = _now_iso()
        lapsed = database.execute(
            "UPDATE outbox_intents SET state = 'QUEUED', claim_owner = NULL,"
            " claim_expires_at = NULL, updated_at = ?"
            " WHERE state = 'CLAIMED' AND claim_expires_at IS NOT NULL AND claim_expires_at <= ?",
            (now, now),
        )
        if lapsed:
            logger.warning(
                "outbox.claims_lapsed",
                extra={
                    "pf.event": "outbox.claims_lapsed",
                    "pf.intents": lapsed,
                    "pf.leaseSeconds": self.config.outbox_lease_seconds,
                },
            )
        return lapsed

    def recover_once(self) -> dict[str, Any]:
        """One reconciliation pass. Idempotent by construction (``runtime.recovery`` owns it)."""
        return self.engine.recover()

    # ------------------------------------------------------------------
    # health
    # ------------------------------------------------------------------

    def health(self) -> dict[str, Any]:
        """``ready | read_only | degraded | blocked``, honestly.

        Priority is deliberate: an unusable database or a bridge issuer that does not match
        configuration is ``blocked`` and outranks everything, because nothing else is worth
        reporting once the process cannot trust its caller or cannot read its own state.
        """
        try:
            base = dict(self.engine.health())
        except Exception as exc:  # noqa: BLE001 - health describes, it does not raise
            return {
                "status": "blocked",
                "protocolVersion": PROTOCOL_VERSION,
                "schemaVersion": SCHEMA_VERSION,
                "compilerVersion": COMPILER_VERSION,
                "instanceRole": self.config.instance_role,
                "acceptingAdmissions": False,
                "database": {"ok": False, "detail": f"{type(exc).__name__}"},
                "store": {
                    "runs": 0,
                    "outboxPending": 0,
                    "unknownEffects": 0,
                    "registryWired": self._registry is not None,
                },
                "bridge": {
                    "issuer": self.config.bridge_issuer,
                    "expectedIssuer": self.config.bridge_issuer,
                    "compatible": True,
                },
                "checkedAt": _now_iso(),
                "uptimeSeconds": round(time.monotonic() - self._started_monotonic, 3),
                "issues": [f"the Core is unusable: {type(exc).__name__}"],
                "backgrounds": {
                    "reconciler": self.reconciler_status(),
                    "outbox": self.outbox_status(),
                },
            }

        issues = [str(i) for i in (base.get("issues") or ())]
        # The Core reports read_only when it has no ports, which is the normal shape of this
        # deployment: the bridge implements them out of process. That must not read as an
        # incident, so the issue is re-stated instead of inherited blindly.
        port_issue = next((i for i in issues if "bridge ports" in i), "")
        if port_issue:
            issues.remove(port_issue)
            issues.append(
                "bridge ports are implemented by the bridge process, not here: this service "
                "records intents and refuses to fake a platform answer"
            )
        database_ok = bool((base.get("database") or {}).get("ok"))
        bridge_ok = bool((base.get("bridge") or {}).get("compatible"))
        store = base.get("store") or {}
        # The registry is the only authority for published versions and the default pointer, so
        # a service without one cannot admit or migrate anything. It must not look like an
        # instance whose scope simply has no graphs yet.
        registry_ok = bool(store.get("registryWired"))
        if not registry_ok:
            issues.append(
                "no graph registry is wired to this service: published versions and the active "
                "default version cannot be resolved, so admission and migration are refused"
            )
        accepting = not self.config.read_only
        if not accepting:
            issues.append(
                "this instance is configured read-only: reads and reconciliation are served and "
                "admissions are refused"
            )
        # The Core's own ``read_only`` verdict is deliberately NOT inherited. It reports that
        # when it has no ports object, and in this deployment the bridge implements the ports
        # out of process, so a port-less Core is the normal case rather than a degraded one.
        # Treating it as read_only would put a correctly configured instance permanently out of
        # rotation.
        if not database_ok or not bridge_ok or not registry_ok:
            status = "blocked"
        elif not accepting:
            status = "read_only"
        elif int(store.get("unknownEffects", 0) or 0) or int(store.get("outboxPending", 0) or 0):
            status = "degraded"
        else:
            status = "ready"
        base["status"] = status
        base["issues"] = issues
        base["instanceRole"] = self.config.instance_role
        base["acceptingAdmissions"] = accepting
        base["uptimeSeconds"] = round(time.monotonic() - self._started_monotonic, 3)
        base["backgrounds"] = {
            "reconciler": self.reconciler_status(),
            "outbox": self.outbox_status(),
        }
        return base

    # ------------------------------------------------------------------
    # dispatch
    # ------------------------------------------------------------------

    def dispatch(self, request: Request) -> Response:
        """The whole pipeline for one request. Never raises."""
        correlation_id = _correlation_id(request.headers)
        request = _with_correlation_id(request, correlation_id)
        started = time.monotonic()
        endpoint: Endpoint | None = None
        auth: AuthContext | None = None
        body: dict[str, Any] = {}
        outcome = "ok"
        try:
            if self.stopping:
                raise PolyForgeError(
                    ErrorCode.CONTROL_PLANE_UNAVAILABLE,
                    "this instance is shutting down and is not accepting requests",
                    details={"instanceRole": self.config.instance_role},
                )
            try:
                endpoint, params = self.router.resolve(request.method, request.route_path)
            except PolyForgeError as exc:
                outcome = f"route:{exc.code.value}"
                return self._finish_error(request, None, None, exc, correlation_id, started, outcome)

            if endpoint.authenticated:
                try:
                    auth = self.authenticator.authenticate(
                        request.method,
                        request.signed_path,
                        request.raw_body,
                        request.headers,
                        correlation_id=correlation_id,
                        require_scope=not endpoint.instance_scope,
                        require_project=not endpoint.projectless_scope,
                    )
                except PolyForgeError as exc:
                    outcome = f"auth:{getattr(exc, 'reason', exc.code.value)}"
                    return self._finish_error(
                        request, endpoint, None, exc, correlation_id, started, outcome
                    )

            try:
                body = request.json_object()
            except PolyForgeError as exc:
                outcome = f"body:{exc.code.value}"
                return self._finish_error(
                    request, endpoint, auth, exc, correlation_id, started, outcome
                )

            if auth is not None:
                self._refuse_body_identity(body, correlation_id, request, endpoint)
                self._refuse_body_scope(body, auth, correlation_id, request, endpoint)
                self._check_authority(endpoint, auth)

            handler: Callable[[HandlerContext], HandlerResult] = getattr(
                self, f"_handle_{endpoint.name}"
            )
            context = HandlerContext(
                request=request,
                auth=auth,
                params=params,
                body=body,
                payload=self._payload(body, endpoint, auth),
                service=self,
            )
            response = handler(context)
            self._log(
                request, endpoint, auth, response.status, correlation_id, started, outcome, body
            )
            return Response(
                status=response.status,
                body=response.body,
                headers=((apierrors.CORRELATION_HEADER, correlation_id),) + tuple(response.headers),
                content_type=response.content_type,
            )
        except PolyForgeError as exc:
            return self._finish_error(
                request, endpoint, auth, exc, correlation_id, started, outcome or exc.code.value, body
            )
        except Exception as exc:  # noqa: BLE001 - the last line of defence
            logger.error(
                "request.unhandled_exception",
                extra={
                    "pf.event": "request.unhandled_exception",
                    "pf.correlationId": correlation_id,
                    "pf.method": request.method,
                    "pf.path": request.route_path,
                    "pf.route": endpoint.name if endpoint else "",
                    "pf.exceptionType": type(exc).__name__,
                },
                exc_info=(type(exc), exc, exc.__traceback__),
            )
            return apierrors.internal_error(correlation_id, exc=exc)

    # -- pipeline steps -------------------------------------------------

    def _payload(
        self, body: Mapping[str, Any], endpoint: Endpoint, auth: AuthContext | None
    ) -> dict[str, Any]:
        """The handler payload: the body plus the transport-injected context.

        ``scope`` is always injected and is never read from the body. ``actor`` is injected only
        for the handlers whose Core method reads it; the others hash their payload into an
        idempotency record, and adding a field there would change an identity hash for nothing.
        """
        payload = dict(body)
        if auth is not None:
            payload["scope"] = dict(auth.scope)
        if auth is not None and endpoint.name in _ACTOR_READING_ENDPOINTS:
            payload["actor"] = {
                "subjectRef": auth.subject_ref,
                "subject": auth.subject_ref,
                "actorType": auth.actor.actor_type,
                "actorId": auth.subject_ref,
                "roles": list(auth.actor.roles),
                "capabilities": [],
            }
        return payload

    def _refuse_body_identity(
        self,
        body: Mapping[str, Any],
        correlation_id: str,
        request: Request,
        endpoint: Endpoint,
    ) -> None:
        findings = _body_identity_findings(body)
        if not findings:
            return
        logger.warning(
            "security.body_identity_refused",
            extra={
                "pf.event": "security.body_identity_refused",
                "pf.correlationId": correlation_id,
                "pf.method": request.method,
                "pf.path": request.route_path,
                "pf.route": endpoint.name,
                "pf.fields": ",".join(findings),
            },
        )
        raise errors.contract_invalid(
            "a request body may not carry an actor identity or an approval: actor and scope come "
            "from the signed transport context, and a body that names them is refused rather "
            "than ignored",
            offendingFields=findings,
            route=endpoint.name,
        )

    def _refuse_body_scope(
        self,
        body: Mapping[str, Any],
        auth: AuthContext,
        correlation_id: str,
        request: Request,
        endpoint: Endpoint,
    ) -> None:
        findings = _body_scope_findings(body, auth.scope)
        if not findings:
            return
        logger.warning(
            "security.body_scope_refused",
            extra={
                "pf.event": "security.body_scope_refused",
                "pf.correlationId": correlation_id,
                "pf.method": request.method,
                "pf.path": request.route_path,
                "pf.route": endpoint.name,
                "pf.issuer": auth.issuer,
            },
        )
        raise errors.scope_violation(
            "the request body names a different company/project than the signed scope; the Core "
            "reads scope from the transport context and refuses a body that contradicts it",
            assertedScope=dict(auth.scope),
            offendingFields=findings,
            route=endpoint.name,
        )

    def _check_authority(self, endpoint: Endpoint, auth: AuthContext) -> None:
        """The authorisation step for routes that declare one.

        Authoring is not open to every authenticated caller, and run-control commands are
        re-checked by the Core against granted capabilities. Both checks read the signed roles
        and the store's grants; neither reads a body field.
        """
        if endpoint.name == "recover" and auth.actor.actor_type != "system":
            raise errors.authorization_denied(
                "crash reconciliation is a system operation; an agent or a human caller cannot "
                "invoke it",
                actorType=auth.actor.actor_type,
                requiredActorType="system",
            )
        if not (endpoint.required_roles or endpoint.required_capabilities):
            return
        if set(auth.actor.roles) & set(endpoint.required_roles):
            return
        capabilities = self.capabilities_for(auth.subject_ref, auth.actor.roles, auth.scope)
        if capabilities & endpoint.required_capabilities:
            return
        raise errors.authorization_denied(
            f"{endpoint.name} requires one of the platform roles {sorted(endpoint.required_roles)}"
            f" or the capability {sorted(endpoint.required_capabilities)}; the presented roles are"
            f" {sorted(auth.actor.roles)}",
            requiredRoles=sorted(endpoint.required_roles),
            requiredCapabilities=sorted(endpoint.required_capabilities),
            presentedRoles=sorted(auth.actor.roles),
            route=endpoint.name,
        )

    # -- logging --------------------------------------------------------

    def _finish_error(
        self,
        request: Request,
        endpoint: Endpoint | None,
        auth: AuthContext | None,
        exc: PolyForgeError,
        correlation_id: str,
        started: float,
        outcome: str,
        body: Mapping[str, Any] | None = None,
    ) -> Response:
        self._log(
            request,
            endpoint,
            auth,
            exc.status,
            correlation_id,
            started,
            outcome,
            body,
            apierrors.retry_hint(exc),
        )
        return apierrors.response_for(exc, correlation_id)

    def _log(
        self,
        request: Request,
        endpoint: Endpoint | None,
        auth: AuthContext | None,
        status: int,
        correlation_id: str,
        started: float,
        outcome: str,
        body: Mapping[str, Any] | None = None,
        retry: str = "",
    ) -> None:
        """One line per request: identifiers and the outcome, never the content.

        ``runId``/``nodeId``/``transition``/``attempt``/``issueRef`` are what an operator needs
        to find the row; the body is a prompt, a diff, or an artifact manifest and belongs
        nowhere near a log line.
        """
        fields = _identifiers(body)
        logger.info(
            "request.handled",
            extra={
                "pf.event": "request.handled",
                "pf.method": request.method,
                "pf.path": request.route_path,
                "pf.route": endpoint.name if endpoint else "",
                "pf.status": status,
                "pf.outcome": outcome,
                "pf.retry": retry,
                "pf.durationMs": int((time.monotonic() - started) * 1000),
                "pf.correlationId": correlation_id,
                "pf.issuer": auth.issuer if auth else "",
                "pf.actorId": auth.subject_ref if auth else "",
                "pf.actorType": auth.actor.actor_type if auth else "",
                "pf.companyRef": auth.company_ref if auth and auth.scope else "",
                "pf.projectRef": auth.project_ref if auth and auth.scope else "",
                "pf.runId": fields.get("runId", ""),
                "pf.nodeId": fields.get("nodeId", ""),
                "pf.transition": fields.get("transition", ""),
                "pf.attempt": fields.get("attemptId", ""),
                "pf.issueRef": fields.get("issueRef", ""),
            },
        )

    # ------------------------------------------------------------------
    # authoring handlers
    # ------------------------------------------------------------------

    def _handle_list_graphs(self, ctx: HandlerContext) -> HandlerResult:
        """The graph library for the asserted scope.

        Each entry carries the active version, the version count, and the active version's
        entrypoints. The entrypoints are here because this is the only read a caller needs in order
        to decide *where* to enter a graph, and the bridge's admission path asks exactly that
        question before it writes anything durable. Leaving it off meant the bridge had to guess or
        refuse, and refusing made admission impossible.

        The entrypoints come from the *active* version, not from a draft and not from the newest
        version: those three can differ, and the one an operator can actually start is the one the
        pointer names.
        """
        graphs: list[dict[str, Any]] = []
        for graph_id in self.registry.list_graphs(scope=ctx.scope):
            active = self.registry.get_active_version(scope=ctx.scope, graph_id=graph_id)
            versions = self.registry.list_versions(graph_id, scope=ctx.scope)
            entrypoints: dict[str, Any] = {}
            node_policies: list[dict[str, Any]] = []
            if active is not None:
                declared = active.definition.get("entrypoints")
                if isinstance(declared, Mapping):
                    entrypoints = dict(declared)
                declared_nodes = active.definition.get("nodes")
                if isinstance(declared_nodes, Mapping):
                    for node_id, node in sorted(declared_nodes.items()):
                        if not isinstance(node_id, str) or not isinstance(node, Mapping):
                            continue
                        if node.get("kind") != "agent_operation":
                            continue
                        executor = node.get("executor")
                        capabilities = (
                            executor.get("requiredCapabilities")
                            if isinstance(executor, Mapping)
                            else None
                        )
                        node_policies.append(
                            {
                                "nodeId": node_id,
                                "requiredCapabilities": [
                                    str(capability)
                                    for capability in capabilities or ()
                                    if isinstance(capability, str) and capability
                                ],
                                "eligibleSubjects": self.engine.capability_subjects(
                                    Scope.from_wire(ctx.scope),
                                    [
                                        str(capability)
                                        for capability in capabilities or ()
                                        if isinstance(capability, str) and capability
                                    ],
                                ),
                            }
                        )
            graphs.append(
                {
                    "graphId": graph_id,
                    "activeVersion": active.version if active is not None else None,
                    "versionCount": len(versions),
                    "isActive": active is not None,
                    "entrypoints": entrypoints,
                    # Admission uses this active-version projection to pin narrowly scoped
                    # node-execution policy from the bridge's separately governed capability
                    # bindings. It intentionally exposes no draft or inactive graph content.
                    "nodePolicies": node_policies,
                    "name": active.definition.get("name", graph_id) if active is not None else graph_id,
                    "description": active.definition.get("description", "") if active is not None else "",
                }
            )
        return Response.json_body(200, {"graphs": graphs})

    def _handle_create_draft(self, ctx: HandlerContext) -> HandlerResult:
        """Create a draft. The author is the asserted actor, never a body field."""
        definition = ctx.body.get("definition")
        base_version = ctx.body.get("baseVersion")
        if base_version is not None and (
            isinstance(base_version, bool) or not isinstance(base_version, int)
        ):
            raise errors.bad_request("baseVersion must be an integer", field="baseVersion")
        draft = self.registry.create_draft(
            company_ref=ctx.scope["companyRef"],
            project_ref=ctx.scope["projectRef"],
            graph_id=ctx.params["graphId"],
            author=ctx.subject,
            base_version=base_version,
            definition=definition,
        )
        return _draft_response(201, self.registry, draft, ctx.scope)

    def _handle_list_drafts(self, ctx: HandlerContext) -> HandlerResult:
        drafts = self.registry.list_drafts(ctx.params["graphId"], scope=ctx.scope)
        return Response.json_body(200, {"drafts": [d.summary() for d in drafts]})

    def _handle_get_draft(self, ctx: HandlerContext) -> HandlerResult:
        draft = self.registry.get_draft(ctx.params["draftId"], scope=ctx.scope)
        return _draft_response(200, self.registry, draft, ctx.scope)

    def _handle_save_draft(self, ctx: HandlerContext) -> HandlerResult:
        """Compare-and-swap on the ``If-Match`` revision. Editing invalidates everything derived."""
        definition = ctx.body.get("definition")
        if not isinstance(definition, AbcMapping):
            raise errors.contract_invalid(
                "a draft save must carry the full definition", field="definition"
            )
        draft = self.registry.save_draft(
            ctx.params["draftId"],
            definition=definition,
            author=ctx.subject,
            expected_revision=ctx.request.if_match_revision(),
            scope=ctx.scope,
        )
        return _draft_response(200, self.registry, draft, ctx.scope)

    def _handle_delete_draft(self, ctx: HandlerContext) -> HandlerResult:
        self.registry.delete_draft(ctx.params["draftId"], scope=ctx.scope)
        return Response(status=204, body=b"", content_type="application/json")

    def _handle_validate_draft(self, ctx: HandlerContext) -> HandlerResult:
        """Validate the *current* revision and bind the report to it."""
        draft = self.registry.get_draft(ctx.params["draftId"], scope=ctx.scope)
        report = validate_definition(draft.definition).for_draft(draft.draft_id, draft.revision)
        self.registry.record_validation(draft.draft_id, report, scope=ctx.scope)
        return Response.json_body(200, report.to_dict())

    def _handle_compile_draft(self, ctx: HandlerContext) -> HandlerResult:
        """Compile the current revision. Deterministic for the same definition and lock."""
        draft = self.registry.get_draft(ctx.params["draftId"], scope=ctx.scope)
        lock = ctx.body.get("dependencyLock")
        if lock is None:
            lock = _default_dependency_lock(draft.graph_id, draft.definition)
        compiled = compile_definition(
            draft.definition, dependency_lock=lock, known_graphs=_known_graphs()
        )
        # Stamped with the draft and revision it was produced for, because the publish path
        # refuses an artifact bound to a different one - the "validated then modified" hole.
        artifact = CompileArtifact.from_dict(
            {
                **compiled.to_dict(),
                "draftId": draft.draft_id,
                "revision": draft.revision,
            }
        )
        self.registry.record_compile(draft.draft_id, artifact.to_dict(), scope=ctx.scope)
        return Response.json_body(200, artifact.to_dict())

    def _handle_record_draft_review(self, ctx: HandlerContext) -> HandlerResult:
        """Bind a human review of one exact target hash to the current revision.

        Two controls the store cannot apply by itself, because it does not know who is calling:
        the reviewer must be a ``human`` assertion, and must not be the draft's author. A
        reviewer identity in a body is refused upstream, so the reviewer here is the signed
        actor and nothing else.
        """
        if not ctx.actor.is_human:
            raise errors.authorization_denied(
                "a graph review is a human act; an agent or system assertion may not record one",
                actorType=ctx.actor.actor.actor_type,
                reviewer=ctx.subject,
            )
        target_hash = str(ctx.body.get("reviewTargetHash", ""))
        if not target_hash:
            raise errors.bad_request(
                "reviewTargetHash is required: a review of nothing is not a review",
                field="reviewTargetHash",
            )
        draft = self.registry.get_draft(ctx.params["draftId"], scope=ctx.scope)
        if draft.author == ctx.subject:
            raise errors.authorization_denied(
                "a draft may not be reviewed by its own author; the review has to be a second pair "
                "of eyes",
                reviewer=ctx.subject,
                author=draft.author,
            )
        refs = [str(item) for item in (ctx.body.get("authorizationRefs") or ())]
        updated = self.registry.record_review(
            draft.draft_id,
            review_target_hash=target_hash,
            reviewer=ctx.subject,
            scope=ctx.scope,
            authorization_refs=refs,
        )
        return _draft_response(200, self.registry, updated, ctx.scope)

    def _handle_publish_draft(self, ctx: HandlerContext) -> HandlerResult:
        """Publish an immutable version. The CAS covers the whole chain for one revision."""
        body = ctx.body
        for field_name in ("definitionHash", "compilerVersion", "planHash", "reviewTargetHash"):
            if not str(body.get(field_name, "")):
                raise errors.bad_request(
                    f"{field_name} is required; publishing compares against it",
                    field=field_name,
                )
        expected_revision = body.get("expectedRevision")
        if expected_revision is not None:
            expected_revision = _body_int(expected_revision, "expectedRevision")
        draft = self.registry.get_draft(ctx.params["draftId"], scope=ctx.scope)
        version = self.registry.publish_version(
            scope=ctx.scope,
            graph_id=draft.graph_id,
            draft_id=draft.draft_id,
            author=ctx.subject,
            review_target_hash=str(body["reviewTargetHash"]),
            authorization_refs=[str(item) for item in (body.get("authorizationRefs") or ())],
            expected_revision=expected_revision,
            expected_definition_hash=str(body["definitionHash"]),
            expected_plan_hash=str(body["planHash"]),
            expected_compiler_version=str(body["compilerVersion"]),
        )
        return _version_response(201, self.registry, version, ctx.scope)

    def _handle_list_versions(self, ctx: HandlerContext) -> HandlerResult:
        graph_id = ctx.params["graphId"]
        versions = self.registry.list_versions(graph_id, scope=ctx.scope)
        # The pointer's generation is returned here because activation is a compare-and-swap on it
        # and there was no other way to read the value a caller has to present. Without this, a caller
        # could only guess, and a guess is only ever right the first time: every later activation
        # failed with "default pointer generation is stale" until someone deleted the pointer by
        # hand. A CAS whose current value is unreadable is not a CAS, it is a one-shot.
        pointer = self.registry.get_default_pointer(scope=ctx.scope, graph_id=graph_id)
        return Response.json_body(
            200,
            {
                "graphId": graph_id,
                "versions": [
                    v.summary(retired=self.registry.is_retired(graph_id, v.version, scope=ctx.scope))
                    for v in versions
                ],
                "activeVersion": _active_version(self.registry, ctx.scope, graph_id),
                "defaultPointer": pointer.to_dict() if pointer is not None else None,
                "generation": pointer.generation if pointer is not None else 0,
            },
        )

    def _handle_get_version(self, ctx: HandlerContext) -> HandlerResult:
        version = self.registry.get_version(
            ctx.params["graphId"], _path_int(ctx.params, "version"), scope=ctx.scope
        )
        return _version_response(200, self.registry, version, ctx.scope)

    def _handle_activate_version(self, ctx: HandlerContext) -> HandlerResult:
        """Independent CAS on the default pointer's own generation counter."""
        if ctx.body.get("version") is None:
            raise errors.bad_request("version is required", field="version")
        if ctx.body.get("expectedGeneration") is None:
            raise errors.bad_request(
                "expectedGeneration is required; activation is a compare-and-swap on its own "
                "generation counter",
                field="expectedGeneration",
            )
        pointer = self.registry.activate_version(
            scope=ctx.scope,
            graph_id=ctx.params["graphId"],
            version=_body_int(ctx.body["version"], "version"),
            expected_generation=_body_int(ctx.body["expectedGeneration"], "expectedGeneration"),
            actor=ctx.subject,
        )
        return Response.json_body(200, pointer.to_dict())

    def _handle_diff_versions(self, ctx: HandlerContext) -> HandlerResult:
        graph_id = ctx.params["graphId"]
        to_version = ctx.request.query_optional_int("to")
        if to_version is None:
            raise errors.bad_request("the 'to' query parameter is required", field="to")
        diff = self.registry.semantic_diff(
            graph_id,
            from_version=ctx.request.query_optional_int("from"),
            to_version=to_version,
            scope=ctx.scope,
        )
        return Response.json_body(200, diff.to_dict())

    # ------------------------------------------------------------------
    # execution handlers
    # ------------------------------------------------------------------

    def _handle_admit_work_order(self, ctx: HandlerContext) -> HandlerResult:
        """Admit one work order. Idempotent on scope + startIntentId + entrypoint."""
        if self.config.read_only:
            raise errors.run_blocked(
                "this instance is configured read-only and does not accept admissions",
                instanceRole=self.config.instance_role,
            )
        payload = ctx.engine_payload()
        # The engine records who admitted the work order from the asserted actor, never from a
        # body field, so the identity is attached here from the transport context.
        payload["actorId"] = ctx.subject
        snapshot = self.engine.admit_work_order(payload)
        return Response.json_body(201, snapshot)

    def _handle_list_runs(self, ctx: HandlerContext) -> HandlerResult:
        runs = self.engine.list_runs(
            scope=ctx.scope,
            graph_id=ctx.request.query_one("graphId"),
            status=ctx.request.query_one("status"),
            limit=ctx.request.query_int("limit", 50, minimum=1, maximum=500),
        )
        return Response.json_body(200, {"runs": runs, "count": len(runs)})

    def _handle_get_run(self, ctx: HandlerContext) -> HandlerResult:
        return Response.json_body(200, self.engine.get_run(ctx.params["runId"], scope=ctx.scope))

    def _handle_list_events(self, ctx: HandlerContext) -> HandlerResult:
        """Persisted events after a cursor, in ``seq`` order, with the run's current sequence.

        Reading the snapshot first is what makes the cursor honest: the caller is told the
        highest sequence that exists, so it can tell "no new events" from "more to fetch"
        without guessing.
        """
        run_id = ctx.params["runId"]
        snapshot = self.engine.get_run(run_id, scope=ctx.scope)
        after = ctx.request.query_int("after", 0, minimum=0)
        limit = ctx.request.query_int("limit", 200, minimum=1, maximum=1000)
        events = self.engine.list_events(run_id, after=after, limit=limit, scope=ctx.scope)
        cursor = int(events[-1]["seq"]) if events else after
        return Response.json_body(
            200,
            {
                "runId": run_id,
                "events": events,
                "count": len(events),
                "after": after,
                "nextAfter": cursor,
                "eventSequence": int(snapshot["eventSequence"]),
            },
        )

    def _handle_current_contract(self, ctx: HandlerContext) -> HandlerResult:
        """The current contract and permitted actions for the asserted actor. Read only."""
        if ctx.request.query_one("adopt") is not None or ctx.request.query_one("priorWorkerState") is not None:
            raise errors.bad_request(
                "GET /current is read-only; use the operator-only POST route for an explicit takeover"
            )
        return Response.json_body(200, self._current_view(ctx))

    def _current_view(self, ctx: HandlerContext) -> dict[str, Any]:
        return self.engine.current(
            ctx.params["runId"],
            actor=ctx.actor_view(),
            node_id=ctx.body.get("nodeId") or ctx.request.query_one("nodeId"),
        )

    def _handle_claim_node(self, ctx: HandlerContext) -> HandlerResult:
        return Response.json_body(200, self.engine.claim(_path_run_id(ctx)))

    def _handle_submit_artifacts(self, ctx: HandlerContext) -> HandlerResult:
        return Response.json_body(200, self.engine.submit_artifacts(_envelope(ctx)))

    def _handle_submit_evidence(self, ctx: HandlerContext) -> HandlerResult:
        return Response.json_body(200, self.engine.submit_evidence(_envelope(ctx)))

    def _handle_request_transition(self, ctx: HandlerContext) -> HandlerResult:
        """The only path to PASSED. ``202`` when the command is recorded and its effect waits."""
        result = self.engine.request_transition(_envelope(ctx))
        return _command_response(ctx, result)

    def _handle_request_help(self, ctx: HandlerContext) -> HandlerResult:
        result = self.engine.request_help(_envelope(ctx))
        # Always 202: a recorded help request is pending by definition, and answering 200 would
        # let a caller read "recorded" as "handled".
        return Response.json_body(202, result)

    def _handle_run_command(self, ctx: HandlerContext) -> HandlerResult:
        """pause/resume/cancel/retry/resolve_block. The Core re-checks the capability."""
        payload = _path_run_id(ctx)
        payload["actor"] = ctx.actor_view()
        return Response.json_body(200, self.engine.run_command(payload))

    def _handle_plan_migration(self, ctx: HandlerContext) -> HandlerResult:
        payload = _path_run_id(ctx)
        if not payload.get("targetGraphVersion"):
            raise errors.bad_request("targetGraphVersion is required", field="targetGraphVersion")
        return Response.json_body(200, self.engine.plan_migration(payload))

    def _handle_commit_migration(self, ctx: HandlerContext) -> HandlerResult:
        payload = _path_run_id(ctx)
        return Response.json_body(200, self.engine.commit_migration(payload))

    def _handle_record_governance_resolution(self, ctx: HandlerContext) -> HandlerResult:
        """Record a bridge-verified resolution, then re-run the whole gate.

        The responder fields *are* a body claim, and that is deliberate: they are a report of
        what the bridge read back from the authoritative platform object. The Core refuses
        anything unverified (``verifiedAgainstProvider``) and re-checks the responder against
        the request's own ``requiredResponder``, so a callback carrying ``approved=true`` is
        never enough on its own (``docs/05-PROTOCOL.md`` section 7).
        """
        payload = dict(ctx.payload)
        return Response.json_body(
            200,
            self.engine.record_governance_resolution(
                ctx.params["runId"], ctx.params["requestId"], payload
            ),
        )

    def _handle_list_refusals(self, ctx: HandlerContext) -> HandlerResult:
        """The isolated diagnostic record. Append-only, and never read back as state."""
        return Response.json_body(200, {"refusals": self.engine.refusals(ctx.params["runId"])})

    # ------------------------------------------------------------------
    # operations handlers
    # ------------------------------------------------------------------

    def _handle_health(self, ctx: HandlerContext) -> HandlerResult:
        return Response.json_body(200, self.health())

    def _handle_health_live(self, ctx: HandlerContext) -> HandlerResult:
        """Liveness. Touches no tenant data, which is why it is the one open route."""
        return Response.json_body(
            200,
            {
                "status": "alive" if not self.stopping else "stopping",
                "protocolVersion": PROTOCOL_VERSION,
                "instanceRole": self.config.instance_role,
                "uptimeSeconds": round(time.monotonic() - self._started_monotonic, 3),
                "checkedAt": _now_iso(),
            },
        )

    def _handle_health_ready(self, ctx: HandlerContext) -> HandlerResult:
        """Readiness with a status a load balancer can act on.

        ``degraded`` is ready: there is undelivered work or an unknown effect, but the process
        can still admit and serve, and taking it out of rotation would not help. ``read_only``
        and ``blocked`` are not ready, because routing traffic here would fail the work anyway.
        """
        report = self.health()
        status = 200 if report["status"] in ("ready", "degraded") else 503
        return Response.json_body(status, report)

    def _handle_recover(self, ctx: HandlerContext) -> HandlerResult:
        """One reconciliation pass. Operator only, and idempotent."""
        report = self.engine.recover()
        return Response.json_body(200, report)

    def _handle_intake_event(self, ctx: HandlerContext) -> HandlerResult:
        """Ingest one ``pf.*`` observation. Recorded, never applied as a pass."""
        event = dict(ctx.payload)
        event.setdefault("source", "bridge")
        return Response.json_body(202, self.engine.intake_event(event))

    def _handle_openapi(self, ctx: HandlerContext) -> HandlerResult:
        from polyforge.services.runtime_api.openapi import build_document

        return Response.json_body(200, build_document())

    # ------------------------------------------------------------------
    # bridge handlers
    # ------------------------------------------------------------------

    def _handle_bridge_outbox(self, ctx: HandlerContext) -> HandlerResult:
        limit = ctx.request.query_int("limit", 50, minimum=1, maximum=500)
        intents = self.claim_outbox(ctx.scope, limit)
        return Response.json_body(
            200,
            {
                "intents": intents,
                "count": len(intents),
                "leaseSeconds": self.config.outbox_lease_seconds,
            },
        )

    def _handle_bridge_outbox_delivery(self, ctx: HandlerContext) -> HandlerResult:
        """Acknowledge one delivery attempt, scope-checked before the Core sees it."""
        intent_id = ctx.params["intentId"]
        row = self.database.query_one(
            "SELECT company_ref, project_ref FROM outbox_intents WHERE intent_id = ?", (intent_id,)
        )
        if row is None:
            raise errors.not_found("no such outbox intent", intentId=intent_id)
        if str(row["company_ref"]) != ctx.scope["companyRef"] or str(row["project_ref"]) != ctx.scope[
            "projectRef"
        ]:
            raise errors.scope_violation(
                "this outbound intent belongs to a different company/project than the signed scope",
                intentId=intent_id,
            )
        state = str(ctx.body.get("state", ""))
        report = self.engine.mark_delivery(
            intent_id,
            state,
            receipt=(
                ctx.body.get("receipt") if isinstance(ctx.body.get("receipt"), AbcMapping) else None
            ),
            error=ctx.body.get("error") if isinstance(ctx.body.get("error"), AbcMapping) else None,
        )
        return Response.json_body(200, report)


# ----------------------------------------------------------------------
# helpers
# ----------------------------------------------------------------------


def _with_correlation_id(request: Request, correlation_id: str) -> Request:
    if request.correlation_id == correlation_id:
        return request
    return Request(
        method=request.method,
        path=request.path,
        route_path=request.route_path,
        signed_path=request.signed_path,
        query=request.query,
        headers=request.headers,
        raw_body=request.raw_body,
        correlation_id=correlation_id,
        peer=request.peer,
    )


def _path_run_id(ctx: HandlerContext) -> dict[str, Any]:
    """The body plus the run id from the path, with a disagreement refused.

    The path is authoritative, and a body that names a *different* run is a caller mistake
    worth reporting rather than silently overwriting: a bridge that got its ids crossed would
    otherwise write to the run it did not mean.
    """
    payload = dict(ctx.payload)
    run_id = ctx.params["runId"]
    if payload.get("runId") not in (None, run_id):
        raise errors.contract_invalid(
            "the runId in the body does not match the runId in the path",
            pathRunId=run_id,
            bodyRunId=str(payload["runId"]),
        )
    payload["runId"] = run_id
    return payload


def _body_int(value: Any, field_name: str) -> int:
    """A required integer body field.

    Strict on purpose: a JSON ``"3"`` reaching a compare-and-swap is a client bug, and letting
    it through would make the CAS token's type depend on how the client serialised it.
    """
    if isinstance(value, bool) or not isinstance(value, int):
        raise errors.bad_request(f"{field_name} must be an integer", field=field_name, received=type(value).__name__)
    return int(value)


def _path_int(params: Mapping[str, str], name: str) -> int:
    """A required integer path segment. A path segment is a string, so it is parsed here."""
    raw = params.get(name, "")
    try:
        return int(raw)
    except ValueError as exc:
        raise errors.bad_request(
            f"path segment {{{name}}} must be an integer", field=name, received=raw
        ) from exc


def _envelope(ctx: HandlerContext) -> dict[str, Any]:
    return _path_run_id(ctx)


def _command_response(ctx: HandlerContext, result: Mapping[str, Any]) -> HandlerResult:
    """``202`` for a recorded-but-deferred command, ``200`` otherwise.

    The body stays the command envelope, not the error body: a deferred command succeeded at
    being recorded, and a bridge that has to parse an error to find that out will eventually
    treat it as a failure and retry a command that is already parked.
    """
    if bool(result.get("pending")):
        return Response.json_body(202, result)
    return Response.json_body(200, result)


def _known_graphs() -> Mapping[str, Mapping[str, Any]]:
    from polyforge.graph_library import all_definitions

    return all_definitions()


def _default_dependency_lock(graph_id: str, definition: Mapping[str, Any]) -> dict[str, Any]:
    """The lock a compile should use when the caller did not pin one.

    A library graph gets its shipped lock. Anything else is locked from the same version tables
    against *its own* definition, so a custom graph still gets a complete, pinned closure
    rather than a silently empty one. Note both ``dependency_lock_for`` names: the compiler's
    takes the version tables as arguments, the library's does not.
    """
    from polyforge.graph_library import (
        dependency_lock_for as library_lock,
        dependency_lock_for_definition,
        library_graph_ids,
    )

    if graph_id in library_graph_ids():
        return library_lock(graph_id)
    return dependency_lock_for_definition(definition)


def _active_version(
    registry: RegistryStore, scope: Mapping[str, str], graph_id: str
) -> int | None:
    pointer = registry.get_default_pointer(scope=scope, graph_id=graph_id)
    return None if pointer is None else int(pointer.version)


def _draft_response(
    status: int, registry: RegistryStore, draft: Any, scope: Mapping[str, str]
) -> HandlerResult:
    """A draft with its derived state, plus the ``ETag`` that carries the concurrency token."""
    body = draft.to_dict()
    body["validation"] = registry.get_validation(draft.draft_id) or None
    body["compile"] = registry.get_compile(draft.draft_id) or None
    return Response.json_body(
        status, body, headers=(("ETag", f'"{int(draft.revision)}"'),)
    )


def _version_response(
    status: int, registry: RegistryStore, version: Any, scope: Mapping[str, str]
) -> HandlerResult:
    body = version.to_dict()
    body["retired"] = registry.is_retired(version.graph_id, version.version, scope=scope)
    return Response.json_body(status, body, headers=(("ETag", f'"{int(version.version)}"'),))


# ----------------------------------------------------------------------
# background loops
# ----------------------------------------------------------------------


class _Loop(threading.Thread):
    """A named, stoppable, exception-swallowing background loop.

    A loop that dies on one transient database error stops reconciling forever, which is the
    one failure mode a background job must not have. Each iteration is independently guarded,
    the error is recorded for ``/health``, and the loop keeps going.
    """

    def __init__(self, service: RuntimeService, *, interval: float) -> None:
        super().__init__(name=f"polyforge-{type(self).__name__}", daemon=True)
        self.service = service
        self.interval = interval
        self.stop_event = threading.Event()
        self.runs = 0
        self.last_run_at: str | None = None
        self.last_error: str | None = None
        self._alive = False

    @property
    def alive(self) -> bool:
        return self._alive

    def request_stop(self) -> None:
        self.stop_event.set()

    def run(self) -> None:  # pragma: no cover - driven by start(); exercised via the service
        self._alive = True
        try:
            while not self.stop_event.is_set():
                try:
                    self.iterate()
                    self.runs += 1
                    self.last_run_at = _now_iso()
                    self.last_error = None
                except Exception as exc:  # noqa: BLE001 - the loop outlives one bad pass
                    self.last_error = type(exc).__name__
                    logger.warning(
                        "background.iteration_failed",
                        extra={
                            "pf.event": "background.iteration_failed",
                            "pf.loop": self.name,
                            "pf.exceptionType": type(exc).__name__,
                        },
                        exc_info=True,
                    )
                self.stop_event.wait(self.interval)
        finally:
            self._alive = False

    def iterate(self) -> None:  # pragma: no cover - overridden
        raise NotImplementedError


class _ReconcilerLoop(_Loop):
    """Calls ``engine.recover()`` on an interval.

    Reconciliation is idempotent by construction (``runtime.recovery`` owns that rule), which
    is what makes running it on a timer safe: a second pass over already-repaired state changes
    nothing (AT-27).
    """

    def iterate(self) -> None:  # pragma: no cover - driven by start()
        self.service.recover_once()


class _OutboxReaperLoop(_Loop):
    """Returns expired outbox claims to the queue.

    The outbox is **pull**-based: the bridge polls ``GET /v1/bridge/outbox`` and acknowledges
    with ``POST /v1/bridge/outbox/{intentId}/delivery``. Pull was chosen over push because the
    Core cannot reach the bridge, because a queue the Core pushes into has to be buffered
    somewhere the Core does not own, and because a poll makes "the bridge took it" an
    observable fact. The cost is that a bridge dying mid-delivery leaves claims held; that is
    this loop, and it releases only expired ones.
    """

    def __init__(self, service: RuntimeService, *, interval: float) -> None:
        super().__init__(service, interval=interval)
        self.lapsed = 0

    def iterate(self) -> None:  # pragma: no cover - driven by start()
        self.lapsed += self.service.reap_outbox_claims()


def build_service(config: ServiceConfig, **kwargs: Any) -> RuntimeService:
    """Construct a service from a validated configuration."""
    config.validate()
    return RuntimeService(config, **kwargs)
