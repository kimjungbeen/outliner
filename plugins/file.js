// 첨부 파일 관리 file (예전 af): 목록 · 골라서 내려받기 · 전체 ZIP · 삭제 · 항목으로 넣기 · 안 쓰는 파일 정리 · 폴더 열기 (예전 afx · afo · afz를 합쳤어요)
// 내려받을 때 북마크 · 마크업은 파일 안에 담겨요
import { command } from './_kit.js';
function make(api, ui, t) {
  const KIND = { image: '이미지', video: '영상', audio: '오디오', pdf: 'PDF' };
  const size = (b) => (b >= 1073741824 ? `${(b / 1073741824).toFixed(1)} GB` : b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
  const date = (s) => new Date(s * 1000).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' });

  async function cleanUnused(list) {
    const orphans = (list ?? (await api.files.list()).files).filter((f) => !f.ref_count && !f.ink_base); // 마크업 원본은 남겨요 (다시 고칠 때 필요)
    if (!orphans.length) { ui.toast('안 쓰는 파일이 없어요', 2); return false; }
    const total = orphans.reduce((s, f) => s + f.size, 0);
    const ok = await ui.confirmDelete('안 쓰는 첨부 정리', `어떤 항목의 글에도 적혀 있지 않은 파일 **${orphans.length}개** (${size(total)})를 컴퓨터에서 **완전히 삭제**할까요? 되돌릴 수 없어요.`, '삭제');
    if (!ok) return false;
    const r = await api.files.remove({ orphans: true });
    ui.toast(`${r.deleted.length}개 삭제 · ${size(r.freed)} 확보`, 3);
    return true;
  }

  const SORTS = [['mtime', '날짜'], ['size', '크기'], ['name', '이름'], ['ref_count', '쓰는 곳']];
  const plainText = (s) => s.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').trim();
  const { VStack, HStack, Text, Button, Checkbox, Link, Image, Badge, Spacer } = ui;

  /** 파일 한 줄: 체크 · 그림(또는 종류) · 이름(새 탭) · 종류 · 크기 · 날짜 · 쓰는 곳 */
  function fileRow(f, s, set, close) {
    const on = s.chosen.includes(f.name), open = s.opened.includes(f.name);
    const toggle = (list, x) => (list.includes(x) ? list.filter((y) => y !== x) : [...list, x]);
    let side;
    if (f.ref_count === 1) side = Button('쓰는 곳 →', () => close({ go: f.refs[0].parent_id, id: f.refs[0].id })).style('plain').size('sm').tooltip('이 파일을 쓰는 항목으로 이동');
    else if (f.ref_count > 1) side = Button(`쓰는 곳 ${f.ref_count} ${open ? '▴' : '▾'}`, () => { set({ opened: toggle(s.opened, f.name) }); if (!s.refs[f.name]) loadRefs(f, set, s); })
      .style('plain').size('sm').selected(open).tooltip('이 파일을 쓰는 항목 모두 보기'); // 여러 곳에서 쓰면 줄 아래에 전부 → 고르면 그 항목으로
    else if (f.ink_base) side = Badge('마크업 원본').tooltip('마크업한 이미지의 원본이에요 — 마크업을 다시 고칠 때 써요 (정리에서 빠져요)');
    else side = Badge('안 쓰는 파일');
    const row = HStack({ gap: 12 },
      Checkbox(on, () => set({ chosen: toggle(s.chosen, f.name) }), '선택 (내려받기 · 삭제 · 항목으로 넣기)'),
      (f.kind === 'image' ? Image(f.url) : Text(KIND[f.kind]).font('caption').align('center')).frame({ width: 44, height: 44 }).radius('sm').background('fill').css({ objectFit: 'cover', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }),
      VStack({ gap: 2 }, Link(plainText(f.refs[0]?.content || '') || f.name, f.url).tooltip('새 탭에서 열기'), Text(`${KIND[f.kind]} · ${size(f.size)} · ${date(f.mtime)}`).font('caption')).grow(),
      side,
    ).padding({ x: 10, y: 7 }).radius('md').background(on ? 'fill' : 'transparent').onTap(() => set({ chosen: toggle(s.chosen, f.name) }))
      .attr('data-f', 'file-row').attr('data-unused', !f.ref_count && !f.ink_base);
    if (!open) return row.key(f.name);
    const refs = s.refs[f.name];
    return VStack({ gap: 2 }, row,
      VStack({ gap: 2 }, !refs ? Text('불러오는 중…').font('caption') : refs.error ? Text('불러오지 못했어요').font('caption')
        : refs.map((r) => Button(VStack({ gap: 0, align: 'leading' }, Text(['홈', ...r.path.map((p) => p.content || '(빈 항목)')].slice(-3).join(' › ')).font('caption'), Text(plainText(r.content) || '(빈 항목)').lines(1)),
          () => close({ go: r.parent_id, id: r.id })).style('plain').css({ justifyContent: 'flex-start', textAlign: 'left', width: '100%' }))).padding({ left: 66 }),
    ).key(f.name);
  }
  const loadRefs = (f, set, s) => api.files.refs(f.name).then((r) => set({ refs: { ...s.refs, [f.name]: r.refs || [] } })).catch(() => set({ refs: { ...s.refs, [f.name]: { error: true } } }));

  async function manage() {
    for (;;) {
      const data = await api.files.list();
      const files = data.files;
      let st = null; // 창의 상태 (닫은 뒤 고른 파일을 봐요)
      const act = await ui.sheet({
        task: (s) => { st = s; },
        title: '첨부 파일', size: 'wide',
        state: { sortKey: 'mtime', desc: true, chosen: [], opened: [], refs: {} },
        body: (s, set, close) => {
          const sub = Text(`${files.length}개 · ${size(data.total_size)}${data.missing.length ? ` · 파일이 없는 참조 ${data.missing.length}개` : ''}`).font('caption').tooltip(data.folder);
          if (!files.length) return VStack({ gap: 12 }, sub, Text('첨부한 파일이 없어요. 파일을 항목에 끌어다 놓거나 붙여넣어 보세요.').color('mute').align('center').padding(32),
            HStack({ gap: 6, justify: 'trailing' }, Button('폴더 열기', () => close('open')).style('plain'), Button('닫기', () => close('close')).style('primary')));
          const rows = [...files].sort((a, b) => (s.sortKey === 'name' ? a.name.localeCompare(b.name) : a[s.sortKey] - b[s.sortKey]) * (s.desc ? -1 : 1));
          const picked = files.filter((f) => s.chosen.includes(f.name)), bytes = picked.reduce((t, f) => t + f.size, 0);
          const sortBy = (key) => set(s.sortKey === key ? { desc: !s.desc } : { sortKey: key, desc: key !== 'name' });
          return VStack({ gap: 10 },
            sub,
            HStack({ gap: 4, wrap: true }, // 알약 탭(정렬) · 전체 선택
              SORTS.map(([key, label]) => Button(s.sortKey === key ? `${label} ${s.desc ? '↓' : '↑'}` : label, () => sortBy(key)).style('tab').selected(s.sortKey === key)),
              Spacer(),
              Button(picked.length === files.length ? '선택 해제' : '전체 선택', () => set({ chosen: picked.length === files.length ? [] : files.map((f) => f.name) })).style('plain').size('sm'),
            ),
            VStack({ gap: 2 }, rows.map((f) => fileRow(f, s, set, close))).scroll('55vh'),
            // 아래 막대: 고른 게 없으면 정리 · 백업 같은 조용한 단추, 고르면 그 파일들에 할 일 (내려받기만 강조)
            HStack({ gap: 6, wrap: true },
              Text(picked.length ? `${picked.length}개 선택 · ${size(bytes)}` : '').font('caption'), Spacer(),
              picked.length
                ? [Button('삭제', () => close('del')).style('plain').color('danger').attr('data-f', 'del'), Button('항목으로 넣기', () => close('add')).style('plain'), Button('내려받기', () => close('down')).style('primary')]
                : [Button('안 쓰는 파일 정리', () => close('clean')).style('plain'), Button('첨부 전체 ZIP', () => close('zip')).style('plain'), Button('폴더 열기', () => close('open')).style('plain'), Button('닫기', () => close('close')).style('primary')],
            ).attr('data-f', 'foot'),
          );
        },
      });
      const chosen = new Set(st?.chosen ?? []);
      if (act && typeof act === 'object' && act.go !== undefined) {
        await api.view.zoomTo(act.go ?? null);
        setTimeout(() => api.view.highlight([act.id]), 600);
        return;
      }
      if (act === 'open') { const r = await api.files.revealFolder(); if (r.error) ui.toast(`폴더를 열지 못했어요: ${r.folder}`, 4, true); return; }
      if (act === 'zip') { await api.files.download('all'); return; } // 전체를 ZIP 하나로 (북마크 · 마크업은 파일 안에)
      if (act === 'down') { // 하나면 그 파일, 여럿이면 ZIP 하나로 (글에 적힌 이름으로 저장돼요)
        if (!chosen.size) { ui.toast('먼저 내려받을 파일을 선택하세요', 2.5, true); continue; }
        await api.files.download([...chosen]); // 하나면 그 파일 · 여럿이면 ZIP (북마크 · 마크업은 파일 안에)
        return;
      }
      if (act === 'clean') { if (await cleanUnused(files)) continue; return; }
      if (act === 'add') {
        if (!chosen.size) { ui.toast('먼저 항목으로 넣을 파일을 선택하세요', 2.5, true); continue; }
        const label = (f) => f.refs[0]?.content?.match(/\[([^\]]*)\]\(/)?.[1] || KIND[f.kind];
        const tokens = files.filter((f) => chosen.has(f.name)).map((f) => `${f.kind === 'image' ? '!' : ''}[${label(f)}](${f.url})`);
        const n = await api.files.insert(tokens);
        ui.toast(`${n}개 파일을 항목으로 넣었어요`, 2.5);
        return;
      }
      if (act === 'del') {
        if (!chosen.size) { ui.toast('먼저 삭제할 파일을 선택하세요', 2.5, true); continue; }
        const inUse = files.filter((f) => chosen.has(f.name) && f.ref_count).length;
        const ok = await ui.confirmDelete('선택한 첨부 삭제', `**${chosen.size}개** 파일을 컴퓨터에서 완전히 삭제할까요?${inUse ? `\n\n그중 **${inUse}개**는 아직 항목에서 쓰고 있어서, 삭제하면 그 항목의 미리보기가 깨져요.` : ''}`, '삭제');
        if (ok) {
          const r = await api.files.remove({ names: [...chosen], force: true });
          ui.toast(`${r.deleted.length}개 삭제 · ${size(r.freed)} 확보`, 3);
          await api.view.refresh();
        }
        continue;
      }
      return;
    }
  }

  return {
    file: manage, // 안 쓰는 파일 정리 · 폴더 열기 · 전체 ZIP은 이 창의 단추로 (예전 af · afx · afo · afz)
  };
}

export default (api) => command(api, { name: 'file', label: '첨부 파일 관리 (목록 · 내려받기 · 항목으로 넣기 · 삭제 · 안 쓰는 파일 정리 · 폴더 열기)', preload: false, make });
