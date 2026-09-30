/**
 * Tool/claim contract — lease epochs, fencing, the six tools, and fast pending responses.
 * This is not docs/03 §10 AT-06 (workspace isolation); see the requirements matrix for that gate.
 *
 * ## Harness limits
 *
 * The SDK test harness exposes no `callTool`: `ctx.tools.register` is its only tool surface. The
 * harness wrapper keeps the registered handler and invokes it with a `ToolRunContext` the test
 * supplies, so what is proven is the bridge's handler logic — not the host's tool dispatch, its
 * schema validation, or its derivation of the run context from a real agent run. The Core side is
 * real in the way that matters here: the fake Runtime keeps a lease per `run|node|iteration` and
 * rejects a claim presenting a stale epoch, so a bridge that trusted only its own store would fail
 * these tests.
 */

import "./helpers/bootstrap.ts";
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { after, test } from "node:test";
import { load } from "./helpers/bootstrap.ts";

const h = await load<typeof import("./helpers/harness.ts")>(new URL("./helpers/harness.ts", import.meta.url));
const register = await load<typeof import("../src/tools/register.ts")>(
  new URL("../src/tools/register.ts", import.meta.url),
);
const protocol = await load<typeof import("@polyforge/protocol")>("@polyforge/protocol");
const sdk = await load<typeof import("@paperclipai/plugin-sdk")>("@paperclipai/plugin-sdk");

const { COMPANY_A, PROJECT_A, GRAPH_ID, ENTRYPOINT, buildBridge, company, project, issue, label } = h;
const bridges: { dispose(): void }[] = [];
after(async () => {
  for (const bridge of bridges) await bridge.dispose();
});
function track<T extends { dispose(): Promise<void> }>(bridge: T): T {
  bridges.push(bridge);
  return bridge;
}

const AGENT_ID = "agent-1";
const AGENT_RUN = "agent-run-1";
const OTHER_AGENT_RUN = "agent-run-2";
const OTHER_AGENT_ID = "agent-2";
const WORK_UNIT_BINDING_KIND = "work_unit";

/** The `ToolRunContext` a host would hand the tool for a dispatched agent run. */
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

const intruderCtx = () =>
  runCtx({ runId: OTHER_AGENT_RUN, agentId: OTHER_AGENT_ID, toolName: "current", callId: "call-2" });

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
    policyConstraints: { mayTouchPaths: ["src/**"] },
    permittedActions: ["polyforge.submit_evidence"],
    claimable: true,
    previousOwnerAgentRunId: null,
    ...overrides,
  };
}

/** A bridge with one work unit dispatched to `agent-run-1`, and a Core contract for `run-1`. */
async function withWorkUnit(options: { current?: Record<string, unknown> } = {}) {
  const bridge = await buildBridge({
    seed: {
      companies: [company(COMPANY_A)],
      projects: [project(PROJECT_A, COMPANY_A)],
      issues: [issue("root-1", COMPANY_A, PROJECT_A, { labels: [label("engineering")] })],
    },
    configureRuntime: (runtime) => {
      runtime.seedRun("run-1", {
        scope: { companyRef: COMPANY_A, projectRef: PROJECT_A },
        graphId: GRAPH_ID,
        entrypoint: ENTRYPOINT,
        startIntentId: "intent-1",
      });
      runtime.contracts.set("run-1", contract(options.current ?? {}));
    },
  });
  // The run binding, which is where a run-scoped call learns its project. Without it every tool
  // call is refused with BLOCKED_SCOPE, which is the correct behaviour: the Core treats the
  // company/project pair as the only tenant identity and refuses an empty project, and a run the
  // bridge never recorded a project for genuinely has no scope to be signed with.
  bridge.store.putBinding({
    companyId: COMPANY_A,
    kind: "run",
    providerId: "run-1",
    projectId: PROJECT_A,
    payload: { runId: "run-1", projectId: PROJECT_A, rootIssueId: "root-1" },
  });
  bridge.store.putBinding({
    companyId: COMPANY_A,
    kind: WORK_UNIT_BINDING_KIND,
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
    kind: "run",
    providerId: "run-1",
    projectId: PROJECT_A,
    payload: { runId: "run-1", rootIssueId: "root-1", projectId: PROJECT_A },
  });
  // The dispatch record the bridge itself would have written when it handed this node to the
  // agent. It is what lets a later stop-check attribute the agent run to an issue at all.
  bridge.store.putBinding({
    companyId: COMPANY_A,
    kind: "dispatch",
    providerId: AGENT_RUN,
    projectId: PROJECT_A,
    payload: { agentRunRefId: AGENT_RUN, issueId: "root-1", runId: "run-1", nodeId: "n1" },
  });
  return bridge;
}

