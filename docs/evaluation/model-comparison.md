# Shanghainese speech model comparison

Started 2026-11-07 (batch E, step 9). **Status: baseline frozen, candidates researched, evaluation tooling and recording plan ready. No model has been run on real speech in this round, and no result below is a quality measurement.** Results will be added only from saved, reproducible runs.

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

## 7. Budget (needs approval before any paid call)

| Service | Planned use | Estimate at list price | Proposed hard cap |
| --- | --- | --- | --- |
| `qwen3-asr-flash` | Pilot ~62 clips (2 speakers × 31) + formal ~120 clips, about 3 s each, one call per clip per run, plus at most one re-run after an audio-handling fix | ≤ 400 calls × ~3 s ≈ 20 min ≈ ¥0.27 | **400 calls, ¥2 total**, no automatic retries; billing to be checked afterwards |
| Local models | B, C, D and CosyVoice on this Mac | ¥0; ~19 GB downloads into the Hugging Face cache (`~/.cache/huggingface`) | Downloads only after approval |
| Hosted GPU inference | Only if a local model wins and should go to production | Not estimated yet | Separate written proposal; nothing bought |

Rule changes do not need new ASR calls: saved transcripts are re-scored offline.

## 8. Not done yet

- No real recordings, labels or listening ratings; no candidate model downloaded or run; no paid call in this round.
- Local inference wrappers for B, C, D are not written yet (they depend on the approved downloads).
- No production change. The [project report](https://docs.google.com/document/d/1EdI3IUBs7F1X_XHufFtIgYP4DChm3JsY8A4sL_nx6BQ/edit) has not been updated with results because there are none yet.
