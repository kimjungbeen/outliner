"""오디오 · 영상 북마크: 만들기 · 위치 막대 눈금 · 목록(가기 · 이름 · 시간 고치기 · 지우기) · 링크로 열기 · 북마크 찾기 · 아래 재생 막대 · JSON 내보내기/가져오기.
사용: python3 tests/media_marks_test.py <앱 포트>"""
import json, struct, sys, requests
from playwright.sync_api import sync_playwright

B = f"http://127.0.0.1:{sys.argv[1]}"
fails = []
def check(name, ok, info=""):
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else f" {info}"))
    if not ok: fails.append(name)

rate = 8000; data = b"\x00\x00" * rate * 30
wav = b"RIFF" + struct.pack("<I", 36 + len(data)) + b"WAVEfmt " + struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16) + b"data" + struct.pack("<I", len(data)) + data
au = requests.post(B + "/api/upload", files={"file": ("노래.wav", wav)}).json()
root = requests.post(B + "/api/nodes", json={"parent_id": None, "position": 0, "content": "북마크 미디어"}).json()["id"]
nid = requests.post(B + "/api/nodes", json={"parent_id": root, "content": f"노래 {au['markdown']}"}).json()["id"]
URL = au["url"]
store = lambda: requests.get(B + "/api/plugin-data/core/media_marks").json().get("value") or {}
other = requests.post(B + "/api/nodes", json={"parent_id": None, "position": 1, "content": "다른 화면"}).json()["id"]
requests.post(B + "/api/nodes", json={"parent_id": other, "content": "빈 항목"})

