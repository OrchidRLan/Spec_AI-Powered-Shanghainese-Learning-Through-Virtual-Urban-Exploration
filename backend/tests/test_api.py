from concurrent.futures import ThreadPoolExecutor
from threading import Event
from uuid import uuid4
import io
import json
import sqlite3
import wave

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.interpreter import parse_development
from app.models import Interpretation


@pytest.fixture
def app(tmp_path):
    return create_app(str(tmp_path / "test.db"))


@pytest.fixture
def client(app):
    with TestClient(app) as client:
        assert client.get("/api/session").status_code == 200
        yield client


def start(client, restart=False):
    response = client.post("/api/attempts", json={"station_id": "nanxiang", "restart": restart})
    assert response.status_code == 200, response.text
    return response.json()


def submit(client, attempt, action=None, text=None, request_id=None, **extra):
    body = {"request_id": request_id or str(uuid4()), "expected_revision": attempt["revision"],
            "channel": "text" if text else "buttons", **extra}
    body.update({"text": text} if text else {"action": action})
    response = client.post(f"/api/attempts/{attempt['id']}/turns", json=body)
    assert response.status_code == 200, response.text
    return response.json()["attempt"]


def order(client, attempt):
    return submit(client, attempt, {"type": "set_order", "item": "xiaolongbao", "quantity": 2, "unit": "serving", "takeaway": True})


def confirm(client, attempt):
    return submit(client, attempt, {"type": "confirm"}, summary_revision=attempt["summary_revision"])


def test_initial_unknown_and_cookie_security(client):
    response = client.get("/api/session")
    assert "HttpOnly" in response.headers["set-cookie"]
    assert "SameSite=strict" in response.headers["set-cookie"]
    assert response.json()["id"] not in response.headers["set-cookie"]
    attempt = start(client)
    assert all(v is None for v in attempt["order"].values())
    assert attempt["summary_revision"] is None
    assert client.patch("/api/session", json={"locale": "en", "show_romanization": False}).json()["locale"] == "en"
    assert client.get("/api/session").json()["show_romanization"] is False


def test_button_complete_and_review_is_separate(client):
    attempt = order(client, start(client))
    assert attempt["status"] == "confirming"
    assert attempt["confirmed_revision"] is None
    completed = confirm(client, attempt)
    assert completed["status"] == "completed"
    assert completed["metrics"]["voice_attempts"] == 0
    assert completed["confirmed_revision"] == attempt["revision"]
    assert client.get("/api/session").json()["completed_station_ids"] == ["nanxiang"]
    assert len([e for e in client.get("/api/events").json() if e["event_type"] == "task_completed"]) == 1


@pytest.mark.parametrize("initial,expected", [("外带", True), ("堂吃", False), ("不要打包", False), ("不堂吃，要打包", True)])
def test_text_takeaway_tristate(client, initial, expected):
    attempt = submit(client, start(client), text=initial)
    assert attempt["order"]["takeaway"] is expected
    assert attempt["order"]["item"] is None
    assert attempt["order"]["quantity"] is None
    assert attempt["status"] == "collecting"


def test_full_text_and_premature_confirmation(client):
    attempt = submit(client, start(client), text="我要两份小笼包外带，对的")
    assert attempt["status"] == "confirming"
    assert attempt["confirmed_revision"] is None
    attempt = submit(client, attempt, text="对的", summary_revision=attempt["summary_revision"])
    assert attempt["status"] == "completed"


def test_text_split_order_preserves_valid_fields(client):
    attempt = submit(client, start(client), text="外带")
    attempt = submit(client, attempt, text="小笼包")
    assert attempt["prompt_id"] == "NX-N02"
    attempt = submit(client, attempt, text="两")
    assert attempt["status"] == "confirming"
    assert attempt["turns"][-1]["interpretation"]["evidence"]["unit"].startswith("context:")


@pytest.mark.parametrize("text,issue", [("两个", "unit_unknown"), ("两只小笼包外带", "piece_not_serving"), ("200份小笼包外带", "quantity_out_of_range"), ("两份还是三份都行", "ambiguous_quantity")])
def test_invalid_quantity_never_completes(client, text, issue):
    attempt = submit(client, start(client), text=text)
    assert issue in attempt["unresolved_issues"]
    assert attempt["status"] == "collecting"
    assert attempt["summary_revision"] is None


