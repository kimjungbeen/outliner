// 바탕: 모든 모듈이 같이 쓰는 것 (화면 상태 · 서버 요청 · 요소 만들기 · 알림). 다른 모듈에 기대지 않아요 — 모듈을 처음 읽을 때 바로 써도 안전해요.


const $ = (s) => document.querySelector(s);
const state = {
  nodes: new Map(),        // id → {id, parent_id, content, collapsed, hk(자식 있음)}  (불러온 것만)
  ch: new Map(),           // 부모 id(최상위는 null) → {ids: [불러온 앞부분], total, show(화면에 그릴 개수)}
  zoom: null, path: [],    // 현재 화면 항목과 그 조상들 [{id, content}]
  focusId: null, focusPos: null, flash: null, ensure: null,
  sel: new Set(), anchor: null, head: null,
  hl: new Set(),           // 플러그인 검색이 찾은 항목들 (Esc로 해제)
};
const listeners = {}, timers = new Map(); // listeners: 앱 안의 소식(render · node:update …) — 플러그인에는 열지 않아요

const CLIENT_ID = globalThis.crypto?.randomUUID?.() ?? String(Math.random()).slice(2); // 이 화면의 이름표 — 내가 한 변경은 내가 다시 받지 않게
async function http(url, method = 'GET', body) {
  for (let tries = 0; ; tries++) {
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json', 'X-Client-Id': CLIENT_ID }, body: body ? JSON.stringify(body) : undefined });
    // 이 앱은 403을 내지 않아요. 403은 같은 포트를 쓰는 다른 프로그램(맥 AirPlay 수신 모드 등)이 요청을 가로챈 것 → 처리되지 않았으니 다시 보내요
    if (r.status === 403 && tries < 4) { await new Promise((ok) => setTimeout(ok, 80 * (tries + 1))); continue; }
    if (r.status === 403) throw new Error('403: 다른 프로그램이 같은 포트를 쓰고 있어요 — 앱을 다른 포트로 켜 주세요 (OUTLINER_PORT)');
    return r.json();
  }
}

/** 서버가 JSON이 아닌 답을 줬을 때(너무 큰 파일 · 서버 오류 등) 사람이 읽을 글 */
const httpError = (status) => (status === 413 ? '파일이 너무 커요' : `서버 응답 ${status}`);
/** 파일 보내기(FormData) → 서버 답(JSON). JSON이 아니면 { error } — 413 같은 오류 페이지도 알림으로 보여 줄 수 있게 */
async function postForm(url, fd) {
  const r = await fetch(url, { method: 'POST', headers: { 'X-Client-Id': CLIENT_ID }, body: fd });
  return r.json().catch(() => ({ error: httpError(r.status) }));
}

function emit(evt, data) {
  for (const f of listeners[evt] || []) { try { f(data); } catch (e) { console.error(e); } }
}
/** 아래쪽 알림 (앱 · 플러그인 모두). err면 빨간색 */
function toast(msg, ms = 2600, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('err', !!err);
  t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { t.hidden = true; }, ms);
}
function mk(tag, cls) { const e = document.createElement(tag); if (cls) e.className = cls; return e; }

export { $, state, listeners, timers, CLIENT_ID, http, postForm, httpError, emit, toast, mk };
