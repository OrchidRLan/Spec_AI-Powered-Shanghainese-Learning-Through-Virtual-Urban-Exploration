"""Authentication lifecycle races use only an in-process synthetic ASR provider."""
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from threading import Event
import json
import subprocess
from pathlib import Path
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from test_auth import app, client, guest, register, start, rows, PASSWORD, ACCOUNT_COOKIE
from app.providers import QwenASR


@dataclass
class SyntheticTranscript:
    status: str = "ok"
    transcript: str = "private late transcript"


def test_guest_merge_during_upload_cannot_save_late_asr(client, app, monkeypatch):
    account = register(client)
    with TestClient(app) as temporary, TestClient(app) as merger:
        state = guest(temporary)
        attempt = start(temporary)
        merger.headers["X-Guest-Token"] = state["guest_token"]
        called = []

        async def forbidden_provider(self, request):
            called.append(True)
            raise AssertionError("Merged guest upload must never reach the provider")

        monkeypatch.setattr(QwenASR, "transcribe", forbidden_provider)

        def upload():
            yield b"RIFF"
            result = merger.post("/api/auth/login", json={"username": "Walker", "password": PASSWORD})
            assert result.status_code == 200, result.text
            yield b"synthetic audio bytes"

        response = temporary.post("/api/asr", content=upload(), headers={"Content-Type": "audio/wav", "X-Request-ID": str(uuid4())})
        assert response.status_code == 401
        assert called == []
        assert rows(app, "SELECT * FROM asr_requests") == []
        assert client.get(f"/api/attempts/{attempt['id']}").status_code == 200
        assert client.get("/api/session").json()["id"] == account["session"]["id"]


def test_logout_during_asr_discards_transcript_and_finishes_pending_request(client, app, monkeypatch):
    state = register(client)
    entered, release = Event(), Event()

    async def delayed_provider(self, request):
        entered.set()
        assert release.wait(5)
        return SyntheticTranscript()

    monkeypatch.setattr(QwenASR, "transcribe", delayed_provider)
    with TestClient(app) as logout_browser, ThreadPoolExecutor(max_workers=1) as pool:
        logout_browser.cookies.update(client.cookies)
        future = pool.submit(client.post, "/api/asr", content=b"synthetic", headers={"Content-Type": "audio/wav", "X-Request-ID": str(uuid4())})
        assert entered.wait(5)
        try:
            assert logout_browser.post("/api/auth/logout", json={}).status_code == 200
        finally:
            release.set()
        response = future.result(timeout=5)
    assert response.status_code == 401
    stored = rows(app, "SELECT response FROM asr_requests WHERE session_id=?", (state["session"]["id"],))
    assert len(stored) == 1
    assert json.loads(stored[0]["response"])["error"]["code"] == "session_ended"
    assert "private late transcript" not in stored[0]["response"]
    assert rows(app, "SELECT * FROM events WHERE event_type='asr_finished'") == []


def test_guest_expiry_during_asr_does_not_recreate_removed_data(client, app, monkeypatch):
    state = guest(client)
    entered, release = Event(), Event()

    async def delayed_provider(self, request):
        entered.set()
        assert release.wait(5)
        return SyntheticTranscript()

    monkeypatch.setattr(QwenASR, "transcribe", delayed_provider)
    with TestClient(app) as cleaner, ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(client.post, "/api/asr", content=b"synthetic", headers={"Content-Type": "audio/wav", "X-Request-ID": str(uuid4())})
        assert entered.wait(5)
        try:
            with app.state.database.transaction() as connection:
                connection.execute("UPDATE guest_sessions SET expires_at=0 WHERE session_id=?", (state["session"]["id"],))
                connection.execute("UPDATE guest_tokens SET expires_at=0 WHERE session_id=?", (state["session"]["id"],))
            assert cleaner.get("/api/auth").json()["mode"] == "signed_out"
        finally:
            release.set()
        response = future.result(timeout=5)
    assert response.status_code == 401
    for table in ("sessions", "asr_requests", "events"):
        assert rows(app, f"SELECT * FROM {table}") == []


def test_new_session_keeps_account_binding_and_owned_history(client, app):
    original = register(client)
    old_attempt = start(client)
    response = client.post("/api/session/new", json={})
    assert response.status_code == 200
    fresh = response.json()
    assert fresh["id"] != original["session"]["id"]
    assert client.get("/api/auth").json()["session"]["id"] == fresh["id"]
    assert client.get(f"/api/attempts/{old_attempt['id']}").status_code == 404
    linked = rows(app, "SELECT session_id FROM account_sessions")
    assert {item["session_id"] for item in linked} == {fresh["id"], original["session"]["id"]}
    assert rows(app, "SELECT id FROM attempts WHERE id=?", (old_attempt["id"],))
    with TestClient(app) as other:
        response = other.post("/api/auth/login", json={"username": "Walker", "password": PASSWORD})
        assert response.json()["session"]["id"] == fresh["id"]


