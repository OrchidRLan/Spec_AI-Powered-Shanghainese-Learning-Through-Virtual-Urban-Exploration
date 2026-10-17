import { useEffect, useRef, useState } from 'react';
import { Mic, RotateCcw, Send, Square, X } from 'lucide-react';
import { chooseRecordingMimeType, MAX_RECORDING_SECONDS, recordingToWav, stopAllAudio } from '../lib/audio';

type Locale = 'zh' | 'en';
type RecordingStatus = 'idle' | 'requesting' | 'recording' | 'stopping' | 'ready' | 'submitting';

interface RecorderProps {
  locale: Locale;
  enabled: boolean;
  onTranscript: (text: string, requestId: string) => void;
  onDraftChange?: (hasDraft: boolean) => void;
  onEvent?: (name: string) => void;
  onError?: (message: string) => void;
  stopSignal?: number;
}

interface RecordingSession {
  recorder: MediaRecorder;
  stream: MediaStream;
  chunks: Blob[];
  discard: boolean;
  failed: boolean;
  startedAt: number;
  interval?: ReturnType<typeof setInterval>;
  timeout?: ReturnType<typeof setTimeout>;
}

const copy = {
  zh: {
    label: '说一句上海话', start: '点击说话', requesting: '等待麦克风权限…',
    recording: '正在录音', stopping: '正在保存本地录音…', stop: '停止录音', cancel: '取消',
    ready: '录音已保留在本页，可以先回听。', retry: '重新录制', discard: '删除录音',
    submit: '提交录音识别', submitting: '正在识别，可以取消…', cancelRequest: '取消识别',
    playback: '回听我的录音', limit: '最长 20 秒。停止后可回听，点击提交才上传。',
    unavailable: '语音识别待连接，仍可本地回听、打字或选择。',
    privacy: '本地录音不长期保存；刷新或离开此页面后需要重录。提交后转写可随回应保存。',
    original: '原始转写', recognized: '已填入回应框，请核对后再提交回应。编辑稿与原始转写分别保存。',
    unsupported: '此浏览器无法录音。请使用支持录音的浏览器，或直接打字、选择回应。',
    permission: '麦克风权限未开启。可在浏览器中允许麦克风，也可以打字或选择回应。',
    noDevice: '没有找到可用的麦克风。请连接麦克风，或打字、选择回应。',
    busyDevice: '麦克风暂时无法使用，可能正被其他应用占用。请重试或改用文字、选择。',
    recordingError: '录音未能完成，请重新录制或改用文字、选择。',
    empty: '没有收到有效录音，请重新录制。',
    conversion: '此录音暂时无法转换为可识别的格式。仍可本地回听，请重新录制或打字、选择。',
    session: '体验会话已过期，请刷新页面后重试；刷新会清除本地录音。',
    recognition: '识别暂时不可用。录音已保留，可以重试或改用文字、选择。',
    noText: '未识别到清楚的文字。录音已保留，请回听后重试，或打字、选择。',
    timeout: '识别等待超时。录音已保留，请重试或改用文字、选择。',
  },
  en: {
    label: 'Try saying it in Shanghainese', start: 'Tap to speak', requesting: 'Waiting for microphone permission…',
    recording: 'Recording', stopping: 'Preparing your local recording…', stop: 'Stop recording', cancel: 'Cancel',
    ready: 'Your recording is on this page. Listen back before sending.', retry: 'Record again', discard: 'Delete recording',
    submit: 'Send for transcription', submitting: 'Transcribing… You can cancel.', cancelRequest: 'Cancel transcription',
    playback: 'Play my recording', limit: 'Up to 20 seconds. Listen back first; upload only when you press Send.',
    unavailable: 'Speech recognition is not connected yet. You can still record, listen back, type, or choose.',
    privacy: 'Your local recording is not stored long term. Refreshing or leaving this page clears it. Submitted transcripts may be saved with your response.',
    original: 'Original transcript', recognized: 'Added to your response box. Check it before submitting your response. Edits and the original transcript are saved separately.',
    unsupported: 'This browser cannot record audio. Use a supported browser, type, or choose a response.',
    permission: 'Microphone permission is off. Allow it in your browser, or type or choose a response.',
    noDevice: 'No microphone was found. Connect one, or type or choose a response.',
    busyDevice: 'The microphone is unavailable or in use by another app. Try again, type, or choose.',
    recordingError: 'Recording could not finish. Try recording again, type, or choose.',
    empty: 'No usable audio was recorded. Please record again.',
    conversion: 'This recording could not be converted for recognition. You can still listen back, record again, type, or choose.',
    session: 'Your session expired. Refresh the page to retry; this will clear your local recording.',
    recognition: 'Recognition is unavailable. Your recording is still here. Retry, type, or choose.',
    noText: 'No clear words were recognized. Your recording is still here. Listen back and retry, type, or choose.',
    timeout: 'Recognition timed out. Your recording is still here. Retry, type, or choose.',
  },
};

