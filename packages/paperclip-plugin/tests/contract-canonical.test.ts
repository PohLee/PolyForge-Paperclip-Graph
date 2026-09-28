/**
 * Cross-language conformance for the signed request.
 *
 * ## Why the exact string is asserted, not a hash of it
 *
 * `services/polyforge/src/polyforge/core/hashing.py` is the Python twin of
 * `packages/protocol/src/canonical.ts`, and the two must agree byte for byte or the Core
 * rejects every request the bridge makes. Asserting a digest would localise the failure to
 * "some canonical input differs"; asserting the **string** puts the divergence in the diff.
 *
 * ## The Python side of the same fixture
 *
 * The docblock below is the fixture the Python conformance suite mirrors. Re-run it with:
 *
 * ```python
 * from polyforge.core.hashing import canonical_json
 * import hashlib, hmac
 *
 * canonical = canonical_json({
 *     "audience": "polyforge-runtime",
 *     "method": "POST",
 *     "path": "/v1/runs/run-1/claims?force=true",
 *     "bodyHash": "sha256:" + hashlib.sha256(b"").hexdigest(),
 *     "timestamp": "2026-01-02T03:04:05.000Z",
 *     "nonce": "0123456789abcdef0123456789abcdef",
 *     "issuer": "polyforge-bridge",
 *     "actor": {
 *         "actorId": "agent-1", "actorType": "agent", "agentId": "agent-1",
 *         "roles": [], "runId": "run-agent-1",
 *     },
 *     "scope": {"companyRef": "company-a", "projectRef": "project-a"},
 * })
 * assert canonical == EXPECTED_CANONICAL_REQUEST
 * assert "v1=" + hmac.new(b"shared-secret-for-the-fixture", canonical.encode(), hashlib.sha256).hexdigest() == EXPECTED_SIGNATURE
 * ```
 *
 * The canonical encoding rules are asserted individually after that, so a regression names the
 * rule it broke rather than only reporting that the fixture changed.
 */

import "./helpers/bootstrap.ts";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createHmac } from "node:crypto";
import { load } from "./helpers/bootstrap.ts";

const protocol = await load<typeof import("@polyforge/protocol")>("@polyforge/protocol");
const client = await load<typeof import("../src/runtime-client.ts")>(
  new URL("../src/runtime-client.ts", import.meta.url),
);

const { canonicalJson, canonicalBytes, digestBytes, digestText, hashCanonical, hashDomain, stableIdempotencyKey } = protocol;
const { buildCanonicalRequest, signCanonicalRequest, hashBodyBytes, base64url } = client;

/**
 * The fixture the Python suite mirrors verbatim.
 *
 * `path` is relative to the API base, matching `canonical_request_bytes` on the Core side. The
 * `/v1` prefix is where the service is mounted, not part of the request's identity; a fixture that
 * included it would pin the bridge to exactly one mount point and let a signature mismatch through
 * every unit test, because both ends of a self-consistent wrong fixture agree with each other.
 */
const FIXTURE = {
  audience: "polyforge-runtime",
  method: "POST",
  path: "/runs/run-1/claims?force=true",
  timestamp: "2026-01-02T03:04:05.000Z",
  nonce: "0123456789abcdef0123456789abcdef",
  issuer: "polyforge-bridge",
  actor: {
    actorId: "agent-1",
    actorType: "agent" as const,
    agentId: "agent-1",
    roles: [] as string[],
    runId: "run-agent-1",
  },
  scope: { companyRef: "company-a", projectRef: "project-a" },
  secret: "shared-secret-for-the-fixture",
};

const EMPTY_BODY_HASH = digestBytes(new Uint8Array(0));

/** Byte for byte. If this string changes, the Core and the bridge have diverged. */
const EXPECTED_CANONICAL_REQUEST =
  '{"actor":{"actorId":"agent-1","actorType":"agent","agentId":"agent-1","roles":[],"runId":"run-agent-1"},' +
  '"audience":"polyforge-runtime","bodyHash":"sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",' +
  '"issuer":"polyforge-bridge","method":"POST","nonce":"0123456789abcdef0123456789abcdef",' +
  '"path":"/runs/run-1/claims?force=true","scope":{"companyRef":"company-a","projectRef":"project-a"},' +
  '"timestamp":"2026-01-02T03:04:05.000Z"}';

const EXPECTED_SIGNATURE = `v1=${createHmac("sha256", FIXTURE.secret)
  .update(EXPECTED_CANONICAL_REQUEST, "utf8")
  .digest("hex")}`;

test("the canonical request string is byte-identical to the cross-language fixture", () => {
  const canonical = buildCanonicalRequest({
    audience: FIXTURE.audience,
    method: FIXTURE.method,
    path: FIXTURE.path,
    bodyHash: hashBodyBytes(null),
    timestamp: FIXTURE.timestamp,
    nonce: FIXTURE.nonce,
    issuer: FIXTURE.issuer,
    actor: FIXTURE.actor,
    scope: FIXTURE.scope,
  });
  assert.equal(canonical, EXPECTED_CANONICAL_REQUEST);
});

test("the signature is v1=<hex hmac-sha256> over exactly that string", () => {
  const signature = signCanonicalRequest(EXPECTED_CANONICAL_REQUEST, FIXTURE.secret);
  assert.equal(signature, EXPECTED_SIGNATURE);
  assert.match(signature, /^v1=[0-9a-f]{64}$/);
});

