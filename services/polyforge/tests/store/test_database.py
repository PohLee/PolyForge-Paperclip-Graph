"""Durable store tests: transactions, migrations, scope-scoped uniqueness, writer lock.

These cover the storage guarantees the rest of the Runtime relies on. If a transaction is not
real, or a unique key is not scoped, every higher layer's idempotency and isolation claims are
decorative.
"""

from __future__ import annotations

import atexit
import pathlib
import tempfile
import unittest

from polyforge.core import errors, ids
from polyforge.core.store.db import Database
from polyforge.core.store.models import PF_EVENT_TYPES


def _in_memory() -> Database:
    db = Database(":memory:")
    db.migrate()
    # Closed at exit so a suite of in-memory stores does not bury a real failure under
    # resource warnings.
    atexit.register(db.close)
    return db


def _insert_run(db: Database, run_id: str, *, company: str = "c1", project: str = "p1") -> None:
    db.execute(
        "INSERT INTO graph_runs (run_id, company_ref, project_ref, family_id, work_order_id,"
        " graph_id, graph_version, definition_hash, plan_hash, dependency_lock_hash, status,"
        " state_version, event_sequence, owner_epoch, entrypoint, invocation_generation, pins_json,"
        " plan_json, input_snapshot_json, required_facts_json, root_issue_ref_json, created_at,"
        " updated_at)"
        " VALUES (?,?,?,?,?,?,1,?,?,?,'ACTIVE',1,0,1,'e.start',0,'{}','{}','{}','{}','{}',?,?)",
        (
            run_id,
            company,
            project,
            "fam",
            f"wo-{run_id}",
            "verification",
            "sha256:def",
            "sha256:plan",
            "sha256:lock",
            ids.now_iso(),
            ids.now_iso(),
        ),
    )


class MigrationTests(unittest.TestCase):
    def test_migrate_is_idempotent_and_records_a_checksum(self) -> None:
        db = Database(":memory:")
        atexit.register(db.close)
        first = db.migrate()
        second = db.migrate()
        self.assertEqual(first["applied"], ["pf.core/2"])
        self.assertEqual(second["applied"], [], "re-running migrate on a current schema is a no-op")
        state = db.schema_state()
        self.assertEqual(len(state), 1)
        self.assertTrue(state[0]["checksum"].startswith("sha256:"))

    def test_migrate_refuses_a_schema_checksum_mismatch(self) -> None:
        db = _in_memory()
        db.execute(
            "UPDATE pf_schema_meta SET checksum = ? WHERE schema_id = ?",
            ("sha256:" + "0" * 64, "pf.core/2"),
        )
        with self.assertRaises(errors.PolyForgeError) as caught:
            db.migrate()
        self.assertEqual(caught.exception.code, errors.ErrorCode.CONTRACT_INVALID)
        self.assertIn("checksum", caught.exception.message)

    def test_force_allows_a_rewritten_schema_step(self) -> None:
        db = _in_memory()
        db.execute(
            "UPDATE pf_schema_meta SET checksum = ? WHERE schema_id = ?",
            ("sha256:" + "0" * 64, "pf.core/2"),
        )
        report = db.migrate(force=True)
        self.assertEqual(report["applied"], ["pf.core/2"])

    def test_the_core_schema_carries_no_authoring_tables(self) -> None:
        """The registry is the only authority for published versions (REQ-GRAPH-02/06).

        These three tables used to sit in the Core schema while the registry wrote its own
        ``pf_registry_*`` rows, and the Runtime read the empty copy. A second definition of
        "published" is the bug, so the Core must not be able to grow one again — and the
        registry's tables are the ones that exist instead, in the same database.
        """
        db = _in_memory()
        from polyforge.core.registry.store import REQUIRED_TABLES, RegistryStore

        RegistryStore(db)
        tables = {
            str(row["name"])
            for row in db.query(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
            )
        }
        for absent in ("graph_drafts", "graph_versions", "graph_defaults"):
            self.assertNotIn(absent, tables)
        for owned in REQUIRED_TABLES:
            self.assertIn(owned, tables, msg=f"the registry owns {owned}")

    def test_every_table_declares_created_and_updated(self) -> None:
        db = _in_memory()
        tables = [
            row["name"]
            for row in db.query(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
            )
        ]
        self.assertGreaterEqual(len(tables), 20)
        for table in tables:
            columns = {row["name"] for row in db.query(f"PRAGMA table_info({table})")}
            if table == "pf_schema_meta":
                continue
            self.assertIn("created_at", columns, msg=f"{table} has no created_at")
            self.assertIn("updated_at", columns, msg=f"{table} has no updated_at")


class TransactionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.db = _in_memory()

    def test_outer_transaction_commits(self) -> None:
        with self.db.transaction() as conn:
            conn.execute(
                "INSERT INTO pf_schema_meta (schema_id, checksum, applied_at, created_at, updated_at)"
                " VALUES ('probe','c','t','t','t')"
            )
        self.assertEqual(self.db.scalar("SELECT COUNT(*) FROM pf_schema_meta WHERE schema_id='probe'"), 1)

    def test_failure_rolls_the_whole_command_back(self) -> None:
        class Crash(RuntimeError):
            pass

        with self.assertRaises(Crash):
            with self.db.transaction() as conn:
                conn.execute(
                    "INSERT INTO pf_schema_meta (schema_id, checksum, applied_at, created_at, updated_at)"
                    " VALUES ('crash','c','t','t','t')"
                )
                raise Crash("process died before commit")
        self.assertEqual(
            self.db.scalar("SELECT COUNT(*) FROM pf_schema_meta WHERE schema_id='crash'"), 0
        )

    def test_nested_transaction_uses_a_savepoint(self) -> None:
        with self.db.transaction() as conn:
            conn.execute(
                "INSERT INTO pf_schema_meta (schema_id, checksum, applied_at, created_at, updated_at)"
                " VALUES ('outer','c','t','t','t')"
            )
            try:
                with self.db.transaction() as inner:
                    inner.execute(
                        "INSERT INTO pf_schema_meta (schema_id, checksum, applied_at, created_at, updated_at)"
                        " VALUES ('inner','c','t','t','t')"
                    )
                    raise RuntimeError("inner failed")
            except RuntimeError:
                pass
        self.assertEqual(self.db.scalar("SELECT COUNT(*) FROM pf_schema_meta WHERE schema_id='outer'"), 1)
        self.assertEqual(
            self.db.scalar("SELECT COUNT(*) FROM pf_schema_meta WHERE schema_id='inner'"), 0
        )

    def test_transaction_reports_depth(self) -> None:
        self.assertFalse(self.db.in_transaction)
        with self.db.transaction():
            self.assertTrue(self.db.in_transaction)
            with self.db.transaction():
                self.assertTrue(self.db.in_transaction)
        self.assertFalse(self.db.in_transaction)