/** Dispatch a second agent run to the same node, the way a stale redispatch would. */
function dispatchIntruder(bridge: Awaited<ReturnType<typeof withWorkUnit>>): void {
  bridge.store.putBinding({
    companyId: COMPANY_A,
    kind: WORK_UNIT_BINDING_KIND,
    providerId: "run-1:n1:0:intruder",
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
}

function envelope(result: sdk.ToolResult): Record<string, unknown> {
  return result.data as Record<string, unknown>;
}

function claimOf(data: Record<string, unknown>): Record<string, unknown> {
  return (data["data"] as Record<string, unknown>)["claim"] as Record<string, unknown>;
}

/** Drop every `description` key, recursively, so only the validating shape is compared. */
function stripDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => stripDescriptions(item));
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key === "description") continue;
    out[key] = stripDescriptions(entry);
  }
  return out;
}

// ---------------------------------------------------------------------------
// REQ-TOOL-01 / REQ-TOOL-02: exactly six tools, in sync with the manifest
// ---------------------------------------------------------------------------

 test("TOOL: the registered tool set is exactly the manifest's, with the manifest's declarations", async () => {
  const bridge = track(await withWorkUnit());
  const registered = [...bridge.tools.keys()].sort();
  const declared = (h.manifest.tools ?? []).map((tool) => tool.name).sort();
  assert.deepEqual(registered, declared);
  assert.equal(registered.length, 6);
  // No alias: `node.complete` must not exist as a name, because REQ-TOOL-02 forbids a name that is
  // not *exactly* `request_transition`.
  assert.equal(registered.includes("node.complete"), false);
  // The registered declaration is the protocol's schema, and the manifest declares the same
  // shape with richer documentation. What must match is everything the host validates.
  for (const tool of h.manifest.tools ?? []) {
    const entry = bridge.tools.get(tool.name);
    assert.ok(entry, `${tool.name} must be registered`);
    assert.equal(entry.declaration["displayName"], tool.displayName);
    assert.deepEqual(
      stripDescriptions(entry.declaration["parametersSchema"]),
      stripDescriptions(tool.parametersSchema),
      `${tool.name} must validate identically to the manifest`,
    );
  }
  // The validating shape is the protocol's own constant, which is where a drift would start.
  for (const tool of h.manifest.tools ?? []) {
    const expected = protocol.TOOL_PARAMETERS[tool.name as keyof typeof protocol.TOOL_PARAMETERS];
    assert.deepEqual(
      stripDescriptions(tool.parametersSchema),
      stripDescriptions(expected),
      `${tool.name} must validate identically to the shared TOOL_PARAMETERS`,
    );
  }
  assert.deepEqual(register.REGISTERED_TOOL_NAMES.slice().sort(), declared);
  const artifactTool = h.manifest.tools?.find((tool) => tool.name === "submit_artifact");
  const artifactSchema = artifactTool?.parametersSchema as {
    properties?: { artifacts?: { items?: { properties?: { source?: { properties?: { kind?: { enum?: string[] } } } } } } };
  };
  assert.deepEqual(
    artifactSchema.properties?.artifacts?.items?.properties?.source?.properties?.kind?.enum,
    ["document", "inline"],
    "attachment uploads stay out of the agent tool schema until the host capability is granted",
  );
});

 test("TOOL: every tool response is the protocol envelope, with the declared fields and nothing else", async () => {
  const bridge = track(await withWorkUnit());
  await bridge.callTool("current", { adopt: true }, runCtx());
  const calls = [
    ["status", {}],
    ["current", {}],
    ["submit_evidence", { nodeId: "n1", evidence: [{ kind: "test_report", contentHash: "sha256:r" }] }],
    ["submit_artifact", { nodeId: "n1", artifacts: [{ kind: "code_diff", contentHash: "sha256:d" }] }],
    ["request_transition", { nodeId: "n1", evidenceIds: ["ev-1"] }],
    ["request_help", { kind: "clarification", question: "which option?" }],
  ] as const;
  for (const [name, params] of calls) {
    const data = envelope(await bridge.callTool(name, params, runCtx()));
    assert.deepEqual(
      Object.keys(data).sort(),
      ["blockers", "data", "nextSteps", "pending", "pendingReason", "runId", "stateVersion", "status"],
      `${name} must return exactly the protocol ToolEnvelope`,
    );
    assert.equal(typeof data["status"], "string", `${name} must return a status`);
    // The defining property: a tool never reports a commit. It reports what it durably asked
    // for, and the Core decides later.
    assert.notEqual(data["status"], "COMMITTED", `${name} must not claim a synchronous commit`);
  }
});

