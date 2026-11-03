// 가져오기 (import) — 파일 고르는 창: 종류를 보고 알아서 (이미지 · 영상 · 오디오 · PDF · 첨부 ZIP은 첨부로, JSON · HTML · Markdown · 텍스트는 항목으로, 백업 .zip · .db는 아래에 추가 · 대체하기)
// 끌어다 놓기 · 붙여넣기도 같은 길로 가요 (앱의 attach.js)
import { command } from './_kit.js';

export default (api) => command(api, {
  name: 'import', preload: false,
  label: '가져오기 (파일 넣기 — 이미지 · 영상 · 오디오 · PDF는 첨부로, JSON · HTML · Markdown · 텍스트는 항목으로, 백업 .zip · .db는 아래에 추가 · 대체하기, 끌어놓기 · 붙여넣기도 돼요)',
  make: (api) => ({ import: () => api.files.pick(api.view.cursorId()) }),
});
