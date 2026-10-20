# Speech service boundaries and content production

This document keeps the speech adaptation, production and live-call records; batch-by-batch counts describe historical runs and do not represent full quality acceptance. For current product behavior see the [product spec](../Product-spec.md); for pending verification see the [D/E plan](../Batch-DE-plan.md).

Latest connectivity check (2026-10-17): Batch D ran the separately approved **1 E08 synthetic-audio ASR call** through the actual Vercel/Render deployment, with no retry and no microphone; see the next section. It does not constitute acceptance of real human speech or language quality. Before that, [Batch B+C](../archive/batches/Batch-BC-plan.md) kept Nanxiang's speech adaptation and explicit-continue interaction, and added fixed-target checks for three stations plus 36 pending audio clips. That B+C round had only the 35 TTS calls described below, with no new ASR, LLM or real human recordings; full evidence is in [B+C acceptance](../archive/batches/Batch-BC-acceptance.md).

Current overriding decisions (2026-10-17): [Batch A revision 4](../archive/batches/Batch-A-revision-4.md) trims the persistent Chinese/English hints, carries the actual order into the final confirmation with matching audio, unifies the completion button and reorders the location cards. The flow follows [revision 3](../archive/batches/Batch-A-revision-3.md): only the four fixed questions (item, quantity, dine-in/takeaway, order check) remain, and ad-hoc follow-up questions are removed; after recognition the raw transcript and correct/incorrect result are shown, the flow advances only on an explicit continue click, and on failure the user can retry or continue with assistance. Parts not covered follow [revision 2](../archive/batches/Batch-A-revision-2.md); the conflicting historical rules below are overridden by the latest revision, and actual completion status is in [development status](../Development-status.md).

Verified on: 2026-10-17. The implementation is in `backend/app/providers/`, and the official production entry point is `scripts/speech.py`; the R1 pending-draft entry point is `scripts/speech-review.py`, and R2 is `scripts/speech-review-r2.py`. The current [R2 manifest](../../content/audio-review-r2.json) contains **20 normal-speed Jada Shanghainese pending records, 18 unique files, 24.56 seconds total counted per entry**; the frontend plays local static assets and supports 1× / 0.75× pitch-preserving playback. The original [R1 sentence-by-sentence review sheet](../content-review/Pronunciation-draft-r1.md) is kept as historical. **Real Shanghainese recognition quality, Jada's Shanghainese teaching pronunciation, and normal/slow-speed listening review remain pending**; successful live requests, file checks and mocked transport cannot substitute for language review.

## Batch D: online E08 synthetic-audio connectivity check

On 2026-10-17, under the user's additional authorization, **1 ASR call, 0 LLM, 0 TTS, no retry** was made through the same-origin proxy of the [actual frontend](https://spec-virtual-shanghainese-learning.vercel.app) and the [Render backend](https://a-little-shanghai-api.onrender.com). Both ends were built from source `e3beb7dc6c2feb8f630a1d11ee13b2d80a879e59`; Vercel deployment `G2g4NfWeERH5BhWPaqJX4kxjh8bt` was Ready. The input was the existing E08 「我要两份小笼馒头」 ("I want two servings of xiaolongbao") synthetic PCM16 WAV, 1,600 ms, 24 kHz, mono; no microphone or real user recording was used.

Beijing `qwen3-asr-flash` returned the raw transcript **「我要两份小笼馒头。」**, `elapsed_ms:1962`, config ID `asr-4c784f1651e2840a`. The selected-target check was correct, the raw transcript was kept, and the flow stayed on the Nanxiang item question without auto-advancing. The first script run exited before sending because of a wrong local audio path, sending **0** requests; only after the path was fixed was the single request sent, so this must not be recorded as two calls or a paid retry.

The cost cap for this authorization was **¥1**; actual billing was not checked and no actual charge is fabricated; the single-call authorization is used up. There were also 36 online API baseline checks, in which all four stations completed via assistance after an explicitly simulated client technical fallback, with no model calls and no speech-correctness conclusion. The browser check covered the normal/slow-speed buttons and the clerk-speaking state; no hardware audio listening review was done. The above only confirms deployment connectivity, the raw transcript and the fixed-target check; it does not replace E's real human speech, physical devices, ASR effectiveness evaluation or teaching-material review. Full boundaries are in the [D check record](Batch-D-checks.md).

