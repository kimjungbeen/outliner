#!/bin/bash
# 다른 맥에 Outliner 설치 · 업데이트 — 터미널에 한 줄:
#   curl -fsSL https://raw.githubusercontent.com/kimjungbeen/outliner/main/install.sh | bash
# curl로 받은 파일에는 맥의 격리 표시가 붙지 않아서 '확인되지 않은 개발자'로 막히지 않아요.
#  - 코드는 ~/Outliner에 (OUTLINER_DIR로 바꿀 수 있어요). 다시 실행하면 코드만 새로 바꾸고 data/ · .venv는 그대로
#  - 처음이면 .venv 준비 · 응용 프로그램 폴더에 Outliner.app을 만들고 열어요 (다음부터는 그 앱으로)
set -euo pipefail
DIR="${OUTLINER_DIR:-$HOME/Outliner}"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
echo "▶ 내려받는 중…"
curl -fsSL https://github.com/kimjungbeen/outliner/archive/refs/heads/main.tar.gz | tar -xz -C "$TMP"
mkdir -p "$DIR"
rsync -a --delete --exclude /data/ --exclude /.venv/ "$TMP"/outliner-main/ "$DIR"/
echo "▶ $DIR 에 받았어요"
OUTLINER_SETUP_ONLY=1 bash "$DIR/Outliner.command" < /dev/null
for app in /Applications/Outliner.app "$HOME/Applications/Outliner.app"; do
  if [ "$(cut -d'|' -f1 "$app/Contents/Resources/outliner-folder" 2>/dev/null)" = "$DIR" ]; then
    open "$app" && echo "✅ 열었어요 — 다음부터는 Launchpad · Spotlight에서 Outliner" && exit 0
  fi
done
exec bash "$DIR/Outliner.command" < /dev/null
