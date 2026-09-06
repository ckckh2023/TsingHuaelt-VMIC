// 独立整页"选文件页"：把本地音频文件写进扩展自己的 IndexedDB。
// 支持两种来源：
//  1) "选择文件…"：多选文件；
//  2) "选择文件夹…"：整个文件夹（含子文件夹），只挑其中的音频文件。
// 设计：
//  - 整页不会被弹窗失焦关闭，读大文件不被打断；
//  - 二进制不进消息通道（避免 JSON 序列化把 File/Blob/ArrayBuffer 变成 {}），
//    本页直接结构化克隆到 file:<id>（读写工具 lib/idb.js）；
//  - 列表登记(list/cur)统一交给 SW 的 addFile 命令维护；批量导入用 silent
//    标记，只在最后一个文件后推送一次给打开的评测页面。
const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);
const { uid, fmtKB } = globalThis.VMIC;

const AUDIO_EXT = new Set([
  'mp3', 'wav', 'm4a', 'aac', 'oga', 'ogg', 'opus',
  'flac', 'webm', 'wma', 'amr'
]);

function isAudioFile(f) {
  if (f.type && f.type.startsWith('audio/')) return true;
  const i = f.name.lastIndexOf('.');
  return i >= 0 && AUDIO_EXT.has(f.name.slice(i + 1).toLowerCase());
}

function setStatus(text, ok) {
  const st = $('status');
  st.classList.toggle('ok', !!ok);
  st.textContent = text;
}

async function renderList() {
  const ul = $('list');
  ul.textContent = '';
  try {
    const r = await send({ cmd: 'getLib' });
    if (!r || !r.ok) throw new Error((r && r.error) || 'getLib 失败');
    const list = r.list || [];
    $('listMeta').textContent = list.length ? '（' + list.length + ' 项，高亮项为当前选中）' : '';
    if (!list.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = '（空）';
      ul.appendChild(li);
      return;
    }
    for (const it of list) {
      const li = document.createElement('li');
      li.dataset.id = it.id;
      if (it.id === r.currentId) li.className = 'cur';
      const nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = it.name;
      nm.title = it.name;
      li.appendChild(nm);
      if (it.id === r.currentId) {
        const flag = document.createElement('span');
        flag.className = 'flag';
        flag.textContent = '当前';
        li.appendChild(flag);
      }
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
  } catch (e) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = '读取列表失败：' + e;
    ul.appendChild(li);
  }
}

// source: 'files'（多选文件）| 'folder'（整个文件夹，过滤非音频）
async function addFiles(fileList, source) {
  const input = source === 'folder' ? $('folder') : $('file');
  let pool = Array.from(fileList || []);
  let skipped = 0;
  if (source === 'folder') {
    const good = [];
    for (const f of pool) {
      if (isAudioFile(f)) good.push(f);
      else skipped++;
    }
    pool = good;
  }
  if (!pool.length) {
    input.value = '';
    setStatus(source === 'folder'
      ? '该文件夹里没有找到可用音频（mp3/wav/m4a/aac/ogg/opus/flac/webm 等）'
      : '没有可添加的文件', false);
    renderList();
    return;
  }

  let added = 0;
  const failed = [];
  let lastOkId = null;
  for (let i = 0; i < pool.length; i++) {
    const f = pool[i];
    const disp = f.webkitRelativePath || f.name;
    try {
      setStatus('正在添加 ' + (i + 1) + '/' + pool.length + '：' + disp + ' …');
      const buf = await f.arrayBuffer();
      const id = uid();
      const mime = f.type || 'audio/mpeg';
      await idbPut('file:' + id, { buf, mime, name: disp });
      // silent：批量时只有最后一个触发页面推送，避免反复全量 base64
      const r = await send({
        cmd: 'addFile',
        file: { id, name: disp, size: buf.byteLength, mime },
        silent: i < pool.length - 1
      });
      if (r && r.ok) {
        added++;
        lastOkId = id;
      } else {
        failed.push(disp + '(登记失败)');
        await idbDel('file:' + id).catch(() => {});
      }
    } catch (e) {
      failed.push(disp);
    }
  }
  input.value = ''; // 允许再次选择同名文件/同一文件夹

  // 兜底：全部成功时最后一条已 silent:false 推送过；
  // 若部分失败导致"最后一个文件"没推送成功，把当前(cur=最后成功项)补推一次
  if (failed.length && lastOkId) {
    await send({ cmd: 'selectAudio', id: lastOkId }).catch(() => {});
  }

  const parts = [];
  if (added) parts.push('成功添加 ' + added + ' 个音频并设为当前音频文件');
  if (skipped) parts.push('跳过 ' + skipped + ' 个非音频文件');
  if (failed.length) parts.push('失败 ' + failed.length + ' 个：' + failed.slice(0, 3).join('、') + (failed.length > 3 ? ' 等' : ''));
  setStatus(parts.join('；') || '未添加任何文件', !failed.length && (added > 0));
  await renderList();
}

// 列表删除（与主页一致：✕ 二次确认，删除当前文件自动切到第一项）
async function removeItem(id) {
  const r = await send({ cmd: 'removeAudio', id });
  if (r && r.ok) {
    setStatus('已删除' + (r.currentId ? '' : '，列表已清空'), true);
  } else {
    setStatus('删除失败：' + (r && r.error), false);
  }
  await renderList();
}

$('list').addEventListener('click', (e) => {
  const rmBtn = e.target.closest('.rm');
  if (!rmBtn) return;
  const li = rmBtn.closest('li');
  if (!li || !li.dataset.id) return;
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
});

$('btnFiles').addEventListener('click', () => $('file').click());
$('btnFolder').addEventListener('click', () => $('folder').click());
$('file').addEventListener('change', () => {
  if ($('file').files && $('file').files.length) addFiles($('file').files, 'files');
});
$('folder').addEventListener('change', () => {
  if ($('folder').files && $('folder').files.length) addFiles($('folder').files, 'folder');
});

renderList();
