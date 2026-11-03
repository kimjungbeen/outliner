// 대화창 하나로: 앱 창(묻기 · 글 받기 · 지우기 확인 · PDF 내보내기 · 단축키 · 북마크 찾기)과 플러그인 창(ui.dialog)이 모두 이 틀을 써요.
// 맡는 일: 어두운 배경 + 창, 맨 위 창만 키를 받기(Esc = 닫기), 바깥을 누르면 닫기, 닫힐 때 움직임, 처음 포커스.
// 겉모양은 둘: 앱 창(.pdf-dlg · .pdf-btn) · 플러그인 창(.wfx-dialog · .wfx-btn — 플러그인이 직접 만든 단추와 같은 모양). 배경 · 틀 · 움직임은 같아요 (.dlg-ov)
// 플러그인도 '/dialog.js'에서 가져다 써요 (plugins/wfx/ui.js). toast도 여기서 함께 내보내요.
import { mk, toast } from './base.js';

const open = []; // 떠 있는 창들 (맨 뒤가 맨 위)
/** 대화창이 떠 있나요? (앱 단축키 · Esc가 비켜 줄 때) */
const modalOpen = () => open.length > 0;

/** 빈 창 틀 → { ov, dlg, close(v) }. 내용은 dlg에 넣어요.
 *  close(v, { instant }): instant면 사라지는 움직임 없이 바로 닫아요
 *  onKey(e, close): 맨 위 창일 때 먼저 받아요 — true를 돌려주면 처리한 거예요. onClose(v): 닫힐 때 한 번
 *  outside: false면 바깥을 눌러도 닫히지 않아요 (녹음처럼 잃으면 안 되는 일을 하는 창) */
function modalShell({ plugin = false, cls = '', label = '', onKey = null, onClose = null, outside = true, still = false } = {}) {
  const ov = mk('div', 'dlg-ov' + (still ? ' still' : '')); // still: 나타나는 움직임 없이 (같은 자리에서 바로 바꿔 연 창)
  ov.dataset.pluginUi = ''; // 창 안의 키 · 클릭은 앱 단축키 · 선택이 받지 않아요
  const dlg = mk('div', (plugin ? 'wfx-dialog' : 'pdf-dlg') + (cls ? ` ${cls}` : ''));
  dlg.setAttribute('role', 'dialog');
  if (label) dlg.setAttribute('aria-label', label);
  const me = { ov };
  let closed = false;
  const close = (v = null, { instant = false } = {}) => { // instant: 움직임 없이 바로 (같은 자리에 다른 창을 바로 열 때 — tree의 탭)
    if (closed) return;
    closed = true;
    removeEventListener('keydown', key, true);
    open.splice(open.indexOf(me), 1);
    // 사라지는 동안(0.12초)에도 키 · 클릭이 막히지 않게: 포커스를 놓고 '창 안'으로 치지 않아요
    if (ov.contains(document.activeElement)) document.activeElement.blur();
    delete ov.dataset.pluginUi; ov.style.pointerEvents = 'none';
    if (instant) ov.remove();
    else { ov.classList.add('out'); setTimeout(() => ov.remove(), 120); }
    onClose?.(v);
  };
  const key = (e) => {
    if (open.at(-1) !== me) return; // 위에 다른 창(지우기 확인 등)이 떠 있으면 그 창이 받아요
    if (onKey?.(e, close)) return;
    if (e.key === 'Escape' && !e.isComposing) { e.preventDefault(); e.stopPropagation(); close(null); }
  };
  addEventListener('keydown', key, true);
  ov.addEventListener('mousedown', (e) => { if (outside && e.target === ov) close(null); });
  ov.append(dlg);
  document.body.append(ov);
  open.push(me);
  return { ov, dlg, close };
}

/** 제목 · 내용 · 단추가 있는 창 → 누른 단추의 value (value가 없으면 label) · close(v)로 닫은 값 · Esc · 바깥 = null
 *  body: HTML 글 | Node | (close) => Node|글 · bodyCls: 내용 칸 클래스
 *  buttons: [{ label, value?, primary?, danger?, cls?, before?() → false면 닫지 않아요 }] */
function modal({ title, body = '', bodyCls = '', buttons = [], plugin = false, cls = '', onKey = null, focus = null, outside = true, still = false } = {}) {
  return new Promise((resolve) => {
    const { dlg, close } = modalShell({ plugin, cls, label: title, onKey, onClose: resolve, outside, still });
    const h = mk(plugin ? 'h3' : 'h2'); h.textContent = title;
    const c = typeof body === 'function' ? body(close) : body;
    const box = mk(typeof c === 'string' && !plugin ? 'p' : 'div', bodyCls);
    if (typeof c === 'string') box.innerHTML = c; else if (c) box.append(c);
    dlg.append(h, box);
    if (buttons.length) {
      const bar = mk('div', plugin ? 'wfx-actions' : 'pdf-foot');
      for (const b of buttons) {
        const btn = mk('button', (plugin ? 'wfx-btn' : 'pdf-btn') + (b.primary ? ' primary' : '') + (b.danger ? ' danger' : '') + (b.cls ? ` ${b.cls}` : ''));
        btn.type = 'button'; btn.textContent = b.label;
        btn.onclick = async () => { if (b.before && (await b.before()) === false) return; close('value' in b ? b.value : b.label); };
        bar.append(btn);
      }
      dlg.append(bar);
    }
    (focus?.(dlg) ?? (plugin ? dlg.querySelector('input, textarea') || dlg.querySelector('.wfx-btn.primary') || dlg.querySelector('.wfx-btn') : dlg.querySelector('.primary')))?.focus();
  });
}

const escHtml = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/** 고르기: buttons [{ label, value, primary?, danger? }] → value · Esc = null */
const askChoice = (title, html, buttons) => modal({ title, body: html, bodyCls: 'pdf-sub', buttons });

/** 지우기 전에 한 번 더 물어요 (모든 지우기 · 삭제가 이 창을 써요) → 지우면 true. what: 무엇을 (글자 그대로) · note: 덧붙일 말(HTML) */
const confirmDelete = (what, note = '') =>
  askChoice('지우기', `<b>${escHtml(what)}</b> — 지울까요?${note ? `<br>${note}` : ''}`, [{ label: '취소', value: false }, { label: '지우기', value: true, primary: true, danger: true }]).then(Boolean);

/** 글 한 칸을 받는 작은 창 → { action, text } (Esc · 밖 누르기 = null). ⌘Enter = primary 단추, danger 단추는 한 번 더 물어요 */
function askText(title, value, buttons, help = '', { select = false } = {}) {
  const ta = mk('textarea', 'pdf-note'); ta.value = value; ta.rows = 4; ta.spellcheck = false;
  const body = document.createDocumentFragment();
  if (help) body.append(Object.assign(mk('p', 'pdf-sub'), { innerHTML: help })); // 제목 바로 아래 도움말
  body.append(ta);
  return modal({
    title, body,
    buttons: buttons.map((b) => ({ ...b, before: b.danger ? () => confirmDelete(ta.value.trim().slice(0, 40) || title) : null })),
    onKey: (e, close) => {
      if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey)) return false;
      e.preventDefault(); e.stopPropagation(); close(buttons.find((b) => b.primary)?.value ?? null);
      return true;
    },
    focus: () => { if (select) queueMicrotask(() => ta.select()); return ta; }, // 기본 이름처럼 바로 바꿔 쓸 글은 골라 둬요
  }).then((v) => v && { action: v, text: ta.value.trim() });
}

export { modalOpen, modalShell, modal, askChoice, askText, confirmDelete, toast };
