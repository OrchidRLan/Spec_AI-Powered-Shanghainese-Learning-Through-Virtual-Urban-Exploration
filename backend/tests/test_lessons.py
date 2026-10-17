"""B/C fixed lessons: transactional API tests with synthetic ASR evidence only.

All sessions and audio-playback fixtures use isolated temporary databases. These
tests do not contact speech services, access a microphone, or open user data.
"""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from uuid import uuid4
import hashlib
import json
import sqlite3

import pytest
from fastapi.testclient import TestClient

from app.main import create_app, now
from app.lessons import assess, new_attempt
from app.storage import encode


STATIONS = ("restaurant", "candy", "teahouse")
FLAVOR_TEXT = {"rose": "玫瑰味", "osmanthus": "桂花味", "mint": "薄荷味"}


def teaching_options():
    content = json.loads((Path(__file__).resolve().parents[2] / "content" / "batch-bc.json").read_text())
    entries = {entry["id"]: entry for entry in content["entries"]}
    return [pytest.param(station["id"], step["id"], option["id"], entries[option["entryId"]]["hanzi"],
                         id=f"{station['id']}-{step['id']}-{option['id']}")
            for station in content["stationPlans"] for step in station["steps"] for option in step["options"]]


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(str(tmp_path / "lessons.db"))) as browser:
        browser.get("/api/session")
        yield browser


def start(client, station="restaurant", restart=False):
    response = client.post("/api/attempts", json={"station_id": station, "restart": restart})
    assert response.status_code == 200, response.text
    return response.json()


def path(attempt):
    return f"/api/attempts/{attempt['id']}/lesson"


def payload(attempt, operation, **extra):
    return {"request_id": str(uuid4()), "expected_revision": attempt["revision"], "operation": operation, **extra}


def send(client, attempt, operation, **extra):
    response = client.post(path(attempt), json=payload(attempt, operation, **extra))
    assert response.status_code == 200, response.text
    return response.json()["attempt"]


def select(client, attempt, option):
    return send(client, attempt, "select", option_id=option)


def save_asr(client, transcript=None, error=None):
    sid, request_id = client.get("/api/session").json()["id"], str(uuid4())
    response = {"error": {"code": error}} if error else {"transcript": transcript}
    with client.app.state.database.transaction() as connection:
        connection.execute("INSERT INTO asr_requests VALUES (?,?,?,?,?)", (sid, request_id, "synthetic-test-only", encode(response), now()))
    return request_id


def evaluate(client, attempt, text):
    return send(client, attempt, "evaluate", text=text, asr_request_id=save_asr(client, text))


def advance(client, attempt, assisted=False):
    result = attempt["lesson"]["result"]
    return send(client, attempt, "continue", assisted=assisted,
                **({"result_request_id": result["request_id"]} if result else {}))


def answer(client, attempt, option, text):
    selected = select(client, attempt, option)
    assessed = evaluate(client, selected, text)
    assert assessed["lesson"]["result"]["status"] == "correct", assessed["lesson"]["result"]
    assert assessed["lesson"]["step"] == attempt["lesson"]["step"]
    assert assessed["lesson"]["answers"] == attempt["lesson"]["answers"]
    return advance(client, assessed)


def internal_attempt(client, attempt, **changes):
    """Inspect or seed server-only state strictly inside this test's database."""
    with client.app.state.database.transaction() as connection:
        row = connection.execute("SELECT data FROM attempts WHERE id=?", (attempt["id"],)).fetchone()
        stored = json.loads(row["data"])
        if changes:
            stored.update(changes)
            client.app.state.database.save_attempt(connection, stored)
    return stored


def change_test_session_versions(client, **changes):
    sid = client.get("/api/session").json()["id"]
    with client.app.state.database.transaction() as connection:
        stored = json.loads(connection.execute("SELECT data FROM sessions WHERE id=?", (sid,)).fetchone()["data"])
        stored.update(changes)
        connection.execute("UPDATE sessions SET data=? WHERE id=?", (encode(stored), sid))


def restaurant_dish(client):
    attempt = answer(client, start(client), "not_spicy", "我不吃辣")
    assert attempt["prompt_id"] == "BC-OLD-ASK-RECOMMENDATION"
    attempt = answer(client, attempt, "recommend", "有什么推荐")
    assert attempt["prompt_id"] == "BC-OLD-ASK-DISH"
    return attempt


def restaurant_confirmation(client, dish="fish"):
    return answer(client, restaurant_dish(client), dish, "清蒸鱼" if dish == "fish" else "白斩鸡")


