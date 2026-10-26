// A fake Google for tests: the OAuth token + revoke endpoints and the slice of the Calendar API the website uses, on a private port. The real
// lib/google-calendar.js / lib/google-config.js are pointed at it with GOOGLE_OAUTH_TOKEN_URL / GOOGLE_OAUTH_AUTH_URL / GOOGLE_OAUTH_REVOKE_URL /
// GOOGLE_API_ROOT_URL (see startFakeGoogle().env). Nothing here reaches Google. Used by test/google-calendar.child.js.
//   g.clients            { clientId: secret }       the OAuth clients Google "knows"
//   g.issueCode(clientId, redirectUri[, opts])      what Google would put in ?code= after the consent screen (opts.refresh === false: no refresh token is issued)
//   g.behaviour          { accessRole, apiDisabled, tokenFailure, revokeStatus, accountEmail }  switches for failure modes
//   g.tokenLog / g.apiLog / g.revokeLog             every request received (form bodies decoded)
//   g.revoke(refreshToken)                          the user revoked access in their Google account
const http = require('http');

async function startFakeGoogle({ clients } = {}) {
    const g = {
        clients: Object.assign({}, clients),
        behaviour: { accessRole: 'owner', apiDisabled: false, tokenFailure: null, revokeStatus: 200, accountEmail: 'owner@example.test' },
        tokenLog: [], apiLog: [], revokeLog: [], events: [],   // events: what the calendar lists (items as Google returns them)
        codes: new Map(), refreshTokens: new Map(), revoked: new Set(), accessTokens: new Map()
    };
    let n = 0;
    g.issueCode = (clientId, redirectUri, opts = {}) => {
        const code = 'code-' + (++n) + '-' + Math.random().toString(36).slice(2, 8);
        g.codes.set(code, { clientId, redirectUri, refresh: opts.refresh !== false, used: false });
        return code;
    };
    g.revoke = (refreshToken) => { g.revoked.add(refreshToken); };

    const readBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => resolve(b)); });
    const json = (res, status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(obj === undefined ? '' : JSON.stringify(obj)); };

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://x');
        const body = await readBody(req);

        if (url.pathname === '/token' && req.method === 'POST') {
            const f = Object.fromEntries(new URLSearchParams(body));
            g.tokenLog.push(f);
            if (g.behaviour.tokenFailure) return json(res, g.behaviour.tokenFailure.status || 400, { error: g.behaviour.tokenFailure.error, error_description: g.behaviour.tokenFailure.description || 'failure' });
            if (!f.client_id || g.clients[f.client_id] === undefined || g.clients[f.client_id] !== f.client_secret) return json(res, 401, { error: 'invalid_client', error_description: 'The OAuth client was not found.' });
            if (f.grant_type === 'authorization_code') {
                const c = g.codes.get(f.code);
                if (!c || c.used || c.clientId !== f.client_id || c.redirectUri !== f.redirect_uri) return json(res, 400, { error: c && c.redirectUri !== f.redirect_uri ? 'redirect_uri_mismatch' : 'invalid_grant', error_description: 'Bad Request' });
                c.used = true;
                const at = 'at-' + (++n) + '-' + Math.random().toString(36).slice(2, 12);
                const out = { access_token: at, expires_in: 3599, scope: 'https://www.googleapis.com/auth/calendar', token_type: 'Bearer' };
                if (c.refresh) { const rt = '1//rt-' + (++n) + '-' + Math.random().toString(36).slice(2, 10); out.refresh_token = rt; g.refreshTokens.set(rt, f.client_id); g.accessTokens.set(at, rt); }
                return json(res, 200, out);
            }
            if (f.grant_type === 'refresh_token') {
                if (!g.refreshTokens.has(f.refresh_token) || g.revoked.has(f.refresh_token) || g.refreshTokens.get(f.refresh_token) !== f.client_id) return json(res, 400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
                const at = 'at-' + (++n) + '-' + Math.random().toString(36).slice(2, 12);
                g.accessTokens.set(at, f.refresh_token);
                return json(res, 200, { access_token: at, expires_in: 3599, scope: 'https://www.googleapis.com/auth/calendar', token_type: 'Bearer' });
            }
            return json(res, 400, { error: 'unsupported_grant_type' });
        }

        if (url.pathname === '/revoke' && req.method === 'POST') {
            const token = url.searchParams.get('token') || new URLSearchParams(body).get('token');
            g.revokeLog.push({ token });
            if (g.behaviour.revokeStatus !== 200) return json(res, g.behaviour.revokeStatus, { error: 'server_error' });
            g.revoked.add(token);
            return json(res, 200, {});
        }

        if (url.pathname === '/auth') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('fake Google consent screen'); }

        if (url.pathname.startsWith('/calendar/v3/')) {
            const bearer = /^Bearer (.+)$/.exec(req.headers.authorization || '');
            const at = bearer ? bearer[1] : null;
            const rt = at ? g.accessTokens.get(at) : null;
            g.apiLog.push({ method: req.method, path: url.pathname, auth: at, refreshToken: rt || null, body: body ? safeJson(body) : null });
            if (!rt || g.revoked.has(rt)) return json(res, 401, { error: { code: 401, message: 'Invalid Credentials', status: 'UNAUTHENTICATED' } });
            if (g.behaviour.apiDisabled) return json(res, 403, { error: { code: 403, message: 'Google Calendar API has not been used in project 123456 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/calendar-json.googleapis.com/overview?project=123456', errors: [{ reason: 'accessNotConfigured', domain: 'usageLimits' }], status: 'PERMISSION_DENIED' } });
            if (req.method === 'GET' && /\/users\/me\/calendarList\/primary$/.test(url.pathname)) {
                return json(res, 200, { kind: 'calendar#calendarListEntry', id: g.behaviour.accountEmail, summary: g.behaviour.accountEmail, accessRole: g.behaviour.accessRole });
            }
            if (req.method === 'GET' && /\/calendars\/primary\/events$/.test(url.pathname)) return json(res, 200, { kind: 'calendar#events', items: g.events });
            if (req.method === 'POST' && /\/calendars\/primary\/events$/.test(url.pathname)) return json(res, 200, Object.assign({ id: 'gev-' + (++n) }, safeJson(body) || {}));
            if (req.method === 'DELETE' && /\/calendars\/primary\/events\/[^/]+$/.test(url.pathname)) { res.writeHead(204); return res.end(); }
            return json(res, 404, { error: { code: 404, message: 'Not Found' } });
        }
        json(res, 404, { error: 'not found' });
    });
    function safeJson(s) { try { return JSON.parse(s); } catch (e) { return null; } }

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    g.origin = 'http://127.0.0.1:' + server.address().port;
    g.env = {
        GOOGLE_OAUTH_TOKEN_URL: g.origin + '/token', GOOGLE_OAUTH_AUTH_URL: g.origin + '/auth',
        GOOGLE_OAUTH_REVOKE_URL: g.origin + '/revoke', GOOGLE_API_ROOT_URL: g.origin + '/'
    };
    g.close = () => new Promise((resolve) => { server.closeAllConnections && server.closeAllConnections(); server.close(() => resolve()); });
    return g;
}

module.exports = { startFakeGoogle };
