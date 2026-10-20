# Batch D Checks

Date: 2026-10-17. **D is complete within the deployment and basic-operation scope; E has not started.** Checked: frontend and backend, accounts and the assisted path through the four stations, persistence across a real update restart, the single ASR call on synthetic audio, private backup download, and isolated restore. This file does not represent real human speech, device compatibility, teaching quality, or final product acceptance.

## Implemented

- Vercel Vite frontend and Node `/api` proxy configuration; Render Python single instance, Virginia, paid persistent disk configuration. Initially, selected commits are deployed manually.
- Validation of required configuration at production startup, Secure/HttpOnly/SameSite cookies, exact Origin allowlist, proxy secret and trusted IP verification; unauthenticated direct API access is rejected, and the health check is publicly readable.
- `build:deployment` keeps teaching materials in pending-review status, checks 4 manifests, 82 audio bindings, and 64 distinct WAV files, and generates a version manifest; the formal `build:release` gate is retained.
- SQLite online consistent backup, integrity and foreign-key checks, restore to a new path only; pre-start backups and dedicated automatic backups keep the latest 3, and manual backups are not deleted. An empty database is initialized on first startup.
- Daily same-disk backup and idle-guest cleanup are live; the first maintenance cycle and the pre-update-start snapshot succeeded, and the health check does not trigger cleanup.
- [Deployment operations](Deployment.md), [Database maintenance](Database-maintenance.md), and environment variable templates.

## Local Verification

| Scope | Result and boundaries |
| --- | --- |
| Pending-acceptance build | First-round type check, 49 existing content tests, 11 new deployment content tests, Vite build, and output audio hash check passed; all 64 distinct WAV files intact. After an additional fix to cloud source metadata, 12 deployment content tests passed in total; 11 and 12 are two successive rounds and are not added together |
| Frontend regression | 170 passed, covering existing fixed questions, result hold, assisted continue, identity binding, Review, and audio behavior |
| Backend | First full regression: 473 passed; after adding database failure regressions, all 35 production-specific tests passed. The two sets overlap and are not added together |
| API proxy | 15 passed, including raw bytes of WAV/JSON from a temporary local HTTP upstream, multiple cookies, session headers, forged headers, Origin, paths, redirects, size limits, timeouts, and cancellation; not equivalent to real Vercel routing |
| Data maintenance and startup | 9 backup/restore tests and 5 startup tests passed, all using temporary databases; covers WAL, corrupted database, refusal to overwrite, config-first checks, abort on backup failure, and rotation of automatic backups only |
| Daily maintenance addition | 9 new tests and 92 related checks passed; two independent reviews found no blockers; deployed, with actual runtime evidence in the next section. The related checks overlap and are not cumulative with the rows above |
| Production startup/restart | Ran the production script for real twice, using a temporary copy of the source, an empty database, a synthetic proxy secret, and an environment with speech disabled; health, direct-access rejection, register/login/logout, and case-insensitive duplicate-name rejection passed |
| Persistence recovery | After the above local process restart, account ID, English UI, and hidden-romanization preference were restored; one automatic backup was generated and passed integrity/foreign-key checks. This row is local evidence only; the real Render restart verification is in the next section |
| Cookie | Production mode returns Secure/HttpOnly/SameSite=strict. The local HTTP smoke test passed cookies manually; actual HTTPS login/refresh/logout-and-relogin is covered in the next section |
| Independent review | No new clear blockers found; the original path and fetch handler of the plain Node rewrite were checked against official Vercel documentation, and the online testing below was completed |

The checks above did not call ASR/TTS, and the production startup smoke test did not read the real `.env` or the local user database; test processes and temporary databases have been cleaned up. The existing 677.43 kB main JS size warning remains; product UI and audio content were not changed this time.

## Actual Platform and Online Checks

