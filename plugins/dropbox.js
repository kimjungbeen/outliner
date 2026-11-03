// Dropbox 백업 · 동기화 (dropbox) — 실행할 때마다 Dropbox의 판과 이 기기를 비교해서 올리기 · 받기 · 합치기
// 처음 한 번: Dropbox 앱 키를 넣고 로그인(허용한 뒤 나오는 코드를 붙여 넣기). 그다음부터는 실행하면 바로 맞춰요
//   · Dropbox에 없으면 → 첫 백업(전체 사본)을 올려요
//   · 이 기기만 바뀜 → 바뀐 것만 올리기 · Dropbox만 바뀜(다른 기기가 올림) → 바뀐 것만 받기 · 둘 다 바뀜 → Dropbox 판에 이 기기 변경을 얹어(3-way) 그 차이만 올리고 그걸로
//   · 같은 항목의 글을 양쪽에서 고쳤으면 Dropbox 글은 그대로, 바로 아래에 '⚠ 충돌 · 이 기기에서 고친 글' 항목으로 남겨요
// Dropbox의 앱 폴더(Apps/<앱 이름>/):
//   head.json                 지금 판 { v, seq, reset, snapshot: { seq, path, size }, changes: [{ seq, path, size } …] } — snapshot 판에 changes를 차례로 얹으면 seq 판
//   snapshots/<seq>-….db.gz   전체 사본 (gzip) · changes/<seq>-….jsonl.gz  그 판에서 바뀐 항목만 (gzip — 몇 글자 고치면 몇 KB)
//   files/<첨부>              첨부는 이름이 내용 해시라 없는 것만 주고받아요 (지우지는 않아요)
// 버전은 seq — head.json을 '내가 본 rev일 때만' 바꿔서 두 기기가 동시에 올려도 하나는 막혀요 (그러면 다시 받아서 합쳐요)
// 바뀐 것이 쌓여 전체 사본의 1/4을 넘으면 맞춘 판을 새 전체 사본으로 올리고 예전 것을 지워요 (정리). '덮어쓰기'는 새 전체 사본 + reset — 그 전에 맞춘 기기는 어느 쪽을 쓸지 다시 물어요
// 로그인 정보는 이 브라우저에만 둬요 (DB에 두면 백업에 섞여 Dropbox로 올라가요). 앱과는 api로만 (api.backup · api.files), Dropbox와는 직접 fetch
import { command } from './_kit.js';

const KEY = 'dropbox';                 // api.backup 저장소 이름 (마지막으로 맞춘 판을 앱이 따로 기억해요)
const LS = 'outliner.dropbox';         // 이 브라우저의 로그인 정보 { appKey, refresh, access, expires }
const AFTER = 'outliner.dropbox.after'; // 이 DB를 바꾸면 화면이 새로고침돼요 → 다시 켜진 뒤 알림으로
const HEAD = '/head.json', SNAPS = '/snapshots', CHANGES = '/changes', FILES = '/files';
const COMPACT_MIN = 4 * 1024 * 1024, COMPACT_RATIO = 0.25, COMPACT_COUNT = 300; // 바뀐 것이 이만큼 쌓이면 새 전체 사본으로 정리
const fileName = (seq, ext) => `${String(seq).padStart(8, '0')}-${Math.random().toString(36).slice(2, 10)}.${ext}`; // 같은 seq를 두 기기가 동시에 올려도 이름이 겹치지 않게
const ONE_SHOT = 140 * 1024 * 1024, CHUNK = 64 * 1024 * 1024; // 한 번에 올리는 건 150MB까지 — 넘으면 나눠 올려요
const API = 'https://api.dropboxapi.com', CONTENT = 'https://content.dropboxapi.com';

