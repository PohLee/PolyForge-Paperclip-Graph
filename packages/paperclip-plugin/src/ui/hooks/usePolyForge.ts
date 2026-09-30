/**
 * Typed wrappers over the plugin bridge.
 *
 * Two rules this module exists to enforce:
 *
 * 1. **No component hand-rolls a key string.** Every `DATA_KEYS` / `ACTION_KEYS` member gets a
 *    named hook here, so a rename in `packages/protocol` breaks this file at compile time
 *    instead of producing a runtime "unknown data key" in production.
 * 2. **Failure is a first-class state, not an absence.** `usePluginData` can leave `data` null
 *    for three very different reasons — still loading, denied, or unreachable — and a UI that
 *    collapses them renders a blank panel for an authorization failure. `describeFailure` keeps
 *    them apart, and `QueryBoundary` renders each one in words.
 *
 * A hidden button is not authorization, so nothing in this module decides whether an action is
 * allowed. The worker re-validates identity, scope, and version on every call; the UI only
 * reports what came back.
 *
 * ## Why the key tables are re-declared here instead of imported
 *
 *  The key tables are imported as *values* from `@polyforge/protocol/browser`, the browser-safe
 *  subpath of the protocol package. That subpath exists precisely because the root barrel
 *  re-exports the `node:crypto` digest surface, and this bundle is built with
 *  `platform: "browser"` against only four host-provided externals — a value import from the
 *  root barrel would fail to resolve `node:crypto` and the UI would not build.
 *
 *  Nothing here re-declares a key. `COVERED_DATA_KEYS` / `COVERED_ACTION_KEYS` list the keys this
 *  module actually exposes a hook for, and `ExactKeySet` asserts in *both* directions that the
 *  covered set is exactly the protocol's set: a rename breaks the build, and so does a key
 *  added to the protocol without a corresponding hook — the failure that would otherwise ship
 *  as a silently missing panel.
 */

import { useCallback, useMemo, useState } from "react";
import { useHostContext, usePluginAction, usePluginData } from "@paperclipai/plugin-sdk/ui";
import type { PluginBridgeError } from "@paperclipai/plugin-sdk/ui";
import { ACTION_KEYS, DATA_KEYS } from "@polyforge/protocol/browser";
import type {
  ActionKey,
  ArtifactRef,
  Blocker,
  BlockReason,
  CommandResult,
  CompileArtifact,
  DataKey,
  DomainEvent,
  EffectRecord,
  EvidenceRecord,
  ExecutionAttempt,
  GateEvaluationRecord,
  GraphDefinition,
  GraphLibraryItem,
  GraphVersionSummary,
  HealthData,
  IssueView,
  MigrationPreview,
  PendingGovernance,
  ProviderRefLike,
  RunListItem,
  RunSnapshot,
  Scope,
  SemanticDiff,
  ValidationReport,
  GraphRunStatus,
  NodeStatus,
  ProjectedIssueStatus,
} from "@polyforge/protocol/browser";

// ---------------------------------------------------------------------------
// Key coverage — the single place a key string is allowed to appear
// ---------------------------------------------------------------------------

/**
 * Asserts that a locally enumerated set is *exactly* the protocol's key union, in both directions.
 *
 * A `satisfies` check alone would only catch a key the protocol does not have. This also fails when
 * the protocol gains a key the UI has no hook for, which is the failure that would otherwise be a
 * silently missing panel in production.
 */
type ExactKeySet<TLocal extends ReadonlyArray<string>, TProtocol extends string> = [
  Exclude<TLocal[number], TProtocol>,
] extends [never]
  ? [Exclude<TProtocol, TLocal[number]>] extends [never]
    ? TLocal
    : never
  : never;

/** `ctx.data.register` keys this module exposes a typed reader for. */
const COVERED_DATA_KEYS: ExactKeySet<ReadonlyArray<DataKey>, DataKey> = [
  "health",
  "graph-library",
  "graph-draft",
  "graph-versions",
  "runtime-runs",
  "run-snapshot",
  "run-events",
  "issue-views",
  "project-views",
  "agent-views",
  "run-tab",
  "integration-health",
  "migration-preview",
] as const satisfies ReadonlyArray<DataKey>;

/** `ctx.actions.register` keys this module exposes a typed caller for. */
const COVERED_ACTION_KEYS: ExactKeySet<ReadonlyArray<ActionKey>, ActionKey> = [
  "create-draft",
  "save-draft",
  "validate-draft",
  "compile-draft",
  "publish-draft",
  "activate-version",
  "start-run",
  "run-command",
  "plan-migration",
  "commit-migration",
  "retry-node",
  "refresh",
] as const satisfies ReadonlyArray<ActionKey>;

/**
 * Runtime membership check against the protocol's tables.
 *
 * Every call site passes a statically typed key, so this never rejects anything today. It exists so
 * that a future caller who widens a parameter to `string` gets a named error here rather than an
 * opaque "unknown data key" from the worker, and so the registry is load-bearing in the emitted
 * bundle rather than a compile-time-only assertion.
 */
function registered<K extends string>(registry: ReadonlyArray<K>, key: K, kind: "data" | "action"): K {
  if (!registry.includes(key)) {
    throw new Error(`PolyForge UI: ${kind} key "${key}" is not in the protocol ${kind} key registry`);
  }
  return key;
}

// ---------------------------------------------------------------------------
// Scoping
// ---------------------------------------------------------------------------

/**
 * Company scope for every call.
 *
 * The `companyId` in a data/action payload is caller-controlled, and the worker rejects a
 * payload whose company is not the invoking scope. Passing `null` here means "this company is
 * not selected in the host", which is a distinct state the UI shows rather than a request it
 * sends with an empty scope.
 */
export interface PolyForgeScope {
  readonly companyId: string | null;
  readonly projectId: string | null;
  readonly entityId: string | null;
  readonly entityType: string | null;
  /** `true` when the host has told us which company to act in. */
  readonly scoped: boolean;
}