def candy_quantity(client, flavor=None):
    attempt = start(client, "candy")
    if flavor is not None:
        internal_attempt(client, attempt, _lesson_target=flavor)
    target = internal_attempt(client, attempt)["_lesson_target"]
    attempt = send(client, attempt, "help")
    attempt = answer(client, attempt, target, FLAVOR_TEXT[target])
    assert attempt["prompt_id"] == "BC-CND-ASK-QUANTITY"
    return attempt


def candy_confirmation(client, flavor=None):
    return answer(client, candy_quantity(client, flavor), "two_packs", "两包")


def tea_thanks(client):
    attempt = answer(client, start(client, "teahouse"), "good_tea", "这茶很好喝")
    assert attempt["prompt_id"] == "BC-TEA-RESPONSE"
    return attempt


@pytest.mark.parametrize("station,step", [("restaurant", "preference"), ("candy", "flavor"), ("teahouse", "appreciation")])
def test_new_station_version_empty_state_and_no_legacy_bypass(client, station, step):
    attempt = start(client, station)
    assert attempt["content_version"] == "batch-bc.2026-10-17.v1"
    assert attempt["rule_version"] == "station-lessons.v1"
    assert attempt["prompt_id"] == {"restaurant": "BC-OLD-ASK-PREFERENCE", "candy": "BC-CND-ASK-FLAVOR",
                                     "teahouse": "BC-TEA-ASK-APPRECIATION"}[station]
    lesson = attempt["lesson"]
    assert lesson["step"] == step
    assert lesson["target"] is None and lesson["result"] is None
    assert lesson["answers"] == {} and lesson["history"] == []
    assert lesson["can_choose"] is False
    assert "_lesson_target" not in attempt and "_introduction_served" not in attempt
    legacy = client.post(f"/api/attempts/{attempt['id']}/turns", json={
        "request_id": str(uuid4()), "expected_revision": 0, "channel": "buttons",
        "action": {"type": "set_order", "item": "xiaolongbao"},
    })
    assert legacy.status_code == 409
    assert client.get(f"/api/attempts/{attempt['id']}").json() == attempt


@pytest.mark.parametrize("content_version,rule_version", [
    ("batch-a-r1.2026-10-17.v1", "nanxiang-rules.v1"),
    ("batch-a-r2.2026-10-17.v1", "nanxiang-rules.v2"),
])
def test_legacy_sessions_cannot_silently_start_new_station_lessons(client, content_version, rule_version):
    change_test_session_versions(client, content_version=content_version, rule_version=rule_version)
    before = client.get("/api/session").json()
    before_events = client.get("/api/events").json()
    for station in STATIONS:
        response = client.post("/api/attempts", json={"station_id": station})
        assert response.status_code == 409
        assert response.json()["detail"]["code"] == "lesson_version_required"
    assert client.get("/api/session").json() == before
    assert client.get("/api/events").json() == before_events
    previous_flow = start(client, "nanxiang")
    assert previous_flow["content_version"] == content_version
    assert previous_flow["rule_version"] == rule_version
    assert "lesson" not in previous_flow


@pytest.mark.parametrize("version_field", ["lesson_content_version", "lesson_rule_version"])
def test_bound_lesson_extension_version_mismatch_is_not_overwritten(client, version_field):
    change_test_session_versions(client, **{version_field: "prior-extension-version"})
    before = client.get("/api/session").json()
    before_events = client.get("/api/events").json()
    response = client.post("/api/attempts", json={"station_id": "restaurant"})
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "lesson_version_required"
    assert client.get("/api/session").json() == before
    assert client.get("/api/events").json() == before_events


@pytest.mark.parametrize("dish", ["fish", "chicken"])
def test_restaurant_four_fixed_questions_and_explicit_confirmation(client, dish):
    attempt = restaurant_confirmation(client, dish)
    assert attempt["lesson"]["step"] == "confirm"
    assert attempt["lesson"]["target"] == "confirm"
    assert attempt["lesson"]["answers"] == {"preference": "not_spicy", "recommendation": "recommend", "dish": dish}
    assert attempt["prompt_id"] == f"BC-OLD-CONFIRM-{dish.upper()}"
    assessed = evaluate(client, attempt, "对个")
    assert assessed["prompt_id"] == attempt["prompt_id"]
    assert assessed["lesson"]["result"]["status"] == "correct"
    assert assessed["status"] != "completed"
    assert client.get("/api/session").json()["completed_station_ids"] == []
    completed = advance(client, assessed)
    assert completed["status"] == "completed"
    assert completed["prompt_id"] == "BC-OLD-COMPLETE"
    assert client.get("/api/session").json()["completed_station_ids"] == ["restaurant"]


