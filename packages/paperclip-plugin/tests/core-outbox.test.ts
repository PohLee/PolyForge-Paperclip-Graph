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
import { coreIntentPayload } from "../src/outbox/core-intent-mapping.ts";

const h = await load<typeof import("./helpers/harness.ts")>(new URL("./helpers/harness.ts", import.meta.url));
const intents = await load<typeof import("../src/outbox/intents.ts")>(
  new URL("../src/outbox/intents.ts", import.meta.url),
);

const { COMPANY_A, PROJECT_A, company, project, issue } = h;
const SCOPE = { companyRef: COMPANY_A, projectRef: PROJECT_A };

const bridges: { dispose(): void }[] = [];
after(async () => {
  for (const bridge of bridges) {
    try {
      await bridge.dispose();
    } catch {
      // A bridge that already tore itself down is not a failure worth reporting.
    }
  }
});
function track<T extends { dispose(): void }>(bridge: T): T {
  bridges.push(bridge);
  return bridge;
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
    payload: { ...coreIntentPayload(), title: "do the thing", scope: SCOPE },
    deliveryAttempt: 1,
    maxDeliveryAttempts: 5,
  });

  const result = await bridge.company.coreOutbox.run(SCOPE);

  assert.equal(result.claimed, 1);
  assert.equal(result.enqueued, 1);
  assert.deepEqual(result.unknownKinds, []);

  // It landed in the bridge's own queue, keyed on the Core's intent id, so a re-claim is a
  // duplicate rather than a second intent.
  const rows = bridge.store.listDeliveries(COMPANY_A, ["pending"]);
  const enqueued = rows.filter((row) => String(row.effectKey).includes("oi_1"));
  assert.equal(enqueued.length, 1, "the Core's intent must be durable before it is acknowledged");
  assert.equal(enqueued[0]?.kind, intents.INTENT_KINDS.workUnitEnsure);

  // And the Core was told, by the real endpoint rather than a local note.
  const ack = bridge.runtime.requestsTo("POST", "/delivery").at(-1);
  assert.ok(ack, "the Core must be acknowledged");
  assert.equal(decodeURIComponent(ack.path.split("/v1/bridge/outbox/")[1]?.split("/")[0] ?? ""), "oi_1");
  assert.equal(JSON.parse(ack.bodyText ?? "{}")["state"], "sent");
});

test("a re-claimed intent is a duplicate, not a second delivery", async () => {
  const bridge = await withRun();
  bridge.runtime.queueCoreIntent({
    intentId: "oi_2",
    kind: "work.unit.ensure",
    runId: "run-1",
    nodeId: "security_review",
    correlationKey: "work-unit:run-1:security_review:0",
    payload: { ...coreIntentPayload(), nodeId: "security_review" },
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

test("an intent kind this build does not carry is refused, not guessed and not acked", async () => {
  const bridge = await withRun();
  bridge.runtime.queueCoreIntent({
    intentId: "oi_3",
    kind: "some.future.intent",
    runId: "run-1",
    nodeId: "architecture",
    correlationKey: "k3",
    payload: coreIntentPayload(),
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
    payload: coreIntentPayload(),
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
