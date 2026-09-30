/**
 * AT-14 — authorization is exact, expiry is real, and a dispatch names one worker.
 * (docs/03 §10 AT-14: "authorization 过期/撤销/精确匹配/wakeup 正常/dead-letter 人工可见")
 *
 * The point of this file is that an authorization is a *bound target*, not a permission: it is
 * granted for one action, one resource, one environment, one transition hash and one set of input
 * hashes, and it stops being valid when the clock passes `expiresAt` or a human cancels it. The
 * bridge never treats "there is an approval" as "approved".
 *
 * Harness limits: `ctx.approvals` is a map, so a cancellation is a status the test sets. The
 * reconciler's timer-driven re-check is exercised directly rather than by waiting for a cron.
 */

import "./helpers/bootstrap.ts";
import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { load } from "./helpers/bootstrap.ts";

const h = await load<typeof import("./helpers/harness.ts")>(new URL("./helpers/harness.ts", import.meta.url));

const { COMPANY_A, PROJECT_A, buildBridge, company, project, issue, label } = h;
const bridges: { dispose(): void }[] = [];
after(async () => {
  for (const bridge of bridges) await bridge.dispose();
});
function track<T extends { dispose(): Promise<void> }>(bridge: T): T {
  bridges.push(bridge);
  return bridge;
}

const SCOPE = { companyRef: COMPANY_A, projectRef: PROJECT_A };
const ACTION = "deploy.production";
const RESOURCE = "svc-checkout@prod";
const ENVIRONMENT = "production";
const TRANSITION_HASH = "sha256:transition-14";
const INPUT_HASHES = { manifest: "sha256:manifest-1", plan: "sha256:plan-1" };
const META = { commandId: "c14", idempotencyKey: "pf:auth:14", correlationId: "corr-14" };

const FUTURE = "2999-01-01T00:00:00.000Z";
const PAST = "2000-01-01T00:00:00.000Z";

function request(overrides: Record<string, unknown> = {}) {
  return {
    scope: SCOPE,
    action: ACTION,
    resource: RESOURCE,
    environment: ENVIRONMENT,
    authority: "platform:release-manager",
    policyRef: "policy:prod-deploy",
    inputHashes: INPUT_HASHES,
    transitionHash: TRANSITION_HASH,
    expiresAt: FUTURE,
    ...overrides,
  };
}

/**
 * An approval a human already created for exactly this target.
 *
 * `status` is deliberately separate from `payload`: an approval's status is the host's field, and a
 * test that set it inside the payload would be testing a revocation the host never recorded.
 */
function approval(options: { status?: string; payload?: Record<string, unknown> } = {}) {
  return {
    id: "ap-1",
    companyId: COMPANY_A,
    status: options.status ?? "approved",
    title: "Deploy checkout to production",
    payload: {
      action: ACTION,
      resource: RESOURCE,
      environment: ENVIRONMENT,
      authority: "platform:release-manager",
      transitionHash: TRANSITION_HASH,
      inputHashes: INPUT_HASHES,
      expiresAt: FUTURE,
      ...(options.payload ?? {}),
    },
  } as never;
}

async function withApproval(approvals: unknown[]) {
  return buildBridge({
    seed: {
      companies: [company(COMPANY_A)],
      projects: [project(PROJECT_A, COMPANY_A)],
      issues: [issue("root-1", COMPANY_A, PROJECT_A, { labels: [label("engineering")] })],
      approvals: approvals as never,
    },
  });
}

const exactAction = (overrides: Record<string, unknown> = {}) => ({
  action: ACTION,
  resource: RESOURCE,
  environment: ENVIRONMENT,
  inputHashes: INPUT_HASHES,
  transitionHash: TRANSITION_HASH,
  ...overrides,
});

