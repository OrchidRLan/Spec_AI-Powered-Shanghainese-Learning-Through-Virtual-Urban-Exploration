"""Offline ASR comparison: same labeled recordings, same rules, different providers.

Human labels follow the scoring calibration plan: `acceptable` and
`understandable` should pass, `incorrect` should be asked to retry.

`reference` is what the speaker actually said (reviewed by a fluent speaker),
not the expected answer. Judging the reference with the same rules gives the
"perfect ASR" verdict, which separates ASR errors from rule errors.
"""
from __future__ import annotations

import math
import re
import unicodedata

from . import guided, lessons, scoring

LABELS = {"acceptable": True, "understandable": True, "incorrect": False}
NANXIANG_STEPS = {"item", "quantity", "mode", "confirm"}
SPEAKER_GROUPS = {"fluent", "heritage", "beginner", "synthetic"}
SOURCES = {"human", "synthetic"}
SPLITS = {"dev", "test"}
# What the recording was designed to exercise. The pass/fail expectation is the
# separate `label`, assigned by a fluent reviewer after listening.
CONDITIONS = {"canonical", "nonstandard", "wrong_target", "wrong_quantity", "wrong_unit", "negation",
              "missing_field", "filler_pause", "self_correction", "silence", "noise"}
SPEAKER_ID = re.compile(r"^[A-Z]{1,3}\d{2,3}$")  # anonymous IDs such as S01, never names
NORMALIZATION_VERSION = "cer-norm.v1"
# cer-norm.v1: NFKC, lowercase, drop punctuation/space/symbols, map the
# traditional forms that occur in the current content and rules to simplified.
# Wu vs Mandarin word choices (侬/你, 勿/不, 个/的) are NOT merged: they count as
# character errors and are analysed through the task verdict instead.
_ORTHOGRAPHY = str.maketrans("魚雞斬謝個儂飯點喫們這麼說話吳滬兩氣歡圍餛飩邊來還與買賣蔥", "鱼鸡斩谢个侬饭点吃们这么说话吴沪两气欢围馄饨边来还与买卖葱")
OUTCOMES = ("true_pass", "false_reject", "false_accept", "true_retry", "technical_failure")


class ManifestError(ValueError):
    pass


def assessor(item: dict):
    """Return (assess(text) -> (status, reason), step) for one manifest item."""
    station, step, target = item.get("station"), item.get("step"), item.get("target")
    if station == "nanxiang":
        if step not in NANXIANG_STEPS:
            raise ManifestError(f"{item.get('id')}: unknown Nanxiang step")
        try:
            practice = {"step": step, "target": guided.target_for(step, target or {"type": "confirm"})}
        except guided.PracticeError:
            raise ManifestError(f"{item.get('id')}: invalid Nanxiang target") from None
        return (lambda text: guided.assess(text, practice)), step
    if station not in lessons.STEPS or step not in lessons.STEPS[station]:
        raise ManifestError(f"{item.get('id')}: unknown station or step")
    target = target or ("confirm" if step == "confirm" else None)
    if target not in lessons.OPTIONS[step]:
        raise ManifestError(f"{item.get('id')}: invalid target for {station}/{step}")
    attempt = {"station_id": station, "lesson": {"step": step, "target": target}}
    if station == "candy":
        attempt["_lesson_target"] = item.get("candy_flavor", target if step == "flavor" else "rose")
    return (lambda text: lessons.assess(text, attempt)), step


def _check_enum(item: dict, field: str, allowed: set) -> None:
    if field in item and item[field] not in allowed:
        raise ManifestError(f"{item['id']}: {field} must be one of {sorted(allowed)}")


