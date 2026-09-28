/**
 * A review has to exist in the Core, not in the editor.
 *
 * Publishing requires a review bound to the current revision, and the Core is the only thing that can
 * bind one. The editor's "attest" control filled in a name in React state and told the reader it was
 * "recorded in the publish request" — so the panel showed a completed review, the publish request
 * carried a `reviewTargetHash`, and the Core still had no reviewer and refused with "publishing
 * requires a review bound to the current revision". The UI reported success for a step it had not
 * performed.
 *
 * These tests drive the action the UI now calls, and assert on the request the Core receives.
 */

import "./helpers/bootstrap.ts";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { load } from "./helpers/bootstrap.ts";

const h = await load<typeof import("./helpers/harness.ts")>(new URL("./helpers/harness.ts", import.meta.url));
const manifestModule = await load<typeof import("../src/manifest.ts")>(new URL("../src/manifest.ts", import.meta.url));
const protocol = await load<typeof import("@polyforge/protocol")>("@polyforge/protocol");

const { COMPANY_A, PROJECT_A } = h;

const BOARD_USER = { type: "user" as const, userId: "user-anna", companyId: COMPANY_A, agentId: null, runId: null };
const AGENT = { type: "agent" as const, agentId: "agent-1", agentId_: undefined, runId: "run-1" };

test("the review action is declared in the shared contract", () => {
  assert.ok(
    protocol.ACTION_KEYS.includes("record-draft-review"),
    "the action must exist in the shared contract, or the UI cannot call it by name",
  );
  assert.ok(manifestModule.default, "the manifest module loads");
});

test("recording a review reaches the Core, with the reviewer as the asserted actor", async () => {
  const bridge = await h.buildBridge({
    seed: {
      companies: [h.company(COMPANY_A)],
      projects: [h.project(PROJECT_A, COMPANY_A)],
      issues: [h.issue("root-1", COMPANY_A, PROJECT_A)],
    },
  });
  try {
    const { registerActionKeys } = await load<typeof import("../src/bridge/actions.ts")>(
      new URL("../src/bridge/actions.ts", import.meta.url),
    );
    const actions = new Map<string, (params: Record<string, unknown>, context: never) => Promise<unknown>>();
    registerActionKeys(
      (key, handler) => actions.set(key, handler as never),
      (id) => bridge.companies.get(id) ?? (id === COMPANY_A ? bridge.company : null),
    );
    // The host's action context: which company the host says this call is for, and the actor the
    // host authenticated. Both come from the host in production, which is the whole point — the
    // bridge never decides who the caller is.
    const perform = async (params: Record<string, unknown>, actor: Record<string, unknown>) => {
      const handler = actions.get("record-draft-review");
      assert.ok(handler, "the action should be registered");
      const context = { companyId: COMPANY_A, actor, requestId: "req-1", projectId: PROJECT_A };
      try {
        const value = await handler(params, context as never);
        return { error: undefined as string | undefined, value };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error), value: null };
      }
    };

    const result = await perform(
      { companyId: COMPANY_A, projectId: PROJECT_A, draftId: "drf-1", reviewTargetHash: "sha256:plan" },
      BOARD_USER,
    );
    assert.equal(result.error, undefined, JSON.stringify(result));

    const posted = bridge.runtime.requestsTo("POST", "/reviews").at(-1);
    assert.ok(posted, "the Core should have received a review");

    // The reviewer is the asserted actor. A body that named an identity would be refused by the
    // Core, and would be the wrong trust model even if it were not: a body is the one part of a
    // request the signature does not decide.
    const actor = JSON.parse(Buffer.from(posted.headers["x-pf-actor"] ?? "", "base64url").toString("utf8"));
    assert.equal(actor["actorType"], "human", "a review is a human act");
    assert.equal(actor["actorId"], "user-anna");
    assert.equal(
      JSON.parse(posted.bodyText ?? "{}")["reviewer"],
      undefined,
      "the reviewer must never appear in the body",
    );
    assert.equal(JSON.parse(posted.bodyText ?? "{}")["reviewTargetHash"], "sha256:plan");
  } finally {
    bridge.dispose();
  }
});

test("an agent cannot record a review", async () => {
  const bridge = await h.buildBridge({
    seed: {
      companies: [h.company(COMPANY_A)],
      projects: [h.project(PROJECT_A, COMPANY_A)],
      issues: [h.issue("root-1", COMPANY_A, PROJECT_A)],
    },
  });
  try {
    const { registerActionKeys } = await load<typeof import("../src/bridge/actions.ts")>(
      new URL("../src/bridge/actions.ts", import.meta.url),
    );
    const actions = new Map<string, (params: Record<string, unknown>, context: never) => Promise<unknown>>();
    registerActionKeys(
      (key, handler) => actions.set(key, handler as never),
      (id) => bridge.companies.get(id) ?? null,
    );
    const perform = async (params: Record<string, unknown>, actor: unknown) => {
      const handler = actions.get("record-draft-review");
      assert.ok(handler, "the action should be registered");
      try {
        const value = await handler(params, actor as never);
        return { error: undefined, value };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error), value: null };
      }
    };

    const result = await perform(
      { companyId: COMPANY_A, projectId: PROJECT_A, draftId: "drf-1", reviewTargetHash: "sha256:plan" },
      { type: "agent", agentId: "agent-1", runId: "run-1" },
    );

    assert.notEqual(result.error, undefined, "an agent's review must be refused");
    assert.equal(
      bridge.runtime.requestsTo("POST", "/reviews").length,
      0,
      "nothing may reach the Core once the bridge has refused",
    );
  } finally {
    bridge.dispose();
  }
});

test("a review with no target hash is refused", async () => {
  const bridge = await h.buildBridge({
    seed: {
      companies: [h.company(COMPANY_A)],
      projects: [h.project(PROJECT_A, COMPANY_A)],
      issues: [h.issue("root-1", COMPANY_A, PROJECT_A)],
    },
  });
  try {
    const { registerActionKeys } = await load<typeof import("../src/bridge/actions.ts")>(
      new URL("../src/bridge/actions.ts", import.meta.url),
    );
    const actions = new Map<string, (params: Record<string, unknown>, context: never) => Promise<unknown>>();
    registerActionKeys(
      (key, handler) => actions.set(key, handler as never),
      (id) => bridge.companies.get(id) ?? null,
    );
    const perform = async (params: Record<string, unknown>, actor: unknown) => {
      const handler = actions.get("record-draft-review");
      assert.ok(handler, "the action should be registered");
      try {
        const value = await handler(params, actor as never);
        return { error: undefined, value };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error), value: null };
      }
    };

    const result = await perform(
      { companyId: COMPANY_A, projectId: PROJECT_A, draftId: "drf-1" },
      BOARD_USER,
    );

    assert.notEqual(result.error, undefined, "a review of nothing in particular is not a review");
    assert.equal(bridge.runtime.requestsTo("POST", "/reviews").length, 0);
  } finally {
    bridge.dispose();
  }
});
