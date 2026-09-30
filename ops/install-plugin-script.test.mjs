import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const installer = join(root, "tools", "install-plugin.sh");
const bash = process.env.BASH ?? (process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash");
const samePath = (left, right) => resolve(left).toLowerCase() === resolve(right).toLowerCase();

function stagePackage(path, version) {
  mkdirSync(join(path, "dist", "ui"), { recursive: true });
  const files = {
    "dist/worker.js": `worker-${version}\n`,
    "dist/manifest.js": `manifest-${version}\n`,
    "dist/ui/index.js": `ui-${version}\n`,
  };
  for (const [relative, content] of Object.entries(files)) writeFileSync(join(path, relative), content);
  writeFileSync(join(path, "package.json"), JSON.stringify({
    name: "@polyforge/paperclip-plugin",
    version,
    paperclipPlugin: { manifest: "dist/manifest.js", worker: "dist/worker.js", ui: "dist/ui" },
  }));
  const digests = Object.fromEntries(Object.entries(files).map(([relative, content]) => [
    relative,
    createHash("sha256").update(content).digest("hex"),
  ]));
  writeFileSync(join(path, "staged-build.json"), JSON.stringify({ files: digests }));
}

async function fixture(t, { scenario = "success", previousPath } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "polyforge-install-script-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const previous = join(directory, "previous");
  const stage = join(directory, "new-stage");
  const unexpected = join(directory, "unexpected");
  stagePackage(previous, "0.0.9");
  stagePackage(stage, "0.1.0");
  const installedPreviousPath = previousPath ?? previous;
  let installed = {
    pluginKey: "polyforge",
    status: "ready",
    version: "0.0.9",
    packagePath: installedPreviousPath,
  };
  const actions = [];

  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && request.url === "/api/health") {
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (request.method === "GET" && request.url === "/api/plugins") {
      response.end(JSON.stringify(installed ? [installed] : []));
      return;
    }
    if (request.method === "POST" && request.url === "/__fake/cli") {
      let text = "";
      for await (const chunk of request) text += chunk;
      const command = JSON.parse(text);
      if (command.action === "list") {
        response.end(JSON.stringify({ exitCode: 0 }));
        return;
      }
      if (command.action === "uninstall") {
        actions.push({ action: "uninstall", packagePath: installed?.packagePath ?? null });
        installed = null;
        response.end(JSON.stringify({ exitCode: 0 }));
        return;
      }
      if (command.action === "install") {
        actions.push({ action: "install", packagePath: command.packagePath });
        const packageJson = JSON.parse(readFileSync(join(command.packagePath, "package.json"), "utf8"));
        if (samePath(command.packagePath, stage) && scenario === "new-not-ready") {
          installed = { pluginKey: "polyforge", status: "starting", version: packageJson.version, packagePath: command.packagePath };
          response.end(JSON.stringify({ exitCode: 1, message: "fake readiness failure" }));
          return;
        }
        if (samePath(command.packagePath, stage) && scenario === "new-unexpected") {
          installed = { pluginKey: "polyforge", status: "starting", version: packageJson.version, packagePath: unexpected };
          response.end(JSON.stringify({ exitCode: 1, message: "fake unexpected path" }));
          return;
        }
        installed = { pluginKey: "polyforge", status: "ready", version: packageJson.version, packagePath: command.packagePath };
        response.end(JSON.stringify({ exitCode: 0 }));
        return;
      }
      response.statusCode = 400;
      response.end(JSON.stringify({ error: "unsupported fake CLI request" }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  t.after(() => new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose())));
  const address = server.address();

  const cli = join(directory, "paperclipai.mjs");
  writeFileSync(cli, `#!/usr/bin/env node
const [namespace, action, value] = process.argv.slice(2);
if (namespace !== "plugin") process.exit(2);
const payload = action === "list" ? { action } : { action, packagePath: value === "polyforge" ? undefined : value };
const response = await fetch(process.env.PAPERCLIP_API + "/__fake/cli", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(payload),
});
const result = await response.json();
if (result.message) process.stderr.write(result.message + "\\n");
process.exit(result.exitCode);
`);
  chmodSync(cli, 0o755);

  const result = await new Promise((resolveRun, rejectRun) => {
    const child = spawn(bash, [installer], {
      cwd: root,
      env: {
        ...process.env,
        PF_DATA_DIR: directory,
        POLYFORGE_PLUGIN_STAGE: stage,
        POLYFORGE_RUN_DIR: root,
        PAPERCLIP_BIN: cli,
        PAPERCLIP_API: `http://127.0.0.1:${address.port}`,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    const timeout = setTimeout(() => child.kill("SIGTERM"), 30_000);
    child.once("error", rejectRun);
    child.once("close", (status, signal) => {
      clearTimeout(timeout);
      resolveRun({ status, signal, stdout, stderr });
    });
  });
  return { result, actions, get installed() { return installed; }, previous, stage, unexpected };
}

test("the install script swaps to the exact verified stage when the CLI and host succeed", async (t) => {
  const run = await fixture(t);
  assert.equal(run.result.status, 0, `${run.result.stdout}\n${run.result.stderr}`);
  assert.deepEqual(run.actions.map(({ action }) => action), ["uninstall", "install"]);
  assert.equal(run.installed.status, "ready");
  assert.ok(samePath(run.installed.packagePath, run.stage));
  assert.match(run.result.stdout, /ready/);
});

test("a staged package that stays unready is removed and the previous verified build is restored", async (t) => {
  const run = await fixture(t, { scenario: "new-not-ready" });
  assert.notEqual(run.result.status, 0);
  assert.deepEqual(run.actions.map(({ action }) => action), ["uninstall", "install", "uninstall", "install"]);
  assert.ok(samePath(run.actions[0]?.packagePath, run.previous));
  assert.ok(samePath(run.actions[2]?.packagePath, run.stage));
  assert.ok(samePath(run.actions[3]?.packagePath, run.previous));
  assert.equal(run.installed.pluginKey, "polyforge");
  assert.equal(run.installed.status, "ready");
  assert.equal(run.installed.version, "0.0.9");
  assert.ok(samePath(run.installed.packagePath, run.previous));
  assert.match(run.result.stdout, /previous PolyForge installation restored/);
});

test("an unreadable previous package path refuses replacement before uninstall", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "polyforge-install-missing-prev-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const missingPrevious = join(directory, "missing-previous");
  const run = await fixture(t, { previousPath: missingPrevious });
  assert.notEqual(run.result.status, 0);
  assert.deepEqual(run.actions, []);
  assert.ok(samePath(run.installed.packagePath, missingPrevious));
  assert.match(run.result.stderr, /existing PolyForge package path is not locally readable/);
});

test("an unexpected path after an ambiguous install is left untouched for manual recovery", async (t) => {
  const run = await fixture(t, { scenario: "new-unexpected" });
  assert.notEqual(run.result.status, 0);
  assert.deepEqual(run.actions.map(({ action }) => action), ["uninstall", "install"]);
  assert.ok(samePath(run.installed.packagePath, run.unexpected));
  assert.match(run.result.stderr, /unreadable PolyForge path|unexpected PolyForge path/);
});
