"""The `/v1` route table, request/response records, and the matcher.

Responsibility: one hand-rolled table that is simultaneously the router's dispatch source and
the OpenAPI document's source. :data:`ENDPOINTS` is the only place a route is declared, so a
route cannot exist without being documented or be documented without being served.

Invariants:

* **Table first, regex second.** :class:`Endpoint` compiles its own pattern; a path that does
  not match any endpoint is ``404`` and a method that exists on a path but not for that method
  is ``405``. Both use the Core error vocabulary, with the status carried explicitly on the
  error so the code vocabulary and the HTTP status stay separately honest.
* **Path placeholders are typed.** ``{graphId}`` captures one non-empty segment that stops at
  ``/``. A placeholder never matches across a separator, so ``/runs//events`` cannot smuggle
  an empty id into a handler.
* **Handlers are named, not stored.** An :class:`Endpoint` holds the *name* of a
  ``RuntimeService`` method. That keeps the table importable by :mod:`openapi` without
  importing the service, and it makes a missing handler a loud ``AttributeError`` at dispatch
  rather than a silently unrouted request.
* **Every endpoint declares its failure codes.** The OpenAPI document reads them from here,
  so a documented status and a served status cannot disagree.
* **One unauthenticated route.** ``GET /v1/health/live`` only, because a container probe
  cannot sign and it reveals no tenant data. Everything else, including the full health
  report, is behind the signature.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any, Final, Mapping, Sequence
from urllib.parse import parse_qs, unquote, urlsplit

from polyforge.core import errors
from polyforge.core.errors import ErrorCode

__all__ = [
    "API_BASE",
    "API_BASE_PATH",
    "ENDPOINTS",
    "Endpoint",
    "Parameter",
    "Request",
    "Response",
    "Router",
    "ROUTER",
    "endpoint_paths",
    "parse_json_object",
    "signed_path",
]

#: Version prefix. Every route is declared relative to it, so the signature covers
#: ``/runs/x/commands`` rather than a path that a reverse proxy may have rewritten.
API_BASE: Final[str] = "/v1"
API_BASE_PATH: Final[str] = API_BASE

_PLACEHOLDER = re.compile(r"\{([A-Za-z][A-Za-z0-9_]*)\}")


def signed_path(target: str) -> str:
    """The path the signature covers: the request target relative to :data:`API_BASE`.

    **The query string is included.** A diff's ``from``/``to`` pair and an event cursor are
    answers, not decoration, so a signature that ignored them would let a captured request be
    re-pointed at different parameters while still verifying. The ``/v1`` prefix is excluded so
    the signed string is stable across a deployment that mounts the service under a different
    prefix or behind a proxy that rewrites it.

    Exposed as a function so a test, a bridge, and the verifier all have one definition.
    """
    split = urlsplit(target)
    path = split.path
    if path.startswith(API_BASE_PATH):
        path = path[len(API_BASE_PATH) :] or "/"
    if not path.startswith("/"):
        path = "/" + path
    return f"{path}?{split.query}" if split.query else path


def parse_json_object(raw_body: bytes) -> dict[str, Any]:
    """Parse a request body as a JSON object, with the Core's error vocabulary.

    An empty body is an empty object: ``POST /runs/{id}/migrations/plan`` and the other
    no-field commands are legitimately empty, and demanding ``{}`` from a bridge that sends no
    body would be a protocol detail with no security value.
    """
    if not raw_body.strip():
        return {}
    try:
        value = json.loads(raw_body.decode("utf-8"))
    except UnicodeDecodeError as exc:
        raise errors.bad_request("the request body is not valid UTF-8") from exc
    except json.JSONDecodeError as exc:
        raise errors.bad_request("the request body is not valid JSON", position=exc.pos) from exc
    if not isinstance(value, dict):
        raise errors.bad_request(
            "the request body must be a JSON object", received=type(value).__name__
        )
    return value


@dataclass(frozen=True, slots=True)
class Parameter:
    """One OpenAPI parameter. Declared once, rendered by the router's docs and its handler."""

    name: str
    location: str  # "path" | "query" | "header"
    required: bool = False
    schema_type: str = "string"
    description: str = ""
    default: str | None = None

    def to_openapi(self) -> dict[str, Any]:
        body: dict[str, Any] = {
            "name": self.name,
            "in": self.location,
            "required": bool(self.required),
            "description": self.description,
            "schema": {"type": self.schema_type},
        }
        if self.default is not None:
            body["schema"]["default"] = self.default
        return body


