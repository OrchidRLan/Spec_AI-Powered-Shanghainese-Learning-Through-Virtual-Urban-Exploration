# Four-Station API (Accounts, Temporary Guests, and Production Configuration)

Python 3.11+, FastAPI + SQLite. In development the database lives on the local machine; in production it must be placed on the backend's persistent disk. Having the configuration implemented does not mean deployment or acceptance has actually been completed.

```sh
cd backend
python3.11 -m venv .venv
.venv/bin/python -m pip install -r requirements.lock
.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
# Run the root frontend in another terminal; /api goes through the Vite same-origin proxy.
.venv/bin/python -m pytest
```

The default database is `backend/data/app.db`; it can be moved to a separate directory via `DATABASE_PATH`. The backend automatically loads the root `.env` without overriding environment variables already set in the process; restart the backend after changing configuration. The database, recordings, logs, and virtual environment are not committed. The cookie is a random 256-bit token (the database stores only its hash), `HttpOnly; SameSite=Strict`; production additionally requires `Secure`. The returned session ID is not an access credential. Write requests check Origin / Fetch Metadata and require JSON (except ASR). ASR already has a per-session limit of 30 requests per minute.

## Production Runtime Boundaries

| Environment variable | Development default | Production requirement |
| --- | --- | --- |
| `APP_ENV` | `development` | `production`; any other value fails at startup |
| `DATABASE_PATH` | `backend/data/app.db` | Explicit absolute path; the deployment configuration is responsible for mounting the persistent disk, e.g. `/var/data/app.db` |
| `COOKIE_SECURE` | `false` | Must be `true` |
| `ALLOWED_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | Explicit HTTPS frontend origins, comma-separated; no paths, credentials, or wildcards. The request Host and preview domains are not automatically allowed |
| `BACKEND_PROXY_SECRET` | Not used | Random secret of at least 32 non-whitespace ASCII characters; configured only in the Vercel proxy function and the Render backend environment |

Vercel serves the frontend with a same-origin `/api`, and a server-side proxy forwards requests to Render. Except for `GET/HEAD /api/health`, the production backend requires `X-Shanghai-Proxy-Secret` to match the configured value in a constant-time comparison, and requires `X-Shanghai-Client-IP` to be a single valid IP. The proxy must overwrite both request headers and take the client IP from Vercel's trusted metadata; it must not forward a browser-reported IP or secret. IPv4-mapped IPv6 addresses are normalized into the same rate-limit bucket. The backend does not rely on `X-Forwarded-For`, and the deployment starts with `--no-proxy-headers`; a missing secret or malformed IP returns `403 proxy_required`. Production write requests must also carry an allowed `Origin`; the browser `Sec-Fetch-Site` check is retained, and the proxy does not forge an Origin that always passes.

`GET/HEAD /api/health` checks the database connection and that tables are accessible, and returns the runtime mode and content/rule versions; if the database is unavailable it returns 503. It does not return data paths, secrets, or account information, and does not call any model service. Production disables `/docs`, `/redoc`, and `/openapi.json`. New sessions and creation events record the actual `production` mode; the mode of existing sessions is not rewritten.

The first deployment uses an empty database, and tables are created by the existing transactional initialization; restarts and upgrades preserve existing accounts and progress. Mount path, backup/restore, guest cleanup, platform quotas, and actual HTTPS checks still need to be carried out according to the deployment plan; configuration validation by itself cannot prove that the disk is persistently mounted.

## Authentication and Temporary Progress

Identity in this round is independent of the existing learning session. Accounts use the `shanghai_account` HttpOnly / SameSite=Strict cookie; both the server token and the browser cookie last at most 30 days. Logout revokes the current token and does not clear account progress. Guests use the `X-Guest-Token` request header, which the frontend stores only in the tab's `sessionStorage`, for at most 24 hours. The database stores only SHA-256 digests of both kinds of random token. Usernames are unique after trim + casefold, and display preserves case; 3–24 ASCII letters, digits, and underscores. The normalized `users.username_key` is the database `NOT NULL PRIMARY KEY` and uses the `NOCASE` collation to prevent case-only duplicates; the original `users.id` is kept as `NOT NULL UNIQUE` and continues to back the foreign keys of tokens and learning sessions. On startup, existing databases migrate the primary key in a transaction, preserving account IDs, password digests, tokens, and progress; if migration fails it rolls back and does not reset data. Passwords are 8–128 characters with no character-class requirements, and spaces are not trimmed; random-salt scrypt `N=32768,r=8,p=3`; no plaintext is stored.

```ts
type AuthState = {
  mode: 'signed_out' | 'guest' | 'account';
  user: {username: string} | null;
  session: Session | null;
  legacy_available: boolean;
};
```

| Endpoint | Request | Response |
| --- | --- | --- |
| GET /api/auth | Optional account cookie / guest header | AuthState; the legacy anonymous cookie does not log in automatically, it only reports legacy_available |
| POST /api/auth/guest | `{locale?: 'zh'|'en'}` | AuthState + guest_token; no long-lived anonymous cookie is issued |
| POST /api/auth/register | `{username,password,locale?,import_legacy?:boolean}`, may include the guest header | Registers and signs in, AuthState; takes over the current guest progress |
| POST /api/auth/login | Same as above | AuthState; restores the account and transactionally merges the current guest progress |
| POST /api/auth/logout | `{}`, with the current X-Expected-Session-ID | Revokes the current token, returns signed_out; account data is preserved |

For the lesson API, identity precedence is explicit guest header → valid account cookie → legacy anonymous cookie. **If an invalid/expired guest header is sent, `guest_expired` is returned; the request must not fall back to an account in the same browser.** The normal welcome screen does not call the legacy anonymous `/session` to restore; only when the user explicitly checks `import_legacy` does login/registration import the legacy cookie data they hold. Legacy anonymous records are not deleted automatically.

After identity is restored, the frontend sends `X-Expected-Session-ID` with all lesson API calls, raw ASR uploads, and private candy-shop audio; its value is the currently displayed Session.id. The server compares it against the session bound to the actual credential; a mismatch returns 401 `session_changed`, which prevents actions from an old page being written to a new account after another tab switches accounts. Login/registration/guest entry and GET /auth are not subject to this binding; logout does compare. For compatibility with the existing API/legacy anonymous clients, requests without this header are still authorized by their actual credential, but the official frontend must not omit it. Private audio must be fetched with the header as a Blob before playback; tokens are not put in URLs.

Merging moves attempts, events, ASR, and usage records within a single SQLite transaction; the lesson version is first pinned onto each attempt. Merging preserves historical successes and all practice records, revokes the source guest/legacy anonymous credential, and leaves account source attribution. A different lesson version or a request ID conflict within a session returns `merge_conflict`, and the original records on both sides remain unchanged; the old version can be linked to the new account separately and then continued via the existing upgrade entry point. Requests still in progress return `merge_in_progress` and can be retried after they complete; unfinished ASR older than 30 seconds is first stored with the terminal state `asr_interrupted`, so that it does not become permanently unsaveable after a process restart. Legacy turns in processing / prepared use the same 30-second threshold: recent requests still block merging, timed-out requests are recorded as cancelled, and only the matching pending_request_id is cleared; the original payload, interpretation, and records are kept, and the order is not applied automatically. The cancelled state prevents a late interpretation from being rewritten to prepared or advancing the order. Late cloud results cannot overwrite a terminal state. Identity is re-verified when the ASR upload completes and when the cloud returns; transcriptions after logout are discarded and do not change practice progress.

Server-side SQLite rate limiting: login 10 per username / 15 minutes and 50 per source IP / 15 minutes; registration 15 per IP / hour; guest creation 50 per IP / 15 minutes. In production the source IP is taken only from the proxy header described above that passed secret validation; development mode uses the direct connection address and ignores self-reported proxy headers. A nonexistent account and a wrong password both return `invalid_credentials`. Other common errors include `invalid_username` / `invalid_password` (422), `username_taken` (409), `auth_rate_limited` (429), `legacy_unavailable` (409), and `session_required` / `guest_expired` / `session_changed` (401).

Each API request lazily cleans up expired guests and all their associated attempts, requests, events, and ASR data; legacy anonymous and account records are not cleaned up. When there is no traffic, the following command can be run from the backend directory; include it in scheduled maintenance at deployment:

```sh
.venv/bin/python -m app.cleanup_guests --database /absolute/path/to/app.db
```

The command does not load speech services or read `.env`; with no arguments it uses the process's `DATABASE_PATH` or the default backend/data/app.db. Database initialization only adds auth/attribution tables and does not rewrite existing session data. When an account upgrades a legacy lesson, the account_sessions attribution record is kept; a guest upgrade does not extend the original 24-hour window. Closing the page cannot reliably notify the server, so 24 hours is the upper bound on credential validity; actual data is removed on subsequent API requests or by the cleanup command, and without traffic on-time physical deletion cannot be guaranteed. A browser restoring tabs may restore guest credentials.

## Endpoints

| Endpoint | Request | Response |
| --- | --- | --- |
| GET/HEAD /api/health | None; production allows direct health checks | mode/content_version/rule_version; returns 503 if the database is unavailable |
| GET /api/session | Current identity | Restores Session; returns 401 when there is no identity, and no longer auto-creates an anonymous cookie |
| PATCH /api/session | locale?: zh/en, show_romanization?: bool, reduced_motion?: bool | Session |
| POST /api/session/new | Current identity; JSON `{}` | Creates a Session when explicitly upgrading a legacy lesson; accounts update the current binding, guests keep the original token and expiry time, and only legacy anonymous replaces the cookie; preferences and old records are preserved |
| GET /api/services | None | asr.enabled/formats/config; text.mode=development_parser |
| GET /api/content | Current identity | The current content pack or historical archived pack bound to the session; does not automatically fall back to another version |
| POST /api/attempts | station_id: nanxiang/restaurant/candy/teahouse, restart?: bool | Attempt; resumes if unfinished, and retrying the same request does not create a duplicate. When completed, only restart:true creates a new one |
| GET /api/attempts/{id} | Current identity | Attempt |
| POST /api/attempts/{id}/practice | PracticeInput, R3 only | PracticeResult; saves the current question's selection/evaluation or an explicit advance |
| GET /api/attempts/{id}/practice/{request_id} | Current identity | Original PracticeResult; unknown returns 404 |
| POST /api/attempts/{id}/practice/{request_id}/cancel | expected_revision | Saved result or cancellation tombstone, protecting against a late original request |
| POST /api/attempts/{id}/lesson | LessonInput, B+C three stations only | PracticeResult; saves selection, evaluation, explicit continue, edit, or listening exposure |
| GET /api/attempts/{id}/lesson/{request_id} | Current identity | Original PracticeResult; unknown returns 404 |
| POST /api/attempts/{id}/lesson/{request_id}/cancel | expected_revision | Original result or cancellation tombstone |
| GET /api/attempts/{id}/introduction/audio | Current identity; only the user's own candy-shop attempt | WAV after verification of version, original text, romanization, and file hash; the target filename is not sent |
| POST /api/attempts/{id}/turns | TurnInput | TurnResult |
| GET /api/attempts/{id}/turns/{request_id} | Current identity | TurnResult; unknown returns 404 |
| POST /api/attempts/{id}/turns/{request_id}/cancel | expected_revision | TurnResult; supports the cancel arriving before the original POST |
| POST /api/attempts/{id}/skip | expected_revision | Attempt; cancels in-flight turns, does not overwrite a success |
| POST /api/events | event_id, attempt_id?, event_type, metadata? | saved, duplicate; does not update order fields |
| GET /api/events | Current identity | Only events from the user's own session |
| POST /api/asr | Raw PCM16 WAV; Content-Type:audio/wav, X-Request-ID | {text,transcript,status,elapsed_ms,config_id,...}; the transcription by itself does not advance the task |

```ts
type Order = {
  item: string | null;
  quantity: number | null;
  unit: 'serving' | 'basket' | 'piece' | 'pack' | 'unknown' | null;
  normalized_servings: number | null;
  takeaway: boolean | null;
};
type Attempt = {
  id: string; station_id: 'nanxiang'|'restaurant'|'candy'|'teahouse';
  content_version: string; rule_version: string;
  status: 'collecting'|'confirming'|'completed'|'skipped';
  revision: number; order: Order; unresolved_issues: string[];
  summary_revision: number|null; confirmed_revision: number|null;
  prompt_id: string; pending_request_id: string|null;
  metrics: {voice_attempts:number;help_used:number};
  unit_convention_seen: boolean; turns: Turn[];
  practice?: Practice; // R3 only; historical versions lack this field
  lesson?: Lesson; // B+C three stations; Nanxiang keeps using practice
  created_at:string; updated_at:string;
};
type TurnInput = {
  request_id:string; expected_revision:number; channel:'buttons'|'text'|'voice'|'voice_edited';
  action?: {type:'set_order';item?:string|null;quantity?:number|null;
    unit?:Order['unit'];takeaway?:boolean|null} | {type:'confirm'|'repeat'};
  text?:string; summary_revision?:number; asr_request_id?:string;
};
type TurnResult = {request_id:string;status:'applied'|'pending'|'cancelled'|'failed';
  attempt:Attempt;interpretation_source:string|null;
  speech_feedback?: {outcome:'accepted'|'retry';
    reason:'understood'|'unrecognized'|'needs_clarification'|'repeat_requested'|'confirmation_required'}};
