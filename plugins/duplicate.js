// 항목 복제 (duplicate) — 커서 항목을 하위까지 바로 아래에 복제해요
import { command } from './_kit.js';

export default (api) => command(api, {
  name: 'duplicate', label: '항목 복제 (커서 항목, 하위 포함)', preload: false,
  make: (api, ui) => ({ duplicate: () => { const id = api.view.cursorId(); if (id == null) return ui.toast('먼저 항목에 커서를 두세요', 2, true); return api.nodes.duplicate(id); } }),
});
