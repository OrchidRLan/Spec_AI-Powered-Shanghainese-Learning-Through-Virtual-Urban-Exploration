"""Back up the existing persistent database before starting one API worker."""
from __future__ import annotations

import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def prepare_database(database: Path) -> None:
    if not database.is_absolute():
        raise ValueError("DATABASE_PATH must be absolute.")
    database.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if not database.exists():
        return  # The application initializes a new empty database on first start.
    backup_dir = database.parent / "backups"
    backup_dir.mkdir(mode=0o700, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    destination = backup_dir / f"auto-prestart-{stamp}.db"
    subprocess.run([
        sys.executable, str(ROOT / "scripts/database-maintenance.py"), "backup",
        "--database", str(database), "--output", str(destination),
    ], check=True)
    # Only this launcher's backups are rotated. Manual backups are untouched.
    automatic = sorted(
        (path for path in backup_dir.glob("auto-prestart-*.db") if path.is_file() and not path.is_symlink()),
        reverse=True,
    )
    for old in automatic[3:]:
        if old.is_file() and not old.is_symlink():
            old.unlink()


def main() -> None:
    os.umask(0o077)
    # Import settings only: importing app.main would initialize/migrate the DB
    # and load .env before we have a verified backup.
    backend_path = str(ROOT / "backend")
    if backend_path not in sys.path:
        sys.path.insert(0, backend_path)
    from app.runtime import RuntimeSettings

    runtime = RuntimeSettings.from_env(str(ROOT / "backend/data/app.db"))
    if not runtime.production:
        raise ValueError("The Render launcher requires APP_ENV=production.")
    port = int(os.environ.get("PORT", "10000"))
    if not 1 <= port <= 65535:
        raise ValueError("PORT is outside the valid range.")
    prepare_database(Path(runtime.database_path))
    os.chdir(ROOT)
    os.execv(sys.executable, [
        sys.executable, "-m", "uvicorn", "app.main:app", "--app-dir", "backend",
        "--host", "0.0.0.0", "--port", str(port), "--workers", "1",
        "--no-proxy-headers", "--no-access-log",
    ])


if __name__ == "__main__":
    main()
