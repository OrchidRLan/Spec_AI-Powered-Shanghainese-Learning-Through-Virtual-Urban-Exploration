# Speech provider swap and offline evaluation

Updated 2026-11-07. Status: **implemented and merged to main, with mocked tests only. No real local model, paid call, acoustic model download, or human-labeled recording has been run.** Results from any provider are engineering measurements, not Shanghainese quality approval. The current comparison round (candidates, frozen baseline, selection rules, budget) is in [model comparison](../evaluation/model-comparison.md); recordings follow the [recording plan](../evaluation/recording-plan.md).

Code: [openai_compatible.py](../../backend/app/providers/openai_compatible.py) (ASR/TTS adapters + provider selection), [acoustic.py](../../backend/app/acoustic.py) (reference-audio similarity), [evaluation.py](../../backend/app/evaluation.py) (labels, metrics), [asr-eval.py](../../scripts/asr-eval.py) (CLI). Tests: [test_asr_swap.py](../../backend/tests/test_asr_swap.py).

## 1. Selecting the ASR provider

`ASR_PROVIDER` chooses the provider used by `POST /api/asr` and `GET /api/services`:

| Value | Provider | Notes |
| --- | --- | --- |
| `qwen` (default) | DashScope `qwen3-asr-flash` | Unchanged behavior and settings (`QWEN_ASR_*`) |
| `openai_compatible` | Any server implementing `POST /v1/audio/transcriptions` | For local or self-hosted models, e.g. vLLM, speaches / faster-whisper-server, LocalAI |

Settings for `openai_compatible` (see [.env.example](../../.env.example)):

| Variable | Meaning |
| --- | --- |
| `LOCAL_ASR_ENDPOINT` | Origin only, e.g. `http://127.0.0.1:8000`. Plain `http` is allowed only for `127.0.0.1`, `localhost`, `::1`, and never when `APP_ENV=production`; other hosts need `https` |
| `LOCAL_ASR_MODEL` | Required model name sent to the server |
| `LOCAL_ASR_LANGUAGE` | Optional language hint passed through unchanged |
| `LOCAL_ASR_API_KEY` | Optional bearer token; DashScope keys are never sent to this provider |
| `LOCAL_ASR_TIMEOUT_SECONDS` | 1–120, default 12 |
| `LOCAL_ASR_ENABLE_LIVE` | Must be `true`; off by default |

Guarantees:

- There is no automatic fallback between providers. A failure returns the usual retryable or terminal error.
- The audio contract is unchanged: WAV only, at most 3 MiB, no raw audio persisted.
- Each configuration has its own `config_id`, and sessions stay bound to the ASR configuration they started with. If you change the provider or model mid-session, `/api/asr` returns `409 configuration_changed`.
- `public_dict()` reports `provider: openai-compatible` and `deployment: local | self-hosted`. It never reports the endpoint or the key.
- The production backend (Render, 512 MB) cannot host these models. Local providers are for development and evaluation.

## 2. Offline comparison script

The script runs the same labeled items through one or more providers, applies the same scoring rules (`scoring.assess_lenient`), and reports false-reject and false-accept rates.

```bash
npm run asr:eval -- scripts/asr-eval.example.json
```

```bash
npm run asr:eval -- private/asr-eval/manifest.json --provider rules --provider openai_compatible
```

```bash
npm run asr:eval -- private/asr-eval/manifest.json --provider qwen --allow-paid-call --max-calls 20
```

| Provider | Input | Cost |
| --- | --- | --- |
| `rules` (default) | Each item's saved `transcript` | None; no network |
| `openai_compatible` | Each item's `audio` | Free on loopback; a non-loopback endpoint is treated as paid |
| `qwen` | Each item's `audio` | Paid: requires `--allow-paid-call`; stops at `--max-calls` (default 0) |

There is one attempt per item and no automatic retries. Full rows, including transcripts, go only to `artifacts/local/asr-eval/<UTC timestamp>-<random id>/results.json`, which Git ignores. The console prints metrics only, unless you pass `--show-transcripts`.

