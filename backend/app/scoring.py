"""Lenient rule-based utterance scoring: deductions from 100, never model-assigned.

The content gate (target matched, no negation/conflict) stays authoritative:
a score can never pass an answer the target rules reject. The number is an
internal analysis value; learners only see pass / retry / re-record.

The current ASR returns text only, so pronunciation and tone events are not
produced today. They are accepted from a future audio-assessment provider and
are subject to Rule A (uncertain evidence never costs points).
"""
from __future__ import annotations

import re
from typing import Callable

SCORING_VERSION = "lenient-rules.v1"
THRESHOLD = 75
MINOR_CAP = 15
MIN_CONFIDENCE = 0.6
# MVP parameters, not a calibrated Shanghainese standard.
POINTS = {
    "accepted_variant": 0, "pause_or_repetition": 0, "synonym_substitution": 0,
    "minor_pronunciation": 2, "minor_tone": 3, "omitted_non_key": 5,
    "key_content_error": 10, "severe_pronunciation": 10,
}
PROFILES = {"lenient": 1.0, "standard": 1.5, "strict": 2.0}
PHONETIC = {"minor_pronunciation", "minor_tone", "severe_pronunciation"}
BLOCKING = {"key_content_error", "severe_pronunciation"}
UNSCORABLE = {"unintelligible"}

# Interjections that carry no content; only these are stripped.
FILLERS = r"(?:嗯+|呃+|额+|唔+|欸+|诶+|\b(?:um+|uh+|erm|hmm+)\b)"
# A word restarted after a pause ("两，两份", "我要 我要").
REPEAT = r"(\S{1,4}?)(?:[，,、…\s]+\1)+"
HOMOPHONE_QUANTITY = r"(?:\d+|[零一二两三四五六七八九十]+)\s*分(?=$|[。.!！?？，,\s]|小笼|谢谢)"

REASON_EVENTS = {
    "target_mismatch": "key_content_error", "not_understood": "key_content_error",
    "ambiguous_expression": "key_content_error", "task_mismatch": "key_content_error",
    "item_mismatch": "key_content_error", "quantity_mismatch": "key_content_error",
    "mode_mismatch": "key_content_error", "unit_mismatch": "key_content_error",
    "confirmation_mismatch": "key_content_error",
}


def normalize(text: str) -> str:
    """Remove fillers and restarted words; never touches negation or numbers."""
    cleaned = re.sub(FILLERS, " ", text, flags=re.I)
    cleaned = re.sub(r"^[\s，,、。.…]+", "", cleaned)
    previous = None
    while previous != cleaned:
        previous, cleaned = cleaned, re.sub(REPEAT, r"\1", cleaned)
    return re.sub(r"\s{2,}", " ", cleaned).strip()


def score(events: list[dict], profile: str = "lenient", threshold: int = THRESHOLD) -> dict:
    """Apply Rules A (uncertain → 0), B (one span, one deduction), C (minor cap)."""
    if any(event["type"] in UNSCORABLE for event in events):
        return {"version": SCORING_VERSION, "profile": profile, "threshold": threshold, "score": None,
                "verdict": "rerecord", "deductions": [], "capped": False}
    multiplier = PROFILES[profile]
    by_span: dict[str, dict] = {}
    for index, event in enumerate(events):
        points = round(POINTS[event["type"]] * multiplier, 1)
        uncertain = event.get("uncertain") or event.get("confidence", 1.0) < MIN_CONFIDENCE
        if event["type"] in PHONETIC and uncertain:
            points = 0
        entry = {"type": event["type"], "points": points, "span": event.get("span"), "uncertain": bool(uncertain)}
        key = event.get("span") or f"#{index}"
        if key not in by_span or points > by_span[key]["points"]:
            by_span[key] = entry
    deductions = list(by_span.values())
    blocking = any(d["type"] in BLOCKING and d["points"] > 0 for d in deductions)
    total = sum(d["points"] for d in deductions)
    capped = not blocking and total > MINOR_CAP
    if capped:
        total = MINOR_CAP
    value = max(0, round(100 - total))
    verdict = "pass" if not blocking and value >= threshold else "retry"
    return {"version": SCORING_VERSION, "profile": profile, "threshold": threshold, "score": value,
            "verdict": verdict, "deductions": deductions, "capped": capped}


def unscored(status: str) -> dict:
    """No speech or a technical failure: no score, ask for another recording."""
    return {"version": SCORING_VERSION, "profile": "lenient", "threshold": THRESHOLD, "score": None,
            "verdict": "rerecord" if status == "unrecognized" else "unavailable", "deductions": [], "capped": False}


def assess_lenient(text: str, assess: Callable[[str], tuple[str, str]], step: str | None = None,
                   observations: list[dict] | None = None) -> tuple[str, str, dict]:
    """Run the target rules on the original text, then on a filler-free form.

    `observations` are optional audio-model events (pronunciation/tone); text
    rules alone decide the content gate.
    """
    status, reason = assess(text)
    events: list[dict] = []
    cleaned = normalize(text)
    if cleaned and cleaned != text:
        if status == "incorrect" and assess(cleaned)[0] == "correct":
            status, reason = "correct", "target_matched"
        if status == "correct":
            events.append({"type": "pause_or_repetition", "span": "fillers"})
    if status == "unrecognized":
        return status, reason, unscored(status)
    if status == "correct" and step == "quantity" and re.search(HOMOPHONE_QUANTITY, text):
        events.append({"type": "accepted_variant", "span": "quantity_unit"})
    if status != "correct":
        events.append({"type": REASON_EVENTS.get(reason, "key_content_error"), "span": "target"})
    events += observations or []
    result = score(events)
    # The content gate remains authoritative in both directions.
    if status != "correct":
        result["verdict"] = "retry"
    elif result["verdict"] == "retry":
        status, reason = "incorrect", "pronunciation_unclear"
    return status, reason, result
