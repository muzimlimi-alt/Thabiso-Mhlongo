// Microsoft Graph client, calendar side (lib/m365-graph.js graphRequest / diagnoseCalendar) - Phase 2 of the Admin Calendar <-> Microsoft 365 work.
//   A. writes (POST / PATCH / DELETE) against the fake Graph calendar (test/fake-graph.js): what is retried and what is NOT (a write whose answer was lost must
//      never be repeated unless it is idempotent), event-level 404 vs mailbox 404, permission text, no secret anywhere;
//   B. the administrator diagnostic, including the write probe that is the only proof of "Application Calendars.ReadWrite";
//   C. following Graph's own nextLink / deltaLink (written as users('<id>')/calendarView/delta?...) with the request rebuilt on the pinned mailbox;
//   D. the admin API (roles; mock mode never contacts Microsoft).
// Nothing here talks to Microsoft.
const oauth = require('../lib/smtp-oauth');
const graph = require('../lib/m365-graph');
const { startFakeGraph } = require('./fake-graph');

const MAILBOX = 'bookings@example.invalid';
const SECRET = 'Zq9~fakeCalendarSecret_VALUE-7';
const TENANT = '11111111-1111-1111-1111-111111111111';
const CLIENT = '22222222-2222-2222-2222-222222222222';
const SAST = 'South Africa Standard Time';

