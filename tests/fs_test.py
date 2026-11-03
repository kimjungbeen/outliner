"""fs(성구 찾기) 테스트: 괄호 없이·문단 어디서든 찾고, 성구가 아닌 숫자는 무시해요.
사용: python3 tests/fs_test.py <앱 포트>"""
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
top = add(None, "설교 메모")
requests.patch(BASE + f"/api/nodes/{top}", json={"collapsed": 1})
want = {
    add(top, "(창 1:3) 빛이 있으라"),
    add(top, "본문은 창 1:1-5 입니다"),
    add(top, "끝에 괄호 (창 1:2-4)"),
    add(top, "붙여서 창1:3도"),
}
deep = add(top, "깊은 곳")
want.add(add(deep, "출 2:4; 창 1:3 같이"))
nope = {add(top, "창 2:3 다른 장"), add(top, "오전 1:30 회의"), add(top, "전체 1:3 비율")}

errors = []
with sync_playwright() as p:
    br = p.chromium.launch()
    page = br.new_page(viewport={"width": 1100, "height": 800})
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(BASE); page.wait_for_selector("#tree .text")
    page.locator("#tree .text").first.click()
    page.keyboard.press("Control+/")  # ⌘/ 명령 목록
    page.wait_for_selector(".cmdl-find")
    page.keyboard.type("verse"); page.wait_for_timeout(150); page.keyboard.press("Enter")
    page.wait_for_selector(".wfx-prompt.show input, .wfx-prompt.show textarea")
    page.keyboard.type("창 1:3"); page.keyboard.press("Enter")
    page.wait_for_timeout(800)
    check("물음은 한 번뿐 (위치 묻지 않음)", not page.is_visible(".wfx-prompt"))
    found = set(page.eval_on_selector_all("#tree .row.found", "rs => rs.map(r => +r.dataset.id)"))
    check("괄호 유무·위치 상관없이 찾음", found == want, f"{sorted(found)} vs {sorted(want)}")
    check("다른 장·시각·일반 낱말은 안 찾음", not (found & nope))
    check("접힌 조상이 펼쳐져 보임", page.is_visible(f'#tree .row[data-id="{max(want)}"]'))
    check("페이지 오류 없음", not errors, str(errors))
    br.close()

print("\n" + ("모두 통과" if not fails else f"실패 {len(fails)}개: {fails}"))
sys.exit(1 if fails else 0)
