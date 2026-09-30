import { readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function rowsFrom(body) {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.plugins)) return body.plugins;
  throw new Error("Paperclip plugin list response has an unsupported shape");
}

export async function checkInstallTarget(mode, api, stage) {
  if (mode !== "preflight" && mode !== "verify") throw new Error(`unknown mode: ${mode}`);
  const packageJson = JSON.parse(readFileSync(join(stage, "package.json"), "utf8"));
  const expectedPath = realpathSync(stage);
  const base = new URL(api);
  base.pathname = base.pathname.replace(/\/$/, "");

  const get = async (route) => {
    const response = await fetch(new URL(route, base), { signal: AbortSignal.timeout(5_000) });
    const text = await response.text();
    if (!response.ok) throw new Error(`Paperclip ${route} returned HTTP ${response.status}`);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Paperclip ${route} returned invalid JSON`);
    }
  };

  const health = await get("/api/health");
  if (health?.status !== "ok") throw new Error("Paperclip health is not ready");
  const plugins = rowsFrom(await get("/api/plugins"));
  const plugin = plugins.find((row) => row?.pluginKey === "polyforge");
  if (mode === "preflight") {
    return {
      ready: true,
      installed: Boolean(plugin),
      plugin: plugin
        ? {
            status: typeof plugin.status === "string" ? plugin.status : null,
            version: typeof plugin.version === "string" ? plugin.version : null,
            packagePath: typeof plugin.packagePath === "string" ? plugin.packagePath : null,
          }
        : null,
    };
  }
  if (!plugin) throw new Error("Paperclip does not report the PolyForge plugin as installed");
  if (plugin.status !== "ready") throw new Error(`PolyForge status is ${String(plugin.status)}, not ready`);
  if (plugin.version !== packageJson.version) {
    throw new Error(`installed version ${String(plugin.version)} does not match staged version ${packageJson.version}`);
  }
  if (typeof plugin.packagePath !== "string" || resolve(plugin.packagePath) !== expectedPath) {
    throw new Error(`installed package path does not match staged path ${expectedPath}`);
  }
  return { ready: true, installed: true, version: plugin.version, packagePath: plugin.packagePath };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , mode, api, stage] = process.argv;
  if (!mode || !api || !stage) throw new Error("usage: node ops/install-plugin-target.mjs <preflight|verify> <paperclip-api> <stage>");
  checkInstallTarget(mode, api, stage)
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}
