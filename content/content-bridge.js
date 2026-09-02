// ISOLATED world：有 chrome.* 权限，负责：
//   SW / popup 的命令 -> postMessage 给主世界 (content-main.js)
//   主世界的请求(hello)   -> 向 SW 要状态与音频再回传
// 与主世界之间用 window.postMessage + 固定 token 通信。
(() => {
  const TOKEN = 'VMIC_TSINGHUAELT_01';

  function postToMain(d) {
    window.postMessage({ __vmic: TOKEN, to: 'main', ...d }, '*');
  }

  // 收到主世界 hello（首次就绪 / 首次同步竞态兜底）时回推状态与音频
  async function pushState() {
    try {
      const r = await chrome.runtime.sendMessage({ cmd: 'getState' });
      if (r && r.ok) postToMain({ kind: 'state', state: r.state });
    } catch (_) {}
  }

  async function pushAudio() {
    try {
      const r = await chrome.runtime.sendMessage({ cmd: 'getAudio' });
      if (r && r.ok) postToMain({ kind: 'audio', audio: r.audio, mime: r.mime });
    } catch (_) {}
  }

  // 主世界发来 hello（首次就绪 / 首次同步竞态兜底）时，回推最新状态与音频
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.__vmic !== TOKEN || d.to !== 'bridge') return;
    if (d.kind === 'hello') {
      pushState();
      pushAudio();
    }
  });

  // 本脚本加载后主动推一次：防止主世界先于 bridge 执行导致 hello 漏接。
  // （主世界有内容签名去重，重复推送同一文件会被忽略，不会重解码/清状态）
  setTimeout(() => {
    pushState();
    pushAudio();
  }, 60);

  // SW/popup 下发的同步命令
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
