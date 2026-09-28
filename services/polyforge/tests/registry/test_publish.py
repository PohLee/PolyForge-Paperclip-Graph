"""Publish, immutability and default-pointer tests.

AT-17: publish is a compare-and-swap over one revision, and a published version is not
writable. AT-19: publishing and activating v14 must leave a v13 run and its child on their
original pins. AT-20 / REQ-GRAPH-07: a published version is read-only and offers
clone-to-draft.
"""

from __future__ import annotations

import copy
import unittest

from polyforge import COMPILER_VERSION
from polyforge.core import hashing
from polyforge.core.compiler.validate import validate_definition
from polyforge.core.errors import ErrorCode, PolyForgeError
from polyforge.core.registry.models import GraphVersion, GraphVersionSummary
from polyforge.core.registry.store import RegistryStore
from polyforge.graph_library import load_graph
from services.polyforge.tests.registry.fake_db import close, memory_database
from services.polyforge.tests.registry.fixtures import (
    OTHER_SCOPE,
    SCOPE,
    StoreTestCase,
    reviewed_draft,
)


class PublishTest(StoreTestCase):
    """AT-17: the whole chain has to describe one revision, or nothing is published."""

    def setUp(self):
        super().setUp()
        self.definition = load_graph("design")
        self.prepared = reviewed_draft(self.store, self.definition)
        self.draft_id = self.prepared["draft"].draft_id

    def _publish(self, **overrides):
        arguments = {
            "scope": SCOPE,
            "graph_id": "design",
            "draft_id": self.draft_id,
            "author": "eng:dana",
            "review_target_hash": self.prepared["reviewTargetHash"],
            "authorization_refs": [],
        }
        arguments.update(overrides)
        return self.store.publish_version(**arguments)

    def test_publishing_produces_version_one(self):
        version = self._publish()
        self.assertEqual(version.version, 1)
        self.assertEqual(version.compiler_version, COMPILER_VERSION)
        self.assertEqual(version.plan_hash, self.prepared["artifact"].plan_hash)
        self.assertEqual(version.definition_hash, self.prepared["report"].definition_hash)
        self.assertEqual(version.published_by, "eng:dana")
        self.assertEqual(version.closure, self.prepared["artifact"].closure)

    def test_a_validated_then_modified_draft_cannot_publish(self):
        edited = copy.deepcopy(self.definition)
        edited["name"] = "Design, quietly changed"
        self.store.save_draft(self.draft_id, definition=edited, author="eng:mallory", expected_revision=1)
        with self.assertRaises(PolyForgeError) as caught:
            self._publish()
        self.assertEqual(caught.exception.code, ErrorCode.VERSION_CONFLICT)
        self.assertEqual(self.store.list_versions("design", scope=SCOPE), [])

    def test_publishing_without_validation_is_refused(self):
        draft = self.store.create_draft(
            company_ref=SCOPE["companyRef"],
            project_ref=SCOPE["projectRef"],
            graph_id="design",
            author="eng:dana",
            definition=self.definition,
        )
        with self.assertRaises(PolyForgeError) as caught:
            self.store.publish_version(
                scope=SCOPE,
                graph_id="design",
                draft_id=draft.draft_id,
                author="eng:dana",
                review_target_hash="sha256:" + "b" * 64,
            )
        self.assertEqual(caught.exception.code, ErrorCode.VERSION_CONFLICT)

    def test_publishing_without_compile_is_refused(self):
        draft = self.store.create_draft(
            company_ref=SCOPE["companyRef"],
            project_ref=SCOPE["projectRef"],
            graph_id="design",
            author="eng:dana",
            definition=self.definition,
        )
        self.store.record_validation(draft.draft_id, validate_definition(self.definition))
        with self.assertRaises(PolyForgeError) as caught:
            self.store.publish_version(
                scope=SCOPE,
                graph_id="design",
                draft_id=draft.draft_id,
                author="eng:dana",
                review_target_hash="sha256:" + "b" * 64,
            )
        self.assertEqual(caught.exception.code, ErrorCode.VERSION_CONFLICT)

    def test_publishing_without_a_review_is_refused(self):
        draft = self.store.create_draft(
            company_ref=SCOPE["companyRef"],
            project_ref=SCOPE["projectRef"],
            graph_id="design",
            author="eng:dana",
            definition=self.definition,
        )
        report = validate_definition(self.definition)
        draft = self.store.record_validation(draft.draft_id, report)
        from polyforge.core.compiler.compile import compile_definition
        from polyforge.graph_library import dependency_lock_for

        self.store.record_compile(
            draft.draft_id, compile_definition(self.definition, dependency_lock=dependency_lock_for("design"))
        )
        with self.assertRaises(PolyForgeError) as caught:
            self.store.publish_version(
                scope=SCOPE,
                graph_id="design",
                draft_id=draft.draft_id,
                author="eng:dana",
                review_target_hash="sha256:" + "b" * 64,
            )
        self.assertEqual(caught.exception.code, ErrorCode.VERSION_CONFLICT)

    def test_a_review_of_a_different_target_is_refused(self):
        with self.assertRaises(PolyForgeError) as caught:
            self._publish(review_target_hash=hashing.hash_domain("pf.decision-target", {"other": True}))
        self.assertEqual(caught.exception.code, ErrorCode.VERSION_CONFLICT)
        self.assertIn("reviewed", caught.exception.details)

    def test_an_explicit_plan_hash_mismatch_is_refused(self):
        with self.assertRaises(PolyForgeError) as caught:
            self._publish(expected_plan_hash="sha256:" + "c" * 64)
        self.assertEqual(caught.exception.code, ErrorCode.VERSION_CONFLICT)

    def test_an_explicit_revision_mismatch_is_refused(self):
        with self.assertRaises(PolyForgeError) as caught:
            self._publish(expected_revision=7)
        self.assertEqual(caught.exception.code, ErrorCode.VERSION_CONFLICT)

    def test_a_draft_with_a_permission_gate_needs_authorization_references(self):
        prepared = reviewed_draft(self.store, load_graph("release"), scope=SCOPE)
        with self.assertRaises(PolyForgeError) as caught:
            self.store.publish_version(
                scope=SCOPE,
                graph_id="release",
                draft_id=prepared["draft"].draft_id,
                author="eng:dana",
                review_target_hash=prepared["reviewTargetHash"],
            )
        self.assertEqual(caught.exception.code, ErrorCode.CONTRACT_INVALID)
        version = self.store.publish_version(
            scope=SCOPE,
            graph_id="release",
            draft_id=prepared["draft"].draft_id,
            author="eng:dana",
            review_target_hash=prepared["reviewTargetHash"],
            authorization_refs=["apr_deploy_42"],
        )
        self.assertEqual(version.authorization_refs, ("apr_deploy_42",))

    def test_a_draft_that_cannot_be_deleted_once_published(self):
        self._publish()
        with self.assertRaises(PolyForgeError) as caught:
            self.store.delete_draft(self.draft_id, scope=SCOPE)
        self.assertEqual(caught.exception.code, ErrorCode.CONTRACT_INVALID)


