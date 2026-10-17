#!/usr/bin/env python3
"""R2 review sounds: verify/rebind R1 recordings and synthesize only three changed sentences."""
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

VERSION = "batch-a-r2.2026-10-17.v1"
MANIFEST = ROOT / "content" / "audio-review-r2.json"
SOURCE = ROOT / "content" / "audio-review-r1.json"
OUTPUT = ROOT / "frontend" / "public" / "audio" / "review-r2"
CACHE = ROOT / "artifacts" / "audio" / "review-r2"
NEW_TEXTS = {"NX-N04": "侬讲个是只，还是份？", "NX-N09": "对伐？", "NX-N10": "好个。"}
BUDGET_CNY = Decimal("1.00")
MAX_REQUESTS = 3
RATE = Decimal("0.8") / 10000
PRICE_SOURCE = R1.PRICE_SOURCE


def load_pack(value: str) -> dict:
    path = (ROOT / value).resolve()
    if not path.is_relative_to(ROOT / "content"):
        raise ProviderError("content_path_required")
    pack = json.loads(path.read_text(encoding="utf-8"))
    if pack.get("contentVersion") != VERSION:
        raise ProviderError("review_pack_version_mismatch")
    return pack


def selection(pack: dict) -> list[str]:
    ids = R1.selection(pack, None)
    if len(ids) != 20:
        raise ProviderError("invalid_text_selection")
    for text_id, text in NEW_TEXTS.items():
        if review_draft_text(pack, text_id)["hanzi"] != text:
            raise ProviderError("review_new_text_not_authorized")
    return ids


def source_clips() -> list[dict]:
    # Reuse only audio that still passes the original source/version/metadata and
    # byte-level checks, including its honest pending review state.
    old_pack = json.loads((ROOT / "content" / "versions" / f"{R1.VERSION}.json").read_text())
    R1.check_manifest(old_pack)
    return json.loads(SOURCE.read_text())["clips"]


def rebind(entry: dict, source: dict) -> dict:
    clip = deepcopy(source)
    clip.update({"id": entry["audio"]["normal"], "textId": entry["id"], "textVersion": entry["version"],
                 "text": entry["hanzi"], "textSha256": hashlib.sha256(entry["hanzi"].encode()).hexdigest(),
                 "pronunciation": entry.get("pronunciation"), "pronunciationVersion": entry["version"],
                 "reused": True,
                 "reusedFrom": {"manifest": "content/audio-review-r1.json", "textId": source["textId"],
                                "textVersion": source["textVersion"], "generationId": source["generationId"],
                                "sha256": source["sha256"], "file": source["file"]}})
    return clip


def reused_clip(entry: dict, sources: list[dict]) -> dict | None:
    matches = [clip for clip in sources if clip["text"] == entry["hanzi"]]
    if not matches:
        return None
    source = next((clip for clip in matches if clip["textId"] == entry["id"]), matches[0])
    return rebind(entry, source)


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
        total += Decimal(reserved) * RATE
    return len(attempts), total


