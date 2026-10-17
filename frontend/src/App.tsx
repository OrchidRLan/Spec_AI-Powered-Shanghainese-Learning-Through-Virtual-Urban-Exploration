import { useEffect, useRef, useState } from 'react';
import { ArrowRight, ArrowUpRight, AudioLines, BookOpen, Check, CheckCircle2, ChevronLeft, ChevronRight, CircleHelp, Clock3, Compass, Footprints, Globe2, MapPin, MessageCircle, Mic, Minus, Navigation, PackageCheck, PencilLine, Play, RotateCcw, Settings2, ShoppingBag, Sparkles, Volume2, X } from 'lucide-react';
import Dialog from './components/Dialog';
import Recorder from './components/Recorder';
import GuidedPractice from './components/GuidedPractice';
import StationLesson from './components/StationLesson';
import { stationPlanFor, stationEntryFor, completedAttemptFor } from './lib/stationContent';
import { GardenMap, Landmark, NanxiangScene, type ScenePose } from './components/SceneArt';
import { api, post, ApiError, type Action, type Attempt, type Locale, type Session, type TurnRequest, type TurnResult } from './lib/api';
import { strings } from './lib/i18n';
import content from '../../content/batch-a.json';
import LearningText, { type LearningEntry } from './components/LearningText';
import { cursorForQuestion, readQuestionCursors, saveQuestionCursors, readOrderEdit, saveOrderEdit, readFallbacks, writeFallback } from './lib/conversation';
import { reviewClipFor } from './lib/reviewAudio';
import { orderConfirmationFor } from './lib/orderConfirmation';
import { stopAllAudio } from './lib/audio';
import './styles.css';
import './styles-revision1.css';
import './styles-revision2.css';
import './styles-revision3.css';
import './styles-revision4.css';
import './styles-stations.css';

