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


QTY = {"type": "set_order", "quantity": 2, "unit": "serving"}


def qty_item(i, label, reference, **extra):
    return {"id": i, "station": "nanxiang", "step": "quantity", "target": QTY, "label": label, "reference": reference, **extra}


def test_cer_is_reported_per_item_and_per_corpus_with_fixed_normalization():
    rows = [evaluation.judge(qty_item("a", "acceptable", "两份"), "量份"),            # 1 edit / 2 chars
            evaluation.judge(qty_item("b", "acceptable", "我要两份小笼馒头"), "我要两份小笼馒头")]  # 0 / 8
    summary = evaluation.summarize(rows)
    assert (summary["mean_cer"], summary["corpus_cer"], summary["cer_items"]) == (0.25, 0.1, 2)
    assert summary["cer_normalization"] == "cer-norm.v1"
    assert evaluation.cer("清蒸魚", "清蒸鱼") == 0  # traditional/simplified is not an error
    assert evaluation.cer("侬好", "你好") == 0.5  # a Mandarin word choice still is


def test_latency_reports_median_and_p95_separately_from_mean():
    rows = [{**evaluation.judge(qty_item(str(i), "acceptable", "两份"), "两份"), "elapsed_ms": ms}
            for i, ms in enumerate([100, 200, 300, 400, 5000])]
    summary = evaluation.summarize(rows)
    assert (summary["median_latency_ms"], summary["p95_latency_ms"], summary["mean_latency_ms"]) == (300, 5000, 1200)


def test_attribution_separates_asr_errors_from_rule_errors():
    asr = evaluation.judge(qty_item("asr", "acceptable", "两份"), "三份")   # the speaker was right, ASR was not
    rule = evaluation.judge(qty_item("rule", "acceptable", "两客"), "两客")  # ASR is perfect, rules reject it
    ok = evaluation.judge(qty_item("ok", "incorrect", "不要两份"), "不要两份")
    tech = evaluation.judge(qty_item("t", "acceptable", "两份"), None, "timeout")
    assert [r["attribution"] for r in (asr, rule, ok, tech)] == ["asr_error", "rule_error", "ok", None]
    assert asr["reference_verdict"] == "pass" and rule["reference_verdict"] == "retry"
    summary = evaluation.summarize([asr, rule, ok, tech])
    assert summary["technical_failure_reasons"] == {"timeout": 1} and summary["technical_failure_rate"] == 0.25
    assert (summary["acceptable_or_understandable_n"], summary["incorrect_n"]) == (2, 1)


def test_breakdowns_by_station_group_and_condition():
    rows = [evaluation.judge(qty_item("a", "acceptable", "两份", speaker_group="beginner", condition="canonical"), "两份"),
            evaluation.judge(qty_item("b", "incorrect", "三份", speaker_group="fluent", condition="wrong_quantity"), "三份")]
    summary = evaluation.summarize(rows)
    assert summary["by_speaker_group"]["beginner"]["false_reject_rate"] == 0.0
    assert summary["by_condition"]["wrong_quantity"]["false_accept_rate"] == 0.0
    assert set(summary["by_station"]) == {"nanxiang"}


def test_manifest_privacy_and_split_rules():
    with pytest.raises(evaluation.ManifestError, match="anonymous"):
        evaluation.validate([qty_item("a", "acceptable", "两份", speaker_id="Ruolan")])
    with pytest.raises(evaluation.ManifestError, match="synthetic"):
        evaluation.validate([qty_item("a", "acceptable", "两份", source="synthetic", speaker_group="fluent")])
    with pytest.raises(evaluation.ManifestError, match="both dev and test"):
        evaluation.validate([qty_item("a", "acceptable", "两份", utterance_group="u1", split="dev"),
                             qty_item("b", "acceptable", "两份", utterance_group="u1", split="test")])
    with pytest.raises(evaluation.ManifestError, match="condition"):
        evaluation.validate([qty_item("a", "acceptable", "两份", condition="easy")])
    warnings = evaluation.validate([qty_item("a", "acceptable", "两份", speaker_id="S01", split="dev"),
                                    qty_item("b", "acceptable", "两份", speaker_id="S01", split="test")])
    assert warnings == ["speaker S01 appears in both dev and test"]


