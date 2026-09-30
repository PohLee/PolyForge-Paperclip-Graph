#!/usr/bin/env node
/** Verify a staged plugin completely before an installer touches the live host. */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("usage: node ops/verify-staged-plugin.mjs <stage-directory>");

const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
if (packageJson.name !== "@polyforge/paperclip-plugin" || packageJson.paperclipPlugin?.manifest !== "dist/manifest.js" ||
    packageJson.paperclipPlugin?.worker !== "dist/worker.js" || packageJson.paperclipPlugin?.ui !== "dist/ui") {
  throw new Error("staged package identity or Paperclip entrypoints do not match the PolyForge plugin");
}

const build = JSON.parse(readFileSync(join(root, "staged-build.json"), "utf8"));
const requiredFiles = ["dist/worker.js", "dist/manifest.js", "dist/ui/index.js"];
for (const file of requiredFiles) {
  const expected = build.files?.[file];
  if (typeof expected !== "string" || !/^[0-9a-f]{64}$/.test(expected)) {
    throw new Error(`staged build has no valid SHA-256 digest for ${file}`);
  }
  const actual = createHash("sha256").update(readFileSync(join(root, file))).digest("hex");
  if (actual !== expected) throw new Error(`staged digest mismatch: ${file}`);
}

process.stdout.write(`verified staged PolyForge plugin ${packageJson.version}\n`);
