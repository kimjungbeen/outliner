// 하위 검색 (find) — 지금 화면 아래에서만 찾아, 고르면 이동 없이 그 항목까지 펼쳐 보여요 (⌘+클릭: 그 항목 안으로). 본체는 _search.js
// 글 속 태그를 누르면 그 태그로 바로 찾아요 (tag 트리거 — ⌘/의 '태그'로 끄고 켜요)
import makeSearch from './_search.js';

export default (api) => makeSearch(api, { mode: 'sub', name: 'find', hist: 'find', tag: true, label: '하위 검색 (지금 화면 아래에서 찾아 그 자리에 펼쳐 보이기 — 태그를 누르면 그 태그로)' });
