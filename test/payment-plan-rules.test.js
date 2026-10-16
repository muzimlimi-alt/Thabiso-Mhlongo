// Pure unit tests for js/shared/payment-plan-rules.js — the client payment-plan rules shared by the server
// (accept-quote, POST /payment-plan) and the public tracking page's plan builder. No server, database or
// clock is involved: every context is built from a fixed "today", so the date boundaries below are exact
// and never flake around midnight (the server passes the Africa/Johannesburg date in; this module never
// reads the clock). The end-to-end behaviour is covered by client-milestones.test.js.
//
// Fixed scenario unless a test says otherwise: today 2026-10-16 (a Friday), event 2026-12-31, accepted
// today, total R10,000, nothing paid, 50% deposit, R500 minimum.
//   → deposit floor R5,000; first payment due by 2026-10-23 (today + 7); last due 2026-12-29 (event − 2).
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const MODULE_PATH = path.join(__dirname, '..', 'js', 'shared', 'payment-plan-rules.js');

const TODAY = '2026-10-16';
const EVENT = '2026-12-31';
const J = JSON.stringify;
const eq = (a, b) => J(a) === J(b);
const DASH = '\u2013';

module.exports = async function ({ check }) {
    let R;
    try {
        R = require(MODULE_PATH);
    } catch (e) {
        check('payment-plan-rules: module loads under Node', false, e.stack);
        return;
    }
    // A thrown error would abort every later test file (test/run.js has no per-file catch), so any
    // surprise is reported as one failed check instead.
    try {
        runAll(R, check);
    } catch (e) {
        check('payment-plan-rules: suite ran to completion without throwing', false, e.stack);
    }
};