@dataclass(frozen=True, slots=True)
class Endpoint:
    """One served route.

    ``success_status`` is the status the handler returns on the happy path. ``failure_codes``
    are Core :class:`~polyforge.core.errors.ErrorCode` values; the transport maps each to a
    status through ``ERROR_STATUS`` and the document lists the same mapping.
    """

    method: str
    path: str
    name: str
    summary: str
    tag: str
    success_status: int
    failure_codes: tuple[str, ...] = ()
    parameters: tuple[Parameter, ...] = ()
    request_schema: str | None = None
    response_schema: str | None = None
    response_description: str = ""
    authenticated: bool = True
    #: An instance-scoped route answers a question about the deployment, not about a tenant, so
    #: its caller is not required to name a company. The signature is still fully required; only
    #: the scope header is optional, and a scope that *is* sent is still parsed and still signed.
    instance_scope: bool = False
    #: A route that has no project to name, so its scope header may carry a company without a
    #: project. Only the *liveness* probe qualifies: it reports whether the deployment's Core is
    #: reachable and which versions it speaks, and reads no project data. Demanding a project
    #: identity here would only invite a caller to fabricate one inside a signed scope.
    #: ``companyRef`` stays mandatory, because the probe does report company wiring.
    projectless_scope: bool = False
    required_roles: frozenset[str] = field(default_factory=frozenset)
    required_capabilities: frozenset[str] = field(default_factory=frozenset)
    if_match: bool = False

    @property
    def full_path(self) -> str:
        return f"{API_BASE}{self.path}"

    def pattern(self) -> re.Pattern[str]:
        """Compile (and cache) the path matcher for this endpoint."""
        cached = _PATTERN_CACHE.get(self.path)
        if cached is not None:
            return cached
        parts: list[str] = []
        index = 0
        for match in _PLACEHOLDER.finditer(self.path):
            parts.append(re.escape(self.path[index : match.start()]))
            parts.append(f"(?P<{match.group(1)}>[^/]+)")
            index = match.end()
        parts.append(re.escape(self.path[index:]))
        compiled = re.compile("^" + "".join(parts) + "$")
        _PATTERN_CACHE[self.path] = compiled
        return compiled

    def match(self, path: str) -> dict[str, str] | None:
        found = self.pattern().match(path)
        if found is None:
            return None
        return {key: unquote(value) for key, value in found.groupdict().items()}


_PATTERN_CACHE: dict[str, re.Pattern[str]] = {}


@dataclass(frozen=True, slots=True)
class Request:
    """One inbound request, already parsed and bounded.

    ``raw_body`` is kept as bytes and never re-encoded: the signature covers the exact bytes
    received, and a body that was parsed and re-serialised would hash differently and fail
    verification for reasons that are very hard to debug.

    Three views of the target, and they are not interchangeable:

    * ``path`` - the raw request target, base prefix and query included.
    * ``route_path`` - base prefix removed, query removed. This is what the router matches.
    * ``signed_path`` - base prefix removed, query *kept*. This is what gets signed.
    """

    method: str
    path: str
    route_path: str
    signed_path: str
    query: Mapping[str, list[str]]
    headers: Mapping[str, str]
    raw_body: bytes
    correlation_id: str = ""
    peer: str = ""

    @staticmethod
    def build(
        method: str,
        target: str,
        headers: Mapping[str, str],
        raw_body: bytes,
        *,
        correlation_id: str = "",
        peer: str = "",
    ) -> "Request":
        split = urlsplit(target)
        relative = signed_path(target)
        route_path = relative.split("?", 1)[0]
        return Request(
            method=method.upper(),
            path=target,
            route_path=route_path,
            signed_path=relative,
            query=parse_qs(split.query, keep_blank_values=True),
            headers={str(k).lower(): str(v) for k, v in headers.items()},
            raw_body=raw_body,
            correlation_id=correlation_id,
            peer=peer,
        )

    def header(self, name: str) -> str | None:
        return self.headers.get(name.lower())

    def query_one(self, name: str, default: str | None = None) -> str | None:
        values = self.query.get(name)
        if not values:
            return default
        return values[0]

    def query_int(
        self, name: str, default: int, *, minimum: int = 0, maximum: int | None = None
    ) -> int:
        """A query integer, with a *floor* that is refused and a *ceiling* that is clamped.

        The asymmetry is deliberate. ``limit=-1`` is a caller mistake worth reporting, because
        silently treating it as the default hides a broken client. ``limit=100000`` is a caller
        asking for everything, and answering "here is at most 1000" is what a well-behaved API
        does; refusing it would only make clients compute the cap themselves.
        """
        raw = self.query_one(name)
        if raw is None or raw == "":
            return default
        try:
            value = int(raw)
        except ValueError as exc:
            raise errors.bad_request(f"query parameter {name!r} must be an integer", **{name: raw}) from exc
        if value < minimum:
            raise errors.bad_request(
                f"query parameter {name!r} must be >= {minimum}", **{name: value}
            )
        if maximum is not None and value > maximum:
            return maximum
        return value

    def query_optional_int(self, name: str) -> int | None:
        raw = self.query_one(name)
        if raw is None or raw == "":
            return None
        try:
            return int(raw)
        except ValueError as exc:
            raise errors.bad_request(f"query parameter {name!r} must be an integer", **{name: raw}) from exc

    def if_match_revision(self) -> int:
        """The ``If-Match`` revision, or a 400.

        Missing ``If-Match`` on a compare-and-swap route is a ``400`` rather than a ``428``:
        the protocol's failure vocabulary is the Core's, and a caller that omits the
        precondition has sent a request that cannot be answered, not a request that failed
        validation.
        """
        raw = self.header("If-Match")
        if raw is None or not raw.strip():
            raise errors.bad_request(
                'If-Match: "<revision>" is required; the draft revision is the concurrency token',
                header="If-Match",
            )
        text = raw.strip()
        if text.startswith("W/"):
            text = text[2:].strip()
        text = text.strip('"')
        try:
            return int(text)
        except ValueError as exc:
            raise errors.bad_request(
                'If-Match must be a quoted integer draft revision', header="If-Match", value=raw
            ) from exc

    def json_object(self) -> dict[str, Any]:
        """Parse the body as a JSON object.

        No memoisation: ``Request`` is frozen, and a parse cache would either need mutable
        state on an immutable record or a side table. The body is small and parsed once per
        request in the normal path, so the cost is not worth the state.
        """
        return parse_json_object(self.raw_body)