def test_candy_target_is_private_stable_and_help_reveals_only_on_request(client):
    attempt = start(client, "candy")
    target = internal_attempt(client, attempt)["_lesson_target"]
    listening = attempt["lesson"]["listening"]
    assert target in FLAVOR_TEXT
    assert listening["played"] is False and listening["text_revealed"] is False
    assert listening["introduction_text_id"] is None
    assert all(flavor not in listening["audio_url"] for flavor in FLAVOR_TEXT)
    assert start(client, "candy")["id"] == attempt["id"]
    with TestClient(create_app(client.app.state.database.path)) as reopened:
        reopened.cookies.update(client.cookies)
        assert reopened.get(f"/api/attempts/{attempt['id']}").json() == attempt
        assert internal_attempt(reopened, attempt)["_lesson_target"] == target
    helped = send(client, attempt, "help")
    assert helped["lesson"]["listening"]["introduction_text_id"] == f"BC-CND-INTRO-{target.upper()}"
    assert helped["lesson"]["listening"]["text_revealed"] is True
    assert helped["lesson"]["answers"] == {}
    assert helped["lesson"]["step"] == "flavor"
    assert "_lesson_target" not in helped


@pytest.mark.parametrize("flavor", FLAVOR_TEXT)
def test_candy_three_fixed_questions_complete_after_explicit_continue(client, flavor):
    attempt = candy_confirmation(client, flavor)
    assert attempt["lesson"]["step"] == "confirm"
    target = internal_attempt(client, attempt)["_lesson_target"]
    assert target == flavor
    assert attempt["lesson"]["answers"] == {"flavor": target, "quantity": "two_packs"}
    assert attempt["prompt_id"] == f"BC-CND-CONFIRM-{flavor.upper()}"
    assessed = evaluate(client, attempt, "对")
    assert assessed["prompt_id"] == attempt["prompt_id"]
    assert assessed["lesson"]["result"]["status"] == "correct"
    assert assessed["status"] != "completed"
    completed = advance(client, assessed)
    assert completed["status"] == "completed"
    assert completed["prompt_id"] == "BC-CND-COMPLETE"
    assert client.get("/api/session").json()["completed_station_ids"] == ["candy"]


def test_teahouse_two_questions_end_without_extra_confirmation(client):
    attempt = tea_thanks(client)
    assert attempt["lesson"]["step"] == "thanks"
    assessed = evaluate(client, select(client, attempt, "thanks"), "谢谢侬")
    assert assessed["lesson"]["result"]["status"] == "correct"
    assert assessed["status"] != "completed"
    assert assessed["lesson"]["answers"] == {"appreciation": "good_tea"}
    completed = advance(client, assessed)
    assert completed["status"] == "completed"
    assert completed["prompt_id"] == "BC-TEA-COMPLETE"
    assert completed["lesson"]["answers"] == {"appreciation": "good_tea", "thanks": "thanks"}
    assert client.get("/api/session").json()["completed_station_ids"] == ["teahouse"]


@pytest.mark.parametrize("station,option,text", [
    ("restaurant", "not_spicy", "我不吃辣"), ("teahouse", "good_tea", "这茶很好喝"),
    ("restaurant", "not_spicy", "I don’t eat spicy food"),
])
def test_result_stays_on_same_question_and_restores_exactly(client, station, option, text):
    attempt = select(client, start(client, station), option)
    assessed = evaluate(client, attempt, text)
    assert assessed["lesson"]["result"]["transcript"] == text
    assert assessed["lesson"]["step_id"] == attempt["lesson"]["step_id"]
    assert assessed["lesson"]["answers"] == {}
    assert assessed["prompt_id"] == attempt["prompt_id"]
    with TestClient(create_app(client.app.state.database.path)) as reopened:
        reopened.cookies.update(client.cookies)
        assert reopened.get(f"/api/attempts/{attempt['id']}").json() == assessed
        assert start(reopened, station) == assessed
        advanced = advance(reopened, assessed)
    assert advanced["lesson"]["step_id"] != attempt["lesson"]["step_id"]
    assert advanced["lesson"]["answers"]


@pytest.mark.parametrize("text", [
    "我吃辣", "我要辣的", "我不是不吃辣", "不吃辣还是吃辣", "spicy", "I eat spicy food",
    "我不吃不辣的菜", "不辣菜不要", "I do not want non-spicy food",
])
def test_restaurant_spicy_or_ambiguous_preference_cannot_pass(client, text):
    attempt = select(client, start(client), "not_spicy")
    assessed = evaluate(client, attempt, text)
    assert assessed["lesson"]["result"]["status"] == "incorrect"
    assert assessed["lesson"]["answers"] == {}
    assert assessed["lesson"]["step"] == "preference"
    assert assessed["lesson"]["can_choose"] is True


