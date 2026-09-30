/**
 * Outbox delivery — Runtime Service offline, retry with backoff, single-flight, ambiguity, dead-letter.
 * This is not docs/03 §10 AT-09 (evidence immutability). A subset is explicitly tagged AT-26 below.
 *
 * The fake Runtime is a real HTTP server, so "offline" here means the socket is gone, the response
 * never arrives, or the Core answers with a protocol error. Which of those a failure is decides
 * everything downstream, and the decision is the protocol's own `RetryDisposition` rather than a
 * status-code guess:
 *
 * - `do_not_retry` → dead letter, no budget spent;
 * - `reconcile_required` → ambiguous, resolved by reading the object back, never by resending;
 * - `safe` → stay queued with a backoff, bounded by the redelivery budget.
 *
 * What this file cannot prove is anything about the real Core's own retry behaviour; it proves the
 * bridge does not depend on it.
 */

import "./helpers/bootstrap.ts";
import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { load } from "./helpers/bootstrap.ts";

const h = await load<typeof import("./helpers/harness.ts")>(new URL("./helpers/harness.ts", import.meta.url));
const intents = await load<typeof import("../src/outbox/intents.ts")>(
  new URL("../src/outbox/intents.ts", import.meta.url),
);
const worker = await load<typeof import("../src/worker.ts")>(new URL("../src/worker.ts", import.meta.url));
const delivery = await load<typeof import("../src/outbox/delivery.ts")>(
  new URL("../src/outbox/delivery.ts", import.meta.url),
);

const { COMPANY_A, PROJECT_A, buildBridge, company, project, issue } = h;
const bridges: { dispose(): void }[] = [];
after(async () => {
  for (const bridge of bridges) await bridge.dispose();
});
function track<T extends { dispose(): Promise<void> }>(bridge: T): T {
  bridges.push(bridge);
  return bridge;
}

const SCOPE = { companyRef: COMPANY_A, projectRef: PROJECT_A };
const EFFECT_KEY = "pf.at09.observation";
const CORRELATION = "corr-at09";

function observation(overrides: Partial<{ effectKey: string; scope: typeof SCOPE }> = {}) {
  return {
    effectKey: overrides.effectKey ?? EFFECT_KEY,
    kind: intents.INTENT_KINDS.eventIntake,
    scope: overrides.scope ?? SCOPE,
    correlationId: CORRELATION,
    payload: {
      type: "pf.execution.observed",
      payload: { observationOnly: true, observationKind: "board_status_change" },
    },
  };
}

async function withBridge(extraConfig: Record<string, unknown> = {}) {
  return buildBridge({
    seed: {
      companies: [company(COMPANY_A)],
      projects: [project(PROJECT_A, COMPANY_A)],
      issues: [issue("root-1", COMPANY_A, PROJECT_A)],
    },
    // A short request timeout so "the Core never answered" does not spend the production 15s
    // waiting. The ambiguity logic is identical; only the patience differs.
    extraConfig: { requestTimeoutMs: 250, ...extraConfig },
  });
}

/** Make the next matching request hang, the way a Core that dies mid-request does. */
function hang(runtime: h.FakeRuntime, times = 1): void {
  runtime.addFault({ match: (request) => request.path.includes("/events"), kind: "hang", times });
}

/** Answer the next matching requests with a protocol error the Core itself would send. */
function refuse(
  runtime: h.FakeRuntime,
  status: number,
  code: string,
  message: string,
  times = 1,
): void {
  runtime.addFault({
    match: (request) => request.path.includes("/events"),
    kind: "status",
    status,
    body: { error: { code, message } },
    times,
  });
}

 test("OUTBOX: a queued intent survives the Runtime being unreachable and is not lost", async () => {
  const bridge = track(await withBridge());
  assert.equal(bridge.company.deliveries.begin(observation()), true);

  // The socket is gone. The pump must not drop the intent, and must not record it as done.
  await bridge.runtime.stop();
  const report = await bridge.pump.pumpOnce([COMPANY_A]);
  assert.ok(report.claimed >= 1, "the pump must have picked the intent up");
  assert.equal(bridge.store.countDeliveries(COMPANY_A, "pending") + bridge.store.countDeliveries(COMPANY_A, "ambiguous"), 1);
  assert.equal(bridge.store.countDeliveries(COMPANY_A, "observed"), 0, "an unreachable Core is not an effect that happened");
  assert.equal(bridge.store.countDeliveries(COMPANY_A, "reconciled"), 0);
});

