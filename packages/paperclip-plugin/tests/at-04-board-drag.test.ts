/**
 * AT-04 / AT-31 — a board drag and a faked agent success are observations, not passes.
 * (docs/03 §10 AT-04: "人工拖 Issue 为 done 或伪造 agent success，缺证据的 node 不能 PASS/downstream dispatch")
 *
 * The Core is what commits a transition, so what this file proves is the bridge half: neither a
 * dragged status nor an `agent.run.finished` event is translated into anything stronger than an
 * observation, the observation is flagged as such, and the `IssueView` the UI reads keeps the two
 * statuses apart with `needsEngineeringVerification` set. It also covers AT-31's "an SSE drop
 * recovers a full authoritative snapshot": the run tab returns the Core's cursor, and an unknown
 * status is never rendered as a pass.
 */

import "./helpers/bootstrap.ts";
import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { load } from "./helpers/bootstrap.ts";

const h = await load<typeof import("./helpers/harness.ts")>(new URL("./helpers/harness.ts", import.meta.url));
const enums = await load<typeof import("@polyforge/protocol")>("@polyforge/protocol");

const { COMPANY_A, PROJECT_A, GRAPH_ID, ENTRYPOINT, buildBridge, company, project, issue, label, hostEvent } = h;
const bridges: { dispose(): void }[] = [];
after(() => {
  for (const bridge of bridges) bridge.dispose();
});
function track<T extends { dispose(): void }>(bridge: T): T {
  bridges.push(bridge);
  return bridge;
}

const engineering = label("engineering");

async function bridgeWithRun() {
  const bridge = track(
    await buildBridge({
      seed: {
        companies: [company(COMPANY_A)],
        projects: [project(PROJECT_A, COMPANY_A)],
        issues: [issue("root-1", COMPANY_A, PROJECT_A, { labels: [engineering] })],
      },
      configureRuntime: (runtime) => {
        runtime.seedRun("run-1", {
          scope: { companyRef: COMPANY_A, projectRef: PROJECT_A },
          graphId: GRAPH_ID,
          entrypoint: ENTRYPOINT,
          startIntentId: "intent-1",
          // The node is RUNNING with no evidence: the exact state a board drag tries to skip.
          nodes: [
            {
              nodeId: "n1",
              kind: "agent_operation",
              status: "RUNNING",
              iteration: 0,
              waitReason: null,
              blockReason: null,
              requiredCapabilities: ["code.modify"],
              activeAttemptId: "attempt-1",
              inputRefs: [],
              outputRefs: [],
              assignedSubject: "agent:paperclip/agent-1",
              assignedIssueRef: null,
              childRunId: null,
              contractHash: "sha256:contract-1",
              updatedAt: new Date(0).toISOString(),
            },
          ],
          evidence: [],
        });
      },
    }),
  );
  bridge.store.putBinding({
    companyId: COMPANY_A,
    kind: "run",
    providerId: "run-1",
    projectId: PROJECT_A,
    payload: { runId: "run-1", rootIssueId: "root-1", projectId: PROJECT_A },
  });
  return bridge;
}

test("AT-04: a board drag to done becomes a completion observation that may not pass a node", async () => {
  const bridge = await bridgeWithRun();
  const result = await bridge.eventPump.handle(
    hostEvent("issue.updated", "evt-drag-1", { issueId: "root-1", from: "in_progress", to: "done" }),
  );
  assert.equal(result.quarantined, 0);
  await bridge.drain();

  const intake = bridge.runtime.intake;
  assert.equal(intake.length, 1);
  const event = intake[0] as Record<string, unknown>;
  const payload = event["payload"] as Record<string, unknown>;
  assert.equal(event["type"], "pf.execution.observed");
  // The four flags that make this an observation and not a verdict.
  assert.equal(payload["observationOnly"], true);
  assert.equal(payload["mayPassNode"], false);
  assert.equal(payload["requiresEvidenceVerification"], true);
  // The *classification* is the event's — someone dragged something to done — while the status
  // value is the host's, read back from the issue rather than taken from the event. A drag that
  // did not actually move the issue is still reported as a drag claim, with both values kept.
  assert.equal(payload["observationKind"], "board_status_change");
  assert.equal(payload["boardStatus"], "todo", "the host's status, not the event's claim");
  assert.equal(payload["claimedStatus"], "done", "the claim is kept for the audit trail");
  assert.equal(payload["refetchedFromAuthoritativeObject"], true);
  // And no request that could commit a transition was made.
  assert.equal(bridge.runtime.requestsTo("POST", "/transitions").length, 0);
  assert.equal(bridge.runtime.requestsTo("POST", "/evidence").length, 0);
});

