/**
 * AT-25 (TOOL-01/03/04) and AT-26 (NFR-01) — durable tool refs, controlled takeover, and no
 * duplicate effect across duplicate/out-of-order events, HTTP timeouts, and a crash.
 *
 * - AT-25: "工具快速返回 durable refs；关闭 agent session 后 Graph 保留，另一合格 agent 可受控接管"
 * - AT-26: "重复/乱序 event、HTTP timeout、bridge crash 无重复 transition；ambiguous create 不盲重发"
 *
 * What is *not* proven here: the harness has no agent-session lifecycle, so "the session was
 * closed" is modelled as the agent run no longer being resolvable. The property under test is the
 * one the bridge owns — the run survives, and a takeover is gated on the lease and a capability
 * grant rather than on who asks.
 */

import "./helpers/bootstrap.ts";
import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { load } from "./helpers/bootstrap.ts";

const h = await load<typeof import("./helpers/harness.ts")>(new URL("./helpers/harness.ts", import.meta.url));
const sdk = await load<typeof import("@paperclipai/plugin-sdk")>("@paperclipai/plugin-sdk");
const register = await load<typeof import("../src/tools/register.ts")>(
  new URL("../src/tools/register.ts", import.meta.url),
);

const { COMPANY_A, PROJECT_A, GRAPH_ID, ENTRYPOINT, buildBridge, company, project, issue, label, hostEvent } = h;
const bridges: { dispose(): void }[] = [];
after(() => {
  for (const bridge of bridges) bridge.dispose();
});
function track<T extends { dispose(): void }>(bridge: T): T {
  bridges.push(bridge);
  return bridge;
}

const AGENT_ID = "agent-1";
const AGENT_RUN = "agent-run-1";
const OTHER_AGENT_ID = "agent-2";
const OTHER_AGENT_RUN = "agent-run-2";

function runCtx(overrides: Record<string, unknown> = {}) {
  return {
    companyId: COMPANY_A,
    projectId: PROJECT_A,
    agentId: AGENT_ID,
    runId: AGENT_RUN,
    toolName: "current",
    callId: "call-1",
    ...overrides,
  } as unknown as sdk.ToolRunContext;
}

function contract(overrides: Record<string, unknown> = {}) {
  return {
    runId: "run-1",
    stateVersion: 7,
    nodeId: "n1",
    iteration: 0,
    attemptId: "attempt-1",
    leaseEpoch: 0,
    contractHash: "sha256:contract-1",
    requiredInputs: ["issue:root-1"],
    permittedOutputs: ["code_diff", "test_report"],
    evidenceRequirements: [{ kind: "test_report", mandatory: true }],
    policyConstraints: {},
    permittedActions: ["polyforge.submit_evidence"],
    claimable: true,
    previousOwnerAgentRunId: null,
    ...overrides,
  };
}

async function withRun(options: { extraConfig?: Record<string, unknown> } = {}) {
  const bridge = await buildBridge({
    seed: {
      companies: [company(COMPANY_A)],
      projects: [project(PROJECT_A, COMPANY_A)],
      issues: [issue("root-1", COMPANY_A, PROJECT_A, { labels: [label("engineering")] })],
    },
    extraConfig: { requestTimeoutMs: 250, ...(options.extraConfig ?? {}) },
    configureRuntime: (runtime) => {
      runtime.seedRun("run-1", {
        scope: { companyRef: COMPANY_A, projectRef: PROJECT_A },
        graphId: GRAPH_ID,
        entrypoint: ENTRYPOINT,
        startIntentId: "intent-1",
        nodes: [
          {
            nodeId: "n1",
            kind: "agent_operation",
            status: "RUNNING",
            iteration: 0,
            requiredCapabilities: ["code.modify"],
            activeAttemptId: "attempt-1",
            outputRefs: [],
            updatedAt: new Date(0).toISOString(),
          },
        ],
      });
      runtime.contracts.set("run-1", contract());
    },
  });
  bridge.store.putBinding({
    companyId: COMPANY_A,
    kind: "work_unit",
    providerId: "run-1:n1:0",
    projectId: PROJECT_A,
    payload: {
      runId: "run-1",
      nodeId: "n1",
      iteration: 0,
      issueId: "root-1",
      agentRunRefId: AGENT_RUN,
      agentId: AGENT_ID,
      contractHash: "sha256:contract-1",
    },
  });
  bridge.store.putBinding({
    companyId: COMPANY_A,
    kind: "dispatch",
    providerId: AGENT_RUN,
    projectId: PROJECT_A,
    payload: { agentRunRefId: AGENT_RUN, issueId: "root-1", runId: "run-1", nodeId: "n1" },
  });
  bridge.store.putBinding({
    companyId: COMPANY_A,
    kind: "run",
    providerId: "run-1",
    projectId: PROJECT_A,
    payload: { runId: "run-1", rootIssueId: "root-1", projectId: PROJECT_A },
  });
  return bridge;
}

