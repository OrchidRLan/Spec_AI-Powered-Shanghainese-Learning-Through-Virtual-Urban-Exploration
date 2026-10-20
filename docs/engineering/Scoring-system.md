# Lenient Shanghainese speaking scoring: before and after

Updated: 2026-10-20. Status: **implemented locally and passing tests; not yet committed or deployed; deduction values have not been calibrated with native speakers.**

Implementation: [scoring.py](../../backend/app/scoring.py). Tests: [test_scoring.py](../../backend/tests/test_scoring.py). Integration points: [main.py](../../backend/app/main.py) (Nanxiang) and [lesson_api.py](../../backend/app/lesson_api.py) (old restaurant, pear-candy shop, teahouse).

## 1. Summary

| | Before | After |
| --- | --- | --- |
| Is there a score? | No, only correct / incorrect | Yes, an internal score (out of 100, deducted per error); learners do not see it |
| What decides a pass? | Rules check whether the text matches the current question's target | The same rules still decide whether the content is correct; scoring only adds tolerance on top |
| Where it is more lenient | Only one homophone tolerance, "两分→两份" | Pauses, fillers and restarts no longer cause false rejections; homophone variants are recorded as 0-point deductions |
| Pronunciation / tone | Not judged | A deduction interface exists, but **it is still not judged**, because the ASR returns text only |
| Safety boundary | Negation, opposite meaning and conflicting quantities must not pass | Unchanged; new tests confirm negatives still fail after adding fillers or repetitions |

## 2. Before: target check, no scoring

```text
录音 → qwen3-asr-flash 转文字 → 规则核对（正则 + 解析器）→ correct / incorrect / unrecognized / technical
(recording → qwen3-asr-flash transcription → rule check (regex + parser) → correct / incorrect / unrecognized / technical)
```

- Nanxiang uses `guided.assess()`; the three other stations use `lessons.assess()`. The output is only a status and a reason code, e.g. `quantity_mismatch`, `ambiguous_expression`.
- Qwen only transcribes speech and does not score; the LLM prompt also explicitly forbids it from scoring.
- Leniency exists only as the omissions, synonyms and the "分/份" homophone tolerance that the rules allow.
- **False-rejection examples**: at the teahouse, "嗯，好喝" and "嗯 蛮香个"; at Nanxiang, "两份，两份". All failed because of an extra filler or a restart.

## 3. After: content gate + lenient deductions

```text
recording → ASR text
     → rule check on the original text
         └ if it fails: remove fillers, collapse restarts, check once more
     → generate error events → rule deductions (Rules A / B / C)
     → content gate + score threshold → pass / retry / rerecord
```

### 3.1 Deduction table (MVP parameters, not calibrated)

| Error type | Code | Deduction | Current source |
| --- | --- | --- | --- |
| Accepted variant (e.g. "两分" read as "两份") | `accepted_variant` | 0 | Text rules ✅ |
| Pause, filler, restart | `pause_or_repetition` | 0 | Text rules ✅ |
| Synonym substitution | `synonym_substitution` | 0 | Reserved |
| Minor pronunciation deviation | `minor_pronunciation` | −2 | Reserved: needs an audio-assessment model |
| Minor tone deviation | `minor_tone` | −3 | Reserved: needs an audio-assessment model |
| Omitted non-key word | `omitted_non_key` | −5 | Reserved |
| Key content error (negation, conflicting quantity, wrong object, etc.) | `key_content_error` | −10, **and forces retry** | Text rules ✅ |
| Pronunciation error that makes the meaning hard to identify | `severe_pronunciation` | −10, **and forces retry** | Reserved: needs an audio-assessment model |
| Whole utterance unrecognizable | `unintelligible` / empty transcript | Not scored; prompt to re-record | ✅ |

Strictness: `lenient` ×1.0 (default), `standard` ×1.5, `strict` ×2.0. Pass threshold: 75.

### 3.2 Protection rules

