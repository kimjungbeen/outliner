import assert from 'node:assert/strict';
import { splitHighlightRegex, parseQuery, splitHighlight, parsePaste, dropZone, dropTarget, movesIntoSelf, chInsert, chRemove } from '../src/static/lib.js';

// 검색어 파서
assert.deepEqual(parseQuery('회의 "a b" -메모 -"x y" c'), { pos: ['회의', 'a b', 'c'], neg: ['메모', 'x y'], exact: ['a b', 'x y'] });
assert.deepEqual(parseQuery('   '), { pos: [], neg: [], exact: [] });
assert.deepEqual(parseQuery('-'), { pos: [], neg: [], exact: [] });
assert.deepEqual(parseQuery('"알파 베타'), { pos: ['알파 베타'], neg: [], exact: ['알파 베타'] }); // 닫지 않은 따옴표
assert.deepEqual(parseQuery('"" x'), { pos: ['x'], neg: [], exact: [] });
assert.deepEqual(splitHighlight('Hello hello', ['hello'], ['hello']).map((x) => x.hit), [false, true]); // 따옴표는 대소문자 구분
assert.deepEqual(parseQuery('#tag @x'), { pos: ['#tag', '@x'], neg: [], exact: [] });

// 하이라이트
assert.deepEqual(splitHighlight('Hello World', ['world']), [{ t: 'Hello ', hit: false }, { t: 'World', hit: true }]);
assert.deepEqual(splitHighlight('aaa', ['aa']), [{ t: 'aaa', hit: true }]);
assert.deepEqual(splitHighlight('abc', []), [{ t: 'abc', hit: false }]);
assert.deepEqual(splitHighlight('가나다 회의 라마', ['회의', '나']).map((x) => x.hit), [false, true, false, true, false]);
assert.equal(splitHighlight('x', ['']).length, 1);

// 붙여넣기
assert.deepEqual(parsePaste('- a\n  - b\n\t- c\n- d'), [
  { depth: 0, text: 'a' }, { depth: 1, text: 'b' }, { depth: 2, text: 'c' }, { depth: 0, text: 'd' }]);
assert.equal(parsePaste('  \n\n').length, 0);

// 드롭 위치
assert.equal(dropZone(101, 100, 30), 'before');
assert.equal(dropZone(115, 100, 30), 'child');
assert.equal(dropZone(129, 100, 30), 'after');
const closed = { id: 5, parent_id: 1, open: false, firstChild: null };
const open = { id: 5, parent_id: 1, open: true, firstChild: 9 };
assert.deepEqual(dropTarget('before', open), { parent: 1, pos: { before: 5 } });
assert.deepEqual(dropTarget('after', closed), { parent: 1, pos: { after: 5 } });
assert.deepEqual(dropTarget('after', open), { parent: 5, pos: { before: 9 } });
assert.deepEqual(dropTarget('child', closed), { parent: 5, pos: {} });
assert.deepEqual(dropTarget('child', open), { parent: 5, pos: { before: 9 } });

// 자기 하위로 이동 방지
const nodes = new Map([[1, { parent_id: null }], [2, { parent_id: 1 }], [3, { parent_id: 2 }], [4, { parent_id: null }]]);
assert.equal(movesIntoSelf(nodes, [1], 3), true);
assert.equal(movesIntoSelf(nodes, [2], 2), true);
assert.equal(movesIntoSelf(nodes, [3], 1), false);
assert.equal(movesIntoSelf(nodes, [1], null), false);
assert.equal(movesIntoSelf(nodes, [4, 2], 3), true);

