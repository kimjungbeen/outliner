"""녹음 플러그인(rec): 녹음 → 일시정지 · 이어서 → 끝내기 → 미리 듣기 · 이름 → 넣기(mp3 첨부가 커서 항목 아래에),
녹음 중 바깥을 눌러도 안 닫힘 · Esc는 묻고 닫기 · 음질 기억. 크롬의 가짜 마이크(삐 소리)로 해요. 사용: python3 tests/recorder_test.py <앱 포트>"""
import sys, requests
from playwright.sync_api import sync_playwright

B = f"http://127.0.0.1:{sys.argv[1]}"
fails = []
def check(name, ok, info=""):
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else f" {info}"))
    if not ok: fails.append(name)
root = requests.post(B + "/api/nodes", json={"parent_id": None, "position": 0, "content": "녹음 시험"}).json()["id"]
base = requests.post(B + "/api/nodes", json={"parent_id": root, "content": "회의"}).json()["id"]
kids = lambda: [n["content"] for n in requests.get(f"{B}/api/children?parent={root}&limit=20").json()["nodes"]]

requests.put(B + "/api/plugin-data/core/cmd_keys", json={"value": {"map": {"Alt+Shift+R": "record"}, "off": []}})  # 기본 단축키가 없는 명령 — 사용자가 ⌘/에서 하듯 지정해 두고 시작해요
with sync_playwright() as p:
    br = p.chromium.launch(args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"])
    pg = br.new_page(viewport={"width": 1000, "height": 760})
    pg.goto(f"{B}/#{root}"); pg.wait_for_selector(f'#tree .text[data-id="{base}"]'); pg.wait_for_timeout(400)
    def open_rec():
        pg.click(f'#tree .text[data-id="{base}"]'); pg.keyboard.press("End")
        pg.keyboard.press("Alt+Shift+R"); pg.wait_for_selector(".wfx-dialog:has([data-f=rec], [data-f=name])")
    dlg = ".wfx-dialog:has([data-f=rec], [data-f=name])"
    open_rec()
    check("⌥⇧R로 녹음 창 · 음질 기본 96 kbps", pg.locator(f"{dlg} [data-f=rate] button.on").inner_text().startswith("96"))
    pg.locator(f"{dlg} [data-f=rate] button", has_text="64").click()
    pg.locator(f"{dlg} button", has_text="녹음").click(); pg.wait_for_timeout(2300)
    t1 = pg.inner_text(f"{dlg} [data-f=time]")
    check("녹음 중: 시간이 흘러요", t1 in ("0:02", "0:03"), t1)
    check("소리 크기 막대가 움직여요", pg.evaluate(f"parseFloat(document.querySelector('{dlg} [data-f=meter] i').style.width)") > 0)
    pg.mouse.click(5, 5); pg.wait_for_timeout(200)
    check("녹음 중 바깥을 눌러도 창은 그대로", pg.locator(dlg).count() == 1)
    pg.keyboard.press(" "); pg.wait_for_timeout(1200)
    tp = pg.inner_text(f"{dlg} [data-f=time]")
    check("Space: 일시정지 (끝내기 단추에 커서가 있어도 끝나지 않아요)", pg.locator(f"{dlg} [data-phase=paused]").count() == 1 and pg.locator(f"{dlg} audio[src]").count() == 0, tp)
    pg.wait_for_timeout(800)
    check("일시정지 동안 시간은 멈춰요", pg.inner_text(f"{dlg} [data-f=time]") == tp, (tp, pg.inner_text(f"{dlg} [data-f=time]")))
    pg.keyboard.press(" "); pg.wait_for_timeout(1100)
    pg.locator(f"{dlg} button", has_text="끝내기").click(); pg.wait_for_selector(f"{dlg} audio[src]")
    pg.wait_for_function(f"document.querySelector('{dlg} audio').readyState >= 1")
    dur = pg.evaluate(f"document.querySelector('{dlg} audio').duration")
    check("끝내면 미리 듣기 (멈춘 동안은 빼고 약 3초)", 2.5 < dur < 4.6, dur)
    check("이름 칸 기본값 · 크기 · 음질", pg.input_value(f"{dlg} [data-f=name]").startswith("녹음 ") and "64 kbps" in pg.inner_text(f"{dlg} [data-f=size]"), pg.inner_text(f"{dlg} [data-f=size]"))
    pg.fill(f"{dlg} [data-f=name]", "회의 메모"); pg.keyboard.press("Enter"); pg.wait_for_timeout(1500)
    ks = kids()
    check("Enter로 넣기: 커서 항목 아래에 mp3 첨부", len(ks) == 2 and ks[1].startswith("[회의 메모](/files/") and ks[1].endswith(".mp3)"), ks)
    url = ks[1].split("](")[1].rstrip(")") if len(ks) == 2 else ""
    head = requests.get(B + url).content[:3] if url else b""
    check("올라간 파일은 mp3", head[:2] == b"\xff\xfb" or head == b"ID3", head)
    check("화면에 오디오 플레이어", pg.locator(".att-audio", has_text="회의 메모").count() == 1)
    # Esc: 녹음한 게 있으면 묻고 닫아요 · 음질은 기억
    open_rec()
    check("고른 음질(64)을 기억", pg.locator(f"{dlg} [data-f=rate] button.on").inner_text().startswith("64"))
    pg.locator(f"{dlg} button", has_text="녹음").click(); pg.wait_for_timeout(800)
    pg.keyboard.press("Escape"); pg.wait_for_selector("text=창을 닫으면 녹음이 사라져요")
    pg.keyboard.press("Escape"); pg.wait_for_timeout(300)
    check("묻는 창에서 취소하면 녹음은 계속", pg.locator(f"{dlg} [data-phase=rec]").count() == 1)
    pg.keyboard.press("Escape"); pg.wait_for_selector("text=창을 닫으면 녹음이 사라져요"); pg.keyboard.press("Enter"); pg.wait_for_timeout(500)
    check("확인하면 닫히고 아무것도 넣지 않아요", pg.locator(dlg).count() == 0 and len(kids()) == 2, kids())
    br.close()

print("\n" + ("모두 통과" if not fails else f"실패 {len(fails)}개: {fails}"))
sys.exit(1 if fails else 0)
