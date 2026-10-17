from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import secrets
import sqlite3
from dataclasses import asdict, is_dataclass
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from dotenv import load_dotenv

from .interpreter import parse_development
from .models import AttemptInput, EventInput, Interpretation, NewSessionInput, Preferences, PracticeInput, RevisionInput, TurnInput
from .rules import CONTENT_VERSION, LEGACY_CONTENT_VERSION, R1_CONTENT_VERSION, R2_CONTENT_VERSION, RULE_VERSION, apply_interpretation, new_attempt
from .guided import GUIDED_SOURCE, PracticeError, apply_practice, assess
from .semantic import configure_interpreter
from .storage import Database, encode
from . import lessons
from .lesson_api import register as register_lessons

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT.parent / ".env", override=False)
COOKIE = "shanghai_session"


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def identifier() -> str:
    return str(uuid4())


def problem(code: str, message: str, status: int = 409, **extra):
    raise HTTPException(status, {"code": code, "message": message, **extra})


def create_app(database_path: str | None = None, interpreter=None) -> FastAPI:
    app = FastAPI(title="Shanghai learning — Four stations", version="0.2.0")
    app.state.database = Database(database_path or os.environ.get("DATABASE_PATH", str(ROOT / "data" / "app.db")))
    text_mode = os.environ.get("TEXT_INTERPRETER", "development_parser")
    selected_interpreter, interpreter_config_id = configure_interpreter(text_mode)
    app.state.interpreter = interpreter or selected_interpreter
    # Testable failure boundary immediately before the atomic state/event commit.
    app.state.before_commit = None
    database = app.state.database

    @app.middleware("http")
    async def same_origin(request: Request, call_next):
        if request.method not in ("GET", "HEAD", "OPTIONS"):
            origin = request.headers.get("origin")
            permitted = {str(request.base_url).rstrip("/")}
            permitted.update(os.environ.get("ALLOWED_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(","))
            if origin and origin not in permitted:
                return JSONResponse({"detail": {"code": "cross_origin_denied", "message": "Use the application origin."}}, status_code=403)
            if request.headers.get("sec-fetch-site") == "cross-site":
                return JSONResponse({"detail": {"code": "cross_origin_denied", "message": "Cross-site writes are not allowed."}}, status_code=403)
            if request.url.path != "/api/asr" and request.headers.get("content-type", "").split(";")[0] != "application/json":
                return JSONResponse({"detail": {"code": "json_required", "message": "Send JSON."}}, status_code=415)
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    @app.exception_handler(sqlite3.Error)
    async def save_error(_request, _exc):
        return JSONResponse({"detail": {"code": "save_failed", "message": "Progress could not be saved. Retry the same request ID.", "retryable": True}}, status_code=503)

    def session_id(request: Request, connection) -> str:
        token = request.cookies.get(COOKIE)
        if not token:
            problem("session_required", "Start or resume your session first.", 401)
        row = connection.execute("SELECT id FROM sessions WHERE token_hash=?", (hashlib.sha256(token.encode()).hexdigest(),)).fetchone()
        if row is None:
            problem("session_required", "The session is no longer available.", 401)
        return row["id"]

    def owned_attempt(connection, sid: str, attempt_id: str) -> dict:
        row = connection.execute("SELECT data FROM attempts WHERE id=? AND session_id=?", (attempt_id, sid)).fetchone()
        if row is None:
            problem("attempt_not_found", "Attempt not found.", 404)
        attempt = json.loads(row["data"])
        add_bound_versions(connection, attempt)
        return attempt

    def public_attempt(connection, attempt: dict) -> dict:
        result = lessons.public_fields(attempt)
        add_bound_versions(connection, result)
        turns = connection.execute(
            "SELECT request_id,status,payload,interpretation,created_at FROM turns WHERE attempt_id=? ORDER BY created_at, rowid", (attempt["id"],)
        ).fetchall()
        result["turns"] = []
        for row in turns:
            payload = json.loads(row["payload"])
            transcript = None
            if payload.get("asr_request_id"):
                asr_row = connection.execute(
                    "SELECT response FROM asr_requests WHERE request_id=? AND session_id=(SELECT session_id FROM attempts WHERE id=?)",
                    (payload["asr_request_id"], attempt["id"]),
                ).fetchone()
                if asr_row and asr_row["response"]:
                    transcript = json.loads(asr_row["response"]).get("transcript")
            result["turns"].append({
                "request_id": row["request_id"], "status": "pending" if row["status"] in ("processing", "prepared") else row["status"],
                "channel": payload.get("channel"), "text": payload.get("text"), "action": payload.get("action"),
                "asr_request_id": payload.get("asr_request_id"), "asr_transcript": transcript,
                "interpretation": json.loads(row["interpretation"]) if row["interpretation"] else None,
                "created_at": row["created_at"],
            })
        return result

    def add_bound_versions(connection, attempt: dict):
        # Older persisted attempts predate these explicit fields. Read their
        # owning session's binding; never label them with today's content.
        if "content_version" not in attempt or "rule_version" not in attempt:
            row = connection.execute("SELECT s.data FROM sessions s JOIN attempts a ON a.session_id=s.id WHERE a.id=?", (attempt["id"],)).fetchone()
            bound = json.loads(row["data"])
            attempt.setdefault("content_version", bound["content_version"])
            attempt.setdefault("rule_version", bound["rule_version"])

    def services() -> dict:
        try:
            from .providers import ProviderConfig
            config = ProviderConfig.from_env("asr")
            public = config.public_dict()
            enabled = bool(config.live_enabled and config.api_key)
            return {"asr": {**public, "enabled": enabled, "formats": ["audio/wav"]},
                    "text": {"mode": text_mode, "config_id": interpreter_config_id,
                             "label": "Limited development parser; not an LLM" if text_mode == "development_parser" else "Configured Qwen interpretation provider"}}
        except ImportError:
            return {"asr": {"enabled": False, "formats": ["audio/wav"]},
                    "text": {"mode": "development_parser", "label": "Limited development parser; not an LLM"}}

    def public_session(connection, sid: str) -> dict:
        row = connection.execute("SELECT data FROM sessions WHERE id=?", (sid,)).fetchone()
        result = json.loads(row["data"])
        result["attempts"] = [public_attempt(connection, json.loads(x["data"])) for x in connection.execute("SELECT data FROM attempts WHERE session_id=? ORDER BY rowid", (sid,))]
        result["completed_station_ids"] = sorted({a["station_id"] for a in result["attempts"] if a["status"] == "completed"})
        result["services"] = {"text": text_mode, "asr": "configured" if services()["asr"]["enabled"] else "unconfigured"}
        return result

    @app.get("/api/health")
    def health():
        return {"status": "ok", "mode": "development", "rule_version": RULE_VERSION}

    @app.get("/api/services")
    def get_services():
        return services()

    def create_session(connection, preferences: dict | None = None, reason: str = "initial") -> tuple[str, str]:
        token, sid = secrets.token_urlsafe(32), identifier()
        session = {"id": sid, "locale": "zh", "show_romanization": True, "reduced_motion": False,
                   "mode": "development", "content_version": CONTENT_VERSION, "rule_version": RULE_VERSION,
                   "model_config_id": interpreter_config_id, "asr_config_id": services()["asr"].get("config_id"), "created_at": now()}
        if preferences:
            for field in ("locale", "show_romanization", "reduced_motion"):
                session[field] = preferences[field]
        connection.execute("INSERT INTO sessions VALUES (?,?,?)", (sid, hashlib.sha256(token.encode()).hexdigest(), encode(session)))
        database.event(connection, sid, None, identifier(), "session_started", {"mode": "development", "creation_reason": reason}, now())
        return sid, token

    def set_session_cookie(response: Response, token: str):
        response.set_cookie(COOKIE, token, max_age=60 * 60 * 24 * 30, httponly=True,
                            secure=os.environ.get("COOKIE_SECURE", "false").lower() == "true",
                            samesite="strict", path="/")

    @app.get("/api/session")
    def get_session(request: Request, response: Response):
        with database.transaction() as connection:
            token = request.cookies.get(COOKIE)
            digest = hashlib.sha256(token.encode()).hexdigest() if token else None
            row = connection.execute("SELECT id FROM sessions WHERE token_hash=?", (digest,)).fetchone() if digest else None
            if row:
                sid = row["id"]
            else:
                sid, token = create_session(connection)
            set_session_cookie(response, token)
            return public_session(connection, sid)

    @app.post("/api/session/new")
    def new_session(_body: NewSessionInput, request: Request, response: Response):
        with database.transaction() as connection:
            previous_id = session_id(request, connection)
            previous = json.loads(connection.execute("SELECT data FROM sessions WHERE id=?", (previous_id,)).fetchone()["data"])
            sid, token = create_session(connection, preferences=previous, reason="explicit_new_session")
            set_session_cookie(response, token)
            return public_session(connection, sid)

    @app.patch("/api/session")
    def update_session(body: Preferences, request: Request):
        with database.transaction() as connection:
            sid = session_id(request, connection)
            row = connection.execute("SELECT data FROM sessions WHERE id=?", (sid,)).fetchone()
            session = json.loads(row["data"])
            updates = body.model_dump(exclude_unset=True, exclude_none=True)
            session.update(updates)
            connection.execute("UPDATE sessions SET data=? WHERE id=?", (encode(session), sid))
            database.event(connection, sid, None, identifier(), "preferences_changed", updates, now())
            return public_session(connection, sid)

    @app.get("/api/content")
    def get_content(request: Request):
        with database.transaction() as connection:
            sid = session_id(request, connection)
            bound = json.loads(connection.execute("SELECT data FROM sessions WHERE id=?", (sid,)).fetchone()["data"])
        content_paths = {
            CONTENT_VERSION: ROOT.parent / "content" / "batch-a.json",
            R1_CONTENT_VERSION: ROOT.parent / "content" / "versions" / f"{R1_CONTENT_VERSION}.json",
            R2_CONTENT_VERSION: ROOT.parent / "content" / "versions" / f"{R2_CONTENT_VERSION}.json",
            LEGACY_CONTENT_VERSION: ROOT.parent / "content" / "versions" / f"{LEGACY_CONTENT_VERSION}.json",
        }
        version = bound["content_version"]
        path = content_paths.get(version)
        if path is None or not path.exists():
            problem("content_version_unavailable", "The session's content version is unavailable.", 503)
        content = json.loads(path.read_text())
        if content.get("contentVersion") != version:
            problem("content_version_unavailable", "The session's content version is unavailable.", 503)
        return content

    @app.post("/api/attempts")
    def start_attempt(body: AttemptInput, request: Request):
        with database.transaction() as connection:
            sid = session_id(request, connection)
            attempts = [json.loads(r["data"]) for r in connection.execute("SELECT data FROM attempts WHERE session_id=? ORDER BY rowid DESC", (sid,))]
            active = next((a for a in attempts if a["station_id"] == body.station_id and a["status"] in ("collecting", "confirming")), None)
            if active is not None:
                # Re-entering an unfinished practice always resumes it; avoids
                # accidental double attempts from a retried restart click.
                return public_attempt(connection, active)
            if not body.restart:
                latest = next((a for a in attempts if a["station_id"] == body.station_id), None)
                if latest and latest["status"] == "completed":
                    return public_attempt(connection, latest)
            bound = json.loads(connection.execute("SELECT data FROM sessions WHERE id=?", (sid,)).fetchone()["data"])
            if body.station_id == "nanxiang":
                attempt = new_attempt(identifier(), now(), content_version=bound["content_version"], rule_version=bound["rule_version"])
            else:
                if bound["rule_version"] != RULE_VERSION or bound["content_version"] != CONTENT_VERSION:
                    problem("lesson_version_required", "Start a new journey to use the new station lessons.")
                if (bound.get("lesson_content_version", lessons.CONTENT_VERSION) != lessons.CONTENT_VERSION
                        or bound.get("lesson_rule_version", lessons.RULE_VERSION) != lessons.RULE_VERSION):
                    problem("lesson_version_required", "This session uses an earlier station lesson package.")
                bound.update(lesson_content_version=lessons.CONTENT_VERSION, lesson_rule_version=lessons.RULE_VERSION)
                connection.execute("UPDATE sessions SET data=? WHERE id=?", (encode(bound), sid))
                attempt = lessons.new_attempt(identifier(), now(), body.station_id)
            connection.execute("INSERT INTO attempts VALUES (?,?,?)", (attempt["id"], sid, encode(attempt)))
            database.event(connection, sid, attempt["id"], identifier(), "attempt_started", {}, now())
            return public_attempt(connection, attempt)

    @app.get("/api/attempts/{attempt_id}")
    def get_attempt(attempt_id: str, request: Request):
        with database.transaction() as connection:
            return public_attempt(connection, owned_attempt(connection, session_id(request, connection), attempt_id))

    def require_guided(connection, attempt):
        if attempt["rule_version"] != RULE_VERSION or "practice" not in attempt:
            problem("practice_version_required", "This session uses the earlier conversation flow.",
                    attempt=public_attempt(connection, attempt))

    def saved_practice_response(connection, attempt, row):
        if row["status"] == "cancelled":
            return {"request_id": row["request_id"], "status": "cancelled", "attempt": public_attempt(connection, attempt)}
        return json.loads(row["response"])

    @app.post("/api/attempts/{attempt_id}/practice")
    def practice_operation(attempt_id: str, body: PracticeInput, request: Request):
        payload = encode(body.model_dump(exclude_unset=True))
        fingerprint = hashlib.sha256(payload.encode()).hexdigest()
        with database.transaction() as connection:
            sid = session_id(request, connection)
            attempt = owned_attempt(connection, sid, attempt_id)
            require_guided(connection, attempt)
            previous = connection.execute("SELECT * FROM practice_requests WHERE attempt_id=? AND request_id=?", (attempt_id, body.request_id)).fetchone()
            if previous:
                if previous["status"] != "cancelled" and previous["fingerprint"] != fingerprint:
                    problem("idempotency_conflict", "This request ID was already used for different input.", attempt=public_attempt(connection, attempt))
                return saved_practice_response(connection, attempt, previous)
            if attempt["status"] in ("completed", "skipped"):
                problem("attempt_closed", "This attempt has ended. Start a new practice.", attempt=public_attempt(connection, attempt))
            if attempt["revision"] != body.expected_revision:
                problem("stale_revision", "The question changed. Review the current question.", attempt=public_attempt(connection, attempt))
            evaluation = None
            if body.operation == "evaluate":
                transcript, status, reason, reported_by = None, None, None, "client"
                if body.asr_request_id:
                    used = connection.execute("SELECT request_id FROM practice_asr_uses WHERE session_id=? AND asr_request_id=?", (sid, body.asr_request_id)).fetchone()
                    if used:
                        problem("asr_result_already_used", "This transcription has already been evaluated. Record a new reply.", attempt=public_attempt(connection, attempt))
                    row = connection.execute("SELECT response FROM asr_requests WHERE session_id=? AND request_id=?", (sid, body.asr_request_id)).fetchone()
                    if row is None or not row["response"]:
                        if body.failure_kind != "technical":
                            problem("asr_result_required", "Use a finished transcription from your own session.", 422)
                        # A browser timeout or lost request is itself a real
                        # technical failure, even when the provider outcome is
                        # unknown. Persist this empty state; late ASR cannot
                        # override it or silently progress the question.
                        saved = {}
                        status, reason = "technical", "device_or_service_unavailable"
                    else:
                        saved = json.loads(row["response"])
                        reported_by = "server"
                    if "transcript" in saved:
                        transcript = saved["transcript"]
                        # The server may have finished after the browser lost
                        # the response. Reconcile from that saved original.
                        if body.failure_kind != "technical" and (body.failure_kind is not None or body.text != transcript):
                            problem("original_transcript_required", "Keep the original saved transcription unchanged.", 422)
                    elif "error" in saved:
                        if body.failure_kind is None:
                            problem("asr_result_required", "This recording did not return a transcript.", 422)
                        if saved["error"]["code"] == "no_speech":
                            status, reason = "unrecognized", "no_speech"
                        else:
                            status, reason = "technical", "asr_failed"
                    elif status is None:
                        problem("asr_result_required", "This recording did not return a usable result.", 422)
                elif body.failure_kind == "recognition":
                    status, reason = "unrecognized", "no_speech"
                else:
                    status, reason = "technical", "device_or_service_unavailable"
                if attempt["practice"]["target"] is None:
                    problem("practice_target_required", "Select what you want to say first.", attempt=public_attempt(connection, attempt))
                if transcript is not None:
                    status, reason = assess(transcript, attempt["practice"])
                evaluation = {"request_id": body.request_id, "transcript": transcript, "status": status,
                              "reason": reason, "channel": "technical" if status == "technical" else "voice",
                              "reported_by": reported_by, "asr_request_id": body.asr_request_id,
                              "interpretation_source": GUIDED_SOURCE if transcript is not None else None}
            try:
                result, events = apply_practice(attempt, body, evaluation)
            except PracticeError as exc:
                problem(exc.code, exc.message, attempt=public_attempt(connection, attempt))
            result["updated_at"] = now()
            if app.state.before_commit:
                app.state.before_commit()
            database.save_attempt(connection, result)
            if body.operation == "evaluate" and body.asr_request_id:
                connection.execute("INSERT INTO practice_asr_uses VALUES (?,?,?,?)", (sid, body.asr_request_id, attempt_id, body.request_id))
            for event in events:
                metadata = {"request_id": body.request_id, "revision": result["revision"],
                            "previous_revision": attempt["revision"], "step_id": attempt["practice"]["step_id"],
                            "step": attempt["practice"]["step"], "target": result["practice"]["target"] if body.operation == "select" else attempt["practice"]["target"],
                            "assisted": body.assisted, "result": evaluation if evaluation is not None else attempt["practice"]["result"]}
                if event in ("fields_updated", "confirmation_shown", "confirmation_accepted", "task_completed"):
                    metadata.update(order=result["order"], summary_revision=result["summary_revision"], confirmed_revision=result["confirmed_revision"])
                if event == "task_completed":
                    metadata["metrics"] = result["metrics"]
                database.event(connection, sid, attempt_id, identifier(), event, metadata, now())
            response = {"request_id": body.request_id, "status": "applied", "attempt": public_attempt(connection, result)}
            connection.execute("INSERT INTO practice_requests VALUES (?,?,?,?,?,?,?)", (attempt_id, body.request_id, fingerprint, "applied", payload, encode(response), now()))
            return response

    @app.get("/api/attempts/{attempt_id}/practice/{request_id}")
    def get_practice_operation(attempt_id: str, request_id: str, request: Request):
        with database.transaction() as connection:
            attempt = owned_attempt(connection, session_id(request, connection), attempt_id)
            require_guided(connection, attempt)
            row = connection.execute("SELECT * FROM practice_requests WHERE attempt_id=? AND request_id=?", (attempt_id, request_id)).fetchone()
            if row is None:
                problem("practice_request_not_found", "No saved practice operation has this ID.", 404)
            return saved_practice_response(connection, attempt, row)

    @app.post("/api/attempts/{attempt_id}/practice/{request_id}/cancel")
    def cancel_practice_operation(attempt_id: str, request_id: str, body: RevisionInput, request: Request):
        if not re.fullmatch(r"[A-Za-z0-9_-]{8,100}", request_id):
            problem("invalid_request_id", "Invalid request ID.", 422)
        with database.transaction() as connection:
            sid = session_id(request, connection)
            attempt = owned_attempt(connection, sid, attempt_id)
            require_guided(connection, attempt)
            row = connection.execute("SELECT * FROM practice_requests WHERE attempt_id=? AND request_id=?", (attempt_id, request_id)).fetchone()
            if row:
                return saved_practice_response(connection, attempt, row)
            if attempt["revision"] != body.expected_revision:
                problem("stale_revision", "The question changed. Refresh its state.", attempt=public_attempt(connection, attempt))
            response = {"request_id": request_id, "status": "cancelled", "attempt": public_attempt(connection, attempt)}
            connection.execute("INSERT INTO practice_requests VALUES (?,?,?,?,?,?,?)", (attempt_id, request_id, "cancelled-before-arrival", "cancelled", "{}", encode(response), now()))
            database.event(connection, sid, attempt_id, identifier(), "practice_request_cancelled", {"request_id": request_id}, now())
            return response

    def turn_response(connection, attempt: dict, row) -> dict:
        if row["response"]:
            result = json.loads(row["response"])
            add_bound_versions(connection, result["attempt"])
            return result
        return {"request_id": row["request_id"], "status": "pending" if row["status"] in ("processing", "prepared") else row["status"],
                "attempt": public_attempt(connection, attempt), "interpretation_source": None}

    def finalize(sid: str, attempt_id: str, request_id: str) -> dict:
        with database.transaction() as connection:
            attempt = owned_attempt(connection, sid, attempt_id)
            row = connection.execute("SELECT * FROM turns WHERE attempt_id=? AND request_id=?", (attempt_id, request_id)).fetchone()
            if row["status"] != "prepared":
                return turn_response(connection, attempt, row)
            body = TurnInput.model_validate_json(row["payload"])
            if (attempt["pending_request_id"] != request_id or attempt["revision"] != body.expected_revision
                    or attempt["status"] in ("completed", "skipped")):
                connection.execute("UPDATE turns SET status='cancelled' WHERE attempt_id=? AND request_id=?", (attempt_id, request_id))
                if attempt["pending_request_id"] == request_id:
                    attempt["pending_request_id"] = None
                    database.save_attempt(connection, attempt)
                return {"request_id": request_id, "status": "cancelled", "attempt": public_attempt(connection, attempt), "interpretation_source": None}
            parsed = Interpretation.model_validate_json(row["interpretation"])
            result, events = apply_interpretation(attempt, parsed, body.summary_revision)
            result["pending_request_id"] = None
            result["updated_at"] = now()
            if app.state.before_commit:
                app.state.before_commit()
            database.save_attempt(connection, result)
            connection.execute("UPDATE turns SET status='applied' WHERE attempt_id=? AND request_id=?", (attempt_id, request_id))
            for event in events:
                metadata = {"request_id": request_id, "revision": result["revision"],
                            "previous_revision": attempt["revision"], "channel": body.channel,
                            "interpretation_source": parsed.source}
                if event in ("fields_updated", "validation_rejected", "correction_received"):
                    metadata.update(before=attempt["order"], after=result["order"],
                                    unresolved_issues=result["unresolved_issues"], evidence=parsed.evidence)
                if event in ("confirmation_shown", "confirmation_accepted", "task_completed"):
                    metadata.update(order=result["order"], summary_revision=result["summary_revision"],
                                    confirmed_revision=result["confirmed_revision"])
                if event == "task_completed":
                    metadata["metrics"] = result["metrics"]
                database.event(connection, sid, attempt_id, identifier(), event, metadata, now())
            response = {"request_id": request_id, "status": "applied", "attempt": public_attempt(connection, result), "interpretation_source": parsed.source}
            if body.channel == "voice":
                # This describes text understanding, never acoustic accuracy or
                # pronunciation. A clear denial / correction is still understood.
                if parsed.intent == "repeat" and not parsed.changes and not parsed.uncertainties:
                    feedback = {"outcome": "accepted", "reason": "repeat_requested"}
                elif parsed.uncertainties or result["unresolved_issues"]:
                    feedback = {"outcome": "retry", "reason": "needs_clarification"}
                elif parsed.intent == "unknown" or "interpretation_unrecognized" in events:
                    feedback = {"outcome": "retry", "reason": "unrecognized"}
                elif "confirmation_rejected" in events:
                    feedback = {"outcome": "accepted", "reason": "confirmation_required"}
                else:
                    feedback = {"outcome": "accepted", "reason": "understood"}
                response["speech_feedback"] = feedback
            connection.execute("UPDATE turns SET response=? WHERE attempt_id=? AND request_id=?", (encode(response), attempt_id, request_id))
            return response

    @app.post("/api/attempts/{attempt_id}/turns")
    def submit_turn(attempt_id: str, body: TurnInput, request: Request):
        payload = encode(body.model_dump(exclude_unset=True))
        fingerprint = hashlib.sha256(payload.encode()).hexdigest()
        prepare = False
        with database.transaction() as connection:
            sid = session_id(request, connection)
            attempt = owned_attempt(connection, sid, attempt_id)
            if attempt["rule_version"] == RULE_VERSION or "lesson" in attempt:
                problem("guided_practice_required", "Use the guided practice flow for this session.", attempt=public_attempt(connection, attempt))
            previous = connection.execute("SELECT * FROM turns WHERE attempt_id=? AND request_id=?", (attempt_id, body.request_id)).fetchone()
            if previous:
                # A cancellation tombstone applies even when POST arrived later.
                if previous["status"] == "cancelled":
                    return turn_response(connection, attempt, previous)
                if previous["fingerprint"] != fingerprint:
                    problem("idempotency_conflict", "This request ID was already used for different input.", attempt=public_attempt(connection, attempt))
                if previous["status"] != "prepared":
                    return turn_response(connection, attempt, previous)
            else:
                if body.channel in ("voice", "voice_edited"):
                    asr_row = connection.execute("SELECT response FROM asr_requests WHERE session_id=? AND request_id=?", (sid, body.asr_request_id)).fetchone()
                    if not asr_row or not asr_row["response"] or "transcript" not in json.loads(asr_row["response"]):
                        problem("asr_result_required", "Use a successful transcription from your own session.", 422)
                    transcript = json.loads(asr_row["response"])["transcript"]
                    if body.channel == "voice" and body.text != transcript:
                        problem("edited_transcript_channel_required", "Mark edited transcription as voice_edited.", 422)
                if body.channel != "buttons":
                    session = json.loads(connection.execute("SELECT data FROM sessions WHERE id=?", (sid,)).fetchone()["data"])
                    if session["model_config_id"] != interpreter_config_id:
                        problem("configuration_changed", "This session uses another interpretation configuration. Use choices or start a fresh session.", 409)
                if attempt["status"] in ("completed", "skipped"):
                    problem("attempt_closed", "This attempt has ended. Start a new practice.", attempt=public_attempt(connection, attempt))
                if body.expected_revision != attempt["revision"]:
                    problem("stale_revision", "The order changed. Review the current order.", attempt=public_attempt(connection, attempt))
                if body.summary_revision is not None and body.summary_revision != attempt["summary_revision"]:
                    problem("stale_summary", "Review the current confirmation before confirming.", attempt=public_attempt(connection, attempt))
                if attempt["pending_request_id"]:
                    problem("turn_pending", "One response is already being processed.", attempt=public_attempt(connection, attempt))
                connection.execute("INSERT INTO turns VALUES (?,?,?,?,?,?,?,?)", (attempt_id, body.request_id, fingerprint, "processing", payload, None, None, now()))
                attempt["pending_request_id"] = body.request_id
                database.save_attempt(connection, attempt)
                database.event(connection, sid, attempt_id, identifier(), "input_submitted", {"request_id": body.request_id, "channel": body.channel}, now())
                prepare = True
        if prepare:
            try:
                if body.channel == "buttons":
                    action = body.action
                    parsed = Interpretation(intent={"set_order": "provide", "confirm": "confirm", "repeat": "repeat"}[action.type],
                                            changes=action.model_dump(exclude_unset=True, exclude={"type"}), source="structured_buttons")
                else:
                    parsed = app.state.interpreter(body.text, attempt)
                    if asyncio.iscoroutine(parsed):
                        parsed = asyncio.run(parsed)
                    if not isinstance(parsed, Interpretation):
                        parsed = Interpretation.model_validate(asdict(parsed) if is_dataclass(parsed) else parsed)
                with database.transaction() as connection:
                    # Cancellation may have arrived while interpretation was running.
                    connection.execute("UPDATE turns SET interpretation=?,status='prepared' WHERE attempt_id=? AND request_id=? AND status='processing'", (parsed.model_dump_json(), attempt_id, body.request_id))
            except Exception:
                with database.transaction() as connection:
                    current = owned_attempt(connection, sid, attempt_id)
                    if current["pending_request_id"] == body.request_id:
                        current["pending_request_id"] = None
                        database.save_attempt(connection, current)
                    connection.execute("UPDATE turns SET status='failed' WHERE attempt_id=? AND request_id=? AND status='processing'", (attempt_id, body.request_id))
                problem("interpretation_failed", "The reply could not be interpreted. Try again with a new request ID or use choices.", 503, retryable=True, terminal=True)
        return finalize(sid, attempt_id, body.request_id)

    @app.get("/api/attempts/{attempt_id}/turns/{request_id}")
    def get_turn(attempt_id: str, request_id: str, request: Request):
        with database.transaction() as connection:
            attempt = owned_attempt(connection, session_id(request, connection), attempt_id)
            row = connection.execute("SELECT * FROM turns WHERE attempt_id=? AND request_id=?", (attempt_id, request_id)).fetchone()
            if row is None:
                problem("turn_not_found", "No submitted response has this ID.", 404)
            return turn_response(connection, attempt, row)

    @app.post("/api/attempts/{attempt_id}/turns/{request_id}/cancel")
    def cancel_turn(attempt_id: str, request_id: str, body: RevisionInput, request: Request):
        if not re.fullmatch(r"[A-Za-z0-9_-]{8,100}", request_id):
            problem("invalid_request_id", "Invalid request ID.", 422)
        with database.transaction() as connection:
            sid = session_id(request, connection)
            attempt = owned_attempt(connection, sid, attempt_id)
            row = connection.execute("SELECT * FROM turns WHERE attempt_id=? AND request_id=?", (attempt_id, request_id)).fetchone()
            if row and row["status"] in ("applied", "cancelled", "failed"):
                return turn_response(connection, attempt, row)
            if body.expected_revision != attempt["revision"]:
                problem("stale_revision", "The order changed. Refresh its state.", attempt=public_attempt(connection, attempt))
            if row:
                connection.execute("UPDATE turns SET status='cancelled' WHERE attempt_id=? AND request_id=?", (attempt_id, request_id))
            else:
                connection.execute("INSERT INTO turns VALUES (?,?,?,?,?,?,?,?)", (attempt_id, request_id, "cancelled-before-arrival", "cancelled", "{}", None, None, now()))
            if attempt["pending_request_id"] == request_id:
                attempt["pending_request_id"] = None
                database.save_attempt(connection, attempt)
            database.event(connection, sid, attempt_id, identifier(), "request_cancelled", {"request_id": request_id}, now())
            return {"request_id": request_id, "status": "cancelled", "attempt": public_attempt(connection, attempt), "interpretation_source": None}

    @app.post("/api/attempts/{attempt_id}/skip")
    def skip_attempt(attempt_id: str, body: RevisionInput, request: Request):
        with database.transaction() as connection:
            sid = session_id(request, connection)
            attempt = owned_attempt(connection, sid, attempt_id)
            if attempt["status"] == "skipped":
                return public_attempt(connection, attempt)
            if attempt["status"] == "completed":
                problem("attempt_completed", "A saved success cannot be skipped.", attempt=public_attempt(connection, attempt))
            if attempt["revision"] != body.expected_revision:
                problem("stale_revision", "The order changed. Refresh its state.", attempt=public_attempt(connection, attempt))
            if attempt["pending_request_id"]:
                connection.execute("UPDATE turns SET status='cancelled' WHERE attempt_id=? AND request_id=?", (attempt_id, attempt["pending_request_id"]))
            attempt.update(status="skipped", pending_request_id=None, revision=attempt["revision"] + 1, summary_revision=None, updated_at=now())
            database.save_attempt(connection, attempt)
            database.event(connection, sid, attempt_id, identifier(), "task_skipped", {}, now())
            return public_attempt(connection, attempt)

    @app.post("/api/events")
    def add_event(body: EventInput, request: Request):
        if len(encode(body.metadata).encode()) > 2048:
            problem("event_too_large", "Event metadata is too large.", 422)
        # Client diagnostics describe the UI. They are never evidence that the
        # ASR service succeeded, that an order advanced, or that speech was learned.
        metadata = {**body.metadata, "reported_by": "client"}
        with database.transaction() as connection:
            sid = session_id(request, connection)
            attempt = owned_attempt(connection, sid, body.attempt_id) if body.attempt_id else None
            previous = connection.execute("SELECT * FROM events WHERE session_id=? AND event_id=?", (sid, body.event_id)).fetchone()
            if previous:
                if (previous["attempt_id"] != body.attempt_id or previous["event_type"] != body.event_type or previous["metadata"] != encode(metadata)):
                    problem("event_id_conflict", "This event ID was already used.")
                return {"event_id": body.event_id, "saved": True, "duplicate": True}
            database.event(connection, sid, body.attempt_id, body.event_id, body.event_type, metadata, now())
            if attempt:
                if body.event_type == "recording_started":
                    attempt["metrics"]["voice_attempts"] += 1
                if body.event_type in ("expression_opened", "unit_explanation_viewed", "assistance_recorded", "pronunciation_support_changed"):
                    attempt["metrics"]["help_used"] += 1
                if body.event_type == "unit_explanation_viewed":
                    attempt["unit_convention_seen"] = True
                database.save_attempt(connection, attempt)
            return {"event_id": body.event_id, "saved": True, "duplicate": False}

    @app.get("/api/events")
    def get_events(request: Request):
        with database.transaction() as connection:
            sid = session_id(request, connection)
            return [{**dict(row), "metadata": json.loads(row["metadata"])} for row in connection.execute("SELECT event_id,attempt_id,event_type,metadata,created_at FROM events WHERE session_id=? ORDER BY rowid", (sid,))]

    @app.post("/api/asr")
    async def asr(request: Request):
        from .providers import ASRRequest, ProviderConfig, ProviderError, QwenASR
        with database.transaction() as connection:
            sid = session_id(request, connection)
            bound_session = json.loads(connection.execute("SELECT data FROM sessions WHERE id=?", (sid,)).fetchone()["data"])
        config = ProviderConfig.from_env("asr")
        if bound_session.get("asr_config_id") not in (None, config.config_id):
            problem("configuration_changed", "This session uses another ASR configuration. Start a fresh session or use text.", 409)
        audio = bytearray()
        async for part in request.stream():
            audio.extend(part)
            if len(audio) > 3 * 1024 * 1024:
                problem("audio_too_large", "Audio must be no larger than 3 MiB.", 413, retryable=False)
        request_id = request.headers.get("x-request-id", identifier())
        if not re.fullmatch(r"[A-Za-z0-9_-]{8,100}", request_id):
            problem("invalid_request_id", "Invalid request ID.", 422)
        content_type = request.headers.get("content-type", "").split(";")[0]
        fingerprint = hashlib.sha256(content_type.encode() + bytes(audio)).hexdigest()
        with database.transaction() as connection:
            row = connection.execute("SELECT * FROM asr_requests WHERE session_id=? AND request_id=?", (sid, request_id)).fetchone()
            if row:
                if row["fingerprint"] != fingerprint:
                    problem("idempotency_conflict", "This request ID was already used for another recording.")
                if row["response"]:
                    saved = json.loads(row["response"])
                    if "error" in saved:
                        problem(**saved["error"])
                    return saved
                elapsed = (datetime.now(timezone.utc) - datetime.fromisoformat(row["created_at"])).total_seconds()
                if elapsed > 30:
                    # Never re-submit an unknown cloud request automatically.
                    # The next user-initiated retry may use a fresh request ID.
                    problem("asr_interrupted", "The previous transcription was interrupted. You can submit again.", 503,
                            retryable=True, terminal=True)
                problem("asr_pending", "This recording is already being transcribed.")
            recent = connection.execute("SELECT created_at FROM asr_requests WHERE session_id=? ORDER BY created_at DESC LIMIT 30", (sid,)).fetchall()
            if len(recent) >= 30 and (datetime.now(timezone.utc) - datetime.fromisoformat(recent[-1]["created_at"])).total_seconds() < 60:
                problem("rate_limited", "Please wait a moment before transcribing again.", 429, retryable=True)
            connection.execute("INSERT INTO asr_requests VALUES (?,?,?,?,?)", (sid, request_id, fingerprint, None, now()))
        try:
            result = await QwenASR(config).transcribe(ASRRequest(audio=bytes(audio), request_id=request_id, mime_type=content_type))
            result = asdict(result) if is_dataclass(result) else result.model_dump()
            result["text"] = result["transcript"]
            result["request_id"] = request_id
        except ProviderError as exc:
            result = {"error": {"code": exc.code, "message": str(exc), "status": 503, "retryable": exc.retryable, "terminal": True}}
        finally:
            audio.clear()  # No raw audio is persisted by this endpoint.
        with database.transaction() as connection:
            connection.execute("UPDATE asr_requests SET response=? WHERE session_id=? AND request_id=?", (encode(result), sid, request_id))
            database.event(connection, sid, None, identifier(), "asr_finished", {
                "reported_by": "server", "request_id": request_id,
                "status": "failed" if "error" in result else result["status"],
                "config_id": config.config_id, "error_code": result.get("error", {}).get("code"),
                "elapsed_ms": result.get("elapsed_ms"), "model": result.get("model"),
            }, now())
        if "error" in result:
            problem(**result["error"])
        return result

    register_lessons(app, database, session_id=session_id, owned_attempt=owned_attempt,
                     public_attempt=public_attempt, problem=problem, now=now,
                     identifier=identifier, root=ROOT.parent)
    return app


app = create_app()
