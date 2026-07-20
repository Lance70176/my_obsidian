const fs = require('fs');
const os = require('os');
const path = require('path');
const { ipcRenderer, webUtils } = require('electron');
const { createRenderer } = require('../lib/markdown');
const { renderNoteHtml, exportVault, walkVault, buildNoteIndex } = require('../lib/exporter');
const { syncToVault } = require('../lib/claude-sync');

const $ = (id) => document.getElementById(id);
const els = {
  vaultName: $('vault-name'),
  tree: $('file-tree'),
  filter: $('tree-filter'),
  main: $('main'),
  empty: $('empty-state'),
  editorPane: $('editor-pane'),
  previewPane: $('preview-pane'),
  editor: $('editor'),
  editorHl: $('editor-highlights'),
  preview: $('preview'),
  statusFile: $('status-file'),
  statusCount: $('status-count'),
  statusSave: $('status-save')
};

const state = {
  vault: null,
  file: null,          // absolute path of the open note
  dirty: false,
  mode: localStorage.getItem('mode') || 'split',
  theme: localStorage.getItem('theme') || 'dark',
  sort: localStorage.getItem('sortMode') || 'name-asc',
  mtimes: new Map(),
  ctimes: new Map(),
  resolveNote: () => null,
  expanded: new Set(JSON.parse(localStorage.getItem('expanded') || '[]')),
  staged: JSON.parse(localStorage.getItem('stagedFiles') || '[]'),
  manualOrder: JSON.parse(localStorage.getItem('manualOrder') || '{}')
};

let autosaveTimer = null;
let previewTimer = null;
let vaultWatcher = null;
let watchTimer = null;

/* ---------------- modal helpers ---------------- */

let modalOpen = false;

function modal({ title, message = '', input = null, okLabel = '確定', danger = false }) {
  // A second modal while one is open would steal the first one's button
  // handlers and leave it unresponsive — refuse instead.
  if (modalOpen) return Promise.resolve(null);
  modalOpen = true;
  return new Promise((resolve) => {
    const overlay = $('modal-overlay');
    const inputEl = $('modal-input');
    $('modal-title').textContent = title;
    $('modal-msg').textContent = message;
    inputEl.hidden = input === null;
    inputEl.value = input || '';
    const ok = $('modal-ok');
    ok.textContent = okLabel;
    ok.classList.toggle('primary', !danger);
    ok.style.background = danger ? 'var(--danger)' : '';
    overlay.hidden = false;
    if (input !== null) {
      inputEl.focus();
      const dot = inputEl.value.lastIndexOf('.');
      inputEl.setSelectionRange(0, dot > 0 ? dot : inputEl.value.length);
    } else {
      ok.focus();
    }
    function close(result) {
      overlay.hidden = true;
      modalOpen = false;
      ok.onclick = $('modal-cancel').onclick = inputEl.onkeydown = overlay.onclick = null;
      resolve(result);
    }
    ok.onclick = () => close(input !== null ? inputEl.value.trim() : true);
    $('modal-cancel').onclick = () => close(null);
    overlay.onclick = (e) => { if (e.target === overlay) close(null); };
    inputEl.onkeydown = (e) => {
      if (e.key === 'Enter') close(inputEl.value.trim());
      if (e.key === 'Escape') close(null);
    };
  });
}

const promptModal = (title, defaultValue = '') => modal({ title, input: defaultValue });
const confirmModal = (title, message) => modal({ title, message, okLabel: '刪除', danger: true });

/* ---------------- vault / file tree ---------------- */

function openVaultDialog() {
  ipcRenderer.invoke('choose-vault').then((dir) => { if (dir) loadVault(dir); });
}

function loadVault(dir) {
  if (!fs.existsSync(dir)) return;
  state.vault = dir;
  localStorage.setItem('lastVault', dir);
  els.vaultName.textContent = path.basename(dir);
  document.title = `MyObsidian — ${path.basename(dir)}`;
  refreshTree();
  watchVault(dir);
  syncClaudeMemory(true);
  const lastFile = localStorage.getItem('lastFile');
  const known = lastFile && (lastFile.startsWith(dir + path.sep) || state.staged.includes(lastFile));
  if (known && fs.existsSync(lastFile)) {
    openFile(lastFile);
  } else {
    showEmpty(false);
  }
}

function refreshTree() {
  const { notes } = walkVault(state.vault, null);
  state.resolveNote = buildNoteIndex(notes);
  state.mtimes = new Map();
  state.ctimes = new Map();
  for (const rel of notes) {
    try {
      const st = fs.statSync(path.join(state.vault, ...rel.split('/')));
      state.mtimes.set(rel, st.mtimeMs);
      state.ctimes.set(rel, st.birthtimeMs || st.ctimeMs);
    } catch {
      state.mtimes.set(rel, 0);
      state.ctimes.set(rel, 0);
    }
  }
  renderTree(notes);
  schedulePreview();
}

// Snapshot of the current note set — used to tell an added/removed/renamed
// file (which must refresh the tree) from a content-only edit (which need not).
function noteSetKey(notes) {
  return [...notes].sort().join('\n');
}

// Watch the vault so files created/deleted/renamed outside the app (Finder,
// sync, another editor) appear in the sidebar without a manual refresh. A
// recursive watch fires a burst of events, so debounce; and only re-render
// when the note *set* actually changed, to avoid churn on every autosave.
function watchVault(dir) {
  if (vaultWatcher) {
    vaultWatcher.close();
    vaultWatcher = null;
  }
  try {
    vaultWatcher = fs.watch(dir, { recursive: true }, () => {
      clearTimeout(watchTimer);
      watchTimer = setTimeout(() => {
        if (!state.vault) return;
        try {
          const before = noteSetKey([...state.mtimes.keys()]);
          const { notes } = walkVault(state.vault, null);
          if (noteSetKey(notes) !== before) refreshTree();
        } catch { /* vault may be mid-move; ignore and wait for the next event */ }
      }, 300);
    });
  } catch { /* recursive watch unsupported or dir unreadable — skip live refresh */ }
}

/* ---- 檔案排序 ---- */

const SORT_MODES = [
  ['name-asc', '名稱（A→Z）'],
  ['name-desc', '名稱（Z→A）'],
  ['mtime-desc', '修改時間（新→舊）'],
  ['mtime-asc', '修改時間（舊→新）'],
  ['ctime-desc', '建立時間（新→舊）'],
  ['ctime-asc', '建立時間（舊→新）'],
  ['manual', '自訂（拖曳排序）']
];

