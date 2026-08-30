const express = require('express');
const path = require('path');
const fs = require('fs');
const moment = require('moment-timezone');
const db = require('../../database');
const { requireAdmin } = require('../../middleware/auth');
const { requireRole } = require('../../middleware/rbac');
const { mutateRateLimiter } = require('../../middleware/rate-limiters');
const { dbGet, dbRun } = require('../../lib/db-helpers');
const { withDbTransaction } = require('../../lib/db-transaction');
const { docsWriteDir, resolveDocsPath } = require('../../lib/runtime-paths');
const { encodeUserHtml } = require('../../lib/html-sanitize');
const { getBookingByIdAsync, getBookingIdStatusAsync } = require('../../database/repositories/bookings.repository');
const emailService = require('../../js/emailService');
const pdfService = require('../../js/pdfService');
const router = express.Router();

// ==========================================
// ADVANCING PACK (Deal View "Advancing" tab) — run-of-show, technical, hospitality,
// contacts, travel. Available from CONFIRMED onward (DG-A4). Auto-sourced contacts
// (client/venue/artist/manager) are resolved live for editing and snapshotted into the
// PDF/email only at generate/send time (DG-A5) so a later change to the source record
// doesn't retroactively alter a pack already sent.
// ==========================================

// Sends the advancing pack PDF to the client and (if it has a contact email) the venue.
// Plain HTML body wrapped by the existing createEmailWrapper() via sendEmail()'s default
// (non-preWrapped) path — not the newer bespoke emailComponents.js template system, which is a
// separate, larger piece of work. pack.internal_notes is never included — office-only.
async function sendAdvancingPackEmail(booking, venue, pdfPath) {
    const subject = `Advancing Pack — ${booking.event_name || booking.event_type || 'Your Event'} (${booking.date})`;
    const html = `
        <p>Hi,</p>
        <p>Please find attached the advancing pack for <strong>${encodeUserHtml(booking.event_name || booking.event_type || 'the event')}</strong> on <strong>${encodeUserHtml(booking.date || '')}</strong>${booking.event_location ? ' at ' + encodeUserHtml(booking.event_location) : ''}.</p>
        <p>It covers the run-of-show, technical and hospitality requirements, show-day contacts, and travel arrangements.</p>
        <p>Please get in touch if anything needs adjusting before the day.</p>
        <p>Thabiso Mhlongo Management</p>
    `;
    const attachments = [{ filename: `Advancing_Pack_${booking.id}.pdf`, path: pdfPath }];
    const recipients = [];
    if (booking.email) recipients.push(booking.email);
    if (venue && venue.contact_email && venue.contact_email !== booking.email) recipients.push(venue.contact_email);

    for (const to of recipients) {
        await emailService.sendEmail({
            to, subject, htmlContent: html, attachments,
            trigger_event: 'advancing_pack_sent', related_entity: 'booking', related_id: booking.id
        });
    }
}

// Ensures a pack row exists for this booking, creating a bare draft if needed — the ROS/contacts
// child-table routes can be the very first write for a booking (e.g. adding a run-of-show item
// before ever saving the header form).
async function ensureAdvancingPack(bookingId) {
    let pack = await dbGet("SELECT id FROM advancing_packs WHERE booking_id = ?", [bookingId]);
    if (!pack) {
        const ins = await dbRun("INSERT INTO advancing_packs (booking_id) VALUES (?)", [bookingId]);
        pack = { id: ins.lastID };
    }
    return pack;
}

