"""Error-to-response mapping for the `/v1` surface.

Responsibility: turn anything that went wrong into exactly one response shape, and make sure
a caller can always act on it.

Invariants:

* **One error vocabulary.** A failure is always
  ``{"error": {"code", "message", "details?", "pendingReason?"}}`` with the status
  ``polyforge.core.errors.ERROR_STATUS`` maps the code to. The bridge branches on ``code``, so
  inventing a second spelling would make every retry decision a guess.
* **An unexpected exception is a 500 with a correlation id and nothing else.** The type name,
  the message, and the traceback go to the log; none of them reach the wire. A 500 whose body
  says ``KeyError: 'plan_hash'`` tells an attacker about the internals and tells an operator
  nothing they can act on, because they cannot find that log line.
* **A retry decision is derivable.** :func:`retry_hint` exposes the Core's
  ``retry_disposition`` so the bridge does not have to re-derive it from the code.
* **Statuses that ``ERROR_STATUS`` cannot express are stated explicitly.** ``405``, ``413``
  and ``415`` are HTTP facts about this surface rather than Core error classes, so they are
  carried on the error's own ``status`` and named here instead of being forced into a code
  that means something else.
"""

from __future__ import annotations

import logging
from typing import Any, Final, Mapping, Sequence

from polyforge.core.errors import ERROR_STATUS, ErrorCode, PolyForgeError, retry_disposition
from polyforge.core.hashing import canonical_bytes

__all__ = [
    "CORRELATION_HEADER",
    "INTERNAL_DETAIL_LOGGED",
    "error_body",
    "internal_error",
    "method_not_allowed_error",
    "payload_too_large_error",
    "response_for",
    "retry_hint",
    "unsupported_media_type_error",
]

logger = logging.getLogger("polyforge.runtime_api.errors")

#: Present on every response. Echoed from the request when the caller supplied one, so a
#: bridge can join its own log to the Runtime's without a second round trip.
CORRELATION_HEADER: Final[str] = "X-PF-Correlation-Id"

#: The only thing an unexpected failure puts in the body. Deliberately constant: a 500 that
#: varies with the cause is a 500 that leaks.
INTERNAL_DETAIL_LOGGED: Final[str] = (
    "the failure was recorded against this correlation id; retry or reconcile, and quote the id"
)


def _response(
    status: int,
    body: Mapping[str, Any],
    correlation_id: str,
    extra_headers: Sequence[tuple[str, str]] = (),
) -> Any:
    from polyforge.services.runtime_api.router import Response

    return Response(
        status=status,
        body=canonical_bytes(body),
        headers=((CORRELATION_HEADER, correlation_id),) + tuple(extra_headers),
        content_type="application/json; charset=utf-8",
    )


def error_body(exc: PolyForgeError) -> dict[str, Any]:
    """The wire body for a refusal, from the Core's own serialiser."""
    return exc.to_body()


def retry_hint(exc: PolyForgeError) -> str:
    return str(retry_disposition(exc.code))


def response_for(exc: PolyForgeError, correlation_id: str) -> Any:
    """Map a :class:`PolyForgeError` to its response.

    ``exc.status`` wins over ``ERROR_STATUS`` because a few statuses are about this surface
    (``405``) rather than about the Core's error classes; everything else is the Core's table.
    """
    status = exc.status or ERROR_STATUS.get(exc.code, 500)
    headers: list[tuple[str, str]] = []
    disposition = retry_disposition(exc.code)
    if disposition.value == "reconcile_required":
        # Retry-After for the codes that mean "the other plane is not answering yet". A caller
        # that retries a 503 immediately is how a control plane gets knocked over by its own
        # clients; a caller that never retries an unrefusable code gets nothing either way.
        headers.append(("Retry-After", "5"))
    return _response(status, error_body(exc), correlation_id, tuple(headers))


def internal_error(correlation_id: str, *, exc: BaseException) -> Any:
    """A 500 that describes nothing and identifies everything."""
    logger.error(
        "request.unhandled_exception",
        extra={
            "pf.event": "request.unhandled_exception",
            "pf.correlationId": correlation_id,
            "pf.exceptionType": type(exc).__name__,
        },
        exc_info=(type(exc), exc, exc.__traceback__),
    )
    return _response(
        500,
        {
            "error": {
                "code": ErrorCode.INTERNAL.value,
                "message": INTERNAL_DETAIL_LOGGED,
                "details": {"correlationId": correlation_id},
            }
        },
        correlation_id,
    )


def method_not_allowed_error(method: str, path: str, allowed: Sequence[str]) -> PolyForgeError:
    """405. The Core has no code for "wrong verb on a real path", so one is named here."""
    return PolyForgeError(
        ErrorCode.UNSUPPORTED,
        f"{method} is not served on {path}",
        details={"allowed": sorted(allowed), "path": path, "method": method},
        status=405,
    )


def payload_too_large_error(limit: int, presented: int) -> PolyForgeError:
    """413. Refusing early beats buffering an unbounded body into the Core's memory."""
    return PolyForgeError(
        ErrorCode.BAD_REQUEST,
        f"the request body exceeds the {limit} byte limit",
        details={"limitBytes": limit, "receivedBytes": presented},
        status=413,
    )


def unsupported_media_type_error(content_type: str) -> PolyForgeError:
    return PolyForgeError(
        ErrorCode.BAD_REQUEST,
        "the request Content-Type must be application/json",
        details={"contentType": content_type},
        status=415,
    )
