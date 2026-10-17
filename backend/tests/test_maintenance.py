"""Idle maintenance uses temporary DBs only; no provider or network calls."""
import asyncio
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
import sqlite3
import subprocess
import sys
import threading
import time
from types import SimpleNamespace

import pytest

from app.maintenance import ProductionMaintenance, production_lifespan
from app.storage import Database


@pytest.fixture
def database(tmp_path):
    return Database(str(tmp_path / "app.db"))


def seed_visits(database):
    with database.transaction() as connection:
        for sid in ("expired", "active", "account", "legacy"):
            connection.execute("INSERT INTO sessions VALUES (?,?,?)", (sid, sid + "-hash", "{}"))
        connection.execute("INSERT INTO guest_sessions VALUES ('expired',0)")
        connection.execute("INSERT INTO guest_sessions VALUES ('active',?)", (time.time() + 600,))
        connection.execute("INSERT INTO guest_sessions VALUES ('account',0)")
        connection.execute("INSERT INTO users VALUES ('user','User','user','private-hash','account','now')")
        connection.execute("INSERT INTO account_sessions VALUES ('user','account')")
        connection.execute("INSERT INTO guest_tokens VALUES ('expired-hash','expired',0,0)")
        connection.execute("INSERT INTO attempts VALUES ('attempt','expired','{}')")
        connection.execute("INSERT INTO events VALUES ('expired','event','attempt','test','{}','now')")


def test_idle_cleanup_removes_expired_guests_and_keeps_account_active_and_legacy(database, monkeypatch):
    seed_visits(database)
    maintenance = ProductionMaintenance(database)
    monkeypatch.setattr(maintenance, "backup_daily", lambda: None)
    maintenance.cycle()  # No API request is made.
    with database.transaction() as connection:
        assert {row["id"] for row in connection.execute("SELECT id FROM sessions")} == {"active", "account", "legacy"}
        assert connection.execute("SELECT count(*) FROM attempts").fetchone()[0] == 0
        assert connection.execute("SELECT password_hash FROM users").fetchone()[0] == "private-hash"
        assert connection.execute("PRAGMA foreign_key_check").fetchone() is None


def test_daily_snapshot_is_consistent_private_once_per_utc_day_and_rotates_only_owned_files(database):
    seed_visits(database)
    maintenance = ProductionMaintenance(database)
    directory = Path(database.path).parent / "backups"
    directory.mkdir()
    manual = directory / "manual.db"
    manual.write_bytes(b"manual")
    prestart = directory / "auto-prestart-20260101.db"
    prestart.write_bytes(b"prestart")
    linked = directory / "auto-daily-20260101T000000000000Z.db"
    linked.symlink_to(manual)
    for day in range(2, 10):
        maintenance.backup_daily(datetime(2026, 1, day, tzinfo=timezone.utc))
    snapshots = maintenance.daily_files(directory)
    assert len(snapshots) == 7
    assert all("20260102" not in path.name for path in snapshots)
    assert manual.read_bytes() == b"manual" and prestart.read_bytes() == b"prestart" and linked.is_symlink()
    maintenance.backup_daily(datetime(2026, 1, 9, 12, tzinfo=timezone.utc))
    assert maintenance.daily_files(directory) == snapshots
    with closing(sqlite3.connect(snapshots[0])) as connection:
        assert connection.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        assert connection.execute("SELECT count(*) FROM sessions").fetchone()[0] == 4
    assert snapshots[0].stat().st_mode & 0o777 == 0o600
    assert not list(directory.glob(".auto-daily-work-*"))


