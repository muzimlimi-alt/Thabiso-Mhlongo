// The ITN webhook's signature verdict, through the real route. The webhook logs a FAILED_SIGNATURE event when the notification's signature does not match
// (production then rejects it; sandbox mode logs and carries on, so this event is what shows the verdict here). A notification built like PayFast's own -
// every field incl. the blank ones (item_description, custom_str1-5, custom_int1-5), signed per PayFast's documented recipe - must NOT raise it; a bad one must.
// It used to be raised for EVERY real notification (the check dropped the blank fields), which in production meant genuine payments were rejected.
// The recipes themselves are pinned against a port of PayFast's PHP in payfast-signature.test.js. The test server runs the sandbox with the merchant 10000100
// and NO passphrase (test/support.js), which is what is signed with below.
const { api, pub, one, q, future, sleep, getTrackingToken } = require('./support');
const { generatePayFastItnSignature } = require('../lib/payfast-signature');

const SVC = 15;                         // 'Travel Buyout – Gauteng': an active flat-fee service (see booking.test.js)
const MERCHANT_ID = '10000100';
const email = () => `pfitnsig.${Date.now()}.${Math.floor(Math.random() * 1e6)}@example.invalid`;

async function acceptedBooking(days, amount) {
    const em = email();
    const created = await api('POST', '/api/admin/bookings', { name: 'PF ITN Signature Test', email: em, cell: '+27821234567', event_date: future(days), event_name: 'PF ITN signature event',
        event_type: 'Corporate', event_location: 'Test Hall', message: 'PayFast ITN signature integration test booking.', services: [{ service_id: SVC }], status: 'NEW', override_working_hours: true });
    const id = created.body && created.body.booking_id;
    await sleep(50);
    const bk = await one('SELECT date FROM bookings WHERE id = ?', [id]);
    const expiry = new Date(Date.parse(bk.date) - 10 * 86400000).toISOString().slice(0, 10);
    await api('POST', `/api/admin/bookings/${id}/quote`, { quote_expiry_date: expiry, terms: 'T', apply_vat: false, discount: 0, items: [{ service_id: SVC, description: 'Travel Buyout – Gauteng', quantity: 1, unit_price: amount }] });
    await pub('POST', `/api/public/bookings/${id}/accept-quote`, { access_token: await getTrackingToken(id, em), terms_agreed: true });
    return id;
}

// the notification as PayFast sends it: this field order, blank fields present, signature last
const realShapedItn = (bookingId, amount, pfPaymentId) => ({
    m_payment_id: `${bookingId}_FULL`, pf_payment_id: String(pfPaymentId), payment_status: 'COMPLETE', item_name: `Booking ${bookingId} - PF ITN signature event - Full`, item_description: '',
    amount_gross: amount.toFixed(2), amount_fee: '-23.00', amount_net: (amount - 23).toFixed(2),
    custom_str1: '', custom_str2: '', custom_str3: '', custom_str4: '', custom_str5: '', custom_int1: '', custom_int2: '', custom_int3: '', custom_int4: '', custom_int5: '',
    // every character the app's request sanitiser rewrites (& < > ' ") - PayFast signs the notification as it posted it, not as that sanitiser leaves it
    name_first: 'A&B <Events> "Ltd"', name_last: "O'Brien", email_address: 'pfitnsig@example.invalid', merchant_id: MERCHANT_ID
});

async function waitFor(fn, ms = 20000) { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(250); } return false; }
const events = async (id) => (await q('SELECT event_type FROM payment_logs WHERE booking_id = ? ORDER BY id', [id])).map((r) => r.event_type);

