(function () {
'use strict';

const registry = 'clockchoco.pair.v1.';
const storedCode = registry + 'code';
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const validKey = k => k === 'last' || k === 'scope' || /^item\.[\w.-]{1,128}$/.test(k);
const supported = () => Boolean(window.crypto?.subtle && window.crypto?.getRandomValues);
let hooks, active, pairing = false, state = 'local', timer, running, failures = 0, lastClock = 0;
let intervalsInstalled = false;
const temporary = new Map();

function encode(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 16384) {
    text += String.fromCharCode(...bytes.subarray(i, i + 16384));
  }
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function decode(text) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]+$/.test(text)) throw new Error('올바르지 않은 연결 데이터입니다.');
  const raw = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}
function random(length) {
  return encode(crypto.getRandomValues(new Uint8Array(length)));
}
function snapshot() {
  const s = hooks.snapshot();
  return s instanceof Map ? Object.fromEntries(s) : s;
}
function status(next) {
  state = next;
  hooks?.onStatus?.(state);
}
function code() {
  if (active) return active.code;
  try { return localStorage.getItem(storedCode); } catch { return null; }
}
function storageGet(k) {
  try { return localStorage.getItem(k); } catch { return null; }
}
function storageSet(k, value) {
  try { localStorage.setItem(k, value); return true; } catch { return false; }
}
function validateCode(value) {
  if (!supported()) throw new Error('기기 연결은 HTTPS 또는 이 컴퓨터의 로컬 주소에서 사용할 수 있습니다.');
  const key = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(key) || encode(decode(key)) !== key) throw new Error('연결 코드를 다시 확인해 주세요.');
  return key;
}
async function prepare(value) {
  const cfg = window.PSAT_SYNC_CONFIG;
  if (!cfg?.supabaseUrl || !cfg?.supabaseAnonKey) throw new Error('서버 연결 설정을 확인해 주세요.');
  const baseKey = await crypto.subtle.importKey('raw', decode(value), 'HKDF', false, ['deriveBits','deriveKey']);
  const parameters = purpose => ({
    name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('clockchoco.library.sync.v1'), info: encoder.encode(purpose)
  });
  const [profile, key] = await Promise.all([
    crypto.subtle.deriveBits(parameters('profile-lookup'), baseKey, 256),
    crypto.subtle.deriveKey(parameters('progress-encryption'), baseKey, {name:'AES-GCM',length:256}, false, ['encrypt','decrypt'])
  ]);
  const row = 'library-v1-' + encode(new Uint8Array(profile));
  const endpoint = new URL('/rest/v1/' + encodeURIComponent(cfg.tableName || 'psat_progress'), cfg.supabaseUrl);
  if (endpoint.protocol !== 'https:') throw new Error('동기화 서버에는 HTTPS 주소가 필요합니다.');
  return {
    code:value, row, key, endpoint, apiKey:cfg.supabaseAnonKey,
    prefix:registry + row + '.', allowCreate:false, doc:null, clock:0, lastWrites:new Map()
  };
}
async function request(c, url, method = 'GET', body) {
  const headers = {apikey:c.apiKey, Accept:'application/json'};
  if (c.apiKey.startsWith('eyJ')) headers.Authorization = 'Bearer ' + c.apiKey;
  if (body) Object.assign(headers, {'Content-Type':'application/json', Prefer:'return=representation'});
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 15000);
  try {
    const content = body ? JSON.stringify(body) : undefined;
    const response = await fetch(url, {
      method, headers, body:content, keepalive:document.hidden && (!content || content.length<58000),
      cache:'no-store', credentials:'omit', referrerPolicy:'no-referrer', signal:abort.signal
    });
    if (!response.ok) {
      const e = new Error('저장 서버가 요청을 처리하지 못했습니다.');
      e.httpStatus = response.status;
      throw e;
    }
    return await response.json();
  } finally { clearTimeout(timeout); }
}
function api(c, select, filter = true) {
  const url = new URL(c.endpoint);
  url.searchParams.set('select', select);
  if (filter) url.searchParams.set('profile_id', 'eq.' + c.row);
  return url;
}
function aad(c, rev) {
  return encoder.encode(c.row + '/' + rev);
}
async function pack(c, doc) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad(c,doc.rev)}, c.key,
    encoder.encode(JSON.stringify([doc.n, doc.fields])));
  return {v:1, rev:doc.rev, iv:encode(iv), encrypted:encode(new Uint8Array(cipher))};
}
async function unpack(c, value) {
  try {
    if (value.v !== 1 || !/^[A-Za-z0-9_-]{22}$/.test(value.rev)) throw new Error();
    const bytes = await crypto.subtle.decrypt({
      name:'AES-GCM',iv:decode(value.iv),additionalData:aad(c,value.rev)
    }, c.key, decode(value.encrypted));
    const [n, fields] = JSON.parse(decoder.decode(bytes));
    if (!Number.isSafeInteger(n) || n < 1 || !fields || Array.isArray(fields) || typeof fields !== 'object') throw new Error();
    for (const [key, cell] of Object.entries(fields)) {
      if (!validKey(key) || !Array.isArray(cell) || cell.length !== 3 || typeof cell[1] !== 'string' ||
          !Number.isSafeInteger(cell[2]) || cell[2] < 1 || cell[2] > n) throw new Error();
    }
    return {n,fields,rev:value.rev};
  } catch {
    const e = new Error('서버 기록을 확인할 수 없습니다. 이 기기의 변경을 보관합니다.');
    e.integrity = true;
    throw e;
  }
}
async function fetchDocument(c, allowCached) {
  if (allowCached && c.doc) {
    const meta = await request(c,api(c,'revision:answers->>rev'));
    if (meta[0]?.revision === c.doc.rev) return c.doc;
    if (!meta.length) return null;
  }
  const data = await request(c,api(c,'answers'));
  return data.length ? unpack(c,data[0].answers) : null;
}
function newId(c) {
  c.clock = Math.max(c.clock + 1, Date.now(), lastClock + 1);
  lastClock = c.clock;
  return c.clock.toString(36).padStart(10,'0') + '-' + random(9);
}
function pending(c) {
  const prefix = c.prefix + 'op.';
  const result = new Map();
  try {
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith(prefix)) continue;
      const text = localStorage.getItem(key);
      if (text) result.set(key, JSON.parse(text));
    }
  } catch { /* In-memory edits are still eligible for upload. */ }
  for (const [key,op] of temporary) if (key.startsWith(prefix)) result.set(key,op);
  return Array.from(result,([storageKey,op]) => ({storageKey,op})).sort((a,b) =>
    a.op.id < b.op.id ? -1 : a.op.id > b.op.id ? 1 : 0);
}
function enqueue(c, op) {
  op.id = newId(c);
  op.base = c.doc?.n || Number(storageGet(c.prefix+'seen') || 0);
  const storageKey = c.prefix+'op.'+op.id;
  if (!storageSet(storageKey, JSON.stringify(op))) temporary.set(storageKey,op);
  return op.id;
}
function acknowledge(batch) {
  for (const {storageKey} of batch) {
    temporary.delete(storageKey);
    try { localStorage.removeItem(storageKey); } catch { /* Retry duplicates are idempotent. */ }
  }
}
function acceptsCell(previous, value, op, version, seeded) {
  if (previous) {
    if (seeded || previous[1] === op.id) return false;
    if (previous[2] > op.base && previous[2] !== version) {
      if (previous[0] === null && value !== null && op.after !== previous[1] && op.afterReset !== previous[1]) return false;
      if (previous[0] !== null && value !== null && previous[1] > op.id && op.after !== previous[1]) return false;
      if (previous[0] === null && value === null && previous[1] > op.id) return false;
    }
  }
  return true;
}
function setCell(fields, key, value, op, version, seeded = false) {
  const previous = fields[key];
  const accepted = acceptsCell(previous, value, op, version, seeded);
  const cell = accepted ? [value,op.id,version] : previous;
  // Concurrent edits choose one answer, but either device may have solved it more recently.
  // A deletion still clears the entire record, including its solve date.
  if (key.startsWith('item.') && previous?.[0] && value) {
    const other = accepted ? previous[0] : value;
    if (other.lastSolvedDay > (cell[0].lastSolvedDay || '')) {
      fields[key] = [{...cell[0], lastSolvedDay: other.lastSolvedDay}, cell[1], cell[2]];
      return true;
    }
  }
  if (accepted) fields[key] = cell;
  return accepted;
}
function merge(c, doc, batch) {
  const fields = {...(doc?.fields || {})}, version = (doc?.n || 0)+1;
  let changed = !doc;
  for (const {op} of batch) {
    if (op.kind === 'seed') {
      for (const [key,value] of Object.entries(op.values)) {
        if (validKey(key) && value !== null && setCell(fields,key,value,op,version,true)) changed = true;
      }
    } else if (op.kind === 'reset') {
      const keys = new Set(op.keys);
      if (typeof fields.last?.[0] === 'string' && keys.has('item.'+fields.last[0])) keys.add('last');
      for (const key of keys) if (validKey(key) && setCell(fields,key,null,op,version)) changed = true;
    } else if (op.kind === 'set' && validKey(op.key)) {
      if (setCell(fields,op.key,op.value,op,version)) changed = true;
    }
  }
  return changed ? {n:version, rev:random(16),fields} : doc;
}
async function commit(c, oldDoc, doc) {
  const packed = await pack(c,doc);
  const fields = {answers:packed, updated_at:new Date().toISOString()};
  if (!oldDoc) {
    try { await request(c,api(c,'profile_id',false),'POST',{profile_id:c.row,...fields}); }
    catch (e) { if (e.httpStatus === 409) return false; throw e; }
    return true;
  }
  const url = api(c,'profile_id');
  url.searchParams.set('answers->>rev','eq.'+oldDoc.rev);
  const updated = await request(c,url,'PATCH',fields);
  return updated.length === 1;
}
function apply(c, doc) {
  const dirty = new Set();
  for (const {op} of pending(c)) {
    if (op.kind === 'set') dirty.add(op.key);
    if (op.kind === 'reset') for (const k of op.keys) dirty.add(k);
  }
  const values = snapshot(), changes = Object.create(null);
  for (const [key,[value]] of Object.entries(doc.fields)) {
    if (dirty.has(key)) continue;
    if (value === null ? own(values,key) : JSON.stringify(value) !== JSON.stringify(values[key])) changes[key] = value;
  }
  if (Object.keys(changes).length) hooks.onApply(changes);
  c.doc = doc;
  storageSet(c.prefix+'seen',String(doc.n));
}
function plan(delay) {
  clearTimeout(timer);
  if (active) timer=setTimeout(() => {void flush();}, delay);
}
async function synchronize(c) {
  status('syncing');
  for (let round=0; round<5; round++) {
    // A CAS protects a cached revision, so an edit need not wait for a preliminary read.
    const old = round === 0 && c.doc && pending(c).length ? c.doc : await fetchDocument(c,round===0);
    if (!old && !c.allowCreate) throw new Error('연결한 서버 기록이 없습니다.');
    if (old && old.n < Number(storageGet(c.prefix+'seen') || 0)) {
      // Other tabs can legitimately advance the cached version while this tab is inactive.
      if (old === c.doc && round === 0) continue;
      const e = new Error('서버에 더 오래된 기록이 있습니다.');
      e.integrity = true;
      throw e;
    }
    const batch = pending(c);
    const doc = batch.length || !old ? merge(c, old, batch) : old;
    if (doc !== old && !await commit(c,old,doc)) continue;
    acknowledge(batch);
    if (active !== c) return false;
    if (c.allowCreate) {
      c.allowCreate=false;
      storageSet(c.prefix+'ready','1');
    }
    if (c.doc !== doc || batch.length) apply(c,doc);
    failures=0;
    const more = pending(c).length>0;
    status(more?'syncing':'synced');
    if (more) plan(150);
    return true;
  }
  throw new Error('다른 기기의 저장을 기다리고 있습니다.');
}
function flush() {
  if (!active) return Promise.resolve(false);
  if (running) return running;
  clearTimeout(timer);
  const c=active;
  running = synchronize(c).catch(e => {
    if (active !== c) return false;
    failures++;
    status(e.integrity || (e.httpStatus && ![408,429].includes(e.httpStatus) && e.httpStatus<500) ? 'error' : 'offline');
    plan(Math.min(60000, 1000 * 2 ** Math.min(failures,6)));
    return false;
  }).finally(() => {running=null;});
  return running;
}
function keepAlive() {
  if (intervalsInstalled) return;
  intervalsInstalled=true;
  window.addEventListener('online', () => { if(active) plan(0); });
  window.addEventListener('focus', () => { if(active) plan(50); });
  document.addEventListener('visibilitychange', () => {
    if (!active) return;
    if (document.hidden) void flush();
    else plan(50);
  });
  window.addEventListener('pagehide', () => { if(active) void flush(); });
  window.addEventListener('storage', e => {
    if(active && e.key?.startsWith(active.prefix+'op.') && e.newValue) plan(250);
    if(!active && e.key === storedCode && e.newValue) restore().catch(() => status('error'));
  });
  setInterval(() => { if(active && !document.hidden && !running) void flush(); }, 30000);
}
async function restore() {
  const saved = validateCode(code());
  const c = await prepare(saved);
  c.allowCreate = storageGet(c.prefix+'ready') !== '1';
  seedIfNeeded(c);
  active=c;
  await flush();
}
function start(callbacks) {
  hooks=callbacks;
  keepAlive();
  if (code()) return restore().catch(() => status('error'));
  status('local');
  return Promise.resolve();
}
function seedIfNeeded(c) {
  if (storageGet(c.prefix+'seeded')) return;
  const initial=snapshot();
  if (Object.keys(initial).length) {
    const id=enqueue(c,{kind:'seed',values:initial});
    if (!storageGet(c.prefix+'op.'+id)) return;
  }
  storageSet(c.prefix+'seeded','1');
}
async function connect(value, options={}) {
  if (!hooks) throw new Error('문제집을 불러온 뒤 연결해 주세요.');
  value=validateCode(value);
  if (active?.code === value) { await flush(); return; }
  if (pairing) throw new Error('기기 연결을 진행하고 있습니다.');
  if (code() && code() !== value) throw new Error('이 브라우저는 다른 연결 코드에 연결되어 있습니다.');
  pairing = true;
  status('connecting');
  try {
    const c=await prepare(value);
    if (!options.createIfMissing) {
      const existing=await fetchDocument(c,false);
      if (!existing) throw new Error('서버에서 이 연결 코드를 찾지 못했습니다.');
      // The confirmed initial read is repeated by the CAS loop before any mutation.
      c.allowCreate=false;
      storageSet(c.prefix+'ready','1');
    } else {
      c.allowCreate = storageGet(c.prefix+'ready') !== '1';
    }
    seedIfNeeded(c);
    active=c;
    storageSet(storedCode,value);
    await flush();
  } catch(e) {
    if (!active) status('local');
    throw e;
  } finally {pairing=false;}
}
async function create() {
  if (code()) { await connect(code(),{createIfMissing:true}); return code(); }
  if (!supported()) throw new Error('이 브라우저는 안전한 기기 연결을 지원하지 않습니다.');
  const value=random(32);
  await connect(value,{createIfMissing:true});
  return value;
}
function record(key,value) {
  if (!active || !validKey(key)) return;
  const c=active, op={kind:'set', key, value}, prior=c.lastWrites.get(key);
  // Chain a re-answer to the reset it follows, including while a request is in flight.
  if (c.lastLocalReset?.keys.has(key)) op.afterReset=c.lastLocalReset.id;
  if (prior) op.after=prior;
  const id=enqueue(c,op);
  c.lastWrites.set(key,id);
  if (prior && (storageGet(c.prefix+'op.'+id) || temporary.has(c.prefix+'op.'+prior))) {
    acknowledge([{storageKey:c.prefix+'op.'+prior}]);
  }
  status('syncing'); plan(450);
}
function reset(keys) {
  if (!active) return;
  const items=[...new Set(keys)].filter(validKey);
  if (!items.length) return;
  const id=enqueue(active,{kind:'reset',keys:items});
  active.lastLocalReset={id,keys:new Set(items)};
  status('syncing'); plan(50);
}
window.LibrarySync = Object.freeze({start, connect, create, code, record, reset, flush, status:()=>state});
})();
