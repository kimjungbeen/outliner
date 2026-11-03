#!/bin/bash
# Outliner 실행 파일 — Finder에서 더블클릭하면 전용 창으로 열려요.
# 처음 실행할 때는 .venv(이 폴더 안 전용 파이썬 환경)를 만들고 필요한 패키지를 내려받아요.
# requirements.txt가 바뀌면 다음 실행 때 알아서 다시 설치해요.
# 다시 설치하고 싶으면 .venv 폴더를 지우고 실행하면 돼요.
# 처음 실행하면 응용 프로그램 폴더에 Outliner.app 을 이 맥에서 만들어요 (/Applications — 쓸 수 없으면 ~/Applications) — 다음부터 그걸로 열면 '확인되지 않은 개발자'로 막히지 않아요
# (이 파일은 다른 곳에서 받아 와서 격리 표시가 붙지만, 이 맥에서 만든 앱에는 붙지 않아요. 앱은 이 파일을 bash로 실행해요)

cd "$(dirname "$0")" || exit 1
APP_DIR="$(pwd)"
VENV="$APP_DIR/.venv"
STAMP="$VENV/.installed"
QUIET=""; [ -t 1 ] || QUIET=1  # Outliner.app에서 열면 터미널 창이 없어요 → 알림 · 경고 창으로
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"  # 앱에서 열면 PATH가 짧아요 (Homebrew · python.org 파이썬)

# 다른 곳에서 받아 온 폴더면 맥이 파일마다 격리 표시(com.apple.quarantine)를 붙여 둬요 — 폴더 전체에서 떼요
xattr -dr com.apple.quarantine "$APP_DIR" 2>/dev/null

note() { [ -n "$QUIET" ] && osascript -e "display notification \"$1\" with title \"Outliner\"" >/dev/null 2>&1; echo "$1"; }
fail() {
  echo ""
  echo "⚠️  $1"
  echo ""
  if [ -n "$QUIET" ]; then
    osascript -e "display alert \"Outliner를 열지 못했어요\" message \"$1 (자세한 내용: ~/Library/Logs/Outliner.log)\" as critical" >/dev/null 2>&1
  else
    read -n 1 -s -r -p "아무 키나 누르면 창을 닫아요..."
  fi
  exit 1
}

# 응용 프로그램 폴더의 Outliner.app — 이 폴더의 Outliner.command를 bash로 실행하는 작은 앱. 폴더를 옮기면 다시 만들어요
make_app() {
  command -v osacompile >/dev/null 2>&1 || return 0
  local dir="/Applications"  # Finder의 '응용 프로그램' · Launchpad에 보이는 곳 (관리자 계정이면 암호 없이 쓸 수 있어요)
  [ -w "$dir" ] || dir="$HOME/Applications"
  [ -f "$dir/Outliner.app/Contents/Resources/run.sh" ] && dir="$HOME/Applications"  # Outliner.dmg로 설치한 앱(파이썬이 든 것)은 그대로 두고
  local app="$dir/Outliner.app" old="$HOME/Applications/Outliner.app"
  # 예전엔 ~/Applications에 만들었어요 — 이 폴더 것이면 지우고 /Applications에 새로
  [ "$dir" != "$HOME/Applications" ] && [ "$(cat "$old/Contents/Resources/outliner-folder" 2>/dev/null)" = "$APP_DIR|3" ] && rm -rf "$old"
  local mark="$app/Contents/Resources/outliner-folder" want="$APP_DIR|3"  # |3: 앱 모양 판 — 바꾸면(아이콘 …) 이미 만든 앱도 다시 만들어요
  [ "$(cat "$mark" 2>/dev/null)" = "$want" ] && return 0
  local tmp; tmp="$(mktemp -d)" || return 0
  local q="${APP_DIR//\\/\\\\}"; q="${q//\"/\\\"}"  # AppleScript 글자 안의 \ · "
  cat > "$tmp/run.applescript" <<EOF
set f to "$q/Outliner.command"
set l to (POSIX path of (path to library folder from user domain)) & "Logs/Outliner.log"
do shell script "/bin/bash " & quoted form of f & " > " & quoted form of l & " 2>&1 &"
EOF
  if osacompile -o "$tmp/Outliner.app" "$tmp/run.applescript" >/dev/null 2>&1; then
    local res="$tmp/Outliner.app/Contents/Resources"
    printf '%s' "$want" > "$res/outliner-folder"
    if [ -f "$APP_DIR/src/mac/Outliner.icns" ]; then  # 앱 아이콘 (src/mac/icon.svg)
      cp "$APP_DIR/src/mac/Outliner.icns" "$res/applet.icns"
      # 새 macOS의 osacompile은 Assets.car(기본 스크립트 아이콘) + CFBundleIconName도 넣는데, 그게 applet.icns보다 먼저 쓰여요
      rm -f "$res/Assets.car"
      /usr/libexec/PlistBuddy -c "Delete :CFBundleIconName" "$tmp/Outliner.app/Contents/Info.plist" >/dev/null 2>&1
    fi
    codesign --force --sign - "$tmp/Outliner.app" >/dev/null 2>&1  # 안을 바꿨으니 이 맥에서 다시 서명
    mkdir -p "$dir" && rm -rf "$app" && mv "$tmp/Outliner.app" "$app" \
      && touch "$app" && echo "▶ 다음부터는 응용 프로그램 폴더($dir)의 Outliner로 열면 막히지 않아요 (Launchpad · Spotlight에서 Outliner)"
  fi
  rm -rf "$tmp"
}

