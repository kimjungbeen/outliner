import { booted } from './progress.js';
import { addFiles, attachEl, attachTimers, scheduleAttach } from './attach.js';
import { $, CLIENT_ID, emit, http, listeners, mk, postForm, state, timers, toast } from './base.js';
import { askChoice, confirmDelete, modalOpen } from './dialog.js';
import { imgViewer } from './imgview.js';
import { FILE_RE, chInsert as chIns, chRemove as chRem, dropTarget, dropZone, fileTokens, flattenJson, hlDark, linkifyPaste, mdLinks, mdSegments, movesIntoSelf, parseHtml, parsePaste } from './lib.js';
import { mergeMarks } from './marks.js';
import { loadImgInk, loadImgMarks, loadMediaMarks, loadPdfMarks } from './markup.js';
import { loadLoops, openMediaAt } from './media.js';
import { initMobile } from './mobile.js';
import { inSelBar, inTagMenu, loadCmdPrefs, pal, paletteCommands, paletteOpen, runCommandNow, setHighlight, updateHlBar } from './commands.js';
import { pdfFolded } from './pdf.js';
import './tooltip.js';
import { openCommandList } from './cmdlist.js';
import { apiFor } from './api.js';
import { printHtml } from './print.js';
import { applyHeading, applyMd, blockBrowserFmt, fmtBar, headingOf, hlSet, mdWrapped, selOffsets } from './format.js';
 // 아이콘 · 단추에 마우스를 올리면 하는 일을 보여줘요

const PAGE = 300;
const ck = (id) => (id === null ? 'root' : id);
const create = async (parent_id, position, content = '') => (await http('/api/nodes', 'POST', { parent_id, position, content })).id;
const patch = (id, body) => http(`/api/nodes/${id}`, 'PATCH', body);

// 화면은 서버 응답을 기다리지 않고 먼저 바뀌어요(새 항목 · 삭제 · 접기). 서버에 보내는 일은 이 줄(wq)에 순서대로 서요.
// 다른 요청은 flushAll()로 이 줄이 비기를 기다린 뒤에 나가서, "만들기 → 수정 → 삭제" 순서가 뒤집히지 않아요.
let wq = Promise.resolve();
let leaving = false; // 페이지를 떠나는 중에 끊긴 요청은 오류가 아니에요
addEventListener('pagehide', () => { leaving = true; });
addEventListener('pageshow', () => { leaving = false; });
const logErr = (e) => { if (!leaving) console.error(e); };
addEventListener('unhandledrejection', (e) => { if (leaving || /Failed to fetch|Load failed|NetworkError/i.test(String(e.reason?.message ?? e.reason))) e.preventDefault(); }); // 떠나는 중 · 서버가 잠깐 끊긴 요청은 조용히
const later = (fn) => { wq = wq.then(fn).catch(logErr); };

// 새 항목 id를 서버에서 미리 받아 둬요 → Enter를 누르는 순간 바로 진짜 id로 만들 수 있어요.
const idPool = [];
let refilling = null;
function refillIds() {
  if (refilling) return refilling;
  refilling = http('/api/reserve', 'POST', { n: 100 }).then((r) => { for (let i = 0; i < r.count; i++) idPool.push(r.first + i); })
    .catch(logErr).finally(() => { refilling = null; });
  return refilling;
}
async function newId() {
  if (idPool.length < 30) refillIds();
  while (!idPool.length) await refillIds();
  return idPool.shift();
}
function newIdNow() { // 풀에 있으면 기다리지 않고 바로 (없을 때만 null)
  if (idPool.length < 30) refillIds();
  return idPool.length ? idPool.shift() : null;
}
/** 화면에 먼저 새 항목을 만들었어요 → 서버에는 순서대로 저장 */
function saveNew(node, parent, index) {
  later(async () => {
    if (timers.has(node.id)) { clearTimeout(timers.get(node.id)); timers.delete(node.id); } // 아래 content에 이미 담겨요
    await http('/api/nodes', 'POST', { id: node.id, parent_id: parent, position: index, content: node.content });
  });
}

// ---- 데이터 (부분 로딩) ----
function upsert(n) {
  const o = state.nodes.get(n.id);
  if (!o) { state.nodes.set(n.id, { ...n }); return; }
  const dirty = timers.has(n.id); // 아직 저장 안 된 내 입력은 서버 값으로 덮지 않아요
  const keep = o.content;
  Object.assign(o, n);
  if (dirty) o.content = keep;
}
function ingest(view) {
  for (const n of view.nodes) upsert(n);
  for (const [k, l] of Object.entries(view.lists)) {
    state.ch.set(k === 'root' ? null : +k, { ids: l.ids, total: l.total, show: Math.max(PAGE, l.ids.length) });
  }
}
const hasKids = (n) => (state.ch.has(n.id) ? state.ch.get(n.id).total > 0 : !!n.hk);
const isOpen = (n) => hasKids(n) && !n.collapsed;
const kidNodes = (pid) => (state.ch.get(pid)?.ids ?? []).map((id) => state.nodes.get(id)).filter(Boolean);

function chInsert(pid, id, idx) {
  const c = state.ch.get(pid);
  const inside = chIns(c, id, idx);
  if (inside && (idx ?? c.ids.length - 1) <= c.show) c.show++; // 보이던 항목은 그대로 보이고 새 항목도 보이게 ('더 보기' 경계에서 밀려나지 않게)
  const pn = state.nodes.get(pid);
  if (pn) pn.hk = 1;
  return inside;
}
function chRemove(pid, id) {
  const c = state.ch.get(pid);
  const had = chRem(c, id);
  const pn = state.nodes.get(pid);
  if (pn && c) pn.hk = c.total > 0 ? 1 : 0;
  return had;
}
function purge(id) {
  const c = state.ch.get(id);
  if (c) for (const cid of c.ids) purge(cid);
  state.ch.delete(id);
  state.nodes.delete(id);
  state.sel.delete(id);
}

let loadToken = 0;
async function loadZoom({ skipSame = false } = {}) {
  const token = ++loadToken;
  const cur = state.ch.get(state.zoom);
  const page = Math.min(5000, Math.max(PAGE, cur?.ids.length ?? 0));
  const q = `parent=${ck(state.zoom)}&page=${page}` + (state.ensure !== null ? `&ensure=${state.ensure}` : '');
  const v = await http(`/api/view?${q}`);
  if (token !== loadToken) return; // 그 사이 다른 화면으로 이동했어요
  state.ensure = null;
  if (v.error) { state.zoom = null; history.replaceState(null, '', location.pathname); return loadZoom(); }
  const sig = `${state.zoom}|${JSON.stringify(v)}`;
  if (skipSame && sig === state.viewSig && !state.focusFirst) return false; // 다른 창이 고친 게 이 화면과 상관없으면 다시 그리지 않아요 (깜빡임 없음)
  state.viewSig = sig;
  state.ch.clear();
  ingest(v);
  state.path = v.path;
  if (v.node) upsert(v.node);
  if (state.focusFirst) { // Alt+↓ 로 들어왔으면 첫 자식에 커서 (키보드만으로 계속 들어갈 수 있게)
    state.focusFirst = false;
    const k = state.ch.get(state.zoom)?.ids?.[0];
    if (k != null) { state.focusId = k; state.focusPos = 'end'; }
    else state.focusTitle = true; // 하위가 없는 항목이면 제목에 커서 → Enter로 첫 하위 항목을 만들어요
  }
  render();
  if (state.focusTitle) { state.focusTitle = false; const t = $('#title'); if (!t.hidden) setCaret(t, 'end'); }
  settleFlash();
}
const refresh = () => loadZoom();

// ---- 여러 브라우저 동기화 ----
// 다른 화면에서 바뀌면 서버가 알려줘요 → 내 미저장 글을 먼저 저장한 뒤 현재 화면을 다시 받아 그려요 (커서 · 선택은 유지).
let composing = false, remoteTimer = 0, remoteBusy = false, sseOpened = false;
addEventListener('compositionstart', () => { composing = true; }, true);
addEventListener('compositionend', () => { composing = false; }, true);
function scheduleRemote(delay = 300) { clearTimeout(remoteTimer); remoteTimer = setTimeout(applyRemote, delay); }
// 다른 화면의 변경을 받아 다시 그릴 때 화면이 움직이지 않게: 지금 맨 위에 보이는 행과 그 위치를 기억했다가 그대로 맞춰요.
// (펼쳐진 하위를 나중에 받아 그릴 때도 잠깐 동안 같은 기준으로 다시 맞춰요)
let keepScroll = null;
function scrollAnchor() {
  // 커서가 있는 줄이 화면에 보이면 그 줄을 기준으로 (다시 그려도 커서 줄이 같은 높이에 있게)
  const a = document.activeElement;
  const fid = state.focusId ?? (a?.classList?.contains('text') && a.dataset.id ? +a.dataset.id : null);
  if (fid != null) {
    const r = document.querySelector(`#tree .row[data-id="${fid}"]`);
    if (r) { const b = r.getBoundingClientRect(); if (b.bottom > 0 && b.top < innerHeight) return { id: String(fid), top: b.top, y: scrollY, focus: true }; }
  }
  for (const r of document.querySelectorAll('#tree .row')) {
    const b = r.getBoundingClientRect();
    if (b.bottom > 0 && b.height) return { id: r.dataset.id, top: b.top, y: scrollY };
  }
  return { id: null, top: 0, y: scrollY };
}
function restoreAnchor(a) {
  if (!a) return;
  const r = a.id != null && document.querySelector(`#tree .row[data-id="${a.id}"]`);
  if (r) { const d = r.getBoundingClientRect().top - a.top; if (Math.abs(d) >= 1) scrollBy(0, d); } else if (Math.abs(scrollY - a.y) >= 1) scrollTo(0, a.y);
}
function stopKeepScroll() { keepScroll = null; }
for (const ev of ['wheel', 'touchmove', 'keydown', 'mousedown']) addEventListener(ev, stopKeepScroll, { passive: true, capture: true });
async function applyRemote() {
  if (remoteBusy) return scheduleRemote();
  if (composing || drag.on || rangeDrag.active || paletteOpen()) return scheduleRemote(500); // 한글 조합 · 드래그 중에는 끝난 뒤에
  remoteBusy = true;
  try {
    await flushAll();
    const a = document.activeElement;
    if (a?.classList?.contains('text') && a.dataset.id) { state.focusId = +a.dataset.id; state.focusPos = caretOffset(a); }
    document.body.classList.add('syncing'); // 위쪽 행들도 실제 높이로 → 기준 행 위치를 정확히 재요
    const anchor = scrollAnchor();
    keepScroll = anchor;
    const tree = $('#tree');
    tree.style.minHeight = tree.offsetHeight + 'px'; // 다시 그리는 동안 높이가 잠깐 줄어 화면이 튀지 않게
    document.documentElement.style.overflowAnchor = 'none'; // 브라우저의 자동 스크롤 보정 대신 아래에서 직접 맞춰요
    setTimeout(() => { tree.style.minHeight = ''; document.documentElement.style.overflowAnchor = ''; }, 1000);
    let drew = true;
    try { drew = (await loadZoom({ skipSame: true })) !== false; } finally { restoreAnchor(anchor); }
    if (!drew) { state.focusId = state.focusPos = null; document.body.classList.remove('syncing'); keepScroll = null; return; } // 그대로라 커서도 그대로
    // 한 번 실제 크기로 그려진 뒤에 건너뛰기를 다시 켜요 (그래야 브라우저가 그 크기를 기억해서 위치가 안 바뀌어요)
    const again = () => { if (keepScroll === anchor) restoreAnchor(anchor); };
    requestAnimationFrame(() => requestAnimationFrame(() => { document.body.classList.remove('syncing'); again(); }));
    for (const ms of [50, 150, 400, 900]) setTimeout(again, ms);
    setTimeout(() => { if (keepScroll === anchor) keepScroll = null; }, 2000);
  } catch (e) { logErr(e); } finally { remoteBusy = false; }
}
let syncEpoch = null;
// 실시간 연결은 브라우저마다 '하나'만 열어요. 브라우저는 한 주소에 동시에 6개까지만 연결해서, 창(탭)마다 실시간 연결을 열어 두면
// 창을 6개 넘게 띄웠을 때 새 창 · 새로고침이 빈자리를 기다리며 '계속 로딩'에 멈춰요.
// 그래서 창들 중 하나(Web Locks로 정한 담당)만 연결하고, 받은 소식은 BroadcastChannel로 다른 창에 나눠 줘요.
// 담당 창이 닫히면 다른 창이 자동으로 이어받아요.
function onSyncData(raw) {
  let d = null;
  try { d = JSON.parse(raw); } catch { /* 형식이 이상하면 그냥 새로 받아요 */ }
  if (d?.epoch) { // DB가 통째로 바뀌었으면 새로고침: 미리 받아 둔 새 항목 번호가 새 DB의 항목과 겹쳐 덮어쓰지 않게
    if (syncEpoch && d.epoch !== syncEpoch) { location.reload(); return; }
    syncEpoch = d.epoch;
  }
  if (d && d.origins.every((o) => o === CLIENT_ID)) return;
  scheduleRemote();
}
const onSyncOpen = () => { if (sseOpened) scheduleRemote(0); sseOpened = true; }; // 끊겼다 다시 연결되면 놓친 변경을 받아요
function openEventSource(bc) {
  const es = new EventSource('/api/events');
  es.onopen = () => { onSyncOpen(); bc?.postMessage({ type: 'open' }); };
  es.onmessage = (e) => { onSyncData(e.data); bc?.postMessage({ type: 'msg', data: e.data }); };
  return es;
}
function connectSync() {
  if (!globalThis.EventSource) return;
  if (!navigator.locks || !globalThis.BroadcastChannel) { openEventSource(null); return; } // 아주 오래된 브라우저: 창마다
  const bc = new BroadcastChannel('outliner-sync');
  bc.onmessage = (e) => { if (e.data?.type === 'msg') onSyncData(e.data.data); else if (e.data?.type === 'open') onSyncOpen(); };
  http('/api/ping').then((r) => { if (r?.epoch && !syncEpoch) syncEpoch = r.epoch; }).catch(() => {}); // 담당이 아니어도 DB 교체를 알아채게
  navigator.locks.request('outliner-sync-leader', () => new Promise(() => { // 이 창이 담당이 되면 연결을 열고, 창이 닫힐 때까지 쥐고 있어요
    let es = openEventSource(bc);
    addEventListener('pagehide', () => es.close());
    addEventListener('pageshow', (e) => { if (e.persisted && es.readyState === 2) es = openEventSource(bc); });
  }));
}

function settleFlash() {
  const id = state.flash;
  if (id === null) return;
  state.flash = null;
  const el = document.querySelector(`#tree .text[data-id="${id}"]`);
  if (el) {
    const row = el.closest('.row');
    row.scrollIntoView({ block: 'center' });
    row.classList.add('flash');
    setTimeout(() => row.classList.remove('flash'), 1600);
  } else if (state.nodes.has(id) && state.zoom !== id) setZoom(id); // 너무 뒤쪽 항목이면 그 항목 안으로 들어가요
}

