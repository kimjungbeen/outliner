"""플러그인 입력 기록(최근 · ★) 테스트: fs(입력창 기록) · rx(창 안 기록 — 찾기 · 바꾸기 짝) · mt. 사용: python3 tests/hist_test.py <앱 포트>"""
import sys
import requests
from playwright.sync_api import sync_playwright

B = f"http://127.0.0.1:{sys.argv[1]}"
fails = []


def check(name, cond, extra=""):
    print(("PASS " if cond else "FAIL ") + name, "" if cond else extra)
    if not cond:
        fails.append(name)


for r in requests.get(B + "/api/children").json().get("nodes", []):
    requests.delete(B + f"/api/nodes/{r['id']}")
add = lambda c: requests.post(B + "/api/nodes", json={"parent_id": None, "position": None, "content": c}).json()["id"]
a = add("말씀 요 3:16 하나"); b = add("롬 8:28 둘"); c = add("요 3:16 셋")
hist = lambda k: requests.get(B + f"/api/plugin-data/wfx/hist-{k}").json()["value"] or {}

with sync_playwright() as p:
    br = p.chromium.launch()
    page = br.new_page(viewport={"width": 1100, "height": 800})
    errors = []; page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(B); page.wait_for_selector("#tree .text")

    def run(cmd):
        if page.is_visible(".dlg-ov:not(.out) .palette"):
            page.keyboard.press("Escape")
        page.locator("#tree .text").first.click()
        page.keyboard.press("Control+/")  # ⌘/ 명령 목록
        page.wait_for_selector(".cmdl-find"); page.keyboard.type(cmd); page.wait_for_timeout(150); page.keyboard.press("Enter")

    run("verse"); page.wait_for_selector(".wfx-prompt.show input")
    check("처음엔 기록 없음", page.locator(".wfx-prompt .result-item").count() == 0)
    page.keyboard.type("요 3:16"); page.keyboard.press("Enter"); page.wait_for_timeout(800)
    check("fs 실행 → 최근 기록에 저장", [x["v"] for x in hist("fs").get("recent", [])] == ["요 3:16"], str(hist("fs")))
    page.keyboard.press("Escape")
    run("verse"); page.wait_for_selector(".wfx-prompt.show .result-item")
    row = page.inner_text(".wfx-prompt .result-item >> nth=0")
    check("다시 열면 최근 입력이 맨 위 ('방금')", "요 3:16" in row and "방금" in row, row)
    page.keyboard.press("Shift+Enter"); page.wait_for_timeout(400)
    check("⇧Enter → ★ 즐겨찾기 (창은 그대로)", hist("fs").get("favs") == ["요 3:16"] and page.locator(".wfx-prompt .result-item.fav").count() == 1 and page.is_visible(".wfx-prompt"))
    page.keyboard.type("롬 8:28"); page.keyboard.press("Enter"); page.wait_for_timeout(800)
    page.keyboard.press("Escape")
    run("verse"); page.wait_for_selector(".wfx-prompt.show .result-item")
    items = page.eval_on_selector_all(".wfx-prompt .result-item .txt", "els => els.map(e => e.textContent)")
    check("★는 맨 위, 그다음 최근 순", items == ["요 3:16", "롬 8:28"], str(items))
    page.keyboard.press("Enter"); page.wait_for_timeout(800)  # 빈 입력 + Enter → 맨 위 줄(★ 사과) 실행
    found = sorted(page.eval_on_selector_all("#tree .row.found", "rs => rs.map(r => +r.dataset.id)"))
    check("빈 칸에서 Enter → 맨 위 기록으로 바로 다시 실행", found == sorted([a, c]), str(found))
    page.keyboard.press("Escape")
    # rx 바꾸기: 찾기 → 바꾸기 짝이 한 기록으로
    run("replace"); page.wait_for_selector(".wfx-dialog [data-f=find]")
    page.fill(".wfx-dialog [data-f=find]", "둘"); page.fill(".wfx-dialog [data-f=to]", "2"); page.click(".wfx-dialog [data-f=go]"); page.wait_for_timeout(800)
    rv = [x["v"] for x in hist("rx").get("recent", [])]
    check("rx 바꾸기 실행 → 찾기 · 바꾸기 짝으로 기록", len(rv) == 1 and rv[0].get("f") == "둘" and rv[0].get("r") == "2", str(hist("rx")))
    run("replace"); page.wait_for_selector(".wfx-hist-row")
    check("rx 다시 열면 '둘 → 2' 기록", "둘" in page.inner_text(".wfx-hist-row") and "2" in page.inner_text(".wfx-hist-row"))
    page.click(".wfx-hist-row .wfx-hist-text")
    check("기록을 누르면 두 칸이 채워짐", page.input_value(".wfx-dialog [data-f=find]") == "둘" and page.input_value(".wfx-dialog [data-f=to]") == "2")
    page.click(".wfx-hist-row .wfx-star"); page.wait_for_timeout(400)
    check("rx 기록도 ★", len(hist("rx").get("favs") or []) == 1 and page.locator(".wfx-hist-row.fav").count() == 1)
    page.keyboard.press("Escape"); page.wait_for_timeout(200)
    # replace의 '뒤에 붙이기' (예전 regex · tag · mt): 고른 항목에만
    page.click(f'#tree .text[data-id="{a}"]'); page.keyboard.press("Shift+ArrowDown"); page.wait_for_timeout(100)
    page.keyboard.press("Control+/")  # ⌘/ 명령 목록
    page.wait_for_selector(".cmdl-find"); page.keyboard.type("replace"); page.wait_for_timeout(150); page.keyboard.press("Enter")
    page.wait_for_selector(".wfx-dialog [data-f=presets] button")
    page.locator(".wfx-dialog [data-f=presets] button", has_text="뒤에 붙이기").click(); page.wait_for_timeout(150)
    check("뒤에 붙이기: 찾기 $ · 바꿀 글의 #태그가 골라져 있어요", page.input_value(".wfx-dialog [data-f=find]") == "$" and page.evaluate("document.activeElement.value.slice(document.activeElement.selectionStart, document.activeElement.selectionEnd)") == "#태그")
    page.keyboard.type("#과일"); page.wait_for_timeout(150)
    check("범위는 고른 항목만", "선택" in page.inner_text(".wfx-dialog [data-f=note]") or page.locator(".wfx-dialog .wfx-after").count() == 1, page.inner_text(".wfx-dialog [data-f=note]"))
    page.click(".wfx-dialog [data-f=go]"); page.wait_for_timeout(800)
    check("고른 항목 뒤에 #과일", requests.get(B + f"/api/view?parent={a}").json()["node"]["content"].endswith(" #과일"), requests.get(B + f"/api/view?parent={a}").json()["node"]["content"])
    check("페이지 오류 없음", not errors, str(errors))
    br.close()

print("\n" + ("모두 통과" if not fails else f"실패 {len(fails)}개: {fails}"))
sys.exit(1 if fails else 0)
