import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const bash = process.env.BASH ?? (process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash");

test("px refuses a run directory outside PF_DATA_DIR before it can clean anything", (t) => {
  const fixture = mkdtempSync(join(tmpdir(), "polyforge-px-safety-"));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));

  const data = join(fixture, "data");
  const outside = join(fixture, "outside");
  mkdirSync(join(outside, "tools"), { recursive: true });
  const sentinel = join(outside, "tools", "keep.txt");
  writeFileSync(sentinel, "preserve\n");

  const result = spawnSync(bash, [join(root, "tools", "px.sh"), "tools/stage-plugin.sh"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PF_DATA_DIR: data,
      POLYFORGE_RUN_DIR: outside,
      POLYFORGE_REPO_WSL: join(fixture, "missing-repository"),
    },
  });

  assert.notEqual(result.status, 0, "unsafe override must fail");
  assert.match(result.stderr, /run directory must be a child of PF_DATA_DIR/);
  assert.equal(readFileSync(sentinel, "utf8"), "preserve\n");
});
