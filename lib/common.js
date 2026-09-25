// VMIC 公共工具
(function (g) {
  const V = g.VMIC = g.VMIC || {};

  // 文件 id 生成
  V.uid = function uid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  };

  // 字节数显示
  V.fmtKB = function fmtKB(size) {
    return (size / 1024).toFixed(0) + ' KB';
  };

  // 噪音文件名
  V.NOISE_NAMES = ['ocean-waves', 'rain', 'stream', 'thunder'];

  V.debounce = function debounce(fn, ms) {
    let t = null;
    return function (...args) {
      if (t) clearTimeout(t);
      t = setTimeout(() => { t = null; fn.apply(this, args); }, ms);
    };
  };
})(globalThis);
