// 툴팁: 마우스를 올리면 그 단추가 하는 일을 앱 모양의 작은 말풍선으로 보여줘요 (브라우저 기본 툴팁보다 빨리 · 어디서나 같은 모양)
// 따로 붙일 것 없이 title이 있는 요소(또는 글자 없는 단추의 aria-label)면 다 돼요 — 앱 · 플러그인 · 나중에 바뀐 title도. 처음 올릴 때 title을 data-tip으로 옮겨 기본 툴팁과 겹치지 않게 해요.
// 터치 화면에서는 뜨지 않아요 (누르면 바로 동작하니까요).
const DELAY = 450, WARM = 600; // 처음엔 조금 기다렸다가, 하나 본 뒤 곧바로 옆 단추로 가면 바로
let tip = null, owner = null, timer = 0, hidAt = 0;

const SEL = '[title], [data-tip], button[aria-label], [role="button"][aria-label]';
function harvest(el) {
  const t = el.getAttribute('title');
  if (t == null) { // title이 없으면 글자 없는(아이콘만 있는) 단추의 aria-label로
    if (!el.dataset.tip && !el.textContent.trim() && el.getAttribute('aria-label')) el.dataset.tip = el.getAttribute('aria-label');
    return el.dataset.tip || '';
  }
  el.removeAttribute('title');
  if (t) {
    el.dataset.tip = t;
    if (!el.getAttribute('aria-label') && !el.textContent.trim()) el.setAttribute('aria-label', t); // 아이콘만 있는 단추도 읽어 줄 이름이 있게
  }
  return t;
}
function place(el) {
  const r = el.getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight, gap = 8;
  const below = r.bottom + gap + h <= innerHeight - 4 || r.top - gap - h < 4; // 아래 자리가 없으면 위로
  const x = Math.min(innerWidth - w - 6, Math.max(6, r.left + r.width / 2 - w / 2));
  tip.style.left = `${x}px`;
  tip.style.top = `${below ? r.bottom + gap : r.top - gap - h}px`;
}
function show(el) {
  const text = el.dataset.tip;
  if (!text || !el.isConnected) return;
  tip ??= Object.assign(document.createElement('div'), { className: 'tip', role: 'tooltip' });
  tip.textContent = text;
  document.body.append(tip);
  place(el);
  tip.classList.add('on');
}
function hide() {
  clearTimeout(timer);
  if (tip?.classList.contains('on')) hidAt = performance.now();
  tip?.classList.remove('on');
  owner = null;
}
if (matchMedia('(hover: hover)').matches) {
  addEventListener('pointerover', (e) => {
    if (e.pointerType !== 'mouse') return;
    const el = e.target.closest?.(SEL);
    if (el === owner) return;
    hide();
    if (!el || !harvest(el)) return;
    owner = el;
    const warm = performance.now() - hidAt < WARM && !el.closest('.pal-list'); // 명령 · 검색 목록에서는 줄을 따라 내려갈 때 줄마다 말풍선이 뜨지 않게 늘 기다려요
    timer = setTimeout(() => show(el), warm ? 0 : DELAY);
  }, true);
  addEventListener('pointerout', (e) => { if (owner && !owner.contains(e.relatedTarget)) hide(); }, true);
  for (const ev of ['pointerdown', 'keydown', 'wheel', 'scroll', 'blur']) addEventListener(ev, hide, true);
}

export { hide as hideTip };
