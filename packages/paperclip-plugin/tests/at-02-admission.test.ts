/**
 * AT-02 — admission is explicit, and a replayed start intent is one run.
 * (docs/03 §10, AT-02: "同一 Root Issue 重放 100 次相同 start intent，只创建 1 run；普通 Issue 创建 0 run")
 *
 * What is proved here is the *bridge* half: the durable inbox dedupes, the admission gate
 * refuses an ordinary issue, the start intent is stable, and the bridge enqueues exactly one
 * work-order intent. The "exactly 1 run" half is the Core's `startIntentId` idempotency, which
 * the fake Runtime reproduces faithfully — so a harness pass is evidence about the bridge plus a
 * modelled Core, not about a real Core.
 */

import "./helpers/bootstrap.ts";
import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { load } from "./helpers/bootstrap.ts";

const h = await load<typeof import("./helpers/harness.ts")>(new URL("./helpers/harness.ts", import.meta.url));
const admission = await load<typeof import("../src/admission.ts")>(new URL("../src/admission.ts", import.meta.url));

const { COMPANY_A, PROJECT_A, GRAPH_ID, ENTRYPOINT, buildBridge, company, project, issue, label, workspace, hostEvent } = h;
const bridges: { dispose(): void }[] = [];

after(async () => {
  for (const bridge of bridges) await bridge.dispose();
});

function track<T extends { dispose(): Promise<void> }>(bridge: T): T {
  bridges.push(bridge);
  return bridge;
}

const engineeringLabel = label("engineering");

async function seed() {
  return buildBridge({
    seed: {
      companies: [company(COMPANY_A)],
      projects: [project(PROJECT_A, COMPANY_A)],
      issues: [
        issue("root-1", COMPANY_A, PROJECT_A, {
          labels: [engineeringLabel],
          originKind: undefined,
        }),
        issue("plain-1", COMPANY_A, PROJECT_A, { labels: [] }),
        issue("other-project", COMPANY_A, "project-unknown", { labels: [engineeringLabel] }),
      ],
    },
  });
}

test("AT-02: an ordinary issue starts no graph at all", async () => {
  const bridge = track(await seed());
  const plain = bridge.harness.ctx.issues;
  const issueList = await plain.list({ companyId: COMPANY_A });
  const plainIssue = issueList.find((entry) => entry.id === "plain-1");
  assert.ok(plainIssue, "the seeded plain issue must be visible");

  const decision = bridge.company.admission.evaluate(plainIssue, "user-1");
  assert.equal(decision.admit, false);
  assert.match(decision.reason, /no configured engineering-entry trigger/);

  // And no intent is enqueued for it, even after a full event round trip.
  await bridge.eventPump.handle(
    hostEvent("issue.assignment_wakeup_requested", "evt-plain-1", { issueId: "plain-1", agentId: "agent-1" }),
  );
  await bridge.drain();
  assert.equal(bridge.runtime.requestsTo("POST", "/v1/work-orders").length, 0);
});

test("AT-02: the engineering label admits, and the project comes from the issue relation", async () => {
  const bridge = track(await seed());
  const issueList = await bridge.harness.ctx.issues.list({ companyId: COMPANY_A });
  const root = issueList.find((entry) => entry.id === "root-1");
  assert.ok(root);

  const decision = bridge.company.admission.evaluate(root, "user-1");
  assert.equal(decision.admit, true);
  if (!decision.admit) return;
  assert.equal(decision.trigger, "entry_label");
  assert.equal(decision.graphId, GRAPH_ID);
  // A label trigger names the graph, not an entrypoint; the Router resolves the entrypoint from
  // the Core's own graph definition rather than guessing one.
  assert.equal(decision.entrypoint, "");
  assert.equal(decision.scope.companyRef, COMPANY_A);
  // The project half of the scope is the issue's own project, never a caller-supplied value.
  assert.equal(decision.scope.projectRef, root.projectId);
  assert.equal(decision.projectId, PROJECT_A);
  assert.equal(decision.rootIssueId, "root-1");

  const resolved = await bridge.company.router.resolveEntrypoint(COMPANY_A, GRAPH_ID, "");
  assert.equal(resolved, ENTRYPOINT);
});

