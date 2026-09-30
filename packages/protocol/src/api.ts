/**
 * Wire types for the PolyForge Runtime Service `/v1` API.
 *
 * Actor and company identity is derived from the authenticated transport context and a
 * scope-bound actor assertion — never read from a request body. The bridge verifies the
 * host actor, the Paperclip issue checkout, the agent run, and the work binding before it
 * mints the assertion; the Core only trusts assertions from the configured bridge issuer.
 */

import type {
  AttemptStatus,
  BlockReason,
  EvaluatorKind,
  GateResult,
  GraphRunStatus,
  JoinSemantics,
  NodeKind,
  NodeStatus,
} from "./enums.js";
import type { ErrorCode } from "./errors.js";
import type { CommandMeta, ProviderRefLike, Scope } from "./port-types.js";
import type { WorkspaceRequirement } from "./ports.js";

export const PROTOCOL_VERSION = 1;

export type { CommandMeta, ProviderRefLike, Scope };

/** Trusted caller identity asserted by the bridge. */
export interface ActorAssertion {
  /** `human` | `agent` | `system`. A worker can never assert `human`. */
  actorType: "human" | "agent" | "system";
  actorId: string;
  agentId?: string | null;
  /** Paperclip heartbeat run id, when the actor is an agent run. */
  runId?: string | null;
  /** Roles the platform asserted for this actor; used only for display and coarse checks. */
  roles?: string[];
}

/**
 * The assertion in the exact form the Core signs, mirroring `ActorAssertion.to_wire` on the Python
 * side.
 *
 * The normalisation is load-bearing, not cosmetic. The Core decodes `X-PF-Actor` into a dataclass
 * and re-encodes it through `to_wire()` before building the canonical string, so an absent
 * `agentId` and an explicit `agentId: null` produce the same bytes, and an empty `roles` list is
 * dropped rather than encoded as `[]`. A client that signs its own object verbatim therefore signs
 * a *different* string from the one the Core reconstructs, and every request fails signature
 * verification with no indication of why.
 *
 * Defining it once here is what keeps the two languages from drifting: the wire form is the
 * contract, not an implementation detail of either side.
 */
export function actorToWire(actor: ActorAssertion): Record<string, unknown> {
  const wire: Record<string, unknown> = { actorType: actor.actorType, actorId: actor.actorId };
  if (actor.agentId !== undefined && actor.agentId !== null) wire["agentId"] = actor.agentId;
  if (actor.runId !== undefined && actor.runId !== null) wire["runId"] = actor.runId;
  if (actor.roles !== undefined && actor.roles.length > 0) wire["roles"] = [...actor.roles];
  return wire;
}

/** Mutation envelope. Every write to the Core uses exactly this shape. */
export interface MutationEnvelope<P = Record<string, unknown>> {
  schemaVersion: number;
  commandId: string;
  idempotencyKey: string;
  correlationId: string;
  causationId?: string;
  runId: string;
  nodeId?: string;
  iteration?: number;
  attemptId?: string;
  leaseEpoch?: number;
  expectedStateVersion?: number;
  contractHash?: string;
  payload: P;
}

export interface Blocker {
  code: string;
  reason: BlockReason | string;
  message: string;
  detail?: Record<string, unknown>;
}

export interface CommandResult {
  commandId: string;
  applied: boolean;
  stateVersion: number;
  status: string;
  resultRef?: string;
  blockers: Blocker[];
  /** Set when the command was recorded but its effect is waiting on a future event. */
  pending?: boolean;
  pendingReason?: string;
}

// ---------------------------------------------------------------------------
// Authoring: definitions, drafts, versions
// ---------------------------------------------------------------------------

export interface GraphNode {
  id: string;
  kind: NodeKind;
  /** Operation contract for `agent_operation` nodes. */
  operation?: { id: string; version: number };
  inputs?: Record<string, string>;
  outputs?: string[];
  produces?: string[];
  requires?: string[];
  executor?: NodeExecutor;
  evaluatorRefs?: string[];
  humanDecision?: { required: boolean; semanticKind: string };
  join?: { semantics: JoinSemantics; quorum?: number; inputs: string[] };
  subgraph?: { graphId: string; entrypoint: string };
  permissionGate?: { action: string; resource: string };
  timeoutSeconds?: number;
  retryBudget?: { maxAttempts: number };
  layout?: { x: number; y: number };
}

export interface NodeExecutor {
  requiredCapabilities: string[];
  preferredRoles?: string[];
  fallbackRoles?: string[];
  /** Capability refs whose producing subjects must differ from this node's subject. */
  independentFrom?: string[];
}

