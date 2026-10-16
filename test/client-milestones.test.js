// Client-designed payment plans, end to end through the real HTTP API: the client designs the plan
// while accepting a quote (accept-quote `milestones`), later rearranges the UNPAID milestones
// (POST /api/public/bookings/:id/payment-plan), and the admin can still take over (Setup
// Milestones). The rules themselves are unit-tested exhaustively in payment-plan-rules.test.js; this
// file proves the server enforces them, writes plans the way the design says (supersede + insert,
// server-generated labels, sequences that continue after paid rows, the sum invariant), refuses
// edits in the states it must, and fires the side effects (audit row, note, emails, invoice PDF).
//
// Conventions (see calendar.test.js's header on date offsets):
//   - event dates 1000-1049 for normal cases, plus the free short-notice offsets 4 and 5;
//   - SVC 15 ('Travel Buyout – Gauteng': flat fee, VAT-exempt, zero lead time) so totals are exact;
//   - "today" is the Africa/Johannesburg date, exactly as the server computes it — future() is a
//     UTC date and would be a day behind between 22:00 and 24:00 UTC, flaking every boundary check;
//   - /track sits behind trackRateLimiter (10 per 15 minutes for the WHOLE suite, never bypassed in
//     test mode), so it is called only twice; everything else is read straight from the test DB and
//     plan_version is rebuilt from the DB with the documented formula (ids|paid cents|total cents);
//   - the Booking Policies this file depends on are set explicitly and restored in `finally`;
//   - nothing throws: test/run.js has no per-file catch, so a surprise becomes one failed check.
const sqlite3 = require('sqlite3');
const moment = require('moment-timezone');

const SVC = 15;
const TZ = 'Africa/Johannesburg';
const DASH = '\u2013'; // en dash, as in the server-generated labels
const J = JSON.stringify;
let seq = 0;
const email = () => `plans.${Date.now()}.${seq++}@example.invalid`;

const todaySast = () => moment().tz(TZ).format('YYYY-MM-DD');
const addDays = (ymd, n) => moment.utc(ymd, 'YYYY-MM-DD').add(n, 'days').format('YYYY-MM-DD');
const cents = (x) => Math.round((parseFloat(x) || 0) * 100);

module.exports = async function (support) {
    const { check, api, one, TEST_DB } = support;
    const rw = new sqlite3.Database(TEST_DB);
    rw.configure('busyTimeout', 10000);

    const prevDeposit = await one("SELECT policy_value FROM policies WHERE policy_key='deposit_percentage'").catch(() => null);
    const prevMin = await one("SELECT policy_value FROM policies WHERE policy_key='min_installment_amount'").catch(() => null);
    try {
        const set = await api('PUT', '/api/admin/policies', { policies: { deposit_percentage: '50', min_installment_amount: '500' } });
        check('plans: fixture policies set (50% deposit, R500 minimum)', set.status === 200, `${set.status} ${J(set.body)}`);
        await runAll(support, rw);
    } catch (e) {
        check('plans: suite ran to completion without throwing', false, e && e.stack);
    } finally {
        await api('PUT', '/api/admin/policies', { policies: {
            deposit_percentage: (prevDeposit && prevDeposit.policy_value) || '50',
            min_installment_amount: (prevMin && prevMin.policy_value) || '500',
        } }).catch(() => {});
        await new Promise(res => rw.close(() => res()));
    }
};

