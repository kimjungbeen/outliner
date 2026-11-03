// 찾아서 바꾸기 (replace, 예전 regex · fr) — 글자 그대로 또는 정규식으로, 앞에 붙이기 · 뒤에 붙이기 · 떼기. 본체는 _find.js
import make from './_find.js';
import { command } from './_kit.js';

export default (api) => command(api, { name: 'replace', label: '찾아서 바꾸기 (글자 그대로 · 정규식, 앞에 붙이기 · 뒤에 붙이기 · 떼기 — 고른 항목, 없으면 지금 화면)', keys: 'Alt+G', preload: false, make }); // 범위는 picked()가 불러와요
