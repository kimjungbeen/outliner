// view.js — 코드만으로 화면을 짜는 작은 UI 라이브러리 (SwiftUI처럼). 의존성 없음: 이 폴더(view.js · view.css)만 있으면 어느 웹페이지에서나 써요.
//
//   import { mount, VStack, Text, Button } from './view/view.js';
//   mount(document.body, { n: 0 }, (s, set) =>
//     VStack(
//       Text(`눌렀어요 ${s.n}번`).font('title'),
//       Button('하나 더', () => set({ n: s.n + 1 })).style('primary'),
//     ).padding(24));
//
// 화면 = 상태를 받아 뷰를 돌려주는 함수(body). set(바뀐 값)을 부르면 body를 다시 그리고, 바뀐 곳만 고쳐요
// (입력 중인 칸 · 커서 · 재생 중인 소리 · 스크롤은 그대로). HTML · CSS는 쓰지 않아요 — 모양은 수식어(.font() · .padding() …)로.
// 테마: view.css의 --v-* 변수 (밝은/어두운 화면 자동). 페이지에서 :root { --v-accent: … } 로 바꿔요.

// ---- 뷰: 태그 · 클래스 · 속성 · 스타일 · 이벤트 · 자식 (가상 노드이자 수식어를 가진 값) ----
class View {
  constructor(tag, cls = '', children = []) {
    this.t = tag; this.c = cls ? [cls] : []; this.a = {}; this.s = {}; this.on = {}; this.p = {}; this.k = null;
    this.ch = flat(children);
  }
  // 모양
  padding(n = 16) { return this.css(typeof n === 'object' ? { paddingTop: px(n.top ?? n.y ?? 0), paddingBottom: px(n.bottom ?? n.y ?? 0), paddingLeft: px(n.left ?? n.x ?? 0), paddingRight: px(n.right ?? n.x ?? 0) } : { padding: px(n) }); }
  /** { width, height, minWidth, maxWidth, minHeight, maxHeight } — 숫자는 px, 글자는 그대로 ('100%' · '20rem') */
  frame(o = {}) { const s = {}; for (const [k, v] of Object.entries(o)) s[k] = px(v); return this.css(s); }
  grow(n = 1) { return this.css({ flex: `${n} 1 0`, minWidth: '0' }); }
  /** 세로로 남은 높이를 채워요 (창 · 화면 가득한 목록 · 달력) */
  fill() { return this.cls('v-fill'); }
  /** 'largeTitle' · 'title' · 'headline' · 'body' · 'callout' · 'caption' · 'mono' */
  font(f) { return this.cls(`v-font-${f}`); }
  bold(on = true) { return this.css({ fontWeight: on ? '600' : '400' }); }
  /** 'regular' · 'medium' · 'semibold' · 'bold' */
  weight(w) { return this.css({ fontWeight: { regular: '400', medium: '500', semibold: '600', bold: '700' }[w] || w }); }
  mono() { return this.cls('v-font-mono'); }
  /** 'ink' · 'mute' · 'accent' · 'link' · 'danger' · 'ok' · 'inverse' 또는 CSS 색 */
  color(c) { return this.css({ color: tone(c) }); }
  /** 'fill' · 'panel' · 'accent' · 'danger' 또는 CSS 색 */
  background(c) { return this.css({ background: tone(c) }); }
  radius(r = 'md') { return this.css({ borderRadius: typeof r === 'number' ? px(r) : `var(--v-r-${r})` }); }
  align(a) { return this.css({ textAlign: a, alignItems: { leading: 'flex-start', center: 'center', trailing: 'flex-end' }[a] || a }); }
  lines(n) { return this.cls('v-clip').css({ WebkitLineClamp: String(n) }); }
  wrap(on = true) { return this.css({ whiteSpace: on ? 'pre-wrap' : 'nowrap' }); }
  opacity(x) { return this.css({ opacity: String(x) }); }
  indent(level, step = 1.2) { return this.css({ paddingLeft: `${level * step}em` }); }
  scroll(maxHeight) { return this.cls('v-scroll').css(maxHeight != null ? { maxHeight: px(maxHeight) } : {}); }
  // 상태
  hidden(on = true) { if (on) this.a.hidden = ''; return this; }
  disabled(on = true) { if (on) this.p.disabled = true; return this; }
  selected(on = true) { return on ? this.cls('on') : this; }
  tooltip(t) { if (t) this.a.title = t; return this; }
  label(t) { if (t) this.a['aria-label'] = t; return this; }
  /** 새로 나타날 때 여기로 커서 (창을 열 때 · 단계가 바뀌어 새 단추가 생길 때) */
  autofocus(on = true) { if (on) this.a['data-autofocus'] = ''; return this; }
  /** 새로 나타날 때 커서를 두고 글을 골라 둬요 (바로 바꿔 쓰게) */
  autoselect(on = true) { if (on) { this.a['data-autofocus'] = ''; this.a['data-autoselect'] = ''; } return this; }
  /** 줄에 마우스를 올렸거나 고른 줄일 때만 보여요 (줄 끝 작은 단추 — 터치 화면에서는 늘) */
  revealOnHover() { return this.cls('v-reveal'); }
  /** on이 되는 순간 이 칸이 보이게 스크롤 (↑↓로 고른 줄) */
  scrollIntoView(on = true) { if (on) this.a['data-into-view'] = ''; return this; }
  /** 다시 그려도 같은 것으로 알아보는 이름 (목록 줄 등) */
  key(k) { this.k = k; return this; }
  // 이벤트
  onTap(fn) { return this.event('click', fn); }
  onHover(fn) { return this.event('mouseenter', () => fn(true)).event('mouseleave', () => fn(false)); }
  onContextMenu(fn) { return this.event('contextmenu', (e) => { e.preventDefault(); fn(e); }); }
  event(type, fn) { this.on[type] = fn; return this; }
  // 빠져나갈 구멍 — 속성 · 클래스 · 스타일 (테스트 · 다른 CSS와 이을 때)
  attr(k, v) { if (v != null && v !== false) this.a[k] = v === true ? '' : String(v); return this; }
  cls(c) { if (c) this.c.push(c); return this; }
  css(o) { Object.assign(this.s, o); return this; }
}
const flat = (list) => list.flat(Infinity).filter((x) => x != null && x !== false && x !== true).map((x) => (x instanceof View ? x : String(x)));
const px = (v) => (typeof v === 'number' ? `${v}px` : v);
const TONES = new Set(['ink', 'mute', 'accent', 'link', 'danger', 'ok', 'fill', 'panel', 'line', 'inverse', 'bg']);
const tone = (c) => (TONES.has(c) ? `var(--v-${c})` : c);
/** 첫 인자가 옵션이면 떼어 내요 — VStack({ gap: 8 }, a, b) · VStack(a, b) */
const opts = (args) => (args.length && args[0] && typeof args[0] === 'object' && !(args[0] instanceof View) && !Array.isArray(args[0]) ? [args[0], args.slice(1)] : [{}, args]);
const stack = (cls, args) => {
  const [o, kids] = opts(args);
  const v = new View('div', cls, kids);
  if (o.gap != null) v.css({ gap: px(o.gap) });
  if (o.align) v.cls(`v-align-${o.align}`);
  if (o.justify) v.css({ justifyContent: { leading: 'flex-start', center: 'center', trailing: 'flex-end', between: 'space-between' }[o.justify] || o.justify });
  if (o.wrap) v.css({ flexWrap: 'wrap' });
  return v;
};

