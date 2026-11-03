"""테스트를 모두 돌려요: 테스트마다 새 DB로 서버를 띄우고(필요하면 두 개), 결과(PASS/FAIL)를 모아 보여줘요.
사용: python tests/run_all.py [테스트 이름 …]   (playwright · requests · reportlab 필요: pip install playwright requests reportlab && playwright install chromium)
맥에서는 platform_wrap.py를 거쳐 리눅스(Ctrl) 기준으로 돌려요. 실패한 테스트의 전체 출력은 임시 폴더에 남겨요."""
import os, subprocess, sys, tempfile, time, urllib.request, shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = tempfile.mkdtemp(prefix="outliner-tests-")
WRAP = [os.path.join(ROOT, "tests", "platform_wrap.py")] if sys.platform == "darwin" else []
PY = sys.executable
for k in ("NO_PROXY", "no_proxy"): os.environ[k] = ",".join(filter(None, [os.environ.get(k), "127.0.0.1,localhost"]))  # 시스템 프록시가 있어도 앱 서버엔 바로
TWO = {"keys_test.py", "commands_test.py", "dropbox_test.py"}
SELF = {"windows_test.py", "boundary_test.py"}  # 스스로 서버를 켜거나 서버가 필요 없어요


def free(port):  # 앞서 남은 서버가 같은 포트를 쓰고 있으면 끄고 시작해요 (남은 서버에 붙으면 다른 테스트의 데이터가 섞여요)
    out = subprocess.run(["lsof", "-ti", f"tcp:{port}"], capture_output=True, text=True).stdout.split()
    for pid in out: subprocess.run(["kill", pid])
    for _ in range(50):
        if not subprocess.run(["lsof", "-ti", f"tcp:{port}"], capture_output=True, text=True).stdout.strip(): return
        time.sleep(0.1)


def start(port, d):
    free(port)
    env = dict(os.environ, OUTLINER_DB=os.path.join(d, "app.db"), OUTLINER_PORT=str(port), OUTLINER_NO_BROWSER="1")
    p = subprocess.Popen([PY, os.path.join(ROOT, "src/server.py")], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(100):
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/api/ping", timeout=1); return p
        except Exception:
            time.sleep(0.1)
    raise RuntimeError("server did not start")


def run(name):
    d1, d2 = tempfile.mkdtemp(), tempfile.mkdtemp()
    procs = []
    try:
        args = []
        if name not in SELF:
            procs.append(start(5201, d1)); args = ["5201"]
            if name in TWO:
                procs.append(start(5202, d2)); args.append("5202")
        r = subprocess.run([PY, *WRAP, os.path.join(ROOT, "tests", name), *args], capture_output=True, text=True, timeout=600, cwd=ROOT)
        out = r.stdout + r.stderr
    except subprocess.TimeoutExpired as e:
        out = (e.stdout or b"").decode() if isinstance(e.stdout, bytes) else (e.stdout or "") + "\nTIMEOUT"
    finally:
        for p in procs:
            p.terminate()
            try: p.wait(5)
            except Exception: p.kill()
        shutil.rmtree(d1, True); shutil.rmtree(d2, True)
    passes = out.count("PASS ")
    fails = [l for l in out.splitlines() if l.startswith("FAIL") or "Traceback" in l or "Error" in l[:40] or "TIMEOUT" in l]
    return passes, fails, out


names = sys.argv[1:] or sorted(f for f in os.listdir(os.path.join(ROOT, "tests")) if f.endswith("_test.py"))
total_p, bad = 0, {}
for n in names:
    p, f, out = run(n)
    total_p += p
    print(f"{'OK  ' if not f else 'FAIL'} {n}: {p} pass, {len(f)} fail", flush=True)
    if f:
        bad[n] = f
        open(os.path.join(OUT, f"{n}.txt"), "w").write(out)
print(f"\n== {total_p} pass · {sum(len(v) for v in bad.values())} fail in {len(bad)} files" + (f" (출력: {OUT})" if bad else ""))
for n, f in bad.items():
    print(f"-- {n}")
    for l in f[:12]: print("   ", l[:200])
