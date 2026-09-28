"""SQLite connection, explicit transactions, migrations, and the writer lock.

Responsibility: everything that touches a raw connection lives here, and nothing above it
may call ``sqlite3`` directly.

Invariants:

* ``isolation_level=None``. Transactions are driven explicitly so ``BEGIN IMMEDIATE``
  takes the write lock at the start of the command rather than at the first write, and so
  a rollback cannot silently become a partial commit.
* ``transaction()`` is a real context manager. Nesting uses savepoints, so a helper that
  wants a rollback point can be called from inside a larger command transaction.
* WAL, ``foreign_keys=ON`` and a ``busy_timeout`` are set on every connection.
* The single-writer lock is *advisory*. Correctness under two processes comes from
  ``BEGIN IMMEDIATE``, the unique constraints in ``schema.sql`` and the lease CAS in
  :meth:`Database.acquire_writer`; a process that ignores the lock still cannot corrupt a
  run, it can only contend.
"""

from __future__ import annotations

import pathlib
import sqlite3
import threading
import uuid
from collections.abc import Iterable, Iterator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any

from polyforge.core import errors, hashing, ids

__all__ = [
    "WRITER_LOCK_TABLE",
    "Database",
    "WriterLease",
    "dumps",
    "loads",
]

#: The one-row advisory lock table (the "pf_writer_lock" row of the design).
WRITER_LOCK_TABLE = "wf_writer_lock"

_BOOTSTRAP = """
CREATE TABLE IF NOT EXISTS pf_schema_meta (
    schema_id   TEXT PRIMARY KEY,
    checksum    TEXT NOT NULL,
    applied_at  TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
"""


def dumps(value: Any) -> str:
    """Serialize to canonical JSON text so a stored document re-hashes identically."""
    if value is None:
        return "null"
    if isinstance(value, str):
        return hashing.canonical_json(value)
    return hashing.canonical_json(value)


def loads(text: str | None, default: Any = None) -> Any:
    if text is None or text == "":
        return default
    import json

    return json.loads(text)


@dataclass(frozen=True)
class WriterLease:
    """A held single-writer lease.

    ``fencing_token`` increases on every acquire. Anything durable that records the owner
    also records the token, so a lease that expired and was re-acquired cannot be mistaken
    for the current one.
    """

    owner: str
    epoch: int
    fencing_token: int
    acquired_at: str
    expires_at: str
    released: bool = False

    def to_wire(self) -> dict[str, Any]:
        return {
            "owner": self.owner,
            "epoch": self.epoch,
            "fencingToken": self.fencing_token,
            "acquiredAt": self.acquired_at,
            "expiresAt": self.expires_at,
        }