// ---- 커서 ----
function caretOffset(el) {
  const s = getSelection();
  if (!s.rangeCount) return 0;
  const cur = s.getRangeAt(0);
  const r = cur.cloneRange();
  r.selectNodeContents(el);
  r.setEnd(cur.endContainer, cur.endOffset);
  return r.toString().length;
}
/** 글자 칸 안의 p번째 글자 자리 → [텍스트 노드, 그 안의 위치] (마크다운 서식 때문에 칸 안에 조각이 여럿일 수 있어요) */
function textPoint(el, p) {
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let last = null;
  for (let t = w.nextNode(); t; t = w.nextNode()) {
    if (p <= t.length) return [t, p];
    p -= t.length; last = t;
  }
  return last ? [last, last.length] : [el, 0];
}

// ---- 마크다운 모양 (앱 기본): 글(기호 포함)은 그대로 두고 보이는 모양만 꾸며요 (**굵게** · *기울임* · `코드` · ~~취소~~ · ==형광== · # 제목 · > 인용 · ---) ----
// 어디가 서식인지는 lib.js의 mdSegments (plain · 내보내기도 같은 규칙). 플러그인은 글 모양에 끼어들지 않아요 — 서식을 넣는 명령(bold · highlight …)만 있어요
const mdSig = (md) => (md ? `${md.block}|${md.segs.map((x) => `${x.k}${x.bg ?? ''}${x.t.length}`).join(',')}` : '');
/** el에 글을 넣으며 서식 조각으로 나눠요. 같은 모양이면 건드리지 않아요 (커서가 흔들리지 않게) */
function paintText(el, content, { block = true } = {}) {
  const md = mdSegments(content), sig = mdSig(md);
  if (el.textContent === content && (el._md ?? '') === sig) return false;
  el._md = sig;
  if (block && md?.block) el.dataset.md = md.block; else delete el.dataset.md;
  if (!md) { el.textContent = content; return true; }
  el.replaceChildren(...md.segs.map((x) => {
    if (!x.k) return document.createTextNode(x.t);
    const sp = document.createElement('span'); sp.className = x.k.split(' ').map((k) => `md-${k}`).join(' '); sp.textContent = x.t;
    if (x.bg) { sp.style.backgroundColor = x.bg; sp.style.color = hlDark(x.bg) ? '#fff' : '#1d1d1f'; } // 형광펜: Gem처럼 불투명한 색 · 어두운 색이면 흰 글자
    return sp;
  }));
  return true;
}

/** 타이핑하는 동안: 잠깐 멈추면 모양을 다시 맞춰요 (커서 자리 그대로, 한글 조합 · 글자 선택 중에는 기다려요) */
function scheduleMdPaint(el, getContent, block = true) {
  clearTimeout(el._mdT);
  el._mdT = setTimeout(function again() {
    if (!el.isConnected) return;
    if (composing || (document.activeElement === el && !getSelection().isCollapsed)) { el._mdT = setTimeout(again, 300); return; }
    const content = getContent();
    const focused = document.activeElement === el, pos = focused ? caretOffset(el) : 0;
    if (paintText(el, content, { block }) && focused) { setCaret(el, pos, true); scheduleMarks(0, el); }
  }, 250);
}

/** ↑·↓를 브라우저에 맡긴 뒤, 첫 줄/마지막 줄이라 커서가 그대로면 글의 처음/끝으로 보내요 */
function edgeAfterDefault(el, before, back) {
  requestAnimationFrame(() => {
    if (document.activeElement !== el || !getSelection().isCollapsed) return;
    if (caretOffset(el) === before) setCaret(el, back ? 0 : 'end');
  });
}
function setCaret(el, pos, restoring = false) {
  const y0 = scrollY, still = !!keepScroll || restoring; // 커서를 '되돌릴' 때는 화면을 움직이지 않아요 (새 자리로 옮길 때만 따라가요)
  el.focus({ preventScroll: still });
  const len = el.textContent.length;
  const p = pos === 'end' || pos > len ? len : pos;
  const r = document.createRange();
  const [node, off] = textPoint(el, p);
  r.setStart(node, off);
  r.collapse(true);
  const s = getSelection();
  s.removeAllRanges();
  s.addRange(r);
  if (still && scrollY !== y0) scrollTo(0, y0); // 커서를 놓으며 브라우저가 스크롤한 것도 되돌려요
}
function captureFocus() {
  const a = document.activeElement;
  if (state.focusId !== null) return;
  if (a?.classList.contains('text') && a.dataset.id) {
    state.focusId = +a.dataset.id;
    state.focusRestore = state.focusId; // 다시 그리느라 잠깐 잃은 커서를 되돌리는 것 → 화면은 움직이지 않아요
    state.focusPos = caretOffset(a);
  } else if (a?.id === 'title' && state.zoom !== null) { // 제목 = 들어와 있는 항목: 다른 항목과 똑같이 '커서 항목'으로 (명령 · 플러그인이 이 항목을 써요)
    state.focusId = state.zoom;
    state.focusRestore = state.focusId;
    state.focusPos = caretOffset(a);
  }
}
/** 커서를 둘 글자 칸: 트리의 그 항목, 그 항목이 지금 들어와 있는 항목이면 제목 */
const textElOf = (id) => document.querySelector(`#tree .text[data-id="${id}"]`) ?? (id != null && id === state.zoom && !$('#title').hidden ? $('#title') : null);

// ---- 렌더링: 바뀐 부분만 다시 그려요 ----
const toLoad = new Set();
const loading = new Set();

const LINK_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M6.8 9.2a3 3 0 0 0 4.2 0l2-2a3 3 0 0 0-4.2-4.2l-.9.9M9.2 6.8a3 3 0 0 0-4.2 0l-2 2a3 3 0 0 0 4.2 4.2l.9-.9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const CARET = '<svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function childRows(pid) {
  const c = state.ch.get(pid);
  if (!c) return [];
  const shown = Math.min(c.show, c.ids.length);
  const out = [];
  for (let i = 0; i < shown; i++) {
    const n = state.nodes.get(c.ids[i]);
    if (n) out.push(rowFor(n));
  }
  if (shown < c.total) {
    const more = mk('div', 'more');
    more.textContent = `더 보기 (${c.total - shown}개 남음)`;
    more.tabIndex = 0;
    more.onclick = () => showMore(pid);
    more.onkeydown = (e) => { if (e.key === 'Enter') showMore(pid); };
    out.push(more);
  }
  return out;
}

async function showMore(pid) {
  const c = state.ch.get(pid);
  if (!c) return;
  const want = c.show + PAGE;
  if (c.ids.length < Math.min(want, c.total)) {
    const r = await http(`/api/children?parent=${ck(pid)}&offset=${c.ids.length}&limit=${want - c.ids.length}`);
    r.nodes.forEach(upsert);
    c.ids.push(...r.nodes.map((n) => n.id));
    c.total = r.total;
  }
  c.show = want;
  redrawParent(pid);
}

// ---- 태그 · 링크 색 (CSS Custom Highlight API: 글자를 고치지 않고 색만 입혀요. 지원하지 않는 브라우저에선 그냥 안 칠해져요) ----
const TAG_RE = /(?<![\p{L}\p{N}_])[#@][\p{L}\p{N}][\p{L}\p{N}_:-]*/gu;
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'）)\]]+[^\s<>"'）)\].,;:!?]/giu;
let marksTimer = 0;
function scheduleMarks(delay = 0, el = null) {
  if (!globalThis.CSS?.highlights) return;
  if (el && !marksTimer) { // 타이핑: 고친 칸만
    marksTimer = setTimeout(() => { marksTimer = 0; requestAnimationFrame(() => paintMarksOf(el)); }, delay);
    return;
  }
  clearTimeout(marksTimer);
  marksTimer = setTimeout(() => { marksTimer = 0; requestAnimationFrame(paintMarks); }, delay);
}
const markOf = new WeakMap(); // 글자 칸 → 그 칸에 칠한 범위들 (고친 칸만 다시 칠하려고)
const MARK_HINT = /[#@]|www\.|http|\/files\//i;
// 링크: [글자](주소)의 괄호 · 주소는 ** 같은 기호처럼 옅게(link), 글자만 파랗게(linktext). 단독 주소는 통째로 파랗게
function marksFor(el, tags, links, files, ltext) {
  markOf.delete(el);
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let t = w.nextNode(); t; t = w.nextNode()) {
    const v = t.nodeValue;
    if (!v || !MARK_HINT.test(v)) continue;
    const mine = [];
    for (const m of v.matchAll(FILE_RE)) { const r = new Range(); r.setStart(t, m.index); r.setEnd(t, m.index + m[0].length); files.push(r); mine.push(r); } // 첨부 표시는 옅게
    for (const l of mdLinks(v)) { // [ · 글자 · ](주소)
      const a = l.index + 1, b = a + l.label.length;
      for (const [x, y, to] of [[l.index, a, links], [a, b, ltext], [b, l.end, links]]) { const r = new Range(); r.setStart(t, x); r.setEnd(t, y); to.push(r); mine.push(r); }
    }
    for (const m of v.matchAll(URL_RE)) { if (mdLinks(v).some((l) => m.index >= l.index && m.index < l.end)) continue; const r = new Range(); r.setStart(t, m.index); r.setEnd(t, m.index + m[0].length); ltext.push(r); mine.push(r); } // 단독 주소는 파랗게
    for (const m of v.matchAll(TAG_RE)) {
      if (isInLink(v, m.index)) continue; // 주소 안의 #조각은 링크 색으로
      const r = new Range(); r.setStart(t, m.index); r.setEnd(t, m.index + m[0].length); tags.push(r); mine.push(r);
    }
    if (mine.length) markOf.set(el, (markOf.get(el) || []).concat(mine));
  }
}
function paintMarks() { // 화면 전체 (다시 그린 뒤). 글자 칸에 # @ http www 가 없으면 건너뛰어 빨라요
  const tags = [], links = [], files = [], ltext = [];
  for (const el of document.querySelectorAll('#title:not([hidden]), #tree .text')) { // 줌인한 제목도 같은 색
    const s = el.textContent;
    if (s.length < 2 || !MARK_HINT.test(s)) continue;
    marksFor(el, tags, links, files, ltext);
  }
  CSS.highlights.set('tag', new Highlight(...tags));
  CSS.highlights.set('link', new Highlight(...links));
  CSS.highlights.set('file', new Highlight(...files));
  CSS.highlights.set('linktext', new Highlight(...ltext));
}
function paintMarksOf(el) { // 타이핑 중에는 고친 칸 하나만 (전체를 훑지 않아요)
  const ht = CSS.highlights.get('tag'), hl = CSS.highlights.get('link'), hf = CSS.highlights.get('file'), hx = CSS.highlights.get('linktext');
  if (!ht || !hl || !hf || !hx) return paintMarks();
  for (const r of markOf.get(el) || []) { ht.delete(r); hl.delete(r); hf.delete(r); hx.delete(r); }
  markOf.delete(el);
  const tags = [], links = [], files = [], ltext = [];
  marksFor(el, tags, links, files, ltext);
  for (const r of tags) ht.add(r);
  for (const r of links) hl.add(r);
  for (const r of files) hf.add(r);
  for (const r of ltext) hx.add(r);
}
function isInLink(v, at) {
  for (const l of mdLinks(v)) if (at >= l.index && at < l.end) return true;
  for (const m of v.matchAll(URL_RE)) if (at >= m.index && at < m.index + m[0].length) return true;
  return false;
}
// 글 속 태그를 누르면: '태그'로 부르는 명령(api의 tag — ⌘/에서 켜고 끄기)을 불러요. 누른 태그가 첫 인자로 가요
// 하나면 바로, 여럿이면 태그 아래에 작은 메뉴(글자 메뉴와 같은 모양)로 골라요. 글자 자리에 정확히 눌렀을 때만 — 그 근처를 눌러 편집하는 건 그대로
const tagMenu = (() => {
  let box = null;
  const hide = () => { box?.remove(); box = null; };
  addEventListener('mousedown', (e) => { if (box && !box.contains(e.target)) hide(); }, true);
  addEventListener('keydown', (e) => { if (box && e.key === 'Escape') { e.preventDefault(); hide(); } }, true);
  addEventListener('scroll', hide, { passive: true, capture: true });
  return { hide, show(rect, tag, list) {
    hide();
    box = mk('div', 'fmt-bar tag-menu'); box.setAttribute('role', 'menu'); box.setAttribute('aria-label', `태그 ${tag}`);
    for (const c of list) {
      const b = mk('button', 'fmt-btn txt'); b.type = 'button'; b.textContent = c.name; b.title = c.label || c.name; // 다른 곳처럼 명령 이름 그대로
      b.onmousedown = (e) => e.preventDefault();
      b.onclick = () => { hide(); runCommandNow(c, tag); };
      box.append(b);
    }
    document.body.append(box);
    const x = Math.min(innerWidth - box.offsetWidth - 8, Math.max(8, rect.left));
    box.style.left = `${x}px`; box.style.top = `${rect.bottom + 6 + box.offsetHeight > innerHeight ? rect.top - box.offsetHeight - 6 : rect.bottom + 6}px`;
  } };
})();
document.addEventListener('click', (e) => {
  if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.button !== 0 || !getSelection().isCollapsed) return;
  const el = e.target.closest?.('.text, #title');
  if (!el) return;
  const list = [...paletteCommands.values()].filter(inTagMenu);
  if (!list.length) return;
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let t = w.nextNode(); t; t = w.nextNode()) {
    for (const m of t.nodeValue.matchAll(TAG_RE)) {
      if (isInLink(t.nodeValue, m.index)) continue;
      const r = new Range(); r.setStart(t, m.index); r.setEnd(t, m.index + m[0].length);
      for (const q of r.getClientRects()) {
        if (e.clientX < q.left || e.clientX > q.right || e.clientY < q.top || e.clientY > q.bottom) continue;
        if (list.length === 1) runCommandNow(list[0], m[0]); else tagMenu.show(q, m[0], list);
        return;
      }
    }
  }
});
// Ctrl/⌘+클릭으로 링크 열기
document.addEventListener('click', (e) => {
  if (!(e.ctrlKey || e.metaKey) || !e.target.closest?.('.text, #title')) return;
  const pos = document.caretPositionFromPoint?.(e.clientX, e.clientY);
  const node = pos?.offsetNode ?? document.caretRangeFromPoint?.(e.clientX, e.clientY)?.startContainer;
  const off = pos?.offset ?? document.caretRangeFromPoint?.(e.clientX, e.clientY)?.startOffset;
  if (node?.nodeType !== 3) return;
  for (const l of mdLinks(node.nodeValue)) {
    if (off >= l.index && off <= l.end) { e.preventDefault(); if (!openAppLink(l.url)) window.open(l.url, '_blank', 'noopener'); return; }
  }
  for (const m of node.nodeValue.matchAll(URL_RE)) {
    if (off >= m.index && off <= m.index + m[0].length) {
      e.preventDefault();
      if (!openAppLink(m[0])) window.open(/^https?:/i.test(m[0]) ? m[0] : 'https://' + m[0], '_blank', 'noopener');
      return;
    }
  }
});

