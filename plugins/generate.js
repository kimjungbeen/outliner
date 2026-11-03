// 패턴 · 수식으로 항목 대량 만들기 (gen)
//   범위 · 수식: 틀 한 줄이 {1..12} · {a,b,c} · {2026-01-01..2026-01-31} 마다 여러 줄로 늘어나요. 들여 쓴 줄은 하위 항목으로 (줄마다 반복)
//   정규식 추출: 붙여 넣은 글에서 정규식에 맞는 곳마다 틀대로 항목을 만들어요 ($1 · $2 · $& · $<이름>)
//   {=식}: 자바스크립트 식 — n(1부터) · i(0부터) · N(이 줄 개수) · $1 $2(이 줄의 범위 값) · up(위 줄의 값들) · m(정규식 추출의 일치)
import { compile } from './_expr.js';
import { command } from './_kit.js';

const MAX_ITEMS = 5000;
const MAX_GEN = 10000;
const DEC = (s) => (String(s).split('.')[1] || '').length;

/** {…} 안의 글 → 값 목록 (범위 · 목록이 아니면 null = 글자 그대로) */
function genValues(body) {
  let m;
  if ((m = body.match(/^(\d{4}-\d{1,2}-\d{1,2})\.\.(\d{4}-\d{1,2}-\d{1,2})(?:\.\.(-?\d+))?$/))) { // 날짜 범위 (·· 며칠씩)
    const [a, b] = [m[1], m[2]].map((s) => { const [y, mo, d] = s.split('-').map(Number); return new Date(y, mo - 1, d); });
    const step = Math.abs(+(m[3] || 1)) || 1, dir = a <= b ? 1 : -1, out = [];
    for (const d = new Date(a); dir > 0 ? d <= b : d >= b; d.setDate(d.getDate() + step * dir)) {
      out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
      if (out.length > MAX_GEN) throw new Error(`{${body}}: 값이 너무 많아요`);
    }
    return out;
  }
  if ((m = body.match(/^(-?\d+(?:\.\d+)?)\.\.(-?\d+(?:\.\d+)?)(?:\.\.(-?\d+(?:\.\d+)?))?$/))) { // 숫자 범위 · 01처럼 쓰면 자릿수 맞춤
    const a = +m[1], b = +m[2], step = Math.abs(+(m[3] || 1)) || 1, dir = a <= b ? 1 : -1;
    const dec = Math.max(DEC(m[1]), DEC(m[2]), DEC(m[3] || '')), width = /^-?0\d/.test(m[1]) || /^-?0\d/.test(m[2]) ? Math.max(m[1].length, m[2].length) : 0;
    const out = [];
    for (let k = 0; ; k++) {
      const v = +(a + dir * step * k).toFixed(dec);
      if (dir > 0 ? v > b + 1e-9 : v < b - 1e-9) break;
      const s = dec ? v.toFixed(dec) : String(v);
      out.push(width ? (v < 0 ? '-' + s.slice(1).padStart(width - 1, '0') : s.padStart(width, '0')) : s);
      if (out.length > MAX_GEN) throw new Error(`{${body}}: 값이 너무 많아요`);
    }
    return out;
  }
  if ((m = body.match(/^([a-zA-Z])\.\.([a-zA-Z])$/))) { // 글자 범위 a..e
    const a = m[1].charCodeAt(0), b = m[2].charCodeAt(0), dir = a <= b ? 1 : -1, out = [];
    for (let c = a; dir > 0 ? c <= b : c >= b; c += dir) out.push(String.fromCharCode(c));
    return out;
  }
  if (body.includes(',')) return body.split(',').map((s) => s.trim()); // 목록 a,b,c
  return null;
}

/** 틀 한 줄 → 조각들: 글자 · 범위(값 목록) · 식 */
function parseLine(s) {
  const parts = [];
  let lit = '';
  for (let k = 0; k < s.length; k++) {
    if (s[k] === '\\' && (s[k + 1] === '{' || s[k + 1] === '}')) { lit += s[++k]; continue; } // \{ \} = 글자 그대로
    if (s[k] !== '{') { lit += s[k]; continue; }
    let depth = 0, e = k; // 짝이 맞는 }까지 (식 안의 {} 허용)
    for (; e < s.length; e++) { if (s[e] === '{') depth++; else if (s[e] === '}' && --depth === 0) break; }
    if (e >= s.length) { lit += s.slice(k); break; }
    const body = s.slice(k + 1, e);
    if (body.startsWith('=')) { if (lit) parts.push({ lit }); lit = ''; parts.push({ expr: body.slice(1).trim(), fn: compile(body.slice(1).trim()) }); }
    else {
      const vals = genValues(body);
      if (vals) { if (lit) parts.push({ lit }); lit = ''; parts.push({ vals }); } else lit += `{${body}}`;
    }
    k = e;
  }
  if (lit) parts.push({ lit });
  return parts;
}

