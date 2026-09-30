/**
 * Test harness for the PolyForge bridge.
 *
 * ## What is real here, and what is not
 *
 * **Real:** the bridge's own code. Every test drives `createCompanyContext` — the same factory
 * `worker.ts` uses — so the production wiring is what runs. The Runtime Service is a real HTTP
 * server that *verifies the HMAC signature of every request it receives*, so a broken canonical
 * encoder, a missing header, or a mutated body fails a bridge test instead of passing because a
 * mock did not look.
 *
 * **Not real:** the Paperclip host. `@paperclipai/plugin-sdk/testing` is an in-memory
 * approximation. It enforces declared capabilities and a simplified set of its own rules, and it
 * does **not** enforce interaction `resolverPolicy`, does not evaluate `human_only` on a card,
 * does not verify that a document revision is immutable, does not run a real database, and does
 * not enforce `assertCheckoutOwner` the way the server does. A passing harness test therefore
 * proves *the bridge asks the right question and records the right durable fact* — not that the
 * host answers it correctly. The tests that depend on host-side enforcement say so in their
 * names and comments, and the delivery report lists them.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import type { PluginContext, PluginEvent, PluginWorkspace, ToolResult, ToolRunContext } from "@paperclipai/plugin-sdk";
import { actorToWire, digestBytes } from "@polyforge/protocol";
import type { Company, Issue, Project, Agent } from "@paperclipai/shared";
import manifestJson from "../../src/manifest.js";
import { BridgeStore } from "../../src/store.js";
import { BridgeMetrics } from "../../src/metrics.js";
import { CapabilityMatcher } from "../../src/capabilities.js";
import { Inbox } from "../../src/events/inbox.js";
import { EventPump } from "../../src/events/pump.js";
import { OutboxPump, StoreDeliveryRecorder } from "../../src/outbox/delivery.js";
import { RuntimeClient, SYSTEM_CLOCK, buildCanonicalRequest, signCanonicalRequest } from "../../src/runtime-client.js";
import { ConfigRegistry } from "../../src/config.js";
import { createLogger } from "../../src/logger.js";
import { createCompanyContext, type CompanyContext } from "../../src/bridge/data.js";
import { registerTools } from "../../src/tools/register.js";
import { __testing } from "../../src/worker.js";

/**
 * The Core's declared outbound intent kinds, read from the Core's own source.
 *
 * Not a copy. A copy is a table that silently goes stale the moment the Core gains a kind, and a
 * stale table is exactly how an intent gets dropped without a trace. Reading the declaration means a
 * new Core kind fails this test until the bridge says what it does with it.
 */
export function coreOutboxKinds(): string[] {
  const source = readFileSync(
    new URL(
      "../../../../services/polyforge/src/polyforge/core/runtime/engine.py",
      import.meta.url,
    ),
    "utf8",
  );
  const block = /OUTBOX_KINDS: tuple\[str, \.\.\.\] = \(([\s\S]*?)\)/.exec(source);
  if (block === null) throw new Error("could not find OUTBOX_KINDS in the Core's engine.py");
  return [...block[1]!.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
}

export const SHARED_SECRET = "test-shared-secret-not-a-real-one";
export const ISSUER = "polyforge-bridge-test";
export const AUDIENCE = "polyforge-runtime";
export const COMPANY_A = "company-a";
export const COMPANY_B = "company-b";
export const PROJECT_A = "project-a";
export const PROJECT_B = "project-b";
export const GRAPH_ID = "graph-test";
/** The mount point the fake Runtime serves under; the signed path is relative to it. */
const API_BASE = "/v1";
export const ENTRYPOINT = "test.start";

const manifest = manifestJson;

// ---------------------------------------------------------------------------
// The fake Runtime Service
// ---------------------------------------------------------------------------

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  bodyText: string;
  canonicalRequest: string | null;
  signatureValid: boolean;
  responseStatus: number;
}

export interface FaultRule {
  readonly match: (request: RecordedRequest) => boolean;
  /**
   * `hang` never answers, which is exactly how a transport timeout is produced.
   *
   * `hangAfterCommit` is the dangerous variant: the request is fully handled — state committed —
   * and *then* the response is withheld. That is the only way a write can land without the caller
   * knowing, and the only way to test that the bridge reconciles instead of resending.
   */
  readonly kind: "hang" | "hangAfterCommit" | "status";
  readonly status?: number;
  readonly body?: unknown;
  /** How many matching requests the rule applies to. Defaults to 1; `Infinity` for sticky. */
  readonly times?: number;
  /** `false` makes the fault fire before the signature is checked. */
  readonly afterSignatureCheck?: boolean;
}

export interface RouteResult {
  status: number;
  body: unknown;
}

export type RouteHandler = (ctx: {
  request: RecordedRequest;
  body: Record<string, unknown>;
  server: FakeRuntime;
}) => RouteResult | null;

/**
 * A real HTTP server standing in for the PolyForge Runtime Service.
 *
 * It recomputes the canonical request from the exact bytes it received and compares the
 * signature, so a divergence between the TypeScript and Python canonical encoders shows up as a
 * `401` here rather than as a production `401` nobody can reproduce.
 */
export class FakeRuntime {
  readonly requests: RecordedRequest[] = [];
  readonly intake: Record<string, unknown>[] = [];
  readonly runs = new Map<string, Record<string, unknown>>();
  readonly runIdByStartIntent = new Map<string, string>();
  /**
   * Intents the Core has queued, as `GET /v1/bridge/outbox` would return them.
   *
   * The fake holds them so a test can decide *when* they are claimable, which is how the lease
   * behaviour is exercised: a claim the bridge fails to acknowledge has to come back around, or a
   * crash would strand the intent forever.
   */
  readonly coreIntents: {
    intentId: string;
    kind: string;
    runId: string | null;
    nodeId: string | null;
    correlationKey: string;
    payload: Record<string, unknown>;
    deliveryAttempt: number;
    maxDeliveryAttempts: number;
    claimed: boolean;
  }[] = [];

  /** Queue one outbound intent, as the Core does when a node becomes READY. */
  queueCoreIntent(intent: {
    intentId: string;
    kind: string;
    runId: string | null;
    nodeId: string | null;
    correlationKey: string;
    payload: Record<string, unknown>;
    deliveryAttempt: number;
    maxDeliveryAttempts: number;
  }): void {
    this.coreIntents.push({ ...intent, claimed: false });
  }

