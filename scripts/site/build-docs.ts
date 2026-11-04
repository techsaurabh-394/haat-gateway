/** Builds site/docs/*.html from docs/*.md (+ a few root files). Run: node scripts/site/build-docs.ts */
import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync } from 'node:fs';
import { join, dirname, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, 'site');
const GH = 'https://github.com/techsaurabh-394/haat-gateway/blob/main/';

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

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const slugify = (s: string) => s.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-');

function fixHref(href: string, srcPath: string): string {
  if (/^(https?:|mailto:|#)/.test(href)) return href;
  const [path, hash] = href.split('#');
  const resolved = posix.normalize(posix.join(posix.dirname(srcPath), path));
  const page = bySrc.get(resolved);
  if (page) return `${page.slug}.html${hash ? '#' + hash : ''}`;
  if (resolved.startsWith('assets/')) return `../${resolved}`;
  return GH + resolved + (hash ? '#' + hash : '');
}

function render(p: Page): string {
  const md = readFileSync(join(ROOT, p.src), 'utf8');
  const r = new marked.Renderer();
  // marked >= 13 passes a single token object to renderer functions and exposes
  // `this.parser` for rendering inline children.
  r.heading = function ({ tokens, depth, text }) {
    return `<h${depth} id="${slugify(text)}">${this.parser.parseInline(tokens)}</h${depth}>`;
  };
  r.link = function ({ href, title, tokens }) {
    return `<a href="${fixHref(href, p.src)}"${title ? ` title="${esc(title)}"` : ''}>${this.parser.parseInline(tokens)}</a>`;
  };
  r.image = ({ href, text }) => `<img src="${fixHref(href, p.src)}" alt="${esc(text)}" loading="lazy">`;
  r.code = ({ text, lang }) => lang === 'mermaid' ? `<pre class="mermaid">${esc(text)}</pre>` : `<pre><code class="lang-${lang ?? ''}">${esc(text)}</code></pre>`;
  const html = marked.parse(md, { renderer: r, gfm: true }) as string;
  const i = pages.indexOf(p);
  const prev = pages[i - 1], next = pages[i + 1];
  const nav = pages.length && `
    <div class="pn">${prev ? `<a href="${prev.slug}.html"><small>← Previous</small>${prev.title}</a>` : '<span></span>'}${next ? `<a href="${next.slug}.html"><small>Next →</small>${next.title}</a>` : '<span></span>'}</div>
    <p style="margin-top:30px"><a href="${GH}${p.src}">Edit this page on GitHub</a></p>`;
  return shell(p.title, `<article class="prose">${html}${nav}</article>`, p.slug, p.blurb);
}

function sidebar(active: string) {
  return `<aside class="side"><a href="./" class="${active === 'index' ? 'on' : ''}">Overview</a>${groups.map((g) => `<h5>${g}</h5>${pages.filter((p) => p.group === g).map((p) => `<a href="${p.slug}.html" class="${p.slug === active ? 'on' : ''}">${p.title}</a>`).join('')}`).join('')}</aside>`;
}

function shell(title: string, body: string, active: string, desc: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Haat docs</title><meta name="description" content="${esc(desc)}"><meta name="theme-color" content="#0b1024">
<link rel="icon" href="../assets/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="../assets/site.css"></head><body>
<header class="nav"><div class="wrap"><a class="brand" href="../"><i>◆</i>Haat <span style="font-weight:400;color:var(--muted);font-size:18px">docs</span></a>
<nav><a href="../#demo">Live demo</a><a href="../#features">Features</a><a href="./">Docs</a><a class="btn sm primary" href="https://github.com/techsaurabh-394/haat-gateway">★ GitHub</a></nav></div></header>
<div class="wrap docs">${sidebar(active)}${body}</div>
<script type="module">
import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.esm.min.mjs';
mermaid.initialize({startOnLoad:false,theme:'neutral'});
const nodes=[...document.querySelectorAll('pre.mermaid')];
if(nodes.length)mermaid.run({nodes});
document.querySelectorAll('.prose pre:not(.mermaid)').forEach(p=>{const b=document.createElement('button');b.className='btn sm copy';b.textContent='Copy';b.onclick=async()=>{await navigator.clipboard.writeText(p.innerText);b.textContent='Copied ✓';setTimeout(()=>b.textContent='Copy',1500)};p.appendChild(b)});
</script></body></html>`;
}

mkdirSync(join(OUT, 'docs'), { recursive: true });
for (const p of pages) writeFileSync(join(OUT, 'docs', `${p.slug}.html`), render(p));

const index = `<div class="prose" style="max-width:none"><div class="hero-docs"><span class="eyebrow">Documentation</span><h1>Everything about Haat.</h1>
<p class="lead">Start with the quickstart, then read how the approval gate and the Poppy to Beckn mapping work. Docs are rendered from the Markdown files in the repository, so a PR to <code>docs/</code> updates this site.</p></div>
${groups.map((g) => `<h3>${g}</h3><div class="cards">${pages.filter((p) => p.group === g).map((p) => `<a href="${p.slug}.html"><b>${p.title}</b><span>${p.blurb}</span></a>`).join('')}</div>`).join('')}</div>`;
writeFileSync(join(OUT, 'docs', 'index.html'), shell('Documentation', index, 'index', 'Haat gateway documentation'));

// copy diagrams used by the site and docs
mkdirSync(join(OUT, 'assets'), { recursive: true });
for (const f of ['architecture', 'order-flow', 'approval-gate', 'hinglish-pipeline', 'hero']) cpSync(join(ROOT, 'assets', `${f}.svg`), join(OUT, 'assets', `${f}.svg`));
mkdirSync(join(OUT, '..', 'site', 'assets'), { recursive: true });
if (!existsSync(join(OUT, '.nojekyll'))) writeFileSync(join(OUT, '.nojekyll'), '');
console.log(`built ${pages.length + 1} docs pages`);
