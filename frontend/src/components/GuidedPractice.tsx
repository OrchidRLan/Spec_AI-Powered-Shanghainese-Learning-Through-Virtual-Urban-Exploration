import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowRight, Check, CheckCircle2, CircleHelp, Mic, PencilLine, RotateCcw, XCircle } from 'lucide-react';
import { api, post, ApiError, type Action, type Attempt, type Locale, type PracticeRequest, type PracticeResponse, type PracticeResult, type PracticeStep } from '../lib/api';
import LearningText, { type LearningEntry } from './LearningText';
import Recorder, { type RecorderPhase } from './Recorder';

const copy = {
  zh: {
    steps: ['商品', '数量', '用餐方式', '核对订单'], step: '本题', pick: '我想说', pickHint: '先选想练习的表达，再开口说。选择不会立即写入订单。',
    say: '试着这样说', selectFirst: '先选择上面的内容，就可以听示范、开口练习。', first: '先开口试一次。没听清或表达不符时，可以用所选答案继续。',
    result: '这次的练习结果', target: '本题目标', transcript: '识别结果', correct: '正确 · 符合本题目标', incorrect: '不正确 · 与本题目标不符',
    unrecognized: '未识别到清楚的内容', technical: '暂时无法判定', checking: '正在核对这次回应…', noTranscript: '未获得识别文字',
    matched: '系统理解到了你选择的表达。点击下一步继续。', confirmMatched: '系统理解到了你的确认。点击下方按钮完成点单。',
    mismatch: '识别结果与本题目标不符。可以再说一次，或用所选答案继续。', quantity: '识别结果与所选份数不符。', mode: '识别结果与所选用餐方式不符。',
    item: '识别结果与本题商品不符。', confirmation: '这次没有识别到明确的确认。', ambiguous: '这次回应中有冲突或不明确的表达。', notUnderstood: '识别到了上面的文字，但未能理解为本题表达。',
    noSpeech: '这次没有获得清楚的转写，可以重试或用所选答案继续。', unavailable: '语音服务或设备暂时不可用，可以重试或用所选答案继续。',
    scope: '这里核对的是本题表达，不是逐字发音评分。', next: '下一步', complete: '确认并完成', assisted: '用所选答案继续', assistedComplete: '用所选答案确认并完成',
    retry: '再说一次', saving: '正在保存…', pending: '这次保存的结果还未确认。请查询结果，或取消后重新尝试。', recover: '查询结果', cancel: '取消这次操作',
    cancelled: '这次操作已取消，可以重新尝试。', failure: '暂时未能保存，请重试。', changed: '练习已更新，已显示最新结果。',
    unapplied: '这次识别没有应用', unappliedNote: '练习或保存状态已发生变化，这段转写没有作为当前题目的答案。请按当前目标重新练习。', dismiss: '知道了',
    edit: '修改订单', editQuantity: '修改数量', editMode: '修改用餐方式', chooseHint: '选择辅助已开放；你也可以换一个目标继续练习。',
  },
  en: {
    steps: ['Item', 'Quantity', 'Dining choice', 'Confirm order'], step: 'STEP', pick: 'I want to say', pickHint: 'Choose what to practise, then say it. Choosing alone does not change your order.',
    say: 'Try saying this', selectFirst: 'Choose an expression above to listen and practise speaking.', first: 'Try speaking first. If we cannot understand your response, you can continue with your choice.',
    result: 'Your practice result', target: 'Your target', transcript: 'Recognized words', correct: 'Correct · Matches your target', incorrect: 'Incorrect · Does not match your target',
    unrecognized: 'No clear words recognized', technical: 'Unable to check this time', checking: 'Checking your response…', noTranscript: 'No transcript was received',
    matched: 'We understood the expression you chose. Select Next step to continue.', confirmMatched: 'We understood your confirmation. Use the button below to complete your order.',
    mismatch: 'The recognized words do not match your target. Try again or continue with your choice.', quantity: 'The recognized quantity does not match your choice.', mode: 'The recognized dining choice does not match your choice.',
    item: 'The recognized item does not match this target.', confirmation: 'We did not recognize a clear confirmation this time.', ambiguous: 'The response contains conflicting or unclear expressions.', notUnderstood: 'We received the words above but could not understand them as the target expression.',
    noSpeech: 'No clear transcript was received. Try again or continue with your choice.', unavailable: 'Speech recognition or your device is unavailable. Try again or continue with your choice.',
    scope: 'This checks the expression for this step, not individual pronunciation.', next: 'Next step', complete: 'Confirm & complete', assisted: 'Continue with my choice', assistedComplete: 'Confirm & complete with my choice',
    retry: 'Try speaking again', saving: 'Saving…', pending: 'The outcome of this save is not confirmed. Check its result, or cancel before trying again.', recover: 'Check result', cancel: 'Cancel this operation',
    cancelled: 'This operation was cancelled. You can try again.', failure: 'We could not save this yet. Please try again.', changed: 'The practice has changed. The latest result is now shown.',
    unapplied: 'This transcript was not applied', unappliedNote: 'The practice or save state changed. These words were not used as an answer to the current step. Please practise the current target again.', dismiss: 'Got it',
    edit: 'Change my order', editQuantity: 'Change quantity', editMode: 'Change dining choice', chooseHint: 'Choice assistance is available. You can also select a different target to practise.',
  },
};

