"""PolyForge Graph Core.

The Core is the single authority for engineering correctness: graph structure, contracts,
evidence, gates, and the durable runtime that executes them. It never imports a Paperclip
SDK type, never reads a Paperclip database, and never treats a platform status as an
engineering fact.

Module map (``docs/02-TECHNICAL-PLAN.md`` section 1.1)::

    registry/     definitions, drafts, versions, dependency lock
    compiler/     validation and deterministic plans
    entrypoints/  admission and preconditions
    contracts/    effective policy and the transition contract
    evidence/     ingestion, lineage, invalidation
    gates/        evaluator registry and gate aggregation
    runtime/      runs, claims, checkpoints, effects, recovery
    ports/        provider-neutral Protocol interfaces
    migrations/   additive Core schema migrations
    store/        durable GraphStore

Invariants that hold for every module below this one:

* Platform objects cross the boundary only as provider-neutral references, always scoped by
  company and project.
* No module calls a wall clock directly; a clock is injected so recovery and tests can
  reason about lease expiry.
* A failure is a :class:`PolyForgeError` with a stable code. Nothing returns a value that
  a caller could mistake for success.
"""

from __future__ import annotations

from polyforge import COMPILER_VERSION, PROTOCOL_VERSION, SCHEMA_VERSION

__all__ = ["COMPILER_VERSION", "PROTOCOL_VERSION", "SCHEMA_VERSION"]
