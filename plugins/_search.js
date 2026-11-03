// 검색 창 본체 — jump(전역 검색) · find(하위 검색)가 같이 써요. 범위만 달라요 (mode: 'global' | 'sub')
//   jump → 전체에서, 고르면 그 항목 안으로 (⌘+클릭 · ⌘Enter: 그 항목이 있는 화면으로)
//   find → 지금 화면 아래에서만, 고르면 이동 없이 그 항목까지 펼쳐요 (⌘+클릭: 그 항목 안으로)
// 검색어: 공백 = AND · "구절" · -제외 · #태그는 그 태그만. .* 단추로 정규식(대소문자 무시). ↑↓ · Enter · Esc 닫기
// 빈 칸이면 검색 기록: ★ 고정한 검색어 → 최근 검색어 (숫자 키 · Enter로 다시 찾기, ☆ · ⇧Enter로 고정). 고른 줄에서 ⌘C(또는 🔗) = 그 항목 주소 복사
// 부를 때 고른 글자(태그를 눌렀으면 그 태그)가 있으면 검색어로 바로 찾아요
import { command } from './_kit.js';
import { hitRow, hitText, searchPalette } from './_palette.js';

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

const MODE_NAME = { global: '전역 검색', sub: '하위 검색' };
const MODE_HOLD = { global: '찾기', sub: '이 화면에서 찾기' };
const NUM_KEYS = '1234567890';
const MAX_HITS = 5000; // 이보다 많이 쌓으면 화면이 무거워져서 여기서 멈추고 검색어를 좁히도록 안내해요
const stop = (e) => e.preventDefault(); // 단추를 눌러도 입력칸 커서를 빼앗지 않게

/** 검색 명령 하나 등록: { mode: 'global' | 'sub', name, label, hist(기록 칸), bookmarks(북마크 쓰기), keys, tag … }
 *  bookmarks: 결과 줄의 책갈피로 항목을 북마크 (이 명령의 저장 칸 'bookmarks') — 빈 칸으로 열면 북마크 → 검색 기록 순으로, 숫자 키로 바로 */
