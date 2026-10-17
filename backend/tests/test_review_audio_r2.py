"""R2 audio pipeline: local WAV fixtures and mocked TTS only; no real paid requests."""
import asyncio
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
    output = io.BytesIO()
    with wave.open(output, "wb") as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(24000)
        writer.writeframes(b"\x01\x00" * 2400)
    return output.getvalue()


@pytest.fixture
def review(tmp_path, monkeypatch):
    root = Path(__file__).resolve().parents[2]
    spec = importlib.util.spec_from_file_location("review_r2_test", root / "scripts" / "speech-review-r2.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    content = tmp_path / "content"
    (content / "versions").mkdir(parents=True)
    for file in ("batch-a.json", "audio-review-r1.json", "reviews.json", f"versions/{module.R1.VERSION}.json"):
        shutil.copyfile(root / "content" / file, content / file)
    source_folder = tmp_path / "frontend" / "public" / "audio" / "review-r1"
    shutil.copytree(root / "frontend" / "public" / "audio" / "review-r1", source_folder)
    monkeypatch.setattr(module, "ROOT", tmp_path)
    monkeypatch.setattr(module, "CACHE", tmp_path / "cache-r2")
    monkeypatch.setattr(module, "OUTPUT", tmp_path / "frontend" / "public" / "audio" / "review-r2")
    monkeypatch.setattr(module, "MANIFEST", content / "audio-review-r2.json")
    monkeypatch.setattr(module, "SOURCE", content / "audio-review-r1.json")
    monkeypatch.setattr(module.R1, "ROOT", tmp_path)
    monkeypatch.setattr(module.R1, "MANIFEST", module.SOURCE)
    monkeypatch.setattr(module.R1, "OUTPUT", source_folder)
    monkeypatch.setenv("DASHSCOPE_API_KEY", "mock-only-key")
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
            return wav(), {"upstreamRequestId": "mock-request", "usage": {"characters": len(request.text)},
                           "targetLanguage": "wuu", "providerLanguageParameter": "Chinese"}

    monkeypatch.setattr(module, "QwenTTS", MockProvider)
    pack = module.load_pack("content/batch-a.json")
    args = SimpleNamespace(command="generate", pack="content/batch-a.json", allow_paid_call=True,
                           expect_input_sha256=module.review_input_sha256(pack, module.selection(pack)))
    return module, pack, args, calls


def test_plan_never_calls_provider_and_reuses_exact_r1_sentences(review):
    module, pack, _, calls = review
    plan = module.plan(pack, module.QwenTTS(module.ProviderConfig.from_env("tts")))
    assert plan["networkCalls"] == 0 and calls == []
    assert plan["texts"] == 20 and plan["reusedFromR1"] == 17 and plan["pendingApiRequests"] == 3
    assert {entry["textId"]: entry["text"] for entry in plan["pendingTexts"]} == module.NEW_TEXTS
    reused = {entry["textId"]: entry["sourceTextId"] for entry in plan["reuse"]}
    assert reused["NX-N05"] == "NX-N02" and reused["NX-N06"] == "NX-N03"
    assert 0 < plan["estimatedNewCostCny"] < 1
    assert not module.MANIFEST.exists() and not module.OUTPUT.exists()


def test_generate_only_three_unique_new_assets_and_rerun_without_api_calls(review):
    module, pack, args, calls = review
    old_manifest = module.SOURCE.read_bytes()
    old_assets = {path.name: path.read_bytes() for path in module.R1.OUTPUT.glob("*.wav")}
    approval = module.R1.production_state_sha256(pack)
    result = asyncio.run(module.generate(args))
    assert result["newApiRequests"] == 3 and "networkCalls" not in result and len(calls) == 3
    assert {request.text_id: request.text for request in calls} == module.NEW_TEXTS
    assert result["clips"] == 20 and result["uniqueAudioFiles"] == 18
    assert len(list(module.OUTPUT.glob("*.wav"))) == 3
    assert module.SOURCE.read_bytes() == old_manifest
    assert {path.name: path.read_bytes() for path in module.R1.OUTPUT.glob("*.wav")} == old_assets
    assert module.R1.production_state_sha256(pack) == approval
    assert module.check_manifest(pack)["productionApprovalUnchanged"] is True
    repeated = asyncio.run(module.generate(args))
    assert repeated["newApiRequests"] == 0 and len(calls) == 3
    assert module.plan(pack, module.QwenTTS(module.ProviderConfig.from_env("tts")))["pendingApiRequests"] == 0


@pytest.mark.parametrize("kind,error", [("hash", "review_input_changed"), ("flag", "explicit_paid_call_flag_required"),
                                        ("text", "review_new_text_not_authorized")])
def test_paid_generation_requires_frozen_authorized_input(review, kind, error):
    module, pack, args, calls = review
    if kind == "hash":
        args.expect_input_sha256 = "a" * 64
    elif kind == "flag":
        args.allow_paid_call = False
    else:
        next(entry for entry in pack["dialogues"] if entry["id"] == "NX-N09")["hanzi"] = "未获授权的新句子"
        (module.ROOT / args.pack).write_text(json.dumps(pack))
    with pytest.raises(ProviderError, match=error):
        asyncio.run(module.generate(args))
    assert calls == []


@pytest.mark.parametrize("key,value,error", [
    ("text", "旧句子", "review_text_mismatch"),
    ("textVersion", "old-version", "review_text_mismatch"),
    ("file", "/audio/review-r2/../../private.wav", "review_asset_path_mismatch"),
    ("reviewStatus", "approved", "review_status_mismatch"),
    ("sha256", "a" * 64, "review_asset_mismatch"),
    ("durationMs", 1, "review_audio_metadata_mismatch"),
])
def test_offline_check_rejects_changed_text_metadata_status_or_bytes(review, key, value, error):
    module, pack, args, _ = review
    asyncio.run(module.generate(args))
    manifest = json.loads(module.MANIFEST.read_text())
    clip = next(clip for clip in manifest["clips"] if clip["textId"] == "NX-N09")
    clip[key] = value
    module.MANIFEST.write_text(json.dumps(manifest))
    with pytest.raises(ProviderError, match=error):
        module.check_manifest(pack)


def test_reused_audio_must_retain_verified_original_provenance(review):
    module, pack, args, _ = review
    asyncio.run(module.generate(args))
    manifest = json.loads(module.MANIFEST.read_text())
    clip = next(clip for clip in manifest["clips"] if clip["textId"] == "NX-N05")
    clip["reusedFrom"]["textId"] = "NX-N03"
    module.MANIFEST.write_text(json.dumps(manifest))
    with pytest.raises(ProviderError, match="review_reuse_provenance_mismatch"):
        module.check_manifest(pack)


def test_ambiguous_failed_attempt_is_not_retried(review, monkeypatch):
    module, _, args, calls = review

    async def fail(self, request):
        calls.append(request)
        raise ProviderError("timeout")

    monkeypatch.setattr(module.QwenTTS, "synthesize", fail)
    with pytest.raises(ProviderError, match="timeout"):
        asyncio.run(module.generate(args))
    with pytest.raises(ProviderError, match="review_generation_needs_attention"):
        asyncio.run(module.generate(args))
    assert len(calls) == 1
    assert not (module.CACHE / "batch.lock").exists()


def test_total_attempt_and_cost_limits(review, monkeypatch):
    module, pack, _, calls = review
    module.CACHE.mkdir()
    reservation = module.CACHE / "other.attempt.json"
    reservation.write_text('{"characters":1,"reservedCharacters":3}')
    with pytest.raises(ProviderError, match="review_request_limit_exceeded"):
        module.plan(pack, module.QwenTTS(module.ProviderConfig.from_env("tts")))
    reservation.unlink()
    monkeypatch.setattr(module, "BUDGET_CNY", module.Decimal("0.0001"))
    with pytest.raises(ProviderError, match="review_budget_exceeded"):
        module.plan(pack, module.QwenTTS(module.ProviderConfig.from_env("tts")))
    assert calls == []
