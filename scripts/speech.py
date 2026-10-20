#!/usr/bin/env python3
"""No network by default. Explicit smoke / generation commands may incur API charges."""
import argparse
import asyncio
import json
from pathlib import Path
import sys
import uuid
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / ".env", override=False)
sys.path.insert(0, str(ROOT / "backend"))
from app.providers import ASRRequest, ProviderConfig, ProviderError, QwenInterpreter, asr_from_env, tts_from_env
from app.providers.production import approved_text, produce_audio


def content_file(value: str) -> dict:
    path = (ROOT / value).resolve()
    if not path.is_relative_to(ROOT / "content"):
        raise ProviderError("content_path_required")
    return json.loads(path.read_text(encoding="utf-8"))


async def run(args: argparse.Namespace) -> dict:
    if args.command == "config":
        return {"network_calls": 0, "services": [asr_from_env()[1].public_dict(), tts_from_env().config.public_dict(),
                                                ProviderConfig.from_env("llm").public_dict()]}
    if args.command == "tts-check":
        entry = approved_text(content_file(args.pack), content_file(args.reviews), args.text_id)
        return {"text_id": entry["id"], "text_version": entry["version"], "eligible": True, "network_calls": 0}
    if not args.allow_paid_call:
        raise ProviderError("explicit_paid_call_flag_required")
    if args.command == "asr-smoke":
        path = Path(args.audio).expanduser().resolve()
        if path.stat().st_size > 3 * 1024 * 1024:
            raise ProviderError("audio_too_large")
        result = await asr_from_env()[0].transcribe(ASRRequest(path.read_bytes(), str(uuid.uuid4())))
        # Do not persist raw audio or transcript in console logs by default.
        return {"status": result.status, "config_id": result.config_id, "elapsed_ms": result.elapsed_ms,
                "upstream_request_id": result.upstream_request_id, "transcript_characters": len(result.transcript),
                "transcript": result.transcript if args.show_transcript else None,
                "quality_review": "pending"}
    if args.command == "llm-smoke":
        result = await QwenInterpreter(ProviderConfig.from_env("llm")).interpret(
            "Two servings to take away", {"scene": "nanxiang", "menu": ["xiaolongbao"]})
        return {"intent": result.intent, "changes": result.changes, "evidence": result.evidence,
                "config_id": result.config_id, "elapsed_ms": result.elapsed_ms, "upstream_request_id": result.upstream_request_id}
    if args.command == "tts-generate":
        result = await produce_audio(content_file(args.pack), content_file(args.reviews), args.text_id,
            tts_from_env(), ROOT / "artifacts" / "audio", args.speed)
        return {"generation_id": result["generationId"], "file": "artifacts/audio/" + result["file"],
                "sha256": result["sha256"], "status": result["status"], "listening_review": "pending"}
    raise ProviderError("invalid_command")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("config", help="Read configuration only; no network calls or secret values")
    for name in ("tts-check", "tts-generate"):
        sub = commands.add_parser(name)
        sub.add_argument("--pack", default="content/batch-a.json")
        sub.add_argument("--reviews", default="content/reviews.json")
        sub.add_argument("--text-id", required=True)
        if name == "tts-generate":
            sub.add_argument("--speed", choices=("normal", "slow"), default="normal")
            sub.add_argument("--allow-paid-call", action="store_true")
    asr = commands.add_parser("asr-smoke")
    asr.add_argument("--audio", required=True)
    asr.add_argument("--show-transcript", action="store_true")
    asr.add_argument("--allow-paid-call", action="store_true")
    llm = commands.add_parser("llm-smoke")
    llm.add_argument("--allow-paid-call", action="store_true")
    args = parser.parse_args()
    try:
        print(json.dumps(asyncio.run(run(args)), ensure_ascii=False, indent=2))
        return 0
    except ProviderError as error:
        print(json.dumps({"status": "pending", "error": error.public_dict()}, ensure_ascii=False))
        return 2
    except (OSError, ValueError, KeyError, TypeError):
        print(json.dumps({"status": "pending", "error": {"code": "invalid_local_input", "retryable": False}}))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
