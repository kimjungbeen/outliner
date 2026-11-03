// 녹음 — 명령 이름 record (기본 단축키 없음 — ⌘/에서 지정)
// 마이크로 녹음해 mp3를 만들고, 커서 항목 아래에 오디오 첨부로 넣어요 (넣은 뒤에는 다른 오디오와 같아요: 플레이어 · 구간 반복 · 북마크).
// 녹음 중: 걸린 시간 · 소리 크기 막대 · 일시정지/이어서 · 끝내기. 끝내면 미리 듣고 이름을 정해 '넣기', 또는 '다시 녹음' · '버리기'.
// mp3는 브라우저 안에서 바로 만들어요 (lamejs — src/static/vendor/lamejs, LGPL-3.0, api.vendor로 불러요): 서버나 다른 프로그램이 필요 없고, 녹음하는 동안 조금씩 만들어 두어 끝내면 바로 들을 수 있어요.
// 녹음 중에는 바깥을 눌러도 창이 닫히지 않아요. Esc는 묻고 닫아요. 음질(64 · 96 · 128 kbps)은 기억해요.
import { command } from './_kit.js';

const RATES = [[64, '64 kbps · 작게'], [96, '96 kbps · 말'], [128, '128 kbps · 음악']];
// 마이크 소리를 128샘플씩 받아 오는 작은 처리기 (여러 채널이면 섞어 모노로)
const TAP = `registerProcessor('outliner-rec-tap', class extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0];
    if (ch && ch.length && ch[0].length) {
      const n = ch[0].length, m = new Float32Array(n);
      for (const c of ch) for (let i = 0; i < n; i++) m[i] += c[i] / ch.length;
      this.port.postMessage(m, [m.buffer]);
    }
    return true;
  }
});`;
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const stamp = () => { const d = new Date(), p = (n) => String(n).padStart(2, '0'); return `녹음 ${d.toLocaleDateString('sv-SE')} ${p(d.getHours())}-${p(d.getMinutes())}`; };
export default (api) => command(api, { name: 'record', preload: false, label: '녹음 (마이크로 녹음해 mp3로 커서 항목 아래에 넣기)', make: (api, ui) => ({ record: () => record(api, ui) }) });

