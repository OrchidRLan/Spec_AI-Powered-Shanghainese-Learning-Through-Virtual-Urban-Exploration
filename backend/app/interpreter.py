"""Explicitly labelled, conservative development parser; this is not an LLM.

Limited Chinese / English phrases let developers exercise the real rule / save
path before a configured interpretation provider is available. Unsupported
syntax is kept as the learner's text, never promoted to teaching content.
"""
from __future__ import annotations

import re
from .models import Interpretation

PARSER_VERSION = "development-parser.v3"
ITEM_PATTERN = r"(?:小笼(?:包|馒头)?|\bxiao\s*long\s*bao\b|\bsoup\s+dumplings?\b)"
NEGATIVE_PREFIX = r"(?:(?:不|勿)\s*(?:是|要|想(?:\s*(?:要|吃))?|用|需要)?|覅)\s*"
SAME_CLAUSE = r"[^，,。.!！?？;；\n]*"
NUMBERS = {"一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5,
           "六": 6, "七": 7, "八": 8, "九": 9, "十": 10,
           "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6,
           "seven": 7, "eight": 8, "nine": 9, "ten": 10, "eleven": 11,
           "twelve": 12, "thirteen": 13, "fourteen": 14, "fifteen": 15,
           "sixteen": 16, "seventeen": 17, "eighteen": 18, "nineteen": 19, "twenty": 20}
ENGLISH_NUMBERS = r"twenty(?:[ -]+(?:one|two|three|four|five|six|seven|eight|nine))?|" + "|".join(key for key in NUMBERS if key.isascii() and key != "twenty")
NUMBER_PATTERN = rf"(?:\d+|[零一二两三四五六七八九十百千万]+|\b(?:{ENGLISH_NUMBERS})\b)"
QUANTITY = re.compile(rf"(?P<n>{NUMBER_PATTERN})\s*(?P<u>servings?|baskets?|dumplings?|份|笼|只|个)?", re.I)
TAKEAWAY = r"(?:打包|外带|带走|take\s*away|takeout|to\s+go)"
HERE = r"(?:堂吃|堂食|(?:在)?(?:这里|这儿|店里)吃|for\s+here|eat\s+here|dine[ -]+in)"
MODE = re.compile(rf"(?P<takeaway>{TAKEAWAY})|(?P<here>{HERE})", re.I)
ENGLISH_NEGATION = r"(?:not|no|(?:don'?t|do\s+not)(?:\s+want)?(?:\s+to)?)\s*"
UNIT_PATTERN = r"(?:servings?|baskets?|dumplings?|份|笼|只|个)"


def number_value(number: str) -> int | None:
    if number.isdigit():
        return int(number)
    if number in NUMBERS:
        return NUMBERS[number]
    if re.fullmatch(r"twenty[ -]+(?:one|two|three|four|five|six|seven|eight|nine)", number):
        return 20 + NUMBERS[re.split(r"[ -]+", number)[-1]]
    # Chinese 11–99 are unambiguous; approximate 一两 / 两三 are not numbers.
    if re.fullmatch(r"[一二三四五六七八九]?十[一二三四五六七八九]?", number):
        tens, ones = number.split("十")
        return NUMBERS.get(tens, 1) * 10 + NUMBERS.get(ones, 0)
    return None


def quantity_reply(value: str, attempt: dict) -> bool:
    """Only the explicit servings question supplies an omitted serving unit."""
    if attempt["prompt_id"] != "NX-N02":
        return False
    return bool(re.fullmatch(
        rf"(?:(?:嗯|呃|哦|好|好的|请|麻烦侬|麻烦你|please)[，,\s]*)*"
        rf"(?:(?:我(?:想要|要)|要|来|给我|请给我|就|i\s+(?:want|would\s+like)|can\s+i\s+have|give\s+me)\s*)?"
        rf"{NUMBER_PATTERN}(?:[，,\s]*(?:啊|呀|吧|呢|哦|就行|就可以了|好了|谢谢|please|thanks|thank\s+you))*", value))


def dining_change(value: str) -> tuple[bool | None, bool]:
    """Resolve explicit modes and bounded corrections, preserving contradictions."""
    mentions = list(MODE.finditer(value))
    if not mentions:
        return None, False
    if len(mentions) > 1 and re.search(r"还是|或者|\bor\b", value[mentions[0].end():mentions[-1].start()]):
        return None, True
    classified = []
    for index, match in enumerate(mentions):
        previous_end = mentions[index - 1].end() if index else 0
        next_start = mentions[index + 1].start() if index + 1 < len(mentions) else len(value)
        prefix = re.split(r"[，,。.!！?？;；\n]", value[previous_end:match.start()])[-1]
        suffix = value[match.end():next_start]
        negative = bool(re.search(rf"(?:{NEGATIVE_PREFIX}|{ENGLISH_NEGATION})$", prefix)
                        or re.match(r"\s*(?:(?:都|也)\s*)?(?:不\s*要|勿\s*要|取消)", suffix))
        mode = bool(match.group("takeaway"))
        # 打包带走 is one synonymous phrase: the second word cannot erase
        # the negation applying to its first word.
        if (classified and classified[-1][1] == mode and classified[-1][2]
                and re.fullmatch(r"\s*(?:和|及|and)?\s*", value[previous_end:match.start()])):
            negative = True
        classified.append((index, mode, negative))
    if len(mentions) > 1 and re.search(r"(?:都|也)\s*(?:不\s*要|勿\s*要)[。.!！?？\s]*$", value):
        return None, True
    positives = [(index, mode) for index, mode, negative in classified if not negative]
    negatives = [(index, mode) for index, mode, negative in classified if negative]
    if positives:
        # An explicit final correction may replace an earlier choice. Otherwise
        # contradictory positive modes need clarification, even without 'or'.
        if len({mode for _, mode in positives}) > 1:
            last_index, last_mode = positives[-1]
            previous_index = positives[-2][0]
            between = value[mentions[previous_index].end():mentions[last_index].start()]
            if re.search(r"改|换|不[，,]|instead|actually", between):
                return last_mode, False
            return None, True
        last_positive_index, chosen_mode = positives[-1]
        same_mode_refusals = [index for index, mode in negatives if mode == chosen_mode]
        if same_mode_refusals and same_mode_refusals[-1] < last_positive_index:
            between = value[mentions[same_mode_refusals[-1]].end():mentions[last_positive_index].start()]
            if not re.search(r"改|换|instead|actually", between):
                return None, True
        if negatives and last_positive_index < classified[-1][0]:
            # A later refusal cannot be silently ignored in favor of old words.
            if classified[-1][1] == chosen_mode:
                return (False, False) if chosen_mode else (None, True)
        return chosen_mode, False
    if {mode for _, mode in negatives} == {True}:
        return False, False  # Explicitly declining takeaway selects dine-in.
    return None, True