def plan(pack: dict, provider: QwenTTS) -> dict:
    config = provider.config
    if (config.region != "beijing" or config.model != "qwen3-tts-flash" or config.voice != "Jada"):
        raise ProviderError("review_generation_config_mismatch")
    ids, sources = selection(pack), source_clips()
    pending, reused, cached = {}, [], []
    for text_id in ids:
        entry = review_draft_text(pack, text_id)
        old = reused_clip(entry, sources)
        if old is not None:
            reused.append({"textId": text_id, "sourceTextId": old["reusedFrom"]["textId"], "file": old["file"]})
            continue
        if NEW_TEXTS.get(text_id) != entry["hanzi"]:
            raise ProviderError("review_new_text_not_authorized")
        identity = review_audio_id(entry, config)
        if review_audio_cached(entry, provider, CACHE):
            cached.append(text_id)
        elif (CACHE / f"{identity}.attempt.json").exists():
            raise ProviderError("review_generation_needs_attention")
        else:
            pending[identity] = entry
    attempts, reserved = reservations()
    estimate = sum(len(entry["hanzi"].encode("utf-8")) for entry in pending.values()) * RATE
    if attempts + len(pending) > MAX_REQUESTS:
        raise ProviderError("review_request_limit_exceeded")
    if reserved + estimate > BUDGET_CNY:
        raise ProviderError("review_budget_exceeded")
    return {"purpose": "review-draft", "version": VERSION, "inputSha256": review_input_sha256(pack, ids),
            "sourceManifestSha256": hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
            "productionApprovalSha256": R1.production_state_sha256(pack),
            "texts": len(ids), "reusedFromR1": len(reused), "reuse": reused,
            "cachedR2TextIds": cached, "pendingApiRequests": len(pending),
            "pendingTexts": [{"textId": entry["id"], "text": entry["hanzi"]} for entry in pending.values()],
            "pendingCharacters": sum(len(entry["hanzi"]) for entry in pending.values()),
            "pendingReservedCharacters": sum(len(entry["hanzi"].encode("utf-8")) for entry in pending.values()),
            "estimatedNewCostCny": float(estimate), "previousReservedCostCny": float(reserved),
            "previousAttempts": attempts, "maxApiRequests": MAX_REQUESTS, "budgetCny": float(BUDGET_CNY),
            "priceSource": PRICE_SOURCE, "region": config.region, "model": config.model, "voice": config.voice,
            "credentialConfigured": bool(config.api_key), "reviewStatus": "pending", "networkCalls": 0}


def check_clip(entry: dict, clip: dict, sources: list[dict]) -> None:
    if (clip.get("id") != entry["audio"]["normal"] or clip.get("textId") != entry["id"]
            or clip.get("textVersion") != entry["version"] or clip.get("text") != entry["hanzi"]
            or clip.get("textSha256") != hashlib.sha256(entry["hanzi"].encode()).hexdigest()
            or clip.get("pronunciation") != entry.get("pronunciation") or clip.get("pronunciationVersion") != entry["version"]):
        raise ProviderError("review_text_mismatch")
    if (clip.get("status") != "generated" or clip.get("reviewStatus") != "pending"
            or clip.get("purpose") != "review-draft" or clip.get("speed") != "normal"
            or clip.get("reviewIds") != [] or clip.get("listeningReview") != "pending"):
        raise ProviderError("review_status_mismatch")
    expected = reused_clip(entry, sources)
    folder = "review-r1" if expected is not None else "review-r2"
    identity = review_audio_id(entry, SimpleNamespace(config_id=clip.get("configId")))
    if (clip.get("generationId") != identity or clip.get("file") != f"/audio/{folder}/{identity}.wav"
            or not re.fullmatch(r"[a-f0-9]{64}", clip.get("sha256", ""))):
        raise ProviderError("review_asset_path_mismatch")
    if expected is not None and clip != expected:
        raise ProviderError("review_reuse_provenance_mismatch")
    if expected is None and (entry["id"] not in NEW_TEXTS or clip.get("reusedFrom") is not None):
        raise ProviderError("review_new_text_not_authorized")
    generation = clip.get("generationConfig", {})
    if (clip.get("model") != "qwen3-tts-flash" or clip.get("voice") != "Jada" or clip.get("targetLanguage") != "wuu"
            or clip.get("providerLanguageParameter") != "Chinese" or generation.get("config_id") != clip.get("configId")
            or generation.get("model") != clip.get("model") or generation.get("voice") != clip.get("voice")
            or generation.get("service") != "tts" or generation.get("deployment") != "hosted-api"
            or generation.get("region") != "beijing"):
        raise ProviderError("review_generation_config_mismatch")
    audio_root = ROOT / "frontend" / "public" / "audio" / folder
    path = audio_root / f"{identity}.wav"
    if path.is_symlink() or not path.resolve().is_relative_to(audio_root.resolve()):
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
    ids, sources = selection(pack), source_clips()
    manifest = json.loads(MANIFEST.read_text())
    clips = manifest.get("clips", [])
    if (manifest.get("schemaVersion") != 1 or manifest.get("version") != VERSION
            or manifest.get("purpose") != "review-draft" or manifest.get("reviewStatus") != "pending"
            or len(clips) != len(ids) or {clip.get("textId") for clip in clips} != set(ids)
            or len({clip.get("id") for clip in clips}) != len(clips)):
        raise ProviderError("review_manifest_incomplete")
    if manifest.get("sourceInputSha256") != review_input_sha256(pack, ids):
        raise ProviderError("review_input_changed")
    if manifest.get("sourceManifestSha256") != hashlib.sha256(SOURCE.read_bytes()).hexdigest():
        raise ProviderError("review_source_manifest_changed")
    if manifest.get("productionApprovalSha256") != R1.production_state_sha256(pack):
        raise ProviderError("production_approval_state_changed")
    for clip in clips:
        check_clip(review_draft_text(pack, clip["textId"]), clip, sources)
    reused = sum("reusedFrom" in clip for clip in clips)
    if reused != 17:
        raise ProviderError("review_manifest_incomplete")
    return {"status": "passed", "clips": len(clips), "reusedFromR1": reused, "generatedForR2": len(clips) - reused,
            "reviewStatus": "pending", "totalDurationMs": sum(clip["durationMs"] for clip in clips),
            "uniqueAudioFiles": len({clip["file"] for clip in clips}), "productionApprovalUnchanged": True, "networkCalls": 0}