### Manifest format

See [asr-eval.example.json](../../scripts/asr-eval.example.json). That file is synthetic and its labels are illustrative, not native-speaker judgments.

```json
{"items": [{"id": "nx-qty-01", "station": "nanxiang", "step": "quantity",
  "target": {"type": "set_order", "quantity": 2, "unit": "serving"},
  "label": "acceptable", "reference": "两份", "audio": "recordings/nx-qty-01.wav"}]}
```

| Field | Meaning |
| --- | --- |
| `station`, `step`, `target` | Nanxiang: `item` / `quantity` / `mode` / `confirm` with the same target objects as `/practice`. Other stations: the lesson step and option ID, e.g. `teahouse` / `appreciation` / `good_tea` |
| `candy_flavor` | Candy only: the attempt's assigned flavor (defaults to the target on the flavor step) |
| `label` | Native-speaker judgment: `acceptable` and `understandable` should pass, `incorrect` should be asked to retry |
| `reference` | What the speaker **actually said**, reviewed by a fluent speaker — never the expected answer for a wrong utterance. Used for CER and judged by the same rules as "perfect ASR" for attribution |
| `audio` / `transcript` | Audio path relative to the manifest (keep recordings under the ignored `private/`), and/or a saved transcript for `rules` |
| `speaker_id`, `speaker_group` | Optional anonymous code (`S01`; names are rejected) and `fluent` / `heritage` / `beginner` / `synthetic` |
| `source`, `split` | Optional `human` / `synthetic` (must agree with the group) and `dev` / `test` |
| `condition` | Optional design category: `canonical`, `nonstandard`, `wrong_target`, `wrong_quantity`, `wrong_unit`, `negation`, `missing_field`, `filler_pause`, `self_correction`, `silence`, `noise` |
| `utterance_group` | Optional; takes of one utterance. A group in both `dev` and `test` is rejected; a speaker in both splits is a warning |
| `reviewed_by` | Reviewer codes; required for every audio item when running `--split test` |

[asr-eval-prepare.py](../../scripts/asr-eval-prepare.py) creates annotation sheets from the [recording plan](../../scripts/asr-eval-plan.json), converts recordings to 16 kHz mono PCM16 with macOS `afconvert` (originals kept, processing logged), and freezes a versioned manifest with each file's SHA256, sample rate, channels and duration. It writes only under `private/` and never overwrites a frozen manifest.

### Metrics

| Metric | Definition |
| --- | --- |
| `false_reject_rate` | Items labeled acceptable or understandable that got `retry` or `rerecord`, divided by `acceptable_or_understandable_n` (non-technical items) |
| `false_accept_rate` | Items labeled incorrect that got `pass`, divided by `incorrect_n` |
| `technical_failure`, `technical_failure_rate`, `technical_failure_reasons` | Timeouts, unreachable servers, provider errors, budget exhaustion; counted over all items, broken down by reason, and excluded from the two rates above — never dropped |
| `mean_cer` / `corpus_cer` | Mean of per-item CER, and total edits ÷ total reference characters. Both use `cer-norm.v1` (NFKC, lowercase, strip punctuation/space/symbols, traditional→simplified for characters in current content); Wu vs Mandarin word choices still count as errors |
| `median_latency_ms`, `p95_latency_ms`, `mean_latency_ms` | Over `latency_items`. `elapsed_ms` is the adapter's request round trip (upload + network + inference); rows also keep `wall_ms`. p95 is nearest-rank, so with few items it is the slowest one. Cold/warm start, machine and network are recorded with the run |
| `attribution` | Per row, comparing the ASR verdict with the verdict on `reference`: `asr_error` (rules would be right on the true words), `rule_error` (rules are wrong even on the true words), `ok`, `ok_despite_rule_error` |
| `by_station`, `by_speaker_group`, `by_condition`, `by_split` | The same counts and rates per group |

