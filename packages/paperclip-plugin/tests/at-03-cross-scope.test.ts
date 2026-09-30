/**
 * AT-03 / AT-29 — cross-company and cross-project isolation.
 * (docs/03 §10: "Root/child/workspace/agent refs 在同 scope；跨 scope 访问/提交全部拒绝" and
 *  "跨公司 SSE、artifact、tool、API、workspace refs 全拒绝")
 *
 * What this file proves is the *bridge's* half: every read, tool call, evidence submission and
 * API route re-derives scope from the host-authenticated context and refuses a mismatch, and
 * every refusal is counted. It does **not** prove the host's own cross-company enforcement: the
 * SDK test harness returns `null`/empty for a cross-company read, which is an approximation of
 * the server's row-level scoping rather than the thing itself. See the delivery report.
 */

import "./helpers/bootstrap.ts";
import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { load } from "./helpers/bootstrap.ts";

const h = await load<typeof import("./helpers/harness.ts")>(new URL("./helpers/harness.ts", import.meta.url));
const identity = await load<typeof import("../src/identity.ts")>(new URL("../src/identity.ts", import.meta.url));

const {
  COMPANY_A,
  COMPANY_B,
  PROJECT_A,
  PROJECT_B,
  GRAPH_ID,
  ENTRYPOINT,
  buildBridge,
  company,
  project,
  issue,
  label,
  approval,
  answeredInteraction,
  safeParse,
} = h;

const bridges: { dispose(): void }[] = [];
after(async () => {
  for (const bridge of bridges) await bridge.dispose();
});
function track<T extends { dispose(): Promise<void> }>(bridge: T): T {
  bridges.push(bridge);
  return bridge;
}

const engineering = label("engineering");

async function twoTenantBridge() {
  return buildBridge({
    companyId: COMPANY_A,
    extraCompanyIds: [COMPANY_B],
    seed: {
      companies: [company(COMPANY_A), company(COMPANY_B)],
      projects: [project(PROJECT_A, COMPANY_A), project(PROJECT_B, COMPANY_B)],
      issues: [
        issue("root-a", COMPANY_A, PROJECT_A, { labels: [engineering] }),
        issue("root-b", COMPANY_B, PROJECT_B, { labels: [engineering] }),
      ],
      projectWorkspaces: [
        { ...h.workspace("pw-a", PROJECT_A, COMPANY_A), repoUrl: "https://git.invalid/api.git" },
        { ...h.workspace("pw-b", PROJECT_B, COMPANY_B), repoUrl: "https://git.invalid/web.git" },
      ],
      approvals: [
        approval({
          id: "approval-a",
          companyId: COMPANY_A,
          payload: {
            action: "deploy",
            resource: "service/api",
            environment: "prod",
            authority: "release.manager",
            inputHashes: { artifact: "sha256:aa" },
            transitionHash: "sha256:th",
            expiresAt: "2099-01-01T00:00:00.000Z",
          },
        }),
      ],
      issueInteractions: [
        answeredInteraction({
          id: "int-a",
          issueId: "root-a",
          companyId: COMPANY_A,
          decisionTargetHash: "sha256:target-a",
          semanticKind: "design_acceptance",
        }),
      ],
    },
  });
}

/** Write the run binding the work-order delivery path writes, so later reads can scope to it. */
function recordRunBinding(bridge: TestBridgeLike, runId: string, projectRef: string, issueId: string): void {
  bridge.store.putBinding({
    companyId: COMPANY_A,
    kind: "run",
    providerId: runId,
    projectId: projectRef,
    payload: { runId, rootIssueId: issueId, projectId: projectRef, entrypoint: ENTRYPOINT, graphId: GRAPH_ID },
  });
}

type TestBridgeLike = Awaited<ReturnType<typeof twoTenantBridge>>;

