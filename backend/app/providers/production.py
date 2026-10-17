"""Offline teaching-audio pipeline. Human approval is data; never synthesized here."""
import hashlib
import json
import os
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path

from .contracts import ProviderError, ServiceConfig, TTSProvider, TTSRequest


def language_subject_sha256(entry: dict) -> str:
    """Same canonical projection as scripts/validate-content.mjs language reviews."""
    try:
        subject = {key: entry[key] for key in ("id", "version", "hanzi", "meaning", "acceptableVariants")}
        subject["segments"] = [{key: segment[key] for key in ("id", "hanzi", "meaning")}
                               for segment in entry.get("segments", [])]
        return hashlib.sha256(json.dumps(subject, sort_keys=True, ensure_ascii=False,
                                         separators=(",", ":")).encode("utf-8")).hexdigest()
    except (KeyError, TypeError):
        raise ProviderError("invalid_content_record") from None


def approved_text(pack: dict, reviews: dict, text_id: str) -> dict:
    entries = [entry for group in ("expressions", "dialogues", "supportTerms") for entry in pack.get(group, [])]
    matches = [entry for entry in entries if entry.get("id") == text_id]
    if len(matches) != 1:
        raise ProviderError("unknown_text")
    entry = matches[0]
    review = entry.get("review", {})
    if (not isinstance(entry.get("hanzi"), str) or not entry["hanzi"].strip()
            or review.get("language") != "approved"
            or review.get("status") not in ("language-reviewed", "audio-reviewed", "approved")):
        raise ProviderError("language_review_required")
    subject_hash = language_subject_sha256(entry)
    reviewers = {r["id"] for r in reviews.get("reviewers", []) if r.get("fluentShanghainese") is True}
    latest = {}
    for record in reviews.get("records", []):
        if (record.get("contentId") != text_id or record.get("contentVersion") != entry.get("version")
                or record.get("stage") != "language"):
            continue
        try:
            reviewed = datetime.fromisoformat(record["reviewedAt"].replace("Z", "+00:00"))
            if reviewed.tzinfo is None:
                raise ValueError
        except (KeyError, ValueError, TypeError):
            raise ProviderError("invalid_review_record") from None
        reviewer = record.get("reviewerId")
        if reviewer not in latest or reviewed >= latest[reviewer][0]:
            latest[reviewer] = reviewed, record
    if any(record.get("decision") == "changes-requested" for _, record in latest.values()):
        raise ProviderError("language_review_required")
    approved = {reviewer for reviewer, (_, record) in latest.items()
                if reviewer in reviewers and record.get("decision") == "approved"
                and record.get("subjectSha256") == subject_hash
                and record.get("id") in review.get("recordIds", [])}
    if len(approved) < 2:
        raise ProviderError("language_review_required")
    return entry


def generation_id(request: TTSRequest, config: ServiceConfig) -> str:
    source = json.dumps({"request": asdict(request), "configId": config.config_id},
                        sort_keys=True, ensure_ascii=False).encode()
    return hashlib.sha256(source).hexdigest()


