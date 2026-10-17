#!/usr/bin/env python3
"""Offline B+C candidate audio audit and bounded, explicitly requested whole-sentence TTS."""
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


def _script(name: str):
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), ROOT / "scripts" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# R1 initializes the server-only dotenv configuration without exposing secrets.
R1 = _script("speech-review")
R2 = _script("speech-review-r2")
R4 = _script("speech-review-r4")
from app.providers import ProviderConfig, ProviderError, QwenTTS, inspect_wav
from app.providers.production import produce_review_audio, review_audio_cached, review_audio_id, review_draft_text, review_input_sha256

VERSION = "batch-bc.2026-10-17.v1"
PACK_PATH = "content/batch-bc.json"
MANIFEST = ROOT / "content" / "audio-review-bc.json"
OUTPUT = ROOT / "frontend" / "public" / "audio" / "review-bc"
CACHE = ROOT / "artifacts" / "audio" / "review-bc"
MAX_REQUESTS = 100
BUDGET_CNY = Decimal("2.00")
RATE = Decimal("0.8") / 10000
PRICE_SOURCE = R1.PRICE_SOURCE
SOURCE_MANIFESTS = ("content/audio-review-r1.json", "content/audio-review-r2.json", "content/audio-review-r4.json")


def _sha(value) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def load_pack(value: str) -> dict:
    path = (ROOT / value).resolve()
    if not path.is_relative_to(ROOT / "content"):
        raise ProviderError("content_path_required")
    pack = json.loads(path.read_text(encoding="utf-8"))
    selection(pack)
    return pack


def review_pack(pack: dict) -> dict:
    """Adapt the shared station entry list to the established audio producer contract."""
    return {**pack, "expressions": [], "supportTerms": [], "dialogues": pack["entries"]}


def selection(pack: dict) -> list[str]:
    if pack.get("contentVersion") != VERSION or not isinstance(pack.get("entries"), list):
        raise ProviderError("review_pack_version_mismatch")
    normalized = review_pack(pack)
    ids = R1.selection(normalized, None)
    if len(ids) > 150:
        raise ProviderError("invalid_text_selection")
    audio_ids = []
    for text_id in ids:
        entry = review_draft_text(normalized, text_id)
        if entry["version"] != VERSION:
            raise ProviderError("review_pack_version_mismatch")
        review = entry.get("review", {})
        if (review.get("status") != "draft" or review.get("language") != "pending"
                or review.get("pronunciation") != "pending" or review.get("audio") != "pending"
                or review.get("recordIds") != []):
            raise ProviderError("review_status_mismatch")
        audio_ids.append(entry["audio"]["normal"])
    if len(set(audio_ids)) != len(audio_ids):
        raise ProviderError("invalid_text_selection")
    return ids


def source_clips() -> list[dict]:
    # Each source pack checks exact words, versions, review state, generation
    # metadata, WAV contents and hashes before it is eligible for reuse.
    R1.check_manifest(json.loads((ROOT / "content" / "versions" / f"{R1.VERSION}.json").read_text()))
    R2.check_manifest(json.loads((ROOT / "content" / "versions" / f"{R2.VERSION}.json").read_text()))
    R4.check_manifest(R4.load_pack(R4.PACK_PATH))
    return [{"manifest": path, "clip": clip} for path in SOURCE_MANIFESTS
            for clip in json.loads((ROOT / path).read_text())["clips"]]


def source_digest() -> str:
    return _sha({path: hashlib.sha256((ROOT / path).read_bytes()).hexdigest() for path in SOURCE_MANIFESTS})


def rebind(entry: dict, source: dict) -> dict:
    original = source["clip"]
    clip = deepcopy(original)
    clip.update({"id": entry["audio"]["normal"], "textId": entry["id"], "textVersion": entry["version"],
                 "text": entry["hanzi"], "textSha256": hashlib.sha256(entry["hanzi"].encode()).hexdigest(),
                 "pronunciation": entry.get("pronunciation"), "pronunciationVersion": entry["version"], "reused": True,
                 "reusedFrom": {"manifest": source["manifest"], "textId": original["textId"],
                                "textVersion": original["textVersion"], "generationId": original["generationId"],
                                "sha256": original["sha256"], "file": original["file"]}})
    return clip


