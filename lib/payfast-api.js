// PayFast's merchant API (server-to-server, authenticated with the merchant id + passphrase): the part this site uses to find payments PayFast
// SAYS it received but whose notification (ITN) never reached us - see lib/payfast-reconcile.js for what is done with them.
//
// Everything here is verified against PayFast's own SDK and against the real sandbox (2026-10-19):
//   GET https://api.payfast.co.za/transactions/history?from=YYYY-MM-DD&to=YYYY-MM-DD&offset=0&limit=1000     (+ ?testing=true for a sandbox merchant)
//   headers: merchant-id, version (v1), timestamp (PHP date("Y-m-d\TH:i:sO")), signature
//   signature: md5 of  key=urlencode(value)&...  over EVERY header and query value (not "signature", not "testing") plus passphrase,
//              sorted ALPHABETICALLY by key (the checkout form's signature is NOT sorted; this one is), PHP urlencode.
//   200 text/csv  rows: Date, Type, Sign, Party, Name, Description, Currency, "Funding Type", Gross, Fee, Net, Balance, "M Payment ID", "PF Payment ID", custom ...
//   204 no body   nothing in that period / past the last page
//   401 JSON      {"code":401,"status":"failed","data":{"response":"Merchant authorization failed."}}   (wrong signature, passphrase or merchant)
//   400 JSON      a bad date etc.
// No database and no site code in this file, so tests (and the fake PayFast API they run) can load it freely.
'use strict';
const crypto = require('crypto');
const { phpUrlencode } = require('./payfast-signature');

const LIVE_API = 'https://api.payfast.co.za';
const PAGE_LIMIT = 1000;
const MAX_PAGES = 20;                  // 20,000 rows is far beyond a period of days; a runaway server cannot loop us forever
const REQUEST_TIMEOUT_MS = 20000;

// code: NOT_CONFIGURED | AUTH | RATE_LIMIT | BAD_REQUEST | HTTP | FORMAT | NETWORK | TIMEOUT
class PayFastApiError extends Error {
    constructor(code, message, { status = null, retryAfterSeconds = null } = {}) {
        super(message);
        this.name = 'PayFastApiError';
        this.code = code;
        this.status = status;
        this.retryAfterSeconds = retryAfterSeconds;
    }
}

// What the safety net needs from the environment (read live: Admin > Settings changes process.env at once).
//   merchantId / passphrase : the same ones the checkout uses (the API is signed with them)
//   sandbox                 : the checkout is pointed at PayFast's sandbox -> the API is told ?testing=true
//   baseUrl                 : PAYFAST_API_URL (tests point it at a fake); PayFast's real API otherwise
//   enabled                 : on unless PAYFAST_RECONCILE=off
function resolveConfig(env = process.env) {
    const merchantId = String(env.PAYFAST_MERCHANT_ID || '').trim();
    return {
        merchantId,
        passphrase: String(env.PAYFAST_PASSPHRASE || '').trim(),
        sandbox: /sandbox/i.test(String(env.PAYFAST_URL || '')),
        baseUrl: String(env.PAYFAST_API_URL || '').trim() || LIVE_API,
        enabled: String(env.PAYFAST_RECONCILE || '').trim().toLowerCase() !== 'off',
        configured: !!merchantId
    };
}

// The timestamp PayFast expects, in South African time (a fixed +0200 - no daylight saving - so it never depends on the server's own time zone).
function apiTimestamp(now = new Date()) {
    return new Date(now.getTime() + 2 * 3600 * 1000).toISOString().slice(0, 19) + '+0200';
}

// `values`: every header and query value being sent (except signature and testing). passphrase: the merchant's, or empty when the account has none.
function apiSignature(values, passphrase) {
    const all = { ...values };
    if (passphrase) all.passphrase = passphrase;
    const str = Object.keys(all).filter((k) => k !== 'signature').sort().map((k) => `${k}=${phpUrlencode(String(all[k]))}`).join('&');
    return crypto.createHash('md5').update(str).digest('hex');
}