function updateAdd() { // '항목 추가' 버튼은 이 화면에 노드가 하나도 없을 때만
  const c = state.ch.get(state.zoom);
  $('#add').hidden = !(c && c.total === 0);
}
function afterDraw() {
  updateAdd();
  scheduleMarks();
  if (state.hl.size) updateHlBar();
  if (state.focusId !== null && !paletteOpen() && !modalOpen()) { // 통합 창 · 명령 목록 · 플러그인 창이 열려 있으면 커서를 뺏어 오지 않아요 (창을 닫을 때 돌려줘요) — 그 사이 다른 창에서 고친 걸 받아 다시 그려도
    const el = textElOf(state.focusId);
    if (el) {
      const restoring = state.focusRestore === state.focusId;
      // 다른 창을 보고 있는데(여러 창 · 다른 창에서 고친 걸 받아 다시 그릴 때) 커서를 놓으면 focus()가 이 창을 앞으로 끌어와요 → 이 창으로 돌아올 때 놓아요
      if (!document.hasFocus()) caretLater = { id: state.focusId, pos: state.focusPos ?? 'end' };
      else setCaret(el, state.focusPos ?? 'end', restoring);
      state.focusId = state.focusPos = null; state.focusRestore = null;
    }
    else if (!toLoad.size && !loading.size) state.focusId = state.focusPos = null; // 더 기다릴 게 없으면 포기
  }
  paintSel();
  emit('render');
  kickLoads();
}

let caretLater = null; // 뒤에 있는 창이 다시 그리며 미뤄 둔 커서 { id, pos }
addEventListener('focus', () => { // 이 창으로 돌아오면: 다른 칸을 이미 누르지 않았으면 그 커서를 되돌려요
  const c = caretLater; caretLater = null;
  if (!c) return;
  const a = document.activeElement;
  if (a && a !== document.body && a.isConnected) return;
  const el = textElOf(c.id);
  if (el) setCaret(el, c.pos, true);
});

function kickLoads() { // 펼쳐져 있지만 아직 안 불러온 항목들을 불러와요
  const ids = [...toLoad].filter((id) => !loading.has(id));
  toLoad.clear();
  for (const id of ids) {
    loading.add(id);
    http(`/api/view?parent=${id}`).then((v) => {
      if (v.error) return;
      ingest(v);
      loading.delete(id);
      redraw(id);
      if (keepScroll) restoreAnchor(keepScroll);
    }).catch((e) => { console.error(e); loading.delete(id); });
  }
}

// ---- 화면을 다시 그려도 보던 자리가 움직이지 않게 ----
// 다시 그리기 전에 맨 위에 보이던 행과 위치를 재 두었다가, 그린 직후(커서를 놓기 전에) 같은 자리로 맞춰요.
// 커서를 놓으면서 생기는 스크롤은 '새 자리로 옮길' 때만 허용해요 (afterDraw · setCaret 참고).
let renderedZoom;
function stableRebuild(fn) {
  const same = renderedZoom === state.zoom;
  renderedZoom = state.zoom;
  if (!same) { fn(); scrollTo(0, 0); return; } // 다른 항목으로 들어가거나 나오면 맨 위부터
  document.body.classList.add('syncing'); // 화면 밖 행도 실제 높이로 재서 정확히 맞춰요
  document.documentElement.style.overflowAnchor = 'none';
  const a = scrollAnchor();
  fn();
  restoreAnchor(a);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    document.body.classList.remove('syncing');
    document.documentElement.style.overflowAnchor = '';
  }));
}
// 다시 그릴 때 이미 불러온 첨부 이미지는 같은 요소를 옮겨 써요 — 새로 만들면 디코딩하는 동안 잠깐 비어 보여 깜빡였어요
let imgPool = null;
function takeImg(url) { const l = imgPool?.get(url); return l?.length ? l.pop() : null; }
function rebuildTree() {
  imgPool = new Map();
  for (const im of document.querySelectorAll('#tree .att-img img')) { const k = im.getAttribute('src'); if (!imgPool.has(k)) imgPool.set(k, []); imgPool.get(k).push(im); }
  try { $('#tree').replaceChildren(...childRows(state.zoom)); renderHeader(); } finally { imgPool = null; }
  if (globalThis.CSS?.highlights) { clearTimeout(marksTimer); marksTimer = 0; paintMarks(); } // 태그 · 링크 색도 같은 프레임에 (늦게 칠하면 색이 빠졌다 돌아와 깜빡여요)
}
function render() {
  captureFocus();
  stableRebuild(rebuildTree);
  afterDraw();
}

function redraw(id, quiet = false) {
  if (id === state.zoom) { captureFocus(); stableRebuild(rebuildTree); if (!quiet) afterDraw(); return; }
  const old = document.querySelector(`#tree .node[data-nid="${id}"]`);
  const n = state.nodes.get(id);
  if (!old || !n) { if (!quiet) afterDraw(); return; }
  captureFocus();
  const a = scrollAnchor();
  const inside = a.id != null && +a.id !== id && old.querySelector(`.row[data-id="${a.id}"]`); // 보던 줄이 접히며 사라지는 경우는 그대로 둬요
  old.replaceWith(rowFor(n));
  if (!inside || a.focus) restoreAnchor(a); // 위쪽 항목을 접고 펼쳐도 보던 줄(커서 줄)은 제자리
  if (!quiet) afterDraw();
}
const redrawParent = (pid) => redraw(pid);
/** 여러 부모를 한꺼번에 다시 그려요 (다른 부모의 안쪽에 있는 것은 바깥 것이 그리므로 건너뜀). 커서 복원은 마지막에 한 번만 */
function redrawMany(pids) {
  const set = new Set(pids);
  for (const p of set) {
    const anc = [];
    for (let a = state.nodes.get(p)?.parent_id; a != null; a = state.nodes.get(a)?.parent_id) anc.push(a);
    if (anc.some((a) => set.has(a)) || (p !== state.zoom && set.has(state.zoom))) continue; // 현재 화면 전체를 다시 그리면 그 안은 함께 그려져요
    redraw(p, true);
  }
  afterDraw();
}

function rowFor(n) {
  const kids = hasKids(n), open = kids && !n.collapsed;
  const wrap = mk('div', 'node'), row = mk('div', 'row');
  wrap.dataset.nid = n.id;
  if (state.hl.has(n.id)) row.classList.add('found');

  const chev = mk('button', 'chev');
  chev.type = 'button';
  chev.tabIndex = -1;
  chev.innerHTML = CARET;
  if (kids) {
    chev.setAttribute('aria-expanded', String(!n.collapsed));
    chev.setAttribute('aria-label', n.collapsed ? '펼치기' : '접기');
    chev.onclick = () => toggle(n);
  } else chev.disabled = true;

  const bullet = mk('button', 'bullet');
  bullet.type = 'button';
  bullet.tabIndex = -1;
  bullet.setAttribute('aria-label', '이 항목으로 이동 (끌어서 옮기기)');
  if (n.collapsed && kids) bullet.classList.add('folded');
  bullet.onclick = () => { if (!drag.justEnded) zoomTo(n.id); };
  bullet.addEventListener('pointerdown', (e) => onBulletDown(e, n));

  const text = mk('div', 'text');
  text.contentEditable = 'true';
  text.spellcheck = false;
  text.dataset.id = n.id;
  paintText(text, n.content);
  text.addEventListener('input', () => onInput(n, text));
  text.addEventListener('focus', () => { if (!state.sel.size) state.anchor = state.head = n.id; }); // 키보드로 옮긴 커서도 시작점
  text.addEventListener('keydown', (e) => onKey(e, n, text));
  text.addEventListener('paste', (e) => onPaste(e, n, text));

  row.dataset.id = n.id;
  row.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.shiftKey && state.anchor !== null && state.anchor !== n.id) { e.preventDefault(); selectRange(state.anchor, n.id); } // 다른 항목을 Shift+클릭 = 항목 선택
    else if (e.shiftKey) { if (state.sel.size) clearSel(); } // 같은 항목 안에서는 평범한 글자 선택
    else if (e.ctrlKey || e.metaKey) { e.preventDefault(); toggleSel(n.id); }
    else if (state.sel.size && !(e.target.closest('.bullet') && state.sel.has(n.id))) clearSel(); // 선택된 항목의 점을 잡는 건 '함께 끌기'
    if (!e.shiftKey && !e.ctrlKey && !e.metaKey) state.anchor = state.head = n.id; // 커서를 둔 곳이 Shift+클릭 범위의 시작점
    if (!e.shiftKey && !e.ctrlKey && !e.metaKey && !e.target.closest('.bullet, .chev, input')) rangeDrag.anchor = n.id; // 글자 위에서 시작한 마우스 끌기
  });

  row.append(chev, bullet, text);
  wrap.append(row);
  const att = attachEl(n.content);
  if (att) wrap.append(att);
  if (open) {
    const box = mk('div', 'children');
    if (state.ch.has(n.id)) box.append(...childRows(n.id));
    else {
      const wait = mk('div', 'more');
      wait.textContent = '불러오는 중…';
      box.append(wait);
      toLoad.add(n.id);
    }
    wrap.append(box);
  }
  return wrap;
}