class Database:
    """A serialized, WAL-mode SQLite handle with explicit transaction control."""

    def __init__(
        self,
        path: str | pathlib.Path = ":memory:",
        *,
        clock: Any | None = None,
        busy_timeout_ms: int = 5_000,
    ) -> None:
        self.path = str(path)
        self._clock = clock if clock is not None else ids.SystemClock()
        self._lock = threading.RLock()
        self._depth = 0
        self._closed = False
        self._conn = sqlite3.connect(
            self.path,
            isolation_level=None,
            check_same_thread=False,
            timeout=busy_timeout_ms / 1000.0,
        )
        self._conn.row_factory = sqlite3.Row
        self._configure(busy_timeout_ms)

    # -- lifecycle ---------------------------------------------------------

    def _configure(self, busy_timeout_ms: int) -> None:
        cur = self._conn
        # WAL keeps readers from blocking the single writer; a memory database reports
        # "memory" for journal_mode and that is fine.
        cur.execute("PRAGMA journal_mode=WAL")
        cur.execute("PRAGMA foreign_keys=ON")
        cur.execute(f"PRAGMA busy_timeout={int(busy_timeout_ms)}")
        cur.execute("PRAGMA synchronous=NORMAL")

    @property
    def clock(self) -> Any:
        return self._clock

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
            self._conn.close()

    def __enter__(self) -> Database:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # -- connections and transactions --------------------------------------

    @contextmanager
    def connection(self) -> Iterator[sqlite3.Connection]:
        """Yield the live connection. The connection outlives the context."""
        with self._lock:
            if self._closed:
                raise errors.PolyForgeError(
                    errors.ErrorCode.INTERNAL, "database handle is closed"
                )
            yield self._conn

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        """Run a real transaction; nest with savepoints.

        The outermost scope issues ``BEGIN IMMEDIATE`` so the write lock is taken before
        any read decides what to write. An exception at any depth rolls the whole command
        back; the caller never has to decide whether a partial write is acceptable.
        """
        with self._lock:
            if self._closed:
                raise errors.PolyForgeError(
                    errors.ErrorCode.INTERNAL, "database handle is closed"
                )
            depth = self._depth
            savepoint = f"pf_sp_{depth}"
            if depth == 0:
                self._conn.execute("BEGIN IMMEDIATE")
            else:
                self._conn.execute(f"SAVEPOINT {savepoint}")
            self._depth += 1
            try:
                yield self._conn
            except BaseException:
                self._depth -= 1
                try:
                    if depth == 0:
                        self._conn.execute("ROLLBACK")
                    else:
                        self._conn.execute(f"ROLLBACK TO {savepoint}")
                        self._conn.execute(f"RELEASE {savepoint}")
                except sqlite3.Error:  # pragma: no cover - connection already broken
                    pass
                raise
            else:
                self._depth -= 1
                if depth == 0:
                    self._conn.execute("COMMIT")
                else:
                    self._conn.execute(f"RELEASE {savepoint}")

    @property
    def in_transaction(self) -> bool:
        return self._depth > 0

    # -- statements --------------------------------------------------------

    def execute(self, sql: str, params: Sequence[Any] | Mapping[str, Any] = ()) -> int:
        """Execute one statement and return the affected row count."""
        with self._lock:
            cur = self._conn.execute(sql, params)
            return cur.rowcount

    def executemany(self, sql: str, seq_of_params: Iterable[Sequence[Any]]) -> int:
        with self._lock:
            cur = self._conn.executemany(sql, seq_of_params)
            return cur.rowcount

    def executescript(self, sql: str) -> None:
        with self._lock:
            self._conn.executescript(sql)

    def query(self, sql: str, params: Sequence[Any] | Mapping[str, Any] = ()) -> list[dict[str, Any]]:
        with self._lock:
            cur = self._conn.execute(sql, params)
            return [dict(row) for row in cur.fetchall()]

    def query_one(
        self, sql: str, params: Sequence[Any] | Mapping[str, Any] = ()
    ) -> dict[str, Any] | None:
        with self._lock:
            cur = self._conn.execute(sql, params)
            row = cur.fetchone()
            return dict(row) if row is not None else None

    def scalar(self, sql: str, params: Sequence[Any] | Mapping[str, Any] = ()) -> Any:
        row = self.query_one(sql, params)
        if row is None:
            return None
        return next(iter(row.values()))

    # -- migrations --------------------------------------------------------

    def migrate(self, *, force: bool = False) -> dict[str, Any]:
        """Apply the Core schema idempotently.

        Returns a small report instead of a bare ``None`` so a caller can log what the
        process found: a fresh database and an up-to-date one are different states and
        conflating them hides a broken deployment.
        """
        from polyforge.core import migrations

        with self._lock:
            # ``executescript`` commits any open transaction, so bootstrap bookkeeping
            # runs outside the DDL application.
            self._conn.executescript(_BOOTSTRAP)
            steps = migrations.migration_plan()
            applied: list[str] = []
            for step in steps:
                row = self.query_one(
                    "SELECT checksum FROM pf_schema_meta WHERE schema_id = ?", (step.step_id,)
                )
                now = self._now()
                if row is not None:
                    recorded = str(row["checksum"])
                    if recorded == step.checksum:
                        continue
                    if not force:
                        raise errors.PolyForgeError(
                            errors.ErrorCode.CONTRACT_INVALID,
                            (
                                f"schema step {step.step_id!r} was recorded with checksum "
                                f"{recorded} but the packaged SQL hashes to {step.checksum}; "
                                "refusing to run a schema the data was not written with"
                            ),
                            details={
                                "stepId": step.step_id,
                                "recordedChecksum": recorded,
                                "packagedChecksum": step.checksum,
                            },
                        )
                self._conn.executescript(step.sql)
                self._conn.execute(
                    "INSERT INTO pf_schema_meta (schema_id, checksum, applied_at, created_at, updated_at)"
                    " VALUES (?, ?, ?, ?, ?)"
                    " ON CONFLICT(schema_id) DO UPDATE SET checksum = excluded.checksum,"
                    " applied_at = excluded.applied_at, updated_at = excluded.updated_at",
                    (step.step_id, step.checksum, now, now, now),
                )
                applied.append(step.step_id)
            return {
                "schemaId": steps[-1].step_id,
                "checksum": steps[-1].checksum,
                "applied": applied,
                "path": self.path,
            }

    def schema_state(self) -> list[dict[str, Any]]:
        try:
            return self.query(
                "SELECT schema_id, checksum, applied_at FROM pf_schema_meta ORDER BY schema_id"
            )
        except sqlite3.OperationalError:
            return []

    def _now(self) -> str:
        return self._clock.iso() if hasattr(self._clock, "iso") else ids.now_iso()

    # -- single writer -----------------------------------------------------

    def _ensure_writer_row(self, now: str) -> None:
        self._conn.execute(
            "INSERT OR IGNORE INTO wf_writer_lock"
            " (id, owner, epoch, fencing_token, acquired_at, expires_at, created_at, updated_at)"
            " VALUES (1, NULL, 0, 0, NULL, NULL, ?, ?)",
            (now, now),
        )

    def acquire_writer(
        self,
        owner: str | None = None,
        *,
        ttl_seconds: float = 30.0,
        lease: "WriterLease | None" = None,
    ) -> WriterLease:
        """Take or renew the single-writer lease through a compare-and-swap.

        The ``WHERE`` clause is the whole point: a takeover is admissible only when the
        previous lease expired, or the caller already owns it. A live foreign owner is
        refused rather than waited on, because a blocking wait in a command path hides a
        real split-brain.
        """
        owner = owner or f"{ids.process_tag()}"
        now = self._now()
        from datetime import timedelta

        expires_at = (ids.parse_iso(now) + timedelta(seconds=ttl_seconds)).isoformat(
            timespec="milliseconds"
        )
        expires_at = expires_at.replace("+00:00", "Z")
        with self.transaction() as conn:
            self._ensure_writer_row(now)
            # Renewal keeps the fencing token stable; a genuine takeover advances it so
            # a stale holder is detectable by comparing tokens.
            advance = 1 if lease is None else 0
            cur = conn.execute(
                "UPDATE wf_writer_lock SET owner = ?, epoch = epoch + ?, "
                "fencing_token = fencing_token + ?, acquired_at = ?, expires_at = ?, updated_at = ?"
                " WHERE id = 1 AND (owner IS NULL OR owner = ? OR expires_at IS NULL OR expires_at <= ?)",
                (owner, advance, advance, now, expires_at, now, owner, now),
            )
            if cur.rowcount != 1:
                held = conn.execute(
                    "SELECT owner, epoch, fencing_token, expires_at FROM wf_writer_lock WHERE id = 1"
                ).fetchone()
                raise errors.PolyForgeError(
                    errors.ErrorCode.RUN_BLOCKED,
                    "another writer holds the Core write lease",
                    details={
                        "owner": (held["owner"] if held else None),
                        "expiresAt": (held["expires_at"] if held else None),
                        "requestedBy": owner,
                    },
                )
            row = conn.execute(
                "SELECT owner, epoch, fencing_token, acquired_at, expires_at FROM wf_writer_lock WHERE id = 1"
            ).fetchone()
        return WriterLease(
            owner=str(row["owner"]),
            epoch=int(row["epoch"]),
            fencing_token=int(row["fencing_token"]),
            acquired_at=str(row["acquired_at"]),
            expires_at=str(row["expires_at"]),
        )

    def release_writer(self, lease: WriterLease) -> None:
        """Release only if still held; a lease that was taken over is left alone."""
        with self.transaction() as conn:
            self._ensure_writer_row(self._now())
            conn.execute(
                "UPDATE wf_writer_lock SET owner = NULL, expires_at = NULL, updated_at = ?"
                " WHERE id = 1 AND owner = ? AND fencing_token = ?",
                (self._now(), lease.owner, lease.fencing_token),
            )

    def writer_holder(self) -> dict[str, Any] | None:
        try:
            row = self.query_one(
                "SELECT owner, epoch, fencing_token, acquired_at, expires_at FROM wf_writer_lock WHERE id = 1"
            )
        except sqlite3.OperationalError:
            return None
        if row is None or row.get("owner") is None:
            return None
        return row

    @contextmanager
    def single_writer(
        self, owner: str | None = None, *, ttl_seconds: float = 30.0
    ) -> Iterator[WriterLease]:
        held = self.acquire_writer(owner, ttl_seconds=ttl_seconds)
        try:
            yield held
        finally:
            self.release_writer(held)

    # -- small shared helpers ---------------------------------------------

    def next_id(self, kind: str) -> str:
        return ids.new_id(kind)

    def touch(self, table: str, where: Mapping[str, Any], params: Sequence[Any]) -> int:
        stamp = self._now()
        assignments = "updated_at = ?" + "".join(f", {column} = ?" for column in where)
        values: list[Any] = [stamp, *params, stamp]
        return self.execute(
            f"UPDATE {table} SET {assignments} WHERE {', '.join(where)}", values
        )

    def now(self) -> str:
        return self._now()


def new_diagnostic_id() -> str:
    return f"rej_{uuid.uuid4().hex}"
