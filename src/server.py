"""로컬 outliner 서버. 실행: python src/server.py"""
import functools
import gzip
import json
import mimetypes
import os
import re
import shutil
import sqlite3
import subprocess
import tempfile
import threading
import time
import webbrowser
from datetime import datetime
from pathlib import Path

from flask import Flask, Response, g, jsonify, request, send_file, send_from_directory

BASE = Path(__file__).parent  # src/ (코드와 static/)
ROOT = BASE.parent  # 프로젝트 폴더 (data/ · plugins/)
DB_PATH = Path(os.environ.get("OUTLINER_DB") or ROOT / "data" / "app.db")  # 테스트용으로 바꿀 수 있어요
PLUGIN_DIR = ROOT / "plugins"
FILES_DIR = DB_PATH.parent / f"{DB_PATH.stem}-files"  # 첨부 파일(이미지·영상·PDF)이 저장되는 곳
AUDIO_EXT = {"mp3", "wav", "m4a", "aac", "ogg", "oga", "opus", "flac", "weba"}
ATTACH_EXT = {"png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "mp4", "webm", "mov", "m4v", "ogv", "pdf"} | AUDIO_EXT


def _kind(ext):
    return "image" if ext in {"png", "jpg", "jpeg", "gif", "webp", "avif", "bmp"} else "pdf" if ext == "pdf" else "audio" if ext in AUDIO_EXT else "video"


app = Flask(__name__, static_folder="static", static_url_path="")
app.config["MAX_CONTENT_LENGTH"] = 64 * 1024 ** 3  # 백업(.db · 전체 백업 .zip)은 아주 클 수 있어요 — 첨부 파일 하나는 따로 1GB까지 (ATTACH_LIMIT)
ATTACH_LIMIT = 1024 ** 3
mimetypes.add_type("text/javascript", ".js")  # Windows 등에서 .js가 text/plain으로 잡히는 문제 방지
mimetypes.add_type("text/javascript", ".mjs")  # PDF.js (static/vendor/pdfjs)
for _ext, _mime in {".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".aac": "audio/aac", ".ogg": "audio/ogg", ".oga": "audio/ogg",
                    ".opus": "audio/ogg", ".flac": "audio/flac", ".weba": "audio/webm"}.items():
    mimetypes.add_type(_mime, _ext)  # 운영체제에 등록이 없어도 브라우저가 재생할 수 있게

SCHEMA = """
CREATE TABLE IF NOT EXISTS nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id INTEGER REFERENCES nodes(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  content TEXT NOT NULL DEFAULT '',
  collapsed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_parent ON nodes(parent_id, position);
CREATE TABLE IF NOT EXISTS plugin_data (
  plugin TEXT, key TEXT, value TEXT, PRIMARY KEY (plugin, key)
);
-- 바깥 저장소와 맞춘 뒤 바뀌었는지: 맞출 때 (저장소, 표시)를 넣고, 항목 · 플러그인 데이터가 바뀌면 트리거가 모두 지워요 (판 번호 epoch는 빼요)
-- → 지문을 계산하지 않아도 돼요 (항목 140만 개면 8초)
CREATE TABLE IF NOT EXISTS remote_clean (key TEXT PRIMARY KEY, mark TEXT);
CREATE TRIGGER IF NOT EXISTS remote_dirty_ni AFTER INSERT ON nodes WHEN EXISTS (SELECT 1 FROM remote_clean) BEGIN DELETE FROM remote_clean; END;
CREATE TRIGGER IF NOT EXISTS remote_dirty_nd AFTER DELETE ON nodes WHEN EXISTS (SELECT 1 FROM remote_clean) BEGIN DELETE FROM remote_clean; END;
CREATE TRIGGER IF NOT EXISTS remote_dirty_nu AFTER UPDATE OF id, parent_id, position, content, collapsed ON nodes WHEN EXISTS (SELECT 1 FROM remote_clean) BEGIN DELETE FROM remote_clean; END;
CREATE TRIGGER IF NOT EXISTS remote_dirty_pi AFTER INSERT ON plugin_data WHEN NOT (new.plugin = 'core' AND new.key = 'epoch') AND EXISTS (SELECT 1 FROM remote_clean) BEGIN DELETE FROM remote_clean; END;
CREATE TRIGGER IF NOT EXISTS remote_dirty_pd AFTER DELETE ON plugin_data WHEN NOT (old.plugin = 'core' AND old.key = 'epoch') AND EXISTS (SELECT 1 FROM remote_clean) BEGIN DELETE FROM remote_clean; END;
CREATE TRIGGER IF NOT EXISTS remote_dirty_pu AFTER UPDATE ON plugin_data WHEN NOT (new.plugin = 'core' AND new.key = 'epoch') AND EXISTS (SELECT 1 FROM remote_clean) BEGIN DELETE FROM remote_clean; END;
"""

# 검색 인덱스: FTS5 trigram(글자 3개 단위) — 한글/영어 부분 일치를 노드가 수십만 개여도 인덱스로 찾아요.
FTS_SCHEMA = """
CREATE VIRTUAL TABLE nodes_fts USING fts5(content, content='nodes', content_rowid='id', tokenize='trigram');
CREATE TRIGGER nodes_ai AFTER INSERT ON nodes BEGIN
  INSERT INTO nodes_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER nodes_ad AFTER DELETE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;
CREATE TRIGGER nodes_au AFTER UPDATE OF content ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, content) VALUES ('delete', old.id, old.content);
  INSERT INTO nodes_fts(rowid, content) VALUES (new.id, new.content);
END;
"""

PAGE = 300          # 한 부모 아래에서 한 번에 불러오는 자식 수
VIEW_CAP = 3000     # 한 화면(view) 요청이 돌려주는 노드 최대 개수


@functools.lru_cache(maxsize=64)
def _compile(pattern):
    return re.compile(pattern, re.IGNORECASE)


def _regexp(pattern, text):
    return 1 if _compile(pattern).search(text or "") else 0


def _tune(con):
    con.execute("PRAGMA foreign_keys = ON")
    con.execute("PRAGMA synchronous = NORMAL")   # WAL과 함께 쓰면 안전하면서 빨라요
    con.execute("PRAGMA temp_store = MEMORY")
    con.execute("PRAGMA cache_size = -65536")    # 64MB 페이지 캐시
    con.execute("PRAGMA mmap_size = 268435456")


def db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH, timeout=10)
        g.db.row_factory = sqlite3.Row
        _tune(g.db)
        g.db.create_function("REGEXP", 2, _regexp, deterministic=True)
    return g.db


# ---- 다른 사이트가 이 앱에 몰래 요청하지 못하게 ----
# 앱이 켜져 있을 때 내가 방문한 다른 웹페이지가 127.0.0.1로 폼을 보내 DB를 바꾸거나 지우는 것을 막아요.
_LOCAL_HOSTS = ("127.0.0.1", "localhost", "[::1]")


@app.before_request
def _guard():
    h = request.host or ""
    host = h[: h.index("]") + 1] if h.startswith("[") else h.split(":")[0]  # 포트를 뗀 이름
    if host not in _LOCAL_HOSTS:  # 다른 이름으로 접속(DNS 리바인딩) → 거절
        return jsonify(error="이 앱은 이 컴퓨터 주소(127.0.0.1)로만 열 수 있어요"), 403
    if request.method in ("GET", "HEAD", "OPTIONS"):
        return None
    if request.headers.get("Sec-Fetch-Site") == "cross-site":
        return jsonify(error="다른 사이트에서 온 요청이에요"), 403
    origin = request.headers.get("Origin")
    if origin and origin != "null":
        o_host = origin.split("://", 1)[-1]
        if o_host != request.host:
            return jsonify(error="다른 사이트에서 온 요청이에요"), 403
    return None


@app.teardown_appcontext
def close_db(_):
    con = g.pop("db", None)
    if con:
        con.close()


def init_db():
    global HAS_FTS
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB_PATH)
    con.execute("PRAGMA journal_mode = WAL")
    con.executescript(SCHEMA)
    fresh = con.execute("SELECT 1 FROM sqlite_master WHERE name='nodes_fts'").fetchone() is None
    if fresh:
        try:
            con.executescript(FTS_SCHEMA)
            if con.execute("SELECT 1 FROM nodes LIMIT 1").fetchone():
                con.execute("INSERT INTO nodes_fts(nodes_fts) VALUES ('rebuild')")  # 기존 데이터 색인 (한 번만)
        except sqlite3.OperationalError as e:
            print("FTS5 trigram을 쓸 수 없어 느린 검색으로 대체해요:", e)
    HAS_FTS = con.execute("SELECT 1 FROM sqlite_master WHERE name='nodes_fts'").fetchone() is not None
    for t in ("node_shares", "users"):  # (이전 버전이 만들었던) 계정·공유 표: 비어 있거나 기본 사용자뿐이면 지워요
        if con.execute("SELECT 1 FROM sqlite_master WHERE name=?", (t,)).fetchone() and con.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] <= 1:
            con.execute(f"DROP TABLE {t}")
    if con.execute("SELECT COUNT(*) FROM nodes").fetchone()[0] == 0:
        def add(parent, pos, text):
            return con.execute(
                "INSERT INTO nodes(parent_id, position, content) VALUES (?,?,?)",
                (parent, pos, text),
            ).lastrowid

        root = add(None, 0, "시작하기")
        tips = [
            "⌘/ (Ctrl+/): 명령 목록 — 검색 · 서식 · 내보내기 … 모든 기능(플러그인)을 찾아 실행 · 단축키 지정",
                        "⌘. / ⌘, : 항목 안으로 / 밖으로 · ⌘⇧. / ⌘⇧, : 다음 / 이전 형제 항목으로",
            "⌘↓ / ⌘↑: 한 단계씩 펼치기 / 접기",
            "⌘⇧↑ / ↓: 항목 옮기기 (끝에 닿으면 이웃 항목 안으로)",
            "⌃+영문 글자 (윈도우는 Alt): 명령 단축키 — ⌘/ 명령 목록에서 확인·변경",
        ]
        for i, t in enumerate(tips):
            add(root, i, t)
    _migrate_prefs(con)
    shutil.rmtree(DB_PATH.parent / f"{DB_PATH.stem}-sync", ignore_errors=True)  # 예전 파일 합치기가 쌓던 기준 DB들 (합치기는 이제 바깥 저장소 맞추기에만)
    global _epoch
    r = con.execute("SELECT value FROM plugin_data WHERE plugin='core' AND key='epoch'").fetchone()
    _epoch = json.loads(r[0]) if r else _new_epoch(con)  # 이 DB의 '판' 번호. 통째로 바꾸면 새로 매겨서, 열려 있던 화면이 새로고침해요
    con.commit()
    con.close()


# 예전 명령 이름 → 지금 이름 (명령을 합치거나 이름을 바꾼 것). 사용자 설정(내가 정한 단축키 · ★)을 서버가 한 번 옮겨요 — 화면 코드는 플러그인 이름을 몰라요
_RENAMED = {"backup-all": "export", "export-pdf": "export", "af": "file", "attach": "import",
            "ca": "collapse", "ea": "expand", "ord": "sort", "rx": "replace", "regex": "replace", "gen": "generate", "tx": "tree", "reshape": "tree", "fold": "tree",
            "fs": "verse", "mt": "replace", "tag": "replace", "rv": "review", "dt": "review", "due": "review", "sc": "calendar", "lf": "plain", "links": "plain",
            "rec": "record", "today-date": "now", "date": "now", "timestamp": "now", "time": "now", "play-all": "play", "mobile-keys": "toolbar", "search": "jump"}
# 다른 명령에 합쳐진 것: '기본 단축키 끄기'는 옮기지 않아요 (합친 명령까지 꺼지면 안 돼요)
_MERGED = {"backup-all", "export-pdf", "attach", "dt", "due", "today-date", "date", "timestamp", "time", "mt", "tag", "tx", "reshape"}


def _migrate_prefs(con):
    """처음 켤 때 · DB를 통째로 바꾼 뒤: 예전 이름으로 남은 명령 설정과 앱이 갖고 있던 플러그인 데이터를 지금 자리로 옮겨요."""
    get = lambda pl, k: (lambda r: json.loads(r[0]) if r else None)(con.execute("SELECT value FROM plugin_data WHERE plugin=? AND key=?", (pl, k)).fetchone())
    put = lambda pl, k, v: con.execute("INSERT OR REPLACE INTO plugin_data(plugin, key, value) VALUES (?,?,?)", (pl, k, json.dumps(v)))
    to = lambda n: _RENAMED.get(n, n)
    con.execute("DELETE FROM plugin_data WHERE plugin='_sync'")  # 예전 파일 합치기의 계보
    favs = get("core", "cmd_favs")
    if isinstance(favs, list) and any(n in _RENAMED for n in favs):
        put("core", "cmd_favs", list(dict.fromkeys(to(n) for n in favs)))
    keys = get("core", "cmd_keys")
    if isinstance(keys, dict):
        m, off = (keys.get("map", {}), keys.get("off", [])) if "map" in keys else (keys, [])  # 예전 형식(조합 → 이름)도
        if "map" not in keys or any(n in _RENAMED for n in list(m.values()) + list(off)):
            put("core", "cmd_keys", {"map": {c: to(n) for c, n in m.items()}, "off": list(dict.fromkeys(to(n) for n in off if n not in _MERGED))})
    for where in ("cmd_bar", "cmd_text"):
        v = get("core", where)
        if isinstance(v, dict) and any(n in _RENAMED for n in v):
            put("core", where, {to(n): on for n, on in v.items()})
    # 형광펜 색 기록: 예전엔 앱 칸(core hl_colors · hl_recent) → 이제 highlight 플러그인 칸
    old = [c for c in (get("core", "hl_colors") or []) if isinstance(c, str)] + ([get("core", "hl_recent")] if isinstance(get("core", "hl_recent"), str) else [])
    if old:
        mine = get("highlight", "colors") or []
        put("highlight", "colors", list(dict.fromkeys([*mine, *old])))
        con.execute("DELETE FROM plugin_data WHERE plugin='core' AND key IN ('hl_colors','hl_recent')")


def _new_epoch(con):
    """DB를 통째로 바꿀 때마다 새 값. 열려 있는 화면이 이걸 보고 새로고침해요 (미리 받아 둔 항목 번호가 새 DB와 겹치지 않게)."""
    import uuid
    e = uuid.uuid4().hex[:12]
    con.execute("INSERT OR REPLACE INTO plugin_data(plugin, key, value) VALUES ('core','epoch',?)", (json.dumps(e),))
    return e


_epoch = ""
HAS_FTS = False


def _where(parent):
    """parent_id 비교식. NULL이면 IS NULL (인덱스를 타요)."""
    return ("parent_id IS NULL", ()) if parent is None else ("parent_id = ?", (parent,))


