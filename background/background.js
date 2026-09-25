// 音频文件库与状态的列表

importScripts('../lib/idb.js', '../lib/common.js');

const NOISE_NAMES = VMIC.NOISE_NAMES;

const DEFAULTS = {
  enabled: true,     // 注入开关
  delayMs: 800,      // 延时时间
  volume: 1,         // 录音音量
  monitor: true,     // 外放试听
  loop: false,       // 循环播放
  mode: 'auto',      // 自动模式
  audioSig: '',      // 当前文件源的内容签名
  noiseOn: true,     // 启用噪音覆盖
  noiseRandom: true, // 启用随机噪音
  noiseId: 'rain',   // 指定噪音名
  noiseVol: 0.1      // 噪音音量
};


// ---------- 文件库 ----------
async function readCurFile() {
  const cur = await idbGet('cur');
  if (!cur) return null;
  const rec = await idbGet('file:' + cur);
  return (rec && rec.buf instanceof ArrayBuffer)
    ? { id: cur, buf: rec.buf, mime: rec.mime || 'audio/mpeg', name: rec.name || '' }
    : null;
}

async function getLib() {
  const list = (await idbGet('list')) || [];
  const cur = await idbGet('cur');
  return { list, currentId: cur };
}

function bufToB64(buf) {
  const u8 = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000; // 32768
  for (let i = 0; i < u8.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function b64ToBuf(b64) {
  const bin = atob(String(b64 || ''));
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8.buffer;
}

// ---------- 状态 ----------
async function readState() {
  const { state } = await chrome.storage.session.get('state');
  return { ...DEFAULTS, ...(state || {}) };
}

async function writeState(patch) {
  const next = { ...(await readState()), ...patch };
  await chrome.storage.session.set({ state: next });
  return next;
}

async function pushToPages(payload) {
  try {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      if (!t.id) continue;
      chrome.tabs.sendMessage(t.id, { cmd: 'pageSync', ...payload }).catch(() => {});
    }
  } catch (e) { console.warn('[VMIC] pushToPages 广播失败:', e); }
}

async function pushCurrentAudio() {
  const rec = await readCurFile();
  await pushToPages(rec
    ? { audio: bufToB64(rec.buf), mime: rec.mime }
    : { clearAudio: true });
}

async function pushClearAudio() {
  await pushToPages({ clearAudio: true });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
    switch (msg && msg.cmd) {
      case 'getState': {
        sendResponse({ ok: true, state: await readState() });
        return;
      }
      case 'getAudio': {
        const rec = await readCurFile();
        sendResponse({
          ok: true,
          audio: rec ? bufToB64(rec.buf) : null,
          mime: rec ? rec.mime : 'audio/mpeg'
        });
        return;
      }
      case 'getNoise': {
        const name = msg.name;
        if (!NOISE_NAMES.includes(name)) {
          sendResponse({ ok: false, error: 'unknown noise: ' + name });
          return;
        }
        let nrec = await idbGet('noise:' + name);
        if (!nrec || !(nrec.buf instanceof ArrayBuffer)) {
          try {
            const url = chrome.runtime.getURL('assets/whitevoice/' + name + '.mp3');
            const res = await fetch(url);
            const ab = await res.arrayBuffer();
            nrec = { buf: ab, mime: 'audio/mpeg' };
            await idbPut('noise:' + name, nrec);
          } catch (e) {
            console.warn('[VMIC] 噪音加载失败 ' + name + ':', e);
            sendResponse({ ok: false, error: 'fetch fail' });
            return;
          }
        }
        sendResponse({ ok: true, audio: bufToB64(nrec.buf), mime: nrec.mime || 'audio/mpeg' });
        return;
      }
      case 'getLib': {
        const lib = await getLib();
        sendResponse({ ok: true, list: lib.list, currentId: lib.currentId });
        return;
      }
      case 'addFile': {
        const f = (msg && msg.file) || {};
        const rec = await idbGet('file:' + f.id);
        if (!f.id || !(rec && rec.buf instanceof ArrayBuffer)) {
          sendResponse({ ok: false, error: 'file not stored' });
          return;
        }
        const lib = await getLib();
        const meta = {
          id: f.id,
          name: String(f.name || 'audio'),
          size: Number(f.size) || rec.buf.byteLength,
          mime: f.mime || rec.mime || 'audio/mpeg',
          addedAt: Date.now()
        };
        const list = [...lib.list.filter((x) => x.id !== f.id), meta];
        await idbPut('list', list);
        await idbPut('cur', f.id);
        sendResponse({ ok: true, list, currentId: f.id });
        if (!msg.silent) await pushCurrentAudio();
        return;
      }
      case 'addFileB64': {
        const f = (msg && msg.file) || {};
        let buf = null;
        try { buf = b64ToBuf(f.b64); } catch (_) { buf = null; }
        if (!buf || !buf.byteLength) {
          sendResponse({ ok: false, error: 'empty data' });
          return;
        }
        const capId = VMIC.uid();
        const capMime = f.mime || 'audio/mpeg';
        const capName = String(f.name || 'capture-' + capId.slice(0, 8));
        await idbPut('file:' + capId, { buf, mime: capMime, name: capName });
        const capLib = await getLib();
        const capMeta = {
          id: capId,
          name: capName,
          size: Number(f.size) || buf.byteLength,
          mime: capMime,
          addedAt: Date.now()
        };
        const capList = [...capLib.list.filter((x) => x.id !== capId), capMeta];
        await idbPut('list', capList);
        await idbPut('cur', capId);
        sendResponse({ ok: true, list: capList, currentId: capId, size: capMeta.size });
        await pushCurrentAudio();
        return;
      }
      case 'selectAudio': {
        const lib = await getLib();
        if (!msg.id || !lib.list.some((x) => x.id === msg.id)) {
          sendResponse({ ok: false, error: 'not found: ' + msg.id });
          return;
        }
        await idbPut('cur', msg.id);
        sendResponse({ ok: true, list: lib.list, currentId: msg.id });
        await pushCurrentAudio();
        return;
      }
      case 'removeAudio': {
        const lib = await getLib();
        if (!msg.id || !lib.list.some((x) => x.id === msg.id)) {
          sendResponse({ ok: false, error: 'not found: ' + msg.id });
          return;
        }
        const list = lib.list.filter((x) => x.id !== msg.id);
        await idbPut('list', list);
        await idbDel('file:' + msg.id);
        const wasCur = lib.currentId === msg.id;
        const cur = wasCur ? (list.length ? list[0].id : null) : lib.currentId;
        if (cur) await idbPut('cur', cur); else await idbDel('cur');
        sendResponse({ ok: true, list, currentId: cur });
        if (wasCur) {
          if (cur) await pushCurrentAudio();
          else await pushClearAudio();
        }
        return;
      }
      case 'clearLib': {
        const lib = await getLib();
        for (const it of lib.list) await idbDel('file:' + it.id);
        await idbPut('list', []);
        await idbDel('cur');
        sendResponse({ ok: true, list: [], currentId: null });
        await pushClearAudio();
        return;
      }
      case 'setState': {
        const next = await writeState(msg.patch || {});
        sendResponse({ ok: true, state: next });
        await pushToPages({ state: next });
        return;
      }
      case 'transport': {
        sendResponse({ ok: true });
        await pushToPages({ transport: msg.op });
        return;
      }
      default:
        sendResponse({ ok: false, error: 'unknown cmd: ' + (msg && msg.cmd) });
    }
    } catch (e) {
      console.warn('[VMIC] 处理消息异常:', e);
      try { sendResponse({ ok: false, error: String((e && e.message) || e) }); } catch (_) {}
    }
  })();
  return true;
});
