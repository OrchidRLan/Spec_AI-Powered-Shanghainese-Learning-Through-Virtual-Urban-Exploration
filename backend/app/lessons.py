"""Fixed questions for the three additional stations; no generated follow-ups.

Selected teaching targets, expression matching and task requirements remain
separate. Evaluation only saves feedback; an explicit continuation applies it.
"""
from __future__ import annotations

from copy import deepcopy
import re
import secrets
from uuid import uuid4

from .guided import PracticeError, assess as assess_nanxiang

CONTENT_VERSION = "batch-bc.2026-10-17.v1"
RULE_VERSION = "station-lessons.v1"
SOURCE = "station-target-check.v1"
STEPS = {
    "restaurant": ("preference", "recommendation", "dish", "confirm"),
    "candy": ("flavor", "quantity", "confirm"),
    "teahouse": ("appreciation", "thanks"),
}
OPTIONS = {
    "preference": ("not_spicy",), "recommendation": ("recommend",),
    "dish": ("fish", "chicken", "tofu"), "flavor": ("rose", "osmanthus", "mint"),
    "quantity": ("two_packs",), "confirm": ("confirm",),
    "appreciation": ("good_tea",), "thanks": ("thanks",),
}
PROMPTS = {
    "restaurant": {"preference": "BC-OLD-ASK-PREFERENCE", "recommendation": "BC-OLD-ASK-RECOMMENDATION",
                   "dish": "BC-OLD-ASK-DISH", "completed": "BC-OLD-COMPLETE"},
    "candy": {"flavor": "BC-CND-ASK-FLAVOR", "quantity": "BC-CND-ASK-QUANTITY", "completed": "BC-CND-COMPLETE"},
    "teahouse": {"appreciation": "BC-TEA-ASK-APPRECIATION", "thanks": "BC-TEA-RESPONSE", "completed": "BC-TEA-COMPLETE"},
}
DISHES = {"fish": r"清蒸鱼|清蒸魚|蒸鱼|蒸魚|\b(?:steamed\s+)?fish\b",
          "chicken": r"白斩鸡|白斬雞|白切鸡|白切雞|\b(?:poached\s+)?chicken\b",
          "tofu": r"豆腐|\btofu\b"}
FLAVORS = {"rose": r"玫瑰|\brose\b", "osmanthus": r"桂花|\bosmanthus\b", "mint": r"薄荷|\bmint\b"}
NEGATIVE = r"不|勿|覅|别|莫|取消|\b(?:no|not|never|without|don['’]?t|isn['’]?t|is\s+not|can['’]?t)\b"
META = r"[“”‘「」『』\"]|怎么说|怎麼說|该说|該說|应该说|應該說|可以说|可以說|(?:他说|他說|她说|她說|我说|我說|刚才说|剛才說|说了|說了)|\b(?:say|said|saying|means?|translate|should\s+i)\b"


def fail(code: str, message: str):
    raise PracticeError(code, message)


def new_question(lesson: dict, step: str):
    lesson.update(step=step, step_id=str(uuid4()), target="confirm" if step == "confirm" else None,
                  result=None, can_choose=False)


def prompt_for(attempt: dict) -> str:
    station, lesson = attempt["station_id"], attempt["lesson"]
    if attempt["status"] == "completed":
        return PROMPTS[station]["completed"]
    if lesson["step"] == "confirm":
        if station == "restaurant":
            return f"BC-OLD-CONFIRM-{lesson['answers']['dish'].upper()}"
        return f"BC-CND-CONFIRM-{lesson['answers']['flavor'].upper()}"
    return PROMPTS[station][lesson["step"]]


def new_attempt(attempt_id: str, timestamp: str, station_id: str) -> dict:
    lesson = {"answers": {}, "history": [], "listening": None}
    new_question(lesson, STEPS[station_id][0])
    result = {"id": attempt_id, "station_id": station_id, "status": "collecting", "revision": 0,
              "content_version": CONTENT_VERSION, "rule_version": RULE_VERSION,
              "order": {"item": None, "quantity": None, "unit": None, "normalized_servings": None, "takeaway": None},
              "unresolved_issues": [], "summary_revision": None, "confirmed_revision": None,
              "prompt_id": lesson["step"], "pending_request_id": None,
              "metrics": {"voice_attempts": 0, "help_used": 0}, "unit_convention_seen": False,
              "created_at": timestamp, "updated_at": timestamp, "lesson": lesson}
    if station_id == "candy":
        result["_lesson_target"] = secrets.choice(OPTIONS["flavor"])
        result["_introduction_served"] = False
        lesson["listening"] = {"audio_url": f"/api/attempts/{attempt_id}/introduction/audio",
                               "played": False, "text_revealed": False, "introduction_text_id": None}
    result["prompt_id"] = prompt_for(result)
    return result


