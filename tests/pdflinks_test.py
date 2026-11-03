"""PDF 안의 링크 테스트: 웹 주소 → 새 탭, 문서 안 링크 → 그 페이지로.
사용: python3 tests/pdflinks_test.py <앱 포트>"""
import io
import sys
import requests
from reportlab.pdfgen import canvas
from playwright.sync_api import sync_playwright

BASE = f"http://127.0.0.1:{sys.argv[1]}"
fails = []


def check(name, cond, extra=""):
    print(("PASS " if cond else "FAIL ") + name, "" if cond else extra)
    if not cond:
        fails.append(name)


buf = io.BytesIO(); c = canvas.Canvas(buf)
c.setFont("Helvetica", 30); c.drawString(100, 700, "Contents")
c.drawString(100, 600, "Go to page 5"); c.linkRect("", "p5", (90, 590, 400, 640), relative=0)
c.drawString(100, 500, "example.com"); c.linkURL("https://example.com/", (90, 490, 400, 540), relative=0)
c.showPage()
for k in range(2, 7):
    c.bookmarkPage(f"p{k}"); c.setFont("Helvetica", 40); c.drawString(100, 700, f"Page {k}"); c.showPage()
c.save()
up = requests.post(BASE + "/api/upload", files={"file": ("목차.pdf", buf.getvalue())}).json()
nid = requests.post(BASE + "/api/nodes", json={"parent_id": None, "position": 0, "content": "목차 " + up["markdown"]}).json()["id"]
# 여러 PDF에서 찾기(pdfsearch)용 두 번째 PDF: 2쪽에만 "page"
buf2 = io.BytesIO(); c2 = canvas.Canvas(buf2)
c2.setFont("Helvetica", 30); c2.drawString(100, 700, "Appendix"); c2.showPage()
c2.setFont("Helvetica", 30); c2.drawString(100, 700, "Last page of appendix"); c2.showPage(); c2.save()
up2 = requests.post(BASE + "/api/upload", files={"file": ("부록.pdf", buf2.getvalue())}).json()
nid2 = requests.post(BASE + "/api/nodes", json={"parent_id": None, "position": 1, "content": "부록 " + up2["markdown"]}).json()["id"]

