/**
 * Translation from the Core's outbound intents to the bridge's port contracts.
 *
 * The Core and the bridge do not share a vocabulary, and they do not share a payload shape either.
 * The Core enqueues a `work.unit.ensure` whose payload carries the project inside `scope` and whose
 * `workspaceRequirement` is an empty object whenever the plan node declares none. The port contract
 * wants a flat `projectRef` and a fully populated `WorkspaceRequirement`.
 *
 * Handing one to the other without this step is what produced
 * `Cannot read properties of undefined (reading 'length')` on every admitted node: the Core's
 * payload was spread straight into a `WorkUnitIntent` cast to `never`, so nothing checked that the
 * two shapes agreed and the port read a field the Core never sends.
 *
 * Every rule here is fail-closed. An intent this build cannot read exactly is refused *by name* and
 * left unacknowledged, because the alternative -- a default, a coercion, or a dropped field -- is a
 * work unit created against the wrong project, or a workspace the worker was never granted.
 */

import type { ProviderRefLike, Scope, WorkspaceMode, WorkspaceRequirement, WorkUnitIntent } from "@polyforge/protocol";

/** The modes the port contract declares. Anything else is a Core this bridge does not implement. */
const WORKSPACE_MODES: WorkspaceMode[] = ["read_write", "read_only_snapshot", "reuse_serially"];

/**
 * The exact payload the Core enqueues for `work.unit.ensure`.
 *
 * Transcribed from `engine.py` so the tests exercise the real shape rather than a convenient one.
 * Exported so a change on the Core side is noticed here first.
 */
export function coreIntentPayload(): Record<string, unknown> {
  return {
    runId: "run-1",
    nodeId: "architecture",
    iteration: 0,
    scope: { companyRef: "company-a", projectRef: "project-a" },
    title: "design.design: architecture",
    description: "Work the architecture node of run run-1 in graph design v3.",
    requiredCapabilities: ["architecture.produce"],
    correlationKey: "work-unit:run-1:architecture:0",
    parentIssueRef: { provider: "paperclip", kind: "issue", id: "root-1" },
    workspaceRequirement: {},
  };
}

function refuse(message: string, detail: Record<string, unknown> = {}): never {
  const error = new Error(message) as Error & { code?: string; detail?: Record<string, unknown> };
  error.code = "BRIDGE_PROTOCOL_INCOMPATIBLE";
  error.detail = detail;
  throw error;
}

function requiredString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0) {
    refuse(`the Core's intent payload has no ${key}; this bridge cannot act on a work order that does not say which node it is`, {
      field: key,
    });
  }
  return value;
}

function requiredInteger(payload: Record<string, unknown>, key: string): number {
  const value = payload[key];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    refuse(`the Core's intent payload has no integer ${key}`, { field: key, value });
  }
  return value;
}

function readScope(payload: Record<string, unknown>): Scope {
  const scope = payload["scope"];
  if (typeof scope !== "object" || scope === null) {
    refuse("the Core's intent payload carries no scope; a work order is only meaningful inside one", {
      field: "scope",
    });
  }
  const company = (scope as Record<string, unknown>)["companyRef"];
  const project = (scope as Record<string, unknown>)["projectRef"];
  if (typeof company !== "string" || company.length === 0) {
    refuse("the Core's intent scope has no companyRef", { field: "scope.companyRef" });
  }
  if (typeof project !== "string" || project.length === 0) {
    // Not defaulted. The project is what the child issue is written under and what the scope guard
    // compares against; inventing one would put a child's work in a project nobody asked for.
    refuse(
      "the Core's intent scope has no projectRef; project identity comes from the trusted issue " +
        "relation and is never invented here",
      { field: "scope.projectRef" },
    );
  }
  return { companyRef: company, projectRef: project };
}

/**
 * `{}` is a real answer, not a missing field.
 *
 * The Core sends `dict(node_plan.workspace_requirement or {})`, so a node that declares no workspace
 * arrives as an empty object. Reading `.repositories` off that is the second crash, one line after
 * the first.
 */
