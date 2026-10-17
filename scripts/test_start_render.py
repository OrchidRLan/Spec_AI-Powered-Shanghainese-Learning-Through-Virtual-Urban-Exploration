"""Test the Render launch boundary without starting an API or using real data."""
from contextlib import closing, ExitStack
import importlib.util
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location("start_render", Path(__file__).with_name("start-render.py"))
launcher = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(launcher)


class RenderStartupTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.database = self.root / "data/app.db"
        self.environment = {
            "APP_ENV": "production", "COOKIE_SECURE": "true",
            "ALLOWED_ORIGINS": "https://example.test",
            "BACKEND_PROXY_SECRET": "synthetic-test-proxy-secret-not-a-real-key",
            "DATABASE_PATH": str(self.database), "PORT": "10000",
        }
        self.stack = self.enterContext(ExitStack())
        self.stack.enter_context(patch.dict(os.environ, self.environment, clear=True))
        self.stack.enter_context(patch.object(launcher.os, "umask"))
        self.stack.enter_context(patch.object(launcher.os, "chdir"))
        self.exec = self.stack.enter_context(patch.object(launcher.os, "execv"))

    def create_database(self):
        self.database.parent.mkdir()
        with closing(sqlite3.connect(self.database)) as connection:
            connection.executescript("CREATE TABLE records(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO records VALUES(1, 'before migration');")

    def test_first_start_leaves_database_initialization_to_application(self):
        with patch.object(launcher.subprocess, "run") as backup:
            launcher.main()
        backup.assert_not_called()
        self.assertTrue(self.database.parent.is_dir())
        self.assertFalse(self.database.exists())
        self.exec.assert_called_once()
        arguments = self.exec.call_args.args[1]
        self.assertIn("--no-proxy-headers", arguments)
        self.assertEqual(arguments[arguments.index("--workers") + 1], "1")

    def test_existing_database_is_backed_up_before_only_automatic_files_rotate(self):
        self.create_database()
        original = self.database.read_bytes()
        backups = self.database.parent / "backups"
        backups.mkdir()
        old = []
        for index in range(4):
            path = backups / f"auto-prestart-2000010{index + 1}T000000000000Z.db"
            path.write_bytes(b"previous automatic snapshot")
            old.append(path)
        manual = backups / "app-manual.db"
        manual.write_bytes(b"keep manual snapshot")
        outside = self.root / "outside.db"
        outside.write_bytes(b"do not touch symlink target")
        link = backups / "auto-prestart-99999999.db"
        link.symlink_to(outside)
        original_run = subprocess.run
        with patch.object(launcher.subprocess, "run", side_effect=lambda *args, **kwargs: original_run(*args, **kwargs, capture_output=True)):
            launcher.main()
        automatic = [path for path in backups.glob("auto-prestart-*.db") if not path.is_symlink()]
        self.assertEqual(len(automatic), 3)
        self.assertFalse(old[0].exists())
        self.assertFalse(old[1].exists())
        self.assertTrue(old[2].exists())
        self.assertTrue(old[3].exists())
        self.assertEqual(manual.read_bytes(), b"keep manual snapshot")
        self.assertTrue(link.is_symlink())
        self.assertEqual(outside.read_bytes(), b"do not touch symlink target")
        new = next(path for path in automatic if path not in old)
        with closing(sqlite3.connect(new)) as connection:
            self.assertEqual(connection.execute("SELECT value FROM records").fetchall(), [("before migration",)])
        self.assertEqual(self.database.read_bytes(), original)
        self.exec.assert_called_once()

    def test_failed_backup_prevents_rotation_and_api_start(self):
        self.create_database()
        backups = self.database.parent / "backups"
        backups.mkdir()
        for index in range(4):
            (backups / f"auto-prestart-2000010{index + 1}.db").write_bytes(b"keep previous snapshot")
        before = {path.name: path.read_bytes() for path in backups.iterdir()}
        with patch.object(launcher.subprocess, "run", side_effect=subprocess.CalledProcessError(1, "backup")):
            with self.assertRaises(subprocess.CalledProcessError):
                launcher.main()
        self.assertEqual({path.name: path.read_bytes() for path in backups.iterdir()}, before)
        self.exec.assert_not_called()

    def test_invalid_production_settings_fail_before_creating_any_database_directory(self):
        for name, value in (("COOKIE_SECURE", "false"), ("ALLOWED_ORIGINS", ""), ("BACKEND_PROXY_SECRET", "short")):
            with self.subTest(setting=name), patch.dict(os.environ, {name: value}), patch.object(launcher.subprocess, "run") as backup:
                with self.assertRaises(ValueError):
                    launcher.main()
                backup.assert_not_called()
                self.assertFalse(self.database.parent.exists())
        self.exec.assert_not_called()

    def test_invalid_port_fails_before_backups_or_database_creation(self):
        with patch.dict(os.environ, {"PORT": "65536"}), patch.object(launcher.subprocess, "run") as backup:
            with self.assertRaises(ValueError):
                launcher.main()
            backup.assert_not_called()
            self.assertFalse(self.database.parent.exists())
        self.exec.assert_not_called()


if __name__ == "__main__":
    unittest.main()
