/**
 * Registration of exactly the six `polyforge.*` tools.
 *
 * Two invariants are enforced here rather than in review:
 *
 * * **The parameter schemas are the protocol's, not the manifest's re-typed copy.**
 *   `TOOL_PARAMETERS` in `@polyforge/protocol` is the contract; the manifest carries the same
 *   shapes because the host validates it at install time. Registering from `TOOL_PARAMETERS`
 *   means a divergence fails the schema-sync test instead of silently changing the agent-facing
 *   API.
 * * **There is no `node.complete`.** REQ-TOOL-02 allows a `node.complete` alias only if it is
 *   exactly equivalent to `request_transition`; an alias that takes user parameters as
 *   success facts is explicitly forbidden. Six tools, no aliases, no evaluator registration,
 *   no way to assert a pass.
 */

import { TOOL_NAMES, TOOL_PARAMETERS } from "@polyforge/protocol";
import type { ToolName } from "@polyforge/protocol";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { makeToolHandlers } from "./handlers.js";

/** Human-facing labels. The manifest carries its own copies; this is the worker's copy. */
const DISPLAY_NAMES: Record<ToolName, string> = {
  status: "PolyForge status",
  current: "PolyForge current contract",
  submit_artifact: "PolyForge submit artifact",
  submit_evidence: "PolyForge submit evidence",
  request_transition: "PolyForge request transition",
  request_help: "PolyForge request help",
};

export const REGISTERED_TOOL_NAMES: readonly ToolName[] = TOOL_NAMES;

export function registerTools(ctx: PluginContext, deps: ToolHandlerDeps): void {
  const handlers = makeToolHandlers(deps);
  for (const name of REGISTERED_TOOL_NAMES) {
    const handler = handlers[name];
    if (!handler) {
      // Registration is synchronous and complete: a tool with no handler would be advertised
      // to every agent and fail at call time, which is the worst possible failure mode.
      throw new Error(`no handler implemented for declared tool ${name}`);
    }
    ctx.tools.register(name, {
      displayName: DISPLAY_NAMES[name],
      description: TOOL_PARAMETERS[name].description,
      parametersSchema: TOOL_PARAMETERS[name],
    }, handler);
  }
}

export interface ToolHandlerDeps {
  /** Per-company runtime accessor. `null` when the company's config is not resolvable. */
  runtime(companyId: string): ToolRuntime | null;
  /** Look up a durable claim for a run/node/iteration. */
  claim(input: ToolClaimQuery): ToolClaim | null;
  recordClaim(input: ToolClaimRecord): void;
  /** Durable ids an agent run is bound to. */
  bindingForAgentRun(companyId: string, agentRunId: string): ToolRunBinding | null;
  /**
   * Ask the work port to stop a previous owner's execution.
   *
   * Returns `"stopped"` only when the platform *confirmed* it (`confirmed_stopped`,
   * `already_terminal`, `not_found`) and `"unknown"` otherwise. `current --adopt` refuses to
   * proceed on `"unknown"`, because an unconfirmed stop is exactly the condition that lets two
   * workers produce the same effect.
   */
  stopPreviousOwner(companyId: string, ref: { provider: string; kind: string; id: string }): Promise<"stopped" | "unknown">;
  /** Metrics + counters for the company. */
  bump(companyId: string, counter: string, by?: number): void;
  warn(message: string, meta: Record<string, unknown>): void;
  /** Publish an artifact through the artifact port. */
  /**
   * Publish an artifact and return what the Core should be told about it.
   *
   * The returned `contentHash` and `source` are the ones this port *computed and verified* against
   * the bytes, not the ones the caller declared. The distinction is the whole point: the Core
   * registers an artifact by kind and hash and refuses a reference without a well-formed digest, so
   * what reaches it has to be a fact this side checked. Returning only a ref forced the caller to
   * echo its own claim back, which made the Core's copy of the identity a restatement of the
   * request rather than a record of the bytes.
   */
  publishArtifact(
    companyId: string,
    input: ToolArtifactInput,
  ): Promise<{
    providerRef: { provider: string; kind: string; id: string; revision?: string };
    contentHash: string;
    source: Record<string, unknown>;
  }>;
}

