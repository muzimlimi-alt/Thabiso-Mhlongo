// Which loading screen the site shows (js/tm-preloader.js has both designs; the admin picks one in Site Appearance > Preloader).
// Covers the whole path the choice travels:
//   - the public payload always carries a resolved `preloader`, defaulting to the design the site has always had;
//   - the admin can save either design and either field, and only those - a made-up value is ignored, never stored;
//   - BOTH pages that show a loader - the homepage and the admin page - are SERVED with the choice already written into them
//     (#tmPreloaderBoot), so a change the admin saves reaches every visitor on their very next page view, with nothing fetched and
//     no older copy in their browser able to win; and neither page is cached in a way that could hold the old one back;
//   - the picture the portrait needs is actually on disk and served.
// Restores whatever was set before, so running this leaves the site as it found it.
const fs = require('fs');
const path = require('path');

module.exports = async function ({ check, api, pub, loginAs, BASE }) {
    await loginAs('administrator');

    // what it is now, so the end of this file can put it back
    const before = (await pub('GET', '/api/public/site-content')).body.preloader || {};

    const get = async () => (await pub('GET', '/api/public/site-content')).body;
    const html = async () => (await fetch(BASE + '/')).text();
    const adminHtml = async () => (await fetch(BASE + '/admin.html')).text();
    // the value the head script is handed, i.e. what the browser will act on before first paint
    const boot = (page) => {
        const m = /<script id="tmPreloaderBoot">[\s\S]*?var v = ([^;]+);/.exec(page);
        return m ? m[1].trim() : null;
    };

    // ── the payload always resolves to something the loader knows ────────────────────────────────────────────────────────
    try {
        const p = (await get()).preloader;
        check('preloader: the public payload carries a resolved style + field',
            !!p && ['wordmark', 'portrait'].includes(p.style) && ['onyx', 'bone'].includes(p.field), JSON.stringify(p));
    } catch (e) { check('preloader: the public payload carries a resolved style + field', false, e.message); }

    // ── saving the portrait ──────────────────────────────────────────────────────────────────────────────────────────────
    try {
        const r = await api('PUT', '/api/admin/site-content', { preloader_style: 'portrait', preloader_field: 'bone' });
        const p = (await get()).preloader;
        check('preloader: the admin can switch to the portrait design',
            r.status === 200 && p.style === 'portrait' && p.field === 'bone', JSON.stringify({ r: r.status, p }));
    } catch (e) { check('preloader: the admin can switch to the portrait design', false, e.message); }

    // ── the homepage is served with it, before any script runs ───────────────────────────────────────────────────────────
    try {
        const page = await html();
        const v = boot(page);
        check('preloader: the homepage is served with the choice already in it (no flash of the other design)',
            v === '{"style":"portrait","field":"bone"}', String(v));
    } catch (e) { check('preloader: the homepage is served with the choice already in it (no flash of the other design)', false, e.message); }

    // ── a value the loader would not recognise is refused, and changes nothing ───────────────────────────────────────────
    try {
        const r = await api('PUT', '/api/admin/site-content', { preloader_style: 'rainbow', preloader_field: 'chartreuse' });
        const p = (await get()).preloader;
        check('preloader: an unknown design or field is ignored, and the stored one is untouched',
            p.style === 'portrait' && p.field === 'bone', JSON.stringify({ r: r.status, p }));
    } catch (e) { check('preloader: an unknown design or field is ignored, and the stored one is untouched', false, e.message); }

    // ── back to the wordmark ─────────────────────────────────────────────────────────────────────────────────────────────
    try {
        await api('PUT', '/api/admin/site-content', { preloader_style: 'wordmark', preloader_field: 'onyx' });
        const p = (await get()).preloader;
        const v = boot(await html());
        check('preloader: the admin can switch back to the wordmark design',
            p.style === 'wordmark' && v === '{"style":"wordmark","field":"onyx"}', JSON.stringify({ p, v }));
    } catch (e) { check('preloader: the admin can switch back to the wordmark design', false, e.message); }

    // ── the portrait's picture exists and is served ──────────────────────────────────────────────────────────────────────
    try {
        const file = path.join(__dirname, '..', 'images', 'preloader', 'portrait-mark.webp');
        const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
        const res = await fetch(BASE + '/images/preloader/portrait-mark.webp');
        // it is downloaded before anything else on a page, so a bloated file here would delay the loader it belongs to
        check('preloader: the portrait picture is on disk, served, and small enough to sit in front of a page',
            size > 1000 && size < 120 * 1024 && res.status === 200, JSON.stringify({ size, status: res.status }));
    } catch (e) { check('preloader: the portrait picture is on disk, served, and small enough to sit in front of a page', false, e.message); }

    // ── index.html keeps the token the server fills ──────────────────────────────────────────────────────────────────────
    try {
        const tpl = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
        check('preloader: index.html still carries the #tmPreloaderBoot token the server fills',
            tpl.includes('/*TM_PRELOADER*/null') && tpl.includes('id="tmPreloaderBoot"'), 'token or script id missing from index.html');
    } catch (e) { check('preloader: index.html still carries the #tmPreloaderBoot token the server fills', false, e.message); }

    // ── the admin page is served with it too (it used to read only the browser's cache, so it lagged a load behind) ───────
    try {
        await api('PUT', '/api/admin/site-content', { preloader_style: 'portrait', preloader_field: 'onyx' });
        const v = boot(await adminHtml());
        check('preloader: the admin page is served with the choice already in it (no one-load lag for other admins)',
            v === '{"style":"portrait","field":"onyx"}', String(v));
    } catch (e) { check('preloader: the admin page is served with the choice already in it (no one-load lag for other admins)', false, e.message); }

    // ── a change reaches BOTH pages on the next view, with nothing cached in the way ──────────────────────────────────────
    try {
        await api('PUT', '/api/admin/site-content', { preloader_style: 'wordmark', preloader_field: 'bone' });
        const home = await fetch(BASE + '/');
        const admin = await fetch(BASE + '/admin.html');
        const hv = boot(await home.text()), av = boot(await admin.text());
        const want = '{"style":"wordmark","field":"bone"}';
        // "no-cache" still revalidates every view, so a changed page is never answered from a stale copy
        const cacheOk = /no-cache/.test(home.headers.get('cache-control') || '') && /no-cache|no-store/.test(admin.headers.get('cache-control') || '');
        check('preloader: switching again is live on the homepage AND the admin page at the next view, and neither is cached stale',
            hv === want && av === want && cacheOk,
            JSON.stringify({ hv, av, home: home.headers.get('cache-control'), admin: admin.headers.get('cache-control') }));
    } catch (e) { check('preloader: switching again is live on the homepage AND the admin page at the next view, and neither is cached stale', false, e.message); }

    // ── admin.html keeps the token, like index.html ───────────────────────────────────────────────────────────────────────
    try {
        const tpl = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
        check('preloader: admin.html still carries the #tmPreloaderBoot token the server fills',
            tpl.includes('/*TM_PRELOADER*/null') && tpl.includes('id="tmPreloaderBoot"'), 'token or script id missing from admin.html');
    } catch (e) { check('preloader: admin.html still carries the #tmPreloaderBoot token the server fills', false, e.message); }

    // put back what was there
    if (before.style) await api('PUT', '/api/admin/site-content', { preloader_style: before.style, preloader_field: before.field || 'onyx' });
};
