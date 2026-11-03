// 성구 찾기 (verse, 예전 fs) — 괄호 없어도, 문단 어디서든. 성구 범위 → 숫자 변환 · 약호 표도 여기에
import { command } from './_kit.js';
const BOOKS = {
  창: 1, 출: 2, 레: 3, 민: 4, 신: 5, 수: 6, 삿: 7, 룻: 8, 삼상: 9, 삼하: 10, 왕상: 11, 왕하: 12,
  역상: 13, 대상: 13, 역하: 14, 대하: 14, 스: 15, 라: 15, 느: 16, 에: 17, 더: 17, 욥: 18, 시: 19,
  잠: 20, 전: 21, 아: 22, 사: 23, 렘: 24, 애: 25, 겔: 26, 단: 27, 호: 28, 욜: 29, 암: 30, 옵: 31,
  욘: 32, 미: 33, 나: 34, 합: 35, 습: 36, 학: 37, 슥: 38, 말: 39, 마: 40, 막: 41, 눅: 42, 요: 43,
  행: 44, 롬: 45, 고전: 46, 고후: 47, 갈: 48, 엡: 49, 빌: 50, 골: 51, 살전: 52, 살후: 53, 딤전: 54,
  딤후: 55, 딛: 56, 몬: 57, 히: 58, 약: 59, 벧전: 60, 벧후: 61, 요1: 62, 요2: 63, 요3: 64, 유: 65, 계: 66,
};
// 다른 이름들: 한글 전체 이름(신세계역 · 개역) · 영문 이름과 약호. 띄어쓰기 · 마침표("Gen.") · 대소문자는 가리지 않아요.
// 영문 약호는 신세계역 약호(Ge · Ex · Le … Re)와 흔한 영문 약호(Gen · Deut · 1 Chron · Song of Sol …)를 모두 알아요. 두 글자 약호도 글 속에서는
// 쓴 모양 그대로(대소문자)이고 바로 뒤에 장:절이 있을 때만 성구로 봐요 ("Am 5:24"는 성구, "I am 5"는 아님). "1Sa"처럼 숫자에 붙여 써도 돼요.
const NAMES = [
  [1, '창세기', 'Genesis', 'Gen', 'Gn', 'Ge'],
  [2, '탈출기', '출애굽기', 'Exodus', 'Exod', 'Ex'],
  [3, '레위기', 'Leviticus', 'Lev', 'Lv', 'Le'],
  [4, '민수기', 'Numbers', 'Num', 'Nm', 'Nu'],
  [5, '신명기', 'Deuteronomy', 'Deut', 'Dt', 'De'],
  [6, '여호수아', 'Joshua', 'Josh', 'Jos'],
  [7, '재판관기', '사사기', 'Judges', 'Judg', 'Jdg', 'Jg'],
  [8, '룻기', 'Ruth', 'Ru'],
  [9, '사무엘기 상', '사무엘상', '1 Samuel', '1 Sam', '1 Sm', '1 Sa'],
  [10, '사무엘기 하', '사무엘하', '2 Samuel', '2 Sam', '2 Sm', '2 Sa'],
  [11, '열왕기 상', '열왕기상', '1 Kings', '1 Kgs', '1 Ki'],
  [12, '열왕기 하', '열왕기하', '2 Kings', '2 Kgs', '2 Ki'],
  [13, '역대기 상', '역대상', '1 Chronicles', '1 Chron', '1 Chr', '1 Ch'],
  [14, '역대기 하', '역대하', '2 Chronicles', '2 Chron', '2 Chr', '2 Ch'],
  [15, '에스라', 'Ezra', 'Ezr'],
  [16, '느헤미야', 'Nehemiah', 'Neh', 'Ne'],
  [17, '에스더', 'Esther', 'Esth', 'Est', 'Es'],
  [18, '욥기', 'Job'],
  [19, '시편', 'Psalms', 'Psalm', 'Psa', 'Ps'],
  [20, '잠언', 'Proverbs', 'Prov', 'Prv', 'Pr'],
  [21, '전도서', 'Ecclesiastes', 'Eccl', 'Ecc', 'Eccles', 'Ec'],
  [22, '솔로몬의 노래', '아가', 'Song of Solomon', 'Song of Songs', 'Song', 'Sol', 'Song of Sol', 'Ca'],
  [23, '이사야', 'Isaiah', 'Isa'],
  [24, '예레미야', 'Jeremiah', 'Jer'],
  [25, '예레미야애가', '애가', 'Lamentations', 'Lam', 'La'],
  [26, '에스겔', 'Ezekiel', 'Ezek', 'Eze', 'Ezk'],
  [27, '다니엘', 'Daniel', 'Dan', 'Dn', 'Da'],
  [28, '호세아', 'Hosea', 'Hos', 'Ho'],
  [29, '요엘', 'Joel', 'Jl', 'Joe'],
  [30, '아모스', 'Amos', 'Am'],
  [31, '오바댜', 'Obadiah', 'Obad', 'Ob'],
  [32, '요나', 'Jonah', 'Jon', 'Jnh'],
  [33, '미가', 'Micah', 'Mic'],
  [34, '나훔', 'Nahum', 'Nah', 'Na'],
  [35, '하박국', 'Habakkuk', 'Hab'],
  [36, '스바냐', 'Zephaniah', 'Zeph', 'Zep'],
  [37, '학개', 'Haggai', 'Hag'],
  [38, '스가랴', 'Zechariah', 'Zech', 'Zec'],
  [39, '말라기', 'Malachi', 'Mal'],
  [40, '마태복음', 'Matthew', 'Matt', 'Mt'],
  [41, '마가복음', 'Mark', 'Mk', 'Mr'],
  [42, '누가복음', 'Luke', 'Lk', 'Lu'],
  [43, '요한복음', 'John', 'Jn', 'Joh'],
  [44, '사도행전', 'Acts', 'Ac'],
  [45, '로마서', 'Romans', 'Rom', 'Rm', 'Ro'],
  [46, '고린도 전서', '고린도전서', '1 Corinthians', '1 Cor', '1 Co'],
  [47, '고린도 후서', '고린도후서', '2 Corinthians', '2 Cor', '2 Co'],
  [48, '갈라디아서', 'Galatians', 'Gal', 'Ga'],
  [49, '에베소서', 'Ephesians', 'Eph'],
  [50, '빌립보서', 'Philippians', 'Phil', 'Php'],
  [51, '골로새서', 'Colossians', 'Col'],
  [52, '데살로니가 전서', '데살로니가전서', '1 Thessalonians', '1 Thess', '1 Thes', '1 Th'],
  [53, '데살로니가 후서', '데살로니가후서', '2 Thessalonians', '2 Thess', '2 Thes', '2 Th'],
  [54, '디모데 전서', '디모데전서', '1 Timothy', '1 Tim', '1 Ti'],
  [55, '디모데 후서', '디모데후서', '2 Timothy', '2 Tim', '2 Ti'],
  [56, '디도서', 'Titus', 'Tit'],
  [57, '빌레몬서', 'Philemon', 'Philem', 'Phm', 'Phlm'],
  [58, '히브리서', 'Hebrews', 'Heb'],
  [59, '야고보서', 'James', 'Jas', 'Jam'],
  [60, '베드로 전서', '베드로전서', '1 Peter', '1 Pet', '1 Pt', '1 Pe'],
  [61, '베드로 후서', '베드로후서', '2 Peter', '2 Pet', '2 Pt', '2 Pe'],
  [62, '요한 1서', '요한일서', '요일', '1 John', '1 Jn', '1 Jo'],
  [63, '요한 2서', '요한이서', '요이', '2 John', '2 Jn', '2 Jo'],
  [64, '요한 3서', '요한삼서', '요삼', '3 John', '3 Jn', '3 Jo'],
  [65, '유다서', 'Jude'],
  [66, '요한계시록', '계시록', 'Revelation', 'Rev', 'Rv', 'Re'],
];
/** 책 이름 비교용: 띄어쓰기 · 마침표 없애고 소문자로 ("1 Cor." → "1cor") */
const norm = (b) => String(b).replace(/[\s.]+/g, '').toLowerCase();
const ROMAN = { 1: ['I', 'First', '1st'], 2: ['II', 'Second', '2nd'], 3: ['III', 'Third', '3rd'] };
const BOOK_NO = new Map(Object.entries(BOOKS).map(([k, v]) => [norm(k), v]));
const SPELLINGS = Object.keys(BOOKS); // 글 속에서 찾을 때 쓰는 모양들
for (const [no, ...names] of NAMES) {
  for (const n of names) {
    const m = /^([123]) (.+)$/.exec(n);
    for (const v of m ? [n, ...ROMAN[m[1]].map((r) => `${r} ${m[2]}`)] : [n]) { // "1 John" → "I John" · "First John" · "1st John"도
      BOOK_NO.set(norm(v), no);
      SPELLINGS.push(v);
    }
  }
}
const bookNo = (b) => BOOK_NO.get(norm(b));

