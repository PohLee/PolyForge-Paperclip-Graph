/**
 * Bridge error vocabulary and payload redaction.
 *
 * Two separate concerns live here because they are the same concern seen from two ends:
 * what the bridge refuses to do, and what it refuses to print. Every rejection below is
 * an *explainable* cause (docs/05 §9) rather than a thrown string, because a silent
 * success or a bare exception is how an unsupported capability turns into a bypass.
 *
 * The redaction helpers are the last line of defence for the three classes of data this
 * system must never emit: a prompt body, a secret, and a raw actor assertion.
 */

import type { Blocker, BlockReason } from "@polyforge/protocol";

/** Codes the bridge itself raises. They are namespaced so they cannot collide with an `ErrorCode`. */
export const BRIDGE_ERROR_CODES = {
  scopeViolation: "BRIDGE_SCOPE_VIOLATION",
  configInvalid: "BRIDGE_CONFIG_INVALID",
  unsupported: "BRIDGE_UNSUPPORTED",
  storeUnavailable: "BRIDGE_STORE_UNAVAILABLE",
  claimRequired: "BRIDGE_CLAIM_REQUIRED",
  leaseFenced: "BRIDGE_LEASE_FENCED",
  checkoutRequired: "BRIDGE_CHECKOUT_REQUIRED",
  runNotBound: "BRIDGE_RUN_NOT_BOUND",
  integrityFailure: "BRIDGE_INTEGRITY_FAILURE",
  hostileSource: "BRIDGE_HOSTILE_SOURCE",
  /**
   * The Core answered, but in a shape this bridge does not implement.
   *
   * Its own code, distinct from `unsupported`, because the two demand different responses. An
   * unsupported *capability* is a known gap and the feature turns itself off. An incompatible *wire
   * format* means two components that should agree do not, and quietly degrading it is how a broken
   * contract shipped as an empty result: the bridge answered with a contract that had no hash, no
   * required inputs and no evidence requirements, and nothing downstream could tell that apart from
   * a node that genuinely requires nothing.
   */
  protocolIncompatible: "BRIDGE_PROTOCOL_INCOMPATIBLE",
} as const;
export type BridgeErrorCode = (typeof BRIDGE_ERROR_CODES)[keyof typeof BRIDGE_ERROR_CODES];

/**
 * Base class for every refusal the bridge raises on purpose.
 *
 * `blocker` is the machine-readable projection the Core and the UI consume. `reason` uses
 * the Core's `BlockReason` vocabulary so a blocked run is explainable without the bridge
 * inventing a parallel enum.
 */
export class BridgeError extends Error {
  readonly code: BridgeErrorCode;
  readonly reason: BlockReason | string;
  readonly detail: Record<string, unknown>;
  readonly blocker: Blocker;

  constructor(
    code: BridgeErrorCode,
    reason: BlockReason | string,
    message: string,
    detail: Record<string, unknown> = {},
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "BridgeError";
    this.code = code;
    this.reason = reason;
    this.detail = detail;
    this.blocker = { code, reason, message, detail };
  }
}

/** Cross-company or cross-project access. Always counted; never downgraded to a read-only success. */
export class ScopeViolationError extends BridgeError {
  constructor(message: string, detail: Record<string, unknown> = {}, cause?: unknown) {
    super(BRIDGE_ERROR_CODES.scopeViolation, "BLOCKED_SCOPE", message, detail, { cause });
    this.name = "ScopeViolationError";
  }
}

/** The host does not expose the API this port needs. Per docs/05 §9 this is a BLOCKED, never a fake success. */
export class UnsupportedCapabilityError extends BridgeError {
  constructor(capability: string, message: string, detail: Record<string, unknown> = {}) {
    super(BRIDGE_ERROR_CODES.unsupported, "BLOCKED_PLATFORM", message, { capability, ...detail });
    this.name = "UnsupportedCapabilityError";
  }
}

/** Operator configuration is missing or self-contradictory. The worker refuses to start in a degraded-but-writable state. */
export class BridgeConfigError extends BridgeError {
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super(BRIDGE_ERROR_CODES.configInvalid, "BLOCKED_PLATFORM", message, detail);
    this.name = "BridgeConfigError";
  }
}

/** No verified claim/lease, or a stale one. A contract-level side effect is forbidden. */
export class ClaimRequiredError extends BridgeError {
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super(BRIDGE_ERROR_CODES.claimRequired, "BLOCKED_LEASE_FENCED", message, detail);
    this.name = "ClaimRequiredError";
  }
}

/** The lease epoch the caller presented is not the current one. Rejected, never merged. */
export class LeaseFencedError extends BridgeError {
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super(BRIDGE_ERROR_CODES.leaseFenced, "BLOCKED_LEASE_FENCED", message, detail);
    this.name = "LeaseFencedError";
  }
}

/** An artifact/evidence source that looks like an SSRF or path-traversal payload. */
export class HostileSourceError extends BridgeError {
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super(BRIDGE_ERROR_CODES.hostileSource, "BLOCKED_SCOPE", message, detail);
    this.name = "HostileSourceError";
  }
}

/** A verification the bridge performs before trusting a provider object failed. */
export class IntegrityError extends BridgeError {
  constructor(message: string, detail: Record<string, unknown> = {}, cause?: unknown) {
    super(BRIDGE_ERROR_CODES.integrityFailure, "BLOCKED_STALE_INPUT", message, detail, { cause });
    this.name = "IntegrityError";
  }
}

export function isBridgeError(value: unknown): value is BridgeError {
  return value instanceof BridgeError;
}

export function toBlocker(value: unknown): Blocker {
  if (isBridgeError(value)) return value.blocker;
  const message = value instanceof Error ? value.message : String(value);
  return { code: "BRIDGE_UNEXPECTED", reason: "BLOCKED_PLATFORM", message };
}

/**
 * Keys whose values never reach a log line, an activity entry, a metric tag, or a stream
 * payload. The list is matched case-insensitively against the *whole* key.
 */
const REDACTED_KEYS = new Set([
  "secret",
  "secrets",
  "sharedsecret",
  "sharedsecretvalue",
  "token",
  "accesstoken",
  "refreshtoken",
  "apikey",
  "password",
  "authorization",
  "signature",
  "cookie",
  "prompt",
  "promptbody",
  "body",
  "description",
  "text",
  "content",
  "contents",
  "comment",
  "message_body",
  "rawactor",
  "actorassertion",
  "stack",
]);

const MAX_REDACTED_STRING = 512;

/**
 * Redact a value for logging.
 *
 * The rule is deliberately blunt: a prompt body is replaced with its length, never its
 * first characters, because a truncated prompt still leaks the requirement under NDA. An
 * actor assertion is reduced to a shape description, never the asserted id, so a log line
 * can never be replayed as an identity claim.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[redacted:depth]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return value.length > MAX_REDACTED_STRING ? `[redacted:len=${value.length}]` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.slice(0, 32).map((item) => redact(item, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (REDACTED_KEYS.has(normalized)) {
        out[key] = typeof item === "string" ? `[redacted:len=${item.length}]` : "[redacted]";
        continue;
      }
      out[key] = redact(item, depth + 1);
    }
    return out;
  }
  return "[redacted:type]";
}
