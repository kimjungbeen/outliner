// 계층 (tree) — 계층을 어떻게 볼지 · 어떻게 짤지를 한 창에서. 위의 단추로 고르고, 마지막에 고른 것을 기억해요
//   접기 — 위에서 N단계까지 보이게(그 아래는 접기) · 아래(말단)에서 N단계 접기 (예전 fold · clc)
//   찾아 펼치기 — 글이 맞는 항목까지 펼치고 강조 · 맞는 것만 보이게 · 접기 · 펼치기 (글자 그대로, '정규식'을 켜면 정규식)
//   단계 바꾸기 · 묶기 — 식으로 깊이를 다시 정하기 · 공통 글자로 하위에 모으기 (예전 reshape, 본체는 _shape.js)
//   접기 · 찾아 펼치기는 보이는 모습만 바꾸고(적용), 단계 바꾸기 · 묶기는 항목을 옮겨요(바꾸기)
// 모두 접기 · 모두 펼치기는 collapse · expand 명령(단축키)이에요
import { command } from './_kit.js';
import { findRe } from './_tools.js';
import makeShape from './_shape.js';
const TABS = [['fold', '접기'], ['find', '찾아 펼치기'], ['depth', '단계 바꾸기'], ['group', '묶기']];
const MODES = [['top', '위에서 단계'], ['bottom', '아래에서 단계']];
const RX_ACTS = [['show', '펼치고 강조'], ['only', '맞는 것만 보이게'], ['fold', '접기'], ['unfold', '펼치기']];
const PRESETS = [['1단계만', { mode: 'top', n: 1 }], ['2단계까지', { mode: 'top', n: 2 }], ['3단계까지', { mode: 'top', n: 3 }], ['마지막 단계 접기', { mode: 'bottom', n: 1 }]];
const PREVIEW = 120;