export function usePolyForgeScope(): PolyForgeScope {
  const context = useHostContext();
  return useMemo(
    () => ({
      companyId: context.companyId,
      projectId: context.projectId,
      entityId: context.entityId,
      entityType: context.entityType,
      scoped: typeof context.companyId === "string" && context.companyId.length > 0,
    }),
    [context.companyId, context.projectId, context.entityId, context.entityType],
  );
}

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

/**
 * Why a call did not produce data.
 *
 * `conflict` is a heuristic over the message because the host bridge collapses a worker
 * rejection to `{ code, message }`: the SDK's JSON-RPC error path sends `err.message` and a
 * numeric code, and drops `details`. The *message is always rendered verbatim* alongside this
 * classification, so a wrong guess costs the reader one sentence, and the conflict panel is
 * offered rather than asserted — the UI never claims a 409 it did not observe.
 */
export type FailureKind =
  | "not_permitted"
  | "unreachable"
  | "conflict"
  | "refused"
  | "unknown";

export interface BridgeFailure {
  readonly kind: FailureKind;
  readonly code: string;
  /** The bridge's own words, unedited. */
  readonly message: string;
  /** `PluginBridgeError.details` when the host supplied any, otherwise `null`. */
  readonly detail: unknown;
  /** What the reader can do next. Never empty: a dead end with no instructions is a defect. */
  readonly remedy: string;
}

const CONFLICT_HINTS: ReadonlyArray<string> = [
  "version conflict",
  "conflict",
  "revision",
  "if-match",
  "precondition",
  "expectedstateversion",
  "expectedrevision",
  "stale",
  "409",
  "already been modified",
];

function looksLikeConflict(message: string): boolean {
  const lowered = message.toLowerCase();
  return CONFLICT_HINTS.some((hint) => lowered.includes(hint));
}

const REMEDY: Readonly<Record<FailureKind, string>> = {
  not_permitted:
    "This session's plugin instance does not hold the capability or the scope for this call. An operator has to grant it; nothing in this page can work around it.",
  unreachable:
    "The bridge worker did not answer. The data below may be a cached earlier read, so treat it as stale until the connection returns.",
  conflict:
    "The server and this page disagree about the current revision. Reload the server's copy, compare it with your buffer, and only then choose to overwrite.",
  refused:
    "The server refused the call deterministically. Resending the same request will be refused the same way; the message above says why.",
  unknown: "The failure could not be classified. The raw bridge error is shown verbatim below.",
};

/**
 * Classify a bridge error into a renderable failure.
 *
 * The three states the product requires to be visually distinct are `not_permitted`,
 * `unreachable`, and `conflict`. Everything else is `refused` or `unknown`, and both still
 * render the server's message rather than swallowing it.
 */
export function describeFailure(code: string, rawMessage: string, detail: unknown): BridgeFailure {
  const message =
    rawMessage.length > 0 ? rawMessage : "the bridge reported a failure without a message";
  let kind: FailureKind;
  switch (code) {
    case "CAPABILITY_DENIED":
    case "INVOCATION_SCOPE_DENIED":
      kind = "not_permitted";
      break;
    case "WORKER_UNAVAILABLE":
    case "TIMEOUT":
      kind = "unreachable";
      break;
    case "WORKER_ERROR":
    case "UNKNOWN":
      kind = looksLikeConflict(message) ? "conflict" : "refused";
      break;
    default:
      kind = "unknown";
  }
  return { kind, code, message, detail: detail ?? null, remedy: REMEDY[kind] };
}

/** `null` in, `null` out — so `usePluginData().error` maps straight onto it. */
export function classifyBridgeError(error: PluginBridgeError | null | undefined): BridgeFailure | null {
  if (error === null || error === undefined) return null;
  return describeFailure(
    typeof error.code === "string" ? error.code : "UNKNOWN",
    typeof error.message === "string" ? error.message : "",
    error.details,
  );
}

export function failureHeadline(failure: BridgeFailure): string {
  switch (failure.kind) {
    case "not_permitted":
      return "Not permitted";
    case "unreachable":
      return "Connection to the PolyForge worker lost";
    case "conflict":
      return "Version conflict";
    case "refused":
      return "The server refused this call";
    case "unknown":
      return "Unclassified bridge failure";
  }
}

// ---------------------------------------------------------------------------
// Query wrapper
// ---------------------------------------------------------------------------

export interface PolyForgeQuery<T> {
  readonly data: T | null;
  readonly loading: boolean;
  readonly failure: BridgeFailure | null;
  /** Present when the call succeeded but produced nothing. Distinct from `loading`. */
  readonly empty: boolean;
  refresh(): void;
  /** `true` when the call was not made because no company is selected. */
  readonly unscoped: boolean;
}

/**
 * Uniform read surface.
 *
 * `empty` is computed against the payload rather than left to each caller, so "no data" and "data
 * that has not arrived" stop looking identical in the markup.
 *
 * The dependency list is the scope id plus the *values* of `params`, not `params` itself. Every
 * call site passes a fresh object literal, so depending on the object would rebuild the params
 * identity on every render and defeat the host's own change detection.
 */
function useQuery<T>(key: DataKey, params: Record<string, unknown>, isEmpty: (data: T) => boolean): PolyForgeQuery<T> {
  const scope = usePolyForgeScope();
  const paramValues = Object.values(params);
  const merged = useMemo<Record<string, unknown>>(
    () => ({ companyId: scope.companyId, ...params }),
    [scope.companyId, ...paramValues],
  );
  const result = usePluginData<T>(registered(COVERED_DATA_KEYS, key, "data"), merged);
  const failure = classifyBridgeError(result.error);
  const loading = result.loading && !failure;
  return useMemo(
    () => ({
      data: result.data,
      loading,
      failure,
      empty: result.data !== null && isEmpty(result.data),
      refresh: result.refresh,
      unscoped: !scope.scoped,
    }),
    [result.data, loading, failure, isEmpty, result.refresh, scope.scoped],
  );
}

const neverEmpty = (_data: unknown): boolean => false;
const listEmpty = (data: unknown): boolean => Array.isArray(data) && data.length === 0;

// ---------------------------------------------------------------------------
// Reads — one hook per DATA_KEY
// ---------------------------------------------------------------------------

export function useHealth(): PolyForgeQuery<HealthData> {
  return useQuery<HealthData>("health", {}, neverEmpty);
}

