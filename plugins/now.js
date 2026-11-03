// 지금 넣기 (now, 예전 date · time) — 오늘 날짜(Enter) 또는 날짜와 시각을 골라, 쓰던 자리에 바로 · 아니면 커서 항목 끝에
import { command } from './_kit.js';

const p2 = (n) => String(n).padStart(2, '0');

async function now(api, ui) {
  const caret = api.text.caret(); // 묻는 창이 포커스를 가져가니 쓰던 자리를 기억해요
  const d = new Date(), day = d.toLocaleDateString('sv-SE'), full = `${day} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
  const text = await api.ui.choose('지금 넣기', '쓰던 자리에 넣어요 (글을 쓰던 중이 아니면 커서 항목 끝에)', [
    { label: '취소', value: null }, { label: `날짜 + 시각 · ${full}`, value: full }, { label: `날짜 · ${day}`, value: day, primary: true },
  ]);
  if (!text) return;
  if (caret?.insert(text)) return; // 쓰던 자리에 바로 (되돌리기도 돼요)
  const id = api.view.cursorId(), node = id != null ? api.nodes.get(id) : null;
  if (!node) return ui.toast('먼저 항목에 커서를 두세요', 2, true);
  await api.nodes.update(node.id, { content: `${node.content} ${text}`.trim() });
  api.view.focus(node.id, 'end');
}

export default (api) => command(api, { name: 'now', label: '지금 넣기 (오늘 날짜 · 또는 날짜와 시각 — 쓰던 자리에, 아니면 커서 항목 끝에)', preload: false, make: (api, ui) => ({ now: () => now(api, ui) }) });
