import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "ops", "probe-host.mjs");
const sdkVersion = JSON.parse(
  readFileSync(join(root, "node_modules", "@paperclipai", "plugin-sdk", "package.json"), "utf8"),
).version;

async function fakeHost({ agentStatus = 200, projectStatus = 200, projectWorkspaceStatus = 200, executionWorkspaceStatus = 200, installRouteSecurity = [{ BoardSessionAuth: [] }, { BoardApiKeyAuth: [] }], deploymentMode = "authenticated" } = {}) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    const adapterMatch = request.url.match(/^\/llms\/agent-configuration\/(codex_local|hermes_local|hermes_gateway)\.txt$/);
    if (adapterMatch) {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(`Adapter configuration: ${adapterMatch[1]}`);
      return;
    }
    const status = request.method === "POST" && request.url === "/api/plugins/install"
      ? 401
      : request.url === "/api/companies/probe-test-company/agents"
        ? agentStatus
        : request.url === "/api/companies/probe-test-company/projects"
          ? projectStatus
          : request.url === "/api/projects/private-project-id/workspaces"
            ? projectWorkspaceStatus
            : request.url === "/api/companies/probe-test-company/execution-workspaces"
              ? executionWorkspaceStatus
        : 200;
    const body = request.url === "/api/health"
      ? { status: "ok", version: sdkVersion, deploymentMode }
      : request.url === "/api/companies"
        ? [{ id: "probe-test-company" }]
        : request.url === "/api/plugins"
          ? [{ pluginKey: "polyforge", status: "ready", version: "0.1.0", packagePath: "/tmp/polyforge", grantedCapabilities: [] }]
          : request.url === "/api/companies/probe-test-company/agents"
            ? [
                { id: "agent-secret-id", name: "private-agent-name", adapterType: "codex_local", adapterConfig: { token: "do-not-report" } },
                { id: "another-secret-id", name: "another-private-name", adapterType: "hermes_local", adapterConfig: { token: "also-do-not-report" } },
              ]
          : request.url === "/api/companies/probe-test-company/projects"
            ? [{ id: "private-project-id", name: "private-project-name" }]
            : request.url === "/api/projects/private-project-id/workspaces"
              ? [{ id: "private-workspace-id", sourceType: "local_path", path: "C:/secret/project" }]
          : request.url === "/api/companies/probe-test-company/execution-workspaces"
                ? [{ id: "private-execution-workspace", sourceIssueId: "secret-issue", providerType: "git_worktree", mode: "isolated_workspace", status: "active", deliveryState: "unknown", cwd: "C:/secret/worktree", repoUrl: "https://secret.invalid/repo.git", baseRef: "private-branch", metadata: { commit: "a".repeat(40) } }]
          : request.url === "/api/execution-workspaces/private-execution-workspace"
            ? { workspace: { id: "private-execution-workspace", metadata: { git: { headCommit: "b".repeat(64) } } } }
          : request.url === "/api/openapi.json"
            ? {
                  paths: {
                    "/api/plugins/install": { post: { security: installRouteSecurity } },
                    "/api/plugins/{pluginId}/config": {
                      get: { security: [{ BoardSessionAuth: [] }, { BoardApiKeyAuth: [] }] },
                      post: { security: [{ BoardSessionAuth: [] }, { BoardApiKeyAuth: [] }] },
                    },
                  "/api/heartbeat-runs/{runId}/cancel": {
                    post: { security: [{ BoardSessionAuth: [] }, { BoardApiKeyAuth: [] }, { AgentBearerAuth: [] }] },
                  },
                  "/api/companies/{companyId}/tools/action-requests": {
                    get: { security: [{ BoardSessionAuth: [] }, { BoardApiKeyAuth: [] }] },
                  },
                  "/api/companies/{companyId}/tools/action-requests/{actionRequestId}/trust-rule": {
                    post: { security: [{ BoardSessionAuth: [] }, { BoardApiKeyAuth: [] }] },
                  },
                  "/api/tool-gateway/action-requests/{id}/approve": {
                    post: { security: [{ BoardSessionAuth: [] }, { BoardApiKeyAuth: [] }] },
                  },
                  "/api/tool-gateway/action-requests/{id}/decline": {
                    post: { security: [{ BoardSessionAuth: [] }, { BoardApiKeyAuth: [] }] },
                  },
                  "/api/approvals/{id}/approve": {
                    post: { security: [{ BoardSessionAuth: [] }, { BoardApiKeyAuth: [] }, { AgentBearerAuth: [] }] },
                  },
                },
              }
          : [];
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  return {
    requests,
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
    },
  };
}

