"""여러 창 · 서버 수명 · 다른 사이트 요청 막기 테스트. 사용: python3 tests/windows_test.py   (스스로 서버를 켜고 꺼요)"""
import os
import subprocess
import sys
import tempfile
import time
import requests
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
fails = []


def check(name, cond, extra=""):
    print(("PASS " if cond else "FAIL ") + name, "" if cond else extra)
    if not cond:
        fails.append(name)


tmp = tempfile.mkdtemp()
env = dict(os.environ, OUTLINER_DB=os.path.join(tmp, "app.db"), OUTLINER_FIRST_WAIT="30")
PORT = 5461
B = f"http://127.0.0.1:{PORT}"
owner = subprocess.Popen([sys.executable, "src/launcher.py", "--no-window", "--port", str(PORT)], cwd=HERE, env=env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
first = ""
for _ in range(10):  # Flask 시작 안내 줄은 건너뛰어요
    first = owner.stdout.readline().strip()
    if first.startswith("http"):
        break
check("1) 서버 켜짐", first == B, first)
info = requests.get(B + "/api/ping").json()
check("ping: 이 앱 + DB 경로", info["app"] == "outliner" and info["db"].endswith("app.db"), str(info))

again = subprocess.run([sys.executable, "src/launcher.py", "--no-window", "--port", str(PORT)], cwd=HERE, env=env, capture_output=True, text=True, timeout=30)
check("2) 한 번 더 실행 → 새 서버 없이 기존 서버 재사용", "이미 켜져 있어요" in again.stdout, again.stdout + again.stderr)

# 다른 사이트에서 온 요청 막기
r = requests.post(B + "/api/nodes", json={"parent_id": None, "content": "x"}, headers={"Origin": "https://evil.example"})
check("3) 다른 Origin의 쓰기 요청 → 403", r.status_code == 403, str(r.status_code))
r = requests.post(B + "/api/import/db", files={"file": ("x.db", b"x")}, data={"mode": "replace"}, headers={"Sec-Fetch-Site": "cross-site"})
check("   다른 사이트 폼(통째로 바꾸기) → 403", r.status_code == 403, str(r.status_code))
r = requests.get(B + "/api/children", headers={"Host": "evil.example:5461"})
check("   다른 이름(Host)으로 접속 → 403", r.status_code == 403, str(r.status_code))
r = requests.post(B + "/api/nodes", json={"parent_id": None, "content": "ok"}, headers={"Origin": B})
check("   같은 주소의 요청은 그대로", r.status_code == 200, str(r.status_code))

with sync_playwright() as p:
    br = p.chromium.launch()
    ctx = br.new_context(viewport={"width": 1000, "height": 700})
    page = ctx.new_page()
    errors = []; page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(B); page.wait_for_selector("#tree .text"); page.wait_for_timeout(500)
    check("4) 창 1개 → clients 1", requests.get(B + "/api/ping").json()["clients"] == 1)
    page.locator("#tree .text").first.click()
    with ctx.expect_page() as pop:
        page.evaluate("window.open(location.origin + '/', '_blank', 'popup')")  # 새 창 (예전 new-window 명령이 하던 것)
    w2 = pop.value; w2.wait_for_selector("#tree .text"); w2.wait_for_timeout(500)
    check("5) '새 창' → 같은 서버의 창이 하나 더 (실시간 연결은 브라우저당 하나)", w2.url.startswith(B) and requests.get(B + "/api/ping").json()["clients"] == 1, w2.url)
    page.locator("#tree .text").first.click(); page.keyboard.press("End"); page.keyboard.type(" 동기화"); page.wait_for_timeout(1500)
    check("   두 창이 실시간 반영", "동기화" in w2.inner_text("#tree"))
    page.close()
    for _ in range(30):  # 닫힌 창의 연결은 서버가 알아채는 데 몇 초 걸려요 (그동안은 잠깐 2)
        time.sleep(0.5)
        if requests.get(B + "/api/ping").json()["clients"] == 1: break
    check("6) 첫 창(연결 담당)을 닫아도 다른 창이 이어받아 서버 유지", owner.poll() is None and requests.get(B + "/api/ping").json()["clients"] == 1)
    w2.locator("#tree .text").first.click(); w2.keyboard.press("End"); w2.keyboard.type("!"); w2.wait_for_timeout(300)
    requests.post(B + "/api/nodes", json={"parent_id": None, "position": 0, "content": "밖에서 추가"}); w2.wait_for_timeout(1500)
    check("   이어받은 뒤에도 실시간 반영", "밖에서 추가" in w2.inner_text("#tree"))
    check("페이지 오류 없음", not errors, str(errors))
    w2.close(); br.close()

try:
    out, _ = owner.communicate(timeout=25)
except subprocess.TimeoutExpired:
    owner.kill(); out = "(안 꺼짐)"
check("7) 마지막 창이 닫히면 서버도 꺼짐", owner.returncode == 0 and "마지막 창" in out, out)

print("\n" + ("모두 통과" if not fails else f"실패 {len(fails)}개: {fails}"))
sys.exit(1 if fails else 0)
