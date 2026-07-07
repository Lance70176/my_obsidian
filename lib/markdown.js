// Shared Markdown rendering core, used by both the in-app preview and the
// HTML exporter so the two outputs always match.
const { Marked } = require('marked');
const hljs = require('highlight.js');

const IMAGE_EXT = /\.(png|jpe?g|gif|svg|webp|bmp|avif)$/i;

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Create a Markdown renderer.
 *
 * options.resolveWikilink(target) -> { href, exists } | null
 *   Maps an Obsidian-style [[target]] to a link. null renders plain text.
 * options.resolveAsset(href) -> string
 *   Maps a relative image/asset path to a usable URL (file://, data:, ...).
 * options.rewriteLink(href) -> string
 *   Last-chance hook for normal [text](href) links (e.g. .md -> .html).
 */
function createRenderer(options = {}) {
  const resolveWikilink = options.resolveWikilink || null;
  const resolveAsset = options.resolveAsset || ((href) => href);
  const rewriteLink = options.rewriteLink || ((href) => href);

  const wikilink = {
    name: 'wikilink',
    level: 'inline',
    start(src) {
      const i = src.search(/!?\[\[/);
      return i === -1 ? undefined : i;
    },
    tokenizer(src) {
      const match = /^(!?)\[\[([^\]|#\n]+)(?:#([^\]|\n]+))?(?:\|([^\]\n]+))?\]\]/.exec(src);
      if (!match) return undefined;
      return {
        type: 'wikilink',
        raw: match[0],
        embed: match[1] === '!',
        target: match[2].trim(),
        anchor: match[3] ? match[3].trim() : null,
        alias: match[4] ? match[4].trim() : null
      };
    },
    renderer(token) {
      const label = token.alias || (token.anchor ? `${token.target} › ${token.anchor}` : token.target);
      if (token.embed && IMAGE_EXT.test(token.target)) {
        const src = resolveAsset(token.target);
        return `<img src="${escapeHtml(src)}" alt="${escapeHtml(label)}">`;
      }
      if (!resolveWikilink) return escapeHtml(label);
      const resolved = resolveWikilink(token.target);
      if (!resolved) return escapeHtml(label);
      const cls = resolved.exists === false ? 'wikilink broken' : 'wikilink';
      const anchor = token.anchor ? `#${encodeURIComponent(token.anchor)}` : '';
      return `<a class="${cls}" href="${escapeHtml(resolved.href)}${anchor}" data-wikilink="${escapeHtml(token.target)}">${escapeHtml(label)}</a>`;
    }
  };

  const renderer = {
    code(token) {
      const lang = (token.lang || '').trim().split(/\s+/)[0];
      if (lang === 'mermaid') {
        // Placeholder rendered into an SVG/image by the environment that has a
        // DOM (preview and export flows in the renderer process); the escaped
        // source doubles as a visible fallback when rendering fails.
        return `<div class="mermaid-block" data-mermaid="${escapeHtml(token.text)}">` +
          `<pre><code class="hljs language-mermaid">${escapeHtml(token.text)}</code></pre></div>\n`;
      }
      let body;
      if (lang && hljs.getLanguage(lang)) {
        body = hljs.highlight(token.text, { language: lang, ignoreIllegals: true }).value;
      } else {
        body = escapeHtml(token.text);
      }
      const cls = `hljs language-${escapeHtml(lang || 'plaintext')}`;
      return `<pre><code class="${cls}">${body}</code></pre>\n`;
    },
    image(token) {
      const src = resolveAsset(token.href || '');
      const title = token.title ? ` title="${escapeHtml(token.title)}"` : '';
      return `<img src="${escapeHtml(src)}" alt="${escapeHtml(token.text || '')}"${title}>`;
    },
    link(token) {
      const href = rewriteLink(token.href || '');
      const title = token.title ? ` title="${escapeHtml(token.title)}"` : '';
      const external = /^https?:/i.test(href) ? ' data-external="1"' : '';
      const body = this.parser.parseInline(token.tokens);
      return `<a href="${escapeHtml(href)}"${title}${external}>${body}</a>`;
    }
  };

  const marked = new Marked({ gfm: true, breaks: false });
  marked.use({ extensions: [wikilink], renderer });

  return {
    renderBody(markdownText) {
      const text = stripFrontmatter(markdownText != null ? String(markdownText) : '');
      return marked.parse(text);
    }
  };
}

// Obsidian notes often start with a YAML frontmatter block; it is metadata,
// not content, so drop it before rendering.
function stripFrontmatter(text) {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text);
  return match ? text.slice(match[0].length) : text;
}

module.exports = { createRenderer, escapeHtml, stripFrontmatter, IMAGE_EXT };
