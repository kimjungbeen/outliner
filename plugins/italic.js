// 기울임 (italic) — 고른 글자를 * 로 감싸요 · 이미 감싸져 있으면 풀어요 · 안 고르면 기호 한 쌍 사이에 커서. 글자 메뉴에도 떠요
import { command } from './_kit.js';

export default (api) => command(api, {
  name: 'italic', label: '기울임 (*글자* — 고른 글자, 다시 누르면 풀기)', keys: 'Alt+I', preload: false,
  text: { label: 'I', title: '기울임', group: 'md', order: 11, style: 'font-style:italic;font-family:Georgia,var(--font)', active: (ctx) => ctx.wrapped('*') },
  make: (api) => ({ italic: () => api.text.wrap('*') || api.ui.toast('글자를 고르거나 커서를 두세요') }),
});
