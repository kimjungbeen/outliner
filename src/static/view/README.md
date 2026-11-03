# view.js — 코드만으로 화면 짜기

SwiftUI처럼 **상태 → 화면** 함수 하나로 웹 화면을 만드는 작은 라이브러리예요. 의존성 없음 · 빌드 없음.
`view.js`와 `view.css` 두 파일만 있으면 어느 웹페이지에서나 써요 (CSS는 JS가 알아서 붙여요). HTML · CSS를 쓰지 않아요 — 모양은 수식어로.

아웃라이너 플러그인에서는 같은 것을 `api.ui`로 써요 (`api.ui.VStack` · `api.ui.sheet` …). 다른 프로젝트에서는 이 폴더를 복사해서 `import` 하면 돼요.

```js
import { mount, VStack, HStack, Text, Button, TextField, Spacer } from './view/view.js';

mount(document.body, { name: '', n: 0 }, (s, set) =>
  VStack({ gap: 12 },
    Text('안녕하세요').font('largeTitle'),
    TextField(s.name, (v) => set({ name: v }), { placeholder: '이름' }),
    HStack(
      Text(`${s.name || '누군가'} · ${s.n}번`).color('mute'),
      Spacer(),
      Button('하나 더', () => set({ n: s.n + 1 })).style('primary'),
    ),
  ).padding(24).frame({ maxWidth: 480 }));
```

- `mount(놓을 곳, 처음 상태, (상태, set) => 뷰)` — `set({ 바뀐 값 })`을 부르면 다시 그려요. **바뀐 곳만** 고쳐서 입력 중인 칸 · 커서 · 재생 중인 소리 · 스크롤은 그대로예요.
- `sheet({ title, state, body: (상태, set, close) => 뷰, task, size: 'auto' | 'wide' | 'full' })` → `close(값)`으로 닫은 값 (Esc · 바깥 = `null`). `task(상태, set)`는 연 뒤 한 번 (불러오기 — SwiftUI의 `.task`).
- `toast(글, 초)` — 아래쪽 알림.
- 데모: [demo.html](demo.html) (아웃라이너를 켜고 `/view/demo.html`).

## 뷰

| 묶음 | 뷰 |
|---|---|
| 배치 | `VStack({ gap, align, justify }, …)` · `HStack({ gap, align, justify, wrap }, …)` · `ZStack` · `Grid({ columns, rows, gap, lines }, …)` · `Spacer()` · `Divider()` · `Section(제목, …)` · `List(목록, (x, i) => 뷰, { empty, selected, onTap, key })` · `ForEach` · `Disclosure(이름, …)` · `Actions(…단추)` |
| 글 | `Text(글)` · `Rich('**굵게** · \`코드\` · 줄바꿈')` · `Marked(['앞', { hit: '찾은 글' }, '뒤'])` · `LabeledValue(이름, 값)` · `Badge` · `Lines([줄])` (미리 보기 줄: `{ text, depth, changed, muted, after, err, num, mark }`) |
| 입력 | `Button(이름, fn).style('primary' \| 'ghost' \| 'plain' \| 'danger' \| 'pill' \| 'tab').size('sm')` · `IconButton(그림, fn, 이름, { filled })` · `Segmented([[값, 이름]], 값, fn)` · `TextField(값, fn, { placeholder, mono, multiline, number, onSubmit, invalid })` · `Toggle(이름, 값, fn)` · `Checkbox` · `Picker([[값, 이름]], 값, fn)` · `ColorWell` · `Swatch(색, fn, { current })` · `Chip(이름, fn)` · `Link(이름, 주소)` |
| 그 밖 | `Image` · `Audio` (다시 그려도 재생 그대로) · `Meter(0~1)` · `Dot(색, { pulse })` · `Spinner` · `Icon(이름 \| svg, { filled })` · `Embed(make, update)` (다른 코드가 그리는 칸 — 지도 · 미리 보기 틀) |

## 수식어 (이어 붙여요)

- 모양: `.padding(n | { x, y, top, … })` · `.frame({ width, height, minWidth, maxWidth, … })` · `.grow()` · `.fill()` (남은 높이) · `.font('largeTitle' | 'title' | 'large' | 'headline' | 'body' | 'callout' | 'caption' | 'mono')` · `.bold()` · `.weight()` · `.color('mute' | 'accent' | 'danger' | 'link' | 'ok' | 색)` · `.background('fill' | 색)` · `.radius('sm' | 'md' | 'lg' | 'pill' | n)` · `.align()` · `.lines(n)` · `.wrap()` · `.opacity()` · `.indent(단계)` · `.scroll(최대 높이)`
- 상태: `.hidden(b)` · `.disabled(b)` · `.selected(b)` · `.tooltip(글)` · `.label(글)` · `.autofocus()` · `.autoselect()` · `.scrollIntoView(b)` · `.revealOnHover()` · `.key(k)` (목록 줄을 알아보는 이름)
- 이벤트: `.onTap(fn)` · `.onHover(fn)` · `.onContextMenu(fn)` · `.event('scroll', fn)`
- 이어 붙이기: `.attr(이름, 값)` (테스트용 `data-*` 등) · `.cls(클래스)` · `.css({ … })` — 다른 CSS와 이을 때만

## 테마

`view.css`의 `--v-*` 변수만 바꾸면 돼요. 밝은 · 어두운 화면은 자동이고, `<html data-theme="light">` · `"dark"`로 고정할 수 있어요.

```css
:root { --v-accent: #0a84ff; --v-inverse: #fff; --v-r-md: 10px; --v-font: "Pretendard", sans-serif; }
```
