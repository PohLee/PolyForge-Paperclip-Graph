"""The single-writer command processor.

Responsibility: every state change a GraphRun can undergo passes through exactly one method
on this class, inside exactly one Core transaction, with a recorded command result. Nothing
else may write engineering state.

Invariants (``docs/05-PROTOCOL.md`` sections 5-8, ``docs/02-TECHNICAL-PLAN.md`` sections
6-10):

* **One transaction per committed transition.** A committing command writes the semantic
  mutation, the gate result, the checkpoint, the domain event, the outbox intent, and the
  command result together, or writes none of them.
* **Only one path can produce a pass.** ``request_transition`` with every mandatory
  evaluator passing is the sole writer of ``PASSED``. An issue dragged to ``done``, an
  ``agent.run.finished`` observation, and a human confirmation are all *observations*: they
  are recorded and, at most, they trigger a re-evaluation.
* **Fencing before content.** Every worker write checks the active claim's ``lease_epoch``
  first. A stale epoch is refused and stored as an isolated diagnostic that never mutates run
  state — the diagnostic is written after the rollback, so it survives it.
* **Idempotency by identity, not by HTTP attempt.** Each behavior has its own key
  (``docs/05`` section 8.1). Same key + same payload returns the recorded result; same key +
  different payload is ``409 IDEMPOTENCY_CONFLICT``; a stale ``expectedStateVersion`` is
  ``409 VERSION_CONFLICT`` carrying ``currentVersion``.
* **Waiting never occupies a thread.** ``WAITING_GOVERNANCE`` releases the worker, records a
  durable governance intent carrying a ``decisionTargetHash``, and returns.
* **No silent degradation.** With ``ports=None`` the engine still serves reads and reports
  ``read_only`` health, and any command that would need the platform fails with a blocker. It
  never invents a success.
* **The registry owns published versions.** Drafts, versions, the active-default pointer and
  their audit trail are written by ``RegistryStore`` alone. This engine reads them through
  ``get_version`` / ``get_active_version`` and never from a table of its own, so there is one
  authoritative answer to "which version is published, and which one is the default". With no
  registry injected it refuses rather than guessing, and health says ``blocked``.
"""

from __future__ import annotations

from dataclasses import replace
from typing import Any, Mapping, Sequence

from polyforge import COMPILER_VERSION, PROTOCOL_VERSION, SCHEMA_VERSION
from polyforge.core import errors, hashing, ids
from polyforge.core.contracts.policy import (
    EffectivePolicy,
    PlatformGrants,
    PolicyContext,
    PolicyRule,
    resolve_policy,
)
from polyforge.core.contracts.transition import (
    RequiredEvaluator,
    build_contract,
    decision_target_hash,
)
from polyforge.core.evidence.store import EvidenceCandidate, EvidenceStore, is_content_hash
from polyforge.core.gates.aggregate import GateResult, aggregate_gate
from polyforge.core.gates.evaluators import EvaluationContext, default_registry
from polyforge.core.runtime.effects import EffectLedger
from polyforge.core.runtime.planner import (
    ExecutionPlan,
    PlanNode,
    build_plan,
    compute_plan_hash,
    plan_states,
)
from polyforge.core.state import (
    AttemptStatus,
    BlockReason,
    EvaluatorKind,
    GraphRunStatus,
    NodeStatus,
)
from polyforge.core.store.db import Database, dumps, loads
from polyforge.core.store.models import (
    ArtifactRef,
    Blocker,
    CommandResult,
    DomainEvent,
    EffectRecord,
    EvidenceRecord,
    ExecutionAttempt,
    GateEvaluationRecord,
    GovernanceResolution,
    HealthReport,
    MigrationPreview,
    MutationEnvelope,
    NodeExecutionView,
    PendingGovernance,
    RunSnapshot,
    Scope,
    is_pf_event,
)

__all__ = ["OUTBOX_KINDS", "RuntimeEngine"]

#: Every outbound intent kind the Core emits. The bridge maps these onto port calls; the Core
#: never calls the platform directly.
OUTBOX_KINDS: tuple[str, ...] = (
    "work.unit.ensure",
    "work.dispatch",
    "work.stop",
    "status.project",
    "governance.request",
    "governance.decision",
    "governance.authorization",
    "effect.deliver",
    "artifact.publish",
    "migration.applied",
)

_DEFAULT_EVALUATORS: tuple[str, ...] = ("contract_schema_v1", "required_evidence_present")

#: Codes whose refusal is worth keeping as an audit record. A ``NOT_FOUND`` on an unrelated
#: object is a caller mistake, not an incident.
_REFUSAL_CODES = frozenset(
    {
        errors.ErrorCode.LEASE_FENCED,
        errors.ErrorCode.VERSION_CONFLICT,
        errors.ErrorCode.IDEMPOTENCY_CONFLICT,
        errors.ErrorCode.EVIDENCE_INVALID,
        errors.ErrorCode.SCOPE_VIOLATION,
        errors.ErrorCode.CONTRACT_INVALID,
        errors.ErrorCode.AUTHORIZATION_DENIED,
        errors.ErrorCode.RUN_BLOCKED,
    }
)

COMMAND_CAPABILITIES: Mapping[str, str] = {
    "pause": "run.control",
    "resume": "run.control",
    "cancel": "run.control",
    "retry": "run.execute",
    "resolve_block": "run.resolve_block",
}

RUN_COMMANDS: tuple[str, ...] = tuple(COMMAND_CAPABILITIES)

_TERMINAL_RUN = frozenset(
    {GraphRunStatus.COMPLETED, GraphRunStatus.FAILED, GraphRunStatus.CANCELLED}
)

_CLAIMABLE_NODE_STATES = frozenset(
    {
        NodeStatus.READY,
        NodeStatus.DISPATCH_REQUESTED,
        NodeStatus.RUNNING,
        NodeStatus.EVIDENCE_READY,
        NodeStatus.EVALUATING,
        NodeStatus.WAITING_GOVERNANCE,
        NodeStatus.REWORK_REQUIRED,
    }
)

_RUNNING_ATTEMPT_STATES = frozenset({AttemptStatus.RUNNING, AttemptStatus.CHECKPOINTED})


