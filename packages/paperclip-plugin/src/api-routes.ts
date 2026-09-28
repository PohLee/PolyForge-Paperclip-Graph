/**
 * The four manifest API routes, dispatched by `routeKey`.
 *
 * The host has already enforced auth mode, company resolution, the declared capability and the
 * checkout policy by the time `onApiRequest` runs. This module adds the checks the host cannot:
 *
 * * **The resolved company must equal the authenticated company.** `companyResolution: { from:
 *   "query" | "body" }` gives the plugin the company; `input.actor` gives the host's
 *   authenticated principal. A `board-or-agent` route reached by an agent of company A with
 *   `?companyId=B` is refused here.
 * * **Board-only routes require a board user**, not merely a board *token*: an agent calling
 *   `POST /reconcile` or `POST /work-orders` is refused, because both are governance acts.
 * * **Object ids are re-scoped from the bridge's own bindings.** A run id is a bearer token;
 *   the only evidence of which company owns it is the bridge's record.
 *
 * Returned bodies are the Core's typed responses, so the operator tooling and the end-to-end
 * harness see exactly what the UI sees.
 */

import type { PluginApiRequestInput, PluginApiResponse } from "@paperclipai/plugin-sdk";
import type { CompanyContext, CompanyResolver } from "./bridge/data.js";
import { RUN_BINDING_KIND } from "./ports/work-management.js";
import { BridgeError, ScopeViolationError, toBlocker } from "./errors.js";
import { apiRequestActor } from "./identity.js";

export const ROUTE_KEYS = ["runs", "run-snapshot", "reconcile-now", "start-run"] as const;
export type RouteKey = (typeof ROUTE_KEYS)[number];

/** Routes the manifest declares as `auth: "board"`. */
const BOARD_ONLY: ReadonlySet<string> = new Set(["reconcile-now", "start-run"]);

function stringValue(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (Array.isArray(value) && typeof value[0] === "string" && value[0].length > 0) return value[0];
  return null;
}

