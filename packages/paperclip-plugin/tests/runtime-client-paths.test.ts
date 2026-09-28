import "./helpers/bootstrap.ts";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createHmac } from "node:crypto";
import { load } from "./helpers/bootstrap.ts";

/**
 * The wire path and the signed path are deliberately different, and the difference is a protocol
 * rule rather than an implementation detail.
 *
 * `docs/05-PROTOCOL.md` §1.1 defines the signed `path` as the request target *relative to the API
 * base*. The Core's `canonical_request_bytes` verifies exactly that and `ops/pfctl.mjs` signs that
 * way, which is why the operator CLI could read health while the plugin could not. A cross-language
 * fixture could not have caught it: both ends of a self-consistent wrong fixture agree with each
 * other, so the earlier contract test passed while every real request was rejected with a signature
 * error.
 *
 * These tests therefore go through `call()` and rebuild the canonical string from the headers that
 * actually went out, which is what the Core does. A fixture that mirrors the implementation proves
 * only that the implementation is self-consistent; this proves the client agrees with the verifier.
 */

type RuntimeModule = typeof import("../src/runtime-client.ts");

const SECRET = "test-shared-secret-not-a-real-one";
const ISSUER = "polyforge-bridge-test";
const AUDIENCE = "polyforge-runtime";
const RUNTIME_URL = "http://127.0.0.1:8787";
const EMPTY_BODY_HASH = "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const QUIET_LOGGER = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child(): unknown {
    return QUIET_LOGGER;
  },
} as never;

function decodeHeaderJson(value: string | undefined): Record<string, unknown> {
  assert.ok(value, "expected a base64url JSON header");
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
}

/** The canonical string the Core derives from the bytes it received, with its sorted key order. */
function canonicalAsTheCoreSeesIt(headers: Record<string, string>, method: string, signedPath: string, bodyHash: string): string {
  const fields: Record<string, unknown> = {
    actor: decodeHeaderJson(headers["x-pf-actor"]),
    audience: headers["x-pf-audience"] ?? "",
    bodyHash,
    issuer: headers["x-pf-issuer"] ?? "",
    method,
    nonce: headers["x-pf-nonce"] ?? "",
    path: signedPath,
    scope: decodeHeaderJson(headers["x-pf-scope"]),
    timestamp: headers["x-pf-timestamp"] ?? "",
  };
  // The Core sorts keys and emits no whitespace; rebuilding the string here keeps this test
  // independent of the client's own encoder, which is the point.
  return JSON.stringify(Object.fromEntries(Object.entries(fields).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));
}