test("a different path, method, body, timestamp, nonce, issuer, actor, audience or scope changes the signature", () => {
  const base = {
    audience: FIXTURE.audience,
    method: FIXTURE.method,
    path: FIXTURE.path,
    bodyHash: hashBodyBytes(null),
    timestamp: FIXTURE.timestamp,
    nonce: FIXTURE.nonce,
    issuer: FIXTURE.issuer,
    actor: FIXTURE.actor,
    scope: FIXTURE.scope,
  };
  const reference = signCanonicalRequest(buildCanonicalRequest(base), FIXTURE.secret);
  const variants: Record<string, unknown>[] = [
    { method: "GET" },
    { path: "/v1/runs/run-2/claims?force=true" },
    { path: "/v1/runs/run-1/claims" },
    { bodyHash: digestText("mutated") },
    { timestamp: "2026-01-02T03:04:06.000Z" },
    { nonce: "0123456789abcdef0123456789abcdee" },
    { issuer: "polyforge-bridge-2" },
    { audience: "polyforge-runtime-2" },
    { actor: { ...FIXTURE.actor, actorType: "human" } },
    { scope: { companyRef: "company-b", projectRef: "project-a" } },
  ];
  for (const variant of variants) {
    const signature = signCanonicalRequest(buildCanonicalRequest({ ...base, ...(variant as never) }), FIXTURE.secret);
    assert.notEqual(signature, reference, `signature must change for ${JSON.stringify(variant)}`);
  }
});

test("an empty body hashes to the well-known sha256 of zero bytes", () => {
  assert.equal(
    hashBodyBytes(null),
    "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  // A body of `null` is not the same as no body: it has bytes.
  assert.notEqual(hashBodyBytes(new TextEncoder().encode("null")), hashBodyBytes(null));
  void EMPTY_BODY_HASH;
});

test("the body hash is taken over the transmitted bytes, not a re-encoded string", () => {
  const bytes = new Uint8Array([0xff, 0xfe, 0x00, 0x41]);
  assert.equal(hashBodyBytes(bytes), digestBytes(bytes));
  // The same bytes round-tripped through a lossy string encoding hash differently, which is
  // exactly the bug the raw-bytes rule prevents.
  assert.notEqual(hashBodyBytes(bytes), digestText(String.fromCharCode(0xff, 0xfe, 0x00, 0x41)));
});

test("actor and scope headers are unpadded base64url of their canonical JSON", () => {
  const encoded = base64url(canonicalJson(FIXTURE.actor));
  assert.equal(encoded, Buffer.from(JSON.stringify(FIXTURE.actor)).toString("base64url"));
  assert.ok(!encoded.includes("="));
  assert.deepEqual(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")), FIXTURE.actor);
});

// ---------------------------------------------------------------------------
// The canonical encoding rules (docs/05 §2), so a regression names the rule it broke
// ---------------------------------------------------------------------------

test("canonical JSON sorts object keys by code point", () => {
  assert.equal(canonicalJson({ b: 1, a: 2, A: 3 }), '{"A":3,"a":2,"b":1}');
});

test("canonical JSON omits undefined object values and preserves an explicit null", () => {
  assert.equal(canonicalJson({ a: undefined, b: null }), '{"b":null}');
});

test("canonical JSON rejects undefined inside an array", () => {
  assert.throws(() => canonicalJson([1, undefined, 2]), /undefined is not encodable inside an array/);
});

test("canonical JSON keeps array order", () => {
  assert.equal(canonicalJson([3, 1, 2]), "[3,1,2]");
});

test("canonical JSON normalises -0 to 0 and collapses integral floats", () => {
  assert.equal(canonicalJson({ a: -0, b: 1.0, c: 2.5 }), '{"a":0,"b":1,"c":2.5}');
});

test("canonical JSON rejects non-finite numbers", () => {
  assert.throws(() => canonicalJson({ a: Number.NaN }), /non-finite/);
  assert.throws(() => canonicalJson({ a: Number.POSITIVE_INFINITY }), /non-finite/);
});

test("canonical JSON emits no whitespace", () => {
  assert.equal(canonicalJson({ a: [1, { b: 2 }] }), '{"a":[1,{"b":2}]}');
});

test("canonical JSON keeps a boolean distinct from a number", () => {
  assert.equal(canonicalJson({ a: true, b: 1 }), '{"a":true,"b":1}');
});

test("canonical bytes are the UTF-8 encoding of the canonical text", () => {
  const value = { "ключ": "значение", emoji: "🛠️" };
  assert.deepEqual(canonicalBytes(value), new TextEncoder().encode(canonicalJson(value)));
});

test("hashes are sha256:<hex> and domain separation is real", () => {
  const value = { a: 1 };
  assert.equal(hashCanonical(value), digestBytes(canonicalBytes(value)));
  assert.equal(hashDomain("pf.contract", value), hashCanonical({ domain: "pf.contract", value }));
  // A contract hash and an evidence-set hash over the same payload must not collide.
  assert.notEqual(hashDomain("pf.contract", value), hashDomain("pf.evidence-set", value));
});

test("idempotency keys are stable, URI-escaped and bounded", () => {
  assert.equal(stableIdempotencyKey(["a", "b c"]), "a:b%20c");
  assert.equal(stableIdempotencyKey(["a", "b c"]), stableIdempotencyKey(["a", "b c"]));
  assert.notEqual(stableIdempotencyKey(["a:b", "c"]), stableIdempotencyKey(["a", "b:c"]));
  assert.ok(stableIdempotencyKey(Array.from({ length: 200 }, () => "x".repeat(50))).length <= 512);
});
