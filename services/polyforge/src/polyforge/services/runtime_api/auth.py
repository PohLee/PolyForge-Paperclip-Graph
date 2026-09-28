"""The bridge-to-Runtime trust boundary.

Responsibility: turn six request headers into a verified :class:`AuthContext`, or refuse the
request with a stable code. This is hop two of the three in ``docs/05-PROTOCOL.md`` section
1, and it is the only place in the process where a company id or an actor identity may enter
from outside.

Invariants (each one is a rejection, not a warning):

* **A request is signed over its own bytes.** The canonical request includes the
  ``sha256:`` digest of the exact body received, so a mutated body cannot verify even when
  the attacker has the signature. :meth:`RequestAuthenticator.canonical_request` is the one
  definition of that string; the TypeScript bridge computes the same bytes.
* **The signature is compared in constant time.** ``hmac.compare_digest`` only.
* **A captured request is useless.** The signature covers issuer, audience, method, path
  (with query), body digest, timestamp, nonce, actor and scope, so it cannot be replayed at
  another endpoint, for another service, for another body, or by another actor, and the
  timestamp window plus the nonce cache bound how long a replay is even worth attempting.
* **Identity arrives in headers, never in a body.** The decoded actor and scope are the only
  identity the rest of the process sees. A body that names a different company is
  ``403 SCOPE_VIOLATION``; a body that tries to *set* an actor or an approval is
  ``422 CONTRACT_INVALID`` outright, because a worker that can name itself a human has no
  reason to stop at that (AT-13).
* **A human assertion is only as good as its issuer.** Exactly one issuer may be configured
  and a ``human`` actor is refused from anything else, so "some plugin said a human said so"
  is not a path into the Core.
* **The nonce cache is bounded and TTL'd.** An unbounded replay cache is a memory exhaustion
  vector, so it evicts the oldest entries and expires anything older than the window.

The nonce is consumed *after* the signature verifies. Checking it first would let an
unauthenticated caller burn a legitimate caller's nonces, and would record an attacker's
chosen nonce as if it were a real caller's.
"""

from __future__ import annotations

import base64
import binascii
import hmac
import json
import logging
import re
import threading
import time
from collections import OrderedDict
from collections.abc import Sequence as AbcSequence
from dataclasses import dataclass, field
from hashlib import sha256
from typing import Any, Callable, Final, Mapping

from polyforge.core import errors
from polyforge.core.errors import ErrorCode, PolyForgeError
from polyforge.core.hashing import canonical_bytes, digest_bytes

__all__ = [
    "ACTOR_TYPES",
    "AUDIENCE_HEADER",
    "AUTH_HEADERS",
    "ActorAssertion",
    "AuthContext",
    "AuthFailure",
    "CANONICAL_FIELDS",
    "NonceCache",
    "RequestAuthenticator",
    "SCOPE_HEADER",
    "SIGNATURE_PREFIX",
    "SignedHeaders",
    "canonical_request_bytes",
    "decode_b64url",
    "encode_b64url",
    "sign_headers",
]

logger = logging.getLogger("polyforge.runtime_api.auth")

ISSUER_HEADER: Final[str] = "X-PF-Issuer"
TIMESTAMP_HEADER: Final[str] = "X-PF-Timestamp"
NONCE_HEADER: Final[str] = "X-PF-Nonce"
ACTOR_HEADER: Final[str] = "X-PF-Actor"
SCOPE_HEADER: Final[str] = "X-PF-Scope"
SIGNATURE_HEADER: Final[str] = "X-PF-Signature"
AUDIENCE_HEADER: Final[str] = "X-PF-Audience"

#: Every header hop two uses, in the order they appear in the canonical request.
AUTH_HEADERS: Final[tuple[str, ...]] = (
    ISSUER_HEADER,
    TIMESTAMP_HEADER,
    NONCE_HEADER,
    ACTOR_HEADER,
    SCOPE_HEADER,
    SIGNATURE_HEADER,
)

#: Instance-scoped routes still need a full signature; they just do not need a tenant named.
_AUTH_HEADERS_WITHOUT_SCOPE: Final[tuple[str, ...]] = tuple(
    name for name in AUTH_HEADERS if name != SCOPE_HEADER
)

