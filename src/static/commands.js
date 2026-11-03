// 명령 (앱 바탕): 명령 등록부 · 명령마다 단축키 · ★ · 선택 막대 · 글자 메뉴에 띄울지 — 명령 목록 창은 cmdlist.js(⌘/)
// 그리고 명령 · 플러그인이 같이 쓰는 것: 찾은 항목 강조(위쪽 ▲▼ 막대) · 항목으로 가기(openHit) · 이 화면에서 펼쳐 보이기(openInPlace)
// 검색 창(⌘K)은 플러그인이에요 — plugins/search.js
import { afterDraw, captureFocus, ck, comboOf, drag, flushAll, ingest, isMac, render, setZoom, settleFlash, upsert } from './app.js';
import { $, http, mk, state, toast } from './base.js';
import { modalOpen, modalShell } from './dialog.js';

const paletteCommands = new Map(); // 이름 → { name, label, keys, selection, text, run } — 명령은 모두 plugins/ 폴더의 파일이 등록해요
const pal = { prevId: null, picked: '' }; // picked: 명령을 부를 때 고른 글자 (api.text.picked()) // prevId: 명령을 실행하기 직전에 커서가 있던 항목 (명령이 '이 항목'으로 써요)
/** 검색 창 같은 덮개 창이 떠 있나요 — 플러그인의 덮개는 data-overlay를 달아요 (떠 있는 동안 앱이 커서 · 키를 빼앗지 않아요) */
const overlayOpen = () => !!document.querySelector('[data-overlay]:not([hidden])');
const paletteOpen = overlayOpen; // 예전 이름
/** 창을 닫으면 원래 있던 자리로 커서를 돌려줘요 */
function restoreFocusAfterPalette() {
  if (state.focusId !== null) afterDraw();
}

/** 항목 주소 (다른 브라우저 창에 붙여 넣으면 그 항목 안으로 바로 들어가요) */
const nodeUrl = (id) => `${location.origin}/#${id}`;
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return; } catch { /* 전용 창 등 클립보드 API가 막힌 곳은 아래 방법으로 */ }
  const ta = mk('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
  document.body.append(ta);
  ta.select();
  const ok = document.execCommand('copy');
  ta.remove();
  if (!ok) throw new Error('클립보드에 쓰지 못했어요');
}
async function copyNodeUrl(id) {
  const url = nodeUrl(id);
  try { await copyText(url); toast(`주소를 복사했어요 — ${url}`); } catch (e) { toast(`복사하지 못했어요: ${e.message}`, 4000); }
}
async function toggleCmdFav(name) {
  const i = cmdPrefs.favs.indexOf(name);
  if (i >= 0) cmdPrefs.favs.splice(i, 1); else cmdPrefs.favs.push(name);
  try { await http('/api/plugin-data/core/cmd_favs', 'PUT', { value: cmdPrefs.favs }); } catch (e) { toast(`저장하지 못했어요: ${e.message}`, 4000); }
}
/** 찾은 항목 강조. ids를 주면 그 항목들을 강조(이전 강조는 해제)하고 첫 번째로 스크롤, 빈 배열이면 해제.
 *  강조가 켜져 있으면 위쪽 막대의 ▲▼로 다음 · 이전 항목으로 넘어가요. */
