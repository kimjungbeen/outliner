"""새 단축키 배치 · 전체 백업(ZIP) · PDF 제목 단계 테스트.
사용: python3 tests/keys_test.py <앱 포트> <두 번째 앱 포트>   (서로 다른 OUTLINER_DB 로 켜요)"""
import io
import sys
import zipfile
import requests
from playwright.sync_api import sync_playwright

BASE, OTHER = (f"http://127.0.0.1:{p}" for p in sys.argv[1:3])
fails = []


def check(name, cond, extra=""):
    print(("PASS " if cond else "FAIL ") + name, "" if cond else extra)
    if not cond:
        fails.append(name)


def add(parent, content, collapsed=0):
    nid = requests.post(BASE + "/api/nodes", json={"parent_id": parent, "content": content}).json()["id"]
    if collapsed:
        requests.patch(BASE + f"/api/nodes/{nid}", json={"collapsed": 1})
    return nid


# 트리: 루트 > A > A1 > A1a > A1a-i ,  루트 > B > B1   (모두 접힌 상태)
root = add(None, "키루트")
A = add(root, "A", 1); A1 = add(A, "A1", 1); A1a = add(A1, "A1a", 1); add(A1a, "A1a-i")
B = add(root, "B", 1); add(B, "B1")
sib_prev = add(None, "앞형제"); sib_next = None
requests.post(BASE + "/api/move", json={"ids": [sib_prev], "parent_id": None, "before_id": root})
sib_next = add(None, "뒤형제")
requests.post(BASE + "/api/move", json={"ids": [sib_next], "parent_id": None, "after_id": root})

