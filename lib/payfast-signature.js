// Phase 5 (HOUSEKEEPING-NOTES.md): moved from app.js verbatim, byte-identical. Shared by the public
// /:id/pay route (signs the outgoing redirect) and the PayFast ITN webhook (verifies the inbound
// notification's signature) — the ITN webhook stays in app.js for now, so app.js re-imports this too.
const crypto = require('crypto');

function generatePayFastSignature(pfData, passPhrase = null) {
    let pfOutput = '';
    for (let key in pfData) {
        if (pfData.hasOwnProperty(key) && pfData[key] !== '') {
            const val = pfData[key].toString().trim();
            const encoded = encodeURIComponent(val).replace(/%20/g, "+");
            const upperEncoded = encoded.replace(/%[0-9a-fA-F]{2}/g, match => match.toUpperCase());
            pfOutput += `${key}=${upperEncoded}&`;
        }
    }
    let getString = pfOutput.slice(0, -1);
    if (passPhrase && passPhrase.trim() !== '') {
        const encodedPass = encodeURIComponent(passPhrase.trim()).replace(/%20/g, "+");
        const upperPass = encodedPass.replace(/%[0-9a-fA-F]{2}/g, match => match.toUpperCase());
        getString += `&passphrase=${upperPass}`;
    }
    return crypto.createHash("md5").update(getString).digest("hex");
}

module.exports = { generatePayFastSignature };
