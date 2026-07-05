// Aggregate this machine's Claude Code memory (~/.claude) into a folder of
// digest notes inside the vault:
//
//   Claude 記憶/<hostname>/總記憶.md   — global CLAUDE.md + group index + root memories
//   Claude 記憶/<hostname>/<group>.md — one note per project group (yc, fq, ...)
//
// A "group" is the first directory level under /Users/<user>/projects, matched
// against the real filesystem (longest-prefix), which also resolves the
// dash-encoding ambiguity of "_" and "/" in ~/.claude/projects dir names.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const NOTE_TYPE = 'type: claude-code-memory';

function defaultClaudeDir() {
  return process.env.MYOB_CLAUDE_DIR || path.join(os.homedir(), '.claude');
}

function hostName() {
  return os.hostname().replace(/\.local$/i, '');
}

function readIfExists(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

// "-Users-lujianzhou-projects-yc-yc-agent-api" -> { user, rest: "yc-yc-agent-api" }
function parseProjectDir(dirName) {
  const m = /^-Users-([^-]+)-projects-?(.*)$/.exec(dirName);
  return m ? { user: m[1], rest: m[2] } : null;
}

function defaultListGroupDirs(user) {
  try {
    return fs.readdirSync(path.join('/Users', user, 'projects'), { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

// Match the encoded remainder against real group dirs; "_" and "/" both
// encode to "-", so compare on normalized names, longest match wins.
function groupFor(rest, groupDirs) {
  let best = null;
  for (const dir of groupDirs) {
    const norm = dir.replace(/[_/]/g, '-');
    if ((rest === norm || rest.startsWith(norm + '-')) && (!best || norm.length > best.norm.length)) {
      best = { dir, norm };
    }
  }
  if (best) {
    const label = rest === best.norm ? '（根目錄）' : rest.slice(best.norm.length + 1);
    return { group: best.dir, label };
  }
  return { group: rest.split('-')[0], label: rest };
}

// Fallback digest when a project has memory files but no MEMORY.md index.
function indexFromFiles(memoryDir, files) {
  return files.map((file) => {
    const text = readIfExists(path.join(memoryDir, file)) || '';
    const desc = /^description:\s*(.+)$/m.exec(text);
    return `- ${file.replace(/\.md$/i, '')}${desc ? ` — ${desc[1].trim()}` : ''}`;
  }).join('\n');
}

/**
 * Scan claudeDir and return { global, rootProjects, groups } where groups is
 * a Map: groupName -> [{ label, dirName, count, index, hash }].
 */
function collectClaudeMemory(claudeDir = defaultClaudeDir(), opts = {}) {
  const listGroupDirs = opts.listGroupDirs || defaultListGroupDirs;
  const groupDirCache = new Map();
  const global = readIfExists(path.join(claudeDir, 'CLAUDE.md'));
  const groups = new Map();
  const rootProjects = [];

  const projRoot = path.join(claudeDir, 'projects');
  const dirNames = fs.existsSync(projRoot) ? fs.readdirSync(projRoot).sort() : [];
  for (const dirName of dirNames) {
    const memoryDir = path.join(projRoot, dirName, 'memory');
    let files;
    try {
      files = fs.readdirSync(memoryDir).filter((f) => /\.md$/i.test(f));
    } catch {
      continue;
    }
    if (files.length === 0) continue;
    const entryFiles = files.filter((f) => f !== 'MEMORY.md');
    const index = (readIfExists(path.join(memoryDir, 'MEMORY.md')) || indexFromFiles(memoryDir, entryFiles)).trim();
    if (!index) continue;

    const parsed = parseProjectDir(dirName);
    const project = {
      dirName,
      count: entryFiles.length,
      index,
      hash: crypto.createHash('sha1').update(index).digest('hex')
    };
    if (!parsed || parsed.rest === '') {
      rootProjects.push({ ...project, label: parsed ? '~/projects' : dirName });
      continue;
    }
    if (!groupDirCache.has(parsed.user)) groupDirCache.set(parsed.user, listGroupDirs(parsed.user));
    const { group, label } = groupFor(parsed.rest, groupDirCache.get(parsed.user));
    project.label = label;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(project);
  }
  return { global, rootProjects, groups };
}

function frontmatter(fields) {
  return ['---', NOTE_TYPE, ...Object.entries(fields).map(([k, v]) => `${k}: ${v}`), '---', ''].join('\n');
}

function projectSections(projects) {
  const out = [];
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
  return out;
}

/**
 * Build all notes. Returns [{ name, content }]; the first entry is 總記憶.
 */
function buildNotes(collection, { host = hostName(), now = new Date(), noteDirRel } = {}) {
  const { global, rootProjects, groups } = collection;
  const groupNames = [...groups.keys()].sort((a, b) => a.localeCompare(b, 'zh-Hant'));
  const totalProjects = rootProjects.length + groupNames.reduce((n, g) => n + groups.get(g).length, 0);
  const totalEntries = [...groups.values()].flat().concat(rootProjects).reduce((n, p) => n + p.count, 0);
  const synced = now.toISOString();
  const notes = [];

  const main = [];
  main.push(frontmatter({ device: host, synced, groups: groupNames.length, projects: totalProjects, entries: totalEntries }));
  main.push(`# Claude Code 總記憶（${host}）`);
  main.push('');
  main.push('> 由 my_obsidian 自動彙整本機 Claude Code 記憶。共同事項在這份筆記，');
  main.push('> 各公司／群組的專案記憶依分類拆成同資料夾內的個別筆記。');
  main.push('');
  main.push('## 全域指示（CLAUDE.md）');
  main.push('');
  main.push(global ? global.trim() : '*本機沒有全域 `~/.claude/CLAUDE.md`。*');
  main.push('');
  main.push(`## 分類索引（${groupNames.length} 類、${totalProjects} 個專案、共 ${totalEntries} 則）`);
  main.push('');
  for (const g of groupNames) {
    const list = groups.get(g);
    const entries = list.reduce((n, p) => n + p.count, 0);
    main.push(`- [[${noteDirRel}/${g}|${g}]] — ${list.length} 個專案、${entries} 則`);
  }
  if (rootProjects.length) {
    main.push('');
    main.push('## 共同／根目錄記憶');
    main.push(...projectSections(rootProjects));
  }
  main.push('');
  notes.push({ name: '總記憶.md', content: main.join('\n') });

  for (const g of groupNames) {
    const list = groups.get(g);
    const entries = list.reduce((n, p) => n + p.count, 0);
    const out = [];
    out.push(frontmatter({ device: host, synced, group: g, projects: list.length, entries }));
    out.push(`# ${g} — Claude Code 記憶`);
    out.push('');
    out.push(`> ${list.length} 個專案、共 ${entries} 則。回 [[${noteDirRel}/總記憶|總記憶]]。`);
    out.push(...projectSections(list));
    out.push('');
    notes.push({ name: `${g.replace(/[/\\:]/g, '-')}.md`, content: out.join('\n') });
  }
  return notes;
}

function isGeneratedNote(file) {
  const head = readIfExists(file);
  return !!head && head.startsWith('---') && head.slice(0, 400).includes(`\n${NOTE_TYPE}\n`);
}

/**
 * Sync into the vault: write Claude 記憶/<host>/*.md, prune generated notes
 * that no longer exist (including the legacy single-note layout), never touch
 * user-authored files. Returns { mainNote, files, groups, projects, entries }.
 */
function syncToVault(vaultDir, claudeDir = defaultClaudeDir(), opts = {}) {
  const host = opts.host || hostName();
  const baseDir = path.join(vaultDir, 'Claude 記憶');
  const outDir = path.join(baseDir, host);
  const noteDirRel = `Claude 記憶/${host}`;

  const collection = collectClaudeMemory(claudeDir, opts);
  const notes = buildNotes(collection, { host, now: opts.now || new Date(), noteDirRel });

  fs.mkdirSync(outDir, { recursive: true });
  const keep = new Set(notes.map((n) => n.name));
  for (const existing of fs.readdirSync(outDir)) {
    if (/\.md$/i.test(existing) && !keep.has(existing) && isGeneratedNote(path.join(outDir, existing))) {
      fs.rmSync(path.join(outDir, existing));
    }
  }
  // Legacy layout: single generated note directly under Claude 記憶/.
  for (const existing of fs.readdirSync(baseDir)) {
    const full = path.join(baseDir, existing);
    if (/\.md$/i.test(existing) && fs.statSync(full).isFile() && isGeneratedNote(full)) fs.rmSync(full);
  }
  for (const note of notes) fs.writeFileSync(path.join(outDir, note.name), note.content);

  const groupCount = notes.length - 1;
  const projects = collection.rootProjects.length + [...collection.groups.values()].flat().length;
  const entries = [...collection.groups.values()].flat().concat(collection.rootProjects).reduce((n, p) => n + p.count, 0);
  return { mainNote: path.join(outDir, '總記憶.md'), outDir, files: notes.length, groups: groupCount, projects, entries };
}

module.exports = { collectClaudeMemory, buildNotes, syncToVault, groupFor, parseProjectDir, defaultClaudeDir, hostName };
