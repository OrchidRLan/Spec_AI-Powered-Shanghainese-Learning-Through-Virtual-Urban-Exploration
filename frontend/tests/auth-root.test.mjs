import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { transformWithOxc } from 'vite';

const {code}=await transformWithOxc(await readFile(new URL('../src/AuthRoot.tsx',import.meta.url),'utf8'),'AuthRoot.tsx',{jsx:{runtime:'classic'}});
const executable=code.replace(/^import\b[\s\S]*?;\n/gm,'').replace('export default function AuthRoot','function AuthRoot');
const signedOut={mode:'signed_out',user:null,session:null,legacy_available:false};
const guest={mode:'guest',user:null,session:{id:'guest-1',locale:'en'},legacy_available:false,guest_token:'temporary'};
const account={mode:'account',user:{username:'Alice'},session:{id:'account-1',locale:'en'},legacy_available:false};
function deferred(){let resolve;let reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
function harness(options={}){
  const slots=[];const effects=[];const requests=[];const identityChanges=[];const guestTokens=[];let expired;let cursor=0;let dirty=true;let tree;let disposed=false;
  const same=(a,b)=>a&&b&&a.length===b.length&&a.every((value,index)=>Object.is(value,b[index]));
  const useState=initial=>{const index=cursor++;if(!(index in slots))slots[index]=typeof initial==='function'?initial():initial;return[slots[index],value=>{const next=typeof value==='function'?value(slots[index]):value;if(!Object.is(next,slots[index])){slots[index]=next;dirty=true;}}];};
  const useRef=value=>slots[cursor++]??={current:value};
  const useEffect=(callback,dependencies)=>{const index=cursor++;if(!same(slots[index]?.dependencies,dependencies)){const previous=slots[index];const slot={dependencies,cleanup:previous?.cleanup};slots[index]=slot;effects.push(()=>{slot.cleanup?.();slot.cleanup=callback();});}};
  const components=Object.fromEntries(['App','AuthWelcome','Dialog'].map(name=>[name,function boundary(){}]));
  class ApiError extends Error{constructor(code){super(code);this.code=code;}}
  const window={location:{hash:options.hash??''},history:{replaceState:(_s,_t,hash)=>{window.location.hash=hash;}}};
  const value=(result,...args)=>typeof result==='function'?result(...args):result?.promise??result;
  const context={...components,useState,useRef,useEffect,React:{createElement:(type,props,...children)=>({type,props:{...props,children}})},window,document:{title:'',documentElement:{lang:''}},DOMException,ApiError,
    stopAllAudio:()=>{},bindAuthSession:()=>{},isolateAuthRequests:()=>{},changeAuthIdentity:()=>identityChanges.push(true),setGuestToken:value=>guestTokens.push(value),onAuthExpired:callback=>{expired=callback;return()=>{expired=null;};},
    api:async(path,init,policy)=>{requests.push({path,policy});if(options.readResponse)return options.readResponse(path,policy,requests.filter(r=>!r.body).length);if(options.restoreError)throw new TypeError('offline');return value(options.restore??signedOut);},
    post:async(path,body)=>{requests.push({path,body});return value(options.response??guest,path,body);},
  };
  const AuthRoot=vm.runInNewContext(`${executable};AuthRoot`,context);
  function flush(){for(let loop=0;dirty&&loop<30;loop++){dirty=false;cursor=0;tree=AuthRoot();while(effects.length)effects.shift()();}assert.equal(dirty,false);}
  function nodes(node=tree){return node&&typeof node==='object'?[node,...(node.props?.children??[]).flat(Infinity).flatMap(nodes)]:[];}
  function text(node=tree){return typeof node==='string'?node:node&&typeof node==='object'?(node.props?.children??[]).flat(Infinity).map(text).join(''):'';}
  const find=predicate=>nodes().find(predicate);flush();
  return{requests,guestTokens,identityChanges,ApiError,options,find,get welcome(){return find(node=>node.type===components.AuthWelcome)?.props;},get app(){return find(node=>node.type===components.App)?.props;},get dialog(){return find(node=>node.type===components.Dialog)?.props;},get title(){return context.document.title;},get documentLanguage(){return context.document.documentElement.lang;},get hash(){return window.location.hash;},get text(){return text();},expire(){expired();flush();},flush,async settle(){for(let i=0;i<25;i++){await Promise.resolve();if(!disposed)flush();}},dispose(){disposed=true;for(const slot of slots)slot?.cleanup?.();}};
}

test('signed-out boot only checks auth, exposes welcome and never creates an anonymous session',async t=>{
  const h=harness();t.after(()=>h.dispose());await h.settle();assert.equal(h.welcome.mode,'login');assert.equal(h.app,undefined);assert.deepEqual(h.requests.map(r=>r.path),['/auth']);
  h.welcome.onLocaleChange('en');await h.settle();assert.equal(h.welcome.locale,'en');assert.equal(h.requests.length,1);
});

test('guest entry is single-flight and enters About with a tab credential',async t=>{
  const response=deferred();const h=harness({hash:'#nanxiang',response});t.after(()=>h.dispose());await h.settle();h.welcome.onGuest();h.welcome.onGuest();await h.settle();
  assert.equal(h.requests.filter(r=>r.path==='/auth/guest').length,1);assert.equal(h.welcome.busy,true);response.resolve(guest);await h.settle();
  assert.equal(h.hash,'#about');assert.equal(h.app.initialSession.id,'guest-1');assert.equal(h.app.accountName,null);assert.equal(h.guestTokens.at(-1),'temporary');
});

test('existing account or guest restores its exact deep link without creating a new guest',async t=>{
  for(const restore of [account,guest]){const h=harness({hash:'#review/candy',restore});t.after(()=>h.dispose());await h.settle();assert.equal(h.hash,'#review/candy');assert.equal(h.app.initialSession.id,restore.session.id);assert.equal(h.welcome,undefined);assert.deepEqual(h.requests.map(r=>r.path),['/auth']);}
});

test('login and register send unchanged passwords and legacy choice, then remount at About',async t=>{
  for(const mode of ['login','register']){const h=harness({restore:{...signedOut,legacy_available:true},response:account});t.after(()=>h.dispose());await h.settle();h.welcome.onModeChange(mode);await h.settle();assert.equal(h.welcome.legacyAvailable,true);
    h.welcome.onSubmit({username:'Alice',password:' long password with spaces ',import_legacy:true});await h.settle();
    const sent=h.requests.find(r=>r.path===`/auth/${mode}`);assert.equal(sent.body.password,' long password with spaces ');assert.equal(sent.body.import_legacy,true);assert.equal(h.app.accountName,'Alice');assert.equal(h.hash,'#about');assert.equal(h.guestTokens.at(-1),null);
  }
});

test('a guest can cancel account entry or resume guest mode without replacing current progress',async t=>{
  const h=harness({restore:guest});t.after(()=>h.dispose());await h.settle();const key=h.app.key;
  h.app.onSignIn('en');await h.settle();assert.ok(h.dialog);h.welcome.onGuest();await h.settle();assert.equal(h.dialog,undefined);assert.equal(h.app.key,key);assert.equal(h.requests.length,1);
  h.app.onSignIn('en');await h.settle();h.dialog.onClose();await h.settle();assert.equal(h.app.key,key);assert.equal(h.app.initialSession.id,'guest-1');
});

test('registering during a guest visit retains the old app until success, then replaces its identity',async t=>{
  const response=deferred();const h=harness({restore:guest,response});t.after(()=>h.dispose());await h.settle();const key=h.app.key;h.app.onSignIn('en');await h.settle();h.welcome.onModeChange('register');await h.settle();h.welcome.onSubmit({username:'Alice',password:'long safe passphrase',import_legacy:false});await h.settle();h.dialog.onClose();await h.settle();assert.ok(h.dialog,'saving overlay cannot close');assert.equal(h.app.authBusy,true);assert.equal(h.app.key,key);
  response.resolve(account);await h.settle();assert.equal(h.dialog,undefined);assert.notEqual(h.app.key,key);assert.equal(h.app.accountName,'Alice');assert.equal(h.hash,'#about');
});

test('failed login keeps guest progress and offers a retry instead of pretending to log out',async t=>{
  const h=harness({restore:guest});h.options.response=()=>{throw new h.ApiError('invalid_credentials');};t.after(()=>h.dispose());await h.settle();const key=h.app.key;h.app.onSignIn('en');await h.settle();h.welcome.onSubmit({username:'Alice',password:'wrong',import_legacy:false});await h.settle();assert.match(h.welcome.error,/incorrect/);assert.equal(h.welcome.busy,false);assert.equal(h.app.key,key);assert.equal(h.identityChanges.length,0);
  h.options.response=account;h.welcome.onSubmit({username:'Alice',password:'correct long passphrase',import_legacy:false});await h.settle();assert.equal(h.app.accountName,'Alice');
});

test('boot network failure shows retry without erasing identity or offering an empty new session',async t=>{
  const options={restoreError:true};const h=harness(options);t.after(()=>h.dispose());await h.settle();assert.equal(h.welcome,undefined);assert.equal(h.app,undefined);assert.equal(h.guestTokens.length,0);assert.equal(h.identityChanges.length,0);assert.match(h.text,/重试/);options.restoreError=false;options.restore=account;h.find(n=>n.type==='button').props.onClick();await h.settle();assert.equal(h.app.accountName,'Alice');
});

test('session expiry removes the old app and cancels any pending account response',async t=>{
  const response=deferred();const h=harness({restore:guest,response});t.after(()=>h.dispose());await h.settle();h.app.onSignIn('en');await h.settle();h.welcome.onSubmit({username:'Alice',password:'long passphrase',import_legacy:false});await h.settle();h.expire();assert.equal(h.app,undefined);assert.equal(h.welcome.busy,false);assert.match(h.welcome.error,/ended/);response.resolve(account);await h.settle();assert.equal(h.app,undefined);
});

test('logout waits for server revocation and only then removes account identity',async t=>{
  const response=deferred();const h=harness({restore:account,response});t.after(()=>h.dispose());await h.settle();h.app.onSignOut('en');await h.settle();assert.equal(h.app.accountName,'Alice');assert.equal(h.app.authBusy,true);response.resolve(signedOut);await h.settle();assert.equal(h.app,undefined);assert.equal(h.welcome.mode,'login');assert.equal(h.guestTokens.at(-1),null);
});

test('a lost successful login response recovers only the intended account after the guest is revoked',async t=>{
  const h=harness({restore:guest,response:()=>{throw new TypeError('response lost');}});t.after(()=>h.dispose());await h.settle();h.options.readResponse=(_path,policy)=>{if(!policy?.guest)throw new h.ApiError('guest_expired');return account;};
  h.app.onSignIn('en');await h.settle();h.welcome.onSubmit({username:'ALICE',password:'long passphrase',import_legacy:false});await h.settle();assert.equal(h.app.accountName,'Alice');assert.equal(h.hash,'#about');assert.equal(h.dialog,undefined);assert.equal(h.requests.filter(r=>r.policy?.guest==='omit').length,1);
});

test('uncertain login never discards a valid guest or adopts an unrelated account cookie',async t=>{
  for(const state of [guest,{...account,user:{username:'SomebodyElse'}}]){const h=harness({restore:guest,response:()=>{throw new TypeError('offline');}});t.after(()=>h.dispose());await h.settle();const key=h.app.key;h.options.readResponse=(_path,policy)=>{if(state.mode==='account'&&!policy?.guest)throw new h.ApiError('guest_expired');return state;};h.app.onSignIn('en');await h.settle();h.welcome.onSubmit({username:'Alice',password:'long passphrase',import_legacy:false});await h.settle();assert.equal(h.app.key,key);assert.equal(h.app.accountName,null);assert.match(h.welcome.error,/could not connect/);if(state.mode==='guest')assert.equal(h.requests.filter(r=>r.policy?.guest==='omit').length,0);}
});

test('welcome document title and language follow locale after logout',async t=>{
  const h=harness({restore:account,response:signedOut});t.after(()=>h.dispose());await h.settle();h.app.onSignOut('en');await h.settle();assert.equal(h.title,'A little Shanghai · Sign in');assert.equal(h.documentLanguage,'en');h.welcome.onLocaleChange('zh');await h.settle();assert.equal(h.title,'沪语漫游 · 登录');assert.equal(h.documentLanguage,'zh-CN');
});


test('logout preserves the language currently displayed by App rather than its original account locale',async t=>{
  const h=harness({restore:account,response:signedOut});t.after(()=>h.dispose());await h.settle();h.app.onSignOut('zh');await h.settle();assert.equal(h.welcome.locale,'zh');assert.equal(h.title,'沪语漫游 · 登录');assert.equal(h.documentLanguage,'zh-CN');
});
