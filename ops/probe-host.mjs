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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const API = flag("api", process.env.PAPERCLIP_API ?? "http://127.0.0.1:3100");
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SDK = resolve(flag("sdk", join(ROOT, "node_modules", "@paperclipai", "plugin-sdk")));
const COMPATIBILITY_LOCK = JSON.parse(readFileSync(join(ROOT, "ops", "compatibility-lock.json"), "utf8"));
const OUT = flag("json", null);
const STRICT = has("strict");
const PROBE_UNAUTHENTICATED_WRITE = has("probe-unauthenticated-write");

if (PROBE_UNAUTHENTICATED_WRITE) {
  let target;
  try {
    target = new URL(API);
  } catch {
    throw new Error("--api must be an absolute URL");
  }
  const loopback = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
  if (!loopback.has(target.hostname.toLowerCase())) {
    throw new Error(
      "the unauthenticated write probe is restricted to a loopback Paperclip host; use a separately reviewed procedure for any remote host",
    );
  }
}

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

function rowsFrom(body, key) {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.[key])) return body[key];
  return [];
}

function hasPinnedCommit(workspace) {
  const seen = new Set();
  const visit = (value, depth = 0) => {
    if (!value || typeof value !== "object" || depth > 5 || seen.has(value)) return false;
    seen.add(value);
    return Object.entries(value).some(([key, nested]) => {
      if (/^(commit|headCommit|resolvedCommit|pinnedCommit|currentCommit|checkoutCommit|commitSha)$/i.test(key) &&
          typeof nested === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(nested)) return true;
      return visit(nested, depth + 1);
    });
  };
  return visit(workspace);
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
  const interfaceMethods = (name) => {
    const match = types.match(new RegExp(`export interface ${name}\\s*\\{([\\s\\S]*?)^\\}`, "m"));
    if (!match) return [];
    return [...match[1].matchAll(/^\s{4}([a-zA-Z][a-zA-Z0-9]*)\s*\(/gm)].map((method) => method[1]).sort();
  };
  const agentMethods = interfaceMethods("PluginAgentsClient");
  const agentSessionMethods = interfaceMethods("PluginAgentSessionsClient");

  return {
    present: true,
    version: JSON.parse(readFileSync(join(SDK, "package.json"), "utf8")).version,
    distSha256: hash.digest("hex"),
    contextMembers: [...new Set(ctxNames)].sort(),
    clientMethodCount: clientMethods.size,
    agentControlSurface: {
      agentMethods,
      agentSessionMethods,
      exposesRunScopedCancel: /^(?:cancelRun|stopRun|cancel|stop)$/.test(agentMethods.join(" ")),
    },
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

  // OpenAPI is read-only and documents the declared auth contract of the plugin-install route.
  // This is deliberately separate from the opt-in POST below: a declaration is not proof that
  // local_trusted middleware enforces it at runtime.
  try {
    const openApi = await call("/api/openapi.json", { method: "GET" });
    const operation = openApi.body?.paths?.["/api/plugins/install"]?.post;
    const alternatives = Array.isArray(operation?.security)
      ? operation.security.map((alternative) => Object.keys(alternative ?? {}).sort())
      : [];
    out.installRouteDeclaredSecurity = {
      status: openApi.status,
      available: openApi.status === 200 && operation !== undefined,
      alternatives,
      declaresAuthentication: alternatives.length > 0 && alternatives.every((schemes) => schemes.length > 0),
    };
    const pluginConfigOperation = openApi.body?.paths?.["/api/plugins/{pluginId}/config"]?.post;
    const pluginConfigSecurity = Array.isArray(pluginConfigOperation?.security)
      ? pluginConfigOperation.security.map((alternative) => Object.keys(alternative ?? {}).sort())
      : [];
    out.pluginConfigWriteRoute = {
      status: openApi.status,
      present: pluginConfigOperation !== undefined,
      securityAlternatives: pluginConfigSecurity,
      declaresAuthentication: pluginConfigSecurity.length > 0 && pluginConfigSecurity.every((schemes) => schemes.length > 0),
      source: "OpenAPI declaration only; does not establish admin-only access, effective authorization, or runtime enforcement",
    };
    const cancelOperation = openApi.body?.paths?.["/api/heartbeat-runs/{runId}/cancel"]?.post;
    const cancelSecurity = Array.isArray(cancelOperation?.security)
      ? cancelOperation.security.map((alternative) => Object.keys(alternative ?? {}).sort())
      : [];
    out.heartbeatRunCancelRoute = {
      status: openApi.status,
      available: openApi.status === 200 && cancelOperation !== undefined,
      method: cancelOperation ? "POST" : null,
      securityAlternatives: cancelSecurity,
      source: "OpenAPI declaration only; not evidence this plugin has a supported credential or capability to call it",
    };
    const routeDeclaration = (path, method) => {
      const routeOperation = openApi.body?.paths?.[path]?.[method.toLowerCase()];
      const securityAlternatives = Array.isArray(routeOperation?.security)
        ? routeOperation.security.map((alternative) => Object.keys(alternative ?? {}).sort())
        : [];
      return {
        present: routeOperation !== undefined,
        securityAlternatives,
        declaresAuthentication: securityAlternatives.length > 0 && securityAlternatives.every((schemes) => schemes.length > 0),
      };
    };
    out.toolGovernanceRoutes = {
      actionRequestList: routeDeclaration("/api/companies/{companyId}/tools/action-requests", "GET"),
      trustRuleCreate: routeDeclaration(
        "/api/companies/{companyId}/tools/action-requests/{actionRequestId}/trust-rule",
        "POST",
      ),
      gatewayActionApprove: routeDeclaration("/api/tool-gateway/action-requests/{id}/approve", "POST"),
      gatewayActionDecline: routeDeclaration("/api/tool-gateway/action-requests/{id}/decline", "POST"),
      approvalDecide: routeDeclaration("/api/approvals/{id}/approve", "POST"),
      source: "OpenAPI route declarations only; not proof of plugin capabilities, effective grants, or runtime enforcement",
    };
  } catch (error) {
    out.installRouteDeclaredSecurity = {
      status: 0,
      available: false,
      alternatives: [],
      declaresAuthentication: false,
      error: String(error),
    };
    out.pluginConfigWriteRoute = {
      status: 0,
      present: false,
      securityAlternatives: [],
      declaresAuthentication: false,
      source: "OpenAPI declaration unavailable",
    };
    out.heartbeatRunCancelRoute = {
      status: 0,
      available: false,
      method: null,
      securityAlternatives: [],
      source: "OpenAPI declaration unavailable",
    };
    out.toolGovernanceRoutes = {
      actionRequestList: { present: false, securityAlternatives: [], declaresAuthentication: false },
      trustRuleCreate: { present: false, securityAlternatives: [], declaresAuthentication: false },
      gatewayActionApprove: { present: false, securityAlternatives: [], declaresAuthentication: false },
      gatewayActionDecline: { present: false, securityAlternatives: [], declaresAuthentication: false },
      approvalDecide: { present: false, securityAlternatives: [], declaresAuthentication: false },
      source: "OpenAPI unavailable",
    };
  }

  try {
    const pluginsResult = await call("/api/plugins", { method: "GET" });
    const plugins = Array.isArray(pluginsResult.body)
      ? pluginsResult.body
      : Array.isArray(pluginsResult.body?.plugins)
        ? pluginsResult.body.plugins
        : [];
    const polyforge = plugins.find((plugin) => plugin?.pluginKey === "polyforge");
    if (polyforge) {
      const exposedFields = Object.keys(polyforge);
      out.installedPolyForge = {
        found: true,
        status: typeof polyforge.status === "string" ? polyforge.status : null,
        version: typeof polyforge.version === "string" ? polyforge.version : null,
        packagePath: typeof polyforge.packagePath === "string" ? polyforge.packagePath : null,
        exposesCapabilityGrantMetadata: exposedFields.some((field) =>
          /^(grantedCapabilities|capabilityGrants|permissionGrants)$/i.test(field),
        ),
      };
    } else {
      out.installedPolyForge = { found: false, status: null, version: null, packagePath: null };
    }
  } catch (error) {
    out.installedPolyForge = { found: false, error: String(error) };
  }

  // Static adapter configuration references expose no per-agent config or secrets. Record only
  // availability and a digest; this proves the host can document both Hermes choices, not that
  // any company has a configured agent or that its runtime/cancellation behavior is verified.
  out.hermesAdapterConfigReferences = {};
  for (const adapterType of ["hermes_local", "hermes_gateway"]) {
    const route = `/llms/agent-configuration/${adapterType}.txt`;
    try {
      const response = await fetch(`${API}${route}`, { signal: AbortSignal.timeout(10_000) });
      const body = Buffer.from(await response.arrayBuffer());
      const sha256 = createHash("sha256").update(body).digest("hex");
      const pinnedSha256 = COMPATIBILITY_LOCK.hermesAdapter?.configurationReferenceSha256?.[adapterType] ?? null;
      out.hermesAdapterConfigReferences[adapterType] = {
        status: response.status,
        available: response.status === 200,
        sha256,
        pinnedSha256,
        matchesPinnedHash: pinnedSha256 === null ? null : pinnedSha256 === sha256,
      };
    } catch (error) {
      out.hermesAdapterConfigReferences[adapterType] = {
        status: 0,
        available: false,
        error: String(error),
      };
    }
  }

  // `codex_local` is the adapterType on every agent profile observed in this host snapshot.
  // Pin its config reference too, while keeping the report free of any agent-specific config.
  out.codexLocalAdapterConfigReference = {};
  const codexLocalRoute = "/llms/agent-configuration/codex_local.txt";
  try {
    const response = await fetch(`${API}${codexLocalRoute}`, { signal: AbortSignal.timeout(10_000) });
    const body = Buffer.from(await response.arrayBuffer());
    const sha256 = createHash("sha256").update(body).digest("hex");
    const pinnedSha256 = COMPATIBILITY_LOCK.codexLocalAdapter?.configurationReferenceSha256 ?? null;
    out.codexLocalAdapterConfigReference = {
      status: response.status,
      available: response.status === 200,
      sha256,
      pinnedSha256,
      matchesPinnedHash: pinnedSha256 === null ? null : pinnedSha256 === sha256,
    };
  } catch (error) {
    out.codexLocalAdapterConfigReference = {
      status: 0,
      available: false,
      error: String(error),
    };
  }

  // Issue and agent listing are company-scoped in this host release. Probe each company's
  // read surface without recording tenant IDs. Agent adapter types are aggregated only: names,
  // IDs, adapter configs and capability profiles are intentionally omitted from the report.
  try {
    const companiesResult = await call("/api/companies", { method: "GET" });
    const companies = Array.isArray(companiesResult.body)
      ? companiesResult.body
      : Array.isArray(companiesResult.body?.companies)
        ? companiesResult.body.companies
        : [];
    const companyId = companies.find((company) => typeof company?.id === "string")?.id;
    if (typeof companyId !== "string") {
      out.routes["GET /api/companies/{companyId}/issues?limit=1"] = {
        status: 0,
        ok: false,
        reason: "no readable company id was returned",
      };
      out.companyAgentAdapters = {
        companyCount: companies.length,
        readableCompanyCount: 0,
        unreadableCompanyCount: companies.length,
        totalAgentCount: 0,
        adapterTypeCounts: {},
        unclassifiedCount: 0,
      };
      out.workspaceInventory = emptyWorkspaceInventory(companies.length);
    } else {
      const result = await call(`/api/companies/${encodeURIComponent(companyId)}/issues?limit=1`, { method: "GET" });
      out.routes["GET /api/companies/{companyId}/issues?limit=1"] = {
        status: result.status,
        ok: result.status < 400,
      };

      const adapterTypeCounts = new Map();
      let readableCompanyCount = 0;
      let unreadableCompanyCount = 0;
      let totalAgentCount = 0;
      let unclassifiedCount = 0;
      for (const company of companies) {
        if (typeof company?.id !== "string") {
          unreadableCompanyCount += 1;
          continue;
        }
        try {
          const agentsResult = await call(`/api/companies/${encodeURIComponent(company.id)}/agents`, { method: "GET" });
          if (agentsResult.status >= 400) {
            unreadableCompanyCount += 1;
            continue;
          }
          readableCompanyCount += 1;
          const agents = Array.isArray(agentsResult.body)
            ? agentsResult.body
            : Array.isArray(agentsResult.body?.agents)
              ? agentsResult.body.agents
              : [];
          totalAgentCount += agents.length;
          for (const agent of agents) {
            const adapterType = typeof agent?.adapterType === "string" && agent.adapterType.length > 0
              ? agent.adapterType
              : null;
            if (adapterType === null) {
              unclassifiedCount += 1;
              continue;
            }
            adapterTypeCounts.set(adapterType, (adapterTypeCounts.get(adapterType) ?? 0) + 1);
          }
        } catch {
          unreadableCompanyCount += 1;
        }
      }
      out.routes["GET /api/companies/{companyId}/agents"] = {
        status: unreadableCompanyCount === 0 ? 200 : 0,
        ok: unreadableCompanyCount === 0,
        readableCompanyCount,
        unreadableCompanyCount,
      };
      out.companyAgentAdapters = {
        companyCount: companies.length,
        readableCompanyCount,
        unreadableCompanyCount,
        totalAgentCount,
        adapterTypeCounts: Object.fromEntries([...adapterTypeCounts.entries()].sort(([a], [b]) => a.localeCompare(b))),
        unclassifiedCount,
      };

      const projectSourceTypeCounts = new Map();
      const executionProviderTypeCounts = new Map();
      const executionModeCounts = new Map();
      const executionStatusCounts = new Map();
      const executionDeliveryStateCounts = new Map();
      const projectIds = [];
      let readableProjectCompanies = 0;
      let unreadableProjectCompanies = 0;
      let projectWorkspaceCount = 0;
      let readableProjectWorkspaceLists = 0;
      let unreadableProjectWorkspaceLists = 0;
      let readableExecutionCompanies = 0;
      let unreadableExecutionCompanies = 0;
      let executionWorkspaceCount = 0;
      let executionWorkspaceWithSourceIssueCount = 0;
      let executionWorkspaceWithCwdCount = 0;
      let executionWorkspaceWithRepoCoordinatesCount = 0;
      let executionWorkspaceWithPinnedCommitCount = 0;
      let readableExecutionWorkspaceDetails = 0;
      let unreadableExecutionWorkspaceDetails = 0;
      let executionWorkspaceDetailsWithPinnedCommitCount = 0;
      const count = (map, value) => {
        const key = typeof value === "string" && value.length > 0 ? value : "(unclassified)";
        map.set(key, (map.get(key) ?? 0) + 1);
      };
      for (const company of companies) {
        if (typeof company?.id !== "string") {
          unreadableProjectCompanies += 1;
          unreadableExecutionCompanies += 1;
          continue;
        }
        try {
          const projectsResult = await call(`/api/companies/${encodeURIComponent(company.id)}/projects`, { method: "GET" });
          if (projectsResult.status >= 400) {
            unreadableProjectCompanies += 1;
          } else {
            readableProjectCompanies += 1;
            for (const project of rowsFrom(projectsResult.body, "projects")) {
              if (typeof project?.id === "string") projectIds.push(project.id);
            }
          }
        } catch {
          unreadableProjectCompanies += 1;
        }
        try {
          const executionResult = await call(`/api/companies/${encodeURIComponent(company.id)}/execution-workspaces`, { method: "GET" });
          if (executionResult.status >= 400) {
            unreadableExecutionCompanies += 1;
          } else {
            readableExecutionCompanies += 1;
            const workspaces = rowsFrom(executionResult.body, "workspaces");
            executionWorkspaceCount += workspaces.length;
            for (const workspace of workspaces) {
              count(executionProviderTypeCounts, workspace?.providerType);
              count(executionModeCounts, workspace?.mode);
              count(executionStatusCounts, workspace?.status);
              count(executionDeliveryStateCounts, workspace?.deliveryState);
              if (typeof workspace?.sourceIssueId === "string" && workspace.sourceIssueId.length > 0) {
                executionWorkspaceWithSourceIssueCount += 1;
              }
              if (typeof workspace?.cwd === "string" && workspace.cwd.length > 0) {
                executionWorkspaceWithCwdCount += 1;
              }
              if ([workspace?.repoUrl, workspace?.baseRef].some((value) => typeof value === "string" && value.length > 0)) {
                executionWorkspaceWithRepoCoordinatesCount += 1;
              }
              if (hasPinnedCommit(workspace)) executionWorkspaceWithPinnedCommitCount += 1;
              if (typeof workspace?.id === "string") {
                try {
                  const detailResult = await call(`/api/execution-workspaces/${encodeURIComponent(workspace.id)}`, { method: "GET" });
                  if (detailResult.status >= 400) {
                    unreadableExecutionWorkspaceDetails += 1;
                  } else {
                    readableExecutionWorkspaceDetails += 1;
                    const detail = detailResult.body?.workspace ?? detailResult.body;
                    if (hasPinnedCommit(detail)) executionWorkspaceDetailsWithPinnedCommitCount += 1;
                  }
                } catch {
                  unreadableExecutionWorkspaceDetails += 1;
                }
              } else {
                unreadableExecutionWorkspaceDetails += 1;
              }
            }
          }
        } catch {
          unreadableExecutionCompanies += 1;
        }
      }

      for (const projectId of projectIds) {
        try {
          const workspacesResult = await call(`/api/projects/${encodeURIComponent(projectId)}/workspaces`, { method: "GET" });
          if (workspacesResult.status >= 400) {
            unreadableProjectWorkspaceLists += 1;
            continue;
          }
          readableProjectWorkspaceLists += 1;
          const workspaces = rowsFrom(workspacesResult.body, "workspaces");
          projectWorkspaceCount += workspaces.length;
          for (const workspace of workspaces) count(projectSourceTypeCounts, workspace?.sourceType);
        } catch {
          unreadableProjectWorkspaceLists += 1;
        }
      }

      const sortedCounts = (map) => Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
      out.routes["GET /api/companies/{companyId}/projects"] = {
        status: unreadableProjectCompanies === 0 ? 200 : 0,
        ok: unreadableProjectCompanies === 0,
        readableCompanyCount: readableProjectCompanies,
        unreadableCompanyCount: unreadableProjectCompanies,
      };
      out.routes["GET /api/projects/{projectId}/workspaces"] = {
        status: unreadableProjectWorkspaceLists === 0 ? 200 : 0,
        ok: unreadableProjectWorkspaceLists === 0,
        readableProjectCount: readableProjectWorkspaceLists,
        unreadableProjectCount: unreadableProjectWorkspaceLists,
      };
      out.routes["GET /api/companies/{companyId}/execution-workspaces"] = {
        status: unreadableExecutionCompanies === 0 ? 200 : 0,
        ok: unreadableExecutionCompanies === 0,
        readableCompanyCount: readableExecutionCompanies,
        unreadableCompanyCount: unreadableExecutionCompanies,
      };
      out.routes["GET /api/execution-workspaces/{id}"] = {
        status: unreadableExecutionWorkspaceDetails === 0 ? 200 : 0,
        ok: unreadableExecutionWorkspaceDetails === 0,
        readableWorkspaceCount: readableExecutionWorkspaceDetails,
        unreadableWorkspaceCount: unreadableExecutionWorkspaceDetails,
      };
      out.workspaceInventory = {
        companyCount: companies.length,
        projectCount: projectIds.length,
        readableProjectCompanies,
        unreadableProjectCompanies,
        projectWorkspaceCount,
        readableProjectWorkspaceLists,
        unreadableProjectWorkspaceLists,
        projectWorkspaceSourceTypeCounts: sortedCounts(projectSourceTypeCounts),
        executionWorkspaceCount,
        executionWorkspaceWithSourceIssueCount,
        executionWorkspaceWithCwdCount,
        executionWorkspaceWithRepoCoordinatesCount,
        executionWorkspaceWithPinnedCommitCount,
        readableExecutionWorkspaceDetails,
        unreadableExecutionWorkspaceDetails,
        executionWorkspaceDetailsWithPinnedCommitCount,
        readableExecutionCompanies,
        unreadableExecutionCompanies,
        executionWorkspaceProviderTypeCounts: sortedCounts(executionProviderTypeCounts),
        executionWorkspaceModeCounts: sortedCounts(executionModeCounts),
        executionWorkspaceStatusCounts: sortedCounts(executionStatusCounts),
        executionWorkspaceDeliveryStateCounts: sortedCounts(executionDeliveryStateCounts),
      };
    }
  } catch (error) {
    out.routes["GET /api/companies/{companyId}/issues?limit=1"] = {
      status: 0,
      ok: false,
      error: String(error),
    };
    out.companyAgentAdapters = {
      companyCount: 0,
      readableCompanyCount: 0,
      unreadableCompanyCount: 0,
      totalAgentCount: 0,
      adapterTypeCounts: {},
      unclassifiedCount: 0,
      error: String(error),
    };
    out.workspaceInventory = { ...emptyWorkspaceInventory(0), error: String(error) };
  }

  // This deliberately attempts a write and therefore requires an explicit opt-in. A default
  // capability report must be safe to run against a real local instance without installing or
  // mutating anything if the host's local-trusted mode accepts unauthenticated requests.
  if (PROBE_UNAUTHENTICATED_WRITE) {
    try {
      const probe = await call("/api/plugins/install", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ packageName: "@polyforge/this-must-never-install" }),
      });
      out.unauthenticatedWrite = { status: probe.status, refused: probe.status >= 400, skipped: false };
    } catch (error) {
      out.unauthenticatedWrite = { status: 0, refused: false, skipped: false, error: String(error) };
    }
  } else {
    out.unauthenticatedWrite = {
      status: null,
      refused: null,
      skipped: true,
      reason: "requires explicit --probe-unauthenticated-write opt-in; no write request was sent",
    };
  }
  return out;
}

