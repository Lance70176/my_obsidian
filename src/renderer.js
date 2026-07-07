const fs = require('fs');
const os = require('os');
const path = require('path');
const { ipcRenderer } = require('electron');
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
  resolveNote: () => null,
  expanded: new Set(JSON.parse(localStorage.getItem('expanded') || '[]'))
};

let autosaveTimer = null;
let previewTimer = null;

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
  syncClaudeMemory(true);
  const lastFile = localStorage.getItem('lastFile');
  if (lastFile && lastFile.startsWith(dir + path.sep) && fs.existsSync(lastFile)) {
    openFile(lastFile);
  } else {
    showEmpty(false);
  }
}

function refreshTree() {
  const { notes } = walkVault(state.vault, null);
  state.resolveNote = buildNoteIndex(notes);
  renderTree(notes);
  schedulePreview();
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
  const filter = els.filter.value.trim().toLowerCase();
  els.tree.textContent = '';
  if (filter) {
    for (const rel of notes.filter((r) => r.toLowerCase().includes(filter)).sort()) {
      els.tree.appendChild(fileItem(rel, rel.replace(/\.(md|markdown)$/i, '')));
    }
    return;
  }
  els.tree.appendChild(renderNode(buildTree(notes), ''));
}

function renderNode(node, relBase) {
  const frag = document.createDocumentFragment();
  const folderNames = [...node.folders.keys()].sort((a, b) => a.localeCompare(b, 'zh-Hant'));
  for (const name of folderNames) {
    const rel = relBase ? `${relBase}/${name}` : name;
    const isOpen = state.expanded.has(rel);
    const item = document.createElement('div');
    item.className = 'tree-item folder';
    item.dataset.folder = rel;
    item.innerHTML = `<span class="icon">${isOpen ? '▾' : '▸'}</span><span class="name"></span>`;
    item.querySelector('.name').textContent = name;
    item.onclick = () => {
      state.expanded.has(rel) ? state.expanded.delete(rel) : state.expanded.add(rel);
      localStorage.setItem('expanded', JSON.stringify([...state.expanded]));
      refreshTree();
    };
    item.oncontextmenu = (e) => showContextMenu(e, { type: 'folder', rel });
    frag.appendChild(item);
    if (isOpen) {
      const children = document.createElement('div');
      children.className = 'tree-children';
      children.appendChild(renderNode(node.folders.get(name), rel));
      frag.appendChild(children);
    }
  }
  for (const rel of [...node.files].sort((a, b) => a.localeCompare(b, 'zh-Hant'))) {
    const name = rel.split('/').pop().replace(/\.(md|markdown)$/i, '');
    frag.appendChild(fileItem(rel, name));
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
  item.title = rel;
  item.onclick = () => openFile(abs);
  item.oncontextmenu = (e) => showContextMenu(e, { type: 'file', rel });
  return item;
}

/* ---------------- context menu ---------------- */

function showContextMenu(event, target) {
  event.preventDefault();
  event.stopPropagation();
  const menu = $('context-menu');
  menu.textContent = '';
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
  for (const [label, action, cls] of entries) {
    const li = document.createElement('li');
    li.textContent = label;
    if (cls) li.className = cls;
    li.onclick = () => { hideContextMenu(); action(); };
    menu.appendChild(li);
  }
  menu.hidden = false;
  const { innerWidth, innerHeight } = window;
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(event.clientX, innerWidth - rect.width - 8)}px`;
  menu.style.top = `${Math.min(event.clientY, innerHeight - rect.height - 8)}px`;
}

function hideContextMenu() { $('context-menu').hidden = true; }
window.addEventListener('click', hideContextMenu);
window.addEventListener('blur', hideContextMenu);

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
  if (state.mode !== 'preview') els.editor.focus();
}

function markActiveTreeItem() {
  const rel = state.file ? path.relative(state.vault, state.file).split(path.sep).join('/') : null;
  for (const item of els.tree.querySelectorAll('.tree-item.file')) {
    item.classList.toggle('active', item.dataset.file === rel);
  }
}

function showEmpty(hasFile) {
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
}

function flushSave() {
  clearTimeout(autosaveTimer);
  saveFile();
}

function updateStatus() {
  if (!state.file) return;
  els.statusFile.textContent = path.relative(state.vault, state.file);
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
  renderMermaidBlocks(els.preview, { theme: state.theme === 'light' ? 'default' : 'dark' });
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
  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return;
  if (e.key === 's') { e.preventDefault(); flushSave(); }
  if (e.key === 'n') { e.preventDefault(); createNote(currentFolderRel()); }
  if (e.key === '1') { e.preventDefault(); setMode('edit'); }
  if (e.key === '2') { e.preventDefault(); setMode('split'); }
  if (e.key === '3') { e.preventDefault(); setMode('preview'); }
});

function currentFolderRel() {
  if (!state.file) return '';
  return path.relative(state.vault, path.dirname(state.file)).split(path.sep).join('/');
}

els.filter.addEventListener('input', refreshTree);
$('btn-open-vault').onclick = openVaultDialog;
$('btn-open-vault-2').onclick = openVaultDialog;
$('btn-new-note').onclick = () => createNote(currentFolderRel());
$('btn-new-folder').onclick = () => createFolder(currentFolderRel());
$('btn-collapse-all').onclick = () => {
  if (!state.vault) return;
  state.expanded.clear();
  localStorage.setItem('expanded', '[]');
  refreshTree();
};
$('btn-theme').onclick = () => setTheme(state.theme === 'light' ? 'dark' : 'light');
$('btn-export-note').onclick = () => exportNoteFlow(state.file);
$('btn-export-vault').onclick = exportVaultFlow;
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
const lastVault = localStorage.getItem('lastVault');
if (lastVault && fs.existsSync(lastVault)) loadVault(lastVault);

// Automation hook for test/e2e.js.
window.__myob = { state, loadVault, openFile, setMode, refreshTree };
