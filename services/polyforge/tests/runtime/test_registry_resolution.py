"""The Runtime resolves published versions through the registry, and fails closed without it.

AT-19 (REQ-GRAPH-06): publishing and activating a newer version changes what *future*
admissions get, and nothing else. A run admitted on the active default keeps the pins it was
created with, and a version that was published but never activated — or that was retired — is
never substituted for the pointer.

AT-21 (REQ-MIG-01/02/03/04): a migration is planned and committed through a real
``RegistryStore`` and a real ``RuntimeEngine`` over one database, and each of the five
refusals is refused with its own code.

The bug this file pins shut: the Core used to carry its own ``graph_versions`` /
``graph_defaults`` tables, which nothing ever wrote, and resolved the default with
``MAX(version)``. Every assertion here goes through the registry, so a test that would have
passed against the empty local tables cannot exist any more.
"""

from __future__ import annotations

import unittest

from polyforge.core import errors
from polyforge.core.registry.store import RegistryStore
from polyforge.core.state import GraphRunStatus
from polyforge.core.store.models import Scope
from services.polyforge.tests.runtime.fixtures import (
    QA_NODE,
    SCOPE_A,
    artifact,
    claim_request,
    definition,
    envelope,
    evidence_for,
    grant_capability,
    make_engine,
    published_version,
    work_order_request,
)

GRAPH_ID = "verification"
SCOPE_KWARGS = {"company_ref": SCOPE_A["companyRef"], "project_ref": SCOPE_A["projectRef"]}


def relabelled(label: str) -> dict:
    """The fixture graph with a different description: a new, separately reviewed version."""
    value = definition()
    value["description"] = label
    return value


class RegistryWiringCase(unittest.TestCase):
    """An engine over one database with a real registry, and the grants admission needs."""

    def setUp(self) -> None:
        self.engine, self.db, self.clock = make_engine()
        self.registry: RegistryStore = self.engine.registry
        grant_capability(self.db, "sub-qa", "verification.qa")
        grant_capability(self.db, "sub-security", "security.review")

    # -- helpers ---------------------------------------------------------

    def publish(self, graph: dict, *, activate: bool = True) -> int:
        return int(published_version(self.registry, graph, activate=activate).version)

    def admit(self, start_intent: str, **overrides) -> dict:
        """Admit with no inline definition, so the registry is the only thing that can answer."""
        request = work_order_request(start_intent_id=start_intent)
        request.pop("definition", None)
        request.update(overrides)
        return self.engine.admit_work_order(request)

    def work(self, run_id: str, node_id: str, subject: str, seed: str) -> dict:
        attempt = self.engine.claim(
            claim_request(run_id=run_id, node_id=node_id, subject=subject)
        )
        art = artifact("qa_report", seed)
        self.engine.submit_artifacts(
            envelope(
                run_id=run_id,
                node_id=node_id,
                attempt_id=attempt["attemptId"],
                lease_epoch=attempt["leaseEpoch"],
                payload={"artifacts": [art]},
            )
        )
        evidence = self.engine.submit_evidence(
            envelope(
                run_id=run_id,
                node_id=node_id,
                attempt_id=attempt["attemptId"],
                lease_epoch=attempt["leaseEpoch"],
                command_suffix="ev",
                payload={"evidence": [evidence_for(art, "qa_report")]},
            )
        )
        return self.engine.request_transition(
            envelope(
                run_id=run_id,
                node_id=node_id,
                attempt_id=attempt["attemptId"],
                lease_epoch=attempt["leaseEpoch"],
                command_suffix="tr",
                payload={"evidenceIds": [str(evidence["resultRef"]).split(",")[0]]},
            )
        )


