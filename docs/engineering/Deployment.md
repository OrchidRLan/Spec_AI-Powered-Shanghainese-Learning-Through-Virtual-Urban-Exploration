# Deployment: Vercel and Render

This is the Batch D version awaiting full acceptance. Teaching language, romanization, and audio remain review drafts; deployment is not language approval. Current delivery and online verification are recorded in [development status](../Development-status.md).

## Architecture and source

- Both platforms use `hollis-yang/Spec-Virtual-Shanghainese-Learning`, branch `main`, repository root `./`.
- Vercel serves the Vite frontend and a small Node API proxy. Select **Vite**, not the automatically detected multi-service preset; the Python app belongs on Render.
- Render runs one Python 3.11 API process in Virginia, with a 1 GB persistent disk at `/var/data`. SQLite is `/var/data/app.db`. New production accounts start in an empty database; local user data is never uploaded.
- Vercel rewrites `/api/:path*` to `api/proxy.js`. The proxy preserves the original API path and Cookie headers. A shared server-only secret authenticates this hop; Render trusts the forwarded client IP only after authenticating it. Browsers use only the Vercel origin.
- Existing teaching WAVs travel with the repository. Render also needs `content/` and the teaching audio under `frontend/public/`; do not set its root to `backend/`.

The Render creation screen checked on 2026-10-17 lists `0.5c-512mb` (0.5 CPU, 512 MB RAM) at **US$7/month**, plus **US$0.25/month** for 1 GB disk. This is US$7.25/month before taxes, excess usage, and the separate speech-provider bill. Confirm the actual checkout before creation. Vercel currently uses the existing Hobby workspace. See [Render pricing](https://render.com/pricing) and [disk limitations](https://render.com/docs/disks).

## Build and verification

```sh
npm ci
npm run build:deployment
npm run test:ui
npm run test:api
npm run test:deployment-proxy
npm run test:database-maintenance
```

`build:deployment` validates the current content packages, review evidence, all audio bindings, WAV structure, duration and hashes; runs type/content checks; builds Vite; then verifies output audio. `dist/deployment.json` records the code commit, review status, content versions, and audio hashes. It contains no environment secrets. Cloud builds use the provider's source commit and record `source.provider` as `vercel` or `render`, with `source.dirty: null`: cloud build files cannot establish source cleanliness, so null is not a deployment error or a claim of a clean checkout. Local builds record actual Git status.

`build:release` continues to reject unapproved teaching material. Do not change approval fields to make deployment pass. The proxy tests use temporary localhost HTTP servers; all database tests use temporary files. None of these checks calls a live speech provider.

## Environment variables

All variables below are server-side. Never prefix a key or proxy secret with `VITE_`. Keep `.env`, private deployment imports, and databases out of Git. Use a distinct, random proxy secret of at least 32 printable ASCII characters, shared by these two services only.

| Platform | Variable | Value |
| --- | --- | --- |
| Vercel | `BACKEND_URL` | Actual Render HTTPS service origin, without an API path or query |
| Both | `BACKEND_PROXY_SECRET` | Exactly the same private random value |
| Render | `APP_ENV` | `production` |
| Render | `COOKIE_SECURE` | `true` |
| Render | `DATABASE_PATH` | `/var/data/app.db` |
| Render | `ALLOWED_ORIGINS` | Exact stable Vercel production HTTPS origin; no wildcard |
| Render | `DASHSCOPE_API_KEY` | Existing user-approved local speech key |
| Render | `SPEECH_ENABLE_LIVE` | `false` |
| Render | `QWEN_ASR_ENABLE_LIVE` | `true` to enable the intended live recognition service |
| Render | `QWEN_ASR_REGION` | `beijing`, matching the existing configuration |
| Render | `QWEN_TTS_ENABLE_LIVE` | `false`; playback uses saved teaching audio |
| Render | `QWEN_LLM_ENABLE_LIVE` | `false`; guided practice does not need extra LLM calls |
| Render | `TEXT_INTERPRETER` | `development_parser`, the existing legacy text fallback |
| Render | `PYTHONUNBUFFERED` | `1` |

An explicit `QWEN_ASR_ENABLE_LIVE=true` overrides the global speech switch for ASR only. If the existing local setup uses `QWEN_ASR_API_KEY` separately, configure that approved key on Render instead of silently substituting a key for another service. Do not import unrelated local environment values. Health checks do not call ASR/TTS.

Configure production-only Vercel secrets; unapproved preview domains must not write to the live database. The UI uses secure, HttpOnly, SameSite=Strict cookies through the same-origin proxy. Direct Render API calls are rejected except health GET/HEAD. See [backend configuration](../../backend/API.md).

## First deployment

1. Complete GitHub access for the fork. Review and commit checked code, then run `npm run git:publish`; verify both remote `main` commits match. No database, credentials, recording or private backup belongs in this commit.
2. Import the fork in Vercel. Use repository root `./`, Vite, Node 24.x, `npm ci`, `npm run build:deployment`, and output `dist`. The committed `vercel.json` sets these build/routing defaults and function region `iad1`. Select the existing Hobby workspace. Record the actual production URL.
3. Prepare Render from [render.yaml](../../render.yaml), or use the same values in its Web Service form: Python, repository root, main, Virginia, paid `0.5c-512mb`, one instance, 1 GB disk at `/var/data`, health `/api/health`. Build with `pip install -r backend/requirements.lock`; start with `python scripts/start-render.py`. `.python-version` selects the latest Python 3.11 patch.
4. Set exact environment values and confirm the paid service and disk cost before creating them. Do not place migrations in a pre-deploy hook: the persistent disk is unavailable there. The startup script validates production settings, backs up an existing database before migration, and runs one API worker. First start creates an empty database.
5. Record the actual Render service URL; set it as Vercel `BACKEND_URL`, ensure the proxy secrets match, and redeploy the frontend. Ensure Render `ALLOWED_ORIGINS` matches the stable frontend URL. An incomplete frontend/backend pair is not a finished deployment.
6. Execute the minimum checks below. Record deployed frontend/backend commits separately and confirm they use compatible content. Hand over a URL only with an accurate description of what has passed.

Render and Vercel automatic Git deployments are initially disabled. Repository synchronization and deploying a release are separate operations. Use an explicit deployment of the checked commit to coordinate the two platforms. Vercel's [Git configuration](https://vercel.com/docs/project-configuration/git-configuration) does not prevent an explicit manual deployment.

## Minimum online checks

| Check | Required evidence |
| --- | --- |
| Version and routing | Production `/deployment.json`, `/api/health`, `/api/auth`, and a nested API path use the expected build and backend; health reports production |
| Login and cookies | Registration, duplicate username rejection, logout/login, account separation, secure cookie persistence, and guest-to-account transition |
| Progress | A saved step survives refresh, logout/login, and a backend redeployment; the first production database contains no imported local users |
| Four stops | Open and complete each fixed flow with explicit Continue, save and Review; distinguish assisted completion from speech success |
| Audio | Normal/slow saved audio and protected candy introduction play; protected API audio rejects requests without identity |
| Voice wiring | Use only authorized test audio/calls, record the source and count; no accuracy conclusion from one connectivity check |
| Boundaries | No proxy secret or speech key in the frontend bundle; direct backend API, wrong origin and cross-account requests denied |
| Maintenance | Verified backup, recovery to a new path, correct database mount and restart persistence; maintain a private off-disk backup copy |

Vercel rewrite routing, real browser cookies, microphone access and platform cancellation still need actual deployment evidence. Aborting a frontend proxy request does not prove that an already started speech-provider call was cancelled or unbilled. Full voice quality, devices, compatibility, language/audio approval and final acceptance belong to E.

## Update and rollback

Before a backend update, take a consistent backup and record its hash and application version. See [database maintenance](Database-maintenance.md) for verified backup, restore and guest-cleanup commands. Startup retains three automatic pre-start backups on the same disk. The production API also runs same-instance maintenance every 15 minutes: expired-guest cleanup and a verified snapshot on the first cycle of each UTC day, retaining seven daily copies. Confirm these events on the deployed instance. Private off-disk transfer remains separate; same-disk snapshots do not protect against loss of that disk.

Publish checked commits with `npm run git:publish`, verify both main branches, then manually deploy the intended fork commit on Render and Vercel. Check health, cookies, saved progress and affected teaching content. With an attached disk, Render updates briefly interrupt service; no horizontal scaling or zero-downtime guarantee applies.

For a failed code update, redeploy the recorded compatible code version on both platforms. Roll back the database only if necessary and after stopping all writers, using a verified snapshot restored to a new path. Keep the original file until recovery is accepted. Do not assume an older application can read a newer schema, and do not use a frontend rollback to overwrite learning progress.