def test_failed_backup_retains_previous_snapshots_and_logs_no_exception_data(database, monkeypatch, caplog):
    maintenance = ProductionMaintenance(database)
    directory = Path(database.path).parent / "backups"
    directory.mkdir()
    for day in range(1, 9):
        (directory / f"auto-daily-200001{day:02d}T000000000000Z.db").write_bytes(b"retain")
    before = {path.name: path.read_bytes() for path in directory.iterdir()}

    def fail(*args, **kwargs):
        raise OSError("secret credential and private user data")

    monkeypatch.setattr("app.maintenance.subprocess.Popen", fail)
    maintenance.cycle()
    assert {path.name: path.read_bytes() for path in directory.iterdir()} == before
    assert "maintenance_backup_failed" in caplog.text
    assert "secret credential" not in caplog.text
    assert "private user data" not in caplog.text


def test_missing_database_is_not_created(database, caplog):
    Path(database.path).unlink()
    maintenance = ProductionMaintenance(database)
    maintenance.cycle()
    assert not Path(database.path).exists()
    assert "maintenance_database_unavailable" in caplog.text


def test_shutdown_reaps_running_backup_and_joins_thread(database, monkeypatch):
    maintenance = ProductionMaintenance(database, interval=600)
    started = threading.Event()
    children = []
    original_popen = subprocess.Popen

    def slow_backup(_command, **kwargs):
        child = original_popen([sys.executable, "-c", "import time; time.sleep(60)"], **kwargs)
        children.append(child)
        started.set()
        return child

    monkeypatch.setattr("app.maintenance.subprocess.Popen", slow_backup)
    maintenance.start()
    assert started.wait(5)
    maintenance.stop()
    assert not maintenance.thread.is_alive()
    assert children[0].poll() is not None
    directory = Path(database.path).parent / "backups"
    assert not list(directory.iterdir())


def test_backup_timeout_reaps_child_without_rotating(database, monkeypatch):
    maintenance = ProductionMaintenance(database, backup_timeout=0.01)
    children = []
    original_popen = subprocess.Popen

    def slow_backup(_command, **kwargs):
        child = original_popen([sys.executable, "-c", "import time; time.sleep(60)"], **kwargs)
        children.append(child)
        return child

    monkeypatch.setattr("app.maintenance.subprocess.Popen", slow_backup)
    with pytest.raises(TimeoutError):
        maintenance.backup_daily()
    assert children[0].poll() is not None
    assert not list((Path(database.path).parent / "backups").iterdir())


def test_lifespan_runs_only_in_production_and_stops_maintenance(database, monkeypatch):
    actions = []
    monkeypatch.setattr(ProductionMaintenance, "start", lambda self: actions.append("start"))
    monkeypatch.setattr(ProductionMaintenance, "stop", lambda self: actions.append("stop"))

    async def visit(production):
        app = SimpleNamespace(state=SimpleNamespace(runtime=SimpleNamespace(production=production), database=database))
        async with production_lifespan(app):
            actions.append("request")

    asyncio.run(visit(False))
    assert actions == ["request"]
    actions.clear()
    asyncio.run(visit(True))
    assert actions == ["start", "request", "stop"]


def test_cleanup_refuses_to_recreate_database_after_it_disappears(database):
    maintenance = ProductionMaintenance(database)
    Path(database.path).unlink()
    with pytest.raises(sqlite3.OperationalError):
        maintenance.cleanup()
    assert not Path(database.path).exists()


def test_low_disk_headroom_preserves_snapshots_and_never_starts_backup(database, monkeypatch):
    maintenance = ProductionMaintenance(database)
    directory = Path(database.path).parent / "backups"
    directory.mkdir()
    old = directory / "auto-daily-20000101T000000000000Z.db"
    old.write_bytes(b"retain")
    monkeypatch.setattr("app.maintenance.shutil.disk_usage", lambda _path: SimpleNamespace(free=0))
    monkeypatch.setattr("app.maintenance.subprocess.Popen", lambda *args, **kwargs: pytest.fail("No child should start"))
    with pytest.raises(OSError):
        maintenance.backup_daily()
    assert old.read_bytes() == b"retain"
    assert list(directory.iterdir()) == [old]
