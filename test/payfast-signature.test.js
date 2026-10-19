// PayFast signatures, checked against a literal port of PayFast's own documented PHP (developers.payfast.co.za/docs):
//   CHECKOUT form  - generateSignature(): skip blank variables, urlencode(trim(value)), "&passphrase=" + urlencode(trim(passphrase)) when set, md5.
//   ITN (the notification PayFast posts back) - pfParamString: EVERY posted field except "signature" in the order received - blank ones included
//                  ("The string that gets created needs to include all fields posted from Payfast") - urlencode(value), then the passphrase, md5.
// PHP's urlencode() encodes everything except letters, digits and - _ . (space -> +, hex in upper case); JavaScript's encodeURIComponent leaves
// ! ' ( ) * ~ alone, so a surname like O'Brien signed differently.
// What this guards (found by running a payment through PayFast's real sandbox, 2026-10-19): every REAL ITN carries blank fields (item_description,
// custom_str1-5, custom_int1-5) and the app verified it with the checkout recipe, which drops them - so in production, where a signature mismatch
// is a hard reject, every genuine payment notification would have been thrown away and the client charged but the booking left unpaid.
// The module is pure (crypto only), so it is tested directly.
const crypto = require('crypto');
const { generatePayFastSignature, generatePayFastItnSignature, verifyPayFastItnSignature, phpUrlencode } = require('../lib/payfast-signature');

// ── the reference: a literal port of the documented PHP, written independently of the module under test ──
const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex');
const phpUrlencodeRef = (s) => {
    let out = '';
    for (const byte of Buffer.from(String(s), 'utf8')) {
        const ch = String.fromCharCode(byte);
        if (/[A-Za-z0-9\-_.]/.test(ch)) out += ch;
        else if (ch === ' ') out += '+';
        else out += '%' + byte.toString(16).toUpperCase().padStart(2, '0');
    }
    return out;
};
const phpTrim = (s) => String(s).replace(/^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g, '');
function docsCheckoutSignature(data, passPhrase = null) {            // generateSignature($data, $passPhrase)
    let pfOutput = '';
    for (const [key, val] of Object.entries(data)) if (val !== '') pfOutput += `${key}=${phpUrlencodeRef(phpTrim(val))}&`;
    let getString = pfOutput.slice(0, -1);
    if (passPhrase !== null) getString += `&passphrase=${phpUrlencodeRef(phpTrim(passPhrase))}`;
    return md5(getString);
}
function docsItnSignature(posted, passPhrase = null) {              // the ITN's $pfParamString + pfValidSignature()
    let pfParamString = '';
    for (const [key, val] of Object.entries(posted)) { if (key !== 'signature') pfParamString += `${key}=${phpUrlencodeRef(val)}&`; else break; }
    pfParamString = pfParamString.slice(0, -1);
    if (passPhrase !== null) pfParamString += `&passphrase=${phpUrlencodeRef(passPhrase)}`;
    return md5(pfParamString);
}

// a notification exactly as PayFast sent it to the sandbox rig: blank fields in the middle, signature last
const REAL_ITN = () => ({
    m_payment_id: '1_SCHED1', pf_payment_id: '3458978', payment_status: 'COMPLETE', item_name: 'Booking 1 - PayFast sandbox rig - 50 Deposit', item_description: '',
    amount_gross: '2500.00', amount_fee: '-57.50', amount_net: '2442.50',
    custom_str1: '', custom_str2: '', custom_str3: '', custom_str4: '', custom_str5: '', custom_int1: '', custom_int2: '', custom_int3: '', custom_int4: '', custom_int5: '',
    name_first: 'Sandbox', name_last: 'Client', email_address: 'rig.payfast@example.invalid', merchant_id: '10000100'
});
const signed = (payload, pass) => ({ ...payload, signature: docsItnSignature(payload, pass) });