function sortFiles(rels) {
  const arr = [...rels];
  switch (state.sort) {
    case 'name-desc':
      return arr.sort((a, b) => b.localeCompare(a, 'zh-Hant'));
    case 'mtime-desc':
      return arr.sort((a, b) => (state.mtimes.get(b) || 0) - (state.mtimes.get(a) || 0));
    case 'mtime-asc':
      return arr.sort((a, b) => (state.mtimes.get(a) || 0) - (state.mtimes.get(b) || 0));
    case 'ctime-desc':
      return arr.sort((a, b) => (state.ctimes.get(b) || 0) - (state.ctimes.get(a) || 0));
    case 'ctime-asc':
      return arr.sort((a, b) => (state.ctimes.get(a) || 0) - (state.ctimes.get(b) || 0));
    default:
      return arr.sort((a, b) => a.localeCompare(b, 'zh-Hant'));
  }
}

function setSort(mode) {
  state.sort = mode;
  localStorage.setItem('sortMode', mode);
  refreshTree();
}

function fmtMtime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// 側欄檔名右側的短日期:今年只顯示月/日,跨年才帶年份。
function fmtDateShort(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  const md = `${p(d.getMonth() + 1)}/${p(d.getDate())}`;
  return d.getFullYear() === new Date().getFullYear() ? md : `${d.getFullYear()}/${md}`;
}

// Build a nested {folders, files} structure from vault-relative note paths.
function buildTree(noteRelPaths) {
  const root = { folders: new Map(), files: [] };
  for (const rel of noteRelPaths) {
    const parts = rel.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node.folders.has(parts[i])) node.folders.set(parts[i], { folders: new Map(), files: [] });
      node = node.folders.get(parts[i]);
    }
    node.files.push(rel);
  }
  return root;
}

function renderTree(notes) {
  updateCollapseBtn();
  const filter = els.filter.value.trim().toLowerCase();
  els.tree.textContent = '';
  if (filter) {
    for (const rel of sortFiles(notes.filter((r) => r.toLowerCase().includes(filter)))) {
      els.tree.appendChild(fileItem(rel, rel.replace(/\.(md|markdown)$/i, '')));
    }
    return;
  }
  els.tree.appendChild(renderNode(buildTree(notes), ''));
}

// 自訂排序:依儲存的手動順序排,沒記錄過的項目照名稱附在後面。
function manualNames(parentRel, names) {
  const rec = state.manualOrder[parentRel] || {};
  // 相容早期 {folders, files} 分開存的格式:合併成單一混排順序(資料夾在前)
  const saved = rec.order || [...(rec.folders || []), ...(rec.files || [])];
  const idx = new Map(saved.map((n, i) => [n, i]));
  return [...names].sort((a, b) => {
    const ia = idx.has(a) ? idx.get(a) : Infinity;
    const ib = idx.has(b) ? idx.get(b) : Infinity;
    return ia !== ib ? ia - ib : a.localeCompare(b, 'zh-Hant');
  });
}

function renderNode(node, relBase) {
  const frag = document.createDocumentFragment();
  const appendFolder = (name) => {
    const rel = relBase ? `${relBase}/${name}` : name;
    const isOpen = state.expanded.has(rel);
    const item = document.createElement('div');
    item.className = 'tree-item folder';
    item.dataset.folder = rel;
    item.innerHTML = `<span class="icon chevron${isOpen ? ' open' : ''}"><svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg></span><span class="name"></span>`;
    item.querySelector('.name').textContent = name;
    item.onclick = () => {
      state.expanded.has(rel) ? state.expanded.delete(rel) : state.expanded.add(rel);
      localStorage.setItem('expanded', JSON.stringify([...state.expanded]));
      refreshTree();
    };
    item.oncontextmenu = (e) => showContextMenu(e, { type: 'folder', rel });
    enableTreeDrag(item, rel);
    frag.appendChild(item);
    if (isOpen) {
      const children = document.createElement('div');
      children.className = 'tree-children';
      children.appendChild(renderNode(node.folders.get(name), rel));
      frag.appendChild(children);
    }
  };
  const appendFile = (rel) => {
    frag.appendChild(fileItem(rel, rel.split('/').pop().replace(/\.(md|markdown)$/i, '')));
  };
  const folderNames = [...node.folders.keys()].sort((a, b) => a.localeCompare(b, 'zh-Hant'));
  if (state.sort === 'manual') {
    // 自訂模式:同一層的資料夾與檔案混排,像根目錄只有一個檔案(Home)時
    // 也能拖到各資料夾之間;檔名鍵帶副檔名,不會和同名資料夾撞名。
    const names = [...folderNames, ...sortFiles(node.files).map((r) => r.split('/').pop())];
    for (const name of manualNames(relBase, names)) {
      if (node.folders.has(name)) appendFolder(name);
      else appendFile(relBase ? `${relBase}/${name}` : name);
    }
  } else {
    for (const name of folderNames) appendFolder(name);
    for (const rel of sortFiles(node.files)) appendFile(rel);
  }
  return frag;
}

function fileItem(rel, label) {
  const abs = path.join(state.vault, ...rel.split('/'));
  const item = document.createElement('div');
  item.className = 'tree-item file' + (abs === state.file ? ' active' : '');
  item.dataset.file = rel;
  item.innerHTML = `<span class="icon"></span><span class="name"></span>`;
  item.querySelector('.name').textContent = label;
  // 依日期排序時,檔名右側顯示排序依據的日期(修改或建立)。
  if (state.sort.startsWith('mtime') || state.sort.startsWith('ctime')) {
    const ms = state.sort.startsWith('ctime') ? state.ctimes.get(rel) : state.mtimes.get(rel);
    const date = document.createElement('span');
    date.className = 'date';
    date.textContent = fmtDateShort(ms);
    item.appendChild(date);
  }
  const mtime = fmtMtime(state.mtimes.get(rel));
  const ctime = fmtMtime(state.ctimes.get(rel));
  item.title = [rel, mtime && `修改：${mtime}`, ctime && `建立：${ctime}`].filter(Boolean).join('\n');
  item.onclick = () => openFile(abs);
  item.oncontextmenu = (e) => showContextMenu(e, { type: 'file', rel });
  enableTreeDrag(item, rel);
  return item;
}

/* ---------------- 側欄拖曳排序(自訂排序) ---------------- */

let treeDrag = null; // { rel, parent, name }

const parentOf = (rel) => rel.split('/').slice(0, -1).join('/');