test("AT-14: an approval for this exact target is found and bound to the transition", async () => {
  const bridge = track(await withApproval([approval()]));
  const ref = await bridge.company.ports.governance.requestActionAuthorization(request(), META);
  assert.equal(ref.kind, "approval");
  assert.equal(ref.id, "ap-1");
  // The binding records the target, so a later check is against a recorded fact.
  const row = bridge.store.getBinding(COMPANY_A, "governance_authorization", ref.id);
  assert.ok(row, "the authorization binding must be durable, keyed by the approval ref");
  const payload = JSON.parse(row.payloadJson) as Record<string, unknown>;
  assert.equal(payload["action"], ACTION);
  assert.equal(payload["transitionHash"], TRANSITION_HASH);
  assert.equal(payload["expiresAt"], FUTURE);
  assert.equal(payload["approvalId"], "ap-1");
  // And the effect key is kept, so a repeat request finds the grant without re-listing approvals.
  assert.equal(typeof payload["effectKey"], "string");
});

test("AT-14: the same request twice reuses the approval instead of asking again", async () => {
  const bridge = track(await withApproval([approval()]));
  const first = await bridge.company.ports.governance.requestActionAuthorization(request(), META);
  const second = await bridge.company.ports.governance.requestActionAuthorization(request(), META);
  assert.equal(first.id, second.id);
});

test("AT-14: an approval for a different input hash is not this authorization", async () => {
  // Same action, same resource, same transition — but a different plan. That is a different thing
  // to approve, and reusing the approval would be the exact substitution AT-14 forbids.
  const bridge = track(
    await withApproval([
      approval({ payload: { inputHashes: { manifest: "sha256:manifest-1", plan: "sha256:plan-OTHER" } } }),
    ]),
  );
  // No approval matched and the bridge cannot create one, so the action is blocked outright.
  // Failing closed is the requirement; failing closed *silently* would not be.
  await assert.rejects(
    () => bridge.company.ports.governance.requestActionAuthorization(request(), META),
    (error: Error) => {
      assert.match(error.message, /BLOCKED_AUTHORIZATION/);
      return true;
    },
  );
  assert.equal(bridge.store.countDeliveries(COMPANY_A, "pending"), 0, "a blocked authorization queues nothing");
});

test("AT-14: an approval for a different environment does not cover production", async () => {
  const bridge = track(await withApproval([approval({ payload: { environment: "staging" } })]));
  await assert.rejects(
    () => bridge.company.ports.governance.requestActionAuthorization(request(), META),
    /BLOCKED_AUTHORIZATION/,
  );
});

test("AT-14: an expired approval is recorded but never granted", async () => {
  const bridge = track(await withApproval([approval({ payload: { expiresAt: PAST } })]));
  // The approval matches the target, so it is found and bound — and then the clock says no.
  const ref = await bridge.company.ports.governance.requestActionAuthorization(request(), META);
  assert.equal(ref.id, "ap-1");
  const status = await bridge.company.ports.governance.checkAuthorization(ref, exactAction());
  assert.equal(status.granted, false, "an expired authorization must not authorize anything");
  assert.equal(status.expiresAt, PAST);
  assert.match(status.reason, /expired/i);
});

test("AT-14: a cancelled approval is revoked, not merely absent", async () => {
  const bridge = track(await withApproval([approval({ status: "cancelled" })]));
  const ref = await bridge.company.ports.governance.requestActionAuthorization(request(), META);
  const status = await bridge.company.ports.governance.checkAuthorization(ref, exactAction());
  assert.equal(status.granted, false);
  assert.equal(status.revoked, true, "a revocation must be distinguishable from never-granted");
});

test("AT-14: a check against a different action than the one recorded is refused", async () => {
  const bridge = track(await withApproval([approval()]));
  const ref = await bridge.company.ports.governance.requestActionAuthorization(request(), META);
  // Granted for the recorded target...
  const granted = await bridge.company.ports.governance.checkAuthorization(ref, exactAction());
  assert.equal(granted.granted, true);
  assert.equal(granted.exactMatch, true);
  // ...and refused for a wider one. An authorization is not a capability.
  const widened = await bridge.company.ports.governance.checkAuthorization(
    ref,
    exactAction({ action: "deploy.anything" }),
  );
  assert.equal(widened.granted, false);
  assert.equal(widened.exactMatch, false);
  // A changed input hash is the substitution that matters most: the plan was edited after approval.
  const edited = await bridge.company.ports.governance.checkAuthorization(
    ref,
    exactAction({ inputHashes: { manifest: "sha256:manifest-1", plan: "sha256:plan-EDITED" } }),
  );
  assert.equal(edited.granted, false);
});