function renderHeader() {
  const crumbs = $('#crumbs'), title = $('#title');
  crumbs.replaceChildren();
  const zn = state.zoom !== null ? state.nodes.get(state.zoom) : null;
  crumbs.hidden = title.hidden = !zn;
  if (!zn) { syncTitleAttach(null); return; }
  const link = (label, id) => {
    const a = mk('a');
    a.textContent = label || '(빈 항목)';
    a.href = id === null ? '#' : `#${id}`;
    return a;
  };
  crumbs.append(link('홈', null));
  for (const p of state.path) crumbs.append('›', link(p.content, p.id));
  title.dataset.id = zn.id;
  if (document.activeElement !== title || title.textContent !== zn.content) paintText(title, zn.content, { block: false }); // 고치는 중이면 커서를 건드리지 않아요
  syncTitleAttach(zn.content);
}
function syncTitleAttach(content) { // 줌인한 항목 자신의 첨부(이미지 · 영상 · PDF) 미리보기를 제목 아래에
  const box = $('#titleatt');
  const sig = content ? fileTokens(content).map((f) => f.url).join('|') : '';
  if ((box.firstChild?.dataset.sig ?? '') === sig) return;
  box.replaceChildren();
  const el = content ? attachEl(content) : null;
  if (el) box.append(el);
}
// 제목(들어와 있는 항목)도 바로 고칠 수 있어요
{
  const title = $('#title');
  title.contentEditable = 'plaintext-only';
  if (title.contentEditable !== 'plaintext-only') title.contentEditable = 'true';
  title.spellcheck = false;
  title.addEventListener('input', () => {
    const n = state.nodes.get(+title.dataset.id);
    if (!n) return;
    n.content = title.textContent.replace(/\s*\n\s*/g, ' ');
    scheduleMdPaint(title, () => n.content, false);
    scheduleMarks(150, title);
    tagAcUpdate(title); // # · @ 태그 목록 — 제목도 다른 항목과 같아요
    clearTimeout(attachTimers.get('title'));
    attachTimers.set('title', setTimeout(() => syncTitleAttach(n.content), 250));
    clearTimeout(timers.get(n.id));
    timers.set(n.id, setTimeout(() => saveNow(n.id), 400));
  });
  title.addEventListener('keydown', async (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    const first = () => document.querySelector('#tree .text');
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.shiftKey && !e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { // 제목에서 ⌘↓↑: 이 화면 전체를 한 단계씩
      e.preventDefault(); e.stopPropagation(); foldStep(state.zoom, e.key === 'ArrowDown' ? 'down' : 'up', true); return;
    }
    if (undoKey(e)) return;
    if (blockBrowserFmt(e)) return;
    if (e.key === 'Tab' || (mod && e.shiftKey && !e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown'))) { // 제목(들어와 있는 항목)은 들여쓰기 · 옮기기 안 해요
      e.preventDefault(); e.stopPropagation(); return;
    }
    if (mod || e.altKey) return; // ⌘Enter 등은 아래 공통 단축키로 (명령 단축키는 commands.js가 먼저 받아요)
    if ((e.key === 'ArrowDown' || e.key === 'ArrowRight') && !e.shiftKey && getSelection().isCollapsed && caretOffset(title) < title.textContent.length) {
      if (e.key === 'ArrowDown') edgeAfterDefault(title, caretOffset(title), false); // 먼저 제목 끝까지
      return;
    }
    if (e.key === 'Enter' || ((e.key === 'ArrowDown' || e.key === 'ArrowRight') && !e.shiftKey && !e.altKey)) {
      e.preventDefault();
      let el = first();
      if (!el && e.key === 'Enter') { $('#add').click(); return; } // 자식이 없으면 첫 자식을 만들어요
      if (el) setCaret(el, 0);
    }
  });
  title.addEventListener('paste', (e) => { e.preventDefault(); document.execCommand('insertText', false, (e.clipboardData.getData('text/plain') || '').replace(/\s*\n\s*/g, ' ')); });
  title.addEventListener('blur', () => { if (!title.textContent && state.nodes.get(+title.dataset.id)) title.textContent = ''; flushAll(); });
}
/** 그 화면으로 가서(이미 그 화면이면 바로) fn */
function afterZoom(zoom, fn) {
  if (String(zoom ?? '') === String(state.zoom ?? '')) return fn();
  const once = () => { listeners.render.splice(listeners.render.indexOf(once), 1); setTimeout(fn, 80); };
  (listeners.render ||= []).push(once);
  setZoom(zoom);
}
/** 이 앱의 보기 링크면 이 화면에서 열고 true:
 *  이미지 보기 …/?img=주소&v=영역#항목 · PDF 북마크 …/?pdf=주소&p=쪽&r=영역&n=PDF가 든 항목#항목 */
function openAppLink(href) {
  let u;
  try { u = new URL(href, location.href); } catch { return false; }
  const q = u.searchParams;
  if (u.origin !== location.origin || u.pathname !== '/' || !(q.get('img') || q.get('pdf') || q.get('media'))) return false;
  const zoom = u.hash.length > 1 ? +u.hash.slice(1) : null;
  const nums = (k) => { const v = (q.get(k) || '').split(',').map(Number); return v.length === 4 && v.every(Number.isFinite) ? v : null; };
  if (q.get('img')) { afterZoom(zoom, () => imgViewer.openUrl(q.get('img'), nums('v'), nums('r'))); return true; }
  if (q.get('media')) { // 오디오 · 영상 북마크: 그 화면에서 그 시간부터 재생
    afterZoom(zoom, () => openMediaAt(q.get('media'), Math.max(0, parseFloat(q.get('t')) || 0)));
    if (location.search) history.replaceState(null, '', location.pathname + location.hash);
    return true;
  }
  const pdf = q.get('pdf'), page = Math.max(1, parseInt(q.get('p'), 10) || 1), r = nums('r'), n = q.get('n') ? +q.get('n') : null;
  const card = () => document.querySelector(`.att-pdf[data-url="${CSS.escape(pdf)}"]`);
  afterZoom(zoom, () => {
    if (card()?._goMark) return card()._goMark(page, r);
    if (n != null && String(n) !== String(state.zoom ?? '')) afterZoom(n, () => (card()?._goMark ? card()._goMark(page, r) : toast('그 PDF를 찾지 못했어요', 4000))); // 접혀 있어 안 보이면 PDF가 든 항목 안으로
    else toast('그 PDF를 찾지 못했어요', 4000);
  });
  if (location.search) history.replaceState(null, '', location.pathname + location.hash);
  return true;
}

/** 그 PDF가 든 항목 안으로 가서 p쪽부터 find를 찾아 칠해요 (여러 PDF 찾기에서 결과를 고를 때) */
function showPdf(url, { node = null, page = 1, find = '', regex = false, nth = 0 } = {}) {
  const card = () => document.querySelector(`.att-pdf[data-url="${CSS.escape(url)}"]`);
  const go = () => (card()?._goFind ? card()._goFind(find, page, regex, nth) : toast('그 PDF를 화면에서 찾지 못했어요', 4000));
  if (card()?._goFind) return go();
  afterZoom(node, go);
}

// ---- 태그 목록: 항목에서 #·@를 치면 DB에 있는 태그를 보여줘요 (↑↓ 고르기 · Enter/Tab 넣기 · Esc 닫기) ----
const tagAc = { box: null, el: null, start: 0, items: [], active: 0, all: null, at: 0 };
const TAG_TYPING = /(?<![\p{L}\p{N}_])[#@][\p{L}\p{N}_:-]*$/u;
async function tagList() {
  if (!tagAc.all || Date.now() - tagAc.at > 30000) { // 30초마다 새로 받아요
    tagAc.at = Date.now();
    try { tagAc.all = (await http('/api/tags')).tags; } catch { tagAc.all ||= []; }
  }
  return tagAc.all;
}
function tagAcClose() { tagAc.box?.remove(); tagAc.box = tagAc.el = null; }
async function tagAcUpdate(el) {
  const s = getSelection();
  if (!s.isCollapsed) return tagAcClose();
  const caret = caretOffset(el), m = el.textContent.slice(0, caret).match(TAG_TYPING);
  if (!m) return tagAcClose();
  const all = await tagList();
  if (document.activeElement !== el || caretOffset(el) !== caret) return; // 받는 사이에 계속 타이핑했어요
  const typed = m[0].toLowerCase();
  const items = all.filter(([t]) => t[0] === m[0][0] && t.toLowerCase().startsWith(typed) && t.toLowerCase() !== typed).slice(0, 8);
  if (!items.length) return tagAcClose();
  Object.assign(tagAc, { el, start: caret - m[0].length, items, active: 0 });
  if (!tagAc.box) { tagAc.box = mk('div', 'tag-ac'); tagAc.box.setAttribute('role', 'listbox'); document.body.append(tagAc.box); }
  tagAc.box.replaceChildren(...items.map(([t, c], i) => {
    const row = mk('div', i ? 'tag-ac-item' : 'tag-ac-item active');
    row.setAttribute('role', 'option');
    row.append(mk('span', 'tag-ac-name'), mk('span', 'tag-ac-num'));
    row.firstChild.textContent = t; row.lastChild.textContent = c;
    row.onmousedown = (e) => { e.preventDefault(); tagAc.active = i; tagAcPick(); };
    return row;
  }));
  const r = document.createRange(); const [node, off] = textPoint(el, caret);
  r.setStart(node, off); r.collapse(true);
  const b = r.getClientRects()[0] || el.getBoundingClientRect();
  const h = tagAc.box.offsetHeight, below = b.bottom + 6 + h < innerHeight;
  tagAc.box.style.left = `${Math.max(8, Math.min(b.left - 8, innerWidth - tagAc.box.offsetWidth - 8))}px`;
  tagAc.box.style.top = `${below ? b.bottom + 6 : b.top - h - 6}px`;
}
function tagAcPick() {
  const { el, start, items, active } = tagAc;
  const tag = items[active]?.[0];
  tagAcClose();
  if (!tag || !el) return;
  const s = getSelection(), r = document.createRange();
  const end = caretOffset(el), after = el.textContent[end];
  r.setStart(...textPoint(el, start)); r.setEnd(...textPoint(el, end));
  s.removeAllRanges(); s.addRange(r);
  document.execCommand('insertText', false, after === ' ' ? tag : `${tag} `); // input 이벤트 → 저장 · 되돌리기도 그대로
}
addEventListener('keydown', (e) => {
  if (!tagAc.box || e.isComposing || e.keyCode === 229) return;
  if (e.target !== tagAc.el) return tagAcClose();
  const k = e.key, n = tagAc.items.length;
  if (k === 'ArrowDown' || k === 'ArrowUp') tagAc.active = (tagAc.active + (k === 'ArrowDown' ? 1 : n - 1)) % n;
  else if ((k === 'Enter' || k === 'Tab') && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) { e.preventDefault(); e.stopImmediatePropagation(); return tagAcPick(); }
  else if (k === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); return tagAcClose(); }
  else return;
  e.preventDefault(); e.stopImmediatePropagation();
  [...tagAc.box.children].forEach((x, i) => x.classList.toggle('active', i === tagAc.active));
}, true);
document.addEventListener('focusout', () => setTimeout(() => { if (tagAc.el && document.activeElement !== tagAc.el) tagAcClose(); }));
addEventListener('scroll', tagAcClose, { passive: true });
document.addEventListener('selectionchange', () => { // 커서가 태그 밖으로 나가면 닫아요
  if (tagAc.box && !(getSelection().isCollapsed && TAG_TYPING.test(tagAc.el.textContent.slice(0, caretOffset(tagAc.el))))) tagAcClose();
});

// ---- 저장 ----
function onInput(n, text) {
  const before = n.content;
  n.content = text.textContent;
  undoText(n, before);
  scheduleAttach(n);
  scheduleMdPaint(text, () => n.content);
  scheduleMarks(150, text); // 타이핑 중에는 잠깐 미뤄서 입력이 버벅이지 않게
  tagAcUpdate(text);
  clearTimeout(timers.get(n.id));
  timers.set(n.id, setTimeout(() => saveNow(n.id), 400));
}
async function saveNow(id) {
  if (!timers.has(id)) return;
  clearTimeout(timers.get(id));
  timers.delete(id);
  const n = state.nodes.get(id);
  if (!n) return;
  await wq; // 아직 서버에 안 만들어진 항목이면 만들어진 뒤에 저장해요
  await patch(id, { content: n.content });
  emit('node:update', n);
}
const flushAll = async () => { await wq; await Promise.all([...timers.keys()].map(saveNow)); };
addEventListener('pagehide', () => {
  for (const id of timers.keys()) {
    const n = state.nodes.get(id);
    if (n) fetch(`/api/nodes/${id}`, { method: 'PATCH', keepalive: true, headers: { 'Content-Type': 'application/json', 'X-Client-Id': CLIENT_ID }, body: JSON.stringify({ content: n.content }) }).catch(() => {});
  }
});

// ---- 되돌리기 / 다시 실행 (Ctrl/⌘+Z · Ctrl/⌘+Shift+Z · Ctrl+Y) ----
// 이 화면에서 한 일(글 고치기 · 만들기 · 지우기 · 옮기기 · 붙여넣기 · 복제 · 완료)을 차례로 기록해요.
// 지운 항목은 하위까지 원래 id 그대로 되살려요(/api/restore). 글자 입력은 1.5초 안에 이어진 건 한 번으로 묶어요.
const undo = { stack: [], redo: [], busy: false, max: 300 };
function undoPush(e) {
  if (undo.busy) return;
  undo.stack.push(e);
  undo.redo.length = 0;
  if (undo.stack.length > undo.max) undo.stack.shift();
}
function undoGroupSince(mark) { // mark 뒤에 쌓인 되돌리기들을 하나로 (⌘Z 한 번에 모두)
  const items = undo.stack.splice(mark);
  if (items.length > 1) undo.stack.push({ group: items }); else if (items.length) undo.stack.push(items[0]);
}
/** 위 항목(prevId)으로 합치기: 글은 위 항목 끝에 붙이고, 하위 항목은 위 항목 아래로 옮기고, 이 항목은 지워요. 커서는 붙인 자리. */
async function mergeIntoPrev(n, text, prevId) {
  const p = state.nodes.get(prevId);
  if (!p || p.id === n.id) return;
  n.content = text.textContent;
  clearTimeout(timers.get(n.id)); timers.delete(n.id);
  await flushAll();
  const mark = undo.stack.length;
  const tail = n.content, at = p.content.length;
  if (hasKids(n)) { // 하위 항목 → 위 항목 아래 (위 항목이 부모면 이 항목 자리, 아니면 맨 끝)
    const r = await http(`/api/children?parent=${n.id}&limit=5000`);
    r.nodes.forEach(upsert);
    if (!state.ch.has(n.id)) state.ch.set(n.id, { ids: r.nodes.map((x) => x.id), total: r.total, show: PAGE });
    const kids = r.nodes.map((x) => x.id);
    if (kids.length) {
      if (p.collapsed) { p.collapsed = 0; await patch(p.id, { collapsed: 0 }); }
      if (!state.ch.has(p.id)) { const v = await http(`/api/view?parent=${p.id}`); if (!v.error) ingest(v); }
      await moveNodes(kids, p.id, n.parent_id === p.id ? { after: n.id } : {}, null);
    }
  }
  if (tail) { // 글 붙이기
    const from = p.content;
    p.content = from + tail;
    await patch(p.id, { content: p.content });
    undoPush({ k: 'text', id: p.id, from, to: p.content, t: 0 });
    emit('node:update', p);
  }
  const pid = n.parent_id, idx = state.ch.get(pid)?.ids.indexOf(n.id) ?? null; // 이 항목 지우기 (되살릴 수 있게 기록)
  undoPush({ k: 'tree', present: false, ids: [n.id], rows: [{ id: n.id, parent_id: pid, position: 0, index: idx, content: tail, collapsed: n.collapsed }] });
  await http(`/api/nodes/${n.id}`, 'DELETE');
  chRemove(pid, n.id);
  purge(n.id);
  undoGroupSince(mark);
  if (p.id === state.zoom) { // 제목으로 합쳤어요 → 제목 글을 고치고 커서를 제목의 붙인 자리에
    redrawMany([pid]);
    const t = $('#title'); t.textContent = p.content; setCaret(t, at);
  } else {
    state.focusId = p.id; state.focusPos = at;
    redrawMany([pid, p.parent_id, p.id].filter((x, i, a) => a.indexOf(x) === i));
  }
  emit('node:delete', n);
}
function undoClear() { undo.stack.length = 0; undo.redo.length = 0; }
function undoText(n, from) {
  if (undo.busy || from === n.content) return;
  const now = Date.now(), top = undo.stack[undo.stack.length - 1];
  if (top && top.k === 'text' && top.id === n.id && now - top.t < 1500) { top.to = n.content; top.t = now; undo.redo.length = 0; return; }
  undoPush({ k: 'text', id: n.id, from, to: n.content, t: now });
}
/** ids(하위 포함)를 지금 모양 그대로 저장해 둬요 — 되살릴 때 원래 자리(몇 번째)에 끼워 넣으려고 index도 적어요 */
async function captureTree(ids) {
  const info = ids.map((id) => {
    const n = state.nodes.get(id), l = n && state.ch.get(n.parent_id);
    return { id, idx: l ? l.ids.indexOf(id) : -1 };
  }).sort((a, b) => a.idx - b.idx);
  const { rows } = await http('/api/subtree', 'POST', { ids: info.map((i) => i.id) });
  const at = new Map(info.map((i) => [i.id, i.idx]));
  for (const r of rows) if (at.has(r.id)) r.index = at.get(r.id) >= 0 ? at.get(r.id) : null;
  return rows;
}
function dropLocal(ids) { // 화면 쪽 상태에서 지우고 해당 부모만 다시 그려요
  const parents = new Set();
  for (const id of ids) {
    const n = state.nodes.get(id);
    if (!n) continue;
    parents.add(n.parent_id);
    chRemove(n.parent_id, id);
    purge(id);
  }
  return parents;
}
function inZoom(pid) {
  for (let p = pid, g = 0; g < 500; g++) {
    if (p === state.zoom) return true;
    if (p === null || p === undefined) return state.zoom === null;
    const n = state.nodes.get(p);
    if (!n) return true;
    p = n.parent_id;
  }
  return true;
}
async function toggleTree(e) {
  if (e.present) {
    e.rows = await captureTree(e.ids);
    await http('/api/bulk', 'POST', { ops: e.ids.map((id) => ({ id, delete: true })) });
    const parents = dropLocal(e.ids);
    clearSel();
    redrawMany([...parents]);
    e.present = false;
  } else {
    await http('/api/restore', 'POST', { rows: e.rows });
    const tops = e.rows.filter((r) => e.ids.includes(r.id));
    for (const r of tops) { const p = state.nodes.get(r.parent_id); if (p?.collapsed) { p.collapsed = 0; await patch(p.id, { collapsed: 0 }); } }
    const first = tops[0];
    state.focusId = first.id; state.focusPos = 'end';
    if (inZoom(first.parent_id)) { state.ensure = first.id; await refresh(); } else setZoom(first.parent_id, first.id);
    e.present = true;
  }
}
async function setTextTo(id, value) {
  const n = state.nodes.get(id);
  if (!n) return;
  clearTimeout(timers.get(id)); timers.delete(id);
  await patch(id, { content: value });
  if (n) {
    n.content = value;
    emit('node:update', n);
    state.focusId = id; state.focusPos = 'end';
    if (document.querySelector(`#tree .text[data-id="${id}"]`)) redrawParent(n.parent_id);
    else if (inZoom(n.parent_id)) { state.ensure = id; await refresh(); } else setZoom(n.parent_id, id);
  }
}
async function applyUndo(e, redo) {
  if (e.group) { for (const x of redo ? e.group : [...e.group].reverse()) await applyUndo(x, redo); return; }
  if (e.k === 'text') return setTextTo(e.id, redo ? e.to : e.from);
  if (e.k === 'tree') return toggleTree(e);
  if (e.k === 'move') {
    if (redo) return moveNodes(e.ids, e.to.parent, e.to.pos, null);
    for (const g of [...e.from].reverse()) await moveNodes(g.ids, g.pid, g.next != null ? { before: g.next } : {}, null);
    const id = e.ids[0];
    if (state.nodes.has(id)) { state.focusId = id; state.focusPos = 'end'; afterDraw(); }
  }
}
async function runUndo(redo) {
  if (undo.busy) return;
  const from = redo ? undo.redo : undo.stack, to = redo ? undo.stack : undo.redo;
  const e = from.pop();
  if (!e) return toast(redo ? '다시 실행할 게 없어요' : '되돌릴 게 없어요', 1200);
  undo.busy = true;
  try { await flushAll(); await applyUndo(e, redo); to.push(e); }
  catch (err) { logErr(err); toast('되돌리지 못했어요'); }
  finally { undo.busy = false; }
}
const undoKey = (e) => { // Ctrl/⌘+Z = 되돌리기 · Ctrl/⌘+Shift+Z, Ctrl+Y = 다시 실행. 처리했으면 true
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return false;
  const k = e.key.toLowerCase();
  if (k === 'z') { e.preventDefault(); e.stopPropagation(); runUndo(e.shiftKey); return true; }
  if (k === 'y' && e.ctrlKey && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); runUndo(true); return true; }
  return false;
};

