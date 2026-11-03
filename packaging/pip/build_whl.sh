#!/bin/bash
# pip 설치 파일(.whl) 만들기 — 맥 · 윈도우 공용 파일 하나. AirDrop · USB · 메신저 … 아무렇게나 옮겨서:
#   pip install --upgrade outliner-<버전>-py3-none-any.whl   →   outliner   (터미널에 치면 창이 열려요)
# 사용: bash packaging/pip/build_whl.sh [만들 폴더]   (기본: outliner/ — git에는 안 들어가요)
#  - 버전은 만든 시각(2026.11.3.2130) — 늘 올라가서 --upgrade로 새 파일이 들어가요
#  - 코드: 지금 폴더의 src · plugins (커밋하지 않은 수정도 들어가요). 필요한 것(flask)은 pip이 같이 설치해요
#  - 데이터는 코드와 따로 (packaging/pip/__main__.py) — 받는 컴퓨터에 파이썬 3.9 이상만 있으면 돼요
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT="${1:-$(pwd)}"
VER="$(date +%Y.%-m.%-d.%H%M)"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
PKG="$WORK/outliner"

# 꾸러미 모양: outliner/ = src의 코드 · static · mac 아이콘 + plugins + 실행 입구(__main__.py)
cp -R src "$PKG"
cp -R plugins "$PKG/plugins"
cp packaging/pip/__main__.py "$PKG/__main__.py"
: > "$PKG/__init__.py"
find "$PKG" \( -name __pycache__ -o -name .DS_Store \) -prune -exec rm -rf {} +

cat > "$WORK/pyproject.toml" <<EOF
[build-system]
requires = ["setuptools>=69"]
build-backend = "setuptools.build_meta"

[project]
name = "outliner"
version = "$VER"
description = "내 컴퓨터용 outliner (Flask + SQLite)"
requires-python = ">=3.9"
dependencies = [$(grep -v '^\s*#' requirements.txt | sed '/^\s*$/d; s/.*/"&"/' | paste -sd, -)]

[project.scripts]
outliner = "outliner.__main__:main"

[tool.setuptools]
packages = ["outliner"]
include-package-data = false

[tool.setuptools.package-data]
outliner = ["*.py", "static/**/*", "mac/*", "plugins/**/*"]
EOF

python3 -m pip wheel --quiet --disable-pip-version-check --no-deps -w "$WORK/dist" "$WORK"
mkdir -p "$OUT"
rm -f "$OUT"/outliner-*-py3-none-any.whl  # 예전 판은 지워요 (하나만)
cp "$WORK"/dist/*.whl "$OUT/"
W="$(ls "$OUT"/outliner-*-py3-none-any.whl)"
echo "✅ $W ($(du -h "$W" | cut -f1))"
