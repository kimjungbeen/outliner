// 형광펜 (highlight) — 글자 메뉴의 색들 + 명령(⌘/에서 단축키 지정: 누를 때마다 노랑 → 초록 → … → 지우기)
// 글자를 고르면: 기본 6색 · 최근에 고른 색 2개 · '색 더 보기'(색 18개 더 · 내가 고른 색 전부 · 색 고르기)
// 칠한 곳을 누르면: 그 형광펜의 색 바꾸기 · 지우기 (marks). 글 속에는 =={헥스}글자== 로 적어요 — 칠하기는 api.text.setHighlight
// 내가 고른 색 기록: 색 고르기로 칠한 색을 모두 남겨요 (최근 것이 앞, 같은 색은 하나). 기록의 색을 ⌥/Alt+클릭(또는 오른쪽 클릭)하면 빼요
import { command } from './_kit.js';

// Gem과 같은 파스텔 6색 · '색 더 보기' 칸의 한 단계 진한 파스텔 9 · 또렷한 색 9
const CYCLE = ['fefac3', 'dff0cb', 'd1eafd', 'ded4ee', 'f3cddc', 'f9dec7'];
const MORE = ['fff08a', 'c6efb3', 'b9e1fb', 'd2c4f1', 'f7bfd6', 'fcd3ad', 'c7eee8', 'e6e6e6', 'efe3c8',
  'ffd60a', '7ed957', '5ac8fa', 'af82f5', 'ff6fa8', 'ff9f45', '35d0ba', 'a3a3a3', 'c7a26b'];
