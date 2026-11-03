// 플러그인 API — 앱과 플러그인이 만나는 단 하나의 다리예요.
// 플러그인(plugins/*.js)은 이 api 객체만 받아 써요: 앱 안쪽 파일(/app.js · /dialog.js · /lib.js …)을 가져오거나 서버 주소(/api/…)를 직접 부르지 않아요.
// (바깥 서비스 — Dropbox API 같은 — 는 플러그인이 직접 fetch해도 돼요. 앱 서버만 api로)
// 플러그인은 사용자가 부를 때만 실행돼요 — 단축키 · ⌘/ 명령 목록 · 선택 막대 · 글자 메뉴. 앱이 그리거나 고칠 때 끼어드는 길은 없어요.
//
//   api.commands  명령 등록 · 실행 · 목록 · 단축키 · 선택 막대 · 글자 메뉴 설정
//   api.nodes     항목 읽기 · 만들기 · 고치기 · 옮기기 · 검색
//   api.view      화면: 지금 화면 · 커서 · 선택 · 들어가기 · 펼쳐 보이기 · 강조 · 다시 그리기
//   api.text      글자 칸: 감싸기 · 제목 단계 · 형광펜 (서식 명령)
//   api.files     첨부: 올리기 · 넣기 · 고르기 · 내려받기 · 목록 · 지우기 · 파일 보기(PDF · 북마크 · 재생)
//   api.export    내보내기: 형식별 받기 · 인쇄용 문서 · 인쇄 · 서버 PDF
//   api.backup    바깥 저장소와 맞추기: DB 사본 · 받은 사본으로 바꾸기 · 3-way 합치기 (저장소 접속은 플러그인이)
//   api.ui        플러그인 UI 부품 (플러그인에 HTML · CSS 없이): sheet + VStack · Text · Button …(view.js — 코드로 화면 짜기) · form(칸 · 미리 보기) · choose · ask · confirmDelete · prompt · toast · 입력 기록
//   api.md        글 읽기 규칙: 마크다운 조각 · 검색어 · 강조 조각
//   api.mobile    모바일 보조 키 배치
//   api.storage   이 플러그인의 저장 칸 (DB) · api.store(이름): 여러 플러그인이 같이 쓰는 칸 ('core'는 앱 것이라 안 돼요)
//   api.vendor(경로)  앱이 같이 싣고 있는 외부 라이브러리 (src/static/vendor/…)
import { core } from './app.js';
import { http, postForm, state, toast } from './base.js';
import * as uiKit from './ui.js';
import { pdfPreview } from './pdfpreview.js';
import { assignShortcut, copyNodeUrl, fmtCombo, inSelBar, inTagMenu, inTextBar, keyOfCommand, openHit, openInPlace, pal, paletteCommands, restoreFocusAfterPalette, runCommandNow, setHighlight, setSelBar, setTagMenu, setTextBar } from './commands.js';
import { CORE_KEYS } from './cmdlist.js';
import { pickAttachFiles, placeTokens } from './attach.js';
import { downloadAttachments, openMarkFinder } from './marks.js';
import { playUnder } from './media.js';
import { notePdf, pdfText } from './pdf.js';
import { mobileCfg } from './mobile.js';
import { buildPdfHtml, hlDark, mdSegments, parseQuery, PDF_DEFAULTS, splitHighlight, splitHighlightRegex } from './lib.js';

const cursorId = () => pal.prevId ?? state.focusId; // 명령을 실행하기 직전에 커서가 있던 항목
const q = (o) => Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== false).map(([k, v]) => `${k}=${encodeURIComponent(v === true ? 1 : v)}`).join('&');

