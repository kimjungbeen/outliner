// 예시 플러그인
//  - "[ ] " 또는 "[x] "로 시작하는 항목에 체크박스를 붙입니다.
//  - Alt+T: 체크박스 켜고 끄기 / Alt+D: 오늘 날짜 넣기
const CHECK = /^\[( |x)\] /;

export default function (api) {
  api.decorate(({ node, prefix, text }) => {
    const m = CHECK.exec(node.content);
    if (!m) return;
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = m[1] === 'x';
    box.tabIndex = -1;
    box.addEventListener('change', () =>
      api.updateNode(node.id, { content: (box.checked ? '[x] ' : '[ ] ') + node.content.slice(4) }));
    prefix.appendChild(box);
    text.classList.toggle('done', box.checked);
  });

  api.addCommand({
    keys: 'Alt+T',
    label: '체크박스 켜고 끄기',
    run: ({ node }) => {
      const next = CHECK.test(node.content) ? node.content.slice(4) : '[ ] ' + node.content;
      api.updateNode(node.id, { content: next }).then(() => api.focus(node.id, 'end'));
    },
  });

  api.addCommand({
    keys: 'Alt+D',
    label: '오늘 날짜 넣기',
    run: ({ node }) => {
      const today = new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD
      api.updateNode(node.id, { content: (node.content + ' ' + today).trim() }).then(() => api.focus(node.id, 'end'));
    },
  });
}
