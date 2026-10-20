"""Reference-audio similarity (self-supervised speech features + DTW). Evaluation only.

Compares a learner recording with a reference recording of the same sentence.
Language-agnostic: no Shanghainese lexicon or acoustic model is required, so it
can say "sounds close to the reference" but never which word was said.

Uncalibrated similarity is recorded but costs no points (scoring Rule A). Only
an explicit calibration, fitted on native-speaker labels, turns it into
confident pronunciation events. Optional dependencies (torch, transformers)
are listed in backend/requirements-acoustic.txt and are never installed in production.
"""
from __future__ import annotations

import array
import io
import math
import os
import wave
from typing import Protocol, Sequence

from .providers.contracts import ProviderError

TARGET_RATE = 16000
DEFAULT_MODEL = "microsoft/wavlm-base-plus"
Vector = Sequence[float]


class Extractor(Protocol):
    name: str
    def features(self, samples: list[float], rate: int) -> list[Vector]: ...


def decode_wav(data: bytes) -> tuple[list[float], int]:
    """16-bit PCM WAV → mono float samples in [-1, 1]."""
    try:
        with wave.open(io.BytesIO(data), "rb") as wav:
            if wav.getsampwidth() != 2 or wav.getcomptype() != "NONE":
                raise ProviderError("unsupported_format")
            channels, rate = wav.getnchannels(), wav.getframerate()
            pcm = array.array("h", wav.readframes(wav.getnframes()))
    except (wave.Error, EOFError):
        raise ProviderError("unsupported_format") from None
    if not pcm:
        raise ProviderError("no_speech")
    if channels > 1:
        pcm = [sum(pcm[i:i + channels]) / channels for i in range(0, len(pcm), channels)]
    return [value / 32768 for value in pcm], rate


def resample(samples: list[float], rate: int, target: int = TARGET_RATE) -> list[float]:
    if rate == target:
        return samples
    length = max(1, round(len(samples) * target / rate))
    step = (len(samples) - 1) / max(1, length - 1)
    out = []
    for i in range(length):
        position = i * step
        left = int(position)
        right = min(left + 1, len(samples) - 1)
        out.append(samples[left] + (samples[right] - samples[left]) * (position - left))
    return out


def trim_silence(samples: list[float], rate: int, threshold: float = 0.02, frame_ms: int = 20) -> list[float]:
    """Drop leading/trailing low-energy frames so pauses do not dominate DTW."""
    size = max(1, rate * frame_ms // 1000)
    frames = [samples[i:i + size] for i in range(0, len(samples), size)]
    loud = [i for i, frame in enumerate(frames) if math.sqrt(sum(v * v for v in frame) / len(frame)) >= threshold]
    if not loud:
        return samples
    return samples[loud[0] * size:(loud[-1] + 1) * size]


def _cosine(a: Vector, b: Vector) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    norm = math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(y * y for y in b))
    return dot / norm if norm else 0.0


def dtw_similarity(a: list[Vector], b: list[Vector]) -> float:
    """Mean cosine similarity along the optimal DTW path, clamped to [0, 1]."""
    if not a or not b:
        raise ProviderError("no_speech")
    try:
        import numpy as np  # Optional: much faster for real 768-dim features.
        x, y = np.asarray(a, dtype=float), np.asarray(b, dtype=float)
        x /= np.linalg.norm(x, axis=1, keepdims=True) + 1e-9
        y /= np.linalg.norm(y, axis=1, keepdims=True) + 1e-9
        sim = (x @ y.T).tolist()
    except ImportError:
        sim = [[_cosine(u, v) for v in b] for u in a]
    n, m = len(a), len(b)
    inf = float("inf")
    cost = [[inf] * (m + 1) for _ in range(n + 1)]
    steps = [[0] * (m + 1) for _ in range(n + 1)]
    cost[0][0] = 0.0
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            best, length = min((cost[i - 1][j - 1], steps[i - 1][j - 1]), (cost[i - 1][j], steps[i - 1][j]),
                               (cost[i][j - 1], steps[i][j - 1]))
            cost[i][j], steps[i][j] = best + (1 - sim[i - 1][j - 1]), length + 1
    return round(min(1.0, max(0.0, 1 - cost[n][m] / steps[n][m])), 4)


class WavLMExtractor:
    """Lazy-loaded Hugging Face model; weights download on first use (see docs)."""

    def __init__(self, model: str | None = None, layer: int | None = None):
        self.name = model or os.getenv("ACOUSTIC_MODEL", DEFAULT_MODEL)
        self.layer = layer if layer is not None else int(os.getenv("ACOUSTIC_LAYER", "6"))
        self._model = self._processor = None

    def _load(self):
        try:
            import torch  # noqa: F401
            from transformers import AutoFeatureExtractor, AutoModel
        except ImportError:
            raise ProviderError("acoustic_dependencies_missing") from None
        self._processor = AutoFeatureExtractor.from_pretrained(self.name)
        self._model = AutoModel.from_pretrained(self.name, output_hidden_states=True).eval()

    def features(self, samples: list[float], rate: int) -> list[Vector]:
        if self._model is None:
            self._load()
        import torch
        inputs = self._processor(samples, sampling_rate=rate, return_tensors="pt")
        with torch.no_grad():
            hidden = self._model(**inputs).hidden_states[self.layer][0]
        return hidden.tolist()


def compare(learner: bytes, reference: bytes, extractor: Extractor) -> dict:
    vectors = []
    for data in (learner, reference):
        samples, rate = decode_wav(data)
        samples = trim_silence(resample(samples, rate), TARGET_RATE)
        vectors.append(extractor.features(samples, TARGET_RATE))
    return {"similarity": dtw_similarity(*vectors), "model": extractor.name,
            "frames": [len(vectors[0]), len(vectors[1])]}


def observations(similarity: float, calibration: dict | None = None) -> list[dict]:
    """Turn similarity into scoring events.

    Without calibration every event is `uncertain` (0 points, recorded only).
    A calibration is `{"minor_below": float, "severe_below": float, "confidence": float}`
    fitted on labeled recordings for one model/layer.
    """
    if calibration is None:
        return [{"type": "minor_pronunciation", "span": "acoustic", "uncertain": True,
                 "evidence": f"reference similarity {similarity}"}] if similarity < 0.5 else []
    confidence = calibration.get("confidence", 0.0)
    if similarity < calibration["severe_below"]:
        kind = "severe_pronunciation"
    elif similarity < calibration["minor_below"]:
        kind = "minor_pronunciation"
    else:
        return []
    return [{"type": kind, "span": "acoustic", "confidence": confidence,
             "evidence": f"reference similarity {similarity}"}]
