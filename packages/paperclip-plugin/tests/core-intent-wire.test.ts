/**
 * What the Core actually puts on the wire, mapped by hand.
 *
 * This fixture is transcribed from `engine.py` (`_admit_node`'s `work.unit.ensure` payload) and
 * `TransitionContract.to_wire`, not from what the plugin wishes the Core sent. Every test that used
 * a hand-built intent before was, in effect, a test of the plugin's own assumptions.
 *
 * Two differences from the plugin's assumed shape are load-bearing:
 *
 * * there is **no top-level `projectRef`**. The project lives at `scope.projectRef`, and the port
 *   reads `intent.projectRef.length` -- so a real intent threw `Cannot read properties of undefined
 *   (reading 'length')` and every admitted node was retried instead of worked.
 * * `workspaceRequirement` is `{}` whenever the plan node declares none, and the port reads
 *   `workspaceRequirement.repositories` unconditionally -- a second crash one line later.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { coreIntentPayload, mapCoreIntentPayload, toWorkUnitIntent } from "../src/outbox/core-intent-mapping.ts";

/** Exactly what the Core enqueues when a node becomes READY. */
const CORE_WORK_UNIT_PAYLOAD = {
  runId: "run-1",
  nodeId: "architecture",
  iteration: 0,
  scope: { companyRef: "company-a", projectRef: "project-a" },
  title: "design.design: architecture",
  description: "Work the architecture node of run run-1 in graph design v3.",
  requiredCapabilities: ["architecture.produce"],
  correlationKey: "work-unit:run-1:architecture:0",
  parentIssueRef: { provider: "paperclip", kind: "issue", id: "root-1" },
  // A plan node with no declared workspace: the Core sends an empty object, not a filled one.
  workspaceRequirement: {},
} as const;

test("a real Core payload becomes a work unit intent the port can act on", () => {
  const intent = toWorkUnitIntent("work.unit.ensure", CORE_WORK_UNIT_PAYLOAD);

  // The project comes from the trusted scope, not from a top-level field the Core does not send.
  assert.equal(intent.projectRef, "project-a");
  assert.equal(intent.runId, "run-1");
  assert.equal(intent.nodeId, "architecture");
  assert.equal(intent.iteration, 0);
  assert.deepEqual(intent.scope, { companyRef: "company-a", projectRef: "project-a" });
});

test("an empty workspace requirement does not read as a missing field", () => {
  const intent = toWorkUnitIntent("work.unit.ensure", CORE_WORK_UNIT_PAYLOAD);
  // `{}` is a real answer -- no repositories, and the mode the platform default is -- and it must
  // not be read as `undefined.repositories`.
  assert.deepEqual(intent.workspaceRequirement, {
    mode: "read_write",
    repositories: [],
    requireReadOnlyForReviewer: false,
  });
});

test("a fully populated workspace requirement is carried through unchanged", () => {
  const intent = toWorkUnitIntent("work.unit.ensure", {
    ...CORE_WORK_UNIT_PAYLOAD,
    workspaceRequirement: {
      mode: "read_only_snapshot",
      repositories: [{ repoRef: "core", baseRef: "main", commit: "abc123" }],
      requireReadOnlyForReviewer: true,
    },
  });
  assert.equal(intent.workspaceRequirement.mode, "read_only_snapshot");
  assert.equal(intent.workspaceRequirement.requireReadOnlyForReviewer, true);
  assert.equal(intent.workspaceRequirement.repositories[0]?.commit, "abc123");
});

test("a payload with no project in its scope is refused, not guessed at", () => {
  assert.throws(
    () =>
      toWorkUnitIntent("work.unit.ensure", {
        ...CORE_WORK_UNIT_PAYLOAD,
        scope: { companyRef: "company-a", projectRef: "" },
      }),
    /project/i,
    "a work order with no project must be refused: project identity is what the child issue is written under",
  );
});

test("a workspace mode the bridge does not implement is refused by name", () => {
  assert.throws(
    () =>
      toWorkUnitIntent("work.unit.ensure", {
        ...CORE_WORK_UNIT_PAYLOAD,
        workspaceRequirement: { mode: "ephemeral_sandbox", repositories: [] },
      }),
    /ephemeral_sandbox/,
  );
});

test("a payload missing the fields that identify the node is refused", () => {
  assert.throws(() => toWorkUnitIntent("work.unit.ensure", { ...CORE_WORK_UNIT_PAYLOAD, runId: undefined }), /runId/);
  assert.throws(() => toWorkUnitIntent("work.unit.ensure", { ...CORE_WORK_UNIT_PAYLOAD, nodeId: "" }), /nodeId/);
  assert.throws(() => toWorkUnitIntent("work.unit.ensure", { ...CORE_WORK_UNIT_PAYLOAD, iteration: "zero" }), /iteration/);
});

test("a kind with no mapping is refused rather than passed through as a work unit", () => {
  assert.throws(() => toWorkUnitIntent("work.something.new", CORE_WORK_UNIT_PAYLOAD), /work\.something\.new/);
});

test("the exported fixture matches the Core's payload shape", () => {
  // Guards the transcription itself: if the Core's payload changes, this is the first thing that
  // should be noticed, rather than a mapper quietly accepting the old shape.
  const payload = coreIntentPayload();
  assert.ok(!("projectRef" in payload), "the Core does not send a top-level projectRef");
  assert.equal((payload["scope"] as Record<string, unknown>)["projectRef"], "project-a");
  assert.deepEqual(payload["workspaceRequirement"], {});
});

test("a real Core status payload is expanded into the status projection contract", () => {
  const mapped = mapCoreIntentPayload(
    "status.project",
    {
      runId: "run-1",
      nodeId: "architecture",
      status: "PASSED",
      summary: "architecture passed",
      stateVersion: 7,
      origin: "polyforge",
    },
    { scope: { companyRef: "company-a", projectRef: "project-a" }, correlationId: "status-7" },
  );
  assert.deepEqual(mapped["scope"], { companyRef: "company-a", projectRef: "project-a" });
  assert.equal(mapped["projectionSequence"], 7);
  assert.deepEqual(mapped["target"], { provider: "paperclip", kind: "work_unit", id: "architecture" });
  assert.deepEqual(mapped["nodeStates"], [{ nodeId: "architecture", status: "PASSED" }]);
});

test("governance and stop payloads map the Core's differently named provider refs", () => {
  const context = { scope: { companyRef: "company-a", projectRef: "project-a" }, correlationId: "corr-1" };
  const governance = mapCoreIntentPayload(
    "governance.request",
    {
      semanticKind: "design_acceptance",
      kind: "interaction",
      question: "Approve?",
      decisionTargetHash: "sha256:target",
      rootIssueRef: { provider: "paperclip", kind: "issue", id: "root-1" },
    },
    context,
  );
  assert.deepEqual(governance["targetIssueRef"], { provider: "paperclip", kind: "issue", id: "root-1" });
  assert.equal(governance["kind"], "review");

  const stop = mapCoreIntentPayload(
    "work.stop",
    { agentRunRef: { provider: "paperclip", kind: "agent_run", id: "agent-run-1" } },
    context,
  );
  assert.deepEqual(stop["ref"], { provider: "paperclip", kind: "agent_run", id: "agent-run-1" });
});