def test_spicy_tofu_cannot_complete_task_even_with_assistance(client):
    attempt = select(client, restaurant_dish(client), "tofu")
    assessed = evaluate(client, attempt, "辣味豆腐")
    assert assessed["lesson"]["result"]["status"] == "incorrect"
    assert assessed["lesson"]["step"] == "dish"
    refused = client.post(path(attempt), json=payload(assessed, "continue", assisted=True,
                          result_request_id=assessed["lesson"]["result"]["request_id"]))
    assert refused.status_code == 409
    assert client.get(f"/api/attempts/{attempt['id']}").json() == assessed
    corrected = select(client, assessed, "chicken")
    assert corrected["lesson"]["result"] is None
    assert corrected["lesson"]["can_choose"] is True
    assert advance(client, corrected, assisted=True)["lesson"]["answers"]["dish"] == "chicken"


def test_wrong_candy_flavor_does_not_reveal_answer_or_allow_assisted_skip(client):
    attempt = start(client, "candy")
    target = internal_attempt(client, attempt)["_lesson_target"]
    wrong = next(flavor for flavor in FLAVOR_TEXT if flavor != target)
    internal_attempt(client, attempt, _introduction_served=True)
    attempt = send(client, attempt, "listened")
    assessed = evaluate(client, select(client, attempt, wrong), FLAVOR_TEXT[wrong])
    assert assessed["lesson"]["result"]["status"] == "incorrect"
    assert assessed["lesson"]["listening"]["introduction_text_id"] is None
    assert assessed["lesson"]["answers"] == {}
    refused = client.post(path(attempt), json=payload(assessed, "continue", assisted=True,
                          result_request_id=assessed["lesson"]["result"]["request_id"]))
    assert refused.status_code == 409
    assert internal_attempt(client, attempt)["_lesson_target"] == target
    assert client.get(f"/api/attempts/{attempt['id']}").json() == assessed


def test_candy_requires_hearing_or_explicit_help_before_evaluation(client):
    attempt = start(client, "candy")
    target = internal_attempt(client, attempt)["_lesson_target"]
    selected = select(client, attempt, target)
    for extra in ({"failure_kind": "technical"}, {"text": FLAVOR_TEXT[target], "asr_request_id": save_asr(client, FLAVOR_TEXT[target])}):
        refused = client.post(path(attempt), json=payload(selected, "evaluate", **extra))
        assert refused.status_code == 409
        assert client.get(f"/api/attempts/{attempt['id']}").json() == selected
    refused = client.post(path(attempt), json=payload(selected, "listened"))
    assert refused.status_code == 409
    assert client.get(f"/api/attempts/{attempt['id']}").json()["lesson"]["listening"]["played"] is False
    helped = send(client, selected, "help")
    assert evaluate(client, helped, FLAVOR_TEXT[target])["lesson"]["result"]["status"] == "correct"


@pytest.mark.parametrize("text", [
    "茶不好喝", "这茶不怎么样", "这茶很好喝，不，其实不好喝", "风景很好", "点心很好吃", "杯子很好看",
    "The tea is not good", "The view is lovely", "这茶好喝吗", "Is this tea good?", "这茶香但难喝",
    "I dislike this tea, it smells nice", "The tea smells nice but tastes awful", "I like you",
    "我喜欢这家店", "这个店员真香", "The shopkeeper is nice",
])
def test_tea_wrong_object_negative_or_retracted_praise_never_passes(client, text):
    attempt = select(client, start(client, "teahouse"), "good_tea")
    assessed = evaluate(client, attempt, text)
    assert assessed["lesson"]["result"]["status"] == "incorrect"
    assert assessed["lesson"]["result"]["transcript"] == text
    assert assessed["lesson"]["answers"] == {}
    assert assessed["lesson"]["step"] == "appreciation"


@pytest.mark.parametrize("text", ["不要说谢谢", "我该说谢谢吗", "他刚才说谢谢", "他说谢谢", "How do I say thank you?", "Should I say thanks?", "Don't say thank you"])
def test_quoted_or_negated_thanks_does_not_complete(client, text):
    attempt = select(client, tea_thanks(client), "thanks")
    assessed = evaluate(client, attempt, text)
    assert assessed["lesson"]["result"]["status"] == "incorrect"
    assert assessed["status"] != "completed"
    assert "thanks" not in assessed["lesson"]["answers"]
    assert client.get("/api/session").json()["completed_station_ids"] == []