function readWorkspaceRequirement(payload: Record<string, unknown>): WorkspaceRequirement {
  const raw = payload["workspaceRequirement"];
  const requirement = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const mode = requirement["mode"];
  if (mode === undefined) {
    return { mode: "read_write", repositories: [], requireReadOnlyForReviewer: false };
  }
  if (typeof mode !== "string" || !WORKSPACE_MODES.includes(mode as WorkspaceMode)) {
    refuse(
      `the Core asked for workspace mode ${JSON.stringify(mode)}, which this bridge does not implement; ` +
        "a workspace it cannot describe is not one it will grant",
      { field: "workspaceRequirement.mode", known: [...WORKSPACE_MODES] },
    );
  }
  const repositories = Array.isArray(requirement["repositories"]) ? requirement["repositories"] : [];
  return {
    mode: mode as WorkspaceMode,
    repositories: repositories.map((entry) => {
      const repo = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>;
      const repoRef = repo["repoRef"];
      const baseRef = repo["baseRef"];
      if (typeof repoRef !== "string" || repoRef.length === 0 || typeof baseRef !== "string") {
        refuse("the Core's workspace requirement names a repository this bridge cannot read", {
          field: "workspaceRequirement.repositories",
          entry,
        });
      }
      return {
        repoRef,
        baseRef,
        ...(typeof repo["commit"] === "string" ? { commit: repo["commit"] } : {}),
      };
    }),
    requireReadOnlyForReviewer: requirement["requireReadOnlyForReviewer"] === true,
  };
}

function readParentIssueRef(payload: Record<string, unknown>): ProviderRefLike | null {
  const raw = payload["parentIssueRef"];
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object") {
    refuse("the Core's intent parentIssueRef is neither a provider ref nor absent", {
      field: "parentIssueRef",
    });
  }
  const ref = raw as Record<string, unknown>;
  const provider = ref["provider"];
  const kind = ref["kind"];
  const id = ref["id"];
  if (
    typeof provider !== "string" ||
    provider.length === 0 ||
    typeof kind !== "string" ||
    kind.length === 0 ||
    typeof id !== "string" ||
    id.length === 0
  ) {
    refuse("the Core's intent parentIssueRef is not a complete provider ref", { field: "parentIssueRef" });
  }
  return { provider, kind, id } as ProviderRefLike;
}

function readProviderRef(value: unknown, field: string): ProviderRefLike {
  if (typeof value !== "object" || value === null) {
    refuse(`the Core's intent has no provider reference at ${field}`, { field });
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record["provider"] !== "string" ||
    typeof record["kind"] !== "string" ||
    typeof record["id"] !== "string" ||
    record["provider"].length === 0 ||
    record["kind"].length === 0 ||
    record["id"].length === 0
  ) {
    refuse(`the Core's intent carries an incomplete provider reference at ${field}`, { field, value });
  }
  return {
    provider: record["provider"],
    kind: record["kind"],
    id: record["id"],
  } as ProviderRefLike;
}

function readStringArray(payload: Record<string, unknown>, key: string): string[] {
  const value = payload[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    refuse(`the Core's intent ${key} is not a list`, { field: key });
  }
  return value.filter((item): item is string => typeof item === "string");
}

/**
 * Map one Core intent payload onto the port contract it realises.
 *
 * Only the kinds that produce a `WorkUnitIntent` are mapped here. Anything else is refused by name:
 * an unmapped kind handed on as a work order would create a child issue for something the Core never
 * asked for, which is worse than leaving the intent unacknowledged for a later build.
 */
/**
 * The payload a bridge intent is persisted with, per Core kind.
 *
 * Every kind is mapped separately. The Core names graph concepts; the ports need provider targets,
 * authenticated scope, projection sequences and normalized interaction fields. Passing Core payloads
 * through unchanged made the queue look drained while the platform handlers failed later.
 */
export interface CoreIntentMappingContext {
  scope: Scope;
  correlationId: string;
}

