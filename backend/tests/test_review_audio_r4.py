"""R4 confirmation generation tests use only synthetic WAVs and a mock provider."""
import asyncio
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
    spec = importlib.util.spec_from_file_location("review_r4_test", root / "scripts" / "speech-review-r4.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    (tmp_path / "content" / "versions").mkdir(parents=True)
    for file in (module.PACK_PATH, module.SOURCE_PATH, "content/reviews.json"):
        shutil.copyfile(root / file, tmp_path / file)
    monkeypatch.setattr(module, "ROOT", tmp_path)
    monkeypatch.setattr(module.R1, "ROOT", tmp_path)
    monkeypatch.setattr(module, "CACHE", tmp_path / "cache")
    monkeypatch.setattr(module, "OUTPUT", tmp_path / "frontend" / "public" / "audio" / "review-r4")
    monkeypatch.setattr(module, "MANIFEST", tmp_path / "content" / "audio-review-r4.json")
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
    pack = module.load_pack(module.PACK_PATH)
    args = SimpleNamespace(command="generate", pack=module.PACK_PATH, allow_paid_call=True,
                           expect_input_sha256=module.review_input_sha256(pack, module.selection(pack)),
                           max_calls=6, max_cost_cny=Decimal("1"))
    return module, pack, args, calls


def test_six_whole_sentences_are_planned_offline_with_no_writes(review):
    module, pack, _, calls = review
    plan = module.plan(pack, module.QwenTTS(module.ProviderConfig.from_env("tts")))
    assert plan["networkCalls"] == 0 and calls == []
    assert plan["pendingApiRequests"] == plan["texts"] == 6
    assert {e["textId"]: e["text"] for e in plan["pendingTexts"]} == module.NEW_TEXTS
    assert plan["pendingReservedCharacters"] == 252
    assert 0 < plan["estimatedNewCostCny"] < 1
    assert not module.MANIFEST.exists() and not module.OUTPUT.exists() and not module.CACHE.exists()


def test_generation_has_six_whole_files_exact_metadata_and_no_repeat_billing(review):
    module, pack, args, calls = review
    original_pack = (module.ROOT / module.PACK_PATH).read_bytes()
    source = (module.ROOT / module.SOURCE_PATH).read_bytes()
    ledger = (module.ROOT / "content/reviews.json").read_bytes()
    result = asyncio.run(module.generate(args))
    assert result["newApiRequests"] == 6 and len(calls) == 6
    assert {request.text_id: request.text for request in calls} == module.NEW_TEXTS
    assert result["uniqueAudioFiles"] == 6 and result["wholeSentenceAssets"] is True
    assert "networkCalls" not in result
    assert len(list(module.OUTPUT.glob("*.wav"))) == 6
    assert len(list(module.CACHE.glob("*.attempt.json"))) == 6
    assert (module.ROOT / module.PACK_PATH).read_bytes() == original_pack
    assert (module.ROOT / module.SOURCE_PATH).read_bytes() == source
    assert (module.ROOT / "content/reviews.json").read_bytes() == ledger
    assert module.check_manifest(pack)["reviewStatus"] == "pending"
    repeated = asyncio.run(module.generate(args))
    assert repeated["newApiRequests"] == 0 and len(calls) == 6


@pytest.mark.parametrize("kind,error", [
    ("hash", "review_input_changed"), ("flag", "explicit_paid_call_flag_required"),
    ("text", "review_new_text_not_authorized"), ("reading", "review_new_text_not_authorized"),
    ("order", "review_new_text_not_authorized"), ("approval", "review_status_mismatch"),
])
def test_generation_rejects_unfrozen_text_readings_mapping_and_approval(review, kind, error):
    module, pack, args, calls = review
    if kind == "hash":
        args.expect_input_sha256 = "a" * 64
    elif kind == "flag":
        args.allow_paid_call = False
    else:
        entry = pack["dialogues"][0]
        if kind == "text":
            entry["hanzi"] = "新句子"
        elif kind == "reading":
            entry["segments"][0]["pronunciation"] = "invented"
        elif kind == "order":
            entry["order"]["normalized_servings"] = 2
        elif kind == "approval":
            entry["review"]["language"] = "approved"
        (module.ROOT / args.pack).write_text(json.dumps(pack))
    with pytest.raises(ProviderError, match=error):
        asyncio.run(module.generate(args))
    assert calls == []


@pytest.mark.parametrize("calls_limit,budget,error", [
    (7, "1", "review_request_limit_exceeded"), (5, "1", "review_request_limit_exceeded"),
    (6, "2", "review_budget_exceeded"), (6, "0.0001", "review_budget_exceeded"),
    (6, "NaN", "review_budget_exceeded"),
])
def test_caller_limits_cannot_exceed_hard_budget_or_allow_partial_unplanned_calls(review, calls_limit, budget, error):
    module, pack, _, calls = review
    with pytest.raises(ProviderError, match=error):
        module.plan(pack, module.QwenTTS(module.ProviderConfig.from_env("tts")), calls_limit, Decimal(budget))
    assert calls == []


def test_uncertain_request_is_preserved_and_never_automatically_retried(review, monkeypatch):
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


def test_unrelated_reserved_attempt_consumes_same_batch_limit(review):
    module, pack, _, calls = review
    module.CACHE.mkdir()
    (module.CACHE / "unknown.attempt.json").write_text('{"characters":1,"reservedCharacters":3}')
    with pytest.raises(ProviderError, match="review_request_limit_exceeded"):
        module.plan(pack, module.QwenTTS(module.ProviderConfig.from_env("tts")))
    assert calls == []


@pytest.mark.parametrize("key,value,error", [
    ("text", "对伐？", "review_text_mismatch"), ("textVersion", "old", "review_text_mismatch"),
    ("pronunciation", "wrong", "review_text_mismatch"), ("reviewStatus", "approved", "review_status_mismatch"),
    ("file", "/audio/review-r1/wrong.wav", "review_asset_path_mismatch"),
    ("durationMs", 1, "review_audio_metadata_mismatch"), ("sha256", "a" * 64, "review_asset_mismatch"),
])
def test_offline_check_rejects_wrong_sentence_audio_provenance_or_metadata(review, key, value, error):
    module, pack, args, _ = review
    asyncio.run(module.generate(args))
    manifest = json.loads(module.MANIFEST.read_text())
    manifest["clips"][0][key] = value
    module.MANIFEST.write_text(json.dumps(manifest))
    with pytest.raises(ProviderError, match=error):
        module.check_manifest(pack)


def test_same_audio_cannot_be_relabelled_for_two_order_variants(review):
    module, pack, args, _ = review
    asyncio.run(module.generate(args))
    manifest = json.loads(module.MANIFEST.read_text())
    manifest["clips"][1]["file"] = manifest["clips"][0]["file"]
    module.MANIFEST.write_text(json.dumps(manifest))
    with pytest.raises(ProviderError, match="review_manifest_incomplete"):
        module.check_manifest(pack)