with sync_playwright() as p:
    br = p.chromium.launch(args=["--autoplay-policy=no-user-gesture-required"]); pg = br.new_page()
    pg.goto(f"{B}/#{root}"); pg.wait_for_selector(".att-audio .mp-markbtn")
    pg.wait_for_function("document.querySelector('.att-audio audio').readyState >= 1")
    card = ".att-audio"
    rows = lambda: [t.replace("\n", "") for t in pg.locator(f"{card} .att-pdfmarkrow").all_text_contents()]
    # 만들기: 지금 위치(12.5초)에서 북마크 단추 → '지금 위치에 북마크' → 이름
    pg.evaluate("document.querySelector('.att-audio audio').currentTime = 12.5"); pg.wait_for_timeout(200)
    pg.click(f"{card} .mp-markbtn")
    check("북마크 칸이 열리고 '지금 위치' 단추에 시간", "0:12" in pg.inner_text(f"{card} .att-markadd"), pg.inner_text(f"{card} .att-markadd"))
    pg.click(f"{card} .att-markadd"); pg.wait_for_selector(".pdf-dlg textarea")
    check("이름 칸 기본값 = 시간", pg.input_value(".pdf-dlg textarea") == "0:12", pg.input_value(".pdf-dlg textarea"))
    pg.fill(".pdf-dlg textarea", "후렴"); pg.click(".pdf-dlg .pdf-btn.primary"); pg.wait_for_timeout(600)
    s = store()
    check("DB(media_marks)에 저장 · 시간 그대로", [(m["name"], m["t"]) for m in s.get(URL, [])] == [("후렴", 12.5)], s)
    check("목록에 '시간 · 이름'", rows() == ["0:12후렴"], rows())
    left = pg.evaluate("document.querySelector('.att-audio .mp-tick')?.style.left")
    check("위치 막대에 눈금 (12.5 / 30초 ≈ 41.7%)", left and abs(float(left[:-1]) - 41.67) < 0.5, left)
    # 두 번째는 API로 (다른 창에서 만든 것처럼) — 바뀐 저장소를 다시 받으면 목록이 시간 순으로
    pg.evaluate(f"import('/markup.js').then((M) => M.addMark('media', '{URL}', {{ t: 3, name: '시작' }}))"); pg.wait_for_timeout(400)
    check("목록은 시간 순 · 찾기 칸(둘 이상)", rows() == ["0:03시작", "0:12후렴"] and pg.is_visible(f"{card} .att-markfind"), rows())
    pg.fill(f"{card} .att-markfind", "후렴"); pg.wait_for_timeout(100)
    check("찾기로 거르기", rows() == ["0:12후렴"])
    pg.fill(f"{card} .att-markfind", "")
    # 가기: 그 자리부터 재생
    pg.locator(f"{card} .att-pdfmarkgo", has_text="시작").click(); pg.wait_for_timeout(400)
    st = pg.evaluate("(() => { const a = document.querySelector('.att-audio audio'); return [a.currentTime, a.paused]; })()")
    check("누르면 그 시간부터 재생", 3 <= st[0] < 4.5 and not st[1], st)
    pg.evaluate("document.querySelector('.att-audio audio').pause()")
    # 고치기: 이름 · 시간 (한 창에서)
    edit = lambda name: (pg.locator(f"{card} .att-pdfmarkrow", has_text=name).locator("[aria-label='이름 · 시간 고치기']").click(), pg.wait_for_selector(".pdf-dlg .mark-edit"))
    fields = lambda: pg.locator(".pdf-dlg .mark-edit input")
    marks = lambda: [(m["name"], m["t"]) for m in store()[URL]]
    edit("시작")
    check("고치기 창: 이름 · 시간 칸", [fields().nth(0).input_value(), fields().nth(1).input_value()] == ["시작", "0:03"])
    fields().nth(0).fill("도입"); pg.keyboard.press("Enter"); pg.wait_for_timeout(500)
    check("이름 고치기 (Enter) · 안 고친 시간은 그대로", marks() == [("후렴", 12.5), ("도입", 3)], marks())
    edit("후렴"); fields().nth(0).fill("후렴 고침"); pg.click(".pdf-dlg .pdf-btn.primary"); pg.wait_for_timeout(500)
    check("시간 칸을 안 고치면 소수점까지 그대로 (12.5 → 12.5)", marks()[0] == ("후렴 고침", 12.5), marks())
    edit("후렴"); fields().nth(1).fill("말도 안 됨"); pg.click(".pdf-dlg .pdf-btn.primary"); pg.wait_for_timeout(300)
    check("틀린 시간: 창은 그대로 · 알림", pg.locator(".pdf-dlg .mark-edit").count() == 1 and "1:23" in pg.inner_text("#toast"))
    fields().nth(1).fill("5:00"); pg.keyboard.press("Enter"); pg.wait_for_timeout(300)
    check("곡보다 긴 시간: 창은 그대로", pg.locator(".pdf-dlg .mark-edit").count() == 1 and "길어요" in pg.inner_text("#toast"))
    fields().nth(1).fill("0:20"); pg.keyboard.press("Enter"); pg.wait_for_timeout(500)
    check("시간 고치기 (0:20)", marks()[0] == ("후렴 고침", 20), marks())
    check("목록 · 눈금이 새 시간으로", rows() == ["0:03도입", "0:20후렴 고침"] and abs(float(pg.evaluate("[...document.querySelectorAll('.att-audio .mp-tick')].map(t => parseFloat(t.style.left)).sort((a, b) => b - a)[0]")) - 66.67) < 0.5, rows())
    pg.evaluate("document.querySelector('.att-audio audio').currentTime = 7.3"); pg.wait_for_timeout(200)
    edit("후렴"); pg.click(".pdf-dlg .mark-now"); pg.keyboard.press("Enter"); pg.wait_for_timeout(500)
    check("'지금 위치로' 단추 (7.3초 그대로)", marks()[0] == ("후렴 고침", 7.3), marks())
    edit("후렴"); fields().nth(0).fill("후렴"); fields().nth(1).fill("12.5"); pg.keyboard.press("Enter"); pg.wait_for_timeout(500)
    edit("후렴"); pg.keyboard.press("Escape"); pg.wait_for_timeout(300)
    check("Esc는 고치지 않고 닫기", marks()[0] == ("후렴", 12.5) and pg.locator(".pdf-dlg").count() == 0, marks())
    pg.locator(f"{card} .att-pdfmarkrow", has_text="도입").locator("[aria-label='북마크 지우기']").click()
    pg.wait_for_selector("text=지울까요"); pg.keyboard.press("Enter"); pg.wait_for_timeout(500)
    check("지우기는 한 번 더 묻고 지움", [m["name"] for m in store()[URL]] == ["후렴"], store())
    # 링크로 열기: 다른 화면에서 열어도 그 화면으로 가서 그 시간부터
    mid = store()[URL][0]["id"]
    pg.goto(f"{B}/#"); pg.wait_for_selector("#tree .text")
    pg.goto(f"{B}/?media={URL}&t=12.5&n={nid}#{root}"); pg.wait_for_timeout(2000)
    st = pg.evaluate("(() => { const a = document.querySelector('.att-audio audio'); return a && [a.currentTime, a.paused]; })()")
    check("링크(?media=…&t=)로 열면 그 화면에서 그 시간부터 재생", st and 12.5 <= st[0] < 15 and not st[1], st)
    check("링크를 연 뒤 주소창은 원래 모양", pg.evaluate("location.search") == "")
    pg.evaluate("document.querySelector('.att-audio audio').pause()")
    # 화면에 플레이어가 없으면 아래 재생 막대에서
    pg.goto(f"{B}/#{other}"); pg.wait_for_selector("#tree .text"); pg.wait_for_timeout(300)
    pg.evaluate(f"import('/app.js').then((A) => A.openAppLink(location.origin + '/?media={URL}&t=20#{other}'))"); pg.wait_for_timeout(1500)
    st = pg.evaluate("(() => { const m = document.querySelector('.mplayer video'); return m && [m.currentTime, m.paused, document.querySelector('.mplayer').hidden]; })()")
    check("화면에 없으면 아래 재생 막대가 그 시간부터", st and 20 <= st[0] < 23 and not st[1] and not st[2], st)
    check("재생 막대에도 북마크 단추 · 눈금", pg.locator(".mplayer .mp-markbtn").count() == 1 and pg.locator(".mplayer .mp-tick").count() == 1)
    pg.evaluate("document.querySelector('.mplayer video').pause()")
    # 북마크 찾기 (bookmarks): 오디오도 나와요
    pg.evaluate("import('/marks.js').then((M) => M.openMarkFinder())"); pg.wait_for_selector(".markfind-row")
    row = pg.locator(".markfind-row", has_text="후렴")
    check("북마크 찾기에 '오디오 · 이름 · 파일 · 시간'", row.count() == 1 and "오디오" in row.inner_text() and "0:12" in row.inner_text(), row.all_inner_texts())
    pg.evaluate("navigator.clipboard.writeText = (t) => { window.__copied = t; return Promise.resolve(); }")
    row.hover(); row.locator(".markfind-link").click(); pg.wait_for_timeout(300)
    copied = pg.evaluate("window.__copied || ''")
    check("북마크 찾기: 줄의 링크 복사 (그 자리 · 시간으로 열리는 링크)", "media=" in copied and "t=12" in copied and pg.locator(".markfind-row").count() >= 1, copied)
    pg.evaluate("window.__copied = ''"); pg.keyboard.press("ControlOrMeta+c"); pg.wait_for_timeout(300)
    check("북마크 찾기: ⌘C로도 링크 복사", "media=" in pg.evaluate("window.__copied || ''"))
    pg.keyboard.press("Escape"); pg.wait_for_timeout(200)
    # JSON 내보내기에 담기고 · 가져오면 되살아나요
    js = json.loads(requests.get(f"{B}/api/export?format=json&ids={root}").content)
    got = js[0]["children"][0].get("media_marks", {})
    check("JSON 내보내기에 media_marks", [m["name"] for m in got.get(URL, [])] == ["후렴"], got)
    requests.put(B + "/api/plugin-data/core/media_marks", json={"value": {}})
    pg.reload(); pg.wait_for_selector("#tree .text")
    pg.set_input_files("#importfile", files=[{"name": "백업.json", "mimeType": "application/json", "buffer": json.dumps(js).encode()}]); pg.wait_for_timeout(2000)
    check("JSON을 가져오면 오디오 북마크도 되살아남", [(m["name"], m["t"]) for m in store().get(URL, [])] == [("후렴", 12.5)], store())
    br.close()

print("\n" + ("모두 통과" if not fails else f"실패 {len(fails)}개: {fails}"))
sys.exit(1 if fails else 0)