def slot(parent, index, count=1):
    """parent의 자식 목록에서 index번째 자리(끝이면 None/큰 값)를 count칸 비우고, 그 position 값을 돌려줘요.
    position에 빈 번호가 있어도 '몇 번째'를 정확히 계산해요. 뒤쪽 형제만 밀기 때문에 맨 끝에 넣을 땐 O(1)."""
    con = db()
    w, a = _where(parent)
    if index is not None and index >= 0:
        row = con.execute(f"SELECT position FROM nodes WHERE {w} ORDER BY position LIMIT 1 OFFSET ?", (*a, index)).fetchone()
        if row is not None:
            base = row[0]
            con.execute(f"UPDATE nodes SET position = position + ? WHERE {w} AND position >= ?", (count, *a, base))
            return base
    mx = con.execute(f"SELECT MAX(position) FROM nodes WHERE {w}", a).fetchone()[0]
    return 0 if mx is None else mx + 1


def _node_json(r):
    return {"id": r["id"], "parent_id": r["parent_id"], "content": r["content"], "collapsed": r["collapsed"], "hk": r["hk"]}


NODE_COLS = "n.id, n.parent_id, n.content, n.collapsed, EXISTS(SELECT 1 FROM nodes c WHERE c.parent_id = n.id) AS hk"


def _path(con, nid, cache):
    """nid의 조상 목록 [{id, content}] (맨 위 → 바로 위 부모)"""
    chain, p, guard = [], nid, 0
    while p is not None and guard < 200:
        if p not in cache:
            r = con.execute("SELECT parent_id, content FROM nodes WHERE id=?", (p,)).fetchone()
            cache[p] = (r["parent_id"], r["content"]) if r else (None, "")
        parent, content = cache[p]
        chain.append({"id": p, "content": content})
        p, guard = parent, guard + 1
    chain.reverse()
    return chain


@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.get("/api/view")
def view():
    """화면 하나를 그리는 데 필요한 것만 한 번에: (zoom 노드 + 경로) + 펼쳐진 노드들의 자식(너비 우선).
    노드가 아무리 많아도 응답 크기는 VIEW_CAP으로 제한돼요.
    parent=id|root, page=부모당 최대 자식 수, ensure=이 노드가 첫 화면 안에 들어오도록 page를 늘려요."""
    con = db()
    raw = request.args.get("parent", "root")
    parent = None if raw in ("root", "", "null") else int(raw)
    page = min(int(request.args.get("page", PAGE)), 5000)
    out = {"node": None, "path": [], "nodes": [], "lists": {}}
    if parent is not None:
        r = con.execute(f"SELECT {NODE_COLS} FROM nodes n WHERE n.id=?", (parent,)).fetchone()
        if r is None:
            return jsonify(error="없는 항목이에요"), 404
        out["node"] = _node_json(r)
        out["path"] = _path(con, parent, {})[:-1]
    ensure = request.args.get("ensure", type=int)
    if ensure is not None:
        r = con.execute("SELECT parent_id, position FROM nodes WHERE id=?", (ensure,)).fetchone()
        if r is not None and r["parent_id"] == parent:
            w, a = _where(parent)
            idx = con.execute(f"SELECT COUNT(*) FROM nodes WHERE {w} AND position < ?", (*a, r["position"])).fetchone()[0]
            if idx < 3000:
                page = max(page, idx + 30)
    budget, queue = VIEW_CAP, [parent]
    qi = 0
    while qi < len(queue) and budget > 0:
        pid = queue[qi]
        qi += 1
        w, a = _where(pid)
        w = w.replace("parent_id", "n.parent_id")
        lim = min(page if pid == parent else PAGE, budget)
        rows = con.execute(f"SELECT {NODE_COLS} FROM nodes n WHERE {w} ORDER BY n.position LIMIT ?", (*a, lim)).fetchall()
        total = con.execute(f"SELECT COUNT(*) FROM nodes WHERE {_where(pid)[0]}", a).fetchone()[0]
        out["lists"]["root" if pid is None else str(pid)] = {"ids": [r["id"] for r in rows], "total": total}
        for r in rows:
            out["nodes"].append(_node_json(r))
            if r["hk"] and not r["collapsed"]:
                queue.append(r["id"])
        budget -= len(rows)
    return jsonify(out)


@app.get("/api/children")
def children():
    """부모 아래 자식을 offset부터 limit개 (더 보기 / 접힌 항목 펼치기)."""
    parent = None if request.args.get("parent", "root") in ("root", "") else int(request.args["parent"])
    offset, limit = int(request.args.get("offset", 0)), min(int(request.args.get("limit", PAGE)), 5000)
    w, a = _where(parent)
    w = w.replace("parent_id", "n.parent_id")
    rows = db().execute(f"SELECT {NODE_COLS} FROM nodes n WHERE {w} ORDER BY n.position LIMIT ? OFFSET ?", (*a, limit, offset)).fetchall()
    total = db().execute(f"SELECT COUNT(*) FROM nodes WHERE {_where(parent)[0]}", a).fetchone()[0]
    return jsonify(nodes=[_node_json(r) for r in rows], total=total)


@app.get("/api/subtree")
def subtree():
    """root 아래 모든 하위 항목 (root 자신 제외). 플러그인이 '전체를 훑는' 명령을 쓸 때만 불러요."""
    raw = request.args.get("root", "root")
    root = None if raw in ("root", "", "null") else int(raw)
    limit = min(int(request.args.get("limit", 200000)), 1000000)
    w, a = _where(root)
    rows = db().execute(
        f"""WITH RECURSIVE sub(id) AS (
              SELECT id FROM nodes WHERE {w}
              UNION ALL SELECT n.id FROM nodes n JOIN sub ON n.parent_id = sub.id LIMIT ?)
            SELECT n.id, n.parent_id, n.position, n.content, n.collapsed,
                   EXISTS(SELECT 1 FROM nodes c WHERE c.parent_id = n.id) AS hk
            FROM nodes n JOIN sub ON sub.id = n.id""",
        (*a, limit + 1),
    ).fetchall()
    truncated = len(rows) > limit
    return jsonify(nodes=[dict(r) for r in rows[:limit]], truncated=truncated)


@app.get("/api/count")
def count_subtree():
    """ids와 그 하위 항목을 모두 합친 개수 (삭제 확인 문구용)"""
    ids = [int(x) for x in request.args.get("ids", "").split(",") if x.strip().isdigit()]
    if not ids:
        return jsonify(count=0)
    ph = ",".join("?" * len(ids))
    n = db().execute(
        f"""WITH RECURSIVE sub(id) AS (SELECT id FROM nodes WHERE id IN ({ph})
              UNION ALL SELECT n.id FROM nodes n JOIN sub ON n.parent_id = sub.id)
            SELECT COUNT(*) FROM sub""", ids).fetchone()[0]
    return jsonify(count=n)


TAG_ALL = re.compile(r"(?<![\w])[#@][^\W_][\w:-]*")  # 앱의 TAG_RE와 같은 규칙


@app.get("/api/tags")
def all_tags():
    """DB 전체의 태그(#태그 · @사람)와 쓰인 항목 수 — 항목에서 # · @를 칠 때 뜨는 태그 목록용"""
    counts, shown = {}, {}
    for (c,) in db().execute("SELECT content FROM nodes WHERE content LIKE '%#%' OR content LIKE '%@%'"):
        for t in {m.group(0).rstrip(":") for m in TAG_ALL.finditer(c)}:
            k = t.lower()
            counts[k] = counts.get(k, 0) + 1
            shown.setdefault(k, t)
    return jsonify(tags=[[shown[k], n] for k, n in sorted(counts.items(), key=lambda x: (-x[1], x[0]))])


# ---- 검색 ----
QUERY_TOKEN = re.compile(r'(-?)"([^"]+)"|(-?)"([^"]*)$|(-?)(\S+)')  # "구절" · 닫지 않은 "구절(입력 중) · 낱말


def parse_query(q):
    """공백 = AND · "구절"(따옴표 안은 글자 그대로: 공백 포함·대소문자 구분) · -제외. (client의 parseQuery와 같은 규칙)
    돌려주는 값: (포함할 것들, 제외할 것들, 따옴표로 묶은 것들의 집합)"""
    pos, neg, exact = [], [], set()
    for m in QUERY_TOKEN.finditer(q):
        if m.group(2) is not None:
            text, is_neg, quoted = m.group(2), m.group(1) == "-", True
        elif m.group(4) is not None:  # 닫는 따옴표를 아직 안 쓴 경우: 끝까지를 한 구절로
            text, is_neg, quoted = m.group(4), m.group(3) == "-", True
        else:
            text, is_neg, quoted = m.group(6).strip(), m.group(5) == "-", False
        if (quoted and not text.strip()) or (not quoted and not text.strip('"')):  # 빈 따옴표("")는 무시
            continue
        if text and not (text == "-" and not quoted):  # 입력 중인 '-'만 있는 조각은 무시
            (neg if is_neg else pos).append(text)
            if quoted:
                exact.add(text)
    return pos, neg, exact


TAG_TERM = re.compile(r"[#@][^\W_][\w:-]*")  # 검색어가 태그 하나(#태그, @사람)이면 그 태그 그대로만 찾아요


def _tag_re(t):
    """#태 → '#태'로 끝나는 태그만 (#태그는 아님). 앱의 태그 규칙(글자·숫자·_ · : · -)과 같은 경계."""
    return r"(?<![\w])" + re.escape(t) + r"(?![\w:-])"


def _like(s):
    return "%" + s.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


@app.get("/api/search")
def search():
    """q=검색어, scope=이 항목의 하위에서만, regex=1이면 q 전체를 정규식(대소문자 무시)으로, limit=최대 결과 수.
    after=이어 받기용 마지막 id. 일반 검색: 글자 3개 이상은 인덱스(FTS5), 그보다 짧은 낱말은 LIKE. 정규식은 (범위 안) 행을 훑어요."""
    con = db()
    q = request.args.get("q", "")
    limit = min(int(request.args.get("limit", 100)), 500)
    scope = request.args.get("scope", type=int)
    regex = request.args.get("regex") == "1"
    after = request.args.get("after", type=int)  # 이어 받기: 앞서 받은 마지막 id 뒤부터 (id 순서라 몇 번째 쪽이든 같은 속도)
    prefix, pre_args, where, args = "", [], [], []
    if scope is not None:
        prefix = ("WITH RECURSIVE sub(id) AS (SELECT id FROM nodes WHERE parent_id = ? "
                  "UNION ALL SELECT n.id FROM nodes n JOIN sub ON n.parent_id = sub.id) ")
        pre_args = [scope]
        where.append("n.id IN (SELECT id FROM sub)")
    if regex:
        if not q:
            return jsonify(results=[], more=False, terms=[])
        try:
            _compile(q)
        except re.error as e:
            return jsonify(error=f"정규식 오류: {e}", results=[], more=False, terms=[])
        where.append("n.content REGEXP ?")
        args.append(q)
        terms = [q]
    else:
        pos, neg, exact = parse_query(q)
        terms = pos
        if not pos:
            return jsonify(results=[], more=False, terms=[])
        long_terms = [t for t in pos if len(t) >= 3]
        if HAS_FTS and long_terms:
            match = " AND ".join('"' + t.replace('"', '""') + '"' for t in long_terms)
            where.append("n.id IN (SELECT rowid FROM nodes_fts WHERE nodes_fts MATCH ?)")
            args.append(match)
            like_pos = [t for t in pos if len(t) < 3]
        else:
            like_pos = pos
        for t in like_pos:
            where.append("n.content LIKE ? ESCAPE '\\'")
            args.append(_like(t))
        for t in neg:
            if TAG_TERM.fullmatch(t):
                where.append("NOT (n.content REGEXP ?)")  # -#태그: 그 태그가 그대로 있는 것만 빼요
                args.append(_tag_re(t))
            elif t in exact:
                where.append("instr(n.content, ?) = 0")  # 따옴표로 묶은 제외어: 대소문자까지 그대로
                args.append(t)
            else:
                where.append("n.content NOT LIKE ? ESCAPE '\\'")
                args.append(_like(t))
        for t in pos:
            if TAG_TERM.fullmatch(t):  # 태그는 그대로만: #태 로 #태그 를 찾지 않아요
                where.append("n.content REGEXP ?")
                args.append(_tag_re(t))
            if t in exact:  # 따옴표로 묶은 것: 위의 색인/LIKE가 후보를 줄인 뒤, 대소문자까지 그대로 들어 있는지 확인
                where.append("instr(n.content, ?) > 0")
                args.append(t)
    if after is not None:
        where.append("n.id > ?")
        args.append(after)
    try:
        rows = con.execute(
            f"{prefix}SELECT n.id, n.parent_id, n.content FROM nodes n WHERE {' AND '.join(where)} ORDER BY n.id LIMIT ?",
            (*pre_args, *args, limit + 1),
        ).fetchall()
    except sqlite3.OperationalError as e:
        return jsonify(error=str(e)), 400
    cache = {}
    results = [{"id": r["id"], "parent_id": r["parent_id"], "content": r["content"],
                "path": _path(con, r["id"], cache)[:-1]} for r in rows[:limit]]
    return jsonify(results=results, more=len(rows) > limit, terms=terms, exact=sorted(exact) if not regex else [])


@app.get("/api/sibling_index")
def sibling_index():
    """형제들 중 몇 번째인지 (검색 결과를 화면에 펼쳐 보일 때 필요한 만큼만 불러오려고)"""
    nid = request.args.get("id", type=int)
    r = db().execute("SELECT parent_id, position FROM nodes WHERE id=?", (nid,)).fetchone()
    if r is None:
        return jsonify(error="없는 항목이에요"), 404
    w, a = _where(r["parent_id"])
    idx = db().execute(f"SELECT COUNT(*) FROM nodes WHERE {w} AND position < ?", (*a, r["position"])).fetchone()[0]
    return jsonify(parent_id=r["parent_id"], index=idx)


# ---- 여러 브라우저 동기화 ----
# 쓰기 요청이 성공할 때마다 번호를 올리고, 열려 있는 모든 화면에 Server-Sent Events로 알려요.
# 화면은 자기가 보낸 변경(X-Client-Id)이 아닐 때만 새로 불러와요.
_sync = threading.Condition()
_events = []  # 최근 변경 [(번호, 보낸 화면 id)]
_rev = 0


def _bump(origin):
    global _rev
    with _sync:
        _rev += 1
        _events.append((_rev, origin or ""))
        del _events[:-500]
        _sync.notify_all()