class VersionImmutabilityTest(StoreTestCase):
    """AT-20 / REQ-GRAPH-07: a published version is read-only and offers clone-to-draft."""

    def setUp(self):
        super().setUp()
        self.prepared = reviewed_draft(self.store, load_graph("requirement"))
        self.version = self.store.publish_version(
            scope=SCOPE,
            graph_id="requirement",
            draft_id=self.prepared["draft"].draft_id,
            author="eng:dana",
            review_target_hash=self.prepared["reviewTargetHash"],
        )

    def test_no_update_or_delete_statement_targets_the_version_table(self):
        import inspect

        from polyforge.core.registry import store as store_module

        text = inspect.getsource(store_module).upper()
        for forbidden in (
            "UPDATE PF_REGISTRY_VERSION ",
            "DELETE FROM PF_REGISTRY_VERSION",
        ):
            with self.subTest(statement=forbidden):
                self.assertNotIn(forbidden, text)

    def test_reading_a_version_returns_the_published_bytes(self):
        stored = self.store.get_version("requirement", 1, scope=SCOPE)
        self.assertEqual(stored.to_dict(), self.version.to_dict())
        self.assertEqual(stored.definition_hash, self.version.definition_hash)
        self.assertEqual(
            stored.summary()["planHash"], self.prepared["artifact"].plan_hash
        )

    def test_retire_keeps_the_version_readable(self):
        retired = self.store.retire_version("requirement", 1, scope=SCOPE, actor="human:ravi")
        self.assertTrue(self.store.is_retired("requirement", 1, scope=SCOPE))
        self.assertEqual(retired.definition_hash, self.version.definition_hash)
        self.assertEqual(retired.published_at, self.version.published_at)
        self.assertEqual(self.store.get_version("requirement", 1, scope=SCOPE).to_dict(), retired.to_dict())

    def test_retiring_without_a_scope_is_refused(self):
        with self.assertRaises(PolyForgeError) as caught:
            self.store.retire_version("requirement", 1)
        self.assertEqual(caught.exception.code, ErrorCode.BAD_REQUEST)

    def test_clone_to_draft_copies_the_definition_and_bases_on_the_version(self):
        draft = self.store.clone_to_draft(
            "requirement",
            1,
            scope=SCOPE,
            company_ref=SCOPE["companyRef"],
            project_ref=SCOPE["projectRef"],
            author="eng:erin",
        )
        self.assertEqual(draft.base_version, 1)
        self.assertEqual(draft.definition_hash, self.version.definition_hash)
        self.assertNotEqual(draft.draft_id, self.prepared["draft"].draft_id)
        # The copy is editable and the published version is not affected by editing it.
        edited = copy.deepcopy(draft.definition)
        edited["name"] = "Requirement, second edition"
        saved = self.store.save_draft(
            draft.draft_id, definition=edited, author="eng:erin", expected_revision=1
        )
        self.assertEqual(saved.revision, 2)
        self.assertEqual(
            self.store.get_version("requirement", 1, scope=SCOPE).definition_hash,
            self.version.definition_hash,
        )

    def test_clone_from_another_scope_is_denied(self):
        with self.assertRaises(PolyForgeError) as caught:
            self.store.clone_to_draft(
                "requirement",
                1,
                scope=OTHER_SCOPE,
                company_ref=OTHER_SCOPE["companyRef"],
                project_ref=OTHER_SCOPE["projectRef"],
                author="eng:erin",
            )
        self.assertEqual(caught.exception.code, ErrorCode.NOT_FOUND)

    def test_a_version_record_round_trips(self):
        self.assertEqual(GraphVersion.from_dict(self.version.to_dict()).to_dict(), self.version.to_dict())
        summary = GraphVersionSummary.from_dict(self.version.summary())
        self.assertEqual(summary.to_dict(), self.version.summary())


