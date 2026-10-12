// Guards the files search engines act on, after a real incident: robots.txt used to Disallow all of /api, but the
// homepage renders its sections (About, Events, Gallery, ...) from /api/public/*, so Googlebot saw a near-empty page
// ("Crawled - currently not indexed", and "Googlebot blocked by robots.txt" on every page resource). Also checks the
// sitemap, that the served robots.txt and the physical one agree (the route is registered before express.static, so
// a stale file would be silently shadowed), and that both are sent with a short cache lifetime - Cloudflare caches
// *.txt for hours by default and kept serving Googlebot the old rules after the fix.
const fs = require('fs');
const path = require('path');
const support = require('./support');

const ROOT = path.resolve(__dirname, '..');

// Minimal robots.txt matcher using Google's rules: the longest matching path wins, Allow wins a tie.
function rulesForAllCrawlers(text) {
    const rules = [];
    let inGroup = false, lastWasAgent = false;
    for (const raw of text.split(/\r?\n/)) {
        const m = raw.replace(/#.*$/, '').trim().match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
        if (!m) continue;
        const key = m[1].toLowerCase(), val = m[2].trim();
        if (key === 'user-agent') {
            inGroup = lastWasAgent ? (inGroup || val === '*') : val === '*';
            lastWasAgent = true;
        } else {
            lastWasAgent = false;
            if (inGroup && (key === 'allow' || key === 'disallow') && val) rules.push({ allow: key === 'allow', path: val });
        }
    }
    return rules;
}
function pathRegex(p) {            // supports the * wildcard and a trailing $ anchor
    const anchored = p.endsWith('$');
    const body = (anchored ? p.slice(0, -1) : p).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp('^' + body + (anchored ? '$' : ''));
}
function isAllowed(rules, urlPath) {
    let best = null;
    for (const r of rules) {
        if (!pathRegex(r.path).test(urlPath)) continue;
        if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
    }
    return best ? best.allow : true;
}

module.exports = async function ({ check }) {
    // ── robots.txt ──
    const robotsRes = await fetch(`${support.BASE}/robots.txt`);
    const robots = await robotsRes.text();
    check('GET /robots.txt serves 200 text/plain', robotsRes.status === 200 && /^text\/plain/.test(robotsRes.headers.get('content-type') || ''), `status=${robotsRes.status} type=${robotsRes.headers.get('content-type')}`);

    const rules = rulesForAllCrawlers(robots);
    check('robots.txt keeps the admin area and the private API out of search', !isAllowed(rules, '/admin') && !isAllowed(rules, '/admin.html') && !isAllowed(rules, '/api/admin/bookings') && !isAllowed(rules, '/api/anything-else'), robots);
    check('...but lets crawlers fetch /api/public/* (the homepage renders its sections from there)', isAllowed(rules, '/api/public/events') && isAllowed(rules, '/api/public/site-content') && isAllowed(rules, '/api/public/gallery'), robots);
    check('...and leaves the homepage itself crawlable', isAllowed(rules, '/'), robots);
    check('robots.txt points crawlers at the sitemap', /^Sitemap:\s*https:\/\/www\.thabisomhlongo\.com\/sitemap\.xml\s*$/mi.test(robots), robots);

    // Every API path the homepage's own scripts fetch must be crawlable - this is exactly what broke.
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const scripts = [...html.matchAll(/<script[^>]*\ssrc="([^"?#]+)[^"]*"/g)].map(m => m[1]).filter(s => !/^(https?:)?\/\//.test(s));
    const blocked = [];
    let fetched = 0;
    for (const rel of scripts) {
        const file = path.join(ROOT, rel.replace(/^\//, ''));
        if (!fs.existsSync(file)) continue;
        for (const m of fs.readFileSync(file, 'utf8').matchAll(/fetch\(\s*['"`](\/[A-Za-z0-9_\/.-]+)/g)) {
            fetched++;
            if (!isAllowed(rules, m[1])) blocked.push(`${rel}: ${m[1]}`);
        }
    }
    check('the homepage scripts really do fetch from the API (so the next check is meaningful)', fetched > 10, `found ${fetched} fetch() calls`);
    check('every path the homepage scripts fetch is crawlable by robots.txt', blocked.length === 0, blocked.join('; '));

    const fileRobots = fs.readFileSync(path.join(ROOT, 'robots.txt'), 'utf8').replace(/\r\n/g, '\n');
    check('the physical robots.txt carries exactly the rules the route serves (they must not drift apart)', fileRobots === robots.replace(/\r\n/g, '\n'), `file=${JSON.stringify(fileRobots)} served=${JSON.stringify(robots)}`);

    // ── sitemap.xml ──
    const sitemapRes = await fetch(`${support.BASE}/sitemap.xml`);
    const sitemap = await sitemapRes.text();
    check('GET /sitemap.xml serves 200 application/xml', sitemapRes.status === 200 && /^application\/xml/.test(sitemapRes.headers.get('content-type') || ''), `status=${sitemapRes.status} type=${sitemapRes.headers.get('content-type')}`);
    check('...as a urlset listing the homepage', /<urlset[^>]*sitemaps\.org\/schemas\/sitemap\/0\.9/.test(sitemap) && /<loc>https:\/\/www\.thabisomhlongo\.com\/<\/loc>/.test(sitemap), sitemap);

    // ── site name (the line above the title in Google results; falls back to the bare domain without WebSite markup) ──
    const ldBlocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(m => { try { return JSON.parse(m[1]); } catch (e) { return null; } });
    check('every static JSON-LD block in index.html is valid JSON', ldBlocks.length >= 2 && ldBlocks.every(Boolean), `${ldBlocks.length} blocks, ${ldBlocks.filter(b => !b).length} invalid`);
    const site = ldBlocks.find(b => b && b['@type'] === 'WebSite');
    check('index.html has WebSite markup with the brand as its name and the homepage as its url', !!site && site.name === 'Thabiso Mhlongo' && site.url === 'https://www.thabisomhlongo.com/', JSON.stringify(site));
    check('...and og:site_name agrees with it', /<meta property="og:site_name" content="Thabiso Mhlongo">/.test(html), '');

    // ── favicon: Google's favicon crawler wants a square image, a multiple of 48px, crawlable, at a stable URL ──
    // (The old tag declared a 1536px / 1.8 MB PNG as a 16x16 GIF and there was no /favicon.ico.)
    const pngSize = (buf) => (buf.length > 24 && buf.slice(1, 4).toString() === 'PNG') ? { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) } : null;
    const iconTags = [...html.matchAll(/<link\s[^>]*rel="icon"[^>]*>/g)].map(m => m[0]);
    const pngIcons = iconTags.filter(t => /type="image\/png"/.test(t)).map(t => ({ href: (/href="([^"]+)"/.exec(t) || [])[1], sizes: (/sizes="(\d+)x(\d+)"/.exec(t) || []) }));
    check('index.html declares PNG favicons with their real sizes', pngIcons.length >= 2 && pngIcons.every(i => i.href && i.sizes[1]), iconTags.join(' | '));
    const problems = [];
    for (const i of pngIcons) {
        const file = path.join(ROOT, i.href.replace(/^\//, ''));
        const buf = fs.existsSync(file) ? fs.readFileSync(file) : null;
        const dim = buf && pngSize(buf);
        if (!dim) { problems.push(`${i.href}: missing or not a PNG`); continue; }
        if (dim.w !== dim.h || dim.w % 48 !== 0) problems.push(`${i.href}: ${dim.w}x${dim.h} is not a square multiple of 48`);
        if (String(dim.w) !== i.sizes[1] || String(dim.h) !== i.sizes[2]) problems.push(`${i.href}: declared ${i.sizes[1]}x${i.sizes[2]} but is ${dim.w}x${dim.h}`);
        if (buf.length > 100 * 1024) problems.push(`${i.href}: ${buf.length} bytes is far too big for a favicon`);
        if (!isAllowed(rules, i.href)) problems.push(`${i.href}: blocked by robots.txt`);
    }
    check('every declared favicon exists, is a square multiple of 48, matches its sizes="" attribute, is small and crawlable', problems.length === 0, problems.join('; '));
    check('no icon link still mislabels an image/gif or points at the 1.8 MB logo', !iconTags.some(t => /image\/gif|logo5\.png/.test(t)), iconTags.join(' | '));
    const icoRes = await fetch(`${support.BASE}/favicon.ico`);
    const ico = Buffer.from(await icoRes.arrayBuffer());
    check('GET /favicon.ico serves 200 with a valid multi-size icon (16, 32 and 48 px)', icoRes.status === 200 && ico.readUInt16LE(2) === 1 && ico.readUInt16LE(4) === 3 && [ico[6], ico[22], ico[38]].join() === '16,32,48', `status=${icoRes.status} type=${icoRes.headers.get('content-type')} head=${ico.slice(0, 6).toString('hex')}`);
    check('/favicon.ico and the icon folder are allowed by robots.txt', isAllowed(rules, '/favicon.ico') && isAllowed(rules, '/images/icon/mic-favicon-48.png'), robots);
    const appleHref = (/rel="apple-touch-icon"[^>]*href="([^"]+)"/.exec(html) || [])[1];
    const appleTouch = appleHref && path.join(ROOT, appleHref.replace(/^\//, ''));
    check('the apple-touch-icon is declared, exists and is 180x180', !!appleTouch && fs.existsSync(appleTouch) && (() => { const d = pngSize(fs.readFileSync(appleTouch)); return d && d.w === 180 && d.h === 180; })(), String(appleHref));

    // ── caching ──
    for (const [name, res] of [['robots.txt', robotsRes], ['sitemap.xml', sitemapRes]]) {
        const cc = res.headers.get('cache-control') || '';
        const maxAge = /max-age=(\d+)/.exec(cc);
        check(`${name} is sent with a short max-age (10 minutes or less) so Cloudflare re-checks it quickly`, /public/.test(cc) && !!maxAge && Number(maxAge[1]) <= 600, `cache-control: ${cc || '(none)'}`);
    }
};
