# 清英在线 · 虚拟麦克风（VMIC）

让 [清英在线](https://www.tsinghuaelt.com/) 的网页录音只能拿到**本插件注入的本地音频**，而非真实麦克风。

> **合规提示：** 仅建议用于自控的自动化测试、功能演示、无障碍辅助等场景。代做朗读/口语作业可能违反学校与平台规定，后果自负。MIT 许可，不上架公共商店。

---

## 功能

- **独占注入**：纯音频请求一律返回伪流，真实麦克风被隐藏
- **多文件播放列表**：随时添加/切换/删除，当前文件即录音会拿到的那个
- **自动播放**：录音开始即从头播放（可调延时对齐倒计时）；亦支持手动模式
- **噪音覆盖**：混入随机环境噪音，防止音频完全一致被平台识别
- **外放试听 / 音量 / 循环**：可选扬声器监听、调节音量、循环播放
- **网页音频捕获**：页面右下角悬浮控件，自动发现网页中的音频，可试听、一键加入插件音频库
- 兼容 Chromium ≥ 111

## 安装

1. `chrome://extensions`（Edge 为 `edge://extensions`）开启「开发者模式」
2. 下载 Release 压缩包，解压后「加载已解压的扩展」
3. 访问 `*.tsinghuaelt.com` 并登录

## 使用

1. 打开扩展 popup →「＋ 选择文件…」导入本地音频
2. 点列表行切换当前文件，✕ 删除
3. 左下「⚙ 设置」调延时/音量/试听/模式/噪音
4. 网页点「开始录音」→ 当前音频自动从头播放 → 录完即停

### 从网页捕获音频

1. 在 `*.tsinghuaelt.com` 页面播放音频，右下角 ♪ 悬浮球角标显示捕获数（可拖动）
2. 点开悬浮球 → 列表自动收录页面 `<audio>/<video>` 元素与媒体网络请求
3. 「▶ 试听」直接播放原始地址；「＋ 加入音频库」下载后入库并设为当前音频
4. 播放新音频后点面板「刷新」发现更多；跨域受限的资源无法入库，列表中会标注失败原因

## 技术原理

### 音频图

```
recSrc(BufferSource) ──→ recGain ──→ recDest(MediaStreamDestination) ──→ 伪麦流
                    └──→ monGain  ──→ ctx.destination(扬声器试听)
noiseSrc(循环噪音)  ──→ noiseGain ──→ recDest(混入伪流，不进扬声器)
```

### 伪流生命周期

`recDest`一旦创建**尽量永远活着**，网页复用流不会拿到死流：

| 操作 | recDest | recSrc | 说明 |
|------|---------|--------|------|
| `startRecGraph` | 新建 | 新建 | 全量建图 |
| `ensureRecSrc` | **保留** | 重建 | 只换源，流不变 |
| `stopSrcOnly`(pause) | **保留** | 停 | 暂停但流活着 |
| `onended`(自然播完) | **保留** | 清 | 播完但流活着 |
| `stopRec` | 清 | 清 | 仅关闭注入/换文件时 |

### 自动播放三层触发

```
getUserMedia        ← 首次 init（只触发一次）
createMediaStreamSource ← 网页从伪流建 source
WebSocket            ← chivox startRecord
```

### API 包装

| 包装 | 作用 |
|------|------|
| `getUserMedia` | 返回伪流，隐藏真实麦克风 |
| `enumerateDevices` | 注入虚拟设备条目代替真麦 |
| `createMediaStreamSource` | 识别网页消费伪流，补充触发自动播放 |
| `WebSocket` | 拦截 chivox 连接评测服务器，触发自动播放 |

## 目录结构

```
manifest.json                       MV3 配置
background/background.js            SW：文件库(IndexedDB) + 状态 + 消息路由
content/content-main.js             主世界引擎：解码/建图/包装 API
content/content-bridge.js           ISOLATED 世界：SW ↔ 主世界中转
content/content-capture.js          网页音频捕获：扫描 + 悬浮控件 + 试听 + 入库
content/content-capture-main.js     捕获模块页面侧代理：fetch/试听
popup/ · settings/ · picker/        控制面板 / 设置 / 选文件
lib/idb.js                          IndexedDB 读写工具
assets/                             图标 + 内置噪音
```

## 快速验证

目标页 Console 执行：

```javascript
navigator.mediaDevices.getUserMedia({ audio: true }).then(async (s) => {
  console.log('track =', s.getAudioTracks()[0].label); // 应为本地音频
  const rec = new MediaRecorder(s), chunks = [];
  rec.ondataavailable = (e) => chunks.push(e.data);
  rec.onstop = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(chunks, { type: rec.mimeType }));
    a.download = 'vmic-test.webm'; a.click();
  };
  rec.start(); setTimeout(() => rec.stop(), 4000);
});
```

能下载到含插件音频的文件即链路打通。

## 调参与排障

| 现象 | 处理 |
|------|------|
| 录到空白/静音 | 确认列表有文件且能解码；确认录音时音频在播；加大「自动延时」 |
| 点「播放」没声音 | 先点页面任意位置授播放权再点播放；仍无声开 F12 查 `[VMIC]` 报错 |
| 开头被截断 | 调「自动延时」，每类任务试一次 |
| 检测麦克风时出声 | 正常现象，正式录音会从头重播 |
| 想用真实麦克风 | 设置页关闭「启用注入」 |
| 装好后没效果 | 确认 ≥ Chromium 111；**刷新评测页**；Console 确认 `getUserMedia` 已被包装 |
| 悬浮球没出现 | 重载扩展并强刷页面（Ctrl+F5）；Console 过滤 `[VMIC CAP]` 看是否注入 |
| 捕获入库失败 | 多为跨域受限（服务器不允许扩展页面外抓取），列表项会标注；试听不受影响可先听 |
| 评测页不在匹配域 | 改 `manifest.json` 的 `matches` 并重载 |

**已知边界**：仅覆盖装了本扩展的浏览器与匹配域名；页面若读 `track.getSettings()` 或对比设备真实信息仍可能识破；网站改版后可能失效。

## 数据模型

- **IndexedDB**（`vmic-db` / store `kv`）：`file:<id>` 音频二进制；`list` 播放列表元信息；`cur` 当前文件 id
- **状态**（`chrome.storage.session`）：`enabled/delayMs/volume/monitor/loop/mode/noiseOn/noiseVol`，随会话重置
- **消息**：`getState/setState/getAudio/getLib/addFile/addFileB64/selectAudio/removeAudio/transport`；主世界 ↔ bridge 用 `postMessage` + 固定 token
- **网页捕获模块**：`addFileB64`（base64 → `file:<id>`，content script 受 origin 限制不能直写 IndexedDB）；页面侧代理与捕获 UI 用独立 token `VMIC_CAPTURE_01`，与引擎零耦合
