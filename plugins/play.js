// 전체 재생 (play) — 커서 항목(없으면 지금 화면) 아래의 오디오 · 영상을 화면 순서대로 아래 재생 막대에서 이어 재생
import { command } from './_kit.js';

export default (api) => command(api, { name: 'play', label: '하위 오디오 · 영상 전체 재생 (커서 항목, 없으면 지금 화면)', preload: false, make: (api) => ({ play: () => api.files.playUnder(false) }) });