// 자식 목록 조작 (부분 로딩 포함)
let c = { ids: [1, 2, 3], total: 3 };
assert.equal(chInsert(c, 9, 1), true); assert.deepEqual(c, { ids: [1, 9, 2, 3], total: 4 });
assert.equal(chInsert(c, 8, null), true); assert.deepEqual(c, { ids: [1, 9, 2, 3, 8], total: 5 });
c = { ids: [1, 2, 3], total: 10 };                       // 앞 3개만 불러온 상태
assert.equal(chInsert(c, 9, null), false); assert.deepEqual(c, { ids: [1, 2, 3], total: 11 }); // 끝에 추가 → 불러온 구간 밖
assert.equal(chInsert(c, 8, 3), true); assert.deepEqual(c.ids, [1, 2, 3, 8]); // 불러온 구간 바로 뒤(번째로 지정) → 구간에 붙임 (서버도 같은 자리)
assert.equal(chInsert(c, 7, 0), true); assert.deepEqual(c.ids, [7, 1, 2, 3, 8]);
assert.equal(chRemove(c, 2), true); assert.deepEqual(c.ids, [7, 1, 3, 8]);
assert.equal(chRemove(c, 999), false);
assert.equal(chInsert(undefined, 1, 0), false);
assert.deepEqual(splitHighlightRegex('a12b345', /\d+/i), [{ t: 'a', hit: false }, { t: '12', hit: true }, { t: 'b', hit: false }, { t: '345', hit: true }]);
assert.deepEqual(splitHighlightRegex('abc', /x*/), [{ t: 'abc', hit: false }]);
console.log('lib.test.mjs 통과');

// ---- 첨부 · PDF 내보내기 ----
{
  const { fileTokens, buildPdfHtml } = await import('../src/static/lib.js');
  const tk = fileTokens('앞 ![사진](/files/0123456789abcdef01234567.png) 뒤 [문서](/files/0123456789abcdef01234568.pdf) [영상](/files/0123456789abcdef01234569.mp4)');
  assert.deepEqual(tk.map((t) => t.kind), ['image', 'pdf', 'video']);
  assert.equal(fileTokens('[x](http://a/files/1.png)').length, 0);
  const html = buildPdfHtml([{ content: '가<b>', children: [{ content: '나 ![p](/files/0123456789abcdef01234567.png)', children: [] }] }, { content: '', children: [] }], { fontPt: 14, margin: 15, bullet: 'number', title: '제목' });
  assert.ok(html.includes('font-size: 14pt') && html.includes('margin: 15mm') && html.includes('size: A4 portrait'));
  assert.ok(html.includes('가&lt;b&gt;') && html.includes('<img src="/files/0123456789abcdef01234567.png"'));
  assert.ok(html.includes('1.1.') && html.includes('<h1 class="doc">제목</h1>'));
  assert.equal((html.match(/class="n"/g) || []).length, 2, '빈 항목은 건너뜀');
  const html2 = buildPdfHtml([{ content: 'x' }], { images: false, paper: 'nope', margin: 9999 });
  assert.ok(html2.includes('size: A4') && html2.includes('margin: 60mm'), '범위를 벗어난 값은 보정');
  const tree = [{ content: '장', children: [{ content: '절', children: [{ content: '항', children: [{ content: '본문', children: [] }] }] }] }];
  const h0 = buildPdfHtml(tree, {});
  assert.ok(!/<h[1-3] class="t"/.test(h0), '기본은 제목 강조 없음');
  const h2 = buildPdfHtml(tree, { headings: '2' });
  assert.ok(h2.includes('<h1 class="t">장</h1>') && h2.includes('<h2 class="t">절</h2>') && h2.includes('<span class="t">항</span>'), '2단계까지 h1·h2');
  assert.ok(!h2.includes('<span class="b">•</span><h1'), '제목에는 • 없음');
  const h3 = buildPdfHtml(tree, { headings: 3, bullet: 'number' });
  assert.ok(h3.includes('<span class="b">1.1.1.</span><h3 class="t">항</h3>') && h3.includes('<span class="t">본문</span>'), '3단계 + 번호 유지');
  const h6 = buildPdfHtml(tree, { headings: 6 });
  assert.ok(h6.includes('<h4 class="t">본문</h4>') && h6.includes('.n.h4'), '6단계까지: 4단계 → h4');
  assert.ok(buildPdfHtml(tree, { headings: 9 }).includes('<h4 class="t">본문</h4>'), '6보다 크면 6으로');
  console.log('첨부/PDF 단위 검사 통과');
}