state.hlIdx = 0;
const hlRows = () => [...document.querySelectorAll('#tree .row.found')]; // 화면 순서
function updateHlBar() {
  const rows = hlRows();
  $('#hlbar').hidden = !state.hl.size;
  $('#hlcount').textContent = state.hl.size ? `${rows.length ? state.hlIdx + 1 : 0} / ${state.hl.size}` : '';
  rows.forEach((r, i) => r.classList.toggle('current', i === state.hlIdx));
}
function stepHighlight(dir) {
  const rows = hlRows();
  if (!rows.length) return;
  state.hlIdx = (state.hlIdx + dir + rows.length) % rows.length;
  updateHlBar();
  const r = rows[state.hlIdx];
  const go = () => r.scrollIntoView({ block: 'center' });
  go(); requestAnimationFrame(() => { go(); requestAnimationFrame(go); });
  r.querySelector('.text')?.focus({ preventScroll: true });
}
let hlSince = 0; // 강조를 켠 때. 그 뒤에 일어난 클릭 · 키 입력만 강조를 꺼요 (강조를 켠 그 Enter · 클릭 자체는 빼고)
function setHighlight(ids, { scroll = true } = {}) {
  state.hl = new Set(ids);
  state.hlIdx = 0;
  hlSince = performance.now();
  document.querySelectorAll('#tree .row.found').forEach((r) => { if (!state.hl.has(+r.dataset.id)) r.classList.remove('found', 'current'); });
  for (const id of state.hl) {
    const r = document.querySelector(`#tree .row[data-id="${id}"]`);
    if (!r) continue;
    r.classList.remove('found'); void r.offsetWidth; r.classList.add('found'); // 애니메이션을 다시 재생
  }
  updateHlBar();
  if (scroll && hlRows().length) stepHighlight(0);
}
$('#hl-prev').onclick = () => stepHighlight(-1);
$('#hl-next').onclick = () => stepHighlight(1);
$('#hl-off').onclick = () => setHighlight([]);
// 강조는 사용자가 다른 곳을 누르거나 키를 치면 저절로 꺼져요. 위쪽 막대(▲ ▼ ✕)를 누를 때만 그대로예요.
// (터치에서 화면을 밀어 스크롤할 때는 꺼지지 않게 pointerdown이 아니라 click으로 봐요. ⇧·⌘ 같은 보조 키만 누른 건 입력이 아니에요)
const HL_KEEP_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Fn', 'Escape']); // Esc는 아래에서 따로 꺼요
for (const ev of ['click', 'keydown']) document.addEventListener(ev, (e) => {
  if (!state.hl.size || e.timeStamp < hlSince || !e.isTrusted) return;
  if (ev === 'keydown' && HL_KEEP_KEYS.has(e.key)) return;
  if (e.target.closest?.('#hlbar')) return;
  setHighlight([], { scroll: false });
}, true);

// Esc: 검색 창 닫기 · 찾은 항목 강조 끄기 (검색 창 열기는 ⌘K). 드래그 중 · 플러그인 창이 떠 있을 때는 그쪽이 먼저 처리해요.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.isComposing || e.keyCode === 229) return;
  if (overlayOpen()) return; // 덮개 창이 스스로 닫아요
  if (drag.on) return;
  if (modalOpen() || document.querySelector('.wfx-prompt')) return;
  if (state.hl.size) { e.preventDefault(); setHighlight([]); } // 찾은 항목 강조 끄기
}, true);

