"""OpenAI-compatible ASR (`/v1/audio/transcriptions`) and TTS (`/v1/audio/speech`).

For self-hosted or local models behind the OpenAI audio API, e.g. vLLM,
speaches / faster-whisper-server, LocalAI, or a CosyVoice OpenAI-style server. Off unless explicitly enabled;
plain HTTP is accepted only for loopback hosts, and never in production.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import time
from dataclasses import dataclass, field
from urllib.parse import urlsplit

import httpx

from .audio import finalize_generated_wav, inspect_wav
from .contracts import ASRRequest, ASRResult, ProviderError, TTSRequest
from .qwen import _http_error

LOOPBACK = {"127.0.0.1", "localhost", "::1"}


@dataclass(frozen=True)
class OpenAICompatibleConfig:
    model: str
    endpoint: str = field(repr=False)
    api_key: str = field(default="", repr=False)
    language: str | None = None
    live_enabled: bool = False
    timeout_seconds: float = 12.0
    service: str = "asr"
    voice: str | None = None
    adapter_version: str = "openai-transcriptions-v1"

    @classmethod
    def from_env(cls, service: str = "asr") -> "OpenAICompatibleConfig":
        if service not in ("asr", "tts"):
            raise ProviderError("invalid_configuration")
        prefix = f"LOCAL_{service.upper()}"
        endpoint = os.getenv(f"{prefix}_ENDPOINT", "http://127.0.0.1:8000").rstrip("/")
        try:
            parts = urlsplit(endpoint)
            port = parts.port
        except ValueError:
            raise ProviderError("invalid_configuration") from None
        host = parts.hostname or ""
        production = os.getenv("APP_ENV", "development") == "production"
        secure = parts.scheme == "https" or (parts.scheme == "http" and host in LOOPBACK and not production)
        if (not secure or not host or parts.username or parts.password or parts.query or parts.fragment
                or parts.path not in ("", "/") or (port is not None and not 0 < port < 65536)):
            raise ProviderError("invalid_configuration")
        model = os.getenv(f"{prefix}_MODEL", "")
        voice = os.getenv(f"{prefix}_VOICE") or None
        if not model or len(model) > 200 or (service == "tts" and (not voice or len(voice) > 200)):
            raise ProviderError("invalid_configuration")
        language = os.getenv(f"{prefix}_LANGUAGE") or None
        try:
            timeout = float(os.getenv(f"{prefix}_TIMEOUT_SECONDS", "12" if service == "asr" else "60"))
        except ValueError:
            raise ProviderError("invalid_configuration") from None
        if not 1 <= timeout <= 120:
            raise ProviderError("invalid_configuration")
        return cls(model=model, endpoint=endpoint, api_key=os.getenv(f"{prefix}_API_KEY", ""), language=language,
                   live_enabled=os.getenv(f"{prefix}_ENABLE_LIVE", "false").lower() == "true",
                   timeout_seconds=timeout, service=service, voice=voice if service == "tts" else None,
                   adapter_version="openai-transcriptions-v1" if service == "asr" else "openai-speech-v1")

    @property
    def config_id(self) -> str:
        fields = {"service": self.service, "provider": "openai-compatible", "model": self.model,
                  "endpoint": self.endpoint, "language": self.language,
                  "adapter": self.adapter_version, "timeout": self.timeout_seconds}
        if self.service == "tts":
            fields["voice"] = self.voice  # Kept out for ASR so existing ASR config IDs stay stable.
        encoded = json.dumps(fields, sort_keys=True).encode()
        return f"{self.service}-" + hashlib.sha256(encoded).hexdigest()[:16]

    @property
    def ready(self) -> bool:
        return self.live_enabled  # A local server may legitimately need no key.

    def public_dict(self) -> dict:
        host = urlsplit(self.endpoint).hostname
        return {"config_id": self.config_id, "service": self.service, "provider": "openai-compatible",
                "deployment": "local" if host in LOOPBACK else "self-hosted", "model": self.model,
                "model_revision": None, "region": None, "adapter_version": self.adapter_version,
                "live_enabled": self.live_enabled, "credential_configured": bool(self.api_key),
                "timeout_seconds": self.timeout_seconds, "json_mode": None, "voice": self.voice,
                "language": self.language, "real_validation": "pending"}

    def require_enabled(self) -> None:
        if not self.live_enabled:
            raise ProviderError("service_disabled")


class OpenAICompatibleASR:
    def __init__(self, config: OpenAICompatibleConfig, transport: httpx.AsyncBaseTransport | None = None):
        self.config, self.transport = config, transport

    async def transcribe(self, request: ASRRequest) -> ASRResult:
        self.config.require_enabled()
        if request.mime_type not in ("audio/wav", "audio/x-wav", "audio/wave"):
            raise ProviderError("unsupported_format")
        inspect_wav(request.audio)
        data = {"model": self.config.model, "response_format": "json", "temperature": "0"}
        if self.config.language:
            data["language"] = self.config.language
        headers = {"Authorization": f"Bearer {self.config.api_key}"} if self.config.api_key else {}
        started = time.monotonic()
        budget = self.config.timeout_seconds
        if request.deadline is not None:
            budget = min(budget, request.deadline - started)
        if budget <= 0:
            raise ProviderError("timeout", True)
        try:
            async with asyncio.timeout(budget):
                async with httpx.AsyncClient(transport=self.transport, timeout=budget, follow_redirects=False) as client:
                    response = await client.post(self.config.endpoint + "/v1/audio/transcriptions", data=data,
                                                 files={"file": ("audio.wav", request.audio, "audio/wav")}, headers=headers)
            if response.status_code != 200:
                raise _http_error(response.status_code)
            result = response.json()
            text = result.get("text") if isinstance(result, dict) else None
            if not isinstance(text, str):
                raise ProviderError("invalid_response")
            if not text.strip():
                raise ProviderError("no_speech", True)
            language = result.get("language") if isinstance(result.get("language"), str) else None
            return ASRResult(text.strip(), "succeeded", round((time.monotonic() - started) * 1000),
                             self.config.config_id, None, self.config.model, language)
        except (TimeoutError, httpx.TimeoutException):
            raise ProviderError("timeout", True) from None
        except httpx.HTTPError:
            raise ProviderError("service_unavailable", True) from None
        except (ValueError, TypeError, AttributeError):
            raise ProviderError("invalid_response") from None


class OpenAICompatibleTTS:
    """Offline teaching-audio generation only; output is always pending human review."""

    def __init__(self, config: OpenAICompatibleConfig, transport: httpx.AsyncBaseTransport | None = None):
        self.config, self.transport = config, transport

    async def synthesize(self, request: TTSRequest) -> tuple[bytes, dict]:
        self.config.require_enabled()
        if request.target_language != "wuu":
            raise ProviderError("unsupported_language_or_voice")
        if request.speed != "normal":
            raise ProviderError("unsupported_speed")  # Slow audio stays a pitch-preserving client playback rate.
        if not request.text.strip() or len(request.text) > 600:
            raise ProviderError("invalid_input")
        payload = {"model": self.config.model, "input": request.text, "voice": self.config.voice,
                   "response_format": "wav"}
        if self.config.language:
            payload["language"] = self.config.language
        headers = {"Authorization": f"Bearer {self.config.api_key}"} if self.config.api_key else {}
        started = time.monotonic()
        try:
            async with asyncio.timeout(self.config.timeout_seconds):
                async with httpx.AsyncClient(transport=self.transport, timeout=self.config.timeout_seconds,
                                             follow_redirects=False) as client:
                    async with client.stream("POST", self.config.endpoint + "/v1/audio/speech",
                                             json=payload, headers=headers) as response:
                        if response.status_code != 200:
                            raise _http_error(response.status_code)
                        audio = bytearray()
                        async for chunk in response.aiter_bytes():
                            audio.extend(chunk)
                            if len(audio) > 15 * 1024 * 1024:
                                raise ProviderError("audio_too_large")
            finalized, metadata = finalize_generated_wav(bytes(audio))
            return finalized, {**metadata, "upstreamRequestId": None,
                               "elapsedMs": round((time.monotonic() - started) * 1000), "targetLanguage": "wuu",
                               "providerLanguageParameter": self.config.language, "voice": self.config.voice,
                               "status": "pending", "listeningReview": "pending", "configId": self.config.config_id,
                               "usage": {"characters": len(request.text)}}
        except (TimeoutError, httpx.TimeoutException):
            raise ProviderError("timeout", True) from None
        except httpx.HTTPError:
            raise ProviderError("service_unavailable", True) from None


def tts_from_env(transport: httpx.AsyncBaseTransport | None = None):
    """`TTS_PROVIDER=qwen` (default, Jada) or `openai_compatible`. No fallback between them."""
    from .config import ProviderConfig
    from .qwen import QwenTTS
    kind = os.getenv("TTS_PROVIDER", "qwen")
    if kind == "qwen":
        return QwenTTS(ProviderConfig.from_env("tts"), transport)
    if kind == "openai_compatible":
        return OpenAICompatibleTTS(OpenAICompatibleConfig.from_env("tts"), transport)
    raise ProviderError("invalid_configuration")


def asr_from_env(transport: httpx.AsyncBaseTransport | None = None):
    """`ASR_PROVIDER=qwen` (default) or `openai_compatible`. No fallback between them."""
    from .config import ProviderConfig
    from .qwen import QwenASR
    kind = os.getenv("ASR_PROVIDER", "qwen")
    if kind == "qwen":
        config = ProviderConfig.from_env("asr")
        return QwenASR(config, transport), config
    if kind == "openai_compatible":
        config = OpenAICompatibleConfig.from_env("asr")
        return OpenAICompatibleASR(config, transport), config
    raise ProviderError("invalid_configuration")
