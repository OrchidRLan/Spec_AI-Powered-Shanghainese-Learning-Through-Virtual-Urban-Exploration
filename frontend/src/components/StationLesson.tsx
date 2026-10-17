import { useEffect, useRef, useState } from 'react';
import { ArrowRight, BookOpen, Check, CheckCircle2, ChevronLeft, CircleHelp, Compass, Headphones, Mic, PencilLine, RotateCcw, Volume2, XCircle } from 'lucide-react';
import { api, post, ApiError, type Attempt, type LessonRequest, type LessonResponse, type LessonStationId, type Locale } from '../lib/api';
import { stopAllAudio } from '../lib/audio';
import { reviewClipFor } from '../lib/reviewAudio';
import { stationPlanFor, stationEntryFor, stationSummary, type StationPlan } from '../lib/stationContent';
import LearningText, { type LearningEntry } from './LearningText';
import Recorder, { type RecorderPhase } from './Recorder';
import Toggle from './Toggle';
import { StationScene, DishIllustration, CandyIllustration } from './StationScenes';
import type { ScenePose } from './SceneArt';

const copy = {
  zh: { back: '返回地图', skip: '稍后再来', start: '开始交流', saved: '已保存', host: '与你交流', draft: '审阅稿', step: '本题', pick: '我想说', say: '试着这样说', select: '先选择想说的内容。', romanization: '显示拉丁注音', normal: '标准', slow: '慢速', audioPending: '声音待审阅', listen: '听店员介绍', listenAgain: '再听一遍', listenFirst: '先听介绍，选出店员说的口味。', listened: '已听完介绍', showText: '查看介绍文字', introText: '店员刚才说', audioError: '声音暂时无法播放，请重试或查看介绍文字。', result: '这次的练习结果', target: '本题目标', transcript: '识别结果', noTranscript: '未获得识别文字', correct: '正确 · 符合本题目标', incorrect: '不正确 · 与本题目标不符', unrecognized: '未识别到清楚的内容', technical: '暂时无法判定', pending: '正在核对这次回应…', mismatch: '可以再说一次，或用所选答案继续。', wrongFlavor: '这不是刚才介绍的口味。再听一遍，或查看介绍文字后重新选择。', spicy: '这道菜是辣的。请重新选择一道不辣的菜。', next: '下一步', complete: '确认并完成', finishTea: '完成这次品茶', assisted: '用所选答案继续', retry: '再说一次', saving: '正在保存…', unknown: '这次操作的结果还未确认。', recover: '查询结果', cancel: '取消这次操作', cancelled: '已取消，可以重新尝试。', failure: '暂时未能保存，请重试。', changed: '已显示最新保存的练习。', unapplied: '这段转写未应用到当前题目', dismiss: '收起', change: '修改选择', summary: '这次的选择', completed: '这一站完成了', review: '回顾这一站', explore: '继续探索', again: '再练一次', menu: '今日练习菜单', flavors: '梨膏糖的三种口味', route: '查看探索回顾', progress: '播放进度' },
  en: { back: 'Back to the map', skip: 'Come back later', start: 'Start the conversation', saved: 'Saved', host: 'Your local host', draft: 'Review draft', step: 'STEP', pick: 'I want to say', say: 'Try saying this', select: 'Choose what you would like to say.', romanization: 'Show romanization', normal: 'Normal', slow: 'Slow', audioPending: 'Audio pending', listen: 'Listen to the introduction', listenAgain: 'Listen again', listenFirst: 'Listen, then choose the flavor the shopkeeper mentions.', listened: 'Introduction played', showText: 'Show the introduction text', introText: 'The shopkeeper said', audioError: 'Audio could not play. Try again or read the introduction.', result: 'Your practice result', target: 'Your target', transcript: 'Recognized words', noTranscript: 'No transcript was received', correct: 'Correct · Matches your target', incorrect: 'Incorrect · Does not match your target', unrecognized: 'No clear words recognized', technical: 'Unable to check this time', pending: 'Checking your response…', mismatch: 'Try speaking again, or continue with your choice.', wrongFlavor: 'That is not the flavor in the introduction. Listen again, or read the introduction and choose again.', spicy: 'This dish is spicy. Choose a non-spicy dish.', next: 'Next step', complete: 'Confirm & complete', finishTea: 'Finish this tea visit', assisted: 'Continue with my choice', retry: 'Try speaking again', saving: 'Saving…', unknown: 'The result of this operation is not confirmed yet.', recover: 'Check result', cancel: 'Cancel this operation', cancelled: 'Cancelled. You can try again.', failure: 'We could not save this yet. Please try again.', changed: 'Your latest saved practice is shown.', unapplied: 'These words were not applied to the current step', dismiss: 'Dismiss', change: 'Change my choice', summary: 'Your choices', completed: 'This stop is complete', review: 'Review this stop', explore: 'Keep exploring', again: 'Try it again', menu: 'Our practice menu', flavors: 'Three pear candy flavors', route: 'View your journey', progress: 'Playback progress' },
};
type Pending = { requestId: string; operation: LessonRequest['operation']; stepId: string; transcript: string | null; expectedRevision: number; target: string | null };
type Props = {
  station: LessonStationId; attempt: Attempt | null; locale: Locale; romanization: boolean; savingPreferences?: boolean; asrEnabled: boolean; servicesReady: boolean; disabled: boolean; stopSignal: number; audioSpeed: 1 | 0.75; autoVoice: boolean;
  onAttempt: (attempt: Attempt) => void; onStart: (restart?: boolean) => void; onBack: () => void; onSkip: () => void; onReview: () => void;
  onRomanization: () => void; onSpeed: (speed: 1 | 0.75) => void; onBusyChange: (busy: boolean) => void; onDraftChange: (draft: boolean) => void; onPhaseChange: (phase: RecorderPhase) => void; onEvent: (name: string) => void;
};
function storageKey(id: string) { return `shanghai-lesson-pending:${id}`; }
function readPending(id: string): Pending | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(storageKey(id)) || 'null');
    return value && typeof value.requestId === 'string' && typeof value.stepId === 'string' && typeof value.expectedRevision === 'number' && (value.transcript === null || typeof value.transcript === 'string') && ['select', 'evaluate', 'continue', 'edit', 'help', 'listened'].includes(value.operation) ? {...value, target: typeof value.target === 'string' ? value.target : null} : null;
  } catch { return null; }
}
function savePending(id: string, value: Pending | null) {
  try { if (value) sessionStorage.setItem(storageKey(id), JSON.stringify(value)); else sessionStorage.removeItem(storageKey(id)); } catch { /* Server receipts remain authoritative. */ }
}