errors = []
with sync_playwright() as p:
    br = p.chromium.launch()
    page = br.new_page(viewport={"width": 1100, "height": 850})
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(f"{BASE}/#{root}")
    page.wait_for_selector("#tree .text")
    texts = lambda: page.eval_on_selector_all("#tree .text", "els => els.map(e => e.textContent)")

    def cursor(t):
        page.locator("#tree .text", has_text=t).first.click()
        page.keyboard.press("End")

    # ---- ⌘↓ 한 단계씩 / ⌘↑ 직계만 → 자신 ----
    cursor("A")
    page.keyboard.press("Control+ArrowDown"); page.wait_for_timeout(500)
    check("⌘↓ 1번: A 펼침", texts() == ["A", "A1", "B"], str(texts()))
    page.keyboard.press("Control+ArrowDown"); page.wait_for_timeout(500)
    check("⌘↓ 2번: 한 단계 더", texts() == ["A", "A1", "A1a", "B"], str(texts()))
    page.keyboard.press("Control+ArrowDown"); page.wait_for_timeout(500)
    check("⌘↓ 3번: 한 단계 더", texts() == ["A", "A1", "A1a", "A1a-i", "B"], str(texts()))
    page.keyboard.press("Control+ArrowDown"); page.wait_for_timeout(400)
    check("⌘↓ 더 펼칠 게 없으면 그대로", texts() == ["A", "A1", "A1a", "A1a-i", "B"], str(texts()))
    page.keyboard.press("Control+ArrowUp"); page.wait_for_timeout(500)
    check("⌘↑ 1번: 직계 자녀만 남기고 한 번에 접힘", texts() == ["A", "A1", "B"], str(texts()))
    page.keyboard.press("Control+ArrowUp"); page.wait_for_timeout(500)
    check("⌘↑ 2번: 자신 접힘", texts() == ["A", "B"], str(texts()))
    page.keyboard.press("Control+ArrowDown"); page.wait_for_timeout(500)
    check("다시 ⌘↓: 직계만 (깊은 단계는 접혀 있음)", texts() == ["A", "A1", "B"], str(texts()))
    page.reload(); page.wait_for_selector("#tree .text")
    check("펼침 상태가 저장됨", texts() == ["A", "A1", "B"], str(texts()))
    # 제목에서 ⌘↓: 화면 전체를 한 단계씩
    page.click("#title"); page.keyboard.press("End")
    page.keyboard.press("Control+ArrowDown"); page.wait_for_timeout(500)
    check("제목에서 ⌘↓: 보이는 가장 얕은 접힌 단계(B)를 펼침", texts() == ["A", "A1", "B", "B1"], str(texts()))
    page.keyboard.press("Control+ArrowDown"); page.wait_for_timeout(500)
    check("제목에서 ⌘↓ 한 번 더: 다음 단계(A1)", texts() == ["A", "A1", "A1a", "B", "B1"], str(texts()))
    page.keyboard.press("Control+ArrowUp"); page.wait_for_timeout(500)
    check("제목에서 ⌘↑: 직계(A·B)만", texts() == ["A", "B"], str(texts()))

    # ---- ⌘⇧↑↓ 항목 옮기기 ----
    cursor("B")
    page.keyboard.press("Control+Shift+ArrowUp"); page.wait_for_timeout(500)
    check("⌘⇧↑ 항목 위로 옮기기", texts() == ["B", "A"], str(texts()))
    page.keyboard.press("Control+Shift+ArrowDown"); page.wait_for_timeout(500)
    check("⌘⇧↓ 항목 아래로 옮기기", texts() == ["A", "B"], str(texts()))

    # ---- ⌘⇧↑↓ 계층을 넘어 옮기기 ----
    X = add(None, "넘기루트")
    P1 = add(X, "P1"); add(P1, "a1"); add(P1, "a2")
    P2 = add(X, "P2"); b1 = add(P2, "b1")
    P3 = add(X, "P3", 0); add(P3, "c1"); requests.patch(BASE + f"/api/nodes/{P3}", json={"collapsed": 1})
    page.goto(f"{BASE}/#{X}"); page.wait_for_selector("#tree .text")
    tree = lambda: requests.get(BASE + f"/api/export?format=txt&ids={X}").text.splitlines()[1:]
    cursor("b1")
    page.keyboard.press("Control+Shift+ArrowUp"); page.wait_for_timeout(700)
    check("맨 위에서 ⌘⇧↑ → 부모의 이전 형제(P1) 안 맨 아래로", tree() == ["\tP1", "\t\ta1", "\t\ta2", "\t\tb1", "\tP2", "\tP3", "\t\tc1"], str(tree()))
    check("옮긴 뒤에도 커서 유지", page.evaluate("document.activeElement.textContent") == "b1")
    page.keyboard.press("Control+Shift+ArrowDown"); page.wait_for_timeout(700)
    check("맨 아래에서 ⌘⇧↓ → 부모의 다음 형제(빈 P2) 안으로", tree() == ["\tP1", "\t\ta1", "\t\ta2", "\tP2", "\t\tb1", "\tP3", "\t\tc1"], str(tree()))
    page.keyboard.press("Control+Shift+ArrowDown"); page.wait_for_timeout(900)
    check("다시 ⌘⇧↓ → 접혀 있던 P3를 펼치고 맨 위로", tree() == ["\tP1", "\t\ta1", "\t\ta2", "\tP2", "\tP3", "\t\tb1", "\t\tc1"] and texts()[-2:] == ["b1", "c1"], str(tree()) + str(texts()))
    check("커서 유지 (P3 펼친 뒤)", page.evaluate("document.activeElement.textContent") == "b1")
    page.keyboard.press("Control+z"); page.wait_for_timeout(800)
    check("⌘Z로 되돌리기", tree()[3:5] == ["\tP2", "\t\tb1"], str(tree()))
    cursor("P1")
    page.keyboard.press("Control+Shift+ArrowUp"); page.wait_for_timeout(500)
    check("화면 최상위 단계 맨 위에서는 그대로", tree()[0] == "\tP1", str(tree()))
    page.goto(f"{BASE}/#{root}"); page.wait_for_selector("#tree .text")

    # ---- ⌘. 줌인 · ⌘, 줌아웃 ----
    cursor("A")
    page.keyboard.press("Control+."); page.wait_for_timeout(600)
    check("⌘.: 커서 항목 안으로 줌인", page.evaluate("location.hash") == f"#{A}" and page.inner_text("#title") == "A", page.evaluate("location.hash"))
    page.locator("#tree .text").first.click()
    page.keyboard.press("Control+,"); page.wait_for_timeout(600)
    check("⌘,: 줌아웃", page.evaluate("location.hash") == f"#{root}", page.evaluate("location.hash"))
    check("줌아웃하면 나온 항목에 커서", page.evaluate("document.activeElement.textContent") == "A")

    # ---- ⌘⇧,↓: 앞뒤 형제 항목 안으로 ----
    page.keyboard.press("Control+Shift+."); page.wait_for_timeout(600)
    check("⌘⇧.: 다음 형제 안으로", page.evaluate("location.hash") == f"#{sib_next}", page.evaluate("location.hash"))
    page.keyboard.press("Control+Shift+,"); page.wait_for_timeout(600)
    page.keyboard.press("Control+Shift+,"); page.wait_for_timeout(600)
    check("⌘⇧, 두 번: 앞 형제 안으로", page.evaluate("location.hash") == f"#{sib_prev}", page.evaluate("location.hash"))

    # ---- ⌘/ 명령 목록: 이름을 치고 Enter → 그 명령 (home: 기본 단축키 없음) ----
    page.goto(f"{BASE}/#{root}"); page.wait_for_selector("#tree .text")
    cursor("A")
    page.keyboard.press("Control+/"); page.wait_for_selector(".cmdl-find")
    page.keyboard.type("home"); page.wait_for_timeout(200)
    check("⌘/ 명령 목록: 이름이 똑같은 명령이 맨 위", page.inner_text(".cmdl-row.on .cmdl-name") == "home", page.inner_text(".cmdl-row.on"))
    page.keyboard.press("Enter"); page.wait_for_timeout(600)
    check("Enter → home 실행 (홈으로)", page.evaluate("location.hash") in ("", "#"), page.evaluate("location.hash"))
    check("명령 목록 창이 닫힘", page.locator(".cmdl-dlg").count() == 0)

    # 기본 단축키: ⌃+알파벳 하나(Linux · Windows Alt+알파벳)뿐, Mac 글 칸의 ⌃ 키 · 브라우저 Alt+D E F와 겹치지 않아요
    page.goto(f"{BASE}/#{root}"); page.wait_for_selector("#tree .text")
    page.keyboard.press("Control+/"); page.wait_for_selector(".cmdl-find")
    rows = page.evaluate("[...document.querySelectorAll('.cmdl-row')].map(e => [e.querySelector('.cmdl-name').textContent, e.querySelector('.cmdl-kbd').classList.contains('none') ? '' : e.querySelector('.cmdl-kbd').textContent])")
    keyed = {n: k for n, k in rows if k}
    check("기본 단축키는 모두 Alt+알파벳 하나", all(len(k) == 5 and k.startswith("Alt+") and k[-1].isalpha() for k in keyed.values()), str(keyed))
    check("Mac 글 칸 ⌃ 키 · Alt+D E F와 안 겹침", not set(k[-1] for k in keyed.values()) & set("ABDEFHKLNOPTVWY"), str(keyed))
    check("기본 단축키끼리 겹치지 않음", len(keyed) == len(set(keyed.values())), str(keyed))
    check("기본 단축키: collapse ⌃C · export ⌃X · replace ⌃G", keyed.get("collapse") == "Alt+C" and keyed.get("export") == "Alt+X" and keyed.get("replace") == "Alt+G", str(keyed))
    check("jump · find · bold · home은 기본 단축키 없음", not {"jump", "find", "bold", "home"} & set(keyed), str(keyed))
    check("앱 자체 키도 목록 아래에 (⌘/ · ⌘.)", "명령 목록 (이 창)" in page.inner_text(".cmdl-list"))
    page.keyboard.press("Escape")

    # ---- 전체 백업 ZIP ----
    up = requests.post(BASE + "/api/upload", files={"file": ("사진.png", b"\x89PNG\r\n\x1a\n" + b"x" * 100)}).json()
    add(root, "첨부 " + up["markdown"])
    z = requests.get(BASE + "/api/export/all")
    zf = zipfile.ZipFile(io.BytesIO(z.content))
    names = zf.namelist()
    check("전체 백업: outliner.db + files/ + manifest", "outliner.db" in names and f"files/{up['url'].split('/')[-1]}" in names and "manifest.json" in names, str(names))
    pre = requests.post(OTHER + "/api/import/db", files={"file": ("full.zip", z.content)}, data={"mode": "check"}).json()
    check("다른 기기 미리보기: 첨부 개수, 아직 안 넣음", pre.get("files") == 1 and "files_added" not in pre and requests.get(OTHER + up["url"]).status_code == 404, str(pre))
    r = requests.post(OTHER + "/api/import/db", files={"file": ("full.zip", z.content)}, data={"mode": "replace"}).json()
    check("다른 기기 통째로 바꾸기: 첨부도 들어옴", r.get("files_added") == 1 and requests.get(OTHER + up["url"]).status_code == 200, str(r))
    check("다른 기기 내용 같음", requests.get(OTHER + "/api/export?format=txt").text == requests.get(BASE + "/api/export?format=txt").text)
    n = len(requests.get(OTHER + "/api/export?format=txt").text.splitlines())
    r2 = requests.post(OTHER + "/api/import/db", files={"file": ("full.zip", z.content)}, data={"mode": "append"}).json()
    check("같은 ZIP 아래에 추가: 항목이 한 벌 더 · 첨부는 이미 있음", r2.get("mode") == "append" and r2.get("files_added") == 0
          and len(requests.get(OTHER + "/api/export?format=txt").text.splitlines()) == 2 * n, str(r2))
    evil = io.BytesIO()
    with zipfile.ZipFile(evil, "w") as e:
        e.writestr("outliner.db", zf.read("outliner.db")); e.writestr("files/../../evil.png", b"x"); e.writestr("../evil.txt", b"x")
    r3 = requests.post(OTHER + "/api/import/db", files={"file": ("evil.zip", evil.getvalue())}, data={"mode": "append"}).json()
    check("ZIP 안의 이상한 경로는 무시", r3.get("files") == 0, str(r3))
    check("DB 없는 ZIP은 거절", "error" in requests.post(OTHER + "/api/import/db", files={"file": ("x.zip", b"PK\x03\x04garbage")}, data={"mode": "replace"}).json())

    # 화면에서 ZIP 가져오기 창
    page.goto(OTHER); page.wait_for_selector("#tree .text")
    page.set_input_files("#importfile", files=[{"name": "full.zip", "mimeType": "application/zip", "buffer": z.content}])
    page.wait_for_selector(".pdf-dlg")
    dlg = page.inner_text(".pdf-dlg")
    check("ZIP 가져오기 창: 제목·첨부 안내", "전체 백업 가져오기" in dlg and "첨부 파일 1개" in dlg, dlg)
    page.keyboard.press("Escape")
    # ---- Mac: 명령 단축키는 ⌃(Control)+알파벳, ⌘는 앱 기본 단축키 ----
    mctx = br.new_context(viewport={"width": 1100, "height": 850})
    mctx.add_init_script("Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' })")
    mac = mctx.new_page(); mac.on("pageerror", lambda e: errors.append(str(e)))
    mac.goto(f"{BASE}/#{root}"); mac.wait_for_selector("#tree .text")
    mac.locator("#tree .text", has_text="A").first.click(); mac.keyboard.press("End")
    mac.keyboard.press("Meta+/"); mac.wait_for_selector(".cmdl-find")
    mac.keyboard.type("collapse"); mac.wait_for_timeout(200)
    check("Mac 명령 목록: 명령 단축키는 ⌃ (collapse = ⌃C)", "⌃C" in mac.inner_text(".cmdl-row.on"), mac.inner_text(".cmdl-row.on"))
    mac.keyboard.press("Escape"); mac.wait_for_timeout(200)
    mac.locator("#tree .text", has_text="A").first.click(); mac.keyboard.press("Meta+."); mac.wait_for_timeout(700)
    check("Mac ⌘. → 줌인", mac.evaluate("location.hash") == f"#{A}", mac.evaluate("location.hash"))
    mac.locator("#tree .text").first.click(); mac.keyboard.press("Control+a"); mac.wait_for_timeout(300)
    check("Mac ⌃A는 명령이 아님 (글 칸의 줄 앞으로)", mac.evaluate("location.hash") == f"#{A}" and not mac.locator(".wfx-dialog, .cmdl-dlg").count(), mac.evaluate("location.hash"))
    mac.goto(f"{BASE}/#{root}"); mac.wait_for_selector("#tree .text")
    mac.locator("#tree .text", has_text="A").first.click(); mac.keyboard.press("Alt+h"); mac.wait_for_timeout(500)
    check("Mac ⌥H는 명령이 아님 (그대로)", mac.evaluate("location.hash") == f"#{root}")
    mctx.close()
    check("콘솔 오류 없음", not errors, str(errors))
    br.close()

# ---- PDF 제목 단계 (H1~H6) ----
print("\n" + ("모두 통과" if not fails else f"실패 {len(fails)}개: {fails}"))
sys.exit(1 if fails else 0)
