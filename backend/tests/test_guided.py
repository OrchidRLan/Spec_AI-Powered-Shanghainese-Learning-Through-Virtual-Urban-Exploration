"""R3 real API/state transactions with synthetic stored ASR evidence; no paid calls."""
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4
import json
import sqlite3

import pytest
from fastapi.testclient import TestClient

from app.main import create_app, now
from app.storage import encode


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(str(tmp_path / "guided.db"))) as browser:
        browser.get("/api/session")
        yield browser


def start(client):
    result = client.post("/api/attempts", json={"station_id": "nanxiang"})
    assert result.status_code == 200, result.text
    return result.json()


def send(client, attempt, operation, **extra):
    body = {"request_id": str(uuid4()), "expected_revision": attempt["revision"], "operation": operation, **extra}
    response = client.post(f"/api/attempts/{attempt['id']}/practice", json=body)
    assert response.status_code == 200, response.text
    return response.json()["attempt"]


def select(client, attempt, **fields):
    return send(client, attempt, "select", action={"type": "set_order", **fields})


def save_asr(client, transcript=None, error=None):
    sid, request_id = client.get("/api/session").json()["id"], str(uuid4())
    result = {"error": {"code": error}} if error else {"transcript": transcript}
    with client.app.state.database.transaction() as connection:
        connection.execute("INSERT INTO asr_requests VALUES (?,?,?,?,?)", (sid, request_id, "mock-only", encode(result), now()))
    return request_id


def evaluate(client, attempt, transcript):
    return send(client, attempt, "evaluate", text=transcript, asr_request_id=save_asr(client, transcript))


def advance(client, attempt, assisted=False):
    result = attempt["practice"]["result"]
    return send(client, attempt, "continue", assisted=assisted,
                **({"result_request_id": result["request_id"]} if result else {}))


def quantity_question(client):
    attempt = select(client, start(client), item="xiaolongbao")
    return advance(client, evaluate(client, attempt, "小笼馒头"))


def confirmation(client, quantity=2, takeaway=True):
    attempt = select(client, quantity_question(client), quantity=quantity, unit="serving")
    attempt = advance(client, evaluate(client, attempt, f"{quantity}份"))
    attempt = select(client, attempt, takeaway=takeaway)
    return advance(client, evaluate(client, attempt, "打包带走" if takeaway else "堂吃"))


def test_new_default_versions_and_legacy_turn_bypass_rejected(client):
    session = client.get("/api/session").json()
    assert session["content_version"] == "batch-a-r3.2026-10-17.v1"
    assert client.get("/api/content").json()["contentVersion"] == session["content_version"]
    attempt = start(client)
    assert attempt["rule_version"] == "nanxiang-rules.v3"
    response = client.post(f"/api/attempts/{attempt['id']}/turns", json={"request_id": str(uuid4()), "expected_revision": 0, "channel": "buttons", "action": {"type": "set_order", "item": "xiaolongbao"}})
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "guided_practice_required"


def test_result_waits_without_changing_order_prompt_or_summary_and_survives_restart(client):
    attempt = select(client, start(client), item="xiaolongbao")
    assessed = evaluate(client, attempt, "我要两份小笼馒头外带")
    assert assessed["practice"]["result"]["status"] == "correct"
    assert assessed["order"] == attempt["order"]
    assert assessed["prompt_id"] == attempt["prompt_id"] == "NX-N01"
    assert assessed["summary_revision"] is None
    assert assessed["practice"]["step_id"] == attempt["practice"]["step_id"]
    with TestClient(create_app(client.app.state.database.path)) as reopened:
        reopened.cookies.update(client.cookies)
        recovered = reopened.get(f"/api/attempts/{attempt['id']}").json()
        assert recovered == assessed
        advanced = advance(reopened, recovered)
    assert advanced["order"]["item"] == "xiaolongbao"
    assert advanced["order"]["quantity"] is None
    assert advanced["order"]["takeaway"] is None
    assert advanced["prompt_id"] == "NX-N02"


