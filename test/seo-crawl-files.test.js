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

    // ── favicon: ONE icon on every page - images/icon/favicon.ico, the owner's file - also answered at the default /favicon.ico ──
    // History: the favicon was a 1536px / 1.8 MB PNG declared as a 16x16 GIF with no /favicon.ico (Google showed a globe); it became a gold-
    // microphone set (48/96/192 PNGs plus a root favicon.ico); the owner has since replaced it with images/icon/favicon.ico and the root file
    // is gone, so app.js answers /favicon.ico from the new file and every <head> links to that one URL. Google prefers a multiple of 48px and
    // the owner's file is 16px, so Google may show it soft - a trade-off the owner chose, not something this test should fail on.
    const pngSize = (buf) => (buf.length > 24 && buf.slice(1, 4).toString() === 'PNG') ? { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) } : null;
    const icoFile = path.join(ROOT, 'images', 'icon', 'favicon.ico');
    const icoDisk = fs.existsSync(icoFile) ? fs.readFileSync(icoFile) : Buffer.alloc(0);
    const icoProblems = (buf) => {            // a structurally valid .ico: header, at least one image, every image inside the file
        if (buf.length < 22) return ['missing or too short'];
        const problems = [];
        if (buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) problems.push('not an icon header');
        const count = buf.readUInt16LE(4);
        if (count < 1) problems.push('holds no image');
        for (let i = 0; i < count && 6 + 16 * i + 16 <= buf.length; i++) {
            const size = buf.readUInt32LE(6 + 16 * i + 8), offset = buf.readUInt32LE(6 + 16 * i + 12);
            if (size === 0 || offset + size > buf.length) problems.push(`image ${i} runs past the end of the file`);
        }
        return problems;
    };
    check('images/icon/favicon.ico is a valid icon and small enough for a favicon', icoProblems(icoDisk).length === 0 && icoDisk.length <= 100 * 1024, icoProblems(icoDisk).join('; ') || `${icoDisk.length} bytes`);

    const pages = ['index.html', 'admin.html', 'confirm-subscription.html', 'unsubscribe.html', 'reset-password.html'];
    const iconLinks = (name) => [...fs.readFileSync(path.join(ROOT, name), 'utf8').matchAll(/<link\s[^>]*rel="(?:shortcut )?icon"[^>]*>/g)].map(m => (/href="([^"]+)"/.exec(m[0]) || [])[1]);
    const homeIcons = iconLinks('index.html');
    check('index.html declares exactly one icon: the stable /favicon.ico URL with a ?v= cache-buster', homeIcons.length === 1 && /^\/favicon\.ico\?v=\d+$/.test(homeIcons[0]), JSON.stringify(homeIcons));
    check('...and every other page declares that same icon (no page keeps an old or different one)', pages.every(p => JSON.stringify(iconLinks(p)) === JSON.stringify(homeIcons)), pages.map(p => `${p}: ${JSON.stringify(iconLinks(p))}`).join(' | '));

    const icoRes = await fetch(`${support.BASE}${homeIcons[0] || '/favicon.ico'}`);          // exactly what the page links to, query string and all
    const ico = Buffer.from(await icoRes.arrayBuffer());
    const icoType = icoRes.headers.get('content-type') || '';
    check('GET /favicon.ico?v=N serves 200 as an icon', icoRes.status === 200 && /^image\/(x-icon|vnd\.microsoft\.icon)/.test(icoType), `status=${icoRes.status} type=${icoType}`);
    check('...and what it serves is exactly images/icon/favicon.ico (the owner\'s file)', icoDisk.length > 0 && Buffer.compare(ico, icoDisk) === 0 && icoProblems(ico).length === 0, `served ${ico.length} bytes, file ${icoDisk.length} bytes`);
    const plainRes = await fetch(`${support.BASE}/favicon.ico`);
    const plain = Buffer.from(await plainRes.arrayBuffer());
    check('the bare /favicon.ico (what crawlers and browsers ask for by default) answers the same bytes', plainRes.status === 200 && icoDisk.length > 0 && Buffer.compare(plain, icoDisk) === 0, `status=${plainRes.status} bytes=${plain.length}`);
    const headRes = await fetch(`${support.BASE}/favicon.ico`, { method: 'HEAD' });
    check('HEAD /favicon.ico works too (crawlers probe with it)', headRes.status === 200 && Number(headRes.headers.get('content-length')) === icoDisk.length, `status=${headRes.status} length=${headRes.headers.get('content-length')}`);
    const iconCache = plainRes.headers.get('cache-control') || '';
    const iconAge = /max-age=(\d+)/.exec(iconCache);
    check('/favicon.ico is cacheable but not "immutable": it is a fixed URL, so a future icon change must be able to reach visitors', /public/.test(iconCache) && !!iconAge && Number(iconAge[1]) > 0 && Number(iconAge[1]) <= 7 * 86400 && !/immutable/.test(iconCache), `cache-control: ${iconCache || '(none)'}`);
    check('/favicon.ico and /images/icon/favicon.ico are allowed by robots.txt', isAllowed(rules, '/favicon.ico') && isAllowed(rules, '/images/icon/favicon.ico'), robots);
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
