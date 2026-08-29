// Coverage for double opt-in (pending_confirmation -> confirm -> active) and the resubscribe-after-
// unsubscribe bug fix on POST /api/public/subscribe, plus the new `dormant` segmentation case.
const support = require('./support');
const { pub, api, one, sleep } = support;
const sqlite3 = require('sqlite3');

// Direct read-write handle to the isolated TEST_DB — needed to backdate subscribed_at for the
// dormant-segment checks (no public/admin endpoint can set that field to an arbitrary past date).
const rw = new sqlite3.Database(support.TEST_DB);
const run = (sql, params = []) => new Promise((res, rej) => rw.run(sql, params, function (e) { e ? rej(e) : res(this); }));

const email = () => `optin.${Date.now()}.${Math.floor(Math.random() * 1e4)}@example.invalid`;

async function queued(subjectLike, recipient) {
    const row = await one(
        "SELECT subject, recipient_email FROM notifications WHERE type='email' AND subject LIKE ? AND recipient_email = ? ORDER BY id DESC LIMIT 1",
        [subjectLike, recipient]
    );
    return row || null;
}
async function queuedCount(subjectLike, recipient) {
    const rows = await support.q(
        "SELECT id FROM notifications WHERE type='email' AND subject LIKE ? AND recipient_email = ?",
        [subjectLike, recipient]
    );
    return rows.length;
}