## Batch B+C: pending audio and checks for three stations

The [three-station content pack](../../content/batch-bc.json) is version `batch-bc.2026-10-17.v1`, with 36 candidates in total, covering clerk questions, learning expressions, flavor introductions, full order confirmations and closings. The corresponding rules are `station-lessons.v1` and the expression-check source is `station-target-check.v1`; the selected target is still checked against the raw ASR transcript, the original text is kept, no free-conversation LLM is called, and there is no auto-advance.

This batch ran **35 Alibaba Cloud Beijing `qwen3-tts-flash` + Jada TTS calls on the frozen list, with no automatic retry**. The provider's `usage.characters` totaled **516**; at the verified [Beijing list price](https://help.aliyun.com/zh/model-studio/qwen3-tts-flash) of 0.8 yuan per 10,000 characters, the estimate is **¥0.04128**; account billing, free quota and discounts were not queried, so this estimate must not be written up as the actual charge. The call cap was 35 and the budget ¥2. The generation config is `tts-7f9e533827ac529c`; the target language `wuu` and the provider parameter `Chinese` are recorded separately, and the latter does not certify Shanghainese pronunciation quality.

**35 new PCM16 WAVs** were added, all 24 kHz mono, saved in `frontend/public/audio/review-bc/`; "对个" ("right") reuses the full original R1 E05 recording, with no new charge. In total there are [36 audio records](../../content/audio-review-bc.json) and 36 unique files, **55.92 seconds** counted per entry. The manifest stores the text/romanization versions, frozen hash, config, request identifiers, duration, SHA256, usage and reuse provenance; all entries remain `reviewStatus:pending`, `listeningReview:pending`, with empty approval records. Slow speed reuses the same file with 0.75× pitch-preserving playback; no separate slow reading was generated and no listening review was faked.

The [production and offline verification tool](../../scripts/speech-review-bc.py) checks the cache by text, version and config; it recomputes the manifest and costs inside an exclusive lock and does not automatically retry failed or unknown results. Existing files and historical reuse sources all pass the offline check, which makes no network calls. Formal content validation includes a separate B+C gate, so review cannot be bypassed just by changing candidate status fields.

The candy-shop introduction is served as a full local recording through `/api/attempts/{attempt_id}/introduction/audio` after session-ownership validation; playback is refused when the file does not match the text/romanization/version/SHA256. The returned status does not expose the hidden flavor; successful playback handling (providing the audio) is kept separate from actual playback completion; a frontend playback failure is not marked as listened, and only explicit text help reveals the introduction and records the help event.

Engineering checks cover raw ASR retrieval, single consumption, cancelled/duplicate/late requests, 12-second frontend recovery, same-question target changes and isolation of stale transcripts. Real desktop Chrome, in an isolated environment with the live speech service turned off, completed all four stations via technical-unavailable assistance and played local 1×/0.75× audio; synthetic records of recognition correct/incorrect are used only for automated tests, and no synthetic ASR was injected into the browser. These results are not equivalent to passing real human microphone, real ASR, physical phone, Safari or teaching-pronunciation listening review.

## Revision 4: full order confirmation audio

The [separate confirmation content](../../content/nanxiang-confirmations-r4.json) contains six full sentences for one/two/three servings × dine-in/takeaway, reusing existing candidate wording and romanization, all kept pending. Playback is matched from the current normalized saved order, and display, autoplay and manual playback are consistent; after the order is changed, the old sentence is not reused. The original R3 base content and rules are unchanged, the new assets are versioned separately, and existing R3 progress does not need to be reset.

Six live Beijing `qwen3-tts-flash` + Jada calls were made with no retry; input text totaled 84 characters, provider-metered 150 characters, estimated at ¥0.012 using the existing list rate; billing was not queried. The execution cap was six calls with an estimated budget of ¥1, and there were no ASR/LLM/user recording calls. The six full-sentence WAVs total 15.6 seconds and are located in `frontend/public/audio/review-r4/`; the [manifest](../../content/audio-review-r4.json) is entirely pending. Slow speed is the same file at pitch-preserving 0.75×; no separate slow reading was produced.