  /** What the Core would hand back for a claim: the unacknowledged intents, oldest first. */
  claimCoreIntents(): Record<string, unknown>[] {
    const pending = this.coreIntents.filter((intent) => !intent.claimed);
    for (const intent of pending) intent.claimed = true;
    return pending.map((intent) => ({ ...intent, claimOwner: "fake-core" }));
  }

  /** What the bridge acknowledged to the Core, so a test can assert the outcome it reported. */
  readonly coreAcks: { intentId: string; body: Record<string, unknown> }[] = [];

  /** Reviews the Core was asked to record, so a test can assert one really was persisted. */
  readonly reviews: { path: string; body: Record<string, unknown>; reviewer: string; actorHeader: string }[] = [];

  /** Current contract returned by `GET /runs/{id}/current`, keyed by run id. */
  readonly contracts = new Map<string, Record<string, unknown>>();
  /** Graph definitions, so an admission that names a graph can resolve its entrypoint. */
  readonly graphs = new Map<string, Record<string, unknown>>([
    [
      GRAPH_ID,
      {
        graphId: GRAPH_ID,
        name: "Test graph",
        entrypoints: { [ENTRYPOINT]: { key: ENTRYPOINT, startNodes: ["n1"] } },
        nodePolicies: [],
        nodes: [],
        edges: [],
      },
    ],
  ]);
  /** Recorded claim bodies, so a test can assert the epoch the Core granted. */
  readonly claims: Record<string, unknown>[] = [];
  /** The bodies of the four write commands, in the order the Core received them. */
  readonly commands: { kind: string; path: string; body: Record<string, unknown> }[] = [];
  /** The Core's live lease per `run|node|iteration`. */
  readonly leases = new Map<
    string,
    { leaseEpoch: number; attemptId: string; agentRunId: string; agentSubject: string; expiresAtMs: number }
  >();
  /** How long a claim stays live. Tests age it with `advanceClock` or `expireLeases`. */
  leaseTtlMs = 90_000;
  clockMs = 1_700_000_000_000;
  #faults: FaultRule[] = [];
  #routes: RouteHandler[] = [];
  #server: Server | null = null;
  #url = "";

