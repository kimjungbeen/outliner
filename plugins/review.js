// 간격 반복 복습: FSRS-5 — review 하나로 (예전 rv · dt)
//   무엇을 복습하나: ① 고른 항목이 있으면 그 항목들 ② 없으면 지금 화면이 덱 — 홈이면 전체, 줌인했으면 그 항목과 하위에서 밀린 카드를 오래 밀린 순으로
//   ③ 줌인한 화면에 밀린 카드가 없으면 그 항목 자신 (처음 카드로 만들 때도). 카드가 이어서 떠요 — 질문 → 답 보기(Space) → 1~4 → 다음 카드, Esc는 그만
// 복습 정보는 항목 아래 ".fsrs" 자식 항목에 "difficulty: 5.1" 같은 줄로 저장돼요.
// 시각은 초까지 ("last_review: 2026-10-15 14:03:27") — 지난 시간을 초 단위로 재서 기억 확률을 계산해요. 예전의 날짜만 있는 기록도 읽어요(그날 0시로).
import { command } from './_kit.js';
const W = [0.4072, 1.1829, 3.1262, 15.4722, 7.2102, 0.5316, 1.0651, 0.0234, 1.616,
  0.1544, 1.0824, 1.9813, 0.0953, 0.2975, 2.2042, 0.2407, 2.9466, 0.5034, 0.6567];
const DECAY = -0.5;
const FACTOR = 19 / 81;
const DEFAULT_RETENTION = 0.9;

const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);
const initStability = (g) => Math.max(W[g - 1], 0.1);
const initDifficulty = (g) => clamp(W[4] - Math.exp(W[5] * (g - 1)) + 1, 1, 10);
const meanReversion = (init, cur) => W[7] * init + (1 - W[7]) * cur;
function nextDifficulty(d, g) {
  const damped = (-W[6] * (g - 3) * (10 - d)) / 9;
  return clamp(meanReversion(initDifficulty(4), d + damped), 1, 10);
}
const forgettingCurve = (t, s) => Math.pow(1 + (FACTOR * t) / s, DECAY);
function nextRecallStability(d, s, r, g) {
  const hardPenalty = g === 2 ? W[15] : 1;
  const easyBonus = g === 4 ? W[16] : 1;
  return s * (1 + Math.exp(W[8]) * (11 - d) * Math.pow(s, -W[9]) * (Math.exp((1 - r) * W[10]) - 1) * hardPenalty * easyBonus);
}
const nextForgetStability = (d, s, r) => W[11] * Math.pow(d, -W[12]) * (Math.pow(s + 1, W[13]) - 1) * Math.exp((1 - r) * W[14]);
// 간격은 반올림하지 않아요 (일 단위 소수, 예: 0.41일 ≈ 9.8시간) — 하루보다 짧은 Again도 FSRS가 계산한 그대로. 최소 1분
const nextIntervalDays = (s, retention) => Math.max(1 / 1440, (s / FACTOR) * (Math.pow(retention, 1 / DECAY) - 1));
/** 간격(일, 소수) → "35분" · "9.8시간" · "3일" · "2개월" · "1.2년" */
function fmtInterval(days) {
  const min = days * 1440;
  if (min < 60) return `${Math.max(1, Math.round(min))}분`;
  if (days < 1) { const h = min / 60; return `${h < 10 ? h.toFixed(1).replace(/\.0$/, '') : Math.round(h)}시간`; }
  if (days < 31) return `${days < 10 ? days.toFixed(1).replace(/\.0$/, '') : Math.round(days)}일`;
  if (days < 365) return `${Math.round(days / 30)}개월`;
  return `${(days / 365).toFixed(1)}년`;
}
// FSRS-5: 하루가 안 지나 다시 복습하면(같은 날 복습) 기억 확률 대신 이 식으로 안정도를 바꿔요
const nextShortTermStability = (s, g) => s * Math.exp(W[17] * (g - 3 + W[18]));

