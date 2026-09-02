// Service Worker：音频文件与状态的"仓库"+ 消息路由
// 关键约束（本扩展踩过的坑）:
//  1) chrome.storage 是 JSON 序列化, 存不了 ArrayBuffer(会变成 {})
//  2) chrome.runtime 消息传递默认也是 JSON 序列化, File/Blob/ArrayBuffer
//     都可能被破坏(File/Blob -> {})
// 因此:
//  - 二进制音频存【扩展源的 IndexedDB】(结构化克隆, 无 JSON 问题)
//  - 跨上下文传递一律用【base64 字符串】(JSON 安全), 由接收方解码
//  - 文件选择放在【整页 options.html】(不会被弹窗失焦关闭), 直接写 IndexedDB

const DEFAULTS = {
  enabled: false,   // 是否启用注入（页面只拿插件音频）
  delayMs: 800,     // 自动模式下：创建伪流后延时多少毫秒再出声（对齐站内倒计时）
  volume: 1,        // 录音/试听音量
  monitor: true,    // 外放试听：扬声器能听到正在录的声音（作为"开始播放"提示）
  loop: false,      // 循环播放
  mode: 'auto'      // auto=录音请求到达即自动从头播放; manual=手动点播放再出声
};

// ---------- IndexedDB(存音频二进制) ----------
const DB_NAME = 'vmic-db';
const DB_VER = 1;
const STORE = 'kv';
let dbp = null;

function openDB() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}

function idbPut(key, value) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

function idbGet(key) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const rq = tx.objectStore(STORE).get(key);
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
  }));
}

async function idbDel(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// 音频在 IDB 中的形态: { buf: ArrayBuffer, mime: string }
async function readAudio() {
  try {
    const rec = await idbGet('audio');
    return (rec && rec.buf instanceof ArrayBuffer) ? rec : null;
  } catch (_) {
    return null;
  }
}

// ArrayBuffer -> base64(跨上下文消息传递只走 JSON 安全的字符串)
function bufToB64(buf) {
  const u8 = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000; // 32768
  for (let i = 0; i < u8.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

// ---------- 状态(storage.session, 纯 JSON) ----------
async function readState() {
  const { state } = await chrome.storage.session.get('state');
  return { ...DEFAULTS, ...(state || {}) };
}

async function writeState(patch) {
  const next = { ...(await readState()), ...patch };
  await chrome.storage.session.set({ state: next });
  return next;
}

// 把变更同步到所有已打开标签页里的 bridge（无 tabs 权限时无法按 URL 过滤，
// 就广播给全部标签页，非目标页会静默失败）
async function pushToPages(payload) {
  try {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      if (!t.id) continue;
      chrome.tabs.sendMessage(t.id, { cmd: 'pageSync', ...payload }).catch(() => {});
    }
  } catch (_) { /* ignore */ }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg && msg.cmd) {
      case 'getState': {           // bridge -> SW
        sendResponse({ ok: true, state: await readState() });
        return;
      }
      case 'getAudio': {           // bridge -> SW（回传 base64 字符串, JSON 安全）
        const rec = await readAudio();
        sendResponse({
          ok: true,
          audio: rec ? bufToB64(rec.buf) : null,
          mime: rec ? rec.mime : 'audio/mpeg'
        });
        return;
      }
      case 'audioInfo': {          // popup/options -> SW（只回大小, 不回文件本体）
        const rec = await readAudio();
        sendResponse({
          ok: true,
          size: rec ? rec.buf.byteLength : 0,
          mime: rec ? rec.mime : 'audio/mpeg'
        });
        return;
      }
      case 'broadcastAudio': {     // options 已把新文件写入 IndexedDB -> 广播给页面
        const rec = await readAudio();
        sendResponse({ ok: true });
        await pushToPages({
          audio: rec ? bufToB64(rec.buf) : null,
          mime: rec ? rec.mime : 'audio/mpeg'
        });
        return;
      }
      case 'setState': {           // popup -> SW
        const next = await writeState(msg.patch || {});
        sendResponse({ ok: true, state: next });
        await pushToPages({ state: next });
        return;
      }
      case 'transport': {          // popup -> SW -> 页面
        sendResponse({ ok: true });
        await pushToPages({ transport: msg.op });
        return;
      }
      default:
        sendResponse({ ok: false, error: 'unknown cmd: ' + (msg && msg.cmd) });
    }
  })();
  return true; // 异步 sendResponse
});
