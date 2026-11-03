// 모두 펼치기 (expand, 예전 ea) — 지금 화면 아래 항목을 모두 펼쳐요
import { command } from './_kit.js';

export default (api) => command(api, { name: 'expand', label: '모두 펼치기 (지금 화면 아래 전부)', make: (api, ui, t) => ({ expand: () => t.setAllCollapsed(false) }) });
