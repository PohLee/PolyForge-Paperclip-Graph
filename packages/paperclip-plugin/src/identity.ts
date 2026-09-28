/**
 * Trusted actor derivation and the "no forged identity" invariant.
 *
 * ## The invariant
 *
 * **A worker can never assert a human actor, and no request body the bridge signs may carry
 * an actor, an approval, or an evaluator at all.**
 *
 * Three properties hold this together, and each is enforced in code rather than in review:
 *
 * 1. *Origin is the host.* `actorType` comes only from a host-provided context object:
 *    `ToolRunContext` for an agent tool call (always `agent`) and
 *    `PluginPerformActionContext` / `PluginApiRequestInput` for a board action (a `user`
 *    only when the host authenticated a board user). There is no third input.
 * 2. *Direction of construction.* The `ActorAssertion` handed to the Runtime Client is built
 *    by `agentActor` or `boardActor` from those contexts. Both functions take only host types;
 *    neither accepts a caller-supplied `actorType`, `actorId`, `approved`, or `evaluatorRef`.
 *    A `ToolRunContext` structurally cannot express `human`.
 * 3. *Strip on the way out.* Every outbound body passes through `stripActorAssertions` before
 *    it is hashed and signed. The function removes, recursively, any key that names an actor,
 *    an approval, or an evaluator registration. So even if a future caller, a Core payload, or
 *    a hand-crafted tool parameter smuggles `{"actorUserId": "…", "approved": true}` into a
 *    body, the signed request physically cannot contain it, and the Core's own
 *    body-scope check never sees it.
 *
 * ## Why stripping rather than rejecting
 *
 * Rejecting would be a denial-of-service vector: a Core that echoes back a field it read
 * from a previous response would make the next request fail. Stripping is the fail-closed
 * choice that cannot be turned into a bypass, because the field's *absence* is what the
 * trust model depends on. Every strip is counted and logged as `actorFieldsStripped` so the
 * attempt is visible rather than invisible.
 */

import type { ActorAssertion, Scope } from "@polyforge/protocol";
import type {
  PluginApiRequestInput,
  PluginPerformActionContext,
  ToolRunContext,
} from "@paperclipai/plugin-sdk";
import { ScopeViolationError } from "./errors.js";
import type { ActorLogRef } from "./logger.js";
import { actorLogRef } from "./logger.js";

/**
 * Keys stripped from every signed body.
 *
 * `actor*` is matched by prefix (see `isActorishKey`), because the dangerous family is
 * open-ended: `actorId`, `actorType`, `actorUserId`, `actorAgentId`, `actorRunId`,
 * `actorAssertion`, `onBehalfOfUserId`, … A blocklist of exact names would miss the next one.
 */
const EXACT_STRIP = new Set([
  "approved",
  "approvedby",
  "approveruserid",
  "approval",
  "approvalref",
  "recordapproval",
  "resolverpolicyoverride",
  "createdbyuserid",
  "createdbyagentid",
  "resolvedbyuserid",
  "resolvedbyagentid",
  "decideas",
  "evaluatorref",
  "evaluatorrefs",
  "registerevaluator",
  "evaluatorregistration",
  "gateoverride",
  "overridepolicy",
]);

const ACTOR_PREFIXES = ["actor", "onbehalfof", "asuser", "asactor", "impersonate", "humanactor", "pretend"];

export function isActorishKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (EXACT_STRIP.has(normalized)) return true;
  return ACTOR_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export interface StripResult<T> {
  readonly value: T;
  readonly strippedKeys: string[];
}

/**
 * Recursively remove actor/approval/evaluator keys from a value.
 *
 * Arrays and plain objects are walked; anything else (Date, Buffer, class instance) is
 * returned untouched because the bridge only ever builds plain JSON bodies. The
 * `strippedKeys` list is dotted so a log line points at the exact offending field.
 */
