"""pip으로 설치한 Outliner 실행 — `outliner` 명령 (또는 python -m outliner). 옵션은 launcher.py와 같아요 (--port · --fullscreen)

데이터(글 · 첨부 · 설정)는 코드와 따로 — 업데이트(pip install --upgrade)해도 그대로예요. OUTLINER_DB로 바꿀 수 있어요
  맥: ~/Library/Application Support/Outliner (Outliner.dmg 앱과 같은 곳)   윈도우: %APPDATA%\\Outliner   그 밖: ~/.local/share/Outliner
"""
import os
import sys
from pathlib import Path

HERE = Path(__file__).parent


def data_dir():
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "Outliner"
    if os.name == "nt":
        return Path(os.environ.get("APPDATA") or Path.home()) / "Outliner"
    return Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share") / "Outliner"


def main():
    if not os.environ.get("OUTLINER_DB"):
        d = data_dir()
        d.mkdir(parents=True, exist_ok=True)
        os.environ["OUTLINER_DB"] = str(d / "app.db")
    sys.path.insert(0, str(HERE))  # server · launcher · sync_merge는 서로 이름으로 불러요 (폴더 실행과 같게)
    import launcher
    print(f"▶ Outliner — 데이터: {Path(os.environ['OUTLINER_DB']).parent}", flush=True)
    launcher.main()


if __name__ == "__main__":
    main()
