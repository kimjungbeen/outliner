"""명령 사용 횟수 정렬 · 명령 단축키 · 오디오 첨부 · 통째로 바꾸기 뒤 새로고침 테스트.
사용: python3 tests/commands_test.py <앱 포트> <두 번째 앱 포트>   (두 앱은 서로 다른 OUTLINER_DB 로 켜요)"""
import io
import struct
import sys
import requests
from playwright.sync_api import sync_playwright

BASE, OTHER = (f"http://127.0.0.1:{p}" for p in sys.argv[1:3])
fails = []


def check(name, cond, extra=""):
    print(("PASS " if cond else "FAIL ") + name, "" if cond else extra)
    if not cond:
        fails.append(name)


def wav(seconds=1, rate=8000):  # 조용한 WAV 파일
    data = b"\x00\x00" * rate * seconds
    return b"RIFF" + struct.pack("<I", 36 + len(data)) + b"WAVEfmt " + struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16) + b"data" + struct.pack("<I", len(data)) + data


# ---- 오디오 첨부 (서버) ----
r = requests.post(BASE + "/api/upload", files={"file": ("녹음.wav", wav())}).json()
check("오디오 업로드: kind=audio, 이미지 표시(!) 없음", r.get("kind") == "audio" and r["markdown"].startswith("[녹음]("), str(r))
f = requests.get(BASE + r["url"], headers={"Range": "bytes=0-99"})
check("오디오 파일: 이어 받기(206) + audio/ 형식", f.status_code == 206 and f.headers["Content-Type"].startswith("audio/"), f"{f.status_code} {f.headers.get('Content-Type')}")
for ext in ("mp3", "m4a", "ogg", "flac", "opus"):
    rr = requests.post(BASE + "/api/upload", files={"file": (f"a.{ext}", b"x" * 10 + ext.encode())}).json()
    if rr.get("kind") != "audio":
        check(f"오디오 확장자 .{ext}", False, str(rr))
check("목록에 없는 확장자는 거절", "error" in requests.post(BASE + "/api/upload", files={"file": ("a.exe", b"MZ")}).json())

root = requests.post(BASE + "/api/nodes", json={"parent_id": None, "position": 0, "content": "오디오 항목 " + r["markdown"]}).json()["id"]