class ActiveDefaultVersionTests(RegistryWiringCase):
    """AT-19: the pointer is the default, and nothing else is."""

    def test_admission_pins_the_activated_version_not_the_highest_one(self) -> None:
        first = self.publish(definition())
        second = self.publish(relabelled("published but never activated"), activate=False)
        self.assertEqual((first, second), (1, 2))

        snapshot = self.admit("default-1")

        self.assertEqual(int(snapshot["graphVersion"]), first)
        self.assertEqual(snapshot["pins"]["graphVersion"], str(first))
        self.assertEqual(
            snapshot["pins"]["definitionHash"],
            self.registry.get_version(GRAPH_ID, first, scope=SCOPE_A).definition_hash,
            msg="the unactivated newer version is not substituted for the pointer",
        )

    def test_publishing_and_activating_v14_leaves_a_v13_run_on_v13(self) -> None:
        """AT-19 as written: v13 keeps its pins after v14 is published and activated."""
        for number in range(1, 14):
            self.assertEqual(self.publish(relabelled(f"release {number}")), number)
        v13 = self.admit("v13-run")
        self.assertEqual(int(v13["graphVersion"]), 13)

        v14 = self.publish(relabelled("release 14"))
        self.registry.activate_version(
            scope=SCOPE_A,
            graph_id=GRAPH_ID,
            version=v14,
            expected_generation=int(
                self.registry.get_default_pointer(scope=SCOPE_A, graph_id=GRAPH_ID).generation
            ),
            actor="user-anna",
        )

        reread = self.engine.get_run(str(v13["runId"]), scope=SCOPE_A)
        self.assertEqual(int(reread["graphVersion"]), 13)
        self.assertEqual(reread["pins"]["graphVersion"], "13")
        self.assertEqual(
            reread["pins"]["definitionHash"],
            self.registry.get_version(GRAPH_ID, 13, scope=SCOPE_A).definition_hash,
        )
        self.assertEqual(int(self.admit("v14-run")["graphVersion"]), 14)
        # The version the run pinned is still fully readable, which is why the pointer may move
        # freely: retirement and activation never remove a definition a run is holding.
        self.assertFalse(self.registry.is_retired(GRAPH_ID, 13, scope=SCOPE_A))

    def test_a_retired_version_is_never_the_default(self) -> None:
        first = self.publish(definition())
        second = self.publish(relabelled("deprecated immediately"))
        self.registry.retire_version(GRAPH_ID, second, scope=SCOPE_A)
        self.registry.activate_version(
            scope=SCOPE_A,
            graph_id=GRAPH_ID,
            version=first,
            expected_generation=int(
                self.registry.get_default_pointer(scope=SCOPE_A, graph_id=GRAPH_ID).generation
            ),
            actor="user-anna",
        )

        snapshot = self.admit("default-2")

        self.assertEqual(int(snapshot["graphVersion"]), first)
        self.assertTrue(self.registry.is_retired(GRAPH_ID, second, scope=SCOPE_A))

    def test_activating_a_newer_version_changes_only_future_admissions(self) -> None:
        first = self.publish(definition())
        before = self.admit("default-3")
        self.assertEqual(int(before["graphVersion"]), first)

        second = self.publish(relabelled("the next release"))
        self.registry.activate_version(
            scope=SCOPE_A,
            graph_id=GRAPH_ID,
            version=second,
            expected_generation=int(
                self.registry.get_default_pointer(scope=SCOPE_A, graph_id=GRAPH_ID).generation
            ),
            actor="user-anna",
        )
        after = self.admit("default-4")

        self.assertEqual(int(before["graphVersion"]), first, msg="the admitted run keeps its pin")
        self.assertEqual(int(after["graphVersion"]), second, msg="the new run gets the pointer")
        reread = self.engine.get_run(str(before["runId"]), scope=SCOPE_A)
        self.assertEqual(reread["pins"]["graphVersion"], str(first))
        self.assertEqual(
            reread["pins"]["definitionHash"],
            self.registry.get_version(GRAPH_ID, first, scope=SCOPE_A).definition_hash,
        )
        self.assertNotEqual(
            reread["pins"]["definitionHash"],
            self.registry.get_version(GRAPH_ID, second, scope=SCOPE_A).definition_hash,
        )

    def test_a_graph_with_no_activated_version_is_refused_not_defaulted(self) -> None:
        self.publish(definition(), activate=False)
        with self.assertRaises(errors.PolyForgeError) as caught:
            self.admit("default-5")
        self.assertEqual(caught.exception.code, errors.ErrorCode.NOT_FOUND)

    def test_an_explicit_graph_version_may_be_pinned_even_when_it_is_not_the_default(self) -> None:
        self.publish(definition())
        unpublished = self.publish(relabelled("pinned by request"), activate=False)

        snapshot = self.admit("default-6", graphVersion=unpublished)

        self.assertEqual(int(snapshot["graphVersion"]), unpublished)

    def test_another_project_cannot_read_this_scope_s_version(self) -> None:
        self.publish(definition())
        other_scope = {"companyRef": SCOPE_A["companyRef"], "projectRef": "another-project"}
        scope = Scope.from_wire(SCOPE_A)
        other = Scope.from_wire(other_scope)

        self.assertIsNone(
            self.engine._resolve_version(scope=other, graph_id=GRAPH_ID, version=1),
            msg="the same version number in another project is not this project's version",
        )
        self.assertIsNone(
            self.engine._resolve_active_version(scope=other, graph_id=GRAPH_ID),
            msg="a pointer is per project; another project has none",
        )
        self.assertIsNotNone(
            self.engine._resolve_version(scope=scope, graph_id=GRAPH_ID, version=1)
        )
        with self.assertRaises(errors.PolyForgeError) as caught:
            self.admit("default-7", scope=other_scope, graphVersion=1)
        self.assertEqual(caught.exception.code, errors.ErrorCode.NOT_FOUND)

    def test_the_runtime_holds_no_authoring_table_of_its_own(self) -> None:
        """The Runtime has no second copy of "published" to disagree with the registry."""
        tables = {
            str(row["name"])
            for row in self.db.query(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
            )
        }
        for absent in ("graph_drafts", "graph_versions", "graph_defaults"):
            self.assertNotIn(absent, tables)
        self.publish(definition())
        published_rows = self.db.scalar("SELECT COUNT(*) FROM pf_registry_version")
        self.assertEqual(int(published_rows or 0), 1)


