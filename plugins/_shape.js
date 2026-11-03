// 수식으로 계층 바꾸기 (tree의 '단계 바꾸기 · 묶기', 예전 reshape · tx) — 현재 화면 아래 항목들의 구조를 식으로 다시 짜요
//   단계: 항목마다 '몇 번째 단계에 둘지'를 식으로 (1 = 화면 바로 아래). 순서는 그대로, 앞 항목보다 두 단계 이상 깊어지지는 않아요
//   묶기: 항목마다 '묶을 이름'을 식으로. 같은 부모 아래에서 이름이 같은 항목들을 그 이름의 새 항목 아래로 모아요 (빈 값이면 그대로)
import { compile } from './_expr.js';

const JOINS = [['space', '띄어쓰기'], ['line', '줄바꿈'], ['blank', '빈 줄'], ['custom', '직접']];
// 나누기(split) 기준 — 직접은 정규식
const SPLITS = [['line', '줄마다', /\n+/], ['blank', '빈 줄(문단)', /\n\s*\n/], ['sentence', '문장마다', /(?<=[.!?。？！])\s+/], ['custom', '직접 (정규식)', null]];

const PRESETS = {
  depth: [
    ['모두 한 단계로 펴기', '1'],
    ['번호 1.2.3 → 단계', "m(/^(\\d+(?:\\.\\d+)*)/)?.split('.').length ?? prev + 1"],
    ['# 제목 → 단계', "m(/^(#+)\\s/)?.length ?? prev + 1"],
    ['한 단계 올리기', 'max(1, depth - 1)'],
    ['한 단계 내리기', 'depth + 1'],
  ],
  group: [
    ['첫 태그로', 'tags[0]'],
    ['날짜의 년-월로', "m(/(\\d{4}-\\d{2})-\\d{2}/)"],
    ['첫 글자로', 'text.trim()[0]?.toUpperCase()'],
    ['10개씩', "`${floor((idx - 1) / 10) * 10 + 1}–${floor((idx - 1) / 10) * 10 + 10}`"],
  ],
};
const HELP = `**text** 글 · **depth** 지금 단계(1부터) · **idx** 형제 중 몇 번째 · **n** 전체 순서 · **kids** 하위 개수 · **parent** 부모 글 · **tags** 태그 목록 · **num** 첫 숫자
**m(/정규식/)** 첫 괄호(없으면 전체) 또는 null · **has('글')** · 단계 식에서는 **prev** = 바로 앞 항목의 새 단계 · Math 함수(floor · max …)`;

