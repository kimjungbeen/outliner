// 찾아서 지우기 (delete, 예전 regex의 지우기 · fd) — 글이 맞는 항목을 하위까지 지워요 (한 번 더 물어요). 본체는 _find.js
import make from './_find.js';
import { command } from './_kit.js';

export default (api) => command(api, { name: 'delete', label: '찾아서 지우기 (글자 그대로 · 정규식 — 맞는 항목을 하위까지, 고른 항목, 없으면 지금 화면)', preload: false, make });
