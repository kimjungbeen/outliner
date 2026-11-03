// 순서 바꾸기 (ord) — 정렬(식으로 기준) · 뒤집기 · 섞기 · 엇갈리기 · 돌리기를 한 창에서 (예전 so · rn · il을 합쳤어요)
//   대상: 화면 바로 아래 · 고른 항목들(자기 자리끼리만) · 모든 단계(항목마다 그 하위끼리)
import { compile } from './_expr.js';
import { command } from './_kit.js';

const METHODS = [['sort', '정렬'], ['reverse', '뒤집기'], ['shuffle', '섞기'], ['interleave', '엇갈리기'], ['rotate', '돌리기']];
const KEYS = [['글자', 'text'], ['첫 숫자', 'num'], ['날짜', "m(/\\d{4}-\\d{2}-\\d{2}/)"], ['하위 개수', 'kids'], ['첫 태그', 'tags[0]'], ['글 길이', 'text.length'], ['완료 [x] 뒤로', "/^\\[x\\]/i.test(text)"]];
const MAX = 5000;
const HELP = `**text** 글 · **idx** 지금 순서 · **kids** 하위 개수 · **tags** 태그 · **num** 첫 숫자 · **m(/정규식/)** 첫 괄호 · **has('글')** · 배열을 돌려주면 앞 값부터 차례로 비교해요 (예: **[tags[0], num]**)`;
const coll = new Intl.Collator('ko', { numeric: true, sensitivity: 'base' });

/** 정렬 비교: 빈 값은 맨 뒤 · 숫자끼리는 크기 · 글자는 자연 순서(2 < 10) · 배열은 앞부터 */
function cmp(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) {
    const x = [].concat(a), y = [].concat(b);
    for (let k = 0; k < Math.max(x.length, y.length); k++) { const c = cmp(x[k], y[k]); if (c) return c; }
    return 0;
  }
  const na = a == null || a === '' || Number.isNaN(a), nb = b == null || b === '' || Number.isNaN(b);
  if (na || nb) return na === nb ? 0 : na ? 1 : -1;
  if (typeof a === 'boolean' || typeof b === 'boolean') return Number(a) - Number(b);
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return coll.compare(String(a), String(b));
}
function shuffle(list, rnd = Math.random) {
  const out = [...list];
  for (let k = out.length - 1; k > 0; k--) { const j = Math.floor(rnd() * (k + 1)); [out[k], out[j]] = [out[j], out[k]]; }
  return out;
}

