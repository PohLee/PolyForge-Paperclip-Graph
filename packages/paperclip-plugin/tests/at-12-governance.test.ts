/**
 * AT-12 / AT-13 — governance carriers and the forged-identity refusals.
 * (docs/03 §10: AT-12 "human_only、not_creator、company cap 的真实服务端测试；plugin 创建者不同于产物作者时仍拒绝作者自审";
 *  AT-13 "agent 伪造 actorUserId/approved/record_approval/evaluator registration 全部失败")
 *
 * ## What the harness cannot prove here
 *
 * AT-12's real subject is the *server*'s enforcement of `human_only` / `not_creator` /
 * company-cap, and `@paperclipai/plugin-sdk/testing` does **not** implement it: its
 * `createInteraction` stores whatever resolver policy it is handed and its `respondInteraction`
 * does not check one. So this file proves the bridge half — the carrier is always `human_only`,
 * a requested `anyone` is upgraded, the bridge never calls `respondInteraction`, the target hash
 * is read back out of the object, and an unverified or agent-resolved card is never recorded as
 * a fact — and it asserts the harness gap explicitly so nobody reads a green run as "human-only
 * is enforced".
 */

import "./helpers/bootstrap.ts";
import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "./helpers/bootstrap.ts";

const h = await load<typeof import("./helpers/harness.ts")>(new URL("./helpers/harness.ts", import.meta.url));
const identity = await load<typeof import("../src/identity.ts")>(new URL("../src/identity.ts", import.meta.url));
const governance = await load<typeof import("../src/ports/governance.ts")>(
  new URL("../src/ports/governance.ts", import.meta.url),
);
const intents = await load<typeof import("../src/outbox/intents.ts")>(
  new URL("../src/outbox/intents.ts", import.meta.url),
);
const manifest = h.manifest;

const { COMPANY_A, PROJECT_A, SHARED_SECRET, buildBridge, company, project, issue, answeredInteraction } = h;
const bridges: { dispose(): void }[] = [];
after(() => {
  for (const bridge of bridges) bridge.dispose();
});
function track<T extends { dispose(): void }>(bridge: T): T {
  bridges.push(bridge);
  return bridge;
}

const TARGET_HASH = "sha256:decision-target-1";
const SEMANTIC_KIND = "design_acceptance";

function governanceRequest(overrides: Record<string, unknown> = {}) {
  return {
    scope: { companyRef: COMPANY_A, projectRef: PROJECT_A },
    targetIssueRef: { provider: "paperclip", kind: "issue", id: "root-1" },
    kind: "review" as const,
    semanticKind: SEMANTIC_KIND,
    question: "Accept this design?",
    options: [{ id: "approve", label: "Approve" }, { id: "reject", label: "Reject" }],
    decisionTargetHash: TARGET_HASH,
    correlationId: "corr-1",
    ...overrides,
  };
}

const meta = { commandId: "c1", idempotencyKey: "pf:g:1", correlationId: "corr-1" };

/**
 * The harness does not persist `resolverPolicy` on a created interaction, so the only way to see
 * what the bridge asked for is to wrap the call. The wrapper is kept on the bridge for every test
 * here so the assertion is always against the request, not against harness bookkeeping.
 */
type InteractionRequestSpy = { requests: Record<string, unknown>[] };

async function seeded(interactions: unknown[] = []) {
  const bridge = await buildBridge({
    seed: {
      companies: [company(COMPANY_A)],
      projects: [project(PROJECT_A, COMPANY_A)],
      issues: [issue("root-1", COMPANY_A, PROJECT_A)],
      issueInteractions: interactions as never,
    },
  });
  const spy: InteractionRequestSpy = { requests: [] };
  const original = bridge.ctx.issues.createInteraction;
  // A rest-parameter wrapper: `createInteraction` takes four arguments and the bridge passes
  // all of them, so forwarding only the first two would break the host call.
  bridge.ctx.issues.createInteraction = ((...args: unknown[]) => {
    spy.requests.push(args[1] as Record<string, unknown>);
    return (original as unknown as (...a: unknown[]) => unknown)(...args);
  }) as typeof bridge.ctx.issues.createInteraction;
  Object.defineProperty(bridge, "interactionRequests", { value: spy.requests });
  return bridge;
}

