// 찾아서 바꾸기(replace) · 찾아서 지우기(delete)가 같이 쓰는 본체 (예전 regex · fi · fr · fd)
// 찾을 글은 글자 그대로 찾아요 — '정규식'을 켜면 정규식($1 · $2 괄호도). 범위: 고른 항목이 있으면 그 항목들만, 없으면 지금 화면 아래 전부.
// replace의 '앞에 붙이기 · 뒤에 붙이기 · 떼기'로 태그나 글자를 붙이고 떼요 (예전 tag · mt). 찾아서 펼치기는 tree의 '찾아 펼치기'
import { findRe } from './_tools.js';
const PREVIEW = 30;
// 바로 고르기(replace): 찾기 · 바꿀 글을 채우고 고칠 자리(#태그)를 골라 둬요 — field: 고를 칸 (모두 정규식)
const PRESETS = [
  ['앞에 붙이기', { find: '^', to: '#태그 ', rx: true, $focus: 'to', $select: '#태그' }],
  ['뒤에 붙이기', { find: '$', to: ' #태그', rx: true, $focus: 'to', $select: '#태그' }],
  ['떼기', { find: '\\s*#태그(?=\\s|$)', to: '', rx: true, $focus: 'find', $select: '#태그' }],
];

export default function make(api, ui, t) { // replace.js · delete.js가 같이 써요
  const { kids, root, picked } = t;

  /** act: 'replace' | 'delete' · given: 부를 때 고른 글자 → 찾을 글에 미리 (글자 그대로) */
  async function run(act, given = '') {
    const { nodes, sel, text: scopeText } = await picked();
    const del = act === 'delete';
    let re = null, list = [];
    // 찾은 항목: 바꾸기는 범위의 모든 항목, 지우기는 화면 아래 항목(맞는 항목 아래로는 내려가지 않아요 — 어차피 함께 지워져요)
    const test = (s) => { re.lastIndex = 0; return re.test(s); };
    const hits = () => {
      if (!re) return [];
      if (del && !sel) {
        const out = [];
        (function visit(id) { for (const c of kids(id)) { if (test(c.content.trim())) out.push(c); else visit(c.id); } })(root());
        return out;
      }
      return nodes.filter((n) => test(n.content));
    };
    const after = (s, v) => { re.lastIndex = 0; return s.trim().replace(re, v.rx ? v.to : () => v.to).trim(); }; // 글자 그대로면 $도 그대로
    const marked = (s) => { // 찾은 부분을 칠해서 보여줘요
      re.lastIndex = 0;
      const out = []; let last = 0;
      for (const m of s.matchAll(re)) { out.push(s.slice(last, m.index), { hit: m[0] }); last = m.index + m[0].length; if (!m[0].length) break; }
      return [...out, s.slice(last)];
    };
    const verb = del ? '지우기' : '바꾸기';
    const o = await ui.form({
      title: del ? '찾아서 지우기' : '찾아서 바꾸기', submit: verb, danger: del, previewLabel: '', focus: 'find',
      values: { find: typeof given === 'string' ? given : '', to: '', rx: false, i: false },
      fields: [
        { key: 'find', label: '찾을 글', type: 'text', mono: true },
        { key: 'rx', type: 'check', label: '정규식', inline: true },
        { key: 'i', type: 'check', label: '대소문자 무시', inline: true },
        ...(del ? [] : [{ type: 'presets', items: PRESETS, key: 'find' }, { key: 'to', label: '바꿀 글', type: 'text', mono: true }]),
      ],
      history: {
        key: del ? 'del' : 'rx',
        show: (v) => `${v.rx === false ? v.f : `/${v.f}/`}${del ? '' : `  →  ${v.r ?? ''}`}`,
        pick: (v) => ({ find: v.f, to: v.r ?? '', i: !!v.i, rx: v.rx !== false }), // 예전(regex) 기록은 정규식
        save: (v) => ({ f: v.find, ...(del ? {} : { r: v.to }), i: v.i, rx: v.rx }),
      },
      preview: (v) => {
        re = null; list = [];
        if (!v.find) return { note: `범위: ${scopeText}`, rows: [], ok: false };
        try { re = findRe(v.find, { regex: v.rx, icase: v.i, g: true }); } catch (e) { return { note: `정규식 오류: ${e.message}`, rows: [], ok: false }; }
        list = hits();
        return {
          ok: list.length > 0, submit: list.length ? `${list.length}개 ${verb}` : verb,
          note: list.length ? `${list.length}개 항목이 맞아요${del ? ' · 하위 항목도 함께 지워져요' : ''}` : '맞는 항목이 없어요',
          rows: [...list.slice(0, PREVIEW).flatMap((n) => (del ? [{ text: marked(n.content) }] : [{ text: marked(n.content) }, { after: true, text: `→ ${after(n.content, v)}` }])),
            ...(list.length > PREVIEW ? [{ muted: true, text: `… 외 ${list.length - PREVIEW}개` }] : [])],
        };
      },
    });
    if (!o || !re || !list.length) return;
    if (del) {
      if (!(await ui.confirmDelete('지우기', `**${list.length}개 항목** — 하위 항목까지 지울까요? 되돌릴 수 없어요.`))) return; // 한 번 더 물어요
      await api.nodes.bulk(list.map((n) => ({ id: n.id, delete: 1 })));
    } else await api.nodes.bulk(list.map((n) => ({ id: n.id, content: after(n.content, o) })));
    api.view.clearUndo();
    await api.view.refresh();
    ui.toast(`${list.length}개 항목을 ${del ? '지웠어요' : '바꿨어요'}`, 2.5);
  }

  return { replace: (t) => run('replace', t), delete: (t) => run('delete', t) };
}
