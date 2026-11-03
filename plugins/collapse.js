// 모두 접기 (collapse, 예전 ca) — 지금 화면 아래 하위가 있는 항목을 모두 접어요
import { command } from './_kit.js';

export default (api) => command(api, { name: 'collapse', label: '모두 접기 (지금 화면 아래 전부)', keys: 'Alt+C', make: (api, ui, t) => ({ collapse: () => t.setAllCollapsed(true) }) });
