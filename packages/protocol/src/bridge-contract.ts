/**
 * Contract between the plugin worker and the plugin UI.
 *
 * The UI never talks to the Runtime Service directly and never writes engineering state
 * from the browser. It calls a named `data` key for reads and a named `action` key for
 * writes; the worker re-validates identity, scope, and version server-side. Hiding a
 * button is not authorization, so every action here is also enforced on the server.
 *
 * Both sides import these names, so a rename breaks the build rather than production.
 */

/** Read keys registered with `ctx.data.register`. */
export const DATA_KEYS = [
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
] as const;
export type DataKey = (typeof DATA_KEYS)[number];

/** Write keys registered with `ctx.actions.register`. */
export const ACTION_KEYS = [
  "create-draft",
  "save-draft",
  "validate-draft",
  "compile-draft",
  /**
   * Record a human review of one exact target hash on the current draft revision.
   *
   * It is an action and not a UI-only step because publication requires a review the Core has
   * persisted. An editor that collects a reviewer's name in local state produces an attestation,
   * not a review, and the Core is right to refuse to publish on the strength of one.
   */
  "record-draft-review",
  "publish-draft",
  "activate-version",
  "start-run",
  "run-command",
  "plan-migration",
  "commit-migration",
  "retry-node",
  "refresh",
] as const;
export type ActionKey = (typeof ACTION_KEYS)[number];

/**
 * Every data/action payload carries the company id. The worker rejects a payload whose
 * company is not the company of the invoking scope, so a UI cannot read across tenants by
 * passing another company's id.
 */
export interface ScopedParams {
  companyId: string;
}

export interface HealthData {
  status: "ready" | "read_only" | "degraded" | "blocked";
  runtime: {
    reachable: boolean;
    status: string | null;
    protocolVersion: number | null;
    schemaVersion: number | null;
    compilerVersion: string | null;
    detail: string | null;
  };
  host: {
    serverVersion: string | null;
    compatible: boolean;
    detail: string | null;
  };
  counters: {
    inboxDuplicates: number;
    schemaQuarantine: number;
    outboxOldestAgeSeconds: number | null;
    projectionLagSeconds: number | null;
    reconcileMismatch: number;
    unknownAttempts: number;
    staleLeaseRejected: number;
    duplicateEffectsPrevented: number;
    waitingGovernanceOldestAgeSeconds: number | null;
    gateMissingEvidence: number;
    budgetBlocks: number;
    platformBlocks: number;
    workspaceValidationFailures: number;
    artifactDigestMismatch: number;
    crossScopeDenials: number;
    /**
     * Core outbound intents this build could not map to a bridge intent.
     *
     * Non-zero means the Core asked for something nobody knows how to do. It is a gap, not a failure
     * of any one intent: those intents stay unacknowledged and are re-claimed until the mapping
     * covers them, which is why this is surfaced rather than merely logged.
     */
    unknownCoreIntentKinds: number;
    /**
     * A Core intent whose *payload* this build cannot read, as distinct from a kind it does not
     * carry. Left unacknowledged, like an unknown kind, because the Core still owns the obligation
     * and no work unit was created. Counted separately so a producer/consumer shape drift is
     * visible in health rather than only as a retry loop.
     */
    unreadableCoreIntentPayload: number;
    /** A Core intent that could not be made durable. The Core kept the obligation. */
    coreOutboxEnqueueFailed: number;
    /** A Core intent whose acknowledgement failed; its lease expires and it is re-claimed. */
    coreOutboxAckFailed: number;
    /** A pass over the Core's queue that could not run at all, usually because the Core was down. */
    controlPlaneUnavailable: number;
  };
  issues: string[];
  checkedAt: string;
}

export interface NodeView {
  nodeId: string;
  kind: string;
  status: string;
  iteration: number;
  waitReason: string | null;
  blockReason: string | null;
  requiredCapabilities: string[];
  assignedSubject: string | null;
  childRunId: string | null;
  contractHash: string | null;
}

export interface RunListItem {
  runId: string;
  graphId: string;
  graphVersion: number;
  status: string;
  entrypoint: string;
  stateVersion: number;
  rootIssueRef: { provider: string; kind: string; id: string; label?: string } | null;
  pendingGovernanceCount: number;
  unknownEffectCount: number;
  updatedAt: string;
}

export interface IssueView {
  issueId: string;
  runId: string | null;
  /** Which side of the mapping produced each status. Never conflate them. */
  issueStatus: string | null;
  graphStatus: string | null;
  graphStatusSource: "polyforge" | null;
  needsEngineeringVerification: boolean;
  nodes: NodeView[];
  blockers: { code: string; reason: string; message: string }[];
}

export interface GraphLibraryItem {
  graphId: string;
  name: string;
  description: string;
  activeVersion: number | null;
  latestVersion: number | null;
  draftCount: number;
  entrypoints: string[];
  runCount: number;
  retired: boolean;
}

export interface MigrationPreview {
  runId: string;
  sourceGraphVersion: number;
  targetGraphVersion: number;
  planHash: string;
  quiescent: boolean;
  blockers: { code: string; reason: string; message: string }[];
  nodeMapping: { from: string; to: string; stateAction: string }[];
  invalidations: { kind: string; detail: string }[];
  pendingGovernance: { requestId: string; nodeId: string; semanticKind: string }[];
}
