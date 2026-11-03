// 명령 목록 (⌘/ · Ctrl+/) — 앱이 기본으로 주는 단 하나의 명령 창. 명령은 모두 plugins/ 폴더의 파일이에요.
// 줄을 누르면(또는 ↑↓ · Enter) 실행 · ⇧Enter는 ★ · ⌘Enter는 단축키 바꾸기. 줄마다 내가 정해요:
//   ★ 고정(맨 위 · 모바일 막대) · 막대(항목을 고를 때 뜨는 선택 막대에 띄우기) · 글자(글자를 고를 때 뜨는 글자 메뉴에 띄우기) · 태그(글 속 태그를 누르면 부르기) · 단축키(누르면 그 자리에서 바꾸기)
// 맨 아래 '편집 · 이동'은 앱 자체의 키(CORE_KEYS)예요 — 찾기 칸으로 둘 다 걸러요.
import { captureFocus, isMac } from './app.js';
import { mk } from './base.js';
import { modal } from './dialog.js';
import { assignShortcut, cmdPrefs, fmtCombo, inSelBar, inTagMenu, inTextBar, keyOfCommand, paletteCommands, restoreFocusAfterPalette, runCommandNow, selectedText, setSelBar, setTagMenu, setTextBar, toggleCmdFav } from './commands.js';

// 앱 자체의 편집 · 이동 키 (명령이 아니라 바꿀 수 없어요): [하는 일, Windows · Linux, Mac]
export const CORE_KEYS = [
  ['명령 목록 (이 창)', 'Ctrl+/', '⌘/'],
  ['줌인 / 줌아웃', 'Ctrl+. · Ctrl+,', '⌘. · ⌘,'],
  ['다음 / 이전 형제 항목 안으로', 'Ctrl+Shift+. · ,', '⌘⇧. · ⌘⇧,'],
  ['한 단계씩 펼치기 / 접기', 'Ctrl+↓ · Ctrl+↑', '⌘↓ · ⌘↑'],
  ['항목 옮기기 (끝에 닿으면 이웃 항목 안으로)', 'Ctrl+Shift+↑ · ↓', '⌘⇧↑ · ↓'],
  ['맨 앞에서 지우면 위 항목(맨 위면 제목)과 합치기', 'Backspace', '⌫'],
  ['고른 항목 지우기 (한 번 더 물어요)', 'Ctrl+Shift+Backspace', '⌘⇧⌫'],
  ['태그 넣기: # · @를 치면 태그 목록 (↑↓ 고르고 넣기)', 'Enter · Tab', '↵ · ⇥'],
];

/** 명령들 → [{ name, label, keys, fav, bar, text }] (★ 다음 알파벳 순) */
export function commandRows() {
  const favAt = (n) => { const i = cmdPrefs.favs.indexOf(n); return i < 0 ? 1e9 : i; };
  return [...paletteCommands.values()].sort((a, b) => favAt(a.name) - favAt(b.name) || a.name.localeCompare(b.name)).map((c) => {
    const k = keyOfCommand(c.name);
    return { name: c.name, label: c.label || '', keys: k ? fmtCombo(k) : '', fav: cmdPrefs.favs.includes(c.name), bar: inSelBar(c), text: inTextBar(c), tag: inTagMenu(c) };
  });
}

