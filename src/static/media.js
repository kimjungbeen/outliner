// 첨부 재생: 재생 · 읽기 위치 기억 · 미디어 조작부(구간 반복 · 북마크 포함) · 아래 재생 막대 · 하위 미디어 전체 재생

import { fileTokens, fmtTime, parseTime } from './lib.js';
import { http, listeners, mk, state, toast } from './base.js';
import { ck, flushAll, patch, toggle } from './app.js';
import { askText, confirmDelete } from './dialog.js';
import { addMark, mediaMarks, PDF_ICON } from './markup.js';
import { copyMarkLink, markHref, markList } from './marks.js';
import { openHit, pal } from './commands.js';

// ---- 첨부 재생 · 읽기 위치: PDF는 마지막 페이지, 영상 · 오디오는 마지막 재생 위치를 DB에 기억해요 ----
const mediaPos = new Map(); // 파일 주소 → {page?, t?}
const mediaPosReady = http('/api/media-pos').then((r) => { for (const [k, v] of Object.entries(r.pos || {})) mediaPos.set(k, v); }).catch(() => {});
const posTimers = new Map();
function saveMediaPos(url, patch, now = false) {
  mediaPos.set(url, { ...(mediaPos.get(url) || {}), ...patch });
  clearTimeout(posTimers.get(url));
  const go = () => { posTimers.delete(url); http('/api/media-pos', 'POST', { url, ...patch }).catch(() => {}); };
  if (now) go(); else posTimers.set(url, setTimeout(go, 800));
}
addEventListener('pagehide', () => { for (const [url, t] of posTimers) { clearTimeout(t); navigator.sendBeacon?.('/api/media-pos', new Blob([JSON.stringify({ url, ...mediaPos.get(url) })], { type: 'application/json' })); } });

// 다시 그려도 재생 중인 영상 · 오디오, 보고 있던 PDF가 처음으로 돌아가지 않게 같은 요소를 옮겨 붙여요
const mediaEls = new Map(); // 파일 주소 → 요소
function reuseMedia(url, make) { // (같은 파일이 여러 항목에 있으면 마지막으로 그린 곳으로 옮겨져요)
  let el = mediaEls.get(url);
  if (!el) { el = make(); mediaEls.set(url, el); }
  else if (el.onReattach) { // 요소를 떼었다 붙이면 안쪽 스크롤 위치가 0으로 돌아가요 → 다시 붙은 뒤 되돌려요 (그리기 전에)
    queueMicrotask(() => el.onReattach());
    requestAnimationFrame(() => el.onReattach());
  }
  return el;
}

function mediaWithPos(el, url) { // 영상 · 오디오: 마지막 위치에서 이어서
  const resume = () => { const t = mediaPos.get(url)?.t; if (t && el.duration && t < el.duration - 1) el.currentTime = t; };
  el.addEventListener('loadedmetadata', () => { mediaPosReady.then(resume); }, { once: true });
  let last = -1;
  el.addEventListener('timeupdate', () => { if (Math.abs(el.currentTime - last) >= 2) { last = el.currentTime; saveMediaPos(url, { t: el.currentTime }); } });
  el.addEventListener('pause', () => saveMediaPos(url, { t: el.currentTime }, true));
  el.addEventListener('seeked', () => { saveMediaPos(url, { t: el.currentTime }); player.inlineSeeked(el, url); });
  el.addEventListener('ended', () => saveMediaPos(url, { t: 0 }, true)); // 끝까지 봤으면 다음엔 처음부터
  // 재생 중인 항목을 접거나 다른 화면으로 가면 브라우저가 멈춰요 → 아래 재생 막대가 그 자리부터 (구간 반복 · 반복 설정도 그대로) 이어서 재생
  let playing = false;
  el.addEventListener('play', () => { playing = true; player.pauseFor(el); player.follow(el, url); });
  el.addEventListener('ended', () => { playing = false; });
  el.addEventListener('pause', () => setTimeout(() => {
    if (playing && !el.isConnected) player.takeOver(url, el.currentTime, mediaCtl.get(el)?.st);
    playing = false;
  }));
  return el;
}