test("AT-02: 100 replays of one start intent produce one work-order request and one run", async () => {
  const bridge = track(await seed());
  const issueList = await bridge.harness.ctx.issues.list({ companyId: COMPANY_A });
  const root = issueList.find((entry) => entry.id === "root-1");
  assert.ok(root);
  const decision = bridge.company.admission.evaluate(root, "user-1");
  assert.equal(decision.admit, true);
  if (!decision.admit) return;

  const human = {
    actorType: "human" as const,
    actorId: "user-1",
    agentId: null,
    runId: null,
    roles: [],
  };

  const enqueued: boolean[] = [];
  for (let replay = 0; replay < 100; replay += 1) {
    const outcome = await bridge.company.router.considerIssue(decision, human, "corr-1");
    assert.ok(outcome);
    enqueued.push(outcome.enqueued);
  }
  // Exactly one of the hundred enqueues created the intent; the other ninety-nine found it.
  assert.equal(enqueued.filter(Boolean).length, 1, "only the first replay may enqueue");
  assert.equal(bridge.store.countDeliveries(COMPANY_A, "pending") >= 1, true);

  // The same event delivered a hundred times is also deduped by the inbox, before admission.
  const event = hostEvent("issue.assignment_wakeup_requested", "evt-root-1", {
    issueId: "root-1",
    agentId: "agent-1",
  });
  for (let replay = 0; replay < 100; replay += 1) {
    const outcome = await bridge.eventPump.handle(event);
    if (replay === 0) assert.equal(outcome.duplicate, false);
    else assert.equal(outcome.duplicate, true, `replay ${replay} must be suppressed`);
  }
  assert.equal(bridge.counters()["inboxDuplicates"], 99);

  await bridge.drain();
  await bridge.drain();

  const workOrderRequests = bridge.runtime.requestsTo("POST", "/v1/work-orders");
  assert.equal(workOrderRequests.length, 1, "one durable intent means one create request");
  assert.equal(bridge.runtime.runs.size, 1, "the Core must return one run for one start intent");
  assert.equal(bridge.runtime.runIdByStartIntent.size, 1);

  // The signed request carried the scope in the header, never the body.
  const signed = workOrderRequests[0];
  assert.ok(signed);
  assert.equal(signed.signatureValid, true);
  const scopeHeader = signed.headers["x-pf-scope"];
  assert.ok(scopeHeader);
  assert.deepEqual(JSON.parse(Buffer.from(scopeHeader, "base64url").toString("utf8")), {
    companyRef: COMPANY_A,
    projectRef: PROJECT_A,
  });
  const workOrderBody = JSON.parse(signed.bodyText) as Record<string, unknown>;
  assert.deepEqual(workOrderBody["policyRules"], [
    {
      ruleId: `paperclip-admission:${decision.startIntentId}`,
      effect: "allow",
      projectRef: PROJECT_A,
      workflowRef: GRAPH_ID,
      transitionRef: `${GRAPH_ID}.${ENTRYPOINT}`,
      actions: ["work_order.admit"],
      resources: ["root-1"],
      environments: ["production"],
      reason: "a board user explicitly admitted this Paperclip issue into the named graph entrypoint",
    },
  ]);
});

test("AT-02: node execution policy is pinned only for Runtime-approved project capability subjects", async () => {
  const bridge = track(await seed());
  const graph = bridge.runtime.graphs.get(GRAPH_ID);
  assert.ok(graph);
  bridge.runtime.graphs.set(GRAPH_ID, {
    ...graph,
    nodePolicies: [
      { nodeId: "clarify", requiredCapabilities: ["requirement.clarify"], eligibleSubjects: ["agent:paperclip/producer"] },
      { nodeId: "review", requiredCapabilities: ["requirement.review"], eligibleSubjects: [] },
    ],
  });
  const root = (await bridge.harness.ctx.issues.list({ companyId: COMPANY_A })).find((entry) => entry.id === "root-1");
  assert.ok(root);
  const decision = bridge.company.admission.evaluate(root, "user-1");
  assert.equal(decision.admit, true);
  if (!decision.admit) return;
  await bridge.company.router.considerIssue(decision, {
    actorType: "human",
    actorId: "user-1",
    agentId: null,
    runId: null,
    roles: [],
  }, "corr-policy");
  await bridge.drain();

  const request = bridge.runtime.requestsTo("POST", "/v1/work-orders")[0];
  assert.ok(request);
  const policyRules = JSON.parse(request.bodyText)["policyRules"] as Record<string, unknown>[];
  assert.equal(policyRules.length, 2, "the reviewer without a scoped Runtime capability grant gets no execution allow");
  assert.deepEqual(policyRules[1], {
    ruleId: `paperclip-capability:${GRAPH_ID}:clarify:agent:paperclip/producer`,
    effect: "allow",
    agentRef: "agent:paperclip/producer",
    projectRef: PROJECT_A,
    workflowRef: GRAPH_ID,
    transitionRef: `${GRAPH_ID}.clarify`,
    actions: ["node.clarify.execute"],
    resources: ["clarify"],
    environments: ["production"],
    requiredCapabilities: ["requirement.clarify"],
    version: "1",
    reason: "the project-scoped Paperclip capability binding grants requirement.clarify to this subject",
  });
});