@dataclass(frozen=True, slots=True)
class Response:
    """One outbound response. ``extra_headers`` is an immutable tuple so a handler cannot
    mutate a shared mapping, and the body is bytes because that is what goes on the wire."""

    status: int
    body: bytes = b""
    headers: tuple[tuple[str, str], ...] = ()
    content_type: str = "application/json"

    @staticmethod
    def json_body(status: int, payload: Any, headers: Sequence[tuple[str, str]] = ()) -> "Response":
        from polyforge.core.hashing import canonical_bytes

        # Canonical bytes for every response, not just signed ones: it removes key-order
        # noise from diffs and makes a response reproducible in a test.
        return Response(
            status=status,
            body=canonical_bytes(payload),
            headers=tuple(headers),
            content_type="application/json; charset=utf-8",
        )

    def header_map(self) -> dict[str, str]:
        return {name: value for name, value in self.headers}


class Router:
    """Method-and-path dispatch over the :data:`ENDPOINTS` table."""

    __slots__ = ("_by_method", "_paths", "_templated")

    def __init__(self, endpoints: Sequence[Endpoint]) -> None:
        self._by_method: dict[str, list[Endpoint]] = {}
        self._paths: dict[str, list[Endpoint]] = {}
        templated: list[Endpoint] = []
        for endpoint in endpoints:
            self._by_method.setdefault(endpoint.method, []).append(endpoint)
            if "{" in endpoint.path:
                templated.append(endpoint)
            else:
                self._paths.setdefault(endpoint.path, []).append(endpoint)
        self._templated = templated

    def resolve(self, method: str, route_path: str) -> tuple[Endpoint, dict[str, str]]:
        """Find the endpoint, or raise ``404``/``405`` from the Core error vocabulary.

        A literal path is tried first, then the templated ones. The literal pass is an
        optimisation and a determinism guarantee: ``/health`` must never be shadowed by a
        pattern someone adds later.
        """
        for endpoint in self._paths.get(route_path, ()):
            if endpoint.method == method:
                params = endpoint.match(route_path)
                if params is not None:
                    return endpoint, params
        for endpoint in self._templated:
            if endpoint.method != method:
                continue
            params = endpoint.match(route_path)
            if params is not None:
                return endpoint, params
        allowed = sorted(
            {
                endpoint.method
                for endpoint in (*self._paths.get(route_path, ()), *self._templated)
                if endpoint.match(route_path) is not None
            }
        )
        if allowed:
            # Imported here rather than at module scope: ``errors`` builds its responses from
            # this module, so a top-level import would be a cycle. One definition of the 405
            # matters more than where the import sits.
            from polyforge.services.runtime_api.errors import method_not_allowed_error

            raise method_not_allowed_error(method, route_path, allowed)
        raise errors.not_found("no such route", path=route_path)

    def routes(self) -> list[tuple[str, str]]:
        return sorted(
            (endpoint.method, endpoint.path)
            for group in self._paths.values()
            for endpoint in group
        ) + sorted((endpoint.method, endpoint.path) for endpoint in self._templated)


