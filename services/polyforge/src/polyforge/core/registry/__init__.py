"""Graph registry: mutable drafts, immutable published versions, default-version pointer.

The registry is the only writer of a published version. There is deliberately no update or
delete path for one: editing happens on a draft, publishing inserts a new version, and a
version that is still referenced by a run, an approval or an audit record stays readable
after it is retired.
"""

from __future__ import annotations

from polyforge.core.registry.models import (
    GraphDefaultPointer,
    GraphDraft,
    GraphVersion,
    GraphVersionSummary,
    empty_definition,
    normalize_scope,
    scope_key,
)
from polyforge.core.registry.store import REQUIRED_TABLES, RegistryStore

__all__ = [
    "GraphDefaultPointer",
    "GraphDraft",
    "GraphVersion",
    "GraphVersionSummary",
    "RegistryStore",
    "REQUIRED_TABLES",
    "empty_definition",
    "normalize_scope",
    "scope_key",
]