// These two run-of-show routes and the contact-delete route below aren't nested under
// /bookings/:id (mirroring the original spec's route shape), so without an explicit ownership
// check any admin session could edit/delete another booking's row just by guessing/replaying an
// id — found in an end-to-end booking-flow audit. The frontend already knows the booking id it's
// editing, so it sends it along and the server verifies the item's pack actually belongs to it.
async function verifyRosOwnership(itemId, bookingId) {
    if (!bookingId) return false;
    const row = await dbGet(
        `SELECT r.id FROM run_of_show_items r
         JOIN advancing_packs ap ON ap.id = r.pack_id
         WHERE r.id = ? AND ap.booking_id = ?`,
        [itemId, bookingId]
    );
    return !!row;
}
async function verifyAdvancingContactOwnership(contactId, bookingId) {
    if (!bookingId) return false;
    const row = await dbGet(
        `SELECT c.id FROM advancing_contacts c
         JOIN advancing_packs ap ON ap.id = c.pack_id
         WHERE c.id = ? AND ap.booking_id = ?`,
        [contactId, bookingId]
    );
    return !!row;
}

// Resolves the four auto-sourced contacts + any manually-added extras, live, for PDF/email
// snapshotting (DG-A5) — shared by the pdf and send routes so they never drift.
async function resolveAdvancingContacts(booking, venue, packId) {
    const extraContacts = await new Promise((resolve, reject) =>
        db.all("SELECT * FROM advancing_contacts WHERE pack_id = ?", [packId], (e, r) => e ? reject(e) : resolve(r)));
    const artist = await dbGet("SELECT stage_name AS name, email, phone FROM comedians WHERE id = 1");
    const manager = await dbGet("SELECT name, email, cell_number AS phone FROM manager_details LIMIT 1");
    return [
        { role: 'Client', name: booking.name, phone: booking.cell, email: booking.email },
        venue ? { role: 'Venue', name: venue.contact_name, phone: venue.contact_phone, email: venue.contact_email } : null,
        artist ? { role: 'Artist', name: artist.name, phone: artist.phone, email: artist.email } : null,
        manager ? { role: 'Manager', name: manager.name, phone: manager.phone, email: manager.email } : null,
        ...extraContacts.map(c => ({ role: c.role, name: c.name, phone: c.phone, email: c.email }))
    ].filter(Boolean);
}

router.get('/api/admin/bookings/:id/advancing', requireAdmin, async (req, res) => {
    try {
        const bookingId = req.params.id;
        const booking = await getBookingByIdAsync(bookingId);
        if (!booking) return res.status(404).json({ success: false, message: 'Booking not found.' });

        if (!['CONFIRMED', 'COMPLETED'].includes((booking.status || '').toUpperCase())) {
            return res.status(409).json({ success: false, needsConfirmation: true, message: 'Confirm the booking first to start its advancing pack.' });
        }

        const venue = booking.venue_id ? await dbGet("SELECT * FROM venues WHERE id = ?", [booking.venue_id]) : null;

        let pack = await dbGet("SELECT * FROM advancing_packs WHERE booking_id = ?", [bookingId]);
        if (!pack) {
            // Pre-filled draft skeleton — not persisted until the admin actually saves something.
            pack = {
                id: null, booking_id: Number(bookingId), status: 'draft',
                mic_type: null, pa_spec: null, monitors: null, lighting: null,
                stage_layout: null, equipment_responsibility: null,
                green_room_notes: venue ? venue.green_room_notes : null,
                meals: null, dietary: null, parking_wifi: null,
                travel_type: null, flights: null, hotel: null, ground_transport: null,
                internal_notes: null, pdf_url: null,
                sent_to_client_at: null, sent_to_venue_at: null, confirmed_at: null
            };
        }

        const rosItems = pack.id ? await new Promise((resolve, reject) =>
            db.all("SELECT * FROM run_of_show_items WHERE pack_id = ? ORDER BY sort_order ASC, id ASC", [pack.id], (e, r) => e ? reject(e) : resolve(r))
        ) : [];
        const extraContacts = pack.id ? await new Promise((resolve, reject) =>
            db.all("SELECT * FROM advancing_contacts WHERE pack_id = ? ORDER BY id ASC", [pack.id], (e, r) => e ? reject(e) : resolve(r))
        ) : [];

        const artist = await dbGet("SELECT stage_name AS name, email, phone FROM comedians WHERE id = 1");
        const manager = await dbGet("SELECT name, email, cell_number AS phone FROM manager_details LIMIT 1");
        const autoContacts = [
            { role: 'Client', name: booking.name, phone: booking.cell, email: booking.email, source: 'booking' },
            { role: 'Venue', name: venue ? venue.contact_name : null, phone: venue ? venue.contact_phone : null, email: venue ? venue.contact_email : null, source: 'venue' },
            { role: 'Artist', name: artist ? artist.name : null, phone: artist ? artist.phone : null, email: artist ? artist.email : null, source: 'comedians' },
            { role: 'Manager', name: manager ? manager.name : null, phone: manager ? manager.phone : null, email: manager ? manager.email : null, source: 'manager_details' }
        ];

        res.json({ success: true, pack, run_of_show: rosItems, contacts: extraContacts, auto_contacts: autoContacts, venue: venue || null });
    } catch (e) {
        console.error('[Advancing] GET failed:', e.message);
        res.status(500).json({ success: false, message: 'Could not load the advancing pack.' });
    }
});

