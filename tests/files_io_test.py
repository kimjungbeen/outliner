"""파일은 명령 셋: import(가져오기) · export(내보내기) · file(첨부 관리).
export 창: 문서(Markdown · 텍스트 · JSON · PDF) + 백업(전체 백업 · DB만). 백업 DB는 빈 공간 · 검색 색인 없이 작게, 가져오면 검색도 돼요.
import: 백업이 아닌 ZIP(첨부 파일 ZIP)은 풀어서 첨부로. 예전 명령 이름(af · backup-all · export-pdf)의 단축키 · 즐겨찾기는 새 이름으로.
사용: python3 tests/files_io_test.py <앱 포트>"""
import io, sqlite3, sys, tempfile, zipfile, requests
from playwright.sync_api import sync_playwright

B = f"http://127.0.0.1:{sys.argv[1]}"
fails = []
def check(name, ok, info=""):
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else f" {info}"))
    if not ok: fails.append(name)
put = lambda k, v: requests.put(f"{B}/api/plugin-data/core/{k}", json={"value": v})
# 예전 이름으로 저장된 설정 (af에 내가 정한 단축키 · 즐겨찾기 · 사용 횟수)
put("cmd_keys", {"map": {"Alt+Shift+Q": "af", "Alt+I": "import"}, "off": ["backup-all"]}); put("cmd_favs", ["af", "export-pdf"])
root = requests.post(B + "/api/nodes", json={"parent_id": None, "position": 0, "content": "파일 셋"}).json()["id"]
base = requests.post(B + "/api/nodes", json={"parent_id": root, "content": "여기 아래"}).json()["id"]
for i in range(300): requests.post(B + "/api/nodes", json={"parent_id": root, "content": f"지울 항목 {i} " + "가" * 400})
ids = [n["id"] for n in requests.get(f"{B}/api/children?parent={root}&limit=400").json()["nodes"] if n["content"].startswith("지울")]
requests.post(B + "/api/bulk", json={"ops": [{"id": i, "delete": True} for i in ids]})

# ---- 백업 DB: 작게 (빈 공간 · 검색 색인 빼고) ----
raw = requests.get(B + "/api/export/db").content
f = tempfile.NamedTemporaryFile(suffix=".db", delete=False); f.write(raw); f.close()
c = sqlite3.connect(f.name)
tables = [r[0] for r in c.execute("select name from sqlite_master where type='table'")]
check("DB만: 검색 색인 · 빈 공간 없이", "nodes_fts" not in tables and c.execute("pragma freelist_count").fetchone()[0] == 0, (tables, c.execute("pragma freelist_count").fetchone()))
check("DB만: 항목은 다 있어요", c.execute("select count(*) from nodes where content='여기 아래'").fetchone()[0] == 1)
c.close()
z = zipfile.ZipFile(io.BytesIO(requests.get(B + "/api/export/all").content))
check("전체 백업 ZIP 안의 DB도 작게", "outliner.db" in z.namelist() and len(z.read("outliner.db")) <= len(raw) + 4096, (len(raw), len(z.read("outliner.db"))))

# ---- 첨부 파일 ZIP (file 창에서 여럿 받은 것처럼) ----
png = bytes.fromhex("89504e470d0a1a0a0000000d4948445200000001000000010806000000" "1f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082")
buf = io.BytesIO()
with zipfile.ZipFile(buf, "w") as zz:
    zz.writestr("사진/점.png", png); zz.writestr("메모.txt", "넣을 수 없어요"); zz.writestr("__MACOSX/._점.png", "x")
zpath = tempfile.mktemp(suffix=".zip"); open(zpath, "wb").write(buf.getvalue())
r = requests.post(B + "/api/import/db", files={"file": ("첨부.zip", buf.getvalue())}, data={"mode": "check"}).json()
check("백업이 아닌 ZIP은 서버가 알려줘요 (files_zip)", r.get("files_zip") is True, r)