// ---- 미디어 조작부: 항목 안의 플레이어와 아래 재생 막대가 똑같은 것을 써요 ----
// 위치 막대 · 시간(눌러서 입력) · −5 · 재생 · +15 · 구간 반복(A-B, 시간 입력) · 반복
const mediaCtl = new WeakMap(); // 미디어 요소 → 그 조작부 (막대로 넘길 때 설정을 함께 넘기려고)
const MSVG = (d, fill = false) => `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" ${fill ? 'fill="currentColor"' : 'fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"'}>${d}</svg>`;
const MICON = {
  play: MSVG('<path d="M5 3.5v9l7-4.5z"/>', true),
  pause: MSVG('<path d="M5 3.5h2v9H5zM9 3.5h2v9H9z"/>', true),
  prev: MSVG('<path d="M4 3.5v9M12.5 3.5v9L6 8z"/>', true),
  next: MSVG('<path d="M12 3.5v9M3.5 3.5v9L10 8z"/>', true),
  shuffle: MSVG('<path d="M2.5 4.5h2.2c1.2 0 2.3.6 3 1.6l1.6 2.3c.7 1 1.8 1.6 3 1.6h1.2M2.5 11.5h2.2c1.2 0 2.3-.6 3-1.6M10 5.6c.6-.7 1.4-1.1 2.3-1.1h1.2M12 2.8l1.7 1.7L12 6.2M12 8.3l1.7 1.7-1.7 1.7"/>'),
  repeat: MSVG('<path d="M3 7V6a2 2 0 0 1 2-2h7.5M10.5 2l2 2-2 2M13 9v1a2 2 0 0 1-2 2H3.5M5.5 14l-2-2 2-2"/>'),
  repeatOne: MSVG('<path d="M3 7V6a2 2 0 0 1 2-2h7.5M10.5 2l2 2-2 2M13 9v1a2 2 0 0 1-2 2H3.5M5.5 14l-2-2 2-2"/><path d="M7.4 7.2 8.5 6.5v3.6" stroke-width="1.3"/>'),
  close: MSVG('<path d="M4 4l8 8M12 4l-8 8"/>'),
  mini: MSVG('<path d="M4 6l4 4 4-4"/>'),
  expand: MSVG('<path d="M4 10l4-4 4 4"/>'),
  full: MSVG('<path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/>'),
  queue: MSVG('<path d="M2.5 4h11M2.5 8h11M2.5 12h6.5M11.5 10.2v3.6l3-1.8z"/>'),
  toBar: MSVG('<rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5"/><rect x="8" y="8" width="4.5" height="3.5" rx=".6" fill="currentColor" stroke="none"/>'),
  mark: MSVG('<path d="M4.5 2.5h7v11L8 10.8 4.5 13.5z"/>'),
  toNode: MSVG('<rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5"/><path d="M5.5 5.5h4v4M9.5 5.5 5 10"/>'),
};
function mediaBtn(label, fn, { icon = '', text = '', cls = '' } = {}) {
  const b = mk('button', `mp-btn ${cls}`.trim()); b.type = 'button';
  if (icon) b.innerHTML = MICON[icon]; else b.textContent = text;
  b.title = label; b.setAttribute('aria-label', label); b.onclick = fn;
  return b;
}
// 구간 반복 기록: 곡(파일 주소)마다 정했던 A–B 구간을 DB(plugin_data 'core' media_loops)에 남겨, 칩으로 다시 고르거나 지워요
const mediaLoops = new Map(); // 파일 주소 → [{ a, b }] (시작 순)
const loadLoops = () => http('/api/plugin-data/core/media_loops').then((r) => {
  mediaLoops.clear();
  for (const [k, v] of Object.entries(r.value || {})) if (Array.isArray(v)) mediaLoops.set(k, v);
  document.dispatchEvent(new Event('medialoops'));
}).catch(() => {});
loadLoops();
function saveLoops() {
  document.dispatchEvent(new Event('medialoops')); // 항목 안 · 막대의 칩을 함께 다시 그림
  http('/api/plugin-data/core/media_loops', 'PUT', { value: Object.fromEntries(mediaLoops) }).catch((e) => toast(`구간 기록을 저장하지 못했어요: ${e.message}`, 4000));
}
function addLoop(url, a, b) {
  if (!url) return;
  const list = mediaLoops.get(url) || [];
  if (list.some((l) => Math.abs(l.a - a) < 0.3 && Math.abs(l.b - b) < 0.3)) return; // 이미 있는 구간
  list.push({ a: Math.round(a * 10) / 10, b: Math.round(b * 10) / 10 });
  list.sort((x, y) => x.a - y.a || x.b - y.b);
  mediaLoops.set(url, list.slice(-30));
  saveLoops();
}
function removeLoop(url, loop) {
  const list = (mediaLoops.get(url) || []).filter((l) => l !== loop);
  if (list.length) mediaLoops.set(url, list); else mediaLoops.delete(url);
  saveLoops();
}
const REPEAT_NAME = { off: '반복 끄기', all: '전체 반복', one: '한 곡 반복' };
/** 미디어 요소 하나의 조작부. modes: 반복 단추가 도는 순서 (항목 안: 끔 → 한 곡 / 막대: 끔 → 전체 → 한 곡)
 *  prev · next · extra: 막대의 이전 · 다음 · 섞기 단추를 제자리에 끼워 넣음. 끝났을 때 처리는 부르는 쪽이 ended()로 */
