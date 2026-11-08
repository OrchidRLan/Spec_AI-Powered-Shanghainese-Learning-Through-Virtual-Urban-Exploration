#!/usr/bin/env python3
"""Serve one open-weight ASR model behind the OpenAI transcription API, on loopback only.

Lets scripts/asr-eval.py compare local candidates through the existing
`openai_compatible` adapter with the same scoring as production:

  python scripts/local-asr-server.py qwen3-asr-1.7b --port 8011
  LOCAL_ASR_ENDPOINT=http://127.0.0.1:8011 LOCAL_ASR_MODEL=qwen3-asr-1.7b LOCAL_ASR_ENABLE_LIVE=true \
    backend/.venv/bin/python scripts/asr-eval.py MANIFEST --provider openai_compatible

Evaluation only, never deployed. Models are pinned to the revisions in MODELS and
loaded from the local Hugging Face cache (no network at serve time). The server
rejects a request whose `model` differs from the one it loaded, so results cannot
be filed under the wrong model. Runs in its own environment (see
docs/evaluation/model-comparison.md), not in backend/.venv.
"""

import argparse
import io
import os
import sys
import tempfile
import time
from pathlib import Path

MODELS = {
    # C: general open-weight model whose card lists Wu among supported dialects.
    "qwen3-asr-1.7b": {"repo": "Qwen/Qwen3-ASR-1.7B", "revision": "7278e1e70fe206f11671096ffdd38061171dd6e5"},
    # B: Whisper-Medium fine-tuned on WenetSpeech-Wu (WeNet checkpoint, not transformers).
    "whisper-medium-wu": {"repo": "ASLP-lab/WenetSpeech-Wu-Speech-Understanding",
                          "revision": "cb53da7aefd9acd0f2af61b9631e49f5c3382686", "files": ["whisper/*"]},
    # D: general Whisper baseline.
    "whisper-medium": {"repo": "openai/whisper-medium", "revision": "abdf7c39ab9d0397620ccaea8974cc764cd0953e",
                       "files": ["*.json", "*.txt", "model.safetensors"]},
}
SAMPLE_RATE = 16000
MAX_UPLOAD = 3 * 1024 * 1024


def snapshot(name: str) -> Path:
    from huggingface_hub import snapshot_download
    spec = MODELS[name]
    return Path(snapshot_download(spec["repo"], revision=spec["revision"], allow_patterns=spec.get("files"),
                                  local_files_only=True))


def device() -> str:
    import torch
    forced = os.getenv("LOCAL_ASR_DEVICE")
    if forced:
        return forced
    return "mps" if torch.backends.mps.is_available() else "cpu"


def read_wav(data: bytes):
    """Decode a WAV upload to mono float32 at 16 kHz."""
    import numpy as np
    import soundfile as sf
    audio, rate = sf.read(io.BytesIO(data), dtype="float32", always_2d=True)
    audio = audio.mean(axis=1)
    if rate != SAMPLE_RATE:
        import librosa
        audio = librosa.resample(audio, orig_sr=rate, target_sr=SAMPLE_RATE)
    return np.ascontiguousarray(audio, dtype=np.float32)


class QwenBackend:
    def __init__(self, language: str | None):
        import torch
        from qwen_asr import Qwen3ASRModel
        dev = device()
        self.language = language
        self.model = Qwen3ASRModel.from_pretrained(str(snapshot("qwen3-asr-1.7b")),
                                                   dtype=torch.float32 if dev == "cpu" else torch.bfloat16,
                                                   device_map=dev, max_inference_batch_size=1, max_new_tokens=256)

    def transcribe(self, audio) -> tuple[str, str | None]:
        result = self.model.transcribe(audio=(audio, SAMPLE_RATE), language=self.language)[0]
        return result.text, getattr(result, "language", None)


class WhisperHFBackend:
    def __init__(self, language: str | None):
        import torch
        from transformers import WhisperForConditionalGeneration, WhisperProcessor
        path = snapshot("whisper-medium")
        self.device = device()
        self.language = language
        self.processor = WhisperProcessor.from_pretrained(path)
        self.model = WhisperForConditionalGeneration.from_pretrained(path, dtype=torch.float32).to(self.device).eval()

    def transcribe(self, audio) -> tuple[str, str | None]:
        import torch
        features = self.processor(audio, sampling_rate=SAMPLE_RATE, return_tensors="pt").input_features.to(self.device)
        with torch.inference_mode():
            ids = self.model.generate(features, language=self.language, task="transcribe", num_beams=1,
                                      do_sample=False, max_new_tokens=200)
        return self.processor.batch_decode(ids, skip_special_tokens=True)[0], self.language