def test_basket_requires_seen_convention(client):
    attempt = submit(client, start(client), text="两笼小笼包外带")
    assert attempt["order"]["normalized_servings"] is None
    assert "basket_unit_unexplained" in attempt["unresolved_issues"]
    event = {"event_id": str(uuid4()), "attempt_id": attempt["id"], "event_type": "unit_explanation_viewed"}
    assert client.post("/api/events", json=event).status_code == 200
    current = client.get(f"/api/attempts/{attempt['id']}").json()
    assert current["order"]["normalized_servings"] is None  # Help does not submit an order.
    attempt = submit(client, current, text="两笼")
    assert attempt["order"]["unit"] == "basket"
    assert attempt["order"]["normalized_servings"] == 2
    assert attempt["status"] == "confirming"


def test_invalid_modification_blocks_old_confirmation(client):
    attempt = order(client, start(client))
    old_revision = attempt["summary_revision"]
    changed = submit(client, attempt, text="对，改成三份")
    assert changed["order"]["quantity"] == 3
    assert changed["status"] == "collecting"
    assert changed["confirmed_revision"] is None
    stale = client.post(f"/api/attempts/{attempt['id']}/turns", json={"request_id": str(uuid4()), "expected_revision": changed["revision"], "channel": "buttons", "action": {"type": "confirm"}, "summary_revision": old_revision})
    assert stale.status_code == 409
    attempt = order(client, changed)
    invalid = submit(client, attempt, text="改一下")
    assert invalid["order"]["quantity"] == 2
    assert invalid["status"] == "collecting"
    assert "unclear_modification" in invalid["unresolved_issues"]
    assert submit(client, invalid, {"type": "confirm"})["status"] != "completed"


def test_ambiguous_quantity_cannot_be_resolved_by_unrelated_mode(client):
    attempt = order(client, start(client))
    attempt = submit(client, attempt, text="两份还是三份都行")
    attempt = submit(client, attempt, text="外带")
    assert "ambiguous_quantity" in attempt["unresolved_issues"]
    assert attempt["status"] == "collecting"
    attempt = submit(client, attempt, text="两份")
    assert attempt["status"] == "confirming"


def test_repeat_does_not_confirm_or_change_revision(client):
    attempt = order(client, start(client))
    repeated = submit(client, attempt, text="没听清")
    assert repeated["status"] == "confirming"
    assert repeated["revision"] == attempt["revision"]


def test_same_id_idempotent_payload_checked_and_late_revision_rejected(client):
    attempt = order(client, start(client))
    body = {"request_id": str(uuid4()), "expected_revision": attempt["revision"], "channel": "buttons", "action": {"type": "confirm"}, "summary_revision": attempt["summary_revision"]}
    path = f"/api/attempts/{attempt['id']}/turns"
    first = client.post(path, json=body)
    second = client.post(path, json=body)
    assert first.status_code == second.status_code == 200
    assert first.json() == second.json()
    body["action"] = {"type": "repeat"}
    assert client.post(path, json=body).status_code == 409
    assert len([e for e in client.get("/api/events").json() if e["event_type"] == "task_completed"]) == 1


def test_other_tab_stale_revision(client):
    attempt = start(client)
    updated = order(client, attempt)
    response = client.post(f"/api/attempts/{attempt['id']}/turns", json={"request_id": str(uuid4()), "expected_revision": 0, "channel": "buttons", "action": {"type": "set_order", "takeaway": False}})
    assert response.status_code == 409
    assert response.json()["detail"]["attempt"]["revision"] == updated["revision"]


def test_failed_save_never_completes_and_same_request_recovers(app, client):
    attempt = order(client, start(client))
    request_id = str(uuid4())
    body = {"request_id": request_id, "expected_revision": attempt["revision"], "channel": "buttons", "action": {"type": "confirm"}, "summary_revision": attempt["summary_revision"]}
    def fail():
        raise sqlite3.OperationalError("simulated disk full")
    app.state.before_commit = fail
    path = f"/api/attempts/{attempt['id']}/turns"
    response = client.post(path, json=body)
    assert response.status_code == 503
    saved = client.get(f"/api/attempts/{attempt['id']}").json()
    assert saved["status"] == "confirming"
    assert not any(e["event_type"] == "task_completed" for e in client.get("/api/events").json())
    assert client.get(path + "/" + request_id).json()["status"] == "pending"
    app.state.before_commit = None
    response = client.post(path, json=body)
    assert response.json()["attempt"]["status"] == "completed"


