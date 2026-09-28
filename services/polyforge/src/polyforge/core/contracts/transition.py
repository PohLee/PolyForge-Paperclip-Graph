"""The transition contract: what a worker is being asked to change, and under what terms.

Responsibility: build the immutable, hash-identified statement of one engineering state
change, so that everything downstream (a claim, an effect, an approval, a governance
request) can bind to *this exact* change and nothing else.

Invariants (``docs/05-PROTOCOL.md`` sections 2 and 5):

* The contract binds run-independent structure plus the node and iteration it applies to.
  Two structurally identical contracts hash identically; changing any bound field changes
  the hash. That is the whole point — a "same" transition has to be recognizable as the
  same one across a retry, a process restart, and a bridge reconnection.
* Mutable status, wait/block reasons, timestamps and the storage handle ``contract_id`` are
  excluded from the hash. A contract that changed its hash every time a row was touched
  would make idempotency impossible.
* Secrets are referenced, never embedded: the contract carries authority *refs* and input
  digests, not credentials.

``decision_target_hash`` lives here because a human decision is fundamentally about a
transition: it is the hash of the exact thing a human is being asked to approve. If the
artifact, authority, environment or evaluator set changes afterwards, the recorded answer
no longer applies — which is the mechanism that implements "a stale approval does not
apply".
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Any, Mapping, Sequence

from polyforge import SCHEMA_VERSION
from polyforge.core import errors, hashing
from polyforge.core.contracts.policy import EffectivePolicy
from polyforge.core.state import EvaluatorKind

__all__ = [
    "CONTRACT_SCHEMA_VERSION",
    "CONTRACT_HASH_DOMAIN",
    "DECISION_TARGET_HASH_DOMAIN",
    "RequiredEvaluator",
    "TransitionContract",
    "build_contract",
    "contract_hash",
    "decision_target_hash",
]

#: Bumped when the *meaning* of the contract changes. The schema version travels inside the
#: hashed payload, so an old identity is never silently reinterpreted under new rules.
CONTRACT_SCHEMA_VERSION = 1

CONTRACT_HASH_DOMAIN = "pf.contract"
DECISION_TARGET_HASH_DOMAIN = "pf.decision-target"

# Never hashed: wall-clock keys are stripped by ``hashing``; these are the status-shaped
# keys a caller may legitimately include in a nested block.
_MUTABLE_KEYS = frozenset({"status", "state", "waitReason", "blockReason", "reason"})


@dataclass(frozen=True)
class RequiredEvaluator:
    """One evaluator the contract obliges the transition to satisfy."""

    ref: str
    kind: str
    version: str
    mandatory: bool = True

    def to_wire(self) -> dict[str, Any]:
        return {
            "ref": self.ref,
            "kind": str(self.kind),
            "version": self.version,
            "mandatory": self.mandatory,
        }

    @staticmethod
    def from_wire(value: "Mapping[str, Any] | RequiredEvaluator") -> "RequiredEvaluator":
        if isinstance(value, RequiredEvaluator):
            return value
        kind = str(value.get("kind", EvaluatorKind.AUTOMATIC))
        try:
            EvaluatorKind(kind)
        except ValueError as exc:
            raise errors.contract_invalid(
                f"evaluator {value.get('ref')!r} declares unknown kind {kind!r}"
            ) from exc
        return RequiredEvaluator(
            ref=str(value.get("ref", "")),
            kind=kind,
            version=str(value.get("version", "1")),
            mandatory=bool(value.get("mandatory", True)),
        )


@dataclass(frozen=True)
class TransitionContract:
    """The immutable statement of one constrained engineering state change."""

    node_id: str
    iteration: int
    operation_id: str
    operation_version: int
    subject: dict[str, Any]
    inputs: dict[str, str]
    effective_policy: EffectivePolicy
    authority: dict[str, Any]
    environment: dict[str, Any]
    intended_mutations: list[dict[str, Any]]
    required_evidence_kinds: list[str]
    required_evaluators: list[RequiredEvaluator]
    plan_hash: str = ""
    graph_id: str = ""
    graph_version: int = 0
    definition_hash: str = ""
    dependency_lock_hash: str = ""
    compiler_version: str = ""
    contract_schema_version: int = CONTRACT_SCHEMA_VERSION
    schema_version: int = SCHEMA_VERSION
    contract_id: str = ""
    created_at: str = ""
    updated_at: str = ""

    def to_canonical(self) -> dict[str, Any]:
        """The payload the identity hash is taken over. Volatile fields never appear here."""
        return {
            "schemaVersion": self.schema_version,
            "contractSchemaVersion": self.contract_schema_version,
            "nodeId": self.node_id,
            "iteration": self.iteration,
            "operation": {"id": self.operation_id, "version": self.operation_version},
            "subject": self.subject,
            "inputs": self.inputs,
            "effectivePolicy": self.effective_policy.to_wire(),
            "authority": self.authority,
            "environment": self.environment,
            "intendedMutations": self.intended_mutations,
            "requiredEvidenceKinds": self.required_evidence_kinds,
            "requiredEvaluators": [e.to_wire() for e in self.required_evaluators],
            "planHash": self.plan_hash,
            "graphId": self.graph_id,
            "graphVersion": self.graph_version,
            "definitionHash": self.definition_hash,
            "dependencyLockHash": self.dependency_lock_hash,
            "compilerVersion": self.compiler_version,
        }

    def to_wire(self) -> dict[str, Any]:
        wire = self.to_canonical()
        wire["contractId"] = self.contract_id
        wire["contractHash"] = self.hash
        wire["createdAt"] = self.created_at
        wire["updatedAt"] = self.updated_at
        return wire

    @property
    def hash(self) -> str:
        return contract_hash(self)

    def mandatory_evaluators(self) -> list[RequiredEvaluator]:
        return [e for e in self.required_evaluators if e.mandatory]

    def optional_evaluators(self) -> list[RequiredEvaluator]:
        return [e for e in self.required_evaluators if not e.mandatory]

    @staticmethod
    def from_wire(value: Mapping[str, Any]) -> "TransitionContract":
        return TransitionContract(
            node_id=str(value.get("nodeId", "")),
            iteration=int(value.get("iteration", 0)),
            operation_id=str((value.get("operation") or {}).get("id", "")),
            operation_version=int((value.get("operation") or {}).get("version", 1)),
            subject=dict(value.get("subject") or {}),
            inputs=dict(value.get("inputs") or {}),
            effective_policy=EffectivePolicy.from_wire(value.get("effectivePolicy") or {}),
            authority=dict(value.get("authority") or {}),
            environment=dict(value.get("environment") or {}),
            intended_mutations=[dict(m) for m in (value.get("intendedMutations") or ())],
            required_evidence_kinds=[str(k) for k in (value.get("requiredEvidenceKinds") or ())],
            required_evaluators=[
                RequiredEvaluator.from_wire(e) for e in (value.get("requiredEvaluators") or ())
            ],
            plan_hash=str(value.get("planHash", "")),
            graph_id=str(value.get("graphId", "")),
            graph_version=int(value.get("graphVersion", 0)),
            definition_hash=str(value.get("definitionHash", "")),
            dependency_lock_hash=str(value.get("dependencyLockHash", "")),
            compiler_version=str(value.get("compilerVersion", "")),
            contract_schema_version=int(
                value.get("contractSchemaVersion", CONTRACT_SCHEMA_VERSION)
            ),
            schema_version=int(value.get("schemaVersion", SCHEMA_VERSION)),
            contract_id=str(value.get("contractId", "")),
            created_at=str(value.get("createdAt", "")),
            updated_at=str(value.get("updatedAt", "")),
        )

    def with_storage(self, *, contract_id: str, created_at: str, updated_at: str) -> "TransitionContract":
        """Attach storage bookkeeping without changing the identity."""
        return replace(self, contract_id=contract_id, created_at=created_at, updated_at=updated_at)


def contract_hash(contract: TransitionContract) -> str:
    """Return the domain-separated identity of ``contract``.

    ``strip_for_hash`` is applied to the canonical payload rather than to a subset of
    fields, so a volatile key that reaches the payload by accident still cannot fork an
    identity.
    """
    payload = hashing.strip_for_hash(contract.to_canonical(), extra_mutable_keys=_MUTABLE_KEYS)
    return hashing.hash_domain(CONTRACT_HASH_DOMAIN, payload)


def build_contract(
    *,
    run: Mapping[str, Any],
    node: Mapping[str, Any],
    policy: EffectivePolicy | Mapping[str, Any],
    inputs: Mapping[str, str] | None = None,
    subject: Mapping[str, Any] | None = None,
    operation: Mapping[str, Any] | None = None,
    authority: Mapping[str, Any] | None = None,
    environment: Mapping[str, Any] | None = None,
    mutations: Sequence[Mapping[str, Any]] = (),
    required_evidence_kinds: Sequence[str] = (),
    required_evaluators: Sequence[Mapping[str, Any] | RequiredEvaluator] = (),
    plan: Mapping[str, Any] | None = None,
    node_plan: Mapping[str, Any] | None = None,
    contract_id: str = "",
    created_at: str = "",
    updated_at: str = "",
) -> TransitionContract:
    """Assemble a contract from the run row, the planned node, and the resolved policy.

    Raises ``CONTRACT_INVALID`` rather than defaulting: a contract with an invented
    operation id or an empty policy would be a hash that looks legitimate and is not.
    """
    if not run.get("run_id"):
        raise errors.contract_invalid("a transition contract needs a run id")
    if not node.get("node_id"):
        raise errors.contract_invalid("a transition contract needs a node id")

    plan_node = dict(node_plan or node)
    resolved_policy = (
        policy
        if isinstance(policy, EffectivePolicy)
        else EffectivePolicy.from_wire(policy if isinstance(policy, Mapping) else {})
    )
    if not isinstance(resolved_policy, EffectivePolicy):  # pragma: no cover - defensive
        raise errors.contract_invalid("effective policy is not resolvable")

    op = dict(operation or plan_node.get("operation") or {})
    operation_id = str(op.get("id") or "")
    if not operation_id:
        # A deterministic or gate node has no agent operation of its own. Give it a stable
        # synthetic identity rather than leaving the field empty, so the hash still names
        # exactly one thing.
        operation_id = f"node.{node['node_id']}"
    operation_version = int(op.get("version", 1))

    evaluators = [RequiredEvaluator.from_wire(e) for e in (required_evaluators or ())]
    if not evaluators:
        raise errors.contract_invalid(
            f"node {node['node_id']!r} has a contract with no required evaluator; a transition "
            "with nothing to satisfy is how a node reaches PASSED without evidence"
        )

    iteration = int(node.get("iteration", 0))
    graph_version = int(run.get("graph_version", 0))
    return TransitionContract(
        node_id=str(node["node_id"]),
        iteration=iteration,
        operation_id=operation_id,
        operation_version=operation_version,
        subject=dict(subject or {}),
        inputs={str(k): str(v) for k, v in (inputs or {}).items()},
        effective_policy=resolved_policy,
        authority=dict(authority or {}),
        environment=dict(environment or {}),
        intended_mutations=[dict(m) for m in mutations],
        required_evidence_kinds=[str(k) for k in required_evidence_kinds],
        required_evaluators=evaluators,
        plan_hash=str((plan or {}).get("plan_hash") or run.get("plan_hash") or ""),
        graph_id=str(run.get("graph_id", "")),
        graph_version=graph_version,
        definition_hash=str(run.get("definition_hash", "")),
        dependency_lock_hash=str(run.get("dependency_lock_hash", "")),
        compiler_version=str((plan or {}).get("compiler_version") or run.get("compiler_version") or ""),
        contract_id=contract_id,
        created_at=created_at,
        updated_at=updated_at,
    )


def decision_target_hash(
    *,
    gate_id: str,
    semantic_kind: str,
    transition_hash: str,
    input_digests: Mapping[str, str] | None = None,
    output_digests: Mapping[str, str] | None = None,
    policy_hash: str = "",
    evaluator_versions: Mapping[str, str] | None = None,
    options: Sequence[Any] = (),
    authority: Mapping[str, Any] | None = None,
    environment: Mapping[str, Any] | None = None,
) -> str:
    """Bind the exact target a human is being asked to decide about.

    Everything the answer would mean is inside the hash: which gate, which transition, the
    input and output bytes, the policy and evaluator versions in force, the options on the
    table, and the authority and environment the decision would exercise. A resolution whose
    target hash no longer matches is not evidence about the current state.
    """
    payload = {
        "gateId": gate_id,
        "semanticKind": semantic_kind,
        "transitionHash": transition_hash,
        "inputDigests": {str(k): str(v) for k, v in (input_digests or {}).items()},
        "outputDigests": {str(k): str(v) for k, v in (output_digests or {}).items()},
        "policyHash": policy_hash,
        "evaluatorVersions": {str(k): str(v) for k, v in (evaluator_versions or {}).items()},
        "options": [o if isinstance(o, (Mapping, str, int, float, bool)) else str(o) for o in options],
        "authority": dict(authority or {}),
        "environment": dict(environment or {}),
    }
    return hashing.hash_domain(DECISION_TARGET_HASH_DOMAIN, hashing.strip_for_hash(payload))