test("AT-02: the start intent id is stable for the same issue, graph and entrypoint", async () => {
  const scope = { companyRef: COMPANY_A, projectRef: PROJECT_A };
  const first = admission.deriveStartIntentId(scope, "root-1", GRAPH_ID, ENTRYPOINT, null);
  const second = admission.deriveStartIntentId(scope, "root-1", GRAPH_ID, ENTRYPOINT, null);
  assert.equal(first, second);
  // A different graph or entrypoint is a different intent: a genuinely new run needs a new ask.
  assert.notEqual(first, admission.deriveStartIntentId(scope, "root-1", "other-graph", ENTRYPOINT, null));
  assert.notEqual(first, admission.deriveStartIntentId(scope, "root-2", GRAPH_ID, ENTRYPOINT, null));
  // And it is scoped, so two tenants cannot collide on the same ids.
  assert.notEqual(
    first,
    admission.deriveStartIntentId({ companyRef: "company-b", projectRef: PROJECT_A }, "root-1", GRAPH_ID, ENTRYPOINT, null),
  );
});

test("AT-02: an edited work-order intent block is a new intent, so a new run is a deliberate act", async () => {
  const scope = { companyRef: COMPANY_A, projectRef: PROJECT_A };
  const blockA = {
    graphId: GRAPH_ID,
    entrypoint: ENTRYPOINT,
    inputSnapshot: { a: 1 },
    workspaceRequirement: null,
    requiredFactSources: {},
    startIntentId: null,
    rejectedFields: [] as string[],
  };
  const blockB = { ...blockA, inputSnapshot: { a: 2 } };
  assert.notEqual(
    admission.deriveStartIntentId(scope, "root-1", GRAPH_ID, ENTRYPOINT, blockA),
    admission.deriveStartIntentId(scope, "root-1", GRAPH_ID, ENTRYPOINT, blockB),
  );
  // The same block replayed is the same intent.
  assert.equal(
    admission.deriveStartIntentId(scope, "root-1", GRAPH_ID, ENTRYPOINT, blockA),
    admission.deriveStartIntentId(scope, "root-1", GRAPH_ID, ENTRYPOINT, blockA),
  );
  assert.notEqual(
    admission.deriveStartIntentId(scope, "root-1", GRAPH_ID, ENTRYPOINT, {
      ...blockA,
      requiredFactSources: { design_acceptance: { sourceRunId: "run-design-a" } },
    }),
    admission.deriveStartIntentId(scope, "root-1", GRAPH_ID, ENTRYPOINT, {
      ...blockA,
      requiredFactSources: { design_acceptance: { sourceRunId: "run-design-b" } },
    }),
  );
});

