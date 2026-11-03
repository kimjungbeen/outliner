"""다른 창에서 고쳐 화면을 다시 그려도 재생 중인 영상·오디오가 끊기지 않는지. 사용: python3 tests/media_sync_test.py <앱 포트>"""
import struct, sys, time, requests, subprocess, os, tempfile
from playwright.sync_api import sync_playwright
B=f"http://127.0.0.1:{sys.argv[1]}"
rate=8000; data=b"\x00\x00"*rate*30
wav=b"RIFF"+struct.pack("<I",36+len(data))+b"WAVEfmt "+struct.pack("<IHHIIHH",16,1,1,rate,rate*2,2,16)+b"data"+struct.pack("<I",len(data))+data
au=requests.post(B+"/api/upload",files={"file":("a.wav",wav)}).json()
items=[("audio", au["markdown"])]
d=tempfile.mkdtemp(); mp4=os.path.join(d,"v.webm")
if subprocess.run(["ffmpeg","-y","-f","lavfi","-i","testsrc=size=160x120:rate=10","-t","30","-c:v","libvpx","-b:v","50k",mp4],capture_output=True).returncode==0:
    vi=requests.post(B+"/api/upload",files={"file":("v.webm",open(mp4,"rb").read())}).json(); items.append(("video", vi["markdown"]))
root=requests.post(B+"/api/nodes",json={"parent_id":None,"position":0,"content":"미디어"}).json()["id"]
for k,md in items: requests.post(B+"/api/nodes",json={"parent_id":root,"content":f"{k} {md}"})
with sync_playwright() as p:
    br=p.chromium.launch(args=["--autoplay-policy=no-user-gesture-required"]); pg=br.new_page()
    pg.goto(f"{B}/#{root}"); pg.wait_for_selector("audio", state="attached")  # 기본 audio는 숨기고 앱의 조작부를 써요; pg.wait_for_timeout(800)
    for k,_ in items:
        sel="audio" if k=="audio" else "video"
        pg.evaluate(f"document.querySelector('{sel}').play()"); 
    pg.wait_for_timeout(1500)
    before={k: pg.evaluate(f"(()=>{{const m=document.querySelector('{'audio' if k=='audio' else 'video'}');return [m.paused,m.currentTime]}})()") for k,_ in items}
    for i in range(3):
        requests.post(B+"/api/nodes",json={"parent_id":root,"position":0,"content":f"다른 창 {i}"}); pg.wait_for_timeout(1200)
    after={k: pg.evaluate(f"(()=>{{const m=document.querySelector('{'audio' if k=='audio' else 'video'}');return [m.paused,m.currentTime, document.contains(m)]}})()") for k,_ in items}
    fails=[k for k,_ in items if after[k][0] or not after[k][2] or after[k][1] < before[k][1] + 2]
    for k,_ in items: print(("FAIL " if k in fails else "PASS ")+f"{k}: 다시 그려도 계속 재생 ({before[k][1]:.1f}s → {after[k][1]:.1f}s)")
    print("\n"+("모두 통과" if not fails else f"실패 {len(fails)}개: {fails}"))
    br.close()
sys.exit(1 if fails else 0)
