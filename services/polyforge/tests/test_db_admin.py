from __future__ import annotations

import sqlite3
import sys
import tempfile
import threading
import errno
import urllib.error
from contextlib import closing
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from unittest import TestCase
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "ops"))

from db_admin import (  # noqa: E402
    DatabaseAdminError,
    _runtime_maintenance_lock,
    create_backup,
    restore_backup,
    verify_backup,
)


def write_db(path: Path, value: str) -> None:
    with closing(sqlite3.connect(path)) as connection:
        connection.execute("CREATE TABLE IF NOT EXISTS payload (value TEXT NOT NULL)")
        connection.execute("DELETE FROM payload")
        connection.execute("INSERT INTO payload VALUES (?)", (value,))
        connection.commit()


def runtime_is_stopped(*_args: object, **_kwargs: object) -> None:
    raise urllib.error.URLError(ConnectionRefusedError(errno.ECONNREFUSED, "connection refused"))


class LiveHealthHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"live")

    def log_message(self, *_args: object) -> None:
        pass


class DatabaseAdminTests(TestCase):
    def test_backup_verify_and_guarded_restore_round_trip(self) -> None:
        with tempfile.TemporaryDirectory(prefix="pf-db-admin-") as temp:
            root = Path(temp)
            source = root / "runtime.sqlite"
            write_db(source, "backup-state")
            result = create_backup(source, root / "backups")
            backup = Path(str(result["path"]))
            self.assertEqual(verify_backup(backup)["integrity"], "ok")

            write_db(source, "newer-state")
            with self.assertRaisesRegex(DatabaseAdminError, "explicit --confirm-restore"):
                restore_backup(
                    backup,
                    source,
                    root / "backups",
                    root / "runtime.pid",
                    "http://127.0.0.1:1/health",
                    confirmed=False,
                )

            with patch("db_admin.urllib.request.urlopen", side_effect=runtime_is_stopped):
                restored = restore_backup(
                    backup,
                    source,
                    root / "backups",
                    root / "runtime.pid",
                    "http://127.0.0.1:1/health",
                    confirmed=True,
                )
            self.assertIsNotNone(restored["preRestoreBackup"])
            with closing(sqlite3.connect(source)) as connection:
                self.assertEqual(connection.execute("SELECT value FROM payload").fetchone()[0], "backup-state")
            pre_restore = Path(str(restored["preRestoreBackup"]["path"]))
            self.assertEqual(verify_backup(pre_restore)["integrity"], "ok")
            with closing(sqlite3.connect(pre_restore)) as connection:
                self.assertEqual(connection.execute("SELECT value FROM payload").fetchone()[0], "newer-state")

    def test_restore_refuses_a_live_runtime_and_leaves_database_untouched(self) -> None:
        with tempfile.TemporaryDirectory(prefix="pf-db-live-guard-") as temp:
            root = Path(temp)
            source = root / "source.sqlite"
            target = root / "target.sqlite"
            write_db(source, "backup-state")
            write_db(target, "target-state")
            backup = Path(str(create_backup(source, root / "backups")["path"]))
            server = HTTPServer(("127.0.0.1", 0), LiveHealthHandler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                url = f"http://127.0.0.1:{server.server_port}/v1/health/live"
                with self.assertRaisesRegex(DatabaseAdminError, "answered health check"):
                    restore_backup(backup, target, root / "backups", root / "runtime.pid", url, confirmed=True)
                with closing(sqlite3.connect(target)) as connection:
                    self.assertEqual(connection.execute("SELECT value FROM payload").fetchone()[0], "target-state")
            finally:
                server.shutdown()
                thread.join(timeout=2)
                server.server_close()

    def test_restore_refuses_an_existing_pidfile_or_wal_sidecar(self) -> None:
        with tempfile.TemporaryDirectory(prefix="pf-db-sidecars-") as temp:
            root = Path(temp)
            source = root / "source.sqlite"
            target = root / "target.sqlite"
            write_db(source, "backup-state")
            write_db(target, "target-state")
            backup = Path(str(create_backup(source, root / "backups")["path"]))
            pidfile = root / "runtime.pid"
            pidfile.write_text("not-safe-to-guess\n", encoding="utf-8")
            with self.assertRaisesRegex(DatabaseAdminError, "pidfile still exists"):
                restore_backup(backup, target, root / "backups", pidfile, "http://127.0.0.1:1/health", confirmed=True)
            pidfile.unlink()
            Path(f"{target}-wal").write_bytes(b"stale wal")
            with patch("db_admin.urllib.request.urlopen", side_effect=runtime_is_stopped):
                with self.assertRaisesRegex(DatabaseAdminError, "WAL sidecar"):
                    restore_backup(backup, target, root / "backups", pidfile, "http://127.0.0.1:1/health", confirmed=True)
            with closing(sqlite3.connect(target)) as connection:
                self.assertEqual(connection.execute("SELECT value FROM payload").fetchone()[0], "target-state")

    def test_restore_refuses_while_runtime_startup_holds_the_maintenance_lock(self) -> None:
        with tempfile.TemporaryDirectory(prefix="pf-db-lock-guard-") as temp:
            root = Path(temp)
            source = root / "source.sqlite"
            target = root / "target.sqlite"
            write_db(source, "backup-state")
            write_db(target, "target-state")
            backup = Path(str(create_backup(source, root / "backups")["path"]))
            pidfile = root / "runtime.pid"

            with _runtime_maintenance_lock(root / "runtime-maintenance.lock"):
                with self.assertRaisesRegex(DatabaseAdminError, "maintenance lock is already held"):
                    restore_backup(
                        backup,
                        target,
                        root / "backups",
                        pidfile,
                        "http://127.0.0.1:1/health",
                        confirmed=True,
                    )

            with closing(sqlite3.connect(target)) as connection:
                self.assertEqual(connection.execute("SELECT value FROM payload").fetchone()[0], "target-state")

    def test_verify_rejects_a_changed_backup_and_non_loopback_health_url(self) -> None:
        with tempfile.TemporaryDirectory(prefix="pf-db-invalid-") as temp:
            root = Path(temp)
            source = root / "source.sqlite"
            write_db(source, "backup-state")
            backup = Path(str(create_backup(source, root / "backups")["path"]))
            with backup.open("ab") as stream:
                stream.write(b"changed")
            with self.assertRaisesRegex(DatabaseAdminError, "digest or size"):
                verify_backup(backup)

            # An unhealthy remote URL is not evidence that the local Runtime stopped.
            fresh = Path(str(create_backup(source, root / "backups")["path"]))
            with self.assertRaisesRegex(DatabaseAdminError, "restricted to a loopback"):
                restore_backup(
                    fresh,
                    root / "target.sqlite",
                    root / "backups",
                    root / "runtime.pid",
                    "http://example.invalid/health",
                    confirmed=True,
                )