test("AT-02: a code work-order carries one exact repository commit pin", async () => {
  const bridge = track(await seed());
  const commit = "a".repeat(40);
  const requirement = {
    mode: "read_write" as const,
    repositories: [{ repoRef: "https://example.invalid/repo.git", baseRef: "refs/heads/main", commit }],
    requireReadOnlyForReviewer: false,
  };
  const body = admission.renderWorkOrderIntentBlock({
    graphId: GRAPH_ID,
    entrypoint: ENTRYPOINT,
    workspaceRequirement: requirement,
  });
  const parsed = admission.parseWorkOrderIntent(body, bridge.metrics, COMPANY_A, bridge.company.logger);
  assert.deepEqual(parsed?.workspaceRequirement, requirement);

  const blockA = { graphId: GRAPH_ID, entrypoint: ENTRYPOINT, inputSnapshot: {}, workspaceRequirement: requirement, startIntentId: null, rejectedFields: [] };
  const blockB = { ...blockA, workspaceRequirement: { ...requirement, repositories: [{ ...requirement.repositories[0]!, commit: "b".repeat(40) }] } };
  assert.notEqual(
    admission.deriveStartIntentId({ companyRef: COMPANY_A, projectRef: PROJECT_A }, "root-1", GRAPH_ID, ENTRYPOINT, blockA),
    admission.deriveStartIntentId({ companyRef: COMPANY_A, projectRef: PROJECT_A }, "root-1", GRAPH_ID, ENTRYPOINT, blockB),
  );
});

test("AT-02: malformed repository pins are rejected instead of normalized into a weaker request", async () => {
  const bridge = track(await seed());
  const body = admission.renderWorkOrderIntentBlock({
    graphId: GRAPH_ID,
    entrypoint: ENTRYPOINT,
    workspaceRequirement: {
      mode: "read_write",
      repositories: [{ repoRef: "https://example.invalid/repo.git", baseRef: "refs/heads/main", commit: "abc123" }],
      requireReadOnlyForReviewer: false,
    },
  });
  assert.equal(admission.parseWorkOrderIntent(body, bridge.metrics, COMPANY_A, bridge.company.logger), null);
});

test("AT-02: special object property names cannot poison the prerequisite-source map", async () => {
  const bridge = track(await seed());
  const body = [
    "```polyforge:work-order",
    '{"graphId":"requirements","entrypoint":"design.start","requiredFactSources":{"__proto__":{"sourceRunId":"run-source"}}}',
    "```",
  ].join("\n");
  assert.equal(admission.parseWorkOrderIntent(body, bridge.metrics, COMPANY_A, bridge.company.logger), null);
});

test("AT-02: code work is admitted only with a pin matching the trusted project workspace", async () => {
  const repo = workspace("workspace-a", PROJECT_A, COMPANY_A);
  const bridge = track(await buildBridge({
    seed: {
      companies: [company(COMPANY_A)],
      projects: [project(PROJECT_A, COMPANY_A)],
      projectWorkspaces: [repo],
      issues: [issue("root-code", COMPANY_A, PROJECT_A, { labels: [engineeringLabel] })],
    },
  }));
  const graph = bridge.runtime.graphs.get(GRAPH_ID);
  assert.ok(graph);
  bridge.runtime.graphs.set(GRAPH_ID, {
    ...graph,
    nodePolicies: [{ nodeId: "edit", requiredCapabilities: ["code.modify"], eligibleSubjects: ["agent:paperclip/engineer"] }],
  });
  const requirement = {
    mode: "read_write" as const,
    repositories: [{ repoRef: repo.repoUrl, baseRef: repo.defaultRef, commit: "c".repeat(40) }],
    requireReadOnlyForReviewer: false,
  };
  const requiredFactSources = { design_acceptance: { sourceRunId: "run-design-1" } };
  const body = admission.renderWorkOrderIntentBlock({
    graphId: GRAPH_ID,
    entrypoint: ENTRYPOINT,
    workspaceRequirement: requirement,
    requiredFactSources,
  });
  const root = { ...(await bridge.harness.ctx.issues.get("root-code", COMPANY_A))!, description: body };
  const decision = bridge.company.admission.evaluate(root, "user-1");
  assert.equal(decision.admit, true);
  if (!decision.admit) return;

  await bridge.company.router.considerIssue(decision, {
    actorType: "human", actorId: "user-1", agentId: null, runId: null, roles: [],
  }, "corr-repo-pin");
  await bridge.drain();
  const request = bridge.runtime.requestsTo("POST", "/v1/work-orders")[0];
  assert.ok(request);
  const payload = JSON.parse(request.bodyText) as Record<string, unknown>;
  assert.deepEqual(payload["workspaceRequirement"], requirement);
  assert.deepEqual(payload["requiredFactSources"], requiredFactSources);
});

