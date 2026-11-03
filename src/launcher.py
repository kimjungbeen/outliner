"""실행 관리: 서버를 켜고, 주소창·탭 없는 전용 창(Chrome 앱 모드)을 열고, 창을 다 닫으면 서버를 꺼요.   실행: python src/launcher.py

Chrome / Edge / Chromium 의 '앱 모드'(--app): 주소창·탭이 없는 창. 따로 설치할 게 없어요.
셋 다 없으면 평소처럼 기본 브라우저로 열어요.
pywebview가 있으면(맥 설치 파일 Outliner.dmg) 크롬 대신 이 앱의 창으로 — 맥은 내장 WebKit (OUTLINER_WINDOW=chrome이면 크롬)
옵션: --fullscreen (전체 화면)   --port 4300

여러 창:
- 이 파일을 한 번 더 실행하면 서버를 새로 켜지 않고, 이미 켜진 서버로 창만 하나 더 열어요 (서로 실시간 반영).
- 서버는 마지막 창이 닫힐 때 함께 꺼져요 (창이 하나라도 남아 있으면 계속 켜져 있어요).
"""
import json
import urllib.request
import argparse
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
import webbrowser
from pathlib import Path

os.environ["OUTLINER_NO_BROWSER"] = "1"  # 브라우저는 아래에서 우리가 직접 골라 열어요
import server as outliner  # noqa: E402


def free_port(preferred):
    for p in (preferred, 0):
        with socket.socket() as s:
            # 방금 끈 서버의 연결이 잠깐(TIME_WAIT) 남아 있어도 그 포트를 다시 써요 — 서버(werkzeug)도 이렇게 열어요.
            # 이게 없으면 끄고 바로 켤 때 4300이 '쓰는 중'으로 보여 엉뚱한 포트로 켜져요 (포트가 바뀌면 브라우저에 저장한 설정도 따로 놀아요)
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind(("127.0.0.1", p))
                return s.getsockname()[1]
            except OSError:
                continue


def wait_up(port, timeout=10):
    end = time.time() + timeout
    while time.time() < end:
        with socket.socket() as s:
            s.settimeout(0.3)
            if s.connect_ex(("127.0.0.1", port)) == 0:
                return True
        time.sleep(0.1)
    return False


# 이 컴퓨터의 서버를 부를 땐 시스템 프록시를 거치지 않아요 — urllib는 127.0.0.1도 프록시로 보내서, 프록시 너머(예: 휴대폰 핫스팟)의
# 다른 Outliner가 대답하면 '4300은 다른 DB가 쓰는 중'으로 보고 엉뚱한 포트로 켰어요 (크롬은 127.0.0.1을 프록시로 안 보내요)
_local = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def our_server(port, timeout=0.8):
    """그 포트에 이 앱의 서버가 떠 있으면 그 정보를, 아니면 None"""
    try:
        with _local.open(f"http://127.0.0.1:{port}/api/ping", timeout=timeout) as r:
            info = json.loads(r.read())
            return info if info.get("app") == "outliner" else None
    except Exception:
        return None


def serve_until_last_window(first_wait=60, grace=6):
    """창이 처음 붙을 때까지 기다렸다가, 열린 창이 하나도 없는 상태가 grace초 이어지면 돌아와요(→ 서버 종료)"""
    t0 = time.time()
    while outliner.open_clients() == 0 and time.time() - t0 < first_wait:
        time.sleep(0.5)
    idle = None
    while True:
        if outliner.open_clients() > 0:
            idle = None
        else:
            idle = idle or time.time()
            if time.time() - idle > grace:
                return
        time.sleep(0.5)


# 전용 창 폴더가 커지지 않게 — 크롬이 혼자 내려받는 AI 모델(4GB) · 최적화 힌트는 끄고, 캐시는 100MB까지
SLIM = ["--disable-features=OptimizationGuideModelDownloading,OptimizationGuideOnDeviceModel,OptimizationHints,OptimizationHintsFetching,OptimizationTargetPrediction",
        "--disk-cache-size=104857600"]
BULKY = ("OptGuideOnDeviceModel", "optimization_guide_model_store")  # 예전에 받아 둔 것


def trim_profile():
    """창이 하나도 없을 때(서버를 새로 켤 때) 예전에 받아 둔 모델 폴더를 지워요"""
    for name in BULKY:
        shutil.rmtree(outliner.DB_PATH.parent / "app-window-profile" / name, ignore_errors=True)


def open_window(url, fullscreen=False):
    """전용 창 하나를 열고 바로 돌아와요 (창 수는 서버가 세요)."""
    exe = outliner.chrome_path()
    if exe:
        profile = outliner.DB_PATH.parent / "app-window-profile"  # 이 창 전용 설정 (평소 브라우저와 섞이지 않아요)
        args = [exe, f"--app={url}", f"--user-data-dir={profile}", "--no-first-run", "--no-default-browser-check", "--start-maximized", *SLIM]
        if fullscreen:
            args.append("--start-fullscreen")
        subprocess.Popen(args)  # 이미 떠 있는 크롬이면 그 크롬에 창을 넘기고 바로 끝나요 → 창 수는 서버가 세요
        return "chrome"
    print("Chrome/Edge를 찾지 못해 기본 브라우저로 열어요")
    webbrowser.open(url)
    return "browser"


def pywebview():
    """이 앱 자체 창(pywebview)을 쓸 수 있으면 그 모듈, 아니면 None"""
    if os.environ.get("OUTLINER_WINDOW") == "chrome":
        return None
    try:
        import webview
        return webview
    except ImportError:
        return None