// ---------------------------------------------------------------------------
 // Claim, epoch, fencing
// ---------------------------------------------------------------------------

 test("CLAIM: reading the contract without adopting claims nothing and says what to do next", async () => {
  const bridge = track(await withWorkUnit());
  const result = await bridge.callTool("current", {}, runCtx());
  assert.equal(result.error, undefined);
  const data = envelope(result);
  assert.equal(data["status"], "UNCLAIMED");
  assert.equal(data["pending"], true);
  assert.equal(data["pendingReason"], "no_claim");
  assert.deepEqual(data["nextSteps"], ["Re-run with adopt: true to claim this attempt."]);
  // The contract itself is readable, so the agent knows what it is being asked to do.
  const payload = data["data"] as Record<string, unknown>;
  assert.equal(payload["contractHash"], "sha256:contract-1");
  assert.deepEqual(payload["permittedActions"], contract().permittedActions);
  // Reading is not claiming: the Core saw no claim request at all.
  assert.equal(bridge.runtime.requestsTo("POST", "/claims").length, 0);
});

 test("CLAIM: adopting claims the attempt, advances the epoch, and records the claim durably", async () => {
  const bridge = track(await withWorkUnit());
  const data = envelope(await bridge.callTool("current", { adopt: true }, runCtx()));
  assert.equal(data["status"], "CLAIMED");
  assert.equal(claimOf(data)["leaseEpoch"], 1);
  assert.equal(claimOf(data)["previousLeaseEpoch"], 0);
  assert.equal(claimOf(data)["invalidatesPreviousAttempt"], true);
  // The Core actually received the next-epoch fence: epoch 1 requested and granted.
  const claims = bridge.runtime.claims;
  assert.equal(claims.length, 1);
  assert.equal(claims[0]?.["presentedLeaseEpoch"], 1);
  assert.equal(claims[0]?.["grantedEpoch"], 1);
  assert.equal(claims[0]?.["granted"], true);
  assert.equal(claims[0]?.["agentSubject"], `agent:paperclip/${AGENT_ID}`);
  // And the bridge can rebuild the claim after a restart from its own store.
  const stored = bridge.store.getBinding(COMPANY_A, register.CLAIM_BINDING_KIND, "run-1:n1:0");
  assert.ok(stored, "the claim must be durable, not just in memory");
  const payload = JSON.parse(stored.payloadJson) as Record<string, unknown>;
  assert.equal(payload["leaseEpoch"], 1);
  assert.equal(payload["agentRunId"], AGENT_RUN);
});

 test("CLAIM: the same agent run re-entering gets its own claim back, not a second epoch", async () => {
  const bridge = track(await withWorkUnit());
  await bridge.callTool("current", { adopt: true }, runCtx());
  // A second adopt by the same agent run is ordinary, not adversarial. It must not burn an epoch:
  // the bump invalidates the previous attempt, so the bridge would be invalidating its own live
  // claim and telling the agent the attempt it is using has been superseded.
  const data = envelope(await bridge.callTool("current", { adopt: true }, runCtx()));
  assert.equal(data["status"], "CLAIMED");
  assert.equal(claimOf(data)["leaseEpoch"], 1, "re-entry must not burn an epoch");
  assert.equal(claimOf(data)["alreadyHeld"], true);
  assert.equal(claimOf(data)["invalidatesPreviousAttempt"], false);
  assert.equal(bridge.runtime.claims.length, 1, "exactly one claim ever reached the Core");
  // A write under the re-entered claim still works, so the short-circuit did not strand it.
  const evidence = await bridge.callTool(
    "submit_evidence",
    { nodeId: "n1", evidence: [{ kind: "test_report", contentHash: "sha256:r" }] },
    runCtx(),
  );
  assert.equal(envelope(evidence)["status"], "PENDING");
});