// ---- 구조 변경 ----
/** ids를 parent 아래로 옮겨요. pos: {before: id} | {after: id} | {}(맨 끝). 서버가 확인하면 화면의 바뀐 부분만 고쳐요. */
async function moveNodes(ids, parent, pos, focus) {
  await flushAll();
  if (movesIntoSelf(state.nodes, ids, parent)) return false;
  const r = await http('/api/move', 'POST', { ids, parent_id: parent, before_id: pos.before ?? null, after_id: pos.after ?? null });
  if (r.error) { toast(r.error); return false; }
  let from = []; // 되돌릴 때 필요한 원래 자리 (부모별로 묶고, 그 묶음 바로 뒤 형제를 기억해요)
  if (!undo.busy) {
    const moving = new Set(ids), byP = new Map();
    for (const id of ids) { const pid = state.nodes.get(id)?.parent_id; (byP.get(pid) ?? byP.set(pid, []).get(pid)).push(id); }
    for (const [pid, list] of byP) {
      const sibs = state.ch.get(pid)?.ids;
      if (!sibs) { from = null; break; }
      const last = Math.max(...list.map((id) => sibs.indexOf(id)));
      from.push({ pid, ids: list, next: sibs.slice(last + 1).find((x) => !moving.has(x)) ?? null });
    }
    if (from) undoPush({ k: 'move', ids: [...ids], from, to: { parent, pos: { before: pos.before ?? undefined, after: pos.after ?? undefined } } });
  }
  const oldParents = new Set();
  for (const id of ids) {
    const n = state.nodes.get(id);
    oldParents.add(n.parent_id);
    chRemove(n.parent_id, id);
    n.parent_id = parent;
  }
  const dest = state.ch.get(parent);
  ids.forEach((id, k) => {
    let idx = null; // 맨 끝
    if (dest && pos.before != null) { const i = dest.ids.indexOf(pos.before); idx = i < 0 ? Infinity : i; }
    else if (dest && pos.after != null) { const i = dest.ids.indexOf(pos.after); idx = i < 0 ? Infinity : i + 1 + k; }
    chInsert(parent, id, idx);
  });
  if (focus) { // 서버를 기다리는 동안 더 입력했을 수 있으니 지금 커서 위치를 써요
    const a = document.activeElement;
    state.focusId = focus.id;
    state.focusPos = a?.dataset?.id === String(focus.id) ? caretOffset(a) : focus.pos;
  }
  const fr = focus && document.querySelector(`#tree .row[data-id="${focus.id}"]`), top0 = fr ? fr.getBoundingClientRect().top : null;
  redrawMany([...oldParents, parent]);
  if (top0 != null) holdRow(focus.id, top0); // 들여쓰기 · 옮기기 뒤에도 커서 줄은 화면의 같은 높이에
  return true;
}
/** id 줄을 화면 높이 top 에 붙잡아 둬요: 지금 · 다음 그리기 · 잠깐 뒤(키보드가 다시 올라오는 등)에도. 사용자가 직접 스크롤하면 멈춰요. */
let holdToken = 0;
function holdRow(id, top) {
  const my = ++holdToken;
  let userMoved = false;
  const stop = () => { userMoved = true; };
  addEventListener('wheel', stop, { passive: true, once: true }); addEventListener('touchmove', stop, { passive: true, once: true });
  const fix = () => {
    if (userMoved || my !== holdToken) return;
    const r = document.querySelector(`#tree .row[data-id="${id}"]`);
    if (!r) return;
    const d = r.getBoundingClientRect().top - top;
    if (Math.abs(d) >= 1) scrollBy(0, d);
  };
  fix();
  requestAnimationFrame(() => { fix(); requestAnimationFrame(fix); });
  for (const ms of [120, 350, 700]) setTimeout(fix, ms);
  setTimeout(() => { removeEventListener('wheel', stop); removeEventListener('touchmove', stop); }, 800);
}

/** ⌘⇧↑↓ 로 형제 끝에 닿았을 때 계층을 넘어 옮겨요 (같은 깊이 유지).
 *  위로: 부모의 이전 형제 안 맨 아래로 · 아래로: 부모의 다음 형제 안 맨 위로. 그 형제가 접혀 있으면 펼쳐서 옮긴 항목이 보이게 해요. */
async function moveAcross(n, dir, focus) { return moveAcrossIds([n.id], n.parent_id, dir, focus); }
async function moveAcrossIds(ids, pid, dir, focus = null) {
  if (pid === state.zoom || pid == null) return; // 지금 화면의 최상위 단계에서는 더 나갈 곳이 없어요
  const p = state.nodes.get(pid);
  if (!p) return;
  const aunts = state.ch.get(p.parent_id)?.ids ?? [];
  const target = aunts[aunts.indexOf(pid) + dir];
  if (target == null) return toast(dir < 0 ? '부모 위에 형제 항목이 없어요' : '부모 아래에 형제 항목이 없어요', 1800);
  await flushAll();
  let pos = {}; // 위로: 맨 끝 (기본값)
  if (dir > 0) { // 아래로: 맨 앞 = 첫 자식 앞 (아직 안 불러왔으면 서버에 물어봐요)
    const first = state.ch.get(target)?.ids?.[0] ?? (await http(`/api/children?parent=${target}&limit=1`)).nodes?.[0]?.id;
    if (first != null) pos = { before: first };
  }
  const t = state.nodes.get(target);
  if (t?.collapsed) { t.collapsed = 0; later(() => patch(target, { collapsed: 0 })); }
  if (t && !state.ch.has(target) && !hasKids(t)) state.ch.set(target, { ids: [], total: 0, show: PAGE }); // 빈 항목 안으로
  if (t && !state.ch.has(target) && hasKids(t)) { // 접혀 있어서 자식을 아직 안 불러왔으면 먼저 받아 둬요 (옮긴 자리가 바로 보이게)
    const v = await http(`/api/view?parent=${target}`);
    if (!v.error) ingest(v);
  }
  await moveNodes(ids, target, pos, focus);
}

/** ⌘↓ / ⌘↑ : 서버가 어느 단계를 펼치고 접을지 정하고(아직 안 불러온 깊은 단계도 정확히), 화면은 그 부분만 다시 받아 그려요. */
async function foldStep(id, dir, root = false) {
  await flushAll();
  const r = await http('/api/fold', 'POST', { id, dir, root: root ? 1 : 0 });
  if (r.error || r.action === 'none') return;
  for (const x of r.ids) { const k = state.nodes.get(x); if (k) k.collapsed = r.collapsed; }
  if (r.action === 'expand') {
    const v = await http(`/api/view?parent=${ck(id)}`); // 새로 보일 하위를 한 번에 받아요
    if (!v.error) ingest(v);
  }
  captureFocus();
  redraw(root ? state.zoom : id);
}
function toggle(n, force) {
  const want = force === undefined ? (n.collapsed ? 0 : 1) : force;
  if (!!want === !!n.collapsed) return;
  n.collapsed = want;
  later(() => patch(n.id, { collapsed: want }));
  redraw(n.id); // 서버 응답을 기다리지 않고 바로 고쳐요
}
/** 화살표 더블클릭: n이 지금 접혀 있으면 하위 전부 접기, 펼쳐져 있으면 하위 전부 펼치기 */
async function toggleAll(n) {
  const collapse = !!n.collapsed;
  await flushAll();
  const r = await http('/api/collapse_subtree', 'POST', { id: n.id, collapsed: collapse ? 1 : 0, limit: 2000 });
  const walk = (id) => { const c = state.ch.get(id); if (c) for (const cid of c.ids) { const k = state.nodes.get(cid); if (k) { if (hasKids(k)) k.collapsed = collapse ? 1 : 0; walk(cid); } } };
  n.collapsed = collapse ? 1 : 0;
  walk(n.id);
  if (r.truncated) { await refresh(); toast(`항목이 많아 위쪽 ${r.count}개까지만 펼쳤어요`); } else redraw(n.id);
}
// 화살표 더블클릭 → 하위 전체. 첫 클릭이 행을 다시 그려서 브라우저의 dblclick 이벤트가 안 올 수 있어요 → 클릭 두 번(0.35초 안, 같은 자리)을 직접 셈해요.
// 두 번째 클릭은 접기/펼치기를 되돌리지 않도록 화살표에 닿기 전에 가로채요.
let lastChev = null;
$('#tree').addEventListener('click', (e) => {
  const c = e.target.closest?.('.chev'), l = lastChev, now = performance.now();
  // 두 번째 클릭의 대상은 다시 그려진 행일 수도 있어서, 대상이 아니라 첫 클릭과의 시간 · 자리로 판단해요
  if (l && now - l.t < 350 && Math.abs(e.clientX - l.x) < 8 && Math.abs(e.clientY - l.y) < 8) {
    e.stopPropagation(); e.preventDefault();
    lastChev = null;
    const n = state.nodes.get(l.id);
    if (n) toggleAll(n); // 첫 클릭이 바꾼 방향 그대로 하위 전체에
  } else if (c && !c.disabled) lastChev = { id: +c.closest('.row').dataset.id, x: e.clientX, y: e.clientY, t: now };
  else lastChev = null;
}, true);
async function zoomTo(id) {
  await flushAll();
  setZoom(id);
}
function setZoom(id, ensure = null) {
  state.ensure = ensure;
  if (String(state.zoom ?? '') === String(id ?? '')) { loadZoom(); return; }
  location.hash = id === null ? '' : String(id);
}
addEventListener('hashchange', () => {
  state.zoom = location.hash.length > 1 ? +location.hash.slice(1) : null;
  state.sel = new Set();
  state.anchor = state.head = null;
  loadZoom();
});

// ---- 붙여넣기 ----
/** 붙여넣을 글 → 항목들. 글의 들여쓰기로 계층을 읽고, 글에는 들여쓰기가 없지만 복사한 곳(구글 문서 · 워드 · 노션 · 웹)의
 *  서식에 목록 단계가 있으면 그쪽을 써요. 링크는 [글자](주소)로 남겨요. */
function pasteItems(raw, html) {
  const plain = parsePaste(raw, { keepNumbers: true });
  if (!html || !/<(li|h[1-6])\b|mso-list|aria-level/i.test(html)) return plain;
  let fromHtml;
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    for (const a of doc.querySelectorAll('a[href]')) {
      const href = (a.getAttribute('href') || '').trim(), label = (a.textContent || '').replace(/\s+/g, ' ').trim();
      if (/^(https?:\/\/|mailto:)/i.test(href) && label && label !== href && !/[\]\n]/.test(label) && !/[)\s]/.test(href)) a.textContent = `[${label}](${href})`;
    }
    fromHtml = parseHtml(doc.body);
  } catch { return plain; }
  const deepest = (xs) => xs.reduce((m, x) => Math.max(m, x.depth), 0);
  return fromHtml.length > 1 && deepest(fromHtml) > deepest(plain) ? fromHtml : plain; // 계층을 더 많이 살린 쪽
}

async function onPaste(e, n, text) {
  e.preventDefault();
  if (e.clipboardData.files?.length) { // 캡처 · 복사한 이미지 · 파일 붙여넣기 → 파일 넣기와 같게 (첨부 · 가져오기)
    addFiles(e.clipboardData.files, n.id);
    return;
  }
  const html = e.clipboardData.getData('text/html');
  const raw = linkifyPaste(e.clipboardData.getData('text/plain'), html); // 웹에서 복사한 링크는 [글자](주소)로
  const items = pasteItems(raw, html);
  if (items.length <= 1) { // 한 줄이면 커서 위치에 그대로 삽입
    document.execCommand('insertText', false, raw.replace(/\s*\n\s*/g, ' ').trim());
    return;
  }
  await flushAll();
  const replace = text.textContent === '' && !hasKids(n); // 빈 항목이면 그 자리를 대체
  const idx = state.ch.get(n.parent_id)?.ids.indexOf(n.id) ?? -1;
  const r = await http('/api/import', 'POST', { parent_id: n.parent_id, position: idx < 0 ? null : replace ? idx : idx + 1, items });
  if (replace) await http(`/api/nodes/${n.id}`, 'DELETE');
  undoPush({ group: [{ k: 'tree', present: true, ids: r.tops },
    ...(replace ? [{ k: 'tree', present: false, ids: [n.id], rows: [{ id: n.id, parent_id: n.parent_id, position: 0, index: idx + r.tops.length, content: '', collapsed: 0 }] }] : [])] });
  state.focusId = r.last;
  state.focusPos = 'end';
  state.ensure = n.parent_id === state.zoom ? n.id : null;
  await refresh();
}

// ---- 다중 선택 ----
// Ctrl/⌘+클릭: 하나씩 추가/해제 · Shift+클릭: 범위 · Shift+↑/↓: 키보드로 확장 · 마우스로 여러 노드에 걸쳐 끌기 · Ctrl/⌘+A: 전체
// 선택 후 Ctrl/⌘+C 복사 · Ctrl/⌘+X 잘라내기 · Backspace/Delete 삭제
const visibleIds = () => [...document.querySelectorAll('#tree .text')].map((el) => +el.dataset.id);
const leaveText = () => { document.activeElement?.blur?.(); getSelection().removeAllRanges(); };

function topSelected() { // 부모가 이미 선택돼 있으면 제외하고, 화면 순서로 정렬
  if (state.zoom !== null && state.sel.has(state.zoom)) return [state.zoom]; // 제목(들어와 있는 항목)을 골랐으면 그 하나가 전부를 품어요
  const under = (id) => {
    for (let p = state.nodes.get(id)?.parent_id; p != null; p = state.nodes.get(p)?.parent_id) if (state.sel.has(p)) return true;
    return false;
  };
  return visibleIds().filter((id) => state.sel.has(id) && !under(id));
}

function paintSel() {
  const has = state.sel.size > 0;
  document.body.classList.toggle('has-sel', has); // 선택 중에는 화면 밖 행 건너뛰기를 꺼서, 하이라이트가 잘리지 않고 이어져요
  const rows = [...document.querySelectorAll('#tree .row')];
  let prevSel = false;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i], on = state.sel.has(+r.dataset.id);
    const next = i + 1 < rows.length && state.sel.has(+rows[i + 1].dataset.id);
    r.classList.toggle('selected', on);
    r.classList.toggle('sel-first', on && !prevSel);
    r.classList.toggle('sel-last', on && !next);
    if (on) { // 들여쓴 행도 왼쪽 끝까지 이어 칠하도록 깊이를 알려줘요
      let d = 0;
      for (let p = r.parentElement; p && p.id !== 'tree'; p = p.parentElement) if (p.classList.contains('children')) d++;
      r.style.setProperty('--d', d);
    }
    prevSel = on;
  }
  $('#title').classList.toggle('selected', state.zoom !== null && state.sel.has(state.zoom)); // 제목도 항목처럼 선택 표시
  const top = has ? topSelected() : [];
  $('#selbar').hidden = !has;
  $('#selcount').textContent = `${top.length}개 선택됨`;
  paintSelCmds(top.length);
}
/** 선택 막대의 명령 단추: 명령이 { selection: '단추 글', selectionMin: 몇 개부터 } 로 스스로 올려요 (예: join → '합치기', 둘 이상일 때).
 *  앱은 어떤 명령이 있는지 몰라요 — 그 플러그인 파일을 지우면 단추도 사라져요 */