@app.after_request
def _track_writes(resp):
    if (request.method in ("POST", "PATCH", "PUT", "DELETE") and request.path.startswith("/api/") and resp.status_code < 400
            and not request.path.startswith(("/api/reserve", "/api/plugin-data", "/api/media-pos", "/api/attachments", "/api/subtree", "/api/remote"))):
        _bump(request.headers.get("X-Client-Id"))
    if resp.status_code < 400 and request.method == "GET" and not request.path.startswith(("/api/", "/files/")) and "Cache-Control" not in resp.headers:
        # 화면 · 플러그인 · 라이브러리 파일은 매번 '바뀌었는지'만 물어봐요 (안 바뀌었으면 304라 가벼워요).
        # 이 머리글이 없으면 브라우저가 알아서 한동안 저장해 둔 걸 써서(특히 폰 크롬) 앱을 새 버전으로 바꿔도 예전 화면이 떠요
        resp.headers["Cache-Control"] = "no-cache"
    return resp


_clients = 0  # 실시간 연결 수 (브라우저마다 하나: 창들이 연결 하나를 나눠 써요). 전용 창 실행기가 '마지막 창이 닫히면 서버도 끄기'에 써요


@app.get("/api/events")
def events():
    def stream():
        global _clients
        with _sync:
            _clients += 1
        try:
            cur = _rev
            yield "retry: 1500\n\n"
            yield f"data: {json.dumps({'rev': cur, 'origins': [], 'epoch': _epoch})}\n\n"  # 처음 연결: 지금 DB의 epoch
            while True:
                with _sync:
                    if _rev == cur:
                        _sync.wait(timeout=5)
                    new = [o for r, o in _events if r > cur]
                    changed = _rev != cur
                    cur = _rev
                if changed:
                    yield f"data: {json.dumps({'rev': cur, 'origins': sorted(set(new) or {''}), 'epoch': _epoch})}\n\n"
                else:
                    yield ": ping\n\n"  # 연결 유지 (창이 닫혔으면 여기서 알아채요)
        finally:
            with _sync:
                _clients -= 1

    return Response(stream(), mimetype="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.get("/api/ping")
def ping():
    """전용 창 실행기가 '이미 켜진 이 앱의 서버인지' 확인할 때 써요."""
    return jsonify(app="outliner", db=str(DB_PATH.resolve()), clients=_clients, epoch=_epoch)


def open_clients():
    return _clients


# ---- 노드 CRUD ----
@app.post("/api/reserve")
def reserve_ids():
    """새 항목 id를 미리 n개 예약해요. 화면이 서버 응답을 기다리지 않고 바로 새 항목을 만들 수 있게 하려는 거예요."""
    n = max(1, min(int(request.get_json().get("n", 50)), 1000))
    con = db()
    con.execute("BEGIN IMMEDIATE")
    row = con.execute("SELECT seq FROM sqlite_sequence WHERE name='nodes'").fetchone()
    seq = row[0] if row else 0
    if row:
        con.execute("UPDATE sqlite_sequence SET seq = seq + ? WHERE name='nodes'", (n,))
    else:
        con.execute("INSERT INTO sqlite_sequence(name, seq) VALUES ('nodes', ?)", (n,))
    con.commit()
    return jsonify(first=seq + 1, count=n)


@app.post("/api/nodes")
def create_node():
    """id를 주면(예약해 둔 id) 그 id로 만들어요."""
    d = request.get_json()
    parent = d.get("parent_id")
    pos = slot(parent, d.get("position"))
    try:
        cur = db().execute(
            "INSERT INTO nodes(id, parent_id, position, content) VALUES (?,?,?,?)",
            (d.get("id"), parent, pos, d.get("content", "")),
        )
    except sqlite3.IntegrityError:
        db().rollback()
        return jsonify(error="이미 있는 id예요"), 409
    db().commit()
    return jsonify(id=cur.lastrowid)


@app.get("/api/sibling")
def sibling():
    """id의 이전(dir=-1)/다음(dir=1) 형제 id. 없으면 id=null"""
    nid, d = request.args.get("id", type=int), request.args.get("dir", 1, type=int)
    con = db()
    r = con.execute("SELECT parent_id, position FROM nodes WHERE id=?", (nid,)).fetchone()
    if r is None:
        return jsonify(error="없는 항목이에요"), 404
    w, a = _where(r["parent_id"])
    op, order = ("<", "DESC") if d < 0 else (">", "ASC")
    s = con.execute(f"SELECT id FROM nodes WHERE {w} AND position {op} ? ORDER BY position {order} LIMIT 1", (*a, r["position"])).fetchone()
    return jsonify(id=s["id"] if s else None)


@app.post("/api/duplicate")
def duplicate():
    """id 항목을 하위 항목까지 통째로 복제해 바로 다음 형제로 넣어요. 새 id를 돌려줘요."""
    nid = int(request.get_json()["id"])
    con = db()
    r = con.execute("SELECT parent_id, position FROM nodes WHERE id=?", (nid,)).fetchone()
    if r is None:
        return jsonify(error="없는 항목이에요"), 404
    rows = con.execute(
        """WITH RECURSIVE sub(id) AS (SELECT ?1 UNION ALL SELECT n.id FROM nodes n JOIN sub ON n.parent_id = sub.id)
           SELECT n.id, n.parent_id, n.position, n.content, n.collapsed FROM nodes n JOIN sub ON sub.id = n.id ORDER BY n.position""", (nid,)).fetchall()
    kids = {}
    for x in rows:
        kids.setdefault(x["parent_id"], []).append(x)
    idx = con.execute(f"SELECT COUNT(*) FROM nodes WHERE {_where(r['parent_id'])[0]} AND position < ?", (*_where(r["parent_id"])[1], r["position"])).fetchone()[0]
    pos = slot(r["parent_id"], idx + 1)
    new_root, stack = None, [(x, r["parent_id"], pos) for x in rows if x["id"] == nid]
    while stack:
        x, parent, p = stack.pop()
        new = con.execute("INSERT INTO nodes(parent_id, position, content, collapsed) VALUES (?,?,?,?)", (parent, p, x["content"], x["collapsed"])).lastrowid
        if new_root is None:
            new_root = new
        stack.extend((c, new, i) for i, c in reversed(list(enumerate(kids.get(x["id"], [])))))
    con.commit()
    return jsonify(id=new_root)


@app.patch("/api/nodes/<int:nid>")
def update_node(nid):
    d = request.get_json()
    con = db()
    if "parent_id" in d:  # (옛 방식) 이동. 새 코드는 /api/move를 써요
        pos = slot(d["parent_id"], d.get("position"))
        con.execute("UPDATE nodes SET parent_id=?, position=? WHERE id=?", (d["parent_id"], pos, nid))
    if "content" in d:
        con.execute("UPDATE nodes SET content=?, updated_at=CURRENT_TIMESTAMP WHERE id=?", (d["content"], nid))
    if "collapsed" in d:
        con.execute("UPDATE nodes SET collapsed=? WHERE id=?", (int(d["collapsed"]), nid))
    con.commit()
    return jsonify(ok=True)


@app.delete("/api/nodes/<int:nid>")
def delete_node(nid):
    db().execute("DELETE FROM nodes WHERE id=?", (nid,))  # 하위 항목은 CASCADE로 함께 삭제
    db().commit()
    return jsonify(ok=True)


@app.post("/api/subtree")
def subtree_snapshot():
    """ids 항목들의 하위 전체를 (부모가 먼저 오는 순서로) 돌려줘요. 되돌리기(undo)용 스냅샷이에요."""
    ids = [int(i) for i in request.get_json().get("ids", [])]
    con = db()
    out = []
    for nid in ids:
        out.extend(dict(r) for r in con.execute(
            """WITH RECURSIVE sub(id, d) AS (SELECT ?1, 0 UNION ALL SELECT n.id, sub.d + 1 FROM nodes n JOIN sub ON n.parent_id = sub.id)
               SELECT n.id, n.parent_id, n.position, n.content, n.collapsed FROM nodes n JOIN sub ON sub.id = n.id ORDER BY sub.d, n.position""", (nid,)))
    return jsonify(rows=out)


@app.post("/api/restore")
def restore_nodes():
    """지운 항목을 원래 id 그대로 되살려요. rows: 부모가 먼저 오는 순서. index가 있는 행은 그 부모의 index번째 자리에 끼워 넣고,
    없는 행은 저장해 둔 position을 써요. 이미 있는 id는 건너뛰어요."""
    rows = request.get_json().get("rows", [])
    con = db()
    n = 0
    for r in rows:
        if con.execute("SELECT 1 FROM nodes WHERE id=?", (r["id"],)).fetchone():
            continue
        pid = r.get("parent_id")
        if pid is not None and not con.execute("SELECT 1 FROM nodes WHERE id=?", (pid,)).fetchone():
            continue  # 부모가 없으면 되살릴 곳이 없어요
        pos = slot(pid, r["index"]) if r.get("index") is not None else r.get("position", 0)
        con.execute("INSERT INTO nodes(id, parent_id, position, content, collapsed) VALUES (?,?,?,?,?)",
                    (r["id"], pid, pos, r.get("content", ""), int(r.get("collapsed") or 0)))
        n += 1
    con.commit()
    return jsonify(ok=True, count=n)


@app.post("/api/move")
def move_nodes():
    """ids(여러 개 가능)를 parent_id 아래로 옮겨요. 자리는 before_id(이 노드 앞) / after_id(이 노드 뒤) / 없으면 맨 끝.
    형제를 전부 다시 매기지 않고, 들어갈 자리 뒤쪽만 밀어요."""
    d = request.get_json()
    ids = d.get("ids") or [d["id"]]
    parent, before, after = d.get("parent_id"), d.get("before_id"), d.get("after_id")
    con = db()
    moving = set(ids)
    if before in moving or after in moving:
        return jsonify(error="자기 자신을 기준으로 옮길 수 없어요"), 400
    p, guard = parent, 0  # 자기 자신이나 자기 하위 항목 안으로는 옮길 수 없어요
    while p is not None and guard < 1000:
        if p in moving:
            return jsonify(error="항목을 자기 하위로 옮길 수 없어요"), 400
        r = con.execute("SELECT parent_id FROM nodes WHERE id=?", (p,)).fetchone()
        p, guard = (r["parent_id"] if r else None), guard + 1
    w, a = _where(parent)
    anchor = before if before is not None else after
    if anchor is not None:
        r = con.execute("SELECT parent_id, position FROM nodes WHERE id=?", (anchor,)).fetchone()
        if r is None or r["parent_id"] != parent:
            return jsonify(error="기준 항목이 그 부모 아래에 없어요"), 400
        base = r["position"] if before is not None else r["position"] + 1
        con.execute(f"UPDATE nodes SET position = position + ? WHERE {w} AND position >= ?", (len(ids), *a, base))
    else:
        mx = con.execute(f"SELECT MAX(position) FROM nodes WHERE {w}", a).fetchone()[0]
        base = 0 if mx is None else mx + 1
    for k, nid in enumerate(ids):
        con.execute("UPDATE nodes SET parent_id=?, position=? WHERE id=?", (parent, base + k, nid))
    con.commit()
    return jsonify(ok=True)


@app.post("/api/import")
def import_items():
    """붙여넣기·가져오기용 일괄 저장. items: [{depth, text, collapsed?}], 첫 항목의 depth는 0."""
    d = request.get_json()
    parent, items = d.get("parent_id"), d["items"]
    con = db()
    top = sum(1 for it in items if it["depth"] == 0)
    pos = slot(parent, d.get("position"), max(top, 1))
    stack, top_count, last, made, tops = [], 0, None, [], []  # stack: [노드 id, 다음 자식 위치]
    for it in items:
        depth = min(it["depth"], len(stack))  # 단계를 건너뛸 수 없어요
        del stack[depth:]
        if depth == 0:
            p_id, position = parent, pos + top_count
            top_count += 1
        else:
            p_id, position = stack[-1][0], stack[-1][1]
            stack[-1][1] += 1
        last = con.execute(
            "INSERT INTO nodes(parent_id, position, content, collapsed) VALUES (?,?,?,?)",
            (p_id, position, it["text"], int(bool(it.get("collapsed")))),
        ).lastrowid
        stack.append([last, 0])
        if depth == 0:
            tops.append(last)
    con.commit()
    return jsonify(last=last, count=len(items), tops=tops)


# ---- DB 파일 가져오기 (내보내기의 'DB 파일 전체 백업'과 짝) ----
ZIP_FILE_RE = re.compile(r"files/([0-9a-f]{24}\.([a-z0-9]{2,4}))")


def _unpack_full_backup(ztmp):
    """전체 백업 ZIP → (DB 임시 경로, 첨부 이름 목록). ZIP 안의 경로는 정해진 모양만 받아요 (다른 폴더로 빠져나가는 이름은 무시)."""
    import shutil
    import zipfile
    try:
        z = zipfile.ZipFile(ztmp)
    except zipfile.BadZipFile:
        raise ValueError("ZIP 파일을 읽을 수 없어요")
    with z:
        if "outliner.db" not in z.namelist():
            g.files_zip = True  # 백업이 아닌 ZIP — 첨부 파일 ZIP이면 /api/import/files로 (가져오기가 알아서 그쪽으로 보내요)
            raise ValueError("전체 백업 ZIP이 아니에요 (안에 outliner.db가 없어요)")
        fd, tmp = tempfile.mkstemp(suffix=".db")
        with os.fdopen(fd, "wb") as out, z.open("outliner.db") as src:
            shutil.copyfileobj(src, out, 1024 * 1024)
        files = [n for n in z.namelist() if (m := ZIP_FILE_RE.fullmatch(n)) and m.group(2) in ATTACH_EXT]
    return tmp, files


def _extract_attachments(ztmp, names):
    """전체 백업 ZIP의 첨부를 첨부 폴더로. 이름이 내용 해시라 이미 있는 파일은 같은 파일이에요 → 건너뛰어요. 반환: 새로 넣은 개수"""
    import shutil
    import zipfile
    FILES_DIR.mkdir(parents=True, exist_ok=True)
    added = 0
    with zipfile.ZipFile(ztmp) as z:
        for n in names:
            dest = FILES_DIR / n.split("/", 1)[1]
            if dest.exists():
                continue
            part = dest.with_suffix(dest.suffix + ".part")
            with z.open(n) as src, open(part, "wb") as out:
                shutil.copyfileobj(src, out, 1024 * 1024)
            os.replace(part, dest)
            added += 1
    return added


def _open_uploaded_db():
    """올린 .db (또는 전체 백업 .zip) 를 임시 파일로 받아 검사하고 읽기 전용으로 열어요.
    반환: ((연결, 컬럼들), 임시 경로) — 잘못된 파일이면 (None, 오류 메시지). ZIP이면 g.zip = (ZIP 경로, 첨부 이름들)"""
    f = request.files.get("file")
    if f is None or not f.filename:
        return None, "파일이 없어요"
    fd, tmp = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    f.save(tmp)
    try:
        with open(tmp, "rb") as fh:
            head = fh.read(16)
        if head.startswith(b"PK\x03\x04"):
            ztmp = tmp
            tmp, names = _unpack_full_backup(ztmp)
            g.zip = (ztmp, names)
            with open(tmp, "rb") as fh:
                head = fh.read(16)
        if head != b"SQLite format 3\x00":
            raise ValueError("SQLite 파일이 아니에요")
        src = sqlite3.connect(f"file:{tmp}?mode=ro", uri=True)
        src.row_factory = sqlite3.Row
        cols = {r["name"] for r in src.execute("PRAGMA table_info(nodes)")}
        if not {"id", "parent_id", "position", "content"} <= cols:
            raise ValueError("이 앱의 DB 파일이 아니에요 (nodes 표가 없어요)")
        if src.execute("PRAGMA quick_check").fetchone()[0] != "ok":
            raise ValueError("DB 파일이 손상돼 있어요")
        return (src, cols), tmp
    except (sqlite3.DatabaseError, ValueError) as e:
        os.unlink(tmp)
        return None, str(e) if isinstance(e, ValueError) else "DB 파일을 읽을 수 없어요"


@app.post("/api/import/files")
def import_files_zip():
    """첨부 파일 ZIP(file 창의 '내려받기'로 여럿 받은 것 · 첨부 전체 ZIP 등)을 풀어 첨부 폴더로.
    ZIP 안의 이미지 · 영상 · 오디오 · PDF만 (폴더 안에 있어도), 다른 파일은 건너뛰어요. 이름이 내용 해시라 이미 있는 파일은 같은 것을 써요.
    반환: files=[{url, markdown, name, kind}], skipped=건너뛴 개수"""
    import zipfile
    f = request.files.get("file")
    if f is None or not f.filename:
        return jsonify(error="파일이 없어요"), 400
    fd, tmp = tempfile.mkstemp(suffix=".zip")
    os.close(fd)
    f.save(tmp)
    out, skipped = [], 0
    try:
        with zipfile.ZipFile(tmp) as z:
            for info in z.infolist():
                base = Path(info.filename).name
                ext = base.rsplit(".", 1)[-1].lower() if "." in base else ""
                if info.is_dir() or base.startswith(".") or "__MACOSX" in info.filename:
                    continue
                if ext not in ATTACH_EXT:
                    skipped += 1
                    continue
                with z.open(info) as src:
                    out.append(_store_attachment(src, base, ext, ATTACH_LIMIT))
    except zipfile.BadZipFile:
        return jsonify(error="ZIP 파일을 읽을 수 없어요"), 400
    except ValueError as e:
        return jsonify(error=str(e)), 413
    finally:
        os.unlink(tmp)
    return jsonify(files=out, skipped=skipped)


@app.post("/api/import/db")
def import_db():
    """.db 또는 전체 백업 .zip. ZIP이면 DB 처리가 끝난 뒤(미리보기가 아닐 때) 첨부 파일도 넣고, 응답에 files·files_added를 붙여요."""
    g.zip = None
    resp = _import_db()
    z = g.get("zip")
    if z:
        ztmp, names = z
        try:
            status = resp[1] if isinstance(resp, tuple) else 200
            body = (resp[0] if isinstance(resp, tuple) else resp).get_json()
            if status == 200 and not body.get("error"):
                body["files"] = len(names)
                if not body.get("dry_run"):
                    body["files_added"] = _extract_attachments(ztmp, names)
                resp = jsonify(body)
        finally:
            if os.path.exists(ztmp):
                os.unlink(ztmp)
    return resp


def _merge_plugin_data(live, src_path):
    """합치기 때 가져온 DB의 기록도 더해요: PDF · 이미지 · 오디오 · 영상 북마크(같은 id는 여기 것 유지) · 구간 반복(같은 구간은 하나로) · 재생 위치(여기 없는 곡만) · 접은 PDF · 이미지 마크업.
    한쪽에서 지운 기록은 지워지지 않아요 (더하기만). 더한 개수를 돌려줘요."""
    try:
        src = sqlite3.connect(f"file:{src_path}?mode=ro", uri=True)
    except sqlite3.Error:
        return 0
    try:
        if not src.execute("SELECT 1 FROM sqlite_master WHERE name='plugin_data'").fetchone():
            return 0
        theirs = {k: v for k, v in src.execute("SELECT key, value FROM plugin_data WHERE plugin='core' AND key IN ('pdf_marks','img_marks','media_marks','media_loops','media_pos','pdf_folded','img_ink')")}
    except sqlite3.Error:
        return 0
    finally:
        src.close()
    added = 0
    for key, raw in theirs.items():
        try:
            other = json.loads(raw)
        except (TypeError, ValueError):
            continue
        r = live.execute("SELECT value FROM plugin_data WHERE plugin='core' AND key=?", (key,)).fetchone()
        try:
            mine = json.loads(r[0]) if r else None
        except (TypeError, ValueError):
            mine = None
        if key == "pdf_folded":
            if not isinstance(other, list):
                continue
            mine = mine if isinstance(mine, list) else []
            new = [u for u in other if u not in mine]
            mine += new
            added += len(new)
        else:
            if not isinstance(other, dict):
                continue
            mine = mine if isinstance(mine, dict) else {}
            for url, v in other.items():
                if key in ("media_pos", "img_ink"):  # 재생 위치 · 마크업(원본 + 그린 것): 여기 없는 것만
                    if url not in mine and isinstance(v, dict):
                        mine[url] = v
                        added += 1
                    continue
                if not isinstance(v, list):
                    continue
                cur = mine.get(url) if isinstance(mine.get(url), list) else []
                for item in v:
                    if not isinstance(item, dict):
                        continue
                    if key in ("pdf_marks", "img_marks", "media_marks"):
                        dup = any(isinstance(x, dict) and x.get("id") == item.get("id") for x in cur)
                    else:
                        dup = any(isinstance(x, dict) and abs((x.get("a") or 0) - (item.get("a") or 0)) < 0.3
                                  and abs((x.get("b") or 0) - (item.get("b") or 0)) < 0.3 for x in cur)
                    if not dup:
                        cur.append(item)
                        added += 1
                if key == "media_loops":
                    cur.sort(key=lambda x: (x.get("a") or 0, x.get("b") or 0))
                if cur:
                    mine[url] = cur
        live.execute("INSERT OR REPLACE INTO plugin_data(plugin, key, value) VALUES ('core',?,?)", (key, json.dumps(mine)))
    return added


def _backup_live(live, prefix, keep=0):
    """지금 DB를 <DB>-<prefix>-<시각>.db로 통째로 안전 복사 → 그 이름. keep이면 최근 것만 남겨요"""
    path = DB_PATH.parent / f"{DB_PATH.stem}-{prefix}-{datetime.now().strftime('%Y%m%d-%H%M%S')}.db"
    dst = sqlite3.connect(path)
    live.backup(dst)
    dst.close()
    if keep:
        for old in sorted(DB_PATH.parent.glob(f"{DB_PATH.stem}-{prefix}-*.db"))[:-keep]:
            old.unlink(missing_ok=True)
    return path.name


def _replace_live(src, cols, tmp, prefix="before-import", keep=0):
    """지금 DB의 내용을 src(읽기 전용 연결 · 컬럼들 · 그 파일 경로)로 통째로 바꿔요 — 먼저 지금 DB를 <DB>-<prefix>-<시각>.db로 백업. → (항목 수, 백업 이름)"""
    live = sqlite3.connect(DB_PATH, timeout=30)
    try:
        backup_name = _backup_live(live, prefix)  # 지금 DB를 통째로 안전 복사
        # 파일을 덮어쓰지 않고 '내용'을 옮겨요: 우리 표·색인·번호표가 그대로 유지되고, 다른 앱에서 만든 DB도 안전해요
        live.execute("PRAGMA foreign_keys = OFF")
        use = [k for k in ("id", "parent_id", "position", "content", "collapsed", "created_at", "updated_at") if k in cols]
        live.execute("BEGIN IMMEDIATE")
        live.execute("DELETE FROM nodes")  # 색인은 트리거가 함께 비워요
        cur = src.execute(f"SELECT {', '.join(use)} FROM nodes ORDER BY id")
        while batch := cur.fetchmany(5000):
            live.executemany(f"INSERT INTO nodes({', '.join(use)}) VALUES ({', '.join('?' * len(use))})", [tuple(r) for r in batch])
        if src.execute("SELECT 1 FROM sqlite_master WHERE name='plugin_data'").fetchone():
            live.execute("DELETE FROM plugin_data")
            live.executemany("INSERT OR REPLACE INTO plugin_data(plugin, key, value) VALUES (?,?,?)",
                             [tuple(r) for r in src.execute("SELECT plugin, key, value FROM plugin_data")])
        _migrate_prefs(live)
        seq = src.execute("SELECT seq FROM sqlite_sequence WHERE name='nodes'").fetchone() if src.execute(
            "SELECT 1 FROM sqlite_master WHERE name='sqlite_sequence'").fetchone() else None
        if seq:  # 지운 번호도 다시 쓰지 않도록 '지금까지 쓴 가장 큰 번호'를 이어받아요
            live.execute("UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name='nodes'", (seq[0],))
        live.commit()
        global _epoch
        _epoch = _new_epoch(live)
        live.commit()
    finally:
        live.close()
    src.close()
    init_db()  # 빠진 표·색인 보충
    _bump(request.headers.get("X-Client-Id"))
    n = db().execute("SELECT COUNT(*) FROM nodes").fetchone()[0]
    if keep:  # 자주 바꾸는 길(바깥 저장소와 맞추기)은 최근 것만 남겨요
        for old in sorted(DB_PATH.parent.glob(f"{DB_PATH.stem}-{prefix}-*.db"))[:-keep]:
            old.unlink(missing_ok=True)
    return n, backup_name


def _import_db():
    """multipart: file=.db, mode=append(기본: 그 DB의 항목들을 parent_id 아래 맨 끝에 붙여요) | replace(현재 DB 전체를 교체, 먼저 자동 백업) | check(읽을 수 있는지만 — 바꾸지 않아요)"""
    mode = request.form.get("mode", "append")
    opened, tmp = _open_uploaded_db()
    if opened is None:
        return jsonify(error=tmp, files_zip=bool(g.get("files_zip"))), 400
    src, cols = opened
    try:
        if mode == "check":
            return jsonify(mode="check", dry_run=True)
        if mode == "replace":
            n, backup = _replace_live(src, cols, tmp)
            return jsonify(mode="replace", count=n, backup=backup)
        # 아래에 붙이기: 새 번호를 매겨 부모→자식 순서로 복사 (id가 겹쳐도 안전)
        rows = src.execute(f"SELECT id, parent_id, position, content, {'collapsed' if 'collapsed' in cols else '0 AS collapsed'} FROM nodes ORDER BY position, id").fetchall()
        kids, ids = {}, {r["id"] for r in rows}
        for r in rows:
            kids.setdefault(r["parent_id"] if r["parent_id"] in ids else None, []).append(r)
        con = db()
        target = request.form.get("parent_id", type=int)
        w, a = _where(target)
        base = con.execute(f"SELECT COALESCE(MAX(position), -1) + 1 FROM nodes WHERE {w}", a).fetchone()[0]
        count, seen = 0, set()
        stack = [(r, target, base + i) for i, r in enumerate(kids.get(None, []))][::-1]
        while stack:
            r, parent, pos = stack.pop()
            if r["id"] in seen:
                continue
            seen.add(r["id"])
            new = con.execute("INSERT INTO nodes(parent_id, position, content, collapsed) VALUES (?,?,?,?)",
                              (parent, pos, r["content"] or "", int(bool(r["collapsed"])))).lastrowid
            count += 1
            stack.extend((c, new, i) for i, c in reversed(list(enumerate(kids.get(r["id"], [])))))
        records = _merge_plugin_data(con, tmp)
        con.commit()
        return jsonify(mode="append", count=count, records=records)
    except sqlite3.Error as e:
        return jsonify(error=f"가져오지 못했어요: {e}"), 500
    finally:
        try:
            src.close()
        except sqlite3.Error:
            pass
        if os.path.exists(tmp):
            os.unlink(tmp)


# ---- 내보내기 (선택한 부분만 읽어요) ----
@app.get("/api/export")
def export_outline():
    """format=md|txt|json, ids=선택한 노드(하위 항목 포함, 화면 순서). ids가 없으면 전체."""
    fmt = request.args.get("format", "md")
    con = db()
    ids = [int(x) for x in request.args.get("ids", "").split(",") if x.strip().isdigit()]
    cols = "n.id, n.parent_id, n.content, n.collapsed"
    if ids:
        ph = ",".join("?" * len(ids))
        rows = con.execute(
            f"""WITH RECURSIVE sub(id) AS (SELECT id FROM nodes WHERE id IN ({ph})
                  UNION ALL SELECT n.id FROM nodes n JOIN sub ON n.parent_id = sub.id)
                SELECT {cols} FROM nodes n JOIN sub ON sub.id = n.id ORDER BY n.position""", ids).fetchall()
    else:
        rows = con.execute(f"SELECT {cols} FROM nodes n ORDER BY n.position").fetchall()
    kids, by_id = {}, {}
    for r in rows:
        by_id[r["id"]] = r
        kids.setdefault(r["parent_id"], []).append(r)
    tops = [by_id[i] for i in ids if i in by_id] if ids else kids.get(None, [])

    def walk(roots):  # 재귀 대신 스택으로: 아주 깊은 트리에서도 안전해요
        seen, stack = set(), [(n, 0) for n in reversed(roots)]
        while stack:
            n, depth = stack.pop()
            if n["id"] in seen:
                continue
            seen.add(n["id"])
            yield n, depth
            stack.extend((c, depth + 1) for c in reversed(kids.get(n["id"], [])))

    if fmt == "json":
        # 항목에 든 PDF · 이미지 · 오디오 · 영상의 북마크도 함께 (파일 주소마다 · 가져오기에서 되살려요)
        marks = {}
        for key in ("pdf_marks", "img_marks", "media_marks"):
            r = con.execute("SELECT value FROM plugin_data WHERE plugin='core' AND key=?", (key,)).fetchone()
            try:
                marks[key] = json.loads(r["value"]) if r else {}
            except ValueError:
                marks[key] = {}
        objs = {}
        for n, _ in walk(tops):
            objs[n["id"]] = {"content": n["content"], "collapsed": bool(n["collapsed"]), "children": []}
            for key, by_url in marks.items():
                got = {u: by_url[u] for u in dict.fromkeys(FILE_URL_RE.findall(n["content"] or "")) if by_url.get(u)}
                if got:
                    objs[n["id"]][key] = got
        for n, _ in walk(tops):
            if n["parent_id"] in objs and n not in tops:
                objs[n["parent_id"]]["children"].append(objs[n["id"]])
        body = json.dumps([objs[n["id"]] for n in tops if n["id"] in objs], ensure_ascii=False, indent=2)
        mime = "application/json"
    elif fmt == "txt":
        body, mime = "\n".join("\t" * d + n["content"] for n, d in walk(tops)), "text/plain"
    else:
        fmt, mime = "md", "text/markdown"
        body = "\n".join("  " * d + "- " + n["content"] for n, d in walk(tops))
    stamp = datetime.now().strftime("%Y%m%d-%H%M")
    return Response(
        body + "\n",
        mimetype=mime,
        headers={"Content-Disposition": f'attachment; filename="outline-{stamp}.{fmt}"'},
    )


def _snapshot_db():
    """내보낼 DB 사본 → 임시 경로. 지금 DB를 그대로 복사하면 지운 뒤 남은 빈 공간과 검색 색인까지 들어가 아주 커져요
    (항목 140만 개: 1.6GB → 가져오기 한도를 넘어요). 그래서 검색 색인을 뺀 표만 새 파일에 한 번에 옮겨요(빈 공간 없음) —
    색인은 항목에서 다시 만들 수 있어요 (이 파일을 가져오면 항목을 넣을 때 · 그대로 앱 DB로 쓰면 켤 때 저절로).
    (예전엔 통째로 VACUUM INTO 한 뒤 색인을 지우고 다시 VACUUM — 140만 개에 몇 초 더 걸렸어요)"""
    fd, tmp = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    os.unlink(tmp)
    con = sqlite3.connect(tmp, isolation_level=None)
    try:
        con.execute("PRAGMA journal_mode = OFF")  # 새 임시 파일 — 중간에 끊기면 버려요
        con.execute("PRAGMA synchronous = OFF")
        con.execute("ATTACH ? AS src", (str(DB_PATH),))
        con.execute("BEGIN")  # 한 트랜잭션 안에서 읽어서 표끼리 같은 순간의 판이에요
        objs = con.execute("SELECT type, name, tbl_name, sql FROM src.sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'"
                           " AND tbl_name NOT LIKE 'nodes_fts%' AND NOT (type = 'trigger' AND sql LIKE '%nodes_fts%')").fetchall()
        tables = [o for o in objs if o[0] == "table" and not o[3].upper().startswith("CREATE VIRTUAL")]
        for _, name, _, sql in tables:
            con.execute(sql)
            con.execute(f'INSERT INTO main."{name}" SELECT * FROM src."{name}"' + (" ORDER BY rowid" if name == "nodes" else ""))
        if con.execute("SELECT 1 FROM src.sqlite_master WHERE name='sqlite_sequence'").fetchone():
            con.execute("DELETE FROM main.sqlite_sequence")  # 지운 번호도 다시 쓰지 않게 '지금까지 쓴 가장 큰 번호'를 그대로
            con.execute("INSERT INTO main.sqlite_sequence SELECT * FROM src.sqlite_sequence")
        for kind, _, _, sql in objs:
            if kind in ("index", "trigger", "view"):
                con.execute(sql)
        con.execute("COMMIT")
        con.execute("DETACH src")
    except sqlite3.Error:  # 이상한 표가 있으면 예전처럼 통째로 복사
        con.close()
        if os.path.exists(tmp):
            os.unlink(tmp)
        dst = sqlite3.connect(tmp)
        db().backup(dst)
        dst.close()
        return tmp
    finally:
        con.close()
    return tmp


@app.get("/api/export/db")
def export_db():
    """DB만 내려받기 (빈 공간 · 검색 색인 없이 작게 — _snapshot_db)."""
    tmp = _snapshot_db()
    stamp = datetime.now().strftime("%Y%m%d-%H%M")
    resp = send_file(tmp, as_attachment=True, download_name=f"outliner-{stamp}.db")
    resp.call_on_close(lambda: os.unlink(tmp))
    return resp


@app.get("/api/export/all")
def export_all():
    """전체 백업: DB + 첨부 파일을 ZIP 하나로. 가져오기에서 이 ZIP을 고르면 둘 다 돌아와요."""
    import zipfile
    tmpdb = _snapshot_db()
    ztmp = tempfile.NamedTemporaryFile(suffix=".zip", delete=False)
    ztmp.close()
    n = 0
    try:
        with zipfile.ZipFile(ztmp.name, "w") as z:
            z.write(tmpdb, "outliner.db", compress_type=zipfile.ZIP_DEFLATED)
            if FILES_DIR.exists():
                for p in sorted(FILES_DIR.iterdir()):
                    if p.is_file() and FILE_NAME_RE.fullmatch(f"/files/{p.name}"):
                        z.write(p, f"files/{p.name}", compress_type=zipfile.ZIP_STORED)  # 이미지·영상은 이미 압축돼 있어요
                        n += 1
            z.writestr("manifest.json", json.dumps({"app": "outliner", "kind": "full-backup", "created": datetime.now().isoformat(timespec="seconds"),
                                                    "files": n}, ensure_ascii=False))
    finally:
        os.unlink(tmpdb)
    stamp = datetime.now().strftime("%Y%m%d-%H%M")
    resp = send_file(ztmp.name, as_attachment=True, download_name=f"outliner-full-{stamp}.zip")
    resp.call_on_close(lambda: os.unlink(ztmp.name))
    return resp


# ---- 바깥 저장소와 맞추기 (Dropbox … — 저장소는 플러그인이 맡아요) ----
# 앱은 저장소를 몰라요. 사본 · 변경분을 만들어 주고(snapshot · changes), 받은 것으로 저장소 판을 다시 만들고(build), 이 DB와 3-way로 합치고(merge), 저장소에 올린 · 받은 뒤 확정해요(commit).
# 주고받는 건 모두 gzip: 사본은 SQLite 파일(검색 색인 · 빈 공간 없이), 변경분은 한 줄에 하나씩인 JSON(아래 _write_delta).
# 마지막으로 맞춘 판(base.db)과 그 판의 표시(id — 저장소의 버전) · 맞춘 표시(mark — DB의 remote_clean과 같으면 그 뒤 안 바뀜)는 <DB>-remote/<이름>/ 에 둬요 — DB 안에 두면 백업에 섞여 다른 기기로 가요.
# 모든 기기가 저장소 판의 항목 번호를 그대로 써요: 합칠 때 저장소 판에 이 기기의 변경을 얹고(merge), 그 결과로 이 DB를 바꿔요 → 다음 합치기도 번호가 맞아요.
# 이 DB를 바꿀 때(commit apply)도 다른 곳만 고쳐요 — 다른 곳이 아주 많으면(처음 받는 기기) 통째로 바꿔요(_replace_live, 먼저 백업).
REMOTE_DIR = DB_PATH.parent / f"{DB_PATH.stem}-remote"
_REMOTE_KEY_RE = re.compile(r"[a-z0-9_-]{1,40}")
_REMOTE_TOKEN_RE = re.compile(r"[0-9a-f]{32}")
REMOTE_CONFLICT = "⚠ 충돌 · 이 기기에서 고친 글: "
REMOTE_REPLACE_OVER = 200_000  # 이 DB와 다른 곳이 이보다 많으면 고치지 않고 통째로 바꿔요
_NODE_COLS = ("id", "parent_id", "position", "content", "collapsed", "created_at", "updated_at")
_pd_skip = lambda t="": f"NOT ({t}plugin = 'core' AND {t}key = 'epoch')"  # 판 번호는 기기마다 따로


def _remote_dir(key):
    if not _REMOTE_KEY_RE.fullmatch(key or ""):
        raise ValueError("저장소 이름이 잘못됐어요")
    d = REMOTE_DIR / key
    d.mkdir(parents=True, exist_ok=True)
    for old in d.glob("pending-*"):  # 확정하지 않은 사본은 하루 지나면 지워요
        if time.time() - old.stat().st_mtime > 86400:
            old.unlink(missing_ok=True)
    return d


def _remote_state(d):
    try:
        return json.loads((d / "state.json").read_text())
    except (OSError, ValueError):
        return {}


def _mark_clean(con, key, mark):
    """이 DB가 지금 저장소 key의 mark 판과 같다고 표시해요 — 그 뒤 바뀌면 트리거가 지워요 (remote_clean). 부르는 쪽이 commit"""
    con.execute("INSERT OR REPLACE INTO remote_clean(key, mark) VALUES (?,?)", (key, mark))


def _clean_mark(key):
    r = db().execute("SELECT mark FROM remote_clean WHERE key=?", (key,)).fetchone()
    return r[0] if r else None


def _new_token():
    import uuid
    return uuid.uuid4().hex


def _pending(d, src_path, move=False, token=None):
    """사본을 확정 전 자리(pending-<token>.db)에 두고 이름표(token)를 돌려줘요. 올릴 gzip은 pending-<token>.gz"""
    token = token or _new_token()
    (shutil.move if move else shutil.copyfile)(src_path, d / f"pending-{token}.db")
    return token


def _pending_path(d, token, ext="db"):
    p = d / f"pending-{token}.{ext}"
    if not _REMOTE_TOKEN_RE.fullmatch(token or "") or not p.exists():
        raise LookupError("사본이 없어요 (다시 맞춰 주세요)")
    return p


def _gzip_file(src, dest, chunk=4 * 1024 * 1024):
    """gzip — 조각마다 따로 눌러 여러 코어로 (gzip 조각을 이어 붙인 파일도 그대로 풀려요). 140만 개 사본(350MB): 13초 → 1초"""
    from concurrent.futures import ThreadPoolExecutor
    n = os.cpu_count() or 2
    with open(src, "rb") as i, open(dest, "wb") as o, ThreadPoolExecutor(n) as ex:
        window = []  # 앞선 조각부터 차례로 쓰고, 메모리에는 몇 조각만
        while True:
            b = i.read(chunk)
            if b:
                window.append(ex.submit(gzip.compress, b, 6))
            if window and (len(window) >= 2 * n or not b):
                o.write(window.pop(0).result())
            if not b and not window:
                break


def _has_table(con, name, schema="main"):
    return con.execute(f"SELECT 1 FROM {schema}.sqlite_master WHERE type='table' AND name=?", (name,)).fetchone() is not None


def _write_delta(a_path, b_path, out_gz, limit=None):
    """a → b 변경분을 gzip JSON 줄로 out_gz에 써요 → 바뀐 줄 수. limit보다 많으면 쓰지 않고 None.
    줄: 첫 줄 {"v":1,"cols":[…],"seq":가장 큰 번호} · ["n", 항목 칸들…](넣거나 고침) · ["x", id](지움) · ["d", plugin, key, value] · ["dx", plugin, key]"""
    con = sqlite3.connect(f"file:{b_path}?mode=ro", uri=True)
    try:
        con.execute("ATTACH ? AS a", (f"file:{a_path}?mode=ro",))
        cols = [c for c in _NODE_COLS if c in {r[1] for r in con.execute("PRAGMA main.table_info(nodes)")}
                and c in {r[1] for r in con.execute("PRAGMA a.table_info(nodes)")}]
        differs = " OR ".join(f"n.{c} IS NOT o.{c}" for c in cols if c != "id")
        q_nodes = f"FROM main.nodes n LEFT JOIN a.nodes o ON o.id = n.id WHERE o.id IS NULL OR {differs}"
        q_gone = "FROM a.nodes o WHERE NOT EXISTS (SELECT 1 FROM main.nodes n WHERE n.id = o.id)"
        pd = _has_table(con, "plugin_data") and _has_table(con, "plugin_data", "a")
        q_data = (f"FROM main.plugin_data n LEFT JOIN a.plugin_data o ON o.plugin = n.plugin AND o.key = n.key "
                  f"WHERE (o.plugin IS NULL OR o.value IS NOT n.value) AND {_pd_skip('n.')}")
        q_dgone = (f"FROM a.plugin_data o WHERE {_pd_skip('o.')} "
                   "AND NOT EXISTS (SELECT 1 FROM main.plugin_data n WHERE n.plugin = o.plugin AND n.key = o.key)")
        seq = con.execute("SELECT seq FROM main.sqlite_sequence WHERE name='nodes'").fetchone() if _has_table(con, "sqlite_sequence") else None
        line = lambda o: (json.dumps(o, ensure_ascii=False) + "\n").encode()
        queries = [("n", f"SELECT {', '.join('n.' + c for c in cols)} {q_nodes}"), ("x", f"SELECT o.id {q_gone}")]
        if pd:
            queries += [("d", f"SELECT n.plugin, n.key, n.value {q_data}"), ("dx", f"SELECT o.plugin, o.key {q_dgone}")]
        count = 0  # 세면서 바로 써요 (먼저 세고 다시 읽으면 두 배 걸려요) — limit을 넘으면 그만두고 지워요
        with gzip.open(out_gz, "wb", compresslevel=6) as out:
            out.write(line({"v": 1, "cols": cols, "seq": seq[0] if seq else None}))
            for tag, q in queries:
                for r in con.execute(q):
                    count += 1
                    if limit is not None and count > limit:
                        break
                    out.write(line([tag, *r]))
                if limit is not None and count > limit:
                    break
        return None if limit is not None and count > limit else count  # 넘었으면 쓰다 만 파일 — 부르는 쪽이 지워요
    finally:
        con.close()


def _apply_delta(con, gz_path):
    """_write_delta로 만든 변경분을 con(트랜잭션 안 · 외래 키 꺼 둠)에 적용 → 적용한 줄 수. 형식이 틀리면 ValueError"""
    have = {r[1] for r in con.execute("PRAGMA table_info(nodes)")}
    pd = _has_table(con, "plugin_data")
    n = 0
    try:
        with gzip.open(gz_path, "rt", encoding="utf-8") as f:
            head = json.loads(f.readline() or "null")
            if not isinstance(head, dict) or head.get("v") != 1 or "id" not in head.get("cols", []):
                raise ValueError("변경분 파일이 아니에요")
            cols = head["cols"]
            keep = [i for i, c in enumerate(cols) if c in have and c in _NODE_COLS]
            use = [cols[i] for i in keep]
            upsert = (f"INSERT INTO nodes({', '.join(use)}) VALUES ({', '.join('?' * len(use))}) "
                      f"ON CONFLICT(id) DO UPDATE SET {', '.join(f'{c}=excluded.{c}' for c in use if c != 'id')}")
            batch = []
            def flush():
                if batch:
                    con.executemany(upsert, batch)
                    batch.clear()
            for raw in f:
                row = json.loads(raw)
                kind = row[0]
                if kind == "n":
                    batch.append(tuple(row[1 + i] for i in keep))
                    if len(batch) >= 5000:
                        flush()
                    n += 1
                    continue
                flush()
                if kind == "x":
                    con.execute("DELETE FROM nodes WHERE id=?", (row[1],))
                elif kind == "d" and pd:
                    con.execute("INSERT OR REPLACE INTO plugin_data(plugin, key, value) VALUES (?,?,?)", tuple(row[1:4]))
                elif kind == "dx" and pd:
                    con.execute("DELETE FROM plugin_data WHERE plugin=? AND key=?", tuple(row[1:3]))
                else:
                    continue
                n += 1
            flush()
    except (OSError, EOFError, json.JSONDecodeError, IndexError, TypeError) as e:
        raise ValueError(f"변경분 파일을 읽지 못했어요 ({e})")
    if head.get("seq") and _has_table(con, "sqlite_sequence"):  # 지운 번호도 다시 쓰지 않게 가장 큰 번호를 이어받아요
        if con.execute("UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name='nodes'", (head["seq"],)).rowcount == 0:
            con.execute("INSERT INTO sqlite_sequence(name, seq) VALUES ('nodes', ?)", (head["seq"],))
    return n


def _apply_delta_file(db_path, gz_path):
    con = sqlite3.connect(db_path, isolation_level=None)
    try:
        con.execute("PRAGMA foreign_keys = OFF")
        con.execute("BEGIN IMMEDIATE")
        try:
            n = _apply_delta(con, gz_path)
            con.execute("COMMIT")
        except Exception:
            con.execute("ROLLBACK")
            raise
        return n
    finally:
        con.close()


def _check_db(path):
    """저장소에서 받은 사본이 이 앱의 DB인지 — 아니면 ValueError"""
    with open(path, "rb") as fh:
        if fh.read(16) != b"SQLite format 3\x00":
            raise ValueError("SQLite 파일이 아니에요")
    try:
        con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        try:
            if not {"id", "parent_id", "position", "content"} <= {r[1] for r in con.execute("PRAGMA table_info(nodes)")}:
                raise ValueError("이 앱의 DB 파일이 아니에요 (nodes 표가 없어요)")
            if con.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                raise ValueError("DB 파일이 손상돼 있어요")
            return con.execute("SELECT COUNT(*) FROM nodes").fetchone()[0]
        finally:
            con.close()
    except sqlite3.DatabaseError:
        raise ValueError("DB 파일을 읽을 수 없어요")


def _save_upload(f, dest, gunzip=True):
    """올린 파일 → dest (gzip이면 풀어서)"""
    head = f.stream.read(2)
    f.stream.seek(0)
    if gunzip and head == b"\x1f\x8b":
        with gzip.GzipFile(fileobj=f.stream) as i, open(dest, "wb") as o:
            shutil.copyfileobj(i, o, 1024 * 1024)
    else:
        f.save(dest)


def _merge_plugin_rows(m, local_path, base_path):
    """플러그인 데이터 3-way: 이 기기에서만 바꾼 칸은 이 기기 것으로 (저장소 쪽도 바꿨으면 저장소 것 — 북마크 같은 기록은 _merge_plugin_data가 더해요)"""
    def rows(path):
        con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        try:
            return {(a, b): v for a, b, v in con.execute("SELECT plugin, key, value FROM plugin_data")}
        except sqlite3.Error:
            return {}
        finally:
            con.close()
    L, B = rows(local_path), rows(base_path)
    M = {(a, b): v for a, b, v in m.execute("SELECT plugin, key, value FROM plugin_data")}
    n = 0
    for k in set(L) | set(B):
        if k == ("core", "epoch"):
            continue
        lv, bv = L.get(k), B.get(k)
        if lv == bv or M.get(k) != bv:
            continue
        if lv is None:
            m.execute("DELETE FROM plugin_data WHERE plugin=? AND key=?", k)
        else:
            m.execute("INSERT OR REPLACE INTO plugin_data(plugin, key, value) VALUES (?,?,?)", (*k, lv))
        n += 1
    return n


def _remote_call(fn):
    @functools.wraps(fn)
    def wrap(key, *a, **kw):
        try:
            return fn(_remote_dir(key), *a, **kw)
        except ValueError as e:
            return jsonify(error=str(e)), 400
        except LookupError as e:
            return jsonify(error=str(e)), 404
        except sqlite3.Error as e:
            return jsonify(error=f"DB를 다루지 못했어요: {e}"), 500
    return wrap


def _tmp_db():
    fd, tmp = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    return tmp


@app.get("/api/remote/<key>")
@_remote_call
def remote_status(d):
    """{ synced: 마지막으로 맞춘 저장소 버전 | null, changed: 그 뒤 이 DB가 바뀌었는지, base: 맞춘 판이 남아 있는지 }"""
    st = _remote_state(d)
    if not st.get("id"):
        return jsonify(synced=None, changed=None, base=False)
    return jsonify(synced=st["id"], changed=_clean_mark(d.name) != st.get("mark"), base=(d / "base.db").exists())


@app.post("/api/remote/<key>/snapshot")
@_remote_call
def remote_snapshot(d):
    """{ of: 'live'(기본) | 'base' } → 그 판의 사본 { token, size } — GET …/pending/<token> 이 gzip 사본.
    live는 올린 뒤 commit(token, 새 버전)으로 확정해요. base(마지막으로 맞춘 판)는 저장소를 정리할 때(새 사본으로 갈음) 올리기만"""
    of = (request.get_json(silent=True) or {}).get("of", "live")
    token = _new_token()
    if of == "base":
        if not (d / "base.db").exists():
            raise LookupError("마지막으로 맞춘 판이 없어요")
        _pending(d, d / "base.db", token=token)
    else:
        con = db()
        _mark_clean(con, d.name, token)  # 사본을 뜨기 전에 — 그사이 고치면 지워져서 다음에 다시 올려요
        con.commit()
        _pending(d, _snapshot_db(), move=True, token=token)
    _gzip_file(d / f"pending-{token}.db", d / f"pending-{token}.gz")
    return jsonify(token=token, size=os.path.getsize(d / f"pending-{token}.gz"))


@app.post("/api/remote/<key>/changes")
@_remote_call
def remote_changes(d):
    """마지막으로 맞춘 판 → 지금 DB의 변경분 { token, size, count } — GET …/pending/<token> 이 gzip 변경분.
    올린 뒤 commit(token, 새 버전)으로 확정하면 '맞춘 판 + 이 변경분'이 새 기준이 돼요 (count 0이면 올릴 필요 없어요)"""
    base = d / "base.db"
    if not base.exists():
        raise LookupError("마지막으로 맞춘 판이 없어요")
    token = _new_token()
    gz = d / f"pending-{token}.gz"
    con = db()
    _mark_clean(con, d.name, token)  # 비교하기 전에 — 그사이 고치면 지워져서 다음에 다시 올려요
    con.commit()
    count = _write_delta(base, DB_PATH, gz)
    (d / f"pending-{token}.delta").touch()  # 확정할 때 맞춘 판에 이 변경분을 바로 얹어요 (맞춘 판을 복사하지 않아요 — 휴대폰에선 수백 MB 복사가 몇 초)
    return jsonify(token=token, size=os.path.getsize(gz), count=count)


@app.get("/api/remote/<key>/pending/<token>")
@_remote_call
def remote_pending(d, token):
    """올릴 gzip (snapshot · changes · merge가 만든 것)"""
    return send_file(_pending_path(d, token, "gz"), mimetype="application/gzip")


@app.post("/api/remote/<key>/build")
@_remote_call
def remote_build(d):
    """저장소 판을 이 기기에서 다시 만들어요 → { token, count(항목 수) }
    multipart: snapshot=저장소의 gzip 사본(없으면 마지막으로 맞춘 판에서 시작) · changes=그 뒤 변경분들(gzip, 차례대로 여러 개)
    그다음 commit(token, 버전, { apply: true })(받기) 또는 merge(token)(양쪽 다 바뀜)"""
    snap, changes = request.files.get("snapshot"), request.files.getlist("changes")
    tmp = _tmp_db()
    try:
        if snap is not None:
            _save_upload(snap, tmp)
            _check_db(tmp)
        elif (d / "base.db").exists():
            shutil.copyfile(d / "base.db", tmp)
        else:
            raise LookupError("마지막으로 맞춘 판이 없어서 사본부터 받아야 해요")
        for f in changes:
            fd, gz = tempfile.mkstemp(suffix=".gz")
            os.close(fd)
            try:
                _save_upload(f, gz, gunzip=False)
                _apply_delta_file(tmp, gz)
            finally:
                os.unlink(gz)
        count = _check_db(tmp)
        return jsonify(token=_pending(d, tmp, move=True), count=count)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


@app.post("/api/remote/<key>/merge")
@_remote_call
def remote_merge(d):
    """{ token: build로 만든 저장소 판 } → 그 판에 '마지막으로 맞춘 판 뒤 이 기기에서 바꾼 것'을 얹은 판 { token, size, count, added, updated, … }
    GET …/pending/<새 token> 이 저장소 판 → 합친 판의 gzip 변경분 (올린 뒤 commit(새 token, 새 버전, { apply: true })).
    저장소 판의 번호를 그대로 써요. 양쪽에서 같은 항목의 글을 고쳤으면 저장소 글은 그대로, 바로 아래에 이 기기 글을 '⚠ 충돌' 항목으로"""
    base = d / "base.db"
    if not base.exists():
        return jsonify(error="마지막으로 맞춘 판이 없어서 합칠 수 없어요"), 409
    remote = _pending_path(d, str((request.get_json(silent=True) or {}).get("token") or ""))
    token = _new_token()
    out = d / f"pending-{token}.db"
    shutil.copyfile(remote, out)
    local = _snapshot_db()
    try:
        m = sqlite3.connect(out)
        try:
            m.execute("CREATE TABLE IF NOT EXISTS plugin_data (plugin TEXT, key TEXT, value TEXT, PRIMARY KEY (plugin, key))")
            info = sync_merge.merge(m, local, base, label="이 기기", conflict_prefix=REMOTE_CONFLICT)
            info["settings"] = _merge_plugin_rows(m, local, base)
            info["records"] = _merge_plugin_data(m, local)
            m.commit()
        finally:
            m.close()
    finally:
        os.unlink(local)
    gz = d / f"pending-{token}.gz"
    count = _write_delta(remote, out, gz)
    return jsonify(token=token, size=os.path.getsize(gz), count=count, **info)


@app.post("/api/remote/<key>/commit")
@_remote_call
def remote_commit(d):
    """{ token, id, apply, backup } — 그 판이 저장소의 id 버전과 같다고 적어요 (다음 맞추기의 기준).
    apply면 먼저 이 DB를 그 판으로 — 다른 곳만 고치고(많으면 통째로 바꾸고, 먼저 백업), 열린 화면은 새로고침해요.
    backup이면 고치기만 할 때도 먼저 지금 DB를 <DB>-before-remote-<시각>.db로 (이 기기의 맞추지 않은 글을 버릴 때)"""
    global _epoch
    body = request.get_json(silent=True) or {}
    rid, token = body.get("id"), str(body.get("token") or "")
    if not isinstance(rid, str) or not rid or len(rid) > 200:
        return jsonify(error="버전이 잘못됐어요"), 400
    if not body.get("apply") and _REMOTE_TOKEN_RE.fullmatch(token) and (d / f"pending-{token}.delta").exists():  # changes: 맞춘 판 + 변경분
        _apply_delta_file(d / "base.db", _pending_path(d, token, "gz"))
        p = d / "base.db"
    else:
        p = _pending_path(d, token)
    out, bump = {}, False
    if body.get("apply"):
        fd, gz = tempfile.mkstemp(suffix=".gz")
        os.close(fd)
        try:
            n = _write_delta(DB_PATH, p, gz, limit=REMOTE_REPLACE_OVER)
            if n is None:  # 처음 받는 기기처럼 거의 다 다르면 통째로
                src = sqlite3.connect(f"file:{p}?mode=ro", uri=True)
                src.row_factory = sqlite3.Row
                cols = {r["name"] for r in src.execute("PRAGMA table_info(nodes)")}
                out["count"], out["backup"] = _replace_live(src, cols, str(p), prefix="before-remote", keep=1)
                con = db()
                _mark_clean(con, d.name, token)
                con.commit()
            else:
                live = sqlite3.connect(DB_PATH, timeout=30, isolation_level=None)
                try:
                    if body.get("backup"):
                        out["backup"] = _backup_live(live, "before-remote", keep=1)
                    live.execute("PRAGMA foreign_keys = OFF")
                    live.execute("BEGIN IMMEDIATE")
                    try:
                        out["changed"] = _apply_delta(live, gz)
                        _mark_clean(live, d.name, token)
                        _epoch = _new_epoch(live)  # 미리 받아 둔 항목 번호가 받은 항목과 겹치지 않게 열린 화면은 새로고침
                        live.execute("COMMIT")
                    except Exception:
                        live.execute("ROLLBACK")
                        raise
                finally:
                    live.close()
                bump = request.headers.get("X-Client-Id")
        finally:
            os.unlink(gz)
    if p != d / "base.db":
        os.replace(p, d / "base.db")
    (d / "state.json").write_text(json.dumps({"id": rid, "mark": token, "at": datetime.now().isoformat(timespec="seconds")}))
    for old in d.glob("pending-*"):
        old.unlink(missing_ok=True)
    resp = jsonify(ok=True, **out)
    if bump is not False:  # 열린 화면에 새로고침 신호는 이 답을 보낸 뒤에 (먼저 보내면 새로고침에 이 답이 끊겨요)
        resp.call_on_close(lambda: _bump(bump))
    return resp


@app.put("/api/attachments/raw/<name>")
def attachment_restore(name):
    """첨부를 그 이름 그대로 넣어요 (다른 기기 · 저장소에서 받은 첨부 — 이름이 내용 해시라 같은 이름이면 같은 파일). 이미 있으면 그대로"""
    if not FILE_NAME_RE.fullmatch(f"/files/{name}") or name.rsplit(".", 1)[-1] not in ATTACH_EXT:
        return jsonify(error="첨부 이름이 잘못됐어요"), 400
    dest = FILES_DIR / name
    if dest.exists():
        return jsonify(ok=True, added=False)
    FILES_DIR.mkdir(parents=True, exist_ok=True)
    fd, part = tempfile.mkstemp(dir=FILES_DIR, suffix=".part")
    size = 0
    try:
        with os.fdopen(fd, "wb") as out:
            while chunk := request.stream.read(1024 * 1024):
                size += len(chunk)
                if size > ATTACH_LIMIT:
                    return jsonify(error="파일이 너무 커요"), 413
                out.write(chunk)
        os.replace(part, dest)
    finally:
        if os.path.exists(part):
            os.unlink(part)
    return jsonify(ok=True, added=True)


@app.get("/api/plugins")
def list_plugins():
    """plugins/<명령 이름>.js 하나 = 명령 하나. _로 시작하는 파일(_kit · _ui · _tools …)은 여러 명령이 같이 쓰는 도구라 빼요"""
    return jsonify(plugins=sorted(p.name for p in PLUGIN_DIR.glob("*.js") if not p.name.startswith("_")))


@app.get("/plugins/<path:name>")
def plugin_file(name):
    return send_from_directory(PLUGIN_DIR, name, mimetype="text/javascript" if name.endswith(".js") else None)


@app.get("/api/plugin-data/<plugin>/<key>")
def plugin_get(plugin, key):
    if plugin == "core" and key.startswith("cmd_"):  # 명령 설정을 읽을 때: 예전 이름이 끼어 있으면(합치기 · 다른 기기) 지금 이름으로 옮겨 둬요
        _migrate_prefs(db()); db().commit()
    r = db().execute("SELECT value FROM plugin_data WHERE plugin=? AND key=?", (plugin, key)).fetchone()
    return jsonify(value=json.loads(r["value"]) if r else None)


@app.put("/api/plugin-data/<plugin>/<key>")
def plugin_put(plugin, key):
    v = json.dumps(request.get_json().get("value"))
    db().execute("INSERT OR REPLACE INTO plugin_data(plugin, key, value) VALUES (?,?,?)", (plugin, key, v))
    db().commit()
    return jsonify(ok=True)


# ---- 첨부 파일 (이미지 · 영상 · 오디오 · PDF) ----
# 파일은 내용 해시로 이름을 지어 data 폴더에 저장하고(같은 파일은 한 번만), 항목에는 ![이름](/files/해시.확장자) 를 적어요.
@app.post("/api/upload")
def upload():
    f = request.files.get("file")
    if f is None or not f.filename:
        return jsonify(error="파일이 없어요"), 400
    name = Path(f.filename).name
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    if ext not in ATTACH_EXT:
        return jsonify(error=f".{ext or '?'} 파일은 첨부할 수 없어요 (이미지 · 영상 · 오디오 · PDF만)"), 400
    try:
        return jsonify(_store_attachment(f.stream, name, ext, ATTACH_LIMIT))
    except ValueError as e:
        return jsonify(error=str(e)), 413


def _store_attachment(stream, name, ext, limit=None):
    """stream을 내용 해시 이름으로 첨부 폴더에 저장하고 응답 정보를 돌려줘요. limit 바이트를 넘으면 ValueError"""
    import hashlib
    FILES_DIR.mkdir(parents=True, exist_ok=True)
    h = hashlib.sha256()
    size = 0
    fd, tmp = tempfile.mkstemp(dir=FILES_DIR, suffix=".part")
    try:
        with os.fdopen(fd, "wb") as out:
            while chunk := stream.read(1024 * 1024):
                size += len(chunk)
                if limit and size > limit:
                    raise ValueError(f"파일이 너무 커요 ({limit // (1024 * 1024)}MB까지)")
                h.update(chunk)
                out.write(chunk)
        stored = f"{h.hexdigest()[:24]}.{ext}"
        os.replace(tmp, FILES_DIR / stored)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    kind = _kind(ext)
    label = re.sub(r"[\[\]()]", "", name.rsplit(".", 1)[0]) or "첨부"
    return dict(url=f"/files/{stored}", name=name, kind=kind, markdown=f"{'!' if kind == 'image' else ''}[{label}](/files/{stored})")


def chrome_path():
    """Chrome / Edge / Chromium 실행 파일 (전용 창 열기 · PDF 만들기에 써요). 없으면 None"""
    names = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "msedge", "chrome"]
    for n in names:
        p = shutil.which(n)
        if p:
            return p
    cands = [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ]
    return next((c for c in cands if Path(c).exists()), None)