const loadCfg = () => { try { return JSON.parse(localStorage.getItem(LS) || '{}'); } catch { return {}; } };
const saveCfg = (c) => { try { localStorage.setItem(LS, JSON.stringify(c)); } catch { /* 저장이 안 되는 환경이면 이번만 */ } };
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
/** 한 번에 n개씩 나눠 동시에 (첨부 · 변경 파일 주고받기) — 차례는 그대로 돌려줘요 */
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } }));
  return out;
}
const mb = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`);

/** Dropbox API (로그인 정보 cfg로) — 실패하면 Error { status, summary: 'path/not_found/…' } */
function dropbox(cfg) {
  async function token() {
    if (cfg.access && cfg.expires > Date.now() + 60_000) return cfg.access;
    const r = await fetch(`${API}/oauth2/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: cfg.refresh, client_id: cfg.appKey }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(`Dropbox 로그인이 풀렸어요 — 다시 연결해 주세요 (${j.error_description || j.error || r.status})`), { relogin: true });
    Object.assign(cfg, { access: j.access_token, expires: Date.now() + j.expires_in * 1000 });
    saveCfg(cfg);
    return cfg.access;
  }
  // Dropbox-API-Arg 머리글에는 ASCII만 — 한글 같은 글자는 \uXXXX로
  const argOf = (o) => JSON.stringify(o).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  async function call(url, { arg, json, body } = {}, tries = 0) {
    const headers = { Authorization: `Bearer ${await token()}` };
    if (arg !== undefined) headers['Dropbox-API-Arg'] = argOf(arg);
    if (json !== undefined) headers['Content-Type'] = 'application/json';
    else if (body !== undefined) headers['Content-Type'] = 'application/octet-stream';
    let r;
    try { r = await fetch(url, { method: 'POST', headers, body: json !== undefined ? JSON.stringify(json) : body }); } catch (e) { throw new Error(`Dropbox에 접속하지 못했어요 — 인터넷 연결을 확인해 주세요 (${e.message})`); }
    if (r.status === 401 && tries < 1) { cfg.access = null; return call(url, { arg, json, body }, tries + 1); }
    if ((r.status === 429 || r.status >= 500) && tries < 3) { await sleep((+r.headers.get('Retry-After') || 1 + tries * 2) * 1000); return call(url, { arg, json, body }, tries + 1); }
    if (!r.ok) {
      const t = await r.text(); let e = null;
      try { e = JSON.parse(t); } catch { /* 글 오류 */ }
      const summary = e?.error_summary || '';
      const msg = /insufficient_space/.test(summary) ? 'Dropbox 공간이 모자라요' : `Dropbox 오류 ${r.status}: ${summary || t.slice(0, 200)}`;
      throw Object.assign(new Error(msg), { status: r.status, summary, relogin: r.status === 401 });
    }
    return r;
  }
  const notFound = (e) => e.status === 409 && /not_found/.test(e.summary);
  return {
    /** 파일 정보 { rev, size } | null (없음) */
    async meta(path) {
      try { const m = await (await call(`${API}/2/files/get_metadata`, { json: { path } })).json(); return m['.tag'] === 'file' ? m : null; } catch (e) { if (notFound(e)) return null; throw e; }
    },
    /** 폴더 안 파일 이름들 (없는 폴더면 빈 목록) */
    async names(path) {
      const out = new Set();
      try {
        let j = await (await call(`${API}/2/files/list_folder`, { json: { path, limit: 2000 } })).json();
        for (;;) {
          for (const e of j.entries) if (e['.tag'] === 'file') out.add(e.name);
          if (!j.has_more) break;
          j = await (await call(`${API}/2/files/list_folder/continue`, { json: { cursor: j.cursor } })).json();
        }
      } catch (e) { if (!notFound(e)) throw e; }
      return out;
    },
    download: async (path) => (await call(`${CONTENT}/2/files/download`, { arg: { path } })).blob(),
    /** 받기 + 그 파일의 rev → { blob, rev } | null (없음) — 정보를 따로 묻지 않아도 돼요 (Dropbox-API-Result 머리글) */
    async get(path) {
      let r;
      try { r = await call(`${CONTENT}/2/files/download`, { arg: { path } }); } catch (e) { if (notFound(e)) return null; throw e; }
      let rev = null;
      try { rev = JSON.parse(r.headers.get('Dropbox-API-Result') || 'null')?.rev ?? null; } catch { /* 아래에서 */ }
      return { blob: await r.blob(), rev };
    },
    remove: (path) => call(`${API}/2/files/delete_v2`, { json: { path } }).catch(() => {}), // 정리 — 못 지워도 그만 (head.json이 가리키지 않으면 안 써요)
    /** 올리기 → 올린 파일 정보 { rev }. mode: 'add' | 'overwrite' | { '.tag': 'update', update: rev } — update는 그 rev가 아니면 막혀요 (summary에 conflict) */
    async upload(path, blob, mode = 'add') {
      const commit = { path, mode, autorename: false, mute: true };
      if (blob.size <= ONE_SHOT) return (await call(`${CONTENT}/2/files/upload`, { arg: commit, body: blob })).json();
      const { session_id } = await (await call(`${CONTENT}/2/files/upload_session/start`, { arg: { close: false }, body: new Blob([]) })).json();
      let at = 0;
      for (; blob.size - at > CHUNK; at += CHUNK) await call(`${CONTENT}/2/files/upload_session/append_v2`, { arg: { cursor: { session_id, offset: at }, close: false }, body: blob.slice(at, at + CHUNK) });
      return (await call(`${CONTENT}/2/files/upload_session/finish`, { arg: { cursor: { session_id, offset: at }, commit }, body: blob.slice(at) })).json();
    },
  };
}