function emptyWorkspaceInventory(companyCount) {
  return {
    companyCount,
    projectCount: 0,
    readableProjectCompanies: 0,
    unreadableProjectCompanies: companyCount,
    projectWorkspaceCount: 0,
    readableProjectWorkspaceLists: 0,
    unreadableProjectWorkspaceLists: 0,
    projectWorkspaceSourceTypeCounts: {},
    executionWorkspaceCount: 0,
    executionWorkspaceWithSourceIssueCount: 0,
    executionWorkspaceWithCwdCount: 0,
    executionWorkspaceWithRepoCoordinatesCount: 0,
    executionWorkspaceWithPinnedCommitCount: 0,
    readableExecutionWorkspaceDetails: 0,
    unreadableExecutionWorkspaceDetails: companyCount,
    executionWorkspaceDetailsWithPinnedCommitCount: 0,
    readableExecutionCompanies: 0,
    unreadableExecutionCompanies: companyCount,
    executionWorkspaceProviderTypeCounts: {},
    executionWorkspaceModeCounts: {},
    executionWorkspaceStatusCounts: {},
    executionWorkspaceDeliveryStateCounts: {},
  };
}

function readManifest() {
  const path = resolve(ROOT, "packages/paperclip-plugin/dist/manifest.js");
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

const verdicts = section("verdicts", {
  hostReachable: server.reachable,
  hostVersionMatchesSdk: server.version === sdk.version,
  installedPolyForgeReady: server.installedPolyForge?.status === "ready",
  installedPolyForgePackageVersionMatchesSource: server.installedPolyForge?.version === manifest?.version,
  hostExposesPolyForgeCapabilityGrants: server.installedPolyForge?.exposesCapabilityGrantMetadata === true,
  companyAgentProfilesReadable: server.routes?.["GET /api/companies/{companyId}/agents"]?.ok === true,
  projectInventoryReadable: server.routes?.["GET /api/companies/{companyId}/projects"]?.ok === true,
  projectWorkspaceInventoryReadable: server.routes?.["GET /api/projects/{projectId}/workspaces"]?.ok === true,
  executionWorkspaceInventoryReadable: server.routes?.["GET /api/companies/{companyId}/execution-workspaces"]?.ok === true,
  executionWorkspaceDetailsReadable: server.routes?.["GET /api/execution-workspaces/{id}"]?.ok === true,
  installRouteDeclaresAuthentication: server.installRouteDeclaredSecurity?.declaresAuthentication === true,
  // The pinned 2026.916.1 server route calls assertInstanceAdmin, but in local_trusted mode the
  // host synthesizes every request as a local_implicit instance admin. Authentication therefore
  // isolates the plugin-config grant surface only when the host runs authenticated. This is a
  // configuration verdict, not a live authorization test; the explicit write probe is separate.
  pluginConfigGrantBoundarySafe:
    server.deploymentMode === "authenticated" && server.pluginConfigWriteRoute?.declaresAuthentication === true,
  unauthenticatedWriteRefused: server.unauthenticatedWrite?.refused === true,
  unauthenticatedWriteProbeExecuted: PROBE_UNAUTHENTICATED_WRITE,
  pluginBuildPresent: manifest?.present !== false,
  allRequiredCapabilitiesDeclared: Object.keys(REQUIRED).every((c) => declared.has(c)),
  noForbiddenCapabilityDeclared: Object.keys(FORBIDDEN).every((c) => !declared.has(c)),
});

const blocking = [
  ["host reachable", verdicts.hostReachable],
  ["host and SDK versions agree", verdicts.hostVersionMatchesSdk],
  ["installed PolyForge plugin is ready", verdicts.installedPolyForgeReady],
  ["installed plugin package version matches this source", verdicts.installedPolyForgePackageVersionMatchesSource],
  ["company-scoped Agent profiles are readable", verdicts.companyAgentProfilesReadable],
  ["company-scoped projects are readable", verdicts.projectInventoryReadable],
  ["project workspace lists are readable", verdicts.projectWorkspaceInventoryReadable],
  ["company execution workspaces are readable", verdicts.executionWorkspaceInventoryReadable],
  ["execution workspace details are readable", verdicts.executionWorkspaceDetailsReadable],
  ["plugin install route declares authentication", verdicts.installRouteDeclaresAuthentication],
  ["plugin config capability grants have an authenticated admin boundary", verdicts.pluginConfigGrantBoundarySafe],
  ["an unauthenticated write is refused (explicit opt-in probe)", verdicts.unauthenticatedWriteRefused],
  ["the plugin build is present", verdicts.pluginBuildPresent],
  ["every required capability is declared", verdicts.allRequiredCapabilitiesDeclared],
  ["no forbidden capability is declared", verdicts.noForbiddenCapabilityDeclared],
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