#: The exact keys of the signed object, sorted by :mod:`polyforge.core.hashing`. Both sides
#: build this dict and let the canonical encoder sort it, so neither has to agree on order.
CANONICAL_FIELDS: Final[tuple[str, ...]] = (
    "actor",
    "audience",
    "bodyHash",
    "issuer",
    "method",
    "nonce",
    "path",
    "scope",
    "timestamp",
)

SIGNATURE_PREFIX: Final[str] = "v1="

#: ``human`` is in the set because a real human decision resolves a run; it is reachable
#: only from the configured bridge issuer, which is the whole point of the boundary.
ACTOR_TYPES: Final[frozenset[str]] = frozenset({"human", "agent", "system"})

_NONCE_RE = re.compile(r"\A[A-Za-z0-9_-]{8,128}\Z")
_SIGNATURE_RE = re.compile(r"\Av1=([0-9a-fA-F]{64})\Z")
#: 128-bit random in hex, or any base64url token of 16+ characters. Both are accepted because
#: the requirement is unpredictability and length, not a particular encoding.
_DIGEST_RE = re.compile(r"\Asha256:[0-9a-f]{64}\Z")


class AuthFailure(PolyForgeError):
    """A refused request at the trust boundary.

    A distinct type so the service can log it as a security event rather than as a handler
    bug, and so a caller cannot tell *which* check failed from the message alone: the
    ``reason`` detail is for the operator's log, the message is for the bridge.
    """

    def __init__(self, reason: str, message: str, **details: Any) -> None:
        super().__init__(
            ErrorCode.AUTHORIZATION_DENIED, message, details={"reason": reason, **details}
        )
        self.reason = reason


@dataclass(frozen=True, slots=True)
class ActorAssertion:
    """Trusted caller identity, decoded from ``X-PF-Actor``.

    ``actor_type`` is the platform's word for who is calling, not a claim the Core trusts on
    its own: a worker process that wants to look like a human sets ``actorType`` to
    ``human`` here, and the only thing that makes it real is that the whole assertion came
    from the configured issuer over a verified signature.
    """

    actor_type: str
    actor_id: str
    agent_id: str | None = None
    run_id: str | None = None
    roles: tuple[str, ...] = ()

    def to_wire(self) -> dict[str, Any]:
        """The canonical assertion form: optional fields are **absent**, never ``null``.

        The canonical encoder keeps an explicit ``null`` and only drops the ``OMIT`` sentinel,
        so a ``null`` here and an absent key there would be two different signed objects. The
        assertion is normalised on both sides of the boundary, so a bridge may omit
        ``agentId``/``runId`` or send them as ``null`` and still produce the same bytes.
        """
        body: dict[str, Any] = {
            "actorType": self.actor_type,
            "actorId": self.actor_id,
        }
        if self.agent_id is not None:
            body["agentId"] = self.agent_id
        if self.run_id is not None:
            body["runId"] = self.run_id
        if self.roles:
            body["roles"] = list(self.roles)
        return body

    @property
    def subject_ref(self) -> str:
        return self.actor_id

    @staticmethod
    def from_wire(value: Any) -> "ActorAssertion | None":
        if not isinstance(value, Mapping):
            return None
        actor_type = str(value.get("actorType", ""))
        actor_id = str(value.get("actorId", ""))
        if actor_type not in ACTOR_TYPES or not actor_id.strip():
            return None
        roles = value.get("roles")
        # A bare string is a Sequence, and ``("a","d","m")`` is not a role list.
        role_list = (
            tuple(str(role) for role in roles)
            if isinstance(roles, AbcSequence) and not isinstance(roles, (str, bytes))
            else ()
        )
        return ActorAssertion(
            actor_type=actor_type,
            actor_id=actor_id,
            agent_id=None if value.get("agentId") is None else str(value["agentId"]),
            run_id=None if value.get("runId") is None else str(value["runId"]),
            roles=role_list,
        )


