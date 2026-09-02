// 整页设置页：选择本地音频文件，并【直接写入扩展自己的 IndexedDB】。
// 好处：
//  1) 整页不会被弹窗失焦关闭，读文件不被打断；
//  2) 二进制不进消息通道(避免 JSON 序列化把 File/Blob/ArrayBuffer 变成 {})，
//     由本页直接结构化克隆到 IndexedDB，后台/页面再经 base64 读取。
const $ = (id) => document.getElementById(id);
const DB_NAME = 'vmic-db';
const DB_VER = 1;
const STORE = 'kv';

function openDB() {
  return new Promise((resolve, reject) => {
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

async function render() {
  try {
    const rec = await idbGet('audio');
    if (rec && rec.buf instanceof ArrayBuffer) {
      $('info').textContent = '当前：' + (rec.buf.byteLength / 1024).toFixed(0) +
        ' KB（' + (rec.mime || 'audio/mpeg') + '）';
    } else {
      $('info').textContent = '当前：未选择音频';
    }
  } catch (e) {
    $('info').textContent = '读取失败：' + e;
  }
}

$('file').addEventListener('change', async () => {
  const f = $('file').files && $('file').files[0];
  if (!f) return;
  const status = $('status');
  status.textContent = '载入中：' + f.name + ' …';
  try {
    const buf = await f.arrayBuffer();
    await idbPut('audio', { buf, mime: f.type || 'audio/mpeg' });
    status.textContent = '已保存：' + f.name + ' ✓（已同步到打开的页面）';
    // 通知后台把新文件(以 base64)广播给已打开的 tsinghuaelt 页面
    await chrome.runtime.sendMessage({ cmd: 'broadcastAudio' }).catch(() => {});
  } catch (e) {
    status.textContent = '保存失败：' + e;
  }
  $('file').value = '';
  render();
});

render();
