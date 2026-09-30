import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const verifier = join(root, "ops", "verify-staged-plugin.mjs");

function stagedFixture() {
  const dir = mkdtempSync(join(tmpdir(), "polyforge-stage-check-"));
  const files = ["dist/worker.js", "dist/manifest.js", "dist/ui/index.js"];
  const contents = new Map(files.map((file) => [file, `fixture:${file}`]));
  for (const [file, value] of contents) {
    const target = join(dir, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, value);
  }
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name: "@polyforge/paperclip-plugin",
    version: "0.1.0",
    paperclipPlugin: { manifest: "dist/manifest.js", worker: "dist/worker.js", ui: "dist/ui" },
  }));
  const digests = Object.fromEntries([...contents].map(([file, value]) => [
    file,
    createHash("sha256").update(value).digest("hex"),
  ]));
  writeFileSync(join(dir, "staged-build.json"), JSON.stringify({ files: digests }));
  return dir;
}

test("staged plugin verifier accepts the exact staged bundle", () => {
  const dir = stagedFixture();
  try {
    const result = spawnSync(process.execPath, [verifier, dir], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /verified staged PolyForge plugin 0\.1\.0/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("staged plugin verifier rejects a changed bundle before installation", () => {
  const dir = stagedFixture();
  try {
    writeFileSync(join(dir, "dist", "worker.js"), "tampered worker");
    const result = spawnSync(process.execPath, [verifier, dir], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /staged digest mismatch: dist\/worker\.js/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
