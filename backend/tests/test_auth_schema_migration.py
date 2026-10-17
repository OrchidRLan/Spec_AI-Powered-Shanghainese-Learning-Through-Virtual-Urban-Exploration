"""Username-primary-key upgrades preserve existing identities and learning data."""
from concurrent.futures import ThreadPoolExecutor
import sqlite3
from threading import Barrier
import time
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from app.auth import ACCOUNT_COOKIE, digest, password_hash
from app.main import create_app, now
from app.rules import CONTENT_VERSION, RULE_VERSION, new_attempt
from app.storage import Database, encode


PASSWORD = "An existing Shanghai password"
LEGACY_SCHEMA = """
    CREATE TABLE sessions (
        id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, data TEXT NOT NULL
    );
    CREATE TABLE attempts (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
        data TEXT NOT NULL
    );
    CREATE TABLE users (
        id TEXT PRIMARY KEY, username TEXT NOT NULL, username_key TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL, session_id TEXT NOT NULL REFERENCES sessions(id),
        created_at TEXT NOT NULL
    );
    CREATE TABLE auth_tokens (
        token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
        expires_at REAL NOT NULL, created_at REAL NOT NULL
    );
    CREATE TABLE account_sessions (
        user_id TEXT NOT NULL REFERENCES users(id),
        session_id TEXT NOT NULL REFERENCES sessions(id),
        PRIMARY KEY(user_id, session_id)
    );
"""
USER_INSERT = """
    INSERT INTO users (id, username, username_key, password_hash, session_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
"""


def snapshot(path):
    """Capture logical schema and all rows, including any leaked staging tables."""
    with sqlite3.connect(path) as connection:
        schema = connection.execute(
            "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name"
        ).fetchall()
        rows = {}
        for kind, name, _table, _sql in schema:
            if kind == "table":
                quoted = name.replace('"', '""')
                rows[name] = connection.execute(f'SELECT * FROM "{quoted}" ORDER BY rowid').fetchall()
        return schema, rows


def assert_username_primary_key(database):
    with database.transaction() as connection:
        fields = {row["name"]: dict(row) for row in connection.execute("PRAGMA table_info(users)")}
        assert [(name, field["pk"]) for name, field in fields.items() if field["pk"]] == [("username_key", 1)]
        assert fields["username_key"]["notnull"] == fields["id"]["notnull"] == 1
        assert fields["username_key"]["type"] == fields["id"]["type"] == "TEXT"
        indexes = []
        for index in connection.execute("PRAGMA index_list(users)").fetchall():
            if index["unique"]:
                name = index["name"].replace('"', '""')
                columns = [dict(row) for row in connection.execute(f'PRAGMA index_xinfo("{name}")') if row["key"]]
                indexes.append((index["origin"], columns))
        assert any(origin == "pk" and [(column["name"], column["coll"]) for column in columns]
                   == [("username_key", "NOCASE")] for origin, columns in indexes)
        assert any([column["name"] for column in columns] == ["id"] for _origin, columns in indexes)
        for table, column, parent, target in (
            ("users", "session_id", "sessions", "id"),
            ("auth_tokens", "user_id", "users", "id"),
            ("account_sessions", "user_id", "users", "id"),
            ("account_sessions", "session_id", "sessions", "id"),
        ):
            assert any((row["from"], row["table"], row["to"]) == (column, parent, target)
                       for row in connection.execute(f"PRAGMA foreign_key_list({table})"))
        assert connection.execute("PRAGMA foreign_keys").fetchone()[0] == 1
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []


@pytest.fixture(scope="module")
def old_password_hashes():
    return [password_hash(PASSWORD), password_hash(PASSWORD)]