test("AT-14: a ref the bridge never recorded cannot be checked into existence", async () => {
  const bridge = track(await withApproval([approval()]));
  const status = await bridge.company.ports.governance.checkAuthorization(
    { provider: "paperclip", kind: "approval", id: "ap-someone-elses" },
    exactAction(),
  );
  assert.equal(status.granted, false);
  assert.match(status.reason, /not bound in this company|never recorded|no recorded scope/);
});

test("AT-14: the reconciler re-checks an expiry noticed between admission and commit", async () => {
  // The dangerous window: admitted while valid, committed after expiry. Only a re-check on a
  // timer catches it, which is why the reconciler exists.
  const bridge = track(await withApproval([approval()]));
  const ref = await bridge.company.ports.governance.requestActionAuthorization(request(), META);
  const before = await bridge.company.ports.governance.checkAuthorization(
    { provider: "paperclip", kind: "approval", id: ref.id },
    exactAction(),
  );
  assert.equal(before.granted, true);

  // Time passes and the approval lapses. The host has no approval-update call, so the change is
  // seeded — which is also the only way a real expiry would be observed: a re-read, never a cache.
  bridge.harness.seed({ approvals: [approval({ payload: { expiresAt: PAST } })] });

  const report = await bridge.company.reconciler.reconcileCompany(COMPANY_A);
  assert.ok(report.authorizationsChecked >= 1, "authorizations must be re-checked on the timer");
  assert.ok(
    report.issues.some((line) => /authoriz/i.test(line)),
    `an expired authorization must be reported, got ${JSON.stringify(report.issues)}`,
  );
  const after = await bridge.company.ports.governance.checkAuthorization(ref, exactAction());
  assert.equal(after.granted, false);
  // And the change in grant state is recorded, so the reconciler can tell a human what moved.
  const row = bridge.store.getBinding(COMPANY_A, "governance_authorization", "ap-1");
  const payload = JSON.parse(String(row?.payloadJson ?? "{}")) as Record<string, unknown>;
  assert.equal(payload["lastKnownGranted"], "denied");
  assert.match(String(payload["lastReason"]), /expired/i);
});

test("AT-08/AT-14: dispatch asks Paperclip to wake the assigned worker; the plugin cannot invoke it", async () => {
  const bridge = track(await withApproval([]));
  const { default: manifest } = await load<typeof import("../src/manifest.ts")>(
    new URL("../src/manifest.ts", import.meta.url),
  );
  const capabilities = new Set(manifest.capabilities as string[]);
  assert.equal(capabilities.has("agents.invoke"), false);
  assert.equal(capabilities.has("agent.sessions.create"), false);

  // A work unit, already materialized on the child issue, and a worker that is allowed to run it.
  bridge.store.putBinding({
    companyId: COMPANY_A,
    kind: "work_unit",
    providerId: "run-1:n1:0",
    projectId: PROJECT_A,
    payload: {
      runId: "run-1",
      nodeId: "n1",
      iteration: 0,
      issueId: "child-1",
      workspaceRequirement: { mode: "read_write", repositories: [], requireReadOnlyForReviewer: false },
    },
  });
  h.seedChildIssue(bridge, "child-1");
  h.seedCapabilityBinding(bridge, COMPANY_A, "agent:paperclip/agent-1", "agent-1");
  const wakeupCalls: unknown[][] = [];
  const requestWakeup = bridge.ctx.issues.requestWakeup.bind(bridge.ctx.issues);
  bridge.ctx.issues.requestWakeup = async (...args) => {
    wakeupCalls.push(args);
    return requestWakeup(...args);
  };

  const receipt = await bridge.company.ports.work.assignAndWake(
    {
      scope: SCOPE,
      runId: "run-1",
      nodeId: "n1",
      iteration: 0,
      workUnitRef: { provider: "paperclip", kind: "issue", id: "child-1" },
      workerSubjectRef: "agent:paperclip/agent-1",
      attemptId: "attempt-1",
    } as never,
    META,
  );
  assert.equal(receipt.queued, true);
  assert.ok(receipt.agentRunRef, "a wakeup must produce a run the bridge can bind");
  assert.equal(wakeupCalls.length, 1, "the bridge uses Paperclip's scheduler API exactly once");
  assert.deepEqual(wakeupCalls[0]?.slice(0, 2), ["child-1", COMPANY_A]);
  assert.deepEqual(wakeupCalls[0]?.[2], {
    reason: "PolyForge node n1 is READY (attempt attempt-1)",
    contextSource: "polyforge",
    idempotencyKey: META.idempotencyKey,
    actorAgentId: null,
    actorUserId: null,
    actorRunId: null,
  });
  // The child issue is assigned, and the platform — not the bridge — decides whether to wake.
  const child = await bridge.ctx.issues.get("child-1", COMPANY_A);
  assert.equal(child?.assigneeAgentId, "agent-1");
});

