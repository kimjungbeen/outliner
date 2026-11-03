// 첨부 넣기: 항목 글 속 첨부 표시 → 카드, 업로드 · 끌어놓기 · 붙여넣기

import { fileTokens } from './lib.js';
import { CLIENT_ID, http, httpError, mk, postForm, state, toast } from './base.js';
import { progress } from './progress.js';
import { flushAll, hasKids, importDbFile, importOutlineFile, patch, refresh, takeImg } from './app.js';
import { inlinePlayer, reuseMedia } from './media.js';
import { pdfCard } from './pdf.js';
import { restoreMarksFrom } from './marks.js';
import { imgViewer } from './imgview.js';

// ---- 첨부 (이미지 · 영상 · 오디오 · PDF) ----
// 항목 글에 ![이름](/files/…) 가 있으면 그 아래에 미리보기를 보여줘요. 글은 그대로 고칠 수 있고, 지우면 미리보기도 사라져요.
function attachEl(content) {
  const list = fileTokens(content);
  if (!list.length) return null;
  const box = mk('div', 'attach');
  box.dataset.sig = list.map((f) => f.url).join('|');
  for (const f of list) {
    if (f.kind === 'image') {
      const a = mk('a', 'att-img'); a.href = f.url; a.target = '_blank'; a.rel = 'noopener'; a.title = `${f.name || '이미지'} — 크게 보기 (⌘/Ctrl+클릭: 새 탭)`;
      a.addEventListener('click', (e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return; e.preventDefault(); imgViewer.openFrom(a); }); // ⌘ · Ctrl+클릭은 새 탭
      let im = takeImg(f.url);
      if (!im) { im = mk('img'); im.src = f.url; im.loading = 'lazy'; im.decoding = 'async'; }
      im.alt = f.name;
      a.append(im); box.append(a);
    } else if (f.kind === 'video') {
      box.append(reuseMedia(f.url, () => {
        const card = mk('div', 'att-vid');
        const v = mk('video', 'att-video'); v.src = f.url; v.preload = 'metadata'; v.playsInline = true;
        v.onclick = () => (v.paused ? v.play().catch(() => {}) : v.pause());
        const full = () => (document.fullscreenElement ? document.exitFullscreen() : card.requestFullscreen?.());
        card.append(v, inlinePlayer(v, f.url, { fullscreen: full }));
        return card;
      }));
    } else if (f.kind === 'audio') {
      box.append(reuseMedia(f.url, () => {
        const card = mk('div', 'att-audio');
        const name = mk('span', 'att-name'); name.textContent = `오디오 · ${f.name}`;
        const a = mk('audio'); a.src = f.url; a.preload = 'metadata'; // 안 보이는 요소 — 조작은 아래 조작부로
        card.append(name, a, inlinePlayer(a, f.url));
        return card;
      }));
    } else {
      box.append(reuseMedia(f.url, () => pdfCard(f)));
    }
  }
  return box;
}
const attachTimers = new Map();
function scheduleAttach(n) {
  clearTimeout(attachTimers.get(n.id));
  attachTimers.set(n.id, setTimeout(() => {
    attachTimers.delete(n.id);
    const wrap = document.querySelector(`#tree .node[data-nid="${n.id}"]`);
    if (!wrap) return;
    const old = [...wrap.children].find((x) => x.classList.contains('attach'));
    const sig = fileTokens(n.content).map((f) => f.url).join('|');
    if ((old?.dataset.sig ?? '') === sig) return;
    old?.remove();
    const el = attachEl(n.content);
    if (el) wrap.children[0].after(el);
  }, 250));
}

