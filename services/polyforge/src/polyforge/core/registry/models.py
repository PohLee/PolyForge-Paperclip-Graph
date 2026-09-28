"""Registry records: drafts, immutable published versions, and the default pointer.

Responsibility: the data shapes the registry persists, plus their canonical ``to_dict`` /
``from_dict`` pair so a record survives a JSON round trip without losing the fields that
make it a decision record rather than a blob.

Invariants
----------
* ``GraphDraft`` is **mutable and revision-stamped**. ``revision`` is the optimistic
  concurrency token (``If-Match``); every save compares against it and bumps it. The
  validation, compile and review references a draft carries are all bound to the exact
  revision they were produced for, and a save clears them.
* ``GraphVersion`` is **immutable**. The store issues no ``UPDATE`` or ``DELETE`` against a
  version row at all — retirement lives in a separate state row — so "immutable" is a
  property of the storage strategy, not a convention somebody has to remember.
* Scope is part of every record's identity. A row belongs to exactly one
  ``{companyRef, projectRef}``; ids are never resolved across scopes.

``Scope`` is mirrored locally as a plain dict to match ``Scope`` in
``packages/protocol/src/port-types.ts``; the Core deliberately does not import a provider
type here.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping

from polyforge.core.errors import bad_request

__all__ = [
    "GraphDefaultPointer",
    "GraphDraft",
    "GraphVersion",
    "GraphVersionSummary",
    "Scope",
    "empty_definition",
    "normalize_scope",
    "scope_key",
]


def normalize_scope(scope: Any) -> dict[str, str]:
    """Validate a scope and return it as a canonical ``{companyRef, projectRef}`` dict.

    The Core never takes a company or project id from a body field it trusts; this only
    normalises the scope the transport already asserted.
    """
    if not isinstance(scope, Mapping):
        raise bad_request("scope must be an object with companyRef and projectRef", field="scope")
    company = scope.get("companyRef")
    project = scope.get("projectRef")
    for name, value in (("companyRef", company), ("projectRef", project)):
        if not isinstance(value, str) or not value.strip():
            raise bad_request(f"scope.{name} must be a non-empty string", field=f"scope.{name}")
    return {"companyRef": company, "projectRef": project}


def scope_key(scope: Any) -> str:
    """Storage key for a scope. Deterministic and safe to use inside a composite key."""
    normalized = normalize_scope(scope)
    return f"{normalized['companyRef']}\x1f{normalized['projectRef']}"


def empty_definition(graph_id: str) -> dict[str, Any]:
    """The definition a brand new draft starts from: a valid, empty graph."""
    return {
        "schemaVersion": 1,
        "graphId": graph_id,
        "name": graph_id,
        "description": "",
        "entrypoints": {},
        "nodes": {},
        "edges": [],
        "policyRefs": [],
    }


@dataclass(slots=True)
class GraphDraft:
    """A mutable, revision-stamped authoring state for one graph."""

    draft_id: str
    graph_id: str
    scope: dict[str, str]
    author: str
    revision: int
    definition: dict[str, Any]
    definition_hash: str
    base_version: int | None = None
    validation_ref: str | None = None
    validation_revision: int | None = None
    validation_ok: bool | None = None
    compile_ref: str | None = None
    compile_revision: int | None = None
    review_target_hash: str | None = None
    review_revision: int | None = None
    review_reviewer: str | None = None
    authorization_refs: list[str] = field(default_factory=list)
    created_at: str = ""
    updated_at: str = ""

    def summary(self) -> dict[str, Any]:
        """``DraftSummary`` from ``packages/protocol/src/api.ts``."""
        body: dict[str, Any] = {
            "draftId": self.draft_id,
            "graphId": self.graph_id,
            "baseVersion": self.base_version,
            "revision": self.revision,
            "author": self.author,
            "updatedAt": self.updated_at,
            "definitionHash": self.definition_hash,
        }
        if self.validation_ref is not None:
            body["validationRef"] = self.validation_ref
        if self.compile_ref is not None:
            body["compileRef"] = self.compile_ref
        return body

    def to_dict(self) -> dict[str, Any]:
        return {
            "draftId": self.draft_id,
            "graphId": self.graph_id,
            "scope": dict(self.scope),
            "author": self.author,
            "revision": self.revision,
            "definition": dict(self.definition),
            "definitionHash": self.definition_hash,
            "baseVersion": self.base_version,
            "validationRef": self.validation_ref,
            "validationRevision": self.validation_revision,
            "validationOk": self.validation_ok,
            "compileRef": self.compile_ref,
            "compileRevision": self.compile_revision,
            "reviewTargetHash": self.review_target_hash,
            "reviewRevision": self.review_revision,
            "reviewReviewer": self.review_reviewer,
            "authorizationRefs": list(self.authorization_refs),
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
        }

    @classmethod
    def from_dict(cls, body: Mapping[str, Any]) -> "GraphDraft":
        return cls(
            draft_id=str(body.get("draftId") or ""),
            graph_id=str(body.get("graphId") or ""),
            scope=normalize_scope(body.get("scope")),
            author=str(body.get("author") or ""),
            revision=int(body.get("revision") or 0),
            definition=dict(body.get("definition") or {}),
            definition_hash=str(body.get("definitionHash") or ""),
            base_version=body.get("baseVersion"),
            validation_ref=body.get("validationRef"),
            validation_revision=body.get("validationRevision"),
            validation_ok=body.get("validationOk"),
            compile_ref=body.get("compileRef"),
            compile_revision=body.get("compileRevision"),
            review_target_hash=body.get("reviewTargetHash"),
            review_revision=body.get("reviewRevision"),
            review_reviewer=body.get("reviewReviewer"),
            authorization_refs=list(body.get("authorizationRefs") or ()),
            created_at=str(body.get("createdAt") or ""),
            updated_at=str(body.get("updatedAt") or ""),
        )


@dataclass(frozen=True, slots=True)
class GraphVersion:
    """A published, immutable graph version."""

    graph_id: str
    version: int
    scope: dict[str, str]
    definition: dict[str, Any]
    definition_hash: str
    compiler_version: str
    plan_hash: str
    dependency_lock_hash: str
    closure: dict[str, str]
    draft_id: str
    published_by: str
    published_at: str
    schema_version: int = 1
    review_target_hash: str = ""
    authorization_refs: tuple[str, ...] = ()

    def summary(self, *, retired: bool = False) -> dict[str, Any]:
        """``GraphVersionSummary`` from ``packages/protocol/src/api.ts``."""
        return {
            "graphId": self.graph_id,
            "version": self.version,
            "definitionHash": self.definition_hash,
            "compilerVersion": self.compiler_version,
            "planHash": self.plan_hash,
            "dependencyLockHash": self.dependency_lock_hash,
            "publishedBy": self.published_by,
            "publishedAt": self.published_at,
            "retired": bool(retired),
        }

    def to_dict(self) -> dict[str, Any]:
        return {
            "graphId": self.graph_id,
            "version": self.version,
            "scope": dict(self.scope),
            "definition": dict(self.definition),
            "definitionHash": self.definition_hash,
            "compilerVersion": self.compiler_version,
            "planHash": self.plan_hash,
            "dependencyLockHash": self.dependency_lock_hash,
            "closure": dict(self.closure),
            "draftId": self.draft_id,
            "publishedBy": self.published_by,
            "publishedAt": self.published_at,
            "schemaVersion": self.schema_version,
            "reviewTargetHash": self.review_target_hash,
            "authorizationRefs": list(self.authorization_refs),
        }

    @classmethod
    def from_dict(cls, body: Mapping[str, Any]) -> "GraphVersion":
        return cls(
            graph_id=str(body.get("graphId") or ""),
            version=int(body.get("version") or 0),
            scope=normalize_scope(body.get("scope")),
            definition=dict(body.get("definition") or {}),
            definition_hash=str(body.get("definitionHash") or ""),
            compiler_version=str(body.get("compilerVersion") or ""),
            plan_hash=str(body.get("planHash") or ""),
            dependency_lock_hash=str(body.get("dependencyLockHash") or ""),
            closure=dict(body.get("closure") or {}),
            draft_id=str(body.get("draftId") or ""),
            published_by=str(body.get("publishedBy") or ""),
            published_at=str(body.get("publishedAt") or ""),
            schema_version=int(body.get("schemaVersion") or 1),
            review_target_hash=str(body.get("reviewTargetHash") or ""),
            authorization_refs=tuple(str(item) for item in body.get("authorizationRefs") or ()),
        )


@dataclass(slots=True)
class GraphDefaultPointer:
    """Which version new admissions in one scope get by default.

    Independent of publication: activating a version affects future admission only and
    never rewrites the pins of a run that already exists (REQ-GRAPH-06).
    """

    graph_id: str
    scope: dict[str, str]
    version: int
    generation: int
    activated_by: str
    activated_at: str
    previous_version: int | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "graphId": self.graph_id,
            "scope": dict(self.scope),
            "version": self.version,
            "generation": self.generation,
            "activatedBy": self.activated_by,
            "activatedAt": self.activated_at,
            "previousVersion": self.previous_version,
        }

    @classmethod
    def from_dict(cls, body: Mapping[str, Any]) -> "GraphDefaultPointer":
        return cls(
            graph_id=str(body.get("graphId") or ""),
            scope=normalize_scope(body.get("scope")),
            version=int(body.get("version") or 0),
            generation=int(body.get("generation") or 0),
            activated_by=str(body.get("activatedBy") or ""),
            activated_at=str(body.get("activatedAt") or ""),
            previous_version=body.get("previousVersion"),
        )


@dataclass(frozen=True, slots=True)
class GraphVersionSummary:
    """List projection of a published version.

    Mirrors ``GraphVersionSummary`` in ``packages/protocol/src/api.ts``. Retirement is a
    separate flag from the version row, so the summary can say "retired" while the version
    itself is still fully readable.
    """

    graph_id: str
    version: int
    definition_hash: str
    compiler_version: str
    plan_hash: str
    dependency_lock_hash: str
    published_by: str
    published_at: str
    retired: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "graphId": self.graph_id,
            "version": self.version,
            "definitionHash": self.definition_hash,
            "compilerVersion": self.compiler_version,
            "planHash": self.plan_hash,
            "dependencyLockHash": self.dependency_lock_hash,
            "publishedBy": self.published_by,
            "publishedAt": self.published_at,
            "retired": self.retired,
        }

    @classmethod
    def from_dict(cls, body: Mapping[str, Any]) -> "GraphVersionSummary":
        return cls(
            graph_id=str(body.get("graphId") or ""),
            version=int(body.get("version") or 0),
            definition_hash=str(body.get("definitionHash") or ""),
            compiler_version=str(body.get("compilerVersion") or ""),
            plan_hash=str(body.get("planHash") or ""),
            dependency_lock_hash=str(body.get("dependencyLockHash") or ""),
            published_by=str(body.get("publishedBy") or ""),
            published_at=str(body.get("publishedAt") or ""),
            retired=bool(body.get("retired")),
        )