@dataclass(frozen=True, slots=True)
class AuthContext:
    """Everything the rest of the process is allowed to know about the caller.

    ``replayed`` is carried rather than merely refused so an operator reading the log can
    tell a duplicate delivery from a forged one; a replay never produces a served response.
    """

    issuer: str
    actor: ActorAssertion
    scope: dict[str, str]
    nonce: str
    timestamp: str
    audience: str = ""
    replayed: bool = False

    @property
    def company_ref(self) -> str:
        """The company, or ``""`` for an instance-scoped caller.

        An empty scope is a real state, not a bug: health and operator recovery are about the
        deployment. Reading this property must not raise on it, because the audit log records a
        scope for *every* authenticated request.
        """
        return str(self.scope.get("companyRef", ""))

    @property
    def project_ref(self) -> str:
        return str(self.scope.get("projectRef", ""))

    @property
    def subject_ref(self) -> str:
        return self.actor.actor_id

    @property
    def is_human(self) -> bool:
        return self.actor.actor_type == "human"

    def to_wire(self) -> dict[str, Any]:
        return {
            "issuer": self.issuer,
            "actor": self.actor.to_wire(),
            "scope": dict(self.scope),
            "nonce": self.nonce,
            "timestamp": self.timestamp,
            "audience": self.audience,
        }


@dataclass(frozen=True, slots=True)
class SignedHeaders:
    """The header set a caller sends. Returned by :func:`sign_headers` for the bridge's benefit."""

    headers: dict[str, str] = field(default_factory=dict)
    canonical: str = ""
    signature: str = ""


def encode_b64url(value: Mapping[str, Any]) -> str:
    """Base64url the canonical JSON of ``value``, without padding."""
    return base64.urlsafe_b64encode(canonical_bytes(value)).decode("ascii").rstrip("=")


def decode_b64url(text: str) -> Any:
    """Inverse of :func:`encode_b64url`. A malformed token is an error, never a guess."""
    padded = text + "=" * (-len(text) % 4)
    try:
        raw = base64.urlsafe_b64decode(padded.encode("ascii"))
    except (binascii.Error, ValueError, UnicodeEncodeError) as exc:
        raise AuthFailure("malformed_header", "an assertion header is not valid base64url") from exc
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise AuthFailure("malformed_header", "an assertion header is not valid JSON") from exc


def canonical_request_bytes(
    *,
    audience: str,
    method: str,
    path: str,
    body_hash: str,
    timestamp: str,
    nonce: str,
    issuer: str,
    actor: Mapping[str, Any],
    scope: Mapping[str, Any],
) -> bytes:
    """The exact bytes both sides sign.

    ``path`` is the request target *relative to the API base* and **includes the query
    string**, so a query parameter is covered by the signature: ``/graphs/g/diff?from=1&to=2``
    and ``/graphs/g/diff?from=1&to=3`` are different signed requests. Excluding the query
    would leave the version pair of a diff unauthenticated.

    The eight keys are fixed and the canonical encoder sorts them, so neither side has to
    agree on an ordering convention beyond "use the canonical encoder".
    """
    return canonical_bytes(
        {
            "actor": dict(actor),
            "audience": audience,
            "bodyHash": body_hash,
            "issuer": issuer,
            "method": str(method).upper(),
            "nonce": nonce,
            "path": path,
            "scope": dict(scope),
            "timestamp": timestamp,
        }
    )