// ---- 명령 즐겨찾기 · 명령마다 단축키 ----
// 둘 다 DB(plugin_data 'core')에 저장해요 → 같은 서버에 붙은 브라우저 · 기기 모두 같은 즐겨찾기 · 단축키를 써요. 명령 목록은 ★ 다음 알파벳 순이에요.
// keys: 내가 바꾼 조합('Alt+Shift+K') → 명령 이름 · off: 기본 단축키를 지운 명령들
// favs: ★ 즐겨찾기한 명령 이름들 (넣은 순서) — 명령 목록 맨 위 · 모바일 막대 맨 앞
// bar: 선택 막대에 띄울지 내가 정한 명령들 (이름 → true · false). 안 정했으면 명령이 정한 대로(selection이 있으면 띄워요)
// text: 글자를 고를 때 뜨는 글자 메뉴에 띄울지 내가 정한 명령들 (안 정했으면 text가 있으면 띄워요)
// tag: 태그를 누르면 부를지 내가 정한 명령들 (안 정했으면 tag가 있으면 불러요)
const cmdPrefs = { keys: {}, off: new Set(), favs: [], bar: {}, text: {}, tag: {} };
async function loadCmdPrefs() {
  try {
    const [k, f, b, t, g] = await Promise.all(['cmd_keys', 'cmd_favs', 'cmd_bar', 'cmd_text', 'cmd_tag'].map((x) => http(`/api/plugin-data/core/${x}`)));
    cmdPrefs.tag = g.value && typeof g.value === 'object' ? g.value : {};
    cmdPrefs.text = t.value && typeof t.value === 'object' ? t.value : {};
    cmdPrefs.favs = Array.isArray(f.value) ? f.value : [];
    cmdPrefs.bar = b.value && typeof b.value === 'object' ? b.value : {};
    const v = k.value || {};
    if (v.map) { cmdPrefs.keys = v.map; cmdPrefs.off = new Set(v.off || []); } else cmdPrefs.keys = v; // 예전 형식(조합 → 이름)도 읽어요
  } catch { /* 처음이거나 못 읽으면 빈 채로 */ }
}
/** 선택 막대에 띄우는 명령인지: 내가 정한 것 → 없으면 명령이 정한 것(selection) */
const inSelBar = (c) => cmdPrefs.bar[c.name] ?? !!c.selection;
/** 글자 메뉴에 띄우는 명령인지: 내가 정한 것 → 없으면 명령이 정한 것(text) */
const inTextBar = (c) => cmdPrefs.text[c.name] ?? !!c.text;
/** 태그를 누르면 부르는 명령인지: 내가 정한 것 → 없으면 명령이 정한 것(tag) */
const inTagMenu = (c) => cmdPrefs.tag[c.name] ?? !!c.tag;
/** 선택 막대 · 글자 메뉴 · 태그에 띄우기 · 빼기 (명령 목록) — 명령이 정한 것과 같으면 내 설정을 지워요. where: 'bar' | 'text' | 'tag' */
async function setMenuPref(where, name, on) {
  const c = paletteCommands.get(name);
  if (!c) return;
  const prefs = cmdPrefs[where], dflt = !!(where === 'bar' ? c.selection : where === 'tag' ? c.tag : c.text);
  if (on === dflt) delete prefs[name]; else prefs[name] = on;
  try { await http(`/api/plugin-data/core/cmd_${where}`, 'PUT', { value: prefs }); } catch (e) { toast(`저장하지 못했어요: ${e.message}`, 4000); }
}
const setSelBar = (name, on) => setMenuPref('bar', name, on);
const setTextBar = (name, on) => setMenuPref('text', name, on);
const setTagMenu = (name, on) => setMenuPref('tag', name, on);
// 기본 단축키는 명령(플러그인)마다 스스로 정해요: addPaletteCommands([{ name, keys: 'Alt+K', … }]).
// ⌥(Alt)+알파벳, 덜 쓰는 것은 ⌥⇧ — Mac에서는 ⌃(Control)+알파벳. 'Ctrl+…'은 Windows의 Ctrl · Mac의 ⌘. Windows 브라우저가 가로채는 Alt+D · E · F, Alt+Shift+I · T는 쓰지 마세요.
const defaultKey = (name) => { const k = paletteCommands.get(name)?.keys; return k && (isMac ? k.replace(/^Alt\+/, 'Ctl+') : k); };
function effectiveKeys() { // 기본값 위에 내가 바꾼 것을 얹어요 (조합 → 이름)
  const mine = cmdPrefs.keys, mineNames = new Set(Object.values(mine)), eff = {};
  for (const name of paletteCommands.keys()) {
    const combo = defaultKey(name);
    if (!combo || cmdPrefs.off.has(name) || mineNames.has(name) || mine[combo]) continue;
    eff[combo] = name;
  }
  return Object.assign(eff, mine);
}
/** 명령 실행 (단축키 · 모바일 버튼 공통): 지금 커서 항목을 '이 항목'으로 넘기고 사용 횟수를 세요 */
/** 지금 글 칸에서 고른 글자 (없으면 '') — 명령을 부르는 순간의 것 */
function selectedText() {
  const s = getSelection();
  if (!s.rangeCount || s.isCollapsed) return '';
  const n = s.getRangeAt(0).commonAncestorContainer;
  return (n.nodeType === 1 ? n : n.parentElement)?.closest?.('#tree .text, #title') ? s.toString() : '';
}
/** 명령 실행 — 어떤 길로 부르든(단축키 · ⌘/ · 선택 막대 · 글자 메뉴) 그때 고른 글자가 있으면 run의 첫 인자로 넘겨요 (글을 입력받는 명령은 입력 칸에 미리 넣어요)
 *  ⌘/처럼 창을 띄웠다 부르는 곳은 열 때 기억한 글자를 args로 줘요 */
