// 홈 (home) — 맨 위 화면으로
import { command } from './_kit.js';

export default (api) => command(api, { name: 'home', label: '홈으로 (맨 위 화면)', preload: false, make: (api) => ({ home: () => api.view.zoomId() !== null && api.view.zoomTo(null) }) });
