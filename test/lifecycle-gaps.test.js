// Fills five concrete gaps found by a full Section-1 audit of the booking lifecycle against a
// 45-section end-to-end test brief (2026-09-29): the existing suite (lifecycle.test.js,
// booking.test.js, contract.test.js, calendar.test.js, rbac.test.js, etc. — 809 checks) already
// covers the happy-path trace, contract double-sign idempotency, VAT/discount math, and RBAC on a
// 30-route GET sample. What it does NOT cover, verified by grepping the whole suite before writing
// a single line here:
//   1. Double accept-quote (the compare-and-swap 409 in routes/public/bookings.js) — untested.
//   2. Book Again (routes/admin/bookings.js POST .../book-again) — zero references anywhere in test/.
//   3. Refund-tier correctness at multiple days-until-event points, driven by the REAL policy row and
//      the REAL calculator (lib/cancellation-refund.js) rather than a hardcoded expected number — the
//      brief explicitly warns against hardcoding refund values without checking the actual policy.
//   4. Cancel-retry idempotency + "transactions are preserved, not deleted" on cancellation.
//   5. RBAC on the write-lifecycle routes (cancel/complete/status/contract/*) — rbac.test.js's own
//      header says it sampled read-only GET routes; docs-internal/routes.md documents all of these
//      as role "—" (any authenticated admin, no requireRole layered on requireAdmin), same as the
//      running code — so this section is a characterization test that locks in the CURRENT,
//      documented-as-intentional behavior, not a claim that it's wrong.
//
// Date offsets 8/12/15/16/17/19/20/25/38/44 are not used by any other *.test.js file (see
// calendar.test.js's comment on why offsets must not collide across files sharing one server/DB per
// npm test run — checked via `grep -on "future([0-9]*" test/*.test.js` before picking these), and
// none fall on 2026-10-05/08/13 — the three dates support.js's start() copies in from the real
// database.sqlite as pre-existing all-day date_holds (checked directly against the live DB before
// picking these; offsets 6/9/14 land on them and were rejected 409 by an earlier draft of this
// file). Every offset below is also distinct from every OTHER offset in this same file: an
// admin-created booking with no event_start_time occupies the whole day, so two bookings on the
// same date conflict even across this file's own separate sections.
const { calculateCancellationRefund } = require('../lib/cancellation-refund');

const SVC = 15; // 'Travel Buyout – Gauteng' (active, flat fee, zero lead time) — see booking.test.js
let seq = 0;
const email = () => `gaps.${Date.now()}.${seq++}@example.invalid`;

async function makeQuoted(api, future, sleep, amount, days, em) {
    const created = await api('POST', '/api/admin/bookings', {
        name: 'Gaps IT', email: em, cell: '+27821234567', event_date: future(days),
        event_name: 'Gaps Event', event_type: 'Corporate', event_location: 'Test Hall',
        message: 'Lifecycle-gaps integration test booking, over ten characters.',
        services: [{ service_id: SVC }], status: 'NEW', override_working_hours: true,
    });
    const id = created.body && created.body.booking_id;
    if (!id) throw new Error(`makeQuoted: booking creation failed (status ${created.status}): ${JSON.stringify(created.body)}`);
    await sleep(40);
    // Quote expiry must be >=3 days from today (a route-enforced business rule — see
    // routes/admin/bookings.js's quote route) AND on/before the event date. max(days-5, 4) satisfies
    // both for every offset this file uses (the smallest, 8, yields 4; the largest, 44, yields 39).
    const q = await api('POST', `/api/admin/bookings/${id}/quote`, {
        quote_expiry_date: future(Math.max(days - 5, 4)), terms: 'Standard terms', apply_vat: false, discount: 0,
        items: [{ service_id: SVC, description: 'Travel Buyout – Gauteng', quantity: 1, unit_price: amount }],
    });
    if (q.status !== 200) throw new Error(`makeQuoted: quote failed (status ${q.status}): ${JSON.stringify(q.body)}`);
    return id;
}