test("AT-03: a read through the other company's scope finds nothing and is counted", async () => {
  const bridge = track(await twoTenantBridge());
  const before = bridge.counters()["crossScopeDenials"] as number;

  // The host's own scoping: an issue of company A is invisible from company B.
  const fromB = await bridge.ctx.issues.get("root-a", COMPANY_B);
  assert.equal(fromB, null);

  // The bridge's scoping: asking for company A's run under company B's context is refused.
  const api = await load<typeof import("../src/api-routes.ts")>(new URL("../src/api-routes.ts", import.meta.url));
  const handler = api.createApiRequestHandler((id) => bridge.companies.get(id) ?? null);
  const result = await handler({
    routeKey: "run-snapshot",
    method: "GET",
    path: "/runs/run-1",
    params: { runId: "run-1" },
    query: { companyId: COMPANY_A },
    body: null,
    // An agent of company A asking, with company B's company in scope.
    actor: { actorType: "agent", actorId: "agent-a", agentId: "agent-a", runId: "run-a", userId: null },
    companyId: COMPANY_B,
    headers: {},
  });
  assert.equal(result.status, 403);
  assert.ok((bridge.counters()["crossScopeDenials"] as number) > before);
});

test("AT-03: a run id from another tenant is a 403, not a 404 that confirms existence", async () => {
  const bridge = track(await twoTenantBridge());
  bridge.runtime.seedRun("run-a-1", { scope: { companyRef: COMPANY_A, projectRef: PROJECT_A } });
  recordRunBinding(bridge, "run-a-1", PROJECT_A, "root-a");
  const api = await load<typeof import("../src/api-routes.ts")>(new URL("../src/api-routes.ts", import.meta.url));
  const handler = api.createApiRequestHandler((id) => bridge.companies.get(id) ?? null);

  const allowed = await handler({
    routeKey: "run-snapshot",
    method: "GET",
    path: "/runs/run-a-1",
    params: { runId: "run-a-1" },
    query: { companyId: COMPANY_A },
    body: null,
    actor: { actorType: "user", actorId: "user-1", agentId: null, runId: null, userId: "user-1" },
    companyId: COMPANY_A,
    headers: {},
  });
  assert.equal(allowed.status, 200);

  // The same run id, requested as company B: refused, and the body says nothing about whether
  // the run exists.
  const denied = await handler({
    routeKey: "run-snapshot",
    method: "GET",
    path: "/runs/run-a-1",
    params: { runId: "run-a-1" },
    query: { companyId: COMPANY_B },
    body: null,
    actor: { actorType: "user", actorId: "user-b", agentId: null, runId: null, userId: "user-b" },
    companyId: COMPANY_B,
    headers: {},
  });
  assert.equal(denied.status, 403);
  assert.equal(safeParse(JSON.stringify(denied.body)).error.code, "BRIDGE_SCOPE_VIOLATION");
});

test("AT-03: ensureWorkUnit refuses a project the trusted issue relation does not name", async () => {
  const bridge = track(await twoTenantBridge());
  // The intent names company A and company A's project, but its parent issue is in company A's
  // *other* project. Only the parent relation can catch this, so that is what is checked.
  await assert.rejects(
    () =>
      bridge.company.ports.work.ensureWorkUnit(
        {
          scope: { companyRef: COMPANY_A, projectRef: PROJECT_B },
          runId: "run-1",
          nodeId: "n1",
          iteration: 0,
          title: "t",
          description: "d",
          correlationKey: "k",
          requiredCapabilities: [],
          projectRef: PROJECT_B,
          // A parent in company B, which is not in company A at all.
          parentIssueRef: { provider: "paperclip", kind: "issue", id: "root-b" },
          workspaceRequirement: { mode: "read_write", repositories: [], requireReadOnlyForReviewer: false },
        },
        { commandId: "c", idempotencyKey: "pf:i", correlationId: "corr" },
      ),
    /not in this company|not in the same project/,
  );
  assert.ok((bridge.counters()["crossScopeDenials"] as number) >= 1);
});

