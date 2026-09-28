-- PolyForge Graph Core / durable Runtime schema (schema id: pf.core/2).
--
-- Invariants this file exists to enforce:
--
--  1. Every unique constraint carries `company_ref` (and `project_ref`, or the owning
--     `run_id`). There is no identifier that is usable across two tenants: a row for
--     company A can never satisfy a lookup for company B even when the caller guesses
--     the id. The isolation check in `RuntimeEngine` is the first gate; these
--     constraints are the second, database-enforced one.
--  2. Every table has `created_at` / `updated_at`. Nothing is written without them,
--     because recovery and audit reasons about rows it cannot fully understand.
--  3. JSON payloads are stored as canonical JSON text so a stored document re-hashes to
--     the same value it had when the identity was computed.
--  4. `state_version` and `event_sequence` live on `graph_runs` and only ever move
--     forward. A rejected write never touches either.
--
-- Section 1  schema bookkeeping and the single-writer lock
-- Section 2  authoring: owned by the registry, absent here (see below)
-- Section 3  work order / run / node / contract / attempt (the execution spine)
-- Section 4  durable outputs: checkpoints, effects, artifacts, evidence, gates
-- Section 5  governance and binding tables
-- Section 6  ledger: events, outbox, command results, idempotency, diagnostics

-- ---------------------------------------------------------------------------
-- Section 1
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS pf_schema_meta (
    schema_id   TEXT PRIMARY KEY,
    checksum    TEXT NOT NULL,
    applied_at  TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

-- The single advisory writer row. Correctness does NOT come from this lock: it stops two
-- processes from fighting over the write path and gives a diagnosable owner. Correctness
-- comes from `BEGIN IMMEDIATE`, the unique constraints above, and the lease CAS in
-- `Database.acquire_writer`. A process that ignores this lock still cannot corrupt a run.
CREATE TABLE IF NOT EXISTS wf_writer_lock (
    id            INTEGER PRIMARY KEY CHECK (id = 1),
    owner         TEXT,
    epoch         INTEGER NOT NULL DEFAULT 0,
    fencing_token INTEGER NOT NULL DEFAULT 0,
    acquired_at   TEXT,
    expires_at    TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Section 2
-- ---------------------------------------------------------------------------

-- No authoring tables live here, deliberately.
--
-- Graph drafts, published versions, the active-default pointer and their audit trail are
-- written by exactly one component: `polyforge.core.registry.store.RegistryStore`, in its own
-- `pf_registry_*` tables. This file used to *also* declare `graph_drafts`, `graph_versions`
-- and `graph_defaults`, and the Runtime read them to pin a run. Nothing ever inserted into
-- those three tables, so a second authoritative definition of "what version is published"
-- existed that the registry never wrote to: admission could not find a version to pin, and the
-- commit of a migration could not find its target, so the route could only ever refuse.
--
-- The Runtime must not read the authoring tables directly, even if they were maintained:
-- two definitions of a published version means a migration can resolve a target the registry
-- never published, and a run can pin a definition it was never reviewed against. So the
-- version tables are gone rather than synchronised, and `RuntimeEngine` reaches every
-- published version through `RegistryStore.get_version` / `get_active_version` (see
-- `RuntimeEngine._resolve_version` and `_resolve_active_version`). A deployment that ran an
-- earlier build still carries the three tables; this build neither reads nor writes them, they
-- were never written by the registry, and they hold no engineering fact — an operator can
-- drop them.

-- ---------------------------------------------------------------------------
-- Section 3
-- ---------------------------------------------------------------------------

-- First admission is idempotent on scope + startIntentId + entrypoint, so replaying a
-- wakeup 100 times creates exactly one work order and one run.
CREATE TABLE IF NOT EXISTS work_orders (
    work_order_id      TEXT NOT NULL,
    company_ref        TEXT NOT NULL,
    project_ref        TEXT NOT NULL,
    start_intent_id    TEXT NOT NULL,
    entrypoint         TEXT NOT NULL,
    graph_id           TEXT NOT NULL,
    graph_version      INTEGER NOT NULL,
    run_id             TEXT NOT NULL,
    source_ref_json    TEXT,
    root_issue_ref_json TEXT NOT NULL,
    input_snapshot_json TEXT NOT NULL,
    required_facts_json TEXT NOT NULL,
    case_binding_json  TEXT,
    request_hash       TEXT NOT NULL,
    state              TEXT NOT NULL,
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL,
    created_by         TEXT,
    PRIMARY KEY (company_ref, project_ref, work_order_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_work_orders_start_intent
    ON work_orders (company_ref, project_ref, start_intent_id, entrypoint);

CREATE TABLE IF NOT EXISTS graph_runs (
    run_id               TEXT NOT NULL,
    company_ref          TEXT NOT NULL,
    project_ref          TEXT NOT NULL,
    family_id            TEXT NOT NULL,
    work_order_id        TEXT NOT NULL,
    graph_id             TEXT NOT NULL,
    graph_version        INTEGER NOT NULL,
    definition_hash      TEXT NOT NULL,
    plan_hash            TEXT NOT NULL,
    dependency_lock_hash TEXT NOT NULL,
    status               TEXT NOT NULL,
    state_version        INTEGER NOT NULL,
    event_sequence       INTEGER NOT NULL,
    owner_epoch          INTEGER NOT NULL,
    entrypoint           TEXT NOT NULL,
    parent_run_id        TEXT,
    parent_node_id       TEXT,
    invocation_generation INTEGER NOT NULL DEFAULT 0,
    pins_json            TEXT NOT NULL,
    plan_json            TEXT NOT NULL,
    input_snapshot_json  TEXT NOT NULL,
    required_facts_json  TEXT NOT NULL,
    root_issue_ref_json  TEXT NOT NULL,
    parent_issue_ref_json TEXT,
    budget_state_json    TEXT,
    block_reason         TEXT,
    block_detail_json    TEXT,
    migration_state      TEXT,
    created_at           TEXT NOT NULL,
    updated_at           TEXT NOT NULL,
    created_by           TEXT,
    PRIMARY KEY (company_ref, project_ref, run_id)
);
-- A work order admits exactly one run, and that is enforced by the unique start intent on
-- `work_orders` (plus the admission check). It is *not* re-enforced here, because a migrated
-- successor run deliberately keeps its source lineage and therefore its work order id.
CREATE INDEX IF NOT EXISTS ix_graph_runs_work_order
    ON graph_runs (company_ref, project_ref, work_order_id);
CREATE INDEX IF NOT EXISTS ix_graph_runs_family ON graph_runs (company_ref, project_ref, family_id);

CREATE TABLE IF NOT EXISTS node_executions (
    company_ref            TEXT NOT NULL,
    project_ref            TEXT NOT NULL,
    run_id                 TEXT NOT NULL,
    node_id                TEXT NOT NULL,
    iteration              INTEGER NOT NULL,
    kind                   TEXT NOT NULL,
    status                 TEXT NOT NULL,
    contract_hash          TEXT,
    contract_id            TEXT,
    plan_node_json         TEXT NOT NULL,
    input_refs_json        TEXT NOT NULL,
    output_refs_json       TEXT NOT NULL,
    input_digest_json      TEXT NOT NULL,
    output_digest          TEXT,
    active_attempt_id      TEXT,
    wait_reason            TEXT,
    block_reason           TEXT,
    required_capabilities_json TEXT NOT NULL,
    assigned_subject       TEXT,
    assigned_issue_ref_json TEXT,
    child_run_id           TEXT,
    workspace_requirement_json TEXT,
    rework_count           INTEGER NOT NULL DEFAULT 0,
    max_rework             INTEGER NOT NULL DEFAULT 3,
    created_at             TEXT NOT NULL,
    updated_at             TEXT NOT NULL,
    PRIMARY KEY (company_ref, project_ref, run_id, node_id, iteration),
    FOREIGN KEY (company_ref, project_ref, run_id)
        REFERENCES graph_runs (company_ref, project_ref, run_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ix_node_executions_run ON node_executions (run_id, status);

-- The transition contract is identified by its hash. `contract_id` is a storage handle and
-- is deliberately NOT part of the hash, so a rebuild of the same structure reuses the
-- same identity instead of forking it.
CREATE TABLE IF NOT EXISTS transition_contracts (
    contract_id            TEXT NOT NULL,
    company_ref            TEXT NOT NULL,
    project_ref            TEXT NOT NULL,
    run_id                 TEXT NOT NULL,
    node_id                TEXT NOT NULL,
    iteration              INTEGER NOT NULL,
    operation_id           TEXT NOT NULL,
    operation_version      INTEGER NOT NULL,
    subject_json           TEXT NOT NULL,
    plan_hash              TEXT NOT NULL,
    contract_hash          TEXT NOT NULL,
    contract_schema_version INTEGER NOT NULL,
    policy_json            TEXT NOT NULL,
    authority_json         TEXT NOT NULL,
    environment_json       TEXT NOT NULL,
    inputs_json            TEXT NOT NULL,
    mutations_json         TEXT NOT NULL,
    required_evidence_json TEXT NOT NULL,
    required_evaluators_json TEXT NOT NULL,
    created_at             TEXT NOT NULL,
    updated_at             TEXT NOT NULL,
    PRIMARY KEY (company_ref, project_ref, contract_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_transition_contracts_hash
    ON transition_contracts (company_ref, project_ref, run_id, contract_hash);

CREATE TABLE IF NOT EXISTS execution_attempts (
    attempt_id         TEXT NOT NULL,
    company_ref        TEXT NOT NULL,
    project_ref        TEXT NOT NULL,
    run_id             TEXT NOT NULL,
    node_id            TEXT NOT NULL,
    iteration          INTEGER NOT NULL,
    attempt_no         INTEGER NOT NULL,
    transition_hash    TEXT NOT NULL,
    contract_hash      TEXT NOT NULL,
    status             TEXT NOT NULL,
    lease_epoch        INTEGER NOT NULL,
    lease_state        TEXT NOT NULL,
    agent_subject      TEXT,
    agent_run_ref_json TEXT,
    issue_ref_json     TEXT,
    adapter_binding_json TEXT,
    started_at         TEXT,
    finished_at        TEXT,
    lease_expires_at   TEXT,
    checkpoint_ref     TEXT,
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL,
    PRIMARY KEY (company_ref, project_ref, attempt_id),
    FOREIGN KEY (company_ref, project_ref, run_id)
        REFERENCES graph_runs (company_ref, project_ref, run_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_execution_attempts_no
    ON execution_attempts (company_ref, project_ref, run_id, node_id, iteration, attempt_no);
CREATE UNIQUE INDEX IF NOT EXISTS ux_execution_attempts_transition
    ON execution_attempts (company_ref, project_ref, transition_hash, attempt_no);
-- One active claim per (run, node, iteration). This is the constraint that makes "two
-- owners => only one admitted" true even if two processes race.
CREATE UNIQUE INDEX IF NOT EXISTS ux_execution_attempts_active
    ON execution_attempts (company_ref, project_ref, run_id, node_id, iteration)
    WHERE lease_state = 'ACTIVE';
CREATE INDEX IF NOT EXISTS ix_execution_attempts_run ON execution_attempts (run_id, status);

-- ---------------------------------------------------------------------------
-- Section 4
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS graph_checkpoints (
    checkpoint_id      TEXT NOT NULL,
    company_ref        TEXT NOT NULL,
    project_ref        TEXT NOT NULL,
    run_id             TEXT NOT NULL,
    node_id            TEXT,
    attempt_id         TEXT,
    journal_sequence   INTEGER NOT NULL,
    state_version      INTEGER NOT NULL,
    schema_version     INTEGER NOT NULL,
    plan_hash          TEXT NOT NULL,
    contract_hash      TEXT,
    artifact_refs_json TEXT NOT NULL,
    effect_keys_json   TEXT NOT NULL,
    pending_governance_json TEXT NOT NULL,
    child_refs_json    TEXT NOT NULL,
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL,
    PRIMARY KEY (company_ref, project_ref, checkpoint_id),
    FOREIGN KEY (company_ref, project_ref, run_id)
        REFERENCES graph_runs (company_ref, project_ref, run_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_graph_checkpoints_seq
    ON graph_checkpoints (company_ref, project_ref, run_id, node_id, journal_sequence);

-- `effect_key` is a domain hash of (transitionHash, stepId, targetHash). It is never an
-- HTTP retry id and never an attempt number, so a retried delivery re-attaches to the
-- same row instead of creating a second external side effect.
CREATE TABLE IF NOT EXISTS effect_records (
    effect_key          TEXT NOT NULL,
    company_ref         TEXT NOT NULL,
    project_ref         TEXT NOT NULL,
    run_id              TEXT NOT NULL,
    node_id             TEXT,
    transition_hash     TEXT NOT NULL,
    step_id             TEXT NOT NULL,
    target_hash         TEXT NOT NULL,
    request_hash        TEXT NOT NULL,
    status              TEXT NOT NULL,
    provider_ref_json   TEXT,
    result_hash         TEXT,
    receipt_json        TEXT,
    authority_json      TEXT,
    prior_worker_state  TEXT,
    reconciliation_note TEXT,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    PRIMARY KEY (company_ref, project_ref, run_id, effect_key),
    FOREIGN KEY (company_ref, project_ref, run_id)
        REFERENCES graph_runs (company_ref, project_ref, run_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ix_effect_records_status ON effect_records (status, updated_at);

CREATE TABLE IF NOT EXISTS artifacts (
    artifact_id     TEXT NOT NULL,
    company_ref     TEXT NOT NULL,
    project_ref     TEXT NOT NULL,
    run_id          TEXT NOT NULL,
    node_id         TEXT NOT NULL,
    iteration       INTEGER NOT NULL,
    kind            TEXT NOT NULL,
    content_hash    TEXT NOT NULL,
    media_type      TEXT NOT NULL,
    size            INTEGER NOT NULL,
    provider_ref_json TEXT,
    source_json     TEXT,
    repository_json TEXT,
    immutable       INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    PRIMARY KEY (company_ref, project_ref, artifact_id),
    FOREIGN KEY (company_ref, project_ref, run_id)
        REFERENCES graph_runs (company_ref, project_ref, run_id) ON DELETE CASCADE
);
-- Create-or-verify: the same bytes under the same output type are one artifact no matter
-- which attempt re-registers them.
CREATE UNIQUE INDEX IF NOT EXISTS ux_artifacts_identity
    ON artifacts (company_ref, project_ref, run_id, node_id, kind, content_hash);

CREATE TABLE IF NOT EXISTS evidence (
    evidence_id     TEXT NOT NULL,
    company_ref     TEXT NOT NULL,
    project_ref     TEXT NOT NULL,
    run_id          TEXT NOT NULL,
    node_id         TEXT NOT NULL,
    iteration       INTEGER NOT NULL,
    kind            TEXT NOT NULL,
    producer_subject TEXT NOT NULL,
    producer_run_ref_json TEXT,
    artifacts_json  TEXT NOT NULL,
    artifact_digest TEXT NOT NULL,
    input_revision_bindings_json TEXT NOT NULL,
    transition_hash TEXT,
    detail_json     TEXT,
    source_revision TEXT,
    produced_at     TEXT NOT NULL,
    expires_at      TEXT,
    valid           INTEGER NOT NULL DEFAULT 1,
    invalidated_reason TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    PRIMARY KEY (company_ref, project_ref, evidence_id),
    FOREIGN KEY (company_ref, project_ref, run_id)
        REFERENCES graph_runs (company_ref, project_ref, run_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ix_evidence_run ON evidence (run_id, node_id, valid);

CREATE TABLE IF NOT EXISTS gate_evaluations (
    evaluation_id     TEXT NOT NULL,
    company_ref       TEXT NOT NULL,
    project_ref       TEXT NOT NULL,
    run_id            TEXT NOT NULL,
    node_id           TEXT NOT NULL,
    gate_id           TEXT NOT NULL,
    evaluator_ref     TEXT NOT NULL,
    evaluator_kind    TEXT NOT NULL,
    evaluator_version TEXT NOT NULL,
    transition_hash   TEXT NOT NULL,
    evidence_set_hash TEXT NOT NULL,
    evaluation_no     INTEGER NOT NULL,
    result            TEXT NOT NULL,
    reason            TEXT NOT NULL,
    mandatory         INTEGER NOT NULL DEFAULT 1,
    diagnostics_json  TEXT NOT NULL,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    PRIMARY KEY (company_ref, project_ref, evaluation_id),
    FOREIGN KEY (company_ref, project_ref, run_id)
        REFERENCES graph_runs (company_ref, project_ref, run_id) ON DELETE CASCADE
);
-- Re-evaluating the same evidence after a fix records a new numbered row instead of
-- overwriting the earlier verdict: both the failure and the fix stay auditable.
CREATE UNIQUE INDEX IF NOT EXISTS ux_gate_evaluations_repeat
    ON gate_evaluations (company_ref, project_ref, run_id, gate_id, evaluator_ref,
                         transition_hash, evidence_set_hash, evaluation_no);

-- ---------------------------------------------------------------------------
-- Section 5
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS governance_bindings (
    binding_id           TEXT NOT NULL,
    company_ref          TEXT NOT NULL,
    project_ref          TEXT NOT NULL,
    run_id               TEXT NOT NULL,
    node_id              TEXT NOT NULL,
    iteration            INTEGER NOT NULL,
    request_id           TEXT NOT NULL,
    kind                 TEXT NOT NULL,
    gate_id              TEXT,
    semantic_kind        TEXT NOT NULL,
    decision_target_hash TEXT NOT NULL,
    transition_hash      TEXT NOT NULL,
    evidence_set_hash    TEXT,
    policy_version       TEXT,
    evaluator_versions_json TEXT,
    required_responder   TEXT NOT NULL,
    interaction_creator  TEXT,
    authority_json       TEXT,
    environment_json     TEXT,
    question             TEXT,
    options_json         TEXT,
    provider_ref_json    TEXT,
    state                TEXT NOT NULL,
    expires_at           TEXT,
    resolved_at          TEXT,
    resolution_json      TEXT,
    created_at           TEXT NOT NULL,
    updated_at           TEXT NOT NULL,
    PRIMARY KEY (company_ref, project_ref, binding_id),
    FOREIGN KEY (company_ref, project_ref, run_id)
        REFERENCES graph_runs (company_ref, project_ref, run_id) ON DELETE CASCADE
);
-- One pending request per exact target: a re-evaluation cannot open a second human
-- decision for a decision that is already on the table.
CREATE UNIQUE INDEX IF NOT EXISTS ux_governance_bindings_target
    ON governance_bindings (company_ref, project_ref, run_id, semantic_kind, decision_target_hash);
CREATE UNIQUE INDEX IF NOT EXISTS ux_governance_bindings_request
    ON governance_bindings (company_ref, project_ref, run_id, request_id);

CREATE TABLE IF NOT EXISTS capability_bindings (
    binding_id                  TEXT NOT NULL,
    company_ref                 TEXT NOT NULL,
    project_ref                 TEXT NOT NULL,
    subject_ref                 TEXT NOT NULL,
    provider_ref_json           TEXT,
    capability_ref              TEXT NOT NULL,
    capability_contract_version TEXT NOT NULL,
    entrypoints_json            TEXT NOT NULL,
    resource_ceiling_json       TEXT,
    review_provenance_json      TEXT,
    revoked                     INTEGER NOT NULL DEFAULT 0,
    created_at                  TEXT NOT NULL,
    updated_at                  TEXT NOT NULL,
    PRIMARY KEY (company_ref, project_ref, binding_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_capability_bindings_subject
    ON capability_bindings (company_ref, project_ref, subject_ref, capability_ref);

CREATE TABLE IF NOT EXISTS work_bindings (
    binding_id         TEXT NOT NULL,
    company_ref        TEXT NOT NULL,
    project_ref        TEXT NOT NULL,
    run_id             TEXT NOT NULL,
    node_id            TEXT NOT NULL,
    iteration          INTEGER NOT NULL,
    issue_ref_json     TEXT,
    contract_hash      TEXT,
    workspace_ref_json TEXT,
    projection_version INTEGER NOT NULL DEFAULT 0,
    execution_owner    TEXT,
    owner_epoch        INTEGER NOT NULL DEFAULT 0,
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL,
    PRIMARY KEY (company_ref, project_ref, binding_id),
    FOREIGN KEY (company_ref, project_ref, run_id)
        REFERENCES graph_runs (company_ref, project_ref, run_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_work_bindings_node
    ON work_bindings (company_ref, project_ref, run_id, node_id, iteration);

CREATE TABLE IF NOT EXISTS child_run_links (
    link_id                TEXT NOT NULL,
    company_ref            TEXT NOT NULL,
    project_ref            TEXT NOT NULL,
    parent_run_id          TEXT NOT NULL,
    parent_node_id         TEXT NOT NULL,
    invocation_generation  INTEGER NOT NULL,
    input_hash             TEXT NOT NULL,
    child_run_id           TEXT NOT NULL,
    child_graph_id         TEXT NOT NULL,
    child_graph_version    INTEGER NOT NULL,
    export_contract_json   TEXT NOT NULL,
    state                  TEXT NOT NULL,
    created_at             TEXT NOT NULL,
    updated_at             TEXT NOT NULL,
    PRIMARY KEY (company_ref, project_ref, link_id),
    FOREIGN KEY (company_ref, project_ref, parent_run_id)
        REFERENCES graph_runs (company_ref, project_ref, run_id) ON DELETE CASCADE
);
-- A child instance is created once per invocation generation. A retry resumes the same
-- child; only an explicit rework generation creates a new one.
CREATE UNIQUE INDEX IF NOT EXISTS ux_child_run_links_invocation
    ON child_run_links (company_ref, project_ref, parent_run_id, parent_node_id, invocation_generation);

CREATE TABLE IF NOT EXISTS migration_records (
    migration_id            TEXT NOT NULL,
    company_ref             TEXT NOT NULL,
    project_ref             TEXT NOT NULL,
    source_run_id           TEXT NOT NULL,
    successor_run_id        TEXT,
    source_graph_version    INTEGER NOT NULL,
    target_graph_version    INTEGER NOT NULL,
    plan_hash               TEXT NOT NULL,
    node_mapping_json       TEXT NOT NULL,
    approval_refs_json      TEXT NOT NULL,
    checkpoint_refs_json    TEXT NOT NULL,
    cutover_epoch           INTEGER NOT NULL,
    status                  TEXT NOT NULL,
    created_at              TEXT NOT NULL,
    updated_at              TEXT NOT NULL,
    PRIMARY KEY (company_ref, project_ref, migration_id),
    FOREIGN KEY (company_ref, project_ref, source_run_id)
        REFERENCES graph_runs (company_ref, project_ref, run_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_migration_records_plan
    ON migration_records (company_ref, project_ref, source_run_id, target_graph_version, plan_hash);

-- ---------------------------------------------------------------------------
-- Section 6
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS domain_events (
    event_id        TEXT NOT NULL,
    company_ref     TEXT NOT NULL,
    project_ref     TEXT NOT NULL,
    run_id          TEXT,
    seq             INTEGER NOT NULL,
    type            TEXT NOT NULL,
    at              TEXT NOT NULL,
    payload_json    TEXT NOT NULL,
    correlation_id  TEXT,
    causation_id    TEXT,
    source          TEXT,
    source_event_id TEXT,
    source_revision TEXT,
    quarantined     INTEGER NOT NULL DEFAULT 0,
    quarantine_reason TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    PRIMARY KEY (event_id)
);
-- `seq` is per-run and monotonic, so a consumer can resume from a cursor.
CREATE UNIQUE INDEX IF NOT EXISTS ux_domain_events_seq
    ON domain_events (run_id, seq);
-- Intake dedupe: source + scope + sourceEventId. A replayed observation is a no-op.
CREATE UNIQUE INDEX IF NOT EXISTS ux_domain_events_source
    ON domain_events (source, company_ref, project_ref, source_event_id)
    WHERE source_event_id IS NOT NULL;

-- The outbox is written in the same transaction as the semantic change, so an intent
-- cannot exist without its fact and a fact cannot exist without its intent.
CREATE TABLE IF NOT EXISTS outbox_intents (
    intent_id             TEXT NOT NULL,
    company_ref           TEXT NOT NULL,
    project_ref           TEXT NOT NULL,
    run_id                TEXT,
    node_id               TEXT,
    kind                  TEXT NOT NULL,
    correlation_key       TEXT NOT NULL,
    payload_json          TEXT NOT NULL,
    state                 TEXT NOT NULL,
    delivery_attempts     INTEGER NOT NULL DEFAULT 0,
    max_delivery_attempts INTEGER NOT NULL DEFAULT 8,
    claim_owner           TEXT,
    claim_expires_at      TEXT,
    next_attempt_at       TEXT,
    receipt_json          TEXT,
    error_json            TEXT,
    delivered_at          TEXT,
    created_at            TEXT NOT NULL,
    updated_at            TEXT NOT NULL,
    PRIMARY KEY (company_ref, project_ref, intent_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_outbox_intents_correlation
    ON outbox_intents (company_ref, project_ref, correlation_key);
CREATE INDEX IF NOT EXISTS ix_outbox_intents_state ON outbox_intents (state, next_attempt_at);

CREATE TABLE IF NOT EXISTS command_results (
    company_ref     TEXT NOT NULL,
    project_ref     TEXT NOT NULL,
    command_id      TEXT NOT NULL,
    run_id          TEXT,
    idempotency_key TEXT NOT NULL,
    payload_hash    TEXT NOT NULL,
    result_json     TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    PRIMARY KEY (company_ref, project_ref, command_id),
    FOREIGN KEY (company_ref, project_ref, run_id)
        REFERENCES graph_runs (company_ref, project_ref, run_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_command_results_idempotency
    ON command_results (company_ref, project_ref, idempotency_key);

-- One row per logical operation identity, separate from the HTTP command id, so two
-- different commands that mean the same thing still collide.
CREATE TABLE IF NOT EXISTS idempotency_keys (
    company_ref     TEXT NOT NULL,
    project_ref     TEXT NOT NULL,
    scope_key       TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    payload_hash    TEXT NOT NULL,
    command_id      TEXT,
    result_ref      TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    PRIMARY KEY (company_ref, project_ref, scope_key, idempotency_key)
);

-- Isolated diagnostics for writes the Core refused (stale lease, out-of-order revision,
-- rejected evidence candidate). Append-only: nothing here is read back as state, and no
-- row here can advance a run.
CREATE TABLE IF NOT EXISTS rejected_writes (
    rejection_id     TEXT NOT NULL PRIMARY KEY,
    company_ref      TEXT NOT NULL,
    project_ref      TEXT NOT NULL,
    run_id           TEXT,
    node_id          TEXT,
    attempt_id       TEXT,
    presented_epoch  INTEGER,
    active_epoch     INTEGER,
    command_id       TEXT,
    idempotency_key  TEXT,
    kind             TEXT NOT NULL,
    code             TEXT NOT NULL,
    reason           TEXT NOT NULL,
    payload_json     TEXT NOT NULL,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_rejected_writes_run ON rejected_writes (run_id, created_at);
