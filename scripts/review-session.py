#!/usr/bin/env python3
"""Blind fluent-speaker review of pilot recordings, then merge agreed decisions into the sheets.

  backend/.venv/bin/python scripts/review-session.py serve        # open http://127.0.0.1:8766
  backend/.venv/bin/python scripts/review-session.py apply        # write agreed labels into the sheets

serve: loopback-only page. The reviewer hears each recording in a per-reviewer random order,
verifies or corrects the speaker's own transcript, and chooses a label for the question that
was asked. Model transcripts and the plan's intended labels are never shown. The reviewer also
rates each draft prompt's wording. Decisions are saved to private/asr-eval/<session>/review-<code>.json,
one file per reviewer; no reviewer's file touches another's or the sheets.

apply: for each recording, if every reviewer who rated it gave the same label and the same
reference, writes label, reference and reviewed_by into the speaker's sheet. Disagreements are
listed and left unwritten. A reviewer who is also the speaker is recorded as a self-review.
"""
import argparse
import csv
import importlib.util
import json
import random
import re
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location("asr_eval_prepare", ROOT / "scripts" / "asr-eval-prepare.py")
prepare = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(prepare)
evaluation = prepare.evaluation

LABELS = ("acceptable", "understandable", "incorrect")
WORDING = ("natural", "ok_but_unnatural", "not_shanghainese")
SELF_REVIEW = "self-review: reviewer is the speaker"
UNREVIEWED = "reference typed by the speaker, not yet reviewed"  # written by record-session.py
QUESTIONS = {  # what the speaker was answering, in the reviewer's words
    ("nanxiang", "item"): "店员问：侬要买啥？（目标：小笼馒头）",
    ("nanxiang", "mode"): "店员问：堂吃，还是打包带走？",
    ("nanxiang", "confirm"): "店员复述订单后问：对伐？（目标：确认无误）",
    ("restaurant", "preference"): "服务员问：侬吃辣伐？（目标：说自己不吃辣）",
    ("restaurant", "recommendation"): "服务员问：想听听推荐伐？（目标：请对方推荐）",
    ("candy", "quantity"): "店员问：侬要几包？（目标：两包）",
    ("teahouse", "appreciation"): "主人问：请吃茶，味道哪能？（目标：称赞茶好）",
    ("teahouse", "thanks"): "主人说：侬欢喜就好。（目标：道谢）",
}
DISH = {"fish": "清蒸鱼", "chicken": "白斩鸡", "tofu": "辣味豆腐"}
FLAVOR = {"rose": "玫瑰", "osmanthus": "桂花", "mint": "薄荷"}


def question(row: dict) -> str:
    target = json.loads(row["target"])
    key = (row["station"], row["step"])
    if key == ("nanxiang", "quantity"):
        return "店员问：要几份？（目标：两份）"
    if key == ("nanxiang", "mode"):
        return QUESTIONS[key] + ("（目标：打包带走）" if target.get("takeaway") else "（目标：堂吃）")
    if key == ("restaurant", "dish"):
        return f"服务员问：侬想要哪一道？（目标：{DISH.get(target, target)}）"
    if key == ("candy", "flavor"):
        return f"店员问：侬要哪一种？（目标：{FLAVOR.get(target, target)}味）"
    return QUESTIONS.get(key, f"{row['station']} / {row['step']}")


