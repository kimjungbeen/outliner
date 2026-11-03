"""화살표 이동 테스트: 글 끝/처음까지 간 다음에야 이웃 항목으로, 넘어가면 맨 앞에.
사용: python3 tests/arrows_test.py <앱 포트>"""
import sys
import requests
from playwright.sync_api import sync_playwright

BASE = f"http://127.0.0.1:{sys.argv[1]}"
fails = []


def check(name, cond, extra=""):
    print(("PASS " if cond else "FAIL ") + name, "" if cond else extra)
    if not cond:
        fails.append(name)


for r in requests.get(BASE + "/api/children").json().get("nodes", []):
    requests.delete(BASE + f"/api/nodes/{r['id']}")
add = lambda parent, c: requests.post(BASE + "/api/nodes", json={"parent_id": parent, "position": None, "content": c}).json()["id"]
a = add(None, "첫째 항목 짧은 글")
b = add(None, "둘째 " + "아주 긴 글이 여러 줄로 감깁니다 " * 12)
c = add(None, "셋째 항목")

with sync_playwright() as p:
    br = p.chromium.launch()
    page = br.new_page(viewport={"width": 700, "height": 800})
    page.goto(BASE); page.wait_for_selector("#tree .text")
    T = lambda i: f'#tree .text[data-id="{i}"]'
    where = lambda: page.evaluate("""() => { const el = document.activeElement; const s = getSelection(); const r = s.getRangeAt(0).cloneRange();
        r.selectNodeContents(el); r.setEnd(s.getRangeAt(0).endContainer, s.getRangeAt(0).endOffset); return [+el.dataset.id, r.toString().length, el.textContent.length]; }""")
    page.click(T(a)); page.evaluate(f"(() => {{ const el = document.querySelector('{T(a)}'); const r = document.createRange(); r.setStart(el.firstChild, 3); r.collapse(true); getSelection().removeAllRanges(); getSelection().addRange(r); }})()")
    page.keyboard.press("ArrowDown"); page.wait_for_timeout(100)
    w = where(); check("↓ 중간에서: 먼저 그 항목 끝으로", w[0] == a and w[1] == w[2], str(w))
    page.keyboard.press("ArrowDown"); page.wait_for_timeout(100)
    w = where(); check("↓ 끝에서: 다음 항목 맨 앞으로", w[0] == b and w[1] == 0, str(w))
    page.keyboard.press("ArrowDown"); page.wait_for_timeout(100)
    w = where(); check("여러 줄 항목: ↓는 다음 줄로 (넘어가지 않음)", w[0] == b and 0 < w[1] < w[2], str(w))
    for _ in range(30):
        page.keyboard.press("ArrowDown"); page.wait_for_timeout(30)
        if where()[0] != b: break
    w = where(); check("여러 줄 항목 끝까지 간 뒤 다음 항목 맨 앞으로", w[0] == c and w[1] == 0, str(w))
    page.keyboard.press("ArrowUp"); page.wait_for_timeout(100)
    w = where(); check("↑ 맨 앞에서: 이전 항목 맨 앞으로", w[0] == b and w[1] == 0, str(w))
    page.keyboard.press("End"); page.keyboard.press("ArrowRight"); page.wait_for_timeout(50)
    w = where(); check("→ (끝 아님)는 글 안에서만", w[0] == b, str(w))
    page.click(T(c)); page.keyboard.press("End"); page.keyboard.press("ArrowLeft"); page.wait_for_timeout(50)
    w = where(); check("← 중간에서: 글 안에서만", w[0] == c and w[1] == w[2] - 1, str(w))
    page.keyboard.press("Home"); page.keyboard.press("ArrowLeft"); page.wait_for_timeout(50)
    w = where(); check("← 맨 앞에서: 이전 항목 끝으로", w[0] == b and w[1] == w[2], str(w))
    page.keyboard.press("ArrowRight"); page.wait_for_timeout(50)
    w = where(); check("→ 끝에서: 다음 항목 맨 앞으로", w[0] == c and w[1] == 0, str(w))
    # 여러 항목 선택 중 ↑·↓ → 선택 해제 + 커서 이동
    sel = lambda: page.evaluate("document.querySelectorAll('#tree .row.sel, #tree .row.selected').length")
    def select(x, n):
        page.click(T(x)); page.keyboard.press("Home")
        for _ in range(n):
            page.keyboard.press("Shift+ArrowDown")
        page.wait_for_timeout(100)
    select(a, 2)
    check("(준비) 항목 여러 개 선택됨", page.evaluate("document.body.classList.contains('has-sel')"))
    page.keyboard.press("ArrowDown"); page.wait_for_timeout(100)
    w = where(); check("선택 중 ↓ → 선택 해제, 선택 아래 항목 맨 앞으로", not page.evaluate("document.body.classList.contains('has-sel')") and w[0] == c and w[1] == 0, str(w))
    select(b, 2)
    page.keyboard.press("ArrowUp"); page.wait_for_timeout(100)
    w = where(); check("선택 중 ↑ → 선택 해제, 선택 위 항목 맨 앞으로", not page.evaluate("document.body.classList.contains('has-sel')") and w[0] == a and w[1] == 0, str(w))
    select(a, 2)
    page.keyboard.press("ArrowUp"); page.wait_for_timeout(100)
    w = where(); check("맨 위까지 선택한 채 ↑ → 맨 위 항목 맨 앞", not page.evaluate("document.body.classList.contains('has-sel')") and w[0] == a and w[1] == 0, str(w))
    br.close()

print("\n" + ("모두 통과" if not fails else f"실패 {len(fails)}개: {fails}"))
sys.exit(1 if fails else 0)
