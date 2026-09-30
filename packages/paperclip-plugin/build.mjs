/**
 * Build the plugin: manifest, worker, and the single-file UI bundle.
 *
 * The host loads `dist/worker.js` with `node` and `dist/ui/index.js` in the browser. The UI
 * bundle must be self-contained: the host only shims `react`, `react-dom`,
 * `react/jsx-runtime`, and `@paperclipai/plugin-sdk/ui`, so every other import has to be
 * inlined here. See `createPluginBundlerPresets` in the SDK for the host contract.
 */

import { build } from "esbuild";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes("--watch");
const dev = process.argv.includes("--dev") || watch;

const UI_EXTERNALS = [
  "react",
  "react-dom",
  "react-dom/client",
  "react/jsx-runtime",
  "@paperclipai/plugin-sdk/ui",
  "@paperclipai/plugin-sdk/ui/hooks",
];

const common = {
  bundle: true,
  format: "esm",
  logLevel: "info",
  sourcemap: true,
  minify: !dev,
  define: { "process.env.NODE_ENV": JSON.stringify(dev ? "development" : "production") },
};

await rm(path.join(root, "dist"), { recursive: true, force: true });
await mkdir(path.join(root, "dist"), { recursive: true });

const targets = [
  {
    ...common,
    entryPoints: [path.join(root, "src/manifest.ts")],
    outfile: path.join(root, "dist/manifest.js"),
    platform: "node",
    target: "node24",
  },
  {
    ...common,
    entryPoints: [path.join(root, "src/worker.ts")],
    outfile: path.join(root, "dist/worker.js"),
    platform: "node",
    target: "node24",
    external: ["react", "react-dom"],
  },
  {
    ...common,
    entryPoints: [path.join(root, "src/ui/index.tsx")],
    outfile: path.join(root, "dist/ui/index.js"),
    // Keep the UI build's JSX runtime aligned with tsconfig.ui.json. Without
    // this, esbuild reads tsconfig.json (which has no JSX setting) and emits
    // React.createElement calls, but the host only provides the automatic JSX
    // runtime module and never installs a global React variable.
    tsconfig: path.join(root, "tsconfig.ui.json"),
    // The host rewrites bare imports in the UI bundle before importing it. Its
    // loader matches the readable `from "react"` form, so keep this bundle
    // unminified (the SDK bundler preset also defaults to minify: false).
    minify: false,
    platform: "browser",
    target: "es2022",
    external: UI_EXTERNALS,
  },
];

if (watch) {
  const { context } = await import("esbuild");
  const contexts = await Promise.all(targets.map((t) => context(t)));
  await Promise.all(contexts.map((c) => c.watch()));
  console.log("esbuild watching…");
} else {
  await Promise.all(targets.map((t) => build(t)));
  console.log("plugin build complete");
}
