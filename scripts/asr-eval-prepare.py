#!/usr/bin/env python3
"""Prepare private ASR evaluation recordings: annotation sheets, WAV conversion, frozen manifest.

  sheet    Write one speaker's annotation CSV from the recording plan.
  convert  Convert recordings to 16 kHz mono PCM16 WAV with macOS afconvert, keeping originals.
  freeze   Check annotated CSVs and audio, hash every file, and write a versioned manifest.

All outputs must live under private/ (ignored by Git). Nothing here calls a model.
"""
import argparse
import csv
import hashlib
import json
import shutil
import subprocess
import sys
import wave
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
from app import evaluation

COLUMNS = ["id", "prompt_id", "speaker_id", "speaker_group", "source", "split", "utterance_group", "station", "step",
           "target", "candy_flavor", "condition", "say", "audio", "reference", "label", "reviewed_by", "device",
           "environment", "original_audio", "processing", "notes"]
EMPTY_REFERENCE_OK = {"silence", "noise"}


def private_path(path: Path) -> Path:
    path = path.resolve()
    if ROOT / "private" not in path.parents:
        raise SystemExit(f"refusing to write outside private/: {path}")
    ignored = subprocess.run(["git", "check-ignore", "-q", str(path)], cwd=ROOT).returncode == 0
    if not ignored:
        raise SystemExit(f"{path} is not ignored by Git; fix .gitignore before storing recordings")
    return path


def sheet(args) -> None:
    plan = json.loads(Path(args.plan).read_text(encoding="utf-8"))
    if not evaluation.SPEAKER_ID.match(args.speaker):
        raise SystemExit("speaker must be an anonymous code such as S01")
    source = "synthetic" if args.group == "synthetic" else "human"
    out = private_path(Path(args.out))
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("x", newline="", encoding="utf-8") as handle:  # never overwrite annotations
        writer = csv.DictWriter(handle, COLUMNS)
        writer.writeheader()
        for prompt in plan["prompts"]:
            for take in range(1, args.takes + 1):
                suffix = f"-t{take}" if args.takes > 1 else ""
                writer.writerow({
                    "id": f"{args.speaker}-{prompt['prompt_id']}{suffix}", "prompt_id": prompt["prompt_id"],
                    "speaker_id": args.speaker, "speaker_group": args.group, "source": source, "split": args.split,
                    "utterance_group": f"{args.speaker}-{prompt['prompt_id']}", "station": prompt["station"],
                    "step": prompt["step"], "target": json.dumps(prompt["target"], ensure_ascii=False),
                    "candy_flavor": prompt.get("candy_flavor", ""), "condition": prompt["condition"],
                    "say": prompt["say"], "audio": f"{args.speaker}/{prompt['prompt_id']}{suffix}.wav"})
    print(json.dumps({"sheet": str(out.relative_to(ROOT)), "rows": len(plan["prompts"]) * args.takes}))


def convert(args) -> None:
    if not shutil.which("afconvert"):
        raise SystemExit("afconvert not found (macOS only); convert to 16 kHz mono PCM16 WAV another way")
    src, dst = Path(args.src).resolve(), private_path(Path(args.dst))
    converted = []
    for original in sorted(p for p in src.rglob("*") if p.is_file() and not p.name.startswith(".")):
        target = dst / original.relative_to(src).with_suffix(".wav")
        if target.exists():
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["afconvert", "-f", "WAVE", "-d", "LEI16@16000", "-c", "1", str(original), str(target)], check=True)
        converted.append({"original": str(original.relative_to(src)), "wav": str(target.relative_to(dst)),
                          "original_sha256": hashlib.sha256(original.read_bytes()).hexdigest(),
                          "processing": "afconvert -f WAVE -d LEI16@16000 -c 1"})
    log = dst / "conversion-log.json"
    previous = json.loads(log.read_text()) if log.exists() else []
    log.write_text(json.dumps(previous + converted, ensure_ascii=False, indent=2))
    print(json.dumps({"converted": len(converted), "log": str(log.relative_to(ROOT))}))