// ---- 붙여넣기 링크 / 마크다운 링크 ----
import { linkifyPaste, mdLinks, buildPdfHtml as _pdf } from '../src/static/lib.js';
const fakeDoc = (links) => ({ querySelectorAll: () => links.map(([label, href]) => ({ getAttribute: () => href, textContent: label })) });
const lp = (plain, links) => linkifyPaste(plain, '<a href="x">', () => fakeDoc(links));
assert.equal(lp('문서 보기와 설명', [['문서 보기', 'https://a.com/x?y=1#z']]), '[문서 보기](https://a.com/x?y=1#z)와 설명');
assert.equal(lp('같은 글 같은 글', [['같은 글', 'https://a.com'], ['같은 글', 'https://b.com']]), '[같은 글](https://a.com) [같은 글](https://b.com)'); // 같은 글자는 순서대로
assert.equal(lp('주소 https://a.com', [['https://a.com', 'https://a.com']]), '주소 https://a.com'); // 글자 = 주소면 그대로
assert.equal(lp('못 찾음', [['없는 글', 'https://a.com']]), '못 찾음');
assert.equal(lp('위험', [['위험', 'javascript:alert(1)']]), '위험'); // http/mailto 외는 무시
assert.equal(lp('괄호', [['괄호', 'https://a.com/(x)']]), '괄호'); // 주소에 ) 가 있으면 깨지니 무시
assert.equal(linkifyPaste('그냥 글', ''), '그냥 글');
assert.equal(linkifyPaste('그냥 글', '<p>링크 없음</p>'), '그냥 글');
assert.deepEqual(mdLinks('앞 [a b](https://x.com/p#q) 뒤 [x](/files/a.png) [ ] 체크'), [{ index: 2, end: 26, label: 'a b', url: 'https://x.com/p#q' }]);
assert.deepEqual(mdLinks('![이미지](https://x.com/a.png)').length, 1); // (첨부 표시는 앱이 먼저 따로 처리해요)
const pdfHtml = _pdf([{ content: '링크 [문서](https://a.com/?a=1&b=2) 와 <b>', children: [] }]);
assert.ok(pdfHtml.includes('<a href="https://a.com/?a=1&amp;b=2">문서</a>') && pdfHtml.includes('&lt;b&gt;'), 'PDF에서 링크 변환 + 이스케이프');
console.log('링크 단위 검사 통과');

// ---- PDF 내보내기: 마크다운 서식 ----
{
  const { mdInline, mdBlock, buildPdfHtml } = await import('../src/static/lib.js');
  assert.equal(mdInline('**굵게** *기울임* _이것_ `a*b*` ~~취소~~ ==형광=='), '<b>굵게</b> <i>기울임</i> <i>이것</i> <code>a*b*</code> <s>취소</s> <mark style="background:#fefac3">형광</mark>');
  assert.equal(mdInline('snake_case_name 2*3*4 ** 띄움 ** <b>'), 'snake_case_name 2*3*4 ** 띄움 ** &lt;b&gt;', '짝 없는 기호·낱말 속 _·* 는 그대로');
  assert.deepEqual(mdBlock('## 제목'), { kind: 'h', level: 2, text: '제목' });
  assert.equal(mdBlock('#벧전:5:8').kind, 'p', '# 뒤에 띄어쓰기가 없으면 태그');
  assert.equal(mdBlock('> 인용').kind, 'quote');
  assert.equal(mdBlock('---').kind, 'hr');
  assert.equal(mdBlock('- [x] 끝').text, '☑ 끝');
  const h = buildPdfHtml([{ content: '# 큰 제목', children: [{ content: '**굵게** [링크 *기울*](https://x.com)' }, { content: '---' }, { content: '> 인용' }] }]);
  assert.ok(h.includes('<h1 class="t">큰 제목</h1>') && h.includes('<b>굵게</b> <a href="https://x.com">링크 <i>기울</i></a>') && h.includes('<hr>') && h.includes('class="n q"'));
  assert.ok(buildPdfHtml([{ content: '**x**' }], { markdown: false }).includes('**x**'), '끄면 글자 그대로');
  console.log('PDF 마크다운 단위 검사 통과');
}

