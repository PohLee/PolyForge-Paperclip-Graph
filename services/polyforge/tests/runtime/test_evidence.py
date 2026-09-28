"""Evidence ingestion, lineage, and the evidence-set hash (AT-09).

The order of the checks is itself under test: a candidate from another tenant must be
refused at the *scope* stage, not later with a message that would leak the tenant's business.
"""

from __future__ import annotations

import unittest

from services.polyforge.tests.runtime.fixtures import (
    SCOPE_A,
    digest,
    insert_run_row,
    make_engine,
)
from polyforge.core.evidence.store import (
    STAGE_ARTIFACT,
    STAGE_CLAIM,
    STAGE_CONTENT_HASH,
    STAGE_FRESHNESS,
    STAGE_OUTPUT_TYPE,
    STAGE_PRODUCER,
    STAGE_SCOPE,
    STAGE_SOURCE_REVISION,
    EvidenceCandidate,
    EvidenceStore,
    evidence_set_hash,
    is_content_hash,
)
from polyforge.core.store.db import dumps

RUN = {
    "run_id": "run-1",
    "company_ref": SCOPE_A["companyRef"],
    "project_ref": SCOPE_A["projectRef"],
}
NODE = {"node_id": "qa_run", "iteration": 0}
CONTRACT = {
    "requiredEvidenceKinds": ["qa_report"],
    "intendedMutations": [{"kind": "qa_report", "requiresTrustedExecution": False}],
    "effectivePolicy": {"freshnessSeconds": None},
}
CLAIM = {"attempt_id": "att-1", "lease_state": "ACTIVE", "agent_subject": "sub-qa"}
ATTEMPT = {"attempt_id": "att-1"}
ARTIFACT = {
    "kind": "qa_report",
    "contentHash": digest("report"),
    "mediaType": "text/markdown",
    "size": 12,
}
REVISION = {"candidate_artifacts": "sha256:rev-1"}


class IngestOrderTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine, self.db, self.clock = make_engine()
        self.store = EvidenceStore(self.db, clock=self.clock)
        self.now = self.clock.iso()
        insert_run_row(self.db, "run-1", now=self.now)
        insert_run_row(self.db, "run-2", now=self.now)

    def _ingest(self, **overrides: object) -> object:
        artifacts = overrides.pop("artifacts", None)
        candidate = EvidenceCandidate(
            kind=str(overrides.pop("kind", "qa_report")),  # type: ignore[arg-type]
            artifacts=tuple(artifacts) if artifacts is not None else (ARTIFACT,),  # type: ignore[arg-type]
            producer_subject=str(overrides.pop("producer_subject", "sub-qa")),  # type: ignore[arg-type]
            input_revision_bindings=dict(overrides.pop("bindings", {}) or {}),  # type: ignore[arg-type]
            produced_at=str(overrides.pop("produced_at", self.now)),  # type: ignore[arg-type]
            source_revision=overrides.pop("source_revision", None),  # type: ignore[arg-type]
            trusted_execution=bool(overrides.pop("trusted_execution", False)),  # type: ignore[arg-type]
        )
        kwargs: dict[str, object] = {
            "run": RUN,
            "node": NODE,
            "contract": CONTRACT,
            "claim": CLAIM,
            "attempt": ATTEMPT,
            "current_input_revisions": REVISION,
            "artifact_index": {"qa_report|" + ARTIFACT["contentHash"]: {"artifact_id": "art-1"}},
        }
        kwargs.update(
            {
                k: v
                for k, v in overrides.items()
                if k in ("claim", "run", "contract", "artifact_index")
            }
        )
        return self.store.ingest_candidate(candidate, **kwargs)  # type: ignore[arg-type]

    def test_a_fully_verified_candidate_is_archived(self) -> None:
        result = self._ingest()
        self.assertTrue(result.accepted, msg=result.reason)
        record = self.store.get(
            company_ref=SCOPE_A["companyRef"],
            project_ref=SCOPE_A["projectRef"],
            evidence_id=str(result.evidence_id),
        )
        self.assertIsNotNone(record)
        self.assertEqual(record["kind"], "qa_report")
        self.assertEqual(record["producer_subject"], "sub-qa")

    def test_a_candidate_without_a_declared_scope_is_refused_at_the_scope_stage(self) -> None:
        result = self._ingest(run={"run_id": "run-1", "company_ref": "", "project_ref": ""})
        self.assertFalse(result.accepted)
        self.assertEqual(result.first_failure.stage, STAGE_SCOPE)  # type: ignore[union-attr]

    def test_an_evidence_id_owned_by_another_run_is_a_scope_conflict(self) -> None:
        first = self._ingest()
        other = dict(RUN, run_id="run-2")
        second = self.store.ingest_candidate(
            EvidenceCandidate(
                kind="qa_report",
                artifacts=(ARTIFACT,),
                producer_subject="sub-qa",
                evidence_id=str(first.evidence_id),
                produced_at=self.now,
            ),
            run=other,
            node=NODE,
            contract=CONTRACT,
            claim=CLAIM,
            attempt=ATTEMPT,
            current_input_revisions=REVISION,
            artifact_index={"qa_report|" + ARTIFACT["contentHash"]: {"artifact_id": "art-1"}},
        )
        self.assertFalse(second.accepted)
        self.assertEqual(second.first_failure.stage, STAGE_SCOPE)  # type: ignore[union-attr]

    def test_a_missing_producer_is_refused(self) -> None:
        result = self._ingest(producer_subject="")
        self.assertFalse(result.accepted)
        self.assertEqual(result.first_failure.stage, STAGE_PRODUCER)  # type: ignore[union-attr]

    def test_a_producer_that_is_not_the_claim_holder_is_refused(self) -> None:
        result = self._ingest(producer_subject="sub-someone-else")
        self.assertFalse(result.accepted)
        self.assertEqual(result.first_failure.stage, STAGE_PRODUCER)  # type: ignore[union-attr]
        self.assertEqual(result.first_failure.code, "producer_not_claim_holder")  # type: ignore[union-attr]

    def test_an_unclaimed_write_is_refused(self) -> None:
        result = self._ingest(claim=None)
        self.assertFalse(result.accepted)
        self.assertEqual(result.first_failure.stage, STAGE_CLAIM)  # type: ignore[union-attr]

    def test_a_released_lease_is_refused(self) -> None:
        result = self._ingest(claim={**CLAIM, "lease_state": "RELEASED"})
        self.assertFalse(result.accepted)
        self.assertEqual(result.first_failure.stage, STAGE_CLAIM)  # type: ignore[union-attr]

    def test_an_output_type_outside_the_contract_is_refused(self) -> None:
        result = self._ingest(kind="deployment_approval")
        self.assertFalse(result.accepted)
        self.assertEqual(result.first_failure.stage, STAGE_OUTPUT_TYPE)  # type: ignore[union-attr]

    def test_a_mutable_document_url_without_a_revision_is_never_an_identity(self) -> None:
        mutable = {**ARTIFACT, "providerRef": {"provider": "paperclip", "kind": "document", "id": "doc-1"}}
        result = self._ingest(artifacts=(mutable,))
        self.assertFalse(result.accepted)
        self.assertEqual(result.first_failure.stage, STAGE_CONTENT_HASH)  # type: ignore[union-attr]

    def test_an_artifact_without_a_well_formed_digest_is_refused(self) -> None:
        result = self._ingest(artifacts=({**ARTIFACT, "contentHash": "not-a-digest"},))
        self.assertFalse(result.accepted)
        self.assertEqual(result.first_failure.stage, STAGE_CONTENT_HASH)  # type: ignore[union-attr]

    def test_evidence_produced_against_an_old_input_revision_is_refused(self) -> None:
        result = self._ingest(bindings={"candidate_artifacts": "sha256:rev-0"})
        self.assertFalse(result.accepted)
        self.assertEqual(result.first_failure.stage, STAGE_SOURCE_REVISION)  # type: ignore[union-attr]
        self.assertEqual(result.first_failure.code, "input_revision_stale")  # type: ignore[union-attr]

    def test_a_stale_source_revision_is_refused(self) -> None:
        result = self._ingest(source_revision="sha256:rev-0")
        self.assertFalse(result.accepted)
        self.assertEqual(result.first_failure.stage, STAGE_SOURCE_REVISION)  # type: ignore[union-attr]

    def test_evidence_outside_the_freshness_window_is_refused(self) -> None:
        contract = {**CONTRACT, "effectivePolicy": {"freshnessSeconds": 60}}
        result = self._ingest(contract=contract, produced_at="2025-01-01T00:00:00.000Z")
        self.assertFalse(result.accepted)
        self.assertEqual(result.first_failure.stage, STAGE_FRESHNESS)  # type: ignore[union-attr]

    def test_a_trusted_execution_requirement_cannot_be_self_certified(self) -> None:
        contract = {
            **CONTRACT,
            "intendedMutations": [{"kind": "qa_report", "requiresTrustedExecution": True}],
        }
        result = self._ingest(contract=contract)
        self.assertFalse(result.accepted)
        self.assertEqual(result.failures[-1].code, "trusted_execution_required")

    def test_an_unregistered_artifact_is_refused(self) -> None:
        result = self._ingest(artifact_index={})
        self.assertFalse(result.accepted)
        self.assertEqual(result.first_failure.stage, STAGE_ARTIFACT)  # type: ignore[union-attr]

    def test_a_candidate_without_a_kind_raises_rather_than_being_ingested(self) -> None:
        from polyforge.core import errors

        with self.assertRaises(errors.PolyForgeError):
            self.store.ingest_candidate(
                EvidenceCandidate(kind="", produced_at=self.now),
                run=RUN,
                node=NODE,
                contract=CONTRACT,
                claim=CLAIM,
            )


