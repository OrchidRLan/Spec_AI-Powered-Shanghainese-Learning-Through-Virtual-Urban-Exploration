import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { transformWithOxc } from 'vite';

const files = ['components/AuthWelcome.tsx', 'components/AboutPage.tsx', 'lib/i18n.ts'];
const sources = await Promise.all(files.map(file => readFile(new URL(`../src/${file}`, import.meta.url), 'utf8')));
const icons = [...new Set(sources.flatMap(source => source.match(/import \{([^}]+)\} from 'lucide-react'/)?.[1].split(',').map(name => name.trim()) ?? []))];
const executable = (await Promise.all(sources.map(async (source, index) => {
  const transformed = await transformWithOxc(source, files[index], { jsx: { runtime: 'classic' } });
  return transformed.code.replace(/^import\b[\s\S]*?;\n/gm, '')
    .replace(/export default function /g, 'function ').replace(/export (?=(?:function|const) )/g, '');
}))).join('\n');

function harness(initial = {}) {
  let cursor = 0;
  const slots = [];
  const submits = []; const locales = [];
  let guests = 0; let closes = 0;
  const props = { locale: 'en', mode: 'login', busy: false, error: '',
    onModeChange: mode => { props.mode = mode; }, onLocaleChange: locale => locales.push(locale),
    onSubmit: payload => submits.push(JSON.parse(JSON.stringify(payload))), onGuest: () => guests++, ...initial };
  if (initial.onClose) props.onClose = () => closes++;
  const components = Object.fromEntries([...icons, 'Landmark'].map(name => [name, function boundary() {}]));
  const context = { ...components,
    useState: initial => {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
    },
    React: { createElement: (type, attributes, ...children) => ({ type, props: { ...attributes, children } }) },
  };
  const { AuthWelcome, AboutPage } = vm.runInNewContext(`${executable}\n({AuthWelcome, AboutPage});`, context);
  let tree;
  const render = () => { cursor = 0; tree = AuthWelcome(props); };
  const nodes = (node = tree) => !node || typeof node !== 'object' ? [] : [node, ...(node.props?.children ?? []).flat(Infinity).filter(child => child != null).flatMap(nodes)];
  const text = (node = tree) => typeof node === 'string' || typeof node === 'number' ? String(node)
    : !node || typeof node !== 'object' ? '' : (node.props?.children ?? []).flat(Infinity).filter(child => child != null).map(text).join('');
  const find = predicate => nodes().find(predicate);
  render();
  return {
    submits, locales, get guests() { return guests; }, get closes() { return closes; }, get text() { return text(); },
    input: name => find(node => node.type === 'input' && node.props.name === name)?.props,
    change(name, value) { this.input(name).onChange({ target: { value } }); render(); },
    click(label) {
      const button = find(node => node.type === 'button' && (node.props['aria-label'] === label || text(node) === label));
      assert.ok(button, `Button exists: ${label}`);
      if (!button.props.disabled) button.props.onClick();
      render();
    },
    consent(checked) { find(node => node.type === 'input' && node.props.type === 'checkbox').props.onChange({ target: { checked } }); render(); },
    submit() { find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); render(); },
    set(update) { Object.assign(props, update); render(); },
    find, textOf: text,
    about(aboutProps) { tree = AboutPage({ locale: props.locale, hasProgress: false, onExplore() {}, ...aboutProps }); },
  };
}

test('welcome submits the entered username and exact password without importing old records by default', () => {
  const h = harness({ mode: 'register', legacyAvailable: true });
  h.change('username', 'Garden_Walker');
  h.change('password', '  a memorable tea time  ');
  h.submit();
  assert.deepEqual(h.submits, [{ username: 'Garden_Walker', password: '  a memorable tea time  ', import_legacy: false }]);
  h.consent(true); h.submit();
  assert.equal(h.submits[1].import_legacy, true);
  h.set({ legacyAvailable: false }); h.submit();
  assert.equal(h.submits[2].import_legacy, false, 'hidden legacy option cannot imply consent');
});

test('switching between login and registration clears and hides the password while retaining the username', () => {
  const h = harness();
  h.change('username', 'Garden_Walker'); h.change('password', 'a memorable tea time');
  h.click('Show password');
  assert.equal(h.input('password').type, 'text');
  assert.equal(h.input('password').autoComplete, 'current-password');
  h.click('Register');
  assert.equal(h.input('username').value, 'Garden_Walker');
  assert.equal(h.input('password').value, '');
  assert.equal(h.input('password').type, 'password');
  assert.equal(h.input('password').autoComplete, 'new-password');
  assert.match(h.text, /15–128 characters/);
  assert.match(h.text, /Password recovery is not available/);
});

test('guest choice, return, and language switch remain separate from account submission', () => {
  const h = harness({ onClose: true });
  assert.match(h.text, /Guest progress stays in this tab and is not kept after you close it/);
  h.click('Explore as a guest'); h.click('Back to this visit'); h.click('切换为中文');
  assert.equal(h.guests, 1); assert.equal(h.closes, 1);
  assert.deepEqual(h.locales, ['zh']); assert.equal(h.submits.length, 0);
  h.set({ busy: true }); h.click('Explore as a guest'); h.click('Back to this visit'); h.click('切换为中文'); h.submit();
  assert.equal(h.guests, 1); assert.equal(h.closes, 1); assert.equal(h.locales.length, 1); assert.equal(h.submits.length, 0);
  assert.equal(h.input('username').disabled, true); assert.equal(h.input('password').disabled, true);
});

test('registration exposes field errors and temporary guest wording in both languages', () => {
  for (const locale of ['zh', 'en']) {
    const h = harness({ locale, mode: 'register', error: 'Username is already in use.', fieldError: 'username' });
    assert.equal(h.input('username')['aria-invalid'], true);
    assert.match(h.input('username')['aria-describedby'], /auth-error/);
    assert.equal(h.find(node => node.props?.role === 'alert').props.id, 'auth-error');
    assert.match(h.text, locale === 'zh' ? /游客进度仅在当前标签页内保留，关闭后不会保留/ : /Guest progress stays in this tab and is not kept after you close it/);
    assert.match(h.text, locale === 'zh' ? /暂不支持找回密码/ : /Password recovery is not available/);
    h.set({ fieldError: 'password' });
    assert.equal(h.input('password')['aria-invalid'], true);
    assert.match(h.input('password')['aria-describedby'], /auth-error/);
  }
});

test('About distinguishes temporary guest progress from account saving in both languages', () => {
  for (const locale of ['zh', 'en']) {
    const h = harness({ locale }); let signIns = 0;
    h.about({ onSignIn: () => signIns++ });
    assert.match(h.text, locale === 'zh' ? /游客进度仅在本次体验中保留/ : /Guest progress lasts for this visit/);
    const signIn = h.find(node => node.type === 'button' && node.props.className === 'about-sign-in');
    assert.ok(signIn); signIn.props.onClick(); assert.equal(signIns, 1);
    assert.doesNotMatch(h.text, /Pick up where you left off|下次接着逛/);
    h.about({ accountName: 'Garden_Walker', onSignIn() {} });
    assert.match(h.text, locale === 'zh' ? /进度已保存到账号/ : /Your progress is saved to your account/);
    assert.doesNotMatch(h.text, /Guest progress lasts|游客进度仅/);
    assert.equal(h.find(node => node.type === 'button' && node.props.className === 'about-sign-in'), undefined);
  }
});