export default function make(api, ui, t) { // tree.js · join.js · split.js가 같이 써요
  const { kids, root, label, tagsOf } = t;

  /** 화면 아래 항목들을 문서 순서로: {node, depth, idx, parent, kids} */
  function entries() {
    const out = [];
    (function walk(id, depth, parentText) {
      kids(id).forEach((c, k) => {
        out.push({ node: c, depth, idx: k + 1, parent: parentText, kids: kids(c.id).length });
        walk(c.id, depth + 1, c.content);
      });
    })(root(), 1, root() === null ? '' : api.nodes.get(root())?.content ?? '');
    return out;
  }
  const ctxOf = (e, n, extra = {}) => {
    const text = e.node.content;
    return {
      text, depth: e.depth, idx: e.idx, n, kids: e.kids, parent: e.parent, tags: tagsOf(text),
      num: (() => { const x = text.match(/-?\d+(?:\.\d+)?/); return x ? +x[0] : null; })(),
      m: (re) => { const x = text.match(re); return x ? (x[1] ?? x[0]) : null; },
      has: (s) => text.includes(s),
      ...extra,
    };
  };

  /** 단계 식 → [{e, d}] (d = 새 단계) */
  function planDepth(fn, list) {
    let prev = 0;
    return list.map((e, k) => {
      let d = Math.round(Number(fn(ctxOf(e, k + 1, { prev }))));
      if (!Number.isFinite(d)) d = e.depth;
      d = Math.max(1, Math.min(d, prev + 1));
      prev = d;
      return { e, d };
    });
  }
  /** 묶기 식 → 부모마다 [{group, members} | {e}] (all이 아니면 화면 바로 아래만) */
  function planGroup(fn, list, all) {
    const byParent = new Map();
    list.forEach((e, k) => {
      if (!all && e.depth !== 1) return;
      const raw = fn(ctxOf(e, k + 1));
      const key = raw == null || raw === false || String(raw).trim() === '' ? null : String(raw).trim();
      const p = e.node.parent_id ?? null;
      if (!byParent.has(p)) byParent.set(p, []);
      byParent.get(p).push({ e, key });
    });
    const plan = new Map();
    for (const [p, rows] of byParent) {
      if (!rows.some((r) => r.key)) continue;
      const order = [], groups = new Map();
      for (const r of rows) {
        if (!r.key) { order.push({ e: r.e }); continue; }
        if (!groups.has(r.key)) { const g = { group: r.key, members: [] }; groups.set(r.key, g); order.push(g); }
        groups.get(r.key).members.push(r.e);
      }
      plan.set(p, order);
    }
    return plan;
  }

  return {
    /** mode: 'depth' · 'group' · tabs: tree 창 맨 위의 고르기 단추 { items, still } → 다른 탭을 고르면 { tab } 을 돌려줘요 */
    async reshape(initMode = 'depth', tabs = null) { // 예전 tx
      const list = entries();
      if (!list.length) return ui.toast('이 화면에 바꿀 항목이 없어요', 2.5, true);
      let plan = null;
      const line = (d, text, x = {}) => ({ depth: d - 1, mark: '•', text: text.length > 90 ? text.slice(0, 90) + '…' : text, ...x });
      const f = await ui.form({
        title: tabs ? '계층' : `${initMode === 'group' ? '묶기' : '단계 바꾸기'} · ${list.length}개`, submit: '바꾸기', focus: 'expr',
        tabs: tabs && { items: tabs.items, value: initMode }, still: !!tabs?.still,
        values: { mode: initMode === 'group' ? 'group' : 'depth', expr: initMode === 'group' ? '' : 'depth', all: false },
        fields: [
          ...(tabs ? [] : [{ key: 'mode', label: '무엇을 바꿀까요', type: 'seg', options: [['depth', '단계 (깊이)'], ['group', '묶기']] }]),
          { key: 'expr', type: 'text', mono: true, label: (v) => (v.mode === 'depth' ? '새 단계 = 식' : '묶을 이름 = 식') },
          { key: 'expr', type: 'presets', items: PRESETS.depth, show: (v) => v.mode === 'depth' },
          { key: 'expr', type: 'presets', items: PRESETS.group, show: (v) => v.mode === 'group' },
          { key: 'all', type: 'check', label: '모든 단계에서 묶기', show: (v) => v.mode === 'group' },
          { type: 'help', label: '식 쓰는 법', text: HELP },
        ],
        change: (key, v) => (key === 'mode' ? { expr: v.mode === 'depth' ? 'depth' : '' } : null),
        history: { key: 'tx', show: (v) => `${v.mode === 'group' ? '묶기' : '단계'} · ${v.expr}`, pick: (v) => (tabs && v.mode !== initMode ? {} : { mode: v.mode, expr: v.expr, all: !!v.all }) },
        preview: (v) => {
          plan = null;
          if (!v.expr.trim()) return { rows: [{ muted: true, text: '식을 넣으면 바뀐 모습을 보여줘요' }], ok: false };
          const fn = compile(v.expr);
          if (v.mode === 'depth') {
            plan = planDepth(fn, list);
            const changed = plan.filter((x) => x.d !== x.e.depth).length;
            return {
              ok: changed > 0, submit: changed ? '바꾸기 ✓' : '바꾸기', note: `${changed}개 항목의 단계가 바뀌어요`,
              rows: [...plan.slice(0, 80).map((x) => line(x.d, x.e.node.content, { changed: x.d !== x.e.depth })), ...(plan.length > 80 ? [{ muted: true, text: `… 외 ${plan.length - 80}개` }] : [])],
            };
          }
          plan = planGroup(fn, list, v.all);
          let groups = 0, moved = 0;
          const rows = [];
          for (const [p, order] of plan) {
            const pd = p === root() ? 1 : (list.find((e) => e.node.id === p)?.depth ?? 0) + 1;
            if (p !== root()) rows.push(line(pd - 1, api.nodes.get(p)?.content ?? '', { muted: true }));
            for (const o of order) {
              if (!o.group) { rows.push(line(pd, o.e.node.content)); continue; }
              groups++; moved += o.members.length;
              rows.push(line(pd, `${o.group}  (${o.members.length})`, { changed: true }));
              rows.push(...o.members.slice(0, 3).map((e) => line(pd + 1, e.node.content)));
              if (o.members.length > 3) rows.push(line(pd + 1, `… 외 ${o.members.length - 3}개`, { muted: true }));
            }
          }
          return { ok: groups > 0, submit: groups ? '바꾸기 ✓' : '바꾸기', note: groups ? `묶음 ${groups}개 · 항목 ${moved}개를 옮겨요` : '', rows: rows.length ? rows : [{ muted: true, text: '묶을 항목이 없어요' }] };
        },
      });
      if (f?.tab) return f;
      if (!f || !plan) return;
      const mode = f.mode;
      const ops = [];
      if (mode === 'depth') {
        const parents = [root()], pos = new Map(), hadKids = new Map(list.map((e) => [e.node.id, e.kids > 0]));
        for (const { e, d } of plan) {
          parents.length = d;
          const p = parents[d - 1];
          const k = pos.get(p) ?? 0; pos.set(p, k + 1);
          const op = { id: e.node.id, parent_id: p, position: k };
          if (p !== root() && !hadKids.get(p)) hadKids.set(p, true), ops.push({ id: p, collapsed: 0 }); // 새로 하위가 생긴 항목은 펼쳐서 보여줘요
          ops.push(op);
          parents.push(e.node.id);
        }
      } else {
        for (const [p, order] of plan) {
          for (let k = 0; k < order.length; k++) {
            const o = order[k];
            if (!o.group) { ops.push({ id: o.e.node.id, parent_id: p, position: k }); continue; }
            const gid = await api.nodes.create(p, null, o.group);
            ops.push({ id: gid, parent_id: p, position: k });
            o.members.forEach((e, j) => ops.push({ id: e.node.id, parent_id: gid, position: j }));
          }
        }
      }
      const r = await api.nodes.bulk(ops);
      if (r?.error) return ui.toast(r.error, 4, true);
      api.view.clearUndo();
      await api.view.refresh();
      ui.toast(mode === 'depth' ? '단계를 바꿨어요' : '묶었어요', 2.5);
    },

    // 항목 합치기 (join): 선택한 항목들의 글을 첫 항목 하나에 이어 붙여 한 문단으로. 나머지 항목은 없어지고,
    // 그 항목들의 하위는 합친 항목 아래로 옮겨요 ('하위 글도 합치기'를 켜면 하위 글까지 이어 붙여요)
    async join() {
      const sel = api.view.selection();
      const inSel = new Set(sel);
      // 위에서부터: 선택한 항목 중 조상도 선택된 것(범위로 고를 때 딸려 온 하위)은 빼요 — 선택 막대의 'N개 선택됨'과 같아요
      const tops = sel.filter((id) => { for (let p = api.nodes.get(id)?.parent_id; p != null; p = api.nodes.get(p)?.parent_id) if (inSel.has(p)) return false; return true; });
      if (tops.length < 2) return ui.toast('합칠 항목을 둘 이상 선택하세요 (Shift+↑/↓ · Shift+클릭 · Ctrl/⌘+클릭)', 3.5, true);
      let plan = null;
      const under = (id, out = []) => { for (const c of kids(id)) { out.push(c); under(c.id, out); } return out; };
      function compute(o) {
        const sep = o.how === 'space' ? ' ' : o.how === 'line' ? '\n' : o.how === 'blank' ? '\n\n' : o.custom.replace(/\\n/g, '\n');
        const parts = [], gone = [], moves = [];
        const target = tops[0];
        const take = (n) => parts.push(o.trim ? n.content.trim() : n.content);
        if (o.kids) for (const id of tops) { const n = api.nodes.get(id); take(n); for (const d of under(id)) take(d); if (id !== target) gone.push(id); }
        else {
          for (const id of tops) { take(api.nodes.get(id)); if (id !== target) gone.push(id); }
          // 없어지는 항목들의 하위는 합친 항목 맨 아래로 (순서 그대로)
          let k = kids(target).length;
          for (const id of tops) if (id !== target) for (const c of kids(id)) moves.push({ id: c.id, parent_id: target, position: k++ });
        }
        const text = parts.filter((x) => !o.trim || x !== '').join(sep);
        const dropKids = o.kids ? under(target).map((d) => d.id) : []; // 하위 글까지 합쳤으면 첫 항목의 하위도 글로 들어갔어요
        return { target, text, gone: [...gone, ...dropKids.filter((id) => !gone.includes(id))], moves };
      }
      const f = await ui.form({
        title: `항목 합치기 · 선택한 항목 ${tops.length}개`, submit: '합치기', focus: 'submit', previewLabel: '합친 글',
        values: { how: 'space', custom: ', ', kids: false, trim: true },
        fields: [
          { key: 'how', label: '이어 붙이는 방법', type: 'seg', options: JOINS },
          { key: 'custom', label: '사이에 넣을 글 (\\n = 줄바꿈)', type: 'text', mono: true, show: (v) => v.how === 'custom' },
          { key: 'kids', type: 'check', label: '하위 항목 글도 합치기' },
          { key: 'trim', type: 'check', label: '앞뒤 빈칸 정리' },
        ],
        preview: (v) => {
          plan = compute(v);
          const total = v.kids ? tops.reduce((s, id) => s + 1 + under(id).length, 0) : tops.length;
          return { note: `${total}개 → 1개 (첫 항목에)${plan.moves.length ? ` · 하위 ${plan.moves.length}개는 그 아래로` : ''}`, text: plan.text.length > 4000 ? `${plan.text.slice(0, 4000)}…` : plan.text || '(빈 글)' };
        },
      });
      if (!f || !plan) return;
      await api.view.flush?.();
      if (plan.moves.length) { const r = await api.nodes.bulk(plan.moves); if (r?.error) return ui.toast(r.error, 4, true); } // 하위를 먼저 옮기고 (지우면 하위도 함께 지워져서)
      const r = await api.nodes.bulk([{ id: plan.target, content: plan.text }, ...plan.gone.map((id) => ({ id, delete: 1 }))]);
      if (r?.error) return ui.toast(r.error, 4, true);
      api.view.clearUndo();
      await api.view.refresh();
      api.view.select?.([]);
      api.view.focus?.(plan.target, 'end');
      ui.toast(`${tops.length}개 항목을 한 문단으로 합쳤어요`, 2.5);
    },

    // 항목 나누기 (split, join의 반대): 고른 항목들(없으면 커서 항목)의 글을 줄 · 문단 · 문장 · 정규식으로 잘라 여러 항목으로.
    // 첫 조각은 그 항목에 남고, 나머지는 바로 아래 형제로 (또는 '하위로'를 켜면 그 항목의 하위 맨 위로)
    async split() {
      const sel = api.view.selection();
      const ids = sel.length ? sel : [api.view.cursorId()].filter((id) => id != null); // 제목(들어와 있는 항목)도 다른 항목과 같아요
      const nodes = ids.map((id) => api.nodes.get(id)).filter(Boolean);
      if (!nodes.length) return ui.toast('나눌 항목에 커서를 두거나 항목을 고르세요', 3, true);
      const last = (await api.storage.get('last').catch(() => null)) || {};
      const reOf = (v) => { const re = SPLITS.find(([x]) => x === v.by)[2]; if (re) return re; try { return v.custom ? new RegExp(v.custom, 'u') : null; } catch { return null; } };
      let plan = [];
      const o = await ui.form({
        title: `항목 나누기 · ${nodes.length > 1 ? `선택한 항목 ${nodes.length}개` : '커서 항목'}`, submit: '나누기', focus: 'submit', previewLabel: '나눈 조각',
        values: { by: SPLITS.some(([v]) => v === last.by) ? last.by : 'line', custom: last.custom ?? ',\\s*', kids: !!last.kids },
        fields: [
          { key: 'by', label: '나누는 기준', type: 'seg', options: SPLITS.map(([v, l]) => [v, l]) },
          { key: 'custom', label: '자를 자리 (정규식)', type: 'text', mono: true, show: (v) => v.by === 'custom', bad: (v) => !reOf(v) },
          { key: 'kids', type: 'check', label: '하위로' },
        ],
        preview: (v) => {
          const re = reOf(v);
          plan = re ? nodes.map((n) => ({ n, parts: n.content.split(re).map((x) => (x ?? '').trim()).filter(Boolean) })).filter((x) => x.parts.length > 1) : [];
          if (!plan.length) return { rows: [{ muted: true, text: '나눌 자리가 없어요' }], ok: false };
          return {
            note: `${plan.length}개 항목 → ${plan.reduce((s, x) => s + x.parts.length, 0)}개`,
            rows: [...plan.slice(0, 20).flatMap(({ n, parts }) => [{ muted: true, text: n.content }, ...parts.map((x) => ({ after: true, text: `${v.kids ? '  └ ' : '• '}${x}` }))]),
              ...(plan.length > 20 ? [{ muted: true, text: `… 외 ${plan.length - 20}개 항목` }] : [])],
          };
        },
      });
      if (!o || !plan.length) return;
      api.storage.set('last', { by: o.by, custom: o.custom, kids: o.kids }).catch(() => {});
      await api.view.flush();
      let made = 0;
      for (const { n, parts } of [...plan].reverse()) { // 아래 항목부터: 위 항목의 자리 번호가 바뀌지 않게
        const rest = parts.slice(1);
        const at = o.kids ? 0 : kids(n.parent_id ?? null).findIndex((c) => c.id === n.id) + 1;
        for (let k = 0; k < rest.length; k++) await api.nodes.create(o.kids ? n.id : n.parent_id ?? null, at + k, rest[k]);
        made += rest.length;
      }
      const ops = plan.map(({ n, parts }) => ({ id: n.id, content: parts[0] }));
      if (o.kids) for (const { n } of plan) ops.push({ id: n.id, collapsed: 0 });
      const r = await api.nodes.bulk(ops);
      if (r?.error) return ui.toast(r.error, 4, true);
      api.view.clearUndo();
      await api.view.refresh();
      api.view.select?.([]);
      ui.toast(`${plan.length}개 항목을 나눠 ${made}개를 새로 만들었어요`, 2.5);
    },
  };
}
