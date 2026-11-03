// 플러그인 UI 부품 (앱 바탕) — 플러그인은 api.ui로만 써요. 모든 플러그인 창이 같은 디자인 언어(모양 · 움직임 · 말투)를 쓰게 앱이 줘요.
//   화면 짜기: sheet(상태 · body로 그린 창) + VStack · HStack · Text · Button · TextField … (view/view.js — SwiftUI처럼 코드로)
//   창: form(칸 · 미리 보기 — 데이터로) · dialog · choose · ask · confirmDelete · shell · prompt(고르는 입력창) · toast
//   글: 창에 넣는 글은 rich 글 — 글자 그대로에 **굵게** · `코드` · 줄바꿈만 (플러그인은 HTML을 쓰지 않아요)
//   부품: el · esc · tips(접은 도움말) · splitDialog(두 칸 창) · historyPanel(입력 기록) · icon
//   입력 기록: remember(칸, 값) · loadHistory(칸) · toggleFavValue(칸, 값) ★ · forget(칸, 값) 한 줄 지우기 · clearHistory(칸, { favs }) 비우기 — 기록 줄마다 ✕ · ⇧Delete · ⌘⌫
//   CSS 클래스(style.css '플러그인 UI 부품'): wfx-input · wfx-btn(ghost · danger) · wfx-seg · wfx-flag · wfx-row · wfx-split · wfx-col · wfx-preview · wfx-presets · wfx-pill · wfx-help · wfx-more · wfx-after · wfx-actions …
import { http, toast as coreToast } from './base.js';
import { askText, modal, modalShell } from './dialog.js';
import { LINK_ICON } from './app.js';
import { PDF_ICON } from './markup.js';
import { rich, makeForm, previewRow } from './uiform.js';
import { mount } from './view/view.js';
// 코드로 화면 짜기 (SwiftUI처럼) — view.js 그대로. 쓰는 법은 view/README.md
export { mount, VStack, HStack, ZStack, Grid, Spacer, Divider, Section, List, ForEach, Disclosure, Text, Rich, Marked, LabeledValue, Badge,
  Button, IconButton, Chip, Segmented, TextField, Toggle, Checkbox, Link, Picker, Embed, ColorWell, Swatch, Image, Audio, Meter, Dot, Spinner, Icon, Lines, Actions } from './view/view.js';
export { rich, previewRow };
export const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** 예전 이름 — 모양은 이제 style.css에 늘 있어요 */
export function injectStyle() {}