function clearDropMarks() {
  for (const el of document.querySelectorAll('.tree-item.drop-before, .tree-item.drop-after')) {
    el.classList.remove('drop-before', 'drop-after');
  }
}

// 同一層的項目(檔案、資料夾皆可)互相拖曳換位。
function enableTreeDrag(item, rel) {
  item.draggable = true;
  item.addEventListener('dragstart', (e) => {
    // 搜尋過濾中看到的是跨資料夾的扁平清單,拖曳排序無意義
    if (els.filter.value.trim()) { e.preventDefault(); return; }
    treeDrag = { rel, parent: parentOf(rel), name: rel.split('/').pop() };
    e.dataTransfer.effectAllowed = 'move';
  });
  const accepts = () => treeDrag && treeDrag.rel !== rel && parentOf(rel) === treeDrag.parent;
  item.addEventListener('dragover', (e) => {
    if (!accepts()) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const r = item.getBoundingClientRect();
    const before = e.clientY < r.top + r.height / 2;
    item.classList.toggle('drop-before', before);
    item.classList.toggle('drop-after', !before);
  });
  item.addEventListener('dragleave', () => item.classList.remove('drop-before', 'drop-after'));
  item.addEventListener('drop', (e) => {
    if (!accepts()) return;
    e.preventDefault();
    const r = item.getBoundingClientRect();
    reorderSibling(treeDrag, rel.split('/').pop(), e.clientY < r.top + r.height / 2);
    treeDrag = null;
    clearDropMarks();
  });
  item.addEventListener('dragend', () => { treeDrag = null; clearDropMarks(); });
}

// 以畫面上目前的顯示順序為基準(資料夾與檔案混在一起),把拖曳項插到
// 目標前/後,存成該層的自訂順序。在其他排序模式下拖曳會自動切到
// 「自訂排序」,當下的順序就此凍結為起點。
function reorderSibling(drag, targetName, before) {
  const names = [...els.tree.querySelectorAll('.tree-item')]
    .map((el) => el.dataset.folder || el.dataset.file)
    .filter((r) => r && parentOf(r) === drag.parent)
    .map((r) => r.split('/').pop())
    .filter((n) => n !== drag.name);
  const at = names.indexOf(targetName);
  if (at === -1) return;
  names.splice(before ? at : at + 1, 0, drag.name);
  state.manualOrder[drag.parent] = { order: names };
  localStorage.setItem('manualOrder', JSON.stringify(state.manualOrder));
  if (state.sort !== 'manual') {
    setSort('manual');
    els.statusSave.textContent = '已切換為自訂排序（排序選單可切回）';
  } else {
    refreshTree();
  }
}

/* ---------------- context menu ---------------- */

