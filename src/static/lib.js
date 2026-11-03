// 화면(DOM)과 상관없는 순수 함수들 — Node로 단독 테스트할 수 있어요 (tests/lib.test.mjs)

/** 검색어 규칙: 공백 = AND · "구절"(따옴표 안은 글자 그대로: 공백 포함·대소문자 구분) · -제외. (서버 server.py의 parse_query와 같은 규칙)
 *  exact = 따옴표로 묶은 조각들 */
export function parseQuery(q) {
  const pos = [], neg = [], exact = [];
  for (const m of q.matchAll(/(-?)"([^"]+)"|(-?)"([^"]*)$|(-?)(\S+)/g)) {
    const quoted = m[2] !== undefined || m[4] !== undefined; // 닫는 따옴표를 아직 안 쓴 입력 중인 구절도 구절로
    const text = m[2] !== undefined ? m[2] : m[4] !== undefined ? m[4] : m[6].trim();
    const isNeg = (m[2] !== undefined ? m[1] : m[4] !== undefined ? m[3] : m[5]) === '-';
    if ((quoted && !text.trim()) || (!quoted && !text.replace(/"/g, ''))) continue; // 빈 따옴표("")는 무시
    if (text && !(text === '-' && !quoted)) { (isNeg ? neg : pos).push(text); if (quoted) exact.push(text); } // 입력 중인 '-'만 있는 조각은 무시
  }
  return { pos, neg, exact };
}

/** text를 [{t, hit}] 조각으로 나눠요. terms와 겹치는 부분(대소문자 무시)이 hit. exact에 든 항목은 대소문자까지 그대로 */
export const TAG_TERM = /^[#@][\p{L}\p{N}][\p{L}\p{N}_:-]*$/u;
const TAG_BEFORE = /^[\p{L}\p{N}_]$/u, TAG_AFTER = /^[\p{L}\p{N}_:-]$/u;
export function splitHighlight(text, terms, exact = []) {
  const low = text.toLowerCase();
  if (low.length !== text.length || !terms.length) return [{ t: text, hit: false }];
  const marks = new Array(text.length).fill(false);
  for (const term of terms) {
    const ex = exact.includes(term), t = ex ? term : term.toLowerCase(), hay = ex ? text : low;
    if (!t) continue;
    const tag = TAG_TERM.test(term); // 태그는 그대로인 곳만 (#태 가 #태그 안에서 칠해지지 않게)
    for (let i = hay.indexOf(t); i >= 0; i = hay.indexOf(t, i + 1)) {
      if (tag && (TAG_BEFORE.test(text[i - 1] ?? '') || TAG_AFTER.test(text[i + t.length] ?? ''))) continue;
      marks.fill(true, i, i + t.length);
    }
  }
  const out = [];
  for (let i = 0; i < text.length;) {
    let j = i;
    while (j < text.length && marks[j] === marks[i]) j++;
    out.push({ t: text.slice(i, j), hit: marks[i] });
    i = j;
  }
  return out.length ? out : [{ t: text, hit: false }];
}

/** 붙여넣기 텍스트 → [{depth, text}]. 들여쓰기(탭=4칸 · 전각 공백=2칸 · 줄바꿈 없는 공백도)와 글머리표로 계층을 복원해요.
 *  keepNumbers: true면 '1.' '2)' 같은 번호는 글에 남겨요 (붙여넣기 — 번호도 내용이라서). false면 지워요 (.md/.txt 가져오기). */
const BULLET = '-*+•▪▫◦‣○●■□◆◇►▶➤✓✔·∙–—';
const BULLET_RE = new RegExp(`^[${BULLET.replace(/[-\]\\^]/g, '\\$&')}](?:\\s+|$)`);
export function parsePaste(raw, { keepNumbers = false } = {}) {
  const stack = [], items = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const ind = /^[ \t\u00a0\u2002\u2003\u3000]*/.exec(line)[0];
    let rest = line.slice(ind.length);
    const b = BULLET_RE.exec(rest);
    if (b) rest = rest.slice(b[0].length);
    else if (!keepNumbers) rest = rest.replace(/^\d+[.)]\s+/, '');
    const m = [null, ind, rest];
    const w = [...m[1]].reduce((sum, c) => sum + (c === '\t' ? 4 : c === '\u3000' || c === '\u2003' ? 2 : 1), 0);
    while (stack.length && stack.at(-1) >= w) stack.pop();
    items.push({ depth: stack.length, text: m[2].trim() });
    stack.push(w);
  }
  return items;
}

/**
 * HTML → [{depth, text}]. root = DOMParser로 만든 body(또는 아무 요소).
 * <ul>/<ol>의 중첩은 그대로 계층이 되고(Workflowy 등 HTML 내보내기), 제목(h1~h6)은 그 아래 내용의 부모가 돼요.
 * 문단/블록은 한 항목, 표는 행마다 한 항목(셀은 " | "로 연결). script/style은 무시해요.
 */
export function parseHtml(root) {
  const out = [], heads = [];
  const SKIP = new Set(['SCRIPT', 'STYLE', 'HEAD', 'TITLE', 'META', 'LINK', 'NOSCRIPT', 'TEMPLATE']);
  const LIST = new Set(['UL', 'OL']);
  const BLOCK = new Set(['UL', 'OL', 'LI', 'P', 'DIV', 'SECTION', 'ARTICLE', 'BLOCKQUOTE', 'PRE', 'TABLE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'DL', 'HEADER', 'FOOTER', 'MAIN', 'NAV', 'ASIDE', 'FIGURE']);
  const clean = (t) => t.replace(/\s+/g, ' ').trim();
  const hasBlock = (el) => [...el.children].some((c) => BLOCK.has(c.tagName));
  // 블록 자식을 뺀 "자기 글자"
  const own = (el) => clean([...el.childNodes].filter((c) => c.nodeType === 3 || (c.nodeType === 1 && !BLOCK.has(c.tagName) && !SKIP.has(c.tagName))).map((c) => c.textContent).join(''));
  const push = (depth, text) => { if (text) out.push({ depth: Math.max(depth, heads.length), text }); }; // 제목 아래 내용은 그 제목의 자식
  function walk(el, base) {
    let prev = null; // 바로 앞에 낸 글 항목의 깊이 — 뒤따르는 <ul>은 그 항목의 자식이에요 (Workflowy 최상위 항목)
    let buf = '';    // 이어진 글자/인라인 요소는 한 항목으로 모아요
    const flush = () => { const t = clean(buf); buf = ''; if (t) { push(base, t); prev = Math.max(base, heads.length); } };
    for (const c of el.childNodes) {
      if (c.nodeType === 3) { buf += c.textContent; continue; }
      if (c.nodeType !== 1 || SKIP.has(c.tagName)) continue;
      const tag = c.tagName;
      if (!BLOCK.has(tag)) { buf += c.textContent; continue; }
      flush();
      if (/^H[1-6]$/.test(tag)) {
        const lv = +tag[1];
        while (heads.length && heads.at(-1) >= lv) heads.pop();
        push(Math.max(base, heads.length), clean(c.textContent));
        heads.push(lv);
        prev = null;
      } else if (LIST.has(tag)) { walk(c, prev === null ? base : prev + 1); prev = null; }
      else if (tag === 'LI') {
        const d = Math.max(base, heads.length); // 제목 아래라면 그만큼 더 들어가서
        // 항목 글: li 바로 안의 글자, 없으면 첫 블록(<div class="name"> · <p> · <h3> …)의 글자. <hr>은 구분선 "---"
        const lead = [...c.children].find((x) => BLOCK.has(x.tagName) && !LIST.has(x.tagName)) || [...c.children].find((x) => x.tagName === 'HR');
        let text = own(c);
        if (!text && lead) text = lead.tagName === 'HR' ? '---' : clean(lead.textContent);
        push(d, text);
        walk2(c, d + 1, text && !own(c) ? lead : null);
        prev = text ? d : null; // 바로 뒤에 형제로 붙은 <ul>(구글 문서 등)은 이 항목의 하위로
      } else if (tag === 'TABLE') {
        for (const tr of c.querySelectorAll('tr')) push(base, clean([...tr.children].map((x) => clean(x.textContent)).filter(Boolean).join(' | ')));
        prev = null;
      } else if (hasBlock(c)) { walk(c, Math.max(base, heads.length)); prev = null; }
      else {
        // 워드: <p style="mso-list:l0 level2 …"><span>·<span> </span></span>글</p> → 단계만큼 들여쓰고 글머리표는 빼요
        const lv = /mso-list:\s*\S+\s+level(\d+)/i.exec(c.getAttribute?.('style') || '');
        const al = +(c.getAttribute?.('aria-level') || 0);
        let t = clean(c.textContent);
        if (lv) t = t.replace(new RegExp(`^(?:[${BULLET.replace(/[-\]\\^]/g, '\\$&')}o§Ø]|\\d+[.)]|[a-z][.)])\\s*`), '');
        push(base + (lv ? +lv[1] - 1 : al > 1 ? al - 1 : 0), t);
        prev = null;
      }
    }
    flush();
  }
  // li 안: 항목 글로 이미 쓴 블록(skip)은 빼고 나머지 블록 자식(중첩 목록·문단)만 처리
  function walk2(li, d, skip) {
    for (const c of li.children) {
      if (c === skip || !BLOCK.has(c.tagName)) continue;
      if (LIST.has(c.tagName)) walk(c, d);
      else walk({ childNodes: [c] }, d);
    }
  }
  walk(root, 0);
  return out;
}

export function flattenJson(list, depth = 0, out = []) {
  if (!Array.isArray(list)) throw new Error('올바른 JSON 형식이 아니에요');
  for (const n of list) {
    if (typeof n?.content !== 'string') throw new Error('올바른 JSON 형식이 아니에요');
    out.push({ depth, text: n.content, collapsed: !!n.collapsed });
    if (n.children) flattenJson(n.children, depth + 1, out);
  }
  return out;
}

/** 드래그 중 포인터가 행의 어디에 있는지: 위쪽 30% = 앞에 · 아래쪽 30% = 뒤에 · 가운데 = 하위로 */
export function dropZone(y, top, height) {
  const r = (y - top) / Math.max(height, 1);
  return r < 0.3 ? 'before' : r > 0.7 ? 'after' : 'child';
}

/**
 * 드롭 위치 → 서버 /api/move 인자. row = 놓을 대상 {id, parent_id, open(펼쳐져 있나), firstChild(첫 자식 id|null)}
 * 반환: {parent, pos:{before?|after?}} 
 */
export function dropTarget(zone, row) {
  if (zone === 'before') return { parent: row.parent_id, pos: { before: row.id } };
  if (zone === 'after') {
    if (row.open && row.firstChild != null) return { parent: row.id, pos: { before: row.firstChild } }; // 펼쳐진 항목 바로 아래 = 첫 자식
    return { parent: row.parent_id, pos: { after: row.id } };
  }
  if (row.open && row.firstChild != null) return { parent: row.id, pos: { before: row.firstChild } };
  return { parent: row.id, pos: {} }; // 접힌 항목 위에 놓으면 맨 끝 자식
}

/** nodes(Map)에서 id의 조상 id들 (가까운 순) */
export function ancestorsOf(nodes, id) {
  const out = [];
  for (let p = nodes.get(id)?.parent_id; p != null; p = nodes.get(p)?.parent_id) out.push(p);
  return out;
}

/** ids 중 하나라도 parent 자신이거나 조상이면 true (자기 하위로 옮기려는 시도) */
export function movesIntoSelf(nodes, ids, parent) {
  if (parent == null) return false;
  const set = new Set(ids);
  return set.has(parent) || ancestorsOf(nodes, parent).some((a) => set.has(a));
}

// ---- 자식 목록(ch) 조작: {ids: [...불러온 앞부분], total: 전체 개수} ----
/** idx 자리에 id 삽입. 불러온 구간 안(또는 목록이 전부 불러와진 상태의 끝)이면 실제로 넣고 true */
export function chInsert(c, id, idx) {
  if (!c) return false;
  const complete = c.ids.length === c.total;
  // idx가 null이면 '진짜 맨 끝'(아직 안 불러온 항목들 뒤)이에요. 숫자로 준 idx는 서버에도 같은 번째로 들어가므로,
  // 불러온 구간 바로 뒤(idx === 길이)여도 구간에 붙여요 — 그 뒤 '더 보기'는 offset=길이부터 이어 받아서 순서가 맞아요.
  const atEnd = idx == null;
  if (atEnd) idx = c.ids.length;
  const inside = idx < c.ids.length || (idx === c.ids.length && (complete || !atEnd));
  if (inside) c.ids.splice(idx, 0, id);
  c.total++;
  return inside;
}
export function chRemove(c, id) {
  if (!c) return false;
  const i = c.ids.indexOf(id);
  if (i >= 0) c.ids.splice(i, 1);
  c.total = Math.max(0, c.total - 1);
  return i >= 0;
}

/** 정규식 일치 부분을 [{t, hit}] 조각으로 (빈 일치는 무시). re는 g 플래그가 없어도 돼요 */
export function splitHighlightRegex(text, re) {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  const out = [];
  let last = 0;
  for (const m of text.matchAll(g)) {
    if (!m[0]) continue;
    if (m.index > last) out.push({ t: text.slice(last, m.index), hit: false });
    out.push({ t: m[0], hit: true });
    last = m.index + m[0].length;
  }
  if (last < text.length || !out.length) out.push({ t: text.slice(last), hit: false });
  return out;
}

// ---- 첨부 표시 (![이름](/files/해시.확장자)) ----
export const FILE_RE = /(!?)\[([^\]]*)\]\((\/files\/[0-9a-f]{24}\.([a-z0-9]{2,4}))\)/g;
export const AUDIO_RE = /^(mp3|wav|m4a|aac|ogg|oga|opus|flac|weba)$/i;
export const fileKind = (ext) => (/^(png|jpe?g|gif|webp|avif|bmp)$/i.test(ext) ? 'image' : /^pdf$/i.test(ext) ? 'pdf' : AUDIO_RE.test(ext) ? 'audio' : 'video');
/** 글 안의 첨부 표시들 → [{name, url, kind}] */
export function fileTokens(text) {
  return [...String(text ?? '').matchAll(FILE_RE)].map((m) => ({ name: m[2], url: m[3], kind: fileKind(m[4]) }));
}

// ---- PDF 내보내기: 옵션에 맞춘 인쇄용 HTML 문서 만들기 ----
// ---- 재생 시간 (오디오 · 영상의 조작부 · 북마크 · 구간 반복) ----
// 초 → "1:23" · "1:02:03"
export const fmtTime = (t) => {
  if (!Number.isFinite(t)) return '0:00';
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = String(Math.floor(t % 60)).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};
// 시간 글 → 초: "1:23" · "1:02:03" · "95" · "1분 30초"
export const parseTime = (v) => {
  v = String(v).trim();
  const ko = v.match(/^(?:(\d+)\s*시간)?\s*(?:(\d+)\s*분)?\s*(?:(\d+(?:\.\d+)?)\s*초)?$/);
  if (ko && (ko[1] || ko[2] || ko[3])) return (+ko[1] || 0) * 3600 + (+ko[2] || 0) * 60 + (+ko[3] || 0);
  if (!/^\d+(?::\d{1,2}){0,2}(?:\.\d+)?$/.test(v)) return null;
  return v.split(':').reduce((t, x) => t * 60 + Number(x), 0);
};
export const PDF_DEFAULTS = {
  paper: 'A4', orient: 'portrait', margin: 20, font: 'sans', fontPt: 11, lineH: 1.5, indent: 8, gap: 1.2,
  bullet: 'disc', headings: 0, title: '', pageNum: true, images: true, skipEmpty: true, color: false, markdown: true, addNode: false,
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const FONTS = {
  sans: '"Apple SD Gothic Neo","Malgun Gothic","Noto Sans KR","Noto Sans CJK KR",system-ui,-apple-system,"Segoe UI",sans-serif',
  serif: '"Noto Serif KR","Noto Serif CJK KR","AppleMyungjo","Batang",Georgia,"Times New Roman",serif',
  mono: 'ui-monospace,SFMono-Regular,Menlo,Consolas,"D2Coding","Noto Sans Mono CJK KR",monospace',
};
/** 마크다운 글자 서식 → HTML (이미 HTML 이스케이프하기 전의 글). `코드` 안은 그대로 두고, 나머지에서
 *  **굵게** · __굵게__ · *기울임* · _기울임_ · ~~취소선~~ · ==형광펜== 을 바꿔요. 짝이 안 맞는 기호는 글자 그대로. */
export function mdInline(text) {
  let out = '';
  for (const [i, part] of String(text).split(/(`[^`\n]+`)/).entries()) {
    if (i % 2) { out += `<code>${esc(part.slice(1, -1))}</code>`; continue; }
    out += esc(part)
      .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/gu, '<b>$1</b>')
      .replace(/(?<![\p{L}\p{N}_])__(?=\S)(.+?)(?<=\S)__(?![\p{L}\p{N}_])/gu, '<b>$1</b>')
      .replace(/(?<![*\p{L}\p{N}])\*(?=[^\s*])(.+?)(?<=[^\s*])\*(?![*\p{L}\p{N}])/gu, '<i>$1</i>')
      .replace(/(?<![\p{L}\p{N}_])_(?=[^\s_])(.+?)(?<=[^\s_])_(?![\p{L}\p{N}_])/gu, '<i>$1</i>')
      .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, '<s>$1</s>')
      .replace(/==(?=\S)(.+?)(?<=\S)==/g, (_, x) => {
        const c = HL_COLOR_RE.exec(x), hex = hlHex(c ? c[1] : 'yellow');
        return `<mark style="background:${hex}${hlDark(hex) ? ';color:#fff' : ''}">${c ? x.slice(c[0].length) : x}</mark>`;
      });
  }
  return out;
}
/** 항목 한 줄의 마크다운 블록 표시: "# 제목"(1~6) · "> 인용" · "---" 구분선 · "[ ] / [x] 할 일" → {kind, level, text} */
export function mdBlock(content) {
  const c = String(content);
  if (c.includes('\n')) return { kind: 'p', text: c };
  let m;
  if ((m = /^(#{1,6})\s+(.*)$/.exec(c))) return { kind: 'h', level: m[1].length, text: m[2] };
  if ((m = /^>\s?(.*)$/.exec(c))) return { kind: 'quote', text: m[1] };
  if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(c)) return { kind: 'hr', text: '' };
  if ((m = /^(?:[-*+]\s+)?\[([ xX])\]\s+(.*)$/.exec(c))) return { kind: 'p', text: `${m[1] === ' ' ? '☐' : '☑'} ${m[2]}` };
  return { kind: 'p', text: c };
}
/** items: [{content, children:[…]}] (내보내기 JSON 그대로). 반환: 완성된 HTML 문서 문자열 */
export function buildPdfHtml(items, o = {}) {
  o = { ...PDF_DEFAULTS, ...o };
  const num = (v, d, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(+v) ? +v : d));
  const margin = num(o.margin, 20, 0, 60), fontPt = num(o.fontPt, 11, 6, 40), lineH = num(o.lineH, 1.5, 1, 3), indent = num(o.indent, 8, 0, 30), gap = num(o.gap, 1.2, 0, 10);
  const paper = ['A4', 'A3', 'A5', 'Letter', 'Legal'].includes(o.paper) ? o.paper : 'A4';
  const orient = o.orient === 'landscape' ? 'landscape' : 'portrait';
  const headings = Math.round(num(o.headings, 0, 0, 6)); // 위에서부터 몇 단계를 제목(h1 ~ h6)으로 강조할지
  const lines = [];
  const txt = o.markdown ? mdInline : esc; // 마크다운 서식을 켜면 **굵게** 등을 서식으로
  const seg = (t) => { // 글자 조각: [글자](주소)는 링크로, 나머지는 안전하게
    let o2 = '', at = 0;
    for (const l of mdLinks(t)) { o2 += txt(t.slice(at, l.index)) + `<a href="${esc(l.url)}">${txt(l.label)}</a>`; at = l.end; }
    return o2 + txt(t.slice(at));
  };
  const inline = (text) => {
    let out = '', last = 0;
    for (const m of String(text).matchAll(FILE_RE)) {
      out += seg(text.slice(last, m.index));
      last = m.index + m[0].length;
      const kind = fileKind(m[4]);
      if (kind === 'image' && o.images) out += `<img src="${esc(m[3])}" alt="${esc(m[2])}">`;
      else out += `<span class="att">${kind === 'pdf' ? 'PDF' : kind === 'video' ? '동영상' : kind === 'audio' ? '오디오' : '이미지'}: ${esc(m[2] || m[3])}</span>`;
    }
    return out + seg(text.slice(last));
  };
  const walk = (list, depth, prefix) => {
    let i = 0;
    for (const n of list) {
      const content = n.content ?? '';
      if (o.skipEmpty && !content.trim() && !(n.children || []).length) continue;
      i++;
      const blk = o.markdown ? mdBlock(content) : { kind: 'p', text: content };
      const ml = `margin-left:${(depth * indent).toFixed(1)}mm`;
      if (blk.kind === 'hr') { lines.push(`<div class="n hr" style="${ml}"><hr></div>`); i--; }
      else {
        const hl = blk.kind === 'h' ? blk.level : depth < headings ? depth + 1 : 0; // "# 제목"이 먼저, 아니면 1단계 → h1, 2단계 → h2 … 6단계 → h6
        const label = o.bullet === 'number' ? `${prefix}${i}.` : hl ? '' : o.bullet === 'dash' ? '–' : o.bullet === 'disc' ? '•' : ''; // 제목에는 •·– 를 붙이지 않아요 (번호는 유지)
        const body = inline(blk.text) || '&nbsp;';
        const tag = hl ? `<h${hl} class="t">${body}</h${hl}>` : `<span class="t">${body}</span>`;
        lines.push(`<div class="n${hl ? ` h h${hl}` : ''}${blk.kind === 'quote' ? ' q' : ''}" style="${ml}">${label ? `<span class="b">${esc(label)}</span>` : ''}${tag}</div>`);
      }
      if (n.children?.length) walk(n.children, depth + 1, o.bullet === 'number' ? `${prefix}${i}.` : '');
    }
  };
  walk(items, 0, '');
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${esc(o.title || 'Outline')}</title><style>
@page { size: ${paper} ${orient}; margin: ${margin}mm;${o.pageNum ? ' @bottom-center { content: counter(page) " / " counter(pages); font: 9pt sans-serif; color: #888; }' : ''} }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #fff; }
body { font-family: ${FONTS[o.font] || FONTS.sans}; font-size: ${fontPt}pt; line-height: ${lineH}; color: ${o.color ? '#000' : '#111'}; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
h1.doc { font-size: ${(fontPt * 2).toFixed(1)}pt; line-height: 1.25; margin: 0 0 ${(fontPt * 1.1).toFixed(1)}pt; break-after: avoid; }
.n.h { align-items: baseline; break-after: avoid; }
.n.h .t { margin: 0; line-height: 1.3; font-weight: 700; color: #000; }
.n.h1 { margin-top: ${(gap * 2 + 3).toFixed(1)}mm; } .n.h1 .t { font-size: ${(fontPt * 1.6).toFixed(1)}pt; }
.n.h2 { margin-top: ${(gap * 1.5 + 2).toFixed(1)}mm; } .n.h2 .t { font-size: ${(fontPt * 1.3).toFixed(1)}pt; }
.n.h3 { margin-top: ${(gap + 1).toFixed(1)}mm; } .n.h3 .t { font-size: ${(fontPt * 1.12).toFixed(1)}pt; }
.n.h4 { margin-top: ${(gap + .6).toFixed(1)}mm; } .n.h4 .t { font-size: ${(fontPt * 1.04).toFixed(1)}pt; }
.n.h5 .t { font-size: ${fontPt}pt; } .n.h6 .t { font-size: ${fontPt}pt; font-weight: 600; color: #333; }
.n.h1 { border-bottom: .3mm solid #ddd; padding-bottom: .8mm; }
.n.h .b { color: #000; font-weight: 700; }
body > .n.h:first-child, h1.doc + .n.h { margin-top: 0; }
.n { display: flex; gap: .55em; margin-bottom: ${gap}mm; break-inside: avoid; }
.b { flex: none; min-width: 1.1em; color: #666; text-align: right; }
.t { flex: 1; min-width: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
img { display: block; max-width: 100%; max-height: 150mm; margin: 1mm 0; break-inside: avoid; object-fit: contain; }
.n.q .t { border-left: .8mm solid #ccc; padding-left: 2.5mm; color: #444; }
.n.hr hr { flex: 1; border: 0; border-top: .3mm solid #bbb; margin: 1.5mm 0; }
code { font-family: ${FONTS.mono}; font-size: .9em; background: #f1f1f1; border-radius: 1mm; padding: 0 1mm; }
mark { color: inherit; padding: 0 .3mm; border-radius: .6mm; }
.att { color: #555; font-size: .9em; border: .3mm solid #bbb; border-radius: 1.2mm; padding: 0 1.5mm; }
</style></head><body>${o.title ? `<h1 class="doc">${esc(o.title)}</h1>` : ''}${lines.join('\n')}</body></html>`;
}


/** 붙여넣기: 클립보드의 HTML에 있는 링크(<a href>)를 일반 글 속의 [글자](주소) 로 바꿔요. 구조(들여쓰기)는 text/plain 그대로 쓰고
 *  링크 글자만 순서대로 찾아 바꾸므로, 못 찾은 링크는 건너뛰어요. 글자가 주소와 같은 링크는 주소만 남겨요. */
export function linkifyPaste(plain, html, parse = (h) => new DOMParser().parseFromString(h, 'text/html')) {
  if (!html || !/<a\s/i.test(html)) return plain;
  let doc;
  try { doc = parse(html); } catch { return plain; }
  let out = '', at = 0;
  for (const a of doc.querySelectorAll('a[href]')) {
    const href = (a.getAttribute('href') || '').trim();
    const label = (a.textContent || '').replace(/\s+/g, ' ').trim();
    if (!/^(https?:\/\/|mailto:)/i.test(href) || !label || label === href || /[\]\n]/.test(label) || /[)\s]/.test(href)) continue;
    const i = plain.indexOf(label, at);
    if (i < 0) continue;
    out += plain.slice(at, i) + `[${label}](${href})`;
    at = i + label.length;
  }
  return out + plain.slice(at);
}

/** 글 속의 [글자](https://주소) 위치들: [{index, end, label, url}] */
export const MD_LINK_RE = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/giu;
export function mdLinks(text) {
  return [...text.matchAll(MD_LINK_RE)].map((m) => ({ index: m.index, end: m.index + m[0].length, label: m[1], url: m[2] }));
}



// ---- 편집 화면의 마크다운 서식: 글자(기호 포함)는 그대로 두고, 조각마다 서식 종류만 알려줘요 ----
// 기호(**, `, # …)는 'mk' 조각으로 따로 — 화면에서 옅게 보여요. 링크·주소·첨부·태그 안은 건드리지 않아요 (주소 속 _ 등).
const MD_HINT = /[*_`~=#>-]/;
const MD_URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'）)\]]+[^\s<>"'）)\].,;:!?]/giu;
const MD_TAG_RE = /(?<![\p{L}\p{N}_])[#@][\p{L}\p{N}][\p{L}\p{N}_:-]*/gu;
/** 형광펜 색 (Gem과 같은 파스텔 6색): ==글자==는 노랑, =={green}글자== 처럼 이름, =={ff8800}글자== 처럼 헥스(3·6자리, # 없이 — #은 언제나 태그예요) */
export const HL_PALETTE = { yellow: '#fefac3', green: '#dff0cb', blue: '#d1eafd', purple: '#ded4ee', pink: '#f3cddc', orange: '#f9dec7' };
const HL_ALIAS = { red: 'pink' }; // 예전 이름
export const HL_COLOR_RE = /^\{(yellow|green|blue|purple|pink|orange|red|(?:[0-9a-fA-F]{3}){1,2})\}(?=\S)/;
/** 색 이름·헥스 → '#rrggbb' */
export const hlHex = (c) => {
  const name = HL_ALIAS[c] ?? c;
  if (HL_PALETTE[name]) return HL_PALETTE[name];
  return '#' + (c.length === 3 ? [...c].map((h) => h + h).join('') : c).toLowerCase();
};
/** 이 배경색 위에서는 흰 글자를 써야 하나 (Gem과 같은 밝기 기준) */
export function hlDark(hex) {
  const n = parseInt(hex.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.55;
}
const MD_INLINE_RE = new RegExp([
  '(`)([^`\\n]+?)(`)',
  '(\\*\\*\\*)(?=[^\\s*])(.+?)(?<=[^\\s*])(\\*\\*\\*)(?!\\*)',
  '(\\*\\*)(?=\\S)(.+?)(?<=\\S)(\\*\\*)',
  '(~~)(?=\\S)(.+?)(?<=\\S)(~~)',
  '(==)(?=\\S)(.+?)(?<=\\S)(==)',
  '(?<![\\p{L}\\p{N}_])(__)(?=\\S)(.+?)(?<=\\S)(__)(?![\\p{L}\\p{N}_])',
  '(?<![*\\p{L}\\p{N}])(\\*)(?=[^\\s*])(.+?)(?<=[^\\s*])(\\*)(?![*\\p{L}\\p{N}])',
  '(?<![\\p{L}\\p{N}_])(_)(?=[^\\s_])(.+?)(?<=[^\\s_])(_)(?![\\p{L}\\p{N}_])',
].join('|'), 'gu');
const MD_KINDS = ['code', 'b i', 'b', 's', 'hl', 'b', 'i', 'i'];
/** text → { block: 'h1'…'h6' | 'quote' | 'hr' | null, segs: [{ t, k }] } (k: '' 보통 · 'mk' 기호 · 'b' 'i' 's' 'hl' 'code'). 꾸밀 게 없으면 null.
 *  segs의 t를 이으면 언제나 원래 글과 같아요 (글자를 바꾸지 않아요) */
export function mdSegments(text) {
  const src = String(text ?? '');
  if (!MD_HINT.test(src)) return null;
  const segs = [];
  let block = null, body = src, head = '';
  let m;
  if (!src.includes('\n')) {
    if ((m = /^(#{1,6})(\s+)/.exec(src))) { block = `h${m[1].length}`; head = m[0]; }
    else if ((m = /^>\s?/.exec(src))) { block = 'quote'; head = m[0]; }
    else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(src)) return { block: 'hr', segs: [{ t: src, k: 'mk' }] };
  }
  if (head) { segs.push({ t: head, k: 'mk' }); body = src.slice(head.length); }
  const inner = mdInlineSegs(body, '');
  if (!block && !inner.some((x) => x.k)) return null;
  segs.push(...inner);
  return { block, segs };
}
/** 글자 서식 조각들 (겹친 서식은 안쪽까지: **==굵게+형광==** → k 'b hl'). 손대지 않을 자리: 첨부 표시 · [글자](주소) · 주소 · 태그
 *  헥스 색 형광펜 안의 조각에는 bg('#ff8800')가 붙어요 */
function mdInlineSegs(body, outer, bg = null) {
  const seg = (t, k) => (bg && k !== 'mk' ? { t, k, bg } : { t, k });
  const out = [];
  const keep = [];
  for (const re of [FILE_RE, MD_LINK_RE, MD_URL_RE, MD_TAG_RE]) for (const x of body.matchAll(new RegExp(re.source, re.flags))) keep.push([x.index, x.index + x[0].length]);
  const blocked = (a, b) => keep.some(([x, y]) => a < y && x < b);
  let at = 0;
  for (const x of body.matchAll(MD_INLINE_RE)) {
    const a = x.index, b = a + x[0].length;
    if (blocked(a, b)) continue;
    const g = x.slice(1).findIndex((v) => v !== undefined), kind = MD_KINDS[g / 3];
    if (a > at) out.push(seg(body.slice(at, a), outer));
    const k = outer ? `${outer} ${kind}` : kind;
    out.push({ t: x[g + 1], k: 'mk' });
    let body2 = x[g + 2], k2 = k, bg2 = bg;
    if (kind === 'hl') { // 형광펜: 색 표시가 있으면 그 색, 없으면 노랑 — 조각마다 bg로 붙어요
      const c = HL_COLOR_RE.exec(body2);
      if (c) { out.push({ t: c[0], k: 'mk' }); body2 = body2.slice(c[0].length); }
      bg2 = hlHex(c ? c[1] : 'yellow');
    }
    if (kind === 'code') out.push(seg(body2, k2));
    else out.push(...mdInlineSegs(body2, k2, bg2)); // 안쪽 서식도
    out.push({ t: x[g + 3], k: 'mk' });
    at = b;
  }
  if (at < body.length) out.push(seg(body.slice(at), outer));
  return out;
}
