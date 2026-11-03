// 제목 3단계 (h3) — 줄 앞에 '### '을 붙이거나 바꾸고, 이미 3단계면 떼요. 커서 · 고른 글자는 그대로. 글자 메뉴에도 떠요
import { command } from './_kit.js';

export default (api) => command(api, {
  name: 'h3', label: '제목 3단계 (다시 누르면 떼기)', preload: false,
  text: { label: 'H3', title: '제목 3단계', group: 'heading', order: 22, style: 'font-size:12px;letter-spacing:-.02em', active: (ctx) => ctx.level() === 3 },
  make: (api) => ({ h3: () => api.text.heading(3) || api.ui.toast('글자 칸에 커서를 두세요') }),
});