module.exports = async function ({ check, api, pub, loginAs }) {
    const g = await startFakeGraph({ mailbox: MAILBOX, secret: SECRET, tenant: TENANT });
    const saved = { a: process.env.SMTP_OAUTH_AUTHORITY, b: process.env.M365_GRAPH_BASE_URL };
    process.env.SMTP_OAUTH_AUTHORITY = g.origin;
    process.env.M365_GRAPH_BASE_URL = g.origin + '/v1.0';
    const ctx = { mailbox: MAILBOX, oauth: { tenant: TENANT, clientId: CLIENT, secret: SECRET } };
    const sleeps = [];
    const fast = { sleep: async (ms) => { sleeps.push(ms); }, retryBaseMs: 10 };
    const fresh = () => { g.reset(); g.calReset(); oauth.clearTokens(); sleeps.length = 0; };
    const body = (n, extra) => ({ subject: 'Test ' + n, start: { dateTime: '2026-12-01T18:00:00', timeZone: SAST }, end: { dateTime: '2026-12-01T20:00:00', timeZone: SAST }, ...(extra || {}) });
    const evPath = (id) => `/calendar/events/${encodeURIComponent(id)}`;
    const calReq = (extra) => ({ resource: 'calendar', ...extra });
    const creates = () => g.graphRequests.filter((r) => r.method === 'POST' && /\/calendar\/events$/i.test(r.path.split('?')[0]));

    try {
        // ══════════ A. writes ══════════
        fresh();
        const made = await graph.graphRequest(ctx, calReq({ method: 'POST', path: '/calendar/events', body: body(1, { transactionId: 'tx-1' }), idempotent: true }), fast);
        check('POST creates an event (201) and returns it in the business zone', made.ok && made.status === 201 && !!made.json.id && made.json.start.timeZone === SAST && made.json.start.dateTime.startsWith('2026-12-01T18:00:00'), JSON.stringify(made));
        const again = await graph.graphRequest(ctx, calReq({ method: 'POST', path: '/calendar/events', body: body(1, { transactionId: 'tx-1' }), idempotent: true }), fast);
        check('the same transactionId again returns the SAME event (Graph de-duplicates a repeated create)', again.ok && again.json.id === made.json.id && g.cal.events.size === 1, JSON.stringify([again.json && again.json.id, made.json.id, g.cal.events.size]));

        const patched = await graph.graphRequest(ctx, calReq({ method: 'PATCH', path: evPath(made.json.id), body: { subject: 'Changed' }, item: true }), fast);
        check('PATCH changes the event and Graph issues a new change key', patched.ok && patched.json.subject === 'Changed' && patched.json.changeKey !== made.json.changeKey, JSON.stringify(patched));

        const del = await graph.graphRequest(ctx, calReq({ method: 'DELETE', path: evPath(made.json.id), item: true }), fast);
        check('DELETE removes the event (204, no body)', del.ok && del.status === 204 && del.json === null && g.cal.events.size === 0, JSON.stringify(del));
        const before404 = g.graphRequests.length;
        const gone = await graph.graphRequest(ctx, calReq({ method: 'DELETE', path: evPath(made.json.id), item: true }), fast);
        check('deleting an event that is already gone -> "notfound": an event-level fact, not systemic, not retried', !gone.ok && gone.category === 'notfound' && gone.systemic === false && gone.retryable === false && g.graphRequests.length === before404 + 1, JSON.stringify(gone));
        const goneMailbox = await graph.graphRequest(ctx, calReq({ method: 'DELETE', path: evPath(made.json.id) }), fast);
        check('...whereas the same 404 WITHOUT item:true still reads as a mailbox problem (the old behaviour is kept for the inbox)', !goneMailbox.ok && goneMailbox.category === 'mailbox' && goneMailbox.systemic === true, JSON.stringify(goneMailbox));

        fresh();
        const badZone = await graph.graphRequest(ctx, calReq({ method: 'POST', path: '/calendar/events', body: body(2, { start: { dateTime: '2026-12-01T18:00:00', timeZone: 'Atlantis Standard Time' } }), idempotent: true }), fast);
        check('an unknown time-zone name is refused by Graph (400 -> invalid, not retried): the client must use a real zone name', !badZone.ok && badZone.category === 'invalid' && /ErrorInvalidTimeZone/.test(badZone.message) && creates().length === 1, JSON.stringify(badZone));

        fresh();
        const before = g.requests.length;
        const put = await graph.graphRequest(ctx, { method: 'PUT', path: '/calendar/events/x' }, fast);
        check('a method other than GET / POST / PATCH / DELETE is refused without sending anything', !put.ok && put.code === 'BadMethod' && g.requests.length === before, JSON.stringify(put));

        // permission text per resource
        fresh(); g.cal.mode = '403';
        const c403 = await graph.graphRequest(ctx, calReq({ path: '/calendar' }), fast);
        check('calendar 403 -> permission, systemic, names the Exchange CALENDAR role and the calendar doc', !c403.ok && c403.category === 'permission' && c403.systemic && /Application Calendars\.ReadWrite/.test(c403.message) && /calendar-m365\.md/.test(c403.message) && !/Mail\.Read/.test(c403.message), JSON.stringify(c403));
        g.mode = '403';   // the inbox has its own switch in the fake
        const m403 = await graph.graphRequest(ctx, { path: '/mailFolders/inbox' }, fast);
        check('...and a mail 403 on the same server still names the mail role (the inbox sync is unchanged)', !m403.ok && /Application Mail\.Read/.test(m403.message), JSON.stringify(m403));

        // retry rules for writes
        fresh(); g.cal.mode = '429-once';
        const t429 = await graph.graphRequest(ctx, calReq({ method: 'POST', path: '/calendar/events', body: body(3) }), fast);
        check('a throttled (429) POST is retried even when not idempotent - Microsoft did not process it - and creates exactly one event', t429.ok && g.cal.events.size === 1 && creates().length === 2, JSON.stringify([t429.ok, g.cal.events.size, creates().length]));

        fresh(); g.cal.mode = 'drop-after-apply-once';
        const lost = await graph.graphRequest(ctx, calReq({ method: 'POST', path: '/calendar/events', body: body(4) }), fast);
        check('a NON-idempotent POST whose answer is lost is NOT repeated (it may already exist) and is flagged unconfirmed', !lost.ok && lost.category === 'connection' && lost.unconfirmed === true && creates().length === 1 && g.cal.events.size === 1, JSON.stringify({ lost, n: creates().length, e: g.cal.events.size }));

        fresh(); g.cal.mode = 'drop-after-apply-once';
        const idem = await graph.graphRequest(ctx, calReq({ method: 'POST', path: '/calendar/events', body: body(5, { transactionId: 'tx-5' }), idempotent: true }), fast);
        check('an IDEMPOTENT POST (transactionId) whose answer is lost is repeated and still ends with exactly one event', idem.ok && g.cal.events.size === 1 && creates().length === 2 && g.cal.log.map((l) => l.op).join() === 'create,create-dedup', JSON.stringify({ ok: idem.ok, e: g.cal.events.size, log: g.cal.log.map((l) => l.op) }));

        fresh(); g.cal.mode = '503';
        const p503 = await graph.graphRequest(ctx, calReq({ method: 'POST', path: '/calendar/events', body: body(6) }), fast);
        check('a 503 on a non-idempotent POST is not retried and is flagged unconfirmed', !p503.ok && p503.category === 'server' && p503.unconfirmed === true && creates().length === 1 && sleeps.length === 0, JSON.stringify({ c: p503.category, u: p503.unconfirmed, n: creates().length }));
        const seeded = g.calSeed({ subject: 'Existing', start: { dateTime: '2026-12-02T10:00:00', timeZone: SAST }, end: { dateTime: '2026-12-02T11:00:00', timeZone: SAST } });
        const n0 = g.graphRequests.length;
        const patch503 = await graph.graphRequest(ctx, calReq({ method: 'PATCH', path: evPath(seeded.id), body: { subject: 'x' }, item: true }), fast);
        check('a 503 on a PATCH IS retried (repeating a PATCH is harmless): bounded to 4 attempts with back-off', !patch503.ok && patch503.category === 'server' && g.graphRequests.length - n0 === 4 && sleeps.length === 3, JSON.stringify({ n: g.graphRequests.length - n0, s: sleeps.length }));
        check('no secret or token in any write result', ![lost, p503, patch503, c403].some((r) => JSON.stringify(r).includes(SECRET) || /fake-access-token/.test(JSON.stringify(r))) && !/secret-bearing/.test(JSON.stringify(p503)), '');

        // ══════════ B. the administrator diagnostic ══════════
        fresh();
        const d = await graph.diagnoseCalendar(ctx);
        check('diagnoseCalendar: sign-in, calendar and write steps all pass on a healthy calendar', d.ok && d.steps.map((s) => s.id).join() === 'config,token,calendar,write' && d.steps.every((s) => s.ok), JSON.stringify(d));
        const probe = g.cal.log.filter((l) => l.op === 'create' || l.op === 'delete');
        check('...the write probe created ONE event and removed it again - nothing is left in the calendar', probe.map((l) => l.op).join() === 'create,delete' && probe[0].id === probe[1].id && g.cal.events.size === 0, JSON.stringify(g.cal.log));
        const sent = g.cal.created[0] || {};
        check('...and the probe event is invisible: free, no reminder, no attendees, dated 2001, plainly named, sent with a transactionId', /Website connection test/.test(sent.subject) && sent.showAs === 'free' && sent.isReminderOn === false && !sent.attendees && /^2001-/.test(sent.start.dateTime) && !!sent.transactionId, JSON.stringify(sent));
        check('diagnoseCalendar output contains no secret and no token', !JSON.stringify(d).includes(SECRET) && !JSON.stringify(d).includes('fake-access-token'), JSON.stringify(d));

        fresh();
        const dNo = await graph.diagnoseCalendar(ctx, { probe: false });
        check('probe:false never writes (read-only check)', dNo.ok && dNo.steps.length === 3 && g.cal.log.every((l) => l.op === 'calendar'), JSON.stringify(g.cal.log));

        fresh(); g.cal.canEdit = false;
        const dRo = await graph.diagnoseCalendar(ctx);
        check('a read-only calendar is reported before any write is attempted', !dRo.ok && !dRo.steps.find((s) => s.id === 'write').ok && /read-only/.test(dRo.steps.find((s) => s.id === 'write').message) && g.cal.log.every((l) => l.op === 'calendar'), JSON.stringify(dRo));

        fresh(); g.cal.mode = 'writes-403';
        const dW = await graph.diagnoseCalendar(ctx);
        check('Calendars.Read without ReadWrite: reading passes, the write step fails and names the Exchange role to grant', !dW.ok && dW.steps.find((s) => s.id === 'calendar').ok && !dW.steps.find((s) => s.id === 'write').ok && /Application Calendars\.ReadWrite/.test(dW.steps.find((s) => s.id === 'write').message), JSON.stringify(dW));

        fresh(); g.cal.mode = '403';
        const d403 = await graph.diagnoseCalendar(ctx);
        check('no calendar role at all: sign-in works, "Calendar access" fails with the role to grant, nothing is written', !d403.ok && d403.steps.find((s) => s.id === 'token').ok && !d403.steps.find((s) => s.id === 'calendar').ok && !d403.steps.find((s) => s.id === 'write'), JSON.stringify(d403));

        fresh();
        const dBad = await graph.diagnoseCalendar({ ...ctx, oauth: { ...ctx.oauth, secret: 'wrong-secret-VALUE' } });
        check('a refused secret stops the diagnostic at sign-in (no calendar call), without echoing the secret', !dBad.ok && dBad.steps.length === 2 && g.graphRequests.length === 0 && !JSON.stringify(dBad).includes('wrong-secret-VALUE'), JSON.stringify(dBad));

        // ══════════ C. delta through Graph-style links ══════════
        fresh();
        const ids = [];
        for (let i = 1; i <= 5; i++) ids.push(g.calSeed({ subject: 'Show ' + i, start: { dateTime: `2026-12-0${i}T18:00:00`, timeZone: SAST }, end: { dateTime: `2026-12-0${i}T20:00:00`, timeZone: SAST } }).id);
        g.calSeed({ subject: 'Outside the window', start: { dateTime: '2027-06-01T18:00:00', timeZone: SAST }, end: { dateTime: '2027-06-01T20:00:00', timeZone: SAST } });
        const prefer = { Prefer: `odata.maxpagesize=2, outlook.timezone="${SAST}"` };
        const walk = async (first) => {
            const rows = []; const links = []; let res = await graph.graphRequest(ctx, calReq(first), fast); let pages = 0, delta = null;
            while (res.ok && pages < 20) {
                pages++; rows.push(...res.json.value);
                if (res.json['@odata.nextLink']) { links.push(res.json['@odata.nextLink']); res = await graph.graphRequest(ctx, calReq({ url: res.json['@odata.nextLink'], path: '/calendarView/delta', headers: prefer }), fast); continue; }
                delta = res.json['@odata.deltaLink']; break;
            }
            return { rows, links, pages, delta, ok: res.ok, res };
        };
        const first = await walk({ path: '/calendarView/delta', query: { startDateTime: '2026-11-30T00:00:00+02:00', endDateTime: '2027-01-01T00:00:00+02:00' }, headers: prefer });
        check('the first delta round pages through the window (3 pages of 2), returning the 5 events inside it and not the one outside', first.ok && first.pages === 3 && first.rows.length === 5 && !first.rows.some((r) => r.subject === 'Outside the window'), JSON.stringify({ ok: first.ok, pages: first.pages, n: first.rows.length, res: first.res.message }));
        check("Graph's links are users('<id>')/... style and were still followed (the request was rebuilt on the pinned mailbox)", first.links.length === 2 && first.links.every((l) => /\/users\('/.test(l)) && g.graphRequests.every((r) => r.path.toLowerCase().startsWith(`/v1.0/users/${encodeURIComponent(MAILBOX)}/`.toLowerCase())), JSON.stringify(first.links));
        check('...and a deltaLink came back to resume from', !!first.delta && /\$deltatoken=/.test(first.delta), String(first.delta));
        check('every delta request asked for the business time zone', g.cal.log.filter((l) => l.op === 'delta').every((l) => /outlook\.timezone="South Africa Standard Time"/.test(l.prefer || '')), JSON.stringify(g.cal.log));

        const edited = g.calEdit(ids[0], { subject: 'Show 1 (renamed in Outlook)' });
        g.calDelete(ids[1]);
        const added = g.calSeed({ subject: 'Added in Outlook', start: { dateTime: '2026-12-10T09:00:00', timeZone: SAST }, end: { dateTime: '2026-12-10T10:00:00', timeZone: SAST } });
        const next = await walk({ url: first.delta, path: '/calendarView/delta', headers: prefer });
        const bySub = (s) => next.rows.find((r) => r.subject === s);
        check('the next round returns only what changed: the edit (new change key), the deletion (@removed) and the new event', next.ok && next.rows.length === 3 && bySub('Show 1 (renamed in Outlook)') && bySub('Show 1 (renamed in Outlook)').changeKey === edited.changeKey && next.rows.some((r) => r.id === ids[1] && r['@removed']) && !!bySub('Added in Outlook') && bySub('Added in Outlook').id === added.id, JSON.stringify(next.rows.map((r) => r.subject || r.id)));
        g.cal.deltaMode = '410';
        const expired = await graph.graphRequest(ctx, calReq({ url: next.delta, path: '/calendarView/delta', headers: prefer }), fast);
        check('an expired checkpoint (410) is reported as "resync", not as a failure of the integration', !expired.ok && expired.category === 'resync' && !expired.systemic, JSON.stringify(expired));
    } finally {
        if (saved.a === undefined) delete process.env.SMTP_OAUTH_AUTHORITY; else process.env.SMTP_OAUTH_AUTHORITY = saved.a;
        if (saved.b === undefined) delete process.env.M365_GRAPH_BASE_URL; else process.env.M365_GRAPH_BASE_URL = saved.b;
        oauth.clearTokens();
        await g.close();
    }

    // ══════════ D. admin API (the server runs with SMTP_MOCK=true) ══════════
    const asManager = await loginAs('manager');
    const asAssistant = await loginAs('assistant');
    const url = '/api/admin/calendar-sync/test';
    check('calendar test: unauthenticated -> 401', (await pub('POST', url, {})).status === 401, '');
    check('calendar test: manager -> 403', (await asManager('POST', url, {})).status === 403, '');
    check('calendar test: assistant -> 403', (await asAssistant('POST', url, {})).status === 403, '');
    const adminRes = await api('POST', url, {});
    check('calendar test: administrator -> 200 with a plain-language failed config step in mock mode (Microsoft is not contacted)',
        adminRes.status === 200 && adminRes.body.success === true && adminRes.body.ok === false && adminRes.body.steps.length === 1 && adminRes.body.steps[0].id === 'config' && /mock mode/i.test(adminRes.body.steps[0].message), JSON.stringify(adminRes.body));
    check('...and the response carries nothing secret', !/secret|token|password/i.test(JSON.stringify(adminRes.body)), JSON.stringify(adminRes.body));
};
