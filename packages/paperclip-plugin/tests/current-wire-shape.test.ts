import "./helpers/bootstrap.ts";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createHmac } from "node:crypto";
import { load } from "./helpers/bootstrap.ts";

/**
 * The `current` response is the most load-bearing DTO in the system, and it was the one the fake got
 * wrong.
 *
 * `RuntimeService.current` nests the contract under `contract` and the attempt under `attempt`. The
 * bridge read `contractHash`, `attemptId`, `leaseEpoch`, `requiredInputs`, `permittedOutputs`,
 * `evidenceRequirements` and `policyConstraints` from the *top level*, where none of them exist. The
 * test harness answered with a flat object using exactly those names, so client and fake agreed with
 * each other and the suite passed while a real Core would have delivered a contract with a null hash,
 * no required inputs, no permitted outputs, no evidence requirements and an empty policy: an agent
 * with no idea what it was required to produce, and a claim that could not be checked.
 *
 * A fixture that mirrors the implementation proves only that the implementation is self-consistent.
 * These tests assert the production mapper against a payload shaped like the Core's, and assert that
 * a shape it does not implement is named rather than answered with an empty contract.
 */

type RuntimeModule = typeof import("../src/runtime-client.ts");
type WorkerModule = typeof import("../src/worker.ts");

const SECRET = "test-shared-secret-not-a-real-one";
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

/** The Core's real `current` payload, nested exactly as `RuntimeService.current` sends it. */
const CORE_CURRENT = {
  runId: "run-1",
  nodeId: "architecture",
  iteration: 2,
  stateVersion: 7,
  status: "RUNNING",
  attempt: {
    attemptId: "att-1",
    runId: "run-1",
    nodeId: "architecture",
    iteration: 2,
    attemptNo: 3,
    transitionHash: "sha256:transition",
    status: "ACTIVE",
    leaseEpoch: 4,
    leaseState: "HELD",
    agentSubject: "agent:paperclip/agent-1",
    agentRunRef: { provider: "paperclip", kind: "agent_run", id: "agent-run-1" },
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: null,
    leaseExpiresAt: null,
    checkpointRef: null,
  },
  contract: {
    nodeId: "architecture",
    iteration: 2,
    operation: { id: "op-1", version: 1 },
    subject: {},
    inputs: { "spec.path": "docs/01.md", "spec.revision": "sha256:spec" },
    effectivePolicy: { "budget.ceiling": 100, "network.egress": "denied" },
    authority: {},
    environment: {},
    intendedMutations: ["issue.create", "issue.update"],
    requiredEvidenceKinds: ["test_report"],
    requiredEvaluators: ["contract_schema_v1"],
    planHash: "sha256:plan",
    graphId: "design",
    graphVersion: 3,
    definitionHash: "sha256:definition",
    dependencyLockHash: "sha256:lock",
    compilerVersion: "polyforge-compiler/1.0.0",
    contractHash: "sha256:contract-1",
    contractId: "ctr-1",
    contractSchemaVersion: 1,
    schemaVersion: 1,
  },
  inputs: {},
  pendingGovernance: [],
  permittedActions: [
    "polyforge.current",
    "polyforge.request_transition",
    "polyforge.status",
    "polyforge.submit_artifact",
    "polyforge.submit_evidence",
  ],
  previousOwnerAgentRunId: "agent-run-0",
  claimable: true,
};

