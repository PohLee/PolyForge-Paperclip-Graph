import "./helpers/bootstrap.ts";
import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { load } from "./helpers/bootstrap.ts";

const h = await load<typeof import("./helpers/harness.ts")>(new URL("./helpers/harness.ts", import.meta.url));
const routes = await load<typeof import("../src/api-routes.ts")>(new URL("../src/api-routes.ts", import.meta.url));
const manifestModule = await load<typeof import("../src/manifest.ts")>(new URL("../src/manifest.ts", import.meta.url));
const { COMPANY_A, PROJECT_A, buildBridge } = h;
const bridges: { dispose(): Promise<void> }[] = [];
after(async () => {
  for (const bridge of bridges) await bridge.dispose();
});

test("agent tool API route executes through the bound Paperclip heartbeat identity", async () => {
  const bridge = await buildBridge({ companyId: COMPANY_A });
  bridges.push(bridge);
  bridge.runtime.seedRun("run-1", {
    scope: { companyRef: COMPANY_A, projectRef: PROJECT_A },
    graphId: "graph-test",
    entrypoint: "test.start",
    startIntentId: "intent-1",
  });
  bridge.store.putBinding({
    companyId: COMPANY_A,
    kind: "work_unit",
    providerId: "run-1:n1:0",
    projectId: PROJECT_A,
    payload: { runId: "run-1", nodeId: "n1", iteration: 0, issueId: "issue-1", agentRunRefId: "heartbeat-1" },
  });

  const deps = {
    runtime: (companyId: string) => companyId === COMPANY_A ? bridge.company.runtime : null,
    claim: () => null,
    recordClaim: () => undefined,
    bindingForAgentRun: (companyId: string, agentRunId: string) => {
      for (const kind of ["dispatch", "work_unit"]) {
        for (const row of bridge.store.listBindings(companyId, kind, 2000)) {
          const payload = JSON.parse(row.payloadJson) as Record<string, unknown>;
          if (payload["agentRunRefId"] !== agentRunId || typeof payload["runId"] !== "string") continue;
          return {
            companyId,
            runId: payload["runId"],
            nodeId: typeof payload["nodeId"] === "string" ? payload["nodeId"] : "",
            iteration: typeof payload["iteration"] === "number" ? payload["iteration"] : 0,
            issueId: typeof payload["issueId"] === "string" ? payload["issueId"] : "",
            projectId: row.projectId,
            contractHash: null,
          };
        }
      }
      return null;
    },
    bindingForIssueExecution: async () => null,
    stopPreviousOwner: async () => "unknown" as const,
    bump: (companyId: string, counter: string) => bridge.metrics.bump(companyId, counter),
    warn: () => undefined,
    publishArtifact: async () => { throw new Error("not used by status"); },
  } as never;
  const handle = routes.createApiRequestHandler((companyId) => bridge.companies.get(companyId) ?? null, deps);
  const input = {
    routeKey: "agent-tool",
    method: "POST",
    path: "/issues/issue-1/tools/status",
    params: { issueId: "issue-1", toolName: "status" },
    query: {},
    body: {},
    actor: { actorType: "agent", actorId: "agent-1", agentId: "agent-1", runId: "heartbeat-1" },
    companyId: COMPANY_A,
    headers: {},
  } as never;

  const response = await handle(input);
  assert.equal(response.status, 200);
  assert.equal((response.body as { data: { runId: string } }).data.runId, "run-1");
});