@app.post("/api/print-pdf")
def print_pdf():
    """{html, name} — 인쇄용 문서를 크롬(headless)으로 PDF로 만들어 첨부로 저장해요 → 첨부 정보(markdown 포함)"""
    d = request.get_json() or {}
    html = str(d.get("html") or "")
    name = re.sub(r'[\\/:*?"<>|\n\r\t]', " ", str(d.get("name") or "")).strip()[:80] or "내보내기"
    exe = chrome_path()
    if not exe:
        return jsonify(error="Chrome이나 Edge가 있어야 PDF를 앱 안에 만들 수 있어요"), 400
    base = f'<base href="{request.host_url}">'  # 문서 속 /files/… 이미지를 이 서버에서 불러와요
    html = re.sub(r"<head>", "<head>" + base, html, count=1) if "<head>" in html else base + html
    with tempfile.TemporaryDirectory() as tmp:
        src, out = Path(tmp) / "doc.html", Path(tmp) / "out.pdf"
        src.write_text(html, encoding="utf-8")
        args = [exe, "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", f"--user-data-dir={Path(tmp) / 'profile'}",
                "--no-pdf-header-footer", "--virtual-time-budget=10000", f"--print-to-pdf={out}", src.as_uri()]
        try:
            subprocess.run(args, capture_output=True, timeout=90)
        except subprocess.TimeoutExpired:
            return jsonify(error="PDF를 만드는 데 너무 오래 걸려요"), 500
        if not out.exists() or out.stat().st_size == 0:
            return jsonify(error="PDF를 만들지 못했어요"), 500
        with out.open("rb") as fh:
            return jsonify(_store_attachment(fh, f"{name}.pdf", "pdf"))


