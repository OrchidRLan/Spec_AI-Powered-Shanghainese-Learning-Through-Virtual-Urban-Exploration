"""Provider-neutral contracts. No provider response determines task completion."""
from dataclasses import dataclass, field
from typing import Any, Protocol


class ProviderError(Exception):
    def __init__(self, code: str, retryable: bool = False):
        self.code, self.retryable = code, retryable
        super().__init__(code)  # Never include upstream bodies, URLs, keys or audio.

    def public_dict(self) -> dict:
        return {"code": self.code, "retryable": self.retryable}


@dataclass(frozen=True)
class ASRRequest:
    audio: bytes = field(repr=False)
    request_id: str
    mime_type: str = "audio/wav"
    language_hint: str | None = None
    deadline: float | None = None  # monotonic time; never derived from client clock


@dataclass(frozen=True)
class ASRResult:
    transcript: str
    status: str
    elapsed_ms: int
    config_id: str
    upstream_request_id: str | None
    model: str | None
    language: str | None = None
    confidence: float | None = None


@dataclass(frozen=True)
class Interpretation:
    intent: str
    changes: dict[str, Any]
    evidence: dict[str, str]
    uncertainties: list[str]
    help_requested: bool
    config_id: str = ""
    upstream_request_id: str | None = None
    elapsed_ms: int = 0
    model: str | None = None


@dataclass(frozen=True)
class TTSRequest:
    text_id: str
    text_version: str
    text: str
    target_language: str = "wuu"
    voice_config: str = "nanxiang-jada-v1"
    speed: str = "normal"


class ASRProvider(Protocol):
    async def transcribe(self, request: ASRRequest) -> ASRResult: ...


class SemanticProvider(Protocol):
    async def interpret(self, text: str, context: dict) -> Interpretation: ...


class ServiceConfig(Protocol):
    @property
    def config_id(self) -> str: ...
    def public_dict(self) -> dict: ...


class TTSProvider(Protocol):
    config: ServiceConfig
    async def synthesize(self, request: TTSRequest) -> tuple[bytes, dict]: ...
