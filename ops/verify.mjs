#!/usr/bin/env node
/**
 * Reproducible local verification for the repository's implemented surfaces.
 *
 * This is intentionally a local suite. The live Paperclip probe is separate because it reads the
 * configured host. By default it is GET-only and reports the unauthenticated-write check as
 * skipped. That POST requires explicit loopback opt-in; strict acceptance fails unless it is
 * actually run and refused. See the probe instructions before opting in.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const node = process.execPath;
const pluginDir = path.join(root, "packages", "paperclip-plugin");
const pythonCandidates = process.env.PYTHON ? [process.env.PYTHON] : ["python3", "python"];
const python = pythonCandidates.find((candidate) => {
  const result = spawnSync(candidate, ["--version"], { cwd: root, stdio: "ignore" });
  return result.status === 0;
});
const bashCandidates = process.env.BASH
  ? [process.env.BASH]
  : process.platform === "win32"
    ? ["C:\\Program Files\\Git\\bin\\bash.exe", "bash"]
    : ["bash"];
const bash = bashCandidates.find((candidate) => {
  const result = spawnSync(candidate, ["--version"], { cwd: root, stdio: "ignore" });
  return result.status === 0;
});

const checks = [
  ["Protocol typecheck", node, ["node_modules/typescript/bin/tsc", "-p", "packages/protocol/tsconfig.json", "--noEmit"]],
  ["Plugin worker typecheck", node, ["node_modules/typescript/bin/tsc", "-p", "packages/paperclip-plugin/tsconfig.json", "--noEmit"]],
  ["Plugin UI typecheck", node, ["node_modules/typescript/bin/tsc", "-p", "packages/paperclip-plugin/tsconfig.ui.json", "--noEmit"]],
  ["Protocol build", node, ["node_modules/typescript/bin/tsc", "-p", "packages/protocol/tsconfig.json"]],
  ["Plugin build", node, ["packages/paperclip-plugin/build.mjs"]],
  ["AT-01 architecture ownership boundaries", node, ["--test", "ops/architecture-boundaries.test.mjs"]],
  ["Host capability probe safety tests", node, ["--test", "ops/probe-host.test.mjs"]],
  ["Staged plugin integrity tests", node, ["--test", "ops/verify-staged-plugin.test.mjs"]],
  ["Plugin install target tests", node, ["--test", "ops/install-plugin-target.test.mjs"]],
  ["Plugin installer rollback tests", node, ["--test", "ops/install-plugin-script.test.mjs"]],
  ["Operational path safety tests", node, ["--test", "ops/px-safety.test.mjs"]],
  ["Operational shell syntax", bash ?? "<bash>", ["-n", "tools/px.sh", "tools/run-service.sh", "tools/stop-service.sh", "tools/pf-db.sh", "tools/stage-plugin.sh", "tools/install-plugin.sh"]],
  ["Paperclip plugin tests", node, ["--test", "--experimental-strip-types", "tests/**/*.test.ts"], pluginDir],
];

if (python) {
  checks.push(
    ["Graph library lock", python, ["ops/build-graph-library-lock.py", "--check"]],
    ["PolyForge Core and Runtime tests", python, ["-m", "unittest", "discover", "-s", "services/polyforge/tests", "-p", "test_*.py", "-t", ".", "-q"]],
  );
} else {
  checks.push(["Python test runtime", "<python3 or python>", []]);
}

let failed = false;
for (const [label, command, args, cwd = root] of checks) {
  process.stdout.write(`\n=== ${label} ===\n`);
  if (command === "<python3 or python>") {
    process.stderr.write("Set PYTHON to a Python 3 executable; the Core test suite uses only the standard library.\n");
    failed = true;
    continue;
  }
  if (command === "<bash>") {
    process.stderr.write("Set BASH to a Bash executable; operational scripts require Bash syntax validation.\n");
    failed = true;
    continue;
  }
  if (!existsSync(cwd)) {
    process.stderr.write(`Working directory does not exist: ${cwd}\n`);
    failed = true;
    continue;
  }
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, PYTHONPATH: [path.join(root, "services", "polyforge", "src"), process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) },
    stdio: "inherit",
  });
  if (result.error) {
    process.stderr.write(`${result.error.message}\n`);
    failed = true;
  } else if (result.status !== 0) {
    process.stderr.write(`${label} failed with exit code ${result.status ?? "unknown"}.\n`);
    failed = true;
  }
}

if (failed) {
  process.stderr.write("\nVerification did not pass. See the first failing section above.\n");
  process.exitCode = 1;
} else {
  process.stdout.write("\nAll local verification sections passed. This does not certify the live host or production deployment.\n");
}
