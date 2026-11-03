"""형광펜 색: 서식 막대는 작게(기본 6색 + 최근 고른 색 2 + '색 더 보기'), 더 보기 칸에 색 18개 더 · 내가 고른 색 전부 · 색 고르기,
고른 색은 모두 기록(최근 것이 앞, highlight 플러그인 칸) · ⌥/Alt+클릭으로 빼기. 사용: python3 tests/hlcolors_test.py <앱 포트>"""
import sys, requests
from playwright.sync_api import sync_playwright

B = f"http://127.0.0.1:{sys.argv[1]}"
fails = []
def check(name, ok, info=""):
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else f" {info}"))
    if not ok: fails.append(name)
put = lambda k, v: requests.put(f"{B}/api/plugin-data/highlight/{k}", json={"value": v})  # 형광펜 플러그인의 저장 칸
saved = lambda: requests.get(f"{B}/api/plugin-data/highlight/colors").json().get("value")
put("colors", ["ff8800"])
root = requests.post(B + "/api/nodes", json={"parent_id": None, "position": 0, "content": "색 기록"}).json()["id"]
nid = requests.post(B + "/api/nodes", json={"parent_id": root, "content": "하나 둘 셋 넷 다섯 여섯"}).json()["id"]
content = lambda: requests.get(f"{B}/api/children?parent={root}&limit=5").json()["nodes"][0]["content"]

with sync_playwright() as p:
    br = p.chromium.launch(); pg = br.new_page(viewport={"width": 1000, "height": 700})
    pg.goto(f"{B}/#{root}"); pg.wait_for_selector(f'#tree .text[data-id="{nid}"]'); pg.wait_for_timeout(500)
    def select(word):
        pg.evaluate("""(w) => { const t = document.querySelector('#tree .text'); t.focus(); const tn = [...t.childNodes].find((n) => n.nodeType === 3 && n.textContent.includes(w));
          const i = tn.textContent.indexOf(w), r = document.createRange(); r.setStart(tn, i); r.setEnd(tn, i + w.length); getSelection().removeAllRanges(); getSelection().addRange(r); }""", word)
        pg.wait_for_selector(".fmt-bar:not([hidden])"); pg.wait_for_timeout(150)
    mine = lambda where=".fmt-bar > [data-f=mine]": pg.eval_on_selector_all(where, "(l) => l.map((s) => s.querySelector('.v-dot').style.background)")
    select("하나")
    check("기록의 색이 막대에 (1개)", mine() == ["rgb(255, 136, 0)"], mine())
    check("처음엔 '색 더 보기' 칸이 닫혀 있어요", pg.locator(".fmt-panel").count() == 0 and pg.locator(".fmt-bar [data-f=more]").count() == 1)
    pg.click(".fmt-bar [data-f=more]"); pg.wait_for_selector(".fmt-panel")
    check("더 보기: 색 18개 · 내가 고른 색 · 색 고르기", pg.locator(".fmt-panel [data-f=grid]").nth(0).locator(".v-swatch").count() == 18 and pg.locator(".fmt-panel [data-f=mine]").count() == 1 and pg.locator(".fmt-panel [data-f=pick]").count() == 1)
    check("더 보기를 눌러도 고른 글자는 그대로", pg.evaluate("getSelection().toString()") == "하나")
    pg.evaluate("(() => { const i = document.querySelector('.fmt-panel [data-f=pick] input'); i.value = '#3366ff'; i.dispatchEvent(new Event('change', { bubbles: true })); })()"); pg.wait_for_timeout(800)
    check("색 고르기로 칠하기", "=={3366ff}하나==" in content(), content())
    check("고른 색은 기록 맨 앞에", saved() == ["3366ff", "ff8800"], saved())
    # 색을 많이 골라도 막대는 그대로 작게 — 기록은 모두 남고 더 보기 칸에
    put("colors", ["3366ff", "ff8800"] + [f"{i:02x}88cc" for i in range(10)])
    pg.reload(); pg.wait_for_selector("#tree .text"); pg.wait_for_timeout(500)
    select("둘")
    w = pg.evaluate("document.querySelector('.fmt-bar').getBoundingClientRect().width")
    check("막대에는 최근 고른 색 2개만 · 한 줄", len(mine()) == 2 and pg.evaluate("document.querySelector('.fmt-bar').offsetHeight") < 50, (mine(), w))
    pg.click(".fmt-bar [data-f=more]"); pg.wait_for_selector(".fmt-panel")
    check("더 보기 칸에 고른 색 12개 모두", pg.locator(".fmt-panel [data-f=mine]").count() == 12)
    pg.wait_for_timeout(400)
    w2 = pg.evaluate("document.querySelector('.fmt-bar').getBoundingClientRect().width")
    check("칸을 열어도 막대 너비는 거의 그대로 (좁게)", abs(w2 - w) < 12 and w2 < 600, (w, w2))
    # 기록의 색을 쓰면 맨 앞으로
    pg.locator(".fmt-panel [data-f=mine]").nth(5).click(); pg.wait_for_timeout(800)
    check("기록의 색을 쓰면 맨 앞으로", saved()[0] == "0388cc" and len(saved()) == 12 and "=={0388cc}둘==" in content(), (saved(), content()))
    # 더 보기의 기본 색은 기록에 넣지 않아요
    select("셋")
    check("다른 글자를 고르면 '색 더 보기'는 다시 접혀요 (작게)", pg.locator(".fmt-panel").count() == 0)
    pg.click(".fmt-bar [data-f=more]"); pg.wait_for_selector(".fmt-panel")
    pg.locator(".fmt-panel [data-f=grid]").nth(0).locator(".v-swatch").nth(9).click(); pg.wait_for_timeout(800)
    check("'색 더'의 색으로 칠하기 · 기록은 그대로", "=={ffd60a}셋==" in content() and len(saved()) == 12, (content(), saved()))
    # ⌥/Alt+클릭으로 기록에서 빼기 (묻고)
    select("넷"); pg.click(".fmt-bar [data-f=more]"); pg.wait_for_selector(".fmt-panel")
    pg.locator(".fmt-panel [data-f=mine]").nth(1).click(modifiers=["Alt"]); pg.wait_for_selector(".wfx-dialog .wfx-btn.danger")
    pg.click(".wfx-dialog .wfx-btn.danger"); pg.wait_for_timeout(800)
    check("⌥/Alt+클릭: 묻고 기록에서 빼기 · 글자는 그대로", len(saved()) == 11 and "3366ff" not in saved() and "=={3366ff}하나==" in content(), saved())
    br.close()

print("\n" + ("모두 통과" if not fails else f"실패 {len(fails)}개: {fails}"))
sys.exit(1 if fails else 0)
