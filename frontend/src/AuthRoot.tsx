import { useEffect, useRef, useState } from 'react';
import App from './App';
import AuthWelcome from './components/AuthWelcome';
import Dialog from './components/Dialog';
import { api, post, ApiError, type AuthState, type Locale } from './lib/api';
import { bindAuthSession, changeAuthIdentity, isolateAuthRequests, onAuthExpired, setGuestToken } from './lib/authSession';
import { stopAllAudio } from './lib/audio';
import './AuthRoot.css';

const signedOut: AuthState = { mode: 'signed_out', user: null, session: null, legacy_available: false };
const errors: Record<string, { zh: string; en: string }> = {
  invalid_credentials: { zh: '用户名或密码不正确，请再试一次。', en: 'The username or password is incorrect. Please try again.' },
  username_taken: { zh: '这个用户名已有人使用，请换一个。', en: 'This username is already taken. Please choose another.' },
  invalid_username: { zh: '用户名需为 3–24 位英文字母、数字或下划线。', en: 'Use 3–24 letters, numbers, or underscores for your username.' },
  invalid_password: { zh: '密码需为 15–128 个字符，可以包含空格。', en: 'Use a password with 15–128 characters. Spaces are welcome.' },
  auth_rate_limited: { zh: '尝试次数较多，请稍等片刻再试。', en: 'Too many attempts. Please wait a little before trying again.' },
  merge_in_progress: { zh: '这段练习还在保存，请稍等后重试。', en: 'Your practice is still being saved. Please wait and try again.' },
  merge_conflict: { zh: '这两段进度使用不同的课程版本，暂时不能合并。原记录仍在，可返回本次体验，或取消导入旧进度后登录。', en: 'These journeys use different lesson versions and cannot be combined. Your records are kept. Return to this visit, or uncheck importing earlier progress to sign in.' },
  legacy_unavailable: { zh: '旧进度暂时不可用，请取消导入或稍后再试。', en: 'The earlier journey is unavailable. Uncheck importing it or try again later.' },
};

function requireAuthState(value: AuthState): AuthState {
  if (!value || !['signed_out', 'guest', 'account'].includes(value.mode)
    || value.mode !== 'signed_out' && (!value.session?.id || value.mode === 'account' && !value.user?.username)) throw new Error('Invalid authentication response');
  return value;
}

