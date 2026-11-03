#!/bin/bash
# outliner/ 폴더(기본: main 브랜치)를 공개 저장소 github.com/kimjungbeen/outliner의 main에 올려요 — install.sh가 거기서 받아요
# 사용: bash outliner/packaging/publish_github.sh [브랜치]
# 저장소 기록 위에 '그 판의 outliner 폴더' 커밋을 하나 얹어요 (강제 푸시 없음 · 바뀐 게 없으면 그대로)
set -euo pipefail
cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
REPO=https://github.com/kimjungbeen/outliner.git
REF="${1:-main}"
tree="$(git rev-parse "$REF:outliner")"
git fetch -q "$REPO" main
parent="$(git rev-parse FETCH_HEAD)"
if [ "$(git rev-parse "$parent^{tree}")" = "$tree" ]; then echo "이미 같아요"; exit 0; fi
msg="$(git log -1 --no-merges --format=%s "$REF" -- outliner | cut -c1-300)"
c="$(printf '%s\n\n(claude-projects %s)\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n' "$msg" "$(git rev-parse --short "$REF")" | git commit-tree "$tree" -p "$parent")"
git push -q "$REPO" "$c:refs/heads/main"
echo "✅ $REPO ← $(git rev-parse --short "$c")"