/** `provider_bindings.kind` for the Core claim fence the bridge mirrors. */
export const CLAIM_BINDING_KIND = "claim" as const;

export interface ToolRuntime {
  getRun(companyId: string, runId: string): Promise<ToolRunSnapshot>;
  current(companyId: string, runId: string): Promise<ToolCurrentContract>;
  claim(companyId: string, runId: string, body: unknown): Promise<ToolCommandResult>;
  submitArtifacts(companyId: string, runId: string, body: unknown): Promise<ToolCommandResult>;
  submitEvidence(companyId: string, runId: string, body: unknown): Promise<ToolCommandResult>;
  requestTransition(companyId: string, runId: string, body: unknown): Promise<ToolCommandResult>;
  requestHelp(companyId: string, runId: string, body: unknown): Promise<ToolCommandResult>;
}

export interface ToolRunSnapshot {
  runId: string;
  stateVersion: number;
  eventSequence: number;
  status: string;
  scope: { companyRef: string; projectRef: string };
  graphId: string;
  graphVersion: number;
  pins: Record<string, string>;
  nodes: {
    nodeId: string;
    kind: string;
    status: string;
    iteration: number;
    waitReason: string | null;
    blockReason: string | null;
    requiredCapabilities: string[];
    activeAttemptId: string | null;
    contractHash: string | null;
  }[];
  attempts: {
    attemptId: string;
    nodeId: string;
    iteration: number;
    leaseEpoch: number;
    status: string;
    agentSubject: string | null;
  }[];
  evidence: { evidenceId: string; kind: string; valid: boolean; producerSubject: string }[];
  pendingGovernance: {
    requestId: string;
    nodeId: string;
    transitionHash: string;
    decisionTargetHash: string;
    semanticKind: string;
    createdAt: string;
  }[];
  blockers: { code: string; reason: string; message: string }[];
}

export interface ToolCurrentContract {
  runId: string;
  stateVersion: number;
  nodeId: string | null;
  iteration: number;
  attemptId: string | null;
  leaseEpoch: number | null;
  contractHash: string | null;
  requiredInputs: string[];
  permittedOutputs: string[];
  evidenceRequirements: unknown[];
  policyConstraints: Record<string, unknown>;
  permittedActions: string[];
  claimable: boolean;
  /**
   * The agent run that currently owns the attempt, when it is not this caller.
   *
   * The Core is the authority on who holds a lease; the bridge asks it rather than guessing
   * from its own bookkeeping. `null` means the attempt is unowned or already this caller's.
   */
  previousOwnerAgentRunId: string | null;
}

export interface ToolCommandResult {
  commandId: string;
  applied: boolean;
  stateVersion: number;
  status: string;
  resultRef?: string;
  pending?: boolean;
  pendingReason?: string;
  blockers?: { code: string; reason: string; message: string }[];
}

export interface ToolClaimQuery {
  companyId: string;
  runId: string;
  nodeId: string;
  iteration: number;
}

export interface ToolClaim {
  readonly attemptId: string;
  readonly leaseEpoch: number;
  readonly agentRunId: string;
  readonly agentId: string;
  readonly contractHash: string | null;
  readonly claimedAt: string;
}

export interface ToolClaimRecord extends ToolClaimQuery {
  readonly attemptId: string;
  readonly leaseEpoch: number;
  readonly agentRunId: string;
  readonly agentId: string;
  readonly contractHash: string | null;
}

export interface ToolRunBinding {
  readonly companyId: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly iteration: number;
  readonly issueId: string;
  readonly projectId: string;
  readonly contractHash: string | null;
}

export interface ToolArtifactInput {
  readonly companyId: string;
  readonly kind: string;
  readonly contentHash: string;
  readonly mediaType: string;
  readonly size: number;
  readonly source: { kind: "attachment" | "document" | "inline"; ref?: string; body?: string };
  readonly repository?: { repoRef: string; commit: string } | null;
}
