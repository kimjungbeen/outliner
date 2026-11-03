"""붙여넣기 계층 유지 테스트. 사용: python3 tests/paste_test.py <앱 포트>"""
import json
import sys
import requests
from playwright.sync_api import sync_playwright

B = f"http://127.0.0.1:{sys.argv[1]}"
fails = []


def check(name, cond, extra=""):
    print(("PASS " if cond else "FAIL ") + name, "" if cond else extra)
    if not cond:
        fails.append(name)


CASES = [
    ("탭 들여쓰기", "회의\n\t안건 1\n\t\t세부\n\t안건 2", "", ["회의", "\t안건 1", "\t\t세부", "\t안건 2"]),
    ("공백 · 글머리표", "목표\n  - 하나\n    * 둘\n  - 셋", "", ["목표", "\t하나", "\t\t둘", "\t셋"]),
    ("전각 공백 · ○■ 기호 (한글 문서)", "1장\n　○ 1절\n　　■ 요점", "", ["1장", "\t1절", "\t\t요점"]),
    ("번호는 글에 남김", "1. 첫째\n   1) 하위\n2. 둘째", "", ["1. 첫째", "\t1) 하위", "2. 둘째"]),
    ("구글 문서식 HTML (글엔 들여쓰기 없음)", "A\nB\nC",
     '<meta charset="utf-8"><ul><li aria-level="1"><p>A</p></li><ul><li aria-level="2"><p>B</p></li></ul><li aria-level="1"><p>C</p></li></ul>', ["A", "\tB", "C"]),
    ("워드식 HTML (mso-list)", "·\t상위\no\t하위",
     "<p class=MsoListParagraph style='mso-list:l0 level1 lfo1'><span>·<span>  </span></span>상위</p><p class=MsoListParagraph style='mso-list:l0 level2 lfo1'><span>o<span>  </span></span>하위</p>", ["상위", "\t하위"]),
    ("웹 목록 + 링크", "도구\n문서",
     '<ul><li>도구<ul><li><a href="https://ex.com/doc">문서</a></li></ul></li></ul>', ["도구", "\t[문서](https://ex.com/doc)"]),
]

with sync_playwright() as p:
    br = p.chromium.launch()
    page = br.new_page(viewport={"width": 1000, "height": 800})
    errors = []; page.on("pageerror", lambda e: errors.append(str(e)))
    for name, plain, html, want in CASES:
        for r in requests.get(B + "/api/children").json().get("nodes", []):
            requests.delete(B + f"/api/nodes/{r['id']}")
        nid = requests.post(B + "/api/nodes", json={"parent_id": None, "position": 0, "content": ""}).json()["id"]
        page.goto(B); page.wait_for_selector(f'#tree .text[data-id="{nid}"]')
        page.click(f'#tree .text[data-id="{nid}"]')
        page.evaluate("""([p, h]) => { const dt = new DataTransfer(); dt.setData('text/plain', p); if (h) dt.setData('text/html', h);
            document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); }""", [plain, html])
        page.wait_for_timeout(700)
        got = requests.get(B + "/api/export?format=txt").text.splitlines()
        check(name, got == want, json.dumps(got, ensure_ascii=False))
    check("페이지 오류 없음", not errors, str(errors))
    br.close()

print("\n" + ("모두 통과" if not fails else f"실패 {len(fails)}개: {fails}"))
sys.exit(1 if fails else 0)
