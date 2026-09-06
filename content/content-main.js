// MAIN world：本扩展的"心脏"（多文件播放列表：页面始终持有"当前文件"）
// AudioContext 方案：decodeAudioData 解码 -> MediaStreamDestination 出伪麦流，
// 音频轨恒存在；另接 ctx.destination 做外放试听。
//
// 三模块:
//  输入: bridge 转来的本地音频(ArrayBuffer) -> decodeAudioData 成 AudioBuffer
//  处理: BufferSource -> recGain(音量) -> MediaStreamDestination(伪装麦克风)
//        BufferSource -> monGain(试听) -> ctx.destination(扬声器, 可开关)
//  输出: 包装 getUserMedia/enumerateDevices，启用时纯音频请求只能拿到伪流
(() => {
  'use strict';
  const TOKEN = 'VMIC_TSINGHUAELT_01';
  // 内置噪音名（与 lib/common.js 的 VMIC.NOISE_NAMES 保持一致；content scripts 不引用 common.js）
  const NOISE_NAMES = ['ocean-waves', 'rain', 'stream', 'thunder'];

  const state = {
    enabled: true,     // 注入开关（默认启用；停用需去设置页，页面才走真实麦克风）
    delayMs: 800,      // 自动模式: 伪流创建后多少 ms 再出声(对齐倒计时)
    volume: 1,         // 录音/试听共用音量
    monitor: true,     // 外放试听(扬声器可听到正在录的声音)
    loop: false,       // 循环播放
    mode: 'auto',      // auto | manual
    audioSig: '',      // 当前文件源的内容签名(用于幂等去重, 不与页面状态混淆)
    noiseOn: true,     // 启用噪音覆盖
    noiseRandom: true, // 启用随机噪音
    noiseId: 'rain',   // 指定噪音名(随机关闭时用)
    noiseVol: 0.1      // 噪音音量(0-1)
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
  let recDestTrackId = null;   // 伪流 audio track 的 id, 用于识别网页是否在消费我们的流

  // 噪音覆盖: noiseSrc -> noiseGain -> recDest(混入伪麦流, 不进扬声器)
  let noiseSrc = null;
  let noiseGain = null;
  const noiseBuffers = {};          // name -> AudioBuffer
  let noiseLoaded = false;          // 全部噪音解码完成
  let noiseLoadRequested = false;   // 是否已发起加载(避免重复)

  const clampVol = (v) => Math.min(1, Math.max(0, Number(v) || 0));

  // ---------- 调试日志 ----------
  function dbgSnapshot() {
    const track = recDest && recDest.stream && recDest.stream.getAudioTracks()[0];
    return {
      ctx: ctx ? ctx.state : 'null',
      hasBuf: !!audioBuffer,
      mode: state.mode,
      enabled: state.enabled,
      loop: state.loop,
      recSrc: recSrc ? { started: !!recSrc.__started, stopping: !!recSrc.__stopping } : null,
      recDest: !!recDest,
      recGain: !!recGain,
      monGain: !!monGain,
      noiseSrc: noiseSrc ? { started: !!noiseSrc.__started } : null,
      trackState: track ? track.readyState : 'none'
    };
  }
  function dbg(tag, extra) {
    const t = ((performance.now() % 100000) / 1000).toFixed(2);
    console.log('[VMIC DBG] t=' + t + 's ' + tag, dbgSnapshot(), extra || '');
  }

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
    if (d.kind === 'state' && d.state) { applyState(d.state); everSynced = true; maybeLoadNoises(); }
    if (d.kind === 'audio' && d.audio !== undefined) { setAudioData(d.audio); everSynced = true; maybeLoadNoises(); }
    if (d.kind === 'noise' && d.name && d.audio !== undefined) setNoiseData(d.name, d.audio);
    if (d.kind === 'sync') {
      if (d.clearAudio) { clearAudio(); everSynced = true; } // 列表删空/删当前文件 -> 显式清空（区别于空推送）
      if (d.state) { applyState(d.state); everSynced = true; }
      if (d.audio !== undefined) { setAudioData(d.audio); everSynced = true; }
      if (d.transport) doTransport(d.transport);
      maybeLoadNoises();
    }
  });

  function applyState(patch) {
    const prev = { ...state };
    Object.assign(state, patch || {});
    dbg('applyState', { patch });
    if (state.enabled === false && prev.enabled === true) stopRec(); // 关闭注入即停
    applyVolume();
  }

  // 显式清空当前文件源。与 setAudioData 的"空推送不误清"守卫互补：
  // 只有这里能主动清掉现有文件（删除当前文件/列表删空时由 SW 广播触发）。
  function clearAudio() {
    stopRec();
    audioRaw = null;
    audioBuffer = null;
    decodeDone = true;
    state.audioSig = '';
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
    } catch (e) {
      console.warn('[VMIC] SHA-256 不可用，退化为不去重(仍安全):', e);
      return null;
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
        if (audioRaw === snapshot) { audioBuffer = ab; decodeDone = true; dbg('decode OK', { dur: ab.duration, ch: ab.numberOfChannels }); }
      }).catch((e) => {
        console.error('[VMIC] 音频解码失败(请换 mp3/wav):', e);
        decodeDone = true;
      });
    } catch (e) {
      console.error('[VMIC] 解码流程异常:', e);
      decodeDone = true;
    }
  }

  // ---------- 噪音加载 ----------
  function maybeLoadNoises() {
    if (noiseLoadRequested || !everSynced) return;
    noiseLoadRequested = true;
    dbg('maybeLoadNoises: requesting', { names: NOISE_NAMES });
    for (const name of NOISE_NAMES) postToBridge({ kind: 'getNoise', name });
  }

  async function setNoiseData(name, b64) {
    if (noiseBuffers[name]) return;
    let buf = null;
    if (typeof b64 === 'string' && b64) {
      try {
        const bin = atob(b64);
        const u8 = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        buf = u8.buffer;
      } catch (e) {
        console.warn('[VMIC] 噪音 base64 解码失败 ' + name + ':', e);
        return;
      }
    }
    if (!buf || !buf.byteLength) { dbg('setNoiseData empty', { name }); return; }
    try {
      const c = ensureCtx();
      if (!c) return;
      const ab = await c.decodeAudioData(buf.slice(0));
      noiseBuffers[name] = ab;
      if (NOISE_NAMES.every((n) => noiseBuffers[n])) { noiseLoaded = true; dbg('noiseLoaded ALL'); }
      else { dbg('noise decoded one', { name, loaded: Object.keys(noiseBuffers) }); }
    } catch (e) {
      console.warn('[VMIC] 噪音解码失败 ' + name + ':', e);
    }
  }

  // ---------- 处理模块: 建图(伪麦流 + 可选试听) ----------
  function stopRec() {
    dbg('stopRec begin');
    if (recSrc) {
      recSrc.__stopping = true; // 标记手动停止，onended 据此跳过自然结束清理
      try { if (recSrc.__started) recSrc.stop(); } catch (e) { console.warn('[VMIC] recSrc.stop:', e); }
      try { recSrc.disconnect(); } catch (e) { console.warn('[VMIC] recSrc.disconnect:', e); }
      recSrc = null;
    }
    if (recGain) { try { recGain.disconnect(); } catch (e) { console.warn('[VMIC] recGain.disconnect:', e); } recGain = null; }
    if (monGain) { try { monGain.disconnect(); } catch (e) { console.warn('[VMIC] monGain.disconnect:', e); } monGain = null; }
    if (noiseSrc) {
      try { if (noiseSrc.__started) noiseSrc.stop(); } catch (e) { console.warn('[VMIC] noiseSrc.stop:', e); }
      try { noiseSrc.disconnect(); } catch (e) { console.warn('[VMIC] noiseSrc.disconnect:', e); }
      noiseSrc = null;
    }
    if (noiseGain) { try { noiseGain.disconnect(); } catch (e) { console.warn('[VMIC] noiseGain.disconnect:', e); } noiseGain = null; }
    if (recDest) { try { recDest.disconnect(); } catch (e) { console.warn('[VMIC] recDest.disconnect:', e); } recDest = null; }
  }

  // 只停止音频源(recSrc/noiseSrc)，保留 recDest/recGain/monGain/noiseGain 不动。
  // 用于 pause：伪流(recDest.stream)持续活着，网页复用流不会拿到已死流，
  // 之后手动 play 可经 ensureRecSrc 重新注入音频到同一条流。
  function stopSrcOnly() {
    dbg('stopSrcOnly begin');
    if (recSrc) {
      recSrc.__stopping = true;
      try { if (recSrc.__started) recSrc.stop(); } catch (e) { console.warn('[VMIC] recSrc.stop:', e); }
      try { recSrc.disconnect(); } catch (e) { console.warn('[VMIC] recSrc.disconnect:', e); }
      recSrc = null;
    }
    if (noiseSrc) {
      try { if (noiseSrc.__started) noiseSrc.stop(); } catch (e) { console.warn('[VMIC] noiseSrc.stop:', e); }
      try { noiseSrc.disconnect(); } catch (e) { console.warn('[VMIC] noiseSrc.disconnect:', e); }
      noiseSrc = null;
    }
  }

  function startRecGraph() {
    stopRec();
    const c = ensureCtx();
    if (!c || !audioBuffer) return null;

    recDest = c.createMediaStreamDestination();      // -> 伪装麦克风
    try { recDestTrackId = recDest.stream.getAudioTracks()[0].id; } catch (e) { recDestTrackId = null; }
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
    recSrc.__stopping = false;
    recSrc.connect(recGain);
    recSrc.connect(monGain); // 常连, 用增益 0 关断, 避免开关瞬间爆音

    // 监听自然播放结束: 清理 src 但保留 dest/recGain/monGain,
    // 让伪流持续活着——网页复用流时仍可经手动重播重新注入音频
    const src = recSrc;
    recSrc.onended = () => {
      dbg('onended fired', { stopping: !!src.__stopping, isCurrent: recSrc === src });
      if (src.__stopping) return; // 手动停止由 stopRec 统一清理
      try { src.disconnect(); } catch (e) {}
      if (recSrc === src) recSrc = null;
      dbg('onended natural-end cleanup done');
    };

    // 噪音覆盖: 选一个噪音循环混入 recDest(不进扬声器试听)
    dbg('noise check', { noiseOn: state.noiseOn, noiseLoaded, loadedKeys: Object.keys(noiseBuffers) });
    if (state.noiseOn && noiseLoaded) {
      const noiseName = state.noiseRandom
        ? NOISE_NAMES[Math.floor(Math.random() * NOISE_NAMES.length)]
        : (NOISE_NAMES.includes(state.noiseId) ? state.noiseId : NOISE_NAMES[0]);
      const nb = noiseBuffers[noiseName];
      if (nb) {
        noiseGain = c.createGain();
        noiseGain.gain.value = clampVol(state.noiseVol);
        noiseGain.connect(recDest);
        noiseSrc = c.createBufferSource();
        noiseSrc.buffer = nb;
        noiseSrc.loop = true;
        noiseSrc.connect(noiseGain);
        noiseSrc.__started = false;
        dbg('noise src created', { name: noiseName, vol: state.noiseVol });
      }
    }

    dbg('startRecGraph done');
    return { src: recSrc, dest: recDest };
  }

  // 仅重建源节点(recSrc)，保留 recDest/recGain/monGain 不动——用于音频自然播放结束后
  // 的手动重播。这样伪流(recDest.stream)持续活着，网页若复用旧流仍能录到重新播放的音频，
  // 而不是录到静音或拿到已死流导致录音失败。
  function ensureRecSrc() {
    if (recSrc) { dbg('ensureRecSrc skip: recSrc exists'); return true; }
    if (!ctx || !audioBuffer || !recGain || !monGain) { dbg('ensureRecSrc fail: missing deps', { ctx: !!ctx, buf: !!audioBuffer, rg: !!recGain, mg: !!monGain }); return false; }
    recSrc = ctx.createBufferSource();
    recSrc.buffer = audioBuffer;
    recSrc.loop = !!state.loop;
    recSrc.__started = false;
    recSrc.__stopping = false;
    recSrc.connect(recGain);
    recSrc.connect(monGain);
    const src = recSrc;
    recSrc.onended = () => {
      dbg('onended(ensure) fired', { stopping: !!src.__stopping, isCurrent: recSrc === src });
      if (src.__stopping) return;
      try { src.disconnect(); } catch (e) {}
      if (recSrc === src) recSrc = null;
      dbg('onended(ensure) natural-end cleanup done');
    };

    // 噪音恢复：若噪音应开启但 noiseSrc 已被 stopSrcOnly 停掉，在此重建，
    // 否则暂停后再自动播放会丢失噪音覆盖。
    if (state.noiseOn && noiseLoaded && !noiseSrc && recDest) {
      const noiseName = state.noiseRandom
        ? NOISE_NAMES[Math.floor(Math.random() * NOISE_NAMES.length)]
        : (NOISE_NAMES.includes(state.noiseId) ? state.noiseId : NOISE_NAMES[0]);
      const nb = noiseBuffers[noiseName];
      if (nb) {
        if (!noiseGain) {
          noiseGain = ctx.createGain();
          noiseGain.gain.value = clampVol(state.noiseVol);
          noiseGain.connect(recDest);
        }
        noiseSrc = ctx.createBufferSource();
        noiseSrc.buffer = nb;
        noiseSrc.loop = true;
        noiseSrc.connect(noiseGain);
        noiseSrc.__started = false;
        dbg('noise src re-created in ensureRecSrc', { name: noiseName });
      }
    }

    dbg('ensureRecSrc done');
    return true;
  }

  function playNow(delayMs) {
    const c = ctx;
    if (!c || !recSrc || recSrc.__started) { dbg('playNow FAIL', { reason: !c ? 'no ctx' : (!recSrc ? 'no recSrc' : 'already started'), delayMs }); return false; }
    const t = c.currentTime + (Math.max(0, Number(delayMs) || 0)) / 1000;
    try {
      recSrc.start(t);
      recSrc.__started = true;
      if (noiseSrc && !noiseSrc.__started) {
        try { noiseSrc.start(t); noiseSrc.__started = true; }
        catch (e) { console.warn('[VMIC] 噪音启动失败:', e); }
      }
      dbg('playNow OK', { delayMs });
      return true;
    } catch (e) {
      console.error('[VMIC] 播放启动失败:', e);
      dbg('playNow EXCEPTION', { msg: e.message });
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
    // 文件源的更新只发生在 popup/picker 切换文件(广播)这一条用户主动路径上。
    // 默认启用后 gUM 可能先于 bridge 的首次推送到达: 必须等 everSynced
    // 再放行, 否则会误判"无文件"而立即返回静音流。
    if (!everSynced) postToBridge({ kind: 'hello' });
    for (let i = 0; i < 80; i++) {            // 最多等 ~4s(解码较慢的大文件)
      if (everSynced && (audioRaw === null || decodeDone)) return;
      await waitMs(50);
    }
  }

  if (origGUM && md) {
    md.getUserMedia = async function (constraints) {
      const wantAudio = state.enabled && wantsAudio(constraints);
      dbg('getUserMedia called', { wantAudio, constraints });
      if (!wantAudio) return origGUM(constraints);

      await ensureReady();
      if (!state.enabled) { dbg('getUserMedia disabled after wait'); return origGUM(constraints); }

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
        dbg('getUserMedia return stream');
        return stream; // 纯音频请求 -> 页面只能拿到插件音频
      } catch (e) {
        console.error('[VMIC] 伪流创建失败, 回退真实设备:', e);
        dbg('getUserMedia fallback to real', { msg: e.message });
        return origGUM(constraints); // 极端兜底(几乎不会走到)
      }
    };
  }

  // 启用时隐藏真麦
  if (origEnum && md) {
    md.enumerateDevices = async function () {
      let devs;
      try { devs = await origEnum(); } catch (e) { console.warn('[VMIC] enumerateDevices 首次失败，重试:', e); return origEnum(); }
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

  // 包装 createMediaStreamSource：网页每次从伪流创建音频源(即开始从流取数据/录音)时，
  // 在 auto 模式下触发自动播放。弥补网页复用流、不再调用 getUserMedia 导致的自动播放缺失。
  const ACProto = (window.AudioContext || window.webkitAudioContext);
  if (ACProto && ACProto.prototype && ACProto.prototype.createMediaStreamSource) {
    const origCreateMSS = ACProto.prototype.createMediaStreamSource;
    ACProto.prototype.createMediaStreamSource = function (stream) {
      const result = origCreateMSS.call(this, stream);
      try {
        const tracks = stream && stream.getAudioTracks ? stream.getAudioTracks() : [];
        if (tracks.length && tracks[0].id === recDestTrackId) {
          dbg('createMediaStreamSource on our stream', { mode: state.mode, enabled: state.enabled });
          if (state.enabled && state.mode === 'auto' && audioBuffer) {
            const c = ensureCtx();
            if (c && c.state === 'suspended') c.resume().catch(() => {});
            if (recDest && !recSrc) ensureRecSrc();
            if (recSrc && !recSrc.__started) playNow(Number(state.delayMs) || 0);
          }
        }
      } catch (e) { console.warn('[VMIC] createMediaStreamSource 包装异常:', e); }
      return result;
    };
  }

  // 包装 WebSocket：chivox 每次 startRecord 都会连接 WebSocket 上传音频数据，
  // 这是"录音真正开始"的可靠信号（getUserMedia 只在 init 时调一次，不够）。
  // 在 auto 模式下以此触发自动播放，对齐录音起点。
  const OrigWebSocket = window.WebSocket;
  if (OrigWebSocket) {
    const WSWrap = function (url, protocols) {
      const ws = protocols !== undefined ? new OrigWebSocket(url, protocols) : new OrigWebSocket(url);
      try {
        const urlStr = String(url || '').slice(0, 80);
        dbg('WebSocket created', { url: urlStr });
        if (state.enabled && state.mode === 'auto' && audioBuffer) {
          const c = ensureCtx();
          if (c && c.state === 'suspended') c.resume().catch(() => {});
          if (!recDest) { dbg('WS auto: no recDest -> startRecGraph'); startRecGraph(); }
          else if (!recSrc) { dbg('WS auto: recDest alive, no recSrc -> ensureRecSrc'); ensureRecSrc(); }
          if (recSrc && !recSrc.__started) playNow(Number(state.delayMs) || 0);
        }
      } catch (e) { console.warn('[VMIC] WebSocket 包装异常:', e); }
      return ws;
    };
    WSWrap.prototype = OrigWebSocket.prototype;
    WSWrap.CONNECTING = OrigWebSocket.CONNECTING;
    WSWrap.OPEN = OrigWebSocket.OPEN;
    WSWrap.CLOSING = OrigWebSocket.CLOSING;
    WSWrap.CLOSED = OrigWebSocket.CLOSED;
    window.WebSocket = WSWrap;
  }

  // ---------- popup 控制(手动模式/试听) ----------
  function doTransport(op) {
    if (!op) return;
    dbg('doTransport', { action: op.action, value: op.value });
    const c = ensureCtx();
    switch (op.action) {
      case 'play': {
        if (c && c.state === 'suspended') c.resume().catch(() => {});
        if (!recDest) { dbg('play: no recDest -> startRecGraph'); startRecGraph(); }
        else if (!recSrc) { dbg('play: recDest alive, no recSrc -> ensureRecSrc'); ensureRecSrc(); }
        else { dbg('play: both exist -> playNow only'); }
        playNow(0);
        break;
      }
      case 'pause':
        stopSrcOnly();                 // 只停源, 保留 recDest 让伪流持续活着, 避免网页复用流拿到死流
        break;
      case 'restart':
        if (c && c.state === 'suspended') c.resume().catch(() => {});
        if (audioBuffer) {
          if (recDest) {
            dbg('restart: recDest alive -> rebuild src only');
            if (recSrc) {
              recSrc.__stopping = true;
              try { if (recSrc.__started) recSrc.stop(); } catch (e) {}
              try { recSrc.disconnect(); } catch (e) {}
              recSrc = null;
            }
            ensureRecSrc();
          } else {
            dbg('restart: no recDest -> startRecGraph');
            startRecGraph();
          }
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
      case 'noiseVol':
        state.noiseVol = clampVol(op.value);
        if (noiseGain) noiseGain.gain.value = state.noiseVol;
        break;
    }
  }

  hookGestures();
  postToBridge({ kind: 'hello' });
})();