const commands = {
  /** 명령 등록: [{ name, label, keys?, selection?, selectionMin?, text?, tag?, run(...args) }] — ⌘/ 명령 목록에 나타나요
   *  tag = true면 글 속 태그를 누를 때 불러요 (여럿이면 명령 이름으로 고르는 메뉴) — 누른 태그가 run의 첫 인자
   *  keys = 기본 단축키 ('Alt+C' — Mac ⌃C) · selection = 항목을 고르면 선택 막대에 뜰 단추 글 (selectionMin개 이상, 기본 1)
   *  text = 글자를 고르면 뜨는 글자 메뉴의 단추 { label, title, style, group, order, active(ctx), hidden(ctx), render(ctx), marks } (app.js fmtBar) */
  add(list) { for (const c of list) paletteCommands.set(c.name, { label: '', ...c }); },
  run: (name, ...args) => { const c = paletteCommands.get(name); if (c) return runCommandNow(c, ...args); }, // 다른 명령 실행 (args는 그 명령에게)
  /** 모든 명령과 지금 단축키: { core: 앱 자체 키 [{ text, keys }], commands: [{ name, label, keys, bar, text }] } */
  list: () => ({
    core: CORE_KEYS.map(([text, win, mac]) => ({ text, keys: core.isMac ? mac : win })),
    commands: [...paletteCommands.values()].sort((a, b) => a.name.localeCompare(b.name)).map((c) => ({ name: c.name, label: c.label || '', keys: keyOfCommand(c.name) ? fmtCombo(keyOfCommand(c.name)) : '', bar: inSelBar(c), text: inTextBar(c), tag: inTagMenu(c) })),
  }),
  openList: () => core.openCmds(),                                                       // ⌘/ 명령 목록
  assignShortcut: (name) => { const c = paletteCommands.get(name); return c ? assignShortcut(c) : Promise.resolve(); }, // 단축키 지정 창 (닫히면 끝나요)
  setSelectionBar: async (name, on) => { await setSelBar(name, on); core.paintSel(); },  // 선택 막대에 띄울지
  setTextMenu: async (name, on) => { await setTextBar(name, on); core.fmtBar.update(); }, // 글자 메뉴에 띄울지
  setTagMenu: (name, on) => setTagMenu(name, on),                // 태그를 누르면 부를지
};

const nodes = {
  get: (id) => state.nodes.get(id),
  loaded: () => [...state.nodes.values()],                       // 지금까지 불러온 항목들만 (전체가 아니에요) — 전체 하위가 필요하면 먼저 loadSubtree()
  children: (id) => core.kidNodes(id),                           // 불러온 자식들을 순서대로. 안 불러왔으면 [] — 순서는 이 배열이에요 (node.position은 믿지 마세요)
  loadSubtree: (id = state.zoom) => core.loadSubtree(id),        // id 아래 모든 하위 항목을 불러와요 → { count, truncated }
  create: (parent_id, position, content = '') => core.create(parent_id, position, content), // position은 '몇 번째' → 새 id. 만든 뒤 view.refresh()
  update: (id, changes) => core.updateNode(id, changes),         // { content?, collapsed? } — 바로 저장하고 그 줄을 다시 그려요
  bulk: (ops) => http('/api/bulk', 'POST', { ops }),             // [{ id, content?, collapsed?, parent_id?, position?, delete? }] — 끝나면 view.refresh()
  reorder: (parent_id, ids) => http('/api/reorder', 'POST', { parent_id, ids }),
  move: (ids, parent_id, pos = {}) => core.moveNodes(ids, parent_id, pos, null), // pos: { before } | { after } | {} (맨 끝) — ⌘Z로 되돌려요
  duplicate: (id) => core.duplicateNode(id),                     // 하위까지 복제
  importItems: (parent_id, position, items) => http('/api/import', 'POST', { parent_id, position, items }), // [{ content, children? }]
  /** 검색 → { results: [{ id, parent_id, content, path }], more, error? } — 공백 = AND · "구절" · -제외 · #태그는 그 태그만
   *  scope: 그 항목 하위에서만 · regex: 정규식 하나로(대소문자 무시) · after: 이 id 다음부터 이어 받기 */
  search: (text, { scope = null, limit = 100, regex = false, after = null } = {}) => http(`/api/search?${q({ q: text, limit, scope, regex, after })}`),
};

