// Child of test/ticketing-limits.test.js: the REAL ticketing limiters (middleware/rate-limiters.js) in front of a tiny express app, under the
// NODE_ENV the parent gives. Loads only the limiter module (no database, no app.js). Prints the statuses it got back.
const express = require('express');
const { ticketReserveRateLimiter, ticketLookupRateLimiter, payfastItnRateLimiter } = require('../middleware/rate-limiters');

const app = express();
app.post('/reserve', ticketReserveRateLimiter, (req, res) => res.json({ success: true }));
app.get('/lookup', ticketLookupRateLimiter, (req, res) => res.json({ success: true }));
app.post('/itn', payfastItnRateLimiter, (req, res) => res.sendStatus(200));

const server = app.listen(0, '127.0.0.1', async () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        const reserve = [];
        for (let i = 0; i < 42; i++) reserve.push((await fetch(`${base}/reserve`, { method: 'POST' })).status);
        console.log('RESERVE:' + JSON.stringify(reserve));
        const lookup = [];
        for (let i = 0; i < 122; i++) lookup.push((await fetch(`${base}/lookup`)).status);
        console.log('LOOKUP:' + JSON.stringify(lookup));
        const itn = [];
        for (let i = 0; i < 22; i++) { const r = await fetch(`${base}/itn`, { method: 'POST' }); itn.push(r.status === 503 ? '503:' + r.headers.get('retry-after') : r.status); }
        console.log('ITN:' + JSON.stringify(itn));
    } catch (e) {
        console.log('CHILD ERROR: ' + e.message);
    }
    server.close();
    process.exit(0);          // the limiter module starts a background DNS refresh; do not wait for it
});
