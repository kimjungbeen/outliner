"""명령 즐겨찾기(★) · 알파벳 순 테스트. 사용: python3 tests/cmdfav_test.py <앱 포트>"""
import sys
import time
import requests
from playwright.sync_api import sync_playwright

B = f"http://127.0.0.1:{sys.argv[1]}"
fails = []


def check(name, cond, extra=""):
    print(("PASS " if cond else "FAIL ") + name, "" if cond else extra)
    if not cond:
        fails.append(name)



with sync_playwright() as p:
    br = p.chromium.launch()
    page = br.new_page(viewport={"width": 1100, "height": 800})
    errors = []; page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(B); page.wait_for_selector("#tree .text")
    names = lambda: page.eval_on_selector_all(".cmdl-row .cmdl-name", "els => els.map(e => e.textContent)")

    def cmd_mode():
        page.locator("#tree .text").first.click()
        page.keyboard.press("Control+/")  # ⌘/ 명령 목록
        page.wait_for_selector(".cmdl-find")

    cmd_mode()
    first = names()
    check("기본: 알파벳 순", first == sorted(first) and first[:2] == ["bold", "bookmarks"], str(first[:4]))
    # ★ 별 누르기
    page.hover(".cmdl-row:has(.cmdl-name:text-is('home'))")
    page.click(".cmdl-row:has(.cmdl-name:text-is('home')) .cmdl-star"); page.wait_for_timeout(400)
    check("☆ 누르면 맨 위로 (★)", names()[0] == "home" and page.locator(".cmdl-row:has(.cmdl-star.on)").count() == 1, str(names()[:3]))
    check("서버에 저장", requests.get(B + "/api/plugin-data/core/cmd_favs").json()["value"] == ["home"])
    page.keyboard.type("plain"); page.wait_for_timeout(150)
    page.keyboard.press("Shift+Enter"); page.wait_for_timeout(300)
    check("⇧Enter로 고른 명령 ★ (실행은 안 함)", requests.get(B + "/api/plugin-data/core/cmd_favs").json()["value"] == ["home", "plain"] and page.is_visible(".cmdl-dlg"))
    page.keyboard.press("Escape")
    page.reload(); page.wait_for_selector("#tree .text")
    cmd_mode()
    check("새로고침해도 ★ 두 개가 맨 위 (넣은 순서), 그다음 알파벳 순", names()[:4] == ["home", "plain", "bold", "bookmarks"], str(names()[:5]))
    page.keyboard.press("Escape")
    # ★ 빼기
    cmd_mode(); page.click(".cmdl-row:has(.cmdl-name:text-is('home')) .cmdl-star"); page.wait_for_timeout(400)
    check("★ 다시 누르면 빠짐", requests.get(B + "/api/plugin-data/core/cmd_favs").json()["value"] == ["plain"])
    check("페이지 오류 없음", not errors, str(errors))
    br.close()

print("\n" + ("모두 통과" if not fails else f"실패 {len(fails)}개: {fails}"))
sys.exit(1 if fails else 0)
