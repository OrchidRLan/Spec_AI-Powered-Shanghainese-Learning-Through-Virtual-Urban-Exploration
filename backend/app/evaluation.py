"""Offline ASR comparison: same labeled recordings, same rules, different providers.

Human labels follow the scoring calibration plan: `acceptable` and
`understandable` should pass, `incorrect` should be asked to retry.
"""
from __future__ import annotations

import unicodedata

from . import guided, lessons, scoring

LABELS = {"acceptable": True, "understandable": True, "incorrect": False}
NANXIANG_STEPS = {"item", "quantity", "mode", "confirm"}


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


def validate(items: list[dict]) -> None:
    seen = set()
    for item in items:
        if not isinstance(item.get("id"), str) or item["id"] in seen:
            raise ManifestError("every item needs a unique string id")
        seen.add(item["id"])
        if item.get("label") not in LABELS:
            raise ManifestError(f"{item['id']}: label must be acceptable, understandable or incorrect")
        assessor(item)


def _plain(text: str) -> str:
    return "".join(ch for ch in unicodedata.normalize("NFKC", text).lower()
                   if not unicodedata.category(ch).startswith(("P", "Z", "S")))


def cer(reference: str, hypothesis: str) -> float | None:
    """Character error rate after removing punctuation and spaces."""
    ref, hyp = _plain(reference), _plain(hypothesis)
    if not ref:
        return None
    previous = list(range(len(hyp) + 1))
    for i, r in enumerate(ref, 1):
        current = [i]
        for j, h in enumerate(hyp, 1):
            current.append(min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (r != h)))
        previous = current
    return round(previous[-1] / len(ref), 4)


def judge(item: dict, transcript: str | None, error: str | None = None, observations: list[dict] | None = None) -> dict:
    assess, step = assessor(item)
    expected = LABELS[item["label"]]
    if error is not None:
        status, reason, result = ("unrecognized", error, scoring.unscored("unrecognized")) if error == "no_speech" \
            else ("technical", error, scoring.unscored("technical"))
    else:
        status, reason, result = scoring.assess_lenient(transcript or "", assess, step, observations)
    passed = result["verdict"] == "pass"
    outcome = ("true_pass" if passed else "false_reject") if expected else ("false_accept" if passed else "true_retry")
    if error is not None and error != "no_speech":
        outcome = "technical_failure"
    return {"id": item["id"], "label": item["label"], "transcript": transcript, "status": status, "reason": reason,
            "score": result["score"], "verdict": result["verdict"], "outcome": outcome,
            "deductions": result["deductions"],
            "cer": cer(item["reference"], transcript or "") if item.get("reference") and error is None else None}


def summarize(rows: list[dict]) -> dict:
    counts = {key: sum(row["outcome"] == key for row in rows)
              for key in ("true_pass", "false_reject", "false_accept", "true_retry", "technical_failure")}
    positives = sum(LABELS[row["label"]] for row in rows if row["outcome"] != "technical_failure")
    negatives = sum(not LABELS[row["label"]] for row in rows if row["outcome"] != "technical_failure")
    cers = [row["cer"] for row in rows if row["cer"] is not None]
    latencies = [row["elapsed_ms"] for row in rows if row.get("elapsed_ms") is not None]
    by_label = {}
    for row in rows:
        if row.get("acoustic_similarity") is not None:
            by_label.setdefault(row["label"], []).append(row["acoustic_similarity"])
    acoustic = {label: round(sum(v) / len(v), 4) for label, v in by_label.items()} or None
    return {"items": len(rows), **counts, "mean_acoustic_similarity_by_label": acoustic,
            "false_reject_rate": round(counts["false_reject"] / positives, 4) if positives else None,
            "false_accept_rate": round(counts["false_accept"] / negatives, 4) if negatives else None,
            "mean_cer": round(sum(cers) / len(cers), 4) if cers else None,
            "mean_latency_ms": round(sum(latencies) / len(latencies)) if latencies else None}
