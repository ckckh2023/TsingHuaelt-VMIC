// 默认页面
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

function renderState(st) {
  st = st || {};
  const el = $('stateLine');
  const enabled = !!st.enabled;
  el.classList.toggle('off', !enabled);
  const parts = [enabled ? '● 注入已启用' : '○ 注入已停用'];
  if (st.autoContinue) parts.push('自动连播');
  if (st.loop) parts.push('循环');
  el.textContent = parts.join(' · ');
}

function renderList() {
  const ul = $('list');
  ul.textContent = '';
  $('listMeta').textContent = list.length ? '（' + list.length + ' 项）' : '';
  syncClearBtn();
  if (!list.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = '还没有音频文件，点下方按钮添加';
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
    say('已切换为当前文件', 2500);
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

function resetClearBtn() {
  const b = $('btnClear');
  delete b.dataset.arm;
  b.classList.remove('confirm');
  b.textContent = '清空';
}
function syncClearBtn() {
  const b = $('btnClear');
  b.disabled = !list.length;
  if (!list.length) resetClearBtn();
}

async function clearAll() {
  const r = await send({ cmd: 'clearLib' });
  if (r && r.ok) {
    list = r.list || [];
    currentId = r.currentId || null;
    renderList();
    say('已清空全部音频', 2500);
  } else {
    say('清空失败：' + (r && r.error));
  }
}

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

$('btnClear').addEventListener('click', () => {
  const b = $('btnClear');
  if (!list.length) return;
  if (b.dataset.arm === '1') {
    clearAll();
  } else {
    b.dataset.arm = '1';
    b.classList.add('confirm');
    b.textContent = '确认？';
    setTimeout(() => {
      if (b.dataset.arm === '1') resetClearBtn();
    }, 2500);
  }
});

function transport(op) { return send({ cmd: 'transport', op }); }

$('btnPlay').addEventListener('click', async () => {
  if (!list.length) { say('列表为空，请先添加音频'); return; }
  await transport({ action: 'play' });
  say('已发送播放指令', 6000);
});
$('btnPause').addEventListener('click', () => transport({ action: 'pause' }));
$('btnRestart').addEventListener('click', () => {
  if (!list.length) { say('列表为空，添加音频'); return; }
  transport({ action: 'restart' });
  say('已重播', 2000);
});

$('btnPick').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('picker/picker.html') });
});

$('lnkSettings').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

(function () {
  const REPO = 'ckckh2023/TsingHuaelt-VMIC';
  function newer(a, b) {
    const pa = (a || '').split('.').map(Number);
    const pb = (b || '').split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      if ((pa[i] || 0) > (pb[i] || 0)) return true;
      if ((pa[i] || 0) < (pb[i] || 0)) return false;
    }
    return false;
  }
  $('lnkUpdate').addEventListener('click', async (e) => {
    e.preventDefault();
    const el = $('lnkUpdate');
    const old = el.textContent;
    el.textContent = '检查中…';
    try {
      const SOURCES = [
        'https://api.github.com/repos/' + REPO + '/releases/latest',
        'https://gitee.com/api/v5/repos/' + REPO + '/releases/latest',
        'https://gitcode.com/api/v5/repos/' + REPO + '/releases/latest',
      ];
      let data = null, used = '';
      for (const api of SOURCES) {
        try {
          const res = await fetch(api, { cache: 'no-store' });
          if (!res.ok) continue;
          data = await res.json();
          if (data && data.tag_name) { used = api; break; }
        } catch (_) {}
      }
      if (!data || !data.tag_name) throw new Error('所有更新源均不可用');
      const tag = (data.tag_name || '').replace(/^v/i, '');
      const cur = chrome.runtime.getManifest().version;
      if (newer(tag, cur)) {
        el.textContent = '新版本 ' + tag;
        let jump = data.html_url;
        if (!jump) {
          if (used.indexOf('gitee.com') >= 0) jump = 'https://gitee.com/' + REPO + '/releases/' + tag;
          else if (used.indexOf('gitcode.com') >= 0) jump = 'https://gitcode.com/' + REPO + '/releases/' + tag;
          else jump = 'https://github.com/' + REPO + '/releases/tag/' + tag;
        }
        window.open(jump, '_blank');
      } else {
        el.textContent = '已是最新';
      }
    } catch (err) {
      el.textContent = old;
      say('检查更新失败：' + (err.message || err), 3000);
    }
  });
})();

(async function init() {
  try {
    const [s, lib] = await Promise.all([send({ cmd: 'getState' }), send({ cmd: 'getLib' })]);
    if (s && s.ok) renderState(s.state);
    if (lib && lib.ok) { list = lib.list || []; currentId = lib.currentId; }
  } catch (e) {
    say('加载失败：' + e);
  }
  renderList();
})();
