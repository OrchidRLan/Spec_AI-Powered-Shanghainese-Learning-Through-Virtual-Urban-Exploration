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
