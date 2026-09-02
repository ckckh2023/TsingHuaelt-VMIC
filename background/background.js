// Service Worker：音频文件库与状态的"仓库"+ 消息路由
// 数据模型（IndexedDB store 'kv'，读写工具见 lib/idb.js）:
//   file:<id> -> { buf: ArrayBuffer, mime, name }   每个音频文件本体（二进制）
//   list      -> [{ id, name, size, mime, addedAt }] 播放列表元信息（数组顺序=显示顺序）
//   cur       -> 当前选中的音频 id（页面注入/播放只针对"当前文件"）
// 关键约束（本扩展踩过的坑）:
//  1) chrome.storage 是 JSON 序列化, 存不了 ArrayBuffer(会变成 {})
//  2) chrome.runtime 消息传递默认也是 JSON 序列化, File/Blob/ArrayBuffer
//     都可能被破坏(File/Blob -> {})
// 因此:
//  - 二进制音频只进【IndexedDB】(结构化克隆, 无 JSON 问题)
//  - 跨上下文传递一律用【base64 字符串】(JSON 安全), 由接收方解码
//  - 文件选择放在【整页 picker.html】(不会被弹窗失焦关闭), 只负责把新文件
//    写入 file:<id>；列表登记(list/cur)统一由本 SW 维护，避免并发改列表

importScripts('../lib/idb.js');

const DEFAULTS = {
  enabled: true,   // 是否启用注入。默认【启用】：不启用独占时本扩展完全无法发挥作用
  delayMs: 800,    // 自动模式下：创建伪流后延时多少毫秒再出声（对齐站内倒计时）
  volume: 1,       // 录音/试听音量
  monitor: true,   // 外放试听：扬声器能听到正在录的声音（作为"开始播放"提示）
  loop: false,     // 循环播放
  mode: 'auto'     // auto=录音请求到达即自动从头播放; manual=手动点播放再出声
};

// 说明：状态用 chrome.storage.session（每次浏览器会话从 DEFAULTS 起步，
// 因此"默认启用"在每个新会话都成立；用户手动关闭仅当次会话内保持）。

// ---------- 文件库 ----------
function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

// 当前选中的音频文件: { id, buf, mime, name } 或 null
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

// v0.3 -> v0.4 迁移：旧版单文件记录 {buf,mime}(key 'audio') 转成文件库首项
(async function migrateV03() {
  try {
    if (await idbGet('list')) return;   // 已有新库则跳过
    const old = await idbGet('audio');
    if (!old || !(old.buf instanceof ArrayBuffer)) return;
    const id = uid();
    const meta = {
      id, name: '我的音频',
      size: old.buf.byteLength,
      mime: old.mime || 'audio/mpeg',
      addedAt: Date.now()
    };
    await idbPut('file:' + id, { buf: old.buf, mime: meta.mime, name: meta.name });
    await idbPut('list', [meta]);
    await idbPut('cur', id);
    await idbDel('audio');
  } catch (_) { /* 迁移失败不影响新库路径 */ }
})();

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

// 把"当前文件"推给所有打开的页面（页面按内容签名去重，换文件才会重解码）
async function pushCurrentAudio() {
  const rec = await readCurFile();
  await pushToPages(rec
    ? { audio: bufToB64(rec.buf), mime: rec.mime }
    : { clearAudio: true });
}

// 显式清空页面里的音频（区别于"空推送"，避免误清现有文件源）
async function pushClearAudio() {
  await pushToPages({ clearAudio: true });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg && msg.cmd) {
      case 'getState': {           // bridge/settings/popup -> SW
        sendResponse({ ok: true, state: await readState() });
        return;
      }
      case 'getAudio': {           // bridge -> SW（当前文件 base64, JSON 安全）
        const rec = await readCurFile();
        sendResponse({
          ok: true,
          audio: rec ? bufToB64(rec.buf) : null,
          mime: rec ? rec.mime : 'audio/mpeg'
        });
        return;
      }
      case 'getLib': {             // popup/picker -> SW（播放列表元信息）
        const lib = await getLib();
        sendResponse({ ok: true, list: lib.list, currentId: lib.currentId });
        return;
      }
      case 'addFile': {            // picker 已把二进制写入 file:<id> -> 登记入列表并设为当前
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
        if (!msg.silent) await pushCurrentAudio(); // 批量导入(silent)只在最后一个文件后推送一次
        return;
      }
      case 'selectAudio': {        // popup 点列表行 -> 切换当前文件并推给页面
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
      case 'removeAudio': {        // popup 删除列表项
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
          if (cur) await pushCurrentAudio(); // 自动切到列表第一项
          else await pushClearAudio();       // 删到空 -> 页面清空, 回静音兜底
        }
        return;
      }
      case 'setState': {           // settings/popup -> SW
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