class MigrationEndToEndTests(RegistryWiringCase):
    """AT-21: plan and commit succeed through a real registry over one database."""

    def setUp(self) -> None:
        super().setUp()
        self.source = self.publish(definition())
        self.snapshot = self.admit("migrate-1")
        self.run_id = str(self.snapshot["runId"])
        self.target = self.publish(relabelled("the migrated definition"))
        self.assertEqual(self.target, self.source + 1)

    def plan(self, **overrides) -> dict:
        request = {
            "scope": SCOPE_A,
            "runId": self.run_id,
            "targetGraphVersion": self.target,
        }
        request.update(overrides)
        return self.engine.plan_migration(request)

    def commit(self, preview: dict, **overrides) -> dict:
        request = {
            "scope": SCOPE_A,
            "runId": self.run_id,
            "targetGraphVersion": self.target,
            "planHash": preview["planHash"],
            "commandId": "cmd-migrate-e2e",
            "idempotencyKey": "migrate-e2e-1",
            "approvalRefs": ["approval-migration-1"],
        }
        request.update(overrides)
        return self.engine.commit_migration(request)

    def test_a_quiescent_run_migrates_onto_the_published_target(self) -> None:
        preview = self.plan()
        self.assertTrue(preview["quiescent"], msg=preview["blockers"])
        self.assertEqual(preview["sourceGraphVersion"], self.source)
        self.assertEqual(preview["targetGraphVersion"], self.target)

        result = self.commit(preview)

        self.assertTrue(result["applied"], msg=result)
        successor_id = str(result["resultRef"])
        successor = self.engine.get_run(successor_id, scope=SCOPE_A)
        source = self.engine.get_run(self.run_id, scope=SCOPE_A)
        self.assertEqual(int(successor["graphVersion"]), self.target)
        self.assertEqual(successor["parentRunId"], self.run_id)
        self.assertEqual(successor["familyId"], source["familyId"])
        self.assertEqual(successor["pins"]["migratedFrom"], self.run_id)
        self.assertEqual(
            successor["pins"]["definitionHash"],
            self.registry.get_version(GRAPH_ID, self.target, scope=SCOPE_A).definition_hash,
        )
        self.assertNotEqual(
            successor["pins"]["definitionHash"],
            self.registry.get_version(GRAPH_ID, self.source, scope=SCOPE_A).definition_hash,
        )
        self.assertEqual(
            self.db.scalar(
                "SELECT migration_state FROM graph_runs WHERE run_id = ?", (self.run_id,)
            ),
            "SUPERSEDED",
        )
        self.assertEqual(str(source["status"]), str(GraphRunStatus.PAUSED))
        record = self.db.query_one(
            "SELECT * FROM migration_records WHERE successor_run_id = ?", (successor_id,)
        )
        assert record is not None
        self.assertEqual(str(record["status"]), "COMMITTED")
        self.assertEqual(int(record["target_graph_version"]), self.target)

    def test_a_pass_under_the_old_version_is_never_inherited(self) -> None:
        self.work(self.run_id, QA_NODE, "sub-qa", "qa-v1")
        preview = self.plan()
        self.assertIn("pass_inheritance", [i["kind"] for i in preview["invalidations"]])

        result = self.commit(preview)
        successor = self.engine.get_run(str(result["resultRef"]), scope=SCOPE_A)
        node = next(n for n in successor["nodes"] if n["nodeId"] == QA_NODE)
        self.assertNotEqual(str(node["status"]), "PASSED")

    def test_the_commit_is_idempotent_on_its_command_key(self) -> None:
        preview = self.plan()
        first = self.commit(preview)
        replay = self.commit(preview)
        self.assertEqual(replay["commandId"], first["commandId"])
        self.assertEqual(replay["resultRef"], first["resultRef"])
        self.assertEqual(self.db.scalar("SELECT COUNT(*) FROM migration_records"), 1)

    def test_a_successor_run_admits_no_new_work_before_its_own_plan_applies(self) -> None:
        preview = self.plan()
        successor_id = str(self.commit(preview)["resultRef"])
        successor = self.engine.get_run(successor_id, scope=SCOPE_A)
        self.assertEqual(str(successor["status"]), str(GraphRunStatus.ACTIVE))
        ready = [n["nodeId"] for n in successor["nodes"] if n["status"] == "READY"]
        self.assertEqual(ready, [QA_NODE], msg="the successor starts from the target's own start node")


