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
            connection.executescript("""
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
            """)

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