def test_new_guest_session_reuses_token_without_extending_expiry(client, app):
    previous = guest(client)
    token = client.headers["X-Guest-Token"]
    expiry = rows(app, "SELECT expires_at FROM guest_tokens")[0]["expires_at"]
    response = client.post("/api/session/new", json={})
    assert response.status_code == 200
    fresh = response.json()
    assert fresh["id"] != previous["session"]["id"]
    assert "set-cookie" not in response.headers
    assert client.get("/api/auth").json()["session"]["id"] == fresh["id"]
    assert client.headers["X-Guest-Token"] == token
    assert rows(app, "SELECT expires_at FROM guest_tokens")[0]["expires_at"] == expiry
    assert len(rows(app, "SELECT * FROM guest_sessions")) == 2


def test_guest_creation_rate_limit_prevents_unbounded_session_growth(client, app):
    for _ in range(50):
        assert client.post("/api/auth/guest", json={}).status_code == 200
    denied = client.post("/api/auth/guest", json={})
    assert denied.status_code == 429
    assert len(rows(app, "SELECT * FROM sessions")) == 50


def test_cleanup_command_only_removes_expired_guests(client, app):
    account = register(client)
    with TestClient(app) as temporary:
        state = guest(temporary)
        start(temporary)
    with app.state.database.transaction() as connection:
        connection.execute("UPDATE guest_sessions SET expires_at=0 WHERE session_id=?", (state["session"]["id"],))
    root = Path(__file__).resolve().parents[1]
    result = subprocess.run([str(root / ".venv/bin/python"), "-m", "app.cleanup_guests", "--database", app.state.database.path], cwd=root, text=True, capture_output=True, check=True)
    assert "Removed 1 expired guest visits" in result.stdout
    assert rows(app, "SELECT * FROM sessions WHERE id=?", (state["session"]["id"],)) == []
    assert rows(app, "SELECT * FROM sessions WHERE id=?", (account["session"]["id"],))


def test_expected_session_blocks_stale_tab_from_mutating_another_account(client, app):
    original = register(client, username="FirstWalker")
    with TestClient(app) as second:
        other = register(second, username="OtherWalker")
        before = second.get("/api/session").json()
        client.cookies.clear()
        client.cookies.update(second.cookies)
        client.headers["X-Expected-Session-ID"] = original["session"]["id"]
        requests = [
            ("GET", "/api/session", {}),
            ("PATCH", "/api/session", {"json": {"locale": "en"}}),
            ("POST", "/api/attempts", {"json": {"station_id": "nanxiang"}}),
            ("POST", "/api/events", {"json": {"event_id": str(uuid4()), "event_type": "station_entered"}}),
            ("POST", "/api/asr", {"content": b"synthetic", "headers": {"Content-Type": "audio/wav"}}),
            ("POST", "/api/auth/logout", {"json": {}}),
        ]
        for method, path, options in requests:
            result = client.request(method, path, **options)
            assert result.status_code == 401, (path, result.text)
            assert result.json()["detail"]["code"] == "session_changed"
        assert second.get("/api/session").json() == before
        assert second.get("/api/auth").json()["session"]["id"] == other["session"]["id"]


def test_stale_pending_asr_can_merge_and_late_cloud_result_cannot_reopen_it(client, app, monkeypatch):
    from datetime import datetime, timedelta, timezone

    account = register(client)
    entered, release = Event(), Event()
    request_id = str(uuid4())

    async def delayed_provider(self, request):
        entered.set()
        assert release.wait(5)
        return SyntheticTranscript()

    monkeypatch.setattr(QwenASR, "transcribe", delayed_provider)
    with TestClient(app) as temporary, ThreadPoolExecutor(max_workers=1) as pool:
        source = guest(temporary)
        attempt = start(temporary)
        future = pool.submit(client.post, "/api/asr", content=b"synthetic", headers={"Content-Type": "audio/wav", "X-Request-ID": request_id})
        assert entered.wait(5)
        try:
            with app.state.database.transaction() as connection:
                old = (datetime.now(timezone.utc) - timedelta(seconds=31)).isoformat()
                connection.execute("UPDATE asr_requests SET created_at=? WHERE request_id=?", (old, request_id))
            saved = temporary.post("/api/auth/login", json={"username": "Walker", "password": PASSWORD})
            assert saved.status_code == 200, saved.text
            assert saved.json()["session"]["id"] == account["session"]["id"]
        finally:
            release.set()
        response = future.result(timeout=5)
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "asr_interrupted"
    stored = rows(app, "SELECT response FROM asr_requests WHERE request_id=?", (request_id,))[0]["response"]
    assert "private late transcript" not in stored
    assert json.loads(stored)["error"]["code"] == "asr_interrupted"
    assert client.get(f"/api/attempts/{attempt['id']}").status_code == 200