def test_eval_script_guards_held_out_split_and_audio_leakage(tmp_path):
    script = ROOT / "scripts" / "asr-eval.py"
    (tmp_path / "a.wav").write_bytes(wav())
    (tmp_path / "b.wav").write_bytes(wav())
    base = {"station": "nanxiang", "step": "quantity", "target": QTY, "label": "acceptable", "reference": "两份",
            "transcript": "两份"}
    def run(items, *extra):
        manifest = tmp_path / "m.json"
        manifest.write_text(json.dumps({"version": "t1", "items": items}, ensure_ascii=False))
        return subprocess.run([sys.executable, str(script), str(manifest), *extra], capture_output=True, text=True, cwd=ROOT)
    leaked = run([{**base, "id": "a", "audio": "a.wav", "split": "dev"}, {**base, "id": "b", "audio": "b.wav", "split": "test"}])
    assert leaked.returncode == 1 and "identical audio" in leaked.stderr
    (tmp_path / "b.wav").write_bytes(wav() + b"\0\0")
    unreviewed = run([{**base, "id": "a", "audio": "a.wav", "split": "dev"}, {**base, "id": "b", "audio": "b.wav", "split": "test"}],
                     "--split", "test")
    assert unreviewed.returncode == 1 and "reviewed_by" in unreviewed.stderr
    reviewed = run([{**base, "id": "a", "audio": "a.wav", "split": "dev"},
                    {**base, "id": "b", "audio": "b.wav", "split": "test", "reviewed_by": ["R01"]}], "--split", "test")
    assert reviewed.returncode == 0, reviewed.stderr
    report = json.loads(reviewed.stdout)
    assert report["providers"][0]["items"] == 1 and report["split"] == "test"
    saved = json.loads((ROOT / report["results"]).read_text())
    assert saved["manifest_version"] == "t1" and len(saved["manifest_sha256"]) == 64
    assert saved["rule_versions"]["scoring"] == "lenient-rules.v1" and saved["reports"][0]["rows"][0]["input_sha256"]


def test_recording_plan_is_valid_and_prepare_tool_keeps_data_private():
    import csv
    import shutil
    plan = json.loads((ROOT / "scripts" / "asr-eval-plan.json").read_text())
    items = [{"id": p["prompt_id"], "label": p["intended_label"], "station": p["station"], "step": p["step"],
              "target": p["target"], "condition": p["condition"], **({"candy_flavor": p["candy_flavor"]} if "candy_flavor" in p else {})}
             for p in plan["prompts"]]
    assert evaluation.validate(items) == []
    assert {"negation", "wrong_target", "wrong_quantity", "self_correction", "silence"} <= {i["condition"] for i in items}
    tool, work = ROOT / "scripts" / "asr-eval-prepare.py", ROOT / "private" / "_pytest-prepare"
    shutil.rmtree(work, ignore_errors=True)
    try:
        run = lambda *a: subprocess.run([sys.executable, str(tool), *map(str, a)], capture_output=True, text=True, cwd=ROOT)
        assert run("sheet", "--speaker", "S01", "--group", "fluent", "--split", "dev", "--out", "/tmp/x.csv").returncode != 0
        assert run("sheet", "--speaker", "Alice", "--group", "fluent", "--split", "dev", "--out", work / "a.csv").returncode != 0
        assert run("sheet", "--speaker", "S01", "--group", "fluent", "--split", "dev", "--out", work / "s.csv").returncode == 0
        (work / "S01").mkdir()
        (work / "S01" / "NX-QTY-SHORT.wav").write_bytes(wav())
        rows = [r for r in csv.DictReader((work / "s.csv").open()) if r["prompt_id"] == "NX-QTY-SHORT"]
        with (work / "s.csv").open("w", newline="") as handle:
            writer = csv.DictWriter(handle, rows[0].keys())
            writer.writeheader()
            writer.writerows(rows)
        missing = run("freeze", work / "s.csv", "--out", work / "m.json", "--version", "t")
        assert missing.returncode != 0 and "reference" in missing.stderr
        rows[0].update(label="acceptable", reference="两份", reviewed_by="R01;R02")
        with (work / "s.csv").open("w", newline="") as handle:
            writer = csv.DictWriter(handle, rows[0].keys())
            writer.writeheader()
            writer.writerows(rows)
        assert run("freeze", work / "s.csv", "--out", work / "m.json", "--version", "t").returncode == 0
        item = json.loads((work / "m.json").read_text())["items"][0]
        assert item["reviewed_by"] == ["R01", "R02"] and item["audio_info"]["sample_rate"] == 16000
        assert run("freeze", work / "s.csv", "--out", work / "m.json", "--version", "t").returncode != 0  # no overwrite
    finally:
        shutil.rmtree(work, ignore_errors=True)