test("AT-04: a drag that really moved the issue reports the host's new status", async () => {
  const bridge = await bridgeWithRun();
  // The issue genuinely moved, and the event says so. The observation then reports `done` — still
  // as an observation, with `mayPassNode: false`, because a status is not a pass.
  await bridge.ctx.issues.update("root-1", { status: "done" }, COMPANY_A, {
    actorAgentId: null,
    actorUserId: "user-1",
    actorRunId: null,
  });
  await bridge.eventPump.handle(
    hostEvent("issue.updated", "evt-drag-real", { issueId: "root-1", from: "in_progress", to: "done" }),
  );
  await bridge.drain();
  const payload = (bridge.runtime.intake[0] as Record<string, unknown>)["payload"] as Record<string, unknown>;
  assert.equal(payload["boardStatus"], "done");
  assert.equal(payload["claimedStatus"], "done");
  assert.equal(payload["mayPassNode"], false, "a real drag is still not a pass");
  assert.equal(payload["requiresEvidenceVerification"], true);
});

test("AT-04: a faked agent success is candidate evidence, never a pass", async () => {
  const bridge = await bridgeWithRun();
  await bridge.eventPump.handle(
    hostEvent("agent.run.finished", "evt-run-finished-1", {
      issueId: "root-1",
      agentId: "agent-1",
      runId: "agent-run-1",
      finishedAt: new Date().toISOString(),
      // A worker claiming it produced a passing test report.
      artifacts: [{ kind: "test_report", contentHash: "sha256:whatever" }],
    }),
  );
  await bridge.drain();

  const event = bridge.runtime.intake[0] as Record<string, unknown>;
  const payload = event["payload"] as Record<string, unknown>;
  assert.equal(event["type"], "pf.execution.observed");
  assert.equal(payload["observationOnly"], true);
  assert.equal(payload["mayPassNode"], false);
  assert.equal(payload["requiresEvidenceVerification"], true);
  // The effect outcome stays unknown: the host cannot authoritatively say whether an external
  // effect happened, and the bridge does not guess.
  assert.equal(payload["effectOutcome"], "unknown");
  assert.deepEqual(payload["candidateArtifacts"], [
    { kind: "test_report", contentHash: "sha256:whatever" },
  ]);
});

test("AT-04: the issue view keeps the board status and the graph status apart", async () => {
  const bridge = await bridgeWithRun();
  // A human drags the Root Issue to done while the Core still has an unverified node.
  await bridge.ctx.issues.update("root-1", { status: "done" }, COMPANY_A, {
    actorAgentId: null,
    actorUserId: "user-1",
    actorRunId: null,
  });

  const view = await bridge.company.ports.work.issueView(COMPANY_A, "root-1", null);
  assert.equal(view.issueStatus, "done", "what the board shows");
  assert.equal(view.graphStatus, null, "the Core has committed nothing, so there is no graph status");
  assert.equal(view.graphStatusSource, null);

  // With a snapshot, the disagreement is explicit.
  bridge.runtime.seedRun("run-2", {
    scope: { companyRef: COMPANY_A, projectRef: PROJECT_A },
    nodes: [
      {
        nodeId: "n1",
        kind: "agent_operation",
        status: "RUNNING",
        iteration: 0,
        waitReason: null,
        blockReason: null,
        requiredCapabilities: [],
        activeAttemptId: "a",
        inputRefs: [],
        outputRefs: [],
        assignedSubject: null,
        assignedIssueRef: null,
        childRunId: null,
        contractHash: null,
        updatedAt: new Date(0).toISOString(),
      },
    ],
  });
  const snapshot = await bridge.company.runtime!.getRun(
    { actorType: "system", actorId: "test", agentId: null, runId: null, roles: [] },
    { companyRef: COMPANY_A, projectRef: PROJECT_A },
    "run-2",
  );
  const withSnapshot = await bridge.company.ports.work.issueView(COMPANY_A, "root-1", snapshot);
  assert.equal(withSnapshot.issueStatus, "done");
  assert.equal(withSnapshot.graphStatus, "ACTIVE");
  assert.equal(withSnapshot.graphStatusSource, "polyforge");
  // The one flag the UI needs: the board claims more than the Core has verified.
  assert.equal(withSnapshot.needsEngineeringVerification, true);
  assert.equal(withSnapshot.nodes[0]?.status, "RUNNING");
});