export default function makeSearch(api, { mode, name, label, hist, bookmarks = false, ...opts }) {
  const ui = api.ui, { VStack, Text, Button, IconButton } = ui;
  const HIST = hist; // 검색 기록 칸 (다른 명령의 입력 기록과 같은 모양 · 같은 ★ 고정)
  const { parseQuery, splitHighlight, splitHighlightRegex } = api.md; // 검색어 · 강조 규칙은 앱과 같게
  // 화면에 보이는 것은 창의 상태(s: q · regex · items · active · hist · info · more · loading), 나머지는 여기
  const pal = { token: 0, timer: null, seen: null, shownKey: null, inflight: null, opts: null, q: '', ms: 0, pendStep: 0, flushing: false };
  let view = null; // 열린 창 { s, set, close }
  const CLOSED = { q: '', regex: false, items: [], active: 0, hist: false, more: false, loading: false }; // 닫힌 뒤 늦게 온 이벤트(사라지는 중인 줄의 mousemove 등)용
  const S = () => view?.s ?? CLOSED, set = (p) => view?.set(p);

  // ---- 북마크 (bookmarks: true인 명령만 — jump) ----
  let marks = null; // [{ id, parent_id, content, path }] (넣은 순)
  const loadMarks = async () => (marks ??= ((await api.storage.get('bookmarks').catch(() => null)) || []).filter((m) => m && m.id != null));
  const isMarked = (id) => !!marks?.some((m) => m.id === id);
  async function toggleMark(h) {
    await loadMarks();
    marks = isMarked(h.id) ? marks.filter((m) => m.id !== h.id) : [...marks, { id: h.id, parent_id: h.parent_id, content: h.content, path: h.path || [] }];
    await api.storage.set('bookmarks', marks).catch(() => {});
    ui.toast(isMarked(h.id) ? '북마크에 넣었어요' : '북마크에서 뺐어요', 1.2);
    set({}); // 책갈피 모양 다시
  }

  /** text: 처음 검색어 (부를 때 고른 글자 · 누른 태그) — 열려 있으면 검색어만 바꿔요 */
  function open(text = '') {
    if (view) { if (text) { set({ q: text }); refresh(); } return; }
    ui.sheet({
      size: 'palette',
      state: { q: text, regex: false, items: [], active: 0, hist: false, info: '', more: false, loading: false },
      task: (s, st, close) => { view = { s, set: st, close }; refresh(); },
      onKey: (e) => onKey(e),
      body,
    }).then(() => { if (view) { forget(); api.view.restoreFocus(); } }); // 바깥을 눌러 닫았을 때
  }
  function forget() { view = null; pal.token++; pal.seen = null; pal.shownKey = null; pal.inflight = null; } // 다시 열면 그 사이 바뀐 내용으로 새로 찾아요
  function close() {
    if (!view) return;
    const c = view.close;
    forget(); c(null);
    api.view.restoreFocus();
  }

  /** 검색 결과 새로 받기. 같은 조건(모드 · 정규식 · 범위 · 검색어)의 결과가 이미 화면에 있거나 받는 중이면 다시 받지 않아요 —
   *  한글 조합이 끝날 때 늦게 오는 input 이벤트 등으로 같은 검색을 또 하면, ↑↓로 고른 항목이 첫 항목으로 되돌아갔어요 */
  function refresh() {
    if (!view) return Promise.resolve();
    const q = S().q;
    if (!q.trim()) { pal.shownKey = null; pal.inflight = null; return doRefresh(null); }
    const key = [mode, S().regex ? 1 : 0, mode === 'sub' ? api.view.zoomId() : '', q].join('\u0000');
    if (key === pal.shownKey && pal.seen === q) return Promise.resolve();
    if (pal.inflight?.key === key) return pal.inflight.p;
    const p = doRefresh(key);
    pal.inflight = { key, p };
    p.finally(() => { if (pal.inflight?.p === p) pal.inflight = null; });
    return p;
  }
  /** 강조 조각을 미리 만들어 둬요 (↑↓마다 다시 자르지 않게) */
  function withSegs(list, q, regex) {
    let segs;
    if (regex) { let re; try { re = new RegExp(q, 'i'); } catch { re = null; } segs = (t) => (re ? splitHighlightRegex(t, re) : [{ t, hit: false }]); }
    else { const { pos: terms, exact } = parseQuery(q); segs = (t) => splitHighlight(t, terms, exact); }
    return list.map((h) => ({ ...h, segs: segs(h.content || '(빈 항목)').map((x) => (x.hit ? { hit: x.t } : x.t)) }));
  }
  async function doRefresh(key) {
    const s = S(), q = s.q, regex = s.regex; // 이 요청이 답하는 입력 (늦게 도착했을 때 그 사이 더 친 글자와 헷갈리지 않게)
    const token = ++pal.token; // 이전 요청의 늦은 응답이 화면을 덮어쓰지 못하게
    set({ more: false, loading: false });
    if (!q.trim()) {
      pal.seen = null;
      set({ items: [], hist: false });
      const h = await ui.loadHistory(HIST).catch(() => ({ recent: [], favs: [] }));
      const bm = bookmarks ? (await loadMarks()).map((m) => ({ ...m, content: api.nodes.get(m.id)?.content ?? m.content, bm: true })) : []; // 북마크 먼저
      if (token !== pal.token) return;
      const k = (v) => JSON.stringify(v), pinned = new Set(h.favs.map(k));
      const items = [...h.favs.map((v) => ({ q: v.q, regex: !!v.regex, pin: true, v })), ...h.recent.filter((x) => !pinned.has(k(x.v))).map((x) => ({ q: x.v.q, regex: !!x.v.regex, t: x.t, v: x.v }))];
      if (items.length || bm.length) {
        pal.seen = q;
        return set({ hist: true, items: [...bm, ...items], active: 0, info: bm.length ? (items.length ? '북마크 · 검색 기록' : '북마크') : '검색 기록' });
      }
      return set({ info: '' });
    }
    const opts = { regex, scope: mode === 'sub' ? api.view.zoomId() : null };
    const t0 = performance.now();
    const r = await api.nodes.search(q, { ...opts, limit: 100 });
    if (token !== pal.token) return;
    pal.seen = q; pal.shownKey = key;
    if (r.error) return set({ items: [], hist: false, more: false, info: r.error });
    Object.assign(pal, { opts, q, ms: Math.round(performance.now() - t0) });
    set({ items: withSegs(r.results, q, regex), hist: false, active: 0, more: r.more, list: (S().list || 0) + 1 }); // 기록 → 결과는 한 번에 (줄 모양이 섞이지 않게) // list: 새 결과면 목록을 새로 (맨 위부터)
    updateInfo();
  }
  function updateInfo() {
    const s = S(), n = s.items.length;
    if (!n) return set({ info: '결과 없음' });
    const tail = s.more ? (n >= MAX_HITS ? ` · ${MAX_HITS}개까지만` : s.loading ? ' · 불러오는 중…' : '') : '';
    set({ info: `${n}${s.more ? '개 이상' : '개'}${tail}` });
  }
  /** 목록 끝에 가까워지면 다음 쪽을 이어 받아 붙여요 (id 순서 이어 받기라 몇 번째 쪽이든 첫 쪽과 같은 속도) */
  async function loadMore() {
    const s = S();
    if (!s.more || s.loading || s.items.length >= MAX_HITS) return;
    const token = pal.token, last = s.items.at(-1);
    set({ loading: true }); updateInfo();
    const t0 = performance.now();
    let r;
    try { r = await api.nodes.search(pal.q, { ...pal.opts, limit: 200, after: last.id }); } finally { if (view) set({ loading: false }); }
    if (!view || token !== pal.token || r.error) { if (view && token === pal.token) updateInfo(); return; }
    pal.ms += Math.round(performance.now() - t0);
    set({ items: S().items.concat(withSegs(r.results, pal.q, pal.opts.regex)), more: r.more });
    updateInfo();
  }
  const maybeMore = (l) => { if (S().more && !S().loading && l.scrollHeight - l.scrollTop - l.clientHeight < 240) loadMore(); }; // 끝에 가까우면 더 받아요

  // ---- 줄 ----
  const pathOf = (h) => ['홈', ...h.path.map((p) => p.content || '(빈 항목)')].slice(-4).join(' › ');
  const linkBtn = (id) => IconButton('link', (e) => { e.stopPropagation(); api.view.copyUrl(id); }, `주소 복사 (${isMac ? '⌘' : 'Ctrl+'}C) — 다른 브라우저에서 이 항목을 바로 열 수 있어요`)
    .revealOnHover().event('mousedown', stop).attr('data-f', 'hit-link'); // 줄 오른쪽의 🔗 — 누르면 그 항목 주소를 복사 (창은 그대로)
  const markBtn = (h, onTap = () => toggleMark(h)) => { // 책갈피 — 누르면 북마크 넣기 · 빼기 (창은 그대로). 북마크한 것은 채운 모양으로 늘 보여요
    const on = isMarked(h.id) || !!h.bm;
    const b = IconButton('bookmark', (e) => { e.stopPropagation(); onTap(); }, h.bm ? '북마크에서 빼기' : on ? '북마크에서 빼기 (⇧Enter)' : '북마크 (⇧Enter)', { filled: on })
      .event('mousedown', stop).attr('data-f', 'hit-mark').attr('data-on', on);
    return on ? b.color('ink') : b.revealOnHover();
  };
  const num = (i, s) => VStack({ align: 'center', justify: 'center' }, Text(i < 10 ? NUM_KEYS[i] : '').font('caption').bold().color(i === s.active ? 'inverse' : 'mute'))
    .frame({ width: 24, height: 24 }).radius('sm').background(i === s.active ? 'accent' : 'fill').css({ flex: 'none' });
  const row = (i, s, kind, ...kids) => hitRow(ui, { active: i === s.active, onTap: (e) => activate(i, e.ctrlKey || e.metaKey), onPoint: () => set({ active: i }), kind, key: `${kind}${i}` }, ...kids);
  function rowOf(h, i, s) {
    if (s.hist && h.bm) return row(i, s, 'bm', num(i, s), markBtn(h, () => drop(i)), // 북마크한 항목: 고르면 그 항목 안으로 · 책갈피로 빼기
      VStack({ gap: 1 }, Text(h.content || '(빈 항목)').wrap().attr('data-f', 'hit-text'), Text(pathOf(h)).font('caption').lines(1).attr('data-f', 'hit-path')).grow(),
      linkBtn(h.id)); // 주소 복사도 결과 줄과 같게
    if (s.hist) return row(i, s, 'hist', num(i, s), // 검색 기록: ★ 고정 · 다시 찾기 · ✕ 지우기
      Button(h.pin ? '★' : '☆', (e) => { e.stopPropagation(); pin(i); }).style('plain').tooltip(h.pin ? '고정 풀기' : '고정 (맨 위에)').event('mousedown', stop).attr('data-f', 'star').attr('data-on', !!h.pin),
      VStack({ gap: 1 }, Text(h.regex ? `/${h.q}/` : h.q).wrap().attr('data-f', 'hit-text'), Text(h.pin ? '고정' : h.t ? ui.ago(h.t) : '').font('caption')).grow(),
      Button('✕', (e) => { e.stopPropagation(); drop(i); }).style('plain').revealOnHover().tooltip('기록에서 지우기 (⇧Delete · ⌘⌫)').label('기록에서 지우기').event('mousedown', stop).attr('data-f', 'del'));
    return row(i, s, 'hit', hitText(ui, pathOf(h), h.segs), bookmarks && markBtn(h), linkBtn(h.id));
  }
  function body(s, st) {
    return searchPalette(ui, {
      q: s.q, placeholder: MODE_HOLD[mode], label: MODE_NAME[mode],
      onType: (v) => { st({ q: v }); clearTimeout(pal.timer); pal.timer = setTimeout(refresh, 140); },
      regex: s.regex, onRegex: (v) => { st({ regex: v }); refresh(); },
      field: (f) => f.event('copy', (e) => { // ⌘C가 keydown 없이 '복사'로만 들어오는 환경용 — 글자를 고르지 않았으면 고른 결과의 주소를 복사
        const h = e.target.selectionStart === e.target.selectionEnd && pal.seen === S().q && S().items[S().active];
        if (!h || h.id == null) return;
        e.preventDefault(); e.clipboardData.setData('text/plain', `${location.origin}/#${h.id}`); ui.toast('주소를 복사했어요');
      }),
      info: s.info, items: s.items, row: (h, i) => rowOf(h, i, s), listKey: `list${s.hist ? 'h' : s.list}`, onScroll: maybeMore,
    });
  }

  async function drop(i) { // 기록 한 줄 지우기 (api.ui.forget) · 북마크면 북마크에서 빼기
    const h = S().items[i]; if (!h) return;
    if (h.bm) await toggleMark(h); else await ui.forget(HIST, h.v);
    refresh();
  }
  async function pin(i) { const h = S().items[i]; if (!h || h.bm) return; await ui.toggleFavValue(HIST, h.v); refresh(); }
  /** 기록 고르기 → 그 검색어(정규식이면 정규식 켜고)로 다시 찾기 */
  function useHist(h) { set({ q: h.q, regex: !!h.regex }); refresh(); }
  async function activate(i, zoomIn = false) {
    const item = S().items[i];
    if (!item) return;
    if (item.bm && S().hist) { close(); return zoomIn ? api.view.goTo(item) : api.view.zoomTo(item.id, { focusFirst: true }); } // 북마크: 그 항목 안으로
    if (S().hist) return useHist(item); // 기록이면 그 검색어로 다시 찾아요
    if (pal.q.trim()) ui.remember(HIST, { q: pal.q, ...(pal.opts?.regex ? { regex: true } : {}) }); // 결과를 고른 검색어는 기록에
    close();
    if (mode === 'global') return zoomIn ? api.view.goTo(item) : api.view.zoomTo(item.id, { focusFirst: true }); // 전역: 찾은 항목 안으로 (첫 자식에 커서) · ⌘+클릭은 그 항목이 있는 화면으로
    return zoomIn ? api.view.zoomTo(item.id) : api.view.reveal(item); // 하위: 이동 없이 그 항목까지 펼쳐 보이기 · ⌘+클릭은 그 항목 안으로
  }
  /** ↑↓를 눌렀는데 화면의 결과가 아직 지금 입력 기준이 아니면, 결과를 먼저 받고 누른 만큼 옮겨요
   *  (그냥 옮기면 곧 도착한 결과가 첫 항목으로 되돌려 놓아서, 첫 ↓가 무시된 것처럼 보였어요) */
  function stepAfterRefresh(d) {
    pal.pendStep += d;
    if (pal.flushing) return;
    pal.flushing = true;
    clearTimeout(pal.timer);
    refresh().finally(() => {
      const k = pal.pendStep; pal.flushing = false; pal.pendStep = 0;
      if (view && pal.seen === S().q && S().items.length) set({ active: Math.max(0, Math.min(S().items.length - 1, S().active + k)) });
    });
  }
  /** 키 (창이 받아요) → 받았으면 true */
  function onKey(e) {
    if (!view || e.isComposing || e.keyCode === 229) return false; // 한글 조합 중 ↑↓는 조합을 끝내는 데 쓰이고, 끝난 뒤 보통 ↑↓가 한 번 더 들어와요 (그쪽에서 옮겨요)
    const s = S(), n = s.items.length, mod = e.ctrlKey || e.metaKey, input = e.target;
    const handled = () => { e.preventDefault(); e.stopPropagation(); return true; };
    if (e.key === 'Escape') { handled(); close(); return true; }
    const dg = /^Digit([0-9])$/.exec(e.code || '');
    if (s.hist && dg && !mod && !e.shiftKey && !e.altKey && s.q === '') { // 기록 번호 (1~9, 0=10번째)
      const i = (+dg[1] + 9) % 10;
      if (i < n) { handled(); activate(i); return true; }
    }
    if (e.code === 'KeyC' && mod && !e.shiftKey && !e.altKey && input.selectionStart === input.selectionEnd && s.items[s.active]?.id != null) { // 항목 줄(결과 · 북마크)에서만 — 글자를 고르지 않았으면 ⌘C = 고른 결과의 주소 복사
      handled();
      if (pal.seen === s.q) api.view.copyUrl(s.items[s.active].id);
      return true;
    }
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && pal.seen !== s.q && s.q.trim()) { handled(); stepAfterRefresh(e.key === 'ArrowDown' ? 1 : -1); return true; } // 방금 친 글자의 결과가 아직 안 왔어요
    if (e.key === 'ArrowDown' && n) {
      handled();
      if (s.active >= n - 1 && s.more) loadMore().then(() => { if (view && S().items.length > n) set({ active: n }); }); // 맨 끝에서 ↓ 를 누르면 다음 쪽을 받아 이어서 내려가요
      else set({ active: Math.min(n - 1, s.active + 1) });
      return true;
    }
    if (e.key === 'ArrowUp' && n) { handled(); set({ active: Math.max(0, s.active - 1) }); return true; }
    if (e.key === 'Enter' && e.shiftKey && s.hist) { handled(); pin(s.active); return true; } // ⇧Enter: 기록 고정 · 풀기
    if (e.key === 'Enter' && e.shiftKey && bookmarks && s.items[s.active]) { handled(); toggleMark(s.items[s.active]); return true; } // ⇧Enter: 결과를 북마크
    if (s.hist && n && ((e.key === 'Delete' && e.shiftKey) || (e.key === 'Backspace' && mod && !s.q))) { handled(); drop(s.active); return true; } // ⇧Delete · ⌘⌫: 기록 지우기
    if (e.key === 'Tab') { e.preventDefault(); return true; } // 포커스가 입력칸을 벗어나지 않게
    if (e.key === 'Enter') {
      handled();
      clearTimeout(pal.timer);
      (async () => {
        if (pal.seen !== S().q) await refresh(); // 아직 이전 입력의 결과면 새로 찾은 뒤에 실행
        if (view) activate(S().active, mod);
      })();
      return true;
    }
    return false;
  }

  command(api, {
    name, label, preload: false, ...opts,
    make: () => ({ [name]: (text) => open(typeof text === 'string' ? text : '') }),
  });
}
