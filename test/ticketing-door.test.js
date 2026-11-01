// Event ticketing - DOOR LINKS (migration 115, lib/ticketing-door.js, routes/public/ticketing-door.js) against the real server:
// an administrator / manager makes a per-show link for a volunteer without a portal account; the link can look up, find and check in
// tickets for THAT show only, never shows buyers' e-mails / phones, records its name on every check-in, and stops working the moment it
// is switched off or expires. Only a hash of the secret is stored, and the secret never reaches the server log.
// Date offsets 1980-1989 are reserved for this file. Every event it creates is cancelled before it ends.
const sqlite3 = require('sqlite3');
const crypto = require('crypto');
const { api, pub, q, one, future, sleep, loginAs, BASE, TEST_DB, getChildLog } = require('./support');
const { generatePayFastItnSignature } = require('../lib/payfast-signature');

const waitFor = async (fn, ms = 20000) => { const t = Date.now(); let v; while (Date.now() - t < ms) { v = await fn(); if (v) return v; await sleep(200); } return v; };
let pf = 0;

module.exports = async function ({ check }) {
    const made = [];
    try { await suite(check, made); }
    finally { for (const ev of made) await api('PUT', `/api/admin/events/${ev.id}`, { event_title: ev.title, event_datetime: ev.when, event_status: 'cancelled', sync_to_gcal: false }).catch(() => {}); }
};

async function makeShow(made, offset, title) {
    const when = `${future(offset)}T20:00`;
    const ev = (await api('POST', '/api/admin/events', { event_title: title, event_datetime: when, venue_name: 'Hall', event_status: 'upcoming', sync_to_gcal: false })).body;
    made.push({ id: ev.id, title, when });
    const t = (await api('POST', `/api/admin/events/${ev.id}/ticket-types`, { name: 'General', price: '100', is_active: true, max_per_order: 4, capacity: 20 })).body.tier;
    return { id: ev.id, title, when, tier: t };
}

async function paidOrder(eventId, tierId, name, email, phone) {
    const o = (await pub('POST', '/api/public/ticket-orders', { event_id: eventId, items: [{ ticket_type_id: tierId, quantity: 1 }] })).body.order;
    await pub('POST', `/api/public/ticket-orders/${o.reference}/checkout`, { buyer_name: name, buyer_email: email, buyer_phone: phone, popia_consent: true, terms_accepted: true });
    const row = await one('SELECT * FROM ticket_orders WHERE public_reference = ?', [o.reference]);
    const m = { m_payment_id: row.m_payment_id, pf_payment_id: `DOOR-${Date.now()}-${++pf}`, payment_status: 'COMPLETE', item_name: 'x', item_description: '', amount_gross: (row.total_cents / 100).toFixed(2), amount_fee: '-1.00', amount_net: '1.00',
        custom_str1: '', custom_str2: '', custom_str3: '', custom_str4: '', custom_str5: '', custom_int1: '', custom_int2: '', custom_int3: '', custom_int4: '', custom_int5: '', name_first: 'D', name_last: 'B', email_address: email, merchant_id: '10000100' };
    m.signature = generatePayFastItnSignature(m, null);
    await pub('POST', '/api/payment/webhook/payfast', m);
    await waitFor(async () => (await one('SELECT status FROM ticket_orders WHERE id = ?', [row.id])).status === 'paid');
    return one('SELECT * FROM tickets WHERE order_id = ?', [row.id]);
}

// The door API as the volunteer's phone calls it: the pass in the x-door-pass header, no cookie.
async function door(method, path, pass) {
    const r = await fetch(BASE + path, { method, headers: pass ? { Accept: 'application/json', 'x-door-pass': pass } : { Accept: 'application/json' } });
    const text = await r.text();
    let body = null; try { body = JSON.parse(text); } catch (e) {}
    return { status: r.status, body, text };
}

function writeDb(sql, params) {
    return new Promise((res, rej) => {
        const db = new sqlite3.Database(TEST_DB);
        db.configure('busyTimeout', 5000);
        db.run(sql, params, (e) => { db.close(); e ? rej(e) : res(); });
    });
}