test("AT-04: an external cancel is a control request, and history is kept", async () => {
  const bridge = await bridgeWithRun();
  await bridge.eventPump.handle(
    hostEvent("issue.updated", "evt-cancel-1", { issueId: "root-1", from: "in_progress", to: "cancelled" }),
  );
  await bridge.drain();
  const payload = (bridge.runtime.intake[0] as Record<string, unknown>)["payload"] as Record<string, unknown>;
  assert.equal(payload["controlRequest"], "cancel");
  assert.equal(payload["preservesHistory"], true);
  assert.equal(payload["observationOnly"], true);
  // The bridge never deletes an issue or a run on a cancel; it records and asks the Core.
  const still = await bridge.ctx.issues.get("root-1", COMPANY_A);
  assert.ok(still, "the issue must still exist after a cancel observation");
  assert.equal(bridge.runtime.runs.size, 1);
});

test("AT-04: a budget incident is BLOCKED_BUDGET and the bridge does not route around it", async () => {
  const bridge = await bridgeWithRun();
  await bridge.eventPump.handle(
    hostEvent("budget.incident.opened", "evt-budget-1", {
      incidentId: "bi-1",
      scopeType: "company",
      metric: "cost",
    }),
  );
  await bridge.drain();
  const event = bridge.runtime.intake[0] as Record<string, unknown>;
  const payload = event["payload"] as Record<string, unknown>;
  assert.equal(event["type"], "pf.run.blocked");
  assert.equal(payload["blockReason"], "BLOCKED_BUDGET");
  // Switching agents to dodge a financial hard stop is explicitly forbidden.
  assert.equal(payload["bridgeMayWorkAround"], false);
});

test("AT-04: an agent made unavailable is a platform block, not a retryable wobble", async () => {
  const bridge = await bridgeWithRun();
  await bridge.eventPump.handle(
    hostEvent("agent.status_changed", "evt-agent-paused", { agentId: "agent-1", status: "paused" }),
  );
  await bridge.drain();
  const event = bridge.runtime.intake[0] as Record<string, unknown>;
  assert.equal(event["type"], "pf.run.blocked");
  const payload = event["payload"] as Record<string, unknown>;
  assert.equal(payload["blockReason"], "BLOCKED_PLATFORM");
  assert.equal(payload["retryableByBridge"], false);
});

test("AT-04: a deleted workspace is BLOCKED_WORKSPACE, and a new directory is not the old state", async () => {
  const bridge = await bridgeWithRun();
  await bridge.eventPump.handle(
    hostEvent("project.workspace_deleted", "evt-ws-deleted", { workspaceId: "pw-1", projectId: PROJECT_A }),
  );
  await bridge.drain();
  const event = bridge.runtime.intake[0] as Record<string, unknown>;
  assert.equal(event["type"], "pf.run.blocked");
  const payload = event["payload"] as Record<string, unknown>;
  assert.equal(payload["blockReason"], "BLOCKED_WORKSPACE");
  assert.equal(payload["newDirectoryIsNotTheOldState"], true);
});