@pytest.mark.parametrize("text,status,reason", [
    ("两份", "correct", "target_matched"), ("我要两份", "correct", "target_matched"),
    ("两", "correct", "target_matched"), ("two", "correct", "target_matched"),
    ("两分。", "correct", "target_matched"), ("我要两分小笼馒头", "correct", "target_matched"),
    ("seven.", "incorrect", "quantity_mismatch"), ("七份", "incorrect", "quantity_mismatch"),
    ("不要两份", "incorrect", "ambiguous_expression"), ("两份还是七份", "incorrect", "ambiguous_expression"),
    ("我不是要两份", "incorrect", "ambiguous_expression"), ("不要给我两份", "incorrect", "ambiguous_expression"),
    ("两份，不要", "incorrect", "ambiguous_expression"), ("两份，不，三", "incorrect", "ambiguous_expression"),
    ("两份，不，七", "incorrect", "ambiguous_expression"), ("我想要两分钟", "incorrect", "unit_mismatch"),
    ("两只", "incorrect", "unit_mismatch"), ("两笼", "incorrect", "unit_mismatch"),
    ("两个", "incorrect", "unit_mismatch"), ("二分之一", "incorrect", "unit_mismatch"),
    ("banana", "incorrect", "not_understood"), ("", "unrecognized", "no_speech"),
])
def test_quantity_tolerance_preserves_original_and_never_opens_followup(client, text, status, reason):
    attempt = select(client, quantity_question(client), quantity=2, unit="serving")
    assessed = evaluate(client, attempt, text)
    feedback = assessed["practice"]["result"]
    assert (feedback["status"], feedback["reason"]) == (status, reason)
    assert feedback["transcript"] == text
    assert assessed["order"] == attempt["order"]
    assert assessed["prompt_id"] == "NX-N02"
    assert assessed["unresolved_issues"] == []
    assert assessed["practice"]["can_choose"] == (status != "correct")


def test_failed_result_cannot_advance_unassisted_or_write_conflicting_quantity(client):
    attempt = select(client, quantity_question(client), quantity=2, unit="serving")
    failed = evaluate(client, attempt, "七份")
    body = {"request_id": str(uuid4()), "expected_revision": failed["revision"], "operation": "continue", "result_request_id": failed["practice"]["result"]["request_id"]}
    path = f"/api/attempts/{attempt['id']}/practice"
    assert client.post(path, json=body).json()["detail"]["code"] == "practice_result_required"
    advanced = advance(client, failed, assisted=True)
    assert advanced["order"]["quantity"] == 2
    assert advanced["practice"]["step"] == "mode"
    assert advanced["practice"]["can_choose"] is False
    assert advanced["metrics"]["help_used"] == 1
    events = client.get("/api/events").json()
    assert len([e for e in events if e["event_type"] == "practice_assisted_continue"]) == 1


def test_change_target_invalidates_old_correct_result_and_retains_prior_failure_unlock(client):
    attempt = select(client, quantity_question(client), quantity=2, unit="serving")
    correct = evaluate(client, attempt, "两份")
    old_result = correct["practice"]["result"]["request_id"]
    changed = select(client, correct, quantity=3, unit="serving")
    assert changed["practice"]["result"] is None
    response = client.post(f"/api/attempts/{attempt['id']}/practice", json={"request_id": str(uuid4()), "expected_revision": changed["revision"], "operation": "continue", "result_request_id": old_result})
    assert response.json()["detail"]["code"] == "stale_practice_result"
    failed = evaluate(client, changed, "七份")
    reselected = select(client, failed, quantity=1, unit="serving")
    assert reselected["practice"]["can_choose"] is True
    assert reselected["practice"]["step_id"] == attempt["practice"]["step_id"]
    assert advance(client, reselected, assisted=True)["order"]["quantity"] == 1


def test_initial_assisted_continue_is_locked(client):
    attempt = select(client, start(client), item="xiaolongbao")
    response = client.post(f"/api/attempts/{attempt['id']}/practice", json={"request_id": str(uuid4()), "expected_revision": attempt["revision"], "operation": "continue", "assisted": True})
    assert response.json()["detail"]["code"] == "practice_speak_required"