test("AT-12: a governance request creates a human_only carrier carrying the Core's exact target", async () => {
  const bridge = track(await seeded());
  const ref = await bridge.company.ports.governance.requestInteraction(governanceRequest(), meta);
  assert.equal(ref.kind, "issue_interaction");

  // What the bridge asked the host for.
  const request = bridge.interactionRequests[0];
  assert.ok(request, "the bridge must have called createInteraction");
  assert.equal(request["resolverPolicy"], "human_only");
  assert.equal(request["authorAgentId"], undefined, "the carrier is attributed to no agent");

  // What the host stored.
  const interactions = await bridge.ctx.issues.listInteractions("root-1", COMPANY_A);
  assert.equal(interactions.length, 1);
  const card = interactions[0];
  assert.ok(card);
  assert.equal(card.payload.version, 1);
  const question = card.payload.questions[0];
  assert.ok(question);
  // The prompt shows the human exactly what is being decided.
  assert.match(question.prompt, /semantic-kind: design_acceptance/);
  assert.match(question.prompt, new RegExp(`decision-target: ${TARGET_HASH}`));
  // The options are exactly the Core's, and there is no free-text escape hatch: an answer
  // outside the option set is not one of the targets the Core hashed.
  assert.deepEqual(question.options, [
    { id: "approve", label: "Approve" },
    { id: "reject", label: "Reject" },
  ]);
  assert.equal(question.allowOther, false);
  // The bridge is the creator and is attributed to no human, which is what makes `not_creator`
  // meaningful rather than self-referential.
  assert.equal(card.createdByUserId, null);
});

test("AT-12: the harness does not store resolverPolicy, so the card is not self-enforcing here", async () => {
  // A guard on the *claim* this file makes. The bridge sends `human_only`; the SDK harness drops
  // it on the floor, so nothing in this run proves the host would enforce it. The real
  // enforcement is the server's, and the test says so instead of implying otherwise.
  const bridge = track(await seeded());
  await bridge.company.ports.governance.requestInteraction(
    governanceRequest({ requiredResolver: "human_only" }),
    meta,
  );
  const card = (await bridge.ctx.issues.listInteractions("root-1", COMPANY_A))[0];
  assert.ok(card);
  assert.equal(bridge.interactionRequests[0]?.["resolverPolicy"], "human_only");
  assert.equal(card.resolverPolicy, undefined, "the harness neither stores nor evaluates the policy");
  assert.equal(card.status, "pending");
});

test("AT-12: a requested 'anyone' resolver is upgraded to human_only, never honoured", async () => {
  const bridge = track(await seeded());
  await bridge.company.ports.governance.requestInteraction(
    governanceRequest({ requiredResolver: "anyone" }),
    meta,
  );
  assert.equal(bridge.interactionRequests[0]?.["resolverPolicy"], "human_only");
  // The upgrade is visible in the log rather than silent.
  assert.ok(
    bridge.logs.some((line) => line.message.includes("upgraded an 'anyone' resolver")),
    "an attempted downgrade must be recorded",
  );
});

test("AT-12: a replayed request finds the same card instead of asking a human twice", async () => {
  const bridge = track(await seeded());
  const first = await bridge.company.ports.governance.requestInteraction(governanceRequest(), meta);
  const second = await bridge.company.ports.governance.requestInteraction(governanceRequest(), meta);
  assert.equal(first.id, second.id);
  assert.equal((await bridge.ctx.issues.listInteractions("root-1", COMPANY_A)).length, 1);
});

test("AT-12: a pending card is not a resolution", async () => {
  const bridge = track(await seeded());
  const ref = await bridge.company.ports.governance.requestInteraction(governanceRequest(), meta);
  assert.equal(await bridge.company.ports.governance.readVerifiedResolution(ref), null);
});

