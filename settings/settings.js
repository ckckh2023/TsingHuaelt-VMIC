// 独立整页设置页（manifest options_ui）：启用开关、模式/延时、音量/试听/循环。
// 所有改动即时 setState 持久到 storage.session，并广播给已打开的评测页面。
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
    $('monitor').checked = r.state.monitor !== false;
    $('loop').checked = !!r.state.loop;
    syncDelayRow();
  } catch (e) {
    say('读取设置失败：' + e);
  }
}

function syncDelayRow() {
  $('delayRow').style.opacity = $('mode').value === 'auto' ? 1 : 0.4;
}

$('enable').addEventListener('change', () => {
  setState({ enabled: $('enable').checked },
    $('enable').checked ? '已启用：该站录音只能拿到插件音频' : '已停用：页面走真实麦克风');
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

$('monitor').addEventListener('change', () => {
  const on = $('monitor').checked;
  setState({ monitor: on }, on ? '外放试听已开：录音时会从扬声器听到' : '外放试听已关');
  send({ cmd: 'transport', op: { action: 'monitor', value: on } });
});

$('loop').addEventListener('change', () => {
  const on = $('loop').checked;
  setState({ loop: on });
  send({ cmd: 'transport', op: { action: 'loop', value: on } });
});

refresh();
