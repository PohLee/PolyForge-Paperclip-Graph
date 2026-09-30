/**
 * AT-19 (GRAPH-06) and AT-22 (MIG-05, ENTRY-06) — pins survive a graph version, child identity is
 * stable, and rework is explicit.
 *
 * - AT-19: "发布/激活 v14 后 v13 run/child 继续使用原 pin；安全撤销仍暂停旧 run" — after a new graph
 *   version is published and activated, a run and its child keep the pin they started with, and a
 *   security revocation still pauses the old run.
 * - AT-22: "bounded fan-out 产生稳定 child IDs；replay 无重复 child；显式 rework generation 可新建" —
 *   bounded fan-out yields stable child ids, a replay produces no duplicate child, and only an
 *   explicit rework generation may create a new one.
 *
 * The pin half of AT-19 is Core-owned: publishing v14 is not something a bridge does. What is
 * proven here is the bridge side that makes the pin meaningful — it records the pin a run started
 * with, it re-reads rather than trusting its cache, and it surfaces the old run as still pinned
 * when a newer graph version exists.
 */

import "./helpers/bootstrap.ts";
import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { load } from "./helpers/bootstrap.ts";

const h = await load<typeof import("./helpers/harness.ts")>(new URL("./helpers/harness.ts", import.meta.url));

const { COMPANY_A, PROJECT_A, GRAPH_ID, ENTRYPOINT, buildBridge, company, project, issue, label } = h;
const bridges: { dispose(): void }[] = [];
after(async () => {
  for (const bridge of bridges) await bridge.dispose();
});
function track<T extends { dispose(): Promise<void> }>(bridge: T): T {
  bridges.push(bridge);
  return bridge;
}

const SCOPE = { companyRef: COMPANY_A, projectRef: PROJECT_A };
const META = { commandId: "c", idempotencyKey: "pf:x:1", correlationId: "corr" };

function workspaceRequirement() {
  return {
    mode: "metadata_only" as const,
    // The Core pins the commits; the platform provisions. A requirement with no repositories asks
    // for no particular checkout, which is the honest default for a node that writes its own.
    repositories: [],
    requireReadOnlyForReviewer: false,
  };
}

function workUnit(overrides: Record<string, unknown> = {}) {
  return {
    scope: SCOPE,
    runId: "run-1",
    nodeId: "n1",
    iteration: 0,
    title: "Implement the checkout service",
    description: "Node n1 of run-1",
    correlationKey: "corr-n1",
    requiredCapabilities: ["code.modify"],
    projectRef: PROJECT_A,
    parentIssueRef: { provider: "paperclip", kind: "issue", id: "root-1" } as const,
    workspaceRequirement: workspaceRequirement(),
    labels: ["engineering"],
    ...overrides,
  };
}