function paintSelCmds(n) {
  const box = $('#sel-cmds');
  const want = n ? [...paletteCommands.values()].filter((c) => inSelBar(c) && n >= (c.selectionMin ?? 1)) : []; // 띄울지는 keys 창에서 바꿀 수 있어요
  const sig = want.map((c) => c.name).join();
  if (box.dataset.sig === sig) return; // 고를 때마다 다시 만들지 않게
  box.dataset.sig = sig;
  box.replaceChildren(...want.map((c) => {
    const b = mk('button'); b.type = 'button'; b.textContent = c.selection || c.name; b.title = c.label ? `${c.label} (${c.name})` : c.name;
    b.onclick = () => runCommandNow(c);
    return b;
  }));
}
/** 화면 순서 ids에서 i~j 범위를 고르되, 부모와 그 자식 중 하나라도 범위에 들면 그 부모의 (화면에 보이는) 하위 항목을 전부 포함해요. */
function rangeSel(ids, i, j) {
  const set = new Set(ids.slice(Math.min(i, j), Math.max(i, j) + 1));
  const marked = new Set();
  for (const id of set) { const p = state.nodes.get(id)?.parent_id; if (p != null && set.has(p)) marked.add(p); }
  if (marked.size) {
    for (const id of ids) {
      if (set.has(id)) continue;
      for (let p = state.nodes.get(id)?.parent_id; p != null; p = state.nodes.get(p)?.parent_id) if (marked.has(p)) { set.add(id); break; }
    }
  }
  return set;
}
function selectRange(a, b) {
  const ids = visibleIds(), i = ids.indexOf(a), j = ids.indexOf(b);
  if (i < 0 || j < 0) return;
  state.sel = rangeSel(ids, i, j);
  state.head = b;
  leaveText();
  paintSel();
}
function toggleSel(id) {
  const s = new Set(state.sel);
  if (s.has(id)) s.delete(id); else s.add(id);
  state.sel = s;
  state.anchor = state.head = id;
  leaveText();
  paintSel();
}
function clearSel() {
  state.sel = new Set();
  state.anchor = state.head = null;
  paintSel();
}
function extendSel(id, dir) {
  if (!state.sel.size) { state.anchor = state.head = id; selectRange(id, id); return; } // 첫 입력은 현재 항목만
  const ids = visibleIds(), ai = ids.indexOf(state.anchor);
  let j = Math.max(0, Math.min(ids.length - 1, ids.indexOf(state.head) + dir));
  // 부모→자식으로 이어져 하위가 통째로 선택된 구간에서는 눌러도 달라지지 않는 자리를 건너뛰어요
  const same = (x, y) => x.size === y.size && [...x].every((v) => y.has(v));
  for (let k = 0; k < 500 && j > 0 && j < ids.length - 1 && same(rangeSel(ids, ai, j), state.sel); k++) j += dir;
  selectRange(state.anchor, ids[j]);
}

// ---- 전체 선택 (Ctrl+A / ⌘A) ----
// 1번째: 그 항목의 글자만 → 2번째: 항목 선택 → 3번째: 현재 화면(현재 항목) 안의 모든 항목.  이미 여러 개를 골랐거나 커서가 없으면 바로 전부.
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
function selectAllStep() {
  const a = document.activeElement;
  const onTitle = a?.id === 'title' && state.zoom !== null; // 제목도 항목과 똑같이: 글자 → 이 항목 → 화면 전부
  const fromId = a?.classList?.contains('text') && a.dataset.id ? +a.dataset.id : onTitle ? state.zoom : null;
  const all = visibleIds();
  if (!all.length && !onTitle) return;
  if (state.sel.size === 0 && fromId !== null) {
    const s = getSelection(), len = a.textContent.length;
    const full = len === 0 || (s.rangeCount && a.contains(s.anchorNode) && a.contains(s.focusNode) && s.toString().replace(/\n/g, '').length >= len);
    if (!full) { const r = document.createRange(); r.selectNodeContents(a); s.removeAllRanges(); s.addRange(r); return; } // 1번째: 글자만 전체 선택
    state.sel = new Set([fromId]);
    state.anchor = state.head = fromId;
    leaveText();
    paintSel();
  } else {
    if (!all.length) return; // 하위가 없는 항목의 제목: 항목 선택까지만
    state.sel = new Set(all);
    state.anchor = all[0];
    state.head = all.at(-1);
    leaveText();
    paintSel();
  }
}
document.addEventListener('keydown', (e) => {
  if (e.isComposing || e.keyCode === 229 || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'a') return;
  if (!(isMac ? e.metaKey : e.ctrlKey)) return;
  if (e.target.closest?.('input, textarea, select, [data-plugin-ui]')) return; // 입력칸에서는 원래대로 글자 전체 선택
  if (paletteOpen()) return;
  e.preventDefault();
  selectAllStep();
});

// ---- 마우스로 끌어서 여러 노드에 걸치면 그 노드들 전체를 선택 ----
// 한 노드 안에서는 평소처럼 글자가 하이라이트되고, 다른 노드로 넘어가는 순간 노드 단위 선택으로 바뀌어요.
const rangeDrag = { anchor: null, active: false, y: 0, x: 0, timer: 0 };
function rowUnder(x, y) {
  const r = document.elementFromPoint(x, y)?.closest?.('#tree .row');
  return r ? +r.dataset.id : null;
}
function rangeDragUpdate() {
  const id = rowUnder(rangeDrag.x, rangeDrag.y);
  if (id === null) return;
  if (!rangeDrag.active && id === rangeDrag.anchor) return;
  rangeDrag.active = true;
  selectRange(rangeDrag.anchor, id);
}
document.addEventListener('mousemove', (e) => {
  if (rangeDrag.anchor === null || !(e.buttons & 1) || drag.on) return;
  rangeDrag.x = e.clientX;
  rangeDrag.y = e.clientY;
  rangeDragUpdate();
  if (rangeDrag.active && !rangeDrag.timer) { // 화면 위/아래 끝에서는 자동 스크롤
    rangeDrag.timer = setInterval(() => {
      const edge = 60;
      const v = rangeDrag.y < edge ? -14 : rangeDrag.y > innerHeight - edge ? 14 : 0;
      if (v) { scrollBy(0, v); rangeDragUpdate(); }
    }, 30);
  }
});
document.addEventListener('mouseup', () => {
  clearInterval(rangeDrag.timer);
  rangeDrag.timer = 0;
  rangeDrag.anchor = null;
  rangeDrag.active = false;
});
document.addEventListener('mousedown', (e) => { // 빈 곳을 누르면 선택 해제
  if (!state.sel.size || e.button !== 0) return;
  if (e.target.closest?.('.row, #selbar, [data-plugin-ui], .pal-overlay, .more, summary, button, a, input, details')) return;
  clearSel();
});
document.addEventListener('selectstart', (e) => { if (rangeDrag.active) e.preventDefault(); }); // 노드 선택 중엔 글자 하이라이트가 따로 생기지 않게

async function copySelected() {
  await flushAll();
  const r = await fetch(`/api/export?format=md&ids=${topSelected().join(',')}`);
  await navigator.clipboard.writeText((await r.text()).replace(/\n$/, ''));
  toast('복사했어요');
}
async function deleteSelected(ask = true) {
  const ids = topSelected();
  if (!ids.length) return;
  if (ask) {
    const { count } = await http(`/api/count?ids=${ids.join(',')}`);
    const one = ids.length === 1 ? state.nodes.get(ids[0])?.content?.slice(0, 40) || '(빈 항목)' : null;
    if (!(await confirmDelete(one ?? `선택한 항목 ${ids.length}개`, count > ids.length ? `하위 항목까지 모두 ${count}개가 지워져요 (⌘Z로 되돌릴 수 있어요)` : '⌘Z로 되돌릴 수 있어요'))) return false;
  }
  await flushAll();
  const rows = await captureTree(ids);
  await http('/api/bulk', 'POST', { ops: ids.map((id) => ({ id, delete: true })) });
  undoPush({ k: 'tree', present: false, ids: [...ids], rows });
  if (ids.includes(state.zoom)) { // 들어와 있는 항목(제목)을 지웠으면 한 단계 밖으로
    const up = state.nodes.get(state.zoom)?.parent_id ?? null;
    clearSel();
    setZoom(up);
    return;
  }
  const parents = dropLocal(ids);
  clearSel();
  redrawMany([...parents]);
}

/** 선택한 항목들을 한꺼번에 들여쓰기/내어쓰기. 같은 부모의 연속된 항목은 순서를 유지한 채 함께 움직여요. */
/** 여러 항목을 고른 채 ⌘⇧↑↓: 한 칸씩 함께 옮겨요. 형제 끝에 닿으면 한 항목일 때처럼 부모의 이전 · 다음 형제 안으로 넘어가요. */
let moveChain = Promise.resolve(); // 빠르게 여러 번 눌러도 한 번씩 차례로 (앞의 이동이 끝난 자리에서 다음 이동)
function moveSelected(dir) { moveChain = moveChain.then(() => moveSelectedNow(dir)).catch(logErr); return moveChain; }
/** 제목(들어와 있는 항목)을 고른 채로는 들여쓰기 · 옮기기를 하지 않아요 — 지금 보는 화면 자체가 다른 곳으로 가 버려요 */
const titleSelected = () => state.zoom !== null && state.sel.has(state.zoom);
async function moveSelectedNow(dir) {
  if (titleSelected()) return toast('들어와 있는 항목(제목)은 옮길 수 없어요 — 밖으로 나가서(⌘,) 옮기세요', 2600);
  const top = topSelected();
  if (!top.length) return;
  const pid = state.nodes.get(top[0])?.parent_id;
  const sibs = state.ch.get(pid)?.ids ?? [];
  const idx = top.map((id) => sibs.indexOf(id));
  if (top.some((id) => state.nodes.get(id)?.parent_id !== pid) || idx.some((k, j) => k < 0 || (j && k !== idx[j - 1] + 1)))
    return toast('같은 부모 아래 이어진 항목들만 함께 옮길 수 있어요', 2200);
  const first = idx[0], last = idx[idx.length - 1], total = state.ch.get(pid)?.total ?? 0;
  if (dir < 0 && first > 0) await moveNodes(top, pid, { before: sibs[first - 1] });
  else if (dir > 0 && last < sibs.length - 1) await moveNodes(top, pid, { after: sibs[last + 1] });
  else if (dir < 0 || total <= sibs.length) await moveAcrossIds(top, pid, dir);
  paintSel();
}
async function indentSelected(out) {
  if (titleSelected()) return toast('들어와 있는 항목(제목)은 들여쓰거나 내어쓸 수 없어요 — 밖으로 나가서(⌘,) 하세요', 2600);
  const a0 = document.activeElement;
  const fid = a0?.dataset?.id && state.sel.has(+a0.dataset.id) ? +a0.dataset.id : null, fpos = fid ? caretOffset(a0) : 0;
  await flushAll();
  const top = topSelected(), byParent = new Map();
  for (const id of top) { const pid = state.nodes.get(id).parent_id; (byParent.get(pid) ?? byParent.set(pid, []).get(pid)).push(id); }
  let moved = 0;
  for (const [pid, ids] of byParent) {
    if (out) {
      if (pid === state.zoom) continue; // 현재 화면의 최상위 단계
      const p = state.nodes.get(pid);
      if (p && await moveNodes(ids, p.parent_id, { after: p.id })) moved += ids.length;
    } else {
      const sibs = state.ch.get(pid)?.ids ?? [];
      const set = new Set(ids);
      for (let k = 0; k < ids.length;) { // 연속된 묶음마다: 묶음 바로 앞 형제 밑으로
        const at = sibs.indexOf(ids[k]);
        let run = [ids[k]];
        while (k + run.length < ids.length && sibs[at + run.length] === ids[k + run.length]) run.push(ids[k + run.length]);
        k += run.length;
        const prev = at > 0 ? state.nodes.get(sibs[at - 1]) : null;
        if (!prev || set.has(prev.id)) continue;
        if (prev.collapsed) { prev.collapsed = 0; await patch(prev.id, { collapsed: 0 }); }
        if (await moveNodes(run, prev.id, {})) moved += run.length;
      }
    }
  }
  paintSel();
  if (fid !== null && state.nodes.has(fid)) { state.focusId = fid; state.focusPos = fpos; afterDraw(); }
  return moved;
}

document.addEventListener('keydown', async (e) => {
  if (!state.sel.size || e.isComposing || e.target.closest?.('.text, input, textarea, select, [data-plugin-ui]')) return;
  const mod = e.ctrlKey || e.metaKey, key = e.key.toLowerCase();
  if (e.shiftKey && !mod && (key === 'arrowup' || key === 'arrowdown')) { e.preventDefault(); extendSel(state.head, key === 'arrowup' ? -1 : 1); }
  else if (!e.shiftKey && !mod && !e.altKey && (key === 'arrowup' || key === 'arrowdown')) { // ↑·↓: 선택을 풀고, 선택 범위 바로 위 · 아래 항목의 맨 앞으로 커서
    e.preventDefault();
    const ids = visibleIds(), at = ids.map((id, i) => (state.sel.has(id) ? i : -1)).filter((i) => i >= 0);
    if (!at.length) { clearSel(); return; }
    const up = key === 'arrowup', i = up ? at[0] - 1 : at.at(-1) + 1;
    const target = ids[i] ?? ids[up ? at[0] : at.at(-1)]; // 맨 위 · 맨 아래면 선택 끝 항목 자신
    clearSel();
    if (up && i < 0 && !$('#title').hidden) { setCaret($('#title'), 0); return; } // 맨 위 항목 위 → 제목
    const el = document.querySelector(`#tree .text[data-id="${target}"]`);
    if (el) setCaret(el, 0);
  }
  else if (key === 'tab' && !mod && !e.altKey) { e.preventDefault(); indentSelected(e.shiftKey); }
  else if (mod && e.shiftKey && !e.altKey && (key === 'arrowup' || key === 'arrowdown')) { e.preventDefault(); moveSelected(key === 'arrowup' ? -1 : 1); }
  else if (key === 'backspace' || key === 'delete') { e.preventDefault(); deleteSelected(); } // 늘 한 번 더 물어요
  else if (mod && (key === 'c' || key === 'x')) {
    e.preventDefault();
    await copySelected();
    if (key === 'x') await deleteSelected(false);
  }
});
$('#sel-copy').onclick = copySelected;
$('#sel-del').onclick = () => deleteSelected();
$('#sel-clear').onclick = clearSel;

