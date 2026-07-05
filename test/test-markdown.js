// Smoke tests for the rendering core and the HTML exporters.
// Run with: npm test
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRenderer, stripFrontmatter } = require('../lib/markdown');
const { exportNote, exportVault, mdHrefToHtml, buildNoteIndex } = require('../lib/exporter');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

/* ---- markdown core ---- */

test('renders basic markdown', () => {
  const html = createRenderer().renderBody('# 標題\n\n**粗體** 與 `code`');
  assert.match(html, /<h1[^>]*>標題<\/h1>/);
  assert.match(html, /<strong>粗體<\/strong>/);
  assert.match(html, /<code>code<\/code>/);
});

test('highlights fenced code', () => {
  const html = createRenderer().renderBody('```js\nconst x = 1;\n```');
  assert.match(html, /class="hljs language-js"/);
  assert.match(html, /hljs-keyword/);
});

test('renders GFM tables and task lists', () => {
  const html = createRenderer().renderBody('| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n- [ ] todo');
  assert.match(html, /<table>/);
  assert.match(html, /type="checkbox"/);
});

test('wikilinks resolve with alias and broken state', () => {
  const renderer = createRenderer({
    resolveWikilink: (target) => ({ href: `${target}.html`, exists: target === '存在' })
  });
  const html = renderer.renderBody('[[存在]] [[存在|別名]] [[不存在]]');
  assert.match(html, /<a class="wikilink" href="存在.html"[^>]*>存在<\/a>/);
  assert.match(html, /<a class="wikilink" href="存在.html"[^>]*>別名<\/a>/);
  assert.match(html, /<a class="wikilink broken"[^>]*>不存在<\/a>/);
});

test('wikilink image embed renders <img>', () => {
  const renderer = createRenderer({ resolveAsset: (href) => `assets/${href}` });
  const html = renderer.renderBody('![[圖.png]]');
  assert.match(html, /<img src="assets\/圖.png"/);
});

test('wikilinks without resolver render as plain text', () => {
  const html = createRenderer().renderBody('[[某筆記|顯示文字]]');
  assert.ok(html.includes('顯示文字'));
  assert.ok(!html.includes('<a'));
});

test('strips YAML frontmatter', () => {
  assert.strictEqual(stripFrontmatter('---\ntags: [a]\n---\n# hi'), '# hi');
  const html = createRenderer().renderBody('---\ntags: [a]\n---\n# hi');
  assert.ok(!html.includes('tags'));
});

test('escapes raw HTML-ish text in code', () => {
  const html = createRenderer().renderBody('```\n<script>alert(1)</script>\n```');
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});

/* ---- link helpers ---- */

test('mdHrefToHtml rewrites only local .md links', () => {
  assert.strictEqual(mdHrefToHtml('note.md'), 'note.html');
  assert.strictEqual(mdHrefToHtml('../a/b.md#sec'), '../a/b.html#sec');
  assert.strictEqual(mdHrefToHtml('https://x.com/a.md'), 'https://x.com/a.md');
});

test('buildNoteIndex matches by name and by path', () => {
  const resolve = buildNoteIndex(['歡迎.md', '教學/匯出說明.md']);
  assert.strictEqual(resolve('歡迎'), '歡迎.md');
  assert.strictEqual(resolve('匯出說明'), '教學/匯出說明.md');
  assert.strictEqual(resolve('教學/匯出說明'), '教學/匯出說明.md');
  assert.strictEqual(resolve('不存在'), null);
});

/* ---- exporters (real files in a temp dir) ---- */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myob-test-'));
const vault = path.join(tmp, 'vault');
fs.mkdirSync(path.join(vault, '教學'), { recursive: true });
fs.mkdirSync(path.join(vault, 'assets'), { recursive: true });
// 1x1 red PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
fs.writeFileSync(path.join(vault, 'assets', 'dot.png'), PNG);
fs.writeFileSync(path.join(vault, '歡迎.md'), '# 歡迎\n\n連到 [[教學/筆記A]] 與 [md 連結](教學/筆記A.md)。\n\n![點](assets/dot.png)\n');
fs.writeFileSync(path.join(vault, '教學', '筆記A.md'), '# 筆記A\n\n回 [[歡迎]]\n');

test('exportNote produces a standalone HTML file with inlined image', () => {
  const out = path.join(tmp, 'single.html');
  exportNote(path.join(vault, '歡迎.md'), out);
  const html = fs.readFileSync(out, 'utf8');
  assert.match(html, /<!DOCTYPE html>/);
  assert.match(html, /<title>歡迎<\/title>/);
  assert.ok(html.includes('data:image/png;base64,'), 'image should be inlined as data URI');
  assert.ok(html.includes('<style>'), 'CSS should be embedded');
  assert.ok(html.includes('prefers-color-scheme: dark'), 'dark theme should be embedded');
});

test('exportVault builds a linked static site', () => {
  const out = path.join(tmp, 'site');
  const result = exportVault(vault, out);
  assert.strictEqual(result.notes, 2);
  assert.strictEqual(result.assets, 1);
  const welcome = fs.readFileSync(path.join(out, '歡迎.html'), 'utf8');
  assert.ok(welcome.includes(`href="${encodeURIComponent('教學')}/${encodeURIComponent('筆記A')}.html"`), 'wikilink rewritten to relative html');
  assert.ok(welcome.includes('教學/筆記A.html'.split('/').map(decodeURIComponent).join('/')) || welcome.includes('筆記A.html'), 'md link rewritten');
  const noteA = fs.readFileSync(path.join(out, '教學', '筆記A.html'), 'utf8');
  assert.ok(noteA.includes(`href="../${encodeURIComponent('歡迎')}.html"`), 'back wikilink uses ../');
  assert.ok(fs.existsSync(path.join(out, 'assets', 'dot.png')), 'asset copied');
  assert.ok(fs.existsSync(path.join(out, 'index.html')), 'index generated');
  const index = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
  assert.ok(index.includes('共 2 篇筆記'));
});

test('exportVault skips the output dir when it is inside the vault', () => {
  const out = path.join(vault, '_export');
  const result = exportVault(vault, out);
  assert.strictEqual(result.notes, 2, 'exported html must not be re-picked as source');
  fs.rmSync(out, { recursive: true, force: true });
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} tests passed ✅`);
