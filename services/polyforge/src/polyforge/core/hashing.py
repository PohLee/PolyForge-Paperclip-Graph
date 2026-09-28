"""Canonical JSON encoding and content hashing.

This is the Python twin of ``packages/protocol/src/canonical.ts``. The two implementations
must agree byte for byte; ``tests/contract/test_canonical_conformance.py`` holds a shared
fixture set so a divergence fails the contract suite instead of silently producing two
incompatible identity spaces.

Normative rules (``docs/05-PROTOCOL.md`` section 2):

1. Encoding is UTF-8.
2. Object keys are sorted ascending by their Unicode code points, which is byte order for
   the key subset this system emits.
3. ``None`` values are omitted from objects. ``None`` inside an array is an error.
4. A missing key and an explicit ``null`` are different: use ``OMIT`` to omit.
5. Arrays keep their order; order is semantic for ``edges``, ``nodeIds``, ``evidenceIds``.
6. Numbers must be finite. ``-0.0`` normalizes to ``0``. ``bool`` is a distinct type from
   ``int`` and is never encoded as a number.
7. No insignificant whitespace.
8. ``float`` values are emitted with ``repr`` (shortest round-tripping form). Integral
   floats collapse to an integer literal so ``1.0`` and ``1`` hash identically.

``OMIT`` sentinel: use ``hashing.OMIT`` to explicitly drop a key.
"""

from __future__ import annotations

import hashlib
import json
import math
from typing import Any, Final

__all__ = [
    "OMIT",
    "CanonicalJsonError",
    "canonical_bytes",
    "canonical_json",
    "digest_bytes",
    "digest_text",
    "hash_canonical",
    "hash_domain",
    "strip_for_hash",
]


class _Omit:
    """Sentinel marking a value that must be omitted from the canonical encoding."""

    _instance: "_Omit | None" = None

    def __new__(cls) -> "_Omit":
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return "OMIT"

    def __bool__(self) -> bool:
        return False


OMIT: Final[_Omit] = _Omit()


class CanonicalJsonError(TypeError):
    """Raised when a value cannot be canonically encoded."""

    def __init__(self, message: str, path: str = "$") -> None:
        super().__init__(f"{message} at {path}")
        self.path = path


def _encode(value: Any, path: str, out: list[str]) -> None:
    if value is OMIT:
        raise CanonicalJsonError("OMIT is only valid as an object value", path)

    if value is None:
        out.append("null")
        return

    if isinstance(value, bool):
        out.append("true" if value else "false")
        return

    if isinstance(value, int):
        out.append(str(value))
        return

    if isinstance(value, float):
        if not math.isfinite(value):
            raise CanonicalJsonError(f"non-finite float is not encodable ({value!r})", path)
        if value == 0.0:
            out.append("0")
            return
        if value.is_integer() and abs(value) < 1e16:
            out.append(str(int(value)))
            return
        out.append(repr(value))
        return

    if isinstance(value, str):
        out.append(json.dumps(value, ensure_ascii=False))
        return

    if isinstance(value, (list, tuple)):
        out.append("[")
        for index, item in enumerate(value):
            if index:
                out.append(",")
            _encode(item, f"{path}[{index}]", out)
        out.append("]")
        return

    if isinstance(value, dict):
        keys = []
        for key in value.keys():
            if not isinstance(key, str):
                raise CanonicalJsonError(f"object keys must be strings, got {type(key).__name__}", path)
            if value[key] is OMIT:
                continue
            keys.append(key)
        keys.sort()
        out.append("{")
        first = True
        for key in keys:
            if not first:
                out.append(",")
            first = False
            out.append(json.dumps(key, ensure_ascii=False))
            out.append(":")
            _encode(value[key], f"{path}.{key}" if path != "$" else key, out)
        out.append("}")
        return

    if isinstance(value, (set, frozenset)):
        raise CanonicalJsonError("sets have no canonical order; use a sorted list", path)

    if hasattr(value, "to_canonical"):
        _encode(value.to_canonical(), path, out)
        return

    raise CanonicalJsonError(f"unsupported value of type {type(value).__name__}", path)


def canonical_json(value: Any) -> str:
    """Return the canonical JSON text for ``value``."""
    out: list[str] = []
    _encode(value, "$", out)
    return "".join(out)


def canonical_bytes(value: Any) -> bytes:
    """Return the UTF-8 bytes of the canonical encoding."""
    return canonical_json(value).encode("utf-8")


def digest_bytes(data: bytes) -> str:
    """Return ``sha256:<hex>`` for raw bytes."""
    return "sha256:" + hashlib.sha256(data).hexdigest()


def digest_text(text: str) -> str:
    """Return ``sha256:<hex>`` for a UTF-8 string."""
    return digest_bytes(text.encode("utf-8"))


def hash_canonical(value: Any) -> str:
    """Return ``sha256:<hex>`` of the canonical encoding of ``value``."""
    return digest_bytes(canonical_bytes(value))


def hash_domain(domain: str, value: Any) -> str:
    """Domain-separated hash.

    Mixing the domain in keeps identity classes disjoint: an evidence-set hash can never
    collide with a contract hash even if the hashed payloads happen to be equal.
    """
    return hash_canonical({"domain": domain, "value": value})


_MUTABLE_BOOKKEEPING_KEYS = frozenset(
    {
        "createdAt",
        "created_at",
        "updatedAt",
        "updated_at",
        "startedAt",
        "started_at",
        "finishedAt",
        "finished_at",
        "projectionVersion",
        "projection_version",
        "lastEventSeq",
        "last_event_seq",
    }
)

# Callers that need a status field excluded from an immutable hash must opt in by name.
# Nothing is stripped implicitly beyond wall-clock bookkeeping: a graph definition may
# legitimately carry a field called ``status`` that is part of its meaning.
_MUTABLE_STATUS_KEYS = frozenset({"status", "state", "layout"})


def strip_for_hash(value: Any, extra_mutable_keys: frozenset[str] | set[str] = frozenset()) -> Any:
    """Remove mutable bookkeeping fields before hashing.

    Wall-clock timestamps and projection bookkeeping are always excluded: a contract hash
    that changed every time a row was touched would make idempotency impossible. Semantic
    fields are only excluded when the caller names them explicitly, because a field called
    ``status`` inside a graph definition is part of that definition's meaning.
    """
    excluded = _MUTABLE_BOOKKEEPING_KEYS | frozenset(extra_mutable_keys)
    if isinstance(value, dict):
        return {
            key: strip_for_hash(item, extra_mutable_keys)
            for key, item in value.items()
            if key not in excluded and item is not OMIT
        }
    if isinstance(value, list):
        return [strip_for_hash(item, extra_mutable_keys) for item in value]
    return value
