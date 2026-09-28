/**
 * Provider-neutral ports.
 *
 * These interfaces are declared by the Graph Core and implemented by the bridge inside the
 * Paperclip plugin. The Core never imports a Paperclip SDK type and never reads the Paperclip
 * database; every platform object crosses this boundary as an opaque `ProviderRef`.
 *
 * Every mutation returns a durable operation or reference and may complete asynchronously.
 * A UI hook is not a reliable message bus and must not be used as one.
 */

import type { CommandMeta, ProviderRefLike, Scope, VerifiedArtifact } from "./port-types.js";

export type { CommandMeta, ProviderRefLike, Scope, VerifiedArtifact };

export interface WorkUnitIntent {
  scope: Scope;
  runId: string;
  nodeId: string;
  iteration: number;
  title: string;
  description: string;
  /** Deterministic correlation key so a replay reuses the same work unit. */
  correlationKey: string;
  requiredCapabilities: string[];
  projectRef: string;
  parentIssueRef: ProviderRefLike | null;
  workspaceRequirement: WorkspaceRequirement;
  labels?: string[];
}

export interface StatusProjection {
  scope: Scope;
  runId: string;
  /** Monotonic projection sequence from the Core; used to drop stale projections. */
  projectionSequence: number;
  target: ProviderRefLike;
  status: string;
  summary: string;
  nodeStates: { nodeId: string; status: string }[];
  origin: "polyforge";
  correlationId: string;
}

export interface WorkerRequirement {
  scope: Scope;
  runId: string;
  nodeId: string;
  requiredCapabilities: string[];
  preferredRoles?: string[];
  fallbackRoles?: string[];
  /** Capability refs the chosen worker must not have produced, for independent review. */
  independentFrom?: { capabilityRef: string; subjectRefs: string[] }[];
  excludeSubjects?: string[];
}

export interface WorkerCandidate {
  subjectRef: string;
  providerRef: ProviderRefLike;
  matchedCapabilities: string[];
  independenceSatisfied: boolean;
  reasons: string[];
}

export interface DispatchBinding {
  scope: Scope;
  runId: string;
  nodeId: string;
  iteration: number;
  attemptId: string;
  workUnitRef: ProviderRefLike;
  workerSubjectRef: string;
  workspaceRef: ProviderRefLike | null;
  contractHash: string;
}

export interface DispatchReceipt {
  workUnitRef: ProviderRefLike;
  workUnitKey: string;
  agentRunRef: ProviderRefLike | null;
  queued: boolean;
  reason?: string;
}

export interface StopReceipt {
  requested: boolean;
  /** `confirmed_stopped` | `not_found` | `already_terminal` | `unknown`. */
  outcome: "confirmed_stopped" | "not_found" | "already_terminal" | "unknown";
  observedAt: string;
}

export interface ExecutionObservation {
  providerRef: ProviderRefLike;
  state: "running" | "succeeded" | "failed" | "cancelled" | "unknown";
  startedAt: string | null;
  finishedAt: string | null;
  exitReason: string | null;
  /** Present only when the provider can authoritatively report effect outcomes. */
  effectOutcome?: "effected" | "not_effected" | "unknown";
  artifacts: { kind: string; contentHash: string; providerRef?: ProviderRefLike }[];
}

export interface WorkManagementPort {
  ensureWorkUnit(intent: WorkUnitIntent, meta: CommandMeta): Promise<ProviderRefLike>;
  projectStatus(projection: StatusProjection, meta: CommandMeta): Promise<void>;
  resolveWorker(requirement: WorkerRequirement): Promise<WorkerCandidate[]>;
  assignAndWake(binding: DispatchBinding, meta: CommandMeta): Promise<DispatchReceipt>;
  requestStop(ref: ProviderRefLike, meta: CommandMeta): Promise<StopReceipt>;
  inspectExecution(ref: ProviderRefLike): Promise<ExecutionObservation>;
}

export interface InteractionRequest {
  scope: Scope;
  targetIssueRef: ProviderRefLike;
  kind: "clarification" | "review" | "confirmation";
  /** The Core's semantic kind; the platform only renders it. */
  semanticKind: string;
  question: string;
  options?: { id: string; label: string }[];
  /** Exact target the human decides about. The Core keeps the canonical copy. */
  decisionTargetHash: string;
  correlationId: string;
  requiredResolver?: "anyone" | "not_creator" | "human_only";
  capabilityRef?: string;
}