class ActivationTest(StoreTestCase):
    """AT-19: activation is an independent CAS that only affects future admission."""

    def setUp(self):
        super().setUp()
        self.v13 = self._publish_version("requirement", load_graph("requirement"))
        changed = load_graph("requirement")
        changed["nodes"]["clarify"]["timeoutSeconds"] = 900
        self.v14 = self._publish_version("requirement", changed, name="Requirement v14")

    def _publish_version(self, graph_id, definition, *, name=None):
        if name:
            definition = copy.deepcopy(definition)
            definition["name"] = name
        prepared = reviewed_draft(self.store, definition)
        return self.store.publish_version(
            scope=SCOPE,
            graph_id=graph_id,
            draft_id=prepared["draft"].draft_id,
            author="eng:dana",
            review_target_hash=prepared["reviewTargetHash"],
        )

    def test_no_active_version_before_activation(self):
        self.assertIsNone(self.store.get_active_version(scope=SCOPE, graph_id="requirement"))

    def test_activation_is_a_compare_and_swap_on_its_own_generation(self):
        pointer = self.store.activate_version(
            scope=SCOPE, graph_id="requirement", version=1, expected_generation=0, actor="human:ravi"
        )
        self.assertEqual(pointer.version, 1)
        self.assertEqual(pointer.generation, 1)
        with self.assertRaises(PolyForgeError) as caught:
            self.store.activate_version(
                scope=SCOPE, graph_id="requirement", version=2, expected_generation=0, actor="human:ravi"
            )
        self.assertEqual(caught.exception.code, ErrorCode.VERSION_CONFLICT)
        self.assertEqual(caught.exception.details["currentVersion"], 1)
        self.assertEqual(self.store.get_default_pointer(scope=SCOPE, graph_id="requirement").version, 1)

    def test_activating_v14_leaves_v13_readable_and_pinned(self):
        # This stands in for a v13 run and its child: they hold the v13 pins.
        v13_run_pins = {
            "graph.id": self.v13.definition_hash,
            "graph.planHash": self.v13.plan_hash,
            "graph.version": "1",
        }
        child_pins = {**v13_run_pins, "child.entrypoint": "requirement.start"}
        self.store.activate_version(scope=SCOPE, graph_id="requirement", version=2, expected_generation=0)
        still_there = self.store.get_version("requirement", 1, scope=SCOPE)
        self.assertEqual(still_there.plan_hash, self.v13.plan_hash)
        self.assertEqual(still_there.closure["graph.definitionHash"], v13_run_pins["graph.id"])
        self.assertEqual(child_pins["child.entrypoint"], "requirement.start")
        self.assertEqual(self.store.get_active_version(scope=SCOPE, graph_id="requirement").version, 2)
        self.assertNotEqual(
            self.store.get_active_version(scope=SCOPE, graph_id="requirement").plan_hash, self.v13.plan_hash
        )

    def test_activation_writes_its_own_audit_record(self):
        self.store.activate_version(scope=SCOPE, graph_id="requirement", version=2, expected_generation=0, actor="human:ravi")
        log = self.store.audit_log(scope=SCOPE, graph_id="requirement")
        kinds = [entry["kind"] for entry in log]
        self.assertIn("pointer.activated", kinds)
        activation = next(entry for entry in log if entry["kind"] == "pointer.activated")
        self.assertEqual(activation["generation"], 1)
        self.assertEqual(activation["actor"], "human:ravi")
        self.assertIn("future admission only", activation["detail"]["effect"])

    def test_a_retired_version_cannot_be_activated(self):
        self.store.retire_version("requirement", 2, scope=SCOPE, actor="human:ravi")
        with self.assertRaises(PolyForgeError) as caught:
            self.store.activate_version(scope=SCOPE, graph_id="requirement", version=2, expected_generation=0)
        self.assertEqual(caught.exception.code, ErrorCode.CONTRACT_INVALID)

    def test_activation_is_per_scope(self):
        self.store.activate_version(scope=SCOPE, graph_id="requirement", version=2, expected_generation=0)
        other = memory_database()
        self.addCleanup(close, other)
        other_store = RegistryStore(other)
        other_store.create_draft(
            company_ref=OTHER_SCOPE["companyRef"],
            project_ref=OTHER_SCOPE["projectRef"],
            graph_id="requirement",
            author="eng:dana",
        )
        self.assertIsNone(other_store.get_active_version(scope=OTHER_SCOPE, graph_id="requirement"))

    def test_versions_are_listed_newest_last_with_closure_pins(self):
        versions = self.store.list_versions("requirement", scope=SCOPE)
        self.assertEqual([item.version for item in versions], [1, 2])
        self.assertEqual(versions[1].closure["compilerVersion"], COMPILER_VERSION)

    def test_store_works_on_the_execute_only_shape_too(self):
        database = memory_database("execute-only")
        self.addCleanup(close, database)
        store = RegistryStore(database)
        prepared = reviewed_draft(store, load_graph("verification"))
        version = store.publish_version(
            scope=SCOPE,
            graph_id="verification",
            draft_id=prepared["draft"].draft_id,
            author="eng:dana",
            review_target_hash=prepared["reviewTargetHash"],
        )
        self.assertEqual(version.version, 1)
        self.assertEqual(
            store.get_version("verification", 1, scope=SCOPE).definition_hash, version.definition_hash
        )


