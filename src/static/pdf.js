// PDF: PDF.js로 보기 · 화면 가득 · 확대 · 북마크 · 편집(펜 · 형광펜 · 글자 · 메모 · 쪽 정리) · 노트 PDF

import { CLIENT_ID, http, mk, state, toast } from './base.js';
import { progress } from './progress.js';
import { flushAll, refresh, updateNode } from './app.js';
import { askChoice, askText, confirmDelete, modalOpen } from './dialog.js';
import { addMark, copyMarks, nearPolyline, PDF_ICON, pdfIconBtn, pdfLib, pdfMarks, PEN, penPick, penStyle, rgbCss, simplifyPts, smoothSegs, svgPathD } from './markup.js';
import { mediaPos, mediaPosReady, saveMediaPos } from './media.js';
import { copyMarkLink, downloadAttachment, markHref, markList } from './marks.js';

// PDF: PDF.js(static/vendor/pdfjs)로 이 화면 안에서 바로 보여줘요. 기본으로 펼쳐져 있고, 마지막으로 보던 페이지에서 열려요.
// 접어 둔 PDF는 DB(plugin_data 'core' pdf_folded)에 기억해서 다시 열어도 · 다른 창 · 브라우저에서도 접힌 채로 보여요 (접힌 PDF는 불러오지도 않아요)
const pdfFolded = new Set();
const pdfFoldReady = http('/api/plugin-data/core/pdf_folded').then((r) => { for (const u of Array.isArray(r.value) ? r.value : []) pdfFolded.add(u); }).catch(() => {});
function savePdfFold(url, folded) {
  if (folded) pdfFolded.add(url); else pdfFolded.delete(url);
  http('/api/plugin-data/core/pdf_folded', 'PUT', { value: [...pdfFolded] }).catch((e) => toast(`접힘 상태를 저장하지 못했어요: ${e.message}`, 4000));
}
let pdfjsP = null;
const pdfDocs = new Map();
const PDFJS = '/vendor/pdfjs/';
const pdfProg = new Map(); // 파일 주소 → 받는 중 진행을 들을 함수들 (같은 PDF를 여러 카드가 열 때)
/** PDF 열기 (같은 파일은 한 번만 받아요). onProgress(받은 바이트, 전체) — 큰 파일을 받는 동안 */
const pdfjs = () => (pdfjsP ??= import(PDFJS + 'pdf.mjs').then((m) => { m.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.mjs'; return m; }));
function loadPdf(url, onProgress = null) {
  pdfjs();
  if (onProgress) (pdfProg.get(url) ?? pdfProg.set(url, new Set()).get(url)).add(onProgress);
  if (!pdfDocs.has(url)) pdfDocs.set(url, pdfjsP.then((m) => {
    const task = m.getDocument({ url, ...pdfOpts });
    task.onProgress = ({ loaded, total }) => { for (const fn of pdfProg.get(url) || []) fn(loaded, total); };
    return task.promise.finally(() => pdfProg.delete(url));
  }));
  return pdfDocs.get(url);
}
// ---- 노트 PDF: 줄 노트 · 모눈 · 점 · 빈 종이 (선은 벡터라 확대해도 선명) — note 플러그인과 PDF 편집의 '쪽 추가'가 같이 써요 ----
// 종이 종류는 PDF 키워드(outliner-note:종류)에 남겨, 쪽을 더할 때 같은 종이로 이어져요
const NOTE_SIZES = { portrait: [595.28, 841.89], landscape: [841.89, 595.28], square: [700, 700] }; // A4 세로 · 가로 (pt)
function drawNotePage(L, pd, paper, w, h) {
  const p = pd.addPage([w, h]), mm5 = 14.173, rgb = (c) => L.rgb(...c);
  p.drawRectangle({ x: 0, y: 0, width: w, height: h, color: rgb([1, 0.992, 0.973]) });
  const line = (x1, y1, x2, y2, c, t) => p.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: t, color: rgb(c) });
  if (paper === 'lined') { // 8mm 줄 · 왼쪽 여백 선
    const S = 22.68;
    for (let y = h - S * 3; y > S; y -= S) line(0, y, w, y, [0.79, 0.84, 0.91], 0.8);
    line(S * 2.6, 0, S * 2.6, h, [0.94, 0.7, 0.7], 0.8);
  } else if (paper === 'grid') { // 5mm 칸 · 2cm마다 조금 진하게
    for (let i = 1, x = mm5; x < w; i++, x += mm5) line(x, 0, x, h, i % 4 ? [0.88, 0.91, 0.94] : [0.76, 0.81, 0.87], 0.5);
    for (let i = 1, y = h - mm5; y > 0; i++, y -= mm5) line(0, y, w, y, i % 4 ? [0.88, 0.91, 0.94] : [0.76, 0.81, 0.87], 0.5);
  } else if (paper === 'dot') { // 5mm 점
    for (let y = h - mm5; y > 0; y -= mm5) for (let x = mm5; x < w; x += mm5) p.drawCircle({ x, y, size: 0.75, color: rgb([0.68, 0.73, 0.8]) });
  }
  return p;
}
/** 노트 PDF 바이트: { paper: lined|grid|dot|blank, size: portrait|landscape|square, pages } */
async function notePdf({ paper = 'lined', size = 'portrait', pages = 1 } = {}) {
  const L = await pdfLib(), pd = await L.PDFDocument.create(), [w, h] = NOTE_SIZES[size] || NOTE_SIZES.portrait;
  for (let i = 0; i < Math.max(1, Math.min(200, pages)); i++) drawNotePage(L, pd, paper, w, h);
  pd.setTitle('노트'); pd.setKeywords([`outliner-note:${paper}`]);
  return pd.save();
}
/** 쪽 하나의 PDF.js 글(getTextContent) → 이은 글 + 글 조각마다 그 글의 어디인지 (뷰어 찾기 · 여러 PDF 찾기가 같이 써요)
 *  줄은 띄어 잇고, 줄 사이가 글자 높이의 1.8배보다 벌어지면 문단이 바뀐 걸로 보고 '\n'으로 나눠요 (여러 PDF 찾기가 문단째 보여줘요) */
function joinText(tc) {
  let s = '', prevY = null, prevH = 0; const parts = [];
  for (const it of tc.items) {
    if (typeof it.str !== 'string') continue;
    const t = it.transform, h = it.height || Math.hypot(t[2], t[3]) || 10;
    if (it.str.trim()) {
      if (prevY != null && s && !s.endsWith('\n') && Math.abs(t[5] - prevY) > Math.max(h, prevH) * 1.8) s = s.replace(/ $/, '') + '\n';
      prevY = t[5]; prevH = h;
    }
    parts.push({ a: s.length, b: s.length + it.str.length, it, font: tc.styles?.[it.fontName]?.fontFamily || 'sans-serif' }); s += it.str;
    if (it.hasEOL && !s.endsWith(' ') && !s.endsWith('-')) s += ' '; // 줄 끝은 띄어 이어요 (줄을 넘는 낱말 · 문장도 찾게)
  }
  return { s, parts };
}
const pdfTexts = new Map(); // 파일 주소 → 쪽마다의 글 (첨부 파일은 내용이 바뀌지 않아요 — 고쳐 저장하면 새 주소)
const TEXT_BATCH = 8; // 쪽을 이만큼씩 한꺼번에 요청해요 (하나씩 기다리면 큰 PDF가 오래 걸려요)
/** PDF의 쪽마다 글 → ['1쪽 글', …] (그림만 있는 쪽은 '').
 *  서버에 꺼내 둔 글(/api/pdf-text)이 있으면 그걸로 — 없을 때만 PDF.js로 읽고(화면에 연 PDF면 그 문서를 그대로) 서버에 남겨요 → 다음부터 · 다른 기기도 바로 */
function pdfText(url) {
  if (!pdfTexts.has(url)) pdfTexts.set(url, (async () => {
    const name = url.split('/').pop();
    const saved = await http(`/api/pdf-text/${encodeURIComponent(name)}`).catch(() => null);
    if (Array.isArray(saved?.pages)) return saved.pages;
    const m = await pdfjs(), open = pdfDocs.get(url);
    const d = open ? await open : await m.getDocument({ url, ...pdfOpts }).promise;
    let out;
    try {
      out = [];
      for (let k = 1; k <= d.numPages; k += TEXT_BATCH) {
        const ks = Array.from({ length: Math.min(TEXT_BATCH, d.numPages - k + 1) }, (_, i) => k + i);
        out.push(...await Promise.all(ks.map(async (n) => joinText(await (await d.getPage(n)).getTextContent()).s)));
      }
    } finally { if (!open) d.destroy(); }
    http(`/api/pdf-text/${encodeURIComponent(name)}`, 'PUT', { pages: out }).catch(() => {}); // 남기지 못해도 이번 찾기는 그대로
    return out;
  })().catch((e) => { pdfTexts.delete(url); throw e; }));
  return pdfTexts.get(url);
}
const pdfOpts = { cMapUrl: PDFJS + 'cmaps/', cMapPacked: true, standardFontDataUrl: PDFJS + 'standard_fonts/' };
const annotNum = (id) => parseInt(String(id), 10); // pdf.js 주석 id "12R" → PDF 객체 번호 12
function pdfCard(f) {
  const card = mk('div', 'att-pdf');
  const head = mk('div', 'att-pdfhead');
  const name = mk('span', 'att-name'); name.textContent = `PDF · ${f.name}`;
  const pg = mk('span', 'att-pdfpage');
  // 페이지 번호 칸: 숫자를 넣고 Enter → 그 페이지로 (Esc · 밖을 누르면 원래 번호로)
  const num = mk('input', 'att-pdfnum'); num.type = 'text'; num.inputMode = 'numeric'; num.title = '페이지 번호를 넣고 Enter'; num.setAttribute('aria-label', '페이지 번호');
  const tot = mk('span', 'att-pdftot');
  const prev = pdfIconBtn('prev', '이전 페이지');
  const next = pdfIconBtn('next', '다음 페이지');
  // 맞춤: 가로 = 칸 너비에 맞춰요 · 세로 = 한 페이지가 칸 높이에 다 들어오게 (PDF마다 기억해요)
  // 맞춤은 단추 하나로 가로 ↔ 세로를 바꿔요 (아이콘 = 지금 맞춤). 확대(두 손가락 · ⌘/Ctrl+휠)하면 배율 단추가 나와요 — 누르면 맞춤으로
  const fitB = pdfIconBtn('fitW', '');
  const zoomB = mk('button', 'att-btn att-pdfzoom'); zoomB.type = 'button'; zoomB.title = '맞춤 크기로 (100%)'; zoomB.hidden = true;
  const editB = pdfIconBtn('edit', '편집 (형광펜 · 메모 · 페이지 정리)'); editB.classList.add('att-fit');
  const open = pdfIconBtn('full', '화면 가득 보기 (Esc로 돌아오기)');
  const fold = pdfIconBtn('fold', '접기');
  const markB = pdfIconBtn('mark', '북마크 (영역을 지정해 링크로)'); markB.classList.add('att-fit');
  const findB = pdfIconBtn('find', 'PDF 안에서 찾기 (화면 가득일 때 ⌘F)');
  const downB = pdfIconBtn('download', 'PDF 내려받기');
  downB.onclick = () => downloadAttachment(f.url, f.name); // 이름은 글에 적힌 이름으로 · 북마크는 PDF 책갈피로 담아요
  const sep = mk('span', 'att-sep');
  head.append(name, pg, prev, next, sep, fitB, zoomB, findB, markB, editB, downB, open, fold);
  for (const b of [name, markB, downB]) b.classList.add('edit-hide'); // 좁은 화면 편집 중에는 숨겨 페이지 칸을 넓게
  card.dataset.url = f.url;
  // 북마크 칸: '영역 지정' + 목록 (누르면 그 영역으로 · 링크 복사 · 지우기)
  const markPanel = mk('div', 'att-pdfmarks'); markPanel.hidden = true;
  // 편집 막대: 도구(형광펜 · 메모) · 지금 페이지(회전 · 앞으로 · 뒤로 · 삭제) · PDF 합치기 · 되돌리기 · 취소 · 저장
  const bar = mk('div', 'att-pdfbar'); bar.hidden = true;
  // 도구: 펜 · 형광펜(손으로 그어요) · 글자(누른 자리에 글 넣기) · 메모(아이콘 + 내용)
  const TOOLS = [['pen', 'pen', '펜 — 끌어서 그려요 (Shift · 끝에서 잠깐 멈추면 직선)'], ['hl', 'hl', '형광펜 — 끌어서 칠해요 (Shift · 끝에서 잠깐 멈추면 직선)'], ['erase', 'erase', '지우개 — 문지르면 펜 · 형광펜 자국을 지워요'], ['text', 'text', '글자 — 누른 자리에 글을 넣어요'], ['note', 'note', '메모 — 누른 자리에 메모를 달아요']]
    .map(([v, icon, label]) => { const b = pdfIconBtn(icon, label); b.classList.add('att-fit'); b.dataset.tool = v; return b; });
  const bRot = pdfIconBtn('rotate', '지금 페이지 돌리기 (90°)');
  const bUp = pdfIconBtn('up', '지금 페이지를 앞으로');
  const bDown = pdfIconBtn('down', '지금 페이지를 뒤로');
  const bDel = pdfIconBtn('del', '지금 페이지 지우기');
  const bMerge = pdfIconBtn('merge', '다른 PDF를 뒤에 합치기');
  const bAddPage = pdfIconBtn('pageAdd', '빈 쪽을 맨 뒤에 추가 (노트 PDF면 같은 종이로)');
  const bUndo = pdfIconBtn('undo', '되돌리기');
  const editInfo = mk('span', 'att-pdfinfo');
  const bCancel = mk('button', 'att-btn'); bCancel.type = 'button'; bCancel.textContent = '취소';
  const bSave = mk('button', 'att-btn primary'); bSave.type = 'button'; bSave.textContent = '저장';
  const penOpts = mk('span', 'att-pdfopts'); penOpts.hidden = true; // 펜 · 형광펜을 고르면: 색 · 굵기
  const acts = mk('span', 'att-pdfacts'); acts.append(bUndo, editInfo, bCancel, bSave); // 좁은 화면에서는 막대가 옆으로 밀려도 오른쪽에 붙어 있어요
  bar.append(...TOOLS, penOpts, mk('span', 'att-sep'), bRot, bUp, bDown, bDel, bAddPage, bMerge, acts);
  // 찾기 막대: 찾을 글 · 몇 번째 / 모두 · 이전 · 다음 · 닫기 (Enter 다음 · ⇧Enter 이전 · Esc 닫기)
  const findBar = mk('div', 'att-pdffind'); findBar.hidden = true;
  const findQ = mk('input', 'att-pdffindq'); findQ.type = 'search'; findQ.placeholder = 'PDF 안에서 찾기'; findQ.setAttribute('aria-label', 'PDF 안에서 찾기'); findQ.spellcheck = false;
  const findN = mk('span', 'att-pdffindn'); findN.setAttribute('role', 'status');
  const findPrev = pdfIconBtn('up', '이전 결과 (⇧Enter)'), findNext = pdfIconBtn('down', '다음 결과 (Enter)'), findX = pdfIconBtn('close', '찾기 닫기 (Esc)');
  // '정규식': 찾기 창들(jump · find · pdfsearch)과 같은 켜고 끄기 (view.js Toggle과 같은 모양 · 눌러도 찾기 칸의 커서는 그대로)
  const findRx = mk('label', 'v-toggle att-pdfrx'), findRxIn = mk('input'), findRxT = mk('span');
  findRxIn.type = 'checkbox'; findRxT.textContent = '정규식'; findRx.append(findRxIn, findRxT);
  findRx.onmousedown = (e) => e.preventDefault();
  findRx.onclick = (e) => { if (e.target !== findRxIn) { e.preventDefault(); findRxIn.click(); } };
  findRxIn.onchange = () => runFind();
  findBar.append(findQ, findRx, findN, findPrev, findNext, findX);
  const view = mk('div', 'att-pdfview');
  view.tabIndex = -1;
  card.append(head, findBar, markPanel, bar, view);
  // 다른 창에서 고쳐 화면을 다시 그리면 이 카드가 떼었다 붙여지면서 스크롤이 맨 위(1쪽)로 가요 → 보던 자리로 되돌려요
  let lastTop = 0;
  view.addEventListener('scroll', () => { if (view.isConnected) lastTop = view.scrollTop; }, { passive: true });
  card.onReattach = () => { if (view.isConnected && !view.hidden && Math.abs(view.scrollTop - lastTop) > 1) view.scrollTop = lastTop; };
  let pages = [], cur = 1, started = false, restoring = true;
  const setPage = (k, save = true) => {
    cur = k;
    if (pages.length) {
      if (num.parentNode !== pg) pg.replaceChildren(num, tot);
      if (document.activeElement !== num) num.value = k;
      num.style.width = `${String(pages.length).length + 1.2}ch`;
      tot.textContent = ` / ${pages.length}`;
    } else pg.textContent = '';
    if (save && !restoring && !edit) saveMediaPos(f.url, { page: k });
  };
  // 옮긴 쪽 (쪽 번호 · 찾기 · 북마크): 끝쪽이라 그 쪽이 맨 위까지 못 올라와도 그 번호를 지켜요 — 스크롤이 그대로인 동안만
  let pinned = null;
  const pinPage = (k) => { pinned = { k, top: view.scrollTop }; };
  const scrollTo = (k) => { const el = pages[k - 1]; if (el) { view.scrollTop = el.offsetTop; setPage(k); pinPage(k); } };
  const jump = () => {
    const k = parseInt(num.value.replace(/[^\d]/g, ''), 10);
    if (Number.isFinite(k) && pages.length) { const t = Math.min(pages.length, Math.max(1, k)); scrollTo(t); setPage(t); }
    num.value = cur; num.blur();
  };
  num.addEventListener('keydown', (e) => {
    e.stopPropagation(); // 앱 단축키로 새지 않게
    if (e.isComposing) return;
    if (e.key === 'Enter') { e.preventDefault(); jump(); }
    else if (e.key === 'Escape') { e.preventDefault(); num.value = cur; num.blur(); }
  });
  num.addEventListener('focus', () => num.select());
  num.addEventListener('blur', () => { num.value = cur; });
  // ‹ ›: 한 줄(두 쪽 보기면 두 쪽)씩
  prev.onclick = () => { const top = pages[cur - 1]?.offsetTop ?? 0, row = pages.filter((b) => b.offsetTop < top - 1).at(-1); if (row) scrollTo(rowStart(row)); };
  next.onclick = () => { const top = pages[cur - 1]?.offsetTop ?? 0, b = pages.find((x) => x.offsetTop > top + 1); if (b) scrollTo(+b.dataset.page); };
  const rowStart = (b) => +pages.find((x) => Math.abs(x.offsetTop - b.offsetTop) < 2).dataset.page; // 그 줄의 첫 쪽

  // 화면 가득 보기: 새 탭 대신 이 뷰어를 창 전체로 늘려요 (Esc · 버튼으로 돌아와요). 늘어난 크기에 맞춰 다시 그려요(ResizeObserver)
  const onFullKey = (e) => {
    if (e.key !== 'Escape' || e.isComposing || modalOpen()) return; // 대화창이 떠 있으면 그 창부터 닫혀요
    e.preventDefault(); e.stopPropagation(); setFull(false);
  };
  const setFull = (on) => {
    if (on === card.classList.contains('full')) return;
    const keep = cur;
    card.classList.toggle('full', on);
    document.documentElement.classList.toggle('pdf-full', on); // 뒤 페이지는 스크롤되지 않게
    open.innerHTML = PDF_ICON[on ? 'unfull' : 'full'];
    open.title = on ? '원래 크기로 (Esc)' : '화면 가득 보기 (Esc로 돌아오기)'; open.setAttribute('aria-label', open.title);
    if (on) addEventListener('keydown', onFullKey, true); else removeEventListener('keydown', onFullKey, true);
    if (on && view.hidden) setFold(false);
    fold.hidden = on; // 화면 가득 볼 때는 접을 수 없어요 (Esc · ⛶로 먼저 돌아오기)
    requestAnimationFrame(() => { refit(true); scrollTo(keep); setPage(keep, false); }); // 크기가 바뀐 뒤 보던 페이지로
  };
  open.onclick = () => setFull(!card.classList.contains('full'));

  // ---- 보기: model(보이는 페이지 목록)을 페이지 상자들로 그려요 ----
  // 편집은 PDF를 바로 고치지 않고 '고친 것 목록(ops)'에 쌓아 화면에만 반영해요 → 빨라요. 저장할 때 한 번에 pdf-lib으로 PDF에 써요.
  // model 한 칸: { d: PDF.js 문서, i: 그 문서의 페이지 번호(0부터), merged: 합친 파일의 페이지인지, rot: 더 돌린 각도, add: 새 형광펜 · 메모, del: 지울 기존 주석 id, notes: 고친 기존 메모 글 }
  let doc = null, model = [], base = null, avail = { w: 0, h: 0 }, gen = 0, io = null, fit = 'width', zoom = 1;
  const drawn = new Set();
  const baseModel = (d) => Array.from({ length: d.numPages }, (_, i) => ({ d, i, merged: false, rot: 0, add: [], del: new Set(), notes: new Map(), moves: new Map() }));
  const showFit = () => {
    fitB.innerHTML = PDF_ICON[fit === 'page' ? 'fitH' : 'fitW'];
    fitB.title = fit === 'page' ? '세로 맞춤 (한 페이지가 다 보여요) — 누르면 가로 맞춤' : '가로 맞춤 (페이지 너비를 칸에 맞춰요) — 누르면 세로 맞춤';
    fitB.setAttribute('aria-label', fitB.title);
    zoomB.hidden = Math.abs(zoom - 1) < 0.01; zoomB.textContent = `${Math.round(zoom * 100)}%`;
  };
  const measure = () => ({ w: Math.max(200, view.clientWidth - 16), h: Math.max(120, view.clientHeight - 16) }); // 칸 안쪽 여백(8px씩)을 뺀 크기
  let twoUp = false; // 세로 맞춤인데 너비가 두 쪽을 담을 만큼 넉넉하면 두 쪽씩 나란히
  const layout = () => {
    twoUp = fit === 'page' && zoom === 1 && !!base && avail.w >= 2 * base.width * (avail.h / base.height) + 8;
    view.classList.toggle('two', twoUp);
  };
  const scaleFor = (vp1) => zoom * (fit === 'page' ? Math.min((twoUp ? (avail.w - 8) / 2 : avail.w) / vp1.width, avail.h / vp1.height) : avail.w / vp1.width);
  const setFit = (m) => { if (m === fit && zoom === 1) return; fit = m; zoom = 1; showFit(); saveMediaPos(f.url, { fit: m }, true); refit(true); };
  fitB.onclick = () => setFit(fit === 'page' ? 'width' : 'page');
  zoomB.onclick = () => setFit(fit);
  showFit();
  const placeholder = (box) => { // 그리기 전 자리: 첫 페이지 비율로
    const s = scaleFor(base);
    box.style.width = `${Math.round(base.width * s)}px`; box.style.height = `${Math.round(base.height * s)}px`;
  };
  const draw = async (box, again = false) => {
    const k = +box.dataset.page;
    if (drawn.has(k) && !again) return;
    drawn.add(k);
    const g = gen, en = model[k - 1];
    if (!en) return;
    const page = await en.d.getPage(en.i + 1);
    if (g !== gen) return;
    const rotation = (page.rotate + en.rot) % 360;
    const vp = page.getViewport({ scale: scaleFor(page.getViewport({ scale: 1, rotation })), rotation });
    const annots = await page.getAnnotations({ intent: 'display' }).catch(() => []);
    for (const an of annots) { // 지울 기존 주석은 그리지 않아요 (PDF.js 주석 저장소의 noView)
      const hide = en.del.has(an.id) || an.subtype === 'FreeText'; // 글자 주석은 겹으로 그려요 (한글도 그대로 · 고치기 쉽게)
      if (hide || en.d.annotationStorage.has(an.id)) en.d.annotationStorage.setValue(an.id, { noView: hide });
    }
    const dpr = Math.min(2, devicePixelRatio || 1, Math.sqrt(16e6 / (vp.width * vp.height))); // 크게 확대해도 캔버스가 브라우저 한도(약 1600만 화소)를 넘지 않게
    const c = mk('canvas'); c.width = Math.floor(vp.width * dpr); c.height = Math.floor(vp.height * dpr);
    c.style.width = `${Math.floor(vp.width)}px`; c.style.height = `${Math.floor(vp.height)}px`;
    const { AnnotationMode } = await pdfjsP;
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp, annotationMode: AnnotationMode.ENABLE_STORAGE, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null }).promise;
    if (g !== gen) return;
    box.style.width = `${Math.floor(vp.width)}px`; box.style.height = `${Math.floor(vp.height)}px`;
    box.replaceChildren(c);
    box._vp = vp; box._annots = annots;
    addOverlays(box);
  };
  // PDF 안의 링크: 웹 주소는 새 탭으로, 문서 안 링크(목차 · 각주 등)는 그 페이지로 이동
  const pageOfDest = async (dest) => {
    const d = typeof dest === 'string' ? await doc.getDestination(dest) : dest;
    if (!Array.isArray(d) || !d.length) return null;
    return typeof d[0] === 'number' ? d[0] + 1 : (await doc.getPageIndex(d[0])) + 1;
  };
  const placeAt = (el, vp, rect) => {
    const [x1, y1, x2, y2] = vp.convertToViewportRectangle(rect);
    Object.assign(el.style, { left: `${Math.min(x1, x2)}px`, top: `${Math.min(y1, y2)}px`, width: `${Math.abs(x2 - x1)}px`, height: `${Math.abs(y2 - y1)}px` });
  };
  // 편집 중 끌어서 옮기기 (도구가 없거나 글자 · 메모 도구일 때): 다 끌면 onMove(PDF 좌표로 움직인 만큼). 살짝 흔들린 건 클릭
  const draggable = (el, vp, onMove) => {
    const st = { moved: false };
    el.addEventListener('pointerdown', (e) => {
      if (!edit || !onMove || e.button !== 0 || (tool && tool !== 'text' && tool !== 'note')) return;
      e.preventDefault(); e.stopPropagation();
      const sx = e.clientX, sy = e.clientY;
      st.moved = false;
      try { el.setPointerCapture(e.pointerId); } catch { /* 이미 끝난 터치 */ }
      const mv = (ev) => {
        const dx = ev.clientX - sx, dy = ev.clientY - sy;
        if (!st.moved && Math.hypot(dx, dy) < 3) return;
        st.moved = true; el.classList.add('dragging');
        el.style.translate = `${dx}px ${dy}px`;
      };
      const up = (ev) => {
        el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up);
        el.classList.remove('dragging');
        if (!st.moved) return;
        const [ax, ay] = vp.convertToPdfPoint(0, 0), [bx, by] = vp.convertToPdfPoint(ev.clientX - sx, ev.clientY - sy);
        onMove(bx - ax, by - ay);
      };
      el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
    });
    return st;
  };
  const memoEl = (vp, rect, text, onEdit, color = null, onMove = null) => {
    const m = mk('button', 'att-pdfmemo'); m.type = 'button'; m.innerHTML = PDF_ICON.note; m.title = text || '(빈 메모)';
    const [x, y] = vp.convertToViewportPoint(rect[0], rect[3]);
    Object.assign(m.style, { left: `${x}px`, top: `${y}px` });
    if (color) { // 아이콘 색 (밝기에 따라 글씨는 진하게 · 밝게)
      m.style.background = rgbCss(color);
      m.style.color = 0.299 * color[0] + 0.587 * color[1] + 0.114 * color[2] > 0.6 ? 'rgba(0,0,0,.65)' : '#fff';
    }
    const drag = draggable(m, vp, onMove);
    m.onclick = async (e) => {
      e.stopPropagation();
      if (drag.moved) return;
      if (!edit) { toast(text || '(빈 메모)', Math.min(12000, 2500 + text.length * 80)); return; }
      const r = await askText('메모', text, [{ label: '지우기', value: 'del', danger: true }, { label: '취소', value: null }, { label: '고치기', value: 'save', primary: true }]);
      if (r) onEdit(r);
    };
    return m;
  };
  /** 펜 자국(PDF 좌표의 점들) → 화면의 SVG 선 */
  const inkPath = (vp, pts, st) => {
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', svgPathD(pts.map(([x, y]) => vp.convertToViewportPoint(x, y))));
    p.setAttribute('stroke', `rgb(${st.color.map((c) => Math.round(c * 255)).join(',')})`);
    p.setAttribute('stroke-opacity', st.alpha); p.setAttribute('stroke-width', st.width * vp.scale);
    if (st.alpha < 1) p.setAttribute('class', 'hl');
    return p;
  };
  /** 글자 주석 → 겹 (글자 크기는 PDF 12pt를 화면 배율대로) */
  // 편집 중: 끌면 옮기고(onMove: PDF 좌표로 얼마나 움직였는지), 그냥 누르면 고치기 · 지우기
  const textEl = (vp, rect, text, onEdit, readOnly = false, onMove = null) => {
    const el = mk('div', 'att-pdftext'); el.textContent = text;
    const [x, y] = vp.convertToViewportPoint(rect[0], rect[3]);
    Object.assign(el.style, { left: `${x}px`, top: `${y}px`, fontSize: `${TEXT_PT * vp.scale}px` });
    const drag = draggable(el, vp, readOnly ? null : onMove);
    el.onclick = async (e) => {
      if (!edit || readOnly || drag.moved || (tool && tool !== 'text' && tool !== 'note')) return;
      e.stopPropagation();
      const r = await askText('글자', text, [{ label: '지우기', value: 'del', danger: true }, { label: '취소', value: null }, { label: '고치기', value: 'save', primary: true }]);
      if (r && (r.action === 'del' || r.text)) onEdit(r);
    };
    return el;
  };
  const shift = (rect, d) => (d ? [rect[0] + d[0], rect[1] + d[1], rect[2] + d[0], rect[3] + d[1]] : rect);
  const askDelHl = async () => !tool && (await confirmDelete('이 펜 · 형광펜 자국', '저장하기 전에는 되돌리기로 살릴 수 있어요'));
  /** 페이지 위의 겹: 링크 · 메모 · (편집 중) 형광펜 지우기 · 새로 칠한 형광펜 · 새 메모 */
  function addOverlays(box) {
    for (const el of [...box.children]) if (el.tagName !== 'CANVAS') el.remove();
    const k = +box.dataset.page, en = model[k - 1], vp = box._vp;
    for (const an of box._annots || []) {
      if (!an.rect || en.del.has(an.id)) continue;
      if (an.subtype === 'Link') {
        if (edit || en.merged || model !== viewModel) continue; // 편집 중에는 링크 대신 칠하고 메모해요
        const url = an.url || an.unsafeUrl;
        if (!url && an.dest == null) continue;
        const l = mk('a', 'att-pdflink'); placeAt(l, vp, an.rect);
        if (url) { l.href = url; l.target = '_blank'; l.rel = 'noopener noreferrer'; l.title = url; }
        else {
          l.href = '#'; l.title = '문서 안 링크';
          l.onclick = async (e) => {
            e.preventDefault();
            const t = await pageOfDest(an.dest).catch(() => null);
            if (t) { await draw(pages[t - 1]); scrollTo(t); setPage(t); }
          };
        }
        box.append(l);
      } else if (an.subtype === 'Text') { // 메모: 누르면 내용 (편집 중에는 고치기 · 지우기)
        const text = en.notes.get(an.id) ?? an.contentsObj?.str ?? an.contents ?? '';
        const color = an.color?.length === 3 ? Array.from(an.color, (v) => v / 255) : null;
        box.append(memoEl(vp, shift(an.rect, en.moves.get(an.id)), text, (r) => record(r.action === 'del' ? { t: 'rm', k, id: an.id } : { t: 'txt', k, id: an.id, text: r.text }), color, en.merged ? null : (dx, dy) => record({ t: 'mv', k, id: an.id, dx, dy })));
      } else if (an.subtype === 'FreeText') { // 글자: 겹으로 (편집 중에는 눌러서 고치기 · 지우기)
        const text = en.notes.get(an.id) ?? an.contentsObj?.str ?? an.contents ?? '';
        box.append(textEl(vp, shift(an.rect, en.moves.get(an.id)), text, (r) => record(r.action === 'del' ? { t: 'rm', k, id: an.id } : { t: 'txt', k, id: an.id, text: r.text }), en.merged, (dx, dy) => record({ t: 'mv', k, id: an.id, dx, dy })));
      } else if (edit && !en.merged && (an.subtype === 'Highlight' || an.subtype === 'Ink')) { // 편집 중: 기존 형광펜 · 펜 자국을 누르면 지우기
        const h = mk('button', 'att-pdfhl'); h.type = 'button'; h.title = '형광펜 지우기'; placeAt(h, vp, an.rect);
        h.onclick = async (e) => { e.stopPropagation(); if (await askDelHl()) record({ t: 'rm', k, id: an.id }); };
        box.append(h);
      }
    }
    let svg = null;
    for (const a of en.add) { // 아직 저장 안 한 펜 · 형광펜 · 글자 · 메모
      const onEdit = (r) => record(r.action === 'del' ? { t: 'rm', k, id: a.uid } : { t: 'txt', k, id: a.uid, text: r.text });
      if (a.type === 'ink') {
        if (!svg) { svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('class', 'att-pdfink'); svg.setAttribute('width', vp.width); svg.setAttribute('height', vp.height); box.append(svg); }
        const p = inkPath(vp, a.pts, a.st ?? INK[a.kind]);
        p.onclick = async (e) => { e.stopPropagation(); if (await askDelHl()) record({ t: 'rm', k, id: a.uid }); };
        svg.append(p);
      } else if (a.type === 'text') box.append(textEl(vp, a.rect, a.text, onEdit, false, (dx, dy) => record({ t: 'mv', k, id: a.uid, dx, dy })));
      else box.append(memoEl(vp, a.rect, a.text, onEdit, a.color, (dx, dy) => record({ t: 'mv', k, id: a.uid, dx, dy })));
    }
    paintMarkBoxes(box);
    paintHits(box);
  }
  // 북마크 영역 (북마크 칸을 열었을 때 · 링크로 왔을 때 잠깐 보여요)
  function paintMarkBoxes(box) {
    for (const el of box.querySelectorAll(':scope > .att-pdfmark')) el.remove();
    if (edit || model !== viewModel) return; // 편집 중에는 쪽이 바뀔 수 있어서 안 보여요
    const k = +box.dataset.page;
    for (const m of pdfMarks.get(f.url) || []) {
      if (m.page !== k) continue;
      const el = mk('div', 'att-pdfmark'); el.dataset.id = m.id;
      Object.assign(el.style, { left: `${m.r[0] * 100}%`, top: `${m.r[1] * 100}%`, width: `${m.r[2] * 100}%`, height: `${m.r[3] * 100}%` });
      const tag = mk('span', 'att-pdfmarktag'); tag.textContent = m.name; el.append(tag);
      box.append(el);
    }
  }
  // 창 · 칸 크기가 바뀌면 그 크기에 맞춰 다시 그려요 (보던 페이지의 보던 위치는 그대로)
  function refit(force = false) {
    if (!doc || view.hidden || !view.isConnected) return;
    const a = measure();
    if (!force && Math.abs(a.w - avail.w) < 4 && (fit !== 'page' || Math.abs(a.h - avail.h) < 4)) return;
    const at = pages[cur - 1], frac = at ? (view.scrollTop - at.offsetTop) / Math.max(1, at.offsetHeight) : 0;
    avail = a; layout(); gen++;
    drawn.clear();
    for (const b of pages) { b.replaceChildren(); placeholder(b); }
    if (at) { view.scrollTop = force || twoUp ? at.offsetTop : at.offsetTop + frac * at.offsetHeight; lastTop = view.scrollTop; } // 맞춤을 바꾸면 보던 페이지의 맨 위로
    for (const b of pages) { io.unobserve(b); io.observe(b); } // 지금 보이는 페이지부터 다시 그려요
  }
  // ---- 찾기: 쪽마다 PDF.js 글자(getTextContent)를 한 줄로 이어 찾고, 찾은 자리를 쪽 위에 칠해요 ----
  const texts = new WeakMap(); // model 한 칸 → { s: 소문자로 이은 글, parts: [{ a, b, it }] } (같은 쪽은 한 번만 읽어요)
  let hits = [], hitAt = -1, findTok = 0, findDone = false;
  async function pageText(en) {
    if (!texts.has(en)) texts.set(en, en.d.getPage(en.i + 1).then((p) => p.getTextContent()).then((tc) => {
      const { s, parts } = joinText(tc);
      return { s: s.toLowerCase(), parts };
    }).catch(() => ({ s: '', parts: [] })));
    return texts.get(en);
  }
  /** 찾은 것 하나 → 그 쪽 화면 좌표의 사각형들 (글자 조각마다 · 가로 글 기준. 조각 안의 위치는 글자 너비를 재서 나눠요 — 띄어쓰기는 좁으니까) */
  function hitRects(h, vp) {
    const out = [];
    for (const { a, b, it, font } of h.parts) {
      const s = Math.max(h.a, a) - a, e = Math.min(h.b, b) - a, t = it.transform;
      const hgt = it.height || Math.hypot(t[2], t[3]) || 10, x = t[4] + it.width * textFrac(it.str, s, font), x2 = t[4] + it.width * textFrac(it.str, e, font);
      const [x1, y1, x3, y3] = vp.convertToViewportRectangle([x, t[5] - hgt * 0.22, x2, t[5] + hgt * 0.92]);
      out.push([Math.min(x1, x3), Math.min(y1, y3), Math.abs(x3 - x1), Math.abs(y3 - y1)]);
    }
    return out;
  }
  let measureCtx = null;
  const textFrac = (str, i, font) => { // str 앞 i글자가 전체 너비에서 차지하는 비율
    if (i <= 0) return 0;
    if (i >= str.length) return 1;
    measureCtx ??= document.createElement('canvas').getContext('2d');
    measureCtx.font = `100px ${font}`;
    const all = measureCtx.measureText(str).width;
    return all > 0 ? measureCtx.measureText(str.slice(0, i)).width / all : i / str.length;
  };
  function paintHits(box) {
    for (const el of box.querySelectorAll(':scope > .att-pdffound')) el.remove();
    if (findBar.hidden || !box._vp) return;
    const k = +box.dataset.page;
    hits.forEach((h, i) => {
      if (h.k !== k) return;
      for (const [x, y, w, hh] of hitRects(h, box._vp)) {
        const el = mk('div', i === hitAt ? 'att-pdffound cur' : 'att-pdffound');
        Object.assign(el.style, { left: `${x - 1}px`, top: `${y}px`, width: `${w + 2}px`, height: `${hh}px` });
        box.append(el);
      }
    });
  }
  const repaintHits = () => { for (const b of pages) if (b._vp) paintHits(b); };
  const showCount = () => { findN.textContent = !findQ.value.trim() ? '' : hits.length ? `${hitAt + 1} / ${hits.length}${findDone ? '' : '…'}` : findDone ? '없음' : '찾는 중…'; };
  async function runFind() {
    const q = findQ.value.trim().toLowerCase().replace(/\s+/g, ' '), tok = ++findTok, m = model;
    hits = []; hitAt = -1; findDone = false; repaintHits(); showCount();
    if (!q || !m.length) return;
    let re = null;
    if (findRxIn.checked) try { re = new RegExp(findQ.value.trim(), 'gi'); } catch { findN.textContent = '정규식 오류'; return; }
    let first = true;
    for (let k = 1; k <= m.length; k++) {
      const { s, parts } = await pageText(m[k - 1]);
      if (tok !== findTok || m !== model) return;
      const add = (i, e) => hits.push({ k, a: i, b: e, parts: parts.filter((x) => x.b > i && x.a < e) });
      if (re) { for (const x of s.matchAll(re)) if (x[0]) add(x.index, x.index + x[0].length); } // 빈 일치(^ · a* …)는 건너뛰어요
      else for (let i = s.indexOf(q); i >= 0; i = s.indexOf(q, i + q.length)) add(i, i + q.length);
      if (first && hits.length && hits.at(-1).k >= cur) { first = false; goHit(hits.findIndex((h) => h.k >= cur)); } // 보던 쪽부터 — 다 찾기 전에 먼저 보여줘요
      if (k % 20 === 0) { showCount(); await new Promise((r) => setTimeout(r)); } // 쪽이 많아도 화면이 멈추지 않게
    }
    findDone = true;
    if (first && hits.length) goHit(0); // 보던 쪽 뒤에 없으면 처음부터
    showCount(); repaintHits();
  }
  async function goHit(i) {
    if (!hits.length) return;
    hitAt = (i + hits.length) % hits.length;
    const h = hits[hitAt], box = pages[h.k - 1];
    showCount();
    if (!box) return;
    await draw(box);
    repaintHits();
    const r = box._vp ? hitRects(h, box._vp)[0] : null;
    const y = box.offsetTop + (r ? r[1] : 0), x = box.offsetLeft + (r ? r[0] : 0);
    if (!r || y < view.scrollTop + 8 || y + r[3] > view.scrollTop + view.clientHeight - 8) view.scrollTop = Math.max(0, y - view.clientHeight / 3);
    if (r && (x < view.scrollLeft || x + r[2] > view.scrollLeft + view.clientWidth)) view.scrollLeft = Math.max(0, x - view.clientWidth / 3); // 확대해서 옆으로 넘친 쪽
    setPage(h.k); pinPage(h.k);
  }
  const setFind = (on) => {
    findBar.hidden = !on; findB.setAttribute('aria-pressed', on);
    if (on) { if (view.hidden) setFold(false); findQ.focus(); findQ.select(); if (findQ.value.trim() && !hits.length) runFind(); }
    else { findTok++; hits = []; hitAt = -1; findDone = false; repaintHits(); }
  };
  findB.onclick = () => setFind(findBar.hidden);
  findX.onclick = () => setFind(false);
  findPrev.onclick = () => goHit(hitAt - 1);
  findNext.onclick = () => goHit(hitAt + 1);
  let findT = 0;
  findQ.addEventListener('input', () => { clearTimeout(findT); findT = setTimeout(runFind, 200); });
  findQ.addEventListener('keydown', (e) => {
    e.stopPropagation(); // 앱 단축키로 새지 않게
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') { e.preventDefault(); clearTimeout(findT); if (!hits.length) runFind(); else goHit(hitAt + (e.shiftKey ? -1 : 1)); }
    else if (e.key === 'Escape') { e.preventDefault(); setFind(false); view.focus({ preventScroll: true }); }
  });
  addEventListener('keydown', (e) => { // 화면 가득일 때 ⌘F · Ctrl+F = 이 PDF에서 찾기
    if (!card.classList.contains('full') || !card.isConnected || modalOpen() || e.isComposing) return;
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.code === 'KeyF') { e.preventDefault(); e.stopPropagation(); setFind(true); }
  }, true);

  let viewModel = null;
  /** model을 그려요 (want 페이지부터) */
  async function show(m, want) {
    model = m; gen++; drawn.clear();
    io?.disconnect();
    base = (await m[0].d.getPage(m[0].i + 1)).getViewport({ scale: 1 });
    avail = measure(); layout();
    pages = m.map((_, k) => { const box = mk('div', 'att-pdfpg'); box.dataset.page = k + 1; placeholder(box); return box; });
    view.replaceChildren(...pages);
    io = new IntersectionObserver((es) => { for (const e of es) if (e.isIntersecting) draw(e.target); }, { root: view, rootMargin: '600px 0px' });
    for (const b of pages) io.observe(b);
    want = Math.min(m.length, Math.max(1, want));
    setPage(want, false);
    await draw(pages[want - 1]); scrollTo(want);
    if (!findBar.hidden && findQ.value.trim()) runFind(); // 쪽이 바뀌었으면(편집 · 저장) 다시 찾아요
  }
  let rsz = 0;
  new ResizeObserver(() => { clearTimeout(rsz); rsz = setTimeout(refit, 150); }).observe(view);
  // ---- 확대: 두 손가락 벌리기(터치) · ⌘/Ctrl+휠(트랙패드 오므리기). 하는 동안은 페이지를 CSS로 늘려 보여주고, 손을 떼면 그 배율로 다시 그려요 ----
  const ZMIN = 0.5, ZMAX = 6;
  let live = null; // { r: 지금까지 늘린 비율, ax, ay: 시작할 때 손가락 가운데의 내용 좌표 }
  const beginZoom = (cx, cy) => { live = { r: 1, ax: view.scrollLeft + cx, ay: view.scrollTop + cy }; };
  const liveZoom = (r, cx, cy) => {
    r = Math.min(ZMAX / zoom, Math.max(ZMIN / zoom, r));
    live.r = r;
    for (const b of pages) b.style.zoom = r;
    view.scrollLeft = live.ax * r - cx; view.scrollTop = live.ay * r - cy;
  };
  const endZoom = () => {
    if (!live) return;
    const r = live.r; live = null;
    if (Math.abs(r - 1) < 0.01) { for (const b of pages) b.style.zoom = ''; return; }
    const sl = view.scrollLeft, st = view.scrollTop;
    zoom = Math.min(ZMAX, Math.max(ZMIN, zoom * r));
    if (Math.abs(zoom - 1) < 0.04) zoom = 1;
    layout(); gen++; drawn.clear();
    for (const b of pages) {
      b.style.zoom = '';
      for (const el of [...b.children]) if (el.tagName !== 'CANVAS') el.remove(); // 겹(링크 · 메모 …)은 다시 그릴 때 새로
      const c = b.querySelector('canvas'); if (c) { c.style.width = '100%'; c.style.height = '100%'; } // 다시 그릴 때까지 옛 그림을 늘려 보여줘요
      placeholder(b);
    }
    view.scrollLeft = sl; view.scrollTop = st; lastTop = st;
    for (const b of pages) { io.unobserve(b); io.observe(b); }
    showFit();
  };
  let pinch = null;
  const tdist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  const tmid = (t) => { const r = view.getBoundingClientRect(); return [(t[0].clientX + t[1].clientX) / 2 - r.left, (t[0].clientY + t[1].clientY) / 2 - r.top]; };
  view.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 2 || !pages.length) return;
    abortStroke?.(); // 긋던 선은 버려요
    const [cx, cy] = tmid(e.touches);
    pinch = { d: tdist(e.touches) || 1 }; beginZoom(cx, cy);
  }, { passive: true });
  view.addEventListener('touchmove', (e) => {
    if (!pinch || e.touches.length < 2) return;
    e.preventDefault();
    const [cx, cy] = tmid(e.touches);
    liveZoom(tdist(e.touches) / pinch.d, cx, cy);
  }, { passive: false });
  const tend = (e) => { if (pinch && e.touches.length < 2) { pinch = null; endZoom(); } };
  view.addEventListener('touchend', tend); view.addEventListener('touchcancel', tend);
  let wheelT = 0;
  view.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey) || !pages.length) return;
    e.preventDefault();
    const r = view.getBoundingClientRect(), cx = e.clientX - r.left, cy = e.clientY - r.top;
    if (!live) beginZoom(cx, cy);
    liveZoom(live.r * Math.exp(-e.deltaY * 0.01), cx, cy);
    clearTimeout(wheelT); wheelT = setTimeout(endZoom, 250);
  }, { passive: false });
  let tick = 0;
  view.addEventListener('scroll', () => {
    cancelAnimationFrame(tick);
    tick = requestAnimationFrame(() => { // 창 가운데 위쪽에 걸친 페이지 = 지금 페이지
      if (pinned && Math.abs(view.scrollTop - pinned.top) < 2) return; // 방금 옮긴 쪽 그대로
      pinned = null;
      const mid = view.scrollTop + view.clientHeight * 0.35;
      let k = 1;
      for (const b of pages) { if (b.offsetTop > mid) break; if (b.offsetTop > (pages[k - 1]?.offsetTop ?? -1) + 1) k = +b.dataset.page; } // 두 쪽 보기면 그 줄의 왼쪽 쪽
      if (pages.length && view.scrollTop > 0 && view.scrollTop + view.clientHeight >= view.scrollHeight - 2) k = rowStart(pages.at(-1)); // 끝까지 내리면 마지막 쪽 (짧아서 맨 위까지 못 올라와도)
      if (k !== cur) setPage(k);
    });
  }, { passive: true });
  const setFold = (hide) => {
    view.hidden = hide; prev.hidden = next.hidden = pg.hidden = sep.hidden = fitB.hidden = editB.hidden = markB.hidden = findB.hidden = hide; if (hide) zoomB.hidden = true; else showFit();
    if (hide) { markPanel.hidden = true; card.classList.remove('marks'); setMarking(false); if (!findBar.hidden) setFind(false); }
    bar.hidden = hide || !edit;
    fold.innerHTML = PDF_ICON[hide ? 'unfold' : 'fold']; fold.title = hide ? '펼치기' : '접기'; fold.setAttribute('aria-label', fold.title);
    if (!hide) start();
  };
  fold.onclick = () => { if (card.classList.contains('full')) return; const hide = !view.hidden; setFold(hide); savePdfFold(f.url, hide); };
  let startP = null;
  /** 불러오기 — 이미 불러오는 중이면 그 끝을 기다려요 (불러오는 동안 북마크 · 찾기 결과로 와도 그 쪽으로 가게) */
  function start() {
    if (started) return startP ?? Promise.resolve();
    if (view.hidden || !card.isConnected) return Promise.resolve();
    return (startP = load());
  }
  async function load() {
    started = true;
    pg.textContent = '불러오는 중…';
    const job = progress(); // 받는 동안 맨 위 막대 · 쪽 번호 자리에 몇 %
    try { doc = await loadPdf(f.url, (got, all) => { if (all > 0) { job.set(got / all); pg.textContent = `불러오는 중… ${Math.min(99, Math.round((got / all) * 100))}%`; } }); } catch { job.done(); pg.textContent = 'PDF를 열 수 없어요'; view.hidden = true; prev.hidden = next.hidden = sep.hidden = fitB.hidden = editB.hidden = true; return; } // 손상됐거나 PDF가 아닌 파일
    job.done();
    await mediaPosReady;
    if (mediaPos.get(f.url)?.fit === 'page') { fit = 'page'; showFit(); }
    viewModel = baseModel(doc);
    await show(viewModel, mediaPos.get(f.url)?.page || 1);
    requestAnimationFrame(() => { restoring = false; });
  }

  // ---- 편집: 고친 것을 ops에 쌓고 화면만 바꿔요 (되돌리기 = 마지막 것 빼고 다시 계산). 저장할 때 원본에 차례로 적용해 새 파일로 올려요 ----
  let edit = false, ops = [], tool = null, busy = false, uid = 0, editFull = false, abortStroke = null;
  const ADD_OPS = new Set(['ink', 'text', 'note']); // 페이지에 더하는 것 (그 페이지만 다시 그려요)
  const INK = { pen: { color: [0.86, 0.15, 0.15], width: 1.6, alpha: 1 }, hl: { color: [1, 0.85, 0.1], width: 12, alpha: 0.4 } }; // 펜 = 빨강 · 형광펜 = 노랑 (굵기는 PDF 단위 pt)
  const TEXT_PT = 12;
  const showEdit = () => {
    editB.setAttribute('aria-pressed', edit); bar.hidden = !edit || view.hidden; card.classList.toggle('editing', edit);
    for (const b of TOOLS) b.setAttribute('aria-pressed', tool === b.dataset.tool);
    view.dataset.tool = tool || '';
    paintPenOpts();
    bUndo.disabled = !ops.length; bSave.disabled = !ops.length;
    editInfo.textContent = ops.length ? `고친 곳 ${ops.length}` : '';
  };
  // 펜 · 형광펜 색 · 굵기 고르기
  function paintPenOpts() {
    const kind = tool === 'pen' || tool === 'hl' || tool === 'note' ? tool : null;
    penOpts.hidden = !kind;
    if (!kind) return;
    const P = PEN[kind], q = penPick[kind];
    const save = () => { try { localStorage.setItem('outliner.pdfpen', JSON.stringify(penPick)); } catch {} paintPenOpts(); };
    penOpts.replaceChildren(
      ...P.colors.map((c, i) => {
        const b = mk('button', 'att-swatch'); b.type = 'button'; b.style.setProperty('--c', rgbCss(c)); b.setAttribute('aria-pressed', q.c === i);
        b.title = '색'; b.setAttribute('aria-label', `색 ${i + 1}`); b.onclick = () => { q.c = i; save(); };
        return b;
      }),
      ...(P.widths || []).map((w, i) => {
        const b = mk('button', 'att-btn att-ico att-fit att-width'); b.type = 'button'; b.setAttribute('aria-pressed', q.w === i);
        const dot = mk('span', 'att-dot'), px = kind === 'hl' ? 5 + i * 3 : 2 + i * 2.5;
        Object.assign(dot.style, { width: `${px}px`, height: `${px}px`, background: rgbCss(P.colors[q.c] ?? P.colors[0]) });
        b.append(dot); b.title = ['가늘게', '보통', '굵게'][i]; b.setAttribute('aria-label', b.title); b.onclick = () => { q.w = i; save(); };
        return b;
      }),
    );
  }
  /** ops를 차례로 적용한 페이지 목록 (PDF는 건드리지 않아요) */
  function replay() {
    const m = baseModel(doc);
    for (const op of ops) {
      if (op.t === 'rot') m[op.k - 1].rot = (m[op.k - 1].rot + 90) % 360;
      else if (op.t === 'move') { const [p] = m.splice(op.k - 1, 1); m.splice(op.to - 1, 0, p); }
      else if (op.t === 'del') m.splice(op.k - 1, 1);
      else if (op.t === 'merge') for (const x of op.files) for (let i = 0; i < x.d.numPages; i++) m.push({ d: x.d, i, merged: true, rot: 0, add: [], del: new Set(), notes: new Map(), moves: new Map() });
      else if (ADD_OPS.has(op.t)) m[op.k - 1].add.push({ ...op, type: op.t, text: op.text ?? '' });
      else if (op.t === 'rm' || op.t === 'txt') {
        const en = m[op.k - 1], a = en.add.find((x) => x.uid === op.id);
        if (op.t === 'rm') { if (a) en.add.splice(en.add.indexOf(a), 1); else en.del.add(op.id); }
        else if (a) a.text = op.text; else en.notes.set(op.id, op.text);
      } else if (op.t === 'mv') { // 글자 옮기기: 새 글자는 자리를, 기존 글자는 움직인 만큼을 기억해요
        const en = m[op.k - 1], a = en.add.find((x) => x.uid === op.id);
        if (a) a.rect = shift(a.rect, [op.dx, op.dy]);
        else { const d = en.moves.get(op.id) ?? [0, 0]; en.moves.set(op.id, [d[0] + op.dx, d[1] + op.dy]); }
      }
    }
    return m;
  }
  /** 고친 것 하나를 쌓고 화면에 반영: 주석은 그 페이지만, 페이지 정리는 목록 전체를 다시 (보이는 페이지만 그려요) */
  async function record(op, want) {
    if (ADD_OPS.has(op.t)) op.uid = `n${++uid}`;
    ops.push(op);
    await refresh(op, want);
  }
  async function refresh(op, want = cur) {
    const m = replay();
    showEdit();
    if (op && (ADD_OPS.has(op.t) || op.t === 'rm' || op.t === 'txt' || op.t === 'mv') && m.length === model.length) { // 주석만 바뀌었으면 그 페이지만
      model = m;
      const box = pages[op.k - 1];
      if (op.t === 'rm' && !String(op.id).startsWith('n')) await draw(box, true); else if (box?._vp) addOverlays(box);
      return;
    }
    await show(m, want);
  }
  const annotsOf = (pd, L, i) => {
    const node = pd.getPage(i).node;
    let a = node.lookup(L.PDFName.of('Annots'));
    if (!a) { a = pd.context.obj([]); node.set(L.PDFName.of('Annots'), a); }
    return a;
  };
  function findAnnot(pd, i, id) {
    const a = pd.getPage(i).node.Annots(), want = annotNum(id);
    for (let j = 0; a && j < a.size(); j++) { const r = a.get(j); if (r?.objectNumber === want) return pd.context.lookup(r); }
    return null;
  }
  function removeAnnot(pd, i, id) {
    const a = pd.getPage(i).node.Annots(), want = annotNum(id);
    for (let j = a ? a.size() - 1 : -1; j >= 0; j--) if (a.get(j)?.objectNumber === want) a.remove(j);
  }
  const addAnnot = (pd, L, i, dict) => {
    const ref = pd.context.register(pd.context.obj({ Type: 'Annot', F: 4, T: L.PDFHexString.fromText('outliner'), M: L.PDFString.fromDate(new Date()), ...dict }));
    annotsOf(pd, L, i).push(ref);
  };
  /** 펜 · 형광펜 자국 → Ink 주석 (다른 PDF 앱에서도 똑같이 보이게 모양(AP)도 함께 넣어요) */
  function addInk(pd, L, i, pts, st) {
    const pad = st.width;
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const rect = [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad];
    const n = (v) => +v.toFixed(2);
    let cp = null; // 화면과 같은 부드러운 곡선 (2차 곡선 → PDF의 3차 곡선)
    const path = smoothSegs(pts).map(([t, a, b]) => {
      if (t !== 'Q') { cp = a; return `${n(a[0])} ${n(a[1])} ${t === 'M' ? 'm' : 'l'}`; }
      const c1 = [cp[0] + (2 / 3) * (a[0] - cp[0]), cp[1] + (2 / 3) * (a[1] - cp[1])], c2 = [b[0] + (2 / 3) * (a[0] - b[0]), b[1] + (2 / 3) * (a[1] - b[1])];
      cp = b;
      return `${n(c1[0])} ${n(c1[1])} ${n(c2[0])} ${n(c2[1])} ${n(b[0])} ${n(b[1])} c`;
    }).join(' ');
    const content = `/GS0 gs ${st.color.join(' ')} RG ${st.width} w 1 J 1 j ${path} S`;
    const ap = pd.context.register(pd.context.stream(content, {
      Type: 'XObject', Subtype: 'Form', BBox: rect,
      Resources: { ExtGState: { GS0: { Type: 'ExtGState', CA: st.alpha, ...(st.alpha < 1 ? { BM: 'Multiply' } : {}) } } },
    }));
    addAnnot(pd, L, i, { Subtype: 'Ink', Rect: rect, InkList: [pts.flatMap(([x, y]) => [n(x), n(y)])], C: st.color, CA: st.alpha, BS: { W: st.width }, AP: { N: ap } });
  }
  /** 저장: 원본 PDF에 ops를 차례로 적용 → 바이트 */
  async function build() {
    const L = await pdfLib();
    const pd = await L.PDFDocument.load(new Uint8Array(await (await fetch(f.url)).arrayBuffer()), { updateMetadata: false });
    const gone = new Set(ops.filter((o) => o.t === 'rm').map((o) => o.id)); // 새로 칠했다가 지운 것은 처음부터 안 넣어요
    const text = new Map(ops.filter((o) => o.t === 'txt').map((o) => [o.id, o.text]));
    const moveOf = new Map(); // 새 글자를 옮긴 만큼 (처음부터 그 자리에 넣어요)
    for (const o of ops) if (o.t === 'mv' && String(o.id).startsWith('n')) { const d = moveOf.get(o.id) ?? [0, 0]; moveOf.set(o.id, [d[0] + o.dx, d[1] + o.dy]); }
    for (const op of ops) {
      if (op.t === 'rot') { const p = pd.getPage(op.k - 1); p.setRotation(L.degrees((p.getRotation().angle + 90) % 360)); }
      else if (op.t === 'move') { const p = pd.getPage(op.k - 1); pd.removePage(op.k - 1); pd.insertPage(op.to - 1, p); }
      else if (op.t === 'del') pd.removePage(op.k - 1);
      else if (op.t === 'merge') for (const x of op.files) { const other = await L.PDFDocument.load(x.bytes); for (const p of await pd.copyPages(other, other.getPageIndices())) pd.addPage(p); }
      else if (op.t === 'ink' && !gone.has(op.uid)) addInk(pd, L, op.k - 1, op.pts, op.st ?? INK[op.kind]);
      else if (op.t === 'text' && !gone.has(op.uid)) addAnnot(pd, L, op.k - 1, { Subtype: 'FreeText', Rect: shift(op.rect, moveOf.get(op.uid)), Contents: L.PDFHexString.fromText(text.get(op.uid) ?? op.text), DA: L.PDFString.of(`/Helv ${TEXT_PT} Tf 0 0 0 rg`), Q: 0, BS: { W: 0 } });
      else if (op.t === 'note' && !gone.has(op.uid)) addAnnot(pd, L, op.k - 1, { Subtype: 'Text', Name: 'Comment', Rect: shift(op.rect, moveOf.get(op.uid)), C: op.color ?? [1, 0.8, 0.1], Contents: L.PDFHexString.fromText(text.get(op.uid) ?? op.text) });
      else if (op.t === 'rm' && !String(op.id).startsWith('n')) removeAnnot(pd, op.k - 1, op.id);
      else if (op.t === 'mv' && !String(op.id).startsWith('n')) { // 기존 글자 옮기기: 자리(Rect)를 움직여요 (모양(AP)도 Rect를 따라가요)
        const o = findAnnot(pd, op.k - 1, op.id), r = o?.lookup(L.PDFName.of('Rect'));
        if (r) o.set(L.PDFName.of('Rect'), pd.context.obj(shift(r.asArray().map((x) => x.asNumber()), [op.dx, op.dy])));
      } else if (op.t === 'txt' && !String(op.id).startsWith('n')) findAnnot(pd, op.k - 1, op.id)?.set(L.PDFName.of('Contents'), L.PDFHexString.fromText(op.text));
    }
    return pd.save();
  }
  editB.onclick = async () => {
    if (!doc || busy) return;
    if (edit) return leaveEdit();
    busy = true;
    try {
      const L = await pdfLib();
      await L.PDFDocument.load(new Uint8Array(await (await fetch(f.url)).arrayBuffer()), { updateMetadata: false }); // 암호가 걸린 PDF면 여기서 걸러요
      ops = []; edit = true; tool = null;
      editFull = !card.classList.contains('full'); if (editFull) setFull(true); // 편집은 화면 가득으로 (끝나면 원래대로)
      markPanel.hidden = true; card.classList.remove('marks'); setMarking(false); markB.setAttribute('aria-pressed', false);
      await show(replay(), cur); // 편집용 겹(형광펜 · 메모)을 다시 그려요
    } catch (e) {
      toast(/encrypt/i.test(e.message) ? '암호가 걸린 PDF는 편집할 수 없어요' : `편집할 수 없는 PDF예요: ${e.message}`, 4000);
    } finally { busy = false; showEdit(); }
  };
  async function leaveEdit(force = false) {
    if (!force && ops.length && !(await askChoice('편집 그만하기', '저장하지 않은 고친 곳이 있어요. 버릴까요?', [{ label: '계속 편집', value: null }, { label: '버리기', value: true, primary: true }]))) return;
    edit = false; tool = null; ops = [];
    if (editFull && card.classList.contains('full')) setFull(false);
    editFull = false;
    showEdit();
    viewModel = baseModel(doc);
    await show(viewModel, Math.min(cur, viewModel.length));
  }
  bCancel.onclick = () => leaveEdit();
  for (const b of TOOLS) b.onclick = () => { tool = tool === b.dataset.tool ? null : b.dataset.tool; showEdit(); };
  bUndo.onclick = () => { const op = ops.pop(); if (!op) return; const k = cur; refresh(ADD_OPS.has(op.t) || op.t === 'txt' || op.t === 'mv' || (op.t === 'rm' && String(op.id).startsWith('n')) ? op : null, Math.min(k, replay().length)); };
  bRot.onclick = () => record({ t: 'rot', k: cur }, cur);
  const movePage = (dir) => { const to = cur + dir; if (to >= 1 && to <= model.length) record({ t: 'move', k: cur, to }, to); };
  bUp.onclick = () => movePage(-1);
  bDown.onclick = () => movePage(1);
  bDel.onclick = async () => {
    if (model.length <= 1) return toast('마지막 한 페이지는 지울 수 없어요');
    const k = cur;
    if (await confirmDelete(`${k}쪽`, '저장하기 전에는 되돌리기로 살릴 수 있어요')) record({ t: 'del', k }, Math.min(k, model.length - 1));
  };
  const mergeInput = mk('input'); mergeInput.type = 'file'; mergeInput.accept = 'application/pdf,.pdf'; mergeInput.multiple = true; mergeInput.hidden = true;
  card.append(mergeInput);
  bMerge.onclick = () => mergeInput.click();
  // 빈 쪽 추가: 지금 쪽과 같은 크기 · 노트 PDF면 같은 종이(줄 · 모눈 · 점)로 — 한 쪽짜리 PDF를 합치는 것과 같아요
  bAddPage.onclick = async () => {
    try {
      const L = await pdfLib();
      const src = await L.PDFDocument.load(new Uint8Array(await (await fetch(f.url)).arrayBuffer()), { updateMetadata: false });
      const paper = /outliner-note:(\w+)/.exec(src.getKeywords() || '')?.[1] || 'blank';
      const m = model[cur - 1], pv = (await m.d.getPage(m.i + 1)).getViewport({ scale: 1, rotation: 0 });
      const pd = await L.PDFDocument.create();
      drawNotePage(L, pd, paper, pv.width, pv.height);
      const bytes = await pd.save();
      const d = await (await pdfjsP).getDocument({ data: bytes.slice(), ...pdfOpts }).promise;
      record({ t: 'merge', files: [{ bytes, d }] }, model.length + 1);
    } catch (e) { toast(`쪽을 더하지 못했어요: ${e.message}`, 4000); }
  };
  mergeInput.onchange = async () => {
    const list = [...mergeInput.files]; mergeInput.value = '';
    if (!list.length) return;
    try {
      const m = await pdfjsP, files = [];
      for (const file of list) { const bytes = new Uint8Array(await file.arrayBuffer()); files.push({ bytes, d: await m.getDocument({ data: bytes.slice(), ...pdfOpts }).promise }); }
      record({ t: 'merge', files }, model.length + 1); // 합친 첫 페이지로
    } catch (e) { toast(`합칠 수 없는 PDF예요: ${e.message}`, 4000); }
  };
  // 펜 · 형광펜: 끌어서 그려요 · 글자 · 메모: 누른 자리에
  view.addEventListener('pointerdown', (e) => {
    const box = e.target.closest?.('.att-pdfpg');
    if (marking && box?._vp && e.button === 0) return drawMark(e, box);
    if (e.pointerType === 'touch' && abortStroke) { abortStroke(); return; } // 두 번째 손가락: 그리기 대신 확대
    if (!edit || !tool || !box?._vp || e.button !== 0) return;
    e.preventDefault();
    const k = +box.dataset.page, vp = box._vp, r0 = box.getBoundingClientRect();
    const x0 = e.clientX - r0.left, y0 = e.clientY - r0.top;
    if (tool === 'erase') { // 지우개: 지나간 자리에 걸친 펜 · 형광펜 자국을 하나씩 지워요 (되돌리기로 하나씩 살려요)
      const hit = new Set();
      const rub = (ev) => {
        const x = ev.clientX - r0.left, y = ev.clientY - r0.top, en = model[k - 1];
        for (const a of en.add) {
          if (a.type !== 'ink' || hit.has(a.uid)) continue;
          const st = a.st ?? INK[a.kind];
          if (nearPolyline(a.pts.map(([px, py]) => vp.convertToViewportPoint(px, py)), x, y, (st.width * vp.scale) / 2 + 6)) { hit.add(a.uid); record({ t: 'rm', k, id: a.uid }); }
        }
        for (const an of box._annots || []) {
          if (!(an.subtype === 'Ink' || an.subtype === 'Highlight') || !an.rect || en.del.has(an.id) || hit.has(an.id) || en.merged) continue;
          const [x1, y1, x2, y2] = vp.convertToViewportRectangle(an.rect);
          if (x < Math.min(x1, x2) - 4 || x > Math.max(x1, x2) + 4 || y < Math.min(y1, y2) - 4 || y > Math.max(y1, y2) + 4) continue;
          const lists = an.subtype === 'Ink' ? an.inkLists || [] : [];
          const ptsOf = (l) => { // pdf.js 판에 따라 [{x, y}, …] 또는 [x1, y1, x2, y2, …]
            const a = Array.from(l), out = [];
            if (typeof a[0] === 'number') for (let j = 0; j + 1 < a.length; j += 2) out.push(vp.convertToViewportPoint(a[j], a[j + 1]));
            else for (const pt of a) out.push(vp.convertToViewportPoint(pt.x ?? pt[0], pt.y ?? pt[1]));
            return out;
          };
          const near = !lists.length || lists.some((l) => nearPolyline(ptsOf(l), x, y, 10));
          if (near) { hit.add(an.id); record({ t: 'rm', k, id: an.id }); }
        }
      };
      const stop = () => { removeEventListener('pointermove', rub); removeEventListener('pointerup', stop); removeEventListener('pointercancel', stop); abortStroke = null; };
      abortStroke = stop;
      rub(e);
      addEventListener('pointermove', rub); addEventListener('pointerup', stop); addEventListener('pointercancel', stop);
      return;
    }
    if (tool === 'note' || tool === 'text') { // 손을 뗄 때 (두 손가락 확대였으면 넣지 않아요)
      const isText = tool === 'text';
      let gone = false;
      const off = () => { removeEventListener('pointerup', fire); abortStroke = null; };
      const fire = (ev) => { off(); if (!gone && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 12) ask(); };
      abortStroke = () => { gone = true; off(); };
      addEventListener('pointerup', fire);
      const ask = () => askText(isText ? '글자 넣기' : '메모 달기', '', [{ label: '취소', value: null }, { label: isText ? '넣기' : '달기', value: 'save', primary: true }]).then((r) => {
        if (!r?.text) return;
        const [px, py] = vp.convertToPdfPoint(x0, y0);
        if (!isText) return record({ t: 'note', k, rect: [px, py - 20, px + 20, py], text: r.text, color: PEN.note.colors[penPick.note.c] ?? PEN.note.colors[0] });
        const lines = r.text.split('\n'), w = Math.max(...lines.map((l) => [...l].reduce((s, ch) => s + (ch.charCodeAt(0) > 0x2e80 ? 1 : 0.55), 0))) * TEXT_PT + 4; // 대략의 글자 폭 (한글은 1em)
        record({ t: 'text', k, rect: [px, py - lines.length * TEXT_PT * 1.25 - 2, px + w, py], text: r.text });
      });
      return;
    }
    const kind = tool, st = penStyle(kind), pts = [[x0, y0]];
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('class', 'att-pdfink live'); svg.setAttribute('width', r0.width); svg.setAttribute('height', r0.height);
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('stroke', rgbCss(st.color)); path.setAttribute('stroke-opacity', st.alpha); path.setAttribute('stroke-width', st.width * vp.scale);
    if (st.alpha < 1) path.setAttribute('class', 'hl');
    svg.append(path); box.append(svg);
    const at = (ev) => [Math.max(0, Math.min(r0.width, ev.clientX - r0.left)), Math.max(0, Math.min(r0.height, ev.clientY - r0.top))];
    // 직선: Shift를 누르고 그리거나, 긋다가 잠깐 멈추면 처음 점에서 지금 점까지 곧은 선으로 (그 뒤로는 끝점만 따라와요)
    let straight = false, end = [x0, y0], holdAt = [x0, y0], hold = 0;
    const shown = () => (straight ? [pts[0], end] : pts);
    const paint = () => path.setAttribute('d', svgPathD(shown()));
    const armHold = () => { clearTimeout(hold); hold = setTimeout(() => { if (!straight && pts.length > 3 && Math.hypot(end[0] - x0, end[1] - y0) > 24) { straight = true; paint(); } }, 550); };
    const move = (ev) => {
      const list = ev.getCoalescedEvents?.();
      for (const ce of list?.length ? list : [ev]) { // 촘촘한 중간 점까지 (없으면 이 점만)
        const p = at(ce), q = pts.at(-1);
        end = p;
        if (!straight && Math.hypot(p[0] - q[0], p[1] - q[1]) >= 1.5) pts.push(p); // 촘촘한 점은 건너뛰어요
      }
      if (ev.shiftKey) straight = true;
      if (Math.hypot(end[0] - holdAt[0], end[1] - holdAt[1]) > 4) { holdAt = end; armHold(); } // 움직이는 동안은 멈춤 시계를 다시
      paint();
    };
    paint(); armHold();
    abortStroke = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); clearTimeout(hold); svg.remove(); abortStroke = null; };
    const up = (ev) => {
      removeEventListener('pointermove', move); removeEventListener('pointerup', up);
      clearTimeout(hold); abortStroke = null;
      move(ev);
      svg.remove();
      const line = shown();
      if (line.length < 2 || (line.length === 2 && Math.hypot(line[1][0] - line[0][0], line[1][1] - line[0][1]) < 0.5)) line.splice(1, line.length, [line[0][0] + 0.5, line[0][1]]); // 한 번 콕 = 점
      record({ t: 'ink', k, kind, st, pts: simplifyPts(line.map(([x, y]) => vp.convertToPdfPoint(x, y)), 0.25) });
    };
    addEventListener('pointermove', move); addEventListener('pointerup', up);
  });
  // ---- 북마크: '영역 지정'을 켜고 페이지 위에서 끌어 사각형을 그리면 이름을 받아 저장하고 링크를 복사해요 ----
  let marking = false;
  const nodeIdOf = () => +(card.closest('.node')?.dataset.nid ?? state.zoom);
  const markAddB = mk('button', 'att-btn att-markadd'); markAddB.type = 'button';
  const marksUi = markList({
    kind: 'pdf', url: () => f.url, tag: (m) => `${m.page}쪽`, sort: (a, b) => a.page - b.page || a.r[1] - b.r[1],
    go: (m) => goMark(m), link: (m) => markHref('pdf', f.url, m, { n: nodeIdOf() }),
  });
  markPanel.append(markAddB, marksUi.find, marksUi.list);
  const setMarking = (on) => {
    marking = on; view.classList.toggle('marking', on);
    markAddB.innerHTML = PDF_ICON.markAdd; markAddB.append(on ? ' 페이지 위에서 끌어 영역을 그려요 (Esc 취소)' : ' 영역 지정해 북마크 만들기');
    markAddB.setAttribute('aria-pressed', on);
  };
  function paintMarks() {
    markB.setAttribute('aria-pressed', !markPanel.hidden);
    marksUi.paint();
    for (const b of pages) if (b._vp) paintMarkBoxes(b);
  }
  document.addEventListener('pdfmarks', () => { if (card.isConnected || markPanel.isConnected) paintMarks(); });
  markB.onclick = () => {
    if (edit) return toast('편집 중에는 북마크를 만들 수 없어요 — 저장하거나 취소한 뒤에');
    markPanel.hidden = !markPanel.hidden;
    card.classList.toggle('marks', !markPanel.hidden);
    if (markPanel.hidden) setMarking(false);
    else if (view.hidden) setFold(false);
    paintMarks();
  };
  markAddB.onclick = () => setMarking(!marking);
  setMarking(false);
  addEventListener('keydown', (e) => { if (marking && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setMarking(false); } }, true);
  function drawMark(e, box) {
    e.preventDefault();
    const r0 = box.getBoundingClientRect(), k = +box.dataset.page;
    const at = (ev) => [Math.max(0, Math.min(r0.width, ev.clientX - r0.left)), Math.max(0, Math.min(r0.height, ev.clientY - r0.top))];
    const a = at(e);
    let b = a;
    const rb = mk('div', 'att-pdfmark drawing'); box.append(rb);
    const paint = () => Object.assign(rb.style, { left: `${Math.min(a[0], b[0])}px`, top: `${Math.min(a[1], b[1])}px`, width: `${Math.abs(b[0] - a[0])}px`, height: `${Math.abs(b[1] - a[1])}px` });
    const mv = (ev) => { b = at(ev); paint(); };
    const up = async (ev) => {
      removeEventListener('pointermove', mv); removeEventListener('pointerup', up); removeEventListener('pointercancel', up);
      b = at(ev); rb.remove();
      if (Math.abs(b[0] - a[0]) < 8 || Math.abs(b[1] - a[1]) < 8) return toast('조금 더 크게 끌어 영역을 그려요');
      const R = (v) => Math.round(v * 10000) / 10000;
      const r = [R(Math.min(a[0], b[0]) / r0.width), R(Math.min(a[1], b[1]) / r0.height), R(Math.abs(b[0] - a[0]) / r0.width), R(Math.abs(b[1] - a[1]) / r0.height)];
      const ans = await askText('북마크 이름', `${k}쪽`, [{ label: '취소', value: null }, { label: '만들기', value: 'save', primary: true }], '', { select: true });
      if (!ans) return;
      const m = addMark('pdf', f.url, { page: k, r, name: ans.text.trim() || `${k}쪽` });
      setMarking(false);
      copyMarkLink(m.name, markHref('pdf', f.url, m, { n: nodeIdOf() }));
    };
    addEventListener('pointermove', mv); addEventListener('pointerup', up); addEventListener('pointercancel', up);
    paint();
  }
  // 북마크(또는 링크)로: 펼치고 · 불러오고 · 그 페이지의 그 영역이 보이게 스크롤해 잠깐 강조
  async function goMark(m) {
    if (edit) await leaveEdit();
    if (view.hidden) { setFold(false); savePdfFold(f.url, false); }
    await start();
    for (let i = 0; i < 100 && !pages.length; i++) await new Promise((r) => setTimeout(r, 50));
    const box = pages[Math.min(pages.length, Math.max(1, m.page)) - 1];
    if (!box) return toast('그 페이지가 없어요');
    await draw(box);
    const top = box.offsetTop + (m.r?.[1] ?? 0) * box.offsetHeight;
    view.scrollTop = Math.max(0, top - Math.max(24, (view.clientHeight - (m.r?.[3] ?? 0) * box.offsetHeight) / 3));
    setPage(+box.dataset.page); pinPage(+box.dataset.page);
    if (!card.classList.contains('full')) card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    if (m.r) {
      paintMarkBoxes(box);
      let el = m.id ? box.querySelector(`.att-pdfmark[data-id="${m.id}"]`) : null;
      if (!el) { el = mk('div', 'att-pdfmark'); Object.assign(el.style, { left: `${m.r[0] * 100}%`, top: `${m.r[1] * 100}%`, width: `${m.r[2] * 100}%`, height: `${m.r[3] * 100}%` }); box.append(el); }
      el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 2600);
    }
  }
  // 그 쪽으로 가서 이 PDF 안에서 찾기 (여러 PDF 찾기에서 결과를 골랐을 때) — 그 쪽 · 뒤의 첫 결과를 칠해요
  card._goFind = async (q, p = 1, regex = false, nth = 0) => { // nth: 그 쪽에서 몇 번째 결과로 (0부터)
    if (edit) await leaveEdit();
    if (view.hidden) { setFold(false); savePdfFold(f.url, false); }
    await start();
    for (let i = 0; i < 100 && !pages.length; i++) await new Promise((r) => setTimeout(r, 50));
    if (!pages.length) return;
    const t = Math.min(pages.length, Math.max(1, p));
    await draw(pages[t - 1]); scrollTo(t); setPage(t);
    if (!card.classList.contains('full')) card.scrollIntoView({ block: 'nearest' });
    if (!q) return;
    findQ.value = q; findRxIn.checked = !!regex;
    findBar.hidden = false; findB.setAttribute('aria-pressed', true); findQ.focus(); findQ.select();
    await runFind();
    const i = hits.findIndex((h) => h.k === t) + nth;
    if (nth > 0 && hits[i]?.k === t) goHit(i);
  };
  card._openFull = async () => { if (view.hidden) setFold(false); setFull(true); await start(); };
  // 화면 가득 + 편집으로 바로 (note 플러그인이 새 노트를 열 때)
  card._openEdit = async () => {
    if (view.hidden) setFold(false);
    await start();
    for (let i = 0; i < 100 && !doc; i++) await new Promise((r) => setTimeout(r, 50));
    setFull(true);
    if (!edit) await editB.onclick();
    if (edit && !tool) { tool = 'pen'; showEdit(); }
  };
  card._goMark = (p, r) => {
    const m = (pdfMarks.get(f.url) || []).find((x) => x.page === p && r && x.r.every((v, i) => Math.abs(v - r[i]) < 0.0002));
    return goMark(m || { page: p, r });
  };
  bSave.onclick = async () => {
    if (!ops.length || busy) return;
    const id = +(card.closest('.node')?.querySelector(':scope > .row')?.dataset.id ?? state.zoom); // 항목 아래 첨부 · 아니면 제목 아래 첨부(들어와 있는 항목)
    const n = state.nodes.get(id);
    if (!n) return toast('이 PDF가 들어 있는 항목을 찾지 못했어요', 4000);
    busy = true; bSave.textContent = '저장 중…';
    try {
      const bytes = await build();
      const fd = new FormData(); fd.append('file', new Blob([bytes], { type: 'application/pdf' }), `${f.name.replace(/\.pdf$/i, '')}.pdf`); // 글에 적힌 이름에는 확장자가 없을 수 있어요
      const r = await (await fetch('/api/upload', { method: 'POST', headers: { 'X-Client-Id': CLIENT_ID }, body: fd })).json();
      if (r.error) throw new Error(r.error);
      saveMediaPos(r.url, { page: cur, fit }, true); // 고친 파일도 보던 페이지 · 맞춤 그대로
      // 북마크도 고친 파일로 (페이지를 지우 · 옮기 · 돌리지 않았을 때만 — 그러면 쪽 · 영역이 그대로예요)
      if (!ops.some((o) => o.t === 'del' || o.t === 'move' || o.t === 'rot')) copyMarks('pdf', f.url, r.url);
      await flushAll();
      const wasFull = card.classList.contains('full') && !editFull; // 편집하려고 화면 가득으로 갔던 거면 저장 뒤엔 원래대로
      if (card.classList.contains('full')) setFull(false); // 이 카드는 고친 파일의 새 카드로 바뀌어요 → 화면 가득은 새 카드에서 이어서
      await updateNode(id, { content: n.content.split(f.url).join(r.url) }); // 이 항목의 첨부를 고친 파일로 (원래 파일은 첨부 관리에서 지울 수 있어요)
      if (wasFull) requestAnimationFrame(() => document.querySelector(`.att-pdf[data-url="${CSS.escape(r.url)}"]`)?._openFull?.());
      edit = false; ops = []; editFull = false;
      toast('고친 PDF를 저장했어요');
    } catch (e) { toast(`저장하지 못했어요: ${e.message}`, 4000); } finally { busy = false; bSave.textContent = '저장'; showEdit(); }
  };
  showEdit();
  // 화면에 가까워지면 그때 불러와요 (항목이 많아도 가볍게)
  const near = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { near.disconnect(); pdfFoldReady.then(start); } }, { rootMargin: '400px 0px' });
  near.observe(card);
  pdfFoldReady.then(() => { if (pdfFolded.has(f.url) && !started) setFold(true); }); // 접어 둔 PDF는 접힌 채로 (불러오기 전에)
  return card;
}

export { pdfFolded, pdfFoldReady, savePdfFold, pdfjsP, pdfDocs, PDFJS, loadPdf, pdfText, NOTE_SIZES, drawNotePage, notePdf, pdfOpts, annotNum, pdfCard };
