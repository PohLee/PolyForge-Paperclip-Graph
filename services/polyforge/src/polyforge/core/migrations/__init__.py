"""Additive Core schema migrations.

Responsibility: describe the ordered set of schema steps the Core applies to a fresh or
existing database, and the checksum bookkeeping that makes applying them idempotent.

Invariants:

* A step is append-only. Once ``pf_schema_meta`` records a step id, that step's SQL is
  never edited: a mismatch between the recorded checksum and the on-disk SQL means the
  file was rewritten rather than extended, and the Core refuses to start instead of
  silently running a different schema than the one the data was written with.
* An empty list of steps for an already-applied schema is a no-op, not an error, so
  ``migrate()`` can be called on every process start.
* Migrations never drop or rewrite engineering facts. The Runtime reads and writes
  canonical state that a rollback of the *code* must still be able to explain.
"""

from __future__ import annotations

import pathlib
from dataclasses import dataclass

from polyforge.core import hashing

__all__ = [
    "SCHEMA_ID",
    "SCHEMA_PATH",
    "MigrationStep",
    "applied_steps",
    "current_step",
    "migration_plan",
    "schema_checksum",
    "schema_sql",
]

#: Identifier recorded in ``pf_schema_meta``. Bump only when the SQL changes.
#:
#: ``pf.core/2`` is this file without the ``graph_drafts`` / ``graph_versions`` /
#: ``graph_defaults`` tables. The id is bumped instead of editing ``pf.core/1``'s SQL because
#: a step that has been applied is never rewritten: a database that recorded ``pf.core/1``
#: keeps that record, applies the new step's ``CREATE TABLE IF NOT EXISTS`` statements on top,
#: and is left holding the three now-unreferenced tables. Dropping them is left to an operator
#: because a migration must never destroy rows, and the point of the change is that no row of
#: engineering value can be in them.
SCHEMA_ID = "pf.core/2"

#: The schema ships as a real file, loaded through pathlib, so an operator can diff it.
SCHEMA_PATH = pathlib.Path(__file__).resolve().parent.parent / "store" / "schema.sql"


@dataclass(frozen=True)
class MigrationStep:
    """One idempotent schema step."""

    step_id: str
    sql: str
    description: str

    @property
    def checksum(self) -> str:
        return hashing.digest_text(self.sql)


def schema_sql() -> str:
    """Return the current DDL text."""
    return SCHEMA_PATH.read_text(encoding="utf-8")


def schema_checksum() -> str:
    """Return the digest of the current DDL text."""
    return hashing.digest_text(schema_sql())


def migration_plan() -> tuple[MigrationStep, ...]:
    """Return the ordered steps this Core version knows how to apply."""
    return (
        MigrationStep(
            step_id=SCHEMA_ID,
            sql=schema_sql(),
            description="Core durable store: execution spine, outputs, governance, ledger",
        ),
    )


def current_step() -> MigrationStep:
    return migration_plan()[-1]


def applied_steps(db) -> list[str]:
    """Return the step ids already recorded for ``db``.

    The caller owns the connection lifecycle; this only reads bookkeeping.
    """
    rows = db.query("SELECT step_id FROM pf_schema_meta ORDER BY step_id")
    return [str(row["step_id"]) for row in rows]