# 파이썬 3.9 이상 찾기 (준비할 때만 — 준비된 .venv가 있으면 필요 없어요)
find_py() {
  PY=""
  for c in python3.13 python3.12 python3.11 python3.10 python3 /usr/local/bin/python3 /opt/homebrew/bin/python3 /usr/bin/python3; do
    p="$(command -v "$c" 2>/dev/null)" || continue
    # 실제로 돌려 봐요: /usr/bin/python3는 개발자 도구가 없으면 설치 창만 띄우는 껍데기이고,
    # 어떤 설치본(예: 맥 업데이트 뒤 Homebrew)은 pyexpat이 깨져서 pip가 못 돌아요
    if "$p" -c 'import sys, pyexpat, ensurepip, venv, platform; sys.exit(0 if sys.version_info >= (3, 9) and (sys.platform != "darwin" or platform.mac_ver()[0]) else 1)' >/dev/null 2>&1; then
      PY="$p"; break
    fi
  done
  if [ -z "$PY" ]; then
    echo "파이썬 3을 찾지 못했어요."
    echo "  · https://www.python.org/downloads/ 에서 설치하거나"
    echo "  · 터미널에서 xcode-select --install 을 실행한 뒤 다시 열어 주세요."
    open "https://www.python.org/downloads/macos/" 2>/dev/null
    fail "파이썬을 설치한 뒤 이 파일을 다시 실행해 주세요."
  fi
}

# 1) 처음이면(또는 requirements.txt가 바뀌었으면) 전용 환경 만들고 패키지 내려받기
# 지난번 준비가 중간에 실패해 pip 없는 .venv가 남아 있으면 지우고 새로 만들어요
if [ -d "$VENV" ] && ! "$VENV/bin/python" -m pip --version >/dev/null 2>&1; then
  rm -rf "$VENV"
fi
REQ_HASH="$(shasum requirements.txt 2>/dev/null | cut -d' ' -f1)"
if [ ! -x "$VENV/bin/python" ] || [ "$(cat "$STAMP" 2>/dev/null)" != "$REQ_HASH" ]; then
  find_py
  note "▶ 처음 실행 준비 중이에요 (한 번만, 1~2분 걸려요)"
  echo "  파이썬: $PY ($("$PY" --version 2>&1))"
  if [ ! -x "$VENV/bin/python" ]; then
    "$PY" -m venv "$VENV" || { rm -rf "$VENV"; fail "전용 파이썬 환경(.venv)을 만들지 못했어요."; }
  fi
  echo "▶ pip 업데이트"
  "$VENV/bin/python" -m pip install --upgrade pip --disable-pip-version-check -q \
    || fail "pip를 준비하지 못했어요. 인터넷 연결을 확인해 주세요."
  echo "▶ 필요한 패키지 내려받기 (requirements.txt)"
  "$VENV/bin/python" -m pip install -r requirements.txt --disable-pip-version-check -q \
    || fail "패키지를 내려받지 못했어요. 인터넷 연결을 확인해 주세요."
  echo "$REQ_HASH" > "$STAMP"
  echo "✅ 준비 끝"
  echo ""
fi

make_app
[ -n "${OUTLINER_SETUP_ONLY:-}" ] && exit 0  # install.sh: 준비 · 앱 만들기까지만 (여는 건 만든 앱으로)

# 2) 실행 (창을 모두 닫으면 서버도 꺼지고 이 터미널 창도 끝나요)
echo "▶ Outliner를 여는 중… 이 터미널 창은 앱이 켜져 있는 동안 열어 두세요."
"$VENV/bin/python" src/launcher.py "$@"
CODE=$?
# 143(SIGTERM)·130(Ctrl+C)은 창을 닫거나 ⌘Q로 끝낸 거라 오류가 아니에요
case $CODE in
  0|130|143) echo "Outliner를 닫았어요." ;;
  *) fail "앱이 오류로 끝났어요 (코드 $CODE). 위 메시지를 확인해 주세요." ;;
esac
exit 0
