// 달력 (calendar): 월간 · 주간 · 일간(하루) 보기. 날짜(YYYY-MM-DD)가 적힌 항목들을 그 날짜 칸에 보여주고, 항목을 누르면 그 항목 안으로 줌인해요.
// 검색은 서버(전문 검색 인덱스)로 해서 항목이 수십만 개여도 그 달 것만 빠르게 가져와요. 칸을 넘치는 항목은 칸 안에서 스크롤해요.
import { command } from './_kit.js';
const VIEWS = [['month', '월간'], ['week', '주간'], ['day', '일간']]; // 일간 = 하루 ('오늘' 버튼은 오늘 날짜로)
const VIEW_KEY = 'wfx.cal.view';

function make(api, ui, t) {
  const { VStack, HStack, Grid, Text, Button, IconButton, Segmented, Chip, Spacer } = ui;
  const pad = (n) => String(n).padStart(2, '0');
  const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const DOW = ['일', '월', '화', '수', '목', '금', '토'];
  const day0 = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const savedView = () => { try { return localStorage.getItem(VIEW_KEY) || 'month'; } catch { return 'month'; } }; // 마지막에 본 보기로 열어요

  async function loadMonth(y, m, inScope) { // 그 달 날짜가 적힌 항목들 → { 'YYYY-MM-DD': [{id, text}] }
    const q = `${y}-${pad(m + 1)}-`;
    const r = await api.nodes.search(q, { limit: 500, scope: inScope ? api.view.zoomId() : null });
    const map = {}, re = /\b\d{4}-\d{2}-\d{2}\b/g;
    for (const h of r.results || []) {
      const dates = new Set(h.content.match(re) || []);
      const label = h.content.replace(re, '').replace(/\s+/g, ' ').trim() || h.content;
      for (const d of dates) if (d.startsWith(q)) (map[d] ??= []).push({ id: h.id, text: label });
    }
    return { map, more: !!r.more };
  }
  /** 보이는 날짜들: 월간은 그 달(앞뒤 빈칸 포함, 주 단위) · 주간은 일요일부터 7일 · 일간은 하루 */
  function daysOf(s) {
    const y = s.cur.getFullYear(), m = s.cur.getMonth();
    if (s.view === 'month') { const first = new Date(y, m, 1).getDay(), n = new Date(y, m + 1, 0).getDate(); return Array.from({ length: Math.ceil((first + n) / 7) * 7 }, (_, i) => new Date(y, m, i - first + 1)); }
    if (s.view === 'week') { const start = addDays(day0(s.cur), -s.cur.getDay()); return Array.from({ length: 7 }, (_, i) => addDays(start, i)); }
    return [day0(s.cur)];
  }
  function titleOf(s) {
    const y = s.cur.getFullYear(), m = s.cur.getMonth(), days = daysOf(s);
    if (s.view === 'month') return `${y}년 ${m + 1}월`;
    if (s.view === 'week') { const a = days[0], b = days[6]; return `${a.getFullYear()}년 ${a.getMonth() + 1}월 ${a.getDate()}–${b.getMonth() !== a.getMonth() ? `${b.getMonth() + 1}월 ` : ''}${b.getDate()}일`; }
    return `${y}년 ${m + 1}월 ${s.cur.getDate()}일 (${DOW[s.cur.getDay()]})`;
  }
  /** 여러 날짜에 걸친 항목들 (주간은 두 달에 걸칠 수 있어요) — 다 불러오면 set */
  let token = 0;
  async function load(s, set) {
    const my = ++token, days = s.view === 'month' ? [s.cur] : daysOf(s);
    const months = [...new Set(days.map((d) => `${d.getFullYear()}-${d.getMonth()}`))];
    const out = { map: {}, more: false };
    try {
      for (const r of await Promise.all(months.map((k) => { const [y, m] = k.split('-').map(Number); return loadMonth(y, m, s.inScope); }))) { Object.assign(out.map, r.map); out.more ||= r.more; }
    } catch { /* 불러오지 못해도 달력은 보여줘요 */ }
    for (const list of Object.values(out.map)) list.sort((a, b) => a.id - b.id); // 칸 안은 만든 순서대로
    if (my === token) set({ map: out.map, more: out.more });
  }
  const move = (s, set, d) => { set({ cur: s.view === 'month' ? new Date(s.cur.getFullYear(), s.cur.getMonth() + d, 1) : addDays(s.cur, d * (s.view === 'week' ? 7 : 1)) }); load(s, set); }; // ◀ ▶
  const setView = (s, set, v) => { try { localStorage.setItem(VIEW_KEY, v); } catch { /* 저장이 안 돼도 이번에는 그 보기로 */ } set({ view: v }); load(s, set); };
  const open = (close, id) => { close(); api.view.zoomTo(id); };
  async function today(s, set, close) { // 한 번: 오늘이 보이게 · 이미 오늘이면: 오늘 날짜(YYYY-MM-DD) 항목으로 (예전 today)
    const d = day0(new Date());
    if (+s.cur !== +d) { set({ cur: d }); return load(s, set); }
    const q = d.toLocaleDateString('sv-SE'), r = await api.nodes.search(q, { limit: 100 });
    const hit = r.results?.find((h) => h.content.trim() === q) ?? r.results?.find((h) => h.content.trim().startsWith(q)) ?? r.results?.[0];
    if (!hit) return ui.toast(`오늘 날짜(${q}) 항목이 없어요`, 2.5, true);
    open(close, hit.id);
  }

  /** 날짜 칸 하나: 날짜 숫자(누르면 그날 보기) · 개수 · 항목들(넘치면 칸 안에서 스크롤) */
  const cell = (s, set, close, d) => {
    const list = s.map[fmt(d)] || [], isToday = fmt(d) === fmt(new Date());
    const num = Text(String(d.getDate())).bold().tooltip('이 날 보기').onTap(() => { set({ cur: d }); setView(s, set, 'day'); });
    if (isToday) num.background('accent').color('inverse').radius('pill').padding({ x: 7 });
    return VStack({ gap: 3 },
      HStack(num, Spacer(), list.length > 2 && Text(`${list.length}개`).font('caption').attr('data-f', 'cnt')), // 칸을 넘칠 만큼 많으면 개수
      VStack({ gap: 2 }, list.map((it) => { const c = Chip(it.text, () => open(close, it.id)).attr('data-f', 'item'); return s.view === 'week' ? c.cls('v-wrap') : c; })).scroll().fill(),
    ).padding({ x: 6, y: 5 }).attr('data-f', 'cell').attr('data-today', isToday);
  };

  function body(s, set, close) {
    const days = daysOf(s), m = s.cur.getMonth(), zoomed = api.view.zoomId() != null;
    const head = HStack({ gap: 6, wrap: true },
      IconButton('prev', () => move(s, set, -1), '이전 (← · PageUp)'),
      Text(titleOf(s)).font('title').frame({ minWidth: 120 }).align('center').attr('data-f', 'title'),
      IconButton('next', () => move(s, set, 1), '다음 (→ · PageDown)'),
      Button('오늘', () => today(s, set, close)).size('sm').tooltip('오늘로 · 이미 오늘이면 오늘 날짜 항목으로 가요'),
      Segmented(VIEWS, s.view, (v) => setView(s, set, v)),
      zoomed && Button(s.inScope ? '이 항목 안만' : '전체', () => { set({ inScope: !s.inScope }); load(s, set); }).size('sm'),
      Spacer(),
      s.more && Text('항목이 너무 많아 일부만 보여요').font('caption'),
      IconButton('close', () => close(), '닫기 (Esc)'),
    );
    if (s.view === 'day') { // 하루: 항목을 글 전체로 크게
      const list = s.map[fmt(days[0])] || [];
      return VStack({ gap: 12 }, head,
        VStack({ gap: 6 }, list.length ? [Text(`${list.length}개`).font('caption'), ...list.map((it) => Chip(it.text, () => open(close, it.id)).cls('v-wrap').font('body').padding({ x: 12, y: 9 }).attr('data-f', 'item'))]
          : Text('이 날짜가 적힌 항목이 없어요').font('caption').align('center').padding(48)).scroll().fill().frame({ maxWidth: 832, width: '100%' }).css({ margin: '0 auto' }),
      ).fill().attr('data-f', 'cal');
    }
    return VStack({ gap: 12 }, head,
      Grid({ columns: 7, rows: `auto repeat(${days.length / 7}, minmax(0, 1fr))`, lines: true },
        DOW.map((d, i) => Text(d).bold().align('center').color(i === 0 ? 'danger' : i === 6 ? 'link' : 'mute').padding({ y: 6 })),
        days.map((d) => (s.view === 'month' && d.getMonth() !== m ? VStack().background('fill').opacity(0.5) : cell(s, set, close, d))),
      ).fill().attr('data-f', 'grid'),
    ).fill().attr('data-f', 'cal');
  }

  return {
    calendar() { // 예전 sc
      return ui.sheet({
        size: 'full',
        state: { cur: day0(new Date()), view: savedView(), inScope: false, map: {}, more: false },
        task: (s, set) => load(s, set),
        body,
        onKey: (e, s, set) => {
          if (e.isComposing) return false;
          const typing = e.target.closest?.('input, textarea');
          if (e.key === 'PageUp' || (e.key === 'ArrowLeft' && !typing)) { e.preventDefault(); move(s, set, -1); return true; }
          if (e.key === 'PageDown' || (e.key === 'ArrowRight' && !typing)) { e.preventDefault(); move(s, set, 1); return true; }
          return false;
        },
      });
    },
  };
}

export default (api) => command(api, { name: 'calendar', label: '달력 (날짜 항목으로 이동 · 오늘 단추를 두 번 누르면 오늘 날짜 항목으로)', keys: 'Alt+S', make });