const ATTACH_OK = /\.(png|jpe?g|gif|webp|avif|bmp|mp4|webm|mov|m4v|ogv|pdf|mp3|wav|m4a|aac|ogg|oga|opus|flac|weba)$/i;
/** 파일 하나 올리기 (보낸 만큼 onSent(바이트)로 알려줘요 — fetch는 올리는 진행을 못 알려줘서 XHR로) → 서버 응답 */
function sendFile(file, onSent) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest(), fd = new FormData();
    fd.append('file', file, file.name);
    x.open('POST', '/api/upload'); x.setRequestHeader('X-Client-Id', CLIENT_ID); x.responseType = 'json';
    x.upload.onprogress = (e) => onSent(e.loaded);
    x.onload = () => (x.response ? resolve(x.response) : reject(new Error(httpError(x.status))));
    x.onerror = () => reject(new Error('연결이 끊겼어요'));
    x.send(fd);
  });
}
async function uploadFiles(files, target) {
  files = [...files];
  const bad = files.filter((f) => !ATTACH_OK.test(f.name));
  files = files.filter((f) => ATTACH_OK.test(f.name));
  if (bad.length) toast(`첨부할 수 없는 파일: ${bad.map((f) => f.name).join(', ')} (이미지 · 영상 · 오디오 · PDF만)`, 4000);
  if (!files.length) return;
  await flushAll();
  const tokens = [], total = files.reduce((s, f) => s + f.size, 0) || 1, job = progress();
  let restored = 0, done = 0;
  const show = (sent, k) => { // 맨 위 막대 + 알림에 몇 번째 · 몇 %
    const f = Math.min(1, (done + sent) / total);
    job.set(f);
    toast(`올리는 중… ${files.length > 1 ? `${k + 1}/${files.length} · ` : ''}${Math.round(f * 100)}%`, 60000);
  };
  try {
    for (const [k, f] of files.entries()) {
      show(0, k);
      const r = await sendFile(f, (sent) => show(sent, k));
      done += f.size;
      if (r.error) throw new Error(r.error);
      tokens.push(r.markdown);
      restored += await restoreMarksFrom(f, r.url); // 내려받을 때 담아 둔 북마크가 있으면 되살려요
    }
  } catch (e) { job.done(); toast(`올리지 못했어요: ${e.message}`, 5000); return; }
  job.done();
  await placeTokens(tokens, target);
  toast(`${tokens.length}개 첨부했어요${restored ? ` · 담겨 있던 북마크 · 마크업 ${restored}개도 되살렸어요` : ''}`);
}
/** 첨부 표시(![이름](/files/…))들을 target 항목 아래에 새 항목으로 넣어요. 그 항목이 비어 있으면 그 자리에 첫 개를. target이 없으면 현재 화면 맨 아래 */
async function placeTokens(tokens, target) {
  const t = target != null ? state.nodes.get(target) : null;
  const pid = t ? t.parent_id : state.zoom;
  let pos = t ? (state.ch.get(pid)?.ids.indexOf(t.id) ?? -1) + 1 : 9999, last = null;
  for (let i = 0; i < tokens.length; i++) {
    if (i === 0 && t && !t.content.trim() && !hasKids(t)) { await patch(t.id, { content: tokens[0] }); last = t.id; continue; } // 빈 항목이면 그 자리에
    const r = await http('/api/nodes', 'POST', { parent_id: pid, position: pos === 9999 ? 9999 : pos++, content: tokens[i] });
    last = r.id;
  }
  state.focusId = last; state.focusPos = 'end';
  if (t) state.ensure = pid === state.zoom ? last : null;
  await refresh();
  return tokens.length;
}
// ---- 파일 넣기: 고르든(import 명령 · 파일 선택) 끌어다 놓든 하나로 — 파일 종류를 보고 알아서 나눠요 ----
//   이미지 · 영상 · 오디오 · PDF → 첨부 (놓은 항목 · 커서 항목 아래에)
//   .json · .html · .md · .txt → 항목으로 가져오기 (지금 화면 맨 아래에)
//   .zip · .db (전체 백업 · DB) → 아래에 추가 / 대체하기 고르는 창
const DOC_RE = /\.(json|html?|md|markdown|txt)$/i, BACKUP_RE = /\.(db|sqlite3?|zip)$/i;
async function addFiles(files, target) {
  files = [...files].map(nameFile);
  const media = files.filter((f) => ATTACH_OK.test(f.name)), docs = files.filter((f) => DOC_RE.test(f.name)), backups = files.filter((f) => BACKUP_RE.test(f.name));
  const bad = files.filter((f) => !media.includes(f) && !docs.includes(f) && !backups.includes(f));
  const skipped = () => bad.length && toast(`넣을 수 없는 파일: ${bad.map((f) => f.name).join(', ')} (이미지 · 영상 · 오디오 · PDF · 백업(.zip · .db) · JSON · HTML · Markdown · 텍스트만)`, 6000);
  if (media.length) await uploadFiles(media, target);
  for (const f of docs) await importOutlineFile(f);
  if (!backups.length) return void (bad.length && setTimeout(skipped, media.length || docs.length ? 2500 : 0)); // 넣은 결과를 본 뒤에 못 넣은 파일을 알려요
  skipped();
  for (const f of backups) if ((await importDbFile(f)) === 'files-zip') await importFilesZip(f, target); // 하나씩 (아래에 추가 / 대체하기를 묻는 창) · 백업이 아닌 ZIP은 첨부로
}
/** 첨부 파일 ZIP(file 창에서 여럿 내려받은 것 등) → 안의 이미지 · 영상 · 오디오 · PDF를 풀어 target 항목 아래에.
 *  파일 안에 담아 둔 북마크 · 마크업도 되살려요 (첨부를 하나씩 올릴 때와 같아요) */
