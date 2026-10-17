import { useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, Eye, EyeOff, Globe2, LoaderCircle, LockKeyhole } from 'lucide-react';
import type { Locale } from '../lib/api';
import { Landmark } from './SceneArt';
import './AuthWelcome.css';

type AuthMode = 'login' | 'register';

type AuthWelcomeProps = {
  locale: Locale;
  mode: AuthMode;
  onModeChange: (mode: AuthMode) => void;
  onLocaleChange: (locale: Locale) => void;
  busy: boolean;
  error: string;
  fieldError?: 'username' | 'password' | null;
  legacyAvailable?: boolean;
  onSubmit: (data: { username: string; password: string; import_legacy: boolean }) => void;
  onGuest: () => void;
  onClose?: () => void;
};

const copy = {
  zh: {
    language: 'Switch to English', back: '返回本次体验', eyebrow: '上海 · 豫园',
    title: '从一句上海话，\n走近这座城。',
    introduction: '走进小店，点一份点心，喝一杯茶。四段日常交流，等你慢慢开口。',
    stops: ['老饭店', '梨膏糖', '南翔', '湖心亭'],
    login: '登录', register: '注册', tabs: '登录或注册',
    loginTitle: '欢迎回来', registerTitle: '留住这段漫游',
    loginDescription: '登录账号，接着上次的练习。', registerDescription: '只需一个用户名和密码，保存你的练习进度。',
    username: '用户名', usernameHint: '3–24 位英文字母、数字或下划线，不区分大小写。',
    password: '密码', passwordHint: '15–128 个字符，可以使用容易记住的长口令。',
    showPassword: '显示密码', hidePassword: '隐藏密码',
    recovery: '暂不支持找回密码，请妥善保管。',
    submitLogin: '登录并继续', submitRegister: '创建账号', waiting: '请稍候…',
    legacyTitle: '保存此浏览器原有的进度',
    legacyDescription: '将之前的匿名练习记录一并关联到本次登录的账号。',
    divider: '也可以先逛逛', guest: '直接体验',
    guestNote: '游客进度仅在当前标签页内保留，关闭后不会保留。登录可保存并继续学习。',
    saved: '登录后，可在其他设备接着练习。',
  },
  en: {
    language: '切换为中文', back: 'Back to this visit', eyebrow: 'SHANGHAI · YU GARDEN',
    title: 'A few words.\nA little closer to the city.',
    introduction: 'Step into a shop, order something warm, and share a cup of tea. Four everyday conversations, at your own pace.',
    stops: ['Restaurant', 'Pear candy', 'Nanxiang', 'Teahouse'],
    login: 'Sign in', register: 'Register', tabs: 'Sign in or register',
    loginTitle: 'Welcome back', registerTitle: 'Save your journey',
    loginDescription: 'Sign in to continue your saved practice.', registerDescription: 'A username and password are all you need to save your progress.',
    username: 'Username', usernameHint: '3–24 letters, numbers, or underscores. Not case-sensitive.',
    password: 'Password', passwordHint: '15–128 characters. A memorable passphrase works well.',
    showPassword: 'Show password', hidePassword: 'Hide password',
    recovery: 'Password recovery is not available yet. Keep your password safe.',
    submitLogin: 'Sign in and continue', submitRegister: 'Create account', waiting: 'Please wait…',
    legacyTitle: 'Keep earlier progress from this browser',
    legacyDescription: 'Add your previous anonymous practice records to the account you sign in to.',
    divider: 'Or take a look around', guest: 'Explore as a guest',
    guestNote: 'Guest progress stays in this tab and is not kept after you close it. Sign in to save it for another visit.',
    saved: 'Sign in to continue on another device.',
  },
};

