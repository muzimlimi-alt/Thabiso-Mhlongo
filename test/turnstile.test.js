// Cloudflare Turnstile (lib/turnstile.js) - the "are you human?" check before a ticket reservation:
//   * OFF unless both keys are set (the default everywhere, including the test server): reservations work without a token, and the drawer
//     is told bot_check = null;
//   * ON: no token / a token Cloudflare rejects -> 403 BOT_CHECK_FAILED; a good token passes; the secret and the visitor's address are what
//     is sent to Cloudflare; Cloudflare unreachable -> let through (an outage there must not stop ticket sales).
// A fake Cloudflare (a tiny local server) stands in for challenges.cloudflare.com. The module is loaded in this process (it opens no DB).
// Date offset 1999 is used by this file.
const http = require('http');
const express = require('express');
const { api, pub, future } = require('./support');

const listen = (srv) => new Promise((res) => srv.listen(0, '127.0.0.1', () => res(srv.address().port)));

module.exports = async function ({ check }) {
    // ═══ off by default: the real test server ═══
    const when = `${future(1999)}T20:00`;
    const ev = (await api('POST', '/api/admin/events', { event_title: 'ZZ Turnstile Show', event_datetime: when, venue_name: 'Hall', event_status: 'upcoming', sync_to_gcal: false })).body;
    try {
        const tier = (await api('POST', `/api/admin/events/${ev.id}/ticket-types`, { name: 'General', price: '100', is_active: true, capacity: 5 })).body.tier;
        const info = await pub('GET', `/api/public/events/${ev.id}/tickets`);
        const r = await pub('POST', '/api/public/ticket-orders', { event_id: ev.id, items: [{ ticket_type_id: tier.id, quantity: 1 }] });
        check('off by default: the drawer is told bot_check = null and a reservation needs no token', info.status === 200 && info.body.bot_check === null && r.status === 201, JSON.stringify([info.body.bot_check, r.status]));
    } finally {
        await api('PUT', `/api/admin/events/${ev.id}`, { event_title: 'ZZ Turnstile Show', event_datetime: when, event_status: 'cancelled', sync_to_gcal: false }).catch(() => {});
    }

    // ═══ on: against a fake Cloudflare ═══
    const seen = [];
    const fake = http.createServer((req, res) => {
        let raw = ''; req.on('data', c => { raw += c; }); req.on('end', () => {
            const p = new URLSearchParams(raw);
            seen.push({ secret: p.get('secret'), response: p.get('response'), remoteip: p.get('remoteip') });
            const good = p.get('response') === 'GOOD-TOKEN';
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(good ? { success: true } : { success: false, 'error-codes': ['invalid-input-response'] }));
        });
    });
    const fakePort = await listen(fake);
    const saved = { s: process.env.TURNSTILE_SITE_KEY, k: process.env.TURNSTILE_SECRET_KEY, u: process.env.TURNSTILE_VERIFY_URL };
    const app = express();
    app.use(express.json());
    const turnstile = require('../lib/turnstile');
    app.post('/reserve', turnstile.requireTurnstile, (req, res) => res.status(201).json({ success: true }));
    const appSrv = http.createServer(app);
    const appPort = await listen(appSrv);
    const post = async (body) => { const r = await fetch(`http://127.0.0.1:${appPort}/reserve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
    const warn = console.warn; let warned = '';
    try {
        process.env.TURNSTILE_SITE_KEY = 'site-key-1';
        process.env.TURNSTILE_SECRET_KEY = '';
        check('one key alone keeps it OFF (both are needed)', !turnstile.config().enabled && (await post({})).status === 201, JSON.stringify(turnstile.config()));
        process.env.TURNSTILE_SECRET_KEY = 'secret-key-1';
        process.env.TURNSTILE_VERIFY_URL = `http://127.0.0.1:${fakePort}/siteverify`;
        check('both keys: ON, and only the public site key is offered to the page', turnstile.config().enabled && turnstile.config().siteKey === 'site-key-1', JSON.stringify(turnstile.config()));
        const none = await post({});
        check('ON: no token -> 403 BOT_CHECK_FAILED, and Cloudflare is not even asked', none.status === 403 && none.body.code === 'BOT_CHECK_FAILED' && seen.length === 0, JSON.stringify(none));
        const bad = await post({ turnstile_token: 'BAD-TOKEN' });
        check('ON: a token Cloudflare rejects -> 403 with a plain message', bad.status === 403 && /I am human/.test(bad.body.message), JSON.stringify(bad));
        const good = await post({ turnstile_token: 'GOOD-TOKEN' });
        const last = seen[seen.length - 1] || {};
        check('ON: a good token passes; Cloudflare gets the SECRET key, the token and the visitor\'s address',
            good.status === 201 && last.secret === 'secret-key-1' && last.response === 'GOOD-TOKEN' && last.remoteip === '127.0.0.1', JSON.stringify([good.status, last]));
        await new Promise((res) => fake.close(res));
        console.warn = (...a) => { warned += a.join(' '); };
        const down = await post({ turnstile_token: 'ANY-TOKEN' });
        console.warn = warn;
        check('ON but Cloudflare unreachable: the reservation goes through (sales never stop for an outage there), and it is logged', down.status === 201 && /could not be reached/.test(warned), JSON.stringify([down.status, warned]));
    } finally {
        console.warn = warn;
        for (const [k, v] of [['TURNSTILE_SITE_KEY', saved.s], ['TURNSTILE_SECRET_KEY', saved.k], ['TURNSTILE_VERIFY_URL', saved.u]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
        fake.close(); appSrv.close();
    }
};
