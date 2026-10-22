// 网页音频捕获模块的页面侧代理
(() => {
  'use strict';
  const TOKEN = 'VMIC_CAPTURE_01';
  if (window.__vmicCaptureMain) return; // 防重复注入
  window.__vmicCaptureMain = true;

  let playEl = null; // 试听 <audio>

  function reply(d) {
    window.postMessage({ __vmicCapture: TOKEN, to: 'capture', ...d }, '*');
  }

  window.addEventListener('message', async (e) => {
    const d = e.data;
    if (!d || d.__vmicCapture !== TOKEN || d.to !== 'main') return;

    if (d.kind === 'fetchAudio' && d.reqId && d.url) {
      try {
        const res = await fetch(d.url);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const ab = await res.arrayBuffer();
        reply({
          kind: 'fetchAudio', reqId: d.reqId, ok: true,
          buf: ab, mime: res.headers.get('content-type') || ''
        });
      } catch (err) {
        reply({
          kind: 'fetchAudio', reqId: d.reqId, ok: false,
          error: String((err && err.message) || err)
        });
      }
      return;
    }

    if (d.kind === 'preview') {
      try { if (playEl) { playEl.pause(); playEl.src = ''; } } catch (_) {}
      playEl = null;
      if (d.url) {
        playEl = new Audio(d.url);
        playEl.play().catch(() => {});
      }
      return;
    }
  });
})();