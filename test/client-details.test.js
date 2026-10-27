// Client corrections from the tracking drawer ("Your details") and the admin Event-card edit that applies them.
//   POST /api/public/bookings/:id/contact             - the client fixes their own name / phone / company straight away
//   POST /api/public/bookings/:id/correction-request  - email / event / date / time / venue: a booking note + a team e-mail
//   PUT  /api/admin/bookings/:id/event-details        - the team applies event name / type / date / time (reschedule rules)
// Runs against the isolated test DB. Date offsets 2000-2010 belong to this file (an all-day hold sits on 2010).
const { api, pub, one, q, future, sleep, getTrackingToken } = require('./support');

const SVC = 15;
let seq = 0;
const email = () => `cd.${Date.now()}.${seq++}@example.invalid`;

async function makeBooking(em, days, extra = {}) {
    const res = await api('POST', '/api/admin/bookings', Object.assign({
        name: 'Jane Clent', email: em, cell: '+27821234567', company: 'Acme Events', event_date: future(days),
        event_name: 'Year End Function', event_type: 'Corporate Event', event_location: 'Sandton Hall',
        message: 'Client details feature integration test booking.',
        services: [{ service_id: SVC }], status: 'NEW', override_working_hours: true, override_conflict: true
    }, extra));
    return res.body.booking_id;
}

// The team e-mail is sent after the response: poll for it rather than sleeping a fixed time.
async function waitForNotification(subjectLike, timeoutMs = 8000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
        const row = await one('SELECT subject, recipient_email FROM notifications WHERE subject LIKE ? ORDER BY id DESC LIMIT 1', [subjectLike]);
        if (row) return row;
        await sleep(150);
    }
    return null;
}

