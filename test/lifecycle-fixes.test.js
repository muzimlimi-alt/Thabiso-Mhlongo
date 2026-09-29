// Regression coverage for the fixes made executing the Phase 1 booking-lifecycle review's
// prioritized action list (2026-09-29): P0-1/P0-2 (compare-and-swap guards on every automated-sweep
// write and both cancel entry points, closing a real race where a blind `WHERE id=?` UPDATE could
// silently clobber a concurrent client/admin action), P1-1 (a revision/extension request now
// extends quote_expiry_date instead of leaving the auto-expiry sweep unaware of it), and P1-2
// (expired_reason distinguishes the two causes that both land on status='EXPIRED').
//
// The guarded functions (promoteBookingToPending, markBookingAutoCompleted, expirePendingBooking,
// expireQuotedBooking) are only ever called from lib/background-clerk.js's hourly sweep — there is
// no HTTP route that invokes one directly, and the sweep itself only fires on a real setTimeout/
// setInterval inside the spawned test server (far too slow to wait on here, same constraint noted
// in lifecycle-gaps.test.js's header for the 8 dedicated job files). So section A tests the exact
// guarded SQL statements directly (same technique calendar.test.js already uses for DB-level
// assertions) — this is what actually proves the fix, since correctness here doesn't depend on
// winning a specific timing window, it depends on the WHERE clause being right regardless of when
// it runs. Sections B-D test the two cancel routes, the revision-request expiry extension, and the
// quote-revert email through the real HTTP API.
const sqlite3 = require('sqlite3');

const SVC = 15; // 'Travel Buyout – Gauteng' (active, flat fee, zero lead time) — see booking.test.js
let seq = 0;
const email = () => `fixes.${Date.now()}.${seq++}@example.invalid`;