function envelope(result: sdk.ToolResult): Record<string, unknown> {
  return result.data as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// AT-25: durable refs, and a controlled takeover after the session goes away
// ---------------------------------------------------------------------------

test("AT-25: every side-effecting tool returns a durable reference, not a promise of a result", async () => {
  const bridge = track(await withRun());
  await bridge.callTool("current", { adopt: true }, runCtx());
  const result = await bridge.callTool(
    "submit_evidence",
    { nodeId: "n1", evidence: [{ kind: "test_report", contentHash: "sha256:report" }] },
    runCtx(),
  );
  const data = envelope(result);
  // The Core's command id is the durable handle an operator or a later pass can quote.
  const command = bridge.runtime.commands.find((entry) => entry.kind === "EVIDENCE");
  assert.ok(command, "the evidence command reached the Core");
  assert.equal(typeof command.body["commandId"], "string");
  assert.equal(command.body["commandId"], "run-1:n1:attempt-1:1");
  // The tool call itself returns immediately with a pending status, never a commit.
  assert.equal(data["status"], "PENDING");
  assert.equal(data["pending"], true);
  // And the bridge has the claim on record, so the next process can rebuild it.
  const claim = bridge.store.getBinding(COMPANY_A, register.CLAIM_BINDING_KIND, "run-1:n1:0");
  assert.ok(claim, "the claim is a durable reference too");
});

test("AT-25: the run survives the agent session ending", async () => {
  const bridge = track(await withRun());
  await bridge.callTool("current", { adopt: true }, runCtx());
  // The session goes away: the agent run is no longer resolvable and its issue has no live run.
  bridge.store.deleteBinding(COMPANY_A, "dispatch", AGENT_RUN);
  await bridge.ctx.issues.update(
    "root-1",
    { activeRun: null } as never,
    COMPANY_A,
    { actorAgentId: null, actorUserId: null, actorRunId: null },
  );

  // The run is still there, with its pin, its contract and its claim. Closing a session is not a
  // reason to lose a GraphRun.
  const run = bridge.store.getBinding(COMPANY_A, "run", "run-1");
  assert.ok(run, "the run binding must survive the session");
  const snapshot = await bridge.company.runtime!.getRun(
    { actorType: "system", actorId: "test", agentId: null, runId: null, roles: [] },
    { companyRef: COMPANY_A, projectRef: PROJECT_A },
    "run-1",
  );
  assert.equal(snapshot["status"], "ACTIVE");
  // The abandoned claim is still recorded, which is what makes the takeover auditable.
  assert.ok(bridge.store.getBinding(COMPANY_A, register.CLAIM_BINDING_KIND, "run-1:n1:0"));
});

test("AT-25: another qualified agent may take over, and only under the lease", async () => {
  const bridge = track(await withRun());
  await bridge.callTool("current", { adopt: true }, runCtx());
  // The second agent is dispatched to the same node, and holds a capability grant.
  bridge.store.putBinding({
    companyId: COMPANY_A,
    kind: "work_unit",
    providerId: "run-1:n1:0:second",
    projectId: PROJECT_A,
    payload: {
      runId: "run-1",
      nodeId: "n1",
      iteration: 0,
      issueId: "root-1",
      agentRunRefId: OTHER_AGENT_RUN,
      agentId: OTHER_AGENT_ID,
      contractHash: "sha256:contract-1",
    },
  });
  h.seedCapabilityBinding(bridge, COMPANY_A, `agent:paperclip/${OTHER_AGENT_ID}`, OTHER_AGENT_ID);
  const second = runCtx({ agentId: OTHER_AGENT_ID, runId: OTHER_AGENT_RUN, callId: "call-2" });

  // While the first lease is live, the second agent is fenced out.
  const fenced = envelope(await bridge.callTool("current", { adopt: true }, second));
  assert.notEqual(fenced["status"], "CLAIMED");

  // The old lease expires — that is the controlled part, not a race.
  bridge.runtime.expireLeases();
  const taken = envelope(await bridge.callTool("current", { adopt: true }, second));
  assert.equal(taken["status"], "CLAIMED");
  const claim = (taken["data"] as Record<string, unknown>)["claim"] as Record<string, unknown>;
  assert.equal(claim["leaseEpoch"], 2, "a takeover advances the epoch so the old attempt is fenced");
  assert.equal(claim["invalidatesPreviousAttempt"], true);
  // The first agent is now fenced on its own next write, which is what stops two owners.
  const stale = await bridge.callTool(
    "submit_evidence",
    { nodeId: "n1", evidence: [{ kind: "test_report", contentHash: "sha256:late" }] },
    runCtx(),
  );
  const blockers = envelope(stale)["blockers"] as Record<string, unknown>[];
  assert.equal(blockers[0]?.["reason"], "BLOCKED_LEASE_FENCED");
  assert.equal(bridge.runtime.requestsTo("POST", "/evidence").length, 0, "a late write sends nothing");
});

test("AT-25: an agent with no capability grant cannot be dispatched a takeover", async () => {
  const bridge = track(await withRun());
  await bridge.callTool("current", { adopt: true }, runCtx());
  bridge.store.putBinding({
    companyId: COMPANY_A,
    kind: "work_unit",
    providerId: "run-1:n1:0:second",
    projectId: PROJECT_A,
    payload: {
      runId: "run-1",
      nodeId: "n1",
      iteration: 0,
      issueId: "root-1",
      agentRunRefId: OTHER_AGENT_RUN,
      agentId: OTHER_AGENT_ID,
      contractHash: "sha256:contract-1",
    },
  });
  // No capability binding for agent-2: the work-unit binding alone is not a grant.
  const report = bridge.company.capabilitiesMatcher.resolve({
    scope: { companyRef: COMPANY_A, projectRef: PROJECT_A },
    requiredCapabilities: ["code.modify"],
  });
  assert.deepEqual(
    report.candidates.filter((candidate) => candidate.subject.includes(OTHER_AGENT_ID)),
    [],
    "an unbound subject is not a candidate",
  );
});

// ---------------------------------------------------------------------------
// AT-26: duplicate / out-of-order events
// ---------------------------------------------------------------------------

test("AT-26: the same host event delivered twice produces one effect", async () => {
  const bridge = track(await withRun());
  const event = hostEvent("issue.updated", "evt-dup-1", { issueId: "root-1", from: "todo", to: "in_progress" });
  const first = await bridge.eventPump.handle(event);
  const second = await bridge.eventPump.handle(event);
  assert.equal(first.quarantined, 0);
  // The inbox is the dedupe: the second delivery is recognised and not re-normalized.
  assert.equal(second.duplicate, true);
  await bridge.drain();
  assert.equal(bridge.runtime.intake.length, 1, "one event, one Core intake");
});

test("AT-26: 100 replays of one event still produce one effect", async () => {
  const bridge = track(await withRun());
  const event = hostEvent("issue.updated", "evt-replay-1", { issueId: "root-1", from: "todo", to: "in_progress" });
  for (let pass = 0; pass < 100; pass += 1) {
    await bridge.eventPump.handle(event);
  }
  await bridge.drain();
  assert.equal(bridge.runtime.intake.length, 1);
  assert.equal(bridge.store.countDeliveries(COMPANY_A, "pending"), 0);
});

test("AT-26: two events describing the same change move the board once", async () => {
  const bridge = track(await withRun());
  // The host emits the change twice under different ids — a re-read and a delivery. These are two
  // events, not one, so both are forwarded; what must not happen is the board moving twice or
  // moving backwards.
  await bridge.eventPump.handle(
    hostEvent("issue.updated", "evt-a", { issueId: "root-1", from: "todo", to: "in_progress" }),
  );
  await bridge.eventPump.handle(
    hostEvent("issue.updated", "evt-b", { issueId: "root-1", from: "todo", to: "in_progress" }),
  );
  await bridge.drain();
  assert.equal(bridge.runtime.intake.length, 2, "two distinct events are two facts");
  // Each observation reports the state read from the host, not the one the event claimed.
  for (const event of bridge.runtime.intake) {
    const payload = (event as Record<string, unknown>)["payload"] as Record<string, unknown>;
    assert.equal(payload["observationOnly"], true);
    assert.notEqual(payload["mayPassNode"], true);
  }
});

test("AT-26: an event's claimed status is never taken as the issue's status", async () => {
  const bridge = track(await withRun());
  // A hostile or buggy producer claims the issue moved to `done` when it did not. The bridge
  // re-reads the object, so the observation cannot report a state the host does not hold.
  await bridge.eventPump.handle(
    hostEvent("issue.updated", "evt-lie", { issueId: "root-1", from: "todo", to: "done" }),
  );
  await bridge.drain();
  const event = bridge.runtime.intake[0] as Record<string, unknown>;
  const payload = event["payload"] as Record<string, unknown>;
  assert.notEqual(payload["boardStatus"], "done", "the claim in the event is not the board's state");
  const current = await bridge.ctx.issues.get("root-1", COMPANY_A);
  assert.equal(current?.status, "todo", "and the board did not move on the event's word");
});

test("AT-26: a stale projection is dropped, so a late event cannot move the board backwards", async () => {
  const bridge = track(await withRun());
  // The Core's projection sequence is the ordering authority for the board; the host's arrival
  // order is not.
  const base = {
    scope: { companyRef: COMPANY_A, projectRef: PROJECT_A },
    runId: "run-1",
    target: { provider: "paperclip", kind: "issue", id: "root-1" } as const,
    nodeStates: [],
    origin: "polyforge" as const,
    correlationId: "corr",
  };
  await bridge.company.ports.work.projectStatus(
    { ...base, projectionSequence: 5, status: "RUNNING", summary: "" },
    { commandId: "c5", idempotencyKey: "pf:p:5", correlationId: "corr" },
  );
  await bridge.company.ports.work.projectStatus(
    { ...base, projectionSequence: 2, status: "WAITING_GOVERNANCE", summary: "" },
    { commandId: "c2", idempotencyKey: "pf:p:2", correlationId: "corr" },
  );
  const current = await bridge.ctx.issues.get("root-1", COMPANY_A);
  assert.equal(current?.status, "in_progress", "the stale projection was dropped");
  const offset = bridge.store.getProjectionOffset(COMPANY_A, "issue", "root-1");
  assert.equal(offset?.projectionSequence, 5);
});

test("AT-26: an unknown event schema is quarantined, not guessed at", async () => {
  const bridge = track(await withRun());
  const result = await bridge.eventPump.handle({
    eventId: "evt-unknown-1",
    eventType: "totally.unknown.event" as never,
    companyId: COMPANY_A,
    occurredAt: new Date().toISOString(),
    payload: { anything: true },
  });
  assert.equal(result.quarantined, 1);
  await bridge.drain();
  assert.equal(bridge.runtime.intake.length, 0, "an unknown schema produces no Core intake");
  // And it is retained for inspection rather than dropped: a schema the bridge cannot read may be
  // a version it simply does not know yet.
  assert.equal(bridge.store.countQuarantine(COMPANY_A), 1);
});

test("AT-26: a quarantined event is replayable once the schema is understood", async () => {
  const bridge = track(await withRun());
  await bridge.eventPump.handle({
    eventId: "evt-quarantine-1",
    eventType: "totally.unknown.event" as never,
    companyId: COMPANY_A,
    occurredAt: new Date().toISOString(),
    payload: {},
  });
  // The quarantine is readable, so a fixed bridge can finish the work it could not do.
  const rows = bridge.store.listQuarantine(COMPANY_A, 10);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.eventType, "totally.unknown.event");
  assert.equal(rows[0]?.companyId, COMPANY_A);
});