/** target 예: "1:1:1"(창세기 1장 1절), range 예: "1:1:1-1:2:1" → target이 range 안에 있는지 */
export function isTargetInRange(target, range) {
  if (!target || !range) return false;
  const [tb, tc, tv] = target.split(':');
  const [sr, er] = range.split('-');
  const [sb, sc, sv] = sr.split(':');
  if (!er) return tb == sb && tc == sc && tv == sv;
  const [eb, ec, ev] = er.split(':');
  const num = (b, c, v) => parseInt(b) * 1_000_000 + parseInt(c) * 1_000 + parseInt(v);
  const s = num(sb, sc, sv), t = num(tb, tc, tv), e = num(eb, ec, ev);
  return s <= t && t <= e;
}

/** "창 1:1-3; 출 2:4" → "1:1:1-1:1:3; 2:2:4" */
export function convertBibleRangeToNumeric(input) {
  const results = [];
  for (const range of input.split(';').map((r) => r.trim())) {
    try {
      const matchBook = range.match(/^([^():\s]+)\s*(\d+):/);
      if (!matchBook) continue;
      const chapter = parseInt(matchBook[2]);
      const book = bookNo(matchBook[1]);
      if (!book || isNaN(chapter)) continue;
      const parts = range.slice(matchBook[0].length).split(',').map((p) => p.trim());
      for (const part of parts) {
        if (part.includes('-')) {
          const [sv, endStr] = part.split('-').map((s) => s.trim());
          if (!endStr.includes(':')) {
            // 같은 장 안의 절 범위 (예: 1-3)
            results.push(`${book}:${chapter}:${parseInt(sv)}-${book}:${chapter}:${parseInt(endStr)}`);
          } else if (!endStr.match(/^[\S\d]+\s/)) {
            // 장:절 - 장:절
            const [ec, ev] = endStr.split(':').map(Number);
            results.push(`${book}:${chapter}:${sv}-${book}:${ec}:${ev}`);
          } else {
            // 다른 책 포함 (예: 창 1:1 - 출 1:1)
            const [, endBook, ec, ev] = endStr.match(/^([^():\s]+)\s+(\d+):(\d+)$/);
            results.push(`${book}:${chapter}:${sv}-${bookNo(endBook)}:${ec}:${ev}`);
          }
        } else {
          let verse = part, ch = chapter;
          if (verse.includes(':')) {
            const [chStr, vStr] = verse.split(':');
            ch = parseInt(chStr);
            verse = parseInt(vStr);
          } else verse = parseInt(verse);
          results.push(`${book}:${ch}:${verse}`);
        }
      }
    } catch (e) {
      console.warn(`파싱 중 오류 발생: ${range} → ${e.message}`);
    }
  }
  return results.join('; ');
}