// 通用彈出選單:entries 為 [label, action, cls] 或 ['---'] 分隔線。
function showMenu(entries, x, y) {
  const menu = $('context-menu');
  menu.textContent = '';
  for (const [label, action, cls] of entries) {
    const li = document.createElement('li');
    if (label === '---') {
      li.className = 'separator';
    } else {
      li.textContent = label;
      if (cls) li.className = cls;
      li.onclick = () => { hideContextMenu(); action(); };
    }
    menu.appendChild(li);
  }
  menu.hidden = false;
  const { innerWidth, innerHeight } = window;
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, innerWidth - rect.width - 8)}px`;
  menu.style.top = `${Math.min(y, innerHeight - rect.height - 8)}px`;
}

function showContextMenu(event, target) {
  event.preventDefault();
  event.stopPropagation();
  const folderRel = target.type === 'folder' ? target.rel : target.rel.split('/').slice(0, -1).join('/');
  const entries = [];
  entries.push(['＋ 新筆記', () => createNote(folderRel)]);
  entries.push(['＋ 新資料夾', () => createFolder(folderRel)]);
  entries.push(['✎ 重新命名', () => renameEntry(target)]);
  entries.push(['🗑 刪除', () => deleteEntry(target), 'danger']);
  if (target.type === 'file') {
    const abs = path.join(state.vault, ...target.rel.split('/'));
    entries.push(['⬇ 匯出成 HTML', () => exportNoteFlow(abs, 'html')]);
    entries.push(['⬇ 匯出成 PDF', () => exportNoteFlow(abs, 'pdf')]);
    entries.push(['⬇ 匯出成 Markdown', () => exportNoteFlow(abs, 'md')]);
  }
  entries.push(['在 Finder 顯示', () => ipcRenderer.invoke('reveal-in-finder', path.join(state.vault, ...target.rel.split('/')))]);
  showMenu(entries, event.clientX, event.clientY);
}

function hideContextMenu() { $('context-menu').hidden = true; }
window.addEventListener('click', hideContextMenu);
window.addEventListener('blur', hideContextMenu);

/* ---------------- 暫存區(拖入的外部 md) ---------------- */

// 拖進視窗的外部 Markdown 檔先放這裡,跟 Vault 樹分開;右鍵可選擇複製進 Vault。
// 清單只存絕對路徑(localStorage),檔案本體留在原處。

function saveStaged() {
  localStorage.setItem('stagedFiles', JSON.stringify(state.staged));
}

function isMarkdownPath(p) {
  try {
    return /\.(md|markdown)$/i.test(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

// 回傳實際新增的數量;不論新舊,開啟第一個拖入的檔案。
function addStagedFiles(paths) {
  const valid = paths.filter(isMarkdownPath);
  let added = 0;
  for (const p of valid) {
    if (!state.staged.includes(p)) {
      state.staged.push(p);
      added++;
    }
  }
  if (added) saveStaged();
  renderStaging();
  if (valid.length) openFile(valid[0]);
  return added;
}

function removeStaged(abs) {
  state.staged = state.staged.filter((p) => p !== abs);
  saveStaged();
  renderStaging();
  if (state.file === abs) {
    state.file = null;
    showEmpty(false);
  }
}

let stagedDragIdx = null;

function renderStaging() {
  // 原始檔已被移走/刪除的項目直接剔除
  const existing = state.staged.filter((p) => fs.existsSync(p));
  if (existing.length !== state.staged.length) {
    state.staged = existing;
    saveStaged();
  }
  const section = $('staging-section');
  section.hidden = state.staged.length === 0;
  $('staging-count').textContent = state.staged.length || '';
  const list = $('staging-list');
  list.textContent = '';
  state.staged.forEach((abs, i) => {
    const item = document.createElement('div');
    item.className = 'tree-item file staged' + (abs === state.file ? ' active' : '');
    item.dataset.staged = abs;
    item.innerHTML = `<span class="icon">📄</span><span class="name"></span>`;
    item.querySelector('.name').textContent = path.basename(abs).replace(/\.(md|markdown)$/i, '');
    item.title = abs;
    item.onclick = () => openFile(abs);
    item.oncontextmenu = (e) => showStagedContextMenu(e, abs);
    // 暫存清單本身也能拖曳換位
    item.draggable = true;
    item.addEventListener('dragstart', (e) => {
      stagedDragIdx = i;
      e.dataTransfer.effectAllowed = 'move';
    });
    item.addEventListener('dragover', (e) => {
      if (stagedDragIdx === null || stagedDragIdx === i) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const r = item.getBoundingClientRect();
      const before = e.clientY < r.top + r.height / 2;
      item.classList.toggle('drop-before', before);
      item.classList.toggle('drop-after', !before);
    });
    item.addEventListener('dragleave', () => item.classList.remove('drop-before', 'drop-after'));
    item.addEventListener('drop', (e) => {
      if (stagedDragIdx === null || stagedDragIdx === i) return;
      e.preventDefault();
      const r = item.getBoundingClientRect();
      const before = e.clientY < r.top + r.height / 2;
      const [moved] = state.staged.splice(stagedDragIdx, 1);
      const at = state.staged.indexOf(abs);
      state.staged.splice(before ? at : at + 1, 0, moved);
      stagedDragIdx = null;
      saveStaged();
      renderStaging();
    });
    item.addEventListener('dragend', () => {
      stagedDragIdx = null;
      clearDropMarks();
    });
    list.appendChild(item);
  });
}

function showStagedContextMenu(event, abs) {
  event.preventDefault();
  event.stopPropagation();
  const entries = [];
  if (state.vault) entries.push(['⬇ 複製到 Vault', () => copyStagedToVault(abs)]);
  entries.push(['在 Finder 顯示', () => ipcRenderer.invoke('reveal-in-finder', abs)]);
  entries.push(['---']);
  entries.push(['✕ 從暫存區移除', () => removeStaged(abs), 'danger']);
  showMenu(entries, event.clientX, event.clientY);
}

// 複製到 Vault 根目錄(同名自動加序號);複製完成後暫存項目功成身退,
// 改開 Vault 內的副本,原始檔保留在原處不動。
function copyStagedToVault(abs) {
  if (!state.vault) return;
  if (!fs.existsSync(abs)) return renderStaging();
  const dest = uniquePath(state.vault, path.basename(abs).replace(/\.(md|markdown)$/i, ''), '.md');
  try {
    fs.copyFileSync(abs, dest);
  } catch (err) {
    return modal({ title: '複製失敗', message: String(err.message || err), okLabel: '知道了' });
  }
  state.staged = state.staged.filter((p) => p !== abs);
  saveStaged();
  renderStaging();
  refreshTree();
  openFile(dest);
  els.statusSave.textContent = `✓ 已複製到 Vault:${path.basename(dest)}`;
}

/* ---- 拖檔進視窗 ---- */

const isFileDrag = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
let dragDepth = 0;

window.addEventListener('dragenter', (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  dragDepth++;
  $('drop-overlay').hidden = false;
});
window.addEventListener('dragleave', (e) => {
  if (!isFileDrag(e)) return;
  if (--dragDepth <= 0) {
    dragDepth = 0;
    $('drop-overlay').hidden = true;
  }
});
window.addEventListener('dragover', (e) => {
  if (isFileDrag(e)) e.preventDefault();
});
window.addEventListener('drop', (e) => {
  // 側欄內部排序等非檔案拖放:擋掉預設行為(例如把路徑文字插進編輯器)就好
  if (!isFileDrag(e)) return e.preventDefault();
  e.preventDefault();
  dragDepth = 0;
  $('drop-overlay').hidden = true;
  const paths = [...e.dataTransfer.files]
    .map((f) => {
      try { return webUtils.getPathForFile(f); } catch { return f.path || ''; }
    })
    .filter(Boolean);
  if (!paths.some(isMarkdownPath)) {
    els.statusSave.textContent = '只支援拖入 .md / .markdown 檔案';
    return;
  }
  addStagedFiles(paths);
});

/* ---------------- file operations ---------------- */

function uniquePath(dir, base, ext) {
  let candidate = path.join(dir, base + ext);
  for (let i = 2; fs.existsSync(candidate); i++) candidate = path.join(dir, `${base} ${i}${ext}`);
  return candidate;
}

async function createNote(folderRel = '') {
  if (!state.vault) return;
  const name = await promptModal('新筆記名稱', '未命名筆記');
  if (!name) return;
  const dir = path.join(state.vault, ...folderRel.split('/').filter(Boolean));
  // The name may contain "/" (create in a subfolder); keep the result inside the vault.
  const file = uniquePath(dir, name.replace(/\.md$/i, ''), '.md');
  if (!path.resolve(file).startsWith(path.resolve(state.vault) + path.sep)) {
    return modal({ title: '無法建立', message: '筆記必須位於 Vault 資料夾內。', okLabel: '知道了' });
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `# ${path.basename(file, '.md')}\n\n`);
  refreshTree();
  openFile(file);
}

async function createFolder(folderRel = '') {
  if (!state.vault) return;
  const name = await promptModal('新資料夾名稱', '新資料夾');
  if (!name) return;
  const dir = path.join(state.vault, ...folderRel.split('/').filter(Boolean), name);
  fs.mkdirSync(dir, { recursive: true });
  state.expanded.add([...folderRel.split('/').filter(Boolean), name].join('/'));
  refreshTree();
}

async function renameEntry(target) {
  const oldAbs = path.join(state.vault, ...target.rel.split('/'));
  const oldName = target.rel.split('/').pop();
  const name = await promptModal('重新命名', oldName);
  if (!name || name === oldName) return;
  const newAbs = path.join(path.dirname(oldAbs), target.type === 'file' && !/\.(md|markdown)$/i.test(name) ? `${name}.md` : name);
  if (fs.existsSync(newAbs)) return modal({ title: '重新命名失敗', message: '同名檔案已存在。', okLabel: '知道了' });
  fs.renameSync(oldAbs, newAbs);
  if (state.file === oldAbs) {
    state.file = newAbs;
    localStorage.setItem('lastFile', newAbs);
  } else if (state.file && state.file.startsWith(oldAbs + path.sep)) {
    state.file = path.join(newAbs, path.relative(oldAbs, state.file));
    localStorage.setItem('lastFile', state.file);
  }
  refreshTree();
  updateStatus();
}

