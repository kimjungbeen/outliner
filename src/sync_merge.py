"""3-way 합치기 — 바깥 저장소 맞추기(api.backup.merge)가 써요

세 DB의 항목 번호가 같아요(모든 기기가 저장소 판의 번호를 그대로 써요). 공통 기준(base)과 비교해서:
- 기준에 있던 항목(같은 번호) → 같은 항목. 상대 쪽에서만 바뀐 것을 반영해요.
- 기준에 없던 번호 → 상대가 새로 만든 항목. 이 DB에서 새 번호를 받아 추가해요.
- 기준에 있었는데 상대 쪽에 없음 → 상대가 지운 항목. 여기서 고치지 않았을 때만 지워요.
- 양쪽이 같은 항목의 글을 다르게 고침 → 여기 글은 그대로 두고, 바로 아래에 상대 버전을 '⚠ 충돌' 항목으로 넣어요.
"""
import sqlite3
from datetime import datetime

CONFLICT_PREFIX = "⚠ 충돌 · 가져온 쪽 버전: "


def merge(live, src_path, base_path, label="", conflict_prefix=CONFLICT_PREFIX):
    """live(이 DB 연결)에 src_path 쪽 변경을 3-way로 합쳐요. base_path: 두 쪽의 공통 기준 — 세 파일의 항목 번호가 같아요.
    {added, updated, moved, deleted, conflicts, orphans, kept}를 돌려줘요"""
    def load(con):
        nodes, kids = {}, {}
        has_col = "collapsed" in {r[1] for r in con.execute("PRAGMA table_info(nodes)")}
        q = f"SELECT id, parent_id, content, {'collapsed' if has_col else '0'} FROM nodes ORDER BY position, id"
        for i, p, c, col in con.execute(q):
            nodes[i] = [p, c or "", int(bool(col))]
            kids.setdefault(p, []).append(i)
        return nodes, kids

    bcon = sqlite3.connect(f"file:{base_path}?mode=ro", uri=True)
    B, Bk = load(bcon)
    bcon.close()
    fcon = sqlite3.connect(f"file:{src_path}?mode=ro", uri=True)
    F, Fk = load(fcon)
    fcon.close()

    Fi = {i: k for lst in Fk.values() for k, i in enumerate(lst)}  # 형제 안에서 몇 번째인지
    Bi = {i: k for lst in Bk.values() for k, i in enumerate(lst)}
    con = live
    L, _ = load(con)  # id → [parent, content, collapsed] (바뀔 때마다 함께 고쳐요)
    stats = dict(added=0, updated=0, moved=0, deleted=0, conflicts=0, orphans=0, kept=0)
    newmap = {}       # 상대 번호(공통 백업에 없던 것 + 되살린 것) → 이 DB 번호
    holder, holder_last = [None], [None]
    added_ids = set()

    def m(bid):  # 공통 백업 번호 → 이 DB 번호 (지워졌으면 None)
        return bid if bid in L else None

    def resolve(fid):  # 상대 번호 → 이 DB 번호
        if fid in newmap:
            return newmap[fid]
        return m(fid) if fid in B else None

    def inside(parent, nid):  # parent가 nid 자신이거나 그 하위인가
        p, g = parent, 0
        while p is not None and g < 100000:
            if p == nid:
                return True
            p, g = (L[p][0] if p in L else None), g + 1
        return False

    def place(parent, after):  # parent 아래 after 뒤(없으면 맨 앞)를 비우고 그 자리 번호를 돌려줘요
        w, a = ("parent_id IS NULL", ()) if parent is None else ("parent_id = ?", (parent,))
        if after is None:
            con.execute(f"UPDATE nodes SET position = position + 1 WHERE {w}", a)
            return 0
        pos = con.execute("SELECT position FROM nodes WHERE id=?", (after,)).fetchone()[0]
        con.execute(f"UPDATE nodes SET position = position + 1 WHERE {w} AND position > ?", (*a, pos))
        return pos + 1

    def anchor(fid, lp):  # 상대 쪽에서 fid 바로 앞 형제 중, 이 DB에서 같은 부모(lp) 아래 있는 가장 가까운 것
        sibs = Fk.get(F[fid][0], [])
        for k in range(Fi[fid] - 1, -1, -1):
            s = sibs[k]
            r = resolve(s)
            if r is not None and r in L and L[r][0] == lp:
                return r
        return None

    known = set(B)  # 공통 백업에서 온 이 DB 항목

    def skip_local_new(lp, after):
        """after 바로 뒤에 이어지는 '이 기기에서만 새로 만든' 항목들은 건너뛰어요 (양쪽 모두 끝에 추가했으면 여기 것이 먼저)."""
        w, a = ("parent_id IS NULL", ()) if lp is None else ("parent_id = ?", (lp,))
        if after is None:
            rows = con.execute(f"SELECT id FROM nodes WHERE {w} ORDER BY position, id", a)
        else:
            pos = con.execute("SELECT position FROM nodes WHERE id=?", (after,)).fetchone()[0]
            rows = con.execute(f"SELECT id FROM nodes WHERE {w} AND (position > ? OR (position = ? AND id > ?)) ORDER BY position, id",
                               (*a, pos, pos, after))
        for (i,) in rows:
            if i in known or i in added_ids:
                break
            after = i
        return after

    def get_holder():
        if holder[0] is None:
            mx = con.execute("SELECT MAX(position) FROM nodes WHERE parent_id IS NULL").fetchone()[0]
            text = f"⚠ 합치기 {datetime.now():%Y-%m-%d %H:%M} {label} — 원래 자리가 지워져서 여기로 옮긴 항목"
            holder[0] = con.execute("INSERT INTO nodes(parent_id, position, content) VALUES (NULL,?,?)",
                                    (0 if mx is None else mx + 1, text.strip())).lastrowid
            L[holder[0]] = [None, text, 0]
        return holder[0]

    # 상대 쪽 트리를 부모 → 자식 순서로 (형제는 화면 순서대로)
    order, stack = [], list(reversed(Fk.get(None, [])))
    seen = set()
    while stack:
        f = stack.pop()
        if f in seen:
            continue
        seen.add(f)
        order.append(f)
        stack.extend(reversed(Fk.get(f, [])))
    # 고아(부모가 파일 안에 없는 항목)도 빠짐없이
    order += [f for f in F if f not in seen]

    conflicts = []

    # 1) 글 · 접힘: 공통 백업에 있던 항목
    for bid, (bp, bc, bcol) in B.items():
        if bid not in F:
            continue
        lid = m(bid)
        if lid is None:
            continue
        fc, fcol = F[bid][1], F[bid][2]
        lc, lcol = L[lid][1], L[lid][2]
        if fc != bc:
            if lc == bc:
                con.execute("UPDATE nodes SET content=?, updated_at=CURRENT_TIMESTAMP WHERE id=?", (fc, lid))
                L[lid][1] = fc
                stats["updated"] += 1
            elif lc != fc:
                conflicts.append((lid, fc))
        if fcol != bcol and lcol == bcol:
            con.execute("UPDATE nodes SET collapsed=? WHERE id=?", (fcol, lid))
            L[lid][2] = fcol

    # 2) 이동: 상대 쪽에서 부모나 순서가 바뀌었고, 여기서는 부모를 안 바꾼 항목
    def prev_base(kids_list, idx, x, present):  # x 앞의 형제 중 '양쪽 공통' 항목
        for k in range(idx[x] - 1, -1, -1):
            if kids_list[k] in present:
                return kids_list[k]
        return None
    common = {i for i in B if i in F}
    for fid in order:
        if fid not in common:
            continue
        lid = m(fid)
        if lid is None:
            continue
        bp, fp = B[fid][0], F[fid][0]
        moved_parent = bp != fp
        moved_order = not moved_parent and prev_base(Bk.get(bp, []), Bi, fid, common) != prev_base(Fk.get(fp, []), Fi, fid, common)
        if not (moved_parent or moved_order):
            continue
        exp_lp = None if bp is None else m(bp)
        if bp is not None and exp_lp is None:
            continue
        if L[lid][0] != exp_lp:  # 여기서도 다른 곳으로 옮겼으면 여기 쪽을 따라요
            continue
        if fp is None:
            lp = None
        else:
            lp = resolve(fp)
            if lp is None or inside(lp, lid):
                continue
        after = anchor(fid, lp)
        if after == lid:
            continue
        con.execute("UPDATE nodes SET parent_id=NULL, position=-1 WHERE id=?", (lid,))  # 잠깐 빼고 자리 계산
        L[lid][0] = None
        pos = place(lp, after)
        con.execute("UPDATE nodes SET parent_id=?, position=? WHERE id=?", (lp, pos, lid))
        L[lid][0] = lp
        stats["moved"] += 1

    # 3) 추가: 상대가 새로 만든 항목 + 여기서 지웠지만 상대가 고친 항목(되살림)
    for fid in order:
        fp, fc, fcol = F[fid]
        if fid in B:
            if m(fid) is not None:
                continue
            if fc == B[fid][1]:  # 여기서 지웠고 상대도 안 고침 → 지운 채로
                continue
        if fp is None:
            lp, after = None, None
        else:
            lp = resolve(fp)
            if lp is None:  # 부모가 여기서 지워졌어요 → 맨 아래 '합치기' 항목 안으로
                lp = get_holder()
                stats["orphans"] += 1
                after = holder_last[0]
        if lp is None or lp != holder[0]:
            after = skip_local_new(lp, anchor(fid, lp))
        pos = place(lp, after)
        nid = con.execute("INSERT INTO nodes(parent_id, position, content, collapsed) VALUES (?,?,?,?)",
                          (lp, pos, fc, fcol)).lastrowid
        L[nid] = [lp, fc, fcol]
        newmap[fid] = nid
        added_ids.add(nid)
        if lp is not None and lp == holder[0]:
            holder_last[0] = nid
        stats["added"] += 1

    # 4) 삭제: 상대가 지웠고 여기서는 글을 안 고친 항목. 남길 하위 항목이 있으면 지우지 않아요.
    cands = []
    for bid in B:
        if bid in F:
            continue
        lid = m(bid)
        if lid is None:
            continue
        if L[lid][1] != B[bid][1]:
            stats["kept"] += 1
            continue
        cands.append(lid)
    depth = {}
    def dep(i):
        d, p, g = 0, L[i][0], 0
        while p is not None and g < 100000:
            d, p, g = d + 1, (L[p][0] if p in L else None), g + 1
        return d
    for i in cands:
        depth[i] = dep(i)
    children = {}
    for i, v in L.items():
        children.setdefault(v[0], set()).add(i)
    for i in sorted(cands, key=lambda i: -depth[i]):
        if children.get(i):
            stats["kept"] += 1
            continue
        con.execute("DELETE FROM nodes WHERE id=?", (i,))
        children.get(L[i][0], set()).discard(i)
        del L[i]
        stats["deleted"] += 1

    # 5) 충돌: 여기 글은 그대로, 바로 아래 형제로 상대 버전
    for lid, fc in conflicts:
        if lid not in L:
            continue
        lp = L[lid][0]
        pos = place(lp, lid)
        nid = con.execute("INSERT INTO nodes(parent_id, position, content) VALUES (?,?,?)",
                          (lp, pos, conflict_prefix + fc)).lastrowid
        L[nid] = [lp, conflict_prefix + fc, 0]
        stats["conflicts"] += 1

    return stats
