"""앱과 플러그인은 api로만 만나요 — plugins/*.js가 앱 안쪽을 직접 건드리지 않는지 글로 훑어요 (서버 없이). 사용: python3 tests/boundary_test.py"""
import os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PL = os.path.join(ROOT, "plugins")
fails = []
def check(name, ok, info=""):
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else f"  {info}"))
    if not ok: fails.append(name)

RULES = [  # (이름, 정규식) — 플러그인 글에 있으면 안 되는 것
    ("앱 파일 가져오기 (import … from '/…')", r"""from\s+['"]/"""),
    ("앱 파일 불러오기 (import('/…'))", r"""import\(\s*['"`]/"""),
    ("서버 주소 직접 (/api/…)", r"""['"`]/api/"""),
    ("앱 서버를 직접 (fetch('/…') · XMLHttpRequest) — 바깥 서비스(https://…)만 직접 불러도 돼요", r"""\bfetch\s*\(\s*['"`]/|XMLHttpRequest"""),
    ("바깥 주소는 https만", r"""['"`]http://"""),
    ("앱 화면 구조 직접 (#tree · #title · .dlg-ov · .fmt-bar · .row)", r"""['"`][^'"`]*(#tree|#title|#hlbar|\.dlg-ov|\.fmt-bar|\.row\b)"""),
    ("앱 속 값 (window.__outliner)", r"__outliner"),
]
files = sorted(f for f in os.listdir(PL) if f.endswith(".js"))
for f in files:
    src = open(os.path.join(PL, f), encoding="utf-8").read()
    code = re.sub(r"^\s*//.*$", "", src, flags=re.M)  # 설명 줄은 빼고
    bad = [name for name, rx in RULES if re.search(rx, code)]
    check(f"{f}: api로만", not bad, ", ".join(bad))
    imports = re.findall(r"""from\s+['"]([^'"]+)['"]""", code)
    check(f"{f}: 가져오는 건 plugins/의 _ 도구뿐", all(re.fullmatch(r"\./_[a-z]+\.js", m) for m in imports), str(imports))

# 명령 파일 = 명령 하나 (이름이 같아요) — _로 시작하는 건 도구
for f in files:
    if f.startswith("_"): continue
    src = open(os.path.join(PL, f), encoding="utf-8").read()
    name = f[:-3]
    check(f"{f}: 명령 이름 = 파일 이름", re.search(rf"name:\s*'{re.escape(name)}'", src) is not None)

# 앱 쪽: 플러그인에게 주는 건 api.js 하나 (예전 통로가 없어요)
app = open(os.path.join(ROOT, "src", "static", "app.js"), encoding="utf-8").read()
api = open(os.path.join(ROOT, "src", "static", "api.js"), encoding="utf-8").read()
check("app.js에 예전 API 객체(baseApi) 없음", "baseApi" not in app)
check("플러그인은 사용자가 부를 때만 — 끼어드는 길(addRenderer · decorate · on · addCommand) 없음", not re.search(r"\b(addRenderer|decorate|addCommand)\s*[:(]|\bon\s*\(evt", api))
check("'core' 저장 칸은 플러그인이 못 써요", "'core' 칸은 앱 것이에요" in api)
print("\n" + ("모두 통과" if not fails else f"실패 {len(fails)}개: {fails}"))
sys.exit(1 if fails else 0)
