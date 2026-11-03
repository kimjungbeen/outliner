"""창을 많이 띄워도 멈추지 않는지 (브라우저의 주소당 동시 연결 6개 제한). 사용: python3 tests/manytabs_test.py <앱 포트>"""
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
    br = p.chromium.launch(); ctx = br.new_context()
    pages, stuck = [], []
    for i in range(10):
        pg = ctx.new_page()
        try:
            pg.goto(B, timeout=8000); pg.wait_for_selector("#tree .text", timeout=8000)
        except Exception:
            stuck.append(i + 1)
        pages.append(pg)
    check("창 10개를 띄워도 모두 열림", not stuck, f"멈춘 창: {stuck}")
    check("실시간 연결은 하나만", requests.get(B + "/api/ping").json()["clients"] == 1, str(requests.get(B + "/api/ping").json()))
    t = time.time()
    try:
        pages[3].reload(timeout=8000); pages[3].wait_for_selector("#tree .text", timeout=8000); ok = True
    except Exception:
        ok = False
    check("새로고침도 바로 됨", ok, f"{time.time() - t:.1f}s")
    requests.post(B + "/api/nodes", json={"parent_id": None, "position": 0, "content": "모두에게"})
    time.sleep(1.5)
    seen = [i + 1 for i, pg in enumerate(pages) if "모두에게" in pg.inner_text("#tree")]
    check("모든 창에 실시간 반영", len(seen) == 10, str(seen))
    pages[0].close(); time.sleep(0.5)  # 처음 창(연결 담당)을 닫으면 다른 창이 이어받아요
    requests.post(B + "/api/nodes", json={"parent_id": None, "position": 0, "content": "이어받기"})
    time.sleep(2)
    seen = [i for i, pg in enumerate(pages[1:]) if "이어받기" in pg.inner_text("#tree")]
    check("담당 창을 닫아도 나머지가 이어받아 실시간 반영", len(seen) == 9, str(seen))
    # 뒤에 있는 창(다른 창을 보는 중)은 다른 창에서 고친 걸 받아 다시 그려도 focus()를 부르지 않아요 (전용 창이 앞으로 끌려 나오지 않게) → 돌아오면 커서를 되돌려요
    pg = pages[1]
    nid = requests.post(B + "/api/nodes", json={"parent_id": None, "position": 0, "content": "커서 자리"}).json()["id"]
    pg.wait_for_selector(f'#tree .text[data-id="{nid}"]', timeout=5000)
    pg.click(f'#tree .text[data-id="{nid}"]'); pg.keyboard.press("End")
    pg.evaluate("""() => { window.__focusCalls = 0; const f = HTMLElement.prototype.focus; HTMLElement.prototype.focus = function (...a) { window.__focusCalls++; (window.__focusStacks ||= []).push(new Error().stack.split('\\n').slice(1, 6).join(' / ') + ' @' + (this.id || this.className)); return f.apply(this, a); }; document.hasFocus = () => false; }""")
    requests.patch(f"{B}/api/nodes/{nid}", json={"content": "커서 자리 (다른 창에서 고침)"}); time.sleep(1.5)
    check("뒤에 있는 창: 다른 창의 변경을 받아도 focus()를 부르지 않음", pg.evaluate("window.__focusCalls") == 0 and "다른 창에서 고침" in pg.inner_text("#tree"), str(pg.evaluate("window.__focusStacks")))
    pg.evaluate("() => { delete document.hasFocus; window.dispatchEvent(new Event('focus')); }"); pg.wait_for_timeout(200)
    check("그 창으로 돌아오면 커서를 되돌림", pg.evaluate(f"document.activeElement?.dataset?.id") == str(nid), pg.evaluate("document.activeElement?.outerHTML?.slice(0, 80)"))
    br.close()

print("\n" + ("모두 통과" if not fails else f"실패 {len(fails)}개: {fails}"))
sys.exit(1 if fails else 0)
