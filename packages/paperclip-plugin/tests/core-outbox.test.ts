/**
 * The Core's outbound queue has to be consumed, or nothing is ever dispatched.
 *
 * The Core enqueues `work.unit.ensure` the moment a node becomes READY and never calls the platform
 * itself. The bridge declares handlers for that intent, but nothing ever *fed* them: `drainOutbox`
 * had no caller, the client pointed at `/v1/outbox` while the Core serves `/v1/bridge/outbox`, and
 * the two sides spelled the kind differently (`work.unit.ensure` against `work_unit.ensure`).
 *
 * The failure is silent by construction. The bridge's own outbox pump kept draining the bridge's own
 * queue and reporting healthy, so every signal said fine while a Root Issue could build a GraphRun
 * and then never have a single node worked.
 *
 * These tests assert on the two directions of the handshake: an intent claimed from the Core becomes
 * a durable bridge intent, and the Core is told what happened to it.
 */

import "./helpers/bootstrap.ts";
import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { load } from "./helpers/bootstrap.ts";

const h = await load<typeof import("./helpers/harness.ts")>(new URL("./helpers/harness.ts", import.meta.url));
const intents = await load<typeof import("../src/outbox/intents.ts")>(
  new URL("../src/outbox/intents.ts", import.meta.url),
);

const { COMPANY_A, PROJECT_A, company, project, issue } = h;
const SCOPE = { companyRef: COMPANY_A, projectRef: PROJECT_A };

const bridges: { dispose(): void }[] = [];
after(() => {
  for (const bridge of bridges) {
    try {
      bridge.dispose();
    } catch {
      // A bridge that already tore itself down is not a failure worth reporting.
    }
  }
});
function track<T extends { dispose(): void }>(bridge: T): T {
  bridges.push(bridge);
  return bridge;
}

/**
 * The payload the Core really enqueues, field for field (`engine.py`, the `work.unit.ensure` branch).
 *
 * These tests used to queue a four-field stub. The stub was missing the `title` the Core always
 * sends, and -- more importantly -- it was missing the two things that made the difference between
 * the stub and production: the project lives at `scope.projectRef` and is *not* repeated at the top
 * level, and `workspaceRequirement` is `{}` rather than absent. A stub that did not carry those
 * differences could not have caught the crash they caused.
 */
function coreWorkUnitPayload(nodeId: string): Record<string, unknown> {
  return {
    runId: "run-1",
    nodeId,
    iteration: 0,
    scope: SCOPE,
    title: `design.design: ${nodeId}`,
    description: `Work the ${nodeId} node of run run-1.`,
    requiredCapabilities: [],
    correlationKey: `work-unit:run-1:${nodeId}:0`,
    parentIssueRef: { provider: "paperclip", kind: "issue", id: "root-1" },
    workspaceRequirement: {},
  };
}

async function withRun() {
  const bridge = track(
    await h.buildBridge({
      seed: {
        companies: [company(COMPANY_A)],
        projects: [project(PROJECT_A, COMPANY_A)],
        issues: [issue("root-1", COMPANY_A, PROJECT_A)],
      },
      configureRuntime: (runtime) => {
        runtime.seedRun("run-1", {
          scope: SCOPE,
          graphId: h.GRAPH_ID,
          entrypoint: h.ENTRYPOINT,
          startIntentId: "intent-1",
        });
      },
    }),
  );
  bridge.store.putBinding({
    companyId: COMPANY_A,
    kind: "run",
    providerId: "run-1",
    projectId: PROJECT_A,
    payload: { runId: "run-1", projectId: PROJECT_A, rootIssueId: "root-1" },
  });
  return bridge;
}

test("every kind the Core emits maps to a bridge intent this build carries", () => {
  // The Core's own declaration is the reference. A kind the bridge does not map is a kind the
  // bridge would silently drop, so the two lists are compared rather than trusted.
  const coreKinds = h.coreOutboxKinds();
  for (const kind of coreKinds) {
    assert.notEqual(
      intents.bridgeIntentFor(kind),
      null,
      `the Core emits "${kind}" and this build cannot deliver it; add it to CORE_INTENT_KINDS`,
    );
  }
  assert.deepEqual(
    [...intents.knownCoreIntentKinds()].sort(),
    [...coreKinds].sort(),
    "the mapping should cover exactly the Core's declared kinds",
  );
});

