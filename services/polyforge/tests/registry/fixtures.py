"""Shared fixtures for the registry tests.

A *reviewed draft* is the only thing ``publish_version`` accepts: current revision, current
validation, current compile artifact, and a review bound to the exact target hash a human
saw. The helper builds exactly that, with the same shape the HTTP layer would build, so a
test that publishes is testing the real gate chain rather than a shortcut through it.
"""

from __future__ import annotations

import unittest
from typing import Any, Mapping

from polyforge import COMPILER_VERSION
from polyforge.core import hashing
from polyforge.core.compiler.compile import compile_definition
from polyforge.core.compiler.validate import validate_definition
from polyforge.core.registry.store import RegistryStore
from polyforge.graph_library import dependency_lock_for
from services.polyforge.tests.registry.fake_db import close, memory_database
COMPANY = "co_alpha"
PROJECT = "pr_core"
SCOPE = {"companyRef": COMPANY, "projectRef": PROJECT}
OTHER_SCOPE = {"companyRef": "co_beta", "projectRef": PROJECT}


def decision_target_hash(definition_hash: str, plan_hash: str) -> str:
    """What a reviewer actually signs: definition, plan, compiler and the reviewed node set."""
    return hashing.hash_domain(
        "pf.decision-target",
        {
            "definitionHash": definition_hash,
            "planHash": plan_hash,
            "compilerVersion": COMPILER_VERSION,
        },
    )


def new_store(db: object | None = None, *, clock: object | None = None) -> RegistryStore:
    """A store over an injected database (or a fresh in-memory one)."""
    return RegistryStore(db if db is not None else memory_database(), clock=clock)


class StoreTestCase(unittest.TestCase):
    """Base for the registry tests: one in-memory database per test, closed afterwards."""

    #: ``core`` uses the real ``Database`` when it exists, ``connection`` and
    #: ``execute-only`` force a double so the database seam stays covered either way.
    database_shape = "core"

    def setUp(self) -> None:
        self.db = memory_database(self.database_shape)
        self.addCleanup(close, self.db)
        self.store = RegistryStore(self.db)


def reviewed_draft(
    store: RegistryStore,
    definition: Mapping[str, Any],
    *,
    author: str = "eng:dana",
    reviewer: str = "human:ravi",
    scope: Mapping[str, str] = SCOPE,
    authorization_refs: tuple[str, ...] = (),
) -> dict[str, Any]:
    """Create, validate, compile and review a draft. Returns everything publish needs."""
    graph_id = str(definition["graphId"])
    draft = store.create_draft(
        company_ref=scope["companyRef"],
        project_ref=scope["projectRef"],
        graph_id=graph_id,
        author=author,
        definition=definition,
    )
    report = validate_definition(definition)
    draft = store.record_validation(draft.draft_id, report, scope=scope)
    artifact = compile_definition(definition, dependency_lock=dependency_lock_for(graph_id))
    draft = store.record_compile(draft.draft_id, artifact, scope=scope)
    target = decision_target_hash(report.definition_hash, artifact.plan_hash)
    draft = store.record_review(
        draft.draft_id,
        review_target_hash=target,
        reviewer=reviewer,
        scope=scope,
        authorization_refs=authorization_refs,
    )
    return {
        "draft": draft,
        "graphId": graph_id,
        "report": report,
        "artifact": artifact,
        "reviewTargetHash": target,
        "authorizationRefs": list(authorization_refs),
    }