test("AT-06: a repo-backed node is not assigned or woken without a verified isolated workspace", async () => {
  const bridge = track(await withApproval([]));
  bridge.store.putBinding({
    companyId: COMPANY_A,
    kind: "work_unit",
    providerId: "run-1:n1:0",
    projectId: PROJECT_A,
    payload: {
      runId: "run-1",
      nodeId: "n1",
      iteration: 0,
      issueId: "child-1",
      workspaceRequirement: {
        mode: "read_write",
        repositories: [{ repoRef: "https://example.invalid/repo.git", baseRef: "main", commit: "a".repeat(40) }],
        requireReadOnlyForReviewer: false,
      },
    },
  });
  h.seedChildIssue(bridge, "child-1", {
    currentExecutionWorkspace: {
      companyId: COMPANY_A,
      projectId: PROJECT_A,
      status: "active",
      mode: "shared_workspace",
      providerType: "local_fs",
      cwd: "/work/shared",
    } as never,
  });
  h.seedCapabilityBinding(bridge, COMPANY_A, "agent:paperclip/agent-1", "agent-1");
  let wakeupCount = 0;
  const requestWakeup = bridge.ctx.issues.requestWakeup.bind(bridge.ctx.issues);
  bridge.ctx.issues.requestWakeup = async (...args) => {
    wakeupCount += 1;
    return requestWakeup(...args);
  };

  const receipt = await bridge.company.ports.work.assignAndWake(
    {
      scope: SCOPE,
      runId: "run-1",
      nodeId: "n1",
      iteration: 0,
      workUnitRef: { provider: "paperclip", kind: "issue", id: "child-1" },
      workerSubjectRef: "agent:paperclip/agent-1",
      attemptId: "attempt-1",
    } as never,
    META,
  );

  assert.equal(receipt.queued, false);
  assert.equal(receipt.reason, "verified_isolated_execution_workspace_and_commit_required");
  assert.equal(wakeupCount, 0, "a shared workspace must not trigger an AgentRun");
  const child = await bridge.ctx.issues.get("child-1", COMPANY_A);
  assert.equal(child?.assigneeAgentId, null, "a blocked repo task must not be assigned");
  const dispatch = bridge.store.getBinding(COMPANY_A, "dispatch", "run-1:n1:0");
  assert.equal(dispatch, null, "a blocked repo task must not acquire an AgentRun binding");
});

