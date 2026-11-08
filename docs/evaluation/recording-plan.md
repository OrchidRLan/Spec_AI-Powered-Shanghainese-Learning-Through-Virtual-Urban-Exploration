# ASR recording plan and listening review materials

Version `asr-recording-plan.pilot-v1`, 2026-11-07. Machine-readable plan: [asr-eval-plan.json](../../scripts/asr-eval-plan.json). Method and selection rules: [model comparison](model-comparison.md).

This is engineering validation data for the speech check, not a learning study. No participants are recruited. Recordings are never committed or published.

## 1. Who records what

| Phase | Speakers | Items | Purpose |
| --- | --- | --- | --- |
| Pilot | 2 (ideally 1 fluent + 1 beginner) | 31 prompts each, 1 take | Find interface, format and labeling problems before freezing |
| Formal (suggested) | 3–5 speakers in total, mixing fluent and beginner | About 80–120 clips | Comparison on a frozen held-out set |

These sizes are a project suggestion, not a course requirement or a guarantee of statistical power. If fewer speakers are available, the report states the real size.

- Use anonymous speaker codes only (`S01`, `S02`, …). Reviewers also get codes (`R01`, …). Keep the code-to-person key outside the repository.
- Groups: `fluent`, `heritage`, `beginner`; synthetic audio is always `synthetic` and reported separately. TTS output never stands in for human recordings.
- Splits are by speaker where possible: for example, S01 + S02 in `dev` (tuning), S03 + S04 in `test` (held-out). Repeated takes of one prompt always stay in the same split.

## 2. Recording instructions

1. Quiet room for most items; note the room in `environment` (`quiet`, `cafe`, `street`).
2. Phone voice memo or laptop microphone is fine; note the device in `device` (e.g. `iPhone voice memo`, `MacBook mic`). One file per prompt, named `<PROMPT>.wav` (or `.m4a`; it is converted).
3. Say each sentence naturally, once. Do not read the romanization aloud. For draft items, say the text only after the reviewer has confirmed it.
4. Leave about half a second of silence before and after speaking. Recordings must be under 20 seconds.
5. For `ENG-SILENCE`, record 3 seconds without speaking. For `ENG-NOISE`, record 3 seconds of room or street noise with nobody speaking.
6. If you misspeak, keep the take and say what actually happened in the sheet; do not re-record to make the item "correct". A clean retake gets a new take number.

## 3. Pilot prompts

"Content" texts come from the current teaching packs (`batch-a-r3`, `batch-bc`), which are themselves still pending language review. **Draft** texts were written to cover error types and must be confirmed or corrected by a fluent reviewer before recording. The intended label is a design intent only; the real label is decided after listening.

