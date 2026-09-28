/**
 * `ObservabilityPort` — activity log plus metrics, with correlation ids.
 *
 * This is the only port whose output is read by humans directly, so it is also the easiest
 * place to leak. Two filters are applied here rather than trusted to the caller:
 *
 * * Free-text keys (`prompt`, `body`, `description`, `content`, `text`, …) are replaced with a
 *   length marker, so an activity entry can carry "a question was asked, 412 characters" and
 *   never the question.
 * * Actor fields are dropped entirely, for the same reason as the signed body
 *   (`src/identity.ts`): an activity log is not an identity assertion channel.
 *
 * The Core's own `correlationId` is preserved verbatim so an activity entry, a metric point
 * and a stored delivery all join on the same key.
 */

import type { CommandMeta, ObservabilityPort, ProgressProjection } from "@polyforge/protocol";
import type { BridgeDeps } from "./index.js";
import { isActorishKey } from "../identity.js";

/** Keys whose content is never written to the activity log or a metric tag. */
const TEXT_KEYS = new Set(["prompt", "body", "description", "text", "content", "question", "summary", "message"]);

const MAX_ACTIVITY_VALUE = 200;

function safeForActivity(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[truncated]";
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    return value.length > MAX_ACTIVITY_VALUE ? `[text:len=${value.length}]` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => safeForActivity(item, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (isActorishKey(key)) continue;
      if (TEXT_KEYS.has(key.toLowerCase())) {
        out[key] = typeof item === "string" ? `[text:len=${item.length}]` : "[text]";
        continue;
      }
      out[key] = safeForActivity(item, depth + 1);
    }
    return out;
  }
  return "[redacted]";
}

export class ObservabilityPortImpl implements ObservabilityPort {
  readonly #deps: BridgeDeps;

  constructor(deps: BridgeDeps) {
    this.#deps = deps;
  }

  async publishProgress(event: ProgressProjection, meta: CommandMeta): Promise<void> {
    const { ctx, store, logger } = this.#deps;
    const scope = event.scope;
    const payload = safeForActivity(event.payload) as Record<string, unknown>;

    // The projection sequence is recorded so a late or duplicated progress event does not
    // rewrite the offset, and so the UI can ask "how far behind is this view?".
    store.advanceProjection({
      companyId: scope.companyRef,
      targetKind: `progress:${event.kind}`,
      targetId: event.runId,
      projectionSequence: event.projectionSequence,
    });

    const message =
      `PolyForge ${event.kind} progress for run ${event.runId}` +
      (event.projectionSequence > 0 ? ` (projection ${event.projectionSequence})` : "");
    try {
      await ctx.activity.log({
        companyId: scope.companyRef,
        message,
        entityType: "issue",
        entityId: event.runId,
        metadata: {
          source: "polyforge",
          kind: event.kind,
          runId: event.runId,
          correlationId: event.correlationId,
          commandId: meta.commandId,
          projectionSequence: event.projectionSequence,
          projectRef: scope.projectRef,
          ...payload,
        },
      });
    } catch (error) {
      // An activity write failure is a real incident (docs/05 §10: an audit write failure
      // pauses sensitive operations) but it must not abort the caller: the Core's own event
      // log is the authoritative record and the projection offset is already durable.
      logger.error("activity log write failed; the engineering record is unaffected but the audit is incomplete", {
        runId: event.runId,
        kind: event.kind,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      await ctx.metrics.write("polyforge.progress", event.projectionSequence, {
        company: scope.companyRef,
        run: event.runId,
        kind: event.kind,
      });
    } catch {
      // Metrics are best effort; the durable counter lives in the bridge store.
    }
  }
}