@pytest.mark.parametrize("failure,error,status,reported", [("technical", None, "technical", "client"), ("recognition", None, "unrecognized", "client"), ("recognition", "no_speech", "unrecognized", "server"), ("technical", "service_disabled", "technical", "server")])
def test_failure_empty_state_persisted_and_allows_assistance(client, failure, error, status, reported):
    attempt = select(client, start(client), item="xiaolongbao")
    assessed = send(client, attempt, "evaluate", failure_kind=failure, **({"asr_request_id": save_asr(client, error=error)} if error else {}))
    result = assessed["practice"]["result"]
    assert (result["status"], result["reported_by"], result["transcript"]) == (status, reported, None)
    assert client.get(f"/api/attempts/{attempt['id']}").json()["practice"] == assessed["practice"]
    assert advance(client, assessed, assisted=True)["prompt_id"] == "NX-N02"


def test_final_confirmation_waits_and_only_explicit_continue_completes(client):
    attempt = confirmation(client, quantity=1, takeaway=False)
    summary = attempt["summary_revision"]
    assessed = evaluate(client, attempt, "对个")
    assert assessed["status"] == "confirming"
    assert assessed["summary_revision"] == summary
    assert assessed["confirmed_revision"] is None
    assert client.get("/api/session").json()["completed_station_ids"] == []
    completed = advance(client, assessed)
    assert completed["status"] == "completed" and completed["prompt_id"] == "NX-N10"
    assert completed["confirmed_revision"] == summary
    assert client.get("/api/session").json()["completed_station_ids"] == ["nanxiang"]


def test_edit_uses_quantity_context_and_cannot_confirm_old_summary(client):
    attempt = confirmation(client)
    old_summary = attempt["summary_revision"]
    edited = send(client, attempt, "edit", step="quantity")
    assert edited["prompt_id"] == "NX-N02" and edited["summary_revision"] is None
    assert edited["practice"]["can_choose"] is False
    selected = select(client, edited, quantity=3, unit="serving")
    assessed = evaluate(client, selected, "三")
    assert assessed["practice"]["result"]["status"] == "correct"
    assert assessed["order"]["quantity"] == 2
    revised = advance(client, assessed)
    assert revised["prompt_id"] == "NX-N09" and revised["order"]["quantity"] == 3
    assert revised["summary_revision"] != old_summary
    assert revised["practice"]["step_id"] != attempt["practice"]["step_id"]


def test_idempotent_continue_conflict_stale_revision_and_cancel_tombstone(client):
    attempt = evaluate(client, select(client, start(client), item="xiaolongbao"), "小笼")
    body = {"request_id": str(uuid4()), "expected_revision": attempt["revision"], "operation": "continue", "result_request_id": attempt["practice"]["result"]["request_id"]}
    path = f"/api/attempts/{attempt['id']}/practice"
    with ThreadPoolExecutor(max_workers=2) as executor:
        first, second = list(executor.map(lambda _: client.post(path, json=body), range(2)))
    assert first.status_code == second.status_code == 200
    assert first.json() == second.json()
    assert client.get(path + "/" + body["request_id"]).json() == first.json()
    assert client.post(path, json={**body, "assisted": True}).json()["detail"]["code"] == "idempotency_conflict"
    assert client.post(path, json={**body, "request_id": str(uuid4())}).json()["detail"]["code"] == "stale_revision"
    current = first.json()["attempt"]
    late = {"request_id": str(uuid4()), "expected_revision": current["revision"], "operation": "select", "action": {"type": "set_order", "quantity": 2, "unit": "serving"}}
    cancelled = client.post(path + "/" + late["request_id"] + "/cancel", json={"expected_revision": current["revision"]})
    assert cancelled.json()["status"] == "cancelled"
    assert client.post(path, json=late).json()["status"] == "cancelled"
    assert client.get(f"/api/attempts/{attempt['id']}").json()["revision"] == current["revision"]


def test_failed_atomic_save_cannot_advance_and_original_retry_recovers(client):
    attempt = evaluate(client, select(client, start(client), item="xiaolongbao"), "小笼")
    path = f"/api/attempts/{attempt['id']}/practice"
    body = {"request_id": str(uuid4()), "expected_revision": attempt["revision"], "operation": "continue", "result_request_id": attempt["practice"]["result"]["request_id"]}
    def fail():
        raise sqlite3.OperationalError("simulated save failure")
    client.app.state.before_commit = fail
    assert client.post(path, json=body).status_code == 503
    assert client.get(f"/api/attempts/{attempt['id']}").json() == attempt
    assert client.get(path + "/" + body["request_id"]).status_code == 404
    client.app.state.before_commit = None
    assert client.post(path, json=body).json()["attempt"]["prompt_id"] == "NX-N02"