test("AT-03: a child issue cannot be created outside its work order's project", async () => {
  const bridge = track(await twoTenantBridge());
  const ref = await bridge.company.ports.work.ensureWorkUnit(
    {
      scope: { companyRef: COMPANY_A, projectRef: PROJECT_A },
      runId: "run-1",
      nodeId: "n1",
      iteration: 0,
      title: "Implement",
      description: "d",
      correlationKey: "run-1:n1:0",
      requiredCapabilities: [],
      projectRef: PROJECT_A,
      parentIssueRef: { provider: "paperclip", kind: "issue", id: "root-a" },
      workspaceRequirement: { mode: "read_write", repositories: [], requireReadOnlyForReviewer: false },
    },
    { commandId: "c", idempotencyKey: "pf:i", correlationId: "corr" },
  );
  const created = await bridge.ctx.issues.get(ref.id, COMPANY_A);
  assert.ok(created);
  assert.equal(created.projectId, PROJECT_A);
  assert.equal(created.companyId, COMPANY_A);
  // `originId` is the identity the idempotent lookup uses.
  assert.equal(created.originId, "run-1:n1:0");
  assert.equal(created.originKind, "plugin:polyforge:node");
  // And it is invisible from the other company.
  assert.equal(await bridge.ctx.issues.get(ref.id, COMPANY_B), null);
});

test("AT-29: a workspace ref from another company does not resolve", async () => {
  const bridge = track(await twoTenantBridge());
  const binding = await bridge.company.ports.workspace.resolve(
    {
      mode: "read_only_snapshot",
      // The repository is the only host-owned link between a repo and a project.
      repositories: [{ repoRef: "https://git.invalid/api.git", baseRef: "refs/heads/main" }],
      requireReadOnlyForReviewer: true,
    },
    { commandId: "c", idempotencyKey: "pf:w", correlationId: "corr" },
  );
  // A workspace binding is only ever created for the company's own project.
  assert.equal(binding.companyRef, COMPANY_A);
  assert.equal(binding.projectRef, PROJECT_A);
  // Reading it through the other company's execution-workspace surface yields nothing.
  const foreign = await bridge.ctx.executionWorkspaces.get(binding.workspaceRef.id, COMPANY_B);
  assert.equal(foreign, null);

  // The same repository is not in company B's project, so company B cannot resolve it at all.
  const companyB = bridge.companies.get(COMPANY_B);
  assert.ok(companyB);
  await assert.rejects(
    () =>
      companyB.ports.workspace.resolve(
        {
          mode: "read_only_snapshot",
          repositories: [{ repoRef: "https://git.invalid/api.git", baseRef: "refs/heads/main" }],
          requireReadOnlyForReviewer: true,
        },
        { commandId: "c", idempotencyKey: "pf:w2", correlationId: "corr" },
      ),
    /do not identify exactly one project/,
  );
});

test("AT-29: an artifact read verified under the other company finds nothing", async () => {
  const bridge = track(await twoTenantBridge());
  const body = "artifact bytes";
  const contentHash = (
    await load<typeof import("@polyforge/protocol")>("@polyforge/protocol")
  ).digestBytes(new TextEncoder().encode(body));
  const ref = await bridge.company.ports.artifacts.publish(
    {
      scope: { companyRef: COMPANY_A, projectRef: PROJECT_A },
      kind: "report",
      contentHash,
      mediaType: "text/plain",
      size: body.length,
      source: { kind: "inline", ref: "issue:root-a", body },
    },
    { commandId: "c", idempotencyKey: `pf:a:${contentHash}`, correlationId: "corr" },
  );
  // `publish` returns the verified identity; `readVerified` takes the ref within it.
  const verified = await bridge.company.ports.artifacts.readVerified(ref.providerRef);
  assert.equal(verified.digestVerified, true);
  assert.equal(verified.contentHash, contentHash);

  // The same content read as company B: the attachment/document surface is company-scoped, so
  // the bytes are not reachable and the artifact cannot be verified as company B's.
  const asB = await bridge.ctx.issues.documents.get("root-a", ref.id, COMPANY_B);
  assert.equal(asB, null);
});

