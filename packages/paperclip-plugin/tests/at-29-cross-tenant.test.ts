/**
 * AT-29 (NFR-02) — cross-company references and hostile inputs are refused at every surface.
 *
 * "跨公司 SSE、artifact、tool、API、workspace refs 全拒绝；SSRF/path traversal payload 拒绝"
 *
 * One file covers all the surfaces on purpose. The property is a single one — a ref or a value
 * that names something outside the caller's scope must be refused *before* it reaches a host API or
 * an outbound request — and testing the surfaces separately would let one of them drift.
 */

import "./helpers/bootstrap.ts";
import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { load } from "./helpers/bootstrap.ts";

const h = await load<typeof import("./helpers/harness.ts")>(new URL("./helpers/harness.ts", import.meta.url));
const sdk = await load<typeof import("@paperclipai/plugin-sdk")>("@paperclipai/plugin-sdk");
const configModule = await load<typeof import("../src/config.ts")>(new URL("../src/config.ts", import.meta.url));

const { COMPANY_A, COMPANY_B, PROJECT_A, PROJECT_B, buildBridge, company, project, issue, label } = h;
const bridges: { dispose(): void }[] = [];
after(() => {
  for (const bridge of bridges) bridge.dispose();
});
function track<T extends { dispose(): void }>(bridge: T): T {
  bridges.push(bridge);
  return bridge;
}

const META = { commandId: "c", idempotencyKey: "pf:x:1", correlationId: "corr" };
const AGENT_RUN = "agent-run-a";

function runCtx(overrides: Record<string, unknown> = {}) {
  return {
    companyId: COMPANY_A,
    projectId: PROJECT_A,
    agentId: "agent-1",
    runId: AGENT_RUN,
    toolName: "current",
    callId: "call-1",
    ...overrides,
  } as unknown as sdk.ToolRunContext;
}

function resolve(runtimeUrl: string, overrides: Record<string, unknown> = {}): never {
  return configModule.resolveConfig({
    companyId: COMPANY_A,
    raw: {
      runtimeUrl,
      bridgeIssuer: "polyforge-bridge",
      sharedSecretRef: { type: "secret_ref", secretId: "pf-bridge" },
      stateDir: "/tmp/pf-state",
      engineeringEntryLabel: "engineering",
      engineeringOriginPrefix: "polyforge",
      ...overrides,
    },
    fallbackStateRoot: "/tmp",
    instanceTag: "test",
  }) as never;
}

/** Two tenants, each with its own project, issue, run and bindings. */
async function twoTenants() {
  const bridge = await buildBridge({
    extraCompanyIds: [COMPANY_B],
    seed: {
      companies: [company(COMPANY_A), company(COMPANY_B)],
      projects: [project(PROJECT_A, COMPANY_A), project(PROJECT_B, COMPANY_B)],
      issues: [
        issue("root-a", COMPANY_A, PROJECT_A, { labels: [label("engineering")] }),
        issue("root-b", COMPANY_B, PROJECT_B, { labels: [label("engineering")] }),
      ],
    },
  });
  for (const [companyId, projectRef, rootId, runId] of [
    [COMPANY_A, PROJECT_A, "root-a", "run-a"],
    [COMPANY_B, PROJECT_B, "root-b", "run-b"],
  ] as const) {
    bridge.store.putBinding({
      companyId,
      kind: "run",
      providerId: runId,
      projectId: projectRef,
      payload: { runId, rootIssueId: rootId, projectId: projectRef },
    });
    bridge.store.putBinding({
      companyId,
      kind: "work_unit",
      providerId: `${runId}:n1:0`,
      projectId: projectRef,
      payload: {
        runId,
        nodeId: "n1",
        iteration: 0,
        issueId: rootId,
        agentRunRefId: AGENT_RUN,
        agentId: "agent-1",
        contractHash: "sha256:contract-1",
      },
    });
  }
  return bridge;
}

// ---------------------------------------------------------------------------
// Cross-company refs
// ---------------------------------------------------------------------------

test("AT-29: an approval ref recorded for the other company is not resolvable here", async () => {
  const bridge = track(await twoTenants());
  // Company B has a recorded authorization; company A must not be able to check it, because the
  // lookup is scoped by the bundle's own company and the id is simply not in company A's store.
  bridge.store.putBinding({
    companyId: COMPANY_B,
    kind: "governance_authorization",
    providerId: "ap-b",
    projectId: PROJECT_B,
    payload: {
      action: "deploy.production",
      resource: "svc@prod",
      environment: "production",
      inputHashes: {},
      transitionHash: "sha256:t",
      authority: "platform:release-manager",
      approvalId: "ap-b",
      expiresAt: "2999-01-01T00:00:00.000Z",
    },
  });
  const status = await bridge.company.ports.governance.checkAuthorization(
    { provider: "paperclip", kind: "approval", id: "ap-b" },
    {
      action: "deploy.production",
      resource: "svc@prod",
      environment: "production",
      inputHashes: {},
      transitionHash: "sha256:t",
    },
  );
  assert.equal(status.granted, false);
  assert.match(status.reason, /not bound in this company/);
});

