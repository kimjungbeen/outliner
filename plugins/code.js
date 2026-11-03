// 코드 (code) — 고른 글자를 ` 로 감싸요 · 이미 감싸져 있으면 풀어요 · 안 고르면 기호 한 쌍 사이에 커서. 글자 메뉴에도 떠요
import { command } from './_kit.js';

export default (api) => command(api, {
  name: 'code', label: '코드 (`글자` — 고른 글자, 다시 누르면 풀기)', keys: 'Alt+Q', preload: false,
  text: { label: '</>', title: '코드', group: 'md', order: 13, style: 'font-family:var(--mono);font-size:11px', active: (ctx) => ctx.wrapped('`') },
  make: (api) => ({ code: () => api.text.wrap('`') || api.ui.toast('글자를 고르거나 커서를 두세요') }),
});
