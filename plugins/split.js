// 항목 나누기 (split, join의 반대) — 줄 · 문단 · 문장 · 정규식으로 잘라 여러 항목으로. 본체는 _shape.js
import make from './_shape.js';
import { command } from './_kit.js';

export default (api) => command(api, { name: 'split', label: '항목 나누기 (고른 항목 · 커서 항목의 글을 줄 · 문단 · 문장 · 정규식으로 잘라 여러 항목으로)', preload: false, make });
