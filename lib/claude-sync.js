// Aggregate this machine's Claude Code memory (~/.claude) into a single
// Markdown digest note, so syncing one note carries the essentials across
// devices. Sources: the global CLAUDE.md plus each project's memory/MEMORY.md
// index (one line per memory — already a digest by design).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

function defaultClaudeDir() {
  return process.env.MYOB_CLAUDE_DIR || path.join(os.homedir(), '.claude');
}

function readIfExists(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

// "-Users-lujianzhou-projects-mac-app-my-obsidian" -> "mac-app-my-obsidian"
function projectLabel(dirName) {
  return dirName.replace(/^-Users-[^-]+-projects-?/, '') || dirName.replace(/^-/, '');
}

// Fallback digest when a project has memory files but no MEMORY.md index:
// one line per file from its frontmatter description.
function indexFromFiles(memoryDir, files) {
  const lines = [];
  for (const file of files) {
    const text = readIfExists(path.join(memoryDir, file)) || '';
    const desc = /^description:\s*(.+)$/m.exec(text);
    lines.push(`- ${file.replace(/\.md$/i, '')}${desc ? ` — ${desc[1].trim()}` : ''}`);
  }
  return lines.join('\n');
}

function collectProjects(claudeDir) {
  const projRoot = path.join(claudeDir, 'projects');
  if (!fs.existsSync(projRoot)) return [];
  const projects = [];
  for (const dirName of fs.readdirSync(projRoot).sort()) {
    const memoryDir = path.join(projRoot, dirName, 'memory');
    let files;
    try {
      files = fs.readdirSync(memoryDir).filter((f) => /\.md$/i.test(f));
    } catch {
      continue;
    }
    const entryFiles = files.filter((f) => f !== 'MEMORY.md');
    if (files.length === 0) continue;
    const index = (readIfExists(path.join(memoryDir, 'MEMORY.md')) || indexFromFiles(memoryDir, entryFiles)).trim();
    if (!index) continue;
    projects.push({
      label: projectLabel(dirName),
      dirName,
      count: entryFiles.length,
      index,
      hash: crypto.createHash('sha1').update(index).digest('hex')
    });
  }
  return projects;
}

/**
 * Build the digest note. Returns { markdown, projects, entries }.
 */
function collectClaudeMemory(claudeDir = defaultClaudeDir(), now = new Date()) {
  const hostname = os.hostname().replace(/\.local$/i, '');
  const globalMd = readIfExists(path.join(claudeDir, 'CLAUDE.md'));
  const projects = collectProjects(claudeDir);
  const entries = projects.reduce((sum, p) => sum + p.count, 0);

  const out = [];
  out.push('---');
  out.push('type: claude-code-memory');
  out.push(`device: ${hostname}`);
  out.push(`synced: ${now.toISOString()}`);
  out.push(`projects: ${projects.length}`);
  out.push(`entries: ${entries}`);
  out.push('---');
  out.push('');
  out.push(`# Claude Code 記憶總覽（${hostname}）`);
  out.push('');
  out.push(`> 由 my_obsidian 自動彙整本機 Claude Code 記憶（來源：\`${claudeDir}\`）。`);
  out.push('> 跨裝置只需同步這一份筆記。內容為各專案 MEMORY.md 重點索引，完整記憶仍在本機。');
  out.push('');
  out.push('## 全域指示（CLAUDE.md）');
  out.push('');
  out.push(globalMd ? globalMd.trim() : '*本機沒有全域 `~/.claude/CLAUDE.md`。*');
  out.push('');
  out.push(`## 專案記憶（${projects.length} 個專案、共 ${entries} 則）`);

  const seenHash = new Map();
  for (const p of projects) {
    out.push('');
    out.push(`### ${p.label}（${p.count} 則）`);
    out.push('');
    out.push(`\`projects/${p.dirName}/memory\``);
    out.push('');
    const firstLabel = seenHash.get(p.hash);
    if (firstLabel) {
      out.push(`*記憶索引與「${firstLabel}」完全相同，略。*`);
    } else {
      seenHash.set(p.hash, p.label);
      out.push(p.index);
    }
  }
  out.push('');

  return { markdown: out.join('\n'), projects: projects.length, entries };
}

module.exports = { collectClaudeMemory, projectLabel, defaultClaudeDir };
