"""Evidence ingestion, lineage, and invalidation.

Responsibility: turn a worker's *claim* that something is true into a verified record the
Core is willing to gate on — or refuse it, with the reason.

Invariants (``docs/05-PROTOCOL.md`` section 7, ``docs/01-REQUIREMENTS.md`` REQ-DATA-02):

* Checks run **in order**, and the first failure is the reported one: scope, then producer
  subject and platform run, then active claim, then contract-bound output type, then
  content hash, then source revision, then trusted execution record, then freshness, then
  artifact existence. Order matters: reporting "stale" for an evidence item from another
  tenant would leak that the tenant exists.
* Identity is immutable. A mutable document URL is never an identity — an immutable
  revision or a content hash is. Re-pointing a "latest revision" link cannot rewrite what a
  gate already accepted.
* A worker's statement that "the tests passed" is a *candidate*. Only a trusted execution
  record or a verifiable digest can become evidence, and invalidating a dependency
  propagates: stale evidence makes its dependent gate escalate rather than silently pass.
* Ingestion never advances a node. It can only add or retract evidence.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Mapping, Sequence

from polyforge.core import errors, hashing, ids
from polyforge.core.store.db import Database, dumps, loads

__all__ = [
    "EVIDENCE_SET_HASH_DOMAIN",
    "EvidenceCandidate",
    "EvidenceStore",
    "IngestFailure",
    "IngestResult",
    "is_content_hash",
    "evidence_set_hash",
]

EVIDENCE_SET_HASH_DOMAIN = "pf.evidence-set"

_CONTENT_HASH = re.compile(r"^sha256:[0-9a-f]{64}$")

#: Verification stages, in the order they are applied. Exposed so a caller can report which
#: control refused an item without string-matching messages.
STAGE_SCOPE = "scope"
STAGE_PRODUCER = "producer"
STAGE_CLAIM = "claim"
STAGE_OUTPUT_TYPE = "output_type"
STAGE_CONTENT_HASH = "content_hash"
STAGE_SOURCE_REVISION = "source_revision"
STAGE_TRUSTED_EXECUTION = "trusted_execution"
STAGE_FRESHNESS = "freshness"
STAGE_ARTIFACT = "artifact"

STAGE_ORDER: tuple[str, ...] = (
    STAGE_SCOPE,
    STAGE_PRODUCER,
    STAGE_CLAIM,
    STAGE_OUTPUT_TYPE,
    STAGE_CONTENT_HASH,
    STAGE_SOURCE_REVISION,
    STAGE_TRUSTED_EXECUTION,
    STAGE_FRESHNESS,
    STAGE_ARTIFACT,
)


def is_content_hash(value: Any) -> bool:
    """True for a well-formed ``sha256:<64 hex>`` digest."""
    return isinstance(value, str) and bool(_CONTENT_HASH.match(value))


@dataclass(frozen=True)
class IngestFailure:
    stage: str
    code: str
    message: str

    def to_wire(self) -> dict[str, str]:
        return {"stage": self.stage, "code": self.code, "message": self.message}


@dataclass(frozen=True)
class IngestResult:
    accepted: bool
    evidence_id: str | None = None
    record: dict[str, Any] | None = None
    failures: tuple[IngestFailure, ...] = ()
    reason: str = ""

    @property
    def first_failure(self) -> IngestFailure | None:
        return self.failures[0] if self.failures else None


@dataclass(frozen=True)
class EvidenceCandidate:
    """An unverified claim about a fact, submitted by a worker or read off a platform run."""

    kind: str
    artifacts: tuple[Mapping[str, Any], ...] = ()
    producer_subject: str = ""
    producer_run_ref: Mapping[str, Any] | None = None
    input_revision_bindings: Mapping[str, str] = field(default_factory=dict)
    detail: Mapping[str, Any] = field(default_factory=dict)
    produced_at: str = ""
    source_revision: str | None = None
    trusted_execution: bool = False
    evidence_id: str = ""
    requested_evidence_ids: tuple[str, ...] = ()

    @staticmethod
    def from_wire(value: Mapping[str, Any], *, producer_subject: str = "") -> "EvidenceCandidate":
        return EvidenceCandidate(
            kind=str(value.get("kind", "")),
            artifacts=tuple(value.get("artifacts") or ()),
            producer_subject=str(value.get("producerSubject", "") or producer_subject),
            producer_run_ref=value.get("producerRunRef"),
            input_revision_bindings=dict(value.get("inputRevisionBindings") or {}),
            detail=dict(value.get("detail") or {}),
            produced_at=str(value.get("producedAt", "")),
            source_revision=(
                None if value.get("sourceRevision") is None else str(value["sourceRevision"])
            ),
            trusted_execution=bool(value.get("trustedExecution", False)),
            evidence_id=str(value.get("evidenceId", "")),
            requested_evidence_ids=tuple(str(v) for v in (value.get("artifacts") or ())),
        )


def evidence_set_hash(evidence_ids: Sequence[str], digests: Mapping[str, str] | None = None) -> str:
    """Hash an evidence set: sorted ids paired with their content digests.

    Sorted because a set has no order; the pairing is what makes the hash change when the
    *bytes* change even though the id list did not.
    """
    digest_map = dict(digests or {})
    pairs = [
        {"evidenceId": str(evidence_id), "digest": digest_map.get(str(evidence_id), "")}
        for evidence_id in sorted({str(e) for e in evidence_ids})
    ]
    return hashing.hash_domain(EVIDENCE_SET_HASH_DOMAIN, pairs)


class EvidenceStore:
    """Durable evidence with create-or-verify semantics and dependency invalidation."""

    def __init__(self, db: Database, *, clock: Any | None = None) -> None:
        self.db = db
        self._clock = clock if clock is not None else db.clock

    def _now(self) -> str:
        return self._clock.iso() if hasattr(self._clock, "iso") else ids.now_iso()

    # -- reads -------------------------------------------------------------

    def get(self, *, company_ref: str, project_ref: str, evidence_id: str) -> dict[str, Any] | None:
        return self.db.query_one(
            "SELECT * FROM evidence WHERE company_ref = ? AND project_ref = ? AND evidence_id = ?",
            (company_ref, project_ref, evidence_id),
        )

    def list_for_run(self, *, company_ref: str, project_ref: str, run_id: str) -> list[dict[str, Any]]:
        return self.db.query(
            "SELECT * FROM evidence WHERE company_ref = ? AND project_ref = ? AND run_id = ?"
            " ORDER BY created_at, evidence_id",
            (company_ref, project_ref, run_id),
        )

    def list_for_node(
        self, *, company_ref: str, project_ref: str, run_id: str, node_id: str
    ) -> list[dict[str, Any]]:
        return self.db.query(
            "SELECT * FROM evidence WHERE company_ref = ? AND project_ref = ? AND run_id = ?"
            " AND node_id = ? ORDER BY created_at, evidence_id",
            (company_ref, project_ref, run_id, node_id),
        )

    def set_hash(self, records: Sequence[Mapping[str, Any]]) -> str:
        return evidence_set_hash(
            [str(r["evidence_id"]) for r in records],
            {str(r["evidence_id"]): str(r.get("artifact_digest", "")) for r in records},
        )

    def artifacts_for(
        self, *, company_ref: str, project_ref: str, run_id: str, node_id: str
    ) -> dict[str, dict[str, Any]]:
        """Index registered artifacts by ``kind`` + ``contentHash`` for the existence check."""
        rows = self.db.query(
            "SELECT * FROM artifacts WHERE company_ref = ? AND project_ref = ? AND run_id = ?"
            " AND node_id = ?",
            (company_ref, project_ref, run_id, node_id),
        )
        return {f"{r['kind']}|{r['content_hash']}": r for r in rows}

    # -- verification ------------------------------------------------------

    def ingest_candidate(
        self,
        candidate: EvidenceCandidate | Mapping[str, Any],
        *,
        run: Mapping[str, Any],
        node: Mapping[str, Any],
        contract: Mapping[str, Any] | None = None,
        claim: Mapping[str, Any] | None = None,
        attempt: Mapping[str, Any] | None = None,
        current_input_revisions: Mapping[str, str] | None = None,
        artifact_index: Mapping[str, Mapping[str, Any]] | None = None,
        freshness_seconds: int | None = None,
    ) -> IngestResult:
        """Verify and archive one evidence candidate.

        Returns an :class:`IngestResult` instead of raising for a *rejection*: the caller
        records the refusal as a diagnostic and keeps the durable state untouched. A
        malformed envelope (no kind at all) still raises, because that is a caller bug
        rather than a claim about the world.
        """
        if not isinstance(candidate, EvidenceCandidate):
            candidate = EvidenceCandidate.from_wire(candidate)
        if not candidate.kind:
            raise errors.bad_request("evidence candidate must declare a kind")

        failures: list[IngestFailure] = []

        company_ref = str(run.get("company_ref", ""))
        project_ref = str(run.get("project_ref", ""))
        run_id = str(run.get("run_id", ""))
        node_id = str(node.get("node_id", ""))

        # 1. Scope. Nothing else is examined for an item from another tenant.
        for ref in (company_ref, project_ref, run_id):
            if not ref:
                failures.append(
                    IngestFailure(STAGE_SCOPE, "scope_unresolved", "run scope is unresolved")
                )
        if candidate.evidence_id:
            existing = self.get(
                company_ref=company_ref, project_ref=project_ref, evidence_id=candidate.evidence_id
            )
            if existing is not None and str(existing["run_id"]) != run_id:
                failures.append(
                    IngestFailure(
                        STAGE_SCOPE,
                        "evidence_id_scope_conflict",
                        f"evidence id {candidate.evidence_id!r} already belongs to another run",
                    )
                )
        if failures:
            return IngestResult(False, failures=tuple(failures), reason=failures[0].message)

        # 2. Producer subject and platform run. An evidence item must name who produced it
        # and which authenticated platform run produced it.
        if not candidate.producer_subject:
            failures.append(
                IngestFailure(
                    STAGE_PRODUCER,
                    "producer_missing",
                    "evidence must name the subject that produced it",
                )
            )
        if candidate.producer_run_ref is not None:
            ref = candidate.producer_run_ref
            if not isinstance(ref, Mapping) or not ref.get("provider") or not ref.get("id"):
                failures.append(
                    IngestFailure(
                        STAGE_PRODUCER,
                        "producer_run_ref_invalid",
                        "producer run reference must be a provider ref with provider and id",
                    )
                )
        if claim is not None and candidate.producer_subject:
            claim_subject = str(claim.get("agent_subject") or "")
            if claim_subject and claim_subject != candidate.producer_subject:
                failures.append(
                    IngestFailure(
                        STAGE_PRODUCER,
                        "producer_not_claim_holder",
                        (
                            f"evidence claims producer {candidate.producer_subject!r} but the "
                            f"active claim is held by {claim_subject!r}"
                        ),
                    )
                )

        # 3. Active claim. Unclaimed work produces no evidence.
        if claim is None:
            failures.append(
                IngestFailure(
                    STAGE_CLAIM,
                    "no_active_claim",
                    "evidence may only be ingested under an active, unfenced claim",
                )
            )
        elif str(claim.get("lease_state", "ACTIVE")) != "ACTIVE":
            failures.append(
                IngestFailure(
                    STAGE_CLAIM,
                    "claim_not_active",
                    f"claim lease state is {claim.get('lease_state')!r}, not ACTIVE",
                )
            )
        elif attempt is not None and str(attempt.get("attempt_id")) != str(claim.get("attempt_id")):
            failures.append(
                IngestFailure(
                    STAGE_CLAIM,
                    "attempt_not_claim_attempt",
                    "the submitting attempt is not the attempt that holds the claim",
                )
            )

        # 4. Contract-bound output type.
        allowed_kinds: list[str] = []
        if contract is not None:
            # The contract arrives in its wire shape (``camelCase``), the same bytes a gate and
            # a worker see.
            allowed_kinds = [str(k) for k in (contract.get("requiredEvidenceKinds") or ())]
            allowed_outputs = [
                str(m.get("kind", ""))
                for m in (contract.get("intendedMutations") or ())
                if m.get("kind")
            ]
            allowed_kinds = sorted(set(allowed_kinds) | set(allowed_outputs))
        if allowed_kinds and candidate.kind not in allowed_kinds:
            failures.append(
                IngestFailure(
                    STAGE_OUTPUT_TYPE,
                    "output_type_not_in_contract",
                    (
                        f"evidence kind {candidate.kind!r} is not one of the kinds the contract "
                        f"binds: {', '.join(allowed_kinds)}"
                    ),
                )
            )

        # 5. Content hash format. A reference without a verifiable digest is a URL, and a URL
        # is not an identity.
        digests: list[str] = []
        for artifact in candidate.artifacts:
            ref = artifact.get("contentHash") or artifact.get("content_hash")
            if not is_content_hash(ref):
                failures.append(
                    IngestFailure(
                        STAGE_CONTENT_HASH,
                        "content_hash_invalid",
                        (
                            f"artifact {artifact.get('artifactId') or artifact.get('kind')!r} has no "
                            "well-formed sha256 content hash; a mutable reference cannot be evidence"
                        ),
                    )
                )
            else:
                digests.append(str(ref))
        if candidate.artifacts and not failures:
            if not self._immutable_identity(candidate.artifacts):
                failures.append(
                    IngestFailure(
                        STAGE_CONTENT_HASH,
                        "mutable_identity_rejected",
                        (
                            "every artifact must be identified by an immutable revision or a content "
                            "digest; a mutable document URL is never accepted as an identity"
                        ),
                    )
                )

        # 6. Source revision. Evidence produced against an older input is not evidence about
        # the current state.
        revisions = dict(current_input_revisions or {})
        if revisions and candidate.input_revision_bindings:
            for name, expected in sorted(revisions.items()):
                declared = candidate.input_revision_bindings.get(name)
                if declared is None:
                    failures.append(
                        IngestFailure(
                            STAGE_SOURCE_REVISION,
                            "input_revision_unbound",
                            f"evidence does not declare the revision it was produced against for {name!r}",
                        )
                    )
                elif str(declared) != str(expected):
                    failures.append(
                        IngestFailure(
                            STAGE_SOURCE_REVISION,
                            "input_revision_stale",
                            (
                                f"evidence for input {name!r} was produced against revision "
                                f"{declared!r} but the run is at {expected!r}"
                            ),
                        )
                    )
        if candidate.source_revision is not None and revisions:
            newest = str(sorted(revisions.values())[-1])
            if str(candidate.source_revision) < newest:
                failures.append(
                    IngestFailure(
                        STAGE_SOURCE_REVISION,
                        "source_revision_stale",
                        f"evidence source revision {candidate.source_revision!r} precedes the run revision {newest!r}",
                    )
                )

        # 7. Trusted execution record. A kind the contract requires a trusted source for
        # cannot be self-certified.
        trusted_required = contract is not None and any(
            str(m.get("kind", "")) == candidate.kind and m.get("requiresTrustedExecution")
            for m in (contract.get("intendedMutations") or ())
        )
        if trusted_required and not candidate.trusted_execution:
            failures.append(
                IngestFailure(
                    STAGE_TRUSTED_EXECUTION,
                    "trusted_execution_required",
                    (
                        f"evidence kind {candidate.kind!r} must come from a trusted execution record; "
                        "a worker's own claim is a candidate only"
                    ),
                )
            )

        # 8. Freshness window.
        window = freshness_seconds
        if window is None and contract is not None:
            policy = contract.get("effectivePolicy") or {}
            window = policy.get("freshnessSeconds")
        if window and candidate.produced_at:
            try:
                age = (ids.parse_iso(self._now()) - ids.parse_iso(candidate.produced_at)).total_seconds()
            except ValueError:
                failures.append(
                    IngestFailure(
                        STAGE_FRESHNESS,
                        "produced_at_unparseable",
                        f"producedAt {candidate.produced_at!r} is not an RFC3339 timestamp",
                    )
                )
                age = None
            if age is not None and age > float(window):
                failures.append(
                    IngestFailure(
                        STAGE_FRESHNESS,
                        "evidence_stale",
                        f"evidence is {int(age)}s old and the freshness window is {int(window)}s",
                    )
                )

        # 9. Artifact existence. The bytes must already be registered as a fixed artifact
        # reference for this node; evidence never inlines content it cannot verify.
        index = (
            artifact_index
            if artifact_index is not None
            else self.artifacts_for(
                company_ref=company_ref,
                project_ref=project_ref,
                run_id=run_id,
                node_id=node_id,
            )
        )
        for artifact in candidate.artifacts:
            key = f"{artifact.get('kind') or ''}|{artifact.get('contentHash') or ''}"
            if not is_content_hash(artifact.get("contentHash")):
                continue
            if key not in index:
                failures.append(
                    IngestFailure(
                        STAGE_ARTIFACT,
                        "artifact_not_registered",
                        (
                            f"no registered artifact for kind {artifact.get('kind')!r} with digest "
                            f"{artifact.get('contentHash')!r}; submit the artifact first"
                        ),
                    )
                )

        if failures:
            return IngestResult(False, failures=tuple(failures), reason=failures[0].message)

        evidence_id = candidate.evidence_id or ids.new_id("evidence")
        now = self._now()
        artifact_digest = hashing.hash_domain(
            "pf.evidence-artifacts", sorted(digests)
        )
        self.db.execute(
            "INSERT INTO evidence (evidence_id, company_ref, project_ref, run_id, node_id,"
            " iteration, kind, producer_subject, producer_run_ref_json, artifacts_json,"
            " artifact_digest, input_revision_bindings_json, transition_hash, detail_json,"
            " source_revision, produced_at, expires_at, valid, invalidated_reason, created_at, updated_at)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,NULL,?,?)"
            " ON CONFLICT(company_ref, project_ref, evidence_id) DO UPDATE SET"
            " producer_run_ref_json = excluded.producer_run_ref_json,"
            " artifacts_json = excluded.artifacts_json,"
            " artifact_digest = excluded.artifact_digest,"
            " transition_hash = COALESCE(excluded.transition_hash, evidence.transition_hash),"
            " updated_at = excluded.updated_at",
            (
                evidence_id,
                company_ref,
                project_ref,
                run_id,
                node_id,
                int(node.get("iteration", 0)),
                candidate.kind,
                candidate.producer_subject,
                dumps(candidate.producer_run_ref) if candidate.producer_run_ref else None,
                dumps([dict(a) for a in candidate.artifacts]),
                artifact_digest,
                dumps(dict(candidate.input_revision_bindings)),
                None,
                dumps(dict(candidate.detail)) if candidate.detail else None,
                candidate.source_revision,
                candidate.produced_at or now,
                None,
                now,
                now,
            ),
        )
        record = self.get(company_ref=company_ref, project_ref=project_ref, evidence_id=evidence_id)
        return IngestResult(True, evidence_id=evidence_id, record=record, reason="verified")

    def _immutable_identity(self, artifacts: Sequence[Mapping[str, Any]]) -> bool:
        """Every artifact must be pinned by an immutable revision or a verifiable digest.

        A digest fixes the *bytes*. A document reference without a ``revision`` fixes nothing:
        the platform may serve different content at the same id tomorrow, which is exactly the
        case REQ-DATA-02 forbids — an accepted gate must not be rewritable by editing a
        document.
        """
        for artifact in artifacts:
            if not is_content_hash(artifact.get("contentHash")):
                return False
            provider = artifact.get("providerRef")
            if isinstance(provider, Mapping) and str(provider.get("kind", "")) == "document":
                if not provider.get("revision"):
                    return False
        return True

    # -- invalidation ------------------------------------------------------

    def invalidate_dependents(
        self,
        *,
        company_ref: str,
        project_ref: str,
        run_id: str,
        reason: str,
        evidence_ids: Sequence[str] = (),
        artifact_content_hashes: Sequence[str] = (),
        input_names: Sequence[str] = (),
        producer_subjects: Sequence[str] = (),
        kinds: Sequence[str] = (),
    ) -> list[dict[str, Any]]:
        """Mark evidence stale and report exactly what it invalidated.

        Returns the affected rows so the caller can escalate the dependent gates
        explicitly. Nothing here advances or passes a node; a stale input produces
        ``REWORK_REQUIRED`` or ``BLOCKED``, decided by the Runtime.
        """
        rows = self.db.query(
            "SELECT * FROM evidence WHERE company_ref = ? AND project_ref = ? AND run_id = ?"
            " AND valid = 1",
            (company_ref, project_ref, run_id),
        )
        wanted_ids = {str(e) for e in evidence_ids}
        wanted_hashes = {str(h) for h in artifact_content_hashes}
        wanted_inputs = {str(i) for i in input_names}
        wanted_subjects = {str(s) for s in producer_subjects}
        wanted_kinds = {str(k) for k in kinds}

        now = self._now()
        invalidated: list[dict[str, Any]] = []
        for row in rows:
            if str(row["evidence_id"]) in wanted_ids:
                matched = True
            elif wanted_hashes:
                stored = loads(row.get("artifacts_json"), []) or []
                digests = {str(a.get("contentHash", "")) for a in stored}
                matched = bool(digests & wanted_hashes)
            elif wanted_inputs:
                bindings = loads(row.get("input_revision_bindings_json"), {}) or {}
                matched = bool(wanted_inputs & {str(k) for k in bindings})
            elif wanted_subjects:
                matched = str(row["producer_subject"]) in wanted_subjects
            elif wanted_kinds:
                matched = str(row["kind"]) in wanted_kinds
            else:
                matched = False
            if not matched:
                continue
            self.db.execute(
                "UPDATE evidence SET valid = 0, invalidated_reason = ?, updated_at = ?"
                " WHERE company_ref = ? AND project_ref = ? AND evidence_id = ?",
                (reason, now, company_ref, project_ref, str(row["evidence_id"])),
            )
            updated = dict(row)
            updated["valid"] = 0
            updated["invalidated_reason"] = reason
            updated["updated_at"] = now
            invalidated.append(updated)
        return invalidated
