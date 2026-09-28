"""Shared runtime test fixtures.

One graph, one happy path, and small helpers, so each acceptance test can state only what it
is actually asserting. The graph mirrors the verification family from
``docs/02-TECHNICAL-PLAN.md`` section 4.1: a work node, an independently reviewed node, and a
gate that needs a real human decision.

Every fixture is deterministic: a :class:`FrozenClock` is injected everywhere and no test
reads a wall clock. That is not tidiness — a run that recovers must be able to reason about
lease expiry against a clock the test controls.
"""

from __future__ import annotations

import atexit
import pathlib
import tempfile
from typing import Any, Mapping

from polyforge import COMPILER_VERSION, SCHEMA_VERSION
from polyforge.core import errors, hashing, ids
from polyforge.core.compiler.compile import CompileArtifact, compile_definition
from polyforge.core.compiler.validate import validate_definition
from polyforge.core.registry.models import GraphVersion
from polyforge.core.registry.store import RegistryStore
from polyforge.core.runtime.engine import RuntimeEngine
from polyforge.core.store.db import Database, dumps
from polyforge.core.store.models import Scope
from polyforge.graph_library import dependency_lock_for_definition

__all__ = [
    "COMPANY_A",
    "PROJECT_A",
    "SCOPE_A",
    "SCOPE_B",
    "VERIFICATION_DEFINITION",
    "VERIFICATION_POLICY_RULES",
    "HUMAN_CAPABILITY",
    "blank_engine",
    "definition",
    "digest",
    "grant_capability",
    "insert_node_row",
    "insert_run_row",
    "make_engine",
    "open_file_engine",
    "published_version",
    "work_order_request",
]

COMPANY_A = "company-a"
COMPANY_B = "company-b"
PROJECT_A = "project-a"
PROJECT_B = "project-b"

SCOPE_A = {"companyRef": COMPANY_A, "projectRef": PROJECT_A}
SCOPE_B = {"companyRef": COMPANY_B, "projectRef": PROJECT_B}

QA_NODE = "qa_run"
REVIEW_NODE = "security_review"
GATE_NODE = "review_gate"
ENTRYPOINT = "verification.start"

HUMAN_CAPABILITY = "verification.qa"


def digest(seed: str) -> str:
    """A syntactically valid content digest derived from ``seed``."""
    from polyforge.core import hashing

    return hashing.digest_text(seed)


def _rule(**overrides: Any) -> dict[str, Any]:
    rule: dict[str, Any] = {
        "ruleId": "verification.allow",
        "effect": "allow",
        "projectRef": PROJECT_A,
        "version": "1",
        "reason": "the verification workflow is authorised for this project",
    }
    rule.update(overrides)
    return rule


