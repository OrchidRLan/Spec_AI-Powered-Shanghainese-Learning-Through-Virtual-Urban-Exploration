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
import hashlib
import json
import platform
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
import sys
import uuid

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / ".env", override=False)
sys.path.insert(0, str(ROOT / "backend"))
from app import acoustic, evaluation, guided, interpreter, lessons, scoring
from app.providers import ASRRequest, OpenAICompatibleASR, OpenAICompatibleConfig, ProviderConfig, ProviderError, QwenASR
from app.providers.openai_compatible import LOOPBACK
from urllib.parse import urlsplit

MAX_AUDIO = 3 * 1024 * 1024
RULE_VERSIONS = {"guided": guided.GUIDED_SOURCE, "lessons": lessons.RULE_VERSION, "parser": interpreter.PARSER_VERSION,
                 "scoring": scoring.SCORING_VERSION, "cer_normalization": evaluation.NORMALIZATION_VERSION}


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def git_state() -> dict:
    def run(*cmd):
        done = subprocess.run(["git", *cmd], capture_output=True, text=True, cwd=ROOT)
        return done.stdout.strip() if done.returncode == 0 else None
    return {"commit": run("rev-parse", "HEAD"), "dirty": bool(run("status", "--porcelain", "--", "backend/app", "scripts"))}


def check_audio_leakage(items: list[dict], base: Path) -> dict:
    """Hash every input once; identical audio must not appear in both dev and test."""
    hashes, splits = {}, {}
    for item in items:
        if "audio" in item:
            digest = sha256((base / item["audio"]).read_bytes())
            hashes[item["id"]] = digest
            if item.get("split"):
                splits.setdefault(digest, set()).add(item["split"])
    if any(len(v) > 1 for v in splits.values()):
        raise evaluation.ManifestError("identical audio appears in both dev and test")
    return hashes


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


async def run_provider(name: str, items: list[dict], base: Path, args, budget: dict, hashes: dict) -> dict:
    rows = []
    extractor, calibration = args.extractor, args.calibration
    if name == "rules":
        for item in items:
            if "transcript" not in item:
                continue
            similarity, events = acoustic_for(item, base, extractor, calibration)
            rows.append(with_acoustic({**evaluation.judge(item, item["transcript"], observations=events),
                                       "provider": "rules", "input_sha256": hashes.get(item["id"])}, similarity))
        return {"provider": "rules", "config": None, "rows": rows, "summary": evaluation.summarize(rows)}
    provider, config, paid = build(name)
    if paid and not args.allow_paid_call:
        raise ProviderError("explicit_paid_call_flag_required")
    for item in items:
        if "audio" not in item:
            continue
        row_meta = {"provider": name, "config_id": config.config_id, "input_sha256": hashes.get(item["id"])}
        if paid:
            if budget["calls"] >= args.max_calls:
                rows.append({**evaluation.judge(item, None, "call_budget_exhausted"), **row_meta, "elapsed_ms": None})
                continue
            budget["calls"] += 1
        audio = (base / item["audio"]).resolve().read_bytes()
        if len(audio) > MAX_AUDIO:
            rows.append({**evaluation.judge(item, None, "audio_too_large"), **row_meta, "elapsed_ms": None})
            continue
        started = time.monotonic()
        try:  # One attempt per item: no automatic retries of possibly billed requests.
            result = await provider.transcribe(ASRRequest(audio, str(uuid.uuid4())))
            wall_ms = round((time.monotonic() - started) * 1000)
            similarity, events = acoustic_for(item, base, extractor, calibration)
            # elapsed_ms is the adapter's request round trip: upload + network + inference.
            rows.append(with_acoustic({**evaluation.judge(item, result.transcript, observations=events), **row_meta,
                                       "model": result.model, "elapsed_ms": result.elapsed_ms, "wall_ms": wall_ms},
                                      similarity))
        except ProviderError as exc:
            rows.append({**evaluation.judge(item, None, exc.code), **row_meta, "elapsed_ms": None,
                         "wall_ms": round((time.monotonic() - started) * 1000)})
    return {"provider": name, "config": config.public_dict(), "rows": rows, "summary": evaluation.summarize(rows)}


async def main_async(args) -> dict:
    manifest = Path(args.manifest).resolve()
    raw = manifest.read_bytes()
    data = json.loads(raw.decode("utf-8"))
    items = data["items"] if isinstance(data, dict) else data
    warnings = evaluation.validate(items)
    if isinstance(data, dict) and data.get("draft"):
        warnings.append("draft manifest: labels/references not fully reviewed; use only for interface checks")
    hashes = check_audio_leakage(items, manifest.parent)
    if args.split:
        items = [item for item in items if item.get("split") == args.split]
        if not items:
            raise evaluation.ManifestError(f"no items in split {args.split}")
    unreviewed = [item["id"] for item in items if "audio" in item and not item.get("reviewed_by")]
    if args.split == "test" and unreviewed:
        # The held-out set is scored only after labels and references are reviewed and frozen.
        raise evaluation.ManifestError(f"{len(unreviewed)} test items lack reviewed_by")
    budget = {"calls": 0}
    reports = [await run_provider(name, items, manifest.parent, args, budget, hashes) for name in args.provider]
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out = ROOT / "artifacts" / "local" / "asr-eval" / stamp
    out.mkdir(parents=True, exist_ok=False)
    run = {"manifest": manifest.name, "manifest_sha256": sha256(raw),
           "manifest_version": data.get("version") if isinstance(data, dict) else None,
           "split": args.split, "created_at": stamp, "git": git_state(), "rule_versions": RULE_VERSIONS,
           "machine": {"system": platform.system(), "machine": platform.machine(), "python": platform.python_version()},
           "unreviewed_audio_items": len(unreviewed), "warnings": warnings,
           "paid_calls": budget["calls"], "max_calls": args.max_calls}
    (out / "results.json").write_text(json.dumps({**run, "reports": reports}, ensure_ascii=False, indent=2),
                                      encoding="utf-8")
    console = {"results": str(out.relative_to(ROOT) / "results.json"), "paid_calls": budget["calls"],
               "split": args.split, "unreviewed_audio_items": len(unreviewed), "warnings": warnings,
               "providers": [{"provider": r["provider"], "config_id": (r["config"] or {}).get("config_id"),
                              **r["summary"]} for r in reports]}
    if args.show_transcripts:
        keys = ("id", "reference", "transcript", "verdict", "outcome", "attribution")
        console["rows"] = {r["provider"]: [{k: row.get(k) for k in keys} for row in r["rows"]] for r in reports}
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
    parser.add_argument("--split", choices=sorted(evaluation.SPLITS),
                        help="Only run items of this split; 'test' requires every audio item to have reviewed_by")
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
