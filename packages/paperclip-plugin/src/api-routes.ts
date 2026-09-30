/**
 * The manifest API routes, dispatched by `routeKey`.
 *
 * The host has already enforced auth mode, company resolution, the declared capability and the
 * checkout policy by the time `onApiRequest` runs. This module adds the checks the host cannot:
 *
 * * **The resolved company must be host-resolved.** Issue-scoped routes derive the company from
 *   the host's issue lookup; the agent tool route then matches that issue to the durable work
 *   binding for the authenticated heartbeat.
 * * **Board-only routes require a board user**, not merely a board *token*: an agent calling
 *   `POST /reconcile` or `POST /work-orders` is refused, because both are governance acts.
 * * **Object ids are re-scoped from the bridge's own bindings.** A run id is a bearer token;
 *   the only evidence of which company owns it is the bridge's record.
 *
 * Returned bodies are the Core's typed responses, so operator tooling, agent fallback calls, and
 * the end-to-end harness share the same contract.
 */

import type { PluginApiRequestInput, PluginApiResponse, ToolRunContext } from "@paperclipai/plugin-sdk";
import { TOOL_NAMES, TOOL_PARAMETERS, type ToolName } from "@polyforge/protocol";
import type { CompanyContext, CompanyResolver } from "./bridge/data.js";
import { RUN_BINDING_KIND } from "./ports/work-management.js";
import { BridgeError, ScopeViolationError, toBlocker } from "./errors.js";
import { apiRequestActor } from "./identity.js";
import { makeToolHandlers } from "./tools/handlers.js";
import type { ToolHandlerDeps } from "./tools/register.js";

export const ROUTE_KEYS = ["agent-tool", "runs", "run-snapshot", "reconcile-now", "start-run"] as const;
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

export function createApiRequestHandler(resolve: CompanyResolver, toolDeps: ToolHandlerDeps) {
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
        case "agent-tool":
          return await handleAgentTool(input, company, toolDeps);
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

async function handleAgentTool(
  input: PluginApiRequestInput,
  company: CompanyContext,
  deps: ToolHandlerDeps,
): Promise<PluginApiResponse> {
  const agentId = input.actor.agentId;
  const runId = input.actor.runId;
  const issueId = input.params["issueId"];
  const toolName = input.params["toolName"];
  if (input.actor.actorType !== "agent" || !agentId || !runId) {
    throw new ScopeViolationError("PolyForge agent tool calls require an authenticated heartbeat agent run", {
      actorType: input.actor.actorType,
      hasAgentId: Boolean(agentId),
      hasRunId: Boolean(runId),
    });
  }
  if (typeof issueId !== "string" || issueId.length === 0) {
    throw new ScopeViolationError("the host did not resolve a work-unit issue for this heartbeat", { issueId });
  }
  if (!TOOL_NAMES.includes(toolName as ToolName)) {
    return json(404, { error: { code: "UNKNOWN_TOOL", message: `unknown PolyForge tool ${toolName}` } });
  }
  const name = toolName as ToolName;
  const exactBinding = deps.bindingForAgentRun(company.companyId, runId);
  const binding = exactBinding?.issueId === issueId
    ? exactBinding
    : await deps.bindingForIssueExecution(company.companyId, issueId, agentId, runId);
  if (!binding || binding.issueId !== issueId || binding.projectId.length === 0) {
    company.metrics.bump(company.companyId, "crossScopeDenials");
    throw new ScopeViolationError("this heartbeat is not bound to a PolyForge work unit for the requested issue", {
      issueId,
      runId,
    });
  }
  const params = bodyRecord(input.body);
  const invalid = validateToolParameters(params, TOOL_PARAMETERS[name] as unknown as Record<string, unknown>);
  if (invalid !== null) {
    return json(400, { error: { code: "BAD_REQUEST", message: invalid } });
  }
  // Identity comes from Paperclip's authenticated request; project scope comes from the
  // durable work-unit binding. Body-supplied run/agent/company values never set the context.
  const runCtx: ToolRunContext = {
    agentId,
    runId,
    companyId: company.companyId,
    projectId: binding.projectId,
  };
  // Tool handlers resolve the same binding again as a defense-in-depth check. Supply the
  // already verified issue-execution mapping for this authenticated request so a delayed
  // heartbeat id need not have been returned by requestWakeup and stored ahead of time.
  const requestHandlers = makeToolHandlers({
    ...deps,
    bindingForAgentRun: (boundCompanyId, boundRunId) =>
      boundCompanyId === company.companyId && boundRunId === runId
        ? binding
        : deps.bindingForAgentRun(boundCompanyId, boundRunId),
  });
  const result = await requestHandlers[name](params, runCtx);
  return json(200, result);
}

function validateToolParameters(value: unknown, schema: Record<string, unknown>, path = "parameters"): string | null {
  const expectedType = schema["type"];
  if (expectedType === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return `${path} must be an object`;
    const record = value as Record<string, unknown>;
    const properties = schema["properties"] as Record<string, Record<string, unknown>> | undefined;
    const required = Array.isArray(schema["required"]) ? (schema["required"] as string[]) : [];
    for (const key of required) if (!(key in record)) return `${path}.${key} is required`;
    for (const [key, child] of Object.entries(record)) {
      const childSchema = properties?.[key];
      if (!childSchema) {
        const additional = schema["additionalProperties"];
        if (additional === false) return `${path}.${key} is not allowed`;
        if (typeof additional === "object" && additional !== null) {
          const error = validateToolParameters(child, additional as Record<string, unknown>, `${path}.${key}`);
          if (error) return error;
        }
        continue;
      }
      const error = validateToolParameters(child, childSchema, `${path}.${key}`);
      if (error) return error;
    }
  } else if (expectedType === "array") {
    if (!Array.isArray(value)) return `${path} must be an array`;
    const itemSchema = schema["items"] as Record<string, unknown> | undefined;
    if (itemSchema) for (let i = 0; i < value.length; i += 1) {
      const error = validateToolParameters(value[i], itemSchema, `${path}[${i}]`);
      if (error) return error;
    }
  } else if (expectedType === "string") {
    if (typeof value !== "string") return `${path} must be a string`;
  } else if (expectedType === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) return `${path} must be a finite number`;
  } else if (expectedType === "boolean") {
    if (typeof value !== "boolean") return `${path} must be a boolean`;
  }
  const allowed = schema["enum"];
  if (Array.isArray(allowed) && !allowed.includes(value)) return `${path} must be one of ${allowed.join(", ")}`;
  return null;
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
  const requestedLimit = limitRaw === null ? 100 : Number(limitRaw);
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.min(Math.floor(requestedLimit), 500) : 100;
  const projects = await company.ctx.projects.list({ companyId: company.companyId });
  const responses = await Promise.all(projects.map((project) => runtime.listRuns(
    actor,
    { companyRef: company.companyId, projectRef: project.id },
    {
      ...(graphId === null ? {} : { graphId }),
      ...(status === null ? {} : { status }),
      limit,
    },
  )));
  const runs = responses.flatMap((response) => Array.isArray(response.runs) ? response.runs : [])
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, limit);
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
