// 마크업 공용: PDF 편집 · 이미지 마크업 · 북마크 파일 담기(marks.js)가 함께 쓰는 것
//  · 단추 아이콘 · pdf-lib 불러오기 · 펜 자국 다듬기 · 펜 색과 굵기
//  · 북마크 저장소 (PDF · 이미지 · 오디오 · 영상) · 이미지 마크업 기록 (DB plugin_data 'core': pdf_marks · img_marks · media_marks · img_ink)
// 이 파일은 base.js만 써요 → pdf · imgview · marks가 서로를 부르지 않아도 돼요.
import { http, mk, toast } from './base.js';

// PDF 카드 버튼 아이콘 (16px · 선 굵기 1.6 · 글자색을 따라가요)
const PDF_ICON = Object.fromEntries(Object.entries({
  prev: '<path d="M10 3.5 5.5 8l4.5 4.5"/>',
  next: '<path d="M6 3.5 10.5 8 6 12.5"/>',
  fitW: '<rect x="1.8" y="3" width="12.4" height="10" rx="1.6"/><path d="M4.8 8h6.4M4.8 8l1.7-1.7M4.8 8l1.7 1.7M11.2 8 9.5 6.3M11.2 8l-1.7 1.7"/>',
  fitH: '<rect x="3" y="1.8" width="10" height="12.4" rx="1.6"/><path d="M8 4.8v6.4M8 4.8 6.3 6.5M8 4.8l1.7 1.7M8 11.2 6.3 9.5M8 11.2l1.7-1.7"/>',
  edit: '<path d="M10.3 3.2 12.8 5.7 6 12.5l-3.1.6.6-3.1z"/><path d="M8.8 4.7l2.5 2.5"/>',
  full: '<path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/>',
  unfull: '<path d="M6 2.5V6H2.5M13.5 6H10V2.5M10 13.5V10h3.5M2.5 10H6v3.5"/>',
  fold: '<path d="M3.5 10 8 5.5l4.5 4.5"/>',
  unfold: '<path d="M3.5 6 8 10.5 12.5 6"/>',
  hl: '<path d="m9.6 2.8 3.6 3.6-5.3 5.3H4.3V8.1z"/><path d="M2.5 14h11"/>',
  note: '<path d="M3 2.5h10v7.5l-3.5 3.5H3z"/><path d="M13 10H9.5v3.5M5.5 5.5h5M5.5 8h3"/>',
  pen: '<path d="M2.5 13.5c1.5-.3 2.6-1 3.4-1.8l6.6-6.6a1.4 1.4 0 0 0-2-2L3.9 9.7c-.8.8-1.5 1.9-1.4 3.8z"/><path d="M9.3 4.3l2 2"/>',
  text: '<path d="M3 4V2.8h10V4M8 2.8v10.4M6 13.2h4"/>',
  rotate: '<path d="M12.8 7.2A5 5 0 1 1 11 3.9"/><path d="M11.3 1.6v2.6h-2.6"/>',
  up: '<path d="M8 13V3.5M4 7.5l4-4 4 4"/>',
  down: '<path d="M8 3v9.5M4 8.5l4 4 4-4"/>',
  del: '<path d="M3 4.5h10M6.5 4.5V3.2c0-.4.3-.7.7-.7h1.6c.4 0 .7.3.7.7v1.3M4.3 4.5l.6 8.2c0 .7.6 1.3 1.3 1.3h3.6c.7 0 1.3-.6 1.3-1.3l.6-8.2"/>',
  merge: '<path d="M6 2.2h6.2a1 1 0 0 1 1 1v8.3"/><rect x="2.8" y="4.6" width="8" height="9.6" rx="1"/><path d="M6.8 6.8v4.6M4.9 9.6l1.9 1.9 1.9-1.9"/>',
  undo: '<path d="M5.5 3.5 2.8 6.2l2.7 2.7"/><path d="M2.8 6.2h6.7a3.6 3.6 0 0 1 0 7.2H6"/>',
  find: '<circle cx="7" cy="7" r="4.5"/><path d="m10.3 10.3 3.2 3.2"/>',
  zin: '<circle cx="7" cy="7" r="4.5"/><path d="m10.3 10.3 3.2 3.2M5 7h4M7 5v4"/>',
  zout: '<circle cx="7" cy="7" r="4.5"/><path d="m10.3 10.3 3.2 3.2M5 7h4"/>',
  fit: '<rect x="2" y="2.5" width="12" height="11" rx="1.6"/><path d="M5 6.5V5h1.5M11 6.5V5H9.5M5 9.5V11h1.5M11 9.5V11H9.5"/>',
  link: '<path d="M6.8 9.2a3 3 0 0 0 4.2 0l2-2a3 3 0 0 0-4.2-4.2l-.9.9M9.2 6.8a3 3 0 0 0-4.2 0l-2 2a3 3 0 0 0 4.2 4.2l.9-.9"/>',
  open: '<path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3"/>',
  close: '<path d="M4 4l8 8M12 4l-8 8"/>',
  erase: '<path d="M6 13.5h7.5M3.2 9.9 9.6 3.5a1.4 1.4 0 0 1 2 0l2 2a1.4 1.4 0 0 1 0 2L8 13.1a1.4 1.4 0 0 1-2 0L3.2 11.9a1.4 1.4 0 0 1 0-2z"/><path d="M6.4 6.7l4 4"/>',
  mark: '<path d="M4.5 2.5h7v11L8 10.8 4.5 13.5z"/>',
  download: '<path d="M8 2.5v8M4.8 7.5 8 10.7l3.2-3.2M3 13.5h10"/>',
  pageAdd: '<rect x="3.2" y="1.8" width="9.6" height="12.4" rx="1" stroke-dasharray="2.2 1.5"/><path d="M8 5.6v4.8M5.6 8h4.8"/>',
  markAdd: '<rect x="2" y="3.5" width="12" height="9" rx="1.2" stroke-dasharray="2.2 1.6"/><path d="M8 6v4M6 8h4"/>',
}).map(([k, d]) => [k, `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`]));
function pdfIconBtn(icon, label, tag = 'button') {
  const b = mk(tag, 'att-btn att-ico');
  if (tag === 'button') b.type = 'button';
  b.innerHTML = PDF_ICON[icon]; b.title = label; b.setAttribute('aria-label', label);
  return b;
}
let pdfLibP = null;
const pdfLib = () => (pdfLibP ??= import('/vendor/pdf-lib/pdf-lib.esm.min.js'));
// ---- 펜 자국 다듬기: 점들 → 부드러운 곡선 (가운데 점들을 지나는 2차 곡선), 저장 전에 쓸데없는 점 줄이기 ----
function smoothSegs(pts) {
  const out = [['M', pts[0]]];
  if (pts.length < 3) { for (const p of pts.slice(1)) out.push(['L', p]); return out; }
  for (let i = 1; i < pts.length - 1; i++) out.push(['Q', pts[i], [(pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2]]);
  out.push(['L', pts.at(-1)]);
  return out;
}
const svgPathD = (pts) => smoothSegs(pts).map(([t, a, b]) => `${t}${a[0].toFixed(1)} ${a[1].toFixed(1)}${b ? ` ${b[0].toFixed(1)} ${b[1].toFixed(1)}` : ''}`).join(' ') + (pts.length === 1 ? ' l0.01 0' : '');
/** 선을 거의 그대로 두고 점 수만 줄여요 (Ramer–Douglas–Peucker, eps = 허용 오차) */
function simplifyPts(pts, eps) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop(), [ax, ay] = pts[a], [bx, by] = pts[b], len = Math.hypot(bx - ax, by - ay) || 1e-9;
    let md = 0, mi = -1;
    for (let i = a + 1; i < b; i++) { const d = Math.abs((bx - ax) * (ay - pts[i][1]) - (ax - pts[i][0]) * (by - ay)) / len; if (d > md) { md = d; mi = i; } }
    if (md > eps) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
/** (x, y)가 꺾은선에서 d 안쪽인지 (지우개) */
const nearPolyline = (ps, x, y, d) => ps.some((p, i) => {
  const q = ps[i + 1] || p, dx = q[0] - p[0], dy = q[1] - p[1], l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((x - p[0]) * dx + (y - p[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] + t * dx - x, p[1] + t * dy - y) <= d;
});
// 펜 · 형광펜 색과 굵기 (PDF 단위 pt) — 마지막에 고른 것을 기억해요
const PEN = {
  pen: { colors: [[0.1, 0.1, 0.12], [0.86, 0.15, 0.15], [0.12, 0.38, 0.9], [0.1, 0.6, 0.32], [0.95, 0.52, 0.1]], widths: [0.8, 1.6, 3.2], alpha: 1 },
  hl: { colors: [[1, 0.85, 0.1], [0.45, 0.9, 0.35], [1, 0.5, 0.72], [0.35, 0.8, 1]], widths: [7, 12, 20], alpha: 0.4 },
  note: { colors: [[1, 0.85, 0.3], [0.55, 0.85, 0.4], [1, 0.6, 0.75], [0.5, 0.75, 1], [1, 0.6, 0.25]] }, // 메모 아이콘 색
};
const penPick = { pen: { c: 1, w: 1 }, hl: { c: 0, w: 1 }, note: { c: 0 } };
try { const v = JSON.parse(localStorage.getItem('outliner.pdfpen') || '{}'); for (const k of ['pen', 'hl', 'note']) if (v[k]) Object.assign(penPick[k], v[k]); } catch {}
const penStyle = (kind) => { const P = PEN[kind], q = penPick[kind]; return { color: P.colors[q.c] ?? P.colors[0], width: P.widths[q.w] ?? P.widths[1], alpha: P.alpha }; };
const rgbCss = (c) => `rgb(${c.map((v) => Math.round(v * 255)).join(',')})`;
// ---- 북마크 저장소: 파일 주소 → [{ id, name, … }], 종류마다 DB(plugin_data 'core')의 한 칸 ----
// PDF: { page, r: [x, y, w, h] (페이지 기준 0~1) } → 링크 …/?pdf=파일&p=쪽&r=영역&n=항목#보던 화면
// 이미지: { r: [x, y, w, h] (이미지 기준 0~1) } → …/?img=파일&r=영역#보던 화면
// 오디오 · 영상: { t: 초 } → …/?media=파일&t=초&n=항목#보던 화면
// 바뀌면 문서에 이벤트(pdfmarks · imgmarks · mediamarks)를 보내요 → 목록 · 영역 상자 · 위치 막대 눈금을 다시 그려요
function markStore(key, event, shape) {
  const map = new Map();
  const load = () => http(`/api/plugin-data/core/${key}`).then((r) => {
    map.clear();
    for (const [k, v] of Object.entries(r.value || {})) if (Array.isArray(v)) map.set(k, v);
    document.dispatchEvent(new Event(event));
  }).catch(() => {});
  const save = () => {
    document.dispatchEvent(new Event(event));
    http(`/api/plugin-data/core/${key}`, 'PUT', { value: Object.fromEntries(map) }).catch((e) => toast(`북마크를 저장하지 못했어요: ${e.message}`, 4000));
  };
  load();
  return { key, event, map, load, save, shape };
}
const num = (v) => (v === null || v === '' || !Number.isFinite(+v) ? null : +v);
const rect = (r) => (Array.isArray(r) && r.length === 4 && r.every((x) => num(x) != null) ? r.map(Number) : null);
/** 종류별 저장소. shape(m): 밖에서 온 북마크(가져오기 · 파일에 담긴 것)를 이 종류의 모양으로 — 맞지 않으면 null */
const MARKS = {
  pdf: markStore('pdf_marks', 'pdfmarks', (m) => (rect(m?.r) && num(m.page) >= 1 ? { page: Math.round(+m.page), r: rect(m.r) } : null)),
  img: markStore('img_marks', 'imgmarks', (m) => (rect(m?.r) ? { r: rect(m.r) } : null)),
  media: markStore('media_marks', 'mediamarks', (m) => (num(m?.t) >= 0 ? { t: Math.round(+m.t * 10) / 10 } : null)),
};
const newMarkId = () => `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
/** 북마크 더하기 · 이름 고치기 · 지우기 (저장까지) */
function addMark(kind, url, m) {
  const S = MARKS[kind], full = { id: newMarkId(), ...m };
  S.map.set(url, [...(S.map.get(url) || []), full]); S.save();
  return full;
}
/** 북마크 고치기: patch = { name?, t? … } */
function updateMark(kind, url, id, patch) {
  const S = MARKS[kind];
  S.map.set(url, (S.map.get(url) || []).map((x) => (x.id === id ? { ...x, ...patch } : x))); S.save();
}
function removeMark(kind, url, id) {
  const S = MARKS[kind], l = (S.map.get(url) || []).filter((x) => x.id !== id);
  if (l.length) S.map.set(url, l); else S.map.delete(url);
  S.save();
}
/** 파일이 새 파일로 바뀔 때(편집 · 마크업 저장) 북마크를 함께 옮겨요 (같은 id는 하나만) */
function copyMarks(kind, from, to) {
  const S = MARKS[kind], src = S.map.get(from) || [], cur = S.map.get(to) || [];
  const add = src.filter((m) => !cur.some((x) => x.id === m.id));
  if (!add.length) return;
  S.map.set(to, [...cur, ...add]); S.save();
}
const { map: pdfMarks, load: loadPdfMarks, save: savePdfMarks } = MARKS.pdf;
const { map: imgMarks, load: loadImgMarks, save: saveImgMarks } = MARKS.img;
const { map: mediaMarks, load: loadMediaMarks } = MARKS.media;
// 마크업한 이미지: 저장한 이미지 주소 → { base: 원본 주소, marks: 그린 것(원본 픽셀 좌표) } — 다시 마크업하면 원본 위에 그린 것을 하나하나 고칠 수 있어요
const imgInk = new Map();
const loadImgInk = () => http('/api/plugin-data/core/img_ink').then((r) => {
  imgInk.clear();
  for (const [k, v] of Object.entries(r.value || {})) if (v?.base && Array.isArray(v.marks)) imgInk.set(k, v);
}).catch(() => {});
loadImgInk();
const saveImgInk = () => http('/api/plugin-data/core/img_ink', 'PUT', { value: Object.fromEntries(imgInk) }).catch((e) => toast(`마크업 기록을 저장하지 못했어요: ${e.message}`, 4000));

export { PDF_ICON, pdfIconBtn, pdfLib, smoothSegs, svgPathD, simplifyPts, nearPolyline, PEN, penPick, penStyle, rgbCss, MARKS, addMark, updateMark, removeMark, copyMarks, pdfMarks, loadPdfMarks, savePdfMarks, imgMarks, loadImgMarks, saveImgMarks, mediaMarks, loadMediaMarks, imgInk, loadImgInk, saveImgInk };