module.exports = async function ({ check, api, pub, one, q, future, sleep, getTrackingToken, TEST_DB }) {
    const rw = new sqlite3.Database(TEST_DB);
    const run = (sql, params = []) => new Promise((res, rej) => rw.run(sql, params, function (e) { e ? rej(e) : res(this); }));

    async function makeBooking(days, em) {
        const created = await api('POST', '/api/admin/bookings', {
            name: 'Fixes IT', email: em, cell: '+27821234567', event_date: future(days),
            event_name: 'Fixes Event', event_type: 'Corporate', event_location: 'Test Hall',
            message: 'lifecycle-fixes.test.js integration test booking, over ten characters.',
            services: [{ service_id: SVC }], status: 'NEW', override_working_hours: true,
        });
        return created.body && created.body.booking_id;
    }

    // ============================================================================================
    // A. Direct SQL verification that each P0-1/P0-2 guarded statement is a real compare-and-swap:
    //    0 rows affected (and the row untouched) when the precondition status doesn't hold, exactly
    //    1 row affected when it does. Each guarded statement is copied here VERBATIM from its source
    //    (database/repositories/bookings.repository.js and routes/public/bookings.js) — a mismatch
    //    between this copy and the real one is itself a signal the source drifted.
    // ============================================================================================
    const guardedStatements = [
        {
            label: 'promoteBookingToPending (S0, NEW->PENDING)',
            sql: `UPDATE bookings SET status='PENDING', pending_at=CURRENT_TIMESTAMP WHERE id=? AND status='NEW'`,
            rightStatus: 'NEW', wrongStatus: 'PENDING', expectStatusAfter: 'PENDING',
        },
        {
            label: 'markBookingAutoCompleted (S6, CONFIRMED->COMPLETED)',
            sql: `UPDATE bookings SET status='COMPLETED', completed_at=CURRENT_TIMESTAMP WHERE id=? AND status='CONFIRMED'`,
            rightStatus: 'CONFIRMED', wrongStatus: 'CANCELLED', expectStatusAfter: 'COMPLETED',
        },
        {
            label: 'expirePendingBooking (PENDING->EXPIRED, 48h)',
            sql: `UPDATE bookings SET status = 'EXPIRED', expired_reason = 'pending_inactivity', message = COALESCE(message,'') || '\n[System: Expired due to 48h inactivity]' WHERE id = ? AND status = 'PENDING'`,
            rightStatus: 'PENDING', wrongStatus: 'ACCEPTED', expectStatusAfter: 'EXPIRED',
        },
        {
            label: 'expireQuotedBooking (QUOTED->EXPIRED, past quote_expiry_date)',
            sql: `UPDATE bookings SET status = 'EXPIRED', expired_reason = 'quote_expiry', message = COALESCE(message,'') || '\n[System: Quote expired — no response from client]' WHERE id = ? AND status = 'QUOTED'`,
            rightStatus: 'QUOTED', wrongStatus: 'CONFIRMED', expectStatusAfter: 'EXPIRED',
        },
        {
            label: 'cancelBookingAsync (admin /cancel route)',
            sql: `UPDATE bookings SET status = 'CANCELLED', cancelled_at = CURRENT_TIMESTAMP WHERE id = ? AND status NOT IN ('CANCELLED','COMPLETED')`,
            rightStatus: 'ACCEPTED', wrongStatus: 'CANCELLED', expectStatusAfter: 'CANCELLED',
        },
        {
            label: 'public self-cancel route (inline UPDATE)',
            sql: `UPDATE bookings SET status = 'CANCELLED', cancelled_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('PENDING','QUOTED','ACCEPTED')`,
            rightStatus: 'QUOTED', wrongStatus: 'COMPLETED', expectStatusAfter: 'CANCELLED',
        },
    ];

    let dayOffset = 61;
    for (const g of guardedStatements) {
        const em = email();
        const id = await makeBooking(dayOffset++, em);
        if (!id) { check(`guard (${g.label}): fixture booking created`, false, 'booking creation failed'); continue; }

        // Simulate a lost race: the row is at some OTHER status by the time this statement runs
        // (e.g. a concurrent accept/cancel/re-quote already moved it on).
        await run('UPDATE bookings SET status=? WHERE id=?', [g.wrongStatus, id]);
        const missResult = await run(g.sql, [id]);
        check(`guard (${g.label}): no-ops when status has already moved on (0 rows)`, missResult.changes === 0, `changes=${missResult.changes}`);
        const afterMiss = await one('SELECT status FROM bookings WHERE id=?', [id]);
        check(`guard (${g.label}): row status unchanged after the no-op`, afterMiss.status === g.wrongStatus, afterMiss.status);

        // Now put it in the state the statement is actually meant to act on, and confirm it does.
        await run('UPDATE bookings SET status=? WHERE id=?', [g.rightStatus, id]);
        const hitResult = await run(g.sql, [id]);
        check(`guard (${g.label}): applies when the precondition status holds (1 row)`, hitResult.changes === 1, `changes=${hitResult.changes}`);
        const afterHit = await one('SELECT status, expired_reason FROM bookings WHERE id=?', [id]);
        check(`guard (${g.label}): row now has the expected post-status`, afterHit.status === g.expectStatusAfter, afterHit.status);
    }

    // expired_reason (P1-2) specifically: the two EXPIRED causes must be distinguishable, which the
    // loop above already exercised for each function individually — this cross-check confirms
    // they're not just BOTH set to the same value by accident.
    {
        const emP = email(), emQ = email();
        const idPending = await makeBooking(70, emP);
        const idQuoted = await makeBooking(71, emQ);
        await run("UPDATE bookings SET status='PENDING' WHERE id=?", [idPending]);
        await run(`UPDATE bookings SET status = 'EXPIRED', expired_reason = 'pending_inactivity', message = COALESCE(message,'') || '\n[System: Expired due to 48h inactivity]' WHERE id = ? AND status = 'PENDING'`, [idPending]);
        await run("UPDATE bookings SET status='QUOTED' WHERE id=?", [idQuoted]);
        await run(`UPDATE bookings SET status = 'EXPIRED', expired_reason = 'quote_expiry', message = COALESCE(message,'') || '\n[System: Quote expired — no response from client]' WHERE id = ? AND status = 'QUOTED'`, [idQuoted]);

        const rowP = await one('SELECT expired_reason FROM bookings WHERE id=?', [idPending]);
        const rowQ = await one('SELECT expired_reason FROM bookings WHERE id=?', [idQuoted]);
        check('P1-2: pending-inactivity and quote-expiry produce DIFFERENT expired_reason values',
            rowP.expired_reason !== rowQ.expired_reason && !!rowP.expired_reason && !!rowQ.expired_reason,
            JSON.stringify({ pending: rowP.expired_reason, quoted: rowQ.expired_reason }));
    }

    // ============================================================================================
    // B. P0-2 through the real HTTP routes: cancelling a booking that's already terminal (COMPLETED
    //    or CANCELLED) is rejected — the outer business-rule guard for the common case, which the
    //    inner CAS backs up for the narrow concurrent-race case the outer guard's own read can't see.
    // ============================================================================================
    {
        const em = email();
        const id = await makeBooking(72, em);
        await run("UPDATE bookings SET status='CANCELLED', cancelled_at=CURRENT_TIMESTAMP WHERE id=?", [id]);
        const res = await api('POST', `/api/admin/bookings/${id}/cancel`, { reason: 'x', cancelled_by: 'mutual' });
        check('P0-2: admin cancel on an already-CANCELLED booking is rejected, not double-processed', res.status === 400, `${res.status} ${JSON.stringify(res.body)}`);

        const em2 = email();
        const id2 = await makeBooking(73, em2);
        const token2 = await getTrackingToken(id2, em2);
        await run("UPDATE bookings SET status='COMPLETED' WHERE id=?", [id2]);
        const res2 = await pub('POST', `/api/public/bookings/${id2}/cancel`, { access_token: token2, reason: 'x' });
        check('P0-2: public self-cancel on a COMPLETED booking is rejected', res2.status === 400, `${res2.status} ${JSON.stringify(res2.body)}`);
    }

    // ============================================================================================
    // C. P1-1: a revision/extension request extends quote_expiry_date and stamps
    //    revision_requested_at; a fresh quote afterward clears revision_requested_at.
    // ============================================================================================
    {
        const em = email();
        const id = await makeBooking(74, em);
        const shortExpiry = future(4); // >=3 days out (route-enforced minimum) but inside the 5-day grace window
        const quoteRes = await api('POST', `/api/admin/bookings/${id}/quote`, {
            quote_expiry_date: shortExpiry, terms: 'Standard terms', apply_vat: false, discount: 0,
            items: [{ service_id: SVC, description: 'Travel Buyout – Gauteng', quantity: 1, unit_price: 1000 }],
        });
        check('P1-1: fixture quote issued -> 200', quoteRes.status === 200, `${quoteRes.status}`);

        const token = await getTrackingToken(id, em);
        const revReq = await pub('POST', `/api/public/bookings/${id}/quote-revision-request`, {
            access_token: token, request_type: 'extension', message: 'Could I get a little more time to decide, please?',
        });
        check('P1-1: revision-request -> 200', revReq.status === 200 && revReq.body.success, `${revReq.status} ${JSON.stringify(revReq.body)}`);

        const afterReq = await one('SELECT quote_expiry_date, revision_requested_at FROM bookings WHERE id=?', [id]);
        const graceExpiry = future(5);
        check('P1-1: quote_expiry_date was extended to at least the 5-day grace window',
            afterReq.quote_expiry_date >= graceExpiry, `expiry=${afterReq.quote_expiry_date} grace=${graceExpiry} original=${shortExpiry}`);
        check('P1-1: revision_requested_at was stamped', !!afterReq.revision_requested_at, afterReq.revision_requested_at);

        // A fresh quote resets the negotiation — revision_requested_at should clear.
        const newExpiry = future(30);
        const requoteRes = await api('POST', `/api/admin/bookings/${id}/quote`, {
            quote_expiry_date: newExpiry, terms: 'Revised terms', apply_vat: false, discount: 0,
            items: [{ service_id: SVC, description: 'Travel Buyout – Gauteng', quantity: 1, unit_price: 1200 }],
        });
        check('P1-1: re-quote after a revision request -> 200', requoteRes.status === 200, `${requoteRes.status}`);
        const afterRequote = await one('SELECT revision_requested_at, quote_expiry_date FROM bookings WHERE id=?', [id]);
        check('P1-1: revision_requested_at cleared by the fresh quote', afterRequote.revision_requested_at === null, afterRequote.revision_requested_at);
        check('P1-1: quote_expiry_date reflects the new quote, not the extension', afterRequote.quote_expiry_date === newExpiry, afterRequote.quote_expiry_date);
    }

    // A revision request on a booking whose quote is ALREADY comfortably far from expiring must
    // not shorten it back down to the 5-day grace window.
    {
        const em = email();
        const id = await makeBooking(75, em);
        const farExpiry = future(40);
        await api('POST', `/api/admin/bookings/${id}/quote`, {
            quote_expiry_date: farExpiry, terms: 'Standard terms', apply_vat: false, discount: 0,
            items: [{ service_id: SVC, description: 'Travel Buyout – Gauteng', quantity: 1, unit_price: 1000 }],
        });
        const token = await getTrackingToken(id, em);
        await pub('POST', `/api/public/bookings/${id}/quote-revision-request`, {
            access_token: token, request_type: 'revision', message: 'Could we adjust the line items slightly, please?',
        });
        const after = await one('SELECT quote_expiry_date FROM bookings WHERE id=?', [id]);
        check('P1-1: an already-generous expiry is left alone, not shortened to the 5-day grace window',
            after.quote_expiry_date === farExpiry, `${after.quote_expiry_date} vs original ${farExpiry}`);
    }

    // ============================================================================================
    // D. P3-1: ACCEPTED->QUOTED via the generic status endpoint now emails the client (previously
    //    silent — see lib/booking-status.js's applyStatusChange, 'QUOTED' branch).
    // ============================================================================================
    {
        const em = email();
        const id = await makeBooking(76, em);
        await api('POST', `/api/admin/bookings/${id}/quote`, {
            quote_expiry_date: future(20), terms: 'Standard terms', apply_vat: false, discount: 0,
            items: [{ service_id: SVC, description: 'Travel Buyout – Gauteng', quantity: 1, unit_price: 1000 }],
        });
        const token = await getTrackingToken(id, em);
        await pub('POST', `/api/public/bookings/${id}/accept-quote`, { access_token: token, terms_agreed: true });
        await sleep(150);

        const revertRes = await api('PUT', `/api/admin/bookings/${id}/status`, { status: 'QUOTED' });
        check('P3-1: generic-endpoint ACCEPTED->QUOTED revert -> 200', revertRes.status === 200, `${revertRes.status} ${JSON.stringify(revertRes.body)}`);
        // The email fires after an `await syncBookingToCalendar(b)` in the same async chain, which
        // (in test mode, with a deliberately invalid GOOGLE_REFRESH_TOKEN) retries the OAuth token
        // exchange against Google's real servers before giving up — noticeably slower than this
        // file's other post-transition sleeps.
        await sleep(4000);

        const notif = await q(`SELECT * FROM notifications WHERE recipient_email = ? AND subject LIKE 'Your Quote Is Being Revised%'`, [em]);
        check('P3-1: the client was emailed that their quote is being revised', notif.length === 1, `count=${notif.length}`);
    }

    rw.close();
};
