// Cloudflare Turnstile - the free "are you human?" check (no puzzles for most people; Cloudflare decides in the background).
// OFF unless BOTH keys are set (Cloudflare dashboard -> Turnstile -> add the site): TURNSTILE_SITE_KEY (public, sent to the browser) and
// TURNSTILE_SECRET_KEY (server only). Used by event ticketing before a reservation (routes/public/ticketing.js); written to be reused by
// other public forms (e.g. contact) the same way: put `requireTurnstile` in front of the route and send `turnstile_token` from the page.
// If Cloudflare itself cannot be reached, the request is let through (logged): an outage at Cloudflare must not stop ticket sales - the
// rate limits and one-hold-per-browser rules still apply. A wrong / missing / reused token is refused.
const VERIFY_URL = () => process.env.TURNSTILE_VERIFY_URL || 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

function config() {
    const siteKey = String(process.env.TURNSTILE_SITE_KEY || '').trim();
    const secret = String(process.env.TURNSTILE_SECRET_KEY || '').trim();
    return { enabled: !!(siteKey && secret), siteKey: siteKey && secret ? siteKey : null };
}

// Resolves { ok, reachable, codes }. ok=true also when Cloudflare could not be reached (reachable=false), see above.
async function verify(token, remoteIp) {
    const secret = String(process.env.TURNSTILE_SECRET_KEY || '').trim();
    if (!token || typeof token !== 'string' || token.length > 2048) return { ok: false, reachable: true, codes: ['missing-input-response'] };
    const form = new URLSearchParams({ secret, response: token });
    if (remoteIp) form.set('remoteip', String(remoteIp).replace(/^::ffff:/, ''));
    try {
        const r = await fetch(VERIFY_URL(), { method: 'POST', body: form, signal: AbortSignal.timeout(5000) });
        const json = await r.json().catch(() => null);
        if (!r.ok || !json) throw new Error('siteverify answered ' + r.status);
        return { ok: json.success === true, reachable: true, codes: json['error-codes'] || [] };
    } catch (e) {
        console.warn('[Turnstile] Cloudflare could not be reached - letting the request through:', e.message);
        return { ok: true, reachable: false, codes: [] };
    }
}

// Express middleware: no-op while Turnstile is off; otherwise the body's `turnstile_token` must verify.
async function requireTurnstile(req, res, next) {
    if (!config().enabled) return next();
    const result = await verify(req.body && req.body.turnstile_token, req.ip);
    if (result.ok) return next();
    res.status(403).json({ success: false, code: 'BOT_CHECK_FAILED', message: 'Please complete the "I am human" check and try again.' });
}

module.exports = { config, verify, requireTurnstile };