class MigrationRefusalTests(RegistryWiringCase):
    """AT-21: each of the five refusals, each with its own code."""

    def setUp(self) -> None:
        super().setUp()
        self.source = self.publish(definition())
        self.snapshot = self.admit("refuse-1")
        self.run_id = str(self.snapshot["runId"])
        self.target = self.publish(relabelled("the migrated definition"))

    def _plan(self, **overrides) -> dict:
        request = {
            "scope": SCOPE_A,
            "runId": self.run_id,
            "targetGraphVersion": self.target,
        }
        request.update(overrides)
        return self.engine.plan_migration(request)

    def _commit(self, preview: dict, **overrides) -> dict:
        request = {
            "scope": SCOPE_A,
            "runId": self.run_id,
            "targetGraphVersion": self.target,
            "planHash": preview["planHash"],
            "commandId": "cmd-refuse",
            "idempotencyKey": "refuse-1",
            "approvalRefs": ["approval-1"],
        }
        request.update(overrides)
        return self.engine.commit_migration(request)

    def test_a_source_that_moved_since_the_plan_is_a_409_version_conflict(self) -> None:
        preview = self._plan()
        self.work(self.run_id, QA_NODE, "sub-qa", "qa-v1")
        with self.assertRaises(errors.PolyForgeError) as caught:
            self._commit(preview)
        self.assertEqual(caught.exception.code, errors.ErrorCode.VERSION_CONFLICT)
        self.assertIn("currentPlanHash", caught.exception.details)

    def test_a_live_worker_lease_is_a_423_with_its_blocker(self) -> None:
        preview = self._plan()
        self.engine.claim(claim_request(run_id=self.run_id, node_id=QA_NODE, subject="sub-qa"))
        with self.assertRaises(errors.PolyForgeError) as caught:
            self._commit(preview)
        self.assertEqual(caught.exception.code, errors.ErrorCode.RUN_BLOCKED)
        codes = [b["code"] for b in caught.exception.details["blockers"]]
        self.assertIn("ACTIVE_ATTEMPT", codes)
        self.assertEqual(
            self.db.scalar("SELECT COUNT(*) FROM migration_records"), 0, msg="nothing committed"
        )

    def test_an_unknown_effect_is_a_423_and_is_never_migrated_away_from(self) -> None:
        preview = self._plan()
        key = str(
            self.engine.effects.record_pending(
                **SCOPE_KWARGS,
                run_id=self.run_id,
                transition_hash="sha256:transition",
                step_id="verification.deploy",
                target_hash="sha256:target",
                request_hash="sha256:request",
            )["effect_key"]
        )
        self.engine.effects.mark_unknown(
            **SCOPE_KWARGS, run_id=self.run_id, key=key, reason="the provider timed out"
        )
        with self.assertRaises(errors.PolyForgeError) as caught:
            self._commit(preview)
        self.assertEqual(caught.exception.code, errors.ErrorCode.RUN_BLOCKED)
        codes = [b["code"] for b in caught.exception.details["blockers"]]
        self.assertIn("UNKNOWN_EFFECT", codes)
        still = self.db.query_one(
            "SELECT status FROM effect_records WHERE effect_key = ?", (key,)
        )
        self.assertEqual(str(still["status"]), "UNKNOWN")

    def test_an_unpublished_target_is_a_423_naming_the_version(self) -> None:
        missing = self.target + 1
        preview = self._plan(targetGraphVersion=missing)
        self.assertIn(
            "TARGET_VERSION_UNKNOWN", [b["code"] for b in preview["blockers"]]
        )
        with self.assertRaises(errors.PolyForgeError) as caught:
            self._commit(preview, targetGraphVersion=missing)
        self.assertEqual(caught.exception.code, errors.ErrorCode.RUN_BLOCKED)
        self.assertIn(
            "TARGET_VERSION_UNKNOWN", [b["code"] for b in caught.exception.details["blockers"]]
        )

    def test_a_mapping_onto_a_node_the_target_does_not_declare_is_a_423(self) -> None:
        preview = self._plan(nodeMapping={QA_NODE: "qa_renamed_without_a_declaration"})
        self.assertIn("NODE_MAPPING_INCOMPLETE", [b["code"] for b in preview["blockers"]])
        self.assertFalse(preview["quiescent"])
        with self.assertRaises(errors.PolyForgeError) as caught:
            self._commit(preview, nodeMapping={QA_NODE: "qa_renamed_without_a_declaration"})
        self.assertEqual(caught.exception.code, errors.ErrorCode.RUN_BLOCKED)
        self.assertIn(
            "NODE_MAPPING_INCOMPLETE", [b["code"] for b in caught.exception.details["blockers"]]
        )
        self.assertEqual(self.db.scalar("SELECT COUNT(*) FROM graph_runs"), 1)

    def test_a_terminal_source_is_a_423(self) -> None:
        preview = self._plan()
        self.db.execute(
            "UPDATE graph_runs SET status = 'CANCELLED' WHERE run_id = ?", (self.run_id,)
        )
        with self.assertRaises(errors.PolyForgeError) as caught:
            self._commit(preview)
        self.assertEqual(caught.exception.code, errors.ErrorCode.RUN_BLOCKED)
        self.assertIn("TERMINAL_SOURCE", [b["code"] for b in caught.exception.details["blockers"]])

    def test_a_commit_without_approvals_is_a_403(self) -> None:
        preview = self._plan()
        with self.assertRaises(errors.PolyForgeError) as caught:
            self._commit(preview, approvalRefs=[])
        self.assertEqual(caught.exception.code, errors.ErrorCode.AUTHORIZATION_DENIED)

    def test_a_stale_expected_state_version_is_a_409(self) -> None:
        preview = self._plan()
        with self.assertRaises(errors.PolyForgeError) as caught:
            self._commit(preview, expectedStateVersion=999)
        self.assertEqual(caught.exception.code, errors.ErrorCode.VERSION_CONFLICT)
        self.assertIn("currentVersion", caught.exception.details)