def test_cancel_during_processing_blocks_late_result(app, client):
    entered, release = Event(), Event()
    def slow(text, attempt):
        entered.set()
        assert release.wait(timeout=5)
        return parse_development(text, attempt)
    app.state.interpreter = slow
    attempt = start(client)
    request_id = str(uuid4())
    path = f"/api/attempts/{attempt['id']}/turns"
    body = {"request_id": request_id, "expected_revision": 0, "channel": "text", "text": "两份小笼包外带"}
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(client.post, path, json=body)
        assert entered.wait(timeout=5)
        pending = client.post(path, json=body)
        assert pending.json()["status"] == "pending"
        busy = client.post(path, json={**body, "request_id": str(uuid4())})
        assert busy.status_code == 409
        cancelled = client.post(path + "/" + request_id + "/cancel", json={"expected_revision": 0})
        assert cancelled.json()["status"] == "cancelled"
        release.set()
        assert future.result(timeout=5).json()["status"] == "cancelled"
    saved = client.get(f"/api/attempts/{attempt['id']}").json()
    assert saved["order"]["quantity"] is None
    assert saved["pending_request_id"] is None


def test_cancel_before_arrival_tombstone(client):
    attempt = start(client)
    request_id = str(uuid4())
    path = f"/api/attempts/{attempt['id']}/turns/{request_id}"
    assert client.post(path + "/cancel", json={"expected_revision": 0}).json()["status"] == "cancelled"
    body = {"request_id": request_id, "expected_revision": 0, "channel": "text", "text": "两份小笼包外带"}
    response = client.post(f"/api/attempts/{attempt['id']}/turns", json=body)
    assert response.json()["status"] == "cancelled"
    assert response.json()["attempt"]["order"]["quantity"] is None


def test_restart_preserves_success_and_resume(client):
    initial = confirm(client, order(client, start(client)))
    assert start(client)["id"] == initial["id"]
    practice = start(client, restart=True)
    assert practice["id"] != initial["id"]
    assert start(client, restart=True)["id"] == practice["id"]
    assert client.get("/api/session").json()["completed_station_ids"] == ["nanxiang"]
    skipped = client.post(f"/api/attempts/{practice['id']}/skip", json={"expected_revision": 0}).json()
    assert skipped["status"] == "skipped"
    assert start(client, restart=True)["id"] not in {practice["id"], initial["id"]}


def test_persistence_across_process_instance(app, client):
    attempt = order(client, start(client))
    reopened = TestClient(create_app(app.state.database.path))
    reopened.cookies.update(client.cookies)
    assert reopened.get(f"/api/attempts/{attempt['id']}").json()["order"] == attempt["order"]
    assert reopened.get("/api/session").json()["attempts"][0]["id"] == attempt["id"]
    reopened.close()


def test_ownership_all_private_routes_and_no_client_success(app, client):
    attempt = start(client)
    other = TestClient(app)
    other.get("/api/session")
    assert other.get(f"/api/attempts/{attempt['id']}").status_code == 404
    assert other.post(f"/api/attempts/{attempt['id']}/skip", json={"expected_revision": 0}).status_code == 404
    assert other.post("/api/events", json={"event_id": str(uuid4()), "attempt_id": attempt["id"], "event_type": "recording_started"}).status_code == 404
    assert other.get("/api/events").json()[0]["event_type"] == "session_started"
    assert client.post("/api/events", json={"event_id": str(uuid4()), "attempt_id": attempt["id"], "event_type": "task_completed"}).status_code == 422
    no_cookie = TestClient(app)
    assert no_cookie.post("/api/attempts", json={"station_id": "nanxiang"}).status_code == 401


def test_events_are_idempotent_and_do_not_change_order(client):
    attempt = start(client)
    body = {"event_id": str(uuid4()), "attempt_id": attempt["id"], "event_type": "recording_started"}
    assert client.post("/api/events", json=body).json()["duplicate"] is False
    assert client.post("/api/events", json=body).json()["duplicate"] is True
    attempt = client.get(f"/api/attempts/{attempt['id']}").json()
    assert attempt["metrics"]["voice_attempts"] == 1
    assert all(v is None for v in attempt["order"].values())
    body["event_type"] = "recording_stopped"
    assert client.post("/api/events", json=body).status_code == 409


def test_origin_and_strict_request_validation(client):
    assert client.post("/api/attempts", json={"station_id": "nanxiang"}, headers={"Origin": "https://evil.example"}).status_code == 403
    attempt = start(client)
    body = {"request_id": str(uuid4()), "expected_revision": 0, "channel": "buttons", "action": {"type": "set_order", "takeaway": "false"}}
    assert client.post(f"/api/attempts/{attempt['id']}/turns", json=body).status_code == 422
    body["action"] = {"type": "set_order", "quantity": True}
    assert client.post(f"/api/attempts/{attempt['id']}/turns", json=body).status_code == 422


