import { authFetch, assertCurrentAuthResponse } from '../lib/authSession';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Mic, RotateCcw, Square, X } from 'lucide-react';
import { chooseRecordingMimeType, MAX_RECORDING_SECONDS, recordingToWav, stopAllAudio } from '../lib/audio';

type Locale = 'zh' | 'en';
type RecordingStatus = 'idle' | 'requesting' | 'recording' | 'stopping' | 'ready' | 'submitting';
export type RecorderPhase = 'idle' | 'recording' | 'processing' | 'playback';

interface RecorderProps {
  locale: Locale;
  enabled: boolean;
  disabled?: boolean;
  onTranscript: (text: string, requestId: string) => void;
  onDraftChange?: (hasDraft: boolean) => void;
  onPhaseChange?: (phase: RecorderPhase) => void;
  onEvent?: (name: string) => void;
  onError?: (message: string) => void;
  onFailure?: (reason: 'recognition' | 'technical', detail?: { message?: string; requestId?: string }) => void;
  stopSignal?: number;
  resetSignal?: number;
}

interface RecordingSession {
  recorder: MediaRecorder;
  stream: MediaStream;
  chunks: Blob[];
  discard: boolean;
  failed: boolean;
  autoSubmit: boolean;
  startedAt: number;
  interval?: ReturnType<typeof setInterval>;
  timeout?: ReturnType<typeof setTimeout>;
}

const copy = {
  zh: {
    label: '说一句上海话', start: '点击说话', requesting: '等待麦克风权限…',
    recording: '正在录音', stopping: '正在准备识别…', stop: '停止录音', cancel: '取消',
    ready: '可以回听本次录音。', retry: '重新录制', discard: '删除录音',
    submitting: '正在识别，可以取消…', cancelRequest: '取消识别',
    playback: '回听我的录音',
    unavailable: '语音识别待连接，仍可本地回听或选择回应。',
    unsupported: '此浏览器无法录音。请使用支持录音的浏览器，或选择回应。',
    permission: '麦克风权限未开启。可在浏览器中允许麦克风，也可以选择回应。',
    noDevice: '没有找到可用的麦克风。请连接麦克风，或选择回应。',
    busyDevice: '麦克风暂时无法使用，可能正被其他应用占用。请重试或选择回应。',
    recordingError: '录音未能完成，请重新录制或选择回应。',
    empty: '没有收到有效录音，请重新录制。',
    conversion: '此录音暂时无法转换为可识别的格式。仍可本地回听，请重新录制或选择回应。',
    session: '体验会话已过期，请刷新页面后重试；刷新会清除本地录音。',
    recognition: '识别暂时不可用。录音已保留，可以重试或选择回应。',
    noText: '未识别到清楚的文字。录音已保留，请回听后重试，或选择回应。',
    timeout: '识别等待超时。录音已保留，请重试或选择回应。',
  },
  en: {
    label: 'Try saying it in Shanghainese', start: 'Tap to speak', requesting: 'Waiting for microphone permission…',
    recording: 'Recording', stopping: 'Preparing transcription…', stop: 'Stop recording', cancel: 'Cancel',
    ready: 'You can listen back to your recording.', retry: 'Record again', discard: 'Delete recording',
    submitting: 'Transcribing… You can cancel.', cancelRequest: 'Cancel transcription',
    playback: 'Play my recording',
    unavailable: 'Speech recognition is not connected yet. You can still record, listen back, or choose a response.',
    unsupported: 'This browser cannot record audio. Use a supported browser or choose a response.',
    permission: 'Microphone permission is off. Allow it in your browser or choose a response.',
    noDevice: 'No microphone was found. Connect one or choose a response.',
    busyDevice: 'The microphone is unavailable or in use by another app. Try again or choose a response.',
    recordingError: 'Recording could not finish. Try recording again or choose a response.',
    empty: 'No usable audio was recorded. Please record again.',
    conversion: 'This recording could not be converted for recognition. You can still listen back, record again, or choose a response.',
    session: 'Your session expired. Refresh the page to retry; this will clear your local recording.',
    recognition: 'Recognition is unavailable. Your recording is still here. Retry or choose a response.',
    noText: 'No clear words were recognized. Your recording is still here. Listen back and retry, or choose a response.',
    timeout: 'Recognition timed out. Your recording is still here. Retry or choose a response.',
  },
};