class MutationResistanceTests(unittest.TestCase):
    """AT-09: a mutable document update must not rewrite evidence that already exists."""

    def setUp(self) -> None:
        self.engine, self.db, self.clock = make_engine()
        self.store = EvidenceStore(self.db, clock=self.clock)
        self.run = {
            "run_id": "run-1",
            "company_ref": SCOPE_A["companyRef"],
            "project_ref": SCOPE_A["projectRef"],
        }
        insert_run_row(self.db, "run-1", now=self.clock.iso())
        self.db.execute(
            "INSERT INTO artifacts (artifact_id, company_ref, project_ref, run_id, node_id, iteration,"
            " kind, content_hash, media_type, size, source_json, immutable, created_at, updated_at)"
            " VALUES ('art-1',?,?,'run-1','qa_run',0,'qa_report',?,'text/markdown',12,'{}',1,?,?)",
            (
                SCOPE_A["companyRef"],
                SCOPE_A["projectRef"],
                digest("report"),
                self.clock.iso(),
                self.clock.iso(),
            ),
        )
        self.accepted = self.store.ingest_candidate(
            EvidenceCandidate(
                kind="qa_report",
                artifacts=(
                    {
                        "artifactId": "art-1",
                        "kind": "qa_report",
                        "contentHash": digest("report"),
                        "providerRef": {
                            "provider": "paperclip",
                            "kind": "document",
                            "id": "doc-1",
                            "revision": "rev-1",
                        },
                    },
                ),
                producer_subject="sub-qa",
                produced_at=self.clock.iso(),
            ),
            run=self.run,
            node=NODE,
            contract=CONTRACT,
            claim=CLAIM,
            attempt=ATTEMPT,
            artifact_index={"qa_report|" + digest("report"): {"artifact_id": "art-1"}},
        )
        self.assertTrue(self.accepted.accepted, msg=self.accepted.reason)
        self.before = dict(
            self.store.get(
                company_ref=SCOPE_A["companyRef"],
                project_ref=SCOPE_A["projectRef"],
                evidence_id=str(self.accepted.evidence_id),
            )
        )

    def test_a_new_document_revision_does_not_change_existing_evidence(self) -> None:
        # The platform moves the document on; the Core's evidence still points at the pinned
        # revision and the same digest.
        self.db.execute(
            "UPDATE artifacts SET provider_ref_json = ? WHERE artifact_id = 'art-1'",
            (
                dumps(
                    {
                        "provider": "paperclip",
                        "kind": "document",
                        "id": "doc-1",
                        "revision": "rev-2",
                    }
                ),
            ),
        )
        after = self.store.get(
            company_ref=SCOPE_A["companyRef"],
            project_ref=SCOPE_A["projectRef"],
            evidence_id=str(self.accepted.evidence_id),
        )
        self.assertEqual(after["artifact_digest"], self.before["artifact_digest"])
        self.assertEqual(
            after["artifacts_json"],
            self.before["artifacts_json"],
            "the evidence record itself must not follow a mutable document pointer",
        )
        self.assertEqual(int(after["valid"]), 1)

    def test_invalidate_dependents_reports_exactly_what_it_invalidated(self) -> None:
        invalidated = self.store.invalidate_dependents(
            company_ref=SCOPE_A["companyRef"],
            project_ref=SCOPE_A["projectRef"],
            run_id="run-1",
            reason="the upstream candidate artifact changed",
            artifact_content_hashes=[digest("report")],
        )
        self.assertEqual([str(r["evidence_id"]) for r in invalidated], [str(self.accepted.evidence_id)])
        self.assertEqual(str(invalidated[0]["invalidated_reason"]), "the upstream candidate artifact changed")
        again = self.store.invalidate_dependents(
            company_ref=SCOPE_A["companyRef"],
            project_ref=SCOPE_A["projectRef"],
            run_id="run-1",
            reason="second pass",
            artifact_content_hashes=[digest("report")],
        )
        self.assertEqual(again, [], "invalidation is idempotent; a second pass finds nothing valid")

    def test_invalidation_by_input_name(self) -> None:
        invalidated = self.store.invalidate_dependents(
            company_ref=SCOPE_A["companyRef"],
            project_ref=SCOPE_A["projectRef"],
            run_id="run-1",
            reason="input renamed",
            input_names=["candidate_artifacts"],
        )
        self.assertEqual(invalidated, [], "this record declared no input binding, so it is untouched")


