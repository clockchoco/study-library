'use strict';
const main = document.querySelector('main'), dialog = document.querySelector('dialog');
const number = new Intl.NumberFormat('ko-KR'), fmt = n => number.format(n);
const esc = value =>
    String(value ?? '')
        .replace(
            /[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;'}[c]));
const prefix = 'clockchoco.library.v1.', entry = prefix + 'item.';
const emptyScope = () => ({group: '', category: '', topic: '', subtopic: ''});
const questions = [], byId = new Map(), records = new Map();
const order = [
  '언어논리', '자료해석', '상황판단', '컴퓨터구조', '운영체제', '자료구조', '알고리즘', '프로그래밍언어',
  '데이터베이스', '소프트웨어공학', '네트워크', '정보보호', '인공지능·데이터분석', '최신IT·정보시스템'
];
const glyphs = ['Aa', '▥', '◇', '⌘', '⊞', '⌬', 'ƒ', '{ }', '▤', '⎔', '◎', '◈', '✧', '▦'];
const stateNames = {
  empty: '미풀이',
  right: '정답',
  wrong: '오답',
  pending: '채점 대기'
};
const rangeFields = Object.keys(emptyScope());
let study = emptyScope(), draft = emptyScope(), tab = 'PSAT';
let expandedPath = [], pendingReset = null;
let current, pool = [], index = 0, listPage = 0, listStatus = '', listed = [];
let editing = false, memoryOnly = false, toastTimer;
let syncState = 'local';
let syncReady = false;
let deferredView = false;
let deferredCursor = false;
const codePattern = /^[A-Za-z0-9_-]{43}$/;
const incomingPair = /^#pair=([A-Za-z0-9_-]{43})$/.exec(location.hash)?.[1];
if (incomingPair) history.replaceState(null, '', location.pathname + location.search);
const syncLabels = {
  local: '이 기기에 저장', connecting: '기기 연결 중', syncing: '진도 동기화 중',
  synced: '기기 동기화 완료', offline: '연결되면 동기화', error: '동기화 확인 필요'
};
const percent = (a, b) => b ? Number((a / b * 100).toFixed(2)) : 0;
const scopeName = s => s.subtopic || s.topic || s.category || s.group || '전체 문제';
const compareRangeNames = new Intl.Collator('ko-KR', {numeric: true}).compare;
function rangeNames(items, field) {
  const names = [...new Set(items.map(q => q[field]).filter(Boolean))];
  // A question moved from another subject should not determine a chapter's position in the menu.
  return field === 'topic' || field === 'subtopic' ? names.sort(compareRangeNames) : names;
}
const filtered = s => questions.filter(q => Object.keys(s).every(k => !s[k] || q[k] === s[k]));
const getLast = () => byId.get(read(prefix + 'last', null)) || questions[0];
function read(k, fallback) {
  try {
    return JSON.parse(localStorage.getItem(k)) ?? fallback;
  } catch {
    return fallback;
  }
}
function persist(k, v, sync = true) {
  try {
    if (v === null)
      localStorage.removeItem(k);
    else
      localStorage.setItem(k, JSON.stringify(v));
  } catch {
    memoryOnly = true;
    toast('저장 공간을 사용할 수 없어 현재 탭에서만 기록됩니다.');
  }
  if (sync && syncReady) window.LibrarySync.record(k.slice(prefix.length), v);
}
function hydrate() {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(entry) && byId.has(k.slice(entry.length))) {
        const r = read(k, null);
        if (r && typeof r === 'object')
          records.set(k.slice(entry.length), r);
      }
    }
  } catch {
    memoryOnly = true;
  }
}
const koreaOffsetMs = 9 * 60 * 60 * 1000;
const dayMs = 24 * 60 * 60 * 1000;
function currentStudyDay() {
  return new Date(Date.now() + koreaOffsetMs).toISOString().slice(0, 10);
}
function save(answer, {draft = false} = {}) {
  const day = draft ? records.get(current.id)?.lastSolvedDay : currentStudyDay();
  const record = day ? {...answer, lastSolvedDay: day} : answer;
  records.set(current.id, record);
  persist(entry + current.id, record);
}
function deviceSnapshot() {
  const result = {};
  for (const [id, value] of records) result['item.' + id] = value;
  for (const key of ['last', 'scope']) {
    const value = read(prefix + key, null);
    if (value !== null) result[key] = value;
  }
  return result;
}
function applyDeviceChanges(changes) {
  for (const [key, value] of Object.entries(changes)) {
    if (key.startsWith('item.')) {
      const id = key.slice(5);
      if (!byId.has(id)) continue;
      if (value === null) records.delete(id);
      else records.set(id, value);
    } else if (key === 'scope') {
      study = {...emptyScope(), ...value};
    } else if (key !== 'last') continue;
    persist(prefix + key, value, false);
  }
  deferredView = true;
  if ('last' in changes) deferredCursor = true;
  refreshDeviceView();
}
function refreshDeviceView() {
  if (!deferredView) return;
  if (dialog.open || document.activeElement?.id === 'written') {
    refreshTodayCounts();
    return;
  }
  deferredView = false;
  if (location.hash.startsWith('#solve') && deferredCursor) {
    const question = getLast();
    history.replaceState(null, '', '#solve/' + encodeURIComponent(question.id));
  }
  deferredCursor = false;
  render(false);
}
function setSyncState(status) {
  syncState = status;
  for (const tag of document.querySelectorAll('[data-sync-label]'))
    tag.textContent = syncLabels[status] || syncLabels.error;
}
function state(q) {
  const r = records.get(q.id);
  if (!r)
    return 'empty';
  if (r.pick && q.answer?.length)
    return q.answer.includes(r.pick) ? 'right' : 'wrong';
  return ['right', 'wrong'].includes(r.manual) ? r.manual : 'pending';
}
function stats(items) {
  const s = {right: 0, wrong: 0, pending: 0, empty: 0, today: 0, total: items.length};
  const day = currentStudyDay();
  for (const q of items) {
    s[state(q)]++;
    if (records.get(q.id)?.lastSolvedDay === day) s.today++;
  }
  s.done = s.total - s.empty;
  return s;
}
function toast(s) {
  const el = document.querySelector('#toast');
  el.textContent = s;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 4000);
}
function options(values, sel, all) {
  return `<option value="">${all}</option>` +
      values.map(v => `<option value="${esc(v)}" ${v === sel ? 'selected' : ''}>${esc(v)}</option>`).join('');
}
function rangeLabels(group) {
  return {group: '문제집', category: '과목', topic: group === '전공' ? '단원' : '유형',
          subtopic: group === '전공' ? '세부 주제' : '세부 유형'};
}
function filters(s) {
  let part = questions;
  const labels = rangeLabels(s.group);
  const fields = rangeFields.map(k => {
    const label = labels[k], values = rangeNames(part, k);
    if (!values.length || (k === 'topic' && !s.category) || (k === 'subtopic' && !s.topic))
      return '';
    if (s[k]) part = part.filter(q => q[k] === s[k]);
    return `<label>${label}<select data-field="${k}">${options(values, s[k], '모든 ' + label)}</select></label>`;
  });
  return `<div class="filters">${fields.join('')}</div>`;
}
function changeField(s, k, value) {
  const keys = Object.keys(emptyScope());
  s[k] = value;
  for (const field of keys.slice(keys.indexOf(k) + 1)) s[field] = '';
  if (k === 'category' && value)
    s.group = questions.find(q => q.category === value)?.group || s.group;
}
function meter(s) {
  return `<div class="bar" aria-hidden="true"><i style="width:${
      s.total ? s.done / s.total * 100 : 0}%"></i></div>`;
}
const studyDateFormat = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul', year: 'numeric', month: 'long', day: 'numeric', weekday: 'short'
});
const todayText = count => `오늘 ${fmt(count)}문항`;
function todayCount(s, scope) {
  return `<span data-today="${scope}" title="한국 시간 기준 오늘 푼 문제 수">${todayText(s.today)}</span>`;
}
function scopeCounts(s, scope) {
  return `<span class="scope-counts">${todayCount(s, scope)}<span>누적 ${fmt(s.done)} / ${fmt(s.total)}문항</span></span>`;
}
function refreshTodayCounts() {
  const date = main.querySelector('.date');
  if (date) date.textContent = studyDateFormat.format(new Date());
  for (const count of document.querySelectorAll('[data-today]')) {
    let items;
    switch (count.dataset.today) {
      case 'all': items = questions; break;
      case 'group': items = filtered({group: tab}); break;
      case 'study': items = pool; break;
      case 'draft': items = filtered(draft); break;
      case 'range':
        items = filtered(scopeForPath(JSON.parse(count.closest('.range-row').dataset.path)));
        break;
    }
    count.textContent = todayText(stats(items).today);
  }
}
function metrics(s, rateLabel) {
  return `<div class="metrics">${
          [[rateLabel, percent(s.done, s.total), '%', '◎', 'sage'],
           ['풀이 기록', fmt(s.done), '문항', '▤', 'blue'], ['정답', fmt(s.right), '문항', '✓', 'sage'],
           ['오답', fmt(s.wrong), '문항', '×', 'clay']]
              .map(
                  ([label, n, u, icon, c]) => `<div class="metric"><span>${label}</span><i class="${
                      c}" aria-hidden="true">${icon}</i><strong>${n}<small>${u}</small></strong></div>`)
              .join('')}</div>`;
}
function sheetArt() {
  return `<div class="sheet-art" aria-hidden="true"><div class="art-grid"></div><div class="back-sheet"></div><div class="front-sheet"><div class="sheet-edge"><b>Q.</b><i></i></div><div class="ink s1"></div><div class="ink s2"></div><div class="ink s3"></div><div class="sheet-answers"><span>1</span><span>2</span><span>3</span><span>4</span></div></div><div class="pencil"></div></div>`;
}
function scopeForPath(path) {
  const result = emptyScope();
  path.forEach((name, index) => { result[rangeFields[index]] = name; });
  return result;
}
function rangeRows(items, parentPath) {
  const field = rangeFields[parentPath.length];
  const labels = rangeLabels(parentPath[0]);
  return rangeNames(items, field).map(name => {
    const path = [...parentPath, name];
    const members = items.filter(q => q[field] === name);
    const s = stats(members);
    const childField = rangeFields[path.length];
    const children = childField ? rangeNames(members, childField) : [];
    const open = children.length > 0 && path.every((part, index) => expandedPath[index] === part);
    const counts = [`정답 ${fmt(s.right)}`, `오답 ${fmt(s.wrong)}`];
    if (s.pending) counts.push(`채점 대기 ${fmt(s.pending)}`);
    if (children.length) counts.unshift(`${fmt(children.length)}개 ${labels[childField]}`);
    const markIndex = order.indexOf(name);
    const mark = path.length === 2 && markIndex >= 0
      ? `<span class="subject-mark ${['sage','blue','clay','plum','wheat'][markIndex % 5]}" aria-hidden="true">${esc(glyphs[markIndex])}</span>` : '';
    const label = `${mark}<span class="range-title"><strong>${esc(name)}</strong><small>${counts.join(' · ')}</small></span>`;
    return `<div class="range-row" data-path="${esc(JSON.stringify(path))}" data-depth="${path.length - 2}">
      ${children.length ? `<button class="range-label" data-expand-range aria-expanded="${open}" aria-label="${esc(name)} ${labels[childField]} ${open ? '접기' : '보기'}">${label}<span class="range-chevron" aria-hidden="true">${open ? '▾' : '▸'}</span></button>` : `<div class="range-label">${label}</div>`}
      <div class="range-progress">${scopeCounts(s, 'range')}${meter(s)}</div>
      <div class="range-actions"><button class="soft" data-start-range aria-label="${esc(name)} 풀기">풀기</button>
        <button class="range-reset" data-reset="range" aria-label="${esc(name)} 기록 초기화" ${s.done ? '' : 'disabled'}>초기화</button></div>
    </div>${open ? rangeRows(members, path) : ''}`;
  }).join('');
}
function rangeLibrary() {
  const items = filtered({group: tab}), s = stats(items);
  const tabs = rangeNames(questions, 'group').map(name =>
    `<button data-group="${esc(name)}" aria-pressed="${name === tab}">${esc(name)}</button>`).join('');
  return `<div class="section-title"><h2 id="library-heading">과목별 문제집</h2></div>
    <div class="library-toolbar"><div class="tabs" aria-label="문제집 선택">${tabs}</div>
    <div class="range-heading-actions">${scopeCounts(s, 'group')}
    <button class="range-reset" data-reset="group" ${s.done ? '' : 'disabled'}>${esc(tab)} 초기화</button></div></div>
    <div class="range-list">${rangeRows(items, [tab])}</div>`;
}
function home() {
  const q = getLast(), visited = byId.has(read(prefix + 'last', null)), s = stats(questions);
  const date = studyDateFormat.format(new Date());
  main.innerHTML = `<div class="title-row"><h1>학습 홈</h1><span class="date">${esc(date)}</span></div>
    <section class="hero"><div class="hero-text"><p class="eyeline"><i></i>${visited ? '최근 학습한 문제' : '첫 번째 문제'}</p>
      <h2>${esc(q.category)}<span> / </span>${esc(q.topic || q.exam)}</h2>
      <p class="hero-meta">${esc(q.exam)} · ${esc(q.number)}번</p>
      <button class="light-btn" data-act="resume">${visited ? '이어서 풀기' : '학습 시작하기'} <span>→</span></button></div>${sheetArt()}</section>
    <section id="home-progress" aria-labelledby="home-progress-title"><div class="section-title">
      <div class="progress-heading"><h2 id="home-progress-title">전체 학습 현황</h2>${todayCount(s, 'all')}</div>
      <button class="range-reset" data-reset="all" ${s.done ? '' : 'disabled'}>전체 기록 초기화</button></div>
      ${metrics(s, '전체 진도')}</section>
    <section id="range-library" aria-labelledby="library-heading">${rangeLibrary()}</section>`;
}
// Reader
function go(q) {
  if (!q)
    return;
  const dest = '#solve/' + encodeURIComponent(q.id);
  if (location.hash === dest)
    render();
  else
    location.hash = dest;
}
function setStudy(s, remember = true) {
  study = {...emptyScope(), ...s};
  if (remember) persist(prefix + 'scope', study);
}
function startScope(s) {
  setStudy(s);
  const items = filtered(s);
  go(items.find(q => q.id === getLast().id) || items.find(q => state(q) === 'empty') || items[0]);
}
function answerArea(q) {
  const r = records.get(q.id), known = Boolean(q.answer?.length), locked = Boolean(r) && !editing && known;
  const choices = q.choices ?? 5, result = state(q);
  const feedback = r && !editing ?
      `<div role="status" class="feedback ${result}"><strong>${
          {right: '정답입니다', wrong: '오답입니다', pending: '답안을 기록했습니다'}[result]}</strong><span>${
          known                    ? '정답 ' + q.answer.map(v => v + '번').join(' · ') :
              result === 'pending' ? '채점 대기' :
                                     '직접 채점한 결과'}</span></div>` :
      '';
  return `<div class="answer-top"><h2>${choices ? '답안 선택' : '서술형 답안'}</h2>${
      locked ? '<button class="text-btn" data-act="retry">다시 풀기</button>' : ''}</div>
  ${
      choices ?
          `<div class="choices">${
              Array
                  .from(
                      {length: choices},
                      (_, i) => {
                        const v = i + 1, picked = !editing && r?.pick === v;
                        const cls = locked && q.answer.includes(v) ? 'right' :
                            picked                                 ? (locked ? 'wrong' : 'selected') :
                                                                     '';
                        return `<button data-choice="${v}" class="${cls}" aria-label="${
                            v}번 선택" aria-pressed="${!!picked}" ${locked ? 'disabled' : ''}><b>${
                            v}</b>번</button>`;
                      })
                  .join('')}</div>` :
          `<label class="written-label" for="written">내 답안</label><textarea id="written" rows="3" placeholder="답안을 입력하세요.">${
              esc(r?.text || '')}</textarea>`}
  ${feedback}${
      !known ?
          `<p class="key-note">${
              choices ?
                  '확인된 정답표가 없어 선택한 답을 기록합니다. 정오를 알고 있다면 직접 채점할 수 있습니다.' :
                  '입력한 답안은 자동 저장됩니다. 풀이를 마치면 직접 채점할 수 있습니다.'}</p><div class="manual">${
              choices ?
                  '' :
                  '<button class="soft" data-act="written">답안 저장</button>'}<button class="soft" data-manual="right">정답으로 기록</button><button class="soft" data-manual="wrong">오답으로 기록</button></div>` :
          ''}
  ${q.answerNote ? `<p class="key-note">${esc(q.answerNote)}</p>` : ''}`;
}
function solve(remember = true) {
  let id;
  try {
    id = decodeURIComponent(location.hash.slice(7));
  } catch {
    id = '';
  }
  current = byId.get(id) || getLast();
  if (!study.category && !study.group && !read(prefix + 'scope', null))
    setStudy({group: current.group, category: current.category}, remember);
  pool = filtered(study);
  if (!pool.includes(current)) {
    const next = {group: current.group, category: current.category};
    const resuming = current.id === read(prefix + 'last', null);
    if (resuming && study.topic) {
      next.topic = current.topic;
      // The original PSAT catalog combined the type and subtype in one topic label.
      if (study.subtopic || (study.group === 'PSAT' && study.topic.includes(' · ')))
        next.subtopic = current.subtopic || '';
    }
    setStudy(next, remember || resuming);
    pool = filtered(study);
  }
  index = pool.indexOf(current);
  if (location.hash === '#solve' || location.hash === '#solve/')
    history.replaceState(null, '', '#solve/' + encodeURIComponent(current.id));
  if (remember && read(prefix + 'last', null) !== current.id)
    persist(prefix + 'last', current.id);
  const q = current, s = stats(pool);
  main.innerHTML =
      `<div class="title-row"><h1>문제 풀기</h1><button class="soft" data-act="filter">문제집 선택 ⌄</button></div><div class="reader-layout">
  <aside class="reader-aside"><span class="label">선택한 문제집</span><h2>${
          esc(scopeName(study))}</h2><div class="aside-stats"><b>${percent(s.done, s.total)}%</b>${
          scopeCounts(s, 'study')}</div>${
          meter(s)}<div class="aside-nav"><button class="soft" data-act="prev" aria-label="이전 문제" ${
          index <= 0 ?
              'disabled' :
              ''}>←</button><button class="soft" data-act="list">문제 목록</button><button class="soft" data-act="next" aria-label="다음 문제" ${
          index + 1 >= pool.length ? 'disabled' : ''}>→</button></div>
          <button class="range-reset reader-range-reset" data-reset="study" ${s.done ? '' : 'disabled'}>현재 범위 초기화</button></aside>
  <div class="reader-column"><article class="question"><div class="question-head"><div class="crumb">${esc([
        q.group, q.category, q.topic, q.subtopic
      ].filter(Boolean).join(' › '))}</div><div class="question-title"><h2>${esc(q.exam)} <span>${
          esc(q.number)}번</span></h2><button class="soft capture" data-act="capture">문제 이미지 복사</button></div></div>
  <div class="paper">${
          q.images
              .map(
                  (src, i) =>
                      `<img class="paper-image" ${window.LibraryPrivate ? '' : 'src="' + esc(src) + '"'} alt="${esc(q.category)} ${esc(q.exam)} ${
                          esc(q.number)}번 문제${q.images.length > 1 ? ' ' + (i + 1) + '쪽' : ''}">`)
              .join(
                  '')}</div><div class="image-error" hidden>문제 이미지를 불러오지 못했습니다. <button class="text-btn" data-act="reload">다시 시도</button></div>
  <div id="answer" class="answer">${
          answerArea(q)}</div></article><div class="reader-nav"><button class="soft" data-act="prev" ${
          index <= 0 ? 'disabled' : ''}>← 이전</button><button class="text-btn" data-act="list">${
          fmt(index + 1)} / ${fmt(pool.length)} ⌄</button><button class="primary" data-act="next" ${
          index + 1 >= pool.length ? 'disabled' : ''}>다음 →</button></div></div></div>`;
  const errorBox = main.querySelector('.image-error');
  main.querySelectorAll('.paper-image').forEach((img, i) => {
    img.addEventListener('error', () => { errorBox.hidden = false; });
    if (window.LibraryPrivate) {
      window.LibraryPrivate.imageUrl(q.images[i]).then(url => {
        if (img.isConnected) img.src = url;
      }).catch(() => { errorBox.hidden = false; });
    }
  });
}
function render(remember = true) {
  if (!questions.length)
    return;
  const legacyProgress = location.hash === '#progress';
  if (legacyProgress) {
    history.replaceState(null, '', '#home');
  }
  const view = location.hash.startsWith('#solve') ? 'solve' : 'home';
  document.querySelectorAll('[data-nav]').forEach(a => {
    if (a.dataset.nav === view)
      a.setAttribute('aria-current', 'page');
    else
      a.removeAttribute('aria-current');
  });
  if (view === 'solve') solve(remember);
  else home();
  document.title = (view === 'solve' ? '문제 풀기' : '학습 홈') + ' · 문제서재';
  if (legacyProgress) requestAnimationFrame(() => document.querySelector('#home-progress')?.scrollIntoView());
}
// Interaction
function modal(title, body, kind) {
  dialog.dataset.kind = kind;
  document.querySelector('#dialog-body').innerHTML = `<div class="modal-title"><h2 id="dialog-title">${
      esc(title)}</h2><button class="close" aria-label="닫기" data-act="close">×</button></div>${body}`;
  dialog.setAttribute('aria-labelledby', 'dialog-title');
  if (!dialog.open)
    dialog.showModal();
}
function deviceModal(message = '') {
  const code = window.LibraryPrivate?.pairingCode() || window.LibrarySync?.code();
  const localHost = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  let controls;
  if (code) {
    const link = new URL(location.pathname, location.origin);
    link.hash = (window.LibraryPrivate ? 'key=' : 'pair=') + code;
    const value = localHost ? code : link.href;
    const label = localHost ? '연결 코드' : '내 연결 링크';
    controls = `<p>다른 기기에서 ${localHost ? '문제서재를 열고 같은 코드를 입력하세요.' : '이 링크를 열면 같은 진도로 이어집니다.'} 링크와 코드를 가진 사람은 진도에 접근할 수 있습니다.</p>
      <label class="device-field">${label}<input id="pair-share" type="password" readonly autocomplete="off" value="${esc(value)}"></label>
      <div class="modal-footer"><button class="soft" data-act="sync-now">지금 동기화</button><button class="primary" data-act="copy-device">${label} 복사</button></div>`;
  } else {
    controls = `<p>먼저 사용한 기기의 개인 연결 링크를 열거나 여기에 붙여넣으세요.</p>
      <label class="device-field">연결 링크 또는 코드<input id="pair-input" type="password" autocomplete="off" spellcheck="false"></label>
      <div class="modal-footer">${window.PSAT_SYNC_CONFIG && !window.LibrarySyncConfigGate ? '<button class="soft" data-act="new-device">새 연결 만들기</button>' : '<span></span>'}
      <button class="primary" data-act="connect-device">연결하기</button></div>`;
  }
  modal('기기 연결', `<p class="device-status" role="status" data-sync-label>${esc(syncLabels[syncState])}</p>
    ${controls}<p id="pair-message" aria-live="polite">${esc(message)}</p>`, 'devices');
}
async function connectDevice(code, createIfMissing) {
  if (!codePattern.test(code)) throw new Error('연결 링크 또는 코드를 확인해 주세요.');
  if (window.LibrarySyncConfigGate && !await window.LibrarySyncConfigGate.unlock(code))
    throw new Error('이 문제서재의 개인 연결 링크를 확인해 주세요.');
  await window.LibrarySync.connect(code, {createIfMissing});
}
async function deviceAction(name, button) {
  button.disabled = true;
  const feedback = document.querySelector('#pair-message');
  try {
    if (name === 'copy-device') {
      const input = document.querySelector('#pair-share');
      try {
        await navigator.clipboard.writeText(input.value);
        feedback.textContent = '복사했습니다.';
      } catch {
        input.type = 'text'; input.select(); feedback.textContent = '선택된 내용을 복사해 주세요.';
      }
    } else if (name === 'sync-now') {
      if (!window.LibrarySync.code() && window.LibraryPrivate?.pairingCode())
        await connectDevice(window.LibraryPrivate.pairingCode(), true);
      const ok = await window.LibrarySync.flush();
      feedback.textContent = ok ? '최신 진도를 확인했습니다.' : '인터넷 연결을 확인하고 다시 시도해 주세요.';
    } else {
      if (name === 'new-device') await window.LibrarySync.create();
      else {
        const input = document.querySelector('#pair-input').value.trim();
        const code = codePattern.test(input) ? input : /#(?:pair|key)=([A-Za-z0-9_-]{43})$/.exec(input)?.[1];
        await connectDevice(code || '', Boolean(window.LibrarySyncConfigGate));
      }
      deviceModal('이 기기가 연결되었습니다.');
    }
  } catch {
    feedback.textContent = '연결하지 못했습니다. 개인 연결 링크와 인터넷 연결을 확인해 주세요.';
  } finally { button.disabled = false; }
}
function selectModal() {
  const s = stats(filtered(draft));
  modal(
      '문제집 선택',
      `${filters(draft)}<div class="scope-footer">${scopeCounts(s, 'draft')}
      <button class="range-reset" data-reset="draft" ${s.done ? '' : 'disabled'}>선택 범위 초기화</button>
      <button class="primary" data-act="apply" ${s.total ? '' : 'disabled'}>문제 풀기 →</button></div>`,
      'filter');
}
function listModal() {
  listed = pool.filter(q => !listStatus || state(q) === listStatus);
  const size = 40, pages = Math.ceil(listed.length / size);
  listPage = Math.max(0, Math.min(listPage, pages - 1));
  const start = listPage * size;
  modal(
      '문제 목록',
      `<div class="list-tools"><label>풀이 상태<select id="list-filter"><option value="">모든 상태</option>${
          Object.entries(stateNames)
              .map(([k, v]) => `<option value="${k}" ${listStatus === k ? 'selected' : ''}>${v}</option>`)
              .join('')}</select></label>
  <label>목록 순번<input id="jump-index" type="number" min="1" max="${listed.length}" placeholder="1–${
          fmt(listed.length)}"></label><button class="soft" data-act="jump">이동</button></div>
  <div class="q-list">${
          listed.slice(start, start + size)
              .map(
                  (q, i) => `<button class="q-row ${q === current ? 'active' : ''}" data-id="${
                      esc(q.id)}"><small>${fmt(start + i + 1)}</small><span>${esc(q.exam)} ${
                      esc(q.number)}번</span><em class="${state(q)}">${stateNames[state(q)]}</em></button>`)
              .join('') ||
          '<p class="muted">이 상태의 문제가 없습니다.</p>'}</div>
  <div class="reader-nav"><button data-act="list-prev" class="soft" ${
          listPage === 0 ? 'disabled' : ''}>이전 목록</button><span>${pages ? listPage + 1 : 0} / ${
          pages}</span><button data-act="list-next" class="soft" ${
          listPage + 1 >= pages ? 'disabled' : ''}>다음 목록</button></div>`,
      'list');
}
async function questionPng(q) {
  const images = await Promise.all(q.images.map(async src => {
    const img = new Image();
    img.src = window.LibraryPrivate ? await window.LibraryPrivate.imageUrl(src) : src;
    await img.decode();
    return img;
  }));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(...images.map(img => img.naturalWidth));
  const heights = images.map(img => Math.round(img.naturalHeight * canvas.width / img.naturalWidth));
  const gap = 12;
  canvas.height = heights.reduce((total, height) => total + height, 0) + gap * (images.length - 1);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  let y = 0;
  images.forEach((img, i) => {
    ctx.drawImage(img, 0, y, canvas.width, heights[i]);
    y += heights[i] + gap;
  });
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('PNG encoding failed')), 'image/png');
  });
}
async function capture(q, btn) {
  if (!navigator.clipboard?.write || !window.ClipboardItem) {
    toast('이 브라우저는 이미지 복사를 지원하지 않습니다. 최신 Safari, Chrome 또는 Edge에서 열어 주세요.');
    return;
  }
  btn.disabled = true;
  try {
    // Start the write during the click gesture, even when image decryption is still pending.
    const item = new ClipboardItem({'image/png': questionPng(q)});
    await navigator.clipboard.write([item]);
    toast('문제 이미지를 복사했습니다. 채팅창에 붙여넣으세요.');
  } catch (error) {
    toast(error.name === 'NotAllowedError'
        ? '복사가 차단되었습니다. 브라우저의 클립보드 권한을 확인하고 다시 눌러 주세요.'
        : '문제 이미지를 복사하지 못했습니다. 다시 시도해 주세요.');
  } finally {
    btn.disabled = false;
  }
}
function rowForPath(path) {
  const pathKey = JSON.stringify(path);
  return Array.from(main.querySelectorAll('.range-row')).find(row => row.dataset.path === pathKey);
}
function askReset(origin, path = []) {
  const targets = {all: {}, group: {group: tab}, range: scopeForPath(path), study, draft};
  const selection = {...emptyScope(), ...targets[origin]};
  const done = stats(filtered(selection)).done;
  if (!done) return;
  pendingReset = {origin, path, selection, done};
  showResetConfirmation();
}
function showResetConfirmation() {
  const {selection, done} = pendingReset;
  const label = rangeFields.map(field => selection[field]).filter(Boolean).join(' › ') || '전체 문제';
  modal('풀이 기록을 초기화할까요?',
    `<p><strong>${esc(label)}</strong></p><p>이 범위에 저장한 답안과 채점 기록 ${fmt(done)}건이 삭제됩니다.</p>
    <div class="modal-footer"><button class="soft" data-act="close">취소</button>
    <button class="danger" data-act="confirm-reset">기록 초기화</button></div>`, 'reset');
  dialog.querySelector('.modal-footer [data-act="close"]').focus();
}
function dismissDialog() {
  const returnToPicker = pendingReset?.origin === 'draft';
  pendingReset = null;
  if (returnToPicker) selectModal();
  else dialog.close();
}
function confirmReset() {
  if (!pendingReset || dialog.dataset.kind !== 'reset') return;
  const {origin, path, selection} = pendingReset;
  const items = filtered(selection), done = stats(items).done;
  if (done && done !== pendingReset.done) {
    pendingReset.done = done;
    showResetConfirmation();
    return;
  }
  if (done) {
    for (const q of items) {
      if (records.delete(q.id)) persist(entry + q.id, null, false);
    }
    const last = read(prefix + 'last', null);
    if (items.some(q => q.id === last)) persist(prefix + 'last', null, false);
    if (syncReady) window.LibrarySync.reset(items.map(q => 'item.' + q.id));
  }
  pendingReset = null;
  if (origin !== 'draft') dialog.close();
  render(false);
  if (origin === 'draft') selectModal();
  else if (origin === 'range') rowForPath(path)?.querySelector('[data-start-range]')?.focus({preventScroll: true});
  else if (origin === 'study') main.querySelector('.aside-nav [data-act="list"]')?.focus({preventScroll: true});
  else main.querySelector(origin === 'group' ? '[data-group][aria-pressed="true"]' : '[data-act="resume"]')?.focus({preventScroll: true});
  toast(`${scopeName(selection)} 풀이 기록을 초기화했습니다.`);
}
function action(name, el) {
  switch (name) {
    case 'devices':
      deviceModal();
      break;
    case 'new-device':
    case 'connect-device':
    case 'copy-device':
    case 'sync-now':
      deviceAction(name, el);
      break;
    case 'resume':
      go(getLast());
      break;
    case 'filter':
      draft = {...study};
      selectModal();
      break;
    case 'apply':
      dialog.close();
      startScope(draft);
      break;
    case 'list':
      listStatus = '';
      listPage = Math.floor(index / 40);
      listModal();
      break;
    case 'list-prev':
      listPage--;
      listModal();
      break;
    case 'list-next':
      listPage++;
      listModal();
      break;
    case 'jump': {
      const v = Number(document.querySelector('#jump-index').value);
      if (!Number.isInteger(v) || v < 1 || v > listed.length) {
        toast('목록에 있는 순번을 입력해 주세요.');
        break;
      }
      dialog.close();
      go(listed[v - 1]);
      break;
    }
    case 'prev':
      go(pool[index - 1]);
      break;
    case 'next':
      go(pool[index + 1]);
      break;
    case 'close':
      dismissDialog();
      break;
    case 'capture':
      capture(current, el);
      break;
    case 'reload':
      solve();
      break;
    case 'retry':
      editing = true;
      solve();
      break;
    case 'written': {
      const v = document.querySelector('#written').value.trim();
      if (!v) {
        toast('저장할 답안을 입력해 주세요.');
        break;
      }
      save({text: v});
      solve();
      break;
    }
    case 'confirm-reset':
      confirmReset();
      break;
  }
}
document.addEventListener('click', e => {
  const el = e.target.closest('button');
  if (!el || el.disabled)
    return;
  const rangeRow = el.closest('.range-row');
  const path = rangeRow ? JSON.parse(rangeRow.dataset.path) : [];
  if (el.dataset.reset) {
    askReset(el.dataset.reset, path);
    return;
  }
  if (el.hasAttribute('data-expand-range')) {
    expandedPath = el.getAttribute('aria-expanded') === 'true' ? path.slice(0, -1) : path;
    main.querySelector('#range-library').innerHTML = rangeLibrary();
    rowForPath(path)?.querySelector('[data-expand-range]')?.focus({preventScroll: true});
    return;
  }
  if (el.hasAttribute('data-start-range')) {
    startScope(scopeForPath(path));
    return;
  }
  if (el.dataset.act)
    return action(el.dataset.act, el);
  if (el.dataset.group) {
    if (el.dataset.group === tab) return;
    tab = el.dataset.group;
    expandedPath = [];
    main.querySelector('#range-library').innerHTML = rangeLibrary();
    main.querySelector('[data-group][aria-pressed="true"]').focus({preventScroll: true});
    return;
  }
  if (el.dataset.id) {
    dialog.close();
    go(byId.get(el.dataset.id));
    return;
  }
  if (el.dataset.choice) {
    save({pick: Number(el.dataset.choice)});
    editing = false;
    solve();
    return;
  }
  if (el.dataset.manual) {
    const r = {...records.get(current.id), manual: el.dataset.manual},
          input = document.querySelector('#written');
    if (input)
      r.text = input.value;
    save(r);
    solve();
  }
});
document.addEventListener('input', e => {
  if (e.target.id !== 'written' || !current)
    return;
  const text = e.target.value;
  if (text.trim())
    save({text}, {draft: true});
  else {
    records.delete(current.id);
    persist(entry + current.id, null);
  }
  main.querySelector('.feedback')?.remove();
  const s = stats(pool), sidebar = main.querySelector('.reader-aside');
  sidebar.querySelector('.aside-stats').innerHTML =
      `<b>${percent(s.done, s.total)}%</b>${scopeCounts(s, 'study')}`;
  sidebar.querySelector('.bar i').style.width = (s.total ? s.done / s.total * 100 : 0) + '%';
  sidebar.querySelector('[data-reset="study"]').disabled = !s.done;
});
document.addEventListener('change', e => {
  const el = e.target;
  if (el.id === 'list-filter') {
    listStatus = el.value;
    listPage = 0;
    listModal();
    return;
  }
  if (!el.dataset.field)
    return;
  if (dialog.open && dialog.dataset.kind === 'filter') {
    changeField(draft, el.dataset.field, el.value);
    selectModal();
  }
});
dialog.addEventListener('click', e => {
  if (e.target === dialog)
    dismissDialog();
});
dialog.addEventListener('cancel', e => {
  if (pendingReset?.origin === 'draft') {
    e.preventDefault();
    dismissDialog();
  }
});
dialog.addEventListener('close', () => {
  pendingReset = null;
  refreshDeviceView();
});
document.addEventListener('focusout', e => {
  if (e.target.id === 'written' && deferredView) setTimeout(refreshDeviceView, 0);
});
window.addEventListener('hashchange', () => {
  if (dialog.open)
    dialog.close();
  editing = false;
  render();
  window.scrollTo(0, 0);
});
window.addEventListener('storage', e => {
  if (e.key?.startsWith(entry)) {
    const id = e.key.slice(entry.length), r = read(e.key, null);
    if (r)
      records.set(id, r);
    else
      records.delete(id);
    if (!dialog.open && document.activeElement?.id !== 'written')
      render(false);
    else
      refreshTodayCounts();
  } else if (e.key === null) {
    records.clear();
    render(false);
  }
});
function watchStudyDay() {
  let displayedDay = currentStudyDay(), timer;
  function schedule() {
    clearTimeout(timer);
    const day = currentStudyDay();
    if (day !== displayedDay) {
      displayedDay = day;
      refreshTodayCounts();
    }
    const nextMidnight = Date.parse(day) + dayMs - koreaOffsetMs;
    timer = setTimeout(schedule, Math.max(0, nextMidnight - Date.now()));
  }
  // A background tab or suspended phone may wake after the scheduled midnight.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) schedule(); });
  window.addEventListener('pageshow', schedule);
  window.addEventListener('focus', schedule);
  schedule();
}
async function boot() {
  try {
    const sets = window.LibraryPrivate ? await window.LibraryPrivate.loadCatalogs() : await Promise.all(['psat', 'major'].map(async (file) => {
      const res = await fetch('data/' + file + '.json');
      if (!res.ok)
        throw new Error();
      return res.json();
    }));
    sets.forEach((rows, i) => {
      for (const q of rows) {
        q.group = i ? '전공' : 'PSAT';
        byId.set(q.id, q);
        questions.push(q);
      }
    });
    const position = q => {
      const i = order.indexOf(q.category);
      return i < 0 ? order.length : i;
    };
    questions.sort((a, b) => position(a) - position(b));
    study = {...emptyScope(), ...read(prefix + 'scope', {})};
    hydrate();
    const sync = window.LibrarySync;
    const profile = window.LibraryPrivate?.pairingCode() || incomingPair;
    if (sync) {
      const savedProfile = profile || sync.code();
      if (window.LibrarySyncConfigGate && savedProfile) await window.LibrarySyncConfigGate.unlock(savedProfile);
      syncReady = true;
      if (savedProfile) main.innerHTML = '<p class="loading" role="status">저장된 진도를 불러오는 중입니다…</p>';
      await sync.start({snapshot: deviceSnapshot, onApply: applyDeviceChanges, onStatus: setSyncState});
      if (profile && profile !== sync.code()) {
        try { await connectDevice(profile, true); }
        catch { setSyncState('offline'); toast('기기 연결을 마치지 못했습니다. 개인 링크를 다시 열어 주세요.'); }
      }
    }
    render(!profile && !sync?.code());
    watchStudyDay();
    if (memoryOnly)
      toast('브라우저 저장 공간을 사용할 수 없습니다.');
  } catch {
    main.innerHTML =
        '<div class="panel"><h1>문제집을 열 수 없습니다</h1><p>연결을 확인한 뒤 다시 시도해 주세요.</p><button class="primary" onclick="location.reload()">다시 불러오기</button></div>';
  }
}
boot();
