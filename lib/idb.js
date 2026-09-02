// 通用 IndexedDB 小工具：service worker(importScripts) 与扩展整页(<script>)
// 共用同一数据库。经典脚本（非 module），函数直接挂到全局。
// 背景：本扩展音频二进制只存 IndexedDB（结构化克隆，规避 chrome.runtime /
// chrome.storage 的 JSON 序列化破坏 File/Blob/ArrayBuffer 的问题）。

const IDB_NAME = 'vmic-db';
const IDB_VER = 1;
const IDB_STORE = 'kv';
let _dbp = null;

function openDB() {
  if (!_dbp) {
    _dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, IDB_VER);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(IDB_STORE)) {
          req.result.createObjectStore(IDB_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return _dbp;
}

function idbPut(key, value) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

function idbGet(key) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const rq = tx.objectStore(IDB_STORE).get(key);
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
  }));
}

function idbDel(key) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}
