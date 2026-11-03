// 제목 1단계 (h1) — 줄 앞에 '# '을 붙이거나 바꾸고, 이미 1단계면 떼요. 커서 · 고른 글자는 그대로. 글자 메뉴에도 떠요
import { command } from './_kit.js';

export default (api) => command(api, {
  name: 'h1', label: '제목 1단계 (다시 누르면 떼기)', preload: false,
  text: { label: 'H1', title: '제목 1단계', group: 'heading', order: 20, style: 'font-size:12px;letter-spacing:-.02em', active: (ctx) => ctx.level() === 1 },
  make: (api) => ({ h1: () => api.text.heading(1) || api.ui.toast('글자 칸에 커서를 두세요') }),
});