def test_asr_original_and_session_ownership_enforced(client):
    attempt = select(client, start(client), item="xiaolongbao")
    asr_id = save_asr(client, "七份")
    path = f"/api/attempts/{attempt['id']}/practice"
    body = {"request_id": str(uuid4()), "expected_revision": attempt["revision"], "operation": "evaluate", "asr_request_id": asr_id, "text": "小笼"}
    assert client.post(path, json=body).json()["detail"]["code"] == "original_transcript_required"
    with TestClient(client.app) as other:
        other.get("/api/session")
        assert other.get(f"/api/attempts/{attempt['id']}").status_code == 404
        theirs = select(other, start(other), item="xiaolongbao")
        assert other.post(f"/api/attempts/{theirs['id']}/practice", json={**body, "expected_revision": theirs["revision"]}).json()["detail"]["code"] == "asr_result_required"


def test_invalid_target_no_prepayment_or_multiple_field_skip(client):
    attempt = start(client)
    path = f"/api/attempts/{attempt['id']}/practice"
    response = client.post(path, json={"request_id": str(uuid4()), "expected_revision": 0, "operation": "select", "action": {"type": "set_order", "item": "xiaolongbao", "quantity": 2, "unit": "serving"}})
    assert response.json()["detail"]["code"] == "invalid_practice_target"
    assert client.get(f"/api/attempts/{attempt['id']}").json() == attempt


@pytest.mark.parametrize("step,target,text", [
    ("item", {"item": "xiaolongbao"}, "别给我小笼"),
    ("item", {"item": "xiaolongbao"}, "小笼，不要"),
    ("item", {"item": "xiaolongbao"}, "小笼还是面条"),
    ("item", {"item": "xiaolongbao"}, "soup dumplings or noodles"),
    ("mode", {"takeaway": True}, "别打包"),
    ("mode", {"takeaway": True}, "不要给我打包"),
    ("mode", {"takeaway": True}, "打包，不要"),
    ("mode", {"takeaway": True}, "堂吃"),
    ("mode", {"takeaway": False}, "打包"),
    ("mode", {"takeaway": True}, "堂吃还是打包"),
])
def test_negation_and_opposite_mode_never_pass_or_advance(client, step, target, text):
    attempt = start(client) if step == "item" else send(client, confirmation(client), "edit", step="mode")
    attempt = select(client, attempt, **target)
    evaluated = evaluate(client, attempt, text)
    assert evaluated["practice"]["result"]["status"] == "incorrect"
    assert evaluated["order"] == attempt["order"]
    assert evaluated["prompt_id"] in ("NX-N01", "NX-N03")


def test_asr_consumed_once_across_questions_and_attempts_but_same_request_id_recovers(client):
    attempt = select(client, start(client), item="xiaolongbao")
    asr_id = save_asr(client, "小笼两份")
    body = {"request_id": str(uuid4()), "expected_revision": attempt["revision"], "operation": "evaluate", "text": "小笼两份", "asr_request_id": asr_id}
    path = f"/api/attempts/{attempt['id']}/practice"
    result = client.post(path, json=body)
    assert result.status_code == 200
    assert client.post(path, json=body).json() == result.json()
    evaluated = result.json()["attempt"]
    repeated = client.post(path, json={**body, "request_id": str(uuid4()), "expected_revision": evaluated["revision"]})
    assert repeated.json()["detail"]["code"] == "asr_result_already_used"
    quantity = select(client, advance(client, evaluated), quantity=2, unit="serving")
    reused = client.post(path, json={**body, "request_id": str(uuid4()), "expected_revision": quantity["revision"]})
    assert reused.json()["detail"]["code"] == "asr_result_already_used"
    client.post(f"/api/attempts/{attempt['id']}/skip", json={"expected_revision": quantity["revision"]})
    fresh = select(client, start(client), item="xiaolongbao")
    assert client.post(f"/api/attempts/{fresh['id']}/practice", json={**body, "request_id": str(uuid4()), "expected_revision": fresh["revision"]}).json()["detail"]["code"] == "asr_result_already_used"


