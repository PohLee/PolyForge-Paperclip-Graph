import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkInstallTarget } from "./install-plugin-target.mjs";

async function fakeHost(t, { health = { status: "ok" }, plugins = [] } = {}) {
  const methods = [];
  const server = createServer((request, response) => {
    methods.push(request.method);
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/health") response.end(JSON.stringify(health));
    else if (request.url === "/api/plugins") response.end(JSON.stringify({ plugins }));
    else { response.statusCode = 404; response.end("{}"); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  return { api: `http://127.0.0.1:${address.port}`, methods };
}

function stagedPackage(t) {
  const stage = mkdtempSync(join(tmpdir(), "polyforge-install-target-"));
  t.after(() => rmSync(stage, { recursive: true, force: true }));
  mkdirSync(join(stage, "dist"));
  writeFileSync(join(stage, "package.json"), JSON.stringify({ name: "@polyforge/paperclip-plugin", version: "0.1.0" }));
  return stage;
}

test("install preflight is read-only and requires a healthy, queryable host", async (t) => {
  const stage = stagedPackage(t);
  const host = await fakeHost(t);
  assert.deepEqual(await checkInstallTarget("preflight", host.api, stage), { ready: true, installed: false, plugin: null });
  assert.deepEqual(host.methods, ["GET", "GET"]);

  const unhealthy = await fakeHost(t, { health: { status: "starting" } });
  await assert.rejects(checkInstallTarget("preflight", unhealthy.api, stage), /health is not ready/);
});

test("install verification requires the exact ready package version and path", async (t) => {
  const stage = stagedPackage(t);
  const goodHost = await fakeHost(t, { plugins: [{
    pluginKey: "polyforge", status: "ready", version: "0.1.0", packagePath: stage,
  }] });
  assert.deepEqual(await checkInstallTarget("preflight", goodHost.api, stage), {
    ready: true,
    installed: true,
    plugin: { status: "ready", version: "0.1.0", packagePath: stage },
  });
  const result = await checkInstallTarget("verify", goodHost.api, stage);
  assert.equal(result.installed, true);
  assert.deepEqual(goodHost.methods, ["GET", "GET", "GET", "GET"]);

  const staleHost = await fakeHost(t, { plugins: [{
    pluginKey: "polyforge", status: "ready", version: "0.1.0", packagePath: `${stage}-old`,
  }] });
  await assert.rejects(checkInstallTarget("verify", staleHost.api, stage), /package path does not match/);

  const failedHost = await fakeHost(t, { plugins: [{
    pluginKey: "polyforge", status: "error", version: "0.1.0", packagePath: stage,
  }] });
  await assert.rejects(checkInstallTarget("verify", failedHost.api, stage), /not ready/);
});