function mediaControls(media, { modes = ['off', 'one'], prev = null, next = null, extra = [], fullscreen = null } = {}) {
  const st = { repeat: 'off', loopA: null, loopB: null }; // 반복 · 구간 반복(A-B)
  const box = mk('div', 'mctl');
  const line = mk('div', 'mp-line');
  const seek = mk('input', 'mp-seek'); seek.type = 'range'; seek.min = 0; seek.max = 1000; seek.value = 0; seek.setAttribute('aria-label', '재생 위치');
  const fill = () => seek.style.setProperty('--p', `${seek.value / 10}%`); // 지나온 부분 칠하기
  seek.oninput = () => { fill(); if (media.duration) media.currentTime = (seek.value / 1000) * media.duration; };
  seek.addEventListener('keydown', (e) => e.stopPropagation()); // ←→는 위치 옮기기 (앱 단축키로 새지 않게)
  const time = mk('button', 'mp-time'); time.type = 'button'; time.title = '눌러서 시간 넣기 (예: 1:23 · 95 · 1분 30초)';
  time.onclick = editTime;
  const track = mk('span', 'mp-track'), ticks = mk('span', 'mp-ticks'); // 위치 막대 위의 북마크 눈금
  track.append(seek, ticks);
  line.append(track, time);
  const playBtn = mediaBtn('재생 · 일시정지', () => (media.paused ? media.play().catch(() => {}) : media.pause()), { icon: media.paused ? 'play' : 'pause' });
  const repeatBtn = mediaBtn('반복', () => { st.repeat = modes[(modes.indexOf(st.repeat) + 1) % modes.length]; paint(); }, { icon: 'repeat' });
  const abBtn = mediaBtn('구간 반복', tapAB, { text: 'A-B', cls: 'mp-ab' });
  const markBtn = mediaBtn('북마크', () => { markBox.hidden = !markBox.hidden; paintMarks(); }, { icon: 'mark', cls: 'mp-markbtn' });
  const skip = (d) => { if (media.duration) media.currentTime = Math.min(Math.max(0, media.currentTime + d), media.duration - 0.05); };
  const row = mk('div', 'mp-row');
  row.append(
    ...[prev, mediaBtn('5초 전', () => skip(-5), { text: '−5', cls: 'mp-skip' }), playBtn, mediaBtn('15초 후', () => skip(15), { text: '+15', cls: 'mp-skip' }), next].filter(Boolean),
    mk('span', 'mp-gap'), markBtn, abBtn, repeatBtn, ...extra,
    ...(fullscreen ? [mediaBtn('전체 화면', fullscreen, { icon: 'full' })] : []),
  );
  // 구간 반복이 켜지면 A · B 시간 칸: 고쳐 넣으면 바로 적용 (B를 비우면 A부터 끝까지)
  const abRow = mk('div', 'mp-abrow'); abRow.hidden = true;
  const timeIn = (label, ph) => { const i = mk('input', 'mp-timein'); i.placeholder = ph; i.setAttribute('aria-label', label); i.title = '1:23 · 95 · 1분 30초'; return i; };
  const inA = timeIn('구간 시작(A)', '시작'), inB = timeIn('구간 끝(B)', '끝까지');
  const lab = (t) => { const x = mk('span', 'mp-ablabel'); x.textContent = t; return x; };
  abRow.append(lab('구간 반복  A'), inA, lab('B'), inB);
  for (const [inp, which] of [[inA, 'A'], [inB, 'B']]) {
    inp.addEventListener('keydown', (e) => {
      e.stopPropagation(); // 앱 단축키로 새지 않게
      if (e.isComposing) return;
      if (e.key === 'Enter') { e.preventDefault(); setLoop(which, inp.value); inp.blur(); } else if (e.key === 'Escape') { e.preventDefault(); inp.blur(); paint(); }
    });
    inp.addEventListener('change', () => setLoop(which, inp.value));
    inp.addEventListener('blur', () => setTimeout(paint));
  }
  // 저장한 구간: 누르면 그 구간 반복, ×로 지우기
  const savedRow = mk('div', 'mp-saved'); savedRow.hidden = true;
  const fileKey = () => { try { return media.getAttribute('src') ? new URL(media.src).pathname : ''; } catch { return ''; } };
  // 북마크 칸: '지금 위치에 북마크' + 목록 (누르면 그 자리부터 재생 · 이름 고치기 · 링크 복사 · 지우기) — PDF · 이미지와 같은 목록
  const markBox = mk('div', 'att-pdfmarks mp-marks'); markBox.hidden = true;
  const markAdd = mk('button', 'att-btn att-markadd'); markAdd.type = 'button'; markAdd.onclick = addHere;
  const nodeOf = () => fileItem(fileKey()).nodeId;
  const marksUi = markList({
    kind: 'media', url: fileKey, tag: (m) => fmtTime(m.t), sort: (a, b) => a.t - b.t,
    go: (m) => { media.currentTime = Math.min(m.t, (media.duration || Infinity) - 0.05); media.play().catch(() => {}); },
    link: (m) => markHref('media', fileKey(), m, { n: nodeOf() }),
    extra: { // 시간도 고쳐요: 1:23 · 95 · 1분 30초, '지금 위치로' 단추
      label: '시간', get: (m) => fmtTime(m.t), now: () => ({ t: Math.round(media.currentTime * 10) / 10 }),
      parse: (v) => {
        const t = parseTime(v);
        if (t == null) return '시간은 1:23 · 95 · 1분 30초처럼 넣어요';
        if (Number.isFinite(media.duration) && t >= media.duration) return `곡 길이(${fmtTime(media.duration)})보다 길어요`;
        return { t: Math.round(t * 10) / 10 };
      },
    },
  });
  markBox.append(markAdd, marksUi.find, marksUi.list);
  box.append(line, row, abRow, savedRow, markBox);
  async function addHere() {
    const key = fileKey(), t = Math.round(media.currentTime * 10) / 10;
    if (!key) return;
    const ans = await askText('북마크 이름', fmtTime(t), [{ label: '취소', value: null }, { label: '만들기', value: 'save', primary: true }], `${fmtTime(t)} 자리에 북마크를 만들어요`, { select: true });
    if (!ans) return;
    const m = addMark('media', key, { t, name: ans.text.trim() || fmtTime(t) });
    copyMarkLink(m.name, markHref('media', key, m, { n: nodeOf() }));
  }
  function paintMarks() {
    const all = mediaMarks.get(fileKey()) || [], d = media.duration;
    markBtn.setAttribute('aria-pressed', !markBox.hidden);
    markBtn.classList.toggle('has', all.length > 0);
    markBtn.title = all.length ? `북마크 ${all.length}개` : '북마크'; markBtn.setAttribute('aria-label', markBtn.title);
    ticks.replaceChildren(...(Number.isFinite(d) && d > 0 ? all.map((m) => { const k = mk('span', 'mp-tick'); k.style.left = `${Math.min(100, (m.t / d) * 100)}%`; k.title = `${m.name} · ${fmtTime(m.t)}`; return k; }) : []));
    if (markBox.hidden) return;
    markAdd.innerHTML = PDF_ICON.mark; markAdd.append(` 지금 위치에 북마크 · ${fmtTime(media.currentTime)}`);
    marksUi.paint();
  }
  document.addEventListener('mediamarks', paintMarks);
  for (const ev of ['loadedmetadata', 'durationchange', 'emptied']) media.addEventListener(ev, paintMarks);
  const same = (l) => st.loopA != null && st.loopB != null && Math.abs(st.loopA - l.a) < 0.3 && Math.abs(st.loopB - l.b) < 0.3;
  function paintSaved() {
    const key = fileKey(), list = mediaLoops.get(key) || [];
    savedRow.hidden = !list.length;
    savedRow.replaceChildren(...(list.length ? [lab('저장한 구간')] : []), ...list.map((l) => {
      const chip = mk('span', 'mp-chip');
      const pick = mk('button', 'mp-chipgo'); pick.type = 'button'; pick.textContent = `${fmtTime(l.a)}–${fmtTime(l.b)}`; pick.title = '이 구간 반복';
      pick.setAttribute('aria-pressed', same(l));
      pick.onclick = () => { st.loopA = l.a; st.loopB = l.b; media.currentTime = l.a; paint(); };
      const del = mk('button', 'mp-chipx'); del.type = 'button'; del.textContent = '×'; del.title = '이 구간 지우기'; del.setAttribute('aria-label', `${pick.textContent} 구간 지우기`);
      del.onclick = async () => { if (await confirmDelete(`구간 ${pick.textContent}`)) removeLoop(key, l); };
      chip.append(pick, del);
      return chip;
    }));
  }
  document.addEventListener('medialoops', paintSaved);
  media.addEventListener('loadedmetadata', paintSaved);
  media.addEventListener('emptied', paintSaved);
  const record = () => { if (st.loopA != null && st.loopB != null) addLoop(fileKey(), st.loopA, st.loopB); };

  const showTime = () => { if (!time.querySelector('input')) time.textContent = `${fmtTime(media.currentTime)} / ${fmtTime(media.duration)}`; };
  media.addEventListener('play', () => { playBtn.innerHTML = MICON.pause; });
  media.addEventListener('pause', () => { playBtn.innerHTML = MICON.play; });
  media.addEventListener('loadedmetadata', showTime);
  media.addEventListener('durationchange', showTime);
  media.addEventListener('timeupdate', () => {
    if (st.loopB != null && media.currentTime >= st.loopB) media.currentTime = st.loopA; // 구간 반복
    if (media.duration) { seek.value = Math.round((media.currentTime / media.duration) * 1000); fill(); }
    showTime();
    if (!markBox.hidden) markAdd.lastChild.textContent = ` 지금 위치에 북마크 · ${fmtTime(media.currentTime)}`;
  });
  // 끝났을 때: 구간 반복(A만 정했으면 A부터 끝까지) · 한 곡 반복이면 다시 재생하고 true
  function ended() {
    if (st.loopA == null && st.repeat !== 'one') return false;
    media.currentTime = st.loopA ?? 0;
    media.play().catch(() => {});
    return true;
  }
  // 시간 칸에 넣은 값으로 구간을 바꿈 (A가 B보다 뒤면 B를 지워 A부터 끝까지)
  function setLoop(which, text) {
    const v = String(text).trim();
    if (which === 'B' && !v) { st.loopB = null; return paint(); }
    const t = parseTime(v);
    const max = media.duration || Infinity;
    if (t == null || t >= max) { toast(t == null ? '시간은 1:23 · 95 · 1분 30초처럼 넣어요' : '곡 길이보다 길어요'); return paint(); }
    if (which === 'A') {
      st.loopA = t;
      if (st.loopB != null && st.loopB <= st.loopA + 0.3) st.loopB = null;
    } else {
      if (st.loopA == null) st.loopA = 0;
      if (t <= st.loopA + 0.3) { toast('끝(B)은 시작(A)보다 뒤여야 해요'); return paint(); }
      st.loopB = t;
    }
    record();
    if (media.currentTime < st.loopA || (st.loopB != null && media.currentTime >= st.loopB)) media.currentTime = st.loopA; // 구간 밖이면 시작으로
    paint();
  }
  // 구간 반복 단추: 누를 때마다 시작(A) 정하기 → 끝(B) 정하기(A~B 반복) → 끄기
  function tapAB() {
    if (st.loopA == null) st.loopA = media.currentTime;
    else if (st.loopB == null) {
      if (media.currentTime <= st.loopA + 0.3) st.loopA = null; // A보다 앞에서 누르면 취소
      else { st.loopB = media.currentTime; media.currentTime = st.loopA; record(); }
    } else st.loopA = st.loopB = null;
    paint();
  }
  // 시간 글자를 누르면 입력칸: Enter로 그 시간으로, Esc · 밖을 누르면 취소
  function editTime() {
    if (time.querySelector('input')) return;
    const inp = mk('input', 'mp-timein'); inp.value = fmtTime(media.currentTime); inp.setAttribute('aria-label', '이동할 시간');
    time.replaceChildren(inp); inp.focus(); inp.select();
    const done = (ok) => {
      if (!inp.isConnected) return;
      const t = ok ? parseTime(inp.value) : null;
      inp.remove();
      if (t != null && media.duration) media.currentTime = Math.min(t, media.duration - 0.05);
      else if (ok) toast('시간은 1:23 · 95 · 1분 30초처럼 넣어요');
      showTime();
    };
    inp.addEventListener('keydown', (e) => {
      e.stopPropagation(); // 앱 단축키로 새지 않게
      if (e.isComposing) return;
      if (e.key === 'Enter') { e.preventDefault(); done(true); } else if (e.key === 'Escape') { e.preventDefault(); done(false); }
    });
    inp.addEventListener('blur', () => done(false));
    inp.addEventListener('click', (e) => e.stopPropagation());
  }
  function paint() {
    if (!modes.includes(st.repeat)) st.repeat = 'off';
    const nx = modes[(modes.indexOf(st.repeat) + 1) % modes.length];
    repeatBtn.setAttribute('aria-pressed', st.repeat !== 'off');
    repeatBtn.innerHTML = MICON[st.repeat === 'one' ? 'repeatOne' : 'repeat'];
    repeatBtn.title = `${st.repeat === 'off' ? '반복: 꺼짐' : REPEAT_NAME[st.repeat]} (누르면 ${REPEAT_NAME[nx]})`;
    repeatBtn.setAttribute('aria-label', repeatBtn.title);
    const { loopA, loopB } = st;
    abBtn.setAttribute('aria-pressed', loopA != null);
    abBtn.textContent = loopA == null ? 'A-B' : loopB == null ? `A ${fmtTime(loopA)}` : `${fmtTime(loopA)}–${fmtTime(loopB)}`;
    abBtn.title = loopA == null ? '구간 반복: 시작(A) 정하기' : loopB == null ? '끝(B) 정하기 — 누르면 A~B를 반복해요' : '구간 반복 끄기';
    abBtn.setAttribute('aria-label', abBtn.title);
    abRow.hidden = loopA == null;
    if (document.activeElement !== inA) inA.value = loopA == null ? '' : fmtTime(loopA);
    if (document.activeElement !== inB) inB.value = loopB == null ? '' : fmtTime(loopB);
    paintSaved();
    showTime();
  }
  paint();
  const ctl = { box, st, ended, paint, set(s) { Object.assign(st, s); paint(); }, reset() { st.loopA = st.loopB = null; paint(); } };
  mediaCtl.set(media, ctl);
  return ctl;
}
/** 항목 안의 오디오 · 영상: 마지막 위치에서 이어서 + 막대와 같은 조작부 */
function inlinePlayer(el, url, opts) {
  mediaWithPos(el, url);
  const ctl = mediaControls(el, opts);
  el.addEventListener('ended', () => { if (!ctl.ended()) player.inlineEnded(el); }); // 구간 · 한 곡 반복이 아니면 다음 곡으로
  return ctl.box;
}

