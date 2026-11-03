"""서식 없애기 플러그인(plain, 예전 links · lf — 고른 항목, 없으면 화면 전부): 링크 하위로 접기 · 서식 기호 빼기 · 링크 글자만 / 글자 (주소).
사용: python3 tests/plain_test.py <앱 포트>"""
import sys
import requests
from playwright.sync_api import sync_playwright

BASE = f"http://127.0.0.1:{sys.argv[1]}"
fails = []


def check(name, cond, extra=""):
    print(("PASS " if cond else "FAIL ") + name, "" if cond else extra)
    if not cond:
        fails.append(name)


for r in requests.get(BASE + "/api/children").json().get("nodes", []):
    requests.delete(BASE + f"/api/nodes/{r['id']}")
add = lambda parent, c: requests.post(BASE + "/api/nodes", json={"parent_id": parent, "position": None, "content": c}).json()["id"]
W = "https://ko.wikipedia.org/wiki/%EC%95%84%EC%9B%83"
a = add(None, f"참고 [위키 문서]({W}) 를 보세요")
b = add(None, "주소 https://www.example.com/a/b?x=1 끝")
c = add(None, "[A](https://a.com) 와 [B](https://b.com)")
k = add(None, "자식 있는 [링크](https://k.com)"); add(k, "원래 자식")
u = add(None, "https://only.example.com/x")
outline = lambda: requests.get(BASE + "/api/export?format=txt").text.splitlines()


def apply_in_dialog(links):
    """서식 없애기 창: links 방법을 고르고(None이면 기억한 것 그대로) 바꾸기 → 고른 방법"""
    page.wait_for_selector(".wfx-dialog [data-f=links]")
    if links: page.click(f".wfx-dialog [data-f=links] button[data-v={links}]")
    on = page.get_attribute(".wfx-dialog [data-f=links] button.on", "data-v")
    page.click(".wfx-dialog [data-f=go]"); page.wait_for_timeout(1200)
    return on if (links or on == "fold") else None

