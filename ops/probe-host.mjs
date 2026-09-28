#!/usr/bin/env node
/**
 * Phase 0 capability probe (docs/03-MIGRATION-ROLLOUT-ACCEPTANCE.md P0-4, V-01…V-14).
 *
 * Answers, against the *live* host, the questions whose answers decide whether a feature can
 * be enabled at all. It reads the installed SDK's published types and exports — the same
 * surface a plugin compiles against — and probes the running server for the routes it needs.
 *
 * The output is a report, not a gate. `ok: false` on a capability means the corresponding
 * feature must fail closed; it is not an error to be suppressed. Run with `--strict` to make
 * a missing security capability a non-zero exit.
 *
 *   node ops/probe-host.mjs [--api http://127.0.0.1:3100] [--sdk <path>] [--json <out>] [--strict]
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const API = flag("api", process.env.PAPERCLIP_API ?? "http://127.0.0.1:3100");
const SDK = resolve(
  flag(
    "sdk",
    "/home/pohlee/.npm/_npx/43414d9b790239bb/node_modules/@paperclipai/plugin-sdk",
  ),
);
const OUT = flag("json", null);
const STRICT = has("strict");

/** A capability the plugin depends on, and the consequence of its absence. */
const REQUIRED = {
  "events.subscribe": "routing and observation; without it nothing is admitted",
  "agent.tools.register": "the polyforge.* protocol surface",
  "issues.create": "materializing approved work as child issues",
  "issues.update": "projecting engineering status onto an issue",
  "issues.checkout": "asserting issue ownership before a mutation",
  "issues.wakeup": "asking the host to start a worker",
  "issue.relations.write": "blocker relations between work units",
  "issue.interactions.create": "the human-only decision carrier",
  "issue.interactions.read": "reading a resolved decision back",
  "agents.read": "capability-based worker selection",
  "approvals.read": "reconciling an authorization's current state",
  "http.outbound": "reaching the Runtime Service",
  "secrets.read-ref": "signing Runtime Service requests",
};

const FORBIDDEN = {
  "approvals.respond": "a plugin must not answer a human decision for a human",
  "issue.interactions.respond": "same, for the interaction carrier",
  "issue.comments.create_human_attributed": "a plugin must not forge human attribution",
  "access.members.write": "membership is not the bridge's business",
  "authorization.grants.write": "engineering policy may not widen platform grants",
  "authorization.policies.write": "same",
  "agents.invoke": "the host scheduler is the only invoker",
  "issue.attachments.read": "not needed; evidence is anchored on documents",
};

const report = { probedAt: new Date().toISOString(), api: API, sdk: SDK, sections: {} };

function section(name, value) {
  report.sections[name] = value;
  return value;
}

/** Read the SDK's shipped type declarations. The declarations *are* the contract. */
function readSdkSurface() {
  const typesPath = join(SDK, "dist/types.d.ts");
  if (!existsSync(typesPath)) {
    return { present: false, reason: `no SDK at ${SDK}` };
  }
  const types = readFileSync(typesPath, "utf8");
  const distDir = join(SDK, "dist");
  const hash = createHash("sha256");
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && full.endsWith(".js")) hash.update(readFileSync(full));
    }
  };
  walk(distDir);

  const ctxNames = [...types.matchAll(/^\s{4}([a-zA-Z][a-zA-Z0-9]*)[?:]/gm)].map((m) => m[1]);
  const clientMethods = new Set(
    [...types.matchAll(/^\s{4}(?:readonly\s+)?([a-zA-Z][a-zA-Z0-9]*)\s*\(/gm)].map((m) => m[1]),
  );
  const coreEvents = [...types.matchAll(/`([a-z_]+\.[a-z_.]+)`/g)].map((m) => m[1]);

  return {
    present: true,
    version: JSON.parse(readFileSync(join(SDK, "package.json"), "utf8")).version,
    distSha256: hash.digest("hex"),
    contextMembers: [...new Set(ctxNames)].sort(),
    clientMethodCount: clientMethods.size,
    declaredEventStrings: [...new Set(coreEvents)].sort(),
    sizeBytes: statSync(typesPath).size,
  };
}