test("AT-12: a verified human resolution reports the target hash it matched", async () => {
  const bridge = track(
    await seeded([
      answeredInteraction({
        id: "int-1",
        issueId: "root-1",
        companyId: COMPANY_A,
        decisionTargetHash: TARGET_HASH,
        semanticKind: SEMANTIC_KIND,
      }),
    ]),
  );
  // Record the binding the carrier creation would have written, then re-read.
  bridge.store.putBinding({
    companyId: COMPANY_A,
    kind: "governance_interaction",
    providerId: "pf.gov.1",
    projectId: PROJECT_A,
    payload: {
      requestId: "req-1",
      issueId: "root-1",
      interactionId: "int-1",
      decisionTargetHash: TARGET_HASH,
      semanticKind: SEMANTIC_KIND,
      requiredResolver: "human_only",
      effectiveResolverPolicy: "human_only",
      createdAt: new Date(1_700_000_000_000).toISOString(),
      resolvedVerified: false,
      options: [{ id: "approve", label: "Approve" }],
      runId: "run-1",
      transitionHash: "sha256:transition-1",
      correlationId: "corr-1",
    },
  });

  const resolution = await bridge.company.ports.governance.readVerifiedResolution({
    provider: "paperclip",
    kind: "issue_interaction",
    id: "pf.gov.1",
  });
  assert.ok(resolution);
  assert.equal(resolution.outcome, "accept");
  assert.equal(resolution.responderKind, "human");
  assert.equal(resolution.responderSubject, "user-1");
  // Verified only because the re-read object carries the same target hash.
  assert.equal(resolution.targetHashVerified, true);
  assert.equal(resolution.detail.observedTargetHash, TARGET_HASH);
  assert.equal(resolution.detail.humanResponder, true);
});

test("AT-12: a card whose target hash no longer matches is never verified", async () => {
  const bridge = track(
    await seeded([
      answeredInteraction({
        id: "int-1",
        issueId: "root-1",
        companyId: COMPANY_A,
        // The card the host still holds names a *different* target than the Core pinned.
        decisionTargetHash: "sha256:a-different-target",
        semanticKind: SEMANTIC_KIND,
      }),
    ]),
  );
  bridge.store.putBinding({
    companyId: COMPANY_A,
    kind: "governance_interaction",
    providerId: "pf.gov.1",
    projectId: PROJECT_A,
    payload: {
      requestId: "req-1",
      issueId: "root-1",
      interactionId: "int-1",
      decisionTargetHash: TARGET_HASH,
      semanticKind: SEMANTIC_KIND,
      effectiveResolverPolicy: "human_only",
      createdAt: new Date(1_700_000_000_000).toISOString(),
      resolvedVerified: false,
    },
  });
  const resolution = await bridge.company.ports.governance.readVerifiedResolution({
    provider: "paperclip",
    kind: "issue_interaction",
    id: "pf.gov.1",
  });
  assert.ok(resolution);
  assert.equal(resolution.targetHashVerified, false);
  assert.equal(resolution.detail.observedTargetHash, "sha256:a-different-target");
  // The reconciler refuses to record an unverified resolution.
  const report = await bridge.company.reconciler.reconcileCompany(COMPANY_A);
  assert.equal(report.governanceObserved, 1);
  assert.equal(bridge.store.countDeliveries(COMPANY_A, "pending"), 0);
  assert.ok(
    bridge.logs.some((line) => line.message.includes("does not match the pinned decision target")),
    "a target mismatch must be logged as an error",
  );
});

test("AT-12: an author self-review through a plugin-created card is still refused", async () => {
  // The producer agent answered its own `human_only` card — a host violation the bridge must
  // record rather than smooth over.
  const bridge = track(
    await seeded([
      answeredInteraction({
        id: "int-1",
        issueId: "root-1",
        companyId: COMPANY_A,
        decisionTargetHash: TARGET_HASH,
        semanticKind: SEMANTIC_KIND,
        resolvedByUserId: null,
        resolvedByAgentId: "agent-author",
        status: "accepted",
      }),
    ]),
  );
  bridge.store.putBinding({
    companyId: COMPANY_A,
    kind: "governance_interaction",
    providerId: "pf.gov.1",
    projectId: PROJECT_A,
    payload: {
      requestId: "req-1",
      issueId: "root-1",
      interactionId: "int-1",
      decisionTargetHash: TARGET_HASH,
      semanticKind: SEMANTIC_KIND,
      effectiveResolverPolicy: "human_only",
      createdAt: new Date(1_700_000_000_000).toISOString(),
      resolvedVerified: false,
      runId: "run-1",
      transitionHash: "sha256:transition-1",
      correlationId: "corr-1",
    },
  });
  const resolution = await bridge.company.ports.governance.readVerifiedResolution({
    provider: "paperclip",
    kind: "issue_interaction",
    id: "pf.gov.1",
  });
  assert.ok(resolution);
  assert.equal(resolution.responderKind, "agent");
  assert.equal(resolution.responderSubject, "agent-author");
  assert.ok(
    bridge.logs.some((line) => line.message.includes("resolved without a human responder")),
    "a human_only card answered by an agent is a host violation and must be loud",
  );
  // And the reconciler does not hand an agent-only resolution to the Core as verified.
  await bridge.company.reconciler.reconcileCompany(COMPANY_A);
  assert.equal(bridge.store.countDeliveries(COMPANY_A, "pending"), 0);
});

