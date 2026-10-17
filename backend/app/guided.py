"""R3 fixed-question practice. Evaluation never applies an order or advances it."""
from __future__ import annotations

from copy import deepcopy
import re
from uuid import uuid4

from .interpreter import NUMBER_PATTERN, parse_development

GUIDED_SOURCE = "guided-target-check.v1"
PROMPTS = {"item": "NX-N01", "quantity": "NX-N02", "mode": "NX-N03", "confirm": "NX-N09"}


class PracticeError(ValueError):
    def __init__(self, code: str, message: str):
        self.code, self.message = code, message


def initial_practice(step: str = "item") -> dict:
    return {"step": step, "step_id": str(uuid4()),
            "target": {"type": "confirm"} if step == "confirm" else None,
            "result": None, "can_choose": False}


def target_for(step: str, action: dict) -> dict:
    keys = set(action)
    valid = False
    if step == "item":
        valid = action == {"type": "set_order", "item": "xiaolongbao"}
    elif step == "quantity":
        valid = (keys == {"type", "quantity", "unit"} and action["type"] == "set_order"
                 and type(action["quantity"]) is int and 1 <= action["quantity"] <= 20
                 and action["unit"] == "serving")
    elif step == "mode":
        valid = (keys == {"type", "takeaway"} and action["type"] == "set_order"
                 and type(action["takeaway"]) is bool)
    elif step == "confirm":
        valid = action == {"type": "confirm"}
    if not valid:
        raise PracticeError("invalid_practice_target", "Select one valid expression for this question.")
    return deepcopy(action)


def assess(text: str, practice: dict) -> tuple[str, str]:
    """Finite semantic tolerance, not a phonetic or pronunciation assessment."""
    step, target = practice["step"], practice["target"]
    if not text.strip():
        return "unrecognized", "no_speech"
    # This is target practice, not free-form correction handling. A negative
    # or rejected expression must not pass just because it mentions the target.
    # Keep this conservative R3 boundary independent of the historical parser.
    if re.search(r"不|勿|覅|别|莫|取消|\b(?:no|not|never|without|don['’]?t)\b", text, re.I):
        return "incorrect", "ambiguous_expression"
    if step == "item" and re.search(r"还是|或者|\bor\b", text, re.I):
        return "incorrect", "ambiguous_expression"
    checked = text
    if step == "quantity":
        if re.search(r"分之|分钟|小时|秒钟|\b(?:minutes?|hours?|seconds?)\b", text, re.I):
            return "incorrect", "unit_mismatch"
        # Only a bounded numerical quantity phrase receives this homophone rule;
        # fractions (二分之一), minutes and arbitrary words remain unchanged.
        checked = re.sub(rf"({NUMBER_PATTERN})\s*分(?=$|[。.!！?？，,\s]|小笼|谢谢)", r"\1份", checked, flags=re.I)
    parsed = parse_development(checked, {"prompt_id": PROMPTS[step]})
    if parsed.uncertainties:
        return "incorrect", "ambiguous_expression"
    if step == "confirm":
        if parsed.intent == "confirm" and not parsed.changes:
            return "correct", "target_matched"
        return ("incorrect", "confirmation_mismatch") if parsed.changes or parsed.intent == "modify" else ("incorrect", "not_understood")
    field = {"item": "item", "quantity": "quantity", "mode": "takeaway"}[step]
    if field not in parsed.changes:
        return ("incorrect", "target_mismatch") if parsed.changes or parsed.intent == "confirm" else ("incorrect", "not_understood")
    if parsed.changes[field] != target[field]:
        return "incorrect", {"quantity": "quantity_mismatch", "mode": "mode_mismatch", "item": "item_mismatch"}[step]
    if step == "quantity" and parsed.changes.get("unit") != "serving":
        return "incorrect", "unit_mismatch"
    # 个 is an explicitly different counter, not a missing serving unit.
    if step == "quantity" and re.search(rf"{NUMBER_PATTERN}\s*个", checked, flags=re.I):
        return "incorrect", "unit_mismatch"
    return "correct", "target_matched"


def next_step(order: dict) -> str:
    if order["item"] is None:
        return "item"
    if order["quantity"] is None:
        return "quantity"
    if order["takeaway"] is None:
        return "mode"
    return "confirm"


def apply_practice(current: dict, body, evaluation: dict | None = None) -> tuple[dict, list[str]]:
    result = deepcopy(current)
    practice = result["practice"]
    operation = body.operation
    events = []
    if operation == "select":
        practice["target"] = target_for(practice["step"], body.action.model_dump(exclude_unset=True))
        practice["result"] = None
        events.append("practice_target_selected")
    elif operation == "evaluate":
        if practice["target"] is None:
            raise PracticeError("practice_target_required", "Select what you want to say first.")
        practice["result"] = evaluation
        if evaluation["status"] != "correct":
            practice["can_choose"] = True
        events.append("practice_evaluated")
    elif operation == "edit":
        if practice["step"] != "confirm" or result["status"] != "confirming":
            raise PracticeError("practice_edit_unavailable", "Edit an order from its confirmation question.")
        result["practice"] = initial_practice(body.step)
        result["prompt_id"] = PROMPTS[body.step]
        result["status"] = "collecting"
        result["summary_revision"] = result["confirmed_revision"] = None
        events.append("practice_edit_started")
    elif operation == "continue":
        target, feedback = practice["target"], practice["result"]
        if target is None:
            raise PracticeError("practice_target_required", "Select what you want to say first.")
        if body.result_request_id is not None and (feedback is None or feedback["request_id"] != body.result_request_id):
            raise PracticeError("stale_practice_result", "Review the current result before continuing.")
        if body.assisted:
            if not practice["can_choose"]:
                raise PracticeError("practice_speak_required", "Try speaking before using the selected answer.")
            result["metrics"]["help_used"] += 1
            events.append("practice_assisted_continue")
        elif feedback is None or feedback["status"] != "correct":
            raise PracticeError("practice_result_required", "A correct result is required for unassisted continuation.")
        else:
            events.append("practice_voice_continue")
        if practice["step"] == "confirm":
            if result["status"] != "confirming" or result["summary_revision"] is None:
                raise PracticeError("stale_summary", "Review the current order before confirming.")
            result["confirmed_revision"] = result["summary_revision"]
            result["status"], result["prompt_id"] = "completed", "NX-N10"
            events += ["confirmation_accepted", "task_completed"]
        else:
            result["order"].update({key: value for key, value in target.items() if key != "type"})
            if practice["step"] == "quantity":
                result["order"]["normalized_servings"] = target["quantity"]
            following = next_step(result["order"])
            result["practice"] = initial_practice(following)
            result["prompt_id"] = PROMPTS[following]
            result["status"] = "confirming" if following == "confirm" else "collecting"
            result["summary_revision"] = current["revision"] + 1 if following == "confirm" else None
            result["confirmed_revision"] = None
            events.append("fields_updated")
            if following == "confirm":
                events.append("confirmation_shown")
    result["revision"] += 1
    return result, events
