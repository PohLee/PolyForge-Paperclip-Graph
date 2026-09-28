/**
 * Structured logging with correlation ids and mandatory redaction.
 *
 * Every line the bridge emits carries enough context to find the run, node, transition and
 * provider object it concerns (docs/02 §13) and nothing that could be replayed as an
 * identity claim or replayed as a prompt (docs/02 §12). Two rules are enforced here rather
 * than at each call site, because a call site that forgets to redact is a leak:
 *
 *   1. Values pass through `redact()` on every path.
 *   2. The actor is logged as a *derived kind plus a short digest of the id*, never as the
 *      raw id in an "actor" field, so a log aggregator cannot be used as an assertion
 *      oracle for `X-PF-Actor`.
 */

import { digestText } from "@polyforge/protocol";
import type { PluginLogger } from "@paperclipai/plugin-sdk";
import { redact } from "./errors.js";
import type { LogLevel } from "./config.js";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface CorrelationContext {
  readonly correlationId?: string;
  readonly workOrderId?: string;
  readonly runId?: string;
  readonly nodeId?: string;
  readonly transitionHash?: string;
  readonly attemptId?: string;
  readonly issueId?: string;
  readonly agentRunId?: string;
  readonly companyId?: string;
  readonly projectId?: string;
}

/** A log-safe actor reference: the kind, plus a digest that is stable but not an identity. */
export interface ActorLogRef {
  readonly actorType: "human" | "agent" | "system";
  readonly actorIdDigest: string;
}

export function actorLogRef(actorType: "human" | "agent" | "system", actorId: string): ActorLogRef {
  return { actorType, actorIdDigest: digestText(actorId).slice(0, 19) };
}

export interface BridgeLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  /** Derive a logger that merges additional context into every subsequent line. */
  child(context: CorrelationContext): BridgeLogger;
}

class StructuredLogger implements BridgeLogger {
  readonly #sink: PluginLogger;
  readonly #level: LogLevel;
  readonly #context: CorrelationContext;

  constructor(sink: PluginLogger, level: LogLevel, context: CorrelationContext) {
    this.#sink = sink;
    this.#level = level;
    this.#context = context;
  }

  child(context: CorrelationContext): BridgeLogger {
    return new StructuredLogger(this.#sink, this.#level, { ...this.#context, ...compact(context) });
  }

  #emit(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.#level]) return;
    const merged: Record<string, unknown> = {
      ...redact(this.#context) as Record<string, unknown>,
      ...(redact(meta ?? {}) as Record<string, unknown>),
    };
    const line = `[polyforge] ${message}`;
    if (level === "error") this.#sink.error(line, merged);
    else if (level === "warn") this.#sink.warn(line, merged);
    else if (level === "info") this.#sink.info(line, merged);
    else this.#sink.debug(line, merged);
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.#emit("debug", message, meta);
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.#emit("info", message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.#emit("warn", message, meta);
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.#emit("error", message, meta);
  }
}

function compact(context: CorrelationContext): CorrelationContext {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(context)) {
    if (typeof value === "string" && value.length > 0) out[key] = value;
  }
  return out as CorrelationContext;
}

/** A logger that discards everything. Used by unit tests that assert behaviour, not output. */
export const NULL_LOGGER: BridgeLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return NULL_LOGGER;
  },
};

export function createLogger(sink: PluginLogger, level: LogLevel): BridgeLogger {
  return new StructuredLogger(sink, level, {});
}