def public_fields(attempt: dict) -> dict:
    """Never expose the assigned flavor through session, errors or recovery."""
    return {key: deepcopy(value) for key, value in attempt.items() if not key.startswith("_")}


def task_matches(attempt: dict, option: str | None = None) -> bool:
    lesson = attempt["lesson"]
    option = option if option is not None else lesson["target"]
    if lesson["step"] == "dish":
        return option in ("fish", "chicken")
    if lesson["step"] == "flavor":
        return option == attempt["_lesson_target"]
    return True


def listening_ready(attempt: dict):
    listening = attempt["lesson"]["listening"]
    if listening and not (listening["played"] or listening["text_revealed"]):
        fail("lesson_listening_required", "Listen to the introduction or open its text first.")


def contains(pattern: str, text: str) -> bool:
    return re.search(pattern, text, re.I) is not None


def assess(text: str, attempt: dict) -> tuple[str, str]:
    lesson = attempt["lesson"]
    step, target = lesson["step"], lesson["target"]
    if not text.strip():
        return "unrecognized", "no_speech"
    compact = re.sub(r"\s+", "", text)
    # Questions, quoted teaching examples and reported speech are not the act
    # the learner is practicing. A final question mark alone may be ASR noise.
    if contains(META, text) or contains(r"还是|還是|或者|\bor\b", text):
        return "incorrect", "ambiguous_expression"
    matched = False
    if step == "preference":
        matched = contains(r"(?:勿|不)(?:要|吃|想吃)?辣|覅辣|\b(?:not\s+spicy|non[-\s]?spicy|no\s+(?:spice|chili)|(?:don['’]?t|do\s+not)\s+(?:eat|want|like)\s+spicy)\b", text)
        if contains(r"(?:勿|不|覅|别|別)(?:要|是|想)?(?:勿|不|覅)|吃辣|要辣|\b(?:want|like|eat)\s+(?:it\s+)?spicy\b", text):
            positive_remainder = re.sub(r"(?:勿|不)(?:要|吃|想吃)?辣|覅辣|\b(?:don['’]?t|do\s+not)\s+(?:eat|want|like)\s+spicy\b", "", text, flags=re.I)
            if contains(r"吃辣|要辣|\b(?:want|like|eat)\s+(?:it\s+)?spicy\b|(?:勿|不|覅|别|別)(?:要|是|想)?(?:勿|不|覅)", positive_remainder) or contains(r"(?:勿|不|覅|别|別)(?:要|是|想|吃)?(?:勿|不|覅)", compact):
                matched = False
        if contains(r"不辣.{0,5}(?:不要|勿要|覅|不吃)|(?:不|勿|覅)(?:要|是|想|吃)?.{0,2}(?:不|勿|覅).{0,2}辣|\b(?:do\s+not|don['’]?t|not|never)\s+(?:want|like|eat)\s+(?:non[-\s]?spicy|not\s+spicy)", text):
            matched = False
    elif step == "recommendation":
        matched = contains(r"(?:有啥|有什么|有什麼|啥|什么|什麼|请|請|帮我|幫我|能否|可以).{0,8}(?:推荐|推薦)|有啥好吃|有什么好吃|有什麼好吃|\b(?:what\s+(?:would|do)\s+you\s+(?:suggest|recommend)|(?:can|could|would)\s+you\s+recommend|any\s+recommendations?|please\s+recommend)\b", text) or re.fullmatch(r"\s*(?:推荐|推薦)(?:一道菜)?[。.!！?？]*\s*", text) is not None
        if contains(NEGATIVE, text) or contains(r"推荐了|推薦了|推荐过|推薦過|我推荐|我推薦|\b(?:i\s+recommend|you\s+recommended)\b", text):
            matched = False
    elif step in ("dish", "flavor"):
        dictionary = DISHES if step == "dish" else FLAVORS
        found = [key for key, pattern in dictionary.items() if contains(pattern, text)]
        matched = found == [target] and not contains(NEGATIVE, text)
    elif step == "quantity":
        matched = contains(r"(?<![\d零〇一二两兩三四五六七八九十百千万萬])(?:两|兩|二|2)\s*包|\btwo\s+(?:packs?|packets?|packages?)\b", text)
        if contains(NEGATIVE, text) or contains(r"(?:[013-9一三四五六七八九十百]|\d{2,})\s*(?:包|pack)|(?:两|兩|二|2)\s*(?:个|個|颗|顆|份)|\b(?:one|three|four|five|six|seven|eight|nine|ten|twenty)\b", text):
            matched = False
    elif step == "confirm":
        return assess_nanxiang(text, {"step": "confirm", "target": {"type": "confirm"}})
    elif step == "appreciation":
        # Mild 'not bad' is positive. Negation of the praise itself remains
        # negative, and praising scenery/cups/food cannot satisfy tea's task.
        normalized = re.sub(r"还不错|還不錯|不错|不錯|\bnot\s+bad\b", "好喝", text, flags=re.I)
        positive = contains(r"好吃|好喝|香|喜欢|喜歡|欢喜|歡喜|\b(?:good|nice|delicious|fragrant|tasty|love|like|enjoy)\b", normalized)
        implicit = re.fullmatch(r"[\s。.!！,，]*(?:我|搿个|这个|這個|它)?(?:觉得|覺得)?(?:老|蛮|蠻|真|真的|很|好|挺|还|還|非常|比较|比較|特别|特別)*(?:好吃|好喝|香|喜欢|喜歡|欢喜|歡喜)(?:个|的|它|搿个|这个|這個)?[\s。.!！,，]*", normalized) is not None
        implicit = implicit or re.fullmatch(r"\s*(?:(?:it(?:['’]s|\s+is|\s+tastes|\s+smells)?|this(?:\s+is)?)(?:\s+(?:really|very|so|quite))?\s+)?(?:good|nice|delicious|fragrant|tasty)[.!?\s]*|\s*i\s+(?:(?:really|quite)\s+)?(?:like|love|enjoy)\s+it[.!?\s]*", normalized, re.I) is not None
        implicit = implicit or re.fullmatch(r"\s*(?:很|真|蛮|蠻)?香[，,；;\s]+我(?:很|蛮|蠻)?(?:喜欢|喜歡|欢喜|歡喜)[。.!！\s]*", normalized) is not None
        matched = positive and (contains(r"茶|\btea\b", text) or implicit)
        # A cup of tea identifies the tea; praising the cup itself does not.
        object_text = re.sub(r"(?:这|這|那|搿)?杯茶|\bcup\s+of\s+tea\b", "茶", text, flags=re.I)
        if (contains(NEGATIVE, normalized)
                or contains(r"难喝|難喝|难吃|難吃|讨厌|討厭|差|糟|坏|壞|苦得|\b(?:dislike|hate|bad|awful|terrible|disgusting)\b", normalized)
                or contains(r"吗|嗎|么|麼|伐|\b(?:is|does|do|would|could)\s+(?:this|the|it)\b", text)
                or contains(r"杯|风景|風景|景色|点心|點心|食物|菜|店员|店員|服务|服務|环境|環境|店|\b(?:cup|view|scenery|food|dish|dumpling|cake|room|server|host|service|staff|waiter|waitress|decor|shopkeeper|shop)\b", object_text)):
            matched = False
    elif step == "thanks":
        matched = contains(r"谢谢|謝謝|多谢|多謝|谢谢侬|謝謝儂|\b(?:thanks|thank\s+you|thank\s+ya)\b", text)
        if contains(NEGATIVE, text) or contains(r"不用谢|不用謝|勿用谢|勿用謝|不必谢|不必謝|\byou['’]?re\s+welcome\b", text):
            matched = False
    if not matched:
        return "incorrect", "target_mismatch"
    if not task_matches(attempt):
        return "incorrect", "task_mismatch"
    return "correct", "target_matched"