/** 여러 줄 틀 → [{parts, kids}] (들여쓰기 = 하위: 탭 하나 또는 가장 작은 공백 폭이 한 단계) */
function parseTemplate(text) {
  const lines = text.split('\n').filter((l) => l.trim());
  const sp = lines.map((l) => l.match(/^[ \t]*/)[0]);
  const unit = Math.min(...sp.map((x) => x.replace(/\t/g, '').length).filter((n) => n > 0), Infinity);
  const roots = [], stack = [];
  lines.forEach((l, k) => {
    const tabs = (sp[k].match(/\t/g) || []).length, spaces = sp[k].length - tabs;
    let d = tabs + (unit === Infinity ? 0 : Math.round(spaces / unit));
    d = Math.min(d, stack.length); // 단계를 건너뛰지 않아요
    stack.length = d;
    const node = { parts: parseLine(l.trim()), kids: [] };
    (d ? stack[d - 1].kids : roots).push(node);
    stack.push(node);
  });
  return roots;
}

/** 틀 나무를 펼쳐 [{depth, text}]로 */
function expand(list, up, depth, out) {
  for (const node of list) {
    const gens = node.parts.filter((p) => p.vals);
    const N = gens.reduce((a, g) => a * g.vals.length, 1);
    if (out.length + N > MAX_ITEMS) throw new Error(`한 번에 ${MAX_ITEMS}개까지 만들 수 있어요`);
    for (let i = 0; i < N; i++) {
      const vals = [];
      for (let r = i, k = gens.length - 1; k >= 0; k--) { vals[k] = gens[k].vals[r % gens[k].vals.length]; r = Math.floor(r / gens[k].vals.length); } // 앞쪽 범위가 천천히 바뀌어요
      const ctx = { ...(up?.m ? { m: up.m } : {}), up, n: i + 1, i, N, $: vals, depth: depth + 1 };
      vals.forEach((v, k) => { ctx[`$${k + 1}`] = /^-?\d+(\.\d+)?$/.test(v) && !/^-?0\d/.test(v) ? +v : v; });
      let g = 0, text = '';
      for (const p of node.parts) {
        if (p.lit != null) text += p.lit;
        else if (p.vals) text += vals[g++];
        else { try { const v = p.fn(ctx); text += v == null ? '' : v; } catch (e) { throw new Error(`{=${p.expr}}: ${e.message}`); } }
      }
      out.push({ depth, text });
      expand(node.kids, ctx, depth + 1, out);
    }
  }
}

/** 정규식 추출: 틀 글자 속 $&, $1, $<이름>을 일치한 글로 (식 {=…} 안은 그대로 두고 m으로 써요) */
function fillMatch(tpl, m) {
  return tpl.replace(/\{=(?:[^{}]|\{[^{}]*\})*\}|\$(?:&|<([^>]+)>|(\d{1,2}))/g, (t, name, num) => {
    if (t.startsWith('{=')) return t;
    if (t === '$&') return m[0];
    if (name) return m.groups?.[name] ?? '';
    return m[+num] ?? '';
  });
}

export function build(mode, { tpl, src, rx, icase }) {
  const out = [];
  if (mode === 'range') { expand(parseTemplate(tpl), null, 0, out); return out; }
  const re = new RegExp(rx, icase ? 'gmi' : 'gm');
  let k = 0;
  for (const m of src.matchAll(re)) {
    if (!m[0].length) { if (++k > MAX_ITEMS) break; continue; }
    expand(parseTemplate(fillMatch(tpl, m)), { m, n: ++k }, 0, out);
    if (out.length > MAX_ITEMS) throw new Error(`한 번에 ${MAX_ITEMS}개까지 만들 수 있어요`);
  }
  return out;
}