def sign_headers(
    *,
    secret: str,
    method: str,
    path: str,
    body: bytes = b"",
    issuer: str,
    actor: Mapping[str, Any],
    scope: Mapping[str, Any],
    timestamp: str,
    nonce: str,
    audience: str,
) -> SignedHeaders:
    """Produce the header set for one request. Used by the bridge and by this package's tests.

    This is deliberately a thin wrapper over the same canonical encoder the verifier uses, so
    "the test signs" and "the bridge signs" are the same code path rather than two
    implementations that agree by luck. The actor is normalised through
    :meth:`ActorAssertion.from_wire` first, which means a caller may omit the optional
    assertion fields, send them as ``null``, or send an extra field the Core does not model,
    and still produce the bytes the verifier reconstructs.
    """
    normalised = ActorAssertion.from_wire(actor)
    if normalised is None:
        raise AuthFailure(
            "malformed_actor",
            "sign_headers needs an ActorAssertion with a known actorType and a non-empty id",
        )
    body_hash = digest_bytes(body)
    canonical = canonical_request_bytes(
        audience=audience,
        method=method,
        path=path,
        body_hash=body_hash,
        timestamp=timestamp,
        nonce=nonce,
        issuer=issuer,
        actor=normalised.to_wire(),
        scope=scope,
    )
    mac = hmac.new(secret.encode("utf-8"), canonical, sha256).hexdigest()
    signature = f"{SIGNATURE_PREFIX}{mac}"
    headers = {
        ISSUER_HEADER: issuer,
        TIMESTAMP_HEADER: timestamp,
        NONCE_HEADER: nonce,
        ACTOR_HEADER: encode_b64url(normalised.to_wire()),
        SCOPE_HEADER: encode_b64url(scope),
        SIGNATURE_HEADER: signature,
    }
    if audience:
        headers[AUDIENCE_HEADER] = audience
    return SignedHeaders(
        headers=headers, canonical=canonical.decode("utf-8"), signature=signature
    )


class NonceCache:
    """Bounded, TTL'd set of nonces already spent inside the replay window.

    Two hard limits, both of which exist because this cache is fed by the network:

    * **TTL.** An entry older than ``ttl_seconds`` is removed. Past the window a replayed
      request is already refused by the timestamp check, so keeping the nonce longer would
      only grow the cache.
    * **Capacity.** At ``max_entries`` the oldest entry is evicted. Evicting early is safe:
      it can only let a very old nonce be spent twice, and a second spend of a nonce that old
      is already outside the timestamp window and refused there. Refusing to start because
      the cache filled up would be a worse failure than a bounded memory cost.
    """

    __slots__ = ("_entries", "_lock", "_max_entries", "_ttl")

    def __init__(self, *, max_entries: int = 65_536, ttl_seconds: float = 300.0) -> None:
        self._entries: "OrderedDict[str, float]" = OrderedDict()
        self._lock = threading.Lock()
        self._max_entries = max(1, int(max_entries))
        self._ttl = float(ttl_seconds)

    def __len__(self) -> int:
        with self._lock:
            return len(self._entries)

    def seen(self, nonce: str, *, now: float | None = None) -> bool:
        """Whether ``nonce`` is already spent and still inside the window."""
        moment = time.monotonic() if now is None else now
        with self._lock:
            self._expire(moment)
            return nonce in self._entries

    def spend(self, nonce: str, *, now: float | None = None) -> bool:
        """Record ``nonce`` as spent. Returns ``False`` when it was already spent."""
        moment = time.monotonic() if now is None else now
        with self._lock:
            self._expire(moment)
            if nonce in self._entries:
                return False
            self._entries[nonce] = moment + self._ttl
            while len(self._entries) > self._max_entries:
                self._entries.popitem(last=False)
            return True

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()

    def _expire(self, moment: float) -> None:
        deadline = moment
        stale = [key for key, expiry in self._entries.items() if expiry <= deadline]
        for key in stale:
            del self._entries[key]


def _now_seconds(clock: Any) -> float:
    """Epoch seconds from an injected clock.

    The clock is duck-typed rather than required to be ``ids.SystemClock`` so a test can
    pass a monotonic function: replay arithmetic is about elapsed time, not wall time.
    """
    if clock is None:
        return time.time()
    if callable(clock):
        return float(clock())
    if hasattr(clock, "epoch_ms"):
        return float(clock.epoch_ms()) / 1000.0
    if hasattr(clock, "now"):
        return float(clock.now().timestamp())
    return float(clock)