function closeSession(session: RecordingSession): void {
  clearInterval(session.interval);
  clearTimeout(session.timeout);
  session.stream.getTracks().forEach((track) => track.stop());
}

export default function Recorder({ locale, enabled, disabled = false, onTranscript, onDraftChange, onPhaseChange, onEvent, onError, onFailure, stopSignal, resetSignal }: RecorderProps) {
  const [status, setStatus] = useState<RecordingStatus>('idle');
  const [seconds, setSeconds] = useState(0);
  const [clipUrl, setClipUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef<RecordingSession | null>(null);
  const clipRef = useRef<Blob | null>(null);
  const urlRef = useRef<string | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const requestIdRef = useRef<string | null>(null);
  const generationRef = useRef(0);
  const mountedRef = useRef(true);
  const draftRef = useRef(false);
  const phaseRef = useRef<RecorderPhase>('idle');
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const attachAudio = useCallback((element: HTMLAudioElement | null) => {
    // DOM refs detach before passive effect cleanup; stop the old element here.
    if (audioRef.current && audioRef.current !== element) audioRef.current.pause();
    audioRef.current = element;
  }, []);
  const resetRef = useRef(resetSignal);
  const statusRef = useRef<RecordingStatus>('idle');
  const latest = useRef({ locale, enabled, disabled, stopSignal, resetSignal, onTranscript, onDraftChange, onPhaseChange, onEvent, onError, onFailure });
  latest.current = { locale, enabled, disabled, stopSignal, resetSignal, onTranscript, onDraftChange, onPhaseChange, onEvent, onError, onFailure };
  const t = copy[locale];

  function syncPhase() {
    if (!mountedRef.current) return;
    const current = statusRef.current;
    const audio = audioRef.current;
    const next: RecorderPhase = current === 'recording' ? 'recording'
      : current === 'stopping' || current === 'submitting' ? 'processing'
        : current === 'ready' && !latest.current.disabled && audio && !audio.paused && !audio.ended && !audio.error ? 'playback' : 'idle';
    if (phaseRef.current === next) return;
    phaseRef.current = next;
    latest.current.onPhaseChange?.(next);
  }

  function changeStatus(next: RecordingStatus) {
    statusRef.current = next;
    if (mountedRef.current) setStatus(next);
    syncPhase();
  }

  function isCurrentOperation(generation: number, controls: Pick<RecorderProps, 'locale' | 'stopSignal' | 'resetSignal'>) {
    return mountedRef.current && generation === generationRef.current && !latest.current.disabled
      && controls.locale === latest.current.locale && controls.stopSignal === latest.current.stopSignal
      && controls.resetSignal === latest.current.resetSignal;
  }

  function report(message: string, reason: 'recognition' | 'technical', requestId?: string) {
    if (!mountedRef.current) return;
    setError(message);
    latest.current.onError?.(message);
    latest.current.onFailure?.(reason, { message, ...(requestId ? { requestId } : {}) });
  }

  function notifyDraft(hasDraft: boolean) {
    if (!mountedRef.current || draftRef.current === hasDraft) return;
    draftRef.current = hasDraft;
    latest.current.onDraftChange?.(hasDraft);
  }

  function replaceClip(blob: Blob | null) {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    clipRef.current = blob;
    requestIdRef.current = null;
    urlRef.current = blob ? URL.createObjectURL(blob) : null;
    if (mountedRef.current) {
      setClipUrl(urlRef.current);
      notifyDraft(Boolean(blob));
    }
  }

  function abortPending() {
    generationRef.current += 1;
    requestRef.current?.abort();
    requestRef.current = null;
  }

  function stopCapture(autoSubmit = true) {
    const session = sessionRef.current;
    if (!session) return;
    session.autoSubmit = autoSubmit;
    clearInterval(session.interval);
    clearTimeout(session.timeout);
    changeStatus('stopping');
    if (session.recorder.state !== 'inactive') session.recorder.stop();
    // Do not wait for the asynchronous stop event before releasing the microphone.
    session.stream.getTracks().forEach((track) => track.stop());
  }

  function stopAndKeep() {
    abortPending();
    stopAllAudio();
    if (sessionRef.current) stopCapture(false);
    else changeStatus(clipRef.current ? 'ready' : 'idle');
  }

  function resetRecording() {
    const hadDraft = draftRef.current;
    const wasSubmitting = statusRef.current === 'submitting';
    abortPending();
    audioRef.current?.pause();
    const session = sessionRef.current;
    sessionRef.current = null;
    if (session) {
      session.discard = true;
      if (session.recorder.state !== 'inactive') session.recorder.stop();
      closeSession(session);
    }
    replaceClip(null);
    setSeconds(0);
    setError(null);
    changeStatus('idle');
    if (wasSubmitting) latest.current.onEvent?.('asr_cancelled');
    if (hadDraft) latest.current.onEvent?.('recording_cancelled');
  }

  useEffect(() => {
    mountedRef.current = true;
    latest.current.onDraftChange?.(draftRef.current);
    latest.current.onPhaseChange?.(phaseRef.current);
    const onVisibility = () => {
      if (document.hidden) stopAndKeep();
    };
    const onPageHide = () => stopAndKeep();
    const onPlay = (event: Event) => {
      if (!(event.target instanceof HTMLMediaElement)) return;
      if (['requesting', 'recording', 'stopping', 'submitting'].includes(statusRef.current)
        || (event.target === audioRef.current && latest.current.disabled)) event.target.pause();
      else stopAllAudio(event.target);
    };
    document.addEventListener('visibilitychange', onVisibility);
    document.addEventListener('play', onPlay, true);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      mountedRef.current = false;
      abortPending();
      audioRef.current?.pause();
      const session = sessionRef.current;
      if (session) {
        session.discard = true;
        if (session.recorder.state !== 'inactive') session.recorder.stop();
        closeSession(session);
        sessionRef.current = null;
      }
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener('play', onPlay, true);
      window.removeEventListener('pagehide', onPageHide);
      if (phaseRef.current !== 'idle') {
        phaseRef.current = 'idle';
        latest.current.onPhaseChange?.('idle');
      }
    };
  }, []);

  useEffect(() => {
    stopAndKeep();
    setError(null);
  }, [locale, stopSignal]);
  useEffect(() => {
    if (!enabled && statusRef.current === 'submitting') stopAndKeep();
    if (!enabled) latest.current.onFailure?.('technical', { message: copy[latest.current.locale].unavailable });
  }, [enabled, resetSignal]);
  useEffect(() => {
    if (disabled) stopAndKeep();
  }, [disabled]);
  useEffect(() => {
    if (resetRef.current === resetSignal) return;
    resetRef.current = resetSignal;
    resetRecording();
  }, [resetSignal]);

  async function startRecording() {
    if (latest.current.disabled || ['recording', 'stopping', 'requesting', 'submitting'].includes(statusRef.current)) return;
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      report(t.unsupported, 'technical');
      return;
    }
    abortPending();
    const generation = generationRef.current;
    const controls = latest.current;
    stopAllAudio();
    changeStatus('requesting');
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      if (!isCurrentOperation(generation, controls)) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const mimeType = chooseRecordingMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const session: RecordingSession = { recorder, stream, chunks: [], discard: false, failed: false, autoSubmit: false, startedAt: performance.now() };
      sessionRef.current = session;
      recorder.ondataavailable = (event) => {
        if (event.data.size && !session.discard) session.chunks.push(event.data);
      };
      recorder.onerror = () => {
        if (session.discard || !isCurrentOperation(generation, controls)) return;
        session.failed = true;
        closeSession(session);
        report(copy[latest.current.locale].recordingError, 'technical');
        if (recorder.state !== 'inactive') recorder.stop();
      };
      recorder.onstop = () => {
        closeSession(session);
        if (sessionRef.current === session) sessionRef.current = null;
        if (session.discard || !mountedRef.current || controls.resetSignal !== latest.current.resetSignal) return;
        const blob = new Blob(session.chunks, { type: recorder.mimeType || session.chunks[0]?.type || 'audio/webm' });
        session.chunks = [];
        latest.current.onEvent?.('recording_stopped');
        if (blob.size && !session.failed) {
          replaceClip(blob);
          changeStatus('ready');
          // Only a user stop (or the recording time limit) submits. Navigation,
          // language changes and backgrounding invalidate the capture generation.
          if (session.autoSubmit && isCurrentOperation(generation, controls)) void submit();
        } else {
          changeStatus(clipRef.current ? 'ready' : 'idle');
          notifyDraft(Boolean(clipRef.current));
          if (!session.failed && isCurrentOperation(generation, controls)) report(copy[latest.current.locale].empty, 'recognition');
        }
      };
      recorder.start();
      replaceClip(null);
      setSeconds(0);
      changeStatus('recording');
      notifyDraft(true);
      latest.current.onEvent?.('recording_started');
      session.interval = setInterval(() => {
        if (mountedRef.current) setSeconds(Math.min(MAX_RECORDING_SECONDS, Math.floor((performance.now() - session.startedAt) / 1000)));
      }, 200);
      session.timeout = setTimeout(() => stopCapture(), MAX_RECORDING_SECONDS * 1000);
    } catch (cause) {
      stream?.getTracks().forEach((track) => track.stop());
      if (!isCurrentOperation(generation, controls)) return;
      sessionRef.current = null;
      changeStatus(clipRef.current ? 'ready' : 'idle');
      const name = cause instanceof DOMException ? cause.name : '';
      report(name === 'NotAllowedError' || name === 'SecurityError' ? t.permission
        : name === 'NotFoundError' || name === 'OverconstrainedError' ? t.noDevice
          : name === 'NotReadableError' ? t.busyDevice : t.recordingError, 'technical');
    }
  }

  function cancel() {
    const wasSubmitting = statusRef.current === 'submitting';
    const wasRequesting = statusRef.current === 'requesting';
    const hadRecording = Boolean(sessionRef.current || clipRef.current);
    abortPending();
    stopAllAudio();
    const session = sessionRef.current;
    if (session) {
      session.discard = true;
      if (session.recorder.state !== 'inactive') session.recorder.stop();
      closeSession(session);
      sessionRef.current = null;
    }
    if (!wasSubmitting && !wasRequesting) {
      replaceClip(null);
      if (hadRecording) latest.current.onEvent?.('recording_cancelled');
    }
    if (wasSubmitting) latest.current.onEvent?.('asr_cancelled');
    setError(null);
    changeStatus(clipRef.current ? 'ready' : 'idle');
  }

  async function submit() {
    const blob = clipRef.current;
    if (!latest.current.enabled || latest.current.disabled || !blob || statusRef.current !== 'ready') return;
    abortPending();
    const generation = generationRef.current;
    const controls = latest.current;
    const controller = new AbortController();
    requestRef.current = controller;
    setError(null);
    stopAllAudio();
    changeStatus('submitting');
    let timedOut = false;
    // A terminal provider error can clear the reusable request ID. Keep this
    // attempt's ID separately so the parent can persist its failure result.
    let submittedRequestId: string | undefined;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 25000);
    try {
      let wav: ArrayBuffer;
      try {
        wav = await recordingToWav(blob);
      } catch {
        throw new Error('conversion');
      }
      if (!isCurrentOperation(generation, controls) || !latest.current.enabled) return;
      if (controller.signal.aborted) {
        if (timedOut) throw new Error('timeout');
        return;
      }
      requestIdRef.current ??= crypto.randomUUID();
      submittedRequestId = requestIdRef.current;
      latest.current.onEvent?.('asr_submitted');
      const response = await authFetch('/api/asr', {
        method: 'POST', headers: { 'Content-Type': 'audio/wav', 'X-Request-ID': requestIdRef.current }, credentials: 'same-origin',
        body: wav, signal: controller.signal,
      });
      if (!response.ok) {
        const failure: unknown = await response.json().catch(() => null);
        assertCurrentAuthResponse(response);
        if (!isCurrentOperation(generation, controls) || !latest.current.enabled) return;
        if (failure && typeof failure === 'object' && 'detail' in failure) {
          const detail = failure.detail;
          // Only a known, completed failure starts a new attempt. An unknown
          // outcome (cancel, lost connection, still pending) retains its ID.
          if (detail && typeof detail === 'object' && 'terminal' in detail && detail.terminal === true
            && 'retryable' in detail && detail.retryable === true) requestIdRef.current = null;
          if (detail && typeof detail === 'object' && 'code' in detail && detail.code === 'no_speech') {
            throw new Error('noText');
          }
        }
        throw new Error(response.status === 401 ? 'session' : 'recognition');
      }
      const result: unknown = await response.json();
      assertCurrentAuthResponse(response);
      if (!isCurrentOperation(generation, controls) || !latest.current.enabled || controller.signal.aborted) return;
      if (!result || typeof result !== 'object' || !('text' in result) || typeof result.text !== 'string' || !result.text.trim()) {
        throw new Error('noText');
      }
      const requestId = 'request_id' in result && typeof result.request_id === 'string' && result.request_id
        ? result.request_id : requestIdRef.current;
      if (!requestId) throw new Error('recognition');
      notifyDraft(false);
      latest.current.onTranscript(result.text, requestId);
      latest.current.onEvent?.('asr_succeeded');
    } catch (cause) {
      if (!isCurrentOperation(generation, controls) || !latest.current.enabled) return;
      if (controller.signal.aborted && !timedOut) return;
      const key = cause instanceof Error ? cause.message : 'recognition';
      const messages = copy[latest.current.locale];
      report(timedOut ? messages.timeout : key === 'conversion' ? messages.conversion
        : key === 'session' ? messages.session : key === 'noText' ? messages.noText : messages.recognition,
        key === 'noText' && !timedOut ? 'recognition' : 'technical', submittedRequestId);
      latest.current.onEvent?.('asr_failed');
    } finally {
      clearTimeout(timeout);
      if (isCurrentOperation(generation, controls) && latest.current.enabled) {
        requestRef.current = null;
        changeStatus(clipRef.current ? 'ready' : 'idle');
      }
    }
  }

  const isCapturing = status === 'recording' || status === 'stopping';
  return <section className="recorder" aria-label={t.label}>
    <div className="recorder-status" role="status" aria-live="polite">
      {isCapturing && <span className="recording-indicator" aria-hidden="true" />}
      <span>{status === 'requesting' ? t.requesting : status === 'recording' ? t.recording
        : status === 'stopping' ? t.stopping : status === 'submitting' ? t.submitting
          : clipUrl ? t.ready : t.label}</span>
      {isCapturing && <span className="recorder-timer" aria-label={`${seconds} / ${MAX_RECORDING_SECONDS}`}>{String(seconds).padStart(2, '0')} / 20s</span>}
    </div>
    {clipUrl && <audio ref={attachAudio} className="recorder-audio" controls={!disabled && status !== 'submitting'}
      aria-disabled={disabled || status === 'submitting'} src={clipUrl} aria-label={t.playback}
      onPlay={event => {
        if (latest.current.disabled || statusRef.current !== 'ready') event.currentTarget.pause();
        else if (!event.currentTarget.paused) latest.current.onEvent?.('recording_played');
        syncPhase();
      }} onPause={syncPhase} onEnded={syncPhase} onError={syncPhase} />}
    <div className="recorder-actions">
      {(status === 'idle' || status === 'ready') && <button type="button" className="button record-button" disabled={disabled} onClick={startRecording}>
        {clipUrl ? <RotateCcw size={18} aria-hidden="true" /> : <Mic size={18} aria-hidden="true" />}{clipUrl ? t.retry : t.start}
      </button>}
      {isCapturing && <button type="button" className="button record-button" disabled={status === 'stopping'} onClick={() => stopCapture()}>
        <Square size={16} aria-hidden="true" />{t.stop}
      </button>}
      {status !== 'idle' && <button type="button" className="button secondary" disabled={disabled && !isCapturing && status !== 'submitting'} onClick={cancel}>
        <X size={16} aria-hidden="true" />{status === 'submitting' ? t.cancelRequest : status === 'ready' ? t.discard : t.cancel}
      </button>}
    </div>
    {error && <p className="recorder-error" role="alert">{error}</p>}
    {!enabled && <p className="recorder-hint">{t.unavailable}</p>}
  </section>;
}
