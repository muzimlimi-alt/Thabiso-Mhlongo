// The checks every PayFast notification (ITN) goes through, whatever it pays for - a booking (routes/public/payment.js) or a ticket order
// (lib/ticketing-payments.js). Moved out of the booking ITN handler unchanged so both use the one copy; that handler still runs them in the
// order it always did. The signature itself is lib/payfast-signature.js verifyPayFastItnSignature; the source-address allowlist and the ITN
// rate limiter are middleware/rate-limiters.js.

// PayFast's sandbox is in use when PAYFAST_URL names it (there is no separate switch).
const isSandboxPayfast = (env = process.env) => (env.PAYFAST_URL || '').includes('sandbox');

// P3-15: timestamp replay protection - in production an ITN older than 30 minutes is refused. { stale, ageMins }.
function itnTimestampCheck(pfData, isSandbox, now = Date.now()) {
    if (isSandbox || !pfData || !pfData.timestamp) return { stale: false, ageMins: null };
    const itnTime = new Date(pfData.timestamp);
    const ageMins = (now - itnTime.getTime()) / 60000;
    return { stale: isNaN(itnTime.getTime()) || ageMins > 30, ageMins };
}

// Use req.ip, not the raw X-Forwarded-For header. `app.set('trust proxy', 1)` is configured, so Express resolves req.ip from the trusted
// proxy hop. Reading X-Forwarded-For directly and taking its leftmost value let a caller spoof an allowlisted PayFast IP with a header,
// which would defeat the source check entirely.
const itnSourceIp = (req) => (req.ip || req.connection.remoteAddress || '').split(',')[0].trim().replace('::ffff:', '');

// PayFast server confirmation (POST BACK to /eng/query/validate): resolves true only when PayFast answers "VALID".
// Include BOTH payload AND signature for the validation POST, per PayFast's requirements, AS POSTED - PayFast compares these with what it
// sent, and the entity-encoded copy (app.js deepEscapeBody) would not match a name like D'Souza.
async function confirmItnWithPayfast(itnAsPosted, isSandbox) {
    const pfValidateHost = isSandbox
        ? 'https://sandbox.payfast.co.za/eng/query/validate'
        : 'https://www.payfast.co.za/eng/query/validate';

    let validateParams = [];
    for (let key in itnAsPosted) {
        validateParams.push(`${key}=${encodeURIComponent(itnAsPosted[key]).replace(/%20/g, '+')}`);
    }
    const validateBody = validateParams.join('&');

    let pfServerValid = false;
    try {
        const https = require('https');
        const urlModule = require('url');
        const parsedUrl = urlModule.parse(pfValidateHost);

        pfServerValid = await new Promise((resolve) => {
            const options = {
                hostname: parsedUrl.hostname, port: 443, path: parsedUrl.path, method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(validateBody), 'connection': 'close' },
                rejectUnauthorized: !isSandbox,
                timeout: 8000
            };
            const request = https.request(options, (response) => {
                let data = '';
                response.on('data', (chunk) => data += chunk);
                response.on('end', () => resolve(data.trim() === 'VALID'));
            });
            request.on('timeout', () => { request.destroy(); resolve(false); });
            request.on('error', () => resolve(false));
            request.write(validateBody);
            request.end();
        });
    } catch (serverErr) {
        console.error('[PayFast ITN] Server confirmation error:', serverErr.message);
    }
    return pfServerValid;
}

module.exports = { isSandboxPayfast, itnTimestampCheck, itnSourceIp, confirmItnWithPayfast };
