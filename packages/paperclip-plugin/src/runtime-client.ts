/**
 * The signed client to the PolyForge Runtime Service.
 *
 * ## What is signed
 *
 * `docs/05-PROTOCOL.md` §1.1: the signature is
 * `v1=<hex hmac-sha256(canonicalRequest, sharedSecret)>` where `canonicalRequest` is the
 * canonical JSON (§2) of exactly these nine fields:
 *
 * ```text
 * { audience, method, path, bodyHash, timestamp, nonce, issuer, actor, scope }
 * ```
 *
 * Method, path and the *digest of the exact bytes on the wire* are covered, so a captured
 * request cannot be replayed against a different endpoint and a mutated body fails
 * verification even if every header survives. The audience is covered, so the same request
 * cannot be replayed at a different service that shares the secret.
 *
 * `buildCanonicalRequest` and `signCanonicalRequest` are exported separately from the HTTP
 * path on purpose: the cross-language conformance test asserts the *exact* canonical string
 * this module produces, so a refactor cannot silently change the identity space the Python
 * Core verifies.
 *
 * ## The secret
 *
 * Resolved per call through `ctx.secrets.resolve` by the caller-supplied `secretProvider`.
 * It is never cached, never logged, never written to the store, and never included in an
 * error. A `RuntimeCallError` carries the code, status and message from the *response*, not
 * the request that produced it.
 *
 * ## Timeouts are ambiguous, not failures
 *
 * A transport-level failure on a mutating request is reported with `ambiguous: true` and
 * `retry: "reconcile_required"`. The caller must look the object up by its correlation key
 * before deciding. The only exception is a read, where a timeout is simply a failed read.
 */

import { createHmac, randomBytes } from "node:crypto";
import { actorToWire, canonicalJson, digestBytes, digestText, retryDisposition } from "@polyforge/protocol";
import type {
  ActorAssertion,
  ApiErrorBody,
  Blocker,
  CommandResult,
  CompileArtifact,
  CreateWorkOrderRequest,
  DomainEvent,
  DraftSummary,
  ErrorCode,
  GraphDefinition,
  GraphVersionSummary,
  HealthReport,
  MigrationPreview,
  RetryDisposition,
  RunSnapshot,
  Scope,
  SemanticDiff,
  ValidationReport,
} from "@polyforge/protocol";
import type { BridgeConfig } from "./config.js";
import type { BridgeLogger } from "./logger.js";
import { NULL_LOGGER } from "./logger.js";
import type { BridgeStore } from "./store.js";
import { stripActorAssertions } from "./identity.js";

/** The nine signed fields, in the shape §1.1 names. Key order is irrelevant: canonical JSON sorts. */
export interface CanonicalRequestInput {
  readonly audience: string;
  readonly method: string;
  readonly path: string;
  readonly bodyHash: string;
  readonly timestamp: string;
  readonly nonce: string;
  readonly issuer: string;
  readonly actor: ActorAssertion;
  readonly scope: Scope;
}

/** The base64url encoding used for `X-PF-Actor` and `X-PF-Scope` (no padding). */
export function base64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

export function buildCanonicalRequest(input: CanonicalRequestInput): string {
  return canonicalJson({
    audience: input.audience,
    method: input.method,
    path: input.path,
    bodyHash: input.bodyHash,
    timestamp: input.timestamp,
    nonce: input.nonce,
    issuer: input.issuer,
    actor: input.actor,
    scope: input.scope,
  });
}

export function signCanonicalRequest(canonicalRequest: string, secret: string): string {
  const mac = createHmac("sha256", secret).update(canonicalRequest, "utf8").digest("hex");
  return `v1=${mac}`;
}

/**
 * `sha256:<hex>` over the exact bytes that will be transmitted.
 *
 * `digestBytes` hashes the raw buffer, not a re-encoded string, so a byte sequence that is
 * not valid UTF-8 still produces the digest the receiver computes from the received bytes.
 */
export function hashBodyBytes(bytes: Uint8Array | null): string {
  return bytes === null ? digestText("") : digestBytes(bytes);
}

/** Body of `PATCH /v1/drafts/{draftId}`. The draft revision travels in `If-Match`, not here. */
export interface SaveDraftBody {
  readonly definition: GraphDefinition;
  readonly changeSummary?: string;
}

export interface RuntimeClock {
  now(): Date;
  /** 128 bits of randomness, hex encoded (32 chars). */
  nonce(): string;
  sleep(ms: number): Promise<void>;
}