with sync_playwright() as p:
    br = p.chromium.launch()
    page = br.new_page(viewport={"width": 1000, "height": 800})
    errors = []; page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(BASE); page.wait_for_selector("#tree .text")
    page.click(f'#tree .text[data-id="{a}"]'); page.click(f'#tree .text[data-id="{a}"]', modifiers=["ControlOrMeta"])  # 그 항목만 고르기
    page.keyboard.press("Control+/")  # ⌘/ 명령 목록
    page.wait_for_selector(".cmdl-find"); page.keyboard.type("plain"); page.wait_for_timeout(150)
    names = page.eval_on_selector_all(".cmdl-row .cmdl-name", "els => els.map(e => e.textContent)")
    check("명령 목록에 plain", names[:1] == ["plain"], str(names[:3]))
    page.keyboard.press("Enter"); apply_in_dialog("fold")
    o = outline()
    check("plain(하위로 접기): 고른 항목만 바뀜 → 글자만 + 주소는 하위", o[0] == "참고 위키 문서 를 보세요" and o[1] == "\t" + W and o[2].startswith("주소 https://"), "\n".join(o[:4]))
    check("그 항목은 접혀서 주소가 안 보임", page.locator(f'#tree .text:text-is("{W}")').count() == 0)
    check("글은 평범한 텍스트 (화면 그대로)", page.inner_text(f'#tree .text[data-id="{a}"]') == "참고 위키 문서 를 보세요")
    # 화면 전부
    page.locator("#tree .text").first.click()
    page.keyboard.press("Control+/")  # ⌘/ 명령 목록
    page.wait_for_selector(".cmdl-find"); page.keyboard.type("plain"); page.wait_for_timeout(150); page.keyboard.press("Enter")
    check("고른 방법(하위로 접기)을 기억", apply_in_dialog(None) is not None)
    o = outline()
    want = ["참고 위키 문서 를 보세요", "\t" + W,
            "주소 example.com 끝", "\thttps://www.example.com/a/b?x=1",
            "A 와 B", "\tA — https://a.com", "\tB — https://b.com",
            "자식 있는 링크", "\t🔗 링크 1개", "\t\thttps://k.com", "\t원래 자식",
            "https://only.example.com/x"]
    check("고른 것 없음: 화면 전부 · 여러 링크는 짝지어 · 자식 있으면 '🔗 링크' 묶음 · 주소만 있는 항목은 그대로", o == want, "\n".join(o))
    check("원래 자식은 계속 보임", page.locator('#tree .text:text-is("원래 자식")').count() == 1)
    page.locator("#tree .text").first.click()
    page.keyboard.press("Control+/")  # ⌘/ 명령 목록
    page.wait_for_selector(".cmdl-find"); page.keyboard.type("plain"); page.wait_for_timeout(150); page.keyboard.press("Enter")
    page.wait_for_selector(".wfx-dialog [data-f=pv]")
    check("두 번째는 바꿀 게 없어요 (바꾸기 단추 꺼짐)", "바꿀 서식이 없어요" in page.inner_text(".wfx-dialog [data-f=pv]") and page.is_disabled(".wfx-dialog [data-f=go]"))
    page.keyboard.press("Escape"); page.wait_for_timeout(200)
    check("두 번 실행해도 변화 없음", outline() == want, "\n".join(outline()))
    # ---- 서식 기호 빼기 · 링크 글자만 / 글자 (주소) ----
    F = add(None, "서식 시험")
    fm = [add(F, t) for t in ["**굵게** 와 *기울임* 과 ~~취소~~", "`코드` 와 ==형광== 과 =={ff8800}주황==", "# 큰 제목", "#태그 는 그대로 [위키](https://w.org) 끝",
                             "![그림](/files/0123456789abcdef01234567.png) 첨부는 그대로", "---", "> 인용 **굵게**", "평범한 글"]]
    page.goto(f"{BASE}/#{F}"); page.wait_for_selector(f'#tree .text[data-id="{fm[0]}"]'); page.wait_for_timeout(300)
    page.keyboard.press("Alt+u"); page.wait_for_selector(".wfx-dialog [data-f=pv]")
    page.click(".wfx-dialog [data-f=links] button[data-v=text]"); page.wait_for_timeout(150)
    check("미리 보기: 바뀌는 항목 수 (평범한 글 · 첨부 · 가로줄은 빼고)", page.inner_text(".wfx-dialog [data-f=note]") == "5개", page.inner_text(".wfx-dialog [data-f=note]"))
    page.click(".wfx-dialog [data-f=go]"); page.wait_for_timeout(1200)
    got = [n["content"] for n in requests.get(f"{BASE}/api/children?parent={F}&limit=20").json()["nodes"]]
    check("⌥U: 서식 기호만 빼고 글자는 그대로 · 링크는 글자만 · 태그 · 첨부 · 가로줄은 그대로", got == ["굵게 와 기울임 과 취소", "코드 와 형광 과 주황", "큰 제목", "#태그 는 그대로 위키 끝",
        "![그림](/files/0123456789abcdef01234567.png) 첨부는 그대로", "---", "인용 굵게", "평범한 글"], "\n".join(got))
    L = add(F, "[문서](https://d.com) 와 **굵게**")
    page.reload(); page.wait_for_selector(f'#tree .text[data-id="{L}"]'); page.wait_for_timeout(300)
    page.keyboard.press("Alt+u"); page.wait_for_selector(".wfx-dialog [data-f=pv]")
    page.click(".wfx-dialog [data-f=links] button[data-v=both]"); page.click(".wfx-dialog [data-f=fmt]")  # 서식은 그대로 두기
    page.wait_for_timeout(150); page.click(".wfx-dialog [data-f=go]"); page.wait_for_timeout(1000)
    got = requests.get(f"{BASE}/api/children?parent={F}&limit=20").json()["nodes"][-1]["content"]
    check("링크 '글자 (주소)' · 서식 빼기를 끄면 서식은 그대로", got == "문서 (https://d.com) 와 **굵게**", got)
    check("페이지 오류 없음", not errors, str(errors))
    br.close()

print("\n" + ("모두 통과" if not fails else f"실패 {len(fails)}개: {fails}"))
sys.exit(1 if fails else 0)
