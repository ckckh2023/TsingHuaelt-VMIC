// 通信模块
(() => {
  const TOKEN = 'VMIC_TSINGHUAELT_01';

  function postToMain(d) {
    window.postMessage({ __vmic: TOKEN, to: 'main', ...d }, '*');
  }

  async function pushState() {
    try {
      const r = await chrome.runtime.sendMessage({ cmd: 'getState' });
      if (r && r.ok) postToMain({ kind: 'state', state: r.state });
    } catch (e) { console.warn('[VMIC] bridge pushState 失败:', e); }
  }

  async function pushAudio() {
    try {
      const r = await chrome.runtime.sendMessage({ cmd: 'getAudio' });
      if (r && r.ok) postToMain({ kind: 'audio', audio: r.audio, mime: r.mime });
    } catch (e) { console.warn('[VMIC] bridge pushAudio 失败:', e); }
  }

  async function pushNoise(name) {
    try {
      const r = await chrome.runtime.sendMessage({ cmd: 'getNoise', name });
      if (r && r.ok) postToMain({ kind: 'noise', name, audio: r.audio, mime: r.mime });
    } catch (e) { console.warn('[VMIC] bridge pushNoise 失败:', e); }
  }

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.__vmic !== TOKEN || d.to !== 'bridge') return;
    if (d.kind === 'hello') {
      pushState();
      pushAudio();
    }
    if (d.kind === 'getNoise' && d.name) pushNoise(d.name);
  });

  setTimeout(() => {
    pushState();
    pushAudio();
  }, 60);

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.cmd !== 'pageSync') return;
    const payload = {};
    if (msg.state) payload.state = msg.state;
    if (msg.audio !== undefined) payload.audio = msg.audio;
    if (msg.mime) payload.mime = msg.mime;
    if (msg.clearAudio) payload.clearAudio = true;
    if (msg.transport) payload.transport = msg.transport;
    postToMain({ kind: 'sync', ...payload });
  });
})();