def test_content_and_services_do_not_claim_real_validation(client):
    content = client.get("/api/content")
    assert content.status_code == 200
    assert content.json()["contentVersion"] == client.get("/api/session").json()["content_version"]
    assert client.get("/api/services").json()["text"]["mode"] == "development_parser"


def test_asr_disabled_and_no_raw_recording_persistence(client, monkeypatch):
    monkeypatch.setenv("SPEECH_ENABLE_LIVE", "false")
    monkeypatch.delenv("QWEN_ASR_ENABLE_LIVE", raising=False)
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(16000)
        wav.writeframes(b"\x00\x00" * 1600)
    headers = {"content-type": "audio/wav", "x-request-id": str(uuid4())}
    response = client.post("/api/asr", content=buffer.getvalue(), headers=headers)
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "service_disabled"
    assert client.post("/api/asr", content=buffer.getvalue(), headers=headers).json() == response.json()


def test_invalid_provider_field_cannot_pass_rules(app, client):
    attempt = order(client, start(client))
    app.state.interpreter = lambda *_: Interpretation(intent="modify", changes={"takeaway": "true"})
    attempt = submit(client, attempt, text="fake provider payload")
    assert attempt["status"] == "collecting"
    assert "invalid_takeaway" in attempt["unresolved_issues"]


@pytest.mark.parametrize("text", [
    "-2份小笼包外带", "2.2份小笼包外带", "两份半小笼包外带", "一千零两份小笼包外带",
    "不是小笼包，是面条，两份外带", "two servings xiaolongbao not takeaway",
    "不要两份小笼包外带", "two servings xiaolongbao do not take away",
])
def test_development_parser_negation_and_number_boundary_regressions(client, text):
    fresh = submit(client, start(client), text=text)
    assert fresh["status"] != "confirming"
    # A rejected new expression must not leave an older valid order confirmable.
    current = order(client, fresh)
    changed = submit(client, current, text=text)
    assert changed["status"] == "collecting"
    assert submit(client, changed, {"type": "confirm"})["status"] != "completed"


def test_skip_repractice_then_normal_enter_creates_new_attempt(client):
    completed = confirm(client, order(client, start(client)))
    practice = start(client, restart=True)
    client.post(f"/api/attempts/{practice['id']}/skip", json={"expected_revision": 0})
    resumed = start(client)
    assert resumed["id"] not in (completed["id"], practice["id"])
    assert client.get("/api/session").json()["completed_station_ids"] == ["nanxiang"]


def test_interpretation_failure_is_terminal_and_new_request_can_retry(app, client):
    attempt = start(client)
    def failure(*_):
        raise RuntimeError("temporary service failure")
    app.state.interpreter = failure
    body = {"request_id": str(uuid4()), "expected_revision": 0, "channel": "text", "text": "两份小笼包外带"}
    path = f"/api/attempts/{attempt['id']}/turns"
    failed = client.post(path, json=body)
    assert failed.status_code == 503
    assert failed.json()["detail"]["terminal"] is True
    assert client.get(path + "/" + body["request_id"]).json()["status"] == "failed"
    app.state.interpreter = parse_development
    assert client.post(path, json=body).json()["status"] == "failed"
    body["request_id"] = str(uuid4())
    assert client.post(path, json=body).json()["attempt"]["status"] == "confirming"


def test_voice_source_is_saved_verified_and_cannot_be_claimed_from_other_session(app, client, monkeypatch):
    from app.providers import ASRResult, QwenASR
    calls = []
    async def transcribe(_self, request):
        calls.append(request.request_id)
        return ASRResult("两份小笼包外带", "ok", 5, "test-asr", "upstream-1", "test-only")
    monkeypatch.setattr(QwenASR, "transcribe", transcribe)
    request_id = str(uuid4())
    headers = {"content-type": "audio/wav", "x-request-id": request_id}
    result = client.post("/api/asr", content=b"fixture-only", headers=headers)
    assert result.json()["request_id"] == request_id
    assert client.post("/api/asr", content=b"fixture-only", headers=headers).json() == result.json()
    assert calls == [request_id]
    finished = [event for event in client.get("/api/events").json() if event["event_type"] == "asr_finished"]
    assert len(finished) == 1
    assert finished[0]["metadata"]["reported_by"] == "server"
    assert finished[0]["metadata"]["request_id"] == request_id
    attempt = start(client)
    body = {"request_id": str(uuid4()), "expected_revision": 0, "channel": "voice", "text": "两份小笼包外带", "asr_request_id": request_id}
    path = f"/api/attempts/{attempt['id']}/turns"
    accepted = client.post(path, json=body).json()["attempt"]
    assert accepted["status"] == "confirming"
    assert accepted["turns"][-1]["asr_transcript"] == "两份小笼包外带"
    body.update(request_id=str(uuid4()), expected_revision=accepted["revision"], text="三份小笼包外带")
    assert client.post(path, json=body).status_code == 422
    body["channel"] = "voice_edited"
    edited = client.post(path, json=body).json()["attempt"]
    assert edited["order"]["quantity"] == 3
    assert edited["turns"][-1]["asr_transcript"] == "两份小笼包外带"
    assert edited["turns"][-1]["text"] == "三份小笼包外带"
    other = TestClient(app)
    other.get("/api/session")
    others_attempt = start(other)
    body.update(request_id=str(uuid4()), expected_revision=0)
    assert other.post(f"/api/attempts/{others_attempt['id']}/turns", json=body).status_code == 422