test("AT-12: the harness does not enforce resolverPolicy, and this file says so", async () => {
  // The claim being guarded: nothing in this run proves `human_only` is enforced, because the
  // SDK harness does not evaluate it. Asserted so a future harness change surfaces here.
  const bridge = track(await seeded());
  await bridge.company.ports.governance.requestInteraction(
    governanceRequest({ requiredResolver: "human_only" }),
    meta,
  );
  const card = (await bridge.ctx.issues.listInteractions("root-1", COMPANY_A))[0];
  assert.ok(card);
  assert.equal(card.resolverPolicy, undefined);
  assert.equal(card.status, "pending");
});

test("AT-12: a cross-project governance target is refused and counted", async () => {
  const bridge = track(await seeded());
  await assert.rejects(
    () =>
      bridge.company.ports.governance.requestInteraction(
        governanceRequest({
          scope: { companyRef: COMPANY_A, projectRef: "project-somewhere-else" },
        }),
        meta,
      ),
    /in another project/,
  );
  assert.ok((bridge.counters()["crossScopeDenials"] as number) >= 1);
});

test("AT-12: a governance target outside the company is refused", async () => {
  const bridge = track(await seeded());
  await assert.rejects(
    () =>
      bridge.company.ports.governance.requestInteraction(
        governanceRequest({ targetIssueRef: { provider: "paperclip", kind: "issue", id: "does-not-exist" } }),
        meta,
      ),
    /not in scope/,
  );
});

test("AT-13: the manifest cannot answer a human decision on a human's behalf", () => {
  // The structural half of AT-13: the capabilities that would let a plugin impersonate a
  // decision are simply absent from the manifest, so the host refuses the call before the
  // bridge's own logic matters.
  const capabilities = new Set(manifest.capabilities as string[]);
  for (const forbidden of [
    "approvals.respond",
    "issue.interactions.respond",
    "issue.comments.create_human_attributed",
    "agents.invoke",
    "agent.sessions.create",
    "agent.sessions.send",
    "authorization.grants.write",
    "access.members.write",
  ]) {
    assert.equal(capabilities.has(forbidden), false, `the manifest must not hold ${forbidden}`);
  }
  // And it does hold the read surfaces the bridge legitimately needs.
  for (const required of [
    "approvals.read",
    "issue.interactions.create",
    "issue.interactions.read",
    "issues.create",
    "issues.checkout",
    "issues.wakeup",
    "projects.read",
    "project.workspaces.read",
    "execution.workspaces.read",
    "agent.tools.register",
    "api.routes.register",
    "events.subscribe",
    "http.outbound",
    "jobs.schedule",
  ]) {
    assert.equal(capabilities.has(required), true, `the manifest must hold ${required}`);
  }
  // No plugin database namespace: the bridge keeps its own SQLite file.
  assert.equal(manifest.database, undefined);
});

