"""Draft lifecycle tests: revision compare-and-swap and derived-state invalidation.

AT-17: concurrent draft updates must conflict, and validation, compile and review must be
bound to the exact revision they were produced for.
"""

from __future__ import annotations

import copy
import unittest

from polyforge.core.compiler.validate import validate_definition
from polyforge.core.errors import ErrorCode, PolyForgeError
from polyforge.core.ids import FrozenClock
from polyforge.core.registry.store import REQUIRED_TABLES, RegistryStore
from polyforge.graph_library import load_graph
from services.polyforge.tests.registry.fake_db import close, core_database, memory_database
from services.polyforge.tests.registry.fixtures import (
    OTHER_SCOPE,
    SCOPE,
    StoreTestCase,
    new_store,
    reviewed_draft,
)


class StorePlumbingTest(StoreTestCase):
    """The seam: an in-memory database is enough, in every supported shape."""

    def test_required_tables_exist(self):
        for table in REQUIRED_TABLES:
            with self.subTest(table=table):
                count = self.store._sql.query_one(f"SELECT COUNT(*) AS n FROM {table}")  # noqa: SLF001
                self.assertEqual(int(count["n"]), 0)

    def test_connection_shape(self):
        database = memory_database("connection")
        self.addCleanup(close, database)
        store = new_store(database)
        draft = store.create_draft(company_ref="co_a", project_ref="pr_a", graph_id="design", author="eng:a")
        self.assertEqual(draft.revision, 1)
        self.assertEqual(
            store.get_draft(draft.draft_id, scope={"companyRef": "co_a", "projectRef": "pr_a"}).draft_id,
            draft.draft_id,
        )

    def test_execute_only_shape(self):
        database = memory_database("execute-only")
        self.addCleanup(close, database)
        store = new_store(database)
        draft = store.create_draft(company_ref="co_a", project_ref="pr_a", graph_id="design", author="eng:a")
        saved = store.save_draft(
            draft.draft_id, definition=load_graph("design"), author="eng:b", expected_revision=1
        )
        self.assertEqual(saved.revision, 2)

    def test_the_whole_suite_also_runs_on_a_double_when_the_core_database_is_absent(self):
        database = core_database()
        self.addCleanup(close, database)
        if database is None:
            fallback = memory_database("connection")
            self.addCleanup(close, fallback)
            self.assertIsInstance(new_store(fallback), RegistryStore)

    def test_lazy_database_construction(self):
        if core_database.__module__ and _core_database_importable():
            self.assertIsInstance(RegistryStore(None), RegistryStore)
        else:
            with self.assertRaises(PolyForgeError) as caught:
                RegistryStore(None)
            self.assertEqual(caught.exception.code, ErrorCode.UNSUPPORTED)

    def test_an_unusable_database_object_is_refused(self):
        with self.assertRaises(PolyForgeError) as caught:
            RegistryStore(object())
        self.assertEqual(caught.exception.code, ErrorCode.UNSUPPORTED)

    def test_clock_is_injectable(self):
        database = memory_database()
        self.addCleanup(close, database)
        store = new_store(database, clock=FrozenClock("2026-02-01T09:00:00.000Z"))
        draft = store.create_draft(company_ref="co_a", project_ref="pr_a", graph_id="design", author="eng:a")
        self.assertEqual(draft.created_at, "2026-02-01T09:00:00.000Z")


def _core_database_importable() -> bool:
    try:
        import polyforge.core.store.db  # noqa: F401
    except Exception:
        return False
    return True