// ---- 내보내기 / 가져오기 ----
function exportUrl(fmt) {
  if (fmt === 'db') return '/api/export/db';
  if (fmt === 'all') return '/api/export/all';
  const ids = state.sel.size ? topSelected() : state.zoom !== null ? [state.zoom] : [];
  return `/api/export?format=${fmt}&ids=${ids.join(',')}`;
}
// ---- DB 파일 가져오기 (내보내기의 'DB 파일 전체 백업'으로 받은 파일) ----
async function importDbFile(file) {
  const scope = state.zoom !== null ? `지금 화면 (${state.nodes.get(state.zoom)?.content || '빈 항목'}) 맨 아래` : '홈 맨 아래';
  const send = async (mode) => {
    const fd = new FormData();
    fd.append('file', file, file.name); fd.append('mode', mode);
    if (mode === 'append' && state.zoom !== null) fd.append('parent_id', state.zoom);
    const r = await postForm('/api/import/db', fd);
    if (r.error) throw Object.assign(new Error(r.error), { filesZip: r.files_zip });
    return r;
  };
  await flushAll();
  // 먼저 읽을 수 있는 파일인지 봐요 (전체 백업이면 첨부 개수도)
  let pre = null;
  try { pre = await send('check'); } catch (err) {
    if (err.filesZip) return 'files-zip'; // 백업이 아닌 ZIP → 가져오기(addFiles)가 첨부 파일 ZIP으로 풀어요
    toast(`파일을 읽지 못했어요: ${err.message}`, 6000); return;
  }
  const foot = pre.files != null
    ? `<span style="color:var(--mute)">전체 백업이에요 — 첨부 파일 ${pre.files}개도 함께 가져와요 (이미 있는 파일은 건너뛰어요).</span>`
    : `<span style="color:var(--mute)">DB 파일만이라 첨부 파일(이미지 · 영상 · 오디오 · PDF)은 들어 있지 않아요 — 첨부까지 옮기려면 전체 백업(.zip)을 쓰세요.</span>`;
  const html = `<b>${file.name.replace(/[<>&]/g, '')}</b> (${(file.size / 1048576).toFixed(1)} MB)<br><br>` +
    `<b>아래에 추가</b> — 그 DB의 모든 항목을 ${scope}에 추가해요. 지금 있는 내용은 그대로예요.<br>` +
    `<b>대체하기</b> — 지금 DB 전체를 그 파일로 바꿔요. 바꾸기 전에 지금 DB를 자동으로 백업해 둬요.<br>` + foot;
  const mode = await askChoice(/\.zip$/i.test(file.name) ? '전체 백업 가져오기' : 'DB 파일 가져오기', html,
    [{ label: '취소', value: null }, { label: '대체하기', value: 'replace' }, { label: '아래에 추가', value: 'append', primary: true }]);
  if (!mode) return;
  await flushAll();
  toast(/\.zip$/i.test(file.name) ? '전체 백업을 가져오는 중…' : 'DB 파일을 가져오는 중…', 600000);
  try {
    const r = await send(mode);
    const filesNote = r.files != null ? ` · 첨부 ${r.files_added}개 추가 (${r.files - r.files_added}개는 이미 있었어요)` : '';
    if (mode === 'replace') { // 새로고침해서 화면 상태 · 미리 받은 번호를 모두 새 DB 기준으로
      try { sessionStorage.setItem('outliner.toast', `DB를 바꿨어요 (${r.count}개 항목)${filesNote} · 이전 DB는 data/${r.backup} 로 백업했어요`); } catch { /* 무시 */ }
      location.hash = ''; location.reload(); return;
    }
    await refresh();
    if (r.records) await Promise.all([loadLoops(), loadPdfMarks(), loadImgMarks(), loadMediaMarks(), loadImgInk(), http('/api/plugin-data/core/pdf_folded').then((x) => { for (const u of Array.isArray(x.value) ? x.value : []) pdfFolded.add(u); }).catch(() => {})]); // 더한 북마크 · 구간 기록을 다시 받아, 예전 목록으로 덮어쓰지 않게
    const recNote = r.records ? ` · 북마크 · 구간 기록 ${r.records}개` : '';
    toast(`${r.count}개 항목을 아래에 추가했어요${filesNote}${recNote}`, 8000);
  } catch (err) { toast(`가져오지 못했어요: ${err.message}`, 6000); }
}

// .json(내보내기 파일, 접힘 상태까지 복원) · .html(목록 · 제목 · 문단 구조 유지) · .md / .txt(붙여넣기와 같은 규칙). 현재 화면의 맨 아래에 추가돼요.
/** 글 파일 가져오기 (.json · .html · .md · .txt) → 지금 화면 맨 아래에 항목으로. 파일 넣기(addFiles)가 나눠서 불러요 */
async function importOutlineFile(file) {
  try {
    const raw = await file.text();
    const items = /\.json$/i.test(file.name) ? flattenJson(JSON.parse(raw))
      : /\.html?$/i.test(file.name) ? parseHtml(new DOMParser().parseFromString(raw, 'text/html').body)
      : parsePaste(raw);
    if (!items.length) { toast(`${file.name}: 가져올 항목이 없어요`, 3500); return; }
    // 큰 파일은 첫 단계만 펼쳐서 넣어요(전부 펼치면 화면 그리기만 오래 걸려요). 접힘 상태가 담긴 JSON은 그대로.
    if (items.length > 2000 && !items.some((i) => i.collapsed)) for (const i of items) i.collapsed = i.depth >= 1;
    await flushAll();
    const r = await http('/api/import', 'POST', { parent_id: state.zoom, position: null, items });
    undoPush({ k: 'tree', present: true, ids: r.tops });
    let marks = 0; // JSON 내보내기에 담긴 북마크 (파일 주소마다)
    if (/\.json$/i.test(file.name)) (function walk(list) {
      for (const n of Array.isArray(list) ? list : []) {
        for (const [kind, key] of [['pdf', 'pdf_marks'], ['img', 'img_marks'], ['media', 'media_marks']]) for (const [url, ms] of Object.entries(n?.[key] || {})) marks += mergeMarks(kind, url, ms);
        walk(n?.children);
      }
    })(JSON.parse(raw));
    await refresh();
    toast(`${file.name}: ${r.count}개 항목을 가져왔어요${marks ? ` · 북마크 ${marks}개도 함께` : ''}`, 4000);
  } catch (err) { toast(`${file.name}: 가져오지 못했어요 — ${err.message}`, 5000); }
}

// ---- 키보드 ----
function comboOf(e) {
  const k = e.code.startsWith('Key') ? e.code.slice(3) : e.code.startsWith('Digit') ? e.code.slice(5) : e.key;
  // 'Ctrl' = 주 수식키 (Windows/Linux의 Ctrl, Mac의 ⌘). Mac에서는 진짜 Control(⌃)을 따로 'Ctl'로 적어요 — 명령 단축키(⌃+알파벳)용
  if (isMac) return [e.metaKey ? 'Ctrl' : '', e.ctrlKey ? 'Ctl' : '', e.altKey ? 'Alt' : '', e.shiftKey ? 'Shift' : '', k].filter(Boolean).join('+');
  return [e.ctrlKey || e.metaKey ? 'Ctrl' : '', e.altKey ? 'Alt' : '', e.shiftKey ? 'Shift' : '', k].filter(Boolean).join('+');
}

async function onKey(e, n, text) {
  if (e.isComposing || e.keyCode === 229) return; // 한글 조합 중에는 무시
  if (undoKey(e)) return;
  if (blockBrowserFmt(e)) return; // ⌘B 굵게 등은 플러그인 명령(bold …)이 먼저 받아요
  const caret = caretOffset(text);
  const mod = e.ctrlKey || e.metaKey;

  if (e.shiftKey && !e.altKey && !mod && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault(); // 항목 단위 선택 시작/확장
    extendSel(n.id, e.key === 'ArrowUp' ? -1 : 1);
    return;
  }

  if (mod && e.shiftKey && !e.altKey && (e.key === 'Backspace' || e.key === 'Delete')) { // Ctrl/⌘+Shift+Backspace: 커서 항목 지우기(하위 포함) — 한 번 더 물어요
    e.preventDefault();
    if (!state.sel.size) {
      const ids = visibleIds(), k = ids.indexOf(n.id);
      const prev = k > 0 ? ids[k - 1] : null;
      clearTimeout(timers.get(n.id)); timers.delete(n.id);
      state.sel = new Set([n.id]);
      if (prev !== null) { state.focusId = prev; state.focusPos = 'end'; }
      if ((await deleteSelected()) === false) { clearSel(); setCaret(text, caret); } // 취소하면 고른 것도 풀고 커서는 그 자리로
      return;
    }
    await deleteSelected();
    return;
  }

  const list = state.ch.get(n.parent_id);
  const sibs = list?.ids ?? [];
  const i = sibs.indexOf(n.id);
  const visible = [...document.querySelectorAll('#tree .text')];
  const caretRef = { id: n.id, pos: caret };

  // --- 노드 사이 이동 단축키 ---
  if (mod && !e.altKey && !e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { // ⌘↓ 한 단계씩 더 펼치기 · ⌘↑ 하위 접기 → 자신 접기
    e.preventDefault(); n.content = text.textContent; foldStep(n.id, e.key === 'ArrowDown' ? 'down' : 'up'); return;
  }
  const up = mod && e.shiftKey && !e.altKey && e.key === 'ArrowUp';     // 항목 위로 옮기기
  const down = mod && e.shiftKey && !e.altKey && e.key === 'ArrowDown';

  if (e.key === 'Enter' && !e.shiftKey && !mod && !e.altKey && caret === 0 && text.textContent !== '' && i >= 0) {
    // 맨 앞에서 Enter: 바로 위에 빈 항목을 만들고 커서를 그리로 (지금 항목은 글 · 하위 그대로 아래로 내려가요)
    e.preventDefault();
    n.content = text.textContent;
    const parent = n.parent_id, id = newIdNow() ?? await newId();
    undoPush({ k: 'tree', present: true, ids: [id] });
    const node = { id, parent_id: parent, content: '', collapsed: 0, hk: 0 };
    state.nodes.set(id, node);
    chInsert(parent, id, i);
    saveNew(node, parent, i);
    state.focusId = id;
    state.focusPos = 0;
    const row = document.querySelector(`#tree .node[data-nid="${n.id}"]`);
    if (row) { captureFocus(); row.before(rowFor(node)); state.focusId = id; state.focusPos = 0; afterDraw(); } else redrawParent(parent);
    emit('node:create', node);
  } else if (e.key === 'Enter' && !e.shiftKey && !mod && !e.altKey) {
    e.preventDefault();
    const full = text.textContent;
    const head = full.slice(0, caret), rest = full.slice(caret);
    const open = isOpen(n); // 펼쳐진 하위 항목이 있으면 첫 번째 자식으로
    const parent = open ? n.id : n.parent_id, idx = open ? 0 : i < 0 ? null : i + 1;
    const id = newIdNow() ?? await newId();
    const wasText = n.content;
    n.content = head;
    undoPush({ group: [{ k: 'text', id: n.id, from: wasText, to: head, t: 0 }, { k: 'tree', present: true, ids: [id] }] });
    clearTimeout(timers.get(n.id));
    timers.delete(n.id);
    later(() => patch(n.id, { content: head }));
    const node = { id, parent_id: parent, content: rest, collapsed: 0, hk: 0 };
    state.nodes.set(id, node);
    const inside = chInsert(parent, id, idx);
    const c = state.ch.get(parent);
    state.focusId = id;
    state.focusPos = 0;
    saveNew(node, parent, idx);
    const box = parent === state.zoom ? $('#tree') : document.querySelector(`#tree .node[data-nid="${parent}"] > .children`);
    const at = idx ?? (c ? c.ids.length - 1 : 0);
    if (inside && box && at < c.show) {
      // 빠른 길: 새 행 하나만 끼워 넣어요 (형제가 수백 개여도 비용이 같아요)
      captureFocus();
      const els = [...box.children].filter((x) => x.classList.contains('node'));
      box.insertBefore(rowFor(node), els[at] ?? box.querySelector(':scope > .more'));
      redrawRowOf(n); // 방금 잘라낸 앞부분 내용 반영
      afterDraw();
    } else redrawParent(parent);
    emit('node:create', node);
  } else if (e.key === 'Tab' && !mod && !e.altKey) {
    e.preventDefault();
    if (state.sel.size) { await indentSelected(e.shiftKey); return; } // 여러 항목 선택 중이면 전부 함께
    if (e.shiftKey) {
      if (n.parent_id === state.zoom) return; // 현재 화면의 최상위 단계
      const p = state.nodes.get(n.parent_id);
      if (p) await moveNodes([n.id], p.parent_id, { after: p.id }, caretRef);
    } else if (i > 0) {
      const p = state.nodes.get(sibs[i - 1]);
      await flushAll();
      if (p.collapsed) { p.collapsed = 0; await patch(p.id, { collapsed: 0 }); }
      await moveNodes([n.id], p.id, {}, caretRef);
    }
  } else if (up) {
    e.preventDefault();
    if (i > 0) await moveNodes([n.id], n.parent_id, { before: sibs[i - 1] }, caretRef);
    else if (i === 0) await moveAcross(n, -1, caretRef); // 맨 위에서 더 위로 → 부모의 이전 형제 안 맨 아래로
  } else if (down) {
    e.preventDefault();
    if (i >= 0 && i < sibs.length - 1) await moveNodes([n.id], n.parent_id, { after: sibs[i + 1] }, caretRef);
    else if (i === sibs.length - 1 && (list?.total ?? 0) <= sibs.length) await moveAcross(n, 1, caretRef); // 맨 아래에서 더 아래로 → 부모의 다음 형제 안 맨 위로
  } else if (e.key === 'Backspace' && text.textContent === '' && !hasKids(n)) {
    e.preventDefault();
    clearTimeout(timers.get(n.id));
    timers.delete(n.id);
    const prev = visible[visible.indexOf(text) - 1];
    const delId = n.id, pid = n.parent_id;
    undoPush({ k: 'tree', present: false, ids: [delId], rows: [{ id: delId, parent_id: pid, position: 0, index: state.ch.get(pid)?.ids.indexOf(delId) ?? null, content: '', collapsed: 0 }] });
    later(() => http(`/api/nodes/${delId}`, 'DELETE'));
    chRemove(pid, delId);
    const wrap = document.querySelector(`#tree .node[data-nid="${delId}"]`);
    purge(delId);
    if (prev) { state.focusId = +prev.dataset.id; state.focusPos = 'end'; }
    if (wrap && state.ch.get(pid)?.total > 0) { wrap.remove(); afterDraw(); } // 빠른 길: 그 행만 지워요
    else redrawParent(pid);
    emit('node:delete', n);
  } else if (e.key === 'Backspace' && !mod && !e.altKey && !e.shiftKey && caret === 0 && getSelection().isCollapsed
             && (visible.indexOf(text) > 0 || (state.zoom !== null && n.parent_id === state.zoom && !$('#title').hidden))) {
    // 맨 앞에서 Backspace(맥의 delete): 바로 위 항목 끝에 이 항목 글을 붙이고, 하위 항목도 그 항목으로 옮겨요. 맨 위 항목이면 제목(지금 들어와 있는 항목)으로.
    e.preventDefault();
    const k = visible.indexOf(text);
    await mergeIntoPrev(n, text, k > 0 ? +visible[k - 1].dataset.id : state.zoom);
  } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.altKey && !mod && !e.shiftKey) {
    // 화살표: 글 안에서는 먼저 끝(↓·→)이나 처음(↑·←)까지 가고, 거기서 한 번 더 누르면 이웃 항목으로 넘어가요.
    // ↑·↓로 넘어가면 그 항목의 맨 앞에, ←로 넘어가면 맨 끝에, →로 넘어가면 맨 앞에 커서를 둬요.
    if (!getSelection().isCollapsed) return;
    const back = e.key === 'ArrowUp' || e.key === 'ArrowLeft';
    const vertical = e.key === 'ArrowUp' || e.key === 'ArrowDown';
    const edge = back ? caret === 0 : caret >= text.textContent.length;
    if (edge) {
      const next = visible[visible.indexOf(text) + (back ? -1 : 1)];
      if (next) { e.preventDefault(); setCaret(next, e.key === 'ArrowLeft' ? 'end' : 0); }
      else if (back && !$('#title').hidden) { e.preventDefault(); setCaret($('#title'), e.key === 'ArrowLeft' ? 'end' : 0); } // 맨 위 → 제목
      else e.preventDefault();
    } else if (vertical) edgeAfterDefault(text, caret, back);
  }
}