async function deleteEntry(target) {
  const abs = path.join(state.vault, ...target.rel.split('/'));
  const ok = await confirmModal('刪除', `確定要刪除「${target.rel}」嗎?將移至垃圾桶。`);
  if (!ok) return;
  await ipcRenderer.invoke('trash-item', abs);
  if (state.file === abs || (state.file && state.file.startsWith(abs + path.sep))) {
    state.file = null;
    showEmpty(false);
  }
  refreshTree();
}

/* ---------------- open / save ---------------- */

function openFile(absPath) {
  flushSave();
  if (!fs.existsSync(absPath)) return;
  state.file = absPath;
  state.dirty = false;
  localStorage.setItem('lastFile', absPath);
  els.editor.value = fs.readFileSync(absPath, 'utf8');
  showEmpty(true);
  renderPreview();
  updateStatus();
  markActiveTreeItem();
  if (find.open) updateFind({ goto: false });
  if (state.mode !== 'preview') els.editor.focus();
}

// 目前開啟的檔案是否在 Vault 內(暫存區的外部檔不是)
function fileInVault() {
  return !!(state.vault && state.file && state.file.startsWith(state.vault + path.sep));
}

function markActiveTreeItem() {
  const rel = fileInVault() ? path.relative(state.vault, state.file).split(path.sep).join('/') : null;
  for (const item of els.tree.querySelectorAll('.tree-item.file')) {
    item.classList.toggle('active', item.dataset.file === rel);
  }
  for (const item of document.querySelectorAll('#staging-list .tree-item')) {
    item.classList.toggle('active', item.dataset.staged === state.file);
  }
}

function showEmpty(hasFile) {
  if (!hasFile && find.open) closeFind();
  els.empty.hidden = hasFile;
  els.editorPane.hidden = !hasFile;
  els.previewPane.hidden = !hasFile;
  if (!hasFile) {
    els.statusFile.textContent = '—';
    els.statusCount.textContent = '';
    els.statusSave.textContent = '';
  }
}

function saveFile() {
  if (!state.file || !state.dirty) return;
  fs.writeFileSync(state.file, els.editor.value);
  state.dirty = false;
  updateStatus();
  // 依修改時間排序時,存檔後讓樹狀順序即時反映(暫存的外部檔不在樹裡)
  if (state.sort.startsWith('mtime') && fileInVault()) {
    const rel = path.relative(state.vault, state.file).split(path.sep).join('/');
    state.mtimes.set(rel, Date.now());
    refreshTree();
  }
}

function flushSave() {
  clearTimeout(autosaveTimer);
  saveFile();
}

function updateStatus() {
  if (!state.file) return;
  els.statusFile.textContent = fileInVault() ? path.relative(state.vault, state.file) : `📥 ${state.file}`;
  const text = els.editor.value;
  const cjk = (text.match(/[一-鿿㐀-䶿]/g) || []).length;
  const words = (text.match(/[A-Za-z0-9_'-]+/g) || []).length;
  els.statusCount.textContent = `${cjk + words} 字 · ${text.length} 字元`;
  els.statusSave.textContent = state.dirty ? '● 未儲存' : '✓ 已儲存';
  els.statusSave.className = state.dirty ? 'dirty' : 'saved';
}

/* ---------------- preview ---------------- */

function previewRenderer() {
  const mdDir = path.dirname(state.file);
  return createRenderer({
    resolveWikilink: (target) => {
      const found = state.resolveNote(target);
      return { href: '#', exists: !!found };
    },
    resolveAsset: (href) => {
      if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) return href;
      const abs = path.resolve(mdDir, decodeURIComponent(href.split('#')[0].split('?')[0]));
      return `file://${abs.split(path.sep).map(encodeURIComponent).join('/')}`;
    },
    rewriteLink: (href) => href
  });
}

function renderPreview() {
  if (!state.file) return;
  els.preview.innerHTML = previewRenderer().renderBody(els.editor.value);
  const done = renderMermaidBlocks(els.preview, { theme: state.theme === 'light' ? 'default' : 'dark' });
  // 預覽重繪會失效舊的 highlight Range,重新計算(mermaid 置換完再補一次)
  if (find.open) {
    renderPreviewHighlights();
    done.then(() => { if (find.open) renderPreviewHighlights(); });
  }
}

/* ---------------- mermaid ---------------- */

// Parse the mermaid output leniently (labels may contain HTML like <br>/<p>
// that is not well-formed XML) and give the SVG explicit pixel width/height
// from its viewBox so it keeps its natural size when embedded as an <img>.
function parseMermaidSvg(svg) {
  const host = document.createElement('div');
  host.innerHTML = svg;
  const root = host.querySelector('svg');
  if (!root) return null;
  const vb = (root.getAttribute('viewBox') || '').trim().split(/\s+/).map(Number);
  if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) {
    root.setAttribute('width', Math.ceil(vb[2]));
    root.setAttribute('height', Math.ceil(vb[3]));
    root.style.maxWidth = '';
  }
  return root;
}

let mermaidSeq = 0;

// Replace .mermaid-block placeholders (lib/markdown.js) with rendered SVG, or
// with a self-contained <img> for exports. Failed renders keep the source
// code fallback visible.
async function renderMermaidBlocks(root, { theme = 'default', asImage = false, maxHeightMm = 0 } = {}) {
  const blocks = [...root.querySelectorAll('.mermaid-block')];
  if (!blocks.length || typeof mermaid === 'undefined') return;
  mermaid.initialize({
    startOnLoad: false,
    theme,
    fontFamily: '-apple-system, "PingFang TC", "Noto Sans TC", sans-serif'
  });
  for (const block of blocks) {
    try {
      const { svg } = await mermaid.render(`mmd-${++mermaidSeq}`, block.dataset.mermaid || '');
      const svgEl = parseMermaidSvg(svg);
      if (!svgEl) throw new Error('empty mermaid svg');
      if (asImage) {
        // XMLSerializer 會輸出合法 XML(自動閉合 <br> 等),data URI 才能被 <img> 解析。
        const xml = new XMLSerializer().serializeToString(svgEl);
        const uri = `data:image/svg+xml;base64,${Buffer.from(xml).toString('base64')}`;
        const style = maxHeightMm ? ` style="max-height:${maxHeightMm}mm"` : '';
        block.innerHTML = `<img src="${uri}" alt="mermaid 圖表"${style}>`;
      } else {
        block.textContent = '';
        block.appendChild(svgEl);
      }
    } catch (err) {
      block.classList.add('mermaid-error');
    }
  }
}

// Render mermaid placeholders inside an exported HTML string into embedded
// SVG images (data URI), so HTML/PDF exports keep the diagrams.
async function embedMermaidInHtml(html, maxHeightMm = 0) {
  if (!html.includes('mermaid-block')) return html;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  await renderMermaidBlocks(doc.body, { theme: 'default', asImage: true, maxHeightMm });
  return `<!DOCTYPE html>\n${doc.documentElement.outerHTML}\n`;
}

function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(renderPreview, 120);
}

