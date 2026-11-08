#!/usr/bin/env python3
"""Local recording page for the ASR pilot: shows each plan prompt, records it, saves 16 kHz WAV.

  backend/.venv/bin/python scripts/record-session.py            # then open http://127.0.0.1:8765

Loopback only. Writes only under private/asr-eval/<session>/ (ignored by Git):
<speaker>.csv (the annotation sheet from asr-eval-prepare.py) and <speaker>/<prompt>.wav.
A re-take moves the earlier file to <speaker>/_retakes/ instead of deleting it.
The browser records with the app's own microphone settings (mono, echo cancellation and
noise suppression on) and encodes 16 kHz mono PCM16 itself, so no conversion is needed.
What the speaker types as "actually said" is stored as an unreviewed `reference`;
`label` and `reviewed_by` are left for the fluent reviewer.
"""
import argparse
import csv
import importlib.util
import io
import json
import shutil
import time
import wave
from argparse import Namespace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location("asr_eval_prepare", ROOT / "scripts" / "asr-eval-prepare.py")
prepare = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(prepare)
evaluation = prepare.evaluation

MAX_BYTES = 2 * 1024 * 1024  # 60 s at 16 kHz PCM16
PROCESSING = "browser getUserMedia mono, echoCancellation+noiseSuppression on (as in the app); encoded 16 kHz PCM16 in page"
SELF_REPORTED = "reference typed by the speaker, not yet reviewed"


class Session:
    def __init__(self, folder: Path, plan_path: Path):
        self.folder = prepare.private_path(folder)
        self.plan = json.loads(plan_path.read_text(encoding="utf-8"))
        self.plan_path = plan_path
        self.prompts = {p["prompt_id"]: p for p in self.plan["prompts"]}
        self.speaker = None

    def sheet(self) -> Path:
        return self.folder / f"{self.speaker}.csv"

    def start(self, speaker: str, group: str, device: str, environment: str) -> None:
        if not evaluation.SPEAKER_ID.match(speaker):
            raise ValueError("speaker must be an anonymous code such as S01")
        if group not in evaluation.SPEAKER_GROUPS - {"synthetic"}:
            raise ValueError("invalid speaker group")
        self.speaker = speaker
        if not self.sheet().exists():
            prepare.sheet(Namespace(plan=str(self.plan_path), speaker=speaker, group=group, split="dev", takes=1,
                                    out=str(self.sheet())))
        self.device, self.environment = device[:120], environment[:120]

    def rows(self) -> list[dict]:
        with self.sheet().open(encoding="utf-8") as handle:
            return list(csv.DictReader(handle))

    def write_rows(self, rows: list[dict]) -> None:
        tmp = self.sheet().with_suffix(".tmp")
        with tmp.open("w", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(handle, prepare.COLUMNS)
            writer.writeheader()
            writer.writerows(rows)
        tmp.replace(self.sheet())

    def state(self) -> dict:
        rows = self.rows() if self.speaker else []
        done = {r["prompt_id"]: r for r in rows if r["audio"] and (self.folder / r["audio"]).exists()}
        return {"speaker": self.speaker, "folder": str(self.folder.relative_to(ROOT)),
                "prompts": [{**p, "recorded": p["prompt_id"] in done,
                             "reference": done.get(p["prompt_id"], {}).get("reference", "")}
                            for p in self.plan["prompts"]]}

    def save(self, prompt_id: str, audio: bytes, reference: str, note: str) -> dict:
        if self.speaker is None:
            raise ValueError("start the session first")
        if prompt_id not in self.prompts:
            raise ValueError("unknown prompt")
        if len(audio) > MAX_BYTES:
            raise ValueError("recording too long")
        with wave.open(io.BytesIO(audio)) as handle:
            info = (handle.getframerate(), handle.getnchannels(), handle.getsampwidth())
            seconds = handle.getnframes() / handle.getframerate()
        if info != (16000, 1, 2) or not 0.3 <= seconds <= 60:
            raise ValueError(f"expected 16 kHz mono PCM16, 0.3-60 s; got {info}, {seconds:.1f} s")
        rows = self.rows()
        row = next(r for r in rows if r["prompt_id"] == prompt_id)
        target = prepare.private_path(self.folder / row["audio"])
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists():  # keep every earlier take
            retakes = target.parent / "_retakes"
            retakes.mkdir(exist_ok=True)
            shutil.move(target, retakes / f"{target.stem}-{time.strftime('%Y%m%dT%H%M%S')}.wav")
        target.write_bytes(audio)
        notes = [SELF_REPORTED] if reference else []
        if note:
            notes.append(note[:300])
        row.update(reference=reference[:200], device=self.device, environment=self.environment,
                   processing=PROCESSING, notes="; ".join(notes))
        self.write_rows(rows)
        return {"saved": row["audio"], "seconds": round(seconds, 2)}


def handler_for(session: Session, page: bytes):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def reply(self, status: int, body: bytes, kind: str = "application/json; charset=utf-8"):
            self.send_response(status)
            self.send_header("Content-Type", kind)
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def json(self, status: int, data: dict):
            self.reply(status, json.dumps(data, ensure_ascii=False).encode())

        def do_GET(self):
            path = urlsplit(self.path).path
            if path == "/":
                return self.reply(200, page, "text/html; charset=utf-8")
            if path == "/api/state":
                return self.json(200, session.state())
            if path.startswith("/audio/") and session.speaker:
                prompt_id = path.removeprefix("/audio/")
                row = next((r for r in session.rows() if r["prompt_id"] == prompt_id), None)
                if row and (session.folder / row["audio"]).exists():
                    return self.reply(200, (session.folder / row["audio"]).read_bytes(), "audio/wav")
            self.json(404, {"error": "not found"})

        def do_POST(self):
            url = urlsplit(self.path)
            length = int(self.headers.get("Content-Length") or 0)
            if length > MAX_BYTES:
                return self.json(413, {"error": "too large"})
            body = self.rfile.read(length)
            try:
                if url.path == "/api/start":
                    data = json.loads(body)
                    session.start(data["speaker"], data["group"], data.get("device", ""), data.get("environment", ""))
                    return self.json(200, session.state())
                if url.path == "/api/clip":
                    q = {k: v[0] for k, v in parse_qs(url.query).items()}
                    return self.json(200, session.save(q.get("prompt", ""), body, q.get("reference", "").strip(),
                                                       q.get("note", "").strip()))
            except (ValueError, KeyError, wave.Error, json.JSONDecodeError) as exc:
                return self.json(400, {"error": str(exc)})
            self.json(404, {"error": "not found"})

    return Handler


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--session", default="pilot-v1", help="Folder name under private/asr-eval/")
    parser.add_argument("--plan", default=str(ROOT / "scripts" / "asr-eval-plan.json"))
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    session = Session(ROOT / "private" / "asr-eval" / args.session, Path(args.plan))
    page = (ROOT / "scripts" / "record-session.html").read_bytes()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), handler_for(session, page))
    print(f"Recording page: http://127.0.0.1:{args.port}  (saving under {session.folder.relative_to(ROOT)})", flush=True)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
