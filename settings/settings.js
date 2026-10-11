// 独立整页设置页
const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);
const { debounce } = globalThis.VMIC;

function say(text, ms) {
  $('status').textContent = text;
  if (ms) setTimeout(() => {
    if ($('status').textContent === text) $('status').textContent = '';
  }, ms);
}

async function setState(patch, hint) {
  const r = await send({ cmd: 'setState', patch });
  if (r && r.ok) {
    if (hint) say(hint, 3000);
  } else {
    say('保存失败：' + (r && r.error));
  }
  return r;
}

async function refresh() {
  try {
    const r = await send({ cmd: 'getState' });
    if (!r || !r.ok) return;
    $('enable').checked = !!r.state.enabled;
    $('mode').value = r.state.mode === 'manual' ? 'manual' : 'auto';
    $('delay').value = r.state.delayMs;
    $('delayLabel').textContent = r.state.delayMs + ' ms';
    $('volume').value = Math.round((r.state.volume || 1) * 100);
    $('volLabel').textContent = $('volume').value + '%';
    $('rate').value = Math.round((r.state.playbackRate || 1) * 100);
    $('rateLabel').textContent = $('rate').value + '%';
    const fms = Number(r.state.filterMinSec) || 0;
    $('filterMinOn').checked = fms > 0;
    const fmsDisp = fms > 0 ? fms : 0.5;
    $('filterMin').value = secToSlider(fmsDisp);
    $('filterMinLabel').textContent = fmtSec(fmsDisp);
    $('filterDing').checked = r.state.filterDing !== false;
    syncDelayRow();
    syncNoiseRow();
  } catch (e) {
    say('读取设置失败：' + e);
  }
}

function syncDelayRow() {
  $('delayRow').style.opacity = $('mode').value === 'auto' ? 1 : 0.4;
}

function syncNoiseRow() {
  $('noiseId').disabled = $('noiseRandom').checked;
}

$('enable').addEventListener('change', () => {
  setState({ enabled: $('enable').checked },
    $('enable').checked ? '已启用' : '已停用');
});

$('mode').addEventListener('change', () => {
  setState({ mode: $('mode').value === 'manual' ? 'manual' : 'auto' });
  syncDelayRow();
});

const debouncedSetDelay = debounce((v) => setState({ delayMs: v }), 150);
$('delay').addEventListener('input', () => {
  const v = Number($('delay').value);
  $('delayLabel').textContent = v + ' ms';
  debouncedSetDelay(v);
});

const debouncedSetVolume = debounce((v) => {
  setState({ volume: v });
  send({ cmd: 'transport', op: { action: 'volume', value: v } });
}, 150);
$('volume').addEventListener('input', () => {
  const v = Number($('volume').value) / 100;
  $('volLabel').textContent = Math.round(v * 100) + '%';
  debouncedSetVolume(v);
});

const debouncedSetRate = debounce((v) => {
  setState({ playbackRate: v });
  send({ cmd: 'transport', op: { action: 'playbackRate', value: v } });
}, 150);
$('rate').addEventListener('input', () => {
  const v = Number($('rate').value) / 100;
  $('rateLabel').textContent = Math.round(v * 100) + '%';
  debouncedSetRate(v);
});

function sliderToSec(s) {
  if (s <= 50) return 0.1 + (s / 50) * 0.9;
  return 1 + ((s - 50) / 50) * 29;
}
function secToSlider(sec) {
  if (sec <= 1) return Math.round((sec - 0.1) / 0.9 * 50);
  return Math.round(50 + (sec - 1) / 29 * 50);
}
function fmtSec(sec) {
  return (sec < 10 ? sec.toFixed(1) : String(Math.round(sec))) + ' s';
}

const debouncedSetFilterMin = debounce((v) => setState({ filterMinSec: v }), 150);
$('filterMin').addEventListener('input', () => {
  const sec = sliderToSec(Number($('filterMin').value));
  $('filterMinLabel').textContent = fmtSec(sec);
  if ($('filterMinOn').checked) debouncedSetFilterMin(sec);
});
$('filterMinOn').addEventListener('change', () => {
  if ($('filterMinOn').checked) {
    setState({ filterMinSec: sliderToSec(Number($('filterMin').value)) });
  } else {
    setState({ filterMinSec: 0 });
  }
});
$('filterDing').addEventListener('change', () => {
  setState({ filterDing: $('filterDing').checked },
    $('filterDing').checked ? '已过滤 ding' : '已放行 ding');
});

$('monitor').addEventListener('change', () => {
  const on = $('monitor').checked;
  setState({ monitor: on }, on ? '外放试听已开' : '外放试听已关');
  send({ cmd: 'transport', op: { action: 'monitor', value: on } });
});

$('loop').addEventListener('change', () => {
  const on = $('loop').checked;
  setState({ loop: on });
  send({ cmd: 'transport', op: { action: 'loop', value: on } });
});

$('noiseOn').addEventListener('change', () => {
  setState({ noiseOn: $('noiseOn').checked },
    $('noiseOn').checked ? '噪音覆盖已开' : '噪音覆盖已关');
});
$('noiseRandom').addEventListener('change', () => {
  const on = $('noiseRandom').checked;
  setState({ noiseRandom: on });
  syncNoiseRow();
});
$('noiseId').addEventListener('change', () => {
  setState({ noiseId: $('noiseId').value });
});
const debouncedSetNoiseVol = debounce((v) => {
  setState({ noiseVol: v });
  send({ cmd: 'transport', op: { action: 'noiseVol', value: v } });
}, 150);
$('noiseVol').addEventListener('input', () => {
  const v = Number($('noiseVol').value) / 100;
  $('noiseVolLabel').textContent = Math.round(v * 100) + '%';
  debouncedSetNoiseVol(v);
});

refresh();
