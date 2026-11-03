// 내보내기 (export, ⌃X) — 문서(Markdown · 텍스트 · JSON · PDF — 고른 항목, 없으면 지금 화면) · 백업(전체 백업 ZIP · DB만 — 전부)
// PDF는 설정 창: 용지 · 여백 · 글자 크기 · 줄 간격 …을 정하면 실제 쪽 나눔대로 미리 보여주고, 인쇄 창(→ 'PDF로 저장') 또는 항목으로 넣기.
// 형식 바꾸기 · 인쇄용 문서 · 미리 보기 · 인쇄 · 서버 PDF는 앱이 해요 (api.export) — 이 파일은 고르는 창 · 설정
import { command } from './_kit.js';


// 설정은 이 브라우저에 기억해요 (예전과 같은 칸)
const PDF_KEY = 'outliner.pdfOpts';
const loadPdfOpts = (dflt) => { try { return { ...dflt, ...JSON.parse(localStorage.getItem(PDF_KEY) || '{}') }; } catch { return { ...dflt }; } };
const savePdfOpts = (o) => { try { localStorage.setItem(PDF_KEY, JSON.stringify(o)); } catch { /* 저장이 안 되는 환경이면 이번 한 번만 적용 */ } };
// 위쪽은 자주 바꾸는 것만, 나머지(여백 · 글꼴 · 간격 …)는 '세부 설정'에 접어 둬요 (more = true)
const PDF_FIELDS = [
  ['title', '문서 제목 (비우면 없음)', 'text'],
  ['paper', '용지', 'select', [['A4', 'A4'], ['A3', 'A3'], ['A5', 'A5'], ['Letter', 'Letter'], ['Legal', 'Legal']]],
  ['orient', '방향', 'select', [['portrait', '세로'], ['landscape', '가로']]],
  ['fontPt', '글자 크기 (pt)', 'number', { min: 6, max: 40, step: 0.5 }],
  ['headings', '단계를 제목으로', 'select', [['0', '안 함'], ['1', '1단계'], ['2', '1~2단계'], ['3', '1~3단계'], ['4', '1~4단계'], ['5', '1~5단계'], ['6', '1~6단계']]],
  ['addNode', 'PDF를 항목으로 넣기 (인쇄 창 없이)', 'check'],
  ['margin', '여백 (mm)', 'number', { min: 0, max: 60, step: 1 }, true],
  ['font', '글꼴', 'select', [['sans', '고딕'], ['serif', '명조'], ['mono', '고정폭']], true],
  ['lineH', '줄 간격 (배)', 'number', { min: 1, max: 3, step: 0.05 }, true],
  ['gap', '항목 사이 (mm)', 'number', { min: 0, max: 10, step: 0.2 }, true],
  ['indent', '들여쓰기 (mm)', 'number', { min: 0, max: 30, step: 1 }, true],
  ['bullet', '글머리', 'select', [['disc', '•'], ['dash', '–'], ['number', '1. 1.1. 번호'], ['none', '없음']], true],
  ['pageNum', '쪽 번호', 'check', null, true],
  ['images', '이미지 넣기', 'check', null, true],
  ['skipEmpty', '빈 항목 빼기', 'check', null, true],
  ['markdown', '마크다운 서식 (**굵게** · # 제목 …)', 'check', null, true],
];
async function openPdfDialog(api) {
  await api.view.flush();
  const ui = api.ui, { VStack, HStack, Grid, Text, TextField, Picker, Toggle, Disclosure, Button, Spacer } = ui;
  const PDF_DEFAULTS = api.export.pdfDefaults, scope = api.export.scope();
  const opts = loadPdfOpts(PDF_DEFAULTS);
  if (api.view.zoomId() !== null && !opts.title) opts.title = api.nodes.get(api.view.zoomId())?.content ?? '';
  const dataP = api.export.json(); // 내용은 한 번만 받아 두고, 설정이 바뀔 때마다 미리 보기를 다시 그려요
  const optsOf = (s) => Object.fromEntries(PDF_FIELDS.map(([k]) => [k, s[k]]));
  const field = (s, set, [key, label, type, extra]) => { // 설정 한 칸 (이름 = 설정 키)
    const on = (v) => set({ [key]: v });
    if (type === 'check') return Toggle(label, s[key], on).attr('data-key', key);
    const input = type === 'select' ? Picker(extra, String(s[key]), on) : TextField(s[key], on, { number: type === 'number', ...(extra || {}) });
    return VStack({ gap: 4 }, Text(label).font('callout').color('mute'), input.attr('name', key));
  };
  async function make(s, set, close) {
    const o = optsOf(s);
    savePdfOpts(o);
    set({ busy: true });
    try {
      const html = api.export.pdfHtml(await dataP, o);
      if (o.addNode) { // 인쇄 창 대신 서버(크롬)가 PDF를 만들어 첨부로 저장 → 항목으로 넣어요
        const target = scope.selected ? scope.ids.at(-1) : null;
        const name = o.title || (api.view.zoomId() !== null ? api.nodes.get(api.view.zoomId())?.content : '') || '내보내기';
        const r = await api.export.printPdf(html, name);
        if (r.error) throw new Error(r.error);
        close();
        await api.files.insert([r.markdown], target);
        return ui.toast('PDF를 항목으로 넣었어요');
      }
      close();
      await api.export.print(html);
    } catch (e) { ui.toast(`PDF를 만들지 못했어요: ${e.message}`, 4, true); set({ busy: false }); }
  }
  await ui.sheet({
    title: 'PDF로 내보내기', size: 'full',
    state: { ...opts, info: '', busy: false },
    onKey: (e, s, set, close) => { // Enter = PDF 만들기 (목록 · 펼침 단추 위에서는 빼고)
      if (e.key !== 'Enter' || e.target.tagName === 'SELECT' || e.target.tagName === 'SUMMARY' || s.busy) return false;
      e.preventDefault(); e.stopPropagation(); make(s, set, close); return true;
    },
    body: (s, set, close) => VStack({ gap: 12 },
      Text(`범위: ${scope.label} — 접힌 항목도 모두 포함해요`).font('callout').color('mute'),
      HStack({ gap: 20, align: 'top', wrap: true }, // 좁은 화면이면 미리 보기는 아래로
        VStack({ gap: 10 },
          PDF_FIELDS.filter((f) => !f[4]).map((f) => field(s, set, f)),
          Disclosure('세부 설정 (여백 · 글꼴 · 간격 · 글머리 …)', VStack({ gap: 10 }, PDF_FIELDS.filter((f) => f[4]).map((f) => field(s, set, f)))).attr('data-f', 'more'),
        ).frame({ width: 280, maxWidth: '100%' }).scroll().css({ flex: 'none', alignSelf: 'stretch' }).attr('data-f', 'form'),
        VStack({ gap: 6 },
          HStack(Text('미리 보기').font('callout').color('mute'), Spacer(), Text(s.info).font('caption').attr('data-f', 'pinfo')),
          api.export.preview({ html: async () => api.export.pdfHtml(await dataP, optsOf(s)), opts: optsOf(s), onInfo: (t) => set({ info: t }) }).fill(),
        ).grow().frame({ minWidth: 300 }).css({ alignSelf: 'stretch' }),
      ).fill(),
      HStack({ gap: 8 },
        Text(s.addNode ? (scope.selected ? '선택한 항목 아래에 PDF 항목을 넣어요' : '지금 화면 맨 아래에 PDF 항목을 넣어요') : '인쇄 창이 열리면 대상(프린터)을 "PDF로 저장"으로 고르세요').font('caption'),
        Spacer(),
        Button('기본값', () => set({ ...PDF_DEFAULTS })),
        Button('취소', () => close()),
        Button(s.busy ? '만드는 중…' : 'PDF 만들기', () => make(s, set, close)).style('primary').disabled(s.busy).attr('data-f', 'go'),
      ),
    ).fill().attr('data-f', 'pdf'),
  });
  setTimeout(api.view.restoreFocus, 120);
}

async function exportDialog(api) {
  await api.view.flush();
  const { label } = api.export.scope();
  const v = await api.ui.choose('내보내기', `**문서** — ${label}\n**백업** — 전부`, [
    { label: 'Markdown', value: 'md' }, { label: '텍스트', value: 'txt' }, { label: 'JSON', value: 'json' }, { label: 'PDF…', value: 'pdf' },
    { label: '전체 백업', value: 'all' }, { label: 'DB만', value: 'db' }, { label: '취소', value: null },
  ]);
  if (v === 'pdf') return openPdfDialog(api);
  if (v) api.export.download(v);
}

export default (api) => command(api, {
  name: 'export', keys: 'Alt+X', preload: false,
  label: '내보내기 (Markdown · 텍스트 · JSON · PDF — 선택한 항목, 없으면 지금 화면 / 백업: 전체 백업 ZIP · DB만)',
  make: (api) => ({ export: () => exportDialog(api) }),
});
