#!/usr/bin/env python3
"""Back up, inspect, and restore SQLite without loading the application or .env."""
from __future__ import annotations

import argparse
from contextlib import closing
import hashlib
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import time


class MaintenanceError(Exception):
    """An expected failure that must leave the original database untouched."""


def existing_database(path: Path) -> Path:
    path = path.expanduser().resolve(strict=True)
    if not path.is_file() or path.stat().st_size == 0:
        raise MaintenanceError("Source must be an existing, non-empty SQLite database.")
    return path


def read_only(path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=10)
    connection.execute("PRAGMA query_only=ON")
    return connection


def check_database(path: Path) -> None:
    """Check a consistent read snapshot; never initialize or migrate a database."""
    with closing(read_only(existing_database(path))) as connection:
        connection.execute("BEGIN")
        if connection.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
            raise MaintenanceError("SQLite integrity check failed.")
        if connection.execute("PRAGMA foreign_key_check").fetchone() is not None:
            raise MaintenanceError("SQLite foreign-key check failed.")


def copy_snapshot(source: Path, destination: Path, timeout: float = 60) -> Path:
    """Publish a checked, standalone snapshot atomically, without overwriting."""
    source = existing_database(source)
    destination = destination.expanduser().absolute()
    destination = destination.parent.resolve(strict=True) / destination.name
    if os.path.lexists(destination):
        raise MaintenanceError("Destination already exists; choose a new filename.")
    if timeout <= 0:
        raise MaintenanceError("Backup timeout must be greater than zero.")
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=".sqlite-snapshot-", suffix=".db", dir=destination.parent,
    )
    temporary = Path(temporary_name)
    os.close(descriptor)  # mkstemp creates the private file with mode 0600.
    deadline = time.monotonic() + timeout

    def progress(_status: int, _remaining: int, _total: int) -> None:
        if time.monotonic() > deadline:
            raise MaintenanceError("Backup timed out; no snapshot was published.")

    try:
        with closing(read_only(source)) as live, closing(sqlite3.connect(temporary)) as snapshot:
            live.backup(snapshot, pages=128, progress=progress, sleep=0.1)
            # Keep the result self-contained even when the source uses WAL.
            snapshot.execute("PRAGMA journal_mode=DELETE")
        check_database(temporary)
        with temporary.open("rb") as completed:
            os.fsync(completed.fileno())
        # Unlike replace()/rename(), link() fails if a competing writer created
        # the destination. The complete file becomes visible in one operation.
        os.link(temporary, destination)
        directory = os.open(destination.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
        return destination
    finally:
        temporary.unlink(missing_ok=True)
        for suffix in ("-journal", "-wal", "-shm"):
            Path(str(temporary) + suffix).unlink(missing_ok=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    backup = commands.add_parser("backup", help="Create a consistent online snapshot.")
    backup.add_argument("--database", type=Path, required=True)
    backup.add_argument("--output", type=Path, required=True)
    backup.add_argument("--timeout", type=float, default=60)
    check = commands.add_parser("check", help="Read-only integrity and foreign-key checks.")
    check.add_argument("--database", type=Path, required=True)
    restore = commands.add_parser("restore", help="Restore to a new path after stopping service writes.")
    restore.add_argument("--backup", type=Path, required=True)
    restore.add_argument("--output", type=Path, required=True)
    restore.add_argument("--service-stopped", action="store_true",
                         help="Confirm all application writers are stopped; this flag does not stop them.")
    args = parser.parse_args(argv)
    try:
        if args.command == "check":
            check_database(args.database)
            print("SQLite integrity and foreign-key checks passed.")
            return 0
        if args.command == "restore":
            if not args.service_stopped:
                raise MaintenanceError("Stop all application writers first, then provide --service-stopped.")
            check_database(args.backup)
            result = copy_snapshot(args.backup, args.output)
        else:
            result = copy_snapshot(args.database, args.output, args.timeout)
        digest = hashlib.sha256()
        with result.open("rb") as completed:
            for chunk in iter(lambda: completed.read(1024 * 1024), b""):
                digest.update(chunk)
        checksum = digest.hexdigest()
        print(f"Verified snapshot: {result}\nSHA-256: {checksum}")
        if args.command == "restore":
            print("Set DATABASE_PATH to this new file before restarting the service. The old database is unchanged.")
        return 0
    except (MaintenanceError, OSError, sqlite3.Error) as exc:
        print(f"Database maintenance failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