test("AT-28: lease expiry alone does not admit a second owner while the old agent run is live", async () => {
  const bridge = track(await withWorkUnit());
  await bridge.callTool("current", { adopt: true }, runCtx());
  const leaseAge = bridge.runtime.leaseTtlMs + 1;
  bridge.runtime.advanceClock(leaseAge);
  bridge.advanceClock(leaseAge);
  const held = bridge.runtime.leases.get("run-1|n1|0");
  assert.ok(held && held.expiresAtMs <= bridge.runtime.nowMs(), "the Core lease must actually be expired");
  // The provider confirms that the previous agent run is still active. A live host run must
  // produce UNKNOWN and stop before the Runtime claim call, even though the Core lease expired.
  bridge.harness.seed({
    issues: [issue("root-1", COMPANY_A, PROJECT_A, {
      activeRun: { id: AGENT_RUN, status: "running", agentId: AGENT_ID },
    })],
  });
  // A stale duplicate dispatch of the same node to a different agent run: it has a work unit of
  // its own, so the scope check passes and the lease is what must stop it.
  dispatchIntruder(bridge);
  const data = envelope(await bridge.callTool("current", { adopt: true }, intruderCtx()));
  // The provider stop check is unknown, so adoption fails before Core mutation.
  assert.notEqual(data["status"], "CLAIMED");
  assert.ok(
    ["CLAIM_REFUSED", "LEASE_FENCED", "PENDING", "LEASE_NOT_FENCED"].includes(String(data["status"])),
    `unexpected status ${String(data["status"])}`,
  );
  const blockers = data["blockers"] as Record<string, unknown>[];
  assert.equal(blockers[0]?.["reason"], "BLOCKED_LEASE_FENCED");
  assert.equal(bridge.runtime.claims.length, 1, "only the first agent's initial claim may reach Core");
  // The live lease still belongs to the first agent run.
  assert.equal(bridge.runtime.leases.get("run-1|n1|0")?.agentRunId, AGENT_RUN);
});