class RuntimeEngine:
    """The durable Graph Core command/query surface."""

    def __init__(
        self,
        db: Database,
        *,
        clock: Any | None = None,
        ports: Any | None = None,
        registry: Any | None = None,
        bridge_issuer: str | None = None,
        bridge_expected_issuer: str | None = None,
        lease_ttl_seconds: float = 900.0,
        evidence_freshness_seconds: int | None = 3600,
        max_delivery_attempts: int = 8,
        default_max_rework: int = 3,
    ) -> None:
        self.db = db
        self.clock = clock if clock is not None else db.clock
        self.ports = ports
        self.registry = registry
        self.bridge_issuer = bridge_issuer
        self.bridge_expected_issuer = bridge_expected_issuer
        self.lease_ttl_seconds = lease_ttl_seconds
        self.evidence_freshness_seconds = evidence_freshness_seconds
        self.max_delivery_attempts = max_delivery_attempts
        self.default_max_rework = default_max_rework
        self.evidence = EvidenceStore(db, clock=self.clock)
        self.effects = EffectLedger(db, clock=self.clock)
        self.evaluators = default_registry()

    # ------------------------------------------------------------------
    # clock and scope
    # ------------------------------------------------------------------

    def _now(self) -> str:
        return self.clock.iso() if hasattr(self.clock, "iso") else ids.now_iso()

    def _later(self, seconds: float) -> str:
        from datetime import timedelta

        return (
            (ids.parse_iso(self._now()) + timedelta(seconds=seconds))
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z")
        )

    def _scope(self, value: Any) -> Scope | None:
        if value is None:
            return None
        if isinstance(value, Scope):
            return value
        return Scope.from_wire(value)

    def _require_scope_field(self, value: Any, *, field: str = "scope") -> Scope:
        scope = self._scope(value)
        if scope is None or not scope.company_ref or not scope.project_ref:
            raise errors.scope_violation(
                f"{field} is required and must come from the verified transport context, not "
                "from a request body"
            )
        return scope

    def _assert_scope(self, run: Mapping[str, Any], scope: Scope | None, *, operation: str) -> None:
        """The first gate on every read and every write.

        The composite database keys stop a confused query; they cannot stop a caller who
        knows the id. This can, so it runs first.
        """
        if scope is None:
            return
        if str(run["company_ref"]) != scope.company_ref or str(run["project_ref"]) != scope.project_ref:
            raise errors.scope_violation(
                f"{operation} refused: the object belongs to a different company/project than the "
                "asserted scope",
                details={
                    "operation": operation,
                    "requestedCompanyRef": scope.company_ref,
                    "requestedProjectRef": scope.project_ref,
                },
            )

    def _load_run(
        self, run_id: str, *, scope: Scope | None = None, operation: str = "read run"
    ) -> dict[str, Any]:
        if not run_id:
            raise errors.bad_request("runId is required")
        row = self.db.query_one("SELECT * FROM graph_runs WHERE run_id = ?", (str(run_id),))
        if row is None:
            raise errors.not_found(f"no run {run_id!r}", runId=str(run_id))
        self._assert_scope(row, scope, operation=operation)
        return row

    def _load_run_in_scope(
        self, run_id: str, scope: Scope, *, operation: str = "read run"
    ) -> dict[str, Any]:
        """Load a run by its fully scoped key.

        Used on every write so the WHERE clause itself carries the tenant: a guessed id from
        another company produces a refusal, not a row a later check has to catch.
        """
        row = self.db.query_one(
            "SELECT * FROM graph_runs WHERE company_ref = ? AND project_ref = ? AND run_id = ?",
            (scope.company_ref, scope.project_ref, str(run_id)),
        )
        if row is None:
            raise errors.scope_violation(
                f"{operation} refused: no run {run_id!r} exists in the asserted company/project",
                details={"runId": str(run_id)},
            )
        return row

    def _scope_of_run(self, run_id: str) -> Scope:
        row = self.db.query_one(
            "SELECT company_ref, project_ref FROM graph_runs WHERE run_id = ?", (str(run_id),)
        )
        if row is None:
            raise errors.not_found(f"no run {run_id!r}")
        return Scope(str(row["company_ref"]), str(row["project_ref"]))

    def _resolve_envelope_scope(self, run_id: str, presented: Any) -> Scope:
        """Validate a transport-scope claim against the row it addresses."""
        run_scope = self._scope_of_run(run_id)
        scope = self._scope(presented)
        if scope is not None:
            self._assert_scope(
                {"company_ref": run_scope.company_ref, "project_ref": run_scope.project_ref},
                scope,
                operation="write",
            )
        return run_scope

    def _node_rows(self, run_id: str) -> list[dict[str, Any]]:
        return self.db.query(
            "SELECT * FROM node_executions WHERE run_id = ? ORDER BY node_id, iteration",
            (str(run_id),),
        )

    def _node_row(self, run_id: str, node_id: str, iteration: int | None = None) -> dict[str, Any]:
        if iteration is None:
            row = self.db.query_one(
                "SELECT * FROM node_executions WHERE run_id = ? AND node_id = ?"
                " ORDER BY iteration DESC LIMIT 1",
                (str(run_id), str(node_id)),
            )
        else:
            row = self.db.query_one(
                "SELECT * FROM node_executions WHERE run_id = ? AND node_id = ? AND iteration = ?",
                (str(run_id), str(node_id), int(iteration)),
            )
        if row is None:
            raise errors.not_found(
                f"node {node_id!r} is not part of run {run_id!r}",
                runId=str(run_id),
                nodeId=str(node_id),
            )
        return row

    def _current_node_row(
        self, run_id: str, node_id: str | None, *, required: bool = True
    ) -> dict[str, Any]:
        """The node a command refers to, defaulting to the one with work in flight.

        The ordering puts an active attempt first so a bare ``request_transition`` cannot
        land on a different node than the one the worker is actually holding.
        """
        if node_id:
            return self._node_row(run_id, node_id)
        row = self.db.query_one(
            "SELECT * FROM node_executions WHERE run_id = ?"
            " ORDER BY CASE status WHEN 'RUNNING' THEN 0 WHEN 'EVIDENCE_READY' THEN 1"
            " WHEN 'EVALUATING' THEN 2 WHEN 'WAITING_GOVERNANCE' THEN 3 WHEN 'READY' THEN 4"
            " WHEN 'DISPATCH_REQUESTED' THEN 5 WHEN 'REWORK_REQUIRED' THEN 6 ELSE 7 END, node_id"
            " LIMIT 1",
            (str(run_id),),
        )
        if row is None:
            if not required:
                raise errors.not_found(f"run {run_id!r} has no node executions")
            raise errors.not_found(
                f"run {run_id!r} has no node execution to act on; the caller must name a nodeId",
                runId=str(run_id),
            )
        return row

    # ------------------------------------------------------------------
    # plan, policy, facts and digests
    # ------------------------------------------------------------------

    def _plan(self, run: Mapping[str, Any]) -> ExecutionPlan:
        """The run's pinned plan.

        Read from the run row, never from the live registry: a run must not drift when the
        default version or a draft changes underneath it (REQ-GRAPH-06).
        """
        raw = loads(run.get("plan_json"), None)
        if not raw:
            raise errors.contract_invalid(
                f"run {run.get('run_id')!r} carries no compiled plan; a run without its pinned "
                "plan cannot be executed"
            )
        return ExecutionPlan.from_wire(raw)

    def _plan_node(self, plan: ExecutionPlan, node_id: str) -> PlanNode:
        return plan.node(node_id)

    def _policy_rules(self, run: Mapping[str, Any]) -> tuple[PolicyRule, ...]:
        pins = loads(run.get("pins_json"), {}) or {}
        rules: list[PolicyRule] = []
        for item in pins.get("policyRules") or []:
            try:
                rules.append(
                    PolicyRule.from_wire(item) if isinstance(item, Mapping) else item
                )
            except (TypeError, ValueError) as exc:
                raise errors.contract_invalid(
                    f"a pinned policy rule is malformed: {exc}", runId=str(run.get("run_id"))
                ) from exc
        return tuple(rules)

    def _resolve_policy(
        self,
        run: Mapping[str, Any],
        *,
        action: str,
        resource: str,
        environment: str,
        agent_subject: str = "",
        transition_ref: str = "",
        grants: PlatformGrants | None = None,
        phase: str = "admission",
    ) -> EffectivePolicy:
        plan = self._plan(run)
        return resolve_policy(
            self._policy_rules(run),
            PolicyContext(
                project_ref=str(run["project_ref"]),
                workflow_ref=plan.graph_id,
                transition_ref=transition_ref or f"{plan.graph_id}.{plan.entrypoint}",
                agent_subject=agent_subject,
                action=action,
                resource=resource,
                environment=environment,
            ),
            grants=grants,
            phase=phase,
        )

    def _input_snapshot(self, run: Mapping[str, Any]) -> dict[str, Any]:
        return loads(run.get("input_snapshot_json"), {}) or {}

    def _required_facts(self, run: Mapping[str, Any]) -> dict[str, Any]:
        return loads(run.get("required_facts_json"), {}) or {}

    def _available_facts(
        self, run: Mapping[str, Any], node_rows: Sequence[Mapping[str, Any]]
    ) -> dict[str, Any]:
        """Facts a node may rely on: run inputs, verified prerequisite facts, node outputs.

        A fact is only present once something actually produced it, which is what stops a
        node from being released on the strength of a fact nobody verified.
        """
        plan = self._plan(run)
        facts: dict[str, Any] = {}
        for name in sorted(self._input_snapshot(run)):
            facts[name] = hashing.hash_domain(
                "pf.input", {"name": name, "value": self._input_snapshot(run)[name]}
            )
        for name, fact in sorted(self._required_facts(run).items()):
            if isinstance(fact, Mapping) and fact.get("contentHash"):
                facts[name] = str(fact["contentHash"])
        for row in node_rows:
            if str(row["status"]) != NodeStatus.PASSED:
                continue
            node_plan = plan.nodes.get(str(row["node_id"]))
            if node_plan is None:
                continue
            digest = str(
                row.get("output_digest")
                or hashing.hash_domain("pf.node", {"node": str(row["node_id"])})
            )
            for produced in node_plan.produces:
                facts[produced] = digest
        return facts

    def _available_exports(
        self, run: Mapping[str, Any], node_rows: Sequence[Mapping[str, Any]]
    ) -> dict[str, str]:
        """Exported kind -> digest of whatever delivered it."""
        plan = self._plan(run)
        exports: dict[str, str] = {}
        snapshot = self._input_snapshot(run)
        for name in sorted(snapshot):
            exports[name] = hashing.hash_domain("pf.input", {"name": name, "value": snapshot[name]})
        for row in node_rows:
            if str(row["status"]) != NodeStatus.PASSED:
                continue
            node_plan = plan.nodes.get(str(row["node_id"]))
            if node_plan is None:
                continue
            digest = str(row.get("output_digest") or "")
            for produced in node_plan.produces:
                exports[produced] = digest
        return exports

    def _input_digests(
        self, node_plan: PlanNode, exports: Mapping[str, str], facts: Mapping[str, Any]
    ) -> dict[str, str]:
        digests: dict[str, str] = {}
        for name, fact_name in sorted(node_plan.inputs.items()):
            digests[name] = str(
                facts.get(fact_name) or exports.get(fact_name) or exports.get(name) or ""
            )
        return digests

    def _current_input_revisions(
        self,
        run: Mapping[str, Any],
        node_row: Mapping[str, Any],
        node_rows: Sequence[Mapping[str, Any]],
    ) -> dict[str, str]:
        """The revision each declared input is currently at.

        Evidence is bound to this, so a re-registered upstream artifact moves the revision and
        the old evidence stops being current.
        """
        plan = self._plan(run)
        node_plan = plan.nodes.get(str(node_row["node_id"]))
        if node_plan is None:
            return {}
        exports = self._available_exports(run, node_rows)
        facts = self._available_facts(run, node_rows)
        return self._input_digests(node_plan, exports, facts)

    def _output_digest(
        self, node_row: Mapping[str, Any], evidence_rows: Sequence[Mapping[str, Any]]
    ) -> str:
        """One digest standing for everything this node produced."""
        return hashing.hash_domain(
            "pf.node-output",
            {
                "nodeId": str(node_row["node_id"]),
                "iteration": int(node_row["iteration"]),
                "evidence": sorted(
                    {
                        str(r["evidence_id"]): str(r.get("artifact_digest", ""))
                        for r in evidence_rows
                    }.items()
                ),
                "artifacts": sorted(
                    {
                        str(a.get("kind", "")): str(a.get("contentHash", ""))
                        for a in (loads(node_row.get("output_refs_json"), []) or [])
                    }.items()
                ),
            },
        )

    # ------------------------------------------------------------------
    # durable writes
    # ------------------------------------------------------------------

    def _bump(self, run_id: str, *, status: str | None = None, **fields: Any) -> int:
        """Move ``state_version`` forward together with the semantic change."""
        assignments = ["state_version = state_version + 1", "updated_at = ?"]
        values: list[Any] = [self._now()]
        if status is not None:
            assignments.append("status = ?")
            values.append(str(status))
        for column, value in fields.items():
            assignments.append(f"{column} = ?")
            values.append(dumps(value) if isinstance(value, (dict, list)) else value)
        values.append(str(run_id))
        self.db.execute(f"UPDATE graph_runs SET {', '.join(assignments)} WHERE run_id = ?", values)
        row = self.db.query_one(
            "SELECT state_version FROM graph_runs WHERE run_id = ?", (str(run_id),)
        )
        return int(row["state_version"]) if row else 0

    def _emit(
        self,
        run_id: str,
        event_type: str,
        payload: Mapping[str, Any],
        *,
        correlation_id: str | None = None,
        causation_id: str | None = None,
        source: str | None = None,
        source_event_id: str | None = None,
        source_revision: str | None = None,
    ) -> int:
        """Append one ``pf.*`` event and return its per-run sequence number.

        The name is checked against the published vocabulary: an event type outside it is a
        silent break for every consumer that switches on it.
        """
        if not is_pf_event(event_type):
            raise errors.contract_invalid(
                f"{event_type!r} is not a published pf.* event type", eventType=str(event_type)
            )
        now = self._now()
        run_row = self.db.query_one(
            "SELECT company_ref, project_ref, event_sequence FROM graph_runs WHERE run_id = ?",
            (str(run_id),),
        )
        if run_row is None:
            raise errors.not_found(f"cannot emit an event for unknown run {run_id!r}")
        seq = int(run_row["event_sequence"]) + 1
        self.db.execute(
            "INSERT INTO domain_events (event_id, company_ref, project_ref, run_id, seq, type, at,"
            " payload_json, correlation_id, causation_id, source, source_event_id, source_revision,"
            " quarantined, quarantine_reason, created_at, updated_at)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,NULL,?,?)",
            (
                ids.new_id("event"),
                str(run_row["company_ref"]),
                str(run_row["project_ref"]),
                str(run_id),
                seq,
                str(event_type),
                now,
                dumps(dict(payload)),
                correlation_id,
                causation_id,
                source,
                source_event_id,
                source_revision,
                now,
                now,
            ),
        )
        self.db.execute(
            "UPDATE graph_runs SET event_sequence = ?, updated_at = ? WHERE run_id = ?",
            (seq, now, str(run_id)),
        )
        return seq

    def _outbox(
        self,
        *,
        run: Mapping[str, Any],
        kind: str,
        correlation_key: str,
        payload: Mapping[str, Any],
        node_id: str | None = None,
        max_attempts: int | None = None,
    ) -> dict[str, Any]:
        """Queue an outbound intent in the same transaction as the fact that caused it.

        Create-or-get on the correlation key: a replayed command must not queue a second
        platform create, which is the classic source of duplicate work units.
        """
        if kind not in OUTBOX_KINDS:
            raise errors.contract_invalid(
                f"unknown outbox intent kind {kind!r}", known=list(OUTBOX_KINDS)
            )
        existing = self.db.query_one(
            "SELECT * FROM outbox_intents WHERE company_ref = ? AND project_ref = ?"
            " AND correlation_key = ?",
            (str(run["company_ref"]), str(run["project_ref"]), str(correlation_key)),
        )
        if existing is not None:
            return existing
        now = self._now()
        intent_id = ids.new_id("delivery")
        self.db.execute(
            "INSERT INTO outbox_intents (intent_id, company_ref, project_ref, run_id, node_id,"
            " kind, correlation_key, payload_json, state, delivery_attempts, max_delivery_attempts,"
            " claim_owner, claim_expires_at, next_attempt_at, receipt_json, error_json, delivered_at,"
            " created_at, updated_at)"
            " VALUES (?,?,?,?,?,?,?,?,'QUEUED',0,?,NULL,NULL,?,NULL,NULL,NULL,?,?)",
            (
                intent_id,
                str(run["company_ref"]),
                str(run["project_ref"]),
                str(run["run_id"]),
                node_id,
                str(kind),
                str(correlation_key),
                dumps(dict(payload)),
                int(max_attempts or self.max_delivery_attempts),
                now,
                now,
                now,
            ),
        )
        row = self.db.query_one(
            "SELECT * FROM outbox_intents WHERE company_ref = ? AND project_ref = ? AND intent_id = ?",
            (str(run["company_ref"]), str(run["project_ref"]), intent_id),
        )
        assert row is not None
        return row

    def _checkpoint(
        self,
        run: Mapping[str, Any],
        *,
        node_id: str | None,
        attempt_id: str | None,
        contract_hash: str | None,
        state_version: int,
    ) -> str:
        """Write a recovery point that is a fact, not a conversation summary.

        It holds the plan and contract identity, the verified artifacts, the effects already
        recorded, and the pending governance, so a run can be rebuilt from this plus the
        event stream when an agent session is simply gone. No plaintext secrets: only
        digests and provider references.
        """
        company, project, run_id = (
            str(run["company_ref"]),
            str(run["project_ref"]),
            str(run["run_id"]),
        )
        artifacts = self.db.query(
            "SELECT artifact_id, kind, content_hash, media_type FROM artifacts"
            " WHERE company_ref = ? AND project_ref = ? AND run_id = ? ORDER BY artifact_id",
            (company, project, run_id),
        )
        effects = self.db.query(
            "SELECT effect_key, status FROM effect_records WHERE company_ref = ?"
            " AND project_ref = ? AND run_id = ? ORDER BY effect_key",
            (company, project, run_id),
        )
        pending = self.db.query(
            "SELECT request_id, semantic_kind, decision_target_hash FROM governance_bindings"
            " WHERE company_ref = ? AND project_ref = ? AND run_id = ? AND state = 'PENDING'"
            " ORDER BY request_id",
            (company, project, run_id),
        )
        children = self.db.query(
            "SELECT child_run_id, parent_node_id FROM child_run_links WHERE company_ref = ?"
            " AND project_ref = ? AND parent_run_id = ? ORDER BY child_run_id",
            (company, project, run_id),
        )
        seq_row = self.db.query_one(
            "SELECT COALESCE(MAX(journal_sequence), 0) AS seq FROM graph_checkpoints"
            " WHERE company_ref = ? AND project_ref = ? AND run_id = ? AND node_id IS ?",
            (company, project, run_id, node_id),
        )
        journal_sequence = (int(seq_row["seq"]) if seq_row else 0) + 1
        checkpoint_id = ids.new_id("checkpoint")
        now = self._now()
        self.db.execute(
            "INSERT INTO graph_checkpoints (checkpoint_id, company_ref, project_ref, run_id,"
            " node_id, attempt_id, journal_sequence, state_version, schema_version, plan_hash,"
            " contract_hash, artifact_refs_json, effect_keys_json, pending_governance_json,"
            " child_refs_json, created_at, updated_at)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                checkpoint_id,
                company,
                project,
                run_id,
                node_id,
                attempt_id,
                journal_sequence,
                int(state_version),
                SCHEMA_VERSION,
                str(run.get("plan_hash", "")),
                contract_hash,
                dumps([dict(a) for a in artifacts]),
                dumps([dict(e) for e in effects]),
                dumps([dict(p) for p in pending]),
                dumps([dict(c) for c in children]),
                now,
                now,
            ),
        )
        self._emit(
            run_id,
            "pf.checkpoint.written",
            {
                "checkpointId": checkpoint_id,
                "nodeId": node_id,
                "attemptId": attempt_id,
                "journalSequence": journal_sequence,
                "stateVersion": int(state_version),
            },
        )
        return checkpoint_id

    def _release_worker(self, node_row: Mapping[str, Any], *, reason: str) -> None:
        """Let go of the lease without failing the work.

        Used when the run is waiting on a human or a platform answer. The attempt keeps its
        identity and its evidence; only the lease is released, so a different qualified
        worker may continue the same iteration under a new epoch.
        """
        now = self._now()
        active = str(node_row.get("active_attempt_id") or "")
        if active:
            self.db.execute(
                "UPDATE execution_attempts SET lease_state = 'RELEASED', status = ?,"
                " finished_at = COALESCE(finished_at, ?), updated_at = ? WHERE attempt_id = ?",
                (AttemptStatus.EVIDENCE_READY, now, now, active),
            )
        self.db.execute(
            "UPDATE node_executions SET active_attempt_id = NULL, wait_reason = ?,"
            " updated_at = ? WHERE run_id = ? AND node_id = ? AND iteration = ?",
            (reason, now, str(node_row["run_id"]), str(node_row["node_id"]), int(node_row["iteration"])),
        )

    def _fence_worker(
        self, node_row: Mapping[str, Any], *, reason: str, node_status: str = NodeStatus.BLOCKED
    ) -> None:
        """Invalidate the active lease because its holder can no longer be trusted."""
        now = self._now()
        active = str(node_row.get("active_attempt_id") or "")
        if active:
            self.db.execute(
                "UPDATE execution_attempts SET lease_state = 'FENCED', status = ?, finished_at = ?,"
                " updated_at = ? WHERE attempt_id = ?",
                (AttemptStatus.CANCELLED, now, now, active),
            )
        self.db.execute(
            "UPDATE node_executions SET status = ?, active_attempt_id = NULL, wait_reason = ?,"
            " block_reason = ?, updated_at = ? WHERE run_id = ? AND node_id = ? AND iteration = ?",
            (
                node_status,
                reason,
                str(BlockReason.LEASE_FENCED),
                now,
                str(node_row["run_id"]),
                str(node_row["node_id"]),
                int(node_row["iteration"]),
            ),
        )

    # ------------------------------------------------------------------
    # refusals, idempotency, fencing, budgets, ports
    # ------------------------------------------------------------------

    def _record_refusal(
        self,
        exc: errors.PolyForgeError,
        *,
        run: Mapping[str, Any] | None = None,
        node_id: str | None = None,
        attempt_id: str | None = None,
        command_id: str | None = None,
        idempotency_key: str | None = None,
        kind: str = "command",
        payload: Mapping[str, Any] | None = None,
    ) -> None:
        """Persist a refused write as an isolated diagnostic.

        Runs in its own transaction *after* the command transaction rolled back, which is the
        whole reason a rejection is still visible: the state change is gone, the incident is
        not. Nothing written here is ever read back as state.
        """
        if exc.code not in _REFUSAL_CODES:
            return
        now = self._now()
        details = dict(exc.details or {})
        try:
            with self.db.transaction():
                self.db.execute(
                    "INSERT INTO rejected_writes (rejection_id, company_ref, project_ref, run_id,"
                    " node_id, attempt_id, presented_epoch, active_epoch, command_id,"
                    " idempotency_key, kind, code, reason, payload_json, created_at, updated_at)"
                    " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (
                        f"rej_{ids.new_id('rejection')}",
                        str((run or {}).get("company_ref", "")),
                        str((run or {}).get("project_ref", "")),
                        str((run or {}).get("run_id", "")) or None,
                        node_id,
                        attempt_id,
                        details.get("presentedEpoch"),
                        details.get("activeEpoch"),
                        command_id,
                        idempotency_key,
                        str(kind),
                        str(exc.code),
                        exc.message,
                        dumps(dict(payload or {})),
                        now,
                        now,
                    ),
                )
        except errors.PolyForgeError:
            # Losing the diagnostic must not mask the refusal that triggered it, and the
            # caller still receives that error. Health reports the audit gap separately.
            return

    def refusals(self, run_id: str) -> list[dict[str, Any]]:
        """Read the isolated diagnostics for a run. Diagnostics only; never state."""
        return self.db.query(
            "SELECT * FROM rejected_writes WHERE run_id = ? ORDER BY created_at, rejection_id",
            (str(run_id),),
        )

    def _replay(
        self,
        *,
        scope: Scope,
        scope_key: str,
        idempotency_key: str,
        payload_hash: str,
    ) -> dict[str, Any] | None:
        """Return the recorded result for this identity, or refuse a conflicting payload."""
        if not idempotency_key:
            return None
        row = self.db.query_one(
            "SELECT * FROM idempotency_keys WHERE company_ref = ? AND project_ref = ?"
            " AND scope_key = ? AND idempotency_key = ?",
            (scope.company_ref, scope.project_ref, str(scope_key), str(idempotency_key)),
        )
        if row is None:
            return None
        recorded = str(row["payload_hash"])
        if recorded != payload_hash:
            raise errors.idempotency_conflict(
                "this idempotency key was already used with a different payload; the recorded "
                "outcome is only returned for the payload that produced it",
                idempotencyKey=str(idempotency_key),
                recordedPayloadHash=recorded,
                presentedPayloadHash=payload_hash,
            )
        result_row = self.db.query_one(
            "SELECT result_json FROM command_results WHERE company_ref = ? AND project_ref = ?"
            " AND command_id = ?",
            (scope.company_ref, scope.project_ref, str(row["command_id"])),
        )
        if result_row is None:
            return None
        return loads(result_row["result_json"], None)

    def _record_command(
        self,
        *,
        scope: Scope,
        scope_key: str,
        run_id: str | None,
        command_id: str,
        idempotency_key: str,
        payload_hash: str,
        result: Mapping[str, Any],
    ) -> None:
        now = self._now()
        self.db.execute(
            "INSERT INTO command_results (company_ref, project_ref, command_id, run_id,"
            " idempotency_key, payload_hash, result_json, created_at, updated_at)"
            " VALUES (?,?,?,?,?,?,?,?,?)"
            " ON CONFLICT(company_ref, project_ref, command_id) DO UPDATE SET"
            " result_json = excluded.result_json, updated_at = excluded.updated_at",
            (
                scope.company_ref,
                scope.project_ref,
                str(command_id),
                run_id,
                str(idempotency_key),
                str(payload_hash),
                dumps(dict(result)),
                now,
                now,
            ),
        )
        self.db.execute(
            "INSERT INTO idempotency_keys (company_ref, project_ref, scope_key, idempotency_key,"
            " payload_hash, command_id, result_ref, created_at, updated_at)"
            " VALUES (?,?,?,?,?,?,?,?,?)"
            " ON CONFLICT(company_ref, project_ref, scope_key, idempotency_key) DO NOTHING",
            (
                scope.company_ref,
                scope.project_ref,
                str(scope_key),
                str(idempotency_key),
                str(payload_hash),
                str(command_id),
                str(result.get("resultRef") or command_id),
                now,
                now,
            ),
        )

    def _check_version(self, run: Mapping[str, Any], expected: int | None) -> None:
        if expected is None:
            return
        if int(expected) != int(run["state_version"]):
            raise errors.version_conflict(
                f"expectedStateVersion {expected} does not match the run's current version",
                int(run["state_version"]),
                runId=str(run["run_id"]),
            )

    def _active_claim(self, run_id: str, node_id: str, iteration: int) -> dict[str, Any] | None:
        return self.db.query_one(
            "SELECT * FROM execution_attempts WHERE run_id = ? AND node_id = ? AND iteration = ?"
            " AND lease_state = 'ACTIVE'",
            (str(run_id), str(node_id), int(iteration)),
        )

    def _require_claim(
        self,
        run: Mapping[str, Any],
        node_row: Mapping[str, Any],
        *,
        attempt_id: str | None,
        lease_epoch: int | None,
    ) -> dict[str, Any]:
        """Fence check. Every worker write passes through here before it reads content.

        An expired lease is refused too: expiry means "check", not "the old worker stopped",
        and a write arriving after expiry is exactly what the fence exists for.
        """
        node_id = str(node_row["node_id"])
        claim = self._active_claim(str(run["run_id"]), node_id, int(node_row["iteration"]))
        if claim is None:
            raise errors.lease_fenced(
                f"no active claim on node {node_id!r}; an unclaimed write is never accepted",
                nodeId=node_id,
                runId=str(run["run_id"]),
            )
        if lease_epoch is not None and int(lease_epoch) != int(claim["lease_epoch"]):
            raise errors.lease_fenced(
                f"write carries lease epoch {lease_epoch} but node {node_id!r} is held at epoch "
                f"{claim['lease_epoch']}; the writer has been fenced",
                nodeId=node_id,
                runId=str(run["run_id"]),
                presentedEpoch=int(lease_epoch),
                activeEpoch=int(claim["lease_epoch"]),
                attemptId=str(claim["attempt_id"]),
            )
        if attempt_id is not None and str(attempt_id) != str(claim["attempt_id"]):
            raise errors.lease_fenced(
                f"write names attempt {attempt_id!r} but the active attempt is {claim['attempt_id']!r}",
                nodeId=node_id,
                runId=str(run["run_id"]),
                presentedAttemptId=str(attempt_id),
                activeAttemptId=str(claim["attempt_id"]),
                presentedEpoch=int(lease_epoch) if lease_epoch is not None else None,
                activeEpoch=int(claim["lease_epoch"]),
            )
        expires = claim.get("lease_expires_at")
        if expires and str(expires) <= self._now():
            raise errors.lease_fenced(
                f"the lease on node {node_id!r} expired at {expires}; a replacement attempt is only "
                "admissible once the platform confirms the previous worker is stopped or fenced",
                nodeId=node_id,
                runId=str(run["run_id"]),
                presentedEpoch=int(lease_epoch) if lease_epoch is not None else None,
                activeEpoch=int(claim["lease_epoch"]),
                leaseExpiresAt=str(expires),
            )
        return claim

    def _budget_state(self, run: Mapping[str, Any]) -> dict[str, Any]:
        return loads(run.get("budget_state_json"), {}) or {}

    def _budget_blocker(self, run: Mapping[str, Any]) -> Blocker | None:
        """A financial hard stop, or ``None``.

        Counted on the run, never on the agent: switching workers to dodge a budget is the
        failure mode this exists to prevent (REQ-DATA-03).
        """
        budget = self._budget_state(run)
        if str(budget.get("state", "")).upper() in ("HARD_STOP", "EXHAUSTED"):
            return Blocker(
                code="BUDGET_HARD_STOP",
                reason=str(BlockReason.BUDGET),
                message=(
                    "the platform reported a financial hard stop for this run; no dispatch, retry, "
                    "or agent substitution may proceed until the platform itself restores budget"
                ),
                detail=dict(budget),
            )
        return None

    def _budget_lease(self, run: Mapping[str, Any]) -> None:
        blocker = self._budget_blocker(run)
        if blocker is not None:
            raise errors.run_blocked(
                blocker.message, blockers=[blocker.to_wire()], runId=str(run["run_id"])
            )

    def _require_ports(self, operation: str) -> Any:
        if self.ports is None:
            raise errors.unsupported(
                f"{operation} requires the bridge ports and this Runtime was constructed without "
                "them. Execution, authorization, and reconciliation do not degrade to a plain "
                "confirmation, so the operation is refused rather than assumed to have succeeded",
                operation=operation,
            )
        return self.ports

    # ------------------------------------------------------------------
    # admission
    # ------------------------------------------------------------------

    def admit_work_order(self, request: Mapping[str, Any]) -> dict[str, Any]:
        """Idempotently admit one work order and create its pinned GraphRun.

        Idempotent on ``scope + startIntentId + entrypoint``, so replaying a wakeup a hundred
        times produces one work order and one run. An entrypoint the graph does not declare
        produces **no run at all** — that is how ordinary operational work stays out of the
        Graph rather than being admitted and then blocked.
        """
        scope = self._require_scope_field(request.get("scope"))
        try:
            with self.db.transaction():
                run_id = self._admit_tx(scope, request)
        except errors.PolyForgeError as exc:
            self._record_refusal(
                exc,
                command_id=str(request.get("commandId", "")) or None,
                idempotency_key=str(request.get("idempotencyKey", "")) or None,
                kind="admit_work_order",
                payload=request,
            )
            raise
        return self.get_run(str(run_id), scope=scope)

    def _admit_tx(self, scope: Scope, request: Mapping[str, Any]) -> str:
        start_intent_id = str(request.get("startIntentId", ""))
        entrypoint = str(request.get("entrypoint", ""))
        if not start_intent_id:
            raise errors.bad_request("startIntentId is required; it is the admission identity")
        if not entrypoint:
            raise errors.bad_request("entrypoint is required")
        root_issue_ref = request.get("rootIssueRef")
        if not isinstance(root_issue_ref, Mapping) or not root_issue_ref.get("id"):
            raise errors.bad_request(
                "rootIssueRef must be a provider reference; project identity comes from the "
                "trusted issue relationship, never from the body"
            )

        payload_hash = hashing.hash_domain(
            "pf.admission-payload",
            {
                "graphId": str(request.get("graphId", "")),
                "entrypoint": entrypoint,
                "rootIssueRef": dict(root_issue_ref),
                "inputSnapshot": dict(request.get("inputSnapshot") or {}),
                "requiredFacts": dict(request.get("requiredFacts") or {}),
                "requiredFactSources": dict(request.get("requiredFactSources") or {}),
                "workspaceRequirement": request.get("workspaceRequirement"),
            },
        )
        existing = self.db.query_one(
            "SELECT * FROM work_orders WHERE company_ref = ? AND project_ref = ?"
            " AND start_intent_id = ? AND entrypoint = ?",
            (scope.company_ref, scope.project_ref, start_intent_id, entrypoint),
        )
        if existing is not None:
            if str(existing["request_hash"]) != payload_hash:
                raise errors.idempotency_conflict(
                    "this start intent was already admitted with a different work order payload; "
                    "replay the original or raise a new intent",
                    startIntentId=start_intent_id,
                    entrypoint=entrypoint,
                    recordedPayloadHash=str(existing["request_hash"]),
                    presentedPayloadHash=payload_hash,
                )
            return str(existing["run_id"])

        graph_id = str(request.get("graphId", ""))
        if not graph_id:
            raise errors.bad_request("graphId is required")
        definition, artifact, graph_version, definition_hash = self._resolve_graph(
            scope, graph_id, request.get("graphVersion"), request
        )
        entrypoints = definition.get("entrypoints") or {}
        if entrypoint not in entrypoints:
            # Ordinary work does not start a graph. No work order, no run, no events.
            raise errors.contract_invalid(
                f"entrypoint {entrypoint!r} is not an engineering entry point of graph {graph_id!r}; "
                "ordinary work continues on the platform and must not create a GraphRun",
                graphId=graph_id,
                entrypoint=entrypoint,
                declaredEntrypoints=sorted(entrypoints),
            )
        plan = build_plan(
            definition, graph_version=graph_version, entrypoint=entrypoint, artifact=artifact
        )
        plan = self._apply_run_workspace_requirement(plan, request.get("workspaceRequirement"))
        required_facts = self._resolve_required_fact_sources(
            scope, plan, request.get("requiredFactSources")
        )
        admission_request = dict(request)
        if required_facts:
            # Caller-supplied hashes are never mixed with Core-resolved gate receipts.
            if request.get("requiredFacts"):
                raise errors.contract_invalid(
                    "requiredFacts cannot be combined with Core-resolved requiredFactSources"
                )
            admission_request["requiredFacts"] = required_facts

        rules = self._definition_policy_rules(definition, request)
        if not rules:
            raise errors.contract_invalid(
                f"graph {graph_id!r} declares no effective policy rules; resolution is deny-first, "
                "so a graph without rules authorises nothing",
                graphId=graph_id,
            )
        grants = (
            PlatformGrants.from_wire(request.get("platformGrants"))
            if request.get("platformGrants")
            else None
        )
        admission_policy = resolve_policy(
            rules,
            PolicyContext(
                project_ref=scope.project_ref,
                workflow_ref=plan.graph_id,
                transition_ref=f"{plan.graph_id}.{entrypoint}",
                action="work_order.admit",
                resource=str(root_issue_ref.get("id", "")),
                environment=str(request.get("environment", "production")),
            ),
            grants=grants,
            phase="admission",
        )
        if admission_policy.is_denied:
            raise errors.contract_invalid(
                f"admission denied by policy rule {admission_policy.rule_id!r}: {admission_policy.reason}",
                blockers=[admission_policy.to_wire()],
            )
        if admission_policy.requires_fresh_authorization_at_admission and grants is None:
            # The rule asks for a fresh platform check and the bridge supplied no verified
            # result. Admitting anyway would treat silence as an approval.
            raise errors.contract_invalid(
                "the policy requires a fresh platform authorization at admission and none was "
                "supplied; the Core will not infer an approval from silence",
                blockers=[admission_policy.to_wire()],
            )
        missing_facts = self._missing_required_facts(plan, admission_request)
        if missing_facts:
            raise errors.contract_invalid(
                "the entry point requires prerequisite facts with verifiable provenance: "
                + "; ".join(missing_facts),
                requiredFacts=sorted(plan.required_facts),
                suppliedFacts=sorted((request.get("requiredFacts") or {}).keys()),
            )
        blockers = self._sibling_admission_blockers(
            definition, plan, entrypoint, admission_request, self._capability_bindings(scope)
        )
        if blockers:
            raise errors.contract_invalid(
                "admission preconditions are not met: " + "; ".join(str(b) for b in blockers),
                blockers=list(blockers),
            )

        now = self._now()
        work_order_id = ids.new_id("work_order")
        run_id = ids.new_id("run")
        family_id = str(
            request.get("familyId")
            or hashing.hash_domain(
                "pf.family",
                {
                    "graphId": plan.graph_id,
                    "entrypoint": entrypoint,
                    "rootIssue": str(root_issue_ref.get("id", "")),
                },
            ).split(":")[-1]
        )
        pins = self._pins(plan, rules, definition_hash, artifact)
        command_id = str(request.get("commandId", "")) or ids.new_id("command")
        self.db.execute(
            "INSERT INTO work_orders (work_order_id, company_ref, project_ref, start_intent_id,"
            " entrypoint, graph_id, graph_version, run_id, source_ref_json, root_issue_ref_json,"
            " input_snapshot_json, required_facts_json, case_binding_json, request_hash, state,"
            " created_at, updated_at, created_by)"
            " VALUES (:work_order_id, :company_ref, :project_ref, :start_intent_id, :entrypoint,"
            " :graph_id, :graph_version, :run_id, :source_ref_json, :root_issue_ref_json,"
            " :input_snapshot_json, :required_facts_json, :case_binding_json, :request_hash,"
            " 'ADMITTED', :now, :now, :created_by)",
            {
                "work_order_id": work_order_id,
                "company_ref": scope.company_ref,
                "project_ref": scope.project_ref,
                "start_intent_id": start_intent_id,
                "entrypoint": entrypoint,
                "graph_id": plan.graph_id,
                "graph_version": plan.graph_version,
                "run_id": run_id,
                "source_ref_json": dumps(dict(request["sourceRef"]))
                if request.get("sourceRef")
                else None,
                "root_issue_ref_json": dumps(dict(root_issue_ref)),
                "input_snapshot_json": dumps(dict(request.get("inputSnapshot") or {})),
                "required_facts_json": dumps(
                    required_facts or dict(request.get("requiredFacts") or {})
                ),
                "case_binding_json": dumps(dict(request["caseBinding"]))
                if request.get("caseBinding")
                else None,
                "request_hash": payload_hash,
                "now": now,
                "created_by": str(request.get("actorId", "")) or None,
            },
        )
        self.db.execute(
            "INSERT INTO graph_runs (run_id, company_ref, project_ref, family_id, work_order_id,"
            " graph_id, graph_version, definition_hash, plan_hash, dependency_lock_hash, status,"
            " state_version, event_sequence, owner_epoch, entrypoint, parent_run_id, parent_node_id,"
            " invocation_generation, pins_json, plan_json, input_snapshot_json, required_facts_json,"
            " root_issue_ref_json, parent_issue_ref_json, budget_state_json, block_reason,"
            " block_detail_json, migration_state, created_at, updated_at, created_by)"
            " VALUES (:run_id, :company_ref, :project_ref, :family_id, :work_order_id, :graph_id,"
            " :graph_version, :definition_hash, :plan_hash, :dependency_lock_hash, 'CREATED', 1, 0, 1,"
            " :entrypoint, :parent_run_id, :parent_node_id, :invocation_generation, :pins_json,"
            " :plan_json, :input_snapshot_json, :required_facts_json, :root_issue_ref_json,"
            " :parent_issue_ref_json, :budget_state_json, NULL, NULL, :migration_state, :now, :now,"
            " :created_by)",
            {
                "run_id": run_id,
                "company_ref": scope.company_ref,
                "project_ref": scope.project_ref,
                "family_id": family_id,
                "work_order_id": work_order_id,
                "graph_id": plan.graph_id,
                "graph_version": plan.graph_version,
                "definition_hash": definition_hash or plan.definition_hash,
                "plan_hash": plan.plan_hash,
                "dependency_lock_hash": plan.dependency_lock_hash,
                "entrypoint": entrypoint,
                "parent_run_id": str(request.get("parentRunId"))
                if request.get("parentRunId")
                else None,
                "parent_node_id": str(request.get("parentNodeId"))
                if request.get("parentNodeId")
                else None,
                "invocation_generation": int(request.get("invocationGeneration", 0) or 0),
                "pins_json": dumps(pins),
                "plan_json": dumps(plan.to_wire()),
                "input_snapshot_json": dumps(dict(request.get("inputSnapshot") or {})),
                "required_facts_json": dumps(
                    required_facts or dict(request.get("requiredFacts") or {})
                ),
                "root_issue_ref_json": dumps(dict(root_issue_ref)),
                "parent_issue_ref_json": dumps(dict(request["parentIssueRef"]))
                if request.get("parentIssueRef")
                else None,
                "budget_state_json": dumps(dict(request["budgetState"]))
                if request.get("budgetState")
                else None,
                "migration_state": str(request.get("migrationState"))
                if request.get("migrationState")
                else None,
                "now": now,
                "created_by": str(request.get("actorId", "")) or None,
            },
        )
        for node_id in plan.ordered_node_ids():
            node_plan = plan.nodes[node_id]
            self.db.execute(
                "INSERT INTO node_executions (company_ref, project_ref, run_id, node_id, iteration,"
                " kind, status, contract_hash, contract_id, plan_node_json, input_refs_json,"
                " output_refs_json, input_digest_json, output_digest, active_attempt_id, wait_reason,"
                " block_reason, required_capabilities_json, assigned_subject, assigned_issue_ref_json,"
                " child_run_id, workspace_requirement_json, rework_count, max_rework, created_at,"
                " updated_at)"
                " VALUES (:company_ref, :project_ref, :run_id, :node_id, 0, :kind, :status, NULL,"
                " NULL, :plan_node_json, '[]', '[]', '{}', :output_digest, NULL, NULL, NULL,"
                " :required_capabilities_json, NULL, NULL, NULL, :workspace_requirement_json, 0,"
                " :max_rework, :now, :now)",
                {
                    "company_ref": scope.company_ref,
                    "project_ref": scope.project_ref,
                    "run_id": run_id,
                    "node_id": node_id,
                    "kind": node_plan.kind,
                    "status": NodeStatus.PENDING,
                    "plan_node_json": dumps(node_plan.to_canonical()),
                    "output_digest": hashing.hash_domain("pf.node-empty", {"node": node_id}),
                    "required_capabilities_json": dumps(list(node_plan.required_capabilities)),
                    "workspace_requirement_json": dumps(dict(node_plan.workspace_requirement))
                    if node_plan.workspace_requirement
                    else None,
                    "max_rework": node_plan.max_rework or self.default_max_rework,
                    "now": now,
                },
            )
        self._emit(
            run_id,
            "pf.work_order.accepted",
            {
                "workOrderId": work_order_id,
                "graphId": plan.graph_id,
                "graphVersion": plan.graph_version,
                "entrypoint": entrypoint,
                "planHash": plan.plan_hash,
                "startIntentId": start_intent_id,
                "rootIssueRef": dict(root_issue_ref),
            },
            correlation_id=str(request.get("correlationId", "")) or None,
        )
        run_row = self._load_run_in_scope(run_id, scope, operation="admission")
        self._apply_plan(
            run_row, scope=scope, cause="admission", correlation_id=str(request.get("correlationId", "")) or None
        )
        refreshed = self._load_run_in_scope(run_id, scope, operation="admission")
        self._checkpoint(
            refreshed,
            node_id=None,
            attempt_id=None,
            contract_hash=None,
            state_version=int(refreshed["state_version"]),
        )
        result = CommandResult(
            command_id=command_id,
            applied=True,
            state_version=int(refreshed["state_version"]),
            status=str(refreshed["status"]),
            result_ref=run_id,
            blockers=[],
        ).to_wire()
        self._record_command(
            scope=scope,
            scope_key="admission",
            run_id=run_id,
            command_id=command_id,
            idempotency_key=str(
                request.get("idempotencyKey", "")
                # The admission identity is scope + startIntentId + entrypoint, so the default key
                # carries all three: two entry points under one intent are two different runs.
                or f"admission:{start_intent_id}:{entrypoint}"
            ),
            payload_hash=payload_hash,
            result=result,
        )
        return run_id

    # ------------------------------------------------------------------
    # planning application and graph resolution
    # ------------------------------------------------------------------

    def _apply_plan(
        self,
        run: Mapping[str, Any],
        *,
        scope: Scope,
        correlation_id: str | None = None,
        cause: str = "replan",
    ) -> int:
        """Re-derive every node's readiness and queue intents for the newly ready ones.

        Pure planning plus the writes it implies. Nodes that are already in flight are left
        alone: readiness is not the state machine, and a planner that overwrote a running
        status would be able to cancel work by accident.
        """
        plan = self._plan(run)
        run_id = str(run["run_id"])
        node_rows = self._node_rows(run_id)
        facts = self._available_facts(run, node_rows)
        exports = self._available_exports(run, node_rows)
        child_runs = {
            str(link["child_run_id"]): self._child_export_view(str(link["child_run_id"]), scope)
            for link in self.db.query(
                "SELECT child_run_id FROM child_run_links WHERE company_ref = ? AND project_ref = ?"
                " AND parent_run_id = ?",
                (scope.company_ref, scope.project_ref, run_id),
            )
        }
        decisions = plan_states(
            plan,
            node_states={str(r["node_id"]): r for r in node_rows},
            available_facts=facts,
            available_exports=exports,
            child_runs=child_runs,
        )
        now = self._now()
        changed = False
        newly_ready: list[str] = []
        for node_id in plan.ordered_node_ids():
            decision = decisions[node_id]
            row = self._node_row(run_id, node_id)
            current = str(row["status"])
            if decision.status == current:
                continue
            if current in (NodeStatus.PASSED, NodeStatus.SKIPPED, NodeStatus.RUNNING, NodeStatus.BLOCKED):
                # A block is cleared only by an explicit authorized resolution or a retry. If
                # planning could re-derive READY from a blocked node, every block would be
                # transient.
                continue
            self.db.execute(
                "UPDATE node_executions SET status = ?, wait_reason = ?, block_reason = ?,"
                " updated_at = ? WHERE run_id = ? AND node_id = ? AND iteration = ?",
                (
                    decision.status,
                    None if decision.status == NodeStatus.READY else decision.reason,
                    decision.block_reason,
                    now,
                    run_id,
                    node_id,
                    int(row["iteration"]),
                ),
            )
            changed = True
            if decision.status == NodeStatus.READY:
                newly_ready.append(node_id)

        for node_id in newly_ready:
            node_plan = plan.nodes[node_id]
            iteration = int(self._node_row(run_id, node_id)["iteration"])
            correlation_key = f"work-unit:{run_id}:{node_id}:{iteration}"
            independent_subjects = (
                sorted(self._upstream_producer_subjects(run_id, plan, node_id, scope))
                if node_plan.independent_from
                else []
            )
            self._outbox(
                run=run,
                kind="work.unit.ensure",
                correlation_key=correlation_key,
                node_id=node_id,
                payload={
                    "runId": run_id,
                    "nodeId": node_id,
                    "iteration": iteration,
                    "scope": scope.to_wire(),
                    "title": f"{plan.graph_id}.{plan.entrypoint}: {node_id}",
                    "description": (
                        f"Work the {node_id} node of run {run_id} in graph {plan.graph_id} "
                        f"v{plan.graph_version}."
                    ),
                    "requiredCapabilities": list(node_plan.required_capabilities),
                    "preferredRoles": list(node_plan.preferred_roles),
                    "fallbackRoles": list(node_plan.fallback_roles),
                    "independentFrom": [
                        {"capabilityRef": capability, "subjectRefs": independent_subjects}
                        for capability in node_plan.independent_from
                    ],
                    "excludeSubjects": independent_subjects,
                    "correlationKey": correlation_key,
                    "parentIssueRef": loads(run.get("root_issue_ref_json"), None),
                    "workspaceRequirement": dict(node_plan.workspace_requirement or {}),
                },
            )
            self._emit(
                run_id,
                "pf.node.ready",
                {
                    "nodeId": node_id,
                    "iteration": iteration,
                    "planHash": plan.plan_hash,
                    "requiredCapabilities": list(node_plan.required_capabilities),
                    "cause": cause,
                },
                correlation_id=correlation_id,
            )

        if changed or newly_ready or str(run["status"]) == GraphRunStatus.CREATED:
            status = str(run["status"])
            if status == GraphRunStatus.CREATED:
                status = str(GraphRunStatus.ACTIVE)
            elif status == GraphRunStatus.WAITING and newly_ready:
                # Work became admissible again; the run is no longer waiting on a human.
                status = str(GraphRunStatus.ACTIVE)
            self._bump(run_id, status=status)
        return len(newly_ready)

    def _child_export_view(self, child_run_id: str, scope: Scope) -> dict[str, Any]:
        child = self.db.query_one(
            "SELECT * FROM graph_runs WHERE company_ref = ? AND project_ref = ? AND run_id = ?",
            (scope.company_ref, scope.project_ref, str(child_run_id)),
        )
        if child is None:
            return {"status": "UNKNOWN", "exports": []}
        plan = ExecutionPlan.from_wire(loads(child.get("plan_json"), {}) or {})
        exports = self._available_exports(child, self._node_rows(str(child_run_id)))
        return {
            "status": str(child["status"]),
            "exports": [e for e in plan.export_kinds if e in exports],
        }

    def _resolve_graph(
        self,
        scope: Scope,
        graph_id: str,
        graph_version: Any,
        request: Mapping[str, Any],
    ) -> tuple[Mapping[str, Any], Mapping[str, Any] | None, int, str]:
        """Return ``(definition, compile_artifact, version, definition_hash)``.

        An inline ``definition`` is accepted for a graph that is not published yet; it still
        has to be a real definition with declared entrypoints and policy, and its hash is
        recorded so the run's pins stay meaningful.

        Everything else is resolved through the registry. There is deliberately no fallback
        read of a locally stored version table: the registry is the only writer of published
        versions, so a second copy could only ever disagree with it, and a run pinned to the
        wrong one would be rewritten against a definition nobody published.
        """
        if request.get("definition") is not None:
            definition = request["definition"]
            if not isinstance(definition, Mapping):
                raise errors.bad_request("definition must be an object when supplied inline")
            if str(definition.get("graphId", graph_id)) != graph_id:
                raise errors.bad_request(
                    "the inline definition declares a different graphId than the request"
                )
            definition_hash = hashing.hash_domain("pf.definition", definition)
            return definition, None, int(graph_version or 0), definition_hash

        if graph_version is not None:
            record = self._resolve_version(
                scope=scope, graph_id=graph_id, version=int(graph_version)
            )
        else:
            record = self._resolve_active_version(
                scope=scope,
                graph_id=graph_id,
                environment=str(request.get("environment", "") or "") or None,
            )
        if record is None:
            raise errors.not_found(
                f"graph {graph_id!r} has no published version to run in this scope; publish and "
                "activate a version, or supply the definition inline",
                graphId=graph_id,
                graphVersion=graph_version,
            )
        definition = record["definition"]
        if not isinstance(definition, Mapping):
            raise errors.contract_invalid(
                f"graph version {graph_id}@{record['version']} stores no definition",
                graphId=graph_id,
                version=int(record["version"]),
            )
        artifact = self._version_artifact(record)
        return (
            definition,
            artifact,
            int(record["version"]),
            str(artifact["definitionHash"]),
        )

    def _resolve_version(
        self, *, scope: Scope, graph_id: str, version: int
    ) -> Mapping[str, Any] | None:
        """One published version, read through the registry. ``None`` means "not published".

        The registry answers with dataclasses (``GraphVersion``), so the record is normalized
        to its ``to_dict()`` shape here: every caller downstream then reads one key vocabulary
        and never has to know whether a registry agent answered with a record or a mapping.

        A version that lives in another scope is a refusal, not a ``None``. The registry
        refuses a cross-scope read with ``403``, and answering "no such version" would be a
        lie about an id the caller already holds, so only ``NOT_FOUND`` becomes ``None``.
        """
        registry = self._require_registry(
            "a run cannot be pinned to a published version without it"
        )
        getter = getattr(registry, "get_version", None)
        if getter is None:
            raise errors.unsupported(
                "the configured registry does not implement get_version; it must be compatible "
                "with polyforge.core.registry.store.RegistryStore",
                graphId=str(graph_id),
                version=int(version),
            )
        try:
            record = getter(graph_id, int(version), scope=scope.to_wire())
        except TypeError:
            # A registry that will not accept a scope is a trusted unscoped reader. Accepting
            # it would weaken isolation, so say so rather than silently retrying unscoped.
            raise errors.unsupported(
                "the configured registry does not accept a scope on get_version; an unscoped "
                "registry cannot be used to pin a run inside a company/project",
                graphId=str(graph_id),
                version=int(version),
            ) from None
        except errors.PolyForgeError as exc:
            if exc.code is not errors.ErrorCode.NOT_FOUND:
                raise
            return None
        return self._version_record(record, graph_id=graph_id, version=int(version))

    def _resolve_active_version(
        self, *, scope: Scope, graph_id: str, environment: str | None = None
    ) -> Mapping[str, Any] | None:
        """The version future admissions in this scope get by default.

        This is the registry's active-default pointer and nothing else. The Runtime does not
        fall back to "the highest version that exists": a retired version, or one that was
        published but never activated, is not the default, and admitting a run against it
        would silently substitute a version an operator never put in front of new work
        (REQ-GRAPH-06).

        ``environment`` is accepted because the admission request carries one, but the
        registry's pointer is per ``{company, project, graph}`` and has no environment
        dimension, so there is nothing for it to narrow. The pointer that comes back is the
        only one the registry holds, and passing an environment cannot select a different one.
        """
        registry = self._require_registry("admission cannot pick a default version without it")
        pointer = None
        reader = getattr(registry, "get_default_pointer", None)
        if reader is not None:
            pointer = reader(scope=scope.to_wire(), graph_id=graph_id)
        if pointer is None:
            active = getattr(registry, "get_active_version", None)
            if active is None:
                raise errors.unsupported(
                    "the configured registry implements neither get_default_pointer nor "
                    "get_active_version, so the active default version cannot be resolved",
                    graphId=str(graph_id),
                )
            record = active(scope=scope.to_wire(), graph_id=graph_id)
            if record is None:
                return None
            return self._version_record(record, graph_id=graph_id, version=None)
        version = int(pointer["version"] if isinstance(pointer, Mapping) else pointer.version)
        # Resolved through the version reader rather than trusted off the pointer: a pointer
        # that names a version the registry cannot produce is a broken registry, not a default.
        return self._resolve_version(scope=scope, graph_id=graph_id, version=version)

    def _require_registry(self, why: str) -> Any:
        """The injected registry, or a refusal.

        Failing closed is the whole point. The alternative — resolving a version from state
        this process owns — is how a run ends up pinned to a definition the registry never
        published, and it fails silently, which is worse than not running at all.
        """
        if self.registry is None:
            raise errors.unsupported(
                "this Runtime was constructed without a graph registry, so a published version "
                f"cannot be resolved: {why}. The registry is the only authority for drafts, "
                "published versions and the active default pointer, and the Runtime has no "
                "second copy to fall back to",
                operation="resolve graph version",
            )
        return self.registry

    @staticmethod
    def _version_record(
        record: Any, *, graph_id: str, version: int | None
    ) -> Mapping[str, Any]:
        """Normalize whatever the registry returned into one ``GraphVersion.to_dict()`` shape."""
        if hasattr(record, "to_dict"):
            record = record.to_dict()
        if not isinstance(record, Mapping):
            raise errors.unsupported(
                "the configured registry answered with neither a record nor a mapping; the "
                "Runtime cannot read a published version it does not recognise",
                graphId=str(graph_id),
                version=version,
            )
        missing = [key for key in ("graphId", "version", "definition") if key not in record]
        if missing:
            raise errors.unsupported(
                "the configured registry answered without " + ", ".join(missing) + "; a "
                "published version must answer with the GraphVersion wire shape",
                graphId=str(graph_id),
                version=version,
            )
        return dict(record)

    @staticmethod
    def _version_artifact(record: Mapping[str, Any]) -> dict[str, Any]:
        """The compile-artifact view of a resolved version, as ``build_plan`` reads it."""
        definition = record.get("definition") or {}
        digest = str(record.get("definitionHash", "") or "") or hashing.hash_domain(
            "pf.definition", definition
        )
        plan_hash = str(record.get("planHash", "") or "") or hashing.hash_domain(
            "pf.plan", definition
        )
        return {
            "planHash": plan_hash,
            "dependencyLockHash": str(record.get("dependencyLockHash", "") or ""),
            "compilerVersion": str(record.get("compilerVersion", COMPILER_VERSION)),
            "closure": dict(record.get("closure") or {}),
            "definitionHash": digest,
        }

    @staticmethod
    def _definition_policy_rules(
        definition: Mapping[str, Any], request: Mapping[str, Any] | None = None
    ) -> tuple[PolicyRule, ...]:
        """Resolve the rule set this run will be pinned to.

        ``policyRefs`` is a list of strings (``"name@version"``) in the contract shape, and a
        string names a policy without granting anything. The rules therefore come from one of
        two places, and both end up *pinned onto the run* so a later catalog change cannot
        reach it (REQ-ARCH-05, REQ-GRAPH-06):

        1. an inline ``{"name": ..., "rules": [...]}`` entry — the authored, reviewed form;
        2. ``policyRules`` on the admission request — the bridge's pinned copy of the governed
           rules for the cited refs.

        With neither, resolution is deny-first and a run is refused: a graph that only *names*
        a policy authorises nothing, because publishing a graph is not granting it rights.
        """
        rules: list[PolicyRule] = []
        cited = False
        for ref in definition.get("policyRefs") or ():
            if isinstance(ref, Mapping):
                cited = True
                for rule in ref.get("rules") or ():
                    rules.append(
                        PolicyRule.from_wire(rule) if isinstance(rule, Mapping) else rule
                    )
            elif isinstance(ref, str) and ref:
                cited = True
        supplied = (request or {}).get("policyRules") or []
        for rule in supplied:
            rules.append(PolicyRule.from_wire(rule) if isinstance(rule, Mapping) else rule)
        if not cited:
            return ()
        return tuple(rules)

    @staticmethod
    def _pins(
        plan: ExecutionPlan,
        rules: Sequence[PolicyRule],
        definition_hash: str,
        artifact: Mapping[str, Any] | None,
    ) -> dict[str, Any]:
        """Everything this run is pinned to, so later policy drift cannot reach it."""
        rule_wires = [rule.to_wire() for rule in rules]
        return {
            "graphId": plan.graph_id,
            "graphVersion": str(plan.graph_version),
            "definitionHash": definition_hash or plan.definition_hash,
            "planHash": plan.plan_hash,
            "dependencyLockHash": plan.dependency_lock_hash,
            "compilerVersion": plan.compiler_version,
            "schemaVersion": str(SCHEMA_VERSION),
            "protocolVersion": str(PROTOCOL_VERSION),
            "policyRules": rule_wires,
            "policyHash": hashing.hash_domain("pf.policy-set", rule_wires),
            "closure": dict(plan.closure or (artifact or {}).get("closure") or {}),
        }

    @staticmethod
    def _apply_run_workspace_requirement(
        plan: ExecutionPlan,
        raw_requirement: Any,
    ) -> ExecutionPlan:
        """Pin a board-authored repository commit into this run's code.modify plan nodes.

        Paperclip remains the provider and owns workspace creation. The Core records the exact
        repo/ref/commit in the run-specific plan, so later node intents and dispatch checks use
        the same immutable source. A graph cannot turn this input into code authority: only
        nodes already declared as code.modify receive it.
        """
        code_nodes = [
            node for node in plan.nodes.values()
            if "code.modify" in node.required_capabilities or node.operation.get("id") == "code.modify"
        ]
        if raw_requirement is None:
            if code_nodes:
                raise errors.contract_invalid(
                    "this graph has code.modify nodes and admission did not carry a verified workspace requirement",
                    graphId=plan.graph_id,
                    nodes=sorted(node.node_id for node in code_nodes),
                )
            return plan
        if not code_nodes:
            raise errors.contract_invalid(
                "workspaceRequirement was supplied, but this run has no code.modify node to receive it",
                graphId=plan.graph_id,
            )
        if not isinstance(raw_requirement, Mapping) or set(raw_requirement) != {
            "mode", "repositories", "requireReadOnlyForReviewer"
        }:
            raise errors.contract_invalid("workspaceRequirement must use the exact supported schema")
        repositories = raw_requirement.get("repositories")
        if (
            raw_requirement.get("mode") != "read_write"
            or raw_requirement.get("requireReadOnlyForReviewer") is not False
            or not isinstance(repositories, list)
            or len(repositories) != 1
            or not isinstance(repositories[0], Mapping)
            or set(repositories[0]) != {"repoRef", "baseRef", "commit"}
        ):
            raise errors.contract_invalid(
                "Phase 0–4 code execution supports exactly one writable repository with an exact commit pin"
            )
        repo = repositories[0]
        repo_ref, base_ref, commit = repo.get("repoRef"), repo.get("baseRef"), repo.get("commit")
        if (
            not isinstance(repo_ref, str) or not repo_ref.strip()
            or not isinstance(base_ref, str) or not base_ref.strip()
            or not isinstance(commit, str) or len(commit) not in (40, 64)
            or any(character not in "0123456789abcdefABCDEF" for character in commit)
        ):
            raise errors.contract_invalid("workspaceRequirement commit must be a full Git object ID")
        requirement = {
            "mode": "read_write",
            "repositories": [{"repoRef": repo_ref, "baseRef": base_ref, "commit": commit.lower()}],
            "requireReadOnlyForReviewer": False,
        }
        nodes = dict(plan.nodes)
        for node in code_nodes:
            if node.workspace_requirement is not None and dict(node.workspace_requirement) != requirement:
                raise errors.contract_invalid(
                    "the run workspace pin conflicts with a code.modify node's published workspace requirement",
                    nodeId=node.node_id,
                )
            nodes[node.node_id] = replace(node, workspace_requirement=requirement)
        candidate = replace(plan, nodes=nodes, plan_hash="")
        return replace(candidate, plan_hash=compute_plan_hash(candidate))

    @staticmethod
    def _missing_required_facts(plan: ExecutionPlan, request: Mapping[str, Any]) -> list[str]:
        supplied = request.get("requiredFacts") or {}
        missing: list[str] = []
        for fact in plan.required_facts:
            value = supplied.get(fact)
            if not isinstance(value, Mapping):
                missing.append(f"fact {fact!r} was not supplied")
                continue
            # Provenance is mandatory: an imported fact with no source, revision, or digest is
            # a claim, and a side entry point must not be enterable on a claim.
            if not value.get("source") or not value.get("sourceRevision") or not value.get(
                "contentHash"
            ):
                missing.append(
                    f"fact {fact!r} lacks verifiable provenance (source, sourceRevision, contentHash)"
                )
        return missing

    def _resolve_required_fact_sources(
        self,
        scope: Scope,
        plan: ExecutionPlan,
        raw_sources: Any,
    ) -> dict[str, dict[str, str]]:
        """Resolve imported prerequisites from completed, same-scope GraphRun gate exports.

        A source Run ID is only a selector, never proof by itself. The Core verifies the exact
        run scope and terminal state, the immutable source plan's export contract, and the
        currently-passed gate execution before deriving provenance hashes to pin on the new run.
        """
        if raw_sources is None:
            return {}
        if not isinstance(raw_sources, Mapping):
            raise errors.contract_invalid("requiredFactSources must be an object keyed by fact name")
        if not plan.required_facts:
            raise errors.contract_invalid(
                "requiredFactSources were supplied for an entrypoint with no required facts"
            )
        supplied_names = {str(name) for name in raw_sources}
        required_names = set(plan.required_facts)
        if supplied_names != required_names:
            raise errors.contract_invalid(
                "requiredFactSources must name exactly the entrypoint's required facts",
                requiredFacts=sorted(required_names),
                suppliedFacts=sorted(supplied_names),
            )

        resolved: dict[str, dict[str, str]] = {}
        for fact_name in sorted(required_names):
            source = raw_sources.get(fact_name)
            if (
                not isinstance(source, Mapping)
                or set(source) != {"sourceRunId"}
                or not isinstance(source.get("sourceRunId"), str)
                or not str(source.get("sourceRunId", "")).strip()
            ):
                raise errors.contract_invalid(
                    "each required fact source must contain only a non-empty sourceRunId",
                    fact=fact_name,
                )
            source_run_id = str(source["sourceRunId"])
            source_run = self.db.query_one(
                "SELECT * FROM graph_runs WHERE run_id = ? AND company_ref = ? AND project_ref = ?",
                (source_run_id, scope.company_ref, scope.project_ref),
            )
            if source_run is None:
                raise errors.contract_invalid(
                    "required fact source must be a visible GraphRun in the same company and project",
                    fact=fact_name,
                )
            if str(source_run["status"]) != GraphRunStatus.COMPLETED:
                raise errors.contract_invalid(
                    "required fact source GraphRun must be COMPLETED",
                    fact=fact_name,
                    sourceRunId=source_run_id,
                    sourceStatus=str(source_run["status"]),
                )
            source_plan = self._plan(source_run)
            if fact_name not in source_plan.export_kinds:
                raise errors.contract_invalid(
                    "required fact is not an export of the source GraphRun's pinned plan",
                    fact=fact_name,
                    sourceRunId=source_run_id,
                    sourceGraphId=source_plan.graph_id,
                )
            gates = [
                node for node in source_plan.nodes.values()
                if node.is_gate and fact_name in node.produces
            ]
            if len(gates) != 1:
                raise errors.contract_invalid(
                    "required fact must be produced by exactly one gate in the source GraphRun",
                    fact=fact_name,
                    sourceRunId=source_run_id,
                    gateCount=len(gates),
                )
            gate = gates[0]
            gate_row = self.db.query_one(
                "SELECT status, iteration, output_digest FROM node_executions"
                " WHERE run_id = ? AND node_id = ? ORDER BY iteration DESC LIMIT 1",
                (source_run_id, gate.node_id),
            )
            if gate_row is None or str(gate_row["status"]) != NodeStatus.PASSED:
                raise errors.contract_invalid(
                    "required fact source gate is not currently PASSED",
                    fact=fact_name,
                    sourceRunId=source_run_id,
                    gateId=gate.node_id,
                )
            content_hash = str(gate_row["output_digest"] or "")
            if (
                len(content_hash) != 71
                or not content_hash.startswith("sha256:")
                or any(character not in "0123456789abcdef" for character in content_hash[7:])
            ):
                raise errors.contract_invalid(
                    "required fact source gate has no valid Core output digest",
                    fact=fact_name,
                    sourceRunId=source_run_id,
                    gateId=gate.node_id,
                )
            resolved[fact_name] = {
                "source": f"graph-run:{source_run_id}#{gate.node_id}",
                "sourceRevision": f"{source_run['plan_hash']}@{source_run['state_version']}",
                "contentHash": content_hash,
            }
        return resolved

    def _capability_bindings(self, scope: Scope) -> list[dict[str, Any]]:
        """The governed capability bindings that exist in this scope.

        Read from the store rather than from the request, because the bindings are the
        governed record; a caller may *name* a subject but it may not grant one.
        """
        rows = self.db.query(
            "SELECT subject_ref, capability_ref, entrypoints_json FROM capability_bindings"
            " WHERE company_ref = ? AND project_ref = ? AND revoked = 0"
            " ORDER BY subject_ref, capability_ref",
            (scope.company_ref, scope.project_ref),
        )
        by_subject: dict[str, dict[str, Any]] = {}
        for row in rows:
            entry = by_subject.setdefault(
                str(row["subject_ref"]),
                {
                    "subjectRef": str(row["subject_ref"]),
                    "capabilities": [],
                    "entrypoints": loads(row["entrypoints_json"], []) or [],
                },
            )
            entry["capabilities"].append(str(row["capability_ref"]))
        return [by_subject[key] for key in sorted(by_subject)]

    def capability_subjects(
        self, scope: Scope, required_capabilities: Sequence[str]
    ) -> list[str]:
        """Project-scoped subjects holding every capability in ``required_capabilities``.

        The Runtime exposes this read to admission so the bridge can pin node policies from
        the same governed capability records the Core uses to dispatch and claim work.
        """
        required = set(required_capabilities)
        if not required:
            return []
        return sorted(
            str(binding["subjectRef"])
            for binding in self._capability_bindings(scope)
            if required.issubset(set(binding.get("capabilities") or ()))
        )

    @staticmethod
    def _sibling_admission_blockers(
        definition: Mapping[str, Any],
        plan: ExecutionPlan,
        entrypoint: str,
        request: Mapping[str, Any],
        capability_bindings: Sequence[Mapping[str, Any]] | None = None,
    ) -> list[str]:
        """Ask the entrypoints module when it is installed.

        Imported lazily and optionally so the Core's own admission rules stand on their own.
        A missing module means fewer *extra* checks, not fewer of the ones implemented here —
        and a signature drift degrades to the local checks rather than guessing a call shape.
        """
        try:
            from polyforge.core.entrypoints.admission import admit  # type: ignore[import-not-found]
        except ImportError:
            return []
        try:
            result = admit(
                definition,
                entrypoint,
                input_snapshot=dict(request.get("inputSnapshot") or {}),
                required_facts=dict(request.get("requiredFacts") or {}),
                capability_bindings=list(capability_bindings or ()) or None,
            )
        except TypeError:
            # Signature drift between agents: keep the Core's own checks rather than guessing.
            return []
        except errors.PolyForgeError as exc:
            return [exc.message]
        if getattr(result, "ok", False):
            return []
        return [
            str(getattr(blocker, "message", blocker))
            for blocker in (getattr(result, "blockers", ()) or ())
        ]

    # ------------------------------------------------------------------
    # queries
    # ------------------------------------------------------------------

    def get_run(
        self, run_id: str, *, scope: Scope | Mapping[str, Any] | None = None
    ) -> dict[str, Any]:
        resolved = self._scope(scope)
        run = self._load_run(run_id, scope=resolved, operation="read run")
        return self._snapshot(run).to_wire()

    def list_runs(
        self,
        *,
        scope: Scope | Mapping[str, Any] | None = None,
        graph_id: str | None = None,
        status: str | None = None,
        limit: int = 50,
    ) -> list[dict[str, Any]]:
        resolved = self._scope(scope)
        clauses: list[str] = []
        params: list[Any] = []
        if resolved is not None:
            clauses.append("company_ref = ? AND project_ref = ?")
            params.extend([resolved.company_ref, resolved.project_ref])
        if graph_id:
            clauses.append("graph_id = ?")
            params.append(str(graph_id))
        if status:
            clauses.append("status = ?")
            params.append(str(status))
        where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
        rows = self.db.query(
            f"SELECT * FROM graph_runs{where} ORDER BY created_at DESC, run_id DESC LIMIT ?",
            [*params, max(1, int(limit))],
        )
        return [self._snapshot(row, detail=False).to_wire() for row in rows]

    def list_events(
        self,
        run_id: str,
        *,
        after: int = 0,
        limit: int = 200,
        scope: Scope | Mapping[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        resolved = self._scope(scope)
        run = self._load_run(run_id, scope=resolved, operation="read events")
        rows = self.db.query(
            "SELECT * FROM domain_events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?",
            (str(run["run_id"]), int(after), max(1, int(limit))),
        )
        return [
            DomainEvent(
                seq=int(r["seq"]),
                run_id=str(r["run_id"]),
                type=str(r["type"]),
                at=str(r["at"]),
                payload=loads(r["payload_json"], {}) or {},
            ).to_wire()
            for r in rows
        ]

    def _snapshot(self, run: Mapping[str, Any], *, detail: bool = True) -> RunSnapshot:
        run_id = str(run["run_id"])
        company, project = str(run["company_ref"]), str(run["project_ref"])
        node_rows = self._node_rows(run_id)
        blockers: list[Blocker] = []
        budget = self._budget_blocker(run)
        if budget is not None:
            blockers.append(budget)
        for row in node_rows:
            if row.get("block_reason"):
                blockers.append(
                    Blocker(
                        code="NODE_BLOCKED",
                        reason=str(row["block_reason"]),
                        message=str(row.get("wait_reason") or "node is blocked"),
                        detail={"nodeId": str(row["node_id"])},
                    )
                )
        for effect in self.db.query(
            "SELECT effect_key FROM effect_records WHERE company_ref = ? AND project_ref = ?"
            " AND run_id = ? AND status = 'UNKNOWN'",
            (company, project, run_id),
        ):
            blockers.append(
                Blocker(
                    code="EFFECT_UNKNOWN",
                    reason=str(BlockReason.EFFECT_UNKNOWN),
                    message=(
                        "an external effect outcome is unknown; only an authoritative "
                        "non-occurrence permits another attempt"
                    ),
                    detail={"effectKey": str(effect["effect_key"])},
                )
            )

        attempts: list[ExecutionAttempt] = []
        gates: list[GateEvaluationRecord] = []
        evidence: list[EvidenceRecord] = []
        pending: list[PendingGovernance] = []
        effects: list[EffectRecord] = []
        if detail:
            for row in self.db.query(
                "SELECT * FROM execution_attempts WHERE run_id = ? ORDER BY started_at, attempt_id",
                (run_id,),
            ):
                attempts.append(ExecutionAttempt.from_row(row))
            for row in self.db.query(
                "SELECT * FROM gate_evaluations WHERE run_id = ?"
                # ``created_at`` alone is ambiguous: a frozen clock gives every evaluation in one
                # command the same stamp, so the numbered counter is the tiebreak that makes the
                # read model deterministic.
                " ORDER BY created_at, gate_id, evaluator_ref, evaluation_no, evaluation_id",
                (run_id,),
            ):
                gates.append(GateEvaluationRecord.from_row(row))
            for row in self.evidence.list_for_run(
                company_ref=company, project_ref=project, run_id=run_id
            ):
                evidence.append(EvidenceRecord.from_row(row))
            for row in self.db.query(
                "SELECT * FROM governance_bindings WHERE run_id = ? AND state = 'PENDING'"
                " ORDER BY created_at, request_id",
                (run_id,),
            ):
                pending.append(PendingGovernance.from_row(row))
            for row in self.effects.list_for_run(
                company_ref=company, project_ref=project, run_id=run_id
            ):
                effects.append(EffectRecord.from_row(row))

        return RunSnapshot(
            run_id=run_id,
            family_id=str(run["family_id"]),
            work_order_id=str(run["work_order_id"]),
            graph_id=str(run["graph_id"]),
            graph_version=int(run["graph_version"]),
            status=str(run["status"]),
            state_version=int(run["state_version"]),
            event_sequence=int(run["event_sequence"]),
            owner_epoch=int(run["owner_epoch"]),
            entrypoint=str(run["entrypoint"]),
            parent_run_id=run.get("parent_run_id"),
            parent_node_id=run.get("parent_node_id"),
            invocation_generation=int(run["invocation_generation"]),
            scope=Scope(company, project),
            pins=loads(run["pins_json"], {}) or {},
            root_issue_ref=loads(run["root_issue_ref_json"], None),
            budget_state=self._budget_state(run) or None,
            block_reason=run.get("block_reason"),
            nodes=[NodeExecutionView.from_row(r) for r in node_rows],
            attempts=attempts,
            gates=gates,
            evidence=evidence,
            pending_governance=pending,
            effects=effects,
            blockers=blockers,
            created_at=str(run["created_at"]),
            updated_at=str(run["updated_at"]),
        )

    # ------------------------------------------------------------------
    # claims and leases
    # ------------------------------------------------------------------

    def claim(self, request: Mapping[str, Any]) -> dict[str, Any]:
        """Bind a platform agent run to an approved attempt, establishing the lease fence.

        One active claim per ``(run, node, iteration)`` is enforced by a partial unique index
        in the schema, so two owners racing in two processes still produce one admitted claim.
        """
        scope = self._require_scope_field(request.get("scope"))
        run_id = str(request.get("runId", ""))
        try:
            with self.db.transaction():
                return self._claim_tx(scope, request)
        except errors.PolyForgeError as exc:
            run = self.db.query_one("SELECT * FROM graph_runs WHERE run_id = ?", (run_id,))
            self._record_refusal(
                exc,
                run=run,
                node_id=str(request.get("nodeId", "")) or None,
                attempt_id=str(request.get("attemptId", "")) or None,
                command_id=str(request.get("commandId", "")) or None,
                idempotency_key=str(request.get("idempotencyKey", "")) or None,
                kind="claim",
                payload=request,
            )
            raise

    def _claim_tx(self, scope: Scope, request: Mapping[str, Any]) -> dict[str, Any]:
        raw_epoch = request.get("leaseEpoch")
        if raw_epoch is not None and (isinstance(raw_epoch, bool) or not isinstance(raw_epoch, int)):
            raise errors.bad_request("leaseEpoch must be an integer", field="leaseEpoch")
        if request.get("attemptId") not in (None, ""):
            raise errors.contract_invalid(
                "attemptId is allocated by Core and may not be supplied by a caller",
                field="attemptId",
            )
        run = self._load_run_in_scope(str(request.get("runId", "")), scope, operation="claim")
        run_id = str(run["run_id"])
        if str(run["status"]) in _TERMINAL_RUN:
            raise errors.run_blocked(
                f"run is {run['status']}; a terminal run cannot be claimed",
                runId=run_id,
                status=str(run["status"]),
            )
        if str(run["status"]) == GraphRunStatus.PAUSED:
            raise errors.run_blocked(
                "run is PAUSED; pause blocks new admission until an authorized resume",
                runId=run_id,
            )
        self._budget_lease(run)
        node_id = str(request.get("nodeId", ""))
        iteration = int(request.get("iteration", 0) or 0)
        node_row = self._node_row(run_id, node_id, iteration)
        if str(node_row["status"]) not in _CLAIMABLE_NODE_STATES:
            raise errors.run_blocked(
                f"node {node_id!r} is {node_row['status']} and cannot be claimed; only a node the "
                "planner released may take a lease",
                nodeId=node_id,
                status=str(node_row["status"]),
                runId=run_id,
            )
        rework = int(node_row.get("rework_count", 0) or 0)
        ceiling = int(node_row.get("max_rework", self.default_max_rework) or self.default_max_rework)
        if rework >= ceiling:
            # The engineering rework budget is the Core's own, and it stops dispatch just as a
            # financial stop does. Enforced at the claim so no path can route around it.
            raise errors.run_blocked(
                f"node {node_id!r} has exhausted its engineering rework budget ({rework}/{ceiling}); "
                "claiming it again would be a bypass of a budget, not a retry",
                nodeId=node_id,
                runId=run_id,
                reworkCount=rework,
                maxRework=ceiling,
            )
        agent_subject = str(request.get("agentSubject", ""))
        if not agent_subject:
            raise errors.bad_request("agentSubject is required; a claim has no anonymous owner")
        plan = self._plan(run)
        node_plan = self._plan_node(plan, node_id)
        if node_plan.independent_from:
            upstream_subjects = self._upstream_producer_subjects(run_id, plan, node_id, scope)
            if agent_subject in upstream_subjects:
                raise errors.authorization_denied(
                    f"subject {agent_subject!r} produced upstream work and cannot claim the "
                    f"independent node {node_id!r}",
                    runId=run_id,
                    nodeId=node_id,
                    subject=agent_subject,
                    independentFrom=list(node_plan.independent_from),
                    upstreamProducerSubjects=sorted(upstream_subjects),
                )
        agent_run_ref = request.get("agentRunRef")
        if agent_run_ref is not None and (
            not isinstance(agent_run_ref, Mapping) or not agent_run_ref.get("id")
        ):
            raise errors.bad_request(
                "agentRunRef must carry the authenticated platform run id; an unbound claim would "
                "have no execution identity to fence"
            )
        contract_hash = self._ensure_contract(run, node_row, agent_subject=agent_subject)
        declared = request.get("contractHash")
        if declared is not None and str(declared) != contract_hash:
            raise errors.contract_invalid(
                f"claim presents contract {declared} but the node's current contract is "
                f"{contract_hash}; a worker may not claim a different contract than the planned one",
                nodeId=node_id,
                runId=run_id,
            )

        presented_epoch = raw_epoch
        existing = self._active_claim(run_id, node_id, iteration)
        now = self._now()
        if existing is not None:
            existing_epoch = int(existing["lease_epoch"])
            if str(existing["agent_subject"] or "") == agent_subject and presented_epoch is not None and int(
                presented_epoch
            ) == existing_epoch:
                # Create-or-verify: the same worker re-claiming its own live lease is a no-op.
                return ExecutionAttempt.from_row(existing).to_wire()
            required_epoch = existing_epoch + 1
            if presented_epoch is None or int(presented_epoch) != required_epoch:
                raise errors.lease_fenced(
                    f"node {node_id!r} is already claimed at epoch {existing_epoch}; a takeover must "
                    f"present exactly the next epoch {required_epoch}",
                    nodeId=node_id,
                    runId=run_id,
                    presentedEpoch=int(presented_epoch) if presented_epoch is not None else None,
                    activeEpoch=existing_epoch,
                    requiredEpoch=required_epoch,
                    attemptId=str(existing["attempt_id"]),
                    holderSubject=str(existing["agent_subject"] or ""),
                )
            prior_state = str(request.get("priorWorkerState", "") or "")
            if prior_state not in ("fenced", "stopped"):
                # Expiry alone is not permission: the old worker may still be running. A
                # replacement claim is admissible only on a provider-confirmed stop or fence.
                raise errors.lease_fenced(
                    f"node {node_id!r} is held by {existing['agent_subject']!r} at epoch "
                    f"{existing_epoch}; a takeover requires a provider confirmation that the "
                    f"previous worker is stopped or fenced, and none was supplied "
                    f"(priorWorkerState={prior_state or 'absent'})",
                    nodeId=node_id,
                    runId=run_id,
                    presentedEpoch=int(presented_epoch),
                    activeEpoch=existing_epoch,
                    attemptId=str(existing["attempt_id"]),
                    holderSubject=str(existing["agent_subject"] or ""),
                    requiredPriorWorkerState=["fenced", "stopped"],
                )
            self.db.execute(
                "UPDATE execution_attempts SET lease_state = 'FENCED', status = ?, finished_at = ?,"
                " updated_at = ? WHERE company_ref = ? AND project_ref = ? AND attempt_id = ?",
                (
                    AttemptStatus.CANCELLED,
                    now,
                    now,
                    scope.company_ref,
                    scope.project_ref,
                    str(existing["attempt_id"]),
                ),
            )

        attempt_row = self.db.query_one(
            "SELECT COALESCE(MAX(attempt_no), 0) AS attempt_no FROM execution_attempts"
            " WHERE run_id = ? AND node_id = ? AND iteration = ?",
            (run_id, node_id, iteration),
        )
        attempt_no = int(attempt_row["attempt_no"]) + 1
        if existing is None and presented_epoch is not None and int(presented_epoch) != attempt_no:
            raise errors.lease_fenced(
                f"node {node_id!r} expects initial lease epoch {attempt_no}, not {presented_epoch}",
                nodeId=node_id,
                runId=run_id,
                presentedEpoch=int(presented_epoch),
                requiredEpoch=attempt_no,
            )
        epoch = int(presented_epoch) if presented_epoch is not None else attempt_no
        attempt_id = ids.new_id("attempt")
        issue_ref = dumps(dict(request["issueRef"])) if request.get("issueRef") else None
        self.db.execute(
            "INSERT INTO execution_attempts (attempt_id, company_ref, project_ref, run_id, node_id,"
            " iteration, attempt_no, transition_hash, contract_hash, status, lease_epoch, lease_state,"
            " agent_subject, agent_run_ref_json, issue_ref_json, adapter_binding_json, started_at,"
            " finished_at, lease_expires_at, checkpoint_ref, created_at, updated_at)"
            " VALUES (:attempt_id, :company_ref, :project_ref, :run_id, :node_id, :iteration,"
            " :attempt_no, :transition_hash, :contract_hash, 'RUNNING', :lease_epoch, 'ACTIVE',"
            " :agent_subject, :agent_run_ref_json, :issue_ref_json, :adapter_binding_json, :now,"
            " NULL, :lease_expires_at, NULL, :now, :now)",
            {
                "attempt_id": attempt_id,
                "company_ref": scope.company_ref,
                "project_ref": scope.project_ref,
                "run_id": run_id,
                "node_id": node_id,
                "iteration": iteration,
                "attempt_no": attempt_no,
                "transition_hash": contract_hash,
                "contract_hash": contract_hash,
                "lease_epoch": epoch,
                "agent_subject": agent_subject,
                "agent_run_ref_json": dumps(dict(agent_run_ref)) if agent_run_ref else None,
                "issue_ref_json": issue_ref,
                "adapter_binding_json": dumps(dict(request["adapterBinding"]))
                if request.get("adapterBinding")
                else None,
                "now": now,
                "lease_expires_at": self._later(self.lease_ttl_seconds),
            },
        )
        self.db.execute(
            "UPDATE node_executions SET status = ?, active_attempt_id = ?, assigned_subject = ?,"
            " assigned_issue_ref_json = ?, wait_reason = NULL, block_reason = NULL, updated_at = ?"
            " WHERE run_id = ? AND node_id = ? AND iteration = ?",
            (
                NodeStatus.RUNNING,
                attempt_id,
                agent_subject,
                issue_ref,
                now,
                run_id,
                node_id,
                iteration,
            ),
        )
        self.db.execute(
            "INSERT INTO work_bindings (binding_id, company_ref, project_ref, run_id, node_id,"
            " iteration, issue_ref_json, contract_hash, workspace_ref_json, projection_version,"
            " execution_owner, owner_epoch, created_at, updated_at)"
            " VALUES (:binding_id, :company_ref, :project_ref, :run_id, :node_id, :iteration,"
            " :issue_ref_json, :contract_hash, :workspace_ref_json, 0, :execution_owner,"
            " :owner_epoch, :now, :now)"
            " ON CONFLICT(company_ref, project_ref, run_id, node_id, iteration) DO UPDATE SET"
            " issue_ref_json = excluded.issue_ref_json, contract_hash = excluded.contract_hash,"
            " execution_owner = excluded.execution_owner, owner_epoch = excluded.owner_epoch,"
            " updated_at = excluded.updated_at",
            {
                "binding_id": ids.new_id("binding"),
                "company_ref": scope.company_ref,
                "project_ref": scope.project_ref,
                "run_id": run_id,
                "node_id": node_id,
                "iteration": iteration,
                "issue_ref_json": issue_ref,
                "contract_hash": contract_hash,
                "workspace_ref_json": dumps(dict(request["workspaceRef"]))
                if request.get("workspaceRef")
                else None,
                "execution_owner": agent_subject,
                "owner_epoch": epoch,
                "now": now,
            },
        )
        state_version = self._bump(
            run_id,
            status=str(GraphRunStatus.ACTIVE) if str(run["status"]) == GraphRunStatus.CREATED else None,
        )
        self._emit(
            run_id,
            "pf.execution.observed",
            {
                "nodeId": node_id,
                "iteration": iteration,
                "attemptId": attempt_id,
                "attemptNo": attempt_no,
                "leaseEpoch": epoch,
                "agentSubject": agent_subject,
                "agentRunRef": dict(agent_run_ref) if agent_run_ref else None,
                "contractHash": contract_hash,
            },
            correlation_id=str(request.get("correlationId", "")) or None,
        )
        refreshed = self._load_run_in_scope(run_id, scope, operation="claim")
        self._checkpoint(
            refreshed,
            node_id=node_id,
            attempt_id=attempt_id,
            contract_hash=contract_hash,
            state_version=state_version,
        )
        row = self.db.query_one(
            "SELECT * FROM execution_attempts WHERE company_ref = ? AND project_ref = ?"
            " AND attempt_id = ?",
            (scope.company_ref, scope.project_ref, attempt_id),
        )
        assert row is not None
        return ExecutionAttempt.from_row(row).to_wire()

    # ------------------------------------------------------------------
    # transition contracts
    # ------------------------------------------------------------------

    def _required_evidence_kinds(self, plan: ExecutionPlan, node_plan: PlanNode) -> list[str]:
        """What this node must be able to evidence for its own transition.

        A work node must show what it produces. A gate must show the facts it judges —
        otherwise an "independent review" would have nothing to review and a gate could pass
        against an empty artifact set.
        """
        if node_plan.is_gate:
            # A gate judges the facts it consumes, so those are the evidence kinds it must
            # hold before it may be evaluated at all.
            return [name for name, _fact in sorted(node_plan.inputs.items())]
        return list(node_plan.produces)

    def _required_evaluators(self, node_plan: PlanNode) -> list[RequiredEvaluator]:
        refs: list[str] = list(node_plan.evaluator_refs) or list(_DEFAULT_EVALUATORS)
        if node_plan.human_decision and bool(node_plan.human_decision.get("required")):
            if "human_decision" not in refs:
                refs.append("human_decision")
        evaluators: list[RequiredEvaluator] = []
        for ref in refs:
            if any(existing.ref == ref for existing in evaluators):
                continue
            evaluator = self.evaluators.get(ref)
            evaluators.append(
                RequiredEvaluator(
                    ref=ref,
                    kind=str(getattr(evaluator, "kind", EvaluatorKind.AUTOMATIC))
                    if evaluator
                    else str(EvaluatorKind.AUTOMATIC),
                    version=str(getattr(evaluator, "version", "0")) if evaluator else "0",
                    mandatory=True,
                )
            )
        return evaluators

    def _ensure_contract(
        self,
        run: Mapping[str, Any],
        node_row: Mapping[str, Any],
        *,
        agent_subject: str = "",
        environment: Mapping[str, Any] | None = None,
        grants: PlatformGrants | None = None,
    ) -> str:
        """Build and persist the node's transition contract if it does not exist yet.

        Created at claim time, before the worker can act, so the thing the worker is told to
        do and the thing the gate later evaluates are the same identified object.
        """
        existing = node_row.get("contract_hash")
        if existing:
            return str(existing)
        plan = self._plan(run)
        run_id = str(run["run_id"])
        node_id = str(node_row["node_id"])
        node_plan = self._plan_node(plan, node_id)
        node_rows = self._node_rows(run_id)
        facts = self._available_facts(run, node_rows)
        exports = self._available_exports(run, node_rows)
        inputs = self._input_digests(node_plan, exports, facts)
        env = dict(environment or node_plan.workspace_requirement or {})
        action = f"node.{node_id}.execute"
        policy = self._resolve_policy(
            run,
            action=action,
            resource=node_id,
            environment=str(env.get("environment", "production")),
            agent_subject=agent_subject,
            transition_ref=f"{plan.graph_id}.{node_id}",
            grants=grants,
            phase="admission",
        )
        contract = build_contract(
            run=run,
            node={**node_row, "node_id": node_id, "iteration": int(node_row["iteration"])},
            # The compiler version travels in the hashed payload, so a contract compiled by a
            # different compiler is a different contract rather than a silently equal one.
            plan={"compiler_version": plan.compiler_version, "plan_hash": plan.plan_hash},
            node_plan=node_plan.to_canonical(),
            policy=policy,
            inputs=inputs,
            subject={
                "nodeKind": node_plan.kind,
                "requiredCapabilities": list(node_plan.required_capabilities),
                "independentFrom": list(node_plan.independent_from),
                "graphEntryPoint": plan.entrypoint,
            },
            operation=dict(node_plan.operation or {}),
            authority={
                "action": action,
                "resource": node_id,
                "environment": str(env.get("environment", "production")),
                "policyRule": policy.rule_id,
                "grantedAuthority": policy.granted_authority,
            },
            environment=env,
            mutations=self._intended_mutations(node_plan),
            required_evidence_kinds=self._required_evidence_kinds(plan, node_plan),
            required_evaluators=[e.to_wire() for e in self._required_evaluators(node_plan)],
        )
        now = self._now()
        existing_row = self.db.query_one(
            "SELECT contract_id FROM transition_contracts WHERE company_ref = ?"
            " AND project_ref = ? AND run_id = ? AND contract_hash = ?",
            (str(run["company_ref"]), str(run["project_ref"]), run_id, contract.hash),
        )
        contract_id = (
            str(existing_row["contract_id"])
            if existing_row is not None
            else ids.new_id("contract")
        )
        self.db.execute(
            "INSERT INTO transition_contracts (contract_id, company_ref, project_ref, run_id,"
            " node_id, iteration, operation_id, operation_version, subject_json, plan_hash,"
            " contract_hash, contract_schema_version, policy_json, authority_json, environment_json,"
            " inputs_json, mutations_json, required_evidence_json, required_evaluators_json,"
            " created_at, updated_at)"
            " VALUES (:contract_id, :company_ref, :project_ref, :run_id, :node_id, :iteration,"
            " :operation_id, :operation_version, :subject_json, :plan_hash, :contract_hash,"
            " :contract_schema_version, :policy_json, :authority_json, :environment_json,"
            " :inputs_json, :mutations_json, :required_evidence_json, :required_evaluators_json,"
            " :now, :now)"
            " ON CONFLICT(company_ref, project_ref, run_id, contract_hash) DO NOTHING",
            {
                "contract_id": contract_id,
                "company_ref": str(run["company_ref"]),
                "project_ref": str(run["project_ref"]),
                "run_id": run_id,
                "node_id": node_id,
                "iteration": int(node_row["iteration"]),
                "operation_id": contract.operation_id,
                "operation_version": contract.operation_version,
                "subject_json": dumps(contract.subject),
                "plan_hash": contract.plan_hash,
                "contract_hash": contract.hash,
                "contract_schema_version": contract.contract_schema_version,
                "policy_json": dumps(policy.to_wire()),
                "authority_json": dumps(contract.authority),
                "environment_json": dumps(contract.environment),
                "inputs_json": dumps(contract.inputs),
                "mutations_json": dumps(contract.intended_mutations),
                "required_evidence_json": dumps(contract.required_evidence_kinds),
                "required_evaluators_json": dumps(
                    [e.to_wire() for e in contract.required_evaluators]
                ),
                "now": now,
            },
        )
        self.db.execute(
            "UPDATE node_executions SET contract_hash = ?, contract_id = ?, input_digest_json = ?,"
            " updated_at = ? WHERE run_id = ? AND node_id = ? AND iteration = ?",
            (
                contract.hash,
                contract_id,
                dumps(contract.inputs),
                now,
                run_id,
                node_id,
                int(node_row["iteration"]),
            ),
        )
        return contract.hash

    @staticmethod
    def _intended_mutations(node_plan: PlanNode) -> list[dict[str, Any]]:
        mutations: list[dict[str, Any]] = []
        for produced in node_plan.produces:
            # A gate judging an outcome is asserting it, so its own mutation is flagged as
            # requiring a trusted execution record: a worker's own claim cannot satisfy it.
            mutations.append(
                {
                    "kind": produced,
                    "target": produced,
                    "operation": "produce",
                    "requiresTrustedExecution": node_plan.is_gate,
                }
            )
        if node_plan.permission_gate:
            mutations.append(
                {
                    "kind": "permission_gate",
                    "target": str(node_plan.permission_gate.get("resource", node_plan.node_id)),
                    "operation": "check",
                    "action": str(node_plan.permission_gate.get("action", "")),
                }
            )
        return mutations

    def _load_contract_row(self, run_id: str, contract_hash: str) -> dict[str, Any]:
        row = self.db.query_one(
            "SELECT * FROM transition_contracts WHERE run_id = ? AND contract_hash = ?",
            (str(run_id), str(contract_hash)),
        )
        if row is None:
            raise errors.not_found(
                f"no transition contract {contract_hash!r} for run {run_id!r}", runId=str(run_id)
            )
        return row

    def _contract_wire(self, row: Mapping[str, Any], run: Mapping[str, Any]) -> dict[str, Any]:
        """Assemble the contract payload a gate evaluates and a worker reads."""
        return {
            "nodeId": str(row["node_id"]),
            "iteration": int(row["iteration"]),
            "operation": {"id": str(row["operation_id"]), "version": int(row["operation_version"])},
            "subject": loads(row["subject_json"], {}) or {},
            "inputs": loads(row["inputs_json"], {}) or {},
            "effectivePolicy": loads(row["policy_json"], {}) or {},
            "authority": loads(row["authority_json"], {}) or {},
            "environment": loads(row["environment_json"], {}) or {},
            "intendedMutations": loads(row["mutations_json"], []) or [],
            "requiredEvidenceKinds": loads(row["required_evidence_json"], []) or [],
            "requiredEvaluators": loads(row["required_evaluators_json"], []) or [],
            "planHash": str(row["plan_hash"]),
            "graphId": str(run["graph_id"]),
            "graphVersion": int(run["graph_version"]),
            "definitionHash": str(run["definition_hash"]),
            "dependencyLockHash": str(run["dependency_lock_hash"]),
            "compilerVersion": COMPILER_VERSION,
            "contractHash": str(row["contract_hash"]),
            "contractId": str(row["contract_id"]),
            "contractSchemaVersion": int(row["contract_schema_version"]),
            "schemaVersion": SCHEMA_VERSION,
        }

    def _capability_holders(self, scope: Scope) -> dict[str, list[str]]:
        rows = self.db.query(
            "SELECT capability_ref, subject_ref FROM capability_bindings WHERE company_ref = ?"
            " AND project_ref = ? AND revoked = 0",
            (scope.company_ref, scope.project_ref),
        )
        holders: dict[str, list[str]] = {}
        for row in rows:
            holders.setdefault(str(row["capability_ref"]), []).append(str(row["subject_ref"]))
        return {k: sorted(v) for k, v in sorted(holders.items())}

    # ------------------------------------------------------------------
    # current / agent tools
    # ------------------------------------------------------------------

    def current(
        self,
        run_id: str,
        *,
        actor: Mapping[str, Any],
        node_id: str | None = None,
        adopt: bool = False,
    ) -> dict[str, Any]:
        """Return the current attempt's contract, inputs, and permitted next actions.

        With ``adopt=True`` this also performs a controlled takeover: a new attempt at an
        incremented lease epoch, admissible only once the platform has confirmed the previous
        worker is stopped or fenced. It never marks anything passed, and it never returns a
        "success" for work it did not verify.
        """
        scope = self._require_scope_field(actor.get("scope"), field="actor.scope")
        subject = str(actor.get("subjectRef", "") or actor.get("subject", ""))
        if not subject:
            raise errors.authorization_denied(
                "actor.subjectRef is required; the Core will not guess which subject is calling"
            )
        run = self._load_run(run_id, scope=scope, operation="current")
        run_id = str(run["run_id"])
        node_row = self._current_node_row(run_id, node_id, required=adopt)
        if adopt:
            self.claim(
                {
                    "scope": scope.to_wire(),
                    "runId": run_id,
                    "nodeId": str(node_row["node_id"]),
                    "iteration": int(node_row["iteration"]),
                    "agentSubject": subject,
                    "agentRunRef": actor.get("agentRunRef"),
                    "leaseEpoch": actor.get("leaseEpoch"),
                    "priorWorkerState": str(actor.get("priorWorkerState", "") or ""),
                    "commandId": str(actor.get("commandId", "")) or ids.new_id("command"),
                    "correlationId": run_id,
                }
            )
            node_row = self._node_row(run_id, str(node_row["node_id"]))
        contract_hash = node_row.get("contract_hash") or self._ensure_contract(
            run, node_row, agent_subject=subject
        )
        contract_row = self._load_contract_row(run_id, str(contract_hash))
        claim = self._active_claim(run_id, str(node_row["node_id"]), int(node_row["iteration"]))
        pending = self.db.query(
            "SELECT * FROM governance_bindings WHERE run_id = ? AND node_id = ?"
            " AND state = 'PENDING' ORDER BY created_at",
            (run_id, str(node_row["node_id"])),
        )
        refreshed = self._load_run_in_scope(run_id, scope, operation="current")
        return {
            "runId": run_id,
            "nodeId": str(node_row["node_id"]),
            "iteration": int(node_row["iteration"]),
            "stateVersion": int(refreshed["state_version"]),
            "status": str(node_row["status"]),
            "attempt": ExecutionAttempt.from_row(claim).to_wire() if claim else None,
            "contract": self._contract_wire(contract_row, run),
            "inputs": loads(node_row.get("input_digest_json"), {}) or {},
            "pendingGovernance": [PendingGovernance.from_row(p).to_wire() for p in pending],
            "permittedActions": self._permitted_actions(node_row, claim),
            # The two facts a bridge cannot infer, and must not have to guess.
            #
            # `previousOwnerAgentRunId` is the agent run whose attempt this one superseded. A caller
            # adopting a node has to stop that run before it takes the attempt, and it cannot know
            # who that is from `attempt`, which describes the *current* holder. Without this field
            # the adoption path had nothing to check, so a live previous owner would be adopted
            # silently. The attempt history is the authority, so the answer is read from it rather
            # than declared by the caller.
            "previousOwnerAgentRunId": self._previous_owner_agent_run_id(
                run_id, str(node_row["node_id"]), int(node_row["iteration"])
            ),
            # Whether a claim is possible right now, from the node's own state. The bridge used to
            # read a `claimable` flag that this response never carried, so it defaulted to "yes" and
            # a node the Core would refuse was still attempted.
            "claimable": self._is_claimable(node_row, claim, agent_subject=subject),
        }

    def _previous_owner_agent_run_id(
        self, run_id: str, node_id: str, iteration: int
    ) -> str | None:
        """The most recent superseded attempt's agent run, or ``None`` when there is not one."""
        row = self.db.query_one(
            "SELECT agent_run_ref_json AS agent_run_ref FROM execution_attempts"
            " WHERE run_id = ? AND node_id = ? AND iteration = ? AND lease_state != 'ACTIVE'"
            " ORDER BY lease_epoch DESC, started_at DESC LIMIT 1",
            (str(run_id), str(node_id), int(iteration)),
        )
        if row is None:
            return None
        ref = loads(row["agent_run_ref"], None)
        if isinstance(ref, Mapping):
            identifier = ref.get("id")
            return str(identifier) if identifier else None
        return None

    def _is_claimable(
        self,
        node_row: Mapping[str, Any],
        claim: Mapping[str, Any] | None,
        *,
        agent_subject: str | None,
    ) -> bool:
        """Can *this caller* claim this node right now?

        Scoped to the caller on purpose. "Is anyone holding it" is the wrong question: an agent run
        re-entering its own live claim must be able to read it back, and a run taking over an expired
        lease must be able to try. Only a node genuinely unavailable to this caller — held by
        *someone else*, or not in a state that accepts work — is unclaimable.

        The answer comes from stored state, never from the request: a caller that asserted its own
        claimability would make this check decorative.
        """
        if claim is not None:
            held_by = claim.get("agent_subject")
            return held_by is not None and agent_subject is not None and str(held_by) == str(agent_subject)
        return str(node_row["status"]) in (
            NodeStatus.PENDING.value,
            NodeStatus.READY.value,
            NodeStatus.DISPATCH_REQUESTED.value,
            NodeStatus.RUNNING.value,
        )


    def _permitted_actions(
        self, node_row: Mapping[str, Any], claim: Mapping[str, Any] | None
    ) -> list[str]:
        """What this attempt may do next. Derived from state, never granted by the caller."""
        if claim is None:
            return ["polyforge.current", "polyforge.status"]
        status = str(node_row["status"])
        actions = ["polyforge.current", "polyforge.status"]
        if status in (NodeStatus.RUNNING, NodeStatus.DISPATCH_REQUESTED):
            actions += [
                "polyforge.submit_artifact",
                "polyforge.submit_evidence",
                "polyforge.request_help",
            ]
        if status in (NodeStatus.RUNNING, NodeStatus.EVIDENCE_READY, NodeStatus.EVALUATING):
            actions.append("polyforge.request_transition")
        return sorted(set(actions))

    # ------------------------------------------------------------------
    # artifacts and evidence
    # ------------------------------------------------------------------

    def _envelope(self, envelope: Mapping[str, Any]) -> MutationEnvelope:
        env = MutationEnvelope.from_wire(envelope, scope=self._scope(envelope.get("scope")))
        if not env.command_id:
            raise errors.bad_request("commandId is required on every mutation")
        if not env.idempotency_key:
            raise errors.bad_request(
                "idempotencyKey is required on every mutation; without it a retry cannot be "
                "told apart from a new command"
            )
        return env

    def submit_artifacts(self, envelope: Mapping[str, Any]) -> dict[str, Any]:
        """Register fixed artifact references (create-or-verify)."""
        env = self._envelope(envelope)
        scope = self._resolve_envelope_scope(env.run_id, envelope.get("scope"))
        run = self._load_run(env.run_id, scope=scope, operation="submit artifacts")
        try:
            with self.db.transaction():
                result = self._submit_artifacts_tx(run, env)
        except errors.PolyForgeError as exc:
            self._record_refusal(
                exc,
                run=run,
                node_id=env.node_id,
                attempt_id=env.attempt_id,
                command_id=env.command_id,
                idempotency_key=env.idempotency_key,
                kind="submit_artifacts",
                payload=envelope,
            )
            raise
        return result

    def _submit_artifacts_tx(
        self, run: Mapping[str, Any], env: MutationEnvelope
    ) -> dict[str, Any]:
        scope = Scope(str(run["company_ref"]), str(run["project_ref"]))
        run_id = str(run["run_id"])
        node_row = self._current_node_row(run_id, env.node_id)
        scope_key = f"artifacts:{run_id}:{node_row['node_id']}"
        payload_hash = hashing.hash_canonical(env.payload)
        replay = self._replay(
            scope=scope,
            scope_key=scope_key,
            idempotency_key=env.idempotency_key,
            payload_hash=payload_hash,
        )
        if replay is not None:
            return replay
        self._check_version(run, env.expected_state_version)
        self._require_claim(run, node_row, attempt_id=env.attempt_id, lease_epoch=env.lease_epoch)
        artifacts = env.payload.get("artifacts") or []
        if isinstance(artifacts, (str, bytes)) or not isinstance(artifacts, Sequence):
            raise errors.bad_request("payload.artifacts must be an array")
        plan = self._plan(run)
        node_plan = self._plan_node(plan, str(node_row["node_id"]))
        allowed_kinds = set(node_plan.produces) | set(self._required_evidence_kinds(plan, node_plan))
        now = self._now()
        registered: list[dict[str, Any]] = []
        for artifact in artifacts:
            if not isinstance(artifact, Mapping):
                raise errors.bad_request("each artifact must be an object")
            digest = artifact.get("contentHash")
            if not is_content_hash(digest):
                raise errors.bad_request(
                    "each artifact needs a well-formed sha256 contentHash; a mutable reference "
                    "cannot be registered as a fixed artifact"
                )
            kind = str(artifact.get("kind", ""))
            if allowed_kinds and kind not in allowed_kinds:
                raise errors.bad_request(
                    f"artifact kind {kind!r} is not one of the output types this node may produce: "
                    + ", ".join(sorted(allowed_kinds))
                )
            source = dict(artifact.get("source") or {})
            provider_ref = (
                dict(artifact["providerRef"]) if artifact.get("providerRef") else None
            )
            existing = self.db.query_one(
                "SELECT * FROM artifacts WHERE company_ref = ? AND project_ref = ? AND run_id = ?"
                " AND node_id = ? AND kind = ? AND content_hash = ?",
                (
                    scope.company_ref,
                    scope.project_ref,
                    run_id,
                    str(node_row["node_id"]),
                    kind,
                    str(digest),
                ),
            )
            if existing is not None:
                artifact_id = str(existing["artifact_id"])
                # Create-or-verify: the same source identity pointing at different bytes is a
                # conflict, not an update. Overwriting would rewrite what a gate already read.
                if source.get("ref") and loads(existing.get("source_json"), {}) == {}:
                    raise errors.idempotency_conflict(
                        f"artifact {source['ref']!r} is already registered; a fixed artifact ref "
                        "cannot be re-pointed at different bytes",
                        artifactId=artifact_id,
                        registeredContentHash=str(existing["content_hash"]),
                        presentedContentHash=str(digest),
                    )
            else:
                artifact_id = ids.new_id("artifact")
                self.db.execute(
                    "INSERT INTO artifacts (artifact_id, company_ref, project_ref, run_id, node_id,"
                    " iteration, kind, content_hash, media_type, size, provider_ref_json, source_json,"
                    " repository_json, immutable, created_at, updated_at)"
                    " VALUES (:artifact_id, :company_ref, :project_ref, :run_id, :node_id, :iteration,"
                    " :kind, :content_hash, :media_type, :size, :provider_ref_json, :source_json,"
                    " :repository_json, 1, :now, :now)",
                    {
                        "artifact_id": artifact_id,
                        "company_ref": scope.company_ref,
                        "project_ref": scope.project_ref,
                        "run_id": run_id,
                        "node_id": str(node_row["node_id"]),
                        "iteration": int(node_row["iteration"]),
                        "kind": kind,
                        "content_hash": str(digest),
                        "media_type": str(artifact.get("mediaType", "application/octet-stream")),
                        "size": int(artifact.get("size", 0) or 0),
                        "provider_ref_json": dumps(provider_ref) if provider_ref else None,
                        "source_json": dumps(source),
                        "repository_json": dumps(dict(artifact["repository"]))
                        if artifact.get("repository")
                        else None,
                        "now": now,
                    },
                )
            registered.append(
                ArtifactRef.from_row(
                    self.db.query_one(
                        "SELECT * FROM artifacts WHERE artifact_id = ?", (artifact_id,)
                    )
                ).to_wire()
            )
            self._emit(
                run_id,
                "pf.evidence.ingested",
                {
                    "artifactId": artifact_id,
                    "nodeId": str(node_row["node_id"]),
                    "kind": kind,
                    "contentHash": str(digest),
                },
                correlation_id=env.correlation_id or None,
            )
        self.db.execute(
            "UPDATE node_executions SET output_refs_json = ?, updated_at = ? WHERE run_id = ?"
            " AND node_id = ? AND iteration = ?",
            (dumps(registered), now, run_id, str(node_row["node_id"]), int(node_row["iteration"])),
        )
        state_version = self._bump(run_id)
        result = CommandResult(
            command_id=env.command_id,
            applied=True,
            state_version=state_version,
            status=str(node_row["status"]),
            result_ref=",".join(str(a["artifactId"]) for a in registered) or None,
            blockers=[],
        ).to_wire()
        self._record_command(
            scope=scope,
            scope_key=scope_key,
            run_id=run_id,
            command_id=env.command_id,
            idempotency_key=env.idempotency_key,
            payload_hash=payload_hash,
            result=result,
        )
        return result

    def submit_evidence(self, envelope: Mapping[str, Any]) -> dict[str, Any]:
        """Ingest and verify evidence candidates. Never advances a node by itself."""
        env = self._envelope(envelope)
        scope = self._resolve_envelope_scope(env.run_id, envelope.get("scope"))
        run = self._load_run(env.run_id, scope=scope, operation="submit evidence")
        try:
            with self.db.transaction():
                result = self._submit_evidence_tx(run, env)
        except errors.PolyForgeError as exc:
            self._record_refusal(
                exc,
                run=run,
                node_id=env.node_id,
                attempt_id=env.attempt_id,
                command_id=env.command_id,
                idempotency_key=env.idempotency_key,
                kind="submit_evidence",
                payload=envelope,
            )
            raise
        return result

    def _submit_evidence_tx(
        self, run: Mapping[str, Any], env: MutationEnvelope
    ) -> dict[str, Any]:
        scope = Scope(str(run["company_ref"]), str(run["project_ref"]))
        run_id = str(run["run_id"])
        node_row = self._current_node_row(run_id, env.node_id)
        scope_key = f"evidence:{run_id}:{node_row['node_id']}"
        payload_hash = hashing.hash_canonical(env.payload)
        replay = self._replay(
            scope=scope,
            scope_key=scope_key,
            idempotency_key=env.idempotency_key,
            payload_hash=payload_hash,
        )
        if replay is not None:
            return replay
        self._check_version(run, env.expected_state_version)
        claim = self._require_claim(
            run, node_row, attempt_id=env.attempt_id, lease_epoch=env.lease_epoch
        )
        attempt = self.db.query_one(
            "SELECT * FROM execution_attempts WHERE attempt_id = ?", (str(claim["attempt_id"]),)
        )
        contract_hash = node_row.get("contract_hash") or self._ensure_contract(run, node_row)
        contract = self._contract_wire(self._load_contract_row(run_id, str(contract_hash)), run)
        node_rows = self._node_rows(run_id)
        revisions = self._current_input_revisions(run, node_row, node_rows)
        index = self.evidence.artifacts_for(
            company_ref=scope.company_ref,
            project_ref=scope.project_ref,
            run_id=run_id,
            node_id=str(node_row["node_id"]),
        )
        producer = str(env.payload.get("producerSubject") or claim.get("agent_subject") or "")
        candidates = env.payload.get("evidence") or []
        if isinstance(candidates, (str, bytes)) or not isinstance(candidates, Sequence):
            raise errors.bad_request("payload.evidence must be an array")
        accepted: list[str] = []
        rejections: list[dict[str, Any]] = []
        for raw in candidates:
            candidate = (
                raw
                if isinstance(raw, EvidenceCandidate)
                else EvidenceCandidate.from_wire(raw, producer_subject=producer)
            )
            outcome = self.evidence.ingest_candidate(
                candidate,
                run=run,
                node=node_row,
                contract=contract,
                claim=claim,
                attempt=attempt,
                current_input_revisions=revisions,
                artifact_index=index,
                freshness_seconds=self.evidence_freshness_seconds,
            )
            if outcome.accepted:
                accepted.append(str(outcome.evidence_id))
            else:
                rejections.append(
                    {
                        "kind": candidate.kind,
                        "failures": [f.to_wire() for f in outcome.failures],
                    }
                )
        if rejections and not accepted:
            first = rejections[0]["failures"][0] if rejections[0]["failures"] else {}
            raise errors.evidence_invalid(
                f"evidence rejected at the {first.get('stage', 'unknown')} stage: "
                f"{first.get('message', 'unverified')}",
                rejections=rejections,
                runId=run_id,
            )
        now = self._now()
        if accepted:
            self._record_node_outputs(run, node_row, accepted)
        state_version = self._bump(run_id)
        result = CommandResult(
            command_id=env.command_id,
            applied=True,
            state_version=state_version,
            status=str(node_row["status"]),
            result_ref=",".join(accepted) or None,
            blockers=[
                Blocker(
                    code="EVIDENCE_REJECTED",
                    reason=str(BlockReason.STALE_INPUT),
                    message=f"evidence {r['kind']!r} was not accepted",
                    detail={"failures": r["failures"]},
                )
                for r in rejections
            ],
        ).to_wire()
        self._record_command(
            scope=scope,
            scope_key=scope_key,
            run_id=run_id,
            command_id=env.command_id,
            idempotency_key=env.idempotency_key,
            payload_hash=payload_hash,
            result=result,
        )
        return result

    def _record_node_outputs(
        self,
        run: Mapping[str, Any],
        node_row: Mapping[str, Any],
        evidence_ids: Sequence[str],
    ) -> str:
        """Refresh a node's output digest and evidence list after new evidence lands."""
        scope = Scope(str(run["company_ref"]), str(run["project_ref"]))
        wanted = set(evidence_ids)
        rows = [
            r
            for r in self.evidence.list_for_node(
                company_ref=scope.company_ref,
                project_ref=scope.project_ref,
                run_id=str(run["run_id"]),
                node_id=str(node_row["node_id"]),
            )
            if not wanted or str(r["evidence_id"]) in wanted
        ]
        digest = self._output_digest(node_row, rows)
        self.db.execute(
            "UPDATE node_executions SET output_digest = ?, output_refs_json = ?, status = ?,"
            " updated_at = ? WHERE run_id = ? AND node_id = ? AND iteration = ?",
            (
                digest,
                dumps(
                    [
                        {"kind": str(r["kind"]), "contentHash": str(r["artifact_digest"])}
                        for r in rows
                    ]
                ),
                NodeStatus.EVIDENCE_READY
                if str(node_row["status"]) in (NodeStatus.RUNNING, NodeStatus.EVIDENCE_READY)
                else str(node_row["status"]),
                self._now(),
                str(run["run_id"]),
                str(node_row["node_id"]),
                int(node_row["iteration"]),
            ),
        )
        for row in rows:
            self.db.execute(
                "UPDATE evidence SET transition_hash = COALESCE(transition_hash, ?), updated_at = ?"
                " WHERE evidence_id = ?",
                (str(node_row.get("contract_hash") or ""), self._now(), str(row["evidence_id"])),
            )
            self._emit(
                str(run["run_id"]),
                "pf.evidence.ingested",
                {
                    "evidenceId": str(row["evidence_id"]),
                    "nodeId": str(node_row["node_id"]),
                    "kind": str(row["kind"]),
                    "artifactDigest": str(row["artifact_digest"]),
                    "producerSubject": str(row["producer_subject"]),
                },
            )
        return digest

    # ------------------------------------------------------------------
    # the transition: the only path that can write PASSED
    # ------------------------------------------------------------------

    def request_transition(self, envelope: Mapping[str, Any]) -> dict[str, Any]:
        """Request evaluation of a node transition, committing a pass when it is earned.

        This is the only method that writes ``PASSED``, and only when every mandatory
        evaluator returns PASS. An issue dragged to ``done``, an ``agent.run.finished``
        observation, and a human confirmation all arrive through other paths and none of them
        can reach this state without the gate.
        """
        env = self._envelope(envelope)
        scope = self._resolve_envelope_scope(env.run_id, envelope.get("scope"))
        run = self._load_run(env.run_id, scope=scope, operation="request transition")
        try:
            with self.db.transaction():
                run = self._load_run_in_scope(env.run_id, scope, operation="request transition")
                return self._evaluate_and_commit(
                    run,
                    env,
                    scope=scope,
                    require_claim=True,
                    cause="request_transition",
                )
        except errors.PolyForgeError as exc:
            self._record_refusal(
                exc,
                run=run,
                node_id=env.node_id,
                attempt_id=env.attempt_id,
                command_id=env.command_id,
                idempotency_key=env.idempotency_key,
                kind="request_transition",
                payload=envelope,
            )
            raise

    def _evaluate_and_commit(
        self,
        run: Mapping[str, Any],
        env: MutationEnvelope,
        *,
        scope: Scope,
        require_claim: bool,
        cause: str,
        command_id: str | None = None,
        idempotency_key: str | None = None,
        payload_hash: str | None = None,
        record_command: bool = True,
    ) -> dict[str, Any]:
        run_id = str(run["run_id"])
        node_row = self._current_node_row(run_id, env.node_id)
        node_id = str(node_row["node_id"])
        scope_key = f"transition:{run_id}:{node_id}"
        command_id = command_id or env.command_id
        idempotency_key = idempotency_key or env.idempotency_key
        payload_hash = payload_hash or hashing.hash_canonical(env.payload)
        replay = self._replay(
            scope=scope,
            scope_key=scope_key,
            idempotency_key=idempotency_key,
            payload_hash=payload_hash,
        )
        if replay is not None:
            return replay
        self._check_version(run, env.expected_state_version)
        if str(run["status"]) in (GraphRunStatus.CANCELLED,):
            raise errors.run_blocked(
                "run is CANCELLED; a cancelled run cannot commit a transition",
                runId=run_id,
            )
        claim: Mapping[str, Any] | None = None
        if require_claim:
            claim = self._require_claim(
                run, node_row, attempt_id=env.attempt_id, lease_epoch=env.lease_epoch
            )
        contract_hash = node_row.get("contract_hash") or self._ensure_contract(run, node_row)
        if env.contract_hash and str(env.contract_hash) != str(contract_hash):
            raise errors.contract_invalid(
                f"transition presents contract {env.contract_hash} but node {node_id!r} is bound to "
                f"{contract_hash}; a transition may only be committed against its own contract",
                nodeId=node_id,
                runId=run_id,
            )
        contract = self._contract_wire(self._load_contract_row(run_id, str(contract_hash)), run)
        plan = self._plan(run)
        node_plan = self._plan_node(plan, node_id)

        evidence_rows, evidence_failure = self._select_evidence(
            scope, run, node_row, env.payload.get("evidenceIds") or []
        )
        if evidence_failure is not None:
            raise evidence_failure
        set_hash = self.evidence.set_hash(evidence_rows)

        target_hash = self._decision_target(
            run, node_row, contract, node_plan, evidence_rows
        )
        resolution = self._latest_resolution(run_id, node_id)
        context = self._evaluation_context(
            run=run,
            scope=scope,
            node_row=node_row,
            node_plan=node_plan,
            contract=contract,
            evidence_rows=evidence_rows,
            set_hash=set_hash,
            target_hash=target_hash,
            resolution=resolution,
            claim=claim,
            reviewer_subject=str(env.payload.get("reviewerSubject") or ""),
            platform_grants=(
                PlatformGrants.from_wire(env.payload["platformGrants"])
                if env.payload.get("platformGrants")
                else None
            ),
            authorization=env.payload.get("authorizationRef"),
        )
        required = [str(e["ref"]) for e in contract["requiredEvaluators"]]
        versions = {str(e["ref"]): str(e.get("version", "")) for e in contract["requiredEvaluators"]}
        results = self.evaluators.evaluate_all(required, context, versions=versions)
        present_kinds = [
            kind
            for kind in (str(k) for k in contract["requiredEvidenceKinds"])
            if any(str(r["kind"]) == kind and bool(r["valid"]) for r in evidence_rows)
        ]
        self.db.execute(
            "UPDATE node_executions SET status = ?, updated_at = ? WHERE run_id = ? AND node_id = ?"
            " AND iteration = ?",
            (NodeStatus.EVALUATING, self._now(), run_id, node_id, int(node_row["iteration"])),
        )
        node_row = self._node_row(run_id, node_id)
        aggregated = aggregate_gate(
            results,
            join=node_plan.join_semantics,
            mandatory=True,
            gate_id=node_id,
            required_evaluators=required,
            required_evidence_kinds=[str(k) for k in contract["requiredEvidenceKinds"]],
            present_evidence_kinds=present_kinds,
            evidence_set_hash=set_hash,
        )
        self._persist_evaluations(
            run, node_row, contract, aggregated, results, required
        )
        self._emit(
            run_id,
            "pf.gate.evaluated",
            {
                "nodeId": node_id,
                "gateId": node_id,
                "transitionHash": str(contract_hash),
                "evidenceSetHash": set_hash,
                "result": str(aggregated.result),
                "reason": aggregated.reason,
                "evaluators": {r.evaluator_ref: r.result for r in results},
                "cause": cause,
            },
        )

        if aggregated.result == GateResult.PASS:
            outcome = self._commit_pass(
                run=run,
                scope=scope,
                node_row=node_row,
                node_plan=node_plan,
                contract=contract,
                evidence_rows=evidence_rows,
                set_hash=set_hash,
                target_hash=target_hash,
                claim=claim,
                context=context,
                aggregated=aggregated,
            )
        elif aggregated.result == GateResult.FAIL:
            outcome = self._commit_rework(
                run=run,
                scope=scope,
                node_row=node_row,
                node_plan=node_plan,
                contract=contract,
                aggregated=aggregated,
                set_hash=set_hash,
                claim=claim,
            )
        elif self._needs_human(results, required):
            outcome = self._commit_waiting(
                run=run,
                scope=scope,
                node_row=node_row,
                node_plan=node_plan,
                contract=contract,
                aggregated=aggregated,
                set_hash=set_hash,
                target_hash=target_hash,
                claim=claim,
            )
        else:
            outcome = self._commit_evaluating(
                run=run,
                scope=scope,
                node_row=node_row,
                aggregated=aggregated,
                claim=claim,
            )

        outcome["stateVersion"] = self._bump(run_id)
        self._checkpoint(
            self._load_run_in_scope(run_id, scope, operation=cause),
            node_id=node_id,
            attempt_id=str(claim["attempt_id"]) if claim else None,
            contract_hash=str(contract_hash),
            state_version=int(outcome["stateVersion"]),
        )
        self._record_command(
            scope=scope,
            scope_key=scope_key,
            run_id=run_id,
            command_id=command_id,
            idempotency_key=idempotency_key,
            payload_hash=payload_hash,
            result=outcome,
        ) if record_command else None
        self._apply_plan(
            self._load_run_in_scope(run_id, scope, operation=cause),
            scope=scope,
            correlation_id=env.correlation_id or None,
            cause=cause,
        )
        return outcome

    def _select_evidence(
        self,
        scope: Scope,
        run: Mapping[str, Any],
        node_row: Mapping[str, Any],
        evidence_ids: Sequence[str],
    ) -> tuple[list[dict[str, Any]], errors.PolyForgeError | None]:
        """Load the evidence a transition claims, refusing anything unverifiable."""
        run_id = str(run["run_id"])
        if evidence_ids:
            rows: list[dict[str, Any]] = []
            for evidence_id in (str(e) for e in evidence_ids):
                row = self.evidence.get(
                    company_ref=scope.company_ref,
                    project_ref=scope.project_ref,
                    evidence_id=evidence_id,
                )
                if row is None or str(row["run_id"]) != run_id:
                    return [], errors.evidence_invalid(
                        f"evidence {evidence_id!r} does not exist in this run",
                        evidenceId=evidence_id,
                        runId=run_id,
                    )
                rows.append(row)
        else:
            rows = self.evidence.list_for_node(
                company_ref=scope.company_ref,
                project_ref=scope.project_ref,
                run_id=run_id,
                node_id=str(node_row["node_id"]),
            )
        for row in rows:
            if str(row["node_id"]) != str(node_row["node_id"]):
                return [], errors.evidence_invalid(
                    f"evidence {row['evidence_id']!r} belongs to node {row['node_id']!r}, not "
                    f"{node_row['node_id']!r}",
                    evidenceId=str(row["evidence_id"]),
                )
            if not bool(row["valid"]):
                return [], errors.evidence_invalid(
                    f"evidence {row['evidence_id']!r} was invalidated"
                    f" ({row.get('invalidated_reason') or 'no reason recorded'}) and cannot be gated on",
                    evidenceId=str(row["evidence_id"]),
                    invalidatedReason=row.get("invalidated_reason"),
                )
        return rows, None

    def _decision_target(
        self,
        run: Mapping[str, Any],
        node_row: Mapping[str, Any],
        contract: Mapping[str, Any],
        node_plan: PlanNode,
        evidence_rows: Sequence[Mapping[str, Any]],
    ) -> str:
        """Bind the exact thing a human would be deciding about right now."""
        outputs: dict[str, str] = {}
        for row in evidence_rows:
            for artifact in loads(row.get("artifacts_json"), []) or []:
                outputs[f"{row.get('kind', '')}:{artifact.get('artifactId', '')}"] = str(
                    artifact.get("contentHash", "")
                )
        for produced in node_plan.produces:
            outputs[produced] = str(node_row.get("output_digest") or "")
        gate_id = str(node_row["node_id"])
        semantic_kind = str((node_plan.human_decision or {}).get("semanticKind") or gate_id)
        return decision_target_hash(
            gate_id=gate_id,
            semantic_kind=semantic_kind,
            transition_hash=str(contract["contractHash"]),
            input_digests=contract["inputs"],
            output_digests=outputs,
            policy_hash=str((contract.get("effectivePolicy") or {}).get("hash", "")),
            evaluator_versions={
                str(e["ref"]): str(e.get("version", "")) for e in contract["requiredEvaluators"]
            },
            options=list((node_plan.human_decision or {}).get("options") or ()),
            authority=contract.get("authority"),
            environment=contract.get("environment"),
        )

    def _latest_resolution(self, run_id: str, node_id: str) -> dict[str, Any] | None:
        """The most recent recorded resolution for this node, whatever its target.

        Returning a stale one is deliberate: the human decision evaluator then says "that
        answer was about something else" instead of reporting the gate as merely pending.
        """
        row = self.db.query_one(
            "SELECT resolution_json FROM governance_bindings WHERE run_id = ? AND node_id = ?"
            " AND state = 'RESOLVED' AND resolution_json IS NOT NULL"
            " ORDER BY resolved_at DESC, request_id DESC LIMIT 1",
            (str(run_id), str(node_id)),
        )
        if row is None:
            return None
        return loads(row["resolution_json"], None)

    def _upstream_producer_subjects(
        self,
        run_id: str,
        plan: ExecutionPlan,
        node_id: str,
        scope: Scope,
    ) -> set[str]:
        """Trusted subjects that authored any normal-dependency ancestor of ``node_id``.

        ``independentFrom`` is enforced against persisted assignments and evidence provenance,
        never against a caller-supplied author field.  All ancestors are included because join
        nodes deliberately carry the lineage of their contributing branches.
        """
        upstream = set(plan.ancestors(node_id))
        subjects: set[str] = set()
        for row in self._node_rows(run_id):
            upstream_node_id = str(row["node_id"])
            if upstream_node_id not in upstream:
                continue
            assigned = str(row.get("assigned_subject") or "")
            if assigned:
                subjects.add(assigned)
            for evidence in self.evidence.list_for_node(
                company_ref=scope.company_ref,
                project_ref=scope.project_ref,
                run_id=run_id,
                node_id=upstream_node_id,
            ):
                producer = str(evidence.get("producer_subject") or "")
                if producer:
                    subjects.add(producer)
        return subjects

    def _evaluation_context(
        self,
        *,
        run: Mapping[str, Any],
        scope: Scope,
        node_row: Mapping[str, Any],
        node_plan: PlanNode,
        contract: Mapping[str, Any],
        evidence_rows: Sequence[Mapping[str, Any]],
        set_hash: str,
        target_hash: str,
        resolution: Mapping[str, Any] | None,
        claim: Mapping[str, Any] | None,
        reviewer_subject: str = "",
        platform_grants: PlatformGrants | None = None,
        authorization: Mapping[str, Any] | None = None,
    ) -> EvaluationContext:
        """Build the read-only snapshot an evaluator may look at.

        No engine, no database handle: an evaluator that could write would be able to pass
        itself.
        """
        run_id = str(run["run_id"])
        node_id = str(node_row["node_id"])
        plan = self._plan(run)
        node_rows = self._node_rows(run_id)
        upstream = set(plan.ancestors(node_id))
        producers = self._upstream_producer_subjects(run_id, plan, node_id, scope)
        creator_row = self.db.query_one(
            "SELECT interaction_creator FROM governance_bindings WHERE run_id = ? AND node_id = ?"
            " ORDER BY created_at DESC LIMIT 1",
            (run_id, node_id),
        )
        interaction_creator = (
            str(creator_row["interaction_creator"]) if creator_row is not None else None
        )
        subject = reviewer_subject or (str(claim["agent_subject"]) if claim else "")
        return EvaluationContext(
            run={k: run[k] for k in ("run_id", "graph_id", "graph_version", "entrypoint", "status")},
            node=dict(node_row),
            node_plan=node_plan.to_canonical(),
            contract=contract,
            policy=EffectivePolicy.from_wire(contract.get("effectivePolicy") or {}),
            evidence=tuple(
                EvidenceRecord.from_row(r).to_wire() for r in evidence_rows
            ),
            invalid_evidence=tuple(
                EvidenceRecord.from_row(r).to_wire()
                for r in self.evidence.list_for_node(
                    company_ref=scope.company_ref,
                    project_ref=scope.project_ref,
                    run_id=run_id,
                    node_id=node_id,
                )
                if not bool(r["valid"])
            ),
            # Valid evidence from the immutable normal-dependency lineage. A deterministic join
            # carries no evidence of its own, so limiting this to the direct predecessor would hide
            # the QA, security and regression reports the join exists to collect.
            upstream_evidence=tuple(
                EvidenceRecord.from_row(r).to_wire()
                for predecessor in sorted(upstream)
                for r in self.evidence.list_for_node(
                    company_ref=scope.company_ref,
                    project_ref=scope.project_ref,
                    run_id=run_id,
                    node_id=predecessor,
                )
                if bool(r["valid"])
            ),
            resolution=resolution,
            decision_target_hash=target_hash,
            reviewer_subject=subject or None,
            interaction_creator=interaction_creator,
            producer_subjects=tuple(sorted(producers)),
            capability_holders=self._capability_holders(scope),
            required_capabilities=tuple(node_plan.required_capabilities),
            platform_grants=platform_grants,
            authorization=authorization,
            current_input_revisions=self._current_input_revisions(run, node_row, node_rows),
            evidence_set_hash=set_hash,
            now=self._now(),
        )

    def _persist_evaluations(
        self,
        run: Mapping[str, Any],
        node_row: Mapping[str, Any],
        contract: Mapping[str, Any],
        aggregated: Any,
        results: Sequence[Any],
        required: Sequence[str],
    ) -> None:
        """Record every evaluator verdict, including the failures.

        A FAIL that is later fixed must not erase the record that it once failed, so
        re-evaluating appends a numbered row rather than overwriting.
        """
        scope = Scope(str(run["company_ref"]), str(run["project_ref"]))
        run_id = str(run["run_id"])
        now = self._now()
        for result in results:
            counter = self.db.query_one(
                "SELECT COALESCE(MAX(evaluation_no), 0) AS n FROM gate_evaluations"
                " WHERE company_ref = ? AND project_ref = ? AND run_id = ? AND gate_id = ?"
                " AND evaluator_ref = ?",
                (scope.company_ref, scope.project_ref, run_id, str(node_row["node_id"]), result.evaluator_ref),
            )
            self.db.execute(
                "INSERT INTO gate_evaluations (evaluation_id, company_ref, project_ref, run_id,"
                " node_id, gate_id, evaluator_ref, evaluator_kind, evaluator_version, transition_hash,"
                " evidence_set_hash, evaluation_no, result, reason, mandatory, diagnostics_json,"
                " created_at, updated_at)"
                " VALUES (:evaluation_id, :company_ref, :project_ref, :run_id, :node_id, :gate_id,"
                " :evaluator_ref, :evaluator_kind, :evaluator_version, :transition_hash,"
                " :evidence_set_hash, :evaluation_no, :result, :reason, :mandatory, :diagnostics_json,"
                " :now, :now)",
                {
                    "evaluation_id": ids.new_id("evaluation"),
                    "company_ref": scope.company_ref,
                    "project_ref": scope.project_ref,
                    "run_id": run_id,
                    "node_id": str(node_row["node_id"]),
                    "gate_id": str(aggregated.gate_id),
                    "evaluator_ref": result.evaluator_ref,
                    "evaluator_kind": result.evaluator_kind,
                    "evaluator_version": result.evaluator_version,
                    "transition_hash": str(contract["contractHash"]),
                    "evidence_set_hash": str(aggregated.evidence_set_hash),
                    "evaluation_no": (int(counter["n"]) if counter else 0) + 1,
                    "result": str(result.result),
                    "reason": result.reason,
                    "mandatory": 1 if result.mandatory else 0,
                    "diagnostics_json": dumps(list(result.diagnostics)),
                    "now": now,
                },
            )

    @staticmethod
    def _needs_human(results: Sequence[Any], required: Sequence[str]) -> bool:
        """Whether the *only* thing missing is a human decision.

        A missing evaluator or missing evidence is ``ESCALATE`` but is not a reason to bother a
        human: asking someone to approve work whose evidence has not arrived would push the
        Core's own gap onto a person. A governance request is opened only when every other
        evaluator already passed, so the human is deciding about a complete target.
        """
        if "human_decision" not in required:
            return False
        human_result: str | None = None
        for result in results:
            if result.evaluator_ref == "human_decision":
                human_result = str(result.result)
                continue
            if str(result.result) != GateResult.PASS:
                return False
        return human_result == GateResult.ESCALATE

    def _commit_pass(
        self,
        *,
        run: Mapping[str, Any],
        scope: Scope,
        node_row: Mapping[str, Any],
        node_plan: PlanNode,
        contract: Mapping[str, Any],
        evidence_rows: Sequence[Mapping[str, Any]],
        set_hash: str,
        target_hash: str,
        claim: Mapping[str, Any] | None,
        context: EvaluationContext,
        aggregated: Any,
    ) -> dict[str, Any]:
        """Write the pass, after re-checking everything the gate could not.

        The gate is not the last word. Inputs can have moved, an authorization can have been
        revoked, and an approval can have been answered about a different target — all of
        which are checked here, inside the same transaction, before ``PASSED`` exists.
        """
        run_id = str(run["run_id"])
        node_id = str(node_row["node_id"])
        now = self._now()
        blockers: list[Blocker] = []

        node_rows = self._node_rows(run_id)
        current_inputs = self._current_input_revisions(run, node_row, node_rows)
        contract_inputs = {str(k): str(v) for k, v in (contract.get("inputs") or {}).items()}
        stale = {
            name: {"pinned": value, "current": current_inputs.get(name, "")}
            for name, value in sorted(contract_inputs.items())
            if current_inputs.get(name, "") != value
        }
        if stale:
            # Stale input is never inherited. A pass on superseded inputs would be a fact
            # about a state that no longer exists.
            blockers.append(
                Blocker(
                    code="STALE_INPUT",
                    reason=str(BlockReason.STALE_INPUT),
                    message=(
                        "the contract was pinned against input revisions that have since changed; "
                        "a new contract and new evidence are required"
                    ),
                    detail=stale,
                )
            )

        policy = EffectivePolicy.from_wire(contract.get("effectivePolicy") or {})
        if policy.requires_fresh_authorization_before_commit:
            rechecked = self._resolve_policy(
                run,
                action=str((contract.get("authority") or {}).get("action", "")),
                resource=str((contract.get("authority") or {}).get("resource", "")),
                environment=str((contract.get("environment") or {}).get("environment", "production")),
                transition_ref=f"{contract.get('graphId', '')}.{node_id}",
                grants=context.platform_grants,
                phase="before_commit",
            )
            if rechecked.is_denied or context.platform_grants is None:
                blockers.append(
                    Blocker(
                        code="AUTHORIZATION_STALE",
                        reason=str(BlockReason.AUTHORIZATION),
                        message=(
                            rechecked.reason
                            if context.platform_grants is not None
                            else (
                                "the policy requires a fresh platform authorization check before "
                                "commit and no verified result was supplied; an approval is a moment, "
                                "not a possession"
                            )
                        ),
                        detail={
                            "phase": "before_commit",
                            "requiredAuthority": policy.requested_authority,
                        },
                    )
                )
            else:
                # The supplied authorization is re-checked against the *exact* action, so a
                # broader live approval cannot be borrowed for this transition.
                stale = self._verify_authorization_exactly(context, contract, policy)
                if stale is not None:
                    blockers.append(stale)
        if node_plan.permission_gate:
            authorization = context.platform_grants
            if authorization is None or authorization.revoked or authorization.expired:
                blockers.append(
                    Blocker(
                        code="PERMISSION_GATE_UNVERIFIED",
                        reason=str(BlockReason.AUTHORIZATION),
                        message=(
                            "this node declares a permission gate for "
                            f"{node_plan.permission_gate.get('action')!r} and no unexpired, unrevoked "
                            "platform authorization was verified before commit"
                        ),
                        detail={"permissionGate": dict(node_plan.permission_gate)},
                    )
                )

        if blockers:
            # A blocked pass is a recorded outcome, not a silent no: the run carries the
            # reason and an operator can resolve it.
            self.db.execute(
                "UPDATE node_executions SET status = ?, block_reason = ?, wait_reason = ?,"
                " updated_at = ? WHERE run_id = ? AND node_id = ? AND iteration = ?",
                (
                    NodeStatus.BLOCKED,
                    str(BlockReason.STALE_INPUT)
                    if any(b.code == "STALE_INPUT" for b in blockers)
                    else str(BlockReason.AUTHORIZATION),
                    blockers[0].message,
                    now,
                    run_id,
                    node_id,
                    int(node_row["iteration"]),
                ),
            )
            self._emit(
                run_id,
                "pf.transition.rejected",
                {
                    "nodeId": node_id,
                    "transitionHash": str(contract["contractHash"]),
                    "reason": "pre-commit re-check failed",
                    "blockers": [b.to_wire() for b in blockers],
                },
            )
            return CommandResult(
                command_id="",
                applied=False,
                state_version=0,
                status=str(NodeStatus.BLOCKED),
                blockers=blockers,
                result_ref=None,
            ).to_wire()

        digest = self._record_node_outputs(run, node_row, [str(r["evidence_id"]) for r in evidence_rows])
        self.db.execute(
            "UPDATE node_executions SET status = ?, output_digest = ?, active_attempt_id = NULL,"
            " wait_reason = NULL, block_reason = NULL, updated_at = ?"
            " WHERE run_id = ? AND node_id = ? AND iteration = ?",
            (NodeStatus.PASSED, digest, now, run_id, node_id, int(node_row["iteration"])),
        )
        if claim is not None:
            self.db.execute(
                "UPDATE execution_attempts SET status = ?, lease_state = 'RELEASED', finished_at = ?,"
                " updated_at = ? WHERE attempt_id = ?",
                (AttemptStatus.COMPLETED, now, now, str(claim["attempt_id"])),
            )
        self._emit(
            run_id,
            "pf.transition.committed",
            {
                "nodeId": node_id,
                "iteration": int(node_row["iteration"]),
                "transitionHash": str(contract["contractHash"]),
                "evidenceSetHash": set_hash,
                "decisionTargetHash": target_hash,
                "outputDigest": digest,
                "attemptId": str(claim["attempt_id"]) if claim else None,
            },
        )
        self._outbox(
            run=run,
            kind="status.project",
            node_id=node_id,
            correlation_key=f"status:{run_id}:{node_id}:{node_row['iteration']}:{digest}",
            payload={
                "runId": run_id,
                "nodeId": node_id,
                "iteration": int(node_row["iteration"]),
                "status": str(NodeStatus.PASSED),
                "summary": f"{node_id} passed transition {contract['contractHash']}",
                "stateVersion": int(run["state_version"]) + 1,
                "origin": "polyforge",
            },
        )
        self._maybe_complete_run(run, node_id)
        return CommandResult(
            command_id="",
            applied=True,
            state_version=0,
            status=str(NodeStatus.PASSED),
            result_ref=str(contract["contractHash"]),
            blockers=[],
        ).to_wire()

    def _verify_authorization_exactly(
        self,
        context: EvaluationContext,
        contract: Mapping[str, Any],
        policy: EffectivePolicy,
    ) -> Blocker | None:
        """Ask the governance port whether the live authorization covers *this* action.

        A live approval for a neighbouring action is not an approval here, which is why
        ``exactMatch`` is required rather than merely ``granted``. With no ports configured the
        answer is a blocker, never a silent pass: a missing bridge may not read as consent.
        """
        authorization_ref = context.authorization
        if self.ports is None:
            return Blocker(
                code="AUTHORIZATION_UNVERIFIABLE",
                reason=str(BlockReason.AUTHORIZATION),
                message=(
                    "this transition needs a platform authorization check and no governance port is "
                    "configured, so the check cannot be performed; refusing is the only safe answer"
                ),
                detail={"policyRule": policy.rule_id},
            )
        if not isinstance(authorization_ref, Mapping) or not authorization_ref.get("id"):
            return Blocker(
                code="AUTHORIZATION_MISSING",
                reason=str(BlockReason.AUTHORIZATION),
                message=(
                    "the policy requires an exact-action authorization and none was referenced on "
                    "this command"
                ),
                detail={"policyRule": policy.rule_id},
            )
        from polyforge.core.ports.base import ExactAction

        status = self.ports.governance.check_authorization(
            dict(authorization_ref),
            ExactAction(
                action=str((contract.get("authority") or {}).get("action", "")),
                resource=str((contract.get("authority") or {}).get("resource", "")),
                environment=str((contract.get("environment") or {}).get("environment", "")),
                input_hashes=dict(contract.get("inputs") or {}),
                transition_hash=str(contract.get("contractHash", "")),
            ),
        )
        expires_at = status.expires_at
        expired = bool(status.expires_at) and str(status.expires_at) <= self._now()
        if status.granted and status.exact_match and not status.revoked and not expired:
            return None
        return Blocker(
            code="AUTHORIZATION_NOT_EXACT",
            reason=str(BlockReason.AUTHORIZATION),
            message=(
                f"the platform authorization does not cover this exact action: {status.reason or 'no reason given'}"
            ),
            detail={
                "granted": status.granted,
                "exactMatch": status.exact_match,
                "revoked": status.revoked,
                "expired": expired,
                "expiresAt": expires_at,
            },
        )

    def _maybe_complete_run(self, run: Mapping[str, Any], node_id: str) -> None:
        """Complete the run only when every planned node is terminal, not merely this one."""
        run_id = str(run["run_id"])
        plan = self._plan(run)
        rows = {str(r["node_id"]): str(r["status"]) for r in self._node_rows(run_id)}
        outstanding = [
            n
            for n in plan.ordered_node_ids()
            if rows.get(n) not in (NodeStatus.PASSED, NodeStatus.SKIPPED)
        ]
        if outstanding:
            return
        self.db.execute(
            "UPDATE graph_runs SET status = ?, block_reason = NULL, block_detail_json = NULL"
            " WHERE run_id = ?",
            (str(GraphRunStatus.COMPLETED), run_id),
        )
        self._emit(
            run_id,
            "pf.run.completed",
            {
                "entrypoint": str(run["entrypoint"]),
                "graphId": str(run["graph_id"]),
                "graphVersion": int(run["graph_version"]),
                "lastNode": node_id,
            },
        )

    def _commit_rework(
        self,
        *,
        run: Mapping[str, Any],
        scope: Scope,
        node_row: Mapping[str, Any],
        node_plan: PlanNode,
        contract: Mapping[str, Any],
        aggregated: Any,
        set_hash: str,
        claim: Mapping[str, Any] | None,
    ) -> dict[str, Any]:
        """A FAIL is rework until the engineering ceiling, then it stops and explains."""
        run_id = str(run["run_id"])
        node_id = str(node_row["node_id"])
        now = self._now()
        rework = int(node_row.get("rework_count", 0) or 0)
        ceiling = int(node_row.get("max_rework", self.default_max_rework) or self.default_max_rework)
        exhausted = rework >= ceiling
        status = NodeStatus.BLOCKED if exhausted else NodeStatus.REWORK_REQUIRED
        blockers = [
            Blocker(
                code="GATE_FAILED",
                reason=str(BlockReason.DEPENDENCY) if not exhausted else str(BlockReason.BUDGET),
                message=aggregated.reason,
                detail={
                    "nodeId": node_id,
                    "evidenceSetHash": set_hash,
                    "diagnostics": list(aggregated.diagnostics),
                },
            )
        ]
        if exhausted:
            blockers.append(
                Blocker(
                    code="REWORK_CEILING_EXCEEDED",
                    reason=str(BlockReason.BUDGET),
                    message=(
                        f"the engineering rework ceiling for {node_id!r} is reached ({rework}/{ceiling}); "
                        "a retry budget is a stop, and it is not raised by retrying harder"
                    ),
                    detail={"nodeId": node_id, "reworkCount": rework, "maxRework": ceiling},
                )
            )
        self.db.execute(
            "UPDATE node_executions SET status = ?, rework_count = ?, active_attempt_id = NULL,"
            " wait_reason = ?, block_reason = ?, updated_at = ?"
            " WHERE run_id = ? AND node_id = ? AND iteration = ?",
            (
                status,
                rework + 1 if not exhausted else rework,
                aggregated.reason,
                None if not exhausted else str(BlockReason.BUDGET),
                now,
                run_id,
                node_id,
                int(node_row["iteration"]),
            ),
        )
        if claim is not None:
            self.db.execute(
                "UPDATE execution_attempts SET status = ?, lease_state = 'RELEASED', finished_at = ?,"
                " updated_at = ? WHERE attempt_id = ?",
                (AttemptStatus.FAILED, now, now, str(claim["attempt_id"])),
            )
        self._emit(
            run_id,
            "pf.transition.rejected",
            {
                "nodeId": node_id,
                "transitionHash": str(contract["contractHash"]),
                "evidenceSetHash": set_hash,
                "result": str(GateResult.FAIL),
                "reason": aggregated.reason,
                "reworkCount": rework,
                "maxRework": ceiling,
            },
        )
        self._outbox(
            run=run,
            kind="status.project",
            node_id=node_id,
            correlation_key=f"status:{run_id}:{node_id}:{node_row['iteration']}:fail:{set_hash}",
            payload={
                "runId": run_id,
                "nodeId": node_id,
                "iteration": int(node_row["iteration"]),
                "status": str(status),
                "summary": aggregated.reason,
                "stateVersion": int(run["state_version"]) + 1,
                "origin": "polyforge",
            },
        )
        return CommandResult(
            command_id="",
            applied=False,
            state_version=0,
            status=str(status),
            blockers=blockers,
        ).to_wire()

    def _commit_waiting(
        self,
        *,
        run: Mapping[str, Any],
        scope: Scope,
        node_row: Mapping[str, Any],
        node_plan: PlanNode,
        contract: Mapping[str, Any],
        aggregated: Any,
        set_hash: str,
        target_hash: str,
        claim: Mapping[str, Any] | None,
    ) -> dict[str, Any]:
        """Park the node on a human decision, release the worker, and go home.

        Nothing is held open: the worker is released, the intent is durable, and the tool call
        returns. A human may answer hours later; the same target hash still decides.
        """
        run_id = str(run["run_id"])
        node_id = str(node_row["node_id"])
        semantic_kind = str((node_plan.human_decision or {}).get("semanticKind") or node_id)
        now = self._now()
        existing = self.db.query_one(
            "SELECT * FROM governance_bindings WHERE run_id = ? AND semantic_kind = ?"
            " AND decision_target_hash = ?",
            (run_id, semantic_kind, target_hash),
        )
        if existing is None:
            request_id = ids.new_id("decision")
            expires_in = (node_plan.human_decision or {}).get("expiresInSeconds")
            self.db.execute(
                "INSERT INTO governance_bindings (binding_id, company_ref, project_ref, run_id,"
                " node_id, iteration, request_id, kind, gate_id, semantic_kind,"
                " decision_target_hash, transition_hash, evidence_set_hash, policy_version,"
                " evaluator_versions_json, required_responder, interaction_creator, authority_json,"
                " environment_json, question, options_json, provider_ref_json, state, expires_at,"
                " resolved_at, resolution_json, created_at, updated_at)"
                " VALUES (:binding_id, :company_ref, :project_ref, :run_id, :node_id, :iteration,"
                " :request_id, 'interaction', :gate_id, :semantic_kind, :decision_target_hash,"
                " :transition_hash, :evidence_set_hash, :policy_version, :evaluator_versions_json,"
                " :required_responder, :interaction_creator, :authority_json, :environment_json,"
                " :question, :options_json, NULL, 'PENDING', :expires_at, NULL, NULL, :now, :now)",
                {
                    "binding_id": ids.new_id("binding"),
                    "company_ref": scope.company_ref,
                    "project_ref": scope.project_ref,
                    "run_id": run_id,
                    "node_id": node_id,
                    "iteration": int(node_row["iteration"]),
                    "request_id": request_id,
                    "gate_id": node_id,
                    "semantic_kind": semantic_kind,
                    "decision_target_hash": target_hash,
                    "transition_hash": str(contract["contractHash"]),
                    "evidence_set_hash": set_hash,
                    "policy_version": str(
                        (contract.get("effectivePolicy") or {}).get("version", "")
                    ),
                    "evaluator_versions_json": dumps(
                        {str(e["ref"]): str(e.get("version", "")) for e in contract["requiredEvaluators"]}
                    ),
                    "required_responder": str(
                        (node_plan.human_decision or {}).get("requiredResolver", "human_only")
                    ),
                    "interaction_creator": str(node_row.get("assigned_subject") or "") or None,
                    "authority_json": dumps(dict(contract.get("authority") or {})),
                    "environment_json": dumps(dict(contract.get("environment") or {})),
                    "question": str(
                        (node_plan.human_decision or {}).get("question")
                        or f"Decide {semantic_kind} for node {node_id} of run {run_id}"
                    ),
                    "options_json": dumps(
                        list((node_plan.human_decision or {}).get("options") or ())
                    ),
                    "expires_at": self._later(float(expires_in)) if expires_in else None,
                    "now": now,
                },
            )
        else:
            request_id = str(existing["request_id"])
        self._release_worker(node_row, reason=aggregated.reason)
        self.db.execute(
            "UPDATE node_executions SET status = ?, wait_reason = ?, updated_at = ?"
            " WHERE run_id = ? AND node_id = ? AND iteration = ?",
            (NodeStatus.WAITING_GOVERNANCE, aggregated.reason, now, run_id, node_id, int(node_row["iteration"])),
        )
        self._outbox(
            run=run,
            kind="governance.request",
            node_id=node_id,
            correlation_key=f"governance:{run_id}:{node_id}:{target_hash}",
            payload={
                "runId": run_id,
                "nodeId": node_id,
                "requestId": request_id,
                "semanticKind": semantic_kind,
                "kind": "interaction",
                "question": str((node_plan.human_decision or {}).get("question") or semantic_kind),
                "decisionTargetHash": target_hash,
                "transitionHash": str(contract["contractHash"]),
                "evidenceSetHash": set_hash,
                "requiredResolver": str(
                    (node_plan.human_decision or {}).get("requiredResolver", "human_only")
                ),
                "options": list((node_plan.human_decision or {}).get("options") or ()),
                "rootIssueRef": loads(run.get("root_issue_ref_json"), None),
            },
        )
        self._emit(
            run_id,
            "pf.gate.waiting",
            {
                "nodeId": node_id,
                "gateId": node_id,
                "transitionHash": str(contract["contractHash"]),
                "decisionTargetHash": target_hash,
                "reason": aggregated.reason,
            },
        )
        self._emit(
            run_id,
            "pf.governance.requested",
            {
                "requestId": request_id,
                "nodeId": node_id,
                "semanticKind": semantic_kind,
                "decisionTargetHash": target_hash,
                "workerReleased": True,
            },
        )
        self.db.execute(
            "UPDATE graph_runs SET status = ? WHERE run_id = ? AND status IN ('ACTIVE','CREATED')",
            (str(GraphRunStatus.WAITING), run_id),
        )
        return CommandResult(
            command_id="",
            applied=True,
            state_version=0,
            status=str(NodeStatus.WAITING_GOVERNANCE),
            result_ref=request_id,
            blockers=[],
            pending=True,
            pending_reason="awaiting_verified_human_decision",
        ).to_wire()

    def _commit_evaluating(
        self,
        *,
        run: Mapping[str, Any],
        scope: Scope,
        node_row: Mapping[str, Any],
        aggregated: Any,
        claim: Mapping[str, Any] | None,
    ) -> dict[str, Any]:
        """An escalation that is not a human ask: hold the node and report what is missing."""
        run_id = str(run["run_id"])
        node_id = str(node_row["node_id"])
        now = self._now()
        blockers = [
            Blocker(
                code="GATE_ESCALATED",
                reason=str(BlockReason.DEPENDENCY),
                message=aggregated.reason,
                detail={
                    "nodeId": node_id,
                    "missingEvaluators": list(aggregated.missing_evaluators),
                    "missingEvidenceKinds": list(aggregated.missing_evidence_kinds),
                    "diagnostics": list(aggregated.diagnostics),
                },
            )
        ]
        self.db.execute(
            "UPDATE node_executions SET status = ?, wait_reason = ?, updated_at = ?"
            " WHERE run_id = ? AND node_id = ? AND iteration = ?",
            (NodeStatus.EVALUATING, aggregated.reason, now, run_id, node_id, int(node_row["iteration"])),
        )
        return CommandResult(
            command_id="",
            applied=False,
            state_version=0,
            status=str(NodeStatus.EVALUATING),
            blockers=blockers,
        ).to_wire()

    # ------------------------------------------------------------------
    # help and run commands
    # ------------------------------------------------------------------

    def request_help(self, envelope: Mapping[str, Any]) -> dict[str, Any]:
        """Record a durable clarification / review / human-handling intent.

        Never auto-approves anything, and never blocks a tool call: it records the request,
        parks the node, releases the worker, and returns a pending result.
        """
        env = self._envelope(envelope)
        scope = self._resolve_envelope_scope(env.run_id, envelope.get("scope"))
        run = self._load_run(env.run_id, scope=scope, operation="request help")
        try:
            with self.db.transaction():
                run = self._load_run_in_scope(env.run_id, scope, operation="request help")
                return self._request_help_tx(run, env, scope=scope)
        except errors.PolyForgeError as exc:
            self._record_refusal(
                exc,
                run=run,
                node_id=env.node_id,
                attempt_id=env.attempt_id,
                command_id=env.command_id,
                idempotency_key=env.idempotency_key,
                kind="request_help",
                payload=envelope,
            )
            raise

    def _request_help_tx(
        self, run: Mapping[str, Any], env: MutationEnvelope, *, scope: Scope
    ) -> dict[str, Any]:
        run_id = str(run["run_id"])
        node_row = self._current_node_row(run_id, env.node_id)
        node_id = str(node_row["node_id"])
        scope_key = f"help:{run_id}:{node_id}"
        payload_hash = hashing.hash_canonical(env.payload)
        replay = self._replay(
            scope=scope,
            scope_key=scope_key,
            idempotency_key=env.idempotency_key,
            payload_hash=payload_hash,
        )
        if replay is not None:
            return replay
        self._check_version(run, env.expected_state_version)
        claim = self._require_claim(
            run, node_row, attempt_id=env.attempt_id, lease_epoch=env.lease_epoch
        )
        kind = str(env.payload.get("kind", "clarification"))
        if kind not in ("clarification", "review", "human_handling"):
            raise errors.bad_request(
                "help kind must be clarification, review, or human_handling",
                kind=kind,
            )
        question = str(env.payload.get("question", ""))
        if not question.strip():
            raise errors.bad_request("a help request needs a question; an empty one is not help")
        contract_hash = node_row.get("contract_hash") or self._ensure_contract(run, node_row)
        contract = self._contract_wire(self._load_contract_row(run_id, str(contract_hash)), run)
        plan = self._plan(run)
        node_plan = self._plan_node(plan, node_id)
        evidence_rows, _ = self._select_evidence(scope, run, node_row, [])
        target_hash = self._decision_target(run, node_row, contract, node_plan, evidence_rows)
        request_id = ids.new_id("decision")
        now = self._now()
        self.db.execute(
            "INSERT INTO governance_bindings (binding_id, company_ref, project_ref, run_id, node_id,"
            " iteration, request_id, kind, gate_id, semantic_kind, decision_target_hash,"
            " transition_hash, evidence_set_hash, policy_version, evaluator_versions_json,"
            " required_responder, interaction_creator, authority_json, environment_json, question,"
            " options_json, provider_ref_json, state, expires_at, resolved_at, resolution_json,"
            " created_at, updated_at)"
            " VALUES (:binding_id, :company_ref, :project_ref, :run_id, :node_id, :iteration,"
            " :request_id, :kind, :gate_id, :semantic_kind, :decision_target_hash, :transition_hash,"
            " :evidence_set_hash, :policy_version, :evaluator_versions_json, 'human_only',"
            " :interaction_creator, :authority_json, :environment_json, :question, :options_json,"
            " NULL, 'PENDING', NULL, NULL, NULL, :now, :now)",
            {
                "binding_id": ids.new_id("binding"),
                "company_ref": scope.company_ref,
                "project_ref": scope.project_ref,
                "run_id": run_id,
                "node_id": node_id,
                "iteration": int(node_row["iteration"]),
                "request_id": request_id,
                "kind": "decision" if kind == "human_handling" else "interaction",
                "gate_id": node_id,
                "semantic_kind": f"{node_id}.{kind}",
                "decision_target_hash": target_hash,
                "transition_hash": str(contract["contractHash"]),
                "evidence_set_hash": self.evidence.set_hash(evidence_rows),
                "policy_version": str((contract.get("effectivePolicy") or {}).get("version", "")),
                "evaluator_versions_json": dumps(
                    {str(e["ref"]): str(e.get("version", "")) for e in contract["requiredEvaluators"]}
                ),
                "interaction_creator": str(claim["agent_subject"]),
                "authority_json": dumps(dict(contract.get("authority") or {})),
                "environment_json": dumps(dict(contract.get("environment") or {})),
                "question": question,
                "options_json": dumps(list(env.payload.get("options") or ())),
                "now": now,
            },
        )
        self._release_worker(node_row, reason=f"awaiting human response to: {question}")
        self.db.execute(
            "UPDATE node_executions SET status = ?, wait_reason = ?, updated_at = ?"
            " WHERE run_id = ? AND node_id = ? AND iteration = ?",
            (NodeStatus.WAITING_GOVERNANCE, question, now, run_id, node_id, int(node_row["iteration"])),
        )
        self._outbox(
            run=run,
            kind="governance.request",
            node_id=node_id,
            correlation_key=f"governance:{run_id}:{node_id}:{target_hash}:{kind}",
            payload={
                "runId": run_id,
                "nodeId": node_id,
                "requestId": request_id,
                "kind": kind,
                "semanticKind": f"{node_id}.{kind}",
                "question": question,
                "context": dict(env.payload.get("context") or {}),
                "decisionTargetHash": target_hash,
                "transitionHash": str(contract["contractHash"]),
                "requiredResolver": "human_only",
                "rootIssueRef": loads(run.get("root_issue_ref_json"), None),
            },
        )
        self._emit(
            run_id,
            "pf.governance.requested",
            {
                "requestId": request_id,
                "nodeId": node_id,
                "kind": kind,
                "decisionTargetHash": target_hash,
                "workerReleased": True,
            },
        )
        self.db.execute(
            "UPDATE graph_runs SET status = ? WHERE run_id = ? AND status IN ('ACTIVE','CREATED')",
            (str(GraphRunStatus.WAITING), run_id),
        )
        state_version = self._bump(run_id)
        result = CommandResult(
            command_id=env.command_id,
            applied=True,
            state_version=state_version,
            status=str(NodeStatus.WAITING_GOVERNANCE),
            result_ref=request_id,
            blockers=[],
            pending=True,
            pending_reason="awaiting_human_response",
        ).to_wire()
        self._record_command(
            scope=scope,
            scope_key=scope_key,
            run_id=run_id,
            command_id=env.command_id,
            idempotency_key=env.idempotency_key,
            payload_hash=payload_hash,
            result=result,
        )
        return result

    def run_command(self, request: Mapping[str, Any]) -> dict[str, Any]:
        """pause / resume / cancel / retry / resolve_block, with a permission check first."""
        scope = self._require_scope_field(request.get("scope"))
        command = str(request.get("command", ""))
        if command not in RUN_COMMANDS:
            raise errors.bad_request(
                f"unknown run command {command!r}", known=list(RUN_COMMANDS)
            )
        self._authorize_command(request, command)
        run = self._load_run(str(request.get("runId", "")), scope=scope, operation=f"run {command}")
        try:
            with self.db.transaction():
                run = self._load_run_in_scope(
                    str(request.get("runId", "")), scope, operation=f"run {command}"
                )
                return self._run_command_tx(run, request, command, scope=scope)
        except errors.PolyForgeError as exc:
            self._record_refusal(
                exc,
                run=run,
                node_id=str(request.get("nodeId", "")) or None,
                command_id=str(request.get("commandId", "")) or None,
                idempotency_key=str(request.get("idempotencyKey", "")) or None,
                kind=f"run_command:{command}",
                payload=request,
            )
            raise

    @staticmethod
    def _authorize_command(request: Mapping[str, Any], command: str) -> None:
        actor = request.get("actor") or {}
        subject = str(actor.get("subjectRef", "") or actor.get("subject", ""))
        capabilities = [str(c) for c in (actor.get("capabilities") or ())]
        required = COMMAND_CAPABILITIES[command]
        if not subject:
            raise errors.authorization_denied(
                "actor.subjectRef is required; a run command has no anonymous author",
                requiredCapability=required,
            )
        if required not in capabilities:
            # Button visibility is not authorization, so the server re-checks.
            raise errors.authorization_denied(
                f"actor {subject!r} lacks the capability {required!r} required to {command} this run",
                requiredCapability=required,
                presentedCapabilities=sorted(capabilities),
            )
        if str(actor.get("actorType", "")) == "agent" and command == "resolve_block":
            raise errors.authorization_denied(
                "only a human or system actor may resolve a block; a worker may not clear its own"
            )

    def _run_command_tx(
        self,
        run: Mapping[str, Any],
        request: Mapping[str, Any],
        command: str,
        *,
        scope: Scope,
    ) -> dict[str, Any]:
        run_id = str(run["run_id"])
        payload_hash = hashing.hash_canonical(
            {
                "command": command,
                "nodeId": request.get("nodeId"),
                "reason": request.get("reason"),
                "resolutionDetail": request.get("resolutionDetail"),
            }
        )
        idempotency_key = str(request.get("idempotencyKey", "")) or f"command:{command}:{request.get('commandId', '')}"
        scope_key = f"run-command:{run_id}:{command}"
        replay = self._replay(
            scope=scope,
            scope_key=scope_key,
            idempotency_key=idempotency_key,
            payload_hash=payload_hash,
        )
        if replay is not None:
            return replay
        expected = request.get("expectedVersion")
        if expected is not None and int(expected) != int(run["state_version"]):
            raise errors.version_conflict(
                f"expectedVersion {expected} does not match the run's current version",
                int(run["state_version"]),
                runId=run_id,
            )
        reason = str(request.get("reason", ""))
        if not reason.strip():
            raise errors.bad_request("a run command must carry a reason for the audit record")
        if command in ("retry", "resume", "resolve_block"):
            # A financial hard stop is the platform's authority. No command, and no agent
            # substitution, may work around it.
            self._budget_lease(run)
        if str(run["status"]) in _TERMINAL_RUN and command != "resolve_block":
            raise errors.run_blocked(
                f"run is {run['status']} and cannot be {command}ed", runId=run_id
            )

        now = self._now()
        status: str
        blockers: list[Blocker] = []
        if command == "pause":
            status = str(GraphRunStatus.PAUSED)
        elif command == "resume":
            status = str(GraphRunStatus.ACTIVE)
        elif command == "cancel":
            status = str(GraphRunStatus.CANCELLED)
            for row in self.db.query(
                "SELECT * FROM execution_attempts WHERE run_id = ? AND lease_state = 'ACTIVE'",
                (run_id,),
            ):
                node_row = self._node_row(run_id, str(row["node_id"]), int(row["iteration"]))
                self._fence_worker(
                    node_row,
                    reason="run cancelled; the platform must confirm the worker stopped before any "
                    "replacement is dispatched",
                    node_status=NodeStatus.BLOCKED,
                )
                self.db.execute(
                    "UPDATE execution_attempts SET status = ?, updated_at = ? WHERE attempt_id = ?",
                    (AttemptStatus.UNKNOWN, now, str(row["attempt_id"])),
                )
                self._outbox(
                    run=run,
                    kind="work.stop",
                    node_id=str(row["node_id"]),
                    correlation_key=f"stop:{run_id}:{row['attempt_id']}",
                    payload={
                        "runId": run_id,
                        "nodeId": str(row["node_id"]),
                        "attemptId": str(row["attempt_id"]),
                        "agentRunRef": loads(row.get("agent_run_ref_json"), None),
                        "reason": reason,
                    },
                )
                self._emit(
                    run_id,
                    "pf.execution.unknown",
                    {
                        "nodeId": str(row["node_id"]),
                        "attemptId": str(row["attempt_id"]),
                        "reason": "stop requested; outcome unconfirmed until the platform reports it",
                    },
                )
        elif command == "retry":
            node_row = self._current_node_row(run_id, str(request.get("nodeId") or ""), required=False)
            status = str(run["status"])
            blockers, status = self._apply_retry(run, node_row, request, scope=scope)
        else:  # resolve_block
            status, blockers = self._apply_resolve_block(run, request, scope=scope)

        self.db.execute(
            "UPDATE graph_runs SET status = ?, block_reason = ?, block_detail_json = ?"
            " WHERE run_id = ?",
            (
                status,
                blockers[0].reason if blockers else None,
                dumps({"reason": reason, "command": command, "blockers": [b.to_wire() for b in blockers]})
                if blockers
                else None,
                run_id,
            ),
        )
        state_version = self._bump(run_id)
        if command in ("pause", "resume", "cancel"):
            self._apply_plan(
                self._load_run_in_scope(run_id, scope, operation=f"run {command}"),
                scope=scope,
                cause=f"run_command:{command}",
            )
            state_version = int(
                self._load_run_in_scope(run_id, scope, operation="run command")["state_version"]
            )
        if command == "cancel":
            self._emit(
                run_id,
                "pf.run.cancelled",
                {
                    "reason": reason,
                    "actor": str((request.get("actor") or {}).get("subjectRef", "")),
                },
            )
        # A control request is a durable state change, so it gets a recovery point. There is
        # no published "run paused" event, and inventing one would break consumers.
        self._checkpoint(
            self._load_run_in_scope(run_id, scope, operation="run command"),
            node_id=str(request.get("nodeId") or "") or None,
            attempt_id=None,
            contract_hash=None,
            state_version=state_version,
        )
        self._emit(
            run_id,
            "pf.checkpoint.written",
            {"command": command, "reason": reason, "stateVersion": state_version},
        )
        result = CommandResult(
            command_id=str(request.get("commandId", "")) or ids.new_id("command"),
            applied=True,
            state_version=state_version,
            status=status,
            result_ref=run_id,
            blockers=blockers,
        ).to_wire()
        self._record_command(
            scope=scope,
            scope_key=scope_key,
            run_id=run_id,
            command_id=str(request.get("commandId", "")) or ids.new_id("command"),
            idempotency_key=idempotency_key,
            payload_hash=payload_hash,
            result=result,
        )
        return result

    def _apply_retry(
        self,
        run: Mapping[str, Any],
        node_row: Mapping[str, Any],
        request: Mapping[str, Any],
        *,
        scope: Scope,
    ) -> tuple[list[Blocker], str]:
        """Start a new iteration, or explain why the engineering budget forbids it."""
        run_id = str(run["run_id"])
        if node_row is None:
            return (
                [
                    Blocker(
                        code="NO_NODE",
                        reason=str(BlockReason.DEPENDENCY),
                        message="no node execution exists to retry",
                    )
                ],
                str(run["status"]),
            )
        node_id = str(node_row["node_id"])
        rework = int(node_row.get("rework_count", 0) or 0)
        ceiling = int(node_row.get("max_rework", self.default_max_rework) or self.default_max_rework)
        if rework >= ceiling:
            blocker = Blocker(
                code="REWORK_CEILING_EXCEEDED",
                reason=str(BlockReason.BUDGET),
                message=(
                    f"node {node_id!r} has used its engineering rework budget ({rework}/{ceiling}); a "
                    "retry here would be a bypass, so the node stays blocked until the ceiling is "
                    "changed through a reviewed graph revision"
                ),
                detail={"nodeId": node_id, "reworkCount": rework, "maxRework": ceiling},
            )
            self.db.execute(
                "UPDATE node_executions SET status = ?, block_reason = ?, wait_reason = ?,"
                " updated_at = ? WHERE run_id = ? AND node_id = ? AND iteration = ?",
                (
                    NodeStatus.BLOCKED,
                    str(BlockReason.BUDGET),
                    blocker.message,
                    self._now(),
                    run_id,
                    node_id,
                    int(node_row["iteration"]),
                ),
            )
            self._emit(
                run_id,
                "pf.run.blocked",
                {
                    "nodeId": node_id,
                    "blockReason": str(BlockReason.BUDGET),
                    "code": blocker.code,
                    "message": blocker.message,
                },
            )
            self._bump(run_id, status=str(GraphRunStatus.BLOCKED))
            return [blocker], str(GraphRunStatus.BLOCKED)
        iteration = int(node_row["iteration"]) + 1
        now = self._now()
        plan_node = loads(node_row.get("plan_node_json"), {}) or {}
        self.db.execute(
            "UPDATE node_executions SET status = ?, active_attempt_id = NULL, contract_hash = NULL,"
            " contract_id = NULL, wait_reason = NULL, block_reason = NULL, updated_at = ?"
            " WHERE run_id = ? AND node_id = ? AND iteration = ?",
            (NodeStatus.REWORK_REQUIRED, now, run_id, node_id, int(node_row["iteration"])),
        )
        # The new iteration starts with a null contract, so the retry is evaluated against
        # fresh inputs rather than inheriting the previous attempt's identity.
        self.db.execute(
            "INSERT INTO node_executions (company_ref, project_ref, run_id, node_id, iteration,"
            " kind, status, contract_hash, contract_id, plan_node_json, input_refs_json,"
            " output_refs_json, input_digest_json, output_digest, active_attempt_id, wait_reason,"
            " block_reason, required_capabilities_json, assigned_subject, assigned_issue_ref_json,"
            " child_run_id, workspace_requirement_json, rework_count, max_rework, created_at, updated_at)"
            " VALUES (:company_ref, :project_ref, :run_id, :node_id, :iteration, :kind, 'READY',"
            " NULL, NULL, :plan_node_json, '[]', '[]', '{}', :output_digest, NULL, NULL, NULL,"
            " :required_capabilities_json, NULL, :assigned_issue_ref_json, NULL,"
            " :workspace_requirement_json, :rework_count, :max_rework, :now, :now)",
            {
                "company_ref": scope.company_ref,
                "project_ref": scope.project_ref,
                "run_id": run_id,
                "node_id": node_id,
                "iteration": iteration,
                "kind": str(node_row["kind"]),
                "plan_node_json": dumps(plan_node),
                "output_digest": hashing.hash_domain(
                    "pf.node-empty", {"node": node_id, "iteration": iteration}
                ),
                "required_capabilities_json": str(node_row.get("required_capabilities_json") or "[]"),
                "assigned_issue_ref_json": node_row.get("assigned_issue_ref_json"),
                "workspace_requirement_json": node_row.get("workspace_requirement_json"),
                # The new iteration starts one rework deeper; a counter that never advances
                # would make the ceiling unreachable.
                "rework_count": rework + 1,
                "max_rework": ceiling,
                "now": now,
            },
        )
        self._emit(
            run_id,
            "pf.transition.rejected",
            {
                "nodeId": node_id,
                "iteration": iteration,
                "reason": "retry requested",
                "requestedReason": str(request.get("reason", "")),
            },
        )
        return [], str(GraphRunStatus.ACTIVE)

    def _apply_resolve_block(
        self, run: Mapping[str, Any], request: Mapping[str, Any], *, scope: Scope
    ) -> tuple[str, list[Blocker]]:
        """Clear a block only with authority, a reason, and no standing financial stop."""
        run_id = str(run["run_id"])
        budget = self._budget_state(run)
        if str(budget.get("state", "")).upper() in ("HARD_STOP", "EXHAUSTED"):
            # The platform owns the budget. A Core command cannot talk it out of a hard stop.
            return str(run["status"]), [
                Blocker(
                    code="BUDGET_HARD_STOP",
                    reason=str(BlockReason.BUDGET),
                    message=(
                        "a financial hard stop can only be lifted by the platform restoring budget; "
                        "a Core resolve_block cannot clear it"
                    ),
                    detail=dict(budget),
                )
            ]
        detail = request.get("resolutionDetail") or {}
        node_id = str(request.get("nodeId") or "")
        now = self._now()
        if node_id:
            node_row = self._node_row(run_id, node_id)
            self.db.execute(
                "UPDATE node_executions SET status = ?, block_reason = NULL, wait_reason = NULL,"
                " updated_at = ? WHERE run_id = ? AND node_id = ? AND iteration = ?",
                (NodeStatus.REWORK_REQUIRED, now, run_id, node_id, int(node_row["iteration"])),
            )
        self._emit(
            run_id,
            "pf.run.blocked",
            {
                "nodeId": node_id or None,
                "blockReason": None,
                "resolved": True,
                "reason": str(request.get("reason", "")),
                "resolutionDetail": dict(detail),
            },
        )
        return str(GraphRunStatus.ACTIVE), []

    # ------------------------------------------------------------------
    # governance
    # ------------------------------------------------------------------

    def record_governance_resolution(
        self, run_id: str, request_id: str, resolution: Mapping[str, Any]
    ) -> dict[str, Any]:
        """Record a bridge-verified answer, then re-run the whole gate.

        The answer is never applied directly to a node. It is archived as evidence about an
        exact target and the mandatory evaluators are run again; a pass still has to be earned
        by every one of them.
        """
        scope = self._require_scope_field(resolution.get("scope"))
        run = self._load_run(run_id, scope=scope, operation="record governance resolution")
        try:
            with self.db.transaction():
                return self._record_resolution_tx(
                    self._load_run_in_scope(run_id, scope, operation="record governance resolution"),
                    request_id,
                    resolution,
                    scope=scope,
                )
        except errors.PolyForgeError as exc:
            self._record_refusal(
                exc,
                run=run,
                command_id=str(resolution.get("commandId", "")) or None,
                idempotency_key=str(resolution.get("idempotencyKey", "")) or None,
                kind="record_governance_resolution",
                payload=resolution,
            )
            raise

    def _record_resolution_tx(
        self,
        run: Mapping[str, Any],
        request_id: str,
        resolution: Mapping[str, Any],
        *,
        scope: Scope,
    ) -> dict[str, Any]:
        run_id = str(run["run_id"])
        binding = self.db.query_one(
            "SELECT * FROM governance_bindings WHERE run_id = ? AND request_id = ?",
            (run_id, str(request_id)),
        )
        if binding is None:
            raise errors.not_found(
                f"no governance request {request_id!r} in run {run_id!r}",
                runId=run_id,
                requestId=str(request_id),
            )
        payload_hash = hashing.hash_canonical(resolution)
        scope_key = f"governance:{run_id}:{request_id}"
        idempotency_key = str(resolution.get("idempotencyKey", "")) or f"governance:{request_id}"
        replay = self._replay(
            scope=scope,
            scope_key=scope_key,
            idempotency_key=idempotency_key,
            payload_hash=payload_hash,
        )
        if replay is not None:
            return replay
        parsed = GovernanceResolution.from_wire(resolution)
        if parsed is None:
            raise errors.bad_request("resolution must be an object")
        required_responder = str(binding["required_responder"])
        if not parsed.verified_against_provider:
            # The bridge is required to re-read the authoritative object. An unverified
            # "approved" flag is a claim about the platform, not a fact from it.
            raise errors.authorization_denied(
                "the resolution was not verified against the authoritative provider object; the "
                "bridge must re-read it and confirm the target hash before the Core records it",
                requestId=str(request_id),
            )
        if required_responder == "human_only" and parsed.responder_kind != "human":
            raise errors.authorization_denied(
                f"this request is human_only but the responder is {parsed.responder_kind!r}; a worker "
                "or a tool callback can never stand in for a human decision",
                requestId=str(request_id),
                responderKind=parsed.responder_kind,
            )
        if required_responder == "not_creator" and parsed.responder_subject == str(
            binding["interaction_creator"] or ""
        ):
            raise errors.authorization_denied(
                "this request forbids the interaction creator from resolving it",
                requestId=str(request_id),
            )
        expires = binding.get("expires_at")
        if expires and str(expires) <= self._now():
            raise errors.run_blocked(
                f"the governance request expired at {expires}; the decision must be requested again "
                "rather than answered against a stale target",
                requestId=str(request_id),
                expiresAt=str(expires),
            )
        now = self._now()
        detail = dict(parsed.detail or {})
        detail.setdefault("decisionTargetHash", str(binding["decision_target_hash"]))
        self.db.execute(
            "UPDATE governance_bindings SET state = 'RESOLVED', resolved_at = ?, resolution_json = ?,"
            " updated_at = ? WHERE company_ref = ? AND project_ref = ? AND request_id = ?",
            (
                now,
                dumps(
                    {
                        "responderSubject": parsed.responder_subject,
                        "responderKind": parsed.responder_kind,
                        "outcome": parsed.outcome,
                        "verifiedAgainstProvider": True,
                        "detail": detail,
                        "recordedAt": now,
                    }
                ),
                now,
                scope.company_ref,
                scope.project_ref,
                str(request_id),
            ),
        )
        self.db.execute(
            "UPDATE graph_runs SET status = ? WHERE run_id = ? AND status = 'WAITING'",
            (str(GraphRunStatus.ACTIVE), run_id),
        )
        self._emit(
            run_id,
            "pf.governance.observed",
            {
                "requestId": str(request_id),
                "nodeId": str(binding["node_id"]),
                "semanticKind": str(binding["semantic_kind"]),
                "decisionTargetHash": str(binding["decision_target_hash"]),
                "recordedTargetHash": detail.get("decisionTargetHash"),
                "outcome": parsed.outcome,
                "responderSubject": parsed.responder_subject,
                "responderKind": parsed.responder_kind,
            },
        )
        outcome = str(parsed.outcome)
        if outcome in ("reject", "deny"):
            node_row = self._node_row(run_id, str(binding["node_id"]))
            self.db.execute(
                "UPDATE node_executions SET status = ?, wait_reason = ?, updated_at = ?"
                " WHERE run_id = ? AND node_id = ? AND iteration = ?",
                (
                    NodeStatus.REWORK_REQUIRED,
                    f"human decision rejected: {detail.get('reason', outcome)}",
                    now,
                    run_id,
                    str(node_row["node_id"]),
                    int(node_row["iteration"]),
                ),
            )
            state_version = self._bump(run_id)
            result = CommandResult(
                command_id=str(resolution.get("commandId", "")) or ids.new_id("command"),
                applied=True,
                state_version=state_version,
                status=str(NodeStatus.REWORK_REQUIRED),
                result_ref=str(request_id),
                blockers=[],
            ).to_wire()
        else:
            # Re-evaluate: the answer alone changes nothing until the gate agrees.
            env = MutationEnvelope(
                schema_version=SCHEMA_VERSION,
                command_id=str(resolution.get("commandId", "")) or ids.new_id("command"),
                idempotency_key=idempotency_key,
                correlation_id=run_id,
                run_id=run_id,
                node_id=str(binding["node_id"]),
                payload={
                    "evidenceIds": [
                        str(r["evidence_id"])
                        for r in self.evidence.list_for_node(
                            company_ref=scope.company_ref,
                            project_ref=scope.project_ref,
                            run_id=run_id,
                            node_id=str(binding["node_id"]),
                        )
                        if bool(r["valid"])
                    ],
                    "reviewerSubject": str(resolution.get("reviewerSubject", "")) or None,
                    "governanceRequestId": str(request_id),
                },
                scope=scope,
            )
            result = self._evaluate_and_commit(
                self._load_run_in_scope(run_id, scope, operation="record governance resolution"),
                env,
                scope=scope,
                require_claim=False,
                cause="governance_resolution",
                command_id=env.command_id,
                idempotency_key=idempotency_key,
                payload_hash=payload_hash,
                # The outer method records the command once, under the governance identity.
                # Two records for one command would make the second one a conflict.
                record_command=False,
            )
        self._record_command(
            scope=scope,
            scope_key=scope_key,
            run_id=run_id,
            command_id=str(result.get("commandId", "")),
            idempotency_key=idempotency_key,
            payload_hash=payload_hash,
            result=result,
        )
        return result

    # ------------------------------------------------------------------
    # run migration
    # ------------------------------------------------------------------

    def plan_migration(self, request: Mapping[str, Any]) -> dict[str, Any]:
        """Compute a successor-run migration preview. A dry run: nothing is written."""
        scope = self._require_scope_field(request.get("scope"))
        run = self._load_run(str(request.get("runId", "")), scope=scope, operation="plan migration")
        target_version = int(request.get("targetGraphVersion", 0) or 0)
        if not target_version:
            raise errors.bad_request("targetGraphVersion is required")
        mapping = self._migration_mapping(run, target_version, request.get("nodeMapping") or {})
        target = self._resolve_version(
            scope=scope, graph_id=str(run["graph_id"]), version=target_version
        )
        blockers = self._migration_blockers(
            run, target_version, mapping=mapping, target=target, scope=scope
        )
        invalidations = self._migration_invalidations(run, target_version, mapping, scope=scope)
        pending = [
            {
                "requestId": str(row["request_id"]),
                "nodeId": str(row["node_id"]),
                "semanticKind": str(row["semantic_kind"]),
            }
            for row in self.db.query(
                "SELECT * FROM governance_bindings WHERE run_id = ? AND state = 'PENDING'"
                " ORDER BY created_at",
                (str(run["run_id"]),),
            )
        ]
        plan_hash = self._migration_plan_hash(
            run, target_version, mapping, invalidations, pending
        )
        return MigrationPreview(
            run_id=str(run["run_id"]),
            source_graph_version=int(run["graph_version"]),
            target_graph_version=target_version,
            plan_hash=plan_hash,
            quiescent=not blockers,
            blockers=blockers,
            node_mapping=mapping,
            invalidations=invalidations,
            pending_governance=pending,
        ).to_wire()

    def _migration_blockers(
        self,
        run: Mapping[str, Any],
        target_version: int,
        *,
        scope: Scope,
        mapping: Sequence[Mapping[str, Any]] = (),
        target: Mapping[str, Any] | None = None,
    ) -> list[Blocker]:
        run_id = str(run["run_id"])
        blockers: list[Blocker] = []
        for row in self.db.query(
            "SELECT * FROM execution_attempts WHERE run_id = ? AND lease_state IN"
            " ('ACTIVE','FENCED') AND status IN ('PREPARED','RUNNING','CHECKPOINTED')",
            (run_id,),
        ):
            blockers.append(
                Blocker(
                    code="ACTIVE_ATTEMPT",
                    reason=str(BlockReason.LEASE_FENCED),
                    message=(
                        f"attempt {row['attempt_id']} on node {row['node_id']} is still {row['status']}; "
                        "a migration needs a quiescent checkpoint with no live worker"
                    ),
                    detail={"nodeId": str(row["node_id"]), "attemptId": str(row["attempt_id"])},
                )
            )
        for effect in self.db.query(
            "SELECT effect_key FROM effect_records WHERE company_ref = ? AND project_ref = ?"
            " AND run_id = ? AND status = 'UNKNOWN'",
            (scope.company_ref, scope.project_ref, run_id),
        ):
            blockers.append(
                Blocker(
                    code="UNKNOWN_EFFECT",
                    reason=str(BlockReason.EFFECT_UNKNOWN),
                    message=(
                        f"effect {effect['effect_key']} has an unknown outcome; an unknown effect is "
                        "never migrated away from and never reset to zero"
                    ),
                    detail={"effectKey": str(effect["effect_key"])},
                )
            )
        if str(run["status"]) in (GraphRunStatus.CANCELLED, GraphRunStatus.FAILED):
            blockers.append(
                Blocker(
                    code="TERMINAL_SOURCE",
                    reason=str(BlockReason.DEPENDENCY),
                    message=f"source run is {run['status']} and cannot be migrated",
                )
            )
        if self._migration_target_missing(run, target_version, target):
            blockers.append(
                Blocker(
                    code="TARGET_VERSION_UNKNOWN",
                    reason=str(BlockReason.DEPENDENCY),
                    message=f"graph {run['graph_id']} version {target_version} is not published in this scope",
                )
            )
        target_plan = self._target_plan(run, target) if target is not None else None
        if target is not None and target_plan is None:
            blockers.append(
                Blocker(
                    code="TARGET_ENTRYPOINT_MISSING",
                    reason=str(BlockReason.DEPENDENCY),
                    message=(
                        f"graph version {target_version} does not declare entrypoint "
                        f"{run['entrypoint']!r}; there is no successor run to plan"
                    ),
                )
            )
        for entry in mapping:
            # A mapping that names a node the target version does not have would silently drop
            # that node from the successor, so the migration is refused with the mapping
            # visible in the preview rather than committed as a smaller graph.
            if target_plan is not None and not target_plan.has_node(str(entry["to"])):
                blockers.append(
                    Blocker(
                        code="NODE_MAPPING_INCOMPLETE",
                        reason=str(BlockReason.DEPENDENCY),
                        message=(
                            f"node {entry['from']!r} is mapped to {entry['to']!r}, which graph "
                            f"version {target_version} does not declare; a successor run may not "
                            "silently lose a node"
                        ),
                        detail={
                            "from": str(entry["from"]),
                            "to": str(entry["to"]),
                            "targetGraphVersion": int(target_version),
                        },
                    )
                )
        return blockers

    @staticmethod
    def _migration_target_missing(
        run: Mapping[str, Any], target_version: int, target: Mapping[str, Any] | None
    ) -> bool:
        """An unpublished target only blocks a move forward.

        Migrating onto the version the run already runs is a no-op that stays available for
        rollback bookkeeping, so it is not held to the publication rule.
        """
        return target is None and target_version > int(run["graph_version"])

    def _target_plan(
        self, run: Mapping[str, Any], target: Mapping[str, Any]
    ) -> ExecutionPlan | None:
        """The successor run's plan, or ``None`` when the target cannot host this entrypoint.

        A version that dropped the run's entrypoint cannot host its successor, and that is a
        refusal an operator can read in the preview rather than a ``422`` thrown from the
        middle of a dry run.
        """
        entrypoint = str(run["entrypoint"])
        definition = target.get("definition") or {}
        if entrypoint not in (definition.get("entrypoints") or {}):
            return None
        return build_plan(
            definition,
            graph_version=int(target.get("version", 0) or 0),
            entrypoint=entrypoint,
            artifact=self._version_artifact(target),
        )

    def _migration_mapping(
        self,
        run: Mapping[str, Any],
        target_version: int,
        requested: Mapping[str, Any],
    ) -> list[dict[str, str]]:
        plan = self._plan(run)
        rows: list[dict[str, str]] = []
        for node_id in plan.ordered_node_ids():
            target = str(requested.get(node_id, node_id))
            state = self.db.query_one(
                "SELECT status FROM node_executions WHERE run_id = ? AND node_id = ?"
                " ORDER BY iteration DESC LIMIT 1",
                (str(run["run_id"]), node_id),
            )
            rows.append(
                {
                    "from": node_id,
                    "to": target,
                    "stateAction": str(state["status"]) if state else "PENDING",
                }
            )
        return rows

    def _migration_invalidations(
        self,
        run: Mapping[str, Any],
        target_version: int,
        mapping: Sequence[Mapping[str, str]],
        *,
        scope: Scope,
    ) -> list[dict[str, str]]:
        """What a successor run may not inherit. A changed PASS is never carried over."""
        plan = self._plan(run)
        rows = self._node_rows(str(run["run_id"]))
        invalidations: list[dict[str, str]] = [
            {
                "kind": "pass_inheritance",
                "detail": (
                    "a PASS is never inherited across a version change; the successor run re-evaluates "
                    "every node it keeps"
                ),
            }
        ]
        for row in rows:
            if str(row["status"]) == NodeStatus.PASSED:
                invalidations.append(
                    {
                        "kind": "revalidate_node",
                        "detail": (
                            f"node {row['node_id']} passed under plan {plan.plan_hash}; the successor "
                            "re-evaluates it"
                        ),
                    }
                )
        for link in self.db.query(
            "SELECT * FROM child_run_links WHERE company_ref = ? AND project_ref = ?"
            " AND parent_run_id = ?",
            (scope.company_ref, scope.project_ref, str(run["run_id"])),
        ):
            invalidations.append(
                {
                    "kind": "child_run",
                    "detail": (
                        f"child run {link['child_run_id']} belongs to generation "
                        f"{link['invocation_generation']} and is planned individually"
                    ),
                }
            )
        return invalidations

    @staticmethod
    def _migration_plan_hash(
        run: Mapping[str, Any],
        target_version: int,
        mapping: Sequence[Mapping[str, str]],
        invalidations: Sequence[Mapping[str, str]],
        pending: Sequence[Mapping[str, str]],
    ) -> str:
        return hashing.hash_domain(
            "pf.migration-plan",
            {
                "sourceRunId": str(run["run_id"]),
                "sourceStateVersion": int(run["state_version"]),
                "sourcePlanHash": str(run["plan_hash"]),
                "sourceGraphVersion": int(run["graph_version"]),
                "targetGraphVersion": int(target_version),
                "nodeMapping": [dict(m) for m in mapping],
                "invalidations": [dict(i) for i in invalidations],
                "pendingGovernance": [dict(p) for p in pending],
            },
        )

    def commit_migration(self, request: Mapping[str, Any]) -> dict[str, Any]:
        """Commit an approved migration plan: freeze the source, create the successor.

        First version is the frozen-source-plus-successor model (REQ-MIG-03). History is kept:
        the source becomes ``SUPERSEDED``, never deleted.
        """
        scope = self._require_scope_field(request.get("scope"))
        run = self._load_run(str(request.get("runId", "")), scope=scope, operation="commit migration")
        try:
            with self.db.transaction():
                return self._commit_migration_tx(run, request, scope=scope)
        except errors.PolyForgeError as exc:
            self._record_refusal(
                exc,
                run=run,
                command_id=str(request.get("commandId", "")) or None,
                idempotency_key=str(request.get("idempotencyKey", "")) or None,
                kind="commit_migration",
                payload=request,
            )
            raise

    def _commit_migration_tx(
        self, run: Mapping[str, Any], request: Mapping[str, Any], *, scope: Scope
    ) -> dict[str, Any]:
        run_id = str(run["run_id"])
        idempotency_key = str(request.get("idempotencyKey", "")) or f"migration:{run_id}:{request.get('commandId', '')}"
        payload_hash = hashing.hash_canonical(
            {
                "targetGraphVersion": request.get("targetGraphVersion"),
                "nodeMapping": request.get("nodeMapping") or {},
                "planHash": request.get("planHash"),
            }
        )
        replay = self._replay(
            scope=scope,
            scope_key=f"migration:{run_id}",
            idempotency_key=idempotency_key,
            payload_hash=payload_hash,
        )
        if replay is not None:
            return replay
        expected = request.get("expectedStateVersion")
        if expected is not None and int(expected) != int(run["state_version"]):
            raise errors.version_conflict(
                f"expectedStateVersion {expected} does not match the run's current version",
                int(run["state_version"]),
                runId=run_id,
            )
        target_version = int(request.get("targetGraphVersion", 0) or 0)
        preview = self.plan_migration(
            {
                "scope": scope.to_wire(),
                "runId": run_id,
                "targetGraphVersion": target_version,
                "nodeMapping": request.get("nodeMapping") or {},
            }
        )
        if preview["blockers"]:
            raise errors.run_blocked(
                "the source run is not quiescent; migration is refused with its blockers",
                blockers=preview["blockers"],
                runId=run_id,
            )
        if str(request.get("planHash", "")) != str(preview["planHash"]):
            # The plan was computed against a different source state; approving it would
            # approve a transition nobody reviewed.
            raise errors.version_conflict(
                "the migration plan hash no longer matches the source state; re-plan and re-approve",
                int(run["state_version"]),
                presentedPlanHash=str(request.get("planHash", "")),
                currentPlanHash=str(preview["planHash"]),
                runId=run_id,
            )
        approvals = [str(a) for a in (request.get("approvalRefs") or ())]
        if not approvals:
            raise errors.authorization_denied(
                "a migration needs explicit approval references; it is a governed operation, not a "
                "maintenance shortcut",
                runId=run_id,
            )
        target = self._resolve_version(
            scope=scope, graph_id=str(run["graph_id"]), version=target_version
        )
        if target is None:
            raise errors.not_found(
                f"target graph version {target_version} is not published", runId=run_id
            )
        target_plan = build_plan(
            target["definition"],
            graph_version=target_version,
            entrypoint=str(run["entrypoint"]),
            artifact=self._version_artifact(target),
        )
        target_digest = str(target.get("definitionHash", "") or "")
        now = self._now()
        successor_id = ids.new_id("run")
        source_epoch = int(run["owner_epoch"])
        self.db.execute(
            "UPDATE graph_runs SET status = ?, migration_state = 'SUPERSEDED', owner_epoch = ?,"
            " updated_at = ? WHERE run_id = ?",
            (str(GraphRunStatus.PAUSED), source_epoch + 1, now, run_id),
        )
        self.db.execute(
            "INSERT INTO graph_runs (run_id, company_ref, project_ref, family_id, work_order_id,"
            " graph_id, graph_version, definition_hash, plan_hash, dependency_lock_hash, status,"
            " state_version, event_sequence, owner_epoch, entrypoint, parent_run_id, parent_node_id,"
            " invocation_generation, pins_json, plan_json, input_snapshot_json, required_facts_json,"
            " root_issue_ref_json, parent_issue_ref_json, budget_state_json, block_reason,"
            " block_detail_json, migration_state, created_at, updated_at, created_by)"
            " VALUES (:run_id, :company_ref, :project_ref, :family_id, :work_order_id, :graph_id,"
            " :graph_version, :definition_hash, :plan_hash, :dependency_lock_hash, 'ACTIVE', 1, 0,"
            " :owner_epoch, :entrypoint, :parent_run_id, :parent_node_id, :invocation_generation,"
            " :pins_json, :plan_json, :input_snapshot_json, :required_facts_json, :root_issue_ref_json,"
            " :parent_issue_ref_json, :budget_state_json, NULL, NULL, 'SUCCESSOR', :now, :now, :created_by)",
            {
                "run_id": successor_id,
                "company_ref": scope.company_ref,
                "project_ref": scope.project_ref,
                "family_id": str(run["family_id"]),
                "work_order_id": str(run["work_order_id"]),
                "graph_id": str(run["graph_id"]),
                "graph_version": target_version,
                "definition_hash": target_digest,
                "plan_hash": target_plan.plan_hash,
                "dependency_lock_hash": str(target.get("dependencyLockHash", "") or ""),
                "owner_epoch": source_epoch + 1,
                "entrypoint": str(run["entrypoint"]),
                "parent_run_id": run_id,
                "parent_node_id": None,
                "invocation_generation": int(run["invocation_generation"]) + 1,
                "pins_json": dumps(
                    {
                        **self._pins(
                            target_plan,
                            self._policy_rules(run),
                            target_digest,
                            self._version_artifact(target),
                        ),
                        "migratedFrom": run_id,
                    }
                ),
                "plan_json": dumps(target_plan.to_wire()),
                "input_snapshot_json": str(run["input_snapshot_json"]),
                "required_facts_json": str(run["required_facts_json"]),
                "root_issue_ref_json": str(run["root_issue_ref_json"]),
                "parent_issue_ref_json": run.get("parent_issue_ref_json"),
                "budget_state_json": run.get("budget_state_json"),
                "now": now,
                "created_by": str(request.get("actorId", "")) or None,
            },
        )
        carried = 0
        for entry in preview["nodeMapping"]:
            target_node = str(entry["to"])
            if not target_plan.has_node(target_node):
                # Unreachable: the plan refuses a mapping that names a node the target does
                # not declare, and it is the same immutable version resolved again here. Kept
                # so a successor row can never be built from a node id the plan does not hold.
                continue
            source_node = self._node_row(run_id, str(entry["from"]))
            node_plan = target_plan.nodes[target_node]
            self.db.execute(
                "INSERT INTO node_executions (company_ref, project_ref, run_id, node_id, iteration,"
                " kind, status, contract_hash, contract_id, plan_node_json, input_refs_json,"
                " output_refs_json, input_digest_json, output_digest, active_attempt_id, wait_reason,"
                " block_reason, required_capabilities_json, assigned_subject, assigned_issue_ref_json,"
                " child_run_id, workspace_requirement_json, rework_count, max_rework, created_at,"
                " updated_at)"
                " VALUES (:company_ref, :project_ref, :run_id, :node_id, 0, :kind, 'PENDING', NULL,"
                " NULL, :plan_node_json, '[]', '[]', '{}', :output_digest, NULL, NULL, NULL,"
                " :required_capabilities_json, NULL, NULL, NULL, :workspace_requirement_json, 0,"
                " :max_rework, :now, :now)",
                {
                    "company_ref": scope.company_ref,
                    "project_ref": scope.project_ref,
                    "run_id": successor_id,
                    "node_id": target_node,
                    "kind": node_plan.kind,
                    "plan_node_json": dumps(node_plan.to_canonical()),
                    "output_digest": hashing.hash_domain(
                        "pf.node-empty", {"node": target_node, "run": successor_id}
                    ),
                    "required_capabilities_json": dumps(list(node_plan.required_capabilities)),
                    "workspace_requirement_json": dumps(dict(node_plan.workspace_requirement))
                    if node_plan.workspace_requirement
                    else None,
                    "max_rework": node_plan.max_rework or self.default_max_rework,
                    "now": now,
                },
            )
            if str(source_node["status"]) == NodeStatus.PASSED:
                # Recorded as an invalidation, not a shortcut: the successor re-evaluates.
                carried += 1
        migration_id = ids.new_id("migration")
        self.db.execute(
            "INSERT INTO migration_records (migration_id, company_ref, project_ref, source_run_id,"
            " successor_run_id, source_graph_version, target_graph_version, plan_hash,"
            " node_mapping_json, approval_refs_json, checkpoint_refs_json, cutover_epoch, status,"
            " created_at, updated_at)"
            " VALUES (:migration_id, :company_ref, :project_ref, :source_run_id, :successor_run_id,"
            " :source_graph_version, :target_graph_version, :plan_hash, :node_mapping_json,"
            " :approval_refs_json, :checkpoint_refs_json, :cutover_epoch, 'COMMITTED', :now, :now)",
            {
                "migration_id": migration_id,
                "company_ref": scope.company_ref,
                "project_ref": scope.project_ref,
                "source_run_id": run_id,
                "successor_run_id": successor_id,
                "source_graph_version": int(run["graph_version"]),
                "target_graph_version": target_version,
                "plan_hash": str(preview["planHash"]),
                "node_mapping_json": dumps(preview["nodeMapping"]),
                "approval_refs_json": dumps(approvals),
                "checkpoint_refs_json": dumps(
                    [
                        str(r["checkpoint_id"])
                        for r in self.db.query(
                            "SELECT checkpoint_id FROM graph_checkpoints WHERE run_id = ?"
                            " ORDER BY created_at DESC LIMIT 1",
                            (run_id,),
                        )
                    ]
                ),
                "cutover_epoch": source_epoch + 1,
                "now": now,
            },
        )
        successor_row = self._load_run_in_scope(successor_id, scope, operation="commit migration")
        self._apply_plan(successor_row, scope=scope, cause="migration")
        self._outbox(
            run=successor_row,
            kind="migration.applied",
            correlation_key=f"migration:{run_id}:{target_version}:{preview['planHash']}",
            payload={
                "sourceRunId": run_id,
                "successorRunId": successor_id,
                "targetGraphVersion": target_version,
                "planHash": str(preview["planHash"]),
                "invalidatedPasses": carried,
            },
        )
        self._emit(
            run_id,
            "pf.migration.committed",
            {
                "successorRunId": successor_id,
                "targetGraphVersion": target_version,
                "planHash": str(preview["planHash"]),
                "cutoverEpoch": source_epoch + 1,
                "approvalRefs": approvals,
            },
        )
        state_version = self._bump(run_id)
        result = CommandResult(
            command_id=str(request.get("commandId", "")) or ids.new_id("command"),
            applied=True,
            state_version=state_version,
            status=str(GraphRunStatus.PAUSED),
            result_ref=successor_id,
            blockers=[],
        ).to_wire()
        self._record_command(
            scope=scope,
            scope_key=f"migration:{run_id}",
            run_id=run_id,
            command_id=str(result["commandId"]),
            idempotency_key=idempotency_key,
            payload_hash=payload_hash,
            result=result,
        )
        return result

    # ------------------------------------------------------------------
    # event intake
    # ------------------------------------------------------------------

    #: Observations that only describe platform state. None of them can advance a node.
    _OBSERVATION_ONLY = frozenset(
        {
            "pf.work_order.accepted",
            "pf.node.ready",
            "pf.node.dispatched",
            "pf.execution.observed",
            "pf.gate.evaluated",
            "pf.gate.waiting",
            "pf.transition.committed",
            "pf.transition.rejected",
            "pf.governance.requested",
            "pf.governance.observed",
            "pf.authorization.denied",
            "pf.effect.reconciled",
            "pf.run.completed",
            "pf.run.cancelled",
            "pf.checkpoint.written",
            "pf.migration.committed",
        }
    )

    def intake_event(self, event: Mapping[str, Any]) -> dict[str, Any]:
        """Ingest one normalized ``pf.*`` observation from the bridge.

        Three properties matter here. It dedupes on ``source + scope + sourceEventId`` so a
        replayed webhook is a no-op. It quarantines an unknown schema rather than guessing.
        And it treats every event as a *request to verify*: an ``agent.run.finished`` or an
        issue dragged to ``done`` is recorded and may trigger a re-evaluation, but it can never
        set a node ``PASSED``.
        """
        scope = self._require_scope_field(event.get("scope"))
        event_type = str(event.get("type", ""))
        source_event_id = str(event.get("sourceEventId", "") or "")
        payload = dict(event.get("payload") or {})
        now = self._now()
        if not is_pf_event(event_type):
            # Unknown schemas fail closed: the payload hash is kept for triage and nothing is
            # applied. The event is recorded in a dedicated table row so the bridge can see
            # that its observation was refused rather than silently dropped.
            with self.db.transaction():
                self.db.execute(
                    "INSERT INTO domain_events (event_id, company_ref, project_ref, run_id, seq, type,"
                    " at, payload_json, correlation_id, causation_id, source, source_event_id,"
                    " source_revision, quarantined, quarantine_reason, created_at, updated_at)"
                    " VALUES (:event_id, :company_ref, :project_ref, NULL, 0, :type, :now,"
                    " :payload_json, :correlation_id, :causation_id, :source, :source_event_id,"
                    " :source_revision, 1, :reason, :now, :now)",
                    {
                        "event_id": ids.new_id("event"),
                        "company_ref": scope.company_ref,
                        "project_ref": scope.project_ref,
                        "type": event_type or "unknown",
                        "now": now,
                        "payload_json": dumps(
                            {"payloadHash": hashing.hash_canonical(payload), "payload": payload}
                        ),
                        "correlation_id": str(event.get("correlationId", "")) or None,
                        "causation_id": str(event.get("causationId", "")) or None,
                        "source": str(event.get("source", "bridge")) or None,
                        "source_event_id": source_event_id or None,
                        "source_revision": str(event.get("revision", "")) or None,
                        "reason": f"unknown event schema {event_type!r}; failed closed",
                    },
                )
            return {
                "accepted": False,
                "quarantined": True,
                "reason": f"{event_type!r} is not a published pf.* event type; the payload was kept "
                "for triage and nothing was applied",
                "payloadHash": hashing.hash_canonical(payload),
            }

        run = self._load_run(str(event.get("runId", "")), scope=scope, operation="intake event")
        run_id = str(run["run_id"])
        revision = str(event.get("revision", "") or "") or None
        if revision:
            recorded = self.db.query_one(
                "SELECT MAX(source_revision) AS rev FROM domain_events WHERE run_id = ?"
                " AND source_revision IS NOT NULL",
                (run_id,),
            )
            latest = str((recorded or {}).get("rev") or "")
            if latest and revision < latest:
                # Out-of-order: recorded as lag, never applied. Arrival order does not decide
                # state; the authoritative revision does.
                with self.db.transaction():
                    self._append_intake_event(
                        run,
                        event_type,
                        payload,
                        event=event,
                        source_event_id=source_event_id,
                        revision=revision,
                        quarantined=True,
                        quarantine_reason=f"revision {revision} is older than recorded {latest}",
                    )
                return {
                    "accepted": False,
                    "stale": True,
                    "runId": run_id,
                    "reason": f"source revision {revision} is behind the recorded {latest}",
                }
        with self.db.transaction():
            duplicate = self._append_intake_event(
                run,
                event_type,
                payload,
                event=event,
                source_event_id=source_event_id,
                revision=revision,
            )
            if duplicate:
                return {"accepted": False, "duplicate": True, "runId": run_id, "reason": duplicate}
            applied = self._apply_observation(run, event_type, payload, event=event)
            return {
                "accepted": True,
                "runId": run_id,
                "applied": applied,
                "note": (
                    "observation recorded; engineering state advances only through "
                    "request_transition with every mandatory evaluator passing"
                ),
            }

    def _append_intake_event(
        self,
        run: Mapping[str, Any],
        event_type: str,
        payload: Mapping[str, Any],
        *,
        event: Mapping[str, Any],
        source_event_id: str,
        revision: str | None,
        quarantined: bool = False,
        quarantine_reason: str | None = None,
    ) -> str | None:
        """Persist an intake event, returning a reason string when it was a duplicate."""
        run_id = str(run["run_id"])
        if source_event_id:
            existing = self.db.query_one(
                "SELECT event_id FROM domain_events WHERE source = ? AND company_ref = ?"
                " AND project_ref = ? AND source_event_id = ?",
                (str(event.get("source", "bridge")), str(run["company_ref"]), str(run["project_ref"]), source_event_id),
            )
            if existing is not None:
                return f"source event {source_event_id} was already ingested"
        self._emit(
            run_id,
            event_type,
            payload,
            correlation_id=str(event.get("correlationId", "")) or None,
            causation_id=str(event.get("causationId", "")) or None,
            source=str(event.get("source", "bridge")) or None,
            source_event_id=source_event_id or None,
            source_revision=revision,
        )
        if quarantined and quarantine_reason:
            self.db.execute(
                "UPDATE domain_events SET quarantined = 1, quarantine_reason = ? WHERE run_id = ?"
                " AND seq = (SELECT MAX(seq) FROM domain_events WHERE run_id = ?)",
                (quarantine_reason, run_id, run_id),
            )
        return None

    def _apply_observation(
        self,
        run: Mapping[str, Any],
        event_type: str,
        payload: Mapping[str, Any],
        *,
        event: Mapping[str, Any],
    ) -> list[str]:
        """Apply the small set of state changes an observation is allowed to cause.

        A pass is never in this list. An execution observation may only confirm that a worker
        is running or that its exit is unknown; an issue status may only be recorded.
        """
        run_id = str(run["run_id"])
        applied: list[str] = []
        node_id = str(payload.get("nodeId", "") or event.get("nodeId", "") or "")
        if event_type == "pf.execution.observed":
            attempt = self.db.query_one(
                "SELECT * FROM execution_attempts WHERE run_id = ? AND attempt_id = ?",
                (run_id, str(payload.get("attemptId", ""))),
            )
            if attempt is None:
                applied.append("recorded_without_known_attempt")
                return applied
            if str(attempt["status"]) in (AttemptStatus.FAILED, AttemptStatus.CANCELLED):
                applied.append("observation_ignored_for_terminal_attempt")
                return applied
            if str(attempt["status"]) == AttemptStatus.RUNNING:
                applied.append("attempt_confirmed_running")
            return applied
        if event_type == "pf.execution.unknown":
            attempt_id = str(payload.get("attemptId", ""))
            row = self.db.query_one(
                "SELECT * FROM execution_attempts WHERE run_id = ? AND attempt_id = ?",
                (run_id, attempt_id),
            )
            if row is None:
                return applied
            self.db.execute(
                "UPDATE execution_attempts SET status = ?, updated_at = ? WHERE attempt_id = ?",
                (AttemptStatus.UNKNOWN, self._now(), attempt_id),
            )
            node_row = self._node_row(run_id, str(row["node_id"]), int(row["iteration"]))
            self.db.execute(
                "UPDATE node_executions SET status = ?, block_reason = ?, wait_reason = ?,"
                " updated_at = ? WHERE run_id = ? AND node_id = ? AND iteration = ?",
                (
                    NodeStatus.BLOCKED,
                    str(BlockReason.EFFECT_UNKNOWN),
                    str(payload.get("reason", "execution outcome unknown")),
                    self._now(),
                    run_id,
                    str(row["node_id"]),
                    int(row["iteration"]),
                ),
            )
            self._bump(run_id, status=str(GraphRunStatus.BLOCKED))
            applied.append("attempt_marked_unknown")
            return applied
        if event_type == "pf.authorization.denied":
            if node_id:
                node_row = self._node_row(run_id, node_id)
                self.db.execute(
                    "UPDATE node_executions SET status = ?, block_reason = ?, wait_reason = ?,"
                    " updated_at = ? WHERE run_id = ? AND node_id = ? AND iteration = ?",
                    (
                        NodeStatus.BLOCKED,
                        str(BlockReason.AUTHORIZATION),
                        str(payload.get("reason", "platform authorization denied")),
                        self._now(),
                        run_id,
                        node_id,
                        int(node_row["iteration"]),
                    ),
                )
            self._bump(run_id, status=str(GraphRunStatus.BLOCKED))
            applied.append("authorization_denial_recorded")
            return applied
        if event_type == "pf.run.blocked":
            budget = payload.get("budget")
            reason = str(payload.get("blockReason", "") or "")
            if reason == str(BlockReason.BUDGET) or (isinstance(budget, Mapping) and budget):
                self.db.execute(
                    "UPDATE graph_runs SET budget_state_json = ?, block_reason = ? WHERE run_id = ?",
                    (
                        dumps(
                            {
                                # The state vocabulary the budget check reads. The reported block
                                # reason is kept alongside it for the operator.
                                "state": "HARD_STOP",
                                "blockReason": str(BlockReason.BUDGET),
                                "reportedAt": self._now(),
                                "detail": dict(budget) if isinstance(budget, Mapping) else {},
                            }
                        ),
                        str(BlockReason.BUDGET),
                        run_id,
                    ),
                )
            self.db.execute(
                "UPDATE graph_runs SET status = ? WHERE run_id = ? AND status NOT IN"
                " ('COMPLETED','FAILED','CANCELLED')",
                (str(GraphRunStatus.BLOCKED), run_id),
            )
            self._bump(run_id)
            applied.append("run_blocked")
            return applied
        if event_type == "pf.effect.unknown":
            key = str(payload.get("effectKey", ""))
            record = self.effects.get(
                company_ref=str(run["company_ref"]),
                project_ref=str(run["project_ref"]),
                run_id=run_id,
                key=key,
            )
            if record is None:
                return applied
            self.effects.mark_unknown(
                company_ref=str(run["company_ref"]),
                project_ref=str(run["project_ref"]),
                run_id=run_id,
                key=key,
                reason=str(payload.get("reason", "effect outcome unknown")),
            )
            if node_id:
                node_row = self._node_row(run_id, node_id)
                self.db.execute(
                    "UPDATE node_executions SET status = ?, block_reason = ?, wait_reason = ?,"
                    " updated_at = ? WHERE run_id = ? AND node_id = ? AND iteration = ?",
                    (
                        NodeStatus.BLOCKED,
                        str(BlockReason.EFFECT_UNKNOWN),
                        f"effect {key} outcome is unknown",
                        self._now(),
                        run_id,
                        node_id,
                        int(node_row["iteration"]),
                    ),
                )
            self._bump(run_id, status=str(GraphRunStatus.BLOCKED))
            applied.append("effect_marked_unknown")
            return applied
        if event_type in ("pf.transition.committed", "pf.transition.rejected"):
            # The Core owns transitions. A bridge re-announcing one is recorded and ignored,
            # because accepting it would give the transport a second execution path.
            applied.append("recorded_without_state_change")
            return applied
        applied.append("recorded")
        return applied

    # ------------------------------------------------------------------
    # outbox
    # ------------------------------------------------------------------

    def drain_outbox(self, limit: int = 100) -> list[dict[str, Any]]:
        """Claim queued outbound intents for the bridge to deliver.

        Claiming is a compare-and-swap with a delivery-attempt counter, so a crash mid-delivery
        leaves the intent claimable again after its lease expires instead of lost or duplicated
        silently.
        """
        now = self._now()
        owner = ids.process_tag()
        candidates = self.db.query(
            "SELECT * FROM outbox_intents WHERE state IN ('QUEUED','CLAIMED')"
            " AND (next_attempt_at IS NULL OR next_attempt_at <= ?)"
            " AND (claim_expires_at IS NULL OR claim_expires_at <= ?)"
            " ORDER BY created_at, intent_id LIMIT ?",
            (now, now, max(1, int(limit))),
        )
        claimed: list[dict[str, Any]] = []
        for candidate in candidates:
            with self.db.transaction():
                updated = self.db.execute(
                    "UPDATE outbox_intents SET state = 'CLAIMED', claim_owner = ?,"
                    " claim_expires_at = ?, delivery_attempts = delivery_attempts + 1, updated_at = ?"
                    " WHERE company_ref = ? AND project_ref = ? AND intent_id = ?"
                    " AND state IN ('QUEUED','CLAIMED')"
                    " AND (claim_expires_at IS NULL OR claim_expires_at <= ?)",
                    (owner, self._later(self.lease_ttl_seconds), now, str(candidate["company_ref"]), str(candidate["project_ref"]), str(candidate["intent_id"]), now),
                )
                if updated != 1:
                    continue
                row = self.db.query_one(
                    "SELECT * FROM outbox_intents WHERE company_ref = ? AND project_ref = ?"
                    " AND intent_id = ?",
                    (str(candidate["company_ref"]), str(candidate["project_ref"]), str(candidate["intent_id"])),
                )
            if row is not None:
                claimed.append(
                    {
                        "intentId": str(row["intent_id"]),
                        "kind": str(row["kind"]),
                        "runId": row["run_id"],
                        "nodeId": row["node_id"],
                        "correlationKey": str(row["correlation_key"]),
                        "payload": loads(row["payload_json"], {}),
                        "deliveryAttempt": int(row["delivery_attempts"]),
                        "maxDeliveryAttempts": int(row["max_delivery_attempts"]),
                        "claimOwner": str(row["claim_owner"] or ""),
                    }
                )
        return claimed

    def mark_delivery(
        self,
        intent_id: str,
        state: str,
        *,
        receipt: Mapping[str, Any] | None = None,
        error: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Record the outcome of one delivery attempt.

        ``ambiguous_create`` is a first-class outcome: a create that timed out stays UNKNOWN
        and is looked up by its correlation key. It is never blindly re-sent.
        """
        allowed = ("pending", "sent", "observed", "delivered", "reconciled", "failed", "ambiguous_create")
        if state not in allowed:
            raise errors.bad_request(
                f"unknown delivery state {state!r}", known=list(allowed)
            )
        row = self.db.query_one("SELECT * FROM outbox_intents WHERE intent_id = ?", (str(intent_id),))
        if row is None:
            raise errors.not_found(f"no outbox intent {intent_id!r}", intentId=str(intent_id))
        scope = Scope(str(row["company_ref"]), str(row["project_ref"]))
        run_id = row["run_id"]
        payload = loads(row["payload_json"], {}) or {}
        now = self._now()
        with self.db.transaction():
            current = self.db.query_one(
                "SELECT * FROM outbox_intents WHERE intent_id = ?", (str(intent_id),)
            )
            assert current is not None
            if str(current["state"]) in ("delivered", "reconciled") and state in (
                "delivered",
                "reconciled",
            ):
                # Idempotent: a redelivery report of an already-delivered intent is a no-op.
                return {
                    "intentId": str(intent_id),
                    "state": str(current["state"]),
                    "deliveryAttempts": int(current["delivery_attempts"]),
                    "duplicate": True,
                }
            attempts = int(current["delivery_attempts"])
            ceiling = int(current["max_delivery_attempts"])
            blocked = state == "failed" and attempts >= ceiling
            next_state = "BLOCKED" if blocked else state
            self.db.execute(
                "UPDATE outbox_intents SET state = ?, receipt_json = COALESCE(?, receipt_json),"
                " error_json = COALESCE(?, error_json), delivered_at = CASE WHEN ? IN"
                " ('delivered','reconciled') THEN ? ELSE delivered_at END,"
                " claim_owner = NULL, claim_expires_at = NULL, next_attempt_at = ?, updated_at = ?"
                " WHERE intent_id = ?",
                (
                    next_state,
                    dumps(dict(receipt)) if receipt else None,
                    dumps(dict(error)) if error else None,
                    next_state,
                    now,
                    None if state in ("delivered", "reconciled", "failed", "ambiguous_create") else self._later(5 * attempts),
                    now,
                    str(intent_id),
                ),
            )
            effect_key = str(payload.get("effectKey", "") or "")
            effect_note = ""
            if effect_key:
                if state == "delivered" and receipt is not None:
                    self.effects.mark_effected(
                        company_ref=scope.company_ref,
                        project_ref=scope.project_ref,
                        run_id=str(run_id),
                        key=effect_key,
                        receipt=receipt,
                        result_hash=str(receipt.get("resultHash", "")) or None,
                        provider_ref=receipt.get("providerRef")
                        if isinstance(receipt.get("providerRef"), Mapping)
                        else None,
                    )
                    effect_note = "effect_confirmed_effected"
                elif state in ("failed", "ambiguous_create"):
                    self.effects.mark_unknown(
                        company_ref=scope.company_ref,
                        project_ref=scope.project_ref,
                        run_id=str(run_id),
                        key=effect_key,
                        reason=(
                            "the create timed out; the object must be looked up by its correlation "
                            "key before anything is re-sent"
                            if state == "ambiguous_create"
                            else "delivery failed without a receipt"
                        ),
                    )
                    effect_note = "effect_marked_unknown"
            if blocked and run_id:
                self._emit(
                    str(run_id),
                    "pf.run.blocked",
                    {
                        "intentId": str(intent_id),
                        "blockReason": str(BlockReason.PLATFORM),
                        "code": "OUTBOX_DELIVERY_EXHAUSTED",
                        "message": (
                            f"intent {intent_id} exhausted its {ceiling} delivery attempts; the run is "
                            "blocked for an operator rather than retried forever"
                        ),
                    },
                )
            if effect_note and run_id:
                self._emit(
                    str(run_id),
                    "pf.effect.reconciled" if effect_note == "effect_confirmed_effected" else "pf.effect.unknown",
                    {"effectKey": effect_key, "intentId": str(intent_id), "deliveryState": state},
                )
        return {
            "intentId": str(intent_id),
            "state": next_state,
            "deliveryAttempts": attempts,
            "effect": effect_note or None,
            "blocked": blocked,
        }

    # ------------------------------------------------------------------
    # health and recovery
    # ------------------------------------------------------------------

    def health(self) -> dict[str, Any]:
        """Readiness. Never reports ``ready`` when the Core cannot actually execute work."""
        from polyforge import PROTOCOL_VERSION as _PROTO
        from polyforge import SCHEMA_VERSION as _SCHEMA

        issues: list[str] = []
        database: dict[str, Any] = {"ok": True}
        store = {
            "runs": 0,
            "outboxPending": 0,
            "unknownEffects": 0,
            "registryWired": self.registry is not None,
        }
        try:
            store["runs"] = int(self.db.scalar("SELECT COUNT(*) FROM graph_runs") or 0)
            store["outboxPending"] = int(
                self.db.scalar(
                    "SELECT COUNT(*) FROM outbox_intents WHERE state IN ('QUEUED','CLAIMED')"
                )
                or 0
            )
            store["unknownEffects"] = int(
                self.db.scalar(
                    "SELECT COUNT(*) FROM effect_records WHERE status = 'UNKNOWN'"
                )
                or 0
            )
        except Exception as exc:  # noqa: BLE001 - health must describe, not raise
            database = {"ok": False, "detail": f"{type(exc).__name__}: {exc}"}
            issues.append("core database is not readable")

        bridge: dict[str, Any] = {
            "issuer": self.bridge_issuer,
            "expectedIssuer": self.bridge_expected_issuer,
            "compatible": True,
        }
        if self.bridge_issuer and self.bridge_expected_issuer:
            bridge["compatible"] = self.bridge_issuer == self.bridge_expected_issuer
            if not bridge["compatible"]:
                issues.append(
                    f"bridge issuer {self.bridge_issuer!r} does not match the expected "
                    f"{self.bridge_expected_issuer!r}; assertions are refused"
                )
        if self.registry is None:
            # Blocked, not degraded: without the registry this Core cannot resolve a published
            # version, so it can neither admit a run nor migrate one. Reporting anything
            # gentler would let an operator believe new work is starting against a version
            # nobody pinned.
            issues.append(
                "no graph registry is configured: published versions and the active default "
                "pointer cannot be resolved, so admission and migration fail closed"
            )
        if self.ports is None:
            # Reads still work, execution does not. ``read_only`` is the honest answer; a
            # ``ready`` here would let an operator believe work is dispatching.
            issues.append(
                "no bridge ports are configured: reads work, but dispatch, governance requests, and "
                "durable reconciliation are unavailable and will fail closed"
            )
        if store["unknownEffects"]:
            issues.append(
                f"{store['unknownEffects']} external effect outcome(s) are unknown and block their runs"
            )
        if store["outboxPending"]:
            issues.append(f"{store['outboxPending']} outbound intent(s) are awaiting delivery")

        if not database["ok"] or not bridge["compatible"] or self.registry is None:
            status = "blocked"
        elif self.ports is None:
            status = "read_only"
        elif store["unknownEffects"] or store["outboxPending"]:
            status = "degraded"
        else:
            status = "ready"
        return HealthReport(
            status=status,
            protocol_version=_PROTO,
            schema_version=_SCHEMA,
            compiler_version=COMPILER_VERSION,
            database=database,
            store=store,
            bridge=bridge,
            checked_at=self._now(),
            issues=issues,
        ).to_wire()

    def recover(self) -> dict[str, Any]:
        """Reconcile after a crash or a restart.

        Delegates to :mod:`polyforge.core.runtime.recovery`, which owns the rules; this method
        exists so the HTTP layer has one entry point.
        """
        from polyforge.core.runtime.recovery import recover_runtime

        return recover_runtime(self).to_wire()
