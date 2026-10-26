// Bandwidth: the public homepage revalidates (ETag -> 304) instead of being re-downloaded on every view,
// while admin HTML stays no-store.
const http = require('http');

// Raw http, not fetch: fetch adds 'Cache-Control: no-cache' to any request carrying If-None-Match, which
// (correctly) makes Express answer 200. A browser's normal revalidation does not send that header.
const conditionalGet = (url, etag) => new Promise((resolve, reject) => {
    http.get(url, { headers: { 'If-None-Match': etag } }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, length: Buffer.concat(chunks).length }));
    }).on('error', reject);
});

module.exports = async function ({ check, BASE }) {
    const first = await fetch(`${BASE}/`);
    const etag = first.headers.get('etag');
    await first.arrayBuffer();
    check('homepage is served with Cache-Control: no-cache (always revalidated, never silently stale)', first.headers.get('cache-control') === 'no-cache', first.headers.get('cache-control'));
    check('homepage carries an ETag', !!etag, 'no etag');

    const again = await conditionalGet(`${BASE}/`, etag);
    check('an unchanged homepage answers a conditional request with an empty 304', again.status === 304 && again.length === 0, `status ${again.status}, ${again.length} bytes`);

    const admin = await fetch(`${BASE}/admin.html`);
    await admin.arrayBuffer();
    check('admin.html is still no-store', /no-store/.test(admin.headers.get('cache-control') || ''), admin.headers.get('cache-control'));
};