export default function AuthRoot() {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [locale, setLocale] = useState<Locale>('zh');
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [overlay, setOverlay] = useState(false);
  const [busy, setBusy] = useState(false);
  const [connectionError, setConnectionError] = useState(false);
  const [error, setError] = useState('');
  const [fieldError, setFieldError] = useState<'username' | 'password' | null>(null);
  const [identity, setIdentity] = useState(0);
  const operation = useRef(0);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const localeRef = useRef(locale); localeRef.current = locale;

  useEffect(() => {
    if(!auth || auth.mode === 'signed_out') {
      document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
      document.title = locale === 'zh' ? '沪语漫游 · 登录' : 'A little Shanghai · Sign in';
    }
  }, [auth?.mode, locale]);

  function enter(next: AuthState, newlyAuthenticated: boolean) {
    stopAllAudio();
    changeAuthIdentity();
    setGuestToken(next.mode === 'guest' ? next.guest_token || null : null);
    bindAuthSession(next.session?.id || null);
    setAuth(next); if(next.mode === 'signed_out') setMode('login'); setOverlay(false); setError(''); setFieldError(null); setConnectionError(false);
    if (next.session) setLocale(next.session.locale);
    if (newlyAuthenticated) window.history.replaceState(null, '', '#about');
    setIdentity(value => value + 1);
  }

  async function restore() {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setConnectionError(false);
    const ticket = ++operation.current;
    try {
      const next = requireAuthState(await api<AuthState>('/auth'));
      if (!mounted.current || ticket !== operation.current) return;
      // Restoring a guest keeps its tab-only credential; GET never issues a new one.
      bindAuthSession(next.session?.id || null); setAuth(next);
      if (next.mode !== 'guest') setGuestToken(null);
      if (next.session) setLocale(next.session.locale);
    } catch (cause) {
      if (mounted.current && ticket === operation.current && !(cause instanceof DOMException && cause.name === 'AbortError')) setConnectionError(true);
    } finally {
      if (mounted.current && ticket === operation.current) { inFlight.current = false; setBusy(false); }
    }
  }

  useEffect(() => {
    mounted.current = true;
    const unsubscribe = onAuthExpired(() => {
      operation.current += 1; inFlight.current = false; stopAllAudio();
      setAuth(signedOut); setOverlay(false); setBusy(false); setConnectionError(false);
      setFieldError(null); setError(localeRef.current === 'zh' ? '本次体验已结束，请重新登录或开始游客体验。' : 'This session has ended. Sign in again or start a guest visit.');
      setIdentity(value => value + 1);
    });
    void restore();
    return () => { mounted.current = false; operation.current += 1; unsubscribe(); };
  }, []);

  async function authenticate(kind: 'login' | 'register' | 'guest' | 'logout', values?: { username: string; password: string; import_legacy: boolean }, requestLocale: Locale = locale) {
    if (inFlight.current) return;
    inFlight.current = true; stopAllAudio(); isolateAuthRequests(); setBusy(true); setError(''); setFieldError(null);
    const ticket = ++operation.current;
    try {
      const next = requireAuthState(await post<AuthState>(`/auth/${kind}`, kind === 'logout' ? {} : { locale: requestLocale, ...values }));
      if(kind === 'guest' && !next.guest_token) throw new Error('Missing guest credential');
      if (!mounted.current || ticket !== operation.current) return;
      enter(next, kind !== 'logout');
    } catch (cause) {
      if (!mounted.current || ticket !== operation.current || cause instanceof DOMException && cause.name === 'AbortError') return;
      const code = cause instanceof ApiError ? cause.code : '';
      if (!code || code.startsWith('http_5')) {
        // A response can be lost after the server commits a login. Inspect the
        // original guest first so an unrelated account cookie cannot steal it.
        try {
          let recovered: AuthState | null = null;
          try { recovered = requireAuthState(await api<AuthState>('/auth', undefined, {expire:false})); }
          catch (check) {
            if (check instanceof ApiError && check.code === 'guest_expired') recovered = requireAuthState(await api<AuthState>('/auth', undefined, {guest:'omit',expire:false}));
            else throw check;
          }
          if (!mounted.current || ticket !== operation.current) return;
          const matchingAccount = values && recovered.mode === 'account' && recovered.user?.username.toLowerCase() === values.username.toLowerCase();
          if (matchingAccount || kind === 'logout' && recovered.mode === 'signed_out') { enter(recovered, kind !== 'logout'); return; }
        } catch { /* An uncertain outcome keeps the current form and identity. */ }
      }
      setError(errors[code]?.[requestLocale] || (requestLocale === 'zh' ? '暂时连接不上，填写的内容还在，请重试。' : 'We could not connect. Your entries are still here. Please try again.'));
      setFieldError(code === 'username_taken' || code === 'invalid_username' ? 'username' : code === 'invalid_password' ? 'password' : null);
    } finally {
      if (mounted.current && ticket === operation.current) { inFlight.current = false; setBusy(false); }
    }
  }

  function openAccount(nextLocale: Locale) {
    setLocale(nextLocale); setMode('login'); setError(''); setFieldError(null); setOverlay(true);
  }
  const welcome = <AuthWelcome locale={locale} mode={mode} onModeChange={next=>{setMode(next);setError('');setFieldError(null);}} onLocaleChange={setLocale} busy={busy} error={error} fieldError={fieldError} legacyAvailable={auth?.legacy_available} onSubmit={values=>void authenticate(mode, values)} onGuest={()=>{if(overlay){setOverlay(false);setError('');}else void authenticate('guest');}} onClose={overlay ? ()=>{if(!busy){setOverlay(false);setError('');}} : undefined}/>;

  if (!auth) return <main className="auth-connection" aria-live="polite"><img src="/brand/pavilion-mark.png" alt="" width="88" height="88"/><h1>{locale === 'zh' ? '沪语漫游' : 'A little Shanghai'}</h1><p>{connectionError ? (locale === 'zh' ? '暂时连接不上，暂存的登录状态没有改变。' : 'We could not connect. Your sign-in has not been changed.') : (locale === 'zh' ? '正在打开这段漫游…' : 'Opening your journey…')}</p>{connectionError && <button className="primary" disabled={busy} onClick={()=>void restore()}>{locale === 'zh' ? '重试' : 'Try again'}</button>}</main>;
  if (auth.mode === 'signed_out' || !auth.session) return welcome;
  return <>
    {busy && !overlay && <div className="auth-changing" role="status">{locale === 'zh' ? '正在退出登录…' : 'Signing out…'}</div>}
    <App key={identity} initialSession={auth.session} accountName={auth.user?.username || null} onSignIn={openAccount} onSignOut={nextLocale=>{setLocale(nextLocale);localeRef.current=nextLocale;void authenticate('logout', undefined, nextLocale);}} authBusy={busy} authError={overlay ? '' : error}/>
    {overlay && <Dialog title={locale === 'zh' ? '留住这段漫游' : 'Save your journey'} closeLabel={locale === 'zh' ? '返回体验' : 'Back to your visit'} onClose={()=>{if(!busy){setOverlay(false);setError('');}}} className="auth-overlay-dialog">{welcome}</Dialog>}
  </>;
}
