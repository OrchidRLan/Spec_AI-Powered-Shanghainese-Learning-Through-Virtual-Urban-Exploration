#!/usr/bin/env python3
"""Six whole-order confirmation drafts; offline plan/check and bounded, explicit TTS generation."""
import argparse
import asyncio
from copy import deepcopy
from dataclasses import replace
from datetime import datetime, timezone
from decimal import Decimal
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location("speech_review_r1", ROOT / "scripts" / "speech-review.py")
R1 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(R1)
from app.providers import ProviderConfig, ProviderError, QwenTTS, inspect_wav
from app.providers.production import produce_review_audio, review_audio_cached, review_audio_id, review_draft_text, review_input_sha256

VERSION = "nanxiang-confirmations-r4.2026-10-17.v1"
PACK_PATH = "content/nanxiang-confirmations-r4.json"
SOURCE_PATH = "content/versions/batch-a-r2.2026-10-17.v1.json"
SOURCE_SHA256 = "ac3f1985e6c8aa784cd08d85b96b9c27a604eb7a55661830d64d55650a9c7240"
MANIFEST = ROOT / "content" / "audio-review-r4.json"
OUTPUT = ROOT / "frontend" / "public" / "audio" / "review-r4"
CACHE = ROOT / "artifacts" / "audio" / "review-r4"
MAX_REQUESTS = 6
BUDGET_CNY = Decimal("1.00")
RATE = Decimal("0.8") / 10000
PRICE_SOURCE = R1.PRICE_SOURCE
NEW_TEXTS = {f"NX-CONFIRM-{n}-{mode}": f"{number}份小笼馒头，{dining}，对伐？"
             for n, number in ((1, "一"), (2, "两"), (3, "三"))
             for mode, dining in (("HERE", "堂吃"), ("GO", "打包带走"))}


def load_pack(value: str) -> dict:
    path = (ROOT / value).resolve()
    if not path.is_relative_to(ROOT / "content"):
        raise ProviderError("content_path_required")
    pack = json.loads(path.read_text(encoding="utf-8"))
    if pack.get("contentVersion") != VERSION:
        raise ProviderError("review_pack_version_mismatch")
    return pack


def selection(pack: dict) -> list[str]:
    # Existing R2/R3 teaching entries have identical wording/readings. The R2
    # snapshot is immutable and makes this new supplement independently auditable.
    source_path = ROOT / SOURCE_PATH
    if hashlib.sha256(source_path.read_bytes()).hexdigest() != SOURCE_SHA256:
        raise ProviderError("review_source_content_changed")
    source = json.loads(source_path.read_text())
    sources = {e["id"]: e for group in ("expressions", "dialogues", "supportTerms") for e in source[group]}
    if (pack.get("sourceContentPath") != SOURCE_PATH or pack.get("sourceContentVersion") != source["contentVersion"]
            or pack.get("appliesToContentVersions") != ["batch-a-r3.2026-10-17.v1"]
            or pack.get("status") != "draft" or pack.get("reviewStatus") != "pending"):
        raise ProviderError("review_pack_metadata_mismatch")
    ids = R1.selection(pack, None)
    if len(ids) != 6 or set(ids) != set(NEW_TEXTS):
        raise ProviderError("invalid_text_selection")
    for text_id in ids:
        entry = review_draft_text(pack, text_id)
        quantity = int(text_id.split("-")[2])
        takeaway = text_id.endswith("-GO")
        source_ids = [f"NX-Q{quantity}", "NX-ITEM-XLB", "E09" if takeaway else "NX-MODE-HERE", "NX-N09"]
        expected_segments = []
        for source_id in source_ids:
            original = sources[source_id]
            for index, segment in enumerate(original["segments"]):
                segment = deepcopy(segment)
                segment["id"] = f"{text_id}-S{len(expected_segments) + 1:02}"
                if source_id in ("NX-ITEM-XLB", "E09", "NX-MODE-HERE") and index == len(original["segments"]) - 1:
                    segment["hanzi"] += "，"
                expected_segments.append(segment)
        if (entry["hanzi"] != NEW_TEXTS[text_id] or entry["version"] != VERSION
                or entry.get("order") != {"item": "xiaolongbao", "normalized_servings": quantity, "takeaway": takeaway}
                or entry.get("audio", {}).get("normal") != f"{text_id}.normal"
                or entry.get("segments") != expected_segments
                or entry.get("pronunciation") != " / ".join(s["pronunciation"] for s in expected_segments)
                or entry.get("sourceEntries") != [{"id": sid, "version": sources[sid]["version"]} for sid in source_ids]):
            raise ProviderError("review_new_text_not_authorized")
        if (entry.get("textKind") != "shanghainese-candidate" or entry.get("review") != {
                "status": "draft", "language": "pending", "pronunciation": "pending",
                "approximation": "pending", "audio": "pending", "recordIds": []}):
            raise ProviderError("review_status_mismatch")
    return ids