class NoRegistryTests(unittest.TestCase):
    """An engine with no registry refuses to name a version, and says so in health."""

    def setUp(self) -> None:
        self.engine, self.db, self.clock = make_engine(with_registry=False)
        self.assertIsNone(self.engine.registry)

    def test_health_is_blocked_and_names_the_missing_registry(self) -> None:
        report = self.engine.health()
        self.assertEqual(report["status"], "blocked")
        self.assertFalse(report["store"]["registryWired"])
        self.assertTrue(any("graph registry" in issue for issue in report["issues"]))

    def test_resolving_a_version_is_unsupported_rather_than_a_guess(self) -> None:
        scope = Scope.from_wire(SCOPE_A)
        with self.assertRaises(errors.PolyForgeError) as caught:
            self.engine._resolve_version(scope=scope, graph_id=GRAPH_ID, version=1)
        self.assertEqual(caught.exception.code, errors.ErrorCode.UNSUPPORTED)
        self.assertIn("registry", caught.exception.message)
        with self.assertRaises(errors.PolyForgeError) as caught:
            self.engine._resolve_active_version(scope=scope, graph_id=GRAPH_ID)
        self.assertEqual(caught.exception.code, errors.ErrorCode.UNSUPPORTED)

    def test_admission_against_a_published_version_is_refused(self) -> None:
        request = work_order_request(start_intent_id="no-registry-1")
        request.pop("definition", None)
        with self.assertRaises(errors.PolyForgeError) as caught:
            self.engine.admit_work_order(request)
        self.assertEqual(caught.exception.code, errors.ErrorCode.UNSUPPORTED)
        self.assertEqual(self.db.scalar("SELECT COUNT(*) FROM graph_runs"), 0)

    def test_an_inline_definition_still_admits_without_a_registry(self) -> None:
        """The unpublished-graph path never needed a version from anywhere."""
        snapshot = self.engine.admit_work_order(work_order_request(start_intent_id="no-registry-2"))
        self.assertEqual(str(snapshot["status"]), str(GraphRunStatus.ACTIVE))
        self.assertEqual(int(snapshot["graphVersion"]), 0)

    def test_a_migration_cannot_resolve_its_target_without_a_registry(self) -> None:
        run_id = str(
            self.engine.admit_work_order(work_order_request(start_intent_id="no-registry-3"))[
                "runId"
            ]
        )
        with self.assertRaises(errors.PolyForgeError) as caught:
            self.engine.plan_migration(
                {"scope": SCOPE_A, "runId": run_id, "targetGraphVersion": 2}
            )
        self.assertEqual(caught.exception.code, errors.ErrorCode.UNSUPPORTED)