async function runCommandNow(c, ...args) {
  if (!args.length) { const t = selectedText(); if (t) args = [t]; }
  pal.picked = typeof args[0] === 'string' ? args[0] : '';
  captureFocus();
  pal.prevId = state.focusId ?? (state.sel.size === 1 ? [...state.sel][0] : null);
  try { await c.run(...args); } catch (err) { console.error(err); toast(`${c.name} 명령을 실행하지 못했어요: ${err.message}`, 4000); }
}
const keyOfCommand = (name) => { const eff = effectiveKeys(); return Object.keys(eff).find((k) => eff[k] === name) || null; };
const KEY_SYM = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Enter: '↵', Backspace: '⌫', Delete: 'Del', ' ': 'Space' };
function fmtCombo(combo) {
  const parts = combo.split('+').filter(Boolean), key = parts.pop() ?? '+';
  const k = KEY_SYM[key] || (key.length === 1 ? key.toUpperCase() : key);
  if (isMac) return parts.map((p) => ({ Ctrl: '⌘', Ctl: '⌃', Alt: '⌥', Shift: '⇧' }[p])).join('') + k;
  return [...parts, k].join('+');
}
// 앱이 이미 쓰는 조합 (Mac의 ⌘도 Ctrl로 적어요). 겹치면 경고하고, 지정하면 이 명령이 대신 실행돼요.
const BUILTIN_KEYS = new Set([ 'Ctrl+.', 'Ctrl+,', 'Ctrl+Shift+>', 'Ctrl+Shift+<', 'Ctrl+Shift+.', 'Ctrl+Shift+,', 'Ctrl+/', 'Ctrl+ArrowUp', 'Ctrl+ArrowDown', 'Ctrl+Shift+ArrowUp', 'Ctrl+Shift+ArrowDown',
  'Ctrl+Z', 'Ctrl+Shift+Z', 'Ctrl+Y', 'Ctrl+1', 'Ctrl+2', 'Ctrl+3', 'Ctrl+A', 'Ctrl+C', 'Ctrl+X', 'Ctrl+V', 'Ctrl+Shift+Backspace', 'Ctrl+Shift+Delete', 'Tab', 'Shift+Tab']);
const BROWSER_KEYS = new Set(['Ctrl+W', 'Ctrl+T', 'Ctrl+N', 'Ctrl+Shift+N', 'Ctrl+Shift+T', 'Ctrl+Q', 'Ctrl+Shift+W', 'Ctrl+Tab', 'Ctrl+Shift+Tab', 'Ctrl+L', 'Ctrl+R', 'Ctrl+P', 'Ctrl+F']);
const isModKey = (e) => ['Control', 'Meta', 'Alt', 'Shift', 'CapsLock', 'Fn', 'OS', 'AltGraph', 'Process', 'HangulMode', 'Unidentified'].includes(e.key);
const usable = (combo) => /(^|\+)(Ctrl|Ctl|Alt)\+/.test(combo) || /(^|\+)F([1-9]|1[0-2])$/.test(combo); // 글을 쓰는 데 방해가 안 되게 Ctrl/⌘·Alt 조합 또는 F1~F12만