def validate(items: list[dict]) -> list[str]:
    """Raise on invalid items; return warnings that do not block a run."""
    seen, group_split, speaker_splits, warnings = set(), {}, {}, []
    for item in items:
        if not isinstance(item.get("id"), str) or item["id"] in seen:
            raise ManifestError("every item needs a unique string id")
        seen.add(item["id"])
        if item.get("label") not in LABELS:
            raise ManifestError(f"{item['id']}: label must be acceptable, understandable or incorrect")
        for field, allowed in (("speaker_group", SPEAKER_GROUPS), ("source", SOURCES), ("split", SPLITS),
                               ("condition", CONDITIONS)):
            _check_enum(item, field, allowed)
        if "speaker_id" in item and not SPEAKER_ID.match(str(item["speaker_id"])):
            raise ManifestError(f"{item['id']}: speaker_id must be an anonymous code such as S01")
        if (item.get("source") == "synthetic") != (item.get("speaker_group") == "synthetic") \
                and "source" in item and "speaker_group" in item:
            raise ManifestError(f"{item['id']}: synthetic audio must use speaker_group synthetic, and only it")
        # Repeated takes of one utterance must never straddle dev and test.
        if item.get("utterance_group") and item.get("split"):
            previous = group_split.setdefault(item["utterance_group"], item["split"])
            if previous != item["split"]:
                raise ManifestError(f"{item['id']}: utterance_group {item['utterance_group']} is in both dev and test")
        if item.get("speaker_id") and item.get("split"):
            speaker_splits.setdefault(item["speaker_id"], set()).add(item["split"])
        assessor(item)
    warnings += [f"speaker {s} appears in both dev and test" for s, v in sorted(speaker_splits.items()) if len(v) > 1]
    return warnings


def _plain(text: str) -> str:
    text = unicodedata.normalize("NFKC", text).lower().translate(_ORTHOGRAPHY)
    return "".join(ch for ch in text if not unicodedata.category(ch).startswith(("P", "Z", "S")))


def edits(reference: str, hypothesis: str) -> tuple[int, int]:
    """(character edit distance, reference length) after cer-norm.v1."""
    ref, hyp = _plain(reference), _plain(hypothesis)
    previous = list(range(len(hyp) + 1))
    for i, r in enumerate(ref, 1):
        current = [i]
        for j, h in enumerate(hyp, 1):
            current.append(min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (r != h)))
        previous = current
    return previous[-1], len(ref)


def cer(reference: str, hypothesis: str) -> float | None:
    """Per-item character error rate after cer-norm.v1."""
    distance, length = edits(reference, hypothesis)
    return round(distance / length, 4) if length else None


def _verdict(transcript: str, assess, step: str, observations=None) -> tuple[str, str, dict]:
    return scoring.assess_lenient(transcript or "", assess, step, observations)


def attribution(expected: bool, asr_pass: bool | None, reference_pass: bool | None) -> str | None:
    """Where a wrong decision came from, using the reference as perfect ASR."""
    if asr_pass is None or reference_pass is None:
        return None
    if asr_pass == expected:
        return "ok" if reference_pass == expected else "ok_despite_rule_error"
    return "asr_error" if reference_pass == expected else "rule_error"


def judge(item: dict, transcript: str | None, error: str | None = None, observations: list[dict] | None = None) -> dict:
    assess, step = assessor(item)
    expected = LABELS[item["label"]]
    if error is not None:
        status, reason, result = ("unrecognized", error, scoring.unscored("unrecognized")) if error == "no_speech" \
            else ("technical", error, scoring.unscored("technical"))
    else:
        status, reason, result = _verdict(transcript, assess, step, observations)
    passed = result["verdict"] == "pass"
    outcome = ("true_pass" if passed else "false_reject") if expected else ("false_accept" if passed else "true_retry")
    technical = error is not None and error != "no_speech"
    if technical:
        outcome = "technical_failure"
    reference = item.get("reference")
    reference_pass = None
    if reference is not None:
        reference_pass = _verdict(reference, assess, step)[2]["verdict"] == "pass"
    distance, length = edits(reference, transcript or "") if reference and error is None else (None, None)
    return {"id": item["id"], "label": item["label"], "station": item["station"], "step": step,
            "speaker_id": item.get("speaker_id"), "speaker_group": item.get("speaker_group"),
            "source": item.get("source"), "split": item.get("split"), "condition": item.get("condition"),
            "reference": reference, "transcript": transcript, "status": status, "reason": reason,
            "score": result["score"], "verdict": result["verdict"], "outcome": outcome,
            "deductions": result["deductions"],
            "reference_verdict": None if reference_pass is None else ("pass" if reference_pass else "retry"),
            "attribution": None if technical else attribution(expected, passed, reference_pass),
            "cer": round(distance / length, 4) if length else None,
            "cer_edits": distance if length else None, "cer_ref_chars": length or None}


