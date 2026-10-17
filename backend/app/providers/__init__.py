"""Replaceable ASR / interpretation / offline TTS boundary."""
from .audio import inspect_wav
from .config import ProviderConfig
from .contracts import ASRProvider, ASRRequest, ASRResult, Interpretation, ProviderError, SemanticProvider, TTSProvider, TTSRequest
from .qwen import QwenASR, QwenInterpreter, QwenTTS

__all__ = ["ASRProvider", "ASRRequest", "ASRResult", "Interpretation", "ProviderConfig", "ProviderError",
           "SemanticProvider", "TTSProvider", "TTSRequest", "QwenASR", "QwenInterpreter", "QwenTTS", "inspect_wav"]