// ---- 아래 재생 막대: 하위 미디어 전체 재생 · 섞기 · 전체 반복 · 재생 목록, 접어도 이어지는 재생, 최소화 ----
// 오디오 · 영상 하나를 재생하는 요소를 따로 두어(문서에 늘 붙어 있음) 항목을 접거나 화면을 옮겨도 멈추지 않아요.
// 영상은 막대 위에 작게 보여 줘요. 항목 안의 플레이어를 재생하면 이 막대는 멈추고, 막대가 재생하면 항목 안의 것들은 멈춰요.
// 항목 안에서 재생하면 같은 계층(형제 항목)과 그 하위 항목들의 오디오 · 영상이 자동으로 재생 목록이 돼요: 그 곡은 항목 안에서 그대로 재생하고
// (막대는 목록만 보여 주는 '따라가기'), 끝나면 다음 곡을 — 화면에 있으면 그 항목 안에서, 없으면 막대에서 — 이어서 재생해요.
const player = (() => {
  let bar = null, media = null, ctl = null, queue = [], at = -1, order = [], lastSave = -1;
  let title = null, count = null, shuffleBtn = null, miniPlay = null, miniBtn = null, listBtn = null, listEl = null, toNodeBtn = null, toBarBtn = null, lastMirror = -1;
  let shuffled = false, mini = false, listOpen = false;
  let dragEnd = 0, corner = 'br'; // 막대가 붙은 화면 모서리: t/b(위/아래) + l/r(왼/오른)
  try { corner = localStorage.getItem('outliner.mplayer.corner') || 'br'; } catch {}
  let ext = null; // 따라가는 중인 항목 안의 미디어 요소
  let source = null; // 재생 목록을 만든 항목 { id } — 그 아래 항목이 바뀌면(옮기기 · 넣기 · 지우기) 목록을 다시 맞춰요
  const tracked = new WeakSet();
  try { mini = localStorage.getItem('outliner.mplayer.mini') === '1'; listOpen = localStorage.getItem('outliner.mplayer.list') === '1'; } catch {}
  const shuffleAll = (n) => { const a = [...Array(n).keys()]; for (let k = n - 1; k > 0; k--) { const j = Math.floor(Math.random() * (k + 1)); [a[k], a[j]] = [a[j], a[k]]; } return a; };
  const cur = () => ext || media; // 지금 소리를 내는 요소
  const toggle = () => { const m = cur(); if (m.paused) m.play().catch(() => {}); else m.pause(); };

  function build() {
    bar = mk('div', 'mplayer'); bar.setAttribute('role', 'region'); bar.setAttribute('aria-label', '재생 막대');
    media = mk('video', 'mp-video'); media.playsInline = true; media.preload = 'auto';
    media.onclick = toggle;
    // 위: 제목 · 몇 번째 · (최소화했을 때) 재생 · 최소화 · 닫기 / 아래: 항목 안과 같은 조작부 + 이전 · 다음 · 섞기
    const head = mk('div', 'mp-head');
    title = mk('button', 'mp-title'); title.type = 'button'; title.title = '이 항목으로 가기';
    title.onclick = () => { if (performance.now() - dragEnd < 400) return; const it = queue[order[at]]; if (it?.nodeId != null) openHit({ id: it.nodeId, parent_id: it.parentId }); };
    count = mk('span', 'mp-count');
    miniPlay = mediaBtn('재생 · 일시정지', toggle, { icon: 'play', cls: 'mp-miniplay' });
    miniBtn = mediaBtn('최소화', () => setMini(!mini), { icon: 'mini' });
    listBtn = mediaBtn('재생 목록', () => setList(!listOpen), { icon: 'queue', cls: 'mp-list' });
    // 막대 ↔ 항목 안: 같은 곡을 위치 · 구간 반복 · 목록 그대로 넘겨요
    toNodeBtn = mediaBtn('항목 안에서 재생', toNode, { icon: 'toNode', cls: 'mp-swap' }); toNodeBtn.hidden = true;
    toBarBtn = mediaBtn('막대에서 재생', toBar, { icon: 'toBar', cls: 'mp-swap' });
    head.append(title, count, miniPlay, toNodeBtn, toBarBtn, listBtn, miniBtn, mediaBtn('닫기', close, { icon: 'close' }));
    shuffleBtn = mediaBtn('전체 섞기', () => setShuffle(!shuffled), { icon: 'shuffle', cls: 'mp-list' });
    ctl = mediaControls(media, {
      modes: ['off', 'all', 'one'],
      prev: mediaBtn('이전', () => (media.currentTime > 3 || at <= 0 ? (media.currentTime = 0) : go(at - 1)), { icon: 'prev', cls: 'mp-list' }),
      next: mediaBtn('다음', () => (at + 1 < order.length ? go(at + 1) : ctl.st.repeat !== 'off' ? go(0) : null), { icon: 'next', cls: 'mp-list' }),
      extra: [shuffleBtn],
    });
    // 재생 목록: 지금 순서(섞었으면 섞인 순서)대로, 누르면 그 곡으로
    listEl = mk('ol', 'mp-queue'); listEl.setAttribute('aria-label', '재생 목록');
    listEl.addEventListener('click', (e) => { const li = e.target.closest('[data-at]'); if (li) playAt(+li.dataset.at); });
    bar.append(media, head, ctl.box, listEl);
    ctl.box.addEventListener('click', persist); // 반복을 바꾸면 기억
    document.body.append(bar);
    media.addEventListener('play', () => {
      miniPlay.innerHTML = MICON.pause;
      paintNow();
      for (const el of document.querySelectorAll('#tree audio, #tree video, #titleatt audio, #titleatt video')) if (!el.paused) el.pause();
    });
    media.addEventListener('pause', () => { miniPlay.innerHTML = MICON.play; paintNow(); save(true); });
    media.addEventListener('timeupdate', () => {
      if (Math.abs(media.currentTime - lastSave) >= 2) save();
      if (Math.abs(media.currentTime - lastMirror) >= 1) mirror();
    });
    media.addEventListener('seeked', () => mirror(true));
    media.addEventListener('loadedmetadata', () => mirror());
    media.addEventListener('ended', () => {
      const it = queue[order[at]];
      if (it) saveMediaPos(it.url, { t: 0 }, true); // 끝까지 들었으면 다음엔 처음부터
      if (ctl.ended()) return; // 구간 반복 · 한 곡 반복
      if (at + 1 < order.length) go(at + 1);
      else if (ctl.st.repeat === 'all') { if (shuffled) order = shuffleAll(queue.length); go(0); } // 전체 반복 (섞기면 한 바퀴마다 다시 섞어요)
    });
    media.addEventListener('error', () => { if (at + 1 < order.length) setTimeout(() => go(at + 1), 300); }); // 못 여는 파일은 건너뜀
    setMini(mini);
    bar.dataset.corner = corner;
    head.addEventListener('pointerdown', startDrag);
    setInterval(() => { if (!bar.hidden) mirror(); }, 1000); // 항목을 접고 펴도 '항목 안에서 재생' 단추가 따라가게
  }
  function save(now = false) { const it = queue[order[at]]; if (it && media.currentTime > 0) { lastSave = media.currentTime; saveMediaPos(it.url, { t: media.currentTime }, now); } }
  // 위쪽(제목 줄)을 끌어 옮기면 놓은 곳에서 가까운 화면 모서리로 붙어요 (다음에도 그 모서리에)
  function startDrag(e) {
    if (e.button !== 0 || e.target.closest('.mp-btn')) return;
    const r = bar.getBoundingClientRect(), sx = e.clientX, sy = e.clientY;
    let moved = false;
    const move = (ev) => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      if (!moved && Math.hypot(dx, dy) < 5) return; // 살짝 누른 건 그냥 누르기 (제목 → 그 항목으로)
      moved = true;
      bar.classList.add('dragging');
      const x = Math.min(Math.max(0, r.left + dx), innerWidth - r.width), y = Math.min(Math.max(0, r.top + dy), innerHeight - r.height);
      Object.assign(bar.style, { left: `${x}px`, top: `${y}px`, right: 'auto', bottom: 'auto' });
    };
    const up = (ev) => {
      removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', up);
      if (ev.type === 'pointerup') move(ev); // 놓은 자리까지 (마지막 움직임이 덜 왔을 수도)
      if (!moved) return;
      dragEnd = performance.now(); // 끌기를 마친 뒤의 클릭(제목 누르기)은 무시
      const b = bar.getBoundingClientRect(), cx = b.left + b.width / 2, cy = b.top + b.height / 2;
      snap((cy < innerHeight / 2 ? 't' : 'b') + (cx < innerWidth / 2 ? 'l' : 'r'), b);
    };
    addEventListener('pointermove', move); addEventListener('pointerup', up); addEventListener('pointercancel', up);
  }
  function snap(c, from) {
    corner = c; bar.dataset.corner = c;
    bar.classList.remove('dragging');
    bar.style.left = bar.style.top = bar.style.right = bar.style.bottom = '';
    try { localStorage.setItem('outliner.mplayer.corner', c); } catch {}
    const to = bar.getBoundingClientRect(); // 놓은 자리에서 모서리까지 튕기듯 미끄러지게
    bar.animate([{ transform: `translate(${from.left - to.left}px, ${from.top - to.top}px)` }, { transform: 'none' }], { duration: 340, easing: 'cubic-bezier(.3,1.32,.5,1)' });
  }
  // 최소화: 제목 · 재생 · 펼치기 · 닫기만 남긴 작은 막대 (재생은 계속, 다음에도 그 모양으로)
  function setMini(on) {
    mini = on;
    bar.classList.toggle('mini', on);
    miniBtn.innerHTML = MICON[on ? 'expand' : 'mini'];
    miniBtn.title = on ? '펼치기' : '최소화'; miniBtn.setAttribute('aria-label', miniBtn.title);
    try { localStorage.setItem('outliner.mplayer.mini', on ? '1' : '0'); } catch {}
  }
  // 목록에서 지금 곡 자리의 재생 · 멈춤 표시만 바꿈
  function paintNow() {
    if (miniPlay) miniPlay.innerHTML = MICON[cur().paused ? 'play' : 'pause'];
    const n = listEl?.querySelector('[aria-current] .mp-qnum'); if (n) n.innerHTML = MICON[cur().paused ? 'pause' : 'play'];
  }
  function setList(on) {
    listOpen = on;
    try { localStorage.setItem('outliner.mplayer.list', on ? '1' : '0'); } catch {}
    paint();
  }
  function paintList() {
    listEl.hidden = !listOpen;
    listBtn.setAttribute('aria-pressed', listOpen);
    if (!listOpen) return;
    listEl.replaceChildren(...order.map((k, i) => {
      const it = queue[k];
      const li = mk('li');
      const b = mk('button', 'mp-qitem'); b.type = 'button'; b.dataset.at = i;
      if (i === at) b.setAttribute('aria-current', 'true');
      const num = mk('span', 'mp-qnum');
      if (i === at) num.innerHTML = MICON[cur().paused ? 'pause' : 'play']; else num.textContent = i + 1;
      const name = mk('span', 'mp-qname'); name.textContent = it.label;
      const kind = mk('span', 'mp-qkind'); kind.textContent = it.kind === 'video' ? '영상' : '';
      b.append(num, name, kind); li.append(b);
      return li;
    }));
    listEl.querySelector('[aria-current]')?.scrollIntoView({ block: 'nearest' });
  }
  function paint() {
    const it = queue[order[at]];
    title.textContent = it ? it.label : '';
    count.textContent = queue.length > 1 ? `${at + 1} / ${queue.length}` : '';
    bar.classList.toggle('video', it?.kind === 'video');
    bar.classList.toggle('list', queue.length > 1);
    shuffleBtn.setAttribute('aria-pressed', shuffled);
    paintList();
    mirror();
    persist();
  }
  // 목록의 i번째로: 그 곡이 화면의 항목 안에 있으면 거기서, 아니면 막대에서
  // 화면에 있는 항목 안의 그 곡 요소
  function inlineEl(url) {
    const href = new URL(url, location.href).href;
    return [...document.querySelectorAll('#tree audio, #tree video, #titleatt audio, #titleatt video')].find((x) => x.src === href && x.isConnected) || null;
  }
  // 막대가 재생하는 동안 · 막대에서 위치를 옮겼을 때 항목 안의 같은 곡도 같은 위치를 가리키게 (멈춰 있는 것만)
  function mirror(moved = false) {
    if (ext || !media.getAttribute('src')) { if (toNodeBtn) toNodeBtn.hidden = true; return; }
    lastMirror = media.currentTime;
    const it = queue[order[at]];
    const el = it && inlineEl(it.url);
    toNodeBtn.hidden = !el;
    if (el && (moved || !media.paused) && el.paused && el.readyState >= 1 && Math.abs(el.currentTime - media.currentTime) > 0.5) el.currentTime = media.currentTime;
  }
  // 항목 안에서 위치를 옮김 → 막대가 같은 곡을 멈춘 채 들고 있으면 막대도 그 위치로 (다시 되돌리지 않게)
  function inlineSeeked(el, url) {
    if (ext || !media?.getAttribute('src') || !media.paused || queue[order[at]]?.url !== url) return;
    if (Math.abs(media.currentTime - el.currentTime) > 0.5) media.currentTime = el.currentTime;
  }
  // 막대 → 항목 안 (위치 · 구간 반복 · 목록은 follow가 넘겨받아요)
  function toNode() {
    const it = queue[order[at]];
    const el = it && inlineEl(it.url);
    if (!el) { toNodeBtn.hidden = true; return toast('이 곡의 항목이 지금 화면에 없어요'); }
    el.closest('.att-audio, .att-vid')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    el.play().catch(() => {});
  }
  // 항목 안 → 막대: 그 자리부터, 구간 반복 · 한 곡 반복도 그대로
  function toBar() {
    if (!ext) return;
    const e = ext, t = e.currentTime, st = { ...(mediaCtl.get(e)?.st || {}) };
    ext = null; bar.classList.remove('follow');
    e.pause();
    go(at, t);
    ctl.set({ loopA: st.loopA ?? null, loopB: st.loopB ?? null, repeat: st.repeat === 'one' ? 'one' : ctl.st.repeat });
  }
  function playAt(i) {
    const it = queue[order[i]];
    if (!it) return;
    const el = ext && inlineEl(it.url);
    if (el) { if (el !== ext) ext.pause(); el.currentTime = 0; el.play().catch(() => go(i)); } else go(i);
  }
  // 항목 안의 곡이 (반복 없이) 끝남 → 목록의 다음 곡
  function inlineEnded(el) {
    if (el !== ext) return;
    if (at + 1 < order.length) playAt(at + 1);
    else if (ctl.st.repeat === 'all') { if (shuffled) order = shuffleAll(queue.length); playAt(0); }
    else paintNow();
  }
  // 항목 안에서 재생 시작 → 같은 계층과 그 하위의 오디오 · 영상으로 재생 목록 (둘 이상일 때만)
  let followSeq = 0;
  async function follow(el, url) {
    const seq = ++followSeq;
    const f = fileItem(url);
    const track = () => { if (!tracked.has(el)) { tracked.add(el); for (const ev of ['play', 'pause']) el.addEventListener(ev, () => { if (ext === el) paintNow(); }); } };
    if (!ext && bar && !bar.hidden && media.getAttribute('src') && queue[order[at]]?.url === url) {
      // 막대에 있던 곡을 항목 안에서 재생 → 막대의 위치 · 구간 반복 · 한 곡 반복 · 목록 그대로 넘겨받기
      const t = media.currentTime, st = { ...ctl.st };
      if (t > 0 && Math.abs(el.currentTime - t) > 0.5) el.currentTime = t;
      mediaCtl.get(el)?.set({ loopA: st.loopA, loopB: st.loopB, repeat: st.repeat === 'one' ? 'one' : 'off' });
      media.pause(); media.removeAttribute('src'); media.load();
      ext = el; track(); ctl.set({ loopA: null, loopB: null });
      bar.classList.add('follow'); paint(); paintNow(); mirror();
      return;
    }
    if (ext) { // 이미 따라가는 목록에 있는 곡이면 목록(섞은 순서도) 그대로
      const j = order.findIndex((k) => queue[k].url === url && queue[k].nodeId === f.nodeId);
      if (j >= 0) { ext = el; at = j; track(); paint(); paintNow(); return; }
    }
    // 같은 계층의 형제 항목과 그 하위 항목 전부 (화면 순서대로 — 접혀 있어 아직 안 불러온 것도)
    const items = f.nodeId == null ? [] : await mediaUnder(f.parentId).catch(() => []);
    if (seq !== followSeq || el.paused) return; // 그새 다른 곡을 눌렀거나 멈춤
    const i = items.findIndex((x) => x.url === url && x.nodeId === f.nodeId);
    if (items.length < 2 || i < 0) { if (ext) { ext = null; close(); } return; }
    if (!bar) build();
    if (media.getAttribute('src')) { save(true); media.pause(); media.removeAttribute('src'); media.load(); }
    ext = el; track();
    queue = items; order = items.map((_, k) => k); at = i; source = { id: f.parentId };
    bar.hidden = false; bar.classList.add('follow');
    if (shuffled) setShuffle(true); else paint();
    paintNow();
  }
  function unfollow() { if (!ext) return; const e = ext; ext = null; bar.classList.remove('follow'); if (!e.paused) e.pause(); }
  function go(i, startAt = 0, autoplay = true) {
    if (i < 0 || i >= order.length) return;
    unfollow();
    save(true);
    at = i;
    ctl.reset(); // 구간 반복은 곡마다
    const it = queue[order[at]];
    media.src = it.url;
    lastSave = -1;
    media.addEventListener('loadedmetadata', () => { if (startAt && startAt < media.duration - 1) media.currentTime = startAt; if (autoplay) media.play().catch(() => {}); }, { once: true });
    paint();
  }
  // 섞기: 지금 곡은 그대로 두고 나머지 순서만 바꿔요 (끄면 원래 순서로, 지금 곡 다음부터)
  function setShuffle(on) {
    shuffled = on;
    const cur = order[at] ?? 0;
    const rest = queue.map((_, k) => k).filter((k) => k !== cur);
    if (on) for (let k = rest.length - 1; k > 0; k--) { const j = Math.floor(Math.random() * (k + 1)); [rest[k], rest[j]] = [rest[j], rest[k]]; }
    order = on ? [cur, ...rest] : queue.map((_, k) => k);
    at = order.indexOf(cur);
    paint();
  }
  function play(items, { shuffle = false, startAt = 0, from = null } = {}) {
    if (!items.length) return;
    if (!bar) build();
    queue = items; shuffled = shuffle; source = from;
    order = shuffle ? shuffleAll(items.length) : items.map((_, k) => k);
    bar.hidden = false;
    go(0, startAt);
  }
  // 새로고침해도 이어지게: 재생 목록 · 지금 곡 · 섞기 · 반복을 이 브라우저에 기억 (위치는 곡마다 DB에 따로 저장돼요)
  const SESSION = 'outliner.mplayer.session';
  function persist() {
    try {
      if (!queue.length) localStorage.removeItem(SESSION);
      else localStorage.setItem(SESSION, JSON.stringify({ queue, order, at, shuffled, repeat: ctl?.st.repeat || 'off', src: source ? source.id : undefined }));
    } catch {}
  }
  // 앱을 열 때 지난번 재생 막대를 그대로 띄워요 — 브라우저가 저절로 소리 내는 것을 막아서, 멈춘 채로 그 위치에 두고 ▶로 이어서
  async function restore() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(SESSION) || 'null'); } catch {}
    if (!saved?.queue?.length || !saved.order?.length || !(saved.at >= 0 && saved.at < saved.order.length)) return;
    if (bar && !bar.hidden) return; // 그새 재생을 시작함
    await mediaPosReady;
    if (!bar) build();
    queue = saved.queue; order = saved.order; shuffled = !!saved.shuffled; source = 'src' in saved ? { id: saved.src } : null;
    bar.hidden = false;
    ctl.set({ repeat: saved.repeat || 'off' });
    go(saved.at, mediaPos.get(queue[order[saved.at]].url)?.t || 0, false);
  }
  // ---- 노드 순서 따라가기: 목록을 만든 항목 아래가 바뀌면 다시 받아 맞춰요 (지금 곡 · 위치는 그대로) ----
  const itemKey = (x) => `${x.nodeId}|${x.url}`;
  let resyncTimer = 0, resyncSeq = 0;
  const scheduleResync = () => {
    if (!source || !bar || bar.hidden) return;
    clearTimeout(resyncTimer);
    resyncTimer = setTimeout(resync, 700);
  };
  for (const ev of ['render', 'node:update', 'node:create', 'node:delete']) (listeners[ev] ||= []).push(scheduleResync);
  async function resync() {
    if (!source || bar.hidden) return;
    const seq = ++resyncSeq, src = source;
    const items = await mediaUnder(src.id).catch(() => null);
    if (!items || seq !== resyncSeq || src !== source || bar.hidden) return;
    const cur = queue[order[at]];
    if (items.length === queue.length && items.every((x, k) => itemKey(x) === itemKey(queue[k]) && x.label === queue[k].label)) return; // 그대로
    const curKey = cur && itemKey(cur);
    let next = items.slice(), nOrder;
    if (cur && !next.some((x) => itemKey(x) === curKey)) next.splice(Math.min(at, next.length), 0, cur); // 지금 곡이 목록에서 빠졌어도 끝까지는 들어요
    if (shuffled) { // 섞은 순서는 그대로: 남은 곡은 그 순서대로, 새 곡은 끝에
      const idx = new Map(next.map((x, k) => [itemKey(x), k]));
      nOrder = order.map((k) => idx.get(itemKey(queue[k]))).filter((k) => k != null);
      const seen = new Set(nOrder);
      next.forEach((_, k) => { if (!seen.has(k)) nOrder.push(k); });
    } else nOrder = next.map((_, k) => k);
    queue = next; order = nOrder;
    at = Math.max(0, order.findIndex((k) => itemKey(queue[k]) === curKey));
    paint();
  }
  function close() { ext = null; source = null; bar.classList.remove('follow'); save(true); media.pause(); media.removeAttribute('src'); media.load(); bar.hidden = true; queue = []; order = []; at = -1; ctl.reset(); persist(); }
  return {
    play, follow, inlineEnded, inlineSeeked, restore,
    // 항목 안에서 재생하던 것이 화면에서 사라짐(접기 · 화면 이동) → 그 자리부터, 구간 반복 · 반복 설정도 그대로 이 막대에서 이어서
    takeOver(url, t, st) {
      const f = fileItem(url);
      if (!f) return;
      if (ext && queue[order[at]]?.url === url) { ext = null; bar.classList.remove('follow'); go(at, t); } // 따라가던 목록 그대로
      else play([f], { startAt: t }); // 한 곡만 — 따라 맞출 목록 없음
      if (st) ctl.set({ repeat: st.repeat, loopA: st.loopA, loopB: st.loopB });
    },
    // 항목 안의 플레이어를 재생하면 막대는 멈춤
    pauseFor(el) { if (media && el !== media && !media.paused) media.pause(); },
    // 북마크 링크: 막대가 그 곡을 재생 중이면 그 자리로, 아니면 그 곡을 그 자리부터
    jump(url, t) {
      if (bar && !bar.hidden && !ext && queue[order[at]]?.url === url) { media.currentTime = t; media.play().catch(() => {}); }
      else this.takeOver(url, t);
    },
  };
})();
player.restore();
/** 북마크 링크로 열기: 화면에 그 파일의 플레이어가 있으면 거기서, 없으면 아래 재생 막대에서 — 그 시간부터 재생 */
function openMediaAt(url, t) {
  const card = mediaEls.get(url), el = card?.isConnected ? (card.matches('audio, video') ? card : card.querySelector('audio, video')) : null;
  if (!el) return player.jump(url, t);
  card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  const go = () => mediaPosReady.then(() => { el.currentTime = t; el.play().catch(() => {}); }); // 마지막 재생 위치로 이어 가기보다 나중에
  if (el.readyState >= 1) go(); else el.addEventListener('loadedmetadata', go, { once: true });
}
/** 첨부 주소 → 재생 목록 한 칸 { url, kind, label, nodeId, parentId } (그 파일이 들어 있는 항목을 찾아서) */
function fileItem(url, node = null) {
  node ??= [...state.nodes.values()].find((n) => n.content.includes(url)) || null;
  const f = node ? fileTokens(node.content).find((x) => x.url === url) : null;
  const kind = f?.kind || (/\.(mp4|webm|mov|m4v|ogv)$/i.test(url) ? 'video' : 'audio');
  const text = node ? node.content.replace(/!?\[[^\]]*\]\([^)]*\)/g, '').trim() : '';
  return { url, kind, nodeId: node?.id ?? null, parentId: node?.parent_id ?? null, label: text || f?.name || url.split('/').pop() };
}
/** 항목 아래 모든 하위 항목의 오디오 · 영상 → 재생 목록 (화면 순서대로) */
async function mediaUnder(id) {
  await flushAll();
  const r = await http(`/api/subtree?root=${ck(id)}`);
  const byParent = new Map();
  for (const n of r.nodes || []) { const k = n.parent_id ?? null; (byParent.get(k) || byParent.set(k, []).get(k)).push(n); }
  for (const list of byParent.values()) list.sort((a, b) => a.position - b.position);
  const out = [];
  (function walk(pid) {
    for (const n of byParent.get(pid) || []) {
      for (const f of fileTokens(n.content)) if (f.kind === 'audio' || f.kind === 'video') out.push(fileItem(f.url, n));
      walk(n.id);
    }
  })(id);
  return out;
}
/** 커서 항목(없으면 지금 화면)의 하위 미디어를 차례로 · 섞어서 재생 */
async function playUnder(shuffle) {
  const id = pal.prevId ?? state.focusId ?? state.zoom;
  const items = await mediaUnder(id);
  if (!items.length) return toast('이 항목의 하위에는 오디오 · 영상이 없어요');
  player.play(items, { shuffle, from: { id } });
  toast(`${shuffle ? '섞어서' : '차례로'} ${items.length}개 재생`);
}

export { mediaPos, mediaPosReady, posTimers, saveMediaPos, mediaEls, reuseMedia, mediaWithPos, mediaCtl, MSVG, MICON, mediaBtn, mediaLoops, loadLoops, saveLoops, addLoop, removeLoop, REPEAT_NAME, mediaControls, inlinePlayer, player, openMediaAt, fileItem, mediaUnder, playUnder };
