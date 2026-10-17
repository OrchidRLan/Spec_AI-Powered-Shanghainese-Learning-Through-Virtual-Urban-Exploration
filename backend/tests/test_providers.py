"""Mocked HTTP contract tests only: these are NOT real Qwen / Shanghai pronunciation tests."""
import asyncio
from dataclasses import replace
import io
import json
from pathlib import Path
import wave

import httpx
import pytest

from app.providers import ASRRequest, ProviderConfig, ProviderError, QwenASR, QwenInterpreter, QwenTTS, TTSRequest, inspect_wav
from app.providers.production import approved_text, produce_audio, language_subject_sha256, generation_id


def wav(seconds=0.1, rate=16000):
    stream = io.BytesIO()
    with wave.open(stream, "wb") as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(rate)
        writer.writeframes(b"\x01\x00" * round(seconds * rate))
    return stream.getvalue()


def config(service="asr", **overrides):
    return replace(ProviderConfig(service, {"asr": "qwen3-asr-flash", "llm": "qwen-plus", "tts": "qwen3-tts-flash"}[service],
                                  api_key="mock-secret-not-a-real-key", live_enabled=True), **overrides)


def run(coro):
    return asyncio.run(coro)


def response_payload(content):
    return {"id": "mock-request", "model": "mock-model", "choices": [{"message": {"content": content}}]}