`scripts/speech-review-r4.py plan/check` performs offline checks only; after generation the plan shows zero pending calls; `generate` requires the frozen input digest and an explicit call flag, strictly limits budget and count, and does not retry automatically. `npm run check` already includes the R4 audio audit, and both development and formal content validation cover the separate supplementary pack, so unreviewed confirmation sentences are not missed once the base teaching material is approved in the future. Full operations and browser evidence are in [revision 4 acceptance](../archive/batches/Batch-A-revision-4-acceptance.md).

## Revision 2: free-ordering rewrite and slow playback

Content `batch-a-r2.2026-10-17.v1` was frozen first, then the necessary sample audio was produced per the user-authorized revision. Of the 20 entries, 17 reuse R1 original audio; NX-N05 has the same text as the old N02 and NX-N06 the same as the old N03, and the manifest records the source and current version without copying the old files. Three new entries were added, NX-N04 「侬讲个是只，还是份？」 ("Do you mean pieces or servings?"), NX-N09 「对伐？」 ("Right?") and NX-N10 「好个。」 ("OK."), so that old lines no longer require a fixed two servings to take away.

Actually **3 Beijing `qwen3-tts-flash` + Jada TTS calls, no retry**; the API returned `usage.characters` totaling **28**. At the [official Beijing list price](https://help.aliyun.com/zh/model-studio/qwen3-tts-flash) of 0.8 yuan per 10,000 characters, the estimate is **¥0.00224**; billing and free quota were not queried. No new ASR/LLM requests were made and no microphone was used. New files are in `frontend/public/audio/review-r2/` and all remain pending; the R1 manifest and source content snapshot are kept for old sessions and historical verification.

The production tool fixes the three new sentences, at most three requests and a ¥1 cap, and checks the frozen hash; before reuse it verifies WAV/hash/source text, and does not automatically retry unknown results. 14 tool tests use a mocked provider. After generation the offline `check` passed for 20 entries, and `plan` shows zero new requests and zero new cost:

```sh
backend/.venv/bin/python scripts/speech-review-r2.py check
backend/.venv/bin/python scripts/speech-review-r2.py plan
npm run audio:check
```

`audio:check` verifies both historical R1 and current R2. Frontend slow speed only changes the playback rate of the existing file to 0.75× with pitch preservation; it does not call TTS again, does not generate fake separate slow files, and does not mark the slowed playback as reviewed. The normal/slow preference is saved locally. Auto end-of-recording → ASR → submitting the raw transcript, and cancel/late isolation, are covered by media and event-handling mock regressions; this round does not claim successful real human browser recording; specific evidence is in [revision 2 acceptance](../archive/batches/Batch-A-revision-2-acceptance.md).

## Official contracts and initial configuration

Revision 3's current practice uses the fixed target check `guided-target-check.v1`, which only checks the expression selected for this question against the raw ASR transcript, does not call a free-semantics LLM, and does not modify the original text. After the evaluation result is saved, the flow stays put, and the order is applied only on explicit continue; incorrect results, no transcript and technical errors are saved separately. The provider contracts for the earlier R1/R2 free input are kept for historical versions. R3 made no new live ASR/TTS/LLM requests; audio reuse is validated by source text, entry version and bytes.

| Service | Initial configuration | Request and result |
| --- | --- | --- |
| ASR | `qwen3-asr-flash` | OpenAI compatible `POST /compatible-mode/v1/chat/completions`; `messages` carries an `input_audio.data` Data URL, `stream:false`, `asr_options.enable_itn:false`; reads the raw transcript from `choices[0].message.content` |
| Understanding | `qwen-plus`, non-thinking mode | Same path, `response_format` explicitly `json_object`; the returned JSON is validated server-side, with at most one structural-repair retry, sharing an 8-second total budget |
| TTS | `qwen3-tts-flash` + `Jada` | `POST /api/v1/services/aigc/multimodal-generation/generation`; `input.text/voice/language_type`; reads `output.audio.url`, immediately downloads it to a local asset, and leaves no temporary link in the manifest |

Official ASR documentation and examples are in [Qwen-ASR API](https://help.aliyun.com/en/model-studio/qwen-asr-api-reference). `zh` is the API's Chinese language parameter and must not be taken as having identified Shanghainese; the UI language is not automatically passed as a recognition hint. When confidence is not provided, it is kept as `null`.

TTS uses the [Qwen-TTS HTTP contract](https://help.aliyun.com/zh/model-studio/qwen-tts-api) and the [official Jada non-realtime voice list](https://help.aliyun.com/en/model-studio/qwen-tts-voice-list). The internal target language is recorded as `wuu`, the provider parameter is `Chinese`, and the voice must be `Jada`; this parameter mapping does not prove Shanghainese quality. After download, two-person listening review is required; wrong or unnatural readings must not be replaced with Mandarin. The returned temporary URL has a limited validity period and must not become the app's long-term asset address.

The [official structured output documentation](https://www.alibabacloud.com/help/en/model-studio/qwen-structured-output) distinguishes JSON Object from JSON Schema; the support table consulted on 2026-10-17 lists strict Schema only for specified model families. The current `qwen-plus` defaults to JSON Object, and the mode is recorded truthfully. Once the actual account selects a supported Plus deployment, `QWEN_LLM_JSON_MODE=json_schema` can be set explicitly, still with server-side validation; the model is not silently switched and the output mode is not silently downgraded. Neither mode can decide task completion.

## Server-only configuration

The following variables never reach the browser; the read-only config output only shows whether credentials are configured, and never returns keys or endpoints. By default there is no call permission; adding a key alone does not enable the API.

| Variable | Default/purpose |
| --- | --- |
| `SPEECH_ENABLE_LIVE` | `false`; only an explicit `true` allows live service calls |
| `QWEN_ASR_ENABLE_LIVE` / `QWEN_TTS_ENABLE_LIVE` / `QWEN_LLM_ENABLE_LIVE` | Can individually override the master switch |
| `DASHSCOPE_API_KEY` | Server-side shared credential; no default |
| `QWEN_ASR_API_KEY` / `QWEN_TTS_API_KEY` / `QWEN_LLM_API_KEY` | Can individually override the shared credential, for accounts in different regions |
| `QWEN_ASR_REGION` / `QWEN_TTS_REGION` / `QWEN_LLM_REGION` | `beijing`; `singapore` is also supported, and must match that region's key and available models |
| `QWEN_ASR_ENDPOINT` / `QWEN_TTS_ENDPOINT` / `QWEN_LLM_ENDPOINT` | Defaults to the official domain origin for the region; can be changed to an official workspace-specific domain, without API path, query parameters or auth info |
| `QWEN_ASR_MODEL` / `QWEN_TTS_MODEL` / `QWEN_LLM_MODEL` | The initial models in the table above; switching requires a new config and re-verification |
| `QWEN_LLM_JSON_MODE` | `json_object` or explicit `json_schema` |

ASR, TTS and LLM each keep their own model, region, deployment method, adapter version, config ID and latency budget. The config ID changes with model/endpoint/parameters, not with the key. Underlying versions not disclosed by the provider are `null`. Hosted names do not pose as Qwen3-ASR-1.7B or CosyVoice open checkpoints.

## Backend usage conventions

- `ASRProvider.transcribe(ASRRequest)` returns `ASRResult`: raw transcript, status, latency, config ID, upstream request ID, returned model, and nullable language/confidence. Input bytes must come from a session upload authorized by the backend; arbitrary remote URLs are not accepted; private uploads and session permissions are enforced by the API layer.
- `SemanticProvider.interpret(text, context)` returns `Interpretation`: intent, field changes, per-field evidence, uncertainties and help signals. Batch A only accepts evidence spans that actually exist in this turn's original text; fields inferred only from context must not be filled. Model results must still pass the task engine's business validation.
- `TTSProvider.synthesize(TTSRequest)` returns the downloaded audio bytes and source metadata; `produce_audio` saves them as a project asset and generates a manifest. TTS is used only for offline production; the app never calls the synthesis API at runtime.
- Stable errors use `ProviderError.code/retryable`; the API layer gives Chinese/English hints to retry, switch to text, or use buttons. Raw service error bodies, keys and signed URLs never enter error messages.
- ASR total budget 12 seconds, understanding total budget 8 seconds, TTS production including download total budget 30 seconds. HTTP timeout/rate-limit/service-unavailable map to stable categories; ASR/TTS do not retry automatically and do not switch providers. Understanding makes only one limited retry for non-conforming JSON, and does not repeat billable requests on auth/network failures.
- Frontend cancellation and late results that must not change state are controlled by the session/request layer; adapters keep async cancellation semantics and do not convert cancellation exceptions into success.

Current audio validation actually decodes **PCM16 WAV** (mono/stereo, 8–48 kHz), max 3 MiB, 20 seconds; empty files, fake extensions, truncated data and overlong files are rejected. WebM, AAC and other formats return `unsupported_format`; MIME types or user-supplied durations are not trusted on their own. The frontend already decodes the browser recording locally and converts it to mono 16 kHz PCM16 WAV before upload; the server only accepts the converted strict format. Browser format support, decoding and the full recording pipeline still require real-device verification; this batch does not claim a complete cross-browser real recording pipeline.

## Executable checks and manual live smoke

From the repository root, in an environment with backend dependencies installed, run:

```sh
backend/.venv/bin/python scripts/speech.py config
backend/.venv/bin/python scripts/speech.py tts-check --text-id E08
PYTHONPATH=backend backend/.venv/bin/python -m pytest backend/tests/test_providers.py -q
```

`config` only reads locally; `tts-check` only checks the content pack and review records. E08 is not yet language-approved, so the expected result is `language_review_required` with exit code 2; no network request is sent and no audio is generated.

The following are entry points for later manual re-verification. The method and results of the real small-amount diagnostics are recorded separately at the end of this document; running these entry points still requires the corresponding credentials and enable switches on the server, and the commands also require `--allow-paid-call` to prevent a config check from accidentally turning into a paid trial run.

```sh
backend/.venv/bin/python scripts/speech.py asr-smoke --audio /absolute/path/to/private-sample.wav --allow-paid-call
backend/.venv/bin/python scripts/speech.py llm-smoke --allow-paid-call
backend/.venv/bin/python scripts/speech.py tts-generate --text-id E08 --speed normal --allow-paid-call
```

ASR smoke by default only outputs the transcript character count, request identifier and latency; the original text is shown only with explicit `--show-transcript`; the original recording is not copied into Git. Real results should be manually checked for key semantics such as quantity, negation and modification, with the actual region/model/cost and anomalies recorded, before moving on to later batch acceptance.

## Language review and generated assets

The CLI takes `hanzi` only from content packs in the repository's `content/`, and has no arbitrary-text parameter. Expressions, clerk lines and support words are all looked up by ID/version; the source is `content/batch-a.json`, and the review ledger is `content/reviews.json`.

The official production entry point `tts-generate` requires: approved language status; at least two different real reviewers marked as fluent speakers; approval records bound to the same content ID/version; citing the approval records; `subjectSha256` matching the current original text/gloss/segmentation/variants; and no later unresolved change requests. Even if the version number is not bumped, changing the text invalidates the old approval. This entry point rejects candidates or empty original text; the separate pending-draft entry point follows the new authorization in the next section. Reviewer identities and conclusions must be filled in by real reviewers; mock reviewers in tests exist only inside unit tests.

Generated results are saved as `artifacts/audio/<generationId>.wav` plus a JSON file of the same name, with directory/file access restricted to local. The generation ID is computed from the text, version, model config, voice config and speed together; when the same task already exists, it is not overwritten and not called again; the same generation task uses an exclusive lock to prevent concurrent duplicate billing. An unexpected process exit may leave a lock behind; it must be cleaned up manually after checking the actual assets, and billing must not be retried automatically. The manifest records SHA256, measured duration/sample rate, target language, actual provider parameters, model/voice, source-text check, generation time and language-review references; new audio is always `status:pending`, `listeningReview:pending`, `reviewIds:[]`.

Batch A's `qwen3-tts-flash` adapter does not claim to support a slow-speed instruction; `--speed slow` returns `unsupported_speed`. Later, pitch-preserving processing with explicitly recorded parameters, or a verified model capability, can be added, with separate listening review for slow speed. Normal-speed files must not be saved again to fake slow-speed assets.

Only after listening review passes are the corresponding assets imported into the formal content pack, maintaining file paths, SHA256, listening-review records and release review; the production CLI does not automatically change teaching-material approval status. Revision 1's public static pending audio has its own separate manifest and does not enter the formal `audioClips` approval chain.

## Revision 1: generated normal-speed pending audio

On 2026-10-17 18:33–18:34 UTC, under the user-authorized revision 1, one generation was run for each of the 20 original texts in frozen version `batch-a-r1.2026-10-17.v1`: three learning expressions, twelve turn-by-turn lines, and five quantity/dine-in/item support words. The model was Beijing-region `qwen3-tts-flash`, voice `Jada`, parameter `language_type=Chinese`, internal target language `wuu`; each call sent one full sentence, with no Latin romanization sent and no concatenated phrase audio. The official docs list [Jada's Shanghainese capability](https://help.aliyun.com/en/model-studio/qwen-tts-voice-list), but the specific readings still require listening review.

In total **20 TTS requests, no retry**; the API returned `usage.characters` totaling **260**. At the [official Beijing list price](https://help.aliyun.com/zh/model-studio/qwen3-tts-flash) of 0.8 yuan per 10,000 characters, the estimate is **0.0208 yuan**, below this round's 1-yuan budget. Account billing, free quota and discounts were not queried; this figure is an estimate. The original texts' Python string lengths total 141, which does not equal the API-returned metering; later cost reservations use the more conservative UTF-8 byte count, completed requests are accumulated by API usage, and failed requests with unknown results also reserve budget.

20 PCM16 WAVs were actually saved, all 24 kHz mono, total length **29,840 ms**. The assets are in `frontend/public/audio/review-r1/<generationId>.wav`, and the [separate manifest](../../content/audio-review-r1.json) stores each sentence's original text, version, config, SHA256, duration, time, request ID, usage and cost estimate. The provider's WAV placeholder length header is finalized according to a verified rule, with PCM samples unchanged; no speed change, Mandarin substitution or extra paid retry was done. Downloads are only used to save user-authorized app assets; the provider's [temporary URL is valid for 24 hours](https://help.aliyun.com/zh/model-studio/qwen-tts-api), and neither the manifest nor the frontend depends on these addresses.

All entries remain `status:generated`, `reviewStatus:pending`, `reviewIds:[]`. The 28 audio entries in the formal content pack and the review ledger keep their original pending status; the frontend allows playback only when `text` and `textVersion` exactly match the current content, so old audio cannot be bound to new text. The offline check after the first generation verified the completeness of the 20 entries, original-text/romanization versions, generation config, paths, WAV, SHA256, duration, and that production approval status was unchanged.

```sh
# Read-only, no network calls: check existing deliverables and whether the next round needs requests.
backend/.venv/bin/python scripts/speech-review.py check
backend/.venv/bin/python scripts/speech-review.py plan

# Run only after new source text is frozen and the user authorizes production; take the hash from that plan run.
backend/.venv/bin/python scripts/speech-review.py generate --expect-input-sha256 <hash-from-plan> --allow-paid-call
```

The current `plan` is **0 new requests, 0 new cost**; the cache is identified by text and generation config, so audio for the same original text can be reused when romanization or version is revised separately. Existing assets must pass SHA/WAV verification; damaged, failed or unknown-result requests stop and require inspection, and are never silently charged again. The batch lock re-checks the frozen hash and budget, and rerunning a single entry keeps other still-matching manifest entries. This entry point only opens TTS permission within the current process and does not change `.env` or the app's live-call switches; the private cache and English diagnostics remain in a Git-ignored directory.

Changes and slow-speed versions will be handled after the user reviews the normal-speed original text, romanization and audio; currently no slow-speed files have been generated, and no normal-speed playback-rate change is passed off as reviewed slow speed. The formal two-person language/listening review and release gates remain in place. New tests use explicit mock provider/transport, covering isolation between the pending-draft and formal gates, checkpoint reuse, no duplicate billing on failure, saving 20-entry and subset manifests, tamper rejection, and cost reservation; **35 provider tests pass**, and tests make no paid requests.

### E08 synthetic sample recognition and voice-turn regression

The user then explicitly authorized "允许这 1 次合成音频测试" ("allow this 1 synthetic audio test"), with the scope E08 「我要两份小笼馒头」 → the configured Alibaba Cloud Beijing Qwen ASR → an isolated test session, cost cap 1 yuan, no microphone. An earlier automatic-approval block produced no call; after approval, **1 ASR call, 0 LLM, 0 TTS, no retry** was actually executed at **2026-10-17 18:40:39–18:40:40 UTC**.

The input was the 1,600 ms synthetic WAV of the above `E08.normal`, SHA256 `a3df57475feadfd7dc19689358ebe596da926b2abe19a2ed720986697e109846`. It was submitted to `/api/asr` via a separate cookie session on the isolated backend `127.0.0.1:8001`, returning HTTP 200, `qwen3-asr-flash`, raw transcript **「我要两份小笼馒头。」**, service latency **1,699 ms**, `language:zh`, `confidence:null`; the upstream request ID is `chatcmpl-9d684e92-a49f-92d7-9f1c-3c5c2aaa929b` and the config ID is `asr-4c784f1651e2840a`. `zh` does not constitute identification of Shanghainese. The current ASR response structure does not keep provider usage, so only the request count and measured input duration are recorded here; billed seconds, token usage or actual charges are not fabricated; account billing was not queried.

Recognition itself did not create an attempt or advance the order. A new Nanxiang attempt was then created, and the raw transcript was submitted unchanged via `channel:voice` with the same `asr_request_id`; `development-parser.v2` returned `item:xiaolongbao`, `quantity:2`, `unit:serving`, `normalized_servings:2`, **`takeaway:null`**. The order stayed `collecting` and followed up with `NX-N03`, without auto-filling takeaway, confirming or completing; the saved `asr_transcript` and `text` both keep the original sentence. This had no browser recording or `recording_started` event, so `voice_attempts:0` is expected, and no real human voice attempt is faked. Redacted results are in the Git-ignored `artifacts/local/r1-synthetic-asr/`, and the cookie existed only in the requesting process's memory.

This item only proves that one **TTS synthetic sample** successfully linked live ASR with a development-parser turn; it cannot replace real human/beginner recordings, the browser microphone pipeline, Shanghainese pronunciation quality, or full station acceptance.

## Verification record for this batch

- In the initial implementation phase, only whether credentials were configured was checked; none were set at the time, so only mock tests were run. The user then filled in a shared key and authorized live diagnostics; current status and call records are in the next section, and key values were not output.
- All provider tests explicitly use `httpx.MockTransport`: request contract, raw transcript preservation, no secrets echoed back, rate-limit/auth/timeout, limited retry on bad JSON, audio decoding constraints, two-person review rejection, temporary URL download and SHA256, default pending listening review, and duplicate-generation protection.
- The formal production eligibility check still correctly rejects unapproved candidates; revision 1 separately generated the 20 pending audio entries above, awaiting real review.
- Still to verify: Jada's Shanghainese naturalness, reliability of key fields for real Shanghainese/beginner recordings, cost/latency across more scenarios and devices, normal/slow-speed two-person listening review, and the full real-voice Nanxiang pipeline.


## Live technical diagnostics after user authorization (2026-10-17)

Run time was America/New_York 13:51–13:53. Only the relevant config in the root `.env` was read; credential values were not output and the keys in it were not modified. Live calls were enabled only inside the diagnostic process; the master switch in the root `.env` remained `false`. Diagnostic scripts, budget, original/repaired audio and per-call redacted results are kept in the Git-ignored `artifacts/local/speech-diagnostics/`; these files are not teaching material, do not enter the content pack, and have no language or listening-review approval. The CLI now also reads the root `.env`, with variables already set in the environment taking precedence.

The budget used the official Beijing-region list prices, without assuming any free quota: Qwen-Plus non-thinking short input at 0.8 yuan per million input tokens and 2 yuan per million output tokens; ASR at 0.00022 yuan per second; TTS at 0.8 yuan per 10,000 input characters. The conservative up-front budget was below 0.10 yuan, and no resources were purchased or deployed. [Qwen-Plus pricing](https://help.aliyun.com/zh/model-studio/qwen-plus), [ASR pricing](https://help.aliyun.com/zh/model-studio/qwen3-asr-flash), [TTS pricing](https://help.aliyun.com/zh/model-studio/qwen3-tts-flash).

| Call | Actual result | Service latency | Upstream request ID | API-returned usage |
| --- | --- | --- | --- | --- |
| Qwen-Plus full sentence `Two servings to take away, please.` | quantity=2, unit=serving, takeaway=true, with complete source-text evidence | 3544 ms | `chatcmpl-b60fa81f-7fef-9c40-abcf-d6c0ced51c90` | Input 344 / output 113 tokens |
| Qwen-Plus missing-field sentence `Two, please.` | Returned only quantity=2, without inventing unit or takeaway | 2007 ms | `chatcmpl-e95be17f-646f-910f-8c15-f3e379f20b09` | Input 340 / output 43 tokens |
| Qwen-Plus modification sentence, before fix | `Not three. Two servings, and not takeaway.` returned quantity=2, takeaway=false, missing the unit explicitly said in this turn; **does not meet the original acceptance expectation** | 2878 ms | `chatcmpl-47c72146-3891-90f5-8740-0d63611ccffb` | Input 364 / output 84 tokens |
| Same modification sentence, after fix | quantity=2, unit=serving, takeaway=false, all with evidence from this turn, meets the original expectation | 3437 ms | `chatcmpl-638fdeab-30ed-9210-aefd-19409b69e40f` | Input 400 / output 112 tokens |
| ASR synthetic English | macOS Samantha local synthesis, 2.229 seconds PCM16/16 kHz mono; returned the full original sentence `Two servings to take away, please.`, language=en, confidence=null | 2628 ms | `chatcmpl-6ba36622-8728-9946-958e-0a2054580fe7` | seconds=2, input 55 / output 15 tokens |
| Jada English `Hello.` first attempt | HTTP 200, download completed, but the placeholder WAV length triggered strict validation failure; no asset published | HTTP 1219 ms; including download 2573 ms | `1442b050-326a-93ef-b59f-e4eeaf88a7d7` | 6 characters |
| Same Jada diagnostic retry | HTTP 200, original file saved; after offline confirmation and WAV header repair, 560 ms, 24 kHz mono PCM16 | HTTP 1378 ms; including download 2638 ms | `98973fde-2b48-9deb-8de2-4a586132edc9` | 6 characters |

In total there were **7 model requests** (4 LLM, 1 ASR, 2 TTS); one other initially failed due to runtime network restrictions, received no upstream response, and is recorded separately as a connection failure. The four LLM calls totaled input 1448 / output 352 tokens, ASR returned seconds=2, and TTS totaled 12 characters. Based on the API-returned usage above and list prices, the estimate is about **0.0032624 yuan**, which is not the same as the billed charge; account billing and free quota were not read, and actual billing rounding is determined by the provider. The latencies above are only a few diagnostic observations and cannot be used to claim the product latency targets are met.

Fixes resulting from the live diagnostics:

1. Backend rules clear the old unit when the quantity is modified and the unit is missing, to avoid wrongly using the previous order. This rule is kept, and the model prompt was changed to: when a quantity appears, the unit explicitly said in this turn must also be extracted, even if it equals the old value; units not said must still not be inherited from the old order. The failure record is kept and the same sentence was rerun and passed, without relaxing the expectation.
2. The actual Jada file has a standard 44-byte PCM WAV header, but the RIFF/data lengths are the placeholder values `0x7fffffbf` / `0x7fffff9b`; the real file is only 26924 bytes. `finalize_generated_wav` was added, which finalizes only this observed set of provider placeholder headers according to the actual complete body, with PCM samples unchanged; ordinary uploads still undergo strict validation, and this fix does not cause truncated files to be accepted. The source and repaired SHA256 and the processing method are written into metadata. After offline repair, the real sample's SHA256 is `b9d3e3ada60288aa13f465bb8cb1c4b0f49819283461217de3067dbfb3d91423`.
3. The adapter version was bumped to `qwen-http-v2`, and the config ID changed accordingly. Sessions already started do not hot-switch config; the new config is used for new sessions. After adding the WAV placeholder header and truncation rejection cases, 31 provider tests passed; at that time the full backend suite of 75 passed, with live forcibly disabled in the test environment and no extra model requests.

Local handoff configuration: in the Beijing region, these three initial models returned successful responses for the current shared key; afterwards `QWEN_ASR_ENABLE_LIVE=true` was enabled separately in the user's local `.env`, the master switch is still false, and the example config stays off by default; text understanding still requires explicitly selecting `TEXT_INTERPRETER=qwen`, and configuring a key must not quietly replace the development parser. Language review of the current teaching material is still not complete, and the teaching TTS production gate keeps rejecting; the success of the English Jada diagnostic does not prove Shanghainese pronunciation is acceptable, nor does it verify normal/slow-speed teaching material. Full real Shanghainese corpus, phone recordings and complete task acceptance remain for later work.
