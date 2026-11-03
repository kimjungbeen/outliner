// 북마크: 파일에 담아 내려받기 · 올릴 때 되살리기 · 링크 · 목록 칸(PDF · 이미지 · 오디오 · 영상 공용) · 북마크 찾기(bookmarks)

import { fileKind, fileTokens, fmtTime } from './lib.js';
import { CLIENT_ID, http, mk, state, toast } from './base.js';
import { flushAll, openAppLink } from './app.js';
import { imgInk, imgMarks, MARKS, pdfIconBtn, pdfLib, pdfMarks, removeMark, saveImgInk, updateMark } from './markup.js';
import { confirmDelete, modal, modalShell } from './dialog.js';
import { restoreFocusAfterPalette } from './commands.js';

// ---- 북마크를 파일에 담아 내보내고 · 올릴 때 되살리기 ----
// PDF: 표준 '책갈피(목차)'로 써서 다른 PDF 앱에서도 보이고(누르면 그 쪽의 그 자리로), 정확한 영역은 문서 정보의 /OutlinerMarks(base64 JSON)에 따로 담아요.
// 이미지: PNG는 tEXt 덩어리, JPEG는 COM(주석) 칸에 'outliner-marks' + base64 JSON (outliner에서만 읽어요).
// 그 파일을 다시 올리면(첨부) 담긴 북마크를 새 파일의 북마크로 되살려요.
const MARK_TAG = 'outliner-marks';
const b64enc = (str) => { let bin = ''; for (const b of new TextEncoder().encode(str)) bin += String.fromCharCode(b); return btoa(bin); };
const b64dec = (str) => new TextDecoder().decode(Uint8Array.from(atob(str), (c) => c.charCodeAt(0)));
const marksPayload = (list) => b64enc(JSON.stringify({ v: 1, marks: list.map(({ id, page, r, name }) => (page ? { id, page, r, name } : { id, r, name })) }));
const latin1 = (bytes) => new TextDecoder('latin1').decode(bytes);
function lastMarks(text, re) { // 파일 안에서 마지막으로 담은 북마크 (여러 번 담았으면 마지막 것)
  let m = null;
  for (const x of text.matchAll(re)) m = x;
  if (!m) return [];
  try { const v = JSON.parse(b64dec(m[1])); return Array.isArray(v?.marks) ? v.marks.filter((x) => Array.isArray(x.r) && x.r.length === 4 && x.r.every(Number.isFinite)) : []; } catch { return []; }
}
let crcTable = null;
function crc32(bytes) {
  crcTable ??= Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  let c = 0xffffffff;
  for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const isPng = (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47, isJpeg = (b) => b[0] === 0xff && b[1] === 0xd8;
const INK_TAG = 'outliner-ink\0', INK_APP = 'OLINK\0';
function pngChunk(type, data) {
  const c = new Uint8Array(12 + data.length), dv = new DataView(c.buffer);
  dv.setUint32(0, data.length); c.set(new TextEncoder().encode(type), 4); c.set(data, 8);
  dv.setUint32(8 + data.length, crc32(c.subarray(4, 8 + data.length)));
  return c;
}
const concat = (...xs) => { const out = new Uint8Array(xs.reduce((n, x) => n + x.length, 0)); let o = 0; for (const x of xs) { out.set(x, o); o += x.length; } return out; };
/** 마크업 덩어리: [JSON 길이(4)] + JSON(그린 것) + 원본 이미지 바이트 */
const inkBlob = (ink) => { const j = new TextEncoder().encode(JSON.stringify({ v: 1, marks: ink.marks })), h = new Uint8Array(4); new DataView(h.buffer).setUint32(0, j.length); return concat(h, j, ink.base); };
function readInkBlob(b) {
  try {
    const n = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(0), v = JSON.parse(new TextDecoder().decode(b.subarray(4, 4 + n)));
    const base = b.slice(4 + n);
    return Array.isArray(v?.marks) && (isPng(base) || isJpeg(base)) ? { marks: v.marks, base } : null;
  } catch { return null; }
}
/** 이미지 바이트에 담기 (PNG · JPEG만, 아니면 null): 북마크(marks) · 마크업(ink = { marks, base: 원본 바이트 }) — 그림은 그대로, outliner만 읽어요 */
function imgWithMeta(bytes, marks, ink) {
  const markData = marks?.length ? new TextEncoder().encode(`${MARK_TAG}\0${marksPayload(marks)}`) : null;
  if (isPng(bytes)) { // IHDR 바로 뒤에: 북마크 = tEXt · 마크업 = 비공개 덩어리 olIn
    const add = [markData && pngChunk('tEXt', markData), ink && pngChunk('olIn', concat(new TextEncoder().encode(INK_TAG), inkBlob(ink)))].filter(Boolean);
    return add.length ? concat(bytes.subarray(0, 33), ...add, bytes.subarray(33)) : null;
  }
  if (isJpeg(bytes)) { // 앞쪽 APPn(JFIF · EXIF …) 뒤에: 북마크 = COM 칸 · 마크업 = APP15 칸들(64KB씩 나눠서)
    let at = 2;
    while (bytes[at] === 0xff && bytes[at + 1] >= 0xe0 && bytes[at + 1] <= 0xef) at += 2 + ((bytes[at + 2] << 8) | bytes[at + 3]);
    const segs = [];
    if (markData && markData.length + 2 <= 0xffff) segs.push(concat(new Uint8Array([0xff, 0xfe, (markData.length + 2) >> 8, (markData.length + 2) & 0xff]), markData));
    if (ink) {
      const blob = inkBlob(ink), PIECE = 65000, total = Math.ceil(blob.length / PIECE), head = new TextEncoder().encode(INK_APP);
      for (let k = 0; k < total; k++) {
        const piece = blob.subarray(k * PIECE, (k + 1) * PIECE), len = 2 + head.length + 4 + piece.length;
        segs.push(concat(new Uint8Array([0xff, 0xef, len >> 8, len & 0xff]), head, new Uint8Array([k >> 8, k & 0xff, total >> 8, total & 0xff]), piece));
      }
    }
    return segs.length ? concat(bytes.subarray(0, at), ...segs, bytes.subarray(at)) : null;
  }
  return null;
}
/** 이미지에 담긴 마크업 (원본 + 그린 것) → { marks, base } 또는 null */
function imgInkIn(b) {
  const tag = new TextEncoder().encode(INK_TAG), dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const starts = (x, at) => x.every((c, i) => b[at + i] === c);
  if (isPng(b)) {
    for (let p = 8; p + 12 <= b.length;) {
      const len = dv.getUint32(p), type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
      if (type === 'olIn' && starts(tag, p + 8)) return readInkBlob(b.slice(p + 8 + tag.length, p + 8 + len));
      if (type === 'IDAT' || type === 'IEND') break; // 앞쪽에 넣어요
      p += 12 + len;
    }
    return null;
  }
  if (isJpeg(b)) {
    const head = new TextEncoder().encode(INK_APP), pieces = [];
    for (let p = 2; p + 4 <= b.length && b[p] === 0xff;) {
      const m = b[p + 1], len = (b[p + 2] << 8) | b[p + 3];
      if (m === 0xda || m === 0xd9) break; // 그림 데이터 시작
      if (m === 0xef && starts(head, p + 4)) { const q = p + 4 + head.length; pieces[(b[q] << 8) | b[q + 1]] = b.subarray(q + 4, p + 2 + len); }
      p += 2 + len;
    }
    return pieces.length && pieces.every(Boolean) ? readInkBlob(concat(...pieces)) : null;
  }
  return null;
}
const imgMarksIn = (bytes) => lastMarks(latin1(bytes.subarray(0, Math.min(bytes.length, 4 << 20))), new RegExp(`${MARK_TAG}[\\0:]([A-Za-z0-9+/=]+)`, 'g')); // 앞쪽 4MB 안에 넣어요
const pdfMarksIn = (bytes) => lastMarks(latin1(bytes), /\/OutlinerMarks\s*\(([A-Za-z0-9+/=]+)\)/g).filter((m) => m.page >= 1);
/** PDF에 북마크를 담아요: 문서 정보(/OutlinerMarks) + 표준 책갈피(그 쪽의 그 영역 왼쪽 위, XYZ). 원래 목차가 있으면 맨 뒤에 '북마크' 묶음으로 */
async function pdfWithMarks(bytes, list) {
  const L = await pdfLib(), N = (n) => L.PDFName.of(n);
  const pd = await L.PDFDocument.load(bytes, { updateMetadata: false }), ctx = pd.context, pages = pd.getPages();
  pd.getInfoDict().set(N('OutlinerMarks'), L.PDFString.of(marksPayload(list)));
  const items = list.filter((m) => m.page >= 1 && m.page <= pages.length).sort((a, b) => a.page - b.page || a.r[1] - b.r[1] || a.r[0] - b.r[0]);
  if (items.length) {
    const dest = (m) => { // 화면(돌린 그대로) 기준 0~1 영역 → PDF 좌표의 사각형
      const pg = pages[m.page - 1], { x: x0, y: y0, width: W, height: H } = pg.getCropBox(), rot = ((pg.getRotation().angle % 360) + 360) % 360;
      const at = (px, py) => (rot === 90 ? [x0 + py * W, y0 + px * H] : rot === 180 ? [x0 + W - px * W, y0 + py * H] : rot === 270 ? [x0 + W - py * W, y0 + H - px * H] : [x0 + px * W, y0 + H - py * H]);
      const [a, b] = [at(m.r[0], m.r[1]), at(m.r[0] + m.r[2], m.r[1] + m.r[3])];
      return ctx.obj([pg.ref, N('XYZ'), Math.min(a[0], b[0]), Math.max(a[1], b[1]), L.PDFNull]); // 그 영역의 왼쪽 위로 (배율은 그대로 — 대부분의 PDF 앱이 따라요)
    };
    const refs = items.map(() => ctx.nextRef());
    const outRef = pd.catalog.get(N('Outlines')), outlines = pd.catalog.lookupMaybe(N('Outlines'), L.PDFDict);
    let parent;
    if (outRef instanceof L.PDFRef && outlines?.get(N('Last'))) { // 원래 목차 맨 뒤에 '북마크' 묶음
      const last = outlines.get(N('Last')), group = ctx.nextRef();
      ctx.lookup(last, L.PDFDict).set(N('Next'), group);
      ctx.assign(group, ctx.obj({ Title: L.PDFHexString.fromText('북마크'), Parent: outRef, Prev: last, First: refs[0], Last: refs.at(-1), Count: refs.length }));
      outlines.set(N('Last'), group);
      const cnt = outlines.lookupMaybe(N('Count'), L.PDFNumber)?.asNumber() ?? 0;
      outlines.set(N('Count'), L.PDFNumber.of(Math.abs(cnt) + 1 + refs.length));
      parent = group;
    } else {
      parent = ctx.nextRef();
      ctx.assign(parent, ctx.obj({ Type: 'Outlines', First: refs[0], Last: refs.at(-1), Count: refs.length }));
      pd.catalog.set(N('Outlines'), parent);
      pd.catalog.set(N('PageMode'), N('UseOutlines')); // 다른 PDF 앱에서 열면 책갈피 목록이 바로 보이게
    }
    items.forEach((m, i) => ctx.assign(refs[i], ctx.obj({ Title: L.PDFHexString.fromText(m.name), Parent: parent, ...(i ? { Prev: refs[i - 1] } : {}), ...(i < refs.length - 1 ? { Next: refs[i + 1] } : {}), Dest: dest(m) })));
  }
  return pd.save({ useObjectStreams: false }); // 문서 정보가 압축되지 않게 (올릴 때 바로 찾아요)
}
function saveBytes(bytes, name, type) {
  const a = mk('a'); a.href = URL.createObjectURL(new Blob([bytes], { type })); a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
const fileSafe = (s) => String(s).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim().slice(0, 120) || '파일';
const extOf = (url) => (url.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
/** 파일 안에 담을 outliner 정보가 있나: PDF 북마크 · 그림 북마크 · 그림 마크업(원본 + 그린 것) */
const hasMeta = (url) => (extOf(url) === 'pdf' ? !!pdfMarks.get(url)?.length : ['png', 'jpg', 'jpeg'].includes(extOf(url)) && (!!imgMarks.get(url)?.length || imgInk.has(url)));
/** 정보를 담은 파일 바이트 (담을 게 없거나 담을 수 없으면 null) → { bytes, n: 담은 것 개수 } */
async function fileWithMeta(url, bytes) {
  if (extOf(url) === 'pdf') { const m = pdfMarks.get(url) || []; return m.length ? { bytes: await pdfWithMarks(bytes, m), n: m.length } : null; }
  const marks = imgMarks.get(url) || [], d = imgInk.get(url);
  let ink = null;
  if (d) try { const r = await fetch(d.base); if (r.ok) ink = { marks: d.marks, base: new Uint8Array(await r.arrayBuffer()) }; } catch { /* 원본이 없으면 마크업은 빼고 */ }
  const out = imgWithMeta(bytes, marks, ink);
  return out ? { bytes: out, n: marks.length + (ink ? 1 : 0) } : null;
}
/** 첨부 하나 내려받기: 북마크 · 마크업이 있으면 파일에 담아서, 없으면(또는 담을 수 없으면) 그대로 (이름은 글에 적힌 이름) */
async function downloadAttachment(url, label) {
  const plain = () => { const a = mk('a'); a.href = `/api/attachments/download?names=${encodeURIComponent(url.split('/').pop())}`; a.click(); };
  if (!hasMeta(url)) return plain();
  try {
    const ext = extOf(url), got = await fileWithMeta(url, new Uint8Array(await (await fetch(url)).arrayBuffer()));
    if (!got) return plain();
    saveBytes(got.bytes, `${fileSafe(label).replace(new RegExp(`\\.${ext}$`, 'i'), '')}.${ext}`, ext === 'pdf' ? 'application/pdf' : `image/${ext === 'jpg' ? 'jpeg' : ext}`);
    toast(`북마크 · 마크업을 파일 안에 담아 내려받았어요${ext === 'pdf' ? ' (다른 PDF 앱에서도 책갈피로 보여요)' : ''}`);
  } catch (e) { toast(`정보를 담지 못해 파일만 내려받아요: ${e.message}`, 4000); plain(); }
}
/** 첨부 여러 개 · 전체(all) 내려받기 (af): 하나면 그 파일, 여럿이면 서버가 ZIP 하나로 — 북마크 · 마크업이 있는 파일은 브라우저가 담은 판으로 바꿔 넣어요.
 *  폼 전송이라 큰 ZIP도 메모리에 올리지 않고 바로 디스크로 받아져요 */
async function downloadAttachments(names) {
  if (Array.isArray(names) && names.length === 1) {
    const n = names[0], nice = (await http(`/api/attachments/names?names=${encodeURIComponent(n)}`)).names?.[n] || n;
    await downloadAttachment(`/files/${n}`, nice);
    return { n: hasMeta(`/files/${n}`) ? 1 : 0 };
  }
  const all = names === 'all' ? (await http('/api/attachments')).files.map((f) => f.name) : names;
  const meta = all.filter((n) => hasMeta(`/files/${n}`));
  const dt = new DataTransfer();
  let count = 0;
  if (meta.length) toast(`북마크 · 마크업을 담는 중… (${meta.length}개)`, 60000);
  for (const n of meta) {
    try {
      const got = await fileWithMeta(`/files/${n}`, new Uint8Array(await (await fetch(`/files/${n}`)).arrayBuffer()));
      if (got) { dt.items.add(new File([got.bytes], n)); count += got.n; }
    } catch { /* 이 파일은 원래 그대로 */ }
  }
  const form = mk('form'); form.method = 'post'; form.enctype = 'multipart/form-data'; form.action = '/api/attachments/pack'; form.hidden = true;
  let fr = document.querySelector('iframe[name="dlframe"]');
  if (!fr) { fr = mk('iframe'); fr.name = 'dlframe'; fr.hidden = true; document.body.append(fr); }
  form.target = 'dlframe';
  const ni = mk('input'); ni.type = 'hidden'; ni.name = 'names'; ni.value = names === 'all' ? 'all' : all.join(',');
  const fi = mk('input'); fi.type = 'file'; fi.name = 'f'; fi.multiple = true; fi.files = dt.files;
  form.append(ni, fi); document.body.append(form); form.submit(); form.remove();
  toast(`${all.length}개를 ZIP 하나로 내려받아요${count ? ` · 북마크 · 마크업 ${count}개를 파일 안에 담았어요` : ''}`, 3500);
  return { n: count };
}
/** 북마크 합치기 (같은 id는 건너뛰고, 이 종류의 모양이 아닌 것은 빼요) → 더한 개수. kind: pdf · img · media */
function mergeMarks(kind, url, list) {
  const S = MARKS[kind], cur = S.map.get(url) || [], ids = new Set(cur.map((m) => m.id));
  const add = (Array.isArray(list) ? list : []).filter((m) => m && !ids.has(m.id)).map((m) => { const v = S.shape(m); return v && { id: m.id || Math.random().toString(36).slice(2, 10), ...v, name: String(m.name ?? '북마크') }; }).filter(Boolean);
  if (!add.length) return 0;
  S.map.set(url, [...cur, ...add]);
  S.save();
  return add.length;
}
/** 올린 파일에 담긴 북마크 · 마크업을 새 첨부의 것으로 되살려요 → 되살린 개수 (마크업은 원본을 따로 올려 두고 다시 고칠 수 있게) */
async function restoreMarksFrom(file, url) {
  const ext = extOf(url);
  if (!['pdf', 'png', 'jpg', 'jpeg'].includes(ext) || file.size > 300 << 20) return 0;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (ext === 'pdf') return mergeMarks('pdf', url, pdfMarksIn(bytes));
    let n = mergeMarks('img', url, imgMarksIn(bytes));
    const ink = imgInkIn(bytes);
    if (ink && !imgInk.has(url)) {
      const fd = new FormData(); fd.append('file', new Blob([ink.base], { type: isPng(ink.base) ? 'image/png' : 'image/jpeg' }), `원본.${isPng(ink.base) ? 'png' : 'jpg'}`);
      const r = await (await fetch('/api/upload', { method: 'POST', headers: { 'X-Client-Id': CLIENT_ID }, body: fd })).json();
      if (!r.error) { imgInk.set(url, { base: r.url, marks: ink.marks }); saveImgInk(); n++; }
    }
    return n;
  } catch { return 0; }
}
/** 북마크 칸의 찾기 칸 (북마크가 둘 이상이면 보여요): 글자를 넣으면 목록을 걸러요 · Enter = 첫 결과로 · Esc = 지우기 */
function markFindInput(onChange, onEnter) {
  const i = mk('input', 'att-markfind'); i.type = 'search'; i.placeholder = '북마크 찾기'; i.setAttribute('aria-label', '북마크 찾기'); i.hidden = true;
  i.addEventListener('input', onChange);
  i.addEventListener('keydown', (e) => {
    e.stopPropagation(); // 앱 · 뷰어 단축키(← → Esc …)로 새지 않게
    if (e.isComposing) return;
    if (e.key === 'Enter') { e.preventDefault(); onEnter(); }
    else if (e.key === 'Escape') { e.preventDefault(); if (i.value) { i.value = ''; onChange(); } else i.blur(); }
  });
  return i;
}
const markHit = (q, ...texts) => !q || texts.some((t) => String(t).toLowerCase().includes(q));
/** 북마크 링크 (…/?pdf= · ?img= · ?media=). n: 그 파일이 든 항목, at: 링크를 열면 보일 화면(#) */
function markHref(kind, url, m, { n = null, at = state.zoom } = {}) {
  const q = new URLSearchParams(kind === 'pdf' ? { pdf: url, p: m.page, r: m.r.join(',') } : kind === 'img' ? { img: url, r: m.r.join(',') } : { media: url, t: m.t });
  if (n != null && kind !== 'img') q.set('n', n);
  return `${location.origin}/?${q}${at == null ? '' : `#${at}`}`;
}
const copyMarkLink = async (name, url) => {
  try { await navigator.clipboard.writeText(url); toast(`'${name}' 링크를 복사했어요`); } catch { toast(url, 6000); }
};
/** 북마크 고치기 창: 이름 + (종류에 따라) 더 고칠 칸 하나 → 바꿀 값 { name, … } · 취소 null
 *  extra: { label, get(m) → 칸에 보일 글, parse(글) → 바꿀 값 | 오류 글, now?() → 지금 값 (예: 지금 재생 위치) — '지금 위치' 단추 } */
function editMark(m, extra = null) {
  const form = mk('div', 'pdf-form mark-edit');
  const field = (label, value) => {
    const row = mk('label', 'pdf-row'), s = mk('span'), i = mk('input');
    s.textContent = label; i.value = value; i.spellcheck = false;
    row.append(s, i); form.append(row);
    return i;
  };
  const nameIn = field('이름', m.name), extIn = extra && field(extra.label, extra.get(m));
  if (extra?.now) {
    const b = mk('button', 'att-btn mark-now'); b.type = 'button';
    b.textContent = `지금 위치로 · ${extra.get(extra.now())}`; b.title = '지금 재생 위치를 넣어요';
    b.onclick = () => { picked = extra.now(); extIn.value = extra.get(picked); extIn.focus(); };
    form.append(b);
  }
  let patch = null, picked = null; // picked: '지금 위치로'로 넣은 값 (글자로 보이는 것보다 정확해요)
  const check = () => { // 고치기 전에 확인: 맞지 않으면 창을 닫지 않고 알려 줘요
    const text = extIn?.value.trim(), same = !extra || text === extra.get(m); // 칸을 안 고쳤으면 원래 값 그대로 (보이는 글은 반올림돼 있어요)
    const name = nameIn.value.trim() || m.name, got = same ? {} : picked && text === extra.get(picked) ? picked : extra.parse(text);
    if (typeof got === 'string') { toast(got, 3500); extIn.focus(); extIn.select(); return false; }
    patch = { name, ...got };
    return true;
  };
  return modal({
    title: '북마크 고치기', body: form,
    buttons: [{ label: '취소', value: null }, { label: '고치기', value: 'save', primary: true, before: check }],
    onKey: (e) => { // Enter = 고치기
      if (e.key !== 'Enter' || e.isComposing || e.target.tagName !== 'INPUT') return false;
      e.preventDefault(); e.stopPropagation(); form.closest('.pdf-dlg').querySelector('.pdf-btn.primary').click();
      return true;
    },
    focus: () => { queueMicrotask(() => nameIn.select()); return nameIn; },
  }).then((v) => (v === 'save' ? patch : null));
}
/** 북마크 목록 칸 (PDF · 이미지 · 오디오 · 영상이 같이 써요): 찾기 칸(둘 이상일 때) + 줄마다 [가기 · 고치기 · 링크 복사 · 지우기]
 *  kind: pdf · img · media, url(): 지금 파일 주소, tag(m): 이름 앞의 작은 글(쪽 · 시간), sort(a, b): 순서, go(m): 그 자리로, link(m): 링크 주소,
 *  extra: 이름 말고 더 고칠 칸 (editMark 참고 — 오디오 · 영상의 시간),
 *  refocus(): 묻는 창이 닫힌 뒤 포커스를 되돌릴 곳 (뷰어 창 등). 저장소가 바뀌면 부르는 쪽이 paint()를 다시 불러요 → 보이는 북마크 전부 */
function markList({ kind, url, tag = () => '', sort = () => 0, go, link, extra = null, refocus = () => {} }) {
  const list = mk('div', 'att-pdfmarklist');
  const find = markFindInput(() => paint(), () => list.querySelector('.att-pdfmarkgo')?.click());
  const row = (u, m) => {
    const el = mk('div', 'att-pdfmarkrow');
    const b = mk('button', 'att-pdfmarkgo'); b.type = 'button'; b.title = kind === 'media' ? '이 자리부터 재생' : '이 영역으로';
    const t = tag(m);
    if (t) { const pg = mk('span', 'att-pdfmarkpg'); pg.textContent = t; b.append(pg); }
    const nm = mk('span', 'att-pdfmarkname'); nm.textContent = m.name;
    b.append(nm); b.onclick = () => go(m);
    const ren = pdfIconBtn('edit', extra ? `이름 · ${extra.label} 고치기` : '이름 고치기');
    ren.onclick = async () => {
      const patch = await editMark(m, extra);
      refocus();
      if (patch && Object.entries(patch).some(([k, v]) => m[k] !== v)) updateMark(kind, u, m.id, patch);
    };
    const cp = pdfIconBtn('link', '링크 복사'); cp.onclick = () => copyMarkLink(m.name, link(m));
    const del = pdfIconBtn('close', '북마크 지우기');
    del.onclick = async () => { const ok = await confirmDelete(`북마크 '${m.name}'`); refocus(); if (ok) removeMark(kind, u, m.id); };
    el.append(b, ren, cp, del);
    return el;
  };
  function paint() {
    const u = url(), all = u ? (MARKS[kind].map.get(u) || []).slice().sort(sort) : [];
    find.hidden = all.length < 2;
    const q = find.hidden ? '' : find.value.trim().toLowerCase(), shown = all.filter((m) => markHit(q, m.name, tag(m)));
    list.replaceChildren(...(shown.length ? shown.map((m) => row(u, m)) : [Object.assign(mk('div', 'att-pdfmarkempty'), { textContent: all.length ? '찾는 북마크가 없어요' : '아직 북마크가 없어요' })]));
    return all;
  }
  return { find, list, paint };
}
// ---- 북마크 찾기 (bookmarks): 모든 PDF · 이미지의 북마크를 한 창에서 이름 · 파일 이름으로 찾아, 고르면 그 파일의 그 영역으로 ----
async function openMarkFinder(text = '') { // text: 처음 찾을 글자 (부를 때 고른 글자)
  await flushAll();
  const raw = Object.entries(MARKS).flatMap(([kind, S]) => [...S.map].flatMap(([url, ms]) => ms.map((m) => ({ kind, url, m }))));
  if (!raw.length) return toast('아직 북마크가 없어요 — PDF · 이미지 · 오디오 · 영상의 책갈피 단추로 만들어요');
  // 파일마다 그 파일이 든 항목 (이름 · 열 자리)
  const where = new Map();
  await Promise.all([...new Set(raw.map((x) => x.url))].map(async (url) => {
    const r = await http(`/api/search?q=${encodeURIComponent(url.split('/').pop())}&limit=20`).catch(() => null);
    const h = r?.results?.find((x) => x.content?.includes(url));
    where.set(url, h ? { id: h.id, parent: h.parent_id, name: fileTokens(h.content).find((t) => t.url === url)?.name || url.split('/').pop() } : null);
  }));
  const items = raw.map((x) => ({ ...x, file: where.get(x.url)?.name ?? `${url2name(x.url)} (항목 없음)` }))
    .sort((a, b) => !where.get(a.url) - !where.get(b.url) || a.file.localeCompare(b.file, 'ko') || (a.m.page ?? 0) - (b.m.page ?? 0) || (a.m.t ?? 0) - (b.m.t ?? 0) || (a.m.r?.[1] ?? 0) - (b.m.r?.[1] ?? 0) || (a.m.r?.[0] ?? 0) - (b.m.r?.[0] ?? 0));
  const { dlg, close: shut } = modalShell({ cls: 'markfind-dlg', label: '북마크 찾기', onClose: (back) => { if (back !== false) setTimeout(restoreFocusAfterPalette, 120); } }); // 북마크를 열 때는 커서를 되돌리지 않아요 (뷰어가 포커스를 가져요)
  const h = mk('h2'); h.textContent = '북마크 찾기';
  const sub = mk('p', 'pdf-sub'); sub.textContent = `PDF · 이미지 · 오디오 · 영상 북마크 ${items.length}개 — 북마크 이름이나 파일 이름으로 찾아요`;
  const input = mk('input', 'att-markfind'); input.type = 'search'; input.placeholder = '찾을 글자'; input.setAttribute('aria-label', '찾을 글자');
  const listEl = mk('div', 'markfind-list'); listEl.setAttribute('role', 'listbox');
  dlg.append(h, sub, input, listEl);
  let shown = [], active = 0;
  const close = (back = true) => shut(back);
  const open = (x) => {
    close(false);
    const w = where.get(x.url);
    if (!w) return toast('이 파일이 든 항목을 찾지 못했어요 (지워졌을 수 있어요)', 4000);
    // PDF는 그 항목 안으로 (카드가 맨 위에) · 이미지 · 오디오 · 영상은 그 항목이 있는 화면에서 (앞뒤로 넘기거나 이어서 재생하게)
    openAppLink(markHref(x.kind, x.url, x.m, { n: w.id, at: x.kind === 'pdf' ? w.id : w.parent }));
  };
  /** 그 북마크의 링크 복사 — 그 파일이 든 항목을 알면 그 자리로 열리게 */
  const copyLink = (x) => { const w = where.get(x.url); copyMarkLink(x.m.name, markHref(x.kind, x.url, x.m, w ? { n: w.id, at: x.kind === 'pdf' ? w.id : w.parent } : {})); };
  const paint = () => {
    const q = input.value.trim().toLowerCase();
    shown = items.filter((x) => markHit(q, x.m.name, x.file));
    active = Math.min(active, Math.max(0, shown.length - 1));
    listEl.replaceChildren(...(shown.length ? shown.slice(0, 300).map((x, k) => {
      const b = mk('div', 'markfind-row'); b.setAttribute('role', 'option'); b.setAttribute('aria-selected', String(k === active));
      const kind = mk('span', 'markfind-kind'); kind.textContent = KIND_NAME[x.kind === 'media' ? fileKind(extOf(x.url)) : x.kind];
      const nm = mk('span', 'markfind-name'); nm.textContent = x.m.name;
      const fl = mk('span', 'markfind-file'); fl.textContent = x.kind === 'pdf' ? `${x.file} · ${x.m.page}쪽` : x.kind === 'media' ? `${x.file} · ${fmtTime(x.m.t)}` : x.file;
      const cp = pdfIconBtn('link', '링크 복사 (⌘C)'); cp.classList.add('markfind-link'); // 파일 보기의 북마크 목록과 같은 링크
      cp.onmousedown = (e) => e.preventDefault();
      cp.onclick = (e) => { e.stopPropagation(); copyLink(x); input.focus(); };
      b.append(kind, nm, fl, cp);
      b.onclick = () => open(x);
      b.onmousemove = () => { if (active !== k) { active = k; mark(); } };
      return b;
    }) : [Object.assign(mk('div', 'att-pdfmarkempty'), { textContent: '찾는 북마크가 없어요' })]));
  };
  const mark = () => { [...listEl.children].forEach((b, k) => b.setAttribute?.('aria-selected', String(k === active))); listEl.children[active]?.scrollIntoView?.({ block: 'nearest' }); };
  input.addEventListener('input', () => { active = 0; paint(); });
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, Math.min(Math.min(shown.length, 300) - 1, active + (e.key === 'ArrowDown' ? 1 : -1))); mark(); }
    else if (e.key === 'Enter') { e.preventDefault(); if (shown[active]) open(shown[active]); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.code === 'KeyC' && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && input.selectionStart === input.selectionEnd && shown[active]) { e.preventDefault(); copyLink(shown[active]); } // 글자를 고르지 않았으면 ⌘C = 고른 북마크의 링크
  });
  if (text) input.value = text;
  paint(); input.focus(); if (text) input.select();
}
const KIND_NAME = { pdf: 'PDF', img: '이미지', audio: '오디오', video: '영상' };
const url2name = (url) => url.split('/').pop();

export { MARK_TAG, b64enc, b64dec, marksPayload, latin1, lastMarks, crcTable, crc32, isPng, isJpeg, INK_TAG, INK_APP, pngChunk, concat, inkBlob, readInkBlob, imgWithMeta, imgInkIn, imgMarksIn, pdfMarksIn, pdfWithMarks, saveBytes, fileSafe, extOf, hasMeta, fileWithMeta, downloadAttachment, downloadAttachments, mergeMarks, restoreMarksFrom, markFindInput, markHit, markHref, copyMarkLink, markList, openMarkFinder, url2name };