const NAME = { fefac3: '노랑', dff0cb: '초록', d1eafd: '파랑', ded4ee: '보라', f3cddc: '분홍', f9dec7: '주황' };
const HEX = /^[0-9a-f]{6}$/;
export default function (api) {
  const ui = api.ui, { Swatch, IconButton, ColorWell, Grid, Text, VStack } = ui;
  let colors = [], more = false, moreFor = ''; // more: '색 더 보기' 칸이 열려 있나 — 다른 글자 · 형광펜으로 옮기면 다시 접혀요
  const clean = (list) => [...new Set((Array.isArray(list) ? list : []).filter((c) => typeof c === 'string' && HEX.test(c) && !CYCLE.includes(c) && !MORE.includes(c)))];
  // 기록은 이 플러그인 칸(storage 'colors')에 — 다른 창에서 더한 색을 잃지 않게 저장 전에 합쳐요 (예전 앱 칸의 기록은 서버가 처음 켤 때 옮겨 줘요)
  const load = async () => clean(await api.storage.get('colors').catch(() => null));
  const dropped = new Set(); // 이번에 뺀 색 — 다른 창의 기록과 합칠 때 다시 살아나지 않게
  let loaded = null; // 기록은 처음 쓸 때(글자 메뉴를 처음 띄울 때 · 단축키) 읽어요 — 플러그인은 사용자가 부르기 전엔 아무것도 하지 않아요
  const ready = () => (loaded ??= load().then((l) => { colors = clean([...colors, ...l]); }));
  async function save({ use = null, drop = null } = {}) {
    if (drop) dropped.add(drop);
    if (use) { dropped.delete(use); colors = clean([use, ...colors]); }
    colors = clean([...colors, ...(await load())]).filter((c) => !dropped.has(c));
    await api.storage.set('colors', colors).catch(() => {});
  }

  /** 색 c로 칠하기 — 지금 색과 같으면 지우기 */
  function paint(c, cur) {
    if (colors.includes(c)) save({ use: c }); // 기록의 색을 쓰면 맨 앞으로
    api.text.setHighlight(cur === c ? null : c);
  }
  const swatch = (c, label, cur) => Swatch(`#${c}`, () => paint(c, cur), { current: cur === c, label: `${label}${cur === c ? ' (다시 누르면 지우기)' : ''}` });
  function mine(c, ctx) { // 내가 고른 색 — ⌥/Alt+클릭 · 오른쪽 클릭: 기록에서 빼기 (묻고)
    const forget = async () => {
      if (!(await ui.confirmDelete(`기록의 색 #${c}`, '이미 칠한 글자는 그대로예요'))) return;
      await save({ drop: c });
      ctx.redraw();
    };
    return Swatch(`#${c}`, (e) => (e.altKey ? forget() : paint(c, ctx.color)), { current: ctx.color === c, label: `내가 고른 색 #${c} — ⌥/Alt+클릭: 기록에서 빼기` })
      .onContextMenu(forget).attr('data-f', 'mine');
  }
  const MORE_DOT = 'conic-gradient(#ffd60a 0 25%, #7ed957 0 50%, #5ac8fa 0 75%, #ff6fa8 0)'; // '색 더 보기' 점: 네 가지 색
  /** 글자 메뉴에 그릴 것: 기본 6색 + 최근 색 2개 + 더 보기 (+ 칠한 곳이면 지우기) — 더 보기를 누르면 아래에 작은 칸 */
  function render(ctx) {
    if (!loaded) ready().then(() => ctx.redraw());
    if (ctx.key !== moreFor) { moreFor = ctx.key; more = false; }
    const cur = ctx.color;
    const inMore = cur && !CYCLE.includes(cur) && !colors.slice(0, 2).includes(cur); // 지금 색이 칸 안에 있어요
    const items = [
      ...CYCLE.map((c) => swatch(c, `형광펜 ${NAME[c]} #${c}`, cur)),
      ...colors.slice(0, 2).map((c) => mine(c, ctx)),
      Swatch(MORE_DOT, () => { more = !more; ctx.redraw(); }, { current: inMore, label: more ? '색 더 보기 닫기' : '색 더 보기 (색 고르기 · 내가 고른 색 전부)' }).selected(more).attr('aria-expanded', String(more)).attr('data-f', 'more'),
      ...(ctx.mode === 'hl' ? ['|', IconButton('trash', () => api.text.setHighlight(null), '형광펜 지우기').style('danger')] : []),
    ];
    if (!more) return { items };
    const pick = ColorWell(cur && HEX.test(cur) ? '#' + cur : colors[0] ? '#' + colors[0] : '#ffd60a', (v) => { // 고르면 그 색으로 칠하고 '내가 고른 색'에 남겨요
      const hex = v.slice(1).toLowerCase();
      if (!CYCLE.includes(hex) && !MORE.includes(hex)) save({ use: hex });
      paint(hex, cur);
    }).attr('data-f', 'pick');
    return {
      items,
      panel: VStack({ gap: 2 },
        Text('색 더').font('caption'),
        Grid({ columns: 'repeat(9, 28px)', gap: 1 }, MORE.map((c) => swatch(c, `#${c}`, cur))).attr('data-f', 'grid'),
        Text(colors.length ? `내가 고른 색 ${colors.length} · ⌥/Alt+클릭: 빼기` : '내가 고른 색').font('caption'),
        Grid({ columns: 'repeat(9, 28px)', gap: 1 }, colors.map((c) => mine(c, ctx)), pick).attr('data-f', 'grid'),
      ),
    };
  }
  /** 단축키: 안 칠했으면 노랑, 칠했으면 다음 색, 마지막 색 다음은 지우기 (직접 고른 색이면 노랑부터) */
  function cycle() {
    const st = api.text.highlight();
    if (!st) return api.ui.toast('글자를 고르세요');
    const next = CYCLE[(st.color === null ? -1 : CYCLE.indexOf(st.color)) + 1] ?? null;
    api.text.setHighlight(next);
    api.ui.toast(next === null ? '형광펜을 지웠어요' : `형광펜: ${NAME[next]}`, 1.2);
  }
  command(api, {
    name: 'highlight', label: '형광펜 (누를 때마다 다음 색 · 글자 메뉴의 색들 · 칠한 곳을 누르면 바꾸기 · 지우기)', preload: false,
    text: { group: 'highlight', order: 30, marks: true, render },
    make: () => ({ highlight: cycle }),
  });
}
