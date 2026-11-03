// 옮기기 (move) — 고른 항목들(없으면 커서 항목)을 다른 항목 아래 맨 끝으로 보내요. 화면 밖 먼 곳으로도.
// 창에서 보낼 곳을 찾아 고르면 돼요 (전체 검색 · 홈 · 최근에 보낸 곳). 자기 자신이나 자기 하위로는 보낼 수 없어요.
// 되돌리기(⌘Z · Ctrl+Z)로 원래 자리로 돌아와요.
import { command } from './_kit.js';

const HOME = { id: null, content: '', label: '홈', path: [] };
const short = (s, n = 80) => { s = String(s ?? '').replace(/\s+/g, ' ').trim() || '(빈 항목)'; return s.length > n ? `${s.slice(0, n)}…` : s; };

/** 옮길 항목: 고른 것 중 맨 위 것들(조상이 같이 골라졌으면 빼요), 없으면 커서 항목 (제목 포함) */
function moving(api) {
  const sel = api.view.selection(), inSel = new Set(sel);
  const tops = sel.filter((id) => { for (let p = api.nodes.get(id)?.parent_id; p != null; p = api.nodes.get(p)?.parent_id) if (inSel.has(p)) return false; return true; });
  if (tops.length) return tops;
  const c = api.view.cursorId();
  return c != null ? [c] : []; // 제목(들어와 있는 항목)에 커서가 있으면 그 항목 — 다른 항목과 같아요
}

async function move(api, ui, picked = '') { // picked: 부를 때 고른 글자 → 보낼 곳 찾기 칸에 미리
  const ids = moving(api);
  if (!ids.length) return ui.toast('옮길 항목에 커서를 두거나 항목을 고르세요', 3, true);
  const skip = new Set(ids);
  const okDest = (r) => !skip.has(r.id) && !(r.path || []).some((p) => skip.has(p.id)) && r.id !== api.nodes.get(ids[0])?.parent_id;
  const recent = ((await api.storage.get('recent').catch(() => null)) || []).filter((r) => r && okDest(r));
  const what = ids.length > 1 ? `${ids.length}개 항목` : `"${short(api.nodes.get(ids[0])?.content, 30)}"`;

  // 보낼 곳 고르기 — 다른 '치고 고르는 창'(jump · find · verse)과 같은 모양 (api.ui.prompt의 source)
  const row = (r) => ({ v: r, label: r.label ?? short(r.content), sub: r.path?.length ? r.path.map((p) => short(p.content, 24)).join(' › ') : '' });
  const dest = await ui.prompt(`${what} 보낼 곳`, [], {
    value: typeof picked === 'string' ? picked : '',
    source: async (q) => {
      if (!q.trim()) { // 빈 칸: 홈 · 지금 화면 · 최근에 보낸 곳
        const z = api.view.zoomId(), here = z === null ? [] : [{ id: z, content: api.nodes.get(z)?.content ?? '', label: `${short(api.nodes.get(z)?.content, 40)} (지금 화면)`, path: [] }];
        return [...[HOME, ...here].filter(okDest), ...recent].map(row);
      }
      const r = await api.nodes.search(q, { limit: 40 }).catch(() => ({ results: [] }));
      return (r.results || []).filter(okDest).map(row);
    },
  });
  if (!dest || typeof dest !== 'object') return;
  await api.view.flush();
  const ok = await api.nodes.move(ids, dest.id, {});
  if (ok === false) return;
  if (dest.id !== null) api.storage.set('recent', [{ id: dest.id, content: dest.content, path: dest.path || [] }, ...recent.filter((r) => r.id !== dest.id)].slice(0, 8)).catch(() => {});
  api.view.select([]);
  await api.view.refresh();
  ui.toast(`${what}을 ${dest.id === null ? '홈' : `"${short(dest.content, 30)}"`} 아래로 옮겼어요`, 2.5);
}

export default (api) => command(api, { name: 'move', label: '옮기기 (고른 항목 · 커서 항목을 찾아 고른 항목 아래로 — 멀리 있는 곳도)', keys: 'Alt+M', preload: false, selection: '옮기기', make: (api, ui) => ({ move: (t) => move(api, ui, t) }) });