IMAGE_TYPE_EXT = {"image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/avif": "avif", "image/bmp": "bmp"}


@app.post("/api/upload-url")
def upload_url():
    """웹페이지에서 끌어다 놓은 이미지: 브라우저가 파일 대신 주소만 줄 때 서버가 그 주소에서 내려받아 첨부로 저장해요."""
    import urllib.error
    import urllib.parse
    import urllib.request

    if not request.is_json:  # 다른 사이트의 단순 요청이 끼어드는 것을 막아요
        return jsonify(error="JSON만 받아요"), 415
    url = (request.get_json().get("url") or "").strip()
    u = urllib.parse.urlsplit(url)
    if u.scheme not in ("http", "https") or not u.hostname:
        return jsonify(error="http/https 이미지 주소만 받아요"), 400
    host = u.hostname.lower()
    if host in ("localhost", "0.0.0.0") or host.startswith(("127.", "[::1]", "::1")):  # 이 앱이나 이 컴퓨터의 다른 서버는 부르지 않아요
        return jsonify(error="이 컴퓨터 주소의 이미지는 받을 수 없어요"), 400
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36",
        "Accept": "image/avif,image/webp,image/png,image/*;q=0.8,*/*;q=0.5",
        "Referer": f"{u.scheme}://{u.netloc}/",  # 남의 사이트에서 직접 불러가는 것을 막는 곳이 있어서 그 사이트 주소를 붙여요
    })
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            ctype = (r.headers.get("Content-Type") or "").split(";")[0].strip().lower()
            path_name = Path(urllib.parse.unquote(urllib.parse.urlsplit(r.geturl()).path)).name
            ext = IMAGE_TYPE_EXT.get(ctype) or (path_name.rsplit(".", 1)[-1].lower() if "." in path_name else "")
            if ext == "jpeg":
                ext = "jpg"
            if ext not in IMAGE_TYPE_EXT.values():
                return jsonify(error=f"이미지가 아니에요 ({ctype or '알 수 없는 형식'})"), 400
            stem = path_name.rsplit(".", 1)[0] if "." in path_name else path_name
            name = f"{stem[:80] or '웹 이미지'}.{ext}"
            return jsonify(_store_attachment(r, name, ext, limit=100 * 1024 * 1024))
    except ValueError as e:
        return jsonify(error=str(e)), 413
    except (urllib.error.URLError, OSError) as e:
        return jsonify(error=f"이미지를 내려받지 못했어요: {getattr(e, 'reason', e)}"), 502