async function importFilesZip(file, target) {
  const fd = new FormData(); fd.append('file', file, file.name);
  const r = await postForm('/api/import/files', fd);
  if (r.error) return toast(`ZIP을 풀지 못했어요: ${r.error}`, 6000);
  if (!r.files.length) return toast('ZIP 안에 넣을 수 있는 파일(이미지 · 영상 · 오디오 · PDF)이 없어요', 5000);
  let marks = 0;
  for (const f of r.files) {
    if (!/\.(pdf|png|jpe?g)$/i.test(f.url)) continue;
    try { marks += await restoreMarksFrom(new File([await (await fetch(f.url)).blob()], f.name), f.url); } catch { /* 북마크 없이 */ }
  }
  await placeTokens(r.files.map((f) => f.markdown), target);
  toast(`ZIP에서 ${r.files.length}개를 첨부로 넣었어요${marks ? ` · 북마크 · 마크업 ${marks}개` : ''}${r.skipped ? ` · 넣을 수 없는 파일 ${r.skipped}개는 건너뛰었어요` : ''}`, 4500);
}
const fileInput = document.getElementById('importfile'); // 모든 파일 선택이 이 입력칸 하나로
let attachTarget = null;
fileInput.onchange = () => { const fs = [...fileInput.files]; fileInput.value = ''; addFiles(fs, attachTarget); attachTarget = null; };
/** 파일 고르는 창을 열어요 — 고른 첨부는 target 항목 아래에 */
function pickAttachFiles(target) { attachTarget = target; fileInput.click(); }
// 끌어다 놓기: 파일을 항목 위에 놓으면 그 항목 아래에(빈 항목이면 그 자리에), 그 밖에 놓으면 지금 화면 맨 아래에 — 글 파일 · 백업은 addFiles가 가져오기로
// 웹페이지에서 끌어온 이미지도 받아요. 브라우저가 파일 없이 주소만 주면 서버가 그 주소에서 내려받아요(/api/upload-url).
let fileOverTimer = 0, dragFromHere = false;
const fileOverOff = () => { clearTimeout(fileOverTimer); document.body.classList.remove('file-over'); };
addEventListener('dragstart', () => { dragFromHere = true; }, true); // 이 화면 안에서 시작한 끌기(글자 · 이미지)는 브라우저 기본 동작 그대로
addEventListener('dragend', () => { dragFromHere = false; }, true);
const dragHasImage = (dt) => !dragFromHere && dt?.types && (dt.types.includes('Files') || dt.types.includes('text/uri-list') || dt.types.includes('text/html'));
addEventListener('dragover', (e) => {
  if (!dragHasImage(e.dataTransfer)) return;
  e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
  document.body.classList.add('file-over');
  clearTimeout(fileOverTimer); fileOverTimer = setTimeout(fileOverOff, 250); // 끌기가 멈추거나 취소(Esc)되면 저절로 사라져요 — 화면이 가려진 채 남지 않게
});
for (const ev of ['dragend', 'mousemove', 'keydown', 'pointerdown', 'blur']) addEventListener(ev, fileOverOff, true);
/** 이름에 확장자가 없거나 낯선 이미지 파일(웹에서 끌어온 것 등)은 형식에 맞는 이름을 붙여요 */
const nameFile = (f) => (f.name && ATTACH_OK.test(f.name)) || !f.type.startsWith('image/') ? f
  : new File([f], `${(f.name || '웹 이미지').replace(/\.[^.]*$/, '') || '웹 이미지'}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace(/\+.*/, '')}`, { type: f.type });