// ---- 배치 ----
/** 세로로 쌓기. VStack({ gap, align: 'leading'|'center'|'trailing'|'stretch' }, ...뷰) */
export const VStack = (...a) => stack('v-vstack', a);
/** 가로로 늘어놓기. HStack({ gap, align: 'top'|'center'|'bottom'|'baseline', justify, wrap }, ...뷰) */
export const HStack = (...a) => stack('v-hstack', a);
/** 겹쳐 놓기 (뒤에 쓴 것이 위) */
export const ZStack = (...a) => stack('v-zstack', a);
/** 칸 나누기. Grid({ columns: 7 | '1fr 2fr', rows: 6 | 'auto repeat(6, 1fr)', gap, lines: 칸 사이에 줄 }, ...뷰) */
export const Grid = (...a) => {
  const [o, kids] = opts(a);
  const tpl = (x) => (typeof x === 'number' ? `repeat(${x}, minmax(0, 1fr))` : x);
  const v = new View('div', o.lines ? 'v-grid v-gridlines' : 'v-grid', kids).css({ gridTemplateColumns: tpl(o.columns) || '1fr', gap: px(o.gap ?? (o.lines ? 1 : 8)) });
  if (o.rows) v.css({ gridTemplateRows: tpl(o.rows) });
  return v;
};
/** 남은 자리를 채우는 빈칸 */
export const Spacer = () => new View('div', 'v-spacer');
export const Divider = () => new View('hr', 'v-divider');
/** 묶음 — 제목이 있는 구역 */
export const Section = (title, ...kids) => new View('section', 'v-section', [title ? new View('div', 'v-section-title', [title]) : null, ...kids]);
/** 목록. List(items, (item, i) => 뷰, { empty: '비었을 때 글', selected: (item) => bool, onTap: (item) => … }) */
export const List = (items, row, o = {}) => {
  if (!items.length) return new View('div', 'v-list v-empty', [o.empty ?? '']);
  return new View('div', 'v-list', items.map((it, i) => {
    const r = row(it, i);
    const v = r instanceof View && r.c.includes('v-row') ? r : new View('div', 'v-row', [r]);
    if (o.selected?.(it)) v.cls('on');
    if (o.onTap) v.onTap(() => o.onTap(it, i)).cls('v-tappable');
    return v.key(o.key ? o.key(it, i) : i);
  }));
};
/** 같은 것을 여러 개 (배열을 펼쳐요) */
export const ForEach = (items, fn) => items.map(fn);
/** 펼치고 접는 칸 */
export const Disclosure = (label, ...kids) => new View('details', 'v-disclosure', [new View('summary', '', [label]), ...kids]);

