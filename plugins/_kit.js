// 플러그인 명령 하나를 등록하는 틀 — plugins/<명령 이름>.js 마다 이걸로 한 줄씩 등록해요.
// 이름이 _로 시작하는 파일(_kit · _ui · _tools …)은 여러 명령이 같이 쓰는 도구예요 (앱은 명령으로 읽지 않아요).
//
//   export default (api) => command(api, { name: 'sort', label: '순서 바꾸기 (…)', keys: 'Alt+O', make });
//     make(api, ui, t) → { sort() { … } }   — 처음 실행할 때 한 번 만들어요 (ui = api.ui 플러그인 UI 부품, t = _tools.js 도구)
//     keys: 기본 단축키 — 'Alt+알파벳' 하나로 맞춰요 (Mac ⌃C · Windows Alt+C) — Mac 글 칸의 ⌃ 키(A B D E F H K L N O P T V W Y)와 Windows 브라우저가 가로채는 Alt+D · E · F는 빼고. 글자가 모자라 없는 명령도 있어요. ⌘/ 명령 목록에서 바꾸거나 지울 수 있어요
//     preload: 실행 전에 지금 화면 아래 항목을 모두 불러올까요 (앱은 보이는 것만 불러와요) — 화면 아래를 훑는 명령이면 true(기본)
//     selection: 항목을 고르면 아래 선택 막대에 뜰 단추 글 ('합치기') · selectionMin: 몇 개 이상 골랐을 때 (기본 1)
//     tag: true면 글 속 태그를 누를 때 불러요 (여럿이면 명령 이름 메뉴). 누른 태그가 첫 인자로 와요
//     text: 글자를 고르면 뜨는 글자 메뉴의 단추 { label, title, style, group, order, active(ctx), render(ctx), marks } — app.js fmtBar
import makeTools from './_tools.js';

export function command(api, { name, label = '', keys, preload = true, selection, selectionMin, text, tag, make }) {
  let impl = null;
  api.commands.add([{
    name, label, keys, selection, selectionMin, text, tag,
    run: async (...args) => { // args: api.commands.run(name, …) 로 넘긴 것 (단축키 · 명령 목록에서는 없어요)
      if (preload) await api.nodes.loadSubtree(api.view.zoomId());
      impl ??= make(api, api.ui, makeTools(api));
      return impl[name](...args);
    },
  }]);
}
