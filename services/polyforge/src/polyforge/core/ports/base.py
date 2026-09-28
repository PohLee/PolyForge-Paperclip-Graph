"""Provider-neutral ports.

Responsibility: declare, in Core-owned types, everything the Runtime needs from the
platform — and nothing about how it is provided. The Core never imports a Paperclip SDK
type and never reads a Paperclip database; every platform object crosses this boundary as
an opaque :class:`ProviderRef`.

Mirrors ``packages/protocol/src/ports.ts`` and ``port-types.ts``.

Invariants (``docs/05-PROTOCOL.md`` section 9):

* Every mutation returns a durable operation or reference and may be *pending*. A UI hook
  is not a message bus, so nothing here may block waiting for a human.
* An unsupported capability returns an explainable ``BLOCKED``/``UNSUPPORTED`` error. It
  never returns a fake success and never downgrades an authorization check to a
  confirmation.
* Read-only displays may degrade; execution authorization, identity verification, and
  durable reconciliation may not. :class:`NullPorts` therefore raises for the mutating
  methods and the engine degrades to a ``read_only`` health report instead of pretending
  the platform answered.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping, Protocol, Sequence, runtime_checkable

from polyforge.core import errors
from polyforge.core.store.models import ProviderRef, Scope

__all__ = [
    "ArtifactPort",
    "ArtifactUpload",
    "AuthorizationRequest",
    "AuthorizationStatus",
    "CommandMeta",
    "DecisionRequest",
    "DispatchBinding",
    "DispatchReceipt",
    "ExactAction",
    "ExecutionObservation",
    "GovernancePort",
    "InteractionRequest",
    "NullPorts",
    "ObservabilityPort",
    "Ports",
    "ProgressProjection",
    "StatusProjection",
    "StopReceipt",
    "VerifiedArtifact",
    "VerifiedResolution",
    "WorkerCandidate",
    "WorkerRequirement",
    "WorkManagementPort",
    "WorkUnitIntent",
    "WorkspaceBinding",
    "WorkspaceMode",
    "WorkspaceObservation",
    "WorkspacePort",
    "WorkspaceRequirement",
]


@dataclass(frozen=True)
class CommandMeta:
    """Correlation carried on every port call so an intent is traceable back to a run."""

    command_id: str
    idempotency_key: str
    correlation_id: str
    causation_id: str | None = None
    expected_version: int | None = None

    def to_wire(self) -> dict[str, Any]:
        return {
            "commandId": self.command_id,
            "idempotencyKey": self.idempotency_key,
            "correlationId": self.correlation_id,
            "causationId": self.causation_id,
            "expectedVersion": self.expected_version,
        }


WorkspaceMode = str  # "read_write" | "read_only_snapshot" | "reuse_serially"


@dataclass(frozen=True)
class WorkspaceRequirement:
    mode: str = "read_write"
    repositories: tuple[Mapping[str, Any], ...] = ()
    require_read_only_for_reviewer: bool = False

    def to_wire(self) -> dict[str, Any]:
        return {
            "mode": self.mode,
            "repositories": [dict(r) for r in self.repositories],
            "requireReadOnlyForReviewer": self.require_read_only_for_reviewer,
        }


@dataclass(frozen=True)
class WorkspaceBinding:
    workspace_ref: Mapping[str, Any]
    path: str | None = None
    branch: str | None = None
    commits: tuple[Mapping[str, Any], ...] = ()
    read_only: bool = False

    def to_wire(self) -> dict[str, Any]:
        return {
            "workspaceRef": dict(self.workspace_ref),
            "path": self.path,
            "branch": self.branch,
            "commits": [dict(c) for c in self.commits],
            "readOnly": self.read_only,
        }


@dataclass(frozen=True)
class WorkspaceObservation:
    exists: bool
    path: str | None = None
    branch: str | None = None
    commits: tuple[Mapping[str, Any], ...] = ()
    readable: bool = False
    writable: bool = False
    problems: tuple[str, ...] = ()

    def to_wire(self) -> dict[str, Any]:
        return {
            "exists": self.exists,
            "path": self.path,
            "branch": self.branch,
            "commits": [dict(c) for c in self.commits],
            "readable": self.readable,
            "writable": self.writable,
            "problems": list(self.problems),
        }


@dataclass(frozen=True)
class WorkUnitIntent:
    scope: Scope
    run_id: str
    node_id: str
    iteration: int
    title: str
    description: str
    correlation_key: str
    required_capabilities: tuple[str, ...] = ()
    parent_issue_ref: Mapping[str, Any] | None = None
    workspace_requirement: WorkspaceRequirement = field(default_factory=WorkspaceRequirement)
    labels: tuple[str, ...] = ()

    def to_wire(self) -> dict[str, Any]:
        return {
            "scope": self.scope.to_wire(),
            "runId": self.run_id,
            "nodeId": self.node_id,
            "iteration": self.iteration,
            "title": self.title,
            "description": self.description,
            "correlationKey": self.correlation_key,
            "requiredCapabilities": list(self.required_capabilities),
            "parentIssueRef": dict(self.parent_issue_ref) if self.parent_issue_ref else None,
            "workspaceRequirement": self.workspace_requirement.to_wire(),
            "labels": list(self.labels),
        }


@dataclass(frozen=True)
class StatusProjection:
    scope: Scope
    run_id: str
    projection_sequence: int
    target: Mapping[str, Any]
    status: str
    summary: str
    node_states: tuple[Mapping[str, Any], ...] = ()
    correlation_id: str = ""
    origin: str = "polyforge"

    def to_wire(self) -> dict[str, Any]:
        return {
            "scope": self.scope.to_wire(),
            "runId": self.run_id,
            "projectionSequence": self.projection_sequence,
            "target": dict(self.target),
            "status": self.status,
            "summary": self.summary,
            "nodeStates": [dict(n) for n in self.node_states],
            "origin": self.origin,
            "correlationId": self.correlation_id,
        }


@dataclass(frozen=True)
class WorkerRequirement:
    scope: Scope
    run_id: str
    node_id: str
    required_capabilities: tuple[str, ...] = ()
    preferred_roles: tuple[str, ...] = ()
    fallback_roles: tuple[str, ...] = ()
    independent_from: tuple[Mapping[str, Any], ...] = ()
    exclude_subjects: tuple[str, ...] = ()

    def to_wire(self) -> dict[str, Any]:
        return {
            "scope": self.scope.to_wire(),
            "runId": self.run_id,
            "nodeId": self.node_id,
            "requiredCapabilities": list(self.required_capabilities),
            "preferredRoles": list(self.preferred_roles),
            "fallbackRoles": list(self.fallback_roles),
            "independentFrom": [dict(i) for i in self.independent_from],
            "excludeSubjects": list(self.exclude_subjects),
        }


@dataclass(frozen=True)
class WorkerCandidate:
    subject_ref: str
    provider_ref: Mapping[str, Any]
    matched_capabilities: tuple[str, ...] = ()
    independence_satisfied: bool = True
    reasons: tuple[str, ...] = ()

    def to_wire(self) -> dict[str, Any]:
        return {
            "subjectRef": self.subject_ref,
            "providerRef": dict(self.provider_ref),
            "matchedCapabilities": list(self.matched_capabilities),
            "independenceSatisfied": self.independence_satisfied,
            "reasons": list(self.reasons),
        }


@dataclass(frozen=True)
class DispatchBinding:
    scope: Scope
    run_id: str
    node_id: str
    iteration: int
    attempt_id: str
    work_unit_ref: Mapping[str, Any]
    worker_subject_ref: str
    contract_hash: str
    workspace_ref: Mapping[str, Any] | None = None

    def to_wire(self) -> dict[str, Any]:
        return {
            "scope": self.scope.to_wire(),
            "runId": self.run_id,
            "nodeId": self.node_id,
            "iteration": self.iteration,
            "attemptId": self.attempt_id,
            "workUnitRef": dict(self.work_unit_ref),
            "workerSubjectRef": self.worker_subject_ref,
            "contractHash": self.contract_hash,
            "workspaceRef": dict(self.workspace_ref) if self.workspace_ref else None,
        }


@dataclass(frozen=True)
class DispatchReceipt:
    work_unit_ref: Mapping[str, Any]
    work_unit_key: str
    agent_run_ref: Mapping[str, Any] | None = None
    queued: bool = False
    reason: str | None = None

    def to_wire(self) -> dict[str, Any]:
        return {
            "workUnitRef": dict(self.work_unit_ref),
            "workUnitKey": self.work_unit_key,
            "agentRunRef": dict(self.agent_run_ref) if self.agent_run_ref else None,
            "queued": self.queued,
            "reason": self.reason,
        }


@dataclass(frozen=True)
class StopReceipt:
    requested: bool
    outcome: str = "unknown"  # confirmed_stopped | not_found | already_terminal | unknown
    observed_at: str = ""

    def to_wire(self) -> dict[str, Any]:
        return {
            "requested": self.requested,
            "outcome": self.outcome,
            "observedAt": self.observed_at,
        }


@dataclass(frozen=True)
class ExecutionObservation:
    provider_ref: Mapping[str, Any]
    state: str = "unknown"  # running | succeeded | failed | cancelled | unknown
    started_at: str | None = None
    finished_at: str | None = None
    exit_reason: str | None = None
    effect_outcome: str | None = None  # effected | not_effected | unknown
    artifacts: tuple[Mapping[str, Any], ...] = ()

    def to_wire(self) -> dict[str, Any]:
        return {
            "providerRef": dict(self.provider_ref),
            "state": self.state,
            "startedAt": self.started_at,
            "finishedAt": self.finished_at,
            "exitReason": self.exit_reason,
            "effectOutcome": self.effect_outcome,
            "artifacts": [dict(a) for a in self.artifacts],
        }


@dataclass(frozen=True)
class InteractionRequest:
    scope: Scope
    target_issue_ref: Mapping[str, Any]
    kind: str  # clarification | review | confirmation
    semantic_kind: str
    question: str
    decision_target_hash: str
    correlation_id: str
    options: tuple[Mapping[str, Any], ...] = ()
    required_resolver: str = "anyone"  # anyone | not_creator | human_only
    capability_ref: str | None = None

    def to_wire(self) -> dict[str, Any]:
        return {
            "scope": self.scope.to_wire(),
            "targetIssueRef": dict(self.target_issue_ref),
            "kind": self.kind,
            "semanticKind": self.semantic_kind,
            "question": self.question,
            "options": [dict(o) for o in self.options],
            "decisionTargetHash": self.decision_target_hash,
            "correlationId": self.correlation_id,
            "requiredResolver": self.required_resolver,
            "capabilityRef": self.capability_ref,
        }


@dataclass(frozen=True)
class DecisionRequest:
    scope: Scope
    target_issue_ref: Mapping[str, Any]
    semantic_kind: str
    question: str
    options: tuple[Mapping[str, Any], ...]
    decision_target_hash: str
    correlation_id: str
    effects: tuple[Mapping[str, Any], ...] = ()

    def to_wire(self) -> dict[str, Any]:
        return {
            "scope": self.scope.to_wire(),
            "targetIssueRef": dict(self.target_issue_ref),
            "semanticKind": self.semantic_kind,
            "question": self.question,
            "options": [dict(o) for o in self.options],
            "decisionTargetHash": self.decision_target_hash,
            "correlationId": self.correlation_id,
            "effects": [dict(e) for e in self.effects],
        }


@dataclass(frozen=True)
class AuthorizationRequest:
    scope: Scope
    action: str
    resource: str
    environment: str
    authority: str
    policy_ref: str
    input_hashes: Mapping[str, str]
    transition_hash: str
    expires_at: str
    justification: str

    def to_wire(self) -> dict[str, Any]:
        return {
            "scope": self.scope.to_wire(),
            "action": self.action,
            "resource": self.resource,
            "environment": self.environment,
            "authority": self.authority,
            "policyRef": self.policy_ref,
            "inputHashes": dict(self.input_hashes),
            "transitionHash": self.transition_hash,
            "expiresAt": self.expires_at,
            "justification": self.justification,
        }


@dataclass(frozen=True)
class VerifiedResolution:
    provider_ref: Mapping[str, Any]
    outcome: str
    responder_subject: str
    responder_kind: str
    target_hash_verified: bool
    detail: Mapping[str, Any] = field(default_factory=dict)
    recorded_at: str = ""

    def to_wire(self) -> dict[str, Any]:
        return {
            "providerRef": dict(self.provider_ref),
            "outcome": self.outcome,
            "responderSubject": self.responder_subject,
            "responderKind": self.responder_kind,
            "targetHashVerified": self.target_hash_verified,
            "detail": dict(self.detail),
            "recordedAt": self.recorded_at,
        }


@dataclass(frozen=True)
class ExactAction:
    action: str
    resource: str
    environment: str
    input_hashes: Mapping[str, str]
    transition_hash: str

    def to_wire(self) -> dict[str, Any]:
        return {
            "action": self.action,
            "resource": self.resource,
            "environment": self.environment,
            "inputHashes": dict(self.input_hashes),
            "transitionHash": self.transition_hash,
        }


@dataclass(frozen=True)
class AuthorizationStatus:
    granted: bool
    reason: str = ""
    expires_at: str | None = None
    revoked: bool = False
    exact_match: bool = False

    def to_wire(self) -> dict[str, Any]:
        return {
            "granted": self.granted,
            "reason": self.reason,
            "expiresAt": self.expires_at,
            "revoked": self.revoked,
            "exactMatch": self.exact_match,
        }


@dataclass(frozen=True)
class ArtifactUpload:
    scope: Scope
    kind: str
    content_hash: str
    media_type: str
    size: int
    source: Mapping[str, Any]
    repository: Mapping[str, Any] | None = None

    def to_wire(self) -> dict[str, Any]:
        return {
            "scope": self.scope.to_wire(),
            "kind": self.kind,
            "contentHash": self.content_hash,
            "mediaType": self.media_type,
            "size": self.size,
            "source": dict(self.source),
            "repository": dict(self.repository) if self.repository else None,
        }


@dataclass(frozen=True)
class VerifiedArtifact:
    ref: Mapping[str, Any]
    kind: str
    content_hash: str
    media_type: str
    size: int
    digest_verified: bool
    immutable: bool
    repository: Mapping[str, Any] | None = None

    def to_wire(self) -> dict[str, Any]:
        return {
            "ref": dict(self.ref),
            "kind": self.kind,
            "contentHash": self.content_hash,
            "mediaType": self.media_type,
            "size": self.size,
            "digestVerified": self.digest_verified,
            "immutable": self.immutable,
            "repository": dict(self.repository) if self.repository else None,
        }


@dataclass(frozen=True)
class ProgressProjection:
    scope: Scope
    run_id: str
    projection_sequence: int
    kind: str  # run | node | gate | evidence | effect
    payload: Mapping[str, Any]
    correlation_id: str = ""

    def to_wire(self) -> dict[str, Any]:
        return {
            "scope": self.scope.to_wire(),
            "runId": self.run_id,
            "projectionSequence": self.projection_sequence,
            "kind": self.kind,
            "payload": dict(self.payload),
            "correlationId": self.correlation_id,
        }


@runtime_checkable
class WorkManagementPort(Protocol):
    """Work units, status projection, worker resolution, dispatch, stop, inspection."""

    def ensure_work_unit(self, intent: WorkUnitIntent, meta: CommandMeta) -> Mapping[str, Any]: ...

    def project_status(self, projection: StatusProjection, meta: CommandMeta) -> None: ...

    def resolve_worker(self, requirement: WorkerRequirement) -> Sequence[WorkerCandidate]: ...

    def assign_and_wake(
        self, binding: DispatchBinding, meta: CommandMeta
    ) -> DispatchReceipt: ...

    def request_stop(self, ref: Mapping[str, Any], meta: CommandMeta) -> StopReceipt: ...

    def inspect_execution(self, ref: Mapping[str, Any]) -> ExecutionObservation: ...


@runtime_checkable
class GovernancePort(Protocol):
    """Human/agent interactions, engineering decisions, and exact-action authorization."""

    def request_interaction(
        self, req: InteractionRequest, meta: CommandMeta
    ) -> Mapping[str, Any]: ...

    def request_engineering_decision(
        self, req: DecisionRequest, meta: CommandMeta
    ) -> Mapping[str, Any]: ...

    def request_action_authorization(
        self, req: AuthorizationRequest, meta: CommandMeta
    ) -> Mapping[str, Any]: ...

    def read_verified_resolution(
        self, ref: Mapping[str, Any]
    ) -> VerifiedResolution | None: ...

    def check_authorization(
        self, ref: Mapping[str, Any], action: ExactAction
    ) -> AuthorizationStatus: ...


@runtime_checkable
class WorkspacePort(Protocol):
    """Workspace resolution and inspection. A reviewer must get a read-only snapshot."""

    def resolve(
        self, req: WorkspaceRequirement, meta: CommandMeta
    ) -> WorkspaceBinding: ...

    def inspect(self, binding: WorkspaceBinding) -> WorkspaceObservation: ...


@runtime_checkable
class ArtifactPort(Protocol):
    """Artifact publication and verified re-read."""

    def publish(self, req: ArtifactUpload, meta: CommandMeta) -> Mapping[str, Any]: ...

    def read_verified(self, ref: Mapping[str, Any]) -> VerifiedArtifact: ...


@runtime_checkable
class ObservabilityPort(Protocol):
    """Progress projection only. Never a substitute for a durable event."""

    def publish_progress(self, event: ProgressProjection, meta: CommandMeta) -> None: ...


@dataclass(frozen=True)
class Ports:
    work: WorkManagementPort
    governance: GovernancePort
    workspace: WorkspacePort
    artifacts: ArtifactPort
    observability: ObservabilityPort

    @property
    def complete(self) -> bool:
        return all(
            p is not None
            for p in (self.work, self.governance, self.workspace, self.artifacts, self.observability)
        )


def _unsupported(port: str, operation: str, **detail: Any) -> errors.PolyForgeError:
    # Only include detail the caller actually supplied, and read it defensively: the point of
    # this error is to explain the refusal, not to fail while explaining it.
    return errors.PolyForgeError(
        errors.ErrorCode.UNSUPPORTED,
        (
            f"{port}.{operation} is not available: this Runtime has no bridge ports configured. "
            "Execution, authorization, identity verification, and durable reconciliation may not "
            "degrade to a plain confirmation"
        ),
        details={"port": port, "operation": operation, **detail},
    )


@dataclass(frozen=True)
class NullPorts:
    """Ports that refuse every call with a precise ``UNSUPPORTED`` error.

    Used by unit tests and by a Core started without a bridge. Every method raises rather
    than returning an empty success, so a missing bridge produces a block the operator can
    see instead of a run that quietly believes it dispatched work.
    """

    work: Any = None
    governance: Any = None
    workspace: Any = None
    artifacts: Any = None
    observability: Any = None

    # -- WorkManagementPort ------------------------------------------------

    def ensure_work_unit(self, intent: WorkUnitIntent, meta: CommandMeta) -> Mapping[str, Any]:
        raise _unsupported("work", "ensureWorkUnit", correlationKey=getattr(intent, "correlation_key", None))

    def project_status(self, projection: StatusProjection, meta: CommandMeta) -> None:
        raise _unsupported("work", "projectStatus", runId=getattr(projection, "run_id", None))

    def resolve_worker(self, requirement: WorkerRequirement) -> Sequence[WorkerCandidate]:
        raise _unsupported("work", "resolveWorker", runId=getattr(requirement, "run_id", None))

    def assign_and_wake(self, binding: DispatchBinding, meta: CommandMeta) -> DispatchReceipt:
        raise _unsupported("work", "assignAndWake", runId=getattr(binding, "run_id", None))

    def request_stop(self, ref: Mapping[str, Any], meta: CommandMeta) -> StopReceipt:
        raise _unsupported("work", "requestStop")

    def inspect_execution(self, ref: Mapping[str, Any]) -> ExecutionObservation:
        raise _unsupported("work", "inspectExecution")

    # -- GovernancePort ----------------------------------------------------

    def request_interaction(
        self, req: InteractionRequest, meta: CommandMeta
    ) -> Mapping[str, Any]:
        raise _unsupported("governance", "requestInteraction", semanticKind=getattr(req, "semantic_kind", None))

    def request_engineering_decision(
        self, req: DecisionRequest, meta: CommandMeta
    ) -> Mapping[str, Any]:
        raise _unsupported("governance", "requestEngineeringDecision", semanticKind=getattr(req, "semantic_kind", None))

    def request_action_authorization(
        self, req: AuthorizationRequest, meta: CommandMeta
    ) -> Mapping[str, Any]:
        raise _unsupported("governance", "requestActionAuthorization", action=getattr(req, "action", None))

    def read_verified_resolution(self, ref: Mapping[str, Any]) -> VerifiedResolution | None:
        raise _unsupported("governance", "readVerifiedResolution")

    def check_authorization(
        self, ref: Mapping[str, Any], action: ExactAction
    ) -> AuthorizationStatus:
        raise _unsupported("governance", "checkAuthorization", action=getattr(action, "action", None))

    # -- WorkspacePort -----------------------------------------------------

    def resolve(self, req: WorkspaceRequirement, meta: CommandMeta) -> WorkspaceBinding:
        raise _unsupported("workspace", "resolve", mode=getattr(req, "mode", None))

    def inspect(self, binding: WorkspaceBinding) -> WorkspaceObservation:
        raise _unsupported("workspace", "inspect")

    # -- ArtifactPort ------------------------------------------------------

    def publish(self, req: ArtifactUpload, meta: CommandMeta) -> Mapping[str, Any]:
        raise _unsupported("artifacts", "publish", kind=getattr(req, "kind", None))

    def read_verified(self, ref: Mapping[str, Any]) -> VerifiedArtifact:
        raise _unsupported("artifacts", "readVerified")

    # -- ObservabilityPort -------------------------------------------------

    def publish_progress(self, event: ProgressProjection, meta: CommandMeta) -> None:
        raise _unsupported("observability", "publishProgress", kind=getattr(event, "kind", None))

    def as_ports(self) -> Ports:
        return Ports(
            work=self, governance=self, workspace=self, artifacts=self, observability=self
        )


def provider_ref(value: Any) -> ProviderRef:
    """Normalize a mapping into a :class:`ProviderRef`, rejecting a malformed one."""
    ref = ProviderRef.from_wire(value)
    if ref is None or not ref.provider or not ref.id:
        raise errors.bad_request(
            "a provider reference must be {provider, kind, id}; a bare id is not resolvable"
        )
    return ref
