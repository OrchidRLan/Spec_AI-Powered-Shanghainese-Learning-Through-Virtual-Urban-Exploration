#!/usr/bin/env python3
"""Compare ASR providers on the same labeled recordings with the same scoring rules.

Providers:
  rules              Use each item's saved `transcript`; no network (default).
  qwen               Configured DashScope ASR. Paid: needs --allow-paid-call and --max-calls.
  openai_compatible  ASR_PROVIDER-style local/self-hosted server (LOCAL_ASR_* settings).
                     Free on loopback; a non-loopback endpoint is treated as paid.

Results (including transcripts) are written only to artifacts/local/asr-eval/,
which Git ignores. The console prints metrics, not transcripts, unless asked.
"""
import argparse
import asyncio
import json
from datetime import datetime, timezone
from pathlib import Path
import sys
import uuid

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / ".env", override=False)
sys.path.insert(0, str(ROOT / "backend"))
from app import acoustic, evaluation
from app.providers import ASRRequest, OpenAICompatibleASR, OpenAICompatibleConfig, ProviderConfig, ProviderError, QwenASR
from app.providers.openai_compatible import LOOPBACK
from urllib.parse import urlsplit

MAX_AUDIO = 3 * 1024 * 1024


def build(name: str):
    if name == "qwen":
        config = ProviderConfig.from_env("asr")
        return QwenASR(config), config, True
    if name == "openai_compatible":
        config = OpenAICompatibleConfig.from_env()
        return OpenAICompatibleASR(config), config, urlsplit(config.endpoint).hostname not in LOOPBACK
    raise ProviderError("invalid_provider")


def acoustic_for(item: dict, base: Path, extractor, calibration):
    """Optional reference-audio similarity; never blocks the ASR comparison."""
    if extractor is None or "audio" not in item or "reference_audio" not in item:
        return None, None
    result = acoustic.compare((base / item["audio"]).read_bytes(), (base / item["reference_audio"]).read_bytes(), extractor)
    return result["similarity"], acoustic.observations(result["similarity"], calibration)


def with_acoustic(row: dict, similarity) -> dict:
    return {**row, "acoustic_similarity": similarity}


async def run_provider(name: str, items: list[dict], base: Path, args, budget: dict) -> dict:
    rows = []
    extractor, calibration = args.extractor, args.calibration
    if name == "rules":
        for item in items:
            if "transcript" not in item:
                continue
            similarity, events = acoustic_for(item, base, extractor, calibration)
            rows.append(with_acoustic(evaluation.judge(item, item["transcript"], observations=events), similarity))
        return {"provider": "rules", "config": None, "rows": rows, "summary": evaluation.summarize(rows)}
    provider, config, paid = build(name)
    if paid and not args.allow_paid_call:
        raise ProviderError("explicit_paid_call_flag_required")
    for item in items:
        if "audio" not in item:
            continue
        if paid:
            if budget["calls"] >= args.max_calls:
                rows.append({**evaluation.judge(item, None, "call_budget_exhausted"), "elapsed_ms": None})
                continue
            budget["calls"] += 1
        path = (base / item["audio"]).resolve()
        audio = path.read_bytes()
        if len(audio) > MAX_AUDIO:
            rows.append({**evaluation.judge(item, None, "audio_too_large"), "elapsed_ms": None})
            continue
        try:  # One attempt per item: no automatic retries of possibly billed requests.
            result = await provider.transcribe(ASRRequest(audio, str(uuid.uuid4())))
            similarity, events = acoustic_for(item, base, extractor, calibration)
            rows.append(with_acoustic({**evaluation.judge(item, result.transcript, observations=events),
                                       "elapsed_ms": result.elapsed_ms}, similarity))
        except ProviderError as exc:
            rows.append({**evaluation.judge(item, None, exc.code), "elapsed_ms": None})
    return {"provider": name, "config": config.public_dict(), "rows": rows, "summary": evaluation.summarize(rows)}


async def main_async(args) -> dict:
    manifest = Path(args.manifest).resolve()
    data = json.loads(manifest.read_text(encoding="utf-8"))
    items = data["items"] if isinstance(data, dict) else data
    evaluation.validate(items)
    budget = {"calls": 0}
    reports = [await run_provider(name, items, manifest.parent, args, budget) for name in args.provider]
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out = ROOT / "artifacts" / "local" / "asr-eval" / stamp
    out.mkdir(parents=True, exist_ok=False)
    (out / "results.json").write_text(json.dumps({"manifest": manifest.name, "created_at": stamp,
        "paid_calls": budget["calls"], "reports": reports}, ensure_ascii=False, indent=2), encoding="utf-8")
    console = {"results": str(out.relative_to(ROOT) / "results.json"), "paid_calls": budget["calls"],
               "providers": [{"provider": r["provider"], "config_id": (r["config"] or {}).get("config_id"),
                              **r["summary"]} for r in reports]}
    if args.show_transcripts:
        console["rows"] = {r["provider"]: [{k: row.get(k) for k in ("id", "transcript", "verdict", "outcome")}
                                           for row in r["rows"]] for r in reports}
    return console


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("manifest", help="JSON manifest of labeled items (see scripts/asr-eval.example.json)")
    parser.add_argument("--provider", action="append", choices=["rules", "qwen", "openai_compatible"],
                        help="Repeat to compare several; default: rules")
    parser.add_argument("--allow-paid-call", action="store_true", help="Required for qwen or a non-loopback server")
    parser.add_argument("--max-calls", type=int, default=0, help="Upper bound on paid transcription calls")
    parser.add_argument("--acoustic", action="store_true",
                        help="Also compare each item's audio with its reference_audio (needs requirements-acoustic.txt)")
    parser.add_argument("--calibration", help="JSON {minor_below, severe_below, confidence}; without it similarity costs 0 points")
    parser.add_argument("--show-transcripts", action="store_true", help="Also print transcripts to the console")
    args = parser.parse_args()
    args.provider = args.provider or ["rules"]
    args.extractor = acoustic.WavLMExtractor() if args.acoustic else None
    args.calibration = json.loads(Path(args.calibration).read_text()) if args.calibration else None
    try:
        print(json.dumps(asyncio.run(main_async(args)), ensure_ascii=False, indent=2))
        return 0
    except (ProviderError, evaluation.ManifestError, OSError, KeyError, json.JSONDecodeError) as exc:
        print(json.dumps({"error": getattr(exc, "code", None) or str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