@pytest.mark.parametrize("text", ["十二包", "二十二包", "一百零二包", "十二包梨膏糖"])
def test_candy_large_quantity_is_not_misread_as_two_packs(client, text):
    attempt = select(client, candy_quantity(client), "two_packs")
    assessed = evaluate(client, attempt, text)
    assert assessed["lesson"]["result"]["status"] == "incorrect"
    assert assessed["lesson"]["result"]["transcript"] == text
    assert assessed["lesson"]["step"] == "quantity"
    assert "quantity" not in assessed["lesson"]["answers"]


@pytest.mark.parametrize("text", ["这杯茶真好吃", "这杯茶很好喝", "I like it", "Not bad", "This cup of tea is good", "很香，我喜欢"])
def test_tea_context_accepts_cup_of_tea_and_mild_positive_phrasing(client, text):
    attempt = select(client, start(client, "teahouse"), "good_tea")
    assessed = evaluate(client, attempt, text)
    assert assessed["lesson"]["result"]["status"] == "correct"
    assert assessed["lesson"]["result"]["transcript"] == text
    assert assessed["lesson"]["step"] == "appreciation"
    assert assessed["lesson"]["answers"] == {}


@pytest.mark.parametrize("text", ["我说推荐", "The recommendation is fish"])
def test_mentioning_recommendation_is_not_requesting_one(client, text):
    attempt = answer(client, start(client), "not_spicy", "我不吃辣")
    assessed = evaluate(client, select(client, attempt, "recommend"), text)
    assert assessed["lesson"]["result"]["status"] == "incorrect"
    assert assessed["lesson"]["step"] == "recommendation"
    assert "recommendation" not in assessed["lesson"]["answers"]


@pytest.mark.parametrize("failure,error,status,reported", [
    ("technical", None, "technical", "client"), ("recognition", None, "unrecognized", "client"),
    ("recognition", "no_speech", "unrecognized", "server"), ("technical", "service_disabled", "technical", "server"),
])
def test_failed_recognition_unlocks_assistance_without_recording_voice_success(client, failure, error, status, reported):
    attempt = select(client, start(client), "not_spicy")
    locked = client.post(path(attempt), json=payload(attempt, "continue", assisted=True))
    assert locked.status_code == 409
    assessed = send(client, attempt, "evaluate", failure_kind=failure,
                    **({"asr_request_id": save_asr(client, error=error)} if error else {}))
    result = assessed["lesson"]["result"]
    assert (result["status"], result["reported_by"], result["transcript"]) == (status, reported, None)
    assert assessed["lesson"]["can_choose"] is True
    assert assessed["lesson"]["answers"] == {}
    advanced = advance(client, assessed, assisted=True)
    assert advanced["lesson"]["step"] == "recommendation"
    assert advanced["lesson"]["can_choose"] is False
    assert advanced["metrics"]["help_used"] > 0


def test_edit_restaurant_invalidates_result_summary_and_downstream_answers(client):
    attempt = evaluate(client, restaurant_confirmation(client), "对")
    old_result = attempt["lesson"]["result"]["request_id"]
    edited = send(client, attempt, "edit", step="dish")
    assert edited["lesson"]["step"] == "dish"
    assert edited["prompt_id"] == "BC-OLD-ASK-DISH"
    assert edited["lesson"]["step_id"] != attempt["lesson"]["step_id"]
    assert edited["lesson"]["answers"] == {"preference": "not_spicy", "recommendation": "recommend"}
    assert edited["lesson"]["result"] is None and edited["lesson"]["can_choose"] is False
    refused = client.post(path(attempt), json=payload(edited, "continue", result_request_id=old_result))
    assert refused.status_code == 409
    reconfirm = answer(client, edited, "chicken", "白斩鸡")
    assert reconfirm["lesson"]["step"] == "confirm"
    assert reconfirm["lesson"]["answers"]["dish"] == "chicken"
    assert reconfirm["prompt_id"] == "BC-OLD-CONFIRM-CHICKEN"
    assert reconfirm["lesson"]["result"] is None
    earlier = send(client, reconfirm, "edit", step="preference")
    assert earlier["lesson"]["answers"] == {}
    assert earlier["lesson"]["step"] == "preference"
    assert earlier["prompt_id"] == "BC-OLD-ASK-PREFERENCE"


def test_edit_candy_preserves_private_target_and_listening_but_clears_downstream(client):
    attempt = candy_confirmation(client)
    target = internal_attempt(client, attempt)["_lesson_target"]
    edited = send(client, attempt, "edit", step="flavor")
    assert edited["lesson"]["step"] == "flavor" and edited["lesson"]["answers"] == {}
    assert edited["prompt_id"] == "BC-CND-ASK-FLAVOR"
    assert edited["lesson"]["listening"] == attempt["lesson"]["listening"]
    assert internal_attempt(client, edited)["_lesson_target"] == target
    assert edited["lesson"]["step_id"] != attempt["lesson"]["step_id"]
    assert edited["lesson"]["result"] is None


