# 清华社英语在线 · 虚拟麦克风（VMIC）

MV3 Chromium 扩展原型：让 [清华社英语在线](https://www.tsinghuaelt.com/) 的网页录音只能拿到**本插件注入的本地音频**。

> ⚠️ 合规提示：本工具仅建议用于**你自己可控的自动化测试、功能演示、无障碍辅助**等场景。
> 若用于替自己/他人代做平台上的朗读或口语作业，可能违反学校与平台规定，请自行评估后果。

---

## 一、可行度结论（针对本站的调研证据）

该站是 Vue3 SPA，评测相关的两个引擎**都在调用时动态读取
`navigator.mediaDevices.getUserMedia`**，因此只需在 `document_start` 时机、以
`world: "MAIN"` 注入一个包装函数，就能同时覆盖两条录音链路：

| 引擎 | 文件 | 取流方式 | 结论 |
|---|---|---|---|
| MP3Recorder（录音上传类评测） | `/speech-assess/recordmp3.js` | `initSourceNode()` 里**动态**调 `navigator.mediaDevices.getUserMedia({audio})`，再 `createMediaStreamSource` 进 ScriptProcessor 编码 MP3 | ✅ 可被包装覆盖 |
| Chivox 驰声 SDK（实时流评测） | `/speech-assess/chivox/chivox-6.1.3-min.js` | SDK 自己**动态**调 `navigator.mediaDevices.getUserMedia({audio:true})` 后经 WebSocket 实时上传 | ✅ 可被包装覆盖 |

三模块 ↔ 本实现映射：

1. **输入模块（音频来自本地）**：popup 里 `<input type="file">` 选本地 mp3/wav 等 →
   `ArrayBuffer` → service worker 存入 `chrome.storage.session` → 经 bridge 转进页面主世界
   → `decodeAudioData` 解码成 `AudioBuffer`（一进页面就开始解码，录音时零等待）。
2. **处理模块（伪装成麦克风）**：页面主世界里用 WebAudio 建图：
   `BufferSource → recGain(音量) → MediaStreamDestination`（这就是伪装成的麦克风流，
   **音频轨恒存在**，杜绝"无麦克风"误报）；同一声源另接
   `monGain → ctx.destination` 做**外放试听**——录到哪一路就能从扬声器听到哪一路，
   当作"开始播放"的听觉提示（popup 可关）。
3. **输出模块（网页只能拿到插件音频）**：包装 `getUserMedia`（纯音频请求一律返回伪流；
   同时要视频时=真摄像头+伪音频），并包装 `enumerateDevices` 隐藏真实麦克风。

> 为什么不用 `<audio>.captureStream()`（v0.1 做法）：
> ① 元素 `play()` 受浏览器自动播放策略限制，扩展消息触发的播放会被静默拒绝（表现为点播放没声音）；
> ② 流依赖元素加载完成，音频未就绪时返回的流可能无音频轨，站点 `createMediaStreamSource`
> 会抛错并被显示成"无麦克风/权限错误"。v0.2 全链路走 AudioContext，两个问题都不存在。

## 二、为什么必须“主世界注入”

`MediaStream` 无法跨扩展上下文传递，也不存在“把扩展注册成网页可见虚拟麦克风”的官方 API。
页面代码拿到的流必须诞生在**页面自己的 JS 环境**里，所以核心逻辑放在 `world: "MAIN"`
的内容脚本中；`world: "ISOLATED"` 的 bridge 只负责与扩展后台通信（需要 Chrome/Edge ≥ 111）。

## 三、安装

1. 打开 `chrome://extensions`（Edge 为 `edge://extensions`），开启“开发者模式”；
2. “加载已解压的扩展程序” → 选择本目录 `tsinghuaelt-vmic`；
3. 访问 `https://www.tsinghuaelt.com` 并登录（评测页必须在 `*.tsinghuaelt.com` 下）。

## 四、使用步骤

1. 打开扩展 popup，点 **“选择 / 更换音频文件…”**（会打开整页设置页，弹窗里直接选文件会被
   Chrome 因失焦关闭而失败，已改到设置页）；
2. 在设置页选本地 mp3/wav 文件，看到“已保存”即可关掉设置页；
3. 回 popup 勾选 **启用注入**；
4. 回到网页点“开始录音/开始朗读”——录音请求触发时音频会**从头自动播放**（先静音
   `delayMs` 毫秒再出声，用于对齐站内倒计时）；
5. 录完即停（页面关闭伪流时音频自动暂停）。

**手动模式**：若某些流程页面会先做“麦克风检测/预热”导致自动播放时机不对，把 popup 的
播放方式切到“手动”，在网页提示“开始朗读”时点 popup 的 **播放/重播**。

## 五、快速验证（在目标页 Console 执行）

```js
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

能下载到包含插件音频的文件即链路打通。随后按真实评测任务微调。

## 六、调参与已知限制

| 问题 | 处理 |
|---|---|
| 录到的是空白/静音 | 确认已选文件且能解码；确认页面录音期间音频确实在播（开“外放试听”能听到）；加大“自动延时” |
| 点“播放”没声音 | 先在页面上点一下任意位置（授予站点播放权），再点播放；仍无声请开 F12 看是否有 `[VMIC]` 报错 |
| 开始部分被截断/提前出声 | 调“自动延时”（建议 0–2000ms），每类任务试一次 |
| 页面先做“检测麦克风” | 检测时自动模式也会出声一次（属正常预热），正式录音会从头重播；嫌吵可切“手动” |
| 站点提示“无麦克风/权限错误” | v0.2 已消除（音频轨恒存在）。若仍出现，打开 F12 Console 看报错文字与 `[VMIC]` 日志发给我 |
| 声音太小/太大 | 调 popup 音量（同时影响录音与试听） |
| 不需要外放监听 | 关掉 popup 的“外放试听” |
| 大文件 | 二进制存扩展 IndexedDB（非 chrome.storage，无 10MB JSON 限制），受磁盘与解码耗时影响，建议 ≤20MB |
| 之前版本报 `buf.slice is not a function` | 旧版误把 ArrayBuffer 存进 JSON 序列化的 chrome.storage 所致；0.2.1 起改存 IndexedDB 已修复 |
| 文件源会不会被自动改动/清空？ | **不会**。保证幂等：只有重新选文件才会更新；重复录音/刷新页面/开关设置都不会重解码或清空当前文件；收到空数据也一律保留现有文件源 |
| 选完文件弹窗自动关闭、重开又要重传？ | Chrome 会因文件选择器抢焦点而关闭 popup。0.3.0 起文件选择移到**整页设置页**，直接写扩展 IndexedDB，弹窗关不关、网页刷不刷都不丢失，无需重传 |
| 消息里能传 File/Blob 吗？ | **不能**。`chrome.runtime` 消息默认 JSON 序列化，File/Blob/ArrayBuffer 会被破坏（File/Blob→`{}`）。本扩展二进制只存 IndexedDB，跨上下文一律走 base64 字符串 |
| 评测页不在 `*.tsinghuaelt.com`（如学校域名/跨域 iframe） | 改 `manifest.json` 的 `matches` 并重新加载扩展 |
| 装好后没效果 | 确认 ≥Chrome 111；刷新页面（`document_start` 才注入）；Console 确认 `navigator.mediaDevices.getUserMedia` 已被包装 |

已知边界（JS 层伪装的固有限制）：
- 只覆盖装了这个扩展的浏览器与匹配域名；换设备/换浏览器需重装；
- 页面若读取 `track.getSettings()`/对比设备真实信息仍可能识破（本站两个引擎目前不校验）；
- 网站改版后可能失效，属于猫鼠游戏；上架 Chrome Web Store 有审核政策风险，建议自用/内部用。

## 七、文件清单

```
manifest.json           MV3 配置（两路内容脚本：MAIN + ISOLATED；options_ui 整页设置）
content-main.js         主世界 v0.3：AudioContext 引擎（base64 解码/建图/试听）+ getUserMedia/enumerateDevices 包装
content-bridge.js       isolated 世界：SW ↔ 主世界 中转
background.js           service worker：IndexedDB 音频仓库 + base64 编码 + 命令路由
options.html/.js        整页设置页：选择本地音频 → 直接写 IndexedDB
popup.html/.css/.js     开关、延时/音量/模式/试听/循环、播放控制、打开设置页
```