def test_configuration_change_does_not_silently_change_live_session(app, client, monkeypatch):
    from app.providers import ProviderConfig
    current = client.get("/api/session").json()
    assert current["asr_config_id"] == ProviderConfig.from_env("asr").config_id
    monkeypatch.setenv("QWEN_ASR_MODEL", "different-model")
    rejected = client.post("/api/asr", content=b"no-cloud-call", headers={"content-type": "audio/wav"})
    assert rejected.status_code == 409
    assert rejected.json()["detail"]["code"] == "configuration_changed"


def test_semantic_adapter_preserves_actual_model_provenance(monkeypatch):
    import asyncio
    from app.providers import Interpretation as ProviderInterpretation, QwenInterpreter
    from app.semantic import configure_interpreter
    captured = []
    async def interpret(_self, text, context):
        captured.append(context)
        return ProviderInterpretation("provide", {"quantity": 2, "unit": "serving"},
                                      {"quantity": "两", "unit": "份"}, [], False,
                                      config_id="ignored-provider-id", upstream_request_id="up-1", elapsed_ms=7, model="returned-model")
    monkeypatch.setattr(QwenInterpreter, "interpret", interpret)
    interpreter, config_id = configure_interpreter("qwen")
    result = asyncio.run(interpreter("两份", {"station_id": "nanxiang", "order": {}, "prompt_id": "NX-N02", "status": "collecting"}))
    assert result.source == "qwen:" + config_id
    assert result.model == "returned-model"
    assert result.upstream_request_id == "up-1"
    assert "target" not in captured[0]


def test_repeat_intent_cannot_bypass_uncertainties(app, client):
    attempt = order(client, start(client))
    app.state.interpreter = lambda *_: Interpretation(intent="repeat", uncertainties=["ambiguous_quantity"])
    attempt = submit(client, attempt, text="unclear request to repeat or change quantity")
    assert attempt["status"] == "collecting"
    assert "ambiguous_quantity" in attempt["unresolved_issues"]


def test_recorder_diagnostics_never_advance_order_or_count_voice_twice(client):
    attempt = order(client, start(client))
    started = {"event_id": str(uuid4()), "attempt_id": attempt["id"], "event_type": "recording_started"}
    assert client.post("/api/events", json=started).status_code == 200
    for event_type in ("asr_submitted", "asr_succeeded", "asr_failed", "asr_cancelled", "recording_played"):
        body = {"event_id": str(uuid4()), "attempt_id": attempt["id"], "event_type": event_type,
                "metadata": {"reported_by": "server", "status": "completed"}}
        assert client.post("/api/events", json=body).json()["duplicate"] is False
        assert client.post("/api/events", json=body).json()["duplicate"] is True
    updated = client.get(f"/api/attempts/{attempt['id']}").json()
    assert updated["status"] == "confirming"
    assert updated["revision"] == attempt["revision"]
    assert updated["confirmed_revision"] is None
    assert updated["order"] == attempt["order"]
    assert updated["metrics"]["voice_attempts"] == 1
    assert updated["metrics"]["help_used"] == 0
    events = client.get("/api/events").json()
    assert not any(event["event_type"] in ("asr_finished", "task_completed") for event in events)
    diagnostic = next(event for event in events if event["event_type"] == "asr_succeeded")
    assert diagnostic["metadata"]["reported_by"] == "client"
    forged = {"event_id": str(uuid4()), "attempt_id": attempt["id"], "event_type": "asr_finished"}
    assert client.post("/api/events", json=forged).status_code == 422