test("AT-31: the run tab returns the Core's authoritative cursor for a post-drop refetch", async () => {
  const bridge = await bridgeWithRun();
  const { registerDataKeys } = await load<typeof import("../src/bridge/data.ts")>(
    new URL("../src/bridge/data.ts", import.meta.url),
  );
  registerDataKeys(bridge.ctx, (id) => (id === COMPANY_A ? bridge.company : null));

  const tab = (await bridge.harness.getData("run-tab", { companyId: COMPANY_A, runId: "run-1" })) as Record<
    string,
    unknown
  >;
  const cursor = tab["authoritativeSnapshot"] as Record<string, unknown>;
  assert.equal(cursor["runId"], "run-1");
  assert.equal(typeof cursor["stateVersion"], "number");
  assert.equal(typeof cursor["eventSequence"], "number");
  // The stream is a hint; the tab is the truth, and it says so.
  assert.equal(tab["authoritative"], true);

  // Each node's projected issue status is shown *beside* the graph status, never merged.
  const nodes = tab["nodes"] as Record<string, unknown>[];
  const node = nodes[0];
  assert.ok(node);
  assert.equal(node["status"], "RUNNING");
  assert.equal(node["projectedIssueStatus"], "in_progress");
  // The pins are surfaced, which is how an operator sees the run did not drift (AT-19).
  const run = tab["run"] as Record<string, unknown>;
  assert.deepEqual(run["pins"], { startIntentId: "intent-1", graph: `${GRAPH_ID}@1` });
});

test("AT-31: a status outside the vocabulary is refused, not rendered as a pass", async () => {
  // The projection table itself: an unknown value returns null, and the port refuses to write.
  assert.equal(enums.projectIssueStatus("NOT_A_REAL_STATUS" as never), null);
  assert.equal(enums.projectIssueStatus("PASSED"), "done");
  assert.equal(enums.projectIssueStatus("BLOCKED"), "blocked");
  assert.equal(enums.projectIssueStatus("WAITING_GOVERNANCE"), "in_review");
  // A node that is RUNNING projects to in_progress, never to done.
  assert.equal(enums.projectIssueStatus("RUNNING"), "in_progress");

  const bridge = await bridgeWithRun();
  await bridge.company.ports.work.projectStatus(
    {
      scope: { companyRef: COMPANY_A, projectRef: PROJECT_A },
      runId: "run-1",
      projectionSequence: 1,
      target: { provider: "paperclip", kind: "issue", id: "root-1" },
      status: "TOTALLY_UNKNOWN",
      summary: "",
      nodeStates: [],
      origin: "polyforge",
      correlationId: "corr",
    },
    { commandId: "c", idempotencyKey: "pf:p:1", correlationId: "corr" },
  );
  // The issue was not moved to `done`; the refusal is counted as a reconcile mismatch.
  const current = await bridge.ctx.issues.get("root-1", COMPANY_A);
  assert.ok(current);
  assert.notEqual(current.status, "done");
  assert.ok((bridge.counters()["reconcileMismatch"] as number) >= 1);
});

test("AT-31: an out-of-order projection is dropped rather than moving the board backwards", async () => {
  const bridge = await bridgeWithRun();
  const base = {
    scope: { companyRef: COMPANY_A, projectRef: PROJECT_A },
    runId: "run-1",
    target: { provider: "paperclip", kind: "issue", id: "root-1" },
    summary: "",
    nodeStates: [{ nodeId: "n1", status: "RUNNING" }],
    origin: "polyforge" as const,
    correlationId: "corr",
  };
  // Newest first: in_review (sequence 9), then the stale in_progress (sequence 3).
  await bridge.company.ports.work.projectStatus(
    { ...base, projectionSequence: 9, status: "WAITING_GOVERNANCE" },
    { commandId: "c9", idempotencyKey: "pf:p:9", correlationId: "corr" },
  );
  await bridge.company.ports.work.projectStatus(
    { ...base, projectionSequence: 3, status: "RUNNING" },
    { commandId: "c3", idempotencyKey: "pf:p:3", correlationId: "corr" },
  );
  const current = await bridge.ctx.issues.get("root-1", COMPANY_A);
  assert.ok(current);
  assert.equal(current.status, "in_review", "the stale projection must not have moved the board back");
  // And the offset records the newest sequence, not the last one applied.
  const offset = bridge.store.getProjectionOffset(COMPANY_A, "issue", "root-1");
  assert.ok(offset);
  assert.equal(offset.projectionSequence, 9);
});