@app.get("/files/<path:name>")
def serve_file(name):
    if not re.fullmatch(r"[0-9a-f]{24}\.[a-z0-9]{2,4}", name) or name.rsplit(".", 1)[-1] not in ATTACH_EXT:
        return "", 404
    resp = send_from_directory(FILES_DIR, name, conditional=True, max_age=31536000)  # 영상은 Range 요청으로 이어서 재생돼요
    resp.headers["X-Content-Type-Options"] = "nosniff"
    return resp


# ---- 첨부 파일 관리 (목록 · 어디서 쓰는지 · 안 쓰는 파일 정리 · 폴더 열기 · 전체 ZIP) ----
FILE_NAME_RE = re.compile(r"/files/([0-9a-f]{24}\.[a-z0-9]{2,4})")
FILE_URL_RE = re.compile(r"/files/[0-9a-f]{24}\.[a-z0-9]{2,4}")  # 글 속 첨부 주소 (북마크를 찾을 때)


def _attachment_refs(con):
    """파일 이름 → [(id, parent_id, content)] (글에 그 파일이 적힌 항목들)"""
    refs = {}
    for r in con.execute("SELECT id, parent_id, content FROM nodes WHERE content LIKE '%/files/%'"):
        for name in set(FILE_NAME_RE.findall(r["content"])):
            refs.setdefault(name, []).append((r["id"], r["parent_id"], r["content"]))
    return refs


