// Child of test/rate-limiters.test.js: sends 12 requests to a tiny express app guarded by the REAL trackRateLimiter and prints the
// statuses it got back. It loads only the limiter module (no database, no app.js), so it is safe to run anywhere; NODE_ENV comes from the parent.
const express = require('express');
const { trackRateLimiter } = require('../middleware/rate-limiters');

const app = express();
app.post('/track', trackRateLimiter, (req, res) => res.json({ success: true }));

const server = app.listen(0, '127.0.0.1', async () => {
    const statuses = [];
    try {
        for (let i = 0; i < 12; i++) {
            const r = await fetch(`http://127.0.0.1:${server.address().port}/track`, { method: 'POST' });
            statuses.push(r.status);
        }
        console.log('STATUSES:' + JSON.stringify(statuses));
    } catch (e) {
        console.log('CHILD ERROR: ' + e.message);
    }
    server.close();
    process.exit(0);          // the limiter module starts a background DNS refresh; do not wait for it
});
