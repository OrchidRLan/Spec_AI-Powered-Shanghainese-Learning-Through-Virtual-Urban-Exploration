# Shanghainese speech model comparison

Started 2026-11-07 (batch E, step 9). **Status: baseline frozen, candidates researched, evaluation tooling and recording plan ready; budget approved; B, C, D downloaded and wired through local servers (checked on synthetic clips only). First single-speaker pilot run on 2026-11-07, production baseline added 2026-11-09 (§9): one heritage speaker, labels not yet reviewed. It is a pilot, not the formal comparison, and supports no model selection on its own.** Results will be added only from saved, reproducible runs.

Related: [recording plan](recording-plan.md), [evaluation tooling](../engineering/ASR-evaluation.md), [speech integration](../engineering/Speech-integration.md), [scoring](../engineering/Scoring-system.md).

## 1. Frozen baseline

| Item | Value | How verified |
| --- | --- | --- |
| Source commit | `3b438ee8e97252f2b4c5fb60b8464332a1d4eb6b` | Local `main` = `origin/main`, clean tree; same commit in the live [deployment.json](https://spec-virtual-shanghainese-learning.vercel.app/deployment.json) (built 2026-10-20T21:17Z) |
| Production ASR | `qwen3-asr-flash`, Alibaba Cloud Model Studio, region `beijing`, adapter `qwen-http-v2`, config `asr-4c784f1651e2840a`, timeout 12 s, live enabled | Live `GET /api/services` through the app proxy, 2026-11-07 (non-secret fields only) |
| Production text mode | `development-parser.v3`; no LLM | Same response |
| Teaching TTS | `qwen3-tts-flash` + voice `Jada`, config `tts-7f9e533827ac529c`; files pre-generated, all `reviewStatus: pending` | Audio manifests in `content/` |
| Target-check rules | `guided-target-check.v1` (Nanxiang), `station-lessons.v1` (three stations), scoring `lenient-rules.v1`, parser `development-parser.v3` | Source constants; recorded in every evaluation run |
| CER normalization | `cer-norm.v1`: NFKC, lowercase, strip punctuation/space/symbols, traditional→simplified for characters used in current content. Wu vs Mandarin word choices (侬/你, 勿/不, 个/的) still count as errors | [evaluation.py](../../backend/app/evaluation.py) |
| Local machine | Apple M5 Pro, 18 cores, 48 GB RAM, ~646 GB free, no CUDA GPU; backend venv Python 3.11; no torch installed; no `.env` in this checkout (no paid calls possible from here without the key) | Local inspection |

The hosted `qwen3-asr-flash` is not the open-weight Qwen3-ASR-1.7B and is never reported as such. The provider does not publish an underlying model revision, so `model_revision` stays `null`.

## 2. Evidence so far

| Kind of evidence | Exists? | Notes |
| --- | --- | --- |
| Mocked provider tests | Yes | Request contracts, error mapping, metrics; no model quality |
| Rule-only checks on written text | Yes (this round) | Pilot prompt texts judged by current rules; see §6. Not ASR |
| Synthetic audio → real ASR | 1 call (2026-10-17) | E08 Jada clip → `qwen3-asr-flash` returned the full sentence. Synthetic, not human |
| Real human recordings | **No** | No recordings or labels found in this checkout (`private/` absent; earlier `artifacts/local/asr-eval` runs used only the synthetic example manifest with the `rules` provider, 0 paid calls) |
| Live microphone path | **No** | Not tested in a real browser or phone |
| Blind listening ratings | **No** | Jada clips are still pending review |

## 3. ASR candidates

| | A — product baseline | B — Wu-adapted | C — open-weight general | D — general Whisper |
| --- | --- | --- | --- | --- |
| Exact model | `qwen3-asr-flash` (hosted) | Whisper-Medium-Wu: `whisper/whisper-medium.pt` in [ASLP-lab/WenetSpeech-Wu-Speech-Understanding](https://huggingface.co/ASLP-lab/WenetSpeech-Wu-Speech-Understanding) @ `cb53da7a` | [Qwen/Qwen3-ASR-1.7B](https://huggingface.co/Qwen/Qwen3-ASR-1.7B) @ `7278e1e7` | [openai/whisper-medium](https://huggingface.co/openai/whisper-medium) @ `abdf7c39` |
| Wu / Shanghainese support | Docs: automatic language detection; no dialect list, Shanghainese not named ([pricing page](https://help.aliyun.com/zh/model-studio/qwen3-asr-flash)) | Fine-tuned on WenetSpeech-Wu (~8,000 h, 8 Wu sub-dialects incl. Shanghainese) | Model card lists "Wu language" among 22 dialects; no Wu-specific score, Shanghainese not named | None claimed |
| Published Wu result | Not reported | CER 14.19 / 11.09 / 14.33 (Dialogue / Reading / WS-Wu-Bench) | Paper row "Qwen3-ASR": 23.96 / 24.13 / 29.31 (API vs open weights not stated) | 79.31 / 83.94 / 78.24 |
| License | Commercial API | Apache-2.0 (HF repo tag) | Apache-2.0 | Apache-2.0 |
| How it runs | Existing adapter | WeNet `recognize.py` (not transformers); needs a WeNet checkout and a small local wrapper behind `openai_compatible` | `pip install qwen-asr`, transformers backend (vLLM server is CUDA-oriented); local wrapper behind `openai_compatible` | transformers; local wrapper |
| Download | — | 3.27 GB | 4.70 GB | 3.06 GB (safetensors only) |
| Runs on this Mac? | Yes, needs the server key | Expected yes on CPU (WeNet supports CPU); unverified | Expected yes on CPU/MPS in bf16/fp32; unverified | Expected yes |
| Cost | ¥0.00022 per audio second, Beijing list price, billed per second, promotions excluded | Free locally | Free locally | Free locally |
| Production path | Already live | Needs a hosted inference service (Render 0.5 CPU / 512 MB cannot hold it) | Same | Same |
| Priority | Required | High | High | Low: published Wu CER ~78%; kept because the proposal includes it, run last and dropped if time runs out |

Published numbers come from [WenetSpeech-Wu (arXiv 2601.11027)](https://arxiv.org/abs/2601.11027); its benchmark mixes Shanghainese, Suzhounese and Mandarin code-mixing and does not report Shanghainese separately, and it gives no CER normalization rules. They are context only and will not be compared with our numbers.

Not prioritized: Step-Audio2-Wu-ASR (best paper CER, 12.85) is a LoRA on Step-Audio-2-mini, run through ms-swift with CUDA-oriented tooling; Conformer-U2pp-Wu is close to Whisper-Medium-Wu. Either can be added only if B and C both fail.

## 4. TTS candidates (after ASR)

| | Current | Wu-adapted | General base (only if needed) |
| --- | --- | --- | --- |
| Model | `qwen3-tts-flash` + Jada (existing files, no new calls) | CosyVoice2-Wu-SFT: `CosyVoice2-Wu-SFT/SFT.pt` (renamed `llm.pt`) on CosyVoice2 base, [ASLP-lab/WenetSpeech-Wu-Speech-Generation](https://huggingface.co/ASLP-lab/WenetSpeech-Wu-Speech-Generation) @ `9924891e` | [FunAudioLLM/CosyVoice2-0.5B](https://huggingface.co/FunAudioLLM/CosyVoice2-0.5B) @ `eec1ae6c` |
| Input | Text + `language_type=Chinese`, voice Jada | `<|wuyu|>` + text, **zero-shot** with a 16 kHz prompt WAV and its transcript | `inference_instruct2` with instruction "用上海话说这句话" + prompt WAV |
| Paper result (WS-Wu-Eval-TTS easy / hard CER) | Qwen3-TTS row: 5.95 / 16.45 | 6.19 / 25.00 | 10.33 / 82.49 |
| Download | — | `CosyVoice2/` (~5.6 GB) + `SFT.pt` (2.02 GB) | Included in the Wu repo's `CosyVoice2/` folder |
| Needs | — | A consented Shanghainese prompt recording (5–10 s) and its transcript | Same |

The SFT and instruct inputs differ (zero-shot prompt vs instruction), so a comparison is a practical engineering comparison, not an ablation. TTS work starts only after the ASR comparison, on 12–20 key sentences, with blind ratings from at least two fluent reviewers (see [recording plan §5](recording-plan.md#5-tts-blind-listening)).

## 5. Selection criteria (fixed before any formal run)

Compared on the same frozen held-out (`test`) items, paired per item, reported as differences with n/N:

1. **No new false accepts.** The candidate may not pass any `incorrect` item that the baseline rejected; key-field false accepts (negation, quantity, item, dining mode, final confirmation) must stay at 0 new. A 0/N result is reported as "none observed in N", never as a zero error rate.
2. **Fewer false rejects.** At least 2 fewer false rejects in absolute terms, with the flipped items listed.
3. **Technical failures not worse** than the baseline (count and reasons).
4. **Latency** in the configuration that would be deployed: median ≤ 3 s and p95 ≤ 8 s (the ASR budget is 12 s). Local-machine latency is reported as such and does not stand in for production latency.
5. **Cost and deployment:** must fit a separately approved budget. If no approved hosting exists, the result is "measured candidate, production not switched".

If a candidate fails any of 1–3, the baseline stays. Changes are reported in three configurations so gains can be attributed: original model + original rules, new model + original rules, new model + improved rules. Rule tuning uses only `dev` items. Prompts or vocabulary hints, if any, are recorded and held fixed across compared runs.

## 6. Rule-only check of the pilot prompts (not ASR)

The 29 spoken pilot texts were judged by the current rules as if transcribed perfectly. 28 match their intended labels. One mismatch: `NX-QTY-SELF` 「三份……勿对，两份」 (self-correction meaning two) is rejected as `ambiguous_expression`, because the guided check rejects any utterance containing a negation word. This is the conservative boundary written into `guided.py`, so it is a **candidate** rule-level false reject, pending the reviewer's real label and real recordings. Rules were not changed.

## 7. Budget (approved 2026-11-07)

| Service | Planned use | Estimate at list price | Proposed hard cap |
| --- | --- | --- | --- |
| `qwen3-asr-flash` | Pilot ~62 clips (2 speakers × 31) + formal ~120 clips, about 3 s each, one call per clip per run, plus at most one re-run after an audio-handling fix | ≤ 400 calls × ~3 s ≈ 20 min ≈ ¥0.27 | **400 calls, ¥2 total**, no automatic retries; billing to be checked afterwards |
| Local models | B, C, D and CosyVoice on this Mac | ¥0; ~19 GB downloads into the Hugging Face cache (`~/.cache/huggingface`) | Downloads only after approval |
| Hosted GPU inference | Only if a local model wins and should go to production | Not estimated yet | Separate written proposal; nothing bought |

Both rows were approved by the project owner on 2026-11-07: up to **400 `qwen3-asr-flash` calls with a ¥2 hard cap** (no automatic retries; `asr-eval.py --max-calls` enforces the count), and the ~19 GB download. The approval covers this evaluation only; hosted GPU still needs its own proposal. Paid calls also need the server key, which is not in this checkout, and they wait for real recordings: none are spent on synthetic clips.

Rule changes do not need new ASR calls: saved transcripts are re-scored offline.

## 8. Local inference setup (2026-11-07)

Weights are in the Hugging Face cache at the revisions in §3–4 (17 GB on disk; the CosyVoice files are downloaded but not run yet). [local-asr-server.py](../../scripts/local-asr-server.py) serves one candidate on `127.0.0.1` behind `POST /v1/audio/transcriptions`, so `asr-eval.py --provider openai_compatible` scores it with the same rules, metrics and run records as the baseline. It loads only from the local cache, refuses a request whose `model` differs from the loaded one, and returns the pinned revision with every result.

| Candidate | Environment | Fixed configuration |
| --- | --- | --- |
| C `qwen3-asr-1.7b` | `~/.venvs/spec-speech-asr` (Python 3.11, torch 2.15, transformers 4.57.6, `qwen-asr` 0.0.6); Apple MPS, bf16 | Language auto-detected (`language=None`), no context prompt, greedy, max 256 new tokens |
| D `whisper-medium` | Same | `language=zh`, task transcribe, greedy. With auto-detection the synthetic clips were labelled Turkish or Japanese, so auto-detection is not a usable configuration |
| B `whisper-medium-wu` | `~/.venvs/spec-speech-wenet` (torch 2.5.1; current WeNet does not import under torch 2.15) + WeNet checkout `be6ad97f`; CPU | WeNet test-time dataset settings, language token `zh`, beam 10, CTC and reverse weights 0, mode `attention_rescoring`. Plain `attention` beam search repeated whole sentences on the synthetic clips with this checkpoint, so it is not used |

Safety: the WeNet checkpoint is a pickle file. It is loaded with `torch.load(weights_only=True)` (tensors only, 951 entries) and a strict key and shape check, never through WeNet's own loader, which unpickles arbitrary objects under torch 2.5. The other two models use safetensors.

Commands (one server at a time; ports are arbitrary):

```bash
~/.venvs/spec-speech-asr/bin/python scripts/local-asr-server.py qwen3-asr-1.7b --port 8011
~/.venvs/spec-speech-asr/bin/python scripts/local-asr-server.py whisper-medium --language zh --port 8012
~/.venvs/spec-speech-wenet/bin/python scripts/local-asr-server.py whisper-medium-wu --wenet-dir ~/.venvs/src/wenet --port 8013
LOCAL_ASR_ENDPOINT=http://127.0.0.1:8011 LOCAL_ASR_MODEL=qwen3-asr-1.7b LOCAL_ASR_ENABLE_LIVE=true LOCAL_ASR_TIMEOUT_SECONDS=120 \
  backend/.venv/bin/python scripts/asr-eval.py MANIFEST --provider openai_compatible
```

**Wiring check (synthetic, not evidence).** `asr-eval-prepare.py synthetic` pairs 20 plan prompts with existing Jada TTS clips of the same text (reference = TTS input, label = the plan's intended label, neither reviewed; `draft: true`). All three servers returned a transcript for 20/20 clips with 0 technical failures and 0 paid calls; runs are saved under `artifacts/local/asr-eval/`. The check found and fixed three integration problems (D's language setting, B's decoding mode, B's environment) and is the only reason those configurations are fixed now, before any real recording. One synthetic voice says nothing about learners' speech, so these outputs are not compared, ranked or reported as accuracy. B sometimes emits a `�` replacement character where a byte-level token is cut off; that is the model's raw output and is scored as is. Latency there is this Mac's local latency (C on MPS, B on CPU) and does not stand in for production latency.

## 9. Pilot 1 — one speaker, unreviewed labels (2026-11-07)

**What it is.** Speaker `S01` (heritage group; a project author), 31 plan prompts, one take each, MacBook built-in microphone in a quiet room, recorded with [record-session.py](../../scripts/record-session.py) using the app's microphone settings. `reference` is what the speaker typed as actually said (not reviewed); `label` is the plan's intended label, copied into a separate provisional sheet; nobody has reviewed either. Draft manifest `pilot-v1.S01-provisional` (SHA256 `5fad9d1b…`), split `dev`, code `900efa5` clean, each model warmed with one synthetic clip first. Recordings, sheets and per-item transcripts stay in `private/`.

| | A `qwen3-asr-flash` (production) | B Whisper-Medium-Wu | C Qwen3-ASR-1.7B | D whisper-medium (`zh`) |
| --- | --- | --- | --- | --- |
| Clips / technical failures | 31 / 0 | 31 / 0 | 31 / 0 | 31 / 0 |
| False rejects (of 18 acceptable/understandable) | 10 | 3 | 6 | 16 |
| False accepts (of 13 incorrect, incl. silence and noise) | 0 | 0 | 0 | 0 |
| Of the false rejects, ASR error / rule error | 9 / 1 | 2 / 1 | 5 / 1 | 15 / 1 |
| Corpus CER / mean CER (29 spoken clips, `cer-norm.v1`) | 0.445 / 0.524 | 0.141 / 0.162 | 0.398 / 0.507 | 0.828 / 0.823 |
| Latency median / p95 (ms) | 1788 / 2048 (hosted, Beijing, includes network) | 324 / 563 | 226 / 376 | 321 / 393 |
| Paired with A: items A rejected that this one passed / items A passed that this one rejected | — | 7 / 0 | 5 / 1 | 1 / 7 |

Local latency is on this Mac with warm models; A's latency includes upload and network from this Mac in the US to Beijing, so the two are not comparable.

A was run on 2026-11-09 with configuration `asr-4c784f1651e2840a` (verified identical to production) after the project owner added a server key to the local `.env`: 32 paid calls in total (1 key check + 31 clips), 85.5 s of audio, about ¥0.019 at list price, within the approved 400-call / ¥2 cap (368 calls left); billing still to be checked in the console. The §5 selection criteria apply to a reviewed `test` split, so this pilot cannot trigger a switch.

**Observations (to check on more speakers, not conclusions).**
- Against the production baseline, B passed 7 items that A rejected and rejected none that A passed; on this pilot that would satisfy §5 criteria 1–3 (no new false accept, at least 2 fewer false rejects, no more technical failures). C fixed 5 and added 1. With one unreviewed speaker this is a reason to prioritise B in the next round, not a selection.
- The ordering B < C < A < D in false rejects matches the published Wu results for B, C and D, but 18 acceptable items from one speaker cannot separate close systems reliably.
- No false accept was observed in 13 incorrect items for any model. That is "none observed in 13", not a zero rate.
- `NX-QTY-SELF` 「三份……勿对，两份」 is rejected for every model, and B transcribed it exactly: confirmed as a **rule-level** false reject (the guided check refuses any utterance with a negation word). This is the one `rule_error` in each column. Rules were not changed.
- Common ASR errors: homophones in the item, quantity and mode words (小笼→小龙, 两份→两温/两文, 堂吃→糖吃/党七); A and C also turned 三份 into "Seven"; C occasionally answers in English for short replies (对个 → "They are."); D often produces unrelated Mandarin or traditional-character text.
- Candidate rule changes for later, tuned on `dev` only and re-checked against incorrect items: accepting near-homophones such as 糖吃 for 堂吃 and 小龙 for 小笼, and allowing self-correction that ends in the target. None is applied.
- The silence and noise clips were nearly empty after the browser's noise suppression (as in the app), so they test hallucination on near-silence, not real background noise. Models still produced text on silence (A: "Thank you."; C: a book title; D: "谢谢观看"), which the rules then rejected.

**Before this counts as evidence:** a fluent reviewer confirms the 9 draft sentences, each `reference` and each `label`; at least 2–4 more speakers (fluent and beginner); then a frozen, speaker-disjoint `test` split run on all four systems.

## 10. Not done yet

- Only one speaker recorded; no reviewed labels or listening ratings; 32 of 400 approved paid calls used.
- CosyVoice2-Wu-SFT is downloaded but not set up; it also needs the consented prompt recording.
- No production change. The [project report](https://docs.google.com/document/d/1EdI3IUBs7F1X_XHufFtIgYP4DChm3JsY8A4sL_nx6BQ/edit) has not been updated with results because there are none yet.