def _percentile(values: list[float], q: float) -> float | None:
    """Nearest-rank percentile; with few items p95 is simply the slowest."""
    if not values:
        return None
    ordered = sorted(values)
    return ordered[max(0, math.ceil(q * len(ordered)) - 1)]


def _median(values: list[float]) -> float | None:
    if not values:
        return None
    ordered, mid = sorted(values), len(values) // 2
    return ordered[mid] if len(ordered) % 2 else (ordered[mid - 1] + ordered[mid]) / 2


def summarize(rows: list[dict], breakdown: bool = True) -> dict:
    counts = {key: sum(row["outcome"] == key for row in rows) for key in OUTCOMES}
    scored = [row for row in rows if row["outcome"] != "technical_failure"]
    positives = sum(LABELS[row["label"]] for row in scored)
    negatives = len(scored) - positives
    measured = [row for row in rows if row.get("cer") is not None]
    ref_chars = sum(row.get("cer_ref_chars") or 0 for row in measured)
    latencies = [row["elapsed_ms"] for row in rows if row.get("elapsed_ms") is not None]
    by_label = {}
    for row in rows:
        if row.get("acoustic_similarity") is not None:
            by_label.setdefault(row["label"], []).append(row["acoustic_similarity"])
    acoustic = {label: round(sum(v) / len(v), 4) for label, v in by_label.items()} or None
    failures = {}
    for row in rows:
        if row["outcome"] == "technical_failure":
            failures[row["reason"]] = failures.get(row["reason"], 0) + 1
    attributed = {}
    for row in rows:
        if row.get("attribution"):
            attributed[row["attribution"]] = attributed.get(row["attribution"], 0) + 1
    summary = {"items": len(rows), **counts, "mean_acoustic_similarity_by_label": acoustic,
               "acceptable_or_understandable_n": positives, "incorrect_n": negatives,
               "false_reject_rate": round(counts["false_reject"] / positives, 4) if positives else None,
               "false_accept_rate": round(counts["false_accept"] / negatives, 4) if negatives else None,
               "technical_failure_rate": round(counts["technical_failure"] / len(rows), 4) if rows else None,
               "technical_failure_reasons": failures or None,
               "cer_items": len(measured), "cer_normalization": NORMALIZATION_VERSION,
               "mean_cer": round(sum(row["cer"] for row in measured) / len(measured), 4) if measured else None,
               "corpus_cer": round(sum(row["cer_edits"] for row in measured) / ref_chars, 4) if ref_chars else None,
               "latency_items": len(latencies),
               "median_latency_ms": round(_median(latencies)) if latencies else None,
               "p95_latency_ms": round(_percentile(latencies, 0.95)) if latencies else None,
               "mean_latency_ms": round(sum(latencies) / len(latencies)) if latencies else None,
               "attribution": attributed or None}
    if breakdown:
        for field in ("station", "speaker_group", "condition", "split"):
            groups = {}
            for row in rows:
                if row.get(field) is not None:
                    groups.setdefault(row[field], []).append(row)
            if groups:
                keep = ("items", "false_reject", "false_accept", "technical_failure", "acceptable_or_understandable_n",
                        "incorrect_n", "false_reject_rate", "false_accept_rate", "corpus_cer")
                summary[f"by_{field}"] = {key: {k: v for k, v in summarize(group, False).items() if k in keep}
                                          for key, group in sorted(groups.items())}
    return summary