export const SYSTEM_CLOCK: RuntimeClock = {
  now: () => new Date(),
  nonce: () => randomBytes(16).toString("hex"),
  sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface SecretProvider {
  /** Resolve the current secret value. Called once per request; the value is not retained. */
  (): Promise<string>;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface RuntimeClientOptions {
  readonly secretProvider: SecretProvider;
  readonly clock?: RuntimeClock;
  readonly logger?: BridgeLogger;
  /** Injected in tests. Defaults to global `fetch`. */
  readonly fetchImpl?: FetchLike;
  /** Durable nonce ledger; when present, nonces survive a worker restart. */
  readonly nonceLedger?: Pick<BridgeStore, "useNonce" | "pruneNonces">;
  /** Company whose scope this client asserts. */
  readonly companyId: string;
}

export interface RuntimeCallErrorShape {
  readonly code: ErrorCode | "TRANSPORT_TIMEOUT" | "TRANSPORT_ERROR" | "MALFORMED_RESPONSE";
  readonly status: number | null;
  readonly message: string;
  readonly details: Record<string, unknown>;
  readonly retry: RetryDisposition;
  /** True when the request may have taken effect. The caller must reconcile, not resend. */
  readonly ambiguous: boolean;
  readonly pendingReason: string | null;
}

export class RuntimeCallError extends Error implements RuntimeCallErrorShape {
  readonly code: RuntimeCallErrorShape["code"];
  readonly status: number | null;
  readonly details: Record<string, unknown>;
  readonly retry: RetryDisposition;
  readonly ambiguous: boolean;
  readonly pendingReason: string | null;
  readonly blockers: Blocker[];

  constructor(shape: RuntimeCallErrorShape, blockers: Blocker[] = []) {
    super(shape.message);
    this.name = "RuntimeCallError";
    this.code = shape.code;
    this.status = shape.status;
    this.details = shape.details;
    this.retry = shape.retry;
    this.ambiguous = shape.ambiguous;
    this.pendingReason = shape.pendingReason;
    this.blockers = blockers;
  }

  toJSON(): RuntimeCallErrorShape & { blockers: Blocker[] } {
    return {
      code: this.code,
      status: this.status,
      message: this.message,
      details: this.details,
      retry: this.retry,
      ambiguous: this.ambiguous,
      pendingReason: this.pendingReason,
      blockers: this.blockers,
    };
  }
}

export function isRuntimeCallError(value: unknown): value is RuntimeCallError {
  return value instanceof RuntimeCallError;
}

interface EndpointSpec {
  readonly method: "GET" | "POST" | "PATCH" | "DELETE";
  readonly path: string;
  /** A write is subject to the ambiguous-on-timeout rule; a read is not. */
  readonly write: boolean;
  /**
   * True when the endpoint creates a durable object. A timeout on a create is never
   * blindly resent: the reconciler looks the object up by its correlation key first.
   */
  readonly create: boolean;
}

const V1 = "/v1";

/**
 * The path that goes into the signature: the request target *relative to the API base*.
 *
 * `docs/05-PROTOCOL.md` §1.1 and the Core's `canonical_request_bytes` both define the signed
 * `path` as relative to the API base, query string included, so `/runs/run-1/claims?force=true`
 * is what gets signed whether the deployment is mounted at `/v1`, at `/api/v1` behind a proxy, or
 * at the root. The `/v1` prefix is a property of where the service happens to be mounted, not part
 * of the request's identity, and baking it into the signature means the same logical call is a
 * different signed request under a different mount point — which breaks verification the moment the
 * Core is not served from exactly one path.
 *
 * The wire path keeps the prefix. Only the signed form drops it.
 */
function signedPathOf(wirePath: string): string {
  return wirePath.startsWith(V1) ? wirePath.slice(V1.length) : wirePath;
}

/**
 * Typed `/v1` surface.
 *
 * Paths marked below match `docs/05-PROTOCOL.md` §3.2 exactly. The four the bridge needs but
 * §3.2 does not tabulate (outbox drain/ack, event intake, graph list, recover) are declared
 * here so there is exactly one place that knows a Runtime path; a change is one edit, and the
 * cross-language contract test pins the signing behaviour regardless of the path value.
 */
const ENDPOINTS = {
  health: { method: "GET", path: `${V1}/health`, write: false, create: false },
  listGraphs: { method: "GET", path: `${V1}/graphs`, write: false, create: false },
  getRun: { method: "GET", path: `${V1}/runs/{runId}`, write: false, create: false },
  listRuns: { method: "GET", path: `${V1}/runs`, write: false, create: false },
  listEvents: { method: "GET", path: `${V1}/runs/{runId}/events`, write: false, create: false },
  current: { method: "GET", path: `${V1}/runs/{runId}/current`, write: false, create: false },
  getDraft: { method: "GET", path: `${V1}/drafts/{draftId}`, write: false, create: false },
  listVersions: { method: "GET", path: `${V1}/graphs/{graphId}/versions`, write: false, create: false },
  diff: { method: "GET", path: `${V1}/graphs/{graphId}/diff`, write: false, create: false },
  /**
   * Claim the Core's queued outbound intents.
   *
   * The path is `/bridge/outbox`, not `/outbox`. The Core exposes the bridge's delivery surface
   * under that prefix, so the shorter path 404s and the Core's intents are never claimed — the
   * outbox pump goes on successfully delivering the bridge's *own* queue while everything the Core
   * asked for sits unclaimed. Claiming is a lease: an intent not acknowledged before it expires
   * becomes claimable again rather than lost.
   */
  drainOutbox: { method: "GET", path: `${V1}/bridge/outbox`, write: false, create: false },
  /** Acknowledge one delivery attempt. The Core scope-checks it before it sees the intent at all. */
  markDelivery: { method: "POST", path: `${V1}/bridge/outbox/{intentId}/delivery`, write: true, create: false },
  createWorkOrder: { method: "POST", path: `${V1}/work-orders`, write: true, create: true },
  claim: { method: "POST", path: `${V1}/runs/{runId}/claims`, write: true, create: false },
  submitArtifacts: { method: "POST", path: `${V1}/runs/{runId}/artifacts`, write: true, create: false },
  submitEvidence: { method: "POST", path: `${V1}/runs/{runId}/evidence`, write: true, create: false },
  requestTransition: { method: "POST", path: `${V1}/runs/{runId}/transitions`, write: true, create: false },
  requestHelp: { method: "POST", path: `${V1}/runs/{runId}/help`, write: true, create: true },
  runCommand: { method: "POST", path: `${V1}/runs/{runId}/commands`, write: true, create: false },
  recordGovernanceResolution: {
    method: "POST",
    path: `${V1}/runs/{runId}/governance/{requestId}/resolution`,
    write: true,
    create: false,
  },
  planMigration: { method: "POST", path: `${V1}/runs/{runId}/migrations/plan`, write: true, create: false },
  commitMigration: { method: "POST", path: `${V1}/runs/{runId}/migrations/commit`, write: true, create: false },
  createDraft: { method: "POST", path: `${V1}/graphs/{graphId}/drafts`, write: true, create: true },
  saveDraft: { method: "PATCH", path: `${V1}/drafts/{draftId}`, write: true, create: false },
  validateDraft: { method: "POST", path: `${V1}/drafts/{draftId}/validate`, write: true, create: false },
  compileDraft: { method: "POST", path: `${V1}/drafts/{draftId}/compile`, write: true, create: false },
  publishDraft: { method: "POST", path: `${V1}/drafts/{draftId}/publish`, write: true, create: false },
  recordDraftReview: { method: "POST", path: `${V1}/drafts/{draftId}/reviews`, write: true, create: false },
  activateVersion: { method: "POST", path: `${V1}/graphs/{graphId}/activate`, write: true, create: false },
  intakeEvent: { method: "POST", path: `${V1}/events`, write: true, create: false },
  recover: { method: "POST", path: `${V1}/recover`, write: true, create: false },
} as const satisfies Record<string, EndpointSpec>;

export type EndpointName = keyof typeof ENDPOINTS;

/**
 * One outbound intent the Core has queued, as `GET /v1/bridge/outbox` returns it.
 *
 * `deliveryAttempt` and `maxDeliveryAttempts` are the fields that decide whether this intent should
 * be attempted again or dead-lettered, so they are part of the contract rather than an afterthought:
 * a consumer that drops them can neither bound its retries nor explain a dead letter.
 */
export interface CoreOutboxIntent {
  readonly intentId: string;
  readonly kind: string;
  readonly runId: string | null;
  readonly nodeId: string | null;
  readonly correlationKey: string;
  readonly payload: Record<string, unknown>;
  readonly deliveryAttempt: number;
  readonly maxDeliveryAttempts: number;
  readonly claimOwner: string;
}

export interface CoreOutboxBatch {
  readonly intents: CoreOutboxIntent[];
  readonly count: number;
  /** How long this claim is held. An intent not acked inside it becomes claimable again. */
  readonly leaseSeconds: number;
}

export interface CallOptions {
  readonly actor: ActorAssertion;
  readonly scope: Scope;
  /** Path parameters, substituted into the endpoint template. */
  readonly params?: Record<string, string | number>;
  readonly query?: Record<string, string | number | boolean | undefined>;
  readonly body?: unknown;
  /** Extra request headers, e.g. `If-Match` for a draft revision CAS. */
  readonly headers?: Record<string, string>;
  /** Override the configured timeout for one call. */
  readonly timeoutMs?: number;
  /** Correlation id for logging. Not part of the signature. */
  readonly correlationId?: string;
}

export interface RunListQuery {
  readonly graphId?: string;
  readonly status?: string;
  readonly projectRef?: string;
  readonly limit?: number;
}

export class RuntimeClient {
  readonly #config: BridgeConfig;
  readonly #options: RuntimeClientOptions;
  readonly #clock: RuntimeClock;
  readonly #logger: BridgeLogger;
  readonly #fetch: FetchLike;

  constructor(config: BridgeConfig, options: RuntimeClientOptions) {
    this.#config = config;
    this.#options = options;
    this.#clock = options.clock ?? SYSTEM_CLOCK;
    this.#logger = (options.logger ?? NULL_LOGGER).child({ companyId: options.companyId });
    this.#fetch =
      options.fetchImpl ??
      ((url, init) => {
        if (typeof fetch !== "function") {
          throw new Error("no fetch implementation is available in this runtime");
        }
        return fetch(url, init);
      });
  }

  get audience(): string {
    return this.#config.audience;
  }

  get issuer(): string {
    return this.#config.bridgeIssuer;
  }

  get companyId(): string {
    return this.#options.companyId;
  }

  /**
   * Sign a request without sending it.
   *
   * Exposed so a test can assert the exact canonical string and header set, and so
   * `onValidateConfig` can prove the configured issuer and audience actually sign.
   */
  async signForInspection(options: {
    method: string;
    path: string;
    body?: unknown;
    actor: ActorAssertion;
    scope: Scope;
    timestamp: string;
    nonce: string;
  }): Promise<{ canonicalRequest: string; headers: Record<string, string> }> {
    // One implementation, not two. This used to rebuild the canonical string by hand, and it drifted
    // from `call()` in exactly the two ways that matter: it signed the path verbatim and the actor
    // unnormalised. `onValidateConfig` probes the Core with this, so a drift here does not fail a
    // test — it makes the health check report a healthy deployment that no request can reach.
    const { canonicalRequest, headers } = await this.#sign({
      method: options.method,
      path: options.path,
      bodyBytes: options.body === undefined ? null : new TextEncoder().encode(canonicalJson(options.body)),
      timestamp: options.timestamp,
      nonce: options.nonce,
      actor: options.actor,
      scope: options.scope,
    });
    return { canonicalRequest, headers };
  }

  /**
   * The single place a request is turned into a canonical string, a signature and a header set.
   *
   * `path` is the *wire* path; the API base is stripped for the signature. The actor is normalised
   * to the Core's wire form, and the very same object becomes `X-PF-Actor`, so the header and the
   * signature cannot describe different callers.
   */
  async #sign(input: {
    method: string;
    path: string;
    bodyBytes: Uint8Array | null;
    timestamp: string;
    nonce: string;
    actor: ActorAssertion;
    scope: Scope;
    extraHeaders?: Record<string, string>;
    endpoint?: string;
  }): Promise<{ canonicalRequest: string; headers: Record<string, string> }> {
    const actor = actorToWire(input.actor);
    const canonicalRequest = buildCanonicalRequest({
      audience: this.#config.audience,
      method: input.method,
      path: signedPathOf(input.path),
      bodyHash: hashBodyBytes(input.bodyBytes),
      timestamp: input.timestamp,
      nonce: input.nonce,
      issuer: this.#config.bridgeIssuer,
      actor: actor as unknown as ActorAssertion,
      scope: input.scope,
    });
    // The secret is resolved per request and scoped to this block only. It is never stored on the
    // client, never passed to the logger, and never written to the store. An unresolvable secret is
    // a configuration fault, not a transport fault, so it is reported as one and is never retried.
    let secret: string;
    try {
      secret = await this.#options.secretProvider();
    } catch (error) {
      throw new RuntimeCallError({
        code: "AUTHORIZATION_DENIED",
        status: null,
        message: `shared secret is not resolvable: ${error instanceof Error ? error.message : String(error)}`,
        details: input.endpoint === undefined ? {} : { endpoint: input.endpoint },
        retry: "do_not_retry",
        ambiguous: false,
        pendingReason: null,
      });
    }
    return {
      canonicalRequest,
      headers: {
        "content-type": "application/json",
        "x-pf-issuer": this.#config.bridgeIssuer,
        // The audience is covered by the signature, so it must also be transmitted. Left to the
        // Core's default, the field the Core verifies would equal the signed field only by
        // coincidence of configuration, and the binding would be invisible on the wire.
        "x-pf-audience": this.#config.audience,
        "x-pf-timestamp": input.timestamp,
        "x-pf-nonce": input.nonce,
        "x-pf-actor": base64url(canonicalJson(actor)),
        "x-pf-scope": base64url(canonicalJson(input.scope)),
        "x-pf-signature": signCanonicalRequest(canonicalRequest, secret),
        ...(input.extraHeaders ?? {}),
      },
    };
  }


  #nextNonce(): string {
    // Retry a bounded number of times: an unlucky collision with the durable ledger is not a
    // reason to fail a request, and a used nonce must never be sent.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = this.#clock.nonce();
      const ledger = this.#options.nonceLedger;
      if (!ledger) return candidate;
      if (ledger.useNonce(candidate, this.#clock.now().getTime())) return candidate;
      this.#logger.warn("nonce collision with the durable ledger; minting another", { attempt });
    }
    throw new RuntimeCallError({
      code: "INTERNAL",
      status: null,
      message: "could not mint a fresh signing nonce",
      details: {},
      retry: "do_not_retry",
      ambiguous: false,
      pendingReason: null,
    });
  }

  #resolvePath(spec: EndpointSpec, params: Record<string, string | number> | undefined): string {
    let path = spec.path;
    for (const [key, value] of Object.entries(params ?? {})) {
      path = path.replace(`{${key}}`, encodeURIComponent(String(value)));
    }
    return path;
  }

  #resolveQuery(query: Record<string, string | number | boolean | undefined> | undefined): string {
    if (!query) return "";
    const parts: string[] = [];
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    }
    return parts.length > 0 ? `?${parts.join("&")}` : "";
  }

  /**
   * Execute one signed request.
   *
   * Every mutating call goes through here, so the ambiguous-on-timeout rule, the actor
   * stripping, and the `command_log` idempotency record cannot be bypassed by adding a
   * convenience method later.
   */
  async call<T = unknown>(name: EndpointName, options: CallOptions): Promise<T> {
    const spec = ENDPOINTS[name];
    const path = this.#resolvePath(spec, options.params);
    const query = this.#resolveQuery(options.query);
    const fullPath = `${path}${query}`;

    // Identity and approval fields are removed before anything is hashed or signed. A body
    // that carried `approved` or `actorUserId` therefore cannot be smuggled to the Core even
    // by a caller that copied a field out of a previous response.
    const stripped = spec.write && options.body !== undefined
      ? stripActorAssertions(options.body)
      : { value: options.body, strippedKeys: [] as string[] };
    if (stripped.strippedKeys.length > 0) {
      this.#logger.warn("stripped actor/approval fields from an outbound body", {
        endpoint: name,
        keys: stripped.strippedKeys,
      });
    }

    const bodyText = stripped.value === undefined ? null : canonicalJson(stripped.value);
    const bodyBytes = bodyText === null ? null : new TextEncoder().encode(bodyText);
    const timestamp = this.#clock.now().toISOString();
    const nonce = this.#nextNonce();

    const { headers } = await this.#sign({
      method: spec.method,
      path: fullPath,
      bodyBytes,
      timestamp,
      nonce,
      actor: options.actor,
      scope: options.scope,
      extraHeaders: options.headers ?? {},
      endpoint: name,
    });

    const url = `${this.#config.runtimeUrl}${fullPath}`;
    const timeoutMs = options.timeoutMs ?? this.#config.requestTimeoutMs;
    const logger = this.#logger.child({
      correlationId: options.correlationId,
      runId: options.params?.["runId"] === undefined ? undefined : String(options.params["runId"]),
      nodeId: options.params?.["nodeId"] === undefined ? undefined : String(options.params["nodeId"]),
    });

    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: spec.method,
        headers,
        ...(bodyBytes === null ? {} : { body: new Uint8Array(bodyBytes) as unknown as NonNullable<RequestInit["body"]> }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const timedOut = isTimeoutError(error);
      // A write whose transport failed may already have taken effect. Reporting that as
      // "ambiguous" is what stops the pump from blindly re-sending a create.
      const ambiguous = spec.write;
      const shape: RuntimeCallErrorShape = {
        code: timedOut ? "TRANSPORT_TIMEOUT" : "TRANSPORT_ERROR",
        status: null,
        message: timedOut
          ? `request to ${name} timed out after ${timeoutMs}ms`
          : `request to ${name} failed: ${error instanceof Error ? error.message : String(error)}`,
        details: { endpoint: name, method: spec.method, path: fullPath, timedOut },
        retry: spec.write ? "reconcile_required" : "safe",
        ambiguous,
        pendingReason: ambiguous ? "ambiguous_request_outcome" : null,
      };
      logger.warn("runtime call failed at the transport layer", {
        endpoint: name,
        code: shape.code,
        ambiguous,
      });
      throw new RuntimeCallError(shape, [
        {
          code: ambiguous ? "EFFECT_UNKNOWN" : "CONTROL_PLANE_UNAVAILABLE",
          reason: ambiguous ? "BLOCKED_EFFECT_UNKNOWN" : "BLOCKED_PLATFORM",
          message: shape.message,
          detail: { endpoint: name },
        },
      ]);
    }

    const text = await response.text();
    const parsed = parseJson(text);

    if (response.ok) {
      // 202 is a *recorded but deferred* command and still uses the command envelope, so a
      // 2xx is a success shape, never an error body.
      return (parsed ?? {}) as T;
    }

    const errorBody = extractApiError(parsed);
    const code: ErrorCode = errorBody?.code ?? statusFallbackCode(response.status);
    const disposition: RetryDisposition = errorBody ? retryDisposition(code) : "do_not_retry";
    throw new RuntimeCallError(
      {
        code,
        status: response.status,
        message: errorBody?.message ?? `runtime returned HTTP ${response.status}`,
        details: errorBody?.details ?? {},
        retry: disposition,
        // A 5xx on a write may have committed before the failure; treat it the same as a
        // timeout so the reconciler resolves it rather than the pump resending.
        ambiguous: spec.write && (response.status >= 500 || code === "CONTROL_PLANE_UNAVAILABLE"),
        pendingReason: errorBody?.pendingReason ?? null,
      },
      extractBlockers(parsed) ?? [],
    );
  }

  // -------------------------------------------------------------------------
  // Typed endpoints
  // -------------------------------------------------------------------------

  health(actor: ActorAssertion, scope: Scope, correlationId?: string): Promise<HealthReport> {
    return this.call<HealthReport>("health", { actor, scope, ...(correlationId ? { correlationId } : {}) });
  }

  listGraphs(actor: ActorAssertion, scope: Scope): Promise<{ graphs: Record<string, unknown>[] }> {
    return this.call("listGraphs", { actor, scope });
  }

  getRun(actor: ActorAssertion, scope: Scope, runId: string): Promise<RunSnapshot> {
    return this.call<RunSnapshot>("getRun", { actor, scope, params: { runId } });
  }

  listRuns(actor: ActorAssertion, scope: Scope, query: RunListQuery = {}): Promise<{ runs: RunSnapshot[] }> {
    return this.call("listRuns", {
      actor,
      scope,
      query: {
        ...(query.graphId ? { graphId: query.graphId } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.projectRef ? { projectRef: query.projectRef } : {}),
        ...(query.limit ? { limit: query.limit } : {}),
      },
    });
  }

  listEvents(
    actor: ActorAssertion,
    scope: Scope,
    runId: string,
    after: number,
    limit = 200,
  ): Promise<{ events: DomainEvent[] }> {
    return this.call("listEvents", { actor, scope, params: { runId }, query: { after, limit } });
  }

  current(actor: ActorAssertion, scope: Scope, runId: string): Promise<Record<string, unknown>> {
    return this.call("current", { actor, scope, params: { runId } });
  }

  createWorkOrder(actor: ActorAssertion, scope: Scope, body: CreateWorkOrderRequest, correlationId?: string): Promise<CommandResult & { runId?: string; workOrderId?: string }> {
    return this.call("createWorkOrder", {
      actor,
      scope,
      body,
      ...(correlationId ? { correlationId } : {}),
    });
  }

  claim(actor: ActorAssertion, scope: Scope, runId: string, body: unknown, correlationId?: string): Promise<CommandResult> {
    return this.call<CommandResult>("claim", {
      actor,
      scope,
      params: { runId },
      body,
      ...(correlationId ? { correlationId } : {}),
    });
  }

  submitArtifacts(
    actor: ActorAssertion,
    scope: Scope,
    runId: string,
    body: unknown,
    correlationId?: string,
  ): Promise<CommandResult> {
    return this.call<CommandResult>("submitArtifacts", {
      actor,
      scope,
      params: { runId },
      body,
      ...(correlationId ? { correlationId } : {}),
    });
  }

  submitEvidence(
    actor: ActorAssertion,
    scope: Scope,
    runId: string,
    body: unknown,
    correlationId?: string,
  ): Promise<CommandResult> {
    return this.call<CommandResult>("submitEvidence", {
      actor,
      scope,
      params: { runId },
      body,
      ...(correlationId ? { correlationId } : {}),
    });
  }

  requestTransition(
    actor: ActorAssertion,
    scope: Scope,
    runId: string,
    body: unknown,
    correlationId?: string,
  ): Promise<CommandResult> {
    return this.call<CommandResult>("requestTransition", {
      actor,
      scope,
      params: { runId },
      body,
      ...(correlationId ? { correlationId } : {}),
    });
  }

  requestHelp(
    actor: ActorAssertion,
    scope: Scope,
    runId: string,
    body: unknown,
    correlationId?: string,
  ): Promise<CommandResult> {
    return this.call<CommandResult>("requestHelp", {
      actor,
      scope,
      params: { runId },
      body,
      ...(correlationId ? { correlationId } : {}),
    });
  }

  runCommand(actor: ActorAssertion, scope: Scope, runId: string, body: unknown): Promise<CommandResult> {
    return this.call<CommandResult>("runCommand", { actor, scope, params: { runId }, body });
  }

  recordGovernanceResolution(
    actor: ActorAssertion,
    scope: Scope,
    runId: string,
    requestId: string,
    body: unknown,
  ): Promise<CommandResult> {
    return this.call<CommandResult>("recordGovernanceResolution", {
      actor,
      scope,
      params: { runId, requestId },
      body,
    });
  }

  planMigration(actor: ActorAssertion, scope: Scope, runId: string, body: unknown): Promise<MigrationPreview> {
    return this.call<MigrationPreview>("planMigration", { actor, scope, params: { runId }, body });
  }

  commitMigration(actor: ActorAssertion, scope: Scope, runId: string, body: unknown): Promise<CommandResult> {
    return this.call<CommandResult>("commitMigration", { actor, scope, params: { runId }, body });
  }

  /**
   * Claim queued outbound intents from the Core.
   *
   * The response is the Core's own shape, not the one this method used to describe. It carries a
   * lease length and, per intent, a delivery attempt counter against a maximum — the fields that
   * decide whether an intent should be retried or dead-lettered, so they have to survive the trip.
   */
  drainOutbox(actor: ActorAssertion, scope: Scope, options: { limit?: number } = {}): Promise<CoreOutboxBatch> {
    return this.call<CoreOutboxBatch>("drainOutbox", {
      actor,
      scope,
      query: options.limit === undefined ? {} : { limit: options.limit },
    });
  }

  /**
   * Acknowledge one delivery attempt.
   *
   * The path parameter is the Core's `intentId`, not a bridge delivery id: the Core is tracking its
   * own intent, and acknowledging a different id would report on the wrong object.
   */
  markDelivery(
    actor: ActorAssertion,
    scope: Scope,
    intentId: string,
    body: unknown,
  ): Promise<Record<string, unknown>> {
    return this.call<Record<string, unknown>>("markDelivery", {
      actor,
      scope,
      params: { intentId },
      body,
    });
  }

  intakeEvent(actor: ActorAssertion, scope: Scope, body: unknown, correlationId?: string): Promise<CommandResult> {
    return this.call<CommandResult>("intakeEvent", {
      actor,
      scope,
      body,
      ...(correlationId ? { correlationId } : {}),
    });
  }

  listVersions(actor: ActorAssertion, scope: Scope, graphId: string): Promise<{ versions: GraphVersionSummary[] }> {
    return this.call("listVersions", { actor, scope, params: { graphId } });
  }

  getDraft(actor: ActorAssertion, scope: Scope, draftId: string): Promise<{ draft: DraftSummary; definition: unknown }> {
    return this.call("getDraft", { actor, scope, params: { draftId } });
  }

  createDraft(actor: ActorAssertion, scope: Scope, graphId: string, body: unknown): Promise<DraftSummary> {
    return this.call<DraftSummary>("createDraft", { actor, scope, params: { graphId }, body });
  }

  saveDraft(
    actor: ActorAssertion,
    scope: Scope,
    draftId: string,
    body: SaveDraftBody,
    revision: string,
  ): Promise<DraftSummary> {
    return this.call<DraftSummary>("saveDraft", {
      actor,
      scope,
      params: { draftId },
      body,
      headers: { "if-match": `"${revision}"` },
    });
  }

  validateDraft(actor: ActorAssertion, scope: Scope, draftId: string): Promise<ValidationReport> {
    return this.call<ValidationReport>("validateDraft", { actor, scope, params: { draftId } });
  }

  compileDraft(actor: ActorAssertion, scope: Scope, draftId: string): Promise<CompileArtifact> {
    return this.call<CompileArtifact>("compileDraft", { actor, scope, params: { draftId } });
  }

  publishDraft(actor: ActorAssertion, scope: Scope, draftId: string, body: unknown): Promise<CommandResult> {
    return this.call<CommandResult>("publishDraft", { actor, scope, params: { draftId }, body });
  }

  /**
   * Record a human review of one exact target hash.
   *
   * Distinct from `publishDraft` because it is a *human* act: the Core refuses a review from an
   * agent or a system assertion, so this is the one write on the authoring path where the caller's
   * identity is the point rather than an incidental. The reviewer is therefore the asserted actor and
   * never a body field.
   */
  recordDraftReview(actor: ActorAssertion, scope: Scope, draftId: string, body: unknown): Promise<DraftSummary> {
    return this.call<DraftSummary>("recordDraftReview", { actor, scope, params: { draftId }, body });
  }

  activateVersion(actor: ActorAssertion, scope: Scope, graphId: string, body: unknown): Promise<CommandResult> {
    return this.call<CommandResult>("activateVersion", { actor, scope, params: { graphId }, body });
  }

  diff(actor: ActorAssertion, scope: Scope, graphId: string, from: number, to: number): Promise<SemanticDiff> {
    return this.call<SemanticDiff>("diff", { actor, scope, params: { graphId }, query: { from, to } });
  }

  recover(actor: ActorAssertion, scope: Scope, body: unknown): Promise<CommandResult> {
    return this.call<CommandResult>("recover", { actor, scope, body });
  }
}