test("CLAIM: a host-confirmed stop permits takeover and advances the epoch", async () => {
  const bridge = track(await withWorkUnit());
  await bridge.callTool("current", { adopt: true }, runCtx());
  dispatchIntruder(bridge);
  // A lease may still be live; the host observation that no run remains is what permits takeover.
  const data = envelope(await bridge.callTool("current", { adopt: true }, intruderCtx()));
  assert.equal(data["status"], "CLAIMED");
  // Takeover is not a silent overwrite: the epoch moves, so the old attempt is fenced.
  assert.equal(claimOf(data)["leaseEpoch"], 2);
  assert.equal(claimOf(data)["previousLeaseEpoch"], 1);
  assert.equal(claimOf(data)["invalidatesPreviousAttempt"], true);
  const takeover = bridge.runtime.claims.at(-1);
  assert.equal(takeover?.["leaseEpoch"], 2, "the bridge presents the next epoch expected by Core");
  assert.equal(takeover?.["priorWorkerState"], "stopped");
  assert.equal(takeover?.["submittedAttemptId"], undefined, "Core must allocate a fresh attempt id");
  assert.notEqual(takeover?.["attemptId"], "attempt-1");
  // And the first agent run is now fenced on its own next write.
  const fenced = await bridge.callTool(
    "submit_evidence",
    { nodeId: "n1", evidence: [{ kind: "test_report", contentHash: "sha256:r" }] },
    runCtx(),
  );
  const blockers = envelope(fenced)["blockers"] as Record<string, unknown>[];
  assert.equal(blockers[0]?.["reason"], "BLOCKED_LEASE_FENCED");
});

 test("CLAIM: a write from a fenced agent run is refused even though it knows the run id", async () => {
  const bridge = track(await withWorkUnit());
  await bridge.callTool("current", { adopt: true }, runCtx());
  dispatchIntruder(bridge);
  const result = await bridge.callTool(
    "submit_evidence",
    { nodeId: "n1", runId: "run-1", evidence: [{ kind: "test_report", contentHash: "sha256:report" }] },
    intruderCtx(),
  );
  // The intruder is not the claim holder, so its write is fenced rather than applied.
  assert.equal(result.error !== undefined, true);
  const blockers = envelope(result)["blockers"] as Record<string, unknown>[];
  assert.equal(blockers[0]?.["reason"], "BLOCKED_LEASE_FENCED");
  assert.ok((bridge.counters()["staleLeaseRejected"] as number) >= 1);
  // Nothing reached the Core: a fenced write leaves no request and no durable intent.
  assert.equal(bridge.runtime.requestsTo("POST", "/evidence").length, 0);
  assert.equal(bridge.store.countDeliveries(COMPANY_A, "pending"), 0);
});

 test("CLAIM: an unbound agent run cannot call any side-effecting tool", async () => {
  const bridge = track(await withWorkUnit());
  for (const [name, params] of [
    ["submit_artifact", { nodeId: "n1", artifacts: [{ kind: "code_diff", contentHash: "sha256:x" }] }],
    ["submit_evidence", { nodeId: "n1", evidence: [{ kind: "test_report", contentHash: "sha256:x" }] }],
    ["request_transition", { nodeId: "n1", evidenceIds: ["ev-1"] }],
    ["request_help", { kind: "clarification", question: "which option?" }],
  ] as const) {
    const data = envelope(await bridge.callTool(name, params, runCtx({ runId: "agent-run-unbound" })));
    assert.equal(data["status"], "UNBOUND", `${name} must refuse an unbound run`);
    const blockers = data["blockers"] as Record<string, unknown>[];
    assert.equal(blockers[0]?.["reason"], "BLOCKED_SCOPE");
  }
  assert.ok((bridge.counters()["crossScopeDenials"] as number) >= 4);
  assert.equal(bridge.store.countDeliveries(COMPANY_A, "pending"), 0);
});

 test("CLAIM: a tool call naming a run this agent run is not bound to is a scope violation", async () => {
  const bridge = track(await withWorkUnit());
  bridge.runtime.seedRun("run-other", { scope: { companyRef: COMPANY_A, projectRef: PROJECT_A } });
  const data = envelope(
    await bridge.callTool("current", { runId: "run-other" }, runCtx()),
  );
  assert.equal(data["status"], "SCOPE_VIOLATION");
  const blockers = data["blockers"] as Record<string, unknown>[];
  assert.equal(blockers[0]?.["code"], "BRIDGE_SCOPE_VIOLATION");
  // The Core was never asked about a run the agent has no claim on.
  assert.equal(bridge.runtime.requestsTo("GET", "/runs/run-other").length, 0);
});

 test("CLAIM: a claim for a company with no work unit is refused before the Core is asked", async () => {
  const bridge = track(
    await buildBridge({
      extraCompanyIds: ["company-b"],
      seed: {
        companies: [company(COMPANY_A), company("company-b")],
        projects: [project(PROJECT_A, COMPANY_A)],
        issues: [issue("root-1", COMPANY_A, PROJECT_A)],
      },
    }),
  );
  const data = envelope(
    await bridge.callTool("current", { adopt: true }, runCtx({ companyId: "company-b", runId: "agent-run-b" })),
  );
  assert.equal(data["status"], "UNBOUND");
  // Nothing leaked across the tenant boundary: no Runtime call of any kind.
  assert.equal(bridge.runtime.requests.length, 0);
});

 test("CLAIM: a claim the Core grants without advancing the epoch is refused", async () => {
  // The Core is the only authority on epochs. If a claim comes back with the old epoch the old
  // attempt is still live, so the bridge must not proceed on the belief that it fenced anything.
  const bridge = track(await withWorkUnit());
  bridge.runtime.route(({ request, server }) => {
    if (request.method === "POST" && request.path.endsWith("/claims")) {
      server.claims.push({ granted: true, grantedEpoch: 0 });
      return {
        status: 202,
        body: {
          commandId: "cmd-bad",
          applied: true,
          stateVersion: 8,
          status: "CLAIMED",
          pending: false,
          leaseEpoch: 0,
          attemptId: "attempt-1",
        },
      };
    }
    return null;
  });
  const data = envelope(await bridge.callTool("current", { adopt: true }, runCtx()));
  assert.equal(data["status"], "LEASE_NOT_FENCED");
  const blockers = data["blockers"] as Record<string, unknown>[];
  assert.equal(blockers[0]?.["code"], "BRIDGE_LEASE_FENCED");
  assert.ok((bridge.counters()["staleLeaseRejected"] as number) >= 1);
  // No claim was recorded locally either, so a later call cannot mistake this for a live claim.
  assert.equal(bridge.store.getBinding(COMPANY_A, register.CLAIM_BINDING_KIND, "run-1:n1:0"), null);
});

 test("CLAIM: adoption is refused when the previous owner's stop cannot be confirmed", async () => {
  // The realistic shape: the previous owner is a dispatched agent run whose issue still has a
  // live run. The host baseline exposes no execution-stop API to plugins, so the stop cannot be
  // confirmed, and "cannot confirm" must block adoption rather than be read as "it is fine".
  const bridge = track(
    await buildBridge({
      seed: {
        companies: [company(COMPANY_A)],
        projects: [project(PROJECT_A, COMPANY_A)],
        issues: [
          {
            ...issue("root-1", COMPANY_A, PROJECT_A),
            activeRun: { id: "agent-run-old", status: "running", agentId: "agent-old" },
          } as never,
        ],
      },
      configureRuntime: (runtime) => {
        runtime.seedRun("run-1", {
          scope: { companyRef: COMPANY_A, projectRef: PROJECT_A },
          graphId: GRAPH_ID,
          entrypoint: ENTRYPOINT,
          startIntentId: "intent-1",
        });
        runtime.contracts.set("run-1", contract({ previousOwnerAgentRunId: "agent-run-old" }));
      },
    }),
  );
  // The run binding, so a run-scoped call has a project to be signed with. This test builds its own
  // bridge rather than using `withWorkUnit`, so the binding has to be recorded here too.
  bridge.store.putBinding({
    companyId: COMPANY_A,
    kind: "run",
    providerId: "run-1",
    projectId: PROJECT_A,
    payload: { runId: "run-1", projectId: PROJECT_A, rootIssueId: "root-1" },
  });
  // The bridge knows the old agent run is on `root-1` because it dispatched it.
  bridge.store.putBinding({
    companyId: COMPANY_A,
    kind: "dispatch",
    providerId: "agent-run-old",
    projectId: PROJECT_A,
    payload: { agentRunRefId: "agent-run-old", issueId: "root-1", runId: "run-old" },
  });
  // And this agent run is bound to a node, so the refusal is about the stop, not the binding.
  bridge.store.putBinding({
    companyId: COMPANY_A,
    kind: WORK_UNIT_BINDING_KIND,
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

  const data = envelope(await bridge.callTool("current", { adopt: true }, runCtx()));
  assert.equal(data["status"], "PENDING");
  assert.equal(data["pending"], true);
  assert.equal(data["pendingReason"], "previous_owner_stop_unconfirmed");
  assert.deepEqual(data["nextSteps"], ["Wait for reconciliation; do not retry the side effect."]);
  assert.equal(bridge.runtime.claims.length, 0, "no claim may be attempted after an unconfirmed stop");
  // The gap is counted rather than inferred from silence, and the manifest is not quietly widened.
  assert.ok((bridge.counters()["platformBlocks"] as number) >= 1);
  assert.equal(
    h.manifest.capabilities.includes("agent.sessions.stop"),
    false,
    "the manifest must not gain a stop capability to make this test pass",
  );
});

test("AT-28: a terminal Issue with a still-running activeRun cannot be adopted", async () => {
  const bridge = track(await withWorkUnit({ current: { previousOwnerAgentRunId: "agent-run-old" } }));
  bridge.store.putBinding({
    companyId: COMPANY_A,
    kind: "dispatch",
    providerId: "agent-run-old",
    projectId: PROJECT_A,
    payload: { agentRunRefId: "agent-run-old", issueId: "root-1", runId: "run-previous" },
  });
  // Board status and process state are separate facts: someone can mark the Issue done while the
  // host still says its heartbeat is running. The live execution must win for takeover safety.
  bridge.harness.seed({
    issues: [
      issue("root-1", COMPANY_A, PROJECT_A, {
        status: "done",
        activeRun: { id: "agent-run-old", status: "running", agentId: "agent-old" },
      } as never),
    ],
  });

  const data = envelope(await bridge.callTool("current", { adopt: true }, runCtx()));
  assert.equal(data["status"], "PENDING");
  assert.equal(data["pendingReason"], "previous_owner_stop_unconfirmed");
  assert.equal(bridge.runtime.claims.length, 0, "no new lease may be claimed while the old heartbeat runs");
  assert.ok((bridge.counters()["platformBlocks"] as number) >= 1);
});

 test("CLAIM: a node the Core reports as not claimable cannot be claimed", async () => {
  const bridge = track(await withWorkUnit({ current: { claimable: false } }));
  const data = envelope(await bridge.callTool("current", { adopt: true }, runCtx()));
  assert.equal(data["status"], "NOT_CLAIMABLE");
  const blockers = data["blockers"] as Record<string, unknown>[];
  assert.equal(blockers[0]?.["reason"], "BLOCKED_LEASE_FENCED");
  assert.equal(bridge.runtime.claims.length, 0);
});

// ---------------------------------------------------------------------------
 // REQ-TOOL-05: tools return fast, with a durable pending result
// ---------------------------------------------------------------------------

 test("TOOL: a submitted evidence candidate is pending, and the producer is derived not asserted", async () => {
  const bridge = track(await withWorkUnit());
  await bridge.callTool("current", { adopt: true }, runCtx());
  const data = envelope(
    await bridge.callTool(
      "submit_evidence",
      {
        nodeId: "n1",
        evidence: [
          {
            kind: "test_report",
            contentHash: "sha256:report",
            // A worker trying to claim authorship of someone else's work, or to pass its own.
            producerSubject: "agent:paperclip/agent-9",
            valid: true,
          },
        ],
      },
      runCtx(),
    ),
  );
  assert.equal(data["status"], "PENDING");
  assert.equal(data["pending"], true);
  // The request went straight to the Core and came back pending; nothing was committed.
  const evidence = bridge.runtime.requestsTo("POST", "/evidence");
  assert.equal(evidence.length, 1);
  const body = JSON.parse(evidence[0]!.bodyText) as Record<string, unknown>;
  const submitted = (body["payload"] as Record<string, unknown>)["evidence"] as Record<string, unknown>[];
  assert.equal(submitted[0]?.["producerSubject"], `agent:paperclip/${AGENT_ID}`);
  assert.equal(submitted[0]?.["kind"], "test_report");
  // No `valid: true` travelled: validity is the Core's to decide, not the worker's claim.
  assert.equal(JSON.stringify(body).includes('"valid":true'), false);
  // And nothing transitioned: a candidate is not a pass.
  assert.equal(bridge.runtime.requestsTo("POST", "/transitions").length, 0);
  assert.equal(evidence[0]?.signatureValid, true);
});

 test("TOOL: an artifact whose declared digest does not match the host bytes is refused", async () => {
  const bridge = track(await withWorkUnit());
  await bridge.callTool("current", { adopt: true }, runCtx());
  const data = envelope(
    await bridge.callTool(
      "submit_artifact",
      {
        nodeId: "n1",
        artifacts: [
          {
            kind: "code_diff",
            source: { ref: { provider: "paperclip", kind: "document", id: "doc-1" } },
            contentHash: "sha256:definitely-not-the-real-digest",
          },
        ],
      },
      runCtx(),
    ),
  );
  // The declared digest is a claim; the bridge hashes what the host actually holds.
  assert.ok(
    ["BAD_REQUEST", "HASH_MISMATCH", "CONFLICT", "SCOPE_VIOLATION"].includes(String(data["status"])) ||
      data["blockers"].length > 0,
    `an unbacked artifact must not be published, got ${String(data["status"])}`,
  );
  assert.equal(bridge.runtime.requestsTo("POST", "/artifacts").length, 0);
});

test("TOOL: a verified document artifact carries its source revision and immutable snapshot to Core", async () => {
  const bridge = track(await withWorkUnit());
  const sourceBody = "verified tool artifact\n";
  const sourceDocument = await bridge.ctx.issues.documents.upsert({
    issueId: "root-1",
    key: "spec",
    companyId: COMPANY_A,
    body: sourceBody,
    changeSummary: "seed artifact source",
  });
  const contentHash = `sha256:${createHash("sha256").update(sourceBody, "utf8").digest("hex")}`;

  await bridge.callTool("current", { adopt: true }, runCtx());
  const result = envelope(
    await bridge.callTool(
      "submit_artifact",
      {
        nodeId: "n1",
        artifacts: [
          {
            kind: "code_diff",
            contentHash,
            mediaType: "text/markdown",
            size: sourceBody.length,
            source: { kind: "document", ref: "spec" },
          },
        ],
      },
      runCtx(),
    ),
  );

  assert.equal(result["status"], "PENDING");
  const artifacts = bridge.runtime.requestsTo("POST", "/artifacts");
  assert.equal(artifacts.length, 1);
  const request = artifacts[0]!;
  assert.equal(request.signatureValid, true);
  const body = JSON.parse(request.bodyText) as Record<string, unknown>;
  const payload = body["payload"] as Record<string, unknown>;
  const submitted = (payload["artifacts"] as Record<string, unknown>[])[0]!;
  assert.equal(submitted["contentHash"], contentHash);
  assert.deepEqual(submitted["source"], {
    kind: "document",
    ref: "issue:root-1/spec",
    revision: sourceDocument.latestRevisionId,
  });
  const providerRef = submitted["providerRef"] as Record<string, unknown>;
  assert.equal(providerRef["kind"], "issue_document_revision");
  assert.match(String(providerRef["id"]), /^polyforge\/artifact-/);
});

 test("TOOL: a transition request without a claim is refused with a recovery hint", async () => {
  const bridge = track(await withWorkUnit());
  const data = envelope(await bridge.callTool("request_transition", { nodeId: "n1", evidenceIds: ["ev-1"] }, runCtx()));
  assert.equal(data["status"], "NO_CLAIM");
  assert.deepEqual(data["nextSteps"], ["polyforge.current with adopt: true"]);
  const blockers = data["blockers"] as Record<string, unknown>[];
  assert.equal(blockers[0]?.["code"], "BRIDGE_CLAIM_REQUIRED");
  // The bridge cannot pass a node anyway: it asks the Core to evaluate.
  assert.equal(bridge.runtime.requestsTo("POST", "/transitions").length, 0);
});

 test("TOOL: a transition request names the evidence it wants judged, and nothing else", async () => {
  const bridge = track(await withWorkUnit());
  await bridge.callTool("current", { adopt: true }, runCtx());
  const result = await bridge.callTool(
    "request_transition",
    {
      nodeId: "n1",
      evidenceIds: ["ev-1", "ev-2"],
      // A worker asserting the outcome it wants, and an approval to get it.
      outcome: "PASS",
      approved: true,
      approvalId: "ap-1",
    },
    runCtx(),
  );
  const data = envelope(result);
  assert.equal(data["status"], "PENDING");
  const transitions = bridge.runtime.requestsTo("POST", "/transitions");
  assert.equal(transitions.length, 1);
  const body = JSON.parse(transitions[0]!.bodyText) as Record<string, unknown>;
  const payload = body["payload"] as Record<string, unknown>;
  assert.deepEqual(payload["evidenceIds"], ["ev-1", "ev-2"]);
  // The outcome is the Core's, the approval is the human's, and neither came from the parameters.
  assert.equal("outcome" in payload, false);
  assert.equal(JSON.stringify(body).includes('"approved"'), false);
  assert.equal(JSON.stringify(body).includes("ap-1"), false);
  // Optimistic concurrency: the epoch and state version the agent was working against.
  assert.equal(body["leaseEpoch"], 1);
  assert.equal(body["expectedStateVersion"], 7);
  assert.equal(body["attemptId"], "attempt-1");
  // The transport actor is the bridge itself: the bridge is the caller, and it does not get to
  // speak as the agent. The delegated agent run travels as `causationId` *inside the hashed
  // body*, so it is authenticated by the signature even though it is not the transport identity.
  assert.equal(body["causationId"], AGENT_RUN);
  const canonical = transitions[0]?.canonicalRequest ?? "";
  assert.match(canonical, /"actorId":"paperclip:bridge","actorType":"system"/);
  assert.match(canonical, /"bodyHash":"sha256:[0-9a-f]{64}"/);
  assert.equal(transitions[0]?.signatureValid, true);
});

 test("TOOL: status is a read of the Core and needs no claim", async () => {
  const bridge = track(await withWorkUnit());
  const data = envelope(await bridge.callTool("status", {}, runCtx()));
  assert.equal(data["status"], "ACTIVE", "the run's own status, never a node verdict");
  const snapshot = data["data"] as Record<string, unknown>;
  assert.equal(data["runId"], "run-1");
  assert.equal(snapshot["authoritativeStatusSource"], "polyforge-core");
  assert.equal(snapshot["mutatedByThisCall"], false);
  assert.equal(snapshot["assertedPass"], false);
  assert.deepEqual(snapshot["pins"], { startIntentId: "intent-1", graph: `${GRAPH_ID}@1` });
  // No claim was needed, and none was taken.
  assert.equal(bridge.runtime.requestsTo("POST", "/claims").length, 0);
  assert.ok(bridge.runtime.requestsTo("GET", "/runs/run-1").length >= 1);
});

 test("TOOL: help is a pending intent that implies no approval and waits on nothing", async () => {
  const bridge = track(await withWorkUnit());
  await bridge.callTool("current", { adopt: true }, runCtx());
  const data = envelope(
    await bridge.callTool(
      "request_help",
      { kind: "human_handling", question: "which option should I take?", options: ["a", "b"] },
      runCtx(),
    ),
  );
  assert.equal(data["status"], "PENDING");
  // Asking for help is not an approval, and it does not park a tool call on a human.
  assert.equal(data["pending"], true);
  assert.equal(bridge.runtime.requestsTo("POST", "/approvals").length, 0);
  assert.equal(bridge.runtime.requestsTo("POST", "/interactions").length, 0);
});

 test("TOOL: a help kind outside the vocabulary is refused rather than coerced", async () => {
  const bridge = track(await withWorkUnit());
  await bridge.callTool("current", { adopt: true }, runCtx());
  const data = envelope(
    await bridge.callTool("request_help", { kind: "escalate_to_manager", question: "q" }, runCtx()),
  );
  assert.equal(data["status"], "BAD_REQUEST");
  const blockers = data["blockers"] as Record<string, unknown>[];
  assert.match(String(blockers[0]?.["message"]), /clarification, review, human_handling/);
});
