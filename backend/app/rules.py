"""Deterministic Nanxiang rules; task targets never fill learner fields."""
from __future__ import annotations

from copy import deepcopy
from .models import Interpretation

RULE_VERSION = "nanxiang-rules.v3"
R2_RULE_VERSION = "nanxiang-rules.v2"
LEGACY_RULE_VERSION = "nanxiang-rules.v1"
CONTENT_VERSION = "batch-a-r3.2026-10-17.v1"
R2_CONTENT_VERSION = "batch-a-r2.2026-10-17.v1"
R1_CONTENT_VERSION = "batch-a-r1.2026-10-17.v1"
LEGACY_CONTENT_VERSION = "batch-a.2026-10-17.v1"
ORDER_FIELDS = {"item", "quantity", "unit", "takeaway"}
DERIVED_ISSUES = {"unsupported_item", "quantity_out_of_range", "unit_unknown", "piece_not_serving",
                  "basket_unit_unexplained", "quantity_not_target", "takeaway_required"}


def new_attempt(attempt_id: str, now: str, *, content_version: str = CONTENT_VERSION,
                rule_version: str = RULE_VERSION) -> dict:
    result = {
        "id": attempt_id, "station_id": "nanxiang", "status": "collecting", "revision": 0,
        "content_version": content_version, "rule_version": rule_version,
        "order": {"item": None, "quantity": None, "unit": None,
                  "normalized_servings": None, "takeaway": None},
        "unresolved_issues": [], "summary_revision": None, "confirmed_revision": None,
        "prompt_id": "NX-N01", "pending_request_id": None,
        "metrics": {"voice_attempts": 0, "help_used": 0},
        "unit_convention_seen": False, "created_at": now, "updated_at": now,
    }
    if rule_version == RULE_VERSION:
        from .guided import initial_practice
        result["practice"] = initial_practice()
    return result


def issues_for(order: dict, unit_seen: bool, rule_version: str = RULE_VERSION) -> list[str]:
    issues = []
    if order["item"] is not None and order["item"] != "xiaolongbao":
        issues.append("unsupported_item")
    quantity, unit = order["quantity"], order["unit"]
    if quantity is not None:
        if type(quantity) is not int or quantity < 1 or quantity > 20:
            issues.append("quantity_out_of_range")
        if unit in (None, "unknown"):
            issues.append("unit_unknown")
        elif unit == "piece":
            issues.append("piece_not_serving")
        elif unit == "basket" and not unit_seen:
            issues.append("basket_unit_unexplained")
        elif unit not in ("serving", "basket"):
            issues.append("unit_unknown")
        if (rule_version == LEGACY_RULE_VERSION and order["normalized_servings"] is not None
                and order["normalized_servings"] != 2):
            issues.append("quantity_not_target")
    if rule_version == LEGACY_RULE_VERSION and order["takeaway"] is False:
        issues.append("takeaway_required")
    return issues


def ready(attempt: dict) -> bool:
    order = attempt["order"]
    if attempt.get("rule_version", LEGACY_RULE_VERSION) == LEGACY_RULE_VERSION:
        return (order["item"] == "xiaolongbao" and order["normalized_servings"] == 2
                and order["takeaway"] is True and not attempt["unresolved_issues"])
    return (order["item"] == "xiaolongbao" and type(order["normalized_servings"]) is int
            and 1 <= order["normalized_servings"] <= 20
            and type(order["takeaway"]) is bool and not attempt["unresolved_issues"])


def choose_prompt(attempt: dict) -> str:
    issues, order = attempt["unresolved_issues"], attempt["order"]
    if "unsupported_item" in issues:
        return "NX-N07"
    if any(x in issues for x in ("unit_unknown", "piece_not_serving", "basket_unit_unexplained")):
        return "NX-N04"
    if "quantity_out_of_range" in issues:
        return "NX-N08"
    if "quantity_not_target" in issues:
        return "NX-N05"
    if "takeaway_required" in issues:
        return "NX-N06"
    if issues:
        return "NX-N11" if "unclear_modification" in issues else "NX-N12"
    if order["item"] is None:
        return "NX-N01"
    if order["quantity"] is None:
        return "NX-N02"
    if order["takeaway"] is None:
        return "NX-N03"
    return "NX-N09"


