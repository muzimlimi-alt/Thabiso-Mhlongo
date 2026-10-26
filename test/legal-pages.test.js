// Standalone /privacy and /terms pages (lib/legal-pages.js, routes/public/legal-pages.js). The text is read from the pop-ups in index.html, so these tests check
// that the page says EXACTLY what the pop-up says (it is compared with index.html itself, not with the module under test), that it is a real, public,
// indexable page (no login, canonical, not blocked by robots.txt, revalidating cache), that nothing pop-up-only leaks into it, and that the homepage
// footer links are real links that still open the pop-ups.
const fs = require('fs');
const http = require('http');
const path = require('path');
const support = require('./support');

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const textOf = (html) => html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
// What the pop-up shows: from the start of .legal-ms to the pop-up's footer.
function popupText(modalId) {
    const from = INDEX.indexOf('id="' + modalId + '"');
    const body = INDEX.indexOf('<div class="legal-ms">', from);
    const end = INDEX.indexOf('<div class="modal-footer">', body);
    return textOf(INDEX.slice(body, end));
}
function pageText(html) {
    const from = html.indexOf('<div class="legal">');
    const end = html.indexOf('</main>', from);
    return textOf(html.slice(from, end));
}
const get = async (p, opts) => {
    const r = await fetch(support.BASE + p, Object.assign({ redirect: 'manual' }, opts || {}));
    return { status: r.status, headers: r.headers, text: r.status === 200 || (opts && opts.method === 'HEAD') ? await r.text() : await r.text().catch(() => '') };
};

// A conditional GET the way a browser sends it. (Node's fetch adds Cache-Control: no-cache to any request with If-None-Match, which makes Express treat it as a forced reload.)
const conditionalGet = (p, etag) => new Promise((resolve, reject) => {
    http.get(support.BASE + p, { headers: { 'If-None-Match': etag } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }).on('error', reject);
});

module.exports = async function ({ check }) {
    const DOCS = [
        { path: '/privacy', modal: 'privacyModal', title: 'Privacy Policy', other: '/terms', sections: 8 },
        { path: '/terms', modal: 'termsModal', title: 'Terms &amp; Conditions', other: '/privacy', sections: 9 }
    ];

    for (const d of DOCS) {
        const r = await get(d.path);   // no cookie: the page is public
        const html = r.text;
        check(`${d.path}: a public page - 200, HTML, UTF-8, no login needed`, r.status === 200 && /^text\/html; charset=utf-8/i.test(r.headers.get('content-type') || ''), r.status + ' ' + r.headers.get('content-type'));
        check(`${d.path}: has its own title, a heading, a description and a canonical address on this site`,
            html.includes(`<title>${d.title} | Thabiso Mhlongo</title>`) && html.includes(`<h1>${d.title}</h1>`) && /<meta name="description" content="[^"]{40,}">/.test(html) && html.includes(`<link rel="canonical" href="`) && new RegExp(`rel="canonical" href="https?://[^"]+${d.path}"`).test(html), html.slice(0, 600));
        check(`${d.path}: says exactly what the homepage pop-up says (compared with index.html itself)`, pageText(html) === popupText(d.modal) && pageText(html).length > 1500, 'page ' + pageText(html).length + ' chars vs pop-up ' + popupText(d.modal).length + '\n' + pageText(html).slice(0, 200) + '\n' + popupText(d.modal).slice(0, 200));
        const sub = (INDEX.slice(INDEX.indexOf('id="' + d.modal + '"')).match(/<small class="tm-modal-subtitle">([^<]*)<\/small>/) || [])[1];
        check(`${d.path}: shows the same "Last Updated" date as the pop-up`, !!sub && html.includes(`<p class="updated">${sub}</p>`), String(sub));
        check(`${d.path}: all ${d.sections} numbered sections are there`, (html.match(/<h5>\d+\. /g) || []).length === d.sections, String((html.match(/<h5>\d+\. /g) || []).length));
        check(`${d.path}: nothing that only works in a pop-up is left (no data-toggle / data-target / modal markup, no icon font, no scripts)`, !/data-toggle|data-target|data-dismiss|class="[^"]*\bmodal\b|\bfa-(solid|regular|brands)|<script/i.test(html), (html.match(/data-toggle|data-target|data-dismiss|class="[^"]*\bmodal\b|\bfa-(solid|regular|brands)|<script/i) || [])[0]);
        check(`${d.path}: links to the other document and back home are real links`, html.includes(`href="${d.other}"`) && html.includes('href="/"') && !/href="#"/.test(html), '');
        check(`${d.path}: indexable - no noindex, and a viewport for phones`, !/noindex/i.test(html) && /<meta name="robots" content="index, follow">/.test(html) && /<meta name="viewport" content="width=device-width, initial-scale=1">/.test(html), '');
        check(`${d.path}: revalidates (no-cache) and carries an ETag`, /no-cache/.test(r.headers.get('cache-control') || '') && !!r.headers.get('etag'), r.headers.get('cache-control') + ' / ' + r.headers.get('etag'));
        const s304 = await conditionalGet(d.path, r.headers.get('etag'));
        check(`${d.path}: a browser that already has it gets a 304, not the whole page again`, s304 === 304, String(s304));
        const head = await get(d.path, { method: 'HEAD' });
        check(`${d.path}: HEAD works (link checkers, crawlers)`, head.status === 200 && head.text === '', String(head.status));
        const slash = await get(d.path + '/');
        check(`${d.path}/ (trailing slash) shows the same page`, slash.status === 200 && slash.text === html, String(slash.status));
        const q = await get(d.path + '?x=%3Cscript%3Ealert(1)%3C/script%3E');
        check(`${d.path}: nothing from the query string is ever echoed into the page`, q.status === 200 && !q.text.includes('alert(1)') && q.text === html, String(q.status));
        check(`${d.path}: the site-wide security headers still apply`, !!r.headers.get('content-security-policy') && /nosniff/i.test(r.headers.get('x-content-type-options') || ''), '');
    }

    // names people guess
    for (const [from, to] of [['/privacy-policy', '/privacy'], ['/privacy.html', '/privacy'], ['/terms-and-conditions', '/terms'], ['/terms-of-use', '/terms'], ['/terms-of-service', '/terms'], ['/terms.html', '/terms']]) {
        const r = await get(from);
        check(`${from} -> permanent redirect to ${to}`, r.status === 301 && (r.headers.get('location') || '').endsWith(to), r.status + ' ' + r.headers.get('location'));
    }

    // search engines may read them; the homepage keeps its pop-ups AND gains real links
    const robots = await get('/robots.txt');
    check('robots.txt does not block /privacy or /terms', robots.status === 200 && !/Disallow:\s*\/(privacy|terms)/i.test(robots.text) && !/Disallow:\s*\/\s*$/m.test(robots.text), robots.text);
    check('the homepage footer links are real links (/privacy, /terms) and still open the pop-ups',
        /<a href="\/privacy" data-toggle="modal" data-target="#privacyModal">Privacy Policy<\/a>/.test(INDEX) && /<a href="\/terms" data-toggle="modal" data-target="#termsModal">Terms of Use<\/a>/.test(INDEX), '');
    check('the pop-ups are still on the homepage (booking checkboxes link to them)', INDEX.includes('id="privacyModal"') && INDEX.includes('id="termsModal"'), '');
    const nf = await get('/privacy-policies-of-nothing');
    check('an unknown address still gets the normal 404 (the new routes do not swallow everything)', nf.status === 404, String(nf.status));
};
