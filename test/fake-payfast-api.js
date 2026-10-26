// A stand-in for PayFast's merchant API (GET /transactions/history) for tests of the safety net (lib/payfast-reconcile.js). The test server is started with
// PAYFAST_API_URL=http://127.0.0.1:3198 (test/support.js), so nothing a test does can reach the real PayFast.
//
// It is as strict as PayFast: it recomputes the request signature (lib/payfast-api.js apiSignature over every header and query value except `testing`,
// plus the passphrase) and answers 401 "Merchant authorization failed." when it does not match - so a test that passes proves we sign the way PayFast checks.
// It serves the CSV in PayFast's real shape (checked against the real sandbox), pages with offset / limit, answers 204 when there is nothing, and can be told
// to fail: mode 'auth' (401), 'rate' (429 + Retry-After), 'error' (500), 'garbage' (200 with the wrong columns), 'down' (connection dropped).
const http = require('http');
const { apiSignature } = require('../lib/payfast-api');

const COLUMNS = ['Date', 'Type', 'Sign', 'Party', 'Name', 'Description', 'Currency', '"Funding Type"', 'Gross', 'Fee', 'Net', 'Balance', '"M Payment ID"', '"PF Payment ID"',
    '"custom str1"', '"custom int1"', '"custom str2"', '"custom int2"', '"custom str3"', '"custom str4"', '"custom str5"', '"custom int3"', '"custom int4"', '"custom int5"'];

const rands = (cents) => { const v = (Math.abs(cents) / 100).toFixed(2); return v.replace(/\B(?=(\d{3})+(?!\d))/g, ','); };

// A row as PayFast writes it. date: 'YYYY-MM-DD HH:mm:ss' in South African time.
function row({ date, grossCents, mPaymentId, pfPaymentId, name = 'Booking test', fundingType = 'WALLET', type = 'FUNDS_RECEIVED', sign = 'CREDIT', currency = 'ZAR' }) {
    const fee = -Math.round(grossCents * 0.023);
    const cells = [`"${date}"`, type, sign, '"Test User 01"', `"${name.replace(/"/g, '""')}"`, '', currency, fundingType, `"${rands(grossCents)}"`, fee < 0 ? (fee / 100).toFixed(2) : '0.00', `"${rands(grossCents + fee)}"`, '', mPaymentId, String(pfPaymentId)];
    while (cells.length < COLUMNS.length) cells.push('');
    return { date, mPaymentId, pfPaymentId: String(pfPaymentId), line: cells.join(',') };
}

// SAST 'now' (+ offsetSeconds) in the format PayFast uses
const sastNow = (offsetSeconds = 0) => new Date(Date.now() + 2 * 3600 * 1000 + offsetSeconds * 1000).toISOString().slice(0, 19).replace('T', ' ');

function createFakePayFastApi({ port = 3198, merchantId = '10000100', passphrase = '' } = {}) {
    const state = { rows: [], mode: 'ok', calls: [] };
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://x');
        const query = Object.fromEntries(url.searchParams.entries());
        const call = { path: url.pathname, query, merchantId: req.headers['merchant-id'], version: req.headers.version, timestamp: req.headers.timestamp, sigOk: false };
        state.calls.push(call);
        const json = (status, body, extra = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...extra }); res.end(JSON.stringify(body)); };
        if (state.mode === 'down') return req.socket.destroy();
        if (state.mode === 'error') return json(500, { code: 500, status: 'failed', data: { response: 'Internal error' } });
        if (state.mode === 'rate') return json(429, { code: 429, status: 'failed', data: { response: 'Too many requests' } }, { 'Retry-After': '120' });
        if (url.pathname !== '/transactions/history' || req.method !== 'GET') return json(404, { code: 404, status: 'failed', data: { response: 'Not found' } });

        const values = { 'merchant-id': req.headers['merchant-id'], version: req.headers.version, timestamp: req.headers.timestamp };
        for (const [k, v] of Object.entries(query)) if (k !== 'testing') values[k] = v;
        call.sigOk = state.mode !== 'auth' && req.headers['merchant-id'] === merchantId && req.headers.signature === apiSignature(values, passphrase)
            && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{4}$/.test(req.headers.timestamp || '') && req.headers.version === 'v1';
        if (!call.sigOk) return json(401, { code: 401, status: 'failed', data: { response: 'Merchant authorization failed.', message: false } });

        if (!/^\d{4}-\d{2}-\d{2}$/.test(query.from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(query.to || '')) return json(400, { code: 400, status: 'failed', data: { response: { from: 'The from date format is invalid.' } } });
        if (state.mode === 'garbage') { res.writeHead(200, { 'Content-Type': 'text/csv;charset=UTF-8' }); return res.end('Foo,Bar\n1,2\n'); }

        const inRange = state.rows.filter((r) => r.date.slice(0, 10) >= query.from && r.date.slice(0, 10) <= query.to);
        const offset = parseInt(query.offset || '0', 10) || 0, limit = parseInt(query.limit || '1000', 10) || 1000;
        const page = inRange.slice(offset, offset + limit);
        if (!page.length) { res.writeHead(204); return res.end(); }
        res.writeHead(200, { 'Content-Type': 'text/csv;charset=UTF-8' });
        res.end([COLUMNS.join(','), ...page.map((r) => r.line)].join('\n') + '\n');
    });
    return {
        state,
        start: () => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); }),
        stop: () => new Promise((resolve) => { server.close(() => resolve()); if (server.closeAllConnections) server.closeAllConnections(); }),
        setRows: (rows) => { state.rows = rows.slice(); },
        addRow: (r) => { state.rows.push(r); return r; },
        setMode: (m) => { state.mode = m; },
        reset: () => { state.rows = []; state.mode = 'ok'; state.calls = []; }
    };
}

module.exports = { createFakePayFastApi, row, sastNow, rands };
