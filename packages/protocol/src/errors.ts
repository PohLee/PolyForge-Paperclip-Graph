/**
 * Runtime Service error contract.
 *
 * The Runtime Service never invents a success: every non-2xx response carries one of these
 * codes so the bridge can decide between "retry", "reconcile", and "block". A generic 500
 * with a free-text body is not an acceptable answer for a mutation the bridge is going to
 * retry, because a retried create can duplicate an external effect.
 */

export const ERROR_CODES = [
  "IDEMPOTENCY_CONFLICT",
  "VERSION_CONFLICT",
  "AUTHORIZATION_DENIED",
  "CONTRACT_INVALID",
  "RUN_BLOCKED",
  "CONTROL_PLANE_UNAVAILABLE",
  "SCOPE_VIOLATION",
  "LEASE_FENCED",
  "NOT_FOUND",
  "BAD_REQUEST",
  "UNSUPPORTED",
  "EVIDENCE_INVALID",
  "GATE_PENDING",
  "INTERNAL",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const ERROR_STATUS: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  NOT_FOUND: 404,
  AUTHORIZATION_DENIED: 403,
  SCOPE_VIOLATION: 403,
  UNSUPPORTED: 501,
  IDEMPOTENCY_CONFLICT: 409,
  VERSION_CONFLICT: 409,
  LEASE_FENCED: 409,
  CONTRACT_INVALID: 422,
  EVIDENCE_INVALID: 422,
  GATE_PENDING: 202,
  RUN_BLOCKED: 423,
  CONTROL_PLANE_UNAVAILABLE: 503,
  INTERNAL: 500,
};

/**
 * Retry disposition. The bridge uses this instead of guessing from a status code, because
 * a timeout on a create is ambiguous and must not be blindly re-sent.
 */
export type RetryDisposition =
  | "safe" // idempotent replay returns the recorded result
  | "reconcile_required" // the request may have taken effect; look it up before retrying
  | "do_not_retry"; // deterministic rejection

const DISPOSITION: Record<ErrorCode, RetryDisposition> = {
  BAD_REQUEST: "do_not_retry",
  NOT_FOUND: "do_not_retry",
  AUTHORIZATION_DENIED: "do_not_retry",
  SCOPE_VIOLATION: "do_not_retry",
  UNSUPPORTED: "do_not_retry",
  IDEMPOTENCY_CONFLICT: "do_not_retry",
  VERSION_CONFLICT: "safe",
  LEASE_FENCED: "do_not_retry",
  CONTRACT_INVALID: "do_not_retry",
  EVIDENCE_INVALID: "do_not_retry",
  GATE_PENDING: "safe",
  RUN_BLOCKED: "do_not_retry",
  CONTROL_PLANE_UNAVAILABLE: "reconcile_required",
  INTERNAL: "reconcile_required",
};

export function retryDisposition(code: ErrorCode): RetryDisposition {
  return DISPOSITION[code] ?? "do_not_retry";
}

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    /** Machine-readable extra context (current version, required facts, missing evaluators). */
    details?: Record<string, unknown>;
    /** Present on 202 responses that recorded a durable pending request. */
    pendingReason?: string;
  };
}