let opened = false;
/** after(): 막대 · 글자 설정을 바꾼 뒤 앱이 다시 그릴 것 (선택 막대 · 글자 메뉴) */
export function openCommandList({ after = () => {} } = {}) {
  if (opened) return;
  opened = true;
  const picked = selectedText(); // 열기 전에 고른 글자 — 창이 뜨면 풀려서 미리 기억해요 (실행하는 명령에게 넘겨요)
  captureFocus(); // 커서가 있던 항목을 기억해요 — 실행하는 명령이 '이 항목'으로 쓰고, 그냥 닫으면 그 자리로 돌려놔요
  let ran = false;
  const core = CORE_KEYS.map(([text, win, mac]) => ({ text, keys: isMac ? mac : win }));
  let rows = commandRows(), at = 0, shown = [];
  return modal({
    title: '명령', cls: 'cmdl-dlg', plugin: true,
    body: (close) => {
      const w = mk('div');
      const find = mk('input', 'wfx-input cmdl-find'); find.type = 'search'; find.spellcheck = false;
      find.placeholder = '찾기 — 명령 이름 · 하는 일 · 키 (↑↓ · Enter 실행)';
      const list = mk('div', 'cmdl-list');
      const hit = (q, ...xs) => !q || xs.some((x) => x.toLowerCase().includes(q));
      const mark = () => shown.forEach((r, k) => r.classList.toggle('on', k === at));
      const toggle = (cls, on, label, title, fn) => {
        const b = mk('button', `cmdl-t ${cls}${on ? ' on' : ''}`); b.type = 'button'; b.textContent = label; b.title = title;
        b.setAttribute('aria-pressed', String(on));
        b.onclick = async (e) => { e.stopPropagation(); await fn(); rows = commandRows(); paint(); find.focus(); };
        return b;
      };
      const paint = () => {
        const q = find.value.trim().toLowerCase();
        // 이름이 똑같은 것 → 이름이 그렇게 시작하는 것 → 이름에 든 것 → 설명 · 키에 든 것 (같으면 ★ · 알파벳 순 그대로) — 이름을 치고 Enter면 그 명령
        const score = (k) => { const n = k.name.toLowerCase(); return !q ? 0 : n === q ? 0 : n.startsWith(q) ? 1 : n.includes(q) ? 2 : hit(q, k.label, k.keys) ? 3 : 9; };
        const m = rows.map((k, i) => [score(k), i, k]).filter(([sc]) => sc < 9).sort((x, y) => x[0] - y[0] || x[1] - y[1]).map(([, , k]) => k), c = core.filter((k) => hit(q, k.text, k.keys));
        list.replaceChildren(); shown = [];
        at = Math.min(at, Math.max(0, m.length - 1));
        for (const k of m) {
          const r = mk('div', 'cmdl-row'); r.title = `${k.name} 실행`;
          const star = toggle('cmdl-star', k.fav, k.fav ? '★' : '☆', k.fav ? '고정 풀기' : '맨 위에 고정 (모바일 막대에도)', () => toggleCmdFav(k.name));
          const name = mk('span', 'cmdl-name'); name.textContent = k.name;
          const text = mk('span', 'cmdl-text'); text.textContent = k.label;
          const bar = toggle('', k.bar, '막대', k.bar ? '선택 막대에서 빼기' : '항목을 고를 때 선택 막대에 띄우기', async () => { await setSelBar(k.name, !k.bar); after(); });
          const txt = toggle('', k.text, '글자', k.text ? '글자 메뉴에서 빼기' : '글자를 고를 때 글자 메뉴에 띄우기', async () => { await setTextBar(k.name, !k.text); after(); });
          const kb = mk('button', `cmdl-kbd${k.keys ? '' : ' none'}`); kb.type = 'button'; kb.textContent = k.keys || '단축키'; kb.title = '단축키 바꾸기 · 지우기';
          kb.onclick = async (e) => { e.stopPropagation(); await assignShortcut(paletteCommands.get(k.name)); rows = commandRows(); paint(); find.focus(); };
          const tg = toggle('', k.tag, '태그', k.tag ? '태그를 눌러도 부르지 않기' : '글 속 태그를 누르면 이 명령 부르기 (누른 태그가 입력으로)', async () => { await setTagMenu(k.name, !k.tag); after(); });
          r.append(star, name, text, bar, txt, tg, kb);
          r.onclick = () => run(k.name);
          r.onmouseenter = () => { at = shown.indexOf(r); mark(); };
          list.append(r); shown.push(r);
        }
        if (c.length) {
          const h = mk('div', 'cmdl-h'); h.textContent = '편집 · 이동 (앱 자체의 키)'; list.append(h);
          for (const k of c) {
            const r = mk('div', 'cmdl-core'), t = mk('span', 'cmdl-text'), kb = mk('kbd', 'cmdl-kbd');
            t.textContent = k.text; kb.textContent = k.keys; r.append(t, kb); list.append(r);
          }
        }
        if (!m.length && !c.length) { const e = mk('div', 'cmdl-empty'); e.textContent = '맞는 명령이 없어요'; list.append(e); }
        mark();
      };
      const run = (name) => { ran = true; close(null, { instant: true }); setTimeout(() => { const c = paletteCommands.get(name); if (c) (picked ? runCommandNow(c, picked) : runCommandNow(c)); }); };
      find.addEventListener('input', () => { at = 0; paint(); });
      find.addEventListener('keydown', (e) => {
        if (e.isComposing) return;
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); at = Math.max(0, Math.min(shown.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1))); mark(); shown[at]?.scrollIntoView({ block: 'nearest' }); }
        else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); shown[at]?.querySelector('.cmdl-kbd')?.click(); } // ⌘Enter: 단축키 바꾸기
        else if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); shown[at]?.querySelector('.cmdl-star')?.click(); } // ⇧Enter: ★ (실행은 안 해요)
        else if (e.key === 'Enter') { e.preventDefault(); const r = shown[at]; if (r) r.click(); }
        else if (e.key === 'Escape' && find.value) { e.preventDefault(); e.stopPropagation(); find.value = ''; paint(); }
      });
      paint();
      queueMicrotask(() => find.focus());
      w.append(find, list);
      return w;
    },
  }).finally(() => { opened = false; if (!ran) restoreFocusAfterPalette(); });
}
