"""Swappable ASR: OpenAI-compatible adapter, provider selection, offline evaluation.

Mocked transport only; these are not real-model or Shanghainese quality tests.
"""
import asyncio
from dataclasses import replace
import io
import json
from pathlib import Path
import subprocess
import sys
from uuid import uuid4
import wave

import httpx
import pytest
from fastapi.testclient import TestClient

from app import evaluation
from app.main import create_app
from app.providers import (ASRRequest, OpenAICompatibleASR, OpenAICompatibleConfig, ProviderError, QwenASR,
                           asr_from_env)
from auth_helpers import start_guest

ROOT = Path(__file__).resolve().parents[2]


def wav(seconds=0.1, rate=16000):
    stream = io.BytesIO()
    with wave.open(stream, "wb") as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(rate)
        writer.writeframes(b"\x01\x00" * round(seconds * rate))
    return stream.getvalue()


@pytest.fixture
def local_env(monkeypatch):
    for key in ("LOCAL_ASR_API_KEY", "LOCAL_ASR_LANGUAGE", "APP_ENV"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("ASR_PROVIDER", "openai_compatible")
    monkeypatch.setenv("LOCAL_ASR_ENDPOINT", "http://127.0.0.1:8000")
    monkeypatch.setenv("LOCAL_ASR_MODEL", "local-test-model")
    monkeypatch.setenv("LOCAL_ASR_ENABLE_LIVE", "true")
    return monkeypatch


def test_default_provider_is_still_qwen(monkeypatch):
    monkeypatch.delenv("ASR_PROVIDER", raising=False)
    provider, config = asr_from_env()
    assert isinstance(provider, QwenASR) and config.model == "qwen3-asr-flash"


def test_unknown_provider_is_rejected_without_fallback(monkeypatch):
    monkeypatch.setenv("ASR_PROVIDER", "whatever")
    with pytest.raises(ProviderError, match="invalid_configuration"):
        asr_from_env()


@pytest.mark.parametrize("endpoint,production,ok", [
    ("http://127.0.0.1:8000", False, True), ("http://localhost:9000", False, True),
    ("https://asr.example.org", False, True), ("https://asr.example.org", True, True),
    ("http://asr.example.org", False, False), ("http://127.0.0.1:8000", True, False),
    ("https://user:pw@asr.example.org", False, False), ("https://asr.example.org/v1", False, False),
    ("ftp://127.0.0.1", False, False),
])
def test_endpoint_rules(local_env, endpoint, production, ok):
    local_env.setenv("LOCAL_ASR_ENDPOINT", endpoint)
    if production:
        local_env.setenv("APP_ENV", "production")
    if ok:
        assert OpenAICompatibleConfig.from_env().endpoint == endpoint
    else:
        with pytest.raises(ProviderError, match="invalid_configuration"):
            OpenAICompatibleConfig.from_env()


def test_model_is_required_and_disabled_by_default(local_env):
    local_env.delenv("LOCAL_ASR_ENABLE_LIVE")
    config = OpenAICompatibleConfig.from_env()
    assert config.ready is False
    with pytest.raises(ProviderError, match="service_disabled"):
        asyncio.run(OpenAICompatibleASR(config).transcribe(ASRRequest(wav(), "r")))
    local_env.setenv("LOCAL_ASR_MODEL", "")
    with pytest.raises(ProviderError, match="invalid_configuration"):
        OpenAICompatibleConfig.from_env()


def test_transcription_request_shape_and_secret_handling(local_env):
    local_env.setenv("LOCAL_ASR_API_KEY", "local-secret-not-real")
    local_env.setenv("LOCAL_ASR_LANGUAGE", "zh")
    local_env.setenv("DASHSCOPE_API_KEY", "dashscope-secret-not-real")
    seen = {}

    def handler(request):
        seen["url"], seen["auth"], seen["body"] = str(request.url), request.headers.get("authorization"), request.content
        return httpx.Response(200, json={"text": " 两份小笼 ", "language": "zh"})

    config = OpenAICompatibleConfig.from_env()
    result = asyncio.run(OpenAICompatibleASR(config, httpx.MockTransport(handler)).transcribe(ASRRequest(wav(), "r")))
    assert seen["url"] == "http://127.0.0.1:8000/v1/audio/transcriptions"
    assert seen["auth"] == "Bearer local-secret-not-real"
    assert b"local-test-model" in seen["body"] and b'name="language"' in seen["body"]
    assert b"dashscope-secret-not-real" not in seen["body"]
    assert (result.transcript, result.model, result.language, result.config_id) == ("两份小笼", "local-test-model", "zh", config.config_id)
    public = json.dumps(config.public_dict())
    assert "local-secret-not-real" not in public and "127.0.0.1" not in public and '"deployment": "local"' in public


@pytest.mark.parametrize("response,code", [
    (httpx.Response(200, json={"text": "  "}), "no_speech"),
    (httpx.Response(200, json={"nope": 1}), "invalid_response"),
    (httpx.Response(200, content=b"not json"), "invalid_response"),
    (httpx.Response(401), "authentication_failed"),
    (httpx.Response(503), "service_unavailable"),
])
def test_error_mapping(local_env, response, code):
    provider = OpenAICompatibleASR(OpenAICompatibleConfig.from_env(), httpx.MockTransport(lambda _: response))
    with pytest.raises(ProviderError, match=code):
        asyncio.run(provider.transcribe(ASRRequest(wav(), "r")))


def test_unreachable_local_server_is_retryable(local_env):
    def handler(request):
        raise httpx.ConnectError("refused", request=request)
    provider = OpenAICompatibleASR(OpenAICompatibleConfig.from_env(), httpx.MockTransport(handler))
    with pytest.raises(ProviderError) as caught:
        asyncio.run(provider.transcribe(ASRRequest(wav(), "r")))
    assert caught.value.code == "service_unavailable" and caught.value.retryable


def test_api_uses_selected_provider_and_binds_its_config(local_env, tmp_path):
    from app.providers import ASRResult
    calls = []

    async def transcribe(self, request):
        calls.append(type(self).__name__)
        return ASRResult("两份", "succeeded", 3, self.config.config_id, None, "local-test-model")

    local_env.setattr(OpenAICompatibleASR, "transcribe", transcribe)
    with TestClient(create_app(str(tmp_path / "t.db"))) as client:
        start_guest(client)
        services = client.get("/api/services").json()["asr"]
        assert services["enabled"] is True and services["provider"] == "openai-compatible"
        response = client.post("/api/asr", content=wav(), headers={"content-type": "audio/wav", "x-request-id": str(uuid4())})
        assert response.status_code == 200, response.text
        assert response.json()["text"] == "两份" and calls == ["OpenAICompatibleASR"]
        local_env.setenv("LOCAL_ASR_MODEL", "another-model")
        changed = client.post("/api/asr", content=wav(), headers={"content-type": "audio/wav", "x-request-id": str(uuid4())})
        assert changed.status_code == 409 and changed.json()["detail"]["code"] == "configuration_changed"


def test_evaluation_metrics_and_manifest_validation():
    target = {"type": "set_order", "quantity": 2, "unit": "serving"}
    item = lambda i, label: {"id": i, "station": "nanxiang", "step": "quantity", "target": target, "label": label, "reference": "两份"}
    rows = [evaluation.judge(item("a", "acceptable"), "两份"), evaluation.judge(item("b", "understandable"), "量份"),
            evaluation.judge(item("c", "incorrect"), "不要两份"), evaluation.judge(item("d", "acceptable"), None, "timeout")]
    assert [r["outcome"] for r in rows] == ["true_pass", "false_reject", "true_retry", "technical_failure"]
    summary = evaluation.summarize(rows)
    assert (summary["false_reject_rate"], summary["false_accept_rate"]) == (0.5, 0.0)
    assert evaluation.cer("两份", "两份。") == 0 and evaluation.cer("两份", "量份") == 0.5
    with pytest.raises(evaluation.ManifestError):
        evaluation.validate([item("x", "great")])
    with pytest.raises(evaluation.ManifestError):
        evaluation.validate([{**item("x", "acceptable"), "station": "teahouse", "step": "thanks", "target": "fish"}])


def test_eval_script_example_runs_offline_and_refuses_paid_calls():
    script, example = ROOT / "scripts" / "asr-eval.py", ROOT / "scripts" / "asr-eval.example.json"
    done = subprocess.run([sys.executable, str(script), str(example)], capture_output=True, text=True, cwd=ROOT)
    assert done.returncode == 0, done.stderr
    report = json.loads(done.stdout)
    assert report["paid_calls"] == 0 and report["providers"][0]["false_accept_rate"] == 0.0
    assert "两份" not in done.stdout  # Transcripts stay in the ignored artifact unless requested.
    paid = subprocess.run([sys.executable, str(script), str(example), "--provider", "qwen"], capture_output=True, text=True, cwd=ROOT)
    assert paid.returncode == 1 and "explicit_paid_call_flag_required" in paid.stderr


@pytest.fixture
def tts_env(monkeypatch):
    for key in ("LOCAL_TTS_API_KEY", "LOCAL_TTS_LANGUAGE", "APP_ENV"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("TTS_PROVIDER", "openai_compatible")
    monkeypatch.setenv("LOCAL_TTS_ENDPOINT", "http://127.0.0.1:9880")
    monkeypatch.setenv("LOCAL_TTS_MODEL", "cosyvoice-test")
    monkeypatch.setenv("LOCAL_TTS_VOICE", "shanghai-test")
    monkeypatch.setenv("LOCAL_TTS_ENABLE_LIVE", "true")
    return monkeypatch


def test_default_tts_is_still_qwen_jada(monkeypatch):
    from app.providers import QwenTTS, tts_from_env
    monkeypatch.delenv("TTS_PROVIDER", raising=False)
    provider = tts_from_env()
    assert isinstance(provider, QwenTTS) and provider.config.voice == "Jada"


def test_local_tts_request_and_pending_review_metadata(tts_env):
    from app.providers import OpenAICompatibleTTS, TTSRequest, tts_from_env
    seen = {}

    def handler(request):
        seen["url"], seen["body"] = str(request.url), json.loads(request.content)
        return httpx.Response(200, content=wav(0.5, 24000))

    provider = tts_from_env(httpx.MockTransport(handler))
    assert isinstance(provider, OpenAICompatibleTTS)
    audio, meta = asyncio.run(provider.synthesize(TTSRequest("E08", "v1", "两份小笼")))
    assert seen["url"] == "http://127.0.0.1:9880/v1/audio/speech"
    assert seen["body"] == {"model": "cosyvoice-test", "input": "两份小笼", "voice": "shanghai-test", "response_format": "wav"}
    assert meta["status"] == meta["listeningReview"] == "pending" and meta["durationMs"] == 500
    assert meta["configId"].startswith("tts-") and provider.config.public_dict()["voice"] == "shanghai-test"


def test_local_tts_rejects_slow_speed_bad_audio_and_requires_voice(tts_env):
    from app.providers import TTSRequest, tts_from_env
    provider = tts_from_env(httpx.MockTransport(lambda _: httpx.Response(200, content=b"not audio")))
    with pytest.raises(ProviderError, match="unsupported_speed"):
        asyncio.run(provider.synthesize(TTSRequest("E08", "v1", "两份", speed="slow")))
    with pytest.raises(ProviderError, match="unsupported_format"):
        asyncio.run(provider.synthesize(TTSRequest("E08", "v1", "两份")))
    tts_env.delenv("LOCAL_TTS_VOICE")
    with pytest.raises(ProviderError, match="invalid_configuration"):
        tts_from_env()


class FakeExtractor:
    """Stands in for WavLM: one 2-D vector per 20 ms frame, from frame energy and sign changes."""
    name = "fake-extractor"

    def features(self, samples, rate):
        size = rate // 50
        frames = [samples[i:i + size] for i in range(0, len(samples) - size + 1, size)]
        return [[sum(abs(v) for v in f) / size + 1e-3, sum((a < 0) != (b < 0) for a, b in zip(f, f[1:])) / size + 1e-3]
                for f in frames]


def tone(freq, seconds, rate=16000, amplitude=0.5):
    import math
    stream = io.BytesIO()
    with wave.open(stream, "wb") as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(rate)
        writer.writeframes(b"".join(int(amplitude * 32767 * math.sin(2 * math.pi * freq * i / rate)).to_bytes(2, "little", signed=True)
                                    for i in range(round(seconds * rate))))
    return stream.getvalue()


def test_dtw_similarity_is_time_tolerant_and_separates_different_audio():
    from app import acoustic
    same = acoustic.compare(tone(220, 0.4), tone(220, 0.4), FakeExtractor())["similarity"]
    slower = acoustic.compare(tone(220, 0.7, 24000), tone(220, 0.4), FakeExtractor())["similarity"]
    different = acoustic.dtw_similarity([[1.0, 0.0]] * 5, [[0.0, 1.0]] * 5)
    assert same == 1.0 and slower > 0.98 and different == 0.0


def test_acoustic_observations_are_free_until_calibrated():
    from app import acoustic, scoring
    uncalibrated = acoustic.observations(0.2)
    assert uncalibrated[0]["uncertain"] is True and scoring.score(uncalibrated)["score"] == 100
    calibration = {"minor_below": 0.8, "severe_below": 0.4, "confidence": 0.9}
    assert acoustic.observations(0.9, calibration) == []
    assert scoring.score(acoustic.observations(0.6, calibration))["score"] == 98
    assert scoring.score(acoustic.observations(0.3, calibration))["verdict"] == "retry"


def test_missing_acoustic_dependencies_fail_clearly(monkeypatch):
    import builtins
    from app import acoustic
    real_import = builtins.__import__
    monkeypatch.setattr(builtins, "__import__", lambda name, *a, **k: (_ for _ in ()).throw(ImportError()) if name in ("torch", "transformers") else real_import(name, *a, **k))
    with pytest.raises(ProviderError, match="acoustic_dependencies_missing"):
        acoustic.WavLMExtractor().features([0.0] * 1600, 16000)


def test_evaluation_records_acoustic_similarity_by_label():
    target = {"type": "set_order", "quantity": 2, "unit": "serving"}
    item = {"id": "a", "station": "nanxiang", "step": "quantity", "target": target, "label": "acceptable"}
    row = {**evaluation.judge(item, "两份", observations=[{"type": "minor_tone", "uncertain": True}]), "acoustic_similarity": 0.8}
    assert row["score"] == 100 and row["deductions"][0]["uncertain"] is True
    assert evaluation.summarize([row])["mean_acoustic_similarity_by_label"] == {"acceptable": 0.8}