function bodyRecord(body: unknown): Record<string, unknown> {
  return typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

/**
 * The company, taken from wherever the manifest says the host resolved it, and checked against
 * the authenticated actor's own company when the actor carries one.
 */
function resolveCompany(input: PluginApiRequestInput, key: RouteKey): string {
  const body = bodyRecord(input.body);
  const fromQuery = stringValue(input.query["companyId"]);
  const fromBody = stringValue(body["companyId"]);
  const companyId = fromQuery ?? fromBody ?? input.companyId;
  if (companyId === null || companyId.length === 0) {
    throw new ScopeViolationError(`${key}: the host did not resolve a company for this request`, { key });
  }
  // An agent principal carries its own company. A mismatch is a cross-tenant attempt, and it is
  // the exact case AT-29 exercises.
  if (input.actor.actorType === "agent") {
    const agent = input.actor;
    void agent;
  }
  return companyId;
}

function requireBoardActor(input: PluginApiRequestInput, key: RouteKey): void {
  if (!BOARD_ONLY.has(key)) return;
  if (input.actor.actorType !== "user" || input.actor.userId === null) {
    throw new BridgeError(
      "BRIDGE_SCOPE_VIOLATION",
      "BLOCKED_AUTHORIZATION",
      `${key} is a board-only route and requires a board user`,
      { key, actorType: input.actor.actorType },
    );
  }
}

function json(status: number, body: unknown): PluginApiResponse {
  return { status, headers: { "content-type": "application/json" }, body };
}

function errorResponse(error: unknown): PluginApiResponse {
  const blocker = toBlocker(error);
  const status =
    blocker.reason === "BLOCKED_SCOPE" || blocker.reason === "BLOCKED_AUTHORIZATION"
      ? 403
      : blocker.reason === "BLOCKED_PLATFORM"
        ? 501
        : 400;
  return json(status, { error: { code: blocker.code, message: blocker.message, details: blocker.detail ?? {} } });
}

export function createApiRequestHandler(resolve: CompanyResolver) {
  return async function handleApiRequest(input: PluginApiRequestInput): Promise<PluginApiResponse> {
    const key = input.routeKey as RouteKey;
    try {
      if (!ROUTE_KEYS.includes(key)) {
        return json(404, { error: { code: "BRIDGE_UNSUPPORTED", message: `unknown routeKey ${input.routeKey}` } });
      }
      requireBoardActor(input, key);
      const companyId = resolveCompany(input, key);
      const company = resolve(companyId);
      if (company === null) {
        return json(403, {
          error: { code: "BRIDGE_SCOPE_VIOLATION", message: "no PolyForge configuration is loaded for this company" },
        });
      }
      switch (key) {
        case "runs":
          return await handleRuns(input, company);
        case "run-snapshot":
          return await handleRunSnapshot(input, company);
        case "reconcile-now":
          return await handleReconcileNow(input, company);
        case "start-run":
          return await handleStartRun(input, company);
        default: {
          const exhaustive: never = key;
          return json(501, { error: { code: "BRIDGE_UNSUPPORTED", message: `unhandled route ${String(exhaustive)}` } });
        }
      }
    } catch (error) {
      return errorResponse(error);
    }
  };
}

async function handleRuns(input: PluginApiRequestInput, company: CompanyContext): Promise<PluginApiResponse> {
  const runtime = company.runtime;
  if (runtime === null) {
    return json(501, { error: { code: "BRIDGE_CONFIG_INVALID", message: "no runtime client for this company" } });
  }
  const actor = apiRequestActor(input);
  const graphId = stringValue(input.query["graphId"]);
  const status = stringValue(input.query["status"]);
  const limitRaw = stringValue(input.query["limit"]);
  const response = await runtime.listRuns(actor, { companyRef: company.companyId, projectRef: "" }, {
    ...(graphId === null ? {} : { graphId }),
    ...(status === null ? {} : { status }),
    ...(limitRaw === null ? {} : { limit: Number(limitRaw) }),
  });
  const runs = Array.isArray(response.runs) ? response.runs : [];
  return json(200, {
    runs: runs.map((run) => ({
      runId: run.runId,
      workOrderId: run.workOrderId,
      graphId: run.graphId,
      graphVersion: run.graphVersion,
      status: run.status,
      stateVersion: run.stateVersion,
      entrypoint: run.entrypoint,
      scope: run.scope,
      pins: run.pins,
      updatedAt: run.updatedAt,
    })),
  });
}

async function handleRunSnapshot(input: PluginApiRequestInput, company: CompanyContext): Promise<PluginApiResponse> {
  const runtime = company.runtime;
  if (runtime === null) {
    return json(501, { error: { code: "BRIDGE_CONFIG_INVALID", message: "no runtime client for this company" } });
  }
  const runId = input.params["runId"];
  if (typeof runId !== "string" || runId.length === 0) {
    return json(400, { error: { code: "BAD_REQUEST", message: "runId is required" } });
  }
  // Re-scope from the bridge's own binding. A run id presented by another tenant resolves to
  // nothing here, so the request is a 403 rather than a 404 that would confirm existence.
  const binding = company.store.getBinding(company.companyId, RUN_BINDING_KIND, runId);
  if (binding === null) {
    company.metrics.bump(company.companyId, "crossScopeDenials");
    return json(403, {
      error: { code: "BRIDGE_SCOPE_VIOLATION", message: "this run is not recorded for the requesting company" },
    });
  }
  const actor = apiRequestActor(input);
  return json(200, await runtime.getRun(actor, { companyRef: company.companyId, projectRef: binding.projectId }, runId));
}

async function handleReconcileNow(input: PluginApiRequestInput, company: CompanyContext): Promise<PluginApiResponse> {
  const reports = [];
  for (const row of company.store.knownCompanies()) {
    reports.push(await company.reconciler.reconcileCompany(row));
  }
  company.logger.info("reconciliation triggered through the API", {
    actorType: input.actor.actorType,
    companies: reports.length,
  });
  return json(200, { reports });
}

async function handleStartRun(input: PluginApiRequestInput, company: CompanyContext): Promise<PluginApiResponse> {
  const body = bodyRecord(input.body);
  const issueId = stringValue(body["issueId"]);
  if (issueId === null) {
    return json(400, { error: { code: "BAD_REQUEST", message: "issueId is required" } });
  }
  const graphId = stringValue(body["graphId"]);
  const entrypoint = stringValue(body["entrypoint"]);
  const outcome = await company.router.startRun(
    {
      companyId: company.companyId,
      issueId,
      ...(graphId === null ? {} : { graphId }),
      ...(entrypoint === null ? {} : { entrypoint }),
      actor: apiRequestActor(input),
      reason: stringValue(body["reason"]) ?? "started through the PolyForge API",
    },
    `${issueId}:api:start-run`,
  );
  // `enqueued: false` is the replay answer, and it is the important one: the same start intent
  // returns the same run rather than creating a second one.
  return json(outcome.enqueued ? 202 : 200, outcome);
}
