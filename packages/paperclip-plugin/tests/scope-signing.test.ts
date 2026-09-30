/**
 * Every Runtime Service call is signed with a real project scope.
 *
 * The Core's tenant identity is the company/project pair, and it refuses an empty `projectRef`:
 * an empty project would otherwise read as "every project", so the refusal is the security property
 * rather than a validation detail. The plugin signed almost every call `{ companyId, projectRef: "" }`
 * — all seven tools, event intake, governance resolution, execution observation and the delivery ack
 * — so none of them could reach the Core. The failure read as a scope-header problem several layers
 * from its cause.
 *
 * These assertions are on the bytes the Core receives, because that is the only place the property
 * is real. A test that asserted on the bridge's own variables would pass while the header stayed
 * empty.
 */

import "./helpers/bootstrap.ts";
import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { load } from "./helpers/bootstrap.ts";

const h = await load<typeof import("./helpers/harness.ts")>(new URL("./helpers/harness.ts", import.meta.url));

const bridges: { dispose(): Promise<void> }[] = [];
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

const { COMPANY_A, COMPANY_B, PROJECT_A, PROJECT_B, company, project, issue } = h;

function decodeScope(headers: Record<string, string>): { companyRef: string; projectRef: string } {
  const raw = headers["x-pf-scope"] ?? "";
  assert.notEqual(raw, "", "every tenant-scoped request must carry a scope header");
  return JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as { companyRef: string; projectRef: string };
}

async function bridgeWithRun() {
  const bridge = track(
    await h.buildBridge({
      seed: {
        companies: [company(COMPANY_A), company(COMPANY_B)],
        projects: [project(PROJECT_A, COMPANY_A), project(PROJECT_B, COMPANY_B)],
        issues: [issue("root-1", COMPANY_A, PROJECT_A), issue("root-b", COMPANY_B, PROJECT_B)],
      },
      configureRuntime: (runtime) => {
        runtime.seedRun("run-1", {
          scope: { companyRef: COMPANY_A, projectRef: PROJECT_A },
          graphId: h.GRAPH_ID,
          entrypoint: h.ENTRYPOINT,
          startIntentId: "intent-1",
        });
        runtime.contracts.set("run-1", {
          runId: "run-1",
          stateVersion: 1,
          nodeId: "n1",
          iteration: 0,
          attemptId: null,
          leaseEpoch: 0,
          contractHash: "sha256:contract-1",
          requiredInputs: [],
          permittedOutputs: [],
          permittedActions: ["polyforge.current", "polyforge.status"],
        });
      },
    }),
  );
  // The run binding: the project a run-scoped call is signed with comes from here.
  bridge.store.putBinding({
    companyId: COMPANY_A,
    kind: "run",
    providerId: "run-1",
    projectId: PROJECT_A,
    payload: { runId: "run-1", projectId: PROJECT_A, rootIssueId: "root-1" },
  });
  return bridge;
}

test("a run-scoped tool read is signed with the run's own project", async () => {
  const bridge = await bridgeWithRun();
  const { registerTools } = await load<typeof import("../src/tools/register.ts")>(
    new URL("../src/tools/register.ts", import.meta.url),
  );
  void registerTools;

  const wiring = await load<typeof import("../src/worker.ts")>(new URL("../src/worker.ts", import.meta.url));
  const toolRuntime = wiring.__testing.toolRuntimeFor(bridge.company);
  await toolRuntime.current(COMPANY_A, "run-1");

  const call = bridge.runtime.requestsTo("GET", "/current").at(-1);
  assert.ok(call, "the Core should have received a current read");
  const scope = decodeScope(call.headers);
  assert.deepEqual(scope, { companyRef: COMPANY_A, projectRef: PROJECT_A });
  assert.notEqual(scope.projectRef, "", "an empty project is refused by the Core and must never be signed");
});

test("a run with no recorded project is refused rather than signed with a guess", async () => {
  const bridge = await bridgeWithRun();
  const wiring = await load<typeof import("../src/worker.ts")>(new URL("../src/worker.ts", import.meta.url));
  const toolRuntime = wiring.__testing.toolRuntimeFor(bridge.company);

  await assert.rejects(
    () => toolRuntime.current(COMPANY_A, "run-unknown"),
    (error: unknown) => {
      const err = error as { code?: string; reason?: string; message?: string };
      assert.equal(err.code, "BRIDGE_SCOPE_VIOLATION");
      assert.equal(err.reason, "BLOCKED_SCOPE");
      assert.match(err.message ?? "", /not bound to a PolyForge run/);
      return true;
    },
  );
  assert.equal(
    bridge.runtime.requestsTo("GET", "/current").length,
    0,
    "nothing may reach the Core without a scope to sign it with",
  );
});

test("another company's run is refused as out of scope and counted", async () => {
  const bridge = await bridgeWithRun();
  const before = bridge.counters()["crossScopeDenials"] as number;
  const wiring = await load<typeof import("../src/worker.ts")>(new URL("../src/worker.ts", import.meta.url));
  const toolRuntime = wiring.__testing.toolRuntimeFor(bridge.company);

  await assert.rejects(() => toolRuntime.current(COMPANY_B, "run-1"));
  assert.ok(
    (bridge.counters()["crossScopeDenials"] as number) > before,
    "a refusal that is never counted is a refusal nobody can measure",
  );
});