test("a Core delivery retries until company configuration has produced a Runtime client", async () => {
  const bridge = track(await withBridge());
  let companyContext: h.TestBridge["company"] | null = null;
  let clockMs = 1_700_000_000_000;
  const pump = new delivery.OutboxPump({
    store: bridge.store,
    logger: bridge.company.logger,
    metrics: bridge.metrics,
    now: () => new Date(clockMs),
    ownerId: "test-config-discovery",
    jitter: () => 0.5,
  });
  worker.__testing.registerIntentHandlers(pump, () => companyContext);
  bridge.company.deliveries.begin(observation({ effectKey: "pf.at09.config-discovery" }));

  const first = await pump.pumpOnce([COMPANY_A]);
  assert.equal(first.retried, 1, "a missing company context is retryable, not a terminal observation");
  assert.equal(bridge.store.countDeliveries(COMPANY_A, "pending"), 1);
  assert.equal(bridge.runtime.requestsTo("POST", "/events").length, 0);

  companyContext = bridge.company;
  clockMs += 60_000;
  bridge.advanceClock(60_000);
  const second = await pump.pumpOnce([COMPANY_A]);
  assert.equal(second.reconciled, 1);
  assert.equal(bridge.store.countDeliveries(COMPANY_A, "reconciled"), 1);
  assert.equal(bridge.runtime.requestsTo("POST", "/events").length, 1);
  assert.equal(bridge.runtime.requests.at(-1)?.signatureValid, true);
});

 test("AT-26: one effect key is single-flight — concurrent pumps send it once", async () => {
  const bridge = track(await withBridge());
  // Two passes racing over the same queue: a job firing while a reconcile is already running.
  bridge.company.deliveries.begin(observation());
  const [first, second] = await Promise.all([
    bridge.pump.pumpOnce([COMPANY_A]),
    bridge.pump.pumpOnce([COMPANY_A]),
  ]);
  assert.equal(
    first.claimed + second.claimed,
    1,
    `exactly one pass may hold an effect, got ${first.claimed} + ${second.claimed}`,
  );
  assert.equal(bridge.runtime.requestsTo("POST", "/events").length, 1);
  assert.equal(bridge.runtime.intake.length, 1);
});

 test("AT-26: the same intent begun twice is one row, and the second begin is refused", async () => {
  const bridge = track(await withBridge());
  assert.equal(bridge.company.deliveries.begin(observation()), true);
  assert.equal(bridge.company.deliveries.begin(observation()), false, "a duplicate effect key is refused");
  assert.equal(bridge.store.countDeliveries(COMPANY_A, "pending"), 1);
  await bridge.drain();
  // One row, one request: replaying the same effect is not a second event.
  assert.equal(bridge.runtime.requestsTo("POST", "/events").length, 1);
  assert.equal(bridge.runtime.intake.length, 1);
});

 test("AT-26: a request that never answers is ambiguous, and is never blindly resent", async () => {
  const bridge = track(await withBridge());
  // The Core took the connection and went silent. The bridge cannot know whether the write
  // landed, so the only honest state is `ambiguous`, to be resolved by reading back.
  hang(bridge.runtime);
  bridge.company.deliveries.begin(observation());
  const report = await bridge.pump.pumpOnce([COMPANY_A]);
  assert.equal(report.ambiguous, 1, `expected one ambiguous outcome, got ${JSON.stringify(report)}`);
  const rows = bridge.store.listDeliveries(COMPANY_A, ["ambiguous", "pending", "failed", "observed"]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.status, "ambiguous");
  // Not retried automatically: a resend is how one event becomes two.
  const again = await bridge.pump.pumpOnce([COMPANY_A]);
  assert.equal(again.claimed, 0, "an ambiguous intent waits for reconciliation");
  assert.equal(bridge.runtime.requestsTo("POST", "/events").length, 1);
});

 test("AT-26: a 503 the Core marks reconcile_required is ambiguous, not a retry", async () => {
  const bridge = track(await withBridge());
  // `CONTROL_PLANE_UNAVAILABLE` is the protocol's own "may have taken effect" answer. Treating it
  // as a plain retry is how a control-plane restart duplicates an event.
  refuse(bridge.runtime, 503, "CONTROL_PLANE_UNAVAILABLE", "control plane restarting");
  bridge.company.deliveries.begin(observation());
  const report = await bridge.pump.pumpOnce([COMPANY_A]);
  assert.equal(report.ambiguous, 1);
  assert.equal(bridge.store.countDeliveries(COMPANY_A, "ambiguous"), 1);
});

 test("OUTBOX: a deterministic rejection is dead-lettered at once and never retried", async () => {
  const bridge = track(await withBridge());
  // 422 CONTRACT_INVALID will not become valid by trying again.
  refuse(bridge.runtime, 422, "CONTRACT_INVALID", "payload is not a valid observation");
  bridge.company.deliveries.begin(observation());
  const report = await bridge.pump.pumpOnce([COMPANY_A]);
  assert.equal(report.failed, 1);
  assert.equal(bridge.store.countDeliveries(COMPANY_A, "failed"), 1);
  // A second pass does not touch it: no budget is spent on a permanent failure.
  const second = await bridge.pump.pumpOnce([COMPANY_A]);
  assert.equal(second.claimed, 0);
  // And the reason is legible to a human, which is what makes a dead letter actionable.
  const rows = bridge.store.listDeliveries(COMPANY_A, ["failed"]);
  assert.match(String(rows[0]?.lastError), /CONTRACT_INVALID/);
  assert.equal(bridge.store.countDeliveries(COMPANY_A, "observed"), 0, "a rejection is not an effect that happened");
});

 test("OUTBOX: a safe rejection retries with a backoff and succeeds once the Core is ready", async () => {
  const bridge = track(await withBridge({ baseBackoffMs: 50 }));
  // `VERSION_CONFLICT` is `safe`: the command is idempotent, so replaying it returns the
  // recorded result rather than applying anything twice.
  refuse(bridge.runtime, 409, "VERSION_CONFLICT", "expectedStateVersion 7 is stale", 1);
  bridge.company.deliveries.begin(observation());

  const first = await bridge.pump.pumpOnce([COMPANY_A]);
  assert.equal(first.retried, 1, "a safe rejection stays queued");
  const queued = bridge.store.listDeliveries(COMPANY_A, ["pending"]);
  assert.equal(queued.length, 1, "it must remain pending, not be recorded as done");
  const scheduled = new Date(queued[0]!.nextAttemptAt).getTime();
  // The bridge's clock is the one the pump schedules against, so the delay is measured from it
  // rather than from wall time.
  assert.ok(
    scheduled > bridge.store.getCompat<number>(COMPANY_A, "test/now", 0) || scheduled > Date.now(),
    "the retry must be scheduled in the future, not as an immediate hot loop",
  );
  assert.ok(queued[0]!.attempts >= 1);

  // Too soon: a pass does nothing rather than hammering the Core.
  const tooSoon = await bridge.pump.pumpOnce([COMPANY_A]);
  assert.equal(tooSoon.claimed, 0, "the backoff must be respected");

  // Due: it goes out again and lands.
  bridge.store.updateDelivery(COMPANY_A, EFFECT_KEY, { nextAttemptAt: new Date(0).toISOString() });
  await bridge.pump.pumpOnce([COMPANY_A]);
  assert.equal(bridge.runtime.requestsTo("POST", "/events").length, 2);
  assert.equal(bridge.runtime.intake.length, 1, "the event reached the Core exactly once");
  assert.equal(bridge.store.countDeliveries(COMPANY_A, "pending"), 0);
});

 test("OUTBOX: the redelivery budget is finite and the intent ends as a visible dead letter", async () => {
  const bridge = track(await withBridge({ baseBackoffMs: 1 }));
  refuse(bridge.runtime, 409, "VERSION_CONFLICT", "stale", 99);
  bridge.company.deliveries.begin(observation());

  for (let pass = 0; pass < 8; pass += 1) {
    bridge.store.updateDelivery(COMPANY_A, EFFECT_KEY, { nextAttemptAt: new Date(0).toISOString() });
    await bridge.pump.pumpOnce([COMPANY_A]);
    if (bridge.store.countDeliveries(COMPANY_A, "failed") > 0) break;
  }
  const failed = bridge.store.listDeliveries(COMPANY_A, ["failed"]);
  assert.equal(failed.length, 1, "the budget must end the retries rather than spin forever");
  assert.equal(bridge.store.countDeliveries(COMPANY_A, "pending"), 0);
  assert.match(String(failed[0]?.lastError), /exhaust/);
  // And the dead letter is countable, so health can show it instead of a queue that looks busy.
  assert.equal(bridge.store.countDeliveries(COMPANY_A, "failed"), 1);
});

 test("AT-26: a delivered intent is terminal and is never re-sent", async () => {
  const bridge = track(await withBridge());
  bridge.company.deliveries.begin(observation());
  await bridge.drain();
  const settled = bridge.store.countDeliveries(COMPANY_A, "observed") + bridge.store.countDeliveries(COMPANY_A, "reconciled");
  assert.equal(settled, 1);
  // Further passes are no-ops: a delivered intent is not polled.
  const report = await bridge.pump.pumpOnce([COMPANY_A]);
  assert.equal(report.claimed, 0);
  assert.equal(bridge.runtime.intake.length, 1);
});

 test("OUTBOX: a new issue event derives its project scope from Paperclip before intake", async () => {
  const bridge = track(await withBridge());
  // Paperclip's issue.created event does not carry projectId, and a new issue has no local bridge
  // binding yet. The scope must therefore come from the host's authoritative issue read.
  const outcome = await bridge.eventPump.handle(
    h.hostEvent(
      "issue.created",
      "event-unbound-root-1",
      { issueId: "root-1", status: "todo", labels: [] },
      { entityId: "root-1", entityType: "issue" },
    ),
  );
  assert.equal(outcome.normalized, 1);
  await bridge.drain();
  assert.equal(bridge.runtime.intake.length, 1);
  assert.deepEqual(bridge.runtime.intake[0]?.["scope"], { companyRef: COMPANY_A, projectRef: PROJECT_A });
});

 test("AT-29: two companies' queues never mix, even for the same effect key", async () => {
  const bridge = track(
    await buildBridge({
      extraCompanyIds: ["company-b"],
      seed: {
        companies: [company(COMPANY_A), company("company-b")],
        projects: [project(PROJECT_A, COMPANY_A), project("project-b", "company-b")],
        issues: [issue("root-1", COMPANY_A, PROJECT_A)],
      },
      extraConfig: { requestTimeoutMs: 250 },
    }),
  );
  // The *same* effect key in two companies is two independent deliveries, not a collision.
  assert.equal(bridge.company.deliveries.begin(observation()), true);
  assert.equal(
    bridge.companies.get("company-b")!.deliveries.begin(
      observation({ scope: { companyRef: "company-b", projectRef: "project-b" } }),
    ),
    true,
  );
  assert.equal(bridge.store.countDeliveries(COMPANY_A, "pending"), 1);
  assert.equal(bridge.store.countDeliveries("company-b", "pending"), 1);
  await bridge.pump.pumpOnce([...bridge.companies.keys()]);
  assert.equal(bridge.runtime.intake.length, 2, "neither was suppressed as a duplicate of the other");
  // Each delivery was signed with its own tenant's scope, so the Core can tell them apart as well
  // as the bridge can. The scope lives in the signature, not in the body — a body field would be a
  // claim, not a boundary.
  const scopes = bridge.runtime.requestsTo("POST", "/events").map((request) => {
    const canonical = request.canonicalRequest ?? "";
    const match = /"scope":\{"companyRef":"([^"]+)"/.exec(canonical);
    return match?.[1] ?? canonical;
  });
  assert.deepEqual(scopes.sort(), ["company-a", "company-b"]);
});

 test("OUTBOX: every request the bridge makes is correctly signed, even when it fails", async () => {
  // A divergence between the TypeScript and Python canonical encoders would show up as a `401`
  // in production and nowhere else, so the fake recomputes the signature from the bytes it
  // received and this asserts it, on the failure paths too.
  const bridge = track(await withBridge());
  bridge.company.deliveries.begin(observation());
  refuse(bridge.runtime, 503, "CONTROL_PLANE_UNAVAILABLE", "restarting", 1);
  await bridge.pump.pumpOnce([COMPANY_A]);
  assert.ok(bridge.runtime.requests.length >= 1);
  for (const request of bridge.runtime.requests) {
    assert.equal(request.signatureValid, true, `${request.method} ${request.path} was not signed correctly`);
    assert.match(request.headers["x-pf-signature"] ?? "", /^v1=[0-9a-f]{64}$/);
  }
});