def reservations() -> tuple[int, Decimal]:
    attempts = list(CACHE.glob("*.attempt.json"))
    total = Decimal(0)
    for path in attempts:
        attempt = json.loads(path.read_text())
        reserved = attempt.get("reservedCharacters", attempt["characters"] * 4)
        record = path.with_name(path.name.removesuffix(".attempt.json") + ".json")
        if record.exists():
            usage = json.loads(record.read_text()).get("usage", {}).get("characters")
            if type(usage) is int and usage >= 0:
                reserved = usage
        if type(reserved) is not int or reserved < 0:
            raise ProviderError("invalid_local_input")
        total += Decimal(reserved) * RATE
    return len(attempts), total


def plan(pack: dict, provider: QwenTTS, max_calls: int = MAX_REQUESTS,
         max_cost_cny: Decimal = BUDGET_CNY) -> dict:
    if type(max_calls) is not int or not 0 < max_calls <= MAX_REQUESTS:
        raise ProviderError("review_request_limit_exceeded")
    if not max_cost_cny.is_finite() or not 0 < max_cost_cny <= BUDGET_CNY:
        raise ProviderError("review_budget_exceeded")
    config = provider.config
    if config.region != "beijing" or config.model != "qwen3-tts-flash" or config.voice != "Jada":
        raise ProviderError("review_generation_config_mismatch")
    ids = selection(pack)
    pending, cached = {}, []
    for text_id in ids:
        entry = review_draft_text(pack, text_id)
        identity = review_audio_id(entry, config)
        if review_audio_cached(entry, provider, CACHE):
            cached.append(text_id)
        elif (CACHE / f"{identity}.attempt.json").exists():
            raise ProviderError("review_generation_needs_attention")
        else:
            pending[identity] = entry
    attempts, reserved = reservations()
    reserved_characters = sum(len(entry["hanzi"].encode("utf-8")) for entry in pending.values())
    estimate = reserved_characters * RATE
    if attempts + len(pending) > max_calls:
        raise ProviderError("review_request_limit_exceeded")
    if reserved + estimate > max_cost_cny:
        raise ProviderError("review_budget_exceeded")
    return {"purpose": "review-draft", "version": VERSION, "inputSha256": review_input_sha256(pack, ids),
            "sourceContentSha256": SOURCE_SHA256, "productionApprovalSha256": R1.production_state_sha256(pack),
            "texts": len(ids), "cachedR4TextIds": cached, "pendingApiRequests": len(pending),
            "pendingTexts": [{"textId": e["id"], "text": e["hanzi"]} for e in pending.values()],
            "pendingCharacters": sum(len(e["hanzi"]) for e in pending.values()),
            "pendingReservedCharacters": reserved_characters, "estimatedNewCostCny": float(estimate),
            "previousReservedCostCny": float(reserved), "previousAttempts": attempts,
            "maxApiRequests": max_calls, "budgetCny": float(max_cost_cny), "priceSource": PRICE_SOURCE,
            "region": config.region, "model": config.model, "voice": config.voice,
            "credentialConfigured": bool(config.api_key), "reviewStatus": "pending", "networkCalls": 0}