module.exports = async function ({ check }) {
    // ── a genuine-shaped notification, signed the documented way ──
    const good = await acceptedBooking(1700, 1000);
    const itn = realShapedItn(good, 1000, `SIG-GOOD-${Date.now()}`);
    itn.signature = generatePayFastItnSignature(itn, null);
    const r1 = await pub('POST', '/api/payment/webhook/payfast', itn);
    check('a PayFast-shaped notification (blank fields included) is acknowledged with 200', r1.status === 200, `${r1.status}`);
    await waitFor(async () => (await one('SELECT COUNT(*) c FROM transactions WHERE booking_id = ? AND source = ?', [good, 'payfast'])).c >= 1);
    let ev = await events(good);
    check('it is recorded as a payment', (await one('SELECT COUNT(*) c FROM transactions WHERE booking_id = ? AND source = ?', [good, 'payfast'])).c === 1, ev.join(','));
    check('...and its signature is accepted: no FAILED_SIGNATURE event (it was raised for every real notification before)', ev.includes('ITN_RECEIVED') && !ev.includes('FAILED_SIGNATURE'), ev.join(','));
    // what is STORED is still the encoded copy (the app's request sanitiser protects every later screen that shows it)
    const logged = await one(`SELECT raw_payload FROM payment_logs WHERE booking_id = ? AND event_type = 'ITN_RECEIVED' ORDER BY id LIMIT 1`, [good]);
    check('...while the stored copy of the notification stays entity-encoded (no raw "<Events>" reaches the database)', !!logged && !/<Events>/.test(logged.raw_payload) && /&lt;Events&gt;/.test(logged.raw_payload) && /&amp;/.test(logged.raw_payload), logged && logged.raw_payload.slice(0, 400));

    // ── the same notification with a tampered amount keeps the original signature ──
    const bad = await acceptedBooking(1701, 1000);
    const forged = realShapedItn(bad, 1000, `SIG-BAD-${Date.now()}`);
    forged.signature = generatePayFastItnSignature(forged, null);
    forged.amount_gross = '1.00';                       // changed after signing
    await pub('POST', '/api/payment/webhook/payfast', forged);
    await waitFor(async () => (await events(bad)).includes('FAILED_SIGNATURE'));
    ev = await events(bad);
    check('a notification whose amount was changed after signing raises FAILED_SIGNATURE', ev.includes('FAILED_SIGNATURE'), ev.join(','));

    // ── what the buyer sees on PayFast's page: the checkout we send carries the client's name and the item as PEOPLE wrote them ──
    // (the database holds them entity-encoded - O&#x27;Brien, Smith &amp; Sons - which is not for PayFast's page or its receipt e-mail; and "50% Deposit" lost its %)
    {
        const em = email();
        const created = await api('POST', '/api/admin/bookings', { name: "Pat O'Brien", email: em, cell: '+27821234567', event_date: future(1703), event_name: 'Smith & Sons Gala',
            event_type: 'Corporate', event_location: 'Test Hall', message: 'PayFast checkout fields integration test booking.', services: [{ service_id: SVC }], status: 'NEW', override_working_hours: true });
        const id = created.body && created.body.booking_id;
        await sleep(50);
        const bk = await one('SELECT date FROM bookings WHERE id = ?', [id]);
        const expiry = new Date(Date.parse(bk.date) - 10 * 86400000).toISOString().slice(0, 10);
        await api('POST', `/api/admin/bookings/${id}/quote`, { quote_expiry_date: expiry, terms: 'T', apply_vat: false, discount: 0, items: [{ service_id: SVC, description: 'Travel Buyout – Gauteng', quantity: 1, unit_price: 1000 }] });
        const token = await getTrackingToken(id, em);
        await pub('POST', `/api/public/bookings/${id}/accept-quote`, { access_token: token, terms_agreed: true });
        const pay = await pub('POST', `/api/public/bookings/${id}/pay`, { access_token: token, payment_type: 'DEPOSIT' });
        const pf = (pay.body && pay.body.pfData) || {};
        check('the checkout is built for a booking whose client and event have special characters', pay.status === 200 && !!pf.signature, JSON.stringify(pay.body).slice(0, 200));
        check('the client\'s name goes to PayFast as written (Pat / O\'Brien), not as stored (O&#x27;Brien)', pf.name_first === 'Pat' && pf.name_last === "O'Brien", `${pf.name_first} | ${pf.name_last}`);
        check('the item name reads "Smith Sons Gala" - the ampersand goes, no stray "amp" is left behind', /Smith Sons Gala/.test(pf.item_name || '') && !/\bamp\b/.test(pf.item_name || ''), pf.item_name);
        check('a "50% Deposit" milestone keeps its percent sign on the PayFast page', /50% /.test(pf.item_name || ''), pf.item_name);
    }

    // ── a notification with no signature at all ──
    const none = await acceptedBooking(1702, 1000);
    const unsigned = realShapedItn(none, 1000, `SIG-NONE-${Date.now()}`);
    await pub('POST', '/api/payment/webhook/payfast', unsigned);
    await waitFor(async () => (await events(none)).includes('FAILED_SIGNATURE'));
    ev = await events(none);
    check('a notification with no signature raises FAILED_SIGNATURE', ev.includes('FAILED_SIGNATURE'), ev.join(','));
};
