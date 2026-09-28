/**
 * Design tokens for the PolyForge UI.
 *
 * One rule shapes this file: **a status is never encoded by colour alone** (REQ-UI-06). Every
 * status therefore resolves to a quadruple — a text label, a glyph, and a border shape — with
 * colour as a fourth, redundant channel. Strip the colour and a reviewer can still read the
 * state. That is the test this table has to pass, and it is why a raw vocabulary string is
 * never rendered directly: an unrecognised value becomes an explicit `unknown` token rather
 * than the nearest thing that happens to look right.
 *
 * The raw strings come from `@polyforge/protocol` (`GRAPH_RUN_STATUSES`, `NODE_STATUSES`,
 * `ATTEMPT_STATUSES`, `PROJECTED_ISSUE_STATUSES`, `BLOCK_REASONS`, `GATE_RESULTS`,
 * `NODE_KINDS`). They are keys here, not duplicated values, so a Core-side rename shows up as
 * an `unknown` token in the UI rather than as a silent pass.
 */

import type { StatusBadgeVariant } from "@paperclipai/plugin-sdk/ui";

/** Visual weight classes. `tone` is only ever one of four redundant signals. */
export type Tone = "neutral" | "info" | "progress" | "waiting" | "passed" | "problem" | "unknown" | "muted";

/** Redundant shape channel so the state survives greyscale, colour-blindness, and print. */
export type ToneShape = "solid" | "dashed" | "dotted" | "double";

/** Which vocabulary a status came from. Drives the provenance caption, never the colour. */
export type StatusFamily =
  | "graph"
  | "node"
  | "attempt"
  | "issue"
  | "health"
  | "effect"
  | "gate"
  | "block"
  | "nodeKind"
  | "platform"
  | "governance"
  | "generic";

export interface StatusToken {
  readonly tone: Tone;
  /** Human-readable state. This is the authoritative channel and is always rendered as text. */
  readonly label: string;
  /** Decorative marker, `aria-hidden`. Shape + glyph, never the sole encoding. */
  readonly glyph: string;
  readonly shape: ToneShape;
  readonly variant: StatusBadgeVariant;
  /** One line explaining what the state does and does not mean. Shown in the legend. */
  readonly meaning: string;
}

/**
 * Tone palette.
 *
 * The values are mid-tone on purpose: they are used for a decorative glyph and a border, never
 * for body text, so they do not have to clear a text contrast ratio on both host themes. Every
 * readable status string is rendered through the host `StatusBadge`, which owns contrast.
 */
export const TONE_COLOR: Record<Tone, { fg: string; border: string }> = {
  neutral: { fg: "#9ca3af", border: "#9ca3af" },
  info: { fg: "#60a5fa", border: "#60a5fa" },
  progress: { fg: "#38bdf8", border: "#38bdf8" },
  waiting: { fg: "#fbbf24", border: "#fbbf24" },
  passed: { fg: "#4ade80", border: "#4ade80" },
  problem: { fg: "#f87171", border: "#f87171" },
  // `unknown` is deliberately neutral grey, not a problem colour: nothing has gone wrong, the
  // UI simply cannot conclude. A dotted border and a `?` say that better than a hue.
  unknown: { fg: "#cbd5e1", border: "#94a3b8" },
  muted: { fg: "#6b7280", border: "#6b7280" },
};

export const TONE_SHAPE: Record<Tone, ToneShape> = {
  neutral: "solid",
  info: "solid",
  progress: "dashed",
  waiting: "double",
  passed: "solid",
  problem: "solid",
  unknown: "dotted",
  muted: "dashed",
};

/** Space / radius / type tokens. Small on purpose: this is a design-token layer, not a theme. */
export const SPACE = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;
export const RADIUS = { sm: 4, md: 6 } as const;
export const MONO_FONT =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

function token(
  tone: Tone,
  label: string,
  glyph: string,
  meaning: string,
): StatusToken {
  return { tone, label, glyph, shape: TONE_SHAPE[tone], variant: TONE_VARIANT[tone], meaning };
}

const TONE_VARIANT: Record<Tone, StatusBadgeVariant> = {
  neutral: "pending",
  info: "info",
  progress: "info",
  waiting: "warning",
  passed: "ok",
  problem: "error",
  unknown: "warning",
  muted: "pending",
};