// ---- 글 ----
export const Text = (s) => new View('span', 'v-text', [s ?? '']);
/** 꾸민 글: 글자 그대로에 **굵게** · `코드` · 줄바꿈만 */
export const Rich = (s) => {
  const out = [];
  String(s ?? '').split('\n').forEach((line, i) => {
    if (i) out.push(new View('br'));
    for (const part of line.split(/(\*\*.+?\*\*|`[^`]+`)/)) {
      if (!part) continue;
      if (part.startsWith('**') && part.endsWith('**') && part.length > 4) out.push(new View('b', '', [part.slice(2, -2)]));
      else if (part.startsWith('`') && part.endsWith('`') && part.length > 2) out.push(new View('code', '', [part.slice(1, -1)]));
      else out.push(part);
    }
  });
  return new View('span', 'v-text', out);
};
/** 형광펜 칠한 글: ['앞', { hit: '찾은 글' }, '뒤'] */
export const Marked = (parts) => new View('span', 'v-text', parts.map((x) => (typeof x === 'object' && x ? new View('mark', '', [x.hit]) : String(x ?? ''))));
/** 이름 · 값 한 줄 (설정 · 통계) */
export const LabeledValue = (label, value) => new View('div', 'v-lv', [new View('span', 'v-lv-l', [label]), new View('span', 'v-lv-v', [value])]);
/** 누를 수 있는 작은 칸 (달력의 항목 · 태그 등). 넘치면 … */
export const Chip = (label, action) => { const v = new View('button', 'v-chip', [label]); v.a.type = 'button'; v.a.title = typeof label === 'string' ? label : ''; return action ? v.onTap(action) : v; };
/** 작은 꼬리표 */
export const Badge = (s) => new View('span', 'v-badge', [s]);

// ---- 누르기 · 입력 ----
/** 단추. .style('primary' | 'ghost' | 'plain' | 'danger' | 'pill' | 'tab') .size('sm') */
export const Button = (label, action) => {
  const v = new View('button', 'v-btn', [label]);
  v.a.type = 'button';
  if (action) v.onTap(action);
  v.style = (st) => v.cls(`v-${st}`);
  v.size = (sz) => v.cls(`v-${sz}`);
  return v;
};
/** 그림 단추 (svg 글 또는 Icon 이름) */
export const IconButton = (icon, action, label = '', o = {}) => Button(Icon(icon, o), action).cls('v-iconbtn').label(label).tooltip(label);
/** 여럿 중 하나 고르기 (나란히). options: [[값, 이름, { disabled, title }?]] */
export const Segmented = (options, value, onChange) => new View('div', 'v-seg', options.map(([v, l, o = {}]) => {
  const b = new View('button', v === value ? 'on' : '', [l]); b.a.type = 'button'; b.a['data-v'] = String(v);
  if (o.disabled) b.p.disabled = true; if (o.title) b.a.title = o.title;
  return b.onTap(() => { if (v !== value) onChange(v); });
}));
/** 글 칸. TextField(값, (새 값) => …, { placeholder, mono, multiline, number, min, max, step, onSubmit, rows, invalid }) */
export const TextField = (value, onChange, o = {}) => {
  const v = new View(o.multiline ? 'textarea' : 'input', o.multiline ? 'v-field v-area' : 'v-field');
  if (!o.multiline) v.a.type = o.number ? 'number' : o.type || 'text';
  if (o.number) for (const k of ['min', 'max', 'step']) if (o[k] != null) v.a[k] = String(o[k]);
  if (o.rows) v.a.rows = String(o.rows);
  if (o.placeholder) v.a.placeholder = o.placeholder;
  v.a.spellcheck = 'false';
  if (o.mono) v.cls('v-font-mono');
  if (o.invalid) v.cls('v-invalid');
  v.p.value = value == null ? '' : String(value);
  v.on.input = (e) => onChange?.(o.number ? (e.target.value === '' ? null : +e.target.value) : e.target.value);
  if (o.onSubmit && !o.multiline) v.on.keydown = (e) => { if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); o.onSubmit(); } };
  return v;
};
/** 켜고 끄기 */
export const Toggle = (label, value, onChange) => {
  const box = new View('input'); box.a.type = 'checkbox'; box.p.checked = !!value;
  box.on.change = (e) => onChange(e.target.checked);
  const v = new View('label', 'v-toggle', [box, new View('span', '', [label])]);
  v.on.mousedown = (e) => e.preventDefault(); // 눌러도 입력 칸의 커서를 뺏지 않게 (켜고 바로 이어서 쳐요)
  v.on.click = (e) => { const c = e.currentTarget.firstChild; if (e.target !== c) { e.preventDefault(); c.click(); } }; // 라벨을 누르면 브라우저가 체크칸으로 커서를 옮겨서 — 코드로 누르면 커서는 그대로
  return v;
};
/** 고르기 목록 (드롭다운). options: [[값, 이름]] */
export const Picker = (options, value, onChange) => {
  const v = new View('select', 'v-field v-picker', options.map(([x, l]) => { const o = new View('option', '', [l]); o.a.value = String(x); return o; }));
  v.p.value = String(value);
  v.on.change = (e) => onChange(options.find(([x]) => String(x) === e.target.value)?.[0] ?? e.target.value);
  return v;
};
/** 체크 칸 (글 없이 — 목록 줄 맨 앞 등) */
export const Checkbox = (value, onChange, label = '') => {
  const box = new View('input', 'v-check'); box.a.type = 'checkbox'; box.p.checked = !!value;
  if (label) { box.a.title = label; box.a['aria-label'] = label; }
  box.on.change = (e) => onChange(e.target.checked);
  box.on.click = (e) => e.stopPropagation(); // 줄을 누르는 동작과 겹치지 않게
  return box;
};
/** 링크 (새 탭) */
export const Link = (label, href, { newTab = true } = {}) => { const v = new View('a', 'v-link', [label]); v.a.href = href; if (newTab) { v.a.target = '_blank'; v.a.rel = 'noopener'; } return v; };
/** 색 고르기 (#rrggbb) — 무지개 점, 누르면 브라우저의 색 고르기 */
export const ColorWell = (value, onChange, label = '다른 색 고르기') => {
  const i = new View('input'); i.a.type = 'color'; i.p.value = value || '#000000';
  i.on.change = (e) => onChange(e.target.value);
  return new View('label', 'v-btn v-swatch v-colorwell', [new View('span', 'v-dot'), i]).tooltip(label).label(label);
};
/** 색 점 (누를 수 있어요). current면 테두리 */
export const Swatch = (color, action, { current = false, label = '' } = {}) =>
  Button(new View('span', 'v-dot').css({ background: color }), action).cls('v-swatch').selected(current).label(label).tooltip(label);

// ---- 그림 · 소리 · 기타 ----
export const Image = (src, alt = '') => { const v = new View('img', 'v-img'); v.a.src = src; v.a.alt = alt; v.a.loading = 'lazy'; return v; };
/** 소리 (재생 막대). 다시 그려도 재생은 그대로 */
export const Audio = (src) => { const v = new View('audio', 'v-audio'); v.a.controls = ''; if (src) v.a.src = src; return v; };
/** 막대 (0~1) */
export const Meter = (x) => new View('div', 'v-meter', [new View('i').css({ width: `${Math.max(0, Math.min(1, x)) * 100}%` })]);
/** 상태 점 (색 · pulse: 깜빡임) — 녹음 중 같은 표시 */
export const Dot = (color = 'danger', { pulse = false } = {}) => new View('span', pulse ? 'v-sdot v-pulse' : 'v-sdot').css({ background: tone(color) });
/** 도는 표시 */
export const Spinner = () => new View('span', 'v-spinner');
const ICONS = {
  close: '<path d="M5 5l10 10M15 5L5 15"/>',
  prev: '<path d="M12.5 4.5L7 10l5.5 5.5"/>',
  next: '<path d="M7.5 4.5L13 10l-5.5 5.5"/>',
  up: '<path d="M4.5 12.5L10 7l5.5 5.5"/>',
  down: '<path d="M4.5 7.5L10 13l5.5-5.5"/>',
  check: '<path d="M4.5 10.5l3.5 3.5 7.5-8"/>',
  plus: '<path d="M10 4v12M4 10h12"/>',
  trash: '<path d="M4 6h12M8.2 6V4.6c0-.6.4-1 1-1h1.6c.6 0 1 .4 1 1V6M5.6 6l.7 9.3c.1 1 .9 1.7 1.9 1.7h3.6c1 0 1.8-.7 1.9-1.7L14.4 6"/>',
  link: '<path d="M8.5 11.5l3-3M9 6.5l1.3-1.3a3 3 0 014.2 4.2L13.2 10.7M11 13.5l-1.3 1.3a3 3 0 01-4.2-4.2L6.8 9.3"/>',
  search: '<circle cx="9" cy="9" r="5"/><path d="M13 13l3.5 3.5"/>',
  folder: '<path d="M3 6.5V15a1 1 0 001 1h12a1 1 0 001-1V8a1 1 0 00-1-1h-6L8.5 5H4a1 1 0 00-1 1.5z"/>',
  play: '<path d="M7 5l8 5-8 5z"/>',
  pause: '<path d="M7 5v10M13 5v10"/>',
  mic: '<rect x="7.5" y="3" width="5" height="9" rx="2.5"/><path d="M5 10a5 5 0 0010 0M10 15v2.5"/>',
  bookmark: '<path d="M6 3.5h8v13l-4-3.2-4 3.2z"/>',
  star: '<path d="M10 3l2.1 4.5 4.9.6-3.6 3.4.9 4.9L10 14l-4.3 2.4.9-4.9L3 8.1l4.9-.6z"/>',
};
/** 선 그림. 이름(close · prev · next · up · down · check · plus · trash · link · search · folder · play · pause · mic · bookmark · star) 또는 '<svg …>' 글 (믿을 수 있는 곳에서 온 것만)
 *  { filled: 안을 채우기 (북마크한 것 등), size } */
export const Icon = (name, { filled = false, size = 16 } = {}) => {
  const v = new View('span', 'v-icon');
  v.p.innerHTML = name.startsWith('<svg') ? name : `<svg viewBox="0 0 20 20" width="${size}" height="${size}" fill="${filled ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
  return v;
};
/** 다른 코드가 그리는 칸 (지도 · 미리 보기 틀 등): make() → Node 처음 한 번, update(node) 다시 그릴 때마다 */
export const Embed = (make, update = null) => { const v = new View('div', 'v-embed'); v.p.embed = { make, update }; return v; };
/** 아무 태그나 (드물게) */
export const Element = (tag, ...kids) => new View(tag, '', kids);

// ---- 미리 보기 줄 (바뀌는 모습) ----
/** Lines([줄]) — 줄: '글' | { text(글 · 조각 배열), depth, changed, muted, after, err, num, mark } (빈 글은 '(빈 항목)') */
export const Lines = (rows, { empty = '' } = {}) => new View('div', 'v-lines', rows.length ? rows.map(lineOf) : [new View('div', 'v-mute', [empty])]);
function lineOf(r) {
  const o = typeof r === 'string' ? { text: r } : r;
  const v = new View('div', o.err ? 'v-err' : o.after ? 'v-after' : o.muted ? 'v-mute' : o.changed ? 'v-changed' : '');
  if (o.depth) v.indent(o.depth);
  if (o.num != null) v.ch.push(new View('span', 'v-num', [String(o.num)]));
  if (o.mark) v.ch.push(new View('span', 'v-mute', [o.mark]), ' ');
  if (Array.isArray(o.text)) v.ch.push(Marked(o.text));
  else { const t = String(o.text ?? ''); v.ch.push(t || o.err || o.muted ? t : new View('span', 'v-mute', ['(빈 항목)'])); }
  return v;
}

// ---- 그리기: 가상 노드 → DOM (바뀐 곳만) ----
const SVG_NS = 'http://www.w3.org/2000/svg';
function create(v) {
  if (typeof v === 'string') return document.createTextNode(v);
  const el = document.createElement(v.t);
  el.__on = {};
  update(el, { a: {}, s: {}, p: {}, on: {}, c: [] }, v);
  for (const c of v.ch) el.append(create(c));
  if (v.t === 'select' && 'value' in v.p) el.value = v.p.value; // 고르기 목록은 칸이 생긴 뒤에
  if (v.p.embed) { const n = v.p.embed.make(); el.append(n); v.p.embed.update?.(n); }
  if ('data-autofocus' in v.a) requestAnimationFrame(() => { // 그사이 닫힌 창(멈춘 화면)이면 커서를 가져가지 않아요
    if (el.isConnected && !el.closest('[data-v-stopped]')) { el.focus(); if ('data-autoselect' in v.a) el.select?.(); }
  });
  return el;
}
function update(el, o, v) {
  const cls = v.c.join(' ');
  if (o.c.join(' ') !== cls) el.className = cls;
  if ('data-into-view' in v.a && !('data-into-view' in o.a)) requestAnimationFrame(() => el.isConnected && el.scrollIntoView({ block: 'nearest' }));
  for (const k of Object.keys(o.a)) if (!(k in v.a)) el.removeAttribute(k);
  for (const [k, x] of Object.entries(v.a)) if (o.a[k] !== x || el.getAttribute(k) !== x) el.setAttribute(k, x);
  for (const k of Object.keys(o.s)) if (!(k in v.s)) el.style[k] = '';
  for (const [k, x] of Object.entries(v.s)) if (el.style[k] !== x) el.style[k] = x;
  // value · checked는 지금 DOM 값과 비교 (입력 중인 칸은 같으면 건드리지 않아 커서가 그대로)
  if ('value' in v.p && el.value !== v.p.value) el.value = v.p.value;
  if ('checked' in v.p && el.checked !== v.p.checked) el.checked = v.p.checked;
  if (!!o.p.disabled !== !!v.p.disabled || el.disabled !== !!v.p.disabled) { if ('disabled' in el) el.disabled = !!v.p.disabled; }
  if ('innerHTML' in v.p && o.p.innerHTML !== v.p.innerHTML) el.innerHTML = v.p.innerHTML;
  for (const type of new Set([...Object.keys(o.on), ...Object.keys(v.on)])) {
    if (!el.__on[type] && v.on[type]) el.addEventListener(type, (e) => el.__on[type]?.(e));
    el.__on[type] = v.on[type] || null;
  }
}
function patch(parent, olds, news) {
  const nodes = [...parent.childNodes];
  for (let i = 0; i < news.length; i++) {
    const n = news[i], o = olds[i], el = nodes[i];
    if (o === undefined || !el) { parent.append(create(n)); continue; }
    if (typeof n === 'string' || typeof o === 'string') {
      if (typeof n === 'string' && typeof o === 'string' && el.nodeType === 3) { if (o !== n) el.nodeValue = n; continue; }
      parent.replaceChild(create(n), el); continue;
    }
    if (o.t !== n.t || o.k !== n.k || ('innerHTML' in o.p) !== ('innerHTML' in n.p) || !!o.p.embed !== !!n.p.embed) { parent.replaceChild(create(n), el); continue; }
    update(el, o, n);
    if (n.p.embed) n.p.embed.update?.(el.firstChild);
    else if (!('innerHTML' in n.p)) patch(el, o.ch, n.ch);
  }
  for (let i = nodes.length - 1; i >= news.length; i--) nodes[i]?.remove();
}

let styled = false;
/** view.css를 한 번 붙여요 (이 파일 옆). 이미 페이지에 있으면(link[data-view-css]) 그대로 */
export function useStyles(href = new URL('./view.css', import.meta.url).href) {
  if (styled || document.querySelector('link[data-view-css]')) { styled = true; return; }
  const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = href; l.dataset.viewCss = '';
  document.head.append(l); styled = true;
}

/** 화면 붙이기: mount(놓을 곳, 처음 상태, (상태, set, ctx) => 뷰) → { state, set, render, unmount }
 *  set({ 바뀐 값 }) 또는 set((s) => ({ … })) — 다음 틈에 한 번만 다시 그려요 */
export function mount(target, state, body, ctx = {}) { // ctx.task(상태, set): 붙인 뒤 한 번 (불러오기 등 — SwiftUI의 .task)
  useStyles();
  const host = document.createElement('div'); host.className = 'v-root';
  target.append(host);
  let tree = [], queued = false, alive = true;
  const s = { ...state };
  const set = (patchOrFn) => {
    Object.assign(s, typeof patchOrFn === 'function' ? patchOrFn(s) : patchOrFn);
    if (!queued) { queued = true; queueMicrotask(render); }
  };
  function render() {
    queued = false;
    if (!alive) return;
    const next = flat([body(s, set, ctx)]);
    patch(host, tree, next);
    tree = next;
  }
  render();
  if (ctx.task) queueMicrotask(() => alive && ctx.task(s, set));
  return {
    state: s, set, render, host,
    /** 멈추기: 더는 다시 그리지 않고 커서도 가져가지 않아요 (닫히는 창이 사라지는 동안) */
    stop() { alive = false; host.dataset.vStopped = ''; },
    unmount() { alive = false; host.remove(); },
  };
}

// ---- 창 (모달 시트) · 알림 ----
/** 창: sheet({ title, state, body: (상태, set, close) => 뷰, task: (상태, set, close) => 처음 한 번, size: 'auto'|'wide'|'full', dismissable }) → close(값)으로 닫은 값 (Esc · 바깥 = null) */
export function sheet({ title = '', state = {}, body, task = null, size = 'auto', dismissable = true, onKey = null } = {}) {
  useStyles();
  return new Promise((resolve) => {
    const back = document.createElement('div'); back.className = 'v-backdrop';
    const box = document.createElement('div'); box.className = `v-sheet v-${size}`; box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true');
    if (title) { const h = document.createElement('h3'); h.className = 'v-sheet-title'; h.textContent = title; box.append(h); box.setAttribute('aria-label', title); }
    back.append(box); document.body.append(back);
    const before = document.activeElement;
    let done = false;
    const close = (v = null) => {
      if (done) return; done = true;
      m.stop();
      document.removeEventListener('keydown', key, true);
      back.classList.add('v-out');
      setTimeout(() => { m.unmount(); back.remove(); before?.focus?.(); }, 160);
      resolve(v);
    };
    const key = (e) => {
      if (onKey?.(e, m.state, m.set, close)) return;
      if (e.key === 'Escape' && dismissable) { e.preventDefault(); e.stopPropagation(); close(null); }
    };
    document.addEventListener('keydown', key, true);
    if (dismissable) back.addEventListener('mousedown', (e) => { if (e.target === back) close(null); });
    const m = mount(box, state, (s, set) => body(s, set, close), { task: task && ((s, set) => task(s, set, close)) });
    requestAnimationFrame(() => (box.querySelector('[data-autofocus]') || box.querySelector('input, textarea, button.v-primary, button'))?.focus());
  });
}
/** 아래 단추 줄 (오른쪽 정렬) */
export const Actions = (...kids) => HStack({ gap: 8, justify: 'trailing', wrap: true }, ...kids).cls('v-actions');

/** 아래쪽 알림 sec초 */
export function toast(msg, sec = 2, { error = false } = {}) {
  useStyles();
  let t = document.querySelector('.v-toast');
  if (!t) { t = document.createElement('div'); t.className = 'v-toast'; t.setAttribute('role', 'status'); document.body.append(t); }
  t.textContent = msg; t.classList.toggle('v-error', error); t.classList.add('v-show');
  clearTimeout(t.__h); t.__h = setTimeout(() => t.classList.remove('v-show'), sec * 1000);
}

/** 뷰 하나를 DOM으로 (다른 틀 안에 끼울 때 — 다시 그리기는 없어요) */
export const build = (v) => create(v instanceof View ? v : String(v));

export { View };
