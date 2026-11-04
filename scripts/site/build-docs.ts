/** Builds site/docs/*.html from docs/*.md (+ a few root files). Run: node scripts/site/build-docs.ts */
import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync } from 'node:fs';
import { join, dirname, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, 'site');
const REPO = 'https://github.com/techsaurabh-394/haat-gateway';
const GH = `${REPO}/blob/main/`;

type Page = { slug: string; src: string; title: string; blurb: string; group: string };
const pages: Page[] = [
  { slug: 'quickstart', src: 'docs/quickstart.md', title: 'Quickstart and API', blurb: 'Run it, call it, approve an order.', group: 'Start' },
  { slug: 'architecture', src: 'docs/architecture.md', title: 'Architecture', blurb: 'Three layers and the request lifecycle.', group: 'Understand' },
  { slug: 'protocol-mapping', src: 'docs/protocol-mapping.md', title: 'Poppy to Beckn mapping', blurb: 'How each Poppy call becomes Beckn.', group: 'Understand' },
  { slug: 'security', src: 'docs/security.md', title: 'Security model', blurb: 'Sessions, SSRF, approval binding.', group: 'Understand' },
  { slug: 'domain-packs', src: 'docs/domain-packs.md', title: 'Domain packs', blurb: 'Add a vertical with two JSON files.', group: 'Extend' },
  { slug: 'lexicon', src: 'docs/lexicon.md', title: 'Language lexicon', blurb: 'How Indian languages are understood.', group: 'Extend' },
  { slug: 'going-live', src: 'docs/going-live.md', title: 'Going live on ONDC', blurb: 'Step by step, with what is unverified.', group: 'Ship' },
  { slug: 'conformance', src: 'docs/conformance.md', title: 'Conformance', blurb: 'The official validator and how to rerun it.', group: 'Ship' },
  { slug: 'limitations', src: 'docs/limitations.md', title: 'Limitations', blurb: 'What it does not do, plainly.', group: 'Ship' },
  { slug: 'roadmap', src: 'ROADMAP.md', title: 'Roadmap', blurb: 'What comes next.', group: 'Project' },
  { slug: 'contributing', src: 'CONTRIBUTING.md', title: 'Contributing', blurb: 'Your first PR in about 10 minutes.', group: 'Project' },
  { slug: 'changelog', src: 'CHANGELOG.md', title: 'Changelog', blurb: 'Release notes.', group: 'Project' },
  { slug: 'audit', src: 'docs/AUDIT.md', title: 'Repository audit', blurb: 'What not to do, learned the hard way.', group: 'Project' },
];
const bySrc = new Map(pages.map((p) => [p.src, p]));
const groups = [...new Set(pages.map((p) => p.group))];
const groupIcon: Record<string, string> = { Start: 'i-rocket', Understand: 'i-layers', Extend: 'i-blocks', Ship: 'i-ship', Project: 'i-users' };
const groupBlurb: Record<string, string> = {
  Start: 'Get a gateway and mock ONDC network running locally.',
  Understand: 'How Haat is built and why it is safe.',
  Extend: 'Add verticals and teach it new languages.',
  Ship: 'Conformance, onboarding and honest limits.',
  Project: 'Roadmap, contributing and release notes.',
};

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const slugify = (s: string) => s.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-');
const strip = (s: string) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&');