# ----------------------------------------------------------------------
# The route table
# ----------------------------------------------------------------------

_GRAPH = Parameter("graphId", "path", True, "string", "Graph identity within the asserted scope.")
_DRAFT = Parameter("draftId", "path", True, "string", "Draft identity.")
_RUN = Parameter("runId", "path", True, "string", "GraphRun identity.")
_REQUEST = Parameter("requestId", "path", True, "string", "Governance request identity.")
_INTENT = Parameter("intentId", "path", True, "string", "Outbound intent identity.")

_AUTHOR_ROLES = frozenset({"polyforge.author", "polyforge.operator"})
_PUBLISHER_ROLES = frozenset({"polyforge.publisher", "polyforge.operator"})
_AUTHOR_CAPS = frozenset({"graph.author"})
_PUBLISHER_CAPS = frozenset({"graph.publish"})

#: Failure codes every authenticated route can produce, whatever it does. Auth first, then
#: body shape, then the handler; a route's own codes are added on top. ``UNSUPPORTED`` is here
#: because the Core refuses an operation whose port capability is missing from any entry point,
#: and "this deployment cannot do that" has to be discoverable from the document.
_COMMON: tuple[str, ...] = (
    ErrorCode.AUTHORIZATION_DENIED.value,
    ErrorCode.SCOPE_VIOLATION.value,
    ErrorCode.CONTRACT_INVALID.value,
    ErrorCode.BAD_REQUEST.value,
    ErrorCode.UNSUPPORTED.value,
    ErrorCode.INTERNAL.value,
)

#: Mutation routes additionally refuse an over-stale fence and a duplicated key with a
#: different payload, because those are the two answers a retrying bridge has to branch on.
_COMMON_MUTATION: tuple[str, ...] = _COMMON + (
    ErrorCode.IDEMPOTENCY_CONFLICT.value,
    ErrorCode.VERSION_CONFLICT.value,
    ErrorCode.NOT_FOUND.value,
)

