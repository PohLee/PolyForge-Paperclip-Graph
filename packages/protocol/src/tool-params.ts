/**
 * `polyforge.*` agent tool parameter schemas.
 *
 * These tools are the *protocol entry point* into the durable Runtime, not the graph
 * lifecycle. A tool call never owns a GraphRun: it reads current state, submits candidates,
 * or requests an evaluation. Deliberately absent: any way for a worker to assert success,
 * approve itself, register an evaluator, choose a runtime path, or mutate the Core directly.
 *
 * Tool names are logical product names. The host namespaces registered tools by plugin id,
 * so the published identifiers carry that prefix.
 */

export interface ToolJsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
  description?: string;
}

const REF = {
  type: "object",
  properties: {
    provider: { type: "string" },
    kind: { type: "string" },
    id: { type: "string" },
  },
  required: ["provider", "kind", "id"],
  additionalProperties: false,
} as const;

export const TOOL_PARAMETERS = {
  /** Read-only run / gate / node summary with explicit blockers. */
  status: {
    type: "object",
    description:
      "Get the authoritative engineering status of a PolyForge run: node states, gate results, pending governance, and blockers. Read-only. Never marks anything passed.",
    properties: {
      runId: { type: "string", description: "GraphRun id. Omit to use the bound run for this agent run." },
      nodeId: { type: "string", description: "Limit the summary to one node." },
      includeHistory: { type: "boolean", description: "Include recent committed transitions." },
    },
    additionalProperties: false,
  },

  /** The contract, inputs, and permitted actions for the caller's current attempt. */
  current: {
    type: "object",
    description:
      "Get the current attempt's transition contract: required inputs, allowed output types, evidence requirements, policy constraints, and the exact permitted next actions. Establishes the Core lease fence when the agent run matches the binding.",
    properties: {
      runId: { type: "string" },
      nodeId: { type: "string" },
      adopt: {
        type: "boolean",
        description:
          "Claim the current attempt for this agent run when the previous owner is confirmed stopped. Creates a new attempt with an incremented lease epoch; the old attempt is invalidated.",
      },
    },
    additionalProperties: false,
  },

  /** Register immutable artifact references with digests. */
  submit_artifact: {
    type: "object",
    description:
      "Register fixed artifact references (with content digests) produced by this attempt. Create-or-verify: re-registering the same digest is idempotent; a conflicting digest for the same identity is rejected.",
    properties: {
      runId: { type: "string" },
      nodeId: { type: "string" },
      artifacts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            kind: { type: "string", description: "Output type permitted by the node contract." },
            contentHash: { type: "string", description: "sha256:<hex> of the artifact bytes." },
            mediaType: { type: "string" },
            size: { type: "number" },
            source: {
              type: "object",
              description: "Where the bytes live.",
              properties: {
                kind: { type: "string", enum: ["attachment", "document", "inline"] },
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

  /** Submit evidence candidates; trusted ingestion verifies before archiving. */
  submit_evidence: {
    type: "object",
    description:
      "Submit evidence candidates for the current transition. The Core verifies scope, producer, active claim, contract-bound output type, content hash, source revision, and freshness before archiving. A worker's claim that 'tests passed' is only a candidate until a trusted source confirms it.",
    properties: {
      runId: { type: "string" },
      nodeId: { type: "string" },
      evidence: {
        type: "array",
        items: {
          type: "object",
          properties: {
            kind: { type: "string", description: "Evidence kind the gate requires." },
            artifacts: { type: "array", items: REF },
            detail: { type: "object" },
            inputRevisionBindings: {
              type: "object",
              description: "Map of input name to the exact revision this evidence was produced against.",
              additionalProperties: { type: "string" },
            },
          },
          required: ["kind", "artifacts"],
          additionalProperties: false,
        },
      },
    },
    required: ["evidence"],
    additionalProperties: false,
  },

  /** Request evaluation of a transition. */
  request_transition: {
    type: "object",
    description:
      "Request evaluation of the current node's transition. Returns PASS/FAIL/ESCALATE or a durable pending result. A PASS requires every mandatory evaluator to have passed; the agent cannot assert a pass, supply an approval, or register an evaluator.",
    properties: {
      runId: { type: "string" },
      nodeId: { type: "string" },
      evidenceIds: { type: "array", items: { type: "string" } },
      summary: { type: "string", description: "Human-readable transition note recorded with the attempt." },
    },
    required: ["evidenceIds"],
    additionalProperties: false,
  },

  /** Ask for clarification, review, or human handling. */
  request_help: {
    type: "object",
    description:
      "Create a durable help intent: clarification, independent review, or human handling. Never auto-approves anything and never blocks a long-running tool call waiting for a human.",
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
} as const satisfies Record<string, ToolJsonSchema>;

export type ToolName = keyof typeof TOOL_PARAMETERS;

export const TOOL_NAMES: ToolName[] = [
  "status",
  "current",
  "submit_artifact",
  "submit_evidence",
  "request_transition",
  "request_help",
];

/**
 * Uniform tool response contract.
 *
 * Every tool returns durable identifiers, the state version it observed, the current pending
 * reason, and the next permitted step. A human waiting hours must never occupy a tool call.
 */
export interface ToolEnvelope {
  runId: string | null;
  stateVersion: number;
  status: string;
  pending: boolean;
  pendingReason: string | null;
  nextSteps: string[];
  blockers: { code: string; reason: string; message: string }[];
  data: Record<string, unknown>;
}

export function toolEnvelope(partial: Partial<ToolEnvelope> & { data?: Record<string, unknown> }): ToolEnvelope {
  return {
    runId: partial.runId ?? null,
    stateVersion: partial.stateVersion ?? 0,
    status: partial.status ?? "UNKNOWN",
    pending: partial.pending ?? false,
    pendingReason: partial.pendingReason ?? null,
    nextSteps: partial.nextSteps ?? [],
    blockers: partial.blockers ?? [],
    data: partial.data ?? {},
  };
}
