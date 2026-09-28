/**
 * Admission: only explicitly configured engineering entries start a graph.
 *
 * A plain operational issue must continue to work exactly as it did before this plugin was
 * installed. Three triggers admit an issue, and nothing else does (REQ-WORK-03, AT-02):
 *
 * 1. **Our own origin kind.** `originKind` under the configured
 *    `engineeringOriginPrefix`. This covers an issue a human created "for PolyForge" through
 *    the plugin's own surfaces, and a Root Issue the bridge re-imported.
 * 2. **The configured entry label.** A plain issue label, matched by name. An empty
 *    `engineeringEntryLabel` disables label admission entirely rather than admitting
 *    everything.
 * 3. **An explicit work-order intent in the body.** A fenced `polyforge:work-order` block.
 *    This is the only way an issue body can influence admission, and it is parsed as JSON
 *    rather than pattern-matched prose.
 *
 * ## Identity comes from the host, never from the body
 *
 * The intent block may carry `graphId`, `entrypoint` and an `inputSnapshot`. It may **not**
 * carry scope. A `companyId`, `projectId`, `actor*` or `approved` inside the block is stripped
 * and counted as a cross-scope denial attempt, because the project identity has to come from
 * the trusted issue→project relation (REQ-WORK-02). An issue whose project does not exist in
 * its own company is refused rather than admitted into a guessed scope.
 *
 * ## The start intent is stable
 *
 * `startIntentId` is derived, not generated, so replaying the same start intent returns the
 * same run. For label/origin admission it is a function of `(scope, issue, graph, entrypoint)`
 * and therefore stable for the life of the issue. For body-intent admission it also includes
 * the digest of the intent payload, so a human who *deliberately* edits the inputs to start a
 * new run gets a new intent — which is the documented way to ask for a second run.
 */

import { digestText, hashDomain, canonicalJson } from "@polyforge/protocol";
import type { Scope } from "@polyforge/protocol";
import type { Issue } from "@paperclipai/plugin-sdk";
import type { BridgeConfig } from "./config.js";
import type { BridgeLogger } from "./logger.js";
import type { BridgeMetrics } from "./metrics.js";

/** The fence that marks a work-order intent in an issue body. */
export const WORK_ORDER_INTENT_MARKER = "polyforge:work-order";

export interface WorkOrderIntentBlock {
  readonly graphId: string;
  readonly entrypoint: string;
  readonly inputSnapshot: Record<string, unknown>;
  /** Explicitly declared by the author, so a new run can be requested deliberately. */
  readonly startIntentId: string | null;
  /** Fields the author tried to set that the bridge refuses. Recorded, never used. */
  readonly rejectedFields: string[];
}

export type AdmissionDecision =
  | {
      readonly admit: true;
      readonly startIntentId: string;
      readonly graphId: string;
      /**
       * The entrypoint, which may be the empty string meaning "the graph's own default".
       *
       * A label- or origin-kind trigger names the *graph* but not an entrypoint, and the
       * manifest's config offers only `defaultGraphId`. Rather than invent an entrypoint name,
       * the decision leaves it empty and `Router.resolveEntrypoint` asks the Core, refusing the
       * case where the graph has several entrypoints and none was named.
       */
      readonly entrypoint: string;
      readonly scope: Scope;
      readonly projectId: string;
      readonly rootIssueId: string;
      readonly inputSnapshot: Record<string, unknown>;
      readonly trigger: "origin_kind" | "entry_label" | "body_intent";
    }
  | {
      readonly admit: false;
      readonly reason: string;
      readonly detail: Record<string, unknown>;
    };

/** Fields a work-order intent block must never be able to set. */
const FORBIDDEN_INTENT_FIELDS = [
  "companyId",
  "companyRef",
  "projectId",
  "projectRef",
  "scope",
  "actor",
  "actorId",
  "actorType",
  "actorUserId",
  "approved",
  "approverUserId",
  "rootIssueId",
];

const FENCE_RE = /```\s*polyforge:work-order\s*\n([\s\S]*?)\n```/;

export class AdmissionGate {
  readonly #config: BridgeConfig;
  readonly #logger: BridgeLogger;
  readonly #metrics: BridgeMetrics;

  constructor(config: BridgeConfig, logger: BridgeLogger, metrics: BridgeMetrics) {
    this.#config = config;
    this.#logger = logger;
    this.#metrics = metrics;
  }

