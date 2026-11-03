"""Dropbox 백업 · 동기화 플러그인(dropbox) — 두 기기(서버 두 개)가 가짜 Dropbox(브라우저 요청을 가로채 흉내)를 같이 써요.
첫 백업(전체 사본) · 바뀐 것 없음 · 처음 맞추는 기기(로그인 → Dropbox 것으로 바꾸기) · 한쪽만 바뀜(바뀐 것만 올리기 · 받기) · 양쪽 다 바뀜(3-way, 충돌은 '이 기기에서 고친 글'로) ·
다시 받아도 중복 없음 · 첨부 주고받기 · 동시에 올리면 head.json rev로 막히고 다시 합침(올린 변경 파일은 지움) · 쌓이면 새 전체 사본으로 정리 · 덮어쓰기(reset)면 다른 기기는 다시 물어요 ·
로그인이 풀리면 연결 화면으로.
사용: python3 tests/dropbox_test.py <앱 포트 A> <앱 포트 B>"""
import base64, json, os, sqlite3, sys, requests
from pathlib import Path
from playwright.sync_api import sync_playwright

A, B = (f"http://127.0.0.1:{p}" for p in sys.argv[1:3])
fails = []
def check(name, ok, info=""):
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else f" {info}"))
    if not ok: fails.append(name)

# ---- 가짜 Dropbox ----
store, revs, n = {}, {}, [0]      # 경로 → (내용, rev) · rev → 내용
fake = {"bad_refresh": False, "race": None, "uploads": [], "downloads": []}
CORS = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Expose-Headers": "*"}
def reply(route, status, body):
    route.fulfill(status=status, headers={**CORS, "Content-Type": "application/json"}, body=json.dumps(body))
def put_file(path, data):
    n[0] += 1; rev = f"rev{n[0]:04d}"; store[path] = (data, rev); revs[rev] = data
    return {"name": path.rsplit("/", 1)[1], "path_display": path, "rev": rev, "size": len(data), ".tag": "file"}
def dropbox(route):
    req = route.request
    if req.method == "OPTIONS": return route.fulfill(status=200, headers=CORS, body="")
    url = req.url.split("?")[0]
    if url.endswith("/oauth2/token"):
        if fake["bad_refresh"] and "refresh_token" in (req.post_data or ""): return reply(route, 400, {"error": "invalid_grant", "error_description": "refresh token is invalid"})
        return reply(route, 200, {"access_token": "acc", "expires_in": 14400, "refresh_token": "ref", "token_type": "bearer"})
    if req.headers.get("authorization") != "Bearer acc": return reply(route, 401, {"error_summary": "invalid_access_token/"})
    arg = json.loads(req.headers.get("dropbox-api-arg") or "null")
    j = json.loads(req.post_data) if req.headers.get("content-type") == "application/json" else None
    if url.endswith("/2/files/get_metadata"):
        if j["path"] not in store: return reply(route, 409, {"error_summary": "path/not_found/."})
        d, rev = store[j["path"]]; return reply(route, 200, {".tag": "file", "rev": rev, "size": len(d), "name": j["path"]})
    if url.endswith("/2/files/list_folder"):
        es = [{".tag": "file", "name": p.rsplit("/", 1)[1]} for p in store if p.startswith(j["path"] + "/")]
        return reply(route, 200, {"entries": es, "has_more": False, "cursor": "c"}) if es else reply(route, 409, {"error_summary": "path/not_found/."})
    if url.endswith("/2/files/download"):
        p = arg["path"]; d = revs.get(p[4:]) if p.startswith("rev:") else store.get(p, (None,))[0]
        if d is None: return reply(route, 409, {"error_summary": "path/not_found/."})
        fake["downloads"].append(p)
        return route.fulfill(status=200, headers={**CORS, "Content-Type": "application/octet-stream"}, body=d)
    if url.endswith("/2/files/upload"):
        p, mode, body = arg["path"], arg["mode"], req.post_data_buffer or b""
        if p == "/head.json" and fake["race"]:  # 그사이 다른 기기가 올렸어요
            other = fake["race"]; fake["race"] = None; put_file(p, other)
        cur = store.get(p)
        if (mode == "add" and cur) or (isinstance(mode, dict) and (not cur or cur[1] != mode["update"])):
            return reply(route, 409, {"error_summary": "path/conflict/file/.."})
        fake["uploads"].append(p)
        return reply(route, 200, put_file(p, body))
    if url.endswith("/2/files/delete_v2"):
        if store.pop(j["path"], None) is None: return reply(route, 409, {"error_summary": "path_lookup/not_found/."})
        return reply(route, 200, {"metadata": {"path_display": j["path"]}})
    return reply(route, 400, {"error_summary": "unknown/"})