module.exports = async function ({ check }) {
    // ── Resubscribe while still pending_confirmation: single row, identical response ──
    const pendingEmail = email();
    const r1 = await pub('POST', '/api/public/subscribe', { email: pendingEmail, popia_consent: true, first_name: 'Pending' });
    const r2 = await pub('POST', '/api/public/subscribe', { email: pendingEmail, popia_consent: true, first_name: 'Pending' });
    check('resubscribe-while-pending: both responses 200/success', r1.status === 200 && r1.body.success && r2.status === 200 && r2.body.success,
        `${r1.status}/${r1.body && r1.body.success} ${r2.status}/${r2.body && r2.body.success}`);
    check('resubscribe-while-pending: identical response message (no state-enumeration leak)', r1.body.message === r2.body.message,
        `"${r1.body.message}" vs "${r2.body.message}"`);
    const pendingRows = await support.q('SELECT subscriber_id FROM newsletter_subscribers WHERE LOWER(email)=LOWER(?)', [pendingEmail]);
    check('resubscribe-while-pending: still exactly one subscriber row', pendingRows.length === 1, JSON.stringify(pendingRows));

    // ── Resubscribe while active: unchanged 409 regression guard ──
    const activeEmail = email();
    await pub('POST', '/api/public/subscribe', { email: activeEmail, popia_consent: true, first_name: 'Active' });
    await sleep(100);
    const activeSub = await one('SELECT unsubscribe_token FROM newsletter_subscribers WHERE LOWER(email)=LOWER(?)', [activeEmail]);
    await pub('POST', '/api/public/newsletter/confirm', { email: activeEmail, token: activeSub.unsubscribe_token });
    await sleep(100);
    const rActive = await pub('POST', '/api/public/subscribe', { email: activeEmail, popia_consent: true, first_name: 'Active' });
    check('resubscribe-while-active: 409, unchanged message', rActive.status === 409 && rActive.body.message === 'You are already subscribed!',
        `${rActive.status} "${rActive.body && rActive.body.message}"`);

    // ── THE BUG FIX: subscribe -> confirm -> unsubscribe -> subscribe again must succeed ──
    const cycleEmail = email();
    await pub('POST', '/api/public/subscribe', { email: cycleEmail, popia_consent: true, first_name: 'Cycle' });
    await sleep(100);
    const cycleSub = await one('SELECT subscriber_id, unsubscribe_token FROM newsletter_subscribers WHERE LOWER(email)=LOWER(?)', [cycleEmail]);
    await pub('POST', '/api/public/newsletter/confirm', { email: cycleEmail, token: cycleSub.unsubscribe_token });
    await pub('POST', '/api/public/newsletter/unsubscribe', { email: cycleEmail, token: cycleSub.unsubscribe_token });
    await sleep(100);
    const unsubbed = await one('SELECT status FROM newsletter_subscribers WHERE subscriber_id=?', [cycleSub.subscriber_id]);
    check('bug-fix setup: subscriber is genuinely unsubscribed before retry', unsubbed && unsubbed.status === 'unsubscribed', JSON.stringify(unsubbed));

    const rResub = await pub('POST', '/api/public/subscribe', { email: cycleEmail, popia_consent: true, first_name: 'Cycle Again' });
    check('BUG FIX: resubscribing after unsubscribe returns 200, not 409', rResub.status === 200 && rResub.body.success,
        `${rResub.status} ${JSON.stringify(rResub.body)}`);
    await sleep(100);
    const resubbed = await one('SELECT subscriber_id, status FROM newsletter_subscribers WHERE LOWER(email)=LOWER(?)', [cycleEmail]);
    check('BUG FIX: resubscribed row is pending_confirmation again (same row, not duplicated)',
        resubbed && resubbed.status === 'pending_confirmation' && resubbed.subscriber_id === cycleSub.subscriber_id, JSON.stringify(resubbed));

    // ── Stale-token-after-unsubscribe guard: the ORIGINAL confirm link must not resurrect them ──
    // (cycleEmail is pending_confirmation again at this point from the resubscribe above; unsubscribe
    // it a second time so we're back to testing the true "confirm after unsubscribe" scenario.)
    await pub('POST', '/api/public/newsletter/unsubscribe', { email: cycleEmail, token: cycleSub.unsubscribe_token });
    await sleep(100);
    const rStaleConfirm = await pub('POST', '/api/public/newsletter/confirm', { email: cycleEmail, token: cycleSub.unsubscribe_token });
    check('stale confirm link after unsubscribe: rejected, not 200', rStaleConfirm.status !== 200 || rStaleConfirm.body.success !== true,
        `${rStaleConfirm.status} ${JSON.stringify(rStaleConfirm.body)}`);
    const stillUnsubbed = await one('SELECT status FROM newsletter_subscribers WHERE subscriber_id=?', [cycleSub.subscriber_id]);
    check('stale confirm link after unsubscribe: status stays unsubscribed (not reactivated)', stillUnsubbed && stillUnsubbed.status === 'unsubscribed', JSON.stringify(stillUnsubbed));

    // ── Idempotent re-confirm: confirming an already-active row doesn't re-send the welcome email ──
    const idemEmail = email();
    await pub('POST', '/api/public/subscribe', { email: idemEmail, popia_consent: true, first_name: 'Idem' });
    await sleep(100);
    const idemSub = await one('SELECT unsubscribe_token FROM newsletter_subscribers WHERE LOWER(email)=LOWER(?)', [idemEmail]);
    await pub('POST', '/api/public/newsletter/confirm', { email: idemEmail, token: idemSub.unsubscribe_token });
    await sleep(100);
    const countBefore = await queuedCount("Welcome to Thabiso Mhlongo's Newsletter!", idemEmail);
    const rReconfirm = await pub('POST', '/api/public/newsletter/confirm', { email: idemEmail, token: idemSub.unsubscribe_token });
    check('idempotent re-confirm: success + alreadyConfirmed flag', rReconfirm.status === 200 && rReconfirm.body.success && rReconfirm.body.alreadyConfirmed === true,
        JSON.stringify(rReconfirm.body));
    await sleep(100);
    const countAfter = await queuedCount("Welcome to Thabiso Mhlongo's Newsletter!", idemEmail);
    check('idempotent re-confirm: no duplicate welcome email queued', countAfter === countBefore, `${countBefore} -> ${countAfter}`);

    // ── Admin manual-add stays exempt from double opt-in: immediate active, no confirmation email ──
    const adminAddEmail = email();
    const adminAddRes = await api('POST', '/api/admin/newsletter/subscribers', { email: adminAddEmail, first_name: 'AdminAdded' });
    check('admin-add: 200 success', adminAddRes.status === 200 && adminAddRes.body.success, JSON.stringify(adminAddRes.body));
    const adminAdded = await one('SELECT status, active FROM newsletter_subscribers WHERE LOWER(email)=LOWER(?)', [adminAddEmail]);
    check('admin-add exemption: immediately active, no confirmation step', adminAdded && adminAdded.status === 'active' && adminAdded.active === 1, JSON.stringify(adminAdded));
    const adminAddConfirmMail = await queued('%Confirm Your Subscription%', adminAddEmail);
    check('admin-add exemption: no confirmation email queued', !adminAddConfirmMail, JSON.stringify(adminAddConfirmMail));

    // ── Admin "Activate" override on a still-pending subscriber fires the welcome email ──
    const overrideEmail = email();
    await pub('POST', '/api/public/subscribe', { email: overrideEmail, popia_consent: true, first_name: 'Override' });
    await sleep(100);
    const overrideSub = await one('SELECT subscriber_id FROM newsletter_subscribers WHERE LOWER(email)=LOWER(?)', [overrideEmail]);
    const overrideRes = await api('PUT', `/api/admin/newsletter/subscribers/${overrideSub.subscriber_id}/status`, { status: 'active' });
    check('admin override: PUT .../status 200', overrideRes.status === 200 && overrideRes.body.success, JSON.stringify(overrideRes.body));
    await sleep(100);
    const overridden = await one('SELECT status, active, confirmed_at FROM newsletter_subscribers WHERE subscriber_id=?', [overrideSub.subscriber_id]);
    check('admin override: flipped to active with confirmed_at set', overridden && overridden.status === 'active' && overridden.active === 1 && !!overridden.confirmed_at, JSON.stringify(overridden));
    const overrideWelcome = await queued("Welcome to Thabiso Mhlongo's Newsletter!", overrideEmail);
    check('admin override: welcome email fired on force-activation', !!overrideWelcome, JSON.stringify(overrideWelcome));

    // ── Dormant segment: subscribed long ago + never booked vs. subscribed long ago + booked vs. recent ──
    async function countDormant(days) {
        const r = await api('GET', `/api/admin/newsletter/campaigns/audience-count?segment=dormant&segment_value=${days}`);
        return r.body.count;
    }
    const dormantBase = await countDormant(180);

    const dormantEmail = email();
    await run(`INSERT INTO newsletter_subscribers (email, status, active, unsubscribe_token, source, first_name, subscribed_at)
               VALUES (?, 'active', 1, ?, 'index.html', 'Dormant', datetime('now', '-200 days'))`,
        [dormantEmail, 'tok-' + dormantEmail]);
    const afterDormant = await countDormant(180);
    check('dormant segment: old + never-booked subscriber counted', afterDormant === dormantBase + 1, `${dormantBase} -> ${afterDormant}`);

    const bookedDormantEmail = email();
    await run(`INSERT INTO newsletter_subscribers (email, status, active, unsubscribe_token, source, first_name, subscribed_at)
               VALUES (?, 'active', 1, ?, 'index.html', 'BookedDormant', datetime('now', '-200 days'))`,
        [bookedDormantEmail, 'tok-' + bookedDormantEmail]);
    await run(`INSERT INTO bookings (name, email, cell, date, event_location, event_type, message, status)
               VALUES ('Dormant Booker', ?, '0820000001', '2027-06-01', 'Test Venue', 'Corporate', 'Dormant segment test booking', 'CONFIRMED')`,
        [bookedDormantEmail]);
    const afterBooked = await countDormant(180);
    check('dormant segment: old but booked subscriber excluded', afterBooked === afterDormant, `${afterDormant} -> ${afterBooked}`);

    const recentEmail = email();
    await run(`INSERT INTO newsletter_subscribers (email, status, active, unsubscribe_token, source, first_name, subscribed_at)
               VALUES (?, 'active', 1, ?, 'index.html', 'Recent', datetime('now', '-10 days'))`,
        [recentEmail, 'tok-' + recentEmail]);
    const afterRecent = await countDormant(180);
    check('dormant segment: recent (10d) subscriber excluded at 180-day threshold', afterRecent === afterBooked, `${afterBooked} -> ${afterRecent}`);

    const afterRecentShortThreshold = await countDormant(5);
    check('dormant segment: same recent (10d) subscriber IS included at a 5-day threshold', afterRecentShortThreshold >= afterBooked + 1, `${afterBooked} -> ${afterRecentShortThreshold}`);
};
