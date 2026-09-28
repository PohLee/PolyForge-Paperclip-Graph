"""Composition with the sibling Core modules: registry pinning and entry-point admission.

The Runtime imports ``core.registry`` and ``core.entrypoints`` lazily, so it imports cleanly
whether or not those modules are present. These tests use them when installed and assert the
*degradation* when they are not, because "the extra check did not run" must never be
indistinguishable from "the extra check passed".
"""

from __future__ import annotations

import unittest

from services.polyforge.tests.runtime.fixtures import (
    QA_NODE,
    SCOPE_A,
    SCOPE_B,
    definition,
    make_engine,
    node_state,
    work_order_request,
)
from polyforge.core import errors
from polyforge.core.state import GraphRunStatus, NodeStatus

REGISTRY_AVAILABLE = True
try:  # pragma: no cover - depends on the sibling agent having landed
    from polyforge.core.registry.store import RegistryStore  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover
    RegistryStore = None  # type: ignore[assignment]
    REGISTRY_AVAILABLE = False


class EntryPointAdmissionTests(unittest.TestCase):
    def test_a_missing_qualified_coordinator_refuses_admission(self) -> None:
        engine, db, clock = make_engine()
        db.execute(
            "UPDATE capability_bindings SET revoked = 1 WHERE capability_ref = ?",
            ("verification.coordinate",),
        )
        with self.assertRaises(errors.PolyForgeError) as caught:
            engine.admit_work_order(work_order_request())
        self.assertEqual(caught.exception.code, errors.ErrorCode.CONTRACT_INVALID)
        self.assertIn("coordinator capability", caught.exception.message)
        self.assertEqual(
            len(engine.list_runs(scope=SCOPE_A)), 0, "a refused admission creates no run"
        )

    def test_a_coordinator_bound_to_another_entrypoint_does_not_admit(self) -> None:
        engine, db, clock = make_engine()
        db.execute(
            "UPDATE capability_bindings SET entrypoints_json = ? WHERE capability_ref = ?",
            ('["implementation.start"]', "verification.coordinate"),
        )
        with self.assertRaises(errors.PolyForgeError) as caught:
            engine.admit_work_order(work_order_request())
        self.assertEqual(caught.exception.code, errors.ErrorCode.CONTRACT_INVALID)
        self.assertIn("coordinator capability", caught.exception.message)
        self.assertEqual(len(engine.list_runs(scope=SCOPE_A)), 0)

    def test_a_qualified_coordinator_admits_and_releases_the_start_node(self) -> None:
        engine, db, clock = make_engine()
        snapshot = engine.admit_work_order(work_order_request())
        self.assertEqual(snapshot["status"], GraphRunStatus.ACTIVE)
        self.assertEqual(node_state(snapshot, QA_NODE)["status"], NodeStatus.READY)


@unittest.skipUnless(REGISTRY_AVAILABLE, "the registry module is not installed")
class RegistryPinningTests(unittest.TestCase):
    """A run created from a registry version pins exactly what that version published."""

    def _publish(self, db: object) -> tuple[object, int]:
        """Publish a version through the registry's own validate → compile → review chain."""
        from polyforge.core.compiler.compile import compile_definition
        from polyforge.core.compiler.validate import validate_definition

        graph = definition()
        dependency_lock = {
            # A lock entry is the pinned version itself, not an object containing one: the
            # compiler refuses to guess, and it refuses a shape it cannot read.
            "capabilities": {
                "verification.coordinate": "1",
                "verification.qa": "1",
                "security.review": "1",
            },
            "operations": {
                "verification.qa": "1",
                "verification.security_review": "1",
            },
            "evaluators": {
                "contract_schema_v1": "1",
                "required_evidence_present": "1",
                "human_decision": "1",
            },
            "policies": {"verification.policy": "1"},
        }
        registry = RegistryStore(db)
        draft = registry.create_draft(
            company_ref=SCOPE_A["companyRef"],
            project_ref=SCOPE_A["projectRef"],
            graph_id="verification",
            author="user-anna",
            definition=graph,
        )
        draft_id = str(draft.draft_id)
        revision = int(draft.revision)
        report = validate_definition(graph)
        registry.record_validation(draft_id, report, scope=SCOPE_A)
        artifact = compile_definition(graph, dependency_lock=dependency_lock)
        registry.record_compile(draft_id, artifact, scope=SCOPE_A)
        review_target = str(getattr(artifact, "plan_hash", "") or "")
        registry.record_review(
            draft_id,
            review_target_hash=review_target,
            reviewer="user-anna",
            scope=SCOPE_A,
            authorization_refs=("approval-1",),
        )
        version = registry.publish_version(
            scope=SCOPE_A,
            graph_id="verification",
            draft_id=draft_id,
            author="user-anna",
            review_target_hash=review_target,
            authorization_refs=("approval-1",),
            expected_revision=revision,
        )
        return registry, int(version.version)

    def test_admission_from_a_registry_pins_the_published_identity(self) -> None:
        engine, db, clock = make_engine()
        registry, version = self._publish(db)
        engine.registry = registry
        request = work_order_request(start_intent_id="from-registry", graphVersion=version)
        request["definition"] = None
        snapshot = engine.admit_work_order(request)
        self.assertEqual(snapshot["graphVersion"], version)
        self.assertTrue(snapshot["pins"]["planHash"].startswith("sha256:"))
        self.assertTrue(snapshot["pins"]["dependencyLockHash"].startswith("sha256:"))
        self.assertEqual(
            snapshot["pins"]["planHash"],
            registry.get_version("verification", version, scope=SCOPE_A).plan_hash,
        )

    def test_an_unpublished_version_is_not_found_rather_than_invented(self) -> None:
        engine, db, clock = make_engine()
        registry, version = self._publish(db)
        engine.registry = registry
        request = work_order_request(
            start_intent_id="missing-version", graphVersion=version + 99
        )
        request["definition"] = None
        with self.assertRaises(errors.PolyForgeError) as caught:
            engine.admit_work_order(request)
        self.assertEqual(caught.exception.code, errors.ErrorCode.NOT_FOUND)

    def test_a_registry_from_another_scope_is_not_reachable(self) -> None:
        engine, db, clock = make_engine()
        registry, version = self._publish(db)
        engine.registry = registry
        request = work_order_request(
            start_intent_id="cross-scope", graphVersion=version, scope=SCOPE_B
        )
        request["definition"] = None
        with self.assertRaises(errors.PolyForgeError) as caught:
            engine.admit_work_order(request)
        self.assertIn(
            caught.exception.code,
            {errors.ErrorCode.SCOPE_VIOLATION, errors.ErrorCode.NOT_FOUND},
        )


if __name__ == "__main__":
    unittest.main()
