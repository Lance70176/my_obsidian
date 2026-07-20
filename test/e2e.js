// End-to-end UI test: drives the real Electron app with Playwright.
// Native dialogs are stubbed by patching ipcRenderer.invoke in the page.
// Run with: node test/e2e.js
const { _electron: electron } = require('playwright');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

let passed = 0;
async function step(name, fn) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myob-e2e-'));
  const vault = path.join(tmp, 'vault');
  fs.cpSync(path.join(ROOT, 'SampleVault'), vault, { recursive: true });
  const exportDir = path.join(tmp, 'site');
  const exportFile = path.join(tmp, 'single.html');

  // Fake ~/.claude with one project memory for the Claude-sync step.
  const claudeDir = path.join(tmp, 'claude');
  const memDir = path.join(claudeDir, 'projects', '-Users-test-projects-demo', 'memory');
  fs.mkdirSync(memDir, { recursive: true });
  fs.writeFileSync(path.join(memDir, 'MEMORY.md'), '- [重要決定](x.md) — E2E 測試用記憶重點\n');
  fs.writeFileSync(path.join(memDir, 'x.md'), 'x');

  const app = await electron.launch({
    args: [ROOT],
    env: { ...process.env, MYOB_USER_DATA: path.join(tmp, 'userdata'), MYOB_CLAUDE_DIR: claudeDir }
  });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForSelector('#empty-state', { state: 'visible' });

  try {
    await step('沒有 Vault 時,新筆記/匯出按鈕不會跳出對話框或選單', async () => {
      await win.click('#btn-new-note');
      await win.click('#btn-export');
      assert.strictEqual(await win.isVisible('#modal-overlay'), false);
      assert.strictEqual(await win.isVisible('#context-menu'), false);
    });

    await step('stub 原生對話框後,「開啟 Vault」載入 SampleVault', async () => {
      await win.evaluate(({ vault, exportDir, exportFile }) => {
        const { ipcRenderer } = window.require('electron');
        const orig = ipcRenderer.invoke.bind(ipcRenderer);
        ipcRenderer.invoke = (ch, ...args) => {
          if (ch === 'choose-vault') return Promise.resolve(vault);
          if (ch === 'choose-save-file') return Promise.resolve(window.__saveTarget || exportFile);
          if (ch === 'choose-export-dir') return Promise.resolve(exportDir);
          if (ch === 'reveal-in-finder') return Promise.resolve();
          return orig(ch, ...args);
        };
      }, { vault, exportDir, exportFile });
      await win.click('#btn-open-vault');
      await win.waitForSelector('#file-tree .tree-item.file');
      assert.strictEqual(await win.textContent('#vault-name'), 'vault');
      const files = await win.$$eval('#file-tree .tree-item', (els) => els.map((e) => e.textContent.trim()));
      assert.ok(files.some((t) => t.includes('歡迎')), `tree should list 歡迎, got: ${files}`);
      assert.ok(files.some((t) => t.includes('教學')), 'tree should list 教學 folder');
    });

    await step('外部新增的檔案會自動出現在側欄(免手動重整)', async () => {
      fs.writeFileSync(path.join(vault, '外部新增筆記.md'), '# 外部新增\n');
      await win.waitForSelector('#file-tree .tree-item.file:has-text("外部新增筆記")', { timeout: 5000 });
    });

    await step('點擊筆記後,編輯器與預覽都正確載入', async () => {
      await win.click('#file-tree .tree-item.file:has-text("歡迎")');
      const text = await win.inputValue('#editor');
      assert.ok(text.startsWith('# 歡迎使用 MyObsidian'));
      assert.strictEqual(await win.textContent('#preview h1'), '歡迎使用 MyObsidian 👋');
      assert.ok((await win.textContent('#status-save')).includes('已儲存'));
    });

    await step('點擊 [[功能介紹]] wikilink 會開啟該筆記', async () => {
      await win.click('#preview a[data-wikilink="功能介紹"]');
      await win.waitForFunction(() => document.querySelector('#editor').value.startsWith('# 功能介紹'));
      assert.ok(await win.isVisible('#preview table'), '表格應該渲染出來');
      assert.ok((await win.innerHTML('#preview')).includes('hljs-keyword'), '程式碼應有高亮');
    });

    await step('資料夾展開後可開啟子筆記,frontmatter 不會出現在預覽', async () => {
      await win.click('#file-tree .tree-item.folder:has-text("教學")');
      await win.click('#file-tree .tree-item.file:has-text("匯出說明")');
      await win.waitForFunction(() => document.querySelector('#editor').value.includes('# 匯出說明'));
      const preview = await win.textContent('#preview');
      assert.ok(!preview.includes('tags:'), 'frontmatter 不應出現在預覽');
    });

    await step('編輯內容會自動儲存到磁碟', async () => {
      await win.click('#file-tree .tree-item.file:has-text("歡迎")');
      await win.fill('#editor', '# 自動儲存測試\n\n內容已修改。');
      await win.waitForFunction(
        () => document.querySelector('#status-save').textContent.includes('已儲存'),
        null, { timeout: 5000 }
      );
      const onDisk = fs.readFileSync(path.join(vault, '歡迎.md'), 'utf8');
      assert.ok(onDisk.startsWith('# 自動儲存測試'));
    });

    await step('三種檢視模式正常切換', async () => {
      await win.click('#btn-mode-edit');
      assert.ok(await win.isVisible('#editor'));
      assert.strictEqual(await win.isVisible('#preview'), false);
      await win.click('#btn-mode-preview');
      assert.strictEqual(await win.isVisible('#editor'), false);
      assert.ok(await win.isVisible('#preview'));
      await win.click('#btn-mode-split');
      assert.ok(await win.isVisible('#editor'));
      assert.ok(await win.isVisible('#preview'));
    });

    await step('⌘F 文件內搜尋:標亮、計數、跳轉與關閉', async () => {
      await win.fill('#editor', '# 搜尋測試\n\napple 一段文字 apple\n\n第三個 Apple 在這裡。');
      await win.keyboard.press('Meta+f');
      await win.waitForSelector('#find-bar', { state: 'visible' });
      await win.fill('#find-input', 'apple');
      // 大小寫不敏感:三個 apple/Apple 都要找到,從第一個開始
      await win.waitForFunction(() => document.getElementById('find-count').textContent === '1/3');
      assert.strictEqual(await win.$$eval('#editor-highlights mark', (m) => m.length), 3);
      assert.strictEqual(await win.$$eval('#editor-highlights mark.cur', (m) => m.length), 1);
      // 預覽區同步用 Highlight API 標亮(預覽重繪有 120ms debounce,用等待式檢查)
      await win.waitForFunction(() => CSS.highlights.has('find-match'), null, { timeout: 5000 });
      // Enter 跳下一個,⇧Enter 跳回
      await win.keyboard.press('Enter');
      assert.strictEqual(await win.textContent('#find-count'), '2/3');
      await win.keyboard.press('Shift+Enter');
      assert.strictEqual(await win.textContent('#find-count'), '1/3');
      // Esc 關閉並清除所有標亮
      await win.keyboard.press('Escape');
      assert.strictEqual(await win.isVisible('#find-bar'), false);
      assert.strictEqual(await win.$$eval('#editor-highlights mark', (m) => m.length), 0);
      assert.strictEqual(await win.evaluate(() => CSS.highlights.has('find-match')), false);
    });

    await step('點擊不存在的 [[wikilink]] 會詢問並建立新筆記', async () => {
      await win.fill('#editor', '# 測試\n\n連到 [[我的新想法]]。');
      await win.waitForSelector('#preview a.wikilink.broken');
      await win.click('#preview a.wikilink.broken');
      await win.waitForSelector('#modal-overlay', { state: 'visible' });
      await win.click('#modal-ok');
      await win.waitForFunction(() => document.querySelector('#editor').value.startsWith('# 我的新想法'));
      assert.ok(fs.existsSync(path.join(vault, '我的新想法.md')));
    });

    await step('「＋ 新筆記」modal 可輸入名稱並確定建立', async () => {
      await win.click('#btn-new-note');
      await win.waitForSelector('#modal-overlay', { state: 'visible' });
      assert.strictEqual(await win.textContent('#modal-title'), '新筆記名稱');
      await win.fill('#modal-input', '測試筆記');
      await win.click('#modal-ok');
      await win.waitForSelector('#modal-overlay', { state: 'hidden' });
      assert.ok(fs.existsSync(path.join(vault, '測試筆記.md')));
    });

    await step('新筆記名稱含路徑斜線時,會建立子資料夾而不是崩潰', async () => {
      await win.click('#btn-new-note');
      await win.waitForSelector('#modal-overlay', { state: 'visible' });
      await win.fill('#modal-input', '/Users/lujianzhou/projects/obsidian');
      await win.click('#modal-ok');
      await win.waitForSelector('#modal-overlay', { state: 'hidden' });
      assert.ok(
        fs.existsSync(path.join(vault, 'Users/lujianzhou/projects/obsidian.md')),
        '含斜線的名稱應該在 Vault 內建立對應子資料夾'
      );
    });

    await step('搜尋框能過濾檔案樹', async () => {
      await win.fill('#tree-filter', '功能');
      const items = await win.$$eval('#file-tree .tree-item', (els) => els.map((e) => e.textContent.trim()));
      assert.strictEqual(items.length, 1);
      assert.ok(items[0].includes('功能介紹'));
      await win.fill('#tree-filter', '');
    });

    await step('工具列「匯出」下拉選單匯出單篇 HTML(自包含檔案)', async () => {
      await win.click('#file-tree .tree-item.file:has-text("功能介紹")');
      await win.waitForFunction(() => document.querySelector('#editor').value.startsWith('# 功能介紹'));
      await win.click('#btn-export');
      await win.waitForSelector('#context-menu', { state: 'visible' });
      await win.click('#context-menu li:has-text("匯出成 HTML")');
      await win.waitForFunction(
        (p) => window.require('fs').existsSync(p), exportFile, { timeout: 5000 }
      );
      const html = fs.readFileSync(exportFile, 'utf8');
      assert.ok(html.includes('<!DOCTYPE html>') && html.includes('hljs'));
    });

    await step('右鍵選單匯出 PDF', async () => {
      const pdfFile = path.join(tmp, 'single.pdf');
      await win.evaluate((p) => { window.__saveTarget = p; }, pdfFile);
      await win.click('#file-tree .tree-item.file:has-text("功能介紹")', { button: 'right' });
      await win.click('#context-menu li:has-text("匯出成 PDF")');
      await win.waitForFunction(
        (p) => window.require('fs').existsSync(p), pdfFile, { timeout: 15000 }
      );
      assert.strictEqual(fs.readFileSync(pdfFile).subarray(0, 5).toString(), '%PDF-');
    });

    await step('右鍵選單匯出 Markdown(原始檔複製)', async () => {
      const mdFile = path.join(tmp, 'single-copy.md');
      await win.evaluate((p) => { window.__saveTarget = p; }, mdFile);
      await win.click('#file-tree .tree-item.file:has-text("功能介紹")', { button: 'right' });
      await win.click('#context-menu li:has-text("匯出成 Markdown")');
      await win.waitForFunction(
        (p) => window.require('fs').existsSync(p), mdFile, { timeout: 5000 }
      );
      assert.strictEqual(
        fs.readFileSync(mdFile, 'utf8'),
        fs.readFileSync(path.join(vault, '功能介紹.md'), 'utf8')
      );
      await win.evaluate(() => { window.__saveTarget = null; });
    });

    await step('主題切換:深→淺色並持久化,再切回', async () => {
      await win.click('#btn-theme');
      assert.ok(await win.evaluate(() => document.body.classList.contains('theme-light')));
      assert.strictEqual(await win.evaluate(() => localStorage.getItem('theme')), 'light');
      await win.click('#btn-theme');
      assert.ok(await win.evaluate(() => !document.body.classList.contains('theme-light')));
    });

    await step('側欄「新資料夾」按鈕建立資料夾', async () => {
      await win.click('#btn-new-folder');
      await win.waitForSelector('#modal-overlay', { state: 'visible' });
      await win.fill('#modal-input', '按鈕資料夾');
      await win.click('#modal-ok');
      await win.waitForSelector('#modal-overlay', { state: 'hidden' });
      assert.ok(fs.existsSync(path.join(vault, '按鈕資料夾')));
    });

    await step('「全部收合」收完變展開鈕,可還原收合前的展開狀態', async () => {
      // 確保「教學」是展開的(子筆記「匯出說明」可見)
      if (!(await win.isVisible('#file-tree .tree-item.file:has-text("匯出說明")'))) {
        await win.click('#file-tree .tree-item.folder:has-text("教學")');
        await win.waitForSelector('#file-tree .tree-item.file:has-text("匯出說明")');
      }
      await win.click('#btn-collapse-all');
      await win.waitForFunction(() => document.querySelectorAll('#file-tree .tree-children').length === 0);
      assert.ok(
        await win.evaluate(() => document.getElementById('btn-collapse-all').classList.contains('expand-mode')),
        '收合後按鈕應切換成展開圖示'
      );
      // 再點一下:還原剛才的展開狀態,「匯出說明」重新可見
      await win.click('#btn-collapse-all');
      await win.waitForSelector('#file-tree .tree-item.file:has-text("匯出說明")');
      assert.ok(
        await win.evaluate(() => !document.getElementById('btn-collapse-all').classList.contains('expand-mode')),
        '展開後按鈕應切回收合圖示'
      );
      // 收回去,後續步驟以全收合狀態繼續
      await win.click('#btn-collapse-all');
      await win.waitForFunction(() => document.querySelectorAll('#file-tree .tree-children').length === 0);
    });

    await step('排序選單:修改時間(新→舊)讓最近編輯的筆記排最前,並可切回名稱', async () => {
      await win.click('#btn-sort');
      await win.click('#context-menu li:has-text("修改時間（新→舊）")');
      await win.click('#file-tree .tree-item.file:has-text("歡迎")');
      await win.fill('#editor', '# 自動儲存測試\n\n排序測試。');
      await win.waitForFunction(() => {
        const f = document.querySelector('#file-tree .tree-item.file');
        return f && f.textContent.includes('歡迎');
      }, null, { timeout: 5000 });
      await win.click('#btn-sort');
      await win.click('#context-menu li:has-text("名稱（A→Z）")');
      assert.strictEqual(
        await win.evaluate(() => localStorage.getItem('sortMode')), 'name-asc'
      );
      await win.click('#file-tree .tree-item.file:has-text("功能介紹")');
    });

    await step('依日期排序時檔名右側顯示日期,建立時間排序可用,名稱排序不顯示', async () => {
      await win.click('#btn-sort');
      await win.click('#context-menu li:has-text("建立時間（新→舊）")');
      assert.strictEqual(
        await win.evaluate(() => localStorage.getItem('sortMode')), 'ctime-desc'
      );
      await win.waitForSelector('#file-tree .tree-item.file .date');
      const dates = await win.$$eval('#file-tree .tree-item.file .date', (els) => els.map((e) => e.textContent));
      assert.ok(dates.every((t) => /^(\d{4}\/)?\d{2}\/\d{2}$/.test(t)), `date badges should look like MM/DD, got: ${dates}`);
      await win.click('#btn-sort');
      await win.click('#context-menu li:has-text("修改時間（新→舊）")');
      await win.waitForSelector('#file-tree .tree-item.file .date');
      await win.click('#btn-sort');
      await win.click('#context-menu li:has-text("名稱（A→Z）")');
      await win.waitForFunction(() => document.querySelectorAll('#file-tree .tree-item.file .date').length === 0);
    });

    await step('mermaid 程式碼區塊在預覽渲染成 SVG 流程圖(含 <br/> HTML 標籤)', async () => {
      await win.fill('#editor', '# 圖\n\n```mermaid\nflowchart TD\n  A["玩家離場 / 三方轉回<br/>(第二行)"] --> B{判斷}\n  B -->|是| C[結束]\n```\n');
      await win.waitForSelector('#preview .mermaid-block svg', { timeout: 10000 });
      const previewText = await win.textContent('#preview');
      assert.ok(
        !previewText.includes('This page contains the following errors'),
        'HTML 式標籤不應觸發 XML 解析錯誤'
      );
    });

    await step('匯出 HTML 時 mermaid 圖轉成內嵌圖片保留', async () => {
      const mermaidHtml = path.join(tmp, 'mermaid.html');
      await win.evaluate((p) => { window.__saveTarget = p; }, mermaidHtml);
      await win.click('#btn-export');
      await win.click('#context-menu li:has-text("匯出成 HTML")');
      await win.waitForFunction(
        (p) => window.require('fs').existsSync(p), mermaidHtml, { timeout: 10000 }
      );
      const html = fs.readFileSync(mermaidHtml, 'utf8');
      assert.ok(html.includes('data:image/svg+xml;base64,'), 'mermaid 應轉成內嵌 SVG 圖片');
      const b64 = /data:image\/svg\+xml;base64,([A-Za-z0-9+/=]+)/.exec(html)[1];
      const validXml = await win.evaluate((b) => {
        const doc = new DOMParser().parseFromString(atob(b), 'image/svg+xml');
        return !doc.querySelector('parsererror');
      }, b64);
      assert.ok(validXml, '內嵌的 SVG 必須是合法 XML,否則 <img> 無法顯示');
      await win.evaluate(() => { window.__saveTarget = null; });
    });

    await step('匯出 PDF 時 mermaid 圖同樣保留', async () => {
      const mermaidPdf = path.join(tmp, 'mermaid.pdf');
      await win.evaluate((p) => { window.__saveTarget = p; }, mermaidPdf);
      await win.click('#file-tree .tree-item.file:has-text("功能介紹")', { button: 'right' });
      await win.click('#context-menu li:has-text("匯出成 PDF")');
      await win.waitForFunction(
        (p) => window.require('fs').existsSync(p), mermaidPdf, { timeout: 15000 }
      );
      assert.strictEqual(fs.readFileSync(mermaidPdf).subarray(0, 5).toString(), '%PDF-');
      await win.evaluate(() => { window.__saveTarget = null; });
    });

    await step('匯出整個 Vault 成 HTML 網站', async () => {
      await win.click('#btn-export');
      await win.click('#context-menu li:has-text("匯出整個 Vault")');
      await win.waitForSelector('#modal-overlay', { state: 'visible' });
      assert.ok((await win.textContent('#modal-msg')).includes('已匯出'));
      await win.click('#modal-cancel');
      assert.ok(fs.existsSync(path.join(exportDir, 'index.html')));
      assert.ok(fs.existsSync(path.join(exportDir, '教學', '匯出說明.html')));
    });

    await step('「🧠 Claude 記憶」彙整成分類筆記(總記憶 + 群組)並開啟總記憶', async () => {
      await win.click('#btn-claude-sync');
      await win.waitForFunction(() => document.querySelector('#editor').value.includes('Claude Code 總記憶'));
      const host = os.hostname().replace(/\.local$/i, '');
      const outDir = path.join(vault, 'Claude 記憶', host);
      const notes = fs.readdirSync(outDir).sort();
      assert.deepStrictEqual(notes, ['demo.md', '總記憶.md']);
      const demo = fs.readFileSync(path.join(outDir, 'demo.md'), 'utf8');
      assert.ok(demo.includes('E2E 測試用記憶重點'));
      const main = fs.readFileSync(path.join(outDir, '總記憶.md'), 'utf8');
      assert.ok(main.includes(`[[Claude 記憶/${host}/demo|demo]]`));
      // 側邊欄應出現分類資料夾與群組筆記
      const treeText = await win.textContent('#file-tree');
      assert.ok(treeText.includes('Claude 記憶'));
      assert.ok(treeText.includes('demo'));
    });

    await step('拖入的外部 md 進暫存區並自動開啟,右鍵可複製進 Vault', async () => {
      const ext = path.join(tmp, '外部草稿.md');
      fs.writeFileSync(ext, '# 外部草稿\n\n暫存內容。');
      // 拖放的核心邏輯走 addStagedFiles(OS 層拖放無法在測試中模擬)
      await win.evaluate((p) => window.__myob.addStagedFiles([p]), ext);
      await win.waitForSelector('#staging-section', { state: 'visible' });
      const items = await win.$$eval('#staging-list .tree-item', (els) => els.map((e) => e.textContent.trim()));
      assert.ok(items.some((t) => t.includes('外部草稿')), `暫存區應列出外部草稿, got: ${items}`);
      await win.waitForFunction(() => document.querySelector('#editor').value.startsWith('# 外部草稿'));
      // 狀態列顯示完整路徑,和 Vault 內的相對路徑區分
      assert.ok((await win.textContent('#status-file')).includes(ext));
      await win.click('#staging-list .tree-item:has-text("外部草稿")', { button: 'right' });
      await win.click('#context-menu li:has-text("複製到 Vault")');
      await win.waitForSelector('#file-tree .tree-item.file:has-text("外部草稿")');
      assert.strictEqual(
        fs.readFileSync(path.join(vault, '外部草稿.md'), 'utf8'),
        '# 外部草稿\n\n暫存內容。'
      );
      assert.ok(fs.existsSync(ext), '原始檔應保留在原處');
      // 複製後暫存項目移除,清單清空就隱藏
      assert.strictEqual(await win.isVisible('#staging-section'), false);
    });

    await step('暫存項目右鍵「從暫存區移除」不會刪除原始檔', async () => {
      const ext = path.join(tmp, '暫存移除測試.md');
      fs.writeFileSync(ext, '# 移除測試\n');
      await win.evaluate((p) => window.__myob.addStagedFiles([p]), ext);
      await win.waitForSelector('#staging-list .tree-item:has-text("暫存移除測試")');
      await win.click('#staging-list .tree-item:has-text("暫存移除測試")', { button: 'right' });
      await win.click('#context-menu li:has-text("從暫存區移除")');
      await win.waitForSelector('#staging-section', { state: 'hidden' });
      assert.ok(fs.existsSync(ext), '移除只是退出暫存清單,原始檔不能被刪');
    });

    await step('側欄檔案可拖曳排序,自動切到「自訂排序」', async () => {
      fs.writeFileSync(path.join(vault, 'AAA排序.md'), '# a\n');
      fs.writeFileSync(path.join(vault, 'BBB排序.md'), '# b\n');
      await win.waitForSelector('#file-tree .tree-item.file:has-text("BBB排序")', { timeout: 5000 });
      // 模擬 HTML5 拖放:把 BBB排序 拖到 AAA排序 前面
      await win.evaluate(() => {
        const items = [...document.querySelectorAll('#file-tree .tree-item.file')];
        const src = items.find((i) => i.dataset.file === 'BBB排序.md');
        const dst = items.find((i) => i.dataset.file === 'AAA排序.md');
        const dt = new DataTransfer();
        src.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }));
        const r = dst.getBoundingClientRect();
        dst.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, clientY: r.top + 2 }));
        dst.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, clientY: r.top + 2 }));
      });
      await win.waitForFunction(() => localStorage.getItem('sortMode') === 'manual');
      const order = await win.$$eval('#file-tree .tree-item.file', (els) => els.map((e) => e.dataset.file));
      assert.ok(
        order.indexOf('BBB排序.md') < order.indexOf('AAA排序.md'),
        `BBB排序 應排在 AAA排序 前面, got: ${order}`
      );
      // 自訂順序要在重新整理後保留
      await win.evaluate(() => window.__myob.refreshTree());
      const after = await win.$$eval('#file-tree .tree-item.file', (els) => els.map((e) => e.dataset.file));
      assert.ok(after.indexOf('BBB排序.md') < after.indexOf('AAA排序.md'), '重繪後自訂順序應保留');
      // 排序選單有「自訂」且可切回名稱排序
      await win.click('#btn-sort');
      await win.waitForSelector('#context-menu li:has-text("自訂（拖曳排序）")');
      await win.click('#context-menu li:has-text("名稱（A→Z）")');
      await win.waitForFunction(() => localStorage.getItem('sortMode') === 'name-asc');
    });

    await step('自訂排序:檔案可拖到資料夾之間(同層混排,如根目錄唯一檔案)', async () => {
      // 名稱排序下資料夾永遠在檔案前面;把 BBB排序 拖到「教學」資料夾上方,
      // 應自動切到自訂排序並讓檔案排進資料夾之間
      await win.evaluate(() => {
        const items = [...document.querySelectorAll('#file-tree .tree-item')];
        const src = items.find((i) => i.dataset.file === 'BBB排序.md');
        const dst = items.find((i) => i.dataset.folder === '教學');
        const dt = new DataTransfer();
        src.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }));
        const r = dst.getBoundingClientRect();
        dst.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, clientY: r.top + 2 }));
        dst.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, clientY: r.top + 2 }));
      });
      await win.waitForFunction(() => localStorage.getItem('sortMode') === 'manual');
      const order = await win.$$eval('#file-tree .tree-item', (els) =>
        els.map((e) => e.dataset.folder || e.dataset.file).filter((r) => r && !r.includes('/'))
      );
      assert.ok(
        order.indexOf('BBB排序.md') !== -1 && order.indexOf('BBB排序.md') < order.indexOf('教學'),
        `BBB排序 應排在「教學」資料夾前面, got: ${order}`
      );
    });

    console.log(`\n${passed} E2E steps passed ✅`);
  } catch (err) {
    console.error(`\n✗ E2E failed after ${passed} steps:\n`, err);
    process.exitCode = 1;
  } finally {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})();
