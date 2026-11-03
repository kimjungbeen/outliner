// 노트 — 명령 이름 note (기본 단축키 없음 — ⌘/에서 지정)
// 커서 항목 아래에 빈 노트 PDF(줄 노트 · 모눈 · 점 · 빈 종이, 원하는 쪽 수)를 새 항목으로 넣고, 바로 화면 가득 · 펜으로 쓰게 열어요.
// 펜 · 형광펜 · 글자 · 메모는 PDF 주석으로 남아 저장한 뒤에도 다시 편집(연필)해서 지우거나 고칠 수 있어요.
// 쪽이 모자라면 편집 막대의 '쪽 추가'로 같은 종이를 맨 뒤에 더 붙여요.
import { command } from './_kit.js';

const PAPERS = [['lined', '줄 노트'], ['grid', '모눈'], ['dot', '점'], ['blank', '빈 종이']];
const SIZES = [['portrait', 'A4 세로'], ['landscape', 'A4 가로'], ['square', '정사각']];

export default (api) => command(api, {
  name: 'note', preload: false,
  label: '노트 만들기 (커서 항목 아래에 줄 · 모눈 · 점 노트 PDF를 넣고 바로 펜으로)',
  make: (api, ui) => ({ note: () => note(api, ui) }),
});

async function note(api, ui) {
  const last = (await api.storage.get('last').catch(() => null)) || {};
  const f = await ui.form({
    title: '노트 만들기', submit: '만들기', focus: 'submit',
    values: { paper: PAPERS.some(([v]) => v === last.paper) ? last.paper : 'lined', size: SIZES.some(([v]) => v === last.size) ? last.size : 'portrait', pages: last.pages || 5 },
    fields: [
      { key: 'paper', label: '종이', type: 'seg', options: PAPERS },
      { key: 'size', label: '모양', type: 'seg', options: SIZES },
      { key: 'pages', label: '쪽 수', type: 'number', min: 1, max: 200, step: 1 },
    ],
  });
  if (!f) return;
  const { paper, size } = f, pages = Math.max(1, Math.min(200, Math.round(f.pages) || 1));
  api.storage.set('last', { paper, size, pages }).catch(() => {});
  try {
    await api.view.flush();
    const r = await api.files.upload(new Blob([await api.files.notePdf({ paper, size, pages })], { type: 'application/pdf' }), `노트 ${new Date().toLocaleDateString('sv-SE')}.pdf`);
    await api.files.insert([r.markdown]);
    await api.files.openPdf(r.url, { edit: true });
  } catch (e) { api.ui.toast(`노트를 만들지 못했어요: ${e.message}`, 4); }
}
