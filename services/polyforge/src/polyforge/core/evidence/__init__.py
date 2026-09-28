"""Evidence: ingestion, lineage, and invalidation.

Evidence is the only thing a gate may read. A worker's claim becomes evidence only after
the Core has verified its scope, producer, claim, output type, content hash, source
revision, trusted execution record, freshness, and artifact existence.
"""

from __future__ import annotations

from polyforge.core.evidence.store import (
    EVIDENCE_SET_HASH_DOMAIN,
    STAGE_ORDER,
    EvidenceCandidate,
    EvidenceStore,
    IngestFailure,
    IngestResult,
    evidence_set_hash,
    is_content_hash,
)

__all__ = [
    "EVIDENCE_SET_HASH_DOMAIN",
    "STAGE_ORDER",
    "EvidenceCandidate",
    "EvidenceStore",
    "IngestFailure",
    "IngestResult",
    "evidence_set_hash",
    "is_content_hash",
]
