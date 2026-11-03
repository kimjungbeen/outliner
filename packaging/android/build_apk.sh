#!/bin/bash
# 안드로이드 설치 파일(Outliner.apk) 만들기 — 파이썬 서버까지 앱 안에 (Termux 없이 설치만 하면 실행)
# 사용: bash packaging/android/build_apk.sh [만들 apk 경로]   (기본: outliner/Outliner.apk — git에는 안 들어가요)
# 필요한 것: JDK 17 이상 · 안드로이드 SDK(ANDROID_HOME, 기본 ~/Library/Android/sdk — platforms;android-35 · build-tools;35.0.0) · 파이썬 3.12(pip 받기용)
# Gradle은 처음 한 번 ~/Library/Caches/outliner-build에 받아 둬요.
# 서명 키: ~/.android/outliner-release.jks (처음 한 번 만들어요 — 잃어버리면 휴대폰에서 지우고 새로 설치해야 업데이트돼요)
set -euo pipefail
cd "$(dirname "$0")"
OUT="${1:-$(cd ../.. && pwd)/Outliner.apk}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
GV="8.14.3"; CACHE="$HOME/Library/Caches/outliner-build"
GRADLE="$CACHE/gradle-$GV/bin/gradle"
PY312="$(command -v python3.12 || true)"
[ -n "$PY312" ] || { echo "python3.12가 필요해요 (brew install python@3.12)"; exit 1; }

if [ ! -x "$GRADLE" ]; then
  mkdir -p "$CACHE"
  curl -fsSL -o "$CACHE/gradle.zip" "https://services.gradle.org/distributions/gradle-$GV-bin.zip"
  unzip -q -o "$CACHE/gradle.zip" -d "$CACHE" && rm "$CACHE/gradle.zip"
fi

KS="$HOME/.android/outliner-release.jks"
if [ ! -f "$KS" ]; then
  mkdir -p "$HOME/.android"
  keytool -genkeypair -keystore "$KS" -storepass outliner -keypass outliner -alias outliner \
    -keyalg RSA -keysize 2048 -validity 36500 -dname "CN=Outliner" >/dev/null
fi

echo "sdk.dir=$ANDROID_HOME" > local.properties
"$GRADLE" --quiet --console=plain assembleRelease -Poutliner.buildPython="$PY312"
cp app/build/outputs/apk/release/app-release.apk "$OUT"
echo "✅ $OUT ($(du -h "$OUT" | cut -f1))"
