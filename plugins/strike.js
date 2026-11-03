// 취소선 (strike) — 고른 글자를 ~~ 로 감싸요 · 이미 감싸져 있으면 풀어요 · 안 고르면 기호 한 쌍 사이에 커서. 글자 메뉴에도 떠요
import { command } from './_kit.js';

export default (api) => command(api, {
  name: 'strike', label: '취소선 (~~글자~~ — 고른 글자, 다시 누르면 풀기)', keys: 'Alt+Z', preload: false,
  text: { label: 'S', title: '취소선', group: 'md', order: 12, style: 'text-decoration:line-through', active: (ctx) => ctx.wrapped('~~') },
  make: (api) => ({ strike: () => api.text.wrap('~~') || api.ui.toast('글자를 고르거나 커서를 두세요') }),
});
