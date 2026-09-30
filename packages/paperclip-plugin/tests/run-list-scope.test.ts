import "./helpers/bootstrap.ts";
import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { load } from "./helpers/bootstrap.ts";

const h = await load<typeof import("./helpers/harness.ts")>(new URL("./helpers/harness.ts", import.meta.url));
const data = await load<typeof import("../src/bridge/data.ts")>(new URL("../src/bridge/data.ts", import.meta.url));
const routes = await load<typeof import("../src/api-routes.ts")>(new URL("../src/api-routes.ts", import.meta.url));
const { COMPANY_A, PROJECT_A, buildBridge, company, project } = h;
const bridges: { dispose(): Promise<void> }[] = [];
after(async () => {
  for (const bridge of bridges) await bridge.dispose();
});

function projectRefs(bridge: Awaited<ReturnType<typeof buildBridge>>): string[] {
  return bridge.runtime.requestsTo("GET", "/v1/runs").map((request) => {
    const scope = JSON.parse(Buffer.from(request.headers["x-pf-scope"] ?? "e30", "base64url").toString("utf8")) as Record<string, unknown>;
    return String(scope["projectRef"] ?? "");
  });
}

test("run-list UI read aggregates only explicitly project-scoped Runtime requests", async () => {
  const bridge = await buildBridge({
    seed: {
      companies: [company(COMPANY_A)],
      projects: [project(PROJECT_A, COMPANY_A), project("project-b", COMPANY_A)],
    },
    configureRuntime: (runtime) => {
      runtime.seedRun("run-a", { scope: { companyRef: COMPANY_A, projectRef: PROJECT_A } });
      runtime.seedRun("run-b", { scope: { companyRef: COMPANY_A, projectRef: "project-b" } });
    },
  });
  bridges.push(bridge);
  data.registerDataKeys(bridge.ctx, (companyId) => bridge.companies.get(companyId) ?? null);

  const runs = await bridge.harness.getData("runtime-runs", { companyId: COMPANY_A }) as Record<string, unknown>[];
  assert.deepEqual(runs.map((run) => run["runId"]).sort(), ["run-a", "run-b"]);
  assert.deepEqual(projectRefs(bridge).sort(), [PROJECT_A, "project-b"]);
});

test("run-list API route never sends an empty project scope", async () => {
  const bridge = await buildBridge({
    seed: {
      companies: [company(COMPANY_A)],
      projects: [project(PROJECT_A, COMPANY_A), project("project-b", COMPANY_A)],
    },
    configureRuntime: (runtime) => {
      runtime.seedRun("run-a", { scope: { companyRef: COMPANY_A, projectRef: PROJECT_A } });
      runtime.seedRun("run-b", { scope: { companyRef: COMPANY_A, projectRef: "project-b" } });
    },
  });
  bridges.push(bridge);
  const handle = routes.createApiRequestHandler((companyId) => bridge.companies.get(companyId) ?? null, {} as never);

  const response = await handle({
    routeKey: "runs",
    method: "GET",
    path: "/runs",
    params: {},
    query: {},
    body: null,
    actor: { actorType: "user", actorId: "board-user", agentId: null, userId: "board-user", runId: null },
    companyId: COMPANY_A,
    headers: {},
  } as never);

  assert.equal(response.status, 200);
  const result = response.body as { runs: Record<string, unknown>[] };
  assert.deepEqual(result.runs.map((run) => run["runId"]).sort(), ["run-a", "run-b"]);
  assert.deepEqual(projectRefs(bridge).sort(), [PROJECT_A, "project-b"]);
});
