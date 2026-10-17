"""B+C offline audio safety uses only synthetic PCM and a mock TTS provider."""
import asyncio
from copy import deepcopy
from decimal import Decimal
import importlib.util
import io
import json
from pathlib import Path
import shutil
from types import SimpleNamespace
import wave

import pytest

from app.providers import ProviderError


def wav():
    result = io.BytesIO()
    with wave.open(result, "wb") as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(24000)
        writer.writeframes(b"\x01\x00" * 2400)
    return result.getvalue()


@pytest.fixture
def review(tmp_path, monkeypatch):
    root = Path(__file__).resolve().parents[2]
    spec = importlib.util.spec_from_file_location("review_bc_test", root / "scripts" / "speech-review-bc.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    (tmp_path / "content").mkdir()
    shutil.copyfile(root / "content/reviews.json", tmp_path / "content/reviews.json")
    source = next(c for c in json.loads((root / "content/audio-review-r1.json").read_text())["clips"] if c["textId"] == "E05")
    source_file = Path("frontend/public") / source["file"].lstrip("/")
    (tmp_path / source_file).parent.mkdir(parents=True)
    shutil.copyfile(root / source_file, tmp_path / source_file)
    sources = [{"manifest": "content/audio-review-r1.json", "clip": source}]
    monkeypatch.setattr(module, "ROOT", tmp_path)
    monkeypatch.setattr(module.R1, "ROOT", tmp_path)
    monkeypatch.setattr(module, "CACHE", tmp_path / "cache")
    monkeypatch.setattr(module, "OUTPUT", tmp_path / "frontend/public/audio/review-bc")
    monkeypatch.setattr(module, "MANIFEST", tmp_path / "content/audio-review-bc.json")
    monkeypatch.setattr(module, "source_clips", lambda: deepcopy(sources))
    monkeypatch.setattr(module, "source_digest", lambda: module._sha(sources))
    monkeypatch.setenv("DASHSCOPE_API_KEY", "synthetic-test-key")
    monkeypatch.delenv("QWEN_TTS_API_KEY", raising=False)
    monkeypatch.setenv("QWEN_TTS_MODEL", "qwen3-tts-flash")
    monkeypatch.setenv("QWEN_TTS_REGION", "beijing")
    monkeypatch.delenv("QWEN_TTS_ENDPOINT", raising=False)
    calls = []

    class MockProvider:
        def __init__(self, config):
            self.config = config

        async def synthesize(self, request):
            calls.append(request)
            return wav(), {"upstreamRequestId": "synthetic-request", "usage": {"characters": len(request.text)},
                           "targetLanguage": "wuu", "providerLanguageParameter": "Chinese"}

    monkeypatch.setattr(module, "QwenTTS", MockProvider)
    entries = []
    for text_id, text in (("BC-SOURCE", source["text"]), ("BC-ONE", "谢谢侬。"),
                          ("BC-TWO", "侬好。"), ("BC-ONE-AGAIN", "谢谢侬。")):
        entries.append({"id": text_id, "version": module.VERSION, "hanzi": text, "pronunciation": "candidate",
                        "segments": [{"id": text_id + "-S1", "hanzi": text, "pronunciation": "candidate"}],
                        "audio": {"normal": text_id + ".normal"},
                        "review": {"status": "draft", "language": "pending", "pronunciation": "pending",
                                   "approximation": "pending", "audio": "pending", "recordIds": []}})
    pack = {"contentVersion": module.VERSION, "status": "draft", "entries": entries}
    (tmp_path / module.PACK_PATH).write_text(json.dumps(pack))
    preview = module.plan(pack, MockProvider(module.ProviderConfig.from_env("tts")))
    args = SimpleNamespace(command="generate", pack=module.PACK_PATH, allow_paid_call=True,
                           expect_input_sha256=preview["inputSha256"], expect_content_sha256=preview["sourceContentSha256"],
                           expect_config_id=preview["configId"], max_calls=100, max_cost_cny=Decimal("2"))
    return module, pack, args, calls


def test_offline_plan_deduplicates_new_texts_and_reuses_existing_audio_without_writes(review):
    module, pack, _, calls = review
    preview = module.plan(pack, module.QwenTTS(module.ProviderConfig.from_env("tts")))
    assert preview["texts"] == 4 and preview["pendingApiRequests"] == 2
    assert preview["reusedFromEarlierBatches"] == 1
    assert preview["networkCalls"] == 0 and calls == []
    assert not module.CACHE.exists() and not module.OUTPUT.exists() and not module.MANIFEST.exists()
    assert "synthetic-test-key" not in json.dumps(preview)


def test_generate_rebinds_versions_keeps_pending_and_repeat_is_free(review):
    module, pack, args, calls = review
    result = asyncio.run(module.generate(args))
    assert result["newApiRequests"] == result["generatedForBC"] == len(calls) == 2
    assert result["clips"] == 4 and result["uniqueAudioFiles"] == 3
    assert result["reusedFromEarlierBatches"] == 1
    assert module.check_manifest(pack)["networkCalls"] == 0
    manifest = json.loads(module.MANIFEST.read_text())
    assert {c["textVersion"] for c in manifest["clips"]} == {module.VERSION}
    assert all(c["reviewStatus"] == "pending" and c["reviewIds"] == [] for c in manifest["clips"])
    assert len(list(module.OUTPUT.glob("*.wav"))) == 2
    again = asyncio.run(module.generate(args))
    assert again["newApiRequests"] == 0 and len(calls) == 2
    assert "synthetic-test-key" not in module.MANIFEST.read_text()


@pytest.mark.parametrize("field,value,error", [
    ("allow_paid_call", False, "explicit_paid_call_flag_required"),
    ("expect_input_sha256", "changed", "review_input_changed"),
    ("expect_content_sha256", "changed", "review_input_changed"),
    ("expect_config_id", "changed", "review_input_changed"),
])
def test_generation_requires_exact_frozen_text_content_and_configuration(review, field, value, error):
    module, _, args, calls = review
    setattr(args, field, value)
    with pytest.raises(ProviderError, match=error):
        asyncio.run(module.generate(args))
    assert calls == [] and not module.CACHE.exists()


@pytest.mark.parametrize("limit,budget,error", [
    (0, "2", "review_request_limit_exceeded"), (101, "2", "review_request_limit_exceeded"),
    (1, "2", "review_request_limit_exceeded"), (100, "3", "review_budget_exceeded"),
    (100, "0.00001", "review_budget_exceeded"), (100, "NaN", "review_budget_exceeded"),
])
def test_hard_budget_applies_to_entire_plan_before_any_request(review, limit, budget, error):
    module, pack, _, calls = review
    with pytest.raises(ProviderError, match=error):
        module.plan(pack, module.QwenTTS(module.ProviderConfig.from_env("tts")), limit, Decimal(budget))
    assert calls == []


def test_failed_or_uncertain_request_is_never_automatically_retried(review, monkeypatch):
    module, _, args, calls = review

    async def fail(self, request):
        calls.append(request)
        raise ProviderError("timeout")

    monkeypatch.setattr(module.QwenTTS, "synthesize", fail)
    with pytest.raises(ProviderError, match="timeout"):
        asyncio.run(module.generate(args))
    with pytest.raises(ProviderError, match="review_generation_needs_attention"):
        asyncio.run(module.generate(args))
    assert len(calls) == 1 and len(list(module.CACHE.glob("*.attempt.json"))) == 1
    assert not (module.CACHE / "batch.lock").exists()


def test_revised_romanization_reuses_identical_sound_but_requires_new_frozen_manifest(review):
    module, pack, args, calls = review
    asyncio.run(module.generate(args))
    pack["entries"][1]["pronunciation"] = "revised candidate"
    (module.ROOT / module.PACK_PATH).write_text(json.dumps(pack))
    with pytest.raises(ProviderError, match="review_input_changed"):
        asyncio.run(module.generate(args))
    preview = module.plan(pack, module.QwenTTS(module.ProviderConfig.from_env("tts")))
    assert preview["pendingApiRequests"] == 0
    args.expect_input_sha256, args.expect_content_sha256 = preview["inputSha256"], preview["sourceContentSha256"]
    result = asyncio.run(module.generate(args))
    assert result["newApiRequests"] == 0 and len(calls) == 2
    assert module.check_manifest(pack)["status"] == "passed"


@pytest.mark.parametrize("field,value,error", [
    ("text", "wrong sentence", "review_text_mismatch"), ("textVersion", "old", "review_text_mismatch"),
    ("pronunciation", "wrong", "review_text_mismatch"), ("reviewStatus", "approved", "review_status_mismatch"),
    ("file", "/audio/review-bc/wrong.wav", "review_asset_path_mismatch"),
    ("durationMs", 1, "review_audio_metadata_mismatch"), ("sha256", "a" * 64, "review_asset_mismatch"),
    ("voice", "Another", "review_generation_config_mismatch"),
])
def test_audio_audit_rejects_stale_words_and_wrong_asset_or_metadata(review, field, value, error):
    module, pack, args, _ = review
    asyncio.run(module.generate(args))
    manifest = json.loads(module.MANIFEST.read_text())
    manifest["clips"][1][field] = value
    module.MANIFEST.write_text(json.dumps(manifest))
    with pytest.raises(ProviderError, match=error):
        module.check_manifest(pack)


def test_reused_asset_requires_exact_source_provenance(review):
    module, pack, args, _ = review
    asyncio.run(module.generate(args))
    manifest = json.loads(module.MANIFEST.read_text())
    manifest["clips"][0]["reusedFrom"]["textId"] = "wrong-source"
    module.MANIFEST.write_text(json.dumps(manifest))
    with pytest.raises(ProviderError, match="review_reuse_provenance_mismatch"):
        module.check_manifest(pack)


def test_incomplete_or_duplicated_manifest_cannot_pass(review):
    module, pack, args, _ = review
    asyncio.run(module.generate(args))
    manifest = json.loads(module.MANIFEST.read_text())
    manifest["clips"][2] = manifest["clips"][1]
    module.MANIFEST.write_text(json.dumps(manifest))
    with pytest.raises(ProviderError, match="review_manifest_incomplete"):
        module.check_manifest(pack)


def test_corrupt_cache_cannot_trigger_another_paid_call(review):
    module, _, args, calls = review
    asyncio.run(module.generate(args))
    next(module.CACHE.glob("*.wav")).write_bytes(b"not a wav")
    with pytest.raises(ProviderError, match="review_cache_mismatch"):
        asyncio.run(module.generate(args))
    assert len(calls) == 2


def test_attempts_without_known_results_still_consume_budget(review):
    module, pack, _, calls = review
    module.CACHE.mkdir()
    (module.CACHE / "unknown.attempt.json").write_text('{"characters":1,"reservedCharacters":30000}')
    with pytest.raises(ProviderError, match="review_budget_exceeded"):
        module.plan(pack, module.QwenTTS(module.ProviderConfig.from_env("tts")))
    assert calls == []


def test_source_audio_with_another_config_is_not_reused(review, monkeypatch):
    module, pack, _, _ = review
    sources = module.source_clips()
    sources[0]["clip"]["configId"] = "another-config"
    monkeypatch.setattr(module, "source_clips", lambda: sources)
    preview = module.plan(pack, module.QwenTTS(module.ProviderConfig.from_env("tts")))
    assert preview["reusedFromEarlierBatches"] == 0 and preview["pendingApiRequests"] == 3


def test_clean_checkout_reuses_verified_public_files_without_private_cache(review):
    module, pack, args, calls = review
    asyncio.run(module.generate(args))
    shutil.rmtree(module.CACHE)
    preview = module.plan(pack, module.QwenTTS(module.ProviderConfig.from_env("tts")))
    assert preview["pendingApiRequests"] == 0 and len(preview["publicCachedBCTextIds"]) == 3
    result = asyncio.run(module.generate(args))
    assert result["newApiRequests"] == 0 and len(calls) == 2
    assert not list(module.CACHE.glob("*.attempt.json"))
    assert module.check_manifest(pack)["status"] == "passed"


def test_public_file_without_verified_record_does_not_trigger_paid_regeneration(review):
    module, pack, args, calls = review
    asyncio.run(module.generate(args))
    shutil.rmtree(module.CACHE)
    module.MANIFEST.unlink()
    with pytest.raises(ProviderError, match="review_generation_needs_attention"):
        module.plan(pack, module.QwenTTS(module.ProviderConfig.from_env("tts")))
    assert len(calls) == 2


def test_invalid_public_manifest_stops_without_charging_again(review):
    module, pack, args, calls = review
    asyncio.run(module.generate(args))
    shutil.rmtree(module.CACHE)
    manifest = json.loads(module.MANIFEST.read_text())
    manifest["clips"][1]["sha256"] = "a" * 64
    module.MANIFEST.write_text(json.dumps(manifest))
    with pytest.raises(ProviderError, match="review_asset_mismatch"):
        asyncio.run(module.generate(args))
    assert len(calls) == 2