router.put('/api/admin/bookings/:id/advancing', requireAdmin, async (req, res) => {
    try {
        const bookingId = req.params.id;
        const booking = await getBookingIdStatusAsync(bookingId);
        if (!booking) return res.status(404).json({ success: false, message: 'Booking not found.' });
        if (!['CONFIRMED', 'COMPLETED'].includes((booking.status || '').toUpperCase())) {
            return res.status(409).json({ success: false, message: 'Confirm the booking first.' });
        }

        const {
            mic_type, pa_spec, monitors, lighting, stage_layout, equipment_responsibility,
            green_room_notes, meals, dietary, parking_wifi,
            travel_type, flights, hotel, ground_transport, internal_notes
        } = req.body;

        if (travel_type != null && travel_type !== '' && !['local', 'out_of_town'].includes(travel_type)) {
            return res.status(400).json({ success: false, message: "travel_type must be 'local', 'out_of_town', or empty." });
        }

        const vals = [mic_type, pa_spec, monitors, lighting, stage_layout, equipment_responsibility,
            green_room_notes, meals, dietary, parking_wifi,
            travel_type, flights, hotel, ground_transport, internal_notes].map(v => v || null);

        const existing = await dbGet("SELECT id FROM advancing_packs WHERE booking_id = ?", [bookingId]);
        if (existing) {
            await dbRun(
                `UPDATE advancing_packs SET
                    mic_type = ?, pa_spec = ?, monitors = ?, lighting = ?, stage_layout = ?, equipment_responsibility = ?,
                    green_room_notes = ?, meals = ?, dietary = ?, parking_wifi = ?,
                    travel_type = ?, flights = ?, hotel = ?, ground_transport = ?, internal_notes = ?,
                    updated_at = CURRENT_TIMESTAMP
                 WHERE booking_id = ?`,
                [...vals, bookingId]
            );
        } else {
            await dbRun(
                `INSERT INTO advancing_packs
                    (booking_id, mic_type, pa_spec, monitors, lighting, stage_layout, equipment_responsibility,
                     green_room_notes, meals, dietary, parking_wifi, travel_type, flights, hotel, ground_transport, internal_notes)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [bookingId, ...vals]
            );
        }

        const pack = await dbGet("SELECT * FROM advancing_packs WHERE booking_id = ?", [bookingId]);
        res.json({ success: true, pack });
    } catch (e) {
        console.error('[Advancing] PUT failed:', e.message);
        res.status(500).json({ success: false, message: 'Could not save the advancing pack.' });
    }
});

router.post('/api/admin/bookings/:id/advancing/run-of-show', requireAdmin, async (req, res) => {
    try {
        const { time_label, duration_minutes, title, detail, responsible } = req.body;
        if (!title || !title.trim()) return res.status(400).json({ success: false, message: 'title is required.' });

        const pack = await ensureAdvancingPack(req.params.id);
        const maxRow = await dbGet("SELECT MAX(sort_order) AS m FROM run_of_show_items WHERE pack_id = ?", [pack.id]);
        const nextOrder = (maxRow && maxRow.m != null ? maxRow.m : -1) + 1;

        const ins = await dbRun(
            `INSERT INTO run_of_show_items (pack_id, sort_order, time_label, duration_minutes, title, detail, responsible)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [pack.id, nextOrder, time_label || null, duration_minutes || null, title.trim(), detail || null, responsible || null]
        );
        const item = await dbGet("SELECT * FROM run_of_show_items WHERE id = ?", [ins.lastID]);
        res.json({ success: true, item });
    } catch (e) {
        console.error('[Advancing] ROS create failed:', e.message);
        res.status(500).json({ success: false, message: 'Could not add the run-of-show item.' });
    }
});

router.put('/api/admin/advancing/run-of-show/:itemId', requireAdmin, async (req, res) => {
    try {
        const { time_label, duration_minutes, title, detail, responsible, booking_id } = req.body;
        if (!title || !title.trim()) return res.status(400).json({ success: false, message: 'title is required.' });
        if (!(await verifyRosOwnership(req.params.itemId, booking_id))) {
            return res.status(404).json({ success: false, message: 'Item not found.' });
        }
        await dbRun(
            `UPDATE run_of_show_items SET time_label = ?, duration_minutes = ?, title = ?, detail = ?, responsible = ? WHERE id = ?`,
            [time_label || null, duration_minutes || null, title.trim(), detail || null, responsible || null, req.params.itemId]
        );
        const item = await dbGet("SELECT * FROM run_of_show_items WHERE id = ?", [req.params.itemId]);
        res.json({ success: true, item });
    } catch (e) {
        console.error('[Advancing] ROS update failed:', e.message);
        res.status(500).json({ success: false, message: 'Could not update the run-of-show item.' });
    }
});

router.delete('/api/admin/advancing/run-of-show/:itemId', requireAdmin, async (req, res) => {
    try {
        const bookingId = req.body && req.body.booking_id;
        if (!(await verifyRosOwnership(req.params.itemId, bookingId))) {
            return res.status(404).json({ success: false, message: 'Item not found.' });
        }
        await dbRun("DELETE FROM run_of_show_items WHERE id = ?", [req.params.itemId]);
        res.json({ success: true });
    } catch (e) {
        console.error('[Advancing] ROS delete failed:', e.message);
        res.status(500).json({ success: false, message: 'Could not delete the run-of-show item.' });
    }
});

// Rewrites sort_order for every id in orderedIds, atomically — the shared sqlite connection can
// only hold one open transaction at a time (see withDbTransaction's own comment), so a multi-row
// reorder must queue behind other guarded sections rather than issue bare sequential UPDATEs.
router.put('/api/admin/bookings/:id/advancing/run-of-show/reorder', requireAdmin, async (req, res) => {
    const { orderedIds } = req.body;
    if (!Array.isArray(orderedIds) || !orderedIds.length) {
        return res.status(400).json({ success: false, message: 'orderedIds must be a non-empty array.' });
    }
    // Verify every id actually belongs to this booking's pack before touching anything — this route
    // IS booking-scoped in its URL, but the UPDATE loop below wasn't checking that.
    const pack = await dbGet("SELECT id FROM advancing_packs WHERE booking_id = ?", [req.params.id]);
    if (!pack) return res.status(404).json({ success: false, message: 'No advancing pack for this booking.' });
    const owned = await new Promise((resolve, reject) =>
        db.all("SELECT id FROM run_of_show_items WHERE pack_id = ?", [pack.id], (e, r) => e ? reject(e) : resolve(r)));
    const ownedIds = new Set(owned.map(r => Number(r.id)));
    if (!orderedIds.every(id => ownedIds.has(Number(id)))) {
        return res.status(403).json({ success: false, message: 'One or more items do not belong to this booking.' });
    }
    const outcome = await withDbTransaction(async () => {
        try {
            await dbRun("BEGIN IMMEDIATE");
        } catch (beginErr) {
            console.error('[Advancing] reorder BEGIN failed:', beginErr.message);
            return { status: 500, body: { success: false, message: 'Database error while reordering.' } };
        }
        try {
            for (let i = 0; i < orderedIds.length; i++) {
                await dbRun("UPDATE run_of_show_items SET sort_order = ? WHERE id = ?", [i, orderedIds[i]]);
            }
            await dbRun("COMMIT");
            return { status: 200, body: { success: true } };
        } catch (e) {
            await dbRun("ROLLBACK").catch(() => {});
            console.error('[Advancing] reorder failed:', e.message);
            return { status: 500, body: { success: false, message: 'Could not save the new order.' } };
        }
    });
    res.status(outcome.status).json(outcome.body);
});

router.post('/api/admin/bookings/:id/advancing/contacts', requireAdmin, async (req, res) => {
    try {
        const { role, name, phone, email } = req.body;
        if (!name || !name.trim()) return res.status(400).json({ success: false, message: 'name is required.' });
        const pack = await ensureAdvancingPack(req.params.id);
        const ins = await dbRun(
            "INSERT INTO advancing_contacts (pack_id, role, name, phone, email) VALUES (?, ?, ?, ?, ?)",
            [pack.id, role || null, name.trim(), phone || null, email || null]
        );
        const contact = await dbGet("SELECT * FROM advancing_contacts WHERE id = ?", [ins.lastID]);
        res.json({ success: true, contact });
    } catch (e) {
        console.error('[Advancing] contact create failed:', e.message);
        res.status(500).json({ success: false, message: 'Could not add the contact.' });
    }
});

router.delete('/api/admin/advancing/contacts/:contactId', requireAdmin, async (req, res) => {
    try {
        const bookingId = req.body && req.body.booking_id;
        if (!(await verifyAdvancingContactOwnership(req.params.contactId, bookingId))) {
            return res.status(404).json({ success: false, message: 'Contact not found.' });
        }
        await dbRun("DELETE FROM advancing_contacts WHERE id = ?", [req.params.contactId]);
        res.json({ success: true });
    } catch (e) {
        console.error('[Advancing] contact delete failed:', e.message);
        res.status(500).json({ success: false, message: 'Could not delete the contact.' });
    }
});

router.post('/api/admin/bookings/:id/advancing/pdf', requireAdmin, async (req, res) => {
    try {
        const bookingId = req.params.id;
        const booking = await getBookingByIdAsync(bookingId);
        if (!booking) return res.status(404).json({ success: false, message: 'Booking not found.' });

        const pack = await dbGet("SELECT * FROM advancing_packs WHERE booking_id = ?", [bookingId]);
        if (!pack) return res.status(400).json({ success: false, message: 'Save the advancing pack before generating a PDF.' });

        const venue = booking.venue_id ? await dbGet("SELECT * FROM venues WHERE id = ?", [booking.venue_id]) : null;
        const rosItems = await new Promise((resolve, reject) =>
            db.all("SELECT * FROM run_of_show_items WHERE pack_id = ? ORDER BY sort_order ASC, id ASC", [pack.id], (e, r) => e ? reject(e) : resolve(r)));
        const contacts = await resolveAdvancingContacts(booking, venue, pack.id);

        const advancingDir = docsWriteDir('advancing');
        const fileName = `ADV-${bookingId}-${moment().format('YYMMDDHHmmss')}.pdf`;
        const pdfPath = path.join(advancingDir, fileName);

        await pdfService.generateAdvancingPack(booking, pack, rosItems, contacts, pdfPath);
        await dbRun("UPDATE advancing_packs SET pdf_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [fileName, pack.id]);

        res.json({ success: true, pdf_url: fileName });
    } catch (e) {
        console.error('[Advancing] PDF generation failed:', e.message);
        res.status(500).json({ success: false, message: 'Could not generate the advancing pack PDF.' });
    }
});

router.get('/api/admin/bookings/:id/advancing/download', requireAdmin, async (req, res) => {
    try {
        const pack = await dbGet("SELECT pdf_url FROM advancing_packs WHERE booking_id = ?", [req.params.id]);
        if (!pack || !pack.pdf_url) return res.status(404).json({ success: false, message: 'No advancing pack PDF on file yet.' });
        const filePath = resolveDocsPath('advancing', pack.pdf_url);
        if (!fs.existsSync(filePath)) return res.status(404).json({ success: false, message: 'PDF file not found on server.' });
        res.download(filePath, pack.pdf_url, (dlErr) => {
            if (dlErr) console.error('[Advancing Download Error]', dlErr.message);
        });
    } catch (e) {
        console.error('[Advancing] download failed:', e.message);
        res.status(500).json({ success: false, message: 'Could not download the advancing pack.' });
    }
});

// Sends real outbound email to a third party (the venue) — restricted to manager+, matching every
// other outbound-communication-to-a-third-party route in this codebase (e.g. requireRoleForInquiryEmail).
router.post('/api/admin/bookings/:id/advancing/send', requireAdmin, requireRole(['administrator', 'manager']), mutateRateLimiter, async (req, res) => {
    try {
        const bookingId = req.params.id;
        const booking = await getBookingByIdAsync(bookingId);
        if (!booking) return res.status(404).json({ success: false, message: 'Booking not found.' });

        const pack = await dbGet("SELECT * FROM advancing_packs WHERE booking_id = ?", [bookingId]);
        if (!pack) return res.status(400).json({ success: false, message: 'Save the advancing pack before sending it.' });

        const venue = booking.venue_id ? await dbGet("SELECT * FROM venues WHERE id = ?", [booking.venue_id]) : null;
        if (!venue || !venue.contact_email) {
            return res.status(400).json({ success: false, message: 'Link a venue with a contact email before sending the advancing pack.' });
        }

        const rosItems = await new Promise((resolve, reject) =>
            db.all("SELECT * FROM run_of_show_items WHERE pack_id = ? ORDER BY sort_order ASC, id ASC", [pack.id], (e, r) => e ? reject(e) : resolve(r)));
        const contacts = await resolveAdvancingContacts(booking, venue, pack.id);

        const advancingDir = docsWriteDir('advancing');
        const fileName = `ADV-${bookingId}-${moment().format('YYMMDDHHmmss')}.pdf`;
        const pdfPath = path.join(advancingDir, fileName);
        await pdfService.generateAdvancingPack(booking, pack, rosItems, contacts, pdfPath);

        await sendAdvancingPackEmail(booking, venue, pdfPath);

        await dbRun(
            `UPDATE advancing_packs SET pdf_url = ?, status = 'sent',
                sent_to_client_at = CURRENT_TIMESTAMP, sent_to_venue_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [fileName, pack.id]
        );

        const updated = await dbGet("SELECT * FROM advancing_packs WHERE id = ?", [pack.id]);
        res.json({ success: true, pack: updated });
    } catch (e) {
        console.error('[Advancing] send failed:', e.message);
        res.status(500).json({ success: false, message: 'Could not send the advancing pack.' });
    }
});

router.post('/api/admin/bookings/:id/advancing/confirm', requireAdmin, async (req, res) => {
    try {
        const pack = await dbGet("SELECT id FROM advancing_packs WHERE booking_id = ?", [req.params.id]);
        if (!pack) return res.status(400).json({ success: false, message: 'No advancing pack to confirm yet.' });
        await dbRun("UPDATE advancing_packs SET status = 'confirmed', confirmed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [pack.id]);
        const updated = await dbGet("SELECT * FROM advancing_packs WHERE id = ?", [pack.id]);
        res.json({ success: true, pack: updated });
    } catch (e) {
        console.error('[Advancing] confirm failed:', e.message);
        res.status(500).json({ success: false, message: 'Could not confirm the advancing pack.' });
    }
});

module.exports = router;