class RegistryRecordShapeTests(unittest.TestCase):
    """The resolver adapts to the registry's real return type, not to an assumed one."""

    def setUp(self) -> None:
        self.engine, self.db, self.clock = make_engine()
        self.registry = self.engine.registry
        self.published = published_version(self.registry, definition(), activate=False)

    def _resolve(self, version: int | None = None):
        scope = Scope.from_wire(SCOPE_A)
        if version is None:
            return self.engine._resolve_active_version(scope=scope, graph_id=GRAPH_ID)
        return self.engine._resolve_version(scope=scope, graph_id=GRAPH_ID, version=version)

    def test_a_dataclass_record_is_normalized_to_its_wire_shape(self) -> None:
        record = self._resolve(int(self.published.version))
        assert record is not None
        self.assertEqual(record["graphId"], GRAPH_ID)
        self.assertEqual(int(record["version"]), int(self.published.version))
        self.assertEqual(record["definitionHash"], self.published.definition_hash)
        self.assertIsInstance(record["closure"], dict)
        self.assertEqual(record["definition"]["graphId"], GRAPH_ID)
        self.assertIn(QA_NODE, record["definition"]["nodes"])

    def test_an_unpublished_version_resolves_to_none(self) -> None:
        self.assertIsNone(self._resolve(int(self.published.version) + 7))

    def test_no_pointer_resolves_to_none_rather_than_the_highest_version(self) -> None:
        published_version(self.registry, relabelled("a second, unactivated version"), activate=False)
        self.assertIsNone(self._resolve())

    def test_a_registry_without_either_pointer_reader_is_refused(self) -> None:
        class Pointerless:
            def get_version(self, graph_id, version, *, scope):  # noqa: ARG002 - the double
                raise AssertionError("the active pointer must be asked first")

        self.engine.registry = Pointerless()
        with self.assertRaises(errors.PolyForgeError) as caught:
            self._resolve()
        self.assertEqual(caught.exception.code, errors.ErrorCode.UNSUPPORTED)

    def test_a_registry_that_will_not_scope_its_read_is_refused(self) -> None:
        class Unscoped:
            def get_version(self, graph_id, version):  # noqa: ARG002 - the double's shape
                return self.published

        self.engine.registry = Unscoped()
        with self.assertRaises(errors.PolyForgeError) as caught:
            self._resolve(int(self.published.version))
        self.assertEqual(caught.exception.code, errors.ErrorCode.UNSUPPORTED)
        self.assertIn("scope", caught.exception.message)

    def test_a_registry_answering_with_nothing_recognisable_is_refused(self) -> None:
        self.engine.registry = type("Empty", (), {"get_version": lambda *a, **k: "v14"})()
        with self.assertRaises(errors.PolyForgeError) as caught:
            self._resolve(int(self.published.version))
        self.assertEqual(caught.exception.code, errors.ErrorCode.UNSUPPORTED)

    def test_the_artifact_view_carries_the_compiled_pins(self) -> None:
        record = self._resolve(int(self.published.version))
        assert record is not None
        artifact_view = self.engine._version_artifact(record)
        self.assertEqual(artifact_view["planHash"], self.published.plan_hash)
        self.assertEqual(
            artifact_view["dependencyLockHash"], self.published.dependency_lock_hash
        )
        self.assertEqual(artifact_view["compilerVersion"], self.published.compiler_version)
        self.assertEqual(artifact_view["definitionHash"], self.published.definition_hash)
        self.assertIn("graph.planHash", artifact_view["closure"])


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