# 자체 창에서 WebView가 혼자 못 하는 것: window.open(Dropbox 허용하기 · 원본 보기 …) · 틀(iframe) 안의 인쇄 → 파이썬으로
_BRIDGE = """(() => { if (window.__outlinerBridge) return; window.__outlinerBridge = 1;
  window.open = (u) => { window.pywebview.api.open(new URL(u, location.href).href); return null; };
  globalThis.__outlinerPrint = (w) => window.pywebview.api.print(w.document.documentElement.outerHTML);
})()"""


def run_webview(webview, url, fullscreen=False):
    """자체 창을 열고, 이 실행에서 연 창을 다 닫으면 돌아와요 (메뉴 '파일 › 새 창' ⌘N)"""
    from webview.menu import Menu, MenuAction

    webview.settings["ALLOW_DOWNLOADS"] = True  # 내려받기는 저장 창으로
    webview.settings["OPEN_EXTERNAL_LINKS_IN_BROWSER"] = True

    class Api:
        def open(self, u):
            if u.startswith(url + "/"):
                window(u)
            elif u.startswith(("http://", "https://")):
                webbrowser.open(u)

        def print(self, html):  # 인쇄할 문서를 창 하나에 그려 인쇄 창을 열어요 (/files/… 이미지는 이 서버에서)
            base = f'<base href="{url}/">'
            html = html.replace("<head>", "<head>" + base, 1) if "<head>" in html else base + html
            w = webview.create_window("인쇄", html=html, width=820, height=1000)
            w.events.loaded += lambda: w.evaluate_js("setTimeout(() => window.print(), 300)")

    api = Api()
    opened = []

    def window(u=url):
        n = len(opened) % 8  # 새 창은 조금씩 비켜서
        w = webview.create_window("Outliner", u, js_api=api, width=1280, height=860, min_size=(420, 320),
                                  x=80 + 28 * n, y=60 + 28 * n, text_select=True, fullscreen=fullscreen)
        opened.append(w)
        w.events.loaded += lambda: w.evaluate_js(_BRIDGE)
        return w

    def started():  # 메뉴에 단축키 — pywebview 메뉴는 단축키를 못 줘서 AppKit으로 (맥)
        if sys.platform != "darwin":
            return
        try:
            import AppKit
            from PyObjCTools import AppHelper

            def keys():
                for top in AppKit.NSApp.mainMenu().itemArray():
                    for it in (top.submenu().itemArray() if top.submenu() else []):
                        if it.title() == "새 창":
                            it.setKeyEquivalent_("n")
            AppHelper.callAfter(keys)
        except Exception:
            pass

    icon = outliner.BASE / "mac" / "Outliner.icns"
    if sys.platform == "darwin":  # 메뉴 막대 · 정보 창의 이름을 'Python' 대신
        try:
            from Foundation import NSBundle
            NSBundle.mainBundle().infoDictionary()["CFBundleName"] = "Outliner"
        except Exception:
            pass
    window()
    webview.start(started, icon=str(icon) if icon.exists() else None, private_mode=False, storage_path=str(outliner.DB_PATH.parent / "app-webview"),
                  menu=[Menu("파일", [MenuAction("새 창", window)])])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=int(os.environ.get("OUTLINER_PORT", 4300)))
    ap.add_argument("--fullscreen", action="store_true")
    ap.add_argument("--no-window", action="store_true", help="서버만 실행 (시험용)")
    a = ap.parse_args()
    me = str(outliner.DB_PATH.resolve())

    # 1) 같은 DB의 서버가 이미 켜져 있으면: 서버는 그대로 두고 창만 하나 더
    info = our_server(a.port)
    # 포트는 잡혀 있는데 답이 없으면 — 이 앱 서버가 바쁘거나(큰 작업 중) 끄는 중일 수 있어요. 바로 다른 포트로 켜면
    # 창 주소가 매번 바뀌고, 예전 서버가 꺼지면 그 창은 '접속할 수 없음'이 돼요 → 몇 초 더 기다려 봐요
    end = time.time() + 8
    while not info and free_port(a.port) != a.port and time.time() < end:
        info = our_server(a.port, timeout=2)
        if not info:
            time.sleep(0.5)
    if info and info.get("db") == me:
        url = f"http://127.0.0.1:{a.port}"
        if a.no_window:
            print(f"이미 켜져 있어요 {url}")
            return
        wv = pywebview()
        if wv:
            run_webview(wv, url, a.fullscreen)
        else:
            open_window(url, a.fullscreen)
        return

    # 2) 새로 켜기 (그 포트를 다른 DB의 이 앱이나 다른 프로그램이 쓰고 있으면 빈 포트로)
    outliner.init_db()
    trim_profile()
    port =free_port(a.port) if not info else free_port(0)
    url = f"http://127.0.0.1:{port}"
    threading.Thread(target=lambda: outliner.app.run(host="127.0.0.1", port=port, threaded=True, use_reloader=False), daemon=True).start()
    if not wait_up(port):
        sys.exit("서버가 시작되지 않았어요")
    if a.no_window:
        print(url, flush=True)
        serve_until_last_window(first_wait=float(os.environ.get("OUTLINER_FIRST_WAIT", 3600)))
        print("마지막 창이 닫혀서 서버를 꺼요", flush=True)
        return
    wv = pywebview()
    if wv:
        run_webview(wv, url, a.fullscreen)
        serve_until_last_window(first_wait=0)  # 다른 실행에서 연 창이 남아 있으면 계속 켜 둬요
        return
    open_window(url, a.fullscreen)
    serve_until_last_window()  # 다른 실행에서 연 창이 남아 있으면 계속 켜 둬요

if __name__ == "__main__":
    main()