test("AT-02: a body intent admits, and scope or actor fields inside it are refused", async () => {
  const bridge = track(await seed());
  const body = [
    "A Root Issue that describes engineering work.",
    "",
    "```polyforge:work-order",
    JSON.stringify({
      graphId: GRAPH_ID,
      entrypoint: ENTRYPOINT,
      inputSnapshot: { requirement: "PF-1" },
      // Every one of these is refused and counted.
      companyId: "company-b",
      projectId: "project-b",
      actorUserId: "user-1",
      approved: true,
    }),
    "```",
  ].join("\n");

  const issueList = await bridge.harness.ctx.issues.list({ companyId: COMPANY_A });
  const root = issueList.find((entry) => entry.id === "root-1");
  assert.ok(root);
  const withBody = { ...root, description: body };

  const decision = bridge.company.admission.evaluate(withBody, "user-1");
  assert.equal(decision.admit, true);
  if (!decision.admit) return;
  assert.equal(decision.trigger, "body_intent");
  assert.deepEqual(decision.inputSnapshot, { requirement: "PF-1" });
  // The scope is the host-derived one. A body that named another tenant changed nothing.
  assert.equal(decision.scope.companyRef, COMPANY_A);
  assert.equal(decision.scope.projectRef, PROJECT_A);
  assert.ok((bridge.counters()["crossScopeDenials"] as number) >= 1, "the attempt must be counted");
});

test("AT-02: a malformed intent block refuses admission rather than falling back to a default", async () => {
  const bridge = track(await seed());
  const body = ["```polyforge:work-order", "{ not json", "```"].join("\n");
  const issueList = await bridge.harness.ctx.issues.list({ companyId: COMPANY_A });
  const root = issueList.find((entry) => entry.id === "root-1");
  assert.ok(root);
  // No label, no origin kind: the body is the only trigger, and it is unusable.
  const decision = bridge.company.admission.evaluate({ ...root, labels: [], description: body }, "user-1");
  assert.equal(decision.admit, false);
  assert.match(decision.reason, /no configured engineering-entry trigger/);
});

test("AT-02: an issue with no project is never admitted into a guessed scope", async () => {
  const bridge = track(await seed());
  const issueList = await bridge.harness.ctx.issues.list({ companyId: COMPANY_A });
  const projectless = issueList.find((entry) => entry.id === "other-project");
  assert.ok(projectless);
  const decision = bridge.company.admission.evaluate({ ...projectless, projectId: null }, "user-1");
  assert.equal(decision.admit, false);
  assert.match(decision.reason, /no project/);
});

test("AT-02: an origin kind under the configured prefix is a third trigger", async () => {
  const bridge = track(await seed());
  const issueList = await bridge.harness.ctx.issues.list({ companyId: COMPANY_A });
  const root = issueList.find((entry) => entry.id === "root-1");
  assert.ok(root);
  const decision = bridge.company.admission.evaluate(
    { ...root, labels: [], originKind: "polyforge:root" },
    "user-1",
  );
  assert.equal(decision.admit, true);
  if (!decision.admit) return;
  assert.equal(decision.trigger, "origin_kind");
});

test("AT-02: starting a run requires a board user, not an agent", async () => {
  const bridge = track(await seed());
  const agent = {
    actorType: "agent" as const,
    actorId: "agent-1",
    agentId: "agent-1",
    runId: "run-a",
    roles: [],
  };
  await assert.rejects(
    () => bridge.company.router.startRun({ companyId: COMPANY_A, issueId: "root-1", actor: agent, reason: "self-start" }, "c"),
    /requires a board user/,
  );

  const human = { actorType: "human" as const, actorId: "user-1", agentId: null, runId: null, roles: [] };
  const outcome = await bridge.company.router.startRun(
    { companyId: COMPANY_A, issueId: "root-1", actor: human, reason: "board start" },
    "c",
  );
  assert.equal(outcome.enqueued, true);
  // A second start is a replay, not a second run.
  const replay = await bridge.company.router.startRun(
    { companyId: COMPANY_A, issueId: "root-1", actor: human, reason: "board start again" },
    "c",
  );
  assert.equal(replay.enqueued, false);
  assert.equal(replay.startIntentId, outcome.startIntentId);
});