class EvidenceSetHashTests(unittest.TestCase):
    def test_the_set_hash_is_order_independent(self) -> None:
        self.assertEqual(evidence_set_hash(["a", "b", "c"]), evidence_set_hash(["c", "a", "b"]))

    def test_a_changed_digest_changes_the_set_hash(self) -> None:
        first = evidence_set_hash(["a"], {"a": "sha256:one"})
        second = evidence_set_hash(["a"], {"a": "sha256:two"})
        self.assertNotEqual(first, second)

    def test_the_set_hash_is_domain_separated_from_a_contract_hash(self) -> None:
        from polyforge.core import hashing

        self.assertNotEqual(
            evidence_set_hash(["a"]),
            hashing.hash_domain("pf.contract", ["a"]),
        )


class ContentHashFormatTests(unittest.TestCase):
    def test_only_sha256_hex_is_accepted(self) -> None:
        self.assertTrue(is_content_hash(digest("x")))
        self.assertTrue(is_content_hash("sha256:" + "a" * 64))
        self.assertFalse(is_content_hash("sha256:short"))
        self.assertFalse(is_content_hash("md5:" + "a" * 32))
        self.assertFalse(is_content_hash(None))
        self.assertFalse(is_content_hash(123))


if __name__ == "__main__":
    unittest.main()

class EvidenceDetailRoundTripTests(unittest.TestCase):
    """The payload an evaluator reads must be the payload that was submitted.

    This was a silent loss rather than a failure: ``detail`` was accepted on the candidate and
    written to ``detail_json``, and then dropped when the row came back as an ``EvidenceRecord``.
    Every check that judges what a report *says* -- a test report's failures, a threat model's
    findings, a QA verdict -- therefore saw only that a record existed, and would have had to be
    written against a field the Core could not see.
    """

    def test_the_submitted_detail_survives_ingestion(self) -> None:
        from polyforge.core.evidence.store import EvidenceCandidate

        detail = {
            "verdict": "pass",
            "findings": [{"id": "F1", "severity": "high", "resolved": False}],
        }
        record = EvidenceCandidate.from_wire(
            {
                "kind": "security_report",
                "artifacts": [],
                "detail": detail,
                "producerSubject": "human:reviewer",
            }
        )
        self.assertEqual(record.detail, detail)



if __name__ == "__main__":
    unittest.main()