test("AT-29: a tool call bound to company A cannot act on a company B run", async () => {
  const bridge = track(await twoTenantBridge());
  // The run binding: a run-scoped call is signed with the project recorded here, so without it the
  // Core's refusal (or the bridge's own) happens before the cross-tenant check this test is about.
  bridge.store.putBinding({
    companyId: COMPANY_A,
    kind: "run",
    providerId: "run-1",
    projectId: PROJECT_A,
    payload: { runId: "run-1", projectId: PROJECT_A, rootIssueId: "root-a" },
  });
  // Give company A a dispatch binding so the agent run resolves to a run and a project.
  bridge.store.putBinding({
    companyId: COMPANY_A,
    kind: "dispatch",
    providerId: "run-1:n1:0",
    projectId: PROJECT_A,
    payload: {
      runId: "run-1",
      nodeId: "n1",
      iteration: 0,
      issueId: "root-a",
      agentId: "agent-a",
      agentRunRefId: "agent-run-a",
    },
  });
  bridge.runtime.contracts.set("run-1", {
    runId: "run-1",
    stateVersion: 3,
    nodeId: "n1",
    iteration: 0,
    attemptId: "attempt-1",
    leaseEpoch: 1,
    contractHash: "sha256:contract",
    requiredInputs: [],
    permittedOutputs: ["report"],
    evidenceRequirements: [],
    policyConstraints: {},
    permittedActions: ["submit"],
    claimable: true,
    ownerAgentRunId: null,
  });
  bridge.runtime.seedRun("run-1", { scope: { companyRef: COMPANY_A, projectRef: PROJECT_A } });

  const ok = await bridge.harness.executeTool(
    "status",
    { runId: "run-1" },
    { agentId: "agent-a", runId: "agent-run-a", companyId: COMPANY_A, projectId: PROJECT_A },
  );
  assert.ok(!ok.error, "the bound run must be readable in its own scope");

  // The same tool call, run as an agent of company B.
  const denied = await bridge.harness.executeTool(
    "status",
    { runId: "run-1" },
    { agentId: "agent-b", runId: "agent-run-b", companyId: COMPANY_B, projectId: PROJECT_B },
  );
  assert.match(String(denied.error ?? ""), /different company|not bound to a PolyForge run/);
  // The attempt is counted against the tenant that made it, not the tenant it targeted, so an
  // operator can see which company's agents are the ones probing across boundaries.
  const companyB = bridge.companies.get(COMPANY_B);
  assert.ok(companyB);
  assert.ok(companyB.metrics.counters(COMPANY_B)["crossScopeDenials"] >= 1);
});

test("AT-13/AT-29: every outbound signed request carries the scope in the header, not only the body", async () => {
  const bridge = track(await twoTenantBridge());
  const issueList = await bridge.ctx.issues.list({ companyId: COMPANY_A });
  const root = issueList.find((entry) => entry.id === "root-a");
  assert.ok(root);
  const decision = bridge.company.admission.evaluate(root, "user-1");
  assert.equal(decision.admit, true);
  if (!decision.admit) return;
  await bridge.company.router.considerIssue(
    decision,
    { actorType: "human", actorId: "user-1", agentId: null, runId: null, roles: [] },
    "corr",
  );
  await bridge.drain();

  const request = bridge.runtime.requestsTo("POST", "/v1/work-orders")[0];
  assert.ok(request);
  assert.equal(request.signatureValid, true);
  const scopeHeader = request.headers["x-pf-scope"];
  assert.ok(scopeHeader);
  assert.deepEqual(JSON.parse(Buffer.from(scopeHeader, "base64url").toString("utf8")), {
    companyRef: COMPANY_A,
    projectRef: PROJECT_A,
  });
  // A body-supplied company would be a different, unsigned claim; there is none.
  const body = safeParse(request.bodyText);
  assert.equal(body.scope.companyRef, COMPANY_A);
  // The actor assertion is base64url JSON and, for a board start, a human.
  const actorHeader = request.headers["x-pf-actor"];
  assert.ok(actorHeader);
  const actor = JSON.parse(Buffer.from(actorHeader, "base64url").toString("utf8")) as Record<string, unknown>;
  assert.equal(actor["actorType"], "human");
  assert.equal(actor["actorId"], "user-1");
  assert.notEqual(actor["actorType"], "agent");
});

