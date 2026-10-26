// A fake Microsoft sign-in service + Microsoft Graph mailbox API on one plain-http loopback port, for tests of lib/m365-graph.js and
// lib/inbox-sync.js. Nothing here talks to Microsoft. Plain http on 127.0.0.1 is the only way the app's own code accepts a non-Microsoft
// authority (and never in production), so the tests do not depend on loopback TLS (security software can re-sign it).
//
//   const g = await startFakeGraph({ mailbox: 'bookings@example.invalid', secret: 'fake-secret' });
//   process.env.SMTP_OAUTH_AUTHORITY = g.origin;  process.env.M365_GRAPH_BASE_URL = g.origin + '/v1.0';
//   g.mode = '403' | '404' | '429-once' | '503' | '401-once' | '401' | 'drop' | 'ok'      (what /mailFolders/inbox does)
//   g.requests  -> [{ method, path, auth, scope? }]        g.tokensIssued, g.lastScope
//   g.messages  -> the mailbox content served by the delta endpoint (see inbox-sync tests)
//
// The same server also fakes the mailbox's CALENDAR (lib/calendar-m365.js tests): /calendar, /calendar/events[/<id>] (POST with Graph's transactionId
// de-duplication, PATCH, DELETE) and /calendarView/delta (paged, deltaToken, '@removed'), all in Graph's shape, links in Graph's own users('<id>') style.
//   g.cal.mode    'ok' | '403' | '429-once' | '503' | 'drop' (cut before applying) | 'drop-after-apply' / 'drop-after-apply-once' (the write IS applied, the answer is lost)
//   g.cal.created [raw POST bodies as sent]      g.cal.events  Map id -> event            g.cal.canEdit   g.cal.deltaMode 'ok' | '410' (everything) | '410-token' (only a saved checkpoint) | '429' | '500'      g.cal.log  [{ method, op, id? }]
//   g.calSeed(ev) / g.calEdit(id, patch) / g.calDelete(id)   = something done by a person in Outlook (bumps the change key; a delete shows up as '@removed')
const http = require('http');
const crypto = require('crypto');

const SAST = 'South Africa Standard Time';
const OPAQUE_USER_ID = '7d1f2c3e-0a4b-4c5d-8e6f-9a0b1c2d3e4f';   // real Graph writes links as users('<guid>')/..., never as users/<address>/...
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const unb64 = (s) => { try { return JSON.parse(Buffer.from(String(s), 'base64url').toString('utf8')); } catch (e) { return null; } };
// {dateTime, timeZone} as written by the client -> the shape Graph returns when asked for outlook.timezone="South Africa Standard Time"
function toLocal(dt) {
    if (!dt || !dt.dateTime) return null;
    let s = String(dt.dateTime).replace(/\.\d+$/, '').replace(/Z$/, '');
    const tz = String(dt.timeZone || 'UTC');
    if (/^utc$/i.test(tz)) { const d = new Date(s + 'Z'); d.setUTCHours(d.getUTCHours() + 2); s = d.toISOString().slice(0, 19); }
    else if (tz !== SAST) return null;     // an unknown zone name is a client bug: Graph answers 400 ErrorInvalidTimeZone
    return { dateTime: s + '.0000000', timeZone: SAST };
}