// ── CSV ──────────────────────────────────────────────────────────────────────────────────────────────────────
// RFC 4180: fields may be quoted ("2,500.00", "Booking 7 - O""Brien"), quotes doubled inside, any line ending.
function parseCsv(text) {
    const rows = [];
    let row = [], field = '', quoted = false, i = 0;
    const s = String(text || '');
    while (i < s.length) {
        const c = s[i];
        if (quoted) {
            if (c === '"') { if (s[i + 1] === '"') { field += '"'; i += 2; continue; } quoted = false; i++; continue; }
            field += c; i++; continue;
        }
        if (c === '"') { quoted = true; i++; continue; }
        if (c === ',') { row.push(field); field = ''; i++; continue; }
        if (c === '\r') { i++; continue; }
        if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
        field += c; i++;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

// "2,500.00" / "-57.50" / "5400" -> integer cents (no floating point drift), or null when it is not an amount.
function toCents(s) {
    const t = String(s == null ? '' : s).replace(/[\s,]/g, '');
    const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(t);
    if (!m) return null;
    const cents = parseInt(m[2], 10) * 100 + parseInt((m[3] || '').padEnd(2, '0') || '0', 10);
    return m[1] ? -cents : cents;
}

const REQUIRED = ['Date', 'Type', 'Sign', 'Currency', 'Gross', 'M Payment ID', 'PF Payment ID'];

// The history CSV as a list of plain objects. Throws FORMAT when the columns are not the ones documented (a changed API must never be guessed at);
// a single unreadable row is counted in `skipped` and left out, never half-trusted.
function parseHistoryCsv(text) {
    const grid = parseCsv(text);
    if (!grid.length) return { rows: [], skipped: 0 };
    const header = grid[0].map((h) => h.trim());
    const col = {};
    header.forEach((h, idx) => { col[h] = idx; });
    const missing = REQUIRED.filter((h) => !(h in col));
    if (missing.length) throw new PayFastApiError('FORMAT', `PayFast's transaction history did not have the expected columns (missing: ${missing.join(', ')})`);
    const rows = [];
    let skipped = 0;
    for (const r of grid.slice(1)) {
        const get = (h) => (h in col ? (r[col[h]] || '').trim() : '');
        const gross = toCents(get('Gross'));
        const date = get('Date');
        if (gross === null || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(date)) { skipped++; continue; }
        rows.push({
            date,                                                    // PayFast's own clock, South African time
            type: get('Type'), sign: get('Sign'), name: get('Name'), party: get('Party'),
            currency: get('Currency'), fundingType: get('Funding Type'),
            grossCents: gross, feeCents: toCents(get('Fee')), netCents: toCents(get('Net')),
            mPaymentId: get('M Payment ID'), pfPaymentId: get('PF Payment ID')
        });
    }
    return { rows, skipped };
}

// ── the request ──────────────────────────────────────────────────────────────────────────────────────────────
// cfg: { merchantId, passphrase, sandbox, baseUrl }.  from / to: 'YYYY-MM-DD'.  Resolves { rows, skipped, pages }.
async function fetchHistory(cfg, { from, to }, { fetchImpl = fetch, now = () => new Date(), pageLimit = PAGE_LIMIT } = {}) {
    if (!cfg || !cfg.merchantId) throw new PayFastApiError('NOT_CONFIGURED', 'No PayFast merchant id is configured.');
    const base = String(cfg.baseUrl || LIVE_API).replace(/\/$/, '');
    const all = [];
    let skipped = 0, pages = 0;
    for (let offset = 0; pages < MAX_PAGES; offset += pageLimit) {
        const query = { from, to, offset: String(offset), limit: String(pageLimit) };
        const headers = { 'merchant-id': String(cfg.merchantId), version: 'v1', timestamp: apiTimestamp(now()) };
        headers.signature = apiSignature({ ...headers, ...query }, cfg.passphrase);
        const qs = new URLSearchParams(cfg.sandbox ? { ...query, testing: 'true' } : query);
        let res;
        try {
            res = await fetchImpl(`${base}/transactions/history?${qs}`, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
        } catch (e) {
            if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw new PayFastApiError('TIMEOUT', 'PayFast did not answer in time.');
            throw new PayFastApiError('NETWORK', `Could not reach PayFast (${e && e.message ? e.message : 'network error'}).`);
        }
        pages++;
        if (res.status === 204) break;                                     // nothing here, or past the last page
        const text = await res.text();
        if (res.status === 401 || res.status === 403) throw new PayFastApiError('AUTH', 'PayFast refused the merchant credentials (check the merchant id and passphrase).', { status: res.status });
        if (res.status === 429) throw new PayFastApiError('RATE_LIMIT', 'PayFast asked us to slow down.', { status: 429, retryAfterSeconds: parseInt(res.headers.get('retry-after'), 10) || 300 });
        if (res.status === 400) throw new PayFastApiError('BAD_REQUEST', 'PayFast rejected the request.', { status: 400 });
        if (res.status !== 200) throw new PayFastApiError('HTTP', `PayFast answered HTTP ${res.status}.`, { status: res.status });
        const parsed = parseHistoryCsv(text);
        skipped += parsed.skipped;
        all.push(...parsed.rows);
        if (parsed.rows.length + parsed.skipped < pageLimit) break;        // a short page is the last page
    }
    return { rows: all, skipped, pages };
}

// ── matching: which PayFast payments belong to which of OUR pending payment attempts ──────────────────────────
// A payment is only ever tied to an attempt when ALL of these hold (anything else is reported to a person, never credited):
//   * it is money RECEIVED into the account (FUNDS_RECEIVED / CREDIT), in rand;
//   * its M Payment ID is exactly the attempt's m_payment_id (the checkout sends it, e.g. 100054_SCHED88);
//   * its gross amount equals, to the cent, the amount the attempt was built for;
//   * it happened AFTER the attempt was created (minus a 2-minute clock allowance) - an earlier payment under the same id belongs to an earlier attempt;
//   * PayFast's own payment id is not already in the ledger.
// intents: [{ id, booking_id, m_payment_id, expected_amount, status, created_at }]  (created_at: UTC 'YYYY-MM-DD HH:MM:SS' as SQLite stores it)
// recordedPfIds: Set of PayFast payment ids already in the ledger.
// Returns { recover: [{ intent, row }], findings: [{ kind, intent, row, detail }] }  - kinds: mismatch | duplicate_payment
const CLOCK_ALLOWANCE_MS = 2 * 60 * 1000;
const rowTime = (row) => Date.parse(row.date.replace(' ', 'T') + '+02:00');
const intentTime = (intent) => Date.parse(String(intent.created_at).replace(' ', 'T') + 'Z');
const money = (cents) => `R${(cents / 100).toFixed(2)}`;

function planRecovery(intents, rows, recordedPfIds = new Set()) {
    const received = rows.filter((r) => r.type === 'FUNDS_RECEIVED' && r.sign === 'CREDIT' && r.pfPaymentId && !recordedPfIds.has(r.pfPaymentId));
    const byMPaymentId = new Map();
    for (const r of received) {
        if (!byMPaymentId.has(r.mPaymentId)) byMPaymentId.set(r.mPaymentId, []);
        byMPaymentId.get(r.mPaymentId).push(r);
    }
    const recover = [], findings = [];
    for (const intent of intents) {
        if (intent.status !== 'pending') continue;
        const candidates = (byMPaymentId.get(intent.m_payment_id) || []).slice().sort((a, b) => rowTime(a) - rowTime(b));
        if (!candidates.length) continue;
        const expectedCents = Math.round(parseFloat(intent.expected_amount) * 100);
        const startedAt = intentTime(intent);
        const fits = (r) => r.currency === 'ZAR' && r.grossCents === expectedCents && rowTime(r) >= startedAt - CLOCK_ALLOWANCE_MS;
        const first = candidates.find(fits);
        if (first) recover.push({ intent, row: first });
        for (const r of candidates) {
            if (r === first) continue;
            if (first && fits(r)) {
                findings.push({ kind: 'duplicate_payment', intent, row: r, detail: `PayFast received ${money(r.grossCents)} a second time for ${intent.m_payment_id} (the first was recorded as payment ${first.pfPaymentId}). The client may have paid twice and be owed a refund.` });
            } else if (r.currency !== 'ZAR') {
                findings.push({ kind: 'mismatch', intent, row: r, detail: `PayFast shows ${money(r.grossCents)} in ${r.currency || 'an unknown currency'} for ${intent.m_payment_id}; only rand payments are recorded automatically.` });
            } else if (r.grossCents !== expectedCents) {
                findings.push({ kind: 'mismatch', intent, row: r, detail: `PayFast received ${money(r.grossCents)} on ${r.date} for ${intent.m_payment_id}, but the payment that was set up was for ${money(expectedCents)}. Nothing was recorded; check it and record it by hand if it is genuine.` });
            } else {
                findings.push({ kind: 'mismatch', intent, row: r, detail: `PayFast received ${money(r.grossCents)} on ${r.date} for ${intent.m_payment_id}, but BEFORE the current payment attempt was started (${intent.created_at} UTC), so it belongs to an earlier attempt. Nothing was recorded; check it and record it by hand if it is genuine.` });
            }
        }
    }
    return { recover, findings };
}

module.exports = {
    LIVE_API, PAGE_LIMIT, MAX_PAGES, PayFastApiError, resolveConfig,
    apiTimestamp, apiSignature, parseCsv, toCents, parseHistoryCsv, fetchHistory, planRecovery
};
