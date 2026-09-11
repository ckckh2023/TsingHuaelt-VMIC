// MAIN world：网页音频捕获模块的"页面侧代理"（独立于 content-main 的捕获专用桥）
// 职责只有两个，均由 ISOLATED world 的 content-capture.js 通过 postMessage 触发：
//  1) fetch 代理：在页面自身上下文里抓音频 -> base64 回传
//     （ISOLATED world fetch 页面 blob: URL 在部分 Chrome 版本受限，页面上下文最稳）
//  2) 试听代理：用页面环境 new Audio(url) 播/停（直连扬声器，不进任何音频图，
//     不产生 MediaStream，与站点的录音/评测完全隔离）
// 与 content-main.js / content-bridge.js 完全独立：独立 token，不共享任何状态。
(() => {
  'use strict';
  const TOKEN = 'VMIC_CAPTURE_01';
  if (window.__vmicCaptureMain) return; // 防重复注入
  window.__vmicCaptureMain = true;

  let playEl = null; // 试听 <audio>（单实例，播放新条目时替换旧的）

  // ArrayBuffer -> base64（postMessage 虽可结构化克隆 ArrayBuffer，但统一走
  // base64 字符串与本扩展"跨上下文只传 JSON 安全数据"的约定保持一致）
  function abToB64(buf) {
    const u8 = new Uint8Array(buf);
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < u8.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }

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
          b64: abToB64(ab), mime: res.headers.get('content-type') || ''
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
      try { if (playEl) { playEl.pause(); playEl.removeAttribute('src'); } } catch (_) {}
      playEl = null;
      if (d.url) { // 仅传 stop 时不带 url
        playEl = new Audio(d.url);
        playEl.play().catch(() => {});
      }
      return;
    }
  });
})();