"""Authoritative PolyForge state vocabulary.

These are the only states the Graph Core may persist. Paperclip issue statuses are a
*projection* of these values, never a substitute. An issue dragged to ``done`` produces a
completion observation that still has to clear its gate.

Mirrors ``packages/protocol/src/enums.ts``.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Final, Literal

__all__ = [
    "ATTEMPT_STATUSES",
    "BLOCK_REASONS",
    "EVALUATOR_KINDS",
    "AttemptStatus",
    "BlockReason",
    "EvaluatorKind",
    "GraphRunStatus",
    "JoinSemantics",
    "NodeKind",
    "NodeStatus",
    "ProjectedIssueStatus",
    "project_issue_status",
]


class GraphRunStatus(StrEnum):
    CREATED = "CREATED"
    ACTIVE = "ACTIVE"
    WAITING = "WAITING"
    PAUSED = "PAUSED"
    BLOCKED = "BLOCKED"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"


class NodeStatus(StrEnum):
    PENDING = "PENDING"
    READY = "READY"
    DISPATCH_REQUESTED = "DISPATCH_REQUESTED"
    RUNNING = "RUNNING"
    EVIDENCE_READY = "EVIDENCE_READY"
    EVALUATING = "EVALUATING"
    WAITING_GOVERNANCE = "WAITING_GOVERNANCE"
    PASSED = "PASSED"
    REWORK_REQUIRED = "REWORK_REQUIRED"
    FAILED = "FAILED"
    BLOCKED = "BLOCKED"
    SKIPPED = "SKIPPED"


class AttemptStatus(StrEnum):
    PREPARED = "PREPARED"
    RUNNING = "RUNNING"
    CHECKPOINTED = "CHECKPOINTED"
    EVIDENCE_READY = "EVIDENCE_READY"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"
    UNKNOWN = "UNKNOWN"
    RECONCILING = "RECONCILING"


class BlockReason(StrEnum):
    """Every ``BLOCKED`` state names an explainable, non-forgeable cause."""

    BUDGET = "BLOCKED_BUDGET"
    PLATFORM = "BLOCKED_PLATFORM"
    WORKSPACE = "BLOCKED_WORKSPACE"
    AUTHORIZATION = "BLOCKED_AUTHORIZATION"
    GOVERNANCE = "BLOCKED_GOVERNANCE"
    STALE_INPUT = "BLOCKED_STALE_INPUT"
    EFFECT_UNKNOWN = "BLOCKED_EFFECT_UNKNOWN"
    DEPENDENCY = "BLOCKED_DEPENDENCY"
    LEASE_FENCED = "BLOCKED_LEASE_FENCED"
    SCOPE = "BLOCKED_SCOPE"


class EvaluatorKind(StrEnum):
    AUTOMATIC = "automatic"
    INDEPENDENT_AGENT = "independent_agent"
    HUMAN_DECISION = "human_decision"


class NodeKind(StrEnum):
    AGENT_OPERATION = "agent_operation"
    DETERMINISTIC = "deterministic"
    GATE = "gate"
    SUBGRAPH = "subgraph"
    EXTERNAL_EFFECT = "external_effect"


class JoinSemantics(StrEnum):
    ALL = "all"
    ANY = "any"
    QUORUM = "quorum"


ProjectedIssueStatus = Literal[
    "backlog",
    "todo",
    "in_progress",
    "in_review",
    "blocked",
    "done",
    "cancelled",
]

GRAPH_RUN_STATUSES: Final[tuple[str, ...]] = tuple(s.value for s in GraphRunStatus)
NODE_STATUSES: Final[tuple[str, ...]] = tuple(s.value for s in NodeStatus)
ATTEMPT_STATUSES: Final[tuple[str, ...]] = tuple(s.value for s in AttemptStatus)
BLOCK_REASONS: Final[tuple[str, ...]] = tuple(s.value for s in BlockReason)
EVALUATOR_KINDS: Final[tuple[str, ...]] = tuple(s.value for s in EvaluatorKind)
NODE_KINDS: Final[tuple[str, ...]] = tuple(s.value for s in NodeKind)
JOIN_SEMANTICS: Final[tuple[str, ...]] = tuple(s.value for s in JoinSemantics)

_TERMINAL_RUN_STATUSES: Final[frozenset[GraphRunStatus]] = frozenset(
    {GraphRunStatus.COMPLETED, GraphRunStatus.FAILED, GraphRunStatus.CANCELLED}
)

# Status projection table (docs/01-REQUIREMENTS.md REQ-WORK-04, docs/02 section 8.4).
# ``None`` means the projection deliberately declines to guess; the UI must then show the
# value as unknown rather than as a pass.
_PROJECTION: Final[dict[NodeStatus, ProjectedIssueStatus | None]] = {
    NodeStatus.PENDING: "backlog",
    NodeStatus.READY: "todo",
    NodeStatus.DISPATCH_REQUESTED: "todo",
    NodeStatus.RUNNING: "in_progress",
    NodeStatus.EVIDENCE_READY: "in_progress",
    NodeStatus.EVALUATING: "in_progress",
    NodeStatus.WAITING_GOVERNANCE: "in_review",
    NodeStatus.PASSED: "done",
    NodeStatus.REWORK_REQUIRED: "todo",
    NodeStatus.FAILED: "blocked",
    NodeStatus.BLOCKED: "blocked",
    NodeStatus.SKIPPED: "done",
}

_RUN_PROJECTION: Final[dict[GraphRunStatus, ProjectedIssueStatus]] = {
    GraphRunStatus.CREATED: "in_progress",
    GraphRunStatus.ACTIVE: "in_progress",
    GraphRunStatus.WAITING: "in_progress",
    GraphRunStatus.PAUSED: "in_progress",
    GraphRunStatus.BLOCKED: "blocked",
    GraphRunStatus.COMPLETED: "done",
    GraphRunStatus.FAILED: "blocked",
    GraphRunStatus.CANCELLED: "cancelled",
}


def is_terminal_run_status(status: GraphRunStatus) -> bool:
    return status in _TERMINAL_RUN_STATUSES


def project_issue_status(
    status: GraphRunStatus | NodeStatus,
    *,
    waiting_governance: bool = False,
) -> ProjectedIssueStatus | None:
    """Project an authoritative state onto a Paperclip issue status.

    The caller is responsible for carrying the origin marker so the UI can label where the
    status came from; a projection is never evidence of engineering correctness.
    """
    if status == NodeStatus.WAITING_GOVERNANCE:
        return "in_review"
    if isinstance(status, GraphRunStatus):
        if waiting_governance and status in (GraphRunStatus.ACTIVE, GraphRunStatus.WAITING):
            return "in_review"
        return _RUN_PROJECTION.get(status)
    return _PROJECTION.get(status)