def test_eval_runs_started_in_the_same_second_do_not_collide():
    import concurrent.futures
    cmd = [sys.executable, str(ROOT / "scripts" / "asr-eval.py"), str(ROOT / "scripts" / "asr-eval.example.json")]
    with concurrent.futures.ThreadPoolExecutor(3) as pool:
        runs = list(pool.map(lambda _: subprocess.run(cmd, capture_output=True, text=True, cwd=ROOT), range(3)))
    assert [r.returncode for r in runs] == [0, 0, 0], [r.stderr for r in runs]
    assert len({json.loads(r.stdout)["results"] for r in runs}) == 3


def test_synthetic_smoke_manifest_is_a_draft_kept_out_of_private_data():
    import shutil
    tool, work = ROOT / "scripts" / "asr-eval-prepare.py", ROOT / "artifacts" / "local" / f"_pytest-smoke-{uuid4().hex[:6]}"
    run = lambda *a: subprocess.run([sys.executable, str(tool), *map(str, a)], capture_output=True, text=True, cwd=ROOT)
    try:
        assert run("synthetic", "--out", ROOT / "private" / "s.json").returncode != 0
        assert run("synthetic", "--out", work / "s.json").returncode == 0
        manifest = json.loads((work / "s.json").read_text())
        assert manifest["draft"] is True and manifest["items"] and manifest["warnings"] == []
        assert all(i["source"] == "synthetic" and i["speaker_group"] == "synthetic" and "reviewed_by" not in i
                   for i in manifest["items"])
        assert all((work / i["audio"]).resolve().is_file() for i in manifest["items"])
    finally:
        shutil.rmtree(work, ignore_errors=True)


def test_local_asr_server_rejects_other_model_names_and_large_uploads():
    import importlib.util
    spec = importlib.util.spec_from_file_location("local_asr_server", ROOT / "scripts" / "local-asr-server.py")
    server = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(server)

    assert server.reject("qwen3-asr-1.7b", "whisper-medium", 10) == (400, "model mismatch")
    assert server.reject("qwen3-asr-1.7b", "qwen3-asr-1.7b", server.MAX_UPLOAD + 1)[0] == 413
    assert server.reject("qwen3-asr-1.7b", "qwen3-asr-1.7b", 10) is None
    assert set(server.MODELS) == {"qwen3-asr-1.7b", "whisper-medium-wu", "whisper-medium"}
    assert all(len(m["revision"]) == 40 for m in server.MODELS.values())  # pinned full commits
    pytest.importorskip("multipart")  # eval-only server dependency, not needed by the backend

    class Fake:
        def transcribe(self, audio):
            return f"len={len(audio)}", "zh"

    client = TestClient(server.build_app("qwen3-asr-1.7b", Fake(), "rev", decode=lambda data: data))
    post = lambda model, data: client.post("/v1/audio/transcriptions", data={"model": model},
                                           files={"file": ("a.wav", data, "audio/wav")})
    assert post("whisper-medium", wav()).status_code == 400
    assert post("qwen3-asr-1.7b", b"x" * (server.MAX_UPLOAD + 1)).status_code == 413
    ok = post("qwen3-asr-1.7b", wav())
    assert ok.status_code == 200 and ok.json()["model"] == "qwen3-asr-1.7b" and ok.json()["revision"] == "rev"
    assert client.get("/health").json() == {"model": "qwen3-asr-1.7b", "revision": "rev"}


def test_recording_page_saves_private_16k_wav_and_keeps_retakes():
    import importlib.util
    import shutil
    spec = importlib.util.spec_from_file_location("record_session", ROOT / "scripts" / "record-session.py")
    rec = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(rec)
    folder = ROOT / "private" / "asr-eval" / f"_pytest-{uuid4().hex[:6]}"
    try:
        with pytest.raises(SystemExit):
            rec.Session(ROOT / "artifacts" / "x", ROOT / "scripts" / "asr-eval-plan.json")  # outside private/
        session = rec.Session(folder, ROOT / "scripts" / "asr-eval-plan.json")
        with pytest.raises(ValueError):
            session.save("NX-QTY-SHORT", wav(1.0), "两份", "")  # not started
        with pytest.raises(ValueError):
            session.start("Alice", "fluent", "mac", "quiet")
        session.start("S01", "fluent", "mac", "quiet")
        with pytest.raises(ValueError):
            session.save("NX-QTY-SHORT", wav(1.0, rate=44100), "两份", "")
        with pytest.raises(ValueError):
            session.save("../../etc", wav(1.0), "", "")
        assert session.save("NX-QTY-SHORT", wav(1.0), "两份", "")["saved"] == "S01/NX-QTY-SHORT.wav"
        session.save("NX-QTY-SHORT", wav(1.2), "两份，两份", "restart")
        assert len(list((folder / "S01" / "_retakes").iterdir())) == 1
        row = next(r for r in session.rows() if r["prompt_id"] == "NX-QTY-SHORT")
        assert row["reference"] == "两份，两份" and row["label"] == "" and row["reviewed_by"] == ""
        assert "not yet reviewed" in row["notes"] and row["device"] == "mac"
        state = session.state()
        assert sum(p["recorded"] for p in state["prompts"]) == 1
        manifest = folder / "m.json"
        done = subprocess.run([sys.executable, str(ROOT / "scripts" / "asr-eval-prepare.py"), "freeze",
                               str(folder / "S01.csv"), "--out", str(manifest), "--version", "t", "--draft"],
                              capture_output=True, text=True, cwd=ROOT)
        assert done.returncode != 0 and "not found" in done.stderr  # unrecorded prompts are reported, not skipped
    finally:
        shutil.rmtree(folder, ignore_errors=True)