def _parse_timestamp(value: str) -> float:
    """RFC3339 UTC to epoch seconds. A value without an offset is refused, not assumed.

    Assuming UTC for a naive timestamp would let a caller whose clock is hours off still
    land inside the window, which defeats the window.
    """
    from datetime import UTC, datetime

    text = value.strip()
    if text.endswith("Z") or text.endswith("z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError as exc:
        raise AuthFailure("malformed_timestamp", "X-PF-Timestamp is not an RFC3339 timestamp") from exc
    if parsed.tzinfo is None:
        raise AuthFailure(
            "malformed_timestamp", "X-PF-Timestamp must carry an explicit UTC offset"
        )
    return parsed.astimezone(UTC).timestamp()


class RequestAuthenticator:
    """Verify one request's headers and produce its :class:`AuthContext`.

    Construction refuses an empty secret or an empty issuer: a trust boundary that starts
    open cannot be closed later from inside a request.
    """

    __slots__ = (
        "_allowed_audience",
        "_issuer",
        "_nonce_cache",
        "_now",
        "_replay_window_seconds",
        "_secret",
    )

    def __init__(
        self,
        issuer: str,
        secret: str,
        replay_window_seconds: int = 120,
        allowed_audience: AbcSequence[str] = ("polyforge-runtime",),
        clock: Callable[[], float] | Any | None = None,
        nonce_cache: NonceCache | None = None,
    ) -> None:
        issuer = issuer.strip()
        if not issuer:
            raise errors.PolyForgeError(
                ErrorCode.CONTRACT_INVALID,
                "a bridge issuer is required: with none configured every issuer would be trusted",
            )
        if any(separator in issuer for separator in (",", ";", " ")):
            # One configured issuer is what makes a `human` assertion mean anything, so a list
            # smuggled into a scalar field is refused rather than treated as one odd id.
            raise errors.PolyForgeError(
                ErrorCode.CONTRACT_INVALID,
                f"exactly one bridge issuer may be configured, got {issuer!r}",
            )
        if not secret:
            raise errors.PolyForgeError(
                ErrorCode.CONTRACT_INVALID,
                "a shared secret is required: an empty secret verifies any signature",
            )
        audiences = tuple(dict.fromkeys(str(a) for a in allowed_audience if str(a).strip()))
        if not audiences:
            raise errors.PolyForgeError(
                ErrorCode.CONTRACT_INVALID, "at least one allowed audience is required"
            )
        window = int(replay_window_seconds)
        if window < 1:
            raise errors.PolyForgeError(
                ErrorCode.CONTRACT_INVALID, "replay_window_seconds must be at least 1"
            )
        self._issuer = issuer
        self._secret = secret.encode("utf-8")
        self._replay_window_seconds = window
        self._allowed_audience = audiences
        self._now = clock
        self._nonce_cache = nonce_cache or NonceCache(
            max_entries=65_536, ttl_seconds=float(window) * 2.0
        )

    # -- introspection ---------------------------------------------------

    @property
    def issuer(self) -> str:
        return self._issuer

    @property
    def allowed_audience(self) -> tuple[str, ...]:
        return self._allowed_audience

    @property
    def replay_window_seconds(self) -> int:
        return self._replay_window_seconds

    @property
    def nonce_cache(self) -> NonceCache:
        return self._nonce_cache

    # -- verification ----------------------------------------------------

    def authenticate(
        self,
        method: str,
        path: str,
        raw_body: bytes,
        headers: Mapping[str, str],
        *,
        correlation_id: str = "",
        require_scope: bool = True,
        require_project: bool = True,
    ) -> AuthContext:
        """Verify ``headers`` against ``raw_body`` and return the caller's identity.

        The order is a security property, not a style choice: presence, then issuer, then
        audience, then timestamp, then signature, and only then the nonce. Every step before
        the signature is a cheap, side-effect-free rejection that a caller can fail in
        isolation, and the nonce is spent last so an unauthenticated request cannot consume
        a real caller's nonce.

        ``require_scope=False`` is for *instance-scoped* routes — health and operator recovery —
        whose answers are facts about the deployment rather than about a tenant. Such a route
        still needs a full signature; it simply does not need the caller to name a company. A
        scope header that *is* present is still parsed and still signed, so a caller that sends
        one cannot downgrade a tenant-scoped route into an instance-scoped one.

        ``require_project=False`` relaxes only the *project* half of the scope, and only for a
        route that has no project to name. A bridge's liveness probe is company-scoped: it
        reports whether this deployment's Core is reachable and which versions it speaks, and it
        reads no project data. Forcing the bridge to invent a project identity to ask "are you
        there?" would mean putting a fabricated value into a signed scope, and a fabricated value
        that later becomes a real authorization input is precisely the bug this system exists to
        prevent. ``companyRef`` stays mandatory, because health does report company wiring.
        """
        lowered = {str(key).lower(): str(value) for key, value in headers.items()}
        required = AUTH_HEADERS if require_scope else _AUTH_HEADERS_WITHOUT_SCOPE
        missing = [name for name in required if not lowered.get(name.lower())]
        if missing:
            raise self._reject(
                "missing_header",
                "the request is missing a required signature header",
                method=method,
                path=path,
                correlation_id=correlation_id,
                missingHeaders=missing,
            )

        issuer = lowered[ISSUER_HEADER.lower()]
        if not hmac.compare_digest(issuer, self._issuer):
            raise self._reject(
                "unknown_issuer",
                "the request was not issued by the configured bridge",
                method=method,
                path=path,
                correlation_id=correlation_id,
                presentedIssuer=issuer[:120],
            )

        audience = (lowered.get(AUDIENCE_HEADER.lower()) or self._allowed_audience[0]).strip()
        if audience not in self._allowed_audience:
            raise self._reject(
                "unknown_audience",
                "the request is bound to an audience this service does not serve",
                method=method,
                path=path,
                correlation_id=correlation_id,
                presentedAudience=audience[:120],
            )

        timestamp = lowered[TIMESTAMP_HEADER.lower()].strip()
        epoch = _parse_timestamp(timestamp)
        drift = abs(_now_seconds(self._now) - epoch)
        if drift > self._replay_window_seconds:
            raise self._reject(
                "stale_timestamp",
                "the request timestamp is outside the accepted replay window",
                method=method,
                path=path,
                correlation_id=correlation_id,
                driftSeconds=int(drift),
                replayWindowSeconds=self._replay_window_seconds,
            )

        nonce = lowered[NONCE_HEADER.lower()].strip()
        if not _NONCE_RE.match(nonce):
            raise self._reject(
                "malformed_nonce",
                "X-PF-Nonce must be 8 to 128 URL-safe characters",
                method=method,
                path=path,
                correlation_id=correlation_id,
            )

        presented = lowered[SIGNATURE_HEADER.lower()].strip()
        matched = _SIGNATURE_RE.match(presented)
        if matched is None:
            raise self._reject(
                "malformed_signature",
                "X-PF-Signature must be v1= followed by a hex HMAC-SHA256 digest",
                method=method,
                path=path,
                correlation_id=correlation_id,
            )

        actor = self._decode_actor(lowered[ACTOR_HEADER.lower()], method, path, correlation_id)
        raw_scope = lowered.get(SCOPE_HEADER.lower(), "").strip()
        if not require_scope and not raw_scope:
            # An instance-scoped route with no tenant named. The empty scope still participates in
            # the signature, so a captured request cannot be replayed at a tenant-scoped route with
            # a substituted scope.
            scope: dict[str, str] = {}
        else:
            scope = self._decode_scope(
                raw_scope,
                method,
                path,
                correlation_id,
                allow_empty=not require_scope,
                require_project=require_project,
            )
        self._assert_human_is_trusted(actor, issuer)

        body_hash = digest_bytes(raw_body)
        if not _DIGEST_RE.match(body_hash):  # pragma: no cover - digest_bytes is fixed-format
            raise self._reject(
                "body_digest", "the body digest is malformed", method=method, path=path
            )
        canonical = canonical_request_bytes(
            audience=audience,
            method=method,
            path=path,
            body_hash=body_hash,
            timestamp=timestamp,
            nonce=nonce,
            issuer=issuer,
            actor=actor.to_wire(),
            scope=scope,
        )
        expected = hmac.new(self._secret, canonical, sha256).hexdigest()
        # Constant time, and after every cheap check: a timing oracle on the HMAC is the one
        # way to forge a signature without the secret.
        if not hmac.compare_digest(expected, matched.group(1).lower()):
            raise self._reject(
                "bad_signature",
                "the request signature does not verify against the received bytes",
                method=method,
                path=path,
                correlation_id=correlation_id,
                actorId=actor.actor_id,
                issuer=issuer,
            )

        if not self._nonce_cache.spend(nonce):
            raise self._reject(
                "nonce_replay",
                "this nonce was already used inside the replay window",
                method=method,
                path=path,
                correlation_id=correlation_id,
                actorId=actor.actor_id,
                issuer=issuer,
                replayed=True,
            )

        return AuthContext(
            issuer=issuer,
            actor=actor,
            scope=scope,
            nonce=nonce,
            timestamp=timestamp,
            audience=audience,
        )

    # -- decoding --------------------------------------------------------

    def _decode_actor(
        self, token: str, method: str, path: str, correlation_id: str
    ) -> ActorAssertion:
        decoded = decode_b64url(token)
        actor = ActorAssertion.from_wire(decoded)
        if actor is None:
            raise self._reject(
                "malformed_actor",
                "X-PF-Actor must be a base64url ActorAssertion with a known actorType and an id",
                method=method,
                path=path,
                correlation_id=correlation_id,
            )
        return actor

    def _decode_scope(
        self,
        token: str,
        method: str,
        path: str,
        correlation_id: str,
        *,
        allow_empty: bool = False,
        require_project: bool = True,
    ) -> dict[str, str]:
        decoded = decode_b64url(token)
        if not isinstance(decoded, Mapping):
            raise self._reject(
                "malformed_scope",
                "X-PF-Scope must be a base64url object with companyRef and projectRef",
                method=method,
                path=path,
                correlation_id=correlation_id,
            )
        company = decoded.get("companyRef")
        project = decoded.get("projectRef")
        if company is None and project is None and allow_empty:
            # An instance-scoped caller sends an empty object, or omits the header entirely.
            # Both are legitimate; the object is still part of the signed canonical request.
            return {}
        if not isinstance(company, str) or not company.strip():
            raise self._reject(
                "malformed_scope",
                "X-PF-Scope must carry a non-empty companyRef",
                method=method,
                path=path,
                correlation_id=correlation_id,
            )
        if require_project and (not isinstance(project, str) or not project.strip()):
            raise self._reject(
                "malformed_scope",
                "X-PF-Scope must carry a non-empty projectRef",
                method=method,
                path=path,
                correlation_id=correlation_id,
            )
        return {"companyRef": company, "projectRef": project}

    def _assert_human_is_trusted(self, actor: ActorAssertion, issuer: str) -> None:
        """A ``human`` assertion is only meaningful from the configured issuer.

        The issuer check already ran, so in practice this cannot fire; it is kept as an
        explicit, separately testable statement of the rule rather than as a comment,
        because it is the control AT-13 is about.
        """
        if actor.actor_type == "human" and not hmac.compare_digest(issuer, self._issuer):
            raise self._reject(
                "untrusted_human_assertion",
                "a human actor assertion is only accepted from the configured bridge issuer",
                method="",
                path="",
                actorId=actor.actor_id,
            )

    # -- rejection ------------------------------------------------------

    def _reject(
        self,
        reason: str,
        message: str,
        *,
        method: str = "",
        path: str = "",
        correlation_id: str = "",
        **details: Any,
    ) -> AuthFailure:
        """Log a security event and build the refusal.

        The log carries who tried, from where, and why it was refused - never the body and
        never the secret. Without it, "the boundary is enforced" is an unfalsifiable claim.
        """
        logger.warning(
            "security.auth.rejected",
            extra={
                "pf.event": "security.auth.rejected",
                "pf.reason": reason,
                "pf.method": method,
                "pf.path": path,
                "pf.correlationId": correlation_id,
                "pf.issuer": details.get("issuer", ""),
                "pf.actorId": details.get("actorId", ""),
                "pf.nonce": details.get("nonce", ""),
            },
        )
        return AuthFailure(reason, message, **details)
