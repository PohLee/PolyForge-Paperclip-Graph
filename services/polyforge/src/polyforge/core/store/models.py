"""Wire-shaped value objects and row decoders for the durable store.

Responsibility: one place that knows how a Core row becomes the JSON the bridge reads, so
the HTTP layer never hand-builds a payload and drifts from the contract.

Invariants:

* Every field name produced by ``to_wire()`` matches ``packages/protocol/src/api.ts``.
  Python attributes are snake_case; the wire is camelCase. The conversion is explicit
  rather than automatic so a rename cannot silently pass through.
* Decoders take a ``sqlite3.Row``-shaped mapping and raise nothing: a missing optional
  column becomes ``None``, because these run during recovery reads where a partially
  migrated row is a fact to report, not an error to crash on.
* ``PF_EVENT_TYPES`` is the exact ``pf.*`` vocabulary from
  ``packages/protocol/src/events.ts``. Emitting an event name outside it is a contract
  break, so the set is a closed tuple and :func:`is_pf_event` gates it.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Final, Mapping

from polyforge.core.state import (
    AttemptStatus,
    BlockReason,
    EvaluatorKind,
    GraphRunStatus,
    JoinSemantics,
    NodeKind,
    NodeStatus,
)

__all__ = [
    "PF_EVENT_TYPES",
    "ArtifactRef",
    "Blocker",
    "CommandResult",
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
    "PF_HEALTH_STATUSES",
    "PendingGovernance",
    "ProviderRef",
    "RunSnapshot",
    "Scope",
    "is_pf_event",
]

#: Exact mirror of ``PF_EVENT_TYPES`` in packages/protocol/src/events.ts.
PF_EVENT_TYPES: Final[tuple[str, ...]] = (
    "pf.work_order.accepted",
    "pf.node.ready",
    "pf.node.dispatched",
    "pf.execution.observed",
    "pf.execution.unknown",
    "pf.evidence.ingested",
    "pf.gate.waiting",
    "pf.gate.evaluated",
    "pf.transition.committed",
    "pf.transition.rejected",
    "pf.governance.requested",
    "pf.governance.observed",
    "pf.authorization.denied",
    "pf.effect.unknown",
    "pf.effect.reconciled",
    "pf.run.blocked",
    "pf.run.completed",
    "pf.run.cancelled",
    "pf.checkpoint.written",
    "pf.migration.committed",
)

PF_HEALTH_STATUSES: Final[tuple[str, ...]] = ("ready", "read_only", "degraded", "blocked")


def is_pf_event(name: str) -> bool:
    return name in PF_EVENT_TYPES


def _opt_str(row: Mapping[str, Any], key: str) -> str | None:
    value = row.get(key)
    return None if value is None else str(value)


def _opt_int(row: Mapping[str, Any], key: str) -> int | None:
    value = row.get(key)
    return None if value is None else int(value)


def _opt_obj(row: Mapping[str, Any], key: str) -> dict[str, Any] | None:
    from polyforge.core.store.db import loads

    value = row.get(key)
    if value is None:
        return None
    return loads(value, {})


def _opt_list(row: Mapping[str, Any], key: str) -> list[str] | None:
    """Read a JSON array column. These hold opaque identifiers, not structured objects."""
    import json

    value = row.get(key)
    if value is None:
        return None
    if isinstance(value, str):
        if value == "":
            return None
        try:
            decoded = json.loads(value)
        except ValueError:
            return None
    else:
        decoded = value
    if not isinstance(decoded, list):
        return None
    return [str(v) for v in decoded]


def _opt_ref(row: Mapping[str, Any], key: str) -> dict[str, Any] | None:
    return _opt_obj(row, key)


@dataclass(frozen=True)
class ProviderRef:
    """An opaque reference to a platform object. The Core never interprets its fields."""

    provider: str
    kind: str
    id: str
    revision: str | None = None

    def to_wire(self) -> dict[str, Any]:
        wire: dict[str, Any] = {"provider": self.provider, "kind": self.kind, "id": self.id}
        if self.revision is not None:
            wire["revision"] = self.revision
        return wire

    @staticmethod
    def from_wire(value: Any) -> "ProviderRef | None":
        if not isinstance(value, Mapping):
            return None
        return ProviderRef(
            provider=str(value.get("provider", "")),
            kind=str(value.get("kind", "")),
            id=str(value.get("id", "")),
            revision=None if value.get("revision") is None else str(value["revision"]),
        )


@dataclass(frozen=True)
class Scope:
    """Company + project. Every stored row and every read is scoped by this pair."""

    company_ref: str
    project_ref: str

    def to_wire(self) -> dict[str, str]:
        return {"companyRef": self.company_ref, "projectRef": self.project_ref}

    @staticmethod
    def from_wire(value: Any) -> "Scope":
        if isinstance(value, Mapping):
            return Scope(str(value.get("companyRef", "")), str(value.get("projectRef", "")))
        if isinstance(value, (tuple, list)) and len(value) == 2:
            return Scope(str(value[0]), str(value[1]))
        raise ValueError("scope must be {companyRef, projectRef}")

    def same_as(self, other: "Scope | None") -> bool:
        return (
            other is not None
            and self.company_ref == other.company_ref
            and self.project_ref == other.project_ref
        )


@dataclass(frozen=True)
class Blocker:
    """An explainable reason a run is not progressing. Never a bare string."""

    code: str
    reason: str
    message: str
    detail: dict[str, Any] = field(default_factory=dict)

    def to_wire(self) -> dict[str, Any]:
        wire: dict[str, Any] = {"code": self.code, "reason": self.reason, "message": self.message}
        if self.detail:
            wire["detail"] = self.detail
        return wire


@dataclass(frozen=True)
class ArtifactRef:
    """An immutable-by-identity reference to bytes."""

    artifact_id: str
    kind: str
    content_hash: str
    media_type: str
    size: int
    provider_ref: dict[str, Any] | None = None
    repository: dict[str, Any] | None = None
    immutable: bool = True
    created_at: str = ""

    def to_wire(self) -> dict[str, Any]:
        return {
            "artifactId": self.artifact_id,
            "kind": self.kind,
            "contentHash": self.content_hash,
            "mediaType": self.media_type,
            "size": self.size,
            "providerRef": self.provider_ref,
            "repository": self.repository,
            "immutable": self.immutable,
            "createdAt": self.created_at,
        }

    @staticmethod
    def from_row(row: Mapping[str, Any]) -> "ArtifactRef":
        return ArtifactRef(
            artifact_id=str(row["artifact_id"]),
            kind=str(row["kind"]),
            content_hash=str(row["content_hash"]),
            media_type=str(row["media_type"]),
            size=int(row["size"]),
            provider_ref=_opt_ref(row, "provider_ref_json"),
            repository=_opt_obj(row, "repository_json"),
            immutable=bool(row.get("immutable", 1)),
            created_at=str(row.get("created_at", "")),
        )


@dataclass(frozen=True)
class EvidenceRecord:
    """Verified evidence. ``valid`` is the only truth a gate may read."""

    evidence_id: str
    run_id: str
    node_id: str
    kind: str
    transition_hash: str | None
    artifacts: list[dict[str, Any]]
    producer_subject: str
    producer_run_ref: dict[str, Any] | None
    input_revision_bindings: dict[str, str]
    #: The submitted payload, carried through ingestion. Read by the evaluators that judge what a
    #: report says rather than merely that one exists -- a test report's failures, a threat model's
    #: findings, a QA verdict. It was accepted and persisted and then dropped on the way back out,
    #: which left every one of those checks able to see only that a record existed.
    detail: dict[str, Any]
    valid: bool
    invalidated_reason: str | None
    artifact_digest: str
    created_at: str

    def to_wire(self) -> dict[str, Any]:
        return {
            "evidenceId": self.evidence_id,
            "runId": self.run_id,
            "nodeId": self.node_id,
            "kind": self.kind,
            "transitionHash": self.transition_hash,
            "artifacts": self.artifacts,
            "producerSubject": self.producer_subject,
            "producerRunRef": self.producer_run_ref,
            "inputRevisionBindings": self.input_revision_bindings,
            "detail": self.detail,
            "valid": self.valid,
            "invalidatedReason": self.invalidated_reason,
            "artifactDigest": self.artifact_digest,
            "createdAt": self.created_at,
        }

    @staticmethod
    def from_row(row: Mapping[str, Any]) -> "EvidenceRecord":
        return EvidenceRecord(
            evidence_id=str(row["evidence_id"]),
            run_id=str(row["run_id"]),
            node_id=str(row["node_id"]),
            kind=str(row["kind"]),
            transition_hash=_opt_str(row, "transition_hash"),
            artifacts=_opt_obj(row, "artifacts_json") or [],
            producer_subject=str(row["producer_subject"]),
            producer_run_ref=_opt_ref(row, "producer_run_ref_json"),
            input_revision_bindings=_opt_obj(row, "input_revision_bindings_json") or {},
            detail=_opt_obj(row, "detail_json") or {},
            valid=bool(row.get("valid", 1)),
            invalidated_reason=_opt_str(row, "invalidated_reason"),
            artifact_digest=str(row.get("artifact_digest", "")),
            created_at=str(row.get("created_at", "")),
        )


@dataclass(frozen=True)
class GateEvaluationRecord:
    evaluation_id: str
    gate_id: str
    evaluator_ref: str
    evaluator_kind: str
    evaluator_version: str
    transition_hash: str
    evidence_set_hash: str
    result: str
    reason: str
    mandatory: bool
    created_at: str
    run_id: str = ""
    node_id: str = ""

    def to_wire(self) -> dict[str, Any]:
        return {
            "evaluationId": self.evaluation_id,
            "runId": self.run_id,
            "nodeId": self.node_id,
            "gateId": self.gate_id,
            "evaluatorRef": self.evaluator_ref,
            "evaluatorKind": self.evaluator_kind,
            "evaluatorVersion": self.evaluator_version,
            "transitionHash": self.transition_hash,
            "evidenceSetHash": self.evidence_set_hash,
            "result": self.result,
            "reason": self.reason,
            "mandatory": self.mandatory,
            "createdAt": self.created_at,
        }

    @staticmethod
    def from_row(row: Mapping[str, Any]) -> "GateEvaluationRecord":
        return GateEvaluationRecord(
            evaluation_id=str(row["evaluation_id"]),
            gate_id=str(row["gate_id"]),
            evaluator_ref=str(row["evaluator_ref"]),
            evaluator_kind=str(row["evaluator_kind"]),
            evaluator_version=str(row["evaluator_version"]),
            transition_hash=str(row["transition_hash"]),
            evidence_set_hash=str(row["evidence_set_hash"]),
            result=str(row["result"]),
            reason=str(row["reason"]),
            mandatory=bool(row.get("mandatory", 1)),
            created_at=str(row.get("created_at", "")),
            run_id=str(row.get("run_id", "")),
            node_id=str(row.get("node_id", "")),
        )


class EffectStatus:
    """Effect ledger vocabulary. ``UNKNOWN`` is a durable state, not an absence."""

    PENDING: Final = "PENDING"
    EFFECTED: Final = "EFFECTED"
    NOT_EFFECTED: Final = "NOT_EFFECTED"
    UNKNOWN: Final = "UNKNOWN"

    ALL: Final = (PENDING, EFFECTED, NOT_EFFECTED, UNKNOWN)


@dataclass(frozen=True)
class EffectRecord:
    effect_key: str
    transition_hash: str
    step_id: str
    status: str
    provider_ref: dict[str, Any] | None
    request_hash: str
    result_hash: str | None
    reconciliation_note: str | None
    authority: dict[str, Any] | None
    prior_worker_state: str | None
    updated_at: str

    def to_wire(self) -> dict[str, Any]:
        return {
            "effectKey": self.effect_key,
            "transitionHash": self.transition_hash,
            "stepId": self.step_id,
            "status": self.status,
            "providerRef": self.provider_ref,
            "requestHash": self.request_hash,
            "resultHash": self.result_hash,
            "reconciliationNote": self.reconciliation_note,
            "authority": self.authority,
            "priorWorkerState": self.prior_worker_state,
            "updatedAt": self.updated_at,
        }

    @staticmethod
    def from_row(row: Mapping[str, Any]) -> "EffectRecord":
        return EffectRecord(
            effect_key=str(row["effect_key"]),
            transition_hash=str(row["transition_hash"]),
            step_id=str(row["step_id"]),
            status=str(row["status"]),
            provider_ref=_opt_ref(row, "provider_ref_json"),
            request_hash=str(row.get("request_hash", "")),
            result_hash=_opt_str(row, "result_hash"),
            reconciliation_note=_opt_str(row, "reconciliation_note"),
            authority=_opt_obj(row, "authority_json"),
            prior_worker_state=_opt_str(row, "prior_worker_state"),
            updated_at=str(row.get("updated_at", "")),
        )


@dataclass(frozen=True)
class ExecutionAttempt:
    attempt_id: str
    run_id: str
    node_id: str
    iteration: int
    attempt_no: int
    transition_hash: str
    status: str
    lease_epoch: int
    lease_state: str
    agent_subject: str | None
    agent_run_ref: dict[str, Any] | None
    started_at: str | None
    finished_at: str | None
    lease_expires_at: str | None
    checkpoint_ref: str | None

    def to_wire(self) -> dict[str, Any]:
        return {
            "attemptId": self.attempt_id,
            "runId": self.run_id,
            "nodeId": self.node_id,
            "iteration": self.iteration,
            "attemptNo": self.attempt_no,
            "transitionHash": self.transition_hash,
            "status": self.status,
            "leaseEpoch": self.lease_epoch,
            "leaseState": self.lease_state,
            "agentSubject": self.agent_subject,
            "agentRunRef": self.agent_run_ref,
            "startedAt": self.started_at,
            "finishedAt": self.finished_at,
            "leaseExpiresAt": self.lease_expires_at,
            "checkpointRef": self.checkpoint_ref,
        }

    @staticmethod
    def from_row(row: Mapping[str, Any]) -> "ExecutionAttempt":
        return ExecutionAttempt(
            attempt_id=str(row["attempt_id"]),
            run_id=str(row["run_id"]),
            node_id=str(row["node_id"]),
            iteration=int(row["iteration"]),
            attempt_no=int(row["attempt_no"]),
            transition_hash=str(row["transition_hash"]),
            status=str(row["status"]),
            lease_epoch=int(row["lease_epoch"]),
            lease_state=str(row.get("lease_state", "ACTIVE")),
            agent_subject=_opt_str(row, "agent_subject"),
            agent_run_ref=_opt_ref(row, "agent_run_ref_json"),
            started_at=_opt_str(row, "started_at"),
            finished_at=_opt_str(row, "finished_at"),
            lease_expires_at=_opt_str(row, "lease_expires_at"),
            checkpoint_ref=_opt_str(row, "checkpoint_ref"),
        )


@dataclass(frozen=True)
class NodeExecutionView:
    node_id: str
    kind: str
    status: str
    iteration: int
    contract_hash: str | None
    input_refs: list[str]
    output_refs: list[str]
    active_attempt_id: str | None
    wait_reason: str | None
    block_reason: str | None
    required_capabilities: list[str]
    assigned_subject: str | None
    assigned_issue_ref: dict[str, Any] | None
    child_run_id: str | None
    rework_count: int
    max_rework: int
    updated_at: str

    def to_wire(self) -> dict[str, Any]:
        return {
            "nodeId": self.node_id,
            "kind": self.kind,
            "status": self.status,
            "iteration": self.iteration,
            "contractHash": self.contract_hash,
            "inputRefs": self.input_refs,
            "outputRefs": self.output_refs,
            "activeAttemptId": self.active_attempt_id,
            "waitReason": self.wait_reason,
            "blockReason": self.block_reason,
            "requiredCapabilities": self.required_capabilities,
            "assignedSubject": self.assigned_subject,
            "assignedIssueRef": self.assigned_issue_ref,
            "childRunId": self.child_run_id,
            "reworkCount": self.rework_count,
            "maxRework": self.max_rework,
            "updatedAt": self.updated_at,
        }

    @staticmethod
    def from_row(row: Mapping[str, Any]) -> "NodeExecutionView":
        return NodeExecutionView(
            node_id=str(row["node_id"]),
            kind=str(row["kind"]),
            status=str(row["status"]),
            iteration=int(row["iteration"]),
            contract_hash=_opt_str(row, "contract_hash"),
            input_refs=_opt_list(row, "input_refs_json") or [],
            output_refs=_opt_list(row, "output_refs_json") or [],
            active_attempt_id=_opt_str(row, "active_attempt_id"),
            wait_reason=_opt_str(row, "wait_reason"),
            block_reason=_opt_str(row, "block_reason"),
            required_capabilities=_opt_obj(row, "required_capabilities_json") or [],
            assigned_subject=_opt_str(row, "assigned_subject"),
            assigned_issue_ref=_opt_ref(row, "assigned_issue_ref_json"),
            child_run_id=_opt_str(row, "child_run_id"),
            rework_count=int(row.get("rework_count", 0)),
            max_rework=int(row.get("max_rework", 3)),
            updated_at=str(row.get("updated_at", "")),
        )


@dataclass(frozen=True)
class GovernanceResolution:
    """A bridge-verified human/agent answer about an exact target."""

    responder_subject: str
    responder_kind: str
    outcome: str
    verified_against_provider: bool
    detail: dict[str, Any] = field(default_factory=dict)
    recorded_at: str = ""

    def to_wire(self) -> dict[str, Any]:
        return {
            "responderSubject": self.responder_subject,
            "responderKind": self.responder_kind,
            "outcome": self.outcome,
            "verifiedAgainstProvider": self.verified_against_provider,
            "detail": self.detail,
            "recordedAt": self.recorded_at,
        }

    @staticmethod
    def from_wire(value: Any) -> "GovernanceResolution | None":
        if not isinstance(value, Mapping):
            return None
        return GovernanceResolution(
            responder_subject=str(value.get("responderSubject", "")),
            responder_kind=str(value.get("responderKind", "")),
            outcome=str(value.get("outcome", "")),
            verified_against_provider=bool(value.get("verifiedAgainstProvider", False)),
            detail=dict(value.get("detail") or {}),
            recorded_at=str(value.get("recordedAt", "")),
        )


@dataclass(frozen=True)
class PendingGovernance:
    request_id: str
    kind: str
    gate_id: str
    node_id: str
    transition_hash: str
    decision_target_hash: str
    semantic_kind: str
    provider_ref: dict[str, Any] | None
    created_at: str
    expires_at: str | None
    resolved_at: str | None
    resolution: GovernanceResolution | None

    def to_wire(self) -> dict[str, Any]:
        return {
            "requestId": self.request_id,
            "kind": self.kind,
            "gateId": self.gate_id,
            "nodeId": self.node_id,
            "transitionHash": self.transition_hash,
            "decisionTargetHash": self.decision_target_hash,
            "semanticKind": self.semantic_kind,
            "providerRef": self.provider_ref,
            "createdAt": self.created_at,
            "expiresAt": self.expires_at,
            "resolvedAt": self.resolved_at,
            "resolution": self.resolution.to_wire() if self.resolution else None,
        }

    @staticmethod
    def from_row(row: Mapping[str, Any]) -> "PendingGovernance":
        return PendingGovernance(
            request_id=str(row["request_id"]),
            kind=str(row["kind"]),
            gate_id=str(row.get("gate_id") or ""),
            node_id=str(row["node_id"]),
            transition_hash=str(row["transition_hash"]),
            decision_target_hash=str(row["decision_target_hash"]),
            semantic_kind=str(row["semantic_kind"]),
            provider_ref=_opt_ref(row, "provider_ref_json"),
            created_at=str(row.get("created_at", "")),
            expires_at=_opt_str(row, "expires_at"),
            resolved_at=_opt_str(row, "resolved_at"),
            resolution=GovernanceResolution.from_wire(_opt_obj(row, "resolution_json")),
        )


@dataclass(frozen=True)
class DomainEvent:
    seq: int
    run_id: str
    type: str
    at: str
    payload: dict[str, Any]

    def to_wire(self) -> dict[str, Any]:
        return {"seq": self.seq, "runId": self.run_id, "type": self.type, "at": self.at, "payload": self.payload}


@dataclass(frozen=True)
class CommandResult:
    """The command envelope. ``applied`` false means recorded, not attempted-and-failed."""

    command_id: str
    applied: bool
    state_version: int
    status: str
    result_ref: str | None = None
    blockers: list[Blocker] = field(default_factory=list)
    pending: bool = False
    pending_reason: str | None = None

    def to_wire(self) -> dict[str, Any]:
        wire: dict[str, Any] = {
            "commandId": self.command_id,
            "applied": self.applied,
            "stateVersion": self.state_version,
            "status": self.status,
            "blockers": [b.to_wire() for b in self.blockers],
        }
        if self.result_ref is not None:
            wire["resultRef"] = self.result_ref
        if self.pending:
            wire["pending"] = True
            if self.pending_reason:
                wire["pendingReason"] = self.pending_reason
        return wire

    @staticmethod
    def from_wire(value: Mapping[str, Any]) -> "CommandResult":
        return CommandResult(
            command_id=str(value.get("commandId", "")),
            applied=bool(value.get("applied", False)),
            state_version=int(value.get("stateVersion", 0)),
            status=str(value.get("status", "")),
            result_ref=value.get("resultRef"),
            blockers=[
                Blocker(
                    code=str(b.get("code", "")),
                    reason=str(b.get("reason", "")),
                    message=str(b.get("message", "")),
                    detail=dict(b.get("detail") or {}),
                )
                for b in (value.get("blockers") or [])
                if isinstance(b, Mapping)
            ],
            pending=bool(value.get("pending", False)),
            pending_reason=value.get("pendingReason"),
        )


@dataclass(frozen=True)
class RunSnapshot:
    """The authoritative read model. Never contains a derived guess about a pass."""

    run_id: str
    family_id: str
    work_order_id: str
    graph_id: str
    graph_version: int
    status: str
    state_version: int
    event_sequence: int
    owner_epoch: int
    entrypoint: str
    parent_run_id: str | None
    parent_node_id: str | None
    invocation_generation: int
    scope: Scope
    pins: dict[str, str]
    root_issue_ref: dict[str, Any] | None
    budget_state: dict[str, Any] | None
    block_reason: str | None
    nodes: list[NodeExecutionView]
    attempts: list[ExecutionAttempt]
    gates: list[GateEvaluationRecord]
    evidence: list[EvidenceRecord]
    pending_governance: list[PendingGovernance]
    effects: list[EffectRecord]
    blockers: list[Blocker]
    created_at: str
    updated_at: str

    def to_wire(self) -> dict[str, Any]:
        return {
            "runId": self.run_id,
            "familyId": self.family_id,
            "workOrderId": self.work_order_id,
            "graphId": self.graph_id,
            "graphVersion": self.graph_version,
            "status": self.status,
            "stateVersion": self.state_version,
            "eventSequence": self.event_sequence,
            "ownerEpoch": self.owner_epoch,
            "entrypoint": self.entrypoint,
            "parentRunId": self.parent_run_id,
            "parentNodeId": self.parent_node_id,
            "invocationGeneration": self.invocation_generation,
            "scope": self.scope.to_wire(),
            "pins": self.pins,
            "rootIssueRef": self.root_issue_ref,
            "budgetState": self.budget_state,
            "blockReason": self.block_reason,
            "nodes": [n.to_wire() for n in self.nodes],
            "attempts": [a.to_wire() for a in self.attempts],
            "gates": [g.to_wire() for g in self.gates],
            "evidence": [e.to_wire() for e in self.evidence],
            "pendingGovernance": [p.to_wire() for p in self.pending_governance],
            "effects": [e.to_wire() for e in self.effects],
            "blockers": [b.to_wire() for b in self.blockers],
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
        }


@dataclass(frozen=True)
class HealthReport:
    status: str
    protocol_version: int
    schema_version: int
    compiler_version: str
    database: dict[str, Any]
    store: dict[str, Any]
    bridge: dict[str, Any]
    checked_at: str
    issues: list[str] = field(default_factory=list)

    def to_wire(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "protocolVersion": self.protocol_version,
            "schemaVersion": self.schema_version,
            "compilerVersion": self.compiler_version,
            "database": self.database,
            "store": self.store,
            "bridge": self.bridge,
            "checkedAt": self.checked_at,
            "issues": self.issues,
        }


@dataclass(frozen=True)
class MigrationPreview:
    run_id: str
    source_graph_version: int
    target_graph_version: int
    plan_hash: str
    quiescent: bool
    blockers: list[Blocker]
    node_mapping: list[dict[str, str]]
    invalidations: list[dict[str, str]]
    pending_governance: list[dict[str, str]]

    def to_wire(self) -> dict[str, Any]:
        return {
            "runId": self.run_id,
            "sourceGraphVersion": self.source_graph_version,
            "targetGraphVersion": self.target_graph_version,
            "planHash": self.plan_hash,
            "quiescent": self.quiescent,
            "blockers": [b.to_wire() for b in self.blockers],
            "nodeMapping": self.node_mapping,
            "invalidations": self.invalidations,
            "pendingGovernance": self.pending_governance,
        }


@dataclass(frozen=True)
class MutationEnvelope:
    """The write envelope.

    ``scope`` is *not* a body field. It is injected by the transport layer from the
    verified assertion; the HTTP layer must never copy it from caller input, which is
    exactly why the decoder takes it as a separate argument.
    """

    schema_version: int
    command_id: str
    idempotency_key: str
    correlation_id: str
    run_id: str
    node_id: str | None = None
    iteration: int | None = None
    attempt_id: str | None = None
    lease_epoch: int | None = None
    expected_state_version: int | None = None
    contract_hash: str | None = None
    payload: dict[str, Any] = field(default_factory=dict)
    causation_id: str | None = None
    scope: Scope | None = None

    @staticmethod
    def from_wire(value: Mapping[str, Any], *, scope: Scope | None = None) -> "MutationEnvelope":
        iteration = value.get("iteration")
        epoch = value.get("leaseEpoch")
        expected = value.get("expectedStateVersion")
        return MutationEnvelope(
            schema_version=int(value.get("schemaVersion", 1)),
            command_id=str(value.get("commandId", "")),
            idempotency_key=str(value.get("idempotencyKey", "")),
            correlation_id=str(value.get("correlationId", "")),
            run_id=str(value.get("runId", "")),
            node_id=None if value.get("nodeId") is None else str(value["nodeId"]),
            iteration=None if iteration is None else int(iteration),
            attempt_id=None if value.get("attemptId") is None else str(value["attemptId"]),
            lease_epoch=None if epoch is None else int(epoch),
            expected_state_version=None if expected is None else int(expected),
            contract_hash=None if value.get("contractHash") is None else str(value["contractHash"]),
            payload=dict(value.get("payload") or {}),
            causation_id=None if value.get("causationId") is None else str(value["causationId"]),
            scope=scope,
        )


# Re-exported so callers do not have to import two modules for one enum.
GraphRun = GraphRunStatus
NodeStatusEnum = NodeStatus
AttemptStatusEnum = AttemptStatus
BlockReasonEnum = BlockReason
EvaluatorKindEnum = EvaluatorKind
NodeKindEnum = NodeKind
JoinSemanticsEnum = JoinSemantics