def test_changed_dish_target_cannot_reuse_previous_correct_result(client):
    attempt = evaluate(client, select(client, restaurant_dish(client), "fish"), "清蒸鱼")
    result_id = attempt["lesson"]["result"]["request_id"]
    changed = select(client, attempt, "chicken")
    assert changed["lesson"]["step_id"] == attempt["lesson"]["step_id"]
    assert changed["lesson"]["result"] is None
    assert changed["lesson"]["can_choose"] is False
    assert client.post(path(attempt), json=payload(changed, "continue", result_request_id=result_id)).status_code == 409
    assert client.get(f"/api/attempts/{attempt['id']}").json() == changed


@pytest.mark.parametrize("station", STATIONS)
def test_skipping_is_not_completion_and_late_lesson_operation_cannot_apply(client, station):
    attempt = start(client, station)
    skipped = client.post(f"/api/attempts/{attempt['id']}/skip", json={"expected_revision": attempt["revision"]})
    assert skipped.status_code == 200
    closed = client.get(f"/api/attempts/{attempt['id']}").json()
    assert closed["status"] == "skipped"
    assert client.get("/api/session").json()["completed_station_ids"] == []
    assert client.post(path(attempt), json=payload(closed, "evaluate", failure_kind="technical")).status_code == 409
    fresh = start(client, station, restart=True)
    assert fresh["id"] != attempt["id"] and fresh["lesson"]["answers"] == {}


def test_completed_station_remains_complete_when_new_practice_is_skipped(client):
    completed = answer(client, tea_thanks(client), "thanks", "谢谢")
    assert completed["status"] == "completed"
    fresh = start(client, "teahouse", restart=True)
    assert fresh["id"] != completed["id"]
    client.post(f"/api/attempts/{fresh['id']}/skip", json={"expected_revision": fresh["revision"]})
    assert client.get("/api/session").json()["completed_station_ids"] == ["teahouse"]
    assert client.get(f"/api/attempts/{completed['id']}").json() == completed


def test_simultaneous_duplicate_continue_exact_recovery_stale_revision_and_cancel(client):
    attempt = evaluate(client, select(client, start(client), "not_spicy"), "我不吃辣")
    body = payload(attempt, "continue", result_request_id=attempt["lesson"]["result"]["request_id"])
    with ThreadPoolExecutor(max_workers=2) as executor:
        responses = list(executor.map(lambda _: client.post(path(attempt), json=body), range(2)))
    assert all(response.status_code == 200 for response in responses)
    assert responses[0].json() == responses[1].json()
    assert client.get(path(attempt) + "/" + body["request_id"]).json() == responses[0].json()
    conflict = client.post(path(attempt), json={**body, "assisted": True})
    assert conflict.json()["detail"]["code"] == "idempotency_conflict"
    stale = client.post(path(attempt), json={**body, "request_id": str(uuid4())})
    assert stale.json()["detail"]["code"] == "stale_revision"
    current = responses[0].json()["attempt"]
    late = payload(current, "select", option_id="recommend")
    cancelled = client.post(path(attempt) + "/" + late["request_id"] + "/cancel", json={"expected_revision": current["revision"]})
    assert cancelled.json()["status"] == "cancelled"
    assert client.post(path(attempt), json=late).json()["status"] == "cancelled"
    assert client.get(f"/api/attempts/{attempt['id']}").json() == current


def test_failed_final_save_rolls_back_completion_events_and_idempotency_record(client):
    attempt = evaluate(client, select(client, tea_thanks(client), "thanks"), "谢谢")
    body = payload(attempt, "continue", result_request_id=attempt["lesson"]["result"]["request_id"])
    before_events = client.get("/api/events").json()

    def fail():
        raise sqlite3.OperationalError("simulated lesson save failure")

    client.app.state.before_commit = fail
    assert client.post(path(attempt), json=body).status_code == 503
    assert client.get(f"/api/attempts/{attempt['id']}").json() == attempt
    assert client.get("/api/events").json() == before_events
    assert client.get("/api/session").json()["completed_station_ids"] == []
    assert client.get(path(attempt) + "/" + body["request_id"]).status_code == 404
    client.app.state.before_commit = None
    retried = client.post(path(attempt), json=body)
    assert retried.status_code == 200
    assert retried.json()["attempt"]["status"] == "completed"
    assert len([event for event in client.get("/api/events").json() if event["event_type"] == "task_completed"]) == 1


