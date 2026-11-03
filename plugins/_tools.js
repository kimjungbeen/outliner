// 여러 명령이 함께 쓰는 트리 도구. WorkFlowy의 getVisibleChildren/커서 순회 대신 재귀로 다뤄요.
const TAG_RE = /(?:^|\s)([#@][\p{L}\p{N}][\p{L}\p{N}_:-]*)/gu;

/** 찾을 글 → RegExp. regex가 아니면 글자 그대로 찾아요 (특수 문자를 이스케이프) — tree · replace · delete가 같이 써요 */
export const findRe = (text, { regex = false, icase = false, g = false } = {}) =>
  new RegExp(regex ? text : text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), (g ? 'g' : '') + (icase ? 'i' : ''));

/** 텍스트 안의 #태그/@태그 목록 (끝의 콜론은 제거) */
export const tagsOf = (s) => [...s.matchAll(TAG_RE)].map((m) => m[1].replace(/:{1,2}$/, ''));

export default function makeTools(api) {
  // 불러온 자식들을 순서대로. 하위 전체가 필요한 명령은 실행 전에 api.nodes.loadSubtree()가 먼저 불러와요 (_kit.js의 preload)
  /** id의 자식들. null이면 최상위 */
  const kids = (id) => api.nodes.children(id);
  /** 지금 화면의 기준 항목 id (WorkFlowy의 currentItem). 최상위 화면이면 null */
  const root = () => api.view.zoomId();

  /** 기준 항목의 모든 하위 항목 (기준 항목 자신은 제외) */
  function* descendants(id = root()) {
    for (const c of kids(id)) {
      yield c;
      yield* descendants(c.id);
    }
  }
  /** 기준 항목 자신(있으면) + 모든 하위 항목 */
  function* scope() {
    const r = root();
    if (r !== null) yield api.nodes.get(r);
    yield* descendants();
  }

  /** 명령이 다룰 항목: 고른 항목이 있으면 그 항목들만(화면 순서), 없으면 지금 화면(기준 항목 + 하위 전부 — 먼저 불러와요)
   *  → { nodes, sel: 고른 항목인지, text: '선택한 항목 3개' · '지금 화면 아래 12개 항목' · '전체 …' } */
  async function picked() {
    const ids = api.view.selection();
    if (ids.length) {
      const nodes = ids.map((id) => api.nodes.get(id)).filter(Boolean);
      return { nodes, sel: true, text: `선택한 항목 ${nodes.length}개` };
    }
    await api.nodes.loadSubtree(root());
    const nodes = [...scope()].filter(Boolean);
    return { nodes, sel: false, text: root() === null ? `전체 ${nodes.length}개 항목` : `지금 화면 아래 ${nodes.length}개 항목` };
  }

  /** n의 조상 id 목록 (기준 항목 아래쪽까지만) */
  function ancestorsUpTo(n, stop = root()) {
    const out = [];
    let p = n.parent_id;
    while (p !== null && p !== stop) {
      out.push(p);
      p = api.nodes.get(p)?.parent_id ?? null;
    }
    return out;
  }

  const expandOps = (ids) => [...new Set(ids)].map((id) => ({ id, collapsed: 0 }));
  const label = () => (root() === null ? '홈' : api.nodes.get(root())?.content || '(빈 항목)');
  /** 지금 화면 아래 하위가 있는 항목을 모두 접기 · 펼치기 (collapse · expand) */
  async function setAllCollapsed(collapse) {
    const ops = [];
    for (const n of descendants()) if (kids(n.id).length && !!n.collapsed !== collapse) ops.push({ id: n.id, collapsed: collapse ? 1 : 0 });
    if (ops.length) await api.nodes.bulk(ops);
    await api.view.refresh();
    api.ui.toast(`${ops.length}개 ${collapse ? '접었어요' : '펼쳤어요'}`, 1.5);
  }
  return { kids, root, descendants, scope, picked, ancestorsUpTo, expandOps, label, tagsOf, setAllCollapsed };
}
