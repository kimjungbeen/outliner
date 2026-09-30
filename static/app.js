// 아웃라이너 프론트엔드 (바닐라 JS). 플러그인 API는 맨 아래 apiFor() 참고.
const $ = (s) => document.querySelector(s);
const state = { nodes: new Map(), zoom: null, focusId: null, focusPos: null, sel: new Set(), anchor: null, head: null };
const listeners = {}, decorators = [], commands = [], timers = new Map();

async function http(url, method = 'GET', body) {
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return r.json();
}
const kids = (pid) => [...state.nodes.values()].filter((n) => n.parent_id === pid).sort((a, b) => a.position - b.position);
const create = async (parent_id, position, content = '') => (await http('/api/nodes', 'POST', { parent_id, position, content })).id;
const patch = (id, body) => http(`/api/nodes/${id}`, 'PATCH', body);

function emit(evt, data) {
  for (const f of listeners[evt] || []) { try { f(data); } catch (e) { console.error(e); } }
}

async function refresh() {
  const rows = await http('/api/nodes');
  state.nodes = new Map(rows.map((n) => [n.id, n]));
  if (state.zoom !== null && !state.nodes.has(state.zoom)) state.zoom = null;
  render();
}

// ---- 커서 ----
function caretOffset(el) {
  const s = getSelection();
  if (!s.rangeCount) return 0;
  const cur = s.getRangeAt(0);
  const r = cur.cloneRange();
  r.selectNodeContents(el);
  r.setEnd(cur.endContainer, cur.endOffset);
  return r.toString().length;
}
function setCaret(el, pos) {
  el.focus();
  const len = el.textContent.length;
  const p = pos === 'end' || pos > len ? len : pos;
  const r = document.createRange();
  if (el.firstChild) r.setStart(el.firstChild, p); else r.setStart(el, 0);
  r.collapse(true);
  const s = getSelection();
  s.removeAllRanges();
  s.addRange(r);
}

// ---- 렌더링 ----
function render() {
  const a = document.activeElement;
  if (state.focusId === null && a?.classList.contains('text')) {
    state.focusId = +a.dataset.id;
    state.focusPos = caretOffset(a);
  }
  const idx = new Map();
  for (const n of state.nodes.values()) {
    if (!idx.has(n.parent_id)) idx.set(n.parent_id, []);
    idx.get(n.parent_id).push(n);
  }
  for (const l of idx.values()) l.sort((x, y) => x.position - y.position);

  const tree = $('#tree');
  tree.replaceChildren();
  for (const n of idx.get(state.zoom) || []) tree.appendChild(rowFor(n, idx));
  renderHeader();

  if (state.focusId !== null) {
    const el = tree.querySelector(`.text[data-id="${state.focusId}"]`);
    if (el) setCaret(el, state.focusPos ?? 'end');
  }
  state.focusId = state.focusPos = null;
  paintSel();
  emit('render');
}

function mk(tag, cls) { const e = document.createElement(tag); if (cls) e.className = cls; return e; }

function rowFor(n, idx) {
  const list = idx.get(n.id) || [];
  const wrap = mk('div', 'node'), row = mk('div', 'row');

  const chev = mk('button', 'chev');
  chev.type = 'button';
  chev.tabIndex = -1;
  if (list.length) {
    chev.textContent = n.collapsed ? '▸' : '▾';
    chev.setAttribute('aria-label', n.collapsed ? '펼치기' : '접기');
    chev.onclick = () => toggle(n);
  } else chev.disabled = true;

  const bullet = mk('button', 'bullet');
  bullet.type = 'button';
  bullet.tabIndex = -1;
  bullet.setAttribute('aria-label', '이 항목으로 이동');
  if (n.collapsed && list.length) bullet.classList.add('folded');
  bullet.onclick = () => zoomTo(n.id);

  const prefix = mk('span', 'prefix');
  const text = mk('div', 'text');
  text.contentEditable = 'true';
  text.spellcheck = false;
  text.dataset.id = n.id;
  text.textContent = n.content;
  text.addEventListener('input', () => onInput(n, text));
  text.addEventListener('keydown', (e) => onKey(e, n, text));
  text.addEventListener('paste', (e) => onPaste(e, n, text));

  row.dataset.id = n.id;
  row.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.shiftKey && state.anchor !== null) { e.preventDefault(); selectRange(state.anchor, n.id); }
    else if (e.ctrlKey || e.metaKey) { e.preventDefault(); toggleSel(n.id); }
    else if (state.sel.size) clearSel();
  });

  row.append(chev, bullet, prefix, text);
  wrap.append(row);
  if (list.length && !n.collapsed) {
    const box = mk('div', 'children');
    for (const c of list) box.appendChild(rowFor(c, idx));
    wrap.append(box);
  }
  for (const d of decorators) { try { d({ node: n, row, prefix, text }); } catch (err) { console.error(err); } }
  return wrap;
}