type Session = {
  id:string;locale:'zh'|'en';show_romanization:boolean;reduced_motion:boolean;
  mode:'development'|'production';content_version:string;rule_version:string;
  model_config_id:string;asr_config_id:string|null;created_at:string;attempts:Attempt[];
  completed_station_ids:string[];
  lesson_content_version?:string;lesson_rule_version?:string;
  services:{text:'development_parser'|'qwen';asr:'unconfigured'|'configured'};
};
```

## B+C: Fixed Questions for the Three Stations

Nanxiang and the base session remain bound to R3 content and rules; the first time a B+C station is started, `lesson_content_version=batch-bc.2026-10-17.v1` and `lesson_rule_version=station-lessons.v1` are appended to the current R3 session. The Attempts of the three stations are each bound to these two versions, without resetting Nanxiang progress. Old R1/R2 sessions and unknown extension bindings are not silently migrated and return `lesson_version_required`; existing attempts resume under their original binding. `/turns` and `/practice` cannot bypass the new station rules.

```ts
type Lesson = {
  step:string;step_id:string;target:string|null;can_choose:boolean;
  result:Practice['result'];answers:Record<string,string>;
  history:Array<{step:string;step_id:string;option_id:string;assisted:boolean;
    result:Practice['result'];revision:number}>;
  listening:null|{audio_url:string;played:boolean;text_revealed:boolean;
    introduction_text_id:string|null};
};
type LessonInput = {
  request_id:string;expected_revision:number;
  operation:'select'|'evaluate'|'continue'|'edit'|'listened'|'help';
  option_id?:string; // select
  text?:string;asr_request_id?:string;failure_kind?:'recognition'|'technical'; // evaluate
  assisted?:boolean;result_request_id?:string; // continue
  step?:string; // edit
};
```

| Station | Fixed steps | Options per question |
| --- | --- | --- |
| restaurant | preference → recommendation → dish → confirm | not_spicy; recommend; fish/chicken/tofu; confirm |
| candy | flavor → quantity → confirm | rose/osmanthus/mint; two_packs; confirm |
| teahouse | appreciation → thanks | good_tea; thanks |

- Every step first selects a target, then recognizes and checks, and the result stays on screen; only `continue` writes into `answers`. A preliminary selection, playing a dialogue line, or showing a recommendation does not count as a user answer. The target of the final `confirm` is set to `confirm` automatically, but it still requires a voice attempt or technical fallback followed by an explicit continue; for the teahouse, an explicit continue on thanks saves completion directly, and no order check is generated.
- The new three stations use the limited `station-target-check.v1`, which checks the target expression against the raw transcript, and additionally enforces task constraints. Tofu is a spicy dish and cannot complete the not-spicy task; the candy-shop flavor must match the fixed server-side target. Therefore, clearly saying a preselected option that does not fit the task returns `incorrect/task_mismatch`, and assisted continue likewise cannot bypass task constraints. The user can reselect and practice; no follow-up questions are generated.
- Every check for Nanxiang and the new three stations includes `scoring` (`lenient-rules.v1`): it first checks against the original text, and on failure rechecks after removing filler words and restarts. Pauses, repetitions, and homophone variants are recorded as 0-point deductions; content errors are recorded as critical errors and force `retry`. The score is for internal analysis only and is not shown in the UI; see [Lenient scoring notes](../docs/engineering/Scoring-system.md).
- Double negation, wrong object, paraphrase/quotation, quantity conflicts, and questions are not miscounted as target completion based on keywords. The limited semantic check is not arbitrary free-dialogue understanding or word-by-word pronunciation scoring. All textbook options have original-sentence regression tests; the saved ASR original text is not modified.
- Each candy-shop attempt is randomly assigned one fixed flavor, which does not change on refresh, language switch, replay, wrong selection, or resume. The private target never appears in Attempt, Session, errors, idempotency snapshots, or logs; audio is delivered via a private URL with no flavor marker. `listened` requires first successfully fetching that attempt's audio and must be called after the player ends normally; the server records the ended fact as `reported_by:client` and does not call it understood. Audio download, playback failure, cancellation, or only opening the word card do not count as listened.
- `help` is explicitly viewing the introduction text; it saves an irreversible exposure record, and only then returns the corresponding `introduction_text_id`. The flavor question can be checked/continued only after full playback or after using text help. Missing audio or identity verification failure returns 503; text help can still complete the task.
- `edit` can only go back from the restaurant/candy-shop confirm question to an earlier fixed step; it clears that step's and subsequent submitted answers, old results, and the confirmation revision, starts a new `step_id`, and requires Speak first again. Past answers are kept in history; the new confirmation is based only on the latest valid answers. Edits after completion are rejected; re-practicing creates a new attempt.
- Evaluation's original-text binding, single-use ASR consumption, original-text recovery on failure, result IDs, idempotency and cancellation, and atomic saving are the same as Nanxiang; the same ASR also cannot be consumed twice across Nanxiang and the new three stations. If a response is lost, the original request can be queried or cancelled; the client must use revision to prevent the original snapshot from overwriting later state. A save failure does not record completion, consume the ASR, or leave a half-written history entry.

## Revision 3: Fixed Practice and Manual Continue

New sessions bind `batch-a-r3.2026-10-17.v1` and `nanxiang-rules.v3`. R2, R1, and original baseline sessions continue to resume under their original content snapshot and rules; they are not silently migrated. R3 forbids modifying the order directly through the old `POST /turns`, returning `guided_practice_required`; old versions using `/practice` get `practice_version_required`. After a version change, the user still explicitly chooses a new exploration.

```ts
type Practice = {
  step: 'item'|'quantity'|'mode'|'confirm'; step_id: string;
  target: TurnInput['action']|null;
  result: null|{request_id:string;transcript:string|null;
    status:'correct'|'incorrect'|'unrecognized'|'technical';reason:string;
    channel:'voice'|'technical';reported_by:'server'|'client';
    asr_request_id:string|null;interpretation_source:string|null;
    scoring:Scoring};
  can_choose:boolean;
};
// Internal only; the UI does not display it. See docs/engineering/Scoring-system.md.
type Scoring = {version:'lenient-rules.v1';profile:'lenient'|'standard'|'strict';threshold:number;
  score:number|null;verdict:'pass'|'retry'|'rerecord'|'unavailable';capped:boolean;
  deductions:{type:string;points:number;span:string|null;uncertain:boolean}[]};