export default function AuthWelcome({ locale, mode, onModeChange, onLocaleChange, busy, error, fieldError, legacyAvailable = false, onSubmit, onGuest, onClose }: AuthWelcomeProps) {
  const text = copy[locale];
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [importLegacy, setImportLegacy] = useState(false);
  const registering = mode === 'register';
  const stops = ['restaurant', 'candy', 'nanxiang', 'teahouse'] as const;

  function changeMode(next: AuthMode) {
    if (busy || next === mode) return;
    setPassword('');
    setShowPassword(false);
    onModeChange(next);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!busy) onSubmit({ username, password, import_legacy: legacyAvailable && importLegacy });
  }

  return <div className={`auth-welcome locale-${locale}`} lang={locale === 'zh' ? 'zh-CN' : 'en'}>
    <header className="auth-header">
      <div className="auth-brand" aria-label={locale === 'zh' ? '沪语漫游 · A little Shanghai' : 'A little Shanghai · 沪语漫游'}>
        <img src="/brand/pavilion-mark.png" width="1254" height="1254" alt=""/>
        <div><span className="auth-brand-chinese" lang="zh-CN">沪语漫游</span><span className="auth-brand-english" lang="en">A little Shanghai</span></div>
      </div>
      <button type="button" className="auth-language" onClick={() => onLocaleChange(locale === 'zh' ? 'en' : 'zh')} disabled={busy} aria-label={text.language}><Globe2 size={18}/><span>{locale === 'zh' ? 'English' : '中文'}</span></button>
    </header>

    <main className="auth-layout">
      <section className="auth-story" aria-labelledby="auth-welcome-title">
        <span className="overline"><span aria-hidden="true"/>{text.eyebrow}</span>
        <h1 id="auth-welcome-title">{text.title.split('\n').map((line, index) => <span key={index}>{line}</span>)}</h1>
        <p className="auth-introduction">{text.introduction}</p>
        <div className="auth-stops" aria-hidden="true">{stops.map((stop, index) => <div className={`auth-stop auth-stop-${stop}`} key={stop}>
          <Landmark kind={stop}/><span>{text.stops[index]}</span>
        </div>)}</div>
        <p className="auth-save-note"><LockKeyhole size={15}/>{text.saved}</p>
      </section>

      <section className="auth-card" aria-labelledby="auth-form-title">
        {onClose && <button type="button" className="auth-return" onClick={onClose} disabled={busy}><ArrowLeft size={17}/>{text.back}</button>}
        <div className="auth-mode" role="group" aria-label={text.tabs}>
          <button type="button" aria-pressed={!registering} onClick={() => changeMode('login')} disabled={busy}>{text.login}</button>
          <button type="button" aria-pressed={registering} onClick={() => changeMode('register')} disabled={busy}>{text.register}</button>
        </div>
        <h2 id="auth-form-title">{registering ? text.registerTitle : text.loginTitle}</h2>
        <p className="auth-form-description">{registering ? text.registerDescription : text.loginDescription}</p>
        <form onSubmit={submit} aria-busy={busy}>
          <div className="auth-field">
            <label htmlFor="auth-username">{text.username}</label>
            <input id="auth-username" name="username" type="text" autoComplete="username" autoCapitalize="none" spellCheck={false} required minLength={3} maxLength={24} pattern="[A-Za-z0-9_]{3,24}" value={username} onChange={event => setUsername(event.target.value)} disabled={busy} aria-invalid={fieldError === 'username' || undefined} aria-describedby={[registering && 'auth-username-hint', fieldError === 'username' && error && 'auth-error'].filter(Boolean).join(' ') || undefined}/>
            {registering && <p id="auth-username-hint" className="auth-field-hint">{text.usernameHint}</p>}
          </div>
          <div className="auth-field">
            <label htmlFor="auth-password">{text.password}</label>
            <div className="auth-password-wrap">
              <input id="auth-password" name="password" type={showPassword ? 'text' : 'password'} autoComplete={registering ? 'new-password' : 'current-password'} required value={password} onChange={event => setPassword(event.target.value)} disabled={busy} aria-invalid={fieldError === 'password' || undefined} aria-describedby={[registering && 'auth-password-hint', fieldError === 'password' && error && 'auth-error'].filter(Boolean).join(' ') || undefined}/>
              <button type="button" onClick={() => setShowPassword(value => !value)} disabled={busy} aria-label={showPassword ? text.hidePassword : text.showPassword} aria-pressed={showPassword}>{showPassword ? <EyeOff size={19}/> : <Eye size={19}/>}</button>
            </div>
            {registering && <p id="auth-password-hint" className="auth-field-hint">{text.passwordHint}</p>}
          </div>
          {legacyAvailable && <label className="auth-legacy"><input type="checkbox" checked={importLegacy} onChange={event => setImportLegacy(event.target.checked)} disabled={busy}/><span><strong>{text.legacyTitle}</strong><small>{text.legacyDescription}</small></span></label>}
          {error && <p id="auth-error" className="auth-error" role="alert">{error}</p>}
          <button type="submit" className="primary auth-submit" disabled={busy}>{busy ? <><LoaderCircle size={18}/>{text.waiting}</> : <>{registering ? text.submitRegister : text.submitLogin}<ArrowRight size={18}/></>}</button>
          {registering && <p className="auth-recovery-note">{text.recovery}</p>}
        </form>
        <div className="auth-divider"><span>{text.divider}</span></div>
        <button type="button" className="secondary auth-guest" onClick={onGuest} disabled={busy} aria-describedby="auth-guest-note">{text.guest}<ArrowRight size={17}/></button>
        <p id="auth-guest-note" className="auth-guest-note">{text.guestNote}</p>
      </section>
    </main>
  </div>;
}