type View = 'map' | 'nanxiang' | 'restaurant' | 'candy' | 'teahouse' | 'review' | 'design';
type Panel = 'settings' | 'intro' | 'units' | 'about' | 'skip' | 'leaveRecording' | 'newSession' | null;
type StationId = 'restaurant' | 'candy' | 'nanxiang' | 'teahouse';
const stationIds: StationId[] = ['restaurant', 'candy', 'nanxiang', 'teahouse'];
const stationPositions = [{ x: 25, y: 47 }, { x: 69, y: 42 }, { x: 30, y: 85 }, { x: 76, y: 78 }];
const labelNames = { zh: ['上海老饭店', '上海梨膏糖商店', '南翔馒头店', '湖心亭茶楼'], en: ['Shanghai Old Restaurant', 'Shanghai Pear Candy Shop', 'Nanxiang Steamed Bun Restaurant', 'Huxin Pavilion Teahouse'] };
const shortNames = { zh: ['老饭店', '梨膏糖商店', '南翔馒头店', '湖心亭茶楼'], en: ['Old Restaurant', 'Pear Candy Shop', 'Nanxiang', 'Huxin Pavilion'] };
const themes = { zh: ['偏好与推荐', '听辨与挑选', '点单与核对', '赞茶与道谢'], en: ['Preferences & recommendations', 'Listen & choose', 'Order & confirm', 'Tea & a little gratitude'] };
const durations = ['5–6', '5–7', '5–6', '3–4'];
const stationTasks = {
  zh: ['聊聊口味，挑一道想吃的上海菜。', '听听介绍，找出对应口味的梨膏糖。', '点小笼包，选择份数和用餐方式。', '坐下来喝杯茶，说说味道与谢意。'],
  en: ['Share your tastes and choose a Shanghai dish.', 'Listen and find the pear candy flavor you hear.', 'Order xiaolongbao and choose how many servings and where to eat.', 'Enjoy a cup of tea and share your thanks.'],
};
type QuestionFocus = 'item' | 'quantity' | 'mode' | 'confirm' | 'edit';
const learningEntries: LearningEntry[] = [...content.dialogues, ...content.expressions, ...content.supportTerms];
const entryFor = (id: string) => learningEntries.find(entry => entry.id === id)!;
function hostEntryFor(attempt: Attempt | null, promptId: string): LearningEntry {
  if (attempt?.practice?.step === 'confirm' && attempt.status !== 'completed' && promptId === 'NX-N09') {
    return orderConfirmationFor(attempt.order) || entryFor(promptId);
  }
  return entryFor(promptId);
}
function focusFor(attempt: Attempt | null): QuestionFocus {
  if(attempt?.practice) return attempt.practice.step;
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
function getView(): View { const view = window.location.hash.slice(1); return ['nanxiang', 'restaurant', 'candy', 'teahouse', 'review', 'design'].includes(view) ? view as View : 'map'; }

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [locale, setLocale] = useState<Locale>('zh');
  const [view, setView] = useState<View>(getView);
  const [selected, setSelected] = useState<StationId>('nanxiang');
  const [reviewStation, setReviewStation] = useState<StationId>('nanxiang');
  const [panel, setPanel] = useState<Panel>(null);
  const [error, setError] = useState('');
  const [booting, setBooting] = useState(true);
  const [busy, setBusy] = useState(false);
  const [awaitingReplyResolution, setAwaitingReplyResolution] = useState(false);
  const [savingPreferences, setSavingPreferences] = useState(false);
  const preferencesInFlight = useRef(false);
  const sessionResetInFlight = useRef(false);
  const [channel, setChannel] = useState<'speak' | 'choose'>('speak');
  const [draft, setDraft] = useState<{ item?: string; quantity?: number; unit?: string; takeaway?: boolean }>({});
  const [asrSource, setAsrSource] = useState<{text:string;requestId:string}|null>(null);
  const [asrEnabled, setAsrEnabled] = useState(false);
  const [lastText, setLastText] = useState('');
  const [recordingDraft, setRecordingDraft] = useState(false);
  const [stopSignal, setStopSignal] = useState(0);
  const editSummary = useRef<number | null>(null);
  const questionCursors = useRef(readQuestionCursors());
  const [editing, setEditing] = useState(false);
  const [editFocus, setEditFocus] = useState<QuestionFocus | null>(null);
  const [recordingPhase, setRecordingPhase] = useState<'idle'|'recording'|'processing'|'playback'>('idle');
  const [recorderReset, setRecorderReset] = useState(0);
  const [transientPose, setTransientPose] = useState<'acknowledging'|'packing'|null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [audioMessage, setAudioMessage] = useState('');
  const [autoVoice, setAutoVoice] = useState(() => {try {return localStorage.getItem('shanghai-review-autovoice') !== 'off';} catch {return true;}});
  const [audioSpeed, setAudioSpeed] = useState<1 | 0.75>(() => {try {return localStorage.getItem('shanghai-audio-speed') === '0.75' ? 0.75 : 1;} catch {return 1;}});
  const audioSpeedRef = useRef(audioSpeed);
  audioSpeedRef.current = audioSpeed;
  const [speakTarget, setSpeakTarget] = useState<string | null>(null);
  const [fallbacks, setFallbacks] = useState<Record<string, boolean>>(readFallbacks);
  const [speechNotice, setSpeechNotice] = useState<'recognition' | 'technical' | ''>('');
  const questionRef = useRef('');
  const submittingRef = useRef(false);
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
  const attempt = session?.attempts.find(a => a.id === activeAttemptId && a.station_id === 'nanxiang') || [...(session?.attempts || [])].reverse().find(a => a.station_id === 'nanxiang') || null;
  const legacyContent = Boolean(session && session.content_version !== content.contentVersion);
  const reviewUnlocked = !legacyContent && Boolean(session?.attempts.some(item => item.status === 'completed'));
  const lessonStation = view === 'restaurant' || view === 'candy' || view === 'teahouse' ? view : null;
  const lessonAttempt = lessonStation ? session?.attempts.find(item => item.id === activeAttemptId && item.station_id === lessonStation) || [...(session?.attempts || [])].reverse().find(item => item.station_id === lessonStation) || null : null;
  const selectedAttempt = [...(session?.attempts || [])].reverse().find(item=>item.station_id === selected) || null;
  const currentAttempt = lessonStation ? lessonAttempt : view === 'review' ? completedAttemptFor(session?.attempts || [], reviewStation) || null : attempt;
  const completeCount = session?.completed_station_ids.length || 0;
  const selectedIndex = stationIds.indexOf(selected);

  async function loadSession() {
    setBooting(true); setError('');
    try { const next = await api<Session>('/session'); setSession(next); setLocale(next.locale); const savedAttempt=[...next.attempts].reverse().find(item=>item.station_id === 'nanxiang') || null; const edit=readOrderEdit(savedAttempt); if(edit){setEditing(true);setEditFocus(edit.focus);editSummary.current=edit.summary;} const services = await api<{asr:{enabled:boolean}}>('/services'); setAsrEnabled(services.asr.enabled); }
    catch { setError(strings[locale].offline); }
    finally { setBooting(false); }
  }
  useEffect(() => { void loadSession(); const update = () => {const next = getView(); if(next !== viewRef.current) navigationHandler.current(next);}; window.addEventListener('hashchange', update); return () => window.removeEventListener('hashchange', update); }, []);
  useEffect(() => { document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en'; document.title = `${s.brand} · ${stationIds.includes(view as StationId) ? shortNames[locale][stationIds.indexOf(view as StationId)] : view === 'review' ? s.review : s.map}`; setStopSignal(n => n + 1); }, [locale, view]);
  useEffect(() => { const warn = (e:BeforeUnloadEvent) => {if(recordingDraft){e.preventDefault();e.returnValue='';}}; window.addEventListener('beforeunload',warn); return () => window.removeEventListener('beforeunload',warn); },[recordingDraft]);
  useEffect(()=>{ if(session && !completedAttemptFor(session.attempts,reviewStation)) { const first=stationIds.find(id=>completedAttemptFor(session.attempts,id)); if(first) setReviewStation(first); } },[session?.attempts,reviewStation]);
  useEffect(() => { document.documentElement.dataset.reducedMotion = String(session?.reduced_motion || false); }, [session?.reduced_motion]);
  function replaceAttempt(next: Attempt, allowCreate = false) {
    setSession(previous => previous ? { ...previous, attempts: previous.attempts.some(a => a.id === next.id) ? previous.attempts.map(a => a.id === next.id && a.revision <= next.revision ? next : a) : allowCreate ? [...previous.attempts, next] : previous.attempts, completed_station_ids: next.status === 'completed' && previous.attempts.some(a => a.id === next.id) ? Array.from(new Set([...previous.completed_station_ids, next.station_id])) : previous.completed_station_ids } : previous);
    }
  async function event(event_type: string, metadata: Record<string, unknown> = {}) {
    if (!sessionRef.current) return;
    try { await post('/events', { event_id: crypto.randomUUID(), attempt_id: currentAttempt?.id, event_type, metadata }); if(currentAttempt) { const next=await api<Attempt>(`/attempts/${currentAttempt.id}`); setSession(previous => previous ? {...previous,attempts:previous.attempts.map(current=>current.id === next.id ? {...current,metrics:{voice_attempts:Math.max(current.metrics.voice_attempts,next.metrics.voice_attempts),help_used:Math.max(current.metrics.help_used,next.metrics.help_used)}} : current)} : previous); } }
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
    if(next === 'review' && !sessionRef.current?.attempts.some(item=>item.status === 'completed')) next = 'map';
    if (recordingDraft && stationIds.includes(view as StationId) && next !== view && !force) { stopTeachingAudio();setStopSignal(n=>n+1);destination.current = next; window.history.replaceState(null,'',`#${view}`); setPanel('leaveRecording'); return; }
    generation.current += 1; submittingRef.current=false; stopTeachingAudio(); controller.current?.abort(); if(!sessionResetInFlight.current) setBusy(false); setAwaitingReplyResolution(false); setPanel(null); setError(''); setStopSignal(n => n + 1);
    const pendingId = viewRef.current === 'nanxiang' ? lastRequest.current?.body.request_id || attempt?.pending_request_id : null;
    if(pendingId && attempt) { void post<TurnResult>(`/attempts/${attempt.id}/turns/${pendingId}/cancel`, {expected_revision:attempt.revision}).then(result=>replaceAttempt(result.attempt)).catch(()=>setError(s.error)); lastRequest.current=null; }
    if(next === 'map') setActiveAttemptId(null);
    viewRef.current = next; window.location.hash = next; setView(next); window.scrollTo({ top: 0, behavior: 'instant' }); requestAnimationFrame(() => document.getElementById('main-content')?.focus({preventScroll:true}));
  }
  navigationHandler.current = navigate;
  async function begin(restart = false, station: StationId = 'nanxiang') {
    if(sessionResetInFlight.current || busy) return;
    if(legacyContent) {setPanel('newSession');return;}
    setBusy(true); setError('');
    const ticket = ++generation.current;
    try {
      const next = await post<Attempt>('/attempts', { station_id: station, restart });
      if(ticket !== generation.current) return;
      replaceAttempt(next, true); setActiveAttemptId(next.id); setDraft({}); setSpeakTarget(null); setChannel('speak'); setSpeechNotice(''); setAsrSource(null); setLastText(''); setEditing(false); setEditFocus(null); setRecordingDraft(false); setRecorderReset(n=>n+1); setTransientPose(null); lastRequest.current = null;
      navigate(station, true);
      if(station === 'nanxiang') scheduleQuestion(next, 200);
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
      lastRequest.current = null; setSession(next); setLocale(next.locale); setActiveAttemptId(null); setDraft({}); setSpeakTarget(null); setChannel('speak'); setSpeechNotice(''); setAsrSource(null); setLastText(''); setEditing(false); setEditFocus(null); setRecorderReset(n=>n+1); setTransientPose(null); setOrderExpanded(false); setRecordingDraft(false); setLoggingGap(false); setPanel(null);
      viewRef.current = 'map'; window.location.hash = 'map'; setView('map'); window.scrollTo({top:0,behavior:'instant'}); requestAnimationFrame(() => document.getElementById('main-content')?.focus({preventScroll:true}));
    } catch { setPanel(null); setError(s.error); }
    finally {generation.current += 1; sessionResetInFlight.current = false;setBusy(false);}
  }
  function enter() {
    if(selected !== 'nanxiang') { setActiveAttemptId(selectedAttempt?.id || null); navigate(selected); return; }
    if(attempt && attempt.status !== 'skipped') navigate('nanxiang'); else setPanel('intro');
  }
  function openReview(station: StationId) { setReviewStation(station); navigate('review'); }
  function openSavedStation(station: StationId) { const saved=completedAttemptFor(sessionRef.current?.attempts || [],station); if(saved) {setActiveAttemptId(saved.id);navigate(station);} }
  function changeAudioSpeed(speed: 1 | 0.75) { setAudioSpeed(speed); audioSpeedRef.current=speed; if(teachingAudio.current){teachingAudio.current.playbackRate=speed;teachingAudio.current.preservesPitch=true;} try {localStorage.setItem('shanghai-audio-speed',String(speed));} catch {} }
  function applyTurnResult(result:TurnResult, body?:TurnRequest) {
    const previous = sessionRef.current?.attempts.find(current => current.id === result.attempt.id);
    replaceAttempt(result.attempt);
    if(['applied','failed','cancelled'].includes(result.status)) setAwaitingReplyResolution(false);
    if(result.status === 'applied') {
      const retryReply=result.speech_feedback?.outcome === 'retry' || (Boolean(editing || editFocus) && result.speech_feedback?.reason === 'confirmation_required');
      const keepEditing=Boolean(editing || editFocus) && (retryReply || result.speech_feedback?.reason === 'repeat_requested');
      if(body?.channel === 'buttons') setDraft(current => Object.entries(current).every(([key,value]) => (body.action as unknown as Record<string,unknown>)?.[key] === value) ? {} : current);
      else if(body?.text) {setLastText(body.text);setAsrSource(current => current?.requestId === body.asr_request_id ? null : current);setRecorderReset(n=>n+1);}
      if(retryReply) {
        unlockFallback('recognition');
        const nextCursor=cursorForQuestion(result.attempt, (editing || editFocus) ? focus : focusFor(result.attempt), Boolean(editing || editFocus), questionCursors.current[result.attempt.id]);
        questionCursors.current[result.attempt.id]=nextCursor;
        setFallbacks(current=>writeFallback(current,nextCursor.key));
      } else {if(!keepEditing){setEditing(false);setEditFocus(null);}setSpeechNotice('');}
      lastRequest.current=null;setError('');
      if(previous && previous.revision <= result.attempt.revision && viewRef.current === 'nanxiang') {
        if(result.attempt.status === 'completed' && previous.status !== 'completed') {
          setTransientPose('packing');

        } else if(result.attempt.status !== 'completed') {
          setTransientPose('acknowledging');

        }
        scheduleQuestion(result.attempt, result.attempt.status === 'completed' ? 250 : 550, keepEditing ? localPrompt : result.attempt.prompt_id);
      }
    } else if(result.status === 'failed') {if(lastRequest.current) lastRequest.current={...lastRequest.current,body:{...lastRequest.current.body,request_id:crypto.randomUUID()}};setError(s.error);if(body?.channel === 'voice') unlockFallback('technical');}
    else if(result.status === 'cancelled') {lastRequest.current=null;setError('');}
  }
  async function submit(action?: Action, repeat = false, spoken?: {text:string;requestId:string}) {
    if(legacyContent) {setPanel('newSession');return;}
    const source=spoken || asrSource;
    if (!attempt || booting || busy || submittingRef.current || (!repeat && pendingRecovery) || sessionResetInFlight.current || (!action && !repeat && !source)) return;
    if(action && !repeat && !canChoose) return;
    submittingRef.current=true;
    stopTeachingAudio();
    setBusy(true); setError('');setAwaitingReplyResolution(false);
    const ticket = ++generation.current;
    const body: TurnRequest = repeat && lastRequest.current ? lastRequest.current.body : { request_id: crypto.randomUUID(), expected_revision: attempt.revision, channel: action ? 'buttons' : 'voice', ...(action ? {action} : {text: source!.text, asr_request_id:source!.requestId}), ...(focus === 'confirm' && !editing && !editFocus && attempt.summary_revision !== null ? { summary_revision: attempt.summary_revision } : {}) };
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
      else if(!(e instanceof DOMException && e.name === 'AbortError')) {setError(s.error);setAwaitingReplyResolution(true);}
      if(body.channel === 'voice' && !(e instanceof DOMException && e.name === 'AbortError')) unlockFallback('technical');
    } finally { if(ticket === generation.current) {setBusy(false);submittingRef.current=false;} }
  }
  async function cancelTurn() {
    if(!attempt) return;
    const attemptId=attempt.id;
    const snapshot=lastRequest.current?.attemptId === attemptId ? lastRequest.current : null;
    const requestId=snapshot?.body.request_id || attempt.pending_request_id;
    if(!requestId) return;
    const ticket=++generation.current;
    const isCurrent=()=>ticket === generation.current && (snapshot ? lastRequest.current === snapshot : !lastRequest.current && sessionRef.current?.attempts.find(item=>item.id === attemptId)?.pending_request_id === requestId);
    submittingRef.current=false;controller.current?.abort();setBusy(true);setAwaitingReplyResolution(true);
    try {
      await post(`/attempts/${attemptId}/turns/${requestId}/cancel`, {expected_revision:attempt.revision});
      if(!isCurrent()) return;
      const next=await api<Attempt>(`/attempts/${attemptId}`);
      if(!isCurrent()) return;
      replaceAttempt(next);lastRequest.current=null;setAwaitingReplyResolution(false);setAsrSource(null);setRecorderReset(n=>n+1);setError('');
    } catch {
      if(isCurrent()){setError(s.error);setAwaitingReplyResolution(true);}
    } finally {if(ticket === generation.current) setBusy(false);}
  }
  async function recoverPending() {
    if(!attempt) return;
    const attemptId=attempt.id;
    const snapshot=lastRequest.current?.attemptId === attemptId ? lastRequest.current : null;
    const requestId=snapshot?.body.request_id || attempt.pending_request_id;
    if(!requestId) return;
    const body=snapshot?.body;
    const ticket=generation.current;
    const isCurrent=()=>ticket === generation.current && (snapshot ? lastRequest.current === snapshot : !lastRequest.current && sessionRef.current?.attempts.find(item=>item.id === attemptId)?.pending_request_id === requestId);
    try {
      const result=await api<TurnResult>(`/attempts/${attemptId}/turns/${requestId}`);
      if(isCurrent()) applyTurnResult(result,body);
    } catch {if(isCurrent()) setError(s.error);}
  }
  async function skip() {
    if(!currentAttempt || sessionResetInFlight.current) return;
    setBusy(true);
    try { const next = await post<Attempt>(`/attempts/${currentAttempt.id}/skip`, { expected_revision: currentAttempt.revision }); replaceAttempt(next); setRecordingDraft(false); navigate('map', true); }
    catch { setError(s.error); } finally { setBusy(false); }
  }
  function unitHelp() { stopTeachingAudio(); setStopSignal(n=>n+1); setPanel('units'); void event('unit_explanation_viewed'); }
  const statusFor = (id: string) => session?.completed_station_ids.includes(id) ? s.completed : [...(session?.attempts || [])].reverse().find(a => a.station_id === id)?.status === 'skipped' ? s.skipped : session?.attempts.some(a => a.station_id === id) ? s.inProgress : s.notStarted;
  const pendingRecovery = attempt?.pending_request_id || (awaitingReplyResolution ? lastRequest.current?.body.request_id : null);
  const turnBlocked = booting || busy || Boolean(pendingRecovery);
  const captureActive = recordingPhase === 'recording' || recordingPhase === 'processing';
  const focus = editing ? (editFocus || 'edit') : (editFocus || focusFor(attempt));
  const localPrompt = attempt?.practice ? (attempt.status === 'completed' ? 'NX-N10' : {item:'NX-N01',quantity:'NX-N02',mode:'NX-N03',confirm:'NX-N09'}[attempt.practice.step]) : editFocus ? (editFocus === 'quantity' ? 'NX-N02' : editFocus === 'mode' ? 'NX-N03' : 'NX-N01') : editing ? 'NX-N11' : attempt?.prompt_id || 'NX-N01';
  const promptEntry = hostEntryFor(attempt, localPrompt);
  const questionCursor = cursorForQuestion(attempt, focus, Boolean(editing || editFocus), attempt ? questionCursors.current[attempt.id] : undefined);
  if(attempt) questionCursors.current[attempt.id]=questionCursor;
  const questionKey = questionCursor.key;
  questionRef.current = questionKey;
  const canChoose = !booting && (!asrEnabled || Boolean(fallbacks[questionKey]));
  const selectedPractice = speakTarget ? entryFor(speakTarget) : null;
  const practiceIds = focus === 'item' ? ['NX-ITEM-XLB'] : focus === 'quantity' ? ['NX-Q1','NX-Q2','NX-Q3'] : focus === 'mode' ? ['NX-MODE-HERE','E09'] : focus === 'confirm' ? ['E05'] : [];
  useEffect(() => {
    setChannel('speak');setSpeakTarget(null);setDraft({});setSpeechNotice('');setAsrSource(null);setRecordingDraft(false);setRecorderReset(n=>n+1);
    saveQuestionCursors(questionCursors.current);
  },[questionKey]);
  useEffect(()=>{if(attempt) saveOrderEdit(attempt.id, editing || editFocus ? {focus:editFocus,summary:editSummary.current} : null);},[attempt?.id,editing,editFocus]);
  useEffect(() => {if(session && view === 'review' && !reviewUnlocked) navigate('map',true);},[session?.id,reviewUnlocked,view]);
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
            : !attempt?.practice && attempt?.unresolved_issues.length ? 'clarifying'
              : attempt?.status === 'confirming' ? 'checking' : 'idle';
  const phaseLabel = scenePose === 'speaking' ? (locale === 'zh' ? '店员正在说话' : 'Your host is speaking')
    : scenePose === 'listening' ? (locale === 'zh' ? '店员在听' : 'Your host is listening')
      : scenePose === 'thinking' ? s.waiting
        : scenePose === 'packing' ? (attempt?.order.takeaway ? (locale === 'zh' ? '正在准备你的外带订单' : 'Preparing your takeaway order') : (locale === 'zh' ? '正在准备你的餐点' : 'Preparing your order'))
          : scenePose === 'acknowledging' ? (locale === 'zh' ? '收到你的回应了' : 'Reply received')
            : scenePose === 'packed' ? s.stamp : (locale === 'zh' ? '轮到你回应' : 'Your turn');
  const quantityLabel = attempt?.order.quantity != null ? `${attempt.order.quantity} ${attempt.order.unit === 'piece' ? s.piece : attempt.order.unit === 'basket' ? s.basket : attempt.order.unit === 'serving' ? (locale === 'en' && attempt.order.quantity === 1 ? 'serving' : s.serving) : ''}` : s.unknown;
  const orderDescription = `${attempt?.order.item === 'xiaolongbao' ? s.xlb : s.unknown} · ${quantityLabel} · ${attempt?.order.takeaway === true ? s.go : attempt?.order.takeaway === false ? s.here : s.unknown}`;
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
    player.src=clip.file;player.playbackRate=audioSpeedRef.current;player.preservesPitch=true;
    try {await player.play();}
    catch {if(ticket === audioGeneration.current) {setPlayingId(null);setAudioMessage(locale === 'zh' ? '声音未能播放。请点句子旁的播放键重听。' : 'Audio could not play. Use the sentence’s Listen button to try again.');}}
  }
  function scheduleQuestion(next:Attempt, delay:number, promptId = next.prompt_id) {
    if(!autoVoice) return;
    if(next.practice?.result && next.status !== 'completed') return;
    if(promptTimer.current) clearTimeout(promptTimer.current);
    const ticket=generation.current;
    promptTimer.current=setTimeout(()=>{
      if(ticket === generation.current && viewRef.current === 'nanxiang' && recordingPhaseRef.current === 'idle') void playEntry(hostEntryFor(next,promptId),'host');
    },delay);
  }
  useEffect(() => {
    audioGeneration.current += 1;stopAllAudio();setPlayingId(null);setAudioMessage('');
  },[locale,view]);
  useEffect(()=>{if(!transientPose) return;poseTimer.current=setTimeout(()=>setTransientPose(null),transientPose === 'packing' ? 1850 : 550);return()=>{if(poseTimer.current) clearTimeout(poseTimer.current);};},[transientPose]);
  useEffect(()=>()=>{if(promptTimer.current) clearTimeout(promptTimer.current);if(poseTimer.current) clearTimeout(poseTimer.current);stopAllAudio();},[]);
  function listenButton(entry:LearningEntry, role:'host'|'example'='example') {
    const available=Boolean(reviewClipFor(entry));
    return <button type="button" className={`sentence-listen ${playingId === entry.id ? 'is-playing' : ''}`} disabled={!available || captureActive}
      aria-label={`${locale === 'zh' ? '试听' : 'Listen to'} ${entry.hanzi || entry.meaning[locale]}`}
      title={available ? (audioSpeed === 1 ? s.normal : s.slow) : s.audioPending} onClick={()=>void playEntry(entry,role)}><Volume2 size={18}/><span>{available ? (audioSpeed === 1 ? s.normal : s.slow) : s.audioPending}</span></button>;
  }
  function speedControls() {
    return <div className="r2-speed" role="group" aria-label={locale === 'zh' ? '播放速度' : 'Playback speed'}>{([1,0.75] as const).map(speed=><button type="button" key={speed} aria-pressed={audioSpeed === speed} disabled={captureActive} onClick={()=>{setAudioSpeed(speed);audioSpeedRef.current=speed;if(teachingAudio.current){teachingAudio.current.playbackRate=speed;teachingAudio.current.preservesPitch=true;}try{localStorage.setItem('shanghai-audio-speed',String(speed));}catch{}}}>{speed === 1 ? s.normal : s.slow}<small>{speed}×</small></button>)}</div>;
  }
  function unlockFallback(reason:'recognition'|'technical', key = questionRef.current) {
    setFallbacks(current=>writeFallback(current,key));
    setSpeechNotice(reason);
  }
  function selectChannel(next:'speak'|'choose') {
    if(next === 'choose' && !canChoose) return;
    setChannel(next);stopTeachingAudio();setAsrSource(null);setRecordingDraft(false);setRecorderReset(n=>n+1);setStopSignal(n=>n+1);void event('input_channel_changed',{channel:next});
  }
  function chooseEdit(next:'quantity'|'mode') {stopTeachingAudio();setEditFocus(next);setDraft({});setSpeakTarget(null);setChannel('speak');setRecorderReset(n=>n+1);}
  function selectPractice(id:string) {
    if(turnBlocked || captureActive) return;
    stopTeachingAudio();setSpeakTarget(id);setAsrSource(null);setRecordingDraft(false);setRecorderReset(n=>n+1);setError('');
  }
  function changeOrder() {stopTeachingAudio();editSummary.current=attempt?.summary_revision ?? null;setEditing(true);setEditFocus(null);setDraft({});setSpeakTarget(null);setChannel('speak');setRecordingDraft(false);setRecorderReset(n=>n+1);}
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
        <button className={view === 'map' || stationIds.includes(view as StationId) ? 'active' : ''} onClick={() => navigate('map')}><Compass size={18}/>{s.map}</button>
        {reviewUnlocked && <button className={view === 'review' ? 'active' : ''} onClick={() => navigate('review')}><BookOpen size={18}/>{s.review}</button>}
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
          <aside className={`station-detail r4-station-detail station-${selected}`} aria-live="polite">
            <div className="r4-station-topline"><span className="r4-stop-label">{locale === 'zh' ? `第 0${selectedIndex + 1} 站` : `STOP 0${selectedIndex + 1}`}</span><span className={`r4-station-status available`}>{statusFor(selected)}</span></div>
            <div className={`r4-station-art art-${selected}`}><Landmark kind={selected} label={labelNames[locale][selectedIndex]}/></div>
            <div className="r4-station-copy"><h2>{labelNames[locale][selectedIndex]}</h2><span className="r4-station-duration"><Clock3 size={15}/>{locale === 'zh' ? `约 ${durations[selectedIndex]} 分钟` : `${durations[selectedIndex]} minutes`}</span><p>{stationTasks[locale][selectedIndex]}</p></div>
            <div className="r4-station-action"><button className="primary full" disabled={booting || !session} onClick={enter}><span>{selectedAttempt?.status === 'completed' ? (locale === 'zh' ? '查看这一站' : 'View this stop') : selectedAttempt && selectedAttempt.status !== 'skipped' ? s.resume : selected === 'nanxiang' ? s.enter : locale === 'zh' ? `走进${shortNames[locale][selectedIndex]}` : 'Step inside'}</span><ArrowRight size={19}/></button></div>
          </aside>
        </div>
        <div className="route-list" aria-label={s.map}>{stationIds.map((id, i) => <button key={id} onClick={() => setSelected(id)} className={selected === id ? 'active' : ''} aria-pressed={selected === id}><span className="route-number">0{i + 1}</span><span><strong>{shortNames[locale][i]}</strong><small>{themes[locale][i]}</small></span>{selected === id ? <Check size={16}/> : <ChevronRight size={16}/>}</button>)}</div>
        <section className="walking-note"><div><span className="overline">A FEW WORDS, A WHOLE NEW WORLD</span><h2>{s.footerTitle}</h2><p>{s.footerText}</p></div><div className="feature-list">{[[MessageCircle, s.featureSpeak, s.featureSpeakText], [BookOpen, s.featureHelp, s.featureHelpText], [Footprints, s.featurePace, s.featurePaceText]].map(([Icon, title, description]) => {const I = Icon as typeof MessageCircle; return <div className="feature" key={title as string}><I size={21} strokeWidth={1.4}/><div><strong>{title as string}</strong><small>{description as string}</small></div></div>;})}</div></section>
      </div>}

      {view === 'nanxiang' && <div className="scene-page r1-scene-page page-shell">
        <div className="scene-topline"><button className="text-button" onClick={()=>navigate('map')}><ChevronLeft size={18}/>{s.back}</button><span className="scene-breadcrumb">YU GARDEN <span>/</span> 03 · NANXIANG</span><button className="text-button" onClick={()=>{stopTeachingAudio();setPanel('skip');setStopSignal(n=>n+1);}} disabled={!attempt || busy || attempt.status === 'completed'}>{s.leave}<ArrowUpRight size={16}/></button></div>
        <div className="scene-heading"><div><span className="eyebrow">{s.conversation}</span><h1>{labelNames[locale][2]}</h1></div></div>
        {legacyContent ? <div className="r1-old-record"><div className="r1-version-note"><p>{locale === 'zh' ? '课程已有新版本。开始新的探索即可使用逐轮交流、沪语注音和试听稿，语言与显示偏好会保留。' : 'A new lesson version is available. Start a new journey for guided turns, Shanghainese readings, and audio drafts. Your language and display preferences will be kept.'}</p><button className="secondary" disabled={busy} onClick={()=>setPanel('newSession')}>{locale === 'zh' ? '开始新的探索' : 'Start a new journey'}<ArrowRight size={17}/></button></div>{attempt && <><p>{locale === 'zh' ? '以下为旧版探索中已保存的订单，记录不会删除或转入新探索。' : 'This order was saved in your previous lesson version. Its record will remain saved separately.'}</p>{orderSummary}</>}</div> : !attempt || attempt.status === 'skipped' ? <div className="empty-scene"><NanxiangScene label={s.sceneLabel}/><button className="primary" disabled={busy || !session} onClick={()=>setPanel('intro')}>{s.start}<ArrowRight size={18}/></button></div> : <>
          {pendingRecovery && !busy && <div className="pending-recovery" role="status"><CircleHelp size={18}/><span>{locale === 'zh' ? '有一条回应尚未结束。可以查询结果，或取消后重新回应。' : 'A reply is pending. Check its result, or cancel it before replying again.'}</span><button className="secondary" onClick={()=>void recoverPending()}>{locale === 'zh' ? '查询结果' : 'Check result'}</button><button className="text-button" onClick={()=>void cancelTurn()}>{s.cancel}</button></div>}
          <div className="r1-conversation-grid">
            <section className="r1-stage-column" aria-label={s.sceneLabel}>
              <div className="r1-scene-stage"><NanxiangScene label={s.sceneLabel} pose={scenePose} quantity={attempt.order.normalized_servings ?? attempt.order.quantity} takeaway={attempt.order.takeaway}/><div className="r1-scene-label"><span>南翔</span><small>NANXIANG</small></div><div className="r1-scene-status" role="status"><span className={`phase-dot phase-${scenePose}`}/>{phaseLabel}</div></div>
              <div className="r1-mission"><MapPin size={18}/><span><small>{s.task}</small><strong>{s.taskShort}</strong></span>{!attempt.practice && <button className="icon-button" onClick={unitHelp} aria-label={s.units}><CircleHelp size={19}/></button>}</div>
              <section className="r1-saved-order" aria-label={s.heard}><button className="r1-order-toggle" aria-expanded={orderExpanded} aria-controls="r1-order-details" onClick={()=>setOrderExpanded(value=>!value)}><span><ShoppingBag size={17}/><strong>{s.heard}</strong><small>{attempt.order.item === 'xiaolongbao' ? s.xlb : s.unknown} · {quantityLabel} · {attempt.order.takeaway === true ? s.go : attempt.order.takeaway === false ? s.here : s.unknown}</small></span><ChevronRight size={18} className={orderExpanded ? 'rotated' : ''}/></button><div id="r1-order-details" hidden={!orderExpanded}>{orderSummary}<span className="saved-note"><Check size={13}/>{s.saved}</span></div></section>
            </section>
            <section className="r1-turn-panel" aria-label={locale === 'zh' ? '当前交流' : 'Current conversation'}>
              <div className="r1-turn-heading"><span className="overline">{s.server}</span><span className="review-label">{s.candidate}</span></div>
              <div className="r1-question" aria-live="polite">{attempt.practice?.step === 'confirm' && attempt.status !== 'completed' && promptEntry.id === 'NX-N09' && <div className="r1-confirm-summary r4-confirm-fallback"><ShoppingBag size={20}/><strong>{orderDescription}</strong></div>}<LearningText entry={promptEntry} locale={locale} romanization={showRomanization}/>{listenButton(promptEntry,'host')}</div>
              <div className="r1-reading-tools"><button className="text-button" aria-pressed={showRomanization} disabled={savingPreferences} onClick={()=>void preferences({show_romanization:!showRomanization})}><span className={`toggle ${showRomanization ? 'on' : ''}`}/>{s.pronunciation}</button>{speedControls()}</div>
              {audioMessage && <p className="audio-notice" role="status">{audioMessage}</p>}
              {attempt.status === 'completed' ? <div className="r1-completed" role="status"><PackageCheck size={32}/><h2>{s.successTitle}</h2><p><strong>{orderDescription}</strong></p><div className="r1-completed-actions r4-completed-actions"><button className="primary" onClick={()=>openReview('nanxiang')}><BookOpen size={18}/><span>{s.review}</span></button><button className="secondary" onClick={()=>navigate('map')}><Compass size={18}/><span>{s.backExplore}</span></button><button className="text-button" disabled={busy} onClick={()=>void begin(true)}><RotateCcw size={18}/><span>{s.again}</span></button></div></div> : attempt.practice ? <>
                <GuidedPractice key={attempt.id} attempt={attempt} locale={locale} romanization={showRomanization} asrEnabled={asrEnabled} servicesReady={!booting} disabled={busy} stopSignal={stopSignal}
                  entries={learningEntries} listenButton={listenButton} onAttempt={replaceAttempt} onBusyChange={setBusy} onDraftChange={setRecordingDraft} onPhaseChange={setRecordingPhase}
                  onBeforeMedia={stopTeachingAudio} onEvent={name=>void event(name)} onAdvanced={next=>{setTransientPose(next.status === 'completed' ? 'packing' : 'acknowledging');scheduleQuestion(next,next.status === 'completed' ? 250 : 550);}}/>
              </> : <>
                {focus === 'confirm' && <div className="r1-confirm-summary r2-confirm-summary"><ShoppingBag size={20}/><strong>{orderDescription}</strong></div>}
                {focus === 'edit' ? <div className="r2-edit-prompt"><p>{s.editPrompt}</p><div className="r1-edit-options"><button className="secondary" disabled={turnBlocked || captureActive} onClick={()=>chooseEdit('quantity')}>{s.quantity}<ArrowRight size={17}/></button><button className="secondary" disabled={turnBlocked || captureActive} onClick={()=>chooseEdit('mode')}>{s.mode}<ArrowRight size={17}/></button></div></div> : <>
                  <div className="input-tabs r1-input-tabs" role="tablist" aria-label={locale === 'zh' ? '回应方式' : 'Reply method'} onKeyDown={event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key) || !canChoose) return;event.preventDefault();const next=event.key === 'Home' ? 'speak' : event.key === 'End' ? 'choose' : channel === 'speak' ? 'choose' : 'speak';selectChannel(next);(event.currentTarget.querySelector(`#tab-${next}`) as HTMLButtonElement)?.focus();}}>{([['speak',Mic,s.speak],['choose',MessageCircle,s.choose]] as const).map(([id,Icon,label])=><button key={id} id={`tab-${id}`} role="tab" aria-controls={`input-${id}`} aria-selected={channel === id} disabled={turnBlocked || captureActive || (id === 'choose' && !canChoose)} tabIndex={channel === id ? 0 : -1} onClick={()=>selectChannel(id)}><Icon size={17}/>{label}</button>)}</div>
                  {speechNotice && <p className="r2-speech-notice" role="status">{speechNotice === 'technical' ? s.speechUnavailable : s.speechRetry}</p>}
                  <div hidden={channel !== 'speak'} role="tabpanel" id="input-speak" aria-labelledby="tab-speak">
                    <div className="r2-practice-picker"><span className="overline">{s.wantToSay}</span><div>{practiceIds.map(id=><button type="button" className={speakTarget === id ? 'selected' : ''} key={id} aria-pressed={speakTarget === id} disabled={turnBlocked || captureActive} onClick={()=>selectPractice(id)}>{entryFor(id).meaning[locale]}{speakTarget === id && <Check size={16}/>}</button>)}</div></div>
                    {selectedPractice ? <><div className="r1-speaking-example"><span className="overline">{s.sayThis}</span><LearningText entry={selectedPractice} locale={locale} romanization={showRomanization}/>{listenButton(selectedPractice)}</div>{channel === 'speak' && <Recorder key={questionKey} locale={locale} enabled={asrEnabled} disabled={turnBlocked} stopSignal={stopSignal} resetSignal={recorderReset} onPhaseChange={setRecordingPhase} onTranscript={(value,requestId)=>{if(questionRef.current !== questionKey || viewRef.current !== 'nanxiang') return;stopTeachingAudio();const source={text:value,requestId};setAsrSource(source);setRecordingDraft(false);void submit(undefined,false,source);}} onDraftChange={setRecordingDraft} onEvent={name=>void event(name)} onFailure={reason=>unlockFallback(reason)} onError={message=>setError(message)}/>}</> : <div className="r2-select-first"><Mic size={23}/><p>{s.selectBeforeSpeak}</p></div>}
                    {asrSource && <div className="r2-heard" role="status"><span>{s.heardSpeech}</span><p lang="zh">{asrSource.text}</p></div>}
                  </div>
                  {canChoose && <div hidden={channel !== 'choose'} role="tabpanel" id="input-choose" aria-labelledby="tab-choose">
                    {focus === 'confirm' ? <div className="r1-confirmation"><div className="r1-confirm-reply"><LearningText entry={entryFor('E05')} locale={locale} romanization={showRomanization} compact/>{listenButton(entryFor('E05'))}</div><button className="primary full" disabled={turnBlocked || captureActive} onClick={()=>void submit({type:'confirm'})}>{s.confirm}<Check size={18}/></button></div> : <><div className="r1-answer-options">{focus === 'item' ? option('NX-ITEM-XLB',{item:'xiaolongbao'}) : focus === 'quantity' ? [1,2,3].map(quantity=>option(`NX-Q${quantity}`,{quantity,unit:'serving'})) : <>{option('NX-MODE-HERE',{takeaway:false})}{option('E09',{takeaway:true})}</>}</div><div className="r1-answer-footer"><small>{hasSelection ? s.draft : s.draftHint}</small><div>{hasSelection && <button className="text-button" disabled={turnBlocked} onClick={()=>setDraft({})}>{s.clear}</button>}<button className="primary" disabled={turnBlocked || captureActive || !hasSelection} onClick={()=>void submit({type:'set_order',...questionDraft})}>{s.submit}<ArrowRight size={17}/></button></div></div></>}
                  </div>}
                </>}
                {focus === 'quantity' && <button className="text-button r1-unit-help" onClick={unitHelp}><CircleHelp size={16}/>{s.units}</button>}
                {focus === 'confirm' && <button className="text-button r2-change-order" disabled={turnBlocked || captureActive} onClick={changeOrder}><PencilLine size={16}/>{s.change}</button>}
                {(editing || editFocus) && <button className="text-button r1-cancel-edit" disabled={turnBlocked || captureActive} onClick={()=>{setEditing(false);setEditFocus(null);setDraft({});setSpeakTarget(null);setRecorderReset(n=>n+1);}}>{locale === 'zh' ? '返回当前核对' : 'Back to the current question'}</button>}
                {busy && <div className="processing-bar" role="status"><span className="spinner"/>{s.saving}<button className="text-button" onClick={()=>void cancelTurn()}>{s.cancel}</button></div>}
                {lastText && <details className="r1-last-reply"><summary>{locale === 'zh' ? '上一条语音回应' : 'Previous spoken reply'}</summary><p>{lastText}</p></details>}
              </>}
            </section>
          </div>
        </>}
      </div>}

      {lessonStation && <StationLesson station={lessonStation} attempt={lessonAttempt} locale={locale} romanization={showRomanization} asrEnabled={asrEnabled} servicesReady={!booting && Boolean(session)} disabled={busy} stopSignal={stopSignal} audioSpeed={audioSpeed} autoVoice={autoVoice}
        onAttempt={replaceAttempt} onStart={restart=>void begin(restart,lessonStation)} onBack={()=>navigate('map')} onSkip={()=>{stopTeachingAudio();setStopSignal(value=>value + 1);setPanel('skip');}} onReview={()=>openReview(lessonStation)}
        onRomanization={()=>void preferences({show_romanization:!showRomanization})} onSpeed={changeAudioSpeed} onBusyChange={setBusy} onDraftChange={setRecordingDraft} onPhaseChange={setRecordingPhase} onEvent={name=>void event(name)}/>}

      {view === 'review' && reviewUnlocked && <div className="review-page page-shell">
        <div className="page-heading"><div><span className="eyebrow">YOUR SHANGHAI, ONE MOMENT AT A TIME</span><h1>{completeCount === 4 ? (locale === 'zh' ? '四站走过，沪语留在身边。' : 'Four stops. A little more Shanghai.') : s.reviewTitle}</h1><p>{locale === 'zh' ? '回顾已完成地点的表达，随时重听或再练一次。' : 'Revisit expressions from the stops you have completed. Listen again or return for another conversation.'}</p></div><span className="review-seal"><Footprints size={36}/></span></div>
        <div className="review-stats"><strong>{completeCount}<small>/ 4 {s.completedCount}</small></strong><strong>{session?.attempts.reduce((n,a)=>n + a.metrics.voice_attempts,0) || 0}<small>{s.voiceTries}</small></strong><strong>{session?.attempts.reduce((n,a)=>n + a.metrics.help_used,0) || 0}<small>{s.helped}</small></strong></div>
        {completeCount === 4 && <div className="bc-route-banner"><CheckCircle2 size={30}/><p>{locale === 'zh' ? '从点菜、挑糖到喝茶，四个地点的交流都完成了。下面可以重听表达，也可以随时再去练习。' : 'You have shared a meal, chosen candy, ordered dumplings, and enjoyed tea. Revisit your expressions or return to any stop.'}</p></div>}
        <div className="bc-route-review">{stationIds.map((id,index)=>{const saved=completedAttemptFor(session?.attempts || [],id);return <article key={id}><Landmark kind={id} label={labelNames[locale][index]}/><h2>{shortNames[locale][index]}</h2><p>{saved ? (locale === 'zh' ? '已完成' : 'Completed') : statusFor(id)}</p><button className="text-button" onClick={()=>{if(saved) openReview(id);else {setSelected(id);navigate('map');}}}>{saved ? s.review : (locale === 'zh' ? '去看看' : 'Explore')}<ArrowRight size={15}/></button></article>;})}</div>
        <div className="bc-review-tabs" aria-label={locale === 'zh' ? '选择回顾地点' : 'Choose a stop to review'}>{stationIds.filter(id=>completedAttemptFor(session?.attempts || [],id)).map(id=><button key={id} aria-pressed={reviewStation === id} onClick={()=>{stopTeachingAudio();setReviewStation(id);}}><BookOpen size={16}/>{shortNames[locale][stationIds.indexOf(id)]}</button>)}</div>
        {completedAttemptFor(session?.attempts || [],reviewStation) && <section className="r2-review-expressions"><div className="r2-review-heading"><div><span className="overline">{shortNames[locale][stationIds.indexOf(reviewStation)]} · REVIEW</span><h2>{reviewStation === 'nanxiang' ? s.supportTitle : locale === 'zh' ? `${shortNames[locale][stationIds.indexOf(reviewStation)]}的表达` : `Your ${shortNames[locale][stationIds.indexOf(reviewStation)]} expressions`}</h2><p>{reviewStation === 'nanxiang' ? s.supportDesc : stationPlanFor(reviewStation).description[locale]}</p></div>{speedControls()}</div><button className="text-button" disabled={savingPreferences} aria-pressed={showRomanization} onClick={()=>void preferences({show_romanization:!showRomanization})}><span className={`toggle ${showRomanization ? 'on' : ''}`}/>{s.pronunciation}</button><div className="r2-review-cards">{(reviewStation === 'nanxiang' ? ['NX-ITEM-XLB','NX-Q1','NX-Q2','NX-Q3','NX-MODE-HERE','E09','E05'].map(entryFor) : stationPlanFor(reviewStation).reviewEntryIds.map(stationEntryFor)).filter((entry): entry is LearningEntry=>Boolean(entry)).map(entry=><article className="phrase-card" key={entry.id}><span className="review-label">{s.candidate}</span><LearningText entry={entry} locale={locale} romanization={showRomanization}/>{listenButton(entry)}</article>)}</div>{audioMessage && <p className="audio-notice" role="status">{audioMessage}</p>}<div className="r2-review-actions"><button className="secondary" onClick={()=>openSavedStation(reviewStation)}><ChevronLeft size={18}/>{locale === 'zh' ? '返回这一站' : 'Back to this stop'}</button></div></section>}
        <button className="primary" onClick={()=>navigate('map')}><Compass size={18}/>{s.continue}</button>
      </div>}

      {view === 'design' && <div className="design-page page-shell"><div className="page-heading"><div><span className="eyebrow">DESIGN SYSTEM · 01</span><h1>{s.designTitle}</h1><p>{s.designText}</p></div></div><div className="design-swatches">{['#214f46','#a04d3b','#d9bd8d','#f4eee3','#292f2a'].map(color => <div key={color}><span style={{background:color}}/>{color}</div>)}</div><div className="design-state-grid"><article><span className="overline">01 · INPUT</span><h2>{s.stateRecording}</h2><div className="sample-recording"><Mic size={24}/><span>00:08 / 00:20</span><AudioLines size={54}/></div><p>{locale === 'zh' ? '主动开始，结束录音后自动识别；查看结果后，点击继续。' : 'Start deliberately. Stopping transcribes your speech; read the result before continuing.'}</p><button className="secondary" onClick={() => setPanel('about')}>{s.about}</button></article><article><span className="overline">02 · WAITING</span><h2>{s.stateProcessing}</h2><div className="processing-sample"><span className="spinner"/>{s.waiting}</div><p>{locale === 'zh' ? '保存前不展示完成，回应草稿仍保留。' : 'Keep the reply draft. Show completion only after saving.'}</p></article><article><span className="overline">03 · RECOVERY</span><h2>{s.stateError}</h2><div className="sample-error"><CircleHelp size={20}/>{s.error}</div><p>{s.permissionError}</p></article><article><span className="overline">04 · CONFIRMATION</span><h2>{s.stateConfirm}</h2><div className="sample-order"><ShoppingBag size={25}/><strong>{s.xlb} · 2 {s.serving} · {s.go}</strong></div><p>{s.confirmText}</p></article><article><span className="overline">05 · SAVED</span><h2>{s.stateSuccess}</h2><div className="completion-stamp"><Check size={24}/>{s.stamp}</div></article><article><span className="overline">06 · LEARNING SUPPORT</span><h2>{s.supportTitle}</h2><p>{s.supportDesc}</p>{reviewUnlocked && <button className="secondary" onClick={()=>navigate('review')}>{s.review}<ArrowRight size={17}/></button>}</article></div></div>}
    </main>
    <footer className="site-footer"><span>沪语漫游 <span className="footer-dot">·</span> A LITTLE SHANGHAI</span><div><button onClick={() => navigate('design')}>{s.design}</button></div></footer>

    {panel && <Dialog title={{settings:s.settings, intro:s.introTitle, units:s.unitTitle, about:s.about, skip:s.skipTitle, leaveRecording:s.leaveRecording, newSession:locale === 'zh' ? '开始新的探索' : 'Start a new journey'}[panel]} closeLabel={s.close} onClose={() => setPanel(null)} className={panel === 'intro' ? 'intro-dialog' : ''}>
      {panel === 'settings' && <><div className="setting-row"><div><h3>{s.language}</h3><p>{s.languageText}</p></div><div className="segmented"><button className={locale === 'zh' ? 'selected' : ''} disabled={savingPreferences} onClick={() => void preferences({locale:'zh'})}>中文</button><button className={locale === 'en' ? 'selected' : ''} disabled={savingPreferences} onClick={() => void preferences({locale:'en'})}>English</button></div></div>{[{key:'show_romanization',label:s.pronunciation,description:s.romanHelp},{key:'reduced_motion',label:s.motion,description:s.motionText}].map(option => <div className="setting-row" key={option.key}><div><h3>{option.label}</h3><p>{option.description}</p></div><button className={`toggle ${session?.[option.key as 'show_romanization' | 'reduced_motion'] ? 'on' : ''}`} role="switch" disabled={savingPreferences} aria-checked={Boolean(session?.[option.key as 'show_romanization' | 'reduced_motion'])} aria-label={option.label} onClick={() => void preferences({[option.key]:!session?.[option.key as 'show_romanization' | 'reduced_motion']})}/></div>)}<div className="setting-row"><div><h3>{locale === 'zh' ? '店员声音' : 'Host audio'}</h3><p>{locale === 'zh' ? '开始交流或点击继续进入下一题后，播放对应的审阅声音。' : 'Play the matching review recording when you start or choose to continue to the next step.'}</p></div><button className={`toggle ${autoVoice ? 'on' : ''}`} role="switch" aria-checked={autoVoice} aria-label={locale === 'zh' ? '店员声音' : 'Host audio'} onClick={()=>{const next=!autoVoice;setAutoVoice(next);try {localStorage.setItem('shanghai-review-autovoice',next ? 'on':'off');} catch {}if(!next) stopTeachingAudio();}}/></div><button className="secondary full" disabled={busy || savingPreferences || !session} onClick={() => setPanel('newSession')}><RotateCcw size={17}/>{locale === 'zh' ? '开始新的探索' : 'Start a new journey'}</button></>}
      {panel === 'newSession' && <><p className="intro-description">{locale === 'zh' ? '将从 0 个地点重新开始，并保留语言和显示偏好。当前探索的记录仍会保存，但不会带入新的探索。' : 'Start again from 0 places while keeping your language and display preferences. Your previous journey remains saved, but its progress will not carry into this one.'}</p><p className="dialog-description">{locale === 'zh' ? '当前未使用的转写、选择和录音会清除。确定开始吗？' : 'Unused transcripts, choices, and recordings will be cleared. Ready to begin?'}</p><div className="dialog-actions"><button className="secondary" disabled={busy} onClick={() => setPanel('settings')}>{s.cancel}</button><button className="primary" disabled={busy || savingPreferences} onClick={() => void startNewSession()}>{locale === 'zh' ? '开始新的探索' : 'Start a new journey'}<ArrowRight size={18}/></button></div></>}
      {panel === 'intro' && <><div className="intro-art"><Landmark kind="nanxiang" label={labelNames[locale][2]}/></div><span className="eyebrow">{s.introduction}</span><p className="intro-description">{s.introText}</p><div className="intro-steps r3-intro-steps">{[s.item,s.quantity,s.mode,locale === 'zh' ? '核对' : 'Confirm'].map((label,index)=><span key={label}>0{index+1} <strong>{label}</strong></span>)}</div><p className="dialog-description">{s.modes}</p><button className="primary full" disabled={busy || !session} onClick={() => void begin()}>{s.start}<ArrowRight size={18}/></button></>}
      {panel === 'units' && <><div className="unit-baskets"><ServingIllustration/><strong>1 {s.serving}</strong></div><p className="intro-description">{s.unitText}</p><button className="primary full" onClick={() => setPanel(null)}>{s.understood}<Check size={18}/></button></>}
      {panel === 'about' && <><span className="preview-badge">{s.preview}</span><p className="intro-description">{s.aboutText}</p><p className="dialog-description">{s.aboutSpeech}</p>{loggingGap && <p className="sample-error">{locale === 'zh' ? '部分帮助记录未能保存，练习统计可能不完整。' : 'Some help events were not saved; practice statistics may be incomplete.'}</p>}<button className="secondary full" onClick={() => navigate('design')}>{s.design}<ArrowRight size={18}/></button></>}
      {panel === 'skip' && <><p className="intro-description">{s.skipText}</p><div className="dialog-actions"><button className="secondary" onClick={() => setPanel(null)}>{s.keep}</button><button className="primary" disabled={busy} onClick={() => void skip()}>{s.skipConfirm}<ArrowRight size={18}/></button></div></>}
      {panel === 'leaveRecording' && <><p className="intro-description">{s.leaveRecordingText}</p><div className="dialog-actions"><button className="secondary" onClick={() => setPanel(null)}>{s.keep}</button><button className="primary" onClick={() => {setRecordingDraft(false); navigate(destination.current, true);}}>{s.leaveAnyway}<ArrowRight size={18}/></button></div></>}
    </Dialog>}
  </div>;
}