test("AT-06: a repo-backed node reports an unrealized workspace without assigning or waking", async () => {
  const bridge = track(await withApproval([]));
  bridge.store.putBinding({
    companyId: COMPANY_A,
    kind: "work_unit",
    providerId: "run-1:n1:0",
    projectId: PROJECT_A,
    payload: {
      runId: "run-1",
      nodeId: "n1",
      iteration: 0,
      issueId: "child-1",
      workspaceRequirement: {
        mode: "read_write",
        repositories: [{ repoRef: "https://example.invalid/repo.git", baseRef: "main", commit: "a".repeat(40) }],
        requireReadOnlyForReviewer: false,
      },
    },
  });
  h.seedChildIssue(bridge, "child-1");
  h.seedCapabilityBinding(bridge, COMPANY_A, "agent:paperclip/agent-1", "agent-1");
  let wakeupCount = 0;
  const requestWakeup = bridge.ctx.issues.requestWakeup.bind(bridge.ctx.issues);
  bridge.ctx.issues.requestWakeup = async (...args) => {
    wakeupCount += 1;
    return requestWakeup(...args);
  };

  const receipt = await bridge.company.ports.work.assignAndWake(
    {
      scope: SCOPE,
      runId: "run-1",
      nodeId: "n1",
      iteration: 0,
      workUnitRef: { provider: "paperclip", kind: "issue", id: "child-1" },
      workerSubjectRef: "agent:paperclip/agent-1",
      attemptId: "attempt-1",
    } as never,
    META,
  );

  assert.equal(receipt.queued, false);
  assert.equal(receipt.reason, "execution_workspace_not_realized");
  assert.equal(wakeupCount, 0, "an unrealized workspace must not trigger an AgentRun");
  const child = await bridge.ctx.issues.get("child-1", COMPANY_A);
  assert.equal(child?.assigneeAgentId, null, "a blocked repo task must not be assigned");
});

test("AT-06: a dispatch with a missing workspace contract remains blocked", async () => {
  const bridge = track(await withApproval([]));
  bridge.store.putBinding({
    companyId: COMPANY_A,
    kind: "work_unit",
    providerId: "run-1:n1:0",
    projectId: PROJECT_A,
    payload: { runId: "run-1", nodeId: "n1", iteration: 0, issueId: "child-1" },
  });
  h.seedChildIssue(bridge, "child-1");
  h.seedCapabilityBinding(bridge, COMPANY_A, "agent:paperclip/agent-1", "agent-1");

  const receipt = await bridge.company.ports.work.assignAndWake(
    {
      scope: SCOPE,
      runId: "run-1",
      nodeId: "n1",
      iteration: 0,
      workUnitRef: { provider: "paperclip", kind: "issue", id: "child-1" },
      workerSubjectRef: "agent:paperclip/agent-1",
      attemptId: "attempt-1",
    } as never,
    META,
  );

  assert.equal(receipt.queued, false);
  assert.equal(receipt.reason, "workspace_requirement_unavailable");
  const child = await bridge.ctx.issues.get("child-1", COMPANY_A);
  assert.equal(child?.assigneeAgentId, null);
});

test("AT-06: code.modify cannot bypass the workspace gate with an empty repository list", async () => {
  const bridge = track(await withApproval([]));
  bridge.store.putBinding({
    companyId: COMPANY_A,
    kind: "work_unit",
    providerId: "run-1:n1:0",
    projectId: PROJECT_A,
    payload: {
      runId: "run-1",
      nodeId: "n1",
      iteration: 0,
      issueId: "child-1",
      requiredCapabilities: ["code.modify"],
      workspaceRequirement: { mode: "read_write", repositories: [], requireReadOnlyForReviewer: false },
    },
  });
  h.seedChildIssue(bridge, "child-1");
  h.seedCapabilityBinding(bridge, COMPANY_A, "agent:paperclip/agent-1", "agent-1");

  const receipt = await bridge.company.ports.work.assignAndWake(
    {
      scope: SCOPE,
      runId: "run-1",
      nodeId: "n1",
      iteration: 0,
      workUnitRef: { provider: "paperclip", kind: "issue", id: "child-1" },
      workerSubjectRef: "agent:paperclip/agent-1",
      attemptId: "attempt-1",
    } as never,
    META,
  );

  assert.equal(receipt.queued, false);
  assert.equal(receipt.reason, "repo_workspace_requirement_missing_for_code_modify");
  const child = await bridge.ctx.issues.get("child-1", COMPANY_A);
  assert.equal(child?.assigneeAgentId, null);
});

