"""Identifier and clock helpers.

Identifiers are opaque, sortable, and prefixed by kind so a log line or a foreign key is
self-describing. They are never derived from a random HTTP retry, and never reused for a
different logical object.

Clocks are injected so tests can freeze time. Nothing in the Core calls
``datetime.now()`` directly: a run that recovers after a restart must be able to reason
about lease expiry against a clock it controls.
"""

from __future__ import annotations

import os
import threading
import time
import uuid
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Final

__all__ = ["Clock", "SystemClock", "FrozenClock", "new_id", "now_iso", "parse_iso", "epoch_ms"]

_PREFIXES: Final[dict[str, str]] = {
    "graph": "grf",
    "draft": "drf",
    "version": "gvr",
    "work_order": "wo",
    "run": "run",
    "node": "nex",
    "attempt": "att",
    "contract": "tct",
    "checkpoint": "ckp",
    "effect": "eff",
    "artifact": "art",
    "evidence": "evd",
    "gate": "gat",
    "evaluation": "evl",
    "governance": "gov",
    "decision": "dec",
    "command": "cmd",
    "event": "evt",
    "subject": "sub",
    "binding": "bnd",
    "child": "chi",
    "migration": "mig",
    "projection": "prj",
    "intake": "in",
    "job": "job",
    "delivery": "dlv",
}


def new_id(kind: str) -> str:
    """Return a fresh opaque identifier for ``kind``."""
    prefix = _PREFIXES.get(kind, kind[:3] or "id")
    return f"{prefix}_{uuid.uuid4().hex}"


def now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse_iso(value: str) -> datetime:
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    parsed = datetime.fromisoformat(text)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def epoch_ms(moment: datetime | None = None) -> int:
    return int((moment or datetime.now(UTC)).timestamp() * 1000)


class SystemClock:
    """Wall-clock time in UTC, monotonic-anchored for lease arithmetic."""

    name = "system"

    def now(self) -> datetime:
        return datetime.now(UTC)

    def monotonic(self) -> float:
        return time.monotonic()

    def iso(self) -> str:
        return now_iso()

    def epoch_ms(self) -> int:
        return epoch_ms(self.now())


class FrozenClock:
    """A manually advanced clock for deterministic tests and dry runs."""

    name = "frozen"

    def __init__(self, start: str | datetime = "2026-01-01T00:00:00.000Z") -> None:
        self._now = parse_iso(start) if isinstance(start, str) else start
        self._lock = threading.Lock()

    def now(self) -> datetime:
        with self._lock:
            return self._now

    def monotonic(self) -> float:
        return self.now().timestamp()

    def iso(self) -> str:
        return self.now().isoformat(timespec="milliseconds").replace("+00:00", "Z")

    def epoch_ms(self) -> int:
        return epoch_ms(self.now())

    def advance(self, seconds: float) -> None:
        from datetime import timedelta

        with self._lock:
            self._now = self._now + timedelta(seconds=seconds)

    def set(self, moment: str | datetime) -> None:
        with self._lock:
            self._now = parse_iso(moment) if isinstance(moment, str) else moment


Clock = SystemClock


def process_tag() -> str:
    """Short identifier for the current process, used in claim fencing diagnostics."""
    return f"{os.getpid()}:{uuid.uuid4().hex[:6]}"


ClockFactory = Callable[[], SystemClock | FrozenClock]