async function runAll({ check, api, pub, one, q, future, sleep, getTrackingToken, apiBinary, extractPdfText }, rw) {
    const run = (sql, params = []) => new Promise((res, rej) => rw.run(sql, params, function (e) { e ? rej(e) : res(this); }));
    const T = todaySast();

    // ───────────────────────── helpers ─────────────────────────

    async function makeQuoted(label, offset, amount) {
        const em = email();
        const created = await api('POST', '/api/admin/bookings', {
            name: `Plans IT ${label}`, email: em, cell: '+27821234567', event_date: future(offset),
            event_name: `Plans ${label}`, event_type: 'Corporate', event_location: 'Test Hall',
            message: 'client-milestones.test.js integration booking, over ten characters.',
            services: [{ service_id: SVC }], status: 'NEW', override_working_hours: true,
        });
        const id = created.body && created.body.booking_id;
        if (!id) { check(`plans/${label}: fixture booking created`, false, `${created.status} ${J(created.body)}`); return null; }
        const bk = await one('SELECT date FROM bookings WHERE id=?', [id]);
        // The quote route wants an expiry >= 3 days out and before the event.
        const expiry = offset >= 14 ? addDays(bk.date, -10) : future(3);
        const quoted = await api('POST', `/api/admin/bookings/${id}/quote`, {
            quote_expiry_date: expiry, terms: 'T', apply_vat: false, discount: 0,
            items: [{ service_id: SVC, description: 'Travel Buyout – Gauteng', quantity: 1, unit_price: amount }],
        });
        if (quoted.status !== 200) { check(`plans/${label}: fixture quote issued`, false, `${quoted.status} ${J(quoted.body)}`); return null; }
        const token = await getTrackingToken(id, em);
        if (!token) { check(`plans/${label}: fixture tracking token issued`, false, 'getTrackingToken returned null'); return null; }
        return { id, em, token, date: bk.date, E2: addDays(bk.date, -2) };
    }

    const p = (amount, due_date) => ({ amount, due_date });
    const accept = (b, body) => pub('POST', `/api/public/bookings/${b.id}/accept-quote`,
        Object.assign({ access_token: b.token, terms_agreed: true }, body || {}));
    const changePlan = (b, body) => pub('POST', `/api/public/bookings/${b.id}/payment-plan`,
        Object.assign({ access_token: b.token }, body || {}));
    const LIVE = "LOWER(COALESCE(status,'pending')) NOT IN ('superseded','cancelled')";
    const liveRows = (id) => q(`SELECT id, description, due_date, expected_amount, status, sequence, source
        FROM payment_schedules WHERE booking_id=? AND ${LIVE} ORDER BY due_date ASC, id ASC`, [id]);
    const allRows = (id) => q('SELECT id, description, due_date, expected_amount, status, sequence, source FROM payment_schedules WHERE booking_id=? ORDER BY id', [id]);
    const brief = (rows) => J(rows.map(r => [r.id, r.description, String(r.due_date).slice(0, 10), r.expected_amount, r.status, r.sequence, r.source]));
    const errorsOf = (res) => J((res.body && res.body.errors) || (res.body && res.body.message) || res.body);
    const rejected = (res, re) => res.status === 400 && res.body && res.body.code === 'INVALID_PLAN'
        && Array.isArray(res.body.errors) && res.body.errors.some(e => re.test(e.message));

    // The documented optimistic-concurrency token, rebuilt from the DB: change mode plans against
    // total_amount (falling back to the quote), paid = bookings.amount_paid.
    async function planVersionOf(id) {
        const b = await one('SELECT amount_paid, total_amount, quote_amount FROM bookings WHERE id=?', [id]);
        const ids = (await liveRows(id)).map(r => r.id).sort((a, c) => a - c).join(',');
        return `${ids}|${cents(b.amount_paid)}|${cents(b.total_amount) || cents(b.quote_amount)}`;
    }

    async function waitFor(fn, ms = 6000, step = 150) {
        const end = Date.now() + ms;
        for (;;) {
            const v = await fn();
            if (v || Date.now() > end) return v;
            await sleep(step);
        }
    }

    async function queued(subject, to) {
        const row = await waitFor(() => to
            ? one("SELECT recipient_email, body FROM notifications WHERE type='email' AND subject = ? AND recipient_email = ? ORDER BY id DESC LIMIT 1", [subject, to])
            : one("SELECT recipient_email, body FROM notifications WHERE type='email' AND subject = ? ORDER BY id DESC LIMIT 1", [subject]), 5000);
        if (!row) return null;
        let details = {};
        try { details = JSON.parse(row.body || '{}'); } catch (e) {}
        return { to: row.recipient_email, html: details.htmlContent || '' };
    }

    // Manual payments settle row-level 'paid' flags only after processManualPayment's post-commit
    // chain (which first attempts a Google calendar sync that fails slowly on the test env's invalid
    // token), so poll for the flag instead of a fixed sleep.
    async function payTo(id, amountPaid, settledRowId) {
        const r = await api('PUT', `/api/admin/bookings/${id}/manual-payment`, { amount_paid: amountPaid });
        if (r.status !== 200) return r;
        if (settledRowId) {
            await waitFor(async () => {
                const row = await one('SELECT status FROM payment_schedules WHERE id=?', [settledRowId]);
                return row && row.status === 'paid';
            }, 10000, 250);
        }
        return r;
    }

    // ═══════════ 1. Accept mode: /track context, every rule enforced, nothing written ═══════════
    const R = await makeQuoted('rules', 1000, 4000);
    if (R) {
        const tr = await pub('POST', `/api/public/bookings/${R.id}/track`, { access_token: R.token });
        const plan = tr.body && tr.body.payment_plan;
        const ctx = plan && plan.context;
        check('plans: /track on a QUOTED booking -> payment_plan in accept mode, editable',
            tr.status === 200 && !!plan && plan.mode === 'accept' && plan.editable === true && plan.reason_code === null,
            `${tr.status} ${J(plan && { mode: plan.mode, editable: plan.editable, reason_code: plan.reason_code })}`);
        check('plans: /track accept context carries total, deposit floor, R500 minimum and 4 slots',
            !!ctx && ctx.total_cents === 400000 && ctx.remaining_cents === 400000 && ctx.deposit_floor_cents === 200000
                && ctx.min_payment_cents === 50000 && ctx.slots === 4 && ctx.locked_count === 0,
            J(ctx && { t: ctx.total_cents, r: ctx.remaining_cents, f: ctx.deposit_floor_cents, m: ctx.min_payment_cents, s: ctx.slots }));
        check('plans: /track accept context uses the SAST date window (first due by today + 7, last due event − 2)',
            !!ctx && ctx.today === T && ctx.earliest_due === T && ctx.first_due_by === addDays(T, 7) && ctx.latest_due === R.E2,
            J(ctx && { today: ctx.today, first: ctx.first_due_by, latest: ctx.latest_due, expected: [T, addDays(T, 7), R.E2] }));
        check('plans: /track plan_version = ids|paid|total, and deposit_percentage is still returned',
            !!plan && plan.plan_version === '|0|400000' && tr.body.deposit_percentage === 50,
            J({ v: plan && plan.plan_version, dp: tr.body && tr.body.deposit_percentage }));

        // Not editable through the change route while the quote is open.
        const early = await changePlan(R, { plan_version: '|0|400000', milestones: [p(4000, R.E2)] });
        check('plans: change route on a QUOTED booking -> 409 NOT_ACCEPTED', early.status === 409 && early.body && early.body.code === 'NOT_ACCEPTED',
            `${early.status} ${J(early.body)}`);

        // Shape checks (before any rule).
        const notArray = await accept(R, { milestones: 'two payments please' });
        check('plans: accept with non-array milestones -> 400 INVALID_PLAN', notArray.status === 400 && notArray.body.code === 'INVALID_PLAN', `${notArray.status} ${J(notArray.body)}`);
        const empty = await accept(R, { milestones: [] });
        check('plans: accept with an empty milestones array -> 400 INVALID_PLAN', empty.status === 400 && empty.body.code === 'INVALID_PLAN', `${empty.status} ${J(empty.body)}`);
        const eleven = await accept(R, { milestones: Array.from({ length: 11 }, (_, i) => p(100, addDays(T, i + 1))) });
        check('plans: accept with more than 10 milestones -> 400 INVALID_PLAN', eleven.status === 400 && eleven.body.code === 'INVALID_PLAN', `${eleven.status} ${J(eleven.body)}`);

        // One request per rule; each must be refused with a message naming the problem.
        const cases = [
            ['more than 4 payments', [p(800, addDays(T, 1)), p(800, addDays(T, 2)), p(800, addDays(T, 3)), p(800, addDays(T, 4)), p(800, addDays(T, 5))], /at most 4 payments/],
            ['an amount with 3 decimals', [p('2000.555', addDays(T, 3)), p(2000, R.E2)], /2 decimal places/],
            ['a negative amount', [p(-2000, addDays(T, 3)), p(6000, R.E2)], /negative/],
            ['an impossible calendar date', [p(4000, '2026-02-30')], /valid due date/],
            ['two payments on the same day', [p(2000, addDays(T, 3)), p(2000, addDays(T, 3))], /both due on/],
            ['a due date before today', [p(2000, addDays(T, -1)), p(2000, R.E2)], /on or after today/],
            ['a due date less than 2 days before the event', [p(2000, addDays(T, 3)), p(2000, addDays(R.date, -1))], /at least 2 days before your event/],
            ['payments that do not add up to the total', [p(2000, addDays(T, 3)), p(1000, R.E2)], /add up to R 3,000\.00, but R 4,000\.00/],
            ['a payment below the R500 minimum', [p('3500.01', addDays(T, 3)), p('499.99', R.E2)], /at least R 500\.00/],
            ['a first payment below the 50% deposit', [p('1999.99', addDays(T, 3)), p('2000.01', R.E2)], /at least R 2,000\.00 \(the 50% deposit\)/],
            ['a first payment more than 7 days after accepting', [p(2000, addDays(T, 8)), p(2000, R.E2)], /within 7 days of accepting/],
        ];
        for (const [what, milestones, re] of cases) {
            const res = await accept(R, { milestones });
            check(`plans: accept refuses ${what} (400 INVALID_PLAN)`, rejected(res, re), `${res.status} ${errorsOf(res)}`);
        }

        // Booking Policies: the minimum is validated, stored to the cent, and honoured by the rules.
        const neg = await api('PUT', '/api/admin/policies', { policies: { min_installment_amount: '-5' } });
        check('plans: policies refuse a negative minimum instalment (400)', neg.status === 400, `${neg.status} ${J(neg.body)}`);
        const nan = await api('PUT', '/api/admin/policies', { policies: { min_installment_amount: 'lots' } });
        check('plans: policies refuse a non-numeric minimum instalment (400)', nan.status === 400, `${nan.status} ${J(nan.body)}`);
        const rounded = await api('PUT', '/api/admin/policies', { policies: { min_installment_amount: '750.555' } });
        const storedMin = await one("SELECT policy_value FROM policies WHERE policy_key='min_installment_amount'");
        check('plans: policies store the minimum instalment rounded to cents', rounded.status === 200 && storedMin && storedMin.policy_value === '750.56',
            `${rounded.status} ${J(storedMin)}`);
        await api('PUT', '/api/admin/policies', { policies: { min_installment_amount: '1000' } });
        try {
            const res = await accept(R, { milestones: [p(3400, addDays(T, 3)), p(600, R.E2)] });
            check('plans: a raised minimum instalment policy is enforced at acceptance', rejected(res, /at least R 1,000\.00/), `${res.status} ${errorsOf(res)}`);
        } finally {
            await api('PUT', '/api/admin/policies', { policies: { min_installment_amount: '500' } });
        }

        // Every refusal rolled the acceptance back: still QUOTED, no milestones, no invoice.
        const still = await one('SELECT status, accepted_at FROM bookings WHERE id=?', [R.id]);
        const nRows = await one('SELECT COUNT(*) AS n FROM payment_schedules WHERE booking_id=?', [R.id]);
        const nInv = await one('SELECT COUNT(*) AS n FROM invoices WHERE booking_id=?', [R.id]);
        const nAcc = await one("SELECT COUNT(*) AS n FROM audit_log WHERE table_name='bookings' AND record_id=? AND action='QUOTE_ACCEPTED'", [R.id]);
        check('plans: after every refused plan the booking is still QUOTED with no milestones, invoice or acceptance',
            still.status === 'QUOTED' && !still.accepted_at && nRows.n === 0 && nInv.n === 0 && nAcc.n === 0,
            J({ still, rows: nRows.n, invoices: nInv.n, accepted: nAcc.n }));

        // The standard deposit/balance plan, on both date boundaries, sent out of order.
        const ok = await accept(R, { milestones: [p(2000, R.E2), p('2000.00', addDays(T, 7))] });
        check('plans: accept with a custom 2-payment plan on the date boundaries -> 200', ok.status === 200 && ok.body.success === true, `${ok.status} ${J(ok.body)}`);
        const rows = await liveRows(R.id);
        check('plans: 2-payment plan written in due-date order with sequences 1/2, source client',
            rows.length === 2 && rows[0].due_date === addDays(T, 7) && rows[1].due_date === R.E2
                && rows.every((r, i) => r.sequence === i + 1 && r.source === 'client' && r.status === 'pending')
                && cents(rows[0].expected_amount) === 200000 && cents(rows[1].expected_amount) === 200000,
            brief(rows));
        check('plans: a 2-payment plan with the deposit floor first keeps the standard labels',
            rows.length === 2 && rows[0].description === '50% Deposit' && rows[1].description === '50% Balance', brief(rows));
        const acc = await one('SELECT status FROM bookings WHERE id=?', [R.id]);
        const inv = await one("SELECT COUNT(*) AS n FROM invoices WHERE booking_id=? AND UPPER(status) <> 'VOID'", [R.id]);
        check('plans: accepted booking is ACCEPTED and its invoice was generated', acc.status === 'ACCEPTED' && inv.n === 1, J({ acc, inv }));
        const adminMail = await queued(`Invoice Issued – Booking #${R.id} Awaiting Payment`);
        check('plans: admin acceptance email lists the client-designed payment plan',
            !!adminMail && /Payment plan – Client-designed/.test(adminMail.html) && adminMail.html.includes('50% Deposit') && adminMail.html.includes('R 2,000.00'),
            adminMail ? 'card or rows missing' : 'not queued');
    }

    // ═══════════ 2. Custom 3- and 4-payment plans, and a total below the minimum ═══════════
    const B3 = await makeQuoted('three', 1003, 6000);
    if (B3) {
        const res = await accept(B3, { milestones: [p(1500, addDays(T, 30)), p(1500, B3.E2), p(3000, T)] });
        check('plans: accept with a custom 3-payment plan (deposit due today) -> 200', res.status === 200, `${res.status} ${J(res.body)}`);
        const rows = await liveRows(B3.id);
        check('plans: 3-payment plan sorted by date, amounts kept, sequences 1-3',
            rows.length === 3 && J(rows.map(r => cents(r.expected_amount))) === J([300000, 150000, 150000])
                && J(rows.map(r => r.due_date)) === J([T, addDays(T, 30), B3.E2]) && rows.every((r, i) => r.sequence === i + 1),
            brief(rows));
        check('plans: 3-payment plan labels are server-generated',
            J(rows.map(r => r.description)) === J([`Deposit ${DASH} Payment 1 of 3`, 'Payment 2 of 3', `Final Payment ${DASH} Payment 3 of 3`]),
            brief(rows));
    }

    const B4 = await makeQuoted('four', 1006, 8000);
    if (B4) {
        const res = await accept(B4, { milestones: [p(4000, addDays(T, 7)), p('2000.50', addDays(T, 20)), p(1499.5, addDays(T, 40)), p(500, B4.E2)] });
        check('plans: accept with a custom 4-payment plan (cents, last payment exactly the minimum) -> 200', res.status === 200, `${res.status} ${J(res.body)}`);
        const rows = await liveRows(B4.id);
        const sum = rows.reduce((s, r) => s + cents(r.expected_amount), 0);
        check('plans: 4-payment plan stored to the cent and sums to the total',
            rows.length === 4 && J(rows.map(r => cents(r.expected_amount))) === J([400000, 200050, 149950, 50000]) && sum === 800000,
            `${brief(rows)} sum=${sum}`);
        check('plans: 4-payment plan labels and sequences',
            J(rows.map(r => r.description)) === J([`Deposit ${DASH} Payment 1 of 4`, 'Payment 2 of 4', 'Payment 3 of 4', `Final Payment ${DASH} Payment 4 of 4`])
                && rows.every((r, i) => r.sequence === i + 1 && r.source === 'client'),
            brief(rows));
    }

    const S = await makeQuoted('small', 1009, 800);
    if (S) {
        const split = await accept(S, { milestones: [p(400, addDays(T, 3)), p(400, S.E2)] });
        check('plans: a total below the minimum cannot be split', rejected(split, /at least R 500\.00/), `${split.status} ${errorsOf(split)}`);
        const single = await accept(S, { milestones: [p('800', addDays(T, 3))] });
        const rows = await liveRows(S.id);
        check('plans: ... but a single payment of the whole total is accepted (minimum exempt)',
            single.status === 200 && rows.length === 1 && rows[0].description === 'Full Payment' && cents(rows[0].expected_amount) === 80000,
            `${single.status} ${J(single.body)} ${brief(rows)}`);
    }

    // A plan our team prepared before acceptance is replaced when the client sends their own.
    const A2 = await makeQuoted('replace', 1021, 4000);
    if (A2) {
        const pre = await api('POST', `/api/admin/bookings/${A2.id}/payment-schedules`, { schedules: [
            { description: 'Team deposit', due_date: addDays(T, 2), expected_amount: 2000 },
            { description: 'Team balance', due_date: addDays(A2.date, -5), expected_amount: 2000 },
        ] });
        const preRows = await liveRows(A2.id);
        const res = await accept(A2, { milestones: [p(2500, addDays(T, 2)), p(1500, A2.E2)] });
        const rows = await liveRows(A2.id);
        const old = await q(`SELECT status FROM payment_schedules WHERE id IN (${preRows.map(() => '?').join(',') || 'NULL'})`, preRows.map(r => r.id));
        check('plans: accept with milestones replaces a pre-built admin plan (old rows superseded, new client rows)',
            pre.status === 200 && preRows.length === 2 && res.status === 200 && old.length === 2 && old.every(r => r.status === 'superseded')
                && rows.length === 2 && rows.every((r, i) => r.source === 'client' && r.sequence === i + 1)
                && J(rows.map(r => r.description)) === J([`Deposit ${DASH} Payment 1 of 2`, `Final Payment ${DASH} Payment 2 of 2`])
                && J(rows.map(r => cents(r.expected_amount))) === J([250000, 150000]),
            `${pre.status} ${res.status} ${J(res.body)} old=${J(old)} new=${brief(rows)}`);
    }

    // ═══════════ 3. Short-notice events ═══════════
    // Event in 4 days: event − 2 is only two days away, so the old tab's default 2-payment plan pulls
    // the deposit forward one day (it would otherwise land on the same day as the balance) instead of
    // building out-of-order or same-day dates.
    const N4 = await makeQuoted('short4', 4, 2000);
    if (N4) {
        const res = await accept(N4, { installment_count: 2 });
        const rows = await liveRows(N4.id);
        check('plans: short-notice accept without milestones -> 200 with a deposit the day before event − 2 and the balance on event − 2',
            res.status === 200 && rows.length === 2
                && J(rows.map(r => r.description)) === J(['50% Deposit', '50% Balance'])
                && J(rows.map(r => cents(r.expected_amount))) === J([100000, 100000])
                && rows[0].due_date === addDays(N4.E2, -1) && rows[1].due_date === N4.E2
                && rows.every(r => r.source === 'client'),
            `${res.status} ${brief(rows)}`);
        check('plans: ... due inside the window (today .. event − 2), strictly ascending',
            rows.length === 2 && rows[0].due_date >= T && rows[0].due_date < rows[1].due_date && rows[1].due_date <= N4.E2,
            `today=${T} last=${N4.E2} rows=${brief(rows)}`);
    }
    const N5 = await makeQuoted('short5', 5, 2000);
    if (N5) {
        const late = await accept(N5, { milestones: [p(1000, T), p(1000, addDays(N5.date, -1))] });
        check('plans: short-notice plan with a payment the day before the event is refused', rejected(late, /at least 2 days before your event/), `${late.status} ${errorsOf(late)}`);
        const ok = await accept(N5, { milestones: [p(1000, T), p(1000, N5.E2)] });
        const rows = await liveRows(N5.id);
        check('plans: short-notice 2-payment plan (today, event − 2) -> 200',
            ok.status === 200 && rows.length === 2 && rows[0].due_date === T && rows[1].due_date === N5.E2, `${ok.status} ${J(ok.body)} ${brief(rows)}`);
    }

    // ═══════════ 4. Admin pre-built plan kept, first instalment paid, client rearranges the rest ═══════════
    const D = await makeQuoted('change', 1012, 6000);
    if (D) {
        const pre = await api('POST', `/api/admin/bookings/${D.id}/payment-schedules`, { schedules: [
            { description: 'Admin deposit', due_date: addDays(T, 3), expected_amount: 3000 },
            { description: 'Admin balance', due_date: addDays(D.date, -10), expected_amount: 3000 },
        ] });
        check('plans: admin pre-builds a plan on the quoted booking -> 200', pre.status === 200, `${pre.status} ${J(pre.body)}`);
        const preRows = await liveRows(D.id);

        const acc = await accept(D, {});
        const keptRows = await liveRows(D.id);
        check('plans: accept without milestones keeps the admin pre-built plan untouched',
            acc.status === 200 && J(keptRows.map(r => [r.id, r.source])) === J(preRows.map(r => [r.id, 'admin'])) && keptRows.length === 2,
            `${acc.status} before=${brief(preRows)} after=${brief(keptRows)}`);

        const [paidRow, oldUnpaid] = keptRows;
        if (!paidRow || !oldUnpaid) {
            check('plans: change scenario has its two admin rows to work with', false, brief(keptRows));
        } else {
            const pay1 = await payTo(D.id, 3000, paidRow.id);
            const afterPay = await one('SELECT status FROM payment_schedules WHERE id=?', [paidRow.id]);
            check('plans: first instalment paid (manual payment) and its row marked paid', pay1.status === 200 && afterPay && afterPay.status === 'paid',
                `${pay1.status} ${J(afterPay)}`);

            // /track (call 2 of 2): change mode, editable, locked flags from money.
            const tr = await pub('POST', `/api/public/bookings/${D.id}/track`, { access_token: D.token });
            const plan = tr.body && tr.body.payment_plan;
            const ctx = plan && plan.context;
            const v1 = await planVersionOf(D.id);
            check('plans: /track after a payment -> change mode, editable, plan_version matches ids|paid|total',
                tr.status === 200 && !!plan && plan.mode === 'change' && plan.editable === true && plan.plan_version === v1,
                `${tr.status} ${J(plan && { mode: plan.mode, editable: plan.editable, reason: plan.reason_code, v: plan.plan_version })} expected v=${v1}`);
            check('plans: /track change context: 1 locked row, 3 slots left, deposit covered, earliest due = paid row\'s date',
                !!ctx && ctx.locked_count === 1 && J(ctx.locked_ids) === J([paidRow.id]) && ctx.slots === 3 && ctx.require_deposit === false
                    && ctx.require_first_by === false && ctx.remaining_cents === 300000 && ctx.earliest_due === addDays(T, 3) && ctx.sequence_base === 1,
                J(ctx && { lc: ctx.locked_count, ids: ctx.locked_ids, s: ctx.slots, rd: ctx.require_deposit, rf: ctx.require_first_by, rem: ctx.remaining_cents, ed: ctx.earliest_due, sb: ctx.sequence_base }));
            const sched = (tr.body && tr.body.payment_schedule) || [];
            check('plans: /track schedule rows carry source and money-based locked flags',
                sched.length === 2 && sched[0].id === paidRow.id && sched[0].locked === true && sched[0].source === 'admin'
                    && sched[1].locked === false && sched[1].source === 'admin',
                J(sched.map(s => ({ id: s.id, locked: s.locked, source: s.source }))));

            // Change-mode refusals: the paid milestone can't be re-planned or undercut.
            const withPaid = await changePlan(D, { plan_version: v1, milestones: [p(6000, D.E2)] });
            check('plans: change that re-schedules the paid amount is refused (only the R3,000 balance is open)',
                rejected(withPaid, /add up to R 6,000\.00, but R 3,000\.00/), `${withPaid.status} ${errorsOf(withPaid)}`);
            const beforePaid = await changePlan(D, { plan_version: v1, milestones: [p(1500, addDays(T, 1)), p(1500, D.E2)] });
            check('plans: change with a date before the paid milestone\'s due date is refused',
                rejected(beforePaid, /last paid payment/), `${beforePaid.status} ${errorsOf(beforePaid)}`);
            const tooMany = await changePlan(D, { plan_version: v1, milestones: [p(750, addDays(T, 10)), p(750, addDays(T, 20)), p(750, addDays(T, 30)), p(750, D.E2)] });
            check('plans: change with 4 more payments after 1 paid is refused (4 in total)',
                rejected(tooMany, /up to 3 more/), `${tooMany.status} ${errorsOf(tooMany)}`);
            const unchangedYet = await allRows(D.id);
            check('plans: refused changes wrote nothing',
                unchangedYet.length === 2 && J(unchangedYet.map(r => r.id)) === J(keptRows.map(r => r.id)) && unchangedYet.every(r => r.status !== 'superseded'),
                brief(unchangedYet));

            const invBefore = await one("SELECT id, invoice_number, file_path, status FROM invoices WHERE booking_id=? AND UPPER(COALESCE(status,'')) NOT IN ('VOID','PAID') ORDER BY created_at DESC, id DESC LIMIT 1", [D.id]);
            const invCountBefore = await one('SELECT COUNT(*) AS n FROM invoices WHERE booking_id=?', [D.id]);
            // The re-rendered PDF must keep the date the invoice was issued with. Pretend it was issued
            // at 22:30 UTC three days ago — 00:30 SAST two days ago — with the UTC invoice_date the DB
            // stores for that moment: the PDF must print the SAST date of created_at, not today's date
            // and not invoice_date (a day early).
            const issuedUtcDay = addDays(T, -3);
            const issuedDocDate = moment.utc(addDays(T, -2), 'YYYY-MM-DD').format('DD MMM YYYY');
            if (invBefore) await run('UPDATE invoices SET created_at = ?, invoice_date = ? WHERE id = ?', [`${issuedUtcDay} 22:30:00`, issuedUtcDay, invBefore.id]);
            const contractBefore = await one('SELECT status, uploaded_by, is_frozen, signed_by_client_at FROM contracts WHERE booking_id=?', [D.id]);

            const newPlan = [p(1000, addDays(D.date, -3)), p(1000, addDays(T, 10)), p(1000, addDays(T, 50))];
            const ch = await changePlan(D, { plan_version: v1, milestones: newPlan });
            check('plans: client rearranges the unpaid balance -> 200', ch.status === 200 && ch.body && ch.body.success === true && !ch.body.unchanged,
                `${ch.status} ${J(ch.body)}`);
            const live = await liveRows(D.id);
            const newRows = live.filter(r => r.id !== paidRow.id);
            check('plans: the paid milestone is untouched (same row, still paid, still admin)',
                live.length === 4 && live[0].id === paidRow.id && live[0].status === 'paid' && live[0].source === 'admin' && live[0].description === 'Admin deposit',
                brief(live));
            const old = await one('SELECT status FROM payment_schedules WHERE id=?', [oldUnpaid.id]);
            check('plans: the replaced unpaid milestone is superseded, not deleted', !!old && old.status === 'superseded', J(old));
            check('plans: new milestones: source client, sequences continue after the paid row (2,3,4), labels count the paid row',
                newRows.length === 3 && J(newRows.map(r => r.sequence)) === J([2, 3, 4]) && newRows.every(r => r.source === 'client' && r.status === 'pending')
                    && J(newRows.map(r => r.description)) === J(['Payment 2 of 4', 'Payment 3 of 4', `Final Payment ${DASH} Payment 4 of 4`])
                    && J(newRows.map(r => r.due_date)) === J([addDays(T, 10), addDays(T, 50), addDays(D.date, -3)]),
                brief(live));
            const liveSum = live.reduce((s, r) => s + cents(r.expected_amount), 0);
            const seqOrder = live.slice().sort((a, c) => a.sequence - c.sequence).map(r => r.id);
            check('plans: live milestones still sum to the total, and sequence order equals due-date order',
                liveSum === 600000 && J(seqOrder) === J(live.map(r => r.id)), `sum=${liveSum} ${brief(live)}`);

            const resp = ch.body || {};
            const v2 = await planVersionOf(D.id);
            check('plans: change response carries the fresh schedule and plan (same shape as /track)',
                Array.isArray(resp.payment_schedule) && resp.payment_schedule.length === 4 && resp.payment_schedule[0].locked === true
                    && resp.payment_schedule.slice(1).every(s => s.locked === false && s.source === 'client')
                    && !!resp.payment_plan && resp.payment_plan.mode === 'change' && resp.payment_plan.editable === true
                    && resp.payment_plan.plan_version === v2 && v2 !== v1 && !!resp.payment_plan.context,
                J({ sched: resp.payment_schedule && resp.payment_schedule.length, plan: resp.payment_plan && { v: resp.payment_plan.plan_version, e: resp.payment_plan.editable }, v2 }));

            const bk = await one('SELECT payment_plan_changed_at, modified_by, modified_by_role FROM bookings WHERE id=?', [D.id]);
            check('plans: booking stamped payment_plan_changed_at and attributed to the client',
                !!bk.payment_plan_changed_at && bk.modified_by_role === 'client' && bk.modified_by === null, J(bk));
            const audit = await one("SELECT changed_by, user_email, actor_role, old_values, new_values FROM audit_log WHERE table_name='bookings' AND record_id=? AND action='CLIENT_PAYMENT_PLAN_CHANGED' ORDER BY id DESC LIMIT 1", [D.id]);
            let oldV = {}, newV = {};
            try { oldV = JSON.parse((audit && audit.old_values) || '{}'); newV = JSON.parse((audit && audit.new_values) || '{}'); } catch (e) {}
            check('plans: audit row CLIENT_PAYMENT_PLAN_CHANGED by the client with flat before/after values',
                !!audit && audit.changed_by === D.em && audit.user_email === D.em && audit.actor_role === 'client'
                    && /\(paid\)$/.test(oldV['Admin deposit'] || '') && /^R 3,000\.00 due /.test(oldV['Admin balance'] || '')
                    && /^R 1,000\.00 due /.test(newV['Payment 2 of 4'] || '') && !('Admin balance' in newV),
                J(audit));
            const note = await one("SELECT note, author FROM booking_notes WHERE booking_id=? AND note LIKE '[Payment Plan Changed]%' ORDER BY id DESC LIMIT 1", [D.id]);
            check('plans: booking note records the change', !!note && note.author === 'Client' && note.note.includes('Payment 3 of 4'), J(note));

            const invAfter = invBefore ? await one('SELECT invoice_number, file_path, status FROM invoices WHERE id=?', [invBefore.id]) : null;
            const invCountAfter = await one('SELECT COUNT(*) AS n FROM invoices WHERE booking_id=?', [D.id]);
            check('plans: the live invoice PDF is re-rendered in place (same number and status, new file, no new invoice)',
                !!invBefore && !!invAfter && invAfter.invoice_number === invBefore.invoice_number && invAfter.status === invBefore.status
                    && invAfter.file_path !== invBefore.file_path && invCountAfter.n === invCountBefore.n,
                J({ invBefore, invAfter, before: invCountBefore.n, after: invCountAfter.n }));
            const invPdf = await apiBinary('GET', `/api/admin/bookings/${D.id}/invoice/download`);
            const invText = invPdf.status === 200 ? extractPdfText(invPdf.buffer) : '';
            const docDate = invText.match(/DOC DATE:?\s*(\d{1,2} [A-Z][a-z]{2} \d{4})/);
            check('plans: the re-rendered invoice PDF keeps its issue date (DOC DATE) and number, not today\'s date',
                !!invBefore && !!docDate && docDate[1] === issuedDocDate && invText.includes(invBefore.invoice_number),
                J({ status: invPdf.status, docDate: docDate && docDate[1], expected: issuedDocDate, number: !!invBefore && invText.includes(invBefore.invoice_number) }));

            const adminMail = await queued(`Payment Plan Changed – Booking #${D.id}`);
            check('plans: admin "Payment Plan Changed" email queued with the previous and new plan',
                !!adminMail && adminMail.html.includes('Applied immediately') && adminMail.html.includes('Admin balance') && adminMail.html.includes('Payment 2 of 4'),
                adminMail ? 'content missing' : 'not queued');
            if (adminMail) {
                const draftBySystem = contractBefore && String(contractBefore.status).toLowerCase() === 'draft' && contractBefore.uploaded_by === 'system';
                check('plans: admin email reports the invoice refresh and the contract outcome',
                    adminMail.html.includes('invoice PDF now shows the new schedule')
                        && (draftBySystem ? adminMail.html.includes('draft contract was regenerated') : /contract/i.test(adminMail.html)),
                    J({ contractBefore }));
            }
            const clientMail = await queued(`Your Payment Plan Has Been Updated – Booking #${D.id}`, D.em);
            check('plans: client "Your Payment Plan Has Been Updated" email queued with the new schedule',
                !!clientMail && clientMail.html.includes('Payment 3 of 4') && clientMail.html.includes('R 1,000.00'), clientMail ? 'content missing' : 'not queued');

            // Optimistic concurrency: the version the client designed against is now stale.
            const rowsBeforeStale = (await allRows(D.id)).length;
            const stale = await changePlan(D, { plan_version: v1, milestones: [p(1500, addDays(T, 12)), p(1500, D.E2)] });
            check('plans: a stale plan_version -> 409 PLAN_CHANGED', stale.status === 409 && stale.body && stale.body.code === 'PLAN_CHANGED', `${stale.status} ${J(stale.body)}`);
            const missing = await changePlan(D, { milestones: [p(1500, addDays(T, 12)), p(1500, D.E2)] });
            check('plans: a missing plan_version -> 409 PLAN_CHANGED', missing.status === 409 && missing.body && missing.body.code === 'PLAN_CHANGED', `${missing.status} ${J(missing.body)}`);

            // Saving the plan exactly as it is: 200, no new rows, no second audit row.
            const same = await changePlan(D, { plan_version: v2, milestones: [p('1000.00', addDays(T, 50)), p(1000, addDays(T, 10)), p(1000, addDays(D.date, -3))] });
            const rowsAfterSame = (await allRows(D.id)).length;
            const nAudit = await one("SELECT COUNT(*) AS n FROM audit_log WHERE record_id=? AND action='CLIENT_PAYMENT_PLAN_CHANGED'", [D.id]);
            check('plans: re-saving the current plan -> 200 unchanged, nothing written',
                same.status === 200 && same.body && same.body.unchanged === true && rowsAfterSame === rowsBeforeStale && nAudit.n === 1,
                `${same.status} ${J(same.body && { unchanged: same.body.unchanged })} rows ${rowsBeforeStale}->${rowsAfterSame} audits=${nAudit.n}`);

            // Admin Setup Milestones: the "client plan" guard fires on ANY client row (the first row by
            // due date here is the paid admin deposit).
            const guard = await api('POST', `/api/admin/bookings/${D.id}/payment-schedules`, { schedules: [
                { description: 'Admin A', due_date: addDays(T, 3), expected_amount: 3000 },
                { description: 'Admin B', due_date: addDays(D.date, -3), expected_amount: 3000 },
            ] });
            check('plans: admin Setup Milestones over a client plan without override -> 409 requires_override',
                guard.status === 409 && guard.body && guard.body.requires_override === true, `${guard.status} ${J(guard.body)}`);
            const adminGet = await api('GET', `/api/admin/bookings/${D.id}/payment-schedules`);
            check('plans: admin GET payment-schedules returns payment_plan_changed_at and row sources',
                adminGet.status === 200 && !!adminGet.body.payment_plan_changed_at && (adminGet.body.schedules || []).some(s => s.source === 'client'),
                J(adminGet.body && { at: adminGet.body.payment_plan_changed_at, n: (adminGet.body.schedules || []).length }));

            // The next payment lands on the first new milestone; the paid row is never "un-paid".
            const second = newRows[0];
            const pay2 = second ? await payTo(D.id, 4000, second.id) : { status: 0 };
            const afterPay2 = await liveRows(D.id);
            check('plans: paying the next instalment marks the first new milestone paid and keeps the old one paid',
                pay2.status === 200 && afterPay2.length === 4 && afterPay2[0].status === 'paid' && afterPay2[1].id === (second && second.id)
                    && afterPay2[1].status === 'paid' && afterPay2[2].status !== 'paid' && afterPay2[3].status !== 'paid',
                `${pay2.status} ${brief(afterPay2)}`);

            // FK case: a reminder was logged against a live client milestone. The admin override must
            // supersede (not DELETE) it — the old hard delete failed on reminders_log's foreign key.
            const reminded = afterPay2[2];
            let reminderId = null;
            if (reminded) {
                const ins = await run(`INSERT INTO reminders_log (booking_id, schedule_id, days_before, due_date, amount_due, recipient_email)
                    VALUES (?, ?, 7, ?, ?, ?)`, [D.id, reminded.id, reminded.due_date, reminded.expected_amount, D.em]);
                reminderId = ins.lastID;
            }
            const override = await api('POST', `/api/admin/bookings/${D.id}/payment-schedules`, { acknowledge_override: true, schedules: [
                { description: 'Admin deposit', due_date: addDays(T, 3), expected_amount: 3000 },
                { description: 'Admin second', due_date: addDays(T, 10), expected_amount: 1000 },
                { description: 'Admin balance', due_date: addDays(D.date, -3), expected_amount: 2000 },
            ] });
            check('plans: admin Setup Milestones with override after reminders were sent -> 200 (no FK failure)',
                override.status === 200 && override.body && override.body.success === true, `${override.status} ${J(override.body)}`);
            const adminLive = await liveRows(D.id);
            const remindedNow = reminded ? await one('SELECT status FROM payment_schedules WHERE id=?', [reminded.id]) : null;
            const reminderNow = reminderId ? await one('SELECT id FROM reminders_log WHERE id=?', [reminderId]) : null;
            check('plans: admin override superseded the client rows and kept the reminder history',
                !!remindedNow && remindedNow.status === 'superseded' && !!reminderNow, J({ remindedNow, reminderNow }));
            check('plans: admin plan is live: 3 admin rows, sum = total, already-paid money re-applied to the first two',
                adminLive.length === 3 && adminLive.every(r => r.source === 'admin')
                    && adminLive.reduce((s, r) => s + cents(r.expected_amount), 0) === 600000
                    && adminLive[0].status === 'paid' && adminLive[1].status === 'paid' && adminLive[2].status !== 'paid',
                brief(adminLive));
        }
    }

    // ═══════════ 5. Partial credit inside a milestone -> NEEDS_ADMIN ═══════════
    const C = await makeQuoted('credit', 1015, 4000);
    if (C) {
        const acc = await accept(C, {});
        const rows = await liveRows(C.id);
        check('plans: accept without milestones builds the default 2-payment client plan',
            acc.status === 200 && rows.length === 2 && rows[0].description === '50% Deposit' && rows[1].description === '50% Balance'
                && rows.every(r => r.source === 'client') && cents(rows[0].expected_amount) === 200000,
            `${acc.status} ${brief(rows)}`);
        const paid = rows[0] ? await payTo(C.id, 2500, rows[0].id) : { status: 0 };
        const res = await changePlan(C, { plan_version: await planVersionOf(C.id), milestones: [p(1500, addDays(T, 20)), p(500, C.E2)] });
        check('plans: R500 paid towards the second milestone -> 409 NEEDS_ADMIN',
            paid.status === 200 && res.status === 409 && res.body && res.body.code === 'NEEDS_ADMIN' && /reconciled/.test(res.body.message || ''),
            `${paid.status} ${res.status} ${J(res.body)}`);
        const after = await liveRows(C.id);
        check('plans: ... and nothing was changed', J(after.map(r => r.id)) === J(rows.map(r => r.id)), brief(after));
    }

    // ═══════════ 6. Payment in progress, token checks, cancelled booking ═══════════
    const P = await makeQuoted('inflight', 1018, 4000);
    if (P) {
        await accept(P, {});
        const rows = await liveRows(P.id);
        const payRes = rows[0] ? await pub('POST', `/api/public/bookings/${P.id}/pay`, { access_token: P.token, schedule_id: rows[0].id }) : { status: 0 };
        const intent = await waitFor(() => one("SELECT id FROM payfast_payment_intents WHERE booking_id=? AND status='pending'", [P.id]), 3000);
        check('plans: starting a PayFast payment records a pending intent', payRes.status === 200 && !!intent, `${payRes.status} ${J(payRes.body)}`);

        const plan = [p(2000, addDays(T, 5)), p(1000, addDays(T, 20)), p(1000, P.E2)];
        const blocked = await changePlan(P, { plan_version: await planVersionOf(P.id), milestones: plan });
        check('plans: a payment started under an hour ago -> 409 PAYMENT_IN_PROGRESS',
            blocked.status === 409 && blocked.body && blocked.body.code === 'PAYMENT_IN_PROGRESS', `${blocked.status} ${J(blocked.body)}`);

        const noToken = await pub('POST', `/api/public/bookings/${P.id}/payment-plan`, { plan_version: 'x', milestones: plan });
        check('plans: change without an access token -> 401 TOKEN_REQUIRED', noToken.status === 401 && noToken.body && noToken.body.code === 'TOKEN_REQUIRED',
            `${noToken.status} ${J(noToken.body)}`);
        const otherToken = (R || D) ? await changePlan(P, { access_token: (R || D).token, plan_version: 'x', milestones: plan }) : null;
        check('plans: change with another booking\'s access token -> 401', !!otherToken && otherToken.status === 401, otherToken && `${otherToken.status} ${J(otherToken.body)}`);

        // Once the intent is older than the hour, the plan can change again (nothing paid yet, so
        // the first-payment rules are back: the deposit floor, due within 7 days of acceptance).
        await run("UPDATE payfast_payment_intents SET created_at = datetime('now','-2 hours') WHERE booking_id=?", [P.id]);
        const late = await changePlan(P, { plan_version: await planVersionOf(P.id), milestones: [p(2000, addDays(T, 9)), p(2000, P.E2)] });
        check('plans: change mode still holds the first payment to 7 days after the original acceptance',
            rejected(late, /within 7 days of accepting/), `${late.status} ${errorsOf(late)}`);
        const ok = await changePlan(P, { plan_version: await planVersionOf(P.id), milestones: plan });
        const live = await liveRows(P.id);
        check('plans: after the payment window passes the change goes through (3 payments, fresh sequences and labels)',
            ok.status === 200 && live.length === 3 && J(live.map(r => r.sequence)) === J([1, 2, 3])
                && J(live.map(r => r.description)) === J([`Deposit ${DASH} Payment 1 of 3`, 'Payment 2 of 3', `Final Payment ${DASH} Payment 3 of 3`]),
            `${ok.status} ${J(ok.body && ok.body.message)} ${brief(live)}`);

        const cancel = await api('PUT', `/api/admin/bookings/${P.id}/status`, { status: 'CANCELLED' });
        const st = await one('SELECT status FROM bookings WHERE id=?', [P.id]);
        const res = await changePlan(P, { plan_version: await planVersionOf(P.id), milestones: plan });
        check('plans: change on a CANCELLED booking -> 409 NOT_ACCEPTED',
            st.status === 'CANCELLED' && res.status === 409 && res.body && res.body.code === 'NOT_ACCEPTED',
            `${cancel.status} status=${st.status} ${res.status} ${J(res.body)}`);
    }

    // Non-canonical URL ids are refused before any route sees them. SQLite compares '1.5e1' / '015'
    // to an INTEGER id by value (booking #15) while the token check's parseInt reads '1.5e1' as 1 —
    // so a token for booking #1 must never reach a route with the id spelled that way.
    const X = await makeQuoted('url-id', 1022, 4000);
    if (X) {
        const spellings = [`0${X.id}`, `${X.id}.0`, `${X.id}e0`, `${X.id}abc`];
        const results = [];
        for (const sp of spellings) {
            const r = await pub('POST', `/api/public/bookings/${sp}/accept-quote`, { access_token: X.token, terms_agreed: true });
            results.push(`${sp}:${r.status}`);
        }
        const after = await one('SELECT status FROM bookings WHERE id=?', [X.id]);
        check('plans: accept-quote with a non-canonical booking id (leading zero, decimal, exponent, suffix) -> 401, booking untouched',
            results.every(s => s.endsWith(':401')) && after && after.status === 'QUOTED' && (await liveRows(X.id)).length === 0,
            `${results.join(' ')} status=${after && after.status}`);

        // Access is handed out under the same id rule the token check enforces. When request-code and
        // verify-code used parseInt, '0<id>' got a code emailed and a token issued that every guarded
        // route then refused, so the tracker looped on "session expired".
        const codeSubject = "subject LIKE 'Your verification code:%'";
        const codesBefore = await one(`SELECT COUNT(*) AS n FROM notifications WHERE recipient_email = ? AND ${codeSubject}`, [X.em]);
        const reqResults = [];
        for (const sp of spellings) {
            const r = await pub('POST', `/api/public/bookings/${sp}/track/request-code`, { email: X.em });
            reqResults.push(`${sp}:${r.status}:${!!(r.body && /booking number/.test(r.body.message || ''))}`);
        }
        await sleep(300);
        const codesAfter = await one(`SELECT COUNT(*) AS n FROM notifications WHERE recipient_email = ? AND ${codeSubject}`, [X.em]);
        check('plans: track/request-code with a non-canonical booking id -> 400 asking for the plain booking number, no code emailed',
            reqResults.every(s => s.endsWith(':400:true')) && codesAfter.n === codesBefore.n,
            `${reqResults.join(' ')} codes ${codesBefore.n}->${codesAfter.n}`);

        // A live code for the booking, then verify-code under the padded id: refused before the code
        // is looked at (no token, no attempt used), and the same code still works under the plain id.
        const sent = await pub('POST', `/api/public/bookings/${X.id}/track/request-code`, { email: X.em });
        const notif = await waitFor(() => one(`SELECT body FROM notifications WHERE recipient_email = ? AND ${codeSubject} ORDER BY id DESC LIMIT 1`, [X.em]), 3000);
        let code = null;
        try { code = (((JSON.parse((notif && notif.body) || '{}').htmlContent) || '').match(/\b(\d{6})\b/) || [])[1] || null; } catch (e) { code = null; }
        const tokensBefore = await one('SELECT COUNT(*) AS n FROM booking_access_tokens WHERE booking_id = ?', [X.id]);
        const padded = await pub('POST', `/api/public/bookings/0${X.id}/track/verify-code`, { email: X.em, code: code || '000000' });
        const tokensAfter = await one('SELECT COUNT(*) AS n FROM booking_access_tokens WHERE booking_id = ?', [X.id]);
        const plain = await pub('POST', `/api/public/bookings/${X.id}/track/verify-code`, { email: X.em, code: code || '000000' });
        check('plans: track/verify-code with a padded booking id -> 400, no token issued; the code still verifies under the plain id',
            !!(sent.body && sent.body.success) && !!code && padded.status === 400 && !(padded.body && padded.body.access_token)
                && /booking number/.test((padded.body && padded.body.message) || '') && tokensAfter.n === tokensBefore.n
                && plain.status === 200 && !!(plain.body && plain.body.access_token),
            J({ sent: sent.status, code: !!code, padded: [padded.status, padded.body && padded.body.message], tokens: [tokensBefore.n, tokensAfter.n], plain: plain.status }));
    }

    // A paid row whose label this feature generated is renumbered when the client changes the plan,
    // so the schedule never shows "Payment 1 of 3" (paid) above "Payment 2 of 4".
    const L = await makeQuoted('relabel', 1023, 6000);
    if (L) {
        const acc = await accept(L, { milestones: [p(3000, addDays(T, 3)), p(1500, addDays(T, 20)), p(1500, L.E2)] });
        const first = await liveRows(L.id);
        check('plans: custom 3-payment plan gets the generated labels',
            acc.status === 200 && J(first.map(r => r.description)) === J([`Deposit ${DASH} Payment 1 of 3`, 'Payment 2 of 3', `Final Payment ${DASH} Payment 3 of 3`]),
            `${acc.status} ${brief(first)}`);
        if (first.length === 3) {
            await payTo(L.id, 3000, first[0].id);
            const res = await changePlan(L, { plan_version: await planVersionOf(L.id),
                milestones: [p(1000, addDays(T, 21)), p(1000, addDays(T, 30)), p(1000, L.E2)] });
            const live = await liveRows(L.id);
            check('plans: after a change the paid deposit is renumbered with the new total; amount, date and status untouched',
                res.status === 200 && live.length === 4
                    && J(live.map(r => r.description)) === J([`Deposit ${DASH} Payment 1 of 4`, 'Payment 2 of 4', 'Payment 3 of 4', `Final Payment ${DASH} Payment 4 of 4`])
                    && live[0].id === first[0].id && live[0].status === 'paid' && cents(live[0].expected_amount) === 300000 && live[0].due_date === first[0].due_date,
                `${res.status} ${J(res.body && res.body.message)} ${brief(live)}`);
        }
    }
}