VERIFICATION_DEFINITION: dict[str, Any] = {
    "schemaVersion": 1,
    "graphId": "verification",
    "name": "Verification",
    "description": "QA, independent security review, and a human acceptance gate.",
    "entrypoints": {
        ENTRYPOINT: {
            "key": ENTRYPOINT,
            "inputs": ["candidate_artifacts"],
            "requiresFacts": [],
            "coordinator": {
                "requiredCapabilities": ["verification.coordinate"],
                "preferredRoles": ["qa"],
            },
            "startNodes": [QA_NODE],
            # Only what the graph actually delivers: an entry point may not promise a fact no
            # reachable node produces.
            "exports": ["qa_report", "security_review"],
        }
    },
    "nodes": {
        QA_NODE: {
            "id": QA_NODE,
            "kind": "agent_operation",
            "operation": {"id": "verification.qa", "version": 1},
            # ``inputs`` maps a slot to the *fact* it consumes; the fact is either an entry point
            # input or something an ancestor produces.
            "inputs": {"candidate_artifacts": "candidate_artifacts"},
            "produces": ["qa_report"],
            "executor": {"requiredCapabilities": ["verification.qa"]},
            "retryBudget": {"maxAttempts": 2},
        },
        REVIEW_NODE: {
            "id": REVIEW_NODE,
            "kind": "agent_operation",
            "operation": {"id": "verification.security_review", "version": 1},
            "inputs": {"qa_report": "qa_report"},
            "produces": ["security_review"],
            "executor": {
                "requiredCapabilities": ["security.review"],
                "independentFrom": ["verification.qa"],
            },
        },
        GATE_NODE: {
            "id": GATE_NODE,
            "kind": "gate",
            "inputs": {"qa_report": "qa_report", "security_review": "security_review"},
            "evaluatorRefs": [
                "contract_schema_v1",
                "required_evidence_present",
                "human_decision",
            ],
            "humanDecision": {
                "required": True,
                "semanticKind": "verification_acceptance",
                "question": "Do you accept the verification evidence for this release candidate?",
                "requiredResolver": "human_only",
                "options": [{"id": "accept", "label": "Accept"}],
            },
        },
    },
    "edges": [
        {"from": QA_NODE, "to": REVIEW_NODE},
        {"from": REVIEW_NODE, "to": GATE_NODE},
        {"from": QA_NODE, "to": GATE_NODE},
    ],
    # Contract shape: refs name governed policies; the pinned rules travel on the request.
    "policyRefs": [
        "policy.deny_precedence@1",
        "policy.independent_review_before_quality_gate@2",
        "policy.human_only_decision_for_gates@1",
    ],
}

#: The governed rules the fixture run is pinned to.
VERIFICATION_POLICY_RULES: list[dict[str, Any]] = [_rule()]


def definition(**overrides: Any) -> dict[str, Any]:
    """A fresh copy of the fixture definition, safe to mutate per test."""
    import copy

    value = copy.deepcopy(VERIFICATION_DEFINITION)
    value.update(overrides)
    return value


#: The pins the fixture graph needs beyond the library tables. The fixture graph is not a
#: library graph, so ``dependency_lock_for`` cannot derive these; the compiler refuses an
#: unpinned capability or evaluator, which is the point — a test that adds a node with a new
#: capability fails here and says which pin is missing rather than drifting on a default.
_FIXTURE_CAPABILITY_PINS: dict[str, int] = {
    "verification.qa": 1,
    "verification.coordinate": 1,
    "security.review": 1,
}
_FIXTURE_EVALUATOR_PINS: dict[str, int] = {
    "contract_schema_v1": 1,
    "required_evidence_present": 1,
    "human_decision": 1,
}


def compile_fixture(definition_value: Mapping[str, Any]) -> CompileArtifact:
    """Compile a fixture graph the way the registry's publish path requires."""
    lock = dependency_lock_for_definition(
        definition_value,
        capability_versions=_FIXTURE_CAPABILITY_PINS,
        evaluator_versions=_FIXTURE_EVALUATOR_PINS,
    )
    lock["schemaVersion"] = SCHEMA_VERSION
    lock["compilerVersion"] = COMPILER_VERSION
    return compile_definition(dict(definition_value), dependency_lock=lock)