class Review:
    def __init__(self, folder: Path, plan_path: Path):
        self.folder = prepare.private_path(folder)
        self.plan = {p["prompt_id"]: p for p in json.loads(plan_path.read_text(encoding="utf-8"))["prompts"]}

    def sheets(self) -> list[Path]:
        return sorted(p for p in self.folder.glob("*.csv") if evaluation.SPEAKER_ID.match(p.stem))

    def recordings(self) -> list[dict]:
        out = []
        for sheet in self.sheets():
            with sheet.open(encoding="utf-8") as handle:
                for row in csv.DictReader(handle):
                    if row["audio"] and (self.folder / row["audio"]).exists():
                        out.append(row)
        return out

    def path(self, reviewer: str) -> Path:
        if not evaluation.SPEAKER_ID.match(reviewer) or not reviewer.startswith("R"):
            raise ValueError("reviewer code must look like R01")
        return prepare.private_path(self.folder / f"review-{reviewer}.json")

    def load(self, reviewer: str) -> dict:
        path = self.path(reviewer)
        return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}

    def items(self, reviewer: str) -> list[dict]:
        rows = self.recordings()
        random.Random(reviewer).shuffle(rows)  # stable per reviewer, different between reviewers
        return [{"id": r["id"], "question": question(r), "silent": r["condition"] in prepare.EMPTY_REFERENCE_OK,
                 "speaker_text": r["reference"]} for r in rows]

    def drafts(self) -> list[dict]:
        return [{"prompt_id": p["prompt_id"], "say": p["say"], "note": p.get("note", "")}
                for p in self.plan.values() if p.get("say_source") == "draft"]

    def save(self, reviewer: str, data: dict) -> None:
        current = self.load(reviewer)
        ids = {r["id"] for r in self.recordings()}
        if "profile" in data:
            profile = data["profile"]
            current["profile"] = {"fluency": str(profile.get("fluency", ""))[:80],
                                  "is_speaker_of": [s for s in profile.get("is_speaker_of", [])
                                                    if evaluation.SPEAKER_ID.match(s)]}
        if "item" in data:
            item = data["item"]
            if item["id"] not in ids or item.get("label") not in LABELS:
                raise ValueError("invalid item decision")
            current.setdefault("items", {})[item["id"]] = {
                "label": item["label"], "reference": str(item.get("reference", "")).strip()[:200],
                "note": str(item.get("note", "")).strip()[:300], "at": time.strftime("%Y-%m-%dT%H:%M:%S")}
        if "draft" in data:
            draft = data["draft"]
            if draft["prompt_id"] not in self.plan or draft.get("wording") not in WORDING:
                raise ValueError("invalid draft decision")
            current.setdefault("drafts", {})[draft["prompt_id"]] = {
                "wording": draft["wording"], "suggestion": str(draft.get("suggestion", "")).strip()[:200]}
        tmp = self.path(reviewer).with_suffix(".tmp")
        tmp.write_text(json.dumps(current, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(self.path(reviewer))

    def apply(self) -> dict:
        reviews = {p.stem.removeprefix("review-"): json.loads(p.read_text(encoding="utf-8"))
                   for p in sorted(self.folder.glob("review-R*.json"))}
        written, disagreements, unreviewed = [], [], []
        for sheet in self.sheets():
            with sheet.open(encoding="utf-8") as handle:
                rows = list(csv.DictReader(handle))
            for row in rows:
                if not row["audio"] or not (self.folder / row["audio"]).exists():
                    continue
                votes = {code: r["items"][row["id"]] for code, r in reviews.items() if row["id"] in r.get("items", {})}
                if not votes:
                    unreviewed.append(row["id"])
                    continue
                if len({(v["label"], v["reference"]) for v in votes.values()}) > 1:
                    disagreements.append({"id": row["id"], "votes": votes})
                    continue
                vote = next(iter(votes.values()))
                notes = [n for n in row["notes"].split("; ")  # re-applying replaces earlier review notes
                         if n and n not in (UNREVIEWED, SELF_REVIEW) and not re.match(r"R\d{2,3}: ", n)]
                if any(row["speaker_id"] in reviews[c].get("profile", {}).get("is_speaker_of", []) for c in votes):
                    notes.append(SELF_REVIEW)
                notes += [f"{c}: {v['note']}" for c, v in votes.items() if v["note"]]
                row.update(label=vote["label"], reference=vote["reference"], reviewed_by=";".join(sorted(votes)),
                           notes="; ".join(notes))
                written.append(row["id"])
            tmp = sheet.with_suffix(".tmp")
            with tmp.open("w", newline="", encoding="utf-8") as handle:
                writer = csv.DictWriter(handle, prepare.COLUMNS)
                writer.writeheader()
                writer.writerows(rows)
            tmp.replace(sheet)
        drafts = {code: r.get("drafts", {}) for code, r in reviews.items()}
        return {"reviewers": sorted(reviews), "written": len(written), "disagreements": disagreements,
                "unreviewed": unreviewed, "draft_wording": drafts}


def serve(review: Review, port: int) -> None:
    page = (ROOT / "scripts" / "review-session.html").read_bytes()
    by_id = lambda item_id: next((r for r in review.recordings() if r["id"] == item_id), None)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def reply(self, status, body, kind="application/json; charset=utf-8"):
            self.send_response(status)
            self.send_header("Content-Type", kind)
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def json(self, status, data):
            self.reply(status, json.dumps(data, ensure_ascii=False).encode())

        def do_GET(self):
            path = urlsplit(self.path).path
            if path == "/":
                return self.reply(200, page, "text/html; charset=utf-8")
            if path == "/api/speakers":
                return self.json(200, {"speakers": [p.stem for p in review.sheets()]})
            if path.startswith("/audio/"):
                row = by_id(path.removeprefix("/audio/"))
                if row:
                    return self.reply(200, (review.folder / row["audio"]).read_bytes(), "audio/wav")
            self.json(404, {"error": "not found"})

        def do_POST(self):
            path = urlsplit(self.path).path
            body = self.rfile.read(min(int(self.headers.get("Content-Length") or 0), 65536))
            try:
                data = json.loads(body)
                reviewer = data["reviewer"]
                if path == "/api/start":
                    if data.get("profile"):
                        review.save(reviewer, {"profile": data["profile"]})
                    saved = review.load(reviewer)
                    return self.json(200, {"items": review.items(reviewer), "drafts": review.drafts(), "saved": saved})
                if path == "/api/save":
                    review.save(reviewer, data)
                    return self.json(200, {"ok": True})
            except (ValueError, KeyError, TypeError, json.JSONDecodeError) as exc:
                return self.json(400, {"error": str(exc)})
            self.json(404, {"error": "not found"})

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"Review page: http://127.0.0.1:{port}  ({len(review.recordings())} recordings in "
          f"{review.folder.relative_to(ROOT)})", flush=True)
    server.serve_forever()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=["serve", "apply"])
    parser.add_argument("--session", default="pilot-v1")
    parser.add_argument("--plan", default=str(ROOT / "scripts" / "asr-eval-plan.json"))
    parser.add_argument("--port", type=int, default=8766)
    args = parser.parse_args()
    review = Review(ROOT / "private" / "asr-eval" / args.session, Path(args.plan))
    if args.command == "serve":
        serve(review, args.port)
    else:
        print(json.dumps(review.apply(), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