function parseJson(text: string): unknown {
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function extractApiError(parsed: unknown): ApiErrorBody["error"] | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const error = (parsed as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return null;
  const record = error as Record<string, unknown>;
  if (typeof record["code"] !== "string") return null;
  return {
    code: record["code"] as ErrorCode,
    message: typeof record["message"] === "string" ? record["message"] : "runtime error",
    ...(typeof record["details"] === "object" && record["details"] !== null
      ? { details: record["details"] as Record<string, unknown> }
      : {}),
    ...(typeof record["pendingReason"] === "string" ? { pendingReason: record["pendingReason"] } : {}),
  };
}

function extractBlockers(parsed: unknown): Blocker[] | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const error = (parsed as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return null;
  const details = (error as { details?: unknown }).details;
  if (typeof details !== "object" || details === null) return null;
  const blockers = (details as { blockers?: unknown }).blockers;
  return Array.isArray(blockers) ? (blockers as Blocker[]) : null;
}

function statusFallbackCode(status: number): ErrorCode {
  if (status === 404) return "NOT_FOUND";
  if (status === 400) return "BAD_REQUEST";
  if (status === 403) return "AUTHORIZATION_DENIED";
  if (status === 409) return "VERSION_CONFLICT";
  if (status === 422) return "CONTRACT_INVALID";
  if (status === 423) return "RUN_BLOCKED";
  if (status === 501) return "UNSUPPORTED";
  if (status === 503) return "CONTROL_PLANE_UNAVAILABLE";
  return "INTERNAL";
}

function isTimeoutError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const name = (error as { name?: unknown }).name;
  if (name === "TimeoutError" || name === "AbortError") return true;
  const cause = (error as { cause?: unknown }).cause;
  if (cause !== undefined && cause !== null) return isTimeoutError(cause);
  return false;
}

export type { CreateWorkOrderRequest };