const view = {
  zoomId: () => state.zoom,                                      // 지금 들어와 있는 항목 (홈이면 null)
  cursorId,                                                      // 명령을 실행하기 직전에 커서가 있던 항목 ('이 항목')
  selection: () => core.visibleIds().filter((id) => state.sel.has(id)), // 고른 항목 전부 (화면 순서)
  select(ids) { state.sel = new Set(ids); state.anchor = ids[0] ?? null; state.head = ids.at(-1) ?? null; core.leaveText(); core.paintSel(); },
  zoomTo: (id, { focusFirst = false } = {}) => { if (focusFirst) state.focusFirst = true; return core.zoomTo(id); }, // 그 항목 안으로
  goTo: (hit) => openHit(hit),                                   // 그 항목이 있는 화면으로 가서 커서 (hit = { id, parent_id })
  reveal: (hit) => openInPlace(hit),                             // 화면은 그대로, 그 항목까지 펼쳐 보이고 커서 (hit = { id, parent_id, path })
  focus(id, pos = 'end') { state.focusId = id; state.focusPos = pos; core.afterDraw(); },
  highlight: (ids, opts) => setHighlight(ids, opts),             // 찾은 항목 강조 + 첫 항목으로 (refresh() 뒤에) — 클릭 · 키 입력이면 저절로 꺼져요, highlight([])로 끄기
  refresh: () => core.refresh(),                                 // 서버에서 지금 화면을 다시 받아 그려요
  flush: () => core.flushAll(),                                  // 아직 저장 안 된 입력을 서버에 다 보낼 때까지
  clearUndo: () => core.undoClear(),                             // 항목을 크게 바꾼 뒤(되돌리기 기록과 어긋날 때)
  restoreFocus: () => restoreFocusAfterPalette(),                // 플러그인이 띄운 창을 닫은 뒤 커서를 원래 자리로
  copyUrl: (id) => copyNodeUrl(id),                              // 그 항목 주소를 클립보드에 (다른 브라우저에서 바로 열려요)
};

/** 다룰 글자 칸: 글자 메뉴가 떠 있는 칸 → 고른 글자 · 커서가 있는 칸 → 명령을 부를 때 커서가 있던 항목의 칸(제목 포함 — ⌘/처럼 창을 띄웠다 부르면 커서가 풀려요)
 *  edit: 고칠 거면 그 칸에 커서를 둬요 (글 바꾸기는 커서가 있어야 돼요) */
const textEl = (edit = false) => {
  let el = core.fmtBar.textEl();
  if (!el) { const id = cursorId(); el = id != null ? core.textElOf(id) : null; }
  if (el && edit && document.activeElement !== el) el.focus({ preventScroll: true });
  return el;
};
const text = { // 글자 메뉴가 떠 있는 칸, 아니면 글자를 고른 · 커서가 있는 칸 — 칸이 없으면 false · null. 바꾸기는 평소 입력처럼(⌘Z) 저장돼요
  picked: () => pal.picked,                                      // 명령을 부를 때 고른 글자 ('' 없음) — run의 첫 인자로도 와요
  current() { const el = textEl(); if (!el) return null; const o = core.selOffsets(el); return { id: el.id === 'title' ? state.zoom : +el.dataset.id, title: el.id === 'title', text: el.textContent, start: o?.start ?? null, end: o?.end ?? null }; },
  wrap(mk) { const el = textEl(true); if (!el) return false; core.applyMd(el, mk); core.fmtBar.update(); return true; },   // mk(** * ` ~~)로 감싸기 · 풀기
  wrapped(mk) { const el = textEl(), o = el && core.selOffsets(el); return !!o && core.mdWrapped(el.textContent, o.start, o.end, mk); },
  heading(n) { const el = textEl(true); if (!el) return false; core.applyHeading(el, n); core.fmtBar.update(); return true; }, // 제목(들어와 있는 항목) 칸도 같아요 · 같은 단계면 떼요
  level() { const el = textEl(); return el ? core.headingOf(el) : -1; },                                                  // -1: 글자 칸이 없어요
  highlight() { const el = textEl(), st = el && core.fmtBar.hlTarget(el); return st ? { color: st.color } : null; },   // color: 헥스 6자리 · null(안 칠함)
  /** 지금 쓰던 자리를 기억 → { insert(글) } | null (글 칸에서 쓰던 중이 아니면 null). 창을 띄웠다 닫은 뒤에도 그 자리에 넣어요 (⌘Z 돼요) */
  caret() {
    const el = document.activeElement, sel = getSelection();
    if (!el?.isContentEditable || !el.matches('#tree .text, #title') || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0).cloneRange();
    return { insert(t, { space = true } = {}) {
      if (!el.isConnected) return false;
      el.focus({ preventScroll: true }); sel.removeAllRanges(); sel.addRange(range);
      const before = range.startContainer.textContent?.[range.startOffset - 1] ?? '';
      document.execCommand('insertText', false, (space && before && !/\s/.test(before) ? ' ' : '') + t); // 앞 글자와 붙지 않게 띄어 써요
      return true;
    } };
  },
  setHighlight(color) { const el = textEl(true), st = el && core.fmtBar.hlTarget(el); if (!st) return false; core.hlSet(el, st, color); core.fmtBar.clearTarget(); core.fmtBar.update(); return true; }, // null이면 지우기
};

