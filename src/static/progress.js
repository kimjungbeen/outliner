// 진행 표시: 화면 맨 위의 가는 막대.
//  · 서버와 주고받는 중이면 저절로 (0.3초 넘게 걸릴 때만 — 빠른 요청은 깜빡이지 않게): 움직이는 막대
//  · 얼마나 됐는지 아는 일(파일 올리기 · PDF 불러오기)은 progress()로: 채워지는 막대
// 앱이 처음 뜰 때도(html.booting) 막대를 보여줘요. 다른 모듈보다 먼저 읽혀야 해요 (app.js 맨 첫 import).
const DELAY = 300;
const QUIET = /\/api\/(events|ping)\b/; // 늘 열려 있거나 주기적으로 오가는 요청은 빼요
const bar = document.createElement('div');
bar.id = 'progress'; bar.setAttribute('role', 'progressbar'); bar.setAttribute('aria-label', '불러오는 중'); bar.hidden = true;
const fill = document.createElement('div');
bar.append(fill);
(document.body ?? document.documentElement).append(bar);

let pending = 0, timer = 0;
const jobs = new Set(); // 진행률을 아는 일들 { f: 0~1 }
function paint() {
  const busy = pending > 0 || jobs.size > 0 || document.documentElement.classList.contains('booting');
  if (!busy) { clearTimeout(timer); timer = 0; bar.hidden = true; return; }
  if (jobs.size) { // 여러 개면 평균
    const f = [...jobs].reduce((s, j) => s + j.f, 0) / jobs.size;
    bar.classList.remove('wait'); fill.style.width = `${Math.round(Math.max(.03, Math.min(1, f)) * 100)}%`;
    bar.hidden = false; return;
  }
  bar.classList.add('wait'); fill.style.width = '';
  if (bar.hidden && !timer) timer = setTimeout(() => { timer = 0; if (pending > 0 || document.documentElement.classList.contains('booting')) bar.hidden = false; }, DELAY);
}
const orig = window.fetch.bind(window);
window.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input?.url ?? String(input);
  if (QUIET.test(url)) return orig(input, init);
  pending++; paint();
  return orig(input, init).finally(() => { pending--; paint(); });
};

/** 진행률을 아는 일: const p = progress(); p.set(0.4); … p.done() */
export function progress() {
  const job = { f: 0 };
  jobs.add(job); paint();
  return { set(f) { job.f = f; paint(); }, done() { jobs.delete(job); paint(); } };
}
/** 얼마나 걸릴지 모르는 일 (예: 큰 이미지 받기): const b = busy(); … b.done() — 움직이는 막대 */
export function busy() {
  pending++; paint();
  let on = true;
  return { done() { if (on) { on = false; pending--; paint(); } } };
}
/** 처음 화면을 다 그렸어요 → 'booting' 끄기 */
export function booted() { document.documentElement.classList.remove('booting'); paint(); }
paint();