function fixHref(href: string, srcPath: string): string {
  if (/^(https?:|mailto:|#)/.test(href)) return href;
  const [path, hash] = href.split('#');
  const resolved = posix.normalize(posix.join(posix.dirname(srcPath), path));
  const page = bySrc.get(resolved);
  if (page) return `${page.slug}.html${hash ? '#' + hash : ''}`;
  if (resolved.startsWith('assets/')) return `../${resolved}`;
  return GH + resolved + (hash ? '#' + hash : '');
}

/* Simple, dependency-free syntax colouring for the few languages the docs use. */
function highlight(code: string, lang: string): string {
  const e = esc(code);
  const L = lang.toLowerCase();
  if (['bash', 'sh', 'shell', 'console', 'zsh'].includes(L)) {
    return e.split('\n').map((l) => {
      if (/^\s*#/.test(l)) return `<span class="tk-c">${l}</span>`;
      return l.replace(/(\s#\s.*)$/, '<span class="tk-c">$1</span>')
        .replace(/^(\s*)([\w./-]+)/, '$1<span class="tk-f">$2</span>')
        .replace(/(\s)(--?[\w-]+)/g, '$1<span class="tk-k">$2</span>');
    }).join('\n');
  }
  if (['json', 'jsonc'].includes(L)) {
    return e.replace(/(&quot;[^&\n]*?&quot;)(\s*:)/g, '<span class="tk-k">$1</span>$2')
      .replace(/(:\s*)(&quot;[^\n]*?&quot;)/g, '$1<span class="tk-s">$2</span>')
      .replace(/\b(true|false|null)\b/g, '<span class="tk-n">$1</span>')
      .replace(/(:\s*)(-?\d+(?:\.\d+)?)/g, '$1<span class="tk-n">$2</span>');
  }
  if (['ts', 'typescript', 'js', 'javascript', 'mjs'].includes(L)) {
    const KW = /^(const|let|var|function|return|await|async|import|from|export|type|interface|new|if|else|for|of|in|throw|try|catch|class|extends|default|true|false|null|undefined)$/;
    const re = /(\/\/[^\n]*)|(&quot;(?:(?!&quot;)[^\n\\]|\\.)*&quot;|'(?:[^'\n\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|\b(\d+(?:\.\d+)?)\b|\b([A-Za-z_$][\w$]*)\b(\s*\()?/g;
    return e.replace(re, (m, com, str, num, id, call) => {
      if (com) return `<span class="tk-c">${com}</span>`;
      if (str) return `<span class="tk-s">${str}</span>`;
      if (num) return `<span class="tk-n">${num}</span>`;
      if (KW.test(id)) return `<span class="tk-k">${id}</span>${call ?? ''}`;
      if (call) return `<span class="tk-f">${id}</span>${call}`;
      return m;
    });
  }
  if (['http'].includes(L)) {
    return e.replace(/^(GET|POST|PUT|PATCH|DELETE|HTTP\/[\d.]+)/gm, '<span class="tk-k">$1</span>')
      .replace(/^([\w-]+)(:)/gm, '<span class="tk-f">$1</span>$2');
  }
  return e;
}

type Toc = { id: string; text: string; depth: number };

function render(p: Page): string {
  const md = readFileSync(join(ROOT, p.src), 'utf8');
  const toc: Toc[] = [];
  const r = new marked.Renderer();
  let firstH1 = true;
  r.heading = function ({ tokens, depth, text }) {
    const id = slugify(text);
    if (depth === 1 && firstH1) { firstH1 = false; return ''; } // page header shows the title
    const inner = this.parser.parseInline(tokens);
    if (depth === 2 || depth === 3) toc.push({ id, text: strip(inner), depth });
    return `<h${depth} id="${id}"><a class="anchor" href="#${id}" aria-label="Link to this section">#</a>${inner}</h${depth}>`;
  };
  r.link = function ({ href, title, tokens }) {
    const url = fixHref(href, p.src);
    const ext = /^https?:/.test(url) && !url.startsWith(REPO) ? ' rel="noopener" target="_blank"' : '';
    return `<a href="${url}"${title ? ` title="${esc(title)}"` : ''}${ext}>${this.parser.parseInline(tokens)}</a>`;
  };
  r.image = ({ href, text }) => `<figure><img src="${fixHref(href, p.src)}" alt="${esc(text)}" loading="lazy">${text ? `<figcaption>${esc(text)}</figcaption>` : ''}</figure>`;
  r.code = ({ text, lang }) => {
    if (lang === 'mermaid') return `<div class="diagram-box"><pre class="mermaid">${esc(text)}</pre></div>`;
    const l = (lang ?? '').trim();
    return `<div class="code"><div class="code-h"><span>${esc(l || 'text')}</span><button class="copy" type="button">Copy</button></div><pre><code class="lang-${esc(l)}">${highlight(text, l)}</code></pre></div>`;
  };
  r.table = function (token) {
    const head = token.header.map((c) => `<th${c.align ? ` style="text-align:${c.align}"` : ''}>${this.parser.parseInline(c.tokens)}</th>`).join('');
    const rows = token.rows.map((row) => `<tr>${row.map((c) => `<td${c.align ? ` style="text-align:${c.align}"` : ''}>${this.parser.parseInline(c.tokens)}</td>`).join('')}</tr>`).join('');
    return `<div class="table"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
  };
  r.blockquote = function ({ tokens }) {
    return `<blockquote class="callout"><svg class="ci"><use href="#i-info"/></svg><div>${this.parser.parse(tokens)}</div></blockquote>`;
  };
  const html = marked.parse(md, { renderer: r, gfm: true }) as string;
  const words = md.split(/\s+/).length;
  const mins = Math.max(1, Math.round(words / 220));
  const i = pages.indexOf(p);
  const prev = pages[i - 1], next = pages[i + 1];
  const pager = `<nav class="pager" aria-label="Previous and next">
    ${prev ? `<a class="prev" href="${prev.slug}.html"><small>Previous</small><b>${prev.title}</b></a>` : '<span></span>'}
    ${next ? `<a class="next" href="${next.slug}.html"><small>Next</small><b>${next.title}</b></a>` : '<span></span>'}</nav>`;
  const head = `<header class="doc-head">
    <div class="crumbs"><a href="./">Docs</a><svg><use href="#i-chev"/></svg><span>${p.group}</span></div>
    <h1>${esc(p.title)}</h1><p class="doc-lead">${esc(p.blurb)}</p>
    <div class="meta"><span><svg><use href="#i-clock"/></svg>${mins} min read</span><a href="${GH}${p.src}"><svg><use href="#i-edit"/></svg>Edit on GitHub</a></div></header>`;
  const tocHtml = toc.length > 1 ? `<aside class="toc" aria-label="On this page"><h5>On this page</h5>${toc.map((t) => `<a href="#${t.id}" class="d${t.depth}">${esc(t.text)}</a>`).join('')}
    <div class="toc-foot"><a href="${GH}${p.src}"><svg><use href="#i-edit"/></svg>Edit this page</a><a href="${REPO}/issues/new/choose"><svg><use href="#i-chat"/></svg>Give feedback</a><a href="#top"><svg><use href="#i-up"/></svg>Back to top</a></div></aside>` : '<aside class="toc"></aside>';
  const body = `<main class="doc" id="main">${head}<article class="prose">${html}</article>${pager}</main>${tocHtml}`;
  return shell(p.title, body, p.slug, p.blurb);
}

function sidebar(active: string) {
  return `<aside class="side" id="side" aria-label="Documentation">
  <label class="search"><svg><use href="#i-search"/></svg><input id="q" type="search" placeholder="Search docs" autocomplete="off"><kbd>/</kbd></label>
  <a href="./" class="${active === 'index' ? 'on' : ''}"><svg><use href="#i-home"/></svg>Overview</a>
  ${groups.map((g) => `<h5>${g}</h5>${pages.filter((p) => p.group === g).map((p) => `<a href="${p.slug}.html" class="${p.slug === active ? 'on' : ''}" data-k="${esc((p.title + ' ' + p.blurb).toLowerCase())}">${p.title}</a>`).join('')}`).join('')}
  <div class="side-foot"><a href="${REPO}"><svg><use href="#i-gh"/></svg>GitHub</a><a href="../#demo"><svg><use href="#i-play"/></svg>Live demo</a></div>
  </aside>`;
}

const SPRITE = `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
<symbol id="mark" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#0d1015"/><path d="M6 11h10l-1.6 5H7.6z" fill="#e0600f"/><path d="M16 11h10l-1.6 5H17.6z" fill="#f6a56b"/><path d="M8.5 16h15v8.5a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1z" fill="none" stroke="#fff" stroke-width="1.8"/><path d="M14 25.5v-4.5h4v4.5" fill="none" stroke="#fff" stroke-width="1.8"/></symbol>
<symbol id="i-gh" viewBox="0 0 24 24" fill="currentColor"><path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.53-1.33-1.28-1.69-1.28-1.69-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.68 0-1.26.45-2.28 1.18-3.09-.12-.29-.51-1.46.11-3.04 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.62 1.58.23 2.75.11 3.04.74.81 1.18 1.83 1.18 3.09 0 4.41-2.69 5.38-5.26 5.67.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5z"/></symbol>
<symbol id="i-search" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="7.5"/><path d="m20.5 20.5-4-4"/></symbol>
<symbol id="i-home" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m3 10 9-7 9 7v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/></symbol>
<symbol id="i-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></symbol>
<symbol id="i-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></symbol>
<symbol id="i-clock" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9.5"/><path d="M12 7v5l3 2"/></symbol>
<symbol id="i-edit" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></symbol>
<symbol id="i-chat" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></symbol>
<symbol id="i-up" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></symbol>
<symbol id="i-info" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9.5"/><path d="M12 16v-4.5M12 8h.01"/></symbol>
<symbol id="i-play" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l12.5-7.5z"/></symbol>
<symbol id="i-menu" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></symbol>
<symbol id="i-rocket" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/></symbol>
<symbol id="i-layers" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m12 2 10 5-10 5L2 7z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/></symbol>
<symbol id="i-blocks" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/></symbol>
<symbol id="i-ship" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></symbol>
<symbol id="i-users" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></symbol>
</defs></svg>`;

function shell(title: string, body: string, active: string, desc: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Haat docs</title><meta name="description" content="${esc(desc)}"><meta name="theme-color" content="#fbfaf7">
<link rel="icon" href="../assets/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Instrument+Serif:ital@0;1&family=JetBrains+Mono:wght@400;500;600&display=swap">
<link rel="stylesheet" href="../assets/landing.css"><link rel="stylesheet" href="../assets/docs.css"></head><body id="top" class="docs-body">
${SPRITE}
<a class="skip" href="#main">Skip to content</a>
<header class="nav"><div class="wrap wide">
  <button class="side-btn" aria-label="Open documentation menu" aria-controls="side" aria-expanded="false"><svg><use href="#i-menu"/></svg></button>
  <a class="brand" href="../" aria-label="Haat home"><svg class="mark"><use href="#mark"/></svg>Haat <span class="tagdocs">Docs</span></a>
  <nav aria-label="Primary"><a href="../#product">Product</a><a href="../#demo">Live demo</a><a href="../#security">Security</a><a href="./" class="cur">Docs</a></nav>
  <div class="right"><a class="gh" href="${REPO}"><svg><use href="#i-gh"/></svg><span>GitHub</span></a><a class="btn sm primary" href="quickstart.html">Get started</a></div>
</div></header>
<div class="wrap wide docs-grid${active === 'index' ? ' is-index' : ''}">${sidebar(active)}${body}</div>
<footer class="doc-footer"><div class="wrap wide"><span>© 2026 Saurabh Pathak · MIT License</span><span>Rendered from the Markdown in <a href="${REPO}/tree/main/docs">docs/</a>. Independent project, not affiliated with ONDC, Sierra, Meta or the Personal Agent Protocol project.</span></div></footer>
<div class="scrim" hidden></div>
<script src="../assets/docs.js"></script>
<script type="module">
const nodes=[...document.querySelectorAll('pre.mermaid')];
if(nodes.length){const {default:mermaid}=await import('https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.esm.min.mjs');
mermaid.initialize({startOnLoad:false,theme:'base',themeVariables:{fontFamily:'Inter, system-ui, sans-serif',primaryColor:'#fdf0e6',primaryBorderColor:'#e0600f',primaryTextColor:'#0d1015',lineColor:'#9aa0ab',secondaryColor:'#eef0fb',tertiaryColor:'#f4f2ed',noteBkgColor:'#fff8f2',noteBorderColor:'#f3c7a6'}});
mermaid.run({nodes});}
</script></body></html>`;
}

mkdirSync(join(OUT, 'docs'), { recursive: true });
for (const p of pages) writeFileSync(join(OUT, 'docs', `${p.slug}.html`), render(p));

const index = `<main class="doc doc-index" id="main">
<header class="idx-hero"><span class="eyebrow">Documentation</span><h1>Build with <em>Haat.</em></h1>
<p class="doc-lead">Everything you need to run the gateway, understand the approval gate, extend it to new verticals and languages, and take it live on ONDC.</p>
<div class="idx-cta"><a class="btn primary" href="quickstart.html">Read the quickstart <svg class="arrow"><use href="#i-arrow"/></svg></a><a class="btn" href="architecture.html">Architecture overview</a></div>
<div class="idx-cmd"><div class="code"><div class="code-h"><span>bash</span><button class="copy" type="button">Copy</button></div><pre><code>${highlight('git clone https://github.com/techsaurabh-394/haat-gateway.git\ncd haat-gateway && npm install\nnpm run demo          # approve the order in your terminal', 'bash')}</code></pre></div></div>
</header>
${groups.map((g) => `<section class="idx-group"><div class="idx-gh"><span class="gi"><svg><use href="#${groupIcon[g]}"/></svg></span><div><h2>${g}</h2><p>${groupBlurb[g]}</p></div></div>
<div class="idx-cards">${pages.filter((p) => p.group === g).map((p) => `<a href="${p.slug}.html"><b>${p.title}</b><span>${p.blurb}</span><svg><use href="#i-arrow"/></svg></a>`).join('')}</div></section>`).join('')}
<div class="idx-help"><div><b>Can't find what you need?</b><span>Open a discussion or an issue and we'll improve the docs.</span></div><a class="btn" href="${REPO}/issues/new/choose"><svg><use href="#i-chat"/></svg>Ask on GitHub</a></div>
</main>`;
writeFileSync(join(OUT, 'docs', 'index.html'), shell('Documentation', index, 'index', 'Haat gateway documentation: quickstart, architecture, security model, domain packs, language lexicon and going live on ONDC.'));

// copy diagrams used by the site and docs
mkdirSync(join(OUT, 'assets'), { recursive: true });
for (const f of ['architecture', 'order-flow', 'approval-gate', 'hinglish-pipeline', 'hero']) cpSync(join(ROOT, 'assets', `${f}.svg`), join(OUT, 'assets', `${f}.svg`));
if (!existsSync(join(OUT, '.nojekyll'))) writeFileSync(join(OUT, '.nojekyll'), '');
console.log(`built ${pages.length + 1} docs pages`);
