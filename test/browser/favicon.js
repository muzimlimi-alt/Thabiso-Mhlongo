// Favicon - browser test. Boots the app on an isolated DB copy (test/support.js). Not part of `npm test`: `npm run test:browser`.
//
//   public: js/applyBranding.js swaps the page's first icon link for the admin's Branding favicon - EXCEPT an oversized one
//           (the live site's was a 1536px, 1.8 MB PNG), which would undo the small static icons for every visitor
//   admin:  picking a big image in Admin > Branding > Favicon uploads a 192x192 PNG instead, not the original
const fs = require('fs');
const os = require('os');
const path = require('path');
const support = require('../support');
const puppeteer = require('puppeteer');
const { BASE, sleep } = support;
let fails = 0;
const ok = (c, n, detail) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '\n        -> ' + detail)); };
const noise = /Failed to load resource|Loading the font|Loading the image 'https:\/\/placehold\.co\//;
const pngSize = (buf) => ({ w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) });

(async () => {
    await support.start();
    const login = await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'test.runner@example.invalid', password: 'TestRunnerPass1!' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const api = async (method, url, body) => { const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body ? JSON.stringify(body) : undefined }); let j = null; try { j = await r.json(); } catch (e) {} return { status: r.status, body: j }; };
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-quic'] });

    // ══════════ public: the oversized-branding safeguard ══════════
    const firstIcon = async (setting) => {
        const put = await api('PUT', '/api/admin/branding', { settings: { site_logo: '', favicon: setting, theme_font: '' } });
        if (put.status !== 200) throw new Error('branding PUT failed: ' + put.status + ' ' + JSON.stringify(put.body));
        const ctx = await browser.createBrowserContext();
        const p = await ctx.newPage();
        const errs = [];
        p.on('pageerror', e => errs.push(e.message.slice(0, 160)));
        p.on('console', m => { if (m.type() === 'error' && !noise.test(m.text())) errs.push(m.text().slice(0, 160)); });
        const brandingDone = p.waitForResponse(r => r.url().includes('/api/public/branding'), { timeout: 30000 });
        await p.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await brandingDone;
        await sleep(1500);                                   // applyBranding's HEAD request + href swap
        const links = await p.evaluate(() => Array.from(document.querySelectorAll('link[rel~="icon"]')).map(l => l.getAttribute('href')));
        const touch = await p.evaluate(() => { const l = document.querySelector('link[rel="apple-touch-icon"]'); return l && l.getAttribute('href'); });
        await ctx.close();
        return { links, touch, errs };
    };
    const big = await firstIcon('images/icon/logo5.png');                  // 1536px, ~1.8 MB
    ok(big.links[0] === '/images/icon/mic-favicon-48.png', 'public: an oversized branding favicon (1.8 MB) is ignored - the small static icon stays first', JSON.stringify(big.links));
    ok(big.errs.length === 0, 'public: no page errors with an oversized branding favicon', big.errs.join(' | '));
    const small = await firstIcon('images/icon/mic-favicon-96.png');           // 12 KB
    // js/applyBranding.js (2026-10-16 favicon fix) replaces ALL the page's icon links with the branded one - swapping only
    // the first left the browser free to keep picking a built-in mic icon - and makes its path root-relative.
    ok(small.links.length === 1 && small.links[0] === '/images/icon/mic-favicon-96.png', 'public: a small branding favicon is applied as the page\'s only icon (the admin\'s Branding setting keeps working)', JSON.stringify(small.links));
    ok(small.touch === '/images/icon/mic-apple-touch-icon.png', 'public: the iOS home-screen icon (apple-touch-icon, a separate rel) is left untouched', String(small.touch));
    await api('PUT', '/api/admin/branding', { settings: { site_logo: '', favicon: '', theme_font: '' } });

    // ══════════ admin: the favicon upload shrinks big images ══════════
    {
        const ctx = await browser.createBrowserContext();
        const p = await ctx.newPage();
        await p.setViewport({ width: 1500, height: 1000 });
        const errs = [];
        p.on('pageerror', e => errs.push(e.message.slice(0, 160)));
        const [name, ...rest] = cookie.split('=');
        await p.setCookie({ name, value: rest.join('='), url: BASE });
        await p.setRequestInterception(true);
        p.on('request', r => /\/api\/admin\/maps-config/.test(r.url()) ? r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, key: '' }) }) : r.continue());
        await p.goto(BASE + '/admin.html', { waitUntil: 'networkidle0', timeout: 90000 });
        await p.waitForFunction(() => typeof window.uploadBrandingAsset === 'function', { timeout: 30000 });
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'favicon-'));
        const bigPng = path.join(tmp, 'logo-big.png');
        fs.writeFileSync(bigPng, support.makeTestPng(1536, 1536));
        const smallPng = path.join(tmp, 'logo-small.png');
        fs.writeFileSync(smallPng, support.makeTestPng(64, 64));

        const pick = async (file) => {
            await p.evaluate(() => { document.getElementById('brandFaviconUrl').value = ''; });
            const input = await p.$('#brandFaviconFile');
            await input.uploadFile(file);                    // fires onchange -> uploadBrandingAsset
            await p.waitForFunction(() => document.getElementById('brandFaviconUrl').value !== '', { timeout: 20000 });
            const url = await p.$eval('#brandFaviconUrl', e => e.value);
            const buf = Buffer.from(await (await fetch(BASE + '/' + url.replace(/^\//, ''))).arrayBuffer());
            return { url, buf, size: pngSize(buf) };
        };
        const a = await pick(bigPng);
        // Saving used to throw ("Cannot read properties of undefined (reading 'trim')") because the accent-colour inputs no longer exist.
        await p.evaluate(() => window.saveBranding('identity'));
        await sleep(2000);
        const saved = await (await fetch(BASE + '/api/public/branding')).json();
        ok(saved.success && saved.branding.favicon === a.url, 'admin: pressing Save Identity after the upload succeeds and stores the shrunk favicon', JSON.stringify({ saved: saved.branding && saved.branding.favicon, uploaded: a.url }));
        ok(errs.length === 0, 'admin: Save Identity raised no page error (it used to crash on a removed colour field)', errs.join(' | '));
        ok(a.size.w === 192 && a.size.h === 192 && a.buf.length < 100 * 1024, 'admin: a 1536x1536 image picked as the favicon is uploaded as a 192x192 PNG, not the original', JSON.stringify({ url: a.url, size: a.size, bytes: a.buf.length }));
        const b = await pick(smallPng);
        ok(b.size.w === 64 && b.size.h === 64, 'admin: an already-small favicon is uploaded untouched', JSON.stringify({ url: b.url, size: b.size }));
        ok(errs.length === 0, 'admin: no page errors', errs.join(' | '));
        fs.rmSync(tmp, { recursive: true, force: true });
        await ctx.close();
    }

    await browser.close();
    await support.stop();
    console.log(fails ? `\n${fails} FAILED` : '\nAll passed');
    process.exit(fails ? 1 : 0);
})().catch(async e => { console.error('ERR', e.stack || e.message); try { await support.stop(); } catch (_) {} process.exit(2); });