export function stripActorAssertions<T>(value: T): StripResult<T> {
  const strippedKeys: string[] = [];
  const walk = (input: unknown, path: string): unknown => {
    if (Array.isArray(input)) return input.map((item, index) => walk(item, `${path}[${index}]`));
    if (input !== null && typeof input === "object") {
      if (input instanceof Date) return input.toISOString();
      const source = input as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(source)) {
        if (isActorishKey(key)) {
          strippedKeys.push(path.length > 0 ? `${path}.${key}` : key);
          continue;
        }
        const childPath = path.length > 0 ? `${path}.${key}` : key;
        out[key] = walk(source[key], childPath);
      }
      return out;
    }
    return input;
  };
  return { value: walk(value, "") as T, strippedKeys };
}

/** The single place a tool-call actor assertion is built. There is no human branch here. */
export function agentActor(runCtx: ToolRunContext): ActorAssertion {
  return {
    actorType: "agent",
    actorId: runCtx.agentId,
    agentId: runCtx.agentId,
    runId: runCtx.runId,
    roles: [],
  };
}

export function boardActor(context: PluginPerformActionContext): ActorAssertion {
  const actor = context.actor;
  if (actor.type === "agent") {
    if (!actor.agentId) {
      throw new ScopeViolationError("host reported an agent actor without an agent id", {
        hostActorType: actor.type,
      });
    }
    return {
      actorType: "agent",
      actorId: actor.agentId,
      agentId: actor.agentId,
      runId: actor.runId,
      roles: [],
    };
  }
  if (actor.type === "user") {
    if (!actor.userId) {
      throw new ScopeViolationError("host reported a user actor without a user id", {
        hostActorType: actor.type,
      });
    }
    return {
      actorType: "human",
      actorId: actor.userId,
      agentId: null,
      runId: actor.runId,
      roles: [],
    };
  }
  // `system` is the host's own maintenance actor (a scheduled job). It is deliberately not
  // `human`: a system job may reconcile, but it may never be recorded as a human decision.
  return { actorType: "system", actorId: "paperclip:system", agentId: null, runId: null, roles: [] };
}

export function apiRequestActor(input: PluginApiRequestInput): ActorAssertion {
  if (input.actor.actorType === "user") {
    if (!input.actor.userId) {
      throw new ScopeViolationError("api request reported a user actor without a user id", {
        routeKey: input.routeKey,
      });
    }
    return {
      actorType: "human",
      actorId: input.actor.userId,
      agentId: null,
      runId: input.actor.runId ?? null,
      roles: [],
    };
  }
  if (!input.actor.agentId) {
    throw new ScopeViolationError("api request reported an agent actor without an agent id", {
      routeKey: input.routeKey,
    });
  }
  return {
    actorType: "agent",
    actorId: input.actor.agentId,
    agentId: input.actor.agentId,
    runId: input.actor.runId ?? null,
    roles: [],
  };
}

export function logRefFor(actor: ActorAssertion): ActorLogRef {
  return actorLogRef(actor.actorType, actor.actorId);
}

/**
 * Compare a requested scope against the scope the host authenticated.
 *
 * The requested scope comes from configuration or from a URL/body field, both of which a
 * caller controls. The authenticated scope comes from the host. They must be equal, and the
 * comparison is exact: a prefix match, a case-insensitive match, or a "same company, any
 * project" fallback would each be a cross-tenant read.
 */
export function assertScope(
  expected: Scope,
  authenticated: { companyId: string; projectId: string | null | undefined },
  what: string,
): void {
  if (expected.companyRef !== authenticated.companyId) {
    throw new ScopeViolationError(`${what}: company scope is not the authenticated company`, {
      requestedCompany: expected.companyRef,
      authenticatedCompany: authenticated.companyId,
    });
  }
  if (expected.projectRef !== (authenticated.projectId ?? "")) {
    throw new ScopeViolationError(`${what}: project scope is not the authenticated project`, {
      requestedProject: expected.projectRef,
      authenticatedProject: authenticated.projectId ?? "",
    });
  }
}

/**
 * A scope that is valid for cross-project reads inside one company.
 *
 * Some reads (the run list, the integration health counters) legitimately span a company.
 * They still must not cross the company boundary, so the project half is the empty string
 * rather than a caller-supplied value.
 */
export function companyScope(companyRef: string): Scope {
  return { companyRef, projectRef: "" };
}
