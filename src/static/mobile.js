// 모바일(터치) 도구 막대: 키보드 단축키를 그대로 흉내 내서 보내요 → 동작이 키보드와 항상 같아요. app.js가 initMobile()을 불러요
import { caretOffset, setCaret } from './app.js';
import { $, http, mk, toast } from './base.js';
import { isModKey, paletteCommands, paletteOpen } from './commands.js';

/** 모바일 보조 키 배치 (api.mobile) — 터치 화면이 아니면 바꿔도 보이지 않아요 */
const mobileCfg = { get: () => null, keyNames: () => [], set: () => '터치 화면에서만 보조 키가 있어요' };

function initMobile() {
  const mbar = $('#mbar');
  const touch = matchMedia('(pointer: coarse)').matches || location.search.includes('mobile');
  if (touch) {
    document.body.classList.add('touch');
    mbar.hidden = false;
    // ⌘·⇧·⌥ 를 켜면 키보드를 띄워 주는 숨은 '비밀번호' 입력칸 (catcher).
    // 비밀번호 칸에서는 휴대폰 키보드가 단어 추천 · 한글 조합을 끄고 친 글자를 그대로 보내서, 그 글자를 단축키로 바꿀 수 있어요.
    // 단축키를 보낼 때는 원래 커서가 있던 항목(saved)으로 커서를 돌려놓고 거기에 보내요.
    const catcher = document.createElement('input');
    Object.assign(catcher, { type: 'password', id: 'modcatch', autocomplete: 'off', spellcheck: false, tabIndex: -1 });
    catcher.setAttribute('autocorrect', 'off'); catcher.setAttribute('autocapitalize', 'off'); catcher.setAttribute('aria-label', '단축키 입력');
    mbar.append(catcher);
    let saved = null; // { id: 항목 번호 | 'title', pos }
    const savedEl = () => (saved?.id === 'title' ? $('#title') : saved ? document.querySelector(`#tree .text[data-id="${saved.id}"]`) : null);
    const arm = () => { // 키보드를 띄우고 단축키를 받을 준비
      if (document.activeElement === catcher) return;
      const a = document.activeElement;
      saved = a?.id === 'title' ? { id: 'title', pos: caretOffset(a) } : a?.classList?.contains('text') && a.dataset.id ? { id: a.dataset.id, pos: caretOffset(a) } : null;
      catcher.value = '';
      catcher.focus({ preventScroll: true });
    };
    const backToText = () => { // 커서를 원래 항목으로
      if (document.activeElement !== catcher) return;
      const el = savedEl();
      if (el && !el.hidden) setCaret(el, saved.pos, true); else catcher.blur();
    };
    const press = (init) => { // 지금 커서가 있는 곳(없으면 문서)에 키 입력을 보내요 → 앱이 처리했으면 false
      backToText();
      const t = document.activeElement?.closest?.('.text') ?? (document.activeElement?.id === 'title' ? document.activeElement : null) ?? document.activeElement ?? document.body;
      return t.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
    };
    // cmd · ctrl · opt · shift : 누르면 켜지고 다음 키 하나에 붙어요(그 뒤 꺼짐). 두 번 빠르게 누르면 고정, 한 번 더 누르면 해제.
    const mods = { meta: 0, ctrl: 0, alt: 0, shift: 0 }; // 0 꺼짐 · 1 한 번 · 2 고정
    let modBtns = {}; // 그린 키 중 수식키들 (배치를 바꾸면 다시 모아요)
    const lastTap = {};
    const paintMods = () => { for (const [k, b] of Object.entries(modBtns)) { b.classList.toggle('on', mods[k] > 0); b.classList.toggle('lock', mods[k] === 2); b.setAttribute('aria-pressed', String(mods[k] > 0)); } };
    const anyMod = () => mods.meta || mods.ctrl || mods.alt || mods.shift;
    // 이름 그대로의 키: cmd = ⌘(Meta) · ctrl = Control · opt = ⌥(Alt) · shift
    // (앱 단축키는 Apple 기기면 ⌘ · 명령은 ⌃, 그 밖은 Ctrl · 명령은 Alt — 데스크톱 키보드와 같아요)
    const modInit = () => ({ metaKey: !!mods.meta, ctrlKey: !!mods.ctrl, altKey: !!mods.alt, shiftKey: !!mods.shift });
    const useMods = () => { // 한 번짜리는 끄고, 고정된 게 남아 있으면 다시 키보드로 받을 준비
      for (const k in mods) if (mods[k] === 1) mods[k] = 0;
      paintMods();
      if (anyMod()) setTimeout(() => { const a = document.activeElement; if (!paletteOpen() && (a === document.body || a?.classList?.contains('text') || a?.id === 'title')) arm(); }, 0);
    };
    const tapMod = (k) => {
      const now = performance.now(), dbl = now - (lastTap[k] ?? 0) < 500; // 두 번 누르기 = 고정 (0.5초 안에 — 휴대폰에서 너무 빠듯하지 않게)
      lastTap[k] = now;
      mods[k] = dbl && mods[k] === 1 ? 2 : mods[k] ? 0 : 1;
      paintMods();
      if (anyMod()) arm(); else backToText(); // 켜면 키보드가 올라오고, 모두 끄면 원래 항목으로
    };
    const fire = (ch) => { press({ ...keyInit(ch), ...modInit() }); useMods(); };
    // 비밀번호 칸에 들어온 글자 → 단축키 (입력 이벤트를 막을 수 없는 키보드를 위해 input 에서도 한 번 더 받아요)
    catcher.addEventListener('input', () => { const v = catcher.value; catcher.value = ''; if (v && anyMod()) fire([...v].pop()); });
    catcher.addEventListener('blur', () => { catcher.value = ''; });
    // ---- 보조 키 (Termux의 extra-keys처럼) ----
    // 배치는 줄들의 목록: [["ESC", "TAB", {"key": "-", "popup": "|"}, …], […]]. 키 이름 · 글자 하나.
    // popup = 그 키를 위로 밀었을 때. 명령 'mobile-keys'에서 바꾸고 DB에 저장해요 (같은 서버의 모든 기기가 같은 배치).
    const editing = () => { const a = document.activeElement; return a?.isContentEditable ? a : null; };
    // 화살표 · home · end: 먼저 앱에 키를 보내고(이웃 항목으로 넘어가기 · 단축키), 앱이 안 쓰면 브라우저 대신 커서를 직접 옮겨요
    // (가짜 키 입력으로는 브라우저가 커서를 안 옮겨요)
    const navKey = (key, dir, unit) => () => {
      const free = press({ key, code: key, ...modInit() });
      const sel = getSelection();
      if (free && editing() && sel.modify && !mods.meta && !mods.ctrl && !mods.alt) sel.modify(mods.shift ? 'extend' : 'move', dir, unit);
    };
    const KEYS = {
      ESC: { g: 'esc', word: 1, run: () => press({ key: 'Escape', code: 'Escape', ...modInit() }), label: 'Esc' },
      TAB: { g: 'tab', word: 1, run: () => press({ key: 'Tab', code: 'Tab', ...modInit() }), label: 'Tab (들여쓰기)' },
      CMD: { g: 'cmd', word: 1, mod: 'meta', label: 'Cmd(⌘) 누른 채로' },
      CTRL: { g: 'ctrl', word: 1, mod: 'ctrl', label: 'Ctrl(⌃) 누른 채로' },
      OPT: { g: 'opt', word: 1, mod: 'alt', label: 'Option(⌥) · Alt 누른 채로' },
      SHIFT: { g: 'shift', word: 1, mod: 'shift', label: 'Shift(⇧) 누른 채로' },
      UP: { g: '↑', run: navKey('ArrowUp', 'backward', 'line'), label: '위' },
      DOWN: { g: '↓', run: navKey('ArrowDown', 'forward', 'line'), label: '아래' },
      LEFT: { g: '←', run: navKey('ArrowLeft', 'backward', 'character'), label: '왼쪽' },
      RIGHT: { g: '→', run: navKey('ArrowRight', 'forward', 'character'), label: '오른쪽' },
      HOME: { g: 'home', word: 1, run: navKey('Home', 'backward', 'lineboundary'), label: '줄 처음' },
      END: { g: 'end', word: 1, run: navKey('End', 'forward', 'lineboundary'), label: '줄 끝' },
      PGUP: { g: 'pgup', word: 1, run: () => scrollBy({ top: -innerHeight * 0.8, behavior: 'smooth' }), label: '한 화면 위로' },
      PGDN: { g: 'pgdn', word: 1, run: () => scrollBy({ top: innerHeight * 0.8, behavior: 'smooth' }), label: '한 화면 아래로' },
      DEL: { g: '⌦', run: () => { if (press({ key: 'Delete', code: 'Delete', ...modInit() }) && editing()) document.execCommand('forwardDelete'); }, label: '뒤 글자 지우기' },
    };
    KEYS.ALT = KEYS.OPT; // 예전 배치 이름
    // 기본 배치: 수식키와 tab · 화살표만 한 줄로 (esc · home · end · pgup · pgdn · ⌦는 mobile-keys로 넣을 수 있어요)
    const MOBILE_KEYS_DEFAULT = [
      ['TAB', 'SHIFT', 'CTRL', 'OPT', 'CMD', 'LEFT', 'UP', 'DOWN', 'RIGHT'], // Mac 키보드 왼쪽 아래처럼
    ];
    /** 키 이름 → { g 보이는 글자, label, run | mod } (글자 하나는 그 글자 넣기 · 수식키가 켜져 있으면 단축키) */
    const keyDef = (name) => {
      if (typeof name !== 'string' || !name) return null;
      const up = name.toUpperCase();
      if (KEYS[up]) return KEYS[up];
      if ([...name].length === 1) return { g: name, label: `${name} 넣기`, run: () => { if (anyMod()) return fire(name); backToText(); if (editing()) document.execCommand('insertText', false, name); } };
      return null;
    };
    const keysBox = mbar.querySelector('.mbar-keys');
    let layout = MOBILE_KEYS_DEFAULT;
    const renderKeys = () => {
      keysBox.replaceChildren(...layout.map((row) => {
        const r = mk('div', 'mbar-row');
        for (const item of row) {
          const spec = typeof item === 'string' ? { key: item } : item ?? {};
          const d = keyDef(spec.key), pd = spec.popup ? keyDef(spec.popup) : null;
          if (!d) continue;
          const b = mk('button'); b.type = 'button';
          if (d.word) b.classList.add('word');
          b.append(d.g);
          if (pd) { const p = mk('span', 'p'); p.textContent = pd.g; b.append(p); }
          b.setAttribute('aria-label', d.label + (pd ? ` · 위로 밀면 ${pd.label}` : ''));
          if (d.mod) b.dataset.mod = d.mod;
          b.dataset.k = [...spec.key].length === 1 ? spec.key : spec.key.toUpperCase(); // 키 이름 (테스트 · 꾸미기용)
          b._def = d; b._pop = pd;
          r.append(b);
        }
        return r;
      }));
      modBtns = Object.fromEntries([...keysBox.querySelectorAll('[data-mod]')].map((b) => [b.dataset.mod, b]));
      paintMods();
      document.documentElement.style.setProperty('--mbar-h', `${mbar.offsetHeight}px`); // 본문 아래 여백 = 보조 키 높이
    };
    const validLayout = (v) => Array.isArray(v) && v.length && v.every((row) => Array.isArray(row) && row.every((k) => keyDef(typeof k === 'string' ? k : k?.key)));
    http('/api/plugin-data/core/mobile_keys').then((r) => { if (validLayout(r?.value)) { layout = r.value; renderKeys(); } }).catch(() => {});
    renderKeys();
    // 누르기 · 위로 밀기 (Termux처럼 키 위로 손가락을 밀면 작은 글자의 두 번째 기능) · 길게 누르면 반복(↑↓←→ · ⌫)
    const REPEAT = new Set([KEYS.UP, KEYS.DOWN, KEYS.LEFT, KEYS.RIGHT, KEYS.DEL]);
    let gesture = null;
    const runDef = (d) => { if (d.mod) return tapMod(d.mod); d.run(); useMods(); };
    keysBox.addEventListener('pointerdown', (e) => {
      const b = e.target.closest('button');
      if (!b?._def) return;
      e.preventDefault();
      try { b.setPointerCapture(e.pointerId); } catch { /* 이미 끝난 터치 */ }
      b.classList.add('down');
      gesture = { b, y: e.clientY, up: false, timer: 0, repeated: false };
      if (REPEAT.has(b._def)) gesture.timer = setTimeout(function rep() { if (!gesture || gesture.up) return; gesture.repeated = true; b._def.run(); gesture.timer = setTimeout(rep, 70); }, 450);
    });
    keysBox.addEventListener('pointermove', (e) => {
      if (!gesture || !gesture.b._pop) return;
      const up = gesture.y - e.clientY > 18;
      if (up !== gesture.up) { gesture.up = up; gesture.b.classList.toggle('up', up); }
    });
    const endGesture = (e, cancel) => {
      if (!gesture) return;
      const { b, up, timer, repeated } = gesture;
      clearTimeout(timer); gesture = null;
      b.classList.remove('down', 'up');
      if (cancel || repeated) { if (repeated) useMods(); return; }
      runDef(up && b._pop ? b._pop : b._def);
    };
    keysBox.addEventListener('pointerup', (e) => endGesture(e, false));
    keysBox.addEventListener('pointercancel', (e) => endGesture(e, true));
    // 키를 눌러도 글자 입력 칸의 포커스(=소프트 키보드)가 사라지지 않게
    for (const ev of ['pointerdown', 'mousedown']) mbar.addEventListener(ev, (e) => e.preventDefault());
    // 배치 바꾸기: 플러그인(toolbar)이 api.mobile로 — 여기서는 읽고 바꾸는 길만 열어요
    Object.assign(mobileCfg, {
      get: () => layout,
      keyNames: () => Object.keys(KEYS).filter((k) => k !== 'ALT'),
      set(next) { // null = 기본값 · 맞지 않으면 오류 글
        if (next !== null && !validLayout(next)) return '모르는 키 이름이 있거나 줄이 비었어요';
        layout = next ?? MOBILE_KEYS_DEFAULT; renderKeys();
        http('/api/plugin-data/core/mobile_keys', 'PUT', { value: next }).catch(() => {});
        return null;
      },
    });
    // ⌘·⇧·⌥ 가 켜져 있을 때 키보드로 친 글자/키를 그 조합으로 바꿔 보내요 (데스크톱 단축키를 그대로 쓰도록)
    const PUNCT = { '.': 'Period', ',': 'Comma', '>': 'Period', '<': 'Comma', '/': 'Slash', ';': 'Semicolon', "'": 'Quote', '[': 'BracketLeft', ']': 'BracketRight', '-': 'Minus', '=': 'Equal' };
    const keyInit = (ch) => (/^[a-z]$/i.test(ch) ? { key: ch.toLowerCase(), code: 'Key' + ch.toUpperCase() } : /^[0-9]$/.test(ch) ? { key: ch, code: 'Digit' + ch } : { key: ch, code: PUNCT[ch] ?? '' });
    addEventListener('beforeinput', (e) => { // 소프트 키보드는 글자를 keydown 대신 입력 이벤트로만 알려주는 경우가 많아요
      if (!anyMod() || !e.data || [...e.data].length !== 1 || !e.cancelable) return;
      e.preventDefault();
      press({ ...keyInit(e.data), ...modInit() }); useMods();
    }, true);
    addEventListener('keydown', (e) => { // 실제 키 입력(외장 키보드 · 엔터 · 백스페이스 등)
      if (!e.isTrusted || !anyMod() || e.ctrlKey || e.metaKey || e.altKey || isModKey(e) || e.key === 'Unidentified' || e.key === 'Process' || e.keyCode === 229) return;
      e.preventDefault(); e.stopImmediatePropagation();
      press({ ...(e.key.length === 1 ? keyInit(e.key) : { key: e.key, code: e.code }), ...modInit(), shiftKey: !!mods.shift || e.shiftKey }); useMods();
    }, true);
    // 소프트 키보드가 올라와도 막대가 키보드 바로 위에 붙게 (브라우저가 화면을 줄여 주지 않을 때의 보정)
    const vv = window.visualViewport;
    if (vv) {
      const fit = () => { mbar.style.bottom = Math.max(0, innerHeight - vv.height - vv.offsetTop) + 'px'; };
      vv.addEventListener('resize', fit); vv.addEventListener('scroll', fit); fit();
    }
  }
}

export { initMobile, mobileCfg };
