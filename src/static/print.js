// 인쇄: 인쇄용 문서(HTML)를 보이지 않는 틀에 그려 인쇄 창을 열어요 — 내보내기 플러그인이 api.export.print로 써요

/** 화면에 안 보이는 틀 안에 문서를 그려 인쇄 창을 열어요 (이미지가 다 불러와진 뒤에) */
async function printHtml(html) {
  const fr = document.createElement('iframe');
  fr.className = 'print-frame';
  fr.setAttribute('aria-hidden', 'true');
  document.body.append(fr);
  const w = fr.contentWindow;
  w.document.open(); w.document.write(html); w.document.close();
  await Promise.all([...w.document.images].map((im) => (im.complete ? 0 : new Promise((r) => { im.onload = im.onerror = r; }))));
  await new Promise((r) => setTimeout(r, 100));
  const cleanup = () => setTimeout(() => fr.remove(), 500);
  w.addEventListener('afterprint', cleanup);
  setTimeout(() => fr.isConnected && !globalThis.__outlinerPrint && fr.remove(), 10 * 60 * 1000);
  (globalThis.__outlinerPrint || ((win) => { win.focus(); win.print(); }))(w);
}

export { printHtml };