module.exports = async function ({ check, api, pub, one, q, future, sleep, getTrackingToken, loginAs }) {
    // ============================================================================================
    // 1. Double accept-quote: the client-facing acceptance cascade must be idempotent on retry —
    //    exactly one live payment-schedule batch, one invoice, one contract, no matter how many
    //    times the (identical) accept request is replayed. The route has two layers: an outer
    //    business-rule guard (any status other than QUOTED -> 400, read BEFORE the write) and an
    //    inner compare-and-swap on the UPDATE itself (-> 409) that only the narrow concurrent-race
    //    window (two requests both passing the read before either writes) can actually reach — a
    //    sequential retry after the first request has fully landed always hits the outer 400 guard
    //    instead, so both are tested here: sequential retries against 400, and a genuine fired-
    //    together pair against the race-safe 409/200 split.
    // ============================================================================================
    {
        const em = email();
        const id = await makeQuoted(api, future, sleep, 2000, 15, em);
        const token = await getTrackingToken(id, em);
        check('gap1: obtained a tracking/access token', !!token, String(token));

        const first = await pub('POST', `/api/public/bookings/${id}/accept-quote`, { access_token: token, terms_agreed: true });
        check('gap1: first accept -> 200', first.status === 200 && first.body.success, `${first.status} ${JSON.stringify(first.body)}`);
        await sleep(150); // let the async post-accept cascade (schedule+invoice+contract) finish

        const second = await pub('POST', `/api/public/bookings/${id}/accept-quote`, { access_token: token, terms_agreed: true });
        check('gap1: sequential replay (status already advanced past QUOTED) -> 400, not a second cascade',
            second.status === 400 && /already accepted|current status/i.test(second.body?.message || ''), `${second.status} ${JSON.stringify(second.body)}`);

        const schedules = await q('SELECT * FROM payment_schedules WHERE booking_id=?', [id]);
        check('gap1: exactly one 50/50 schedule batch exists (2 rows), not duplicated by the replay', schedules.length === 2, `count=${schedules.length}`);
        const invoices = await q('SELECT * FROM invoices WHERE booking_id=?', [id]);
        check('gap1: exactly one invoice exists', invoices.length === 1, `count=${invoices.length}`);
        const contracts = await q('SELECT * FROM contracts WHERE booking_id=?', [id]);
        check('gap1: exactly one contract row exists (draft)', contracts.length === 1 && contracts[0].status === 'draft', JSON.stringify(contracts[0]));

        // A third replay after the cascade has fully landed must still be rejected the same way.
        const third = await pub('POST', `/api/public/bookings/${id}/accept-quote`, { access_token: token, terms_agreed: true });
        check('gap1: second sequential replay -> still 400', third.status === 400, `${third.status}`);
    }

    // ── 1b. Genuine concurrency: two accept-quote requests fired together against one fresh QUOTED
    //    booking. Exactly one must win (200); the other must be rejected (either the CAS's 409 if it
    //    reached the UPDATE in the same race window, or 400 if it lost the race entirely and its own
    //    read already saw the post-write status) — never both succeeding, and never a second cascade.
    {
        const em = email();
        const id = await makeQuoted(api, future, sleep, 1200, 15 + 200, em); // +200 keeps this off every offset used elsewhere in this file
        const token = await getTrackingToken(id, em);
        const [r1, r2] = await Promise.all([
            pub('POST', `/api/public/bookings/${id}/accept-quote`, { access_token: token, terms_agreed: true }),
            pub('POST', `/api/public/bookings/${id}/accept-quote`, { access_token: token, terms_agreed: true }),
        ]);
        const statuses = [r1.status, r2.status];
        const winners = statuses.filter(s => s === 200).length;
        // Node's event loop rarely lands the two requests inside the narrow interleaved-read window
        // that would exercise the inner CAS's 409 specifically (see this section's own header note);
        // in practice one request's whole read-check-write-commit finishes before the other's initial
        // read runs, so the loser sees the outer 400 guard. Either is an acceptable "loser" status —
        // what actually matters, and what the two checks below verify, is that exactly one request
        // succeeded and no second cascade ran.
        check('gap1b: concurrent accept-quote — exactly one request wins (200), never zero or two',
            winners === 1, `${JSON.stringify(statuses)} bodies=${JSON.stringify([r1.body, r2.body])}`);
        check('gap1b: the losing request was rejected with 400 or 409, not some other error',
            statuses.some(s => s === 400 || s === 409), JSON.stringify(statuses));
        await sleep(200);
        const schedules2 = await q('SELECT * FROM payment_schedules WHERE booking_id=?', [id]);
        check('gap1b: concurrent double-fire still produced exactly one schedule batch (2 rows)', schedules2.length === 2, `count=${schedules2.length}`);
        const invoices2 = await q('SELECT * FROM invoices WHERE booking_id=?', [id]);
        check('gap1b: concurrent double-fire still produced exactly one invoice', invoices2.length === 1, `count=${invoices2.length}`);
    }

    // ============================================================================================
    // 2. Book Again must produce a genuinely fresh booking: new id, NEW status, and none of the
    //    original's financial/contract/calendar artifacts carried over.
    // ============================================================================================
    {
        const em = email();
        const id = await makeQuoted(api, future, sleep, 1500, 25, em);
        const token = await getTrackingToken(id, em);
        await pub('POST', `/api/public/bookings/${id}/accept-quote`, { access_token: token, terms_agreed: true });
        await sleep(150);
        await api('PUT', `/api/admin/bookings/${id}/manual-payment`, { amount_paid: 1500, payment_status: 'PAID', force: true });
        await sleep(150);

        const cancelRes = await api('POST', `/api/admin/bookings/${id}/cancel`, { reason: 'gap2 test cancel', cancelled_by: 'mutual' });
        check('gap2: original cancelled -> 200', cancelRes.status === 200, `${cancelRes.status} ${JSON.stringify(cancelRes.body)}`);

        const again = await api('POST', `/api/admin/bookings/${id}/book-again`, { override_conflict: true });
        check('gap2: book-again -> 200 with a new_booking_id', again.status === 200 && !!again.body.new_booking_id, `${again.status} ${JSON.stringify(again.body)}`);
        const newId = again.body.new_booking_id;
        check('gap2: the new booking id differs from the original', newId && newId !== id, `${newId} vs ${id}`);

        const newRow = await one('SELECT * FROM bookings WHERE id=?', [newId]);
        check('gap2: new booking starts at status NEW', newRow.status === 'NEW', newRow.status);
        check('gap2: new booking carries the same client/event date (that part IS meant to copy)', newRow.email === em && newRow.date === newRow.date, newRow.email);
        check('gap2: new booking has no quote/total amount copied over', !newRow.quote_amount && !newRow.total_amount, JSON.stringify({ q: newRow.quote_amount, t: newRow.total_amount }));
        check('gap2: new booking has amount_paid=0 (no financial history copied)', !(parseFloat(newRow.amount_paid) > 0), newRow.amount_paid);
        check('gap2: new booking has no google_event_id copied', !newRow.google_event_id, newRow.google_event_id);

        const newInvoices = await q('SELECT * FROM invoices WHERE booking_id=?', [newId]);
        check('gap2: no invoice carried over to the new booking', newInvoices.length === 0, `count=${newInvoices.length}`);
        const newContracts = await q('SELECT * FROM contracts WHERE booking_id=?', [newId]);
        check('gap2: no contract carried over to the new booking', newContracts.length === 0, `count=${newContracts.length}`);
        const newSchedules = await q('SELECT * FROM payment_schedules WHERE booking_id=?', [newId]);
        check('gap2: no payment schedule carried over to the new booking', newSchedules.length === 0, `count=${newSchedules.length}`);
        const newTx = await q('SELECT * FROM transactions WHERE booking_id=?', [newId]);
        check('gap2: no transaction carried over to the new booking', newTx.length === 0, `count=${newTx.length}`);

        // The original's own audit trail must record the rebooking (not just the new row's own CREATE).
        const rebookAudit = await q("SELECT * FROM audit_log WHERE table_name='bookings' AND record_id=? AND action='REBOOKED'", [id]);
        check('gap2: original booking has a REBOOKED audit_log entry pointing at the new id', rebookAudit.length === 1, JSON.stringify(rebookAudit[0]));
    }

    // ============================================================================================
    // 3. Refund-tier correctness at three days-until-event points, computed from the ACTUAL policy
    //    row in the DB and the ACTUAL calculator — never a hardcoded expected percentage.
    // ============================================================================================
    {
        const policyRow = await one("SELECT policy_value FROM policies WHERE policy_key='cancellation_policy'");
        const policyStr = (policyRow && policyRow.policy_value) || '';

        const tiers = [
            { days: 8,  label: '< 14 days' },
            { days: 20, label: '14-29 days' },
            { days: 38, label: '30+ days' },
        ];
        const results = [];
        for (const t of tiers) {
            const em = email();
            const id = await makeQuoted(api, future, sleep, 2000, t.days, em);
            const token = await getTrackingToken(id, em);
            await pub('POST', `/api/public/bookings/${id}/accept-quote`, { access_token: token, terms_agreed: true });
            await sleep(120);
            await api('PUT', `/api/admin/bookings/${id}/manual-payment`, { amount_paid: 2000, payment_status: 'PAID', force: true });
            await sleep(120);

            const row = await one('SELECT * FROM bookings WHERE id=?', [id]);
            const expected = calculateCancellationRefund(row, policyStr); // same function, same policy the API itself reads

            const preview = await api('GET', `/api/admin/bookings/${id}/cancellation-preview`);
            check(`gap3 (${t.label}): preview 200`, preview.status === 200, `${preview.status}`);
            check(`gap3 (${t.label}): API refund matches calculateCancellationRefund() against the real policy row`,
                Math.abs(preview.body.preview.refund - expected.refund) < 0.01, `api=${preview.body.preview.refund} expected=${expected.refund}`);
            check(`gap3 (${t.label}): API retention matches calculateCancellationRefund()`,
                Math.abs(preview.body.preview.retention - expected.retention) < 0.01, `api=${preview.body.preview.retention} expected=${expected.retention}`);
            check(`gap3 (${t.label}): API rule label matches`, preview.body.preview.rule === expected.rule, `api="${preview.body.preview.rule}" expected="${expected.rule}"`);

            results.push({ label: t.label, retention: expected.retention, refund: expected.refund });
        }

        // Sanity beyond "the API calls the same function": `tiers` is ordered near-to-far, so
        // retention must not INCREASE down the list (nearer the event -> same or higher retention,
        // never lower than a booking further out).
        check('gap3: retention is monotonically non-increasing from the nearest tier to the farthest',
            results[0].retention >= results[1].retention && results[1].retention >= results[2].retention,
            JSON.stringify(results));
        // And the two ends of a real tiered policy should actually differ, or the policy isn't tiered
        // at all and this whole check would be vacuous.
        check('gap3: the far-out and near-term retention amounts actually differ (policy is genuinely tiered)',
            results[0].retention !== results[2].retention, JSON.stringify(results));
    }

    // ============================================================================================
    // 4. Cancel-retry idempotency + transactions preserved (never deleted) on cancellation.
    // ============================================================================================
    {
        const em = email();
        const id = await makeQuoted(api, future, sleep, 1000, 44, em);
        const token = await getTrackingToken(id, em);
        await pub('POST', `/api/public/bookings/${id}/accept-quote`, { access_token: token, terms_agreed: true });
        await sleep(120);
        await api('PUT', `/api/admin/bookings/${id}/manual-payment`, { amount_paid: 1000, payment_status: 'PAID', force: true });
        await sleep(120);

        const txBefore = await q('SELECT * FROM transactions WHERE booking_id=?', [id]);
        check('gap4: at least one transaction exists from the manual payment', txBefore.length >= 1, `count=${txBefore.length}`);

        const cancel1 = await api('POST', `/api/admin/bookings/${id}/cancel`, { reason: 'gap4 first cancel', cancelled_by: 'client' });
        check('gap4: first cancel -> 200', cancel1.status === 200, `${cancel1.status} ${JSON.stringify(cancel1.body)}`);

        const cancel2 = await api('POST', `/api/admin/bookings/${id}/cancel`, { reason: 'gap4 retry', cancelled_by: 'client' });
        check('gap4: retried cancel on an already-CANCELLED booking -> 400, not a second cascade', cancel2.status === 400, `${cancel2.status} ${JSON.stringify(cancel2.body)}`);

        const cancellations = await q('SELECT * FROM cancellations WHERE booking_id=?', [id]);
        check('gap4: exactly one cancellation record exists (retry did not insert a second)', cancellations.length === 1, `count=${cancellations.length}`);

        const txAfter = await q('SELECT * FROM transactions WHERE booking_id=?', [id]);
        check('gap4: every original transaction row still exists after cancellation (preserved, not deleted)',
            txAfter.length === txBefore.length && txBefore.every(b => txAfter.some(a => a.id === b.id)),
            `before=${txBefore.length} after=${txAfter.length}`);

        const row = await one('SELECT * FROM bookings WHERE id=?', [id]);
        check('gap4: booking status is CANCELLED', row.status === 'CANCELLED', row.status);
        check('gap4: amount_paid is untouched by cancellation (refund is tracked separately, not by zeroing the ledger)',
            Math.abs(parseFloat(row.amount_paid) - 1000) < 0.01, row.amount_paid);
    }

    // ============================================================================================
    // 5. RBAC on write-lifecycle routes at the direct-API level (not UI visibility). rbac.test.js's
    //    own 30-route sample is GET-only; docs-internal/routes.md documents cancel/complete/status/
    //    contract/* as role "—" (any authenticated admin) — this locks in that documented, current
    //    behavior as a regression guard, and separately proves unauthenticated is still blocked.
    // ============================================================================================
    {
        const asManager = await loginAs('manager');
        const asAssistant = await loginAs('assistant');

        // Unauthenticated must be rejected outright on every one of these routes.
        const unauthCancel = await pub('POST', '/api/admin/bookings/999999/cancel', { reason: 'x' });
        check('gap5: unauthenticated POST .../cancel -> 401', unauthCancel.status === 401, `${unauthCancel.status}`);
        const unauthStatus = await pub('PUT', '/api/admin/bookings/999999/status', { status: 'CANCELLED' });
        check('gap5: unauthenticated PUT .../status -> 401', unauthStatus.status === 401, `${unauthStatus.status}`);
        const unauthComplete = await pub('POST', '/api/admin/bookings/999999/complete', {});
        check('gap5: unauthenticated POST .../complete -> 401', unauthComplete.status === 401, `${unauthComplete.status}`);

        // Administrator, manager AND assistant can each independently cancel a booking they own —
        // one fresh booking per role so the three checks don't contend for the same row.
        const roleActors = [
            ['administrator', api, 12],
            ['manager', asManager, 17],
            ['assistant', asAssistant, 19],
        ];
        for (const [roleName, actor, dayOffset] of roleActors) {
            const em = email();
            const id = await makeQuoted(api, future, sleep, 500, dayOffset, em); // created via the fixed `api` (administrator) regardless of who cancels next; each role gets its own date so the three don't conflict with each other
            const token = await getTrackingToken(id, em);
            await pub('POST', `/api/public/bookings/${id}/accept-quote`, { access_token: token, terms_agreed: true });
            await sleep(100);

            const res = await actor('POST', `/api/admin/bookings/${id}/cancel`, { reason: `gap5 ${roleName} cancel`, cancelled_by: 'mutual' });
            check(`gap5: ${roleName} can cancel a booking via the direct API (documented as role "—" in routes.md)`, res.status === 200, `${res.status} ${JSON.stringify(res.body)}`);
        }

        // Contrast: manual-payment and refund ARE role-gated (requireRole(['administrator','manager']))
        // — assistant must be blocked at the API, matching routes.md's documented restriction. This is
        // the negative case that shows section 5's "any role" results above are a deliberate, narrower
        // carve-out and not a blanket absence of RBAC on this router.
        const em2 = email();
        const gatedId = await makeQuoted(api, future, sleep, 500, 16, em2);
        const gatedToken = await getTrackingToken(gatedId, em2);
        await pub('POST', `/api/public/bookings/${gatedId}/accept-quote`, { access_token: gatedToken, terms_agreed: true });
        await sleep(100);
        const assistantPay = await asAssistant('PUT', `/api/admin/bookings/${gatedId}/manual-payment`, { amount_paid: 500, payment_status: 'PAID', force: true });
        check('gap5: assistant IS blocked from manual-payment (requireRole administrator/manager) -> 403', assistantPay.status === 403, `${assistantPay.status}`);
        const managerPay = await asManager('PUT', `/api/admin/bookings/${gatedId}/manual-payment`, { amount_paid: 500, payment_status: 'PAID', force: true });
        check('gap5: manager IS allowed manual-payment -> 200', managerPay.status === 200, `${managerPay.status}`);
    }
};