test("AT-13: the shared secret is resolved per request, never persisted, and never guessed", async () => {
  // The manifest DOES hold `secrets.read-ref`: the bridge must sign every Runtime Service
  // request with a shared secret the operator provisions through the host secret provider.
  // Without it the host refuses `ctx.secrets.resolve` outright and the worker cannot sign.
  assert.equal(manifest.capabilities.includes("secrets.read-ref"), true);
  const required = (manifest.instanceConfigSchema as { required?: string[] }).required ?? [];
  assert.ok(
    required.includes("sharedSecretRef"),
    "the config schema must require a secret reference, not an optional one",
  );

  // `health` is used because it is a read that must reach the Runtime, so it exercises the
  // signing path without needing a seeded run or an outbound side effect.
  let resolutions = 0;
  const bridge = track(
    await buildBridge({
      resolveSecret: async () => {
        resolutions += 1;
        return SHARED_SECRET;
      },
    }),
  );
  const { registerDataKeys } = await load<typeof import("../src/bridge/data.ts")>(
    new URL("../src/bridge/data.ts", import.meta.url),
  );
  registerDataKeys(bridge.ctx, (id) => bridge.companies.get(id) ?? null);

  await bridge.harness.getData("health", { companyId: COMPANY_A });
  assert.equal(resolutions, 1, "the secret is resolved once per signed request, not cached");
  assert.equal(
    bridge.runtime.requestsTo("GET", "/v1/health").length,
    1,
    "the signed call must actually reach the Runtime and pass verification",
  );

  // A second call resolves again: a cached secret would outlive a credential rotation.
  await bridge.harness.getData("health", { companyId: COMPANY_A });
  assert.equal(resolutions, 2, "the secret must be re-resolved on the next request");

  // Not even a SQLite free page or a write-ahead log may hold the value.
  const dbFile = join(bridge.stateDir, "bridge.sqlite");
  assert.equal(readFileSync(dbFile).includes(SHARED_SECRET), false, "the secret must not be persisted");
  for (const suffix of ["-wal", "-shm"]) {
    const path = `${dbFile}${suffix}`;
    if (existsSync(path)) {
      assert.equal(readFileSync(path).includes(SHARED_SECRET), false, `the secret must not reach ${suffix}`);
    }
  }
  assert.equal(
    JSON.stringify(bridge.logs).includes(SHARED_SECRET),
    false,
    "the secret must never be logged",
  );

  // Fail closed: an unresolvable secret must produce no Runtime traffic at all, rather than an
  // unsigned request the Core would (correctly) reject only after a round trip.
  const broken = track(
    await buildBridge({
      resolveSecret: async () => {
        throw new Error("secret provider unavailable");
      },
    }),
  );
  registerDataKeys(broken.ctx, (id) => broken.companies.get(id) ?? null);
  const brokenHealth = await broken.harness.getData("health", { companyId: COMPANY_A });
  assert.equal(
    broken.runtime.requestsTo("GET", "/v1/health").length,
    0,
    "a bridge that cannot resolve its secret must not send a request",
  );
  assert.notEqual(
    (brokenHealth as { status: string }).status,
    "ready",
    "an unresolvable secret must not report ready",
  );
});

test("AT-13: there is no code path that lets a tool parameter express a human actor", () => {
  // The six tool schemas have no actor, approval, or evaluator *property* at all. A caller cannot
  // express an identity because the schema has nowhere to put one. Descriptions are excluded on
  // purpose: prose may legitimately say "wait for a human".
  const tools = manifest.tools ?? [];
  const forbidden = /actor|approv|evaluator|onbehalf|asuser|human|resolvedby|createdby/i;
  for (const tool of tools) {
    const properties = Object.keys(
      ((tool.parametersSchema ?? {}) as { properties?: Record<string, unknown> }).properties ?? {},
    );
    for (const name of properties) {
      assert.equal(forbidden.test(name), false, `${tool.name}.${name} must not be an identity field`);
    }
    // A required list, if present, must be a subset of the properties: no hidden requirement.
    const required = ((tool.parametersSchema ?? {}) as { required?: string[] }).required ?? [];
    for (const name of required) {
      assert.equal(properties.includes(name), true, `${tool.name} requires unknown property ${name}`);
    }
    // And nothing anywhere in the schema smuggles a literal `approved: true`.
    assert.equal(JSON.stringify(tool.parametersSchema ?? {}).includes('"approved"'), false);
  }
  // And the registered names are exactly the six, with no `node.complete` alias.
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    ["current", "request_help", "request_transition", "status", "submit_artifact", "submit_evidence"],
  );
  assert.equal(
    tools.some((tool) => tool.name === "node.complete"),
    false,
    "REQ-TOOL-02 forbids a node.complete alias that is not exactly request_transition",
  );
});

