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
    await step('沒有 Vault 時,新筆記/匯出按鈕不會跳出對話框', async () => {
      await win.click('#btn-new-note');
      await win.click('#btn-export-note');
      await win.click('#btn-export-vault');
      assert.strictEqual(await win.isVisible('#modal-overlay'), false);
    });

    await step('stub 原生對話框後,「開啟 Vault」載入 SampleVault', async () => {
      await win.evaluate(({ vault, exportDir, exportFile }) => {
        const { ipcRenderer } = window.require('electron');
        const orig = ipcRenderer.invoke.bind(ipcRenderer);
        ipcRenderer.invoke = (ch, ...args) => {
          if (ch === 'choose-vault') return Promise.resolve(vault);
          if (ch === 'choose-save-html') return Promise.resolve(exportFile);
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

    await step('點擊筆記後,編輯器與預覽都正確載入', async () => {
      await win.click('#file-tree .tree-item.file:has-text("歡迎")');
      const text = await win.inputValue('#editor');
      assert.ok(text.startsWith('# 歡迎使用 my_obsidian'));
      assert.strictEqual(await win.textContent('#preview h1'), '歡迎使用 my_obsidian 👋');
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

    await step('匯出單篇 HTML(自包含檔案)', async () => {
      await win.click('#file-tree .tree-item.file:has-text("功能介紹")');
      await win.waitForFunction(() => document.querySelector('#editor').value.startsWith('# 功能介紹'));
      await win.click('#btn-export-note');
      await win.waitForFunction(
        (p) => window.require('fs').existsSync(p), exportFile, { timeout: 5000 }
      );
      const html = fs.readFileSync(exportFile, 'utf8');
      assert.ok(html.includes('<!DOCTYPE html>') && html.includes('hljs'));
    });

    await step('匯出整個 Vault 成 HTML 網站', async () => {
      await win.click('#btn-export-vault');
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

    console.log(`\n${passed} E2E steps passed ✅`);
  } catch (err) {
    console.error(`\n✗ E2E failed after ${passed} steps:\n`, err);
    process.exitCode = 1;
  } finally {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})();