def reused_clip(entry: dict, sources: list[dict], config_id: str) -> dict | None:
    for source in sources:
        original = source["clip"]
        if original["text"] == entry["hanzi"] and original["configId"] == config_id:
            return rebind(entry, source)
    return None


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


def public_clips(pack: dict, sources: list[dict], config_id: str) -> dict[str, dict]:
    """A clean checkout can reuse verified public assets without its ignored cache.

    A partial manifest is usable only as a validated subset of this exact frozen
    input. An old pack binding is not reused; the private cache may still safely
    rebind unchanged sound after an explicit annotation/content revision.
    """
    if not MANIFEST.exists():
        return {}
    normalized, ids = review_pack(pack), selection(pack)
    manifest = json.loads(MANIFEST.read_text())
    if (manifest.get("version") != VERSION or manifest.get("configId") != config_id
            or manifest.get("sourceInputSha256") != review_input_sha256(normalized, ids)
            or manifest.get("sourceContentSha256") != _sha(pack)):
        return {}
    if (manifest.get("schemaVersion") != 1 or manifest.get("purpose") != "review-draft"
            or manifest.get("reviewStatus") != "pending"
            or manifest.get("sourceManifestsSha256") != source_digest()
            or manifest.get("productionApprovalSha256") != R1.production_state_sha256(normalized)):
        raise ProviderError("review_public_manifest_mismatch")
    clips = manifest.get("clips", [])
    if (not isinstance(clips, list) or not {clip.get("textId") for clip in clips}.issubset(set(ids))
            or len({clip.get("textId") for clip in clips}) != len(clips)
            or len({clip.get("id") for clip in clips}) != len(clips)):
        raise ProviderError("review_public_manifest_mismatch")
    for clip in clips:
        if clip.get("configId") != config_id:
            raise ProviderError("review_generation_config_mismatch")
        check_clip(review_draft_text(normalized, clip["textId"]), clip, sources)
    return {clip["textId"]: deepcopy(clip) for clip in clips}


