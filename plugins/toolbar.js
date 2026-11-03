// 보조 키 (toolbar, 예전 mobile-keys) — 터치 화면 아래쪽 보조 키 배치를 Termux extra-keys 형식 그대로 고쳐요
// 줄마다 [ ] 하나 · 키 이름 또는 글자 하나 · {"key": "-", "popup": "|"} (popup = 키를 위로 밀었을 때)
import { command } from './_kit.js';

export default (api) => command(api, {
  name: 'toolbar', label: '모바일 보조 키 배치 바꾸기 (Termux extra-keys 형식)', preload: false,
  make: (api) => ({
    async toolbar() {
      const now = api.mobile.layout();
      if (!now) return api.ui.toast('터치 화면에서만 보조 키가 있어요 (주소 뒤에 ?mobile을 붙이면 보여요)');
      const r = await api.ui.ask('모바일 보조 키 배치', JSON.stringify(now).replace(/\],\[/g, '],\n['),
        [{ label: '기본값', value: 'reset' }, { label: '취소', value: null }, { label: '저장', value: 'save', primary: true }],
        `줄마다 [ ] 하나 · 키 이름 또는 글자 하나 · {"key": "-", "popup": "|"} (popup = 키를 위로 밀었을 때)\n키 이름: ${api.mobile.keyNames().join(' · ')}`);
      if (!r) return;
      let next = null;
      if (r.action === 'save') { try { next = JSON.parse(r.text); } catch (err) { return api.ui.toast(`형식이 맞지 않아요: ${err.message}`, 5, true); } }
      const err = api.mobile.setLayout(next);
      if (err) return api.ui.toast(err, 5, true);
      api.ui.toast(next === null ? '기본 배치로 돌렸어요' : '보조 키 배치를 저장했어요');
    },
  }),
});