function renderHeader() {
  const crumbs = $('#crumbs'), title = $('#title');
  crumbs.replaceChildren();
  const chain = [];
  for (let cur = state.zoom; cur !== null && state.nodes.has(cur);) {
    const n = state.nodes.get(cur);
    chain.unshift(n);
    cur = n.parent_id;
  }
  crumbs.hidden = title.hidden = !chain.length;
  if (!chain.length) return;
  const link = (label, id) => {
    const a = mk('a');
    a.textContent = label || '(빈 항목)';
    a.href = id === null ? '#' : `#${id}`;
    return a;
  };
  crumbs.append(link('홈', null));
  for (const n of chain.slice(0, -1)) { crumbs.append('/', link(n.content, n.id)); }
  title.textContent = chain.at(-1).content || '(빈 항목)';
}

// ---- 저장 ----
function onInput(n, text) {
  n.content = text.textContent;
  clearTimeout(timers.get(n.id));
  timers.set(n.id, setTimeout(() => saveNow(n.id), 400));
}
async function saveNow(id) {
  if (!timers.has(id)) return;
  clearTimeout(timers.get(id));
  timers.delete(id);
  const n = state.nodes.get(id);
  if (!n) return;
  await patch(id, { content: n.content });
  emit('node:update', n);
}
const flushAll = () => Promise.all([...timers.keys()].map(saveNow));
addEventListener('pagehide', () => {
  for (const id of timers.keys()) {
    const n = state.nodes.get(id);
    if (n) fetch(`/api/nodes/${id}`, { method: 'PATCH', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: n.content }) });
  }
});

// ---- 구조 변경 ----
async function move(n, parent_id, position, caret) {
  await flushAll();
  await patch(n.id, { parent_id, position });
  state.focusId = n.id;
  state.focusPos = caret;
  await refresh();
}
async function toggle(n) {
  await flushAll();
  await patch(n.id, { collapsed: n.collapsed ? 0 : 1 });
  await refresh();
}
async function zoomTo(id) {
  await flushAll();
  location.hash = id === null ? '' : String(id);
}
addEventListener('hashchange', () => {
  state.zoom = location.hash.length > 1 ? +location.hash.slice(1) : null;
  state.sel = new Set();
  state.anchor = state.head = null;
  render();
});

// ---- 붙여넣기 ----
// 여러 줄: 줄마다 항목 하나. 들여쓰기(탭=4칸)와 글머리표(-, *, •, 1.)로 계층을 복원해요.
function parsePaste(raw) {
  const stack = [], items = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = /^([ \t]*)(?:[-*•▪◦‣]\s+|\d+[.)]\s+)?(.*)$/.exec(line);
    const w = [...m[1]].reduce((sum, c) => sum + (c === '\t' ? 4 : 1), 0);
    while (stack.length && stack.at(-1) >= w) stack.pop();
    items.push({ depth: stack.length, text: m[2].trim() });
    stack.push(w);
  }
  return items;
}