test("AT-13: a tool-call context cannot express a human, and an agent actor is always an agent", () => {
  // `ToolRunContext` has no actor field, so `agentActor` cannot be handed one.
  const assertion = identity.agentActor({
    agentId: "agent-1",
    runId: "agent-run-1",
    companyId: COMPANY_A,
    projectId: PROJECT_A,
  });
  assert.equal(assertion.actorType, "agent");
  assert.equal(assertion.actorId, "agent-1");
  // A `human` type is rejected by the board-action path when the host claims a user with no id.
  assert.throws(
    () => identity.boardActor({ actor: { type: "user", userId: null, agentId: null, runId: null, companyId: COMPANY_A }, companyId: COMPANY_A }),
    /user actor without a user id/,
  );
  assert.throws(
    () => identity.apiRequestActor({
      routeKey: "runs",
      method: "GET",
      path: "/runs",
      params: {},
      query: {},
      body: null,
      actor: { actorType: "agent", actorId: "", agentId: null, runId: null, userId: null },
      companyId: COMPANY_A,
      headers: {},
    }),
    /agent actor without an agent id/,
  );
});

test("AT-13: every identity-flavoured key is stripped, including the open-ended actor family", () => {
  const cases = [
    "actor",
    "actorId",
    "actorType",
    "actorUserId",
    "actorAgentId",
    "actorRunId",
    "actorAssertion",
    "onBehalfOfUserId",
    "asUser",
    "asActor",
    "impersonate",
    "humanActor",
    "pretendUser",
    "approved",
    "approvedBy",
    "approverUserId",
    "recordApproval",
    "record_approval",
    "resolverPolicyOverride",
    "createdByUserId",
    "resolvedByUserId",
    "decideas",
    "evaluatorRef",
    "evaluatorRefs",
    "registerEvaluator",
    "evaluatorRegistration",
    "gateOverride",
    "overridePolicy",
  ];
  for (const key of cases) {
    assert.equal(identity.isActorishKey(key), true, `${key} must be treated as identity-flavoured`);
    const stripped = identity.stripActorAssertions({ [key]: "x", keep: 1 });
    assert.deepEqual(stripped.value, { keep: 1 }, `${key} must be stripped`);
  }
  // Prefix matching is deliberate, so a field that merely *starts* with `actor` is stripped too.
  // Over-stripping is the safe direction: a signed body loses a field rather than gaining an
  // unverified identity. `actorCount` is the documented cost of that choice.
  assert.equal(identity.isActorishKey("actorCount"), true);
  assert.deepEqual(identity.stripActorAssertions({ actorCount: 2, keep: 1 }).value, { keep: 1 });
  // A field that is not identity-flavoured survives untouched.
  assert.equal(identity.isActorishKey("issueId"), false);
  const preserved = identity.stripActorAssertions({ issueId: "i-1", iteration: 2 });
  assert.deepEqual(preserved.value, { issueId: "i-1", iteration: 2 });
});

test("AT-12: an engineering decision is carried by a human-only interaction, and its effects are recorded not executed", async () => {
  const bridge = track(await seeded());
  await bridge.company.ports.governance.requestEngineeringDecision(
    {
      scope: { companyRef: COMPANY_A, projectRef: PROJECT_A },
      targetIssueRef: { provider: "paperclip", kind: "issue", id: "root-1" },
      semanticKind: "architecture_choice",
      question: "A or B?",
      options: [
        { id: "a", label: "Option A" },
        { id: "b", label: "Option B" },
      ],
      decisionTargetHash: TARGET_HASH,
      correlationId: "corr-1",
      // A whitelisted effect that would change an issue status. The bridge records it for the
      // Core and does not apply it: a second write path into a run is exactly what is forbidden.
      effects: [{ kind: "issue_comment", value: "decision recorded" }],
    },
    meta,
  );
  const card = (await bridge.ctx.issues.listInteractions("root-1", COMPANY_A))[0];
  assert.ok(card);
  assert.equal(bridge.interactionRequests[0]?.["resolverPolicy"], "human_only");
  const effectKey = intents.governanceEffectKey(TARGET_HASH, "architecture_choice", "corr-1");
  const recorded = bridge.store.getCompat<unknown>(COMPANY_A, `decision-effects/${effectKey}`, null);
  assert.deepEqual(recorded, [{ kind: "issue_comment", value: "decision recorded" }]);
  // The issue status is untouched: only the Core applies a decision effect.
  const current = await bridge.ctx.issues.get("root-1", COMPANY_A);
  assert.ok(current);
  assert.equal(current.status, "todo");
});