// Clicks inside the preview: wikilinks open notes, .md links open in-app,
// http(s) links go to the system browser.
els.preview.addEventListener('click', async (e) => {
  const a = e.target.closest('a');
  if (!a) return;
  e.preventDefault();
  const wikiTarget = a.dataset.wikilink;
  if (wikiTarget) {
    const rel = state.resolveNote(wikiTarget);
    if (rel) return openFile(path.join(state.vault, ...rel.split('/')));
    if (!state.vault) return;
    const ok = await modal({ title: '建立筆記', message: `「${wikiTarget}」不存在,要建立它嗎?`, okLabel: '建立' });
    if (ok) {
      const file = path.join(state.vault, `${wikiTarget}.md`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `# ${wikiTarget}\n\n`);
      refreshTree();
      openFile(file);
    }
    return;
  }
  const href = a.getAttribute('href') || '';
  if (/^https?:/i.test(href)) return ipcRenderer.invoke('open-external', href);
  if (/\.(md|markdown)(#|$)/i.test(href)) {
    const abs = path.resolve(path.dirname(state.file), decodeURIComponent(href.split('#')[0]));
    if (fs.existsSync(abs)) openFile(abs);
  }
});

/* ---------------- 文件內搜尋 (⌘F) ---------------- */

// 編輯區:在 textarea 底下鋪一層同排版的鏡像 div,用 <mark> 標亮所有符合。
// 預覽區:用 CSS Custom Highlight API 標亮,不改動渲染後的 DOM。
const find = {
  open: false,
  query: '',
  matches: [],       // 編輯區各符合的起始位置
  index: -1,         // 編輯區目前所在的符合
  previewRanges: [],
  previewIndex: -1
};

const escapeHtml = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// 大小寫不敏感的純文字搜尋,回傳所有起始位置。
function findPositions(text, query) {
  const positions = [];
  const hay = text.toLowerCase();
  const needle = query.toLowerCase();
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) {
    positions.push(i);
  }
  return positions;
}

function openFind() {
  if (!state.file) return;
  $('find-bar').hidden = false;
  find.open = true;
  const input = $('find-input');
  const sel = els.editor.value.slice(els.editor.selectionStart, els.editor.selectionEnd);
  if (sel && sel.length <= 200 && !sel.includes('\n')) input.value = sel;
  input.focus();
  input.select();
  updateFind();
}

function closeFind() {
  find.open = false;
  find.query = '';
  find.matches = [];
  find.index = -1;
  $('find-bar').hidden = true;
  els.editorHl.textContent = '';
  clearPreviewHighlights();
  if (state.file && state.mode !== 'preview') els.editor.focus();
}

function clearPreviewHighlights() {
  if (window.CSS && CSS.highlights) {
    CSS.highlights.delete('find-match');
    CSS.highlights.delete('find-current');
  }
  find.previewRanges = [];
  find.previewIndex = -1;
}

// 重新計算符合並更新兩邊標亮。goto=false 用於內容變動時,只更新不跳轉。
function updateFind({ goto = true } = {}) {
  if (!find.open) return;
  find.query = $('find-input').value;
  if (!find.query) {
    find.matches = [];
    find.index = -1;
    els.editorHl.textContent = '';
    clearPreviewHighlights();
    $('find-count').textContent = '';
    return;
  }
  find.matches = findPositions(els.editor.value, find.query);
  // 從編輯游標所在處往後找起;後面沒有就繞回第一個
  const from = els.editor.selectionStart || 0;
  const at = find.matches.findIndex((p) => p + find.query.length >= from);
  find.index = find.matches.length ? Math.max(0, at) : -1;
  renderEditorHighlights();
  renderPreviewHighlights();
  updateFindCount();
  if (goto) scrollToCurrentMatch();
}

function renderEditorHighlights() {
  if (!find.matches.length) { els.editorHl.textContent = ''; return; }
  const text = els.editor.value;
  const len = find.query.length;
  let html = '';
  let last = 0;
  find.matches.forEach((pos, i) => {
    html += escapeHtml(text.slice(last, pos));
    html += `<mark${i === find.index ? ' class="cur"' : ''}>${escapeHtml(text.slice(pos, pos + len))}</mark>`;
    last = pos + len;
  });
  els.editorHl.innerHTML = html + escapeHtml(text.slice(last));
  syncEditorHlScroll();
}

function renderPreviewHighlights() {
  if (!(window.CSS && CSS.highlights)) return;
  CSS.highlights.delete('find-match');
  CSS.highlights.delete('find-current');
  find.previewRanges = [];
  if (!find.open || !find.query) { find.previewIndex = -1; return; }
  const needle = find.query.toLowerCase();
  const ranges = [];
  const walker = document.createTreeWalker(els.preview, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const hay = node.nodeValue.toLowerCase();
    for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) {
      const r = new Range();
      r.setStart(node, i);
      r.setEnd(node, i + needle.length);
      ranges.push(r);
    }
  }
  find.previewRanges = ranges;
  if (!ranges.length) { find.previewIndex = -1; return; }
  if (state.mode === 'preview') {
    find.previewIndex = Math.min(Math.max(find.previewIndex, 0), ranges.length - 1);
  } else {
    // 分割模式:兩邊符合數一致時才同步「目前」標記(Markdown 語法會讓數量不同)
    find.previewIndex = ranges.length === find.matches.length ? find.index : -1;
  }
  CSS.highlights.set('find-match', new Highlight(...ranges));
  if (find.previewIndex >= 0) CSS.highlights.set('find-current', new Highlight(ranges[find.previewIndex]));
}

function updateFindCount() {
  const inPreview = state.mode === 'preview';
  const total = inPreview ? find.previewRanges.length : find.matches.length;
  const cur = inPreview ? find.previewIndex : find.index;
  $('find-count').textContent = total ? `${cur + 1}/${total}` : '0/0';
}

