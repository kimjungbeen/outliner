// 글자 서식 (앱 바탕): 고른 글자를 마크다운 기호로 감싸기 · 풀기 · 제목 단계 · 형광펜, 그리고 글자를 고르면 뜨는 글자 메뉴(자리만 — 단추는 명령이 채워요)
// 플러그인은 이걸 직접 쓰지 않고 api.text로만 (api.js)
import { caretOffset, composing, textPoint, undo } from './app.js';
import { mk } from './base.js';
import { hlHex } from './lib.js';
import { View, build } from './view/view.js';
import { fmtCombo, inTextBar, isModKey, keyOfCommand, paletteCommands, paletteOpen, runCommandNow } from './commands.js';

// ---- 글자 서식 바탕 (굵게 · 기울임 · 형광펜 · 제목 …의 단축키와 글자 메뉴 단추는 플러그인 — plugins/bold.js 등이 api.text로 해요) ----
// 고른 글자를 기호로 감싸요 · 이미 감싸져 있으면 풀어요 · 안 고르면 기호 한 쌍 사이에 커서. 형광펜은 =={헥스}글자==
/** 글자 칸 안의 선택 → {start, end} (글자 위치). 칸 밖이면 null */
/** 고른 범위 양끝의 띄어쓰기는 빼요 — "**글자 **"처럼 기호 안쪽에 공백이 있으면 마크다운 서식이 안 돼요 */
function trimSel(el, o) {
  if (!o || o.start === o.end) return o;
  const t = el.textContent;
  let { start, end } = o;
  while (start < end && /\s/.test(t[start])) start++;
  while (end > start && /\s/.test(t[end - 1])) end--;
  if (start === end) return o;
  if (start !== o.start || end !== o.end) selectOffsets(el, start, end);
  return { start, end };
}
function selOffsets(el) {
  const s = getSelection();
  if (!s.rangeCount) return null;
  const r = s.getRangeAt(0);
  if (!el.contains(r.startContainer) || !el.contains(r.endContainer)) return null;
  const a = document.createRange(); a.selectNodeContents(el); a.setEnd(r.startContainer, r.startOffset);
  const start = a.toString().length;
  return { start, end: start + r.toString().length };
}
function selectOffsets(el, a, b) {
  const [n1, o1] = textPoint(el, a), [n2, o2] = textPoint(el, b);
  const r = document.createRange(); r.setStart(n1, o1); r.setEnd(n2, o2);
  const s = getSelection(); s.removeAllRanges(); s.addRange(r);
}
const sealUndo = () => { const top = undo.stack[undo.stack.length - 1]; if (top?.k === 'text') top.t = 0; }; // 앞뒤 타이핑과 묶이지 않게 → ⌘Z 한 번에 이 서식만 되돌려요
const put = (x) => { sealUndo(); if (x) document.execCommand('insertText', false, x); else document.execCommand('delete'); sealUndo(); };
/** 글 속 색 표시 → 6자리 소문자 헥스 ('' 표시 없음 = 노랑 · 예전 이름 green 등도 헥스로) */
const hlKey = (c) => (c == null ? null : hlHex(c === '' ? 'yellow' : c).slice(1));
/** 고른 글자의 형광펜 상태 → { a, b, inner, color } (a~b: 바꿀 범위 · color: null이면 안 칠함, ''이면 노랑) */
function hlState(el, { start, end }) {
  const t = el.textContent;
  let a = start, b = end, inner = t.slice(start, end), color = null;
  const own = /^==(?:\{(\w+)\})?([\s\S]*)==$/.exec(inner); // 기호까지 골랐으면
  const before = /==(?:\{(\w+)\})?$/.exec(t.slice(0, start)); // 기호 바로 안쪽을 골랐으면
  if (own && inner.length >= 4) { color = own[1] ?? ''; inner = own[2]; }
  else if (before && t.slice(end, end + 2) === '==') { color = before[1] ?? ''; a = start - before[0].length; b = end + 2; }
  return { a, b, inner, color: hlKey(color) };
}
/** 커서가 들어 있는 형광펜 → { a, b, inner, color } (없으면 null) — 칠한 곳을 누르면 색 바꾸기 · 지우기 막대 */
function hlAround(el, pos) {
  const t = el.textContent;
  for (const m of t.matchAll(/==(?:\{(\w+)\})?(?=\S)(.+?)(?<=\S)==/g)) {
    if (pos > m.index && pos < m.index + m[0].length) return { a: m.index, b: m.index + m[0].length, inner: m[2], color: hlKey(m[1] ?? '') };
  }
  return null;
}
/** 형광펜을 color('' 노랑 · 'red' …)로, null이면 지우기. 고른 글자는 계속 골라진 채로 */
function hlSet(el, st, color) {
  const { a, b, inner } = st;
  const open = color === null ? '' : `=={${color}}`, close = color === null ? '' : '=='; // 색은 언제나 헥스로 적어요
  selectOffsets(el, a, b);
  put(open + inner + close);
  selectOffsets(el, a + open.length, a + open.length + inner.length);
}
/** 고른 글자를 mk(** * ` ~~)로 감싸거나, 이미 감싸져 있으면 풀어요 */
function applyMd(el, mk) {
  const o = trimSel(el, selOffsets(el));
  if (!o) return;
  const t = el.textContent, L = mk.length, { start, end } = o, picked = t.slice(start, end);
  if (mdWrapped(t, start, end, mk)) { // 기호 바로 안쪽을 골랐으면 풀기
    selectOffsets(el, start - L, end + L); put(picked); selectOffsets(el, start - L, end - L);
  } else if (picked.length >= 2 * L && picked.startsWith(mk) && picked.endsWith(mk)) { // 기호까지 골랐으면 풀기
    put(picked.slice(L, -L)); selectOffsets(el, start, end - 2 * L);
  } else { // 감싸기 (안 골랐으면 빈 한 쌍)
    put(mk + picked + mk); selectOffsets(el, start + L, end + L);
  }
}
/** start~end 글자가 mk로 감싸져 있나. * 는 앞뒤로 붙은 개수로: *기울임*(1) · **굵게**(2) · ***굵게+기울임***(3) */
function mdWrapped(t, start, end, mk) {
  const run = (i, dir) => { let k = 0; while (t[i + k * dir] === '*') k++; return k; };
  if (mk === '*') return run(start - 1, -1) % 2 === 1 && run(end, 1) % 2 === 1;
  if (mk === '**') return run(start - 1, -1) >= 2 && run(end, 1) >= 2;
  const L = mk.length;
  return start >= L && t.slice(start - L, start) === mk && t.slice(end, end + L) === mk;
}
/** 이 줄의 제목 단계 (# 개수, 없으면 0) */
const headingOf = (el) => /^(#{1,6})\s+/.exec(el.textContent)?.[1].length ?? 0;
/** 제목 단계 바꾸기: 줄 앞의 '# ' · '## ' · '### '을 붙이거나 바꾸고, 같은 단계면 떼요. 커서 · 고른 글자는 그대로 */
function applyHeading(el, level) {
  const t = el.textContent, m = /^(#{1,6})\s+/.exec(t), old = m ? m[0].length : 0;
  const prefix = m && m[1].length === level ? '' : '#'.repeat(level) + ' ';
  const o = selOffsets(el) ?? { start: t.length, end: t.length };
  if (!old && !prefix) return;
  selectOffsets(el, 0, old);
  put(prefix); // 빈 자리에 넣기 · 바꾸기 · 지우기(prefix '')
  const d = prefix.length - old, fix = (x) => Math.max(prefix.length, x + d);
  selectOffsets(el, fix(o.start), fix(o.end));
}
/** 브라우저 기본 서식(⌘B → <b> 등)이 글에 섞이지 않게 막아요 — 서식은 플러그인 명령이 마크다운으로 해요 (명령을 지워도 HTML이 끼지 않게) */
function blockBrowserFmt(e) {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || !/^Key[BIU]$/.test(e.code || '')) return false;
  e.preventDefault();
  return true;
}

// ---- 글자를 고르면 위에 뜨는 작은 글자 메뉴 (Gem 방식) ----
// 앱은 자리 잡기 · 띄우고 숨기기만 하고, 안의 단추는 명령(플러그인)이 채워요: addPaletteCommands([{ name, text: {…}, run }])
//   text: { label: 'B', title, style, group, order, active(ctx), hidden(ctx), render(ctx) → 뷰[] | { items: 뷰[], panel: 뷰 }, marks: true }
//     render는 view.js의 뷰(api.ui의 Swatch · IconButton · ColorWell …)를 돌려줘요 — '|'는 구분선, panel은 단추 줄 아래 펼친 칸
//     label만 주면 단추 하나(누르면 run) · render를 주면 직접 그려요(형광펜 색들) · group이 바뀌면 사이에 구분선 · order 작은 것부터
//     marks: 칠한 곳(형광펜)을 눌렀을 때도 보여요 — 그때 ctx.mode = 'hl'
//   ctx: { mode: 'sel' | 'hl', el, key(대상이 바뀌면 달라져요), color(지금 형광펜 색), wrapped(mk), level(), picked(): 고른 글자, redraw() }
// 글자 메뉴의 단추로 실행하면 명령의 run이 고른 글자를 첫 인자로 받아요 — run(글자) (단축키 · ⌘/로 실행하면 없어요)
// 어떤 명령을 띄울지는 ⌘/ 명령 목록의 '글자'로 바꿀 수 있어요 (안 정했으면 text가 있는 명령)
/** render가 돌려준 것 → DOM: 뷰 · '|'(구분선) · { items, panel } (panel은 아래 펼친 칸) */
function itemNodes(r) {
  if (!r) return null;
  const one = (x) => (x === '|' ? mk('span', 'fmt-sep') : x instanceof View ? build(x) : x);
  if (!Array.isArray(r) && !(r instanceof View) && !(r instanceof Node) && typeof r === 'object') {
    const out = [r.items].flat().filter(Boolean).map(one);
    if (r.panel) { const p = mk('div', 'fmt-panel'); p.append(...[r.panel].flat().filter(Boolean).map(one)); out.push(p); }
    return out;
  }
  return [r].flat().filter(Boolean).map(one);
}
const fmtBar = (() => {
  let bar = null, el = null, down = false, clicked = false, target = null; // target: 칠한 곳을 눌렀을 때 그 형광펜 범위
  let lastRect = null, drawn = ''; // drawn: 지금 그려 둔 내용 — 같으면 다시 그리지 않고 자리만 옮겨요 (스크롤 · 커서 이동 중에 색 고르기 창이 사라지지 않게)
  const items = (mode) => [...paletteCommands.values()].filter((c) => inTextBar(c) && (mode === 'sel' || c.text?.marks))
    .sort((a, b) => (a.text?.order ?? 100) - (b.text?.order ?? 100) || a.name.localeCompare(b.name));
  function ctxOf(mode, color) {
    const t = el.textContent, o = selOffsets(el);
    return {
      mode, el, color, key: mode === 'hl' ? `${el.dataset.id ?? el.id}:hl${target?.a}` : `${el.dataset.id ?? el.id}:${o?.start}-${o?.end}`,
      wrapped: (mk) => !!o && mdWrapped(t, o.start, o.end, mk),
      level: () => headingOf(el), // 제목(들어와 있는 항목) 칸도 다른 항목과 같아요
      redraw: () => { drawn = ''; render(mode, color); place(lastRect); },
      picked: () => (mode === 'hl' ? target?.inner ?? '' : getSelection().toString()), // 고른 글자 (칠한 곳을 눌렀으면 그 형광펜 안의 글자)
    };
  }
  function render(mode, color) {
    const list = items(mode), ctx = ctxOf(mode, color);
    const sig = [mode, color, list.map((c) => c.name).join(), el?.dataset.id ?? el?.id, el?.textContent, ctx.key].join('|');
    if (sig === drawn && bar.firstChild) return;
    drawn = sig;
    bar.replaceChildren();
    let group = null;
    for (const c of list) {
      const spec = c.text || { label: c.name };
      try { if (spec.hidden?.(ctx)) continue; } catch { continue; }
      let nodes;
      try { nodes = spec.render ? itemNodes(spec.render(ctx)) : null; } catch (err) { console.error(err); nodes = null; }
      if (spec.render && !nodes) continue;
      if (!nodes) {
        const text = spec.label ?? c.name;
        const b = mk('button', [...text].length > 3 ? 'fmt-btn txt' : 'fmt-btn'); b.type = 'button'; b.textContent = text; // 긴 글은 한 줄로 늘어나는 단추
        const k = keyOfCommand(c.name), name = spec.title || c.label || c.name;
        b.title = k ? `${name} (${fmtCombo(k)})` : name; b.setAttribute('aria-label', name);
        if (spec.style) b.style.cssText = spec.style;
        try { b.classList.toggle('on', !!spec.active?.(ctx)); } catch { /* 무시 */ }
        b.onclick = async (e) => { e.preventDefault(); await runCommandNow(c, ctx.picked()); later(); }; // 고른 글자를 명령에게 (첫 인자)
        nodes = b;
      }
      const g = spec.group ?? (c.text ? c.name : 'cmds'); // ⌘/에서 '글자'로 더한 명령(text 없음)들은 한 묶음으로 — 사이에 구분선 없이
      if (group !== null && g !== group) bar.append(mk('span', 'fmt-sep'));
      group = g;
      bar.append(...[nodes].flat());
    }
    bar.append(...bar.querySelectorAll(':scope > .fmt-panel')); // 펼친 칸(형광펜 '색 더 보기' 등)은 늘 맨 아래 — 단추 줄은 그대로 보여요
    if (!bar.firstChild) bar.hidden = true;
  }
  function build() {
    bar = mk('div', 'fmt-bar');
    bar.hidden = true;
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', '글자 메뉴');
    bar.addEventListener('mousedown', (e) => { if (!(e.target instanceof HTMLInputElement)) e.preventDefault(); }); // 눌러도 글자 선택이 풀리지 않게 (색 고르기는 예외)
    document.body.append(bar);
  }
  function hide() { if (bar) bar.hidden = true; el = null; target = null; drawn = ''; }
  function place(rect) {
    if (!rect || !bar.firstChild) return;
    lastRect = rect;
    bar.hidden = false;
    bar.style.left = '0px'; // 지난 자리에서 재면 오른쪽 끝에 걸려 줄이 바뀌어요 — 왼쪽 끝에서 재요
    const w = bar.offsetWidth, h = bar.offsetHeight;
    const x = Math.min(innerWidth - w - 8, Math.max(8, rect.left + rect.width / 2 - w / 2));
    const above = rect.top - h - 8 >= 8;
    bar.classList.toggle('below', !above);
    bar.style.left = `${x}px`; bar.style.top = `${above ? rect.top - h - 8 : rect.bottom + 8}px`;
  }
  function update() {
    const s = getSelection();
    if (down || composing || paletteOpen() || document.body.classList.contains('touch') || !s.rangeCount) return hide();
    const r = s.getRangeAt(0);
    const node = r.commonAncestorContainer;
    const box = (node.nodeType === 1 ? node : node.parentElement)?.closest?.('#tree .text, #title');
    if (!box) return hide();
    if (!bar) build();
    if (!s.isCollapsed && s.toString().trim()) { // 글자를 골랐으면
      el = box; target = null;
      const o = selOffsets(el);
      render('sel', o ? hlState(el, o).color : null);
      return place(r.getBoundingClientRect());
    }
    if (s.isCollapsed && clicked) { // 칠한 곳을 눌렀으면: 그 형광펜의 색 바꾸기 · 지우기 (marks인 명령만)
      const hl = hlAround(box, caretOffset(box));
      if (hl) {
        el = box; target = hl;
        render('hl', hl.color);
        const sp = (r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement).closest('.md-hl');
        return place((sp ?? box).getBoundingClientRect());
      }
    }
    if (target && el === box) return; // 형광펜 메뉴를 띄운 채 커서만 조금 움직였으면 그대로
    hide();
  }
  let raf = 0;
  const later = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(update); };
  document.addEventListener('selectionchange', () => { if (!down) later(); });
  document.addEventListener('mousedown', (e) => { if (!bar?.contains(e.target)) { down = true; clicked = false; hide(); } }, true);
  document.addEventListener('mouseup', () => { if (down) { down = false; clicked = true; later(); } }, true);
  addEventListener('scroll', () => { if (bar && !bar.hidden) later(); }, { passive: true, capture: true });
  addEventListener('resize', later);
  document.addEventListener('keydown', (e) => {
    if (!isModKey(e)) clicked = false; // 키보드로 커서를 옮겨 형광펜 안에 들어간 건 '누른 것'이 아니에요
    if (e.key === 'Escape' && bar && !bar.hidden) hide();
  }, true);
  /** 플러그인이 다룰 글자 칸: 메뉴가 떠 있으면 그 칸, 아니면 글자를 고른 · 커서가 있는 칸 */
  const textEl = () => {
    if (el?.isConnected) return el;
    const s = getSelection(), n = s.rangeCount ? s.getRangeAt(0).commonAncestorContainer : null;
    const box = (n?.nodeType === 1 ? n : n?.parentElement)?.closest?.('#tree .text, #title');
    if (box) return box;
    const a = document.activeElement;
    return a?.matches?.('#tree .text, #title') ? a : null;
  };
  /** 형광펜 범위: 칠한 곳을 눌렀으면 그 범위, 아니면 고른 글자 */
  const hlTarget = (box) => (target && box === el ? target : (() => { const o = trimSel(box, selOffsets(box)); return o && hlState(box, o); })());
  return { update: later, hide, textEl, hlTarget, clearTarget: () => { target = null; drawn = ''; } };
})();

export { applyHeading, applyMd, blockBrowserFmt, fmtBar, headingOf, hlSet, mdWrapped, selOffsets };
