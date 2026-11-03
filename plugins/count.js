// 세기 (count) — 고른 항목(없으면 지금 화면 아래 전부)의 항목 수 · 글자 수 · 단어 수 · 줄 수
// 글자 수는 빈칸을 넣은 것과 뺀 것 둘 다. 마크다운 기호도 글자로 세요 (보이는 글자만 세려면 먼저 plain으로)
import { command } from './_kit.js';

/** 글들 → { items, chars, charsNoSpace, words, lines } */
export function countOf(texts) {
  let chars = 0, charsNoSpace = 0, words = 0, lines = 0;
  for (const s of texts) {
    const t = String(s ?? '');
    chars += [...t].length;
    charsNoSpace += [...t.replace(/\s/gu, '')].length;
    words += (t.match(/\S+/gu) || []).length;
    lines += t ? t.split('\n').length : 0;
  }
  return { items: texts.length, chars, charsNoSpace, words, lines };
}

async function count(api, ui, t) {
  const { nodes, text } = await t.picked();
  const c = countOf(nodes.map((n) => n.content));
  const f = (n) => n.toLocaleString('ko-KR');
  const rows = [['항목', c.items], ['글자 (빈칸 포함)', c.chars], ['글자 (빈칸 빼고)', c.charsNoSpace], ['단어', c.words], ['줄', c.lines]];
  const { VStack, Text, LabeledValue, Actions, Button } = ui;
  await ui.sheet({
    title: '세기',
    body: (_, __, close) => VStack({ gap: 10 },
      Text(text).font('caption'),
      VStack({ gap: 6 }, rows.map(([l, v]) => LabeledValue(l, f(v)))).attr('data-f', 'stats'),
      Actions(Button('닫기', () => close()).style('primary')),
    ),
  });
}

export default (api) => command(api, { name: 'count', label: '세기 (항목 · 글자 · 단어 · 줄 수 — 고른 항목, 없으면 지금 화면)', preload: false, make: (api, ui, t) => ({ count: () => count(api, ui, t) }) });
