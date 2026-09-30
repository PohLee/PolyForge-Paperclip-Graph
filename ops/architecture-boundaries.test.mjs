import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function sourceFiles(directory, extension) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(absolute, extension);
      return entry.isFile() && entry.name.endsWith(extension) ? [absolute] : [];
    }),
  );
  return nested.flat();
}

test("AT-01: Paperclip and GraphStore ownership boundaries remain explicit", async (t) => {
  const pluginRoot = path.join(root, "packages", "paperclip-plugin");
  const coreRoot = path.join(root, "services", "polyforge", "src");
  const pluginPackage = JSON.parse(await readFile(path.join(pluginRoot, "package.json"), "utf8"));
  const pluginFiles = await sourceFiles(path.join(pluginRoot, "src"), ".ts");
  const coreFiles = await sourceFiles(coreRoot, ".py");

  await t.test("plugin's runtime dependencies stay on the wire protocol", () => {
    assert.deepEqual(Object.keys(pluginPackage.dependencies ?? {}).sort(), ["@polyforge/protocol"]);
    assert.equal(pluginPackage.dependencies["@polyforge/protocol"], "0.1.0");
  });

  await t.test("Core/Runtime source has no Paperclip SDK dependency", async () => {
    for (const file of coreFiles) {
      const source = await readFile(file, "utf8");
      assert.doesNotMatch(source, /@paperclipai\/plugin-sdk|paperclip_plugin_sdk/i, path.relative(root, file));
    }
  });

  await t.test("plugin source has no direct Core/GraphStore module import", async () => {
    const importPattern = /\b(?:from\s*|import\s*\()\s*["']([^"']+)["']/g;
    for (const file of pluginFiles) {
      const source = await readFile(file, "utf8");
      for (const match of source.matchAll(importPattern)) {
        const specifier = match[1];
        assert.doesNotMatch(
          specifier,
          /(?:^|\/)(?:polyforge\.core|graphstore|graph_store|services\/polyforge)(?:\/|$)|^@polyforge\/(?:core|graphstore)(?:\/|$)/i,
          `${path.relative(root, file)} imports ${specifier}`,
        );
      }
    }
  });

  await t.test("plugin has no evaluator registration operation", async () => {
    for (const file of pluginFiles) {
      const source = await readFile(file, "utf8");
      assert.doesNotMatch(
        source,
        /\b(?:registerEvaluator|register_evaluator|createEvaluatorRegistration|evaluatorRegistry\.register)\s*\(/,
        path.relative(root, file),
      );
    }
  });
});