def test_explicit_new_session_preserves_preferences_and_old_success_but_isolates_access(app, client, monkeypatch):
    from app.main import COOKIE
    from app.providers import ProviderConfig
    completed = confirm(client, order(client, start(client)))
    previous = client.patch("/api/session", json={"locale": "en", "show_romanization": False, "reduced_motion": True}).json()
    old_cookie = client.cookies.get(COOKIE)
    monkeypatch.setenv("QWEN_ASR_MODEL", "new-asr-configuration")
    # Ordinary refresh neither rotates credentials nor rebinds the original config.
    resumed = client.get("/api/session").json()
    assert resumed["id"] == previous["id"]
    assert resumed["asr_config_id"] == previous["asr_config_id"]
    response = client.post("/api/session/new", json={})
    assert response.status_code == 200
    fresh = response.json()
    assert fresh["id"] != previous["id"]
    assert client.cookies.get(COOKIE) != old_cookie
    assert "HttpOnly" in response.headers["set-cookie"]
    assert fresh["locale"] == "en"
    assert fresh["show_romanization"] is False
    assert fresh["reduced_motion"] is True
    assert fresh["attempts"] == fresh["completed_station_ids"] == []
    assert fresh["asr_config_id"] == ProviderConfig.from_env("asr").config_id
    assert fresh["asr_config_id"] != previous["asr_config_id"]
    assert client.get(f"/api/attempts/{completed['id']}").status_code == 404
    assert client.get("/api/session").json()["id"] == fresh["id"]
    with TestClient(app) as old_browser:
        old_browser.cookies.set(COOKIE, old_cookie)
        old = old_browser.get("/api/session").json()
        assert old["id"] == previous["id"]
        assert old["completed_station_ids"] == ["nanxiang"]
        assert old_browser.get(f"/api/attempts/{completed['id']}").json()["status"] == "completed"
    with app.state.database.transaction() as connection:
        assert connection.execute("SELECT count(*) FROM sessions").fetchone()[0] == 2
        assert connection.execute("SELECT count(*) FROM attempts").fetchone()[0] == 1


def test_new_session_requires_owned_cookie_and_empty_explicit_body(app, client):
    previous = client.get("/api/session").json()["id"]
    assert client.post("/api/session/new", json={"id": "borrowed-session"}).status_code == 422
    assert client.get("/api/session").json()["id"] == previous
    with TestClient(app) as no_cookie:
        assert no_cookie.post("/api/session/new", json={}).status_code == 401


def mark_session_as_legacy(app, sid):
    """Represent the pre-R1 persisted schema, without migrating its history."""
    from app.rules import LEGACY_CONTENT_VERSION
    from app.storage import encode
    with app.state.database.transaction() as connection:
        session = json.loads(connection.execute("SELECT data FROM sessions WHERE id=?", (sid,)).fetchone()["data"])
        session.update(content_version=LEGACY_CONTENT_VERSION, model_config_id="development-parser.v1")
        connection.execute("UPDATE sessions SET data=? WHERE id=?", (encode(session), sid))
        for row in connection.execute("SELECT id,data FROM attempts WHERE session_id=?", (sid,)).fetchall():
            attempt = json.loads(row["data"])
            attempt.pop("content_version", None)
            attempt.pop("rule_version", None)
            connection.execute("UPDATE attempts SET data=? WHERE id=?", (encode(attempt), row["id"]))
            for turn in connection.execute("SELECT request_id,response FROM turns WHERE attempt_id=?", (row["id"],)).fetchall():
                if turn["response"]:
                    response = json.loads(turn["response"])
                    response["attempt"].pop("content_version", None)
                    response["attempt"].pop("rule_version", None)
                    connection.execute("UPDATE turns SET response=? WHERE attempt_id=? AND request_id=?", (encode(response), row["id"], turn["request_id"]))