const practiceOptions: Record<PracticeStep, { id: string; action: Action }[]> = {
  item: [{ id: 'NX-ITEM-XLB', action: { type: 'set_order', item: 'xiaolongbao' } }],
  quantity: [1, 2, 3].map(quantity => ({ id: `NX-Q${quantity}`, action: { type: 'set_order', quantity, unit: 'serving' } })),
  mode: [{ id: 'NX-MODE-HERE', action: { type: 'set_order', takeaway: false } }, { id: 'E09', action: { type: 'set_order', takeaway: true } }],
  confirm: [{ id: 'E05', action: { type: 'confirm' } }],
};
type Pending = { requestId: string; operation: PracticeRequest['operation']; stepId: string; transcript: string | null; expectedRevision: number };
type Unapplied = { transcript: string; target: string };
type Props = {
  attempt: Attempt; locale: Locale; romanization: boolean; asrEnabled: boolean; servicesReady: boolean; disabled?: boolean; stopSignal: number;
  entries: LearningEntry[]; listenButton: (entry: LearningEntry) => ReactNode; onAttempt: (next: Attempt) => void; onAdvanced: (next: Attempt) => void;
  onBusyChange: (busy: boolean) => void; onDraftChange: (draft: boolean) => void; onPhaseChange: (phase: RecorderPhase) => void; onBeforeMedia: () => void; onEvent: (name: string) => void;
};

function sameTarget(left: Action | null, right: Action) {
  return left?.type === right.type && Object.entries(right).every(([key, value]) => (left as unknown as Record<string, unknown>)[key] === value);
}
function storageKey(attemptId: string) { return `shanghai-practice-pending:${attemptId}`; }
function readPending(attemptId: string): Pending | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(storageKey(attemptId)) || 'null');
    return value && typeof value.requestId === 'string' && typeof value.stepId === 'string' && typeof value.expectedRevision === 'number' && (value.transcript === null || typeof value.transcript === 'string')
      && ['select', 'evaluate', 'continue', 'edit'].includes(value.operation) ? value : null;
  } catch { return null; }
}
function savePending(attemptId: string, value: Pending | null) {
  try { if(value) sessionStorage.setItem(storageKey(attemptId), JSON.stringify(value)); else sessionStorage.removeItem(storageKey(attemptId)); } catch { /* The server still keeps completed results. */ }
}
function readUnapplied(attemptId: string): Unapplied | null {
  try { const value = JSON.parse(sessionStorage.getItem(`shanghai-practice-unapplied:${attemptId}`) || 'null'); return typeof value?.transcript === 'string' && typeof value?.target === 'string' ? value : null; } catch { return null; }
}

