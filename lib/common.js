// VMIC 公共工具：Service Worker(importScripts) 与扩展整页(<script>)共用。
// 经典脚本，挂到 globalThis.VMIC 命名空间；加载顺序由各 html / importScripts
// 保证在本文件之后。content scripts 因 MAIN/ISOLATED 世界环境特殊，不引用本文件。
(function (g) {
  const V = g.VMIC = g.VMIC || {};

  // 文件 id 生成（crypto.randomUUID 优先，退化到时间戳+随机）
  V.uid = function uid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  };

  // 字节数 -> "xx KB" 显示
  V.fmtKB = function fmtKB(size) {
    return (size / 1024).toFixed(0) + ' KB';
  };

  // 内置噪音文件名（assets/whitevoice/<name>.mp3），与 content-main.js 的 NOISE_NAMES 保持一致
  V.NOISE_NAMES = ['ocean-waves', 'rain', 'stream', 'thunder'];

  // 防抖：高频事件合并为最后一次触发（用于滑块 setState，避免拖动时狂发消息）
  V.debounce = function debounce(fn, ms) {
    let t = null;
    return function (...args) {
      if (t) clearTimeout(t);
      t = setTimeout(() => { t = null; fn.apply(this, args); }, ms);
    };
  };
})(globalThis);