def published_version(
    store: RegistryStore,
    definition_value: Mapping[str, Any],
    *,
    scope: Mapping[str, Any] = SCOPE_A,
    graph_id: str = "verification",
    author: str = "user-anna",
    reviewer: str = "user-bob",
    activate: bool = True,
) -> GraphVersion:
    """Publish one version through the registry's real gate chain, and activate it.

    A version is only publishable from a *reviewed* draft, so this walks the same path the
    HTTP authoring routes walk — create, validate, compile, review, publish, activate — rather
    than inserting a row behind the registry's back. The Runtime has no other legitimate way to
    obtain a published version, so a test that published by raw insert was testing a table the
    registry never wrote.
    """
    report = validate_definition(dict(definition_value))
    if not report.ok:
        raise AssertionError(
            "the fixture graph must validate before it can be published: "
            + "; ".join(str(i.message) for i in report.issues)
        )
    draft = store.create_draft(
        company_ref=scope["companyRef"],
        project_ref=scope["projectRef"],
        graph_id=graph_id,
        author=author,
        definition=definition_value,
    )
    draft = store.record_validation(draft.draft_id, report, scope=scope)
    artifact = compile_fixture(definition_value)
    draft = store.record_compile(draft.draft_id, artifact, scope=scope)
    target_hash = hashing.hash_domain(
        "pf.decision-target",
        {
            "definitionHash": report.definition_hash,
            "planHash": artifact.plan_hash,
            "compilerVersion": COMPILER_VERSION,
        },
    )
    store.record_review(
        draft.draft_id, review_target_hash=target_hash, reviewer=reviewer, scope=scope
    )
    version = store.publish_version(
        scope=scope,
        graph_id=graph_id,
        draft_id=draft.draft_id,
        author=author,
        review_target_hash=target_hash,
    )
    if activate:
        pointer = store.get_default_pointer(scope=scope, graph_id=graph_id)
        store.activate_version(
            scope=scope,
            graph_id=graph_id,
            version=int(version.version),
            expected_generation=int(pointer.generation) if pointer is not None else 0,
            actor=author,
        )
    return version


def make_engine(
    *,
    definition_override: Mapping[str, Any] | None = None,
    scope: Mapping[str, Any] | None = None,
    clock: Any | None = None,
    ports: Any | None = None,
    registry: Any | None = None,
    with_registry: bool = True,
    **engine_kwargs: Any,
) -> tuple[RuntimeEngine, Database, Any]:
    """Return ``(engine, db, clock)`` with a migrated in-memory store.

    The fixture graph's entry point requires a ``verification.coordinate`` coordinator, so a
    qualified subject is bound by default. Admission is refused without one — which is the
    point of the check, and it is why the fixture grants it rather than working around it.

    A ``RegistryStore`` over the same database is wired in by default, because that is how a
    process is built: the registry is the only authority for published versions. ``with_registry
    =False`` constructs the registry-less engine on purpose, for the fail-closed tests.
    """
    the_clock = clock if clock is not None else ids.FrozenClock()
    db = Database(":memory:", clock=the_clock)
    db.migrate()
    # Closed at interpreter exit so a suite of in-memory stores does not emit resource
    # warnings that bury a real failure.
    atexit.register(db.close)
    grant_capability(db, "user-anna", "verification.coordinate", scope=SCOPE_A)
    resolved_registry = registry
    if resolved_registry is None and with_registry:
        resolved_registry = RegistryStore(db, clock=the_clock)
    engine = RuntimeEngine(
        db, clock=the_clock, ports=ports, registry=resolved_registry, **engine_kwargs
    )
    engine.definition_override = dict(definition_override) if definition_override else None
    return engine, db, the_clock


def blank_engine(**kwargs: Any) -> tuple[RuntimeEngine, Database, Any]:
    return make_engine(**kwargs)


def open_file_engine(path: str, **kwargs: Any) -> tuple[RuntimeEngine, Database, Any]:
    """A file-backed engine, for the restart and crash tests."""
    the_clock = kwargs.pop("clock", None) or ids.FrozenClock()
    db = Database(path, clock=the_clock)
    db.migrate()
    engine = RuntimeEngine(db, clock=the_clock, **kwargs)
    return engine, db, the_clock


def temp_db_path() -> str:
    return str(pathlib.Path(tempfile.mkdtemp(prefix="pf-test-")) / "core.db")


def grant_capability(
    db: Database,
    subject: str,
    capability: str,
    *,
    scope: Mapping[str, Any] = SCOPE_A,
    revoked: bool = False,
) -> str:
    """Insert a capability binding. These rows are what the independent-review check reads."""
    binding_id = ids.new_id("binding")
    db.execute(
        "INSERT INTO capability_bindings (binding_id, company_ref, project_ref, subject_ref,"
        " provider_ref_json, capability_ref, capability_contract_version, entrypoints_json,"
        " resource_ceiling_json, review_provenance_json, revoked, created_at, updated_at)"
        " VALUES (?,?,?,?,?,?,?,'[]',NULL,NULL,?,?,?)",
        (
            binding_id,
            scope["companyRef"],
            scope["projectRef"],
            subject,
            dumps({"provider": "paperclip", "kind": "agent", "id": subject}),
            capability,
            "1",
            1 if revoked else 0,
            ids.now_iso(),
            ids.now_iso(),
        ),
    )
    return binding_id


