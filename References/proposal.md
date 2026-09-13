# AI-Powered Shanghainese Learning Through Virtual Urban Exploration

## Ruolan Chen (rc975), Haoyang Song (hs2289)

This is the latest version, as of Sep 11\.

Main revisions made:

* Replaces prev high-level RQ with more concrete ones  
* Clarified the app, concrete tasks, and local testing setup  
* Added explicit comparisons & metrics, and aligned the roadmap with 3 stages in slides

Interactive description：  
Prototype:   
Github:[https://github.com/OrchidRLan/Spec\_AI-Powered-Shanghainese-Learning-Through-Virtual-Urban-Exploration](https://github.com/OrchidRLan/Spec_AI-Powered-Shanghainese-Learning-Through-Virtual-Urban-Exploration)

# 1\. Abstract

This project proposes an app for beginner Shanghainese practice through virtual exploration of Yu Garden in Shanghai, without requiring an on-site visit. Learners will follow a 20–30 minute route through four locations, practising 8–12 core expressions in communication tasks. The prototype combines automatic speech recognition (ASR), a large language model for task interpretation, a deterministic state machine, and pre-generated text-to-speech (TTS) audio. Technical evaluation will compare ASR and TTS models and examine how recognition and interpretation errors affect task progression. An in-person study with 6–8 locally recruited beginners will assess task completion, language-support use, and interaction experience. Expected outcomes include a working prototype and findings to guide speech-model selection, system reliability improvements, and interaction design.

# 2\. Background

Shanghainese is a Wu Chinese variety with pronunciation, vocabulary, and grammar that differ from Standard Mandarin. Word lists and pronunciation guides can introduce basic expressions, while communication tasks provide opportunities to practise using them. This project focuses on beginner exchanges such as expressing preferences, selecting items, specifying quantities, and confirming orders.

A virtual Yu Garden route provides a setting for organizing these exchanges. Restaurants, snack shops, and teahouses offer recognizable situations in which particular expressions become relevant. The app uses these settings to connect expressions with communication goals, without requiring learners to visit Yu Garden physically.

Existing ASR, LLM, and TTS components provide a starting point for building the prototype without training new models. Relevant speech models include general purpose systems and models adapted for Wu speech. Whisper supports multilingual speech recognition, including mandarin, while Qwen3-ASR explicitly lists support for multiple chinese dialects, including Wu. The WenetSpeech-Wu release provides a Wu speech corpus (they said they wil, but haven’t), a benchmark, and trained models, including Whisper-Medium-Wu for ASR and CosyVoice2-Wu-SFT for speech synthesis. 

These Wu-adapted checkpoints are candidates for the prototype. The project plans to use existing models without additional training or fine-tuning. [Whisper documentation](https://github.com/openai/whisper), [Qwen3-ASR documentation](https://github.com/QwenLM/Qwen3-ASR), [WenetSpeech-Wu release](https://github.com/ASLP-lab/WenetSpeech-Wu-Repo). 

The suitability of these components for the app’s target expressions and tasks requires direct evaluation. Published WenetSpeech-Wu evaluations cover speech recognition and synthesis, with ASR results reported on the public benchmark and additional dialogue and reading test sets. These results do not establish performance on this app’s short transactional expressions or on speech produced by beginner learners. Beginners’ pronunciation may differ from the speech represented in existing evaluation datasets. The project will therefore assess recognition accuracy on the target expressions, pronunciation accuracy and intelligibility of synthesized Shanghainese, and whether the system correctly interprets learner responses and advances to the appropriate task state. [WenetSpeech-Wu paper](https://arxiv.org/html/2601.11027v1). 

The team has conducted initial tests of ASR and TTS components. Further evaluation will compare candidate models and examine the integrated system’s reliability. A complementary user study will investigate how beginners use speech interaction and language support to complete the route’s tasks, connecting technical performance with the experience of using the prototype.

# 3\. Proposal

## 3.1 Research Aim & Research Questions

This project investigates speech-model performance, system reliability, and user experience in an app for beginner Shanghainese practice through virtual exploration of Yu Garden. Technical evaluation and an in-person user study will address three questions:

1. **Speech model comparison:** How do candidate ASR models compare in recognition accuracy, and candidate TTS models in pronunciation accuracy and intelligibility, for the app’s target Shanghainese expressions?  
2. **System reliability:** How do speech recognition and task interpretation errors affect task progression in the integrated system?  
3. **User experience:** How do beginners use the app’s speech interaction and language support to complete communication tasks along the virtual Yu Garden route?

## 3.2 Route Design

The app will offer a 20–30 minute virtual route through four Yu Garden locations, introducing 8–12 core expressions. Each location will provide a communication task with predefined completion criteria.

| Location | Task | Completion Criteria |
| ----- | ----- | ----- |
| **Shanghai Old Restaurant** | Express a non-spicy preference, request a recommendation, and confirm an item. | Confirm an item matching the preference in the app’s menu. |
| **Shanghai Pear Candy Shop** | Identify a taste from audio and request two packs of the corresponding candy. | Correctly identify the taste and specify the item and quantity. |
| **Nanxiang Steamed Bun Restaurant** | Order two servings of xiaolongbao for takeaway and review the order. | Confirm the correct item, quantity, and takeaway option. |
| **Huxin Pavilion Teahouse** | Say that the tea tastes good and thank the host. | Communicate both a positive evaluation and thanks. |

Expression cards will include phonetic guides, Mandarin and English translations, and normal-speed and slow audio. Selected expressions will recur across tasks, and learners may consult these resources throughout the route.

## 3.3 App Design and System Architecture

The prototype will be developed using a React frontend and a Python backend deployed on Vercel. The interface will present the virtual route, current task, language supports, and progress, with speech, text, and button inputs.

The Python backend will access ASR and LLM services through APIs. Spoken responses will be transcribed by ASR, then interpreted by the LLM into structured fields such as item, quantity, and preference. Typed responses will enter the same interpretation stage, while buttons will supply predefined values. Application rules will validate these fields, and a deterministic state machine will request missing information, present confirmations, or advance the task. Pre-generated TTS clips will provide expression examples and prompts.

ASR models will be interchangeable for comparison. Language content and audio will be reviewed before user testing, and learners may retry responses or switch input methods. Logs will capture model configurations, transcripts, extracted fields, state changes, processing times, support use, and task completion for evaluation.

## 3.4 Technical Evaluation

**Speech Model Comparison — RQ1**

| Model | Source | Role in the comparison |
| :---: | :---: | :---: |
| Whisper-medium | openai/whisper-medium | General-purpose baseline |
| Whisper-Medium-Wu | WenetSpeech-Wu speech understanding release | Wu-adapted counterpart of the same base model, fine-tuned on Wu data |
| Qwen3-ASR-1.7B | Qwen/Qwen3-ASR-1.7B | Alternative model line with reported Chinese dialect support |

For ASR, we will compare Whisper-medium, Whisper-medium-Wu, and Qwen3-ASR-1.7B. Whisper-medium provides a general-purpose baseline, while Whisper-medium-Wu enables a comparison with its Wu-adapted counterpart. Qwen3-ASR-1.7B provides an alternative model with reported support for Wu Chinese. All three models will transcribe the same recorded Shanghainese task responses, using manually verified reference transcripts and consistent text-normalization rules.

For TTS, We will compare CosyVoice2-0.5B, the general-purpose release, with CosyVoice2-Wu-SFT from the WenetSpeech-Wu speech generation release, to examine whether Wu-specific adaptation improves pronunciation accuracy and intelligibility for the app's target expressions. Both models will synthesize the same texts using the same Shanghainese reference recordings.

The two are not invoked identically. The Wu-SFT model performs zero-shot synthesis from a Shanghainese reference utterance and its transcript. The general-purpose model requires an explicit instruction to produce Shanghainese, and is invoked through its instruction-following interface with a fixed Shanghainese instruction held constant across all clips. Each model is therefore used in the mode its release documents, and the comparison is between two released systems as they are intended to be used rather than a strictly controlled ablation. The instruction text, reference utterances, and inference settings are fixed and reported, and this asymmetry is stated as a limitation.

Fluent Shanghainese reviewers will independently assess the generated clips in randomized order, with model identities hidden.

| Component | Metric | Definition |
| :---: | :---: | ----- |
| ASR | Character error rate (CER) | Character substitutions, deletions, and insertions divided by the number of reference characters, using manually verified transcripts and consistent transcription conventions. |
| ASR | Response latency | Median time from submitting an ASR request to receiving the complete transcript. |
| TTS | Pronunciation accuracy | Percentage of audio clips judged by fluent reviewers (the team) to contain no pronunciation errors. |
| TTS | Intelligibility | Reviewer ratings on a 1–5 scale, from unintelligible to fully understandable. |

We will use released checkpoints without additional training or fine-tuning. Checkpoint revisions, inference settings, and hardware will be documented, with configurations fixed throughout evaluation. ASR latency will be measured on the same hardware with models already loaded and one recording processed at a time.

Results will inform the selection of ASR and TTS models for the final app.

**System Reliability — RQ2**

* **Test cases:** Include complete requests, incomplete responses, and corrections, with expected field values and next actions defined in advance.  
* **Comparison:** Process ASR-generated and manually verified transcripts of the same recordings through the same LLM configuration and state machine.

| Metric | Definition |
| :---: | ----- |
| Field-extraction accuracy | Percentage of predefined task fields whose values match the reference labels, including fields that should remain unset. |
| Task-state correctness | Percentage of test cases in which the system’s next action matches the expected clarification, confirmation, or completion action. |

Errors will be traced across recognition, interpretation, and state transitions to identify their source and effect on task progression.

## 3.5 User Study

An in-person study will involve 6–8 locally recruited participants aged 18–35 with little or no prior Shanghainese experience. After a brief introduction, participants will complete the 20–30 minute virtual route using the available input methods and language supports.

The study will address **RQ3** through:

* **Task completion:** Record completion against predefined criteria, time spent, retries, and facilitator assistance.  
* **Support use:** Record expression-card access, audio replay, and input-method switching, with observations of when and why these occur.  
* **User feedback:** Collect brief post-session ratings of ease and effort, followed by an interview about confusing steps and helpful features.

Interaction logs and observations will be summarized descriptively. Interview responses will be grouped into recurring themes to identify usability issues and priorities for improving the prototype.

## 3.6 Expected Outcomes

The project will deliver a working prototype, comparative findings on candidate ASR and TTS models, an analysis of errors affecting task progression, and usability findings from beginner participants. These findings will inform recommendations for component selection and interaction design, with limitations and directions for future work.

# 4\. Roadmap

## Overall division of labor

* **Ruolan:** ASR/TTS candidate-model research and benchmarking, cultural content, learning-task and phrase preparation, UX coordination, and qualitative analysis.  
* **Haoyang:** Web prototype, virtual route, ASR/TTS integration, task-state logic, logging, and integrated-system reliability testing.  
* **Both:** Research design, Shanghainese expression and audio review, data analysis, final report, and presentation.

## Weeks 1–5: Development

* Finalize route tasks, target expressions, learning resources, and completion criteria.  
* Complete and deploy the integrated prototype.  
* Prepare evaluation materials, pilot the workflow, and begin participant recruitment.

## Weeks 6–10: Evaluation

* Compare ASR and TTS models for RQ1 and select components for the study prototype.  
* Evaluate system reliability for RQ2 and resolve identified failures before user testing.  
* Conduct 6–8 user sessions for RQ3, collecting logs, observations, ratings, and interview feedback.

## Weeks 11–15: Learning

* Analyze technical and user-study data to answer the three research questions.  
* Summarize findings, design recommendations, challenges, limitations, and future directions.  
* Complete the final report, presentation, and prototype demonstration.

# References

Papers

\[1\] Shanghai Municipal Administration of Culture and Tourism. n.d. Yu Garden Old City Intangible Cultural Heritage Food Tour. Shanghai Culture and Tourism Promotion Platform. https://cmp.whlyj.sh.gov.cn/CMP/tpr\_view.ac?id=6e09eecec9824e50876b53e10d33a085.

\[2\] Shi, X., Wang, X., Guo, Z., et al. 2026\. Qwen3-ASR Technical Report. arXiv:2601.21337.

\[3\] Radford, A., Kim, J. W., Xu, T., Brockman, G., McLeavey, C., and Sutskever, I. 2023\. Robust Speech Recognition via Large-Scale Weak Supervision. Proceedings of the 40th International Conference on Machine Learning, 28492-28518.

\[4\] Bai, J., Bai, S., Chu, Y., et al. 2023\. Qwen Technical Report. arXiv:2309.16609.

\[5\] Wang, C., Shao, M., Hu, J., et al. 2026\. WenetSpeech-Wu: Datasets, Benchmarks, and Models for a Unified Chinese Wu Dialect Speech Processing Ecosystem. arXiv:2601.11027.

\[6\] Magic Data Technology. n.d. ASR-CShhiDiaCSC: A Chinese Shanghai Dialect Conversational Speech Corpus. MagicHub Dataset.

\[7\] Zhang, B., Lv, H., Guo, P., et al. 2022\. WenetSpeech: A 10000+ Hours Multi-domain Mandarin Corpus for Speech Recognition. Proceedings of ICASSP 2022, 6182-6186. [https://doi.org/10.1109/ICASSP43922.2022.9746682](https://doi.org/10.1109/ICASSP43922.2022.9746682).

Models & Codes

Whisper-medium — [https://huggingface.co/openai/whisper-medium](https://huggingface.co/openai/whisper-medium)  
Qwen3-ASR-1.7B — [https://huggingface.co/Qwen/Qwen3-ASR-1.7B](https://huggingface.co/Qwen/Qwen3-ASR-1.7B) (inference toolkit: [https://github.com/QwenLM/Qwen3-ASR](https://github.com/QwenLM/Qwen3-ASR))  
WenetSpeech-Wu speech understanding models, including Whisper-Medium-Wu — [https://huggingface.co/ASLP-lab/WenetSpeech-Wu-Speech-Understanding](https://huggingface.co/ASLP-lab/WenetSpeech-Wu-Speech-Understanding)  
WenetSpeech-Wu speech generation models, including CosyVoice2-Wu-SFT — [https://huggingface.co/ASLP-lab/WenetSpeech-Wu-Speech-Generation](https://huggingface.co/ASLP-lab/WenetSpeech-Wu-Speech-Generation)  
CosyVoice2-0.5B — [https://huggingface.co/FunAudioLLM/CosyVoice2-0.5B](https://huggingface.co/FunAudioLLM/CosyVoice2-0.5B)  
WenetSpeech-Wu corpus, benchmark, and inference recipes — [https://github.com/ASLP-lab/WenetSpeech-Wu-Repo](https://github.com/ASLP-lab/WenetSpeech-Wu-Repo)  
