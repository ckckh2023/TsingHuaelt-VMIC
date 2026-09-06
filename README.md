# 清英在线 · 虚拟麦克风（VMIC）

让 [清英在线](https://www.tsinghuaelt.com/) 的网页录音只能拿到**本插件注入的本地音频**——而不是真实麦克风。

支持**多文件播放列表**，默认启用注入，界面拆分为「控制面板 / 设置 / 选文件」三个独立页面。

> **合规提示：**
> 本工具仅建议用于**你自己可控**的自动化测试、功能演示、无障碍辅助等场景。
> 若用于替自己/他人代做平台上的朗读或口语作业，**可能违反学校与平台规定**，请自行评估后果；
> 本项目按 MIT 许可提供，作者不对使用方式负责。不建议上架公共商店。

---

## 功能特性

- **默认启用独占注入**：不启用时本扩展完全无法发挥作用，故默认开启；想临时切回真实麦克风，在设置页关闭即可。
- **多文件播放列表**：可随时添加多个本地音频，当前文件即网页录音会拿到的那一个，点行即可切换
- **列表管理**：当前项高亮；删除走二次确认；删除当前文件自动切到列表第一项
- **播放控制**：播放 / 暂停 / 重播三个主按钮；自动模式网站一请求录音即从头播放，手动模式由你点播放
- **处理与试听**：AudioContext 全链路，音频轨恒存在；可选外放试听、调节音量循环
- 兼容 Chromium ≥ 111；二进制只存 IndexedDB，跨上下文走 base64，无 JSON 序列化破坏问题

## 技术原理

### 调研结论

清英在线是 Vue3 SPA 结构，评测相关的两个引擎**都在调用时动态读取 `navigator.mediaDevices.getUserMedia`**，因此只需在 `document_start` 时机以 `world: "MAIN"`注入包装函数，即可同时覆盖两条录音链路

`MediaStream` 无法跨扩展上下文传递，也没有「把扩展注册成网页可见虚拟麦克风」的官方 API。网页代码拿到的流必须诞生在**页面自己的 JS 环境**里，所以核心逻辑放在 `world: "MAIN"`内容脚本中；`world: "ISOLATED"` 的 bridge 只负责与扩展后台通信。

### 音频链路

- **输入**：picker 页把本地 mp3/wav 等直接写入 IndexedDB 文件库 → bridge 转进页面主世界 → `decodeAudioData` 解码成 `AudioBuffer`。
- **处理**：页面主世界用 WebAudio 建图 `BufferSource → recGain(音量) → MediaStreamDestination`（即伪装成的麦克风流，**音频轨恒存在**）；同一声源另接 `monGain → ctx.destination` 做外放试听。
- **输出**：包装 `getUserMedia` ，纯音频请求一律返回伪流，并包装 `enumerateDevices` 隐藏真实麦克风、以虚拟设备条目代替。

## 目录结构

```
.
├── manifest.json                      MV3 配置
├── LICENSE                            MIT 许可
├── README.md
├── assets/icon.png                    128×128 麦克风图标（16/32/48/128 共用）
├── lib/idb.js                         SW 与整页共用的 IndexedDB 读写工具
├── background/background.js           service worker：文件库(list/cur) + base64 + 状态与消息路由
├── content/
│   ├── content-main.js                主世界引擎：解码/建图/试听 + getUserMedia/enumerateDevices 包装
│   └── content-bridge.js              ISOLATED 世界：SW ↔ 主世界 中转
├── popup/popup.html · .css · .js      控制面板（默认页）
├── settings/settings.html · .css · .js  设置页
└── picker/picker.html · .css · .js    选文件页
```

## 安装

1. 打开 `chrome://extensions`（Edge 为 `edge://extensions`），开启「开发者模式」；
2. 从 `Release` 下载最新版本压缩包，解压到特定目录；
3. 在浏览器插件页面选择加载解压缩的扩展，选择解压即可安装；
4. 访问 `https://www.tsinghuaelt.com` 并登录（评测页必须在 `*.tsinghuaelt.com` 下）。

## 使用

1. 打开扩展 popup；
2. 首次使用点「＋ 选择文件…」→ 在选文件页 `选择文件…` 或 `选择文件夹…`
3. 点列表行可随时**切换当前文件**；点 ✕ 可删除；
4. 需要延时对齐 / 音量 / 外放试听 / 模式时，点 popup 左下「⚙ 设置」；
5. 回到网页点「开始录音/开始朗读」——录音请求触发时当前音频**从头自动播放**（先静音 `delayMs` 毫秒再出声，用于对齐站内倒计时）；录完即停。
6. 若流程页会先做「麦克风检测/预热」导致自动播放时机不对：设置页把模式切到「手动」，在提示开始时回 popup 点「播放/重播」。

## 快速验证

在目标页 Console 执行：

```javascript
navigator.mediaDevices.getUserMedia({ audio: true }).then(async (s) => {
  console.log('track label =', s.getAudioTracks()[0].label); // 应为本地音频而非真实麦克风
  console.log('devices =', await navigator.mediaDevices.enumerateDevices());
  const rec = new MediaRecorder(s);
  const chunks = [];
  rec.ondataavailable = (e) => chunks.push(e.data);
  rec.onstop = () => {
    const url = URL.createObjectURL(new Blob(chunks, { type: rec.mimeType }));
    const a = document.createElement('a');
    a.href = url; a.download = 'vmic-test.webm'; a.click();
  };
  rec.start(); setTimeout(() => rec.stop(), 4000);
});
```

能下载到包含插件音频的文件即链路打通，随后按真实评测任务微调。

## 调参与已知限制

| 现象 | 处理 |
|---|---|
| 录到的是空白/静音 | 确认列表里已有文件且能解码；确认录音期间音频确实在播；加大「自动延时」 |
| 点「播放」没声音 | 先在页面上点一下任意位置（授予站点播放权）再点播放；仍无声请开 F12 看是否有 `[VMIC]` 报错 |
| 开头被截断/提前出声 | 设置页调「自动延时」，每类任务试一次 |
| 页面先做「检测麦克风」 | 检测时自动模式也会出声一次，此为正常现象，正式录音从头重播 |
| 声音太小/太大 或 想关监听 | 设置页调「音量」/「外放试听」 |
| 导入的文件夹文件很多 | 文件顺序逐个读入（有进度提示）；非音频自动跳过；建议单文件 ≤20MB |
| 文件源会不会被自动改动/清空 | **不会**。只有主动添加/切换/删除才会变化；重复录音、刷新、开关设置都不重解码不清空 |
| 想临时用真实麦克风 | 设置页关闭「启用注入」 |
| 消息里能传 File/Blob 吗 | 不能，`chrome.runtime` 消息是 JSON 序列化；二进制只存 IndexedDB，跨上下文走 base64 |
| 评测页不在 `*.tsinghuaelt.com` | 改 `manifest.json` 的 `matches` 并重新加载扩展 |
| 装好后没效果 | 确认 ≥ Chromium 111；**刷新评测页面**；Console 确认 `getUserMedia` 已被包装 |

**已知边界（JS 层伪装的固有限制）**：只覆盖装了本扩展的浏览器与匹配域名，换设备/浏览器需重装；
页面若读取 `track.getSettings()` 或对比设备真实信息仍可能识破；网站改版后可能失效。

## 数据与消息模型（开发者须知）

- **IndexedDB（store `kv`，库名 `vmic-db`）**：`file:<id>` 音频二进制 `{buf,mime,name}`；
  `list` 播放列表元信息 `[{id,name,size,mime,addedAt}]`；`cur` 当前文件 id。
- **状态（`chrome.storage.session`）**：`enabled/delayMs/volume/monitor/loop/mode`，随浏览器
  会话重置回默认值（`enabled:true`）。
- **消息命令**：`getState / setState / getAudio / getLib / addFile / selectAudio / removeAudio /
  transport`（后台 → 页面同步走 `pageSync`；主世界 ↔ bridge 用 `window.postMessage` + 固定 token）。
- 设置/文件选择都在**整页**完成。
