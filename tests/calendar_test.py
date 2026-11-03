"""달력 플러그인 검사. 사용: 새 DB 서버를 띄운 뒤 python tests/calendar_test.py [포트]"""
import json, sys, urllib.request, datetime
from playwright.sync_api import sync_playwright
PORT = sys.argv[1] if len(sys.argv) > 1 else "5101"
BASE = f"http://127.0.0.1:{PORT}"
fails, errors = [], []
def api(path, method="GET", body=None):
    req = urllib.request.Request(BASE + path, method=method, data=json.dumps(body).encode() if body is not None else None, headers={"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req))
def check(n, c, x=""):
    print(("PASS " if c else "FAIL ") + n + (f"  {x}" if x and not c else ""))
    if not c: fails.append(n)
today = datetime.date.today()
ym = today.strftime("%Y-%m")
mk = lambda parent, text, pos=0: api("/api/nodes", "POST", {"parent_id": parent, "position": pos, "content": text})["id"]
P = mk(None, "프로젝트"); Q = mk(None, "다른 곳", 1)
a = mk(P, f"{ym}-05 회의 준비", 0); b = mk(P, f"{ym}-05 보고서", 1); c = mk(Q, f"{ym}-12 병원", 0)
many = [mk(P, f"{ym}-20 일{i}", 2 + i) for i in range(6)]
two = mk(P, f"{ym}-07~{ym}-09 출장", 9)
with sync_playwright() as p:
    b_ = p.chromium.launch(); page = b_.new_page(viewport={"width": 1200, "height": 850})
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(BASE); page.wait_for_selector("#tree .text")
    page.keyboard.press("Control+/"); page.wait_for_selector(".cmdl-find"); page.keyboard.type("calendar"); page.wait_for_timeout(300); page.keyboard.press("Enter"); page.wait_for_selector("[data-f=cal]"); page.wait_for_timeout(700)
    box = page.locator(".wfx-dialog.full").bounding_box()
    check("달력이 크게 표시", box["width"] > 900 and box["height"] > 600, box)
    check("제목에 이번 달", page.inner_text("[data-f=cal] [data-f=title]") == f"{today.year}년 {today.month}월")
    cell = lambda d: page.locator("[data-f=grid] [data-f=cell]").nth(d - 1)
    check("5일 칸에 매칭 노드 2개", cell(5).locator("[data-f=item]").count() == 2 and "회의 준비" in cell(5).inner_text(), cell(5).inner_text())
    check("날짜 글자는 빼고 보여줌", "-05" not in cell(5).locator("[data-f=item]").first.inner_text())
    check("12일 칸(다른 부모 아래)에도 표시", cell(12).locator("[data-f=item]").count() == 1)
    check("여러 날짜가 적힌 항목은 각 날짜 칸에", cell(7).locator("[data-f=item]").count() == 1 and cell(9).locator("[data-f=item]").count() == 1)
    check("한 칸에 많으면 개수 표시 · 항목은 모두 (칸 안에서 스크롤)", cell(20).locator("[data-f=item]").count() == 6 and "6개" in cell(20).locator("[data-f=cnt]").inner_text(), cell(20).inner_text())
    check("오늘 칸 강조", cell(today.day).get_attribute("data-today") == "")
    page.keyboard.press("PageDown"); page.wait_for_timeout(500)
    nm = (today.replace(day=1) + datetime.timedelta(days=32)).replace(day=1)
    check("PageDown → 다음 달", page.inner_text("[data-f=cal] [data-f=title]") == f"{nm.year}년 {nm.month}월" and page.locator("[data-f=grid] [data-f=item]").count() == 0)
    page.locator("[data-f=cal] button", has_text="오늘").click(); page.wait_for_timeout(500)
    check("오늘 버튼 → 이번 달", page.inner_text("[data-f=cal] [data-f=title]") == f"{today.year}년 {today.month}월" and cell(5).locator("[data-f=item]").count() == 2)
    cell(12).locator("[data-f=item]").click(); page.wait_for_timeout(800)
    check("항목 클릭 → 달력 닫히고 그 항목으로 줌인", page.locator("[data-f=cal]").count() == 0 and page.evaluate("location.hash") == f"#{c}", page.evaluate("location.hash"))
    # 줌인 상태에서는 '이 항목 안만' 전환
    page.goto(f"{BASE}/#{P}"); page.reload(); page.wait_for_selector("#tree .text")
    page.keyboard.press("Control+/"); page.wait_for_selector(".cmdl-find"); page.keyboard.type("calendar"); page.wait_for_timeout(300); page.keyboard.press("Enter"); page.wait_for_selector("[data-f=cal]"); page.wait_for_timeout(600)
    check("전체 보기에서는 다른 부모의 항목도 보임", cell(12).locator("[data-f=item]").count() == 1)
    page.locator("[data-f=cal] button", has_text="전체").click(); page.wait_for_timeout(600)
    check("'이 항목 안만' → 하위 것만", cell(12).locator("[data-f=item]").count() == 0 and cell(5).locator("[data-f=item]").count() == 2)
    page.keyboard.press("Escape"); page.wait_for_timeout(200)
    check("Esc로 닫힘", page.locator("[data-f=cal]").count() == 0)
    check("콘솔 오류 없음", not errors, errors[:3])
    b_.close()
print("\n실패:", fails or "없음"); sys.exit(1 if fails else 0)