async function runProbe(args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", rejectRun);
    child.once("close", (status) => resolveRun({ status, stdout, stderr }));
  });
}

test("the default host capability probe is read-only and does not pass a skipped auth check", async () => {
  const host = await fakeHost();
  try {
    const result = await runProbe(["--api", host.url]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(host.requests.some((request) => request.method !== "GET"), false);
    assert.equal(report.sections.server.unauthenticatedWrite.skipped, true);
    assert.equal(report.sections.server.hermesAdapterConfigReferences.hermes_local.available, true);
    assert.equal(report.sections.server.hermesAdapterConfigReferences.hermes_gateway.available, true);
    assert.equal(report.sections.server.hermesAdapterConfigReferences.hermes_local.matchesPinnedHash, false);
    assert.equal(report.sections.server.hermesAdapterConfigReferences.hermes_gateway.matchesPinnedHash, false);
    assert.equal(report.sections.server.codexLocalAdapterConfigReference.available, true);
    assert.equal(report.sections.server.codexLocalAdapterConfigReference.matchesPinnedHash, false);
    assert.deepEqual(report.sections.sdk.agentControlSurface, {
      agentMethods: ["get", "invoke", "list", "pause", "resume"],
      agentSessionMethods: ["close", "create", "list", "sendMessage"],
      exposesRunScopedCancel: false,
    });
    assert.deepEqual(report.sections.server.installRouteDeclaredSecurity, {
      status: 200,
      available: true,
      alternatives: [["BoardSessionAuth"], ["BoardApiKeyAuth"]],
      declaresAuthentication: true,
    });
    assert.deepEqual(report.sections.server.pluginConfigWriteRoute, {
      status: 200,
      present: true,
      securityAlternatives: [["BoardSessionAuth"], ["BoardApiKeyAuth"]],
      declaresAuthentication: true,
      source: "OpenAPI declaration only; does not establish admin-only access, effective authorization, or runtime enforcement",
    });
    assert.deepEqual(report.sections.server.heartbeatRunCancelRoute, {
      status: 200,
      available: true,
      method: "POST",
      securityAlternatives: [["BoardSessionAuth"], ["BoardApiKeyAuth"], ["AgentBearerAuth"]],
      source: "OpenAPI declaration only; not evidence this plugin has a supported credential or capability to call it",
    });
    assert.deepEqual(report.sections.server.toolGovernanceRoutes, {
      actionRequestList: { present: true, securityAlternatives: [["BoardSessionAuth"], ["BoardApiKeyAuth"]], declaresAuthentication: true },
      trustRuleCreate: { present: true, securityAlternatives: [["BoardSessionAuth"], ["BoardApiKeyAuth"]], declaresAuthentication: true },
      gatewayActionApprove: { present: true, securityAlternatives: [["BoardSessionAuth"], ["BoardApiKeyAuth"]], declaresAuthentication: true },
      gatewayActionDecline: { present: true, securityAlternatives: [["BoardSessionAuth"], ["BoardApiKeyAuth"]], declaresAuthentication: true },
      approvalDecide: { present: true, securityAlternatives: [["BoardSessionAuth"], ["BoardApiKeyAuth"], ["AgentBearerAuth"]], declaresAuthentication: true },
      source: "OpenAPI route declarations only; not proof of plugin capabilities, effective grants, or runtime enforcement",
    });
    assert.deepEqual(report.sections.server.companyAgentAdapters, {
      companyCount: 1,
      readableCompanyCount: 1,
      unreadableCompanyCount: 0,
      totalAgentCount: 2,
      adapterTypeCounts: { codex_local: 1, hermes_local: 1 },
      unclassifiedCount: 0,
    });
    assert.equal(report.sections.server.routes["GET /api/companies/{companyId}/agents"].ok, true);
    assert.deepEqual(report.sections.server.workspaceInventory, {
      companyCount: 1,
      projectCount: 1,
      readableProjectCompanies: 1,
      unreadableProjectCompanies: 0,
      projectWorkspaceCount: 1,
      readableProjectWorkspaceLists: 1,
      unreadableProjectWorkspaceLists: 0,
      projectWorkspaceSourceTypeCounts: { local_path: 1 },
      executionWorkspaceCount: 1,
      executionWorkspaceWithSourceIssueCount: 1,
      executionWorkspaceWithCwdCount: 1,
      executionWorkspaceWithRepoCoordinatesCount: 1,
      executionWorkspaceWithPinnedCommitCount: 1,
      readableExecutionWorkspaceDetails: 1,
      unreadableExecutionWorkspaceDetails: 0,
      executionWorkspaceDetailsWithPinnedCommitCount: 1,
      readableExecutionCompanies: 1,
      unreadableExecutionCompanies: 0,
      executionWorkspaceProviderTypeCounts: { git_worktree: 1 },
      executionWorkspaceModeCounts: { isolated_workspace: 1 },
      executionWorkspaceStatusCounts: { active: 1 },
      executionWorkspaceDeliveryStateCounts: { unknown: 1 },
    });
    assert.equal(report.sections.verdicts.projectInventoryReadable, true);
    assert.equal(report.sections.verdicts.projectWorkspaceInventoryReadable, true);
    assert.equal(report.sections.verdicts.executionWorkspaceInventoryReadable, true);
    assert.equal(report.sections.verdicts.executionWorkspaceDetailsReadable, true);
    assert.equal(report.sections.server.routes["GET /api/execution-workspaces/{id}"].ok, true);
    assert.equal(result.stdout.includes("private-agent-name"), false, "agent names must not be reported");
    assert.equal(result.stdout.includes("agent-secret-id"), false, "agent IDs must not be reported");
    assert.equal(result.stdout.includes("do-not-report"), false, "adapter configuration must not be reported");
    assert.equal(result.stdout.includes("private-project-name"), false, "project names must not be reported");
    assert.equal(result.stdout.includes("private-project-id"), false, "project IDs must not be reported");
    assert.equal(result.stdout.includes("private-workspace-id"), false, "workspace IDs must not be reported");
    assert.equal(result.stdout.includes("C:/secret"), false, "workspace paths must not be reported");
    assert.equal(result.stdout.includes("https://secret.invalid"), false, "repository URLs must not be reported");
    assert.equal(result.stdout.includes("secret-issue"), false, "workspace issue references must not be reported");
    assert.equal(result.stdout.includes("a".repeat(40)), false, "commit IDs must not be reported");
    assert.equal(result.stdout.includes("b".repeat(64)), false, "workspace detail commit values must not be reported");
    assert.equal(result.stdout.includes("private-execution-workspace"), false, "workspace IDs must not be reported");
    assert.equal(report.sections.verdicts.unauthenticatedWriteRefused, false);
    assert.equal(report.sections.verdicts.unauthenticatedWriteProbeExecuted, false);
    assert.equal(report.summary.ok, false, "unknown write authorization must not be reported as passing");
  } finally {
    await host.close();
  }
});

test("strict mode fails closed when the unauthenticated-write check was skipped", async () => {
  const host = await fakeHost();
  try {
    const result = await runProbe(["--api", host.url, "--strict"]);
    assert.notEqual(result.status, 0);
    const report = JSON.parse(result.stdout);
    assert.equal(host.requests.some((request) => request.method !== "GET"), false);
    assert.equal(report.sections.server.unauthenticatedWrite.skipped, true);
    assert.match(result.stderr, /unauthenticated write is refused/);
  } finally {
    await host.close();
  }
});

test("strict mode fails when company-scoped Agent profiles cannot be read", async () => {
  const host = await fakeHost({ agentStatus: 403 });
  try {
    const result = await runProbe([
      "--api", host.url,
      "--strict",
      "--probe-unauthenticated-write",
    ]);
    assert.notEqual(result.status, 0);
    const report = JSON.parse(result.stdout);
    assert.equal(report.sections.verdicts.companyAgentProfilesReadable, false);
    assert.ok(report.summary.blocking.some(([name]) => name === "company-scoped Agent profiles are readable"));
    assert.equal(host.requests.filter((request) => request.method === "POST").length, 1);
  } finally {
    await host.close();
  }
});

test("strict mode fails closed when workspace inventory routes cannot be read", async () => {
  const host = await fakeHost({ executionWorkspaceStatus: 403 });
  try {
    const result = await runProbe(["--api", host.url, "--strict", "--probe-unauthenticated-write"]);
    assert.notEqual(result.status, 0);
    const report = JSON.parse(result.stdout);
    assert.equal(report.sections.verdicts.executionWorkspaceInventoryReadable, false);
    assert.ok(report.summary.blocking.some(([name]) => name === "company execution workspaces are readable"));
  } finally {
    await host.close();
  }
});

test("strict mode fails when the install route has no declared auth requirement", async () => {
  const host = await fakeHost({ installRouteSecurity: [] });
  try {
    const result = await runProbe([
      "--api", host.url,
      "--strict",
      "--probe-unauthenticated-write",
    ]);
    assert.notEqual(result.status, 0);
    const report = JSON.parse(result.stdout);
    assert.equal(report.sections.verdicts.installRouteDeclaresAuthentication, false);
    assert.ok(report.summary.blocking.some(([name]) => name === "plugin install route declares authentication"));
  } finally {
    await host.close();
  }
});

test("a local_trusted host cannot be treated as a safe capability-grant boundary", async () => {
  const host = await fakeHost({ deploymentMode: "local_trusted" });
  try {
    const result = await runProbe(["--api", host.url]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.sections.server.pluginConfigWriteRoute.declaresAuthentication, true);
    assert.equal(report.sections.verdicts.pluginConfigGrantBoundarySafe, false);
    assert.ok(report.summary.blocking.some(([name]) => name === "plugin config capability grants have an authenticated admin boundary"));
    assert.equal(host.requests.some((request) => request.method !== "GET"), false);
  } finally {
    await host.close();
  }
});

test("the explicit unauthenticated-write probe is reported only after a loopback refusal", async () => {
  const host = await fakeHost();
  try {
    const result = await runProbe(["--api", host.url, "--probe-unauthenticated-write"]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(host.requests.filter((request) => request.method === "POST").length, 1);
    assert.equal(report.sections.server.unauthenticatedWrite.refused, true);
    assert.equal(report.sections.verdicts.unauthenticatedWriteProbeExecuted, true);
    assert.equal(report.sections.verdicts.installedPolyForgeReady, true);
    assert.equal(report.sections.verdicts.installedPolyForgePackageVersionMatchesSource, true);
    assert.equal(report.sections.verdicts.hostExposesPolyForgeCapabilityGrants, true);
    assert.equal(report.summary.ok, true);
  } finally {
    await host.close();
  }
});

test("the explicit write probe refuses non-loopback targets before making a request", async () => {
  const result = await runProbe(["--api", "https://example.invalid", "--probe-unauthenticated-write"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /restricted to a loopback Paperclip host/);
});
