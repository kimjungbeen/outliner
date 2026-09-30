"""로컬 아웃라이너 서버. 실행: python app.py"""
import json
import os
import sqlite3
import tempfile
import threading
import webbrowser
from datetime import datetime
from pathlib import Path

from flask import Flask, Response, g, jsonify, request, send_file, send_from_directory

BASE = Path(__file__).parent
DB_PATH = BASE / "data" / "app.db"
PLUGIN_DIR = BASE / "plugins"

app = Flask(__name__, static_folder="static", static_url_path="")

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
"""


def db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
    return g.db


@app.teardown_appcontext
def close_db(_):
    con = g.pop("db", None)
    if con:
        con.close()


def init_db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB_PATH)
    con.executescript(SCHEMA)
    if con.execute("SELECT COUNT(*) FROM nodes").fetchone()[0] == 0:
        def add(parent, pos, text):
            return con.execute(
                "INSERT INTO nodes(parent_id, position, content) VALUES (?,?,?)",
                (parent, pos, text),
            ).lastrowid

        root = add(None, 0, "시작하기")
        tips = [
            "Enter: 새 항목 (커서 뒤의 글자는 새 항목으로 넘어가요)",
            "Tab / Shift+Tab: 들여쓰기 / 내어쓰기",
            "Alt+↑ / Alt+↓: 같은 단계에서 위아래로 옮기기",
            "점을 클릭하면 그 항목 안으로 들어가요",
            "빈 항목에서 Backspace: 항목 삭제",
        ]
        for i, t in enumerate(tips):
            add(root, i, t)
        add(None, 1, "[ ] 체크박스 예시 (plugins/todo.js)")
        add(None, 2, "[x] Alt+T로 체크박스, Alt+D로 오늘 날짜")
    con.commit()
    con.close()


def make_room(parent_id, pos):
    db().execute(
        "UPDATE nodes SET position = position + 1 WHERE parent_id IS ? AND position >= ?",
        (parent_id, pos),
    )


@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.get("/api/nodes")
def list_nodes():
    rows = db().execute(
        "SELECT id, parent_id, position, content, collapsed FROM nodes ORDER BY parent_id, position"
    ).fetchall()
    return jsonify([dict(r) for r in rows])


@app.post("/api/nodes")
def create_node():
    d = request.get_json()
    parent, pos = d.get("parent_id"), d.get("position", 0)
    make_room(parent, pos)
    cur = db().execute(
        "INSERT INTO nodes(parent_id, position, content) VALUES (?,?,?)",
        (parent, pos, d.get("content", "")),
    )
    db().commit()
    return jsonify(id=cur.lastrowid)


@app.patch("/api/nodes/<int:nid>")
def update_node(nid):
    d = request.get_json()
    con = db()
    if "parent_id" in d:  # 이동
        pos = d.get("position", 0)
        make_room(d["parent_id"], pos)
        con.execute("UPDATE nodes SET parent_id=?, position=? WHERE id=?", (d["parent_id"], pos, nid))
    if "content" in d:
        con.execute("UPDATE nodes SET content=? WHERE id=?", (d["content"], nid))
    if "collapsed" in d:
        con.execute("UPDATE nodes SET collapsed=? WHERE id=?", (int(d["collapsed"]), nid))
    con.execute("UPDATE nodes SET updated_at=CURRENT_TIMESTAMP WHERE id=?", (nid,))
    con.commit()
    return jsonify(ok=True)


@app.delete("/api/nodes/<int:nid>")
def delete_node(nid):
    db().execute("DELETE FROM nodes WHERE id=?", (nid,))  # 하위 항목은 CASCADE로 함께 삭제
    db().commit()
    return jsonify(ok=True)


@app.post("/api/import")
def import_items():
    """붙여넣기·가져오기용 일괄 저장. items: [{depth, text, collapsed?}], 첫 항목의 depth는 0."""
    d = request.get_json()
    parent, pos, items = d.get("parent_id"), d.get("position", 0), d["items"]
    con = db()
    top = sum(1 for it in items if it["depth"] == 0)
    con.execute(
        "UPDATE nodes SET position = position + ? WHERE parent_id IS ? AND position >= ?",
        (top, parent, pos),
    )
    stack, top_count, last = [], 0, None  # stack: [노드 id, 다음 자식 위치]
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
    con.commit()
    return jsonify(last=last, count=len(items))


def _load_tree():
    rows = db().execute(
        "SELECT id, parent_id, position, content, collapsed FROM nodes ORDER BY position"
    ).fetchall()
    kids, by_id = {}, {}
    for r in rows:
        n = dict(r)
        by_id[n["id"]] = n
        kids.setdefault(n["parent_id"], []).append(n)
    return kids, by_id


@app.get("/api/export")
def export_outline():
    """format=md|txt|json, ids=선택한 노드(하위 항목 포함). ids가 없으면 전체."""
    fmt = request.args.get("format", "md")
    kids, by_id = _load_tree()
    ids = [int(x) for x in request.args.get("ids", "").split(",") if x.strip().isdigit()]
    if ids:
        chosen = set(ids)

        def under_chosen(i):
            p = by_id[i]["parent_id"]
            while p is not None:
                if p in chosen:
                    return True
                p = by_id[p]["parent_id"]
            return False

        order = {}

        def index(pid):
            for n in kids.get(pid, []):
                order[n["id"]] = len(order)
                index(n["id"])

        index(None)
        top = sorted(
            (by_id[i] for i in chosen if i in by_id and not under_chosen(i)),
            key=lambda n: order[n["id"]],
        )
    else:
        top = kids.get(None, [])

    def lines(n, depth, fmt_line):
        yield fmt_line(n["content"], depth)
        for c in kids.get(n["id"], []):
            yield from lines(c, depth + 1, fmt_line)

    def as_json(n):
        return {
            "content": n["content"],
            "collapsed": bool(n["collapsed"]),
            "children": [as_json(c) for c in kids.get(n["id"], [])],
        }

    if fmt == "json":
        body, mime = json.dumps([as_json(n) for n in top], ensure_ascii=False, indent=2), "application/json"
    elif fmt == "txt":
        body = "\n".join(l for n in top for l in lines(n, 0, lambda t, d: "\t" * d + t))
        mime = "text/plain"
    else:
        fmt = "md"
        body = "\n".join(l for n in top for l in lines(n, 0, lambda t, d: "  " * d + "- " + t))
        mime = "text/markdown"
    stamp = datetime.now().strftime("%Y%m%d-%H%M")
    return Response(
        body + "\n",
        mimetype=mime,
        headers={"Content-Disposition": f'attachment; filename="outline-{stamp}.{fmt}"'},
    )


@app.get("/api/export/db")
def export_db():
    """SQLite 파일 전체를 안전하게 복사(백업)해서 내려받기."""
    tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
    tmp.close()
    dst = sqlite3.connect(tmp.name)
    db().backup(dst)
    dst.close()
    stamp = datetime.now().strftime("%Y%m%d-%H%M")
    resp = send_file(tmp.name, as_attachment=True, download_name=f"outliner-{stamp}.db")
    resp.call_on_close(lambda: os.unlink(tmp.name))
    return resp


@app.get("/api/plugins")
def list_plugins():
    return jsonify(plugins=sorted(p.name for p in PLUGIN_DIR.glob("*.js")))


@app.get("/plugins/<path:name>")
def plugin_file(name):
    return send_from_directory(PLUGIN_DIR, name)


@app.get("/api/plugin-data/<plugin>/<key>")
def plugin_get(plugin, key):
    r = db().execute("SELECT value FROM plugin_data WHERE plugin=? AND key=?", (plugin, key)).fetchone()
    return jsonify(value=json.loads(r["value"]) if r else None)


@app.put("/api/plugin-data/<plugin>/<key>")
def plugin_put(plugin, key):
    v = json.dumps(request.get_json().get("value"))
    db().execute("INSERT OR REPLACE INTO plugin_data(plugin, key, value) VALUES (?,?,?)", (plugin, key, v))
    db().commit()
    return jsonify(ok=True)


if __name__ == "__main__":
    init_db()
    url = "http://127.0.0.1:5000"
    threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    app.run(host="127.0.0.1", port=5000)  # 로컬 전용: 외부에서 접속할 수 없어요
