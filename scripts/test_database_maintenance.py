"""Maintenance checks use temporary databases only; no app, .env, or provider imports."""
from contextlib import closing, redirect_stderr, redirect_stdout
import importlib.util
import io
from pathlib import Path
import sqlite3
import stat
import tempfile
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location("database_maintenance", Path(__file__).with_name("database-maintenance.py"))
maintenance = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(maintenance)


class DatabaseMaintenanceTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.database = self.root / "source.db"
        with closing(sqlite3.connect(self.database)) as connection:
            connection.executescript("CREATE TABLE records(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO records VALUES(1, 'original');")

    def command(self, *args):
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            return maintenance.main(list(args))

    def records(self, path):
        with closing(sqlite3.connect(path)) as connection:
            return connection.execute("SELECT * FROM records ORDER BY id").fetchall()

    def test_online_backup_includes_committed_wal_and_excludes_uncommitted_data(self):
        with closing(sqlite3.connect(self.database)) as writer:
            writer.execute("PRAGMA journal_mode=WAL")
            writer.execute("INSERT INTO records VALUES(2, 'committed WAL')")
            writer.commit()
            writer.execute("INSERT INTO records VALUES(3, 'uncommitted')")
            backup = maintenance.copy_snapshot(self.database, self.root / "backup.db")
            self.assertEqual(self.records(backup), [(1, "original"), (2, "committed WAL")])
            self.assertFalse(Path(str(backup) + "-wal").exists())
            self.assertEqual(stat.S_IMODE(backup.stat().st_mode), 0o600)
            writer.rollback()
        self.assertFalse(list(self.root.glob(".sqlite-snapshot-*")))

    def test_restore_requires_stopped_service_and_preserves_old_database(self):
        backup = maintenance.copy_snapshot(self.database, self.root / "backup.db")
        output = self.root / "restored.db"
        arguments = ["restore", "--backup", str(backup), "--output", str(output)]
        self.assertEqual(self.command(*arguments), 1)
        self.assertFalse(output.exists())
        with closing(sqlite3.connect(self.database)) as connection:
            connection.execute("INSERT INTO records VALUES(2, 'later progress')")
            connection.commit()
        self.assertEqual(self.command(*arguments, "--service-stopped"), 0)
        self.assertEqual(self.records(output), [(1, "original")])
        self.assertEqual(self.records(self.database), [(1, "original"), (2, "later progress")])

    def test_existing_destination_is_never_overwritten(self):
        output = self.root / "keep.db"
        output.write_bytes(b"keep existing data")
        for command, source_flag, extra in (("backup", "--database", []), ("restore", "--backup", ["--service-stopped"])):
            self.assertEqual(self.command(command, source_flag, str(self.database), "--output", str(output), *extra), 1)
            self.assertEqual(output.read_bytes(), b"keep existing data")

    def test_missing_source_does_not_create_a_database(self):
        missing = self.root / "missing.db"
        output = self.root / "backup.db"
        self.assertEqual(self.command("backup", "--database", str(missing), "--output", str(output)), 1)
        self.assertFalse(missing.exists())
        self.assertFalse(output.exists())

    def test_invalid_database_cannot_be_published(self):
        self.database.write_bytes(b"not a SQLite database")
        output = self.root / "backup.db"
        self.assertEqual(self.command("backup", "--database", str(self.database), "--output", str(output)), 1)
        self.assertFalse(output.exists())
        self.assertFalse(list(self.root.glob(".sqlite-snapshot-*")))

    def test_integrity_check_rejects_foreign_key_violations(self):
        with closing(sqlite3.connect(self.database)) as connection:
            connection.executescript("CREATE TABLE child(parent_id INTEGER REFERENCES records(id)); INSERT INTO child VALUES(999);")
        output = self.root / "backup.db"
        self.assertEqual(self.command("check", "--database", str(self.database)), 1)
        self.assertEqual(self.command("backup", "--database", str(self.database), "--output", str(output)), 1)
        self.assertFalse(output.exists())

    def test_check_does_not_change_database_contents(self):
        before = self.database.read_bytes()
        self.assertEqual(self.command("check", "--database", str(self.database)), 0)
        self.assertEqual(self.database.read_bytes(), before)

    def test_publish_race_does_not_replace_new_destination(self):
        output = self.root / "backup.db"
        original_link = maintenance.os.link

        def concurrent_destination(source, destination):
            output.write_bytes(b"created by another operation")
            original_link(source, destination)

        with patch.object(maintenance.os, "link", side_effect=concurrent_destination):
            self.assertEqual(self.command("backup", "--database", str(self.database), "--output", str(output)), 1)
        self.assertEqual(output.read_bytes(), b"created by another operation")
        self.assertFalse(list(self.root.glob(".sqlite-snapshot-*")))

    def test_timeout_leaves_no_partial_snapshot(self):
        output = self.root / "backup.db"
        with patch.object(maintenance.time, "monotonic", side_effect=[0, 61]):
            self.assertEqual(self.command("backup", "--database", str(self.database), "--output", str(output)), 1)
        self.assertFalse(output.exists())
        self.assertFalse(list(self.root.glob(".sqlite-snapshot-*")))


if __name__ == "__main__":
    unittest.main()