export interface GraphEdge {
  from: string;
  to: string;
  guard?: string;
}

export interface EntryPointDef {
  key: string;
  inputs: string[];
  requiresFacts: string[];
  coordinator: {
    requiredCapabilities: string[];
    preferredRoles?: string[];
    fallbackRoles?: string[];
  };
  startNodes: string[];
  exports: string[];
  resumePolicy?: { allowedCheckpointKinds?: string[]; reExecutionRequiresNewGeneration: boolean };
}

export interface GraphDefinition {
  schemaVersion: number;
  graphId: string;
  name: string;
  description?: string;
  entrypoints: Record<string, EntryPointDef>;
  nodes: Record<string, GraphNode>;
  edges: GraphEdge[];
  policyRefs: string[];
}

export interface DraftSummary {
  draftId: string;
  graphId: string;
  baseVersion: number | null;
  revision: number;
  author: string;
  updatedAt: string;
  definitionHash: string;
  validationRef?: string;
  compileRef?: string;
}

export interface ValidationIssue {
  severity: "error" | "warning";
  code: string;
  path: string;
  message: string;
}

export interface ValidationReport {
  draftId: string;
  revision: number;
  definitionHash: string;
  ok: boolean;
  issues: ValidationIssue[];
}

export interface CompileArtifact {
  draftId: string;
  revision: number;
  definitionHash: string;
  compilerVersion: string;
  planHash: string;
  dependencyLockHash: string;
  /** Complete pinned version closure for a run created from this artifact. */
  closure: Record<string, string>;
}

export interface GraphVersionSummary {
  graphId: string;
  version: number;
  definitionHash: string;
  compilerVersion: string;
  planHash: string;
  dependencyLockHash: string;
  publishedBy: string;
  publishedAt: string;
  retired: boolean;
}