function make(api, ui, t) {
  const { kids, root, label, tagsOf } = t;

  /** 순서를 바꿀 묶음들: [{parent, slots: 바꿀 자리의 번호, items: 그 자리의 항목}] */
  function groups(target) {
    if (target === 'sel') {
      const sel = new Set(api.view.selection()), byP = new Map();
      for (const id of sel) {
        const n = api.nodes.get(id);
        if (!n || sel.has(n.parent_id)) continue; // 고른 항목의 하위는 부모와 함께 움직여요
        if (!byP.has(n.parent_id ?? null)) byP.set(n.parent_id ?? null, null);
      }
      return [...byP.keys()].map((p) => {
        const all = kids(p), slots = [];
        all.forEach((c, k) => { if (sel.has(c.id)) slots.push(k); });
        return { parent: p, all, slots, items: slots.map((k) => all[k]) };
      }).filter((g) => g.items.length > 1);
    }
    const out = [];
    const add = (p) => { const all = kids(p); if (all.length > 1) out.push({ parent: p, all, slots: all.map((_, k) => k), items: all }); };
    if (target === 'all') (function walk(p) { add(p); for (const c of kids(p)) walk(c.id); })(root());
    else add(root());
    return out;
  }
  const ctxOf = (n, k) => {
    const text = n.content;
    return {
      text, idx: k + 1, kids: kids(n.id).length, tags: tagsOf(text),
      num: (() => { const x = text.match(/-?\d+(?:\.\d+)?/); return x ? +x[0] : null; })(),
      m: (re) => { const x = text.match(re); return x ? (x[1] ?? x[0]) : null; },
      has: (s) => text.includes(s),
    };
  };
  /** 한 묶음의 새 순서 */
  function reorder(items, o) {
    if (o.method === 'reverse') return [...items].reverse();
    if (o.method === 'shuffle') return shuffle(items, o.rnd);
    if (o.method === 'rotate') { const k = ((Math.round(o.k) % items.length) + items.length) % items.length; return [...items.slice(-k || items.length), ...items.slice(0, -k || items.length)].slice(0, items.length); }
    if (o.method === 'interleave') { // k묶음으로 나눠 번갈아: 1a 1b 1c, 2a 2b … (k=2면 앞 절반 · 뒤 절반)
      const k = Math.max(2, Math.min(items.length, Math.round(o.k) || 2)), size = Math.ceil(items.length / k), parts = [], out = [];
      for (let p = 0; p < k; p++) parts.push(items.slice(p * size, (p + 1) * size));
      for (let i = 0; i < size; i++) for (const part of parts) if (i < part.length) out.push(part[i]);
      return out;
    }
    const keyed = items.map((n, k) => ({ n, key: o.fn(ctxOf(n, k)) }));
    keyed.sort((a, b) => cmp(a.key, b.key) * (o.desc ? -1 : 1)); // 같은 값이면 원래 순서 그대로 (안정 정렬)
    return keyed.map((x) => x.n);
  }

  return {
    async sort() { // 예전 ord
      const hasSel = api.view.selection().length > 1;
      let plan = [];
      const o = await ui.form({
        title: `순서 바꾸기 · ${label()}`, submit: '바꾸기', focus: 'expr',
        values: { target: hasSel ? 'sel' : 'screen', method: 'sort', expr: 'text', dir: 'asc', k: null },
        fields: [
          { key: 'target', label: '대상', type: 'seg', options: [['screen', '화면 바로 아래'], ['sel', '고른 항목', hasSel ? {} : { disabled: true, title: '먼저 항목을 둘 이상 고르세요' }], ['all', '모든 단계']] },
          { key: 'method', label: '방법', type: 'seg', options: METHODS },
          { key: 'expr', label: '기준 = 식', type: 'text', mono: true, show: (v) => v.method === 'sort' },
          { key: 'dir', type: 'seg', options: [['asc', '오름차순'], ['desc', '내림차순']], inline: true, show: (v) => v.method === 'sort' },
          { key: 'expr', type: 'presets', items: KEYS, show: (v) => v.method === 'sort' },
          { type: 'help', label: '식 쓰는 법', text: HELP, show: (v) => v.method === 'sort' },
          { key: 'k', type: 'number', step: 1, show: (v) => v.method === 'interleave' || v.method === 'rotate',
            label: (v) => (v.method === 'rotate' ? '몇 칸 돌릴까요 (+ 뒤의 것을 앞으로 · − 앞의 것을 뒤로)' : '몇 묶음으로 나눠 엇갈릴까요 (2 = 앞 절반 · 뒤 절반)') },
        ],
        change: (key) => (key === 'method' ? { k: null } : null),
        buttons: [{ label: '다시 섞기', show: (v) => v.method === 'shuffle' }],
        history: {
          key: 'ord',
          show: (v) => `${METHODS.find(([m]) => m === v.method)?.[1]}${v.method === 'sort' ? ` · ${v.expr} ${v.desc ? '↓' : '↑'}` : v.k ? ` · ${v.k}` : ''}`,
          pick: (v) => ({ method: v.method, dir: v.desc ? 'desc' : 'asc', expr: v.expr || 'text', k: v.k || null }),
          save: (v) => ({ method: v.method, expr: v.expr, desc: v.dir === 'desc', k: v.k }),
        },
        preview: (v) => {
          plan = [];
          const o = { method: v.method, desc: v.dir === 'desc', k: v.k || (v.method === 'rotate' ? 1 : 2), fn: v.method === 'sort' ? compile(v.expr || 'text') : null, rnd: Math.random };
          const gs = groups(v.target);
          if (!gs.length) return { rows: [{ muted: true, text: '순서를 바꿀 항목이 둘 이상 없어요' }], ok: false };
          let moved = 0, total = 0;
          const next = gs.map((g) => {
            if (g.items.length > MAX) throw new Error(`한 부모 아래 ${MAX}개를 넘는 항목은 처리하지 않아요`);
            const n = reorder(g.items, o);
            total += n.length; moved += n.filter((x, k) => x !== g.items[k]).length;
            return { ...g, next: n };
          });
          plan = next;
          const g = plan[0];
          return {
            ok: moved > 0,
            note: `${plan.length > 1 ? `묶음 ${plan.length}개 · ` : ''}${total}개 중 ${moved}개 자리가 바뀌어요`,
            rows: [
              ...(plan.length > 1 ? [{ muted: true, text: `${g.parent === null ? '홈' : api.nodes.get(g.parent)?.content || '(빈 항목)'} 아래 (첫 묶음)` }] : []),
              ...g.next.slice(0, 40).map((n, k) => ({ num: k + 1, text: n.content, changed: n !== g.items[k] })),
              ...(g.next.length > 40 ? [{ muted: true, text: `… 외 ${g.next.length - 40}개` }] : []),
            ],
          };
        },
      });
      if (!o || !plan.length) return;
      for (const g of plan) { // 바꿀 자리에만 새 순서를 넣고, 나머지 형제는 그대로
        const ids = g.all.map((n) => n.id);
        g.slots.forEach((s, k) => { ids[s] = g.next[k].id; });
        await api.nodes.reorder(g.parent, ids);
      }
      await api.view.refresh();
      ui.toast('순서를 바꿨어요', 1.5);
    },
  };
}

export default (api) => command(api, { name: 'sort', label: '순서 바꾸기 (정렬 · 뒤집기 · 섞기 · 엇갈리기 · 돌리기)', selection: '정렬', selectionMin: 2, make }); // 둘 이상 고르면 선택 막대에 '정렬'