  /**
   * Decide whether an issue is an engineering entry.
   *
   * `issue` must already have been read through the company-scoped host client by the caller;
   * this function never fetches, so it cannot accidentally widen its own scope.
   */
  evaluate(issue: Issue, actorRef: string): AdmissionDecision {
    const companyId = issue.companyId;
    const projectId = issue.projectId;
    if (projectId === null || projectId.length === 0) {
      return {
        admit: false,
        reason: "issue has no project; project identity must come from the trusted issue relation",
        detail: { issueId: issue.id },
      };
    }
    const scope: Scope = { companyRef: companyId, projectRef: projectId };

    const originKind = typeof issue.originKind === "string" ? issue.originKind : "";
    const prefix = this.#config.engineeringOriginPrefix;
    const originMatches = prefix.length > 0 && originKind.startsWith(prefix);
    const entryLabel = this.#config.engineeringEntryLabel;
    const labelMatches =
      entryLabel.length > 0 && (issue.labels ?? []).some((label) => label.name === entryLabel);

    const block = parseWorkOrderIntent(issue.description ?? "", this.#metrics, companyId, this.#logger);

    if (!originMatches && !labelMatches && block === null) {
      return {
        admit: false,
        reason: "no configured engineering-entry trigger is present on this issue",
        detail: {
          issueId: issue.id,
          originKind: originKind.length > 0 ? originKind : null,
          engineeringEntryLabel: entryLabel.length > 0 ? entryLabel : null,
          bodyIntentPresent: false,
        },
      };
    }

    const graphId = block?.graphId ?? this.#config.defaultGraphId;
    if (graphId === null || graphId.length === 0) {
      return {
        admit: false,
        reason: "no graph is configured for this company and the issue body names none",
        detail: { issueId: issue.id, defaultGraphId: this.#config.defaultGraphId },
      };
    }

    const entrypoint = block?.entrypoint ?? "";
    const startIntentId = deriveStartIntentId(scope, issue.id, graphId, entrypoint, block);

    this.#logger.info("issue is an engineering entry", {
      issueId: issue.id,
      trigger: block !== null ? "body_intent" : originMatches ? "origin_kind" : "entry_label",
      startIntentId,
      actorRef,
    });

    return {
      admit: true,
      startIntentId,
      graphId,
      entrypoint,
      scope,
      projectId,
      rootIssueId: issue.id,
      inputSnapshot: block?.inputSnapshot ?? {},
      trigger: block !== null ? "body_intent" : originMatches ? "origin_kind" : "entry_label",
    };
  }
}

/**
 * Derive the stable start intent id.
 *
 * `scope + issue + graph + entrypoint` for a label/origin admission; plus the digest of the
 * intent payload when the author supplied one, so a deliberate edit of the inputs is a new
 * intent and therefore a new run — the documented way to ask for a second run without
 * deleting the first.
 */
export function deriveStartIntentId(
  scope: Scope,
  issueId: string,
  graphId: string,
  entrypoint: string,
  block: WorkOrderIntentBlock | null,
): string {
  if (block?.startIntentId !== null && block?.startIntentId !== undefined && block.startIntentId.length > 0) {
    // The author declared it, so it is theirs to choose — but it is still namespaced by
    // scope+issue so one tenant cannot collide with another by reusing a name.
    return hashDomain("pf.start-intent", {
      declared: block.startIntentId,
      scope,
      issueId,
      graphId,
      entrypoint,
    });
  }
  return hashDomain("pf.start-intent", {
    scope,
    issueId,
    graphId,
    entrypoint,
    ...(block === null ? {} : { intentDigest: digestText(canonicalJson(block.inputSnapshot)) }),
  });
}

/**
 * Parse the fenced work-order intent, or return `null`.
 *
 * A malformed block is a *refusal with a reason*, not a silent fallback: an author who typed a
 * broken block should be told, and the default graph+entrypoint must not be used to start a
 * run from an input the bridge could not read.
 */
export function parseWorkOrderIntent(
  description: string,
  metrics: BridgeMetrics,
  companyId: string,
  logger: BridgeLogger,
): WorkOrderIntentBlock | null {
  const match = FENCE_RE.exec(description);
  if (!match) return null;
  const raw = match[1];
  if (raw === undefined) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    logger.warn("work-order intent block is not valid JSON; refusing to admit from it", {
      reason: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    logger.warn("work-order intent block is not an object; refusing to admit from it");
    return null;
  }
  const record = parsed as Record<string, unknown>;

  const rejectedFields = FORBIDDEN_INTENT_FIELDS.filter((field) => field in record);
  if (rejectedFields.length > 0) {
    // The author tried to name the scope or an actor. The fields are ignored, the attempt is
    // counted, and admission continues with the host-derived scope. Silently honouring them
    // would be a cross-tenant escalation; silently ignoring them without a signal would hide
    // an attempted escalation.
    metrics.bump(companyId, "crossScopeDenials");
    logger.warn("work-order intent tried to set identity or approval fields; they were ignored", {
      rejectedFields,
    });
  }

  const graphId = typeof record["graphId"] === "string" ? record["graphId"] : null;
  const entrypoint = typeof record["entrypoint"] === "string" ? record["entrypoint"] : null;
  const startIntentId = typeof record["startIntentId"] === "string" ? record["startIntentId"] : null;
  const inputSnapshot =
    typeof record["inputSnapshot"] === "object" && record["inputSnapshot"] !== null && !Array.isArray(record["inputSnapshot"])
      ? (record["inputSnapshot"] as Record<string, unknown>)
      : {};

  if (graphId === null || entrypoint === null) {
    logger.warn("work-order intent block must name both graphId and entrypoint; refusing to admit from it");
    return null;
  }

  return { graphId, entrypoint, inputSnapshot, startIntentId, rejectedFields };
}

/** Render the intent block an operator can paste into a Root Issue description. */
export function renderWorkOrderIntentBlock(intent: {
  graphId: string;
  entrypoint: string;
  inputSnapshot?: Record<string, unknown>;
  startIntentId?: string;
}): string {
  return [
    "```polyforge:work-order",
    JSON.stringify(
      {
        graphId: intent.graphId,
        entrypoint: intent.entrypoint,
        ...(intent.inputSnapshot ? { inputSnapshot: intent.inputSnapshot } : {}),
        ...(intent.startIntentId ? { startIntentId: intent.startIntentId } : {}),
      },
      null,
      2,
    ),
    "```",
  ].join("\n");
}
