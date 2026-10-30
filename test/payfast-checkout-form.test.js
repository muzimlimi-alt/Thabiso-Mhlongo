// The booking checkout form moved into lib/payfast-signature.js buildPayfastCheckout() (shared with ticket orders). This proves the booking
// path builds EXACTLY what it built before: below is a frozen copy of the inline code routes/public/bookings.js had until 2026-10-30, and
// for a spread of awkward inputs and settings the helper must give the same fields, in the same order, with the same signature and host.
// No server, no database (lib/payfast-signature.js opens none).
const { buildPayfastCheckout, generatePayFastSignature, payfastItemName } = require('../lib/payfast-signature');

// ---- frozen copy of the pre-2026-10-30 booking code (routes/public/bookings.js buildAndSendPfData), env made explicit ----
function legacyBookingForm(f, env) {
    const pfData = {
        merchant_id: env.PAYFAST_MERCHANT_ID || '10000100',
        merchant_key: env.PAYFAST_MERCHANT_KEY || '46f0cd694581a',
        return_url: f.return_url, cancel_url: f.cancel_url, notify_url: f.notify_url,
        name_first: f.name_first, name_last: f.name_last, email_address: f.email_address,
        m_payment_id: f.m_payment_id, amount: f.amount,
        item_name: f.item_name.substring(0, 100).replace(/[^a-zA-Z0-9.\-% ]/g, '').replace(/\s+/g, ' ')
    };
    Object.keys(pfData).forEach(key => { if (pfData[key] === '' || pfData[key] === null || pfData[key] === undefined) delete pfData[key]; });
    const passphrase = env.PAYFAST_PASSPHRASE || null;
    pfData.signature = generatePayFastSignature(pfData, passphrase);
    return { pfData, pfHost: env.PAYFAST_URL || 'https://sandbox.payfast.co.za/eng/process' };
}

module.exports = async function ({ check }) {
    const base = 'https://www.example.invalid';
    const cases = [
        { name: 'an ordinary deposit', f: { name_first: 'Thandi', name_last: 'Mokoena', email_address: 'thandi@example.invalid', m_payment_id: '100054_DEPOSIT', amount: '2500.00', item_name: 'Booking 100054 - Year-end Function - 50% Deposit' } },
        { name: 'apostrophes, ampersands and brackets (the PHP-urlencode characters)', f: { name_first: "D'Souza", name_last: 'Smith & Sons (Pty)', email_address: "o'brien@example.invalid", m_payment_id: '7_SCHED88', amount: '10.05', item_name: "Booking 7 - O'Brien's *Gala* ~ (Final!) - Balance" } },
        { name: 'a blank surname and e-mail (dropped, not signed)', f: { name_first: 'Cher', name_last: '', email_address: '', m_payment_id: '9_FULL', amount: '5.00', item_name: 'Booking 9 - Event - Full' } },
        { name: 'an item name over 100 characters', f: { name_first: 'A', name_last: 'B', email_address: 'a@b.invalid', m_payment_id: '1_FULL', amount: '99999.99', item_name: 'Booking 1 - ' + 'Very long event name '.repeat(8) + ' - Full' } },
        { name: 'an item name that cleans down to nothing', f: { name_first: 'A', name_last: 'B', email_address: 'a@b.invalid', m_payment_id: '2_FULL', amount: '1.00', item_name: '###' } }
    ].map(c => ({ ...c, f: { return_url: `${base}/?track=1&payment=success`, cancel_url: `${base}/?track=1&payment=cancel`, notify_url: `${base}/api/payment/webhook/payfast`, ...c.f } }));
    const envs = [
        { label: 'no settings (public test merchant, sandbox)', env: {} },
        { label: 'own merchant + passphrase + live URL', env: { PAYFAST_MERCHANT_ID: '10099999', PAYFAST_MERCHANT_KEY: 'k3y', PAYFAST_PASSPHRASE: "pass phrase'(!)", PAYFAST_URL: 'https://www.payfast.co.za/eng/process' } }
    ];
    for (const { label, env } of envs) {
        for (const c of cases) {
            const a = legacyBookingForm(c.f, env);
            const b = buildPayfastCheckout(c.f, env);
            check(`booking checkout unchanged - ${c.name}, ${label}: same fields, same ORDER, same signature, same host`,
                JSON.stringify(Object.entries(a.pfData)) === JSON.stringify(Object.entries(b.pfData)) && a.pfHost === b.pfHost,
                JSON.stringify({ legacy: a, helper: b }).slice(0, 600));
        }
    }
    check('the item-name clean-up is idempotent (applying it to an already-clean name changes nothing)', payfastItemName(payfastItemName("O'Brien's *Gala* 50% Deposit")) === payfastItemName("O'Brien's *Gala* 50% Deposit"), payfastItemName("O'Brien's *Gala* 50% Deposit"));
};
