const crypto = require('crypto');

// Ozow Payments API (hosted checkout): signature generation, notification verification,
// and payment request builder.  Mirrors the PayFast pattern (lib/payfast-signature.js).
//
// Docs: https://hub.ozow.com/integration-methods/apis/deprecated-integrations/hosted-checkout/
// Hash algorithm: SHA-512 of the lowercase concatenation of fields (in a fixed order) + private key.

const sha512 = (s) => crypto.createHash('sha512').update(s).digest('hex');

// ─── credentials ───────────────────────────────────────────────────────────────
// DB settings take precedence (the admin screen), env vars are the fallback.
function ozowCreds(env) {
    env = env || process.env;
    return {
        siteCode:   env.OZOW_SITE_CODE   || '',
        privateKey: env.OZOW_PRIVATE_KEY  || '',
        apiKey:     env.OZOW_API_KEY      || '',
        isTest:     (env.OZOW_TEST_MODE || 'false').toLowerCase() === 'true'
    };
}

// ─── request hash ──────────────────────────────────────────────────────────────
// Field order per Ozow docs — only fields with a value are included, the private
// key is appended, the whole thing is lowercased, then SHA-512'd.
const REQUEST_HASH_FIELDS = [
    'siteCode', 'countryCode', 'currencyCode', 'amount', 'transactionReference',
    'bankReference', 'optional1', 'optional2', 'optional3', 'optional4', 'optional5',
    'customer', 'cancelUrl', 'errorUrl', 'successUrl', 'notifyUrl', 'isTest',
    'selectedBankId', 'bankAccountNumber', 'branchCode', 'bankAccountName',
    'payeeDisplayName', 'expiryDateUtc', 'allowVariableAmount', 'variableAmountMin',
    'variableAmountMax', 'customerIdentifier', 'customerCellphoneNumber'
];

function generateRequestHash(fields, privateKey) {
    let concat = '';
    for (const key of REQUEST_HASH_FIELDS) {
        const val = fields[key];
        if (val !== undefined && val !== null && val !== '') {
            concat += String(val);
        }
    }
    concat += privateKey;
    return sha512(concat.toLowerCase());
}

// ─── notification hash ─────────────────────────────────────────────────────────
// Different field order from the request hash.  Empty fields are SKIPPED.
const NOTIFY_HASH_FIELDS = [
    'SiteCode', 'TransactionId', 'TransactionReference', 'Amount', 'Status',
    'Optional1', 'Optional2', 'Optional3', 'Optional4', 'Optional5',
    'CurrencyCode', 'IsTest', 'StatusMessage'
];

function generateNotificationHash(posted, privateKey) {
    let concat = '';
    for (const key of NOTIFY_HASH_FIELDS) {
        const val = posted[key];
        if (val !== undefined && val !== null && val !== '') {
            concat += String(val);
        }
    }
    concat += privateKey;
    return sha512(concat.toLowerCase());
}

function verifyNotificationHash(posted, privateKey) {
    const received = String((posted && posted.Hash) || '');
    if (!received) return { valid: false };
    const expected = generateNotificationHash(posted, privateKey);
    if (received.length !== expected.length || received.length === 0) return { valid: false };
    const valid = crypto.timingSafeEqual(
        Buffer.from(received.toLowerCase()),
        Buffer.from(expected.toLowerCase())
    );
    return { valid };
}