/**
 * The status table, keyed by the protocol's raw vocabulary values.
 *
 * `PASSED`, `COMPLETED` and `done` are *not* the same token even though `projectIssueStatus`
 * maps between them: the Core's `PASSED` and the Paperclip projection's `done` are different
 * claims about the world, and the UI says which one it is showing.
 */
export const STATUS_TOKENS: Readonly<Record<string, StatusToken>> = {
  // -- Graph run ------------------------------------------------------------
  CREATED: token("neutral", "Created", "●", "Work order accepted. No node has been released yet."),
  ACTIVE: token("info", "Active", "◐", "The run is progressing under the Core."),
  WAITING: token("waiting", "Waiting", "‖", "Progress is paused on a human or durable external event."),
  PAUSED: token("waiting", "Paused", "‖", "A human paused the run. Nothing is being dispatched."),
  BLOCKED: token("problem", "Blocked", "■", "An explainable cause is recorded. Not a pass and not a failure."),
  COMPLETED: token("passed", "Completed", "✓", "The Core committed terminal completion for the run."),
  FAILED: token("problem", "Failed", "✕", "The Core recorded a terminal failure."),
  CANCELLED: token("muted", "Cancelled", "○", "A human cancelled the run. External effects are reconciled separately."),

  // -- Node -----------------------------------------------------------------
  PENDING: token("neutral", "Pending", "●", "Not released. No worker has been asked to run it."),
  READY: token("info", "Ready", "◐", "Preconditions are met and the node may be dispatched."),
  DISPATCH_REQUESTED: token("info", "Dispatch requested", "◐", "The bridge asked the platform for a worker."),
  RUNNING: token("progress", "Running", "◐", "An attempt holds the lease and is executing."),
  EVIDENCE_READY: token("progress", "Evidence ready", "✓", "Evidence is archived; evaluation has not concluded."),
  EVALUATING: token("progress", "Evaluating", "◐", "Evaluators are deciding. No pass is recorded yet."),
  WAITING_GOVERNANCE: token("waiting", "Waiting on a human decision", "‖", "A durable human decision is outstanding."),
  PASSED: token("passed", "Passed", "✓", "Every mandatory evaluator passed on the bound evidence."),
  REWORK_REQUIRED: token("problem", "Rework required", "↻", "A gate failed or evidence was invalidated. New work is required."),
  SKIPPED: token("muted", "Skipped", "○", "Deliberately not executed. Provenance is recorded, not assumed."),

  // -- Attempt --------------------------------------------------------------
  PREPARED: token("neutral", "Prepared", "●", "An attempt record exists; the lease is not yet established."),
  CHECKPOINTED: token("progress", "Checkpointed", "◐", "Progress is durable and resumable from this point."),
  RECONCILING: token("waiting", "Reconciling", "↻", "The Core is resolving an ambiguous outcome. Do not resend."),
  UNKNOWN: token("unknown", "Unknown", "?", "The outcome is not known. This is explicitly not a pass."),

  // -- Effect ledger --------------------------------------------------------
  EFFECTED: token("passed", "Effected", "✓", "The external effect is recorded as applied."),
  NOT_EFFECTED: token("muted", "Not effected", "○", "The Core recorded that no external change happened."),

  // -- Gate result ----------------------------------------------------------
  PASS: token("passed", "Pass", "✓", "This evaluator passed on the evidence bound to this transition."),
  FAIL: token("problem", "Fail", "✕", "This evaluator refused. The node cannot advance on it."),
  ESCALATE: token("waiting", "Escalate", "▲", "The evaluator referred the decision upward."),

  // -- Projected Paperclip issue status (never an engineering verdict) ------
  backlog: token("neutral", "Backlog", "●", "Paperclip projection. The Core has not released work."),
  todo: token("info", "To do", "●", "Paperclip projection of a released or rework state."),
  in_progress: token("progress", "In progress", "◐", "Paperclip projection of an executing Core state."),
  in_review: token("waiting", "In review", "‖", "Paperclip projection of evaluation or pending governance."),
  done: token("muted", "Done (issue)", "○", "Paperclip projection only. It is not a gate result and not a Core pass."),

  // -- Health ---------------------------------------------------------------
  ready: token("passed", "Ready", "✓", "Runtime reachable and no operator-actionable issue recorded."),
  read_only: token("waiting", "Read only", "‖", "The bridge cannot persist. Reads work; no new privileged admission."),
  degraded: token("problem", "Degraded", "▲", "Something is wrong. Treat every derived number with suspicion."),

  // -- Block reason ---------------------------------------------------------
  BLOCKED_BUDGET: token("problem", "Budget block", "■", "A platform budget stopped the run. Not a PolyForge decision."),
  BLOCKED_PLATFORM: token("problem", "Platform block", "■", "Paperclip refused. Not a PolyForge decision."),
  BLOCKED_WORKSPACE: token("problem", "Workspace block", "■", "The execution workspace is missing, drifted, or out of scope."),
  BLOCKED_AUTHORIZATION: token("problem", "Authorization block", "■", "Platform authorization is missing or was revoked."),
  BLOCKED_GOVERNANCE: token("waiting", "Governance block", "‖", "A human decision is outstanding."),
  BLOCKED_STALE_INPUT: token("problem", "Stale input", "■", "An input revision moved; the recorded evidence no longer applies."),
  BLOCKED_EFFECT_UNKNOWN: token("unknown", "Unknown external effect", "?", "An external effect outcome is unresolved. Reconcile, never retry."),
  BLOCKED_DEPENDENCY: token("problem", "Dependency block", "■", "A pinned dependency is unsatisfiable."),
  BLOCKED_LEASE_FENCED: token("problem", "Lease fenced", "■", "The presenting lease epoch is stale. The attempt may not act."),
  BLOCKED_SCOPE: token("problem", "Scope violation", "■", "The request referenced an object outside the authorized scope."),

  // -- Governance -----------------------------------------------------------
  interaction: token("waiting", "Human interaction", "‖", "A human interaction is outstanding."),
  decision: token("waiting", "Human decision", "‖", "A recorded human decision is outstanding."),
  authorization: token("waiting", "Authorization", "‖", "A platform authorization is outstanding."),

  // -- Node kind ------------------------------------------------------------
  agent_operation: token("info", "Agent operation", "◈", "Executed by a worker that holds a claim and a lease."),
  deterministic: token("neutral", "Deterministic", "▦", "Executed by a reproducible transform. No agent is involved."),
  gate: token("passed", "Gate", "✓", "Decides a transition. A gate is the only place a PASS originates."),
  subgraph: token("info", "Subgraph", "▤", "A child run with its own version closure and entrypoint."),
  external_effect: token("problem", "External effect", "⇢", "Touches the world outside Paperclip. Governed and reconciled."),

  // -- Block reason aliases that arrive as bare codes -----------------------
  // `blocked` / `failed` are reachable as a projected issue status too, and the projection
  // deliberately maps them to the same words as the Core. They are kept separate here so the
  // source caption is the only thing that has to change between the two.
  fail: token("problem", "Fail", "✕", "This evaluator refused. The node cannot advance on it."),
};