function runAll(R, check) {
    const base = (o) => Object.assign({
        mode: 'accept', today: TODAY, totalAmount: 10000, amountPaid: 0, liveRows: [],
        eventDate: EVENT, acceptedDate: TODAY, depositPercentage: 50, minPaymentAmount: 500,
    }, o || {});
    const ctxOf = (o) => R.buildContext(base(o));
    const msgs = (res) => res.errors.map(e => `[${e.index}/${e.field}] ${e.message}`).join(' | ') || '(no errors)';
    const has = (res, re) => res.errors.some(e => re.test(e.message));
    const errAt = (res, index, field) => res.errors.filter(e => e.index === index && e.field === field);
    const p = (amount, due_date) => ({ amount, due_date });

    // ══════════ module shape ══════════
    check('rules: constants are 4 payments / 7 days / 2 days / R500 / 50%',
        R.MAX_PAYMENTS === 4 && R.FIRST_DUE_WITHIN_DAYS === 7 && R.LAST_DUE_DAYS_BEFORE_EVENT === 2 &&
        R.DEFAULT_MIN_PAYMENT === 500 && R.DEFAULT_DEPOSIT_PERCENTAGE === 50,
        J([R.MAX_PAYMENTS, R.FIRST_DUE_WITHIN_DAYS, R.LAST_DUE_DAYS_BEFORE_EVENT, R.DEFAULT_MIN_PAYMENT, R.DEFAULT_DEPOSIT_PERCENTAGE]));
    const exported = ['buildContext', 'validatePlan', 'buildPreset', 'labelPlan', 'toCents', 'formatRand', 'formatDate',
        'addDays', 'diffDays', 'parseMoneyInput', 'planVersion', 'roundToCents', 'isValidDate', 'isUnchangedPlan'];
    check('rules: every helper is exported as a function', exported.every(k => typeof R[k] === 'function'),
        exported.filter(k => typeof R[k] !== 'function').join(','));

    // The browser path: a plain <script> with no module system defines window.PaymentPlanRules.
    const src = fs.readFileSync(MODULE_PATH, 'utf8');
    const sandbox = {};
    vm.runInNewContext(src, sandbox, { filename: 'payment-plan-rules.js' });
    const B = sandbox.PaymentPlanRules;
    check('rules: as a browser <script> it defines PaymentPlanRules on the global object',
        !!B && typeof B.validatePlan === 'function' && B.MAX_PAYMENTS === 4, typeof B);
    check('rules: the browser copy gives the same answers as the Node copy',
        !!B && eq(B.buildPreset(B.buildContext(base()), 3), R.buildPreset(R.buildContext(base()), 3)), '');
    check('rules: no dependencies (nothing is required)', !/\brequire\s*\(/.test(src), '');

    // ══════════ money helpers ══════════
    const centsCases = [
        [1500, 150000], ['1500', 150000], ['1500.5', 150050], ['1500.50', 150050], [' 12.34 ', 1234], [0, 0], ['0.00', 0],
        [0.1 + 0.2, 30], [1234.56, 123456], [19.99, 1999], [1666.66, 166666], ['007', 700], [123456789.01, 12345678901],
        ['1500.555', null], [1500.555, null], [12.345, null], [-5, null], ['-5', null], [NaN, null], [Infinity, null],
        ['', null], ['   ', null], [null, null], [undefined, null], ['abc', null], ['1e3', null], ['1,500', null], ['.5', null],
        ['1500.', null], ['+5', null], [true, null], [{}, null], [[5], null], ['R500', null],
    ];
    const badCents = centsCases.filter(([inp, out]) => R.toCents(inp) !== out);
    check('toCents: strict rands -> integer cents (<= 2 decimals; negatives, NaN, text and >2 decimals are null)',
        badCents.length === 0, badCents.map(([i, o]) => `${J(i)} -> ${R.toCents(i)} (want ${o})`).join('; '));

    const roundCases = [[1234.5678, 123457], [1250.5, 125050], ['2500.00', 250000], [null, 0], [undefined, 0], ['', 0],
        ['x', 0], [NaN, 0], [-10.5, -1050], [0.1 + 0.2, 30], [1666.666, 166667]];
    const badRound = roundCases.filter(([i, o]) => R.roundToCents(i) !== o);
    check('roundToCents: stored rand values (possibly unrounded) round to whole cents',
        badRound.length === 0, badRound.map(([i, o]) => `${J(i)} -> ${R.roundToCents(i)} (want ${o})`).join('; '));

    const randCases = [[0, 'R 0.00'], [5, 'R 0.05'], [99, 'R 0.99'], [50000, 'R 500.00'], [123450, 'R 1,234.50'],
        [100000000, 'R 1,000,000.00'], [99999, 'R 999.99'], [-150, '-R 1.50'], [1234567891, 'R 12,345,678.91']];
    const badRand = randCases.filter(([i, o]) => R.formatRand(i) !== o);
    check('formatRand: cents -> "R 1,234.50" with thousands commas',
        badRand.length === 0, badRand.map(([i, o]) => `${i} -> ${R.formatRand(i)} (want ${o})`).join('; '));

    const moneyCases = [
        ['R 1 500,50', 1500.5], ['1,500.50', 1500.5], ['1 500.50', 1500.5], ['1500', 1500], ['R1500', 1500], ['r 250', 250],
        ['1,500', 1500], ['12,345,678.90', 12345678.9], ['1.500,50', 1500.5], ['1,5', 1.5], ['1,50', 1.5], ['1500.5', 1500.5],
        ['.5', 0.5], ['R\u00a01\u00a0500', 1500], ['1\u202f500,25', 1500.25], ['ZAR 2000', 2000], ['  750  ', 750], ['0', 0],
        ['1.000.000', 1000000], [1500.5, 1500.5], [0.1 + 0.2, 0.3],
        ['1500.555', null], ['1.500', null], ['1,5000', null], ['1,500,50', null], ['15,00,000', null], ['1500,', null],
        ['-500', null], ['R-500', null], ['abc', null], ['', null], ['   ', null], ['R', null], ['1e3', null], [null, null],
        [undefined, null], [-1, null], [NaN, null], [12.345, null], ['1,500.555', null], ['1.500,5,0', null],
    ];
    const badMoney = moneyCases.filter(([i, o]) => R.parseMoneyInput(i) !== o);
    check('parseMoneyInput: liberal typed input ("R 1 500,50", "1,500.50", "R1500") -> rands; ambiguous or malformed -> null',
        badMoney.length === 0, badMoney.map(([i, o]) => `${J(i)} -> ${R.parseMoneyInput(i)} (want ${o})`).join('; '));

    // ══════════ date helpers ══════════
    const addCases = [
        ['2026-10-16', 7, '2026-10-23'], ['2026-12-30', 3, '2027-01-02'], ['2028-02-28', 1, '2028-02-29'],
        ['2027-02-28', 1, '2027-03-01'], ['2026-03-01', -1, '2026-02-28'], ['2026-03-28', 2, '2026-03-30'],
        ['2026-10-24', 2, '2026-10-26'], ['2026-12-31', -2, '2026-12-29'], ['2026-10-16', 0, '2026-10-16'],
        ['2026-10-16', 30, '2026-11-15'], ['2026-02-30', 1, null], ['nope', 1, null], [null, 1, null], ['2026-10-16', NaN, null],
    ];
    const badAdd = addCases.filter(([d, n, o]) => R.addDays(d, n) !== o);
    check('addDays: exact calendar arithmetic across month/year ends, leap years and DST weekends',
        badAdd.length === 0, badAdd.map(([d, n, o]) => `${d}+${n} -> ${R.addDays(d, n)} (want ${o})`).join('; '));

    const diffCases = [['2026-10-23', '2026-10-16', 7], ['2026-10-16', '2026-10-23', -7], ['2028-03-01', '2028-02-01', 29],
        ['2027-01-01', '2026-12-31', 1], ['2026-10-16', '2026-10-16', 0], ['2026-13-01', '2026-10-16', null], ['2026-10-16', '', null]];
    const badDiff = diffCases.filter(([a, b, o]) => R.diffDays(a, b) !== o);
    check('diffDays(a, b) is a − b in whole days (null for an invalid date)',
        badDiff.length === 0, badDiff.map(([a, b, o]) => `${a}-${b} -> ${R.diffDays(a, b)} (want ${o})`).join('; '));

    const validDates = ['2026-10-16', '2028-02-29', '2026-12-31', '2026-01-01'];
    const invalidDates = ['2026-02-29', '2026-13-01', '2026-04-31', '2026-00-10', '2026-4-1', '2026-10-16T00:00', '16/10/2026', '', null, 20261016];
    check('isValidDate: only real YYYY-MM-DD calendar dates',
        validDates.every(R.isValidDate) && !invalidDates.some(R.isValidDate),
        J(invalidDates.filter(R.isValidDate)) + J(validDates.filter(d => !R.isValidDate(d))));
    check('formatDate: "2 Nov 2026" style',
        R.formatDate('2026-11-02') === '2 Nov 2026' && R.formatDate('2026-01-31') === '31 Jan 2026' &&
        R.formatDate('2027-12-09') === '9 Dec 2027' && R.formatDate(null) === '',
        [R.formatDate('2026-11-02'), R.formatDate('2026-01-31'), R.formatDate('2027-12-09')].join(','));

    // ══════════ planVersion ══════════
    check('planVersion: sorted live ids | paid cents | total cents',
        R.planVersion([{ id: 12 }, { id: 3 }, { id: 7 }], 500000, 1000000) === '3,7,12|500000|1000000' &&
        R.planVersion([], 0, 1000000) === '|0|1000000', R.planVersion([{ id: 12 }, { id: 3 }, { id: 7 }], 500000, 1000000));
    check('planVersion: superseded/cancelled rows never count; any new id, payment or total change gives a new version',
        R.planVersion([{ id: 1, status: 'superseded' }, { id: 2 }, { id: 4, status: 'Cancelled' }], 0, 5) === '2|0|5' &&
        R.planVersion([{ id: 2 }, { id: 3 }], 0, 5) !== R.planVersion([{ id: 2 }, { id: 4 }], 0, 5) &&
        R.planVersion([{ id: 2 }], 0, 5) !== R.planVersion([{ id: 2 }], 1, 5) &&
        R.planVersion([{ id: 2 }], 0, 5) !== R.planVersion([{ id: 2 }], 0, 6),
        R.planVersion([{ id: 1, status: 'superseded' }, { id: 2 }, { id: 4, status: 'Cancelled' }], 0, 5));

    // ══════════ buildContext ══════════
    const c0 = ctxOf();
    const want0 = {
        mode: 'accept', today: TODAY, max_payments: 4, deposit_percentage: 50, min_payment_cents: 50000,
        total_cents: 1000000, paid_cents: 0, locked_cents: 0, credit_cents: 0, remaining_cents: 1000000,
        locked_ids: [], locked_count: 0, unpaid_rows: [], slots: 4, deposit_floor_cents: 500000,
        require_deposit: true, deposit_needed_cents: 500000, require_first_by: true, earliest_due: TODAY,
        latest_due: '2026-12-29', first_due_by: '2026-10-23', event_date: EVENT, consistent: true, event_passed: false,
    };
    const diff0 = Object.keys(want0).filter(k => !eq(c0[k], want0[k]));
    check('buildContext (accept, nothing paid): every documented field', diff0.length === 0,
        diff0.map(k => `${k}=${J(c0[k])} (want ${J(want0[k])})`).join('; '));
    check('buildContext: the context is plain JSON (it is sent to the browser verbatim) and validates identically after a round trip',
        eq(JSON.parse(J(c0)), c0) &&
        eq(R.validatePlan(JSON.parse(J(c0)), [p(4000, '2026-10-24'), p(6000, '2027-01-01')]), R.validatePlan(c0, [p(4000, '2026-10-24'), p(6000, '2027-01-01')])), '');

    let threw = null;
    try { R.buildContext(base({ today: '16/10/2026' })); } catch (e) { threw = e; }
    check('buildContext: an invalid "today" is a programming error and throws', threw instanceof TypeError, String(threw));

    const cNoEvent = ctxOf({ eventDate: null });
    check('buildContext: no event date -> last due date is today + 30, no event_passed',
        cNoEvent.latest_due === '2026-11-15' && cNoEvent.event_date === null && cNoEvent.event_passed === false && cNoEvent.first_due_by === '2026-10-23',
        J([cNoEvent.latest_due, cNoEvent.event_date, cNoEvent.first_due_by]));
    const cDefaults = ctxOf({ depositPercentage: undefined, minPaymentAmount: null });
    check('buildContext: missing policies fall back to 50% deposit and R500 minimum',
        cDefaults.deposit_percentage === 50 && cDefaults.min_payment_cents === 50000, J([cDefaults.deposit_percentage, cDefaults.min_payment_cents]));
    check('buildContext: deposit % is clamped to 0..100 and a negative minimum to 0',
        ctxOf({ depositPercentage: 150 }).deposit_percentage === 100 && ctxOf({ depositPercentage: -5 }).deposit_percentage === 0 &&
        ctxOf({ depositPercentage: '30' }).deposit_percentage === 30 && ctxOf({ minPaymentAmount: -1 }).min_payment_cents === 0 &&
        ctxOf({ minPaymentAmount: '750.5' }).min_payment_cents === 75050, '');
    check('buildContext: mode is "change" only when asked, anything else is "accept"',
        ctxOf({ mode: 'change' }).mode === 'change' && ctxOf({ mode: 'bogus' }).mode === 'accept', '');

    const cRound = ctxOf({ totalAmount: 1234.5678 });
    check('buildContext: an unrounded stored total is rounded to cents; the deposit floor is rounded to the cent',
        cRound.total_cents === 123457 && cRound.remaining_cents === 123457 && cRound.deposit_floor_cents === 61729,
        J([cRound.total_cents, cRound.deposit_floor_cents]));

    // Live rows: unsorted input, mixed-case statuses, superseded/cancelled noise, string amounts, time suffixes.
    const messy = [
        { id: 5, due_date: '2026-12-29 00:00:00', expected_amount: '5000.00', status: 'PENDING', sequence: 2, source: 'client' },
        { id: 4, due_date: '2026-10-20', expected_amount: 5000, status: 'Paid', sequence: 1, source: 'client' },
        { id: 3, due_date: '2026-10-18', expected_amount: 5000, status: 'superseded', sequence: 1, source: 'auto' },
        { id: 2, due_date: '2026-10-17', expected_amount: 5000, status: 'Cancelled', sequence: 1, source: 'auto' },
    ];
    const cMessy = ctxOf({ mode: 'change', amountPaid: 5000, liveRows: messy });
    check('buildContext: dead rows are ignored, rows sorted by due date, statuses lower-cased, dates and amounts normalised',
        eq(cMessy.locked_ids, [4]) && cMessy.unpaid_rows.length === 1 &&
        eq(cMessy.unpaid_rows[0], { id: 5, due_date: '2026-12-29', amount_cents: 500000, status: 'pending', sequence: 2, source: 'client' }) &&
        cMessy.consistent === true,
        J({ locked: cMessy.locked_ids, unpaid: cMessy.unpaid_rows }));
    const cTie = ctxOf({
        mode: 'change', amountPaid: 3000, liveRows: [
            { id: 9, due_date: '2026-11-01', expected_amount: 3000, status: 'pending' },
            { id: 8, due_date: '2026-11-01', expected_amount: 3000, status: null },
            { id: 10, due_date: '2026-12-01', expected_amount: 4000 },
        ],
    });
    check('buildContext: same-day rows are walked in id order (like alignMilestonePayments); a null status counts as pending',
        eq(cTie.locked_ids, [8]) && eq(cTie.unpaid_rows.map(r => r.id), [9, 10]) && cTie.unpaid_rows.every(r => r.status === 'pending'),
        J({ locked: cTie.locked_ids, unpaid: cTie.unpaid_rows }));

    // The standard "deposit paid" state: R5,000 paid on a 50/50 plan, deposit paid early (its due date is still ahead).
    const depositPaidRows = [
        { id: 11, due_date: '2026-10-20', expected_amount: 5000, status: 'paid', sequence: 1, source: 'client' },
        { id: 12, due_date: '2026-12-29', expected_amount: 5000, status: 'pending', sequence: 2, source: 'client' },
    ];
    const cL = ctxOf({ mode: 'change', amountPaid: 5000, liveRows: depositPaidRows, acceptedDate: '2026-10-13' });
    const wantL = {
        mode: 'change', paid_cents: 500000, locked_cents: 500000, credit_cents: 0, remaining_cents: 500000,
        locked_ids: [11], locked_count: 1, slots: 3, require_deposit: false, deposit_needed_cents: 0,
        require_first_by: false, first_due_by: null, earliest_due: '2026-10-20', latest_due: '2026-12-29', consistent: true,
        sequence_base: 1,
    };
    const diffL = Object.keys(wantL).filter(k => !eq(cL[k], wantL[k]));
    check('buildContext (deposit paid early): locked row, 3 slots left, no deposit/first-by rules, earliest due = the paid row\'s due date',
        diffL.length === 0, diffL.map(k => `${k}=${J(cL[k])} (want ${J(wantL[k])})`).join('; '));
    check('buildContext: locked_rows and unpaid_rows carry id/due_date/amount_cents/status/sequence/source',
        eq(cL.locked_rows, [{ id: 11, due_date: '2026-10-20', amount_cents: 500000, status: 'paid', sequence: 1, source: 'client' }]) &&
        eq(cL.unpaid_rows, [{ id: 12, due_date: '2026-12-29', amount_cents: 500000, status: 'pending', sequence: 2, source: 'client' }]),
        J([cL.locked_rows, cL.unpaid_rows]));

    const cPast = ctxOf({ mode: 'change', amountPaid: 5000, liveRows: [Object.assign({}, depositPaidRows[0], { due_date: '2026-10-10' }), depositPaidRows[1]] });
    check('buildContext: a locked row due in the past leaves earliest due = today', cPast.earliest_due === TODAY, cPast.earliest_due);

    const stale = depositPaidRows.map(r => Object.assign({}, r, { status: 'pending' }));
    const cStale = ctxOf({ mode: 'change', amountPaid: 5000, liveRows: stale });
    check('buildContext: locking comes from money, not flags — a covered row still flagged pending is locked (post-payment window)',
        eq(cStale.locked_ids, [11]) && cStale.consistent === true && cStale.remaining_cents === 500000, J(cStale.locked_ids));

    const cCredit = ctxOf({ mode: 'change', amountPaid: 6000, liveRows: depositPaidRows });
    check('buildContext: partial credit (R1,000 paid into the next milestone) -> credit_cents set, consistent=false',
        eq(cCredit.locked_ids, [11]) && cCredit.credit_cents === 100000 && cCredit.consistent === false,
        J([cCredit.locked_ids, cCredit.credit_cents, cCredit.consistent]));
    const cFlag = ctxOf({ mode: 'change', amountPaid: 0, liveRows: depositPaidRows });
    check('buildContext: a row flagged paid that no money covers -> not locked, consistent=false',
        cFlag.locked_count === 0 && cFlag.credit_cents === 0 && cFlag.consistent === false && cFlag.require_first_by === true,
        J([cFlag.locked_ids, cFlag.consistent]));
    const cRefund = ctxOf({ mode: 'change', amountPaid: 4000, liveRows: depositPaidRows });
    check('buildContext: a partly refunded deposit -> nothing locked, credit R4,000, consistent=false',
        cRefund.locked_count === 0 && cRefund.credit_cents === 400000 && cRefund.consistent === false, J([cRefund.locked_ids, cRefund.credit_cents]));
    const cFull = ctxOf({ mode: 'change', amountPaid: 10000, liveRows: depositPaidRows });
    check('buildContext: fully paid -> every row locked, nothing remaining, no unpaid rows',
        eq(cFull.locked_ids, [11, 12]) && cFull.remaining_cents === 0 && cFull.unpaid_rows.length === 0 && cFull.slots === 2 && cFull.consistent === true,
        J([cFull.locked_ids, cFull.remaining_cents]));
    const cOver = ctxOf({ mode: 'change', amountPaid: 12000, liveRows: depositPaidRows });
    check('buildContext: overpaid -> credit left over, consistent=false, remaining 0',
        cOver.credit_cents === 200000 && cOver.consistent === false && cOver.remaining_cents === 0, J([cOver.credit_cents, cOver.remaining_cents]));

    // Cumulative deposit: R2,000 already paid on a R10,000 booking at 50% -> R3,000 more needed up front.
    const partRows = [
        { id: 21, due_date: '2026-10-10', expected_amount: 2000, status: 'paid', sequence: 1, source: 'admin' },
        { id: 22, due_date: '2026-12-29', expected_amount: 8000, status: 'pending', sequence: 2, source: 'admin' },
    ];
    const cPart = ctxOf({ mode: 'change', amountPaid: 2000, liveRows: partRows });
    check('buildContext: deposit floor is judged cumulatively (R2,000 locked -> R3,000 still needed, first-by rule off)',
        cPart.require_deposit === true && cPart.deposit_needed_cents === 300000 && cPart.deposit_floor_cents === 500000 &&
        cPart.require_first_by === false && cPart.first_due_by === null && cPart.earliest_due === TODAY && cPart.remaining_cents === 800000,
        J([cPart.require_deposit, cPart.deposit_needed_cents, cPart.require_first_by, cPart.earliest_due]));
    const cExact = ctxOf({ mode: 'change', amountPaid: 5000, liveRows: [Object.assign({}, partRows[0], { expected_amount: 5000 }), Object.assign({}, partRows[1], { expected_amount: 5000 })] });
    check('buildContext: once locked money reaches the floor the deposit rule no longer applies',
        cExact.require_deposit === false && cExact.deposit_needed_cents === 0, J([cExact.require_deposit, cExact.deposit_needed_cents]));

    check('buildContext: sequence_base = max(locked count, highest locked sequence)',
        ctxOf({ amountPaid: 5000, liveRows: [Object.assign({}, depositPaidRows[0], { sequence: 5 }), depositPaidRows[1]] }).sequence_base === 5 &&
        ctxOf({ amountPaid: 7000, liveRows: [
            { id: 1, due_date: '2026-10-01', expected_amount: 5000, status: 'paid', sequence: null },
            { id: 2, due_date: '2026-10-02', expected_amount: 2000, status: 'paid', sequence: null },
            { id: 3, due_date: '2026-12-01', expected_amount: 3000, status: 'pending', sequence: 1 },
        ] }).sequence_base === 2 && c0.sequence_base === 0, '');

    // First-payment anchor.
    const cAnch = ctxOf({ mode: 'change', acceptedDate: '2026-10-12', liveRows: [{ id: 31, due_date: '2026-10-19', expected_amount: 10000 }] });
    check('buildContext (change, nothing paid): first payment anchored to the ORIGINAL acceptance date + 7',
        cAnch.first_due_by === '2026-10-19' && cAnch.require_first_by === true, cAnch.first_due_by);
    const cLapsed = ctxOf({ mode: 'change', acceptedDate: '2026-10-01' });
    check('buildContext: once acceptance + 7 has passed the first payment must be due today', cLapsed.first_due_by === TODAY, cLapsed.first_due_by);
    check('buildContext: an unknown acceptance date is treated as accepted today', ctxOf({ mode: 'change', acceptedDate: null }).first_due_by === '2026-10-23', '');
    check('buildContext: acceptance date accepts a timestamp prefix', ctxOf({ acceptedDate: '2026-10-12 21:30:00' }).first_due_by === '2026-10-19', '');

    // Short-notice events.
    const cE8 = ctxOf({ eventDate: '2026-10-24' });
    check('buildContext: event in 8 days -> last due event − 2, first due clamped to it',
        cE8.latest_due === '2026-10-22' && cE8.first_due_by === '2026-10-22', J([cE8.latest_due, cE8.first_due_by]));
    const cE1 = ctxOf({ eventDate: '2026-10-17' });
    check('buildContext: event tomorrow -> latest due clamped up to today, first due today, not passed',
        cE1.latest_due === TODAY && cE1.first_due_by === TODAY && cE1.event_passed === false, J([cE1.latest_due, cE1.first_due_by]));
    check('buildContext: event_passed only when the event is before today',
        ctxOf({ eventDate: '2026-10-10' }).event_passed === true && ctxOf({ eventDate: TODAY }).event_passed === false &&
        ctxOf({ eventDate: TODAY }).latest_due === TODAY, '');
    const cLateLock = ctxOf({ mode: 'change', amountPaid: 5000, eventDate: '2026-10-25', liveRows: [
        { id: 41, due_date: '2026-10-24', expected_amount: 5000, status: 'paid' }, { id: 42, due_date: '2026-10-24', expected_amount: 5000 }] });
    check('buildContext: a locked row due after event − 2 pushes latest due up to it (window never inverts)',
        cLateLock.earliest_due === '2026-10-24' && cLateLock.latest_due === '2026-10-24', J([cLateLock.earliest_due, cLateLock.latest_due]));

    // ══════════ validatePlan ══════════
    const ok2 = R.validatePlan(c0, [p(5000, '2026-10-23'), p('5000.00', '2026-12-29')]);
    check('validatePlan: the classic 50/50 plan (deposit on today+7, balance on event−2) is valid',
        ok2.ok && eq(ok2.rows, [{ amount_cents: 500000, due_date: '2026-10-23' }, { amount_cents: 500000, due_date: '2026-12-29' }]), msgs(ok2));
    const okSorted = R.validatePlan(c0, [p(2000, '2026-12-29'), p(6000, '2026-10-16'), p(2000, '2026-11-20')]);
    check('validatePlan: output rows are sorted by due date; "first payment" means the earliest-dated one',
        okSorted.ok && eq(okSorted.rows.map(r => r.due_date), ['2026-10-16', '2026-11-20', '2026-12-29']) && okSorted.rows[0].amount_cents === 600000,
        msgs(okSorted) + J(okSorted.rows));
    const ok4 = R.validatePlan(c0, [p(5000, '2026-10-20'), p(2000, '2026-11-15'), p(2000, '2026-12-01'), p(1000, '2026-12-29')]);
    check('validatePlan: a custom 4-payment plan is valid', ok4.ok, msgs(ok4));
    const ok1 = R.validatePlan(c0, [p(10000, TODAY)]);
    check('validatePlan: one payment of everything, due today, is valid', ok1.ok, msgs(ok1));
    check('validatePlan: string amounts with spaces and numbers computed as cents/100 are accepted',
        R.validatePlan(c0, [p(' 5000 ', '2026-10-23'), p(500000 / 100, '2026-12-29')]).ok &&
        R.validatePlan(ctxOf({ depositPercentage: 0 }), [p(3333.33, '2026-10-20'), p(3333.33, '2026-11-20'), p(10000 - 3333.33 - 3333.33, '2026-12-20')]).ok, '');

    // Rule 1: count.
    const five = R.validatePlan(c0, [p(5000, '2026-10-20'), p(1250, '2026-11-01'), p(1250, '2026-11-15'), p(1250, '2026-12-01'), p(1250, '2026-12-15')]);
    check('validatePlan rule 1: 5 payments rejected; plan-level error mentions the maximum of 4',
        !five.ok && five.errors.some(e => e.index === null && e.field === 'plan' && /at most 4 payments in total/.test(e.message)), msgs(five));
    check('validatePlan rule 1: an empty or missing plan is rejected',
        !R.validatePlan(c0, []).ok && /at least one payment/.test(R.validatePlan(c0, []).errors[0].message) &&
        !R.validatePlan(c0, null).ok && !R.validatePlan(c0, 'x').ok, '');
    const lockedFour = R.validatePlan(cL, [p(1250, '2026-11-01'), p(1250, '2026-11-15'), p(1250, '2026-12-01'), p(1250, '2026-12-15')]);
    check('validatePlan rule 1: paid payments count toward the 4 (1 paid -> 4 more rejected, message explains)',
        !lockedFour.ok && has(lockedFour, /at most 4 payments in total, including the 1 payment already made, so you can schedule up to 3 more/), msgs(lockedFour));
    const fullyPaid4 = ctxOf({ mode: 'change', amountPaid: 10000, liveRows: [1, 2, 3, 4].map(i => ({ id: i, due_date: `2026-10-0${i}`, expected_amount: 2500, status: 'paid' })) });
    const noSlots = R.validatePlan(fullyPaid4, [p(1, '2026-11-01')]);
    check('validatePlan rule 1: no slots left -> "no more can be scheduled"', fullyPaid4.slots === 0 && has(noSlots, /no more can be scheduled/), msgs(noSlots));

    // Rule 2: readable amounts and dates, reported per input row.
    const bad = R.validatePlan(c0, [p('abc', '2026-10-20'), p(-5, '2026-11-01'), p('12.345', '2026-11-02'), p(0, '2026-11-03'), p('', '2026-11-04'), { due_date: '2026-11-05' }]);
    check('validatePlan rule 2: unreadable, negative, >2-decimal, zero and missing amounts each flagged on their own row',
        [0, 1, 2, 3, 4, 5].every(i => errAt(bad, i, 'amount').length === 1) &&
        /in rands/.test(errAt(bad, 0, 'amount')[0].message) && /negative/.test(errAt(bad, 1, 'amount')[0].message) &&
        /2 decimal places/.test(errAt(bad, 2, 'amount')[0].message) && /more than R 0\.00/.test(errAt(bad, 3, 'amount')[0].message) &&
        /enter an amount/.test(errAt(bad, 4, 'amount')[0].message) && /enter an amount/.test(errAt(bad, 5, 'amount')[0].message), msgs(bad));
    check('validatePlan rule 2: messages number payments by their input position ("Payment 2" is the second card)',
        /^Payment 2:/.test(errAt(bad, 1, 'amount')[0].message), errAt(bad, 1, 'amount')[0].message);
    const badDates = R.validatePlan(c0, [p(5000, '2026-02-30'), p(5000, ''), p(5000, undefined)]);
    check('validatePlan rule 2: impossible and missing due dates are flagged',
        errAt(badDates, 0, 'due_date').length === 1 && /valid due date/.test(errAt(badDates, 0, 'due_date')[0].message) &&
        /choose a due date/.test(errAt(badDates, 1, 'due_date')[0].message) && /choose a due date/.test(errAt(badDates, 2, 'due_date')[0].message), msgs(badDates));
    const junk = R.validatePlan(c0, [null, 5, 'x']);
    check('validatePlan: junk rows never throw, they just fail', !junk.ok && junk.rows.length === 3, msgs(junk));
    check('validatePlan: no context -> a plan-level error, no throw', !R.validatePlan(null, [p(1, TODAY)]).ok, '');
    check('validatePlan: when invalid, rows still come back (unreadable fields null, unreadable dates last) for previews',
        eq(badDates.rows, [{ amount_cents: 500000, due_date: null }, { amount_cents: 500000, due_date: null }, { amount_cents: 500000, due_date: null }]) &&
        eq(R.validatePlan(c0, [p('x', '2026-10-20'), p(1, 'nope'), p(2, '2026-10-18')]).rows,
            [{ amount_cents: 200, due_date: '2026-10-18' }, { amount_cents: null, due_date: '2026-10-20' }, { amount_cents: 100, due_date: null }]), J(badDates.rows));

    // Rule 3: one payment per day.
    const dup = R.validatePlan(c0, [p(5000, '2026-10-20'), p(2500, '2026-12-01'), p(2500, '2026-12-01')]);
    check('validatePlan rule 3: two payments on the same day rejected (flagged on the later row)',
        !dup.ok && errAt(dup, 2, 'due_date').some(e => /Payments 2 and 3 are both due on 1 Dec 2026/.test(e.message)), msgs(dup));
    const trip = R.validatePlan(c0, [p(5000, '2026-10-20'), p(2000, '2026-12-01'), p(1500, '2026-12-01'), p(1500, '2026-12-01')]);
    check('validatePlan rule 3: three on one day -> two duplicate errors', trip.errors.filter(e => /both due on/.test(e.message)).length === 2, msgs(trip));

    // Rule 4: the date window.
    const past = R.validatePlan(c0, [p(5000, '2026-10-15'), p(5000, '2026-12-29')]);
    check('validatePlan rule 4: due yesterday rejected ("on or after today")',
        !past.ok && errAt(past, 0, 'due_date').some(e => /on or after today \(16 Oct 2026\)/.test(e.message)), msgs(past));
    const late = R.validatePlan(c0, [p(5000, '2026-10-23'), p(5000, '2026-12-30')]);
    check('validatePlan rule 4: due event − 1 rejected ("at least 2 days before your event (by 29 Dec 2026)")',
        !late.ok && errAt(late, 1, 'due_date').some(e => /at least 2 days before your event \(by 29 Dec 2026\)/.test(e.message)), msgs(late));
    check('validatePlan rule 4: due exactly today and exactly event − 2 are both allowed (inclusive bounds)',
        R.validatePlan(c0, [p(5000, TODAY), p(5000, '2026-12-29')]).ok, '');
    const beforeLock = R.validatePlan(cL, [p(2500, '2026-10-19'), p(2500, '2026-12-29')]);
    check('validatePlan rule 4: with a paid row due later than today, new rows can\'t be earlier than it',
        !beforeLock.ok && errAt(beforeLock, 0, 'due_date').some(e => /on or after your last paid payment's due date \(20 Oct 2026\)/.test(e.message)), msgs(beforeLock));
    check('validatePlan rule 4: on the paid row\'s own due date is allowed', R.validatePlan(cL, [p(2500, '2026-10-20'), p(2500, '2026-12-29')]).ok, '');
    const noEvLate = R.validatePlan(cNoEvent, [p(5000, '2026-10-20'), p(5000, '2026-11-16')]);
    check('validatePlan rule 4: no event date -> due by today + 30', has(noEvLate, /must be due by 15 Nov 2026\./), msgs(noEvLate));

    // Rule 5: covers exactly what is owed.
    const short = R.validatePlan(c0, [p(5000, '2026-10-23'), p(4999.99, '2026-12-29')]);
    check('validatePlan rule 5: one cent short -> exact "add up to" message (plan-wide, field amount)',
        !short.ok && short.errors.some(e => e.index === null && e.field === 'amount' &&
            e.message === 'Your payments add up to R 9,999.99, but R 10,000.00 needs to be scheduled.'), msgs(short));
    check('validatePlan rule 5: one cent over rejected too', !R.validatePlan(c0, [p(5000, '2026-10-23'), p(5000.01, '2026-12-29')]).ok, '');
    const lockedSum = R.validatePlan(cL, [p(5000, '2026-11-01'), p(5000, '2026-12-29')]);
    check('validatePlan rule 5: with a paid row only the remainder may be scheduled (R5,000, not R10,000)',
        has(lockedSum, /add up to R 10,000\.00, but R 5,000\.00 needs to be scheduled/), msgs(lockedSum));
    check('validatePlan rule 5: an unrounded total schedules its rounded cents (R1,234.57)',
        R.validatePlan(cRound, [p(617.29, '2026-10-20'), p(617.28, '2026-12-29')]).ok &&
        has(R.validatePlan(cRound, [p(617.29, '2026-10-20'), p(617.2778, '2026-12-29')]), /2 decimal places/), '');

    // Rule 6: minimum per payment.
    check('validatePlan rule 6: a R500.00 payment is allowed (boundary)', R.validatePlan(c0, [p(9500, '2026-10-23'), p(500, '2026-12-29')]).ok, '');
    const under = R.validatePlan(c0, [p(9500.01, '2026-10-23'), p(499.99, '2026-12-29')]);
    check('validatePlan rule 6: R499.99 rejected with the minimum in the message',
        !under.ok && errAt(under, 1, 'amount').some(e => /R 499\.99.*at least R 500\.00/.test(e.message)), msgs(under));
    const tiny = ctxOf({ totalAmount: 400 });
    check('validatePlan rule 6: a single remaining payment is exempt (R400 total, below the R500 minimum)',
        R.validatePlan(tiny, [p(400, '2026-10-20')]).ok, msgs(R.validatePlan(tiny, [p(400, '2026-10-20')])));
    const tinySplit = R.validatePlan(tiny, [p(200, '2026-10-20'), p(200, '2026-12-01')]);
    check('validatePlan rule 6: R400 split in two -> both payments below the minimum',
        errAt(tinySplit, 0, 'amount').length === 1 && /at least R 500\.00/.test(errAt(tinySplit, 0, 'amount')[0].message) &&
        errAt(tinySplit, 1, 'amount').length === 1, msgs(tinySplit));
    const cMin1000 = ctxOf({ minPaymentAmount: 1000 });
    check('validatePlan rule 6: the minimum follows the policy (R1,000)',
        has(R.validatePlan(cMin1000, [p(9500, '2026-10-23'), p(500, '2026-12-29')]), /at least R 1,000\.00/), '');
    check('validatePlan rule 6: a R0 minimum disables the rule', R.validatePlan(ctxOf({ minPaymentAmount: 0 }), [p(9999.99, '2026-10-23'), p(0.01, '2026-12-29')]).ok, '');

    // Rule 7: deposit floor.
    const dep = R.validatePlan(c0, [p(4999.99, '2026-10-23'), p(5000.01, '2026-12-29')]);
    check('validatePlan rule 7: first payment R0.01 under the 50% deposit rejected ("at least R 5,000.00 (the 50% deposit)")',
        !dep.ok && errAt(dep, 0, 'amount').some(e => e.message === 'Your first payment must be at least R 5,000.00 (the 50% deposit).'), msgs(dep));
    const depOrder = R.validatePlan(c0, [p(6000, '2026-12-29'), p(4000, '2026-10-20')]);
    check('validatePlan rule 7: the deposit is checked on the earliest-dated payment, flagged at its input position',
        errAt(depOrder, 1, 'amount').some(e => /the 50% deposit/.test(e.message)) && errAt(depOrder, 0, 'amount').length === 0, msgs(depOrder));
    const depLow = R.validatePlan(c0, [p(400, '2026-10-20'), p(9600, '2026-12-29')]);
    check('validatePlan rules 6+7: a first payment under both the minimum and the deposit gets ONE error (the deposit, the higher bound)',
        errAt(depLow, 0, 'amount').length === 1 && /the 50% deposit/.test(errAt(depLow, 0, 'amount')[0].message), msgs(depLow));
    const cAlmost = ctxOf({ mode: 'change', amountPaid: 4999.99, liveRows: [
        { id: 51, due_date: '2026-10-10', expected_amount: 4999.99, status: 'paid' }, { id: 52, due_date: '2026-12-29', expected_amount: 5000.01 }] });
    const almost = R.validatePlan(cAlmost, [p(400, '2026-10-20'), p(4600.01, '2026-12-29')]);
    check('validatePlan rules 6+7: when the deposit still needed (R0.01) is below the minimum, the minimum message is the one shown',
        cAlmost.deposit_needed_cents === 1 && errAt(almost, 0, 'amount').length === 1 && /at least R 500\.00/.test(errAt(almost, 0, 'amount')[0].message),
        msgs(almost));
    const depCum = R.validatePlan(cPart, [p(2999.99, '2026-11-01'), p(5000.01, '2026-12-29')]);
    check('validatePlan rule 7: cumulative deposit — R2,000 paid -> next payment must be at least R3,000 (message says why)',
        has(depCum, /next payment must be at least R 3,000\.00 so that, together with what you have already paid, the 50% deposit \(R 5,000\.00\) is covered/) &&
        R.validatePlan(cPart, [p(3000, '2026-11-01'), p(5000, '2026-12-29')]).ok, msgs(depCum));
    check('validatePlan rule 7: no deposit rule once the floor is covered (deposit paid -> R500 first is fine)',
        R.validatePlan(cL, [p(500, '2026-10-25'), p(4500, '2026-12-29')]).ok, '');

    // Rule 8: first payment within 7 days of acceptance.
    check('validatePlan rule 8: first payment due exactly today + 7 is allowed', R.validatePlan(c0, [p(5000, '2026-10-23'), p(5000, '2026-12-29')]).ok, '');
    const firstLate = R.validatePlan(c0, [p(5000, '2026-10-24'), p(5000, '2026-12-29')]);
    check('validatePlan rule 8: first payment due today + 8 rejected ("due by 23 Oct 2026, within 7 days of accepting the quote")',
        !firstLate.ok && errAt(firstLate, 0, 'due_date').some(e => e.message === 'Your first payment must be due by 23 Oct 2026, within 7 days of accepting the quote.'),
        msgs(firstLate));
    const firstWayLate = R.validatePlan(c0, [p(10000, '2027-01-05')]);
    check('validatePlan rule 8: a first payment past the event window reports the first-payment limit once (no duplicate window error)',
        errAt(firstWayLate, 0, 'due_date').length === 1 && /within 7 days/.test(errAt(firstWayLate, 0, 'due_date')[0].message), msgs(firstWayLate));
    const lapsed = R.validatePlan(cLapsed, [p(5000, '2026-10-17'), p(5000, '2026-12-29')]);
    check('validatePlan rule 8: change mode after the 7 days have passed -> the first payment must be due today',
        has(lapsed, /must be due today \(16 Oct 2026\)/) && R.validatePlan(cLapsed, [p(5000, TODAY), p(5000, '2026-12-29')]).ok, msgs(lapsed));
    check('validatePlan rule 8: repeated edits can\'t push the deposit back (anchor is the acceptance date, not today)',
        !R.validatePlan(cAnch, [p(5000, '2026-10-20'), p(5000, '2026-12-29')]).ok && R.validatePlan(cAnch, [p(5000, '2026-10-19'), p(5000, '2026-12-29')]).ok, '');
    check('validatePlan rule 8: no first-payment limit once something is paid',
        R.validatePlan(cPart, [p(3000, '2026-12-01'), p(5000, '2026-12-29')]).ok, '');

    const many = R.validatePlan(c0, [p(100, '2026-10-15'), p(9000, '2027-01-01')]);
    check('validatePlan: all problems are collected, not just the first',
        many.errors.length >= 4 && has(many, /on or after today/) && has(many, /at least 2 days before your event/) &&
        has(many, /add up to/) && has(many, /deposit/), msgs(many));

    // Deposit percentage extremes.
    const c0pct = ctxOf({ depositPercentage: 0 });
    check('validatePlan: 0% deposit -> no deposit floor (R500 first is fine) but the first-by rule still applies',
        c0pct.require_deposit === false && c0pct.deposit_needed_cents === 0 &&
        R.validatePlan(c0pct, [p(500, '2026-10-20'), p(9500, '2026-12-29')]).ok &&
        has(R.validatePlan(c0pct, [p(500, '2026-10-24'), p(9500, '2026-12-29')]), /within 7 days/), '');
    const c100 = ctxOf({ depositPercentage: 100 });
    const split100 = R.validatePlan(c100, [p(9500, '2026-10-20'), p(500, '2026-12-29')]);
    check('validatePlan: 100% deposit -> only a single payment of everything works',
        R.validatePlan(c100, [p(10000, '2026-10-20')]).ok && has(split100, /at least R 10,000\.00 \(the 100% deposit\)/), msgs(split100));

    // Short-notice events.
    check('validatePlan: event in 8 days -> deposit today and balance on event − 2 is a valid 2-payment plan',
        R.validatePlan(cE8, [p(5000, TODAY), p(5000, '2026-10-22')]).ok, '');
    const e1two = R.validatePlan(cE1, [p(5000, TODAY), p(5000, '2026-10-17')]);
    check('validatePlan: event tomorrow -> only one payment, due today (the second is flagged with the event date)',
        R.validatePlan(cE1, [p(10000, TODAY)]).ok && errAt(e1two, 1, 'due_date').some(e => /must be due by 16 Oct 2026 \(your event is on 17 Oct 2026\)/.test(e.message)),
        msgs(e1two));

    // ══════════ buildPreset ══════════
    const pre = (ctx, n) => R.buildPreset(ctx, n);
    const shape = (rows) => rows && rows.map(r => `${r.amount_cents}@${r.due_date}`).join(' ');
    check('buildPreset(1): everything, due on the first-payment date',
        shape(pre(c0, 1)) === '1000000@2026-10-23' && pre(c0, 1)[0].amount === 10000, shape(pre(c0, 1)));
    check('buildPreset(2) at acceptance: deposit floor on today + 7, balance on event − 2',
        shape(pre(c0, 2)) === '500000@2026-10-23 500000@2026-12-29', shape(pre(c0, 2)));
    check('buildPreset(3): deposit floor first, the rest split equally, dates spread evenly (50/25/25)',
        shape(pre(c0, 3)) === '500000@2026-10-23 250000@2026-11-26 250000@2026-12-29', shape(pre(c0, 3)));
    check('buildPreset(4): deposit first, the rest in equal cents with the last absorbing the remainder',
        shape(pre(c0, 4)) === '500000@2026-10-23 166666@2026-11-14 166666@2026-12-07 166668@2026-12-29' &&
        pre(c0, 4).map(r => r.amount).join(',') === '5000,1666.66,1666.66,1666.68', shape(pre(c0, 4)));
    check('buildPreset: n outside 1..4, non-integer or non-numeric -> null',
        [0, 5, -1, 2.5, 'x', null, undefined, NaN].every(n => pre(c0, n) === null) && pre(c0, '2') !== null, '');
    check('buildPreset: n above the slots left -> null (1 paid -> 4 not offered)', pre(cL, 4) === null && pre(cL, 3) !== null, '');
    check('buildPreset: nothing remaining -> null', pre(cFull, 1) === null, '');
    check('buildPreset after the deposit: equal split spread after the paid row\'s due date, last on event − 2',
        shape(pre(cL, 1)) === '500000@2026-12-29' && shape(pre(cL, 2)) === '250000@2026-11-24 250000@2026-12-29' &&
        shape(pre(cL, 3)) === '166666@2026-11-12 166666@2026-12-06 166668@2026-12-29', [shape(pre(cL, 1)), shape(pre(cL, 2)), shape(pre(cL, 3))].join(' / '));
    check('buildPreset with a partly paid deposit: the R3,000 still needed comes first',
        shape(pre(cPart, 2)) === '300000@2026-11-22 500000@2026-12-29' && shape(pre(cPart, 3)) === '300000@2026-11-10 250000@2026-12-04 250000@2026-12-29',
        [shape(pre(cPart, 2)), shape(pre(cPart, 3))].join(' / '));
    check('buildPreset: 0% deposit -> equal split from the first-payment date',
        shape(pre(c0pct, 2)) === '500000@2026-10-23 500000@2026-12-29' &&
        shape(pre(c0pct, 4)) === '250000@2026-10-23 250000@2026-11-14 250000@2026-12-07 250000@2026-12-29', shape(pre(c0pct, 4)));
    check('buildPreset: 100% deposit -> only the 1-payment preset exists',
        pre(c100, 1) !== null && pre(c100, 2) === null && pre(c100, 3) === null && pre(c100, 4) === null, '');
    check('buildPreset: total below the minimum (R400) -> only 1 payment',
        pre(tiny, 1) !== null && pre(tiny, 2) === null, shape(pre(tiny, 2)));
    const c1000 = ctxOf({ totalAmount: 1000 });
    check('buildPreset: R1,000 at 50% with a R500 minimum -> 1 or 2 payments, not 3 or 4',
        pre(c1000, 1) !== null && shape(pre(c1000, 2)) === '50000@2026-10-23 50000@2026-12-29' && pre(c1000, 3) === null && pre(c1000, 4) === null, '');
    check('buildPreset: event in 8 days -> 1 payment on event − 2, or a deposit pulled forward a day so the balance can land on event − 2',
        shape(pre(cE8, 1)) === '1000000@2026-10-22' && shape(pre(cE8, 2)) === '500000@2026-10-21 500000@2026-10-22',
        [shape(pre(cE8, 1)), shape(pre(cE8, 2))].join(' / '));
    const cE3 = ctxOf({ eventDate: '2026-10-19' });
    check('buildPreset: event in 3 days -> 1 payment due tomorrow (event − 2), or deposit today + balance tomorrow',
        shape(pre(cE3, 1)) === '1000000@2026-10-17' && shape(pre(cE3, 2)) === '500000@2026-10-16 500000@2026-10-17' && pre(cE3, 3) === null,
        [shape(pre(cE3, 1)), shape(pre(cE3, 2))].join(' / '));
    check('buildPreset: event tomorrow -> 1 payment due today', pre(cE1, 2) === null && shape(pre(cE1, 1)) === '1000000@2026-10-16', shape(pre(cE1, 1)));
    check('buildPreset: no event date -> balance on today + 30', shape(pre(cNoEvent, 2)) === '500000@2026-10-23 500000@2026-11-15', shape(pre(cNoEvent, 2)));
    const cSmallDep = ctxOf({ totalAmount: 1234, depositPercentage: 25 });
    check('buildPreset: a deposit floor below the minimum (R308.50 of R1,234 at 25%) -> the first payment is raised to the R500 minimum',
        shape(pre(cSmallDep, 2)) === '50000@2026-10-23 73400@2026-12-29' && pre(cSmallDep, 1) !== null &&
        R.validatePlan(cSmallDep, [p(500, '2026-10-23'), p(734, '2026-12-29')]).ok &&
        has(R.validatePlan(cSmallDep, [p(308.5, '2026-10-23'), p(925.5, '2026-12-29')]), /at least R 500\.00/), shape(pre(cSmallDep, 2)));
    const cOdd = ctxOf({ totalAmount: 1000.01, minPaymentAmount: 0 });
    check('buildPreset: odd cents — deposit floor rounded half-up, balance absorbs the rest, sum exact',
        shape(pre(cOdd, 2)) === '50001@2026-10-23 50000@2026-12-29', shape(pre(cOdd, 2)));
    check('buildPreset: equal split remainder goes on the last payment',
        shape(pre(ctxOf({ totalAmount: 100.01, depositPercentage: 0, minPaymentAmount: 0 }), 4)) === '2500@2026-10-23 2500@2026-11-14 2500@2026-12-07 2501@2026-12-29', '');

    // The 2-payment default must match lib/invoicing.js autoBuildDepositBalanceSchedule for normal events:
    // deposit = round2(remaining × pct / 100) on today + 7, balance = remaining − deposit on event − 2.
    const autoBuild2 = (total, pct, event) => {
        const deposit = Math.round((total * pct / 100) * 100) / 100;
        const balance = Math.round((total - deposit) * 100) / 100;
        return `${Math.round(deposit * 100)}@${R.addDays(TODAY, 7)} ${Math.round(balance * 100)}@${R.addDays(event, -2)}`;
    };
    const parity = [[2500, 50, EVENT], [10000, 30, EVENT], [4000, 25, '2027-03-15'], [7999.98, 40, '2026-11-30'], [1500, 33.5, '2026-10-26'], [3200, 60, EVENT]];
    const parityBad = parity.filter(([total, pct, event]) => shape(pre(ctxOf({ totalAmount: total, depositPercentage: pct, eventDate: event }), 2)) !== autoBuild2(total, pct, event));
    check('buildPreset(2): identical to the admin auto plan (autoBuildDepositBalanceSchedule) for normal events',
        parityBad.length === 0, parityBad.map(([t, pc, e]) => `${t}@${pc}%/${e}: ${shape(pre(ctxOf({ totalAmount: t, depositPercentage: pc, eventDate: e }), 2))} vs ${autoBuild2(t, pc, e)}`).join('; '));

    // Property: every preset that exists is valid, sums exactly, has strictly ascending dates; 1 payment always exists.
    const matrix = [];
    [0, 30, 50, 100].forEach(pct => [400, 1000, 2500, 10000, 123456.78].forEach(total =>
        ['2026-10-17', '2026-10-19', '2026-10-24', '2026-11-01', EVENT, null].forEach(eventDate =>
            [ctxOf({ totalAmount: total, depositPercentage: pct, eventDate }),
                ctxOf({ mode: 'change', totalAmount: total, depositPercentage: pct, eventDate, amountPaid: Math.min(400, total),
                    liveRows: [{ id: 1, due_date: '2026-10-01', expected_amount: Math.min(400, total), status: 'paid' },
                        { id: 2, due_date: '2026-10-30', expected_amount: total - Math.min(400, total) }] })]
                .forEach(ctx => matrix.push(ctx)))));
    const propBad = [];
    matrix.forEach(ctx => {
        if (ctx.remaining_cents > 0 && ctx.slots > 0 && !pre(ctx, 1)) propBad.push(`no 1-payment preset: ${J([ctx.total_cents, ctx.deposit_percentage, ctx.event_date])}`);
        [1, 2, 3, 4].forEach(n => {
            const rows = pre(ctx, n);
            if (!rows) return;
            const sum = rows.reduce((s, r) => s + r.amount_cents, 0);
            const asc = rows.every((r, i) => i === 0 || r.due_date > rows[i - 1].due_date);
            const res = R.validatePlan(ctx, rows.map(r => ({ amount: r.amount, due_date: r.due_date })));
            if (rows.length !== n || sum !== ctx.remaining_cents || !asc || !res.ok || !rows.every(r => Number.isInteger(r.amount_cents) && r.amount === r.amount_cents / 100)) {
                propBad.push(`${n}@${J([ctx.total_cents, ctx.deposit_percentage, ctx.event_date])}: ${shape(rows)} ${msgs(res)}`);
            }
        });
    });
    check(`buildPreset: across ${matrix.length} contexts every preset is valid, exact to the cent and strictly ascending; 1 payment always exists`,
        propBad.length === 0, propBad.slice(0, 5).join(' || '));

    // ══════════ labelPlan ══════════
    const lab = (ctx, rows) => R.labelPlan(ctx, rows);
    check('labelPlan: the classic pair keeps "50% Deposit" / "50% Balance" (golden PDFs and emails rely on it)',
        eq(lab(c0, pre(c0, 2)), ['50% Deposit', '50% Balance']), J(lab(c0, pre(c0, 2))));
    const c30 = ctxOf({ depositPercentage: 30 });
    check('labelPlan: 30% policy -> "30% Deposit" / "70% Balance"', eq(lab(c30, pre(c30, 2)), ['30% Deposit', '70% Balance']), J(lab(c30, pre(c30, 2))));
    const c335 = ctxOf({ depositPercentage: 33.5 });
    const c3333 = ctxOf({ depositPercentage: 33.33 });
    check('labelPlan: fractional percentages print like JS numbers and the balance is rounded to 2dp (33.5/66.5, 33.33/66.67)',
        eq(lab(c335, [{ amount_cents: 335000 }, { amount_cents: 665000 }]), ['33.5% Deposit', '66.5% Balance']) &&
        eq(lab(c3333, [{ amount_cents: 333300 }, { amount_cents: 666700 }]), ['33.33% Deposit', '66.67% Balance']),
        J([lab(c335, [{ amount_cents: 335000 }, { amount_cents: 665000 }]), lab(c3333, [{ amount_cents: 333300 }, { amount_cents: 666700 }])]));
    check('labelPlan: rows given as rands (no amount_cents) are recognised too', eq(lab(c0, [{ amount: 5000 }, { amount: '5000.00' }]), ['50% Deposit', '50% Balance']), '');
    check('labelPlan: two payments whose first is NOT exactly the floor get numbered labels',
        eq(lab(c0, [{ amount_cents: 600000 }, { amount_cents: 400000 }]), [`Deposit ${DASH} Payment 1 of 2`, `Final Payment ${DASH} Payment 2 of 2`]), '');
    check('labelPlan: 0% and 100% deposit never use the percentage pair',
        eq(lab(c0pct, pre(c0pct, 2)), [`Deposit ${DASH} Payment 1 of 2`, `Final Payment ${DASH} Payment 2 of 2`]) &&
        eq(lab(c100, [{ amount_cents: 1000000 }, { amount_cents: 0 }]), [`Deposit ${DASH} Payment 1 of 2`, `Final Payment ${DASH} Payment 2 of 2`]), J(lab(c0pct, pre(c0pct, 2))));
    check('labelPlan: a single payment with nothing paid is "Full Payment"', eq(lab(c0, pre(c0, 1)), ['Full Payment']), '');
    check('labelPlan: 3 and 4 payments -> Deposit / Payment k of N / Final Payment (en dash)',
        eq(lab(c0, pre(c0, 3)), [`Deposit ${DASH} Payment 1 of 3`, 'Payment 2 of 3', `Final Payment ${DASH} Payment 3 of 3`]) &&
        eq(lab(c0, pre(c0, 4)), [`Deposit ${DASH} Payment 1 of 4`, 'Payment 2 of 4', 'Payment 3 of 4', `Final Payment ${DASH} Payment 4 of 4`]) &&
        lab(c0, pre(c0, 3))[0].indexOf('\u2013') !== -1, J(lab(c0, pre(c0, 4))));
    check('labelPlan: numbering continues after paid payments (1 paid + 2 new = "Payment 2 of 3", "Final Payment – Payment 3 of 3")',
        eq(lab(cL, pre(cL, 2)), ['Payment 2 of 3', `Final Payment ${DASH} Payment 3 of 3`]), J(lab(cL, pre(cL, 2))));
    check('labelPlan: 1 paid + 1 new -> "Final Payment – Payment 2 of 2" (never "Full Payment")',
        eq(lab(cL, pre(cL, 1)), [`Final Payment ${DASH} Payment 2 of 2`]), J(lab(cL, pre(cL, 1))));
    check('labelPlan: 1 paid + 3 new -> Payment 2 of 4, Payment 3 of 4, Final Payment – Payment 4 of 4',
        eq(lab(cL, pre(cL, 3)), ['Payment 2 of 4', 'Payment 3 of 4', `Final Payment ${DASH} Payment 4 of 4`]), J(lab(cL, pre(cL, 3))));
    const c2locked = ctxOf({ mode: 'change', amountPaid: 6000, liveRows: [
        { id: 1, due_date: '2026-10-01', expected_amount: 5000, status: 'paid' }, { id: 2, due_date: '2026-10-10', expected_amount: 1000, status: 'paid' },
        { id: 3, due_date: '2026-12-01', expected_amount: 4000 }] });
    check('labelPlan: 2 paid + 2 new -> Payment 3 of 4, Final Payment – Payment 4 of 4',
        eq(lab(c2locked, [{ amount_cents: 200000 }, { amount_cents: 200000 }]), ['Payment 3 of 4', `Final Payment ${DASH} Payment 4 of 4`]), '');
    check('labelPlan: the cumulative-deposit plan (partly paid) is numbered, not "Deposit"',
        eq(lab(cPart, pre(cPart, 2)), ['Payment 2 of 3', `Final Payment ${DASH} Payment 3 of 3`]), J(lab(cPart, pre(cPart, 2))));
    check('labelPlan: one label per row, nothing for no rows', lab(c0, []).length === 0 && lab(c0, null).length === 0, '');

    // ══════════ isUnchangedPlan ══════════
    check('isUnchangedPlan: the current unpaid rows (any order, amounts as numbers or strings) are "unchanged"',
        R.isUnchangedPlan(cL, [p(5000, '2026-12-29')]) && R.isUnchangedPlan(cL, [p('5000.00', '2026-12-29')]) &&
        R.isUnchangedPlan(cMessy, [p(5000, '2026-12-29')]), '');
    check('isUnchangedPlan: a different date, amount or count is a change',
        !R.isUnchangedPlan(cL, [p(5000, '2026-12-28')]) && !R.isUnchangedPlan(cL, [p(4999.99, '2026-12-29')]) &&
        !R.isUnchangedPlan(cL, [p(2500, '2026-12-01'), p(2500, '2026-12-29')]) && !R.isUnchangedPlan(cL, []) && !R.isUnchangedPlan(cL, [p('x', '2026-12-29')]), '');
    const cTwo = ctxOf({ mode: 'change', liveRows: [{ id: 61, due_date: '2026-10-20', expected_amount: 5000 }, { id: 62, due_date: '2026-12-29', expected_amount: 5000 }] });
    check('isUnchangedPlan: multi-row plans compare by date and amount regardless of input order',
        R.isUnchangedPlan(cTwo, [p(5000, '2026-12-29'), p(5000, '2026-10-20')]) && !R.isUnchangedPlan(cTwo, [p(5000, '2026-12-29'), p(5000, '2026-10-21')]), '');
}
