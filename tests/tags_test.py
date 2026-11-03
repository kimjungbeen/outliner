"""태그 검색은 그대로만: #태 로 #태그 를 찾지 않아요. 사용: python3 tests/tags_test.py <앱 포트>"""
import sys
import requests

B = f"http://127.0.0.1:{sys.argv[1]}"
for r in requests.get(B + "/api/children").json().get("nodes", []):
    requests.delete(B + f"/api/nodes/{r['id']}")
add = lambda c: requests.post(B + "/api/nodes", json={"parent_id": None, "position": None, "content": c}).json()["id"]
a = add("회의 #태"); b = add("회의 #태그"); c = add("둘 다 #태그 #태"); d = add("문장 끝 #태."); e = add("@철수 만남"); f = add("@철수님")
g = add("#태그-하위"); h = add("#프로젝트 기획 정리")
q = lambda s: sorted(r["id"] for r in requests.get(B + "/api/search", params={"q": s}).json()["results"])
fails = []


def ck(n, got, want):
    ok = got == sorted(want)
    print(("PASS " if ok else "FAIL ") + n, "" if ok else f"{got} vs {sorted(want)}")
    if not ok:
        fails.append(n)


ck("#태 → #태그는 안 나옴", q("#태"), [a, c, d])
ck("#태그 → #태그-하위는 안 나옴", q("#태그"), [b, c])
ck("@철수 → @철수님은 안 나옴", q("@철수"), [e])
ck("-#태 는 그 태그만 뺌", q("회의 -#태"), [b])
ck("#프로젝트 (긴 태그, 색인 사용)", q("#프로젝트"), [h])
ck("태그가 아닌 낱말은 그대로 부분 검색", q("태그"), [b, c, g])
ck("태그 + 낱말 함께", q("#프로젝트 기획"), [h])
print("\n" + ("모두 통과" if not fails else f"실패 {len(fails)}개: {fails}"))
sys.exit(1 if fails else 0)
