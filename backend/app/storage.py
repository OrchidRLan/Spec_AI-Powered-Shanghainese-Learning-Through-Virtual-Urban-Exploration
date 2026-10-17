from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator


def encode(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


class Database:
    """Local transactional store. A fresh connection is used for each operation."""
    def __init__(self, path: str):
        self.path = path
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with self.transaction() as connection:
            schema = """
                CREATE TABLE IF NOT EXISTS sessions (
                    id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, data TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS attempts (
                    id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
                    data TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS attempts_session ON attempts(session_id);
                CREATE TABLE IF NOT EXISTS turns (
                    attempt_id TEXT NOT NULL REFERENCES attempts(id), request_id TEXT NOT NULL,
                    fingerprint TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL,
                    interpretation TEXT, response TEXT, created_at TEXT NOT NULL,
                    PRIMARY KEY(attempt_id, request_id)
                );
                CREATE TABLE IF NOT EXISTS events (
                    session_id TEXT NOT NULL REFERENCES sessions(id), event_id TEXT NOT NULL,
                    attempt_id TEXT REFERENCES attempts(id), event_type TEXT NOT NULL,
                    metadata TEXT NOT NULL, created_at TEXT NOT NULL,
                    PRIMARY KEY(session_id, event_id)
                );
                CREATE TABLE IF NOT EXISTS asr_requests (
                    session_id TEXT NOT NULL REFERENCES sessions(id), request_id TEXT NOT NULL,
                    fingerprint TEXT NOT NULL, response TEXT, created_at TEXT NOT NULL,
                    PRIMARY KEY(session_id, request_id)
                );
                CREATE TABLE IF NOT EXISTS practice_requests (
                    attempt_id TEXT NOT NULL REFERENCES attempts(id), request_id TEXT NOT NULL,
                    fingerprint TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL,
                    response TEXT NOT NULL, created_at TEXT NOT NULL,
                    PRIMARY KEY(attempt_id, request_id)
                );
                CREATE TABLE IF NOT EXISTS practice_asr_uses (
                    session_id TEXT NOT NULL REFERENCES sessions(id), asr_request_id TEXT NOT NULL,
                    attempt_id TEXT NOT NULL REFERENCES attempts(id), request_id TEXT NOT NULL,
                    PRIMARY KEY(session_id, asr_request_id)
                );
                CREATE TABLE IF NOT EXISTS lesson_requests (
                    attempt_id TEXT NOT NULL REFERENCES attempts(id), request_id TEXT NOT NULL,
                    fingerprint TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL,
                    response TEXT NOT NULL, created_at TEXT NOT NULL,
                    PRIMARY KEY(attempt_id, request_id)
                );
                CREATE TABLE IF NOT EXISTS users (
                    id TEXT NOT NULL UNIQUE, username TEXT NOT NULL,
                    username_key TEXT NOT NULL PRIMARY KEY COLLATE NOCASE,
                    password_hash TEXT NOT NULL, session_id TEXT NOT NULL REFERENCES sessions(id),
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS auth_tokens (
                    token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
                    expires_at REAL NOT NULL, created_at REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS account_sessions (
                    user_id TEXT NOT NULL REFERENCES users(id), session_id TEXT NOT NULL REFERENCES sessions(id),
                    PRIMARY KEY(user_id, session_id)
                );
                CREATE TABLE IF NOT EXISTS guest_tokens (
                    token_hash TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
                    expires_at REAL NOT NULL, created_at REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS guest_sessions (
                    session_id TEXT PRIMARY KEY REFERENCES sessions(id), expires_at REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS auth_rate_limits (
                    bucket TEXT PRIMARY KEY, window_started REAL NOT NULL, count INTEGER NOT NULL
                );
            """
            # executescript commits an existing transaction implicitly; keep
            # schema initialization inside the same write lock instead.
            for statement in schema.split(";"):
                if statement.strip():
                    connection.execute(statement)
        self._migrate_username_primary_key()

    def _migrate_username_primary_key(self):
        """Upgrade account keys without changing IDs referenced by credentials.

        SQLite requires rebuilding a table to change its primary key. Foreign
        keys are disabled only on this private migration connection, before
        its transaction starts; all data and foreign keys are checked before
        committing the replacement. Normal application connections keep them on.
        """
        connection = sqlite3.connect(self.path, timeout=10, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=OFF")
        connection.execute("PRAGMA busy_timeout=10000")
        try:
            connection.execute("BEGIN IMMEDIATE")
            columns = {row["name"]: row for row in connection.execute("PRAGMA table_info(users)")}
            # Check under the write lock so concurrent application startups
            # cannot both attempt to rebuild the same table.
            if columns["username_key"]["pk"] == 1 and columns["username_key"]["notnull"] == 1:
                connection.commit()
                return
            connection.execute("""
                CREATE TABLE users_username_pk (
                    id TEXT NOT NULL UNIQUE, username TEXT NOT NULL,
                    username_key TEXT NOT NULL PRIMARY KEY COLLATE NOCASE,
                    password_hash TEXT NOT NULL, session_id TEXT NOT NULL REFERENCES sessions(id),
                    created_at TEXT NOT NULL
                )
            """)
            connection.execute("""
                INSERT INTO users_username_pk (id,username,username_key,password_hash,session_id,created_at)
                SELECT id,username,username_key,password_hash,session_id,created_at FROM users
            """)
            connection.execute("DROP TABLE users")
            connection.execute("ALTER TABLE users_username_pk RENAME TO users")
            if connection.execute("PRAGMA foreign_key_check").fetchone() is not None:
                raise sqlite3.IntegrityError("Account key migration failed foreign-key validation")
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.path, timeout=10, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA busy_timeout=10000")
        try:
            connection.execute("BEGIN IMMEDIATE")
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    @staticmethod
    def save_attempt(connection, attempt: dict):
        connection.execute("UPDATE attempts SET data=? WHERE id=?", (encode(attempt), attempt["id"]))

    @staticmethod
    def event(connection, session_id: str, attempt_id: str | None, event_id: str,
              event_type: str, metadata: dict, now: str):
        connection.execute(
            "INSERT INTO events VALUES (?,?,?,?,?,?)",
            (session_id, event_id, attempt_id, event_type, encode(metadata), now),
        )
