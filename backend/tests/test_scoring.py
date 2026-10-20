"""Lenient scoring: deduction rules and the content gate it must never weaken."""
import pytest

from app import guided, lessons, scoring
from test_lessons import client, evaluate, select, start  # noqa: F401  (fixture reuse)

QUANTITY = {"step": "quantity", "target": {"type": "set_order", "quantity": 2, "unit": "serving"}}
TAKEAWAY = {"step": "mode", "target": {"type": "set_order", "takeaway": True}}
ITEM = {"step": "item", "target": {"type": "set_order", "item": "xiaolongbao"}}
TEA = {"station_id": "teahouse", "lesson": {"step": "appreciation", "target": "good_tea"}}
THANKS = {"station_id": "teahouse", "lesson": {"step": "thanks", "target": "thanks"}}
SPICE = {"station_id": "restaurant", "lesson": {"step": "preference", "target": "not_spicy"}}


def nanxiang(practice, text):
    return scoring.assess_lenient(text, lambda t: guided.assess(t, practice), practice["step"])


def station(attempt, text):
    return scoring.assess_lenient(text, lambda t: lessons.assess(t, attempt), attempt["lesson"]["step"])


def test_clean_correct_answer_scores_full_and_passes():
    status, reason, result = nanxiang(QUANTITY, "两份")
    assert (status, reason, result["score"], result["verdict"]) == ("correct", "target_matched", 100, "pass")


@pytest.mark.parametrize("practice,text", [
    (TEA, "嗯，好喝"), (TEA, "呃，好喝，好喝"), (TEA, "嗯 蛮香个"),
    (QUANTITY, "两份，两份"), (QUANTITY, "嗯……两份"), (THANKS, "嗯，谢谢"),
])
def test_pauses_and_restarts_are_free(practice, text):
    status, _, result = station(practice, text) if "station_id" in practice else nanxiang(practice, text)
    assert status == "correct" and result["score"] == 100 and result["verdict"] == "pass"
    assert [d["type"] for d in result["deductions"]] == ["pause_or_repetition"]


def test_homophone_quantity_is_a_recorded_free_variant():
    _, _, result = nanxiang(QUANTITY, "两分")
    assert result["score"] == 100
    assert "accepted_variant" in [d["type"] for d in result["deductions"]]


NEGATIVES = [
    (QUANTITY, "不要两份"), (QUANTITY, "两份，不，三"), (QUANTITY, "两个"), (QUANTITY, "七份"),
    (QUANTITY, "两份还是七份"), (ITEM, "别给我小笼"), (ITEM, "小笼，不要"), (TAKEAWAY, "别打包"),
    (TAKEAWAY, "堂吃"), (TEA, "茶不好喝"), (TEA, "这茶好喝吗"), (TEA, "风景很好"),
    (THANKS, "不要说谢谢"), (THANKS, "他说谢谢"), (SPICE, "我吃辣"), (SPICE, "我不是不吃辣"),
]


@pytest.mark.parametrize("practice,text", NEGATIVES)
@pytest.mark.parametrize("wrap", ["{}", "嗯，{}", "{0}，{0}", "呃 {} 嗯"])
def test_tolerance_never_passes_negation_conflict_or_wrong_object(practice, text, wrap):
    spoken = wrap.format(text)
    status, _, result = station(practice, spoken) if "station_id" in practice else nanxiang(practice, spoken)
    assert status == "incorrect" and result["verdict"] == "retry"


def test_unrecognized_is_not_scored_and_asks_for_rerecord():
    status, reason, result = nanxiang(QUANTITY, "")
    assert (status, reason, result["score"], result["verdict"]) == ("unrecognized", "no_speech", None, "rerecord")
    assert scoring.unscored("technical")["verdict"] == "unavailable"


def test_rule_a_uncertain_phonetic_evidence_costs_nothing():
    result = scoring.score([{"type": "minor_tone", "confidence": 0.4},
                            {"type": "severe_pronunciation", "uncertain": True}])
    assert result["score"] == 100 and result["verdict"] == "pass"


def test_rule_b_one_span_is_deducted_once_at_its_worst():
    result = scoring.score([{"type": "minor_pronunciation", "span": "份"}, {"type": "minor_tone", "span": "份"}])
    assert result["score"] == 97 and len(result["deductions"]) == 1


def test_rule_c_caps_minor_errors_but_not_key_errors():
    minor = scoring.score([{"type": "omitted_non_key"}] * 5)
    assert (minor["score"], minor["capped"], minor["verdict"]) == (85, True, "pass")
    key = scoring.score([{"type": "omitted_non_key"}] * 3 + [{"type": "key_content_error"}])
    assert (key["score"], key["capped"], key["verdict"]) == (75, False, "retry")


def test_profiles_scale_deductions_and_threshold_decides_minor_only_results():
    events = [{"type": "minor_tone"}, {"type": "minor_pronunciation"}, {"type": "omitted_non_key"}]
    assert scoring.score(events)["score"] == 90
    assert scoring.score(events, "strict")["score"] == 85  # 20 points, capped at 15
    assert scoring.score(events, threshold=95)["verdict"] == "retry"


def test_confident_severe_pronunciation_blocks_even_when_text_matched():
    status, reason, result = scoring.assess_lenient(
        "两份", lambda t: guided.assess(t, QUANTITY), "quantity",
        observations=[{"type": "severe_pronunciation", "span": "两", "confidence": 0.9}])
    assert (status, reason, result["verdict"]) == ("incorrect", "pronunciation_unclear", "retry")


def test_unintelligible_audio_is_unscored():
    assert scoring.score([{"type": "unintelligible"}])["verdict"] == "rerecord"


def test_api_evaluation_carries_internal_scoring(client):  # noqa: F811
    attempt = select(client, start(client, "teahouse"), "good_tea")
    result = evaluate(client, attempt, "嗯，好喝")["lesson"]["result"]
    assert result["status"] == "correct" and result["transcript"] == "嗯，好喝"
    assert result["scoring"]["version"] == scoring.SCORING_VERSION
    assert result["scoring"]["score"] == 100 and result["scoring"]["verdict"] == "pass"


def test_nanxiang_api_scores_and_gate_still_blocks_negation(client):  # noqa: F811
    import test_guided as g
    attempt = g.select(client, g.quantity_question(client), quantity=2, unit="serving")
    attempt = g.evaluate(client, attempt, "两份，两份")
    passed = attempt["practice"]["result"]
    assert passed["status"] == "correct" and passed["scoring"]["verdict"] == "pass"
    blocked = g.evaluate(client, g.select(client, attempt, quantity=2, unit="serving"), "嗯，不要两份")["practice"]["result"]
    assert blocked["status"] == "incorrect" and blocked["scoring"]["verdict"] == "retry"
    assert blocked["scoring"]["deductions"][0]["type"] == "key_content_error"


def test_failed_recording_records_unscored_result(client):  # noqa: F811
    attempt = select(client, start(client, "teahouse"), "good_tea")
    from test_lessons import send
    result = send(client, attempt, "evaluate", failure_kind="technical")["lesson"]["result"]
    assert result["status"] == "technical" and result["scoring"]["score"] is None
    assert result["scoring"]["verdict"] == "unavailable"
