"""Explicitly labelled, conservative development parser; this is not an LLM.

Limited Chinese / English phrases let developers exercise the real rule / save
path before a configured interpretation provider is available. Unsupported
syntax is kept as the learner's text, never promoted to teaching content.
"""
from __future__ import annotations

import re
from .models import Interpretation

PARSER_VERSION = "development-parser.v2"
ITEM_PATTERN = r"(?:小笼包|小笼馒头|xiaolongbao|soup dumplings)"
NEGATIVE_PREFIX = r"(?:(?:不|勿)\s*(?:是|要|想(?:\s*(?:要|吃))?|用|需要)?|覅)\s*"
SAME_CLAUSE = r"[^，,。.!！?？;；\n]*"
NUMBERS = {"一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5,
           "六": 6, "七": 7, "八": 8, "九": 9, "十": 10,
           "one": 1, "two": 2, "three": 3, "four": 4, "five": 5}
QUANTITY = re.compile(r"(?P<n>\d+|[零一二两三四五六七八九十百千万]+|\b(?:one|two|three|four|five)\b)\s*(?P<u>servings?|baskets?|dumplings?|份|笼|只|个)?", re.I)


def parse_development(text: str, attempt: dict) -> Interpretation:
    original = text.strip()
    value = original.lower().strip("。.!！?？ ")
    result = Interpretation(model_config_id=PARSER_VERSION)
    if re.fullmatch(r"(对[的个]?|是的|确认|确认订单|没错|好[的]?|yes|yes,? (that'?s )?right|correct|confirm|that'?s right)", value):
        result.intent = "confirm"
        return result
    repeat_requested = bool(re.search(r"没听清|再[说讲]一[遍次]|repeat|say that again|didn'?t hear", value))
    result.help_requested = repeat_requested

    modification = bool(re.search(r"改|换|不要|不想|不是|不，|不,|勿|覅|change|instead|actually|don'?t|not ", value))
    if modification:
        result.intent = "modify"
    if re.search(r"不知道.*(数量|几份)|not sure how many|clear quantity", value):
        result.changes.update(quantity=None, unit=None)
        result.evidence["quantity"] = original
    else:
        matches = [m for m in QUANTITY.finditer(value)
                   if m.group("u") or value.strip() == m.group("n")
                   or re.search(r"(?:我要|要|want|order)\s*$", value[:m.start()])]
        invalid_numeric_form = bool(re.search(r"[+-]\s*\d|\d+[.,]\d+|[零一二两三四五六七八九十]+点|负[零一二两三四五六七八九十\d]|[份笼只个]半|半[份笼只个]", value))
        if invalid_numeric_form:
            matches = []
            result.uncertainties.append("ambiguous_quantity")
        # Bare numbers only inherit the unit when the immediately displayed
        # question explicitly asked how many servings. 个 is never a serving.
        if matches:
            ambiguous = len(matches) > 1 and not re.search(r"改|不[，,]|instead|actually", value)
            if ambiguous:
                result.uncertainties.append("ambiguous_quantity")
            else:
                match = matches[-1]
                number = match.group("n").lower()
                if not number.isdigit() and number not in NUMBERS:
                    result.uncertainties.append("ambiguous_quantity")
                    quantity = None
                else:
                    quantity = int(number) if number.isdigit() else NUMBERS[number]
                unit = match.group("u")
                if unit in ("份", "serving", "servings"):
                    unit = "serving"
                elif unit in ("笼", "basket", "baskets"):
                    unit = "basket"
                elif unit in ("只", "dumpling", "dumplings"):
                    unit = "piece"
                elif unit == "个":
                    unit = "unknown"
                elif re.fullmatch(r"\s*(\d+|[一二两三四五六七八九十]|one|two|three|four|five)\s*", value) and attempt["prompt_id"] == "NX-N02":
                    unit = "serving"
                    result.evidence["unit"] = "context:NX-N02 explicitly asked for servings"
                else:
                    unit = "unknown"
                result.changes.update(quantity=quantity, unit=unit)
                result.evidence["quantity"] = match.group(0)
                result.evidence.setdefault("unit", match.group(0))
        if matches and re.search(NEGATIVE_PREFIX + r"[一二两三四五六七八九十\d]|\b(?:not|don'?t\s+want)\s+(?:one|two|three|\d)", value) and not re.search(r"改|instead|actually|不[，,]", value):
            # A rejected amount is not a positive replacement amount.
            result.changes.pop("quantity", None)
            result.changes.pop("unit", None)
            result.uncertainties.append("ambiguous_quantity")

    if re.search(ITEM_PATTERN, value):
        if re.search(NEGATIVE_PREFIX + SAME_CLAUSE + r"小笼(?:包|馒头)|(?:don'?t|do\s+not)\s+want" + SAME_CLAUSE + r"(xiaolongbao|dumplings)|not\s+(?:the\s+)?(xiaolongbao|soup dumplings)", value):
            result.changes["item"] = None
        else:
            result.changes["item"] = "xiaolongbao"
        result.evidence["item"] = original
    elif re.search(r"(要|want|order).*(面条|炒饭|noodles|rice)", value):
        result.changes["item"] = "unsupported"
        result.evidence["item"] = original

    # Do not infer an item solely because only one is on the task menu.
    negative_takeaway = bool(re.search(NEGATIVE_PREFIX + r"(?:打包|外带|带走)|(?:打包|外带|带走)\s*(?:不\s*要|取消)|(?:don'?t|do\s+not)" + SAME_CLAUSE + r"(take\s*away|to\s+go)|(?:not|no)\s+(?:take\s*away|takeout|to\s+go)", value))
    positive_takeaway = bool(re.search(r"打包|外带|带走|take ?away|takeout|to go", value))
    here = bool(re.search(r"堂吃|for here|eat here|dine in", value))
    negative_here = bool(re.search(NEGATIVE_PREFIX + r"堂吃|不\s*在[这这儿里]+吃|not\s+(for\s+|eat\s+|dine\s+)?here|(?:don'?t|do\s+not)" + SAME_CLAUSE + r"eat\s+here", value))
    if negative_takeaway:
        result.changes["takeaway"] = False
    elif positive_takeaway:
        if here and not negative_here and re.search(r"还是|或者| or ", value):
            result.uncertainties.append("ambiguous_takeaway")
        else:
            result.changes["takeaway"] = True
    elif here:
        if negative_here:
            result.uncertainties.append("ambiguous_takeaway")
        else:
            result.changes["takeaway"] = False
    if "takeaway" in result.changes:
        result.evidence["takeaway"] = original

    if result.changes and not modification:
        result.intent = "provide"
    if modification and not result.changes:
        result.uncertainties.append("unclear_modification")
    if repeat_requested and not result.changes and not result.uncertainties:
        result.intent = "repeat"
    return result