test("a claimed Core intent becomes a durable bridge intent and is acknowledged", async () => {
  const bridge = await withRun();
  bridge.runtime.queueCoreIntent({
    intentId: "oi_1",
    kind: "work.unit.ensure",
    runId: "run-1",
    nodeId: "architecture",
    correlationKey: "work-unit:run-1:architecture:0",
    payload: { runId: "run-1", nodeId: "architecture", iteration: 0, scope: SCOPE, title: "do the thing" },
    deliveryAttempt: 1,
    maxDeliveryAttempts: 5,
  });

  const result = await bridge.company.coreOutbox.run(SCOPE);

  assert.equal(result.claimed, 1);
  assert.equal(result.enqueued, 1);
  assert.deepEqual(result.unknownKinds, []);

  // It landed in the bridge's own queue, keyed on the Core's intent id, so a re-claim is a
  // duplicate rather than a second intent.
  const rows = bridge.store.listDeliveries(COMPANY_A, ["pending", "claimed", "retry", "failed"]);
  const enqueued = rows.filter((row) => String(row.effectKey).includes("oi_1"));
  assert.equal(enqueued.length, 1, "the Core's intent must be durable before it is acknowledged");
  assert.equal(enqueued[0]?.kind, intents.INTENT_KINDS.workUnitEnsure);

  // And the Core was told, by the real endpoint rather than a local note.
  const ack = bridge.runtime.requestsTo("POST", "/delivery").at(-1);
  assert.ok(ack, "the Core must be acknowledged");
  // The acknowledged id is the Core's own `intentId`, taken from the path the bridge posted to.
  // Acknowledging a bridge delivery id instead would report on the wrong object entirely.
  assert.match(ack.path, /\/v1\/bridge\/outbox\/oi_1\/delivery$/);
  assert.equal(JSON.parse(ack.bodyText ?? "{}")["state"], "sent");
  assert.deepEqual(
    bridge.runtime.coreAcks.map((entry) => [entry.intentId, entry.body["state"]]),
    [["oi_1", "sent"]],
  );
});

test("a governance request reaches its handler instead of being refused as a work order", async () => {
  const bridge = await withRun();
  // The Core's governance.request is a different message with a different shape, and the bridge
  // knows exactly what to do with it. The work-unit mapping was being applied to *every* kind, and
  // since it only accepts `work.unit.ensure`, every other kind was refused before its handler ran
  // -- so a human approval request could never reach the person, and a status projection never
  // reached the board. Both were left unacknowledged and re-claimed forever.
  bridge.runtime.queueCoreIntent({
    intentId: "oi_gov",
    kind: "governance.request",
    runId: "run-1",
    nodeId: "design_gate",
    correlationKey: "gov:run-1:design_gate",
    payload: {
      runId: "run-1",
      requestId: "grv-1",
      nodeId: "design_gate",
      semanticKind: "design_acceptance",
      kind: "interaction",
      question: "Approve this design?",
      transitionHash: "sha256:transition",
      decisionTargetHash: "sha256:target",
      requiredResolver: "human_only",
      options: [{ id: "accept", label: "Accept" }],
      rootIssueRef: { provider: "paperclip", kind: "issue", id: "root-1" },
    },
    deliveryAttempt: 1,
    maxDeliveryAttempts: 5,
  });

  const result = await bridge.company.coreOutbox.run(SCOPE);

  assert.equal(result.enqueued, 1, "a governance request is a known kind and must be delivered");
  assert.deepEqual(result.unknownKinds, []);
  assert.equal(
    (bridge.counters()["unreadableCoreIntentPayload"] as number) ?? 0,
    0,
    "a kind this build carries is not an unreadable payload",
  );
  assert.deepEqual(
    bridge.runtime.coreAcks.map((entry) => [entry.intentId, entry.body["state"]]),
    [["oi_gov", "sent"]],
  );
  await bridge.drain();
  const interactions = await bridge.ctx.issues.listInteractions("root-1", COMPANY_A);
  assert.equal(interactions.length, 1, "the human must receive an interaction before the delivery waits");
  assert.deepEqual(
    bridge.runtime.coreAcks.map((entry) => [entry.intentId, entry.body["state"]]),
    [["oi_gov", "sent"], ["oi_gov", "delivered"]],
  );
});

test("a status projection is delivered, not refused", async () => {
  const bridge = await withRun();
  h.seedChildIssue(bridge, "architecture");
  bridge.runtime.queueCoreIntent({
    intentId: "oi_status",
    kind: "status.project",
    runId: "run-1",
    nodeId: "architecture",
    correlationKey: "k-status",
    payload: {
      runId: "run-1",
      nodeId: "architecture",
      status: "PASSED",
      summary: "architecture passed",
      stateVersion: 4,
      origin: "polyforge",
    },
    deliveryAttempt: 1,
    maxDeliveryAttempts: 5,
  });

  const result = await bridge.company.coreOutbox.run(SCOPE);
  assert.equal(result.enqueued, 1, "a status projection must reach the board, not be refused");
  await bridge.drain();
  assert.equal((await bridge.ctx.issues.get("architecture", COMPANY_A))?.status, "done");
  assert.deepEqual(
    bridge.runtime.coreAcks.map((entry) => [entry.intentId, entry.body["state"]]),
    [["oi_status", "sent"], ["oi_status", "delivered"]],
  );
});