def check_clip(entry: dict, clip: dict) -> None:
    if (clip.get("id") != entry["audio"]["normal"] or clip.get("textId") != entry["id"]
            or clip.get("textVersion") != entry["version"] or clip.get("text") != entry["hanzi"]
            or clip.get("textSha256") != hashlib.sha256(entry["hanzi"].encode()).hexdigest()
            or clip.get("pronunciation") != entry.get("pronunciation") or clip.get("pronunciationVersion") != entry["version"]):
        raise ProviderError("review_text_mismatch")
    if (clip.get("status") != "generated" or clip.get("reviewStatus") != "pending"
            or clip.get("purpose") != "review-draft" or clip.get("speed") != "normal"
            or clip.get("reviewIds") != [] or clip.get("listeningReview") != "pending"):
        raise ProviderError("review_status_mismatch")
    identity = review_audio_id(entry, SimpleNamespace(config_id=clip.get("configId")))
    if (clip.get("generationId") != identity or clip.get("file") != f"/audio/review-r4/{identity}.wav"
            or not re.fullmatch(r"[a-f0-9]{64}", clip.get("sha256", ""))):
        raise ProviderError("review_asset_path_mismatch")
    generation = clip.get("generationConfig", {})
    if (clip.get("model") != "qwen3-tts-flash" or clip.get("voice") != "Jada" or clip.get("targetLanguage") != "wuu"
            or clip.get("providerLanguageParameter") != "Chinese" or generation.get("config_id") != clip.get("configId")
            or generation.get("model") != clip.get("model") or generation.get("voice") != clip.get("voice")
            or generation.get("service") != "tts" or generation.get("deployment") != "hosted-api"
            or generation.get("region") != "beijing"):
        raise ProviderError("review_generation_config_mismatch")
    path = OUTPUT / f"{identity}.wav"
    if path.is_symlink() or not path.resolve().is_relative_to(OUTPUT.resolve()):
        raise ProviderError("review_asset_path_mismatch")
    audio = path.read_bytes()
    if hashlib.sha256(audio).hexdigest() != clip["sha256"]:
        raise ProviderError("review_asset_mismatch")
    measured = inspect_wav(audio, max_bytes=15 * 1024 * 1024, max_seconds=180)
    if any(clip.get(key) != measured[key] for key in ("durationMs", "sampleRate", "channels", "format")):
        raise ProviderError("review_audio_metadata_mismatch")
    if not isinstance(clip.get("generatedAt"), str) or not clip.get("upstreamRequestId"):
        raise ProviderError("review_generation_metadata_missing")


def check_manifest(pack: dict) -> dict:
    ids = selection(pack)
    manifest = json.loads(MANIFEST.read_text())
    clips = manifest.get("clips", [])
    if (manifest.get("schemaVersion") != 1 or manifest.get("version") != VERSION
            or manifest.get("purpose") != "review-draft" or manifest.get("reviewStatus") != "pending"
            or len(clips) != len(ids) or {c.get("textId") for c in clips} != set(ids)
            or len({c.get("id") for c in clips}) != len(clips)
            or len({c.get("file") for c in clips}) != len(clips)):
        raise ProviderError("review_manifest_incomplete")
    if manifest.get("sourceInputSha256") != review_input_sha256(pack, ids):
        raise ProviderError("review_input_changed")
    if manifest.get("sourceContentSha256") != SOURCE_SHA256:
        raise ProviderError("review_source_content_changed")
    if manifest.get("productionApprovalSha256") != R1.production_state_sha256(pack):
        raise ProviderError("production_approval_state_changed")
    for clip in clips:
        check_clip(review_draft_text(pack, clip["textId"]), clip)
    return {"status": "passed", "clips": len(clips), "generatedForR4": len(clips), "reviewStatus": "pending",
            "totalDurationMs": sum(c["durationMs"] for c in clips), "uniqueAudioFiles": len(clips),
            "wholeSentenceAssets": True, "productionApprovalUnchanged": True, "networkCalls": 0}