async function startFakeGraph({ mailbox, secret, tenant = '11111111-1111-1111-1111-111111111111', pageSize = 2 } = {}) {
    const state = {
        mode: 'ok', requests: [], tokensIssued: 0, lastScope: null, validToken: null, revoked: new Set(),
        messages: [],            // Graph message objects, oldest first
        deltaCalls: 0, onceDone: {}, folderCounts: { totalItemCount: 12, unreadItemCount: 3 },
        deltaMode: 'ok'          // 'ok' | '410' | '429' | '500'
    };
    const cal = state.cal = {
        mode: 'ok', canEdit: true, deltaMode: 'ok', events: new Map(), tx: new Map(), removed: [], version: 0, seq: 0, log: [], created: [], onceDone: {}, pageSize: 2
    };
    const stamp = (e) => { cal.version += 1; e.ver = cal.version; e.changeKey = 'ck' + cal.version; e.lastModifiedDateTime = new Date().toISOString(); return e; };
    const clean = (e) => { const { ver, ...rest } = e; return JSON.parse(JSON.stringify(rest)); };
    function makeEvent(b) {
        cal.seq += 1;
        const id = 'AAMkAGFake' + String(cal.seq).padStart(4, '0') + '=';
        const e = {
            id, iCalUId: 'uid-' + id, subject: b.subject || '', bodyPreview: '', body: b.body || { contentType: 'text', content: '' },
            start: toLocal(b.start), end: toLocal(b.end), isAllDay: !!b.isAllDay, isCancelled: !!b.isCancelled, showAs: b.showAs || 'busy',
            location: b.location || { displayName: '' }, categories: b.categories || [], sensitivity: b.sensitivity || 'normal',
            type: b.type || 'singleInstance', seriesMasterId: b.seriesMasterId || null, isOnlineMeeting: !!b.isOnlineMeeting, onlineMeeting: b.onlineMeeting || null,
            webLink: `${state.origin}/owa/?itemid=${encodeURIComponent(id)}&exvsurl=1&path=/calendar/item`, organizer: { emailAddress: { address: mailbox } }
        };
        return stamp(e);
    }
    state.calSeed = (b) => { const e = makeEvent(b); cal.events.set(e.id, e); return clean(e); };
    state.calEdit = (id, patch) => {
        const e = cal.events.get(id); if (!e) throw new Error('no such fake event ' + id);
        for (const [k, v] of Object.entries(patch)) e[k] = (k === 'start' || k === 'end') ? toLocal(v) : v;
        stamp(e); return clean(e);
    };
    state.calDelete = (id) => { if (cal.events.delete(id)) cal.removed.push({ id, ver: (cal.version += 1) }); };
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
            const base = `${state.origin}/v1.0/users('${OPAQUE_USER_ID}')/mailFolders('AAMkInboxFolderFake=')/messages/delta`;
            if (skip + pageSize < all.length) {
                return send(res, 200, { '@odata.nextLink': `${base}?$skiptoken=${skip + pageSize}${since ? '&$deltatoken=' + since : ''}`, value: page });
            }
            return send(res, 200, { '@odata.deltaLink': `${base}?$deltatoken=${state.messages.length}`, value: page });
        }
        if (rest === '/calendar' || rest.startsWith('/calendar/') || rest.startsWith('/calendarview/')) {
            return handleCalendar(req, res, url, rest, decodeURIComponent(url.pathname.slice(mailboxPath.length)));
        }
        send(res, 404, { error: { code: 'ErrorItemNotFound', message: 'Not found' } });
    });

    function handleCalendar(req, res, url, rest, restRaw) {
        let raw = '';
        req.on('data', (d) => { raw += d; });
        req.on('end', () => {
            let body = null; try { body = raw ? JSON.parse(raw) : null; } catch (e) { return send(res, 400, { error: { code: 'ErrorInvalidRequest', message: 'bad json' } }); }
            const once = (name) => { if (cal.onceDone[name]) return false; cal.onceDone[name] = true; return true; };
            const log = (op, id) => cal.log.push({ method: req.method, op, id: id || null, prefer: req.headers.prefer || null });
            if (cal.mode === '403') return send(res, 403, { error: { code: 'ErrorAccessDenied', message: 'Access is denied. Check credentials and try again.' } });
            if (cal.mode === 'writes-403' && req.method !== 'GET') return send(res, 403, { error: { code: 'ErrorAccessDenied', message: 'Access is denied. Check credentials and try again.' } });
            if (cal.mode === '503') return send(res, 503, { error: { code: 'ServiceUnavailable', message: 'secret-bearing text ' + secret } });
            if (cal.mode === 'drop') return req.socket.destroy();
            if (cal.mode === '429-once' && once('429')) return send(res, 429, { error: { code: 'TooManyRequests', message: 'Slow down' } }, { 'Retry-After': '0' });
            const done = (status, obj) => {
                if (req.method !== 'GET' && (cal.mode === 'drop-after-apply' || (cal.mode === 'drop-after-apply-once' && once('dropafter')))) return req.socket.destroy();
                return send(res, status, obj);
            };

            if (rest === '/calendar' && req.method === 'GET') { log('calendar'); return send(res, 200, { id: 'AAMkCalendarFake=', name: 'Calendar', canEdit: cal.canEdit }); }

            if (rest === '/calendar/events' && req.method === 'POST') {
                if (!cal.canEdit) return send(res, 403, { error: { code: 'ErrorAccessDenied', message: 'read only' } });
                if (!body || !body.start || !body.end) return send(res, 400, { error: { code: 'ErrorInvalidRequest', message: 'start and end are required' } });
                if (!toLocal(body.start) || !toLocal(body.end)) return send(res, 400, { error: { code: 'ErrorInvalidTimeZone', message: 'unknown time zone' } });
                if (body.transactionId && cal.tx.has(body.transactionId) && cal.events.has(cal.tx.get(body.transactionId))) {
                    log('create-dedup', cal.tx.get(body.transactionId));
                    return done(201, clean(cal.events.get(cal.tx.get(body.transactionId))));
                }
                const e = makeEvent(body);
                cal.created.push(JSON.parse(JSON.stringify(body)));   // what the client actually sent (tests assert on it)
                cal.events.set(e.id, e);
                if (body.transactionId) cal.tx.set(body.transactionId, e.id);
                log('create', e.id);
                return done(201, clean(e));
            }

            const m = /^\/calendar\/events\/(.+)$/.exec(restRaw);
            if (m) {
                const id = m[1];
                const e = cal.events.get(id);
                if (!e) return send(res, 404, { error: { code: 'ErrorItemNotFound', message: 'The specified object was not found in the store.' } });
                if (req.method === 'GET') { log('get', id); return send(res, 200, clean(e)); }
                if (!cal.canEdit) return send(res, 403, { error: { code: 'ErrorAccessDenied', message: 'read only' } });
                if (req.method === 'PATCH') {
                    for (const [k, v] of Object.entries(body || {})) {
                        if (k === 'start' || k === 'end') { const t = toLocal(v); if (!t) return send(res, 400, { error: { code: 'ErrorInvalidTimeZone', message: 'unknown time zone' } }); e[k] = t; }
                        else if (k !== 'id' && k !== 'transactionId') e[k] = v;
                    }
                    stamp(e); log('patch', id);
                    return done(200, clean(e));
                }
                if (req.method === 'DELETE') { cal.events.delete(id); cal.removed.push({ id, ver: (cal.version += 1) }); log('delete', id); return done(204); }
            }

            if (rest === '/calendarview/delta' && req.method === 'GET') {
                if (cal.deltaMode === '410' || (cal.deltaMode === '410-token' && (url.searchParams.get('$deltatoken') || url.searchParams.get('$skiptoken')))) return send(res, 410, { error: { code: 'SyncStateNotFound', message: 'The sync state was not found.' } });
                if (cal.deltaMode === '429') return send(res, 429, { error: { code: 'TooManyRequests', message: 'Slow down' } }, { 'Retry-After': '0' });
                if (cal.deltaMode === '500') return send(res, 500, { error: { code: 'InternalServerError', message: 'boom' } });
                const q = url.searchParams;
                const skip = q.get('$skiptoken') ? unb64(q.get('$skiptoken')) : null;
                const dt = q.get('$deltatoken') ? unb64(q.get('$deltatoken')) : null;
                let win, since;
                if (skip) { win = skip.win; since = skip.since; }
                else if (dt) { win = dt.win; since = dt.v; }
                else if (q.get('startDateTime') && q.get('endDateTime')) { win = { s: q.get('startDateTime'), e: q.get('endDateTime') }; since = 0; }
                else return send(res, 400, { error: { code: 'ErrorInvalidRequest', message: 'startDateTime and endDateTime are required' } });
                const mPage = /odata\.maxpagesize=(\d+)/.exec(req.headers.prefer || '');
                const pageSize = mPage ? Number(mPage[1]) : cal.pageSize;
                const wantsLocal = /outlook\.timezone="South Africa Standard Time"/.test(req.headers.prefer || '');
                log('delta');
                cal.deltaCalls = (cal.deltaCalls || 0) + 1;
                const inWindow = (e) => e.start.dateTime.slice(0, 19) < String(win.e).slice(0, 19) && e.end.dateTime.slice(0, 19) > String(win.s).slice(0, 19);
                let rows = [];
                for (const e of cal.events.values()) if (e.ver > since && inWindow(e)) rows.push(clean(e));
                if (since > 0) for (const r of cal.removed) if (r.ver > since) rows.push({ id: r.id, '@removed': { reason: 'deleted' } });
                if (!wantsLocal) rows = rows.map((r) => ({ ...r, __warning: 'client did not ask for the business time zone' }));
                const from = skip ? skip.at : 0;
                const page = rows.slice(from, from + pageSize);
                const base = `${state.origin}/v1.0/users('${OPAQUE_USER_ID}')/calendarView/delta`;
                if (from + pageSize < rows.length) {
                    return send(res, 200, { '@odata.nextLink': `${base}?$skiptoken=${b64({ at: from + pageSize, win, since, v: cal.version })}`, value: page });
                }
                return send(res, 200, { '@odata.deltaLink': `${base}?$deltatoken=${b64({ v: skip ? skip.v : cal.version, win })}`, value: page });
            }
            send(res, 404, { error: { code: 'ErrorItemNotFound', message: 'Not found' } });
        });
    }

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    state.origin = `http://127.0.0.1:${server.address().port}`;
    Object.assign(state, {
        tenant, mailbox, secret,
        reset() {
            state.mode = 'ok'; state.deltaMode = 'ok'; state.requests.length = 0; state.onceDone = {}; state.revoked.clear(); state.deltaCalls = 0;
            Object.assign(cal, { mode: 'ok', canEdit: true, deltaMode: 'ok', onceDone: {}, deltaCalls: 0 }); cal.log.length = 0;
        },
        calReset() { cal.events.clear(); cal.tx.clear(); cal.removed.length = 0; cal.log.length = 0; cal.created.length = 0; cal.version = 0; cal.seq = 0; },
        close: () => new Promise((resolve) => { server.closeAllConnections && server.closeAllConnections(); server.close(resolve); })
    });
    // getters (Object.assign would copy their value once instead of keeping them live)
    Object.defineProperty(state, 'graphRequests', { get: () => state.requests.filter((r) => r.path.startsWith('/v1.0/')) });
    Object.defineProperty(state, 'tokenRequests', { get: () => state.requests.filter((r) => r.path.includes('/oauth2/')) });
    return state;
}

module.exports = { startFakeGraph };