def plan(pack: dict, provider: QwenTTS, max_calls: int = MAX_REQUESTS,
         max_cost_cny: Decimal = BUDGET_CNY) -> dict:
    if type(max_calls) is not int or not 0 < max_calls <= MAX_REQUESTS:
        raise ProviderError("review_request_limit_exceeded")
    if not max_cost_cny.is_finite() or not 0 < max_cost_cny <= BUDGET_CNY:
        raise ProviderError("review_budget_exceeded")
    config = provider.config
    if (config.service != "tts" or config.region != "beijing" or config.model != "qwen3-tts-flash"
            or config.voice != "Jada"):
        raise ProviderError("review_generation_config_mismatch")
    ids, sources = selection(pack), source_clips()
    normalized = review_pack(pack)
    published = public_clips(pack, sources, config.config_id)
    pending, reused, cached, public_cached = {}, [], [], []
    for text_id in ids:
        entry = review_draft_text(normalized, text_id)
        source = reused_clip(entry, sources, config.config_id)
        if source is not None:
            reused.append({"textId": text_id, "source": source["reusedFrom"]})
            continue
        identity = review_audio_id(entry, config)
        if review_audio_cached(entry, provider, CACHE):
            cached.append(text_id)
        elif (CACHE / f"{identity}.attempt.json").exists():
            raise ProviderError("review_generation_needs_attention")
        elif text_id in published:
            public_cached.append(text_id)
        elif (OUTPUT / f"{identity}.wav").exists():
            # A WAV without a matching, verified completion record is not a
            # cache miss. Never charge again merely to repair its provenance.
            raise ProviderError("review_generation_needs_attention")
        else:
            pending.setdefault(identity, entry)
    attempts, reserved = reservations()
    reserved_characters = sum(len(entry["hanzi"].encode("utf-8")) for entry in pending.values())
    estimate = reserved_characters * RATE
    if attempts + len(pending) > max_calls:
        raise ProviderError("review_request_limit_exceeded")
    if reserved + estimate > max_cost_cny:
        raise ProviderError("review_budget_exceeded")
    return {"purpose": "review-draft", "version": VERSION, "inputSha256": review_input_sha256(normalized, ids),
            "sourceContentSha256": _sha(pack), "sourceManifestsSha256": source_digest(),
            "productionApprovalSha256": R1.production_state_sha256(normalized), "configId": config.config_id,
            "texts": len(ids), "reusedFromEarlierBatches": len(reused), "reuse": reused,
            "cachedBCTextIds": cached, "publicCachedBCTextIds": public_cached, "pendingApiRequests": len(pending),
            "pendingTexts": [{"textId": entry["id"], "text": entry["hanzi"]} for entry in pending.values()],
            "pendingCharacters": sum(len(entry["hanzi"]) for entry in pending.values()),
            "pendingReservedCharacters": reserved_characters, "estimatedNewCostCny": float(estimate),
            "previousReservedCostCny": float(reserved), "previousAttempts": attempts,
            "maxApiRequests": max_calls, "budgetCny": float(max_cost_cny), "priceSource": PRICE_SOURCE,
            "region": config.region, "model": config.model, "voice": config.voice,
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
    identity = review_audio_id(entry, SimpleNamespace(config_id=clip.get("configId")))
    expected = reused_clip(entry, sources, clip.get("configId"))
    if expected is not None and clip != expected:
        raise ProviderError("review_reuse_provenance_mismatch")
    if expected is None and clip.get("reusedFrom") is not None:
        raise ProviderError("review_reuse_provenance_mismatch")
    expected_file = expected["file"] if expected is not None else f"/audio/review-bc/{identity}.wav"
    if (clip.get("generationId") != identity or clip.get("file") != expected_file
            or not re.fullmatch(r"[a-f0-9]{64}", clip.get("sha256", ""))):
        raise ProviderError("review_asset_path_mismatch")
    generation = clip.get("generationConfig", {})
    if (clip.get("model") != "qwen3-tts-flash" or clip.get("voice") != "Jada" or clip.get("targetLanguage") != "wuu"
            or clip.get("providerLanguageParameter") != "Chinese" or generation.get("config_id") != clip.get("configId")
            or generation.get("model") != clip.get("model") or generation.get("voice") != clip.get("voice")
            or generation.get("service") != "tts" or generation.get("deployment") != "hosted-api"
            or generation.get("region") != "beijing"):
        raise ProviderError("review_generation_config_mismatch")
    audio_root = ROOT / "frontend" / "public" / "audio"
    path = ROOT / "frontend" / "public" / clip["file"].lstrip("/")
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
    normalized = review_pack(pack)
    manifest = json.loads(MANIFEST.read_text())
    clips = manifest.get("clips", [])
    if (manifest.get("schemaVersion") != 1 or manifest.get("version") != VERSION
            or manifest.get("purpose") != "review-draft" or manifest.get("reviewStatus") != "pending"
            or len(clips) != len(ids) or {clip.get("textId") for clip in clips} != set(ids)
            or len({clip.get("id") for clip in clips}) != len(clips)):
        raise ProviderError("review_manifest_incomplete")
    if (manifest.get("sourceInputSha256") != review_input_sha256(normalized, ids)
            or manifest.get("sourceContentSha256") != _sha(pack)):
        raise ProviderError("review_input_changed")
    if manifest.get("sourceManifestsSha256") != source_digest():
        raise ProviderError("review_source_manifest_changed")
    if manifest.get("productionApprovalSha256") != R1.production_state_sha256(normalized):
        raise ProviderError("production_approval_state_changed")
    for clip in clips:
        if clip.get("configId") != manifest.get("configId"):
            raise ProviderError("review_generation_config_mismatch")
        check_clip(review_draft_text(normalized, clip["textId"]), clip, sources)
    reused = sum("reusedFrom" in clip for clip in clips)
    generated = {clip["generationId"] for clip in clips if "reusedFrom" not in clip}
    return {"status": "passed", "clips": len(clips), "reusedFromEarlierBatches": reused,
            "generatedForBC": len(generated), "reviewStatus": "pending",
            "totalDurationMs": sum(clip["durationMs"] for clip in clips),
            "uniqueAudioFiles": len({clip["file"] for clip in clips}),
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
    if (args.expect_input_sha256 != preview["inputSha256"]
            or args.expect_content_sha256 != preview["sourceContentSha256"]
            or args.expect_config_id != preview["configId"]):
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
        sources, generated_count = source_clips(), 0
        ids, normalized = selection(pack), review_pack(pack)
        published = public_clips(pack, sources, provider.config.config_id)
        completed_by_id = deepcopy(published)
        completed = [completed_by_id[text_id] for text_id in ids if text_id in completed_by_id]
        manifest = {"schemaVersion": 1, "version": VERSION, "purpose": "review-draft", "reviewStatus": "pending",
                    **{key: preview[key] for key in ("sourceContentSha256", "sourceManifestsSha256", "productionApprovalSha256", "configId")},
                    "sourceInputSha256": preview["inputSha256"], "priceSource": PRICE_SOURCE,
                    "priceVerifiedAt": "2026-10-17", "budgetCny": float(args.max_cost_cny),
                    "maxApiRequests": args.max_calls, "clips": completed}
        for text_id in ids:
            current = plan(load_pack(args.pack), provider, args.max_calls, args.max_cost_cny)
            if any(current[key] != preview[key] for key in ("inputSha256", "sourceContentSha256", "sourceManifestsSha256", "productionApprovalSha256", "configId")):
                raise ProviderError("review_input_changed")
            entry = review_draft_text(normalized, text_id)
            clip = reused_clip(entry, sources, provider.config.config_id)
            if clip is None:
                if text_id in published and not review_audio_cached(entry, provider, CACHE):
                    clip = deepcopy(published[text_id])
                    clip["reused"] = True
                else:
                    clip = await produce_review_audio(normalized, text_id, provider, OUTPUT, CACHE)
                    clip["file"] = f"/audio/review-bc/{clip['generationId']}.wav"
                    count = clip.get("usage", {}).get("characters")
                    clip["estimatedCostCny"] = float(count * RATE) if type(count) is int else None
                    clip["priceSource"] = PRICE_SOURCE
                    generated_count += int(not clip["reused"])
            check_clip(entry, clip, sources)
            completed_by_id[text_id] = clip
            completed[:] = [completed_by_id[item] for item in ids if item in completed_by_id]
            manifest["usageSummary"] = R1.usage_summary([c for c in completed if "reusedFrom" not in c], RATE)
            manifest["updatedAt"] = datetime.now(timezone.utc).isoformat()
            write_manifest(manifest)
            print(json.dumps({"textId": text_id, "status": "generated", "reviewStatus": "pending",
                              "durationMs": clip["durationMs"], "reused": clip["reused"]}), flush=True)
        checked = check_manifest(load_pack(args.pack))
        checked.pop("networkCalls")
        return {"manifest": "content/audio-review-bc.json", **checked, "newApiRequests": generated_count,
                "slowSpeed": "playback_rate_0.75_preserves_pitch", **manifest["usageSummary"]}
    finally:
        lock.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for command in ("plan", "generate", "check"):
        sub = commands.add_parser(command)
        sub.add_argument("--pack", default=PACK_PATH)
        sub.add_argument("--max-calls", type=int, default=MAX_REQUESTS)
        sub.add_argument("--max-cost-cny", type=Decimal, default=BUDGET_CNY)
        if command == "generate":
            sub.add_argument("--expect-input-sha256", required=True)
            sub.add_argument("--expect-content-sha256", required=True)
            sub.add_argument("--expect-config-id", required=True)
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
