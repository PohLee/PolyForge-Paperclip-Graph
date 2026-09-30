/**
 * Plugin manifest for the PolyForge control-plane bridge.
 *
 * Two decisions here are load-bearing and must not be relaxed casually:
 *
 * 1. **The plugin id is `polyforge` so registered tools namespace to `polyforge.*`.** The
 *    host prefixes tool names with the plugin id, which is exactly the tool surface the
 *    specification names. Renaming the id renames the agent-facing API.
 *
 * 2. **Capabilities are the minimum the bridge can actually honour, and the two it must
 *    never hold are absent.** `approvals.respond` and `issue.interactions.respond` are
 *    deliberately not requested: a plugin must not be able to answer a human decision on
 *    a human's behalf. Human decisions are made in the Paperclip UI by a real person, and
 *    the bridge re-reads the authoritative object afterwards. The same reasoning excludes
 *    `issue.comments.create_human_attributed`, `access.*.write`, `authorization.*.write`,
 *    `agents.invoke`, and `agent.sessions.*`.
 *
 *    `secrets.read-ref` *is* requested, because the bridge must sign its Runtime Service
 *    requests with an operator-provisioned shared secret. It grants reference resolution
 *    only: the value is resolved per request, is never cached, never logged, and never
 *    written to the bridge store.
 *
 * The manifest is validated by the host's `pluginManifestV1Schema` at install time, so a
 * field this file gets wrong fails installation rather than failing quietly at runtime.
 */

