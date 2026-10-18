// Run by quote-reminder.test.js in its OWN process (it opens the database): the REAL runQuoteFollowUpJob() against a throwaway DB.
// The reminder restates the quoted price, so it must carry the same pricing conditions as the quotation (and follow the quote:
// VAT added or not; the rate-card validity sentence only while the card is valid). Prints one "CHECK:{...}" line per assertion.
const rec = (name, pass, detail) => console.log('CHECK:' + JSON.stringify({ name, pass: !!pass, detail: pass ? '' : String(detail === undefined ? '' : detail).slice(0, 700) }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const db = require('../database');
    const q = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => e ? rej(e) : res(r)));
    const one = async (sql, p = []) => (await q(sql, p))[0];
    const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this.lastID); }));

    // init of a brand-new database runs for a few seconds (and rebuilds the banners table); wait until it is really done:
    // the tables exist, the banners rebuild has finished, and the rate-card migration (which waits for the schema) has applied.
    for (let i = 0; i < 200; i++) {
        const t = await q("SELECT name FROM sqlite_master WHERE name IN ('bookings','policies','notifications','settings','services','banners')").catch(() => []);
        const b = await q("SELECT sql FROM sqlite_master WHERE name = 'banners'").catch(() => []);
        const m = await q('SELECT 1 AS x FROM schema_migrations WHERE version = 106').catch(() => []);
        if (t.length === 6 && b[0] && /Birthday/.test(b[0].sql) && m.length) break;
        await sleep(250);
    }
    await sleep(500);
    await run("UPDATE settings SET setting_value = '2099-12-31' WHERE setting_key = 'rate_card_valid_until'");

    const future = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);
    const eventDate = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
    const mk = (email, details, amount) => run(
        `INSERT INTO bookings (name, email, cell, event_name, event_type, event_location, date, message, status, quote_amount, quote_details, quoted_at, quote_expiry_date)
         VALUES (?, ?, '+27821234567', 'Reminder Event', 'Corporate', 'Hall', ?, 'Quote reminder child test booking.', 'QUOTED', ?, ?, datetime('now', '-10 days'), ?)`,
        [`Reminder ${email}`, email, eventDate, amount, JSON.stringify(details), future]);
    await mk('with-vat@example.invalid', { apply_vat: true, discount: 0, items: [] }, '5750.00');
    await mk('no-vat@example.invalid', { apply_vat: false, discount: 0, items: [] }, '5000.00');
    await mk('legacy@example.invalid', null, '3000.00');            // quote_details 'null': an older booking with nothing to read

    const { runQuoteFollowUpJob } = require('../lib/quote-follow-up-job');
    const result = await runQuoteFollowUpJob();
    rec('the reminder job ran for the three open quotes', result.sent === 3 && result.errors === 0, JSON.stringify(result));

    const mail = async (email) => one("SELECT subject, body FROM notifications WHERE type = 'email' AND recipient_email = ? ORDER BY id DESC LIMIT 1", [email]);
    const withVat = await mail('with-vat@example.invalid');
    const noVat = await mail('no-vat@example.invalid');
    const legacy = await mail('legacy@example.invalid');
    rec('each reminder was queued', !!withVat && !!noVat && !!legacy && /Reminder: Your Quote Is Still Open/.test(withVat.subject), JSON.stringify({ withVat: !!withVat, noVat: !!noVat, legacy: !!legacy }));
    rec('the reminder still states the quoted amount', /R 5750\.00/.test(withVat.body) && /R 5000\.00/.test(noVat.body), withVat && withVat.body.slice(0, 300));
    rec('the reminder carries the pricing conditions: currency, travel / accommodation / rider and validity',
        /Pricing conditions/.test(withVat.body) && /All amounts are in South African rand \(ZAR\)\./.test(withVat.body)
        && /Fees exclude travel, accommodation and rider unless they are itemised in this quotation\./.test(withVat.body) && /Rates are valid until 31 December 2099\./.test(withVat.body), withVat && withVat.body.slice(0, 400));
    rec('a quote with VAT added says VAT is added in the totals', /Fees exclude VAT\. VAT at 15% is added in the totals above\./.test(withVat.body) && !/VAT is not included/.test(withVat.body), withVat && withVat.body.slice(0, 400));
    rec('a quote without VAT says VAT is not included', /VAT is not included in the amounts above\./.test(noVat.body) && !/VAT at 15%/.test(noVat.body), noVat && noVat.body.slice(0, 400));
    rec('an older booking with no readable quote details still gets a correct reminder (VAT not added)', /VAT is not included in the amounts above\./.test(legacy.body) && /Pricing conditions/.test(legacy.body), legacy && legacy.body.slice(0, 300));
    rec('the reminder carries no individually-priced note (it has no lines to inspect) and no commercial wording beyond the four facts', !/priced individually/.test(withVat.body) && !/discount|deposit|payment term|surcharge/i.test(withVat.body.replace(/<[^>]*>/g, ' ')), withVat && withVat.body.slice(0, 200));

    // once the rate card has expired the validity sentence is dropped, the rest stays
    await run("UPDATE settings SET setting_value = '2020-01-01' WHERE setting_key = 'rate_card_valid_until'");
    await run("UPDATE bookings SET quote_follow_up_sent_at = NULL");
    await run("DELETE FROM notifications WHERE type = 'email'");
    const second = await runQuoteFollowUpJob();
    const expired = await mail('no-vat@example.invalid');
    rec('after the rate card expired the reminder drops the validity sentence but keeps the other conditions', second.sent === 3 && !!expired && !/Rates are valid until/.test(expired.body) && /All amounts are in South African rand/.test(expired.body), JSON.stringify(second) + ' ' + (expired && expired.body.slice(0, 200)));
    process.exit(0);
})().catch((e) => { console.log('CHECK:' + JSON.stringify({ name: 'child crashed', pass: false, detail: String(e && e.stack || e).slice(0, 700) })); process.exit(0); });