- Logged in to both the Vercel and Render consoles; both platforms can read the personal fork. Full-repository authorization for Render was explicitly confirmed by the user, and the user completed GitHub re-verification.
- The Vercel production URL is [A little Shanghai](https://spec-virtual-shanghainese-learning.vercel.app), deployment `GhTdMgq48GeChMw7i7Gdna9sqpKa` is Ready; Render deployment `dep-db9vq2lg1s2s73a7ok80` is Live. The current application source on both ends is `da96ca8883d1d5b2aab626f5eb6f60ab1bafe93f`, and the collaboration repository and fork are synced as agreed.
- Online `/deployment.json` returns 200, with the commit being the version above, `provider: vercel`, `dirty: null`, `reviewStatus: pending`. The cloud source metadata fix has been released and verified; teaching materials are still pending review.
- Public `/api/health` returns 200, `production`; frontend `/api/auth` returns 200, `signed_out`; direct Render `/api/auth` without proxy authentication returns 403, `proxy_required`. A POST with a wrong Origin returns 403, `cross_origin_denied`.
- The user resolved the Chrome extension file access restriction; the Vercel proxy secret was imported and scoped to Production, and 13 environment variables were imported into the Render creation form. Private configuration is stored in a Git-ignored directory; secrets were not shown in logs or documents.
- Render service `srv-db9vmreq1p3s739p3p30` uses the user-authorized Virginia region, 0.5 CPU/512 MB, and 1 GB disk; base costs are US$7/month compute and US$0.25/month disk, US$7.25/month in total, with taxes and overage usage billed separately; no upgrades, add-ons, or custom domain purchases. The backend URL is [a-little-shanghai-api](https://a-little-shanghai-api.onrender.com).

| Online check | Result and boundaries |
| --- | --- |
| API baseline | 36 passed; recorded in Git-ignored `private/deployment/online-smoke-baseline-20261017T225126-3710.json`. Using isolated test identities, verified registration carry-over, duplicate-name rejection, cross-account isolation, protected audio, login merge, logout, and re-login; the API baseline made no model requests |
| Four-station basic flow | The above baseline, explicitly simulating the client-side technical fallback, completed all four stations via assistance and saved; this is not proof of real recognition or speech correctness at the four stations |
| Real browser | In Chrome: Chinese guest entry defaulting to About, Chinese/English map toggle, entering Nanxiang, and the `host-speaking` state of the normal/slow speed buttons passed. A separate UI test account passed registration, persistence across refresh, default About after logout and re-login, and Review showing Nanxiang in progress and the other three stations not started; at wrap-up the test account was logged out, and the site keeps the login entry. No microphone recording or hardware audio listening review was done |
| Static audio | The SHA256 of the online E08 WAV matches the existing teaching asset; no audio was regenerated and no TTS calls were added |
| The single real ASR call | A separately approved E08 synthetic WAV (1.6 s, 24 kHz, mono) was sent through the online proxy to Beijing `qwen3-asr-flash`; it returned the raw transcript 「我要两份小笼馒头。」, `elapsed_ms:1962`, config `asr-4c784f1651e2840a`. The target match was correct, the raw transcript stayed on the item question, and it did not auto-advance |
| Request and cost boundaries | 1 ASR call actually sent, no microphone, no retries, no new LLM/TTS. The first run exited before sending due to a wrong local file path, sending 0 requests; after the fix, only the single request was sent. Authorized cost cap ¥1; the actual bill has not been checked; the single-use authorization is used up |
| Persistence across real update restart | After releasing `da96ca8`, the 5 checks of `--verify-persistence` passed; the original account session, four-station completion state, 5 attempts, and preferences remained consistent. The private report is `private/deployment/online-smoke-verify_persistence-20261017T225747-1885.json`; no new model requests |
| Online automatic maintenance | Before the update start, `/var/data/backups/auto-prestart-20261017T225647295404Z.db` was generated; the log records `maintenance_cleanup_succeeded removed=0` and `maintenance_backup_succeeded`, proving the first maintenance cycle succeeded. Deleting 0 records when there are no expired records is expected and is not presented as verification of actual deletion |
| Online consistent backup | Render Shell generated `/var/data/backups/dcheck-20261017T2253.db`, downloaded via SSH to local `private/deployment/dcheck-20261017T2253.db`; the SHA256 on both ends is `92482d727ef23a2fd201ec524b5067831a816786fd3f419c70a6f0e3f87ad8e6` |
| Isolated restore | Restored the downloaded backup to a separate local file and, using matching source from `git archive e3beb7d`, completed 11 checks, including original account login, four stations and 5 attempts, settings write, and re-login; 0 network, 0 model. The report is `private/deployment/offline-restore-check.json`. The production database was not overwritten, and no in-place production rollback was performed |

The ASR above only proves online connectivity and target checking for synthetic teaching audio; it does not count toward E's real human speech, Shanghainese recognition quality, or teaching audio evaluation. For the detailed record of the real call, see [Speech integration](Speech-integration.md#batch-d-online-e08-synthetic-audio-connectivity-check).

The backups and reports above are stored in a Git-ignored private directory. The temporary SSH public key has been removed from Render, and the console shows `No authorized SSH keys`; the local temporary private key has also been removed. No backups, credentials, or private keys were added to Git.

## Delivery Boundaries and Ongoing Maintenance

- Daily same-disk backup and idle-guest cleanup are live; this time there is a manually downloaded private off-site copy, but automatic off-site transfer is not yet configured. Continue manual transfers per the [maintenance guide](Database-maintenance.md); same-disk backups cannot replace off-disk copies.
- The isolated restore verification did not cover the production database and is not an in-place production rollback drill; a formal rollback should follow the deployment/maintenance guides, stopping the service and keeping the original database.
- E has not started. Browser microphone, hardware audio, real human speech, physical device compatibility, and model performance remain to be verified in E, and are not substituted by synthetic samples or playback state; teaching material review also remains pending.
- Cancelling a proxy request does not prove that provider inference or billing has stopped; the system does not use this as a cost guarantee.

The scope and source of each test round are recorded separately; local, online, synthetic speech, and restore checks are not aggregated into a single quality score. D's basic deployment scope is complete, and the limitations above carry over to the corresponding maintenance and E work.
