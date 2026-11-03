// 수식 도우미: 항목 만들기(gen) · 계층 바꾸기(tx)가 함께 써요.
// 수식은 자바스크립트 식이에요. Math의 함수(floor · max …)와 아래 도우미를 이름만으로 쓸 수 있어요.

/** 'YYYY-MM-DD' (또는 Date) → 그 날 0시의 Date */
function toDate(s) {
  if (s instanceof Date) return new Date(s.getFullYear(), s.getMonth(), s.getDate());
  const m = String(s).match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) throw new Error(`날짜가 아니에요: ${s}`);
  return new Date(+m[1], +m[2] - 1, +m[3]);
}
const WD = '일월화수목금토';
/** Date → fmt (YYYY · YY · MM · M · DD · D · ddd=요일) */
function fmtDate(d, fmt = 'YYYY-MM-DD') {
  const p2 = (x) => String(x).padStart(2, '0');
  return fmt.replace(/YYYY|YY|MM|M|DD|D|ddd/g, (t) => ({
    YYYY: d.getFullYear(), YY: String(d.getFullYear()).slice(2), MM: p2(d.getMonth() + 1), M: d.getMonth() + 1,
    DD: p2(d.getDate()), D: d.getDate(), ddd: WD[d.getDay()],
  })[t]);
}

export const HELPERS = {
  ...Object.fromEntries(Object.getOwnPropertyNames(Math).map((k) => [k, Math[k]])),
  /** 앞을 채워 w자리로: pad(7) → "07" · pad(7, 3) → "007" */
  pad: (x, w = 2, c = '0') => String(x).padStart(w, c),
  /** 날짜 더하기 · 꾸미기: date('2026-01-01', 6) → "2026-01-07" · date('2026-01-01', 0, 'M월 D일 (ddd)') → "1월 1일 (목)" */
  date: (s, add = 0, fmt = 'YYYY-MM-DD') => { const d = toDate(s); d.setDate(d.getDate() + add); return fmtDate(d, fmt); },
  /** 요일 한 글자: weekday('2026-01-01') → "목" */
  weekday: (s) => WD[toDate(s).getDay()],
  /** 오늘 날짜 (fmt는 date와 같아요) */
  today: (fmt = 'YYYY-MM-DD') => fmtDate(new Date(), fmt),
};
export { toDate, fmtDate };

const cache = new Map();
/** 식 → (ctx) => 값. 문법이 틀리면 여기서 오류를 던져요 */
export function compile(expr) {
  if (!cache.has(expr)) {
    // with: ctx의 이름(text · n · $1 …)과 도우미를 식 안에서 바로 쓰게 해요 (이 앱 안에서 내가 쓴 식만 돌려요)
    const f = new Function('__h', '__c', `with (__h) with (__c) { return (${expr}\n); }`);
    cache.set(expr, (ctx) => f(HELPERS, ctx));
    if (cache.size > 200) cache.delete(cache.keys().next().value);
  }
  return cache.get(expr);
}