/** 로그인 (PKCE — 비밀 키 없이, 허용한 뒤 Dropbox가 보여주는 코드를 붙여 넣어요) */
async function pkce() {
  const verifier = Array.from(crypto.getRandomValues(new Uint8Array(48)), (b) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'[b % 66]).join('');
  if (!crypto.subtle) return { verifier, challenge: verifier, method: 'plain' }; // http://<다른 기기 주소>처럼 안전하지 않은 주소에서는 SHA-256을 못 써요
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  return { verifier, challenge: btoa(String.fromCharCode(...hash)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''), method: 'S256' };
}
const authUrl = (appKey, p) => `https://www.dropbox.com/oauth2/authorize?${new URLSearchParams({ client_id: appKey, response_type: 'code', token_access_type: 'offline', code_challenge: p.challenge, code_challenge_method: p.method })}`;
async function exchange(appKey, code, p) {
  const r = await fetch(`${API}/oauth2/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', code: code.trim(), client_id: appKey, code_verifier: p.verifier }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.refresh_token) throw new Error(`연결하지 못했어요 — ${j.error_description || j.error || r.status} (코드는 한 번만 · 몇 분 안에 써야 해요)`);
  return { appKey, refresh: j.refresh_token, access: j.access_token, expires: Date.now() + j.expires_in * 1000 };
}

function make(api, ui) {
  const { VStack, HStack, Text, TextField, Button, Actions, Spinner, Link, Spacer } = ui;
  let view = null;

  /** Dropbox의 지금 판 → { head, rev } | null (아직 없음) */
  async function readHead(dbx) {
    let g = await dbx.get(HEAD); // 한 번에 내용과 rev를
    if (!g) return null;
    if (!g.rev) { // rev를 못 봤으면(머리글이 안 보이는 환경) 예전처럼 정보 → 그 rev의 내용
      const m = await dbx.meta(HEAD);
      if (!m) return null;
      g = { blob: await dbx.download(`rev:${m.rev}`), rev: m.rev };
    }
    let head = null;
    try { head = JSON.parse(await g.blob.text()); } catch { /* 아래에서 */ }
    if (head?.v !== 1 || !Number.isInteger(head.seq) || !head.snapshot?.path || !Array.isArray(head.changes)) throw new Error('Dropbox의 head.json을 읽지 못했어요 (이 앱이 만든 게 아니거나 망가졌어요)');
    return { head, rev: g.rev };
  }

  /** 맞추기 — log(글)로 진행을 보여주고, 처음 맞추는 기기면 ask()로 어느 쪽을 쓸지 물어요. → 끝 알림 글 (DB를 바꾸면 화면이 새로고침돼요) */
  async function sync(dbx, log, ask, state) {
    log('Dropbox와 이 기기의 판을 보는 중…');
    const [st, cur, { files = [] }, there] = await Promise.all([api.backup.status(KEY), readHead(dbx), api.files.list(), dbx.names(FILES)]); // 한꺼번에 물어요
    let head = cur?.head ?? null, rev = cur?.rev ?? null;

    // 1) 첨부: 없는 것만 서로, 여러 개를 동시에 — 판보다 먼저 (Dropbox 판이 가리키는 첨부가 늘 Dropbox에 있게 · 받은 판을 열면 첨부가 이미 있게)
    const here = new Set(files.map((f) => f.name));
    const up = files.filter((f) => !there.has(f.name)), down = [...there].filter((n) => !here.has(n));
    let done = 0;
    await pool(up, 4, async (f) => {
      await dbx.upload(`${FILES}/${f.name}`, await api.files.blob(f.name), 'overwrite'); // 이름이 내용 해시 — 같은 이름이면 같은 파일
      log(`첨부 올리는 중 ${++done}/${up.length}`, done > 1);
    });
    done = 0;
    await pool(down, 4, async (n) => {
      const r = await api.files.restore(n, await dbx.download(`${FILES}/${n}`));
      if (r.error) log(`⚠ 첨부 ${n}: ${r.error}`);
      log(`첨부 받는 중 ${++done}/${down.length}`, done > 1 && !r.error);
    });
    const fileNote = [up.length && `첨부 ${up.length}개 올림`, down.length && `첨부 ${down.length}개 받음`].filter(Boolean).join(' · ');
    const withFiles = (t) => [t, fileNote].filter(Boolean).join(' · ');

    // 2) 판
    const pathsOf = (h) => [h.snapshot.path, ...h.changes.map((c) => c.path)];
    /** head.json을 next로 (내가 본 rev일 때만 — 아니면 conflict). 막히면 방금 올린 파일(mine)은 지워요 */
    const writeHead = async (next, mine) => {
      try {
        const m = await dbx.upload(HEAD, new Blob([JSON.stringify(next)], { type: 'application/json' }), rev ? { '.tag': 'update', update: rev } : 'add');
        head = next; rev = m.rev;
      } catch (e) { await Promise.all(mine.map((p) => dbx.remove(p))); throw e; }
    };
    /** 이 기기의 판 전체를 seq 판으로 (첫 백업 · 덮어쓰기) — 예전 파일은 지워요 */
    const pushAll = async (seq) => {
      log('이 기기의 판(전체)을 올리는 중…');
      const s = await api.backup.snapshot(KEY);
      log(`이 기기의 판(전체)을 올리는 중… ${mb(s.blob.size)}`, true);
      const path = `${SNAPS}/${fileName(seq, 'db.gz')}`, old = head ? pathsOf(head) : [];
      await dbx.upload(path, s.blob, 'add');
      await writeHead({ v: 1, seq, reset: seq, snapshot: { seq, path, size: s.blob.size }, changes: [] }, [path]);
      await api.backup.commit(KEY, s.token, String(seq));
      await Promise.all(old.map((p) => dbx.remove(p)));
    };
    /** 바뀐 것(blob)을 다음 판으로 올려요 */
    const pushChanges = async (c) => {
      const seq = head.seq + 1, path = `${CHANGES}/${fileName(seq, 'jsonl.gz')}`;
      log(`바뀐 것 ${c.count.toLocaleString('ko-KR')}곳을 올리는 중… ${mb(c.blob.size)}`);
      await dbx.upload(path, c.blob, 'add');
      await writeHead({ ...head, seq, changes: [...head.changes, { seq, path, size: c.blob.size }] }, [path]);
    };
    /** Dropbox 판을 이 기기에서 다시 만들어요 — from: 맞춘 판의 seq (그 뒤 바뀐 것만 받아요) | null (전체 사본부터) */
    const rebuild = async (from) => {
      if (from !== null && from < head.snapshot.seq) from = null; // 그 사이 정리돼서 그 뒤 변경이 없어요 → 전체 사본부터
      const list = head.changes.filter((c) => c.seq > (from ?? head.snapshot.seq));
      const size = (from === null ? head.snapshot.size : 0) + list.reduce((n, c) => n + c.size, 0);
      log(from === null ? `Dropbox 판(전체)을 받는 중… ${mb(size)}` : `바뀐 것 받는 중 · ${list.length}개 · ${mb(size)}`);
      const [snapshot, changes] = await Promise.all([ // 전체 사본과 변경 파일을 동시에 받고, 얹는 건 차례대로
        from === null ? dbx.download(head.snapshot.path) : null,
        pool(list, 6, (c) => dbx.download(c.path)),
      ]);
      log('받은 판을 만드는 중…');
      return api.backup.build(KEY, { snapshot, changes });
    };
    /** 쌓인 변경이 많으면 맞춘 판(= 지금 Dropbox 판)을 새 전체 사본으로 — 다른 기기가 그사이 바꿨으면 그만둬요 */
    const compact = async () => {
      const total = head.changes.reduce((n, c) => n + c.size, 0);
      if (!head.changes.length || (total < Math.max(COMPACT_MIN, head.snapshot.size * COMPACT_RATIO) && head.changes.length < COMPACT_COUNT)) return;
      log(`Dropbox 정리 중 — 쌓인 변경 ${head.changes.length}개를 새 전체 사본으로…`);
      const s = await api.backup.snapshot(KEY, { of: 'base' });
      const path = `${SNAPS}/${fileName(head.seq, 'db.gz')}`, old = pathsOf(head);
      await dbx.upload(path, s.blob, 'add');
      try { await writeHead({ ...head, snapshot: { seq: head.seq, path, size: s.blob.size }, changes: [] }, [path]); } catch (e) { if (/conflict/.test(e.summary || '')) return; throw e; }
      await Promise.all(old.map((p) => dbx.remove(p)));
    };
    // 이 DB를 바꾸면 열린 화면이 새로고침돼요 → 다시 켜진 뒤에도 알림으로 보이게 먼저 적어 둬요
    const replaced = async (token, msg, backup = false) => {
      sessionStorage.setItem(AFTER, msg); state.applying = true;
      log('받은 판을 이 기기에 적용하는 중…');
      await api.backup.commit(KEY, token, String(head.seq), { apply: true, backup });
      return msg;
    };

    if (!head) { await pushAll(0); return withFiles('Dropbox에 첫 백업을 만들었어요'); }
    const B = /^\d+$/.test(st.synced || '') ? Number(st.synced) : null;
    if (B === null || !st.base || B < (head.reset ?? 0) || B > head.seq) { // 이 기기는 처음 (또는 맞춘 판을 잃음 · 다른 기기가 덮어씀) — 어느 쪽을 쓸지
      const pick = await ask();
      if (pick === 'pull') { const r = await rebuild(null); return replaced(r.token, withFiles('Dropbox의 판으로 바꿨어요 (예전 이 기기 판은 백업해 뒀어요)'), true); }
      if (pick === 'push') { await pushAll(head.seq + 1); return withFiles('이 기기의 판으로 Dropbox를 덮어썼어요'); }
      return null;
    }
    if (B === head.seq) {
      let msg = '이미 같아요 — 바뀐 게 없어요';
      if (st.changed) {
        log('바뀐 것을 찾는 중…');
        const c = await api.backup.changes(KEY);
        if (c.count) { await pushChanges(c); msg = `이 기기에서 바뀐 것을 올렸어요 (${c.count.toLocaleString('ko-KR')}곳 · ${mb(c.blob.size)})`; }
        await api.backup.commit(KEY, c.token, String(head.seq));
      }
      await compact();
      return withFiles(msg);
    }
    const r = await rebuild(B);
    if (!st.changed) return replaced(r.token, withFiles('다른 기기에서 바뀐 것을 받았어요'));
    log('양쪽 다 바뀌었어요 — Dropbox 판에 이 기기 변경을 얹는 중…');
    const m = await api.backup.merge(KEY, r.token);
    if (m.count) await pushChanges(m);
    const what = [m.added && `추가 ${m.added}`, m.updated && `고침 ${m.updated}`, m.moved && `옮김 ${m.moved}`, m.deleted && `지움 ${m.deleted}`, m.conflicts && `⚠ 충돌 ${m.conflicts} (아래에 '이 기기에서 고친 글'로)`].filter(Boolean).join(' · ');
    return replaced(m.token, withFiles(`양쪽 변경을 합쳤어요${what ? ` — 이 기기 것: ${what}` : ''}`));
  }

  /** 맞추기를 돌리고 화면에 진행 · 결과를 보여줘요. Dropbox 쪽이 그사이 바뀌었으면(동시에 올림) 다시 */
  async function run() {
    const set = view.set, dbx = dropbox(loadCfg()), state = { applying: false };
    const lines = [];
    const log = (t, replace = false) => { if (replace && lines.length) lines[lines.length - 1] = t; else lines.push(t); set({ lines: [...lines] }); };
    const ask = () => new Promise((ok) => set({ phase: 'choose', choose: (v) => { set({ phase: 'work', choose: null }); ok(v); } }));
    set({ phase: 'work', lines: [], result: '', error: '' });
    try {
      for (let tries = 0; ; tries++) {
        try {
          sessionStorage.removeItem(AFTER);
          state.applying = false;
          const done = await sync(dbx, log, ask, state);
          if (done === null) return view.close(null);
          setTimeout(() => sessionStorage.removeItem(AFTER), 10_000); // 새로고침되지 않았으면(바꾸지 않음) 남기지 않아요
          return set({ phase: 'done', result: done });
        } catch (e) {
          if (tries < 2 && /conflict/.test(e.summary || '')) { log('그사이 다른 기기가 올렸어요 — 다시 맞추는 중…'); continue; }
          throw e;
        }
      }
    } catch (e) {
      // 이 기기에 적용하는 중에 끊겼으면 새로고침 때문일 수 있어요 — 알림 글은 남겨 두고(다시 켜지면 보여요), 새로고침되지 않으면 조금 뒤 지워요
      if (state.applying) setTimeout(() => sessionStorage.removeItem(AFTER), 10_000); else sessionStorage.removeItem(AFTER);
      if (e.relogin) { saveCfg({ appKey: loadCfg().appKey }); set({ phase: 'setup', error: e.message }); return; }
      set({ phase: 'error', error: e.message || String(e) });
    }
  }

  async function connect(s, set) {
    set({ busy: true, error: '' });
    try {
      const cfg = await exchange(s.appKey.trim(), s.code, s.pkce);
      saveCfg(cfg);
      set({ busy: false, code: '' });
      await run();
    } catch (e) { set({ busy: false, error: e.message }); }
  }

  const setupBody = (s, set, close) => VStack({ gap: 12 },
    Text('처음 한 번만: 내 Dropbox에 이 앱이 쓸 폴더를 만들고 연결해요. 로그인 정보는 이 브라우저에만 남아요.').font('callout').wrap(),
    VStack({ gap: 4 },
      HStack({ gap: 6 }, Text('1.').bold(), Link('Dropbox 개발자 화면', 'https://www.dropbox.com/developers/apps/create'), Text('에서 Create app → Scoped access · App folder · 이름은 아무거나')).wrap(),
      HStack({ gap: 6 }, Text('2.').bold(), Text('Permissions 탭: files.content.write · files.content.read 체크 → Submit')).wrap(),
      HStack({ gap: 6 }, Text('3.').bold(), Text('Settings 탭의 App key를 아래에 붙여 넣기')).wrap(),
    ).font('callout'),
    TextField(s.appKey, (v) => set({ appKey: v, pkce: null }), { placeholder: 'App key', mono: true }).attr('data-f', 'app-key').autofocus(),
    HStack({ gap: 8 },
      Button('Dropbox에서 허용하기', async () => { const p = s.pkce || await pkce(); set({ pkce: p }); window.open(authUrl(s.appKey.trim(), p), '_blank'); })
        .disabled(!s.appKey.trim()).attr('data-f', 'authorize'),
      Text(s.pkce ? '허용한 뒤 보이는 코드를 아래에 붙여 넣어요' : '').font('caption').color('mute'),
    ),
    s.pkce && TextField(s.code, (v) => set({ code: v }), { placeholder: '허용 코드', mono: true, onSubmit: () => s.code.trim() && connect(view.s, set) }).attr('data-f', 'code'),
    s.error && Text(s.error).color('danger').wrap().attr('data-f', 'error'),
    Actions(
      Button('취소', () => close(null)).style('ghost'),
      Button(s.busy ? '연결하는 중…' : '연결하고 맞추기', () => connect(s, set)).style('primary').disabled(!s.pkce || !s.code.trim() || s.busy).attr('data-f', 'connect'),
    ),
  );

  const workBody = (s, set, close) => VStack({ gap: 10 },
    VStack({ gap: 4 }, s.lines.map((t, i) => HStack({ gap: 8 },
      s.phase === 'work' && i === s.lines.length - 1 ? Spinner() : Text('✓').color('ok'),
      Text(t).wrap().grow(),
    ).key(`l${i}`))).attr('data-f', 'log'),
    s.phase === 'choose' && VStack({ gap: 8 },
      Text('Dropbox에 이미 백업이 있어요. 이 기기는 처음 맞추는 거라 어느 쪽을 쓸지 골라 주세요.').wrap(),
      Text('바꾸면 지금 이 기기의 판은 따로 백업해 둬요 (데이터 폴더의 …-before-remote-….db).').font('caption').color('mute').wrap(),
      Actions(
        Button('취소', () => s.choose(null)).style('ghost'),
        Button('이 기기 것으로 Dropbox 덮어쓰기', () => s.choose('push')).style('ghost').attr('data-f', 'choose-push'),
        Button('Dropbox 것으로 바꾸기', () => s.choose('pull')).style('primary').attr('data-f', 'choose-pull'),
      ),
    ).attr('data-f', 'choose'),
    s.phase === 'done' && Text(s.result).bold().color('ok').wrap().attr('data-f', 'result'),
    s.phase === 'error' && Text(s.error).color('danger').wrap().attr('data-f', 'error'),
    (s.phase === 'done' || s.phase === 'error') && Actions(
      Button('연결 끊기', () => { saveCfg({ appKey: loadCfg().appKey }); close(null); ui.toast('Dropbox 연결을 끊었어요 (이 브라우저)'); }).style('ghost').tooltip('이 브라우저의 로그인 정보를 지워요 — Dropbox의 백업은 그대로'),
      Spacer(),
      s.phase === 'error' && Button('다시', () => run()).style('ghost'),
      Button('닫기', () => close(null)).style('primary').autofocus().attr('data-f', 'close'),
    ),
  );

  return {
    async dropbox() {
      if (view) return;
      await api.view.flush();
      const cfg = loadCfg();
      await ui.sheet({
        title: 'Dropbox 백업 · 동기화',
        state: { phase: cfg.refresh ? 'work' : 'setup', appKey: cfg.appKey || '', code: '', pkce: null, busy: false, error: '', lines: [], result: '', choose: null },
        outside: false, // 맞추는 동안 바깥을 눌러 닫히지 않게
        task: (s, set, close) => { view = { s, set, close }; if (cfg.refresh) run(); },
        body: (s, set, close) => (s.phase === 'setup' ? setupBody : workBody)(s, set, close).frame({ maxWidth: 560 }),
      }).finally(() => { view = null; });
      api.view.restoreFocus();
    },
  };
}

export default (api) => {
  const after = sessionStorage.getItem(AFTER); // 받은 판으로 바꿔서 새로고침됐어요 → 무엇을 했는지
  if (after) { sessionStorage.removeItem(AFTER); setTimeout(() => api.ui.toast(after, 6), 800); }
  command(api, { name: 'dropbox', label: 'Dropbox 백업 · 동기화 (실행할 때마다 Dropbox 판과 비교해 올리기 · 받기 · 합치기 — 첨부까지)', preload: false, make });
};