def audio_info(path: Path) -> dict:
    data = path.read_bytes()
    try:
        with wave.open(str(path)) as handle:
            info = {"sample_rate": handle.getframerate(), "channels": handle.getnchannels(),
                    "sample_width": handle.getsampwidth(),
                    "duration_ms": round(handle.getnframes() * 1000 / handle.getframerate())}
    except wave.Error as exc:
        raise SystemExit(f"{path.name}: not a PCM WAV ({exc}); run convert first") from None
    if info["sample_width"] != 2:
        raise SystemExit(f"{path.name}: expected PCM16")
    return {"sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data), **info}


def freeze(args) -> None:
    out = private_path(Path(args.out))
    if out.exists():
        raise SystemExit(f"{out.name} exists: frozen manifests are never overwritten; choose a new version")
    items, problems = [], []
    for sheet_path in args.csv:
        sheet_path = Path(sheet_path).resolve()
        with sheet_path.open(encoding="utf-8") as handle:
            for row in csv.DictReader(handle):
                item_id = row["id"]
                if not row["label"] and not args.draft:
                    problems.append(f"{item_id}: label missing")
                if not row["reference"] and row["condition"] not in EMPTY_REFERENCE_OK and not args.draft:
                    problems.append(f"{item_id}: reference (what was actually said) missing")
                audio = (out.parent / row["audio"]).resolve()
                if not audio.exists():
                    problems.append(f"{item_id}: audio {row['audio']} not found next to the manifest")
                    continue
                item = {"id": item_id, "station": row["station"], "step": row["step"],
                        "target": json.loads(row["target"]), "label": row["label"] or "incorrect",
                        "reference": row["reference"], "audio": row["audio"], "audio_info": audio_info(audio)}
                for field in ("speaker_id", "speaker_group", "source", "split", "utterance_group", "condition",
                              "candy_flavor", "device", "environment", "original_audio", "processing", "notes"):
                    if row.get(field):
                        item[field] = row[field]
                if row["reviewed_by"]:
                    item["reviewed_by"] = [code.strip() for code in row["reviewed_by"].split(";") if code.strip()]
                if args.draft and not row["label"]:
                    item["label_status"] = "missing"
                items.append(item)
    if problems:
        raise SystemExit("\n".join(problems))
    warnings = evaluation.validate(items)
    manifest = {"version": args.version, "frozen_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "draft": bool(args.draft), "plan": args.plan_version, "warnings": warnings, "items": items}
    out.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"manifest": str(out.relative_to(ROOT)), "items": len(items), "draft": bool(args.draft),
                      "warnings": warnings}, ensure_ascii=False))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    s = sub.add_parser("sheet")
    s.add_argument("--plan", default=str(ROOT / "scripts" / "asr-eval-plan.json"))
    s.add_argument("--speaker", required=True, help="Anonymous code such as S01")
    s.add_argument("--group", required=True, choices=sorted(evaluation.SPEAKER_GROUPS))
    s.add_argument("--split", required=True, choices=sorted(evaluation.SPLITS))
    s.add_argument("--takes", type=int, default=1)
    s.add_argument("--out", required=True)
    c = sub.add_parser("convert")
    c.add_argument("src")
    c.add_argument("dst")
    f = sub.add_parser("freeze")
    f.add_argument("csv", nargs="+")
    f.add_argument("--out", required=True, help="Manifest path under private/; audio paths resolve next to it")
    f.add_argument("--version", required=True)
    f.add_argument("--plan-version", default="asr-recording-plan.pilot-v1")
    f.add_argument("--draft", action="store_true", help="Allow missing labels/references (pilot interface checks only)")
    args = parser.parse_args()
    {"sheet": sheet, "convert": convert, "freeze": freeze}[args.command](args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