async function probeServer() {
  const out = { reachable: false };
  const call = async (path, init) => {
    const response = await fetch(`${API}${path}`, { signal: AbortSignal.timeout(10_000), ...init });
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text.slice(0, 400);
    }
    return { status: response.status, body };
  };
  try {
    const health = await call("/api/health");
    out.reachable = health.status === 200;
    out.health = health.body;
    out.version = health.body?.version ?? null;
    out.deploymentMode = health.body?.deploymentMode ?? null;
  } catch (error) {
    out.error = String(error);
    return out;
  }

  // The routes the plugin's install, config, and health flows depend on.
  const routes = [
    ["GET", "/api/health"],
    ["GET", "/api/companies"],
    ["GET", "/api/plugins"],
    ["GET", "/api/plugins/ui-contributions"],
    ["GET", "/api/plugins/tools"],
    ["GET", "/api/issues?limit=1"],
  ];
  out.routes = {};
  for (const [method, path] of routes) {
    try {
      const result = await call(path, { method });
      out.routes[`${method} ${path}`] = { status: result.status, ok: result.status < 400 };
    } catch (error) {
      out.routes[`${method} ${path}`] = { status: 0, ok: false, error: String(error) };
    }
  }

  // An unsigned write must be refused. If it is not, the deployment has no auth on this route
  // and the pilot must not run against it.
  try {
    const probe = await call("/api/plugins/install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ packageName: "@polyforge/this-must-never-install" }),
    });
    out.unauthenticatedWrite = { status: probe.status, refused: probe.status >= 400 };
  } catch (error) {
    out.unauthenticatedWrite = { status: 0, refused: false, error: String(error) };
  }
  return out;
}

function readManifest() {
  const path = resolve("packages/paperclip-plugin/dist/manifest.js");
  if (!existsSync(path)) {
    return { present: false, reason: "plugin not built; run `npm run build --workspace @polyforge/paperclip-plugin`" };
  }
  return import(`file://${path}`).then((m) => m.default ?? m.manifest);
}

const sdk = section("sdk", readSdkSurface());
const server = section("server", await probeServer());

const manifest = await readManifest();
const declared = new Set(manifest?.capabilities ?? []);
section("manifest", {
  present: Boolean(manifest?.present !== false),
  id: manifest?.id ?? null,
  version: manifest?.version ?? null,
  apiVersion: manifest?.apiVersion ?? null,
  toolNames: (manifest?.tools ?? []).map((t) => manifest.id ? `${manifest.id}.${t.name}` : t.name),
  slotExportNames: (manifest?.ui?.slots ?? []).map((s) => s.exportName),
  jobs: (manifest?.jobs ?? []).map((j) => j.jobKey),
  declaredCapabilities: [...declared].sort(),
});

section("requiredCapabilities", Object.entries(REQUIRED).map(([capability, why]) => ({
  capability,
  why,
  declared: declared.has(capability),
})));

section("forbiddenCapabilities", Object.entries(FORBIDDEN).map(([capability, why]) => ({
  capability,
  why,
  declared: declared.has(capability),
  mustRemainAbsent: true,
})));

section("verdicts", {
  hostReachable: server.reachable,
  hostVersionMatchesSdk: server.version === sdk.version,
  unauthenticatedWriteRefused: server.unauthenticatedWrite?.refused === true,
  pluginBuildPresent: manifest?.present !== false,
  allRequiredCapabilitiesDeclared: Object.keys(REQUIRED).every((c) => declared.has(c)),
  noForbiddenCapabilityDeclared: Object.keys(FORBIDDEN).every((c) => !declared.has(c)),
});

const v = report.verdicts;
const blocking = [
  ["host reachable", v.hostReachable],
  ["host and SDK versions agree", v.hostVersionMatchesSdk],
  ["an unauthenticated write is refused", v.unauthenticatedWriteRefused],
  ["the plugin build is present", v.pluginBuildPresent],
  ["every required capability is declared", v.allRequiredCapabilitiesDeclared],
  ["no forbidden capability is declared", v.noForbiddenCapabilityDeclared],
].filter(([, ok]) => !ok);

report.summary = {
  ok: blocking.length === 0,
  blocking,
  note: "A missing capability fails closed: the corresponding feature is disabled, not downgraded to a weaker check.",
};

const text = JSON.stringify(report, null, 2);
if (OUT) {
  writeFileSync(OUT, `${text}\n`);
}
process.stdout.write(`${text}\n`);

if (STRICT && blocking.length > 0) {
  process.stderr.write(`\nprobe failed: ${blocking.map(([name]) => name).join("; ")}\n`);
  process.exit(1);
}
