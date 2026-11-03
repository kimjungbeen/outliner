"""안드로이드 앱(MainActivity)이 부르는 시작점 — 앱 폴더에 풀어 둔 src/server.py를 그대로 켜요."""
import os
import socket
import sys
import threading

PREFERRED = 4301  # 4300은 Termux에서 켠 Outliner가 쓸 수 있어서 — 주소가 같아야 화면 설정(localStorage)이 이어져요
_port = None


def _free(preferred):
    for p in (preferred, 0):
        with socket.socket() as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind(("127.0.0.1", p))
                return s.getsockname()[1]
            except OSError:
                continue


def start(app_dir, data_dir):
    """서버를 켜고 포트를 돌려줘요 (이미 켜져 있으면 그 포트)"""
    global _port
    if _port:
        return _port
    os.makedirs(data_dir, exist_ok=True)
    os.environ["OUTLINER_DB"] = os.path.join(data_dir, "app.db")
    os.environ["OUTLINER_NO_BROWSER"] = "1"
    sys.path.insert(0, os.path.join(app_dir, "src"))
    import server
    from werkzeug.serving import make_server
    server.init_db()
    srv = make_server("127.0.0.1", _free(PREFERRED), server.app, threaded=True)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    _port = srv.server_port
    return _port