async function onPaste(e, n, text) {
  e.preventDefault();
  const raw = e.clipboardData.getData('text/plain');
  const items = parsePaste(raw);
  if (items.length <= 1) { // 한 줄이면 커서 위치에 그대로 삽입
    document.execCommand('insertText', false, raw.replace(/\s*\n\s*/g, ' ').trim());
    return;
  }
  await flushAll();
  const replace = text.textContent === '' && !kids(n.id).length; // 빈 항목이면 그 자리를 대체
  const r = await http('/api/import', 'POST', { parent_id: n.parent_id, position: replace ? n.position : n.position + 1, items });
  if (replace) await http(`/api/nodes/${n.id}`, 'DELETE');
  state.focusId = r.last;
  state.focusPos = 'end';
  await refresh();
}

// ---- 다중 선택 ----
// Ctrl/Cmd+클릭: 하나씩 추가/해제 · Shift+클릭: 범위 · Shift+↑/↓: 키보드로 확장
// 선택 후 Ctrl+C 복사 · Ctrl+X 잘라내기 · Backspace/Delete 삭제 · Esc 해제
const visibleIds = () => [...document.querySelectorAll('#tree .text')].map((el) => +el.dataset.id);
const leaveText = () => { document.activeElement?.blur?.(); getSelection().removeAllRanges(); };

function topSelected() { // 부모가 이미 선택돼 있으면 제외하고, 화면 순서로 정렬
  const under = (id) => {
    for (let p = state.nodes.get(id)?.parent_id; p != null; p = state.nodes.get(p)?.parent_id) if (state.sel.has(p)) return true;
    return false;
  };
  return visibleIds().filter((id) => state.sel.has(id) && !under(id));
}

function paintSel() {
  document.querySelectorAll('#tree .row').forEach((r) => r.classList.toggle('selected', state.sel.has(+r.dataset.id)));
  const top = topSelected();
  $('#selbar').hidden = !state.sel.size;
  $('#selcount').textContent = `${top.length}개 선택됨`;
  $('#exportscope').textContent = state.sel.size ? `선택한 ${top.length}개` : state.zoom !== null ? '현재 화면' : '전체';
}
function selectRange(a, b) {
  const ids = visibleIds(), i = ids.indexOf(a), j = ids.indexOf(b);
  if (i < 0 || j < 0) return;
  state.sel = new Set(ids.slice(Math.min(i, j), Math.max(i, j) + 1));
  state.head = b;
  leaveText();
  paintSel();
}
function toggleSel(id) {
  const s = new Set(state.sel);
  if (s.has(id)) s.delete(id); else s.add(id);
  state.sel = s;
  state.anchor = state.head = id;
  leaveText();
  paintSel();
}
function clearSel() {
  state.sel = new Set();
  state.anchor = state.head = null;
  paintSel();
}
function extendSel(id, dir) {
  if (!state.sel.size) { state.anchor = state.head = id; selectRange(id, id); return; } // 첫 입력은 현재 항목만
  const ids = visibleIds();
  const j = Math.max(0, Math.min(ids.length - 1, ids.indexOf(state.head) + dir));
  selectRange(state.anchor, ids[j]);
}

const countSubtree = (id) => 1 + kids(id).reduce((sum, c) => sum + countSubtree(c.id), 0);
function outlineText(ids) { // 붙여넣기 하면 계층이 그대로 복원되는 형식
  const out = [];
  const walk = (id, d) => { out.push('  '.repeat(d) + '- ' + state.nodes.get(id).content); kids(id).forEach((c) => walk(c.id, d + 1)); };
  ids.forEach((id) => walk(id, 0));
  return out.join('\n');
}
const copySelected = () => navigator.clipboard.writeText(outlineText(topSelected()));
async function deleteSelected(ask = true) {
  const ids = topSelected();
  if (!ids.length) return;
  const total = ids.reduce((sum, id) => sum + countSubtree(id), 0);
  if (ask && !confirm(`선택한 ${ids.length}개 항목을 삭제할까요? (하위 항목 포함 ${total}개)`)) return;
  await flushAll();
  for (const id of ids) await http(`/api/nodes/${id}`, 'DELETE');
  clearSel();
  await refresh();
}