def apply_interpretation(current: dict, parsed: Interpretation, summary_revision: int | None) -> tuple[dict, list[str]]:
    result = deepcopy(current)
    changes = parsed.changes
    events: list[str] = []
    if parsed.intent == "repeat" and not changes and not parsed.uncertainties:
        return result, ["repeat_requested"]

    # Re-validate all extracted fields, even after a provider validated its JSON.
    accepted = {}
    rejected = []
    for key, value in changes.items():
        if key not in ORDER_FIELDS:
            rejected.append("unrecognized_field")
            continue
        if value is not None and (
            (key == "quantity" and (type(value) is not int or abs(value) > 1000000))
            or (key == "takeaway" and type(value) is not bool)
            or (key == "item" and (not isinstance(value, str) or len(value) > 60))
            or (key == "unit" and value not in ("serving", "basket", "piece", "unknown"))
        ):
            rejected.append("invalid_" + key)
        else:
            accepted[key] = value

    mutation = bool(changes) or parsed.intent == "modify" or bool(parsed.uncertainties)
    if mutation:
        previous_order = deepcopy(result["order"])
        result["order"].update(accepted)
        # A new quantity without a unit cannot inherit an old unit accidentally.
        if "quantity" in accepted and "unit" not in accepted:
            result["order"]["unit"] = None
        order = result["order"]
        quantity, unit = order["quantity"], order["unit"]
        order["normalized_servings"] = (
            quantity if type(quantity) is int and 1 <= quantity <= 20 and
            (unit == "serving" or (unit == "basket" and result["unit_convention_seen"])) else None
        )
        problems = issues_for(order, result["unit_convention_seen"],
                              result.get("rule_version", LEGACY_RULE_VERSION))
        # Ambiguous / invalid edits block an older valid order until explicitly resolved.
        problems.extend(rejected)
        problems.extend(parsed.uncertainties)
        if parsed.intent == "modify" and not accepted:
            problems.append("unclear_modification")
        # A response to a different field cannot silently remove an unresolved edit.
        retained = []
        for problem in current["unresolved_issues"]:
            if problem.startswith("ambiguous_") or problem.startswith("invalid_"):
                field = problem.split("_", 1)[1]
                if field not in accepted:
                    retained.append(problem)
            elif problem in ("unclear_modification", "unrecognized_field") and not accepted:
                retained.append(problem)
            elif (problem not in DERIVED_ISSUES
                  and not problem.startswith(("ambiguous_", "invalid_"))
                  and problem not in ("unclear_modification", "unrecognized_field")
                  and not ORDER_FIELDS <= set(accepted)):
                retained.append(problem)
        result["unresolved_issues"] = sorted(set(problems + retained))
        result["summary_revision"] = None
        result["confirmed_revision"] = None
        result["revision"] += 1
        events.extend(["fields_updated" if previous_order != order else "clarification_shown"])
        if parsed.intent == "modify":
            events.append("correction_received")
        if result["unresolved_issues"]:
            events.append("validation_rejected")
    elif parsed.intent == "confirm":
        if (current["status"] == "confirming" and ready(current)
                and summary_revision is not None
                and summary_revision == current["summary_revision"] == current["revision"]):
            result["confirmed_revision"] = summary_revision
            result["status"] = "completed"
            result["revision"] += 1
            result["prompt_id"] = "NX-N10"
            return result, ["confirmation_accepted", "task_completed"]
        # No summary means the learner has not been shown anything they can confirm.
        events.append("confirmation_rejected")
    else:
        events.append("interpretation_unrecognized")

    if ready(result):
        result["status"] = "confirming"
        result["summary_revision"] = result["revision"]
        if mutation:
            events.append("confirmation_shown")
    else:
        result["status"] = "collecting"
        result["summary_revision"] = None
    result["prompt_id"] = choose_prompt(result)
    return result, events