def work_order_request(
    *,
    start_intent_id: str = "intent-verification-1",
    entrypoint: str = ENTRYPOINT,
    scope: Mapping[str, Any] = SCOPE_A,
    graph: Mapping[str, Any] | None = None,
    **overrides: Any,
) -> dict[str, Any]:
    """A well-formed ``CreateWorkOrderRequest`` for the fixture graph."""
    request: dict[str, Any] = {
        "commandId": ids.new_id("command"),
        "idempotencyKey": f"admission:{start_intent_id}:{entrypoint}",
        "correlationId": "corr-1",
        "scope": dict(scope),
        "startIntentId": start_intent_id,
        "graphId": "verification",
        "entrypoint": entrypoint,
        "rootIssueRef": {"provider": "paperclip", "kind": "issue", "id": "issue-root-1"},
        "inputSnapshot": {"candidate_artifacts": "candidate commit 41f0c9d"},
        "requiredFacts": {},
        "policyRules": [dict(rule) for rule in VERIFICATION_POLICY_RULES],
        "definition": dict(graph) if graph is not None else definition(),
    }
    request.update(overrides)
    return request


def envelope(
    *,
    run_id: str,
    node_id: str,
    attempt_id: str | None,
    lease_epoch: int | None,
    scope: Mapping[str, Any] = SCOPE_A,
    payload: Mapping[str, Any] | None = None,
    command_suffix: str = "1",
    expected_state_version: int | None = None,
    contract_hash: str | None = None,
    **overrides: Any,
) -> dict[str, Any]:
    """A mutation envelope. ``scope`` is transport-injected, not a body field."""
    value: dict[str, Any] = {
        "schemaVersion": 1,
        "commandId": f"cmd-{node_id}-{command_suffix}",
        "idempotencyKey": f"{node_id}:{command_suffix}",
        "correlationId": run_id,
        "runId": run_id,
        "nodeId": node_id,
        "attemptId": attempt_id,
        "leaseEpoch": lease_epoch,
        "scope": dict(scope),
        "payload": dict(payload or {}),
    }
    if expected_state_version is not None:
        value["expectedStateVersion"] = expected_state_version
    if contract_hash is not None:
        value["contractHash"] = contract_hash
    value.update(overrides)
    return value


def claim_request(
    *,
    run_id: str,
    node_id: str,
    subject: str,
    scope: Mapping[str, Any] = SCOPE_A,
    lease_epoch: int | None = None,
    **overrides: Any,
) -> dict[str, Any]:
    value: dict[str, Any] = {
        "scope": dict(scope),
        "runId": run_id,
        "nodeId": node_id,
        "iteration": 0,
        "agentSubject": subject,
        "agentRunRef": {"provider": "paperclip", "kind": "agent_run", "id": f"run-{subject}"},
        "issueRef": {"provider": "paperclip", "kind": "issue", "id": f"issue-{node_id}"},
        "commandId": ids.new_id("command"),
        "correlationId": run_id,
    }
    if lease_epoch is not None:
        value["leaseEpoch"] = lease_epoch
    value.update(overrides)
    return value


def artifact(kind: str, seed: str, **overrides: Any) -> dict[str, Any]:
    value: dict[str, Any] = {
        "kind": kind,
        "contentHash": digest(seed),
        "mediaType": "text/markdown",
        "size": 128,
        "source": {"kind": "attachment", "ref": f"attachment:{seed}"},
    }
    value.update(overrides)
    return value