def test_cancelled_evaluation_cannot_arrive_late_or_change_fallback(client):
    attempt = select(client, start(client), item="xiaolongbao")
    path = f"/api/attempts/{attempt['id']}/practice"
    body = {"request_id": str(uuid4()), "expected_revision": attempt["revision"], "operation": "evaluate", "text": "banana", "asr_request_id": save_asr(client, "banana")}
    assert client.post(path + "/" + body["request_id"] + "/cancel", json={"expected_revision": attempt["revision"]}).status_code == 200
    cancelled = client.post(path, json=body).json()
    assert cancelled["status"] == "cancelled"
    assert cancelled["attempt"] == attempt
    assert cancelled["attempt"]["practice"]["can_choose"] is False


def test_guided_evaluation_never_calls_configured_text_interpreter(client):
    def forbidden(*_args):
        raise AssertionError("R3 must not call a free-dialogue model")
    client.app.state.interpreter = forbidden
    attempt = select(client, start(client), item="xiaolongbao")
    assert evaluate(client, attempt, "小笼")["practice"]["result"]["status"] == "correct"


@pytest.mark.parametrize("quantity,valid", [(1, True), (20, True), (0, False), (21, False)])
def test_quantity_target_range(client, quantity, valid):
    attempt = quantity_question(client)
    response = client.post(f"/api/attempts/{attempt['id']}/practice", json={"request_id": str(uuid4()), "expected_revision": attempt["revision"], "operation": "select", "action": {"type": "set_order", "quantity": quantity, "unit": "serving"}})
    assert (response.status_code == 200) is valid


def test_final_assisted_confirmation_is_explicit_and_audited(client):
    attempt = confirmation(client)
    failed = evaluate(client, attempt, "不要")
    assert failed["status"] == "confirming"
    assert client.get("/api/session").json()["completed_station_ids"] == []
    completed = advance(client, failed, assisted=True)
    assert completed["status"] == "completed"
    events = client.get("/api/events").json()
    final = [event for event in events if event["event_type"] == "task_completed"]
    assert len(final) == 1 and final[0]["metadata"]["assisted"] is True
    assert final[0]["metadata"]["result"]["status"] == "incorrect"


@pytest.mark.parametrize("asr_state", ["missing", "pending", "succeeded"])
def test_browser_asr_timeout_reconciles_success_or_persists_true_technical_empty_state(client, asr_state):
    attempt = select(client, start(client), item="xiaolongbao")
    asr_id = save_asr(client, "小笼") if asr_state == "succeeded" else str(uuid4())
    if asr_state == "pending":
        sid = client.get("/api/session").json()["id"]
        with client.app.state.database.transaction() as connection:
            connection.execute("INSERT INTO asr_requests VALUES (?,?,?,?,?)", (sid, asr_id, "mock-pending", None, now()))
    evaluated = send(client, attempt, "evaluate", failure_kind="technical", asr_request_id=asr_id)
    result = evaluated["practice"]["result"]
    if asr_state == "succeeded":
        assert result["status"] == "correct" and result["transcript"] == "小笼"
        assert result["reported_by"] == "server"
    else:
        assert result["status"] == "technical" and result["transcript"] is None
        assert result["reported_by"] == "client"
        assert evaluated["practice"]["can_choose"] is True
        # A late provider result cannot be repackaged as a new evaluation.
        if asr_state == "pending":
            with client.app.state.database.transaction() as connection:
                connection.execute("UPDATE asr_requests SET response=? WHERE request_id=?", (encode({"transcript": "小笼"}), asr_id))
            response = client.post(f"/api/attempts/{attempt['id']}/practice", json={"request_id": str(uuid4()), "expected_revision": evaluated["revision"], "operation": "evaluate", "text": "小笼", "asr_request_id": asr_id})
            assert response.json()["detail"]["code"] == "asr_result_already_used"
    assert evaluated["order"] == attempt["order"]
    assert client.get(f"/api/attempts/{attempt['id']}").json()["practice"]["result"] == result