class ScopeConstraintTests(unittest.TestCase):
    """The database is the second isolation gate; these prove it holds on its own."""

    def setUp(self) -> None:
        self.db = _in_memory()

    def test_work_order_intent_is_unique_per_scope(self) -> None:
        for company, project in (("c1", "p1"), ("c2", "p1")):
            self.db.execute(
                "INSERT INTO work_orders (work_order_id, company_ref, project_ref, start_intent_id,"
                " entrypoint, graph_id, graph_version, run_id, root_issue_ref_json, input_snapshot_json,"
                " required_facts_json, request_hash, state, created_at, updated_at)"
                " VALUES (?,?,?,'intent-1','e.start','verification',1,?,'{}','{}','{}','h','ADMITTED',?,?)",
                (f"wo-{company}", company, project, f"run-{company}", ids.now_iso(), ids.now_iso()),
            )
        with self.assertRaises(Exception) as caught:
            self.db.execute(
                "INSERT INTO work_orders (work_order_id, company_ref, project_ref, start_intent_id,"
                " entrypoint, graph_id, graph_version, run_id, root_issue_ref_json, input_snapshot_json,"
                " required_facts_json, request_hash, state, created_at, updated_at)"
                " VALUES (?,?,?,'intent-1','e.start','verification',1,'run-other','{}','{}','{}','h',"
                "'ADMITTED',?,?)",
                ("wo-dup", "c1", "p1", ids.now_iso(), ids.now_iso()),
            )
        self.assertIn("UNIQUE", str(caught.exception))

    def test_graph_run_id_is_scoped_not_global(self) -> None:
        _insert_run(self.db, "run-shared", company="c1", project="p1")
        _insert_run(self.db, "run-shared", company="c2", project="p1")
        found = self.db.query(
            "SELECT company_ref FROM graph_runs WHERE run_id = 'run-shared' ORDER BY company_ref"
        )
        self.assertEqual([r["company_ref"] for r in found], ["c1", "c2"])
        with self.assertRaises(Exception):
            _insert_run(self.db, "run-shared", company="c1", project="p1")

    def test_one_active_claim_per_node_iteration(self) -> None:
        _insert_run(self.db, "run-1")
        self.db.execute(
            "INSERT INTO execution_attempts (attempt_id, company_ref, project_ref, run_id,"
            " node_id, iteration, attempt_no, transition_hash, contract_hash, status, lease_epoch,"
            " lease_state, created_at, updated_at)"
            " VALUES ('att-1','c1','p1','run-1','qa_run',0,1,'t','t','RUNNING',1,'ACTIVE',?,?)",
            (ids.now_iso(), ids.now_iso()),
        )
        with self.assertRaises(Exception) as caught:
            self.db.execute(
                "INSERT INTO execution_attempts (attempt_id, company_ref, project_ref, run_id,"
                " node_id, iteration, attempt_no, transition_hash, contract_hash, status, lease_epoch,"
                " lease_state, created_at, updated_at)"
                " VALUES ('att-2','c1','p1','run-1','qa_run',0,2,'t','t','RUNNING',2,'ACTIVE',?,?)",
                (ids.now_iso(), ids.now_iso()),
            )
        self.assertIn("UNIQUE", str(caught.exception))
        # Fencing the incumbent frees the slot: a takeover, never two concurrent owners.
        self.db.execute(
            "UPDATE execution_attempts SET lease_state = 'FENCED' WHERE attempt_id = 'att-1'"
        )
        self.db.execute(
            "INSERT INTO execution_attempts (attempt_id, company_ref, project_ref, run_id, node_id,"
            " iteration, attempt_no, transition_hash, contract_hash, status, lease_epoch, lease_state,"
            " created_at, updated_at)"
            " VALUES ('att-2','c1','p1','run-1','qa_run',0,2,'t','t','RUNNING',2,'ACTIVE',?,?)",
            (ids.now_iso(), ids.now_iso()),
        )
        active = self.db.query(
            "SELECT attempt_id FROM execution_attempts WHERE lease_state = 'ACTIVE'"
        )
        self.assertEqual([r["attempt_id"] for r in active], ["att-2"])

    def test_effect_key_is_unique_per_run(self) -> None:
        _insert_run(self.db, "run-1")
        for run_id in ("run-1", "run-2"):
            if run_id == "run-2":
                _insert_run(self.db, "run-2")
            self.db.execute(
                "INSERT INTO effect_records (effect_key, company_ref, project_ref, run_id,"
                " transition_hash, step_id, target_hash, request_hash, status, created_at, updated_at)"
                " VALUES ('sha256:eff','c1','p1',?,'t','step','sha256:target','sha256:req','PENDING',?,?)",
                (run_id, ids.now_iso(), ids.now_iso()),
            )
        with self.assertRaises(Exception):
            self.db.execute(
                "INSERT INTO effect_records (effect_key, company_ref, project_ref, run_id,"
                " transition_hash, step_id, target_hash, request_hash, status, created_at, updated_at)"
                " VALUES ('sha256:eff','c1','p1','run-1','t','step','sha256:target','sha256:req','PENDING',?,?)",
                (ids.now_iso(), ids.now_iso()),
            )

    def test_intake_dedupe_index_covers_source_scope_and_event_id(self) -> None:
        _insert_run(self.db, "run-1")
        row = (
            "evt-1",
            "c1",
            "p1",
            "run-1",
            1,
            "pf.execution.observed",
            ids.now_iso(),
            "{}",
            "bridge",
            "source-evt-9",
        )
        self.db.execute(
            "INSERT INTO domain_events (event_id, company_ref, project_ref, run_id, seq, type, at,"
            " payload_json, source, source_event_id, quarantined, created_at, updated_at)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,0,?,?)",
            row + (ids.now_iso(), ids.now_iso()),
        )
        with self.assertRaises(Exception) as caught:
            self.db.execute(
                "INSERT INTO domain_events (event_id, company_ref, project_ref, run_id, seq, type, at,"
                " payload_json, source, source_event_id, quarantined, created_at, updated_at)"
                " VALUES ('evt-2',?,?,?,2,?,?,?,'bridge','source-evt-9',0,?,?)",
                ("c1", "p1", "run-1", "pf.execution.observed", ids.now_iso(), "{}", ids.now_iso(), ids.now_iso()),
            )
        self.assertIn("UNIQUE", str(caught.exception))