def write_manifest(value: dict) -> None:
    temporary = MANIFEST.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, MANIFEST)


async def generate(args) -> dict:
    pack = load_pack(args.pack)
    if args.command == "check":
        return check_manifest(pack)
    provider = QwenTTS(ProviderConfig.from_env("tts"))
    preview = plan(pack, provider, args.max_calls, args.max_cost_cny)
    if args.command == "plan":
        return preview
    if not args.allow_paid_call:
        raise ProviderError("explicit_paid_call_flag_required")
    if args.expect_input_sha256 != preview["inputSha256"]:
        raise ProviderError("review_input_changed")
    provider = QwenTTS(replace(provider.config, live_enabled=True))
    provider.config.require_enabled()
    CACHE.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock = CACHE / "batch.lock"
    try:
        fd = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        raise ProviderError("generation_in_progress") from None
    os.close(fd)
    try:
        completed, generated_count = [], 0
        manifest = {"schemaVersion": 1, "version": VERSION, "purpose": "review-draft", "reviewStatus": "pending",
                    "sourceInputSha256": preview["inputSha256"], "sourceContentSha256": SOURCE_SHA256,
                    "productionApprovalSha256": preview["productionApprovalSha256"], "priceSource": PRICE_SOURCE,
                    "priceVerifiedAt": "2026-10-17", "budgetCny": float(args.max_cost_cny),
                    "maxApiRequests": args.max_calls, "clips": completed}
        for text_id in selection(pack):
            current = plan(load_pack(args.pack), provider, args.max_calls, args.max_cost_cny)
            if any(current[key] != preview[key] for key in ("inputSha256", "sourceContentSha256", "productionApprovalSha256")):
                raise ProviderError("review_input_changed")
            entry = review_draft_text(pack, text_id)
            clip = await produce_review_audio(pack, text_id, provider, OUTPUT, CACHE)
            clip["file"] = f"/audio/review-r4/{clip['generationId']}.wav"
            count = clip.get("usage", {}).get("characters")
            clip["estimatedCostCny"] = float(count * RATE) if type(count) is int else None
            clip["priceSource"] = PRICE_SOURCE
            generated_count += int(not clip["reused"])
            check_clip(entry, clip)
            completed.append(clip)
            manifest["usageSummary"] = R1.usage_summary(completed, RATE)
            manifest["updatedAt"] = datetime.now(timezone.utc).isoformat()
            write_manifest(manifest)
            print(json.dumps({"textId": text_id, "status": "generated", "reviewStatus": "pending",
                              "durationMs": clip["durationMs"], "reused": clip["reused"]}), flush=True)
        checked = check_manifest(load_pack(args.pack))
        checked.pop("networkCalls")
        return {"manifest": "content/audio-review-r4.json", **checked, "newApiRequests": generated_count,
                "slowSpeed": "playback_rate_0.75_preserves_pitch", **manifest["usageSummary"]}
    finally:
        lock.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for command in ("plan", "generate", "check"):
        sub = commands.add_parser(command)
        sub.add_argument("--pack", default=PACK_PATH)
        if command != "check":
            sub.add_argument("--max-calls", type=int, default=MAX_REQUESTS)
            sub.add_argument("--max-cost-cny", type=Decimal, default=BUDGET_CNY)
        if command == "generate":
            sub.add_argument("--expect-input-sha256", required=True)
            sub.add_argument("--allow-paid-call", action="store_true")
    try:
        print(json.dumps(asyncio.run(generate(parser.parse_args())), ensure_ascii=False, indent=2))
        return 0
    except ProviderError as error:
        print(json.dumps({"status": "stopped", "error": error.public_dict()}, ensure_ascii=False))
        return 2
    except (OSError, ValueError, KeyError, TypeError):
        print(json.dumps({"status": "stopped", "error": {"code": "invalid_local_input", "retryable": False}}))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
