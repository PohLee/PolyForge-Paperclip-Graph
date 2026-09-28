"""Graph compiler: validation, deterministic plans, semantic diff, policy baseline.

Layering, so the import graph stays acyclic:

``policy_catalog``  versioned baseline policies; knows nothing about nodes.
``validate``        the semantic gate every definition must pass before it can compile.
``compile``         deterministic plan + pinned version closure.
``diff``            what changed between two definitions, and what that invalidates.

Nothing here mutates a database, starts work, or knows about a provider.
"""

from __future__ import annotations

from polyforge.core.compiler.compile import (
    CompileArtifact,
    compile_definition,
    dependency_lock_for,
    required_pins,
    step_id_for,
)
from polyforge.core.compiler.diff import SemanticDiff, semantic_diff
from polyforge.core.compiler.policy_catalog import (
    CEILINGS,
    POLICY_CATALOG_VERSION,
    PolicyViolation,
    check_definition_policy,
)
from polyforge.core.compiler.validate import (
    ISSUE_CODES,
    ValidationIssue,
    ValidationReport,
    definition_hash,
    validate_definition,
)

__all__ = [
    "CEILINGS",
    "CompileArtifact",
    "ISSUE_CODES",
    "POLICY_CATALOG_VERSION",
    "PolicyViolation",
    "SemanticDiff",
    "ValidationIssue",
    "ValidationReport",
    "check_definition_policy",
    "compile_definition",
    "definition_hash",
    "dependency_lock_for",
    "required_pins",
    "semantic_diff",
    "step_id_for",
    "validate_definition",
]
