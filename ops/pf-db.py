#!/usr/bin/env python3
"""Online Runtime SQLite backup, integrity verification, and offline guarded restore."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from db_admin import DatabaseAdminError, create_backup, restore_backup, verify_backup


def defaults() -> tuple[Path, Path, Path, str]:
    data_dir = Path(os.environ.get("PF_DATA_DIR", Path.home() / ".polyforge")).expanduser()
    database = Path(os.environ.get("POLYFORGE_DB", data_dir / "polyforge.sqlite")).expanduser()
    backup_dir = Path(os.environ.get("POLYFORGE_BACKUP_DIR", data_dir / "backups")).expanduser()
    pidfile = Path(os.environ.get("POLYFORGE_RUNTIME_PIDFILE", data_dir / "runtime.pid")).expanduser()
    service_url = os.environ.get("PF_SERVICE_URL", "http://127.0.0.1:8787").rstrip("/")
    return database, backup_dir, pidfile, f"{service_url}/v1/health/live"


def parser() -> argparse.ArgumentParser:
    database, backup_dir, pidfile, health_url = defaults()
    root = argparse.ArgumentParser(description=__doc__)
    commands = root.add_subparsers(dest="command", required=True)

    backup = commands.add_parser("backup", help="take an online, integrity-checked SQLite snapshot")
    backup.add_argument("--db", type=Path, default=database)
    backup.add_argument("--output-dir", type=Path, default=backup_dir)

    verify = commands.add_parser("verify", help="verify one backup and its checksum manifest")
    verify.add_argument("backup", type=Path)

    restore = commands.add_parser("restore", help="replace a stopped Runtime database from a verified backup")
    restore.add_argument("--backup", type=Path, required=True)
    restore.add_argument("--db", type=Path, default=database)
    restore.add_argument("--backup-dir", type=Path, default=backup_dir)
    restore.add_argument("--pidfile", type=Path, default=pidfile)
    restore.add_argument("--health-url", default=health_url)
    restore.add_argument("--confirm-restore", action="store_true", help="required explicit confirmation for replacement")
    return root


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        if args.command == "backup":
            result = create_backup(args.db, args.output_dir)
        elif args.command == "verify":
            result = verify_backup(args.backup)
        else:
            result = restore_backup(
                args.backup,
                args.db,
                args.backup_dir,
                args.pidfile,
                args.health_url,
                confirmed=args.confirm_restore,
            )
    except (DatabaseAdminError, OSError, ValueError) as exc:
        print(f"database operation refused: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(result, sort_keys=True, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
