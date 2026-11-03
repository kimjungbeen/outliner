"""선택 막대의 명령 단추: 명령(플러그인)이 selection으로 스스로 올려요 — 앱에 박힌 단추 없음. 사용: python3 tests/selbar_test.py <앱 포트>"""
import sys, requests
from playwright.sync_api import sync_playwright

B = f"http://127.0.0.1:{sys.argv[1]}"
fails = []
def check(name, ok, info=""):
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else f" {info}"))
    if not ok: fails.append(name)
root = requests.post(B + "/api/nodes", json={"parent_id": None, "position": 0, "content": "선택 막대"}).json()["id"]
ids = [requests.post(B + "/api/nodes", json={"parent_id": root, "content": t}).json()["id"] for t in ("가", "나", "다")]
with sync_playwright() as p:
    br = p.chromium.launch(); pg = br.new_page()
    pg.goto(f"{B}/#{root}"); pg.wait_for_selector(f'#tree .text[data-id="{ids[0]}"]'); pg.wait_for_timeout(300)
    btns = lambda: pg.eval_on_selector_all("#sel-cmds button", "els => els.map(e => e.textContent)")
    check("앱에 박힌 합치기 단추는 없어요", pg.locator("#sel-join").count() == 0)
    pg.click(f'#tree .text[data-id="{ids[0]}"]'); pg.keyboard.press("Escape"); pg.wait_for_timeout(100)
    pg.click(f'#tree .text[data-id="{ids[0]}"]', modifiers=["ControlOrMeta"]); pg.wait_for_timeout(150)
    check("하나만 고르면 '합치기'는 안 보여요 (join: 둘 이상)", pg.is_visible("#selbar") and "합치기" not in btns(), btns())
    pg.click(f'#tree .text[data-id="{ids[1]}"]', modifiers=["ControlOrMeta"]); pg.wait_for_timeout(150)
    check("둘 고르면 join이 올린 '합치기' · sort의 '정렬' · move의 '옮기기' · plain의 '서식 없애기'", {"합치기", "정렬", "옮기기", "서식 없애기"} <= set(btns()), btns())
    # 다른 플러그인도 한 줄로 올릴 수 있어요
    pg.evaluate("import('/commands.js').then((P) => P.paletteCommands.set('shout', { name: 'shout', label: '외치기', selection: '외치기', run: () => { window.__shout = (window.__shout || 0) + 1; } }))")
    pg.click(f'#tree .text[data-id="{ids[2]}"]', modifiers=["ControlOrMeta"]); pg.wait_for_timeout(150)
    check("새 명령도 selection으로 단추가 생겨요", "외치기" in btns(), btns())
    pg.click("#sel-cmds button:text-is('외치기')"); pg.wait_for_timeout(200)
    check("단추를 누르면 그 명령 실행", pg.evaluate("window.__shout") == 1)
    pg.click("#sel-cmds button:text-is('합치기')"); pg.wait_for_selector(".wfx-dialog h3:has-text('항목 합치기')")
    check("'합치기' → join 창 (고른 항목 그대로)", "선택한 항목 3개" in pg.inner_text(".wfx-dialog h3"), pg.inner_text(".wfx-dialog h3"))
    br.close()
print("\n" + ("모두 통과" if not fails else f"실패 {len(fails)}개: {fails}"))
sys.exit(1 if fails else 0)
