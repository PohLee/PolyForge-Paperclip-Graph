import "./helpers/bootstrap.ts";
import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { load } from "./helpers/bootstrap.ts";

const h = await load<typeof import("./helpers/harness.ts")>(new URL("./helpers/harness.ts", import.meta.url));
const { COMPANY_A, PROJECT_A, buildBridge, seedCapabilityBinding } = h;
const capabilityModule = await load<typeof import("../src/capabilities.ts")>(
  new URL("../src/capabilities.ts", import.meta.url),
);
const bridges: { dispose(): Promise<void> }[] = [];
after(async () => {
  for (const bridge of bridges) await bridge.dispose();
});

test("a project-scoped capability binding cannot qualify its agent in another project", async () => {
  const bridge = await buildBridge({ companyId: COMPANY_A });
  bridges.push(bridge);
  seedCapabilityBinding(bridge, COMPANY_A, "agent:paperclip/agent-1", "agent-1", ["requirement.clarify"]);
  const requirement = {
    scope: { companyRef: COMPANY_A, projectRef: PROJECT_A },
    runId: "run-1",
    nodeId: "clarify",
    requiredCapabilities: ["requirement.clarify"],
  };

  assert.equal(bridge.company.capabilitiesMatcher.resolve(requirement).candidates.length, 1);
  assert.equal(
    bridge.company.capabilitiesMatcher.resolve({
      ...requirement,
      scope: { companyRef: COMPANY_A, projectRef: "another-project" },
    }).candidates.length,
    0,
  );
});

test("removing a subject revokes every project-scoped capability binding", async () => {
  const bridge = await buildBridge({ companyId: COMPANY_A });
  bridges.push(bridge);
  const subjectRef = "agent:paperclip/agent-revoke";
  bridge.company.capabilitiesMatcher.seedBindings(COMPANY_A, [
    {
      subjectRef,
      agentId: "agent-revoke",
      projectRef: PROJECT_A,
      capabilities: ["requirement.clarify"],
      roles: ["engineering"],
      independentSubjects: [],
      contractVersion: "1",
      enabled: true,
    },
    {
      subjectRef,
      agentId: "agent-revoke",
      projectRef: "project-b",
      capabilities: ["requirement.clarify"],
      roles: ["engineering"],
      independentSubjects: [],
      contractVersion: "1",
      enabled: true,
    },
  ]);

  assert.equal(bridge.company.capabilitiesMatcher.bindings(COMPANY_A).length, 2);
  bridge.company.capabilitiesMatcher.removeBinding(COMPANY_A, subjectRef);
  assert.deepEqual(bridge.company.capabilitiesMatcher.bindings(COMPANY_A), []);
});

test("a persisted capability binding without explicit enabled=true fails closed", async () => {
  const bridge = await buildBridge({ companyId: COMPANY_A });
  bridges.push(bridge);
  const subjectRef = "agent:paperclip/legacy-disabled";
  bridge.store.putBinding({
    companyId: COMPANY_A,
    kind: capabilityModule.CAPABILITY_BINDING_KIND,
    providerId: `${PROJECT_A}:${subjectRef}`,
    projectId: PROJECT_A,
    payload: {
      subjectRef,
      agentId: "agent-legacy-disabled",
      projectRef: PROJECT_A,
      capabilities: ["requirement.clarify"],
      roles: ["engineering"],
      independentSubjects: [],
      contractVersion: "1",
      // Simulate an old, partially written, or manually corrupted row with no enable assertion.
    },
  });

  const report = bridge.company.capabilitiesMatcher.resolve({
    scope: { companyRef: COMPANY_A, projectRef: PROJECT_A },
    runId: "run-1",
    nodeId: "clarify",
    requiredCapabilities: ["requirement.clarify"],
  });
  assert.equal(report.candidates.length, 0);
  assert.equal(report.rejected[0]?.code, "binding_disabled");
});