class WenetBackend:
    """Loads the checkpoint once and decodes each request the way WeNet's recognize.py does
    (same test-time dataset settings, the authors' beam 10 and weights 0), one item per batch."""

    def __init__(self, language: str | None, wenet_dir: str | None, mode: str):
        import copy
        import types
        import torch
        import yaml
        self.wenet = Path(wenet_dir or os.getenv("WENET_DIR", "")).expanduser()
        if not (self.wenet / "wenet" / "bin" / "recognize.py").is_file():
            raise SystemExit("set --wenet-dir (or WENET_DIR) to a WeNet checkout")
        sys.path.insert(0, str(self.wenet))
        from wenet.utils.ctc_utils import get_blank_id
        from wenet.utils.init_model import init_model
        from wenet.utils.init_tokenizer import init_tokenizer
        folder = snapshot("whisper-medium-wu") / "whisper"
        configs = yaml.load((folder / "train.yaml").read_text(encoding="utf-8"), Loader=yaml.FullLoader)
        conf = copy.deepcopy(configs["dataset_conf"])
        conf["filter_conf"].update(max_length=102400, min_length=0, token_max_length=102400, token_min_length=0,
                                   max_output_input_ratio=102400, min_output_input_ratio=0)
        conf.update(speed_perturb=False, spec_aug=False, spec_sub=False, spec_trim=False, shuffle=False,
                    sort=False, cycle=1, list_shuffle=False)
        for key in ("fbank_conf", "mfcc_conf"):
            if key in conf:
                conf[key]["dither"] = 0.0
        conf["batch_conf"].update(batch_type="static", batch_size=1)
        self.test_conf = conf
        self.tokenizer = init_tokenizer(configs)
        # As WeNet's training script does; a wrong size would fail the strict shape check below.
        configs.setdefault("vocab_size", self.tokenizer.vocab_size())
        configs.setdefault("output_dim", configs["vocab_size"])
        self.device = torch.device(os.getenv("LOCAL_ASR_DEVICE", "cpu"))
        self.model, configs = init_model(types.SimpleNamespace(jit=False), configs)
        # Tensors only: never unpickle arbitrary objects from a downloaded checkpoint.
        state = torch.load(folder / "whisper-medium.pt", map_location="cpu", weights_only=True)
        missing, unexpected = self.model.load_state_dict(state, strict=False)
        if missing or unexpected:
            raise SystemExit(f"checkpoint mismatch: {len(missing)} missing, {len(unexpected)} unexpected keys")
        self.model.tie_or_clone_weights(False)
        self.model = self.model.to(self.device).eval()
        _, self.blank_id = get_blank_id(configs, self.tokenizer.symbol_table)
        self.mode, self.language = mode, language

    def transcribe(self, audio) -> tuple[str, str | None]:
        import json
        import soundfile as sf
        import torch
        from torch.utils.data import DataLoader
        from wenet.dataset.dataset import Dataset
        with tempfile.TemporaryDirectory() as tmp:
            wav, data = Path(tmp, "a.wav"), Path(tmp, "data.jsonl")
            sf.write(wav, audio, SAMPLE_RATE, subtype="PCM_16")
            # An explicit language token: WeNet otherwise guesses it from `txt`, which is empty at test time.
            line = {"key": "utt", "wav": str(wav), "txt": "", "lang": self.language or "zh"}
            data.write_text(json.dumps(line) + "\n", encoding="utf-8")
            loader = DataLoader(Dataset("raw", str(data), self.tokenizer, self.test_conf, partition=False),
                                batch_size=None, num_workers=0)
            batch = next(iter(loader))
            with torch.no_grad():
                results = self.model.decode(
                    [self.mode], batch["feats"].to(self.device), batch["feats_lengths"].to(self.device), 10,
                    decoding_chunk_size=-1, num_decoding_left_chunks=-1, ctc_weight=0.0, simulate_streaming=False,
                    reverse_weight=0.0, context_graph=None, blank_id=self.blank_id, blank_penalty=0.0,
                    length_penalty=0.0, infos={"tasks": batch["tasks"], "langs": batch["langs"]})
        return self.tokenizer.detokenize(results[self.mode][0].tokens)[0].strip(), self.language or "zh"


def reject(loaded: str, requested: str, size: int) -> tuple[int, str] | None:
    """Refuse results that would be filed under another model, and oversized uploads."""
    if requested != loaded:
        return 400, "model mismatch"
    if size > MAX_UPLOAD:
        return 413, "audio too large"
    return None


def build_app(name: str, backend, revision: str, decode=None):
    decode = decode or read_wav
    from fastapi import FastAPI, File, Form, HTTPException, UploadFile
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

    @app.get("/health")
    def health():
        return {"model": name, "revision": revision}

    @app.post("/v1/audio/transcriptions")
    async def transcriptions(file: UploadFile = File(...), model: str = Form(...),
                             response_format: str = Form("json"), temperature: str = Form("0"),
                             language: str | None = Form(None)):
        data = await file.read(MAX_UPLOAD + 1)
        refused = reject(name, model, len(data))
        if refused:
            raise HTTPException(*refused)
        try:
            audio = decode(data)
        except Exception:
            raise HTTPException(400, "unreadable audio") from None
        started = time.monotonic()
        text, detected = backend.transcribe(audio)
        return {"text": text, "language": detected, "model": name, "revision": revision,
                "inference_ms": round((time.monotonic() - started) * 1000)}

    return app


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("model", choices=sorted(MODELS))
    parser.add_argument("--port", type=int, default=8011)
    parser.add_argument("--language", default=None,
                        help="Force a language (qwen: e.g. Chinese; whisper: e.g. zh). Default: auto-detect")
    parser.add_argument("--wenet-dir", help="WeNet checkout, for whisper-medium-wu")
    # attention_rescoring: plain `attention` beam search repeated whole sentences on the synthetic
    # wiring clips with this checkpoint and WeNet be6ad97f; chosen before any real recording.
    parser.add_argument("--wenet-mode", default="attention_rescoring",
                        help="WeNet decoding mode (default: attention_rescoring)")
    args = parser.parse_args()
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    if args.model == "qwen3-asr-1.7b":
        backend = QwenBackend(args.language)
    elif args.model == "whisper-medium":
        backend = WhisperHFBackend(args.language)
    else:
        backend = WenetBackend(args.language, args.wenet_dir, args.wenet_mode)
    import uvicorn
    uvicorn.run(build_app(args.model, backend, MODELS[args.model]["revision"]), host="127.0.0.1", port=args.port,
                log_level="warning")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