async def produce_audio(pack: dict, reviews: dict, text_id: str, provider: TTSProvider, output: Path,
                        speed: str = "normal") -> dict:
    entry = approved_text(pack, reviews, text_id)
    request = TTSRequest(text_id=entry["id"], text_version=entry["version"], text=entry["hanzi"], speed=speed)
    identity = generation_id(request, provider.config)
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    audio_path, manifest_path = output / f"{identity}.wav", output / f"{identity}.json"
    # No overwrites and no repeat billing for identical generation inputs.
    if manifest_path.exists() or audio_path.exists():
        raise ProviderError("asset_already_exists")
    lock_path = output / f"{identity}.lock"
    try:
        lock_fd = os.open(lock_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        raise ProviderError("generation_in_progress") from None
    os.close(lock_fd)
    try:
        if manifest_path.exists() or audio_path.exists():
            raise ProviderError("asset_already_exists")
        return await _generate_and_save(entry, request, provider, identity, audio_path, manifest_path)
    finally:
        lock_path.unlink(missing_ok=True)


async def _generate_and_save(entry: dict, request: TTSRequest, provider: TTSProvider, identity: str,
                             audio_path: Path, manifest_path: Path) -> dict:
    text_id, speed = request.text_id, request.speed
    audio, metadata = await provider.synthesize(request)
    digest = hashlib.sha256(audio).hexdigest()
    provenance = provider.config.public_dict()
    manifest = {"id": f"{text_id}.{speed}", "generationId": identity,
        "textId": text_id, "textVersion": entry["version"], "textSha256": hashlib.sha256(entry["hanzi"].encode()).hexdigest(),
        "speed": speed, "file": audio_path.name, "sha256": digest,
        **metadata, "source": "tts", "provider": provenance["provider"], "deployment": provenance["deployment"],
        "model": provenance["model"], "voice": provenance["voice"], "generationConfig": provenance,
        "createdAt": datetime.now(timezone.utc).isoformat(), "reviewIds": [],
        "languageReviewIds": entry["review"]["recordIds"], "status": "pending", "listeningReview": "pending"}
    # Use exclusive creation to guard competing runs; each generation keeps immutable provenance.
    fd = os.open(audio_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as handle:
        handle.write(audio)
    fd = os.open(manifest_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    return manifest


# Review previews are authorized separately from production publication. They do
# not create approval records or change the original pack/review ledger.
def review_draft_text(pack: dict, text_id: str) -> dict:
    entries = [entry for group in ("expressions", "dialogues", "supportTerms") for entry in pack.get(group, [])]
    matches = [entry for entry in entries if entry.get("id") == text_id]
    if len(matches) != 1:
        raise ProviderError("unknown_text")
    entry = matches[0]
    if (not isinstance(entry.get("hanzi"), str) or not entry["hanzi"].strip() or len(entry["hanzi"]) > 600
            or not isinstance(entry.get("version"), str) or not entry["version"]
            or not isinstance(entry.get("audio", {}).get("normal"), str)):
        raise ProviderError("invalid_content_record")
    return entry


def review_input_sha256(pack: dict, text_ids: list[str]) -> str:
    """Freeze precisely the selected synthesis text/version and displayed notation."""
    entries = [review_draft_text(pack, text_id) for text_id in text_ids]
    snapshot = [{"id": entry["id"], "version": entry["version"], "text": entry["hanzi"],
                 "pronunciation": entry.get("pronunciation"), "segments": entry.get("segments", [])}
                for entry in entries]
    return hashlib.sha256(json.dumps(snapshot, ensure_ascii=False, sort_keys=True,
                                     separators=(",", ":")).encode()).hexdigest()


def review_audio_id(entry: dict, config: ServiceConfig) -> str:
    # Audio can be reused when annotation/version alone changes; the manifest
    # then binds that same sound to the new exact displayed text/version.
    inputs = {"purpose": "review-draft", "text": entry["hanzi"], "configId": config.config_id,
              "targetLanguage": "wuu", "voiceConfig": "nanxiang-jada-v1", "speed": "normal"}
    return hashlib.sha256(json.dumps(inputs, ensure_ascii=False, sort_keys=True,
                                     separators=(",", ":")).encode()).hexdigest()


def _read_review_cache(entry: dict, provider: TTSProvider, cache: Path) -> tuple[dict, bytes] | None:
    identity = review_audio_id(entry, provider.config)
    record_path, audio_path = cache / f"{identity}.json", cache / f"{identity}.wav"
    if not record_path.exists():
        if audio_path.exists():
            raise ProviderError("review_generation_needs_attention")
        return None
    try:
        record = json.loads(record_path.read_text(encoding="utf-8"))
        audio = audio_path.read_bytes()
        if (record["generationId"] != identity or record["text"] != entry["hanzi"]
                or record["sha256"] != hashlib.sha256(audio).hexdigest()
                or record["configId"] != provider.config.config_id):
            raise ProviderError("review_cache_mismatch")
        from .audio import inspect_wav
        measured = inspect_wav(audio, max_bytes=15 * 1024 * 1024, max_seconds=180)
        if record["durationMs"] != measured["durationMs"]:
            raise ProviderError("review_cache_mismatch")
        return record, audio
    except (OSError, ValueError, KeyError, TypeError):
        raise ProviderError("review_cache_mismatch") from None


def review_audio_cached(entry: dict, provider: TTSProvider, cache: Path) -> bool:
    return _read_review_cache(entry, provider, cache) is not None


def _exclusive_json(path: Path, value: dict) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.write("\n")


async def produce_review_audio(pack: dict, text_id: str, provider: TTSProvider, output: Path,
                               cache: Path) -> dict:
    """Generate/reuse one whole-sentence normal-speed preview; never approves it."""
    entry = review_draft_text(pack, text_id)
    identity = review_audio_id(entry, provider.config)
    cache.mkdir(parents=True, exist_ok=True, mode=0o700)
    cached = _read_review_cache(entry, provider, cache)
    reused = cached is not None
    if cached is not None:
        record, audio = cached
    else:
        attempt_path = cache / f"{identity}.attempt.json"
        # Preserve uncertain/failed paid attempts for inspection rather than
        # automatically charging again on a retry of the CLI.
        try:
            _exclusive_json(attempt_path, {"purpose": "review-draft", "generationId": identity,
                            "status": "started", "characters": len(entry["hanzi"]),
                            "reservedCharacters": len(entry["hanzi"].encode("utf-8")),
                            "startedAt": datetime.now(timezone.utc).isoformat()})
        except FileExistsError:
            raise ProviderError("review_generation_needs_attention") from None
        request = TTSRequest(entry["id"], entry["version"], entry["hanzi"])
        audio, metadata = await provider.synthesize(request)
        from .audio import inspect_wav
        measured = inspect_wav(audio, max_bytes=15 * 1024 * 1024, max_seconds=180)
        provenance = provider.config.public_dict()
        record = {**metadata, **measured, "generationId": identity, "text": entry["hanzi"],
                  "sha256": hashlib.sha256(audio).hexdigest(), "configId": provider.config.config_id,
                  "source": "tts", "provider": provenance["provider"], "deployment": provenance["deployment"],
                  "model": provenance["model"], "voice": provenance["voice"], "generationConfig": provenance,
                  "generatedAt": datetime.now(timezone.utc).isoformat()}
        fd = os.open(cache / f"{identity}.wav", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as handle:
            handle.write(audio)
        _exclusive_json(cache / f"{identity}.json", record)
    # Stable, content-addressed public asset, safe even if the human-readable ID
    # is changed. Never overwrite a path with different bytes.
    output.mkdir(parents=True, exist_ok=True, mode=0o755)
    audio_path = output / f"{identity}.wav"
    if audio_path.exists():
        if hashlib.sha256(audio_path.read_bytes()).hexdigest() != record["sha256"]:
            raise ProviderError("review_asset_mismatch")
    else:
        fd = os.open(audio_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
        with os.fdopen(fd, "wb") as handle:
            handle.write(audio)
    return {**record, "id": entry["audio"]["normal"], "textId": entry["id"], "textVersion": entry["version"],
            "text": entry["hanzi"], "textSha256": hashlib.sha256(entry["hanzi"].encode()).hexdigest(),
            "pronunciation": entry.get("pronunciation"), "pronunciationVersion": entry["version"],
            "speed": "normal", "file": f"/audio/review-r1/{audio_path.name}",
            "purpose": "review-draft", "status": "generated", "reviewStatus": "pending",
            "listeningReview": "pending", "reviewIds": [], "reused": reused}