/** 끌어온 웹 이미지의 주소들: HTML의 <img src>가 먼저, 없으면 이미지 확장자로 끝나는 링크 */
function droppedImageUrls(dt) {
  const html = dt.getData('text/html');
  if (html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const srcs = [...doc.querySelectorAll('img')].map((img) => img.getAttribute('src') || '').filter((u) => /^(https?:|data:image\/)/i.test(u));
    if (srcs.length) return [...new Set(srcs)];
  }
  return dt.getData('text/uri-list').split(/\r?\n/).map((u) => u.trim())
    .filter((u) => u && !u.startsWith('#') && /^https?:\/\/[^?#]+\.(png|jpe?g|gif|webp|avif|bmp)([?#]|$)/i.test(u));
}
async function uploadImageUrls(urls, target) {
  await flushAll();
  toast(`이미지 내려받는 중… (${urls.length}개)`, 60000);
  const tokens = [];
  try {
    for (const u of urls) {
      if (u.startsWith('data:')) { // 페이지에 글자로 박혀 있는 이미지는 브라우저에서 바로 파일로
        const b = await (await fetch(u)).blob();
        const fd = new FormData(); fd.append('file', nameFile(new File([b], '웹 이미지', { type: b.type })));
        const r = await postForm('/api/upload', fd);
        if (r.error) throw new Error(r.error);
        tokens.push(r.markdown); continue;
      }
      const own = u.match(/^https?:\/\/[^/]+(\/files\/[0-9a-f]{24}\.[a-z0-9]+)$/); // 이 앱의 첨부면 내려받지 않고 그대로
      if (own && new URL(u).origin === location.origin) { tokens.push(`![이미지](${own[1]})`); continue; }
      const r = await http('/api/upload-url', 'POST', { url: u });
      if (r.error) throw new Error(r.error);
      tokens.push(r.markdown);
    }
  } catch (e) { toast(`이미지를 가져오지 못했어요: ${e.message}`, 5000); if (!tokens.length) return; }
  await placeTokens(tokens, target);
  toast(`${tokens.length}개 첨부했어요`);
}
addEventListener('drop', (e) => {
  fileOverOff();
  const dt = e.dataTransfer;
  if (!dragHasImage(dt)) return;
  const id = e.target.closest?.('#tree .row')?.dataset.id, target = id ? +id : null;
  if (dt.files?.length) { e.preventDefault(); addFiles(dt.files, target); return; } // 첨부 · 글 파일 · 백업 모두
  const urls = droppedImageUrls(dt);
  if (urls.length) { e.preventDefault(); uploadImageUrls(urls, target); return; }
  if (!e.target.isContentEditable && !e.target.closest?.('input, textarea')) e.preventDefault(); // 이미지가 아닌 링크 · 글: 입력칸이면 기본대로 글로 들어가고, 그 밖이면 아무 일도 없게(페이지 이동 방지)
});

export { attachEl, attachTimers, scheduleAttach, ATTACH_OK, uploadFiles, placeTokens, addFiles, attachTarget, pickAttachFiles, fileOverTimer, dragFromHere, fileOverOff, dragHasImage, nameFile, droppedImageUrls, uploadImageUrls };
