"""Registry persistence: drafts, immutable versions, and the default-version pointer.

Responsibility: the storage semantics of ``docs/01-REQUIREMENTS.md`` REQ-GRAPH-02/03/06
and REQ-GRAPH-07 — draft concurrency, publish-time compare-and-swap, immutability, and an
activation path that cannot touch a running job.

Invariants
----------
* **Scope rule.** Reads and writes disagree on purpose, and the rule is fixed:

  - a *read* of a row that exists in another scope is refused with ``403 SCOPE_VIOLATION``;
    it is never turned into a 404, because answering "not found" to an id the caller
    already holds would be a lie and answering "found" would be a leak, so the only
    honest answer is "not yours";
  - a *write* whose target id lives in another scope (or does not exist) is reported as
    ``404 NOT_FOUND``, so a write cannot be used as an existence oracle;
  - *list* operations filter by scope and return an empty list, which leaks nothing.

  Every method takes an optional ``scope``. When supplied it is enforced with the rule
  above; when omitted the call is a trusted internal read/write (the store calls itself
  that way after a lookup it already authorised). A request-scoped caller **must** pass the
  transport-asserted scope — the Core never infers it from a body field.
* **Draft concurrency.** ``save_draft`` is compare-and-swap on ``expected_revision``. A
  stale revision is ``409 VERSION_CONFLICT`` carrying the current revision, and the write
  is not applied.
* **Editing invalidates.** Saving a draft clears its validation, compile and review
  references, because they described the previous revision. The publish path re-checks the
  whole chain, so a "validated then modified" draft cannot ship.
* **Versions are insert-only.** No statement in this module updates or deletes a row of the
  version table. Retirement and activation live in separate tables, so a version a run, an
  approval or an audit record references stays readable forever.
* **Activation is independent.** It is its own compare-and-swap on a generation counter
  with its own audit row, and it changes what *future* admissions get. It never reads or
  writes a run, so an existing run keeps the pins it was created with.
* **Database seam.** ``polyforge.core.store.db.Database`` is imported lazily, so the
  registry is importable and testable before the storage layer lands, and SQL is issued
  through :class:`_Sql`, which accepts the Core ``Database``, a bare ``sqlite3``
  connection, or a cursor-returning ``execute``. Nothing else in the module touches the
  database object. This is the single place to adjust if that API changes again.
"""

from __future__ import annotations

import json
import sqlite3
from typing import Any, Final, Mapping, Sequence

from polyforge import COMPILER_VERSION, SCHEMA_VERSION
from polyforge.core import hashing
from polyforge.core.compiler.compile import CompileArtifact
from polyforge.core.compiler.diff import SemanticDiff, semantic_diff
from polyforge.core.compiler.validate import ValidationReport, definition_hash
from polyforge.core.errors import (
    ErrorCode,
    PolyForgeError,
    bad_request,
    contract_invalid,
    not_found,
    scope_violation,
    version_conflict,
)
from polyforge.core.ids import SystemClock, new_id
from polyforge.core.registry.models import (
    GraphDefaultPointer,
    GraphDraft,
    GraphVersion,
    empty_definition,
    normalize_scope,
    scope_key,
)

__all__ = ["REQUIRED_TABLES", "RegistryStore"]

VALIDATION_DOMAIN: Final[str] = "pf.validation"
COMPILE_DOMAIN: Final[str] = "pf.compile"

#: Tables this module owns. They are created on demand, so an in-memory database needs no
#: migration step to exercise the whole registry test suite.
REQUIRED_TABLES: Final[tuple[str, ...]] = (
    "pf_registry_draft",
    "pf_registry_validation",
    "pf_registry_compile",
    "pf_registry_version",
    "pf_registry_version_state",
    "pf_registry_default_pointer",
    "pf_registry_audit",
)

_SCHEMA: Final[tuple[str, ...]] = (
    """
    CREATE TABLE IF NOT EXISTS pf_registry_draft (
        scope_key TEXT NOT NULL,
        draft_id TEXT NOT NULL,
        graph_id TEXT NOT NULL,
        author TEXT NOT NULL,
        revision INTEGER NOT NULL,
        base_version INTEGER,
        definition_json TEXT NOT NULL,
        definition_hash TEXT NOT NULL,
        validation_ref TEXT,
        validation_revision INTEGER,
        validation_ok INTEGER,
        compile_ref TEXT,
        compile_revision INTEGER,
        review_target_hash TEXT,
        review_revision INTEGER,
        review_reviewer TEXT,
        authorization_refs_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (scope_key, draft_id)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS pf_registry_validation (
        draft_id TEXT PRIMARY KEY,
        ref TEXT NOT NULL,
        revision INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        at TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS pf_registry_compile (
        draft_id TEXT PRIMARY KEY,
        ref TEXT NOT NULL,
        revision INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        at TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS pf_registry_version (
        scope_key TEXT NOT NULL,
        graph_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        definition_json TEXT NOT NULL,
        definition_hash TEXT NOT NULL,
        compiler_version TEXT NOT NULL,
        plan_hash TEXT NOT NULL,
        dependency_lock_hash TEXT NOT NULL,
        closure_json TEXT NOT NULL,
        draft_id TEXT NOT NULL,
        published_by TEXT NOT NULL,
        published_at TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        review_target_hash TEXT NOT NULL,
        authorization_refs_json TEXT NOT NULL,
        PRIMARY KEY (scope_key, graph_id, version)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS pf_registry_version_state (
        scope_key TEXT NOT NULL,
        graph_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        retired INTEGER NOT NULL DEFAULT 0,
        retired_at TEXT,
        retired_by TEXT,
        PRIMARY KEY (scope_key, graph_id, version)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS pf_registry_default_pointer (
        scope_key TEXT NOT NULL,
        graph_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        generation INTEGER NOT NULL,
        activated_by TEXT NOT NULL,
        activated_at TEXT NOT NULL,
        previous_version INTEGER,
        PRIMARY KEY (scope_key, graph_id)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS pf_registry_audit (
        scope_key TEXT NOT NULL,
        seq INTEGER NOT NULL,
        kind TEXT NOT NULL,
        graph_id TEXT NOT NULL,
        version INTEGER,
        generation INTEGER,
        actor TEXT NOT NULL,
        at TEXT NOT NULL,
        detail_json TEXT NOT NULL,
        PRIMARY KEY (scope_key, seq)
    )
    """,
)