// 往前/往後跳一個符合(dir = ±1),循環繞圈。
function findStep(dir) {
  if (state.mode === 'preview') {
    const n = find.previewRanges.length;
    if (!n) return;
    find.previewIndex = (find.previewIndex + dir + n) % n;
    CSS.highlights.set('find-current', new Highlight(find.previewRanges[find.previewIndex]));
  } else {
    const n = find.matches.length;
    if (!n) return;
    find.index = (find.index + dir + n) % n;
    renderEditorHighlights();
    if (find.previewRanges.length === n) {
      find.previewIndex = find.index;
      CSS.highlights.set('find-current', new Highlight(find.previewRanges[find.previewIndex]));
    }
  }
  updateFindCount();
  scrollToCurrentMatch();
}

function scrollToCurrentMatch() {
  if (state.mode !== 'preview') {
    const cur = els.editorHl.querySelector('mark.cur');
    if (cur) {
      els.editor.scrollTop = Math.max(0, cur.offsetTop - els.editor.clientHeight * 0.4);
      syncEditorHlScroll();
    }
    // 游標跟著目前符合,之後重新輸入時從這裡接續往後找
    if (find.index >= 0) {
      const pos = find.matches[find.index];
      els.editor.setSelectionRange(pos, pos + find.query.length);
    }
  }
  if (state.mode !== 'edit' && find.previewIndex >= 0) {
    const rect = find.previewRanges[find.previewIndex].getBoundingClientRect();
    const pane = els.previewPane;
    pane.scrollTop += rect.top - pane.getBoundingClientRect().top - pane.clientHeight * 0.4;
  }
}

function syncEditorHlScroll() { els.editorHl.scrollTop = els.editor.scrollTop; }
els.editor.addEventListener('scroll', syncEditorHlScroll);

$('find-input').addEventListener('input', () => updateFind());
$('find-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); findStep(e.shiftKey ? -1 : 1); }
  if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
});
$('find-prev').onclick = () => findStep(-1);
$('find-next').onclick = () => findStep(1);
$('find-close').onclick = () => closeFind();

/* ---------------- export ---------------- */

const EXPORT_FORMATS = {
  html: { label: 'HTML', ext: '.html', filters: [{ name: 'HTML', extensions: ['html'] }] },
  pdf: { label: 'PDF', ext: '.pdf', filters: [{ name: 'PDF', extensions: ['pdf'] }] },
  md: { label: 'Markdown', ext: '.md', filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }] }
};

async function exportNoteFlow(mdPath, format = 'html') {
  if (!mdPath) return;
  flushSave();
  const fmt = EXPORT_FORMATS[format];
  const defaultName = path.basename(mdPath).replace(/\.(md|markdown)$/i, fmt.ext);
  const outPath = await ipcRenderer.invoke('choose-save-file', {
    title: `匯出為 ${fmt.label}`,
    defaultName,
    filters: fmt.filters
  });
  if (!outPath) return;
  try {
    if (format === 'md') {
      if (path.resolve(outPath) !== path.resolve(mdPath)) fs.copyFileSync(mdPath, outPath);
    } else if (format === 'pdf') {
      // PDF 由主行程隱藏視窗載入淺色版 HTML 再列印,圖片已內嵌所以暫存檔可即刪。
      // mermaid 圖限制在單頁高度內,讓整張圖完整可見。
      const html = await embedMermaidInHtml(renderNoteHtml(mdPath, { dark: false }), 240);
      const tmpHtml = path.join(os.tmpdir(), `myob-pdf-${Date.now()}.html`);
      fs.writeFileSync(tmpHtml, html);
      try {
        await ipcRenderer.invoke('export-pdf', { htmlPath: tmpHtml, outPath });
      } finally {
        fs.rmSync(tmpHtml, { force: true });
      }
    } else {
      fs.writeFileSync(outPath, await embedMermaidInHtml(renderNoteHtml(mdPath)));
    }
    ipcRenderer.invoke('reveal-in-finder', outPath);
  } catch (err) {
    modal({ title: '匯出失敗', message: String(err.message || err), okLabel: '知道了' });
  }
}

async function exportVaultFlow() {
  if (!state.vault) return;
  flushSave();
  const outDir = await ipcRenderer.invoke('choose-export-dir');
  if (!outDir) return;
  if (path.resolve(outDir) === path.resolve(state.vault)) {
    return modal({ title: '匯出失敗', message: '匯出目的地不能是 Vault 本身,請選擇其他資料夾。', okLabel: '知道了' });
  }
  try {
    const result = exportVault(state.vault, outDir);
    await embedMermaidInVaultSite(outDir);
    const indexFile = fs.existsSync(path.join(outDir, 'index.html')) ? 'index.html' : '_toc.html';
    await modal({
      title: '匯出完成',
      message: `已匯出 ${result.notes} 篇筆記、${result.assets} 個附件到:\n${outDir}`,
      okLabel: '在 Finder 顯示'
    }).then((ok) => { if (ok) ipcRenderer.invoke('reveal-in-finder', path.join(outDir, indexFile)); });
  } catch (err) {
    modal({ title: '匯出失敗', message: String(err.message || err), okLabel: '知道了' });
  }
}

// Vault 匯出後,把靜態網站裡每頁的 mermaid 佔位符渲染成內嵌圖。
async function embedMermaidInVaultSite(outDir) {
  const htmlFiles = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (/\.html$/i.test(entry.name)) htmlFiles.push(abs);
    }
  })(outDir);
  for (const file of htmlFiles) {
    const html = fs.readFileSync(file, 'utf8');
    if (!html.includes('mermaid-block')) continue;
    fs.writeFileSync(file, await embedMermaidInHtml(html));
  }
}

/* ---------------- Claude Code memory sync ---------------- */

// Aggregate ~/.claude memory into the vault as a categorized folder:
// Claude 記憶/<host>/總記憶.md plus one note per project group. Manual click
// always syncs and opens 總記憶; the automatic pass on vault load only
// refreshes if the folder already exists (opt-in).
function syncClaudeMemory(auto = false) {
  if (!state.vault) return;
  const baseDir = path.join(state.vault, 'Claude 記憶');
  if (auto && !fs.existsSync(baseDir)) return;
  try {
    const result = syncToVault(state.vault);
    refreshTree();
    if (!auto) {
      state.expanded.add('Claude 記憶');
      state.expanded.add(`Claude 記憶/${os.hostname().replace(/\.local$/i, '')}`);
      refreshTree();
      openFile(result.mainNote);
      els.statusSave.textContent = `✓ 已同步 ${result.groups} 類、${result.projects} 個專案、${result.entries} 則記憶`;
    }
  } catch (err) {
    if (!auto) modal({ title: 'Claude 記憶同步失敗', message: String(err.message || err), okLabel: '知道了' });
  }
}