/** Same document as `health`, registered separately so a dashboard and a page can load apart. */
export function useIntegrationHealth(): PolyForgeQuery<HealthData> {
  return useQuery<HealthData>("integration-health", {}, neverEmpty);
}

export function useGraphLibrary(): PolyForgeQuery<GraphLibraryItem[]> {
  return useQuery<GraphLibraryItem[]>("graph-library", {}, listEmpty);
}

export function useGraphVersions(graphId: string | null): PolyForgeQuery<GraphVersionSummary[]> {
  return useQuery<GraphVersionSummary[]>(
    "graph-versions",
    // An absent id makes the worker return `{ versions: [] }`, so the hook stays inert rather
    // than being conditionally called.
    { graphId: graphId ?? "" },
    listEmpty,
  );
}

export function useRuntimeRuns(filter?: {
  graphId?: string | null;
  status?: string | null;
  limit?: number;
}): PolyForgeQuery<RunListItem[]> {
  return useQuery<RunListItem[]>(
    "runtime-runs",
    {
      graphId: filter?.graphId ?? "",
      status: filter?.status ?? "",
      limit: filter?.limit ?? 100,
    },
    listEmpty,
  );
}

export function useIssueViews(issueId: string | null): PolyForgeQuery<IssueView[]> {
  return useQuery<IssueView[]>("issue-views", { issueId: issueId ?? "" }, listEmpty);
}

export function useRunTab(runId: string | null): PolyForgeQuery<RunTabView> {
  return useQuery<RunTabView>("run-tab", { runId: runId ?? "" }, (data) => data === null);
}

export function useRunSnapshot(runId: string | null): PolyForgeQuery<RunSnapshot> {
  return useQuery<RunSnapshot>("run-snapshot", { runId: runId ?? "" }, (data) => data === null);
}

export function useRunEvents(
  runId: string | null,
  after: number,
  limit = 500,
): PolyForgeQuery<RunEventPage> {
  return useQuery<RunEventPage>(
    "run-events",
    { runId: runId ?? "", after, limit },
    (data) => !Array.isArray(data.events) || data.events.length === 0,
  );
}

export function useProjectViews(projectId: string | null): PolyForgeQuery<ProjectView[]> {
  return useQuery<ProjectView[]>("project-views", { projectId: projectId ?? "" }, listEmpty);
}

export function useAgentViews(
  filter?: { runId?: string | null; nodeId?: string | null },
): PolyForgeQuery<AgentView[]> {
  return useQuery<AgentView[]>(
    "agent-views",
    { runId: filter?.runId ?? "", nodeId: filter?.nodeId ?? "" },
    listEmpty,
  );
}

export function useMigrationPreview(
  runId: string | null,
  targetGraphVersion: number | null,
): PolyForgeQuery<MigrationPreview> {
  return useQuery<MigrationPreview>(
    "migration-preview",
    { runId: runId ?? "", targetGraphVersion: targetGraphVersion ?? 0 },
    (data) => data === null,
  );
}

// ---------------------------------------------------------------------------
// Draft reads
// ---------------------------------------------------------------------------

/** The Core's `getDraft` payload, narrowed. `definition` is the authoritative graph structure. */
export interface DraftPayload {
  readonly draft: DraftSummaryView;
  readonly definition: GraphDefinition;
}

export interface DraftSummaryView {
  readonly draftId: string;
  readonly graphId: string;
  readonly baseVersion: number | null;
  readonly revision: number;
  readonly author: string;
  readonly updatedAt: string;
  readonly definitionHash: string;
  readonly validationRef: string | null;
  readonly compileRef: string | null;
}

export function useGraphDraft(draftId: string | null): PolyForgeQuery<DraftPayload> {
  return useQuery<DraftPayload>(
    "graph-draft",
    { draftId: draftId ?? "" },
    (data) => data === null || data.draft === null,
  );
}

// ---------------------------------------------------------------------------
// Worker shapes that the protocol does not type
// ---------------------------------------------------------------------------

/**
 * `run-tab` is a single round trip that the worker assembles from the Core snapshot.
 *
 * The protocol types every piece of it, but not the envelope, so the envelope is declared here
 * with narrowing. `projectedIssueStatus` is a *projection* and is kept under a name that says so
 * at every call site.
 */
export interface RunTabView {
  readonly run: {
    readonly runId: string;
    readonly graphId: string;
    readonly graphVersion: number;
    readonly pins: Readonly<Record<string, string>>;
    readonly status: string;
    readonly stateVersion: number;
    readonly eventSequence: number;
    readonly scope: Scope;
  };
  readonly nodes: ReadonlyArray<RunTabNode>;
  readonly attempts: ExecutionAttempt[];
  readonly evidence: EvidenceRecord[];
  readonly gates: GateEvaluationRecord[];
  readonly effects: EffectRecord[];
  readonly pendingGovernance: PendingGovernance[];
  readonly blockers: Blocker[];
  readonly authoritativeSnapshot: { runId: string; stateVersion: number; eventSequence: number };
  readonly authoritative: boolean;
  readonly streamIsHintOnly: boolean;
  readonly projectionLagSeconds: number | null;
}

export interface RunTabNode {
  readonly nodeId: string;
  readonly kind: string;
  readonly status: string;
  readonly iteration: number;
  readonly waitReason: string | null;
  readonly blockReason: string | null;
  readonly requiredCapabilities: string[];
  readonly assignedSubject: string | null;
  readonly childRunId: string | null;
  readonly contractHash: string | null;
  /** A Paperclip projection of `status`. Never a gate result. */
  readonly projectedIssueStatus: string | null;
}

export interface RunEventPage {
  readonly events: DomainEvent[];
}

export interface ProjectView {
  readonly projectId: string;
  readonly name: string;
  readonly primaryWorkspace: { id: string; path: string; isPrimary: true } | null;
  /** `metadata_only` means the bridge reads workspace metadata and never provisions one. */
  readonly workspaceMode: string;
  readonly graphIds: string[];
}

