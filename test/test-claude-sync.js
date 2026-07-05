// Tests for the Claude Code memory digest (lib/claude-sync.js).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { collectClaudeMemory, projectLabel } = require('../lib/claude-sync');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myob-claude-'));
const mem = (proj) => path.join(tmp, 'projects', proj, 'memory');

// Project A: has a MEMORY.md index.
fs.mkdirSync(mem('-Users-test-projects-alpha'), { recursive: true });
fs.writeFileSync(path.join(mem('-Users-test-projects-alpha'), 'MEMORY.md'),
  '- [部署流程](deploy.md) — 用 rsync 部署到正式機\n- [DB 帳號](db.md) — 開發連 dev DB\n');
fs.writeFileSync(path.join(mem('-Users-test-projects-alpha'), 'deploy.md'), 'x');
fs.writeFileSync(path.join(mem('-Users-test-projects-alpha'), 'db.md'), 'x');

// Project B: identical index -> should be deduped.
fs.mkdirSync(mem('-Users-test-projects-alpha-copy'), { recursive: true });
fs.writeFileSync(path.join(mem('-Users-test-projects-alpha-copy'), 'MEMORY.md'),
  '- [部署流程](deploy.md) — 用 rsync 部署到正式機\n- [DB 帳號](db.md) — 開發連 dev DB\n');
fs.writeFileSync(path.join(mem('-Users-test-projects-alpha-copy'), 'deploy.md'), 'x');
fs.writeFileSync(path.join(mem('-Users-test-projects-alpha-copy'), 'db.md'), 'x');

// Project C: no MEMORY.md, digest built from frontmatter descriptions.
fs.mkdirSync(mem('-Users-test-projects-beta'), { recursive: true });
fs.writeFileSync(path.join(mem('-Users-test-projects-beta'), 'api-key.md'),
  '---\nname: api-key\ndescription: API 金鑰放在 1Password\n---\n\n內文');

// Global CLAUDE.md
fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), '# 全域規則\n\n永遠用繁體中文回覆。');

test('projectLabel 去掉共同前綴', () => {
  assert.strictEqual(projectLabel('-Users-lujianzhou-projects-mac-app-my-obsidian'), 'mac-app-my-obsidian');
  assert.strictEqual(projectLabel('-Users-test-projects-alpha'), 'alpha');
});

test('彙整全域 CLAUDE.md 與各專案記憶索引', () => {
  const { markdown, projects, entries } = collectClaudeMemory(tmp, new Date('2026-07-05T00:00:00Z'));
  assert.strictEqual(projects, 3);
  assert.strictEqual(entries, 5);
  assert.ok(markdown.includes('type: claude-code-memory'));
  assert.ok(markdown.includes('永遠用繁體中文回覆'));
  assert.ok(markdown.includes('### alpha（2 則）'));
  assert.ok(markdown.includes('rsync 部署到正式機'));
});

test('沒有 MEMORY.md 的專案改用 frontmatter description 摘要', () => {
  const { markdown } = collectClaudeMemory(tmp);
  assert.ok(markdown.includes('- api-key — API 金鑰放在 1Password'));
});

test('內容相同的專案索引會去重', () => {
  const { markdown } = collectClaudeMemory(tmp);
  assert.ok(markdown.includes('完全相同，略'));
  assert.strictEqual(markdown.split('rsync 部署到正式機').length - 1, 1, '相同索引只完整出現一次');
});

test('沒有 ~/.claude 時不會崩潰', () => {
  const empty = path.join(tmp, 'nothing-here');
  const { markdown, projects } = collectClaudeMemory(empty);
  assert.strictEqual(projects, 0);
  assert.ok(markdown.includes('本機沒有全域'));
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} claude-sync tests passed ✅`);