function respondWith(body: unknown): (url: string, init?: RequestInit) => Promise<Response> {
  return async () =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

const CONFIG = {
  companyId: "company-a",
  runtimeUrl: RUNTIME_URL,
  allowPrivateRuntimeHost: true,
  bridgeIssuer: "polyforge-bridge",
  sharedSecretRef: { type: "secret_ref" as const, secretId: "secret-1" },
  requestTimeoutMs: 5000,
  replayWindowSeconds: 120,
  audience: "polyforge-runtime",
  stateDir: "/tmp/polyforge-current-test",
  storePath: "/tmp/polyforge-current-test/bridge.sqlite",
  defaultGraphId: null,
  engineeringEntryLabel: "engineering",
  engineeringOriginPrefix: "polyforge",
  workspaceProviderMode: "metadata_only" as const,
  runtimeTransport: "governed" as const,
  experimental: { decisions: false, cases: false, pipelines: false },
  enableProjections: true,
  logLevel: "info" as const,
  maxArtifactBytes: 1024,
};

function clientFor(
  runtime: RuntimeModule,
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
): InstanceType<RuntimeModule["RuntimeClient"]> {
  return new runtime.RuntimeClient(CONFIG, {
    secretProvider: async () => SECRET,
    clock: { now: () => new Date(1_700_000_000_000), nonce: () => "d".repeat(32), sleep: async () => {} },
    logger: QUIET_LOGGER,
    fetchImpl,
    companyId: "company-a",
  });
}

const SCOPE = { companyRef: "company-a", projectRef: "project-a" };
const AGENT = { actorType: "agent" as const, actorId: "agent-1", agentId: "agent-1", roles: [] };

test("a run-scoped read names the project and is signed on the base-relative path", async () => {
  const runtime = await load<RuntimeModule>(new URL("../src/runtime-client.ts", import.meta.url));
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    seen.push({ url: String(url), headers });
    return respondWith(CORE_CURRENT)(url, init);
  };

  await clientFor(runtime, fetchImpl).current(AGENT, SCOPE, "run-1");

  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.url, `${RUNTIME_URL}/v1/runs/run-1/current`);

  const scope = JSON.parse(
    Buffer.from(seen[0]!.headers["x-pf-scope"] ?? "", "base64url").toString("utf8"),
  ) as Record<string, unknown>;
  assert.deepEqual(scope, SCOPE, "a run-scoped call must carry the run's own project");

  const canonical = JSON.stringify(
    Object.fromEntries(
      Object.entries({
        actor: JSON.parse(Buffer.from(seen[0]!.headers["x-pf-actor"] ?? "", "base64url").toString("utf8")),
        audience: seen[0]!.headers["x-pf-audience"],
        bodyHash: EMPTY_BODY_HASH,
        issuer: seen[0]!.headers["x-pf-issuer"],
        method: "GET",
        nonce: seen[0]!.headers["x-pf-nonce"],
        path: "/runs/run-1/current",
        scope,
        timestamp: seen[0]!.headers["x-pf-timestamp"],
      }).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ),
  );
  const expected = `v1=${createHmac("sha256", SECRET).update(canonical, "utf8").digest("hex")}`;
  assert.equal(seen[0]!.headers["x-pf-signature"], expected);
});

test("the production mapper reads the Core's nested contract and attempt", async () => {
  const runtime = await load<RuntimeModule>(new URL("../src/runtime-client.ts", import.meta.url));
  const worker = await load<WorkerModule>(new URL("../src/worker.ts", import.meta.url));
  const client = clientFor(runtime, respondWith(CORE_CURRENT));
  const toolRuntime = worker.__testing.toolRuntimeFor({
    companyId: "company-a",
    runtime: client,
    store: { getBinding: () => ({ projectId: "project-a" }) },
    metrics: { bump() {} },
    logger: QUIET_LOGGER,
  } as never);

  const view = await toolRuntime.current("company-a", "run-1");

  assert.equal(view.contractHash, "sha256:contract-1", "the contract hash is the claim's fence");
  assert.equal(view.attemptId, "att-1");
  assert.equal(view.leaseEpoch, 4, "the lease epoch fences a stale worker");
  assert.equal(view.stateVersion, 7);
  assert.equal(view.nodeId, "architecture");
  assert.equal(view.iteration, 2);
  assert.deepEqual(view.requiredInputs, ["spec.path", "spec.revision"]);
  assert.deepEqual(view.permittedOutputs, ["issue.create", "issue.update"]);
  assert.deepEqual(view.evidenceRequirements, ["test_report"]);
  assert.deepEqual(view.policyConstraints, { "budget.ceiling": 100, "network.egress": "denied" });
  assert.equal(view.previousOwnerAgentRunId, "agent-run-0", "adoption must know whose attempt it takes");
  assert.deepEqual(view.permittedActions, CORE_CURRENT.permittedActions);
});

test("the production mapper refuses a current response it does not implement", async () => {
  const runtime = await load<RuntimeModule>(new URL("../src/runtime-client.ts", import.meta.url));
  const worker = await load<WorkerModule>(new URL("../src/worker.ts", import.meta.url));

  // The old flat shape: every field this mapper used to read sat at the top level, and none of them
  // is where the Core puts them. A bridge that understands this body is talking to a different Core.
  const flat = {
    runId: "run-1",
    stateVersion: 1,
    contractHash: "sha256:contract-1",
    attemptId: "att-1",
    leaseEpoch: 4,
    requiredInputs: [],
    permittedOutputs: [],
  };
  const client = clientFor(runtime, respondWith(flat));
  const toolRuntime = worker.__testing.toolRuntimeFor({
    companyId: "company-a",
    runtime: client,
    store: { getBinding: () => ({ projectId: "project-a" }) },
    metrics: { bump() {} },
    logger: QUIET_LOGGER,
  } as never);

  await assert.rejects(
    () => toolRuntime.current("company-a", "run-1"),
    (error: unknown) => {
      const err = error as { code?: string; message?: string };
      assert.equal(err.code, "BRIDGE_PROTOCOL_INCOMPATIBLE");
      assert.match(err.message ?? "", /contract\.contractHash/);
      return true;
    },
    "a wire format this bridge does not implement must be named, not answered with an empty contract",
  );
});
