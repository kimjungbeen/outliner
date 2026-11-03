// PDF 미리 보기 (앱) — 인쇄용 문서를 틀(iframe) 안에 그려 쪽 나눔대로 종이처럼 보여줘요. 플러그인은 api.export.preview()로 뷰만 받아요
import { Embed } from './view/view.js';

const PAPER_MM = { A4: [210, 297], A3: [297, 420], A5: [148, 210], Letter: [215.9, 279.4], Legal: [215.9, 355.6] };
const PREVIEW_PAGES = 30;
/** 미리 보기: 인쇄용 문서를 틀 안에 그린 뒤, 항목을 쪽 높이만큼씩 나눠 종이처럼 보여줘요 (인쇄의 쪽 나눔과 거의 같아요) */
async function renderPdfPreview(fr, html, o, info) {
  const mm = 96 / 25.4;
  let [pw, ph] = PAPER_MM[o.paper] || PAPER_MM.A4;
  if (o.orient === 'landscape') [pw, ph] = [ph, pw];
  const m = Math.min(60, Math.max(0, +o.margin || 0)), cw = pw - 2 * m, ch = ph - 2 * m - (o.pageNum ? 6 : 0);
  const d = fr.contentDocument, gen = fr._gen = (fr._gen || 0) + 1; // document.open()은 같은 문서를 다시 써서, 먼저 시작한 그리기는 번호로 멈춰요
  d.open(); d.write(html); d.close();
  d.head.insertAdjacentHTML('beforeend', `<style>html{background:#e8e8e8}body{width:${cw}mm;margin:0}.pg{position:relative;width:${pw}mm;height:${ph}mm;padding:${m}mm;margin:0 auto 6mm;background:#fff;box-shadow:0 .5mm 2mm rgba(0,0,0,.18);overflow:hidden}.pg>.in{height:${ch}mm;overflow:hidden}.pg>.pn{position:absolute;left:0;right:0;bottom:${Math.max(2, m / 2 - 2)}mm;text-align:center;font:9pt sans-serif;color:#888}.pgs{padding:6mm 0;width:${pw}mm;margin:0 auto}</style>`);
  await Promise.all([...d.images].map((im) => (im.complete ? 0 : new Promise((r) => { im.onload = im.onerror = r; }))));
  if (fr._gen !== gen) return;
  const blocks = [...d.body.children], limit = ch * mm, pages = [];
  let cur = null, top = 0;
  for (const el of blocks) {
    const r = el.getBoundingClientRect();
    if (!cur || (r.bottom - top > limit && cur.length)) {
      // 쪽 끝의 제목은 아래 내용과 함께 다음 쪽으로 (인쇄와 같게) — 같이 한 쪽에 들어갈 때만
      let k = cur?.length ?? 0;
      while (k && cur[k - 1].matches('.n.h, h1.doc') && r.bottom - cur[k - 1].getBoundingClientRect().top <= limit) k--;
      const carry = cur ? cur.splice(k) : [];
      if (cur && !cur.length) pages.pop(); // 제목만 있던 쪽은 없애요
      cur = carry; pages.push(cur); top = carry.length ? carry[0].getBoundingClientRect().top : r.top;
    }
    cur.push(el);
  }
  const total = Math.max(1, pages.length), wrap = d.createElement('div');
  wrap.className = 'pgs';
  (pages.length ? pages : [[]]).slice(0, PREVIEW_PAGES).forEach((list, k) => {
    const pg = d.createElement('div'), inn = d.createElement('div');
    pg.className = 'pg'; inn.className = 'in'; inn.append(...list); pg.append(inn);
    if (o.pageNum) { const pn = d.createElement('div'); pn.className = 'pn'; pn.textContent = `${k + 1} / ${total}`; pg.append(pn); }
    wrap.append(pg);
  });
  d.body.replaceChildren(wrap);
  d.body.style.width = 'auto';
  d.documentElement.style.zoom = Math.max(0.15, (fr.clientWidth - 16) / (pw * mm)).toFixed(3);
  info.textContent = `${total}쪽${total > PREVIEW_PAGES ? ` (앞 ${PREVIEW_PAGES}쪽만 보여요)` : ''}`;
}

/** 미리 보기 뷰: preview({ html: () => Promise<인쇄용 HTML>, opts, onInfo(글) }) — 다시 그릴 때마다 0.2초 뒤 한 번만 새로 그려요 */
export function pdfPreview({ html, opts, onInfo = () => {} }) {
  return Embed(() => {
    const fr = document.createElement('iframe'); fr.className = 'pdf-prevframe'; fr.title = 'PDF 미리 보기'; fr.setAttribute('sandbox', 'allow-same-origin');
    const ro = new ResizeObserver(() => { if (!fr.isConnected) return ro.disconnect(); fr._redraw?.(); }); ro.observe(fr); // 창 크기가 바뀌면 배율도 다시
    return fr;
  }, (fr) => {
    const want = JSON.stringify(opts);
    fr._redraw = () => {
      clearTimeout(fr._timer);
      fr._timer = setTimeout(async () => {
        if (!fr.isConnected) return;
        try { await renderPdfPreview(fr, await html(), opts, { set textContent(t) { onInfo(t); } }); }
        catch (e) { onInfo(`미리 보기 실패: ${e.message}`); }
      }, 200);
    };
    if (fr._want !== want) { fr._want = want; fr._redraw(); } // 설정이 그대로면 다시 그리지 않아요
  });
}