function closeSession(session: RecordingSession): void {
  clearInterval(session.interval);
  clearTimeout(session.timeout);
  session.stream.getTracks().forEach((track) => track.stop());
}

export default function Recorder({ locale, enabled, onTranscript, onDraftChange, onEvent, onError, stopSignal }: RecorderProps) {
  const [status, setStatus] = useState<RecordingStatus>('idle');
  const [seconds, setSeconds] = useState(0);
  const [clipUrl, setClipUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [original, setOriginal] = useState('');
  const sessionRef = useRef<RecordingSession | null>(null);
  const clipRef = useRef<Blob | null>(null);
  const urlRef = useRef<string | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const requestIdRef = useRef<string | null>(null);
  const generationRef = useRef(0);
  const mountedRef = useRef(true);
  const draftRef = useRef(false);
  const statusRef = useRef<RecordingStatus>('idle');
  const latest = useRef({ locale, onTranscript, onDraftChange, onEvent, onError });
  latest.current = { locale, onTranscript, onDraftChange, onEvent, onError };
  const t = copy[locale];

  function changeStatus(next: RecordingStatus) {
    statusRef.current = next;
    if (mountedRef.current) setStatus(next);
  }

  function report(message: string) {
    if (!mountedRef.current) return;
    setError(message);
    latest.current.onError?.(message);
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
      setOriginal('');
      notifyDraft(Boolean(blob));
    }
  }

  function abortPending() {
    generationRef.current += 1;
    requestRef.current?.abort();
    requestRef.current = null;
  }

  function stopCapture() {
    const session = sessionRef.current;
    if (!session) return;
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
    if (sessionRef.current) stopCapture();
    else if (statusRef.current === 'requesting' || statusRef.current === 'submitting') {
      changeStatus(clipRef.current ? 'ready' : 'idle');
    }
  }

  useEffect(() => {
    mountedRef.current = true;
    latest.current.onDraftChange?.(draftRef.current);
    const onVisibility = () => {
      if (document.hidden) stopAndKeep();
    };
    const onPageHide = () => stopAndKeep();
    const onPlay = (event: Event) => {
      if (!(event.target instanceof HTMLMediaElement)) return;
      if (['requesting', 'recording', 'stopping'].includes(statusRef.current)) event.target.pause();
      else stopAllAudio(event.target);
    };
    document.addEventListener('visibilitychange', onVisibility);
    document.addEventListener('play', onPlay, true);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      mountedRef.current = false;
      abortPending();
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
    };
  }, []);

  useEffect(() => {
    stopAndKeep();
    setError(null);
  }, [locale, stopSignal]);
  useEffect(() => {
    if (!enabled && statusRef.current === 'submitting') stopAndKeep();
  }, [enabled]);

  async function startRecording() {
    if (['recording', 'stopping', 'requesting', 'submitting'].includes(statusRef.current)) return;
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      report(t.unsupported);
      return;
    }
    abortPending();
    const generation = generationRef.current;
    stopAllAudio();
    changeStatus('requesting');
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      if (!mountedRef.current || generation !== generationRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const mimeType = chooseRecordingMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const session: RecordingSession = { recorder, stream, chunks: [], discard: false, failed: false, startedAt: performance.now() };
      sessionRef.current = session;
      recorder.ondataavailable = (event) => {
        if (event.data.size && !session.discard) session.chunks.push(event.data);
      };
      recorder.onerror = () => {
        if (session.discard || !mountedRef.current) return;
        session.failed = true;
        closeSession(session);
        report(copy[latest.current.locale].recordingError);
        if (recorder.state !== 'inactive') recorder.stop();
      };
      recorder.onstop = () => {
        closeSession(session);
        if (sessionRef.current === session) sessionRef.current = null;
        if (session.discard || !mountedRef.current) return;
        const blob = new Blob(session.chunks, { type: recorder.mimeType || session.chunks[0]?.type || 'audio/webm' });
        session.chunks = [];
        latest.current.onEvent?.('recording_stopped');
        if (blob.size && !session.failed) {
          replaceClip(blob);
          changeStatus('ready');
        } else {
          changeStatus(clipRef.current ? 'ready' : 'idle');
          notifyDraft(Boolean(clipRef.current));
          if (!session.failed) report(copy[latest.current.locale].empty);
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
      session.timeout = setTimeout(stopCapture, MAX_RECORDING_SECONDS * 1000);
    } catch (cause) {
      stream?.getTracks().forEach((track) => track.stop());
      if (!mountedRef.current || generation !== generationRef.current) return;
      sessionRef.current = null;
      changeStatus(clipRef.current ? 'ready' : 'idle');
      const name = cause instanceof DOMException ? cause.name : '';
      report(name === 'NotAllowedError' || name === 'SecurityError' ? t.permission
        : name === 'NotFoundError' || name === 'OverconstrainedError' ? t.noDevice
          : name === 'NotReadableError' ? t.busyDevice : t.recordingError);
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
    if (!enabled || !blob || statusRef.current !== 'ready') return;
    abortPending();
    const generation = generationRef.current;
    const controller = new AbortController();
    requestRef.current = controller;
    setError(null);
    stopAllAudio();
    changeStatus('submitting');
    let timedOut = false;
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
      if (generation !== generationRef.current) return;
      if (controller.signal.aborted) {
        if (timedOut) throw new Error('timeout');
        return;
      }
      requestIdRef.current ??= crypto.randomUUID();
      latest.current.onEvent?.('asr_submitted');
      const response = await fetch('/api/asr', {
        method: 'POST', headers: { 'Content-Type': 'audio/wav', 'X-Request-ID': requestIdRef.current }, credentials: 'same-origin',
        body: wav, signal: controller.signal,
      });
      if (!response.ok) {
        const failure: unknown = await response.json().catch(() => null);
        if (generation !== generationRef.current || !mountedRef.current) return;
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
      if (generation !== generationRef.current || !mountedRef.current || controller.signal.aborted) return;
      if (!result || typeof result !== 'object' || !('text' in result) || typeof result.text !== 'string' || !result.text.trim()) {
        throw new Error('noText');
      }
      setOriginal(result.text);
      const requestId = 'request_id' in result && typeof result.request_id === 'string' && result.request_id
        ? result.request_id : requestIdRef.current;
      if (!requestId) throw new Error('recognition');
      notifyDraft(false);
      latest.current.onTranscript(result.text, requestId);
      latest.current.onEvent?.('asr_succeeded');
    } catch (cause) {
      if (generation !== generationRef.current || !mountedRef.current) return;
      if (controller.signal.aborted && !timedOut) return;
      const key = cause instanceof Error ? cause.message : 'recognition';
      const messages = copy[latest.current.locale];
      report(timedOut ? messages.timeout : key === 'conversion' ? messages.conversion
        : key === 'session' ? messages.session : key === 'noText' ? messages.noText : messages.recognition);
      latest.current.onEvent?.('asr_failed');
    } finally {
      clearTimeout(timeout);
      if (generation === generationRef.current && mountedRef.current) {
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
    {clipUrl && <audio className="recorder-audio" controls src={clipUrl} aria-label={t.playback}
      onPlay={() => latest.current.onEvent?.('recording_played')} />}
    <div className="recorder-actions">
      {(status === 'idle' || status === 'ready') && <button type="button" className="button record-button" onClick={startRecording}>
        {clipUrl ? <RotateCcw size={18} aria-hidden="true" /> : <Mic size={18} aria-hidden="true" />}{clipUrl ? t.retry : t.start}
      </button>}
      {isCapturing && <button type="button" className="button record-button" disabled={status === 'stopping'} onClick={stopCapture}>
        <Square size={16} aria-hidden="true" />{t.stop}
      </button>}
      {status === 'ready' && <button type="button" className="button primary" disabled={!enabled} onClick={submit}>
        <Send size={16} aria-hidden="true" />{t.submit}
      </button>}
      {status !== 'idle' && <button type="button" className="button secondary" onClick={cancel}>
        <X size={16} aria-hidden="true" />{status === 'submitting' ? t.cancelRequest : status === 'ready' ? t.discard : t.cancel}
      </button>}
    </div>
    {error && <p className="recorder-error" role="alert">{error}</p>}
    {!enabled && <p className="recorder-hint">{t.unavailable}</p>}
    <p className="recorder-hint">{t.limit}</p>
    <p className="recorder-hint recorder-privacy">{t.privacy}</p>
    {original && <div className="transcript-result" role="status">
      <p>{t.recognized}</p>
      <details><summary>{t.original}</summary><p lang="zh">{original}</p></details>
    </div>}
  </section>;
}