test("a ready node is materialized, assigned, woken, and terminally acknowledged", async () => {
  const bridge = track(
    await h.buildBridge({
      seed: {
        companies: [company(COMPANY_A)],
        projects: [project(PROJECT_A, COMPANY_A)],
        issues: [issue("root-1", COMPANY_A, PROJECT_A)],
        agents: [h.agent("agent-1", COMPANY_A)],
      },
      configureRuntime: (runtime) => {
        runtime.seedRun("run-1", {
          scope: SCOPE,
          graphId: h.GRAPH_ID,
          entrypoint: h.ENTRYPOINT,
          startIntentId: "intent-1",
        });
      },
    }),
  );
  bridge.store.putBinding({
    companyId: COMPANY_A,
    kind: "run",
    providerId: "run-1",
    projectId: PROJECT_A,
    payload: { runId: "run-1", projectId: PROJECT_A, rootIssueId: "root-1" },
  });
  h.seedCapabilityBinding(bridge, COMPANY_A, "agent:paperclip/agent-1", "agent-1", ["architecture.design"]);
  bridge.runtime.queueCoreIntent({
    intentId: "oi_dispatch",
    kind: "work.unit.ensure",
    runId: "run-1",
    nodeId: "architecture",
    correlationKey: "work-unit:run-1:architecture:0",
    payload: {
      ...coreWorkUnitPayload("architecture"),
      requiredCapabilities: ["architecture.design"],
      preferredRoles: ["engineering"],
    },
    deliveryAttempt: 1,
    maxDeliveryAttempts: 5,
  });

  await bridge.company.coreOutbox.run(SCOPE);
  const report = await bridge.pump.pumpOnce([COMPANY_A]);
  assert.equal(report.reconciled, 1);
  const children = await bridge.ctx.issues.list({
    companyId: COMPANY_A,
    originKind: "plugin:polyforge:node",
    originId: "run-1:architecture:0",
  });
  assert.equal(children.length, 1);
  assert.equal(children[0]?.assigneeAgentId, "agent-1");
  assert.ok(
    bridge.store.getBinding(COMPANY_A, "dispatch", "run-1:architecture:0"),
    "a queued wakeup must leave a durable dispatch binding",
  );
  assert.deepEqual(
    bridge.runtime.coreAcks.map((entry) => [entry.intentId, entry.body["state"]]),
    [["oi_dispatch", "sent"], ["oi_dispatch", "delivered"]],
  );
});

test("a committed migration is recorded without pretending it is a node status projection", async () => {
  const bridge = await withRun();
  bridge.runtime.queueCoreIntent({
    intentId: "oi_migration",
    kind: "migration.applied",
    runId: "run-2",
    nodeId: null,
    correlationKey: "migration:run-1:2:plan",
    payload: {
      sourceRunId: "run-1",
      successorRunId: "run-2",
      targetGraphVersion: 2,
      planHash: "sha256:plan",
      invalidatedPasses: ["design_gate"],
    },
    deliveryAttempt: 1,
    maxDeliveryAttempts: 5,
  });

  assert.equal((await bridge.company.coreOutbox.run(SCOPE)).enqueued, 1);
  assert.equal((await bridge.pump.pumpOnce([COMPANY_A])).reconciled, 1);
  const binding = bridge.store.getBinding(COMPANY_A, "migration", "run-2");
  assert.ok(binding);
  assert.equal(JSON.parse(binding.payloadJson)["sourceRunId"], "run-1");
  assert.deepEqual(
    bridge.runtime.coreAcks.map((entry) => [entry.intentId, entry.body["state"]]),
    [["oi_migration", "sent"], ["oi_migration", "delivered"]],
  );
});

test("the batch reports a refused payload, so an undelivered intent is not invisible", async () => {
  const bridge = await withRun();
  // A known kind whose payload this build cannot read. `failed` stays 0 -- nothing was written, so
  // nothing was "failed" -- which is exactly why a refusal needs its own count to be visible.
  bridge.runtime.queueCoreIntent({
    intentId: "oi_bad",
    kind: "work.unit.ensure",
    runId: "run-1",
    nodeId: "architecture",
    correlationKey: "k-bad",
    payload: { runId: "run-1", nodeId: "architecture", iteration: 0, scope: { companyRef: COMPANY_A, projectRef: "" }, title: "t" },
    deliveryAttempt: 1,
    maxDeliveryAttempts: 5,
  });

  const result = await bridge.company.coreOutbox.run(SCOPE);
  assert.equal(result.enqueued, 0);
  assert.equal(result.failed, 0, "nothing was written, so nothing failed to be written");
  assert.ok(
    (bridge.counters()["unreadableCoreIntentPayload"] as number) >= 1,
    "and the refusal is counted, so a stuck intent is visible in health",
  );
});