class _Sql:
    """Adapter over whatever database object the caller injected.

    Three shapes are accepted, probed once in this order, so the registry keeps working
    whichever one it is handed:

    1. the Core storage layer's ``Database`` — anything with ``query``/``query_one``. It
       drives its own transactions, so this adapter never commits on its behalf.
    2. a bare ``sqlite3.Connection`` exposed as ``.connection`` (or handed in directly).
    3. a cursor-returning ``execute``/``commit`` pair.

    Rows are read by column name throughout, which works for ``sqlite3.Row`` and for the
    ``dict`` rows shape 1 returns.
    """

    __slots__ = ("_db", "_conn", "_mode")

    def __init__(self, db: Any) -> None:
        self._db = db
        if hasattr(db, "query_one") and hasattr(db, "query"):
            self._mode = "query"
            self._conn = None
            return
        connection = db if isinstance(db, sqlite3.Connection) else getattr(db, "connection", None)
        if isinstance(connection, sqlite3.Connection):
            self._mode = "connection"
            self._conn = connection
            return
        if hasattr(db, "execute"):
            self._mode = "cursor"
            self._conn = None
            return
        raise PolyForgeError(
            ErrorCode.UNSUPPORTED,
            "registry store needs a database exposing query/query_one, a sqlite3 connection, or execute()",
            details={"type": type(db).__name__},
        )

    def query(self, sql: str, params: Sequence[Any] = ()) -> list[Any]:
        if self._mode == "query":
            return list(self._db.query(sql, tuple(params)))
        if self._mode == "connection":
            return list(self._conn.execute(sql, tuple(params)).fetchall())
        return list(self._db.execute(sql, tuple(params)).fetchall())

    def query_one(self, sql: str, params: Sequence[Any] = ()) -> Any | None:
        if self._mode == "query":
            return self._db.query_one(sql, tuple(params))
        rows = self.query(sql, params)
        return rows[0] if rows else None

    def run(self, sql: str, params: Sequence[Any] = ()) -> None:
        if self._mode == "query":
            self._db.execute(sql, tuple(params))
            return
        if self._mode == "connection":
            self._conn.execute(sql, tuple(params))
            return
        self._db.execute(sql, tuple(params))

    def commit(self) -> None:
        # Shape 1 owns its transaction discipline (autocommit or an explicit
        # ``transaction()`` scope the caller opened), so there is nothing to commit here.
        if self._mode == "connection":
            self._conn.commit()
            return
        if self._mode == "cursor":
            committer = getattr(self._db, "commit", None)
            if callable(committer):
                committer()


def _load_database_cls() -> Any:
    """Import the storage layer's ``Database`` on demand.

    Raising ``UNSUPPORTED`` rather than ``ImportError`` keeps the failure inside the error
    contract the HTTP layer already handles.
    """
    try:
        from polyforge.core.store.db import Database  # type: ignore[import-not-found]
    except Exception as exc:  # pragma: no cover - depends on the storage layer landing
        raise PolyForgeError(
            ErrorCode.UNSUPPORTED,
            "the registry store requires polyforge.core.store.db.Database",
            details={"module": "polyforge.core.store.db", "reason": type(exc).__name__},
        ) from exc
    return Database


def _json(value: Any) -> str:
    return hashing.canonical_json(value)


def _unjson(value: Any, default: Any) -> Any:
    if not value:
        return default
    return json.loads(value)


def _value(row: Any, key: str) -> Any:
    if row is None:
        return None
    try:
        return row[key]
    except (KeyError, IndexError, TypeError):
        return None


def _text(row: Any, key: str) -> str:
    value = _value(row, key)
    return "" if value is None else str(value)


def _maybe_text(row: Any, key: str) -> str | None:
    value = _value(row, key)
    return None if value is None else str(value)


def _maybe_int(row: Any, key: str) -> int | None:
    value = _value(row, key)
    return None if value is None else int(value)


def _scope_from_key(key: str) -> dict[str, str]:
    company, _, project = key.partition("\x1f")
    return {"companyRef": company, "projectRef": project}


