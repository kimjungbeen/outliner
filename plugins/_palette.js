// 찾기 창 부품 — jump · find · pdfsearch가 같은 모양을 써요: 입력 칸(⌘/ 칸과 같은 크기) + '정규식' · 안내 줄 · 결과 목록 · 결과 줄
// ui.sheet({ size: 'palette', body: (s, set) => searchPalette(ui, { … }) })처럼 써요. 키(↑↓ · Enter · Esc)는 명령마다 onKey로

/** 마우스가 정말 움직였을 때만 true — 목록이 스크롤되거나 다시 그려지면 마우스가 가만있어도 mousemove가 와서, ↑↓로 고른 줄을 마우스 아래 줄이 빼앗았어요 */
export const pointerMoved = (ev) => ev.movementX !== 0 || ev.movementY !== 0;

/** 창 전체: { q, onType(글), placeholder, label, regex, onRegex(켜짐), info, items, row(항목, i), listKey, onScroll(목록), field(입력 칸 뷰 → 뷰) } */
export function searchPalette(ui, { q, onType, placeholder, label = placeholder, regex = false, onRegex = null, info = '', items = [], row, listKey = 'list', onScroll = null, field = (f) => f }) {
  const { VStack, HStack, Text, TextField, Toggle, Divider } = ui;
  const list = items.length > 0 && VStack({ gap: 1 }, items.map((h, i) => row(h, i))).scroll().fill().padding(4).attr('data-f', 'list').key(listKey);
  return VStack({ gap: 0 },
    HStack({ gap: 10 },
      field(TextField(q, onType, { placeholder }).font('large').autoselect().grow().label(label).attr('autocomplete', 'off').attr('data-f', 'search')),
      onRegex && Toggle('정규식', regex, onRegex).attr('data-f', 'regex'), // replace · delete · tree의 '정규식'과 같은 켜고 끄기
    ).padding({ x: 8 }),
    Text(info).font('caption').padding({ x: 14, y: 4 }).attr('role', 'status').attr('data-f', 'info'),
    items.length > 0 && Divider(),
    list && (onScroll ? list.event('scroll', (e) => onScroll(e.currentTarget)) : list),
  ).fill();
}

/** 결과 줄 하나: { active(고른 줄인지), onTap(e), onPoint(마우스가 올라오면), kind, key } + 줄 안의 뷰들 */
export function hitRow(ui, { active, onTap, onPoint, kind = 'hit', key }, ...kids) {
  return ui.HStack({ gap: 10 }, ...kids).cls('v-row').selected(active).scrollIntoView(active)
    .onTap(onTap)
    .event('mousemove', (e) => { if (!active && pointerMoved(e)) onPoint(); })
    .attr('data-f', 'hit').attr('data-kind', kind).attr('data-active', active).key(key);
}

/** 결과 줄의 글: 위에 어디인지(작게) · 아래에 찾은 글(강조 조각) */
export const hitText = (ui, where, segs) => ui.VStack({ gap: 1 },
  ui.Text(where).font('caption').lines(1).attr('data-f', 'hit-path'),
  ui.Marked(segs).wrap().attr('data-f', 'hit-text'),
).grow();
