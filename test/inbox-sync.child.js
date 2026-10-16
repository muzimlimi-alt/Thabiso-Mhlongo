// Run by inbox-sync.test.js in its OWN process (it opens the database): the REAL lib/inbox-sync.js + lib/m365-graph.js against a fake Microsoft
// sign-in + Graph server (test/fake-graph.js), on a throwaway DB. Prints one "CHECK:{...}" line per assertion. Nothing reaches Microsoft.
const { startFakeGraph } = require('./fake-graph');
const rec = (name, pass, detail) => console.log('CHECK:' + JSON.stringify({ name, pass: !!pass, detail: pass ? '' : String(detail === undefined ? '' : detail).slice(0, 700) }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MAILBOX = 'bookings@test.invalid';
const SECRET = 'Zq9~fakeSyncSecret_VALUE-5';
const TENANT = '11111111-1111-1111-1111-111111111111', CLIENT = '22222222-2222-2222-2222-222222222222';

(async () => {
    const g = await startFakeGraph({ mailbox: MAILBOX, secret: SECRET, tenant: TENANT, pageSize: 2 });
    process.env.SMTP_OAUTH_AUTHORITY = g.origin;
    process.env.M365_GRAPH_BASE_URL = g.origin + '/v1.0';

    const db = require('../database');
    const sync = require('../lib/inbox-sync');
    const graph = require('../lib/m365-graph');
    const oauth = require('../lib/smtp-oauth');
    const smtpConfig = require('../lib/smtp-config');
    const { upsertSetting } = require('../database/repositories/settings.repository');
    const q = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => e ? rej(e) : res(r)));
    const one = async (sql, p = []) => (await q(sql, p))[0];
    const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this.lastID); }));
    const deps = { resolveContext: async () => ({ ok: true, ctx: { mailbox: MAILBOX, oauth: { tenant: TENANT, clientId: CLIENT, secret: SECRET } } }) };

    for (let i = 0; i < 80; i++) {
        const t = await q("SELECT name FROM sqlite_master WHERE name IN ('inquiry_messages','inbox_sync_state','inquiries','settings')").catch(() => []);
        const st = await q('SELECT id FROM inbox_sync_state').catch(() => []);
        if (t.length === 4 && st.length === 1) break;
        await sleep(250);
    }
    const adminId = await run(`INSERT INTO admins (username, email, password_hash, role, is_active, must_change_password) VALUES ('sync.admin', 'sync.admin@test.invalid', 'x', 'administrator', 1, 0)`);

    let n = 0;
    const msg = (o) => {
        n++;
        return {
            id: o.id || `graph-id-${n}`, internetMessageId: o.rfc === null ? null : (o.rfc || `<m${n}-${Date.now()}@sender.test>`), subject: o.subject || 'Hello', isDraft: !!o.draft,
            from: { emailAddress: { name: o.name === undefined ? 'Some Person' : o.name, address: o.from } }, toRecipients: [{ emailAddress: { address: MAILBOX } }], ccRecipients: [],
            receivedDateTime: o.at || new Date().toISOString(), hasAttachments: !!o.att, body: { contentType: o.html ? 'html' : 'text', content: o.text === undefined ? 'A reply from the customer.' : o.text }
        };
    };
    const mkInquiry = (email, status = 'read', extra = {}) => run(`INSERT INTO inquiries (sender_name, sender_email, receiver_email, category, subject, message_body, status) VALUES (?, ?, ?, 'General Inquiry', ?, 'The original message text.', ?)`, [extra.name || 'Customer', email, MAILBOX, extra.subject || 'Original subject', status]);
    const mkOut = (inquiryId, to, mid) => run(`INSERT INTO inquiry_messages (inquiry_id, direction, source, message_id, from_address, to_addresses, cc_addresses, subject, body_html, delivery_status, accepted_at) VALUES (?, 'out', 'admin_reply', ?, ?, ?, '[]', 'Re: Original subject', '<p>Our reply</p>', 'accepted', CURRENT_TIMESTAMP)`, [inquiryId, mid, MAILBOX, JSON.stringify([to])]);
    const ref = (id) => `[INQ-${String(id).padStart(6, '0')}]`;

    // ── the switch ──
    const off = await sync.runIfDue();
    rec('switched off by default: nothing runs and Microsoft is never asked', off === null && g.requests.length === 0 && (await sync.getStatus()).enabled === false, JSON.stringify(g.requests));
    const offRun = await sync.runSync({ deps });
    rec('...a direct run while switched off is a no-op too', offRun.skipped === 'sync is switched off' && g.requests.length === 0, JSON.stringify(offRun));

    // ── P1: matching, ignoring, importing ──
    const A = await mkInquiry('alice@customer.test', 'replied');
    const midA = `<inq-${A}-0001@test.invalid>`;
    await mkOut(A, 'alice@customer.test', midA);
    const B = await mkInquiry('bob@customer.test', 'read');
    const C1 = await mkInquiry('carol@customer.test', 'read'), C2 = await mkInquiry('carol@customer.test', 'unread');
    const ARCH = await mkInquiry('dave@customer.test', 'archived');
    await sync.setEnabled(true, adminId);
    const dupRfc = '<same-rfc-id@alice.test>';
    g.messages.push(
        msg({ from: 'alice@customer.test', name: 'Alice A', subject: `Re: Original subject ${ref(A)}`, rfc: dupRfc, text: 'Yes please, Saturday works.\n\nOn Mon, 12 Oct 2026 at 09:00, Thabiso Mhlongo <bookings@test.invalid> wrote:\n> Our reply quoted here\n> more quote' }),
        msg({ from: 'bob@customer.test', subject: 'Re: your answer', text: 'Thanks Bob here.' }),
        msg({ from: 'stranger@elsewhere.test', name: 'Stranger', subject: `${ref(A)} please send me the bank details`, text: 'I am not Alice.' }),
        msg({ from: MAILBOX, subject: 'Website Inquiry: x ' + ref(A), text: 'our own intake notification' }),
        msg({ from: 'alice@customer.test', subject: 'Automatic reply: I am away', text: 'Out of office' }),
        msg({ from: 'postmaster@outlook.com', name: 'Microsoft Outlook', subject: `Undeliverable: Re: Original subject ${ref(A)}`, text: `Your message could not be delivered.\nDiagnostic information:\n550 5.1.1 RESOLVER.ADR.RecipNotFound; not found\nOriginal Message-ID: ${midA}` }),
        msg({ from: 'draft@customer.test', subject: 'A draft', draft: true }),
        msg({ from: 'alice@customer.test', subject: `Re: Original subject ${ref(A)}`, rfc: dupRfc, text: 'Same message again (another Graph id).' }),
        msg({ from: 'eve@customer.test', name: 'Eve', subject: 'html mail', html: true, text: '<p>Hello <b>there</b></p><script>alert(1)</script><br>second line &amp; more' }),
        msg({ from: 'frank@customer.test', name: 'Frank', subject: 'with a file', att: true, text: 'see attached' }),
        msg({ from: 'carol@customer.test', name: 'Carol', subject: 'Re: hi', text: 'Which inquiry am I answering?' }),
        msg({ from: 'dave@customer.test', name: 'Dave', subject: 'Re: earlier', text: 'Dave writes again.' })
    );
    const r1 = await sync.runSync({ deps });
    const s1 = r1.stats || {};
    rec('P1: the run succeeded across several pages', r1.ok && s1.pages === 6 && s1.seen === 12, JSON.stringify(r1));
    const rowA = await one('SELECT status FROM inquiries WHERE inquiry_id = ?', [A]);
    const inA = await q(`SELECT * FROM inquiry_messages WHERE inquiry_id = ? AND direction = 'in'`, [A]);
    rec('P1: a reply carrying the inquiry tag AND coming from that customer is attached to it (and the replied inquiry is unread again)', inA.length === 1 && inA[0].from_address === 'alice@customer.test' && rowA.status === 'unread', JSON.stringify({ rowA, inA }));
    rec('P1: only the customer\'s new text is kept (quoted history cut), as plain text', inA[0].body_text === 'Yes please, Saturday works.' && inA[0].delivery_status === 'received' && inA[0].source === 'mailbox', JSON.stringify(inA[0]));
    const inB = await q(`SELECT * FROM inquiry_messages WHERE inquiry_id = ? AND direction = 'in'`, [B]);
    rec('P1: with no tag, the sender\'s ONE open inquiry receives the reply', inB.length === 1 && inB[0].body_text === 'Thanks Bob here.', JSON.stringify(inB));
    const stranger = await one(`SELECT * FROM inquiries WHERE LOWER(sender_email) = 'stranger@elsewhere.test'`);
    rec('P1: a stranger quoting someone else\'s tag is NOT attached to that conversation - it becomes a new email inquiry', !!stranger && stranger.source === 'email' && stranger.inquiry_id !== A && inA.every((m) => m.from_address !== 'stranger@elsewhere.test'), JSON.stringify(stranger));
    rec('P1: our own mail, a draft and an out-of-office reply are not imported', stats(s1, 'self') === 1 && stats(s1, 'draft') === 1 && stats(s1, 'auto') === 1 && !(await one(`SELECT 1 AS x FROM inquiries WHERE LOWER(sender_email) = 'draft@customer.test'`)), JSON.stringify(s1.ignored));
    const bounced = await one(`SELECT delivery_status, last_error FROM inquiry_messages WHERE message_id = ?`, [midA]);
    rec('P1: a delivery-failure notice marks OUR reply as bounced (with the reason) and is not stored as a customer message', bounced.delivery_status === 'bounced' && /5\.1\.1/.test(bounced.last_error) && s1.bounces === 1 && !(await one(`SELECT 1 AS x FROM inquiries WHERE LOWER(sender_email) = 'postmaster@outlook.com'`)), JSON.stringify(bounced));
    rec('P1: the same RFC Message-ID arriving again (different Graph id) is not stored twice', stats(s1, 'duplicate') === 1 && inA.length === 1, JSON.stringify(s1.ignored));
    const eve = await one(`SELECT i.message_body, i.source, i.category, i.status FROM inquiries i WHERE LOWER(i.sender_email) = 'eve@customer.test'`);
    rec('P1: new mail becomes an inquiry (source email, unread); an HTML body is stored as text with no markup or script', !!eve && eve.source === 'email' && eve.category === 'Email' && eve.status === 'unread' && !/[<>]|script|alert/i.test(eve.message_body) && /Hello there/.test(eve.message_body) && /second line/.test(eve.message_body), JSON.stringify(eve));
    const frank = await one(`SELECT message_body FROM inquiries WHERE LOWER(sender_email) = 'frank@customer.test'`);
    rec('P1: a mail with attachments says so (attachments themselves are not copied)', /had attachments/.test(frank.message_body), JSON.stringify(frank));
    const carolInq = await q(`SELECT inquiry_id FROM inquiries WHERE LOWER(sender_email) = 'carol@customer.test' ORDER BY inquiry_id`);
    const carolIn = await q(`SELECT inquiry_id FROM inquiry_messages WHERE LOWER(from_address) = 'carol@customer.test' AND direction = 'in'`);
    rec('P1: two open inquiries from one sender and no tag is ambiguous -> a NEW inquiry, never a guess', carolInq.length === 3 && !carolIn.some((m) => m.inquiry_id === C1 || m.inquiry_id === C2), JSON.stringify({ carolInq, carolIn }));
    const dave = await one('SELECT status FROM inquiries WHERE inquiry_id = ?', [ARCH]);
    rec('P1: an archived inquiry is not a match target (the customer\'s new mail is a new inquiry)', !!(await one(`SELECT 1 AS x FROM inquiries WHERE LOWER(sender_email) = 'dave@customer.test' AND source = 'email'`)) && dave.status === 'archived', JSON.stringify(dave));
    const eveMsg = await one(`SELECT body_text, direction FROM inquiry_messages WHERE LOWER(from_address) = 'eve@customer.test'`);
    rec('P1: the origin message of an email inquiry is recorded for de-duplication without repeating its text in the conversation', !!eveMsg && eveMsg.body_text === null && eveMsg.direction === 'in', JSON.stringify(eveMsg));

    // what was asked of Graph
    const firstCall = g.graphRequests.find((r) => /messages\/delta/.test(r.path));
    rec('P1: the first request asked only for mail after the baseline, text bodies, a bounded page and no attachment content', !!firstCall && /\$filter=receivedDateTime%20ge%20/.test(firstCall.path) && /\$select=/.test(firstCall.path) && /outlook\.body-content-type="text"/.test(firstCall.prefer) && /odata\.maxpagesize=25/.test(firstCall.prefer) && !/\$expand/i.test(firstCall.path), JSON.stringify(firstCall));
    rec('P1: every request stayed inside the configured mailbox and was read-only', g.graphRequests.every((r) => r.method === 'GET' && r.path.toLowerCase().startsWith('/v1.0/users/' + encodeURIComponent(MAILBOX).toLowerCase() + '/')), JSON.stringify(g.graphRequests.map((r) => r.method + ' ' + r.path)));

    // checkpoint, idempotence, incremental
    const st1 = await sync.getStatus();
    rec('P1: the checkpoint and baseline are saved, and the API view never exposes the checkpoint URL', st1.hasCheckpoint === true && !!st1.baselineAt && !/deltatoken|127\.0\.0\.1|v1\.0/.test(JSON.stringify(st1)) && st1.lastError === null, JSON.stringify(st1));
    const inquiriesBefore = (await one('SELECT COUNT(*) AS c FROM inquiries')).c, msgsBefore = (await one('SELECT COUNT(*) AS c FROM inquiry_messages')).c;
    const r2 = await sync.runSync({ deps });
    rec('P1: running again with nothing new changes nothing (checkpoint honoured)', r2.ok && r2.stats.seen === 0 && (await one('SELECT COUNT(*) AS c FROM inquiries')).c === inquiriesBefore && (await one('SELECT COUNT(*) AS c FROM inquiry_messages')).c === msgsBefore, JSON.stringify(r2));
    g.messages.push(msg({ from: 'bob@customer.test', subject: 'Re: your answer', text: 'A second message from Bob.' }));
    const r3 = await sync.runSync({ deps });
    rec('P1: a message that arrives later is picked up incrementally', r3.ok && r3.stats.seen === 1 && r3.stats.replies === 1 && (await q(`SELECT 1 FROM inquiry_messages WHERE inquiry_id = ? AND direction = 'in'`, [B])).length === 2, JSON.stringify(r3));

    // ── P3: failures, back-off, resync ──
    g.deltaMode = '429';
    const rT = await sync.runSync({ deps });
    const stT = await sync.getStatus();
    rec('P3: throttling: the run fails politely, records why and backs off 5 minutes (nothing imported)', !rT.ok && rT.category === 'throttled' && stT.consecutiveFailures === 1 && Date.parse(stT.retryAfter) - Date.now() > 4 * 60000 && /throttl/i.test(stT.lastError), JSON.stringify([rT, stT]));
    const calls = g.deltaCalls;
    const skipped = await sync.runIfDue();
    rec('P3: the scheduler respects the back-off (no request while it is running)', skipped === null && g.deltaCalls === calls, `${g.deltaCalls} vs ${calls}`);
    g.deltaMode = '403';
    const rP = await sync.runSync({ deps });
    const stP = await sync.getStatus();
    rec('P3: a missing permission is reported as such (systemic), with the Exchange hint, 15 minutes back-off, never retried in a loop', !rP.ok && rP.category === 'permission' && /Application Mail\.Read/.test(rP.error) && stP.consecutiveFailures === 2 && Date.parse(stP.retryAfter) - Date.now() > 14 * 60000, JSON.stringify([rP, stP]));
    g.deltaMode = '500';
    const rS = await sync.runSync({ deps });
    rec('P3: a server error is a retryable failure with exponential back-off', !rS.ok && rS.category === 'server' && (await sync.getStatus()).consecutiveFailures === 3, JSON.stringify(rS));
    g.deltaMode = '410';
    const rG = await sync.runSync({ deps });
    const stG = await sync.getStatus();
    rec('P3: Microsoft dropping the checkpoint (410) clears it so the next run rescans', !rG.ok && rG.category === 'resync' && stG.hasCheckpoint === false, JSON.stringify([rG, stG]));
    g.deltaMode = 'ok';
    const inquiriesPre = (await one('SELECT COUNT(*) AS c FROM inquiries')).c, msgsPre = (await one('SELECT COUNT(*) AS c FROM inquiry_messages')).c;
    const rR = await sync.runSync({ deps });
    rec('P3: after the rescan nothing was stored twice (message ids are unique) and the failure counters reset', rR.ok && (await one('SELECT COUNT(*) AS c FROM inquiries')).c === inquiriesPre && (await one('SELECT COUNT(*) AS c FROM inquiry_messages')).c === msgsPre && (await sync.getStatus()).consecutiveFailures === 0 && rR.stats.ignored.duplicate >= 8, JSON.stringify([rR.stats, await sync.getStatus()]));

    // ── P6: a tampered checkpoint is never followed ──
    await run(`UPDATE inbox_sync_state SET delta_link = 'http://127.0.0.1:1/v1.0/users/${encodeURIComponent('other@evil.test')}/mailFolders/inbox/messages/delta?$deltatoken=x' WHERE id = 1`);
    const before = g.requests.length;
    const rF = await sync.runSync({ deps });
    rec('P6: a stored checkpoint pointing at another host/mailbox is refused without sending anything', !rF.ok && rF.category === 'invalid' && g.requests.length === before, JSON.stringify(rF));
    await run(`UPDATE inbox_sync_state SET delta_link = NULL, retry_after = NULL WHERE id = 1`);

    // ── P5: a different mailbox discards the old checkpoint ──
    await run(`UPDATE inbox_sync_state SET mailbox = 'old.mailbox@test.invalid', delta_link = 'stale', baseline_at = '2020-01-01T00:00:00.000Z' WHERE id = 1`);
    const rM = await sync.runSync({ deps });
    const stM = await sync.getStatus();
    rec('P5: pointing the site at another mailbox discards the old checkpoint and baseline (no cross-mailbox leakage)', rM.ok && stM.mailbox === MAILBOX && stM.baselineAt !== '2020-01-01T00:00:00.000Z', JSON.stringify(stM));

    // ── P7: page budget ──
    await run(`UPDATE inbox_sync_state SET delta_link = NULL WHERE id = 1`);
    g.messages.length = 0;
    for (let i = 0; i < 50; i++) g.messages.push(msg({ from: `bulk${i}@customer.test`, name: 'Bulk ' + i, subject: 'bulk ' + i, text: 'bulk message number ' + i }));
    const rB1 = await sync.runSync({ deps });
    const st1b = await sync.getStatus();
    rec('P7: a big mailbox is read in bounded runs (20 pages), the position is saved mid-way', rB1.ok && rB1.stats.pages === 20 && st1b.hasCheckpoint && rB1.stats.new_inquiries === 40, JSON.stringify(rB1.stats));
    const rB2 = await sync.runSync({ deps });
    rec('P7: the next run continues where it stopped and finishes (50 in total, none twice)', rB2.ok && rB2.stats.new_inquiries === 10 && (await one(`SELECT COUNT(*) AS c FROM inquiries WHERE LOWER(sender_email) LIKE 'bulk%@customer.test'`)).c === 50, JSON.stringify(rB2.stats));

    // ── P10: configuration from the saved Email (SMTP) settings, end to end ──
    process.env.SMTP_MOCK = 'false';
    const set = (k, v) => new Promise((res, rej) => upsertSetting(k, v, (e) => e ? rej(e) : res()));
    await set('smtp_host', 'smtp.office365.com'); await set('smtp_port', '587'); await set('smtp_secure', 'starttls');
    await set('smtp_user', MAILBOX); await set('smtp_from', MAILBOX); await set('smtp_auth', 'oauth');
    await set('smtp_oauth_tenant', TENANT); await set('smtp_oauth_client', CLIENT); await set('smtp_oauth_secret', smtpConfig.encryptSecret(SECRET));
    oauth.clearTokens(); g.reset(); g.messages.length = 0;
    const diag = await graph.diagnose();
    rec('P10: the saved OAuth settings are enough: diagnose passes all three steps (settings, Graph sign-in, inbox)', diag.ok && diag.steps.length === 3 && diag.mailbox === MAILBOX, JSON.stringify(diag));
    g.messages.push(msg({ from: 'bob@customer.test', subject: 'Re: configured end to end', text: 'Third message from Bob.' }));
    await run('UPDATE inbox_sync_state SET delta_link = NULL, retry_after = NULL WHERE id = 1');   // the mailbox content was swapped for this scenario
    const rE = await sync.runSync({ force: true });
    rec('P10: a run with no injected context resolves the mailbox and secret from the saved settings and reads it', rE.ok && rE.stats.seen === 1 && !JSON.stringify(rE).includes(SECRET), JSON.stringify(rE));
    process.env.SMTP_MOCK = 'true';
    const mockRun = await sync.runSync({ force: true });
    rec('P10: in mock mode the sync refuses to contact Microsoft at all', !mockRun.ok && mockRun.category === 'config' && /mock mode/i.test(mockRun.error), JSON.stringify(mockRun));

    // nothing sensitive anywhere
    const all = JSON.stringify([await sync.getStatus(), await q('SELECT last_error, last_stats FROM inbox_sync_state')]);
    rec('no secret, token or checkpoint URL in the status, errors or statistics', !all.includes(SECRET) && !/fake-access-token/.test(all), all.slice(0, 300));
    await g.close();
    process.exit(0);

    function stats(s, k) { return s.ignored[k]; }
})().catch((e) => { rec('child crashed', false, e && e.stack || e); process.exit(1); });