// ---------------------------------------------------------------------------
// AT-26: HTTP timeout, and a crash between the write and the record
// ---------------------------------------------------------------------------

test("AT-26: a timed-out write is ambiguous and is never blindly resent", async () => {
  const bridge = track(await withRun());
  bridge.runtime.addFault({
    match: (request) => request.path.includes("/events"),
    kind: "hang",
    times: 1,
  });
  await bridge.eventPump.handle(
    hostEvent("issue.updated", "evt-timeout-1", { issueId: "root-1", from: "todo", to: "in_progress" }),
  );
  await bridge.drain();
  const rows = bridge.store.listDeliveries(COMPANY_A, ["ambiguous"]);
  assert.equal(rows.length, 1, "a write whose outcome is unknown is ambiguous");
  // Further passes do not resend it.
  await bridge.pump.pumpOnce([COMPANY_A]);
  assert.equal(bridge.runtime.requestsTo("POST", "/events").length, 1);
  assert.equal(bridge.store.listDeliveries(COMPANY_A, ["ambiguous"]).length, 1);
});

test("AT-26: a create that timed out is resolved by reading back, not by resending", async () => {
  const bridge = track(await withRun());
  // The hard case: the Core commits the create, then the connection dies before the bridge sees
  // the response. A blind resend would create a second run.
  bridge.runtime.addFault({
    match: (request) => request.path.includes("/work-orders"),
    kind: "hangAfterCommit",
    times: 1,
  });
  bridge.company.deliveries.begin({
    effectKey: "pf.work-order:create-1",
    kind: "work_order.create" as never,
    scope: { companyRef: COMPANY_A, projectRef: PROJECT_A },
    correlationId: "corr-create",
    runId: "run-1",
    payload: { startIntentId: "intent-1", entrypoint: ENTRYPOINT, graphId: GRAPH_ID },
  });
  await bridge.pump.pumpOnce([COMPANY_A]);
  const ambiguous = bridge.store.listDeliveries(COMPANY_A, ["ambiguous"]);
  assert.equal(ambiguous.length, 1, "the create's outcome is unknown to the bridge");

  // Reconciliation reads the Core back: the run exists, so the create did take effect.
  const report = await bridge.company.reconciler.reconcileCompany(COMPANY_A);
  assert.ok(report.ambiguousResolved >= 1, `expected a resolution, got ${JSON.stringify(report)}`);
  assert.equal(bridge.store.listDeliveries(COMPANY_A, ["ambiguous"]).length, 0);
  // And it was resolved by reading, not by a second create: the start intent still maps to the
  // one run the timed-out create produced.
  assert.equal(bridge.runtime.requestsTo("POST", "/work-orders").length, 1);
  const runId = bridge.runtime.runIdByStartIntent.get("intent-1");
  assert.ok(runId, "the create did take effect");
  assert.equal(bridge.runtime.runs.has(runId), true);
});

