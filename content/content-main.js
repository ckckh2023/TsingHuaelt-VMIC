// MAIN world：本扩展的"心脏" v0.2
// 引擎改为 AudioContext 方案，解决 v0.1 两个问题：
//  1) <audio>.play() 受自动播放策略限制 + 消息触发无声  -> 改用 AudioContext，
//     播放/监听走 WebAudio，站点手势或页面点击后必定有声
//  2) captureStream 依赖元素加载完成，未就绪返回的流可能无音频轨，
//     导致站点 createMediaStreamSource 报"无麦克风/权限错误"
//     -> 改为 decodeAudioData 解码后由 MediaStreamDestination 出流，
//        音频轨恒存在，且支持"外放试听"(录到哪一路就听到哪一路)
//
// 三模块:
//  输入: bridge 转来的本地音频(ArrayBuffer) -> decodeAudioData 成 AudioBuffer
//  处理: BufferSource -> recGain(音量) -> MediaStreamDestination(伪装麦克风)
//        BufferSource -> monGain(试听) -> ctx.destination(扬声器, 可开关)
//  输出: 包装 getUserMedia/enumerateDevices，启用时纯音频请求只能拿到伪流
(() => {
  'use strict';
  const TOKEN = 'VMIC_TSINGHUAELT_01';

  const state = {
    enabled: false,    // 注入开关
    delayMs: 800,      // 自动模式: 伪流创建后多少 ms 再出声(对齐倒计时)
    volume: 1,         // 录音/试听共用音量
    monitor: true,     // 外放试听(扬声器可听到正在录的声音)
    loop: false,       // 循环播放
    mode: 'auto',      // auto | manual
    audioSig: ''       // 当前文件源的内容签名(用于幂等去重, 不与页面状态混淆)
  };

  let ctx = null;              // 共享 AudioContext(全站只建一个)
  let audioRaw = null;         // 原始 ArrayBuffer
  let audioBuffer = null;      // 解码后的 AudioBuffer
  let decodeDone = true;       // 当前 audioRaw 是否已解码完成(成功/失败都置 true)
  let everSynced = false;      // 是否已收到过 bridge 的首次同步(之后不再主动拉文件)

  // 当前"录音会话"图: src -> recGain -> dest(伪麦流) ; src -> monGain -> speakers
  let recSrc = null;
  let recDest = null;
  let recGain = null;
  let monGain = null;

  const clampVol = (v) => Math.min(1, Math.max(0, Number(v) || 0));

  // ---------- AudioContext 生命周期 ----------
  function ensureCtx() {
    if (!ctx) {
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        ctx = new AC();
      } catch (e) {
        console.error('[VMIC] 创建 AudioContext 失败:', e);
        return null;
      }
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }

  // 页面上任意点击/按键都可能来自站点录音按钮 -> 趁机恢复 ctx(自动播放策略规避)
  function hookGestures() {
    const resume = () => { if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {}); };
    document.addEventListener('pointerdown', resume, true);
    document.addEventListener('keydown', resume, true);
  }

  // ---------- 与 isolated 世界(bridge)通信 ----------
  function postToBridge(d) {
    window.postMessage({ __vmic: TOKEN, to: 'bridge', ...d }, '*');
  }

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.__vmic !== TOKEN || d.to !== 'main') return;
    if (d.kind === 'state' && d.state) { applyState(d.state); everSynced = true; }
    if (d.kind === 'audio' && d.audio !== undefined) { setAudioData(d.audio); everSynced = true; }
    if (d.kind === 'sync') {
      if (d.state) { applyState(d.state); everSynced = true; }
      if (d.audio !== undefined) { setAudioData(d.audio); everSynced = true; }
      if (d.transport) doTransport(d.transport);
    }
  });

  function applyState(patch) {
    const prev = { ...state };
    Object.assign(state, patch || {});
    if (state.enabled === false && prev.enabled === true) stopRec(); // 关闭注入即停
    applyVolume();
  }

  // ---------- 输入模块: 解码本地音频 ----------
  // 幂等保证(核心原则: 只有用户主动换文件, 文件源才会更新):
  //  1) 同一份文件(内容签名相同)重复推送 -> 直接忽略, 不重解码、不清状态
  //  2) 收到空/非法数据时, 若已有文件 -> 保持现状, 绝不清空文件源
  //  3) 页面自身不在录音流程里主动拉取/改写文件(见 ensureReady)
  async function hashBuf(buf) {
    try {
      const h = await crypto.subtle.digest('SHA-256', buf);
      return Array.from(new Uint8Array(h)).slice(0, 8)
        .map((b) => b.toString(16).padStart(2, '0')).join('');
    } catch (_) {
      return null; // 极少数无 crypto.subtle 的环境, 退化为不去重(仍安全)
    }
  }

  async function setAudioData(b64) {
    // 消息传递只传 JSON 安全的 base64 字符串, 这里先解码回 ArrayBuffer
    let buf = null;
    if (typeof b64 === 'string' && b64) {
      try {
        const bin = atob(b64);
        const u8 = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        buf = u8.buffer;
      } catch (e) {
        console.warn('[VMIC] base64 解码失败:', e);
      }
    }
    if (!buf || !buf.byteLength) {
      if (audioRaw) {
        // 已有文件源时收到空/非法数据: 忽略, 绝不清空(防瞬时空推送)
        console.warn('[VMIC] 收到空/非法音频数据, 已忽略并保留当前文件源');
        return;
      }
      audioRaw = null;
      audioBuffer = null;
      decodeDone = true;
      return;
    }
    const sig = await hashBuf(buf);
    if (audioRaw && sig && sig === state.audioSig) return; // 同一文件源, 不动
    state.audioSig = sig || '';

    audioRaw = buf;
    audioBuffer = null;
    decodeDone = false;
    try {
      const c = ensureCtx();
      if (!c) { decodeDone = true; return; }
      const snapshot = buf;
      c.decodeAudioData(buf.slice(0)).then((ab) => {
        if (audioRaw === snapshot) { audioBuffer = ab; decodeDone = true; }
      }).catch((e) => {
        console.error('[VMIC] 音频解码失败(请换 mp3/wav):', e);
        decodeDone = true;
      });
    } catch (e) {
      console.error('[VMIC] 解码流程异常:', e);
      decodeDone = true;
    }
  }

  // ---------- 处理模块: 建图(伪麦流 + 可选试听) ----------
  function stopRec() {
    if (recSrc) {
      try { if (recSrc.__started) recSrc.stop(); } catch (_) {}
      try { recSrc.disconnect(); } catch (_) {}
      recSrc = null;
    }
    if (recGain) { try { recGain.disconnect(); } catch (_) {} recGain = null; }
    if (monGain) { try { monGain.disconnect(); } catch (_) {} monGain = null; }
    if (recDest) { try { recDest.disconnect(); } catch (_) {} recDest = null; }
  }

  function startRecGraph() {
    stopRec();
    const c = ensureCtx();
    if (!c || !audioBuffer) return null;

    recDest = c.createMediaStreamDestination();      // -> 伪装麦克风
    recGain = c.createGain();
    recGain.gain.value = clampVol(state.volume);
    recGain.connect(recDest);

    monGain = c.createGain();                         // -> 扬声器试听
    monGain.gain.value = state.monitor ? clampVol(state.volume) : 0;
    monGain.connect(c.destination);

    recSrc = c.createBufferSource();
    recSrc.buffer = audioBuffer;
    recSrc.loop = !!state.loop;
    recSrc.__started = false;
    recSrc.connect(recGain);
    recSrc.connect(monGain); // 常连, 用增益 0 关断, 避免开关瞬间爆音

    return { src: recSrc, dest: recDest };
  }

  function playNow(delayMs) {
    const c = ctx;
    if (!c || !recSrc || recSrc.__started) return false;
    const t = c.currentTime + (Math.max(0, Number(delayMs) || 0)) / 1000;
    try {
      recSrc.start(t);
      recSrc.__started = true;
      return true;
    } catch (e) {
      console.error('[VMIC] 播放启动失败:', e);
      return false;
    }
  }

  function makeSilentStream() {
    const c = ensureCtx();
    if (!c) return null; // 调用方兜底
    if (c.state === 'suspended') c.resume().catch(() => {});
    return c.createMediaStreamDestination().stream;
  }

  function applyVolume() {
    const v = clampVol(state.volume);
    if (recGain) recGain.gain.value = v;
    if (monGain) monGain.gain.value = state.monitor ? v : 0;
  }

  // ---------- 输出模块: 包装 API ----------
  const md = navigator.mediaDevices;
  const origGUM = md && md.getUserMedia ? md.getUserMedia.bind(md) : null;
  const origEnum = md && md.enumerateDevices ? md.enumerateDevices.bind(md) : null;
  const wantsAudio = (c) => !!(c && (c.audio === true || (c.audio && typeof c.audio === 'object')));
  const waitMs = (ms) => new Promise((r) => setTimeout(r, ms));

  async function ensureReady() {
    // 只在【从未收到过首次同步】时补发一次 hello(覆盖 bridge 加载竞态)。
    // 同步完成后, 录音流程绝不主动去拉取/刷新音频——
    // 文件源的更新只发生在 popup 换文件(setAudio 广播)这一条用户主动路径上。
    if (!everSynced) postToBridge({ kind: 'hello' });
    for (let i = 0; i < 80; i++) {            // 最多等 ~4s(解码较慢的大文件)
      if (audioRaw === null || decodeDone) return;
      await waitMs(50);
    }
  }

  if (origGUM && md) {
    md.getUserMedia = async function (constraints) {
      if (!(state.enabled && wantsAudio(constraints))) return origGUM(constraints);

      await ensureReady();
      if (!state.enabled) return origGUM(constraints); // 等待期间被关闭

      let stream = null;
      try {
        if (audioBuffer) {
          const g = startRecGraph();
          if (g) {
            if (state.mode === 'auto') playNow(Number(state.delayMs) || 0);
            stream = g.dest.stream;
          }
        }
        if (!stream) stream = makeSilentStream(); // 无文件/解码失败: 静音兜底, 不报错
        if (!stream) throw new Error('VMIC 无法创建音频流');

        const wantVideo = !!(constraints && (constraints.video === true ||
          (constraints.video && typeof constraints.video === 'object')));
        if (wantVideo) {
          const v = await origGUM({ video: constraints.video }).catch(() => null);
          if (v) return new MediaStream([...v.getVideoTracks(), stream.getAudioTracks()[0]]);
        }
        return stream; // 纯音频请求 -> 页面只能拿到插件音频
      } catch (e) {
        console.error('[VMIC] 伪流创建失败, 回退真实设备:', e);
        return origGUM(constraints); // 极端兜底(几乎不会走到)
      }
    };
  }

  // 老式 navigator.getUserMedia（chivox support_h5 会引用当前属性）
  try {
    const legacy = (c, ok, err) => {
      const p = (md && md.getUserMedia) ? md.getUserMedia(c)
        : Promise.reject(new Error('getUserMedia unsupported'));
      if (ok) p.then(ok, err || (() => {}));
    };
    navigator.getUserMedia = legacy;
    if ('webkitGetUserMedia' in navigator) navigator.webkitGetUserMedia = legacy;
    if ('mozGetUserMedia' in navigator) navigator.mozGetUserMedia = legacy;
  } catch (_) {}

  // 启用时隐藏真麦
  if (origEnum && md) {
    md.enumerateDevices = async function () {
      let devs;
      try { devs = await origEnum(); } catch (_) { return origEnum(); }
      const out = devs.filter((d) => d.kind !== 'audioinput');
      if (state.enabled) {
        out.push({
          deviceId: 'vmic-local-audio',
          kind: 'audioinput',
          label: '本地音频 (VMIC)',
          groupId: 'vmic-group'
        });
      }
      return out;
    };
  }

  // ---------- popup 控制(手动模式/试听) ----------
  function doTransport(op) {
    if (!op) return;
    const c = ensureCtx();
    switch (op.action) {
      case 'play': {
        if (c && c.state === 'suspended') c.resume().catch(() => {});
        if (!recSrc) startRecGraph();       // 还没有会话: 先建图(试听预览)
        playNow(0);                          // 立即从头出声(录音与试听同时)
        break;
      }
      case 'pause':
        if (c && c.state === 'running') c.suspend().catch(() => {});
        break;
      case 'restart':
        if (c && c.state === 'suspended') c.resume().catch(() => {});
        if (audioBuffer) {
          startRecGraph();
          playNow(0);
        }
        break;
      case 'volume':
        state.volume = clampVol(op.value);
        applyVolume();
        break;
      case 'monitor':
        state.monitor = !!op.value;
        applyVolume();
        break;
      case 'loop':
        state.loop = !!op.value;
        if (recSrc) recSrc.loop = state.loop;
        break;
    }
  }

  hookGestures();
  postToBridge({ kind: 'hello' });
})();
