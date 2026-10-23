// Standalone /privacy and /terms pages. The wording is NOT copied: it is read from the Privacy Policy and Terms & Conditions pop-ups in index.html, so the
// homepage pop-up and the page can never say different things - edit the text there and both change (cached by file modification time). Why standalone pages
// exist at all: a pop-up has no address, and services that ask for "your privacy policy link" (Google Cloud's consent screen, app stores, payment providers)
// need a real URL that shows the policy without a click.
// What is changed on the way: the Font Awesome icons are dropped (the page loads no icon font), and the pop-up cross-links (a "#" link that opens the other
// pop-up) become real links to /privacy and /terms. Nothing else is touched.
'use strict';
const fs = require('fs');
const path = require('path');

const INDEX_FILE = path.join(__dirname, '..', 'index.html');
const SITE = 'Thabiso Mhlongo';
const DOCS = {
    privacy: { modalId: 'privacyModal', path: '/privacy', title: 'Privacy Policy', blurb: 'How Thabiso Mhlongo and Thabiso Mhlongo Management collect, use and protect personal information, in line with POPIA.' },
    terms: { modalId: 'termsModal', path: '/terms', title: 'Terms & Conditions', blurb: 'The terms that apply to using the Thabiso Mhlongo website and to booking Thabiso Mhlongo for events.' }
};

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Returns the inner HTML of the <div ...> that starts at `openIdx` (balanced, so nested divs are handled), or null.
function innerOfDiv(html, openIdx) {
    const openEnd = html.indexOf('>', openIdx);
    if (openEnd < 0) return null;
    const re = /<(\/?)div\b[^>]*>/gi;
    re.lastIndex = openEnd + 1;
    let depth = 1, m;
    while ((m = re.exec(html))) {
        depth += m[1] ? -1 : 1;
        if (depth === 0) return html.slice(openEnd + 1, m.index);
    }
    return null;
}

// Pulls one document out of index.html. Throws if the pop-up cannot be found (the tests guard the structure).
function extract(html, doc) {
    const start = html.indexOf('id="' + doc.modalId + '"');
    if (start < 0) throw new Error('legal-pages: #' + doc.modalId + ' not found in index.html');
    const next = html.indexOf('class="modal fade', start + 10);
    const scope = html.slice(start, next < 0 ? html.length : next);
    const sub = /<small class="tm-modal-subtitle">([\s\S]*?)<\/small>/.exec(scope);
    const bodyAt = scope.indexOf('<div class="legal-ms">');
    if (bodyAt < 0) throw new Error('legal-pages: .legal-ms body not found in #' + doc.modalId);
    let body = innerOfDiv(scope, bodyAt);
    if (!body || body.length < 500) throw new Error('legal-pages: #' + doc.modalId + ' body looks empty');
    body = body
        .replace(/<i\b[^>]*class="[^"]*\bfa-[^"]*"[^>]*><\/i>\s*/gi, '')                                  // icon font is not loaded here
        .replace(/<a\b[^>]*data-target="#(privacy|terms)Modal"[^>]*>/gi, (m, which) => '<a href="/' + which + '">'); // pop-up links -> real pages
    return { updated: sub ? sub[1].replace(/<[^>]*>/g, '').trim() : '', body: body.trim() };
}

function baseUrl() { return String(process.env.BASE_URL || 'https://www.thabisomhlongo.com').trim().replace(/\/+$/, ''); }