  async start(): Promise<string> {
    this.#server = createServer((req, res) => {
      void this.#handle(req, res);
    });
    await new Promise<void>((resolve) => {
      this.#server!.listen(0, "127.0.0.1", () => resolve());
    });
    const address = this.#server!.address() as AddressInfo;
    this.#url = `http://127.0.0.1:${address.port}`;
    return this.#url;
  }

  get url(): string {
    return this.#url;
  }

  async stop(): Promise<void> {
    if (this.#server === null) return;
    await new Promise<void>((resolve) => {
      this.#server!.close(() => resolve());
    });
    this.#server = null;
  }

  addFault(rule: FaultRule): void {
    this.#faults.push(rule);
  }

  clearFaults(): void {
    this.#faults = [];
    this.#routes = [];
  }

  route(handler: RouteHandler): void {
    this.#routes.unshift(handler);
  }

  requestsTo(method: string, pathFragment: string): RecordedRequest[] {
    return this.requests.filter((entry) => entry.method === method && entry.path.includes(pathFragment));
  }

  seedRun(runId: string, run: Record<string, unknown> = {}): void {
    this.runs.set(runId, { ...run, runId });
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const bodyText = Buffer.concat(chunks).toString("utf8");
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      headers[key.toLowerCase()] = Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
    }
    // A probe request (used by `ready`) is answered without a signature check so the test can
    // tell "the server is listening" from "the bridge can sign".
    if (headers["x-pf-probe"] !== undefined) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    const method = req.method ?? "GET";
    const path = req.url ?? "/";
    const verification = this.#verify(method, path, headers, bodyText);
    const record: RecordedRequest = {
      method,
      path,
      headers,
      bodyText,
      canonicalRequest: verification.canonical,
      signatureValid: verification.valid,
      responseStatus: 0,
    };
    this.requests.push(record);

    if (!verification.valid) {
      record.responseStatus = 401;
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "AUTHORIZATION_DENIED", message: "signature verification failed" } }));
      return;
    }

    const fault = this.#takeFault(record, true);
    if (fault === "hang") return;
    if (fault === "hangAfterCommit") {
      // Handle the request for real — the state change lands — and then never answer. This is the
      // only faithful model of "the write committed but the caller never found out".
      const result = this.#respond(record, safeParse(bodyText));
      record.responseStatus = result.status;
      return;
    }
    if (fault !== null) {
      record.responseStatus = fault.status;
      res.writeHead(fault.status, { "content-type": "application/json" });
      res.end(JSON.stringify(fault.body));
      return;
    }

    const body = safeParse(bodyText);
    const result = this.#respond(record, body);
    record.responseStatus = result.status;
    res.writeHead(result.status, { "content-type": "application/json" });
    res.end(JSON.stringify(result.body));
  }

  /**
   * Recompute the canonical request from the bytes this server received and compare the
   * signature.
   *
   * The body hash is taken over the *received* text, so a request whose body was mutated in
   * flight fails here even when every header survived. A missing header fails too. That is the
   * whole of docs/05 §1.1, checked on every request rather than asserted once.
   */
  #verify(
    method: string,
    path: string,
    headers: Record<string, string>,
    bodyText: string,
  ): { canonical: string | null; valid: boolean } {
    const issuer = headers["x-pf-issuer"];
    const timestamp = headers["x-pf-timestamp"];
    const nonce = headers["x-pf-nonce"];
    const actorHeader = headers["x-pf-actor"];
    const scopeHeader = headers["x-pf-scope"];
    const signature = headers["x-pf-signature"];
    if (!issuer || !timestamp || !nonce || !actorHeader || !scopeHeader || !signature) {
      return { canonical: null, valid: false };
    }
    let actor: unknown;
    let scope: unknown;
    try {
      actor = actorToWire(
        JSON.parse(Buffer.from(actorHeader, "base64url").toString("utf8")) as Parameters<typeof actorToWire>[0],
      );
      scope = JSON.parse(Buffer.from(scopeHeader, "base64url").toString("utf8")) as unknown;
    } catch {
      return { canonical: null, valid: false };
    }
    // The signed path is the request target *relative to the API base*, which is what
    // `canonical_request_bytes` on the Core side verifies. The harness deliberately strips the
    // prefix rather than reusing whatever the client signed: a fake verifier that agrees with the
    // client by construction cannot notice the two disagreeing, and that is exactly the bug this
    // fake existed to catch. So the harness models the *verifier*, and the verifier's rule is the
    // protocol's rule.
    const [routePath, query = ""] = path.split("?", 2);
    const signedPath = (routePath ?? "/").startsWith(API_BASE)
      ? (routePath ?? "/").slice(API_BASE.length)
      : routePath ?? "/";
    const canonicalRequest = buildCanonicalRequest({
      audience: headers["x-pf-audience"] ?? AUDIENCE,
      method,
      path: query.length > 0 ? `${signedPath}?${query}` : signedPath,
      bodyHash: bodyText.length === 0 ? digestBytes(new Uint8Array(0)) : digestBytes(new TextEncoder().encode(bodyText)),
      timestamp,
      nonce,
      issuer,
      actor: actor as never,
      scope: scope as never,
    });
    return { canonical: canonicalRequest, valid: signCanonicalRequest(canonicalRequest, SHARED_SECRET) === signature };
  }

  #takeFault(request: RecordedRequest, afterSignatureCheck: boolean): "hang" | "hangAfterCommit" | RouteResult | null {
    for (let index = 0; index < this.#faults.length; index += 1) {
      const rule = this.#faults[index]!;
      if ((rule.afterSignatureCheck ?? true) !== afterSignatureCheck) continue;
      if (!rule.match(request)) continue;
      const times = rule.times ?? 1;
      if (times === 0) {
        // The budget is spent: drop the rule so it stops firing. Leaving a zero-`times` rule in
        // place would make a "once" fault permanent, which silently invalidates the test.
        this.#faults.splice(index, 1);
        continue;
      }
      if (times !== Infinity) this.#faults[index] = { ...rule, times: times - 1 };
      if (rule.kind === "hang") return "hang";
      if (rule.kind === "hangAfterCommit") return "hangAfterCommit";
      return { status: rule.status ?? 500, body: rule.body ?? { error: { code: "INTERNAL", message: "injected fault" } } };
    }
    return null;
  }

  #respond(record: RecordedRequest, body: Record<string, unknown>): RouteResult {
    for (const handler of this.#routes) {
      const result = handler({ request: record, body, server: this });
      if (result !== null) return result;
    }
    return this.#default(record, body);
  }

  #default(record: RecordedRequest, body: Record<string, unknown>): RouteResult {
    const { method, path } = record;
    if (method === "GET" && path === "/v1/health") {
      return { status: 200, body: this.healthReport() };
    }
    if (method === "POST" && path === "/v1/work-orders") {
      return this.#createWorkOrder(body);
    }
    if (method === "POST" && path === "/v1/events") {
      this.intake.push(body);
      return {
        status: 202,
        body: {
          commandId: `cmd-intake-${this.intake.length}`,
          applied: true,
          stateVersion: this.intake.length,
          status: "recorded",
          pending: true,
          pendingReason: "GATE_PENDING",
          blockers: [],
        },
      };
    }
    if (method === "GET" && path.split("?")[0] === "/v1/graphs") {
      return { status: 200, body: { graphs: [...this.graphs.values()] } };
    }
    if (method === "GET" && path.split("?")[0] === "/v1/runs") {
      const scope = JSON.parse(Buffer.from(record.headers["x-pf-scope"] ?? "e30", "base64url").toString("utf8")) as Record<string, unknown>;
      const projectRef = scope["projectRef"];
      const runs = [...this.runs.keys()]
        .map((runId) => this.runSnapshot(runId))
        .filter((run) => (run["scope"] as Record<string, unknown> | undefined)?.["projectRef"] === projectRef);
      return { status: 200, body: { runs } };
    }
    if (method === "GET" && path.startsWith("/v1/runs/") && path.split("?")[0]?.endsWith("/current") === true) {
      const base = path.split("?")[0] ?? "";
      const runId = decodeURIComponent(base.slice("/v1/runs/".length, -"/current".length));
      const contract = this.contracts.get(runId);
      if (contract === undefined) {
        return { status: 404, body: { error: { code: "NOT_FOUND", message: "no contract for this run" } } };
      }
      return { status: 200, body: this.#withLease(contract) };
    }
    /**
     * Recording a review. The fake stores the reviewer and the target hash and hands back a draft,
     * because what matters is that the *Core* ends up holding the review — the editor's own state is
     * not evidence of anything. The reviewer is decoded from the asserted actor, exactly as the real
     * Core records it, so a fake that echoed something else could not let a test pass while
     * production answered differently.
     */
    // The Core's outbound queue, at the path the Core actually serves. The bridge used to ask for
    // `/v1/outbox`, which 404s — so nothing was ever claimed while the bridge's own queue drained
    // happily, and a Root Issue's nodes were never worked.
    if (method === "GET" && (path.split("?")[0] ?? "").endsWith("/bridge/outbox")) {
      const intents = this.claimCoreIntents();
      return { status: 200, body: { intents, count: intents.length, leaseSeconds: 900 } };
    }
    if (method === "POST" && /\/v1\/bridge\/outbox\/[^/]+\/delivery$/.test(path.split("?")[0] ?? "")) {
      const intentId = decodeURIComponent((path.split("?")[0] ?? "").split("/")[4] ?? "");
      const record = this.coreIntents.find((intent) => intent.intentId === intentId);
      if (record === undefined) {
        return { status: 404, body: { error: { code: "NOT_FOUND", message: "no such outbox intent" } } };
      }
      record.claimed = false;
      this.coreAcks.push({ intentId, body });
      return { status: 200, body: { intentId, state: String(body["state"] ?? ""), recorded: true } };
    }
    if (method === "POST" && /\/v1\/drafts\/[^/]+\/reviews$/.test(path.split("?")[0] ?? "")) {
      const target = String(body["reviewTargetHash"] ?? "");
      if (target.length === 0) {
        return {
          status: 400,
          body: { error: { code: "BAD_REQUEST", message: "reviewTargetHash is required" } },
        };
      }
      const actorHeader = String(record.headers["x-pf-actor"] ?? "");
      let reviewer = "unknown";
      try {
        const decoded = JSON.parse(Buffer.from(actorHeader, "base64url").toString("utf8")) as {
          actorId?: unknown;
        };
        if (typeof decoded.actorId === "string" && decoded.actorId.length > 0) reviewer = decoded.actorId;
      } catch {
        reviewer = "unknown";
      }
      this.reviews.push({ path, body, reviewer, actorHeader });
      const draftId = decodeURIComponent((path.split("?")[0] ?? "").split("/")[3] ?? "");
      return {
        status: 200,
        body: {
          draftId,
          revision: 1,
          reviewTargetHash: target,
          reviewReviewer: reviewer,
          reviewRevision: 1,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      };
    }
    if (method === "POST" && path.startsWith("/v1/runs/") && path.split("?")[0]?.endsWith("/claims") === true) {
      return this.#claimLease(path.split("?")[0] ?? "", body);
    }
    // The four write commands. Each records the exact signed body and answers with a *pending*
    // result, which is the shape the Core returns while a gate is still open: applied to the
    // queue, not committed to the graph. A test that wanted a commit would have to say so
    // explicitly with `route`.
    for (const [suffix, kind] of [
      ["/artifacts", "ARTIFACT"],
      ["/evidence", "EVIDENCE"],
      ["/transitions", "TRANSITION"],
      ["/help", "HELP"],
    ] as const) {
      if (method === "POST" && path.split("?")[0]?.endsWith(suffix) === true) {
        this.commands.push({ kind, path, body });
        return {
          status: 202,
          body: {
            commandId: String(body["commandId"] ?? `cmd-${kind}`),
            applied: true,
            stateVersion: Number(body["expectedStateVersion"] ?? 1) + 1,
            status: "PENDING",
            pending: true,
            pendingReason: "GATE_PENDING",
            blockers: [],
          },
        };
      }
    }
    if (method === "GET" && path.startsWith("/v1/runs/")) {
      const base = path.split("?")[0] ?? "";
      const runId = decodeURIComponent(base.slice("/v1/runs/".length));
      if (!this.runs.has(runId)) {
        return { status: 404, body: { error: { code: "NOT_FOUND", message: "no such run" } } };
      }
      return { status: 200, body: this.runSnapshot(runId) };
    }
    return { status: 404, body: { error: { code: "NOT_FOUND", message: `unhandled ${method} ${path}` } } };
  }

  /**
   * The Core's lease, kept per (run, node, iteration).
   *
   * A claim presents the *new* epoch. A different owner is refused unless the trusted bridge has
   * a stop observation from the Paperclip work port; lease expiry by itself is not evidence that
   * the old worker stopped. This mirrors RuntimeEngine._claim_tx rather than a bridge-side model.
   */
  #claimLease(path: string, body: Record<string, unknown>): RouteResult {
    const runId = decodeURIComponent(path.slice("/v1/runs/".length, -"/claims".length));
    if (!this.runs.has(runId)) {
      return { status: 404, body: { error: { code: "NOT_FOUND", message: "no such run" } } };
    }
    const nodeId = String(body["nodeId"] ?? "");
    const iteration = Number(body["iteration"] ?? 0);
    const key = `${runId}|${nodeId}|${iteration}`;
    const held = this.leases.get(key);
    const currentEpoch = held?.leaseEpoch ?? Number(this.contracts.get(runId)?.["leaseEpoch"] ?? 0);
    const presented = Number(body["leaseEpoch"] ?? -1);
    const agentRunRef = body["agentRunRef"] as { id?: unknown } | undefined;
    const caller = String(agentRunRef?.id ?? "");

    const replacingOwner = held !== undefined && held.agentRunId !== caller;
    const priorWorkerState = body["priorWorkerState"];
    if (replacingOwner && priorWorkerState !== "stopped" && priorWorkerState !== "fenced") {
      this.claims.push({ ...body, granted: false, reason: "STOP_UNCONFIRMED", currentEpoch });
      return {
        status: 409,
        body: {
          error: {
            code: "LEASE_FENCED",
            message: "the previous worker must be confirmed stopped or fenced before takeover",
          },
          leaseEpoch: currentEpoch,
        },
      };
    }
    if (presented !== currentEpoch + 1) {
      this.claims.push({ ...body, granted: false, presentedLeaseEpoch: presented, currentEpoch });
      return {
        status: 409,
        body: {
          error: {
            code: "LEASE_FENCED",
            message: `the next lease epoch is ${currentEpoch + 1}, not ${presented}`,
          },
          leaseEpoch: currentEpoch,
        },
      };
    }
    const nextEpoch = presented;
    const attemptId = `attempt-${nextEpoch}`;
    this.leases.set(key, {
      leaseEpoch: nextEpoch,
      attemptId,
      agentRunId: caller,
      agentSubject: String(body["agentSubject"] ?? ""),
      expiresAtMs: this.nowMs() + this.leaseTtlMs,
    });
    this.claims.push({
      ...body,
      submittedAttemptId: body["attemptId"],
      granted: true,
      presentedLeaseEpoch: presented,
      grantedEpoch: nextEpoch,
      attemptId,
    });
    const contract = this.contracts.get(runId);
    if (contract !== undefined) {
      this.contracts.set(runId, {
        ...contract,
        leaseEpoch: nextEpoch,
        attemptId,
        previousOwnerAgentRunId: caller || null,
      });
    }
    return {
      status: 202,
      body: {
        commandId: String(body["commandId"] ?? `cmd-${nextEpoch}`),
        applied: true,
        stateVersion: Number(contract?.["stateVersion"] ?? 1) + 1,
        status: "CLAIMED",
        pending: false,
        leaseEpoch: nextEpoch,
        attemptId,
      },
    };
  }

  /** Age the Core's clock, so an expiring lease really expires. */
  advanceClock(ms: number): void {
    this.clockMs += ms;
  }

  nowMs(): number {
    return this.clockMs;
  }

  /** Expire every live lease at once, without waiting for the clock. */
  expireLeases(): void {
    for (const held of this.leases.values()) held.expiresAtMs = this.nowMs() - 1;
  }

  /**
   * The `current` response, in the shape the **Core** actually sends.
   *
   * This fake used to answer with a flat object carrying `contractHash`, `attemptId`, `leaseEpoch`
   * and `requiredInputs` at the top level — which is not what the Core returns. The Core nests them
   * under `contract` and `attempt`. Because the fake agreed with the bridge's assumption, both were
   * wrong together and the suite passed while every real request would have arrived with an empty
   * contract: a null hash, no required inputs, no permitted outputs, no evidence requirements and
   * an empty policy.
   *
   * So the fake models the Core, not the bridge. Where the two disagree, this file is the thing that
   * has to change.
   */
  #withLease(contract: Record<string, unknown>): Record<string, unknown> {
    const runId = String(contract["runId"] ?? "");
    const nodeId = String(contract["nodeId"] ?? "");
    const iteration = Number(contract["iteration"] ?? 0);
    const held = this.leases.get(`${runId}|${nodeId}|${iteration}`);

    const attempt =
      held === undefined
        ? null
        : {
            attemptId: held.attemptId,
            runId,
            nodeId,
            iteration,
            attemptNo: 1,
            status: "ACTIVE",
            leaseEpoch: held.leaseEpoch,
            leaseState: "HELD",
            agentSubject: held.agentRunId || null,
            agentRunRef: held.agentRunId ? { provider: "paperclip", kind: "agent_run", id: held.agentRunId } : null,
            previousOwnerAgentRunId: held.agentRunId || null,
            startedAt: "2026-01-01T00:00:00.000Z",
            finishedAt: null,
            leaseExpiresAt: new Date(held.expiresAtMs).toISOString(),
            checkpointRef: null,
          };

    return {
      runId,
      nodeId,
      iteration,
      stateVersion: Number(contract["stateVersion"] ?? 0),
      status: String(contract["status"] ?? "READY"),
      attempt,
      contract: {
        nodeId,
        iteration,
        operation: { id: "op-1", version: 1 },
        subject: {},
        inputs: contract["requiredInputs"] ?? {},
        effectivePolicy: contract["policyConstraints"] ?? {},
        authority: {},
        environment: {},
        intendedMutations: contract["permittedOutputs"] ?? [],
        requiredEvidenceKinds: contract["evidenceRequirements"] ?? [],
        requiredEvaluators: [],
        planHash: String(contract["planHash"] ?? "sha256:plan"),
        graphId: String(contract["graphId"] ?? "graph-test"),
        graphVersion: 1,
        definitionHash: String(contract["definitionHash"] ?? "sha256:definition"),
        dependencyLockHash: "sha256:lock",
        compilerVersion: "polyforge-compiler/1.0.0",
        contractHash: String(contract["contractHash"] ?? ""),
        contractId: "ctr-1",
        contractSchemaVersion: 1,
        schemaVersion: 1,
      },
      inputs: {},
      pendingGovernance: [],
      // The superseded attempt's agent run, and whether a claim is possible right now. Both are
      // real fields the Core sends for exactly this reason: a caller adopting a node has to know
      // whose attempt it would be taking, and `attempt` alone only describes the current holder.
      previousOwnerAgentRunId:
        typeof contract["previousOwnerAgentRunId"] === "string" ? contract["previousOwnerAgentRunId"] : null,
      // The Core's question is "can *you* claim this", not "is anyone holding it": a run
      // re-entering its own live claim must still be able to read it. A test that wants a
      // refusal seeds `claimable: false` explicitly.
      claimable: contract["claimable"] !== false,
      // A seeded contract may state its own permitted actions, and a test that seeds one is
      // asserting about that node's situation. The Core's own derivation is only the fallback.
      permittedActions: Array.isArray(contract["permittedActions"])
        ? (contract["permittedActions"] as string[])
        : attempt === null
          ? ["polyforge.current", "polyforge.status"]
          : [
              "polyforge.current",
              "polyforge.status",
              "polyforge.request_transition",
              "polyforge.submit_artifact",
              "polyforge.submit_evidence",
              "polyforge.request_help",
            ],
    };
  }

  #createWorkOrder(body: Record<string, unknown>): RouteResult {
    // The Core's own idempotency: one run per (scope, startIntentId, entrypoint). This is the
    // property AT-02 ultimately relies on, and reproducing it here is what makes a 100× replay
    // test meaningful rather than a test of the bridge's dedupe alone.
    const startIntentId = String(body["startIntentId"] ?? "");
    const existing = this.runIdByStartIntent.get(startIntentId);
    if (existing !== undefined) {
      return { status: 200, body: { ...this.runSnapshot(existing), replayed: true } };
    }
    const runId = `run-${this.runs.size + 1}`;
    this.runIdByStartIntent.set(startIntentId, runId);
    this.runs.set(runId, { ...body, runId, workOrderId: `wo-${runId}`, graphVersion: 1 });
    return { status: 201, body: this.runSnapshot(runId) };
  }

  healthReport(): Record<string, unknown> {
    return {
      status: "ready",
      protocolVersion: 1,
      schemaVersion: 1,
      compilerVersion: "test-1.0.0",
      database: { ok: true },
      store: { runs: this.runs.size, outboxPending: 0, unknownEffects: 0 },
      bridge: { issuer: ISSUER, expectedIssuer: ISSUER, compatible: true },
      checkedAt: new Date().toISOString(),
    };
  }

  runSnapshot(runId: string): Record<string, unknown> {
    const run = this.runs.get(runId) ?? {};
    return {
      runId,
      familyId: `fam-${runId}`,
      workOrderId: run["workOrderId"] ?? `wo-${runId}`,
      graphId: run["graphId"] ?? GRAPH_ID,
      graphVersion: run["graphVersion"] ?? 1,
      status: run["status"] ?? "ACTIVE",
      stateVersion: run["stateVersion"] ?? 1,
      eventSequence: run["eventSequence"] ?? 1,
      ownerEpoch: 1,
      entrypoint: run["entrypoint"] ?? ENTRYPOINT,
      parentRunId: null,
      parentNodeId: null,
      invocationGeneration: 0,
      scope: run["scope"] ?? { companyRef: COMPANY_A, projectRef: PROJECT_A },
      pins: run["pins"] ?? { startIntentId: run["startIntentId"] ?? "", graph: `${GRAPH_ID}@1` },
      nodes: run["nodes"] ?? [],
      attempts: run["attempts"] ?? [],
      gates: [],
      evidence: run["evidence"] ?? [],
      pendingGovernance: run["pendingGovernance"] ?? [],
      effects: [],
      blockers: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
}

export function safeParse(text: string): Record<string, unknown> {
  if (text.length === 0) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The config shape `createCompanyContext` hands to `makeRuntime`. */
type BridgeConfigLike = Parameters<Parameters<typeof createCompanyContext>[0]["makeRuntime"]>[0];
/** The signature `ctx.tools.register` hands the bridge, captured so a test can invoke it. */
type ToolHandlerFn = (params: unknown, runCtx: ToolRunContext) => Promise<ToolResult>;

// ---------------------------------------------------------------------------
// The assembled bridge under test
// ---------------------------------------------------------------------------

export interface SeedOptions {
  readonly companies?: Company[];
  readonly projects?: Project[];
  readonly issues?: Issue[];
  readonly agents?: Agent[];
  readonly projectWorkspaces?: PluginWorkspace[];
}

export interface BuildOptions {
  readonly companyId?: string;
  /**
   * Additional companies to build a bundle for.
   *
   * The worker is multi-company, so a test that only ever has one bundle would never exercise
   * the path where a second tenant is configured and a tool call arrives for it.
   */
  readonly extraCompanyIds?: string[];
  readonly extraConfig?: Record<string, unknown>;
  readonly seed?: SeedOptions;
  /** Configure the fake runtime before the company bundle is built. */
  readonly configureRuntime?: (runtime: FakeRuntime) => void;
  /** Register the six `polyforge.*` tools on the harness context. Defaults to `true`. */
  readonly registerTools?: boolean;
  /** Epoch ms the bridge's clock starts at. Defaults to a fixed, readable instant. */
  readonly startTimeMs?: number;
  /**
   * How the bridge obtains the shared signing secret.
   *
   * Defaults to the harness's `secretProvider`, which is the same shape production wires to
   * `ctx.secrets.resolve`. A test overrides it to prove the bridge's behaviour when resolution
   * *fails* — the case that must never degrade into an unsigned request.
   */
  readonly resolveSecret?: () => Promise<string>;
}

export interface TestBridge {
  readonly harness: TestHarness;
  readonly ctx: PluginContext;
  readonly runtime: FakeRuntime;
  readonly company: CompanyContext;
  /** Every company bundle, so a test can drive a multi-tenant worker. */
  readonly companies: Map<string, CompanyContext>;
  readonly companyId: string;
  readonly store: BridgeStore;
  /** The bridge's own durable directory, so a test can inspect what actually reached disk. */
  readonly stateDir: string;
  readonly pump: OutboxPump;
  readonly eventPump: EventPump;
  /** Companies the event pump asked the bridge to learn, in order. */
  readonly learnedCompanies: string[];
  readonly metrics: BridgeMetrics;
  readonly logs: { level: string; message: string; meta?: Record<string, unknown> }[];
  /**
   * The tool names the bridge registered, with the declarations it registered them under.
   *
   * `ctx.tools.register` is the SDK's registration surface and `harness.executeTool` is its
   * invocation surface, so the declarations are captured (the host exposes no getter) while the
   * call itself goes through the host's own dispatch. What that does **not** cover: the host's
   * schema validation and its derivation of a real `ToolRunContext` from a live agent run — the
   * test supplies the run context, because the harness has no agent-run lifecycle to derive it
   * from.
   */
  readonly tools: Map<string, { declaration: Record<string, unknown>; handler: ToolHandlerFn }>;
  callTool(name: string, params: unknown, runCtx: ToolRunContext): Promise<ToolResult>;
  /** Move the bridge's clock forward, so a lease or a backoff really expires. */
  advanceClock(ms: number): void;
  /** Drain every queued intent for this company through the real pump. */
  drain(): Promise<void>;
  counters(): Record<string, unknown>;
  dispose(): Promise<void>;
}

/**
 * Build a fully wired bridge against the SDK test harness and a real fake Runtime.
 *
 * The shared secret is supplied through the harness's secret provider, i.e. the same
 * `ctx.secrets.resolve` path production uses, so a test that resolves the reference exercises
 * the real resolution order rather than a bypass.
 */
export async function buildBridge(options: BuildOptions = {}): Promise<TestBridge> {
  const companyId = options.companyId ?? COMPANY_A;
  const tempDir = mkdtempSync(join(tmpdir(), "pf-bridge-test-"));

  const runtime = new FakeRuntime();
  const url = await runtime.start();
  options.configureRuntime?.(runtime);

  const logs: { level: string; message: string; meta?: Record<string, unknown> }[] = [];
  /** Companies the event pump asked the bridge to learn, in order. */
  const learned: string[] = [];
  const learnedCompanies: string[] = learned;
  let tools = new Map<string, { declaration: Record<string, unknown>; handler: ToolHandlerFn }>();
  const config: Record<string, unknown> = {
    runtimeUrl: url,
    bridgeIssuer: ISSUER,
    audience: AUDIENCE,
    sharedSecretRef: { type: "secret_ref", secretId: "pf-bridge-test" },
    stateDir: tempDir,
    // The fake Runtime listens on loopback, which the SSRF guard refuses by default.
    allowPrivateRuntimeHost: true,
    defaultGraphId: GRAPH_ID,
    engineeringEntryLabel: "engineering",
    engineeringOriginPrefix: "polyforge",
    workspaceProviderMode: "metadata_only",
    enableProjections: true,
    logLevel: "debug",
    ...(options.extraConfig ?? {}),
  };

  const harness = createTestHarness({ manifest, config });
  // The harness logger is replaced with a collector, so a test can assert that a secret, a
  // prompt body, or a raw actor assertion never appears in a log line.
  harness.ctx.logger.info = (message, meta) => {
    logs.push({ level: "info", message, ...(meta === undefined ? {} : { meta }) });
  };
  harness.ctx.logger.warn = (message, meta) => {
    logs.push({ level: "warn", message, ...(meta === undefined ? {} : { meta }) });
  };
  harness.ctx.logger.error = (message, meta) => {
    logs.push({ level: "error", message, ...(meta === undefined ? {} : { meta }) });
  };
  harness.ctx.logger.debug = (message, meta) => {
    logs.push({ level: "debug", message, ...(meta === undefined ? {} : { meta }) });
  };

  if (options.seed !== undefined) harness.seed(options.seed);

  // One clock for the store, the recorder and the pump, so a test that needs time to pass does it
  // by advancing this rather than by sleeping. Sleeping makes lease and backoff tests both slow
  // and flaky, and a test that has to wait 5ms to observe an expiry is not asserting much.
  let clockMs = options.startTimeMs ?? 1_700_000_000_000;
  const now = (): Date => new Date(clockMs);
  const advanceClock = (ms: number): void => {
    clockMs += ms;
  };

  const store = BridgeStore.open({ path: join(tempDir, "bridge.sqlite"), now });
  const metrics = new BridgeMetrics(store);
  const capabilities = new CapabilityMatcher(store);
  const logger = createLogger(harness.ctx.logger, "debug");
  const inbox = new Inbox(store, metrics, logger);
  const deliveries = new StoreDeliveryRecorder(store, now, logger);
  const registry = new ConfigRegistry(tempDir, "test");
  const pump = new OutboxPump({
    store,
    logger,
    metrics,
    now,
    ownerId: "test-worker",
    // Fixed jitter so a backoff assertion is deterministic.
    jitter: () => 0.5,
  });

  const factory = {
    ctx: harness.ctx,
    store,
    metrics,
    capabilities,
    inbox,
    deliveries,
    pump,
    logger,
    registry,
    makeRuntime: (cfg: BridgeConfigLike, id: string) =>
      new RuntimeClient(cfg, {
        secretProvider: options.resolveSecret ?? (async () => SHARED_SECRET),
        clock: SYSTEM_CLOCK,
        logger,
        // The harness's `http.fetch` delegates to global fetch, so the signature really
        // travels over a socket and is really verified by the fake Runtime.
        fetchImpl: (requestUrl, init) => harness.ctx.http.fetch(requestUrl, init),
        nonceLedger: store,
        companyId: id,
      }),
  };

  const company = createCompanyContext(factory, companyId, config);
  const companies = new Map<string, CompanyContext>([[companyId, company]]);
  for (const extra of options.extraCompanyIds ?? []) {
    companies.set(extra, createCompanyContext(factory, extra, config));
  }
  if (options.registerTools !== false) {
    // `ctx.tools.register` is the only tool surface the SDK test harness offers — there is no
    // `callTool` — so the registration is wrapped to keep the handler callable. This drives the
    // production handler; it does not stand in for the host's schema validation or its
    // derivation of the run context.
    const registered = new Map<string, { declaration: Record<string, unknown>; handler: ToolHandlerFn }>();
    const originalRegister = harness.ctx.tools.register.bind(harness.ctx.tools);
    harness.ctx.tools.register = ((
      name: string,
      declaration: Record<string, unknown>,
      fn: ToolHandlerFn,
    ): void => {
      registered.set(name, { declaration: declaration as unknown as Record<string, unknown>, handler: fn });
      originalRegister(name, declaration as never, fn as never);
    }) as typeof harness.ctx.tools.register;
    registerTools(
      harness.ctx,
      __testing.toolDepsFor({
        store,
        metrics,
        logger,
        company: (id: string) => companies.get(id) ?? null,
        issueExecution: async (id: string, issueId: string) => {
          const record = await harness.ctx.issues.get(issueId, id);
          if (record === null) return null;
          return {
            companyId: record.companyId,
            projectId: record.projectId,
            assigneeAgentId: record.assigneeAgentId,
            executionRunId: record.executionRunId,
            status: record.status,
          };
        },
      }),
    );
    tools = registered;
  }

  // The real outbox handler table, so a test that drains the pump exercises the production
  // delivery path rather than a stub.
  __testing.registerIntentHandlers(pump, (id: string) => companies.get(id) ?? null);

  const eventPump = new EventPump({
    ctx: harness.ctx,
    store,
    inbox,
    logger,
    metrics,
    enqueue: (input) => deliveries.begin(input),
    runtimeAvailable: () => true,
    learnCompany: (companyId) => {
      learnedCompanies.push(companyId);
    },
  });

  return {
    harness,
    ctx: harness.ctx,
    runtime,
    company,
    companies,
    companyId,
    store,
    stateDir: tempDir,
    pump,
    eventPump,
    learnedCompanies: learned,
    metrics,
    logs,
    tools,
    async callTool(name: string, params: unknown, runCtx: ToolRunContext): Promise<ToolResult> {
      if (!tools.has(name)) throw new Error(`no tool named ${name} is registered`);
      // Through the host's own dispatch, so the registered handler is reached the way the host
      // would reach it rather than by calling the captured function directly.
      return (await harness.executeTool(name, params, runCtx as unknown as Record<string, unknown>)) as ToolResult;
    },
    advanceClock,
    async drain() {
      await pump.pumpOnce([...companies.keys()]);
    },
    counters() {
      return metrics.counters(companyId) as unknown as Record<string, unknown>;
    },
    async dispose() {
      store.close();
      await runtime.stop();
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

export function company(id: string): Company {
  return {
    id,
    name: `Company ${id}`,
    slug: id,
    status: "active",
    createdAt: new Date(0),
    updatedAt: new Date(0),
  } as unknown as Company;
}

export function project(id: string, companyId: string): Project {
  return { id, companyId, name: `Project ${id}`, status: "active" } as unknown as Project;
}

export function agent(id: string, companyId: string, overrides: Partial<Agent> = {}): Agent {
  return {
    id,
    companyId,
    name: `Agent ${id}`,
    role: "engineer",
    status: "idle",
    ...overrides,
  } as unknown as Agent;
}

export function issue(id: string, companyId: string, projectId: string, overrides: Partial<Issue> = {}): Issue {
  return {
    id,
    companyId,
    projectId,
    parentId: null,
    title: `Issue ${id}`,
    description: null,
    status: "todo",
    priority: "medium",
    workMode: "standard",
    reviewPolicy: null,
    assigneeAgentId: null,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    responsibleUserId: null,
    issueNumber: 1,
    identifier: `PF-${id}`,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    projectWorkspaceId: null,
    goalId: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  } as unknown as Issue;
}

export function label(name: string) {
  return { id: `label-${name}`, companyId: COMPANY_A, name, color: "#000", createdAt: new Date(0), updatedAt: new Date(0) };
}

export function workspace(id: string, projectIdValue: string, companyId: string) {
  return {
    id,
    projectId: projectIdValue,
    companyId,
    name: `Workspace ${id}`,
    path: `/srv/workspaces/${id}`,
    repoUrl: `https://example.invalid/${id}.git`,
    repoRef: "refs/heads/main",
    defaultRef: "refs/heads/main",
    isPrimary: true,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

export function executionWorkspace(id: string, projectIdValue: string, companyId: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    projectId: projectIdValue,
    companyId,
    projectWorkspaceId: `pw-${projectIdValue}`,
    path: `/srv/exec/${id}`,
    cwd: `/srv/exec/${id}`,
    repoUrl: `https://example.invalid/${id}.git`,
    baseRef: "refs/heads/main",
    branchName: `pf/${id}`,
    providerType: "worktree",
    providerMetadata: null,
    ...extra,
  };
}

/** A host event with a stable id, so a replay is byte-identical. */
export function hostEvent(
  eventType: string,
  eventId: string,
  payload: unknown,
  base: Partial<PluginEvent> = {},
): PluginEvent {
  return {
    eventId,
    eventType: eventType as PluginEvent["eventType"],
    companyId: COMPANY_A,
    occurredAt: new Date(1_700_000_000_000).toISOString(),
    payload,
    ...base,
  };
}

/**
 * Seed an extra issue after the bridge is built.
 *
 * `buildBridge`'s `seed` runs once, so a test that needs an issue the bridge itself would
 * normally create (a child work unit, a woken dispatch target) adds it here instead.
 */
export function seedChildIssue(bridge: TestBridge, issueId: string, overrides: Partial<Issue> = {}): void {
  bridge.harness.seed({
    issues: [{ ...issue(issueId, bridge.companyId, "project-a"), ...overrides }],
  });
}

/**
 * Bind a capability to an agent subject.
 *
 * Bindings live in the bridge store and are written only through this path (the operator/e2e
 * route), never derived from an agent's own configuration — a subject that could grant itself a
 * capability would make independent review meaningless. A test that dispatches work needs one.
 */
export function seedCapabilityBinding(
  bridge: TestBridge,
  companyId: string,
  subjectRef: string,
  agentId: string,
  capabilities: string[] = ["code.modify"],
): void {
  bridge.company.capabilitiesMatcher.seedBindings(companyId, [
    {
      subjectRef,
      agentId,
      projectRef: PROJECT_A,
      capabilities,
      roles: ["engineering"],
      independentSubjects: [],
      contractVersion: "1",
      enabled: true,
    },
  ]);
}

/** An interaction a human has already answered, for the governance read-back path. */export function answeredInteraction(input: {
  id: string;
  issueId: string;
  companyId: string;
  decisionTargetHash: string;
  semanticKind: string;
  status?: string;
  resolvedByUserId?: string | null;
  resolvedByAgentId?: string | null;
  options?: { id: string; label: string }[];
}) {
  const options = input.options ?? [{ id: "approve", label: "Approve" }];
  return {
    id: input.id,
    companyId: input.companyId,
    issueId: input.issueId,
    kind: "ask_user_questions" as const,
    status: input.status ?? "accepted",
    continuationPolicy: "wake_assignee" as const,
    resolverPolicy: "human_only" as const,
    requestedResolverPolicy: "human_only" as const,
    effectiveResolverPolicy: "human_only" as const,
    resolverPolicyProvenance: {} as Record<string, unknown>,
    effectiveResolverPolicySource: "explicit" as const,
    legacyResolverPolicyAliases: { requested: null, effective: null },
    title: `PolyForge: ${input.semanticKind}`,
    summary: `semantic-kind: ${input.semanticKind}`,
    createdByAgentId: null,
    createdByUserId: null,
    // `??` is wrong here: an explicit `null` means "no user", which is the whole point of the
    // author-self-review fixture, and `null ?? "user-1"` would silently become "user-1".
    resolvedByUserId: "resolvedByUserId" in input ? (input.resolvedByUserId ?? null) : "user-1",
    resolvedByAgentId: "resolvedByAgentId" in input ? (input.resolvedByAgentId ?? null) : null,
    resolvedByRunId: null,
    originCommentIds: [],
    sourceCommentId: null,
    sourceRunId: null,
    sourceIdentityContextId: null,
    addresseeAgentId: null,
    addresseeUserId: null,
    idempotencyKey: null,
    createdAt: new Date(1_700_000_000_000),
    updatedAt: new Date(1_700_000_100_000),
    resolvedAt: new Date(1_700_000_100_000),
    payload: {
      version: 1 as const,
      title: `PolyForge decision required: ${input.semanticKind}`,
      questions: [
        {
          id: `decision-target:${input.decisionTargetHash}`,
          prompt: [
            "Approve this transition?",
            "",
            `semantic-kind: ${input.semanticKind}`,
            `decision-target: ${input.decisionTargetHash}`,
            "",
            "Options:",
            ...options.map((option) => `- ${option.id}: ${option.label}`),
          ].join("\n"),
          selectionMode: "single" as const,
          required: true,
          allowOther: false,
          options,
        },
      ],
    },
    result: {
      version: 1 as const,
      answers: [{ questionId: `decision-target:${input.decisionTargetHash}`, optionIds: [options[0]!.id] }],
    },
  };
}

export function approval(input: {
  id: string;
  companyId: string;
  status?: string;
  payload: Record<string, unknown>;
  decidedByUserId?: string | null;
}) {
  return {
    id: input.id,
    companyId: input.companyId,
    type: "tool_action" as const,
    requestedByAgentId: null,
    requestedByUserId: "user-1",
    status: (input.status ?? "approved") as never,
    payload: input.payload,
    decisionNote: null,
    decidedByUserId: input.decidedByUserId ?? "user-1",
    decidedAt: new Date(1_700_000_100_000),
    createdAt: new Date(1_700_000_000_000),
    updatedAt: new Date(1_700_000_100_000),
  };
}

export { buildCanonicalRequest, signCanonicalRequest, digestBytes, manifest };