class DraftRevisionTest(StoreTestCase):
    """AT-17: optimistic concurrency on the draft revision."""

    def setUp(self):
        super().setUp()
        self.definition = load_graph("design")
        self.draft = self.store.create_draft(
            company_ref=SCOPE["companyRef"],
            project_ref=SCOPE["projectRef"],
            graph_id="design",
            author="eng:dana",
            definition=self.definition,
        )

    def test_a_fresh_draft_starts_at_revision_one(self):
        self.assertEqual(self.draft.revision, 1)
        self.assertIsNone(self.draft.base_version)
        self.assertEqual(self.draft.summary()["revision"], 1)

    def test_a_successful_save_bumps_the_revision(self):
        edited = copy.deepcopy(self.definition)
        edited["nodes"]["architecture"]["timeoutSeconds"] = 9000
        saved = self.store.save_draft(
            self.draft.draft_id, definition=edited, author="eng:dana", expected_revision=1
        )
        self.assertEqual(saved.revision, 2)
        self.assertNotEqual(saved.definition_hash, self.draft.definition_hash)

    def test_two_concurrent_writers_produce_one_conflict(self):
        first = copy.deepcopy(self.definition)
        first["name"] = "Design A"
        second = copy.deepcopy(self.definition)
        second["name"] = "Design B"
        self.store.save_draft(self.draft.draft_id, definition=first, author="eng:a", expected_revision=1)
        with self.assertRaises(PolyForgeError) as caught:
            self.store.save_draft(self.draft.draft_id, definition=second, author="eng:b", expected_revision=1)
        self.assertEqual(caught.exception.code, ErrorCode.VERSION_CONFLICT)
        self.assertEqual(caught.exception.status, 409)
        self.assertEqual(caught.exception.details["currentVersion"], 2)
        # The losing write left nothing behind.
        self.assertEqual(self.store.get_draft(self.draft.draft_id).definition["name"], "Design A")

    def test_a_draft_may_not_change_its_graph_id(self):
        moved = copy.deepcopy(self.definition)
        moved["graphId"] = "design_v2"
        with self.assertRaises(PolyForgeError) as caught:
            self.store.save_draft(self.draft.draft_id, definition=moved, author="eng:a", expected_revision=1)
        self.assertEqual(caught.exception.code, ErrorCode.CONTRACT_INVALID)

    def test_delete_then_get_is_not_found(self):
        self.store.delete_draft(self.draft.draft_id, scope=SCOPE)
        with self.assertRaises(PolyForgeError) as caught:
            self.store.get_draft(self.draft.draft_id, scope=SCOPE)
        self.assertEqual(caught.exception.code, ErrorCode.NOT_FOUND)

    def test_a_draft_record_round_trips(self):
        stored = self.store.get_draft(self.draft.draft_id, scope=SCOPE)
        from polyforge.core.registry.models import GraphDraft

        self.assertEqual(GraphDraft.from_dict(stored.to_dict()).to_dict(), stored.to_dict())


class DerivedStateBindingTest(StoreTestCase):
    """AT-17: editing a draft invalidates its validation, compile and review."""

    def setUp(self):
        super().setUp()
        self.definition = load_graph("requirement")
        self.prepared = reviewed_draft(self.store, self.definition)
        self.draft_id = self.prepared["draft"].draft_id

    def test_a_reviewed_draft_carries_all_three_references(self):
        draft = self.prepared["draft"]
        self.assertIsNotNone(draft.validation_ref)
        self.assertIsNotNone(draft.compile_ref)
        self.assertIsNotNone(draft.review_target_hash)
        self.assertEqual(draft.validation_revision, draft.revision)
        self.assertEqual(draft.compile_revision, draft.revision)
        self.assertEqual(draft.review_revision, draft.revision)

    def test_saving_clears_validation_compile_and_review(self):
        edited = copy.deepcopy(self.definition)
        edited["nodes"]["clarify"]["timeoutSeconds"] = 60
        saved = self.store.save_draft(
            self.draft_id, definition=edited, author="eng:dana", expected_revision=1
        )
        self.assertIsNone(saved.validation_ref)
        self.assertIsNone(saved.validation_ok)
        self.assertIsNone(saved.compile_ref)
        self.assertIsNone(saved.review_target_hash)
        self.assertIsNone(saved.review_revision)
        self.assertEqual(saved.authorization_refs, [])

    def test_a_report_for_an_older_revision_is_refused(self):
        stale = self.prepared["report"].to_dict()
        stale["revision"] = 0
        with self.assertRaises(PolyForgeError) as caught:
            self.store.record_validation(self.draft_id, stale)
        self.assertEqual(caught.exception.code, ErrorCode.VERSION_CONFLICT)
        self.assertEqual(caught.exception.details["currentVersion"], 1)

    def test_a_report_for_another_definition_is_refused(self):
        other = validate_definition(load_graph("release"))
        with self.assertRaises(PolyForgeError) as caught:
            self.store.record_validation(self.draft_id, other)
        self.assertEqual(caught.exception.code, ErrorCode.VERSION_CONFLICT)

    def test_a_failing_report_is_recorded_but_is_not_ok(self):
        broken = copy.deepcopy(self.definition)
        del broken["entrypoints"]
        draft = self.store.create_draft(
            company_ref=SCOPE["companyRef"],
            project_ref=SCOPE["projectRef"],
            graph_id="broken",
            author="eng:dana",
            definition=broken,
        )
        recorded = self.store.record_validation(draft.draft_id, validate_definition(broken))
        self.assertFalse(recorded.validation_ok)
        self.assertIsNotNone(recorded.validation_ref)

    def test_re_validation_after_an_edit_binds_to_the_new_revision(self):
        edited = copy.deepcopy(self.definition)
        edited["name"] = "Requirement (revised)"
        saved = self.store.save_draft(
            self.draft_id, definition=edited, author="eng:dana", expected_revision=1
        )
        report = validate_definition(edited)
        rebound = self.store.record_validation(saved.draft_id, report)
        self.assertEqual(rebound.validation_revision, 2)
        self.assertEqual(rebound.definition_hash, report.definition_hash)

    def test_the_recorded_validation_and_compile_are_retrievable(self):
        self.assertTrue(self.store.get_validation(self.draft_id)["ok"])
        self.assertEqual(
            self.store.get_compile(self.draft_id)["planHash"], self.prepared["artifact"].plan_hash
        )


