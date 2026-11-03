// 서식 없애기 — 명령 이름 plain, 기본 단축키 ⌃U (윈도우 Alt+U) · 예전 links(링크 접기)를 넓혔어요
// 고른 항목들(없으면 지금 화면 아래 전부)의 마크다운 표시를 걷어 평범한 글로 만들어요. 창에서 미리 보고 바꿔요.
//   서식: **굵게** · *기울임* · ~~취소선~~ · `코드` · ==형광펜== · 제목(# ) · 인용(> ) → 기호만 빼고 글은 그대로
//         어디가 서식인지는 화면이 그릴 때와 같은 규칙(lib.js mdSegments)으로 봐요 — 첨부 표시 · 주소 · 태그는 건드리지 않아요
//   링크 [글자](주소): 글자만 · 글자 (주소) · 주소는 하위로 접기(예전 links) · 그대로 중에서 골라요
//     하위로 접기: "참고 [위키](https://…) 를 보세요" → "참고 위키 를 보세요" └ https://… (접혀 있어요)
//     맨 주소(https://www.example.com/긴/경로)는 출처 도메인(example.com)만 글에 남기고 주소는 하위로.
//     링크가 여러 개면 하위 항목에 "글자 — 주소"로 짝을 지어요. 이미 하위가 있으면 맨 위에 '🔗 링크' 항목을 만들어 그 안에.
//     주소 하나만 있는 항목(옮겨 둔 주소 자신)은 건드리지 않아요.
let ui; // api.ui — 불러올 때 받아요
import { command } from './_kit.js';
let mdSegments = () => null; // 화면과 같은 마크다운 규칙 (api.md.segments) — 플러그인을 불러올 때 받아요