with sync_playwright() as p:
    br = p.chromium.launch(); pg = br.new_page(viewport={"width": 1100, "height": 800})
    pg.goto(f"{B}/#{root}"); pg.wait_for_selector(f'#tree .text[data-id="{base}"]'); pg.wait_for_timeout(400)
    def cmd(name):
        pg.keyboard.press("Control+/"); pg.wait_for_selector(".cmdl-find"); pg.keyboard.type(name); pg.wait_for_timeout(300)
        return pg.eval_on_selector_all(".cmdl-row .cmdl-name", "els => els.map(e => e.textContent)")
    names = cmd("e")
    check("명령 목록에 예전 이름이 없어요", not {"backup-all", "export-pdf", "af"} & set(names), names)
    pg.keyboard.press("Escape")
    pg.click(f'#tree .text[data-id="{base}"]'); pg.keyboard.press("Alt+x"); pg.wait_for_selector(".wfx-dialog h3:text-is('내보내기')")
    btns = pg.eval_on_selector_all(".wfx-dialog .wfx-btn", "els => els.map(e => e.textContent)")
    check("⌥X 내보내기: 문서 4 + 백업 2", btns == ["Markdown", "텍스트", "JSON", "PDF…", "전체 백업", "DB만", "취소"], btns)
    with pg.expect_download() as dl:
        pg.click(".wfx-dialog .wfx-btn:text-is('전체 백업')")
    check("전체 백업 내려받기", dl.value.suggested_filename.startswith("outliner-full-") and dl.value.suggested_filename.endswith(".zip"), dl.value.suggested_filename)
    # file (예전 af): 내가 정한 단축키 · 즐겨찾기가 그대로
    pg.click(f'#tree .text[data-id="{base}"]'); pg.keyboard.press("Alt+Shift+Q"); pg.wait_for_selector(".wfx-dialog h3:has-text('첨부 파일')", timeout=5000)
    check("예전 af에 정한 단축키(⌥⇧Q)로 file 창", pg.locator(".wfx-dialog h3", has_text="첨부 파일").count() == 1)
    pg.keyboard.press("Escape"); pg.wait_for_timeout(300)
    favs = pg.evaluate("import('/commands.js').then((P) => P.cmdPrefs.favs)")
    check("즐겨찾기도 새 이름으로 (af · export-pdf → file · export)", favs == ["file", "export"], favs)
    # import: 첨부 파일 ZIP → 풀어서 커서 항목 아래에
    pg.click(f'#tree .text[data-id="{base}"]'); pg.keyboard.press("End")
    pg.keyboard.press("Alt+i"); pg.wait_for_timeout(300)
    pg.set_input_files("#importfile", zpath); pg.wait_for_timeout(2000)
    kids = [n["content"] for n in requests.get(f"{B}/api/children?parent={root}&limit=20").json()["nodes"]]
    check("첨부 ZIP을 넣으면 안의 이미지가 첨부로 (txt · 숨김 파일은 건너뛰기)", any(k.startswith("![점](/files/") for k in kids) and not any("메모" in k for k in kids), kids)
    check("알림: 몇 개 넣고 몇 개 건너뛰었는지", "1개를 첨부로" in pg.inner_text("#toast") and "건너뛰었어요" in pg.inner_text("#toast"), pg.inner_text("#toast"))
    # import: 작게 만든 백업 DB를 가져오는 창 → 아래에 추가(그 DB의 항목을 더해요)하면 검색도 돼요 (색인은 넣을 때 다시 만들어요)
    pg.set_input_files("#importfile", f.name); pg.wait_for_selector(".pdf-dlg:has-text('DB 파일 가져오기')")
    check("백업 DB를 넣으면 아래에 추가 · 대체하기 창", pg.locator(".pdf-dlg .pdf-btn", has_text="대체하기").count() == 1)
    pg.keyboard.press("Escape")
    requests.post(B + "/api/import/db", files={"file": ("b.db", open(f.name, "rb"))}, data={"mode": "append"})
    hits = requests.get(f"{B}/api/search?q=여기 아래&limit=10").json().get("results", [])
    check("백업 DB를 아래에 추가하면 그 항목도 검색돼요 (색인을 다시 만들어요)", len(hits) >= 2, len(hits))
    br.close()

# 첨부는 한 파일 1GB까지 — 넘으면 알림 글 (서버가 JSON으로)
print("\n" + ("모두 통과" if not fails else f"실패 {len(fails)}개: {fails}"))
sys.exit(1 if fails else 0)
