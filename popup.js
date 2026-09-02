const $ = (id) => document.getElementById(id);

function send(msg) { return chrome.runtime.sendMessage(msg); }

async function refresh() {
  try {
    const r = await send({ cmd: 'getState' });
    if (!r || !r.ok) return;
    $('enable').checked = !!r.state.enabled;
    $('delay').value = r.state.delayMs;
    $('delayLabel').textContent = r.state.delayMs + ' ms';
    $('volume').value = Math.round((r.state.volume || 1) * 100);
    $('volLabel').textContent = $('volume').value + '%';
    $('mode').value = r.state.mode === 'manual' ? 'manual' : 'auto';
    $('monitor').checked = r.state.monitor !== false;
    $('loop').checked = !!r.state.loop;
    $('delayRow').style.opacity = r.state.mode === 'auto' ? 1 : 0.4;

    const a = await send({ cmd: 'audioInfo' });
    if (a && a.ok) {
      $('fileInfo').textContent = a.size > 0
        ? '已载入：' + (a.size / 1024).toFixed(0) + ' KB（' + (a.mime || 'audio/mpeg') + '）'
        : '未选择音频';
    }
    $('status').textContent = '';
  } catch (e) {
    $('status').textContent = '刷新失败：' + e;
  }
}

async function setState(patch) {
  const r = await send({ cmd: 'setState', patch });
  if (!r || !r.ok) $('status').textContent = '设置失败：' + (r && r.error);
  return r;
}

function say(text, ms) {
  $('status').textContent = text;
  if (ms) setTimeout(() => { if ($('status').textContent === text) $('status').textContent = ''; }, ms);
}

$('enable').addEventListener('change', () => {
  setState({ enabled: $('enable').checked });
  say($('enable').checked
    ? '已启用：该站录音只能拿到插件音频（建议刷新一次页面后 100% 生效）'
    : '已停用：页面走真实麦克风', 5000);
});

$('btnPick').addEventListener('click', () => {
  // 打开整页设置页选文件（弹窗里的文件选择器会因失焦被 Chrome 关闭导致上传失败）
  chrome.runtime.openOptionsPage();
});

$('delay').addEventListener('input', () => {
  const v = Number($('delay').value);
  $('delayLabel').textContent = v + ' ms';
  setState({ delayMs: v });
});

$('volume').addEventListener('input', () => {
  const v = Number($('volume').value) / 100;
  $('volLabel').textContent = Math.round(v * 100) + '%';
  setState({ volume: v });
  send({ cmd: 'transport', op: { action: 'volume', value: v } });
});

$('monitor').addEventListener('change', () => {
  setState({ monitor: $('monitor').checked });
  send({ cmd: 'transport', op: { action: 'monitor', value: $('monitor').checked } });
  say($('monitor').checked ? '外放试听已开：录音时会从扬声器听到' : '外放试听已关', 4000);
});

$('loop').addEventListener('change', () => {
  setState({ loop: $('loop').checked });
  send({ cmd: 'transport', op: { action: 'loop', value: $('loop').checked } });
});

$('mode').addEventListener('change', () => {
  const manual = $('mode').value === 'manual';
  setState({ mode: manual ? 'manual' : 'auto' });
  $('delayRow').style.opacity = manual ? 0.4 : 1;
});

$('btnPlay').addEventListener('click', async () => {
  await send({ cmd: 'transport', op: { action: 'play' } });
  say('已发送播放指令。若仍无声：请先在页面上点一下任意位置（授权播放），再点播放', 6000);
});
$('btnPause').addEventListener('click', () => send({ cmd: 'transport', op: { action: 'pause' } }));
$('btnRestart').addEventListener('click', () => {
  send({ cmd: 'transport', op: { action: 'restart' } });
  say('已重播', 2000);
});

refresh();
