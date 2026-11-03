"""끌어 넣기 접힘 유지 · 여러 창 동시 작업 중 스크롤 고정 · 여러 항목 함께 옮기기 · 맨 앞 Enter 테스트.
사용: python3 tests/ux_test.py <앱 포트>"""
import sys
import requests
from playwright.sync_api import sync_playwright

BASE = f"http://127.0.0.1:{sys.argv[1]}"
fails = []


def check(name, cond, extra=""):
    print(("PASS " if cond else "FAIL ") + name, "" if cond else extra)
    if not cond:
        fails.append(name)


def add(parent, content):
    return requests.post(BASE + "/api/nodes", json={"parent_id": parent, "content": content}).json()["id"]


def tree(root):
    return requests.get(BASE + f"/api/export?format=txt&ids={root}").text.splitlines()[1:]


errors = []
with sync_playwright() as p:
    br = p.chromium.launch()
    page = br.new_page(viewport={"width": 1000, "height": 700})
    page.on("pageerror", lambda e: errors.append(str(e)))
    texts = lambda pg=page: pg.eval_on_selector_all("#tree .text", "els => els.map(e => e.textContent)")

    def cursor(t, end=True):
        page.locator("#tree .text", has_text=t).first.click()
        page.keyboard.press("End" if end else "Home")

    # ---- 맨 앞에서 Enter → 위에 빈 항목, 커서는 새 항목 ----
    R = add(None, "엔터루트"); A = add(R, "가나다"); add(A, "가나다의 자식")
    page.goto(f"{BASE}/#{R}"); page.wait_for_selector("#tree .text")
    cursor("가나다", end=False)
    page.keyboard.press("Enter"); page.wait_for_timeout(300)
    check("맨 앞 Enter: 위에 빈 항목이 생기고 커서가 그리로", texts()[:2] == ["", "가나다"] and page.evaluate("document.activeElement.textContent") == "", str(texts()))
    page.keyboard.type("새 글"); page.wait_for_timeout(900)
    check("새 항목에 바로 입력 · 원래 항목과 하위는 그대로", tree(R) == ["\t새 글", "\t가나다", "\t\t가나다의 자식"], str(tree(R)))
    cursor("가나다", end=False); page.keyboard.press("ArrowRight"); page.keyboard.press("Enter"); page.wait_for_timeout(700)
    check("중간 Enter는 예전처럼 나누기", [t.strip() for t in tree(R)][:3] == ["새 글", "가", "나다"], str(tree(R)))

    # ---- 끌어서 다른 항목 안에 넣어도 펼치지 않음 ----
    D = add(None, "끌기루트"); leaf = add(D, "빈목적지"); folded = add(D, "접힌목적지"); add(folded, "원래자식")
    requests.patch(BASE + f"/api/nodes/{folded}", json={"collapsed": 1})
    m1 = add(D, "옮길1"); m2 = add(D, "옮길2")
    page.goto(f"{BASE}/#{D}"); page.wait_for_selector("#tree .text")

    def drag_into(src, dst):
        s = page.locator(f'#tree .row[data-id="{src}"] .bullet').first
        sb = s.bounding_box(); tb = page.locator(f'#tree .row[data-id="{dst}"] .text').bounding_box()
        page.mouse.move(sb["x"] + sb["width"] / 2, sb["y"] + sb["height"] / 2); page.mouse.down()
        page.mouse.move(tb["x"] + 30, tb["y"] + tb["height"] / 2, steps=8)
        page.mouse.move(tb["x"] + 40, tb["y"] + tb["height"] / 2, steps=3)
        page.mouse.up(); page.wait_for_timeout(800)

    drag_into(m1, folded)
    check("접힌 항목에 끌어 넣기: 들어가고 계속 접혀 있음", "\t\t옮길1" in tree(D) and "옮길1" not in texts() and requests.get(BASE + f"/api/view?parent={folded}").json()["node"]["collapsed"] == 1, f"{tree(D)} {texts()}")
    drag_into(m2, leaf)
    check("하위 없던 항목에 끌어 넣기: 들어가고 접힌 채로", "\t\t옮길2" in tree(D) and "옮길2" not in texts() and requests.get(BASE + f"/api/view?parent={leaf}").json()["node"]["collapsed"] == 1, f"{tree(D)} {texts()}")

    # ---- 여러 항목 선택 + ⌘⇧↑↓ ----
    M = add(None, "다중루트"); P1 = add(M, "P1"); add(P1, "p1a"); P2 = add(M, "P2")
    for t in ("x1", "x2", "x3", "x4"): add(P2, t)
    page.goto(f"{BASE}/#{M}"); page.wait_for_selector("#tree .text")
    cursor("x2"); page.keyboard.press("Shift+ArrowDown"); page.keyboard.press("Shift+ArrowDown"); page.wait_for_timeout(200)
    page.keyboard.press("Control+Shift+ArrowDown"); page.wait_for_timeout(700)
    check("여러 항목 ⌘⇧↓: 함께 한 칸 아래", tree(M) == ["\tP1", "\t\tp1a", "\tP2", "\t\tx1", "\t\tx4", "\t\tx2", "\t\tx3"], str(tree(M)))
    page.keyboard.press("Control+Shift+ArrowUp"); page.keyboard.press("Control+Shift+ArrowUp"); page.wait_for_timeout(1000)
    check("여러 항목 ⌘⇧↑ 두 번: 맨 위까지", tree(M) == ["\tP1", "\t\tp1a", "\tP2", "\t\tx2", "\t\tx3", "\t\tx1", "\t\tx4"], str(tree(M)))
    page.keyboard.press("Control+Shift+ArrowUp"); page.wait_for_timeout(900)
    check("맨 위에서 한 번 더: 부모의 이전 형제(P1) 안 맨 아래로 함께", tree(M) == ["\tP1", "\t\tp1a", "\t\tx2", "\t\tx3", "\tP2", "\t\tx1", "\t\tx4"], str(tree(M)))
    check("옮긴 뒤에도 선택 유지", page.locator("#tree .row.selected").count() == 2)
    page.keyboard.press("Control+z"); page.wait_for_timeout(900)
    check("⌘Z로 되돌리기", tree(M)[3:5] == ["\t\tx2", "\t\tx3"] and tree(M)[2] == "\tP2", str(tree(M)))

    # ---- 여러 창 동시 작업: 다른 창에서 고쳐도 이 창은 스크롤되지 않음 ----
    S = add(None, "스크롤루트")
    kids = [add(S, f"줄 {i}") for i in range(160)]
    for k in kids[::7]:
        add(k, "하위")
    page.goto(f"{BASE}/#{S}"); page.wait_for_selector("#tree .text")
    page.evaluate("scrollTo(0, 1800)"); page.wait_for_timeout(300)
    before = page.evaluate("scrollY")
    top_row = lambda: page.evaluate("(() => { for (const r of document.querySelectorAll('#tree .row')) { const b = r.getBoundingClientRect(); if (b.bottom > 0) return [r.textContent, Math.round(b.top)]; } })()")
    t0 = top_row()
    other = br.new_page(viewport={"width": 1000, "height": 700})
    other.goto(f"{BASE}/#{S}"); other.wait_for_selector("#tree .text")
    for i in range(6):
        other.locator("#tree .text", has_text=f"줄 {i}").first.click(); other.keyboard.press("End"); other.keyboard.type(" 편집"); other.wait_for_timeout(700)
    other.locator("#tree .text", has_text="줄 2 편집").first.click(); other.keyboard.press("End"); other.keyboard.press("Enter"); other.keyboard.type("다른 창 새 항목"); other.wait_for_timeout(1500)
    page.wait_for_timeout(1500)
    t1 = top_row()
    check("다른 창이 화면 위쪽을 고쳐도 보고 있던 줄이 같은 자리", t0[0] == t1[0] and abs(t0[1] - t1[1]) <= 1, f"{t0} → {t1} (scrollY {before} → {page.evaluate('scrollY')})")
    check("다른 창의 변경은 반영됨", "다른 창 새 항목" in texts())
    # 이 창에서 글을 쓰고 있을 때도
    page.locator("#tree .text", has_text="줄 40").first.click(); page.keyboard.press("End"); page.wait_for_timeout(1500)
    t2 = top_row()
    for i in range(3):
        other.locator("#tree .text", has_text=f"줄 {i} 편집").first.click(); other.keyboard.press("End"); other.keyboard.type("!"); other.wait_for_timeout(800)
    page.wait_for_timeout(1500)
    t3 = top_row()
    check("이 창에서 커서를 둔 채로도 화면 고정 + 커서 유지", t2[0] == t3[0] and abs(t2[1] - t3[1]) <= 1 and page.evaluate("document.activeElement.textContent") == "줄 40", f"{t2} → {t3}, {page.evaluate('document.activeElement.textContent')}")

    # ---- 화면을 다시 그려도 저절로 스크롤되지 않음 ----
    page.goto(f"{BASE}/#{S}"); page.wait_for_selector("#tree .text"); page.wait_for_timeout(300)
    page.locator("#tree .text").first.click(); page.keyboard.press("End"); page.wait_for_timeout(200)  # 커서는 맨 위 항목
    page.mouse.wheel(0, 2500); page.wait_for_timeout(600)  # 사용자가 아래로 스크롤 (커서는 화면 밖)
    t4 = top_row()
    chev = page.evaluate("""(() => { for (const r of document.querySelectorAll('#tree .row')) { const b = r.getBoundingClientRect(); const c = r.querySelector('.chev');
        if (b.top > 200 && b.bottom < innerHeight - 50 && c && c.offsetParent) { const q = c.getBoundingClientRect(); return [q.x + q.width / 2, q.y + q.height / 2, r.textContent]; } } })()""")
    page.mouse.click(chev[0], chev[1]); page.wait_for_timeout(700)
    t5 = top_row()
    check("화면 밖에 커서가 있을 때 접기·펼치기를 눌러도 커서 쪽으로 튀지 않음", t4[0] == t5[0] and abs(t4[1] - t5[1]) <= 1, f"{t4} → {t5} ({chev[2]})")
    page.mouse.click(chev[0], chev[1]); page.wait_for_timeout(700)
    t6 = top_row()
    check("다시 눌러도 그대로", t4[0] == t6[0] and abs(t4[1] - t6[1]) <= 1, f"{t4} → {t6}")
    # 다른 항목으로 들어가면 맨 위부터
    page.mouse.wheel(0, 2500); page.wait_for_timeout(400)
    target = page.evaluate("(() => { for (const r of document.querySelectorAll('#tree .row')) { const b = r.getBoundingClientRect(); if (b.top > 100) return r.dataset.id; } })()")
    page.locator(f'#tree .row[data-id="{target}"] .text').click(); page.keyboard.press("Control+."); page.wait_for_timeout(700)
    check("줌인하면 맨 위부터", page.evaluate("scrollY") == 0, str(page.evaluate("scrollY")))

    # ---- 하위가 없는 항목으로 줌인 → Enter로 첫 항목 ----
    L = add(None, "잎부모"); leafz = add(L, "잎")
    page.goto(f"{BASE}/#{L}"); page.wait_for_selector("#tree .text")
    page.locator("#tree .text", has_text="잎").first.click(); page.keyboard.press("Control+."); page.wait_for_timeout(700)
    check("하위 없는 항목으로 줌인하면 커서가 제목에", page.evaluate("document.activeElement.id") == "title", page.evaluate("document.activeElement.id"))
    page.keyboard.press("Enter"); page.wait_for_timeout(300); page.keyboard.type("첫 하위"); page.wait_for_timeout(900)
    check("Enter → 첫 하위 항목이 생기고 바로 입력", tree(leafz) == ["\t첫 하위"], str(tree(leafz)))
    L2 = add(None, "잎2")
    page.goto(f"{BASE}/#{L2}"); page.wait_for_selector("#title"); page.wait_for_timeout(400)
    page.evaluate("document.activeElement.blur()"); page.keyboard.press("Enter"); page.wait_for_timeout(300); page.keyboard.type("빈 화면에서"); page.wait_for_timeout(900)
    check("커서 없이 Enter → 첫 항목", tree(L2) == ["\t빈 화면에서"], str(tree(L2)))

    # ---- 새 항목 → 들여쓰기·옮기기: 커서 줄이 화면의 같은 높이에 그대로 ----
    T = add(None, "들여루트"); tk = [add(T, f"들 {i}") for i in range(90)]
    for k in tk[::9]: add(k, "속")
    caret_top = lambda: page.evaluate("Math.round(document.activeElement.getBoundingClientRect().top)")
    page.goto(f"{BASE}/#{T}"); page.wait_for_selector("#tree .text"); page.wait_for_timeout(300)
    for target in ("들 40", "들 63", "들 89"):
        el = page.locator("#tree .text", has_text=target).first; el.scroll_into_view_if_needed(); el.click(); page.keyboard.press("End"); page.wait_for_timeout(300)
        page.keyboard.press("Enter"); page.keyboard.type("새"); page.wait_for_timeout(400)
        c0 = caret_top()
        page.keyboard.press("Tab"); page.wait_for_timeout(1000)
        c1 = caret_top()
        check(f"{target} 아래 새 항목 Tab: 커서 줄이 같은 높이", abs(c0 - c1) <= 2 and page.evaluate("document.activeElement.textContent") == "새" and 0 < c1 < 700, f"{c0} → {c1}")
        page.keyboard.press("Shift+Tab"); page.wait_for_timeout(1000)
        c2 = caret_top()
        check(f"{target} Shift+Tab도 같은 높이", abs(c0 - c2) <= 2, f"{c0} → {c2}")
        page.keyboard.press("Control+Shift+ArrowDown"); page.wait_for_timeout(1000)
        c3 = caret_top()
        check(f"{target} ⌘⇧↓ 옮겨도 커서 줄이 화면 안 같은 높이", abs(c0 - c3) <= 2 and 0 < c3 < 700, f"{c0} → {c3}")
    mctx = br.new_context(viewport={"width": 390, "height": 760}, has_touch=True, is_mobile=True)
    mp = mctx.new_page()
    mp.goto(f"{BASE}/#{T}"); mp.wait_for_selector("#tree .text"); mp.wait_for_timeout(300)
    el = mp.locator("#tree .text", has_text="들 50").first; el.scroll_into_view_if_needed(); el.tap(); mp.keyboard.press("End"); mp.wait_for_timeout(300)
    mp.keyboard.press("Enter"); mp.keyboard.type("폰"); mp.wait_for_timeout(400)
    m0 = mp.evaluate("Math.round(document.activeElement.getBoundingClientRect().top)")
    mp.locator("#mbar [data-k=TAB]").tap(); mp.wait_for_timeout(1000)
    m1 = mp.evaluate("Math.round(document.activeElement.getBoundingClientRect().top)")
    check("모바일 ⇥ 버튼: 커서 줄이 같은 높이 · 커서 유지", abs(m0 - m1) <= 2 and mp.evaluate("document.activeElement.textContent") == "폰", f"{m0} → {m1}")
    mctx.close()

    # ---- 맨 앞에서 Backspace → 위 항목과 합치기 ----
    G = add(None, "합치기루트"); g1 = add(G, "가나"); g2 = add(G, "다라"); add(g2, "다라의 자식"); g3 = add(G, "마바"); g4 = add(g3, "첫자식"); add(g3, "둘째자식")
    page.goto(f"{BASE}/#{G}"); page.wait_for_selector("#tree .text"); page.wait_for_timeout(300)
    before = tree(G)
    cursor("다라", end=False); page.keyboard.press("Backspace"); page.wait_for_timeout(900)
    check("맨 앞 Backspace: 위 항목 끝에 글이 붙고, 하위 항목은 위 항목 아래로", tree(G) == ["\t가나다라", "\t\t다라의 자식", "\t마바", "\t\t첫자식", "\t\t둘째자식"], str(tree(G)))
    check("커서는 붙인 자리 (가나|다라)", page.evaluate("[document.activeElement.textContent, getSelection().focusOffset]") == ["가나다라", 2], str(page.evaluate("[document.activeElement.textContent, getSelection().focusOffset]")))
    page.keyboard.type("+"); page.wait_for_timeout(700)
    check("바로 이어서 입력", tree(G)[0] == "\t가나+다라", str(tree(G)))
    page.keyboard.press("Backspace"); page.wait_for_timeout(500)
    cursor("첫자식", end=False); page.keyboard.press("Backspace"); page.wait_for_timeout(900)
    check("첫 자식은 부모와 합쳐지고, 그 하위는 같은 자리에", tree(G) == ["\t가나다라", "\t\t다라의 자식", "\t마바첫자식", "\t\t둘째자식"], str(tree(G)))
    page.keyboard.press("Control+z"); page.wait_for_timeout(1200)
    check("⌘Z 한 번으로 합치기 전체를 되돌림", tree(G) == ["\t가나다라", "\t\t다라의 자식", "\t마바", "\t\t첫자식", "\t\t둘째자식"], str(tree(G)))
    cursor("가나다라", end=False); page.keyboard.press("Backspace"); page.wait_for_timeout(900)
    check("화면 맨 위 항목은 제목(합치기루트)으로 합쳐짐", requests.get(BASE + f"/api/view?parent={G}").json()["node"]["content"] == "합치기루트가나다라" and tree(G)[0] == "\t다라의 자식", str(tree(G)))
    page.keyboard.press("Control+z"); page.wait_for_timeout(1200)
    cursor("가나다라"); page.keyboard.press("Backspace"); page.wait_for_timeout(500)
    check("글 중간·끝의 Backspace는 그대로 한 글자 지우기", tree(G)[0] == "\t가나다", str(tree(G)))

    # ---- Shift+클릭: 다른 항목이면 항목 선택, 같은 항목 안이면 글자 선택 ----
    H = add(None, "시프트루트"); add(H, "첫 번째 항목 글자"); add(H, "두 번째 항목"); add(H, "세 번째 항목")
    page.goto(f"{BASE}/#{H}"); page.wait_for_selector("#tree .text"); page.wait_for_timeout(300)
    t1 = page.locator("#tree .text", has_text="첫 번째").first
    b1 = t1.bounding_box()
    page.mouse.click(b1["x"] + 4, b1["y"] + b1["height"] / 2)
    page.keyboard.down("Shift"); page.mouse.click(b1["x"] + b1["width"] - 4, b1["y"] + b1["height"] / 2); page.keyboard.up("Shift"); page.wait_for_timeout(200)
    check("같은 항목 안 Shift+클릭 = 글자 선택 (항목 선택 아님)", page.locator("#tree .row.selected").count() == 0 and len(page.evaluate("getSelection().toString()")) >= 5, page.evaluate("getSelection().toString()"))
    t3 = page.locator("#tree .text", has_text="세 번째").first.bounding_box()
    page.keyboard.down("Shift"); page.mouse.click(t3["x"] + 10, t3["y"] + t3["height"] / 2); page.keyboard.up("Shift"); page.wait_for_timeout(200)
    check("다른 항목 Shift+클릭 = 항목 범위 선택", page.locator("#tree .row.selected").count() == 3, str(page.locator("#tree .row.selected").count()))
    page.keyboard.press("Escape")

    # ---- 맨 위 항목 맨 앞 Backspace → 제목으로 합치기 ----
    Z = add(None, "제목"); z1 = add(Z, "첫줄"); add(z1, "첫줄의 하위"); add(Z, "둘째줄")
    page.goto(f"{BASE}/#{Z}"); page.wait_for_selector("#tree .text"); page.wait_for_timeout(300)
    cursor("첫줄", end=False); page.keyboard.press("Backspace"); page.wait_for_timeout(900)
    title_txt = requests.get(BASE + f"/api/view?parent={Z}").json()["node"]["content"]
    check("맨 위 항목은 제목 끝에 붙고, 하위 항목은 그 자리로", title_txt == "제목첫줄" and page.inner_text("#title") == "제목첫줄" and tree(Z) == ["\t첫줄의 하위", "\t둘째줄"], f"{title_txt} {tree(Z)}")
    check("커서는 제목의 붙인 자리", page.evaluate("[document.activeElement.id, getSelection().focusOffset]") == ["title", 2], str(page.evaluate("[document.activeElement.id, getSelection().focusOffset]")))
    page.keyboard.press("Control+z"); page.wait_for_timeout(1200)
    check("⌘Z로 되돌리기", requests.get(BASE + f"/api/view?parent={Z}").json()["node"]["content"] == "제목" and tree(Z)[:2] == ["\t첫줄", "\t\t첫줄의 하위"], str(tree(Z)))

    # ---- PDF: 기본으로 펼쳐져 보이고, 마지막 페이지에서 다시 열림 ----
    import io as _io
    from reportlab.pdfgen import canvas as _cv
    buf = _io.BytesIO(); c = _cv.Canvas(buf)
    for k in range(1, 7):
        c.setFont("Helvetica", 40); c.drawString(100, 700, f"Page {k}"); c.showPage()
    c.save()
    up = requests.post(BASE + "/api/upload", files={"file": ("문서.pdf", buf.getvalue())}).json()
    P = add(None, "PDF루트"); add(P, "자료 " + up["markdown"])
    page.goto(f"{BASE}/#{P}"); page.wait_for_selector(".att-pdfview canvas", timeout=15000); page.wait_for_timeout(500)
    pdflabel = lambda: page.evaluate("(() => { const n = document.querySelector('.att-pdfnum'); return n ? n.value + document.querySelector('.att-pdftot').textContent : document.querySelector('.att-pdfpage').textContent; })()")
    check("PDF가 처음부터 펼쳐져 보임 (PDF.js로 그림)", page.locator(".att-pdfview").is_visible() and page.locator(".att-pdfview canvas").count() >= 1)
    check("페이지 표시 1 / 6", pdflabel() == "1 / 6", pdflabel())
    page.click(".att-pdf .att-btn[aria-label='다음 페이지']"); page.wait_for_timeout(300)
    page.click(".att-pdf .att-btn[aria-label='다음 페이지']"); page.wait_for_timeout(300)
    page.click(".att-pdf .att-btn[aria-label='다음 페이지']"); page.wait_for_timeout(1500)
    check("다음 페이지 → 4 / 6", pdflabel() == "4 / 6", pdflabel())
    page.reload(); page.wait_for_selector(".att-pdfview canvas", timeout=15000); page.wait_for_timeout(1200)
    check("새로고침해도 마지막 페이지(4)에서 열림", pdflabel() == "4 / 6" and page.evaluate("(() => { const v = document.querySelector('.att-pdfview'); const p = v.querySelector('[data-page=\"4\"]'); return Math.abs(v.scrollTop - p.offsetTop) < 30; })()"), pdflabel())
    check("PDF 카드에 '화면 가득 보기' 단추", page.locator(".att-pdfhead [aria-label^='화면 가득']").count() == 1)
    # 페이지 번호 입력 → 이동
    page.click(".att-pdfnum"); page.keyboard.type("6"); page.keyboard.press("Enter"); page.wait_for_timeout(1200)
    check("페이지 번호 6 입력 → 6 / 6으로 이동", pdflabel() == "6 / 6" and page.evaluate("(() => { const v = document.querySelector('.att-pdfview'); const p = v.querySelector('[data-page=\"6\"]'); return Math.abs(v.scrollTop - p.offsetTop) < 30 || v.scrollTop + v.clientHeight >= v.scrollHeight - 2; })()"), pdflabel())
    page.click(".att-pdfnum"); page.keyboard.type("99"); page.keyboard.press("Enter"); page.wait_for_timeout(600)
    check("범위 밖 번호(99) → 마지막 페이지", pdflabel() == "6 / 6", pdflabel())
    page.click(".att-pdfnum"); page.keyboard.type("x"); page.keyboard.press("Escape"); page.wait_for_timeout(200)
    check("Esc → 원래 번호로, 항목 글은 그대로", pdflabel() == "6 / 6" and "x" not in page.inner_text("#tree"), pdflabel())
    page.click(".att-pdfnum"); page.keyboard.type("4"); page.keyboard.press("Enter"); page.wait_for_timeout(1200)
    check("4 입력 → 4 / 6", pdflabel() == "4 / 6", pdflabel())
    # 다른 창에서 고치면 이 창은 화면을 다시 그려요 → 보던 PDF 페이지가 그대로여야
    at4 = "(() => { const v = document.querySelector('.att-pdfview'); const p = v.querySelector('[data-page=\"4\"]'); return Math.abs(v.scrollTop - p.offsetTop) < 30; })()"
    for k in range(3):
        requests.post(BASE + "/api/nodes", json={"parent_id": P, "position": 0, "content": f"다른 창에서 {k}"}); page.wait_for_timeout(1300)
    check("다른 창에서 고쳐 다시 그려져도 보던 PDF 페이지(4) 유지", page.evaluate(at4) and pdflabel() == "4 / 6", f"{pdflabel()} top={page.evaluate('document.querySelector(\'.att-pdfview\').scrollTop')}")
    cursor("자료"); page.keyboard.press("End"); page.keyboard.type(" 메모"); page.wait_for_timeout(900)
    check("항목 글을 고쳐 다시 그려져도 보던 페이지 유지", pdflabel() == "4 / 6", pdflabel())

    # ---- 영상·오디오: 마지막 재생 위치에서 이어서 ----
    import struct as _st
    rate = 8000; data = b"\x00\x00" * rate * 20
    wav = b"RIFF" + _st.pack("<I", 36 + len(data)) + b"WAVEfmt " + _st.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16) + b"data" + _st.pack("<I", len(data)) + data
    au = requests.post(BASE + "/api/upload", files={"file": ("긴녹음.wav", wav)}).json()
    A = add(None, "오디오루트"); add(A, "들을 것 " + au["markdown"])
    page.goto(f"{BASE}/#{A}"); page.wait_for_selector(".att-audio audio", state="attached"); page.wait_for_timeout(500)
    page.eval_on_selector(".att-audio audio", "a => new Promise(r => { const go = () => { a.currentTime = 12.5; a.dispatchEvent(new Event('pause')); r(); }; a.readyState >= 1 ? go() : a.addEventListener('loadedmetadata', go, { once: true }); })")
    page.wait_for_timeout(800)
    check("멈춘 위치 저장", abs(requests.get(BASE + "/api/media-pos").json()["pos"].get(au["url"], {}).get("t", 0) - 12.5) < 0.2, str(requests.get(BASE + "/api/media-pos").json()))
    page.reload(); page.wait_for_selector(".att-audio audio", state="attached"); page.wait_for_timeout(1500)
    t = page.eval_on_selector(".att-audio audio", "a => a.currentTime")
    check("새로고침하면 그 위치에서 이어서", abs(t - 12.5) < 0.3, str(t))
    check("콘솔 오류 없음", not errors, str(errors))
    br.close()

print("\n" + ("모두 통과" if not fails else f"실패 {len(fails)}개: {fails}"))
sys.exit(1 if fails else 0)