def test_r1_content_loading_preserves_legacy_bindings_and_cached_history(app, client):
    from app.rules import CONTENT_VERSION, LEGACY_CONTENT_VERSION
    attempt = start(client)
    body = {"request_id": str(uuid4()), "expected_revision": 0, "channel": "text", "text": "我要两份小笼包外带"}
    path = f"/api/attempts/{attempt['id']}/turns"
    accepted = client.post(path, json=body).json()["attempt"]
    completed = confirm(client, accepted)
    old_sid = client.get("/api/session").json()["id"]
    mark_session_as_legacy(app, old_sid)
    # Opening a new application instance does not migrate the old cookie/session.
    with TestClient(create_app(app.state.database.path)) as restarted:
        restarted.cookies.update(client.cookies)
        old_session = restarted.get("/api/session").json()
        assert old_session["content_version"] == LEGACY_CONTENT_VERSION
        assert old_session["model_config_id"] == "development-parser.v1"
        assert old_session["attempts"][0]["content_version"] == LEGACY_CONTENT_VERSION
        assert old_session["completed_station_ids"] == ["nanxiang"]
        old_content = restarted.get("/api/content").json()
        assert old_content["contentVersion"] == LEGACY_CONTENT_VERSION
        assert old_content["expressions"][0]["hanzi"] == "我要两份小笼包"
        assert restarted.get(f"/api/attempts/{attempt['id']}").json()["content_version"] == LEGACY_CONTENT_VERSION
        for result in (restarted.get(path + "/" + body["request_id"]), restarted.post(path, json=body)):
            cached = result.json()["attempt"]
            assert cached["content_version"] == LEGACY_CONTENT_VERSION
            assert cached["revision"] == accepted["revision"]  # Original snapshot, not latest success.
            assert cached["status"] == "confirming"
            assert cached["turns"][0]["text"] == body["text"]
        practice = start(restarted, restart=True)
        assert practice["content_version"] == LEGACY_CONTENT_VERSION
        # New parser behavior is not silently substituted for an old binding.
        rejected = restarted.post(f"/api/attempts/{practice['id']}/turns", json={**body, "request_id": str(uuid4())})
        assert rejected.status_code == 409
        assert rejected.json()["detail"]["code"] == "configuration_changed"
        new_session = restarted.post("/api/session/new", json={}).json()
        assert new_session["content_version"] == CONTENT_VERSION == "batch-a-r1.2026-10-17.v1"
        assert new_session["model_config_id"] == "development-parser.v2"
        current_content = restarted.get("/api/content").json()
        assert current_content["contentVersion"] == CONTENT_VERSION
        assert current_content["expressions"][0]["hanzi"] == "我要两份小笼馒头"
    # Reads and cached retries did not rewrite the historical content fields.
    with app.state.database.transaction() as connection:
        saved = json.loads(connection.execute("SELECT data FROM attempts WHERE id=?", (completed["id"],)).fetchone()["data"])
        assert "content_version" not in saved
        assert saved["status"] == "completed"


def test_r1_missing_legacy_content_never_falls_back_to_current(app, client, monkeypatch):
    from pathlib import Path
    from app.rules import LEGACY_CONTENT_VERSION
    mark_session_as_legacy(app, client.get("/api/session").json()["id"])
    exists = Path.exists
    monkeypatch.setattr(Path, "exists", lambda path: False if path.name == f"{LEGACY_CONTENT_VERSION}.json" else exists(path))
    response = client.get("/api/content")
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "content_version_unavailable"
    assert client.get("/api/session").json()["content_version"] == LEGACY_CONTENT_VERSION


def test_r1_prepared_legacy_confirmation_recovers_once_without_reinterpretation(app, client):
    from app.rules import LEGACY_CONTENT_VERSION
    attempt = order(client, start(client))
    body = {"request_id": str(uuid4()), "expected_revision": attempt["revision"], "channel": "buttons", "action": {"type": "confirm"}, "summary_revision": attempt["summary_revision"]}
    def fail_save():
        raise sqlite3.OperationalError("simulated save interruption")
    app.state.before_commit = fail_save
    path = f"/api/attempts/{attempt['id']}/turns"
    assert client.post(path, json=body).status_code == 503
    mark_session_as_legacy(app, client.get("/api/session").json()["id"])
    def must_not_interpret(*_):
        pytest.fail("A prepared request must not be interpreted again")
    with TestClient(create_app(app.state.database.path, interpreter=must_not_interpret)) as restarted:
        restarted.cookies.update(client.cookies)
        result = restarted.post(path, json=body)
        assert result.status_code == 200
        assert result.json()["attempt"]["status"] == "completed"
        assert result.json()["attempt"]["content_version"] == LEGACY_CONTENT_VERSION
        assert restarted.post(path, json=body).json() == result.json()
        assert sum(e["event_type"] == "task_completed" for e in restarted.get("/api/events").json()) == 1


def test_r1_buttons_follow_one_question_at_a_time_and_require_later_confirmation(client):
    attempt = start(client)
    assert attempt["prompt_id"] == "NX-N01"
    attempt = submit(client, attempt, {"type": "set_order", "item": "xiaolongbao"})
    assert attempt["prompt_id"] == "NX-N02"
    assert attempt["order"]["quantity"] is None
    assert attempt["order"]["takeaway"] is None
    attempt = submit(client, attempt, {"type": "set_order", "quantity": 2, "unit": "serving"})
    assert attempt["prompt_id"] == "NX-N03"
    attempt = submit(client, attempt, {"type": "set_order", "takeaway": True})
    assert attempt["prompt_id"] == "NX-N09"
    assert attempt["status"] == "confirming"
    assert attempt["confirmed_revision"] is None
    assert confirm(client, attempt)["status"] == "completed"