function make(api, ui, t) {
  const { kids, root, descendants, label } = t;



  /** 화면 아래 항목들: { n, depth(1부터), height(말단 = 0), has(하위 있음) } — 문서 순서 */
  function survey() {
    const rows = [];
    (function walk(id, depth) {
      let h = -1;
      for (const c of kids(id)) {
        const row = { n: c, depth, has: kids(c.id).length > 0 };
        rows.push(row);
        row.height = walk(c.id, depth + 1);
        h = Math.max(h, row.height);
      }
      return h + 1;
    })(root(), 1);
    return rows;
  }

  const shape = makeShape(api, ui, t);
  let still = false, findText = ''; // findText: 처음 연 '찾아 펼치기'에 넣을 글 (고른 글자) · still: 탭을 바꿔 다시 연 창은 나타나는 움직임 없이 (같은 창처럼 보이게)

  /** picked: 부를 때 고른 글자 → '찾아 펼치기'에 그 글자를 넣고 열어요 */
  async function tree(picked) {
    let tab = await api.storage.get('tab').catch(() => null);
    if (!TABS.some(([v]) => v === tab)) tab = 'fold';
    findText = typeof picked === 'string' ? picked : '';
    if (findText) tab = 'find';
    still = false;
    for (;;) {
      const r = tab === 'fold' || tab === 'find' ? await fold(tab) : await shape.reshape(tab, { items: TABS, still });
      if (!r?.tab) return;
      tab = r.tab; still = true;
      api.storage.set('tab', tab).catch(() => {});
    }
  }

  async function fold(tab) {
    const rows = survey(), withKids = rows.filter((r) => r.has);
    if (!withKids.length && tab === 'fold') ui.toast('이 화면에는 접을 항목이 없어요', 2.5, true);
    const maxDepth = Math.max(...rows.map((r) => r.depth)), maxHeight = Math.max(...rows.map((r) => r.height));
    let plan = null, hitIds = []; // plan: id → 접을지(true/false), 바뀌는 것만 · hitIds: 정규식에 맞는 항목 (찾아 보이게 · 맞는 것만 보이게는 강조해요)
    const highlights = (o) => o.mode === 'regex' && (o.act === 'show' || o.act === 'only'); // 맞는 항목을 강조하는 방법

    /** 새 접힘: id → true(접음) / false(펼침). 하위가 있는 항목만 */
    function target(o) {
      const want = new Map();
      if (o.mode === 'top' || o.mode === 'bottom') {
        const n = Math.max(1, Math.round(o.n) || 1);
        for (const r of withKids) {
          const fold = o.mode === 'top' ? r.depth >= n : r.height <= n;
          if (fold || !o.keep) want.set(r.n.id, fold);
        }
        return want;
      }
      const re = findRe(o.re, { regex: o.rx, icase: o.i });
      const hit = new Set(rows.filter((r) => re.test(r.n.content)).map((r) => r.n.id));
      hitIds = [...hit];
      if (o.act === 'fold' || o.act === 'unfold') { for (const r of withKids) if (hit.has(r.n.id)) want.set(r.n.id, o.act === 'fold'); return want; }
      const path = new Set(); // 맞는 항목까지 가는 길(조상)은 펼쳐요 — '맞는 것만 보이게'면 나머지는 접어요
      for (const id of hit) for (let p = api.nodes.get(id)?.parent_id; p != null && p !== root(); p = api.nodes.get(p)?.parent_id) path.add(p);
      if (o.act === 'show') { for (const id of path) want.set(id, false); return want; }
      for (const r of withKids) want.set(r.n.id, !path.has(r.n.id));
      return want;
    }
    /** 적용한 뒤 보이는 모습 (접힌 항목 아래는 안 보여요) */
    function preview(want) {
      const lines = [];
      let more = 0;
      (function walk(id, depth) {
        for (const c of kids(id)) {
          const has = kids(c.id).length > 0, cur = !!c.collapsed, next = want.has(c.id) ? want.get(c.id) : cur;
          if (lines.length < PREVIEW) lines.push({ depth: depth - 1, mark: has ? (next ? '▸' : '▾') : '•', text: c.content.length > 80 ? `${c.content.slice(0, 80)}…` : c.content, changed: has && next !== cur });
          else more++;
          if (has && !next) walk(c.id, depth + 1);
        }
      })(root(), 1);
      return more ? [...lines, { muted: true, text: `… 외 ${more}줄` }] : lines;
    }
    const isFind = tab === 'find';
    const o = await ui.form({
      title: '계층', submit: '적용', tabs: { items: TABS, value: tab }, still, focus: isFind ? 're' : 'n', // 무엇을 하는지는 위쪽 탭이 보여줘요
      values: { mode: isFind ? 'regex' : 'top', n: 1, keep: false, re: isFind ? findText : '', i: true, rx: false, act: 'show' },
      fields: isFind ? [
        { key: 're', label: '찾을 글', type: 'text', mono: true },
        { key: 'rx', type: 'check', label: '정규식', inline: true },
        { key: 'i', type: 'check', label: '대소문자 무시', inline: true },
        { key: 'act', label: '맞는 항목을', type: 'seg', options: RX_ACTS },
      ] : [
        { key: 'mode', label: '방법', type: 'seg', options: MODES },
        { key: 'n', type: 'number', min: 1, step: 1, label: (v) => (v.mode === 'top' ? '몇 단계까지 보일까요' : '말단에서 몇 단계 위까지 접을까요'), suffix: (v) => `최대 ${v.mode === 'top' ? maxDepth : maxHeight}` },
        { key: 'keep', type: 'check', label: '접기만 하고 나머지는 그대로' },
        { type: 'presets', items: PRESETS.map(([l, v]) => [l, { ...v, keep: false }]), key: 'n' },
      ],
      history: {
        key: isFind ? 'tree-find' : 'fold',
        show: (v) => (v.mode === 'regex' ? `${RX_ACTS.find(([a]) => a === v.act)?.[1]} · ${v.rx ? '/' + v.re + '/' : v.re}` : `${v.mode === 'top' ? '위에서' : '아래에서'} ${v.n}단계${v.keep ? ' · 접기만' : ''}`),
        pick: (v) => ((v.mode === 'regex') === isFind ? v : {}), // 다른 탭의 기록은 무시
        save: (v) => (v.mode === 'regex' ? { mode: 'regex', re: v.re, i: v.i, rx: v.rx, act: v.act } : { mode: v.mode, n: v.n || 1, keep: v.keep }),
      },
      preview: (v) => {
        plan = null; hitIds = [];
        if (v.mode === 'regex' && !v.re) return { rows: [{ muted: true, text: '찾을 글을 넣으면 바뀐 모습을 보여줘요' }], ok: false };
        let want;
        try { want = target(v); } catch (e) { throw new Error(`정규식 오류: ${e.message}`); }
        plan = new Map([...want].filter(([id, f]) => !!api.nodes.get(id)?.collapsed !== f));
        const folds = [...plan.values()].filter(Boolean).length, opens = plan.size - folds;
        const marks = highlights(v) ? hitIds.length : 0;
        return {
          ok: plan.size > 0 || marks > 0, rows: preview(want),
          note: (!plan.size ? (marks ? '이미 다 보여요' : '바뀌는 항목이 없어요') : folds && opens ? `${folds}개 접고 ${opens}개 펼쳐요` : folds ? `${folds}개 접어요` : `${opens}개 펼쳐요`) + (marks ? ` · ${marks}개 강조` : ''),
        };
      },
    });
    findText = '';
    if (o?.tab) return o;
    if (!o) return;
    const marks = highlights(o) ? hitIds : [];
    if (!plan?.size && !marks.length) return;
    if (plan.size) await api.nodes.bulk([...plan].map(([id, f]) => ({ id, collapsed: f ? 1 : 0 })));
    await api.view.refresh();
    if (marks.length) { api.view.highlight(marks); return ui.toast(`${marks.length}개 항목이 맞아요`, 2); }
    const folds = [...plan.values()].filter(Boolean).length;
    ui.toast(`${folds ? `${folds}개 접었어요` : ''}${folds && plan.size - folds ? ' · ' : ''}${plan.size - folds ? `${plan.size - folds}개 펼쳤어요` : ''}`, 2);
  }

  return { tree };
}

export default (api) => command(api, { name: 'tree', label: '계층 (접기 · 찾아 펼치기 · 단계 바꾸기 · 묶기 — 지금 화면 아래)', make });