document.addEventListener('keydown', async (e) => {
  if (!state.sel.size || e.isComposing || e.target.closest?.('.text')) return;
  const mod = e.ctrlKey || e.metaKey, key = e.key.toLowerCase();
  if (key === 'escape') clearSel();
  else if (e.shiftKey && !mod && (key === 'arrowup' || key === 'arrowdown')) { e.preventDefault(); extendSel(state.head, key === 'arrowup' ? -1 : 1); }
  else if (key === 'backspace' || key === 'delete') { e.preventDefault(); deleteSelected(); }
  else if (mod && (key === 'c' || key === 'x')) {
    e.preventDefault();
    await copySelected();
    if (key === 'x') await deleteSelected(false);
  }
});
$('#sel-copy').onclick = copySelected;
$('#sel-del').onclick = () => deleteSelected();
$('#sel-clear').onclick = clearSel;

// ---- 내보내기 ----
function exportUrl(fmt) {
  if (fmt === 'db') return '/api/export/db';
  const ids = state.sel.size ? topSelected() : state.zoom !== null ? [state.zoom] : [];
  return `/api/export?format=${fmt}&ids=${ids.join(',')}`;
}
document.querySelectorAll('#export [data-fmt]').forEach((b) => {
  b.onclick = async () => {
    await flushAll();
    const a = document.createElement('a');
    a.href = exportUrl(b.dataset.fmt);
    a.click();
    $('#export').open = false;
  };
});

// ---- 가져오기 ----
// .json(내보내기 파일, 접힘 상태까지 복원) · .md / .txt(붙여넣기와 같은 규칙). 현재 화면의 맨 아래에 추가돼요.
function flattenJson(list, depth = 0, out = []) {
  if (!Array.isArray(list)) throw new Error('올바른 JSON 형식이 아니에요');
  for (const n of list) {
    if (typeof n?.content !== 'string') throw new Error('올바른 JSON 형식이 아니에요');
    out.push({ depth, text: n.content, collapsed: !!n.collapsed });
    if (n.children) flattenJson(n.children, depth + 1, out);
  }
  return out;
}
$('#import').onclick = () => $('#importfile').click();
$('#importfile').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const raw = await file.text();
    const items = /\.json$/i.test(file.name) ? flattenJson(JSON.parse(raw)) : parsePaste(raw);
    if (!items.length) { alert('가져올 항목이 없어요.'); return; }
    await flushAll();
    const r = await http('/api/import', 'POST', { parent_id: state.zoom, position: kids(state.zoom).length, items });
    await refresh();
    alert(`${r.count}개 항목을 가져왔어요.`);
  } catch (err) { alert(`가져오지 못했어요: ${err.message}`); }
};

// ---- 키보드 ----
function comboOf(e) {
  const k = e.code.startsWith('Key') ? e.code.slice(3) : e.code.startsWith('Digit') ? e.code.slice(5) : e.key;
  return [e.ctrlKey || e.metaKey ? 'Ctrl' : '', e.altKey ? 'Alt' : '', e.shiftKey ? 'Shift' : '', k].filter(Boolean).join('+');
}