@pytest.fixture
def legacy_database(tmp_path, old_password_hashes):
    path = tmp_path / "old-accounts.db"
    timestamp = now()
    sessions = []
    for locale in ("en", "zh", "zh"):
        sid = str(uuid4())
        sessions.append({"id": sid, "locale": locale, "show_romanization": False,
                         "reduced_motion": True, "mode": "development",
                         "content_version": CONTENT_VERSION, "rule_version": RULE_VERSION,
                         "created_at": timestamp})
    users = [(str(uuid4()), username, username.lower(), old_password_hashes[index],
              sessions[index]["id"], timestamp)
             for index, username in enumerate(("LegacyWalker", "TeaWalker"))]
    attempts = []
    for index in range(2):
        attempt = new_attempt(str(uuid4()), timestamp)
        attempt["order"].update(item="xiaolongbao", quantity=3, unit="serving", normalized_servings=3, takeaway=True)
        attempt["revision"] = 7
        attempt["metrics"].update(voice_attempts=4, help_used=1)
        if index == 0:
            attempt.update(status="completed", summary_revision=7, confirmed_revision=7)
        attempts.append(attempt)
    tokens = [f"existing-browser-{uuid4()}" for _ in users]
    expires = time.time() + 86400
    with sqlite3.connect(path) as connection:
        connection.executescript(LEGACY_SCHEMA)
        connection.execute("PRAGMA foreign_keys=ON")
        connection.executemany("INSERT INTO sessions VALUES (?, ?, ?)",
                               [(session["id"], digest(f"old-session-{session['id']}"), encode(session)) for session in sessions])
        connection.executemany(USER_INSERT, users)
        connection.executemany("INSERT INTO attempts VALUES (?, ?, ?)",
                               [(attempt["id"], users[index][4], encode(attempt)) for index, attempt in enumerate(attempts)])
        connection.executemany("INSERT INTO auth_tokens VALUES (?, ?, ?, ?)",
                               [(digest(token), user[0], expires, expires - 86400) for token, user in zip(tokens, users)])
        connection.executemany("INSERT INTO account_sessions VALUES (?, ?)",
                               [(user[0], user[4]) for user in users] + [(users[0][0], sessions[2]["id"])])
    return {"path": path, "users": users, "sessions": sessions, "attempts": attempts, "tokens": tokens}


def test_fresh_database_uses_case_insensitive_username_primary_key(tmp_path):
    assert_username_primary_key(Database(str(tmp_path / "fresh.db")))


@pytest.mark.parametrize("changed", [
    {"username_key": "WALKER"},
    {"username_key": None},
    {"id": "stable-user-id"},
    {"id": None},
    {"session_id": "absent-session"},
], ids=["case-variant-key", "null-key", "duplicate-id", "null-id", "missing-session"])
def test_fresh_database_enforces_identity_constraints(tmp_path, changed):
    database = Database(str(tmp_path / "constraints.db"))
    with database.transaction() as connection:
        connection.execute("INSERT INTO sessions VALUES (?, ?, ?)", ("existing-session", "token-hash", "{}"))
        connection.execute(USER_INSERT, ("stable-user-id", "Walker", "walker", "stored-hash", "existing-session", now()))
    candidate = {"id": "different-id", "username": "Different", "username_key": "different",
                 "password_hash": "stored-hash", "session_id": "existing-session", "created_at": now()}
    candidate.update(changed)
    with pytest.raises(sqlite3.IntegrityError):
        with database.transaction() as connection:
            connection.execute(USER_INSERT, tuple(candidate.values()))
    with pytest.raises(sqlite3.IntegrityError):
        with database.transaction() as connection:
            connection.execute("INSERT INTO auth_tokens VALUES (?, ?, ?, ?)", ("orphan-token", "missing-user", time.time() + 60, time.time()))


