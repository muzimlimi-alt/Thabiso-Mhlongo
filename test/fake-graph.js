// A fake Microsoft sign-in service + Microsoft Graph mailbox API on one plain-http loopback port, for tests of lib/m365-graph.js and
// lib/inbox-sync.js. Nothing here talks to Microsoft. Plain http on 127.0.0.1 is the only way the app's own code accepts a non-Microsoft
// authority (and never in production), so the tests do not depend on loopback TLS (security software can re-sign it).
//
//   const g = await startFakeGraph({ mailbox: 'bookings@example.invalid', secret: 'fake-secret' });
//   process.env.SMTP_OAUTH_AUTHORITY = g.origin;  process.env.M365_GRAPH_BASE_URL = g.origin + '/v1.0';
//   g.mode = '403' | '404' | '429-once' | '503' | '401-once' | '401' | 'drop' | 'ok'      (what /mailFolders/inbox does)
//   g.requests  -> [{ method, path, auth, scope? }]        g.tokensIssued, g.lastScope
//   g.messages  -> the mailbox content served by the delta endpoint (see inbox-sync tests)
const http = require('http');

async function startFakeGraph({ mailbox, secret, tenant = '11111111-1111-1111-1111-111111111111', pageSize = 2 } = {}) {
    const state = {
        mode: 'ok', requests: [], tokensIssued: 0, lastScope: null, validToken: null, revoked: new Set(),
        messages: [],            // Graph message objects, oldest first
        deltaCalls: 0, onceDone: {}, folderCounts: { totalItemCount: 12, unreadItemCount: 3 },
        deltaMode: 'ok'          // 'ok' | '410' | '429' | '500'
    };
    const mailboxPath = `/v1.0/users/${encodeURIComponent(mailbox)}`.toLowerCase();

    const send = (res, status, obj, headers = {}) => {
        const body = obj === undefined ? '' : JSON.stringify(obj);
        res.writeHead(status, { 'Content-Type': 'application/json', 'request-id': 'fake-request-id-1', ...headers });
        res.end(body);
    };

    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        const auth = req.headers.authorization || '';
        state.requests.push({ method: req.method, path: url.pathname + url.search, auth, prefer: req.headers.prefer || null });

        // ── sign-in ──
        if (req.method === 'POST' && url.pathname === `/${tenant}/oauth2/v2.0/token`) {
            let body = '';
            req.on('data', (d) => { body += d; });
            req.on('end', () => {
                const f = new URLSearchParams(body);
                state.lastScope = f.get('scope');
                if (f.get('client_secret') !== secret) {
                    return send(res, 401, { error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided. Trace ID: x Correlation ID: y' });
                }
                state.tokensIssued += 1;
                state.validToken = `fake-access-token-${state.tokensIssued}`;
                send(res, 200, { access_token: state.validToken, token_type: 'Bearer', expires_in: 3600 });
            });
            return;
        }

        // ── Graph: only the mailbox path is served ──
        const p = url.pathname.toLowerCase();
        if (!p.startsWith(mailboxPath + '/') && p !== mailboxPath) return send(res, 404, { error: { code: 'ErrorInvalidUser', message: 'The requested user is invalid.' } });
        if (auth !== `Bearer ${state.validToken}` || state.revoked.has(auth)) return send(res, 401, { error: { code: 'InvalidAuthenticationToken', message: 'Access token is invalid.' } });
        const rest = p.slice(mailboxPath.length);

        if (rest === '/mailfolders/inbox') {
            const once = (name) => { if (state.onceDone[name]) return false; state.onceDone[name] = true; return true; };
            switch (state.mode) {
                case '403': return send(res, 403, { error: { code: 'ErrorAccessDenied', message: 'Access is denied. Check credentials and try again.' } });
                case '404': return send(res, 404, { error: { code: 'ErrorInvalidUser', message: 'The requested user is invalid.' } });
                case '429-once': if (once('429')) return send(res, 429, { error: { code: 'TooManyRequests', message: 'Slow down' } }, { 'Retry-After': '0' }); break;
                case '429-long': return send(res, 429, { error: { code: 'TooManyRequests', message: 'Slow down' } }, { 'Retry-After': '120' });
                case '503': return send(res, 503, { error: { code: 'ServiceUnavailable', message: 'secret-bearing text ' + secret } });
                case '401-once': if (once('401')) { state.revoked.add(auth); return send(res, 401, { error: { code: 'InvalidAuthenticationToken', message: 'revoked' } }); } break;
                case '401': return send(res, 401, { error: { code: 'InvalidAuthenticationToken', message: 'nope' } });
                case 'drop': return req.socket.destroy();
                default: break;
            }
            return send(res, 200, { id: 'inbox-folder-id', displayName: 'Inbox', ...state.folderCounts });
        }

        if (rest === '/mailfolders/inbox/messages/delta') {
            state.deltaCalls += 1;
            if (state.deltaMode === '403') return send(res, 403, { error: { code: 'ErrorAccessDenied', message: 'Access is denied.' } });
            if (state.deltaMode === '410') return send(res, 410, { error: { code: 'SyncStateNotFound', message: 'The sync state was not found.' } });
            if (state.deltaMode === '429') return send(res, 429, { error: { code: 'TooManyRequests', message: 'Slow down' } }, { 'Retry-After': '0' });
            if (state.deltaMode === '500') return send(res, 500, { error: { code: 'InternalServerError', message: 'boom' } });
            const skip = Number(url.searchParams.get('$skiptoken')) || 0;
            const since = url.searchParams.get('$deltatoken');
            const all = since ? state.messages.slice(Number(since)) : state.messages;
            const page = all.slice(skip, skip + pageSize);
            const base = `${state.origin}/v1.0/users/${encodeURIComponent(mailbox)}/mailFolders/inbox/messages/delta`;
            if (skip + pageSize < all.length) {
                return send(res, 200, { '@odata.nextLink': `${base}?$skiptoken=${skip + pageSize}${since ? '&$deltatoken=' + since : ''}`, value: page });
            }
            return send(res, 200, { '@odata.deltaLink': `${base}?$deltatoken=${state.messages.length}`, value: page });
        }
        send(res, 404, { error: { code: 'ErrorItemNotFound', message: 'Not found' } });
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    state.origin = `http://127.0.0.1:${server.address().port}`;
    Object.assign(state, {
        tenant, mailbox, secret,
        reset() { state.mode = 'ok'; state.deltaMode = 'ok'; state.requests.length = 0; state.onceDone = {}; state.revoked.clear(); state.deltaCalls = 0; },
        close: () => new Promise((resolve) => { server.closeAllConnections && server.closeAllConnections(); server.close(resolve); })
    });
    // getters (Object.assign would copy their value once instead of keeping them live)
    Object.defineProperty(state, 'graphRequests', { get: () => state.requests.filter((r) => r.path.startsWith('/v1.0/')) });
    Object.defineProperty(state, 'tokenRequests', { get: () => state.requests.filter((r) => r.path.includes('/oauth2/')) });
    return state;
}

module.exports = { startFakeGraph };