async function boundedRequest<T>(operation: Promise<T>, controller: AbortController): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject)=> {
      timer = setTimeout(()=>{controller.abort(); reject(new Error('request_timeout'));}, 12000);
    })]);
  } finally { if(timer) clearTimeout(timer); }
}

/** The same saved, explicit-continue lesson interaction powers all three new stops. */
export default function StationLesson(props: Props) {
  const { station, attempt, locale, romanization, asrEnabled, servicesReady, disabled, stopSignal, audioSpeed, autoVoice } = props;
  const plan = stationPlanFor(station);
  if (!attempt || attempt.status === 'skipped' || !attempt.lesson) return <div className={`scene-page page-shell bc-station bc-${station}`}>
    <div className="scene-topline"><button className="text-button" onClick={props.onBack}><ChevronLeft size={18}/>{copy[locale].back}</button></div>
    <div className="scene-heading"><div><span className="eyebrow">YU GARDEN</span><h1>{plan.title[locale]}</h1></div></div>
    <div className="bc-welcome"><StationScene station={station} label={plan.title[locale]}/><div><p>{plan.description[locale]}</p><button className="primary" disabled={disabled || !servicesReady} onClick={()=>props.onStart()}><ArrowRight size={18}/>{copy[locale].start}</button></div></div>
  </div>;
  return <ActiveLesson key={attempt.id} {...props} attempt={attempt} plan={plan} audioSpeed={audioSpeed} autoVoice={autoVoice}/>;
}

