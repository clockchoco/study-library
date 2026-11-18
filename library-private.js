(function () {
  'use strict';

  const encoder = new TextEncoder();
  const isPublic = document.currentScript?.dataset.mode === 'public';
  const storageKey = 'clockchoco.library.private.v1.' + new URL('.', location.href).pathname;
  const blobPath = /^vault\/[0-9a-f]{2}\/[0-9a-f]{62}\.bin$/;
  const fragment = new URLSearchParams(location.hash.slice(1));
  const supplied = isPublic ? null : fragment.get('key');
  if (!isPublic && fragment.has('key')) {
    history.replaceState(null, '', location.pathname + location.search);
  }

  let openKey = null;
  let pairing = null;
  let opening = null;
  let manifestPromise = null;
  let configPromise = null;
  const imageCache = new Map();

  function parseCode(input) {
    let value = String(input || '').trim();
    if (value.includes('#')) {
      value = new URLSearchParams(value.slice(value.indexOf('#') + 1)).get('key') || '';
    }
    if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
    const bytes = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='), c => c.charCodeAt(0));
    const canonical = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return value === canonical ? {value, bytes} : null;
  }

  async function download(path) {
    if (!blobPath.test(path)) throw new Error('Unexpected encrypted file');
    const response = await fetch(path, {credentials: 'omit', referrerPolicy: 'no-referrer'});
    if (!response.ok) throw new Error('Download failed');
    return new Uint8Array(await response.arrayBuffer());
  }

  async function decrypt(key, path, ciphertext) {
    return crypto.subtle.decrypt({
      name: 'AES-GCM', iv: ciphertext.subarray(0, 12),
      additionalData: encoder.encode(path), tagLength: 128,
    }, key, ciphertext.subarray(12));
  }

  function readManifest() {
    if (!manifestPromise) manifestPromise = (async () => {
      const response = await fetch('library-bundle.json', {cache: 'no-cache', credentials: 'omit'});
      if (!response.ok) throw new Error('Manifest unavailable');
      const m = await response.json();
      if (m.version !== 1 || typeof m.sync !== 'string' || !blobPath.test(m.sync) ||
          !Array.isArray(m.catalogs) || m.catalogs.length !== (isPublic ? 0 : 2) ||
          !m.catalogs.every(path => typeof path === 'string' && blobPath.test(path))) {
        throw new Error('Invalid manifest');
      }
      return m;
    })().catch(error => { manifestPromise = null; throw error; });
    return manifestPromise;
  }

  function getConfigBlob() {
    if (!configPromise) configPromise = (async () => {
      const {sync} = await readManifest();
      return {path: sync, bytes: await download(sync)};
    })().catch(error => { configPromise = null; throw error; });
    return configPromise;
  }

  async function deriveKey(bytes) {
    const base = await crypto.subtle.importKey('raw', bytes, 'HKDF', false, ['deriveKey']);
    return crypto.subtle.deriveKey({
      name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('clockchoco.private-library.v1'),
      info: encoder.encode('content/aes-gcm'),
    }, base, {name: 'AES-GCM', length: 256}, false, ['decrypt']);
  }

  async function configFor(key) {
    const {path, bytes} = await getConfigBlob();
    const plaintext = await decrypt(key, path, bytes);
    const cfg = JSON.parse(new TextDecoder().decode(plaintext));
    if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(cfg.supabaseUrl) ||
        !/^sb_publishable_[A-Za-z0-9_-]+$/.test(cfg.supabaseAnonKey) ||
        !/^[a-z_][a-z0-9_]*$/.test(cfg.tableName)) {
      throw new Error('Invalid sync config');
    }
    return Object.freeze(cfg);
  }

  async function unlockSync(code) {
    const candidate = parseCode(code);
    if (!candidate) return false;
    const key = await deriveKey(candidate.bytes);
    try {
      window.PSAT_SYNC_CONFIG = await configFor(key);
      return true;
    } catch (error) {
      if (error.name === 'OperationError') return false;
      throw error;
    }
  }

  async function unlock(code, catalogs) {
    const candidate = parseCode(code);
    if (!candidate) return null;
    const key = await deriveKey(candidate.bytes);
    let sets;
    try {
      sets = await Promise.all(catalogs.map(async ({path, bytes}) => {
        const plaintext = await decrypt(key, path, bytes);
        const data = JSON.parse(new TextDecoder().decode(plaintext));
        if (!Array.isArray(data)) throw new Error('Invalid catalog');
        return data;
      }));
    } catch (error) {
      if (error.name === 'OperationError') return null;
      throw error;
    }
    window.PSAT_SYNC_CONFIG = await configFor(key);
    openKey = key;
    pairing = candidate.value;
    try { localStorage.setItem(storageKey, pairing); } catch { /* Unlock still works for this tab. */ }
    return sets;
  }

  function promptForCode(catalogs, rejected) {
    const main = document.querySelector('main');
    main.innerHTML = `<section class="panel"><h1>개인 문제서재</h1>
      <p class="key-note">이미 연결한 기기에서 ‘기기 연결’을 눌러 개인 링크를 복사한 뒤 여기에 붙여넣으세요.</p>
      <form class="private-unlock" style="margin-top:16px">
        <label for="private-link">개인 링크</label>
        <input id="private-link" type="password" autocomplete="off" spellcheck="false" required>
        <button class="primary" type="submit">문제서재 열기</button>
        <p role="status" class="key-note"></p>
      </form></section>`;
    const form = main.querySelector('form');
    const status = form.querySelector('[role="status"]');
    const input = form.querySelector('input');
    const button = form.querySelector('button');
    if (rejected) status.textContent = '이 문제서재의 개인 링크를 확인해 주세요.';
    return new Promise((resolve, reject) => {
      form.addEventListener('submit', async event => {
        event.preventDefault();
        if (button.disabled) return;
        button.disabled = true;
        try {
          const sets = await unlock(input.value, catalogs);
          if (sets) {
            input.value = '';
            resolve(sets);
          } else {
            status.textContent = '이 문제서재의 개인 링크를 확인해 주세요.';
            input.select();
          }
        } catch (error) { reject(error); }
        finally { button.disabled = false; }
      });
    });
  }

  async function open() {
    if (!globalThis.crypto?.subtle) throw new Error('Secure browser context required');
    const manifest = await readManifest();
    const catalogs = await Promise.all(manifest.catalogs.map(async path => ({path, bytes: await download(path)})));
    let saved = '';
    try { saved = localStorage.getItem(storageKey); } catch { /* Private link can be pasted again. */ }
    for (const code of new Set([supplied, saved].filter(Boolean))) {
      const sets = await unlock(code, catalogs);
      if (sets) return sets;
    }
    return promptForCode(catalogs, Boolean(supplied || saved));
  }

  function loadCatalogs() {
    if (!opening) opening = open().catch(error => { opening = null; throw error; });
    return opening;
  }

  function trimImages() {
    const active = new Set(Array.from(document.images, img => img.src));
    for (const [path, entry] of imageCache) {
      if (imageCache.size <= 24) break;
      if (!entry.url || active.has(entry.url)) continue;
      imageCache.delete(path);
      URL.revokeObjectURL(entry.url);
    }
  }

  function imageUrl(path) {
    if (!openKey) return Promise.reject(new Error('Library is locked'));
    const hit = imageCache.get(path);
    if (hit) {
      imageCache.delete(path);
      imageCache.set(path, hit);
      return hit.promise;
    }
    const entry = {url: null, promise: null};
    imageCache.set(path, entry);
    entry.promise = (async () => {
      const buffer = await decrypt(openKey, path, await download(path));
      const b = new Uint8Array(buffer);
      const mime = b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 ? 'image/png' :
        String.fromCharCode(...b.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...b.subarray(8, 12)) === 'WEBP' ?
        'image/webp' : '';
      if (!mime) throw new Error('Unsupported private image');
      entry.url = URL.createObjectURL(new Blob([buffer], {type: mime}));
      // Touch again on completion so an older slow response does not revoke its own URL before use.
      imageCache.delete(path);
      imageCache.set(path, entry);
      trimImages();
      return entry.url;
    })().catch(error => { imageCache.delete(path); throw error; });
    return entry.promise;
  }

  if (isPublic) window.LibrarySyncConfigGate = Object.freeze({unlock: unlockSync});
  else window.LibraryPrivate = Object.freeze({loadCatalogs, imageUrl, pairingCode: () => pairing});
})();