async function suite(check, made) {
    const s = await makeShow(made, 1980, 'ZZ Door Link Show');
    const other = await makeShow(made, 1981, 'ZZ Door Other Show');
    const stamp = Date.now();
    const email = `door.buyer.${stamp}@example.invalid`, phone = '0829876543';
    const tk = await paidOrder(s.id, s.tier.id, 'Door Buyer', email, phone);
    const tk2 = await paidOrder(s.id, s.tier.id, 'Second Guest', `door.two.${stamp}@example.invalid`, '0821112222');
    const otk = await paidOrder(other.id, other.tier.id, 'Other Show Guest', `door.other.${stamp}@example.invalid`, '0823334444');

    // ═══ making a door link ═══
    const asst = await loginAs('assistant');
    check('an assistant cannot make a door link (403)', (await asst('POST', `/api/admin/ticketing/events/${s.id}/door-passes`, { label: 'Front door' })).status === 403, '');
    check('a door link needs a name (400)', (await api('POST', `/api/admin/ticketing/events/${s.id}/door-passes`, { label: ' ' })).status === 400, '');
    const made1 = await api('POST', `/api/admin/ticketing/events/${s.id}/door-passes`, { label: "Thandi's door" });
    const secret = made1.body && made1.body.link && (made1.body.link.match(/\/checkin\?pass=([A-Za-z0-9_-]{24})$/) || [])[1];
    const stored = secret && await one('SELECT * FROM ticket_door_passes WHERE id = ?', [made1.body.pass.id]);
    check('making a door link returns the link (/checkin?pass=<24-char secret>) and its QR once; the DB keeps ONLY a SHA-256 hash of the secret',
        made1.status === 200 && !!secret && /^data:image\/png;base64,/.test(made1.body.qr) && !!stored && stored.token_hash === crypto.createHash('sha256').update(secret).digest('hex')
        && !JSON.stringify(stored).includes(secret) && stored.label === "Thandi's door", JSON.stringify([made1.status, made1.body && made1.body.pass]));
    const showStart = Date.parse(`${future(1980)}T20:00:00+02:00`);
    check('the link expires on show night (12 hours after the show starts)', !!stored && Math.abs(Date.parse(stored.expires_at) - (showStart + 12 * 3600 * 1000)) < 60000, stored && stored.expires_at);
    const list0 = await api('GET', `/api/admin/ticketing/events/${s.id}/door-passes`);
    check('the list never includes the secret or its hash', list0.status === 200 && list0.body.passes.length === 1 && !JSON.stringify(list0.body).includes(secret) && !('token_hash' in list0.body.passes[0]), '');

    // ═══ using it ═══
    check('the door API without a pass, or with a made-up one, answers 401 "expired or switched off"',
        (await door('GET', '/api/door/event')).status === 401 && (await door('GET', '/api/door/event', 'A'.repeat(24))).body.code === 'DOOR_PASS_INVALID', '');
    const ev = await door('GET', '/api/door/event', secret);
    check('the link opens ITS show: title, counts (0 of 3... of this show only) and the link\'s name',
        ev.status === 200 && ev.body.event.event_id === s.id && ev.body.event.title === 'ZZ Door Link Show' && ev.body.counts.valid === 2 && ev.body.counts.checked_in === 0 && ev.body.pass.label === "Thandi's door", JSON.stringify(ev.body));

    const look = await door('GET', `/api/door/tickets/${tk.token}`, secret);
    check('looking up a ticket of this show: holder, type, "valid" - and NOTHING about the buyer\'s e-mail or phone',
        look.status === 200 && look.body.ticket.status === 'valid' && look.body.ticket.holder === 'Door Buyer' && !look.text.includes(email) && !look.text.includes(phone) && !/buyer_email|buyer_phone|total|cents/.test(look.text), look.text);
    const wrong = await door('GET', `/api/door/tickets/${otk.token}`, secret);
    check('a ticket of ANOTHER show: "wrong show" with that show\'s name, and nothing else (no holder, no order number)',
        wrong.status === 200 && wrong.body.ticket.status === 'wrong_event' && wrong.body.ticket.event_title === 'ZZ Door Other Show' && !wrong.text.includes('Other Show Guest') && !('order_id' in wrong.body.ticket), wrong.text);
    const wrongIn = await door('POST', `/api/door/tickets/${otk.token}/check-in`, secret);
    check('checking in another show\'s ticket is refused (409) and leaves it untouched',
        wrongIn.status === 409 && wrongIn.body.result === 'wrong_event' && !(await one('SELECT checked_in_at FROM tickets WHERE id = ?', [otk.id])).checked_in_at, wrongIn.text);
    check('an unknown ticket code: 404 invalid', (await door('POST', `/api/door/tickets/${'Z'.repeat(24)}/check-in`, secret)).status === 404, '');
    check('a GET never checks anyone in', !(await one('SELECT checked_in_at FROM tickets WHERE id = ?', [tk.id])).checked_in_at, '');

    const [in1, in2] = await Promise.all([door('POST', `/api/door/tickets/${tk.token}/check-in`, secret), door('POST', `/api/door/tickets/${tk.token}/check-in`, secret)]);
    const results = [in1.body.result, in2.body.result].sort();
    const row = await one('SELECT checked_in_at, checked_in_by, checked_in_via FROM tickets WHERE id = ?', [tk.id]);
    check('two taps at once through the door link: exactly one "admitted", one "already scanned"; the check-in records the link\'s name (no admin)',
        results[0] === 'admitted' && results[1] === 'already' && !!row.checked_in_at && row.checked_in_by === null && row.checked_in_via === "Thandi's door", JSON.stringify([results, row]));
    const again = await door('GET', `/api/door/tickets/${tk.token}`, secret);
    check('a re-scan shows who let them in: "<link name> (door link)"', again.body.ticket.status === 'checked_in' && again.body.ticket.checked_in_by === "Thandi's door (door link)", JSON.stringify(again.body.ticket));
    const adminView = await api('GET', `/api/admin/ticketing/tickets/${tk.token}`);
    check('the admin door view says the same', adminView.body.ticket.checked_in_by === "Thandi's door (door link)", JSON.stringify(adminView.body.ticket));

    const byName = await door('GET', '/api/door/search?q=' + encodeURIComponent('Second Guest'), secret);
    const byMail = await door('GET', '/api/door/search?q=' + encodeURIComponent(`door.two.${stamp}`), secret);
    const otherName = await door('GET', '/api/door/search?q=' + encodeURIComponent('Other Show Guest'), secret);
    check('search by name finds this show\'s ticket; search by e-mail finds NOTHING through a door link; another show\'s guest is never found',
        byName.status === 200 && byName.body.results.length === 1 && byName.body.results[0].token === tk2.token && byMail.body.results.length === 0 && otherName.body.results.length === 0 && !byName.text.includes('door.two.'),
        JSON.stringify([byName.body.results.length, byMail.body.results.length, otherName.body.results.length]));

    const list1 = await api('GET', `/api/admin/ticketing/events/${s.id}/door-passes`);
    check('the admin list shows the link was used and how many it checked in (1)', list1.body.passes[0].check_ins === 1 && !!list1.body.passes[0].last_used_at, JSON.stringify(list1.body.passes[0]));

    const undo = await api('POST', `/api/admin/ticketing/tickets/${tk.token}/undo-check-in`, { reason: 'Door link test undo' });
    check('undo check-in also clears the door-link name', undo.status === 200 && (await one('SELECT checked_in_via FROM tickets WHERE id = ?', [tk.id])).checked_in_via === null, JSON.stringify(undo.body));

    // ═══ switching it off / expiry ═══
    const otherPass = await api('POST', `/api/admin/ticketing/events/${other.id}/door-passes`, { label: 'Other door' });
    check('a link cannot be switched off through another show (404)', (await api('DELETE', `/api/admin/ticketing/events/${s.id}/door-passes/${otherPass.body.pass.id}`)).status === 404, '');
    const off = await api('DELETE', `/api/admin/ticketing/events/${s.id}/door-passes/${made1.body.pass.id}`);
    const after = await door('POST', `/api/door/tickets/${tk2.token}/check-in`, secret);
    check('switched off: the link stops working straight away (401) and checks nobody in',
        off.status === 200 && after.status === 401 && !(await one('SELECT checked_in_at FROM tickets WHERE id = ?', [tk2.id])).checked_in_at, JSON.stringify([off.body, after.body]));
    check('switching it off twice: 404', (await api('DELETE', `/api/admin/ticketing/events/${s.id}/door-passes/${made1.body.pass.id}`)).status === 404, '');
    const audit = await q("SELECT action FROM audit_log WHERE table_name = 'ticket_door_passes' AND record_id = ?", [made1.body.pass.id]).catch(() => []);
    check('making and switching off a link are in the audit log', audit.map(a => a.action).sort().join() === 'DOOR_LINK_CREATED,DOOR_LINK_SWITCHED_OFF', JSON.stringify(audit));

    const otherSecret = otherPass.body.link.split('pass=')[1];
    check('the other show\'s link still works', (await door('GET', '/api/door/event', otherSecret)).status === 200, '');
    await writeDb('UPDATE ticket_door_passes SET expires_at = ? WHERE id = ?', [new Date(Date.now() - 1000).toISOString(), otherPass.body.pass.id]);
    check('an expired link stops working (401)', (await door('GET', '/api/door/event', otherSecret)).status === 401, '');

    check('assistants and managers: an assistant cannot list door links (403)', (await asst('GET', `/api/admin/ticketing/events/${s.id}/door-passes`)).status === 403, '');
    check('the door link\'s secret never appears in the server log', !getChildLog().includes(secret) && !getChildLog().includes(otherSecret), '');
}