def _ink_bases(con, refs):
    """마크업한 이미지의 원본 (그 마크업 이미지를 항목이 쓰는 동안은 '다시 고치기'에 필요해서 지우지 않아요) → {원본 이름: 마크업 이미지 이름}"""
    r = con.execute("SELECT value FROM plugin_data WHERE plugin='core' AND key='img_ink'").fetchone()
    try:
        ink = json.loads(r["value"]) if r else {}
    except ValueError:
        ink = {}
    out = {}
    for url, v in ink.items() if isinstance(ink, dict) else []:
        m, b = FILE_NAME_RE.fullmatch(url), FILE_NAME_RE.fullmatch(str((v or {}).get("base", "")))
        if m and b and m.group(1) in refs:
            out[b.group(1)] = m.group(1)
    return out


@app.get("/api/attachments")
def attachments_list():
    con = db()
    refs = _attachment_refs(con)
    bases = _ink_bases(con, refs)
    out, total = [], 0
    if FILES_DIR.exists():
        for f in FILES_DIR.iterdir():
            if not FILE_NAME_RE.fullmatch("/files/" + f.name):
                continue
            st = f.stat()
            ext = f.suffix[1:].lower()
            total += st.st_size
            rs = refs.get(f.name, [])
            out.append({"name": f.name, "url": f"/files/{f.name}", "kind": _kind(ext),
                        "size": st.st_size, "mtime": int(st.st_mtime), "ref_count": len(rs), "ink_base": f.name in bases,
                        "refs": [{"id": i, "parent_id": p, "content": ct[:160]} for i, p, ct in rs[:5]]})
    missing = sorted(n for n in refs if not (FILES_DIR / n).exists())  # 글에는 있는데 파일이 없는 경우
    out.sort(key=lambda x: -x["mtime"])
    return jsonify(files=out, total_size=total, missing=[{"name": n, "refs": [{"id": i, "content": ct[:160]} for i, _, ct in refs[n][:3]]} for n in missing], folder=str(FILES_DIR))


@app.get("/api/attachments/refs")
def attachments_refs():
    """?name=해시.확장자 — 이 첨부를 쓰는 항목 전부 (경로 포함). 관리 창에서 '쓰는 곳'을 펼칠 때."""
    name = request.args.get("name") or ""
    if not FILE_NAME_RE.fullmatch("/files/" + name):
        return jsonify(error="첨부 파일 이름이 아니에요"), 400
    con = db()
    cache = {}
    rows = con.execute("SELECT id, parent_id, content FROM nodes WHERE content LIKE ? ORDER BY id", (f"%/files/{name}%",)).fetchall()
    return jsonify(refs=[{"id": r["id"], "parent_id": r["parent_id"], "content": r["content"][:300], "path": _path(con, r["id"], cache)[:-1]}
                         for r in rows if name in FILE_NAME_RE.findall(r["content"])])


@app.post("/api/attachments/delete")
def attachments_delete():
    """{names:[…]} 를 지워요. 항목이 아직 쓰고 있는 파일은 force:true 가 아니면 건너뛰어요. {orphans:true} 는 안 쓰는 파일 전부."""
    body = request.get_json() or {}
    con = db()
    refs = _attachment_refs(con)
    if body.get("orphans"):
        names = [f.name for f in FILES_DIR.iterdir() if FILE_NAME_RE.fullmatch("/files/" + f.name)] if FILES_DIR.exists() else []
        bases = _ink_bases(con, refs)  # 마크업 원본은 정리에서 빼요
        names = [n for n in names if n not in refs and n not in bases]
    else:
        names = [n for n in body.get("names", []) if isinstance(n, str) and FILE_NAME_RE.fullmatch("/files/" + n)]
    deleted, skipped, freed = [], [], 0
    for n in names:
        fp = FILES_DIR / n
        if not fp.exists():
            continue
        if n in refs and not body.get("force"):
            skipped.append(n)
            continue
        freed += fp.stat().st_size
        fp.unlink()
        (TEXT_DIR / f"{n}.json.gz").unlink(missing_ok=True)  # 꺼내 둔 PDF 글도
        deleted.append(n)
    return jsonify(deleted=deleted, skipped=skipped, freed=freed)


# ---- PDF 글 캐시: 브라우저(PDF.js)가 한 번 꺼낸 쪽마다의 글을 저장해 둬요 → 여러 PDF 찾기가 다음부터(다른 기기도) 다시 읽지 않아요 ----
# 첨부 파일 이름은 내용의 해시라 내용이 바뀌지 않아요(고쳐 저장하면 새 이름) — 그래서 지울 때만 같이 지우면 돼요. v: 글 꺼내는 규칙이 바뀌면 올려요
TEXT_DIR = DB_PATH.parent / f"{DB_PATH.stem}-pdftext"
PDF_TEXT_V = 1


@app.get("/api/pdf-text/<name>")
def pdf_text_get(name):
    fp = TEXT_DIR / f"{name}.json.gz"
    if not FILE_NAME_RE.fullmatch("/files/" + name) or not fp.is_file():
        return jsonify(pages=None)
    try:
        d = json.loads(gzip.decompress(fp.read_bytes()))
    except (OSError, ValueError):
        return jsonify(pages=None)
    return jsonify(pages=d.get("pages") if d.get("v") == PDF_TEXT_V else None)


