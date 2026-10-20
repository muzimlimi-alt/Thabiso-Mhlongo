// lib/payfast-api.js - the PayFast merchant API client and the rules that decide which PayFast payment belongs to which of our payment attempts.
// No database and no network: the signature is checked against a literal port of PayFast's own PHP SDK, the CSV against rows copied from the real sandbox
// (2026-10-19), the HTTP behaviour through an injected fetch, and the matching rules case by case - including the exact situation of booking 100054, where
// the real sandbox showed a R5,400 attempt and the R10,350 payment that was set up, both under the same payment reference.
const crypto = require('crypto');
const api = require('../lib/payfast-api');

// PayFast SDK Auth::generateApiSignature, line for line (PHP urlencode, ksort, passphrase added under the key "passphrase" only when not null)
const phpUrlencode = (s) => encodeURIComponent(String(s)).replace(/%20/g, '+').replace(/[!'()*~]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
function phpGenerateApiSignature(pfData, passPhrase) {
    const d = { ...pfData };
    if (passPhrase !== null) d.passphrase = passPhrase;
    const keys = Object.keys(d).sort();
    let s = '';
    for (const k of keys) if (k !== 'signature') s += k + '=' + phpUrlencode(d[k]) + '&';
    return crypto.createHash('md5').update(s.slice(0, -1)).digest('hex');
}

const HEADER = 'Date,Type,Sign,Party,Name,Description,Currency,"Funding Type",Gross,Fee,Net,Balance,"M Payment ID","PF Payment ID","custom str1","custom int1","custom str2","custom int2","custom str3","custom str4","custom str5","custom int3","custom int4","custom int5"';
// rows exactly as the real sandbox returned them
const REAL_CSV = [HEADER,
    '"2026-10-19 06:44:11",FUNDS_RECEIVED,CREDIT,"Test User 01","Booking 2 - Smith Sons Gala - 50% Deposit",,ZAR,WALLET,"2,500.00",-57.50,"2,442.50",,2_SCHED3,3459010,,,,,,,,,,',
    '"2026-10-19 20:50:36",FUNDS_RECEIVED,CREDIT,"Test User 01","Booking 100054 - sdfghjkl - First Milestone 30%",,ZAR,WALLET,"5,400.00",-124.20,"5,275.80",,100054_SCHED88,3461342,,,,,,,,,,',
    '"2026-10-19 20:54:00",FUNDS_RECEIVED,CREDIT,"Test User 01","Booking 100054 - sdfghjkl - First Milestone 30%",,ZAR,WALLET,"10,350.00",-238.05,"10,111.95",,100054_SCHED88,3461352,,,,,,,,,,',
    ''].join('\n');

const resp = (status, body = '', headers = {}) => ({ status, text: async () => body, headers: { get: (k) => headers[String(k).toLowerCase()] ?? null } });

module.exports = async function ({ check }) {
    // ═══ the signature ═══
    const vals = { 'merchant-id': '10047344', version: 'v1', timestamp: '2026-10-19T20:35:10+0200', from: '2026-10-19', to: '2026-10-19' };
    check('API signature: identical to PayFast\'s own SDK (header + query values, sorted alphabetically, passphrase added, PHP urlencode)',
        api.apiSignature(vals, 'a passphrase') === phpGenerateApiSignature(vals, 'a passphrase'), api.apiSignature(vals, 'a passphrase') + ' vs ' + phpGenerateApiSignature(vals, 'a passphrase'));
    check('...without a passphrase it is left out entirely (an account with none), as the SDK does for null', api.apiSignature(vals, '') === phpGenerateApiSignature(vals, null) && api.apiSignature(vals, undefined) === phpGenerateApiSignature(vals, null), '');
    check('...the key order is alphabetical, NOT the checkout form\'s order: shuffling the values changes nothing', api.apiSignature({ to: vals.to, from: vals.from, version: vals.version, 'merchant-id': vals['merchant-id'], timestamp: vals.timestamp }, 'x') === api.apiSignature(vals, 'x'), '');
    check('...the passphrase matters, and so does every value (a changed date is a different signature)', api.apiSignature(vals, 'a') !== api.apiSignature(vals, 'b') && api.apiSignature(vals, 'a') !== api.apiSignature({ ...vals, to: '2026-10-20' }, 'a'), '');
    check('...a "signature" value inside the input is never part of what is signed', api.apiSignature({ ...vals, signature: 'zzz' }, 'p') === api.apiSignature(vals, 'p'), '');
    check('...special characters in a passphrase are encoded the PHP way (spaces +, ! \' ( ) * ~ and & percent-encoded)', api.apiSignature(vals, "p@ss w!rd'(1)*~&=") === phpGenerateApiSignature(vals, "p@ss w!rd'(1)*~&="), '');
    check('...the timestamp\'s : and + are percent-encoded inside the signed string, as PayFast computes it', api.apiSignature(vals, 'p') === phpGenerateApiSignature(vals, 'p') && phpUrlencode(vals.timestamp) === '2026-10-19T20%3A35%3A10%2B0200', phpUrlencode(vals.timestamp));
    check('timestamp: South African time with +0200 whatever the server\'s own zone (18:35:10 UTC is 20:35:10)', api.apiTimestamp(new Date('2026-10-19T18:35:10Z')) === '2026-10-19T20:35:10+0200', api.apiTimestamp(new Date('2026-10-19T18:35:10Z')));
    check('...and it rolls over midnight correctly (22:30 UTC is 00:30 the next day)', api.apiTimestamp(new Date('2026-10-19T22:30:00Z')) === '2026-10-20T00:30:00+0200', '');

    // ═══ configuration ═══
    const cfg = api.resolveConfig({ PAYFAST_MERCHANT_ID: ' 10047344 ', PAYFAST_PASSPHRASE: ' pass ', PAYFAST_URL: 'https://sandbox.payfast.co.za/eng/process' });
    check('config: the merchant id and passphrase are trimmed, a sandbox checkout URL means sandbox, the real API is the default', cfg.merchantId === '10047344' && cfg.passphrase === 'pass' && cfg.sandbox === true && cfg.baseUrl === 'https://api.payfast.co.za' && cfg.enabled && cfg.configured, JSON.stringify(cfg));
    check('...a live checkout URL is not sandbox', api.resolveConfig({ PAYFAST_MERCHANT_ID: '1', PAYFAST_URL: 'https://www.payfast.co.za/eng/process' }).sandbox === false, '');
    check('...PAYFAST_API_URL overrides the API address (tests use it)', api.resolveConfig({ PAYFAST_MERCHANT_ID: '1', PAYFAST_API_URL: 'http://127.0.0.1:3198/' }).baseUrl === 'http://127.0.0.1:3198/', '');
    check('...no merchant id means not configured', api.resolveConfig({}).configured === false && api.resolveConfig({ PAYFAST_MERCHANT_ID: '  ' }).configured === false, '');
    check('...PAYFAST_RECONCILE=off (any case, any spacing) switches it off; anything else leaves it on', ['off', 'OFF', ' Off '].every((v) => api.resolveConfig({ PAYFAST_MERCHANT_ID: '1', PAYFAST_RECONCILE: v }).enabled === false) && ['', 'on', 'yes', undefined].every((v) => api.resolveConfig({ PAYFAST_MERCHANT_ID: '1', PAYFAST_RECONCILE: v }).enabled === true), '');

    // ═══ money and CSV ═══
    const cents = { '2,500.00': 250000, '10,350.00': 1035000, '1,035,000.00': 103500000, '-57.50': -5750, '5400': 540000, '0.5': 50, '0': 0, ' 10.00 ': 1000, '0.07': 7 };
    check('amounts become exact integer cents ("2,500.00", "-57.50", "5400", " 10.00 " ...)', Object.entries(cents).every(([k, v]) => api.toCents(k) === v), JSON.stringify(Object.entries(cents).filter(([k, v]) => api.toCents(k) !== v)));
    check('...anything that is not an amount is null, never guessed ("", "abc", "12.345", "1.2.3", "R10")', ['', 'abc', '12.345', '1.2.3', 'R10', null, undefined].every((v) => api.toCents(v) === null), '');
    check('...no floating point drift: 1,000,000.07 and 0.29 are exact', api.toCents('1,000,000.07') === 100000007 && api.toCents('0.29') === 29, '');
    const grid = api.parseCsv('a,"b,c","d ""q"" e"\r\n1,,3\r\n\r\n"x\ny",z\n');
    check('CSV: quoted commas, doubled quotes, CRLF, blank lines and a newline inside quotes all parse', grid.length === 3 && grid[0].join('|') === 'a|b,c|d "q" e' && grid[1].join('|') === '1||3' && grid[2][0] === 'x\ny' && grid[2][1] === 'z', JSON.stringify(grid));
    check('CSV: empty input is no rows', api.parseCsv('').length === 0 && api.parseCsv('\n\n').length === 0, '');

    // ═══ the real history rows ═══
    const parsed = api.parseHistoryCsv(REAL_CSV);
    check('the real sandbox CSV parses into 3 rows with nothing skipped', parsed.rows.length === 3 && parsed.skipped === 0, JSON.stringify(parsed.rows.length));
    const r3 = parsed.rows[2];
    check('...each with PayFast\'s own payment id, our payment reference, the gross in cents, rand, the type and sign',
        r3.pfPaymentId === '3461352' && r3.mPaymentId === '100054_SCHED88' && r3.grossCents === 1035000 && r3.currency === 'ZAR' && r3.type === 'FUNDS_RECEIVED' && r3.sign === 'CREDIT' && r3.date === '2026-10-19 20:54:00' && r3.feeCents === -23805 && r3.fundingType === 'WALLET', JSON.stringify(r3));
    check('...an item name containing a comma / quote survives', api.parseHistoryCsv([HEADER, '"2026-10-19 10:00:00",FUNDS_RECEIVED,CREDIT,"A","Booking 7 - ""Smith, Sons"" Gala",,ZAR,WALLET,"100.00",-2.30,"97.70",,7_FULL,555,,,,,,,,,,'].join('\n')).rows[0].name === 'Booking 7 - "Smith, Sons" Gala', '');
    check('a row whose amount or date is unreadable is skipped and counted, never half-trusted', (() => { const p = api.parseHistoryCsv([HEADER, '"2026-10-19 10:00:00",FUNDS_RECEIVED,CREDIT,"A","n",,ZAR,WALLET,"oops",,,,7_FULL,555,,,,,,,,,,', '"not a date",FUNDS_RECEIVED,CREDIT,"A","n",,ZAR,WALLET,"1.00",,,,7_FULL,556,,,,,,,,,,'].join('\n')); return p.rows.length === 0 && p.skipped === 2; })(), '');
    let formatErr = null; try { api.parseHistoryCsv('Foo,Bar\n1,2\n'); } catch (e) { formatErr = e; }
    check('a response without the documented columns is a FORMAT error naming what is missing (a changed API is never guessed at)', formatErr && formatErr.code === 'FORMAT' && /M Payment ID/.test(formatErr.message), formatErr && formatErr.message);
    check('an empty response is no rows', api.parseHistoryCsv('').rows.length === 0, '');

    // ═══ the request ═══
    const calls = [];
    const okFetch = (pages) => async (url, init) => { calls.push({ url: new URL(url), headers: init.headers }); const body = pages.shift(); return body === null ? resp(204) : resp(200, body, { 'content-type': 'text/csv' }); };
    const live = { merchantId: '10047344', passphrase: 'pp', sandbox: false, baseUrl: 'https://api.payfast.co.za' };
    await api.fetchHistory(live, { from: '2026-10-18', to: '2026-10-19' }, { fetchImpl: okFetch([REAL_CSV]), now: () => new Date('2026-10-19T18:35:10Z') });
    const c0 = calls[0];
    check('the request goes to /transactions/history with from, to, offset and limit', c0.url.origin === 'https://api.payfast.co.za' && c0.url.pathname === '/transactions/history' && c0.url.searchParams.get('from') === '2026-10-18' && c0.url.searchParams.get('to') === '2026-10-19' && c0.url.searchParams.get('offset') === '0' && c0.url.searchParams.get('limit') === '1000', c0.url.href);
    check('...with merchant-id, version v1, the timestamp and a signature in the HEADERS', c0.headers['merchant-id'] === '10047344' && c0.headers.version === 'v1' && c0.headers.timestamp === '2026-10-19T20:35:10+0200' && /^[0-9a-f]{32}$/.test(c0.headers.signature), JSON.stringify(c0.headers));
    const expectSig = phpGenerateApiSignature({ 'merchant-id': '10047344', version: 'v1', timestamp: '2026-10-19T20:35:10+0200', from: '2026-10-18', to: '2026-10-19', offset: '0', limit: '1000' }, 'pp');
    check('...and that signature is exactly what PayFast\'s SDK would send for the same request (offset and limit are signed too)', c0.headers.signature === expectSig, c0.headers.signature + ' vs ' + expectSig);
    check('...a live merchant is NOT told ?testing=true', !c0.url.searchParams.has('testing'), c0.url.href);
    calls.length = 0;
    await api.fetchHistory({ ...live, sandbox: true }, { from: '2026-10-19', to: '2026-10-19' }, { fetchImpl: okFetch([REAL_CSV]), now: () => new Date('2026-10-19T18:35:10Z') });
    check('...a sandbox merchant is told ?testing=true, and testing is NOT part of the signature (as the SDK does)', calls[0].url.searchParams.get('testing') === 'true'
        && calls[0].headers.signature === phpGenerateApiSignature({ 'merchant-id': '10047344', version: 'v1', timestamp: '2026-10-19T20:35:10+0200', from: '2026-10-19', to: '2026-10-19', offset: '0', limit: '1000' }, 'pp'), '');
    calls.length = 0;
    await api.fetchHistory({ ...live, passphrase: '' }, { from: '2026-10-19', to: '2026-10-19' }, { fetchImpl: okFetch([REAL_CSV]), now: () => new Date('2026-10-19T18:35:10Z') });
    check('...an account with no passphrase signs without one', calls[0].headers.signature === phpGenerateApiSignature({ 'merchant-id': '10047344', version: 'v1', timestamp: '2026-10-19T20:35:10+0200', from: '2026-10-19', to: '2026-10-19', offset: '0', limit: '1000' }, null), '');
    calls.length = 0;
    await api.fetchHistory({ ...live, baseUrl: 'http://127.0.0.1:3198/' }, { from: '2026-10-19', to: '2026-10-19' }, { fetchImpl: okFetch([REAL_CSV]) });
    check('...a custom base URL (tests) is used, trailing slash and all', calls[0].url.origin === 'http://127.0.0.1:3198' && calls[0].url.pathname === '/transactions/history', calls[0].url.href);

    const pageOf = (n, start) => [HEADER, ...Array.from({ length: n }, (_, i) => `"2026-10-19 10:00:${String((start + i) % 60).padStart(2, '0')}",FUNDS_RECEIVED,CREDIT,"A","n",,ZAR,WALLET,"1.00",,,,${start + i}_FULL,${9000 + start + i},,,,,,,,,,`)].join('\n');
    calls.length = 0;
    const paged = await api.fetchHistory(live, { from: '2026-10-19', to: '2026-10-19' }, { fetchImpl: okFetch([pageOf(2, 0), pageOf(2, 2), pageOf(1, 4)]), pageLimit: 2 });
    check('paging: full pages are followed with a growing offset until a short page ends it (5 rows, 3 requests, offsets 0, 2, 4)', paged.rows.length === 5 && paged.pages === 3 && calls.map((c) => c.url.searchParams.get('offset')).join() === '0,2,4' && calls.every((c) => c.url.searchParams.get('limit') === '2'), JSON.stringify({ rows: paged.rows.length, pages: paged.pages }));
    calls.length = 0;
    const pagedEnd = await api.fetchHistory(live, { from: '2026-10-19', to: '2026-10-19' }, { fetchImpl: okFetch([pageOf(2, 0), pageOf(2, 2), null]), pageLimit: 2 });
    check('...a 204 after a full page ends it too', pagedEnd.rows.length === 4 && pagedEnd.pages === 3, JSON.stringify({ rows: pagedEnd.rows.length, pages: pagedEnd.pages }));
    const none = await api.fetchHistory(live, { from: '2020-01-01', to: '2020-01-02' }, { fetchImpl: okFetch([null]) });
    check('...a 204 straight away is "nothing in that period" (an empty list, not an error)', none.rows.length === 0 && none.pages === 1, '');
    let runaway = 0;
    const endless = await api.fetchHistory(live, { from: '2026-10-19', to: '2026-10-19' }, { fetchImpl: async () => { runaway++; return resp(200, pageOf(2, runaway % 50), {}); }, pageLimit: 2 });
    check('...a server that never stops sending full pages is cut off at the page cap, not followed forever', runaway === api.MAX_PAGES && endless.pages === api.MAX_PAGES, String(runaway));

    const errOf = async (fetchImpl, c = live) => { try { await api.fetchHistory(c, { from: '2026-10-19', to: '2026-10-19' }, { fetchImpl }); return null; } catch (e) { return e; } };
    const e401 = await errOf(async () => resp(401, '{"code":401,"status":"failed","data":{"response":"Merchant authorization failed."}}'));
    check('error: 401 is AUTH, with a message about the merchant id and passphrase', e401 && e401.code === 'AUTH' && /merchant id and passphrase/i.test(e401.message) && e401.status === 401, e401 && e401.message);
    const e403 = await errOf(async () => resp(403));
    check('error: 403 is AUTH as well', e403 && e403.code === 'AUTH', '');
    const e429 = await errOf(async () => resp(429, '', { 'retry-after': '120' }));
    check('error: 429 is RATE_LIMIT carrying how long PayFast asked us to wait', e429 && e429.code === 'RATE_LIMIT' && e429.retryAfterSeconds === 120, JSON.stringify(e429 && e429.retryAfterSeconds));
    const e429b = await errOf(async () => resp(429));
    check('...and a sensible wait when it did not say', e429b && e429b.retryAfterSeconds === 300, '');
    const e400 = await errOf(async () => resp(400, '{"code":400}'));
    check('error: 400 is BAD_REQUEST', e400 && e400.code === 'BAD_REQUEST', '');
    const e500 = await errOf(async () => resp(500, 'boom'));
    check('error: 500 / 502 / any other status is HTTP, never read as data', e500 && e500.code === 'HTTP' && e500.status === 500 && (await errOf(async () => resp(502))).code === 'HTTP' && (await errOf(async () => resp(302))).code === 'HTTP', '');
    const eNet = await errOf(async () => { throw new Error('ECONNREFUSED 127.0.0.1:3198'); });
    check('error: a connection failure is NETWORK', eNet && eNet.code === 'NETWORK' && /ECONNREFUSED/.test(eNet.message), eNet && eNet.message);
    const eTime = await errOf(async () => { const e = new Error('timed out'); e.name = 'TimeoutError'; throw e; });
    check('error: a timeout is TIMEOUT', eTime && eTime.code === 'TIMEOUT', '');
    const eNone = await errOf(async () => resp(200, REAL_CSV), { ...live, merchantId: '' });
    check('error: no merchant id is NOT_CONFIGURED and PayFast is never asked', eNone && eNone.code === 'NOT_CONFIGURED', '');
    const eBad = await errOf(async () => resp(200, 'Foo,Bar\n1,2\n'));
    check('error: a 200 with the wrong columns is FORMAT', eBad && eBad.code === 'FORMAT', '');
    check('...every error is a PayFastApiError carrying a code the safety net can act on', [e401, e429, e500, eNet, eTime, eNone, eBad].every((e) => e instanceof api.PayFastApiError && typeof e.code === 'string'), '');

    // ═══ which payment belongs to which attempt ═══
    const mk = (over) => ({ date: '2026-10-19 20:54:00', type: 'FUNDS_RECEIVED', sign: 'CREDIT', currency: 'ZAR', fundingType: 'WALLET', grossCents: 1035000, mPaymentId: '100054_SCHED88', pfPaymentId: '3461352', name: 'x', ...over });
    const intent = (over) => ({ id: 1, booking_id: 100054, m_payment_id: '100054_SCHED88', expected_amount: 10350, status: 'pending', created_at: '2026-10-19 18:53:39', ...over });   // 18:53:39 UTC = 20:53:39 SAST
    const plan = (intents, rows, rec) => api.planRecovery(intents, rows, rec || new Set());

    let p = plan([intent()], [mk()]);
    check('match: the right payment reference, the exact amount, made after the attempt began -> recovered', p.recover.length === 1 && p.recover[0].row.pfPaymentId === '3461352' && p.findings.length === 0, JSON.stringify(p));

    p = plan([intent()], api.parseHistoryCsv(REAL_CSV).rows);
    check('REAL CASE (booking 100054): the R10,350 payment is recovered and the earlier R5,400 attempt under the same reference is NOT - it is reported',
        p.recover.length === 1 && p.recover[0].row.pfPaymentId === '3461352' && p.findings.length === 1 && p.findings[0].kind === 'mismatch' && p.findings[0].row.pfPaymentId === '3461342', JSON.stringify(p.findings.map((f) => f.row.pfPaymentId)));
    check('...the report says what was received, what was set up, and that nothing was recorded', /R5400\.00/.test(p.findings[0].detail) && /R10350\.00/.test(p.findings[0].detail) && /Nothing was recorded/.test(p.findings[0].detail), p.findings[0].detail);
    check('...payments of other bookings in the same sandbox account (2_SCHED3, 3_SCHED5) are not touched or reported at all', !p.findings.some((f) => /^[23]_SCHED/.test(f.row.mPaymentId)) && !p.recover.some((r) => /^[23]_SCHED/.test(r.row.mPaymentId)), '');

    p = plan([intent()], [mk({ grossCents: 1035001 })]);
    check('amount one cent out -> not recovered, reported as a mismatch', p.recover.length === 0 && p.findings.length === 1 && p.findings[0].kind === 'mismatch', JSON.stringify(p));
    p = plan([intent({ expected_amount: 10350.1 })], [mk({ grossCents: 1035010 })]);
    check('...an attempt for R10,350.10 matches 1035010 cents exactly (no float error)', p.recover.length === 1, '');
    p = plan([intent({ expected_amount: 0.29 })], [mk({ grossCents: 29 })]);
    check('...and R0.29 matches 29 cents', p.recover.length === 1, '');
    p = plan([intent()], [mk({ date: '2026-10-19 19:10:00' })]);
    check('a payment made BEFORE the attempt began (same amount, same reference) belongs to an earlier attempt -> not recovered, reported', p.recover.length === 0 && p.findings.length === 1 && /BEFORE the current payment attempt/.test(p.findings[0].detail), JSON.stringify(p));
    p = plan([intent()], [mk({ date: '2026-10-19 20:51:40' })]);
    check('...a clock allowance of two minutes: 1m59s before is accepted', p.recover.length === 1, JSON.stringify(p));
    p = plan([intent()], [mk({ date: '2026-10-19 20:51:30' })]);
    check('...2m09s before is not', p.recover.length === 0 && p.findings.length === 1, JSON.stringify(p));
    p = plan([intent()], [mk({ currency: 'USD' })]);
    check('a payment in another currency is never recorded automatically', p.recover.length === 0 && p.findings.length === 1 && /USD/.test(p.findings[0].detail), JSON.stringify(p));
    p = plan([intent()], [mk({ type: 'REFUND' }), mk({ sign: 'DEBIT', pfPaymentId: '77' }), mk({ type: 'WITHDRAWAL', sign: 'DEBIT', pfPaymentId: '78' })]);
    check('refunds, withdrawals and anything that is not money RECEIVED are ignored', p.recover.length === 0 && p.findings.length === 0, JSON.stringify(p));
    p = plan([intent()], [mk()], new Set(['3461352']));
    check('a payment already in the ledger (PayFast id recorded) is ignored - not recovered twice, not reported', p.recover.length === 0 && p.findings.length === 0, JSON.stringify(p));
    p = plan([intent({ status: 'fulfilled' })], [mk()]);
    check('an attempt that is already fulfilled is not considered at all', p.recover.length === 0 && p.findings.length === 0, JSON.stringify(p));
    p = plan([intent()], [mk({ mPaymentId: '100054_SCHED880' }), mk({ mPaymentId: '100054_sched88', pfPaymentId: '5' }), mk({ mPaymentId: '', pfPaymentId: '6' })]);
    check('the payment reference must match EXACTLY: look-alikes, other case and blank are ignored', p.recover.length === 0 && p.findings.length === 0, JSON.stringify(p));
    p = plan([intent()], [mk({ pfPaymentId: '' })]);
    check('a row without PayFast\'s own payment id is never used', p.recover.length === 0 && p.findings.length === 0, JSON.stringify(p));
    p = plan([intent()], [mk({ pfPaymentId: '200', date: '2026-10-19 20:55:00' }), mk({ pfPaymentId: '100', date: '2026-10-19 20:54:00' })]);
    check('two payments that both fit (a double payment): only the EARLIEST is recovered, the other is reported as a duplicate for a refund decision',
        p.recover.length === 1 && p.recover[0].row.pfPaymentId === '100' && p.findings.length === 1 && p.findings[0].kind === 'duplicate_payment' && p.findings[0].row.pfPaymentId === '200' && /paid twice/.test(p.findings[0].detail), JSON.stringify(p));
    p = plan([intent({ id: 1 }), intent({ id: 2, booking_id: 7, m_payment_id: '7_FULL', expected_amount: 500 })], [mk(), mk({ mPaymentId: '7_FULL', grossCents: 50000, pfPaymentId: '999' })]);
    check('several attempts are matched independently', p.recover.length === 2 && p.recover.map((r) => r.intent.id).sort().join() === '1,2', JSON.stringify(p));
    p = plan([intent()], []);
    check('no PayFast rows -> nothing to do', p.recover.length === 0 && p.findings.length === 0, '');
    p = plan([], [mk()]);
    check('no attempts -> PayFast\'s rows are ignored (they may belong to another site on the same merchant account)', p.recover.length === 0 && p.findings.length === 0, '');
};