- **Rule A: no pronunciation deduction when uncertain.** A pronunciation or tone event marked `uncertain`, or with confidence below 0.6, scores 0 points but is still recorded so it can be reviewed during later calibration.
- **Rule B: no double deductions.** Multiple events at the same position (`span`) keep only the heaviest deduction.
- **Rule C: minor errors capped at 15 points.** Without a key error, the cumulative deduction is at most 15 points; once there is a key error, the cap does not apply.
- **The content gate comes first.** If the content check fails, the verdict is `retry` regardless of the score. Conversely, if the content passes but there is a confident severe pronunciation error, the verdict is also `retry`, with reason code `pronunciation_unclear`. This only takes effect once audio assessment is connected.

### 3.3 Output format (internal field, not shown in the UI)

Every check result gains a `scoring` field:

```json
{"version": "lenient-rules.v1", "profile": "lenient", "threshold": 75,
 "score": 100, "verdict": "pass", "capped": false,
 "deductions": [{"type": "pause_or_repetition", "points": 0, "span": "fillers", "uncertain": false}]}
```

`verdict` values: `pass`, `retry`, `rerecord` (no speech recognized), `unavailable` (device or service failure).

## 4. Before/after examples

| Scene | Transcript | Before | After |
| --- | --- | --- | --- |
| Teahouse · praise the tea | 嗯，好喝 | ❌ target_mismatch | ✅ 100, pause recorded |
| Teahouse · praise the tea | 嗯 蛮香个 | ❌ | ✅ 100 |
| Teahouse · praise the tea | 呃，好喝，好喝 | ❌ | ✅ 100 |
| Nanxiang · quantity | 两份，两份 | ❌ ambiguous_expression | ✅ 100 |
| Nanxiang · quantity | 两分 | ✅ | ✅ 100, homophone variant recorded |
| Nanxiang · quantity | 嗯，不要两份 | ❌ | ❌ key error, retry |
| Nanxiang · quantity | 两，两个 | ❌ unit_mismatch | ❌ key error, retry |
| Teahouse · praise the tea | 嗯，不好喝 | ❌ | ❌ key error, retry |
| Any | (empty) | Unrecognized | Not scored; prompt to re-record |

## 5. Verification

- 565 backend tests pass: all 483 existing tests still pass, plus 82 new ones. `npm run check` passes in full: typecheck, 49 content tests, 170 UI tests, backend tests and audio checks.
- New tests cover: Rules A/B/C, the three strictness profiles, the threshold, severe pronunciation forcing retry, no score when unrecognizable, and both the Nanxiang and the three-station APIs returning the `scoring` field, with technical failures recorded as unscored.
- Safety regression: 16 representative negatives (negation, "还是", wrong unit, wrong object, reported speech, spicy vs. not spicy), each tested in 4 forms: original, with a "嗯，" prefix, full repetition, and surrounding fillers. All 64 combinations still fail.
- **Not done**: no frontend changes; no real recordings, real ASR calls or native-speaker calibration.

## 6. Limitations and next steps

1. **Pronunciation and tone deductions do not take effect yet.** `qwen3-asr-flash` outputs text only. Enabling this requires a model that understands audio directly (e.g. the Qwen-Omni family). First evaluate in Batch E how reliably it judges Shanghainese pronunciation, then pass its results to `assess_lenient()` as `observations`.
2. **Deduction values and the threshold need calibration.** Have native Shanghainese speakers label recordings as Acceptable / Understandable / Incorrect; the first two should pass. Use this data to measure the false-rejection rate (the share of recordings native speakers find acceptable that are rejected) and the false-acceptance rate, then adjust the parameters.
3. **Other false-rejection sources in the rule layer are untouched.** For example, any "不" or "别" fails the check, and "两个" fails as a unit mismatch. Relaxing these touches the negation safety boundary, so each needs negative test cases before it is changed.
4. **Product spec change.** The spec now says "internal whole-utterance scoring, not shown in the UI, no claim of pronunciation mastery". Showing scores to learners later would need a separate product decision.