def head(): return json.loads(store["/head.json"][0])
def referenced():
    h = head(); return {h["snapshot"]["path"], *(c["path"] for c in h["changes"])}
def stray():
    """head.json이 가리키지 않는 사본 · 변경 파일"""
    return sorted(p for p in store if p.startswith(("/snapshots/", "/changes/")) and p not in referenced())
def uploads_since(k): return [p for p in fake["uploads"][k:] if p != "/head.json"]

# ---- 앱 쪽 도우미 ----
def rows(base):
    con = sqlite3.connect(f"file:{requests.get(base + '/api/ping').json()['db']}?mode=ro", uri=True)
    try: return [r[0] for r in con.execute("SELECT content FROM nodes")]
    finally: con.close()
def add(base, text): return requests.post(base + "/api/nodes", json={"parent_id": None, "position": 0, "content": text}).json()["id"]
def edit(base, nid, text): requests.patch(f"{base}/api/nodes/{nid}", json={"content": text})
def node_id(base, text):
    con = sqlite3.connect(f"file:{requests.get(base + '/api/ping').json()['db']}?mode=ro", uri=True)
    try: return con.execute("SELECT id FROM nodes WHERE content=?", (text,)).fetchone()[0]
    finally: con.close()
def data_dir(base): return Path(requests.get(base + '/api/ping').json()['db']).parent
LOGIN = "() => localStorage.setItem('outliner.dropbox', JSON.stringify({ appKey: 'key', refresh: 'ref' }))"

