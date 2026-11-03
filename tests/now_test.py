"""now(지금 넣기): 글을 쓰는 중이면 그 자리에, 아니면 커서 항목 끝에 · Enter = 날짜. 사용: python3 tests/now_test.py <앱 포트>"""
import sys, datetime, requests
from playwright.sync_api import sync_playwright

B = f"http://127.0.0.1:{sys.argv[1]}"
fails = []
def check(name, ok, info=""):
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else f" {info}"))
    if not ok: fails.append(name)
nid = requests.post(B + "/api/nodes", json={"parent_id": None, "position": 0, "content": "회의 메모"}).json()["id"]
requests.put(B + "/api/plugin-data/core/cmd_keys", json={"value": {"map": {"Alt+N": "now"}, "off": []}})  # 기본 단축키가 없는 명령 — 사용자가 ⌘/에서 하듯 지정해 두고 시작해요
content = lambda: requests.get(f"{B}/api/view?parent={nid}").json()["node"]["content"]
today = datetime.date.today().isoformat()
with sync_playwright() as p:
    br = p.chromium.launch(); pg = br.new_page()
    pg.goto(B); pg.wait_for_selector(f'#tree .text[data-id="{nid}"]')
    pg.click(f'#tree .text[data-id="{nid}"]'); pg.keyboard.press("End"); pg.keyboard.press("Home"); pg.keyboard.press("ArrowRight"); pg.keyboard.press("ArrowRight")  # '회의|'
    pg.keyboard.press("Alt+n"); pg.wait_for_selector(".wfx-dialog h3:text-is('지금 넣기')")
    check("⌥N → 지금 넣기 창 (날짜 · 날짜 + 시각)", pg.locator(".wfx-dialog .wfx-btn", has_text="날짜 + 시각").count() == 1)
    pg.keyboard.press("Enter"); pg.wait_for_timeout(1200)
    check("Enter = 날짜, 쓰던 자리에 바로", content() == f"회의 {today} 메모", content())
    pg.keyboard.type("!"); pg.wait_for_timeout(800)
    check("넣은 뒤 커서는 그 자리 그대로 (이어서 입력)", content() == f"회의 {today}! 메모", content())
    br.close()
print("\n" + ("모두 통과" if not fails else f"실패 {len(fails)}개: {fails}"))
sys.exit(1 if fails else 0)
