"""Transactional, session-owned API for versioned station lessons."""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

from fastapi import Request
from fastapi.responses import Response

from . import lessons, scoring
from .guided import PracticeError
from .models import LessonInput, RevisionInput
from .storage import encode


def register(app, database, *, session_id, owned_attempt, public_attempt, problem, now, identifier, root: Path):
    def require_lesson(connection, attempt):
        if (attempt.get("rule_version") != lessons.RULE_VERSION or attempt.get("content_version") != lessons.CONTENT_VERSION
                or "lesson" not in attempt or attempt["station_id"] not in lessons.STEPS):
            problem("lesson_version_required", "This attempt uses another lesson version.", attempt=public_attempt(connection, attempt))

    def saved_response(connection, attempt, row):
        if row["status"] == "cancelled":
            return {"request_id": row["request_id"], "status": "cancelled", "attempt": public_attempt(connection, attempt)}
        return json.loads(row["response"])

    def evaluate(connection, sid, attempt, body):
        transcript, status, reason, reported_by = None, None, None, "client"
        if body.asr_request_id:
            used = connection.execute("SELECT request_id FROM practice_asr_uses WHERE session_id=? AND asr_request_id=?", (sid, body.asr_request_id)).fetchone()
            if used:
                problem("asr_result_already_used", "This transcription has already been evaluated. Record a new reply.", attempt=public_attempt(connection, attempt))
            row = connection.execute("SELECT response FROM asr_requests WHERE session_id=? AND request_id=?", (sid, body.asr_request_id)).fetchone()
            if row is None or not row["response"]:
                if body.failure_kind != "technical":
                    problem("asr_result_required", "Use a finished transcription from your own session.", 422)
                saved, status, reason = {}, "technical", "device_or_service_unavailable"
            else:
                saved, reported_by = json.loads(row["response"]), "server"
            if "transcript" in saved:
                transcript = saved["transcript"]
                if body.failure_kind != "technical" and (body.failure_kind is not None or body.text != transcript):
                    problem("original_transcript_required", "Keep the original saved transcription unchanged.", 422)
            elif "error" in saved:
                if body.failure_kind is None:
                    problem("asr_result_required", "This recording did not return a transcript.", 422)
                status, reason = ("unrecognized", "no_speech") if saved["error"]["code"] == "no_speech" else ("technical", "asr_failed")
            elif status is None:
                problem("asr_result_required", "This recording did not return a usable result.", 422)
        elif body.failure_kind == "recognition":
            status, reason = "unrecognized", "no_speech"
        else:
            status, reason = "technical", "device_or_service_unavailable"
        if attempt["lesson"]["target"] is None:
            problem("lesson_target_required", "Select what you want to say first.", attempt=public_attempt(connection, attempt))
        scored = scoring.unscored(status)
        if transcript is not None:
            status, reason, scored = scoring.assess_lenient(
                transcript, lambda text: lessons.assess(text, attempt), attempt["lesson"]["step"])
        return {"request_id": body.request_id, "transcript": transcript, "status": status, "reason": reason,
                "channel": "technical" if status == "technical" else "voice", "reported_by": reported_by,
                "asr_request_id": body.asr_request_id, "interpretation_source": lessons.SOURCE if transcript is not None else None,
                "scoring": scored}

    @app.post("/api/attempts/{attempt_id}/lesson")
    def operation(attempt_id: str, body: LessonInput, request: Request):
        payload = encode(body.model_dump(exclude_unset=True))
        fingerprint = hashlib.sha256(payload.encode()).hexdigest()
        with database.transaction() as connection:
            sid = session_id(request, connection)
            attempt = owned_attempt(connection, sid, attempt_id)
            require_lesson(connection, attempt)
            previous = connection.execute("SELECT * FROM lesson_requests WHERE attempt_id=? AND request_id=?", (attempt_id, body.request_id)).fetchone()
            if previous:
                if previous["status"] != "cancelled" and previous["fingerprint"] != fingerprint:
                    problem("idempotency_conflict", "This request ID was already used for different input.", attempt=public_attempt(connection, attempt))
                return saved_response(connection, attempt, previous)
            if attempt["status"] in ("completed", "skipped"):
                problem("attempt_closed", "This attempt has ended. Start a new practice.", attempt=public_attempt(connection, attempt))
            if attempt["revision"] != body.expected_revision:
                problem("stale_revision", "The question changed. Review the current question.", attempt=public_attempt(connection, attempt))
            evaluation = evaluate(connection, sid, attempt, body) if body.operation == "evaluate" else None
            try:
                result, events = lessons.apply(attempt, body, evaluation)
            except PracticeError as exc:
                problem(exc.code, exc.message, attempt=public_attempt(connection, attempt))
            result["updated_at"] = now()
            if app.state.before_commit:
                app.state.before_commit()
            database.save_attempt(connection, result)
            if body.operation == "evaluate" and body.asr_request_id:
                connection.execute("INSERT INTO practice_asr_uses VALUES (?,?,?,?)", (sid, body.asr_request_id, attempt_id, body.request_id))
            for event in events:
                metadata = {"request_id": body.request_id, "revision": result["revision"], "previous_revision": attempt["revision"],
                            "step": attempt["lesson"]["step"], "step_id": attempt["lesson"]["step_id"], "assisted": body.assisted,
                            "result": evaluation, "option_id": body.option_id if body.operation == "select" else attempt["lesson"]["target"]}
                if event == "task_completed":
                    metadata.update(answers=result["lesson"]["answers"], metrics=result["metrics"])
                if event == "lesson_introduction_played":
                    metadata["reported_by"] = "client"
                database.event(connection, sid, attempt_id, identifier(), event, metadata, now())
            response = {"request_id": body.request_id, "status": "applied", "attempt": public_attempt(connection, result)}
            connection.execute("INSERT INTO lesson_requests VALUES (?,?,?,?,?,?,?)", (attempt_id, body.request_id, fingerprint, "applied", payload, encode(response), now()))
            return response

    @app.get("/api/attempts/{attempt_id}/lesson/{request_id}")
    def get_operation(attempt_id: str, request_id: str, request: Request):
        with database.transaction() as connection:
            attempt = owned_attempt(connection, session_id(request, connection), attempt_id)
            require_lesson(connection, attempt)
            row = connection.execute("SELECT * FROM lesson_requests WHERE attempt_id=? AND request_id=?", (attempt_id, request_id)).fetchone()
            if row is None:
                problem("lesson_request_not_found", "No saved lesson operation has this ID.", 404)
            return saved_response(connection, attempt, row)

    @app.post("/api/attempts/{attempt_id}/lesson/{request_id}/cancel")
    def cancel_operation(attempt_id: str, request_id: str, body: RevisionInput, request: Request):
        if not re.fullmatch(r"[A-Za-z0-9_-]{8,100}", request_id):
            problem("invalid_request_id", "Invalid request ID.", 422)
        with database.transaction() as connection:
            sid = session_id(request, connection)
            attempt = owned_attempt(connection, sid, attempt_id)
            require_lesson(connection, attempt)
            row = connection.execute("SELECT * FROM lesson_requests WHERE attempt_id=? AND request_id=?", (attempt_id, request_id)).fetchone()
            if row:
                return saved_response(connection, attempt, row)
            if attempt["revision"] != body.expected_revision:
                problem("stale_revision", "The question changed. Refresh its state.", attempt=public_attempt(connection, attempt))
            response = {"request_id": request_id, "status": "cancelled", "attempt": public_attempt(connection, attempt)}
            connection.execute("INSERT INTO lesson_requests VALUES (?,?,?,?,?,?,?)", (attempt_id, request_id, "cancelled-before-arrival", "cancelled", "{}", encode(response), now()))
            database.event(connection, sid, attempt_id, identifier(), "lesson_request_cancelled", {"request_id": request_id}, now())
            return response

    @app.get("/api/attempts/{attempt_id}/introduction/audio")
    def introduction_audio(attempt_id: str, request: Request):
        with database.transaction() as connection:
            sid = session_id(request, connection)
            attempt = owned_attempt(connection, sid, attempt_id)
            require_lesson(connection, attempt)
            if attempt["station_id"] != "candy":
                problem("introduction_not_found", "This station has no listening introduction.", 404)
            # Only serve a local, version/text/hash-matched complete recording.
            # Neither the file name nor the target text is sent in headers.
            try:
                pack = json.loads((root / "content" / "batch-bc.json").read_text())
                manifest = json.loads((root / "content" / "audio-review-bc.json").read_text())
                text_id = f"BC-CND-INTRO-{attempt['_lesson_target'].upper()}"
                entry = next(e for e in pack["entries"] if e["id"] == text_id)
                clip = next(c for c in manifest["clips"] if c["textId"] == text_id and c["speed"] == "normal")
                if (pack["contentVersion"] != lessons.CONTENT_VERSION or manifest["version"] != lessons.CONTENT_VERSION
                        or clip["textVersion"] != entry["version"] or clip["text"] != entry["hanzi"]
                        or clip["textSha256"] != hashlib.sha256(entry["hanzi"].encode()).hexdigest()
                        or clip["pronunciation"] != entry["pronunciation"]
                        or clip["pronunciationVersion"] != entry["version"]
                        or clip.get("status") not in ("generated", "approved")):
                    raise ValueError("Audio identity mismatch")
                public = (root / "frontend" / "public").resolve()
                path = (public / clip["file"].lstrip("/")).resolve()
                if not path.is_relative_to(public) or path.suffix != ".wav":
                    raise ValueError("Invalid audio path")
                audio = path.read_bytes()
                if hashlib.sha256(audio).hexdigest() != clip["sha256"]:
                    raise ValueError("Audio hash mismatch")
            except (OSError, ValueError, KeyError, StopIteration, TypeError):
                problem("introduction_audio_unavailable", "The introduction audio is unavailable. Open its text to continue.", 503)
            attempt["_introduction_served"] = True
            database.save_attempt(connection, attempt)
            return Response(audio, media_type="audio/wav")
