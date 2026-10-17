import { useEffect, useRef, useState } from 'react';
import { ArrowRight, ArrowUpRight, AudioLines, BookOpen, Check, ChevronLeft, ChevronRight, CircleHelp, Clock3, Compass, Footprints, Globe2, Leaf, MapPin, MessageCircle, Mic, Minus, Navigation, PackageCheck, PencilLine, Play, RotateCcw, Settings2, ShoppingBag, Sparkles, Volume2, X } from 'lucide-react';
import Dialog from './components/Dialog';
import Recorder from './components/Recorder';
import { GardenMap, Landmark, NanxiangScene } from './components/SceneArt';
import { api, post, ApiError, type Action, type Attempt, type Locale, type Session, type TurnRequest, type TurnResult } from './lib/api';
import { strings } from './lib/i18n';
import content from '../../content/batch-a.json';

type View = 'map' | 'nanxiang' | 'review' | 'design';
type Panel = 'help' | 'settings' | 'intro' | 'units' | 'about' | 'skip' | 'leaveRecording' | 'newSession' | null;
type StationId = 'restaurant' | 'candy' | 'nanxiang' | 'teahouse';
const stationIds: StationId[] = ['restaurant', 'candy', 'nanxiang', 'teahouse'];
const stationPositions = [{ x: 25, y: 47 }, { x: 69, y: 42 }, { x: 30, y: 85 }, { x: 76, y: 78 }];
const labelNames = { zh: ['上海老饭店', '上海梨膏糖商店', '南翔馒头店', '湖心亭茶楼'], en: ['Shanghai Old Restaurant', 'Shanghai Pear Candy Shop', 'Nanxiang Steamed Bun Restaurant', 'Huxin Pavilion Teahouse'] };
const shortNames = { zh: ['老饭店', '梨膏糖商店', '南翔馒头店', '湖心亭茶楼'], en: ['Old Restaurant', 'Pear Candy Shop', 'Nanxiang', 'Huxin Pavilion'] };
const themes = { zh: ['偏好与推荐', '听辨与挑选', '数量与外带', '赞茶与道谢'], en: ['Preferences & recommendations', 'Listen & choose', 'Quantity & takeaway', 'Tea & a little gratitude'] };
const durations = ['5–6', '5–7', '5–6', '3–4'];
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
  const [channel, setChannel] = useState<'speak' | 'type' | 'choose'>('choose');
  const [draft, setDraft] = useState<{ item?: string; quantity?: number; unit?: string; takeaway?: boolean }>({});
  const [text, setText] = useState('');
  const [asrSource, setAsrSource] = useState<{text:string;requestId:string}|null>(null);
  const [asrEnabled, setAsrEnabled] = useState(false);
  const [lastText, setLastText] = useState('');
  const [showApproximate, setShowApproximate] = useState<string | null>(null);
  const [recordingDraft, setRecordingDraft] = useState(false);
  const [stopSignal, setStopSignal] = useState(0);
  const [editing, setEditing] = useState(false);
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
  const inputRef = useRef<HTMLTextAreaElement>(null);
  sessionRef.current = session;
  const s = strings[locale];
  const attempt = session?.attempts.find(a => a.id === activeAttemptId) || [...(session?.attempts || [])].reverse().find(a => a.station_id === 'nanxiang') || null;
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
    if (recordingDraft && view === 'nanxiang' && next !== view && !force) { destination.current = next; window.history.replaceState(null,'',`#${view}`); setPanel('leaveRecording'); return; }
    generation.current += 1; controller.current?.abort(); if(!sessionResetInFlight.current) setBusy(false); setPanel(null); setError(''); setStopSignal(n => n + 1);
    const pendingId = lastRequest.current?.body.request_id || attempt?.pending_request_id;
    if(pendingId && attempt) { void post<TurnResult>(`/attempts/${attempt.id}/turns/${pendingId}/cancel`, {expected_revision:attempt.revision}).then(result=>replaceAttempt(result.attempt)).catch(()=>setError(s.error)); lastRequest.current=null; }
    viewRef.current = next; window.location.hash = next; setView(next); window.scrollTo({ top: 0, behavior: 'instant' }); requestAnimationFrame(() => document.getElementById('main-content')?.focus({preventScroll:true}));
  }
  navigationHandler.current = navigate;
  async function begin(restart = false) {
    if(sessionResetInFlight.current || busy) return;
    setBusy(true); setError('');
    const ticket = ++generation.current;
    try {
      const next = await post<Attempt>('/attempts', { station_id: 'nanxiang', restart });
      if(ticket !== generation.current) return;
      replaceAttempt(next, true); setActiveAttemptId(next.id); setDraft({}); setText(''); setAsrSource(null); setLastText(''); setEditing(false); setRecordingDraft(false); lastRequest.current = null;
      navigate('nanxiang', true);
    } catch { if(ticket === generation.current) setError(s.error); } finally { if(ticket === generation.current) setBusy(false); }
  }
  async function startNewSession() {
    if(sessionResetInFlight.current || busy || preferencesInFlight.current) return;
    sessionResetInFlight.current = true;
    setBusy(true); setError(''); generation.current += 1; controller.current?.abort(); setStopSignal(n => n + 1);
    try {
      const pendingId = lastRequest.current?.body.request_id || attempt?.pending_request_id;
      if(pendingId && attempt) await post(`/attempts/${attempt.id}/turns/${pendingId}/cancel`, {expected_revision:attempt.revision});
      const next = await post<Session>('/session/new', {});
      lastRequest.current = null; setSession(next); setLocale(next.locale); setActiveAttemptId(null); setDraft({}); setText(''); setAsrSource(null); setLastText(''); setEditing(false); setOrderExpanded(false); setRecordingDraft(false); setLoggingGap(false); setPanel(null);
      viewRef.current = 'map'; window.location.hash = 'map'; setView('map'); window.scrollTo({top:0,behavior:'instant'}); requestAnimationFrame(() => document.getElementById('main-content')?.focus({preventScroll:true}));
    } catch { setPanel(null); setError(s.error); }
    finally {generation.current += 1; sessionResetInFlight.current = false;setBusy(false);}
  }
  function enter() { if(attempt && attempt.status !== 'skipped') navigate('nanxiang'); else setPanel('intro'); }
  function applyTurnResult(result:TurnResult, body?:TurnRequest) {
    replaceAttempt(result.attempt);
    if(result.status === 'applied') {
      if(body?.channel === 'buttons') setDraft(current => Object.entries(current).every(([key,value]) => (body.action as unknown as Record<string,unknown>)?.[key] === value) ? {} : current);
      else if(body?.text) {setLastText(body.text);setText(current => current.trim() === body.text ? '' : current);setAsrSource(current => current?.requestId === body.asr_request_id ? null : current);}
      setEditing(false);lastRequest.current=null;setError('');
    } else if(result.status === 'failed') {if(lastRequest.current) lastRequest.current={...lastRequest.current,body:{...lastRequest.current.body,request_id:crypto.randomUUID()}};setError(s.error);}
    else if(result.status === 'cancelled') {lastRequest.current=null;setError('');}
  }
  async function submit(action?: Action, repeat = false) {
    if (!attempt || busy || sessionResetInFlight.current) return;
    setBusy(true); setError('');
    const ticket = ++generation.current;
    const body: TurnRequest = repeat && lastRequest.current ? lastRequest.current.body : { request_id: crypto.randomUUID(), expected_revision: attempt.revision, channel: action ? 'buttons' : asrSource ? (text.trim() === asrSource.text ? 'voice' : 'voice_edited') : 'text', ...(action ? {action} : {text: text.trim(), ...(asrSource ? {asr_request_id:asrSource.requestId} : {})}), ...(attempt.summary_revision !== null ? { summary_revision: attempt.summary_revision } : {}) };
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
  function help() { setStopSignal(n => n + 1); setPanel('help'); void event('expression_opened', { expression_ids: ['E08', 'E09', 'E05'] }); }
  function unitHelp() { setPanel('units'); void event('unit_explanation_viewed'); }
  const statusFor = (id: string) => session?.completed_station_ids.includes(id) ? s.completed : [...(session?.attempts || [])].reverse().find(a => a.station_id === id)?.status === 'skipped' ? s.skipped : session?.attempts.some(a => a.station_id === id) ? s.inProgress : s.notStarted;
  const unsentChanges = Object.values(draft).some(value => value !== undefined) || Boolean(text.trim()) || recordingDraft;
  const turnBlocked = busy || Boolean(attempt?.pending_request_id);
  const prompt = content.dialogues.find(item => item.id === attempt?.prompt_id)?.meaning[locale] || (locale === 'zh' ? '欢迎，想买什么？' : 'Hello. What would you like?');
  const quantityLabel = attempt?.order.quantity != null ? `${attempt.order.quantity} ${attempt.order.unit === 'piece' ? s.piece : attempt.order.unit === 'basket' ? s.basket : attempt.order.unit === 'serving' ? (locale === 'en' && attempt.order.quantity === 1 ? 'serving' : s.serving) : ''}` : s.unknown;
  const orderSummary = <dl className="order-fields" id="saved-order-fields"><div><dt>{s.item}</dt><dd>{attempt?.order.item === 'xiaolongbao' ? s.xlb : s.unknown}</dd></div><div><dt>{s.quantity}</dt><dd>{quantityLabel}</dd></div><div><dt>{s.mode}</dt><dd>{attempt?.order.takeaway === true ? s.go : attempt?.order.takeaway === false ? s.here : s.unknown}</dd></div></dl>;

  return <div className={`app locale-${locale}`}>
    <a className="skip-link" href="#main-content">{locale === 'zh' ? '跳到主要内容' : 'Skip to content'}</a>
    <header className="site-header">
      <button className="brand" onClick={() => navigate('map')} aria-label={s.brand}><span className="brand-mark"><span>沪</span></span><span><strong>{s.brand}</strong><small>{s.tagline}</small></span></button>
      <nav className="main-nav" aria-label={locale === 'zh' ? '主导航' : 'Main navigation'}>
        <button className={view === 'map' || view === 'nanxiang' ? 'active' : ''} onClick={() => navigate('map')}><Compass size={18}/>{s.map}</button>
        <button onClick={help}><BookOpen size={18}/>{s.phrases}</button>
        <button className={view === 'review' ? 'active' : ''} onClick={() => navigate('review')}><Footprints size={18}/>{s.journey}</button>
      </nav>
      <div className="header-tools"><button className="language-button" disabled={savingPreferences} onClick={() => void preferences({locale: locale === 'zh' ? 'en' : 'zh'})} aria-label={locale === 'zh' ? 'Switch to English' : '切换为中文'}><Globe2 size={17}/><span>{locale === 'zh' ? 'EN' : '中文'}</span></button><span className="tool-divider"/><button className="icon-button" onClick={() => {setPanel('settings'); setStopSignal(n => n + 1);}} aria-label={s.settings}><Settings2 size={20}/></button></div>
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

      {view === 'nanxiang' && <div className="scene-page page-shell">
        <div className="scene-topline"><button className="text-button" onClick={() => navigate('map')}><ChevronLeft size={18}/>{s.back}</button><span className="scene-breadcrumb">YU GARDEN <span>/</span> 03 · NANXIANG</span><button className="text-button" onClick={() => {setPanel('skip'); setStopSignal(n => n + 1);}} disabled={!attempt || busy || attempt.status === 'completed'}>{s.leave}<ArrowUpRight size={16}/></button></div>
        <div className="scene-heading"><div><span className="eyebrow">{s.conversation}</span><h1>{labelNames[locale][2]}</h1></div><button className="help-button" onClick={help}><BookOpen size={19}/>{s.how}</button></div>
        {!attempt || attempt.status === 'skipped' ? <div className="empty-scene"><NanxiangScene label={s.sceneLabel}/><button className="primary" disabled={busy || !session} onClick={() => setPanel('intro')}>{s.start}<ArrowRight size={18}/></button></div> : <>
        {attempt.pending_request_id && !busy && <div className="pending-recovery" role="status"><CircleHelp size={18}/><span>{locale === 'zh' ? '有一条回应尚未结束。可以查询结果，或取消后重新回应。' : 'A reply is still pending. Check its result, or cancel it before replying again.'}</span><button className="secondary" onClick={() => void recoverPending()}>{locale === 'zh' ? '查询结果' : 'Check result'}</button><button className="text-button" onClick={() => void cancelTurn()}>{s.cancel}</button></div>}<div className="scene-workspace">
          <section className="scene-stage"><div className="mission-strip"><span className="mission-icon"><MapPin size={17}/></span><div><small>{s.task}</small><strong>{s.taskShort}</strong></div></div><NanxiangScene label={s.sceneLabel} pose={attempt.status === 'completed' ? 'packed' : busy ? 'listening' : attempt.status === 'confirming' ? 'checking' : 'welcome'}/><div className="scene-sign"><span>南翔</span><small>NANXIANG</small></div><button className="object-hotspot steamer-hotspot" onClick={unitHelp}><CircleHelp size={16}/>{locale === 'zh' ? '认识一份小笼包' : 'What is one serving?'}</button><button className="object-hotspot bag-hotspot" onClick={help}><ShoppingBag size={15}/>{locale === 'zh' ? '怎么说“外带”' : 'How to say “to go”'}</button></section>
          <aside className={`order-card ${orderExpanded ? 'order-expanded' : ''} ${attempt.status === 'confirming' ? 'has-confirmation' : ''} ${attempt.status === 'completed' ? 'order-completed' : ''}`}>
            <div className="order-card-top"><span className="overline">{attempt.status === 'completed' ? 'A LITTLE MOMENT, COMPLETED' : 'YOUR LITTLE ORDER'}</span>{attempt.status === 'completed' ? <PackageCheck size={22}/> : <ShoppingBag size={21}/>}</div><h2>{attempt.status === 'completed' ? s.orderDone : s.heard}</h2><button className="order-summary-toggle" aria-controls="saved-order-fields" aria-expanded={orderExpanded} onClick={() => setOrderExpanded(open=>!open)}><span>{attempt.order.item === 'xiaolongbao' ? s.xlb : s.unknown} · {quantityLabel} · {attempt.order.takeaway === true ? s.go : attempt.order.takeaway === false ? s.here : s.unknown}</span><ChevronRight size={17} className={orderExpanded ? 'rotated' : ''}/></button>{orderSummary}
            <button className="unit-link" onClick={unitHelp}><CircleHelp size={15}/>{s.units}</button>
            {attempt.status === 'confirming' && !editing && !unsentChanges && <div className="confirmation"><span className="confirmation-title"><Check size={16}/>{s.confirmTitle}</span><p>{s.confirmText}</p><button className="primary full" disabled={turnBlocked} onClick={() => void submit({type:'confirm'})}>{s.confirm}<Check size={17}/></button><button className="text-button centered" disabled={busy} onClick={() => {setEditing(true); setDraft({item:attempt.order.item || undefined, quantity:attempt.order.quantity ?? undefined, unit:attempt.order.unit || undefined, takeaway:attempt.order.takeaway ?? undefined}); setChannel('choose');}}><PencilLine size={15}/>{s.change}</button></div>}
            {attempt.status === 'confirming' && (editing || unsentChanges) && <p className="draft-warning">{locale === 'zh' ? '修改还没有提交。请先提交回应，更新核对摘要。' : 'Your changes have not been sent. Send your reply to update the order summary.'}</p>}{attempt.status !== 'confirming' && attempt.status !== 'completed' && <div className="order-awaiting"><span className="small-dot"/>{locale === 'zh' ? '提交后，这里会更新你的订单。' : 'Your order updates when you send a reply.'}</div>}
            {attempt.status === 'completed' && <div className="completion-stamp"><Check size={24}/><span>{s.stamp}</span></div>}
            <span className="saved-note"><Check size={13}/>{s.saved}</span>
          </aside>
        </div>
        {attempt.status === 'completed' ? <section className="success-section" role="status"><div className="success-seal"><PackageCheck size={32}/></div><span className="eyebrow">A CONVERSATION TO REMEMBER</span><h2>{s.successTitle}</h2><p>{s.successText}</p><div className="success-buttons"><button className="primary" onClick={() => navigate('map')}>{s.backExplore}<ArrowRight size={18}/></button><button className="secondary" disabled={busy} onClick={() => void begin(true)}><RotateCcw size={17}/>{s.again}</button><button className="text-button" onClick={help}>{s.supportTitle}<BookOpen size={17}/></button></div><small>{s.successFoot}</small></section> : <section className="conversation-panel">
          <div className="dialogue"><div className="host-avatar" aria-hidden="true">南</div><div><div className="dialogue-heading"><strong>{s.server}</strong><span>{s.semantic}</span></div><p aria-live="polite">{prompt}</p>{lastText && <details className="previous-reply"><summary>{s.sourceText}</summary><p>{lastText}</p></details>}</div><button className="icon-button disabled-audio" disabled aria-label={s.audioPending} title={s.audioPending}><Volume2 size={21}/></button></div>
          <div className="reply-layout"><div className="reply-main"><div className="input-tabs" onKeyDown={event => { if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return; event.preventDefault(); const ids=['speak','type','choose'] as const; const i=ids.indexOf(channel); const next=event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (i + (event.key === 'ArrowRight' ? 1 : 2))%3; setChannel(ids[next]); if(ids[next] !== 'speak') setStopSignal(n=>n+1); (event.currentTarget.querySelectorAll('button')[next] as HTMLButtonElement)?.focus(); }} role="tablist" aria-label={locale === 'zh' ? '回应方式' : 'Reply method'}>{([['speak', Mic, s.speak], ['type', PencilLine, s.type], ['choose', MessageCircle, s.choose]] as const).map(([id, Icon, label]) => <button key={id} role="tab" id={`tab-${id}`} aria-controls={`input-${id}`} aria-selected={channel === id} tabIndex={channel === id ? 0 : -1} onClick={() => {setChannel(id); if(id !== 'speak') setStopSignal(n => n + 1); void event('input_channel_changed', {channel:id});}}><Icon size={17}/>{label}</button>)}</div>
            <div hidden={channel !== 'speak'} role="tabpanel" id="input-speak" aria-labelledby="tab-speak"><Recorder locale={locale} enabled={asrEnabled} stopSignal={stopSignal} onTranscript={(value, requestId) => {setText(value); setAsrSource({text:value,requestId}); setChannel('type'); setRecordingDraft(false);}} onDraftChange={setRecordingDraft} onEvent={name => { void event(name); }} onError={message => setError(message)}/></div>
            <div hidden={channel !== 'type'} role="tabpanel" id="input-type" aria-labelledby="tab-type" className="text-response"><label className="sr-only" htmlFor="reply-text">{s.type}</label><textarea id="reply-text" ref={inputRef} maxLength={1000} value={text} onChange={e => setText(e.target.value)} placeholder={s.textPlaceholder} disabled={turnBlocked}/><div className="input-footer"><small>{s.textHelp}</small><button className="primary" disabled={turnBlocked || !text.trim()} onClick={() => void submit()}>{s.submit}<ArrowRight size={17}/></button></div>{session?.services.text === 'development_parser' && <p className="development-note">{s.parserNote}</p>}{asrSource && <details className="previous-reply"><summary>{locale === 'zh' ? '原始语音转写（编辑后单独保存）' : 'Original transcript (edits are saved separately)'}</summary><p>{asrSource.text}</p></details>}</div>
            <div hidden={channel !== 'choose'} role="tabpanel" id="input-choose" aria-labelledby="tab-choose" className="choice-response"><div className="choice-groups"><fieldset><legend>{s.chooseItem}</legend><button className={`choice-chip ${draft.item ? 'selected' : ''}`} aria-pressed={Boolean(draft.item)} disabled={turnBlocked} onClick={() => setDraft(d => ({...d, item: d.item ? undefined : 'xiaolongbao'}))}>{s.xlb}{draft.item && <Check size={14}/>}</button></fieldset><fieldset><legend>{s.chooseQuantity}</legend><div>{[1,2,3].map(n => <button key={n} className={`choice-chip ${draft.quantity === n ? 'selected' : ''}`} aria-pressed={draft.quantity === n} disabled={turnBlocked} onClick={() => setDraft(d => ({...d, quantity: n, unit: 'serving'}))}>{n} {locale === 'en' && n === 1 ? 'serving' : s.serving}{draft.quantity === n && <Check size={14}/>}</button>)}</div></fieldset><fieldset><legend>{s.chooseMode}</legend><div>{[false,true].map(value => <button key={String(value)} className={`choice-chip ${draft.takeaway === value ? 'selected' : ''}`} aria-pressed={draft.takeaway === value} disabled={turnBlocked} onClick={() => setDraft(d => ({...d, takeaway:value}))}>{value ? s.go : s.here}{draft.takeaway === value && <Check size={14}/>}</button>)}</div></fieldset></div><div className="input-footer"><small>{Object.values(draft).some(v => v !== undefined) ? s.draft : s.draftHint}</small><div className="inline-actions">{Object.values(draft).some(v => v !== undefined) && <button className="text-button" onClick={() => {setDraft({}); setEditing(false);}} disabled={turnBlocked}>{s.clear}</button>}<button className="primary" disabled={turnBlocked || !Object.values(draft).some(v => v !== undefined)} onClick={() => void submit({type:'set_order', ...draft})}>{s.submit}<ArrowRight size={17}/></button></div></div></div>
          </div><div className="reply-support"><span className="book-illustration"><BookOpen size={34} strokeWidth={1.2}/><Sparkles size={16}/></span><strong>{locale === 'zh' ? '一时不知道怎么说？' : 'Looking for the words?'}</strong><p>{locale === 'zh' ? '翻翻表达卡，把想说的话带回来。' : 'Take a peek at your phrase book, then make it your own.'}</p><button className="text-button" onClick={help}>{s.how}<ArrowUpRight size={16}/></button></div></div>
          {busy && <div className="processing-bar" role="status"><span className="spinner"/>{s.saving}<button className="text-button" onClick={() => void cancelTurn()}>{s.cancel}</button></div>}
        </section>}
        </>}
      </div>}

      {view === 'review' && <div className="review-page page-shell"><div className="page-heading"><div><span className="eyebrow">YOUR SHANGHAI, ONE MOMENT AT A TIME</span><h1>{s.reviewTitle}</h1><p>{s.reviewText}</p></div><span className="review-seal"><Footprints size={36}/></span></div><div className="review-stats"><strong>{completeCount}<small>/ 4 {s.completedCount}</small></strong><strong>{session?.attempts.reduce((n,a) => n + a.metrics.voice_attempts, 0) || 0}<small>{s.voiceTries}</small></strong><strong>{session?.attempts.reduce((n,a) => n + a.metrics.help_used, 0) || 0}<small>{s.helped}</small></strong></div><div className="review-grid">{stationIds.map((id,i) => <article className="review-stop" key={id}><div className="review-art"><Landmark kind={id} label={labelNames[locale][i]}/></div><span className="overline">0{i + 1} · {statusFor(id)}</span><h2>{labelNames[locale][i]}</h2><p>{themes[locale][i]}</p>{id === 'nanxiang' ? <button className="secondary" onClick={enter}>{attempt?.status === 'completed' ? s.reviewOrder : s.enter}<ArrowUpRight size={16}/></button> : <span className="in-making-text">{s.coming}</span>}</article>)}</div><p className="review-disclaimer">{s.noMastery}</p><button className="primary" onClick={() => navigate('map')}>{s.continue}<ArrowRight size={18}/></button></div>}

      {view === 'design' && <div className="design-page page-shell"><div className="page-heading"><div><span className="eyebrow">DESIGN SYSTEM · 01</span><h1>{s.designTitle}</h1><p>{s.designText}</p></div></div><div className="design-swatches">{['#214f46','#a04d3b','#d9bd8d','#f4eee3','#292f2a'].map(color => <div key={color}><span style={{background:color}}/>{color}</div>)}</div><div className="design-state-grid"><article><span className="overline">01 · INPUT</span><h2>{s.stateRecording}</h2><div className="sample-recording"><Mic size={24}/><span>00:08 / 00:20</span><AudioLines size={54}/></div><p>{locale === 'zh' ? '主动开始，停止后先回听。' : 'Start deliberately. Listen back before sending.'}</p><button className="secondary" onClick={() => setPanel('about')}>{s.about}</button></article><article><span className="overline">02 · WAITING</span><h2>{s.stateProcessing}</h2><div className="processing-sample"><span className="spinner"/>{s.waiting}</div><p>{locale === 'zh' ? '保存前不展示完成，不丢弃输入草稿。' : 'Keep the reply draft. Show completion only after saving.'}</p></article><article><span className="overline">03 · RECOVERY</span><h2>{s.stateError}</h2><div className="sample-error"><CircleHelp size={20}/>{s.error}</div><p>{s.permissionError}</p></article><article><span className="overline">04 · CONFIRMATION</span><h2>{s.stateConfirm}</h2><div className="sample-order"><ShoppingBag size={25}/><strong>{s.xlb} · 2 {s.serving} · {s.go}</strong></div><p>{s.confirmText}</p></article><article><span className="overline">05 · SAVED</span><h2>{s.stateSuccess}</h2><div className="completion-stamp"><Check size={24}/>{s.stamp}</div><p>{s.successFoot}</p></article><article><span className="overline">06 · LEARNING SUPPORT</span><h2>{s.supportTitle}</h2><p>{s.supportDesc}</p><button className="secondary" onClick={help}>{s.how}<ArrowRight size={17}/></button></article></div></div>}
    </main>
    <footer className="site-footer"><span>沪语漫游 <span className="footer-dot">·</span> A LITTLE SHANGHAI</span><div><button onClick={() => setPanel('about')}>{s.about}</button><span>/</span><button onClick={() => navigate('design')}>{s.design}</button></div></footer>

    {panel && <Dialog title={{help:s.supportTitle, settings:s.settings, intro:s.introTitle, units:s.unitTitle, about:s.about, skip:s.skipTitle, leaveRecording:s.leaveRecording, newSession:locale === 'zh' ? '开始新的探索' : 'Start a new journey'}[panel]} closeLabel={s.close} onClose={() => setPanel(null)} className={panel === 'help' ? 'help-dialog' : panel === 'intro' ? 'intro-dialog' : ''}>
      {panel === 'help' && <><p className="dialog-description">{s.supportDesc}</p><button className="roman-toggle" disabled={savingPreferences} aria-pressed={session?.show_romanization ?? true} onClick={() => void preferences({show_romanization:!session?.show_romanization})}><span className={`toggle ${session?.show_romanization ?? true ? 'on' : ''}`}/>{s.pronunciation}</button><div className="phrase-cards">{content.expressions.map(expression => <article className="phrase-card" key={expression.id}><div className="phrase-card-top"><span className="overline">{expression.id}</span><span className="review-label">{s.candidate}</span></div><div className="phrase-segments" lang="zh">{expression.segments.map(segment => <span key={segment.id} className="phrase-segment">{(session?.show_romanization ?? true) && <small>{s.pronunciationPending}</small>}<strong>{segment.hanzi}</strong></span>)}</div><p className="phrase-meaning">{expression.meaning[locale]}</p><div className="audio-buttons"><button disabled><Play size={15}/>{s.normal}</button><button disabled><Volume2 size={15}/>{s.slow}</button><small>{s.audioPending}</small></div>{locale === 'zh' && <div className="approximation"><button onClick={() => {setShowApproximate(showApproximate === expression.id ? null : expression.id); void event('pronunciation_support_changed', {expression_id:expression.id,kind:'approximation'});}} aria-expanded={showApproximate === expression.id}>{s.approximate}<ChevronRight className={showApproximate === expression.id ? 'rotated' : ''} size={16}/></button>{showApproximate === expression.id && <p><strong>{s.approximateLabel}</strong><br/>{s.approximatePending}</p>}</div>}<button className="text-button phrase-use" onClick={() => {setText(expression.meaning[locale]); setAsrSource(null); setChannel('type'); setPanel(null); void event('expression_inserted', {expression_id:expression.id}); if(view !== 'nanxiang') { if(attempt && attempt.status !== 'completed' && attempt.status !== 'skipped') navigate('nanxiang'); else setPanel('intro'); } setTimeout(() => inputRef.current?.focus(), 60);}}>{s.use}<ArrowUpRight size={16}/></button></article>)}</div><p className="dialog-footnote">{locale === 'zh' ? '当前是内容审核稿。示范、注音和近似读音通过审核后开放；填入不会自动提交。' : 'This is a content review draft. Audio and reading support become available after review. Using a phrase does not send a reply.'}</p></>}
      {panel === 'settings' && <><div className="setting-row"><div><h3>{s.language}</h3><p>{s.languageText}</p></div><div className="segmented"><button className={locale === 'zh' ? 'selected' : ''} disabled={savingPreferences} onClick={() => void preferences({locale:'zh'})}>中文</button><button className={locale === 'en' ? 'selected' : ''} disabled={savingPreferences} onClick={() => void preferences({locale:'en'})}>English</button></div></div>{[{key:'show_romanization',label:s.pronunciation,description:s.romanHelp},{key:'reduced_motion',label:s.motion,description:s.motionText}].map(option => <div className="setting-row" key={option.key}><div><h3>{option.label}</h3><p>{option.description}</p></div><button className={`toggle ${session?.[option.key as 'show_romanization' | 'reduced_motion'] ? 'on' : ''}`} role="switch" disabled={savingPreferences} aria-checked={Boolean(session?.[option.key as 'show_romanization' | 'reduced_motion'])} aria-label={option.label} onClick={() => void preferences({[option.key]:!session?.[option.key as 'show_romanization' | 'reduced_motion']})}/></div>)}<p className="dialog-footnote">{s.aboutSpeech}</p><button className="secondary full" disabled={busy || savingPreferences || !session} onClick={() => setPanel('newSession')}><RotateCcw size={17}/>{locale === 'zh' ? '开始新的探索' : 'Start a new journey'}</button></>}
      {panel === 'newSession' && <><p className="intro-description">{locale === 'zh' ? '将从 0 个地点重新开始，并保留语言和显示偏好。当前探索的记录仍会保存，但不会带入新的探索。' : 'Start again from 0 places while keeping your language and display preferences. Your previous journey remains saved, but its progress will not carry into this one.'}</p><p className="dialog-description">{locale === 'zh' ? '当前未发送的文字、选择和录音会清除。确定开始吗？' : 'Unsent text, choices, and recordings will be cleared. Ready to begin?'}</p><div className="dialog-actions"><button className="secondary" disabled={busy} onClick={() => setPanel('settings')}>{s.cancel}</button><button className="primary" disabled={busy || savingPreferences} onClick={() => void startNewSession()}>{locale === 'zh' ? '开始新的探索' : 'Start a new journey'}<ArrowRight size={18}/></button></div></>}
      {panel === 'intro' && <><div className="intro-art"><Landmark kind="nanxiang" label={labelNames[locale][2]}/></div><span className="eyebrow">{s.introduction}</span><p className="intro-description">{s.introText}</p><div className="intro-steps"><span>01 <strong>{locale === 'zh' ? '说数量' : 'Say how many'}</strong></span><ChevronRight size={16}/><span>02 <strong>{s.go}</strong></span><ChevronRight size={16}/><span>03 <strong>{locale === 'zh' ? '核对' : 'Confirm'}</strong></span></div><p className="dialog-description">{s.modes}</p><button className="primary full" disabled={busy || !session} onClick={() => void begin()}>{s.start}<ArrowRight size={18}/></button></>}
      {panel === 'units' && <><div className="unit-baskets"><ServingIllustration/><span>+</span><ServingIllustration/><strong>2 {s.serving}</strong></div><p className="intro-description">{s.unitText}</p><button className="primary full" onClick={() => setPanel(null)}>{s.understood}<Check size={18}/></button></>}
      {panel === 'about' && <><span className="preview-badge">{s.preview}</span><p className="intro-description">{s.aboutText}</p><p className="dialog-description">{s.aboutSpeech}</p>{loggingGap && <p className="sample-error">{locale === 'zh' ? '部分帮助记录未能保存，练习统计可能不完整。' : 'Some help events were not saved; practice statistics may be incomplete.'}</p>}<button className="secondary full" onClick={() => navigate('design')}>{s.design}<ArrowRight size={18}/></button></>}
      {panel === 'skip' && <><p className="intro-description">{s.skipText}</p><div className="dialog-actions"><button className="secondary" onClick={() => setPanel(null)}>{s.keep}</button><button className="primary" disabled={busy} onClick={() => void skip()}>{s.skipConfirm}<ArrowRight size={18}/></button></div></>}
      {panel === 'leaveRecording' && <><p className="intro-description">{s.leaveRecordingText}</p><div className="dialog-actions"><button className="secondary" onClick={() => setPanel(null)}>{s.keep}</button><button className="primary" onClick={() => {setRecordingDraft(false); navigate(destination.current, true);}}>{s.leaveAnyway}<ArrowRight size={18}/></button></div></>}
    </Dialog>}
  </div>;
}