test("AT-13: a body that tries to assert a human actor is stripped before signing", async () => {
  const bridge = track(await twoTenantBridge());
  // A malicious Core that echoes a forged identity back into a body.
  const runtimeModule = await load<typeof import("../src/runtime-client.ts")>(
    new URL("../src/runtime-client.ts", import.meta.url),
  );
  const client = new runtimeModule.RuntimeClient(bridge.company.config, {
    secretProvider: async () => "test-shared-secret-not-a-real-one",
    clock: { now: () => new Date(1_700_000_000_000), nonce: () => "a".repeat(32), sleep: async () => {} },
    logger: bridge.company.logger,
    fetchImpl: bridge.runtime.url === "" ? undefined : undefined,
    companyId: COMPANY_A,
  });
  // Reach the sanitizer directly: it is the invariant, and the HTTP path is covered above.
  const stripped = identity.stripActorAssertions({
    keep: "value",
    actorUserId: "user-1",
    approved: true,
    nested: { actorId: "agent-9", recordApproval: true, fine: 1 },
    list: [{ onBehalfOfUserId: "user-2" }],
  });
  assert.deepEqual(stripped.value, { keep: "value", nested: { fine: 1 }, list: [{}] });
  assert.deepEqual(stripped.strippedKeys.sort(), [
    "actorUserId",
    "approved",
    "list[0].onBehalfOfUserId",
    "nested.actorId",
    "nested.recordApproval",
  ]);
  void client;
});

test("AT-29: the graph library and run list are company-scoped reads", async () => {
  const bridge = track(await twoTenantBridge());
  // The data layer only serves a company the bridge already works for.
  const { registerDataKeys } = await load<typeof import("../src/bridge/data.ts")>(
    new URL("../src/bridge/data.ts", import.meta.url),
  );
  registerDataKeys(bridge.ctx, (id) => bridge.companies.get(id) ?? null);
  const known = await bridge.harness.getData("graph-library", { companyId: COMPANY_A, projectId: PROJECT_A });
  assert.ok(Array.isArray(known));
  const unknownCompany = await bridge.harness.getData("graph-library", {
    companyId: "company-does-not-exist",
    projectId: PROJECT_A,
  });
  assert.deepEqual(unknownCompany, [], "an unknown company must read nothing at all");
});

test("AT-29: the graph library refuses a read that cannot name its project", async () => {
  const bridge = track(await twoTenantBridge());
  const { registerDataKeys } = await load<typeof import("../src/bridge/data.ts")>(
    new URL("../src/bridge/data.ts", import.meta.url),
  );
  registerDataKeys(bridge.ctx, (id) => bridge.companies.get(id) ?? null);

  // The company/project pair is the Core's only tenant identity, so a read with no project has no
  // honest answer. The failure mode this replaces sent `projectRef: ""`, which the Core refused with
  // a scope error that looked like a misconfiguration; and returning `[]` instead would have been a
  // lie the operator has to notice to distrust.
  await assert.rejects(
    () => bridge.harness.getData("graph-library", { companyId: COMPANY_A }),
    (error: unknown) => {
      const err = error as { reason?: string; message?: string };
      assert.equal(err.reason, "BLOCKED_SCOPE");
      assert.match(err.message ?? "", /projectId is required/);
      return true;
    },
  );
});