import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "polyforge",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "PolyForge Engineering Graph",
  description:
    "Durable engineering-graph orchestration for Paperclip: versioned graph definitions, transition contracts, gates, evidence, and independent review. Paperclip stays the control plane for issues, agents, workspaces, budgets, and platform authorization.",
  author: "PolyForge",
  categories: ["automation", "ui"],
  // No `minimumHostVersion`. The host compares that field against
  // `runtimeServices.instanceInfo.hostVersion`, which its published CLI build leaves at the
  // literal default `"0.0.0"` because the CI build-version stamp is not in the npm tarball
  // (`@paperclipai/server/dist/app.js`: `hostVersion: opts.hostVersion ?? "0.0.0"`). A floor
  // compared against `0.0.0` is not a check — it would refuse installation on every correctly
  // configured deployment of this build while proving nothing about the real host.
  //
  // What actually enforces compatibility is *capability gating*, and it is enforced at runtime
  // rather than declared: every host API this bridge uses is capability-checked by the host, and
  // a missing capability surfaces as a named refusal that degrades the feature instead of
  // silently weakening it. `ops/compatibility-lock.json` records the host version that was
  // probed, and `ops/probe-host.mjs` re-reads it on every upgrade.

  capabilities: [
    // Runtime plumbing.
    "events.subscribe",
    "http.outbound",
    "jobs.schedule",
    "plugin.state.read",
    "plugin.state.write",
    "metrics.write",
    "activity.log.write",
    // The bridge signs every Runtime Service request with a shared secret that the
    // operator stores in the host secret provider. Only the reference is persisted; the
    // value is resolved per request, never cached, never logged. Without this capability
    // the worker cannot authenticate at all, so it is a hard requirement rather than a
    // convenience — but note it grants *reference resolution only*, not a grant surface.
    "secrets.read-ref",

    // Agent-facing graph tools.
    "agent.tools.register",

    // Work management: read the tree, materialize approved work, project status.
    "issues.read",
    "issues.create",
    "issues.update",
    "issues.checkout",
    "issues.wakeup",
    "issue.relations.read",
    "issue.relations.write",
    "issue.subtree.read",
    "issues.orchestration.read",

    // Readable specs, reports, and reviews; evidence anchoring.
    "issue.documents.read",
    "issue.documents.write",
    "issue.comments.read",
    "issue.comments.create",

    // Human-only interaction carriers for engineering decisions.
    "issue.interactions.create",
    "issue.interactions.read",

    // Roster and workspace metadata for capability matching.
    "agents.read",
    // Tenant discovery, so the bridge can find its own configuration instead of depending on a
    // `configChanged` push it might have missed. Read-only, and the reason a correctly configured
    // plugin never reports "no configuration" simply because the worker started first.
    "companies.read",
    "projects.read",
    "project.workspaces.read",
    "execution.workspaces.read",

    // Read approvals to reconcile their state. Never decide one.
    "approvals.read",

    // Scoped JSON API for operator tooling and the end-to-end harness.
    "api.routes.register",

    // UI surfaces.
    "ui.page.register",
    "ui.sidebar.register",
    "ui.detailTab.register",
    "ui.dashboardWidget.register",
    "ui.action.register",
  ],

  entrypoints: {
    worker: "dist/worker.js",
    ui: "dist/ui",
  },

  instanceConfigSchema: {
    type: "object",
    required: ["runtimeUrl", "bridgeIssuer", "sharedSecretRef"],
    // `additionalProperties: false` is deliberate and is why this list has to stay exactly in
    // step with the keys `resolveConfig` reads: the host validates a saved config against this
    // schema, so a key the worker reads but the schema omits is a config the operator physically
    // cannot set. `tests/at-19-22-pins-children.test.ts` asserts the two sets are equal.
    properties: {
      runtimeUrl: {
        type: "string",
        description: "Base URL of the PolyForge Runtime Service, e.g. http://127.0.0.1:8787",
      },
      bridgeIssuer: {
        type: "string",
        description:
          "Issuer id the Runtime Service must accept. Requests with any other issuer are rejected.",
      },
      sharedSecretRef: {
        type: "object",
        description:
          "Secret reference resolved through the host secret provider. Only the reference is stored; the value is never cached or logged.",
        properties: {
          type: { type: "string", const: "secret_ref" },
          secretId: { type: "string" },
          version: { type: "string" },
        },
        required: ["type", "secretId"],
        additionalProperties: false,
      },
      allowPrivateRuntimeHost: {
        type: "boolean",
        default: false,
        description:
          "Permit a loopback or RFC1918 runtimeUrl. A local Runtime Service is a real setup and the SSRF guard must not make it unusable, so this is an explicit per-company opt-in rather than a default. A link-local or cloud-metadata address is refused unconditionally and this flag does not reach it.",
      },
      runtimeTransport: {
        type: "string",
        enum: ["governed", "direct"],
        default: "governed",
        description:
          "How requests to the Runtime Service leave the worker. 'governed' (default, production) routes them through ctx.http.fetch so the host owns SSRF guarding, HTTP audit, and tracing. The host's governed client refuses loopback and RFC1918 unconditionally with no per-plugin opt-in, so a Runtime Service co-located on the same machine is unreachable through it; 'direct' uses Node's fetch so a single-host pilot can run, at the cost of host HTTP audit. 'direct' is never a silent fallback: it is recorded in the bridge's durable state and reported as a named degraded posture in health.",
      },
      audience: {
        type: "string",
        default: "polyforge-runtime",
        description: "Audience the signed request is bound to. The Runtime Service refuses any other.",
      },
      requestTimeoutMs: {
        type: "number",
        description: "Outbound request timeout. Defaults to 15000.",
      },
      replayWindowSeconds: {
        type: "number",
        description: "Accepted clock skew for signed requests. Defaults to 120.",
      },
      maxArtifactBytes: {
        type: "number",
        description: "Hard cap on a single artifact the bridge will read or store. Defaults to 8 MiB.",
      },
      stateDir: {
        type: "string",
        description:
          "Absolute path the operator declares for this company's state, recorded and reported for reference. This is NOT the store location: the bridge's durable store (inbox, outbox, bindings, projection offsets) is one instance-scoped SQLite file with every row namespaced by company, opened before any company config can be read, and its real path is reported by onHealth and named in any writability error. The store's location is chosen by the POLYFORGE_BRIDGE_STATE_ROOT environment variable of the worker process, defaulting to a stable per-user path. Must be writable if set.",
      },
      defaultGraphId: {
        type: "string",
        description: "Graph used when a Root Issue does not name an explicit entrypoint.",
      },
      engineeringEntryLabel: {
        type: "string",
        description:
          "Issue label that marks a Root Issue as an engineering work entry. Empty disables label-based admission.",
      },
      engineeringOriginPrefix: {
        type: "string",
        description:
          "Issue originKind prefix this plugin owns. Child issues it materializes use this prefix so they are distinguishable from human-created work.",
      },
      workspaceProviderMode: {
        type: "string",
        enum: ["metadata_only", "inherited"],
        description:
          "metadata_only: the bridge only reads workspace metadata. inherited: child issues inherit the Root Issue's execution workspace. The bridge never provisions a workspace itself.",
      },
      experimental: {
        type: "object",
        description:
          "All off by default. Root Issue plus a human-only Interaction must keep working with every flag false.",
        properties: {
          decisions: { type: "boolean", default: false },
          cases: { type: "boolean", default: false },
          pipelines: { type: "boolean", default: false },
        },
        additionalProperties: false,
      },
      enableProjections: {
        type: "boolean",
        default: true,
        description: "Project engineering status onto issue statuses. Off means read-only observation.",
      },
      logLevel: {
        type: "string",
        enum: ["debug", "info", "warn", "error"],
        default: "info",
      },
    },
    additionalProperties: false,
  },

  jobs: [
    {
      jobKey: "outbox-pump",
      displayName: "Outbox pump",
      description:
        "Delivers queued bridge intents, retries with bounded backoff, and reconciles deliveries that are stuck in an ambiguous state.",
      schedule: "*/1 * * * *",
    },
    {
      jobKey: "reconcile",
      displayName: "Reconcile",
      description:
        "Re-reads authoritative Paperclip objects for active bindings and reconciles projections. This is the safety net for lost or out-of-order events.",
      schedule: "*/5 * * * *",
    },
    {
      jobKey: "core-outbox",
      displayName: "Core outbox",
      description:
        "Claims the Core's queued outbound intents, records each as a bridge intent, and acknowledges the outcome. This is how a node that became READY turns into work on the platform: the Core never calls the platform itself, so an unclaimed intent is a node nobody is ever asked to do.",
      schedule: "* * * * *",
    },
  ],

  tools: [
    {
      name: "status",
      displayName: "PolyForge status",
      description:
        "Read the authoritative engineering status of a PolyForge run: node states, gate results, pending governance, and blockers. Read-only; it never marks anything passed.",
      parametersSchema: {
        type: "object",
        properties: {
          runId: { type: "string", description: "GraphRun id. Omit to use this agent run's bound run." },
          nodeId: { type: "string" },
          includeHistory: { type: "boolean" },
        },
        additionalProperties: false,
      },
    },
    {
      name: "current",
      displayName: "PolyForge current contract",
      description:
        "Read this attempt's transition contract: required inputs, permitted output types, evidence requirements, policy constraints, and the exact next actions. Establishes the lease fence when the agent run matches the binding.",
      parametersSchema: {
        type: "object",
        properties: {
          runId: { type: "string" },
          nodeId: { type: "string" },
          adopt: {
            type: "boolean",
            description:
              "Claim the current attempt for this agent run when the previous owner is confirmed stopped. Creates a new attempt with an incremented lease epoch and invalidates the old one.",
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: "submit_artifact",
      displayName: "PolyForge submit artifact",
      description:
        "Register fixed artifact references with content digests. Create-or-verify: re-registering the same digest is idempotent, a conflicting digest for the same identity is rejected.",
      parametersSchema: {
        type: "object",
        properties: {
          runId: { type: "string" },
          nodeId: { type: "string" },
          artifacts: {
            type: "array",
            items: {
              type: "object",
              properties: {
                kind: { type: "string" },
                contentHash: { type: "string", description: "sha256:<hex>" },
                mediaType: { type: "string" },
                size: { type: "number" },
                source: {
                  type: "object",
                  description: "Use an issue-scoped document ref or inline bytes; attachment reads are not enabled.",
                  properties: {
                    kind: { type: "string", enum: ["document", "inline"] },
                    ref: { type: "string" },
                    body: { type: "string" },
                  },
                  required: ["kind"],
                  additionalProperties: false,
                },
                repository: {
                  type: "object",
                  properties: { repoRef: { type: "string" }, commit: { type: "string" } },
                  required: ["repoRef", "commit"],
                  additionalProperties: false,
                },
              },
              required: ["kind", "contentHash", "mediaType", "size", "source"],
              additionalProperties: false,
            },
          },
        },
        required: ["artifacts"],
        additionalProperties: false,
      },
    },
    {
      name: "submit_evidence",
      displayName: "PolyForge submit evidence",
      description:
        "Submit evidence candidates for the current transition. The Core verifies scope, producer, active claim, contract-bound output type, content hash, source revision, and freshness before archiving. A worker's claim that tests passed stays a candidate until a trusted source confirms it.",
      parametersSchema: {
        type: "object",
        properties: {
          runId: { type: "string" },
          nodeId: { type: "string" },
          evidence: {
            type: "array",
            items: {
              type: "object",
              properties: {
                kind: { type: "string" },
                artifacts: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      provider: { type: "string" },
                      kind: { type: "string" },
                      id: { type: "string" },
                    },
                    required: ["provider", "kind", "id"],
                    additionalProperties: false,
                  },
                },
                detail: { type: "object" },
                inputRevisionBindings: { type: "object", additionalProperties: { type: "string" } },
              },
              required: ["kind", "artifacts"],
              additionalProperties: false,
            },
          },
        },
        required: ["evidence"],
        additionalProperties: false,
      },
    },
    {
      name: "request_transition",
      displayName: "PolyForge request transition",
      description:
        "Request evaluation of the current node's transition. Returns PASS/FAIL/ESCALATE or a durable pending result. A PASS requires every mandatory evaluator to have passed; the caller cannot assert a pass, supply an approval, or register an evaluator.",
      parametersSchema: {
        type: "object",
        properties: {
          runId: { type: "string" },
          nodeId: { type: "string" },
          evidenceIds: { type: "array", items: { type: "string" } },
          summary: { type: "string" },
        },
        required: ["evidenceIds"],
        additionalProperties: false,
      },
    },
    {
      name: "request_help",
      displayName: "PolyForge request help",
      description:
        "Create a durable help intent: clarification, independent review, or human handling. Never auto-approves anything and never blocks a long-running call waiting for a human.",
      parametersSchema: {
        type: "object",
        properties: {
          runId: { type: "string" },
          nodeId: { type: "string" },
          kind: { type: "string", enum: ["clarification", "review", "human_handling"] },
          question: { type: "string" },
          context: { type: "object" },
        },
        required: ["kind", "question"],
        additionalProperties: false,
      },
    },
  ],

  apiRoutes: [
    {
      routeKey: "agent-tool",
      method: "POST",
      path: "/issues/:issueId/tools/:toolName",
      auth: "agent",
      capability: "api.routes.register",
      checkoutPolicy: "required-for-agent-in-progress",
      companyResolution: { from: "issue", param: "issueId" },
    },
    {
      routeKey: "runs",
      method: "GET",
      path: "/runs",
      auth: "board-or-agent",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      routeKey: "run-snapshot",
      method: "GET",
      path: "/runs/:runId",
      auth: "board-or-agent",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      routeKey: "reconcile-now",
      method: "POST",
      path: "/reconcile",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "body", key: "companyId" },
    },
    {
      routeKey: "start-run",
      method: "POST",
      path: "/work-orders",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "body", key: "companyId" },
    },
  ],

  ui: {
    slots: [
      {
        type: "page",
        id: "polyforge",
        displayName: "PolyForge",
        exportName: "PolyForgePage",
      },
      {
        type: "sidebar",
        id: "polyforge-nav",
        displayName: "PolyForge",
        exportName: "PolyForgeSidebar",
      },
      {
        type: "dashboardWidget",
        id: "polyforge-health",
        displayName: "PolyForge health",
        exportName: "PolyForgeHealthWidget",
      },
      {
        type: "detailTab",
        id: "polyforge-issue",
        displayName: "PolyForge",
        exportName: "PolyForgeIssueTab",
        entityTypes: ["issue"],
      },
      {
        type: "detailTab",
        id: "polyforge-project",
        displayName: "PolyForge",
        exportName: "PolyForgeProjectTab",
        entityTypes: ["project"],
      },
      {
        type: "detailTab",
        id: "polyforge-agent",
        displayName: "PolyForge",
        exportName: "PolyForgeAgentTab",
        entityTypes: ["agent"],
      },
      {
        type: "detailTab",
        id: "polyforge-run",
        displayName: "PolyForge",
        exportName: "PolyForgeRunTab",
        entityTypes: ["run"],
      },
    ],
  },
};

export default manifest;
export { manifest };
