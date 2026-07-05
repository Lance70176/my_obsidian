// Tests for the categorized Claude Code memory digest (lib/claude-sync.js).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { collectClaudeMemory, buildNotes, syncToVault, groupFor } = require('../lib/claude-sync');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

/* ---- fixture: fake ~/.claude ---- */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myob-claude-'));
const claudeDir = path.join(tmp, 'claude');
const mem = (proj) => path.join(claudeDir, 'projects', proj, 'memory');
function writeProject(proj, memoryMd, files = {}) {
  fs.mkdirSync(mem(proj), { recursive: true });
  if (memoryMd !== null) fs.writeFileSync(path.join(mem(proj), 'MEMORY.md'), memoryMd);
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(mem(proj), name), content);
}

// Group "yc" with two subprojects (identical index -> dedup within group note).
writeProject('-Users-test-projects-yc-agent-api', '- [部署](d.md) — 用 rsync 部署\n', { 'd.md': 'x' });
writeProject('-Users-test-projects-yc-global-main', '- [部署](d.md) — 用 rsync 部署\n', { 'd.md': 'x' });
// Group "mac_app" (underscore encoded as dash).
writeProject('-Users-test-projects-mac-app-tool', '- [捷徑](k.md) — ⌘1/2/3 切換模式\n', { 'k.md': 'x' });
// Standalone group root.
writeProject('-Users-test-projects-solo', '- [獨立專案](s.md) — 單一專案記憶\n', { 's.md': 'x' });
// ~/projects root memory -> goes into 總記憶.
writeProject('-Users-test-projects', '- [共用](c.md) — 所有專案共同事項\n', { 'c.md': 'x' });
// No MEMORY.md -> digest from frontmatter descriptions.
writeProject('-Users-test-projects-beta', null, { 'key.md': '---\nname: key\ndescription: API 金鑰在 1Password\n---\n\n內文' });
// Global CLAUDE.md
fs.writeFileSync(path.join(claudeDir, 'CLAUDE.md'), '# 全域規則\n\n永遠用繁體中文回覆。');

const GROUP_DIRS = ['yc', 'mac_app', 'solo', 'beta'];
const opts = { listGroupDirs: () => GROUP_DIRS, host: 'test-mac', now: new Date('2026-07-05T00:00:00Z') };

test('groupFor:底線群組、最長比對、無比對時退回第一段', () => {
  assert.deepStrictEqual(groupFor('mac-app-tool', GROUP_DIRS), { group: 'mac_app', label: 'tool' });
  assert.deepStrictEqual(groupFor('yc-agent-api', GROUP_DIRS), { group: 'yc', label: 'agent-api' });
  assert.deepStrictEqual(groupFor('solo', GROUP_DIRS), { group: 'solo', label: '（根目錄）' });
  assert.deepStrictEqual(groupFor('unknown-thing', GROUP_DIRS), { group: 'unknown', label: 'unknown-thing' });
});

test('collect:依群組分類,根目錄記憶獨立', () => {
  const c = collectClaudeMemory(claudeDir, opts);
  assert.deepStrictEqual([...c.groups.keys()].sort(), ['beta', 'mac_app', 'solo', 'yc']);
  assert.strictEqual(c.groups.get('yc').length, 2);
  assert.strictEqual(c.rootProjects.length, 1);
  assert.ok(c.global.includes('永遠用繁體中文回覆'));
});

test('buildNotes:總記憶含全域指示、分類索引與根目錄記憶', () => {
  const c = collectClaudeMemory(claudeDir, opts);
  const notes = buildNotes(c, { host: 'test-mac', now: opts.now, noteDirRel: 'Claude 記憶/test-mac' });
  assert.strictEqual(notes.length, 5); // 總記憶 + 4 groups
  const main = notes[0];
  assert.strictEqual(main.name, '總記憶.md');
  assert.ok(main.content.includes('永遠用繁體中文回覆'));
  assert.ok(main.content.includes('[[Claude 記憶/test-mac/yc|yc]] — 2 個專案、2 則'));
  assert.ok(main.content.includes('所有專案共同事項'));
  assert.ok(!main.content.includes('rsync'), '專案記憶不應出現在總記憶');
});

test('buildNotes:群組筆記各自成篇,群組內去重', () => {
  const c = collectClaudeMemory(claudeDir, opts);
  const notes = buildNotes(c, { host: 'test-mac', now: opts.now, noteDirRel: 'Claude 記憶/test-mac' });
  const yc = notes.find((n) => n.name === 'yc.md');
  assert.ok(yc.content.includes('# yc — Claude Code 記憶'));
  assert.ok(yc.content.includes('### agent-api（1 則）'));
  assert.strictEqual(yc.content.split('用 rsync 部署').length - 1, 1, '相同索引只完整出現一次');
  assert.ok(yc.content.includes('完全相同，略'));
  const beta = notes.find((n) => n.name === 'beta.md');
  assert.ok(beta.content.includes('- key — API 金鑰在 1Password'));
});

test('syncToVault:寫入分類筆記並清掉舊版/過期的自動筆記,不動使用者筆記', () => {
  const vault = path.join(tmp, 'vault');
  const outDir = path.join(vault, 'Claude 記憶', 'test-mac');
  fs.mkdirSync(outDir, { recursive: true });
  // Legacy single-note layout + a stale generated group + a user-authored note.
  fs.writeFileSync(path.join(vault, 'Claude 記憶', '舊版筆記.md'), '---\ntype: claude-code-memory\n---\n舊');
  fs.writeFileSync(path.join(outDir, 'gone-group.md'), '---\ntype: claude-code-memory\n---\n過期');
  fs.writeFileSync(path.join(outDir, '我自己的筆記.md'), '# 手寫,不能被刪');

  const r = syncToVault(vault, claudeDir, opts);
  assert.strictEqual(r.files, 5);
  assert.strictEqual(r.groups, 4);
  assert.ok(fs.existsSync(path.join(outDir, '總記憶.md')));
  assert.ok(fs.existsSync(path.join(outDir, 'yc.md')));
  assert.ok(fs.existsSync(path.join(outDir, 'mac_app.md')));
  assert.ok(!fs.existsSync(path.join(vault, 'Claude 記憶', '舊版筆記.md')), '舊版自動筆記應清除');
  assert.ok(!fs.existsSync(path.join(outDir, 'gone-group.md')), '過期群組筆記應清除');
  assert.ok(fs.existsSync(path.join(outDir, '我自己的筆記.md')), '使用者筆記不能刪');
});

test('沒有 ~/.claude 時不會崩潰', () => {
  const vault2 = path.join(tmp, 'vault2');
  fs.mkdirSync(vault2, { recursive: true });
  const r = syncToVault(vault2, path.join(tmp, 'nothing-here'), opts);
  assert.strictEqual(r.groups, 0);
  const main = fs.readFileSync(r.mainNote, 'utf8');
  assert.ok(main.includes('本機沒有全域'));
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} claude-sync tests passed ✅`);
