"""Account credentials and temporary guests, separate from versioned learning sessions."""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import time
from datetime import datetime
from typing import Literal

from fastapi import Request, Response
from pydantic import Field, StrictBool

from .models import StrictModel
from .storage import encode

ACCOUNT_COOKIE = "shanghai_account"
LEGACY_COOKIE = "shanghai_session"
GUEST_HEADER = "x-guest-token"
ACCOUNT_SECONDS = 30 * 24 * 60 * 60
GUEST_SECONDS = 24 * 60 * 60


def digest(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def password_hash(password: str) -> str:
    salt = secrets.token_bytes(16)
    key = hashlib.scrypt(password.encode(), salt=salt, n=32768, r=8, p=3, maxmem=64 * 1024 * 1024)
    return f"scrypt$32768$8$3${salt.hex()}${key.hex()}"


def verify_password(password: str, encoded: str | None) -> bool:
    # Unknown users incur the same expensive derivation as known users.
    salt, expected = b"shanghai-no-user!", bytes(64)
    if encoded:
        try:
            algorithm, n, r, p, salt_hex, key_hex = encoded.split("$")
            if (algorithm, n, r, p) != ("scrypt", "32768", "8", "3"):
                return False
            salt, expected = bytes.fromhex(salt_hex), bytes.fromhex(key_hex)
        except (ValueError, TypeError):
            return False
    actual = hashlib.scrypt(password.encode(), salt=salt, n=32768, r=8, p=3, maxmem=64 * 1024 * 1024)
    return hmac.compare_digest(actual, expected) and encoded is not None


class GuestInput(StrictModel):
    locale: Literal["zh", "en"] = "zh"


class CredentialsInput(StrictModel):
    username: str = Field(max_length=128)
    password: str = Field(max_length=512)
    locale: Literal["zh", "en"] | None = None
    import_legacy: StrictBool = False


class LogoutInput(StrictModel):
    pass


def cleanup_expired(connection, timestamp: float | None = None) -> int:
    """Only guest-owned sessions can be deleted; legacy/account records are retained."""
    timestamp = time.time() if timestamp is None else timestamp
    rows = connection.execute("SELECT session_id FROM guest_sessions WHERE expires_at<=?", (timestamp,)).fetchall()
    removed = 0
    for row in rows:
        sid = row["session_id"]
        if (connection.execute("SELECT 1 FROM users WHERE session_id=?", (sid,)).fetchone()
                or connection.execute("SELECT 1 FROM account_sessions WHERE session_id=?", (sid,)).fetchone()):
            connection.execute("DELETE FROM guest_sessions WHERE session_id=?", (sid,))
            continue
        for table in ("turns", "practice_requests", "lesson_requests"):
            connection.execute(f"DELETE FROM {table} WHERE attempt_id IN (SELECT id FROM attempts WHERE session_id=?)", (sid,))
        for table in ("events", "practice_asr_uses", "asr_requests", "guest_tokens"):
            connection.execute(f"DELETE FROM {table} WHERE session_id=?", (sid,))
        connection.execute("DELETE FROM attempts WHERE session_id=?", (sid,))
        connection.execute("DELETE FROM guest_sessions WHERE session_id=?", (sid,))
        connection.execute("DELETE FROM sessions WHERE id=?", (sid,))
        removed += 1
    connection.execute("DELETE FROM auth_tokens WHERE expires_at<=?", (timestamp,))
    connection.execute("DELETE FROM auth_rate_limits WHERE window_started<?", (timestamp - 3600,))
    return removed


class Authentication:
    def __init__(self, app, database, *, create_session, public_session, problem, identifier, now):
        self.database, self.create_session, self.public_session = database, create_session, public_session
        self.problem, self.identifier, self.now = problem, identifier, now
        self.register_routes(app)

    def legacy(self, request, connection):
        token = request.cookies.get(LEGACY_COOKIE)
        if not token:
            return None
        # New guest/account session hashes are never exposed through this cookie.
        return connection.execute("SELECT id FROM sessions WHERE token_hash=?", (digest(token),)).fetchone()

    def identity(self, request, connection, *, allow_legacy=False):
        if GUEST_HEADER in request.headers:
            token = request.headers[GUEST_HEADER]
            row = connection.execute("SELECT session_id FROM guest_tokens WHERE token_hash=? AND expires_at>?", (digest(token), time.time())).fetchone()
            if row is None:
                self.problem("guest_expired", "This guest visit has ended. Choose how to continue.", 401)
            return "guest", row["session_id"], None
        token = request.cookies.get(ACCOUNT_COOKIE)
        if token:
            row = connection.execute("SELECT u.* FROM auth_tokens t JOIN users u ON u.id=t.user_id WHERE t.token_hash=? AND t.expires_at>?", (digest(token), time.time())).fetchone()
            if row:
                return "account", row["session_id"], row
        if allow_legacy:
            row = self.legacy(request, connection)
            if row:
                return "legacy", row["id"], None
        return "signed_out", None, None

    def session_id(self, request, connection):
        _mode, sid, _user = self.identity(request, connection, allow_legacy=True)
        if sid is None:
            self.problem("session_required", "Sign in or start a guest visit first.", 401)
        expected = request.headers.get("x-expected-session-id")
        if expected is not None and expected != sid:
            self.problem("session_changed", "The signed-in account changed in another tab. Choose how to continue.", 401)
        return sid

    def state(self, request, connection, *, identity=None):
        mode, sid, user = identity or self.identity(request, connection)
        return {"mode": mode, "user": {"username": user["username"]} if user else None,
                "session": self.public_session(connection, sid) if sid else None,
                "legacy_available": self.legacy(request, connection) is not None}

    def limit(self, request, kind, username=""):
        address = request.client.host if request.client else "unknown"
        timestamp = time.time()
        limits = [(f"{kind}:ip:{digest(address)}", 15 if kind == "register" else 50, 3600 if kind == "register" else 900)]
        if kind == "login":
            limits.append((f"login:user:{digest(username)}", 10, 900))
        with self.database.transaction() as connection:
            for bucket, maximum, seconds in limits:
                row = connection.execute("SELECT * FROM auth_rate_limits WHERE bucket=?", (bucket,)).fetchone()
                if row and row["window_started"] > timestamp - seconds and row["count"] >= maximum:
                    self.problem("auth_rate_limited", "Too many attempts. Please try again later.", 429)
            for bucket, _maximum, seconds in limits:
                connection.execute("INSERT INTO auth_rate_limits VALUES (?,?,1) ON CONFLICT(bucket) DO UPDATE SET window_started=CASE WHEN window_started<=? THEN excluded.window_started ELSE window_started END, count=CASE WHEN window_started<=? THEN 1 ELSE count+1 END", (bucket, timestamp, timestamp - seconds, timestamp - seconds))

    def credentials(self, body):
        username = body.username.strip()
        if not re.fullmatch(r"[A-Za-z0-9_]{3,24}", username):
            self.problem("invalid_username", "Use 3–24 letters, numbers, or underscores.", 422)
        if not 15 <= len(body.password) <= 128:
            self.problem("invalid_password", "Use a password of 15–128 characters.", 422)
        return username, username.casefold()

    def sources(self, request, connection, import_legacy):
        mode, sid, _user = self.identity(request, connection)
        sources = [sid] if mode == "guest" else []
        if import_legacy:
            legacy = self.legacy(request, connection)
            if legacy is None:
                self.problem("legacy_unavailable", "Previous browser progress is no longer available.", 409)
            if legacy["id"] not in sources:
                sources.append(legacy["id"])
        return sources

    def check_idle(self, connection, sid):
        # A crashed worker must not block saving a visit forever. This is the
        # same 30-second recovery boundary used by the ASR retry endpoint.
        expired = {"error": {"code": "asr_interrupted", "message": "The previous transcription was interrupted. You can submit again.", "status": 503, "retryable": True, "terminal": True}}
        for row in connection.execute("SELECT request_id,created_at FROM asr_requests WHERE session_id=? AND response IS NULL", (sid,)).fetchall():
            if time.time() - datetime.fromisoformat(row["created_at"]).timestamp() > 30:
                connection.execute("UPDATE asr_requests SET response=? WHERE session_id=? AND request_id=? AND response IS NULL", (encode(expired), sid, row["request_id"]))
        for row in connection.execute("SELECT t.attempt_id,t.request_id,t.created_at,a.data FROM turns t JOIN attempts a ON a.id=t.attempt_id WHERE a.session_id=? AND t.status IN ('processing','prepared')", (sid,)).fetchall():
            if time.time() - datetime.fromisoformat(row["created_at"]).timestamp() > 30:
                connection.execute("UPDATE turns SET status='cancelled' WHERE attempt_id=? AND request_id=? AND status IN ('processing','prepared')", (row["attempt_id"], row["request_id"]))
                attempt = json.loads(row["data"])
                if attempt.get("pending_request_id") == row["request_id"]:
                    attempt["pending_request_id"] = None
                    self.database.save_attempt(connection, attempt)
                self.database.event(connection, sid, row["attempt_id"], self.identifier(), "request_cancelled", {"request_id": row["request_id"], "reason": "session_claim_timeout"}, self.now())
        pending = connection.execute("SELECT 1 FROM asr_requests WHERE session_id=? AND response IS NULL LIMIT 1", (sid,)).fetchone()
        pending_turn = connection.execute("SELECT 1 FROM turns t JOIN attempts a ON a.id=t.attempt_id WHERE a.session_id=? AND t.status IN ('processing','prepared') LIMIT 1", (sid,)).fetchone()
        if pending or pending_turn:
            self.problem("merge_in_progress", "Finish the current request before saving this visit to an account.", 409)

    def merge(self, connection, source, target):
        self.check_idle(connection, source)
        if source == target:
            return
        source_data = json.loads(connection.execute("SELECT data FROM sessions WHERE id=?", (source,)).fetchone()["data"])
        target_data = json.loads(connection.execute("SELECT data FROM sessions WHERE id=?", (target,)).fetchone()["data"])
        if any(source_data.get(field) != target_data.get(field) for field in ("content_version", "rule_version")):
            self.problem("merge_conflict", "These visits use different lesson versions. Previous progress is unchanged; sign in without importing it.", 409)
        # Validate all session-scoped unique keys before moving any data.
        for table, key in (("events", "event_id"), ("asr_requests", "request_id"), ("practice_asr_uses", "asr_request_id")):
            collision = connection.execute(f"SELECT 1 FROM {table} s JOIN {table} t ON s.{key}=t.{key} WHERE s.session_id=? AND t.session_id=? LIMIT 1", (source, target)).fetchone()
            if collision:
                self.problem("merge_conflict", "These visits contain conflicting saved requests. Both records are unchanged.", 409)
        for row in connection.execute("SELECT id,data FROM attempts WHERE session_id=?", (source,)).fetchall():
            attempt = json.loads(row["data"])
            attempt.setdefault("content_version", source_data["content_version"])
            attempt.setdefault("rule_version", source_data["rule_version"])
            connection.execute("UPDATE attempts SET session_id=?,data=? WHERE id=?", (target, encode(attempt), row["id"]))
        for table in ("events", "asr_requests", "practice_asr_uses"):
            connection.execute(f"UPDATE {table} SET session_id=? WHERE session_id=?", (target, source))
        self.revoke_source(connection, source)

    def revoke_source(self, connection, sid):
        connection.execute("DELETE FROM guest_tokens WHERE session_id=?", (sid,))
        connection.execute("DELETE FROM guest_sessions WHERE session_id=?", (sid,))
        connection.execute("UPDATE sessions SET token_hash=? WHERE id=?", (digest(secrets.token_urlsafe(32)), sid))

    def issue_account(self, connection, user_id, response):
        token, timestamp = secrets.token_urlsafe(32), time.time()
        connection.execute("INSERT INTO auth_tokens VALUES (?,?,?,?)", (digest(token), user_id, timestamp + ACCOUNT_SECONDS, timestamp))
        response.set_cookie(ACCOUNT_COOKIE, token, max_age=ACCOUNT_SECONDS, httponly=True,
                            secure=os.environ.get("COOKIE_SECURE", "false").lower() == "true", samesite="strict", path="/")

    def reset_binding(self, connection, request, previous_id, next_id):
        mode, _sid, user = self.identity(request, connection, allow_legacy=True)
        if mode == "account":
            connection.execute("INSERT OR IGNORE INTO account_sessions VALUES (?,?)", (user["id"], previous_id))
            connection.execute("INSERT OR IGNORE INTO account_sessions VALUES (?,?)", (user["id"], next_id))
            connection.execute("UPDATE users SET session_id=? WHERE id=?", (next_id, user["id"]))
        elif mode == "guest":
            expiry = connection.execute("SELECT expires_at FROM guest_tokens WHERE token_hash=?", (digest(request.headers[GUEST_HEADER]),)).fetchone()["expires_at"]
            connection.execute("UPDATE guest_tokens SET session_id=? WHERE token_hash=?", (next_id, digest(request.headers[GUEST_HEADER])))
            connection.execute("INSERT INTO guest_sessions VALUES (?,?)", (next_id, expiry))
        return mode

    def register_routes(self, app):
        @app.get("/api/auth")
        def get_auth(request: Request):
            with self.database.transaction() as connection:
                return self.state(request, connection)

        @app.post("/api/auth/guest")
        def guest(body: GuestInput, request: Request):
            self.limit(request, "guest")
            with self.database.transaction() as connection:
                # An explicit guest token must never silently fall back to an account.
                self.identity(request, connection)
                sid, _unused = self.create_session(connection, reason="guest")
                data = json.loads(connection.execute("SELECT data FROM sessions WHERE id=?", (sid,)).fetchone()["data"])
                data["locale"] = body.locale
                connection.execute("UPDATE sessions SET data=? WHERE id=?", (encode(data), sid))
                token, timestamp = secrets.token_urlsafe(32), time.time()
                connection.execute("INSERT INTO guest_tokens VALUES (?,?,?,?)", (digest(token), sid, timestamp + GUEST_SECONDS, timestamp))
                connection.execute("INSERT INTO guest_sessions VALUES (?,?)", (sid, timestamp + GUEST_SECONDS))
                return {**self.state(request, connection, identity=("guest", sid, None)), "guest_token": token}

        @app.post("/api/auth/register")
        def register(body: CredentialsInput, request: Request, response: Response):
            username, key = self.credentials(body)
            self.limit(request, "register", key)
            hashed = password_hash(body.password)
            with self.database.transaction() as connection:
                if connection.execute("SELECT 1 FROM users WHERE username_key=?", (key,)).fetchone():
                    self.problem("username_taken", "This username is already taken.", 409)
                sources = self.sources(request, connection, body.import_legacy)
                for source in sources:
                    self.check_idle(connection, source)
                # Preserve a claimed legacy session's course binding rather than relabeling it.
                sid = sources[-1] if sources else self.create_session(connection, reason="account")[0]
                for source in sources:
                    self.merge(connection, source, sid)
                self.revoke_source(connection, sid)
                if body.locale is not None:
                    data = json.loads(connection.execute("SELECT data FROM sessions WHERE id=?", (sid,)).fetchone()["data"])
                    data["locale"] = body.locale
                    connection.execute("UPDATE sessions SET data=? WHERE id=?", (encode(data), sid))
                user_id = self.identifier()
                connection.execute("INSERT INTO users VALUES (?,?,?,?,?,?)", (user_id, username, key, hashed, sid, self.now()))
                for linked in set([sid, *sources]):
                    connection.execute("INSERT INTO account_sessions VALUES (?,?)", (user_id, linked))
                user = connection.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
                self.issue_account(connection, user_id, response)
                if body.import_legacy:
                    response.delete_cookie(LEGACY_COOKIE, path="/")
                return self.state(request, connection, identity=("account", sid, user))

        @app.post("/api/auth/login")
        def login(body: CredentialsInput, request: Request, response: Response):
            _username, key = self.credentials(body)
            self.limit(request, "login", key)
            with self.database.transaction() as connection:
                candidate = connection.execute("SELECT * FROM users WHERE username_key=?", (key,)).fetchone()
            if not verify_password(body.password, candidate["password_hash"] if candidate else None):
                self.problem("invalid_credentials", "The username or password is incorrect.", 401)
            with self.database.transaction() as connection:
                user = connection.execute("SELECT * FROM users WHERE id=?", (candidate["id"],)).fetchone()
                sid = user["session_id"]
                sources = self.sources(request, connection, body.import_legacy)
                if sources:
                    self.check_idle(connection, sid)
                for source in sources:
                    self.merge(connection, source, sid)
                    connection.execute("INSERT OR IGNORE INTO account_sessions VALUES (?,?)", (user["id"], source))
                self.issue_account(connection, user["id"], response)
                if body.import_legacy:
                    response.delete_cookie(LEGACY_COOKIE, path="/")
                return self.state(request, connection, identity=("account", sid, user))

        @app.post("/api/auth/logout")
        def logout(_body: LogoutInput, request: Request, response: Response):
            with self.database.transaction() as connection:
                if "x-expected-session-id" in request.headers:
                    self.session_id(request, connection)
                if GUEST_HEADER in request.headers:
                    # Ending a guest visit revokes access; scheduled cleanup removes its data.
                    connection.execute("DELETE FROM guest_tokens WHERE token_hash=?", (digest(request.headers[GUEST_HEADER]),))
                else:
                    token = request.cookies.get(ACCOUNT_COOKIE)
                    if token:
                        connection.execute("DELETE FROM auth_tokens WHERE token_hash=?", (digest(token),))
                    response.delete_cookie(ACCOUNT_COOKIE, path="/")
                return self.state(request, connection, identity=("signed_out", None, None))
