"""Safe, stdlib-only online SQLite backup and guarded restore for the PolyForge Runtime."""

from __future__ import annotations

import hashlib
import ipaddress
import errno
import json
import os
import re
import shutil
import sqlite3
import tempfile
from contextlib import closing, contextmanager
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from secrets import token_hex
from urllib.parse import urlparse
from typing import Iterator


class DatabaseAdminError(RuntimeError):
    """An operator action was refused or a database artifact failed verification."""


@contextmanager
def _runtime_maintenance_lock(lock_path: Path) -> Iterator[None]:
    """Exclude Runtime startup while a guarded database replacement is in progress."""
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a+b") as lock_file:
        if lock_path.stat().st_size == 0:
            lock_file.write(b"\0")
            lock_file.flush()
        lock_file.seek(0)
        try:
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(lock_file.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except (OSError, BlockingIOError) as exc:
            raise DatabaseAdminError(f"Runtime maintenance lock is already held: {lock_path}") from exc
        try:
            yield
        finally:
            lock_file.seek(0)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(lock_file.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)


def _integrity_check(path: Path) -> None:
    try:
        with closing(sqlite3.connect(path)) as connection:
            rows = connection.execute("PRAGMA integrity_check").fetchall()
    except sqlite3.DatabaseError as exc:
        raise DatabaseAdminError(f"not a readable SQLite database: {path.name}") from exc
    if rows != [("ok",)]:
        details = "; ".join(str(row[0]) for row in rows[:8])
        raise DatabaseAdminError(f"SQLite integrity_check failed: {details}")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _sync(path: Path) -> None:
    with path.open("r+b") as stream:
        os.fsync(stream.fileno())


def create_backup(source: Path, backup_dir: Path, *, prefix: str = "polyforge") -> dict[str, object]:
    """Take a consistent online SQLite snapshot and atomically publish it with a digest sidecar."""
    source = source.expanduser().resolve(strict=True)
    backup_dir = backup_dir.expanduser().resolve()
    if not source.is_file() or source.stat().st_size == 0:
        raise DatabaseAdminError("source database must be an existing, non-empty file")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", prefix):
        raise DatabaseAdminError("backup prefix may contain only letters, digits, dot, underscore, and dash")

    backup_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    db_fd, db_temp_name = tempfile.mkstemp(prefix=".pf-db-", suffix=".sqlite.tmp", dir=backup_dir)
    os.close(db_fd)
    metadata_temp_name: str | None = None
    final_db: Path | None = None
    final_metadata: Path | None = None
    published_db = False
    try:
        db_temp = Path(db_temp_name)
        with closing(sqlite3.connect(source, timeout=30)) as live, closing(
            sqlite3.connect(db_temp, timeout=30)
        ) as snapshot:
            live.backup(snapshot, pages=256, sleep=0.05)
            snapshot.commit()
            rows = snapshot.execute("PRAGMA integrity_check").fetchall()
        if rows != [("ok",)]:
            raise DatabaseAdminError(f"SQLite snapshot failed integrity_check: {rows[:8]}")
        _sync(db_temp)
        digest = _sha256(db_temp)
        now = datetime.now(timezone.utc)
        name = f"{prefix}-{now.strftime('%Y%m%dT%H%M%SZ')}-{token_hex(4)}.sqlite"
        final_db = backup_dir / name
        final_metadata = final_db.with_suffix(".json")
        metadata = {
            "formatVersion": 1,
            "createdAt": now.isoformat().replace("+00:00", "Z"),
            "sourceName": source.name,
            "databaseFile": final_db.name,
            "sizeBytes": db_temp.stat().st_size,
            "sha256": digest,
        }
        meta_fd, metadata_temp_name = tempfile.mkstemp(prefix=".pf-meta-", suffix=".json.tmp", dir=backup_dir)
        with os.fdopen(meta_fd, "w", encoding="utf-8") as stream:
            json.dump(metadata, stream, sort_keys=True, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())

        os.replace(db_temp, final_db)
        published_db = True
        os.replace(metadata_temp_name, final_metadata)
        metadata_temp_name = None
        return {**metadata, "path": str(final_db), "metadataPath": str(final_metadata)}
    except Exception:
        if published_db and final_db is not None:
            final_db.unlink(missing_ok=True)
        if final_metadata is not None:
            final_metadata.unlink(missing_ok=True)
        raise
    finally:
        Path(db_temp_name).unlink(missing_ok=True)
        if metadata_temp_name is not None:
            Path(metadata_temp_name).unlink(missing_ok=True)


def verify_backup(backup: Path) -> dict[str, object]:
    """Verify the backup's digest sidecar and SQLite integrity before restore or inspection."""
    backup = backup.expanduser().resolve(strict=True)
    metadata_path = backup.with_suffix(".json")
    try:
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise DatabaseAdminError("backup digest metadata is missing or invalid") from exc
    if metadata.get("formatVersion") != 1 or metadata.get("databaseFile") != backup.name:
        raise DatabaseAdminError("backup metadata does not describe this file")
    actual_size = backup.stat().st_size
    if metadata.get("sizeBytes") != actual_size or metadata.get("sha256") != _sha256(backup):
        raise DatabaseAdminError("backup digest or size does not match its metadata")
    _integrity_check(backup)
    return {**metadata, "path": str(backup), "metadataPath": str(metadata_path), "integrity": "ok"}


def _require_runtime_offline(pidfile: Path, health_url: str) -> None:
    if pidfile.exists():
        raise DatabaseAdminError(
            f"Runtime pidfile still exists at {pidfile}; stop the service and resolve any stale pidfile first"
        )
    parsed = urlparse(health_url)
    if parsed.scheme not in {"http", "https"} or parsed.hostname is None:
        raise DatabaseAdminError("health URL must be an absolute HTTP(S) URL")
    host = parsed.hostname.lower()
    is_loopback = host == "localhost"
    try:
        is_loopback = is_loopback or ipaddress.ip_address(host).is_loopback
    except ValueError:
        pass
    if not is_loopback:
        raise DatabaseAdminError("restore health check is restricted to a loopback Runtime Service")

    request = urllib.request.Request(health_url, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=2) as response:
            raise DatabaseAdminError(f"Runtime Service answered health check with HTTP {response.status}; restore refused")
    except urllib.error.HTTPError as exc:
        raise DatabaseAdminError(f"Runtime Service answered health check with HTTP {exc.code}; restore refused") from exc
    except urllib.error.URLError as exc:
        reason = exc.reason
        if not isinstance(reason, OSError) or getattr(reason, "errno", None) not in {errno.ECONNREFUSED, 10061}:
            raise DatabaseAdminError(f"could not prove Runtime Service is stopped: {reason}") from exc


def restore_backup(
    backup: Path,
    target: Path,
    backup_dir: Path,
    pidfile: Path,
    health_url: str,
    *,
    confirmed: bool,
) -> dict[str, object]:
    """Atomically restore a verified backup after proving the local Runtime is stopped."""
    if not confirmed:
        raise DatabaseAdminError("restore requires the explicit --confirm-restore flag")
    backup = backup.expanduser().resolve(strict=True)
    target = target.expanduser()
    if target.is_symlink():
        raise DatabaseAdminError("refusing to replace a symlink database path")
    target = target.absolute()
    if target.exists() and os.path.samefile(backup, target):
        raise DatabaseAdminError("backup and restore target must be different files")
    report = verify_backup(backup)
    pidfile = pidfile.expanduser().absolute()
    maintenance_lock = pidfile.parent / "runtime-maintenance.lock"
    with _runtime_maintenance_lock(maintenance_lock):
        _require_runtime_offline(pidfile, health_url)

        sidecars = [Path(f"{target}-wal"), Path(f"{target}-shm")]
        existing_sidecars = [str(path) for path in sidecars if path.exists()]
        if existing_sidecars:
            raise DatabaseAdminError(
                "SQLite WAL sidecar(s) remain beside the stopped database; inspect/quarantine them before restore: "
                + ", ".join(existing_sidecars)
            )

        backup_dir = backup_dir.expanduser().resolve()
        pre_restore = None
        if target.exists():
            pre_restore = create_backup(target, backup_dir, prefix="polyforge-pre-restore")

        target.parent.mkdir(parents=True, exist_ok=True)
        fd, temp_name = tempfile.mkstemp(prefix=f".{target.name}.restore-", suffix=".tmp", dir=target.parent)
        os.close(fd)
        temp_path = Path(temp_name)
        try:
            with backup.open("rb") as source, temp_path.open("wb") as destination:
                shutil.copyfileobj(source, destination, length=1024 * 1024)
                destination.flush()
                os.fsync(destination.fileno())
            _integrity_check(temp_path)
            os.replace(temp_path, target)
        finally:
            temp_path.unlink(missing_ok=True)

    return {
        "restoredFrom": str(backup),
        "target": str(target),
        "sha256": report["sha256"],
        "preRestoreBackup": pre_restore,
    }