module.exports = async function ({ check }) {
    const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

    // ── encoding ──
    eq('urlencode: ! \' ( ) * ~ are encoded like PHP (JavaScript leaves them)', phpUrlencode("O'Brien (Jr) *!~"), phpUrlencodeRef("O'Brien (Jr) *!~"));
    eq('urlencode: spaces become +, @ : / & + % are encoded, hex is upper case', phpUrlencode('a b@c.com http://x/y?z=1&q=2+3 100%'), phpUrlencodeRef('a b@c.com http://x/y?z=1&q=2+3 100%'));
    eq('urlencode: non-ASCII is encoded as UTF-8 bytes', phpUrlencode('Nkosinathi Mhlongo – Zürich'), phpUrlencodeRef('Nkosinathi Mhlongo – Zürich'));

    // ── the checkout signature (what we send PayFast) ──
    const checkout = { merchant_id: '10000100', merchant_key: '46f0cd694581a', return_url: 'http://localhost:3000/?track=7&payment=success', cancel_url: 'http://localhost:3000/?track=7&payment=cancel',
        notify_url: 'http://localhost:3000/api/payment/webhook/payfast', name_first: 'Thandi', name_last: "D'Souza", email_address: "thandi.d'souza+gigs@example.com",
        m_payment_id: '7_SCHED3', amount: '2500.00', item_name: 'Booking 7 - Gala dinner - 50 Deposit' };
    for (const pass of [null, 'My-Pass_phrase.1']) {
        const label = pass ? 'with a passphrase' : 'without a passphrase';
        eq(`checkout signature ${label}: identical to PayFast's documented PHP (apostrophes in the name and e-mail included)`, generatePayFastSignature(checkout, pass), docsCheckoutSignature(checkout, pass));
    }
    eq('checkout signature: blank variables are left out, exactly as documented', generatePayFastSignature({ ...checkout, item_description: '', custom_str1: '' }, null), docsCheckoutSignature(checkout, null));
    eq('checkout signature: values are trimmed, an empty or blank passphrase is ignored', generatePayFastSignature({ ...checkout, name_first: '  Thandi  ' }, '   '), docsCheckoutSignature(checkout, null));
    eq('checkout signature: a name with parentheses and an asterisk', generatePayFastSignature({ ...checkout, name_last: 'Mokoena (Jr) *' }, 'abc'), docsCheckoutSignature({ ...checkout, name_last: 'Mokoena (Jr) *' }, 'abc'));

    // ── the ITN signature (what PayFast sends us) ──
    for (const pass of [null, 'My-Pass_phrase.1']) {
        const label = pass ? 'with a passphrase' : 'without a passphrase';
        const itn = signed(REAL_ITN(), pass);
        eq(`ITN ${label}: our recomputation equals PayFast's documented one`, generatePayFastItnSignature(REAL_ITN(), pass), itn.signature);
        const v = verifyPayFastItnSignature(itn, pass);
        check(`ITN ${label}: a genuine notification (blank fields and all) verifies`, v.valid === true && v.recipe === 'documented', JSON.stringify(v));
        check(`ITN ${label}: the same notification with a changed amount is refused`, verifyPayFastItnSignature({ ...itn, amount_gross: '25.00' }, pass).valid === false, 'accepted a tampered amount');
        check(`ITN ${label}: a wrong signature is refused`, verifyPayFastItnSignature({ ...itn, signature: '0'.repeat(32) }, pass).valid === false, 'accepted a wrong signature');
        check(`ITN ${label}: a missing signature is refused`, verifyPayFastItnSignature({ ...REAL_ITN() }, pass).valid === false, 'accepted a missing signature');
    }
    check('ITN: signed with a passphrase but verified with the wrong one -> refused', verifyPayFastItnSignature(signed(REAL_ITN(), 'right-one'), 'wrong-one').valid === false, 'accepted');
    check('ITN: a name with an apostrophe still verifies (PHP-style encoding)', verifyPayFastItnSignature(signed({ ...REAL_ITN(), name_last: "D'Souza (Jr)" }, 'pp'), 'pp').valid === true, 'rejected a genuine notification');
    // the defect this guards: the checkout recipe drops blank fields, so it can never reproduce a real ITN's signature
    check('REGRESSION: the checkout recipe (blank fields dropped) does NOT reproduce a real ITN signature - verifying with it threw genuine payments away',
        generatePayFastSignature(REAL_ITN(), 'My-Pass_phrase.1') !== signed(REAL_ITN(), 'My-Pass_phrase.1').signature, 'the two recipes agree on a payload with blank fields');
    // backward compatibility: a notification signed the way this app used to compute it (blank fields skipped) is still accepted
    const legacy = { ...REAL_ITN() };
    legacy.signature = generatePayFastSignature(REAL_ITN(), 'My-Pass_phrase.1');
    const lv = verifyPayFastItnSignature(legacy, 'My-Pass_phrase.1');
    check('ITN: a notification signed the previous way (blank fields skipped) is still accepted, and reported as such', lv.valid === true && lv.recipe === 'legacy', JSON.stringify(lv));
    // field order matters: PayFast signs the fields in the order it posted them
    const reordered = signed(REAL_ITN(), null);
    const shuffled = { ...Object.fromEntries(Object.entries(reordered).filter(([k]) => k !== 'signature').reverse()), signature: reordered.signature };
    check('ITN: the signature depends on field order (a reordered body does not verify)', verifyPayFastItnSignature(shuffled, null).valid === false, 'order ignored');
};