// ---- 글 속 성구 찾기: 괄호가 없어도, 문단 어디에 있어도 ----
// "요 3:16", "롬8:28", "고전 13:4-7", "창 1:1-2:3", "창 1:1, 5, 2:3", "창 1:1; 3:5"(같은 책 이어서), "(출 2:4)" 모두.
// 약호 바로 앞에 한글 · 영문 · 숫자가 붙어 있으면 성구로 보지 않아요 (예: "오전 9:30"의 '전'은 전도서가 아님).
// 책 이름 속 띄어쓰기는 있든 없든("1 John" · "1John" · "고린도 전서" · "고린도전서" · "사무엘 상"), 뒤에 마침표가 있어도("Gen.") 돼요.
const escRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// 이름 속 띄어쓰기: 이름에 있는 빈칸은 있어도 없어도("1 John" · "1John"), 한글 이름은 글자 사이 어디에 빈칸이 있어도("사무엘 상" · "마태 복음" · "요한 일서") 돼요
const altOf = (n) => escRe(n).replace(/ /g, '\\s*').replace(/(?<=[가-힣])(?=[가-힣])/g, '\\s*');
const BOOK_ALT = [...new Set(SPELLINGS)].sort((a, b) => b.length - a.length).map(altOf).join('|');
const SEG = String.raw`\d+\s*:\s*\d+(?:\s*[-–~]\s*(?:\d+\s*:\s*)?\d+)?`;            // 장:절 · 장:절-절 · 장:절-장:절
const ITEM = String.raw`(?:\d+\s*:\s*)?\d+(?:\s*[-–~]\s*(?:\d+\s*:\s*)?\d+)?(?![가-힣\d])`; // 쉼표 뒤: 절 · 장:절 · 범위
// 장이 하나뿐인 책(오바댜 · 빌레몬서 · 요한 2서 · 요한 3서 · 유다서)은 절만 써도 1장으로 봐요: "3 John 4" · "유 3-4" = 요3 1:4 · 유 1:3-4
const SINGLE = new Set([31, 57, 63, 64, 65]);
const SINGLE_ALT = [...new Set(SPELLINGS)].filter((n) => SINGLE.has(bookNo(n))).sort((a, b) => b.length - a.length).map(altOf).join('|');
const VERSE = String.raw`\d+(?:\s*[-–~]\s*\d+)?(?![가-힣\d:])`;
// 책 뒤: 띄어쓰기 · 마침표("Gen.") · 태그 꼴의 쌍점("#벧전:5:8" — 글 속에서는 # 태그일 때만, "그의 말: 3:16"을 말라기로 오인하지 않게)
const refSrc = (colon) => String.raw`(?<![가-힣A-Za-z0-9])(?:(${BOOK_ALT})(?:\.|${colon}(?=\d))?\s*(${SEG}(?:\s*,\s*${ITEM})*(?:\s*;\s*${SEG}(?:\s*,\s*${ITEM})*)*)|(${SINGLE_ALT})(?:\.|${colon}(?=\d))?\s*(${VERSE}(?:\s*,\s*${VERSE})*))`;
const REF_RE = new RegExp(refSrc(String.raw`(?<=#[^\s#]+):`), 'g'); // 글 속: 영문은 쓴 모양 그대로 ("John" · "1 Cor") — "is 3:16" 같은 문장을 성구로 오인하지 않게
const REF_RE_LOOSE = new RegExp(refSrc(':'), 'gi');                 // 찾을 성구 입력: 대소문자 상관없이 ("john 3:16") · "벧전:5:8"도