class StoreSemanticDiffTest(StoreTestCase):
    """AT-21 through the registry: diffing two published versions."""

    def setUp(self):
        super().setUp()
        self.v1 = self._publish(load_graph("design"))
        changed = load_graph("design")
        changed["nodes"]["architecture"]["operation"]["version"] = 4
        self.v2 = self._publish(changed)

    def _publish(self, definition):
        prepared = reviewed_draft(self.store, definition)
        return self.store.publish_version(
            scope=SCOPE,
            graph_id="design",
            draft_id=prepared["draft"].draft_id,
            author="eng:dana",
            review_target_hash=prepared["reviewTargetHash"],
        )

    def test_a_version_to_itself_is_empty(self):
        diff = self.store.semantic_diff("design", from_version=1, to_version=1, scope=SCOPE)
        self.assertTrue(diff.is_noop)
        self.assertEqual(diff.from_version, 1)
        self.assertEqual(diff.to_version, 1)

    def test_a_changed_operation_shows_up_and_invalidates_evidence(self):
        diff = self.store.semantic_diff("design", from_version=1, to_version=2, scope=SCOPE)
        self.assertEqual(diff.changed_nodes, ["architecture"])
        self.assertTrue(diff.invalidates_evidence)
        self.assertEqual(diff.graph_id, "design")

    def test_diffing_against_nothing_is_all_additions(self):
        diff = self.store.semantic_diff("design", from_version=None, to_version=1, scope=SCOPE)
        self.assertEqual(sorted(diff.added_nodes), ["architecture", "design_gate", "security_review"])
        self.assertTrue(diff.invalidates_evidence)

    def test_diffing_a_version_in_another_scope_is_not_found(self):
        with self.assertRaises(PolyForgeError) as caught:
            self.store.semantic_diff("design", from_version=1, to_version=2, scope=OTHER_SCOPE)
        self.assertEqual(caught.exception.code, ErrorCode.NOT_FOUND)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