export interface SemanticDiff {
  graphId: string;
  fromVersion: number | null;
  toVersion: number | null;
  addedNodes: string[];
  removedNodes: string[];
  changedNodes: string[];
  addedEdges: string[];
  removedEdges: string[];
  policyChanges: string[];
  /** True when a removed or changed node invalidates previously recorded PASS results. */
  invalidatesEvidence: boolean;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export interface ArtifactRef {
  artifactId: string;
  kind: string;
  contentHash: string;
  mediaType: string;
  size: number;
  /** Paperclip attachment/document reference, kept as a provider-neutral ref. */
  providerRef?: ProviderRefLike | null;
  repository?: { repoRef: string; commit: string } | null;
  createdAt: string;
}

export interface EvidenceRecord {
  evidenceId: string;
  runId: string;
  nodeId: string;
  kind: string;
  transitionHash: string;
  artifacts: ArtifactRef[];
  producerSubject: string;
  producerRunRef?: ProviderRefLike | null;
  inputRevisionBindings: Record<string, string>;
  valid: boolean;
  invalidatedReason?: string | null;
  createdAt: string;
}

export interface GateEvaluationRecord {
  evaluationId: string;
  gateId: string;
  evaluatorRef: string;
  evaluatorKind: EvaluatorKind;
  evaluatorVersion: string;
  transitionHash: string;
  evidenceSetHash: string;
  result: GateResult;
  reason: string;
  createdAt: string;
}

export interface ExecutionAttempt {
  attemptId: string;
  runId: string;
  nodeId: string;
  iteration: number;
  attemptNo: number;
  transitionHash: string;
  status: AttemptStatus;
  leaseEpoch: number;
  agentSubject: string | null;
  agentRunRef: ProviderRefLike | null;
  startedAt: string;
  finishedAt: string | null;
  checkpointRef: string | null;
}

export interface NodeExecutionView {
  nodeId: string;
  kind: NodeKind;
  status: NodeStatus;
  iteration: number;
  contractHash: string | null;
  inputRefs: string[];
  outputRefs: string[];
  activeAttemptId: string | null;
  waitReason: string | null;
  blockReason: BlockReason | null;
  requiredCapabilities: string[];
  assignedSubject: string | null;
  assignedIssueRef: ProviderRefLike | null;
  childRunId: string | null;
  updatedAt: string;
}

export interface RunSnapshot {
  runId: string;
  familyId: string;
  workOrderId: string;
  graphId: string;
  graphVersion: number;
  status: GraphRunStatus;
  stateVersion: number;
  eventSequence: number;
  ownerEpoch: number;
  entrypoint: string;
  parentRunId: string | null;
  parentNodeId: string | null;
  invocationGeneration: number;
  scope: Scope;
  pins: Record<string, string>;
  nodes: NodeExecutionView[];
  attempts: ExecutionAttempt[];
  gates: GateEvaluationRecord[];
  evidence: EvidenceRecord[];
  pendingGovernance: PendingGovernance[];
  effects: EffectRecord[];
  blockers: Blocker[];
  createdAt: string;
  updatedAt: string;
}

export interface PendingGovernance {
  requestId: string;
  kind: "interaction" | "decision" | "authorization";
  gateId: string;
  nodeId: string;
  transitionHash: string;
  /** Hash of the exact target the human is deciding about. */
  decisionTargetHash: string;
  semanticKind: string;
  providerRef: ProviderRefLike | null;
  createdAt: string;
  expiresAt: string | null;
  resolvedAt: string | null;
  resolution?: GovernanceResolution | null;
}

export interface GovernanceResolution {
  responderSubject: string;
  responderKind: "human" | "agent" | "system";
  outcome: "accept" | "reject" | "approve" | "deny";
  /** True only when the bridge re-read the authoritative provider object and matched the target hash. */
  verifiedAgainstProvider: boolean;
  detail: Record<string, unknown>;
  recordedAt: string;
}

export interface EffectRecord {
  effectKey: string;
  transitionHash: string;
  stepId: string;
  status: "PENDING" | "EFFECTED" | "NOT_EFFECTED" | "UNKNOWN";
  providerRef: ProviderRefLike | null;
  requestHash: string;
  resultHash: string | null;
  reconciliationNote: string | null;
  updatedAt: string;
}

export interface DomainEvent {
  seq: number;
  runId: string;
  type: string;
  at: string;
  payload: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export interface CreateWorkOrderRequest extends CommandMeta {
  scope: Scope;
  startIntentId: string;
  graphId: string;
  /** Omit to use the graph's active default version. */
  graphVersion?: number;
  entrypoint: string;
  rootIssueRef: ProviderRefLike;
  inputSnapshot: Record<string, unknown>;
  /** Optional human-authored, host-validated run pin applied only to code.modify nodes. */
  workspaceRequirement?: WorkspaceRequirement;
  /**
   * The effective policy closure pinned to this work order. The bridge supplies the narrow
   * Paperclip admission rule only after a board user starts the run; later node actions still
   * require their own matching rules and remain deny-first when none are supplied.
   */
  policyRules?: WorkOrderPolicyRule[];
  /** Optional external prerequisite facts; each must carry verifiable provenance. */
  requiredFacts?: Record<string, { source: string; sourceRevision: string; contentHash: string }>;
  /** Fact names mapped to a same-project completed source Run; Core resolves and verifies its Gate export. */
  requiredFactSources?: Record<string, { sourceRunId: string }>;
  sourceRef?: ProviderRefLike | null;
}

export interface WorkOrderPolicyRule {
  ruleId: string;
  effect: "allow" | "deny" | "require_approval";
  agentRef?: string | null;
  projectRef: string;
  workflowRef: string;
  transitionRef: string;
  actions: string[];
  resources: string[];
  environments: string[];
  requiredCapabilities?: string[];
  version?: string;
  reason: string;
}

export interface ClaimRequest {
  runId: string;
  nodeId: string;
  iteration: number;
  attemptId: string;
  leaseEpoch: number;
  agentSubject: string;
  agentRunRef: ProviderRefLike | null;
  issueRef: ProviderRefLike | null;
  contractHash: string;
}

export type SubmitArtifactRequest = MutationEnvelope<{ artifacts: ArtifactRef[] }>;
export type SubmitEvidenceRequest = MutationEnvelope<{ evidence: EvidenceRecord[] }>;
export type RequestTransitionRequest = MutationEnvelope<{ evidenceIds: string[]; summary?: string }>;
export type RequestHelpRequest = MutationEnvelope<{
  kind: "clarification" | "review" | "human_handling";
  question: string;
  context?: Record<string, unknown>;
}>;

export interface RunCommandRequest extends CommandMeta {
  runId: string;
  command: "pause" | "resume" | "cancel" | "retry" | "resolve_block";
  nodeId?: string;
  reason: string;
  resolutionDetail?: Record<string, unknown>;
}

export interface MigrationPlanRequest extends CommandMeta {
  runId: string;
  targetGraphVersion: number;
  nodeMapping?: Record<string, string>;
}

export interface HealthReport {
  status: "ready" | "read_only" | "degraded" | "blocked";
  protocolVersion: number;
  schemaVersion: number;
  compilerVersion: string;
  database: { ok: boolean; detail?: string };
  store: { runs: number; outboxPending: number; unknownEffects: number };
  bridge: { issuer: string | null; expectedIssuer: string; compatible: boolean };
  checkedAt: string;
}

export type ApiFailureCode = ErrorCode;