async function onKey(e, n, text) {
  if (e.isComposing || e.keyCode === 229) return; // 한글 조합 중에는 무시
  const caret = caretOffset(text);

  if (e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault(); // 항목 단위 선택 시작/확장
    extendSel(n.id, e.key === 'ArrowUp' ? -1 : 1);
    return;
  }

  if (e.ctrlKey || e.altKey || e.metaKey) {
    const combo = comboOf(e).toLowerCase();
    const cmd = commands.find((c) => c.keys.toLowerCase() === combo);
    if (cmd) {
      e.preventDefault();
      n.content = text.textContent;
      return cmd.run({ node: n, text });
    }
  }

  const sibs = kids(n.parent_id);
  const i = sibs.findIndex((s) => s.id === n.id);
  const visible = [...document.querySelectorAll('#tree .text')];

  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    const full = text.textContent;
    n.content = full.slice(0, caret);
    clearTimeout(timers.get(n.id));
    timers.delete(n.id);
    await patch(n.id, { content: n.content });
    await flushAll();
    const open = kids(n.id).length && !n.collapsed; // 펼쳐진 하위 항목이 있으면 첫 번째 자식으로
    const id = open ? await create(n.id, 0, full.slice(caret)) : await create(n.parent_id, n.position + 1, full.slice(caret));
    state.focusId = id;
    state.focusPos = 0;
    await refresh();
    emit('node:create', state.nodes.get(id));
  } else if (e.key === 'Tab') {
    e.preventDefault();
    if (e.shiftKey) {
      if (n.parent_id === state.zoom) return; // 현재 화면의 최상위 단계
      const p = state.nodes.get(n.parent_id);
      await move(n, p.parent_id, p.position + 1, caret);
    } else if (i > 0) {
      const p = sibs[i - 1];
      await flushAll();
      if (p.collapsed) await patch(p.id, { collapsed: 0 });
      await move(n, p.id, kids(p.id).length, caret);
    }
  } else if (e.altKey && e.key === 'ArrowUp') {
    e.preventDefault();
    if (i > 0) await move(n, n.parent_id, sibs[i - 1].position, caret);
  } else if (e.altKey && e.key === 'ArrowDown') {
    e.preventDefault();
    if (i < sibs.length - 1) await move(n, n.parent_id, sibs[i + 1].position + 1, caret);
  } else if (e.key === 'Backspace' && text.textContent === '' && !kids(n.id).length) {
    e.preventDefault();
    clearTimeout(timers.get(n.id));
    timers.delete(n.id);
    const prev = visible[visible.indexOf(text) - 1];
    await http(`/api/nodes/${n.id}`, 'DELETE');
    if (prev) { state.focusId = +prev.dataset.id; state.focusPos = 'end'; }
    await refresh();
    emit('node:delete', n);
  } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    const next = visible[visible.indexOf(text) + (e.key === 'ArrowUp' ? -1 : 1)];
    if (next) { e.preventDefault(); setCaret(next, caret); }
  }
}

$('#add').onclick = async () => {
  await flushAll();
  state.focusId = await create(state.zoom, kids(state.zoom).length, '');
  state.focusPos = 'end';
  await refresh();
};

// ---- 플러그인 API ----
const baseApi = {
  getNode: (id) => state.nodes.get(id),
  getNodes: () => [...state.nodes.values()],
  children: (id) => kids(id),
  on(evt, fn) { (listeners[evt] ||= []).push(fn); },             // 'render' | 'node:update' | 'node:create' | 'node:delete'
  decorate(fn) { decorators.push(fn); },                          // fn({ node, row, prefix, text }) — 행이 그려질 때마다 호출
  addCommand(cmd) { commands.push(cmd); },                        // { keys: 'Alt+T', label, run({ node, text }) }
  focus(id, pos = 'end') { state.focusId = id; state.focusPos = pos; render(); },
  refresh,
  async updateNode(id, changes) {
    const n = state.nodes.get(id);
    if (!n) return;
    clearTimeout(timers.get(id));
    timers.delete(id);
    Object.assign(n, changes);
    await patch(id, changes);
    emit('node:update', n);
    render();
  },
};
function apiFor(pluginId) {
  const url = (k) => `/api/plugin-data/${pluginId}/${k}`;
  return { ...baseApi, storage: { get: (k) => http(url(k)).then((r) => r.value), set: (k, v) => http(url(k), 'PUT', { value: v }) } };
}

async function loadPlugins() {
  const { plugins } = await http('/api/plugins');
  for (const name of plugins) {
    try {
      const mod = await import(`/plugins/${name}`);
      mod.default(apiFor(name.replace(/\.js$/, '')));
    } catch (e) { console.error(`플러그인 ${name} 로드 실패`, e); }
  }
}

state.zoom = location.hash.length > 1 ? +location.hash.slice(1) : null;
await loadPlugins();
await refresh();