test("a re-claimed intent is a duplicate, not a second delivery", async () => {
  const bridge = await withRun();
  bridge.runtime.queueCoreIntent({
    intentId: "oi_2",
    kind: "work.unit.ensure",
    runId: "run-1",
    nodeId: "security_review",
    correlationKey: "work-unit:run-1:security_review:0",
    payload: coreWorkUnitPayload("security_review"),
    deliveryAttempt: 1,
    maxDeliveryAttempts: 5,
  });

  const first = await bridge.company.coreOutbox.run(SCOPE);
  assert.equal(first.enqueued, 1);

  // The Core re-issues the same intent — a crash between persisting and acknowledging, or a lease
  // that expired. The bridge must recognise it rather than dispatching the node twice.
  const second = await bridge.company.coreOutbox.run(SCOPE);
  assert.equal(second.claimed, 1);
  assert.equal(second.enqueued, 0);
  assert.equal(second.duplicates, 1);
});

test("a payload this build cannot read is refused, not enqueued and not acked", async () => {
  const bridge = await withRun();
  // A scope with no project. The Core always sends one, so this stands in for a shape this build
  // does not implement -- which is exactly the case that used to be persisted anyway and then threw
  // inside the port, leaving the intent retried forever with no account of why.
  bridge.runtime.queueCoreIntent({
    intentId: "oi_5",
    kind: "work.unit.ensure",
    runId: "run-1",
    nodeId: "architecture",
    correlationKey: "k5",
    payload: { ...coreWorkUnitPayload("architecture"), scope: { companyRef: COMPANY_A, projectRef: "" } },
    deliveryAttempt: 1,
    maxDeliveryAttempts: 5,
  });

  const result = await bridge.company.coreOutbox.run(SCOPE);

  assert.equal(result.enqueued, 0, "a work order with no project must not become a work unit");
  assert.equal(
    bridge.runtime.requestsTo("POST", "/delivery").length,
    0,
    "and it must not be acknowledged: the Core still owns the obligation",
  );
  assert.ok(
    (bridge.counters()["unreadableCoreIntentPayload"] as number) >= 1,
    "an unreadable payload is counted, so the gap cannot be silent",
  );
});

test("an intent kind this build does not carry is refused, not guessed and not acked", async () => {  const bridge = await withRun();
  bridge.runtime.queueCoreIntent({
    intentId: "oi_3",
    kind: "some.future.intent",
    runId: "run-1",
    nodeId: "architecture",
    correlationKey: "k3",
    payload: {},
    deliveryAttempt: 1,
    maxDeliveryAttempts: 5,
  });

  const result = await bridge.company.coreOutbox.run(SCOPE);

  assert.deepEqual(result.unknownKinds, ["some.future.intent"]);
  assert.equal(result.enqueued, 0);
  // Not acknowledged: telling the Core an intent was delivered when it was refused is the one
  // outcome worse than silence. The lease expires and it is claimed again once it is understood.
  assert.equal(
    bridge.runtime.requestsTo("POST", "/delivery").length,
    0,
    "an undelivered intent must not be acknowledged",
  );
  assert.ok(
    (bridge.counters()["unknownCoreIntentKinds"] as number) >= 1,
    "an unmapped kind is counted, so a gap cannot be silent",
  );
});

test("an intent that cannot be made durable is acknowledged as failed, not as sent", async () => {
  const bridge = await withRun();
  bridge.runtime.queueCoreIntent({
    intentId: "oi_4",
    kind: "work.unit.ensure",
    runId: "run-1",
    nodeId: "architecture",
    correlationKey: "k4",
    payload: coreWorkUnitPayload("architecture"),
    deliveryAttempt: 1,
    maxDeliveryAttempts: 5,
  });

  // Make the enqueue fail: an effect key the store will not accept is the honest way to stand in
  // for a full disk or a closed database.
  const deliveries = bridge.company.deliveries as unknown as { begin: (input: unknown) => boolean };
  const original = deliveries.begin.bind(deliveries);
  deliveries.begin = () => {
    throw new Error("disk is full");
  };
  try {
    const result = await bridge.company.coreOutbox.run(SCOPE);
    assert.equal(result.enqueued, 0);
    assert.equal(result.failed, 1);

    const ack = bridge.runtime.requestsTo("POST", "/delivery").at(-1);
    assert.ok(ack, "a failed persistence still has to be reported");
    assert.equal(
      JSON.parse(ack.bodyText ?? "{}")["state"],
      "failed",
      "the Core must keep the obligation when the bridge could not take it",
    );
  } finally {
    deliveries.begin = original;
  }
});
