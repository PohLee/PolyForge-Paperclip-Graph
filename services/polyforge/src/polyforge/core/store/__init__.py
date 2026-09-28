"""Durable GraphStore: schema, connection management, and wire value objects.

Everything the Runtime persists goes through :class:`Database`. The submodules are split
by concern so a schema change, a transaction, and a wire shape are reviewed separately:

* :mod:`polyforge.core.store.db` owns the connection, transactions, migrations, writer lock.
* :mod:`polyforge.core.store.models` owns the wire shapes and row decoders.
* :mod:`polyforge.core.store.schema.sql` is the DDL, loaded as a file.
"""

from __future__ import annotations

from polyforge.core.store.db import WRITER_LOCK_TABLE, Database, WriterLease, dumps, loads
from polyforge.core.store.models import (
    PF_EVENT_TYPES,
    ArtifactRef,
    Blocker,
    CommandResult,
    DomainEvent,
    EffectRecord,
    EffectStatus,
    EvidenceRecord,
    ExecutionAttempt,
    GateEvaluationRecord,
    GovernanceResolution,
    HealthReport,
    MigrationPreview,
    MutationEnvelope,
    NodeExecutionView,
    PendingGovernance,
    ProviderRef,
    RunSnapshot,
    Scope,
)

__all__ = [
    "PF_EVENT_TYPES",
    "WRITER_LOCK_TABLE",
    "ArtifactRef",
    "Blocker",
    "CommandResult",
    "Database",
    "DomainEvent",
    "EffectRecord",
    "EffectStatus",
    "EvidenceRecord",
    "ExecutionAttempt",
    "GateEvaluationRecord",
    "GovernanceResolution",
    "HealthReport",
    "MigrationPreview",
    "MutationEnvelope",
    "NodeExecutionView",
    "PendingGovernance",
    "ProviderRef",
    "RunSnapshot",
    "Scope",
    "WriterLease",
    "dumps",
    "loads",
]