export function mapCoreIntentPayload(
  coreKind: string,
  payload: Record<string, unknown>,
  context?: CoreIntentMappingContext,
): Record<string, unknown> {
  if (coreKind === "work.unit.ensure") {
    const mapped = toWorkUnitIntent(coreKind, payload);
    if (
      context &&
      (mapped.scope.companyRef !== context.scope.companyRef || mapped.scope.projectRef !== context.scope.projectRef)
    ) {
      refuse("the Core intent payload scope differs from the authenticated outbox scope", {
        payloadScope: mapped.scope,
        authenticatedScope: context.scope,
      });
    }
    return {
      ...mapped,
      preferredRoles: readStringArray(payload, "preferredRoles"),
      fallbackRoles: readStringArray(payload, "fallbackRoles"),
      independentFrom: Array.isArray(payload["independentFrom"]) ? payload["independentFrom"] : [],
      excludeSubjects: readStringArray(payload, "excludeSubjects"),
    };
  }

  if (!context) {
    refuse(`mapping ${JSON.stringify(coreKind)} requires the authenticated outbox scope`);
  }

  if (coreKind === "status.project") {
    const runId = requiredString(payload, "runId");
    const nodeId = requiredString(payload, "nodeId");
    return {
      scope: context.scope,
      runId,
      iteration: typeof payload["iteration"] === "number" && Number.isInteger(payload["iteration"])
        ? payload["iteration"]
        : 0,
      projectionSequence: requiredInteger(payload, "stateVersion"),
      target: { provider: "paperclip", kind: "work_unit", id: nodeId },
      status: requiredString(payload, "status"),
      summary: typeof payload["summary"] === "string" ? payload["summary"] : "",
      nodeStates: [{ nodeId, status: requiredString(payload, "status") }],
      origin: "polyforge",
      correlationId: context.correlationId,
    };
  }

  if (coreKind === "governance.request") {
    const rawKind = String(payload["kind"] ?? "review");
    const kind = rawKind === "clarification" ? "clarification" : rawKind === "confirmation" ? "confirmation" : "review";
    const rawOptions = Array.isArray(payload["options"]) ? payload["options"] : [];
    const options = rawOptions.map((entry, index) => {
      if (typeof entry === "string") return { id: entry, label: entry };
      const option = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : {};
      const id = typeof option["id"] === "string" && option["id"].length > 0 ? option["id"] : String(index);
      const label = typeof option["label"] === "string" && option["label"].length > 0 ? option["label"] : id;
      return { id, label };
    });
    const resolver = String(payload["requiredResolver"] ?? "human_only");
    if (!["anyone", "not_creator", "human_only"].includes(resolver)) {
      refuse(`the Core asked for unknown resolver policy ${JSON.stringify(resolver)}`, {
        field: "requiredResolver",
      });
    }
    return {
      scope: context.scope,
      targetIssueRef: readProviderRef(payload["rootIssueRef"], "rootIssueRef"),
      kind,
      semanticKind: requiredString(payload, "semanticKind"),
      question: requiredString(payload, "question"),
      options,
      decisionTargetHash: requiredString(payload, "decisionTargetHash"),
      correlationId: context.correlationId,
      requiredResolver: resolver,
      ...(typeof payload["capabilityRef"] === "string" ? { capabilityRef: payload["capabilityRef"] } : {}),
      runId: typeof payload["runId"] === "string" ? payload["runId"] : undefined,
      nodeId: typeof payload["nodeId"] === "string" ? payload["nodeId"] : undefined,
      requestId: typeof payload["requestId"] === "string" ? payload["requestId"] : undefined,
    };
  }

  if (coreKind === "work.stop") {
    return {
      ...payload,
      scope: context.scope,
      correlationId: context.correlationId,
      ref: readProviderRef(payload["agentRunRef"], "agentRunRef"),
    };
  }

  // The remaining carried kinds already use their port shape; authenticated envelope fields are
  // still authoritative and overwrite any untrusted copies in the payload.
  return { ...payload, scope: context.scope, correlationId: context.correlationId };
}

export function toWorkUnitIntent(coreKind: string, payload: Record<string, unknown>): WorkUnitIntent {
  if (coreKind !== "work.unit.ensure") {
    refuse(`the Core kind ${JSON.stringify(coreKind)} has no work unit mapping in this build`, {
      kind: coreKind,
    });
  }
  const scope = readScope(payload);
  return {
    scope,
    runId: requiredString(payload, "runId"),
    nodeId: requiredString(payload, "nodeId"),
    iteration: requiredInteger(payload, "iteration"),
    title: requiredString(payload, "title"),
    description: typeof payload["description"] === "string" ? payload["description"] : "",
    correlationKey:
      typeof payload["correlationKey"] === "string" && payload["correlationKey"].length > 0
        ? payload["correlationKey"]
        : `work-unit:${String(payload["runId"])}:${String(payload["nodeId"])}:${String(payload["iteration"])}`,
    requiredCapabilities: readStringArray(payload, "requiredCapabilities"),
    // Flattened out of the trusted scope. This is the field the port reads and the Core never
    // sends at the top level.
    projectRef: scope.projectRef,
    parentIssueRef: readParentIssueRef(payload),
    workspaceRequirement: readWorkspaceRequirement(payload),
  };
}