const UNKNOWN_TOKEN: StatusToken = {
  tone: "unknown",
  label: "Unknown",
  glyph: "?",
  shape: "dotted",
  variant: "warning",
  meaning: "The source did not report a value this build recognises. Nothing can be concluded.",
};

const MISSING_TOKEN: StatusToken = {
  ...UNKNOWN_TOKEN,
  label: "Not reported",
  meaning: "The source returned no value for this field. Absence is not a pass.",
};

/**
 * Resolve a raw status string to a token.
 *
 * An unrecognised value is reported verbatim as `unknown` and is never folded into the nearest
 * recognised status. That is the whole point: a new Core status, a typo, or a truncated string
 * must read as "I cannot conclude", because guessing is how an unrecognised `FAIL` gets painted
 * green.
 */
export function statusToken(raw: string | null | undefined, family: StatusFamily = "generic"): StatusToken {
  if (raw === null || raw === undefined) return MISSING_TOKEN;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return MISSING_TOKEN;
  const found = STATUS_TOKENS[trimmed];
  if (found === undefined) {
    // The family is named so a reader can tell *which* vocabulary the UI failed to recognise. The
    // value is quoted verbatim rather than paraphrased, because a paraphrase is a guess.
    return { ...UNKNOWN_TOKEN, label: `Unknown ${family} status "${trimmed}"` };
  }
  return found;
}

/** True when the raw value is one this build knows. Used to gate "can I conclude anything?". */
export function isKnownStatus(raw: string | null | undefined): boolean {
  if (raw === null || raw === undefined) return false;
  return STATUS_TOKENS[raw.trim()] !== undefined;
}

