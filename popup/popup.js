// popup = 默认页面：播放列表 + 选择文件 + 播放控制。
// 其余设置（启用开关/模式/延时/音量/试听/循环）在独立整页 settings.html。
const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);
const { fmtKB } = globalThis.VMIC;

let list = [];         // [{id,name,size,mime}]
let currentId = null;  // 当前文件 id

function say(text, ms) {
  $('status').textContent = text;
  if (ms) setTimeout(() => {
    if ($('status').textContent === text) $('status').textContent = '';
  }, ms);
}

function renderState(enabled) {
  const el = $('stateLine');
  el.classList.toggle('off', !enabled);
  el.textContent = enabled
    ? '● 注入已启用：本站录音将拿到插件音频'
    : '○ 注入已停用：本站走真实麦克风（到“设置”开启）';
}

function renderList() {
  const ul = $('list');
  ul.textContent = '';
  $('listMeta').textContent = list.length ? '（' + list.length + ' 项）' : '';
  if (!list.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = '还没有音频文件，点“选择文件”添加';
    ul.appendChild(li);
    return;
  }
  for (const it of list) {
    const li = document.createElement('li');
    li.dataset.id = it.id;
    if (it.id === currentId) li.className = 'cur';

    const dot = document.createElement('span');
    dot.className = 'dot';
    li.appendChild(dot);

    if (it.id === currentId) {
      const flag = document.createElement('span');
      flag.className = 'flag';
      flag.textContent = '当前';
      li.appendChild(flag);
    }

    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = it.name;
    nm.title = it.name;
    li.appendChild(nm);

    const sz = document.createElement('span');
    sz.className = 'sz';
    sz.textContent = fmtKB(it.size);
    li.appendChild(sz);

    const rm = document.createElement('button');
    rm.className = 'rm';
    rm.textContent = '✕';
    rm.title = '删除';
    li.appendChild(rm);

    ul.appendChild(li);
  }
}

async function selectItem(id) {
  const r = await send({ cmd: 'selectAudio', id });
  if (r && r.ok) {
    list = r.list;
    currentId = r.currentId;
    renderList();
    say('已切换“当前文件”', 2500);
  } else {
    say('切换失败：' + (r && r.error));
  }
}

async function removeItem(id) {
  const r = await send({ cmd: 'removeAudio', id });
  if (r && r.ok) {
    list = r.list;
    currentId = r.currentId;
    renderList();
  } else {
    say('删除失败：' + (r && r.error));
  }
}

// 列表点击：行=切换当前；✕=删除（两段式确认，防误触）
$('list').addEventListener('click', (e) => {
  const li = e.target.closest('li');
  if (!li || !li.dataset.id) return;
  const rmBtn = e.target.closest('.rm');
  if (rmBtn) {
    if (rmBtn.dataset.arm === '1') {
      removeItem(li.dataset.id);
    } else {
      rmBtn.dataset.arm = '1';
      rmBtn.classList.add('confirm');
      rmBtn.textContent = '确认？';
      setTimeout(() => {
        delete rmBtn.dataset.arm;
        rmBtn.classList.remove('confirm');
        rmBtn.textContent = '✕';
      }, 2500);
    }
    return;
  }
  if (li.dataset.id !== currentId) selectItem(li.dataset.id);
});

function transport(op) { return send({ cmd: 'transport', op }); }

$('btnPlay').addEventListener('click', async () => {
  if (!list.length) { say('列表为空，请先“选择文件”添加音频'); return; }
  await transport({ action: 'play' });
  say('已发送播放指令。若仍无声：先在页面上点一下（授权播放）再点播放', 6000);
});
$('btnPause').addEventListener('click', () => transport({ action: 'pause' }));
$('btnRestart').addEventListener('click', () => {
  if (!list.length) { say('列表为空，请先“选择文件”添加音频'); return; }
  transport({ action: 'restart' });
  say('已重播', 2000);
});

$('btnPick').addEventListener('click', () => {
  // 弹窗内选文件会被文件选择器抢焦点关闭，改到独立整页 picker.html
  chrome.tabs.create({ url: chrome.runtime.getURL('picker/picker.html') });
});

$('lnkSettings').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage(); // options_ui = settings 设置页
});

(async function init() {
  try {
    const [s, lib] = await Promise.all([send({ cmd: 'getState' }), send({ cmd: 'getLib' })]);
    if (s && s.ok) renderState(!!s.state.enabled);
    if (lib && lib.ok) { list = lib.list || []; currentId = lib.currentId; }
  } catch (e) {
    say('加载失败：' + e);
  }
  renderList();
})();
