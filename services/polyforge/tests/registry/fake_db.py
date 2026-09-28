"""Database doubles for the registry tests.

``polyforge.core.store.db.Database`` is the real dependency and is preferred whenever it
imports. These two stand-ins exist for two reasons: the suite must still run before that
component lands, and the store's database seam claims to accept more than one shape — this
is what proves the claim.

``ConnectionShapeDatabase`` exposes ``.connection`` (a ``sqlite3`` connection).
``ExecuteOnlyDatabase`` exposes just ``execute``/``commit``, the narrowest supported shape,
so running against it proves the store does not secretly depend on anything wider.
"""

from __future__ import annotations

import sqlite3

__all__ = ["ConnectionShapeDatabase", "ExecuteOnlyDatabase", "core_database", "memory_database"]


class ConnectionShapeDatabase:
    """``Database`` shape with a ``.connection`` attribute."""

    def __init__(self, path: str = ":memory:") -> None:
        self.path = path
        self._connection = sqlite3.connect(path)
        self._connection.row_factory = sqlite3.Row

    @property
    def connection(self) -> sqlite3.Connection:
        return self._connection

    def close(self) -> None:
        self._connection.close()


class ExecuteOnlyDatabase:
    """``Database`` shape with only ``execute`` and ``commit``."""

    def __init__(self, path: str = ":memory:") -> None:
        self.path = path
        self._connection = sqlite3.connect(path)
        self._connection.row_factory = sqlite3.Row

    def execute(self, sql: str, params: tuple = ()) -> sqlite3.Cursor:
        return self._connection.execute(sql, params)

    def commit(self) -> None:
        self._connection.commit()

    def close(self) -> None:
        self._connection.close()


def memory_database(shape: str = "core") -> object:
    """One in-memory database.

    ``shape="core"`` uses the real ``Database`` when it is importable and the
    ``.connection`` double otherwise, so the suite runs before and after that component
    lands. The other shapes always use a double, because their purpose is to cover the
    seam itself.
    """
    if shape == "core":
        database = core_database()
        return database if database is not None else ConnectionShapeDatabase(":memory:")
    if shape == "execute-only":
        return ExecuteOnlyDatabase(":memory:")
    return ConnectionShapeDatabase(":memory:")


def core_database(path: str = ":memory:") -> object | None:
    """The real Core database, or ``None`` when that component has not landed yet."""
    try:
        from polyforge.core.store.db import Database
    except Exception:
        return None
    return Database(path)


def close(database: object) -> None:
    """Close whichever close method the database exposes."""
    closer = getattr(database, "close", None)
    if callable(closer):
        closer()
