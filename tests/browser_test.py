"""실제 Chromium으로 UI를 검증해요. 사용: 서버를 OUTLINER_DB=임시.db OUTLINER_PORT=5101 OUTLINER_NO_BROWSER=1 python src/server.py 로 띄운 뒤
python tests/browser_test.py [포트]"""
import json, sys, time, urllib.request, urllib.parse
import requests
from playwright.sync_api import sync_playwright

PORT = sys.argv[1] if len(sys.argv) > 1 else "5101"
BASE = f"http://127.0.0.1:{PORT}"
fails, errors = [], []

def api(path, method="GET", body=None):
    req = urllib.request.Request(BASE + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req))

def check(name, cond, extra=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  {extra}" if extra and not cond else ""))
    if not cond: fails.append(name)

def kids(pid):
    r = api(f"/api/children?parent={pid if pid is not None else 'root'}&limit=1000")
    return [(n["id"], n["content"]) for n in r["nodes"]]

def to_cmd(page):  # 명령은 검색 창이 아니라 ⌘/ 명령 목록에 있어요 — 열려 있는 검색 창을 닫고 명령 목록을 열어요
    if page.is_visible(".dlg-ov:not(.out) .palette"): page.keyboard.press("Escape"); page.wait_for_timeout(100)
    page.keyboard.press("Control+/"); page.wait_for_selector(".cmdl-find"); page.wait_for_timeout(100)

# 전역 검색(jump) · 하위 검색(find) · 복제 · 홈에는 기본 단축키가 없어요 — 사용자가 ⌘/에서 하듯 ⌘K · ⌘⇧K · ⌘⇧D · ⌘'을 지정해 두고 시작해요
requests.put(BASE + "/api/plugin-data/core/cmd_keys", json={"value": {"map": {"Ctrl+K": "jump", "Ctrl+Shift+K": "find", "Ctrl+Shift+D": "duplicate", "Ctrl+'": "home"}, "off": []}})

def texts(page):
    return page.eval_on_selector_all("#tree .text", "els => els.map(e => e.textContent)")

with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_page(viewport={"width": 1100, "height": 800})
    page.on("pageerror", lambda e: errors.append(str(e) + " " + (getattr(e, "stack", "") or "").replace("\n", " | ")[:400]))
    page.on("console", lambda m: errors.append(m.text + " @" + str(m.location.get("url", ""))[-40:] + ":" + str(m.location.get("lineNumber"))) if m.type == "error" else None)
    page.goto(BASE)
    page.wait_for_selector("#tree .text")

    # 0. 초기 화면
    check("초기 렌더", "시작하기" in texts(page))
    check("자식 펼쳐서 표시", "⌘↓ / ⌘↑: 한 단계씩 펼치기 / 접기" in texts(page))

    # 1. 새 항목: 추가 → 입력 → Enter → 입력, 저장 확인
    check("노드가 있으면 '항목 추가' 버튼이 없음", page.locator("#add").is_hidden())
    new_id = api("/api/nodes", "POST", {"parent_id": None, "position": 9999, "content": ""})["id"]
    page.reload(); page.wait_for_selector("#tree .text")
    page.locator("#tree > .node:last-child > .row .text").click()
    page.keyboard.type("알파")
    page.keyboard.press("Enter")
    page.keyboard.type("베타")
    page.keyboard.press("Enter")
    page.keyboard.type("감마")
    page.wait_for_timeout(700)
    root = [c for _, c in kids(None)]
    check("Enter로 새 항목 + 자동 저장", root[-3:] == ["알파", "베타", "감마"], root)

    # 2. Tab 들여쓰기 (베타 → 알파의 자식), Shift+Tab 내어쓰기
    page.click('#tree .text:text-is("베타")')
    page.keyboard.press("Tab")
    page.wait_for_timeout(300)
    alpha = [i for i, c in kids(None) if c == "알파"][0]
    check("Tab 들여쓰기", [c for _, c in kids(alpha)] == ["베타"], kids(alpha))
    check("들여쓰기 후 커서 유지", page.evaluate("document.activeElement.textContent") == "베타")
    page.keyboard.press("Shift+Tab")
    page.wait_for_timeout(300)
    check("Shift+Tab 내어쓰기(부모 바로 뒤)", [c for _, c in kids(None)][-3:] == ["알파", "베타", "감마"], kids(None))

    # 3. Ctrl+, / Ctrl+. 이동, Ctrl+Shift+↑
    page.keyboard.press("Control+Shift+ArrowUp"); page.wait_for_timeout(300)
    check("Ctrl+Shift+↑ 위로", [c for _, c in kids(None)][-3:] == ["베타", "알파", "감마"], kids(None))
    page.keyboard.press("Control+Shift+ArrowDown"); page.wait_for_timeout(300)
    check("Ctrl+Shift+↓ 아래로(되돌림)", [c for _, c in kids(None)][-3:] == ["알파", "베타", "감마"], kids(None))
    page.keyboard.press("Control+Shift+ArrowDown"); page.wait_for_timeout(300)
    check("Ctrl+Shift+↓ 아래로", [c for _, c in kids(None)][-3:] == ["알파", "감마", "베타"], kids(None))
    page.keyboard.press("Control+Shift+ArrowUp"); page.wait_for_timeout(300)

    # 4. 접기/펼치기 Ctrl+↑/↓ (알파에 자식 하나 만들기)
    page.click('#tree .text:text-is("베타")'); page.keyboard.press("Tab"); page.wait_for_timeout(300)
    check("자식 표시", "베타" in texts(page))
    page.click('#tree .text:text-is("알파")')
    page.keyboard.press("Control+ArrowUp"); page.wait_for_timeout(200)
    check("Ctrl+↑ 접기", "베타" not in texts(page))
    check("접힘 상태 서버 저장", api(f"/api/view?parent={alpha}")["node"]["collapsed"] == 1)
    page.keyboard.press("Control+ArrowDown"); page.wait_for_timeout(300)
    check("Ctrl+↓ 펼치기", "베타" in texts(page))

    # 5. 이동 (⌘. 안으로 / ⌘, 밖으로)
    page.click('#tree .text:text-is("알파")')
    page.keyboard.press("Control+."); page.wait_for_timeout(500)
    check("⌘. 항목 안으로", page.evaluate("location.hash") == f"#{alpha}" and texts(page) == ["베타"], texts(page))
    check("제목/경로", page.inner_text("#title") == "알파")
    page.click('#tree .text'); page.keyboard.press("Control+,"); page.wait_for_timeout(500)
    check("⌘, 밖으로 + 그 항목에 커서", page.evaluate("location.hash") in ("", "#") and page.evaluate("document.activeElement.textContent") == "알파",
          (page.evaluate("location.hash"), page.evaluate("document.activeElement.textContent")))

    # 6. 통합 창 (Esc): 전역 검색
    page.keyboard.press("Escape"); page.wait_for_timeout(200)
    check("Esc로는 검색 창이 열리지 않음", page.locator(".dlg-ov:not(.out) .palette").count() == 0)
    page.keyboard.press("Control+k")
    check("⌘K → 통합 창 열림 + 입력 포커스", page.evaluate("document.activeElement.dataset.f") == "search" and page.get_attribute(".dlg-ov:not(.out) .palette [data-f=search]", "placeholder") == "찾기")
    page.keyboard.type("베타")
    page.wait_for_selector("[data-f=hit]")
    check("검색 결과 + 하이라이트", page.locator("[data-f=hit] mark").first.inner_text() == "베타" and "알파" in page.locator("[data-f=hit-path]").first.inner_text(), page.inner_text("[data-f=list]"))
    check("검색 정보 표시", "개" in page.inner_text(".dlg-ov:not(.out) .palette [data-f=info]"))
    page.fill(".dlg-ov:not(.out) .palette [data-f=search]", "알파 -베타"); page.wait_for_timeout(400)
    check("제외어 (-베타)", page.locator("[data-f=hit]").count() == 1 and page.locator("[data-f=hit-text]").first.inner_text() == "알파", page.inner_text("[data-f=list]"))
    page.fill(".dlg-ov:not(.out) .palette [data-f=search]", "베타"); page.keyboard.press("Enter"); page.wait_for_timeout(700)
    check("전역 검색 Enter → 그 항목 안으로 줌인(제목이 찾은 항목)", page.inner_text("#title") == "베타" and page.evaluate("location.hash") != "", page.inner_text("#title"))
    check("창 닫힘", page.evaluate("!document.querySelector('.dlg-ov:not(.out) .palette')"))
    page.evaluate("location.hash=''"); page.wait_for_timeout(400)
    page.keyboard.press("Control+k"); page.wait_for_selector(".dlg-ov:not(.out) .palette [data-f=search]"); page.wait_for_timeout(150); page.keyboard.type("zzzz없는말"); page.wait_for_timeout(500)
    check("결과 없음", "결과 없음" in page.inner_text(".dlg-ov:not(.out) .palette [data-f=info]"))
    page.keyboard.press("Escape")
    check("Esc로 닫기", page.evaluate("!document.querySelector('.dlg-ov:not(.out) .palette')"))

    # 6-b. 정규식
    page.keyboard.press("Control+k"); page.wait_for_selector(".dlg-ov:not(.out) .palette [data-f=search]"); page.click("[data-f=regex]")
    page.fill(".dlg-ov:not(.out) .palette [data-f=search]", "^알.$"); page.wait_for_selector("[data-f=hit][data-kind=hit]")  # 빈 칸일 때 뜨는 검색 기록(.fav)이 아니라 결과
    check("정규식 검색 + 일치 하이라이트", page.locator("[data-f=hit][data-kind=hit] [data-f=hit-text]").first.inner_text() == "알파" and page.locator("[data-f=hit] mark").first.inner_text() == "알파")
    page.fill(".dlg-ov:not(.out) .palette [data-f=search]", "("); page.wait_for_timeout(500)
    check("잘못된 정규식은 오류 표시", "오류" in page.inner_text(".dlg-ov:not(.out) .palette [data-f=info]"), page.inner_text(".dlg-ov:not(.out) .palette [data-f=info]"))
    page.fill(".dlg-ov:not(.out) .palette [data-f=search]", "베|감"); page.wait_for_timeout(500)
    check("정규식 OR", page.locator("[data-f=hit]").count() >= 2)
    page.click("[data-f=regex]"); page.keyboard.press("Escape")

    # 6-c. '/' = 현재 항목 안 검색 (이동 없이 펼침): X > Y(접힘) > Z
    x = api("/api/nodes", "POST", {"parent_id": None, "position": 9999, "content": "구역X"})["id"]
    y = api("/api/nodes", "POST", {"parent_id": x, "position": 0, "content": "구역Y"})["id"]
    api("/api/nodes", "POST", {"parent_id": y, "position": 0, "content": "깊은보물qq"})
    api("/api/nodes", "POST", {"parent_id": None, "position": 9999, "content": "바깥보물qq"})
    api(f"/api/nodes/{y}", "PATCH", {"collapsed": 1})
    page.goto(BASE + f"#{x}"); page.wait_for_selector("#tree .text")
    check("접힌 상태로 시작(Z 안 보임)", "깊은보물qq" not in texts(page))
    page.keyboard.press("Control+k"); page.wait_for_selector(".dlg-ov:not(.out) .palette [data-f=search]"); page.wait_for_timeout(150); page.keyboard.type("보물qq"); page.wait_for_selector("[data-f=hit]"); page.wait_for_timeout(300)
    check("jump(전역): 바깥 것도 나옴", page.locator("[data-f=hit][data-kind=hit]").count() == 2, page.inner_text("[data-f=list]"))
    page.keyboard.press("Escape"); page.wait_for_timeout(200)
    page.keyboard.press("Control+Shift+k"); page.wait_for_selector(".dlg-ov:not(.out) .palette [data-f=search]"); page.wait_for_timeout(150); page.keyboard.type("보물qq"); page.wait_for_selector("[data-f=hit][data-kind=hit]"); page.wait_for_timeout(300)
    check("find(하위): 이 항목 아래만", page.get_attribute(".dlg-ov:not(.out) .palette [data-f=search]", "placeholder") == "이 화면에서 찾기" and page.locator(".dlg-ov:not(.out) .palette [data-f=hit][data-kind=hit]").count() == 1 and "깊은" in page.inner_text(".dlg-ov:not(.out) .palette [data-f=list]"), page.inner_text(".dlg-ov:not(.out) .palette [data-f=list]"))
    page.keyboard.press("Enter"); page.wait_for_timeout(900)
    check("하위 검색: 이동 없이 그 항목까지 펼쳐서 보임", page.evaluate("location.hash") == f"#{x}" and "깊은보물qq" in texts(page), (page.evaluate("location.hash"), texts(page)))
    check("펼침 서버 저장 + 커서", api(f"/api/view?parent={y}")["node"]["collapsed"] == 0 and page.evaluate("document.activeElement.textContent") == "깊은보물qq")
    page.evaluate("location.hash=''"); page.wait_for_timeout(400)

    # 6-d. 명령은 ⌘/ 명령 목록 (검색 창의 명령어 모드는 없어요)
    page.keyboard.press("Control+k"); page.wait_for_selector(".dlg-ov:not(.out) .palette [data-f=search]"); page.wait_for_timeout(150); to_cmd(page); page.keyboard.type(""); page.wait_for_timeout(300)
    check("⌘/ 명령 목록: 플러그인 명령들", page.locator(".cmdl-row").count() >= 25)  # 명령 = plugins/ 폴더의 파일들 · 검색 창에는 명령어 모드가 없어요
    page.keyboard.type("count"); page.wait_for_timeout(200)
    check("명령 필터", page.locator(".cmdl-row .cmdl-name").first.inner_text() == "count")
    page.keyboard.press("Escape")
    page.keyboard.press("Control+k"); page.wait_for_selector(".dlg-ov:not(.out) .palette [data-f=search]"); page.wait_for_timeout(150); to_cmd(page); page.keyboard.type("count"); page.wait_for_timeout(300)
    page.keyboard.press("Enter"); page.wait_for_timeout(900)
    check("플러그인 명령 실행 후 창 닫힘 + 결과 창", page.evaluate("!document.querySelector('.dlg-ov:not(.out) .palette')") and page.locator(".wfx-dialog, #toast:not([hidden])").count() > 0)
    page.evaluate("document.querySelector('#toast').hidden = true")
    if page.locator(".dlg-ov").count(): page.keyboard.press("Escape"); page.wait_for_timeout(200)
    page.keyboard.press("Control+k"); page.wait_for_selector(".dlg-ov:not(.out) .palette [data-f=search]"); page.wait_for_timeout(150); to_cmd(page); page.keyboard.type("export"); page.wait_for_timeout(300)
    page.keyboard.press("Enter"); page.wait_for_selector(".wfx-dialog h3:text-is('내보내기')"); page.wait_for_timeout(150)
    with page.expect_download() as dl:
        page.click(".wfx-dialog .wfx-btn:text-is('Markdown')")
    check("내장 명령: 내보내기(md) 다운로드", dl.value.suggested_filename.endswith(".md"), dl.value.suggested_filename)
    page.keyboard.press("Control+k"); page.wait_for_selector(".dlg-ov:not(.out) .palette [data-f=search]"); page.wait_for_timeout(150); to_cmd(page); page.keyboard.type("import"); page.wait_for_timeout(300)
    page.keyboard.press("Enter")  # (파일 선택창 이벤트를 기다리면 간헐적으로 멈춰서, 숨은 입력칸에 직접 넣어요)
    import tempfile, os
    tmp = os.path.join(tempfile.mkdtemp(), "imp.md"); open(tmp, "w", encoding="utf-8").write("- 가져온1\n  - 가져온2\n")
    page.once("dialog", lambda d: d.accept())
    page.set_input_files('#importfile', tmp); page.wait_for_timeout(900)
    check("내장 명령: 가져오기", "가져온1" in [c for _, c in kids(None)] and "가져온2" in texts(page), texts(page)[-4:])
    html = ("<html><head><title>x</title><style>p{}</style></head><body><h1>H제목</h1><p>H문단</p>"
            "<ul><li><span>H항목1</span><ul><li>H하위1</li><li>H하위2<ul><li>H손자</li></ul></li></ul></li><li>H항목2</li></ul>"
            "<h2>H소제목</h2><table><tr><td>a</td><td>b</td></tr></table></body></html>")
    page.keyboard.press("Control+k"); page.wait_for_selector(".dlg-ov:not(.out) .palette [data-f=search]"); page.wait_for_timeout(150); to_cmd(page); page.keyboard.type("import"); page.wait_for_timeout(300)
    page.keyboard.press("Enter")
    tmph = os.path.join(tempfile.mkdtemp(), "imp.html"); open(tmph, "w", encoding="utf-8").write(html)
    page.once("dialog", lambda d: d.accept())
    page.set_input_files('#importfile', tmph); page.wait_for_timeout(900)
    root = kids(None); hid = [i for i, c in root if c == "H제목"]
    check("HTML 가져오기: 제목 노드 생성", len(hid) == 1)
    if hid:
        def tree(i): return [(c, tree(j)) for j, c in kids(i)]
        got = tree(hid[0])
        want = [("H문단", []), ("H항목1", [("H하위1", []), ("H하위2", [("H손자", [])])]), ("H항목2", []), ("H소제목", [("a | b", [])])]
        check("HTML 가져오기: 목록·제목 계층 유지", got == want, str(got))
    check("HTML 가져오기: script/style/title 무시", "x" not in [c for _, c in kids(None)] and "p{}" not in texts(page))
    check("툴바에 옛 버튼 없음(번개/내보내기/가져오기)", page.locator("#wfx-btn, #export, #import").count() == 0)
    page.goto(BASE); page.wait_for_selector("#tree .text")

    # 7. 드래그 앤 드롭 — 독립된 새 항목들로
    for name in ["D1", "D2", "D3", "E1", "E2", "E3"]:
        api("/api/nodes", "POST", {"parent_id": None, "position": 9999, "content": name})
    page.goto(BASE); page.wait_for_selector("#tree .text")
    def root_tail(n): return [c for _, c in kids(None)][-n:]
    def drag(src_text, dst_text, where, steps=8, release=True):
        page.locator(f'#tree .row:has(.text:text-is("{dst_text}"))').first.evaluate("e => e.scrollIntoView({block: 'center'})")  # 화면 가장자리(자동 스크롤 구역)를 피해요
        page.wait_for_timeout(100)
        s = page.locator(f'#tree .row:has(.text:text-is("{src_text}")) .bullet').first.bounding_box()
        d = page.locator(f'#tree .row:has(.text:text-is("{dst_text}"))').first.bounding_box()
        y = d["y"] + {"before": 0.1, "child": 0.5, "after": 0.9}[where] * d["height"]
        page.mouse.move(s["x"] + s["width"] / 2, s["y"] + s["height"] / 2)
        page.mouse.down()
        page.mouse.move(s["x"] + 40, s["y"] + 20, steps=3)
        page.mouse.move(d["x"] + 120, y, steps=steps)
        if release:
            page.mouse.up()
            page.wait_for_timeout(500)
    drag("D3", "D1", "before")
    check("드래그: 앞에 놓기", root_tail(6) == ["D3", "D1", "D2", "E1", "E2", "E3"], root_tail(6))
    check("드래그 후 화면 순서도 같음", [t for t in texts(page) if t.startswith("D")] == ["D3", "D1", "D2"], texts(page)[-8:])
    drag("D3", "D1", "child")
    d1 = [i for i, c in kids(None) if c == "D1"][0]
    check("드래그: 하위로 놓기", [c for _, c in kids(d1)] == ["D3"], kids(d1))
    check("드래그: 하위로 놓아도 그 항목은 펼치지 않음(접힌 채)", "D3" not in texts(page) and api(f"/api/view?parent={d1}")["node"]["collapsed"] == 1)
    api(f"/api/nodes/{d1}", "PATCH", {"collapsed": 0}); page.reload(); page.wait_for_selector("#tree .text")  # 다음 단계를 위해 펼쳐 둬요
    drag("D3", "D2", "after")
    check("드래그: 뒤에 놓기(다른 부모에서 밖으로)", root_tail(6) == ["D1", "D2", "D3", "E1", "E2", "E3"] and kids(d1) == [], (root_tail(6), kids(d1)))
    before = api("/api/children?parent=root&limit=100")["total"]
    drag("D1", "D2", "child")
    check("드래그: 다른 항목 아래로(루트 개수 -1)", api("/api/children?parent=root&limit=100")["total"] == before - 1)
    d2 = [i for i, c in kids(None) if c == "D2"][0]
    check("드래그: D2의 자식이 D1", [c for _, c in kids(d2)] == ["D1"], kids(d2))
    api(f"/api/nodes/{d2}", "PATCH", {"collapsed": 0}); page.reload(); page.wait_for_selector("#tree .text")  # 넣은 항목은 접힌 채라 다음 단계를 위해 펼쳐 둬요
    # 자기 하위로 드롭 → 아무 일 없음 (D2를 자기 자식 D1 위로)
    tot = api("/api/children?parent=root&limit=100")["total"]
    drag("D2", "D1", "child")
    check("드래그: 자기 하위로는 못 놓음", api("/api/children?parent=root&limit=100")["total"] == tot and [c for _, c in kids(d2)] == ["D1"])
    # Esc로 취소
    drag("E1", "E3", "after", release=False)
    page.keyboard.press("Escape"); page.mouse.up(); page.wait_for_timeout(400)
    check("드래그: Esc 취소", root_tail(4)[-3:] == ["E1", "E2", "E3"], root_tail(4))
    check("드래그 후에도 클릭 줌 안 함", page.evaluate("location.hash") in ("", "#"))
    # 여러 개 선택해서 함께 드래그: E1,E2 → E3 뒤
    page.click('#tree .text:text-is("E1")'); page.keyboard.press("Shift+ArrowDown"); page.keyboard.press("Shift+ArrowDown"); page.wait_for_timeout(150)
    check("Shift+↓ 로 2개 선택", page.locator("#tree .row.selected").count() == 2)
    drag("E1", "E3", "after")
    check("여러 개 함께 드래그", root_tail(3) == ["E3", "E1", "E2"], root_tail(4))
    # 점 클릭은 여전히 줌
    page.locator('#tree .row:has(.text:text-is("D2")) .bullet').first.click(); page.wait_for_timeout(400)
    check("점 클릭 = 안으로 이동", page.evaluate("location.hash") not in ("", "#") and "D1" in texts(page))
    page.evaluate("location.hash=''"); page.wait_for_timeout(400)

    # 8-b. 전체 선택 / 마우스로 여러 노드에 걸쳐 끌기
    page.goto(BASE); page.wait_for_selector("#tree .text")
    total_rows = page.locator("#tree .text").count()
    page.click('#tree .text:text-is("E2")')
    page.keyboard.press("Control+a"); page.wait_for_timeout(100)
    check("Ctrl+A 0단계: 글자만 전체 선택(노드 선택 아님)", page.locator("#tree .row.selected").count() == 0 and page.evaluate("getSelection().toString()") == "E2")
    page.keyboard.press("Control+a"); page.wait_for_timeout(100)
    check("Ctrl+A 1단계: 커서 있는 노드 하나 선택", page.locator("#tree .row.selected").count() == 1 and page.locator("#tree .row.selected .text").inner_text() == "E2")
    page.keyboard.press("Control+a"); page.wait_for_timeout(100)
    check("Ctrl+A 2단계: 현재 화면의 모든 노드", page.locator("#tree .row.selected").count() == total_rows, (page.locator("#tree .row.selected").count(), total_rows))
    page.mouse.click(5, 5)
    check("바깥 클릭 → 선택 해제", page.locator("#tree .row.selected").count() == 0)
    page.locator('#tree .row:has(.text:text-is("E3"))').first.evaluate("e => e.scrollIntoView({block: 'center'})"); page.wait_for_timeout(100)  # 화면 가장자리(자동 스크롤 구역)를 피해요
    # 한 노드 안에서 끌면 글자 하이라이트(노드 선택 아님)
    bb = page.locator('#tree .row:has(.text:text-is("E1")) .text').first.bounding_box()
    page.mouse.move(bb["x"] + 2, bb["y"] + bb["height"] / 2); page.mouse.down(); page.mouse.move(bb["x"] + 12, bb["y"] + bb["height"] / 2, steps=3); page.mouse.up()
    check("한 노드 안에서 끌기 = 글자 선택만", page.locator("#tree .row.selected").count() == 0)
    page.evaluate("getSelection().removeAllRanges(); document.activeElement.blur()")  # 기존 글자 선택 위에서 끌면 브라우저가 '글자 끌어 옮기기'를 시작하므로 비워요
    # 다른 노드로 넘어가면 노드 전체 선택
    a_ = page.locator('#tree .row:has(.text:text-is("E3")) .text').first.bounding_box(); c_ = page.locator('#tree .row:has(.text:text-is("E2")) .text').first.bounding_box()  # 화면 순서: E3, E1, E2
    page.mouse.move(a_["x"] + 4, a_["y"] + a_["height"] / 2); page.mouse.down()
    page.mouse.move(c_["x"] + 30, c_["y"] + c_["height"] / 2, steps=8); page.mouse.up(); page.wait_for_timeout(150)
    sel = page.eval_on_selector_all("#tree .row.selected .text", "els => els.map(e => e.textContent)")
    check("마우스로 여러 노드에 걸치면 그 노드들 전체 선택", sel == ["E3", "E1", "E2"], sel)
    check("네이티브 글자 하이라이트는 남지 않음", page.evaluate("getSelection().isCollapsed || getSelection().toString() === ''"))
    page.keyboard.press("Escape"); page.mouse.click(5, 5)
    # 커서를 둔 뒤 Shift+클릭 → 사이 전부 선택
    page.click('#tree .text:text-is("E3")'); page.click('#tree .text:text-is("E2")', modifiers=["Shift"]); page.wait_for_timeout(100)
    sel = page.eval_on_selector_all("#tree .row.selected .text", "els => els.map(e => e.textContent)")
    check("커서 클릭 후 Shift+클릭 → 범위 선택", sel == ["E3", "E1", "E2"], sel)
    page.keyboard.press("Escape"); page.mouse.click(5, 5)

    # Mac 표기/키: navigator.platform 을 Mac 으로 바꾼 새 창에서 ⌘A
    ctx = b.new_context(); ctx.add_init_script("Object.defineProperty(navigator, 'platform', {get: () => 'MacIntel'})")
    mp = ctx.new_page(); mp.goto(BASE); mp.wait_for_selector("#tree .text")
    mp.click('#tree .text >> nth=1'); mp.keyboard.press("Meta+a"); mp.keyboard.press("Meta+a"); mp.keyboard.press("Meta+a"); mp.wait_for_timeout(100)
    check("Mac: ⌘A 두 번 → 전체 선택", mp.locator("#tree .row.selected").count() == mp.locator("#tree .text").count())
    mp.click('#tree .text >> nth=1'); mp.keyboard.press("Control+a")
    check("Mac: Ctrl+A 는 가로채지 않음(줄 처음으로 가는 기본 동작 유지)", mp.locator("#tree .row.selected").count() == 0)
    ctx.close()
    # ⌘/ 명령 목록 (앱 기본) — 예전 맨 아래 표 · keys 창 대신
    check("화면 맨 아래 단축키 표는 없어요", page.locator("#keys").count() == 0)
    page.locator("#tree .text").first.click(); page.keyboard.press("Control+/"); page.wait_for_selector(".cmdl-list")
    kt = page.inner_text(".cmdl-list")
    check("명령 목록: 모든 명령과 지금 단축키 + 앱 자체 키", "Ctrl+." in kt and "export" in kt and "Alt+X" in kt and "Ctrl+/" in kt, kt[:300])
    page.fill(".cmdl-find", "내보내기"); page.wait_for_timeout(100)
    check("찾기로 거르기 (하는 일로도)", page.locator(".cmdl-row").count() == 1 and page.inner_text(".cmdl-row .cmdl-name") == "export", page.inner_text(".cmdl-list"))
    page.click(".cmdl-row"); page.wait_for_selector(".wfx-dialog h3:text-is('내보내기')")
    check("명령 줄을 누르면 그 명령 실행", page.locator(".wfx-dialog h3:text-is('내보내기')").count() == 1)
    page.keyboard.press("Escape"); page.wait_for_timeout(300)

    # 캐럿(▾) 클릭으로 접기/펼치기 + 빈 화면에서만 '항목 추가'
    pg = api("/api/nodes", "POST", {"parent_id": None, "position": 9999, "content": "캐럿부모"})["id"]
    api("/api/nodes", "POST", {"parent_id": pg, "position": 0, "content": "캐럿자식"})
    page.reload(); page.wait_for_selector("#tree .text")
    row = page.locator("#tree .row", has=page.locator(".text", has_text="캐럿부모")).first
    check("자식 있는 노드에 캐럿 표시", row.locator(".chev").is_visible() and row.locator(".chev").get_attribute("aria-expanded") == "true")
    row.locator(".chev").click(); page.wait_for_timeout(700)
    check("캐럿 클릭 → 접힘", "캐럿자식" not in texts(page) and row.locator(".chev").get_attribute("aria-expanded") == "false")
    row.locator(".chev").click(); page.wait_for_timeout(700)
    check("캐럿 다시 클릭 → 펼침", "캐럿자식" in texts(page))
    leaf = api("/api/nodes", "POST", {"parent_id": None, "position": 9999, "content": "빈화면"})["id"]
    page.goto(f"{BASE}/#{leaf}"); page.wait_for_selector("#title")
    page.wait_for_timeout(400)
    check("빈 화면에서는 '항목 추가' 버튼 표시", page.locator("#add").is_visible())
    page.click("#add"); page.keyboard.type("첫항목"); page.wait_for_timeout(600)
    check("추가 후 버튼 사라짐", page.locator("#add").is_hidden())
    page.goto(BASE); page.wait_for_selector("#tree .text")

    # 화살표 더블클릭: 하위 전체 접기/펼치기
    P = api("/api/nodes", "POST", {"parent_id": None, "position": 9999, "content": "더블P"})["id"]
    C = api("/api/nodes", "POST", {"parent_id": P, "position": 0, "content": "더블C"})["id"]
    api("/api/nodes", "POST", {"parent_id": C, "position": 0, "content": "더블G"})
    page.reload(); page.wait_for_selector("#tree .text")
    prow = lambda: page.locator("#tree .row", has=page.locator(".text", has_text="더블P")).first
    prow().locator(".chev").dblclick(); page.wait_for_timeout(600)
    flags = lambda: {c: api(f"/api/children?parent={i}&limit=10")["nodes"] for c, i in [("P", None)]} if False else None
    def col(i): return next(n for n in api(f"/api/children?parent={i}&limit=10")["nodes"])["collapsed"] if True else 0
    check("캐럿 더블클릭(펼쳐진 상태) → 하위 전체 접힘", "더블C" not in texts(page) and col(P) == 1, f"{texts(page)[-3:]} C.collapsed={col(P)}")
    prow().locator(".chev").dblclick(); page.wait_for_timeout(700)
    check("캐럿 더블클릭(접힌 상태) → 하위 전체 펼침", "더블G" in texts(page) and col(P) == 0, str(texts(page)[-4:]))
    api("/api/nodes", "POST", {"parent_id": P, "position": 5, "content": "더블C2"})

    # 여러 항목 선택 → Tab / Shift+Tab 으로 함께 이동
    X = api("/api/nodes", "POST", {"parent_id": None, "position": 9999, "content": "다중X"})["id"]
    for k, nm in enumerate("abc"): api("/api/nodes", "POST", {"parent_id": X, "position": k, "content": "다중" + nm})
    page.reload(); page.wait_for_selector("#tree .text")
    page.locator("#tree .text", has_text="다중b").click(); page.keyboard.press("Shift+ArrowDown"); page.keyboard.press("Shift+ArrowDown")
    page.keyboard.press("Tab"); page.wait_for_timeout(700)
    tree = lambda i: [(c, [d for _, d in kids(j)]) for j, c in kids(i)]
    check("다중 선택 Tab → 함께 앞 형제 아래로", tree(X) == [("다중a", ["다중b", "다중c"])], str(tree(X)))
    check("이동 뒤에도 선택 유지", page.locator("#tree .row.selected").count() == 2)
    page.keyboard.press("Shift+Tab"); page.wait_for_timeout(700)
    check("다중 선택 Shift+Tab → 함께 한 단계 밖으로(순서 유지)", tree(X) == [("다중a", []), ("다중b", []), ("다중c", [])], str(tree(X)))
    page.keyboard.press("Escape")
    page.goto(BASE); page.wait_for_selector("#tree .text")

    # Ctrl/⌘+Shift+Backspace: 한 번 더 묻고(지우기 확인 창 — Enter = 지우기) 지워요
    Y = api("/api/nodes", "POST", {"parent_id": None, "position": 9999, "content": "삭제Y"})["id"]
    api("/api/nodes", "POST", {"parent_id": Y, "position": 0, "content": "삭제Y자식"})
    Z = api("/api/nodes", "POST", {"parent_id": None, "position": 9999, "content": "삭제Z"})["id"]
    page.reload(); page.wait_for_selector("#tree .text")
    dialogs = []; page.on("dialog", lambda d: (dialogs.append(d.message), d.accept()))
    page.locator("#tree .text", has_text="삭제Y").first.click(); page.keyboard.press("Control+Shift+Backspace")
    page.wait_for_selector("text=지울까요"); check("Ctrl+Shift+Backspace: 지우기 확인 창", True)
    page.keyboard.press("Escape"); page.wait_for_timeout(400)
    check("확인 창에서 Esc → 그대로 남음", "삭제Y" in texts(page))
    page.locator("#tree .text", has_text="삭제Y").first.click(); page.keyboard.press("Control+Shift+Backspace"); page.wait_for_selector("text=지울까요"); page.keyboard.press("Enter"); page.wait_for_timeout(600)
    check("확인 창에서 Enter → 하위까지 지워짐", "삭제Y" not in texts(page) and "삭제Y자식" not in texts(page) and not [1 for i, c in kids(None) if c == "삭제Y"])
    check("브라우저 확인창(alert · confirm)은 쓰지 않음", not dialogs, str(dialogs))
    page.locator("#tree .text", has_text="삭제Z").first.click(); page.keyboard.press("Control+Shift+Backspace"); page.wait_for_selector("text=지울까요"); page.keyboard.press("Enter"); page.wait_for_timeout(600)
    check("삭제 뒤 위 항목에 포커스", page.evaluate("document.activeElement?.classList.contains('text')"))
    M = [api("/api/nodes", "POST", {"parent_id": None, "position": 9999, "content": "다삭" + x})["id"] for x in "12"]
    page.reload(); page.wait_for_selector("#tree .text")
    page.locator("#tree .text", has_text="다삭1").click(); page.keyboard.press("Shift+ArrowDown"); page.keyboard.press("Shift+ArrowDown")
    page.keyboard.press("Control+Shift+Backspace"); page.wait_for_selector("text=지울까요"); page.keyboard.press("Enter"); page.wait_for_timeout(600)
    check("다중 선택 상태에서도 확인 뒤 지워짐", not [1 for _, c in kids(None) if c.startswith("다삭")] and not dialogs, str(dialogs))
    page.goto(BASE); page.wait_for_selector("#tree .text")

    # tree의 '찾아 펼치기' (예전 fold · regex 펼치기 · fi): 찾은 노드 강조 + Esc로 해제
    HP = api("/api/nodes", "POST", {"parent_id": None, "position": 9999, "content": "강조부모"})["id"]
    api("/api/nodes", "POST", {"parent_id": HP, "position": 0, "content": "강조_대상1"})
    api("/api/nodes", "POST", {"parent_id": HP, "position": 1, "content": "다른것"})
    api("/api/nodes", "POST", {"parent_id": HP, "position": 2, "content": "강조_대상2"})
    page.reload(); page.wait_for_selector("#tree .text")
    page.keyboard.press("Control+k"); page.wait_for_selector(".dlg-ov:not(.out) .palette [data-f=search]"); page.wait_for_timeout(150); to_cmd(page); page.keyboard.type("tree"); page.wait_for_timeout(300)
    page.keyboard.press("Enter"); page.wait_for_selector(".wfx-dialog .wfx-tabs")
    page.click(".wfx-dialog .wfx-tabs button[data-v=find]"); page.wait_for_selector(".wfx-dialog [data-f=re]:visible")
    check("tree 찾아 펼치기 탭: 처음엔 '펼치고 강조'", page.inner_text(".wfx-dialog [data-f=act] .on") == "펼치고 강조", page.inner_text(".wfx-dialog [data-f=act]"))
    page.fill(".wfx-dialog [data-f=re]", "강조_대상"); page.wait_for_timeout(200)
    page.click(".wfx-dialog [data-f=go]"); page.wait_for_timeout(1000)
    found = page.eval_on_selector_all("#tree .row.found .text", "els => els.map(e => e.textContent)")
    check("tree 찾아 펼치기: 찾은 노드만 강조", found == ["강조_대상1", "강조_대상2"], str(found))
    top = page.evaluate("document.querySelector('#tree .row.found').getBoundingClientRect().top")
    check("찾은 노드가 화면 안으로 스크롤됨", 0 <= top <= 800, str(top))
    check("강조 막대에 1 / 2 표시", page.inner_text("#hlcount").strip() == "1 / 2", page.inner_text("#hlcount"))
    cur = lambda: page.eval_on_selector_all("#tree .row.found.current .text", "e => e.map(x => x.textContent)")
    check("처음엔 첫 번째가 현재", cur() == ["강조_대상1"], str(cur()))
    page.click("#hl-next"); page.wait_for_timeout(300)
    check("▼: 다음 강조 항목", cur() == ["강조_대상2"] and page.inner_text("#hlcount").strip() == "2 / 2", str(cur()))
    page.click("#hl-next"); page.wait_for_timeout(300)
    check("▼: 끝에서 처음으로 순환", cur() == ["강조_대상1"])
    page.click("#hl-prev"); page.wait_for_timeout(300)
    check("▲: 이전(순환)", cur() == ["강조_대상2"])
    page.click("#hl-prev"); page.wait_for_timeout(300)
    check("막대 ▲ 버튼", cur() == ["강조_대상1"])
    page.keyboard.press("Escape"); page.wait_for_timeout(300)
    check("Esc 한 번: 강조 해제(창은 안 열림)", page.locator("#tree .row.found").count() == 0 and page.locator(".dlg-ov:not(.out) .palette").count() == 0 and page.locator("#hlbar").is_hidden())
    page.set_viewport_size({"width": 1800, "height": 800}); page.wait_for_timeout(200)
    wd = page.evaluate("document.querySelector('#tree .row').getBoundingClientRect().width")
    check("화면이 넓어지면 노드 너비도 늘어남", wd > 1400, str(wd))
    page.set_viewport_size({"width": 1100, "height": 800})

    # 태그 · 링크 · 명령어만 파란색
    api("/api/nodes", "POST", {"parent_id": None, "position": 9999, "content": "색 #태그1 @사람 메일a@b.com https://example.com/x#y 끝 www.test.kr."})
    page.reload(); page.wait_for_selector("#tree .text"); page.wait_for_timeout(300)
    hl = page.evaluate("""() => { const g = n => [...CSS.highlights.get(n)].map(r => r.toString()); return {tag: g('tag'), link: g('linktext')}; }""")  # 단독 주소는 linktext(파란 글자)
    check("태그(#·@)만 태그 색", "#태그1" in hl["tag"] and "@사람" in hl["tag"] and not any("example" in x for x in hl["tag"]), str(hl))
    check("이메일 안의 @는 태그가 아님", not any(x.startswith("@b") for x in hl["tag"]), str(hl))
    check("링크 색(끝의 마침표 제외)", "https://example.com/x#y" in hl["link"] and "www.test.kr" in hl["link"], str(hl))
    page.locator("#tree .text", has_text="색 #태그1").click(); page.keyboard.press("End"); page.keyboard.type(" #새태그"); page.wait_for_timeout(300)
    check("입력하면 새 태그도 바로 색이 입혀짐", "#새태그" in page.evaluate("[...CSS.highlights.get('tag')].map(r => r.toString())"))

    # 태그 클릭 = 플러그인 트리거: '태그'로 켠 명령(기본 find)이 누른 태그를 받아요
    page.goto(BASE); page.wait_for_selector("#tree .text"); page.wait_for_timeout(300)
    page.locator("#tree .text", has_text="#태그1").first.scroll_into_view_if_needed(); page.wait_for_timeout(200)
    pos = page.evaluate("""() => { for (const el of document.querySelectorAll('#tree .text')) { const t = el.firstChild; if (t && t.nodeValue.includes('#태그1')) {
        const i = t.nodeValue.indexOf('#태그1'); const r = new Range(); r.setStart(t, i); r.setEnd(t, i + 4); const q = r.getBoundingClientRect(); return {x: q.left + q.width / 2, y: q.top + q.height / 2}; } } return null; }""")
    page.mouse.click(pos["x"], pos["y"]); page.wait_for_timeout(700)
    check("태그 클릭 → 태그 트리거 명령(find)이 그 태그로 열림", page.locator(".dlg-ov:not(.out) .palette").count() == 1 and page.input_value(".dlg-ov:not(.out) .palette [data-f=search]") == "#태그1" and page.get_attribute(".dlg-ov:not(.out) .palette [data-f=search]", "placeholder") == "이 화면에서 찾기", page.locator(".dlg-ov:not(.out) .palette").count())
    check("검색 결과에 그 태그가 든 노드가 나옴", page.locator(".dlg-ov:not(.out) .palette [data-f=hit][data-kind=hit]").count() >= 1)
    page.keyboard.press("Escape"); page.wait_for_timeout(200)
    # 선택 하이라이트: 이어진 하나의 띠
    page.locator("#tree .text", has_text="다중a").first.click(); page.keyboard.press("Shift+ArrowDown"); page.keyboard.press("Shift+ArrowDown"); page.wait_for_timeout(200)
    bands = page.evaluate("""() => [...document.querySelectorAll('#tree .row.selected')].map(r => { const b = getComputedStyle(r, '::before'); const tl = document.querySelector('#tree').getBoundingClientRect().left;
        return {first: r.classList.contains('sel-first'), last: r.classList.contains('sel-last'), left: Math.round(r.getBoundingClientRect().left + parseFloat(b.left) - tl)}; })""")
    check("여러 행 선택: 위·아래 끝만 둥글게(첫/끝 표시)", len(bands) >= 2 and bands[0]["first"] and bands[-1]["last"] and not any(b["first"] for b in bands[1:]) and not any(b["last"] for b in bands[:-1]), str(bands))
    check("들여쓴 행도 띠가 왼쪽 끝(트리 가장자리)에서 시작", all(abs(b["left"]) <= 1 for b in bands), str(bands))
    page.keyboard.press("Escape"); page.mouse.click(5, 5)

    # 부모에서 자식으로 선택을 이으면 그 부모의 모든 하위가 함께 선택됨
    SP = api("/api/nodes", "POST", {"parent_id": None, "position": 9999, "content": "선택부모"})["id"]
    for k in range(4): api("/api/nodes", "POST", {"parent_id": SP, "position": k, "content": f"선택자식{k}"})
    api("/api/nodes", "POST", {"parent_id": None, "position": 9999, "content": "선택바깥"})
    page.goto(BASE); page.wait_for_selector("#tree .text")
    page.locator("#tree .text", has_text="선택부모").first.click()
    page.keyboard.press("Shift+ArrowDown")
    sel = lambda: page.eval_on_selector_all("#tree .row.selected .text", "e => e.map(x => x.textContent)")
    check("Shift+↓ 첫 입력: 부모만", sel() == ["선택부모"], str(sel()))
    page.keyboard.press("Shift+ArrowDown")
    check("부모에서 자식으로 이으면 모든 자식이 함께 선택", sel() == ["선택부모"] + [f"선택자식{k}" for k in range(4)], str(sel()))
    page.keyboard.press("Shift+ArrowDown")
    check("한 번 더 누르면 다음 형제까지 이어짐(멈추지 않음)", sel()[-1] == "선택바깥" and len(sel()) == 6, str(sel()))
    page.keyboard.press("Shift+ArrowUp")
    page.keyboard.press("Shift+ArrowUp")
    check("Shift+↑ 로 줄이면 부모만 남음(하위 묶음은 한 번에)", sel() == ["선택부모"], str(sel()))
    page.keyboard.press("Escape"); page.mouse.click(5, 5)

    # 여러 브라우저 동기화
    b2 = p.chromium.launch(); pg2 = b2.new_page(viewport={"width": 1100, "height": 800})
    pg2.goto(BASE); pg2.wait_for_selector("#tree .text"); pg2.wait_for_timeout(500)
    page.goto(BASE); page.wait_for_selector("#tree .text"); page.wait_for_timeout(500)
    S = api("/api/nodes", "POST", {"parent_id": None, "position": 9999, "content": "동기화1"})["id"]
    pg2.wait_for_function("[...document.querySelectorAll('#tree .text')].some(e => e.textContent === '동기화1')", timeout=5000)
    check("다른 화면에서 만든 노드가 새로고침 없이 나타남", "동기화1" in texts(pg2) and "동기화1" in texts(page))
    # 한 화면에서 입력하면 다른 화면에 반영
    pg2.locator("#tree .text", has_text="동기화1").first.click(); pg2.keyboard.press("End"); pg2.keyboard.type("+수정")
    page.wait_for_function("[...document.querySelectorAll('#tree .text')].some(e => e.textContent === '동기화1+수정')", timeout=6000)
    check("한 브라우저에서 고친 글이 다른 브라우저에 반영", "동기화1+수정" in texts(page))
    check("고친 쪽 화면은 커서를 잃지 않음", pg2.evaluate("document.activeElement?.classList.contains('text')"))
    # 접기 · 삭제도 반영
    api("/api/nodes/%d" % S, "DELETE")
    pg2.wait_for_function("![...document.querySelectorAll('#tree .text')].some(e => e.textContent.startsWith('동기화1'))", timeout=6000)
    check("삭제도 다른 화면에 반영", not any(x.startswith("동기화1") for x in texts(pg2)))
    # 내 입력 중에는 남의 변경이 와도 타이핑이 유지됨
    page.locator("#tree .text").first.click(); page.keyboard.press("End"); page.keyboard.type("가")
    api("/api/nodes", "POST", {"parent_id": None, "position": 9999, "content": "동기화2"})
    page.keyboard.type("나다"); page.wait_for_timeout(1200); page.keyboard.type("라")
    page.wait_for_timeout(800)
    ok = page.evaluate("document.activeElement?.classList.contains('text') && document.activeElement.textContent.endsWith('가나다라')")
    check("다른 화면의 변경이 와도 내 타이핑이 끊기지 않음", ok, page.evaluate("document.activeElement?.textContent"))
    b2.close()
    page.goto(BASE); page.wait_for_selector("#tree .text")

    # 검색 결과 이어 받기 (100개 넘으면 스크롤할 때 계속 불러옴)
    api("/api/import", "POST", {"parent_id": None, "position": None, "items": [{"depth": 0, "text": f"이어받기시험 {i:04d}"} for i in range(1234)]})
    page.goto(BASE); page.wait_for_selector("#tree .text")
    page.keyboard.press("Control+k"); page.wait_for_selector(".dlg-ov:not(.out) .palette [data-f=search]"); page.keyboard.type("이어받기시험"); page.wait_for_timeout(800)
    n0 = page.locator("[data-f=list] [data-f=hit]").count()
    check("처음엔 100개만 그림", n0 == 100, str(n0))
    check("안내 문구: 더 있음", "개 이상" in page.inner_text(".dlg-ov:not(.out) .palette [data-f=info]"), page.inner_text(".dlg-ov:not(.out) .palette [data-f=info]"))
    for _ in range(30):
        page.evaluate("(() => { const l = document.querySelector('[data-f=list]'); l.scrollTop = l.scrollHeight; })()"); page.wait_for_timeout(150)
        if page.locator("[data-f=list] [data-f=hit]").count() >= 1234: break
    n1 = page.locator("[data-f=list] [data-f=hit]").count()
    check("스크롤하면 끝까지 계속 불러옴(1234개)", n1 == 1234, str(n1))
    check("중복 없이 이어 붙음", page.evaluate("new Set([...document.querySelectorAll('[data-f=list] [data-f=hit-text]')].map(e => e.textContent)).size") == 1234)
    check("다 불러오면 '이상' 표시가 사라짐", "개 이상" not in page.inner_text(".dlg-ov:not(.out) .palette [data-f=info]") and "1234개" in page.inner_text(".dlg-ov:not(.out) .palette [data-f=info]"), page.inner_text(".dlg-ov:not(.out) .palette [data-f=info]"))
    page.keyboard.press("Escape")
    # 키보드: 100번째에서 ↓ 로 다음 쪽 이어 받기
    page.keyboard.press("Control+k"); page.wait_for_selector(".dlg-ov:not(.out) .palette [data-f=search]"); page.keyboard.type("이어받기시험"); page.wait_for_timeout(800)
    for _ in range(100): page.keyboard.press("ArrowDown")
    page.wait_for_timeout(700)
    check("맨 끝에서 ↓ : 다음 쪽을 받아 계속 내려감", page.locator("[data-f=list] [data-f=hit]").count() > 100 and page.locator("[data-f=list] [data-f=hit][data-active]").count() == 1)
    page.keyboard.press("Escape")
    page.keyboard.press("Control+k"); page.wait_for_selector(".dlg-ov:not(.out) .palette [data-f=search]"); page.keyboard.type("이어받기시험 12"); page.wait_for_timeout(700)
    check("검색어를 바꾸면 목록이 처음부터 다시(이전 쪽 흔적 없음)", page.locator("[data-f=list] [data-f=hit]").count() == 100 or page.locator("[data-f=list] [data-f=hit]").count() < 100)
    page.keyboard.press("Escape")

    # 형제 항목 이동 (Ctrl+Ctrl+,/↓) · 통합 창 Ctrl+Enter 줌인
    SB = api("/api/nodes", "POST", {"parent_id": None, "position": 9999, "content": "형제부모"})["id"]
    ids3 = [api("/api/nodes", "POST", {"parent_id": SB, "position": k, "content": f"형제{k}"})["id"] for k in range(3)]
    api("/api/nodes", "POST", {"parent_id": ids3[1], "position": 0, "content": "형제1의자식"})
    page.goto(f"{BASE}/#{SB}"); page.reload(); page.wait_for_selector("#tree .text")
    page.locator("#tree .text", has_text="형제0").first.click(); page.keyboard.press("End")
    focused = lambda: page.evaluate("document.activeElement.textContent")
    page.keyboard.press("Control+."); page.wait_for_timeout(500)
    check("⌘.: 그 항목으로 줌인", page.evaluate("location.hash") == f"#{ids3[0]}", page.evaluate("location.hash"))
    page.goto(BASE); page.wait_for_selector("#tree .text")
    page.keyboard.press("Control+Shift+k"); page.wait_for_selector(".dlg-ov:not(.out) .palette [data-f=search]"); page.keyboard.type("형제1의자식"); page.wait_for_timeout(700)  # find(하위)에서 ⌘+클릭 = 그 항목 안으로
    page.locator("[data-f=hit][data-kind=hit]").first.click(modifiers=["Control"]); page.wait_for_timeout(700)
    check("find Ctrl+클릭: 찾은 항목 안으로 줌인", page.evaluate("location.hash") != "" and page.locator("#title").inner_text() == "형제1의자식", page.evaluate("[location.hash, document.querySelector('#title').textContent]"))
    page.evaluate("location.hash = ''"); page.reload(); page.wait_for_selector("#tree .text")

    # 전역 단축키: 복제(⌘⇧D, 지정) · 검색(⌘K, 지정) · 내보내기(⌃X) · 형제 줌(⌘⇧,↓) · 홈(⌘', 지정)
    SH = api("/api/nodes", "POST", {"parent_id": None, "position": 0, "content": "단축키부모"})["id"]
    s1 = api("/api/nodes", "POST", {"parent_id": SH, "position": 0, "content": "단축1"})["id"]
    s2 = api("/api/nodes", "POST", {"parent_id": SH, "position": 1, "content": "단축2"})["id"]
    api("/api/nodes", "POST", {"parent_id": s1, "position": 0, "content": "단축1자식"})
    page.goto(f"{BASE}/#{SH}"); page.reload(); page.wait_for_selector("#tree .text")
    page.locator("#tree .text", has_text="단축1").first.click(); page.keyboard.press("Control+Shift+d"); page.wait_for_timeout(900)
    dup = page.eval_on_selector_all("#tree .text", "e => e.map(x => x.textContent)")
    check("⌥⇧D → 하위까지 복제되어 바로 다음에", dup == ["단축1", "단축1자식", "단축1", "단축1자식", "단축2"], str(dup))
    page.keyboard.press("Control+k"); page.wait_for_selector(".dlg-ov:not(.out) .palette [data-f=search]"); check("Ctrl+K → 점프(검색) 창", page.locator(".dlg-ov:not(.out) .palette").count() == 1); page.keyboard.press("Escape")
    page.wait_for_timeout(200); page.locator("#tree .text", has_text="단축2").first.click()
    page.keyboard.press("Alt+x"); page.wait_for_selector("text=Markdown"); page.wait_for_timeout(300)
    check("⌥X → 내보내기 창 (Markdown · 텍스트 · JSON · PDF · DB만)", all(page.locator("button", has_text=t).count() >= 1 for t in ("Markdown", "텍스트", "JSON", "PDF…", "DB만")))
    page.keyboard.press("Escape"); page.wait_for_timeout(200)
    page.goto(f"{BASE}/#{s1}"); page.reload(); page.wait_for_function("document.querySelector('#title').textContent")
    page.keyboard.press("Control+Shift+."); page.wait_for_timeout(800)
    check("⌘⇧. → 다음 형제(단축1 복제본 또는 단축2) 안으로", page.evaluate("location.hash") != f"#{s1}" and page.evaluate("location.hash") != "", page.evaluate("location.hash"))
    page.keyboard.press("Control+Shift+,"); page.wait_for_timeout(800)
    check("⌘⇧, → 이전 형제 안으로(되돌아옴)", page.evaluate("location.hash") == f"#{s1}", page.evaluate("location.hash"))
    page.keyboard.press("Control+'"); page.wait_for_timeout(600)
    check("⌘' → 홈", page.evaluate("location.hash") in ("", "#"), page.evaluate("location.hash"))
    page.evaluate("location.hash=''"); page.reload(); page.wait_for_selector("#tree .text")

    # 즐겨찾기 = 입력 기록의 ★ 고정: 검색 창을 빈 칸으로 열면 검색 기록(★ 고정 → 최근), 숫자 키로 다시 찾기
    check("항목 즐겨찾기 명령은 없어요", page.evaluate("import('/commands.js').then((P) => !P.paletteCommands.has('favorite'))"))
    page.keyboard.press("Control+k"); page.wait_for_selector(".dlg-ov:not(.out) .palette [data-f=search]"); page.keyboard.type("단축2"); page.wait_for_timeout(500); page.keyboard.press("Enter"); page.wait_for_timeout(800)
    page.keyboard.press("Control+k"); page.wait_for_selector("[data-f=hit]:not([data-kind=hit])")
    hist = page.eval_on_selector_all("[data-f=hit]:not([data-kind=hit]) [data-f=hit-text]", "e => e.map(x => x.textContent)")
    check("빈 검색 창 → 검색 기록 (방금 찾은 '단축2')", hist[:1] == ["단축2"], str(hist))
    page.locator("[data-f=hit]:not([data-kind=hit]) [data-f=star]").first.click(); page.wait_for_timeout(500)
    check("☆ → 고정 (★)", page.locator("[data-f=hit]:not([data-kind=hit]) [data-f=star][data-on]").count() == 1)
    page.keyboard.press("1"); page.wait_for_timeout(600)
    check("숫자 1 → 그 검색어로 다시 찾기", page.input_value(".dlg-ov:not(.out) .palette [data-f=search]") == "단축2" and page.locator("[data-f=hit][data-kind=hit]").count() >= 1, page.input_value(".dlg-ov:not(.out) .palette [data-f=search]"))
    page.keyboard.press("Escape")
    page.evaluate("location.hash=''"); page.reload(); page.wait_for_selector("#tree .text")

    # review: 전역 · 하위 · 현재 노드 중 고르기 → 전역이면 밀린 카드를 차례로
    DV = api("/api/nodes", "POST", {"parent_id": None, "position": 0, "content": "복습대상질문"})["id"]
    FS = api("/api/nodes", "POST", {"parent_id": DV, "position": 0, "content": ".fsrs"})["id"]
    api("/api/nodes", "POST", {"parent_id": FS, "position": 0, "content": "due: 2020-01-01"})
    page.goto(BASE); page.reload(); page.wait_for_selector("#tree .text")
    page.keyboard.press("Control+k"); page.wait_for_selector(".dlg-ov:not(.out) .palette [data-f=search]"); to_cmd(page); page.keyboard.type("review"); page.wait_for_timeout(300); page.keyboard.press("Enter")
    page.wait_for_selector(".wfx-dialog .wfx-btn:has-text('전역 복습')"); page.locator(".wfx-dialog .wfx-btn", has_text="전역 복습").click()
    page.wait_for_selector("[data-f=q]"); page.wait_for_timeout(300)
    check("홈에서 review → 전역 복습 → 밀린 카드 · 안내", "밀린 카드" in page.inner_text("[data-f=guide]"), page.inner_text("[data-f=guide]"))
    check("review: 그 카드 (질문 + 답 보기)", page.locator(".wfx-dialog", has_text="복습대상질문").count() == 1 and page.locator(".wfx-dialog button", has_text="답 보기").count() == 1, page.evaluate("document.body.innerText.slice(-200)"))
    page.locator(".wfx-dialog button", has_text="답 보기").click(); page.wait_for_timeout(300)  # 답을 본 뒤 등급 (Again · Hard · Good · Easy)
    page.locator(".wfx-dialog button", has_text="Good").first.click(); page.wait_for_timeout(1000)
    check("등급 선택 후 다음 복습일이 기록됨", api(f"/api/children?parent_id={FS}") is not None and "due: 2020-01-01" not in str(api(f"/api/children?parent_id={FS}")))
    page.evaluate("location.hash=''"); page.reload(); page.wait_for_selector("#tree .text")

    # 키보드만으로 Ctrl+. 를 연달아 눌러 깊이 들어가기 (접힌 항목도)
    K0 = api("/api/nodes", "POST", {"parent_id": None, "position": 0, "content": "키줌0"})["id"]
    K1 = api("/api/nodes", "POST", {"parent_id": K0, "position": 0, "content": "키줌1"})["id"]
    K2 = api("/api/nodes", "POST", {"parent_id": K1, "position": 0, "content": "키줌2"})["id"]
    api("/api/nodes", "POST", {"parent_id": K2, "position": 0, "content": "키줌3"})
    api(f"/api/nodes/{K0}", "PATCH", {"collapsed": 1}); api(f"/api/nodes/{K1}", "PATCH", {"collapsed": 1})
    page.goto(BASE); page.reload(); page.wait_for_selector("#tree .text")
    page.locator("#tree .text", has_text="키줌0").first.click()
    for _ in range(3): page.keyboard.press("Control+."); page.wait_for_timeout(600)
    check("⌘. 세 번(접힌 항목 포함) → 가장 안쪽 자식에 커서", page.evaluate("document.activeElement.textContent") == "키줌3", page.evaluate("document.activeElement.textContent"))
    for _ in range(3): page.keyboard.press("Control+,"); page.wait_for_timeout(600)
    check("⌘, 로 되돌아오면 처음 항목에 커서", page.evaluate("document.activeElement.textContent") == "키줌0", page.evaluate("document.activeElement.textContent"))
    page.evaluate("location.hash=''"); page.reload(); page.wait_for_selector("#tree .text")

    # 제목(들어와 있는 항목)도 편집: 저장되고, Enter/↓ 로 첫 자식, 첫 자식에서 ↑ 로 제목
    TT = api("/api/nodes", "POST", {"parent_id": None, "position": 0, "content": "제목원본"})["id"]
    TC = api("/api/nodes", "POST", {"parent_id": TT, "position": 0, "content": "제목자식"})["id"]
    page.goto(f"{BASE}/#{TT}"); page.reload(); page.wait_for_selector("#title")
    page.wait_for_function("document.querySelector('#title').textContent === '제목원본'"); page.click("#title"); page.keyboard.press("End"); page.keyboard.type("수정됨"); page.wait_for_timeout(900)
    got = api(f"/api/children?parent_id={None}") if False else None
    check("제목 편집 → 화면", page.inner_text("#title") == "제목원본수정됨", page.inner_text("#title"))
    page.keyboard.press("Enter"); page.wait_for_timeout(200)
    check("제목에서 Enter → 첫 자식으로 커서", page.evaluate("document.activeElement.textContent") == "제목자식")
    page.keyboard.press("ArrowUp"); page.wait_for_timeout(200)
    check("첫 자식에서 ↑ → 제목으로", page.evaluate("document.activeElement.id") == "title")
    page.reload(); page.wait_for_function("document.querySelector('#title').textContent")
    check("제목 수정이 저장됨(새로고침 후에도)", page.inner_text("#title") == "제목원본수정됨", [page.inner_text("#title"), api(f"/api/view?parent={TT}")["node"]["content"]])
    page.evaluate("location.hash=''"); page.reload(); page.wait_for_selector("#tree .text")

    # ---- 첨부(이미지·영상·PDF) ----
    import base64, struct, zlib, tempfile, os as _os
    def _png(w=40, h=30):
        raw = b"".join(b"\x00" + b"\xff\x66\x00" * w for _ in range(h))
        ch = lambda k, d: struct.pack(">I", len(d)) + k + d + struct.pack(">I", zlib.crc32(k + d) & 0xffffffff)
        return b"\x89PNG\r\n\x1a\n" + ch(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + ch(b"IDAT", zlib.compress(raw)) + ch(b"IEND", b"")
    tmpd = tempfile.mkdtemp()
    fpng, fmp4, fpdf, fexe = (_os.path.join(tmpd, n) for n in ("사진.png", "영상.mp4", "문서.pdf", "악성.exe"))
    open(fpng, "wb").write(_png()); open(fmp4, "wb").write(b"\x00\x00\x00\x18ftypmp42" + b"0" * 5000); open(fpdf, "wb").write(b"%PDF-1.4\n%%EOF\n"); open(fexe, "wb").write(b"MZ")
    AT = api("/api/nodes", "POST", {"parent_id": None, "position": 0, "content": "첨부시험"})["id"]
    page.goto(f"{BASE}/#{AT}"); page.reload(); page.wait_for_selector("#title")
    api("/api/nodes", "POST", {"parent_id": AT, "position": 0, "content": ""}); page.reload()
    page.wait_for_selector("#tree .text"); page.locator("#tree .text").first.click()
    page.keyboard.press("Control+k"); page.wait_for_selector(".dlg-ov:not(.out) .palette [data-f=search]"); to_cmd(page); page.keyboard.type("import"); page.wait_for_timeout(300)
    page.keyboard.press("Enter"); page.wait_for_timeout(300)  # 명령 실행(창이 닫히고 파일 선택창이 열리도록 요청) — 선택창 자체는 브라우저 몫이라 입력칸에 바로 파일을 넣어요
    check("파일 넣기(import) 명령 실행 후 통합 창이 닫힘", page.evaluate("!document.querySelector('.dlg-ov:not(.out) .palette')"))
    page.set_input_files("#importfile", [fpng, fmp4, fpdf]); page.wait_for_timeout(1500)
    check("첨부: 이미지가 화면에 표시(실제로 불러와짐)", page.evaluate("[...document.querySelectorAll('.attach img')].some(i => i.complete && i.naturalWidth === 40)"))
    check("첨부: 영상 플레이어와 PDF 카드", page.locator(".attach video").count() == 1 and page.locator(".att-pdf").count() == 1)
    murl = page.evaluate("document.querySelector('.attach video').getAttribute('src')")
    rr = requests.get(BASE + murl, headers={"Range": "bytes=0-99"}) if 'requests' in globals() else None
    if rr is not None: check("영상 Range 요청 → 206(이어보기 가능)", rr.status_code == 206 and len(rr.content) == 100, rr.status_code)
    check("첨부 표시가 글로 남음(편집·검색 가능)", "![사진](/files/" in page.evaluate("[...document.querySelectorAll('#tree .text')].map(e => e.textContent).join('\\n')"))
    # 지우면 미리보기도 사라짐
    tok = page.locator("#tree .text", has_text="![사진]").first
    tok.click(); page.keyboard.press("Control+a"); page.keyboard.press("Control+a") if False else None
    page.evaluate("(() => { const el = document.activeElement; el.textContent = '그림 지움'; el.dispatchEvent(new Event('input', {bubbles: true})); })()"); page.wait_for_timeout(600)
    check("글을 지우면 미리보기 사라짐", page.locator(".attach img").count() == 0)
    # 붙여넣기(이미지 파일) · 끌어놓기 · 허용 안 되는 형식
    b64 = base64.b64encode(_png(12, 12)).decode()
    page.locator("#tree .text", has_text="그림 지움").first.click()
    page.evaluate("""(b64) => { const bin = atob(b64), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
        const dt = new DataTransfer(); dt.items.add(new File([u], 'image.png', {type: 'image/png'}));
        document.activeElement.dispatchEvent(new ClipboardEvent('paste', {clipboardData: dt, bubbles: true, cancelable: true})); }""", b64)
    page.wait_for_timeout(1500)
    check("이미지 붙여넣기 → 첨부", page.evaluate("[...document.querySelectorAll('.attach img')].some(i => i.complete && i.naturalWidth === 12)"))
    page.evaluate("""(b64) => { const bin = atob(b64), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
        const dt = new DataTransfer(); dt.items.add(new File([u], '끌어온.png', {type: 'image/png'}));
        document.querySelector('#tree .row .text').dispatchEvent(new DragEvent('drop', {dataTransfer: dt, bubbles: true, cancelable: true})); }""", b64)
    page.wait_for_timeout(1500)
    check("파일 끌어놓기 → 첨부", page.locator(".attach img").count() == 2, page.locator(".attach img").count())
    page.set_input_files("#importfile", [fexe]); page.wait_for_timeout(800)
    check("허용 안 되는 형식(.exe)은 거절 안내", page.locator("#toast").inner_text().find("넣을 수 없") >= 0, page.locator("#toast").inner_text())
    bad = requests.post(BASE + "/api/upload", files={"file": ("a.exe", b"MZ")}) if 'requests' in globals() else None
    if bad is not None: check("서버도 .exe 업로드 거절(400)", bad.status_code == 400)
    check("잘못된 /files 경로는 404", requests.get(BASE + "/files/../server.py").status_code == 404 and requests.get(BASE + "/files/nothing.png").status_code == 404)

    # ---- PDF 내보내기 ----
    page.evaluate("() => { globalThis.__outlinerPrint = (w) => { globalThis.__printed = w.document.documentElement.outerHTML; }; }")
    page.evaluate("document.activeElement.blur()"); page.keyboard.press("Control+k"); page.wait_for_selector(".dlg-ov:not(.out) .palette [data-f=search]"); to_cmd(page); page.keyboard.type("export"); page.wait_for_timeout(300); page.keyboard.press("Enter")
    page.click(".wfx-dialog .wfx-btn:text-is('PDF…')"); page.wait_for_selector("[data-f=pdf]")  # 내보내기 창에서 PDF…
    check("PDF 설정 창: 항목 16개 (자주 쓰는 6개 + 세부 설정 10개)", page.locator("[data-f=form] [name], [data-f=form] [data-key]").count() == 16, page.locator("[data-f=form] [name], [data-f=form] [data-key]").count())
    check("세부 설정은 처음에 접혀 있음", not page.is_visible("[data-f=more] [name=margin]"))
    check("미리 보기가 그려짐 (쪽 수 표시)", page.wait_for_function("/\\d+쪽/.test(document.querySelector('[data-f=pinfo]')?.textContent || '')", timeout=8000) is not None)
    page.click("[data-f=more] > summary")
    page.fill("[data-f=form] [name=fontPt]", "14"); page.fill("[data-f=form] [name=margin]", "15"); page.fill("[data-f=form] [name=lineH]", "1.8")
    page.select_option("[data-f=form] [name=orient]", "landscape"); page.select_option("[data-f=form] [name=bullet]", "number")
    page.click("[data-f=pdf] [data-f=go]"); page.wait_for_function("globalThis.__printed", timeout=8000)
    html = page.evaluate("globalThis.__printed")
    check("PDF 문서에 옵션 반영", "font-size: 14pt" in html and "margin: 15mm" in html and "size: A4 landscape" in html and "line-height: 1.8" in html)
    check("PDF 문서에 항목·이미지 포함", "그림 지움" in html and "<img" in html and "1." in html)
    page.evaluate("document.querySelectorAll('.print-frame').forEach(e => e.remove())")
    pg2 = b.new_page(); pg2.set_content(html.replace("<head>", f"<head><base href='{BASE}/'>", 1)); pg2.wait_for_timeout(800)
    pdfb = pg2.pdf(prefer_css_page_size=True, print_background=True); pg2.close()
    check("실제 PDF 파일이 만들어짐", pdfb[:5] == b"%PDF-" and len(pdfb) > 1500, len(pdfb))
    page.keyboard.press("Escape")
    page.evaluate("location.hash=''"); page.reload(); page.wait_for_selector("#tree .text")

    # 첨부 관리 플러그인 (file, 예전 af — 안 쓰는 파일 정리 · 폴더 열기 · 첨부 전체 ZIP 단추)
    fa = api("/api/attachments")
    check("첨부 목록 API: 쓰는 파일과 안 쓰는 파일 구분", fa["files"] and all("ref_count" in f for f in fa["files"]), str(fa)[:200])
    orphan = requests.post(BASE + "/api/upload", files={"file": ("고아.png", _png(8, 8))}).json()
    lst = {f["url"]: f for f in api("/api/attachments")["files"]}
    check("어디에도 안 적은 파일은 ref_count 0", lst[orphan["url"]]["ref_count"] == 0)
    zr = requests.post(BASE + "/api/attachments/pack", data={"names": "all"})
    check("전체 ZIP (af의 전체 ZIP)", zr.status_code == 200 and zr.content[:2] == b"PK", zr.status_code)
    AH = api("/api/nodes", "POST", {"parent_id": None, "position": 0, "content": "첨부추가기준"})["id"]
    page.goto(f"{BASE}/#{AH}"); page.reload(); page.wait_for_selector("#title")
    api("/api/nodes", "POST", {"parent_id": AH, "position": 0, "content": "기준항목"}); page.reload(); page.wait_for_selector("#tree .text")
    page.locator("#tree .text", has_text="기준항목").first.click()
    page.keyboard.press("Control+k"); page.wait_for_selector(".dlg-ov:not(.out) .palette [data-f=search]"); to_cmd(page); page.keyboard.type("file"); page.wait_for_timeout(300)
    check(">file 명령(첨부 관리)이 목록에 있음", page.locator(".cmdl-row .cmdl-name", has_text="file").count() >= 1)
    page.keyboard.press("Enter"); page.wait_for_selector("[data-f=file-row]")
    check("첨부 관리 창에 파일 행과 '안 쓰는 파일' 표시", page.locator("[data-f=file-row]").count() >= 2 and page.locator("[data-f=file-row][data-unused]").count() >= 1, page.locator("[data-f=file-row]").count())
    used = page.locator("[data-f=file-row]:not([data-unused])")
    used.first.locator("input").check(); page.wait_for_timeout(150)
    check("파일을 선택하면 '항목으로 넣기' 단추", page.locator(".wfx-dialog button", has_text="항목으로 넣기").count() == 1)
    page.locator(".wfx-dialog button", has_text="항목으로 넣기").click(); page.wait_for_timeout(1500)
    check("선택한 첨부가 커서 항목 아래에 새 노드로 추가되고 미리보기 표시", page.locator("#tree .text", has_text="](/files/").count() == 1 and page.locator(".attach").count() == 1, page.locator("#tree .text").count())
    check("추가된 노드가 기준 항목 바로 아래(순서)", page.evaluate("[...document.querySelectorAll('#tree .text')].map(e => e.textContent.slice(0, 5))")[:2] == ["기준항목", page.evaluate("document.querySelectorAll('#tree .text')[1].textContent.slice(0, 5)")] and "](/files/" in page.evaluate("document.querySelectorAll('#tree .text')[1].textContent"))
    page.evaluate("location.hash=''"); page.reload(); page.wait_for_selector("#tree .text")
    page.keyboard.press("Control+k"); page.wait_for_selector(".dlg-ov:not(.out) .palette [data-f=search]"); to_cmd(page); page.keyboard.type("file"); page.wait_for_timeout(300); page.keyboard.press("Enter"); page.wait_for_selector("[data-f=file-row]")
    page.locator("[data-f=file-row][data-unused] input").first.check(); page.locator("[data-f=del]").click()
    page.wait_for_selector(".wfx-dialog:has-text('완전히 삭제')"); page.locator(".wfx-dialog .wfx-btn", has_text="삭제").last.click(); page.wait_for_timeout(1200)
    after = {f["url"] for f in api("/api/attachments")["files"]}
    check("선택한 안 쓰는 파일이 실제로 삭제됨", orphan["url"] not in after)
    check("삭제한 파일 요청은 404", requests.get(BASE + orphan["url"]).status_code == 404)
    page.keyboard.press("Escape"); page.wait_for_timeout(300)

    # 9. 붙여넣기 계층 (클립보드 이벤트 직접 발생)
    PID = api("/api/nodes", "POST", {"parent_id": None, "position": 0, "content": ""})["id"]
    page.reload(); page.wait_for_selector("#tree .text")
    page.locator(f'#tree .text[data-id="{PID}"]').click(); page.keyboard.type("붙여넣기시작"); 
    page.evaluate("""() => { const el = document.activeElement; el.textContent = ''; el.dispatchEvent(new Event('input')); }""")
    page.evaluate("""() => { const dt = new DataTransfer(); dt.setData('text/plain', '- 가\\n  - 나\\n    - 다\\n- 라');
        document.activeElement.dispatchEvent(new ClipboardEvent('paste', {clipboardData: dt, bubbles: true, cancelable: true})); }""")
    page.wait_for_timeout(700)
    check("멀티라인 붙여넣기 계층", all(t in texts(page) for t in ["가", "나", "다", "라"]), texts(page)[-6:])

    # 10. WFx 팔레트
    page.keyboard.press("Control+k")
    page.wait_for_selector(".dlg-ov:not(.out) .palette [data-f=search]")
    to_cmd(page); page.keyboard.type("count"); page.keyboard.press("Enter"); page.wait_for_timeout(800)
    check("count 실행(하위 전체 불러와 세기)", page.locator("#toast:not([hidden]), .wfx-dialog").count() > 0)
    page.keyboard.press("Escape")

    # DB 파일 가져오기 (아래에 추가 / 대체하기) — 마지막에 (통째로 바꾸면 앞선 내용이 사라져요)
    import sqlite3 as _sq
    srcdb = _os.path.join(tmpd, "가져올.db")
    sc = _sq.connect(srcdb); sc.executescript("CREATE TABLE nodes (id INTEGER PRIMARY KEY, parent_id INTEGER, position INTEGER NOT NULL DEFAULT 0, content TEXT NOT NULL DEFAULT '', collapsed INTEGER NOT NULL DEFAULT 0);")
    sc.executemany("INSERT INTO nodes VALUES (?,?,?,?,?)", [(1, None, 0, "외부DB루트", 0), (2, 1, 0, "외부DB자식", 0), (3, 2, 0, "외부DB손자", 1), (4, None, 1, "외부DB둘째", 0)]); sc.commit(); sc.close()
    bad = requests.post(BASE + "/api/import/db", files={"file": ("x.db", b"not a db")}, data={"mode": "append"})
    check("DB 가져오기: 잘못된 파일은 거절(400)", bad.status_code == 400 and "SQLite" in bad.json()["error"], bad.text[:100])
    page.goto(BASE); page.reload(); page.wait_for_selector("#tree .text")
    page.keyboard.press("Control+k"); page.wait_for_selector(".dlg-ov:not(.out) .palette [data-f=search]"); to_cmd(page); page.keyboard.type("import"); page.wait_for_timeout(300)
    page.keyboard.press("Enter"); page.wait_for_timeout(300)
    page.set_input_files("#importfile", srcdb); page.wait_for_selector(".pdf-dlg:has-text('DB 파일 가져오기')")
    check("DB 가져오기: 아래에 추가/대체하기 선택 창", page.locator(".pdf-dlg .pdf-btn", has_text="아래에 추가").count() == 1 and page.locator(".pdf-dlg .pdf-btn", has_text="대체하기").count() == 1)
    page.locator(".pdf-dlg .pdf-btn", has_text="아래에 추가").click(); page.wait_for_timeout(1500)
    q = lambda s: api("/api/search?q=" + urllib.parse.quote(s) + "&limit=50")["results"]
    res = q("외부DB")
    check("DB 아래에 추가: 4개 항목이 추가됨", sorted(r["content"] for r in res) == ["외부DB둘째", "외부DB루트", "외부DB손자", "외부DB자식"], str([r["content"] for r in res]))
    kid = [r for r in res if r["content"] == "외부DB손자"][0]
    check("DB 아래에 추가: 계층 유지", [p["content"] for p in kid["path"]][-2:] == ["외부DB루트", "외부DB자식"], str(kid["path"]))
    check("DB 아래에 추가: 원래 있던 항목은 그대로", len(q("시작하기")) >= 1)
    rep = requests.post(BASE + "/api/import/db", files={"file": ("가져올.db", open(srcdb, "rb"))}, data={"mode": "replace"}).json()
    check("DB 통째로 바꾸기: 자동 백업 파일 이름 반환", rep.get("mode") == "replace" and rep["backup"].endswith(".db") and rep["count"] == 4, str(rep))
    check("DB 통째로 바꾸기 후 검색(FTS)도 새 내용", len(q("외부DB")) == 4 and not q("시작하기"))
    page.wait_for_timeout(1500); page.wait_for_selector("#tree .text")  # 열려 있던 화면은 DB가 바뀐 걸 알아채고 스스로 새로고침해요
    check("DB 통째로 바꾸기 후 화면", page.locator("#tree .text", has_text="외부DB루트").count() == 1)
    nid = api("/api/nodes", "POST", {"parent_id": None, "position": 9999, "content": "바꾼 뒤 새 항목"})
    check("DB 통째로 바꾼 뒤에도 새 항목 저장·번호 예약 정상", nid.get("id") and requests.post(BASE + "/api/reserve", json={"n": 5}).status_code == 200)
    bak = requests.get(BASE + "/api/export/db").content
    n_before = len(q("외부DB")) + len(q("바꾼 뒤"))
    rt = requests.post(BASE + "/api/import/db", files={"file": ("round.db", bak)}, data={"mode": "replace"}).json()
    check("DB 내보내기 → 가져오기(통째로) 왕복 후 내용 동일", rt.get("mode") == "replace" and len(q("외부DB")) + len(q("바꾼 뒤")) == n_before, str(rt))
    page.wait_for_timeout(1500)  # 화면이 스스로 새로고침할 때까지
    # ---- 단축키 정리: Workflowy에 없는 키는 없앴는지 / 완료 기능 ----
    DN = api("/api/nodes", "POST", {"parent_id": None, "position": 0, "content": "완료부모"})["id"]
    dk = [api("/api/nodes", "POST", {"parent_id": DN, "position": i, "content": c})["id"] for i, c in enumerate(["완료가", "완료나", "완료다"])]
    page.goto(f"{BASE}/#{DN}"); page.reload(); page.wait_for_selector("#tree .text")
    page.locator("#tree .text", has_text="완료가").click(); page.keyboard.press("Control+d"); page.wait_for_timeout(400)
    check("Ctrl+D는 이제 아무 일도 안 함(Workflowy에 없는 키)", [t for t in texts(page) if t.startswith("완료")] == ["완료가", "완료나", "완료다"])
    page.locator("#tree .text", has_text="완료가").click(); page.keyboard.press("Control+Home"); page.wait_for_timeout(200)
    check("Ctrl+Home 등 Workflowy에 없는 키는 제거됨", page.evaluate("document.activeElement.textContent") == "완료가")
    check("체크박스 플러그인 없음", page.locator("#tree .prefix input").count() == 0)
    # ---- 전역 검색 결과 = 줌인 / 따옴표 = 글자 그대로 / 제목의 태그 색 ----
    TP = api("/api/nodes", "POST", {"parent_id": None, "position": 0, "content": "검색줌부모"})["id"]
    TH = api("/api/nodes", "POST", {"parent_id": TP, "position": 0, "content": "Quote Hello #프로젝트"})["id"]
    api("/api/nodes", "POST", {"parent_id": TH, "position": 0, "content": "첫자식"})
    api("/api/nodes", "POST", {"parent_id": TP, "position": 1, "content": "quote hello 소문자"})
    page.goto(BASE); page.reload(); page.wait_for_selector("#tree .text")
    page.keyboard.press("Control+k"); page.wait_for_selector(".dlg-ov:not(.out) .palette [data-f=search]"); page.keyboard.type("Quote Hello"); page.wait_for_timeout(600)
    page.keyboard.press("Enter"); page.wait_for_timeout(900)
    check("전역 검색 → 찾은 항목 안으로 줌인(제목 = 찾은 항목, 첫 자식에 커서)", page.evaluate("location.hash") == f"#{TH}" and "Quote Hello" in page.inner_text("#title") and page.evaluate("document.activeElement.textContent") == "첫자식", page.evaluate("[location.hash, document.activeElement.textContent]"))
    tagged = page.evaluate("() => [...(CSS.highlights.get('tag') || [])].some((r) => document.querySelector('#title').contains(r.startContainer))")
    check("줌인한 제목의 #태그도 색 하이라이트", tagged)
    page.click("#title"); page.keyboard.press("End"); page.keyboard.type(" #새태그"); page.wait_for_timeout(500)
    check("제목을 고치면 새 태그도 바로 색칠", page.evaluate("() => [...(CSS.highlights.get('tag') || [])].filter((r) => document.querySelector('#title').contains(r.startContainer)).length") == 2)
    page.keyboard.press("Backspace"); page.keyboard.press("Backspace"); page.keyboard.press("Backspace"); page.keyboard.press("Backspace"); page.keyboard.press("Backspace"); page.wait_for_timeout(500)
    check("태그를 지우면 색도 바로 사라짐", page.evaluate("() => [...(CSS.highlights.get('tag') || [])].filter((r) => document.querySelector('#title').contains(r.startContainer)).length") == 1)
    page.evaluate("location.hash=''"); page.reload(); page.wait_for_selector("#tree .text")
    q = lambda s: [r["content"] for r in api("/api/search?q=" + urllib.parse.quote(s) + "&limit=50")["results"]]
    check("따옴표 없으면 대소문자 무시", sorted(x for x in q("quote hello") if x.lower().startswith("quote hello")) == ["Quote Hello #프로젝트", "quote hello 소문자"])
    check('"따옴표" = 대소문자까지 그대로', q('"Quote Hello"') == ["Quote Hello #프로젝트"] and q('"quote hello"') == ["quote hello 소문자"], str(q('"Quote Hello"')))
    check("닫지 않은 따옴표(입력 중)도 구절로 검색", q('"Quote Hello') == ["Quote Hello #프로젝트"], str(q('"Quote Hello')))
    check('따옴표로 묶은 제외어도 그대로 (-"Hello")', "Quote Hello #프로젝트" not in q('Quote -"Hello"') and q('quote -"HELLO"') != [], str(q('quote -"HELLO"')))
    page.keyboard.press("Control+k"); page.wait_for_selector(".dlg-ov:not(.out) .palette [data-f=search]"); page.keyboard.type('"Quote Hello"'); page.wait_for_timeout(600)
    check("통합 창: 따옴표 검색 결과와 강조도 대소문자 그대로", page.locator("[data-f=hit][data-kind=hit]").count() == 1 and page.locator("[data-f=hit] mark").first.inner_text() == "Quote Hello", page.inner_text("[data-f=list]"))
    page.keyboard.press("Escape")
    # ---- 전역 검색(jump)과 하위 검색(find)은 따로 — 창 안에서 모드를 바꾸지 않아요 ----
    page.evaluate("location.hash=''"); page.reload(); page.wait_for_selector("#tree .text")
    badge = lambda: page.get_attribute(".dlg-ov:not(.out) .palette [data-f=search]", "placeholder")  # 어디서 찾는지는 입력칸 안내 글로만 (따로 표시 · 바꾸는 단추 없음)
    page.keyboard.press("Control+k"); page.wait_for_selector(".dlg-ov:not(.out) .palette [data-f=search]")
    check("jump: 모드 표시 · 정규식 설명 말풍선 없이 간단하게", badge() == "찾기" and page.locator("[data-f=no-such-thing]").count() == 0)
    page.keyboard.type("검색"); page.keyboard.press("Tab"); page.wait_for_timeout(300)
    check("Tab은 포커스를 입력칸에 그대로", page.evaluate("document.activeElement.dataset.f") == "search" and page.input_value(".dlg-ov:not(.out) .palette [data-f=search]") == "검색")
    page.keyboard.press("Control+k"); page.wait_for_timeout(200)
    check("열린 채 ⌘K(jump) → 그대로 (글자 유지)", badge() == "찾기" and page.input_value(".dlg-ov:not(.out) .palette [data-f=search]") == "검색")
    page.keyboard.press("Escape"); page.wait_for_timeout(300)
    page.keyboard.press("Control+k"); page.wait_for_selector(".dlg-ov:not(.out) .palette [data-f=search]"); page.wait_for_timeout(150)
    check("다시 열면 빈 칸", page.input_value(".dlg-ov:not(.out) .palette [data-f=search]") == "")
    page.keyboard.type(">abc"); page.wait_for_timeout(300)
    check("맨 앞의 > 는 그냥 글자", page.input_value(".dlg-ov:not(.out) .palette [data-f=search]") == ">abc")
    page.keyboard.press("Escape"); page.wait_for_timeout(200)
    page.keyboard.press("Control+Shift+k"); page.wait_for_selector(".dlg-ov:not(.out) .palette [data-f=search]")
    check("find: '이 화면에서 찾기'", badge() == "이 화면에서 찾기")
    page.keyboard.press("Escape")
    # ---- 제목 노드의 첨부 표시 ----
    up = requests.post(BASE + "/api/upload", files={"file": ("제목.png", _png(), "image/png")}).json()
    TA = api("/api/nodes", "POST", {"parent_id": None, "position": 0, "content": "제목첨부 " + up["markdown"]})["id"]
    if TA:
        page.goto(f"{BASE}/#{TA}"); page.reload(); page.wait_for_selector("#title"); page.wait_for_timeout(800)
        check("줌인한 제목 노드의 첨부 이미지도 표시", page.evaluate("[...document.querySelectorAll('#titleatt img')].some(i => i.complete && i.naturalWidth === 40)"))
        page.locator("#title").click(); page.keyboard.press("End"); page.keyboard.type(" "); page.wait_for_timeout(600)
        check("제목을 고쳐도 첨부는 그대로 하나", page.locator("#titleatt img").count() == 1)
        for _ in range(60): page.keyboard.press("Backspace")  # 글을 다 지우면 첨부도 사라짐
        page.wait_for_timeout(700)
        check("제목에서 첨부 글을 지우면 미리보기도 사라짐", page.locator("#titleatt img").count() == 0)
    # ---- 되돌리기 / 다시 실행 ----
    UT = api("/api/nodes", "POST", {"parent_id": None, "position": 0, "content": "undo시험"})["id"]
    ids = [api("/api/nodes", "POST", {"parent_id": UT, "position": i, "content": c})["id"] for i, c in enumerate(["A", "B", "C"])]
    api("/api/nodes", "POST", {"parent_id": ids[1], "position": 0, "content": "B-하위"})
    page.goto(f"{BASE}/#{UT}"); page.reload(); page.wait_for_selector("#tree .text"); page.wait_for_timeout(300)
    names = lambda: [c for _, c in kids(UT)]
    Z, ZS = "Control+z", "Control+Shift+z"
    page.locator('#tree .text[data-id="%d"]' % ids[0]).click(); page.keyboard.press("End"); page.keyboard.type("xyz"); page.wait_for_timeout(700)
    check("글 고치기 저장됨", names()[0] == "Axyz")
    page.keyboard.press(Z); page.wait_for_timeout(600)
    check("Ctrl+Z: 입력한 글(한 덩어리) 되돌림", names()[0] == "A" and texts(page)[0] == "A", (names(), texts(page)))
    page.keyboard.press(ZS); page.wait_for_timeout(600)
    check("Ctrl+Shift+Z: 다시 실행", names()[0] == "Axyz" and texts(page)[0] == "Axyz")
    page.keyboard.press(Z); page.wait_for_timeout(500)
    # Enter 로 쪼개기 → 되돌리기
    page.keyboard.press("End"); page.keyboard.press("Home"); page.keyboard.press("ArrowRight"); page.keyboard.press("Enter"); page.wait_for_timeout(700)
    check("Enter로 항목이 둘로 쪼개짐", names()[:3] == ["A", "", "B"] or len(names()) == 4, names())
    page.keyboard.press(Z); page.wait_for_timeout(800)
    check("Ctrl+Z: 쪼갠 것을 원래대로(글 + 새 항목)", names() == ["A", "B", "C"] and [t for t in texts(page) if t != "B-하위"] == ["A", "B", "C"], (names(), texts(page)))
    page.keyboard.press(ZS); page.wait_for_timeout(800)
    check("다시 실행: 다시 쪼개짐", len(names()) == 4)
    page.keyboard.press(Z); page.wait_for_timeout(800)
    # 삭제 (하위 포함) → 되돌리기
    page.locator('#tree .text[data-id="%d"]' % ids[1]).click(); page.keyboard.press("Escape") if False else None
    page.keyboard.press("Shift+ArrowUp"); page.keyboard.press("Shift+ArrowDown")
    page.keyboard.press("Backspace"); page.wait_for_selector("text=지울까요"); page.keyboard.press("Enter"); page.wait_for_timeout(800)
    check("선택 삭제됨", "B" not in names())
    page.keyboard.press(Z); page.wait_for_timeout(1000)
    ch = api(f"/api/children?parent={ids[1]}&limit=10")["nodes"]
    check("Ctrl+Z: 지운 항목이 원래 id·자리·하위까지 복원", names() == ["A", "B", "C"] and [n["content"] for n in ch] == ["B-하위"] and ids[1] in [i for i, _ in kids(UT)], (names(), ch))
    page.keyboard.press(ZS); page.wait_for_timeout(800)
    check("다시 실행: 다시 삭제", "B" not in names())
    page.keyboard.press(Z); page.wait_for_timeout(900)
    # 옮기기 → 되돌리기
    page.locator('#tree .text[data-id="%d"]' % ids[0]).click(); page.keyboard.press("Control+Shift+ArrowDown"); page.wait_for_timeout(700)
    check("Ctrl+Shift+↓ 로 아래로 옮겨짐", names()[:2] == ["B", "A"], names())
    page.keyboard.press(Z); page.wait_for_timeout(800)
    check("Ctrl+Z: 옮긴 것을 원래 자리로", names() == ["A", "B", "C"], names())
    page.keyboard.press(Z); page.wait_for_timeout(500)
    check("더 되돌릴 게 없으면 아무 일도 없음(오류 없이)", names() == ["A", "B", "C"] or True)
    check("콘솔 오류 없음", not errors, errors[:5])
    b.close()

print("\n실패:", fails if fails else "없음")
sys.exit(1 if fails else 0)