@pytest.mark.parametrize("phrase,field,expected", [
    ("我要两份小笼馒头", "item", "xiaolongbao"),
    ("勿要小笼馒头", "item", None),
    ("覅打包", "takeaway", False),
    ("覅 打包", "takeaway", False),
    ("勿打包", "takeaway", False),
    ("勿 打包", "takeaway", False),
    ("勿 要 打包", "takeaway", False),
    ("勿堂吃，要打包", "takeaway", True),
])
def test_r1_development_aliases_preserve_evidence_and_negation(client, phrase, field, expected):
    attempt = order(client, start(client))
    changed = submit(client, attempt, text=phrase)
    if expected is None or type(expected) is bool:
        assert changed["order"][field] is expected
    else:
        assert changed["order"][field] == expected
    assert changed["turns"][-1]["text"] == phrase
    assert changed["turns"][-1]["interpretation"]["evidence"][field] == phrase
    assert changed["turns"][-1]["interpretation"]["model_config_id"] == "development-parser.v2"
    if expected is None or expected is False:
        assert changed["status"] == "collecting"
        assert changed["summary_revision"] is None


def test_r1_repeat_plus_correction_cannot_leave_old_summary_confirmable(client):
    attempt = order(client, start(client))
    changed = submit(client, attempt, text="请侬再讲一遍，改成三份")
    assert changed["order"]["quantity"] == 3
    assert changed["status"] == "collecting"
    assert changed["summary_revision"] is None
    assert changed["turns"][-1]["interpretation"]["help_requested"] is True


@pytest.mark.parametrize("phrase", ["我要两份小笼馒头，覅 打包", "我要两份小笼馒头，勿 打包", "two servings xiaolongbao not  takeaway"])
def test_r1_asr_spacing_does_not_turn_negation_into_takeaway(client, phrase):
    attempt = submit(client, start(client), text=phrase)
    assert attempt["order"]["takeaway"] is False
    assert attempt["status"] == "collecting"
    assert attempt["turns"][-1]["text"] == phrase
    assert submit(client, attempt, {"type": "confirm"})["status"] != "completed"


def test_r1_negating_dine_in_does_not_negate_item_in_next_clause(client):
    attempt = submit(client, start(client), text="勿 堂吃，我要两份小笼馒头打包")
    assert attempt["order"]["item"] == "xiaolongbao"
    assert attempt["order"]["takeaway"] is True
    assert attempt["status"] == "confirming"


def test_r1_voice_alias_can_fill_multiple_fields_and_legacy_voice_edited_remains_readable(app, client, monkeypatch):
    from app.providers import ASRResult, QwenASR
    from app.rules import LEGACY_CONTENT_VERSION
    transcript = "我要两份小笼馒头，打包带走，对个"
    async def transcribe(_self, _request):
        return ASRResult(transcript, "ok", 5, "mock-only", "upstream-r1", "test-only")
    monkeypatch.setattr(QwenASR, "transcribe", transcribe)
    asr_id = str(uuid4())
    assert client.post("/api/asr", content=b"test-fixture", headers={"content-type": "audio/wav", "x-request-id": asr_id}).status_code == 200
    attempt = start(client)
    body = {"request_id": str(uuid4()), "expected_revision": 0, "channel": "voice", "text": transcript, "asr_request_id": asr_id}
    path = f"/api/attempts/{attempt['id']}/turns"
    updated = client.post(path, json=body).json()["attempt"]
    assert updated["order"] == {"item": "xiaolongbao", "quantity": 2, "unit": "serving", "normalized_servings": 2, "takeaway": True}
    assert updated["status"] == "confirming"  # The same utterance's 对个 cannot confirm its newly shown summary.
    edited_text = "我要三份小笼馒头，打包带走"
    edited_body = {**body, "request_id": str(uuid4()), "expected_revision": updated["revision"], "channel": "voice_edited", "text": edited_text}
    edited = client.post(path, json=edited_body).json()["attempt"]
    assert edited["status"] == "collecting"
    mark_session_as_legacy(app, client.get("/api/session").json()["id"])
    read = client.get(f"/api/attempts/{attempt['id']}").json()
    assert read["content_version"] == LEGACY_CONTENT_VERSION
    assert read["turns"][-1]["channel"] == "voice_edited"
    assert read["turns"][-1]["text"] == edited_text
    assert read["turns"][-1]["asr_transcript"] == transcript
    assert client.get(path + "/" + edited_body["request_id"]).json()["attempt"]["turns"][-1]["asr_transcript"] == transcript