errors = []
with sync_playwright() as p:
    br = p.chromium.launch()
    page = br.new_page(viewport={"width": 1100, "height": 800})
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(BASE)
    page.wait_for_selector("#tree .text")
    page.wait_for_selector(".att-audio audio", timeout=5000, state="attached")  # 기본 audio는 숨겨요 (앱의 조작부)
    dur = page.eval_on_selector(".att-audio audio", "a => new Promise(res => { if (a.readyState >= 1) res(a.duration); a.onloadedmetadata = () => res(a.duration); setTimeout(() => res(-1), 4000); })")
    check("화면: 오디오 플레이어 + 길이를 읽음", abs(dur - 1) < 0.1, str(dur))
    check("화면: 오디오 이름 표시", "오디오 · 녹음" in page.inner_text(".att-audio .att-name"))

    def palette_names():
        if page.is_visible(".dlg-ov:not(.out) .palette"):
            page.keyboard.press("Escape")
        page.locator("#tree .text").first.click()
        page.keyboard.press("Control+/")  # ⌘/ 명령 목록
        page.wait_for_selector(".cmdl-find")
        return page.eval_on_selector_all(".cmdl-row .cmdl-name", "els => els.map(e => e.textContent)")

    def keys_value():
        return requests.get(BASE + "/api/plugin-data/core/cmd_keys").json()["value"]

    def spy():  # 명령이 실행됐는지 세는 고리 (앱은 사용 횟수를 세지 않아요)
        page.wait_for_function("import('/commands.js').then((P) => P.paletteCommands.has('collapse'))")
        page.evaluate("""import('/commands.js').then((P) => { window.__runs = {}; for (const [n, c] of P.paletteCommands) { const r = c.run; c.run = (...a) => { window.__runs[n] = (window.__runs[n] || 0) + 1; return r(...a); }; } })""")
    uses = lambda name: page.evaluate("(n) => window.__runs?.[n] || 0", name)
    spy()

    # ---- 명령 목록: 알파벳 순 · 횟수 없음 ----
    after = palette_names()
    check("명령 목록: 알파벳 순", after == sorted(after), str(after[:8]))
    check("명령 목록: 사용 횟수 표시 없음 · 정렬 단추 없음", page.locator(".cmdl-row .cmd-count, .cmd-sort").count() == 0)
    page.keyboard.press("Escape")
    palette_names()
    page.keyboard.type("export"); page.wait_for_timeout(100)
    ex = page.eval_on_selector_all(".cmdl-row .cmdl-name", "els => els.map(e => e.textContent)")
    check("검색: export가 맨 위 (내보내기는 명령 하나로)", ex[:1] == ["export"] and "export-pdf" not in ex and "backup-all" not in ex, str(ex))
    page.keyboard.press("Escape")

    # ---- 기본 단축키 ⌥C = ca (모두 접기 — 실행됐는지는 사용 횟수로) ----
    page.locator("#tree .text").first.click()
    n0 = uses("collapse"); page.keyboard.press("Alt+c"); page.wait_for_timeout(400)
    check("기본 단축키 ⌥C → collapse 실행", uses("collapse") == n0 + 1)

    # ---- 단축키 바꾸기 ----
    palette_names()
    page.keyboard.type("collapse"); page.wait_for_timeout(100)
    page.keyboard.press("Control+Enter")
    page.wait_for_selector(".key-dlg")
    page.keyboard.press("q")  # 수식키 없음 → 쓸 수 없음
    check("단축키: 수식키 없는 키는 거절", "쓸 수 없어요" in page.inner_text(".key-note") and page.is_disabled(".key-dlg .pdf-btn.primary"))
    page.keyboard.press("Control+w")
    check("단축키: 브라우저 조합(Ctrl+W) 거절", "브라우저" in page.inner_text(".key-note"))
    page.keyboard.press("Control+/")
    check("단축키: 앱 기본 단축키(⌘/)와 겹치면 경고", "겹쳐요" in page.inner_text(".key-note") and not page.is_disabled(".key-dlg .pdf-btn.primary"))
    page.keyboard.press("Alt+Shift+q")
    check("빈 조합이면 저장 안내", "Enter" in page.inner_text(".key-note"), page.inner_text(".key-note"))
    page.keyboard.press("Enter")
    page.wait_for_timeout(300)
    check("단축키 저장 (서버)", keys_value() == {"map": {"Alt+Shift+Q": "collapse"}, "off": []}, str(keys_value()))
    check("목록에 바뀐 단축키 표시", "Alt+Shift+Q" in page.inner_text(".cmdl-row.on"), page.inner_text(".cmdl-row.on"))
    page.keyboard.press("Escape")
    page.wait_for_timeout(200)
    page.locator("#tree .text").first.click()
    txt0 = page.locator("#tree .text").first.inner_text()
    n0 = uses("collapse"); page.keyboard.press("Alt+c"); page.wait_for_timeout(400)
    check("바꾼 뒤 예전 기본값(⌥C)은 동작 안 함", uses("collapse") == n0)
    page.keyboard.press("Alt+Shift+q"); page.wait_for_timeout(400)
    check("바꾼 단축키로 실행 (글 쓰는 중에도)", uses("collapse") == n0 + 1)
    txt = page.locator("#tree .text").first.inner_text()
    check("단축키가 글자로 입력되지 않음", txt == txt0, txt)
    page.reload(); page.wait_for_selector("#tree .text"); page.wait_for_timeout(300); spy()
    page.locator("#tree .text").first.click()
    n0 = uses("collapse"); page.keyboard.press("Alt+Shift+q"); page.wait_for_timeout(400)
    check("새로고침 뒤에도 바꾼 단축키 동작", uses("collapse") == n0 + 1)
    # 다른 명령에 같은 조합 → 옮겨감 (ca는 기본값 ⌥C로 돌아가요)
    palette_names(); page.keyboard.type("home"); page.wait_for_timeout(100)
    page.click(".cmdl-row.on .cmdl-kbd")
    page.wait_for_selector(".key-dlg")
    page.keyboard.press("Alt+Shift+q")
    check("다른 명령의 조합이면 '옮겨요' 안내", "옮겨요" in page.inner_text(".key-note"))
    page.keyboard.press("Enter"); page.wait_for_timeout(300)
    check("조합이 home으로 옮겨감", keys_value()["map"] == {"Alt+Shift+Q": "home"}, str(keys_value()))
    page.fill(".cmdl-find", "collapse"); page.wait_for_timeout(200)
    check("collapse는 기본값 Alt+C로 돌아옴", "Alt+C" in page.inner_text(".cmdl-row.on"), page.inner_text(".cmdl-row.on"))
    # 지우기 → 기본값으로 (collapse)
    page.click(".cmdl-row.on .cmdl-kbd"); page.wait_for_selector(".key-dlg")
    page.click(".key-dlg .pdf-btn:has-text('지우기')"); page.wait_for_timeout(300)
    check("단축키 지우기 (기본값도 끔)", keys_value() == {"map": {"Alt+Shift+Q": "home"}, "off": ["collapse"]} and page.locator(".cmdl-row.on .cmdl-kbd.none").count() == 1, str(keys_value()))
    page.click(".cmdl-row.on .cmdl-kbd"); page.wait_for_selector(".key-dlg")
    page.click(".key-dlg .pdf-btn:has-text('기본값')"); page.wait_for_timeout(300)
    check("기본값으로 되돌리기", keys_value() == {"map": {"Alt+Shift+Q": "home"}, "off": []} and "Alt+C" in page.inner_text(".cmdl-row.on"), str(keys_value()))
    page.keyboard.press("Escape")

    # ---- 통째로 바꾸기 뒤 새 항목이 기존 항목을 덮어쓰지 않음 ----
    for i in range(300):
        requests.post(OTHER + "/api/nodes", json={"parent_id": None, "content": f"다른 {i}"})
    big = requests.get(OTHER + "/api/export/db").content
    other_tab = br.new_page(); other_tab.goto(BASE); other_tab.wait_for_selector("#tree .text")
    page.goto(BASE); page.wait_for_selector("#tree .text"); page.wait_for_timeout(500)
    other_tab.wait_for_timeout(500); other_tab.evaluate("window.__stale = 1")  # 새로고침되면 사라져요
    page.set_input_files("#importfile", files=[{"name": "big.db", "mimeType": "application/octet-stream", "buffer": big}])
    page.wait_for_selector(".pdf-dlg")
    page.click(".pdf-btn:has-text('대체하기')")
    page.wait_for_timeout(2500)
    page.wait_for_selector("#tree .text")
    other_tab.wait_for_selector("#tree .text")
    check("통째로 바꾸면 열려 있던 다른 탭도 스스로 새로고침", other_tab.evaluate("window.__stale") is None)
    check("바꾼 뒤 토스트가 새로고침 후에도 보임", "DB를 바꿨어요" in page.inner_text("#toast"))
    for tab, label in ((page, "바꾼 화면"), (other_tab, "두번째 탭")):
        tab.wait_for_selector("#tree .text")
        tab.locator("#tree .text").first.click()
        tab.keyboard.press("End"); tab.keyboard.press("Enter"); tab.keyboard.type(f"{label}에서 새 글")
    page.wait_for_timeout(2000)
    out = [l.strip() for l in requests.get(BASE + "/api/export?format=txt").text.splitlines()]
    check("통째로 바꾸기 뒤: 기존 300개 그대로 + 두 탭의 새 글 저장", sum(1 for l in out if l.startswith("다른 ")) == 300 and "바꾼 화면에서 새 글" in out and "두번째 탭에서 새 글" in out,
          f"{sum(1 for l in out if l.startswith('다른 '))} {[l for l in out if '새 글' in l]}")
    check("콘솔 오류 없음", not errors, str(errors))
    br.close()

print("\n" + ("모두 통과" if not fails else f"실패 {len(fails)}개: {fails}"))
sys.exit(1 if fails else 0)