def parse_development(text: str, attempt: dict) -> Interpretation:
    original = text.strip()
    value = original.lower().strip("。.!！?？ ")
    result = Interpretation(model_config_id=PARSER_VERSION)
    if re.fullmatch(r"(?:(?:嗯|哦|好|yes)[，,\s]+)*(对[的个]?|是[的个]|确认|确认订单|没错|好[的个]?|可以|yes|yes,? (that'?s )?right|correct|confirm|that'?s right)(?:[，,\s]*(?:啊|呀|嗯|谢谢|thanks|thank you|please))*", value):
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
        contextual_quantity = quantity_reply(value, attempt)
        matches = [m for m in QUANTITY.finditer(value)
                   if m.group("u") or value.strip() == m.group("n")
                   or contextual_quantity
                   or re.search(r"(?:我要|要|来|want|order|would\s+like|have)\s*$", value[:m.start()])]
        invalid_numeric_form = bool(re.search(r"[+\-−]\s*\d|\d+[.,/]\d+|\d+\s*[/~～–—至到]\s*\d+|[零一二两三四五六七八九十]+点|负[零一二两三四五六七八九十\d]|[份笼只个]半|半[份笼只个]", value)
                                    or re.search(rf"{NUMBER_PATTERN}\s*{UNIT_PATTERN}?\s*(?:or|and|to|还是|或者|或|到|至|[-~～–—/])\s*{NUMBER_PATTERN}", value)
                                    or re.search(r"\b(?:zero|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|half|quarter|point)\b", value))
        if invalid_numeric_form:
            matches = []
            result.uncertainties.append("ambiguous_quantity")
        # Bare numbers only inherit the unit when the immediately displayed
        # question explicitly asked how many servings. 个 is never a serving.
        selected = None
        if matches:
            ambiguous = len(matches) > 1 and not re.search(
                r"改|不[，,]|instead|actually", value[matches[-2].end():matches[-1].start()])
            if ambiguous:
                result.uncertainties.append("ambiguous_quantity")
            else:
                match = matches[-1]
                selected = match
                number = match.group("n").lower()
                quantity = number_value(number)
                if quantity is None:
                    result.uncertainties.append("ambiguous_quantity")
                unit = match.group("u")
                if unit in ("份", "serving", "servings"):
                    unit = "serving"
                elif unit in ("笼", "basket", "baskets"):
                    unit = "basket"
                elif unit in ("只", "dumpling", "dumplings"):
                    unit = "piece"
                elif unit == "个":
                    unit = "unknown"
                elif contextual_quantity:
                    unit = "serving"
                    result.evidence["unit"] = "context:NX-N02 explicitly asked for servings"
                else:
                    unit = "unknown"
                result.changes.update(quantity=quantity, unit=unit)
                result.evidence["quantity"] = match.group(0)
                result.evidence.setdefault("unit", match.group(0))
        if selected and (re.search(rf"(?:{NEGATIVE_PREFIX}|{ENGLISH_NEGATION})$", value[:selected.start()])
                         or re.match(r"\s*(?:都|也)?\s*(?:不\s*要|勿\s*要|取消)", value[selected.end():])):
            # A rejected amount is not a positive replacement amount.
            result.changes.pop("quantity", None)
            result.changes.pop("unit", None)
            result.uncertainties.append("ambiguous_quantity")

    if re.search(ITEM_PATTERN, value):
        if re.search(NEGATIVE_PREFIX + SAME_CLAUSE + ITEM_PATTERN + r"|(?:don'?t|do\s+not)\s+want" + SAME_CLAUSE + ITEM_PATTERN + r"|not\s+(?:the\s+)?" + ITEM_PATTERN, value) or re.search(ITEM_PATTERN + r"\s*(?:都|也)?\s*(?:不要|勿要|取消)", value):
            result.changes["item"] = None
        else:
            result.changes["item"] = "xiaolongbao"
        result.evidence["item"] = original
    elif re.search(r"(要|want|order).*(面条|炒饭|noodles|rice)", value):
        result.changes["item"] = "unsupported"
        result.evidence["item"] = original

    # Do not infer an item solely because only one is on the task menu.
    dining, dining_unclear = dining_change(value)
    if dining_unclear:
        result.uncertainties.append("ambiguous_takeaway")
    elif dining is not None:
        result.changes["takeaway"] = dining
    if "takeaway" in result.changes:
        result.evidence["takeaway"] = original

    if result.changes and not modification:
        result.intent = "provide"
    if modification and not result.changes:
        result.uncertainties.append("unclear_modification")
    if repeat_requested and not result.changes and not result.uncertainties:
        result.intent = "repeat"
    return result