with sync_playwright() as p:
    br = p.chromium.launch()
    ctx = br.new_context(viewport={"width": 1100, "height": 900})
    page = ctx.new_page()
    errors = []; page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(f"{BASE}/#{nid}"); page.wait_for_selector(".att-pdfpg[data-page='1'] .att-pdflink", timeout=15000)
    links = page.eval_on_selector_all(".att-pdfpg[data-page='1'] .att-pdflink", "ls => ls.map(l => [l.getAttribute('href'), l.target, l.offsetWidth > 50 && l.offsetHeight > 10])")
    check("1쪽에 링크 2개 (웹 주소 + 문서 안)", len(links) == 2 and any(h == "https://example.com/" and t == "_blank" for h, t, _ in links) and all(ok for *_, ok in links), str(links))
    page.click(".att-pdfpg[data-page='1'] .att-pdflink[href='#']"); page.wait_for_timeout(1200)
    lab = page.evaluate("document.querySelector('.att-pdfnum').value")
    at = page.evaluate("(() => { const v = document.querySelector('.att-pdfview'); const p = v.querySelector('[data-page=\"5\"]'); return Math.abs(v.scrollTop - p.offsetTop) < 30; })()")
    check("문서 안 링크 → 5쪽으로 이동", lab == "5" and at, f"{lab} {at}")
    check("주소창은 그대로 (#로 바뀌지 않음)", page.url.endswith(f"#{nid}"), page.url)
    page.click(".att-pdfnum"); page.keyboard.type("1"); page.keyboard.press("Enter"); page.wait_for_timeout(800)
    with ctx.expect_page() as pop:
        page.route("https://example.com/**", lambda r: r.fulfill(body="ok"))
        ctx.route("https://example.com/**", lambda r: r.fulfill(body="ok"))
        page.click(".att-pdfpg[data-page='1'] .att-pdflink[href^='https']")
    check("웹 주소 링크 → 새 탭", pop.value.url.startswith("https://example.com"), pop.value.url)
    # PDF 안에서 찾기: 1쪽 "Go to page 5" + 2~6쪽 "Page k" = 6개 (대소문자 무시) → Enter 다음 · ⇧Enter 이전 · Esc 닫기
    page.click(".att-pdfhead button[aria-label^='PDF 안에서 찾기']"); page.wait_for_selector(".att-pdffindq:focus")
    page.keyboard.type("page"); page.wait_for_function("document.querySelector('.att-pdffindn').textContent === '1 / 6'", timeout=5000)
    check("찾기: 6개 · 첫 결과 칠함", page.locator(".att-pdffound.cur").count() == 1, page.inner_text(".att-pdffindn"))
    page.keyboard.press("Enter"); page.wait_for_timeout(600)
    check("Enter → 다음 결과 (2쪽)", page.inner_text(".att-pdffindn") == "2 / 6" and page.evaluate("document.querySelector('.att-pdfnum').value") == "2" and page.locator(".att-pdfpg[data-page='2'] .att-pdffound.cur").count() == 1, page.inner_text(".att-pdffindn"))
    page.keyboard.press("Shift+Enter"); page.keyboard.press("Shift+Enter"); page.wait_for_timeout(600)
    check("⇧Enter → 이전 (처음에서 끝으로 돌아요)", page.inner_text(".att-pdffindn") == "6 / 6" and page.evaluate("document.querySelector('.att-pdfnum').value") == "6", page.inner_text(".att-pdffindn"))
    page.fill(".att-pdffindq", "zzz"); page.wait_for_function("document.querySelector('.att-pdffindn').textContent === '없음'", timeout=5000)
    check("없는 글 → 없음 · 칠한 것 없음", page.locator(".att-pdffound").count() == 0)
    # 띄어쓰기 낀 글도 (1쪽 "page 5" · 5쪽 "Page 5") — 보던 6쪽 뒤에 없으면 처음부터
    page.fill(".att-pdffindq", "page 5"); page.wait_for_function("document.querySelector('.att-pdffindn').textContent === '1 / 2'", timeout=5000)
    page.keyboard.press("Escape"); page.wait_for_timeout(300)
    check("Esc → 찾기 닫고 칠한 것 지워요", page.locator(".att-pdffind").is_hidden() and page.locator(".att-pdffound").count() == 0)
    # 여러 PDF에서 찾기: 두 PDF의 "page" 7개 (목차 6 + 부록 1) → 부록 결과를 고르면 그 PDF 2쪽으로 가서 칠해요
    page.goto(f"{BASE}/"); page.wait_for_selector("#tree .text"); page.click("#tree .text >> nth=0")
    page.keyboard.press("ControlOrMeta+/"); page.wait_for_selector(".cmdl-find"); page.keyboard.type("pdfsearch"); page.wait_for_timeout(150); page.keyboard.press("Enter")
    page.wait_for_selector(".dlg-ov:not(.out) .palette [data-f=search]"); page.keyboard.type("page")
    try: page.wait_for_function("document.querySelector('.dlg-ov:not(.out) [data-f=info]')?.textContent.startsWith('7개 · 문단 7개 · PDF 2개')", timeout=15000)
    except Exception: print("INFO:", page.evaluate("document.querySelector('.dlg-ov:not(.out) [data-f=info]')?.textContent"), page.evaluate("document.querySelector('.dlg-ov:not(.out) [data-f=search]')?.value")); raise
    rows = page.locator(".dlg-ov:not(.out) [data-f=hit]")
    last = rows.nth(rows.count() - 1)
    check("pdfsearch: 파일 이름 · 쪽 · 찾은 글 강조", last.locator("[data-f=hit-path]").inner_text() == "부록 · 2쪽" and last.locator("mark").first.inner_text().lower() == "page", last.inner_text())
    page.keyboard.press("End"); [page.keyboard.press("ArrowDown") for _ in range(6)]; page.keyboard.press("Enter")
    card2 = page.locator(f".att-pdf[data-url='{up2['url']}']")
    page.wait_for_function(f"document.querySelector(\".att-pdf[data-url='{up2['url']}'] .att-pdffound.cur\")", timeout=10000)
    check("pdfsearch: 고르면 그 PDF 2쪽 · 찾기 칸에 검색어 · 칠함", card2.locator(".att-pdfnum").input_value() == "2" and card2.locator(".att-pdffindq").input_value() == "page" and card2.locator(".att-pdfpg[data-page='2'] .att-pdffound.cur").count() == 1, card2.locator(".att-pdffindn").inner_text())
    name2 = up2["url"].split("/")[-1]
    cached = requests.get(f"{BASE}/api/pdf-text/{name2}").json().get("pages")
    check("pdfsearch: 꺼낸 글을 서버에 남겨요 (다음부터 다시 읽지 않게)", cached == ["Appendix", "Last page of appendix"], cached)
    check("PDF 글 캐시: 첨부가 아닌 이름은 거절", requests.put(f"{BASE}/api/pdf-text/notahash.pdf", json={"pages": []}).status_code == 400 and requests.put(f"{BASE}/api/pdf-text/{name2}", json={"pages": "x"}).status_code == 400)
    # 마지막 쪽 번호: 끝까지 내리면 마지막 쪽 (짧아서 맨 위까지 못 올라와도) · 쪽 번호로 옮긴 쪽은 그대로
    card1 = page.locator(f".att-pdf[data-url='{up['url']}']")
    card1.locator(".att-pdfview").evaluate("v => { v.scrollTop = v.scrollHeight; }"); page.wait_for_timeout(400)
    check("끝까지 내리면 마지막 쪽 번호 (6)", card1.locator(".att-pdfnum").input_value() == "6", card1.locator(".att-pdfnum").input_value())
    check("페이지 오류 없음", not errors, str(errors))
    br.close()

print("\n" + ("모두 통과" if not fails else f"실패 {len(fails)}개: {fails}"))
sys.exit(1 if fails else 0)