test("AT-06: an isolated workspace at the wrong commit is not dispatched", async () => {
  const bridge = track(await withApproval([]));
  bridge.store.putBinding({
    companyId: COMPANY_A,
    kind: "work_unit",
    providerId: "run-1:n1:0",
    projectId: PROJECT_A,
    payload: {
      runId: "run-1",
      nodeId: "n1",
      iteration: 0,
      issueId: "child-1",
      workspaceRequirement: {
        mode: "read_write",
        repositories: [{ repoRef: "https://example.invalid/repo.git", baseRef: "main", commit: "a".repeat(40) }],
        requireReadOnlyForReviewer: false,
      },
    },
  });
  h.seedChildIssue(bridge, "child-1", {
    currentExecutionWorkspace: {
      id: "execution-workspace-1",
      companyId: COMPANY_A,
      projectId: PROJECT_A,
      status: "active",
      mode: "isolated_workspace",
      providerType: "git_worktree",
      cwd: "/work/isolated",
    } as never,
  });
  bridge.ctx.executionWorkspaces.get = async () => ({
    id: "execution-workspace-1",
    companyId: COMPANY_A,
    projectId: PROJECT_A,
    projectWorkspaceId: "project-workspace-1",
    path: "/work/isolated",
    cwd: "/work/isolated",
    repoUrl: "https://example.invalid/repo.git",
    baseRef: "main",
    branchName: "polyforge/run-1",
    providerType: "git_worktree",
    providerMetadata: { repoRef: "https://example.invalid/repo.git", commit: "b".repeat(40) },
  });
  h.seedCapabilityBinding(bridge, COMPANY_A, "agent:paperclip/agent-1", "agent-1");

  const receipt = await bridge.company.ports.work.assignAndWake(
    {
      scope: SCOPE,
      runId: "run-1",
      nodeId: "n1",
      iteration: 0,
      workUnitRef: { provider: "paperclip", kind: "issue", id: "child-1" },
      workerSubjectRef: "agent:paperclip/agent-1",
      attemptId: "attempt-1",
    } as never,
    META,
  );

  assert.equal(receipt.queued, false);
  assert.equal(receipt.reason, "verified_isolated_execution_workspace_and_commit_required");
  const child = await bridge.ctx.issues.get("child-1", COMPANY_A);
  assert.equal(child?.assigneeAgentId, null, "a mismatched commit must not be assigned");
});

test("AT-06: matching isolated workspace and pinned commit can dispatch a repo task", async () => {
  const bridge = track(await withApproval([]));
  bridge.store.putBinding({
    companyId: COMPANY_A,
    kind: "work_unit",
    providerId: "run-1:n1:0",
    projectId: PROJECT_A,
    payload: {
      runId: "run-1",
      nodeId: "n1",
      iteration: 0,
      issueId: "child-1",
      workspaceRequirement: {
        mode: "read_write",
        repositories: [{ repoRef: "https://example.invalid/repo.git", baseRef: "main", commit: "a".repeat(40) }],
        requireReadOnlyForReviewer: false,
      },
    },
  });
  h.seedChildIssue(bridge, "child-1", {
    currentExecutionWorkspace: {
      id: "execution-workspace-1",
      companyId: COMPANY_A,
      projectId: PROJECT_A,
      status: "active",
      mode: "isolated_workspace",
      providerType: "git_worktree",
      cwd: "/work/isolated",
    } as never,
  });
  bridge.ctx.executionWorkspaces.get = async () => ({
    id: "execution-workspace-1",
    companyId: COMPANY_A,
    projectId: PROJECT_A,
    projectWorkspaceId: "project-workspace-1",
    path: "/work/isolated",
    cwd: "/work/isolated",
    repoUrl: "https://example.invalid/repo.git",
    baseRef: "main",
    branchName: "polyforge/run-1",
    providerType: "git_worktree",
    providerMetadata: { repoRef: "https://example.invalid/repo.git", git: { headCommit: "a".repeat(40) } },
  });
  h.seedCapabilityBinding(bridge, COMPANY_A, "agent:paperclip/agent-1", "agent-1");

  const receipt = await bridge.company.ports.work.assignAndWake(
    {
      scope: SCOPE,
      runId: "run-1",
      nodeId: "n1",
      iteration: 0,
      workUnitRef: { provider: "paperclip", kind: "issue", id: "child-1" },
      workerSubjectRef: "agent:paperclip/agent-1",
      attemptId: "attempt-1",
    } as never,
    META,
  );

  assert.equal(receipt.queued, true);
  assert.ok(receipt.agentRunRef, "the pinned isolated workspace may be dispatched");
  const child = await bridge.ctx.issues.get("child-1", COMPANY_A);
  assert.equal(child?.assigneeAgentId, "agent-1");
});