function artifactUpload(source: Record<string, unknown>) {
  return {
    scope: { companyRef: COMPANY_A, projectRef: PROJECT_A },
    kind: "code_diff",
    contentHash: "sha256:declared",
    mediaType: "text/plain",
    size: 12,
    source,
  } as never;
}

test("AT-29: an artifact source in the other company is refused", async () => {
  const bridge = track(await twoTenants());
  // A document source names the issue it belongs to, and the port resolves that issue through the
  // company-scoped host client. `root-b` is company B's issue, so from company A it is not there.
  await assert.rejects(
    () =>
      bridge.company.ports.artifacts.publish(
        artifactUpload({ kind: "document", ref: "issue:root-b/spec" }),
        META,
      ),
    /not readable in this company|not found|no such|not in scope|another company|unresolv/i,
  );
  // A source whose shape is wrong is refused too, before any read is attempted.
  await assert.rejects(
    () => bridge.company.ports.artifacts.publish(artifactUpload({ kind: "document", ref: "doc-b" }), META),
    /must be 'issue:/,
  );
  // Nothing was published and nothing was told to the Core.
  assert.equal(bridge.store.countDeliveries(COMPANY_A, "pending"), 0);
  assert.equal(bridge.store.countDeliveries(COMPANY_B, "pending"), 0);
});

test("AT-29: a workspace ref in the other company is refused", async () => {
  const bridge = track(await twoTenants());
  // A well-formed ref naming the other tenant's workspace must not resolve.
  const observation = await bridge.company.ports.workspace.inspect({
    companyRef: COMPANY_B,
    projectRef: PROJECT_B,
    workspaceRef: { provider: "paperclip", kind: "project_workspace", id: "ew-b" },
    path: null,
    branch: null,
    commits: [],
    readOnly: false,
  } as never);
  assert.equal(observation.exists, false);
  assert.ok(
    observation.problems.some((problem) => problem.includes("workspace_missing")),
    `expected a missing-workspace problem, got ${JSON.stringify(observation.problems)}`,
  );
});

test("AT-29: a tool call naming the other company's run is a scope violation", async () => {
  const bridge = track(await twoTenants());
  // The agent run is bound in company A; naming company B's run is refused before the Core is
  // consulted.
  const data = (await bridge.callTool("current", { runId: "run-b" }, runCtx())).data as Record<string, unknown>;
  assert.equal(data["status"], "SCOPE_VIOLATION");
  const blockers = data["blockers"] as Record<string, unknown>[];
  assert.equal(blockers[0]?.["code"], "BRIDGE_SCOPE_VIOLATION");
  // And nothing was read about company B to make that decision.
  assert.equal(bridge.runtime.requests.length, 0);
});

test("AT-29: a data read cannot be pointed at another company's run", async () => {
  const bridge = track(await twoTenants());
  const { registerDataKeys } = await load<typeof import("../src/bridge/data.ts")>(
    new URL("../src/bridge/data.ts", import.meta.url),
  );
  registerDataKeys(bridge.ctx, (id) => bridge.companies.get(id) ?? null);

  // Asking for company A's data key with company B's ids returns either company A's view (the
  // bundle owns the tenant) or an error. What it must never do is return company B's data.
  for (const key of ["run-tab", "issue-view"] as const) {
    let payload: string;
    try {
      payload = JSON.stringify(
        await bridge.harness.getData(key, { companyId: COMPANY_B, runId: "run-b", issueId: "root-b" }),
      );
    } catch (error) {
      payload = error instanceof Error ? error.message : String(error);
    }
    assert.equal(payload.includes("root-a"), false, `${key} leaked company A's issue`);
    assert.equal(payload.includes("run-a"), false, `${key} leaked company A's run`);
  }
});

test("AT-29: an action cannot be performed against another company's run", async () => {
  const bridge = track(await twoTenants());
  const actions = await load<typeof import("../src/bridge/actions.ts")>(
    new URL("../src/bridge/actions.ts", import.meta.url),
  );
  // Registered the way `worker.ts` registers them, so the action handlers under test are the
  // production ones.
  actions.registerActionKeys(
    (key, handler) => {
      bridge.ctx.actions.register(key, handler as never);
    },
    (id) => bridge.companies.get(id) ?? null,
  );

  for (const [key, params, options] of [
    // A board user, so the identity gate passes and the *scope* gate is what refuses.
    [
      "retry-node",
      { companyId: COMPANY_A, runId: "run-b", nodeId: "n1", iteration: 0 },
      { actor: { type: "user" as const, userId: "user-1" } },
    ],
    // A read-only action with a system actor: refused on the foreign run rather than on identity.
    ["refresh", { companyId: COMPANY_A, runId: "run-b" }, undefined],
  ] as const) {
    let outcome: string;
    try {
      outcome = JSON.stringify(
        await bridge.harness.performAction(key, params as Record<string, unknown>, options as never),
      );
    } catch (error) {
      outcome = error instanceof Error ? error.message : String(error);
    }
    // The refusal must be explicit. Accepting the call and quietly doing nothing in company A
    // would leave an operator believing a foreign run had been retried.
    assert.match(
      outcome,
      /not recorded for the requesting company|SCOPE_VIOLATION|not in scope|not bound|unknown run|no bridge context|board user/i,
      `${key} accepted a foreign run: ${outcome}`,
    );
  }
  // Nothing was dispatched on the strength of a foreign run id.
  assert.equal(bridge.runtime.requestsTo("POST", "/work-orders").length, 0);
});