type PracticeInput = {
  request_id:string;expected_revision:number;
  operation:'select'|'evaluate'|'continue'|'edit';
  action?:TurnInput['action']; // select only
  text?:string;asr_request_id?:string;
  failure_kind?:'recognition'|'technical'; // evaluate only
  assisted?:boolean;result_request_id?:string; // continue only
  step?:'item'|'quantity'|'mode'; // edit only
};
type PracticeResult = {request_id:string;status:'applied'|'cancelled';attempt:Attempt};
```

- `select` only saves a valid target for the current question and clears the old result; it does not write the order. The item can only be `xiaolongbao`, the quantity is 1–20 with `unit:'serving'`, and the mode is a boolean. Each submission may contain only the current question's field; a target containing all order fields cannot be selected. The final question's default target is `{type:'confirm'}`.
- `evaluate` carries an ASR ID saved in this session and the exactly identical original transcript `text`; the server checks independently and does not trust a client correctness flag. It does not change the order, issues, status, summary, or completion list; it only saves the result. The original text is always kept; an empty transcript is `unrecognized/no_speech`, and text that is present but not understood is `incorrect/not_understood`. After the result is returned, the frontend must stay on it.
- Failures use `evaluate`'s `failure_kind` and cannot submit `text` at the same time; when an ASR failure ID exists, the server distinguishes no speech from technical failure using the saved error. If the ID carried by a browser technical timeout is still pending/not yet created, a genuine technical empty state with `reported_by:'client'` is saved and fallback is opened; if the backend actually succeeded, the original transcript is read from the server, checked, and the result shown. Device/browser failures without an ASR ID are likewise marked client, with an empty original text; they cannot be falsely recorded as backend recognition evidence. A technical failure is `technical`, not mispronunciation; a late-returning ASR does not overwrite a saved result.
- A normal advance via `continue` must carry the `result_request_id` of the current correct result. After an error, no speech, or a technical failure, `can_choose=true`, and only when the user explicitly chooses `assisted:true` does it advance using the current target; this increments the help count and records an assisted continue, without fabricating a voice result. Changing to a new target after a failure clears the result but keeps the current question's fallback eligibility; in that case assisted continue may omit the result ID, but if a result ID is provided it must match the current result.
- Only moving to the next question replaces `step_id` and resets the target/fallback eligibility; selection, evaluation, and refresh within the current question keep `step_id`. The fixed questions are only `NX-N01 → NX-N02 → NX-N03 → NX-N09`, ending at `NX-N10`. Extra fields cannot advance across questions; there are no ad-hoc follow-ups for unit, item, out-of-range values, etc.
- `edit` only returns from the final check to a specified fixed question, and immediately invalidates the old confirmation summary. The original order is kept at first, and evaluation still does not modify it; only clicking continue applies the new field and returns to the check. The new edit question again requires a voice attempt first, and its failures/results can be restored across refreshes.
- `revision` covers state changes from selection, results, and advancing; `summary_revision` is fixed upon entering the check question and is not invalidated by selection/evaluation within that question. The confirmation result must also stay on screen; completion happens only when an explicit `continue` is saved successfully; an assisted confirmation must likewise be clicked explicitly.

The check source is `guided-target-check.v1`; it does not call a free-dialogue LLM, and it is not tone or word-by-word pronunciation scoring. The quantity question allows bare digits, common words, and a limited "分→份" homophone miswriting; substitutions used for judging do not change the original text. Explicitly different units such as 只/笼/个, ranges, fractions, durations, conflicts, and negations mark the current result card incorrect without starting a new question. R3 takes a conservative boundary on negative expressions and will not pass merely because target words are mentioned; it does not promise to understand arbitrary free-form modification sentences.

Result reasons: `target_matched`, `ambiguous_expression`, `target_mismatch`, `quantity_mismatch`, `mode_mismatch`, `item_mismatch`, `unit_mismatch`, `confirmation_mismatch`, `not_understood`, `no_speech`, `device_or_service_unavailable`, `asr_failed`. These stable codes are rendered by the frontend according to language; the server does not compose user-facing text.

The state, events, and idempotent responses of all practice operations are written in one SQLite transaction, and no pending state is produced that would require paid reprocessing. Repeating the same ID/payload returns the original result; the same ID with a different payload returns `idempotency_conflict`, and an old revision returns the latest Attempt and `stale_revision`. A save failure rolls back all changes and the ASR consumption marker; the original ID can be queried and the original payload retried. Cancelling an unknown ID creates a tombstone, and a late POST returns cancelled; cancelling a completed operation returns its saved result and does not undo an advance that has already happened.

Within the same session, the same ASR result can be consumed by only one practice evaluation (except for idempotent reads with the same request ID); reusing it across questions or in a different request returns `asr_result_already_used`. Frontend recording callbacks must still be bound to the attempt/step/target/revision at recording time; late callbacks after leaving, cancelling, or reselecting should be discarded and must not rewrap an old recording with the latest revision. Client failure fallback is a teaching strategy, not proof of acoustic accuracy or a security certification.

## Historical Turn Contract for the Original Baseline / Revision 1 / Revision 2

The following `/turns`, free-field parsing, and clarification rules describe only the retained historical versions and are not used in the R3 main flow.

Fields submitted in `set_order` must actually have been expressed; absent fields are kept, null explicitly clears, and false genuinely means dine-in. R2 completion requires xiaolongbao, a valid 1–20 servings, explicit dine-in or takeaway, and a separate confirmation; two servings or takeaway are no longer required. A quantity change must carry a unit; the unit is not borrowed from the old order. A new quantity/unit/item/mode, and invalid modifications, first invalidate the old summary; a "对" in the same turn's text cannot confirm a summary that has not yet been displayed. `confirm` is then submitted separately, carrying the displayed `summary_revision`. Each request uses a new request_id (8–100 letters/digits/`_`/`-`); network retries reuse the same ID with exactly the same payload. Repeating an already-applied turn returns the originally saved result; if newer progress exists since then, the frontend should use revision to prevent the old result from overwriting the current state, and GET the attempt if necessary.

`POST /api/session/new` is called only after the user explicitly clicks "开始新的探索" (Start a new exploration) and confirms; it is not called automatically on configuration conflicts or ordinary refreshes. It keeps the current language, romanization display, and reduced-motion preferences, binds the new session to the current content/rule/model configuration, and returns empty attempts and an empty completion list. The old session, saved attempts, and success records remain in the database; they are neither deleted nor moved into the new session, and the new cookie has no access to the old session. The frontend should first cancel in-flight tasks and clear the old session's local drafts/request state, to prevent late UI results from overwriting the new exploration.

Revision 2 new sessions bind `batch-a-r2.2026-10-17.v1` and `nanxiang-rules.v2`. R1 sessions keep `batch-a-r1.2026-10-17.v1` and baseline sessions keep `batch-a.2026-10-17.v1`, each reading its original content from `content/versions/<原版本>.json`; if the file is missing, unknown, or its in-file version does not match, `content_version_unavailable` is returned, and an old pack cannot be silently replaced with new copy. Rules are likewise dispatched by the Attempt's original binding: `nanxiang-rules.v1` still requires two servings for takeaway and will not silently complete old tasks because R2 has gone live. All Attempt responses include their `content_version/rule_version`; when early records lack these fields they are filled in from their original session, and reading by itself does not migrate the database. Cached responses of historical turns are still the order and revision of that time, with the original version attached; they are not replaced with the latest order.

The R2 UI presents only voice and buttons; the backend still retains the `text` and `voice_edited` data structures, historical reads, and the idempotent results of submitted requests. Old successes, old text, ASR original transcripts, and edited text are not deleted or rewritten. If the current static UI carries only the R2 pack, then on encountering an old session it should explain the version difference and provide a user-initiated "开始新的探索" (Start a new exploration) entry, without labeling old progress as results under the new content.

Allowed events: `expression_opened`, `expression_inserted`, `unit_explanation_viewed`, `recording_started`, `recording_stopped`, `recording_cancelled`, `recording_played`, `recording_permission_denied`, `asr_submitted`, `asr_succeeded`, `asr_failed`, `asr_cancelled`, `audio_started`, `audio_ended`, `audio_interrupted`, `pronunciation_support_changed`, `input_channel_changed`, `station_entered`, `assistance_recorded`, `logging_gap`. Send `unit_explanation_viewed` only after actually displaying "一笼示意对应一份" (one basket illustrated as one serving); only basket units submitted after that can be normalized. Events cannot complete an order directly. A recording permission denial must not send `recording_started`. Client ASR and playback events are UI diagnostics only; the backend forcibly records `reported_by:client`, and they do not increase voice-attempt, help, success, or completion counts. The real recognition result is recorded separately by the server as `asr_finished` (`reported_by:server`), and the client cannot submit that event.

HTTP 409 with `detail={code,message,attempt?}` indicates a conflict; refresh the attempt and display the latest version. 422 is a request validation failure; 503 means a service or save failure. On a save failure, completion must not be shown; first query the original ID, then retry with the original payload. Prepared interpretations are persisted to disk, so after a final transaction failure the submission can be retried without reinterpreting; state, completion events, and results are saved in the same transaction. In-progress interpretations can be cancelled; a pending request left over after a crash can be queried and cancelled, then resubmitted with a new ID.

An interpretation failure terminates the turn and returns `detail.terminal=true`; an explicit retry generates a new ID. This differs from retrying with the original ID for save failures and unknown network results. After a page refresh, the query/cancel entry must also be shown based on `attempt.pending_request_id`, rather than relying only on in-memory request objects.

In R2, after the user actively ends a recording, the frontend automatically transcribes it and automatically submits `channel:'voice',text,asr_request_id`; manually sending the recording and "使用这句话" (Use this sentence) are no longer required. The original transcript can be viewed read-only; the `voice_edited` compatibility structure for old clients and history is kept. The ASR ID must belong to the current session, and the original transcript is read from the server's saved result; `voice` text must exactly match the original transcript, and a preliminary practice selection cannot replace this evidence. Turns return `asr_transcript` and `text` separately, and edited content is not falsely recorded as a recognition result. ASR errors return a stable `detail.code/retryable/terminal`; an empty transcript returns `detail.code='no_speech'`. Only a retry after a terminal failure changes the ID; unknown results still reuse the original ID. For unknown requests whose transcription has been processing for more than 30 seconds, the user may explicitly start a new request; the model is not re-called automatically.

Applied `voice` turns add `speech_feedback`, which is saved together with the order and the idempotent response. `accepted` means the expression was understood; it does not mean completion or correct pronunciation. A clear negation/valid modification is `understood`, a request to repeat is `repeat_requested`, and a confirmation before the summary has been displayed is `confirmation_required`. Unrecognizable meaning returns `retry/unrecognized`; field ambiguity or rule issues such as quantity/unit return `retry/needs_clarification`. These are not word-by-word pronunciation evaluations. Based on `retry`, the frontend opens button answers for the current question and distinguishes "not understood" from "content needs clarification"; normal help requests and explicit expressions that make no progress are not falsely recorded as voice failures. ASR/microphone/service failures also allow frontend fallback; the first Speak per question is a teaching interaction strategy, not a security authorization boundary of the order API; historical button clients and idempotent recovery remain compatible.

Text parsing defaults to a limited development parser covering the common Chinese/English expressions and quantity/unit/negation corrections in the draft; it does not promise arbitrary natural language, and does not present model output or UI copy as reviewed Shanghainese. Setting `TEXT_INTERPRETER=qwen` selects the actual Qwen interpretation adapter; the service must also be explicitly enabled and credentials configured, and it does not silently fall back to the development parser on failure. Sessions are bound to interpretation/ASR configuration IDs; after changing the model or mode, use a new session; the source of historical sessions is not silently modified. Real ASR/TTS calls must be explicitly enabled with credentials configured; when unconfigured, a clear error is reported. ASR processes recordings in memory and does not store raw audio on disk; the request ID deduplicates the same recording. Actual human speech, model quality, and listening-review status are as stated in the verification records.

The R2 development parser is labeled `development-parser.v3`: explicitly spoken "小笼／小笼包／小笼馒头" map to `xiaolongbao`; it supports common Chinese and English numerals 1–20, "要两／两吧／两，谢谢" under an explicit servings question, expressions such as 堂食/这里吃 (dine-in / eat here), and standalone confirmations such as "好个／嗯，对个，谢谢". Only when `NX-N02` has explicitly asked for the number of servings can an omitted unit be filled in as `serving`; 两个/两只 are not converted to 两份. Fractions, ranges, approximate numbers, trailing negation, and contradictory dining modes still require clarification. Quantity, negation, unit, and confirmation are validated separately, and the evidence and original text keep the original sentence. When a repeat request and a correction appear together, the correction must be kept; "再讲一遍" (say it again) cannot be used to bypass an order change. History and cached retries of old `development-parser.v1/v2` sessions are readable; new text or voice interpretation returns `configuration_changed`, prompting an explicit new exploration, while the original version's button rules and turns that are already prepared and only awaiting save can still be resumed. Regression results for the limited parser here do not mean that real ASR/LLM quality on the new Shanghainese script has been reviewed.

The automated tests' `tests/conftest.py` disables all real calls and selects the development parser before the app is loaded, so that a user's local `.env` cannot cause test charges. Adapters are tested via mock HTTP; passing tests does not mean Shanghainese performance has been verified.
