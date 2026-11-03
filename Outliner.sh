#!/data/data/com.termux/files/usr/bin/bash
# Outliner 실행 파일 (안드로이드 Termux) — 압축을 푼 폴더에서 처음 한 번 `bash Outliner.sh`
#  - 필요한 것(python · flask)이 없으면 설치하고, Termux:Widget 바로가기 두 개를 만들어요
#      ~/.shortcuts/tasks/Outliner       켜기 — 화면 깨우기 잠금(wake lock) · 서버 켜기(이미 켜져 있으면 그대로) · 크롬으로 열기
#      ~/.shortcuts/tasks/Outliner 끄기  서버 끄기 · wake lock 풀기
#    tasks/ 안의 바로가기는 터미널 창 없이 뒤에서 실행돼요. 폴더를 옮기면 옮긴 자리에서 `bash Outliner.sh`를 한 번 더
#  - 그다음 바로 켜고 열어요
# 바로가기가 부르는 것: `bash Outliner.sh start` · `bash Outliner.sh stop`
# 서버 기록: data/termux.log

cd "$(dirname "$0")" || exit 1
APP_DIR="$(pwd)"
PORT="${OUTLINER_PORT:-4300}"
URL="http://127.0.0.1:$PORT"
LOG="$APP_DIR/data/termux.log"
SERVER="$APP_DIR/src/server.py"
STAMP="$APP_DIR/data/termux.stamp"

say() { echo "$1"; command -v termux-toast >/dev/null 2>&1 && termux-toast -s "$1" 2>/dev/null; }  # 토스트는 Termux:API가 있을 때만

# Outliner 서버가 이 주소에서 답하는지 — Outliner에만 있는 /api/plugins로 (다른 프로그램이 포트를 잡고 있으면 아니에요 · curl이 없어도 되게 파이썬으로)
up() { python -c "import urllib.request as u; u.build_opener(u.ProxyHandler({})).open('$URL/api/plugins', timeout=1)" >/dev/null 2>&1; }  # 프록시를 거치지 않고

# 서버 코드의 지문 — 새 zip을 풀면 바뀌어요 (켜 둔 서버는 켤 때 코드 그대로라, 바뀌었으면 다시 켜야 해요)
stamp() { cat "$APP_DIR"/src/*.py | cksum; }

setup() {
  command -v python >/dev/null 2>&1 || pkg install -y python || return 1
  python -c "import flask" 2>/dev/null || pip install -r "$APP_DIR/requirements.txt" || return 1
}

shortcuts() {
  local dir="$HOME/.shortcuts/tasks" q
  printf -v q '%q' "$APP_DIR/Outliner.sh"  # 폴더 이름에 띄어쓰기 · ' 가 있어도
  mkdir -p "$dir" && chmod 700 "$HOME/.shortcuts" "$dir"
  printf '#!/data/data/com.termux/files/usr/bin/bash\nexec bash %s start\n' "$q" > "$dir/Outliner"
  printf '#!/data/data/com.termux/files/usr/bin/bash\nexec bash %s stop\n' "$q" > "$dir/Outliner 끄기"
  chmod 700 "$dir/Outliner" "$dir/Outliner 끄기"
  echo "▶ Termux:Widget 바로가기를 만들었어요 — 홈 화면에 Termux:Widget 위젯을 놓으면 'Outliner' · 'Outliner 끄기'가 보여요"
}

start() {
  termux-wake-lock 2>/dev/null  # 화면이 꺼져도 Termux가 잠들지 않게
  # 이 폴더의 서버가 지금 코드로 켜져 있고 답하면 그대로. 아니면(꺼졌거나, 새 zip을 풀었거나, 예전 폴더 · 손으로 켠 서버가 주소를 잡고 있으면) 끄고 이 폴더 것으로 켜요
  if ! { pgrep -f "$SERVER" >/dev/null 2>&1 && [ "$(cat "$STAMP" 2>/dev/null)" = "$(stamp)" ] && up; }; then
    pkill -f "src/server.py" 2>/dev/null && sleep 1
    mkdir -p "$APP_DIR/data"
    OUTLINER_PORT="$PORT" nohup python "$SERVER" >> "$LOG" 2>&1 < /dev/null &
    local pid=$!
    for _ in $(seq 1 40); do up && break; kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
    # 켠 서버가 살아서 답해야 해요 (포트를 다른 프로그램이 잡고 있으면 켠 서버는 바로 끝나요)
    { kill -0 "$pid" 2>/dev/null && up; } || { say "Outliner 서버를 켜지 못했어요 (기록: data/termux.log)"; exit 1; }
    stamp > "$STAMP"
  fi
  termux-open-url "$URL"
}

stop() {
  pkill -f "src/server.py" 2>/dev/null
  termux-wake-unlock 2>/dev/null
  say "Outliner를 껐어요"
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  *)
    echo "▶ 준비 중…"
    setup || { echo "⚠️  python · flask를 설치하지 못했어요 — 인터넷 연결을 확인하고 다시 실행해 주세요"; exit 1; }
    shortcuts
    start
    echo "▶ $URL 에서 열렸어요"
    ;;
esac
