"""Runtime Service error contract.

Every non-2xx response carries a stable code so the bridge can decide between retry,
reconcile, and block. A free-text 500 is not an acceptable answer for a mutation the
bridge intends to retry, because a retried create can duplicate an external effect.

Mirrors ``packages/protocol/src/errors.ts``.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Any, Final

__all__ = [
    "ERROR_CODES",
    "ERROR_STATUS",
    "ErrorCode",
    "PolyForgeError",
    "RetryDisposition",
    "retry_disposition",
]


class ErrorCode(StrEnum):
    IDEMPOTENCY_CONFLICT = "IDEMPOTENCY_CONFLICT"
    VERSION_CONFLICT = "VERSION_CONFLICT"
    AUTHORIZATION_DENIED = "AUTHORIZATION_DENIED"
    CONTRACT_INVALID = "CONTRACT_INVALID"
    RUN_BLOCKED = "RUN_BLOCKED"
    CONTROL_PLANE_UNAVAILABLE = "CONTROL_PLANE_UNAVAILABLE"
    SCOPE_VIOLATION = "SCOPE_VIOLATION"
    LEASE_FENCED = "LEASE_FENCED"
    NOT_FOUND = "NOT_FOUND"
    BAD_REQUEST = "BAD_REQUEST"
    UNSUPPORTED = "UNSUPPORTED"
    EVIDENCE_INVALID = "EVIDENCE_INVALID"
    GATE_PENDING = "GATE_PENDING"
    INTERNAL = "INTERNAL"


class RetryDisposition(StrEnum):
    SAFE = "safe"
    RECONCILE_REQUIRED = "reconcile_required"
    DO_NOT_RETRY = "do_not_retry"


ERROR_STATUS: Final[dict[ErrorCode, int]] = {
    ErrorCode.BAD_REQUEST: 400,
    ErrorCode.NOT_FOUND: 404,
    ErrorCode.AUTHORIZATION_DENIED: 403,
    ErrorCode.SCOPE_VIOLATION: 403,
    ErrorCode.UNSUPPORTED: 501,
    ErrorCode.IDEMPOTENCY_CONFLICT: 409,
    ErrorCode.VERSION_CONFLICT: 409,
    ErrorCode.LEASE_FENCED: 409,
    ErrorCode.CONTRACT_INVALID: 422,
    ErrorCode.EVIDENCE_INVALID: 422,
    ErrorCode.GATE_PENDING: 202,
    ErrorCode.RUN_BLOCKED: 423,
    ErrorCode.CONTROL_PLANE_UNAVAILABLE: 503,
    ErrorCode.INTERNAL: 500,
}

_DISPOSITION: Final[dict[ErrorCode, RetryDisposition]] = {
    ErrorCode.BAD_REQUEST: RetryDisposition.DO_NOT_RETRY,
    ErrorCode.NOT_FOUND: RetryDisposition.DO_NOT_RETRY,
    ErrorCode.AUTHORIZATION_DENIED: RetryDisposition.DO_NOT_RETRY,
    ErrorCode.SCOPE_VIOLATION: RetryDisposition.DO_NOT_RETRY,
    ErrorCode.UNSUPPORTED: RetryDisposition.DO_NOT_RETRY,
    ErrorCode.IDEMPOTENCY_CONFLICT: RetryDisposition.DO_NOT_RETRY,
    ErrorCode.VERSION_CONFLICT: RetryDisposition.SAFE,
    ErrorCode.LEASE_FENCED: RetryDisposition.DO_NOT_RETRY,
    ErrorCode.CONTRACT_INVALID: RetryDisposition.DO_NOT_RETRY,
    ErrorCode.EVIDENCE_INVALID: RetryDisposition.DO_NOT_RETRY,
    ErrorCode.GATE_PENDING: RetryDisposition.SAFE,
    ErrorCode.RUN_BLOCKED: RetryDisposition.DO_NOT_RETRY,
    ErrorCode.CONTROL_PLANE_UNAVAILABLE: RetryDisposition.RECONCILE_REQUIRED,
    ErrorCode.INTERNAL: RetryDisposition.RECONCILE_REQUIRED,
}

ERROR_CODES: Final[tuple[str, ...]] = tuple(c.value for c in ErrorCode)


def retry_disposition(code: ErrorCode | str) -> RetryDisposition:
    """How the caller may proceed after this failure."""
    try:
        return _DISPOSITION[ErrorCode(code)]
    except (ValueError, KeyError):
        return RetryDisposition.DO_NOT_RETRY


class PolyForgeError(Exception):
    """A failure the Runtime Service is willing to describe precisely."""

    def __init__(
        self,
        code: ErrorCode,
        message: str,
        *,
        details: dict[str, Any] | None = None,
        pending_reason: str | None = None,
        status: int | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details: dict[str, Any] = details or {}
        self.pending_reason = pending_reason
        self.status = status if status is not None else ERROR_STATUS.get(code, 500)

    @property
    def retry(self) -> RetryDisposition:
        return retry_disposition(self.code)

    def to_body(self) -> dict[str, Any]:
        body: dict[str, Any] = {"error": {"code": self.code.value, "message": self.message}}
        if self.details:
            body["error"]["details"] = self.details
        if self.pending_reason:
            body["error"]["pendingReason"] = self.pending_reason
        return body

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"PolyForgeError({self.code.value}: {self.message})"


def bad_request(message: str, **details: Any) -> PolyForgeError:
    return PolyForgeError(ErrorCode.BAD_REQUEST, message, details=details or None)


def not_found(message: str, **details: Any) -> PolyForgeError:
    return PolyForgeError(ErrorCode.NOT_FOUND, message, details=details or None)


def scope_violation(message: str, **details: Any) -> PolyForgeError:
    return PolyForgeError(ErrorCode.SCOPE_VIOLATION, message, details=details or None)


def authorization_denied(message: str, **details: Any) -> PolyForgeError:
    return PolyForgeError(ErrorCode.AUTHORIZATION_DENIED, message, details=details or None)


def contract_invalid(message: str, **details: Any) -> PolyForgeError:
    return PolyForgeError(ErrorCode.CONTRACT_INVALID, message, details=details or None)


def version_conflict(message: str, current_version: int, **details: Any) -> PolyForgeError:
    return PolyForgeError(
        ErrorCode.VERSION_CONFLICT,
        message,
        details={"currentVersion": current_version, **details},
    )


def idempotency_conflict(message: str, **details: Any) -> PolyForgeError:
    return PolyForgeError(ErrorCode.IDEMPOTENCY_CONFLICT, message, details=details or None)


def lease_fenced(message: str, **details: Any) -> PolyForgeError:
    return PolyForgeError(ErrorCode.LEASE_FENCED, message, details=details or None)


def run_blocked(message: str, **details: Any) -> PolyForgeError:
    return PolyForgeError(ErrorCode.RUN_BLOCKED, message, details=details or None)


def unsupported(message: str, **details: Any) -> PolyForgeError:
    return PolyForgeError(ErrorCode.UNSUPPORTED, message, details=details or None)


def evidence_invalid(message: str, **details: Any) -> PolyForgeError:
    return PolyForgeError(ErrorCode.EVIDENCE_INVALID, message, details=details or None)