| Prompt | Station / step | Target | Condition | Say | Text source | Intended label |
| --- | --- | --- | --- | --- | --- | --- |
| `NX-ITEM-CAN` | Nanxiang / item | item=xiaolongbao | canonical | 小笼馒头 | Content `NX-ITEM-XLB` | acceptable |
| `NX-ITEM-MISS` | Nanxiang / quantity | quantity=2, unit=serving | missing_field | 小笼馒头 (Quantity question answered with the item only) | Content `NX-ITEM-XLB` | incorrect |
| `NX-QTY-CAN` | Nanxiang / quantity | quantity=2, unit=serving | canonical | 我要两份小笼馒头 | Content `E08` | acceptable |
| `NX-QTY-SHORT` | Nanxiang / quantity | quantity=2, unit=serving | canonical | 两份 | Content `NX-Q2` | acceptable |
| `NX-QTY-FILLER` | Nanxiang / quantity | quantity=2, unit=serving | filler_pause | 嗯……两份 (Natural hesitation before the answer) | **Draft — confirm** (from `NX-Q2`) | acceptable |
| `NX-QTY-SELF` | Nanxiang / quantity | quantity=2, unit=serving | self_correction | 三份……勿对，两份 (Reviewer decides the label; the intended meaning is two) | **Draft — confirm** (from `NX-Q2`) | acceptable |
| `NX-QTY-WRONG` | Nanxiang / quantity | quantity=2, unit=serving | wrong_quantity | 三份 | Content `NX-Q3` | incorrect |
| `NX-QTY-UNIT` | Nanxiang / quantity | quantity=2, unit=serving | wrong_unit | 两个 (个 is a different counter from 份) | **Draft — confirm** (from `NX-Q2`) | incorrect |
| `NX-QTY-NEG` | Nanxiang / quantity | quantity=2, unit=serving | negation | 勿要两份 | **Draft — confirm** (from `NX-Q2`) | incorrect |
| `NX-MODE-TAKE` | Nanxiang / mode | takeaway=True | canonical | 打包带走 | Content `E09` | acceptable |
| `NX-MODE-HERE` | Nanxiang / mode | takeaway=False | canonical | 堂吃 | Content `NX-MODE-HERE` | acceptable |
| `NX-MODE-WRONG` | Nanxiang / mode | takeaway=True | wrong_target | 堂吃 (Target is takeaway) | Content `NX-MODE-HERE` | incorrect |
| `NX-CONF-CAN` | Nanxiang / confirm | confirm | canonical | 对个 | Content `E05` | acceptable |
| `NX-CONF-NEG` | Nanxiang / confirm | confirm | negation | 勿对 | **Draft — confirm** (from `E05`) | incorrect |
| `OLD-PREF-CAN` | Old Restaurant / preference | not_spicy | canonical | 我勿吃辣个。 | Content `BC-OLD-PREFERENCE` | acceptable |
| `OLD-PREF-NEG` | Old Restaurant / preference | not_spicy | negation | 我吃辣个。 (Negation dropped: opposite meaning) | **Draft — confirm** (from `BC-OLD-PREFERENCE`) | incorrect |
| `OLD-REC-CAN` | Old Restaurant / recommendation | recommend | canonical | 有啥推荐伐？ | Content `BC-OLD-RECOMMEND` | acceptable |
| `OLD-DISH-FISH` | Old Restaurant / dish | fish | canonical | 我要清蒸鱼。 | Content `BC-OLD-CHOOSE-FISH` | acceptable |
| `OLD-DISH-NONSTD` | Old Restaurant / dish | chicken | nonstandard | 我要白斩鸡。 (Read with a Mandarin-influenced pronunciation; reviewer decides understandable vs incorrect) | Content `BC-OLD-CHOOSE-CHICKEN` | understandable |
| `OLD-DISH-WRONG` | Old Restaurant / dish | fish | wrong_target | 我要白斩鸡。 (Target is fish) | Content `BC-OLD-CHOOSE-CHICKEN` | incorrect |
| `CND-FLAV-ROSE` | Pear Candy / flavor | rose; assigned flavor rose | canonical | 我要玫瑰味个梨膏糖。 | Content `BC-CND-ROSE` | acceptable |
| `CND-FLAV-OSM` | Pear Candy / flavor | osmanthus; assigned flavor osmanthus | canonical | 我要桂花味个梨膏糖。 | Content `BC-CND-OSMANTHUS` | acceptable |
| `CND-FLAV-WRONG` | Pear Candy / flavor | rose; assigned flavor rose | wrong_target | 我要薄荷味个梨膏糖。 (Assigned flavor is rose) | Content `BC-CND-MINT` | incorrect |
| `CND-QTY-CAN` | Pear Candy / quantity | two_packs; assigned flavor rose | canonical | 我要两包。 | Content `BC-CND-TWO-PACKS` | acceptable |
| `CND-QTY-FILLER` | Pear Candy / quantity | two_packs; assigned flavor rose | filler_pause | 嗯，两包。 | **Draft — confirm** (from `BC-CND-TWO-PACKS`) | acceptable |
| `CND-QTY-WRONG` | Pear Candy / quantity | two_packs; assigned flavor rose | wrong_quantity | 我要三包。 | **Draft — confirm** (from `BC-CND-TWO-PACKS`) | incorrect |
| `TEA-PRAISE-CAN` | Teahouse / appreciation | good_tea | canonical | 搿茶老好吃个。 | Content `BC-TEA-PRAISE` | acceptable |
| `TEA-PRAISE-NEG` | Teahouse / appreciation | good_tea | negation | 搿茶勿好吃。 | **Draft — confirm** (from `BC-TEA-PRAISE`) | incorrect |
| `TEA-THANKS-CAN` | Teahouse / thanks | thanks | canonical | 谢谢侬。 | Content `BC-TEA-THANKS` | acceptable |
| `ENG-SILENCE` | Nanxiang / quantity | quantity=2, unit=serving | silence | (3 seconds of silence) (Engineering negative: press record and stay silent) | — | incorrect |
| `ENG-NOISE` | Teahouse / appreciation | good_tea | noise | (3 seconds of background noise, no speech) (Engineering negative: room or street noise only) | — | incorrect |

### Recording and review tools

- **Recording:** `backend/.venv/bin/python scripts/record-session.py`, then open http://127.0.0.1:8765 in a normal browser (the app's built-in preview pane has no microphone). One prompt at a time, app microphone settings, 16 kHz WAV saved straight into `private/asr-eval/<session>/`, re-takes kept in `_retakes/`. What the speaker types as "actually said" is stored as an unreviewed `reference`.
- **Review:** `backend/.venv/bin/python scripts/review-session.py serve`, then open http://127.0.0.1:8766. Each reviewer (code `R01`, …) hears the recordings in their own random order, verifies or corrects the transcript, labels the answer to the question that was asked, and rates the wording of each draft prompt. Model transcripts and intended labels are not shown. Each reviewer's decisions go to `review-<code>.json`.
- **Merge:** `backend/.venv/bin/python scripts/review-session.py apply` writes label, reference and `reviewed_by` into the speaker sheets only where all reviewers of a recording agree; disagreements are listed for discussion and left blank. A reviewer who is also the speaker is noted as a self-review.

Pilot 1 deviation: speaker S01 recorded the draft prompts before a reviewer confirmed them. If the reviewer rejects a draft's wording, that recording stays as the speaker's own utterance with its reviewed label, and later speakers use the corrected wording.