let keyCapture = false;
function assignShortcut(cmd) {
  return new Promise((resolve) => {
    keyCapture = true;
    const old = keyOfCommand(cmd.name);
    let pending = null;
    const { dlg, close } = modalShell({
      cls: 'key-dlg', label: '단축키 지정',
      onKey: (e) => { onk(e); return true; }, // 이 창은 모든 키를 받아요 (누른 조합을 보여줘요)
      onClose: () => {
        keyCapture = false;
        resolve();
      },
    });
    const h = mk('h2'); h.textContent = `단축키 지정 · ${cmd.name}`;
    const sub = mk('p', 'pdf-sub'); sub.textContent = cmd.label || '';
    const box = mk('div', 'key-box'); box.textContent = old ? fmtCombo(old) : '누를 키 조합을 입력하세요';
    const note = mk('p', 'key-note');
    note.textContent = `${isMac ? '⌘ · ⌃ · ⌥' : 'Ctrl 또는 Alt'}가 들어간 조합, 또는 F1~F12 · Enter 저장 · Esc 취소`;
    const foot = mk('div', 'pdf-foot');
    const btn = (label, cls, fn) => { const b = mk('button', 'pdf-btn' + (cls ? ` ${cls}` : '')); b.type = 'button'; b.textContent = label; b.onmousedown = (e) => e.preventDefault(); b.onclick = fn; foot.append(b); return b; };
    const done = () => close();
    const save = async (combo, reset = false) => { // combo: 새 조합 · null: 지우기 · reset: 기본값으로
      for (const [k, v] of Object.entries(cmdPrefs.keys)) if (v === cmd.name || k === combo) delete cmdPrefs.keys[k];
      cmdPrefs.off.delete(cmd.name);
      if (combo) cmdPrefs.keys[combo] = cmd.name;
      else if (!reset && defaultKey(cmd.name)) cmdPrefs.off.add(cmd.name);
      try { await http('/api/plugin-data/core/cmd_keys', 'PUT', { value: { map: cmdPrefs.keys, off: [...cmdPrefs.off] } }); } catch (e) { toast(`저장하지 못했어요: ${e.message}`, 4000); }
      const now = keyOfCommand(cmd.name);
      toast(now ? `${cmd.name} 단축키: ${fmtCombo(now)}` : `${cmd.name} 단축키를 지웠어요`);
      done();
    };
    const def = defaultKey(cmd.name);
    if (def && old !== def) btn(`기본값 ${fmtCombo(def)}`, '', () => save(null, true));
    if (old) btn('단축키 지우기', '', () => save(null));
    btn('취소', '', done);
    const ok = btn('저장', 'primary', () => pending && save(pending));
    ok.disabled = true;
    const show = (combo) => {
      pending = null; ok.disabled = true; box.classList.remove('bad');
      box.textContent = fmtCombo(combo);
      if (!usable(combo)) { box.classList.add('bad'); note.textContent = `글자 입력과 겹쳐서 쓸 수 없어요 — ${isMac ? '⌘ · ⌃ · ⌥' : 'Ctrl 또는 Alt'}를 함께 누르거나 F1~F12를 쓰세요`; return; }
      if (BROWSER_KEYS.has(combo)) { box.classList.add('bad'); note.textContent = '브라우저가 먼저 가로채는 조합이라 쓸 수 없어요 (탭 닫기 · 새 창 등)'; return; }
      const other = effectiveKeys()[combo];
      note.textContent = other && other !== cmd.name ? `지금 ${other} 의 단축키예요 — 저장하면 이 명령으로 옮겨요`
        : BUILTIN_KEYS.has(combo) ? '앱 기본 단축키와 겹쳐요 — 저장하면 이 명령이 대신 실행돼요'
        : 'Enter 또는 저장을 누르면 적용돼요';
      pending = combo; ok.disabled = false;
    };
    const onk = (e) => {
      if (e.isComposing) return;
      e.preventDefault(); e.stopPropagation();
      const plain = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
      if (plain && e.key === 'Escape') return done();
      if (plain && e.key === 'Enter') { if (pending) save(pending); return; }
      if (isModKey(e)) return;
      show(comboOf(e));
    };
    dlg.append(h, sub, box, note, foot);
  });
}