def test_review_is_blind_per_reviewer_and_applies_only_agreed_decisions():
    import csv
    import importlib.util
    import shutil
    load = lambda name, file: importlib.util.spec_from_file_location(name, ROOT / "scripts" / file)
    specs = {n: load(n, f) for n, f in (("rec", "record-session.py"), ("rev", "review-session.py"))}
    mods = {}
    for name, spec in specs.items():
        mods[name] = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mods[name])
    folder = ROOT / "private" / "asr-eval" / f"_pytest-{uuid4().hex[:6]}"
    plan = ROOT / "scripts" / "asr-eval-plan.json"
    try:
        session = mods["rec"].Session(folder, plan)
        session.start("S01", "heritage", "mac", "quiet")
        for prompt in ("NX-QTY-SHORT", "NX-QTY-SELF", "TEA-THANKS-CAN"):
            session.save(prompt, wav(1.0), "两份" if prompt == "NX-QTY-SHORT" else "x", "")
        review = mods["rev"].Review(folder, plan)
        items = review.items("R01")
        assert {i["id"] for i in items} == {"S01-NX-QTY-SHORT", "S01-NX-QTY-SELF", "S01-TEA-THANKS-CAN"}
        assert all("label" not in i and "transcript" not in i and "intended" not in json.dumps(i) for i in items)
        assert all("目标" in i["question"] for i in items)
        assert all(mods["rev"].question({"station": p["station"], "step": p["step"], "target": json.dumps(p["target"])})
                   != f"{p['station']} / {p['step']}" for p in json.loads(plan.read_text())["prompts"])
        with pytest.raises(ValueError):
            review.save("Alice", {"item": {"id": "S01-NX-QTY-SHORT", "label": "acceptable"}})
        with pytest.raises(ValueError):
            review.save("R01", {"item": {"id": "S01-NX-QTY-SHORT", "label": "great"}})
        review.save("R01", {"profile": {"fluency": "native", "is_speaker_of": []}})
        review.save("R02", {"profile": {"fluency": "heritage", "is_speaker_of": ["S01"]}})
        for code in ("R01", "R02"):
            review.save(code, {"item": {"id": "S01-NX-QTY-SHORT", "label": "acceptable", "reference": "两份", "note": ""}})
        review.save("R01", {"item": {"id": "S01-NX-QTY-SELF", "label": "acceptable", "reference": "三份勿对两份"}})
        review.save("R02", {"item": {"id": "S01-NX-QTY-SELF", "label": "understandable", "reference": "三份勿对两份"}})
        review.save("R01", {"draft": {"prompt_id": "NX-QTY-SELF", "wording": "natural"}})
        result = review.apply()
        assert result["written"] == 1 and [d["id"] for d in result["disagreements"]] == ["S01-NX-QTY-SELF"]
        assert result["unreviewed"] == ["S01-TEA-THANKS-CAN"] and result["draft_wording"]["R01"]["NX-QTY-SELF"]
        rows = {r["prompt_id"]: r for r in csv.DictReader((folder / "S01.csv").open(encoding="utf-8"))}
        assert rows["NX-QTY-SHORT"]["label"] == "acceptable" and rows["NX-QTY-SHORT"]["reviewed_by"] == "R01;R02"
        assert "self-review" in rows["NX-QTY-SHORT"]["notes"] and "not yet reviewed" not in rows["NX-QTY-SHORT"]["notes"]
        assert rows["NX-QTY-SELF"]["label"] == "" and rows["NX-QTY-SELF"]["reviewed_by"] == ""
        review.apply()  # idempotent
        again = {r["prompt_id"]: r for r in csv.DictReader((folder / "S01.csv").open(encoding="utf-8"))}
        assert again["NX-QTY-SHORT"]["notes"] == rows["NX-QTY-SHORT"]["notes"]
    finally:
        shutil.rmtree(folder, ignore_errors=True)