def evidence_for(artifact_value: Mapping[str, Any], kind: str, **overrides: Any) -> dict[str, Any]:
    value: dict[str, Any] = {
        "kind": kind,
        "artifacts": [
            {
                "artifactId": f"submitted-{artifact_value['kind']}",
                "kind": artifact_value["kind"],
                "contentHash": artifact_value["contentHash"],
                "mediaType": artifact_value.get("mediaType", "text/markdown"),
                "size": artifact_value.get("size", 128),
            }
        ],
        "detail": {"note": "submitted by the worker; verified by trusted ingestion"},
    }
    value.update(overrides)
    return value


def assert_error(test: Any, code: errors.ErrorCode, callable_obj: Any, *args: Any, **kwargs: Any) -> errors.PolyForgeError:
    """Assert that ``callable_obj`` refuses with exactly ``code``."""
    with test.assertRaises(errors.PolyForgeError) as caught:
        callable_obj(*args, **kwargs)
    test.assertEqual(caught.exception.code, code, msg=caught.exception.message)
    return caught.exception


def node_state(snapshot: Mapping[str, Any], node_id: str) -> Mapping[str, Any]:
    """The *current* execution of a node: the highest iteration wins."""
    candidates = [n for n in snapshot["nodes"] if n["nodeId"] == node_id]
    if not candidates:
        raise AssertionError(f"node {node_id!r} is missing from the snapshot")
    return max(candidates, key=lambda n: int(n["iteration"]))


def insert_run_row(
    db: Database, run_id: str, *, scope: Mapping[str, Any] = SCOPE_A, now: str = ""
) -> None:
    """A minimal graph_runs row, for tests that exercise a store component directly.

    ``evidence``, ``artifacts`` and ``execution_attempts`` all carry a real foreign key to the
    run, so a component test needs one of these before it can write anything.
    """
    stamp = now or ids.now_iso()
    db.execute(
        "INSERT INTO graph_runs (run_id, company_ref, project_ref, family_id, work_order_id,"
        " graph_id, graph_version, definition_hash, plan_hash, dependency_lock_hash, status,"
        " state_version, event_sequence, owner_epoch, entrypoint, invocation_generation, pins_json,"
        " plan_json, input_snapshot_json, required_facts_json, root_issue_ref_json, created_at,"
        " updated_at) VALUES (:run_id, :company_ref, :project_ref, 'family-1', :work_order_id,"
        " 'verification', 1, 'sha256:definition', 'sha256:plan', 'sha256:lock', 'ACTIVE', 1, 0, 1,"
        " 'verification.start', 0, '{}', '{}', '{}', '{}', '{}', :now, :now)",
        {
            "run_id": run_id,
            "company_ref": scope["companyRef"],
            "project_ref": scope["projectRef"],
            "work_order_id": f"wo-{run_id}",
            "now": stamp,
        },
    )


def insert_node_row(
    db: Database,
    run_id: str,
    node_id: str,
    *,
    scope: Mapping[str, Any] = SCOPE_A,
    status: str = "RUNNING",
    iteration: int = 0,
    now: str = "",
) -> None:
    stamp = now or ids.now_iso()
    db.execute(
        "INSERT INTO node_executions (company_ref, project_ref, run_id, node_id, iteration, kind,"
        " status, plan_node_json, input_refs_json, output_refs_json, input_digest_json,"
        " output_digest, required_capabilities_json, rework_count, max_rework, created_at, updated_at)"
        " VALUES (:company_ref, :project_ref, :run_id, :node_id, :iteration, 'agent_operation',"
        " :status, '{}', '[]', '[]', '{}', :output_digest, '[]', 0, 3, :now, :now)",
        {
            "company_ref": scope["companyRef"],
            "project_ref": scope["projectRef"],
            "run_id": run_id,
            "node_id": node_id,
            "iteration": iteration,
            "status": status,
            "output_digest": f"sha256:{'0' * 64}",
            "now": stamp,
        },
    )