ENDPOINTS: Final[tuple[Endpoint, ...]] = (
    # -- authoring ----------------------------------------------------
    Endpoint(
        method="GET",
        path="/graphs",
        name="list_graphs",
        summary="List the graphs that have a published version in the asserted scope",
        tag="authoring",
        success_status=200,
        failure_codes=_COMMON,
        response_description=(
            "Every graph with at least one published version in the caller's company and project, "
            "each with its active version and version count. A graph that exists only as a draft is "
            "not listed: the library is what can be run."
        ),
    ),
    Endpoint(
        method="POST",
        path="/graphs/{graphId}/drafts",
        name="create_draft",
        summary="Create a draft of a graph in the asserted scope",
        tag="authoring",
        success_status=201,
        failure_codes=_COMMON_MUTATION,
        parameters=(_GRAPH,),
        request_schema="CreateDraftRequest",
        response_schema="DraftView",
        required_roles=_AUTHOR_ROLES,
        required_capabilities=_AUTHOR_CAPS,
        response_description="The new draft, with its revision and current definition.",
    ),
    Endpoint(
        method="GET",
        path="/graphs/{graphId}/drafts",
        name="list_drafts",
        summary="List the drafts of one graph in the asserted scope",
        tag="authoring",
        success_status=200,
        failure_codes=_COMMON,
        parameters=(_GRAPH,),
        response_schema="DraftSummaryList",
        response_description="Draft summaries, oldest first.",
    ),
    Endpoint(
        method="GET",
        path="/drafts/{draftId}",
        name="get_draft",
        summary="Read one draft and its current definition",
        tag="authoring",
        success_status=200,
        failure_codes=_COMMON,
        parameters=(_DRAFT,),
        response_schema="DraftView",
        response_description="The draft, its definition, and the recorded validation/compile state.",
    ),
    Endpoint(
        method="PATCH",
        path="/drafts/{draftId}",
        name="save_draft",
        summary="Replace a draft definition under If-Match compare-and-swap",
        tag="authoring",
        success_status=200,
        failure_codes=_COMMON_MUTATION,
        parameters=(_DRAFT,),
        request_schema="SaveDraftRequest",
        response_schema="DraftView",
        if_match=True,
        required_roles=_AUTHOR_ROLES,
        required_capabilities=_AUTHOR_CAPS,
        response_description=(
            "The bumped draft. A stale If-Match is 409 VERSION_CONFLICT carrying currentVersion."
        ),
    ),
    Endpoint(
        method="DELETE",
        path="/drafts/{draftId}",
        name="delete_draft",
        summary="Delete an unpublished draft",
        tag="authoring",
        success_status=204,
        failure_codes=_COMMON_MUTATION,
        parameters=(_DRAFT,),
        required_roles=_AUTHOR_ROLES,
        required_capabilities=_AUTHOR_CAPS,
        response_description="No body. Refused once a published version references the draft.",
    ),
    Endpoint(
        method="POST",
        path="/drafts/{draftId}/validate",
        name="validate_draft",
        summary="Validate the current draft revision",
        tag="authoring",
        success_status=200,
        failure_codes=_COMMON_MUTATION,
        parameters=(_DRAFT,),
        response_schema="ValidationReport",
        required_roles=_AUTHOR_ROLES,
        required_capabilities=_AUTHOR_CAPS,
        response_description="A ValidationReport bound to the current revision and definition hash.",
    ),
    Endpoint(
        method="POST",
        path="/drafts/{draftId}/compile",
        name="compile_draft",
        summary="Compile the current draft revision against the shipped dependency lock",
        tag="authoring",
        success_status=200,
        failure_codes=_COMMON_MUTATION,
        parameters=(_DRAFT,),
        request_schema="CompileDraftRequest",
        response_schema="CompileArtifact",
        required_roles=_AUTHOR_ROLES,
        required_capabilities=_AUTHOR_CAPS,
        response_description="A CompileArtifact; deterministic for the same definition and lock.",
    ),
    Endpoint(
        method="POST",
        path="/drafts/{draftId}/reviews",
        name="record_draft_review",
        summary="Record a human review of one exact target hash on the current revision",
        tag="authoring",
        success_status=200,
        failure_codes=_COMMON_MUTATION,
        parameters=(_DRAFT,),
        request_schema="RecordReviewRequest",
        response_schema="DraftView",
        required_roles=_AUTHOR_ROLES,
        required_capabilities=_AUTHOR_CAPS,
        response_description=(
            "The draft with the review bound. The reviewer is the asserted actor, never a body "
            "field, and may not be the draft's author."
        ),
    ),
    Endpoint(
        method="POST",
        path="/drafts/{draftId}/publish",
        name="publish_draft",
        summary="Publish an immutable graph version from a reviewed draft",
        tag="authoring",
        success_status=201,
        failure_codes=_COMMON_MUTATION,
        parameters=(_DRAFT,),
        request_schema="PublishRequest",
        response_schema="GraphVersionView",
        required_roles=_PUBLISHER_ROLES,
        required_capabilities=_PUBLISHER_CAPS,
        response_description=(
            "The published version. The compare-and-swap covers revision, definitionHash, "
            "compilerVersion, planHash and reviewTargetHash."
        ),
    ),
    Endpoint(
        method="GET",
        path="/graphs/{graphId}/versions",
        name="list_versions",
        summary="List the published versions of one graph",
        tag="authoring",
        success_status=200,
        failure_codes=_COMMON,
        parameters=(_GRAPH,),
        response_schema="GraphVersionSummaryList",
        response_description="Published versions with their retirement state.",
    ),
    Endpoint(
        method="GET",
        path="/graphs/{graphId}/versions/{version}",
        name="get_version",
        summary="Read one published version, including its definition",
        tag="authoring",
        success_status=200,
        failure_codes=_COMMON,
        parameters=(
            _GRAPH,
            Parameter("version", "path", True, "integer", "Published version number."),
        ),
        response_schema="GraphVersionView",
        response_description="One immutable version.",
    ),
    Endpoint(
        method="POST",
        path="/graphs/{graphId}/activate",
        name="activate_version",
        summary="Point future admissions at a version",
        tag="authoring",
        success_status=200,
        failure_codes=_COMMON_MUTATION,
        parameters=(_GRAPH,),
        request_schema="ActivateRequest",
        response_schema="DefaultPointer",
        required_roles=_PUBLISHER_ROLES,
        required_capabilities=_PUBLISHER_CAPS,
        response_description=(
            "The bumped default pointer. Independent CAS on its own generation counter; an "
            "existing run keeps the pins it was admitted with."
        ),
    ),
    Endpoint(
        method="GET",
        path="/graphs/{graphId}/diff",
        name="diff_versions",
        summary="Semantic diff between two published versions",
        tag="authoring",
        success_status=200,
        failure_codes=_COMMON,
        parameters=(
            _GRAPH,
            Parameter("from", "query", False, "integer", "Source version, omitted for the empty graph."),
            Parameter("to", "query", True, "integer", "Target version."),
        ),
        response_schema="SemanticDiff",
        response_description="A SemanticDiff; the query string is covered by the signature.",
    ),
    # -- execution ----------------------------------------------------
    Endpoint(
        method="POST",
        path="/work-orders",
        name="admit_work_order",
        summary="Admit one work order and create its pinned GraphRun",
        tag="execution",
        success_status=201,
        failure_codes=_COMMON_MUTATION + (ErrorCode.RUN_BLOCKED.value,),
        request_schema="CreateWorkOrderRequest",
        response_schema="RunSnapshot",
        response_description=(
            "The authoritative run snapshot. Idempotent on scope + startIntentId + entrypoint."
        ),
    ),
    Endpoint(
        method="GET",
        path="/runs",
        name="list_runs",
        summary="List runs in the asserted scope",
        tag="execution",
        success_status=200,
        failure_codes=_COMMON,
        parameters=(
            Parameter("graphId", "query", False, "string", "Filter by graph identity."),
            Parameter("status", "query", False, "string", "Filter by GraphRun status."),
            Parameter("limit", "query", False, "integer", "Maximum rows, default 50.", "50"),
        ),
        response_schema="RunSnapshotList",
        response_description="Run summaries, newest first.",
    ),
    Endpoint(
        method="GET",
        path="/runs/{runId}",
        name="get_run",
        summary="Read the authoritative run snapshot",
        tag="execution",
        success_status=200,
        failure_codes=_COMMON,
        parameters=(_RUN,),
        response_schema="RunSnapshot",
        response_description=(
            "A RunSnapshot with stateVersion and eventSequence. A run in another scope is "
            "403 SCOPE_VIOLATION, never a 404 that confirms it exists."
        ),
    ),
    Endpoint(
        method="GET",
        path="/runs/{runId}/events",
        name="list_events",
        summary="Read persisted domain events after a cursor",
        tag="execution",
        success_status=200,
        failure_codes=_COMMON,
        parameters=(
            _RUN,
            Parameter("after", "query", False, "integer", "Exclusive seq cursor, default 0.", "0"),
            Parameter("limit", "query", False, "integer", "Maximum events, default 200.", "200"),
        ),
        response_schema="DomainEventPage",
        response_description="Events in strictly increasing seq order, with the run's eventSequence.",
    ),
    Endpoint(
        method="GET",
        path="/runs/{runId}/current",
        name="current_contract",
        summary="Current contract, inputs and permitted actions for the asserted actor",
        tag="execution",
        success_status=200,
        failure_codes=_COMMON + (ErrorCode.LEASE_FENCED.value,),
        parameters=(
            _RUN,
            Parameter("nodeId", "query", False, "string", "Node to inspect; defaults to the current one."),
        ),
        response_schema="CurrentView",
        response_description="The pinned contract and what this attempt may do next. Read only.",
    ),
    Endpoint(
        method="POST",
        path="/runs/{runId}/claims",
        name="claim_node",
        summary="Bind a platform agent run to an attempt, establishing the lease fence",
        tag="execution",
        success_status=200,
        failure_codes=_COMMON_MUTATION + (ErrorCode.LEASE_FENCED.value,),
        parameters=(_RUN,),
        request_schema="ClaimRequest",
        response_schema="AttemptView",
        response_description="The attempt with its lease epoch. A stale epoch is 409 LEASE_FENCED.",
    ),
    Endpoint(
        method="POST",
        path="/runs/{runId}/artifacts",
        name="submit_artifacts",
        summary="Register fixed artifact references, create-or-verify",
        tag="execution",
        success_status=200,
        failure_codes=_COMMON_MUTATION
        + (ErrorCode.LEASE_FENCED.value, ErrorCode.EVIDENCE_INVALID.value, ErrorCode.GATE_PENDING.value),
        parameters=(_RUN,),
        request_schema="SubmitArtifactRequest",
        response_schema="CommandResult",
        response_description="The command envelope; resultRef carries the artifact ids.",
    ),
    Endpoint(
        method="POST",
        path="/runs/{runId}/evidence",
        name="submit_evidence",
        summary="Ingest and verify evidence candidates",
        tag="execution",
        success_status=200,
        failure_codes=_COMMON_MUTATION
        + (ErrorCode.LEASE_FENCED.value, ErrorCode.EVIDENCE_INVALID.value, ErrorCode.GATE_PENDING.value),
        parameters=(_RUN,),
        request_schema="SubmitEvidenceRequest",
        response_schema="CommandResult",
        response_description="The command envelope; resultRef carries the evidence ids.",
    ),
    Endpoint(
        method="POST",
        path="/runs/{runId}/transitions",
        name="request_transition",
        summary="Request evaluation of a node transition",
        tag="execution",
        success_status=200,
        failure_codes=_COMMON_MUTATION
        + (
            ErrorCode.LEASE_FENCED.value,
            ErrorCode.EVIDENCE_INVALID.value,
            ErrorCode.GATE_PENDING.value,
            ErrorCode.RUN_BLOCKED.value,
        ),
        parameters=(_RUN,),
        request_schema="RequestTransitionRequest",
        response_schema="CommandResult",
        response_description=(
            "The command envelope. 200 with applied=true when every mandatory evaluator passed; "
            "202 GATE_PENDING when the command was recorded and its effect waits on a human."
        ),
    ),
    Endpoint(
        method="POST",
        path="/runs/{runId}/help",
        name="request_help",
        summary="Record a durable clarification, review, or human-handling intent",
        tag="execution",
        success_status=202,
        failure_codes=_COMMON_MUTATION + (ErrorCode.LEASE_FENCED.value,),
        parameters=(_RUN,),
        request_schema="RequestHelpRequest",
        response_schema="CommandResult",
        response_description="202 with the command envelope; the request is recorded, not satisfied.",
    ),
    Endpoint(
        method="POST",
        path="/runs/{runId}/commands",
        name="run_command",
        summary="pause / resume / cancel / retry / resolve_block",
        tag="execution",
        success_status=200,
        failure_codes=_COMMON_MUTATION + (ErrorCode.RUN_BLOCKED.value,),
        parameters=(_RUN,),
        request_schema="RunCommandRequest",
        response_schema="CommandResult",
        response_description=(
            "The command envelope. The capability check runs server side against the actor's "
            "granted bindings, never against a body field."
        ),
    ),
    Endpoint(
        method="POST",
        path="/runs/{runId}/migrations/plan",
        name="plan_migration",
        summary="Compute a successor-run migration preview. A dry run.",
        tag="execution",
        success_status=200,
        failure_codes=_COMMON_MUTATION + (ErrorCode.RUN_BLOCKED.value,),
        parameters=(_RUN,),
        request_schema="MigrationPlanRequest",
        response_schema="MigrationPreview",
        response_description="A MigrationPreview with its planHash and blockers. Nothing is written.",
    ),
    Endpoint(
        method="POST",
        path="/runs/{runId}/migrations/commit",
        name="commit_migration",
        summary="Commit an approved migration plan",
        tag="execution",
        success_status=200,
        failure_codes=_COMMON_MUTATION
        + (ErrorCode.RUN_BLOCKED.value, ErrorCode.LEASE_FENCED.value, ErrorCode.GATE_PENDING.value),
        parameters=(_RUN,),
        request_schema="MigrationCommitRequest",
        response_schema="MigrationCommitResult",
        response_description=(
            "The frozen source and its successor. Compare-and-swap on stateVersion, fenced on "
            "planHash; the source becomes SUPERSEDED, never deleted."
        ),
    ),
    Endpoint(
        method="POST",
        path="/runs/{runId}/governance/{requestId}/resolution",
        name="record_governance_resolution",
        summary="Record a bridge-verified resolution of a governance request",
        tag="execution",
        success_status=200,
        failure_codes=_COMMON_MUTATION + (ErrorCode.RUN_BLOCKED.value,),
        parameters=(_RUN, _REQUEST),
        request_schema="GovernanceResolutionRequest",
        response_schema="CommandResult",
        response_description=(
            "The re-evaluated command envelope. The answer is archived as evidence about an exact "
            "decisionTargetHash; it is never applied to a node directly."
        ),
    ),
    Endpoint(
        method="GET",
        path="/runs/{runId}/refusals",
        name="list_refusals",
        summary="Read the isolated diagnostic record of writes this run refused",
        tag="execution",
        success_status=200,
        failure_codes=_COMMON,
        parameters=(_RUN,),
        response_schema="RefusalList",
        response_description="Refused writes with their code and reason. Never state.",
    ),
    # -- operations ----------------------------------------------------
    Endpoint(
        method="GET",
        path="/health",
        name="health",
        summary="Health and readiness report",
        tag="ops",
        success_status=200,
        failure_codes=(ErrorCode.INTERNAL.value,),
        instance_scope=True,
        projectless_scope=True,
        response_schema="HealthReport",
        response_description=(
            "ready | read_only | degraded | blocked, with the database, store and bridge facts "
            "behind that answer. Instance-scoped: the report is about the deployment, so a probe "
            "is not asked to name a tenant it knows nothing about. It also has no project to name, "
            "so a probe may send a company without a project; companyRef is still required because "
            "the report includes company wiring."
        ),
    ),
    Endpoint(
        method="GET",
        path="/health/live",
        name="health_live",
        summary="Liveness probe. The one unauthenticated route.",
        tag="ops",
        success_status=200,
        failure_codes=(ErrorCode.INTERNAL.value,),
        response_schema="LivenessReport",
        authenticated=False,
        instance_scope=True,
        response_description="Process liveness only. Touches no tenant data.",
    ),
    Endpoint(
        method="GET",
        path="/health/ready",
        name="health_ready",
        summary="Readiness probe with a status code a load balancer can act on",
        tag="ops",
        success_status=200,
        failure_codes=(ErrorCode.INTERNAL.value, ErrorCode.CONTROL_PLANE_UNAVAILABLE.value),
        instance_scope=True,
        response_schema="HealthReport",
        response_description=(
            "200 for ready and degraded, 503 for read_only and blocked, with the same report "
            "body as /health."
        ),
    ),
    Endpoint(
        method="POST",
        path="/recover",
        name="recover",
        summary="Run crash reconciliation. Operator only.",
        tag="ops",
        success_status=200,
        failure_codes=_COMMON_MUTATION,
        request_schema="RecoverRequest",
        response_schema="RecoveryReport",
        instance_scope=True,
        required_roles=frozenset({"polyforge.operator"}),
        required_capabilities=frozenset({"runtime.recover"}),
        response_description=(
            "A RecoveryReport. Idempotent: running it twice changes nothing the second time."
        ),
    ),
    Endpoint(
        method="POST",
        path="/events",
        name="intake_event",
        summary="Ingest one normalized pf.* observation from the bridge",
        tag="ops",
        success_status=202,
        failure_codes=_COMMON_MUTATION,
        request_schema="IntakeEventRequest",
        response_schema="IntakeResult",
        response_description=(
            "The intake outcome. An unknown schema is quarantined and reported, and a duplicate "
            "or out-of-order event is recorded as lag. Neither can mark a node passed."
        ),
    ),
    Endpoint(
        method="GET",
        path="/bridge/outbox",
        name="bridge_outbox",
        summary="Claim queued outbound intents for delivery",
        tag="bridge",
        success_status=200,
        failure_codes=_COMMON,
        parameters=(
            Parameter("limit", "query", False, "integer", "Maximum intents to claim, default 50.", "50"),
        ),
        response_schema="OutboxBatch",
        response_description=(
            "Claimed intents for the asserted scope. A claim is a lease: an intent not "
            "acknowledged before it expires becomes claimable again."
        ),
    ),
    Endpoint(
        method="POST",
        path="/bridge/outbox/{intentId}/delivery",
        name="bridge_outbox_delivery",
        summary="Acknowledge the outcome of one delivery attempt",
        tag="bridge",
        success_status=200,
        failure_codes=_COMMON_MUTATION,
        parameters=(_INTENT,),
        request_schema="DeliveryReportRequest",
        response_schema="DeliveryReport",
        response_description=(
            "The recorded delivery state. ambiguous_create is first class: the object is looked "
            "up by its correlation key, never blindly re-sent."
        ),
    ),
    # -- documentation -------------------------------------------------
    Endpoint(
        method="GET",
        path="/openapi.json",
        name="openapi",
        summary="The OpenAPI 3.1 description of this surface",
        tag="ops",
        success_status=200,
        failure_codes=(ErrorCode.INTERNAL.value,),
        response_schema="OpenApiDocument",
        response_description="Derived from the same table the router dispatches on.",
    ),
)

ROUTER: Final[Router] = Router(ENDPOINTS)


def endpoint_paths() -> tuple[str, ...]:
    """``METHOD /path`` for every served route. Used by the parity test and the docs."""
    return tuple(sorted(f"{endpoint.method} {endpoint.path}" for endpoint in ENDPOINTS))
