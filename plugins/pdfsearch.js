// 여러 PDF에서 찾기 (pdfsearch) — 글에 붙은 모든 PDF의 글을 한 번에 찾아, 고르면 그 PDF의 그 쪽으로 가서 찾은 글을 칠해요
// 연 뒤 PDF를 차례로 읽으며(한 번 읽은 파일은 기억해요) 읽은 만큼 바로 찾아요. 대소문자 무시 · 띄어쓰기는 하나로 · '정규식'으로 정규식. ↑↓ · Enter · Esc 닫기
// 창 모양은 jump · find와 같은 부품(_palette.js) — 앱과는 api로만 (api.files.list · pdfText · showPdf)
// 그림만 있는(스캔한) PDF는 글이 없어서 찾지 못해요. 부를 때 고른 글자가 있으면 그 글자로 바로 찾아요
import { command } from './_kit.js';
import { hitRow, hitText, searchPalette } from './_palette.js';

const MAX_HITS = 500; // 이보다 많으면 여기서 멈추고 검색어를 좁히도록 안내해요

export default (api) => command(api, {
  name: 'pdfsearch', label: '여러 PDF에서 찾기 (글에 붙은 모든 PDF의 글을 찾아 그 쪽으로 — 찾은 글을 칠해요)', preload: false,
  make: (api, ui) => {
    let view = null, timer = 0;
    const pdfs = []; // [{ url, name, node, pages: ['1쪽 글', …] | null }] (읽은 것만 pages)
    const S = () => view?.s, set = (p) => view?.set(p);

    /** 첨부 목록에서 글에 붙은 PDF만 — 이름은 글에 적힌 이름 [이름](/files/…), 열 자리는 그 PDF가 든 첫 항목 */
    async function listPdfs() {
      const { files = [] } = await api.files.list();
      return files.filter((f) => f.kind === 'pdf' && f.ref_count > 0).map((f) => {
        const ref = f.refs[0], m = ref && new RegExp(`\\[([^\\]]*)\\]\\(${f.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`).exec(ref.content);
        return { url: f.url, name: (m?.[1] || f.name).replace(/\.pdf$/i, ''), node: ref?.id ?? null, pages: null };
      }).sort((a, b) => a.name.localeCompare(b.name, 'ko'));
    }

    /** 찾을 것 → RegExp (글자 그대로면 특수 문자를 이스케이프 · 띄어쓰기는 하나로) — 잘못된 정규식이면 오류 글 */
    function needleOf(q, regex) {
      const t = q.trim();
      if (!t) return null;
      try { return new RegExp(regex ? t : t.replace(/\s+/g, ' ').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'); } catch (e) { return `정규식 오류: ${e.message}`; }
    }
    /** 읽은 PDF들에서 찾기 → 결과 줄 [{ pdf, page, nth, n, segs }] — 문단 하나가 한 줄 (자르지 않고, 그 문단에서 찾은 곳은 모두 강조) · 파일 이름순 · 쪽 순
     *  nth: 그 쪽에서 이 문단의 첫 결과가 몇 번째인지 (고르면 PDF 안에서도 바로 그 결과로) · n: 이 문단에서 찾은 수 */
    function search(re) {
      const items = [];
      let count = 0;
      for (const p of pdfs) {
        if (!p.pages) continue;
        for (let k = 0; k < p.pages.length; k++) {
          const t = p.pages[k];
          let nth = 0;
          for (const para of t.split('\n')) {
            const segs = []; let last = 0, n = 0;
            for (const m of para.matchAll(re)) {
              if (!m[0]) continue; // 빈 일치(^ · a* …)는 건너뛰어요
              segs.push(para.slice(last, m.index), { hit: m[0] }); last = m.index + m[0].length; n++;
            }
            if (!n) continue;
            segs.push(para.slice(last));
            items.push({ pdf: p, page: k + 1, nth, n, segs: segs.filter((x) => x !== '') });
            nth += n; count += n;
            if (count >= MAX_HITS) return { items, count, full: true };
          }
        }
      }
      return { items, count, full: false };
    }
    function refresh() {
      const s = S(); if (!s) return;
      const re = needleOf(s.q, s.regex);
      if (typeof re === 'string') return set({ items: [], info: re, active: 0, shownQ: s.q });
      const { items, count, full } = re ? search(re) : { items: [], count: 0, full: false }, read = pdfs.filter((p) => p.pages).length, files = new Set(items.map((x) => x.pdf)).size;
      const reading = read < pdfs.length ? ` · PDF ${pdfs.length}개 중 ${read}개 읽음…` : '';
      const info = !pdfs.length ? '글에 붙은 PDF가 없어요'
        : !s.q.trim() ? `PDF ${pdfs.length}개${reading ? reading : ''}`
          : items.length ? `${count}${full ? '개 이상' : '개'} · 문단 ${items.length}개 · PDF ${files}개${full ? ` — ${MAX_HITS}개까지만, 검색어를 좁혀 보세요` : ''}${reading}`
            : `결과 없음${reading}`;
      set({ items, info, active: s.q === s.shownQ && s.regex === s.shownRx ? Math.min(s.active, Math.max(0, items.length - 1)) : 0, shownQ: s.q, shownRx: s.regex });
    }
    /** PDF를 차례로 읽어요 (네 개씩) — 하나 읽을 때마다 결과를 새로 */
    async function readAll(token) {
      let next = 0;
      const worker = async () => {
        while (next < pdfs.length && view?.token === token) {
          const p = pdfs[next++];
          if (p.pages) continue;
          p.pages = await api.files.pdfText(p.url).catch(() => []);
          if (view?.token === token) refresh();
        }
      };
      await Promise.all(Array.from({ length: 4 }, worker)); // 네 개씩 (서버에 꺼내 둔 글은 바로 와요)
    }

    function openHit(i) {
      const h = S()?.items[i]; if (!h) return;
      const q = S().q.trim(), regex = S().regex;
      view.close('go');
      api.files.showPdf(h.pdf.url, { node: h.pdf.node, page: h.page, find: q, regex, nth: h.nth });
    }
    function onKey(e) {
      const s = S();
      if (!s || e.isComposing || e.keyCode === 229) return false;
      const n = s.items.length, handled = () => { e.preventDefault(); e.stopPropagation(); return true; };
      if (e.key === 'Escape') { handled(); view.close(null); return true; }
      if (e.key === 'ArrowDown' && n) { handled(); set({ active: Math.min(n - 1, s.active + 1) }); return true; }
      if (e.key === 'ArrowUp' && n) { handled(); set({ active: Math.max(0, s.active - 1) }); return true; }
      if (e.key === 'Enter') { handled(); clearTimeout(timer); if (s.q !== s.shownQ || s.regex !== s.shownRx) refresh(); openHit(S().active); return true; }
      if (e.key === 'Tab') { e.preventDefault(); return true; }
      return false;
    }
    const body = (s, st) => searchPalette(ui, {
      q: s.q, placeholder: '여러 PDF에서 찾기',
      onType: (v) => { st({ q: v }); clearTimeout(timer); timer = setTimeout(refresh, 120); },
      regex: s.regex, onRegex: (v) => { st({ regex: v }); refresh(); },
      info: s.info, items: s.items,
      row: (h, i) => hitRow(ui, { active: i === s.active, onTap: () => openHit(i), onPoint: () => set({ active: i }), key: `${h.pdf.url}:${h.page}:${i}` },
        hitText(ui, `${h.pdf.name} · ${h.page}쪽${h.n > 1 ? ` · ${h.n}곳` : ''}`, h.segs)),
    });

    return {
      async pdfsearch(text) {
        if (view) return;
        const q = typeof text === 'string' ? text : '';
        const picked = await ui.sheet({
          size: 'palette',
          state: { q, regex: false, shownQ: null, items: [], active: 0, info: 'PDF 목록을 받는 중…' },
          task: async (s, st, close) => {
            const token = {};
            view = { s, set: st, close, token };
            if (!pdfs.length) pdfs.push(...await listPdfs().catch(() => []));
            else { // 그 사이 새로 붙인 PDF도
              const now = await listPdfs().catch(() => []), have = new Map(pdfs.map((p) => [p.url, p]));
              pdfs.splice(0, pdfs.length, ...now.map((p) => (have.has(p.url) ? { ...p, pages: have.get(p.url).pages } : p)));
            }
            if (view?.token !== token) return;
            refresh(); readAll(token);
          },
          onKey: (e) => onKey(e),
          body,
        }).finally(() => { view = null; clearTimeout(timer); });
        if (picked !== 'go') api.view.restoreFocus(); // 결과를 고르지 않고 닫으면 커서를 원래 자리로
      },
    };
  },
});