const files = {
  /** 파일 하나 올리기 → { name, url, markdown } (markdown = 글에 넣는 첨부 표시) */
  async upload(blob, name) { const fd = new FormData(); fd.append('file', blob, name); const r = await postForm('/api/upload', fd); if (r.error) throw new Error(r.error); return r; },
  insert: (tokens, target = cursorId()) => placeTokens(tokens, target), // 첨부 표시들을 그 항목(기본: 커서 항목) 아래에 새 항목으로 → 넣은 개수
  pick: (target = cursorId()) => pickAttachFiles(target),        // 파일 고르는 창 → 종류를 보고 첨부 · 항목 · 백업으로 (끌어놓기와 같아요)
  download: (names) => downloadAttachments(names),               // 저장 이름들 → 내려받기 (북마크는 파일 안에 담아서, 여럿이면 ZIP)
  list: () => http('/api/attachments'),                          // { files: [{ name, size, ref_count, ink_base, … }], dir }
  refs: (name) => http(`/api/attachments/refs?${q({ name })}`),  // 그 파일을 쓰는 항목들 { refs: [...] }
  remove: (opts) => http('/api/attachments/delete', 'POST', opts), // { names, force } | { orphans: true }
  revealFolder: () => http('/api/attachments/reveal', 'POST', {}), // 첨부 폴더를 파일 관리자로 열기
  blob: (name) => fetch(`/files/${encodeURIComponent(name)}`).then((r) => { if (!r.ok) throw new Error(`첨부 ${name}: ${r.status}`); return r.blob(); }), // 저장 이름 → 파일 내용
  restore: (name, blob) => fetch(`/api/attachments/raw/${encodeURIComponent(name)}`, { method: 'PUT', body: blob }).then((r) => r.json()), // 다른 기기에서 받은 첨부를 그 이름 그대로 → { added } | { error }
  async openPdf(url, { edit = false } = {}) {                    // 화면에 있는 그 PDF를 화면 가득으로 (edit: 바로 편집 · 펜)
    let card = null;
    for (let i = 0; i < 40 && !(card = document.querySelector(`.att-pdf[data-url="${CSS.escape(url)}"]`)); i++) await new Promise((r) => setTimeout(r, 50));
    if (!card) return toast('그 PDF를 화면에서 찾지 못했어요');
    card.scrollIntoView({ block: 'nearest' });
    if (edit) await card._openEdit?.();
  },
  notePdf: (opts) => notePdf(opts),
  pdfText: (url) => pdfText(url),                                // PDF의 쪽마다 글 → Promise<['1쪽 글', …]> (한 번 읽은 파일은 기억해요 · 그림만 있는 쪽은 '')
  showPdf: (url, opts) => core.showPdf(url, opts),               // 그 PDF가 든 항목(node) 안으로 가서 page쪽부터 find를 찾아 칠해요 — { node, page, find, regex, nth: 그 쪽에서 몇 번째 결과(0부터) }                              // 빈 노트 PDF 바이트 ({ paper, size, pages })
  findBookmarks: (text = '') => setTimeout(() => openMarkFinder(typeof text === 'string' ? text : '')), // 모든 파일의 북마크 찾기 창 (text: 처음 찾을 글자)
  playUnder: (shuffle = false) => playUnder(shuffle),            // 커서 항목(없으면 지금 화면) 아래 오디오 · 영상 이어 재생
};