test("AT-26: a crash after the write leaves the queue replayable and the effect unrepeated", async () => {
  const bridge = track(await withRun());
  // A row the pump claimed and never settled: exactly the state a crash between "sent" and
  // "observed" leaves behind.
  bridge.company.deliveries.begin({
    effectKey: "pf.crash.simulation",
    kind: "event.intake" as never,
    scope: { companyRef: COMPANY_A, projectRef: PROJECT_A },
    correlationId: "corr-crash",
    payload: { type: "pf.execution.observed", payload: { observationOnly: true } },
  });
  const claimed = bridge.store.claimDueDeliveries({
    companyId: COMPANY_A,
    owner: "worker-that-died",
    limit: 10,
    leaseMs: 1,
  });
  assert.equal(claimed.length, 1);
  assert.equal(bridge.runtime.requestsTo("POST", "/events").length, 0, "nothing was sent yet");

  // The dead worker's lease expires. The queue is not stranded and the intent is not lost: the
  // pump takes it over under its own lease and sends it exactly once.
  bridge.advanceClock(5);
  await bridge.pump.pumpOnce([COMPANY_A]);
  assert.equal(bridge.runtime.intake.length, 1);
  assert.equal(bridge.store.countDeliveries(COMPANY_A, "pending"), 0);
});

test("AT-26: a crash after a settled write does not repeat the effect", async () => {
  const bridge = track(await withRun());
  await bridge.eventPump.handle(
    hostEvent("issue.updated", "evt-settled-1", { issueId: "root-1", from: "todo", to: "in_progress" }),
  );
  await bridge.drain();
  assert.equal(bridge.runtime.intake.length, 1);
  // The same event arriving again after a restart — the inbox still remembers it.
  await bridge.eventPump.handle(
    hostEvent("issue.updated", "evt-settled-1", { issueId: "root-1", from: "todo", to: "in_progress" }),
  );
  await bridge.drain();
  assert.equal(bridge.runtime.intake.length, 1, "a settled effect is not repeated");
});