Each row keeps clip ID, provider, config ID, returned model, input SHA256, reference, raw transcript, verdict, reason, outcome and latency. Each run records the manifest SHA256 and version, Git commit (and whether `backend/app` or `scripts` were dirty), rule versions, machine, paid-call count and cap, and any manifest warnings. A manifest marked `draft` is flagged as interface-check only.

For a lenient learning product, prioritize a low false-reject rate, but keep the false-accept rate near zero.

## 3. Selecting the TTS provider (offline audio generation)

`TTS_PROVIDER` chooses the provider for `scripts/speech.py tts-generate`; the app never synthesizes at runtime.

| Value | Provider | Notes |
| --- | --- | --- |
| `qwen` (default) | DashScope `qwen3-tts-flash` + Jada | Unchanged; config ID stays `tts-7f9e533827ac529c` |
| `openai_compatible` | Any server implementing `POST /v1/audio/speech` returning WAV | For local or self-hosted voices, e.g. a CosyVoice OpenAI-style server |

`LOCAL_TTS_ENDPOINT`, `LOCAL_TTS_MODEL`, `LOCAL_TTS_VOICE` (required), `LOCAL_TTS_LANGUAGE`, `LOCAL_TTS_API_KEY`, `LOCAL_TTS_TIMEOUT_SECONDS` (default 60), and `LOCAL_TTS_ENABLE_LIVE` follow the same endpoint rules as ASR. Output is validated as WAV and is always `status: pending`, `listeningReview: pending`. Only normal speed is generated; slow playback stays the existing pitch-preserving 0.75× client rate. The review-round scripts (`speech-review*.py`) stay on Qwen because their caches and records are bound to that configuration.

## 4. Reference-audio similarity (`--acoustic`)

[acoustic.py](../../backend/app/acoustic.py) compares a learner recording with a reference recording of the same sentence. It extracts self-supervised speech features (default `microsoft/wavlm-base-plus`, hidden layer 6; override with `ACOUSTIC_MODEL` / `ACOUSTIC_LAYER`), aligns them with DTW, and reports the mean cosine similarity on a 0–1 scale. Leading and trailing silence is trimmed, and timing differences are absorbed by the alignment. It needs no Shanghainese lexicon. It can say "sounds close to the reference", never which word was said.

```bash
backend/.venv/bin/python -m pip install -r backend/requirements-acoustic.txt
```

```bash
npm run asr:eval -- private/asr-eval/manifest.json --acoustic
```

- Add `"reference_audio": "relative/path.wav"` to each item, e.g. an approved teaching recording or a native-speaker recording.
- Each row gets `acoustic_similarity`, and the summary reports `mean_acoustic_similarity_by_label`, which is the data needed to choose thresholds.
- **Without `--calibration`, similarity costs 0 points.** A low value (< 0.5) is recorded as an `uncertain` minor event, per scoring Rule A.
- `--calibration file.json` with `{"minor_below": 0.8, "severe_below": 0.4, "confidence": 0.9}` turns similarity into confident minor or severe pronunciation events. These values are placeholders: fit them per model and layer on labeled data before use.
- The dependencies (numpy, torch, transformers) and the model weights (~380 MB, downloaded from Hugging Face on first use) are local-only and are not in `requirements.lock`.

## 5. Not done yet

- No real local server, real model, or paid call has been run. All provider tests use mocked HTTP.
- No labeled recordings exist yet. The [recording plan](../evaluation/recording-plan.md) and annotation tools are ready; collecting recordings with fluent-speaker labels is the next prerequisite.
- Hosted providers without an OpenAI-compatible API (Tencent, iFlytek, Volcengine, Azure) need their own adapters. Add them as separate `ASR_PROVIDER` values after choosing which ones to test and setting a budget.
- The acoustic path has only been tested with a stand-in feature extractor. The optional dependencies and WavLM weights have not been downloaded, so no real similarity has been measured, and no calibration exists.
- No local TTS voice has been generated or listened to.
