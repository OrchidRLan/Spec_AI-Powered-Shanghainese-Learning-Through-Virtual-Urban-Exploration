"""Delete expired temporary visits without loading providers or creating an ASGI app."""
import argparse
import os
from pathlib import Path

from .auth import cleanup_expired
from .storage import Database


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", default=os.environ.get("DATABASE_PATH", str(Path(__file__).resolve().parents[1] / "data" / "app.db")))
    args = parser.parse_args()
    database = Database(args.database)
    with database.transaction() as connection:
        count = cleanup_expired(connection)
    print(f"Removed {count} expired guest visits.")


if __name__ == "__main__":
    main()
