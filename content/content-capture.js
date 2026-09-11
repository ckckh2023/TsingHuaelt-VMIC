// ISOLATED world：网页音频捕获模块（独立模块：悬浮控件 + 捕获列表 + 试听 + 入库）
// 职责：
//  扫描: DOM 中的 <audio>/<video>/<source> + Performance 资源时间线里的媒体请求，
//        去重后进入捕获列表（MutationObserver + 定时轮询持续发现新音频）
//  UI:   右下角悬浮球（可拖动，角标显示捕获数）-> 点开 Shadow DOM 面板
//  试听: 经页面侧代理(content-capture-main.js)播放原始 URL，直连扬声器
//  入库: fetch 音频数据 -> base64 -> SW 的 addFileB64 命令写入音频库
//        （复用 file:<id> + list/cur 数据模型，与本地选文件(picker)同一套库）
// 模块边界：与 content-main / content-bridge 无任何消息往来；与页面侧代理用
// 独立 token；对其他模块的互动仅限"输入"——通过 SW 入库命令写入音频库。
(() => {
  'use strict';
  const CAP_TOKEN = 'VMIC_CAPTURE_01'; // 与 content-capture-main.js 约定一致

  // ---------- 小工具（content scripts 不引用 lib/，与现有约定一致） ----------
  const uid = () => (crypto.randomUUID
    ? crypto.randomUUID()
    : 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
  const fmtKB = (n) => (n / 1024).toFixed(0) + ' KB';

  const AUDIO_EXT = new Set([
    'mp3', 'wav', 'm4a', 'aac', 'oga', 'ogg', 'opus',
    'flac', 'webm', 'wma', 'amr', 'mid', 'midi'
  ]);
  const MIME_BY_EXT = {
    mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac',
    ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac',
    webm: 'audio/webm', wma: 'audio/x-ms-wma', amr: 'audio/amr'
  };

  function looksAudio(u) {
    if (/^blob:/i.test(u) || /^data:audio/i.test(u)) return true;
    const m = u.split(/[?#]/)[0].match(/\.([a-z0-9]+)$/i);
    return !!(m && AUDIO_EXT.has(m[1].toLowerCase()));
  }

  function nameOf(u) {
    if (/^blob:/i.test(u)) return 'blob-' + u.slice(-8);
    if (/^data:/i.test(u)) return 'data-' + Math.abs(hashStr(u)).toString(36).slice(0, 6);
    try {
      const p = new URL(u).pathname.split('/').filter(Boolean).pop();
      return p ? decodeURIComponent(p) : 'audio';
    } catch (_) { return 'audio'; }
  }

  function normMime(mime, name) {
    const m = String(mime || '').split(';')[0].trim().toLowerCase();
    if (m.startsWith('audio/')) return m;
    const ext = (name.match(/\.([a-z0-9]+)$/i) || [])[1];
    if (ext && MIME_BY_EXT[ext.toLowerCase()]) return MIME_BY_EXT[ext.toLowerCase()];
    return m || 'audio/mpeg';
  }

  function hashStr(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
    return h;
  }

  // ---------- 捕获列表（url 去重） ----------
  // item: { url, name, src: 'dom'|'net', size, mime, status: idle|busy|added|failed, err }
  const items = new Map(); // url -> item
  let playingUrl = null;   // 当前试听中的 url

  function addItem(url, srcType) {
    if (!url || !/^(https?:|blob:|data:)/i.test(url)) return;
    if (items.has(url)) {
      const it = items.get(url);
      if (srcType === 'dom' && it.src === 'net') it.src = 'dom'; // DOM 确证优先展示
      return;
    }
    items.set(url, {
      url, name: nameOf(url), src: srcType, size: null, mime: '',
      status: 'idle', err: ''
    });
    updateBadge();
    if (panelOpen) renderList();
  }

  function scanDom() {
    const els = document.querySelectorAll('audio, video, audio source, video source');
    for (const el of els) {
      const u = el.currentSrc || el.src || el.getAttribute('src') || '';
      if (u) addItem(u, 'dom');
    }
  }

  function scanPerf() {
    let entries;
    try { entries = performance.getEntriesByType('resource'); } catch (_) { return; }
    for (const en of entries) {
      const it = en.initiatorType;
      const isMedia = it === 'audio' || it === 'video' || it === 'media';
      if (isMedia || looksAudio(en.name)) addItem(en.name, 'net');
    }
  }

  function scanAll() { scanDom(); scanPerf(); updateBadge(); }

  // ---------- 与页面侧代理(content-capture-main.js)通信 ----------
  let reqSeq = 0;
  const pendingFetch = new Map(); // reqId -> resolve

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.__vmicCapture !== CAP_TOKEN || d.to !== 'capture') return;
    if (d.kind === 'fetchAudio' && pendingFetch.has(d.reqId)) {
      const resolve = pendingFetch.get(d.reqId);
      pendingFetch.delete(d.reqId);
      resolve(d);
    }
  });

  // 页面上下文代理 fetch（ISOLATED 直连失败时的回退，覆盖 blob: 等场景）
  function proxyFetch(url) {
    const reqId = ++reqSeq;
    return new Promise((resolve) => {
      pendingFetch.set(reqId, resolve);
      window.postMessage(
        { __vmicCapture: CAP_TOKEN, to: 'main', kind: 'fetchAudio', reqId, url }, '*');
      setTimeout(() => {
        if (pendingFetch.has(reqId)) {
          pendingFetch.delete(reqId);
          resolve({ ok: false, error: '代理请求超时' });
        }
      }, 60000);
    });
  }

  async function fetchAudioData(url) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buf = await res.arrayBuffer();
      return { ok: true, buf, mime: res.headers.get('content-type') || '' };
    } catch (_) {
      const r = await proxyFetch(url);
      return r.ok ? { ok: true, b64: r.b64, mime: r.mime } : { ok: false, error: r.error };
    }
  }

  function preview(url) {
    playingUrl = url || null;
    window.postMessage({ __vmicCapture: CAP_TOKEN, to: 'main', kind: 'preview', url }, '*');
    if (panelOpen) renderList();
  }

  // ---------- 入库（对其他模块的唯一互动点：SW addFileB64） ----------
  function abToB64(buf) {
    const u8 = new Uint8Array(buf);
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < u8.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }

  async function addToLib(item) {
    item.status = 'busy';
    item.err = '';
    renderList();
    try {
      const r = await fetchAudioData(item.url);
      if (!r.ok) throw new Error(r.error || '获取失败');
      const b64 = r.buf ? abToB64(r.buf) : r.b64;
      const mime = normMime(r.mime || item.mime, item.name);
      const resp = await chrome.runtime.sendMessage({
        cmd: 'addFileB64',
        file: { b64, name: item.name, mime, size: Math.floor(b64.length * 3 / 4) }
      });
      if (!resp || !resp.ok) throw new Error((resp && resp.error) || '入库被拒绝');
      item.status = 'added';
      item.size = resp.size || item.size;
    } catch (e) {
      item.status = 'failed';
      item.err = String(e && e.message || e);
    }
    renderList();
  }

  // ---------- 悬浮 UI（Shadow DOM 隔离样式） ----------
  const SRC_LABEL = { dom: '页面元素', net: '网络资源' };
  let host = null;       // <vmic-capture> 固定定位宿主
  let ball = null;       // 悬浮球
  let badge = null;      // 角标
  let panel = null;      // 面板
  let panelOpen = false;
  let listEl = null;

  const CSS = `
    :host {
      all: initial;
      display: block;
      position: fixed; right: 20px; bottom: 20px;
      z-index: 2147483647;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: system-ui, "Segoe UI", "Microsoft YaHei", sans-serif; }
    .ball {
      width: 46px; height: 46px; border-radius: 50%;
      background: #2f6fed; color: #fff; font-size: 22px; line-height: 46px;
      text-align: center; cursor: grab; user-select: none;
      box-shadow: 0 2px 10px rgba(0,0,0,.35); position: relative;
    }
    .ball:active { cursor: grabbing; }
    .badge {
      position: absolute; top: -4px; right: -4px; min-width: 18px; height: 18px;
      border-radius: 9px; background: #e5484d; color: #fff; font-size: 11px;
      line-height: 18px; padding: 0 4px; display: none;
    }
    .badge.on { display: block; }
    .panel {
      position: absolute; left: 0; bottom: 56px; width: 340px;
      background: #20242e; color: #e8eaf0; border-radius: 10px;
      box-shadow: 0 6px 24px rgba(0,0,0,.45); overflow: hidden;
      font-size: 13px; display: none;
    }
    .panel.open { display: block; }
    .hd { display: flex; align-items: center; gap: 6px; padding: 10px 12px;
          background: #292f3c; font-weight: 600; }
    .hd .cnt { color: #9aa4b5; font-weight: 400; }
    .hd .sp { flex: 1; }
    .hd button { background: none; border: none; color: #9aa4b5; font-size: 14px;
                 cursor: pointer; padding: 2px 6px; border-radius: 4px; }
    .hd button:hover { background: #3a4152; color: #fff; }
    ul { list-style: none; max-height: 55vh; overflow: auto; }
    li { padding: 8px 12px; border-bottom: 1px solid #2b3140; }
    li .row { display: flex; align-items: center; gap: 8px; }
    li .nm { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    li .tag { flex: none; font-size: 11px; color: #9aa4b5; border: 1px solid #3a4152;
              border-radius: 4px; padding: 1px 5px; }
    li .sz { flex: none; color: #9aa4b5; font-size: 11px; }
    li .ops { margin-top: 6px; display: flex; gap: 6px; align-items: center; }
    li .ops button {
      border: 1px solid #3a4152; background: #2b3140; color: #e8eaf0;
      border-radius: 5px; padding: 3px 10px; font-size: 12px; cursor: pointer;
    }
    li .ops button:hover:not(:disabled) { background: #3a4152; }
    li .ops button:disabled { opacity: .55; cursor: default; }
    li .ops button.added { border-color: #2f9e63; color: #63d19a; }
    li .err { margin-top: 4px; color: #ff8f8f; font-size: 11px; word-break: break-all; }
    .empty { color: #9aa4b5; padding: 18px 12px; text-align: center; }
    .ft { padding: 7px 12px; color: #8590a3; font-size: 11px; background: #1c202a; }
  `;

  function ensureUI() {
    if (host) return;
    host = document.createElement('vmic-capture');
    const root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);

    panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML =
      '<div class="hd"><span>网页音频捕获</span><span class="cnt"></span><span class="sp"></span>' +
      '<button data-act="refresh" title="重新扫描">刷新</button>' +
      '<button data-act="close" title="收起">✕</button></div>' +
      '<ul></ul>' +
      '<div class="ft">播放网页音频后点刷新即可；入库后可在插件播放列表中管理。</div>';
    root.appendChild(panel);

    ball = document.createElement('div');
    ball.className = 'ball';
    ball.textContent = '♪';
    badge = document.createElement('span');
    badge.className = 'badge';
    ball.appendChild(badge);
    root.appendChild(ball);

    // 悬浮球：拖动 + 点击展开（位移超阈值视为拖动）
    // 拖动移动 host(fixed 定位)本体；panel 相对 host 绝对定位，自动跟随
    let drag = null;
    ball.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const hr = host.getBoundingClientRect();
      drag = { sx: e.clientX, sy: e.clientY, ox: e.clientX - hr.left, oy: e.clientY - hr.top, moved: false };
      ball.setPointerCapture(e.pointerId);
    });
    ball.addEventListener('pointermove', (e) => {
      if (!drag) return;
      if (Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) > 6) drag.moved = true;
      if (!drag.moved) return;
      const x = Math.min(Math.max(0, e.clientX - drag.ox), window.innerWidth - 50);
      const y = Math.min(Math.max(0, e.clientY - drag.oy), window.innerHeight - 50);
      host.style.left = x + 'px';
      host.style.top = y + 'px';
      host.style.right = 'auto';
      host.style.bottom = 'auto';
    });
    ball.addEventListener('pointerup', () => {
      if (drag && !drag.moved) togglePanel();
      drag = null;
    });

    panel.addEventListener('click', (e) => {
      const hd = e.target.closest('.hd button');
      if (hd) {
        if (hd.dataset.act === 'refresh') scanAll();
        if (hd.dataset.act === 'close') togglePanel();
        return;
      }
      const btn = e.target.closest('.ops button');
      if (!btn) return;
      const it = items.get(btn.dataset.url);
      if (!it) return;
      if (btn.dataset.act === 'play') {
        preview(playingUrl === it.url ? null : it.url); // 再点一次即停止
      } else if (btn.dataset.act === 'add' && it.status !== 'busy' && it.status !== 'added') {
        addToLib(it);
      }
    });

    document.documentElement.appendChild(host);
    console.log('[VMIC CAP] 网页音频捕获控件已注入（右下角悬浮球）');
    updateBadge();
  }

  function updateBadge() {
    if (!badge) return;
    const n = items.size;
    badge.textContent = String(n);
    badge.classList.toggle('on', n > 0);
    const cnt = panel && panel.querySelector('.cnt');
    if (cnt) cnt.textContent = n ? '（发现 ' + n + ' 项）' : '';
  }

  function togglePanel() {
    panelOpen = !panelOpen;
    panel.classList.toggle('open', panelOpen);
    if (panelOpen) { scanAll(); renderList(); }
    else if (playingUrl) preview(null); // 收起面板即停试听
  }

  function renderList() {
    if (!listEl) listEl = panel.querySelector('ul');
    listEl.textContent = '';
    updateBadge();
    if (!items.size) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = '未发现音频：先播放网页中的音频，再点刷新';
      listEl.appendChild(li);
      return;
    }
    for (const it of items.values()) {
      const li = document.createElement('li');
      li.dataset.url = it.url;

      const row = document.createElement('div');
      row.className = 'row';
      const nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = it.name;
      nm.title = it.url;
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = SRC_LABEL[it.src] || it.src;
      row.appendChild(nm);
      row.appendChild(tag);
      if (it.size != null) {
        const sz = document.createElement('span');
        sz.className = 'sz';
        sz.textContent = fmtKB(it.size);
        row.appendChild(sz);
      }
      li.appendChild(row);

      const ops = document.createElement('div');
      ops.className = 'ops';
      const play = document.createElement('button');
      play.dataset.act = 'play';
      play.dataset.url = it.url;
      play.textContent = playingUrl === it.url ? '■ 停止' : '▶ 试听';
      const add = document.createElement('button');
      add.dataset.act = 'add';
      add.dataset.url = it.url;
      if (it.status === 'busy') { add.textContent = '获取中…'; add.disabled = true; }
      else if (it.status === 'added') { add.textContent = '✓ 已入库'; add.disabled = true; add.className = 'added'; }
      else if (it.status === 'failed') { add.textContent = '重试入库'; }
      else { add.textContent = '＋ 加入音频库'; }
      ops.appendChild(play);
      ops.appendChild(add);
      li.appendChild(ops);

      if (it.status === 'failed' && it.err) {
        const err = document.createElement('div');
        err.className = 'err';
        err.textContent = '失败：' + it.err + '（跨域受限的资源无法捕获）';
        li.appendChild(err);
      }
      listEl.appendChild(li);
    }
  }

  // ---------- 持续发现新音频 ----------
  const mo = new MutationObserver(() => { scanDom(); updateBadge(); });
  mo.observe(document.documentElement, { childList: true, subtree: true });
  setInterval(() => { scanPerf(); updateBadge(); }, 3000);

  scanAll();
  ensureUI();
})();