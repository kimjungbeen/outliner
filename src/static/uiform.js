// 플러그인 창을 데이터로 (api.ui.form · api.ui.rich) — 플러그인은 HTML · CSS 없이 칸 · 미리 보기 줄 · 단추만 적어요.
// 모양은 모두 style.css의 wfx-* 그대로라 모든 플러그인 창이 같은 디자인이에요.

/** 꾸민 글 → HTML: 글자는 그대로(이스케이프), **굵게** · `코드` · 줄바꿈만 */
export function rich(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\n/g, '<br>');
}

const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const val = (x, v) => (typeof x === 'function' ? x(v) : x);

/** 미리 보기 한 줄: '글' | { text, depth, changed, muted, after, err, num, mark } — 빈 글은 '(빈 항목)'
 *  text는 조각 배열도 돼요: ['앞', { hit: '찾은 글' }, '뒤'] — hit은 형광펜처럼 칠해요 */
export function previewRow(r) {
  const o = typeof r === 'string' ? { text: r } : r;
  const d = mk('div', o.err ? 'wfx-err' : o.after ? 'wfx-after' : o.muted ? 'wfx-more' : o.changed ? 'wfx-changed' : '');
  if (o.depth) d.style.paddingLeft = `${o.depth * 1.2}em`;
  if (o.num != null) d.append(mk('span', 'wfx-num', String(o.num)));
  if (o.mark) d.append(mk('span', 'wfx-more', o.mark), ' ');
  if (Array.isArray(o.text)) { d.append(...o.text.map((x) => (typeof x === 'object' && x ? mk('mark', '', x.hit) : String(x ?? '')))); return d; }
  const t = String(o.text ?? '');
  d.append(t || o.err || o.muted ? t : mk('span', 'wfx-more', '(빈 항목)'));
  return d;
}

/** 칸 · 미리 보기가 있는 창 → 고른 값들(values) · 탭을 바꾸면 { tab } · 취소하면 null
 *  form({
 *    title, values: { 키: 처음 값 },
 *    fields: [ // show(v): 보일지 · label: 글 또는 (v) => 글 · inline: 앞 칸과 한 줄에
 *      { key, type: 'seg', options: [[값, 이름, { disabled, title }?]] },   // 하나 고르기
 *      { key, type: 'text' | 'area' | 'number', mono, placeholder, min, max, step, suffix: (v) => 글 },
 *      { key, type: 'check', label },                                         // 켜고 끄기
 *      { type: 'presets', items: [[이름, 값 또는 { 키: 값, $focus: '키', $select: '고를 글' }]], key }, // 누르면 그 값으로
 *      { type: 'help', label, text },                                         // 접은 도움말 (rich 글)
 *      { type: 'info', text },                                                // 옅은 설명 한 줄
 *    ],
 *    preview: (v) => ({ rows: [미리 보기 줄], text: '그대로 보일 긴 글', note: '개수 등', ok: 실행할 수 있나, submit: '단추 이름' }), // 던지면 빨간 오류 줄
 *    previewLabel: '미리 보기', submit: '바꾸기',
 *    change: (key, v, prev) => ({ 바꿀 값 }),                                // 값이 바뀔 때 다른 값도
 *    history: { key, show: (h) => 글, pick: (h) => ({ 값 }), save: (v) => 기록할 값 },  // 입력 기록 (★ · ✕), 실행하면 쌓여요
 *    buttons: [{ label, show: (v) => 보일지 }],                               // 미리 보기를 다시 (예: 다시 섞기)
 *    tabs: { items: [[값, 이름]], value }, still, focus: '키' | 'submit', danger: 실행 단추를 빨갛게, enter: false면 Enter로 실행 안 함
 *  }) */