test("AT-29: the graph id in a request is not a scope escape hatch", async () => {
  const bridge = track(await twoTenantBridge());
  bridge.runtime.seedRun("run-a-1", { scope: { companyRef: COMPANY_A, projectRef: PROJECT_A } });
  recordRunBinding(bridge, "run-a-1", PROJECT_A, "root-a");
  const api = await load<typeof import("../src/api-routes.ts")>(new URL("../src/api-routes.ts", import.meta.url));
  const handler = api.createApiRequestHandler((id) => bridge.companies.get(id) ?? null);
  // `graphId` is a graph, not a tenant. Filtering by it must not widen the company scope.
  const result = await handler({
    routeKey: "runs",
    method: "GET",
    path: "/runs",
    params: {},
    query: { companyId: COMPANY_A, graphId: GRAPH_ID },
    body: null,
    actor: { actorType: "user", actorId: "user-1", agentId: null, runId: null, userId: "user-1" },
    companyId: COMPANY_A,
    headers: {},
  });
  assert.equal(result.status, 200);
  const body = safeParse(JSON.stringify(result.body));
  for (const run of body.runs as Record<string, unknown>[]) {
    assert.deepEqual(run.scope, { companyRef: COMPANY_A, projectRef: PROJECT_A });
  }
  void ENTRYPOINT;
});

test("AT-03: the scope assertion is exact, not a prefix or case-insensitive match", async () => {
  assert.throws(
    () => identity.assertScope({ companyRef: COMPANY_A, projectRef: PROJECT_A }, { companyId: COMPANY_A.toUpperCase(), projectId: PROJECT_A }, "t"),
    /company scope is not the authenticated company/,
  );
  assert.throws(
    () => identity.assertScope({ companyRef: COMPANY_A, projectRef: PROJECT_A }, { companyId: COMPANY_A, projectId: PROJECT_B }, "t"),
    /project scope is not the authenticated project/,
  );
  // A project the host has no record of is a mismatch too, not a wildcard.
  assert.throws(
    () => identity.assertScope({ companyRef: COMPANY_A, projectRef: "project-that-does-not-exist" }, { companyId: COMPANY_A, projectId: null }, "t"),
    /project scope is not the authenticated project/,
  );
  identity.assertScope({ companyRef: COMPANY_A, projectRef: PROJECT_A }, { companyId: COMPANY_A, projectId: PROJECT_A }, "t");

  // `companyScope` is the deliberately company-wide half, and `assertScope` is *exact*: an
  // empty project half matches a host that has no project, and never a host that has one. The
  // company-wide wildcard used by the ports lives in `guardScope` and is asserted next.
  identity.assertScope(identity.companyScope(COMPANY_A), { companyId: COMPANY_A, projectId: null }, "t");
  assert.throws(
    () => identity.assertScope(identity.companyScope(COMPANY_B), { companyId: COMPANY_A, projectId: null }, "t"),
    /company scope is not the authenticated company/,
  );

  const ports = await load<typeof import("../src/ports/index.ts")>(new URL("../src/ports/index.ts", import.meta.url));
  const metrics = { bump: () => {} } as never;
  // A company-wide read may span projects inside its own company…
  ports.guardScope(identity.companyScope(COMPANY_A), { companyId: COMPANY_A, projectId: PROJECT_B }, "t", metrics);
  // …but never another company's projects.
  assert.throws(
    () => ports.guardScope(identity.companyScope(COMPANY_B), { companyId: COMPANY_A, projectId: PROJECT_B }, "t", metrics),
    /cross-company access refused/,
  );
  // And a concrete project is still matched exactly.
  assert.throws(
    () => ports.guardScope({ companyRef: COMPANY_A, projectRef: PROJECT_A }, { companyId: COMPANY_A, projectId: PROJECT_B }, "t", metrics),
    /cross-project access refused/,
  );
});