class DraftScopeTest(StoreTestCase):
    """A read across a scope is denied; a write across a scope is invisible."""

    def setUp(self):
        super().setUp()
        self.draft = self.store.create_draft(
            company_ref=SCOPE["companyRef"],
            project_ref=SCOPE["projectRef"],
            graph_id="design",
            author="eng:dana",
        )

    def test_cross_scope_read_is_denied_not_hidden(self):
        with self.assertRaises(PolyForgeError) as caught:
            self.store.get_draft(self.draft.draft_id, scope=OTHER_SCOPE)
        self.assertEqual(caught.exception.code, ErrorCode.SCOPE_VIOLATION)
        self.assertEqual(caught.exception.status, 403)

    def test_cross_scope_write_reports_not_found(self):
        with self.assertRaises(PolyForgeError) as caught:
            self.store.delete_draft(self.draft.draft_id, scope=OTHER_SCOPE)
        self.assertEqual(caught.exception.code, ErrorCode.NOT_FOUND)
        self.assertEqual(caught.exception.status, 404)

    def test_cross_scope_list_is_empty_rather_than_denied(self):
        self.assertEqual(self.store.list_drafts("design", scope=OTHER_SCOPE), [])
        self.assertEqual(len(self.store.list_drafts("design", scope=SCOPE)), 1)

    def test_a_read_needs_no_scope_only_for_trusted_internal_use(self):
        self.assertEqual(self.store.get_draft(self.draft.draft_id).draft_id, self.draft.draft_id)

    def test_an_invalid_scope_is_a_bad_request(self):
        with self.assertRaises(PolyForgeError) as caught:
            self.store.get_draft(self.draft.draft_id, scope={"companyRef": "co_alpha"})
        self.assertEqual(caught.exception.code, ErrorCode.BAD_REQUEST)

    def test_a_version_in_another_scope_is_not_found(self):
        with self.assertRaises(PolyForgeError) as caught:
            self.store.get_version("design", 1, scope=OTHER_SCOPE)
        self.assertEqual(caught.exception.code, ErrorCode.NOT_FOUND)

    def test_saving_a_validation_for_another_scope_is_not_found(self):
        with self.assertRaises(PolyForgeError) as caught:
            self.store.record_validation(self.draft.draft_id, validate_definition(load_graph("design")), scope=OTHER_SCOPE)
        self.assertEqual(caught.exception.code, ErrorCode.NOT_FOUND)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