function render(key, content) {
    const doc = DOCS[key], other = DOCS[key === 'privacy' ? 'terms' : 'privacy'];
    const url = baseUrl() + doc.path;
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(doc.title)} | ${SITE}</title>
<meta name="description" content="${esc(doc.blurb)}">
<meta name="robots" content="index, follow">
<link rel="canonical" href="${esc(url)}">
<link rel="icon" href="/favicon.ico">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(doc.title)} | ${SITE}">
<meta property="og:description" content="${esc(doc.blurb)}">
<meta property="og:url" content="${esc(url)}">
<style>
:root { --bg: #0a0a0a; --surface: #1a1a1a; --line: #2e2e2e; --gold: #d4af37; --gold-hover: #e6c35c; --text: #ffffff; --text2: #b0b0b0; --muted: #8c8c8c; }
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--text2); font: 16px/1.7 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
a { color: var(--gold); text-decoration: none; }
a:hover, a:focus-visible { color: var(--gold-hover); text-decoration: underline; }
a:focus-visible { outline: 2px solid var(--gold); outline-offset: 2px; }
.skip { position: absolute; left: -999px; top: 0; background: var(--gold); color: #0a0a0a; padding: 8px 14px; z-index: 10; }
.skip:focus { left: 8px; top: 8px; text-decoration: none; }
header.site { border-bottom: 1px solid var(--line); background: #111; }
.wrap { max-width: 820px; margin: 0 auto; padding: 0 20px; }
header.site .wrap { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 20px; min-height: 64px; }
.brand { font: 600 20px/1 Georgia, "Times New Roman", serif; letter-spacing: .12em; text-transform: uppercase; color: var(--text); }
.brand:hover { color: var(--gold); text-decoration: none; }
nav a { margin-left: 18px; font-size: 14px; }
nav a[aria-current="page"] { color: var(--text); border-bottom: 2px solid var(--gold); padding-bottom: 2px; }
main { padding: 40px 0 56px; }
h1 { margin: 0 0 4px; color: var(--text); font: 400 clamp(30px, 6vw, 42px)/1.15 Georgia, "Times New Roman", serif; }
.updated { margin: 0 0 28px; color: var(--muted); font-size: 14px; }
.legal h5 { margin: 30px 0 8px; color: var(--gold); font: 700 13px/1.4 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; letter-spacing: .1em; text-transform: uppercase; }
.legal p, .legal li { color: var(--text2); }
.legal ul { padding-left: 22px; }
.legal li { margin: 4px 0; }
.legal strong { color: var(--text); }
.legal hr { border: 0; border-top: 1px solid var(--line); margin: 26px 0 0; }
footer.site { border-top: 1px solid var(--line); background: #111; padding: 22px 0 30px; font-size: 14px; color: var(--muted); }
footer.site .wrap { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px 24px; }
@media (max-width: 520px) { nav a { margin: 0 14px 0 0; } main { padding-top: 28px; } }
@media print { body { background: #fff; color: #000; } header.site, footer.site, .skip { display: none; } h1, .legal strong, .legal p, .legal li { color: #000; } .legal h5 { color: #000; } a { color: #000; } }
</style>
</head>
<body>
<a class="skip" href="#content">Skip to the text</a>
<header class="site">
  <div class="wrap">
    <a class="brand" href="/">${SITE}</a>
    <nav aria-label="Legal">
      <a href="/privacy"${key === 'privacy' ? ' aria-current="page"' : ''}>Privacy Policy</a><a href="/terms"${key === 'terms' ? ' aria-current="page"' : ''}>Terms &amp; Conditions</a><a href="/">Back to website</a>
    </nav>
  </div>
</header>
<main id="content">
  <div class="wrap">
    <h1>${esc(doc.title)}</h1>
    ${content.updated ? `<p class="updated">${content.updated}</p>` : ''}
    <div class="legal">
${content.body}
    </div>
  </div>
</main>
<footer class="site">
  <div class="wrap">
    <span>${SITE} &mdash; <a href="mailto:bookings@thabisomhlongo.com">bookings@thabisomhlongo.com</a></span>
    <span><a href="${other.path}">${esc(other.title)}</a> &middot; <a href="/">Home</a></span>
  </div>
</footer>
</body>
</html>
`;
}

// key -> { mtimeMs, html }. The homepage file is re-read only when it changes.
let cache = { mtimeMs: -1, pages: null };
function pages() {
    const st = fs.statSync(INDEX_FILE);
    if (cache.pages && cache.mtimeMs === st.mtimeMs) return cache.pages;
    const html = fs.readFileSync(INDEX_FILE, 'utf8');
    const out = {};
    for (const key of Object.keys(DOCS)) out[key] = render(key, extract(html, DOCS[key]));
    cache = { mtimeMs: st.mtimeMs, pages: out };
    return out;
}

module.exports = { DOCS, pages, extract, render, innerOfDiv };
