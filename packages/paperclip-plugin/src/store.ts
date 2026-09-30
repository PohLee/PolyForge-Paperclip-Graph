/**
 * The bridge's durable store: a private SQLite file opened with `node:sqlite`.
 *
 * ## Why not `ctx.db`
 *
 * The host's `ctx.db.execute` accepts exactly one statement per call, enforced by
 * `validatePluginRuntimeExecute` in `@paperclipai/server`. That makes a multi-statement
 * inbox+outbox commit impossible to make atomic through it: the best available sequence is
 * "write the inbox row, then write the outbox row", and a crash between the two loses an
 * event the bridge has already acknowledged. A durable outbox without a real transaction is
 * precisely the failure mode this system exists to avoid (docs/05 §5, §10), so the bridge
 * keeps its own file where `BEGIN IMMEDIATE` gives a real commit.
 *
 * `ctx.db` is still the right tool for *reporting* across plugins, which this plugin does
 * not need. Every table here is bridge-owned; nothing in this file writes a Paperclip table.
 *
 * ## Transaction discipline
 *
 * `transaction()` is reentrant through a savepoint stack: a nested `transaction()` inside an
 * outer one becomes `SAVEPOINT`/`RELEASE`, so a composite operation (record inbox → enqueue
 * outbox → advance offset) is one atomic unit and a failure anywhere rolls the whole unit
 * back. `BEGIN IMMEDIATE` takes the write lock up front, so a read-then-write cannot lose a
 * race with a second worker process.
 *
 * ## Scope discipline
 *
 * Every unique constraint includes `company_id`. There is no key in this schema that is
 * usable across scopes, which is what makes "nothing is usable across scopes" a property of
 * the database rather than a promise in a review comment.
 */