test("agent tool API route denies unbound heartbeats and validates strict tool schemas", async () => {
  const bridge = await buildBridge({ companyId: COMPANY_A });
  bridges.push(bridge);
  let bound = false;
  const deps = {
    runtime: () => null,
    claim: () => null,
    recordClaim: () => undefined,
    bindingForAgentRun: () => bound ? {
      companyId: COMPANY_A,
      runId: "run-1",
      nodeId: "n1",
      iteration: 0,
      issueId: "issue-1",
      projectId: PROJECT_A,
      contractHash: null,
    } : null,
    bindingForIssueExecution: async () => null,
    stopPreviousOwner: async () => "unknown" as const,
    bump: (companyId: string, counter: string) => bridge.metrics.bump(companyId, counter),
    warn: () => undefined,
    publishArtifact: async () => { throw new Error("not used"); },
  } as never;
  const handle = routes.createApiRequestHandler((companyId) => bridge.companies.get(companyId) ?? null, deps);
  const input = {
    routeKey: "agent-tool",
    method: "POST",
    path: "/issues/issue-1/tools/status",
    params: { issueId: "issue-1", toolName: "status" },
    query: {},
    body: { actorId: "forged" },
    actor: { actorType: "agent", actorId: "agent-1", agentId: "agent-1", runId: "heartbeat-1" },
    companyId: COMPANY_A,
    headers: {},
  } as never;
  assert.equal((await handle({ ...input, body: {} } as never)).status, 403);
  bridge.store.putBinding({
    companyId: COMPANY_A,
    kind: "work_unit",
    providerId: "run-1:n1:0",
    projectId: PROJECT_A,
    payload: { runId: "run-1", nodeId: "n1", iteration: 0, issueId: "issue-1", agentRunRefId: "heartbeat-1" },
  });
  bound = true;
  assert.equal((await handle(input)).status, 400);
});

test("agent tool API resolves queued heartbeat IDs from the authenticated active issue execution", async () => {
  const bridge = await buildBridge({ companyId: COMPANY_A });
  bridges.push(bridge);
  bridge.runtime.seedRun("run-1", {
    scope: { companyRef: COMPANY_A, projectRef: PROJECT_A },
    graphId: "graph-test",
    entrypoint: "test.start",
    startIntentId: "intent-1",
  });
  bridge.store.putBinding({
    companyId: COMPANY_A,
    kind: "work_unit",
    providerId: "run-1:n1:0",
    projectId: PROJECT_A,
    payload: { runId: "run-1", nodeId: "n1", iteration: 0, issueId: "issue-1", agentRunRefId: null },
  });
  const deps = {
    runtime: (companyId: string) => companyId === COMPANY_A ? bridge.company.runtime : null,
    claim: () => null,
    recordClaim: () => undefined,
    bindingForAgentRun: () => null,
    bindingForIssueExecution: async (companyId: string, issueId: string, agentId: string, agentRunId: string) => {
      assert.deepEqual([companyId, issueId, agentId, agentRunId], [COMPANY_A, "issue-1", "agent-1", "heartbeat-2"]);
      return {
        companyId: COMPANY_A,
        runId: "run-1",
        nodeId: "n1",
        iteration: 0,
        issueId: "issue-1",
        projectId: PROJECT_A,
        contractHash: null,
      };
    },
    stopPreviousOwner: async () => "unknown" as const,
    bump: (companyId: string, counter: string) => bridge.metrics.bump(companyId, counter),
    warn: () => undefined,
    publishArtifact: async () => { throw new Error("not used by status"); },
  } as never;
  const handle = routes.createApiRequestHandler((companyId) => bridge.companies.get(companyId) ?? null, deps);
  const input = {
    routeKey: "agent-tool",
    method: "POST",
    path: "/issues/issue-1/tools/status",
    params: { issueId: "issue-1", toolName: "status" },
    query: {},
    body: {},
    actor: { actorType: "agent", actorId: "agent-1", agentId: "agent-1", runId: "heartbeat-2" },
    companyId: COMPANY_A,
    headers: {},
  } as never;

  const response = await handle(input);
  assert.equal(response.status, 200);
  assert.equal((response.body as { data: { runId: string } }).data.runId, "run-1");
});

test("manifest declares agent-only, checkout-bound access for PolyForge tool fallback", () => {
  const route = (manifestModule.default as { apiRoutes: { routeKey: string; method: string; path: string; auth: string; checkoutPolicy?: string }[] }).apiRoutes
    .find((entry) => entry.routeKey === "agent-tool");
  assert.deepEqual(route, {
    routeKey: "agent-tool",
    method: "POST",
    path: "/issues/:issueId/tools/:toolName",
    auth: "agent",
    capability: "api.routes.register",
    checkoutPolicy: "required-for-agent-in-progress",
    companyResolution: { from: "issue", param: "issueId" },
  });
});