module.exports = async function ({ check }) {
    const em = email();
    const id = await makeBooking(em, 2000);
    const token = await getTrackingToken(id, em);

    // ── /track shows the client their own details ──
    const tr = await pub('POST', `/api/public/bookings/${id}/track`, { access_token: token });
    const b = tr.body.booking || {};
    check('/track returns the client\'s name, email, phone, venue (their own booking, after the e-mailed code)',
        b.name === 'Jane Clent' && b.email === em && b.cell === '+27821234567' && b.event_location === 'Sandton Hall' && 'performance_slot' in b, JSON.stringify(b));
    check('/track still keeps internal fields out (no admin notes, no client id)', !('admin_notes' in b) && !('client_id' in b), Object.keys(b).join(','));

    // ── the client fixes low-risk details straight away ──
    const noAuth = await pub('POST', `/api/public/bookings/${id}/contact`, { name: 'Jane Client' });
    check('contact: refused without a verified session', noAuth.status === 401, `${noAuth.status}`);

    const bad = await pub('POST', `/api/public/bookings/${id}/contact`, { access_token: token, cell: 'call me' });
    check('contact: a phone number that is not one is refused with a message', bad.status === 400 && /valid phone/i.test(bad.body.message), JSON.stringify(bad.body));
    const shortName = await pub('POST', `/api/public/bookings/${id}/contact`, { access_token: token, name: 'J' });
    check('contact: a one-letter name is refused', shortName.status === 400, JSON.stringify(shortName.body));

    const ok = await pub('POST', `/api/public/bookings/${id}/contact`, {
        access_token: token, name: 'Jane Client', cell: '083 555 0101', company: '', email: 'hijack@example.invalid'
    });
    const row = await one('SELECT name, cell, company, email FROM bookings WHERE id = ?', [id]);
    check('contact: name, phone and company are saved (company cleared)', ok.status === 200 && ok.body.success && row.name === 'Jane Client' && row.cell === '083 555 0101' && row.company === null, JSON.stringify({ body: ok.body, row }));
    check('contact: the e-mail is NOT changed by this route (it decides who can open the booking)', row.email === em, row.email);
    check('contact: the response echoes the saved values for the drawer', ok.body.booking && ok.body.booking.name === 'Jane Client' && ok.body.booking.cell === '083 555 0101', JSON.stringify(ok.body.booking));
    const audit = await one("SELECT old_values, new_values, changed_by FROM audit_log WHERE table_name = 'bookings' AND record_id = ? AND action = 'CONTACT_UPDATED' ORDER BY id DESC LIMIT 1", [id]);
    check('contact: an audit row records old and new values, by "client"', audit && audit.changed_by === 'client' && /Jane Clent/.test(audit.old_values) && /083 555 0101/.test(audit.new_values), JSON.stringify(audit));
    const note = await one("SELECT note, author FROM booking_notes WHERE booking_id = ? AND note LIKE '[Client updated their details]%' ORDER BY id DESC LIMIT 1", [id]);
    check('contact: a booking note tells the team what the client changed', note && note.author === 'Client' && /Phone: \+27821234567 → 083 555 0101/.test(note.note) && /Company: Acme Events → \(blank\)/.test(note.note), JSON.stringify(note));
    const client = await one('SELECT c.full_name, c.phone FROM clients c JOIN bookings b ON b.client_id = c.id WHERE b.id = ?', [id]);
    check('contact: the linked client record follows (name + phone)', client && client.full_name === 'Jane Client' && client.phone === '083 555 0101', JSON.stringify(client));

    const same = await pub('POST', `/api/public/bookings/${id}/contact`, { access_token: token, name: 'Jane Client', cell: '083 555 0101', company: '' });
    const notesAfter = await q("SELECT id FROM booking_notes WHERE booking_id = ? AND note LIKE '[Client updated their details]%'", [id]);
    check('contact: saving the same values changes nothing and adds no note', same.body.success && same.body.unchanged === true && notesAfter.length === 1, JSON.stringify({ same: same.body, notes: notesAfter.length }));

    // ── high-risk details: a request, as a booking note + a team e-mail ──
    const noField = await pub('POST', `/api/public/bookings/${id}/correction-request`, { access_token: token, field: 'price', details: 'Make it cheaper please' });
    check('correction: an unknown field is refused', noField.status === 400, JSON.stringify(noField.body));
    const noDetails = await pub('POST', `/api/public/bookings/${id}/correction-request`, { access_token: token, field: 'event_date', details: 'x' });
    check('correction: an empty "should be" is refused', noDetails.status === 400, JSON.stringify(noDetails.body));

    const req = await pub('POST', `/api/public/bookings/${id}/correction-request`, { access_token: token, field: 'event_date', details: 'It is on the 14th, not the 13th' });
    check('correction: accepted with a thank-you message', req.status === 200 && req.body.success && /our team/i.test(req.body.message), JSON.stringify(req.body));
    const reqNote = await one("SELECT note, author FROM booking_notes WHERE booking_id = ? AND note LIKE '[Correction Request]%' ORDER BY id DESC LIMIT 1", [id]);
    const bookingDate = (await one('SELECT date FROM bookings WHERE id = ?', [id])).date;
    check('correction: the booking note names the field, what it is now, what it should be, and where to fix it',
        reqNote && reqNote.author === 'Client' && /\[Correction Request\] Event date/.test(reqNote.note) && reqNote.note.includes('Currently: ' + bookingDate) &&
        /It is on the 14th, not the 13th/.test(reqNote.note) && /Event card/.test(reqNote.note), JSON.stringify(reqNote));
    const mail = await waitForNotification(`%Correction Request – Booking #${id}%`);
    check('correction: the team is e-mailed', !!mail, JSON.stringify(mail));
    const unchangedDate = (await one('SELECT date FROM bookings WHERE id = ?', [id])).date;
    check('correction: nothing on the booking changes until the team applies it', unchangedDate === bookingDate, unchangedDate);

    // ── closed bookings: no changes online ──
    const em2 = email();
    const id2 = await makeBooking(em2, 2001);
    const token2 = await getTrackingToken(id2, em2);
    await api('PUT', `/api/admin/bookings/${id2}/status`, { status: 'CANCELLED', reason: 'test' });
    const closed = await pub('POST', `/api/public/bookings/${id2}/contact`, { access_token: token2, cell: '0830000000' });
    const closedReq = await pub('POST', `/api/public/bookings/${id2}/correction-request`, { access_token: token2, field: 'other', details: 'Anything at all' });
    check('a cancelled booking can no longer be changed online (both routes say so)', closed.status === 409 && closedReq.status === 409, `${closed.status} / ${closedReq.status}`);

    // ── the team applies it: admin Event-card edit ──
    const newDate = future(2005);
    const ed = await api('PUT', `/api/admin/bookings/${id}/event-details`, {
        event_name: 'Year-End Gala', event_type: 'Private Function', date: newDate, start_time: '18:00', end_time: '19:30'
    });
    const after = await one('SELECT event_name, event_type, date, event_start_time, performance_end_time, performance_slot FROM bookings WHERE id = ?', [id]);
    check('admin event edit: name, type, date and time are saved', ed.status === 200 && ed.body.success && after.event_name === 'Year-End Gala' && after.event_type === 'Private Function' &&
        after.date === newDate && after.event_start_time === '18:00' && after.performance_end_time === '19:30', JSON.stringify({ body: ed.body, after }));
    check('admin event edit: the readable slot follows the times ("18:00–19:30")', after.performance_slot === '18:00–19:30', after.performance_slot);
    const evAudit = await one("SELECT new_values FROM audit_log WHERE table_name = 'bookings' AND record_id = ? AND action = 'EVENT_UPDATED' ORDER BY id DESC LIMIT 1", [id]);
    check('admin event edit: the name/type change is audited', evAudit && /Year-End Gala/.test(evAudit.new_values), JSON.stringify(evAudit));
    const dateAudit = await one("SELECT new_values FROM audit_log WHERE table_name = 'bookings' AND record_id = ? AND action = 'UPDATE' AND new_values LIKE ? ORDER BY id DESC LIMIT 1", [id, `%${newDate}%`]);
    check('admin event edit: the date change went through the reschedule rules (their audit row)', !!dateAudit, JSON.stringify(dateAudit));

    const badEdit = await api('PUT', `/api/admin/bookings/${id}/event-details`, { date: '2026-02-31', start_time: '7pm' });
    check('admin event edit: an impossible date and a non-HH:MM time are refused', badEdit.status === 400 && /valid date/i.test(badEdit.body.message) && /HH:MM/.test(badEdit.body.message), JSON.stringify(badEdit.body));

    // a clash: an all-day hold on the target date refuses the move, and NOTHING else in the same save is applied
    const heldDate = future(2010);
    await api('POST', '/api/admin/calendar/hold', { date: heldDate, reason: 'client-details clash test' });
    const clash = await api('PUT', `/api/admin/bookings/${id}/event-details`, { event_name: 'Should Not Stick', date: heldDate });
    const afterClash = await one('SELECT event_name, date FROM bookings WHERE id = ?', [id]);
    check('admin event edit: a date that clashes is refused (409) and the name in the same save is not applied either',
        clash.status === 409 && afterClash.date === newDate && afterClash.event_name === 'Year-End Gala', JSON.stringify({ clash: clash.body, afterClash }));

    const nothing = await api('PUT', `/api/admin/bookings/${id}/event-details`, { event_name: 'Year-End Gala', date: newDate, start_time: '18:00', end_time: '19:30' });
    check('admin event edit: saving the same values changes nothing', nothing.body.success && nothing.body.updated.length === 0, JSON.stringify(nothing.body));
};
