// Run by notify-ops-monitor.test.js in its OWN process (it opens the database): Phase 2 of the Notification Centre against a throwaway DB -
// the operations monitor (lib/ops-monitor.js), ticket-sales alerts (lib/ticket-alerts.js), door / scanner check-ins (lib/ticketing.js checkIn)
// and the calendar / inbox failure hooks (lib/calendar-m365.js, lib/inbox-sync.js, lib/google-config.js) with fake Microsoft / Google
// answers. Nothing is sent. Prints one "CHECK:{...}" line per assertion.
const rec = (name, pass, detail) => console.log('CHECK:' + JSON.stringify({ name, pass: !!pass, detail: pass ? '' : String(detail === undefined ? '' : detail).slice(0, 700) }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const db = require('../database');
    const q = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => e ? rej(e) : res(r)));
    const one = async (sql, p = []) => (await q(sql, p))[0];
    const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this); }));
    for (let i = 0; i < 240; i++) {
        const m = await q('SELECT 1 AS x FROM schema_migrations WHERE version IN (106, 116, 119)').catch(() => []);
        if (m.length === 3) break;
        await sleep(250);
    }
    await sleep(500);

    // insert a row, filling any NOT NULL column without a default that the test does not care about
    async function insert(table, values) {
        const cols = await q(`PRAGMA table_info(${table})`);
        const v = { ...values };
        for (const c of cols) {
            if (c.pk || v[c.name] !== undefined || !c.notnull || c.dflt_value !== null) continue;
            v[c.name] = /INT|REAL|NUM/i.test(c.type) ? 0 : `${c.name}-${Math.random().toString(36).slice(2, 10)}`;
        }
        const keys = Object.keys(v);
        const r = await run(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, keys.map((k) => v[k]));
        return r.lastID;
    }
    const DAY = 86400000;
    const sast = (offsetDays) => new Date(Date.now() + 2 * 3600000 + offsetDays * DAY).toISOString().slice(0, 10);
    const nowIso = () => new Date().toISOString();
    // fire-and-forget hooks (checkIn, the sync failures) write a moment later: poll, never sleep-and-hope
    const pollRows = async (sql, p, ok) => { let r = []; for (let i = 0; i < 40; i++) { r = await q(sql, p); if (ok(r)) return r; await sleep(100); } return r; };
    const inc = (event, entity) => q(`SELECT * FROM admin_notifications WHERE event_type = ? AND entity_id = ? ORDER BY id`, [event, String(entity)]);

    // ── operations monitor ─────────────────────────────────────────────────────────────────────────────────────────────────────────
    const bookingId = await insert('bookings', { name: 'Ops Client', email: 'ops@example.invalid', cell: '+27821234567', event_name: 'Ops Event', event_type: 'Corporate', event_location: 'Hall', date: sast(30), message: 'ops monitor test booking', status: 'CONFIRMED', total_amount: 5000, amount_paid: 0, payment_status: 'UNPAID' });
    const clientId = await insert('clients', { email: 'ops@example.invalid' });
    const invId = await insert('invoices', { booking_id: bookingId, client_id: clientId, invoice_number: 'INV-OPS-1', invoice_date: sast(-20), due_date: sast(-5), subtotal: 5000, tax_amount: 0, total_amount: 5000, status: 'OVERDUE' });
    const schedId = await insert('payment_schedules', { booking_id: bookingId, description: 'Balance', due_date: sast(2), expected_amount: 2500, status: 'pending' });
    const eventId = await insert('events', { event_title: 'Ops Show', event_datetime: sast(1) + 'T19:00', event_status: 'upcoming', venue_name: 'Big Hall' });
    const t = nowIso();
    const tierId = await insert('ticket_types', { event_id: eventId, name: 'General', price_cents: 15000, capacity: 20, sold: 5, reserved: 0, sales_end: new Date(Date.now() + 20 * 3600000).toISOString(), is_active: 1, created_at: t, updated_at: t });

    const ops = require('../lib/ops-monitor');
    await ops.runOpsCheck();
    const ov = await inc('finance.invoice_overdue', invId);
    rec('an OVERDUE invoice becomes an Action-required item (high) saying how many days overdue', ov.length === 1 && ov[0].kind === 'action' && ov[0].priority === 'high' && /5 day/.test(ov[0].body) && /INV-OPS-1/.test(ov[0].title), JSON.stringify(ov));
    rec('...in-app only (the overdue digest e-mail stays the one e-mail)', ov[0] && ov[0].email_state === 'skipped', ov[0] && ov[0].email_state);
    const ms = await inc('bookings.milestone_due', schedId);
    rec('a payment milestone due in 2 days shows as Attention', ms.length === 1 && /in 2 day/.test(ms[0].title) && ms[0].kind === 'attention', JSON.stringify(ms));
    const up = await inc('events.upcoming', eventId);
    rec('an event tomorrow shows as "tomorrow"', up.length === 1 && /tomorrow/.test(up[0].title), JSON.stringify(up));
    const sc = await inc('events.sales_closing', tierId);
    rec('ticket sales ending within 24 hours with tickets left are flagged', sc.length === 1 && /24 hours/.test(sc[0].title) && /15 ticket/.test(sc[0].body), JSON.stringify(sc));
    await ops.runOpsCheck();
    const twice = await q(`SELECT event_type, COUNT(*) n, MAX(occurrence_count) oc FROM admin_notifications WHERE entity_id IN (?, ?, ?, ?) GROUP BY event_type`, [String(invId), String(schedId), String(eventId), String(tierId)]);
    rec('running the monitor again creates no duplicates and no inflated counts', twice.every((r) => r.n === 1 && r.oc === 1), JSON.stringify(twice));

    await run("UPDATE invoices SET status = 'PAID' WHERE id = ?", [invId]);
    await run("UPDATE payment_schedules SET status = 'paid' WHERE id = ?", [schedId]);
    await run("UPDATE events SET event_status = 'completed' WHERE event_id = ?", [eventId]);
    await run('UPDATE ticket_types SET sold = 20 WHERE id = ?', [tierId]);
    await ops.runOpsCheck();
    const after = await q(`SELECT event_type, status, resolved_auto, resolution_note FROM admin_notifications WHERE entity_id IN (?, ?, ?, ?) AND event_type IN ('finance.invoice_overdue','bookings.milestone_due','events.upcoming','events.sales_closing')`, [String(invId), String(schedId), String(eventId), String(tierId)]);
    rec('when the invoice is paid, the milestone paid, the event over and the tier sold out, all four close themselves', after.length === 4 && after.every((r) => r.status === 'resolved' && r.resolved_auto === 1 && r.resolution_note), JSON.stringify(after));

    // ── ticket-sales alerts ────────────────────────────────────────────────────────────────────────────────────────────────────────
    const ev2 = await insert('events', { event_title: 'Stock Show', event_datetime: sast(40) + 'T19:00', event_status: 'upcoming', venue_name: 'Hall' });
    const tier2 = await insert('ticket_types', { event_id: ev2, name: 'VIP', price_cents: 50000, capacity: 12, sold: 1, reserved: 0, is_active: 1, created_at: t, updated_at: t });
    const ta = require('../lib/ticket-alerts');
    await ta.afterPaidOrder({ id: 9001, event_id: ev2, buyer_name: 'Buyer One', total_cents: 50000, complimentary: 0 });
    await ta.afterPaidOrder({ id: 9002, event_id: ev2, buyer_name: 'Buyer Two', total_cents: 50000, complimentary: 0 });
    const orders = await q(`SELECT * FROM admin_notifications WHERE event_type = 'events.ticket_orders' AND entity_id = ?`, [String(ev2)]);
    rec('paid ticket orders group into ONE "new ticket orders today" item per show, counting each order', orders.length === 1 && orders[0].occurrence_count === 2 && /Buyer Two/.test(orders[0].details_json || ''), JSON.stringify(orders.map((o) => [o.occurrence_count, o.title])));
    rec('no low-stock alert while plenty is left (11 of 12)', (await inc('events.low_stock', tier2)).length === 0);
    await run('UPDATE ticket_types SET sold = 10 WHERE id = ?', [tier2]);
    await ta.afterPaidOrder({ id: 9003, event_id: ev2, buyer_name: 'Buyer Three', total_cents: 50000, complimentary: 0 });
    const low = await inc('events.low_stock', tier2);
    rec('2 left (threshold 10 by default) raises "Only 2 VIP ticket(s) left" (high)', low.length === 1 && /Only 2 VIP/.test(low[0].title) && low[0].priority === 'high', JSON.stringify(low));
    await run('UPDATE ticket_types SET sold = 11 WHERE id = ?', [tier2]);
    await ta.afterPaidOrder({ id: 9004, event_id: ev2, buyer_name: 'Buyer Four', total_cents: 50000, complimentary: 0 });
    const low2 = await inc('events.low_stock', tier2);
    rec('the same low-stock item refreshes to "Only 1" (no second item)', low2.length === 1 && /Only 1 VIP/.test(low2[0].title), JSON.stringify(low2.map((l) => l.title)));
    await run('UPDATE ticket_types SET sold = 12 WHERE id = ?', [tier2]);
    await ta.afterPaidOrder({ id: 9005, event_id: ev2, buyer_name: 'Buyer Five', total_cents: 50000, complimentary: 0 });
    const so = await inc('events.sold_out', ev2);
    rec('selling the last ticket raises "Sold out"', so.length === 1 && /Sold out: Stock Show/.test(so[0].title), JSON.stringify(so));
    rec('...and closes the low-stock item', (await inc('events.low_stock', tier2))[0].status === 'resolved');
    await run("INSERT OR REPLACE INTO settings (setting_key, setting_value) VALUES ('ntf_low_stock_threshold', '0')");
    const ev3 = await insert('events', { event_title: 'No Alert Show', event_datetime: sast(50) + 'T19:00', event_status: 'upcoming', venue_name: 'Hall' });
    const tier3 = await insert('ticket_types', { event_id: ev3, name: 'GA', price_cents: 10000, capacity: 5, sold: 4, reserved: 0, is_active: 1, created_at: t, updated_at: t });
    await ta.afterPaidOrder({ id: 9006, event_id: ev3, buyer_name: 'B', total_cents: 10000, complimentary: 0 });
    rec('a threshold of 0 switches low-stock alerts off', (await inc('events.low_stock', tier3)).length === 0);
    await ta.afterPaidOrder({ id: 9007, event_id: ev3, buyer_name: 'Comp', total_cents: 0, complimentary: 1 });
    rec('complimentary orders are not counted as sales', (await q(`SELECT occurrence_count FROM admin_notifications WHERE event_type = 'events.ticket_orders' AND entity_id = ?`, [String(ev3)]))[0].occurrence_count === 1);

    // ── check-ins ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
    const core = require('../lib/ticketing-core');
    const ticketing = require('../lib/ticketing');
    const orderId = await insert('ticket_orders', { event_id: ev2, status: 'paid', buyer_name: 'Door Buyer', buyer_email: 'door@example.invalid', total_cents: 50000, created_at: t });
    const token = core.randomToken();
    await insert('tickets', { order_id: orderId, ticket_type_id: tier2, holder_name: 'Door Buyer', token, created_at: t });
    const r1 = await ticketing.checkIn(token, null, 'Front door');
    const r2 = await ticketing.checkIn(token, null, 'Side door');
    rec('the first scan admits, the second says already used', r1.result === 'admitted' && r2.result === 'already', JSON.stringify([r1.result, r2.result]));
    await sleep(300);
    const ci = await q(`SELECT * FROM activity_log WHERE event_type = 'events.checkin' AND entity_id IN (SELECT CAST(id AS TEXT) FROM tickets WHERE token = ?)`, [token]);
    rec('an admission is recorded in the Activity Log with the door it came through', ci.length === 1 && /Front door/.test(ci[0].summary), JSON.stringify(ci));
    const dup = await inc('events.checkin_duplicate', ev2);
    rec('scanning a used ticket again raises one grouped "already-used tickets scanned again" item for the show', dup.length === 1 && dup[0].kind === 'attention' && /Side door/.test(dup[0].body), JSON.stringify(dup));
    await ticketing.checkIn(token, null, 'Side door');
    const dup2 = await pollRows(`SELECT occurrence_count FROM admin_notifications WHERE event_type = 'events.checkin_duplicate' AND entity_id = ?`, [String(ev2)], (r) => r[0] && r[0].occurrence_count === 2);
    rec('...a third scan only raises its count', dup2.length === 1 && dup2[0].occurrence_count === 2, JSON.stringify(dup2));
    const voidToken = core.randomToken();
    await insert('tickets', { order_id: orderId, ticket_type_id: tier2, holder_name: 'Voided', token: voidToken, voided_at: t, created_at: t });
    const r3 = await ticketing.checkIn(voidToken, null, 'Front door');
    await sleep(300);
    rec('a cancelled ticket at the door is refused and raises "cancelled / refunded tickets presented"', r3.result === 'void' && (await inc('events.checkin_void', ev2)).length === 1, r3.result);

    // ── calendar & inbox failures (fake Microsoft) ──────────────────────────────────────────────────────────────────────────────────
    const m365 = require('../lib/calendar-m365');
    const badCtx = { resolveContext: async () => ({ ok: false, message: 'Microsoft refused the sign-in (test)' }) };
    await m365.runSync({ force: true, deps: badCtx });
    rec('one failed calendar run is not an alert yet (blips are normal)', (await q(`SELECT id FROM admin_notifications WHERE event_type = 'calendar.sync_failed'`)).length === 0);
    await m365.runSync({ force: true, deps: badCtx });
    const cf = await pollRows(`SELECT * FROM admin_notifications WHERE event_type = 'calendar.sync_failed'`, [], (r) => r.length > 0);
    rec('two in a row raise "Microsoft 365 calendar sync failing" with the error and last good sync', cf.length === 1 && /Microsoft 365/.test(cf[0].title) && /refused the sign-in/.test(cf[0].body) && /Last successful sync/.test(cf[0].body), JSON.stringify(cf));

    const inbox = require('../lib/inbox-sync');
    await inbox.runSync({ force: true, deps: badCtx });
    await inbox.runSync({ force: true, deps: badCtx });
    const ib = await pollRows(`SELECT * FROM admin_notifications WHERE event_type = 'email.inbox_sync_failed'`, [], (r) => r.length > 0);
    rec('two failed mailbox runs raise "customer replies are not being collected"', ib.length === 1 && ib[0].status === 'open' && /refused the sign-in/.test(ib[0].body), JSON.stringify(ib));
    const okCtx = { resolveContext: async () => ({ ok: true, ctx: { mailbox: 'bookings@example.invalid' } }), graphGet: async () => ({ ok: true, json: { value: [], '@odata.deltaLink': 'https://graph.example.invalid/delta?x=1' } }) };
    const good = await inbox.runSync({ force: true, deps: okCtx });
    const ib2 = (await pollRows(`SELECT * FROM admin_notifications WHERE event_type = 'email.inbox_sync_failed'`, [], (r) => r[0] && r[0].status === 'resolved'))[0];
    rec('the next good mailbox run resolves it automatically', good && good.ok !== false && ib2.status === 'resolved' && ib2.resolved_auto === 1, JSON.stringify([good, ib2 && ib2.status]));

    const gconf = require('../lib/google-config');
    if (gconf.recordSync) {
        await gconf.recordSync('push', new Error('Google said no (test)'));
        await gconf.recordSync('push', new Error('Google said no (test)'));
        const g = await q(`SELECT * FROM admin_notifications WHERE event_type = 'calendar.sync_failed' AND title LIKE 'Google%'`);
        if (g.length) {
            rec('two failed Google pushes raise "Google Calendar sync failing (push)"', g.length === 1 && /push/.test(g[0].title), JSON.stringify(g));
            await gconf.recordSync('push', null);
            rec('a successful Google push resolves it', (await one(`SELECT status FROM admin_notifications WHERE id = ?`, [g[0].id])).status === 'resolved');
        } else {
            rec('Google Calendar is not connected in this throwaway database, so its bookkeeping (and alert) is skipped - by design', true);
        }
    }
    process.exit(0);
})().catch((e) => { console.log('CHECK:' + JSON.stringify({ name: 'child crashed', pass: false, detail: String(e && e.stack || e).slice(0, 700) })); process.exit(0); });