// 지정한 단축키 → 명령 실행. 앱 기본 단축키보다 먼저 받아요 (창 · 대화상자가 떠 있을 때는 그쪽 키가 먼저).
addEventListener('keydown', async (e) => {
  if (keyCapture || isModKey(e)) return;
  if ((e.isComposing || e.keyCode === 229) && !(e.altKey || e.ctrlKey || e.metaKey)) return; // 한글 조합 중이어도 ⌥·⌘ 조합은 받아요
  if (paletteOpen() || modalOpen() || document.querySelector('.wfx-prompt')) return;
  const name = effectiveKeys()[comboOf(e)];
  const c = name && paletteCommands.get(name);
  if (!c) return;
  e.preventDefault(); e.stopPropagation();
  runCommandNow(c);
}, true);

/** 전역 검색: 그 항목이 있는 화면으로 가서 커서를 둬요 */
async function openHit(h) {
  await flushAll();
  state.focusId = h.id;
  state.focusPos = 'end';
  state.flash = h.id;
  setZoom(h.parent_id, h.id);
}

/** 현재 항목 안 검색: 화면은 그대로 두고, 이 화면에서 그 항목까지 가는 조상들을 펼쳐서 보여줘요 */
async function openInPlace(h) {
  await flushAll();
  const zi = state.zoom === null ? -1 : h.path.findIndex((p) => p.id === state.zoom);
  if (state.zoom !== null && zi < 0) return openHit(h); // 이 화면 아래가 아니면 이동으로
  const chain = h.path.slice(zi + 1).map((p) => p.id);
  if (chain.length) await http('/api/bulk', 'POST', { ops: chain.map((id) => ({ id, collapsed: 0 })) });
  const parents = [state.zoom, ...chain], seq = [...chain, h.id];
  for (let k = 0; k < parents.length; k++) {
    const pid = parents[k], cid = seq[k];
    let c = state.ch.get(pid);
    if (!c) { ingest(await http(`/api/view?parent=${ck(pid)}`)); c = state.ch.get(pid); }
    if (!c) break;
    if (!c.ids.includes(cid)) { // 형제가 아주 많으면 그 항목이 들어올 만큼만 더 불러와요
      const { index } = await http(`/api/sibling_index?id=${cid}`);
      const need = index + 30;
      if (c.ids.length < need) {
        const r = await http(`/api/children?parent=${ck(pid)}&offset=${c.ids.length}&limit=${need - c.ids.length}`);
        r.nodes.forEach(upsert);
        c.ids.push(...r.nodes.map((n) => n.id));
        c.total = r.total;
      }
    }
    c.show = Math.max(c.show, c.ids.indexOf(cid) + 1);
    const cn = state.nodes.get(cid);
    if (cn && k < chain.length) cn.collapsed = 0;
  }
  state.focusId = h.id;
  state.focusPos = 'end';
  state.flash = h.id;
  render();
  settleFlash();
}

export { inSelBar, setSelBar, inTextBar, setTextBar, inTagMenu, setTagMenu, paletteCommands, pal, overlayOpen, paletteOpen, restoreFocusAfterPalette, nodeUrl, copyText, copyNodeUrl,
  toggleCmdFav, hlRows, updateHlBar, stepHighlight, setHighlight, HL_KEEP_KEYS, cmdPrefs, loadCmdPrefs, defaultKey, effectiveKeys, runCommandNow, keyOfCommand, KEY_SYM, fmtCombo,
  BUILTIN_KEYS, BROWSER_KEYS, selectedText, isModKey, usable, assignShortcut, openHit, openInPlace };