/** A bridge with a root issue, a run bound to it, and a pinned snapshot. */
async function withRun(pinVersion = 13) {
  const bridge = await buildBridge({
    seed: {
      companies: [company(COMPANY_A)],
      projects: [project(PROJECT_A, COMPANY_A)],
      issues: [issue("root-1", COMPANY_A, PROJECT_A, { labels: [label("engineering")] })],
    },
    configureRuntime: (runtime) => {
      runtime.seedRun("run-1", {
        scope: SCOPE,
        graphId: GRAPH_ID,
        graphVersion: pinVersion,
        entrypoint: ENTRYPOINT,
        startIntentId: "intent-1",
        pins: { startIntentId: "intent-1", graph: `${GRAPH_ID}@${pinVersion}` },
      });
    },
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

// ---------------------------------------------------------------------------
// AT-19: pins
// ---------------------------------------------------------------------------

test("AT-19: a run's pin is recorded from the Core, not invented by the bridge", async () => {
  const bridge = track(await withRun(13));
  await bridge.company.reconciler.reconcileCompany(COMPANY_A);
  const row = bridge.store.getBinding(COMPANY_A, "run", "run-1");
  assert.ok(row, "the run binding must carry the pin");
  const payload = JSON.parse(row.payloadJson) as Record<string, unknown>;
  const pins = payload["pins"] as Record<string, unknown>;
  assert.equal(pins["graph"], `${GRAPH_ID}@13`);
  assert.equal(pins["startIntentId"], "intent-1");
  // The version is part of the identity: an unpinned run would silently follow v14.
  assert.equal(payload["graphVersion"], 13);
});

test("AT-19: a v13 run keeps its pin when the Core publishes and activates v14", async () => {
  const bridge = track(await withRun(13));
  await bridge.company.reconciler.reconcileCompany(COMPANY_A);
  const before = bridge.store.getBinding(COMPANY_A, "run", "run-1");
  const pinsBefore = (JSON.parse(before!.payloadJson) as Record<string, unknown>)["pins"];

  // The Core publishes v14 and makes it the active version. The run itself does not change: a
  // running graph is not silently re-pointed at a newer definition.
  bridge.runtime.graphs.set(GRAPH_ID, {
    graphId: GRAPH_ID,
    name: "Test graph",
    version: 14,
    activeVersion: 14,
    entrypoints: { [ENTRYPOINT]: { key: ENTRYPOINT, startNodes: ["n1"] } },
    nodes: [{ nodeId: "n-new-in-v14", kind: "agent_operation" }],
    edges: [],
  });

  await bridge.company.reconciler.reconcileCompany(COMPANY_A);
  const after_ = bridge.store.getBinding(COMPANY_A, "run", "run-1");
  const pinsAfter = (JSON.parse(after_!.payloadJson) as Record<string, unknown>)["pins"];
  assert.deepEqual(pinsAfter, pinsBefore, "an in-flight run must keep the version it started with");
  assert.equal((pinsAfter as Record<string, unknown>)["graph"], `${GRAPH_ID}@13`);
  // And the Core's own snapshot is the authority: it still reports the run at v13.
  const snapshot = await bridge.company.runtime!.getRun(
    { actorType: "system", actorId: "test", agentId: null, runId: null, roles: [] },
    SCOPE,
    "run-1",
  );
  assert.equal(snapshot["graphVersion"], 13);
});

test("AT-19: a child work unit records the run pin it was created under", async () => {
  const bridge = track(await withRun(13));
  // The pin is observed from the Core first (the reconciler's job), then inherited by the child.
  // A child cannot know its graph version on its own, and inventing one would defeat the pin.
  await bridge.company.reconciler.reconcileCompany(COMPANY_A);
  const ref = await bridge.company.ports.work.ensureWorkUnit(workUnit(), META);
  const row = bridge.store.getBinding(COMPANY_A, "work_unit", "run-1:n1:0");
  assert.ok(row, "the child work unit must be recorded");
  const payload = JSON.parse(row.payloadJson) as Record<string, unknown>;
  assert.equal(payload["runId"], "run-1");
  assert.equal(payload["iteration"], 0);
  // The child belongs to the run, so it inherits the run's version — a child created against v14
  // for a v13 run would execute different work than the graph asked for.
  assert.equal(payload["graphVersion"], 13);
  assert.equal((payload["pins"] as Record<string, unknown>)["graph"], `${GRAPH_ID}@13`);
  assert.equal(ref.kind, "issue");
});

test("a repo-backed child requests Paperclip isolation without inheriting a parent workspace", async () => {
  const bridge = track(await withRun(13));
  const create = bridge.ctx.issues.create.bind(bridge.ctx.issues);
  let requested: Parameters<typeof bridge.ctx.issues.create>[0] | null = null;
  bridge.ctx.issues.create = async (input) => {
    requested = input;
    return create(input);
  };

  await bridge.company.ports.work.ensureWorkUnit(
    workUnit({
      workspaceRequirement: {
        mode: "read_write",
        repositories: [{ repoRef: "https://example.invalid/repo.git", baseRef: "main", commit: "a".repeat(40) }],
        requireReadOnlyForReviewer: false,
      },
    }),
    META,
  );

  assert.ok(requested, "the host issue should be created");
  assert.equal(requested.executionWorkspacePreference, "isolated_workspace");
  assert.deepEqual(requested.executionWorkspaceSettings, { mode: "isolated_workspace" });
  assert.equal("inheritExecutionWorkspaceFromIssueId" in requested, false);
});

test("repo-backed modes that cannot be enforced are refused before child creation", async () => {
  const bridge = track(await withRun(13));
  let createCount = 0;
  const create = bridge.ctx.issues.create.bind(bridge.ctx.issues);
  bridge.ctx.issues.create = async (input) => {
    createCount += 1;
    return create(input);
  };

  await assert.rejects(
    () =>
      bridge.company.ports.work.ensureWorkUnit(
        workUnit({
          workspaceRequirement: {
            mode: "read_only_snapshot",
            repositories: [{ repoRef: "https://example.invalid/repo.git", baseRef: "main", commit: "a".repeat(40) }],
            requireReadOnlyForReviewer: true,
          },
        }),
        META,
      ),
    /not implemented for repository work/,
  );
  assert.equal(createCount, 0, "unsupported read-only work must not leave a misleading runnable child");
});

test("a repo-backed work unit without a full commit pin is refused before child lookup or creation", async () => {
  const bridge = track(await withRun(13));
  let listCount = 0;
  let createCount = 0;
  const list = bridge.ctx.issues.list.bind(bridge.ctx.issues);
  const create = bridge.ctx.issues.create.bind(bridge.ctx.issues);
  bridge.ctx.issues.list = async (...args) => {
    listCount += 1;
    return list(...args);
  };
  bridge.ctx.issues.create = async (...args) => {
    createCount += 1;
    return create(...args);
  };

  await assert.rejects(
    () =>
      bridge.company.ports.work.ensureWorkUnit(
        workUnit({
          workspaceRequirement: {
            mode: "read_write",
            repositories: [{ repoRef: "https://example.invalid/repo.git", baseRef: "main" }],
            requireReadOnlyForReviewer: false,
          },
        }),
        META,
      ),
    /full Git commit pin/,
  );
  assert.equal(listCount, 0, "invalid repository intent must not attempt host-side dedupe/recovery");
  assert.equal(createCount, 0, "invalid repository intent must not create a blocked child issue");
});

test("a replay repairs a legacy repo child with no workspace preference", async () => {
  const legacyChild = h.issue("legacy-child", COMPANY_A, PROJECT_A, {
    parentId: "root-1",
    originKind: "plugin:polyforge:node",
    originId: "run-1:n1:0",
  });
  const bridge = track(await withRun(13));
  bridge.harness.seed({ issues: [legacyChild] });

  await bridge.company.ports.work.ensureWorkUnit(
    workUnit({
      workspaceRequirement: {
        mode: "read_write",
        repositories: [{ repoRef: "https://example.invalid/repo.git", baseRef: "main", commit: "a".repeat(40) }],
        requireReadOnlyForReviewer: false,
      },
    }),
    META,
  );

  const repaired = await bridge.ctx.issues.get("legacy-child", COMPANY_A);
  assert.equal(repaired?.executionWorkspacePreference, "isolated_workspace");
  assert.deepEqual(repaired?.executionWorkspaceSettings, { mode: "isolated_workspace" });
});

test("a replay does not overwrite a conflicting workspace preference", async () => {
  const conflictingChild = h.issue("conflicting-child", COMPANY_A, PROJECT_A, {
    parentId: "root-1",
    originKind: "plugin:polyforge:node",
    originId: "run-1:n1:0",
    executionWorkspacePreference: "shared_workspace",
  });
  const bridge = track(await withRun(13));
  bridge.harness.seed({ issues: [conflictingChild] });

  await assert.rejects(
    () =>
      bridge.company.ports.work.ensureWorkUnit(
        workUnit({
          workspaceRequirement: {
            mode: "read_write",
            repositories: [{ repoRef: "https://example.invalid/repo.git", baseRef: "main", commit: "a".repeat(40) }],
            requireReadOnlyForReviewer: false,
          },
        }),
        META,
      ),
    /conflicting workspace preference/,
  );
  const unchanged = await bridge.ctx.issues.get("conflicting-child", COMPANY_A);
  assert.equal(unchanged?.executionWorkspacePreference, "shared_workspace");
});

test("AT-19: a security revocation still pauses the old run, pin or not", async () => {
  const bridge = track(await withRun(13));
  await bridge.eventPump.handle(
    h.hostEvent("project.workspace_deleted", "evt-revoke-1", {
      workspaceId: "pw-1",
      projectId: PROJECT_A,
    }),
  );
  await bridge.drain();
  const blocked = bridge.runtime.intake.find(
    (event) => (event as Record<string, unknown>)["type"] === "pf.run.blocked",
  );
  assert.ok(blocked, "a revocation must reach the Core as a block");
  const payload = (blocked as Record<string, unknown>)["payload"] as Record<string, unknown>;
  assert.equal(payload["blockReason"], "BLOCKED_WORKSPACE");
  // The pin is irrelevant to a revocation: a version that is no longer safe to run stops running.
  assert.notEqual(payload["graphVersion"], 14);
});

// ---------------------------------------------------------------------------
// AT-22: bounded fan-out, stable child ids, no duplicate on replay
// ---------------------------------------------------------------------------

test("AT-22: a fan-out produces one child per node, with a stable id", async () => {
  const bridge = track(await withRun(13));
  // Three nodes, bounded fan-out: the Core decides the bound, the bridge materializes one child
  // per node execution.
  for (const nodeId of ["n1", "n2", "n3"]) {
    const ref = await bridge.company.ports.work.ensureWorkUnit(workUnit({ nodeId }), META);
    assert.equal(ref.kind, "issue");
  }
  const ids = ["run-1:n1:0", "run-1:n2:0", "run-1:n3:0"].map(
    (id) => bridge.store.getBinding(COMPANY_A, "work_unit", id)?.payloadJson ?? "",
  );
  assert.equal(ids.filter((payload) => payload.length > 0).length, 3);
  // Each child's origin id is derived from (run, node, iteration) — not from a counter or a clock,
  // so a replay computes the same identity.
  for (const [index, nodeId] of ["n1", "n2", "n3"].entries()) {
    const payload = JSON.parse(ids[index]!) as Record<string, unknown>;
    assert.equal(payload["originId"], `run-1:${nodeId}:0`);
  }
});

test("AT-22: a replayed fan-out creates no second child", async () => {
  const bridge = track(await withRun(13));
  const first = await bridge.company.ports.work.ensureWorkUnit(workUnit(), META);
  // The host's own origin surface is the dedupe: a second call finds the existing child.
  const second = await bridge.company.ports.work.ensureWorkUnit(workUnit(), META);
  assert.equal(second.id, first.id, "the same node execution must resolve to the same child");
  const children = await bridge.ctx.issues.list({
    companyId: COMPANY_A,
    originKind: "plugin:polyforge:node",
    originId: "run-1:n1:0",
  });
  assert.equal(children.length, 1, "exactly one child exists for this origin");
});

test("AT-22: a different iteration is a different child, and a different run is too", async () => {
  const bridge = track(await withRun(13));
  const first = await bridge.company.ports.work.ensureWorkUnit(workUnit(), META);
  // A retry of the same node is a new attempt with a new iteration, and needs its own child so
  // the two attempts cannot overwrite each other's evidence.
  const retry = await bridge.company.ports.work.ensureWorkUnit(workUnit({ iteration: 1 }), META);
  assert.notEqual(retry.id, first.id);
  const otherRun = await bridge.company.ports.work.ensureWorkUnit(workUnit({ runId: "run-2" }), META);
  assert.notEqual(otherRun.id, first.id);
  // Three distinct children, three distinct origins.
  for (const originId of ["run-1:n1:0", "run-1:n1:1", "run-2:n1:0"]) {
    const found = await bridge.ctx.issues.list({
      companyId: COMPANY_A,
      originKind: "plugin:polyforge:node",
      originId,
    });
    assert.equal(found.length, 1, `exactly one child for ${originId}`);
  }
});

test("AT-22: rework is explicit — a new iteration creates a new child, and nothing else does", async () => {
  const bridge = track(await withRun(13));
  const first = await bridge.company.ports.work.ensureWorkUnit(workUnit(), META);
  // `WorkUnitIntent` has no dedicated `generation` field, so the only explicit lever the Core has
  // is the iteration. That is the assumption to confirm with the Core team; what matters here is
  // the property: rework happens when the Core asks for it, and not on the bridge's initiative.
  const sameAgain = await bridge.company.ports.work.ensureWorkUnit(
    workUnit({ correlationKey: "corr-n1-retry" }),
    { ...META, idempotencyKey: "pf:x:retry" },
  );
  assert.equal(sameAgain.id, first.id, "a different correlation key is not a rework");

  // Nothing the bridge does on its own moves the iteration.
  const binding = bridge.store.getBinding(COMPANY_A, "work_unit", "run-1:n1:0");
  const payload = JSON.parse(String(binding?.payloadJson ?? "{}")) as Record<string, unknown>;
  assert.equal(payload["iteration"], 0, "the bridge must not invent a rework");

  // The explicit ask: iteration 1 is a new execution and gets its own child, keeping the old one.
  const rework = await bridge.company.ports.work.ensureWorkUnit(
    workUnit({ iteration: 1, correlationKey: "corr-n1-rework" }),
    { ...META, idempotencyKey: "pf:x:rework" },
  );
  assert.notEqual(rework.id, first.id, "an explicit rework iteration creates a new child");
  assert.ok(await bridge.ctx.issues.get(first.id, COMPANY_A), "the original child is kept as history");
  const original = bridge.store.getBinding(COMPANY_A, "work_unit", "run-1:n1:0");
  const originalPayload = JSON.parse(String(original?.payloadJson ?? "{}")) as Record<string, unknown>;
  assert.equal(originalPayload["issueId"], first.id, "the identity for iteration 0 is unchanged");
});

test("AT-22: a child is created in the trusted project, never one the caller names", async () => {
  const bridge = track(await withRun(13));
  // The intent names a project; the port checks it against the authenticated scope rather than
  // trusting it, because a child in someone else's project would be a cross-tenant write.
  await assert.rejects(
    () =>
      bridge.company.ports.work.ensureWorkUnit(
        workUnit({ projectRef: "project-somewhere-else" }),
        META,
      ),
    /project|scope/i,
  );
  const children = await bridge.ctx.issues.list({
    companyId: COMPANY_A,
    originKind: "plugin:polyforge:node",
    originId: "run-1:n1:0",
  });
  assert.equal(children.length, 0, "a refused intent must not leave a half-made child");
});