const HELP_RANGE = `**{1..10}** 숫자 · **{01..10}** 자릿수 맞춤 · **{0..100..5}** 5씩 · **{a..e}** 글자 · **{봄,여름,가을}** 목록 · **{2026-01-01..2026-01-31}** 날짜 (한 줄에 여럿이면 모든 조합)
**{=식}** n(1부터) · i(0부터) · N(개수) · $1 $2(이 줄의 범위 값) · up.$1(윗줄 값) · pad(n,3) · date($1, 7, 'M/D (ddd)') · weekday($1) · floor · max …
들여 쓴 줄은 하위 항목이에요 (윗줄 하나마다 반복) · 글자 { } 는 \\{ \\}`;
const HELP_RX = `글에서 정규식에 맞는 곳마다 아래 틀로 항목을 만들어요 (^ $는 줄마다) · 틀에서 **$&** 찾은 글 · **$1** **$2** 괄호 · **$<이름>**
**{=식}** 안에서는 m[1] · m.groups.이름 · n(몇 번째) · 범위 {1..3} · 들여쓰기도 그대로 써요`;

function make(api, ui, t) {
  return {
    async generate(picked) { // 예전 gen — 고른 글자가 있으면 틀에 미리 넣어요 (예: '{1..12}월'을 골라 부르면 바로)
      const cur = api.view.cursorId() != null ? api.nodes.get(api.view.cursorId()) : null;
      const TPL0 = { range: '{1..12}월\n  {1..4}주차', regex: '$1 — $2' };
      let items = [];
      const o = await ui.form({
        title: '패턴 · 수식으로 항목 만들기', submit: '만들기', focus: 'tpl', enter: false,
        values: { mode: 'range', src: cur?.content || '', rx: '', i: false, tpl: typeof picked === 'string' && picked.trim() ? picked : TPL0.range, where: cur ? 'cursor' : 'screen' },
        fields: [
          { key: 'mode', type: 'seg', options: [['range', '범위 · 수식'], ['regex', '정규식 추출']] },
          { key: 'src', label: '원본 글', type: 'area', placeholder: '여기에 글을 붙여 넣으세요', show: (v) => v.mode === 'regex' },
          { key: 'rx', label: '정규식', type: 'text', mono: true, placeholder: '예: ^(\\d+)\\.\\s*(.+)$', show: (v) => v.mode === 'regex' },
          { key: 'i', type: 'check', label: '대소문자 무시', inline: true, show: (v) => v.mode === 'regex' },
          { key: 'tpl', type: 'area', label: (v) => (v.mode === 'regex' ? '만들 항목의 틀' : '틀 (한 줄 = 항목, 들여 쓰면 하위)') },
          { type: 'help', label: (v) => (v.mode === 'regex' ? '틀 쓰는 법' : '범위 · 수식 쓰는 법'), text: (v) => (v.mode === 'regex' ? HELP_RX : HELP_RANGE) },
          { key: 'where', label: '넣을 곳', type: 'seg', options: [['screen', '지금 화면 맨 아래'], ['cursor', '커서 항목의 하위로', cur ? {} : { disabled: true }]] },
        ],
        change: (key, v, prev) => (key === 'mode' && (v.tpl === TPL0[prev] || !v.tpl) ? { tpl: TPL0[v.mode] } : null),
        history: {
          key: 'gen',
          show: (v) => `${v.mode === 'regex' ? `정규식 ${v.rx} → ` : ''}${v.tpl.replace(/\n/g, ' ⏎ ')}`,
          pick: (v) => ({ mode: v.mode, tpl: v.tpl, rx: v.rx || '', i: !!v.i }),
          save: (v) => ({ mode: v.mode, tpl: v.tpl, rx: v.rx, i: v.i }),
        },
        preview: (v) => {
          items = [];
          if (v.mode === 'regex' && !v.rx) throw new Error('정규식을 넣으세요');
          items = build(v.mode, { tpl: v.tpl, src: v.src, rx: v.rx, icase: v.i });
          return {
            ok: items.length > 0, note: `${items.length}개`, submit: items.length ? `${items.length}개 만들기` : '만들기',
            rows: [...items.slice(0, 60).map((x) => ({ depth: x.depth, mark: '•', text: x.text })), ...(items.length > 60 ? [{ muted: true, text: `… 외 ${items.length - 60}개` }] : [])],
          };
        },
      });
      if (!o || !items.length) return;
      const where = o.where;
      const parent = where === 'cursor' && cur ? cur.id : api.view.zoomId();
      await api.nodes.importItems(parent, null, items);
      if (where === 'cursor' && cur?.collapsed) await api.nodes.bulk([{ id: cur.id, collapsed: 0 }]);
      await api.view.refresh();
      ui.toast(`${items.length}개 항목을 만들었어요`, 2.5);
    },
  };
}

export default (api) => command(api, { name: 'generate', label: '항목 대량 만들기 (패턴 · 수식)', preload: false, make });