const DAY_MS = 86400000;
const p2 = (n) => String(n).padStart(2, '0');
const fmtDate = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const fmtDateTime = (d) => `${fmtDate(d)} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
/** "2026-10-15 14:03:27" · "2026-10-15T14:03" · "2026-10-15"(그날 0시) → 이 컴퓨터 시간대의 Date. 형식이 아니면 null */
function parseTime(str) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(String(str ?? '').trim());
  return m ? new Date(+m[1], m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)) : null;
}
/** 지난 시간(일, 초 단위까지의 소수) → 다음 복습 상태 { d, st }. s가 없으면 첫 복습 */
function schedule(s, rating, elapsedDays) {
  if (!s) return { d: initDifficulty(rating), st: initStability(rating) };
  const d = nextDifficulty(s.difficulty, rating);
  if (elapsedDays < 1) return { d, st: nextShortTermStability(s.stability, rating) };
  const r = forgettingCurve(elapsedDays, s.stability);
  return { d, st: rating === 1 ? nextForgetStability(d, s.stability, r) : nextRecallStability(d, s.stability, r, rating) };
}

export { W, initDifficulty, initStability, nextDifficulty, nextRecallStability, nextForgetStability, nextShortTermStability, nextIntervalDays, fmtInterval, forgettingCurve, parseTime, fmtDateTime, schedule };

function make(api, ui, t) {
  const { kids } = t;
  const fsrsOf = (id) => kids(id).find((c) => c.content.trim() === '.fsrs');
  const fsrsLoaded = async (id) => { // .fsrs는 보통 접혀 있어 안의 줄이 아직 안 불러와져 있어요 → 그 아래만 불러와요 (안 하면 기존 줄을 못 찾아 매번 새로 붙었어요)
    let f = fsrsOf(id);
    if (!f && api.nodes.get(id)?.hk) { await api.nodes.loadSubtree(id); f = fsrsOf(id); } // 자식이 아주 많아 첫 쪽에 없으면
    if (f) await api.nodes.loadSubtree(f.id);
    return f;
  };
  const fieldOf = (node, key) => {
    const c = kids(node.id).find((x) => x.content.trim().startsWith(key + ':'));
    return c ? c.content.trim().slice(key.length + 1).trim() : null;
  };
  const dueOf = (n) => {
    const f = fsrsOf(n.id);
    return f ? fieldOf(f, 'due') : null;
  };

  // 복습 카드: 질문(항목 글)만 보여주고, '답 보기'(Space)를 누르면 하위 항목(답)을 펼쳐요. 뒤 화면은 흐려서 답을 미리 못 봐요.
  // 답을 본 뒤 Again · Hard · Good · Easy (1 · 2 · 3 · 4) → 고른 번호(0부터) / 취소(Esc) → null
  async function askCard(cur, answer, labels, info = null) { // info: { idx, total, scope, go } — 이어서 복습할 때 몇 번째인지
    const { VStack, Text, Lines, Actions, Button, Divider } = ui;
    const rows = []; // 답을 들여쓰기 그대로 (너무 길면 200줄까지)
    (function list(nodes, depth) {
      for (const n of nodes) {
        if (rows.length >= 200) return;
        rows.push({ depth, mark: '•', text: n.content });
        list(kids(n.id).filter((c) => c.content.trim() !== '.fsrs'), depth + 1);
      }
    })(answer, 0);
    const title = info && info.total > 1 ? `복습 · ${info.idx} / ${info.total}` : '복습';
    return ui.sheet({
      title, blur: true, state: { shown: false }, // 뒤 화면은 흐려서 답을 미리 못 봐요
      onKey: (e, s, set, close) => {
        if (e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return false;
        if ((e.key === ' ' || e.key === 'Enter') && !s.shown) { e.preventDefault(); set({ shown: true }); return true; }
        if (/^[1-4]$/.test(e.key) && s.shown) { e.preventDefault(); close(+e.key - 1); return true; }
        if (info?.go && 'gGㅎ'.includes(e.key)) { e.preventDefault(); close('go'); return true; }
        return false;
      },
      body: (s, set, close) => VStack({ gap: 10 },
        // 안내: 지금 무엇을 복습하는지 · 어떻게 하는지 (답을 보면 등급 안내로 바뀌어요)
        Text(s.shown ? '얼마나 잘 떠올렸나요? 1 다시 · 2 어려움 · 3 좋음 · 4 쉬움 — 단추에 다음 복습까지의 간격'
          : `${info?.scope ? `${info.scope} · ` : ''}답을 떠올린 뒤 답 보기 (Space) · Esc 그만`).font('caption').attr('data-f', 'guide'),
        Text(cur.content || '(빈 항목)').font('title').wrap().attr('data-f', 'q'),
        s.shown && Divider(),
        s.shown && (rows.length ? Lines(rows) : Text('하위 항목(답)이 없어요').font('caption')).scroll('50vh').attr('data-f', 'a'),
        s.shown
          ? Actions(labels.map((l, k) => Button(l, () => close(k)).style(k === 0 ? 'danger' : k === 2 ? 'primary' : 'ghost').tooltip(`${k + 1}`).autofocus(k === 2)))
          : Actions(info?.go && Button('항목으로 가기 (G)', () => close('go')).tooltip('복습을 멈추고 이 항목이 있는 곳으로'), // 전역 · 하위: 화면은 그대로 두고 복습만, 원하면 그 항목으로
              Button('답 보기 (Space)', () => set({ shown: true })).style('primary').autofocus()),
      ),
    });
  }

  // 항목 하나를 복습하고 다음 복습일을 기록 → 다음 복습 시각 (그만두면 null). info: 이어서 복습할 때 몇 번째인지
  async function review(card, info = null) { // card: 항목 id, 또는 안 불러온 카드 { id, content }
      const curId = typeof card === 'object' ? card.id : card;
      const cur = api.nodes.get(curId) ?? (typeof card === 'object' ? card : null);
      if (!cur) return null;
      if (!api.nodes.get(curId)) await api.nodes.loadSubtree(curId); // 안 불러온 카드 — 하위(.fsrs · 답)를 먼저
      await api.view.flush?.();
      const fsrs = await fsrsLoaded(curId);

      const s = { difficulty: null, stability: null, reps: 0, lapses: 0, last_review: null, retention: DEFAULT_RETENTION };
      if (fsrs) {
        const num = (k, parse) => { const v = fieldOf(fsrs, k); return v === null ? null : parse(v); };
        s.difficulty = num('difficulty', parseFloat);
        s.stability = num('stability', parseFloat);
        s.reps = num('reps', (v) => parseInt(v, 10)) ?? 0;
        s.lapses = num('lapses', (v) => parseInt(v, 10)) ?? 0;
        s.last_review = fieldOf(fsrs, 'last_review');
        const ret = num('retention', parseFloat);
        if (ret !== null && !isNaN(ret)) s.retention = ret;
      }

      const names = ['Again', 'Hard', 'Good', 'Easy'];
      const now0 = new Date();
      const first0 = s.reps === 0 || s.stability === null || s.difficulty === null || isNaN(s.stability) || isNaN(s.difficulty);
      const gap = Math.max(0, (now0 - (parseTime(s.last_review) ?? now0)) / DAY_MS);
      const nextLabel = (g) => fmtInterval(nextIntervalDays(schedule(first0 ? null : s, g, gap).st, s.retention));
      await api.nodes.loadSubtree(curId); // 답 = 하위 항목들 (.fsrs 빼고)
      const pick = await askCard(cur, kids(curId).filter((c) => c.content.trim() !== '.fsrs'), names.map((nm, k) => `${nm} · ${nextLabel(k + 1)}`), info);
      if (pick === null || pick === 'go') return pick;
      const rating = pick + 1;

      const now = new Date();
      const first = s.reps === 0 || s.stability === null || s.difficulty === null || isNaN(s.stability) || isNaN(s.difficulty);
      const last = parseTime(s.last_review) ?? now;
      const elapsedDays = Math.max(0, (now - last) / DAY_MS); // 초 단위까지 (예: 1.4237일)
      const { d, st } = schedule(first ? null : s, rating, elapsedDays);
      const reps = s.reps + 1;
      const lapses = s.lapses + (rating === 1 ? 1 : 0);
      const intervalDays = nextIntervalDays(st, s.retention);
      const due = new Date(now.getTime() + intervalDays * DAY_MS); // 복습한 시각에서 정확히 그만큼 뒤 (초 단위)

      const entries = [
        ['difficulty', d.toFixed(4)], ['stability', st.toFixed(4)], ['reps', reps], ['lapses', lapses],
        ['retention', s.retention], ['last_review', fmtDateTime(now)], ['due', fmtDateTime(due)], ['interval_days', intervalDays.toFixed(4)],
        ['elapsed_days', first ? 0 : elapsedDays.toFixed(4)],
      ];
      let nodeId = fsrs?.id;
      if (nodeId === undefined) nodeId = await api.nodes.create(curId, 0, '.fsrs');
      const existing = fsrs ? kids(nodeId) : [];
      const ops = [], fresh = [];
      for (const [k, v] of entries) {
        const same = existing.filter((x) => x.content.trim().startsWith(k + ':'));
        if (same.length) {
          ops.push({ id: same[0].id, content: `${k}: ${v}` });
          for (const dup of same.slice(1)) ops.push({ id: dup.id, delete: true }); // 예전 버그로 쌓인 같은 줄은 정리해요 (맨 위 = 가장 최근 값만 남김)
        } else fresh.push({ depth: 0, text: `${k}: ${v}` });
      }
      if (ops.length) await api.nodes.bulk(ops);
      if (fresh.length) await api.nodes.importItems(nodeId, existing.length, fresh);
      if (!info || info.total === 1) { await api.view.refresh(); ui.toast(`[${names[pick]}] 다음 복습: ${fmtDateTime(due).slice(0, 16)} (${fmtInterval(intervalDays)} 후)`, 3); }
      return due;
  }

  const isCard = (n) => !!n && n.content.trim() !== '.fsrs' && api.nodes.get(n.parent_id)?.content.trim() !== '.fsrs'; // .fsrs와 그 안의 줄은 카드가 아니에요
  const when = (d) => fmtDateTime(d).slice(0, 16);

  // 밀린 카드 찾기 — 'due:' 줄을 서버에서 찾아요 (안 불러온 곳까지). 경로 = [… 카드, .fsrs] → { card: { id, content }, d }
  async function dueCards(scope = null) {
    const out = [];
    for (let after = null; ;) {
      const r = await api.nodes.search('^\\s*due:', { regex: true, scope, limit: 500, after });
      for (const h of r.results || []) {
        const [card, f] = h.path.slice(-2), parent = h.path.at(-3);
        if (f?.content.trim() !== '.fsrs' || !card) continue;
        const d = parseTime(h.content.trim().slice(4).trim());
        if (d) out.push({ card: { ...card, parent_id: parent?.id ?? null }, d });
      }
      if (!r.more || !r.results?.length) break;
      after = r.results.at(-1).id;
    }
    return out;
  }

  return {
    async review() {
      const here = api.view.zoomId(), now = new Date();
      const sel = api.view.selection().map((id) => api.nodes.get(id)).filter(isCard);
      const cur = api.view.cursorId(), curNode = cur != null && cur !== here ? api.nodes.get(cur) : null; // 제목의 커서 = 줌인한 항목
      const mine = sel.length ? sel : isCard(curNode) ? [curNode] : here !== null ? [api.nodes.get(here)].filter(isCard) : [];
      const all = await dueCards();
      const due = (list) => list.filter((x) => x.d <= now).sort((a, b) => a.d - b.d);
      const under = here === null ? [] : await dueCards(here); // 하위 = 줌인한 항목과 그 아래
      const dueAll = due(all), dueUnder = due(under);
      const short = (n) => { const c = (n.content || '(빈 항목)').trim(); return c.length > 18 ? c.slice(0, 18) + '…' : c; };
      const opts = [{ label: `전역 복습 · ${dueAll.length}개`, value: 'all' }];
      if (here !== null) opts.push({ label: `하위 복습 · ${dueUnder.length}개`, value: 'sub' });
      if (mine.length) opts.push({ label: mine.length > 1 ? `고른 항목 복습 · ${mine.length}개` : `현재 노드 복습 · ${short(mine[0])}`, value: 'here' });
      const def = mine.length && (sel.length || curNode) ? 'here' : here !== null ? 'sub' : 'all'; // Enter = 커서·고른 항목 > 줌인한 곳 > 전체
      opts.forEach((o) => { if (o.value === def) o.primary = true; });
      const pickScope = await ui.choose('복습', '무엇을 복습할까요? 전역 · 하위는 밀린 카드를 오래 밀린 순으로 이어서', [...opts, { label: '취소', value: null }]);
      if (!pickScope) return;
      let queue, scope;
      if (pickScope === 'here') { queue = mine.map((n) => n.id); scope = mine.length > 1 ? `고른 항목 ${mine.length}개` : '현재 노드'; }
      else {
        const list = pickScope === 'all' ? dueAll : dueUnder;
        if (!list.length) {
          const later = (pickScope === 'all' ? all : under).filter((x) => x.d > now).sort((a, b) => a.d - b.d)[0];
          return ui.toast(later ? `지금 복습할 카드가 없어요 · 다음 복습 ${when(later.d)}` : '아직 카드가 없어요 — 현재 노드 복습을 하면 그 항목이 카드가 돼요', 4);
        }
        queue = list.map((x) => x.card); scope = `${pickScope === 'all' ? '전역' : '하위'} 밀린 카드 ${list.length}개`;
      }
      const move = pickScope !== 'here'; // 전역 · 하위는 다른 곳의 카드 — 화면은 그대로, 원하면 '항목으로 가기'
      let done = 0, soonest = null;
      for (let k = 0; k < queue.length; k++) {
        const d = await review(queue[k], { idx: k + 1, total: queue.length, scope, go: move });
        if (d === 'go') { const c = queue[k], n = api.nodes.get(c.id ?? c) ?? c; if (done) await api.view.refresh(); await api.view.goTo({ id: n.id, parent_id: n.parent_id }); return; } // 그 항목으로 가며 그만
        if (!d) break; // Esc · 바깥 = 그만
        done++; if (!soonest || d < soonest) soonest = d;
      }
      if (queue.length > 1) {
        await api.view.refresh();
        if (done) ui.toast(`${done}개 복습했어요${done < queue.length ? ` (남은 ${queue.length - done}개)` : ''} · 가장 가까운 다음 복습 ${when(soonest)}`, 3.5);
      }
    },
  };
}

export default (api) => command(api, { name: 'review', label: '복습 (FSRS — 전역 · 하위 · 현재 노드 중에서 골라요)', keys: 'Alt+R', make });