export default function GuidedPractice(props: Props) {
  const { attempt, locale, romanization, asrEnabled, servicesReady, disabled = false, stopSignal, entries, listenButton, onAttempt, onAdvanced, onBusyChange, onDraftChange, onPhaseChange, onBeforeMedia, onEvent } = props;
  const practice = attempt.practice!;
  const [pending, setPending] = useState<Pending | null>(() => readPending(attempt.id));
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const [working, setWorking] = useState(false);
  const [unapplied, setUnapplied] = useState<Unapplied | null>(() => readUnapplied(attempt.id));
  const [message, setMessage] = useState<'cancelled' | 'failure' | 'changed' | ''>('');
  const [retrying, setRetrying] = useState(false);
  const [recorderReset, setRecorderReset] = useState(0);
  const [phase, setPhase] = useState<RecorderPhase>('idle');
  const mounted = useRef(true);
  const generation = useRef(0);
  const inFlight = useRef(false);
  const inputGeneration = useRef(0);
  const inputTicket = inputGeneration.current;
  const requestController = useRef<AbortController | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const currentKey = `${attempt.id}:${practice.step_id}:${JSON.stringify(practice.target)}`;
  const keyRef = useRef(currentKey);
  keyRef.current = currentKey;
  const c = copy[locale];
  const index = ['item', 'quantity', 'mode', 'confirm'].indexOf(practice.step);
  const options = practiceOptions[practice.step];
  const selected = options.find(option => sameTarget(practice.target, option.action));
  const targetEntry = selected ? entries.find(entry => entry.id === selected.id) : null;
  const result = retrying ? null : practice.result;
  const pendingEvaluation = pending?.operation === 'evaluate' && pending.stepId === practice.step_id ? pending : null;
  const blocked = disabled || !servicesReady || working || Boolean(pending);
  const captureActive = phase === 'recording' || phase === 'processing';

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false; generation.current += 1; requestController.current?.abort(); inFlight.current = false;
      latest.current.onBusyChange(false); latest.current.onDraftChange(false); latest.current.onPhaseChange('idle');
    };
  }, []);
  useEffect(() => { setRetrying(false); setRecorderReset(value => value + 1); setMessage(''); }, [currentKey]);
  // A successful response may have been saved just before a refresh. The loaded
  // server result is authoritative; a local receipt must not hide it.
  useEffect(() => {
    if (pending && (practice.result?.request_id === pending.requestId
      || (attempt.revision > pending.expectedRevision && practice.step_id !== pending.stepId))) {
      pendingRef.current = null; setPending(null); savePending(attempt.id, null);
    }
  }, [attempt.id, attempt.revision, practice.step_id, practice.result?.request_id, pending]);

  function updatePending(value: Pending | null) { pendingRef.current = value; setPending(value); savePending(attempt.id, value); }
  function keepUnapplied(transcript: string | null) {
    if (!transcript?.trim()) return;
    const value = { transcript, target: targetEntry?.hanzi || targetEntry?.meaning[locale] || '' };
    setUnapplied(value);
    try { sessionStorage.setItem(`shanghai-practice-unapplied:${attempt.id}`, JSON.stringify(value)); } catch { /* Keep the original text in memory. */ }
  }
  function dismissUnapplied() { setUnapplied(null); try { sessionStorage.removeItem(`shanghai-practice-unapplied:${attempt.id}`); } catch { /* The current view is already cleared. */ } }
  function setBusy(value: boolean) { setWorking(value); onBusyChange(value); }
  function accept(response: PracticeResponse, operation: PracticeRequest['operation']) {
    inputGeneration.current += 1;
    if (response.attempt.id !== latest.current.attempt.id || response.attempt.revision < latest.current.attempt.revision) { updatePending(null); setRetrying(false); setMessage('changed'); return; }
    onAttempt(response.attempt); updatePending(null); setRetrying(false); setRecorderReset(value => value + 1); onDraftChange(false);
    setMessage(response.status === 'cancelled' ? 'cancelled' : '');
    if (response.status === 'applied' && (operation === 'continue' || operation === 'edit')) onAdvanced(response.attempt);
  }
  async function request(change: Omit<PracticeRequest, 'request_id' | 'expected_revision'>, sourceKey = keyRef.current) {
    if (!mounted.current || sourceKey !== keyRef.current || inFlight.current || pendingRef.current || latest.current.disabled || !latest.current.servicesReady) return;
    inFlight.current = true; onBeforeMedia(); setBusy(true); setMessage('');
    const body: PracticeRequest = { request_id: crypto.randomUUID(), expected_revision: latest.current.attempt.revision, ...change };
    const receipt: Pending = { requestId: body.request_id, operation: body.operation, stepId: practice.step_id, transcript: body.text ?? null, expectedRevision: body.expected_revision };
    updatePending(receipt);
    const ticket = ++generation.current;
    const controller = new AbortController(); requestController.current = controller;
    try {
      const response = await post<PracticeResponse>(`/attempts/${attempt.id}/practice`, body, controller.signal);
      if (!mounted.current || ticket !== generation.current) return;
      if (sourceKey !== keyRef.current) { keepUnapplied(receipt.transcript); updatePending(null); setMessage('changed'); return; }
      accept(response, body.operation);
    } catch (cause) {
      if (!mounted.current || ticket !== generation.current) return;
      if (cause instanceof ApiError && cause.attempt) { inputGeneration.current += 1; keepUnapplied(receipt.transcript); if(cause.attempt.id === latest.current.attempt.id && cause.attempt.revision >= latest.current.attempt.revision) onAttempt(cause.attempt); updatePending(null); setRetrying(false); setRecorderReset(value => value + 1); setMessage('changed'); }
      else if (cause instanceof ApiError && cause.terminal) { inputGeneration.current += 1; keepUnapplied(receipt.transcript); updatePending(null); setMessage('failure'); }
      else setMessage('failure');
    } finally {
      if (mounted.current && ticket === generation.current) { inFlight.current = false; setBusy(false); }
    }
  }
  async function recover(cancel = false) {
    if (!pending || inFlight.current) return;
    inFlight.current = true; setBusy(true); setMessage('');
    const snapshot = pending;
    const ticket = ++generation.current;
    try {
      const path = `/attempts/${attempt.id}/practice/${snapshot.requestId}`;
      const response = cancel ? await post<PracticeResponse>(`${path}/cancel`, { expected_revision: latest.current.attempt.revision }) : await api<PracticeResponse>(path);
      if (!mounted.current || ticket !== generation.current) return;
      accept(response, snapshot.operation);
    } catch (cause) {
      if (!mounted.current || ticket !== generation.current) return;
      if (cause instanceof ApiError && cause.attempt) { inputGeneration.current += 1; keepUnapplied(snapshot.transcript); if(cause.attempt.id === latest.current.attempt.id && cause.attempt.revision >= latest.current.attempt.revision) onAttempt(cause.attempt); updatePending(null); setRetrying(false); setRecorderReset(value => value + 1); setMessage('changed'); }
      else setMessage('failure');
    } finally { if (mounted.current && ticket === generation.current) { inFlight.current = false; setBusy(false); } }
  }
  function select(id: string) {
    const option = options.find(value => value.id === id);
    if (!option || blocked || captureActive || sameTarget(practice.target, option.action)) return;
    void request({ operation: 'select', action: option.action });
  }
  function failure(reason: 'recognition' | 'technical', detail?: { message?: string; requestId?: string }, sourceKey = currentKey) {
    if (sourceKey !== keyRef.current || inputTicket !== inputGeneration.current || result || pendingRef.current || !practice.target) return;
    void request({ operation: 'evaluate', failure_kind: reason, ...(detail?.requestId ? { asr_request_id: detail.requestId } : {}) }, sourceKey);
  }
  function tryAgain() {
    if (blocked) return;
    onBeforeMedia(); inputGeneration.current += 1; setRetrying(true); setRecorderReset(value => value + 1); setMessage('');
  }
  function continuePractice(assisted = false) {
    if (blocked || !practice.target || (assisted ? !practice.can_choose : result?.status !== 'correct')) return;
    void request({ operation: 'continue', assisted, ...(practice.result ? { result_request_id: practice.result.request_id } : {}) });
  }
  function explanation(value: PracticeResult) {
    if (value.status === 'correct') return practice.step === 'confirm' ? c.confirmMatched : c.matched;
    if (value.status === 'technical') return c.unavailable;
    if (value.status === 'unrecognized') return value.transcript?.trim() ? c.notUnderstood : c.noSpeech;
    return ({ quantity_mismatch: c.quantity, mode_mismatch: c.mode, item_mismatch: c.item, confirmation_mismatch: c.confirmation,
      ambiguous_expression: c.ambiguous, not_understood: c.notUnderstood } as Record<string, string>)[value.reason] || c.mismatch;
  }
  const displayStatus = pendingEvaluation ? (working ? 'pending' : 'technical') : result?.status;
  const displayTranscript = pendingEvaluation ? pendingEvaluation.transcript : result?.transcript;
  const hasTranscript = Boolean(displayTranscript?.trim());
  const showResult = Boolean(pendingEvaluation || result);

  return <div className="r3-practice" data-practice-step={practice.step}>
    <div className="r3-step-heading"><span>{c.step} {index + 1} / 4</span><strong>{c.steps[index]}</strong><div aria-hidden="true">{c.steps.map((name, number) => <i key={name} className={number <= index ? 'done' : ''}/>)}</div></div>
    {unapplied && <aside className="r3-pending r3-unapplied" data-testid="practice-unapplied" role="status"><strong>{c.unapplied}</strong>{unapplied.target && <p>{c.target}: {unapplied.target}</p>}<div className="r3-transcript"><span>{c.transcript}</span><p>{unapplied.transcript}</p></div><p>{c.unappliedNote}</p><button type="button" className="text-button" data-practice-action="dismiss-unapplied" onClick={dismissUnapplied}>{c.dismiss}</button></aside>}
    <div className="r2-practice-picker"><span className="overline">{c.pick}</span><div>{options.map(option => {
      const entry = entries.find(value => value.id === option.id)!;
      const chosen = sameTarget(practice.target, option.action);
      return <button type="button" key={option.id} data-practice-action={`select:${option.id}`} aria-pressed={chosen} className={chosen ? 'selected' : ''}
        disabled={blocked || captureActive} onClick={() => select(option.id)}>{entry.meaning[locale]}{chosen && <Check size={16}/>}</button>;
    })}</div><small>{c.pickHint}</small></div>
    {targetEntry ? <>
      {!showResult && <div className="r1-speaking-example"><span className="overline">{c.say}</span><LearningText entry={targetEntry} locale={locale} romanization={romanization}/>{listenButton(targetEntry)}</div>}
      {showResult ? <section className={`r3-result r3-result-${displayStatus}`} data-testid="practice-result" data-result-status={displayStatus} aria-live="polite" aria-atomic="true">
        <div className="r3-result-heading">{displayStatus === 'correct' ? <CheckCircle2 size={24}/> : displayStatus === 'incorrect' ? <XCircle size={24}/> : <CircleHelp size={24}/>}<div><span>{c.result}</span><h2>{displayStatus === 'pending' ? c.checking : c[displayStatus as 'correct' | 'incorrect' | 'unrecognized' | 'technical']}</h2></div></div>
        <div className="r3-result-target"><span className="overline">{c.target}</span><LearningText entry={targetEntry} locale={locale} romanization={romanization} compact/>{listenButton(targetEntry)}</div>
        <div className="r3-transcript"><span>{c.transcript}</span><p data-testid="practice-transcript" className={hasTranscript ? '' : 'empty'}>{hasTranscript ? displayTranscript : c.noTranscript}</p></div>
        <p className="r3-result-explanation">{pendingEvaluation ? (working ? c.checking : c.pending) : result ? explanation(result) : ''}</p>
        <small className="r3-result-scope">{c.scope}</small>
        {!pending && result && <div className="r3-result-actions">{result.status === 'correct'
          ? <button type="button" className="primary full" data-practice-action="continue" disabled={blocked} onClick={() => continuePractice(false)}>{practice.step === 'confirm' ? c.complete : c.next}<ArrowRight size={18}/></button>
          : <><button type="button" className="secondary full" data-practice-action="retry" disabled={blocked} onClick={tryAgain}><RotateCcw size={17}/>{c.retry}</button><button type="button" className="primary full" data-practice-action="assisted" disabled={blocked || !practice.can_choose} onClick={() => continuePractice(true)}>{practice.step === 'confirm' ? c.assistedComplete : c.assisted}<ArrowRight size={18}/></button></>}</div>}
      </section> : <>
        {!practice.can_choose && <p className="r2-first-speak">{c.first}</p>}
        {servicesReady && <Recorder key={currentKey} locale={locale} enabled={asrEnabled} disabled={blocked} stopSignal={stopSignal} resetSignal={recorderReset}
          onPhaseChange={next => { setPhase(next); onPhaseChange(next); }} onDraftChange={onDraftChange} onEvent={onEvent}
          onTranscript={(text, requestId) => { if (keyRef.current !== currentKey || inputTicket !== inputGeneration.current) return; onDraftChange(false); void request({ operation: 'evaluate', text, asr_request_id: requestId }, currentKey); }}
          onFailure={(reason, detail) => failure(reason, detail, currentKey)}/>}
        {practice.can_choose && <div className="r3-choice-assistance"><p>{c.chooseHint}</p><button type="button" className="secondary full" data-practice-action="assisted" disabled={blocked || captureActive} onClick={() => continuePractice(true)}>{practice.step === 'confirm' ? c.assistedComplete : c.assisted}<ArrowRight size={18}/></button></div>}
      </>}
    </> : <div className="r2-select-first"><Mic size={23}/><p>{c.selectFirst}</p></div>}
    {pending && !working && <div className="r3-pending" role="status"><p>{c.pending}</p><div><button type="button" className="secondary" data-practice-action="recover" onClick={() => void recover()}>{c.recover}</button><button type="button" className="text-button" data-practice-action="cancel" onClick={() => void recover(true)}>{c.cancel}</button></div></div>}
    {working && <div className="processing-bar" role="status"><span className="spinner"/>{c.saving}</div>}
    {message && !pending && <p className="r3-save-notice" role="status">{c[message]}</p>}
    {practice.step === 'confirm' && <div className="r3-edit-order"><span><PencilLine size={15}/>{c.edit}</span><div>{(['quantity','mode'] as const).map(step => <button type="button" className="text-button" key={step} data-practice-action={`edit:${step}`} disabled={blocked || captureActive} onClick={() => void request({ operation: 'edit', step })}>{step === 'quantity' ? c.editQuantity : c.editMode}</button>)}</div></div>}
  </div>;
}
