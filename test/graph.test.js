// Microsoft Graph client (lib/m365-graph.js) + its administrator diagnostic. Phase 2 of the Contact/Inquiries <-> Microsoft 365 work.
//   A. the REAL client against a fake sign-in + Graph server on loopback (test/fake-graph.js): token audience, mailbox pinning, link
//      validation, retry / throttling / expiry behaviour, error classification, and that no secret or token ever surfaces;
//   B. the admin API on the running (SMTP_MOCK) test server: roles, and that mock mode never contacts Microsoft.
// Nothing here talks to Microsoft. The module has no database dependency at load time, so it is exercised in the runner process.
const oauth = require('../lib/smtp-oauth');
const graph = require('../lib/m365-graph');
const { startFakeGraph } = require('./fake-graph');

const MAILBOX = 'bookings@example.invalid';
const SECRET = 'Zq9~fakeGraphSecret_VALUE-4';
const TENANT = '11111111-1111-1111-1111-111111111111';
const CLIENT = '22222222-2222-2222-2222-222222222222';

module.exports = async function ({ check, api, pub, loginAs }) {
    const g = await startFakeGraph({ mailbox: MAILBOX, secret: SECRET, tenant: TENANT });
    const saved = { a: process.env.SMTP_OAUTH_AUTHORITY, b: process.env.M365_GRAPH_BASE_URL, n: process.env.NODE_ENV };
    process.env.SMTP_OAUTH_AUTHORITY = g.origin;
    process.env.M365_GRAPH_BASE_URL = g.origin + '/v1.0';
    const ctx = { mailbox: MAILBOX, oauth: { tenant: TENANT, clientId: CLIENT, secret: SECRET } };
    const sleeps = [];
    const fast = { sleep: async (ms) => { sleeps.push(ms); }, retryBaseMs: 10 };
    const fresh = () => { g.reset(); oauth.clearTokens(); sleeps.length = 0; };

    try {
        // ══════════ A. the client ══════════
        check('the Graph token audience is graph.microsoft.com, not the SMTP one', oauth.GRAPH_SCOPE === 'https://graph.microsoft.com/.default' && oauth.GRAPH_SCOPE !== oauth.SCOPE, oauth.GRAPH_SCOPE);

        // URL building: the mailbox is pinned
        check('buildUrl pins every request to /users/<the configured mailbox>', graph.buildUrl(ctx, '/mailFolders/inbox', { $select: 'id,displayName' }) === `${g.origin}/v1.0/users/${encodeURIComponent(MAILBOX)}/mailFolders/inbox?$select=id%2CdisplayName`, graph.buildUrl(ctx, '/mailFolders/inbox', { $select: 'id,displayName' }));
        for (const bad of ['mailFolders/inbox', '/../users/other@example.invalid/messages', '/a/../b', '/x\r\nHost: evil']) {
            let threw = false; try { graph.buildUrl(ctx, bad); } catch (e) { threw = true; }
            check(`buildUrl refuses ${JSON.stringify(bad)}`, threw, '');
        }
        check("a link written the way real Graph writes them (users('<id>')/mailFolders('<id>')/...) is accepted - only its query is used", graph.isGraphLink(ctx, `${g.origin}/v1.0/users('7d1f2c3e-0a4b')/mailFolders('AAMk=')/messages/delta?$deltatoken=abc`), '');
        check('a link to another host is refused', !graph.isGraphLink(ctx, 'http://127.0.0.1:1/v1.0/users/' + encodeURIComponent(MAILBOX) + '/x') && !graph.isGraphLink(ctx, 'https://evil.example.invalid/v1.0/users/' + encodeURIComponent(MAILBOX) + '/x'), '');
        check('a link with embedded credentials is refused', !graph.isGraphLink(ctx, `http://user:pw@${new URL(g.origin).host}/v1.0/users/${encodeURIComponent(MAILBOX)}/x`), '');
        check('garbage is not a link', !graph.isGraphLink(ctx, 'not a url') && !graph.isGraphLink(ctx, undefined), '');

        // Happy path
        fresh();
        const ok = await graph.graphGet(ctx, { path: '/mailFolders/inbox', query: { $select: 'id,displayName,totalItemCount,unreadItemCount' } }, fast);
        check('GET inbox succeeds and returns the folder JSON', ok.ok && ok.status === 200 && ok.json.displayName === 'Inbox' && ok.requestId === 'fake-request-id-1', JSON.stringify(ok));
        check('the token was requested for the Graph audience', g.lastScope === 'https://graph.microsoft.com/.default', g.lastScope);
        check('the Graph call carried that token as a Bearer header', g.graphRequests.length === 1 && g.graphRequests[0].auth === 'Bearer ' + g.validToken, JSON.stringify(g.graphRequests));
        check('the request went to the configured mailbox only', g.graphRequests.every((r) => r.path.toLowerCase().startsWith(`/v1.0/users/${encodeURIComponent(MAILBOX)}/`.toLowerCase())), JSON.stringify(g.graphRequests));
        await graph.graphGet(ctx, { path: '/mailFolders/inbox' }, fast);
        check('the token is cached: a second call does not sign in again', g.tokenRequests.length === 1, g.tokenRequests.length);
        const graphTok = g.validToken;
        const smtpTok = await oauth.getAccessToken(ctx.oauth);
        check('the SMTP-audience token is cached separately (another sign-in, different scope)', g.tokenRequests.length === 2 && g.lastScope === oauth.SCOPE && smtpTok.token !== graphTok, g.tokenRequests.length + ' ' + g.lastScope);

        // Saved links: only the query is kept; the request is rebuilt on the pinned mailbox path
        fresh();
        const before = g.requests.length;
        const noPath = await graph.graphGet(ctx, { url: `${g.origin}/v1.0/users('x')/mailFolders('y')/messages/delta?$deltatoken=0` }, fast);
        check('a saved link followed WITHOUT the path it continues is refused, nothing sent', !noPath.ok && noPath.code === 'BadPath' && g.requests.length === before, JSON.stringify(noPath));
        const evil = await graph.graphGet(ctx, { url: 'https://evil.example.invalid/v1.0/users/x/mailFolders/inbox/messages/delta?$deltatoken=0', path: '/mailFolders/inbox/messages/delta' }, fast);
        check('a saved link to another host is refused, nothing sent', !evil.ok && evil.code === 'ForeignLink' && g.requests.length === before, JSON.stringify(evil));
        const steer = await graph.graphGet(ctx, { url: `${g.origin}/v1.0/users/other%40example.invalid/mailFolders/inbox/messages/delta?$deltatoken=0`, path: '/mailFolders/inbox/messages/delta' }, fast);
        const sent = g.graphRequests[g.graphRequests.length - 1];
        check('a saved link naming ANOTHER mailbox cannot steer the call: it goes to the configured mailbox with only the token taken from the link',
            steer.ok && g.graphRequests.length === 1 && sent.path.toLowerCase().startsWith(`/v1.0/users/${encodeURIComponent(MAILBOX)}/mailfolders/inbox/messages/delta?`.toLowerCase()) && sent.path.includes('$deltatoken=0') && !/other/i.test(sent.path), JSON.stringify(g.graphRequests));

        // Error classification
        fresh(); g.mode = '403';
        const r403 = await graph.graphGet(ctx, { path: '/mailFolders/inbox' }, fast);
        check('403 -> permission, systemic, tells the admin which Exchange role to grant', !r403.ok && r403.category === 'permission' && r403.systemic === true && r403.retryable === false && /Application Mail\.Read/.test(r403.message), JSON.stringify(r403));
        check('...and is not retried', g.graphRequests.length === 1 && sleeps.length === 0, g.graphRequests.length);
        fresh(); g.mode = '404';
        const r404 = await graph.graphGet(ctx, { path: '/mailFolders/inbox' }, fast);
        check('404 -> mailbox problem, systemic, not retried', !r404.ok && r404.category === 'mailbox' && r404.systemic && g.graphRequests.length === 1, JSON.stringify(r404));
        fresh(); g.deltaMode = '410';
        const r410 = await graph.graphGet(ctx, { path: '/mailFolders/inbox/messages/delta' }, fast);
        check('410 SyncStateNotFound -> resync (not systemic, not retried)', !r410.ok && r410.category === 'resync' && !r410.systemic && !r410.retryable && g.graphRequests.length === 1, JSON.stringify(r410));

        // Retry behaviour
        fresh(); g.mode = '429-once';
        const r429 = await graph.graphGet(ctx, { path: '/mailFolders/inbox' }, fast);
        check('429 once, then success: retried and succeeds', r429.ok && g.graphRequests.length === 2, JSON.stringify([r429.ok, g.graphRequests.length]));
        check('...the wait honoured Retry-After (0 s)', sleeps.length === 1 && sleeps[0] === 0, JSON.stringify(sleeps));
        fresh(); g.mode = '429-long';
        const rLong = await graph.graphGet(ctx, { path: '/mailFolders/inbox' }, fast);
        check('a huge Retry-After is capped at 30 s and attempts are bounded (4)', !rLong.ok && rLong.category === 'throttled' && rLong.retryable && g.graphRequests.length === 4 && sleeps.length === 3 && sleeps.every((s) => s === 30000), JSON.stringify({ n: g.graphRequests.length, sleeps }));
        fresh(); g.mode = '503';
        const r503 = await graph.graphGet(ctx, { path: '/mailFolders/inbox' }, fast);
        check('persistent 503: bounded retries, then a retryable "server" failure', !r503.ok && r503.category === 'server' && r503.retryable && g.graphRequests.length === 4, JSON.stringify({ n: g.graphRequests.length, c: r503.category }));
        // wait n = base * 2^(n-1) plus up to 250 ms of random jitter, so each wait is bounded by its own doubling step (never compare one wait with another)
        check('...with exponential back-off between attempts (10, 20, 40 ms steps plus up to 250 ms jitter)', sleeps.length === 3 && [10, 20, 40].every((step, i) => sleeps[i] >= step && sleeps[i] < step + 250), JSON.stringify(sleeps));
        check('...and the error body (which echoed the secret) never reaches the message', !JSON.stringify(r503).includes(SECRET) && !/secret-bearing/.test(r503.message), JSON.stringify(r503));
        fresh(); g.mode = 'drop';
        const rDrop = await graph.graphGet(ctx, { path: '/mailFolders/inbox' }, fast);
        check('a dropped connection is retried, then reported as a retryable connection failure', !rDrop.ok && rDrop.category === 'connection' && rDrop.retryable && g.graphRequests.length === 4, JSON.stringify({ n: g.graphRequests.length, c: rDrop.category }));

        // Token expiry / revocation
        fresh(); g.mode = '401-once';
        const r401a = await graph.graphGet(ctx, { path: '/mailFolders/inbox' }, fast);
        check('a rejected (revoked/expired) token is renewed once and the call succeeds', r401a.ok && g.tokenRequests.length === 2 && g.graphRequests.length === 2, JSON.stringify({ ok: r401a.ok, tokens: g.tokenRequests.length }));
        fresh(); g.mode = '401';
        const r401b = await graph.graphGet(ctx, { path: '/mailFolders/inbox' }, fast);
        check('a token that is rejected even after renewal -> auth, systemic, stops after ONE renewal', !r401b.ok && r401b.category === 'auth' && r401b.systemic && g.graphRequests.length === 2 && g.tokenRequests.length === 2, JSON.stringify({ n: g.graphRequests.length, t: g.tokenRequests.length }));

        // Wrong secret: Microsoft's rejection is shown without the secret
        fresh();
        const rBad = await graph.graphGet({ ...ctx, oauth: { ...ctx.oauth, secret: 'wrong-secret-VALUE' } }, { path: '/mailFolders/inbox' }, fast);
        check('a wrong client secret -> auth failure carrying Microsoft\'s AADSTS code', !rBad.ok && rBad.category === 'auth' && rBad.systemic && /AADSTS7000215/.test(rBad.message), JSON.stringify(rBad));
        check('...without the secret and without any Graph call', !JSON.stringify(rBad).includes('wrong-secret-VALUE') && g.graphRequests.length === 0, JSON.stringify(rBad));

        // Diagnostics
        fresh();
        const d = await graph.diagnose(ctx);
        check('diagnose: all three steps pass against a healthy mailbox', d.ok && d.steps.map((s) => s.id).join() === 'config,token,inbox' && d.steps.every((s) => s.ok), JSON.stringify(d));
        check('diagnose reports the inbox counters, never message content', /12 messages, 3 unread/.test(d.steps[2].message) && g.graphRequests.every((r) => !/\/messages/.test(r.path)), JSON.stringify(g.graphRequests));
        check('diagnose output contains no secret and no token', !JSON.stringify(d).includes(SECRET) && !JSON.stringify(d).includes('fake-access-token'), JSON.stringify(d));
        fresh(); g.mode = '403';
        const d403 = await graph.diagnose(ctx);
        check('diagnose pinpoints "sign-in works, inbox does not" when the Exchange role is missing', !d403.ok && d403.steps.find((s) => s.id === 'token').ok && !d403.steps.find((s) => s.id === 'inbox').ok && /Application Mail\.Read/.test(d403.steps.find((s) => s.id === 'inbox').message), JSON.stringify(d403));
        fresh();
        const dBad = await graph.diagnose({ ...ctx, oauth: { ...ctx.oauth, secret: 'wrong-secret-VALUE' } });
        check('diagnose stops at the sign-in step when Microsoft refuses the secret (no inbox call)', !dBad.ok && dBad.steps.length === 2 && !dBad.steps[1].ok && g.graphRequests.length === 0 && !JSON.stringify(dBad).includes('wrong-secret-VALUE'), JSON.stringify(dBad));

        // Test-only base URL must be ignored in production
        process.env.NODE_ENV = 'production';
        check('M365_GRAPH_BASE_URL is ignored in production', graph.graphBase() === 'https://graph.microsoft.com/v1.0', graph.graphBase());
        process.env.NODE_ENV = 'test';
        process.env.M365_GRAPH_BASE_URL = 'http://evil.example.invalid/v1.0';
        check('...and outside production a plain-http, non-loopback override is refused too', graph.graphBase() === 'https://graph.microsoft.com/v1.0', graph.graphBase());
        process.env.M365_GRAPH_BASE_URL = g.origin + '/v1.0';
    } finally {
        if (saved.a === undefined) delete process.env.SMTP_OAUTH_AUTHORITY; else process.env.SMTP_OAUTH_AUTHORITY = saved.a;
        if (saved.b === undefined) delete process.env.M365_GRAPH_BASE_URL; else process.env.M365_GRAPH_BASE_URL = saved.b;
        if (saved.n === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = saved.n;
        oauth.clearTokens();
        await g.close();
    }

    // ══════════ B. admin API (the server runs with SMTP_MOCK=true) ══════════
    const asManager = await loginAs('manager');
    const asAssistant = await loginAs('assistant');
    const url = '/api/admin/settings/m365/test-mailbox-read';
    check('mailbox read test: unauthenticated -> 401', (await pub('POST', url, {})).status === 401, '');
    check('mailbox read test: manager -> 403', (await asManager('POST', url, {})).status === 403, '');
    check('mailbox read test: assistant -> 403', (await asAssistant('POST', url, {})).status === 403, '');
    const adminRes = await api('POST', url, {});
    check('mailbox read test: administrator -> 200 with a plain-language failed config step in mock mode (Microsoft is not contacted)',
        adminRes.status === 200 && adminRes.body.success === true && adminRes.body.ok === false && adminRes.body.steps.length === 1 && adminRes.body.steps[0].id === 'config' && /mock mode/i.test(adminRes.body.steps[0].message), JSON.stringify(adminRes.body));
    check('...and the response carries nothing secret', !/secret|token|password/i.test(JSON.stringify(adminRes.body)), JSON.stringify(adminRes.body));
};
