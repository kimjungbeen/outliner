// 항목 합치기 (join) — 선택한 항목들을 한 문단으로 (띄어쓰기 · 줄바꿈 · 빈 줄 · 직접). 본체는 _shape.js
import make from './_shape.js';
import { command } from './_kit.js';

export default (api) => command(api, { name: 'join', label: '항목 합치기 (선택한 항목들을 한 문단으로 — 띄어쓰기 · 줄바꿈 · 빈 줄 · 직접)', keys: 'Alt+J', selection: '합치기', selectionMin: 2, make }); // 둘 이상 고르면 선택 막대에 '합치기' // 고른 항목의 하위를 옮기니까 불러와요