def apply(current: dict, body, evaluation: dict | None = None) -> tuple[dict, list[str]]:
    result = deepcopy(current)
    lesson = result["lesson"]
    step, operation = lesson["step"], body.operation
    events = []
    if operation in ("listened", "help"):
        if result["station_id"] != "candy":
            fail("lesson_listening_unavailable", "This station has no listening introduction.")
        listening = lesson["listening"]
        if operation == "listened":
            if not result.get("_introduction_served"):
                fail("lesson_audio_required", "Play the available introduction before marking it finished.")
            listening["played"] = True
            events.append("lesson_introduction_played")
        else:
            if not listening["text_revealed"]:
                result["metrics"]["help_used"] += 1
            listening["text_revealed"] = True
            listening["introduction_text_id"] = f"BC-CND-INTRO-{result['_lesson_target'].upper()}"
            events.append("lesson_introduction_revealed")
    elif operation == "select":
        if body.option_id not in OPTIONS[step]:
            fail("invalid_lesson_target", "Select one expression for the current question.")
        lesson["target"], lesson["result"] = body.option_id, None
        events.append("lesson_target_selected")
    elif operation == "evaluate":
        listening_ready(result)
        if lesson["target"] is None:
            fail("lesson_target_required", "Select what you want to say first.")
        lesson["result"] = evaluation
        if evaluation["status"] != "correct":
            lesson["can_choose"] = True
        events.append("lesson_evaluated")
    elif operation == "edit":
        steps = STEPS[result["station_id"]]
        if step != "confirm" or result["status"] != "confirming" or body.step not in steps[:-1]:
            fail("lesson_edit_unavailable", "Edit a previous answer from the confirmation question.")
        for erased in steps[steps.index(body.step):]:
            lesson["answers"].pop(erased, None)
        new_question(lesson, body.step)
        result.update(status="collecting", summary_revision=None, confirmed_revision=None)
        events.append("lesson_edit_started")
    elif operation == "continue":
        listening_ready(result)
        feedback = lesson["result"]
        if lesson["target"] is None:
            fail("lesson_target_required", "Select what you want to say first.")
        if body.result_request_id is not None and (feedback is None or feedback["request_id"] != body.result_request_id):
            fail("stale_lesson_result", "Review the current result before continuing.")
        if body.assisted:
            if not lesson["can_choose"]:
                fail("lesson_speak_required", "Try speaking before using the selected answer.")
            result["metrics"]["help_used"] += 1
        elif feedback is None or feedback["status"] != "correct":
            fail("lesson_result_required", "A correct result is required for unassisted continuation.")
        if not task_matches(result):
            fail("lesson_task_mismatch", "Choose an answer that meets this step's task.")
        lesson["answers"][step] = lesson["target"]
        lesson["history"].append({"step": step, "step_id": lesson["step_id"], "option_id": lesson["target"],
                                  "assisted": body.assisted, "result": deepcopy(feedback), "revision": result["revision"] + 1})
        events.append("lesson_assisted_continue" if body.assisted else "lesson_voice_continue")
        steps = STEPS[result["station_id"]]
        if step == steps[-1]:
            if step == "confirm":
                if result["status"] != "confirming" or result["summary_revision"] is None:
                    fail("stale_summary", "Review the current order before confirming.")
                result["confirmed_revision"] = result["summary_revision"]
                events.append("confirmation_accepted")
            result["status"] = "completed"
            result["completed_snapshot"] = {"answers": deepcopy(lesson["answers"]), "revision": result["revision"] + 1}
            events.append("task_completed")
        else:
            following = steps[steps.index(step) + 1]
            new_question(lesson, following)
            result["status"] = "confirming" if following == "confirm" else "collecting"
            result["summary_revision"] = result["revision"] + 1 if following == "confirm" else None
            result["confirmed_revision"] = None
            if following == "confirm":
                events.append("confirmation_shown")
    result["prompt_id"] = prompt_for(result)
    # Compatibility summary only contains the learner's committed answers.
    answers = lesson["answers"]
    result["order"].update(item=answers.get("dish") if result["station_id"] == "restaurant" else answers.get("flavor"),
                           quantity=2 if answers.get("quantity") == "two_packs" else (1 if answers.get("dish") else None),
                           unit="pack" if answers.get("quantity") else ("serving" if answers.get("dish") else None))
    result["revision"] += 1
    return result, events