// ---- 편집 화면 마크다운 조각 ----
{
  const { mdSegments } = await import('../src/static/lib.js');
  const join = (r) => r.segs.map((x) => x.t).join('');
  const r1 = mdSegments('**굵게** *기울* `a*b*` ~~취소~~ ==형광==');
  assert.equal(join(r1), '**굵게** *기울* `a*b*` ~~취소~~ ==형광==', '글자는 그대로');
  assert.deepEqual(r1.segs.filter((x) => x.k && x.k !== 'mk').map((x) => x.k + ':' + x.t), ['b:굵게', 'i:기울', 'code:a*b*', 's:취소', 'hl:형광']);
  assert.equal(mdSegments('# 제목 **강조**').block, 'h1');
  assert.equal(mdSegments('> 인용').block, 'quote');
  assert.equal(mdSegments('---').block, 'hr');
  assert.equal(mdSegments('평범한 글 snake_case 가_나_다 #태그_이름 2*3*4'), null, '낱말 속 _·* 와 태그는 그대로');
  const r2 = mdSegments('https://a.com/foo_bar_baz 와 [링크 *x*](https://x.com) 뒤 _기울_');
  assert.deepEqual(r2.segs.filter((x) => x.k === 'i').map((x) => x.t), ['기울'], '주소·링크 안은 건드리지 않음');
  console.log('편집 마크다운 단위 검사 통과');
}

// ---- 형광펜 색 (이름 · 헥스) ----
{
  const { mdSegments, mdInline } = await import('../src/static/lib.js');
  const r = mdSegments('=={red}빨강== =={ff8800}주황== #태그');
  assert.ok(r.segs.some((x) => x.k === 'hl' && x.bg === '#f3cddc' && x.t === '빨강'), '예전 red는 분홍(Gem 팔레트)으로');
  assert.ok(r.segs.some((x) => x.k === 'hl' && x.bg === '#ff8800' && x.t === '주황'));
  assert.ok(mdSegments('==노랑==').segs.some((x) => x.bg === '#fefac3'), '색 표시가 없으면 노랑');
  assert.equal(r.segs.map((x) => x.t).join(''), '=={red}빨강== =={ff8800}주황== #태그');
  assert.ok(!(mdSegments('=={#ff8800}태그==')?.segs ?? []).some((x) => x.bg), '#이 붙으면 태그로 봐요 (색 아님)');
  const r2 = mdSegments('=={ff8800}샵없이== =={0F0}짧게==');
  assert.deepEqual(r2.segs.filter((x) => x.bg).map((x) => x.bg + ':' + x.t), ['#ff8800:샵없이', '#00ff00:짧게'], '# 없는 헥스도');
  assert.equal(mdInline('=={ff8800}주황=='), '<mark style="background:#ff8800">주황</mark>');
  assert.equal(mdInline('=={333}어두움=='), '<mark style="background:#333333;color:#fff">어두움</mark>', '어두운 색이면 흰 글자');
  console.log('형광펜 색 단위 검사 통과');
}

// 재생 시간 (오디오 · 영상 조작부 · 북마크)
{
  const { fmtTime, parseTime } = await import('../src/static/lib.js');
  assert.equal(fmtTime(12.5), '0:12'); assert.equal(fmtTime(3723), '1:02:03'); assert.equal(fmtTime(NaN), '0:00');
  assert.equal(parseTime('1:23'), 83); assert.equal(parseTime('1:02:03'), 3723); assert.equal(parseTime('95'), 95);
  assert.equal(parseTime('1분 30초'), 90); assert.equal(parseTime('2시간'), 7200); assert.equal(parseTime('abc'), null);
  console.log('재생 시간 단위 검사 통과');
}
