#!/usr/bin/env python3
"""R1 whole-sentence TTS review previews. This does not approve or publish a production content pack."""
import argparse
import asyncio
from dataclasses import replace
from datetime import datetime, timezone
from decimal import Decimal
import json
import hashlib
import re
from types import SimpleNamespace
import os
from pathlib import Path
import sys

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / ".env", override=False)
sys.path.insert(0, str(ROOT / "backend"))
from app.providers import ProviderConfig, ProviderError, QwenTTS, inspect_wav
from app.providers.production import produce_review_audio, review_audio_cached, review_audio_id, review_draft_text, review_input_sha256

MANIFEST = ROOT / "content" / "audio-review-r1.json"
OUTPUT = ROOT / "frontend" / "public" / "audio" / "review-r1"
CACHE = ROOT / "artifacts" / "audio" / "review-r1"
VERSION = "batch-a-r1.2026-10-17.v1"
BUDGET_CNY = Decimal("1.00")
# Official list prices verified 2026-10-17; these are estimates, not account invoices.
RATES_PER_CHARACTER = {"beijing": Decimal("0.8") / 10000, "singapore": Decimal("0.733924") / 10000}
PRICE_SOURCE = "https://help.aliyun.com/zh/model-studio/qwen3-tts-flash"


def load_pack(value: str) -> dict:
    path = (ROOT / value).resolve()
    if not path.is_relative_to(ROOT / "content"):
        raise ProviderError("content_path_required")
    return json.loads(path.read_text(encoding="utf-8"))


def selection(pack: dict, ids: list[str] | None) -> list[str]:
    selected = ids or [entry["id"] for group in ("expressions", "dialogues", "supportTerms") for entry in pack.get(group, [])]
    if not selected or len(selected) != len(set(selected)):
        raise ProviderError("invalid_text_selection")
    for text_id in selected:
        review_draft_text(pack, text_id)
    return selected


def reserved_cost() -> Decimal:
    # Count even ambiguous failed requests conservatively. Never silently retry them.
    # Beijing is the more expensive supported rate, so mixed-region reservations stay conservative.
    total = Decimal(0)
    for path in CACHE.glob("*.attempt.json"):
        attempt = json.loads(path.read_text())
        # The observed API character count is higher than Python len for Chinese.
        # Reserve UTF-8 bytes for new attempts, or 4x old code-point counts when
        # an older attempt has no reservation. Completed requests use API usage.
        reserved = attempt.get("reservedCharacters", attempt["characters"] * 4)
        record_path = path.with_name(path.name.removesuffix(".attempt.json") + ".json")
        if record_path.exists():
            usage = json.loads(record_path.read_text()).get("usage", {}).get("characters")
            if type(usage) is int and usage >= 0:
                reserved = usage
        total += Decimal(reserved) * RATES_PER_CHARACTER["beijing"]
    return total


def plan(pack: dict, ids: list[str], provider: QwenTTS) -> dict:
    pending = {}
    for text_id in ids:
        entry = review_draft_text(pack, text_id)
        if not review_audio_cached(entry, provider, CACHE):
            identity = review_audio_id(entry, provider.config)
            if (CACHE / f"{identity}.attempt.json").exists():
                raise ProviderError("review_generation_needs_attention")
            pending[identity] = (len(entry["hanzi"]), len(entry["hanzi"].encode("utf-8")))
    rate = RATES_PER_CHARACTER[provider.config.region]
    characters = sum(value[0] for value in pending.values())
    reserved_characters = sum(value[1] for value in pending.values())
    estimate = reserved_characters * rate
    reserved = reserved_cost()
    if reserved + estimate > BUDGET_CNY:
        raise ProviderError("review_budget_exceeded")
    return {"purpose": "review-draft", "version": VERSION,
            "inputSha256": review_input_sha256(pack, ids), "textIds": ids,
            "texts": len(ids), "pendingApiRequests": len(pending), "pendingCharacters": characters,
            "pendingReservedCharacters": reserved_characters,
            "estimatedNewCostCny": float(estimate), "previousReservedCostCny": float(reserved),
            "budgetCny": float(BUDGET_CNY), "priceSource": PRICE_SOURCE,
            "region": provider.config.region, "model": provider.config.model, "voice": provider.config.voice,
            "credentialConfigured": bool(provider.config.api_key), "reviewStatus": "pending", "networkCalls": 0}


def write_manifest(value: dict) -> None:
    temporary = MANIFEST.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, MANIFEST)


