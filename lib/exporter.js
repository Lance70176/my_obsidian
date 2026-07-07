// Export Markdown to standalone HTML: a single self-contained file (images
// inlined as data URIs) or a whole vault as a browsable static site.
const fs = require('fs');
const path = require('path');
const { createRenderer, escapeHtml, IMAGE_EXT } = require('./markdown');

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif'
};

const SKIP_DIRS = new Set(['node_modules', '.git', '.obsidian', '.trash']);

const DOC_CSS = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  margin: 0 auto;
  padding: 2.5rem 1.5rem 5rem;
  max-width: 820px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang TC",
    "Microsoft JhengHei", "Noto Sans TC", sans-serif;
  font-size: 16px;
  line-height: 1.75;
  color: #24292f;
  background: #ffffff;
  word-wrap: break-word;
}
h1, h2, h3, h4, h5, h6 { line-height: 1.3; margin: 1.6em 0 0.6em; font-weight: 650; }
h1 { font-size: 2em; border-bottom: 1px solid #d0d7de55; padding-bottom: 0.3em; margin-top: 0.4em; }
h2 { font-size: 1.5em; border-bottom: 1px solid #d0d7de55; padding-bottom: 0.25em; }
h3 { font-size: 1.25em; }
p { margin: 0.8em 0; }
a { color: #0969da; text-decoration: none; }
a:hover { text-decoration: underline; }
a.wikilink { color: #7c5cff; }
a.wikilink.broken, span.wikilink { color: #b35900; border-bottom: 1px dashed currentColor; }
img { max-width: 100%; border-radius: 6px; }
code { font-family: "SF Mono", ui-monospace, Menlo, Consolas, monospace; font-size: 0.875em; }
:not(pre) > code { background: #afb8c133; padding: 0.15em 0.4em; border-radius: 4px; }
pre { overflow-x: auto; padding: 1em; border-radius: 8px; line-height: 1.55; background: #f6f8fa; }
blockquote { margin: 1em 0; padding: 0.1em 1em; border-left: 4px solid #d0d7de; color: #57606a; }
table { border-collapse: collapse; margin: 1em 0; display: block; overflow-x: auto; max-width: 100%; }
th, td { border: 1px solid #d0d7de; padding: 0.4em 0.9em; }
th { background: #f6f8fa; }
hr { border: none; border-top: 1px solid #d0d7de; margin: 2em 0; }
ul, ol { padding-left: 1.6em; }
li { margin: 0.25em 0; }
li > input[type="checkbox"] { margin-right: 0.45em; }
li:has(> input[type="checkbox"]) { list-style: none; margin-left: -1.3em; }
.mermaid-block { margin: 1.2em 0; text-align: center; page-break-inside: avoid; }
.mermaid-block img, .mermaid-block svg { max-width: 100%; height: auto; }
.mermaid-block pre { text-align: left; }
`;

const DOC_CSS_DARK = `
@media (prefers-color-scheme: dark) {
  body { color: #d4d4d8; background: #17171e; }
  a { color: #58a6ff; }
  a.wikilink { color: #a78bfa; }
  a.wikilink.broken, span.wikilink { color: #d4a054; }
  h1, h2 { border-bottom-color: #3f3f4655; }
  :not(pre) > code { background: #6e768140; }
  pre { background: #22222b; }
  blockquote { border-left-color: #3f3f46; color: #9ca3af; }
  th, td { border-color: #3f3f46; }
  th { background: #22222b; }
  hr { border-top-color: #3f3f46; }
}
`;

function loadHighlightCss(dark) {
  const stylesDir = path.join(require.resolve('highlight.js/package.json'), '..', 'styles');
  const light = fs.readFileSync(path.join(stylesDir, 'github.min.css'), 'utf8');
  if (!dark) return light;
  const darkCss = fs.readFileSync(path.join(stylesDir, 'github-dark.min.css'), 'utf8');
  return `${light}\n@media (prefers-color-scheme: dark) {\n${darkCss}\n}`;
}

// dark:false 產生純淺色版(給 PDF 列印用,避免深色系統印出黑底)。
function htmlDocument(title, bodyHtml, { dark = true } = {}) {
  const docCss = dark ? DOC_CSS + DOC_CSS_DARK : DOC_CSS.replace('light dark', 'light');
  return `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="my_obsidian">
<title>${escapeHtml(title)}</title>
<style>${docCss}</style>
<style>${loadHighlightCss(dark)}</style>
</head>
<body>
<main class="markdown-body">
${bodyHtml}
</main>
</body>
</html>
`;
}

function isMarkdown(name) {
  return /\.(md|markdown)$/i.test(name);
}

function noteTitle(filePath) {
  return path.basename(filePath).replace(/\.(md|markdown)$/i, '');
}

// Recursively collect vault files, returning vault-relative POSIX paths.
function walkVault(vaultRoot, excludeDir) {
  const notes = [];
  const assets = [];
  const excludeAbs = excludeDir ? path.resolve(excludeDir) : null;
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (excludeAbs && path.resolve(abs) === excludeAbs) continue;
        walk(abs);
      } else if (entry.isFile()) {
        const rel = path.relative(vaultRoot, abs).split(path.sep).join('/');
        (isMarkdown(entry.name) ? notes : assets).push(rel);
      }
    }
  })(vaultRoot);
  return { notes, assets };
}

// Wikilink resolution index: match by full vault-relative path (sans
// extension) first, then by bare note name.
function buildNoteIndex(noteRelPaths) {
  const byPath = new Map();
  const byName = new Map();
  for (const rel of noteRelPaths) {
    const noExt = rel.replace(/\.(md|markdown)$/i, '');
    byPath.set(noExt.toLowerCase(), rel);
    const name = noExt.split('/').pop().toLowerCase();
    if (!byName.has(name)) byName.set(name, rel);
  }
  return (target) => {
    const key = target.replace(/\.(md|markdown)$/i, '').toLowerCase();
    return byPath.get(key) || byName.get(key.split('/').pop()) || null;
  };
}

function mdHrefToHtml(href) {
  // Rewrite local .md links to .html, leaving absolute URLs untouched.
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) return href;
  return href.replace(/\.(md|markdown)(?=(#|$))/i, '.html');
}

function relativeHref(fromRelFile, toRelFile) {
  const rel = path.posix.relative(path.posix.dirname(fromRelFile), toRelFile);
  return rel.split('/').map(encodeURIComponent).join('/');
}

function inlineAssetResolver(mdDir) {
  return (href) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) return href;
    const filePath = path.resolve(mdDir, decodeURIComponent(href.split('#')[0].split('?')[0]));
    const mime = MIME[path.extname(filePath).toLowerCase()];
    if (!mime || !fs.existsSync(filePath)) return href;
    return `data:${mime};base64,${fs.readFileSync(filePath).toString('base64')}`;
  };
}

/**
 * Export one note to a single self-contained HTML file. Local images are
 * inlined as data URIs; wikilinks render as styled text (there is no target
 * page in a single-file export).
 */
function renderNoteHtml(mdPath, opts = {}) {
  const mdDir = path.dirname(mdPath);
  const renderer = createRenderer({
    resolveAsset: inlineAssetResolver(mdDir),
    rewriteLink: (href) => href
  });
  const body = renderer.renderBody(fs.readFileSync(mdPath, 'utf8'));
  return htmlDocument(noteTitle(mdPath), body, opts);
}

function exportNote(mdPath, outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, renderNoteHtml(mdPath));
  return outPath;
}

/**
 * Export the whole vault to outDir as a static HTML site: every note becomes
 * an .html preserving folder structure, wikilinks/.md links are rewritten,
 * assets are copied alongside, and an index page lists all notes.
 */
function exportVault(vaultRoot, outDir) {
  vaultRoot = path.resolve(vaultRoot);
  outDir = path.resolve(outDir);
  const { notes, assets } = walkVault(vaultRoot, outDir);
  const resolveNote = buildNoteIndex(notes);

  fs.mkdirSync(outDir, { recursive: true });
  for (const rel of notes) {
    const htmlRel = rel.replace(/\.(md|markdown)$/i, '.html');
    const renderer = createRenderer({
      resolveWikilink: (target) => {
        const found = resolveNote(target);
        if (!found) return { href: '#', exists: false };
        const targetHtml = found.replace(/\.(md|markdown)$/i, '.html');
        return { href: relativeHref(htmlRel, targetHtml), exists: true };
      },
      resolveAsset: (href) => href,
      rewriteLink: mdHrefToHtml
    });
    const body = renderer.renderBody(fs.readFileSync(path.join(vaultRoot, rel), 'utf8'));
    const outFile = path.join(outDir, htmlRel);
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, htmlDocument(noteTitle(rel), body));
  }

  for (const rel of assets) {
    const dest = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(vaultRoot, rel), dest);
  }

  writeIndexPage(outDir, vaultRoot, notes);
  return { notes: notes.length, assets: assets.length, outDir };
}

function writeIndexPage(outDir, vaultRoot, notes) {
  const hasOwnIndex = notes.some((rel) => rel.toLowerCase() === 'index.md');
  const indexName = hasOwnIndex ? '_toc.html' : 'index.html';
  const items = [...notes]
    .sort((a, b) => a.localeCompare(b, 'zh-Hant'))
    .map((rel) => {
      const htmlRel = rel.replace(/\.(md|markdown)$/i, '.html');
      const href = htmlRel.split('/').map(encodeURIComponent).join('/');
      return `<li><a href="${href}">${escapeHtml(rel.replace(/\.(md|markdown)$/i, ''))}</a></li>`;
    })
    .join('\n');
  const body = `<h1>${escapeHtml(path.basename(vaultRoot))}</h1>\n<p>共 ${notes.length} 篇筆記</p>\n<ul>\n${items}\n</ul>`;
  fs.writeFileSync(path.join(outDir, indexName), htmlDocument(path.basename(vaultRoot), body));
}

module.exports = { exportNote, renderNoteHtml, exportVault, htmlDocument, walkVault, buildNoteIndex, mdHrefToHtml };