def write_manifest(value: dict) -> None:
    temporary = MANIFEST.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, MANIFEST)


async def generate(args) -> dict:
    pack = load_pack(args.pack)
    if args.command == "check":
        return check_manifest(pack)
    provider = QwenTTS(ProviderConfig.from_env("tts"))
    preview = plan(pack, provider)
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
        completed, sources, ids, generated_count = [], source_clips(), selection(pack), 0
        manifest = {"schemaVersion": 1, "version": VERSION, "purpose": "review-draft", "reviewStatus": "pending",
                    "sourceInputSha256": preview["inputSha256"], "sourceManifestSha256": preview["sourceManifestSha256"],
                    "productionApprovalSha256": preview["productionApprovalSha256"], "priceSource": PRICE_SOURCE,
                    "priceVerifiedAt": "2026-10-17", "budgetCny": 1, "maxApiRequests": MAX_REQUESTS, "clips": completed}
        for text_id in ids:
            current = plan(load_pack(args.pack), provider)
            if any(current[key] != preview[key] for key in ("inputSha256", "sourceManifestSha256", "productionApprovalSha256")):
                raise ProviderError("review_input_changed")
            entry = review_draft_text(pack, text_id)
            clip = reused_clip(entry, sources)
            if clip is None:
                clip = await produce_review_audio(pack, text_id, provider, OUTPUT, CACHE)
                # The shared R1 helper writes to the supplied folder but uses an
                # R1 URL; bind this R2 asset to its actual public location.
                clip["file"] = f"/audio/review-r2/{clip['generationId']}.wav"
                count = clip.get("usage", {}).get("characters")
                clip["estimatedCostCny"] = float(count * RATE) if type(count) is int else None
                clip["priceSource"] = PRICE_SOURCE
                generated_count += int(not clip["reused"])
            check_clip(entry, clip, sources)
            completed.append(clip)
            manifest["usageSummary"] = R1.usage_summary([c for c in completed if "reusedFrom" not in c], RATE)
            manifest["updatedAt"] = datetime.now(timezone.utc).isoformat()
            write_manifest(manifest)
            print(json.dumps({"textId": text_id, "status": "generated", "reviewStatus": "pending",
                              "durationMs": clip["durationMs"], "reused": clip["reused"]}), flush=True)
        checked = check_manifest(load_pack(args.pack))
        checked.pop("networkCalls")  # The check is offline; this command may have synthesized/downloaded audio.
        return {"manifest": "content/audio-review-r2.json", **checked, "newApiRequests": generated_count,
                "slowSpeed": "playback_rate_0.75_preserves_pitch", **manifest["usageSummary"]}
    finally:
        lock.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for command in ("plan", "generate", "check"):
        sub = commands.add_parser(command)
        sub.add_argument("--pack", default="content/batch-a.json")
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