def usage_summary(clips: list[dict], rate: Decimal) -> dict:
    unique = {clip["generationId"]: clip for clip in clips}
    known = [clip.get("usage", {}).get("characters") for clip in unique.values()]
    if all(type(count) is int for count in known):
        characters = sum(known)
        return {"apiCharacters": characters, "estimatedListPriceCny": float(characters * rate), "billingStatementChecked": False}
    return {"apiCharacters": None, "estimatedListPriceCny": None, "billingStatementChecked": False}


def production_state_sha256(pack: dict) -> str:
    entries = [entry for group in ("expressions", "dialogues", "supportTerms") for entry in pack.get(group, [])]
    snapshot = {"packStatus": pack.get("status"), "release": pack.get("release"),
                "textReviews": {entry["id"]: entry.get("review") for entry in entries},
                "productionAudioClips": pack.get("audioClips"),
                "ledger": json.loads((ROOT / "content" / "reviews.json").read_text())}
    return hashlib.sha256(json.dumps(snapshot, ensure_ascii=False, sort_keys=True,
                                     separators=(",", ":")).encode()).hexdigest()


def existing_clips(pack: dict) -> list[dict]:
    if not MANIFEST.exists():
        return []
    previous = json.loads(MANIFEST.read_text())
    if previous.get("version") != VERSION:
        raise ProviderError("review_manifest_version_mismatch")
    all_ids = selection(pack, None)
    entries = {text_id: review_draft_text(pack, text_id) for text_id in all_ids}
    return [clip for clip in previous.get("clips", []) if clip.get("textId") in entries
            and clip.get("textVersion") == entries[clip["textId"]]["version"]
            and clip.get("text") == entries[clip["textId"]]["hanzi"]]


def check_manifest(pack: dict) -> dict:
    manifest = json.loads(MANIFEST.read_text())
    all_ids = selection(pack, None)
    clips = manifest.get("clips", [])
    if (manifest.get("schemaVersion") != 1 or manifest.get("version") != VERSION
            or len(all_ids) != 20 or len(clips) != len(all_ids)
            or {clip.get("textId") for clip in clips} != set(all_ids)
            or len({clip.get("id") for clip in clips}) != len(clips)):
        raise ProviderError("review_manifest_incomplete")
    if manifest.get("sourceInputSha256") != review_input_sha256(pack, all_ids):
        raise ProviderError("review_input_changed")
    if manifest.get("productionApprovalSha256") != production_state_sha256(pack):
        raise ProviderError("production_approval_state_changed")
    for clip in clips:
        entry = review_draft_text(pack, clip["textId"])
        if (clip.get("textVersion") != entry["version"] or clip.get("text") != entry["hanzi"]
                or clip.get("id") != entry["audio"]["normal"] or clip.get("pronunciation") != entry.get("pronunciation")
                or clip.get("pronunciationVersion") != entry["version"]):
            raise ProviderError("review_text_mismatch")
        if (clip.get("status") != "generated" or clip.get("reviewStatus") != "pending"
                or clip.get("purpose") != "review-draft" or clip.get("speed") != "normal"
                or clip.get("reviewIds") != [] or clip.get("listeningReview") != "pending"):
            raise ProviderError("review_status_mismatch")
        generation = clip.get("generationConfig", {})
        if (clip.get("model") not in ("qwen3-tts-flash", "qwen3-tts-flash-2025-11-27")
                or clip.get("voice") != "Jada" or clip.get("targetLanguage") != "wuu"
                or clip.get("providerLanguageParameter") != "Chinese"
                or generation.get("config_id") != clip.get("configId")
                or generation.get("model") != clip.get("model") or generation.get("voice") != clip.get("voice")
                or generation.get("service") != "tts" or generation.get("deployment") != "hosted-api"):
            raise ProviderError("review_generation_config_mismatch")
        identity = review_audio_id(entry, SimpleNamespace(config_id=clip.get("configId")))
        if (clip.get("generationId") != identity or clip.get("file") != f"/audio/review-r1/{identity}.wav"
                or not re.fullmatch(r"[a-f0-9]{64}", clip.get("sha256", ""))):
            raise ProviderError("review_asset_path_mismatch")
        audio_path = OUTPUT / (identity + ".wav")
        if audio_path.is_symlink() or not audio_path.resolve().is_relative_to(OUTPUT.resolve()):
            raise ProviderError("review_asset_path_mismatch")
        audio = audio_path.read_bytes()
        if hashlib.sha256(audio).hexdigest() != clip["sha256"]:
            raise ProviderError("review_asset_mismatch")
        measured = inspect_wav(audio, max_bytes=15 * 1024 * 1024, max_seconds=180)
        if any(clip.get(key) != measured[key] for key in ("durationMs", "sampleRate", "channels", "format")):
            raise ProviderError("review_audio_metadata_mismatch")
        if not isinstance(clip.get("generatedAt"), str) or not clip.get("upstreamRequestId"):
            raise ProviderError("review_generation_metadata_missing")
    return {"status": "passed", "clips": len(clips), "reviewStatus": "pending",
            "totalDurationMs": sum(clip["durationMs"] for clip in clips),
            "uniqueAudioFiles": len({clip["file"] for clip in clips}),
            "productionApprovalUnchanged": True, "networkCalls": 0}


