"""Same-instance production maintenance; no providers, .env, or private log data."""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager, closing
from datetime import datetime, timezone
import logging
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import sys
import threading
import tempfile
import time

from .auth import cleanup_expired

LOGGER = logging.getLogger("uvicorn.error.maintenance")
ROOT = Path(__file__).resolve().parents[2]
DAILY_NAME = re.compile(r"auto-daily-\d{8}T\d{12}Z\.db\Z")


class ProductionMaintenance:
    """One worker per deployed API instance; the launcher enforces one worker."""

    def __init__(self, database, *, interval: float = 900, backup_timeout: float = 120):
        self.database = database
        self.interval = interval
        self.backup_timeout = backup_timeout
        self.stopping = threading.Event()
        self.thread: threading.Thread | None = None

    def start(self) -> None:
        self.thread = threading.Thread(target=self.run, name="production-maintenance", daemon=False)
        self.thread.start()

    def stop(self) -> None:
        self.stopping.set()
        if self.thread is not None:
            self.thread.join()

    def run(self) -> None:
        while not self.stopping.is_set():
            try:
                self.cycle()
            except Exception:
                if not self.stopping.is_set():
                    LOGGER.error("maintenance_cycle_failed")
            self.stopping.wait(self.interval)

    def cycle(self) -> None:
        # Never initialize a replacement DB after a lost mount or removed file.
        path = Path(self.database.path)
        if not path.is_file() or path.is_symlink():
            LOGGER.error("maintenance_database_unavailable")
            return
        try:
            count = self.cleanup()
            LOGGER.info("maintenance_cleanup_succeeded removed=%d", count)
        except Exception:
            LOGGER.error("maintenance_cleanup_failed")
        if self.stopping.is_set():
            return
        try:
            self.backup_daily()
        except Exception:
            # Exception strings can contain paths, SQL or stored values.
            if not self.stopping.is_set():
                LOGGER.error("maintenance_backup_failed")

    def cleanup(self) -> int:
        # mode=rw refuses to create an empty replacement if the file disappears
        # between the check above and the connection opening.
        uri = Path(self.database.path).absolute().as_uri() + "?mode=rw"
        with closing(sqlite3.connect(uri, uri=True, timeout=10, isolation_level=None)) as connection:
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA foreign_keys=ON")
            connection.execute("BEGIN IMMEDIATE")
            try:
                count = cleanup_expired(connection)
                connection.commit()
                return count
            except Exception:
                connection.rollback()
                raise

    @staticmethod
    def daily_files(directory: Path) -> list[Path]:
        return sorted((path for path in directory.iterdir()
                       if DAILY_NAME.fullmatch(path.name) and path.is_file() and not path.is_symlink()),
                      reverse=True)

    def backup_daily(self, timestamp: datetime | None = None) -> None:
        timestamp = timestamp or datetime.now(timezone.utc)
        directory = Path(self.database.path).parent / "backups"
        if directory.is_symlink():
            raise ValueError("Backup directory must not be a symlink.")
        directory.mkdir(mode=0o700, exist_ok=True)
        day_prefix = "auto-daily-" + timestamp.strftime("%Y%m%d") + "T"
        if any(path.name.startswith(day_prefix) for path in self.daily_files(directory)):
            return
        source = Path(self.database.path)
        estimated_size = source.stat().st_size
        wal = Path(str(source) + "-wal")
        if wal.is_file():
            estimated_size += wal.stat().st_size
        # Keep room for live writes while staging a full snapshot. A failed
        # capacity check preserves old backups and retries on a later cycle.
        if shutil.disk_usage(directory).free < estimated_size * 2 + 32 * 1024 * 1024:
            raise OSError("Insufficient backup headroom.")
        destination = directory / ("auto-daily-" + timestamp.strftime("%Y%m%dT%H%M%S%fZ") + ".db")
        # A private staging directory lets shutdown remove only this job's
        # temporary SQLite files, after its child has been reaped.
        with tempfile.TemporaryDirectory(prefix=".auto-daily-work-", dir=directory) as temporary:
            staged = Path(temporary) / "snapshot.db"
            command = [sys.executable, str(ROOT / "scripts/database-maintenance.py"), "backup",
                       "--database", self.database.path, "--output", str(staged)]
            process = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            deadline = time.monotonic() + self.backup_timeout
            try:
                while process.poll() is None:
                    if self.stopping.wait(0.1) or time.monotonic() >= deadline:
                        raise TimeoutError("Backup interrupted or timed out.")
                if process.returncode != 0:
                    raise RuntimeError("Backup did not succeed.")
            finally:
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()
            if self.stopping.is_set():
                return
            # Do not replace a competing snapshot, even on an unexpected second
            # worker. Publish the already verified file without copying it.
            os.link(staged, destination)
            descriptor = os.open(directory, os.O_RDONLY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
        if self.stopping.is_set():
            return
        # The script publishes only after integrity/FK checks. Failed or stopped
        # backups never rotate existing snapshots; pre-start/manual files stay.
        for old in self.daily_files(directory)[7:]:
            if old.is_file() and not old.is_symlink():
                old.unlink()
        LOGGER.info("maintenance_backup_succeeded")


@asynccontextmanager
async def production_lifespan(app):
    maintenance = None
    if app.state.runtime.production:
        maintenance = ProductionMaintenance(app.state.database)
        app.state.maintenance = maintenance
        maintenance.start()
    try:
        yield
    finally:
        if maintenance is not None:
            # Wait for the cleanup transaction or tracked child to finish; do
            # not abandon a thread that could still write after ASGI shutdown.
            await asyncio.to_thread(maintenance.stop)
