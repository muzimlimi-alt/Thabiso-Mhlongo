// Three things found missing while checking the business-profile work (docs-internal/business-profile-2026.md) against the booking
// drawer where a booking is actually managed:
//   A. an administrator correcting what a client gave us (a typo'd cell number, a changed e-mail, a VAT number or billing address
//      they forgot) - routes/admin/bookings.js PUT :id/contact, js/admin/bookings-pipeline.js + bookings-actions.js;
//   B. a billing address for a full tax invoice (VAT Act s20, over R5,000) had nowhere to be captured - now alongside the client's
//      VAT number, at accept-quote (routes/public/bookings.js) and from the admin edit above;
//   C. lib/business-profile-core.js's taxInvoiceAdvice() was built and unit-tested but never wired to anything - the Quote Builder
//      now shows it live (js/admin/bookings-quote.js), fed by the threshold /api/admin/services/meta now exposes.
// Two smaller drive-by fixes this surfaced: the booking pipeline's quote/invoice detail panels hard-coded "VAT (15%)" instead of
// reading what was actually stored, and the canned inquiry-reply templates signed off with a name independent of Business Profile's
// trading name (so changing it there did nothing to client-facing e-mail). Date offsets 1850-1879 are reserved for this file.
module.exports = async function ({ check, api, pub, one, q, future, sleep, loginAs, getTrackingToken }) {
    const poll = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(120); } return v; };
    const sClub = (await one("SELECT id FROM services WHERE name = 'Club – 10 min Set (Guest Spot)'")).id;   // fixed R5,000
    let day = 1850, seq = 0;

    // An ACCEPTED-or-later booking with a known client, through the real flow (admin creates+quotes, client accepts) so it carries a
    // client_id and (optionally) a company name - the condition the public VAT/billing-address fields actually show under.
    async function quotedBooking(label, { company, applyVat = false, total = 2500 } = {}) {
        const email = `bca.${Date.now()}.${seq++}@example.invalid`;
        const created = await api('POST', '/api/admin/bookings', {
            name: `BCA ${label}`, email, cell: '+27821234567', company: company || undefined, event_date: future(day++), event_name: `BCA ${label}`,
            event_type: 'Corporate', event_location: 'Hall', message: 'Booking-contact test booking, over ten characters.',
            services: [{ service_id: sClub }], status: 'NEW', override_working_hours: true, override_conflict: true });
        const id = created.body && created.body.booking_id;
        if (!id) throw new Error(`could not create booking "${label}": ${created.status} ${JSON.stringify(created.body)}`);
        const bk = await one('SELECT date FROM bookings WHERE id = ?', [id]);
        const expiry = new Date(Date.parse(bk.date) - 10 * 86400000).toISOString().slice(0, 10);
        await api('POST', `/api/admin/bookings/${id}/quote`, { quote_expiry_date: expiry, terms: 'T', apply_vat: applyVat, discount: 0,
            items: [{ service_id: sClub, description: 'Club set', quantity: 1, unit_price: total, pricing_model: 'flat_fee' }] });
        const token = await getTrackingToken(id, email);
        return { id, email, token };
    }
    const row = (id) => one('SELECT * FROM bookings WHERE id = ?', [id]);
    const client = (clientId) => one('SELECT * FROM clients WHERE id = ?', [clientId]);
    const update = (id, body) => api('PUT', `/api/admin/bookings/${id}/contact`, body);
    const auditFor = (id) => q("SELECT * FROM audit_log WHERE table_name = 'bookings' AND record_id = ? AND action = 'CONTACT_UPDATED' ORDER BY id DESC LIMIT 1", [id]);

    try {
        // ═══ A. the admin edit itself ═══
        const A = await quotedBooking('A', { company: 'Acme Events' });
        const before = await row(A.id);
        const r1 = await update(A.id, { cell: '+27 83 999 1234' });
        check('a partial update (cell only) succeeds and touches only that column', r1.status === 200 && r1.body.success && r1.body.updated.length === 1 && r1.body.updated[0] === 'cell', JSON.stringify(r1.body));
        const afterCell = await row(A.id);
        check('...the cell is saved, everything else on the booking is untouched', afterCell.cell === '+27 83 999 1234' && afterCell.name === before.name && afterCell.email === before.email && afterCell.company === before.company, JSON.stringify(afterCell));

        const r2 = await update(A.id, { name: 'Acme Events Pty Ltd Contact', company: 'Acme Events (Pty) Ltd', vat_number: ' 4010 123-456 ', billing_address: '12 Main Road, Sandton, 2196' });
        check('name, company, VAT number (spaces/dashes ignored) and billing address can all be corrected together', r2.status === 200 && r2.body.success, JSON.stringify(r2.body));
        const afterAll = await row(A.id);
        check('...every one of them is saved exactly as normalised', afterAll.name === 'Acme Events Pty Ltd Contact' && afterAll.company === 'Acme Events (Pty) Ltd' && afterAll.vat_number === '4010123456' && afterAll.billing_address === '12 Main Road, Sandton, 2196', JSON.stringify(afterAll));
        const audit = (await auditFor(A.id))[0];
        check('...the change is audited, old and new values only for what actually changed', audit && JSON.parse(audit.old_values).name === before.name && JSON.parse(audit.new_values).name === 'Acme Events Pty Ltd Contact' && !('cell' in JSON.parse(audit.new_values)), JSON.stringify(audit));
        const clientAfter = await client(afterAll.client_id);
        check('...the linked client record is mirrored too (so another booking by the same person sees the correction)', clientAfter && clientAfter.vat_number === '4010123456' && clientAfter.billing_address === '12 Main Road, Sandton, 2196' && clientAfter.phone === '+27 83 999 1234', JSON.stringify(clientAfter));

        // clearing company/vat/address (an empty string, not omitted)
        const r3 = await update(A.id, { company: '', vat_number: '', billing_address: '' });
        const cleared = await row(A.id);
        check('an explicit empty string CLEARS the field (the client is no longer a company booking, say)', r3.status === 200 && cleared.company === null && cleared.vat_number === null && cleared.billing_address === null, JSON.stringify(cleared));

        // ═══ validation: nothing bad is saved ═══
        const B = await quotedBooking('B');
        const bBefore = await row(B.id);
        const bad = [
            ['a one-letter name', { name: 'X' }, 'name'],
            ['an e-mail with no @', { email: 'not-an-email' }, 'email'],
            ['a cell that is not phone-shaped', { cell: '##' }, 'cell'],
            ['a VAT number that is not 10 digits starting with 4', { vat_number: '1234567890' }, 'vat_number'],
            ['a billing address over 300 characters', { billing_address: 'x'.repeat(301) }, 'billing_address'],
        ];
        let allRefused = true, allUnchanged = true;
        for (const [label, body, field] of bad) {
            const r = await update(B.id, body);
            if (!(r.status === 400 && r.body.errors && r.body.errors[field])) { allRefused = false; console.error('  -> not refused:', label, JSON.stringify(r.body)); }
        }
        const bAfter = await row(B.id);
        for (const f of ['name', 'email', 'cell', 'vat_number', 'billing_address']) if (String(bAfter[f] || '') !== String(bBefore[f] || '')) allUnchanged = false;
        check('every malformed field is refused with a 400 and an error FOR THAT FIELD, and nothing was saved', allRefused && allUnchanged, JSON.stringify({ allRefused, allUnchanged, bBefore, bAfter }));
        check('an empty body (nothing recognised) is refused', (await update(B.id, {})).status === 400, '');
        check('an unknown booking is 404', (await update(999999, { name: 'X Y' })).status === 404, '');

        // ═══ changing the e-mail relinks the client (does not rename whoever else holds the old one) ═══
        const C = await quotedBooking('C');
        const originalClientId = (await row(C.id)).client_id;
        const newEmail = `bca.relinked.${Date.now()}@example.invalid`;
        const r4 = await update(C.id, { email: newEmail });
        const cAfter = await row(C.id);
        check('a corrected e-mail relinks the booking to a client under the NEW address', r4.status === 200 && cAfter.email === newEmail && cAfter.client_id !== originalClientId, JSON.stringify(cAfter));
        const newClient = await client(cAfter.client_id);
        check('...a client record now exists for it', newClient && newClient.email.toLowerCase() === newEmail.toLowerCase(), JSON.stringify(newClient));
        const oldClient = await client(originalClientId);
        check('...and the OLD client record (whoever else might still reference it) was never touched', oldClient && oldClient.email !== newEmail, JSON.stringify(oldClient));
        // re-linking to an e-mail that ALREADY has a client row reuses it rather than duplicating
        const D = await quotedBooking('D');
        const r5 = await update(D.id, { email: newEmail });
        check('linking a second booking to that SAME (now existing) e-mail reuses the client row rather than creating another', r5.status === 200 && (await row(D.id)).client_id === cAfter.client_id, JSON.stringify(await row(D.id)));

        // ═══ who may do this ═══
        const manager = await loginAs('manager');
        const assistant = await loginAs('assistant');
        const E = await quotedBooking('E');
        check('unauthenticated is 401, an assistant is 403, a manager is allowed',
            (await pub('PUT', `/api/admin/bookings/${E.id}/contact`, { name: 'No Session' })).status === 401
            && (await assistant('PUT', `/api/admin/bookings/${E.id}/contact`, { name: 'Blocked' })).status === 403
            && (await row(E.id)).name !== 'Blocked'
            && (await manager('PUT', `/api/admin/bookings/${E.id}/contact`, { name: 'Manager Edit' })).status === 200, '');
        check('...and the attempt by the assistant was never saved', (await row(E.id)).name !== 'Blocked', '');

        // GET /api/admin/bookings (the list that feeds the Deal View's own refresh) and GET /:id both carry the correction straight away
        const F = await quotedBooking('F');
        await update(F.id, { billing_address: '1 List View Street' });
        const listRow = (await api('GET', `/api/admin/bookings?search=${F.id}&limit=5`)).body.bookings.find((b) => b.id === F.id);
        const singleRow = (await api('GET', `/api/admin/bookings/${F.id}`)).body;
        check('the booking list and the single-booking fetch both carry the new billing address (what the Deal View redraws from)', listRow && listRow.billing_address === '1 List View Street' && singleRow.billing_address === '1 List View Street', JSON.stringify({ listRow, singleRow }));

        // ═══ B. billing address at accept-quote, alongside VAT number ═══
        const G = await quotedBooking('G', { company: 'Beta Co' });
        const acc = await pub('POST', `/api/public/bookings/${G.id}/accept-quote`, { access_token: G.token, terms_agreed: true, vat_number: '4987654321', billing_address: '9 Client Avenue, Pretoria' });
        check('accepting a quote with a billing address stores it, alongside the VAT number, on the booking', acc.status === 200 && (await row(G.id)).billing_address === '9 Client Avenue, Pretoria' && (await row(G.id)).vat_number === '4987654321', JSON.stringify(await row(G.id)));
        const tr = await pub('POST', `/api/public/bookings/${G.id}/track`, { access_token: G.token });
        check('...and it comes back on the client\'s own tracking page (what the Accept Quote screen pre-fills from)', tr.body && tr.body.booking && tr.body.booking.billing_address === '9 Client Avenue, Pretoria', JSON.stringify(tr.body && tr.body.booking && tr.body.booking.billing_address));
        const H = await quotedBooking('H', { company: 'Gamma Inc' });
        const overLong = await pub('POST', `/api/public/bookings/${H.id}/accept-quote`, { access_token: H.token, terms_agreed: true, billing_address: 'x'.repeat(301) });
        check('an address over 300 characters is refused (nothing accepted, nothing saved)', overLong.status === 400 && (await row(H.id)).status !== 'ACCEPTED', JSON.stringify(overLong.body));

        // ═══ C. the advisory threshold is exposed for the Quote Builder ═══
        const meta = (await api('GET', '/api/admin/services/meta')).body;
        check('/api/admin/services/meta exposes the R5,000 full-tax-invoice threshold the Quote Builder warns against (lib/business-profile-core.js)', meta.full_tax_invoice_over === 5000, JSON.stringify(meta.full_tax_invoice_over));
    } finally {
        // nothing global was changed by this file - every write above was scoped to its own freshly-created booking/client.
    }
};