## 4. Annotation fields

Create one sheet per speaker; the tool fills the fixed columns:

```bash
backend/.venv/bin/python scripts/asr-eval-prepare.py sheet --speaker S01 --group fluent --split dev --out private/asr-eval/S01.csv
```

| Column | Filled by | Meaning |
| --- | --- | --- |
| `id`, `prompt_id`, `station`, `step`, `target`, `candy_flavor`, `condition`, `say`, `audio`, `utterance_group` | Tool | From the plan. Do not edit |
| `speaker_id`, `speaker_group`, `source`, `split` | Tool | From the command; anonymous only |
| `reference` | Fluent reviewer | **What the speaker actually said**, in Chinese characters, including fillers and mistakes. Not the expected answer. Empty only for silence/noise |
| `label` | Fluent reviewer | `acceptable` (correct and natural), `understandable` (a listener would understand the intended answer, though not standard), `incorrect` (wrong, missing or unintelligible for this question) |
| `reviewed_by` | Fluent reviewer | Reviewer codes separated by `;`, e.g. `R01;R02` |
| `device`, `environment` | Recorder | See §2 |
| `original_audio`, `processing` | Tool/recorder | Original file name and conversion command, if converted |
| `notes` | Anyone | Disagreements, misspeaking, noise, anything unusual |

Writing conventions for `reference` (fixed for CER): use the characters of the teaching packs where the same word is meant (侬, 勿, 个, 搿, 伐); write what was said, so a Mandarin word that was actually spoken is written in Mandarin; mark unclear parts with `?`. Traditional and simplified forms are equivalent under `cer-norm.v1`.

Then convert, freeze and run:

```bash
backend/.venv/bin/python scripts/asr-eval-prepare.py convert private/asr-eval/raw private/asr-eval
```

```bash
backend/.venv/bin/python scripts/asr-eval-prepare.py freeze private/asr-eval/S01.csv private/asr-eval/S02.csv --out private/asr-eval/manifest-pilot-v1.json --version pilot-v1
```

```bash
npm run asr:eval -- private/asr-eval/manifest-pilot-v1.json --provider qwen --allow-paid-call --max-calls 62
```

The tools refuse to write outside `private/`, refuse names as speaker codes, never overwrite a frozen manifest, refuse identical audio in both splits, and refuse to score the `test` split unless every item has `reviewed_by`. After the formal set is frozen, labels and references are not changed in response to any model's output.

## 5. TTS blind listening

After the ASR comparison. Suggested 18 key sentences (current content, all pending review):

| # | Content ID | Text |
| --- | --- | --- |
| 1 | `E08` | 我要两份小笼馒头 |
| 2 | `E09` | 打包带走 |
| 3 | `E05` | 对个 |
| 4 | `NX-Q1` | 一份 |
| 5 | `NX-Q3` | 三份 |
| 6 | `NX-MODE-HERE` | 堂吃 |
| 7 | `NX-N02` | 要几份？ |
| 8 | `BC-OLD-PREFERENCE` | 我勿吃辣个。 |
| 9 | `BC-OLD-RECOMMEND` | 有啥推荐伐？ |
| 10 | `BC-OLD-CHOOSE-FISH` | 我要清蒸鱼。 |
| 11 | `BC-OLD-CONFIRM-CHICKEN` | 一份白斩鸡，勿辣，对伐？ |
| 12 | `BC-CND-ROSE` | 我要玫瑰味个梨膏糖。 |
| 13 | `BC-CND-INTRO-OSMANTHUS` | 今朝介绍桂花味个梨膏糖。 |
| 14 | `BC-CND-TWO-PACKS` | 我要两包。 |
| 15 | `BC-TEA-ASK-APPRECIATION` | 请吃茶，味道哪能？ |
| 16 | `BC-TEA-PRAISE` | 搿茶老好吃个。 |
| 17 | `BC-TEA-THANKS` | 谢谢侬。 |
| 18 | `BC-TEA-COMPLETE` | 勿用客气，欢迎再来。 |

Each system's clip for each sentence gets a random code. Reviewers do not see which system made it, and the order is shuffled per reviewer. At least two fluent reviewers rate independently:

| Field | Scale |
| --- | --- |
| Pronunciation error | Yes / No; if yes, which characters and what was heard |
| Intelligibility | 1–5 (5 = fully clear to a Shanghainese listener) |
| Naturalness | 1–5 (new in this round; reported as such) |
| Comment | Free text |

Disagreements are reported, not averaged away. Audio is replaced only where a candidate is shown to be better and passes review. Slow playback remains the existing 0.75× pitch-preserving rate and is described that way.

## 6. What is needed from Ruolan

1. Pilot recordings (or existing usable recordings) with permission to use them for this engineering evaluation, plus the speaker groups.
2. A fluent reviewer (or two) to confirm the nine draft texts before recording, then fill `reference`, `label` and `reviewed_by`.
3. For CosyVoice: one consented 5–10 s Shanghainese prompt recording and its exact transcript.
4. Later: TTS blind ratings from at least two fluent reviewers, and a physical phone for the microphone check.