def test_original_transcript_and_asr_session_ownership_enforced(client):
    attempt = select(client, start(client), "not_spicy")
    asr_id = save_asr(client, "我要辣的")
    body = payload(attempt, "evaluate", text="我不吃辣", asr_request_id=asr_id)
    response = client.post(path(attempt), json=body)
    assert response.json()["detail"]["code"] == "original_transcript_required"
    with TestClient(client.app) as other:
        other.get("/api/session")
        assert other.get(f"/api/attempts/{attempt['id']}").status_code == 404
        assert other.get(path(attempt) + "/" + body["request_id"]).status_code == 404
        theirs = select(other, start(other), "not_spicy")
        response = other.post(path(theirs), json={**body, "expected_revision": theirs["revision"], "text": "我要辣的"})
        assert response.json()["detail"]["code"] == "asr_result_required"
    assert client.get(f"/api/attempts/{attempt['id']}").json() == attempt


def test_asr_evidence_consumed_once_across_steps_stations_and_retry_recovery(client):
    attempt = select(client, start(client), "not_spicy")
    text = "我不吃辣，有什么推荐"
    asr_id = save_asr(client, text)
    body = payload(attempt, "evaluate", text=text, asr_request_id=asr_id)
    response = client.post(path(attempt), json=body)
    assert response.status_code == 200
    assert client.post(path(attempt), json=body).json() == response.json()
    assessed = response.json()["attempt"]
    reused = client.post(path(attempt), json={**body, "request_id": str(uuid4()), "expected_revision": assessed["revision"]})
    assert reused.json()["detail"]["code"] == "asr_result_already_used"
    next_step = select(client, advance(client, assessed), "recommend")
    reused = client.post(path(attempt), json={**body, "request_id": str(uuid4()), "expected_revision": next_step["revision"]})
    assert reused.json()["detail"]["code"] == "asr_result_already_used"
    other_station = select(client, start(client, "teahouse"), "good_tea")
    reused = client.post(path(other_station), json={**body, "request_id": str(uuid4()), "expected_revision": other_station["revision"]})
    assert reused.json()["detail"]["code"] == "asr_result_already_used"


def test_cancelled_evaluation_cannot_arrive_late_or_unlock_assistance(client):
    attempt = select(client, start(client, "teahouse"), "good_tea")
    body = payload(attempt, "evaluate", text="banana", asr_request_id=save_asr(client, "banana"))
    response = client.post(path(attempt) + "/" + body["request_id"] + "/cancel", json={"expected_revision": attempt["revision"]})
    assert response.status_code == 200
    late = client.post(path(attempt), json=body)
    assert late.json()["status"] == "cancelled"
    assert late.json()["attempt"] == attempt
    assert client.get(f"/api/attempts/{attempt['id']}").json()["lesson"]["can_choose"] is False


@pytest.mark.parametrize("asr_state", ["missing", "pending", "succeeded"])
def test_late_asr_timeout_reconciles_saved_result_or_reserves_failed_recording(client, asr_state):
    attempt = select(client, start(client, "teahouse"), "good_tea")
    asr_id = save_asr(client, "这茶很好喝") if asr_state == "succeeded" else str(uuid4())
    sid = client.get("/api/session").json()["id"]
    if asr_state == "pending":
        with client.app.state.database.transaction() as connection:
            connection.execute("INSERT INTO asr_requests VALUES (?,?,?,?,?)", (sid, asr_id, "synthetic-pending", None, now()))
    assessed = send(client, attempt, "evaluate", failure_kind="technical", asr_request_id=asr_id)
    feedback = assessed["lesson"]["result"]
    if asr_state == "succeeded":
        assert feedback["status"] == "correct" and feedback["transcript"] == "这茶很好喝"
        assert feedback["reported_by"] == "server"
    else:
        assert feedback["status"] == "technical" and feedback["transcript"] is None
        assert assessed["lesson"]["can_choose"] is True
        if asr_state == "pending":
            with client.app.state.database.transaction() as connection:
                connection.execute("UPDATE asr_requests SET response=? WHERE session_id=? AND request_id=?", (encode({"transcript": "这茶很好喝"}), sid, asr_id))
            late = client.post(path(attempt), json=payload(assessed, "evaluate", text="这茶很好喝", asr_request_id=asr_id))
            assert late.json()["detail"]["code"] == "asr_result_already_used"
    assert assessed["lesson"]["answers"] == {}
    assert assessed["lesson"]["step"] == "appreciation"
    assert client.get(f"/api/attempts/{attempt['id']}").json()["lesson"]["result"] == feedback