export function makeForm({ dialog, historyPanel, remember }) {
  return function form(spec) {
    const v = { ...(spec.values || {}) };
    const fields = spec.fields || [];
    const split = !!spec.preview;
    const left = mk('div', split ? 'wfx-col' : '');
    const inputs = new Map(), parts = []; // parts: { f, box, lab, update }
    let close = null, ok = !split, pvState = {};

    const set = (key, value) => {
      const prev = v[key]; v[key] = value;
      if (spec.change) Object.assign(v, spec.change(key, v, prev) || {});
      refresh(key);
    };
    let row = null;
    for (const f of fields) {
      const box = mk('div', 'wfx-field'); if (f.key) box.dataset.field = f.key;
      let lab = null, update = () => {};
      if (f.label && f.type !== 'check' && f.type !== 'help') { lab = mk('label'); box.append(lab); }
      if (f.type === 'seg') {
        const seg = mk('div', 'wfx-seg'); seg.dataset.f = f.key;
        for (const [x, l, o = {}] of f.options) {
          const b = mk('button', '', l); b.type = 'button'; b.dataset.v = x;
          if (o.disabled) b.disabled = true; if (o.title) b.title = o.title;
          b.onclick = () => { if (!b.disabled && v[f.key] !== x) set(f.key, x); };
          seg.append(b);
        }
        box.append(seg);
        update = () => { for (const b of seg.children) b.classList.toggle('on', b.dataset.v === String(v[f.key])); };
      } else if (f.type === 'text' || f.type === 'number' || f.type === 'area') {
        const i = mk(f.type === 'area' ? 'textarea' : 'input', f.type === 'area' ? 'wfx-small' : `wfx-input${f.mono ? ' wfx-mono' : ''}${f.type === 'number' ? ' wfx-num-in' : ''}`);
        if (f.type === 'number') { i.type = 'number'; for (const k of ['min', 'max', 'step']) if (f[k] != null) i[k] = f[k]; }
        i.dataset.f = f.key; i.spellcheck = false; if (f.placeholder) i.placeholder = f.placeholder;
        i.addEventListener('input', () => set(f.key, f.type === 'number' ? (i.value === '' ? null : +i.value) : i.value));
        if (f.type !== 'area') i.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229 && ok && spec.enter !== false) { e.preventDefault(); submit(); } });
        inputs.set(f.key, i);
        const suf = f.suffix ? mk('span', 'wfx-help-inline') : null;
        if (suf) { const r = mk('div', 'wfx-row'); r.append(i, suf); box.append(r); } else box.append(i);
        update = () => {
          const want = v[f.key] == null ? '' : String(v[f.key]);
          if (i.value !== want && !(f.type === 'number' && +i.value === +want && i.value !== '')) i.value = want;
          if (suf) suf.textContent = val(f.suffix, v) ?? '';
          i.classList.toggle('bad', !!val(f.bad, v));
        };
      } else if (f.type === 'check') {
        const l = mk('label', 'wfx-flag'), c = mk('input'); c.type = 'checkbox'; c.dataset.f = f.key;
        c.onchange = () => set(f.key, c.checked);
        l.onmousedown = (e) => e.preventDefault(); // view.js Toggle과 같게 — 눌러도 입력 칸의 커서를 뺏지 않아요
        l.onclick = (e) => { if (e.target !== c) { e.preventDefault(); c.click(); } };
        const t = mk('span'); l.append(c, t); box.append(l); lab = t;
        update = () => { c.checked = !!v[f.key]; };
      } else if (f.type === 'presets') {
        const p = mk('div', 'wfx-presets'); p.dataset.f = 'presets';
        for (const [l, x] of f.items) {
          const b = mk('button', 'wfx-pill', l); b.type = 'button';
          if (typeof x !== 'object') b.title = String(x);
          b.onclick = () => {
            const { $focus, $select, ...patch } = typeof x === 'object' && x ? x : { [f.key]: x };
            Object.assign(v, patch); refresh(null);
            const i = inputs.get($focus ?? f.key); if (!i) return;
            i.focus(); const at = $select ? i.value.indexOf($select) : -1;
            if (at >= 0) i.setSelectionRange(at, at + $select.length); // 바로 고쳐 쓸 자리를 골라 둬요
          };
          p.append(b);
        }
        box.append(p);
      } else if (f.type === 'help') {
        const d = mk('details', 'wfx-tips'), s = mk('summary'), h = mk('div', 'wfx-help');
        d.append(s, h); box.append(d);
        update = () => { s.textContent = val(f.label, v) || '도움말'; h.innerHTML = rich(val(f.text, v)); };
      } else if (f.type === 'info') {
        const d = mk('div', 'wfx-help-inline'); box.append(d);
        update = () => { d.innerHTML = rich(val(f.text, v)); };
      }
      if (f.inline && row) { box.classList.add('inline'); row.append(box); }
      else { row = mk('div', 'wfx-line'); row.append(box); left.append(row); }
      parts.push({ f, box, lab, update });
    }
    if (spec.history) left.append(historyPanel(spec.history.key, { show: spec.history.show, onPick: (h) => { Object.assign(v, spec.history.pick ? spec.history.pick(h) : h); refresh(null); } }));

    // 미리 보기 (오른쪽)
    const pvBox = mk('div', 'wfx-col'), pvLab = mk('label', '', spec.previewLabel || '미리 보기'), note = mk('span', 'wfx-help-inline'), pv = mk('div', 'wfx-preview');
    note.dataset.f = 'note'; pv.dataset.f = 'pv';
    pvLab.append(' ', note); pvBox.append(pvLab, pv);
    const go = mk('button', spec.danger ? 'wfx-btn danger' : 'wfx-btn', spec.submit || '확인'); go.type = 'button'; go.dataset.f = 'go';
    const extra = (spec.buttons || []).map((b) => { const e = mk('button', 'wfx-btn ghost', b.label); e.type = 'button'; e.onclick = () => refresh(null); return { b, e }; });

    function refresh(changed) {
      const was = new Set(parts.filter((p) => !p.box.hidden).map((p) => p.f.key));
      for (const p of parts) {
        const shown = !p.f.show || p.f.show(v);
        p.box.hidden = !shown;
        if (p.lab) p.lab.textContent = val(p.f.label, v) ?? '';
        p.update();
      }
      for (const r of left.querySelectorAll('.wfx-line')) r.hidden = [...r.children].every((c) => c.hidden);
      for (const { b, e } of extra) e.hidden = b.show ? !b.show(v) : false;
      if (split) {
        try { pvState = spec.preview(v) || {}; } catch (e) { pvState = { rows: [{ err: true, text: e.message }], ok: false }; }
        note.textContent = pvState.note ?? '';
        pv.style.whiteSpace = pvState.text != null ? 'pre-wrap' : '';
        if (pvState.text != null) pv.textContent = pvState.text; else pv.replaceChildren(...(pvState.rows || []).map(previewRow));
        ok = pvState.ok !== false;
        go.disabled = !ok;
        go.textContent = pvState.submit || spec.submit || '확인';
      }
      // 고르기로 새로 보인 입력칸이 있으면 거기로 (예: '직접'을 고르면 그 칸)
      if (changed && fields.find((f) => f.key === changed)?.type === 'seg') {
        const i = parts.find((p) => !p.box.hidden && inputs.has(p.f.key) && !was.has(p.f.key))?.f.key;
        if (i) queueMicrotask(() => inputs.get(i)?.focus());
      }
    }
    function submit() {
      if (!ok) return;
      if (spec.history) remember(spec.history.key, spec.history.save ? spec.history.save(v) : v);
      close({ ...v });
    }

    const w = mk('div');
    if (spec.tabs) {
      const bar = mk('div', 'wfx-seg wfx-tabs');
      for (const [x, l] of spec.tabs.items) {
        const b = mk('button', x === spec.tabs.value ? 'on' : '', l); b.type = 'button'; b.dataset.v = x;
        b.onclick = () => { if (x !== spec.tabs.value) close({ tab: x }, { instant: true }); };
        bar.append(b);
      }
      w.append(bar);
    }
    if (split) { const s = mk('div', 'wfx-split'); s.append(left, pvBox); w.append(s); } else w.append(left);
    const acts = mk('div', 'wfx-actions'), cancel = mk('button', 'wfx-btn ghost', '취소'); cancel.type = 'button'; cancel.dataset.f = 'cancel';
    acts.append(...extra.map((x) => x.e), cancel, go); w.append(acts);
    refresh(null);

    return dialog({
      title: spec.title, still: !!spec.still, cls: split ? 'split' : '',
      body: (c) => {
        close = c; cancel.onclick = () => c(null); go.onclick = submit;
        return w;
      },
      focus: () => {
        const f = spec.focus === 'submit' ? go : inputs.get(spec.focus) || [...inputs.values()].find((i) => !i.closest('[hidden]')) || go;
        if (f.select && f.value) queueMicrotask(() => f.select()); // 미리 넣은 글 · 숫자는 바로 바꿔 쓰게 골라 둬요
        return f;
      },
    }).then((r) => (r && typeof r === 'object' ? r : null));
  };
}
