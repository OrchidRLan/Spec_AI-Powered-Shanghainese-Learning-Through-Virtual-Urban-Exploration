"""Server-only config; explicitly opt in to paid calls, independently per service."""
import hashlib
import json
import os
import re
from dataclasses import dataclass, field
from urllib.parse import urlsplit

from .contracts import ProviderError

_MODELS = {"asr": "qwen3-asr-flash", "tts": "qwen3-tts-flash", "llm": "qwen-plus"}
_TIMEOUTS = {"asr": 12.0, "tts": 30.0, "llm": 8.0}
_HOSTS = {"beijing": "dashscope.aliyuncs.com", "singapore": "dashscope-intl.aliyuncs.com"}


@dataclass(frozen=True)
class ProviderConfig:
    service: str
    model: str
    region: str = "beijing"
    endpoint: str = field(default="https://dashscope.aliyuncs.com", repr=False)
    api_key: str = field(default="", repr=False)
    live_enabled: bool = False
    timeout_seconds: float = 12.0
    json_mode: str = "json_object"
    voice: str = "Jada"
    adapter_version: str = "qwen-http-v2"

    @classmethod
    def from_env(cls, service: str) -> "ProviderConfig":
        if service not in _MODELS:
            raise ProviderError("invalid_configuration")
        prefix = f"QWEN_{service.upper()}"
        region = os.getenv(f"{prefix}_REGION", "beijing")
        if region not in _HOSTS:
            raise ProviderError("unsupported_region")
        endpoint = os.getenv(f"{prefix}_ENDPOINT", f"https://{_HOSTS[region]}").rstrip("/")
        try:
            parts = urlsplit(endpoint)
            port = parts.port
        except ValueError:
            raise ProviderError("invalid_configuration") from None
        # Only official Qwen hosts; replacement providers implement the same protocol.
        host = parts.hostname or ""
        if (parts.scheme != "https" or parts.username or parts.password or parts.query or parts.fragment
                or parts.path or port not in (None, 443)
                or not (host in _HOSTS.values() or re.fullmatch(r"[a-zA-Z0-9-]+\.(cn-beijing|ap-southeast-1)\.maas\.aliyuncs\.com", host))):
            raise ProviderError("invalid_configuration")
        expected_region = "singapore" if host == _HOSTS["singapore"] or ".ap-southeast-1." in host else "beijing"
        if region != expected_region:
            raise ProviderError("invalid_configuration")
        mode = os.getenv("QWEN_LLM_JSON_MODE", "json_object")
        if mode not in ("json_object", "json_schema"):
            raise ProviderError("invalid_configuration")
        return cls(service=service, model=os.getenv(f"{prefix}_MODEL", _MODELS[service]),
                   region=region, endpoint=endpoint,
                   api_key=os.getenv(f"{prefix}_API_KEY") or os.getenv("DASHSCOPE_API_KEY", ""),
                   live_enabled=os.getenv(f"{prefix}_ENABLE_LIVE", os.getenv("SPEECH_ENABLE_LIVE", "false")).lower() == "true",
                   timeout_seconds=_TIMEOUTS[service], json_mode=mode)

    @property
    def config_id(self) -> str:
        encoded = json.dumps({"service": self.service, "model": self.model, "region": self.region,
                              "endpoint": self.endpoint, "mode": self.json_mode,
                              "voice": self.voice, "adapter": self.adapter_version,
                              "timeout": self.timeout_seconds}, sort_keys=True).encode()
        return f"{self.service}-" + hashlib.sha256(encoded).hexdigest()[:16]

    def public_dict(self) -> dict:
        return {"config_id": self.config_id, "service": self.service, "provider": "aliyun-model-studio",
                "deployment": "hosted-api", "model": self.model, "model_revision": None,
                "region": self.region, "adapter_version": self.adapter_version,
                "live_enabled": self.live_enabled, "credential_configured": bool(self.api_key),
                "timeout_seconds": self.timeout_seconds,
                "json_mode": self.json_mode if self.service == "llm" else None,
                "voice": self.voice if self.service == "tts" else None,
                "real_validation": "pending"}

    @property
    def ready(self) -> bool:
        return bool(self.live_enabled and self.api_key)

    def require_enabled(self) -> None:
        if not self.live_enabled:
            raise ProviderError("service_disabled")
        if not self.api_key:
            raise ProviderError("authentication_failed")