export interface AgentCapabilityBinding {
  readonly agentId: string;
  readonly projectRef: string | null;
  readonly runId: string | null;
  readonly nodeId: string | null;
  readonly capabilities: string[];
  readonly grantedAt: string | null;
  readonly scope: string | null;
}

export interface AgentDispatch {
  readonly runId: string;
  readonly nodeId: string;
  readonly iteration: number;
  readonly issueId: string | null;
  /** `null` means the platform has not reported an outcome. That is an unknown, not a success. */
  readonly lastObservation: { state: string; detail: string | null } | null;
}

export interface AgentView {
  readonly agentId: string;
  readonly name: string;
  readonly role: string;
  /** Paperclip's own agent status. PolyForge reports it and never asserts it. */
  readonly platformStatus: string;
  readonly engineeringBindings: AgentCapabilityBinding[];
  readonly bindingsAreEngineeringScoped: boolean;
  readonly dispatches: AgentDispatch[];
  readonly matcher: CapabilityMatch | null;
}

export interface CapabilityMatch {
  readonly eligible: boolean;
  readonly agentId: string | null;
  readonly reason: string;
  readonly missingCapabilities: string[];
  readonly roleFit: boolean;
}

// -- narrowers ---------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function nullableStr(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function nullableNum(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function strRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") out[key] = item;
  }
  return out;
}

function narrowRunTabNode(value: unknown): RunTabNode | null {
  if (!isRecord(value)) return null;
  const nodeId = str(value["nodeId"]);
  if (nodeId.length === 0) return null;
  return {
    nodeId,
    kind: str(value["kind"], "unknown_kind"),
    status: str(value["status"], ""),
    iteration: num(value["iteration"], 0),
    waitReason: nullableStr(value["waitReason"]),
    blockReason: nullableStr(value["blockReason"]),
    requiredCapabilities: strArray(value["requiredCapabilities"]),
    assignedSubject: nullableStr(value["assignedSubject"]),
    childRunId: nullableStr(value["childRunId"]),
    contractHash: nullableStr(value["contractHash"]),
    projectedIssueStatus: nullableStr(value["projectedIssueStatus"]),
  };
}

function narrowProviderRef(value: unknown): ProviderRefLike | null {
  if (!isRecord(value)) return null;
  const provider = str(value["provider"]);
  const id = str(value["id"]);
  if (provider.length === 0 || id.length === 0) return null;
  const revision = nullableStr(value["revision"]);
  return revision === null
    ? { provider, kind: str(value["kind"], "unknown"), id }
    : { provider, kind: str(value["kind"], "unknown"), id, revision };
}

function narrowAttempt(value: unknown): ExecutionAttempt | null {
  if (!isRecord(value)) return null;
  const attemptId = str(value["attemptId"]);
  if (attemptId.length === 0) return null;
  return {
    attemptId,
    runId: str(value["runId"]),
    nodeId: str(value["nodeId"]),
    iteration: num(value["iteration"], 0),
    attemptNo: num(value["attemptNo"], 0),
    transitionHash: str(value["transitionHash"]),
    // An attempt status this build does not recognise stays UNKNOWN rather than being folded
    // into COMPLETED. An attempt ledger is read to decide whether work may proceed.
    status: isAttemptStatus(value["status"]) ? value["status"] : "UNKNOWN",
    leaseEpoch: num(value["leaseEpoch"], 0),
    agentSubject: nullableStr(value["agentSubject"]),
    agentRunRef: narrowProviderRef(value["agentRunRef"]),
    startedAt: str(value["startedAt"]),
    finishedAt: nullableStr(value["finishedAt"]),
    checkpointRef: nullableStr(value["checkpointRef"]),
  };
}

function narrowEvidence(value: unknown): EvidenceRecord | null {
  if (!isRecord(value)) return null;
  const evidenceId = str(value["evidenceId"]);
  if (evidenceId.length === 0) return null;
  const artifacts: ArtifactRef[] = Array.isArray(value["artifacts"])
    ? (value["artifacts"] as unknown[])
        .map((item): ArtifactRef | null => {
          if (!isRecord(item)) return null;
          const artifactId = str(item["artifactId"]);
          if (artifactId.length === 0) return null;
          return {
            artifactId,
            kind: str(item["kind"], "unknown"),
            contentHash: str(item["contentHash"]),
            mediaType: str(item["mediaType"], "application/octet-stream"),
            size: num(item["size"], 0),
            providerRef: narrowProviderRef(item["providerRef"]),
            repository: isRecord(item["repository"])
              ? { repoRef: str(item["repository"]["repoRef"]), commit: str(item["repository"]["commit"]) }
              : null,
            createdAt: str(item["createdAt"]),
          };
        })
        .filter((item): item is ArtifactRef => item !== null)
    : [];
  return {
    evidenceId,
    runId: str(value["runId"]),
    nodeId: str(value["nodeId"]),
    kind: str(value["kind"], "unknown"),
    transitionHash: str(value["transitionHash"]),
    artifacts,
    producerSubject: str(value["producerSubject"], "not reported"),
    producerRunRef: narrowProviderRef(value["producerRunRef"]),
    inputRevisionBindings: strRecord(value["inputRevisionBindings"]),
    valid: value["valid"] === true,
    invalidatedReason: nullableStr(value["invalidatedReason"]),
    createdAt: str(value["createdAt"]),
  };
}

function narrowGate(value: unknown): GateEvaluationRecord | null {
  if (!isRecord(value)) return null;
  const evaluationId = str(value["evaluationId"]);
  if (evaluationId.length === 0) return null;
  return {
    evaluationId,
    gateId: str(value["gateId"]),
    evaluatorRef: str(value["evaluatorRef"]),
    // An unrecognised evaluator kind renders as `human_decision`, the most conservative reading:
    // a gate whose evaluator the UI cannot name is a gate whose independence is unproven.
    evaluatorKind: isEvaluatorKind(value["evaluatorKind"]) ? value["evaluatorKind"] : "human_decision",
    evaluatorVersion: str(value["evaluatorVersion"]),
    transitionHash: str(value["transitionHash"]),
    evidenceSetHash: str(value["evidenceSetHash"]),
    // Anything that is not literally PASS is not a pass. A gate result is the single place a
    // PASS originates, so it is the last thing in the UI that may be guessed.
    result: value["result"] === "PASS" ? "PASS" : value["result"] === "FAIL" ? "FAIL" : "ESCALATE",
    reason: str(value["reason"], "no reason recorded"),
    createdAt: str(value["createdAt"]),
  };
}

