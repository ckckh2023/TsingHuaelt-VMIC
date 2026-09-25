# 清英在线 · 虚拟麦克风（VMIC）

让 [清英在线](https://www.tsinghuaelt.com/) 的网页录音只能拿到**本插件注入的本地音频**，而非真实麦克风。

> **合规提示：** 仅建议用于自控的自动化测试、功能演示、无障碍辅助等场景。代做朗读/口语作业可能违反学校与平台规定，后果自负。

---

## 安装

- `chrome://extensions` 开启「开发者模式」
- 下载 Release 压缩包，解压后「加载已解压的扩展」
- 访问 `*.tsinghuaelt.com` 并登录

## 使用

- 打开扩展 ->「＋ 选择文件…」导入本地音频
- 点列表行切换当前文件
- 可以在左下「⚙ 设置」按钮调整

### 从网页捕获音频

- 在 `*.tsinghuaelt.com` 页面播放音频，右下角悬浮球可以捕获音频
-「＋ 加入音频库」下载后入库并设为当前音频

### 音频图

```
recSrc ──→ recGain ──→ recDest ──→ 伪麦流
              └──→ monGain  ──→ ctx.destination
noiseSrc  ──→ noiseGain ──→ recDest
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
| 录到空白或静音 | 确认列表有文件且能解码；确认录音时音频在播；加大「自动延时」 |
| 点「播放」没声音 | 先点页面任意位置授播放权再点播放；仍无声开 F12 查 `[VMIC]` 报错 |
| 开头被截断 | 调「自动延时」，每类任务试一次 |
| 检测麦克风时出声 | 正常现象，正式录音会从头重播 |
| 想用真实麦克风 | 设置页关闭「启用注入」 |
| 装好后没效果 | 确认 ≥ Chromium 111；**刷新评测页**；Console 确认 `getUserMedia` 已被包装 |
| 悬浮球没出现 | 重载扩展并强刷页面；Console 过滤 `[VMIC CAP]` 看是否注入 |
| 捕获入库失败 | 多为跨域受限，列表项会标注；试听不受影响可先听 |
| 评测页不在匹配域 | 改 `manifest.json` 的 `matches` 并重载 |

**已知边界**：仅覆盖装了本扩展的浏览器与匹配域名，网站改版后可能失效。
