"""테스트 하나를 리눅스(Ctrl) 기준으로 돌려요 — 맥에서 돌릴 때 run_all.py가 거쳐 가요. 테스트가 스스로 MacIntel로 바꾸는 창은 그대로."""
import runpy, sys
from playwright.sync_api import Browser, BrowserContext
INIT = "Object.defineProperty(navigator, 'platform', { get: () => 'Linux x86_64', configurable: true })"
_np, _nc = Browser.new_page, Browser.new_context
def new_context(self, *a, **k):
    c = _nc(self, *a, **k); c.add_init_script(INIT); return c
def new_page(self, *a, **k):
    c = new_context(self, *a, **k); p = c.new_page(); return p
# 맥 브라우저에서는 Home/End가 줄 처음/끝으로 커서를 옮기지 않아요 (맥은 ⌘←/⌘→) — 리눅스 기준 테스트라 바꿔 눌러요
from playwright.sync_api import Keyboard
_press = Keyboard.press
MAP = {"Home": "Meta+ArrowLeft", "End": "Meta+ArrowRight", "Shift+Home": "Meta+Shift+ArrowLeft", "Shift+End": "Meta+Shift+ArrowRight"}
def press(self, key, *a, **k): return _press(self, MAP.get(key, key), *a, **k)
Keyboard.press = press
# '#항목'으로만 바뀌는 이동은 앞 화면이 잠깐 남아 있어요 → 그 항목 화면이 실제로 그려질 때까지 기다려요
from playwright.sync_api import Page
_goto = Page.goto
WAIT = """async () => { const id = location.hash.slice(1); if (!/^\\d+$/.test(id)) return true;
  const r = await fetch('/api/view?parent=' + id).then((x) => x.json()).catch(() => null);
  return !!r?.node && document.querySelector('#title')?.textContent === r.node.content && !document.getAnimations().some((x) => x.playState === 'running' && x.effect?.target?.closest?.('#tree')); }"""
def goto(self, url, *a, **k):
    r = _goto(self, url, *a, **k)
    if '#' in url:
        try: self.wait_for_function(WAIT, timeout=5000, polling=100)
        except Exception: pass
        try: self.evaluate("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 50))))")
        except Exception: pass
    return r
Page.goto = goto
# 맥 브라우저에서 Ctrl+클릭은 오른쪽 클릭(메뉴)이에요 → 리눅스의 Ctrl+클릭처럼 ⌘+클릭으로 (앱은 리눅스 모드라 ⌘도 Ctrl로 받아요)
from playwright.sync_api import Locator, Mouse
def fixmods(k):
    if k.get('modifiers'): k['modifiers'] = ['Meta' if m in ('Control', 'ControlOrMeta') else m for m in k['modifiers']]
    return k
for cls in (Page, Locator):
    for name in ('click', 'dblclick'):
        orig = getattr(cls, name)
        def wrap(self, *a, _o=orig, **k): return _o(self, *a, **fixmods(k))
        setattr(cls, name, wrap)
Browser.new_context = new_context
Browser.new_page = new_page
sys.argv = sys.argv[1:]
runpy.run_path(sys.argv[0], run_name="__main__")
