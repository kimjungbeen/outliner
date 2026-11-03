// 굵게 (bold) — 고른 글자를 ** 로 감싸요 · 이미 감싸져 있으면 풀어요 · 안 고르면 기호 한 쌍 사이에 커서. 글자 메뉴에도 떠요
import { command } from './_kit.js';

export default (api) => command(api, {
  name: 'bold', label: '굵게 (**글자** — 고른 글자, 다시 누르면 풀기)', preload: false,
  text: { label: 'B', title: '굵게', group: 'md', order: 10, style: '', active: (ctx) => ctx.wrapped('**') },
  make: (api) => ({ bold: () => api.text.wrap('**') || api.ui.toast('글자를 고르거나 커서를 두세요') }),
});