function ActiveLesson(props: Props & { attempt: Attempt; plan: StationPlan }) {
  const { attempt, station, plan, locale, romanization, asrEnabled, servicesReady, disabled, stopSignal, audioSpeed, autoVoice, onAttempt, onBusyChange, onDraftChange, onPhaseChange, onEvent } = props;
  const lesson = attempt.lesson!;
  const c = copy[locale];
  const [pending, setPending] = useState<Pending | null>(()=>readPending(attempt.id));
  const pendingRef = useRef(pending); pendingRef.current = pending;
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState<'cancelled' | 'failure' | 'changed' | 'wrongFlavor' | 'spicy' | ''>('');
  const [unapplied, setUnapplied] = useState<string | null>(()=>{try{return sessionStorage.getItem(`shanghai-lesson-unapplied:${attempt.id}`);}catch{return null;}});
  const [retrying, setRetrying] = useState(false);
  const [recorderReset, setRecorderReset] = useState(0);
  const [phase, setPhase] = useState<RecorderPhase>('idle');
  const [playing, setPlaying] = useState<string | null>(null);
  const [audioError, setAudioError] = useState(false);
  const [audioProgress, setAudioProgress] = useState(0);
  const player = useRef<HTMLAudioElement | null>(null);
  const mediaId = useRef<string | null>(null);
  const mediaGeneration = useRef(0);
  const introPlayStarted = useRef(false);
  const activeContinuation = useRef<string | null>(null);
  const closingPlayback = useRef<LearningEntry | null>(null);
  const mounted = useRef(true);
  const generation = useRef(0);
  const inputGeneration = useRef(0);
  const inputTicket = inputGeneration.current;
  const inFlight = useRef(false);
  const requestController = useRef<AbortController | null>(null);
  const latest = useRef(props); latest.current = props;
  const currentKey = `${attempt.id}:${lesson.step_id}:${lesson.target}`;
  const keyRef = useRef(currentKey); keyRef.current = currentKey;
  const step = plan.steps.find(value=>value.id === lesson.step) || plan.steps[plan.steps.length - 1];
  const stepIndex = plan.steps.indexOf(step);
  const target = step.options.find(option=>option.id === lesson.target);
  const targetEntry = target ? stationEntryFor(target.entryId) : null;
  const result = retrying ? null : lesson.result;
  const pendingEvaluation = pending?.operation === 'evaluate' && pending.stepId === lesson.step_id && pending.target === lesson.target ? pending : null;
  const blocked = disabled || !servicesReady || working || Boolean(pending);
  const captureActive = phase === 'recording' || phase === 'processing';
  const listening = lesson.listening;
  const listenGate = station === 'candy' && lesson.step === 'flavor';
  const canPractise = !listenGate || Boolean(listening?.played || listening?.text_revealed);
  const completed = attempt.status === 'completed';
  const summary = stationSummary(station, lesson.answers, locale);
  const summaryEntryId = step.summaryEntryIds?.[lesson.answers.dish || lesson.answers.flavor];
  const hostEntry = stationEntryFor(completed ? plan.completedEntryId : summaryEntryId || attempt.prompt_id) || stationEntryFor(step.hostEntryId);
  const pose: ScenePose = playing ? 'speaking' : completed ? 'packed' : phase === 'recording' || phase === 'playback' ? 'listening' : working || phase === 'processing' ? 'thinking' : lesson.step === 'confirm' ? 'checking' : 'idle';

  function stopAudio() { mediaGeneration.current += 1; introPlayStarted.current = false; activeContinuation.current = null; closingPlayback.current = null; stopAllAudio(); setPlaying(null); }
  useEffect(()=> {
    mounted.current = true;
    return ()=> { mounted.current = false; generation.current += 1; mediaGeneration.current += 1; requestController.current?.abort(); inFlight.current = false; stopAllAudio(); latest.current.onBusyChange(false); latest.current.onDraftChange(false); latest.current.onPhaseChange('idle'); };
  }, []);
  useEffect(()=> { setRetrying(false); setRecorderReset(value=>value + 1); setMessage(''); }, [currentKey]);
  useEffect(()=> { stopAudio(); setAudioError(false); }, [locale, stopSignal]);
  useEffect(()=> { if(!autoVoice) stopAudio(); }, [autoVoice]);
  useEffect(()=> { if(player.current) { player.current.playbackRate = audioSpeed; player.current.preservesPitch = true; } }, [audioSpeed]);
  useEffect(()=> {
    if (pending && (lesson.result?.request_id === pending.requestId || (attempt.revision > pending.expectedRevision && lesson.step_id !== pending.stepId))) {
      if(pending.operation === 'evaluate' && lesson.result?.request_id !== pending.requestId) keepUnapplied(pending.transcript);
      updatePending(null);
    }
    if(pending?.operation === 'evaluate' && pending.target !== lesson.target) keepUnapplied(pending.transcript);
  }, [attempt.revision, lesson.step_id, lesson.target, lesson.result?.request_id, pending]);
  useEffect(()=> {
    if (!autoVoice || !hostEntry || lesson.result || completed || listenGate) return;
    const mediaTicket = mediaGeneration.current;
    const timer = setTimeout(()=>{ if(latest.current.autoVoice && !pendingRef.current && mediaTicket === mediaGeneration.current && latest.current.attempt.status !== 'completed' && !latest.current.attempt.lesson?.result) void playEntry(hostEntry); }, 350);
    return ()=>clearTimeout(timer);
  }, [lesson.step_id, autoVoice, completed]);
  useEffect(()=> {
    const entry = closingPlayback.current;
    if(!entry || !completed || blocked) return;
    // Consume this local completion event once. A restored completed attempt has
    // no such event, and manual playback or navigation cancels the pending sound.
    closingPlayback.current = null;
    if(autoVoice) void playEntry(entry);
  }, [completed, blocked, autoVoice]);

  function updatePending(value: Pending | null) { pendingRef.current = value; setPending(value); savePending(attempt.id, value); }
  function keepUnapplied(value: string | null) { if(!value?.trim()) return; setUnapplied(value); try{sessionStorage.setItem(`shanghai-lesson-unapplied:${attempt.id}`,value);}catch{} }
  function dismissUnapplied() {setUnapplied(null);try{sessionStorage.removeItem(`shanghai-lesson-unapplied:${attempt.id}`);}catch{}}
  function setBusy(value: boolean) { setWorking(value); onBusyChange(value); }
  function accept(response: LessonResponse, operation: LessonRequest['operation']) {
    inputGeneration.current += 1;
    if (response.attempt.id !== latest.current.attempt.id || response.attempt.revision < latest.current.attempt.revision) { keepUnapplied(pendingRef.current?.transcript || null); updatePending(null); setRetrying(false); setMessage('changed'); return; }
    const receipt = pendingRef.current;
    if(operation === 'continue' && response.status === 'applied' && response.attempt.status === 'completed' && latest.current.attempt.status !== 'completed'
      && response.request_id === activeContinuation.current && receipt?.requestId === response.request_id
      && receipt.expectedRevision === latest.current.attempt.revision && receipt.stepId === latest.current.attempt.lesson?.step_id
      && response.attempt.revision > latest.current.attempt.revision && latest.current.autoVoice) {
      closingPlayback.current = stationEntryFor(plan.completedEntryId) || null;
    }
    activeContinuation.current = null;
    onAttempt(response.attempt); updatePending(null); setRetrying(false); setRecorderReset(value=>value + 1); onDraftChange(false);
    setMessage(response.status === 'cancelled' ? 'cancelled' : '');
    if (operation === 'continue' || operation === 'edit') document.getElementById('bc-current-turn')?.scrollIntoView({ block: 'start', behavior: 'auto' });
  }
  async function request(change: Omit<LessonRequest, 'request_id' | 'expected_revision'>, sourceKey = keyRef.current) {
    if(!mounted.current || sourceKey !== keyRef.current || inFlight.current || pendingRef.current || latest.current.disabled || !latest.current.servicesReady) return;
    inFlight.current = true; stopAudio(); setBusy(true); setMessage('');
    const body: LessonRequest = { request_id: crypto.randomUUID(), expected_revision: latest.current.attempt.revision, ...change };
    const receipt: Pending = { requestId: body.request_id, operation: body.operation, stepId: lesson.step_id, transcript: body.text ?? null, expectedRevision: body.expected_revision, target: lesson.target };
    if(body.operation === 'continue') activeContinuation.current = body.request_id;
    updatePending(receipt);
    const ticket = ++generation.current;
    const controller = new AbortController(); requestController.current = controller;
    try {
      const response = await boundedRequest(post<LessonResponse>(`/attempts/${attempt.id}/lesson`, body, controller.signal), controller);
      if(!mounted.current || ticket !== generation.current) return;
      if(sourceKey !== keyRef.current) { keepUnapplied(receipt.transcript); updatePending(null); setMessage('changed'); return; }
      accept(response, body.operation);
    } catch(cause) {
      if(!mounted.current || ticket !== generation.current) return;
      if(cause instanceof ApiError && cause.attempt) {
        inputGeneration.current += 1; keepUnapplied(receipt.transcript);
        if(cause.attempt.id === latest.current.attempt.id && cause.attempt.revision >= latest.current.attempt.revision) onAttempt(cause.attempt);
        updatePending(null); setRetrying(false); setRecorderReset(value=>value + 1); setMessage(cause.code === 'lesson_task_mismatch' ? station === 'candy' ? 'wrongFlavor' : 'spicy' : 'changed');
      } else if(cause instanceof ApiError && cause.terminal) { inputGeneration.current += 1; keepUnapplied(receipt.transcript); updatePending(null); setMessage('failure'); }
      else setMessage('failure');
    } finally { if(mounted.current && ticket === generation.current) { inFlight.current = false; setBusy(false); } }
  }
  async function recover(cancel = false) {
    if(!pending || inFlight.current) return;
    inFlight.current = true; setBusy(true); setMessage('');
    const snapshot = pending; const ticket = ++generation.current;
    const controller = new AbortController(); requestController.current = controller;
    try {
      const path = `/attempts/${attempt.id}/lesson/${snapshot.requestId}`;
      const response = await boundedRequest(cancel ? post<LessonResponse>(`${path}/cancel`, { expected_revision: latest.current.attempt.revision }, controller.signal) : api<LessonResponse>(path, {signal:controller.signal}), controller);
      if(mounted.current && ticket === generation.current) accept(response, snapshot.operation);
    } catch(cause) {
      if(!mounted.current || ticket !== generation.current) return;
      if(cause instanceof ApiError && cause.attempt) { inputGeneration.current += 1; keepUnapplied(snapshot.transcript); if(cause.attempt.id === latest.current.attempt.id && cause.attempt.revision >= latest.current.attempt.revision) onAttempt(cause.attempt); updatePending(null); setRetrying(false); setMessage('changed'); }
      else setMessage('failure');
    } finally { if(mounted.current && ticket === generation.current) { inFlight.current = false; setBusy(false); } }
  }
  async function playSource(source: string, id: string) {
    if(captureActive || blocked || !player.current) return;
    stopAudio(); setAudioError(false); setAudioProgress(0);
    const ticket = mediaGeneration.current;
    mediaId.current = id; player.current.src = source; player.current.playbackRate = audioSpeed; player.current.preservesPitch = true;
    try { await player.current.play(); }
    catch { if(mounted.current && ticket === mediaGeneration.current) { introPlayStarted.current = false; setPlaying(null); setAudioError(true); } }
  }
  function playEntry(entry: LearningEntry) { const clip = reviewClipFor(entry); if(clip) return playSource(clip.file, entry.id); setAudioError(true); }
  function listenButton(entry: LearningEntry) { return <button type="button" className={`sentence-listen ${playing === entry.id ? 'is-playing' : ''}`} disabled={!reviewClipFor(entry) || blocked || captureActive} onClick={()=>void playEntry(entry)} aria-label={`${locale === 'zh' ? '试听' : 'Listen to'} ${entry.hanzi}`}><Volume2 size={18}/><span>{reviewClipFor(entry) ? audioSpeed === 1 ? c.normal : c.slow : c.audioPending}</span></button>; }
  function continueLesson(assisted = false) {
    if(blocked || !lesson.target || (assisted ? !lesson.can_choose : result?.status !== 'correct')) return;
    void request({ operation: 'continue', assisted, ...(lesson.result ? { result_request_id: lesson.result.request_id } : {}) });
  }
  function fail(reason: 'recognition' | 'technical', detail?: { requestId?: string }) {
    if(keyRef.current !== currentKey || inputTicket !== inputGeneration.current || result || pendingRef.current || !lesson.target) return;
    void request({ operation: 'evaluate', failure_kind: reason, ...(detail?.requestId ? { asr_request_id: detail.requestId } : {}) });
  }
  const displayStatus = pendingEvaluation ? 'pending' : result?.status;
  const displayTranscript = pendingEvaluation ? pendingEvaluation.transcript : result?.transcript;
  const wrongTask = lesson.result?.task_matches === false || ['wrong_flavor', 'flavor_mismatch', 'spicy_dish', 'task_mismatch', 'dish_preference_mismatch'].includes(lesson.result?.reason || '') || (lesson.step === 'dish' && lesson.target === 'tofu');
  const finalStep = stepIndex === plan.steps.length - 1;
  const nextLabel = finalStep ? station === 'teahouse' ? c.finishTea : c.complete : c.next;
  const showResult = Boolean(result || pendingEvaluation);

  return <div className={`scene-page page-shell bc-station bc-${station}`}>
    <audio ref={player} className="sr-only" preload="none"
      onPlay={()=>{setPlaying(mediaId.current); if(mediaId.current === 'introduction') introPlayStarted.current = true;}}
      onPause={()=>setPlaying(null)} onTimeUpdate={()=>{if(player.current?.duration) setAudioProgress(player.current.currentTime / player.current.duration);}}
      onError={()=>{introPlayStarted.current = false; setPlaying(null); setAudioError(true);}}
      onEnded={()=>{const completedIntroduction = mediaId.current === 'introduction' && introPlayStarted.current; introPlayStarted.current = false; setPlaying(null); if(completedIntroduction && !latest.current.attempt.lesson?.listening?.played) void request({ operation: 'listened' });}}/>
    <div className="scene-topline"><button className="text-button" onClick={props.onBack}><ChevronLeft size={18}/>{c.back}</button><span className="scene-breadcrumb">YU GARDEN <span>/</span> {plan.shortTitle[locale]}</span><button className="text-button" disabled={blocked || completed} onClick={props.onSkip}>{c.skip}<ArrowRight size={16}/></button></div>
    <div className="scene-heading"><div><span className="eyebrow">{plan.theme[locale]}</span><h1>{plan.title[locale]}</h1></div></div>
    <div className="r1-conversation-grid bc-conversation-grid">
      <section className="bc-stage-column" aria-label={plan.title[locale]}>
        <div className="r1-scene-stage bc-scene-stage"><StationScene station={station} pose={pose} selectedDish={lesson.answers.dish || null} selectedFlavor={lesson.answers.flavor || null} completed={completed} label={plan.title[locale]}/><div className="r1-scene-status"><span className={`phase-dot phase-${pose}`}/>{playing ? locale === 'zh' ? '店员正在说话' : 'Your host is speaking' : completed ? c.saved : phase === 'recording' ? locale === 'zh' ? '店员在听' : 'Your host is listening' : locale === 'zh' ? '轮到你回应' : 'Your turn'}</div></div>
        <p className="bc-mission">{plan.description[locale]}</p>
        {summary && <section className="bc-saved-summary"><span className="overline">{c.summary}</span><strong>{summary}</strong><small><Check size={14}/>{c.saved}</small></section>}
        {station === 'restaurant' && <section className="bc-display"><h2>{c.menu}</h2><div>{plan.items.map(item=><article key={item.id}><DishIllustration dish={item.id} label={item.title[locale]}/><div><strong>{item.title[locale]}</strong><p>{item.description[locale]}</p></div></article>)}</div></section>}
        {station === 'candy' && <section className="bc-display"><h2>{c.flavors}</h2><div>{plan.items.map(item=><article key={item.id}><CandyIllustration flavor={item.id} label={item.title[locale]}/><div><strong>{item.title[locale]}</strong><p>{item.description[locale]}</p></div></article>)}</div></section>}
      </section>
      <section className="r1-turn-panel bc-turn-panel" id="bc-current-turn" aria-label={c.host}>
        <div className="r1-turn-heading"><span className="overline">{c.host}</span><span className="review-label">{c.draft}</span></div>
        {hostEntry && <div className="r1-question"><LearningText entry={hostEntry} locale={locale} romanization={romanization}/>{listenButton(hostEntry)}</div>}
        {lesson.step === 'confirm' && !completed && summary && <div className="bc-confirm-summary"><span>{c.summary}</span><strong>{summary}</strong></div>}
        <div className="r1-reading-tools"><Toggle checked={romanization} disabled={props.savingPreferences} onChange={props.onRomanization} label={c.romanization} showLabel/><div className="r2-speed" role="group" aria-label={locale === 'zh' ? '播放速度' : 'Playback speed'}>{([1,0.75] as const).map(speed=><button key={speed} aria-pressed={audioSpeed === speed} disabled={captureActive} onClick={()=>props.onSpeed(speed)}>{speed === 1 ? c.normal : c.slow}<small>{speed}×</small></button>)}</div></div>
        {completed ? <div className="r1-completed bc-completed"><CheckCircle2 size={32}/><h2>{c.completed}</h2><p>{plan.completion[locale]}</p><div className="r1-completed-actions r4-completed-actions"><button className="primary" onClick={props.onReview}><BookOpen size={18}/><span>{c.review}</span></button><button className="secondary" onClick={props.onBack}><Compass size={18}/><span>{c.explore}</span></button><button className="text-button" disabled={blocked} onClick={()=>props.onStart(true)}><RotateCcw size={18}/><span>{c.again}</span></button></div></div> : <div className="r3-practice" data-lesson-step={lesson.step}>
          <div className="r3-step-heading"><span>{c.step} {stepIndex + 1} / {plan.steps.length}</span><strong>{step.title[locale]}</strong><div aria-hidden="true">{plan.steps.map((value,index)=><i key={value.id} className={index <= stepIndex ? 'done' : ''}/>)}</div></div>
          {unapplied && <aside className="r3-pending" role="status"><strong>{c.unapplied}</strong><p>{unapplied}</p><button className="text-button" onClick={dismissUnapplied}>{c.dismiss}</button></aside>}
          {listenGate && listening && <section className="bc-listening" aria-label={c.listen}><Headphones size={28}/><p>{c.listenFirst}</p><button className="primary full" disabled={blocked || captureActive} data-lesson-action="listen" onClick={()=>void playSource(listening.audio_url, 'introduction')}><Volume2 size={19}/>{listening.played ? c.listenAgain : c.listen}</button>{playing === 'introduction' && <progress max={1} value={audioProgress} aria-label={c.progress}/>}<div className="bc-listening-actions">{listening.played && <small><Check size={15}/>{c.listened}</small>}<button className="text-button" data-lesson-action="help" disabled={blocked || captureActive || listening.text_revealed} onClick={()=>void request({operation:'help'})}><BookOpen size={16}/>{c.showText}</button></div>{listening.text_revealed && listening.introduction_text_id && stationEntryFor(listening.introduction_text_id) && <div className="bc-introduction-text"><span className="overline">{c.introText}</span><LearningText entry={stationEntryFor(listening.introduction_text_id)!} locale={locale} romanization={romanization}/></div>}</section>}
          <div className={`r2-practice-picker bc-picker ${step.id === 'dish' || step.id === 'flavor' ? 'bc-picture-picker' : ''}`}><span className="overline">{c.pick}</span><div>{step.options.map(option=>{const entry = stationEntryFor(option.entryId)!; const chosen = lesson.target === option.id; const item = plan.items.find(value=>value.id === option.id); return <button type="button" key={option.id} data-lesson-action={`select:${option.id}`} aria-pressed={chosen} className={chosen ? 'selected' : ''} disabled={blocked || captureActive || !canPractise} onClick={()=>{if(!chosen) void request({operation:'select',option_id:option.id});}}>{step.id === 'dish' && <DishIllustration dish={option.id}/>} {step.id === 'flavor' && <CandyIllustration flavor={option.id}/>}<span>{item?.title[locale] || entry.meaning[locale]}</span>{chosen && <Check size={16}/>}</button>;})}</div></div>
          {targetEntry && canPractise ? <>
            {!showResult && <div className="r1-speaking-example"><span className="overline">{c.say}</span><LearningText entry={targetEntry} locale={locale} romanization={romanization}/>{listenButton(targetEntry)}</div>}
            {showResult ? <section className={`r3-result r3-result-${displayStatus}`} data-testid="lesson-result" data-result-status={displayStatus} aria-live="polite" aria-atomic="true"><div className="r3-result-heading">{displayStatus === 'correct' ? <CheckCircle2 size={24}/> : displayStatus === 'incorrect' ? <XCircle size={24}/> : <CircleHelp size={24}/>}<div><span>{c.result}</span><h2>{c[displayStatus as 'correct'|'incorrect'|'unrecognized'|'technical'|'pending']}</h2></div></div><div className="r3-result-target"><span className="overline">{c.target}</span><LearningText entry={targetEntry} locale={locale} romanization={romanization} compact/>{listenButton(targetEntry)}</div><div className="r3-transcript"><span>{c.transcript}</span><p data-testid="lesson-transcript" className={displayTranscript?.trim() ? '' : 'empty'}>{displayTranscript?.trim() ? displayTranscript : c.noTranscript}</p></div>{result && result.status !== 'correct' && <p className="r3-result-explanation">{wrongTask ? station === 'candy' ? c.wrongFlavor : c.spicy : c.mismatch}</p>}{!pending && result && <div className="r3-result-actions">{result.status === 'correct' ? <button className="primary full" disabled={blocked} data-lesson-action="continue" onClick={()=>continueLesson()}>{nextLabel}<ArrowRight size={18}/></button> : <><button className="secondary full" disabled={blocked} data-lesson-action="retry" onClick={()=>{stopAudio();inputGeneration.current += 1;setRetrying(true);setRecorderReset(value=>value + 1);}}><RotateCcw size={17}/>{c.retry}</button>{!wrongTask && <button className="primary full" disabled={blocked || !lesson.can_choose} data-lesson-action="assisted" onClick={()=>continueLesson(true)}>{c.assisted}<ArrowRight size={18}/></button>}</>}</div>}</section> : <>
              {servicesReady && <Recorder key={currentKey} locale={locale} enabled={asrEnabled} disabled={blocked} stopSignal={stopSignal} resetSignal={recorderReset} onPhaseChange={next=>{if(next === 'recording') stopAudio();setPhase(next);onPhaseChange(next);}} onDraftChange={onDraftChange} onEvent={onEvent} onTranscript={(text,requestId)=>{if(keyRef.current !== currentKey || inputTicket !== inputGeneration.current) return;onDraftChange(false);void request({operation:'evaluate',text,asr_request_id:requestId},currentKey);}} onFailure={fail}/>}
              {lesson.can_choose && !wrongTask && <div className="r3-choice-assistance"><button className="secondary full" disabled={blocked || captureActive} data-lesson-action="assisted" onClick={()=>continueLesson(true)}>{c.assisted}<ArrowRight size={18}/></button></div>}
            </>}
          </> : canPractise && <div className="r2-select-first"><Mic size={23}/><p>{c.select}</p></div>}
          {lesson.step === 'confirm' && <div className="r3-edit-order"><span><PencilLine size={15}/>{c.change}</span><div>{plan.steps.filter(value=>['dish','flavor','quantity'].includes(value.id)).map(value=><button className="text-button" key={value.id} disabled={blocked || captureActive} data-lesson-action={`edit:${value.id}`} onClick={()=>void request({operation:'edit',step:value.id})}>{value.title[locale]}</button>)}</div></div>}
          {pending && !working && <div className="r3-pending" role="status"><p>{c.unknown}</p><div><button className="secondary" data-lesson-action="recover" onClick={()=>void recover()}>{c.recover}</button><button className="text-button" data-lesson-action="cancel" onClick={()=>void recover(true)}>{c.cancel}</button></div></div>}
          {working && <div className="processing-bar" role="status"><span className="spinner"/>{c.saving}</div>}
          {message && !pending && <p className="r3-save-notice" role="status">{c[message]}</p>}
        </div>}
        {audioError && <p className="audio-notice" role="status">{c.audioError}</p>}
      </section>
    </div>
  </div>;
}