@app.put("/api/pdf-text/<name>")
def pdf_text_put(name):
    pages = (request.get_json() or {}).get("pages")
    if not FILE_NAME_RE.fullmatch("/files/" + name) or not (FILES_DIR / name).is_file():
        return jsonify(error="첨부 PDF가 아니에요"), 400
    if not isinstance(pages, list) or not all(isinstance(p, str) for p in pages):
        return jsonify(error="pages는 글 목록이어야 해요"), 400
    TEXT_DIR.mkdir(parents=True, exist_ok=True)
    tmp = TEXT_DIR / f"{name}.tmp"
    tmp.write_bytes(gzip.compress(json.dumps({"v": PDF_TEXT_V, "pages": pages}, ensure_ascii=False).encode()))
    os.replace(tmp, TEXT_DIR / f"{name}.json.gz")
    return jsonify(ok=True)


@app.post("/api/attachments/reveal")
def attachments_reveal():
    """첨부 폴더를 이 컴퓨터의 파일 탐색기(Finder)로 열어요. 이 서버는 내 컴퓨터에서만 접속되므로 가능해요."""
    import subprocess
    FILES_DIR.mkdir(parents=True, exist_ok=True)
    try:
        subprocess.Popen(["open", str(FILES_DIR)])  # 맥 Finder (안드로이드 앱에서는 열 수 없어서 아래 오류로)
    except Exception as e:  # 탐색기를 못 여는 환경
        return jsonify(error=str(e), folder=str(FILES_DIR)), 500
    return jsonify(ok=True, folder=str(FILES_DIR))


@app.post("/api/attachments/pack")
def attachments_pack():
    """첨부를 ZIP 하나로 (af의 다운로드 · 전체 ZIP). 폼: names=a.pdf,b.png 또는 all, 그리고 브라우저가 북마크 · 마크업을 파일 안에 담아
    보낸 판(파일 이름 = 저장 이름)은 원래 파일 대신 그걸 넣어요. 이름은 글에 적힌 이름 — 폼 전송이라 큰 ZIP도 바로 디스크로 받아져요."""
    import zipfile
    want = request.form.get("names") or ""
    every = want == "all"
    if every:
        names = sorted(f.name for f in FILES_DIR.iterdir() if FILE_NAME_RE.fullmatch("/files/" + f.name)) if FILES_DIR.exists() else []
    else:
        names = [n for n in want.split(",") if FILE_NAME_RE.fullmatch("/files/" + n) and (FILES_DIR / n).is_file()]
    if not names:
        return jsonify(error="내려받을 파일이 없어요"), 404
    swap = {f.filename: f for f in request.files.getlist("f") if f.filename in names}
    nice = _download_names(names, _attachment_refs(db()))
    fd, tmp = tempfile.mkstemp(suffix=".zip")
    os.close(fd)
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_STORED) as z:  # 이미 압축된 형식이라 저장만 해요
        for n in names:
            if n in swap:
                z.writestr(nice[n], swap[n].read())
            else:
                z.write(FILES_DIR / n, nice[n])
    label = "attachments" if every else f"attachments-{len(names)}"
    resp = send_file(tmp, as_attachment=True, download_name=f"{label}-{datetime.now():%Y%m%d-%H%M}.zip")
    resp.call_on_close(lambda: os.path.exists(tmp) and os.unlink(tmp))
    return resp


def _download_names(names, refs):
    """저장 이름(해시.확장자) → 내려받을 때 쓸 이름. 글에 적힌 [이름](/files/…) 을 쓰고, 겹치면 (2)·(3)을 붙여요."""
    out, used = {}, set()
    for n in names:
        stem, ext = n.rsplit(".", 1)
        label = ""
        for _, _, ct in refs.get(n, []):
            m = re.search(r"\[([^\]]*)\]\(/files/" + re.escape(n) + r"\)", ct)
            if m and m.group(1).strip():
                label = m.group(1).strip()
                break
        label = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "_", label)[:120].strip(" .") or stem
        if not label.lower().endswith("." + ext.lower()):
            label += "." + ext
        base, k, cand = label[: -len(ext) - 1], 2, label
        while cand.lower() in used:
            cand, k = f"{base} ({k}).{ext}", k + 1
        used.add(cand.lower())
        out[n] = cand
    return out


@app.get("/api/attachments/names")
def attachments_names():
    """?names=a.pdf,b.png — 내려받을 때 쓸 이름(글에 적힌 이름, 겹치면 (2)…). 브라우저에서 북마크를 담아 ZIP을 만들 때 써요."""
    names = [n for n in (request.args.get("names") or "").split(",") if FILE_NAME_RE.fullmatch("/files/" + n) and (FILES_DIR / n).is_file()]
    return jsonify(names=_download_names(names, _attachment_refs(db())) if names else {})


@app.get("/api/attachments/download")
def attachments_download():
    """?names=a.pdf,b.png — 고른 첨부를 내려받아요. 하나면 그 파일 그대로, 여럿이면 ZIP 하나로. 이름은 글에 적힌 이름으로."""
    import zipfile
    names = [n for n in (request.args.get("names") or "").split(",") if FILE_NAME_RE.fullmatch("/files/" + n) and (FILES_DIR / n).is_file()]
    if not names:
        return jsonify(error="내려받을 파일이 없어요"), 404
    nice = _download_names(names, _attachment_refs(db()))
    if len(names) == 1:
        return send_file(FILES_DIR / names[0], as_attachment=True, download_name=nice[names[0]])
    fd, tmp = tempfile.mkstemp(suffix=".zip")
    os.close(fd)
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_STORED) as z:
        for n in names:
            z.write(FILES_DIR / n, nice[n])
    resp = send_file(tmp, as_attachment=True, download_name=f"attachments-{len(names)}-{datetime.now():%Y%m%d-%H%M}.zip")
    resp.call_on_close(lambda: os.path.exists(tmp) and os.unlink(tmp))
    return resp


# ---- 첨부 재생·읽기 위치 (PDF 마지막 페이지 · 영상/오디오 마지막 재생 위치) ----
# DB에 저장해서 같은 서버에 붙은 브라우저·기기 모두 이어서 볼 수 있어요. {파일 주소: {page} | {t}}
@app.get("/api/media-pos")
def media_pos_get():
    r = db().execute("SELECT value FROM plugin_data WHERE plugin='core' AND key='media_pos'").fetchone()
    return jsonify(pos=json.loads(r["value"]) if r else {})


@app.post("/api/media-pos")
def media_pos_set():
    d = request.get_json() or {}
    url = str(d.get("url") or "")
    if not FILE_NAME_RE.fullmatch(url):
        return jsonify(error="첨부 파일 주소가 아니에요"), 400
    con = db()
    con.execute("BEGIN IMMEDIATE")
    r = con.execute("SELECT value FROM plugin_data WHERE plugin='core' AND key='media_pos'").fetchone()
    pos = json.loads(r["value"]) if r else {}
    cur = pos.get(url) or {}
    if "page" in d:
        cur["page"] = max(1, int(d["page"]))
    if "t" in d:
        cur["t"] = max(0.0, round(float(d["t"]), 1))
    if d.get("fit") in ("width", "page"):  # PDF 맞춤: 가로 · 세로
        cur["fit"] = d["fit"]
    pos[url] = cur
    con.execute("INSERT OR REPLACE INTO plugin_data(plugin, key, value) VALUES ('core','media_pos',?)", (json.dumps(pos),))
    con.commit()
    return jsonify(ok=True)


# ---- 명령 사용 횟수 (통합 창의 명령 목록을 자주 쓴 순으로 보여주려고) ----
@app.post("/api/bulk")
def bulk_update():
    """여러 노드를 한 번에 수정/삭제. ops: [{id, content?, collapsed?, parent_id?+position?, delete?}]
    parent_id를 주면 그 부모 아래 position 자리로 옮겨요 (계층 바꾸기 플러그인처럼 위치를 모두 계산해서 보낼 때). 자기 하위로는 못 옮겨요."""
    con = db()
    moves = []
    for op in request.get_json().get("ops", []):
        nid = op["id"]
        if op.get("delete"):
            con.execute("DELETE FROM nodes WHERE id=?", (nid,))
            continue
        if "content" in op:
            con.execute("UPDATE nodes SET content=? WHERE id=?", (op["content"], nid))
        if "collapsed" in op:
            con.execute("UPDATE nodes SET collapsed=? WHERE id=?", (int(op["collapsed"]), nid))
        if "parent_id" in op:
            moves.append((op["parent_id"], int(op.get("position") or 0), nid))
        con.execute("UPDATE nodes SET updated_at=CURRENT_TIMESTAMP WHERE id=?", (nid,))
    for parent, position, nid in moves:  # 옮기기는 다 고친 뒤에: 자기 하위로 들어가는 이동이면 전부 취소해요
        p, guard = parent, 0
        while p is not None and guard < 10000:
            if p == nid:
                con.rollback()
                return jsonify(error="항목을 자기 하위로 옮길 수 없어요"), 400
            r = con.execute("SELECT parent_id FROM nodes WHERE id=?", (p,)).fetchone()
            p, guard = (r["parent_id"] if r else None), guard + 1
        con.execute("UPDATE nodes SET parent_id=?, position=? WHERE id=?", (parent, position, nid))
    con.commit()
    return jsonify(ok=True)


@app.post("/api/fold")
def fold():
    """⌘↓ / ⌘↑ 한 번에 한 단계씩.
    down: 접혀 있으면 펼쳐요. 펼쳐져 있으면 지금 보이는 하위 중 가장 얕은 단계의 접힌 항목들을 모두 펼쳐요 (누를 때마다 한 단계 더 깊이).
    up:   하위가 하나라도 펼쳐져 있으면 하위를 모두 접어 직계 자녀만 보이게, 이미 그렇다면 자기 자신을 접어요.
    root=1 이면 id는 지금 들어와 있는 항목(제목)이라 자신은 늘 펼쳐진 것으로 봐요."""
    d = request.get_json()
    nid, down, root = d.get("id"), d.get("dir") == "down", bool(d.get("root"))
    con = db()
    w, a = _where(nid)
    if nid is not None:
        me = con.execute("SELECT collapsed, EXISTS(SELECT 1 FROM nodes c WHERE c.parent_id = nodes.id) AS hk FROM nodes WHERE id=?", (nid,)).fetchone()
        if me is None:
            return jsonify(error="없는 항목이에요"), 404
        if not me["hk"]:
            return jsonify(action="none", ids=[])
        if not root and me["collapsed"]:
            if not down:
                return jsonify(action="none", ids=[])
            con.execute("UPDATE nodes SET collapsed=0 WHERE id=?", (nid,))
            con.commit()
            return jsonify(action="expand", collapsed=0, ids=[nid])
    hk = "EXISTS(SELECT 1 FROM nodes c WHERE c.parent_id = n.id)"
    if down:
        # 펼쳐진 항목을 따라 내려가며 '보이는' 하위만 훑어요
        rows = con.execute(f"""WITH RECURSIVE t(id, d, col) AS (
              SELECT n.id, 1, n.collapsed FROM nodes n WHERE n.{w}
              UNION ALL SELECT n.id, t.d + 1, n.collapsed FROM nodes n JOIN t ON n.parent_id = t.id WHERE t.col = 0)
            SELECT t.id, t.d FROM t JOIN nodes n ON n.id = t.id WHERE t.col = 1 AND {hk} ORDER BY t.d""", a).fetchall()
        if not rows:
            return jsonify(action="none", ids=[])
        depth = rows[0]["d"]
        ids = [r["id"] for r in rows if r["d"] == depth][:3000]
        con.executemany("UPDATE nodes SET collapsed=0 WHERE id=?", [(i,) for i in ids])
        con.commit()
        return jsonify(action="expand", collapsed=0, ids=ids, depth=depth)
    open_kids = con.execute(f"SELECT 1 FROM nodes n WHERE n.{w} AND n.collapsed = 0 AND {hk} LIMIT 1", a).fetchone()
    if open_kids:
        ids = [r[0] for r in con.execute(f"""WITH RECURSIVE t(id) AS (SELECT n.id FROM nodes n WHERE n.{w}
              UNION ALL SELECT n.id FROM nodes n JOIN t ON n.parent_id = t.id)
            SELECT t.id FROM t JOIN nodes n ON n.id = t.id WHERE n.collapsed = 0 AND {hk}""", a)]
        con.executemany("UPDATE nodes SET collapsed=1 WHERE id=?", [(i,) for i in ids])
        con.commit()
        return jsonify(action="collapse", collapsed=1, ids=ids)
    if nid is None or root:
        return jsonify(action="none", ids=[])
    con.execute("UPDATE nodes SET collapsed=1 WHERE id=?", (nid,))
    con.commit()
    return jsonify(action="collapse", collapsed=1, ids=[nid])


@app.post("/api/collapse_subtree")
def collapse_subtree():
    """id 아래(자기 자신 포함) 자식이 있는 항목을 모두 접거나 펼침. 펼치기는 위쪽(얕은) 단계부터 limit개까지만."""
    d = request.get_json()
    collapsed = 1 if d.get("collapsed") else 0
    limit = int(d.get("limit") or 2000) if not collapsed else 10**9
    con = db()
    ids = [r[0] for r in con.execute(
        """WITH RECURSIVE t(id, d) AS (SELECT id, 0 FROM nodes WHERE id=? UNION ALL
             SELECT n.id, t.d + 1 FROM nodes n JOIN t ON n.parent_id = t.id)
           SELECT id FROM t WHERE EXISTS (SELECT 1 FROM nodes c WHERE c.parent_id = t.id)
           ORDER BY d LIMIT ?""", (d["id"], limit + 1))]
    truncated = len(ids) > limit
    ids = ids[:limit]
    con.executemany("UPDATE nodes SET collapsed=? WHERE id=? AND collapsed<>?", [(collapsed, i, collapsed) for i in ids])
    con.commit()
    return jsonify(ok=True, count=len(ids), truncated=truncated)


@app.post("/api/reorder")
def reorder_children():
    """같은 부모 아래 형제들의 순서를 ids 순서대로 다시 매김."""
    d = request.get_json()
    con = db()
    for i, nid in enumerate(d["ids"]):
        con.execute("UPDATE nodes SET position=? WHERE id=? AND parent_id IS ?", (i, nid, d.get("parent_id")))
    con.commit()
    return jsonify(ok=True)


import sync_merge  # noqa: E402


if __name__ == "__main__":
    init_db()
    port = int(os.environ.get("OUTLINER_PORT", 4300))  # OUTLINER → 키패드 68 85 46 37 → 두 자리씩 더한 일의 자리 = 4300 (5000은 맥 AirPlay와 겹쳐 403이 나요)
    url = f"http://127.0.0.1:{port}"
    print(f" * outliner: {url} 을 브라우저에서 여세요", flush=True)
    if os.environ.get("OUTLINER_OPEN_BROWSER"):  # 브라우저 자동 열기는 기본으로 꺼 뒀어요 (켜려면 OUTLINER_OPEN_BROWSER=1)
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    app.run(host="127.0.0.1", port=port, threaded=True)  # 로컬 전용: 외부에서 접속할 수 없어요