function isAttemptStatus(value: unknown): value is ExecutionAttempt["status"] {
  return (
    value === "PREPARED" ||
    value === "RUNNING" ||
    value === "CHECKPOINTED" ||
    value === "EVIDENCE_READY" ||
    value === "COMPLETED" ||
    value === "FAILED" ||
    value === "CANCELLED" ||
    value === "UNKNOWN" ||
    value === "RECONCILING"
  );
}

function isEvaluatorKind(value: unknown): value is GateEvaluationRecord["evaluatorKind"] {
  return value === "automatic" || value === "independent_agent" || value === "human_decision";
}

function narrowEffect(value: unknown): EffectRecord | null {
  if (!isRecord(value)) return null;
  const effectKey = str(value["effectKey"]);
  if (effectKey.length === 0) return null;
  return {
    effectKey,
    transitionHash: str(value["transitionHash"]),
    stepId: str(value["stepId"]),
    // Anything the UI does not recognise stays UNKNOWN. An effect ledger is exactly where a
    // guessed status would cause a duplicate external call.
    status: isEffectStatus(value["status"]) ? value["status"] : "UNKNOWN",
    providerRef: narrowProviderRef(value["providerRef"]),
    requestHash: str(value["requestHash"]),
    resultHash: nullableStr(value["resultHash"]),
    reconciliationNote: nullableStr(value["reconciliationNote"]),
    updatedAt: str(value["updatedAt"]),
  };
}

function isEffectStatus(value: unknown): value is EffectRecord["status"] {
  return value === "PENDING" || value === "EFFECTED" || value === "NOT_EFFECTED" || value === "UNKNOWN";
}

function narrowPendingGovernance(value: unknown): PendingGovernance | null {
  if (!isRecord(value)) return null;
  const requestId = str(value["requestId"]);
  if (requestId.length === 0) return null;
  return {
    requestId,
    kind: isGovernanceKind(value["kind"]) ? value["kind"] : "interaction",
    gateId: str(value["gateId"]),
    nodeId: str(value["nodeId"]),
    transitionHash: str(value["transitionHash"]),
    decisionTargetHash: str(value["decisionTargetHash"]),
    semanticKind: str(value["semanticKind"], "unknown"),
    providerRef: narrowProviderRef(value["providerRef"]),
    createdAt: str(value["createdAt"]),
    expiresAt: nullableStr(value["expiresAt"]),
    resolvedAt: nullableStr(value["resolvedAt"]),
  };
}

function isGovernanceKind(value: unknown): value is PendingGovernance["kind"] {
  return value === "interaction" || value === "decision" || value === "authorization";
}

function narrowBlocker(value: unknown): Blocker | null {
  if (!isRecord(value)) return null;
  return {
    code: str(value["code"], "UNKNOWN"),
    reason: str(value["reason"], "BLOCKED_PLATFORM") as BlockReason | string,
    message: str(value["message"], "the blocker carried no message"),
  };
}

function narrowArtifactList(value: unknown): ArtifactRef[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is ArtifactRef => isRecord(item) && typeof item["artifactId"] === "string");
}

/**
 * Normalise the `run-tab` envelope.
 *
 * Returns `null` only when the run block is missing. A partially-typed envelope still renders:
 * an unreadable gate list must not hide the node states a reviewer is blocked on.
 */
export function narrowRunTab(value: unknown): RunTabView | null {
  if (!isRecord(value)) return null;
  const run = value["run"];
  if (!isRecord(run) || str(run["runId"]).length === 0) return null;
  const authoritative = isRecord(value["authoritativeSnapshot"])
    ? {
        runId: str(value["authoritativeSnapshot"]["runId"], str(run["runId"])),
        stateVersion: num(value["authoritativeSnapshot"]["stateVersion"], num(run["stateVersion"], 0)),
        eventSequence: num(value["authoritativeSnapshot"]["eventSequence"], num(run["eventSequence"], 0)),
      }
    : {
        runId: str(run["runId"]),
        stateVersion: num(run["stateVersion"], 0),
        eventSequence: num(run["eventSequence"], 0),
      };
  return {
    run: {
      runId: str(run["runId"]),
      graphId: str(run["graphId"], "not reported"),
      graphVersion: num(run["graphVersion"], 0),
      pins: strRecord(run["pins"]),
      status: str(run["status"], ""),
      stateVersion: num(run["stateVersion"], 0),
      eventSequence: num(run["eventSequence"], 0),
      scope: {
        companyRef: str(isRecord(run["scope"]) ? run["scope"]["companyRef"] : "", ""),
        projectRef: str(isRecord(run["scope"]) ? run["scope"]["projectRef"] : "", ""),
      },
    },
    nodes: Array.isArray(value["nodes"])
      ? (value["nodes"] as unknown[]).map(narrowRunTabNode).filter((n): n is RunTabNode => n !== null)
      : [],
    attempts: Array.isArray(value["attempts"])
      ? (value["attempts"] as unknown[]).map(narrowAttempt).filter((a): a is ExecutionAttempt => a !== null)
      : [],
    evidence: Array.isArray(value["evidence"])
      ? (value["evidence"] as unknown[]).map(narrowEvidence).filter((e): e is EvidenceRecord => e !== null)
      : [],
    gates: Array.isArray(value["gates"])
      ? (value["gates"] as unknown[]).map(narrowGate).filter((g): g is GateEvaluationRecord => g !== null)
      : [],
    effects: Array.isArray(value["effects"])
      ? (value["effects"] as unknown[]).map(narrowEffect).filter((e): e is EffectRecord => e !== null)
      : [],
    pendingGovernance: Array.isArray(value["pendingGovernance"])
      ? (value["pendingGovernance"] as unknown[])
          .map(narrowPendingGovernance)
          .filter((g): g is PendingGovernance => g !== null)
      : [],
    blockers: Array.isArray(value["blockers"])
      ? (value["blockers"] as unknown[]).map(narrowBlocker).filter((b): b is Blocker => b !== null)
      : [],
    authoritativeSnapshot: authoritative,
    authoritative: value["authoritative"] === true,
    streamIsHintOnly: value["streamIsHintOnly"] !== false,
    projectionLagSeconds: nullableNum(value["projectionLagSeconds"]),
  };
}

