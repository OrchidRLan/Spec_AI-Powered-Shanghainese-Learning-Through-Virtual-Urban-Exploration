import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { transformWithOxc } from 'vite';

const source = (await Promise.all(['lib/authSession.ts', 'lib/api.ts'].map(async file => {
  const { code } = await transformWithOxc(await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8'), file, {});
  return code.replace(/^import\b[\s\S]*?;\n/gm, '').replace(/export (?=(?:async )?(?:function|const|class) )/g, '');
}))).join('\n');
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function runtime(fetch) {
  const data = new Map();
  const sessionStorage = { getItem: key=>data.get(key) || null, setItem: (key,value)=>data.set(key,value), removeItem:key=>data.delete(key), key:index=>[...data.keys()][index], get length(){return data.size;} };
  const auth = vm.runInNewContext(`${source}; ({authFetch, api, bindAuthSession, isolateAuthRequests, guestToken, setGuestToken, changeAuthIdentity, onAuthExpired, assertCurrentAuthResponse, ApiError});`, {fetch,sessionStorage,Headers,DOMException,AbortController});
  return {...auth, data};
}
const json = (value, status=200)=>new Response(JSON.stringify(value), {status,headers:{'Content-Type':'application/json'}});

test('JSON and WAV requests carry only this tab guest token and the caller headers', async()=>{
  const seen=[]; const r=runtime(async(path,options)=>{seen.push({path,options});return json({ok:true});});
  r.setGuestToken('tab-secret'); await r.api('/session'); await r.authFetch('/api/asr',{method:'POST',headers:{'Content-Type':'audio/wav','X-Request-ID':'one'},body:new Uint8Array([0])});
  assert.equal(seen.length,2); for(const {path,options} of seen){assert.equal(options.headers.get('X-Guest-Token'),'tab-secret');assert.ok(!path.includes('tab-secret'));assert.equal(options.credentials,'same-origin');}
  assert.equal(seen[0].options.headers.get('Content-Type'),'application/json'); assert.equal(seen[1].options.headers.get('Content-Type'),'audio/wav');
  assert.equal(seen[1].options.headers.get('X-Request-ID'),'one');
  r.setGuestToken(null); await r.api('/session'); assert.equal(seen[2].options.headers.has('X-Guest-Token'),false);
});

test('invalid login and network failures keep the current identity, genuine expiry clears it', async()=>{
  let response=json({detail:{code:'invalid_credentials'}},401); const r=runtime(async()=>response); let expired=0;r.onAuthExpired(()=>expired++);r.setGuestToken('guest');
  await assert.rejects(r.api('/auth/login'),e=>e.code==='invalid_credentials');assert.equal(expired,0);assert.equal(r.guestToken(),'guest');
  response=json({detail:{code:'guest_expired'}},401); await assert.rejects(r.api('/session'));assert.equal(expired,1);assert.equal(r.guestToken(),null);
  const offline=runtime(async()=>{throw new TypeError('offline');});offline.setGuestToken('still-here');let offlineExpired=0;offline.onAuthExpired(()=>offlineExpired++);
  await assert.rejects(offline.api('/session'));assert.equal(offlineExpired,0);assert.equal(offline.guestToken(),'still-here');
});

test('a delayed 401 from an old identity cannot clear the new identity', async()=>{
  const pending=deferred();const r=runtime(()=>pending.promise);let expired=0;r.onAuthExpired(()=>expired++);r.setGuestToken('old');const request=r.api('/session');
  r.changeAuthIdentity();r.setGuestToken('new');pending.resolve(json({detail:{code:'guest_expired'}},401));
  await assert.rejects(request,e=>e.name==='AbortError');assert.equal(expired,0);assert.equal(r.guestToken(),'new');
});

test('a response that finishes parsing after identity changes cannot publish its old data', async()=>{
  const body=deferred();const r=runtime(async()=>({ok:true,status:200,json:()=>body.promise}));const request=r.api('/session');
  await Promise.resolve();await Promise.resolve();r.changeAuthIdentity();body.resolve({id:'old-person'});
  await assert.rejects(request,e=>e.name==='AbortError');
});

test('identity changes abort pending uploads and remove local transcripts without removing display preferences', async()=>{
  let signal;const response=deferred();const r=runtime(async(_path,options)=>{signal=options.signal;return response.promise;});
  r.data.set('shanghai-practice-unapplied:one','old transcript');r.data.set('shanghai-lesson-pending:two','old receipt');r.data.set('display-only','en');
  const request=r.authFetch('/api/asr',{method:'POST'});r.changeAuthIdentity();assert.equal(signal.aborted,true);assert.equal(r.data.has('shanghai-practice-unapplied:one'),false);assert.equal(r.data.has('shanghai-lesson-pending:two'),false);assert.equal(r.data.get('display-only'),'en');
  response.resolve(json({text:'old voice'}));await assert.rejects(request,e=>e.name==='AbortError');
});

test('business JSON, WAV and protected audio bind to the rendered session while authentication stays unbound',async()=>{
  const seen=[];const r=runtime(async(path,options)=>{seen.push({path,headers:options.headers});return json({ok:true});});r.bindAuthSession('session-A');
  await r.api('/session');await r.authFetch('/api/asr',{method:'POST'});await r.authFetch('/api/attempts/a/introduction/audio');await r.api('/auth');await r.api('/auth/login',{method:'POST'});
  for(const request of seen.slice(0,3))assert.equal(request.headers.get('X-Expected-Session-ID'),'session-A');for(const request of seen.slice(3))assert.equal(request.headers.has('X-Expected-Session-ID'),false);
  r.changeAuthIdentity();await r.api('/session');assert.equal(seen.at(-1).headers.has('X-Expected-Session-ID'),false);
});

test('session_changed stops the old account view instead of accepting another tabs cookie',async()=>{
  const r=runtime(async()=>json({detail:{code:'session_changed'}},401));let expired=0;r.onAuthExpired(()=>expired++);r.bindAuthSession('session-A');await assert.rejects(r.api('/session'));assert.equal(expired,1);
});

test('read-only recovery can check a revoked guest and its account cookie without automatic identity changes',async()=>{
  const seen=[];const r=runtime(async(_path,options)=>{seen.push(options.headers.get('X-Guest-Token'));return options.headers.has('X-Guest-Token')?json({detail:{code:'guest_expired'}},401):json({mode:'account'});});r.setGuestToken('revoked');let expired=0;r.onAuthExpired(()=>expired++);
  await assert.rejects(r.api('/auth',undefined,{expire:false}),e=>e.code==='guest_expired');assert.equal(r.guestToken(),'revoked');assert.equal(expired,0);
  assert.equal((await r.api('/auth',undefined,{guest:'omit',expire:false})).mode,'account');assert.deepEqual(seen,['revoked',null]);assert.equal(expired,0);
});

test('starting an auth mutation isolates old requests without clearing guest progress or expected session',async()=>{
  const pending=deferred();let first=true;let logoutHeader;const r=runtime(async(path,options)=>{if(first){first=false;return pending.promise;}logoutHeader=options.headers.get('X-Expected-Session-ID');return json({ok:true});});
  r.setGuestToken('guest');r.bindAuthSession('guest-session');r.data.set('shanghai-practice-unapplied:one','kept');const old=r.api('/events',{method:'POST'});r.isolateAuthRequests();
  assert.equal(r.guestToken(),'guest');assert.equal(r.data.get('shanghai-practice-unapplied:one'),'kept');pending.resolve(json({detail:{code:'guest_expired'}},401));await assert.rejects(old,e=>e.name==='AbortError');
  await r.api('/auth/logout',{method:'POST'});assert.equal(logoutHeader,'guest-session');
});