// ---- 입력 기록: 명령마다 최근에 넣은 값 · ★ 즐겨찾기 (DB plugin_data 'wfx' / 'hist-<명령>' 에 저장 → 다른 창 · 기기도 같아요) ----
const HIST_MAX = 30;
const hk = (v) => JSON.stringify(v);
const histUrl = (key) => `/api/plugin-data/wfx/hist-${encodeURIComponent(key)}`; // 명령마다 입력 기록 ('wfx' / 'hist-<명령>')
export async function loadHistory(key) {
  try {
    const v = (await http(histUrl(key))).value || {};
    return { recent: Array.isArray(v.recent) ? v.recent : [], favs: Array.isArray(v.favs) ? v.favs : [] };
  } catch { return { recent: [], favs: [] }; }
}
function saveHistory(key, h) {
  return http(histUrl(key), 'PUT', { value: h }).catch(() => {});
}
/** 실행한 값을 '최근'에 올려요 (같은 값은 하나만, 맨 앞으로) */
export async function remember(key, v) {
  if (v == null || (typeof v === 'string' && !v.trim())) return;
  const h = await loadHistory(key);
  h.recent = [{ v, t: Date.now() }, ...h.recent.filter((x) => hk(x.v) !== hk(v))].slice(0, HIST_MAX);
  await saveHistory(key, h);
}
/** ★ 넣기/빼기 → 바뀐 기록 */
export async function toggleFavValue(key, v) {
  const h = await loadHistory(key);
  const i = h.favs.findIndex((x) => hk(x) === hk(v));
  if (i >= 0) h.favs.splice(i, 1); else h.favs.push(v);
  await saveHistory(key, h);
  return h;
}
/** 기록에서 그 값 지우기 (최근 · ★ 모두) → 바뀐 기록 */
export async function forget(key, v) {
  const h = await loadHistory(key);
  h.recent = h.recent.filter((x) => hk(x.v) !== hk(v));
  h.favs = h.favs.filter((x) => hk(x) !== hk(v));
  await saveHistory(key, h);
  return h;
}
/** 기록 비우기 — favs: true면 ★ 고정도 같이 (기본은 최근만) → 바뀐 기록 */
export async function clearHistory(key, { favs = false } = {}) {
  const h = await loadHistory(key);
  h.recent = [];
  if (favs) h.favs = [];
  await saveHistory(key, h);
  return h;
}
/** 기록 한 줄의 ✕ 단추 (지우기) — 줄에 마우스를 올리거나 고르면 보여요 */
function delBtn(onDel) {
  const b = el('button', 'wfx-del', '✕'); b.type = 'button'; b.title = '기록에서 지우기 (⇧Delete · ⌘⌫)'; b.setAttribute('aria-label', '기록에서 지우기');
  b.onmousedown = (e) => e.preventDefault();
  b.onclick = (e) => { e.stopPropagation(); onDel(); };
  return b;
}
export function ago(t) {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return '방금';
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}일 전`;
  return new Date(t).toLocaleDateString('sv-SE');
}
/** 기록 → 보여 줄 항목들: ★ (넣은 순) → 최근 (★ 제외, 최근 순) */
function historyEntries(h) {
  const favKeys = new Set(h.favs.map(hk));
  return [
    ...h.favs.map((v) => ({ v, kind: 'fav', t: h.recent.find((x) => hk(x.v) === hk(v))?.t })),
    ...h.recent.filter((x) => !favKeys.has(hk(x.v))).map((x) => ({ v: x.v, kind: 'recent', t: x.t })),
  ];
}
/** 접어 둔 도움말 (눌러야 펼쳐져요) — 식 · 패턴 설명이 창을 길게 만들지 않게 */
export const tips = (html, label = '도움말') => `<details class="wfx-tips"><summary>${label}</summary><div class="wfx-help">${html}</div></details>`;
/** 넓은 두 칸 창: 왼쪽 입력 · 오른쪽 미리 보기 (좁은 화면에서는 위아래로), 버튼은 아래에 붙어 스크롤해도 보여요 */
export const splitDialog = (w) => queueMicrotask(() => w.closest('.wfx-dialog')?.classList.add('split'));
/** 대화상자 안에 넣는 기록 목록 (여러 칸 입력용, 예: 치환의 찾기→바꾸기). show(v)=보여 줄 글, onPick(v)=눌렀을 때 */
export function historyPanel(key, { show = (v) => String(v), onPick = () => {} } = {}) {
  const box = el('div', 'wfx-hist');
  const paint = (h) => {
    const list = historyEntries(h);
    box.replaceChildren();
    box.hidden = !list.length; // 기록이 없으면 칸도 숨겨요
    for (const it of list) {
      const row = el('div', 'wfx-hist-row' + (it.kind === 'fav' ? ' fav' : ''));
      const star = el('button', 'wfx-star' + (it.kind === 'fav' ? ' on' : ''), it.kind === 'fav' ? '★' : '☆');
      star.type = 'button'; star.title = it.kind === 'fav' ? '즐겨찾기에서 빼기' : '즐겨찾기';
      star.onclick = async (e) => { e.stopPropagation(); paint(await toggleFavValue(key, it.v)); };
      const txt = el('span', 'wfx-hist-text', show(it.v));
      const when = el('span', 'wfx-hist-when', it.t ? ago(it.t) : '');
      row.append(star, txt, when, delBtn(async () => paint(await forget(key, it.v))));
      row.onclick = () => onPick(it.v);
      box.append(row);
    }
  };
  loadHistory(key).then(paint);
  return box;
}

// ---- 명령 팔레트 ----
// resultItems: 문자열 목록(입력으로 걸러져요). 반환: 입력한 글자 / 고른 항목 / 취소하면 null
// 화살표로 항목을 고른 뒤 Enter를 누르면 고른 항목이, 그렇지 않으면 입력한 글자가 반환돼요.
// pick: true면 항상 강조된 항목을 우선 반환해요(명령 팔레트용).
// history: '명령 이름'을 주면 그 명령의 ★ 즐겨찾기 · 최근 입력이 목록 맨 위에 나오고, 실행한 값은 최근 기록에 쌓여요.
//          ☆를 누르거나 ⇧Enter(고른 줄, 아무것도 안 골랐으면 입력한 글자)로 ★. 입력칸이 비어 있으면 Enter는 맨 위 줄을 실행해요.
// 줄의 ✎ 또는 Tab: 그 줄의 글자를 실행하지 않고 입력칸에 넣어요 — 고쳐서 Enter로 실행.
// source(글) → [{ v, label, sub }]: 목록을 그때그때 받아 올 때 (서버 검색 등) — 고르면 그 줄의 v를 돌려줘요 (글자를 걸러 보지 않아요). '치고 고르는 창'은 모두 이 모양 하나예요
export async function prompt(message = '입력하세요', resultItems = [], { pick = false, history = null, value: initial = '', source = null } = {}) { // value: 입력 칸에 미리 넣을 글 (고른 글자)
  let hist = history ? await loadHistory(history) : null;
  const build = () => [...(hist ? historyEntries(hist) : []), ...resultItems.filter((x) => !hist || !historyEntries(hist).some((e) => e.v === x)).map((v) => ({ v, kind: 'preset' }))];
  let all = build();
  const value = await new Promise((resolve) => {
    if (document.querySelector('.wfx-prompt')) return resolve(null);
    injectStyle();
    const box = el('div', 'wfx-prompt');
    box.dataset.pluginUi = '';
    const input = el('input');
    input.type = 'text';
    input.placeholder = message;
    input.spellcheck = false;
    const results = el('div', 'results');
    box.append(input, results);

    let filtered = [...all], selected = 0, navigated = false, rows = [], closed = false;

    const highlight = (text, q) => {
      const i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
      if (i < 0) return esc(text);
      return `${esc(text.slice(0, i))}<span class="hl">${esc(text.slice(i, i + q.length))}</span>${esc(text.slice(i + q.length))}`;
    };
    const mark = () => {
      rows.forEach((r, i) => r.classList.toggle('selected', i === selected));
      rows[selected]?.scrollIntoView({ block: 'nearest' });
    };
    let seq = 0;
    const refilter = () => {
      if (source) { // 받아 오는 목록: 고친 글로 다시 받아요 (늦게 온 옛 답은 버려요)
        const my = ++seq;
        Promise.resolve(source(input.value)).then((list) => { if (my !== seq || closed) return; all = filtered = (list || []).map((x) => ({ ...x, kind: 'src' })); selected = 0; paint(); }).catch(() => {});
        return;
      }
      const q = input.value.toLowerCase();
      filtered = all.filter((it) => String(it.v).toLowerCase().includes(q));
    };
    const toggleStar = async (v) => {
      if (!hist || v == null || v === '') return;
      hist = await toggleFavValue(history, v);
      all = build(); refilter();
      selected = Math.max(0, filtered.findIndex((it) => it.v === v));
      paint();
    };
    /** 기록 한 줄 지우기 (✕ · ⇧Delete · ⌘⌫) */
    const drop = async (v) => {
      if (!hist) return;
      hist = await forget(history, v);
      all = build(); refilter();
      selected = Math.min(selected, Math.max(0, filtered.length - 1));
      paint(); input.focus({ preventScroll: true });
    };
    /** 고른 줄의 글자를 입력칸에 넣기만 해요(실행하지 않음). 커서는 끝에 */
    const putInInput = (v) => {
      input.value = String(v);
      input.focus({ preventScroll: true });
      input.setSelectionRange(input.value.length, input.value.length);
      refilter();
      selected = Math.max(0, filtered.findIndex((it) => String(it.v) === input.value));
      navigated = false; // 이제 Enter는 입력칸의 글자를 실행해요
      paint();
    };
    const paint = () => {
      results.replaceChildren();
      if (!all.length && !(source && input.value)) { results.style.display = 'none'; rows = []; return; }
      results.style.display = 'block';
      if (!filtered.length) {
        results.append(el('div', 'empty-state', '맞는 항목이 없어요'));
        rows = [];
        return;
      }
      rows = filtered.map((it, i) => {
        const row = el('div', 'result-item' + (i === selected ? ' selected' : '') + (it.kind === 'fav' ? ' fav' : ''));
        if (hist) {
          const star = el('button', 'wfx-star' + (it.kind === 'fav' ? ' on' : ''), it.kind === 'fav' ? '★' : '☆');
          star.type = 'button'; star.title = it.kind === 'fav' ? '즐겨찾기에서 빼기' : '즐겨찾기';
          star.onmousedown = (e) => e.preventDefault();
          star.onclick = (e) => { e.stopPropagation(); toggleStar(it.v); };
          row.append(star);
        }
        if (it.kind === 'src') { // 받아 온 줄: 글 + 아래 작은 글(위치 등)
          const txt = el('span', 'txt'); txt.textContent = it.label ?? String(it.v);
          if (it.sub) { const sub = el('span', 'sub', it.sub); txt.append(sub); }
          row.append(txt);
          row.onclick = () => finish(it.v);
          row.onmouseenter = () => { selected = i; mark(); };
          results.append(row);
          return row;
        }
        const txt = el('span', 'txt'); txt.innerHTML = highlight(String(it.v), input.value); row.append(txt);
        if (it.kind !== 'preset' && it.t) row.append(el('span', 'when', ago(it.t)));
        if (hist && it.kind !== 'preset') row.append(delBtn(() => drop(it.v)));
        const edit = el('button', 'wfx-edit', '✎');
        edit.type = 'button'; edit.title = '실행하지 않고 입력칸에 넣기 (Tab)';
        edit.onmousedown = (e) => e.preventDefault();
        edit.onclick = (e) => { e.stopPropagation(); putInInput(it.v); };
        row.append(edit);
        row.onclick = () => finish(String(it.v).trim());
        row.onmouseenter = () => { selected = i; mark(); };
        results.append(row);
        return row;
      });
    };
    const outside = (e) => {
      if (!box.contains(e.target) && !e.target.closest?.('#wfx-btn')) finish(null);
    };
    function finish(v) {
      if (closed) return;
      closed = true;
      document.removeEventListener('mousedown', outside, true);
      box.classList.remove('show');
      box.classList.add('hide');
      setTimeout(() => { box.remove(); resolve(v); }, 120);
    }

    input.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return; // 한글 조합 중에는 무시
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        navigated = true;
        selected = Math.max(0, Math.min(rows.length - 1, selected + (e.key === 'ArrowDown' ? 1 : -1)));
        mark();
      } else if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault(); // 포커스가 입력칸을 벗어나지 않게
        if (rows.length && !source) putInInput(filtered[selected].v);
      } else if (hist && rows.length && filtered[selected]?.kind !== 'preset' && ((e.key === 'Delete' && e.shiftKey) || (e.key === 'Backspace' && (e.metaKey || e.ctrlKey) && (navigated || !input.value)))) {
        e.preventDefault(); // ⇧Delete · ⌘⌫: 고른 기록 줄 지우기
        drop(filtered[selected].v);
      } else if (e.key === 'Enter' && e.shiftKey && hist) {
        e.preventDefault();
        toggleStar((navigated || !input.value) && rows.length ? filtered[selected].v : input.value);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (source) { if (rows.length) finish(filtered[selected].v); return; } // 받아 온 목록은 줄을 골라야 해요
        finish((pick || navigated || (hist && !input.value)) && rows.length ? String(filtered[selected].v) : input.value);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        finish(null);
      }
    });
    let wait = 0;
    input.addEventListener('input', () => {
      if (source) { clearTimeout(wait); wait = setTimeout(refilter, 120); return; }
      refilter();
      const q = input.value.toLowerCase();
      const exact = filtered.findIndex((it) => String(it.v).toLowerCase() === q);
      selected = exact !== -1 ? exact : 0;
      navigated = false;
      paint();
    });

    document.body.appendChild(box);
    document.addEventListener('mousedown', outside, true);
    if (initial) { input.value = String(initial); refilter(); selected = 0; navigated = false; } // 미리 넣은 글 (고른 글자) — 그대로 Enter면 그 글로
    else if (source) refilter(); // 빈 칸일 때의 목록도 받아 와요
    paint();
    input.focus({ preventScroll: true });
    if (initial) input.select();
    requestAnimationFrame(() => requestAnimationFrame(() => box.classList.add('show')));
  });
  if (history && value != null && value !== '') remember(history, value);
  return value;
}

// ---- 대화상자 · 알림 ----
/** 대화상자 → 눌린 단추의 value(없으면 label) · close(v)로 닫은 값 · Esc · 바깥 = null
 *  dialog(제목, 내용, 단추들) — 내용: HTML | Node | (close) => Node. 단추: [{ label, value?, cls?('ghost' · 'danger'), primary? }]
 *  dialog({ title, body, buttons, cls, onKey, focus, outside, still }) — 키 · 바깥 누르기 · 움직임까지 정할 때 (still: 나타나는 움직임 없이)
 *  close(v, { instant: true }): 사라지는 움직임 없이 바로 닫기 (같은 자리에 다른 창을 바로 열 때) */
export function dialog(title, content, actions = [], opts = {}) {
  if (title && typeof title === 'object') return modal({ plugin: true, ...title, body: typeof title.body === 'string' ? rich(title.body) : title.body });
  return modal({ ...opts, title, body: typeof content === 'string' ? rich(content) : content, plugin: true, buttons: actions.map((a) => ({ label: a.label, cls: a.cls, primary: a.primary, danger: a.danger, ...('value' in a ? { value: a.value } : {}) })) });
}
/** 단추 고르기 → 고른 단추의 value (value가 없으면 번호, 0부터) · 취소하면 null. labels: ['A-Z', 'Z-A'] · [{ label, value, primary }] */
export const choose = (title, html, labels) => // 기본 단추(primary)만 진하게, 나머지는 옅게 — 앱의 고르기 창과 같은 모양
  dialog(title, html, labels.map((l, i) => { const o = typeof l === 'object' ? { ...l, value: 'value' in l ? l.value : i } : { label: l, value: i }; return o.primary || o.danger || o.cls ? o : { ...o, cls: 'ghost' }; }));
/** 글 받기 (여러 줄) → { action: 누른 단추의 value, text } · 취소하면 null */
export const ask = (title, value, buttons, note = '') => askText(title, value, buttons, rich(note));
/** 지우기 · 삭제 전에 한 번 더 물어요 (취소 · 빨간 단추) → 지우면 true */
export const confirmDelete = (title, html, verb = '지우기') =>
  dialog({ title, body: html, buttons: [{ label: '취소', value: false, cls: 'ghost' }, { label: verb, value: true, cls: 'danger' }], focus: (d) => d.querySelector('.wfx-btn.danger') }).then((v) => v === true); // 앱의 지우기 확인처럼 Enter = 지우기
/** 빈 창 틀 → { dlg, close } — 다 직접 그릴 때 (plugin: false면 앱 창 모양 .pdf-dlg) */
export const shell = (o = {}) => modalShell({ plugin: true, ...o });
/** 아래쪽 알림 (앱과 같은 자리 · 모양). sec 초 · err면 빨간색 */
export const toast = (msg, sec = 2, err = false) => coreToast(msg, sec * 1000, err);
/** 앱이 쓰는 그림 (svg 글, 선 아이콘 · currentColor) — 플러그인도 앱과 같은 아이콘을 써요
 *  'link' 🔗 · 'bookmark' 책갈피(파일 보기의 북마크와 같은 모양 — 채우려면 CSS로 path에 fill) · 그 밖에 앱 아이콘 이름(prev · next · download · close · open …) */
export const icon = (name) => {
  if (name === 'link') return LINK_ICON;
  const svg = PDF_ICON[name === 'bookmark' ? 'mark' : name] || '';
  return svg.replace('width="16" height="16"', 'width="14" height="14"'); // 🔗와 같은 크기
};

/** 칸 · 미리 보기 창 (데이터로) — 쓰는 법은 uiform.js */
export const form = makeForm({ dialog, historyPanel, remember });

/** 코드로 그린 창: sheet({ title, state, body: (상태, set, close) => 뷰, size: 'auto'|'wide', still, onKey: (e, 상태, set, close) => 받았으면 true }) → close(값) · Esc · 바깥 = null
 *  task(상태, set, close): 연 뒤 한 번 (불러오기) · size 'wide' 넓게 · 'full' 화면 가득 (달력처럼) · 'palette' 위쪽 찾기 창 (결과가 아래로) · 앱 창 틀(움직임 · 겹친 창 · 단축키 막기)은 그대로, 안은 view.js로 */
export function sheet({ title = '', state = {}, body, task = null, size = 'auto', still = false, onKey = null, outside = true, cls = '', blur = false } = {}) { // blur: 뒤 화면을 흐리게 (복습 카드처럼 미리 보면 안 될 때)
  let m = null;
  if (blur) document.body.classList.add('ui-blur-behind');
  return modal({
    plugin: true, title, still, outside, cls: [{ wide: 'split', full: 'full', palette: 'palette' }[size] || '', cls].filter(Boolean).join(' '),
    onKey: onKey && ((e, close) => onKey(e, m.state, m.set, close)),
    body: (close) => { const host = el('div', 'v-host'); m = mount(host, state, (s, set) => body(s, set, close), { task: task && ((s, set) => task(s, set, close)) }); return host; },
    focus: (dlg) => dlg.querySelector('[data-autofocus]') || dlg.querySelector('input, textarea') || dlg.querySelector('.v-btn.v-primary') || dlg.querySelector('button'),
  }).finally(() => { m?.stop(); if (blur) document.body.classList.remove('ui-blur-behind'); }); // 닫히는 동안 다시 그리거나 커서를 가져가지 않게
}