def test_failed_evaluation_does_not_consume_asr_and_exact_retry_can_recover(client):
    attempt = select(client, start(client), "not_spicy")
    body = payload(attempt, "evaluate", text="我不吃辣", asr_request_id=save_asr(client, "我不吃辣"))

    def fail():
        raise sqlite3.OperationalError("simulated evaluation save failure")

    client.app.state.before_commit = fail
    assert client.post(path(attempt), json=body).status_code == 503
    assert client.get(f"/api/attempts/{attempt['id']}").json() == attempt
    assert client.get(path(attempt) + "/" + body["request_id"]).status_code == 404
    client.app.state.before_commit = None
    response = client.post(path(attempt), json=body)
    assert response.status_code == 200
    assert response.json()["attempt"]["lesson"]["result"]["status"] == "correct"
    assert client.post(path(attempt), json=body).json() == response.json()


def test_introduction_audio_is_session_owned_and_missing_audio_never_marks_played(client):
    attempt = start(client, "candy")
    audio_url = attempt["lesson"]["listening"]["audio_url"]
    with TestClient(client.app) as other:
        other.get("/api/session")
        assert other.get(audio_url).status_code == 404
    # This assertion intentionally does not depend on a generated audio asset.
    # A successful download may allow an explicit ended event, but never itself
    # marks playback as completed or reveals the assigned text.
    response = client.get(audio_url)
    assert response.status_code in (200, 503)
    assert response.headers["cache-control"] == "no-store"
    recovered = client.get(f"/api/attempts/{attempt['id']}").json()
    assert recovered["lesson"]["listening"]["played"] is False
    assert recovered["lesson"]["listening"]["introduction_text_id"] is None
    if response.status_code == 503:
        refused = client.post(path(attempt), json=payload(recovered, "listened"))
        assert refused.status_code == 409
    else:
        assert response.headers["content-type"].startswith("audio/wav")
        assert "content-disposition" not in response.headers
        played = send(client, recovered, "listened")
        assert played["lesson"]["listening"]["played"] is True
        assert played["lesson"]["listening"]["introduction_text_id"] is None


@pytest.mark.parametrize("flavor", FLAVOR_TEXT)
def test_candy_introduction_serves_exact_local_clip_without_exposing_target(client, flavor):
    attempt = start(client, "candy")
    internal_attempt(client, attempt, _lesson_target=flavor)
    root = Path(__file__).resolve().parents[2]
    manifest = json.loads((root / "content" / "audio-review-bc.json").read_text())
    clip = next(clip for clip in manifest["clips"] if clip["textId"] == f"BC-CND-INTRO-{flavor.upper()}" and clip["speed"] == "normal")
    expected_audio = (root / "frontend" / "public" / clip["file"].lstrip("/")).read_bytes()
    response = client.get(attempt["lesson"]["listening"]["audio_url"])
    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith("audio/wav")
    assert response.headers["cache-control"] == "no-store"
    assert response.content == expected_audio
    assert hashlib.sha256(response.content).hexdigest() == clip["sha256"]
    headers = json.dumps(dict(response.headers)).lower()
    assert flavor not in headers
    assert clip["textId"].lower() not in headers
    assert Path(clip["file"]).name.lower() not in headers
    recovered = client.get(f"/api/attempts/{attempt['id']}").json()
    assert recovered["lesson"]["listening"]["played"] is False
    assert recovered["lesson"]["listening"]["introduction_text_id"] is None
    assert recovered["lesson"]["answers"] == {}
    played = send(client, recovered, "listened")
    assert played["lesson"]["listening"]["played"] is True
    assert played["lesson"]["listening"]["introduction_text_id"] is None
    assert played["lesson"]["answers"] == {}


def test_fixed_lesson_never_calls_free_dialogue_model(client):
    def forbidden(*_args):
        raise AssertionError("Fixed lessons must not call a free-dialogue model")

    client.app.state.interpreter = forbidden
    assessed = evaluate(client, select(client, start(client), "not_spicy"), "我不吃辣")
    assert assessed["lesson"]["result"]["status"] == "correct"
    assert advance(client, assessed)["lesson"]["step"] == "recommendation"


@pytest.mark.parametrize("station,step,option,text", teaching_options())
def test_displayed_teaching_sentence_matches_its_actual_rule_target(station, step, option, text):
    """Displayed Shanghainese examples must work, not only Mandarin fixtures."""
    attempt = new_attempt("content-fixture", "test-only", station)
    attempt["lesson"].update(step=step, target=option)
    if station == "candy" and step == "flavor":
        attempt["_lesson_target"] = option
    expected = ("incorrect", "task_mismatch") if option == "tofu" else ("correct", "target_matched")
    assert assess(text, attempt) == expected
    if station == "candy" and step == "flavor":
        attempt["_lesson_target"] = next(flavor for flavor in FLAVOR_TEXT if flavor != option)
        assert assess(text, attempt) == ("incorrect", "task_mismatch")