/* ---------------- mode / events ---------------- */

function setMode(mode) {
  state.mode = mode;
  localStorage.setItem('mode', mode);
  els.main.className = `mode-${mode}`;
  for (const btn of document.querySelectorAll('#mode-group button')) {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  }
  if (mode !== 'edit') renderPreview();
  if (find.open) updateFindCount();
}

function setTheme(theme) {
  state.theme = theme;
  localStorage.setItem('theme', theme);
  document.body.classList.toggle('theme-light', theme === 'light');
  $('hljs-light').disabled = theme !== 'light';
  $('hljs-dark').disabled = theme === 'light';
  $('btn-theme').textContent = theme === 'light' ? '☀️' : '🌙';
  // mermaid 圖表主題跟著切換,重畫預覽
  if (state.file && state.mode !== 'edit') renderPreview();
}

els.editor.addEventListener('input', () => {
  state.dirty = true;
  updateStatus();
  schedulePreview();
  if (find.open) updateFind({ goto: false });
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(saveFile, 700);
});

els.editor.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    e.preventDefault();
    const { selectionStart, selectionEnd } = els.editor;
    els.editor.setRangeText('  ', selectionStart, selectionEnd, 'end');
    els.editor.dispatchEvent(new Event('input'));
  }
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && find.open && !modalOpen) { closeFind(); return; }
  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return;
  if (e.key === 's') { e.preventDefault(); flushSave(); }
  if (e.key === 'n') { e.preventDefault(); createNote(currentFolderRel()); }
  if (e.key === 'f') { e.preventDefault(); openFind(); }
  if (e.key === '1') { e.preventDefault(); setMode('edit'); }
  if (e.key === '2') { e.preventDefault(); setMode('split'); }
  if (e.key === '3') { e.preventDefault(); setMode('preview'); }
});

function currentFolderRel() {
  if (!fileInVault()) return '';
  return path.relative(state.vault, path.dirname(state.file)).split(path.sep).join('/');
}

els.filter.addEventListener('input', refreshTree);
$('btn-open-vault').onclick = openVaultDialog;
$('btn-open-vault-2').onclick = openVaultDialog;
$('btn-new-note').onclick = () => createNote(currentFolderRel());
$('btn-new-folder').onclick = () => createFolder(currentFolderRel());
$('btn-sort').onclick = (e) => {
  e.stopPropagation();
  if (!state.vault) return;
  const entries = SORT_MODES.map(([mode, label]) => [
    (state.sort === mode ? '✓ ' : '　 ') + label,
    () => setSort(mode)
  ]);
  const rect = e.currentTarget.getBoundingClientRect();
  showMenu(entries, rect.left, rect.bottom + 4);
};
/* ---- 全部收合 / 展開切換 ---- */

// 有展開的資料夾時是「全部收合」;全收起來後圖示反轉變「展開」,
// 再點一下還原收合前的展開狀態(記錄存 localStorage,重啟也有效)。
function updateCollapseBtn() {
  const btn = $('btn-collapse-all');
  const collapsed = state.expanded.size === 0;
  btn.classList.toggle('expand-mode', collapsed);
  btn.title = collapsed ? '展開資料夾（還原收合前的展開狀態）' : '全部收合';
}

$('btn-collapse-all').onclick = () => {
  if (!state.vault) return;
  if (state.expanded.size > 0) {
    localStorage.setItem('prevExpanded', JSON.stringify([...state.expanded]));
    state.expanded.clear();
  } else {
    // 只還原收合前有展開的部分;沒有紀錄就維持不動
    for (const rel of JSON.parse(localStorage.getItem('prevExpanded') || '[]')) state.expanded.add(rel);
  }
  localStorage.setItem('expanded', JSON.stringify([...state.expanded]));
  refreshTree();
};
$('btn-theme').onclick = () => setTheme(state.theme === 'light' ? 'dark' : 'light');
$('btn-export').onclick = (e) => {
  e.stopPropagation();
  if (!state.vault) return;
  const entries = [];
  if (state.file) {
    entries.push(['⬇ 匯出成 HTML', () => exportNoteFlow(state.file, 'html')]);
    entries.push(['⬇ 匯出成 PDF', () => exportNoteFlow(state.file, 'pdf')]);
    entries.push(['⬇ 匯出成 Markdown', () => exportNoteFlow(state.file, 'md')]);
    entries.push(['---']);
  }
  entries.push(['🌐 匯出整個 Vault(HTML 網站)', exportVaultFlow]);
  const rect = e.currentTarget.getBoundingClientRect();
  showMenu(entries, rect.left, rect.bottom + 4);
};
$('btn-claude-sync').onclick = () => syncClaudeMemory(false);
for (const btn of document.querySelectorAll('#mode-group button')) {
  btn.onclick = () => setMode(btn.dataset.mode);
}

/* ---- sidebar resize ---- */
$('sidebar-resizer').addEventListener('mousedown', (e) => {
  e.preventDefault();
  const sidebar = $('sidebar');
  const move = (ev) => { sidebar.style.width = `${Math.max(160, Math.min(480, ev.clientX))}px`; };
  const up = () => {
    localStorage.setItem('sidebarWidth', sidebar.style.width);
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
});

window.addEventListener('beforeunload', flushSave);

/* ---------------- startup ---------------- */

const savedWidth = localStorage.getItem('sidebarWidth');
if (savedWidth) $('sidebar').style.width = savedWidth;
setTheme(state.theme);
setMode(state.mode);
showEmpty(false);
updateCollapseBtn();
renderStaging();
const lastVault = localStorage.getItem('lastVault');
if (lastVault && fs.existsSync(lastVault)) {
  loadVault(lastVault);
} else {
  // 沒有 Vault 也能繼續看上次開著的暫存檔
  const lastFile = localStorage.getItem('lastFile');
  if (lastFile && state.staged.includes(lastFile) && fs.existsSync(lastFile)) openFile(lastFile);
}

// Automation hook for test/e2e.js.
window.__myob = { state, loadVault, openFile, setMode, refreshTree, openFind, closeFind, addStagedFiles, removeStaged };