function redrawRowOf(n) { // 행 하나의 글자만 다시 맞춰요 (하위 행은 건드리지 않아요)
  const el = document.querySelector(`#tree .text[data-id="${n.id}"]`);
  if (el) paintText(el, n.content);
}

/** Alt+↑: 한 단계 밖으로. 지금 화면의 항목 밖으로 나가고, 있던 자리에 커서를 둬요 */
async function goUp() {
  if (state.zoom === null) return;
  const zn = state.nodes.get(state.zoom);
  await flushAll();
  state.focusId = state.zoom;
  state.focusPos = 'end';
  setZoom(zn?.parent_id ?? null, state.zoom);
}

$('#add').onclick = async () => {
  const id = newIdNow() ?? await newId();
  const node = { id, parent_id: state.zoom, content: '', collapsed: 0, hk: 0 };
  state.nodes.set(id, node);
  chInsert(state.zoom, id, null);
  saveNew(node, state.zoom, null);
  undoPush({ k: 'tree', present: true, ids: [id] });
  state.focusId = id;
  state.focusPos = 'end';
  const c = state.ch.get(state.zoom);
  if (c && c.ids.includes(id)) render();
  else { state.ensure = null; await refresh(); }
};

/** 같은 서버에 붙은 창을 하나 더 열어요 (주소창 없는 팝업 창으로) */



// ---- 전역 단축키 (Workflowy 배열: ⌘. 줌인 · ⌘, 줌아웃 · ⌃T 오늘 · ⌘Enter 완료 · ⇧⌘D 복제 · ⇧⌘E 내보내기 · ⌘O 완료 숨기기 · ⇧⌘8 즐겨찾기 · ⌘' 홈 · ⌘K 점프 · ⇧⌘9/0 형제로) ----
const currentNodeId = () => {
  const a = document.activeElement;
  if (a?.classList?.contains('text') && a.dataset.id) return +a.dataset.id;
  if (a?.id === 'title' && state.zoom !== null) return state.zoom; // 제목 = 들어와 있는 항목
  return state.sel.size === 1 ? [...state.sel][0] : null;
};
const currentIds = () => { // 커서가 있는 항목, 없으면 선택한 항목들(화면 순서)
  const id = currentNodeId();
  return id !== null ? [id] : visibleIds().filter((x) => state.sel.has(x));
};
async function duplicateNode(id) {
  const n = state.nodes.get(id);
  if (!n) return;
  await flushAll();
  const r = await http('/api/duplicate', 'POST', { id });
  if (r.error) return toast(r.error);
  undoPush({ k: 'tree', present: true, ids: [r.id] });
  state.focusId = r.id; state.focusPos = 'end';
  state.ensure = n.parent_id === state.zoom ? r.id : null;
  await refresh();
}
async function jumpSibling(dir) { // 지금 들어와 있는 항목의 이전/다음 형제 항목 안으로
  if (state.zoom === null) return toast('먼저 어떤 항목 안으로 들어가세요');
  await flushAll();
  const r = await http(`/api/sibling?id=${state.zoom}&dir=${dir}`);
  if (r.id == null) toast(dir < 0 ? '이전 형제 항목이 없어요' : '다음 형제 항목이 없어요');
  else zoomTo(r.id);
}
document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || e.isComposing || e.keyCode === 229 || paletteOpen()) return;
  if (e.target.closest?.('input, textarea, select, [data-plugin-ui]')) return;
  const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
  const run = (fn) => { e.preventDefault(); e.stopPropagation(); fn(); };
  if (undoKey(e)) return;
  if (e.key === 'Enter' && !mod && !e.altKey && !e.shiftKey && !state.sel.size && !e.target.closest?.('#tree, #title, button, a')
      && state.ch.get(state.zoom)?.total === 0) return run(() => $('#add').click()); // 하위가 없는 항목 안에서 (커서 없이) Enter → 첫 항목
  if (!mod || e.altKey) return;
  const dot = e.code === 'Period' || e.key === '.' || e.key === '>', comma = e.code === 'Comma' || e.key === ',' || e.key === '<';
  if (dot && !e.shiftKey) { const id = currentNodeId(); if (id !== null && id !== state.zoom) run(() => { state.focusFirst = true; zoomTo(id); }); } // ⌘. 줌인
  else if (comma && !e.shiftKey) run(goUp);                                          // ⌘, 줌아웃
  else if (dot && e.shiftKey) run(() => jumpSibling(1));                             // ⌘⇧. 다음 형제 항목 안으로
  else if (comma && e.shiftKey) run(() => jumpSibling(-1));                          // ⌘⇧, 이전 형제 항목 안으로
  else if (e.code === 'Slash' && !e.shiftKey) run(openCmds);                       // ⌘/ 명령 목록 (앱이 주는 단 하나의 명령 창)
});
initMobile();

// ---- 드래그 앤 드롭 ----
// 점(●)을 끌어서 옮겨요. 행의 위쪽 = 그 항목 앞 · 아래쪽 = 그 항목 뒤 · 가운데 = 그 항목의 하위로.
// 선택된 항목의 점을 끌면 선택한 항목 전부가 함께 옮겨져요. 화면 위/아래 끝으로 가면 자동 스크롤, Esc로 취소.
const drag = { on: false, ids: [], ghost: null, line: null, drop: null, lastEvt: null, raf: 0, justEnded: false, targetRow: null };

function onBulletDown(e, n) {
  if (e.button !== 0) return;
  const sx = e.clientX, sy = e.clientY;
  let started = false;
  const move = (ev) => {
    if (!started) {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return; // 6px 미만은 클릭으로 봐요
      started = true;
      beginDrag(n, ev);
    }
    drag.lastEvt = ev;
    updateDrag(ev);
  };
  const finish = async (ev, cancel) => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    document.removeEventListener('pointercancel', cancelH);
    document.removeEventListener('keydown', esc, true);
    if (started) await endDrag(cancel);
  };
  const up = (ev) => finish(ev, false);
  const cancelH = (ev) => finish(ev, true);
  const esc = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); finish(ev, true); } };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
  document.addEventListener('pointercancel', cancelH);
  document.addEventListener('keydown', esc, true);
}

function beginDrag(n, ev) {
  drag.on = true;
  drag.ids = state.sel.has(n.id) ? topSelected() : [n.id];
  drag.drop = null;
  leaveText();
  const g = mk('div', 'dragghost');
  const first = state.nodes.get(drag.ids[0])?.content || '(빈 항목)';
  g.textContent = drag.ids.length > 1 ? `${first.slice(0, 30)} 외 ${drag.ids.length - 1}개` : first.slice(0, 40);
  document.body.append(g);
  drag.ghost = g;
  drag.line = mk('div', 'dropline');
  drag.line.hidden = true;
  document.body.append(drag.line);
  document.body.classList.add('dragging');
  for (const id of drag.ids) document.querySelector(`#tree .node[data-nid="${id}"]`)?.classList.add('dragsrc');
  drag.raf = requestAnimationFrame(autoScroll);
  updateDrag(ev);
}

function updateDrag(ev) {
  drag.ghost.style.transform = `translate(${ev.clientX + 12}px, ${ev.clientY + 8}px)`;
  drag.targetRow?.classList.remove('drop-child');
  drag.targetRow = null;
  drag.drop = null;
  drag.line.hidden = true;
  const el = document.elementFromPoint(ev.clientX, ev.clientY);
  const rowEl = el?.closest?.('#tree .row');
  if (!rowEl || rowEl.closest('.dragsrc')) return;
  const tn = state.nodes.get(+rowEl.dataset.id);
  if (!tn) return;
  const rect = rowEl.getBoundingClientRect();
  const zone = dropZone(ev.clientY, rect.top, rect.height);
  const c = state.ch.get(tn.id);
  const t = dropTarget(zone, { id: tn.id, parent_id: tn.parent_id, open: isOpen(tn), firstChild: c?.ids[0] ?? null });
  if (movesIntoSelf(state.nodes, drag.ids, t.parent)) return;
  if ((t.pos.before != null && drag.ids.includes(t.pos.before)) || (t.pos.after != null && drag.ids.includes(t.pos.after))) return;
  drag.drop = { ...t, zone, targetId: tn.id };
  const left = rowEl.querySelector('.text').getBoundingClientRect().left;
  if (zone === 'child' && !(isOpen(tn) && c?.ids.length)) {
    rowEl.classList.add('drop-child');
    drag.targetRow = rowEl;
  } else {
    const indent = zone === 'after' && isOpen(tn) && c?.ids.length ? 24 : 0; // 펼쳐진 항목의 첫 자식 자리
    drag.line.style.left = `${left + indent}px`;
    drag.line.style.width = `${Math.max(40, rect.right - left - indent)}px`;
    drag.line.style.top = `${(zone === 'before' ? rect.top : rect.bottom) - 1}px`;
    drag.line.hidden = false;
  }
}

function autoScroll() {
  if (!drag.on) return;
  const y = drag.lastEvt?.clientY;
  if (y !== undefined) {
    const edge = 80, h = innerHeight;
    const v = y < edge ? -(edge - y) / 4 : y > h - edge ? (y - (h - edge)) / 4 : 0;
    if (v) { scrollBy(0, v); updateDrag(drag.lastEvt); }
  }
  drag.raf = requestAnimationFrame(autoScroll);
}

async function endDrag(cancel) {
  const { drop, ids } = drag;
  drag.on = false;
  cancelAnimationFrame(drag.raf);
  drag.ghost?.remove();
  drag.line?.remove();
  drag.targetRow?.classList.remove('drop-child');
  document.body.classList.remove('dragging');
  document.querySelectorAll('.dragsrc').forEach((x) => x.classList.remove('dragsrc'));
  drag.justEnded = true; // 이어서 오는 click(점 클릭 = 이동)은 무시해요
  setTimeout(() => { drag.justEnded = false; }, 0);
  if (cancel || !drop) return;
  const dn = state.nodes.get(drop.parent);
  // 다른 항목 '안'에 넣을 때는 그 항목을 펼치지 않아요: 접혀 있으면 그대로, 하위가 없던 항목이면 접힌 채로 시작
  if (dn && drop.parent === drop.targetId && !isOpen(dn) && !dn.collapsed) { dn.collapsed = 1; later(() => patch(dn.id, { collapsed: 1 })); }
  await moveNodes(ids, drop.parent, drop.pos, null);
}


// ---- 이 앱의 편집 · 이동 단축키 (명령이 아닌 것) — keys 플러그인(⌘/)이 보여줘요. 손에 익은 일반 키(복사 · 붙여넣기 · 되돌리기 · 전체 선택)는 빼요 ----
// [하는 일, Windows · Linux, Mac] — 키를 바꾸면 여기도 같이 고쳐요 (명령 단축키는 각 플러그인 파일의 keys가 정해요)
/** ⌘/ 명령 목록 — 막대 · 글자 설정을 바꾸면 선택 막대 · 글자 메뉴를 다시 그려요 */
const openCmds = () => openCommandList({ after: () => { paintSel(); fmtBar.update(); } });

// ---- 플러그인 API ----
/** id 아래 모든 하위 항목을 불러와요 → { count, truncated } (화면은 그대로) */
async function loadSubtree(id = state.zoom) {
  const r = await http(`/api/subtree?root=${ck(id)}`);
  const walk = (pid) => { const c = state.ch.get(pid); if (c) for (const cid of c.ids) { walk(cid); state.nodes.delete(cid); } state.ch.delete(pid); };
  if (id !== state.zoom) walk(id); // 옛 값 정리 (화면 자체는 그대로 둬요)
  const byParent = new Map();
  for (const n of r.nodes.sort((a, b) => a.position - b.position)) {
    const { position, ...node } = n;
    void position;
    const o = state.nodes.get(node.id);
    if (o) Object.assign(o, node); else state.nodes.set(node.id, node);
    if (!byParent.has(node.parent_id)) byParent.set(node.parent_id, []);
    byParent.get(node.parent_id).push(node.id);
  }
  for (const [pid, ids] of byParent) {
    const old = state.ch.get(pid);
    state.ch.set(pid, { ids, total: ids.length, show: Math.max(PAGE, old?.show ?? 0) });
  }
  if (r.truncated) toast('항목이 너무 많아 일부만 불러왔어요');
  return { count: r.nodes.length, truncated: r.truncated };
}
/** 항목 하나를 바로 고쳐 저장하고 그 줄을 다시 그려요 (플러그인 api.nodes.update) */
async function updateNode(id, changes) {
  const n = state.nodes.get(id);
  if (!n) return;
  clearTimeout(timers.get(id));
  timers.delete(id);
  Object.assign(n, changes);
  await patch(id, changes);
  emit('node:update', n);
  redraw(id);
}

// 플러그인 API(api.js)가 쓰는 앱 안쪽 — 플러그인은 이걸 직접 만지지 못하고, api.js가 묶어서 api.* 로만 내줘요
const core = {
  get isMac() { return isMac; }, get LINK_ICON() { return LINK_ICON; },
  kidNodes, loadSubtree, create, updateNode, moveNodes, duplicateNode, visibleIds, leaveText, paintSel, zoomTo, afterDraw, refresh, flushAll, topSelected, exportUrl,
  undoClear, printHtml, openCmds, showPdf, textElOf, fmtBar, selOffsets, applyMd, mdWrapped, applyHeading, headingOf, hlSet,
};
async function loadPlugins() {
  const { plugins } = await http('/api/plugins');
  for (const name of plugins) {
    try {
      const mod = await import(`/plugins/${name}`);
      mod.default(apiFor(name.replace(/\.js$/, '')));
    } catch (e) { console.error(`플러그인 ${name} 로드 실패`, e); }
  }
}

state.zoom = location.hash.length > 1 ? +location.hash.slice(1) : null;
if (location.search.includes('debug')) window.__outliner = { state, render, childRows, rowFor }; // 성능 측정용
refillIds();
const prefsReady = loadCmdPrefs();
try { const m = sessionStorage.getItem('outliner.toast'); if (m) { sessionStorage.removeItem('outliner.toast'); setTimeout(() => toast(m, 6000), 300); } } catch { /* 무시 */ }
try {
  await loadPlugins();
  await loadZoom();
  if (/[?&](img|pdf|media)=/.test(location.search)) setTimeout(() => openAppLink(location.href), 80); // 이미지 보기 · PDF · 오디오 · 영상 북마크 링크로 열었으면 그 자리로
} catch (e) { if (!/Failed to fetch|Load failed|NetworkError/i.test(String(e?.message ?? e))) throw e; } // 페이지 이동으로 끊긴 초기 요청은 무시
finally { booted(); } // 처음 화면을 그렸어요 → '불러오는 중' 표시 끄기
connectSync();

// 다른 파일들이 쓰는 것
export { afterDraw, captureFocus, caretOffset, ck, comboOf, composing, core, drag, exportUrl, flushAll, hasKids, importDbFile, importOutlineFile, ingest, isMac, LINK_ICON, openAppLink, patch, refresh, render, setCaret, settleFlash, setZoom, takeImg, textPoint, toggle, topSelected, undo, updateNode, upsert, zoomTo };
