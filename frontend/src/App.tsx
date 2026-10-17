import { useEffect, useRef, useState } from 'react';
import { ArrowRight, ArrowUpRight, AudioLines, BookOpen, Check, ChevronLeft, ChevronRight, CircleHelp, Clock3, Compass, Footprints, Globe2, Leaf, MapPin, MessageCircle, Mic, Minus, Navigation, PackageCheck, PencilLine, Play, RotateCcw, Settings2, ShoppingBag, Sparkles, Volume2, X } from 'lucide-react';
import Dialog from './components/Dialog';
import Recorder from './components/Recorder';
import { GardenMap, Landmark, NanxiangScene, type ScenePose } from './components/SceneArt';
import { api, post, ApiError, type Action, type Attempt, type Locale, type Session, type TurnRequest, type TurnResult } from './lib/api';
import { strings } from './lib/i18n';
import content from '../../content/batch-a.json';
import LearningText, { type LearningEntry } from './components/LearningText';
import { transcriptGuide } from './lib/transcriptGuide';
import { reviewClipFor } from './lib/reviewAudio';
import { stopAllAudio } from './lib/audio';
import './styles.css';
import './styles-revision1.css';

type View = 'map' | 'nanxiang' | 'review' | 'design';
type Panel = 'help' | 'settings' | 'intro' | 'units' | 'about' | 'skip' | 'leaveRecording' | 'newSession' | null;
type StationId = 'restaurant' | 'candy' | 'nanxiang' | 'teahouse';
const stationIds: StationId[] = ['restaurant', 'candy', 'nanxiang', 'teahouse'];
const stationPositions = [{ x: 25, y: 47 }, { x: 69, y: 42 }, { x: 30, y: 85 }, { x: 76, y: 78 }];
const labelNames = { zh: ['上海老饭店', '上海梨膏糖商店', '南翔馒头店', '湖心亭茶楼'], en: ['Shanghai Old Restaurant', 'Shanghai Pear Candy Shop', 'Nanxiang Steamed Bun Restaurant', 'Huxin Pavilion Teahouse'] };
const shortNames = { zh: ['老饭店', '梨膏糖商店', '南翔馒头店', '湖心亭茶楼'], en: ['Old Restaurant', 'Pear Candy Shop', 'Nanxiang', 'Huxin Pavilion'] };
const themes = { zh: ['偏好与推荐', '听辨与挑选', '数量与外带', '赞茶与道谢'], en: ['Preferences & recommendations', 'Listen & choose', 'Quantity & takeaway', 'Tea & a little gratitude'] };
const durations = ['5–6', '5–7', '5–6', '3–4'];
type QuestionFocus = 'item' | 'quantity' | 'mode' | 'confirm' | 'edit';
const learningEntries: LearningEntry[] = [...content.dialogues, ...content.expressions, ...content.supportTerms];
const entryFor = (id: string) => learningEntries.find(entry => entry.id === id)!;
function focusFor(attempt: Attempt | null): QuestionFocus {
  const id = attempt?.prompt_id;
  if (id === 'NX-N09' || id === 'NX-N10') return 'confirm';
  if (id === 'NX-N11') return 'edit';
  if (['NX-N02', 'NX-N04', 'NX-N05', 'NX-N08'].includes(id || '')) return 'quantity';
  if (['NX-N03', 'NX-N06'].includes(id || '')) return 'mode';
  if (id === 'NX-N12' && attempt) {
    if (attempt.unresolved_issues.some(issue => /quantity|unit/.test(issue))) return 'quantity';
    if (attempt.unresolved_issues.some(issue => /takeaway/.test(issue))) return 'mode';
    if (attempt.order.item && attempt.order.quantity === null) return 'quantity';
    if (attempt.order.item && attempt.order.takeaway === null) return 'mode';
  }
  return 'item';
}
function ServingIllustration() { return <svg width="75" height="62" viewBox="0 0 90 70" aria-hidden="true"><path d="M6 28v20c0 22 78 22 78 0V28" fill="#c59d65" stroke="#9d7547" strokeWidth="2"/><path d="M6 42c0 20 78 20 78 0M6 51c8 17 70 17 78 0" fill="none" stroke="#a77d47"/><ellipse cx="45" cy="28" rx="39" ry="20" fill="#dfc598" stroke="#9d7547" strokeWidth="2"/>{[[26,25],[47,21],[64,29],[41,36]].map(([x,y])=><g key={x} transform={`translate(${x},${y})`}><path d="M-12 2q0-10 12-13Q12-8 12 2q-12 10-24 0" fill="#ffedc9" stroke="#b7a076"/><path d="M0-10L-6 2M0-10L0 4M0-10L6 2" fill="none" stroke="#d9c39a"/></g>)}</svg>; }
function getView(): View { const view = window.location.hash.slice(1); return ['nanxiang', 'review', 'design'].includes(view) ? view as View : 'map'; }

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [locale, setLocale] = useState<Locale>('zh');
  const [view, setView] = useState<View>(getView);
  const [selected, setSelected] = useState<StationId>('nanxiang');
  const [panel, setPanel] = useState<Panel>(null);
  const [error, setError] = useState('');
  const [booting, setBooting] = useState(true);
  const [busy, setBusy] = useState(false);
  const [savingPreferences, setSavingPreferences] = useState(false);
  const preferencesInFlight = useRef(false);
  const sessionResetInFlight = useRef(false);
  const [channel, setChannel] = useState<'speak' | 'choose'>('choose');
  const [draft, setDraft] = useState<{ item?: string; quantity?: number; unit?: string; takeaway?: boolean }>({});
  const [asrSource, setAsrSource] = useState<{text:string;requestId:string}|null>(null);
  const [asrEnabled, setAsrEnabled] = useState(false);
  const [lastText, setLastText] = useState('');
  const [showApproximate, setShowApproximate] = useState<string | null>(null);
  const [recordingDraft, setRecordingDraft] = useState(false);
  const [stopSignal, setStopSignal] = useState(0);
  const [editing, setEditing] = useState(false);
  const [editFocus, setEditFocus] = useState<QuestionFocus | null>(null);
  const [recordingPhase, setRecordingPhase] = useState<'idle'|'recording'|'processing'|'playback'>('idle');
  const [recorderReset, setRecorderReset] = useState(0);
  const [transientPose, setTransientPose] = useState<'acknowledging'|'packing'|null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [audioMessage, setAudioMessage] = useState('');
  const [autoVoice, setAutoVoice] = useState(() => {try {return localStorage.getItem('shanghai-review-autovoice') !== 'off';} catch {return true;}});
  const teachingAudio = useRef<HTMLAudioElement | null>(null);
  const audioRole = useRef<'host'|'example'>('host');
  const audioEntryId = useRef<string | null>(null);
  const audioGeneration = useRef(0);
  const promptTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const poseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recordingPhaseRef = useRef(recordingPhase);
  recordingPhaseRef.current = recordingPhase;
  const [orderExpanded, setOrderExpanded] = useState(false);
  const [activeAttemptId, setActiveAttemptId] = useState<string | null>(null);
  const [loggingGap, setLoggingGap] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const lastRequest = useRef<{ attemptId: string; body: TurnRequest } | null>(null);
  const generation = useRef(0);
  const destination = useRef<View>('map');
  const viewRef = useRef(view);
  const navigationHandler = useRef<(next:View)=>void>(()=>{});
  viewRef.current = view;
  const sessionRef = useRef<Session | null>(null);
  sessionRef.current = session;
  const s = strings[locale];
  const attempt = session?.attempts.find(a => a.id === activeAttemptId) || [...(session?.attempts || [])].reverse().find(a => a.station_id === 'nanxiang') || null;
  const legacyContent = Boolean(session && session.content_version !== content.contentVersion);
  const completeCount = session?.completed_station_ids.length || 0;
  const selectedIndex = stationIds.indexOf(selected);
  const selectedData = content.stations.find(station => station.id === selected);

  async function loadSession() {
    setBooting(true); setError('');
    try { const next = await api<Session>('/session'); setSession(next); setLocale(next.locale); const services = await api<{asr:{enabled:boolean}}>('/services'); setAsrEnabled(services.asr.enabled); }
    catch { setError(strings[locale].offline); }
    finally { setBooting(false); }
  }
  useEffect(() => { void loadSession(); const update = () => {const next = getView(); if(next !== viewRef.current) navigationHandler.current(next);}; window.addEventListener('hashchange', update); return () => window.removeEventListener('hashchange', update); }, []);
  useEffect(() => { document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en'; document.title = `${s.brand} · ${view === 'nanxiang' ? shortNames[locale][2] : s.map}`; setShowApproximate(null); setStopSignal(n => n + 1); }, [locale, view]);
  useEffect(() => { const warn = (e:BeforeUnloadEvent) => {if(recordingDraft){e.preventDefault();e.returnValue='';}}; window.addEventListener('beforeunload',warn); return () => window.removeEventListener('beforeunload',warn); },[recordingDraft]);
  useEffect(() => { document.documentElement.dataset.reducedMotion = String(session?.reduced_motion || false); }, [session?.reduced_motion]);
  function replaceAttempt(next: Attempt, allowCreate = false) {
    setSession(previous => previous ? { ...previous, attempts: previous.attempts.some(a => a.id === next.id) ? previous.attempts.map(a => a.id === next.id && a.revision <= next.revision ? next : a) : allowCreate ? [...previous.attempts, next] : previous.attempts, completed_station_ids: next.status === 'completed' && previous.attempts.some(a => a.id === next.id) ? Array.from(new Set([...previous.completed_station_ids, next.station_id])) : previous.completed_station_ids } : previous);
    }
  async function event(event_type: string, metadata: Record<string, unknown> = {}) {
    if (!sessionRef.current) return;
    try { await post('/events', { event_id: crypto.randomUUID(), attempt_id: attempt?.id, event_type, metadata }); if(attempt) { const next=await api<Attempt>(`/attempts/${attempt.id}`); setSession(previous => previous ? {...previous,attempts:previous.attempts.map(current=>current.id === next.id ? {...current,metrics:{voice_attempts:Math.max(current.metrics.voice_attempts,next.metrics.voice_attempts),help_used:Math.max(current.metrics.help_used,next.metrics.help_used)}} : current)} : previous); } }
    catch { setLoggingGap(true); }
  }
  async function preferences(change: Partial<Pick<Session, 'locale' | 'show_romanization' | 'reduced_motion'>>) {
    if(sessionResetInFlight.current) return;
    if(!session) { if(change.locale) setLocale(change.locale); return; }
    if(preferencesInFlight.current) return;
    preferencesInFlight.current = true; setSavingPreferences(true);
    try { const next = await api<Session>('/session', { method: 'PATCH', body: JSON.stringify(change) }); setSession(previous => previous ? {...previous, locale:next.locale, show_romanization:next.show_romanization, reduced_motion:next.reduced_motion} : next); setLocale(next.locale); }
    catch { setError(s.error); }
    finally {preferencesInFlight.current=false;setSavingPreferences(false);}
  }
  function navigate(next: View, force = false) {
    if (recordingDraft && view === 'nanxiang' && next !== view && !force) { stopTeachingAudio();setStopSignal(n=>n+1);destination.current = next; window.history.replaceState(null,'',`#${view}`); setPanel('leaveRecording'); return; }
    generation.current += 1; stopTeachingAudio(); controller.current?.abort(); if(!sessionResetInFlight.current) setBusy(false); setPanel(null); setError(''); setStopSignal(n => n + 1);
    const pendingId = lastRequest.current?.body.request_id || attempt?.pending_request_id;
    if(pendingId && attempt) { void post<TurnResult>(`/attempts/${attempt.id}/turns/${pendingId}/cancel`, {expected_revision:attempt.revision}).then(result=>replaceAttempt(result.attempt)).catch(()=>setError(s.error)); lastRequest.current=null; }
    viewRef.current = next; window.location.hash = next; setView(next); window.scrollTo({ top: 0, behavior: 'instant' }); requestAnimationFrame(() => document.getElementById('main-content')?.focus({preventScroll:true}));
  }
  navigationHandler.current = navigate;
  async function begin(restart = false) {
    if(sessionResetInFlight.current || busy) return;
    if(legacyContent) {setPanel('newSession');return;}
    setBusy(true); setError('');
    const ticket = ++generation.current;
    try {
      const next = await post<Attempt>('/attempts', { station_id: 'nanxiang', restart });
      if(ticket !== generation.current) return;
      replaceAttempt(next, true); setActiveAttemptId(next.id); setDraft({}); setAsrSource(null); setLastText(''); setEditing(false); setEditFocus(null); setRecordingDraft(false); setRecorderReset(n=>n+1); setTransientPose(null); lastRequest.current = null;
      navigate('nanxiang', true);
      scheduleQuestion(next, 200);
    } catch { if(ticket === generation.current) setError(s.error); } finally { if(ticket === generation.current) setBusy(false); }
  }
  async function startNewSession() {
    if(sessionResetInFlight.current || busy || preferencesInFlight.current) return;
    sessionResetInFlight.current = true;
    setBusy(true); setError(''); generation.current += 1; stopTeachingAudio(); controller.current?.abort(); setStopSignal(n => n + 1);
    try {
      const pendingId = lastRequest.current?.body.request_id || attempt?.pending_request_id;
      if(pendingId && attempt) await post(`/attempts/${attempt.id}/turns/${pendingId}/cancel`, {expected_revision:attempt.revision});
      const next = await post<Session>('/session/new', {});
      lastRequest.current = null; setSession(next); setLocale(next.locale); setActiveAttemptId(null); setDraft({}); setAsrSource(null); setLastText(''); setEditing(false); setEditFocus(null); setRecorderReset(n=>n+1); setTransientPose(null); setOrderExpanded(false); setRecordingDraft(false); setLoggingGap(false); setPanel(null);
      viewRef.current = 'map'; window.location.hash = 'map'; setView('map'); window.scrollTo({top:0,behavior:'instant'}); requestAnimationFrame(() => document.getElementById('main-content')?.focus({preventScroll:true}));
    } catch { setPanel(null); setError(s.error); }
    finally {generation.current += 1; sessionResetInFlight.current = false;setBusy(false);}
  }
  function enter() { if(attempt && attempt.status !== 'skipped') navigate('nanxiang'); else setPanel('intro'); }
  function applyTurnResult(result:TurnResult, body?:TurnRequest) {
    const previous = sessionRef.current?.attempts.find(current => current.id === result.attempt.id);
    replaceAttempt(result.attempt);
    if(result.status === 'applied') {
      if(body?.channel === 'buttons') setDraft(current => Object.entries(current).every(([key,value]) => (body.action as unknown as Record<string,unknown>)?.[key] === value) ? {} : current);
      else if(body?.text) {setLastText(body.text);setAsrSource(current => current?.requestId === body.asr_request_id ? null : current);setRecorderReset(n=>n+1);}
      setEditing(false);setEditFocus(null);lastRequest.current=null;setError('');
      if(previous && previous.revision <= result.attempt.revision && viewRef.current === 'nanxiang') {
        if(poseTimer.current) clearTimeout(poseTimer.current);
        if(result.attempt.status === 'completed' && previous.status !== 'completed') {
          setTransientPose('packing');
          poseTimer.current=setTimeout(()=>setTransientPose(null),1850);
        } else if(result.attempt.status !== 'completed') {
          setTransientPose('acknowledging');
          poseTimer.current=setTimeout(()=>setTransientPose(null),550);
        }
        scheduleQuestion(result.attempt, result.attempt.status === 'completed' ? 250 : 550);
      }
    } else if(result.status === 'failed') {if(lastRequest.current) lastRequest.current={...lastRequest.current,body:{...lastRequest.current.body,request_id:crypto.randomUUID()}};setError(s.error);}
    else if(result.status === 'cancelled') {lastRequest.current=null;setError('');}
  }
  async function submit(action?: Action, repeat = false) {
    if(legacyContent) {setPanel('newSession');return;}
    if (!attempt || busy || sessionResetInFlight.current || (!action && !repeat && !asrSource)) return;
    stopTeachingAudio();
    setBusy(true); setError('');
    const ticket = ++generation.current;
    const body: TurnRequest = repeat && lastRequest.current ? lastRequest.current.body : { request_id: crypto.randomUUID(), expected_revision: attempt.revision, channel: action ? 'buttons' : 'voice', ...(action ? {action} : {text: asrSource!.text, asr_request_id:asrSource!.requestId}), ...(attempt.summary_revision !== null ? { summary_revision: attempt.summary_revision } : {}) };
    lastRequest.current = { attemptId: attempt.id, body };
    controller.current = new AbortController();
    try {
      const result = await post<TurnResult>(`/attempts/${attempt.id}/turns`, body, controller.current.signal);
      if(ticket !== generation.current) return;
      applyTurnResult(result,body);
    } catch(e) {
      if(ticket !== generation.current) return;
      if(e instanceof ApiError && e.terminal && e.retryable) { lastRequest.current = {attemptId:attempt.id,body:{...body,request_id:crypto.randomUUID()}}; setError(s.error); }
      else if(e instanceof ApiError && e.attempt) { replaceAttempt(e.attempt); lastRequest.current = null; setError(s.conflict); }
      else if(!(e instanceof DOMException && e.name === 'AbortError')) setError(s.error);
    } finally { if(ticket === generation.current) setBusy(false); }
  }
  async function cancelTurn() {
    if(!attempt) return;
    const requestId = lastRequest.current?.body.request_id || attempt.pending_request_id;
    if(!requestId) return;
    generation.current += 1; controller.current?.abort();
    try { await post(`/attempts/${attempt.id}/turns/${requestId}/cancel`, { expected_revision: attempt.revision }); const next = await api<Attempt>(`/attempts/${attempt.id}`); replaceAttempt(next); lastRequest.current = null; }
    catch { setError(s.error); }
    setBusy(false);
  }
  async function recoverPending() {
    if(!attempt?.pending_request_id) return;
    try { const result = await api<TurnResult>(`/attempts/${attempt.id}/turns/${attempt.pending_request_id}`); applyTurnResult(result,lastRequest.current?.body); } catch {setError(s.error);}
  }
  async function skip() {
    if(!attempt || sessionResetInFlight.current) return;
    setBusy(true);
    try { const next = await post<Attempt>(`/attempts/${attempt.id}/skip`, { expected_revision: attempt.revision }); replaceAttempt(next); setRecordingDraft(false); navigate('map', true); }
    catch { setError(s.error); } finally { setBusy(false); }
  }
  function help() { stopTeachingAudio(); setStopSignal(n => n + 1); setPanel('help'); void event('expression_opened', { expression_ids: ['E08', 'E09', 'E05'] }); }
  function unitHelp() { stopTeachingAudio(); setStopSignal(n=>n+1); setPanel('units'); void event('unit_explanation_viewed'); }
  const statusFor = (id: string) => session?.completed_station_ids.includes(id) ? s.completed : [...(session?.attempts || [])].reverse().find(a => a.station_id === id)?.status === 'skipped' ? s.skipped : session?.attempts.some(a => a.station_id === id) ? s.inProgress : s.notStarted;
  const turnBlocked = busy || Boolean(attempt?.pending_request_id);
  const captureActive = recordingPhase === 'recording' || recordingPhase === 'processing';
  const focus = editing ? (editFocus || 'edit') : (editFocus || focusFor(attempt));
  const localPrompt = editFocus ? (editFocus === 'quantity' ? 'NX-N02' : editFocus === 'mode' ? 'NX-N03' : 'NX-N01') : editing ? 'NX-N11' : attempt?.prompt_id || 'NX-N01';
  const promptEntry = entryFor(localPrompt);
  const transcriptMeaning = asrSource ? transcriptGuide(asrSource.text,locale,learningEntries) : null;
  const showRomanization = session?.show_romanization ?? true;
  const questionDraft = focus === 'item' ? (draft.item ? {item:draft.item} : {})
    : focus === 'quantity' ? (draft.quantity !== undefined ? {quantity:draft.quantity,unit:draft.unit} : {})
      : focus === 'mode' ? (draft.takeaway !== undefined ? {takeaway:draft.takeaway} : {}) : {};
  const hasSelection = Object.values(questionDraft).some(value => value !== undefined);
  const scenePose: ScenePose = attempt?.status === 'completed' ? (transientPose === 'packing' ? 'packing' : 'packed')
    : recordingPhase === 'recording' || recordingPhase === 'playback' ? 'listening'
      : busy || recordingPhase === 'processing' ? 'thinking'
        : playingId && audioRole.current === 'host' ? 'speaking'
          : transientPose === 'acknowledging' ? 'acknowledging'
            : attempt?.unresolved_issues.length ? 'clarifying'
              : attempt?.status === 'confirming' ? 'checking' : 'idle';
  const phaseLabel = scenePose === 'speaking' ? (locale === 'zh' ? '店员正在说话' : 'Your host is speaking')
    : scenePose === 'listening' ? (locale === 'zh' ? '店员在听' : 'Your host is listening')
      : scenePose === 'thinking' ? s.waiting
        : scenePose === 'packing' ? (locale === 'zh' ? '两份，打包带走' : 'Packing two servings to go')
          : scenePose === 'acknowledging' ? (locale === 'zh' ? '收到你的回应了' : 'Reply received')
            : scenePose === 'packed' ? s.stamp : (locale === 'zh' ? '轮到你回应' : 'Your turn');
  const quantityLabel = attempt?.order.quantity != null ? `${attempt.order.quantity} ${attempt.order.unit === 'piece' ? s.piece : attempt.order.unit === 'basket' ? s.basket : attempt.order.unit === 'serving' ? (locale === 'en' && attempt.order.quantity === 1 ? 'serving' : s.serving) : ''}` : s.unknown;
  const orderSummary = <dl className="order-fields" id="saved-order-fields"><div><dt>{s.item}</dt><dd>{attempt?.order.item === 'xiaolongbao' ? s.xlb : s.unknown}</dd></div><div><dt>{s.quantity}</dt><dd>{quantityLabel}</dd></div><div><dt>{s.mode}</dt><dd>{attempt?.order.takeaway === true ? s.go : attempt?.order.takeaway === false ? s.here : s.unknown}</dd></div></dl>;

  function stopTeachingAudio() {
    audioGeneration.current += 1;
    if(promptTimer.current) clearTimeout(promptTimer.current);
    stopAllAudio(); setPlayingId(null);
  }
  async function playEntry(entry:LearningEntry, role:'host'|'example' = 'example') {
    if(recordingPhaseRef.current === 'recording' || recordingPhaseRef.current === 'processing') return;
    const clip = reviewClipFor(entry);
    if(!clip || !teachingAudio.current) {
      setAudioMessage(locale === 'zh' ? '这句话的匹配声音正在制作，请稍后试听。' : 'Matching audio for this sentence is still being prepared.');
      return;
    }
    stopTeachingAudio();
    const ticket = audioGeneration.current;
    const player=teachingAudio.current;
    audioRole.current=role; audioEntryId.current=entry.id; setAudioMessage('');
    player.src=clip.file;
    try {await player.play();}
    catch {if(ticket === audioGeneration.current) {setPlayingId(null);setAudioMessage(locale === 'zh' ? '声音未能播放。请点句子旁的播放键重听。' : 'Audio could not play. Use the sentence’s Listen button to try again.');}}
  }
  function scheduleQuestion(next:Attempt, delay:number) {
    if(!autoVoice) return;
    if(promptTimer.current) clearTimeout(promptTimer.current);
    const ticket=generation.current;
    promptTimer.current=setTimeout(()=>{
      if(ticket === generation.current && viewRef.current === 'nanxiang' && recordingPhaseRef.current === 'idle') void playEntry(entryFor(next.prompt_id),'host');
    },delay);
  }
  useEffect(() => {
    audioGeneration.current += 1;stopAllAudio();setPlayingId(null);setAudioMessage('');
  },[locale,view]);
  useEffect(()=>()=>{if(promptTimer.current) clearTimeout(promptTimer.current);if(poseTimer.current) clearTimeout(poseTimer.current);stopAllAudio();},[]);
  function listenButton(entry:LearningEntry, role:'host'|'example'='example') {
    const available=Boolean(reviewClipFor(entry));
    return <button type="button" className={`sentence-listen ${playingId === entry.id ? 'is-playing' : ''}`} disabled={!available || captureActive}
      aria-label={`${locale === 'zh' ? '试听' : 'Listen to'} ${entry.hanzi || entry.meaning[locale]}`}
      title={available ? s.normal : s.audioPending} onClick={()=>void playEntry(entry,role)}><Volume2 size={18}/><span>{available ? s.normal : s.audioPending}</span></button>;
  }
  function selectChannel(next:'speak'|'choose') {
    setChannel(next);stopTeachingAudio();if(next !== 'speak') setStopSignal(n=>n+1);void event('input_channel_changed',{channel:next});
  }
  function chooseEdit(next:'quantity'|'mode') {stopTeachingAudio();setEditFocus(next);setDraft({});setChannel('choose');}
  function discardTranscript() {setAsrSource(null);setRecordingDraft(false);setRecorderReset(n=>n+1);setAudioMessage('');}
  function option(entryId:string, value: { item?:string;quantity?:number;unit?:string;takeaway?:boolean }) {
    const entry=entryFor(entryId);
    const chosen=Object.entries(value).every(([key,v])=>draft[key as keyof typeof draft] === v);
    return <div className={`answer-option ${chosen ? 'selected' : ''}`} key={entryId}>
      <button className="answer-select" type="button" aria-pressed={chosen} disabled={turnBlocked || captureActive} onClick={()=>setDraft(chosen ? {} : value)}>
        <span className="answer-check" aria-hidden="true">{chosen && <Check size={16}/>}</span>
        <LearningText entry={entry} locale={locale} romanization={showRomanization} compact/>
      </button>{listenButton(entry)}
    </div>;
  }

  return <div className={`app locale-${locale}`}>
    <audio ref={teachingAudio} className="sr-only" preload="none" onPlay={()=>{setPlayingId(audioEntryId.current);void event('audio_started',{text_id:audioEntryId.current,review_draft:true});}} onPause={()=>setPlayingId(null)} onEnded={()=>{setPlayingId(null);void event('audio_ended',{text_id:audioEntryId.current,review_draft:true});}} onError={()=>{setPlayingId(null);setAudioMessage(locale === 'zh' ? '声音暂时无法读取，请重听。' : 'Audio is unavailable. Please try listening again.');}}/>

    <a className="skip-link" href="#main-content" onClick={e=>{e.preventDefault();document.getElementById('main-content')?.focus();}}>{locale === 'zh' ? '跳到主要内容' : 'Skip to content'}</a>
    <header className="site-header">
      <button className="brand" onClick={() => navigate('map')} aria-label={s.brand}><span className="brand-mark"><span>沪</span></span><span><strong>{s.brand}</strong><small>{s.tagline}</small></span></button>
      <nav className="main-nav" aria-label={locale === 'zh' ? '主导航' : 'Main navigation'}>
        <button className={view === 'map' || view === 'nanxiang' ? 'active' : ''} onClick={() => navigate('map')}><Compass size={18}/>{s.map}</button>
        <button onClick={help}><BookOpen size={18}/>{s.phrases}</button>
        <button className={view === 'review' ? 'active' : ''} onClick={() => navigate('review')}><Footprints size={18}/>{s.journey}</button>
      </nav>
      <div className="header-tools"><button className="language-button" disabled={savingPreferences} onClick={() => void preferences({locale: locale === 'zh' ? 'en' : 'zh'})} aria-label={locale === 'zh' ? 'Switch to English' : '切换为中文'}><Globe2 size={17}/><span>{locale === 'zh' ? 'EN' : '中文'}</span></button><span className="tool-divider"/><button className="icon-button" onClick={() => {stopTeachingAudio();setPanel('settings'); setStopSignal(n => n + 1);}} aria-label={s.settings}><Settings2 size={20}/></button></div>
    </header>
    <main id="main-content" tabIndex={-1}>
      {error && <div className="error-banner" role="alert"><CircleHelp size={18}/><span>{error}</span><button onClick={() => { if(!session) void loadSession(); else if(lastRequest.current) void submit(undefined, true); else setError(''); }}>{lastRequest.current || !session ? s.retry : s.close}</button></div>}
      {view === 'map' && <div className="map-page page-shell">
        <section className="page-heading"><div><div className="eyebrow"><span className="tiny-line"/>{s.eyebrow}</div><h1>{s.title}</h1><p>{s.subtitle}</p></div><div className="journey-meter"><div className="journey-meter-top"><span>{s.progress}</span><strong>{completeCount}<small> / 4</small></strong></div><div className="progress-pips">{stationIds.map(id => <span key={id} className={session?.completed_station_ids.includes(id) ? 'done' : ''}/>)}</div></div></section>
        <div className="explore-layout">
          <section className="map-canvas" aria-label={s.mapLabel}>
            <div className="map-caption"><span>豫園</span><div>YU GARDEN<small>31°13′ N &nbsp; 121°29′ E</small></div></div>
            <div className="compass-rose" aria-hidden="true"><span>N</span><Navigation size={28} strokeWidth={1}/></div>
            <div className="map-art"><GardenMap label={s.mapLabel}/></div>
            {stationIds.map((id, i) => <button key={id} className={`map-marker marker-${id} ${selected === id ? 'selected' : ''}`} style={{left: `${stationPositions[i].x}%`, top: `${stationPositions[i].y}%`}} onClick={() => setSelected(id)} aria-pressed={selected === id} aria-label={`${labelNames[locale][i]}, ${statusFor(id)}`}><span className="pin-number">{session?.completed_station_ids.includes(id) ? <Check size={18}/> : `0${i + 1}`}</span><span className="pin-label">{shortNames[locale][i]}<ArrowUpRight size={13}/></span></button>)}
            <div className="map-bottom"><span><span className="map-key"/>{s.illustration}</span><small>{s.notNavigation}</small></div>
          </section>
          <aside className="station-detail" aria-live="polite">
            <div className="station-detail-heading"><span className="overline">{s.explore}</span><span className="station-counter">0{selectedIndex + 1}<span> / 04</span></span></div>
            <div className={`landmark-preview art-${selected}`}><Landmark kind={selected} label={labelNames[locale][selectedIndex]}/><span className="landmark-caption">{themes[locale][selectedIndex]}</span></div>
            <div className="station-detail-body"><div className="station-meta"><span><Clock3 size={14}/>{locale === 'zh' ? `约 ${durations[selectedIndex]} 分钟` : `${durations[selectedIndex]} minutes`}</span><span className="status-dot">{statusFor(selected)}</span></div><h2>{labelNames[locale][selectedIndex]}</h2><p>{selectedData?.taskDescription[locale]}</p>
              {selected === 'nanxiang' ? <><div className="phrase-tags"><span>{locale === 'zh' ? '两份' : 'Two servings'}</span><span>{s.go}</span><span>{locale === 'zh' ? '确认' : 'Confirm'}</span></div><button className="primary full" disabled={booting || !session} onClick={enter}>{attempt?.status === 'completed' ? s.reviewOrder : attempt && attempt.status !== 'skipped' ? s.resume : s.enter}<ArrowRight size={19}/></button></> : <><div className="in-making"><Leaf size={16}/><span>{s.comingText}</span></div><button className="secondary full" onClick={() => setSelected('nanxiang')}>{s.available}<ArrowRight size={18}/></button></>}
              <button className="preview-link" onClick={() => setPanel('about')}><span className="small-dot"/>{s.preview}<CircleHelp size={13}/></button>
            </div>
          </aside>
        </div>
        <div className="route-list" aria-label={s.map}>{stationIds.map((id, i) => <button key={id} onClick={() => setSelected(id)} className={selected === id ? 'active' : ''} aria-pressed={selected === id}><span className="route-number">0{i + 1}</span><span><strong>{shortNames[locale][i]}</strong><small>{themes[locale][i]}</small></span>{selected === id ? <Check size={16}/> : <ChevronRight size={16}/>}</button>)}</div>
        <section className="walking-note"><div><span className="overline">A FEW WORDS, A WHOLE NEW WORLD</span><h2>{s.footerTitle}</h2><p>{s.footerText}</p></div><div className="feature-list">{[[MessageCircle, s.featureSpeak, s.featureSpeakText], [BookOpen, s.featureHelp, s.featureHelpText], [Footprints, s.featurePace, s.featurePaceText]].map(([Icon, title, description]) => {const I = Icon as typeof MessageCircle; return <div className="feature" key={title as string}><I size={21} strokeWidth={1.4}/><div><strong>{title as string}</strong><small>{description as string}</small></div></div>;})}</div></section>
      </div>}

      {view === 'nanxiang' && <div className="scene-page r1-scene-page page-shell">
        <div className="scene-topline"><button className="text-button" onClick={()=>navigate('map')}><ChevronLeft size={18}/>{s.back}</button><span className="scene-breadcrumb">YU GARDEN <span>/</span> 03 · NANXIANG</span><button className="text-button" onClick={()=>{stopTeachingAudio();setPanel('skip');setStopSignal(n=>n+1);}} disabled={!attempt || busy || attempt.status === 'completed'}>{s.leave}<ArrowUpRight size={16}/></button></div>
        <div className="scene-heading"><div><span className="eyebrow">{s.conversation}</span><h1>{labelNames[locale][2]}</h1></div><button className="help-button" onClick={help}><BookOpen size={19}/>{s.phrases}</button></div>
        {legacyContent ? <div className="r1-old-record"><div className="r1-version-note"><p>{locale === 'zh' ? '课程已有新版本。开始新的探索即可使用逐轮交流、沪语注音和试听稿，语言与显示偏好会保留。' : 'A new lesson version is available. Start a new journey for guided turns, Shanghainese readings, and audio drafts. Your language and display preferences will be kept.'}</p><button className="secondary" disabled={busy} onClick={()=>setPanel('newSession')}>{locale === 'zh' ? '开始新的探索' : 'Start a new journey'}<ArrowRight size={17}/></button></div>{attempt && <><p>{locale === 'zh' ? '以下为旧版探索中已保存的订单，记录不会删除或转入新探索。' : 'This order was saved in your previous lesson version. Its record will remain saved separately.'}</p>{orderSummary}</>}</div> : !attempt || attempt.status === 'skipped' ? <div className="empty-scene"><NanxiangScene label={s.sceneLabel}/><button className="primary" disabled={busy || !session} onClick={()=>setPanel('intro')}>{s.start}<ArrowRight size={18}/></button></div> : <>
          {attempt.pending_request_id && !busy && <div className="pending-recovery" role="status"><CircleHelp size={18}/><span>{locale === 'zh' ? '有一条回应尚未结束。可以查询结果，或取消后重新回应。' : 'A reply is pending. Check its result, or cancel it before replying again.'}</span><button className="secondary" onClick={()=>void recoverPending()}>{locale === 'zh' ? '查询结果' : 'Check result'}</button><button className="text-button" onClick={()=>void cancelTurn()}>{s.cancel}</button></div>}
          <div className="r1-conversation-grid">
            <section className="r1-stage-column" aria-label={s.sceneLabel}>
              <div className="r1-scene-stage"><NanxiangScene label={s.sceneLabel} pose={scenePose}/><div className="r1-scene-label"><span>南翔</span><small>NANXIANG</small></div><div className="r1-scene-status" role="status"><span className={`phase-dot phase-${scenePose}`}/>{phaseLabel}</div></div>
              <div className="r1-mission"><MapPin size={18}/><span><small>{s.task}</small><strong>{s.taskShort}</strong></span><button className="icon-button" onClick={unitHelp} aria-label={s.units}><CircleHelp size={19}/></button></div>
              <section className="r1-saved-order" aria-label={s.heard}><button className="r1-order-toggle" aria-expanded={orderExpanded} aria-controls="r1-order-details" onClick={()=>setOrderExpanded(value=>!value)}><span><ShoppingBag size={17}/><strong>{s.heard}</strong><small>{attempt.order.item === 'xiaolongbao' ? s.xlb : s.unknown} · {quantityLabel} · {attempt.order.takeaway === true ? s.go : attempt.order.takeaway === false ? s.here : s.unknown}</small></span><ChevronRight size={18} className={orderExpanded ? 'rotated' : ''}/></button><div id="r1-order-details" hidden={!orderExpanded}>{orderSummary}<span className="saved-note"><Check size={13}/>{s.saved}</span></div></section>
            </section>
            <section className="r1-turn-panel" aria-label={locale === 'zh' ? '当前交流' : 'Current conversation'}>
              <div className="r1-turn-heading"><span className="overline">{s.server}</span><span className="review-label">{s.candidate}</span></div>
              <div className="r1-question" aria-live="polite"><LearningText entry={promptEntry} locale={locale} romanization={showRomanization}/>{listenButton(promptEntry,'host')}</div>
              <div className="r1-reading-tools"><button className="text-button" aria-pressed={showRomanization} disabled={savingPreferences} onClick={()=>void preferences({show_romanization:!showRomanization})}><span className={`toggle ${showRomanization ? 'on' : ''}`}/>{s.pronunciation}</button><small>{locale === 'zh' ? '沪语 · 常速声音审阅稿' : 'Shanghainese · Normal-speed audio draft'}</small></div>
              {audioMessage && <p className="audio-notice" role="status">{audioMessage}</p>}
              {attempt.status === 'completed' ? <div className="r1-completed" role="status"><PackageCheck size={32}/><h2>{s.successTitle}</h2><p>{s.successText}</p><div className="r1-completed-actions"><button className="primary" onClick={()=>navigate('map')}>{s.backExplore}<ArrowRight size={18}/></button><button className="secondary" disabled={busy} onClick={()=>void begin(true)}><RotateCcw size={17}/>{s.again}</button></div><small>{s.successFoot}</small></div> : <>
                <div className="input-tabs r1-input-tabs" role="tablist" aria-label={locale === 'zh' ? '回应方式' : 'Reply method'} onKeyDown={event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;event.preventDefault();const next=event.key === 'Home' ? 'speak' : event.key === 'End' ? 'choose' : channel === 'speak' ? 'choose' : 'speak';selectChannel(next);(event.currentTarget.querySelector(`#tab-${next}`) as HTMLButtonElement)?.focus();}}>{([['speak',Mic,s.speak],['choose',MessageCircle,s.choose]] as const).map(([id,Icon,label])=><button key={id} id={`tab-${id}`} role="tab" aria-controls={`input-${id}`} aria-selected={channel === id} tabIndex={channel === id ? 0 : -1} onClick={()=>selectChannel(id)}><Icon size={17}/>{label}</button>)}</div>
                <div hidden={channel !== 'speak'} role="tabpanel" id="input-speak" aria-labelledby="tab-speak">
                  <div className="r1-speaking-example"><span className="overline">{locale === 'zh' ? '这轮可以这样回应' : 'A reply for this turn'}</span><LearningText entry={entryFor(focus === 'item' ? 'NX-ITEM-XLB' : focus === 'quantity' ? 'NX-Q2' : focus === 'mode' ? 'E09' : focus === 'confirm' ? 'E05' : 'E08')} locale={locale} romanization={showRomanization} compact/>{listenButton(entryFor(focus === 'item' ? 'NX-ITEM-XLB' : focus === 'quantity' ? 'NX-Q2' : focus === 'mode' ? 'E09' : focus === 'confirm' ? 'E05' : 'E08'))}</div>
                  <div hidden={Boolean(asrSource)}><Recorder locale={locale} enabled={asrEnabled} disabled={turnBlocked} stopSignal={stopSignal} resetSignal={recorderReset} onPhaseChange={setRecordingPhase} onTranscript={(value,requestId)=>{stopTeachingAudio();setAsrSource({text:value,requestId});setRecordingDraft(false);}} onDraftChange={setRecordingDraft} onEvent={name=>void event(name)} onError={message=>setError(message)}/></div>
                  {asrSource && <div className="r1-transcript" role="status"><span className="overline">{locale === 'zh' ? '识别到的原话' : 'Original transcript'}</span><p lang="zh">{asrSource.text}</p><div className="r1-transcript-meaning"><strong>{locale === 'zh' ? '教材对照释义' : 'Textbook meaning guide'}</strong>{transcriptMeaning ? <><p>{transcriptMeaning.meanings.join(locale === 'zh' ? '；' : ' · ')}</p><small>{locale === 'zh' ? '来自已知教材原句；仍为审阅稿，不代表订单已经保存。' : 'Matched to textbook wording. This is a draft meaning guide; your order has not been saved.'}</small></> : <><p>{locale === 'zh' ? '暂时没有这句话的对照释义。' : 'Meaning guide unavailable for this wording.'}</p><small>{locale === 'zh' ? '可以重录或使用选项；如原转写符合你的意思，也可以明确使用后查看订单核对。' : 'You can record again or choose a reply. If the transcript is what you intended, use it and check the resulting order.'}</small></>}</div><small>{locale === 'zh' ? '核对意思后再使用。识别结果不代表发音评分。' : 'Check the meaning before using it. Recognition is not a pronunciation score.'}</small><div className="r1-transcript-actions"><button className="primary" disabled={turnBlocked} onClick={()=>void submit()}>{locale === 'zh' ? '使用这句话' : 'Use this reply'}<ArrowRight size={18}/></button><button className="secondary" disabled={turnBlocked} onClick={()=>{discardTranscript();setChannel('speak');}}><RotateCcw size={17}/>{locale === 'zh' ? '重新录音' : 'Record again'}</button><button className="text-button" disabled={turnBlocked} onClick={()=>{discardTranscript();selectChannel('choose');}}>{locale === 'zh' ? '改用选项' : 'Choose instead'}</button></div></div>}
                </div>
                <div hidden={channel !== 'choose'} role="tabpanel" id="input-choose" aria-labelledby="tab-choose">
                  {asrSource && <div className="r1-retained-transcript"><span>{locale === 'zh' ? '还有一条未使用的语音转写。' : 'You have an unused transcript.'}</span><button className="text-button" disabled={turnBlocked} onClick={discardTranscript}>{locale === 'zh' ? '丢弃转写' : 'Discard transcript'}</button></div>}
                  {focus === 'edit' ? <div className="r1-edit-options"><button className="secondary" disabled={turnBlocked} onClick={()=>chooseEdit('quantity')}>{s.quantity}<ArrowRight size={17}/></button><button className="secondary" disabled={turnBlocked} onClick={()=>chooseEdit('mode')}>{s.mode}<ArrowRight size={17}/></button></div> : focus === 'confirm' ? <div className="r1-confirmation"><div className="r1-confirm-summary"><ShoppingBag size={20}/><strong>{s.xlb} · 2 {s.serving} · {s.go}</strong></div><div className="r1-confirm-reply"><LearningText entry={entryFor('E05')} locale={locale} romanization={showRomanization} compact/>{listenButton(entryFor('E05'))}</div><button className="primary full" disabled={turnBlocked || captureActive || Boolean(asrSource) || recordingDraft} onClick={()=>void submit({type:'confirm'})}>{s.confirm}<Check size={18}/></button><button className="text-button centered" disabled={turnBlocked} onClick={()=>{stopTeachingAudio();setEditing(true);setDraft({});setChannel('choose');}}><PencilLine size={16}/>{s.change}</button>{recordingDraft && <button className="text-button" onClick={()=>{setRecorderReset(n=>n+1);setRecordingDraft(false);}}>{locale === 'zh' ? '丢弃未使用的录音' : 'Discard unused recording'}</button>}</div> : <><div className="r1-answer-options">{focus === 'item' ? option('NX-ITEM-XLB',{item:'xiaolongbao'}) : focus === 'quantity' ? [1,2,3].map(quantity=>option(`NX-Q${quantity}`,{quantity,unit:'serving'})) : <>{option('NX-MODE-HERE',{takeaway:false})}{option('E09',{takeaway:true})}</>}</div>{focus === 'quantity' && <button className="text-button r1-unit-help" onClick={unitHelp}><CircleHelp size={16}/>{s.units}</button>}<div className="r1-answer-footer"><small>{hasSelection ? s.draft : s.draftHint}</small><div>{hasSelection && <button className="text-button" disabled={turnBlocked} onClick={()=>setDraft({})}>{s.clear}</button>}<button className="primary" disabled={turnBlocked || captureActive || !hasSelection} onClick={()=>void submit({type:'set_order',...questionDraft})}>{s.submit}<ArrowRight size={17}/></button></div></div></>}
                  {(editing || editFocus) && <button className="text-button r1-cancel-edit" disabled={turnBlocked} onClick={()=>{setEditing(false);setEditFocus(null);setDraft({});}}>{locale === 'zh' ? '返回当前核对' : 'Back to the current question'}</button>}
                </div>
                {busy && <div className="processing-bar" role="status"><span className="spinner"/>{s.saving}<button className="text-button" onClick={()=>void cancelTurn()}>{s.cancel}</button></div>}
                {lastText && <details className="r1-last-reply"><summary>{locale === 'zh' ? '上一条语音回应' : 'Previous spoken reply'}</summary><p>{lastText}</p></details>}
              </>}
            </section>
          </div>
        </>}
      </div>}

      {view === 'review' && <div className="review-page page-shell"><div className="page-heading"><div><span className="eyebrow">YOUR SHANGHAI, ONE MOMENT AT A TIME</span><h1>{s.reviewTitle}</h1><p>{s.reviewText}</p></div><span className="review-seal"><Footprints size={36}/></span></div><div className="review-stats"><strong>{completeCount}<small>/ 4 {s.completedCount}</small></strong><strong>{session?.attempts.reduce((n,a) => n + a.metrics.voice_attempts, 0) || 0}<small>{s.voiceTries}</small></strong><strong>{session?.attempts.reduce((n,a) => n + a.metrics.help_used, 0) || 0}<small>{s.helped}</small></strong></div><div className="review-grid">{stationIds.map((id,i) => <article className="review-stop" key={id}><div className="review-art"><Landmark kind={id} label={labelNames[locale][i]}/></div><span className="overline">0{i + 1} · {statusFor(id)}</span><h2>{labelNames[locale][i]}</h2><p>{themes[locale][i]}</p>{id === 'nanxiang' ? <button className="secondary" onClick={enter}>{attempt?.status === 'completed' ? s.reviewOrder : s.enter}<ArrowUpRight size={16}/></button> : <span className="in-making-text">{s.coming}</span>}</article>)}</div><p className="review-disclaimer">{s.noMastery}</p><button className="primary" onClick={() => navigate('map')}>{s.continue}<ArrowRight size={18}/></button></div>}

      {view === 'design' && <div className="design-page page-shell"><div className="page-heading"><div><span className="eyebrow">DESIGN SYSTEM · 01</span><h1>{s.designTitle}</h1><p>{s.designText}</p></div></div><div className="design-swatches">{['#214f46','#a04d3b','#d9bd8d','#f4eee3','#292f2a'].map(color => <div key={color}><span style={{background:color}}/>{color}</div>)}</div><div className="design-state-grid"><article><span className="overline">01 · INPUT</span><h2>{s.stateRecording}</h2><div className="sample-recording"><Mic size={24}/><span>00:08 / 00:20</span><AudioLines size={54}/></div><p>{locale === 'zh' ? '主动开始，停止后先回听。' : 'Start deliberately. Listen back before sending.'}</p><button className="secondary" onClick={() => setPanel('about')}>{s.about}</button></article><article><span className="overline">02 · WAITING</span><h2>{s.stateProcessing}</h2><div className="processing-sample"><span className="spinner"/>{s.waiting}</div><p>{locale === 'zh' ? '保存前不展示完成，回应草稿仍保留。' : 'Keep the reply draft. Show completion only after saving.'}</p></article><article><span className="overline">03 · RECOVERY</span><h2>{s.stateError}</h2><div className="sample-error"><CircleHelp size={20}/>{s.error}</div><p>{s.permissionError}</p></article><article><span className="overline">04 · CONFIRMATION</span><h2>{s.stateConfirm}</h2><div className="sample-order"><ShoppingBag size={25}/><strong>{s.xlb} · 2 {s.serving} · {s.go}</strong></div><p>{s.confirmText}</p></article><article><span className="overline">05 · SAVED</span><h2>{s.stateSuccess}</h2><div className="completion-stamp"><Check size={24}/>{s.stamp}</div><p>{s.successFoot}</p></article><article><span className="overline">06 · LEARNING SUPPORT</span><h2>{s.supportTitle}</h2><p>{s.supportDesc}</p><button className="secondary" onClick={help}>{s.how}<ArrowRight size={17}/></button></article></div></div>}
    </main>
    <footer className="site-footer"><span>沪语漫游 <span className="footer-dot">·</span> A LITTLE SHANGHAI</span><div><button onClick={() => setPanel('about')}>{s.about}</button><span>/</span><button onClick={() => navigate('design')}>{s.design}</button></div></footer>

    {panel && <Dialog title={{help:s.supportTitle, settings:s.settings, intro:s.introTitle, units:s.unitTitle, about:s.about, skip:s.skipTitle, leaveRecording:s.leaveRecording, newSession:locale === 'zh' ? '开始新的探索' : 'Start a new journey'}[panel]} closeLabel={s.close} onClose={() => setPanel(null)} className={panel === 'help' ? 'help-dialog' : panel === 'intro' ? 'intro-dialog' : ''}>
      {panel === 'help' && <><p className="dialog-description">{s.supportDesc}</p><button className="roman-toggle" disabled={savingPreferences} aria-pressed={showRomanization} onClick={()=>void preferences({show_romanization:!showRomanization})}><span className={`toggle ${showRomanization ? 'on' : ''}`}/>{s.pronunciation}</button><div className="phrase-cards">{learningEntries.map(entry=><article className="phrase-card" key={entry.id}><div className="phrase-card-top"><span className="overline">{entry.id}</span><span className="review-label">{s.candidate}</span></div><LearningText entry={entry} locale={locale} romanization={showRomanization}/><div className="audio-buttons">{listenButton(entry)}<small>{s.slow}</small></div>{locale === 'zh' && <div className="approximation"><button onClick={()=>{setShowApproximate(showApproximate === entry.id ? null : entry.id);void event('pronunciation_support_changed',{expression_id:entry.id,kind:'approximation'});}} aria-expanded={showApproximate === entry.id}>{s.approximate}<ChevronRight size={16}/></button>{showApproximate === entry.id && <p><strong>{s.approximateLabel}</strong><br/>{s.approximatePending}</p>}</div>}</article>)}</div>{audioMessage && <p className="audio-notice" role="status">{audioMessage}</p>}<p className="dialog-footnote">{locale === 'zh' ? '沪语、词组注音和常速声音均为审阅稿。慢速声音将在常速读法选定后制作。' : 'Shanghainese, grouped readings, and normal-speed audio are review drafts. Slow recordings will follow after the normal readings are reviewed.'}</p></>}
      {panel === 'settings' && <><div className="setting-row"><div><h3>{s.language}</h3><p>{s.languageText}</p></div><div className="segmented"><button className={locale === 'zh' ? 'selected' : ''} disabled={savingPreferences} onClick={() => void preferences({locale:'zh'})}>中文</button><button className={locale === 'en' ? 'selected' : ''} disabled={savingPreferences} onClick={() => void preferences({locale:'en'})}>English</button></div></div>{[{key:'show_romanization',label:s.pronunciation,description:s.romanHelp},{key:'reduced_motion',label:s.motion,description:s.motionText}].map(option => <div className="setting-row" key={option.key}><div><h3>{option.label}</h3><p>{option.description}</p></div><button className={`toggle ${session?.[option.key as 'show_romanization' | 'reduced_motion'] ? 'on' : ''}`} role="switch" disabled={savingPreferences} aria-checked={Boolean(session?.[option.key as 'show_romanization' | 'reduced_motion'])} aria-label={option.label} onClick={() => void preferences({[option.key]:!session?.[option.key as 'show_romanization' | 'reduced_motion']})}/></div>)}<div className="setting-row"><div><h3>{locale === 'zh' ? '店员声音' : 'Host audio'}</h3><p>{locale === 'zh' ? '你开始交流或提交回应后，播放下一句审阅声音。' : 'Play the next review recording when you start or send a reply.'}</p></div><button className={`toggle ${autoVoice ? 'on' : ''}`} role="switch" aria-checked={autoVoice} aria-label={locale === 'zh' ? '店员声音' : 'Host audio'} onClick={()=>{const next=!autoVoice;setAutoVoice(next);try {localStorage.setItem('shanghai-review-autovoice',next ? 'on':'off');} catch {}if(!next) stopTeachingAudio();}}/></div><p className="dialog-footnote">{s.aboutSpeech}</p><button className="secondary full" disabled={busy || savingPreferences || !session} onClick={() => setPanel('newSession')}><RotateCcw size={17}/>{locale === 'zh' ? '开始新的探索' : 'Start a new journey'}</button></>}
      {panel === 'newSession' && <><p className="intro-description">{locale === 'zh' ? '将从 0 个地点重新开始，并保留语言和显示偏好。当前探索的记录仍会保存，但不会带入新的探索。' : 'Start again from 0 places while keeping your language and display preferences. Your previous journey remains saved, but its progress will not carry into this one.'}</p><p className="dialog-description">{locale === 'zh' ? '当前未使用的转写、选择和录音会清除。确定开始吗？' : 'Unused transcripts, choices, and recordings will be cleared. Ready to begin?'}</p><div className="dialog-actions"><button className="secondary" disabled={busy} onClick={() => setPanel('settings')}>{s.cancel}</button><button className="primary" disabled={busy || savingPreferences} onClick={() => void startNewSession()}>{locale === 'zh' ? '开始新的探索' : 'Start a new journey'}<ArrowRight size={18}/></button></div></>}
      {panel === 'intro' && <><div className="intro-art"><Landmark kind="nanxiang" label={labelNames[locale][2]}/></div><span className="eyebrow">{s.introduction}</span><p className="intro-description">{s.introText}</p><div className="intro-steps"><span>01 <strong>{locale === 'zh' ? '说数量' : 'Say how many'}</strong></span><ChevronRight size={16}/><span>02 <strong>{s.go}</strong></span><ChevronRight size={16}/><span>03 <strong>{locale === 'zh' ? '核对' : 'Confirm'}</strong></span></div><p className="dialog-description">{s.modes}</p><button className="primary full" disabled={busy || !session} onClick={() => void begin()}>{s.start}<ArrowRight size={18}/></button></>}
      {panel === 'units' && <><div className="unit-baskets"><ServingIllustration/><span>+</span><ServingIllustration/><strong>2 {s.serving}</strong></div><p className="intro-description">{s.unitText}</p><button className="primary full" onClick={() => setPanel(null)}>{s.understood}<Check size={18}/></button></>}
      {panel === 'about' && <><span className="preview-badge">{s.preview}</span><p className="intro-description">{s.aboutText}</p><p className="dialog-description">{s.aboutSpeech}</p>{loggingGap && <p className="sample-error">{locale === 'zh' ? '部分帮助记录未能保存，练习统计可能不完整。' : 'Some help events were not saved; practice statistics may be incomplete.'}</p>}<button className="secondary full" onClick={() => navigate('design')}>{s.design}<ArrowRight size={18}/></button></>}
      {panel === 'skip' && <><p className="intro-description">{s.skipText}</p><div className="dialog-actions"><button className="secondary" onClick={() => setPanel(null)}>{s.keep}</button><button className="primary" disabled={busy} onClick={() => void skip()}>{s.skipConfirm}<ArrowRight size={18}/></button></div></>}
      {panel === 'leaveRecording' && <><p className="intro-description">{s.leaveRecordingText}</p><div className="dialog-actions"><button className="secondary" onClick={() => setPanel(null)}>{s.keep}</button><button className="primary" onClick={() => {setRecordingDraft(false); navigate(destination.current, true);}}>{s.leaveAnyway}<ArrowRight size={18}/></button></div></>}
    </Dialog>}
  </div>;
}