test("AT-14: a dispatch is recorded before it is attempted, so a crash cannot hide it", async () => {
  const bridge = track(await withApproval([]));
  bridge.store.putBinding({
    companyId: COMPANY_A,
    kind: "work_unit",
    providerId: "run-1:n1:0",
    projectId: PROJECT_A,
    payload: { runId: "run-1", nodeId: "n1", iteration: 0, issueId: "child-1" },
  });
  h.seedChildIssue(bridge, "child-1");
  h.seedCapabilityBinding(bridge, COMPANY_A, "agent:paperclip/agent-1", "agent-1");
  await bridge.company.ports.work.assignAndWake(
    {
      scope: SCOPE,
      runId: "run-1",
      nodeId: "n1",
      iteration: 0,
      workUnitRef: { provider: "paperclip", kind: "issue", id: "child-1" },
      workerSubjectRef: "agent:paperclip/agent-1",
      attemptId: "attempt-1",
    } as never,
    META,
  );
  // The dispatch intent exists durably, whether or not the wakeup was accepted.
  const dispatches = bridge.store.listDeliveries(COMPANY_A, ["pending", "sent", "observed", "reconciled"]);
  assert.ok(
    dispatches.some((row) => row.kind === "work_unit.dispatch"),
    "the dispatch intent must be on record",
  );
});

test("AT-14: a worker with no capability binding cannot be dispatched work", async () => {
  const bridge = track(await withApproval([]));
  bridge.store.putBinding({
    companyId: COMPANY_A,
    kind: "work_unit",
    providerId: "run-1:n1:0",
    projectId: PROJECT_A,
    payload: { runId: "run-1", nodeId: "n1", iteration: 0, issueId: "child-1" },
  });
  h.seedChildIssue(bridge, "child-1");
  // No binding was seeded: the capability grant is the thing being tested, and it is absent.
  await assert.rejects(
    () =>
      bridge.company.ports.work.assignAndWake(
        {
          scope: SCOPE,
          runId: "run-1",
          nodeId: "n1",
          iteration: 0,
          workUnitRef: { provider: "paperclip", kind: "issue", id: "child-1" },
          workerSubjectRef: "agent:paperclip/agent-1",
          attemptId: "attempt-1",
        } as never,
        META,
      ),
    /no capability binding/,
  );
  // And the child issue was not quietly assigned anyway.
  const child = await bridge.ctx.issues.get("child-1", COMPANY_A);
  assert.notEqual(child?.assigneeAgentId, "agent-1");
});

test("AT-14: a dead letter is visible to a human, not just to a counter", async () => {
  const bridge = track(await withApproval([]));
  bridge.store.enqueueDelivery({
    id: "d_dead_letter",
    companyId: COMPANY_A,
    projectId: PROJECT_A,
    kind: "work_unit.dispatch",
    effectKey: "pf.dead.letter",
    correlationId: "corr-dead",
    payload: { note: "this intent will never succeed" },
  });
  bridge.store.updateDelivery(COMPANY_A, "pf.dead.letter", {
    status: "failed",
    lastError: "network redelivery budget exhausted",
  });
  // The reconciler surfaces it: a permanently failed effect that nobody sees is indistinguishable
  // from work that silently stopped happening.
  const report = await bridge.company.reconciler.reconcileCompany(COMPANY_A);
  assert.ok(
    report.issues.some((line) => /dead|pf\.dead\.letter|exhausted/i.test(line)),
    `a dead letter must be reported, got ${JSON.stringify(report.issues)}`,
  );
});