class WriterLockTests(unittest.TestCase):
    def setUp(self) -> None:
        self.path = str(pathlib.Path(tempfile.mkdtemp(prefix="pf-writer-")) / "core.db")
        self.db = Database(self.path)
        self.db.migrate()

    def tearDown(self) -> None:
        self.db.close()

    def test_second_writer_is_refused_while_the_lease_is_live(self) -> None:
        lease = self.db.acquire_writer("proc-a", ttl_seconds=60)
        self.assertEqual(lease.epoch, 1)
        other = Database(self.path)
        other.migrate()
        with self.assertRaises(errors.PolyForgeError) as caught:
            other.acquire_writer("proc-b")
        self.assertEqual(caught.exception.code, errors.ErrorCode.RUN_BLOCKED)
        other.close()

    def test_expired_lease_can_be_taken_over_with_a_higher_fencing_token(self) -> None:
        first = self.db.acquire_writer("proc-a", ttl_seconds=0)
        other = Database(self.path)
        second = other.acquire_writer("proc-b", ttl_seconds=60)
        self.assertGreater(second.fencing_token, first.fencing_token)
        self.assertGreater(second.epoch, first.epoch)
        other.close()

    def test_renewal_keeps_the_fencing_token(self) -> None:
        first = self.db.acquire_writer("proc-a", ttl_seconds=60)
        renewed = self.db.acquire_writer("proc-a", ttl_seconds=60, lease=first)
        self.assertEqual(renewed.fencing_token, first.fencing_token)
        self.assertEqual(renewed.epoch, first.epoch)

    def test_release_lets_the_next_writer_take_over_immediately(self) -> None:
        lease = self.db.acquire_writer("proc-a", ttl_seconds=600)
        self.db.release_writer(lease)
        self.assertIsNone(self.db.writer_holder()["owner"] if self.db.writer_holder() else None)
        other = Database(self.path)
        other.acquire_writer("proc-b", ttl_seconds=60)
        other.close()


class ProtocolVocabularyTests(unittest.TestCase):
    def test_event_vocabulary_matches_the_published_contract(self) -> None:
        self.assertEqual(PF_EVENT_TYPES[0], "pf.work_order.accepted")
        self.assertIn("pf.transition.committed", PF_EVENT_TYPES)
        self.assertIn("pf.effect.unknown", PF_EVENT_TYPES)
        self.assertEqual(len(set(PF_EVENT_TYPES)), len(PF_EVENT_TYPES))


if __name__ == "__main__":
    unittest.main()
