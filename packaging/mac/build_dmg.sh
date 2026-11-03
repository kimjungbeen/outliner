#!/bin/bash
# 맥 설치 파일(Outliner.dmg) 만들기 — 파이썬까지 들어 있는 Outliner.app (다른 맥에서 파이썬 설치 없이 실행)
# 사용: bash packaging/mac/build_dmg.sh [만들 dmg 경로]   (기본: outliner/Outliner.dmg — git에는 안 들어가요)
#  - 파이썬: python-build-standalone(3.12) — Apple Silicon(arm64) · Intel(x86_64) 둘 다 넣고, 켤 때 맞는 쪽을 골라요
#  - 창: pywebview(맥 내장 WebKit) — 크롬이 없어도 돼요. 파일 › 새 창(⌘N)
#  - flask · pywebview는 Resources/site에 (universal2 — 둘이 같이 써요)
#  - 코드: 지금 폴더의 src · plugins (커밋하지 않은 수정도 들어가요)
#  - 데이터: ~/Library/Application Support/Outliner (OUTLINER_DATA로 바꿀 수 있어요) — 앱 안에는 아무것도 쓰지 않아요(서명이 깨지지 않게)
#  - 기록: ~/Library/Logs/Outliner.log
# 내려받은 파이썬은 ~/Library/Caches/outliner-build에 두고 다시 써요.
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT="${1:-$(pwd)/Outliner.dmg}"
PBS="20261026"; PYV="3.12.16"
CACHE="$HOME/Library/Caches/outliner-build"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
APP="$WORK/dmg/Outliner.app"; RES="$APP/Contents/Resources"
mkdir -p "$CACHE" "$APP/Contents/MacOS" "$RES"

# 1) 앱 틀 — 실행 파일이 Resources/run.sh로 맞는 파이썬을 바로 실행해요 (그 파이썬이 곧 앱 → Dock · 메뉴가 Outliner)
cp src/mac/Outliner.icns "$RES/Outliner.icns"
cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>Outliner</string>
  <key>CFBundleIdentifier</key><string>app.outliner</string>
  <key>CFBundleName</key><string>Outliner</string>
  <key>CFBundleDisplayName</key><string>Outliner</string>
  <key>CFBundleIconFile</key><string>Outliner</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$(date +%Y.%m.%d)</string>
  <key>CFBundleVersion</key><string>$(date +%Y%m%d%H%M)</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSMicrophoneUsageDescription</key><string>녹음(record 플러그인)에 마이크를 써요</string>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/><key>NSAllowsArbitraryLoadsInWebContent</key><true/></dict>
</dict></plist>
EOF
printf '#!/bin/bash\nexec /bin/bash "$(dirname "$0")/../Resources/run.sh" "$@"\n' > "$APP/Contents/MacOS/Outliner"
chmod 755 "$APP/Contents/MacOS/Outliner"

# 2) 파이썬 두 개 (필요 없는 것 — 테스트 · tkinter · idle · pip … — 은 빼요)
for arch in aarch64:arm64 x86_64:x86_64; do
  a="${arch%%:*}"; name="${arch##*:}"
  tgz="$CACHE/cpython-$PYV+$PBS-$a-apple-darwin-install_only_stripped.tar.gz"
  [ -s "$tgz" ] || curl -fsSL --retry 3 -o "$tgz" "https://github.com/astral-sh/python-build-standalone/releases/download/$PBS/cpython-$PYV%2B$PBS-$a-apple-darwin-install_only_stripped.tar.gz"
  mkdir -p "$WORK/py-$name" && tar -xzf "$tgz" -C "$WORK/py-$name"
  P="$WORK/py-$name/python"; L="$P/lib/python3.12"
  rm -rf "$L"/{test,idlelib,tkinter,turtledemo,turtle.py,ensurepip,lib2to3,pydoc_data,site-packages/pip*} \
         "$L"/lib-dynload/_tkinter* "$P"/lib/{tcl*,tk*,itcl*,thread*,libtcl*,libtk*} "$P"/share "$P"/include "$P"/bin/{idle*,pydoc*,pip*} 2>/dev/null || true
  mv "$P" "$RES/python-$name"
done

# 3) flask · pywebview(pyobjc) — universal2(arm64 + x86_64) 바퀴로
HOSTPY="$RES/python-$(uname -m)/bin/python3"
python3 -m pip install --quiet --disable-pip-version-check --no-compile --target "$RES/site" \
  --python-version 3.12 --implementation cp --only-binary=:all: \
  --platform macosx_11_0_universal2 --platform macosx_10_13_universal2 --platform macosx_10_9_universal2 --platform any \
  -r requirements.txt
# pywebview는 의존성을 손으로 — proxy_tools가 소스로만 있어서 바퀴만 받으면 아주 옛날 pywebview로 내려가요
python3 -m pip install --quiet --disable-pip-version-check --no-compile --target "$RES/site" --no-deps \
  --python-version 3.12 --implementation cp --only-binary=:all: \
  --platform macosx_11_0_universal2 --platform macosx_10_13_universal2 --platform macosx_10_9_universal2 --platform any \
  "pywebview>=6" bottle typing_extensions pyobjc-core pyobjc-framework-Cocoa pyobjc-framework-Quartz \
  pyobjc-framework-WebKit pyobjc-framework-Security pyobjc-framework-UniformTypeIdentifiers
python3 -m pip install --quiet --disable-pip-version-check --no-compile --target "$RES/site" --no-deps proxy_tools  # 순수 파이썬
rm -rf "$RES/site"/{PyObjCTest,bin}

# 4) 앱 코드
mkdir -p "$RES/app"
cp -R src plugins "$RES/app/"
find "$RES" -name __pycache__ -type d -prune -exec rm -rf {} +
"$HOSTPY" -m compileall -q "$RES/site" "$RES/app" >/dev/null || true  # 미리 컴파일 — 켤 때는 앱 안에 쓰지 않아요(PYTHONDONTWRITEBYTECODE)

cat > "$RES/run.sh" <<'EOF'
#!/bin/bash
# Outliner.app 실행 — 맥 종류에 맞는 파이썬으로 launcher.py (자체 창, 창을 다 닫으면 끝나요)
R="$(cd "$(dirname "$0")" && pwd)"
case "$(uname -m)" in arm64) PY="$R/python-arm64/bin/python3" ;; *) PY="$R/python-x86_64/bin/python3" ;; esac
DATA="${OUTLINER_DATA:-$HOME/Library/Application Support/Outliner}"
mkdir -p "$DATA" "$HOME/Library/Logs" || exit 1
export OUTLINER_DB="$DATA/app.db" PYTHONPATH="$R/site" PYTHONDONTWRITEBYTECODE=1 PYTHONNOUSERSITE=1
[ -t 1 ] || exec >> "$HOME/Library/Logs/Outliner.log" 2>&1
echo "▶ Outliner ($(uname -m)) — 데이터: $DATA"
exec "$PY" "$R/app/src/launcher.py" "$@"
EOF
chmod 755 "$RES/run.sh"

# 5) 서명(이 맥에서 만든 임시 서명) · dmg
xattr -cr "$APP"
codesign --force --deep --sign - "$APP"
ln -s /Applications "$WORK/dmg/Applications"
rm -f "$OUT"
hdiutil create -quiet -volname Outliner -srcfolder "$WORK/dmg" -fs HFS+ -format UDZO -imagekey zlib-level=9 "$OUT"
echo "✅ $OUT ($(du -h "$OUT" | cut -f1))"
