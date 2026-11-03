// 전역 검색 (jump, 예전 search) — 전체에서 찾아 고르면 그 항목 안으로 들어가요 (⌘+클릭 · ⌘Enter: 그 항목이 있는 화면으로). 본체는 _search.js
// 북마크는 jump만: 결과 줄의 책갈피(또는 ⇧Enter)로 넣고 빼요 — 빈 칸으로 열면 북마크가 먼저, 숫자 키로 바로 들어가요 (이 플러그인의 저장 칸)
import makeSearch from './_search.js';

export default (api) => makeSearch(api, { mode: 'global', name: 'jump', hist: 'search', bookmarks: true, label: '전역 검색 (전체에서 찾아 그 항목 안으로 — 결과의 책갈피로 북마크, 빈 칸이면 북마크 · 검색 기록)' });