def test_configuration_disabled_by_default_and_redacted(monkeypatch):
    for key in ("DASHSCOPE_API_KEY", "QWEN_ASR_API_KEY", "QWEN_ASR_ENABLE_LIVE", "SPEECH_ENABLE_LIVE"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("DASHSCOPE_API_KEY", "not-a-real-secret")
    value = ProviderConfig.from_env("asr")
    assert value.live_enabled is False
    assert "not-a-real-secret" not in repr(value)
    assert "not-a-real-secret" not in json.dumps(value.public_dict())
    assert "endpoint" not in value.public_dict()
    with pytest.raises(ProviderError, match="service_disabled"):
        value.require_enabled()


def test_independent_region_and_endpoint_validation(monkeypatch):
    monkeypatch.setenv("QWEN_TTS_REGION", "singapore")
    assert ProviderConfig.from_env("tts").endpoint == "https://dashscope-intl.aliyuncs.com"
    monkeypatch.setenv("QWEN_TTS_ENDPOINT", "https://untrusted.example")
    with pytest.raises(ProviderError, match="invalid_configuration"):
        ProviderConfig.from_env("tts")


def test_asr_contract_keeps_transcript_and_has_no_invented_confidence():
    def handler(request):
        payload = json.loads(request.content)
        assert payload["model"] == "qwen3-asr-flash"
        assert payload["asr_options"] == {"enable_itn": False}  # UI language is not a hint.
        assert payload["messages"][0]["content"][0]["input_audio"]["data"].startswith("data:audio/wav;base64,")
        assert "mock-secret" in request.headers["authorization"]
        return httpx.Response(200, json=response_payload("  两份，打包。  "))
    result = run(QwenASR(config(), httpx.MockTransport(handler)).transcribe(ASRRequest(wav(), "r1")))
    assert result.transcript == "  两份，打包。  "
    assert result.confidence is None and result.language is None
    assert result.upstream_request_id == "mock-request"
    assert result.config_id == config().config_id


@pytest.mark.parametrize("status,code,retryable", [(401, "authentication_failed", False), (429, "rate_limited", True),
    (503, "service_unavailable", True), (504, "timeout", True), (400, "provider_rejected_request", False)])
def test_stable_errors_do_not_leak_upstream(status, code, retryable):
    transport = httpx.MockTransport(lambda request: httpx.Response(status, text="upstream secret body"))
    with pytest.raises(ProviderError) as caught:
        run(QwenASR(config(), transport).transcribe(ASRRequest(wav(), "r")))
    assert caught.value.code == code and caught.value.retryable is retryable
    assert "secret" not in str(caught.value)


def test_timeout_has_no_hidden_retry():
    calls = []
    def handler(request):
        calls.append(request)
        raise httpx.ReadTimeout("private upstream URL")
    with pytest.raises(ProviderError, match="timeout"):
        run(QwenASR(config(), httpx.MockTransport(handler)).transcribe(ASRRequest(wav(), "r")))
    assert len(calls) == 1


@pytest.mark.parametrize("audio,code", [(b"not wav", "unsupported_format"), (b"", "no_speech"),
                                      (wav(20.1), "audio_too_long"), (wav()[:-2], "unsupported_format")])
def test_decode_audio_validation(audio, code):
    with pytest.raises(ProviderError, match=code):
        inspect_wav(audio)


def test_asr_empty_and_malformed_response():
    for payload, expected in [(response_payload("  "), "no_speech"), ({}, "invalid_response")]:
        transport = httpx.MockTransport(lambda request: httpx.Response(200, json=payload))
        with pytest.raises(ProviderError, match=expected):
            run(QwenASR(config(), transport).transcribe(ASRRequest(wav(), "r")))


def semantic_response(evidence="Two", value=2):
    return {"intent": "provide", "changes": [{"field": "quantity", "value": value, "evidence": evidence}],
            "uncertainties": [], "help_requested": False}


def test_semantic_structural_and_verbatim_evidence_contract():
    def handler(request):
        payload = json.loads(request.content)
        assert payload["response_format"] == {"type": "json_object"}
        user = json.loads(payload["messages"][1]["content"])
        assert "hidden_target" not in user["context"]
        assert user["user_text"] == "Two servings"
        return httpx.Response(200, json=response_payload(json.dumps(semantic_response())))
    result = run(QwenInterpreter(config("llm"), httpx.MockTransport(handler)).interpret(
        "Two servings", {"scene": "nanxiang", "hidden_target": {"quantity": 2}}))
    assert result.changes == {"quantity": 2}
    assert result.evidence == {"quantity": "Two"}
    assert not hasattr(result, "completed")


@pytest.mark.parametrize("raw", [semantic_response("not in text"), semantic_response("Two", True),
    {**semantic_response(), "completed": True},
    {**semantic_response(), "changes": [{"field": "takeaway", "value": "false", "evidence": "Two"}]}])
def test_invalid_semantics_retry_once_then_fail(raw):
    calls = []
    def handler(request):
        calls.append(request)
        return httpx.Response(200, json=response_payload(json.dumps(raw)))
    with pytest.raises(ProviderError, match="invalid_response"):
        run(QwenInterpreter(config("llm"), httpx.MockTransport(handler)).interpret("Two servings", {}))
    assert len(calls) == 2


def test_json_schema_mode_is_explicit_and_does_not_fallback():
    calls = []
    def handler(request):
        payload = json.loads(request.content)
        calls.append(payload)
        assert payload["response_format"]["json_schema"]["strict"] is True
        return httpx.Response(400)
    with pytest.raises(ProviderError, match="provider_rejected_request"):
        run(QwenInterpreter(config("llm", json_mode="json_schema"), httpx.MockTransport(handler)).interpret("Two", {}))
    assert len(calls) == 1


def reviewed_fixture():
    entry = {"id": "E08", "version": "test-only", "hanzi": "测试专用文本", "meaning": {"zh": "仅测试", "en": "test only"}, "segments": [], "acceptableVariants": [], "review": {
        "language": "approved", "status": "language-reviewed", "recordIds": ["r1", "r2"]}}
    reviews = {"reviewers": [{"id": "mock-1", "fluentShanghainese": True}, {"id": "mock-2", "fluentShanghainese": True}],
        "records": [{"id": f"r{i}", "contentId": "E08", "contentVersion": "test-only", "stage": "language",
                     "decision": "approved", "reviewerId": f"mock-{i}", "reviewedAt": "2026-10-17T00:00:00Z"} for i in (1, 2)]}
    for record in reviews["records"]:
        record["subjectSha256"] = language_subject_sha256(entry)
    return {"expressions": [entry]}, reviews


def test_review_requires_two_people_and_exact_version():
    pack, reviews = reviewed_fixture()
    assert approved_text(pack, reviews, "E08")["version"] == "test-only"
    reviews["records"][1]["reviewerId"] = "mock-1"
    with pytest.raises(ProviderError, match="language_review_required"):
        approved_text(pack, reviews, "E08")
    pack, reviews = reviewed_fixture()
    reviews["records"][1]["contentVersion"] = "old"
    with pytest.raises(ProviderError, match="language_review_required"):
        approved_text(pack, reviews, "E08")


def test_later_changes_requested_revokes_eligibility():
    pack, reviews = reviewed_fixture()
    reviews["records"].append({**reviews["records"][0], "id": "r3", "decision": "changes-requested",
                               "reviewedAt": "2026-10-17T01:00:00Z"})
    with pytest.raises(ProviderError, match="language_review_required"):
        approved_text(pack, reviews, "E08")


def test_tts_download_asset_and_pending_review(tmp_path):
    requests = []
    def handler(request):
        requests.append(request)
        if request.method == "POST":
            body = json.loads(request.content)
            assert body["input"]["voice"] == "Jada"
            assert body["input"]["language_type"] == "Chinese"
            assert "speed" not in body["input"]
            return httpx.Response(200, json={"request_id": "mock-tts", "output": {"audio": {
                "url": "http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/test.wav?Signature=not-a-real-signature"}}})
        assert request.url.scheme == "https"
        assert "authorization" not in request.headers
        return httpx.Response(200, content=wav())
    pack, reviews = reviewed_fixture()
    provider = QwenTTS(config("tts"), httpx.MockTransport(handler))
    result = run(produce_audio(pack, reviews, "E08", provider, tmp_path))
    assert result["status"] == "pending" and result["listeningReview"] == "pending"
    assert result["reviewIds"] == [] and result["durationMs"] == 100
    assert len(result["sha256"]) == 64 and (tmp_path / result["file"]).exists()
    saved = (tmp_path / (result["generationId"] + ".json")).read_text()
    assert "Signature" not in saved and "mock-secret" not in saved
    with pytest.raises(ProviderError, match="asset_already_exists"):
        run(produce_audio(pack, reviews, "E08", provider, tmp_path))
    assert len(requests) == 2  # One POST + one download; repeated job did not bill again.


@pytest.mark.parametrize("overrides,code", [({"speed": "slow"}, "unsupported_speed"),
                                           ({"target_language": "en"}, "unsupported_language_or_voice")])
def test_unsupported_tts_capabilities_fail_before_network(overrides, code):
    def handler(request):
        pytest.fail("Unsupported capabilities must not invoke the API")
    request = TTSRequest("E08", "test", "测试", **overrides)
    with pytest.raises(ProviderError, match=code):
        run(QwenTTS(config("tts"), httpx.MockTransport(handler)).synthesize(request))


def test_tts_rejects_arbitrary_download_hosts():
    transport = httpx.MockTransport(lambda request: httpx.Response(200, json={"output": {"audio": {"url": "https://127.0.0.1/private"}}}))
    with pytest.raises(ProviderError, match="invalid_audio_url"):
        run(QwenTTS(config("tts"), transport).synthesize(TTSRequest("E08", "test", "测试")))


def test_draft_rejected_before_network_or_disk(tmp_path):
    pack, reviews = reviewed_fixture()
    pack["expressions"][0]["review"]["language"] = "pending"
    provider = QwenTTS(config("tts"), httpx.MockTransport(lambda request: pytest.fail("No draft calls")))
    with pytest.raises(ProviderError, match="language_review_required"):
        run(produce_audio(pack, reviews, "E08", provider, tmp_path / "audio"))
    assert not (tmp_path / "audio").exists()


def test_same_version_edit_invalidates_language_approvals():
    pack, reviews = reviewed_fixture()
    pack["expressions"][0]["hanzi"] = "新内容"
    with pytest.raises(ProviderError, match="language_review_required"):
        approved_text(pack, reviews, "E08")


def test_generation_lock_prevents_concurrent_billing(tmp_path):
    pack, reviews = reviewed_fixture()
    provider = QwenTTS(config("tts"), httpx.MockTransport(lambda request: pytest.fail("No concurrent call")))
    entry = pack["expressions"][0]
    request = TTSRequest(entry["id"], entry["version"], entry["hanzi"])
    lock_path = tmp_path / (generation_id(request, provider.config) + ".lock")
    lock_path.touch()
    with pytest.raises(ProviderError, match="generation_in_progress"):
        run(produce_audio(pack, reviews, "E08", provider, tmp_path))
    assert lock_path.exists()


def test_generated_qwen_placeholder_wav_is_finalized_without_changing_samples():
    import struct
    from app.providers.audio import finalize_generated_wav
    original = wav()
    placeholder = bytearray(original)
    struct.pack_into("<I", placeholder, 4, 0x7FFFFFBF)
    struct.pack_into("<I", placeholder, 40, 0x7FFFFF9B)
    # Keep uploads strict: the supplier normalization must not make bad uploads valid.
    with pytest.raises(ProviderError, match="audio_too_long"):
        inspect_wav(bytes(placeholder))
    finalized, metadata = finalize_generated_wav(bytes(placeholder))
    assert finalized == original
    assert metadata["durationMs"] == 100
    assert metadata["processing"]["pcmUnchanged"] is True
    assert metadata["processing"]["kind"] == "wav_header_finalize"
    assert len(metadata["processing"]["sourceSha256"]) == 64


def test_generated_unknown_truncated_wav_is_not_repaired():
    from app.providers.audio import finalize_generated_wav
    with pytest.raises(ProviderError, match="unsupported_format"):
        finalize_generated_wav(wav()[:-2])
