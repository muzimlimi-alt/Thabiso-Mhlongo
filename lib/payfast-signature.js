// Phase 5 (HOUSEKEEPING-NOTES.md): moved from app.js verbatim, byte-identical. Shared by the public
// /:id/pay route (signs the outgoing redirect) and the PayFast ITN webhook (verifies the inbound
// notification's signature) — the ITN webhook stays in app.js for now, so app.js re-imports this too.
const crypto = require('crypto');

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

// PHP's urlencode(), which PayFast's documentation uses for every signature: everything except letters, digits and - _ . is percent-encoded (hex in
// UPPER case) and a space becomes "+". JavaScript's encodeURIComponent leaves ! ' ( ) * ~ alone, so a surname like D'Souza (or an e-mail address with
// an apostrophe) used to be signed differently from the way PayFast checks it.
function phpUrlencode(value) {
    return encodeURIComponent(String(value))
        .replace(/[!'()*~]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
        .replace(/%20/g, '+');
}

const withPassphrase = (str, passPhrase) => (passPhrase && String(passPhrase).trim() !== '' ? `${str}&passphrase=${phpUrlencode(String(passPhrase).trim())}` : str);

// OUTGOING - the signature on the checkout form we post to PayFast. PayFast's documented recipe (generateSignature): every NON-BLANK variable in the order
// it is sent, values trimmed and urlencoded, then "&passphrase=<urlencoded passphrase>" when one is set, md5.
function generatePayFastSignature(pfData, passPhrase = null) {
    let pfOutput = '';
    for (const key in pfData) {
        if (Object.prototype.hasOwnProperty.call(pfData, key) && pfData[key] !== '' && pfData[key] != null) {
            pfOutput += `${key}=${phpUrlencode(String(pfData[key]).trim())}&`;
        }
    }
    return md5(withPassphrase(pfOutput.slice(0, -1), passPhrase));
}

// INCOMING - the signature PayFast puts on the notification (ITN) it posts to us. PayFast's documented recipe (the $pfParamString of its ITN sample):
// EVERY field that was posted, in the order received, blank ones INCLUDED ("the string that gets created needs to include all fields posted from
// Payfast"), values urlencoded but not trimmed, then the passphrase when one is set, md5. That is NOT the checkout recipe above, which drops blank fields:
// a real ITN always carries blank fields (item_description, custom_str1-5, custom_int1-5), so verifying it with the checkout recipe could never succeed -
// in production, where a mismatch is a hard reject, every genuine payment notification would have been thrown away.
// Every field except "signature" is signed here (the documented loop stops at "signature", which PayFast always sends last), so anything appended after
// it cannot ride along unsigned.
function generatePayFastItnSignature(posted, passPhrase = null) {
    let str = '';
    for (const key of Object.keys(posted || {})) {
        if (key === 'signature') continue;
        str += `${key}=${phpUrlencode(posted[key] == null ? '' : posted[key])}&`;
    }
    return md5(withPassphrase(str.slice(0, -1), passPhrase));
}

// What this app computed for an ITN before 2026-10-19: the checkout recipe over the posted fields, with the old JavaScript encoding. Kept ONLY so a
// notification signed that way is still accepted (verifyPayFastItnSignature reports it as "legacy"); nothing is ever signed with it any more.
function legacyItnSignature(posted, passPhrase = null) {
    let pfOutput = '';
    for (const key in posted) {
        if (Object.prototype.hasOwnProperty.call(posted, key) && key !== 'signature' && posted[key] !== '') {
            const encoded = encodeURIComponent(String(posted[key]).trim()).replace(/%20/g, '+');
            pfOutput += `${key}=${encoded.replace(/%[0-9a-fA-F]{2}/g, (m) => m.toUpperCase())}&`;
        }
    }
    let getString = pfOutput.slice(0, -1);
    if (passPhrase && String(passPhrase).trim() !== '') {
        const encodedPass = encodeURIComponent(String(passPhrase).trim()).replace(/%20/g, '+');
        getString += `&passphrase=${encodedPass.replace(/%[0-9a-fA-F]{2}/g, (m) => m.toUpperCase())}`;
    }
    return md5(getString);
}

const sameHex = (a, b) => a.length === b.length && a.length > 0 && crypto.timingSafeEqual(Buffer.from(a.toLowerCase()), Buffer.from(b.toLowerCase()));

// Does the notification carry a valid PayFast signature? { valid, recipe } - recipe is 'documented' (PayFast's own recipe), 'legacy' (the way this app
// used to compute it) or null. Both are keyed with the passphrase, so accepting either gives nothing away; the expected value is never returned (it
// must not reach a log).
function verifyPayFastItnSignature(posted, passPhrase = null) {
    const received = String((posted && posted.signature) || '');
    if (sameHex(generatePayFastItnSignature(posted, passPhrase), received)) return { valid: true, recipe: 'documented' };
    if (sameHex(legacyItnSignature(posted, passPhrase), received)) return { valid: true, recipe: 'legacy' };
    return { valid: false, recipe: null };
}

// The public origin PayFast's return / cancel / notify URLs are built from. PAYFAST_BASE_URL wins, so a LOCAL sandbox run can point PayFast at the
// local site (or a tunnel) while BASE_URL - which names the live site in a developer's .env and feeds the links in emails - stays untouched.
// Otherwise BASE_URL, otherwise the request's own host (the forwarded one when a proxy or tunnel is in front).
function payfastBaseUrl(req, env = process.env) {
    const proto = req.get('x-forwarded-proto') || req.protocol;
    const host = req.get('x-forwarded-host') || req.get('host');
    const explicit = String(env.PAYFAST_BASE_URL || '').trim();
    return (explicit || env.BASE_URL || `${proto}://${host}`).replace(/\/$/, '');
}

module.exports = { generatePayFastSignature, generatePayFastItnSignature, verifyPayFastItnSignature, phpUrlencode, payfastBaseUrl };