async def generate(args) -> dict:
    pack = load_pack(args.pack)
    # R1's recorded inputs and approval hashes belong to its immutable snapshot.
    # A later content revision must use its own explicit generation workflow.
    if pack.get("contentVersion") != VERSION:
        raise ProviderError("review_pack_version_mismatch")
    if args.command == "check":
        return check_manifest(pack)
    ids = selection(pack, args.text_ids)
    config = ProviderConfig.from_env("tts")
    provider = QwenTTS(config)
    preview = plan(pack, ids, provider)
    if args.command == "plan":
        return preview
    if not args.allow_paid_call:
        raise ProviderError("explicit_paid_call_flag_required")
    if args.expect_input_sha256 != preview["inputSha256"]:
        raise ProviderError("review_input_changed")
    # A separate, explicit review command may make paid calls while the product's
    # live switches remain untouched. It cannot grant language/audio approval.
    provider = QwenTTS(replace(config, live_enabled=True))
    provider.config.require_enabled()
    CACHE.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock = CACHE / "batch.lock"
    try:
        fd = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        raise ProviderError("generation_in_progress") from None
    os.close(fd)
    try:
        completed = existing_clips(pack)
        all_ids = selection(pack, None)
        manifest = {"schemaVersion": 1, "version": VERSION, "purpose": "review-draft", "reviewStatus": "pending",
                    "sourceInputSha256": review_input_sha256(pack, all_ids), "priceSource": PRICE_SOURCE,
                    "productionApprovalSha256": production_state_sha256(pack),
                    "priceVerifiedAt": "2026-10-17", "budgetCny": 1, "clips": completed}
        rate = RATES_PER_CHARACTER[config.region]
        generated_count = 0
        # Budget and freeze checks are repeated inside the exclusive batch lock.
        preview = plan(load_pack(args.pack), ids, provider)
        if preview["inputSha256"] != args.expect_input_sha256:
            raise ProviderError("review_input_changed")
        for text_id in ids:
            # Recheck the frozen source before each paid call; stop rather than
            # producing assets from a moving content target.
            current = plan(load_pack(args.pack), ids, provider)
            if current["inputSha256"] != preview["inputSha256"]:
                raise ProviderError("review_input_changed")
            clip = await produce_review_audio(pack, text_id, provider, OUTPUT, CACHE)
            characters = clip.get("usage", {}).get("characters")
            clip["estimatedCostCny"] = float(characters * rate) if type(characters) is int else None
            clip["priceSource"] = PRICE_SOURCE
            generated_count += int(not clip["reused"])
            completed = [old for old in completed if old["textId"] != text_id] + [clip]
            completed.sort(key=lambda item: all_ids.index(item["textId"]))
            manifest["clips"] = completed
            manifest["usageSummary"] = usage_summary(completed, rate)
            manifest["updatedAt"] = datetime.now(timezone.utc).isoformat()
            write_manifest(manifest)
            print(json.dumps({"textId": text_id, "status": "generated", "reviewStatus": "pending",
                              "durationMs": clip["durationMs"], "reused": clip["reused"]}), flush=True)
        return {"manifest": "content/audio-review-r1.json", "clips": len(completed),
                "totalDurationMs": sum(clip["durationMs"] for clip in completed), "newApiRequests": generated_count,
                "reviewStatus": "pending", "slowSpeed": "pending_user_review_of_normal", **manifest["usageSummary"]}
    finally:
        lock.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for command in ("plan", "generate", "check"):
        sub = commands.add_parser(command)
        sub.add_argument("--pack", default=f"content/versions/{VERSION}.json")
        sub.add_argument("--text-ids", nargs="+")
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