/** 글 속 성구들을 "책 장:절…" 꼴로 → ["요 3:16", "창 1:1-3,5", …] (세미콜론 뒤에 책이 없으면 앞 책을 이어받아요) */
export function refsFromText(text, { loose = false } = {}) {
  const out = [];
  for (const m of String(text ?? '').matchAll(loose ? REF_RE_LOOSE : REF_RE)) {
    const one = m[1] === undefined; // 장 없이 절만 쓴 한 장짜리 책
    const book = norm(one ? m[3] : m[1]); // "1 John" → "1john" (띄어쓰기가 없어야 뒤에서 장:절과 나눌 수 있어요)
    for (const part of (one ? m[4] : m[2]).split(';')) {
      const p = part.replace(/\s+/g, '').replace(/[–~]/g, '-');
      if (p) out.push(`${book} ${one ? '1:' : ''}${p}`);
    }
  }
  return out;
}
/** "1:2:3" 또는 "1:2:3-1:4:5" → [시작, 끝] 숫자 */
const span = (r) => {
  const num = (x) => { const [b, c, v] = x.split(':').map((n) => parseInt(n)); return b * 1_000_000 + c * 1_000 + v; };
  const [a, b] = r.split('-');
  return [num(a), num(b || a)];
};
/** 글 속 성구 → 숫자 범위 목록 */
export function spansFromText(text, opts) {
  return refsFromText(text, opts).flatMap((r) => convertBibleRangeToNumeric(r).split(';').map((x) => x.trim()).filter(Boolean)).map(span)
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
}
const overlaps = (x, y) => x[0] <= y[1] && y[0] <= x[1];

function make(api, ui, t) {
  return {
    // 성구 찾기: 글 어디에든(괄호 있든 없든) 입력한 성구와 겹치는 성구가 있는 항목을 찾아, 보이도록 조상을 펼치고 강조해요
    async verse(picked) { // 예전 fs — 고른 글자가 있으면 입력 칸에 미리 (성구를 골라 부르면 바로 Enter)
      const input = await ui.prompt('찾을 성구 (예: 요 3:16)', [], { history: 'fs', value: typeof picked === 'string' ? picked : '' });
      if (input === null) return;
      const targets = spansFromText(input, { loose: true });
      if (!targets.length) return ui.toast('성구 형식이 아니에요 (예: 요 3:16 · John 3:16)', 2.5, true);

      const ids = [], found_ids = [];
      let hits = 0;
      for (const n of t.descendants()) {
        if (!spansFromText(n.content).some((r) => targets.some((tar) => overlaps(r, tar)))) continue;
        hits++; found_ids.push(n.id); ids.push(...t.ancestorsUpTo(n));
      }
      if (ids.length) await api.nodes.bulk(t.expandOps(ids));
      await api.view.refresh();
      api.view.highlight(found_ids);
      ui.toast(hits ? `${hits}개 문단에서 찾았어요 · 위쪽 ▲▼로 이동 · 다른 곳을 누르면 해제` : '찾은 문단이 없어요', 2.5, hits === 0);
    },
  };
}

export default (api) => command(api, { name: 'verse', label: '성구 찾기 (괄호 없어도, 문단 어디서든)', make });