const MD_LINK = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/giu;
const BARE = /\b(?:https?:\/\/|www\.)[^\s<>"'）)\]]+[^\s<>"'）)\].,;:!?]/giu;
const ONLY_URL = new RegExp(`^(?:[^\\n]+ — )?(?:${BARE.source})$`, 'iu'); // 주소만, 또는 이 플러그인이 만든 '글자 — 주소'
const FILE = /!?\[[^\]]*\]\(\/files\//; // 첨부 표시는 그대로 (앱이 미리보기를 그려요)
const LINKS = [['text', '글자만'], ['both', '글자 (주소)'], ['fold', '주소는 하위로 접기'], ['keep', '그대로']];

const domainOf = (u) => u.replace(/^(?:https?:\/\/)?(?:www\.)?/i, '').split(/[/?#]/)[0] || u;
const fullUrl = (u) => (/^https?:|^mailto:/i.test(u) ? u : 'https://' + u);
const isFile = (s, m) => FILE.test(s.slice(Math.max(0, m.index - 1), m.index + m[0].length));

/** 서식 기호만 빼요 (글자는 그대로). 가로줄(---)처럼 기호뿐인 항목은 그대로 둬요 */
export function stripFormat(s) {
  const r = mdSegments(s);
  if (!r || r.block === 'hr') return s;
  return r.segs.filter((x) => x.k !== 'mk').map((x) => x.t).join('');
}
/** [글자](주소) → 글자 · '글자 (주소)' (첨부 표시는 그대로) */
export function unlink(s, mode) {
  return s.replace(MD_LINK, (all, label, url, i) => (isFile(s, { index: i, 0: all }) ? all : mode === 'both' ? `${label} (${url})` : label));
}
/** 링크 접기: 글 → { text: 주소를 뺀 글, links: [{label, url, md}] } (바꿀 게 없으면 null) */
export function foldLinks(content) {
  const s = String(content ?? '');
  if (!/\]\(|www\.|https?:|mailto:/i.test(s)) return null;
  if (ONLY_URL.test(s.trim())) return null; // 주소만 있는 항목 (옮겨 둔 주소 자신)
  const spans = [];
  for (const m of s.matchAll(MD_LINK)) if (!isFile(s, m)) spans.push({ a: m.index, b: m.index + m[0].length, label: m[1], url: m[2], md: true });
  const inside = (i) => spans.some((x) => i >= x.a && i < x.b) || /\]\(\/files\/[^)]*$/.test(s.slice(0, i));
  for (const m of s.matchAll(BARE)) if (!inside(m.index)) spans.push({ a: m.index, b: m.index + m[0].length, label: domainOf(m[0]), url: fullUrl(m[0]), md: false });
  if (!spans.length) return null;
  spans.sort((x, y) => x.a - y.a);
  let out = '', at = 0;
  const links = [];
  for (const x of spans) { out += s.slice(at, x.a) + x.label; at = x.b; links.push({ label: x.label, url: x.url, md: x.md }); }
  out += s.slice(at);
  return { text: out.replace(/[ \t]{2,}/g, ' ').trim(), links };
}
/** 항목 글 하나 → { text, fold: 하위로 옮길 링크들 | null } (바뀐 게 없으면 null) */
export function plainOf(content, { fmt = true, links = 'text' } = {}) {
  let s = String(content ?? ''), fold = null;
  if (links === 'fold') { const f = foldLinks(s); if (f) { s = f.text || f.links.map((l) => l.label).join(' '); fold = f.links; } }
  else if (links !== 'keep') s = unlink(s, links);
  if (fmt) s = stripFormat(s);
  return s === content && !fold ? null : { text: s, fold };
}

export default (api) => (ui = api.ui, (mdSegments = api.md.segments, command(api, {
  name: 'plain', keys: 'Alt+U', preload: false, selection: '서식 없애기', // 고르면 선택 막대에도
  label: '서식 없애기 (굵게 · 기울임 · 취소선 · 코드 · 형광펜 · 제목 기호를 빼고, 링크는 글자만 · 글자 (주소) · 주소는 하위로 — 선택한 항목, 없으면 지금 화면)',
  make: (api, ui, t) => ({ plain: () => run(api, t) }),
})));

async function run(api, t) {
  await api.view.flush();
  const { nodes, text: scope } = await t.picked(); // 고른 항목이 있으면 그 항목들만, 없으면 화면 아래 전부
  const last = (await api.storage.get('last').catch(() => null)) || {};
  let plan = [];
  const o = await ui.form({
    title: '서식 없애기', submit: '바꾸기', focus: 'submit', previewLabel: '바뀌는 항목',
    values: { fmt: last.fmt ?? true, links: LINKS.some(([v]) => v === last.links) ? last.links : 'text' },
    fields: [
      { type: 'info', label: '범위', text: scope },
      { key: 'fmt', type: 'check', label: '서식 기호 빼기 (굵게 · 기울임 · 취소선 · 코드 · 형광펜 · 제목 · 인용)' },
      { key: 'links', label: '링크 [글자](주소)', type: 'seg', options: LINKS },
    ],
    preview: (v) => {
      plan = nodes.map((n) => ({ n, r: plainOf(n.content, v) })).filter((x) => x.r);
      if (!plan.length) return { rows: [{ muted: true, text: '바꿀 서식이 없어요' }], ok: false };
      return {
        note: `${plan.length}개`,
        rows: [...plan.slice(0, 40).flatMap(({ n, r }) => [{ muted: true, text: n.content }, { after: true, text: `→ ${r.text}${r.fold ? `  (하위로 ${r.fold.length}개)` : ''}` }]),
          ...(plan.length > 40 ? [{ muted: true, text: `… 외 ${plan.length - 40}개` }] : [])],
      };
    },
  });
  if (!o || !plan.length) return;
  api.storage.set('last', { fmt: o.fmt, links: o.links }).catch(() => {});
  const ops = [];
  let moved = 0;
  for (const { n, r } of plan) {
    if (r.fold) { // 주소는 하위로 (예전 links)
      const lines = r.fold.map((l) => (r.fold.length > 1 && l.md ? `${l.label} — ${l.url}` : l.url));
      const hadKids = !!n.hk || api.nodes.children(n.id).length > 0;
      let parent = n.id;
      if (hadKids) parent = await api.nodes.create(n.id, 0, `🔗 링크 ${lines.length}개`);
      for (let i = 0; i < lines.length; i++) await api.nodes.create(parent, i, lines[i]);
      ops.push({ id: hadKids ? parent : n.id, collapsed: 1 });
      moved += lines.length;
    }
    ops.push({ id: n.id, content: r.text });
  }
  const res = await api.nodes.bulk(ops);
  if (res?.error) return ui.toast(res.error, 4, true);
  api.view.clearUndo();
  await api.view.refresh();
  ui.toast(`${plan.length}개 항목의 서식을 없앴어요${moved ? ` · 링크 ${moved}개는 하위로 접었어요` : ''}`, 3);
}