import { DatabaseSync, type StatementSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { canonicalJson, stableIdempotencyKey } from "@polyforge/protocol";
import { BridgeError, BridgeConfigError } from "./errors.js";

export type DeliveryStatus =
  | "pending"
  | "sent"
  | "observed"
  | "reconciled"
  | "ambiguous"
  | "failed";

export interface DeliveryRow {
  id: string;
  companyId: string;
  projectId: string;
  kind: string;
  effectKey: string;
  correlationId: string;
  runId: string | null;
  nodeId: string | null;
  payloadJson: string;
  payloadHash: string;
  status: DeliveryStatus;
  attempts: number;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  nextAttemptAt: string;
  resultJson: string | null;
  receiptRef: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InboxRow {
  id: number;
  source: string;
  companyId: string;
  projectId: string;
  sourceEventId: string;
  eventType: string;
  payloadHash: string;
  status: string;
  attempts: number;
  lastError: string | null;
  occurredAt: string;
  receivedAt: string;
}

export interface QuarantineRow {
  id: number;
  companyId: string;
  eventType: string;
  sourceEventId: string;
  detectedVersion: string;
  payloadHash: string;
  reason: string;
  payloadJson: string;
  createdAt: string;
}

export interface BindingRow {
  id: string;
  companyId: string;
  kind: string;
  providerId: string;
  projectId: string;
  payloadJson: string;
  revision: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectionOffsetRow {
  companyId: string;
  targetKind: string;
  targetId: string;
  projectionSequence: number;
  appliedStateVersion: number | null;
  updatedAt: string;
}

export interface CommandLogRow {
  id: number;
  companyId: string;
  commandId: string;
  idempotencyKey: string;
  payloadHash: string;
  status: string;
  resultJson: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CounterSnapshot {
  [name: string]: number;
}

const SCHEMA_VERSION = 1;

/**
 * The complete bridge-owned schema.
 *
 * Seven required tables plus `schema_quarantine`. Counters live in `compatibility_state`
 * under a `counter/` key namespace rather than in a ninth table: a counter is a piece of
 * per-company compatibility/observability state, and keeping it here means the health
 * counters inherit the same company-scoped uniqueness as everything else.
 */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS provider_bindings (
  id            TEXT    PRIMARY KEY,
  company_id    TEXT    NOT NULL,
  kind          TEXT    NOT NULL,
  provider_id   TEXT    NOT NULL,
  project_id    TEXT    NOT NULL DEFAULT '',
  payload_json  TEXT    NOT NULL,
  revision      TEXT,
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL,
  UNIQUE (company_id, kind, provider_id)
);

CREATE TABLE IF NOT EXISTS event_inbox (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  source            TEXT    NOT NULL,
  company_id        TEXT    NOT NULL,
  project_id        TEXT    NOT NULL DEFAULT '',
  source_event_id   TEXT    NOT NULL,
  event_type        TEXT    NOT NULL,
  payload_hash      TEXT    NOT NULL,
  status            TEXT    NOT NULL,
  normalized_json   TEXT,
  attempts          INTEGER NOT NULL DEFAULT 0,
  last_error        TEXT,
  occurred_at       TEXT    NOT NULL,
  received_at       TEXT    NOT NULL,
  UNIQUE (source, company_id, source_event_id)
);

CREATE TABLE IF NOT EXISTS delivery_operations (
  id                TEXT    PRIMARY KEY,
  company_id        TEXT    NOT NULL,
  project_id        TEXT    NOT NULL DEFAULT '',
  kind              TEXT    NOT NULL,
  effect_key        TEXT    NOT NULL,
  correlation_id    TEXT    NOT NULL DEFAULT '',
  run_id            TEXT,
  node_id           TEXT,
  payload_json      TEXT    NOT NULL,
  payload_hash      TEXT    NOT NULL,
  status            TEXT    NOT NULL,
  attempts          INTEGER NOT NULL DEFAULT 0,
  lease_owner       TEXT,
  lease_expires_at  TEXT,
  next_attempt_at   TEXT    NOT NULL,
  result_json       TEXT,
  receipt_ref       TEXT,
  last_error        TEXT,
  created_at        TEXT    NOT NULL,
  updated_at        TEXT    NOT NULL,
  UNIQUE (company_id, effect_key)
);

CREATE TABLE IF NOT EXISTS projection_offsets (
  company_id               TEXT    NOT NULL,
  target_kind              TEXT    NOT NULL,
  target_id                TEXT    NOT NULL,
  projection_sequence      INTEGER NOT NULL,
  applied_state_version    INTEGER,
  updated_at               TEXT    NOT NULL,
  PRIMARY KEY (company_id, target_kind, target_id)
);

CREATE TABLE IF NOT EXISTS compatibility_state (
  company_id   TEXT NOT NULL,
  key          TEXT NOT NULL,
  value_json   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (company_id, key)
);

CREATE TABLE IF NOT EXISTS command_log (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id        TEXT    NOT NULL,
  command_id        TEXT    NOT NULL,
  idempotency_key   TEXT    NOT NULL,
  payload_hash      TEXT    NOT NULL,
  status            TEXT    NOT NULL,
  result_json       TEXT,
  created_at        TEXT    NOT NULL,
  updated_at        TEXT    NOT NULL,
  UNIQUE (company_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS nonce_ledger (
  nonce        TEXT    PRIMARY KEY,
  issued_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_quarantine (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id        TEXT    NOT NULL,
  event_type        TEXT    NOT NULL,
  source_event_id   TEXT    NOT NULL,
  detected_version  TEXT    NOT NULL,
  payload_hash      TEXT    NOT NULL,
  reason            TEXT    NOT NULL,
  payload_json      TEXT    NOT NULL,
  created_at        TEXT    NOT NULL,
  UNIQUE (company_id, event_type, payload_hash)
);

CREATE INDEX IF NOT EXISTS idx_delivery_due
  ON delivery_operations (company_id, status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_inbox_status
  ON event_inbox (company_id, status, id);
CREATE INDEX IF NOT EXISTS idx_binding_kind
  ON provider_bindings (company_id, kind);
`;

export interface StoreOptions {
  /** Absolute path of the SQLite file. The parent directory must already exist or be creatable. */
  readonly path: string;
  /** Called for every store-level warning (quarantine, integrity refusal). */
  readonly onWarning?: (message: string, detail: Record<string, unknown>) => void;
  /** Deterministic clock so tests can control lease and backoff windows. */
  readonly now?: () => Date;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : String(value);
}

function nullableStr(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function num(value: unknown): number {
  return typeof value === "number" ? value : Number(value ?? 0);
}

function nullableNum(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return typeof value === "number" ? value : Number(value);
}

function mapDelivery(row: Record<string, unknown>): DeliveryRow {
  return {
    id: str(row["id"]),
    companyId: str(row["company_id"]),
    projectId: str(row["project_id"]),
    kind: str(row["kind"]),
    effectKey: str(row["effect_key"]),
    correlationId: str(row["correlation_id"]),
    runId: nullableStr(row["run_id"]),
    nodeId: nullableStr(row["node_id"]),
    payloadJson: str(row["payload_json"]),
    payloadHash: str(row["payload_hash"]),
    status: str(row["status"]) as DeliveryStatus,
    attempts: num(row["attempts"]),
    leaseOwner: nullableStr(row["lease_owner"]),
    leaseExpiresAt: nullableStr(row["lease_expires_at"]),
    nextAttemptAt: str(row["next_attempt_at"]),
    resultJson: nullableStr(row["result_json"]),
    receiptRef: nullableStr(row["receipt_ref"]),
    lastError: nullableStr(row["last_error"]),
    createdAt: str(row["created_at"]),
    updatedAt: str(row["updated_at"]),
  };
}

function mapInbox(row: Record<string, unknown>): InboxRow {
  return {
    id: num(row["id"]),
    source: str(row["source"]),
    companyId: str(row["company_id"]),
    projectId: str(row["project_id"]),
    sourceEventId: str(row["source_event_id"]),
    eventType: str(row["event_type"]),
    payloadHash: str(row["payload_hash"]),
    status: str(row["status"]),
    attempts: num(row["attempts"]),
    lastError: nullableStr(row["last_error"]),
    occurredAt: str(row["occurred_at"]),
    receivedAt: str(row["received_at"]),
  };
}

function mapBinding(row: Record<string, unknown>): BindingRow {
  return {
    id: str(row["id"]),
    companyId: str(row["company_id"]),
    kind: str(row["kind"]),
    providerId: str(row["provider_id"]),
    projectId: str(row["project_id"]),
    payloadJson: str(row["payload_json"]),
    revision: nullableStr(row["revision"]),
    createdAt: str(row["created_at"]),
    updatedAt: str(row["updated_at"]),
  };
}

export class BridgeStore {
  readonly #db: DatabaseSync;
  readonly #path: string;
  readonly #now: () => Date;
  readonly #onWarning: ((message: string, detail: Record<string, unknown>) => void) | undefined;
  readonly #statements = new Map<string, StatementSync>();
  #savepointDepth = 0;
  #savepointCounter = 0;
  #closed = false;

  private constructor(options: StoreOptions) {
    this.#path = options.path;
    this.#now = options.now ?? (() => new Date());
    this.#onWarning = options.onWarning;
    try {
      mkdirSync(dirname(options.path), { recursive: true });
    } catch (error) {
      throw new BridgeConfigError("stateDir is not creatable; the bridge cannot open its store", {
        stateDir: dirname(options.path),
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(options.path);
    } catch (error) {
      throw new BridgeConfigError("bridge store file is not openable", {
        path: options.path,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    this.#db = db;
    // WAL keeps readers from blocking the single writer across a crash; busy_timeout turns a
    // contended write into a bounded wait rather than an immediate SQLITE_BUSY.
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec("PRAGMA synchronous = FULL");
    this.#db.exec("PRAGMA foreign_keys = ON");
    this.#db.exec("PRAGMA busy_timeout = 5000");
    this.#db.exec(SCHEMA_SQL);
  }

  static open(options: StoreOptions): BridgeStore {
    return new BridgeStore(options);
  }

  get path(): string {
    return this.#path;
  }

  get schemaVersion(): number {
    return SCHEMA_VERSION;
  }

  #prep(sql: string): StatementSync {
    const cached = this.#statements.get(sql);
    if (cached) return cached;
    const statement = this.#db.prepare(sql);
    this.#statements.set(sql, statement);
    return statement;
  }

  /**
   * Run `fn` inside a write transaction.
   *
   * `BEGIN IMMEDIATE` (not `BEGIN DEFERRED`) because every unit here is a read-then-write:
   * a deferred transaction that upgrades mid-way can fail with SQLITE_BUSY_SNAPSHOT after
   * the reads, which would silently split an inbox+outbox commit.
   */
  transaction<T>(fn: () => T): T {
    if (this.#closed) {
      throw new BridgeError("BRIDGE_STORE_UNAVAILABLE", "BLOCKED_PLATFORM", "bridge store is closed");
    }
    if (this.#savepointDepth > 0) {
      this.#savepointCounter += 1;
      const name = `pf_sp_${this.#savepointCounter}`;
      this.#db.exec(`SAVEPOINT ${name}`);
      this.#savepointDepth += 1;
      try {
        const result = fn();
        this.#db.exec(`RELEASE ${name}`);
        return result;
      } catch (error) {
        this.#db.exec(`ROLLBACK TO ${name}`);
        this.#db.exec(`RELEASE ${name}`);
        throw error;
      } finally {
        this.#savepointDepth -= 1;
      }
    }
    this.#db.exec("BEGIN IMMEDIATE");
    this.#savepointDepth = 1;
    try {
      const result = fn();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    } finally {
      this.#savepointDepth = 0;
    }
  }

  /**
   * Verify the store can still be read and written.
   *
   * Used by `onHealth` so an unwritable store degrades to `read_only` loudly instead of
   * failing silently on the first event.
   */
  checkWritable(): { ok: boolean; detail: string | null } {
    try {
      this.transaction(() => {
        this.#prep("INSERT INTO compatibility_state (company_id, key, value_json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (company_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at")
          .run("__health__", "probe", "{}", this.#now().toISOString());
      });
      return { ok: true, detail: null };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#statements.clear();
    try {
      this.#db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      // A checkpoint failure must not prevent the close; WAL recovery handles it.
    }
    this.#db.close();
  }

  // -------------------------------------------------------------------------
  // provider_bindings
  // -------------------------------------------------------------------------

  putBinding(input: {
    companyId: string;
    kind: string;
    providerId: string;
    projectId?: string;
    payload: unknown;
    revision?: string | null;
  }): BindingRow {
    const now = this.#now().toISOString();
    const payloadJson = canonicalJson(input.payload ?? {});
    const id = stableIdempotencyKey([input.companyId, input.kind, input.providerId]);
    return this.transaction(() => {
      this.#prep(
        `INSERT INTO provider_bindings (id, company_id, kind, provider_id, project_id, payload_json, revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (company_id, kind, provider_id) DO UPDATE SET
           project_id = excluded.project_id,
           payload_json = excluded.payload_json,
           revision = excluded.revision,
           updated_at = excluded.updated_at`,
      ).run(
        id,
        input.companyId,
        input.kind,
        input.providerId,
        input.projectId ?? "",
        payloadJson,
        input.revision ?? null,
        now,
        now,
      );
      const found = this.getBinding(input.companyId, input.kind, input.providerId);
      if (!found) {
        throw new BridgeError("BRIDGE_INTEGRITY_FAILURE", "BLOCKED_STALE_INPUT", "binding write did not persist", {
          kind: input.kind,
          providerId: input.providerId,
        });
      }
      return found;
    });
  }

  getBinding(companyId: string, kind: string, providerId: string): BindingRow | null {
    const row = this.#prep(
      "SELECT * FROM provider_bindings WHERE company_id = ? AND kind = ? AND provider_id = ?",
    ).get(companyId, kind, providerId);
    return row ? mapBinding(row) : null;
  }

  listBindings(companyId: string, kind: string, limit = 500): BindingRow[] {
    return this.#prep(
      "SELECT * FROM provider_bindings WHERE company_id = ? AND kind = ? ORDER BY updated_at DESC LIMIT ?",
    )
      .all(companyId, kind, limit)
      .map(mapBinding);
  }

  deleteBinding(companyId: string, kind: string, providerId: string): void {
    this.#prep("DELETE FROM provider_bindings WHERE company_id = ? AND kind = ? AND provider_id = ?").run(
      companyId,
      kind,
      providerId,
    );
  }

  // -------------------------------------------------------------------------
  // event_inbox
  // -------------------------------------------------------------------------

  /**
   * Insert an inbox row, or report the existing one.
   *
   * The dedupe identity is exactly docs/05 §8.1 `source + scope + sourceEventId`. The `INSERT
   * OR IGNORE` plus a `changes` check is the dedupe: no read-then-write race, so 100
   * concurrent replays of one event still produce one row.
   */
  recordInbox(input: {
    source: string;
    companyId: string;
    projectId?: string;
    sourceEventId: string;
    eventType: string;
    payload: unknown;
    occurredAt: string;
  }): { row: InboxRow; duplicate: boolean } {
    const now = this.#now().toISOString();
    const payloadJson = canonicalJson(input.payload ?? {});
    const payloadHash = `sha256:${Buffer.from(payloadJson, "utf8").toString("hex")}`;
    const result = this.#prep(
      `INSERT OR IGNORE INTO event_inbox
        (source, company_id, project_id, source_event_id, event_type, payload_hash, status, attempts, occurred_at, received_at)
       VALUES (?, ?, ?, ?, ?, ?, 'received', 0, ?, ?)`,
    ).run(
      input.source,
      input.companyId,
      input.projectId ?? "",
      input.sourceEventId,
      input.eventType,
      payloadHash,
      input.occurredAt,
      now,
    );
    const duplicate = result.changes === 0;
    const row = this.#prep(
      "SELECT * FROM event_inbox WHERE source = ? AND company_id = ? AND source_event_id = ?",
    ).get(input.source, input.companyId, input.sourceEventId);
    if (!row) {
      throw new BridgeError("BRIDGE_INTEGRITY_FAILURE", "BLOCKED_STALE_INPUT", "inbox write did not persist", {
        sourceEventId: input.sourceEventId,
      });
    }
    return { row: mapInbox(row), duplicate };
  }

  getInboxRow(source: string, companyId: string, sourceEventId: string): InboxRow | null {
    const row = this.#prep(
      "SELECT * FROM event_inbox WHERE source = ? AND company_id = ? AND source_event_id = ?",
    ).get(source, companyId, sourceEventId);
    return row ? mapInbox(row) : null;
  }

  updateInboxStatus(
    source: string,
    companyId: string,
    sourceEventId: string,
    status: string,
    options: { normalized?: unknown; error?: string | null; bumpAttempts?: boolean } = {},
  ): void {
    const now = this.#now().toISOString();
    this.#prep(
      `UPDATE event_inbox SET status = ?,
         normalized_json = COALESCE(?, normalized_json),
         last_error = ?,
         attempts = attempts + ?
       WHERE source = ? AND company_id = ? AND source_event_id = ?`,
    ).run(
      status,
      options.normalized === undefined ? null : canonicalJson(options.normalized),
      options.error ?? null,
      options.bumpAttempts ? 1 : 0,
      source,
      companyId,
      sourceEventId,
    );
    void now;
  }

  countInboxByStatus(companyId: string, status: string): number {
    const row = this.#prep(
      "SELECT COUNT(*) AS c FROM event_inbox WHERE company_id = ? AND status = ?",
    ).get(companyId, status);
    return num(row?.["c"]);
  }

  /** Inbox rows in the given states, oldest first. Used by the replay sweep after a restart. */
  listInboxStatuses(companyId: string, statuses: string[], limit = 200): InboxRow[] {
    if (statuses.length === 0) return [];
    return this.#prep(
      `SELECT * FROM event_inbox WHERE company_id = ? AND status IN (${statuses.map(() => "?").join(",")})
       ORDER BY id ASC LIMIT ?`,
    )
      .all(companyId, ...statuses, limit)
      .map(mapInbox);
  }

  // -------------------------------------------------------------------------
  // schema_quarantine
  // -------------------------------------------------------------------------

  /**
   * Park an event whose schema the bridge does not understand.
   *
   * Never a silent drop: the payload hash plus the version the bridge was *expecting* is
   * enough for an operator to diff it, and a warning is emitted so an unknown schema shows
   * up in health rather than in a support ticket weeks later.
   */
  quarantine(input: {
    companyId: string;
    eventType: string;
    sourceEventId: string;
    detectedVersion: string;
    payload: unknown;
    reason: string;
  }): void {
    const now = this.#now().toISOString();
    const payloadJson = canonicalJson(input.payload ?? {});
    const payloadHash = `sha256:${Buffer.from(payloadJson, "utf8").toString("hex")}`;
    this.#prep(
      `INSERT OR IGNORE INTO schema_quarantine
        (company_id, event_type, source_event_id, detected_version, payload_hash, reason, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.companyId,
      input.eventType,
      input.sourceEventId,
      input.detectedVersion,
      payloadHash,
      input.reason,
      payloadJson,
      now,
    );
    this.#onWarning?.("event quarantined: unknown schema", {
      eventType: input.eventType,
      detectedVersion: input.detectedVersion,
      reason: input.reason,
    });
  }

  countQuarantine(companyId: string): number {
    const row = this.#prep("SELECT COUNT(*) AS c FROM schema_quarantine WHERE company_id = ?").get(companyId);
    return num(row?.["c"]);
  }

  listQuarantine(companyId: string, limit = 50): QuarantineRow[] {
    return this.#prep(
      "SELECT * FROM schema_quarantine WHERE company_id = ? ORDER BY id DESC LIMIT ?",
    )
      .all(companyId, limit)
      .map((row) => ({
        id: num(row["id"]),
        companyId: str(row["company_id"]),
        eventType: str(row["event_type"]),
        sourceEventId: str(row["source_event_id"]),
        detectedVersion: str(row["detected_version"]),
        payloadHash: str(row["payload_hash"]),
        reason: str(row["reason"]),
        payloadJson: str(row["payload_json"]),
        createdAt: str(row["created_at"]),
      }));
  }

  // -------------------------------------------------------------------------
  // delivery_operations (the outbox)
  // -------------------------------------------------------------------------

  /**
   * Enqueue a delivery operation, or return the existing one for the same effect key.
   *
   * `effectKey` is the *business* identity (docs/05 §8.1), never a per-attempt random id:
   * a retried enqueue of the same effect returns the same row, so a replayed start intent
   * cannot become two work-order requests.
   */
  enqueueDelivery(input: {
    id: string;
    companyId: string;
    projectId?: string;
    kind: string;
    effectKey: string;
    /** Joins the delivery to the Core command it came from; stored so a retry reuses it. */
    correlationId?: string;
    runId?: string | null;
    nodeId?: string | null;
    payload: unknown;
    nextAttemptAt?: string;
  }): { row: DeliveryRow; created: boolean } {
    const now = this.#now().toISOString();
    const payloadJson = canonicalJson(input.payload ?? {});
    const payloadHash = `sha256:${Buffer.from(payloadJson, "utf8").toString("hex")}`;
    const result = this.#prep(
      `INSERT OR IGNORE INTO delivery_operations
        (id, company_id, project_id, kind, effect_key, correlation_id, run_id, node_id, payload_json, payload_hash,
         status, attempts, next_attempt_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
    ).run(
      input.id,
      input.companyId,
      input.projectId ?? "",
      input.kind,
      input.effectKey,
      input.correlationId ?? "",
      input.runId ?? null,
      input.nodeId ?? null,
      payloadJson,
      payloadHash,
      input.nextAttemptAt ?? now,
      now,
      now,
    );
    const row = this.#getDelivery(input.companyId, input.effectKey);
    if (!row) {
      throw new BridgeError("BRIDGE_INTEGRITY_FAILURE", "BLOCKED_STALE_INPUT", "outbox write did not persist", {
        effectKey: input.effectKey,
      });
    }
    if (result.changes === 0 && row.payloadHash !== payloadHash) {
      // Same effect key, different payload. docs/05 §8.2: this is a conflict, never a
      // silent overwrite of the recorded intent.
      this.#onWarning?.("outbox effect key reused with a different payload", {
        effectKey: input.effectKey,
        kind: input.kind,
        recordedHash: row.payloadHash,
        offeredHash: payloadHash,
      });
    }
    return { row, created: result.changes > 0 };
  }

  #getDelivery(companyId: string, effectKey: string): DeliveryRow | null {
    const row = this.#prep(
      "SELECT * FROM delivery_operations WHERE company_id = ? AND effect_key = ?",
    ).get(companyId, effectKey);
    return row ? mapDelivery(row) : null;
  }

  getDeliveryByEffectKey(companyId: string, effectKey: string): DeliveryRow | null {
    return this.#getDelivery(companyId, effectKey);
  }

  getDeliveryById(companyId: string, id: string): DeliveryRow | null {
    const row = this.#prep("SELECT * FROM delivery_operations WHERE company_id = ? AND id = ?").get(companyId, id);
    return row ? mapDelivery(row) : null;
  }

  /**
   * Resolve the company that owns an effect key.
   *
   * A delivery recorder is handed an effect key, not a company, so that the port
   * signatures stay provider-neutral. The lookup keeps that convenience from becoming an
   * unscoped write: the row is found by key, and the company comes *from* the row.
   */
  findDeliveryCompany(effectKey: string): string | null {
    const row = this.#prep("SELECT company_id FROM delivery_operations WHERE effect_key = ? LIMIT 1").get(
      effectKey,
    );
    return nullableStr(row?.["company_id"]);
  }

  /**
   * Resolve the company that owns a provider ref.
   *
   * The port contracts take a `ProviderRefLike` with no company, so a read has to re-derive
   * the scope from the bridge's own record of where that object was bound. A ref the bridge
   * has never bound resolves to `null`, and the port reports `unknown` rather than guessing —
   * "which tenant is this object in" is exactly the question that must not be guessed.
   */
  findCompanyForProviderRef(ref: { provider: string; kind: string; id: string }): string | null {
    const byId = this.#prep(
      "SELECT company_id FROM provider_bindings WHERE provider_id = ? ORDER BY updated_at DESC LIMIT 1",
    ).get(ref.id);
    const direct = nullableStr(byId?.["company_id"]);
    if (direct !== null) return direct;
    const byKind = this.#prep(
      "SELECT company_id FROM provider_bindings WHERE provider_id = ? ORDER BY updated_at DESC LIMIT 1",
    ).get(`${ref.kind}:${ref.id}`);
    return nullableStr(byKind?.["company_id"]);
  }

  /**
   * Whether a provider ref is bound in *this* company.
   *
   * The unscoped `findCompanyForProviderRef` answers "which tenant owns this id", which is the
   * right question for a process-level lookup and the wrong one inside a port: a per-company bundle
   * already knows its tenant, and asking globally lets company A's port follow a ref into company
   * B's bindings. The row it would find is then rejected a step later by the company-scoped host
   * read, so the failure is closed — but only by luck of ordering, and it logs a reason that
   * describes a missing object rather than a scope violation. Ports ask this instead.
   */
  isProviderRefInCompany(
    companyId: string,
    ref: { provider: string; kind: string; id: string },
  ): boolean {
    const row = this.#prep(
      "SELECT company_id FROM provider_bindings WHERE company_id = ? AND provider_id = ? LIMIT 1",
    ).get(companyId, ref.id);
    if (row !== undefined) return true;
    const byKind = this.#prep(
      "SELECT company_id FROM provider_bindings WHERE company_id = ? AND provider_id = ? LIMIT 1",
    ).get(companyId, `${ref.kind}:${ref.id}`);
    return byKind !== undefined;
  }

  /** Advance a delivery's state. Every transition the protocol names is a distinct status. */
  updateDelivery(
    companyId: string,
    effectKey: string,
    patch: {
      status?: DeliveryStatus;
      attempts?: number;
      result?: unknown;
      receiptRef?: string | null;
      lastError?: string | null;
      nextAttemptAt?: string;
      leaseOwner?: string | null;
      leaseExpiresAt?: string | null;
    },
  ): void {
    const now = this.#now().toISOString();
    this.#prep(
      `UPDATE delivery_operations SET
         status = COALESCE(?, status),
         attempts = COALESCE(?, attempts),
         result_json = COALESCE(?, result_json),
         receipt_ref = COALESCE(?, receipt_ref),
         last_error = ?,
         next_attempt_at = COALESCE(?, next_attempt_at),
         lease_owner = ?,
         lease_expires_at = COALESCE(?, lease_expires_at),
         updated_at = ?
       WHERE company_id = ? AND effect_key = ?`,
    ).run(
      patch.status ?? null,
      patch.attempts ?? null,
      patch.result === undefined ? null : canonicalJson(patch.result),
      patch.receiptRef ?? null,
      patch.lastError ?? null,
      patch.nextAttemptAt ?? null,
      patch.leaseOwner ?? null,
      patch.leaseExpiresAt ?? null,
      now,
      companyId,
      effectKey,
    );
  }

  /** Claim up to `limit` due deliveries for one worker, expiring stale leases first. */
  claimDueDeliveries(input: {
    companyId: string;
    owner: string;
    limit: number;
    leaseMs: number;
    kinds?: string[];
  }): DeliveryRow[] {
    const nowMs = this.#now().getTime();
    const nowIso = new Date(nowMs).toISOString();
    return this.transaction(() => {
      this.#prep(
        `UPDATE delivery_operations SET status = 'ambiguous', lease_owner = NULL, lease_expires_at = NULL,
           last_error = 'worker lease expired while delivery outcome was unknown', updated_at = ?
         WHERE company_id = ? AND status = 'sent'
           AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)`,
      ).run(nowIso, input.companyId, nowIso);
      // A sent row means an external request may already have taken effect. Once its lease expires,
      // it must go through reconciliation, never back through the sender. Only pending rows are
      // eligible for dispatch; re-running an expired sent row is a blind duplicate effect.
      this.#prep(
        `UPDATE delivery_operations SET lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE company_id = ? AND status = 'pending' AND lease_owner IS NOT NULL
           AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`,
      ).run(nowIso, input.companyId, nowIso);
      // Stored lease timestamps are canonical millisecond ISO strings, so lexical comparison
      // preserves their full precision. SQLite strftime('%s') truncates to seconds and expires
      // some millisecond leases early.
      const claimable = `(lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)`;
      const rows = input.kinds
        ? this.#prep(
            `SELECT * FROM delivery_operations
             WHERE company_id = ? AND status = 'pending' AND next_attempt_at <= ? AND ${claimable}
               AND kind IN (${input.kinds.map(() => "?").join(",")})
             ORDER BY next_attempt_at ASC LIMIT ?`,
          ).all(input.companyId, nowIso, nowIso, ...input.kinds, input.limit)
        : this.#prep(
            `SELECT * FROM delivery_operations
             WHERE company_id = ? AND status = 'pending' AND next_attempt_at <= ? AND ${claimable}
             ORDER BY next_attempt_at ASC LIMIT ?`,
          ).all(input.companyId, nowIso, nowIso, input.limit);
      const claimed: DeliveryRow[] = [];
      for (const row of rows) {
        const delivery = mapDelivery(row);
        const leaseExpiresAt = new Date(nowMs + input.leaseMs).toISOString();
        const result = this.#prep(
          `UPDATE delivery_operations SET lease_owner = ?, lease_expires_at = ?, status = 'sent', updated_at = ?
           WHERE company_id = ? AND effect_key = ? AND status = ? AND ${claimable}`,
        ).run(
          input.owner,
          leaseExpiresAt,
          nowIso,
          input.companyId,
          delivery.effectKey,
          delivery.status,
          nowIso,
        );
        if (result.changes > 0) claimed.push({ ...delivery, status: "sent", leaseOwner: input.owner, leaseExpiresAt });
      }
      return claimed;
    });
  }

  listDeliveries(companyId: string, statuses: DeliveryStatus[], limit = 200): DeliveryRow[] {
    if (statuses.length === 0) return [];
    return this.#prep(
      `SELECT * FROM delivery_operations WHERE company_id = ? AND status IN (${statuses.map(() => "?").join(",")})
       ORDER BY updated_at ASC LIMIT ?`,
    )
      .all(companyId, ...statuses, limit)
      .map(mapDelivery);
  }

  /** Oldest queued delivery age in seconds, or `null` when the outbox is empty. */
  outboxOldestAgeSeconds(companyId: string): number | null {
    const row = this.#prep(
      `SELECT MIN(created_at) AS oldest FROM delivery_operations
       WHERE company_id = ? AND status IN ('pending', 'sent', 'ambiguous')`,
    ).get(companyId);
    const oldest = nullableStr(row?.["oldest"]);
    if (!oldest) return null;
    const age = this.#now().getTime() - Date.parse(oldest);
    return age < 0 ? 0 : Math.floor(age / 1000);
  }

  countDeliveries(companyId: string, status: DeliveryStatus): number {
    const row = this.#prep("SELECT COUNT(*) AS c FROM delivery_operations WHERE company_id = ? AND status = ?").get(
      companyId,
      status,
    );
    return num(row?.["c"]);
  }

  // -------------------------------------------------------------------------
  // projection_offsets
  // -------------------------------------------------------------------------

  /**
   * Claim a projection sequence.
   *
   * Returns `false` when the incoming sequence is not strictly newer than what was already
   * applied, which is how an out-of-order or replayed projection is dropped instead of
   * overwriting newer state.
   */
  advanceProjection(input: {
    companyId: string;
    targetKind: string;
    targetId: string;
    projectionSequence: number;
    appliedStateVersion?: number | null;
  }): boolean {
    const now = this.#now().toISOString();
    return this.transaction(() => {
      const current = this.#readProjection(input.companyId, input.targetKind, input.targetId);
      if (current && current.projectionSequence >= input.projectionSequence) return false;
      this.#prep(
        `INSERT INTO projection_offsets
           (company_id, target_kind, target_id, projection_sequence, applied_state_version, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (company_id, target_kind, target_id) DO UPDATE SET
           projection_sequence = excluded.projection_sequence,
           applied_state_version = excluded.applied_state_version,
           updated_at = excluded.updated_at`,
      ).run(
        input.companyId,
        input.targetKind,
        input.targetId,
        input.projectionSequence,
        input.appliedStateVersion ?? null,
        now,
      );
      return true;
    });
  }

  #readProjection(companyId: string, targetKind: string, targetId: string): ProjectionOffsetRow | null {
    const row = this.#prep(
      "SELECT * FROM projection_offsets WHERE company_id = ? AND target_kind = ? AND target_id = ?",
    ).get(companyId, targetKind, targetId);
    if (!row) return null;
    return {
      companyId: str(row["company_id"]),
      targetKind: str(row["target_kind"]),
      targetId: str(row["target_id"]),
      projectionSequence: num(row["projection_sequence"]),
      appliedStateVersion: nullableNum(row["applied_state_version"]),
      updatedAt: str(row["updated_at"]),
    };
  }

  getProjectionOffset(companyId: string, targetKind: string, targetId: string): ProjectionOffsetRow | null {
    return this.#readProjection(companyId, targetKind, targetId);
  }

  /**
   * Seconds since the newest applied projection for a company, or `null` when nothing has
   * been projected yet. This is the projection-lag gauge.
   */
  projectionLagSeconds(companyId: string): number | null {
    const row = this.#prep(
      "SELECT MAX(updated_at) AS newest FROM projection_offsets WHERE company_id = ?",
    ).get(companyId);
    const newest = nullableStr(row?.["newest"]);
    if (!newest) return null;
    const age = this.#now().getTime() - Date.parse(newest);
    return age < 0 ? 0 : Math.floor(age / 1000);
  }

  // -------------------------------------------------------------------------
  // compatibility_state + counters
  // -------------------------------------------------------------------------

  setCompat(companyId: string, key: string, value: unknown): void {
    const now = this.#now().toISOString();
    this.#prep(
      `INSERT INTO compatibility_state (company_id, key, value_json, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (company_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    ).run(companyId, key, canonicalJson(value ?? null), now);
  }

  getCompat<T>(companyId: string, key: string, fallback: T): T {
    const row = this.#prep("SELECT value_json FROM compatibility_state WHERE company_id = ? AND key = ?").get(
      companyId,
      key,
    );
    const raw = nullableStr(row?.["value_json"]);
    if (raw === null) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  /**
   * Increment a named counter.
   *
   * Read-modify-write happens inside `BEGIN IMMEDIATE`, so two workers cannot both read 4
   * and both write 5. A missing counter starts at 0 and becomes 1.
   */
  bumpCounter(companyId: string, name: string, by = 1): number {
    return this.transaction(() => {
      const key = `counter/${name}`;
      const current = this.getCompat<number>(companyId, key, 0);
      const next = (Number.isFinite(current) ? current : 0) + by;
      this.setCompat(companyId, key, next);
      return next;
    });
  }

  counters(companyId: string, names: readonly string[]): CounterSnapshot {
    const out: CounterSnapshot = {};
    for (const name of names) {
      out[name] = this.getCompat<number>(companyId, `counter/${name}`, 0);
    }
    return out;
  }

  /**
   * Every company this bridge instance has already seen.
   *
   * Derived from rows the bridge itself wrote, not from a host enumeration. Two uses: a
   * bounded search where the Core's request genuinely carries no scope, and the "is this a
   * company we know?" check the UI data handlers use before returning aggregate data — the
   * bridge cannot prove a company id is real (it holds no `companies.read` capability), so it
   * can only prove it is one it has already worked for.
   */
  knownCompanies(): string[] {
    const rows = this.#prep(
      `SELECT company_id FROM provider_bindings
       UNION SELECT company_id FROM delivery_operations
       UNION SELECT company_id FROM event_inbox
       UNION SELECT company_id FROM compatibility_state`,
    ).all() as Record<string, unknown>[];
    return [...new Set(rows.map((row) => str(row["company_id"])))].filter((id) => id.length > 0).sort();
  }

  // -------------------------------------------------------------------------
  // command_log
  // -------------------------------------------------------------------------

  /**
   * Record an outbound command under its idempotency key.
   *
   * Same key + same payload returns the recorded result (docs/05 §8.2). Same key + different
   * payload is reported as a conflict instead of overwriting, because overwriting would let
   * a caller change the meaning of an already-accepted effect.
   */
  recordCommand(input: {
    companyId: string;
    commandId: string;
    idempotencyKey: string;
    payload: unknown;
  }): { row: CommandLogRow; conflict: boolean; replay: boolean } {
    const now = this.#now().toISOString();
    const payloadJson = canonicalJson(input.payload ?? {});
    const payloadHash = `sha256:${Buffer.from(payloadJson, "utf8").toString("hex")}`;
    return this.transaction(() => {
      const existing = this.#prep(
        "SELECT * FROM command_log WHERE company_id = ? AND idempotency_key = ?",
      ).get(input.companyId, input.idempotencyKey);
      if (existing) {
        const conflict = str(existing["payload_hash"]) !== payloadHash;
        return { row: mapCommand(existing), conflict, replay: !conflict };
      }
      this.#prep(
        `INSERT INTO command_log
           (company_id, command_id, idempotency_key, payload_hash, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'issued', ?, ?)`,
      ).run(input.companyId, input.commandId, input.idempotencyKey, payloadHash, now, now);
      const created = this.#prep(
        "SELECT * FROM command_log WHERE company_id = ? AND idempotency_key = ?",
      ).get(input.companyId, input.idempotencyKey);
      if (!created) {
        throw new BridgeError("BRIDGE_INTEGRITY_FAILURE", "BLOCKED_STALE_INPUT", "command log write failed", {
          idempotencyKey: input.idempotencyKey,
        });
      }
      return { row: mapCommand(created), conflict: false, replay: false };
    });
  }

  completeCommand(companyId: string, idempotencyKey: string, status: string, result: unknown): void {
    this.#prep(
      "UPDATE command_log SET status = ?, result_json = ?, updated_at = ? WHERE company_id = ? AND idempotency_key = ?",
    ).run(status, canonicalJson(result ?? null), this.#now().toISOString(), companyId, idempotencyKey);
  }

  getCommand(companyId: string, idempotencyKey: string): CommandLogRow | null {
    const row = this.#prep("SELECT * FROM command_log WHERE company_id = ? AND idempotency_key = ?").get(
      companyId,
      idempotencyKey,
    );
    return row ? mapCommand(row) : null;
  }

  // -------------------------------------------------------------------------
  // nonce_ledger
  // -------------------------------------------------------------------------

  /**
   * Record a signing nonce, reporting whether it was new.
   *
   * The ledger is on disk so a worker restart cannot re-issue a nonce inside the replay
   * window. Returning `false` means the nonce was already used and the caller must mint a
   * different one rather than sending a duplicate.
   */
  useNonce(nonce: string, issuedAtMs: number): boolean {
    return this.transaction(() => {
      const result = this.#prep("INSERT OR IGNORE INTO nonce_ledger (nonce, issued_at_ms) VALUES (?, ?)").run(
        nonce,
        issuedAtMs,
      );
      return result.changes > 0;
    });
  }

  pruneNonces(olderThanMs: number): number {
    const result = this.#prep("DELETE FROM nonce_ledger WHERE issued_at_ms < ?").run(olderThanMs);
    return Number(result.changes);
  }
}

function mapCommand(row: Record<string, unknown>): CommandLogRow {
  return {
    id: num(row["id"]),
    companyId: str(row["company_id"]),
    commandId: str(row["command_id"]),
    idempotencyKey: str(row["idempotency_key"]),
    payloadHash: str(row["payload_hash"]),
    status: str(row["status"]),
    resultJson: nullableStr(row["result_json"]),
    createdAt: str(row["created_at"]),
    updatedAt: str(row["updated_at"]),
  };
}