def test_ending_guest_tab_does_not_revoke_account_cookie_from_another_tab(client, app):
    account = register(client)
    with TestClient(app) as temporary:
        state = guest(temporary)
        temporary.cookies.update(client.cookies)
        temporary.headers["X-Expected-Session-ID"] = state["session"]["id"]
        response = temporary.post("/api/auth/logout", json={})
        assert response.status_code == 200
        assert response.json()["mode"] == "signed_out"
        assert "set-cookie" not in response.headers
        assert temporary.get("/api/auth").status_code == 401
    assert client.get("/api/auth").json()["session"]["id"] == account["session"]["id"]


@pytest.mark.parametrize("status", ["processing", "prepared"])
@pytest.mark.parametrize("age", [1, 31])
def test_legacy_pending_turn_claim_cancels_only_stale_requests(client, app, status, age):
    from datetime import datetime, timedelta, timezone
    from test_api import bind_r2
    from app.models import Interpretation
    from app.storage import encode

    bind_r2(client)
    attempt = start(client)
    request_id = str(uuid4())
    payload = encode({"request_id": request_id, "expected_revision": 0, "channel": "text", "text": "两份小笼包外带"})
    interpretation = Interpretation(intent="provide", changes={"quantity": 2, "unit": "serving", "takeaway": True}).model_dump_json()
    with app.state.database.transaction() as connection:
        old = (datetime.now(timezone.utc) - timedelta(seconds=age)).isoformat()
        connection.execute("INSERT INTO turns VALUES (?,?,?,?,?,?,?,?)", (attempt["id"], request_id, "original-fingerprint", status, payload, interpretation if status == "prepared" else None, None, old))
        stored = json.loads(connection.execute("SELECT data FROM attempts WHERE id=?", (attempt["id"],)).fetchone()["data"])
        stored["pending_request_id"] = request_id
        connection.execute("UPDATE attempts SET data=? WHERE id=?", (encode(stored), attempt["id"]))
    response = client.post("/api/auth/register", json={"username": "OldWalker", "password": PASSWORD, "import_legacy": True})
    saved = rows(app, "SELECT * FROM turns WHERE attempt_id=? AND request_id=?", (attempt["id"], request_id))[0]
    assert saved["payload"] == payload
    assert saved["fingerprint"] == "original-fingerprint"
    if age == 1:
        assert response.status_code == 409
        assert response.json()["detail"]["code"] == "merge_in_progress"
        assert saved["status"] == status
        assert rows(app, "SELECT * FROM users") == []
        assert client.get(f"/api/attempts/{attempt['id']}").json()["pending_request_id"] == request_id
    else:
        assert response.status_code == 200, response.text
        assert saved["status"] == "cancelled"
        current = client.get(f"/api/attempts/{attempt['id']}").json()
        assert current["pending_request_id"] is None
        assert current["order"] == attempt["order"]
        assert current["revision"] == attempt["revision"]
        assert client.get(f"/api/attempts/{attempt['id']}/turns/{request_id}").json()["status"] == "cancelled"


def test_legacy_claim_timeout_blocks_late_interpretation_from_applying_order(client, app):
    from datetime import datetime, timedelta, timezone
    from test_api import bind_r2
    from app.interpreter import parse_development

    bind_r2(client)
    attempt = start(client)
    entered, release = Event(), Event()
    request_id = str(uuid4())

    def delayed_interpreter(text, current):
        entered.set()
        assert release.wait(5)
        return parse_development(text, current)

    app.state.interpreter = delayed_interpreter
    with TestClient(app) as importer, ThreadPoolExecutor(max_workers=1) as pool:
        importer.cookies.update(client.cookies)
        future = pool.submit(client.post, f"/api/attempts/{attempt['id']}/turns", json={"request_id": request_id, "expected_revision": attempt["revision"], "channel": "text", "text": "两份小笼包外带"})
        assert entered.wait(5)
        try:
            with app.state.database.transaction() as connection:
                old = (datetime.now(timezone.utc) - timedelta(seconds=31)).isoformat()
                connection.execute("UPDATE turns SET created_at=? WHERE attempt_id=? AND request_id=?", (old, attempt["id"], request_id))
            response = importer.post("/api/auth/register", json={"username": "OldWalker", "password": PASSWORD, "import_legacy": True})
            assert response.status_code == 200, response.text
        finally:
            release.set()
        late = future.result(timeout=5)
        assert late.status_code == 200
        assert late.json()["status"] == "cancelled"
        current = importer.get(f"/api/attempts/{attempt['id']}").json()
        assert current["order"] == attempt["order"]
        assert current["pending_request_id"] is None
        assert current["revision"] == attempt["revision"]
        saved = rows(app, "SELECT * FROM turns WHERE attempt_id=? AND request_id=?", (attempt["id"], request_id))[0]
        assert saved["status"] == "cancelled"
        assert saved["interpretation"] is None