function narrowDraftSummary(value: unknown): DraftSummaryView | null {
  if (!isRecord(value)) return null;
  const draftId = str(value["draftId"]);
  if (draftId.length === 0) return null;
  return {
    draftId,
    graphId: str(value["graphId"], "not reported"),
    baseVersion: nullableNum(value["baseVersion"]),
    revision: num(value["revision"], 0),
    author: str(value["author"], "not reported"),
    updatedAt: str(value["updatedAt"]),
    definitionHash: str(value["definitionHash"]),
    validationRef: nullableStr(value["validationRef"]),
    compileRef: nullableStr(value["compileRef"]),
  };
}

/**
 * Coerce the Core's definition payload.
 *
 * The Core is the validator; this only refuses to hand the editor something it cannot edit. A
 * rejected payload is reported as such and the buffer is left empty, because a half-parsed graph
 * that then gets saved is a definition nobody validated.
 */
export function narrowDefinition(value: unknown): GraphDefinition | null {
  if (!isRecord(value)) return null;
  if (typeof value["graphId"] !== "string" || value["graphId"].length === 0) return null;
  if (!isRecord(value["nodes"]) || !isRecord(value["entrypoints"])) return null;
  if (!Array.isArray(value["edges"])) return null;
  return value as unknown as GraphDefinition;
}

export function narrowDraftPayload(value: unknown): DraftPayload | null {
  if (!isRecord(value)) return null;
  const draft = narrowDraftSummary(value["draft"]);
  if (draft === null) return null;
  const definition = narrowDefinition(value["definition"]);
  if (definition === null) return null;
  return { draft, definition };
}

export function narrowRunEventPage(value: unknown): RunEventPage {
  if (!isRecord(value)) return { events: [] };
  const events: DomainEvent[] = Array.isArray(value["events"])
    ? (value["events"] as unknown[]).filter(
        (item): item is DomainEvent => isRecord(item) && typeof item["seq"] === "number" && typeof item["type"] === "string",
      )
    : [];
  return { events };
}

function narrowProjectView(value: unknown): ProjectView | null {
  if (!isRecord(value)) return null;
  const projectId = str(value["projectId"]);
  if (projectId.length === 0) return null;
  const workspace = value["primaryWorkspace"];
  return {
    projectId,
    name: str(value["name"], projectId),
    primaryWorkspace:
      isRecord(workspace) && typeof workspace["id"] === "string"
        ? { id: workspace["id"], path: str(workspace["path"], "not reported"), isPrimary: true as const }
        : null,
    workspaceMode: str(value["workspaceMode"], "unknown"),
    graphIds: strArray(value["graphIds"]),
  };
}

function narrowCapabilityBinding(value: unknown): AgentCapabilityBinding | null {
  if (!isRecord(value)) return null;
  return {
    agentId: str(value["agentId"], "not reported"),
    projectRef: nullableStr(value["projectRef"]),
    runId: nullableStr(value["runId"]),
    nodeId: nullableStr(value["nodeId"]),
    capabilities: strArray(value["capabilities"]),
    grantedAt: nullableStr(value["grantedAt"]),
    scope: nullableStr(value["scope"]),
  };
}

function narrowObservation(value: unknown): AgentDispatch["lastObservation"] {
  if (!isRecord(value)) return null;
  return { state: str(value["state"], "unknown"), detail: nullableStr(value["detail"]) };
}

function narrowDispatch(value: unknown): AgentDispatch | null {
  if (!isRecord(value)) return null;
  const runId = str(value["runId"]);
  const nodeId = str(value["nodeId"]);
  if (runId.length === 0 || nodeId.length === 0) return null;
  return {
    runId,
    nodeId,
    iteration: num(value["iteration"], 0),
    issueId: nullableStr(value["issueId"]),
    lastObservation: narrowObservation(value["lastObservation"]),
  };
}

function narrowMatcher(value: unknown): CapabilityMatch | null {
  if (!isRecord(value)) return null;
  return {
    eligible: value["eligible"] === true,
    agentId: nullableStr(value["agentId"]),
    reason: str(value["reason"], "no reason recorded"),
    missingCapabilities: strArray(value["missingCapabilities"]),
    roleFit: value["roleFit"] === true,
  };
}

function narrowAgentView(value: unknown): AgentView | null {
  if (!isRecord(value)) return null;
  const agentId = str(value["agentId"]);
  if (agentId.length === 0) return null;
  return {
    agentId,
    name: str(value["name"], agentId),
    role: str(value["role"], "not reported"),
    platformStatus: str(value["platformStatus"], str(value["status"], "not reported")),
    engineeringBindings: Array.isArray(value["engineeringBindings"])
      ? (value["engineeringBindings"] as unknown[])
          .map(narrowCapabilityBinding)
          .filter((b): b is AgentCapabilityBinding => b !== null)
      : [],
    bindingsAreEngineeringScoped: value["bindingsAreEngineeringScoped"] === true,
    dispatches: Array.isArray(value["dispatches"])
      ? (value["dispatches"] as unknown[]).map(narrowDispatch).filter((d): d is AgentDispatch => d !== null)
      : [],
    matcher: "matcher" in value ? narrowMatcher(value["matcher"]) : null,
  };
}

export function narrowProjectViews(value: unknown): ProjectView[] {
  return Array.isArray(value)
    ? value.map(narrowProjectView).filter((v): v is ProjectView => v !== null)
    : [];
}

export function narrowAgentViews(value: unknown): AgentView[] {
  return Array.isArray(value)
    ? value.map(narrowAgentView).filter((v): v is AgentView => v !== null)
    : [];
}