const exporter = {
  /** 범위: 고른 항목 → 지금 화면 → 전체 { ids, selected(고른 항목인지), label } */
  scope() { const ids = state.sel.size ? core.topSelected() : state.zoom !== null ? [state.zoom] : []; return { ids, selected: !!state.sel.size, label: state.sel.size ? `선택한 항목 ${ids.length}개` : state.zoom !== null ? `지금 화면 (${state.nodes.get(state.zoom)?.content || '빈 항목'})` : '전체' }; },
  /** 내려받기: 'md' · 'txt' · 'json' (범위) · 'all' 전체 백업 ZIP · 'db' DB만 */
  async download(fmt) { await core.flushAll(); const a = document.createElement('a'); a.href = core.exportUrl(fmt); a.click(); },
  json: async () => { await core.flushAll(); return http(core.exportUrl('json')); }, // 범위의 항목들 (하위 · 접힘 · 북마크까지)
  pdfDefaults: { ...PDF_DEFAULTS },
  pdfHtml: (items, opts) => buildPdfHtml(items, opts),           // 인쇄용 문서 HTML (용지 · 여백 · 글꼴 · 제목 단계 …)
  print: (html) => core.printHtml(html),                         // 인쇄 창 (대상을 'PDF로 저장'으로)
  printPdf: (html, name) => http('/api/print-pdf', 'POST', { html, name }), // 서버(크롬)가 PDF를 만들어 첨부로 저장 → { markdown, url } | { error }
  preview: (o) => pdfPreview(o),                                 // PDF 미리 보기 뷰 (쪽 나눔대로 종이처럼) — { html: () => Promise<pdfHtml>, opts, onInfo(글) } → ui.sheet 안에 넣어요
};

/** 바깥 저장소와 맞추기 — 저장소(Dropbox …)는 플러그인이 맡고, 앱은 사본 · 변경분 · 다시 만들기 · 3-way 합치기 · 바꾸기만 해요. key: 저장소 이름 ('dropbox' …, 영문 소문자)
 *  주고받는 blob은 모두 gzip — 사본(snapshot)은 DB 파일, 변경분(changes)은 '마지막으로 맞춘 판 → 지금'의 바뀐 항목만 (몇 글자 고치면 몇 KB)
 *  status(key) → { synced: 마지막으로 맞춘 저장소 버전 | null, changed: 그 뒤 이 기기에서 바뀌었는지, base: 맞춘 판이 있는지 }
 *  올리기(저장소는 그대로): changes(key) → { token, count, blob } → 저장소에 올림 → commit(key, token, 새 버전)
 *  처음 · 덮어쓰기: snapshot(key) → { token, blob } → 올림 → commit(key, token, 새 버전) · snapshot(key, { of: 'base' }) — 맞춘 판 사본 (저장소 정리용, commit 없음)
 *  받기: build(key, { snapshot?, changes: [blob…] }) → { token, count } (snapshot이 없으면 맞춘 판에서 시작) → commit(key, token, 버전, { apply: true })
 *  양쪽 다 바뀜: build(…) → merge(key, token) → { token, count, blob(저장소 판 → 합친 판 변경분), added, updated, deleted, moved, conflicts } → 올림 → commit(…, { apply: true })
 *  apply는 이 DB를 그 판으로 — 다른 곳만 고치고(아주 많으면 통째로, 먼저 <DB>-before-remote-*.db로 백업 · 최근 3개), 열린 화면은 새로고침돼요 (그래서 맨 끝에)
 *  backup: true면 고치기만 할 때도 먼저 백업 (이 기기의 맞추지 않은 글을 버리고 저장소 판으로 바꿀 때)
 *  저장소 판의 항목 번호를 모든 기기가 같이 써요 (합칠 때 저장소 판에 이 기기 변경을 얹어요) */