def test_upgrade_preserves_accounts_progress_and_existing_login_credentials(legacy_database):
    saved = legacy_database
    before = snapshot(saved["path"])[1]
    app = create_app(str(saved["path"]))
    assert_username_primary_key(app.state.database)
    after = snapshot(saved["path"])[1]
    for table, rows in before.items():
        assert after[table] == rows, table

    for index, user in enumerate(saved["users"]):
        with TestClient(app) as old_browser:
            old_browser.cookies.set(ACCOUNT_COOKIE, saved["tokens"][index])
            response = old_browser.get("/api/auth")
            assert response.status_code == 200, response.text
            state = response.json()
            assert state["mode"] == "account"
            assert state["user"] == {"username": user[1]}
            assert state["session"]["id"] == user[4]
            assert state["session"]["locale"] == saved["sessions"][index]["locale"]
            assert state["session"]["show_romanization"] is False
            assert state["session"]["reduced_motion"] is True
            assert state["session"]["completed_station_ids"] == (["nanxiang"] if index == 0 else [])
            progress = old_browser.get(f"/api/attempts/{saved['attempts'][index]['id']}")
            assert progress.status_code == 200, progress.text
            for field, value in saved["attempts"][index].items():
                assert progress.json()[field] == value, field
        with TestClient(app) as new_browser:
            wrong = new_browser.post("/api/auth/login", json={"username": user[1], "password": "An incorrect old password"})
            assert wrong.status_code == 401
            login = new_browser.post("/api/auth/login", json={"username": user[1].upper(), "password": PASSWORD})
            assert login.status_code == 200, login.text
            assert login.json()["session"]["id"] == user[4]
            assert new_browser.get(f"/api/attempts/{saved['attempts'][index]['id']}").status_code == 200
    with app.state.database.transaction() as connection:
        assert [tuple(row) for row in connection.execute("SELECT * FROM users ORDER BY rowid")] == before["users"]
        assert [tuple(row) for row in connection.execute("SELECT * FROM account_sessions ORDER BY rowid")] == before["account_sessions"]
        for token, user in zip(saved["tokens"], saved["users"]):
            assert connection.execute("SELECT user_id FROM auth_tokens WHERE token_hash=?", (digest(token),)).fetchone()[0] == user[0]


def test_reinitializing_migrated_database_leaves_schema_and_data_unchanged(legacy_database):
    path = legacy_database["path"]
    Database(str(path))
    before = snapshot(path)
    for _ in range(3):
        assert_username_primary_key(Database(str(path)))
    assert snapshot(path) == before


@pytest.mark.parametrize("corruption", ["null-user-id", "dangling-token"])
def test_failed_upgrade_rolls_back_original_schema_and_all_records(legacy_database, corruption):
    path = legacy_database["path"]
    with sqlite3.connect(path) as connection:
        if corruption == "null-user-id":
            # SQLite's old TEXT PRIMARY KEY permits NULL; the upgraded stable id must not.
            connection.execute(USER_INSERT, (None, "BrokenWalker", "brokenwalker", "stored-hash", legacy_database["users"][0][4], now()))
        else:
            # A pre-existing dangling reference must be detected before committing the rebuild.
            connection.execute("INSERT INTO auth_tokens VALUES (?, ?, ?, ?)", ("broken-token", "absent-user", time.time() + 60, time.time()))
    before = snapshot(path)
    with pytest.raises(sqlite3.Error):
        Database(str(path))
    after = snapshot(path)
    # Startup may add missing unrelated tables before the account migration.
    # Every pre-existing schema object and row must survive byte-for-byte.
    assert set(before[0]).issubset(after[0])
    for table, rows in before[1].items():
        assert after[1][table] == rows, table
    assert "users_username_pk" not in after[1]
    assert all(not rows for table, rows in after[1].items() if table not in before[1])
    with sqlite3.connect(path) as connection:
        fields = connection.execute("PRAGMA table_info(users)").fetchall()
        assert [(field[1], field[5]) for field in fields if field[5]] == [("id", 1)]
        # Rollback must release the writer lock so the original database stays usable.
        connection.execute("BEGIN IMMEDIATE")
        connection.rollback()


def test_concurrent_initializers_upgrade_legacy_accounts_once(legacy_database):
    path = legacy_database["path"]
    before = snapshot(path)[1]
    ready = Barrier(3)

    def initialize(_worker):
        ready.wait(timeout=10)
        return Database(str(path))

    with ThreadPoolExecutor(max_workers=3) as pool:
        databases = list(pool.map(initialize, range(3)))
    for database in databases:
        assert_username_primary_key(database)
    after = snapshot(path)[1]
    for table, rows in before.items():
        assert after[table] == rows, table