def _has_permission_gate(definition: Mapping[str, Any]) -> bool:
    nodes = definition.get("nodes")
    if not isinstance(nodes, Mapping):
        return False
    return any(
        isinstance(node, Mapping) and node.get("permissionGate") is not None for node in nodes.values()
    )


def _optional_key(scope: Any) -> str | None:
    """``None`` means a trusted unscoped access; see the module docstring."""
    return None if scope is None else scope_key(scope)


class RegistryStore:
    """Draft / version / pointer storage over one database."""

    def __init__(self, db: Any = None, *, clock: Any | None = None) -> None:
        if db is None:
            db = _load_database_cls()(":memory:")
        self._sql = _Sql(db)
        self._clock = clock or SystemClock()
        self._ensure_schema()

    # ---------------------------------------------------------------- plumbing

    def _now(self) -> str:
        return self._clock.iso()

    def _ensure_schema(self) -> None:
        for statement in _SCHEMA:
            self._sql.run(statement)
        self._sql.commit()

    def _row(self, sql: str, params: Sequence[Any] = ()) -> Any | None:
        rows = self._sql.query(sql, params)
        return rows[0] if rows else None

    def _audit(
        self,
        *,
        key: str,
        kind: str,
        graph_id: str,
        actor: str,
        detail: Mapping[str, Any],
        version: int | None = None,
        generation: int | None = None,
    ) -> None:
        highest = _value(
            self._sql.query_one(
                "SELECT COALESCE(MAX(seq), 0) AS seq FROM pf_registry_audit WHERE scope_key = ?", (key,)
            ),
            "seq",
        )
        seq = int(highest or 0) + 1
        self._sql.run(
            "INSERT INTO pf_registry_audit (scope_key, seq, kind, graph_id, version, generation, actor, at, detail_json)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (key, seq, kind, graph_id, version, generation, actor, self._now(), _json(dict(detail))),
        )

    # ------------------------------------------------------------------- drafts

    def create_draft(
        self,
        *,
        company_ref: str,
        project_ref: str,
        graph_id: str,
        author: str,
        base_version: int | None = None,
        definition: Mapping[str, Any] | None = None,
    ) -> GraphDraft:
        scope = normalize_scope({"companyRef": company_ref, "projectRef": project_ref})
        key = scope_key(scope)
        if not isinstance(graph_id, str) or not graph_id.strip():
            raise bad_request("graph_id is required", field="graph_id")
        if not isinstance(author, str) or not author.strip():
            raise bad_request("author is required", field="author")
        if base_version is not None:
            if isinstance(base_version, bool) or not isinstance(base_version, int):
                raise bad_request("base_version must be an integer", field="base_version")
            self._require_version(key, graph_id, int(base_version))
        body = dict(definition) if definition is not None else empty_definition(graph_id)

        now = self._now()
        draft = GraphDraft(
            draft_id=new_id("draft"),
            graph_id=graph_id,
            scope=scope,
            author=author,
            revision=1,
            definition=body,
            definition_hash=definition_hash(body),
            base_version=base_version,
            authorization_refs=[],
            created_at=now,
            updated_at=now,
        )
        self._sql.run(
            "INSERT INTO pf_registry_draft (scope_key, draft_id, graph_id, author, revision, base_version,"
            " definition_json, definition_hash, authorization_refs_json, created_at, updated_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                key,
                draft.draft_id,
                draft.graph_id,
                draft.author,
                draft.revision,
                draft.base_version,
                _json(draft.definition),
                draft.definition_hash,
                _json([]),
                now,
                now,
            ),
        )
        self._sql.commit()
        return draft

    def get_draft(self, draft_id: str, *, scope: Any = None) -> GraphDraft:
        key = _optional_key(scope)
        row = self._row("SELECT * FROM pf_registry_draft WHERE draft_id = ?", (draft_id,))
        if row is None:
            raise not_found("draft does not exist", draftId=draft_id)
        if key is not None and _text(row, "scope_key") != key:
            raise scope_violation("draft belongs to another scope", draftId=draft_id)
        return self._draft_from_row(row)

    def list_drafts(self, graph_id: str, *, scope: Any = None) -> list[GraphDraft]:
        key = _optional_key(scope)
        if key is None:
            rows = self._sql.query(
                "SELECT * FROM pf_registry_draft WHERE graph_id = ? ORDER BY created_at, draft_id", (graph_id,)
            )
        else:
            rows = self._sql.query(
                "SELECT * FROM pf_registry_draft WHERE scope_key = ? AND graph_id = ?"
                " ORDER BY created_at, draft_id",
                (key, graph_id),
            )
        return [self._draft_from_row(row) for row in rows]

    def save_draft(
        self,
        draft_id: str,
        *,
        definition: Mapping[str, Any],
        author: str,
        expected_revision: int,
        scope: Any = None,
    ) -> GraphDraft:
        """Compare-and-swap the definition, then invalidate everything derived from it."""
        key = _optional_key(scope)
        row = self._row("SELECT * FROM pf_registry_draft WHERE draft_id = ?", (draft_id,))
        if row is None or (key is not None and _text(row, "scope_key") != key):
            raise not_found("draft does not exist", draftId=draft_id)
        row_key = _text(row, "scope_key")
        current = int(_text(row, "revision"))
        if isinstance(expected_revision, bool) or int(expected_revision) != current:
            raise version_conflict(
                "draft revision is stale; reload before saving",
                current,
                draftId=draft_id,
                expectedRevision=int(expected_revision),
            )
        if not isinstance(definition, Mapping):
            raise bad_request("definition must be an object", field="definition")
        body = dict(definition)
        graph_id = _text(row, "graph_id")
        if body.get("graphId") != graph_id:
            raise contract_invalid(
                "a draft may not change its graphId",
                draftId=draft_id,
                expected=graph_id,
                received=body.get("graphId"),
            )
        self._sql.run(
            "UPDATE pf_registry_draft SET revision = ?, definition_json = ?, definition_hash = ?,"
            " author = ?, updated_at = ?, validation_ref = NULL, validation_revision = NULL,"
            " validation_ok = NULL, compile_ref = NULL, compile_revision = NULL, review_target_hash = NULL,"
            " review_revision = NULL, review_reviewer = NULL, authorization_refs_json = ?"
            " WHERE scope_key = ? AND draft_id = ? AND revision = ?",
            (
                current + 1,
                _json(body),
                definition_hash(body),
                author,
                self._now(),
                _json([]),
                row_key,
                draft_id,
                current,
            ),
        )
        self._sql.commit()
        return self.get_draft(draft_id, scope=scope)

    def delete_draft(self, draft_id: str, *, scope: Any = None) -> None:
        """Delete a draft. Refused once a published version was produced from it."""
        row = self._require_draft_for_write(draft_id, scope)
        key = _text(row, "scope_key")
        produced = _value(
            self._sql.query_one(
                "SELECT COUNT(*) AS hits FROM pf_registry_version WHERE scope_key = ? AND draft_id = ?",
                (key, draft_id),
            ),
            "hits",
        )
        if int(produced or 0) > 0:
            raise contract_invalid(
                "a draft that produced a published version is part of the audit trail and cannot be deleted",
                draftId=draft_id,
            )
        self._sql.run(
            "DELETE FROM pf_registry_draft WHERE scope_key = ? AND draft_id = ?", (key, draft_id)
        )
        self._sql.commit()

    def record_validation(
        self,
        draft_id: str,
        report: ValidationReport | Mapping[str, Any],
        *,
        scope: Any = None,
    ) -> GraphDraft:
        """Bind a validation report to the draft's *current* revision.

        A report for another revision or another definition hash is refused: publishing
        either would be the "validated then modified" hole.
        """
        row = self._require_draft_for_write(draft_id, scope)
        key = _text(row, "scope_key")
        payload = report.to_dict() if isinstance(report, ValidationReport) else dict(report)
        revision = int(_text(row, "revision"))
        if payload.get("revision") is not None and int(payload["revision"]) != revision:
            raise version_conflict(
                "validation report is bound to a different draft revision",
                revision,
                draftId=draft_id,
                reportRevision=int(payload["revision"]),
            )
        digest = str(payload.get("definitionHash") or "")
        if digest and digest != _text(row, "definition_hash"):
            raise version_conflict(
                "validation report was produced for a different definition",
                revision,
                draftId=draft_id,
            )
        ok = bool(payload.get("ok"))
        ref = hashing.hash_domain(
            VALIDATION_DOMAIN,
            {"draftId": draft_id, "revision": revision, "definitionHash": digest, "ok": ok},
        )
        self._sql.run(
            "INSERT OR REPLACE INTO pf_registry_validation (draft_id, ref, revision, payload_json, at)"
            " VALUES (?, ?, ?, ?, ?)",
            (draft_id, ref, revision, _json(payload), self._now()),
        )
        self._sql.run(
            "UPDATE pf_registry_draft SET validation_ref = ?, validation_revision = ?, validation_ok = ?,"
            " updated_at = ? WHERE scope_key = ? AND draft_id = ?",
            (ref, revision, 1 if ok else 0, self._now(), key, draft_id),
        )
        self._sql.commit()
        return self.get_draft(draft_id, scope=scope)

    def record_compile(
        self,
        draft_id: str,
        artifact: CompileArtifact | Mapping[str, Any],
        *,
        scope: Any = None,
    ) -> GraphDraft:
        """Bind a compile artifact to the draft's current revision."""
        row = self._require_draft_for_write(draft_id, scope)
        key = _text(row, "scope_key")
        payload = artifact.to_dict() if isinstance(artifact, CompileArtifact) else dict(artifact)
        revision = int(_text(row, "revision"))
        if payload.get("revision") is not None and int(payload["revision"]) != revision:
            raise version_conflict(
                "compile artifact is bound to a different draft revision",
                revision,
                draftId=draft_id,
                artifactRevision=int(payload["revision"]),
            )
        digest = str(payload.get("definitionHash") or "")
        if digest and digest != _text(row, "definition_hash"):
            raise version_conflict(
                "compile artifact was produced for a different definition",
                revision,
                draftId=draft_id,
            )
        ref = hashing.hash_domain(
            COMPILE_DOMAIN,
            {
                "draftId": draft_id,
                "revision": revision,
                "definitionHash": digest,
                "planHash": payload.get("planHash"),
                "compilerVersion": payload.get("compilerVersion"),
            },
        )
        self._sql.run(
            "INSERT OR REPLACE INTO pf_registry_compile (draft_id, ref, revision, payload_json, at)"
            " VALUES (?, ?, ?, ?, ?)",
            (draft_id, ref, revision, _json(payload), self._now()),
        )
        self._sql.run(
            "UPDATE pf_registry_draft SET compile_ref = ?, compile_revision = ?, updated_at = ?"
            " WHERE scope_key = ? AND draft_id = ?",
            (ref, revision, self._now(), key, draft_id),
        )
        self._sql.commit()
        return self.get_draft(draft_id, scope=scope)

    def record_review(
        self,
        draft_id: str,
        *,
        review_target_hash: str,
        reviewer: str,
        scope: Any = None,
        authorization_refs: Sequence[str] = (),
    ) -> GraphDraft:
        """Bind a human review of one exact target hash to the current revision."""
        row = self._require_draft_for_write(draft_id, scope)
        key = _text(row, "scope_key")
        revision = int(_text(row, "revision"))
        if not isinstance(review_target_hash, str) or not review_target_hash:
            raise bad_request("review_target_hash is required", field="review_target_hash")
        self._sql.run(
            "UPDATE pf_registry_draft SET review_target_hash = ?, review_revision = ?, review_reviewer = ?,"
            " authorization_refs_json = ?, updated_at = ? WHERE scope_key = ? AND draft_id = ?",
            (
                review_target_hash,
                revision,
                reviewer,
                _json([str(item) for item in authorization_refs]),
                self._now(),
                key,
                draft_id,
            ),
        )
        self._audit(
            key=key,
            kind="draft.reviewed",
            graph_id=_text(row, "graph_id"),
            actor=reviewer,
            detail={
                "draftId": draft_id,
                "revision": revision,
                "reviewTargetHash": review_target_hash,
            },
        )
        self._sql.commit()
        return self.get_draft(draft_id, scope=scope)

    def get_validation(self, draft_id: str) -> dict[str, Any]:
        return dict(_unjson(self._payload("pf_registry_validation", draft_id), {}))

    def get_compile(self, draft_id: str) -> dict[str, Any]:
        return dict(_unjson(self._payload("pf_registry_compile", draft_id), {}))

    def _payload(self, table: str, draft_id: str) -> Any:
        # ``table`` comes from the two literals above and is never caller supplied.
        return _value(
            self._sql.query_one(f"SELECT payload_json FROM {table} WHERE draft_id = ?", (draft_id,)),
            "payload_json",
        )

    # ----------------------------------------------------------------- versions

    def publish_version(
        self,
        *,
        scope: Any,
        graph_id: str,
        draft_id: str,
        author: str,
        review_target_hash: str,
        authorization_refs: Sequence[str] = (),
        expected_revision: int | None = None,
        expected_definition_hash: str | None = None,
        expected_plan_hash: str | None = None,
        expected_compiler_version: str | None = None,
    ) -> GraphVersion:
        """Publish an immutable version from a draft.

        Compare-and-swap over the whole chain that has to describe one and the same
        revision: draft revision, definition hash, compiler version, plan hash and reviewed
        target hash. Any mismatch refuses the publish.
        """
        normalized = normalize_scope(scope)
        key = scope_key(normalized)
        row = self._require_draft_for_write(draft_id, normalized)
        if _text(row, "graph_id") != graph_id:
            raise not_found("draft does not exist for this graph", draftId=draft_id, graphId=graph_id)

        revision = int(_text(row, "revision"))
        digest = _text(row, "definition_hash")

        if expected_revision is not None and int(expected_revision) != revision:
            raise version_conflict(
                "draft revision moved since the publish was requested", revision, draftId=draft_id
            )
        if expected_definition_hash is not None and expected_definition_hash != digest:
            raise version_conflict(
                "definition hash changed since the publish was requested", revision, draftId=draft_id
            )

        if _maybe_int(row, "validation_revision") != revision:
            raise version_conflict(
                "the draft has no validation for its current revision; editing invalidated the earlier one",
                revision,
                draftId=draft_id,
            )
        if not int(_text(row, "validation_ok") or 0):
            raise contract_invalid(
                "the draft's current revision did not validate", draftId=draft_id, revision=revision
            )
        if _maybe_int(row, "compile_revision") != revision:
            raise version_conflict(
                "the draft has no compile artifact for its current revision", revision, draftId=draft_id
            )

        artifact = self.get_compile(draft_id)
        if str(artifact.get("definitionHash") or "") != digest:
            raise version_conflict(
                "the recorded compile artifact is for a different definition", revision, draftId=draft_id
            )
        compiler_version = str(artifact.get("compilerVersion") or "")
        if compiler_version != COMPILER_VERSION:
            raise contract_invalid(
                "the recorded compile artifact was produced by a different compiler version",
                draftId=draft_id,
                recorded=compiler_version,
                expected=COMPILER_VERSION,
            )
        plan_hash = str(artifact.get("planHash") or "")
        if expected_plan_hash is not None and expected_plan_hash != plan_hash:
            raise version_conflict("plan hash changed since the publish was requested", revision, draftId=draft_id)
        if expected_compiler_version is not None and expected_compiler_version != compiler_version:
            raise version_conflict(
                "compiler version changed since the publish was requested", revision, draftId=draft_id
            )

        recorded_review = _maybe_text(row, "review_target_hash")
        if _maybe_int(row, "review_revision") != revision or not recorded_review:
            raise version_conflict(
                "publishing requires a review bound to the current revision", revision, draftId=draft_id
            )
        if review_target_hash != recorded_review:
            raise version_conflict(
                "the reviewed target hash does not match the recorded review; the draft changed after review",
                revision,
                draftId=draft_id,
                reviewed=recorded_review,
                supplied=review_target_hash,
            )

        definition = _unjson(_text(row, "definition_json"), {})
        if _has_permission_gate(definition) and not list(authorization_refs):
            raise contract_invalid(
                "this graph performs an authorized action; publishing needs the authorization references",
                draftId=draft_id,
            )

        next_version = self._next_version(key, graph_id)
        now = self._now()
        version = GraphVersion(
            graph_id=graph_id,
            version=next_version,
            scope=normalized,
            definition=definition,
            definition_hash=digest,
            compiler_version=compiler_version,
            plan_hash=plan_hash,
            dependency_lock_hash=str(artifact.get("dependencyLockHash") or ""),
            closure=dict(artifact.get("closure") or {}),
            draft_id=draft_id,
            published_by=author,
            published_at=now,
            schema_version=SCHEMA_VERSION,
            review_target_hash=review_target_hash,
            authorization_refs=tuple(str(item) for item in authorization_refs),
        )
        self._sql.run(
            "INSERT INTO pf_registry_version (scope_key, graph_id, version, definition_json, definition_hash,"
            " compiler_version, plan_hash, dependency_lock_hash, closure_json, draft_id, published_by,"
            " published_at, schema_version, review_target_hash, authorization_refs_json)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                key,
                graph_id,
                next_version,
                _json(definition),
                digest,
                compiler_version,
                plan_hash,
                version.dependency_lock_hash,
                _json(version.closure),
                draft_id,
                author,
                now,
                SCHEMA_VERSION,
                review_target_hash,
                _json(list(version.authorization_refs)),
            ),
        )
        self._sql.run(
            "INSERT OR REPLACE INTO pf_registry_version_state (scope_key, graph_id, version, retired)"
            " VALUES (?, ?, ?, 0)",
            (key, graph_id, next_version),
        )
        self._audit(
            key=key,
            kind="version.published",
            graph_id=graph_id,
            version=next_version,
            actor=author,
            detail={
                "draftId": draft_id,
                "revision": revision,
                "definitionHash": digest,
                "planHash": plan_hash,
                "reviewTargetHash": review_target_hash,
            },
        )
        self._sql.commit()
        return version

    def list_graphs(self, *, scope: Any = None) -> list[str]:
        """Every graph that has at least one published version in this scope, name-sorted.

        A graph with only drafts is not listed: the library is what can actually be run, and a
        half-authored graph appearing next to a published one invites an operator to point a
        work order at something that was never compiled. The scope is mandatory in practice — an
        unscoped call would union every tenant's graphs, which is exactly the cross-tenant read the
        scope exists to prevent.
        """
        key = _optional_key(scope)
        if key is None:
            raise bad_request(
                "listing graphs requires a company and project scope",
                field="scope",
            )
        # `_sql` is the one accessor every other read in this class goes through; it hides whether
        # the store is backed by a live connection or an injected query-only database. Reaching past
        # it for a `query`/`_db` that only exists in one of those modes is how a read that works in
        # one deployment 500s in the other.
        rows = self._sql.query(
            "SELECT DISTINCT v.graph_id AS graph_id FROM pf_registry_version v"
            " WHERE v.scope_key = ? ORDER BY v.graph_id",
            (key,),
        )
        return [str(row["graph_id"]) for row in rows]

    def list_versions(self, graph_id: str, *, scope: Any = None) -> list[GraphVersion]:
        key = _optional_key(scope)
        rows = self._version_rows(
            "SELECT v.*, s.retired AS retired FROM pf_registry_version v"
            " LEFT JOIN pf_registry_version_state s"
            " ON s.scope_key = v.scope_key AND s.graph_id = v.graph_id AND s.version = v.version"
            " WHERE {scope} v.graph_id = ? ORDER BY v.version",
            key,
            graph_id,
        )
        return [self._version_from_row(row) for row in rows]

    def get_version(self, graph_id: str, version: int, *, scope: Any = None) -> GraphVersion:
        key = _optional_key(scope)
        if key is None:
            row = self._row(
                "SELECT v.*, s.retired AS retired FROM pf_registry_version v"
                " LEFT JOIN pf_registry_version_state s"
                " ON s.scope_key = v.scope_key AND s.graph_id = v.graph_id AND s.version = v.version"
                " WHERE v.graph_id = ? AND v.version = ?",
                (graph_id, int(version)),
            )
        else:
            row = self._row(
                "SELECT v.*, s.retired AS retired FROM pf_registry_version v"
                " LEFT JOIN pf_registry_version_state s"
                " ON s.scope_key = v.scope_key AND s.graph_id = v.graph_id AND s.version = v.version"
                " WHERE v.scope_key = ? AND v.graph_id = ? AND v.version = ?",
                (key, graph_id, int(version)),
            )
        if row is None:
            raise not_found("graph version does not exist", graphId=graph_id, version=version)
        return self._version_from_row(row)

    def retire_version(
        self, graph_id: str, version: int, *, scope: Any = None, actor: str = "system"
    ) -> GraphVersion:
        """Deprecate a version. The version row itself is never touched, so it stays readable.

        A retired version may still be cited by a run, an approval or an audit record; it
        simply stops being a candidate for future default activation.

        ``scope`` is mandatory here even though it defaults to ``None``: a version number is
        only unique inside one scope, so "retire version 14" is not a well-formed request
        until the caller says whose version 14 it is.
        """
        key = _optional_key(scope)
        if key is None:
            raise bad_request(
                "retiring a version requires a scope; a version number is only unique within one",
                field="scope",
                graphId=graph_id,
                version=int(version),
            )
        self._require_version(key, graph_id, int(version))
        self._sql.run(
            "INSERT OR REPLACE INTO pf_registry_version_state (scope_key, graph_id, version, retired, retired_at, retired_by)"
            " VALUES (?, ?, ?, 1, ?, ?)",
            (key, graph_id, int(version), self._now(), actor),
        )
        self._audit(
            key=key,
            kind="version.retired",
            graph_id=graph_id,
            version=int(version),
            actor=actor,
            detail={"reason": "deprecated; remains readable for existing pins"},
        )
        self._sql.commit()
        return self.get_version(graph_id, int(version), scope=scope)

    def is_retired(self, graph_id: str, version: int, *, scope: Any = None) -> bool:
        key = _optional_key(scope)
        if key is None:
            row = self._row(
                "SELECT retired FROM pf_registry_version_state WHERE graph_id = ? AND version = ?",
                (graph_id, int(version)),
            )
        else:
            row = self._row(
                "SELECT retired FROM pf_registry_version_state WHERE scope_key = ? AND graph_id = ?"
                " AND version = ?",
                (key, graph_id, int(version)),
            )
        return bool(_value(row, "retired") or 0)

    def activate_version(
        self,
        *,
        scope: Any,
        graph_id: str,
        version: int,
        expected_generation: int,
        actor: str = "system",
    ) -> GraphDefaultPointer:
        """Point future admissions at ``version``.

        Independent compare-and-swap on its own generation counter, with its own audit row.
        It never touches a run, so an in-flight run keeps the pins it was created with.
        """
        normalized = normalize_scope(scope)
        key = scope_key(normalized)
        self._require_version(key, graph_id, int(version))
        if self.is_retired(graph_id, int(version), scope=normalized):
            raise contract_invalid(
                "a retired version cannot become the default", graphId=graph_id, version=int(version)
            )
        row = self._row(
            "SELECT generation, version FROM pf_registry_default_pointer WHERE scope_key = ? AND graph_id = ?",
            (key, graph_id),
        )
        current_generation = int(_value(row, "generation") or 0)
        if isinstance(expected_generation, bool) or int(expected_generation) != current_generation:
            raise version_conflict(
                "default pointer generation is stale; reload before activating",
                current_generation,
                graphId=graph_id,
                expectedGeneration=int(expected_generation),
            )
        previous = _maybe_int(row, "version")
        pointer = GraphDefaultPointer(
            graph_id=graph_id,
            scope=normalized,
            version=int(version),
            generation=current_generation + 1,
            activated_by=actor,
            activated_at=self._now(),
            previous_version=previous,
        )
        self._sql.run(
            "INSERT OR REPLACE INTO pf_registry_default_pointer (scope_key, graph_id, version, generation,"
            " activated_by, activated_at, previous_version) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                key,
                graph_id,
                pointer.version,
                pointer.generation,
                pointer.activated_by,
                pointer.activated_at,
                pointer.previous_version,
            ),
        )
        self._audit(
            key=key,
            kind="pointer.activated",
            graph_id=graph_id,
            version=pointer.version,
            generation=pointer.generation,
            actor=actor,
            detail={
                "previousVersion": pointer.previous_version,
                "effect": "future admission only; existing runs keep their pins",
            },
        )
        self._sql.commit()
        return pointer

    def get_default_pointer(self, *, scope: Any, graph_id: str) -> GraphDefaultPointer | None:
        key = scope_key(scope)
        row = self._row(
            "SELECT * FROM pf_registry_default_pointer WHERE scope_key = ? AND graph_id = ?",
            (key, graph_id),
        )
        if row is None:
            return None
        return GraphDefaultPointer.from_dict(
            {
                "graphId": _text(row, "graph_id"),
                "scope": _scope_from_key(key),
                "version": int(_text(row, "version")),
                "generation": int(_text(row, "generation")),
                "activatedBy": _text(row, "activated_by"),
                "activatedAt": _text(row, "activated_at"),
                "previousVersion": _maybe_int(row, "previous_version"),
            }
        )

    def get_active_version(self, *, scope: Any, graph_id: str) -> GraphVersion | None:
        pointer = self.get_default_pointer(scope=scope, graph_id=graph_id)
        if pointer is None:
            return None
        return self.get_version(graph_id, pointer.version, scope=scope)

    def semantic_diff(
        self, graph_id: str, *, from_version: int | None, to_version: int | None, scope: Any = None
    ) -> SemanticDiff:
        before = self.get_version(graph_id, from_version, scope=scope).definition if from_version is not None else None
        after = self.get_version(graph_id, to_version, scope=scope).definition if to_version is not None else None
        return semantic_diff(before, after, from_version=from_version, to_version=to_version)

    def audit_log(self, *, scope: Any, graph_id: str | None = None) -> list[dict[str, Any]]:
        key = scope_key(scope)
        if graph_id is None:
            rows = self._sql.query(
                "SELECT * FROM pf_registry_audit WHERE scope_key = ? ORDER BY seq", (key,)
            )
        else:
            rows = self._sql.query(
                "SELECT * FROM pf_registry_audit WHERE scope_key = ? AND graph_id = ? ORDER BY seq",
                (key, graph_id),
            )
        return [
            {
                "seq": int(_text(row, "seq")),
                "kind": _text(row, "kind"),
                "graphId": _text(row, "graph_id"),
                "version": _maybe_int(row, "version"),
                "generation": _maybe_int(row, "generation"),
                "actor": _text(row, "actor"),
                "at": _text(row, "at"),
                "detail": _unjson(_text(row, "detail_json"), {}),
            }
            for row in rows
        ]

    def clone_to_draft(
        self, graph_id: str, version: int, *, scope: Any, company_ref: str, project_ref: str, author: str
    ) -> GraphDraft:
        """REQ-GRAPH-07: a published version is read-only, so editing starts from a copy."""
        source = self.get_version(graph_id, int(version), scope=scope)
        return self.create_draft(
            company_ref=company_ref,
            project_ref=project_ref,
            graph_id=graph_id,
            author=author,
            base_version=int(version),
            definition=source.definition,
        )

    # ------------------------------------------------------------------ helpers

    def _version_rows(self, sql_template: str, key: str | None, graph_id: str) -> list[Any]:
        if key is None:
            return self._sql.query(sql_template.format(scope=""), (graph_id,))
        return self._sql.query(sql_template.format(scope="v.scope_key = ? AND"), (key, graph_id))

    def _require_draft_for_write(self, draft_id: str, scope: Any) -> Any:
        row = self._row("SELECT * FROM pf_registry_draft WHERE draft_id = ?", (draft_id,))
        if row is None:
            raise not_found("draft does not exist", draftId=draft_id)
        key = _optional_key(scope)
        if key is not None and _text(row, "scope_key") != key:
            raise not_found("draft does not exist", draftId=draft_id)
        return row

    def _require_version(self, key: str, graph_id: str, version: int) -> Any:
        row = self._row(
            "SELECT * FROM pf_registry_version WHERE scope_key = ? AND graph_id = ? AND version = ?",
            (key, graph_id, int(version)),
        )
        if row is None:
            raise not_found("graph version does not exist", graphId=graph_id, version=version)
        return row

    def _next_version(self, key: str, graph_id: str) -> int:
        highest = _value(
            self._sql.query_one(
                "SELECT COALESCE(MAX(version), 0) AS highest FROM pf_registry_version"
                " WHERE scope_key = ? AND graph_id = ?",
                (key, graph_id),
            ),
            "highest",
        )
        return int(highest or 0) + 1

    def _draft_from_row(self, row: Any) -> GraphDraft:
        validation_ok = _maybe_int(row, "validation_ok")
        return GraphDraft(
            draft_id=_text(row, "draft_id"),
            graph_id=_text(row, "graph_id"),
            scope=_scope_from_key(_text(row, "scope_key")),
            author=_text(row, "author"),
            revision=int(_text(row, "revision")),
            definition=dict(_unjson(_text(row, "definition_json"), {})),
            definition_hash=_text(row, "definition_hash"),
            base_version=_maybe_int(row, "base_version"),
            validation_ref=_maybe_text(row, "validation_ref"),
            validation_revision=_maybe_int(row, "validation_revision"),
            validation_ok=None if validation_ok is None else bool(validation_ok),
            compile_ref=_maybe_text(row, "compile_ref"),
            compile_revision=_maybe_int(row, "compile_revision"),
            review_target_hash=_maybe_text(row, "review_target_hash"),
            review_revision=_maybe_int(row, "review_revision"),
            review_reviewer=_maybe_text(row, "review_reviewer"),
            authorization_refs=list(_unjson(_text(row, "authorization_refs_json"), [])),
            created_at=_text(row, "created_at"),
            updated_at=_text(row, "updated_at"),
        )

    def _version_from_row(self, row: Any) -> GraphVersion:
        return GraphVersion(
            graph_id=_text(row, "graph_id"),
            version=int(_text(row, "version")),
            scope=_scope_from_key(_text(row, "scope_key")),
            definition=dict(_unjson(_text(row, "definition_json"), {})),
            definition_hash=_text(row, "definition_hash"),
            compiler_version=_text(row, "compiler_version"),
            plan_hash=_text(row, "plan_hash"),
            dependency_lock_hash=_text(row, "dependency_lock_hash"),
            closure=dict(_unjson(_text(row, "closure_json"), {})),
            draft_id=_text(row, "draft_id"),
            published_by=_text(row, "published_by"),
            published_at=_text(row, "published_at"),
            schema_version=int(_text(row, "schema_version")),
            review_target_hash=_text(row, "review_target_hash"),
            authorization_refs=tuple(str(item) for item in _unjson(_text(row, "authorization_refs_json"), [])),
        )