export function narrowGraphVersions(value: unknown): GraphVersionSummary[] {
  if (!isRecord(value)) return [];
  const versions = value["versions"];
  if (!Array.isArray(versions)) return [];
  return versions.filter((item): item is GraphVersionSummary => isRecord(item) && typeof item["version"] === "number");
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * A completed action, or a classified failure.
 *
 * The action helpers resolve with a discriminated union rather than throwing, because a thrown
 * `PluginBridgeError` inside a click handler is exactly how a refusal turns into a console line
 * and a button that looks like it worked.
 */
export type ActionResult<T> = { ok: true; value: T } | { ok: false; failure: BridgeFailure };

export interface ActionRunner<TParams extends Record<string, unknown>, TResult> {
  readonly run: (params: TParams) => Promise<ActionResult<TResult>>;
  readonly pending: boolean;
  /** The most recent failure. Kept so a panel can still explain itself after a re-render. */
  readonly failure: BridgeFailure | null;
  clearFailure(): void;
}

function toBridgeFailure(thrown: unknown): BridgeFailure {
  if (typeof thrown === "object" && thrown !== null) {
    const record = thrown as { code?: unknown; message?: unknown; details?: unknown };
    return describeFailure(
      typeof record.code === "string" ? record.code : "UNKNOWN",
      typeof record.message === "string" ? record.message : String(thrown),
      record.details,
    );
  }
  return describeFailure("UNKNOWN", String(thrown), null);
}

/**
 * One typed action bound to one `ACTION_KEYS` member and scoped to the active company.
 *
 * `companyId` is injected here rather than at each call site: the worker compares it against the
 * host-authorized company, and a caller that forgets it gets a scope violation it cannot
 * diagnose. Nothing in this file decides whether the action is *permitted* — the worker
 * re-authorizes identity, scope, and version on every call, and a hidden button is not the
 * control.
 */
function useAction<TParams extends Record<string, unknown>, TResult>(
  key: ActionKey,
): ActionRunner<TParams, TResult> {
  const scope = usePolyForgeScope();
  const invoke = usePluginAction(registered(COVERED_ACTION_KEYS, key, "action"));
  const [state, setState] = useState<{ pending: boolean; failure: BridgeFailure | null }>({
    pending: false,
    failure: null,
  });

  const run = useCallback(
    async (params: TParams): Promise<ActionResult<TResult>> => {
      setState({ pending: true, failure: null });
      try {
        const value = (await invoke({ companyId: scope.companyId, ...params })) as TResult;
        setState({ pending: false, failure: null });
        return { ok: true as const, value };
      } catch (thrown) {
        const failure = toBridgeFailure(thrown);
        setState({ pending: false, failure });
        return { ok: false as const, failure };
      }
    },
    [invoke, scope.companyId],
  );

  const clearFailure = useCallback(() => {
    setState((previous) => (previous.failure === null ? previous : { ...previous, failure: null }));
  }, []);

  return useMemo(
    () => ({ run, pending: state.pending, failure: state.failure, clearFailure }),
    [run, state.pending, state.failure, clearFailure],
  );
}

// -- authoring ---------------------------------------------------------------

export function useCreateDraft(): ActionRunner<
  { graphId: string; baseVersion?: number; projectId?: string },
  unknown
> {
  return useAction("create-draft");
}

/** Carries the draft revision the client believes it is editing; the Core answers 409 on a stale one. */
export function useSaveDraft(): ActionRunner<
  { draftId: string; revision: string; definition: unknown; changeSummary?: string; projectId?: string },
  unknown
> {
  return useAction("save-draft");
}

export function useValidateDraft(): ActionRunner<{ draftId: string; projectId?: string }, unknown> {
  return useAction("validate-draft");
}

export function useCompileDraft(): ActionRunner<{ draftId: string; projectId?: string }, unknown> {
  return useAction("compile-draft");
}

/**
 * Record a human review of one exact target hash on the current revision.
 *
 * A review has to exist *in the Core* before a publish can cite it, so this is a real write and not
 * a local annotation. The editor's "attest" control used to fill in local state only, which left the
 * Core with no review and every publish refused with "publishing requires a review bound to the
 * current revision" — while the UI reported the step as done.
 */
export function useRecordDraftReview(): ActionRunner<
  {
    draftId: string;
    reviewTargetHash: string;
    authorizationRefs?: string[];
    projectId?: string;
  },
  unknown
> {
  return useAction("record-draft-review");
}
/**
 * Publish is a compare-and-swap on `expectedRevision`, `definitionHash`, `compilerVersion`,
 * `planHash`, and `reviewTargetHash`. Every one of those must name the *same* target; that is why
 * the editor refuses to publish from a stale stage.
 */
export function usePublishDraft(): ActionRunner<
  {
    draftId: string;
    expectedRevision: number;
    definitionHash: string;
    compilerVersion: string;
    planHash: string;
    reviewTargetHash: string;
    authorizationRefs?: string[];
    projectId?: string;
  },
  unknown
> {
  return useAction("publish-draft");
}

// -- version lifecycle -------------------------------------------------------

/**
 * Activation moves the *default version pointer*. It does not touch any run: a running instance
 * keeps the closure it pinned at creation (AT-19), so this only changes what future runs adopt.
 */
export function useActivateVersion(): ActionRunner<
  { graphId: string; version: number; expectedGeneration: number; projectId?: string },
  unknown
> {
  return useAction("activate-version");
}

export function useStartRun(): ActionRunner<
  { issueId: string; graphId?: string; entrypoint?: string; reason?: string },
  unknown
> {
  return useAction("start-run");
}

// -- runtime control ---------------------------------------------------------

/**
 * Runtime commands. Every one of these is a server call the worker re-authorizes, so the UI's job
 * is to state what will happen and show the result — not to decide whether it may.
 */
export function useRunCommand(): ActionRunner<
  {
    runId: string;
    command: "pause" | "resume" | "cancel" | "retry" | "resolve_block";
    nodeId?: string;
    reason: string;
    projectId?: string;
  },
  unknown
> {
  return useAction("run-command");
}

export function useRetryNode(): ActionRunner<
  { runId: string; nodeId?: string; reason?: string; projectId?: string },
  unknown
> {
  return useAction("retry-node");
}

// -- migration ---------------------------------------------------------------

export function usePlanMigration(): ActionRunner<
  { runId: string; targetGraphVersion: number; nodeMapping?: Record<string, string>; projectId?: string },
  unknown
> {
  return useAction("plan-migration");
}

/** Commits on a reviewed `planHash` and a compare-and-swap on `expectedStateVersion`. */
export function useCommitMigration(): ActionRunner<
  { runId: string; planHash: string; expectedStateVersion: number; projectId?: string },
  unknown
> {
  return useAction("commit-migration");
}

// -- read-only refresh -------------------------------------------------------

/**
 * Cheap, non-mutating, and callable by any actor. This is the call a UI makes after a dropped
 * stream, because the last event the browser happened to see is not evidence of anything.
 */
export function useRefresh(): ActionRunner<{ runId?: string; projectId?: string }, unknown> {
  return useAction("refresh");
}

// ---------------------------------------------------------------------------
// Result readers
// ---------------------------------------------------------------------------

/** Narrow a `CommandResult`. `applied: false` is reported as such, never as a success. */
export function readCommandResult(value: unknown): CommandResult | null {
  if (!isRecord(value)) return null;
  return {
    commandId: str(value["commandId"], "not reported"),
    applied: value["applied"] === true,
    stateVersion: num(value["stateVersion"], 0),
    status: str(value["status"], "not reported"),
    resultRef: nullableStr(value["resultRef"]) ?? undefined,
    blockers: readBlockers(value["blockers"]),
    pending: value["pending"] === true,
    pendingReason: nullableStr(value["pendingReason"]) ?? undefined,
  };
}

export function readValidationReport(value: unknown): ValidationReport | null {
  if (!isRecord(value)) return null;
  const revision = num(value["revision"], -1);
  if (revision < 0) return null;
  const issues = Array.isArray(value["issues"])
    ? (value["issues"] as unknown[]).filter(
        (item): item is ValidationReport["issues"][number] =>
          isRecord(item) && typeof item["path"] === "string" && typeof item["message"] === "string",
      )
    : [];
  return {
    draftId: str(value["draftId"]),
    revision,
    definitionHash: str(value["definitionHash"]),
    ok: value["ok"] === true,
    issues,
  };
}

export function readCompileArtifact(value: unknown): CompileArtifact | null {
  if (!isRecord(value)) return null;
  if (typeof value["planHash"] !== "string" || typeof value["compilerVersion"] !== "string") return null;
  return {
    draftId: str(value["draftId"]),
    revision: num(value["revision"], -1),
    definitionHash: str(value["definitionHash"]),
    compilerVersion: value["compilerVersion"],
    planHash: value["planHash"],
    dependencyLockHash: str(value["dependencyLockHash"]),
    closure: strRecord(value["closure"]),
  };
}

/**
 * Read the review the Core recorded, from a draft view.
 *
 * The editor needs the *stored* reviewer, not the name someone typed. A review is a durable record
 * bound to one target hash on one revision, and the only thing that can say which reviewer the Core
 * holds is the Core's own answer. Building this from local state is what made the panel show a
 * completed review while the Core had none.
 *
 * Returns `null` when the response is not a draft carrying a review, so the caller can refuse
 * rather than display an empty attestation as if it were real.
 */
export function readRecordedReview(
  value: unknown,
): { reviewer: string; targetHash: string; recordedAt: string } | null {
  if (!isRecord(value)) return null;
  const reviewTargetHash = value["reviewTargetHash"];
  const reviewReviewer = value["reviewReviewer"];
  if (typeof reviewTargetHash !== "string" || reviewTargetHash.length === 0) return null;
  if (typeof reviewReviewer !== "string" || reviewReviewer.length === 0) return null;
  const updatedAt = value["updatedAt"];
  return {
    reviewer: reviewReviewer,
    targetHash: reviewTargetHash,
    // The draft's own update time is the closest thing to "when this review landed" that the
    // response carries, and it is a server fact rather than a locally generated timestamp.
    recordedAt: typeof updatedAt === "string" ? updatedAt : new Date(0).toISOString(),
  };
}

export function readSemanticDiff(value: unknown): SemanticDiff | null {
  if (!isRecord(value)) return null;
  return {
    graphId: str(value["graphId"], "not reported"),
    fromVersion: nullableNum(value["fromVersion"]),
    toVersion: nullableNum(value["toVersion"]),
    addedNodes: strArray(value["addedNodes"]),
    removedNodes: strArray(value["removedNodes"]),
    changedNodes: strArray(value["changedNodes"]),
    addedEdges: strArray(value["addedEdges"]),
    removedEdges: strArray(value["removedEdges"]),
    policyChanges: strArray(value["policyChanges"]),
    invalidatesEvidence: value["invalidatesEvidence"] === true,
  };
}

export function readBlockers(value: unknown): Blocker[] {
  if (!Array.isArray(value)) return [];
  return value.map(narrowBlocker).filter((b): b is Blocker => b !== null);
}

export function readArtifacts(value: unknown): ArtifactRef[] {
  return narrowArtifactList(value);
}

export function readIssueViews(value: unknown): IssueView[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is IssueView => isRecord(item) && typeof item["issueId"] === "string",
  );
}

export function readGraphLibrary(value: unknown): GraphLibraryItem[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is GraphLibraryItem => isRecord(item) && typeof item["graphId"] === "string");
}

export function readRunList(value: unknown): RunListItem[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is RunListItem => isRecord(item) && typeof item["runId"] === "string");
}

export function readHealth(value: unknown): HealthData | null {
  if (!isRecord(value)) return null;
  if (typeof value["status"] !== "string") return null;
  if (!isRecord(value["counters"]) || !isRecord(value["runtime"]) || !isRecord(value["host"])) return null;
  if (!Array.isArray(value["issues"])) return null;
  return value as unknown as HealthData;
}

/**
 * Status vocabularies as *types*, so a component can ask "is this a recognised state?" by
 * narrowing rather than by looking a string up in a runtime array it has to keep in sync.
 */
export type StatusVocabularies = {
  readonly graphRun: GraphRunStatus;
  readonly node: NodeStatus;
  readonly issue: ProjectedIssueStatus;
};