const remote = (key, path = '') => `/api/remote/${encodeURIComponent(key)}${path}`;
const blobOf = async (key, token) => { const r = await fetch(remote(key, `/pending/${token}`)); if (!r.ok) throw new Error(`사본을 받지 못했어요 (${r.status})`); return r.blob(); };
const must = (r) => { if (r.error) throw new Error(r.error); return r; };
const backup = {
  status: (key) => http(remote(key)),
  async snapshot(key, { of = 'live' } = {}) { if (of === 'live') await core.flushAll(); const r = must(await http(remote(key, '/snapshot'), 'POST', { of })); return { ...r, blob: await blobOf(key, r.token) }; },
  async changes(key) { await core.flushAll(); const r = must(await http(remote(key, '/changes'), 'POST', {})); return { ...r, blob: await blobOf(key, r.token) }; },
  async build(key, { snapshot = null, changes = [] } = {}) {
    const fd = new FormData();
    if (snapshot) fd.append('snapshot', snapshot, 'snapshot.db.gz');
    changes.forEach((b, i) => fd.append('changes', b, `${i}.jsonl.gz`));
    return must(await postForm(remote(key, '/build'), fd));
  },
  async merge(key, token) { await core.flushAll(); const r = must(await http(remote(key, '/merge'), 'POST', { token })); return { ...r, blob: await blobOf(key, r.token) }; },
  async commit(key, token, id, { apply = false, backup = false } = {}) { if (apply) await core.flushAll(); return must(await http(remote(key, '/commit'), 'POST', { token, id, apply, backup })); },
};

const ui = { ...uiKit }; // 플러그인 UI 부품 — 모든 플러그인이 같은 창 · 알림 · 입력 칸 모양을 써요 (ui.js · style.css '플러그인 UI 부품')

const md = {
  segments: (s) => mdSegments(s),                                // 글 → { block, segs: [{ t, k }] } | null (화면이 그릴 때와 같은 규칙)
  parseQuery: (s) => parseQuery(s),                              // 검색어 → { pos, neg, exact … }
  splitHighlight: (t, terms, exact) => splitHighlight(t, terms, exact), // 찾은 낱말 강조 조각 [{ t, hit }]
  splitHighlightRegex: (t, re) => splitHighlightRegex(t, re),
  dark: (hex) => hlDark(hex),                                    // 어두운 색인가 (형광펜 글자색)
};

const mobile = {
  layout: () => mobileCfg.get(),                                 // 지금 배치 (Termux extra-keys 형식)
  setLayout: (next) => mobileCfg.set(next),                      // 배치 바꾸기 (null = 기본값) → 맞지 않으면 오류 글
  keyNames: () => mobileCfg.keyNames(),
};

const storeOf = (ns) => {
  if (!ns || ns === 'core') throw new Error("'core' 칸은 앱 것이에요");
  const url = (k) => `/api/plugin-data/${encodeURIComponent(ns)}/${encodeURIComponent(k)}`;
  return { get: (k) => http(url(k)).then((r) => r.value), set: (k, v) => http(url(k), 'PUT', { value: v }) };
};

const shared = Object.freeze({
  commands: Object.freeze(commands), nodes: Object.freeze(nodes), view: Object.freeze(view), text: Object.freeze(text), files: Object.freeze(files),
  export: Object.freeze(exporter), backup: Object.freeze(backup), ui: Object.freeze(ui), md: Object.freeze(md), mobile: Object.freeze(mobile),
  store: storeOf,
  vendor: (path) => import(`/vendor/${path}`),                   // 예: api.vendor('lamejs/lamejs.js')
});

/** 플러그인 하나에 줄 api (storage만 플러그인마다 달라요) */
export function apiFor(pluginId) {
  return Object.freeze({ ...shared, storage: storeOf(pluginId) });
}