// ─── payment request builder ───────────────────────────────────────────────────
// Returns { requestBody, apiUrl, apiKey } ready for a server-side POST.
function buildOzowPaymentRequest(opts, env) {
    env = env || process.env;
    const creds = ozowCreds(env);
    const baseUrl = ozowBaseUrl(null, env);

    const amount = parseFloat(opts.amount).toFixed(2);
    const fields = {
        siteCode:             creds.siteCode,
        countryCode:          'ZA',
        currencyCode:         'ZAR',
        amount:               amount,
        transactionReference: opts.transactionReference,
        bankReference:        (opts.bankReference || opts.transactionReference).substring(0, 20),
        cancelUrl:            opts.cancelUrl  || `${baseUrl}/?track=${opts.bookingId}&payment=cancel&gateway=ozow`,
        errorUrl:             opts.errorUrl   || `${baseUrl}/?track=${opts.bookingId}&payment=error&gateway=ozow`,
        successUrl:           opts.successUrl || `${baseUrl}/?track=${opts.bookingId}&payment=success&gateway=ozow`,
        notifyUrl:            opts.notifyUrl  || `${baseUrl}/api/payment/webhook/ozow`,
        isTest:               creds.isTest
    };

    if (opts.customer)    fields.customer = opts.customer;
    if (opts.optional1)   fields.optional1 = opts.optional1;

    fields.hashCheck = generateRequestHash(fields, creds.privateKey);

    const isTest = creds.isTest;
    const apiUrl = isTest
        ? 'https://stagingapi.ozow.com/postpaymentrequest'
        : 'https://api.ozow.com/postpaymentrequest';

    return { requestBody: fields, apiUrl, apiKey: creds.apiKey };
}

// ─── base URL ──────────────────────────────────────────────────────────────────
// Mirrors payfastBaseUrl: OZOW_BASE_URL overrides BASE_URL for Ozow's callback
// URLs only, so a local dev can point callbacks at a tunnel while emails still
// carry the live domain.
function ozowBaseUrl(req, env) {
    env = env || process.env;
    const explicit = String(env.OZOW_BASE_URL || '').trim();
    if (explicit) return explicit.replace(/\/$/, '');
    const base = String(env.BASE_URL || '').trim();
    if (base) return base.replace(/\/$/, '');
    if (!req) return 'http://localhost:3000';
    const proto = req.get('x-forwarded-proto') || req.protocol;
    const host = req.get('x-forwarded-host') || req.get('host');
    return `${proto}://${host}`;
}

// ─── status helpers ────────────────────────────────────────────────────────────
const OZOW_COMPLETE_STATUS = 'Complete';
const OZOW_CANCELLED_STATUS = 'Cancelled';
const OZOW_ERROR_STATUS = 'Error';
const OZOW_PENDING_STATUS = 'PendingInvestigation';

function isOzowComplete(status) { return String(status) === OZOW_COMPLETE_STATUS; }
function isOzowCancelled(status) { return String(status) === OZOW_CANCELLED_STATUS; }
function isOzowError(status) { return String(status) === OZOW_ERROR_STATUS; }
function isOzowPending(status) { return String(status) === OZOW_PENDING_STATUS; }

// ─── transaction status lookup ─────────────────────────────────────────────────
// GET https://api.ozow.com/GetTransactionByReference?siteCode=X&transactionReference=Y
// Header: ApiKey
async function getTransactionStatus(transactionReference, env) {
    env = env || process.env;
    const creds = ozowCreds(env);
    const host = creds.isTest ? 'stagingapi.ozow.com' : 'api.ozow.com';
    const url = `https://${host}/GetTransactionByReference?siteCode=${encodeURIComponent(creds.siteCode)}&transactionReference=${encodeURIComponent(transactionReference)}`;
    const res = await fetch(url, {
        headers: { 'ApiKey': creds.apiKey, 'Accept': 'application/json' }
    });
    if (!res.ok) throw new Error(`Ozow status lookup failed: HTTP ${res.status}`);
    return res.json();
}

module.exports = {
    ozowCreds,
    generateRequestHash,
    generateNotificationHash,
    verifyNotificationHash,
    buildOzowPaymentRequest,
    ozowBaseUrl,
    isOzowComplete, isOzowCancelled, isOzowError, isOzowPending,
    getTransactionStatus,
    OZOW_COMPLETE_STATUS, OZOW_CANCELLED_STATUS, OZOW_ERROR_STATUS, OZOW_PENDING_STATUS,
    REQUEST_HASH_FIELDS, NOTIFY_HASH_FIELDS
};
