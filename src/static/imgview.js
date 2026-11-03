// 이미지 보기: 크게 보기 · 확대 · 북마크 · 마크업(다시 고치기)

import { CLIENT_ID, http, mk, state, toast } from './base.js';
import { busy as loadingBar } from './progress.js';
import { flushAll, updateNode } from './app.js';
import { askText, confirmDelete } from './dialog.js';
import { copyMarkLink, downloadAttachment, markHref, markList } from './marks.js';
import { addMark, copyMarks, imgInk, imgMarks, nearPolyline, PDF_ICON, pdfIconBtn, PEN, penPick, penStyle, rgbCss, saveImgInk, simplifyPts, svgPathD } from './markup.js';

// ---- 이미지 보기: 새 탭 대신 이 화면 안에서 크게 (PDF 화면 가득과 같은 모양) ----
// 앞뒤 이미지(화면에 있는 이미지들 순서대로) · 휠 · 두 손가락 · 더블클릭으로 확대 · 끌어서 이동,
// '링크 복사'는 지금 보고 있는 영역까지 담아요 → 그 링크를 열면 같은 이미지 · 같은 영역으로 열려요.
// 북마크: 이미지의 사각형 영역 → 링크 (…/?img=파일&r=영역#보던 화면). DB(plugin_data 'core' img_marks)에 이미지마다 — PDF 북마크와 같아요.
// 마크업(연필): 펜 · 형광펜 · 지우개 · 글자 — PDF 편집과 같은 도구 · 색 · 굵기. 저장하면 그린 것을 입힌 새 이미지로 이 항목의 첨부를 바꿔요.
const imgViewer = (() => {
  let ov = null, stage = null, img = null, name = null, count = null, zoomTxt = null, prevB = null, nextB = null;
  let list = [], at = 0, s = 1, tx = 0, ty = 0, fitS = 1, pending = null, lastW = 0, lastH = 0;
  let ink = null, bar = null, editB = null, penOpts = null, bUndo = null, bSave = null, info = null, tools = [];
  let edit = false, tool = null, marks = [], undo = [], busy = false, abortDraw = null;
  let editBase = null, loaded = '[]'; // 다시 고치는 중이면 원본 주소 · 처음 불러온 그린 것 (바뀌었는지 보려고)
  const changed = () => JSON.stringify(marks) !== loaded;
  let markB = null, markPanel = null, markAddB = null, marksUi = null, boxes = null, marking = false, flashR = null;
  const SVG = 'http://www.w3.org/2000/svg';
  const W = () => stage.clientWidth, H = () => stage.clientHeight;
  const nat = () => [img.naturalWidth || 1, img.naturalHeight || 1];
  function build() {
    ov = mk('div', 'att-pdf full imgview'); ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-label', '이미지 보기'); ov.tabIndex = -1;
    const head = mk('div', 'att-pdfhead');
    name = mk('span', 'att-name');
    count = mk('span', 'att-pdfpage');
    zoomTxt = mk('button', 'att-btn imgview-zoom'); zoomTxt.type = 'button'; zoomTxt.title = '화면에 맞추기'; zoomTxt.onclick = () => { fit(); apply(); };
    const btn = (icon, label, fn) => { const b = pdfIconBtn(icon, label); b.onclick = fn; return b; };
    prevB = btn('prev', '이전 이미지 (←)', () => go(at - 1));
    nextB = btn('next', '다음 이미지 (→)', () => go(at + 1));
    const zout = btn('zout', '축소 (-)', () => zoomBy(1 / 1.4)), zin = btn('zin', '확대 (+)', () => zoomBy(1.4));
    const downB = btn('download', '이미지 내려받기', download), openB = btn('open', '원본을 새 탭에서', () => window.open(list[at].url, '_blank', 'noopener'));
    head.append(name, count, prevB, nextB, zout, zoomTxt, zin, btn('fit', '화면에 맞추기 (0)', () => { fit(); apply(); }),
      markB = btn('mark', '북마크 (영역을 지정해 링크로)', toggleMarks), downB, openB, btn('close', '닫기 (Esc)', close));
    for (const b of [name, count, prevB, nextB, zout, zin, markB, downB, openB]) b.classList.add('edit-hide'); // 좁은 화면 마크업 중에는 숨겨 그림 칸을 넓게
    editB = btn('edit', '마크업 (펜 · 형광펜 · 지우개 · 글자)', () => setEdit(!edit)); editB.classList.add('att-fit');
    markB.classList.add('att-fit');
    head.insertBefore(editB, markB);
    // 북마크 칸: '영역 지정' + 목록 (누르면 그 영역으로 · 이름 고치기 · 링크 복사 · 지우기)
    markPanel = mk('div', 'att-pdfmarks'); markPanel.hidden = true;
    markAddB = mk('button', 'att-btn att-markadd'); markAddB.type = 'button'; markAddB.onclick = () => setMarking(!marking);
    marksUi = markList({
      kind: 'img', url: () => list[at]?.url, sort: (a, b) => a.r[1] - b.r[1] || a.r[0] - b.r[0],
      go: (m) => goMark(m), link: (m) => markHref('img', list[at].url, m), refocus: () => ov.focus({ preventScroll: true }),
    });
    markPanel.append(markAddB, marksUi.find, marksUi.list);
    setMarking(false);
    document.addEventListener('imgmarks', () => { if (!ov.hidden) paintMarks(); });
    // 마크업 막대: 도구 · 색 · 굵기 · 되돌리기 · 취소 · 저장
    bar = mk('div', 'att-pdfbar imgview-bar'); bar.hidden = true;
    tools = [['pen', '펜 — 끌어서 그려요 (Shift · 끝에서 잠깐 멈추면 직선)'], ['hl', '형광펜 — 끌어서 칠해요 (Shift · 끝에서 잠깐 멈추면 직선)'], ['erase', '지우개 — 문지르면 펜 · 형광펜 자국을 지워요'], ['text', '글자 — 누른 자리에 글을 넣어요 (넣은 글은 끌어서 옮기고, 누르면 고치거나 지워요)']]
      .map(([v, label]) => { const b = btn(v, label, () => { tool = tool === v ? null : v; showEdit(); }); b.classList.add('att-fit'); b.dataset.tool = v; return b; });
    penOpts = mk('span', 'att-pdfopts'); penOpts.hidden = true;
    bUndo = btn('undo', '되돌리기 (⌘Z)', doUndo);
    info = mk('span', 'att-pdfinfo');
    const bCancel = mk('button', 'att-btn'); bCancel.type = 'button'; bCancel.textContent = '취소'; bCancel.onclick = () => setEdit(false);
    bSave = mk('button', 'att-btn primary'); bSave.type = 'button'; bSave.textContent = '저장'; bSave.onclick = save;
    const acts = mk('span', 'att-pdfacts'); acts.append(bUndo, info, bCancel, bSave);
    bar.append(...tools, penOpts, acts);
    stage = mk('div', 'att-pdfview imgview-stage');
    img = mk('img', 'imgview-img'); img.alt = ''; img.draggable = false;
    img.addEventListener('load', () => { sizeInk(); if (pending) { const v = pending; pending = null; place(v); } showFlash(); });
    // 큰 이미지를 받는 동안 맨 위 진행 막대 (src가 바뀔 때마다)
    let loadingJob = null;
    const endLoad = () => { loadingJob?.done(); loadingJob = null; };
    new MutationObserver(() => { endLoad(); if (img.getAttribute('src') && !img.complete) loadingJob = loadingBar(); }).observe(img, { attributes: true, attributeFilter: ['src'] });
    img.addEventListener('load', endLoad); img.addEventListener('error', endLoad);
    ink = document.createElementNS(SVG, 'svg'); ink.setAttribute('class', 'imgview-ink');
    boxes = mk('div', 'imgview-boxes');
    stage.append(img, ink, boxes);
    ov.append(head, markPanel, bar, stage);
    document.body.append(ov);
    // 휠: 커서 자리를 중심으로 확대 · 축소 (트랙패드 두 손가락 이동은 이동)
    stage.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = stage.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) >= 40 && !e.deltaX) zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002)), e.clientX - r.left, e.clientY - r.top);
      else { tx -= e.deltaX; ty -= e.deltaY; apply(); }
    }, { passive: false });
    // 끌어서 이동 · 두 손가락 벌리기로 확대
    const pts = new Map();
    let last = null;
    stage.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.pointerType === 'touch' && abortDraw) { const f = abortDraw(); pts.set(f.id, { x: f.x, y: f.y }); } // 마크업 중에도 두 손가락이면 확대 · 이동
      if (marking && !pts.size) return drawMark(e);
      if (edit && !pts.size && markDown(e)) return; // 마크업 중이면 그리기 · 지우기 · 글자 (도구가 없으면 평소처럼 이동)
      try { stage.setPointerCapture(e.pointerId); } catch { /* 이미 끝난 손가락 */ }
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      last = null;
      stage.classList.add('grabbing');
    });
    stage.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId)) return;
      const p = pts.get(e.pointerId);
      if (pts.size === 1) { tx += e.clientX - p.x; ty += e.clientY - p.y; apply(); }
      p.x = e.clientX; p.y = e.clientY;
      if (pts.size === 2) {
        const [a, b] = [...pts.values()], r = stage.getBoundingClientRect();
        const d = Math.hypot(a.x - b.x, a.y - b.y), cx = (a.x + b.x) / 2 - r.left, cy = (a.y + b.y) / 2 - r.top;
        if (last) { tx += cx - last.cx; ty += cy - last.cy; zoomAt(d / last.d, cx, cy); }
        last = { d, cx, cy };
      }
    });
    const up = (e) => { pts.delete(e.pointerId); last = null; if (!pts.size) stage.classList.remove('grabbing'); };
    stage.addEventListener('pointerup', up); stage.addEventListener('pointercancel', up);
    stage.addEventListener('dblclick', (e) => { const r = stage.getBoundingClientRect(); if (s > fitS * 1.05) { fit(); apply(); } else zoomAt(2.5, e.clientX - r.left, e.clientY - r.top); });
    ov.addEventListener('keydown', (e) => {
      if (edit && e.key === 'z' && (e.metaKey || e.ctrlKey) && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); return doUndo(); }
      if (marking && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); return setMarking(false); }
      const k = { ArrowLeft: () => go(at - 1), ArrowRight: () => go(at + 1), Escape: close, '+': () => zoomBy(1.4), '=': () => zoomBy(1.4), '-': () => zoomBy(1 / 1.4), 0: () => { fit(); apply(); } }[e.key];
      if (e.key === 'c' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.stopPropagation(); return copyLink(); }
      if (!k || e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault(); e.stopPropagation(); k();
    });
    addEventListener('resize', () => { if (!ov.hidden && img.complete) place(view(lastW, lastH)); }); // 크기가 바뀌기 전 화면으로 본 영역을 그대로
  }
  function apply() {
    const [w, h] = nat(), sw = w * s, sh = h * s;
    // 화면보다 작으면 가운데, 크면 가장자리 밖으로 너무 나가지 않게
    tx = sw <= W() ? (W() - sw) / 2 : Math.min(0, Math.max(W() - sw, tx));
    ty = sh <= H() ? (H() - sh) / 2 : Math.min(0, Math.max(H() - sh, ty));
    img.style.transform = ink.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
    lastW = W(); lastH = H();
    posBoxes();
    zoomTxt.textContent = `${Math.round(s * 100)}%`;
  }
  function fit() { const [w, h] = nat(); fitS = Math.min(W() / w, H() / h, 1); s = fitS; tx = (W() - w * s) / 2; ty = (H() - h * s) / 2; }
  function zoomAt(f, cx, cy) {
    const ns = Math.min(Math.max(s * f, fitS * 0.5, 0.02), Math.max(fitS * 40, 8));
    tx = cx - (cx - tx) * (ns / s); ty = cy - (cy - ty) * (ns / s); s = ns;
    apply();
  }
  const zoomBy = (f) => zoomAt(f, W() / 2, H() / 2);
  // 지금 보이는 영역 (이미지 기준 0~1 비율) — 화면 크기가 달라도 같은 영역이 보이게
  function view(sw = W(), sh = H()) {
    const [w, h] = nat(), r = (v) => Math.round(v * 10000) / 10000;
    const x0 = Math.max(0, -tx / s / w), y0 = Math.max(0, -ty / s / h);
    const x1 = Math.min(1, (sw - tx) / s / w), y1 = Math.min(1, (sh - ty) / s / h);
    return [r(x0), r(y0), r(x1 - x0), r(y1 - y0)];
  }
  // 영역(없으면 화면에 맞추기)으로 보여 주기
  function place(v) {
    fit();
    if (v && v.length === 4 && v.every(Number.isFinite) && v[2] > 0 && v[3] > 0 && (v[2] < 0.999 || v[3] < 0.999)) {
      const [w, h] = nat();
      s = Math.min(W() / (v[2] * w), H() / (v[3] * h));
      tx = W() / 2 - (v[0] + v[2] / 2) * w * s; ty = H() / 2 - (v[1] + v[3] / 2) * h * s;
    }
    apply();
  }
  function go(i, v = null) {
    if (i < 0 || i >= list.length || !leaveEdit()) return;
    at = i;
    const it = list[at];
    name.textContent = it.label;
    count.textContent = list.length > 1 ? `${at + 1} / ${list.length}` : '';
    prevB.disabled = at === 0; nextB.disabled = at === list.length - 1;
    prevB.hidden = nextB.hidden = list.length < 2;
    pending = v || 'fit';
    marks = []; undo = []; if (ink) paintInk();
    paintMarks();
    if (img.getAttribute('src') === it.url && img.complete) { pending = null; place(v); showFlash(); } else img.src = it.url;
  }
  function open(items, i, v = null) {
    if (!ov) build();
    list = items;
    ov.hidden = false;
    document.documentElement.classList.add('pdf-full'); // 뒤 화면은 감추고 스크롤 막기 (PDF 화면 가득과 같이)
    ov.focus({ preventScroll: true });
    requestAnimationFrame(() => go(i, v)); // 크기가 잡힌 뒤에 맞추기
  }
  function close() {
    if (!ov || ov.hidden || !leaveEdit()) return;
    ov.hidden = true;
    if (!document.querySelector('.att-pdf.full:not(.imgview)')) document.documentElement.classList.remove('pdf-full');
    if (location.search.includes('img=')) history.replaceState(null, '', location.pathname + location.hash); // 링크로 열었으면 주소를 원래대로
  }
  // ---- 마크업 ----
  const unit = () => Math.max(...nat()) / 700; // 굵기 · 글자 크기: 이미지 크기에 비례 (PDF 한 쪽 ≈ 700)
  const TEXT_SIZE = [16, 24, 36];
  function sizeInk() { const [w, h] = nat(); ink.setAttribute('width', w); ink.setAttribute('height', h); ink.setAttribute('viewBox', `0 0 ${w} ${h}`); }
  /** 그린 것을 저장하지 않고 나가도 되면 true (묻고 나서 마크업을 끝내요) */
  function leaveEdit() {
    if (!edit) return true;
    if (changed() && !confirm('저장하지 않은 마크업이 있어요. 버리고 나갈까요?')) return false;
    setEdit(false, true);
    return true;
  }
  /** 지금 이미지를 내려받기 — 올린 파일이면 글에 적힌 이름으로, 바깥 주소면 브라우저에 맡겨요 */
  function download() {
    const url = list[at]?.url; if (!url) return;
    const a = mk('a');
    if (/^\/files\/[^/?#]+$/.test(url)) return downloadAttachment(url, list[at].label || url.split('/').pop()); // 북마크가 있으면 파일에 담아서
    a.href = url; a.download = ''; a.target = '_blank'; a.rel = 'noopener';
    a.click();
  }
  async function setEdit(on, force = false) {
    if (!on && !force && changed() && !confirm('고친 마크업을 버릴까요?')) return;
    if (on && !markPanel.hidden) toggleMarks(); // 마크업과 북마크는 하나씩
    const url = list[at]?.url, d = on ? imgInk.get(url) : null;
    if (!on && editBase) { pending = view(); img.src = url; } // 원본에서 고치다 그만두면 저장한 이미지로
    edit = on; marks = []; undo = []; editBase = null;
    if (d) { // 전에 마크업한 이미지: 원본을 불러와 그 위에 그린 것을 다시 (하나하나 지우고 · 옮기고 · 더할 수 있게)
      const ok = await new Promise((res) => { const t = new Image(); t.onload = () => res(t.naturalWidth === img.naturalWidth && t.naturalHeight === img.naturalHeight); t.onerror = () => res(false); t.src = d.base; });
      if (ok && edit && list[at]?.url === url) { editBase = d.base; marks = JSON.parse(JSON.stringify(d.marks)); pending = view(); img.src = d.base; }
      else if (!ok) toast('마크업 원본을 찾지 못해서, 저장된 그림 위에 덧그려요', 3500);
    }
    loaded = JSON.stringify(marks);
    if (on && !tool) tool = 'pen';
    paintInk(); showEdit();
  }
  function showEdit() {
    editB.setAttribute('aria-pressed', edit); bar.hidden = !edit; ov.classList.toggle('editing', edit);
    stage.dataset.tool = edit && tool ? tool : '';
    for (const b of tools) b.setAttribute('aria-pressed', tool === b.dataset.tool);
    bUndo.disabled = !undo.length; bSave.disabled = !changed() || busy;
    info.textContent = marks.length ? `그린 것 ${marks.length}` : '';
    // 색 · 굵기 (글자는 펜 색 · 크기 3단계)
    const kind = tool === 'hl' ? 'hl' : tool === 'pen' || tool === 'text' ? 'pen' : null;
    penOpts.hidden = !kind;
    if (!kind) return;
    const P = PEN[kind], q = penPick[kind];
    const keep = () => { try { localStorage.setItem('outliner.pdfpen', JSON.stringify(penPick)); } catch {} showEdit(); };
    penOpts.replaceChildren(
      ...P.colors.map((c, i) => {
        const b = mk('button', 'att-swatch'); b.type = 'button'; b.style.setProperty('--c', rgbCss(c)); b.setAttribute('aria-pressed', q.c === i);
        b.title = '색'; b.setAttribute('aria-label', `색 ${i + 1}`); b.onclick = () => { q.c = i; keep(); };
        return b;
      }),
      ...P.widths.map((_, i) => {
        const b = mk('button', 'att-btn att-ico att-fit att-width'); b.type = 'button'; b.setAttribute('aria-pressed', q.w === i);
        const dot = mk('span', 'att-dot'), px = kind === 'hl' ? 5 + i * 3 : 2 + i * 2.5;
        Object.assign(dot.style, { width: `${px}px`, height: `${px}px`, background: rgbCss(P.colors[q.c] ?? P.colors[0]) });
        b.append(dot); b.title = tool === 'text' ? ['작게', '보통', '크게'][i] : ['가늘게', '보통', '굵게'][i]; b.setAttribute('aria-label', b.title); b.onclick = () => { q.w = i; keep(); };
        return b;
      }),
    );
  }
  const snap = () => { undo.push(JSON.stringify(marks)); if (undo.length > 200) undo.shift(); };
  function doUndo() { if (!undo.length) return; marks = JSON.parse(undo.pop()); paintInk(); showEdit(); }
  function inkPath(m) {
    const p = document.createElementNS(SVG, 'path');
    p.setAttribute('d', svgPathD(m.pts)); p.setAttribute('stroke', rgbCss(m.color)); p.setAttribute('stroke-opacity', m.alpha); p.setAttribute('stroke-width', m.width);
    if (m.alpha < 1) p.setAttribute('class', 'hl');
    return p;
  }
  function textEl(m, i) {
    const t = document.createElementNS(SVG, 'text');
    t.setAttribute('x', m.x); t.setAttribute('y', m.y); t.setAttribute('fill', rgbCss(m.color)); t.setAttribute('font-size', m.size); t.dataset.i = i;
    m.text.split('\n').forEach((line, k) => { const sp = document.createElementNS(SVG, 'tspan'); sp.setAttribute('x', m.x); sp.setAttribute('dy', k ? m.size * 1.2 : 0); sp.textContent = line || ' '; t.append(sp); });
    return t;
  }
  function paintInk() { ink.replaceChildren(...marks.map((m, i) => (m.t === 'text' ? textEl(m, i) : inkPath(m)))); }
  const imgPt = (e) => { const r = stage.getBoundingClientRect(), [w, h] = nat(); return [Math.max(0, Math.min(w, (e.clientX - r.left - tx) / s)), Math.max(0, Math.min(h, (e.clientY - r.top - ty) / s))]; };
  async function askMarkText(m) {
    const r = await askText(m ? '글자 고치기' : '글자 넣기', m?.text ?? '', m
      ? [{ label: '지우기', value: 'del', danger: true }, { label: '취소', value: null }, { label: '고치기', value: 'ok', primary: true }]
      : [{ label: '취소', value: null }, { label: '넣기', value: 'ok', primary: true }]);
    ov.focus({ preventScroll: true });
    return r;
  }
  /** 마크업 중 누르기: 처리했으면 true */
  function markDown(e) {
    const hitText = e.target.closest?.('.imgview-ink text');
    if (hitText && tool !== 'pen' && tool !== 'hl' && tool !== 'erase') { dragText(e, +hitText.dataset.i); return true; }
    if (!tool) return false;
    e.preventDefault();
    if (tool === 'text') {
      const [x, y] = imgPt(e), q = penPick.pen;
      askMarkText(null).then((r) => {
        if (r?.action !== 'ok' || !r.text) return;
        const size = TEXT_SIZE[q.w] * unit();
        snap(); marks.push({ t: 'text', x, y: y + size * 0.85, text: r.text, color: PEN.pen.colors[q.c] ?? PEN.pen.colors[0], size }); // 누른 자리가 글의 왼쪽 위 (y는 첫 줄 기준선)
        paintInk(); showEdit();
      });
      return true;
    }
    if (tool === 'erase') { eraseDrag(e); return true; }
    drawDrag(e);
    return true;
  }
  function dragText(e, i) {
    const m = marks[i], el = ink.querySelector(`text[data-i="${i}"]`), [x0, y0] = imgPt(e), mx = m.x, my = m.y;
    let moved = false;
    try { stage.setPointerCapture(e.pointerId); } catch {}
    const move = (ev) => {
      const [x, y] = imgPt(ev);
      if (!moved && Math.hypot(x - x0, y - y0) * s < 4) return;
      if (!moved) { moved = true; snap(); el.classList.add('dragging'); }
      m.x = mx + x - x0; m.y = my + y - y0;
      el.setAttribute('x', m.x); el.setAttribute('y', m.y); for (const sp of el.children) sp.setAttribute('x', m.x);
    };
    const up = () => {
      stage.removeEventListener('pointermove', move); stage.removeEventListener('pointerup', up); stage.removeEventListener('pointercancel', up);
      if (moved) { paintInk(); showEdit(); return; }
      askMarkText(m).then((r) => {
        if (!r?.action) return;
        snap();
        if (r.action === 'del' || !r.text) marks.splice(i, 1); else m.text = r.text;
        paintInk(); showEdit();
      });
    };
    stage.addEventListener('pointermove', move); stage.addEventListener('pointerup', up); stage.addEventListener('pointercancel', up);
  }
  function eraseDrag(e) {
    let snapped = false;
    const rub = (ev) => {
      const [x, y] = imgPt(ev), d = 8 / s;
      const keep = marks.filter((m) => m.t === 'text' || !nearPolyline(m.pts, x, y, d + m.width / 2));
      if (keep.length === marks.length) return;
      if (!snapped) { snap(); snapped = true; }
      marks = keep; paintInk(); showEdit();
    };
    let last = { id: e.pointerId, x: e.clientX, y: e.clientY };
    const track = (ev) => { last = { id: ev.pointerId, x: ev.clientX, y: ev.clientY }; rub(ev); };
    rub(e);
    const up = () => { removeEventListener('pointermove', track); removeEventListener('pointerup', up); abortDraw = null; };
    abortDraw = () => { up(); return last; };
    addEventListener('pointermove', track); addEventListener('pointerup', up);
  }
  function drawDrag(e) {
    const st = penStyle(tool), p0 = imgPt(e), pts = [p0];
    const m = { t: 'ink', pts, color: st.color, alpha: st.alpha, width: st.width * unit() };
    const path = inkPath(m); ink.append(path);
    // 직선: Shift를 누르고 그리거나, 긋다가 잠깐 멈추면 처음 점에서 지금 점까지 곧은 선으로 (PDF 펜과 같아요)
    let straight = false, end = p0, holdAt = p0, hold = 0;
    const shown = () => (straight ? [pts[0], end] : pts);
    const paint = () => path.setAttribute('d', svgPathD(shown()));
    const armHold = () => { clearTimeout(hold); hold = setTimeout(() => { if (!straight && pts.length > 3 && Math.hypot(end[0] - p0[0], end[1] - p0[1]) * s > 24) { straight = true; paint(); } }, 550); };
    const move = (ev) => {
      const evs = ev.getCoalescedEvents?.();
      for (const ce of evs?.length ? evs : [ev]) {
        const p = imgPt(ce), q = pts.at(-1);
        end = p;
        if (!straight && Math.hypot(p[0] - q[0], p[1] - q[1]) * s >= 1.5) pts.push(p);
      }
      if (ev.shiftKey) straight = true;
      if (Math.hypot(end[0] - holdAt[0], end[1] - holdAt[1]) * s > 4) { holdAt = end; armHold(); }
      paint();
    };
    paint(); armHold();
    let last = { id: e.pointerId, x: e.clientX, y: e.clientY };
    const track = (ev) => { last = { id: ev.pointerId, x: ev.clientX, y: ev.clientY }; move(ev); };
    const off = () => { removeEventListener('pointermove', track); removeEventListener('pointerup', up); clearTimeout(hold); abortDraw = null; };
    abortDraw = () => { off(); path.remove(); return last; }; // 두 번째 손가락이 닿으면 긋던 선은 버리고 확대 · 이동으로
    const up = (ev) => {
      off();
      move(ev);
      const line = shown();
      if (line.length < 2 || (line.length === 2 && Math.hypot(line[1][0] - line[0][0], line[1][1] - line[0][1]) < 0.5 / s)) line.splice(1, line.length, [line[0][0] + 0.5 / s, line[0][1]]); // 한 번 콕 = 점
      snap(); marks.push({ ...m, pts: simplifyPts(line, 0.4 / s) });
      paintInk(); showEdit();
    };
    addEventListener('pointermove', track); addEventListener('pointerup', up);
  }
  /** 그린 것을 입힌 새 이미지를 올리고, 이 이미지가 든 항목의 첨부를 그 파일로 바꿔요 (원래 파일은 첨부 관리에서 지울 수 있어요) */
  async function save() {
    if (!changed() || busy) return;
    const it = list[at], url = it.url, base = editBase || url; // 지금 화면의 그림(img) = 원본
    const nid = it.el?.closest('.node')?.dataset.nid;
    let n = state.nodes.get(nid != null ? +nid : state.zoom);
    if (!n?.content.includes(url)) n = [...state.nodes.values()].find((x) => x.content?.includes(url));
    if (!n) return toast('이 이미지가 들어 있는 항목을 찾지 못했어요', 4000);
    busy = true; bSave.textContent = '저장 중…'; showEdit();
    try {
      if (!marks.length && editBase) { // 그린 것을 다 지웠으면 원본으로 되돌려요 (새 파일 없이)
        await flushAll();
        copyMarks('img', url, base);
        await updateNode(n.id, { content: n.content.split(url).join(base) });
        const v = view();
        marks = []; undo = []; edit = false; editBase = null; loaded = '[]';
        it.url = base; it.el = null; pending = v; img.src = base;
        paintInk(); toast('마크업을 지워 원본 이미지로 되돌렸어요');
        return;
      }
      const [w, h] = nat(), c = document.createElement('canvas');
      c.width = w; c.height = h;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      for (const m of marks) {
        g.save();
        if (m.t === 'text') {
          g.fillStyle = rgbCss(m.color); g.font = `${m.size}px ${getComputedStyle(document.body).fontFamily}`; g.textBaseline = 'alphabetic';
          m.text.split('\n').forEach((line, k) => g.fillText(line, m.x, m.y + k * m.size * 1.2));
        } else {
          g.globalAlpha = m.alpha; if (m.alpha < 1) g.globalCompositeOperation = 'multiply';
          g.strokeStyle = rgbCss(m.color); g.lineWidth = m.width; g.lineCap = g.lineJoin = 'round';
          g.stroke(new Path2D(svgPathD(m.pts)));
        }
        g.restore();
      }
      const jpg = /\.jpe?g$/i.test(url);
      const blob = await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('이미지를 만들지 못했어요'))), jpg ? 'image/jpeg' : 'image/png', 0.92));
      const fd = new FormData(); fd.append('file', blob, `${(it.label || 'image').replace(/[\\/:*?"<>|]/g, '').slice(0, 40) || 'image'}.${jpg ? 'jpg' : 'png'}`);
      const r = await (await fetch('/api/upload', { method: 'POST', headers: { 'X-Client-Id': CLIENT_ID }, body: fd })).json();
      if (r.error) throw new Error(r.error);
      await flushAll();
      copyMarks('img', url, r.url); // 북마크도 새 파일로 (영역은 그대로)
      imgInk.set(r.url, { base, marks: JSON.parse(JSON.stringify(marks)) }); saveImgInk(); // 원본 + 그린 것을 기억해 다음에 다시 고칠 수 있게
      await updateNode(n.id, { content: n.content.split(url).join(r.url) });
      const v = view();
      marks = []; undo = []; edit = false; editBase = null; loaded = '[]';
      it.url = r.url; it.el = null;
      pending = v; img.src = r.url;
      paintInk();
      toast('마크업한 이미지를 저장했어요');
    } catch (err) { toast(`저장하지 못했어요: ${err.message}`, 4000); } finally { busy = false; bSave.textContent = '저장'; showEdit(); }
  }
  // ---- 북마크 ----
  const curMarks = () => (list[at] ? imgMarks.get(list[at].url) || [] : []);
  function setMarking(on) {
    marking = on; stage?.classList.toggle('marking', on);
    markAddB.innerHTML = PDF_ICON.markAdd; markAddB.append(on ? ' 이미지 위에서 끌어 영역을 그려요 (Esc 취소)' : ' 영역 지정해 북마크 만들기');
    markAddB.setAttribute('aria-pressed', on);
  }
  function toggleMarks() {
    if (edit) return toast('마크업 중에는 북마크를 만들 수 없어요 — 저장하거나 취소한 뒤에');
    markPanel.hidden = !markPanel.hidden;
    ov.classList.toggle('marks', !markPanel.hidden);
    if (markPanel.hidden) setMarking(false);
    paintMarks();
  }
  function paintMarks() {
    if (!ov) return;
    markB.setAttribute('aria-pressed', !markPanel.hidden);
    marksUi.paint();
    boxes.replaceChildren(...curMarks().map((m) => {
      const el = mk('div', 'att-pdfmark'); el.dataset.id = m.id; el._r = m.r;
      const tag = mk('span', 'att-pdfmarktag'); tag.textContent = m.name; el.append(tag);
      return el;
    }));
    posBoxes();
  }
  /** 영역 상자들을 지금 배율 · 위치에 맞춰 (테두리 굵기는 그대로) */
  function posBoxes() {
    if (!boxes) return;
    const [w, h] = nat();
    for (const el of boxes.children) {
      const r = el._r;
      if (r) Object.assign(el.style, { left: `${tx + r[0] * w * s}px`, top: `${ty + r[1] * h * s}px`, width: `${r[2] * w * s}px`, height: `${r[3] * h * s}px` });
    }
  }
  /** 영역이 화면 가운데 보이게 (둘레에 여유를 두고) */
  const around = (r) => { const p = 0.12, x = Math.max(0, r[0] - r[2] * p), y = Math.max(0, r[1] - r[3] * p); return [x, y, Math.min(1, r[0] + r[2] * (1 + p)) - x, Math.min(1, r[1] + r[3] * (1 + p)) - y]; };
  function showFlash() {
    if (!flashR) return;
    const r = flashR; flashR = null;
    let el = [...boxes.children].find((x) => x._r && x._r.every((v, i) => Math.abs(v - r[i]) < 0.0002));
    if (!el) { el = mk('div', 'att-pdfmark'); el._r = r; boxes.append(el); posBoxes(); }
    el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 2600);
  }
  function goMark(m) { place(around(m.r)); flashR = m.r; showFlash(); }
  function drawMark(e) {
    e.preventDefault();
    const r0 = stage.getBoundingClientRect(), [w, h] = nat();
    // 이미지 안쪽으로만
    const at2 = (ev) => [Math.max(tx, Math.min(tx + w * s, ev.clientX - r0.left)), Math.max(ty, Math.min(ty + h * s, ev.clientY - r0.top))];
    const a = at2(e);
    let b = a;
    const rb = mk('div', 'att-pdfmark drawing'); boxes.append(rb);
    const paint = () => Object.assign(rb.style, { left: `${Math.min(a[0], b[0])}px`, top: `${Math.min(a[1], b[1])}px`, width: `${Math.abs(b[0] - a[0])}px`, height: `${Math.abs(b[1] - a[1])}px` });
    const mv = (ev) => { b = at2(ev); paint(); };
    const up = async (ev) => {
      removeEventListener('pointermove', mv); removeEventListener('pointerup', up); removeEventListener('pointercancel', up);
      b = at2(ev); rb.remove();
      if (Math.abs(b[0] - a[0]) < 8 || Math.abs(b[1] - a[1]) < 8) return toast('조금 더 크게 끌어 영역을 그려요');
      const R = (v) => Math.round(v * 10000) / 10000;
      const r = [R((Math.min(a[0], b[0]) - tx) / s / w), R((Math.min(a[1], b[1]) - ty) / s / h), R(Math.abs(b[0] - a[0]) / s / w), R(Math.abs(b[1] - a[1]) / s / h)];
      const url = list[at].url, name0 = `영역 ${(imgMarks.get(url)?.length || 0) + 1}`;
      const ans = await askText('북마크 이름', name0, [{ label: '취소', value: null }, { label: '만들기', value: 'save', primary: true }], '', { select: true });
      ov.focus({ preventScroll: true });
      if (!ans) return;
      const m = addMark('img', url, { r, name: ans.text.trim() || name0 });
      setMarking(false);
      copyMarkLink(m.name, markHref('img', url, m));
    };
    addEventListener('pointermove', mv); addEventListener('pointerup', up); addEventListener('pointercancel', up);
    paint();
  }
  async function copyLink() {
    const it = list[at];
    const q = new URLSearchParams({ img: it.url });
    const v = view();
    if (v[2] < 0.999 || v[3] < 0.999) q.set('v', v.join(','));
    const url = `${location.origin}/?${q}${state.zoom === null ? '' : `#${state.zoom}`}`;
    try { await navigator.clipboard.writeText(url); toast('지금 보는 영역의 링크를 복사했어요'); } catch { toast(url, 6000); }
  }
  // 화면에 있는 이미지들 (문서 순서) → 보기 목록
  const onScreen = () => [...document.querySelectorAll('#titleatt .att-img, #tree .att-img')].map((a) => {
    const url = a.getAttribute('href');
    const nid = a.closest('.node')?.dataset.nid;
    const node = state.nodes.get(nid != null ? +nid : state.zoom);
    const text = node ? node.content.replace(/!?\[[^\]]*\]\([^)]*\)/g, '').trim() : '';
    return { url, label: text || a.querySelector('img')?.alt || url.split('/').pop(), el: a };
  });
  return {
    // 첨부 이미지를 눌렀을 때
    openFrom(a) { const items = onScreen(); const i = items.findIndex((x) => x.el === a); open(items, Math.max(0, i)); },
    // 링크로: 그 이미지(화면에 있으면 앞뒤도 함께) · 영역
    openUrl(url, v, r) {
      const items = onScreen();
      let i = items.findIndex((x) => x.url === url);
      if (i < 0) { items.splice(0, items.length, { url, label: url.split('/').pop() }); i = 0; }
      if (r) { flashR = r; v = around(r); } // 북마크 링크: 그 영역을 가운데 · 잠깐 강조
      open(items, i, v);
    },
    close,
    isOpen: () => !!ov && !ov.hidden,
  };
})();

export { imgViewer };