export interface DecisionRequest {
  scope: Scope;
  targetIssueRef: ProviderRefLike;
  semanticKind: string;
  question: string;
  options: { id: string; label: string; detail?: string }[];
  decisionTargetHash: string;
  correlationId: string;
  /** Whitelisted side effects only. A decision effect never advances a GraphRun. */
  effects: { kind: "issue_comment" | "issue_status"; value: string }[];
}

export interface AuthorizationRequest {
  scope: Scope;
  /** The precise action being authorized. */
  action: string;
  resource: string;
  environment: string;
  authority: string;
  policyRef: string;
  inputHashes: Record<string, string>;
  transitionHash: string;
  expiresAt: string;
  justification: string;
}

export interface VerifiedResolution {
  providerRef: ProviderRefLike;
  outcome: "accept" | "reject" | "approve" | "deny";
  responderSubject: string;
  responderKind: "human" | "agent" | "system";
  /** Provider re-read confirmed the object still carries the requested target hash. */
  targetHashVerified: boolean;
  detail: Record<string, unknown>;
  recordedAt: string;
}

export interface ExactAction {
  action: string;
  resource: string;
  environment: string;
  inputHashes: Record<string, string>;
  transitionHash: string;
}

export interface AuthorizationStatus {
  granted: boolean;
  reason: string;
  expiresAt: string | null;
  revoked: boolean;
  /** True when the granted authorization covers this exact action and no other. */
  exactMatch: boolean;
}

export interface GovernancePort {
  requestInteraction(req: InteractionRequest, meta: CommandMeta): Promise<ProviderRefLike>;
  requestEngineeringDecision(req: DecisionRequest, meta: CommandMeta): Promise<ProviderRefLike>;
  requestActionAuthorization(req: AuthorizationRequest, meta: CommandMeta): Promise<ProviderRefLike>;
  readVerifiedResolution(ref: ProviderRefLike): Promise<VerifiedResolution | null>;
  checkAuthorization(
    ref: ProviderRefLike,
    action: ExactAction,
  ): Promise<AuthorizationStatus>;
}

export type WorkspaceMode = "read_write" | "read_only_snapshot" | "reuse_serially";

export interface WorkspaceRequirement {
  mode: WorkspaceMode;
  /** Required repository coordinates; the Core pins commits, the platform provisions. */
  repositories: { repoRef: string; baseRef: string; commit?: string }[];
  /** True when a reviewer must not be able to write to the workspace it reviews. */
  requireReadOnlyForReviewer: boolean;
}

export interface WorkspaceBinding {
  workspaceRef: ProviderRefLike;
  path: string | null;
  branch: string | null;
  commits: { repoRef: string; commit: string }[];
  readOnly: boolean;
}

export interface WorkspaceObservation {
  exists: boolean;
  path: string | null;
  branch: string | null;
  commits: { repoRef: string; commit: string }[];
  readable: boolean;
  writable: boolean;
  problems: string[];
}

export interface WorkspacePort {
  resolve(req: WorkspaceRequirement, meta: CommandMeta): Promise<WorkspaceBinding>;
  inspect(binding: WorkspaceBinding): Promise<WorkspaceObservation>;
}

export interface ArtifactUpload {
  scope: Scope;
  kind: string;
  contentHash: string;
  mediaType: string;
  size: number;
  /** Where the bytes came from: an issue attachment, a document revision, or a path. */
  source: { kind: "attachment" | "document" | "inline"; ref?: string; body?: string };
  repository?: { repoRef: string; commit: string } | null;
}

export interface ArtifactPort {
  /**
   * Publish an artifact and return its **verified** identity.
   *
   * The digest and source in the result are what the port computed from the bytes and checked, not
   * what the caller declared. The Core registers an artifact by kind and hash and refuses a
   * reference without a well-formed digest, so whatever reaches it has to be a verified fact; a
   * signature that returned only a ref pushed the job of restating the identity onto the caller.
   */
  publish(
    req: ArtifactUpload,
    meta: CommandMeta,
  ): Promise<{
    providerRef: ProviderRefLike;
    contentHash: string;
    source: Record<string, unknown>;
  }>;
  readVerified(ref: ProviderRefLike): Promise<VerifiedArtifact>;
}

export interface ProgressProjection {
  scope: Scope;
  runId: string;
  projectionSequence: number;
  kind: "run" | "node" | "gate" | "evidence" | "effect";
  payload: Record<string, unknown>;
  correlationId: string;
}

export interface ObservabilityPort {
  publishProgress(event: ProgressProjection, meta: CommandMeta): Promise<void>;
}

export interface Ports {
  work: WorkManagementPort;
  governance: GovernancePort;
  workspace: WorkspacePort;
  artifacts: ArtifactPort;
  observability: ObservabilityPort;
}