/**
 * Provenance of a status.
 *
 * Every status the UI renders carries one of these as visible text. A reader must never be
 * able to see a projected `done` and conclude the engineering work passed, so the source is
 * not a tooltip — it is a rendered sentence.
 */
export interface StatusSource {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
}

export const STATUS_SOURCE: Readonly<Record<string, StatusSource>> = {
  graph: {
    id: "graph",
    label: "PolyForge Core",
    detail: "Engineering state owned by the Graph Core. This is the only status a gate result derives from.",
  },
  issue: {
    id: "issue",
    label: "Paperclip issue (projection)",
    detail: "A projection of Core state onto a board column. A projection can be moved by a human and is not a verdict.",
  },
  platform: {
    id: "platform",
    label: "Paperclip platform",
    detail: "Platform-owned status. PolyForge reports it and never asserts it.",
  },
  snapshot: {
    id: "snapshot",
    label: "Authoritative snapshot",
    detail: "Read from the Core in this request. The live stream only ever hints that a re-read is worth doing.",
  },
  stream: {
    id: "stream",
    label: "Live stream hint",
    detail: "A notification that something changed. The content is always re-read from the Core.",
  },
  local: {
    id: "local",
    label: "Computed in this browser",
    detail: "Derived for review convenience. The Core remains the authority and recomputes on publish.",
  },
};

export const STATUS_SOURCE_GRAPH: StatusSource = STATUS_SOURCE["graph"] as StatusSource;
export const STATUS_SOURCE_ISSUE: StatusSource = STATUS_SOURCE["issue"] as StatusSource;
export const STATUS_SOURCE_PLATFORM: StatusSource = STATUS_SOURCE["platform"] as StatusSource;
export const STATUS_SOURCE_SNAPSHOT: StatusSource = STATUS_SOURCE["snapshot"] as StatusSource;
export const STATUS_SOURCE_STREAM: StatusSource = STATUS_SOURCE["stream"] as StatusSource;
export const STATUS_SOURCE_LOCAL: StatusSource = STATUS_SOURCE["local"] as StatusSource;

export interface LegendGroup {
  readonly title: string;
  readonly entries: ReadonlyArray<{ raw: string; family: StatusFamily; note?: string }>;
}

/** Legend content. A reader with no colour perception gets the same information from this. */
export const STATUS_LEGEND: ReadonlyArray<LegendGroup> = [
  {
    title: "Node and run outcomes (PolyForge Core)",
    entries: [
      { raw: "PENDING", family: "node" },
      { raw: "RUNNING", family: "node" },
      { raw: "EVALUATING", family: "node" },
      { raw: "WAITING_GOVERNANCE", family: "node" },
      { raw: "PASSED", family: "node" },
      { raw: "REWORK_REQUIRED", family: "node" },
      { raw: "BLOCKED", family: "node" },
      { raw: "FAILED", family: "node" },
      { raw: "SKIPPED", family: "node" },
      { raw: "COMPLETED", family: "graph" },
      { raw: "CANCELLED", family: "graph" },
    ],
  },
  {
    title: "States that are not a pass",
    entries: [
      { raw: "UNKNOWN", family: "attempt", note: "Attempt outcome unknown." },
      { raw: "BLOCKED_EFFECT_UNKNOWN", family: "block", note: "Reconcile; do not retry." },
      { raw: "degraded", family: "health" },
      { raw: "read_only", family: "health" },
    ],
  },
  {
    title: "Paperclip issue projections (never an engineering verdict)",
    entries: [
      { raw: "backlog", family: "issue" },
      { raw: "todo", family: "issue" },
      { raw: "in_progress", family: "issue" },
      { raw: "in_review", family: "issue" },
      { raw: "done", family: "issue", note: "Only a Core PASSED/COMPLETED backs this." },
      { raw: "blocked", family: "issue" },
      { raw: "cancelled", family: "issue" },
    ],
  },
  {
    title: "Block reasons (explainable, non-forgeable causes)",
    entries: [
      { raw: "BLOCKED_BUDGET", family: "block" },
      { raw: "BLOCKED_PLATFORM", family: "block" },
      { raw: "BLOCKED_AUTHORIZATION", family: "block" },
      { raw: "BLOCKED_GOVERNANCE", family: "block" },
      { raw: "BLOCKED_LEASE_FENCED", family: "block" },
      { raw: "BLOCKED_SCOPE", family: "block" },
    ],
  },
];