async function record(api, ui) {
  if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) return api.ui.toast('이 브라우저에서는 녹음할 수 없어요', 4);
  const last = (await api.storage.get('last').catch(() => null)) || {};
  let kbps = RATES.some(([v]) => v === last.kbps) ? last.kbps : 96;
  const lamejs = api.vendor('lamejs/lamejs.js'); // 창을 여는 동안 미리 불러요

  const { VStack, HStack, Text, Button, Segmented, Meter, Dot, Audio, TextField, Actions } = ui;
  let m = null; // 창의 { state, set } — 녹음 처리기에서 화면을 고쳐요
  const show = (patch) => m?.set(patch);

  // ---- 녹음 ----
  let stream = null, ctx = null, node = null, enc = null, chunks = [], pend = [], pendN = 0, samples = 0, rate = 48000, level = 0, raf = 0;
  let phase = 'idle', blob = null, url = null; // idle → rec ⇄ paused → done
  const BLOCK = 1152 * 8;
  const encodePending = (all = false) => { // 모아 둔 소리를 mp3로 (조금씩)
    if (!enc || (!all && pendN < BLOCK)) return;
    const pcm = new Int16Array(pendN);
    let k = 0;
    for (const a of pend) for (let i = 0; i < a.length; i++) { const v = Math.max(-1, Math.min(1, a[i])); pcm[k++] = v < 0 ? v * 0x8000 : v * 0x7fff; }
    pend = []; pendN = 0;
    for (let i = 0; i < pcm.length; i += 1152) { const out = enc.encodeBuffer(pcm.subarray(i, i + 1152)); if (out.length) chunks.push(out); }
  };
  const paintMeter = () => { show({ level: Math.min(1, Math.sqrt(level) * 1.4) }); level *= 0.85; raf = requestAnimationFrame(paintMeter); };
  async function start() {
    try {
      const { Mp3Encoder } = await lamejs;
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      ctx = new AudioContext();
      rate = ctx.sampleRate;
      enc = new Mp3Encoder(1, rate, m.state.kbps);
      const src = URL.createObjectURL(new Blob([TAP], { type: 'text/javascript' }));
      await ctx.audioWorklet.addModule(src); URL.revokeObjectURL(src);
      node = new AudioWorkletNode(ctx, 'outliner-rec-tap');
      node.port.onmessage = (e) => {
        const m = e.data;
        let sum = 0; for (let i = 0; i < m.length; i++) sum += m[i] * m[i];
        level = Math.max(level, sum / m.length);
        if (phase !== 'rec') return;
        pend.push(m); pendN += m.length; samples += m.length;
        encodePending();
        show({ time: fmt(samples / rate) });
      };
      const mute = ctx.createGain(); mute.gain.value = 0; // 처리기가 계속 돌도록 이어만 두고 소리는 내지 않아요
      ctx.createMediaStreamSource(stream).connect(node); node.connect(mute); mute.connect(ctx.destination);
      api.storage.set('last', { kbps: m.state.kbps }).catch(() => {});
      setPhase('rec');
      paintMeter();
    } catch (e) {
      stopMic();
      api.ui.toast(/denied|NotAllowed|Permission/i.test(`${e?.name} ${e?.message}`) ? '마이크를 쓸 수 없어요 — 브라우저 주소창의 권한에서 마이크를 허용해 주세요' : `녹음을 시작하지 못했어요: ${e?.message ?? e}`, 6);
    }
  }
  function stopMic() {
    cancelAnimationFrame(raf);
    stream?.getTracks().forEach((t) => t.stop());
    ctx?.close().catch(() => {});
    stream = ctx = node = null;
  }
  function finish() {
    encodePending(true);
    const tail = enc.flush(); if (tail.length) chunks.push(tail);
    stopMic();
    blob = new Blob(chunks, { type: 'audio/mpeg' });
    if (url) URL.revokeObjectURL(url);
    url = URL.createObjectURL(blob);
    setPhase('done', { url, name: stamp(), info: `${fmt(samples / rate)} · ${(blob.size / 1048576).toFixed(blob.size < 1048576 ? 2 : 1)} MB · mp3 ${m.state.kbps} kbps` });
  }
  function reset() { chunks = []; pend = []; pendN = 0; samples = 0; blob = null; show({ time: '0:00', level: 0, url: null }); }

  function setPhase(p, extra = {}) { phase = p; show({ phase: p, ...extra }); }
  const busy = () => phase === 'rec' || phase === 'paused' || (phase === 'done' && blob);
  const HINT = { idle: '녹음 버튼을 누르면 시작해요 (Enter)', rec: '녹음 중 — Space: 일시정지', paused: '일시정지 — Space: 이어서' };

  const res = await ui.sheet({
    title: '녹음', outside: false, // 녹음 중 바깥을 잘못 눌러도 잃지 않게
    state: { phase: 'idle', kbps, time: '0:00', level: 0, url: null, name: '', info: '' },
    task: (s, set) => { m = { state: s, set }; },
    body: (s, set, close) => VStack({ gap: 14 },
      s.phase !== 'done'
        ? VStack({ gap: 14, align: 'center' },
            Text(s.time).font('largeTitle').css({ fontSize: '2.4rem', fontVariantNumeric: 'tabular-nums' }).attr('data-f', 'time'),
            HStack({ gap: 7 }, s.phase !== 'idle' && Dot(s.phase === 'rec' ? 'danger' : 'mute', { pulse: s.phase === 'rec' }), Text(HINT[s.phase]).font('callout').color('mute')),
            s.phase !== 'idle' && Meter(s.level).frame({ width: '100%' }).attr('data-f', 'meter'),
            s.phase === 'idle' && Segmented(RATES, s.kbps, (v) => set({ kbps: v })).attr('data-f', 'rate'),
          ).attr('data-f', 'rec').attr('data-phase', s.phase)
        : VStack({ gap: 10, align: 'stretch' }, // 끝낸 뒤: 미리 듣기 · 이름
            Audio(s.url),
            TextField(s.name, (v) => set({ name: v }), { placeholder: '이름', onSubmit: () => close('save') }).autoselect().attr('data-f', 'name'),
            Text(s.info).font('caption').attr('data-f', 'size'),
          ),
      Actions({
        idle: [Button('취소', () => close(null)), Button('● 녹음', start).style('danger').autofocus()],
        rec: [Button('일시정지', () => setPhase('paused')), Button('■ 끝내기', finish).style('primary').autofocus()],
        paused: [Button('이어서', () => setPhase('rec')), Button('■ 끝내기', finish).style('primary').autofocus()],
        done: [Button('버리기', async () => { if (await ui.confirmDelete('이 녹음', '아직 넣지 않았어요')) close(null); }), Button('다시 녹음', () => { reset(); setPhase('idle'); }), Button('넣기', () => close('save')).style('primary')],
      }[s.phase]),
    ),
    onKey: (e, s, set, c) => {
      if (e.isComposing) return false;
      if (e.key === 'Escape') { // 녹음한 게 있으면 묻고 닫아요
        e.preventDefault(); e.stopPropagation();
        if (!busy()) { c(null); return true; }
        ui.confirmDelete('이 녹음', '창을 닫으면 녹음이 사라져요').then((ok) => ok && c(null));
        return true;
      }
      if (e.key === ' ' && (phase === 'rec' || phase === 'paused')) { e.preventDefault(); e.stopPropagation(); setPhase(phase === 'rec' ? 'paused' : 'rec'); return true; } // 단추에 커서가 있어도 Space는 일시정지 (끝내기가 눌리지 않게)
      return false;
    },
  });
  stopMic();
  if (res !== 'save' || !blob) { if (url) URL.revokeObjectURL(url); return; }
  try {
    await api.view.flush();
    const file = `${(m.state.name.trim() || stamp()).replace(/[\\/:*?"<>|]/g, '-')}.mp3`;
    const r = await api.files.upload(blob, file);
    await api.files.insert([r.markdown]);
    api.ui.toast(`녹음을 넣었어요 · ${file}`);
  } catch (e) {
    api.ui.toast(`녹음을 넣지 못했어요: ${e.message}`, 5);
  } finally { if (url) URL.revokeObjectURL(url); }
}