with sync_playwright() as p:
    pages = []
    for _ in range(2):  # 기기마다 따로 띄운 브라우저 (창이 하나씩)
        br = p.chromium.launch(); ctx = br.new_context(viewport={"width": 1100, "height": 800})
        ctx.route("https://api.dropboxapi.com/**", dropbox); ctx.route("https://content.dropboxapi.com/**", dropbox)
        ctx.route("https://www.dropbox.com/**", lambda r: r.fulfill(status=200, headers={"Content-Type": "text/html"}, body="<p>허용 코드: CODE123</p>"))
        pg_ = ctx.new_page(); pg_.on("pageerror", lambda e: print("PAGEERR", e)); pages.append(pg_)
    pa, pb = pages
    for pg, base in ((pa, A), (pb, B)):
        pg.goto(base); pg.wait_for_selector("#tree .text")

    def run(pg):
        """명령 목록에서 dropbox 실행"""
        pg.evaluate("window.__old = 1")  # 새로고침되면 사라져요
        pg.keyboard.press("Escape"); pg.locator("#tree .text").first.click()
        pg.keyboard.press("Control+/"); pg.wait_for_selector(".cmdl-find"); pg.keyboard.type("dropbox"); pg.wait_for_timeout(250); pg.keyboard.press("Enter")
        try: pg.wait_for_selector(".wfx-dialog [data-f='log'], .wfx-dialog [data-f='app-key']", timeout=5000)
        except Exception:
            if pg.evaluate("() => !window.__old"): return  # 바뀐 것만 받아 벌써 새로고침됐어요 (창을 보기도 전에)
            raise
    def finish(pg):
        """결과 글 (창을 닫아요)"""
        pg.wait_for_selector(".wfx-dialog [data-f='result'], .wfx-dialog [data-f='error']", timeout=15000)
        t = pg.inner_text(".wfx-dialog [data-f='result'], .wfx-dialog [data-f='error']")
        pg.click(".wfx-dialog [data-f='close']"); pg.wait_for_timeout(200)
        return t
    def after_reload(pg):
        """받은 판으로 바꾸면 새로고침 → 알림 글"""
        pg.wait_for_function("() => !window.__old", timeout=15000); pg.wait_for_selector("#tree .text", timeout=10000)
        pg.wait_for_function("() => !document.querySelector('#toast').hidden && document.querySelector('#toast').textContent.length > 0", timeout=8000)
        return pg.inner_text("#toast")

    # 1) A: 첫 백업 (첨부까지)
    png = bytes.fromhex("89504e470d0a1a0a0000000d4948445200000001000000010806000000" "1f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082")
    up = requests.post(A + "/api/upload", files={"file": ("점.png", png)}).json()
    add(A, up["markdown"]); nid_a = add(A, "A 처음")
    pa.evaluate(LOGIN); pa.reload(); pa.wait_for_selector("#tree .text")
    run(pa); t = finish(pa)
    check("A: Dropbox에 첫 백업 — head.json + 전체 사본(gzip)", "첫 백업" in t and head()["seq"] == 0 and store[head()["snapshot"]["path"]][0][:2] == b"\x1f\x8b" and not head()["changes"], (t, list(store)))
    fname = up["url"].rsplit("/", 1)[1]
    check("A: 첨부도 올려요 (files/이름 그대로)", store.get(f"/files/{fname}", (None,))[0] == png, list(store))
    k = len(fake["uploads"]); run(pa); t = finish(pa)
    check("A: 다시 실행 — 바뀐 게 없으면 그대로 (올리지 않아요)", "이미 같아요" in t and len(fake["uploads"]) == k, (t, fake["uploads"][k:]))

    # 2) B: 처음 — 연결 화면(앱 키 → 허용 → 코드) → 어느 쪽을 쓸지 → Dropbox 것으로 바꾸기
    add(B, "B 원래")
    run(pb)
    check("B: 로그인 정보가 없으면 연결 화면", pb.locator(".wfx-dialog [data-f='app-key']").count() == 1)
    pb.fill(".wfx-dialog [data-f='app-key'] input, .wfx-dialog input[data-f='app-key']", "key")
    with pb.expect_popup() as pop:
        pb.click(".wfx-dialog [data-f='authorize']")
    check("허용하기: Dropbox 허용 화면을 새 창으로 (PKCE · offline)", "client_id=key" in pop.value.url and "code_challenge_method=S256" in pop.value.url and "token_access_type=offline" in pop.value.url, pop.value.url)
    pop.value.close()
    pb.fill(".wfx-dialog [data-f='code'] input, .wfx-dialog input[data-f='code']", "CODE123")
    pb.click(".wfx-dialog [data-f='connect']")
    pb.wait_for_selector(".wfx-dialog [data-f='choose']", timeout=8000)
    check("B: 로그인 정보는 이 브라우저에만", json.loads(pb.evaluate("localStorage.getItem('outliner.dropbox')")).get("refresh") == "ref")
    check("B: 처음 맞추는 기기면 어느 쪽을 쓸지 물어요", pb.locator(".wfx-dialog [data-f='choose-pull']").count() == 1)
    pb.click(".wfx-dialog [data-f='choose-pull']")
    t = after_reload(pb)
    check("B: Dropbox 것으로 바꾸고 새로고침 뒤 알림", "Dropbox의 판으로 바꿨어요" in t, t)
    rb = rows(B)
    check("B: A의 항목이 와요 (B 원래는 백업으로)", "A 처음" in rb and "B 원래" not in rb and list(data_dir(B).glob("*-before-remote-*.db")), rb)
    check("B: 첨부도 받아요", any(f["name"] == fname for f in requests.get(B + "/api/attachments").json()["files"]))
    run(pb); t = finish(pb)
    check("B: 받은 뒤 다시 실행 — 그대로", "이미 같아요" in t, t)

    # 3) 한쪽만 바뀜: A 고침 → 올리기, B → 받기
    edit(A, nid_a, "A 고침")
    k = len(fake["uploads"]); run(pa); t = finish(pa)
    ups = uploads_since(k)
    check("A: 이 기기에서 바뀐 것만 올려요 (변경 파일 하나 · 작게)", "올렸어요" in t and len(ups) == 1 and ups[0].startswith("/changes/") and len(store[ups[0]][0]) < 1000 and head()["seq"] == 1,
          (t, ups, [len(store[u][0]) for u in ups if u in store]))
    k = len(fake["downloads"]); run(pb); t = after_reload(pb)
    downs = [d for d in fake["downloads"][k:] if not d.startswith("rev:") and d != "/head.json"]
    check("B: 다른 기기에서 바뀐 것만 받아요 (전체 사본은 받지 않아요)", "받았어요" in t and "A 고침" in rows(B) and downs == [ups[0]], (t, downs, rows(B)))

    # 4) 양쪽 다 바뀜: 새 항목 + 같은 항목을 다르게 고침
    add(A, "A 새 항목"); edit(A, nid_a, "충돌 A")
    add(B, "B 새 항목"); edit(B, node_id(B, "A 고침"), "충돌 B")
    run(pa); t = finish(pa)
    check("A: 먼저 올려요", "올렸어요" in t, t)
    run(pb); t = after_reload(pb)
    rb = rows(B)
    check("B: 양쪽 다 바뀌면 합쳐요", "합쳤어요" in t and "충돌" in t, t)
    check("B: 합친 판 — 양쪽 새 항목 · Dropbox 글은 그대로 · 이 기기 글은 충돌 항목으로",
          {"A 새 항목", "B 새 항목", "충돌 A", "⚠ 충돌 · 이 기기에서 고친 글: 충돌 B"} <= set(rb) and "충돌 B" not in rb, rb)
    run(pb); t = finish(pb)
    check("B: 합친 뒤 다시 실행 — 그대로 (합친 판을 이미 올렸어요)", "이미 같아요" in t, t)
    run(pa); t = after_reload(pa)
    ra = rows(A)
    check("A: 합친 판을 받아요 — 중복 없이", "받았어요" in t and ra.count("B 새 항목") == 1 and ra.count("A 새 항목") == 1 and sorted(ra) == sorted(rows(B)), (t, sorted(ra), sorted(rows(B))))

    # 5) 다음 합치기도 번호가 맞아요 (합친 뒤 양쪽이 또 고침)
    add(A, "A 둘째"); add(B, "B 둘째"); edit(B, node_id(B, "B 새 항목"), "B 새 항목 고침")
    run(pa); finish(pa)
    run(pb); after_reload(pb)
    run(pa); after_reload(pa)
    ra, rb = rows(A), rows(B)
    check("두 번째 합치기도 중복 없이 같아져요", sorted(ra) == sorted(rb) and ra.count("A 둘째") == 1 and "B 새 항목 고침" in ra and "B 새 항목" not in ra, (sorted(ra), sorted(rb)))

    # 6) 동시에 올림: A가 '이 판 그대로일 때만' 올리는 순간 B의 판이 먼저 들어가 있으면 rev로 막히고 → 다시 받아 합쳐요
    known = store["/head.json"]                          # A · B가 같이 아는 판
    add(B, "B 셋째"); run(pb); finish(pb)
    other = store["/head.json"][0]; store["/head.json"] = known  # B의 판은 A가 head.json을 바꾸는 바로 그때 들어가게
    fake["race"] = other
    add(A, "A 넷째"); run(pa); t = after_reload(pa)
    ra = rows(A)
    check("동시에 올리면 막히고 다시 받아 합쳐요 (잃는 것 없이)", "합쳤어요" in t and "A 넷째" in ra and ra.count("B 셋째") == 1, (t, ra))
    check("막힌 쪽이 올렸던 변경 파일은 지워요", not stray(), stray())
    run(pb); after_reload(pb)
    check("그 뒤 B도 같아져요", sorted(rows(B)) == sorted(rows(A)), (sorted(rows(A)), sorted(rows(B))))

    # 7) 쌓이면 정리: 큰 변경(플러그인 데이터 ~6MB) → 올린 뒤 새 전체 사본으로 갈음, 예전 파일은 지워요
    before = referenced()
    big = base64.b64encode(os.urandom(4_500_000)).decode()
    requests.put(A + "/api/plugin-data/testbig/blob", json={"value": big}); run(pa); t = finish(pa)
    h = head()
    check("정리: 쌓인 변경을 새 전체 사본으로 (변경 목록 비움 · 예전 파일 지움)", "올렸어요" in t and not h["changes"] and h["snapshot"]["seq"] == h["seq"] and not (before & set(store)) and not stray(),
          (t, h, sorted(store)))
    add(B, "B 정리 뒤")  # B는 정리 전 판에서 고침 → 전체 사본을 받아 합쳐요
    run(pb); t = after_reload(pb)
    rb = rows(B)
    check("정리 뒤: 예전 판의 기기도 전체 사본으로 합쳐요", "합쳤어요" in t and "B 정리 뒤" in rb and requests.get(B + "/api/plugin-data/testbig/blob").json()["value"] == big, t)
    run(pa); after_reload(pa)
    check("정리 뒤에도 두 기기가 같아요", sorted(rows(A)) == sorted(rows(B)))

    # 8) 덮어쓰기(reset): B가 맞춘 판을 잃고(처음 기기처럼) '이 기기 것으로 덮어쓰기' → A는 다음에 어느 쪽을 쓸지 물어요
    (data_dir(B) / "app-remote" / "dropbox" / "state.json").unlink()
    add(B, "B 덮어쓰기")
    run(pb); pb.wait_for_selector(".wfx-dialog [data-f='choose']", timeout=8000); pb.click(".wfx-dialog [data-f='choose-push']"); t = finish(pb)
    h = head()
    check("덮어쓰기: 새 전체 사본 + reset", "덮어썼어요" in t and h["reset"] == h["seq"] == h["snapshot"]["seq"] and not h["changes"] and not stray(), (t, h))
    run(pa); pa.wait_for_selector(".wfx-dialog [data-f='choose']", timeout=8000)
    check("덮어쓴 뒤 다른 기기는 어느 쪽을 쓸지 물어요", pa.locator(".wfx-dialog [data-f='choose-pull']").count() == 1)
    pa.click(".wfx-dialog [data-f='choose-pull']"); after_reload(pa)
    check("Dropbox 것으로 바꾸면 B와 같아요", sorted(rows(A)) == sorted(rows(B)) and "B 덮어쓰기" in rows(A))

    # 9) 로그인이 풀리면 연결 화면으로 (앱 키는 남겨요)
    fake["bad_refresh"] = True
    pa.evaluate("() => { const c = JSON.parse(localStorage.getItem('outliner.dropbox')); c.access = null; c.expires = 0; localStorage.setItem('outliner.dropbox', JSON.stringify(c)); }")
    add(A, "A 다섯째"); run(pa)
    pa.wait_for_selector(".wfx-dialog [data-f='app-key']", timeout=8000)
    check("로그인이 풀리면 연결 화면 + 이유", "다시 연결" in pa.inner_text(".wfx-dialog [data-f='error']") and pa.input_value(".wfx-dialog input[data-f='app-key'], .wfx-dialog [data-f='app-key'] input") == "key",
          pa.inner_text(".wfx-dialog"))

# 서버: 저장소 이름 · 사본 이름표 검사
check("저장소 이름이 잘못되면 400", requests.get(A + "/api/remote/..%2Fx").status_code in (400, 404))
check("없는 사본으로 확정하면 404", requests.post(A + "/api/remote/dropbox/commit", json={"token": "0" * 32, "id": "x"}).status_code == 404)
check("변경분이 아닌 파일로 다시 만들면 400", requests.post(A + "/api/remote/dropbox/build", files={"changes": ("x.gz", b"not gzip")}).status_code == 400)
check("첨부 이름 그대로 넣기: 잘못된 이름은 400", requests.put(A + "/api/attachments/raw/notahash.png", data=b"x").status_code == 400)
print("\n" + ("모두 통과" if not fails else f"실패 {len(fails)}개: {fails}"))
sys.exit(1 if fails else 0)
