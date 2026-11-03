// 할 일 (todo) — 커서 항목 맨 앞에 [ ] 넣기 → 한 번 더 누르면 [x] → 한 번 더 누르면 떼기
import { command } from './_kit.js';

const BOX = /^(\s*)\[( |x|X)\](?=\s|$)/;

export default (api) => command(api, {
  name: 'todo', label: '할 일 체크박스 (커서 항목 맨 앞에 [ ] → [x] → 떼기)', preload: false,
  make: () => ({
    async todo() {
      const id = api.view.cursorId(), n = id != null && api.nodes.get(id);
      if (!n) return api.ui.toast('할 일로 만들 항목에 커서를 두세요');
      await api.view.flush();
      const m = BOX.exec(n.content);
      const next = !m ? `[ ] ${n.content}` : m[2] === ' ' ? n.content.replace(BOX, '$1[x]') : n.content.slice(m[0].length).replace(/^\s/, '');
      await api.nodes.update(id, { content: next });
      api.view.focus(id, 'end');
    },
  }),
});