// ---------------------------------------------------------------------------
// SSRF
// ---------------------------------------------------------------------------

test("AT-29: a runtime URL aimed at the metadata service is refused", async () => {
  // The signed client is the bridge's only outbound component, so its base URL is the whole SSRF
  // surface. The link-local range has no legitimate Runtime Service, with or without the opt-in.
  for (const url of [
    "http://169.254.169.254/latest/meta-data",
    "https://169.254.169.254/",
    "http://[fe80::1]/",
    "http://0.0.0.0/",
  ]) {
    assert.throws(() => resolve(url), /link-local|metadata/i, `${url} must be refused`);
    assert.throws(
      () => resolve(url, { allowPrivateRuntimeHost: true }),
      /link-local|metadata/i,
      `${url} must be refused even with the private-network opt-in`,
    );
  }
});

test("AT-29: a private or loopback runtime URL needs an explicit opt-in", async () => {
  for (const url of [
    "http://127.0.0.1:8080",
    "http://localhost:9000",
    "http://10.1.2.3",
    "http://192.168.1.10",
    "http://172.16.0.5",
  ]) {
    assert.throws(() => resolve(url), /private or loopback/i, `${url} must be refused by default`);
    // The development setup stays possible, but only when the operator says so.
    assert.doesNotThrow(
      () => resolve(url, { allowPrivateRuntimeHost: true }),
      `${url} must be allowed with the opt-in`,
    );
  }
  // A non-http scheme is refused outright, opt-in or not.
  assert.throws(() => resolve("file:///etc/passwd"), /http or https/i);
  assert.throws(() => resolve("not-a-url"), /absolute URL/i);
});

test("AT-29: a public https runtime URL is accepted, and the opt-in is per company", () => {
  const publicUrl = resolve("https://runtime.polyforge.dev");
  assert.equal(publicUrl.runtimeUrl, "https://runtime.polyforge.dev");
  // The flag is read per resolution, not held as shared state: one company's opt-in must not
  // silently authorise another's loopback endpoint.
  assert.throws(() => resolve("http://127.0.0.1:1"), /private or loopback/i);
  assert.doesNotThrow(() => resolve("http://127.0.0.1:1", { allowPrivateRuntimeHost: true }));
  assert.throws(() => resolve("http://127.0.0.1:1"), /private or loopback/i);
});

// ---------------------------------------------------------------------------
// Path traversal
// ---------------------------------------------------------------------------

test("AT-29: a hostile artifact source reference is refused before any read", async () => {
  const bridge = track(await twoTenants());
  // A source ref is an *identifier*, never something to dereference. A URL, a UNC path, a traversal
  // or a NUL byte has no legitimate use, and each is refused structurally.
  for (const candidate of [
    "https://evil.example/steal",
    "file:///etc/passwd",
    "//evil.example/share",
    "\\\\evil.example\\share",
    "../../etc/passwd",
    "doc .pdf",
    "data:text/plain;base64,QQ==",
  ]) {
    await assert.rejects(
      () => bridge.company.ports.artifacts.publish(artifactUpload({ kind: "document", ref: candidate }), META),
      /hostile|URL|UNC|traversal|NUL|source/i,
      `${candidate} must be refused as an artifact source`,
    );
  }
  assert.equal(bridge.store.countDeliveries(COMPANY_A, "pending"), 0, "a refused source queues nothing");
});

test("AT-29: a traversing workspace path from the host is refused, not forwarded", async () => {
  const bridge = track(await twoTenants());
  // Defence in depth: a trusted host producing a traversing path would be a host bug, and the
  // bridge refuses to hand such a path to the Core's own path handling.
  for (const candidate of ["/workspace/../../etc/passwd", "/workspace/a/../../b", "relative/path"]) {
    bridge.harness.seed({
      projectWorkspaces: [
        {
          id: "pw-a",
          companyId: COMPANY_A,
          projectId: PROJECT_A,
          path: candidate,
          branch: "main",
          metadata: {},
        } as never,
      ],
    });
    const observation = await bridge.company.ports.workspace.inspect({
      companyRef: COMPANY_A,
      projectRef: PROJECT_A,
      workspaceRef: { provider: "paperclip", kind: "project_workspace", id: "pw-a" },
      path: null,
      branch: null,
      commits: [],
      readOnly: false,
    } as never);
    if (observation.exists) {
      assert.equal(observation.path, null, `${candidate} must not survive as a usable path`);
      assert.ok(
        observation.problems.some((problem) => problem.includes("path_")),
        `expected a path problem for ${candidate}, got ${JSON.stringify(observation.problems)}`,
      );
    }
  }
});
