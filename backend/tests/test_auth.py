"""Account/temporary-guest contracts against isolated SQLite and synthetic ASR only."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import time
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from app.main import create_app, now
from app.storage import encode


PASSWORD = "A small Shanghai journey"
ACCOUNT_COOKIE = "shanghai_account"
LEGACY_COOKIE = "shanghai_session"


@pytest.fixture
def app(tmp_path):
    return create_app(str(tmp_path / "auth.db"))


@pytest.fixture
def client(app):
    with TestClient(app) as browser:
        yield browser


def register(client, username="Walker", password=PASSWORD, **extra):
    response = client.post("/api/auth/register", json={"username": username, "password": password, **extra})
    assert response.status_code == 200, response.text
    assert response.json()["mode"] == "account"
    return response.json()


def guest(client, **extra):
    response = client.post("/api/auth/guest", json=extra)
    assert response.status_code == 200, response.text
    state = response.json()
    assert state["mode"] == "guest"
    client.headers["X-Guest-Token"] = state["guest_token"]
    return state


def start(client, station="nanxiang"):
    response = client.post("/api/attempts", json={"station_id": station})
    assert response.status_code == 200, response.text
    return response.json()


def practice(client, attempt, operation, **extra):
    response = client.post(f"/api/attempts/{attempt['id']}/practice", json={
        "request_id": str(uuid4()), "expected_revision": attempt["revision"], "operation": operation, **extra,
    })
    assert response.status_code == 200, response.text
    return response.json()["attempt"]


def synthetic_asr(client, text="小笼馒头", request_id=None, pending=False):
    sid = client.get("/api/session").json()["id"]
    request_id = request_id or str(uuid4())
    with client.app.state.database.transaction() as connection:
        connection.execute("INSERT INTO asr_requests VALUES (?,?,?,?,?)", (
            sid, request_id, "synthetic-auth-test", None if pending else encode({"transcript": text}), now(),
        ))
    return request_id


def complete_tea(client):
    attempt = start(client, "teahouse")
    for option, transcript in (("good_tea", "这茶很好喝"), ("thanks", "谢谢")):
        for operation, extra in (
            ("select", {"option_id": option}),
            ("evaluate", {"text": transcript, "asr_request_id": synthetic_asr(client, transcript)}),
            ("continue", {}),
        ):
            if operation == "continue":
                extra["result_request_id"] = attempt["lesson"]["result"]["request_id"]
            response = client.post(f"/api/attempts/{attempt['id']}/lesson", json={
                "request_id": str(uuid4()), "expected_revision": attempt["revision"], "operation": operation, **extra,
            })
            assert response.status_code == 200, response.text
            attempt = response.json()["attempt"]
    assert attempt["status"] == "completed"
    return attempt


def legacy_session(client):
    """Seed an actual old browser binding; the current API cannot mint one."""
    sid, token = str(uuid4()), str(uuid4())
    data = {"id": sid, "locale": "zh", "show_romanization": True, "reduced_motion": False,
            "mode": "development", "content_version": "batch-a-r2.2026-10-17.v1",
            "rule_version": "nanxiang-rules.v2", "created_at": now()}
    with client.app.state.database.transaction() as connection:
        connection.execute("INSERT INTO sessions VALUES (?,?,?)", (sid, hashlib.sha256(token.encode()).hexdigest(), encode(data)))
    client.cookies.set(LEGACY_COOKIE, token, domain="testserver.local")
    return data


def rows(app, statement, parameters=()):
    with app.state.database.transaction() as connection:
        return [dict(row) for row in connection.execute(statement, parameters)]


def test_signed_out_auth_does_not_create_anonymous_progress(client, app):
    response = client.get("/api/auth")
    assert response.status_code == 200
    assert response.json()["mode"] == "signed_out"
    assert response.json().get("session") is None
    assert not client.cookies
    assert client.get("/api/session").status_code == 401
    assert rows(app, "SELECT * FROM sessions") == []
    assert client.post("/api/attempts", json={"station_id": "nanxiang"}).status_code == 401


def test_guest_uses_header_not_long_lived_cookie_and_resumes_within_current_tab(client, app):
    state = guest(client, locale="en")
    token, sid = state["guest_token"], state["session"]["id"]
    assert state["session"]["locale"] == "en"
    assert not client.cookies
    assert token != sid
    record = rows(app, "SELECT * FROM guest_tokens")[0]
    assert record["token_hash"] == hashlib.sha256(token.encode()).hexdigest()
    assert 86390 <= record["expires_at"] - time.time() <= 86410
    attempt = start(client)
    with TestClient(app) as refreshed_tab:
        refreshed_tab.headers["X-Guest-Token"] = token
        assert refreshed_tab.get("/api/auth").json()["session"]["id"] == sid
        assert refreshed_tab.get(f"/api/attempts/{attempt['id']}").status_code == 200
    with TestClient(app) as new_tab:
        assert new_tab.get("/api/auth").json()["mode"] == "signed_out"
        assert new_tab.get(f"/api/attempts/{attempt['id']}").status_code == 401


def test_distinct_guest_tokens_cannot_read_other_guests_progress(client, app):
    first = guest(client)
    attempt = start(client)
    with TestClient(app) as other:
        second = guest(other)
        assert second["session"]["id"] != first["session"]["id"]
        assert other.get(f"/api/attempts/{attempt['id']}").status_code == 404
        assert other.get("/api/events").json() != client.get("/api/events").json()


def test_expired_guest_is_rejected_and_cleaned_without_touching_account(client, app):
    account = register(client)
    account_attempt = start(client)
    with TestClient(app) as temporary:
        state = guest(temporary)
        attempt = practice(temporary, start(temporary), "select", action={"type": "set_order", "item": "xiaolongbao"})
        practice(temporary, attempt, "evaluate", text="小笼馒头", asr_request_id=synthetic_asr(temporary))
        completed_tea = complete_tea(temporary)
        source_ids = (attempt["id"], completed_tea["id"])
        with app.state.database.transaction() as connection:
            # A persisted pre-guided turn can coexist with current practice history.
            connection.execute("INSERT INTO turns VALUES (?,?,?,?,?,?,?,?)", (
                attempt["id"], str(uuid4()), "legacy-fixture", "applied", "{}", "{}", "{}", now(),
            ))
            connection.execute("UPDATE guest_tokens SET expires_at=?", (time.time() - 1,))
            connection.execute("UPDATE guest_sessions SET expires_at=?", (time.time() - 1,))
        assert temporary.get(f"/api/attempts/{attempt['id']}").status_code == 401
        temporary.get("/api/auth")  # Auth maintenance also runs expiry cleanup.
    assert rows(app, "SELECT * FROM guest_tokens") == []
    assert rows(app, "SELECT * FROM sessions WHERE id=?", (state["session"]["id"],)) == []
    assert rows(app, "SELECT * FROM asr_requests WHERE session_id=?", (state["session"]["id"],)) == []
    for table in ("turns", "practice_requests", "lesson_requests"):
        assert rows(app, f"SELECT * FROM {table} WHERE attempt_id IN (?,?)", source_ids) == []
    for table in ("events", "practice_asr_uses", "attempts", "guest_sessions"):
        key = "session_id"
        assert rows(app, f"SELECT * FROM {table} WHERE {key}=?", (state["session"]["id"],)) == []
    assert client.get(f"/api/attempts/{account_attempt['id']}").status_code == 200
    assert client.get("/api/auth").json()["session"]["id"] == account["session"]["id"]


def test_registration_stores_salted_password_and_hashed_account_token(client, app):
    response = client.post("/api/auth/register", json={"username": "  City_Walker  ", "password": PASSWORD})
    assert response.status_code == 200, response.text
    assert response.json()["user"]["username"] == "City_Walker"
    assert PASSWORD not in response.text
    account_cookie = client.cookies.get(ACCOUNT_COOKIE)
    assert account_cookie
    assert "HttpOnly" in response.headers["set-cookie"]
    assert "SameSite=strict" in response.headers["set-cookie"]
    assert "Max-Age=2592000" in response.headers["set-cookie"]
    stored = rows(app, "SELECT * FROM users")[0]
    assert stored["username_key"] == "city_walker"
    assert stored["password_hash"] != PASSWORD and PASSWORD not in stored["password_hash"]
    assert stored["password_hash"].startswith("scrypt$32768$8$3$")
    token = rows(app, "SELECT * FROM auth_tokens")[0]
    assert token["token_hash"] == hashlib.sha256(account_cookie.encode()).hexdigest()
    assert 2591990 <= token["expires_at"] - time.time() <= 2592010
    with TestClient(app) as another:
        register(another, "OtherWalker")
    hashes = [row["password_hash"] for row in rows(app, "SELECT password_hash FROM users")]
    assert len(set(hashes)) == 2  # Same password, independent salts.


@pytest.mark.parametrize("username", ["ab", "a" * 25, "white space", "小上海", "name@host", "Ａlice"])
def test_registration_rejects_invalid_usernames_without_creating_account(client, app, username):
    response = client.post("/api/auth/register", json={"username": username, "password": PASSWORD})
    assert response.status_code == 422
    assert rows(app, "SELECT * FROM users") == []


@pytest.mark.parametrize("password", ["short password", "x" * 129])
def test_registration_rejects_password_outside_length_limits(client, app, password):
    response = client.post("/api/auth/register", json={"username": "Walker", "password": password})
    assert response.status_code == 422
    assert rows(app, "SELECT * FROM users") == []


def test_username_case_insensitive_and_password_whitespace_is_significant(client, app):
    register(client, "Alice", password="  a memorable password  ")
    with TestClient(app) as another:
        duplicate = another.post("/api/auth/register", json={"username": "alice", "password": PASSWORD})
        assert duplicate.status_code == 409
        wrong = another.post("/api/auth/login", json={"username": "ALICE", "password": "a memorable password"})
        assert wrong.status_code == 401
        correct = another.post("/api/auth/login", json={"username": "aLiCe", "password": "  a memorable password  "})
        assert correct.status_code == 200
        assert correct.json()["user"]["username"] == "Alice"
    assert len(rows(app, "SELECT * FROM users")) == 1


def test_concurrent_case_variant_registration_has_one_winner(app):
    def submit(username):
        with TestClient(app) as browser:
            return browser.post("/api/auth/register", json={"username": username, "password": PASSWORD})
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(submit, ("OneWalker", "onewalker")))
    assert sorted(response.status_code for response in results) == [200, 409]
    assert len(rows(app, "SELECT * FROM users")) == 1
    assert len(rows(app, "SELECT * FROM auth_tokens")) == 1


def test_wrong_password_and_missing_user_have_same_public_error(client):
    register(client)
    wrong = client.post("/api/auth/login", json={"username": "Walker", "password": "This password is not right"})
    absent = client.post("/api/auth/login", json={"username": "NoSuchUser", "password": "This password is not right"})
    assert wrong.status_code == absent.status_code == 401
    assert wrong.json() == absent.json()


def test_account_login_restores_progress_in_another_browser_and_logout_revokes_cookie(client, app):
    state = register(client)
    attempt = start(client)
    old_cookie = client.cookies.get(ACCOUNT_COOKIE)
    with TestClient(app) as another:
        signed_in = another.post("/api/auth/login", json={"username": "walker", "password": PASSWORD})
        assert signed_in.status_code == 200
        assert signed_in.json()["session"]["id"] == state["session"]["id"]
        assert another.get(f"/api/attempts/{attempt['id']}").status_code == 200
        assert client.post("/api/auth/logout", json={}).json()["mode"] == "signed_out"
        assert client.get("/api/auth").json()["mode"] == "signed_out"
        assert another.get("/api/auth").json()["mode"] == "account"  # Other valid login stays usable.
    with TestClient(app) as replay:
        replay.cookies.set(ACCOUNT_COOKIE, old_cookie)
        assert replay.get(f"/api/attempts/{attempt['id']}").status_code == 401


def test_server_account_expiry_cannot_be_bypassed_with_old_cookie(client, app):
    register(client)
    attempt = start(client)
    with app.state.database.transaction() as connection:
        connection.execute("UPDATE auth_tokens SET expires_at=?", (time.time() - 1,))
    assert client.get(f"/api/attempts/{attempt['id']}").status_code == 401
    assert client.get("/api/auth").json()["mode"] == "signed_out"
    assert rows(app, "SELECT * FROM attempts WHERE id=?", (attempt["id"],))  # Account data remains.


def test_explicit_guest_header_never_falls_back_to_account_cookie(client, app):
    account = register(client)
    account_attempt = start(client)
    with TestClient(app) as temporary:
        state = guest(temporary)
        guest_attempt = start(temporary)
    client.headers["X-Guest-Token"] = state["guest_token"]
    assert client.get("/api/auth").json()["mode"] == "guest"
    assert client.get("/api/session").json()["id"] != account["session"]["id"]
    assert client.get(f"/api/attempts/{guest_attempt['id']}").status_code == 200
    assert client.get(f"/api/attempts/{account_attempt['id']}").status_code == 404
    for invalid in ("", "invalid-guest-token"):
        client.headers["X-Guest-Token"] = invalid
        assert client.get(f"/api/attempts/{account_attempt['id']}").status_code == 401
    del client.headers["X-Guest-Token"]
    assert client.get(f"/api/attempts/{account_attempt['id']}").status_code == 200


def test_account_cannot_read_or_modify_other_account_attempt(client, app):
    register(client)
    attempt = start(client)
    with TestClient(app) as other:
        register(other, "OtherWalker")
        assert other.get(f"/api/attempts/{attempt['id']}").status_code == 404
        mutation = other.post(f"/api/attempts/{attempt['id']}/practice", json={
            "request_id": str(uuid4()), "expected_revision": attempt["revision"], "operation": "select",
            "action": {"type": "set_order", "item": "xiaolongbao"},
        })
        assert mutation.status_code == 404
    assert client.get(f"/api/attempts/{attempt['id']}").json() == attempt


def test_registration_adopts_guest_progress_preferences_and_revokes_source_token(client, app):
    source = guest(client, locale="en")
    client.patch("/api/session", json={"show_romanization": False, "reduced_motion": True})
    attempt = start(client)
    signed_in = register(client)
    del client.headers["X-Guest-Token"]
    assert signed_in["session"]["id"] == source["session"]["id"]
    assert signed_in["session"]["show_romanization"] is False
    assert signed_in["session"]["reduced_motion"] is True
    assert client.get(f"/api/attempts/{attempt['id']}").status_code == 200
    with TestClient(app) as old_tab:
        old_tab.headers["X-Guest-Token"] = source["guest_token"]
        assert old_tab.get(f"/api/attempts/{attempt['id']}").status_code == 401
    assert rows(app, "SELECT * FROM guest_tokens WHERE session_id=?", (source["session"]["id"],)) == []


def test_login_merges_guest_asr_events_and_idempotency_without_losing_existing_success(client, app):
    account = register(client)
    completed = complete_tea(client)
    with TestClient(app) as temporary:
        source = guest(temporary)
        attempt = practice(temporary, start(temporary), "select", action={"type": "set_order", "item": "xiaolongbao"})
        asr_id = synthetic_asr(temporary)
        attempt = practice(temporary, attempt, "evaluate", text="小笼馒头", asr_request_id=asr_id)
        original_result = attempt["practice"]["result"]
        source_events = temporary.get("/api/events").json()
        signed_in = temporary.post("/api/auth/login", json={"username": "walker", "password": PASSWORD})
        assert signed_in.status_code == 200, signed_in.text
        assert signed_in.json()["session"]["id"] == account["session"]["id"]
        del temporary.headers["X-Guest-Token"]
        recovered = temporary.get(f"/api/attempts/{attempt['id']}").json()
        assert recovered["practice"]["result"] == original_result
        saved_evaluation = temporary.get(f"/api/attempts/{attempt['id']}/practice/{original_result['request_id']}")
        assert saved_evaluation.status_code == 200
        assert saved_evaluation.json()["attempt"]["practice"]["result"] == original_result
        advanced = practice(temporary, recovered, "continue", result_request_id=original_result["request_id"])
        assert advanced["order"]["item"] == "xiaolongbao"
        session = temporary.get("/api/session").json()
        assert session["completed_station_ids"] == ["teahouse"]
        assert {item["id"] for item in session["attempts"]} == {completed["id"], attempt["id"]}
        assert {event["event_id"] for event in source_events} <= {event["event_id"] for event in temporary.get("/api/events").json()}
        assert temporary.post("/api/auth/login", json={"username": "Walker", "password": PASSWORD}).status_code == 200
        assert len(temporary.get("/api/session").json()["attempts"]) == 2
    for table, key in (("asr_requests", "request_id"), ("practice_asr_uses", "asr_request_id")):
        record = rows(app, f"SELECT * FROM {table} WHERE {key}=?", (asr_id,))[0]
        assert record["session_id"] == account["session"]["id"]
    with TestClient(app) as stale:
        stale.headers["X-Guest-Token"] = source["guest_token"]
        assert stale.get(f"/api/attempts/{attempt['id']}").status_code == 401


def test_legacy_cookie_is_not_auto_login_and_requires_explicit_import(client, app):
    legacy = legacy_session(client)
    attempt = start(client)
    response = client.get("/api/auth")
    assert response.json()["mode"] == "signed_out"
    state = register(client, import_legacy=False)
    assert state["session"]["id"] != legacy["id"]
    assert state["session"]["attempts"] == []
    assert rows(app, "SELECT * FROM attempts WHERE id=?", (attempt["id"],))


def test_explicit_legacy_merge_freezes_missing_attempt_versions_and_revokes_old_cookie(client, app):
    account = register(client)
    with TestClient(app) as legacy:
        old_session = legacy_session(legacy)
        old_cookie = legacy.cookies.get(LEGACY_COOKIE)
        old_versions = {field: account["session"][field] for field in ("content_version", "rule_version")}
        with app.state.database.transaction() as connection:
            stored = json.loads(connection.execute("SELECT data FROM sessions WHERE id=?", (old_session["id"],)).fetchone()["data"])
            stored.update(old_versions)
            connection.execute("UPDATE sessions SET data=? WHERE id=?", (encode(stored), old_session["id"]))
        attempt = start(legacy)
        with app.state.database.transaction() as connection:
            stored = json.loads(connection.execute("SELECT data FROM attempts WHERE id=?", (attempt["id"],)).fetchone()["data"])
            for field in old_versions:
                stored.pop(field, None)
            connection.execute("UPDATE attempts SET data=? WHERE id=?", (encode(stored), attempt["id"]))
        response = legacy.post("/api/auth/login", json={"username": "Walker", "password": PASSWORD, "import_legacy": True})
        assert response.status_code == 200, response.text
        assert response.json()["session"]["id"] == account["session"]["id"]
        recovered = legacy.get(f"/api/attempts/{attempt['id']}").json()
        assert {field: recovered[field] for field in old_versions} == old_versions
    with TestClient(app) as stale:
        stale.cookies.set(LEGACY_COOKIE, old_cookie)
        assert stale.get(f"/api/attempts/{attempt['id']}").status_code == 401


def test_pending_guest_asr_blocks_merge_then_retry_preserves_progress(client, app):
    account = register(client)
    with TestClient(app) as temporary:
        source = guest(temporary)
        attempt = start(temporary)
        pending_id = synthetic_asr(temporary, pending=True)
        response = temporary.post("/api/auth/login", json={"username": "Walker", "password": PASSWORD})
        assert response.status_code == 409
        assert response.json()["detail"]["code"] == "merge_in_progress"
        assert temporary.get(f"/api/attempts/{attempt['id']}").status_code == 200
        assert rows(app, "SELECT session_id FROM attempts WHERE id=?", (attempt["id"],))[0]["session_id"] == source["session"]["id"]
        assert client.get("/api/session").json()["attempts"] == []
        with app.state.database.transaction() as connection:
            connection.execute("UPDATE asr_requests SET response=? WHERE session_id=? AND request_id=?", (
                encode({"transcript": "小笼馒头"}), source["session"]["id"], pending_id,
            ))
        retried = temporary.post("/api/auth/login", json={"username": "Walker", "password": PASSWORD})
        assert retried.status_code == 200, retried.text
        assert retried.json()["session"]["id"] == account["session"]["id"]


def test_request_id_collision_rejects_entire_merge_without_consuming_guest(client, app):
    account = register(client)
    collision = str(uuid4())
    synthetic_asr(client, text="账号的识别结果", request_id=collision)
    with TestClient(app) as temporary:
        source = guest(temporary)
        attempt = start(temporary)
        synthetic_asr(temporary, text="游客的识别结果", request_id=collision)
        response = temporary.post("/api/auth/login", json={"username": "Walker", "password": PASSWORD})
        assert response.status_code == 409
        assert response.json()["detail"]["code"] == "merge_conflict"
        assert temporary.get("/api/auth").json()["mode"] == "guest"
        assert temporary.get(f"/api/attempts/{attempt['id']}").status_code == 200
        stored = rows(app, "SELECT session_id,response FROM asr_requests WHERE request_id=?", (collision,))
        assert {row["session_id"] for row in stored} == {account["session"]["id"], source["session"]["id"]}
        assert len({row["response"] for row in stored}) == 2
        assert client.get("/api/session").json()["attempts"] == []


def test_auth_repeated_login_failures_are_limited_without_creating_accounts(client, app):
    statuses = []
    for _ in range(25):
        response = client.post("/api/auth/login", json={"username": "MissingWalker", "password": PASSWORD})
        statuses.append(response.status_code)
        if response.status_code == 429:
            break
    assert 401 in statuses and statuses[-1] == 429
    assert rows(app, "SELECT * FROM users") == []
    assert rows(app, "SELECT * FROM auth_rate_limits")


def test_auth_writes_reject_cross_site_requests_before_account_creation(client, app):
    response = client.post("/api/auth/register", json={"username": "Walker", "password": PASSWORD}, headers={"Origin": "https://other.example"})
    assert response.status_code == 403
    assert rows(app, "SELECT * FROM users") == []


def test_old_legacy_can_be_claimed_by_new_account_without_relabeling_course(client, app):
    previous = legacy_session(client)
    attempt = start(client)
    state = register(client, import_legacy=True)
    assert state["session"]["id"] == previous["id"]
    for field in ("content_version", "rule_version"):
        assert state["session"][field] == previous[field]
        assert client.get(f"/api/attempts/{attempt['id']}").json()[field] == previous[field]
    assert client.get("/api/auth").json()["legacy_available"] is False


def test_different_course_versions_reject_merge_and_leave_both_histories_unchanged(client, app):
    account = register(client)
    account_attempt = start(client)
    with TestClient(app) as legacy:
        previous = legacy_session(legacy)
        old_attempt = start(legacy)
        before = legacy.get("/api/session").json()
        response = legacy.post("/api/auth/login", json={"username": "Walker", "password": PASSWORD, "import_legacy": True})
        assert response.status_code == 409
        assert response.json()["detail"]["code"] == "merge_conflict"
        assert legacy.get("/api/session").json() == before
        assert legacy.get(f"/api/attempts/{old_attempt['id']}").json() == old_attempt
        assert legacy.get("/api/auth").json()["legacy_available"] is True
        assert legacy.cookies.get(ACCOUNT_COOKIE) is None
    current = client.get("/api/session").json()
    assert current["id"] == account["session"]["id"]
    assert [attempt["id"] for attempt in current["attempts"]] == [account_attempt["id"]]
    assert rows(app, "SELECT * FROM sessions WHERE id=?", (previous["id"],))