function recorder(): {
  seen: { url: string; headers: Record<string, string> }[];
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
} {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  return {
    seen,
    fetchImpl: async (url: string, init?: RequestInit) => {
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
        headers[key.toLowerCase()] = value;
      }
      seen.push({ url: String(url), headers });
      return new Response(
        JSON.stringify({
          status: "ready",
          protocolVersion: 1,
          schemaVersion: 1,
          compilerVersion: "test",
          bridge: { expectedIssuer: ISSUER },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  };
}

function clientFor(runtime: RuntimeModule, fetchImpl: (url: string, init?: RequestInit) => Promise<Response>) {
  return new runtime.RuntimeClient(
    {
      companyId: "company-a",
      runtimeUrl: RUNTIME_URL,
      allowPrivateRuntimeHost: true,
      bridgeIssuer: ISSUER,
      sharedSecretRef: { type: "secret_ref", secretId: "secret-1" },
      requestTimeoutMs: 5000,
      replayWindowSeconds: 120,
      audience: AUDIENCE,
      stateDir: "/tmp/polyforge-path-test",
      storePath: "/tmp/polyforge-path-test/bridge.sqlite",
      defaultGraphId: null,
      engineeringEntryLabel: "engineering",
      engineeringOriginPrefix: "polyforge",
      workspaceProviderMode: "metadata_only",
      runtimeTransport: "governed",
      experimental: { decisions: false, cases: false, pipelines: false },
      enableProjections: true,
      logLevel: "info",
      maxArtifactBytes: 1024,
    },
    {
      secretProvider: async () => SECRET,
      clock: { now: () => new Date(1_700_000_000_000), nonce: () => "b".repeat(32), sleep: async () => {} },
      logger: QUIET_LOGGER,
      fetchImpl,
      companyId: "company-a",
    },
  );
}

const AGENT = { actorType: "agent" as const, actorId: "agent-1", agentId: "agent-1", roles: [] };

test("a read is sent on the full /v1 path and carries every signed field as a header", async () => {
  const runtime = await load<RuntimeModule>(new URL("../src/runtime-client.ts", import.meta.url));
  const wire = recorder();
  await clientFor(runtime, wire.fetchImpl).health(AGENT, { companyRef: "company-a", projectRef: "" }, "corr-1");

  assert.equal(wire.seen.length, 1);
  const call = wire.seen[0]!;

  assert.equal(call.url, `${RUNTIME_URL}/v1/health`, "the wire path keeps the API base");

  // The audience is covered by the signature, so it has to be transmitted as well. Left to the
  // Core's default, the field the Core verifies would equal the signed field only by coincidence.
  assert.equal(call.headers["x-pf-audience"], AUDIENCE);
  assert.equal(call.headers["x-pf-issuer"], ISSUER);
  assert.ok(call.headers["x-pf-timestamp"], "the signed timestamp must be transmitted");
  assert.ok(call.headers["x-pf-nonce"], "the signed nonce must be transmitted");
  assert.ok(call.headers["x-pf-actor"], "the signed actor must be transmitted");
  assert.ok(call.headers["x-pf-scope"], "the signed scope must be transmitted");
  assert.match(call.headers["x-pf-signature"] ?? "", /^v1=[0-9a-f]{64}$/);
});

test("every /v1 endpoint is signed over the path the Core reconstructs", async () => {
  const runtime = await load<RuntimeModule>(new URL("../src/runtime-client.ts", import.meta.url));
  const wire = recorder();
  const client = clientFor(runtime, wire.fetchImpl);
  const scope = { companyRef: "company-a", projectRef: "project-a" };

  await client.getRun(AGENT, scope, "run-1");
  await client.listRuns(AGENT, scope);
  await client.current(AGENT, scope, "run-1");

  assert.equal(wire.seen.length, 3);
  for (const call of wire.seen) {
    const wirePath = new URL(call.url).pathname;
    assert.ok(wirePath.startsWith("/v1/"), `the wire path should keep the API base: ${wirePath}`);

    // The signed path is the wire path with the API base removed. Recomputing the signature from
    // the received headers is precisely the check the Core performs before it will answer.
    const signedPath = wirePath.slice("/v1".length);
    const canonical = canonicalAsTheCoreSeesIt(call.headers, "GET", signedPath, EMPTY_BODY_HASH);
    const expected = `v1=${createHmac("sha256", SECRET).update(canonical, "utf8").digest("hex")}`;
    assert.equal(
      call.headers["x-pf-signature"],
      expected,
      `the signature must be over the base-relative path ${signedPath}`,
    );
  }
});

test("the signed actor is the Core's wire form, not the caller's object", async () => {
  const runtime = await load<RuntimeModule>(new URL("../src/runtime-client.ts", import.meta.url));
  const wire = recorder();

  // Exactly the shape the bridge's read path uses: nulls and an empty role list present as keys.
  // The Core rebuilds the actor through `to_wire()`, which omits all three, so signing this object
  // verbatim produces a different canonical string and a bare "signature does not verify".
  await clientFor(runtime, wire.fetchImpl).health(
    { actorType: "system", actorId: "paperclip:plugin-ui", agentId: null, runId: null, roles: [] },
    { companyRef: "company-a", projectRef: "" },
    "corr-1",
  );

  assert.deepEqual(decodeHeaderJson(wire.seen[0]!.headers["x-pf-actor"]), {
    actorType: "system",
    actorId: "paperclip:plugin-ui",
  });
});

test("a populated actor keeps its ids and roles", async () => {
  const runtime = await load<RuntimeModule>(new URL("../src/runtime-client.ts", import.meta.url));
  const wire = recorder();

  await clientFor(runtime, wire.fetchImpl).health(
    { actorType: "agent", actorId: "agent-1", agentId: "agent-1", runId: "run-1", roles: ["reviewer"] },
    { companyRef: "company-a", projectRef: "project-a" },
    "corr-1",
  );

  assert.deepEqual(decodeHeaderJson(wire.seen[0]!.headers["x-pf-actor"]), {
    actorType: "agent",
    actorId: "agent-1",
    agentId: "agent-1",
    runId: "run-1",
    roles: ["reviewer"],
  });
});
