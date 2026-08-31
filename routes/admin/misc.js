const express = require('express');
const fs = require('fs');
const db = require('../../database');
const { requireAdmin } = require('../../middleware/auth');
const { requireRole } = require('../../middleware/rbac');
const { resolveDocsPath } = require('../../lib/runtime-paths');
const { getEmailFooterContext } = require('../../lib/email-context');
const bannerRegistry = require('../../js/bannerRegistry');
const emailComponents = require('../../js/emailComponents');
const { sendEmail } = require('../../js/emailService');
const { getNotificationEmail } = require('../../database/repositories/settings.repository');
const { getAllBookingsFull, updateBookingClientVenue } = require('../../database/repositories/bookings.repository');
const router = express.Router();

// GET Email Logs (Advanced: Sorting, Filtering, Searching, Pagination)
router.get('/api/admin/email-logs', requireAdmin, (req, res) => {
    const { 
        page = 1, 
        limit = 20, 
        search = '', 
        status = '', 
        trigger = '', 
        sort = 'sent_at', 
        order = 'DESC' 
    } = req.query;

    const offset = (page - 1) * limit;
    let whereClauses = [];
    let params = [];

    if (search) {
        whereClauses.push("(recipient_email LIKE ? OR subject LIKE ? OR trigger_event LIKE ?)");
        params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (status) {
        whereClauses.push("status = ?");
        params.push(status);
    }
    if (trigger) {
        whereClauses.push("trigger_event = ?");
        params.push(trigger);
    }

    const whereString = whereClauses.length > 0 ? "WHERE " + whereClauses.join(" AND ") : "";
    const allowedSortCols = ['sent_at', 'recipient_email', 'subject', 'status', 'trigger_event'];
    const safeSort = allowedSortCols.includes(sort) ? sort : 'sent_at';
    const safeOrder = order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const countQuery = `SELECT COUNT(*) as total FROM email_logs ${whereString}`;
    const dataQuery = `SELECT * FROM email_logs ${whereString} ORDER BY ${safeSort} ${safeOrder} LIMIT ? OFFSET ?`;
    
    const queryParams = [...params, parseInt(limit), parseInt(offset)];

    db.get(countQuery, params, (countErr, countRow) => {
        if (countErr) return res.status(500).json({ success: false, error: countErr.message });
        
        db.all(dataQuery, queryParams, (err, rows) => {
            if (err) return res.status(500).json({ success: false, error: err.message });
            
            // Defensive: Check both 'total' alias and default 'COUNT(*)' column names
            const rawTotal = countRow ? (countRow.total !== undefined ? countRow.total : countRow['COUNT(*)']) : 0;
            const total = parseInt(rawTotal) || 0;
            res.json({ 
                success: true, 
                logs: rows,
                total: total,
                page: parseInt(page),
                totalPages: Math.ceil(total / parseInt(limit))
            });
        });
    });
});

router.post('/api/admin/settings/test-notification', requireAdmin, requireRole(['administrator']), async (req, res) => {
    try {
        const to = await getNotificationEmail();
        await sendEmail({
            to,
            subject: 'Test Notification — Thabiso Mhlongo Admin',
            htmlContent: emailComponents.renderSystemEmail({
                preheaderText: `Test notification — confirming admin routing to ${to}.`,
                category: 'System',
                severity: 'info',
                leadFact: `This is a test email confirming that admin notifications are correctly routed to <strong style="color:#FAFAFA;">${to}</strong>.`,
                timestamp: new Date().toISOString()
            }),
            preWrapped: true,
            trigger_event: 'Admin: Test Notification'
        });
        res.json({ success: true, message: `Test email sent to ${to}` });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// P3-12: Client duplicate detection — finds clients with the same phone number
// or very similar name (within 2-char edit distance) but different emails.
router.get('/api/admin/clients/duplicates', requireAdmin, (req, res) => {
    // Phone-based duplicates: same non-null phone, different email
    db.all(
        `SELECT a.id AS id_a, a.full_name AS name_a, a.email AS email_a, a.phone AS phone,
                b.id AS id_b, b.full_name AS name_b, b.email AS email_b,
                'phone' AS match_type
         FROM clients a
         JOIN clients b ON a.phone = b.phone
           AND a.id < b.id
           AND LOWER(a.email) != LOWER(b.email)
           AND a.phone IS NOT NULL AND a.phone != ''
         ORDER BY a.phone`,
        [],
        (pErr, phoneRows) => {
            if (pErr) return res.status(500).json({ success: false, error: pErr.message });
            // Name-based duplicates: same name (case-insensitive), different email
            db.all(
                `SELECT a.id AS id_a, a.full_name AS name_a, a.email AS email_a, a.phone AS phone_a,
                        b.id AS id_b, b.full_name AS name_b, b.email AS email_b, b.phone AS phone_b,
                        'name' AS match_type
                 FROM clients a
                 JOIN clients b ON LOWER(TRIM(a.full_name)) = LOWER(TRIM(b.full_name))
                   AND a.id < b.id
                   AND LOWER(a.email) != LOWER(b.email)
                 ORDER BY a.full_name`,
                [],
                (nErr, nameRows) => {
                    if (nErr) return res.status(500).json({ success: false, error: nErr.message });
                    const all = [...(phoneRows || []), ...(nameRows || [])];
                    res.json({ success: true, count: all.length, duplicates: all });
                }
            );
        }
    );
});

// Admin: serve a booking attachment file
router.get('/api/admin/booking-attachments/:filename', requireAdmin, (req, res) => {
    const filePath = resolveDocsPath('booking_attachments', req.params.filename);
    if (!fs.existsSync(filePath)) return res.status(404).send('File not found.');
    res.sendFile(filePath);
});

// Admin: approve or delete a review
router.patch('/api/admin/reviews/:id', requireAdmin, (req, res) => {
    const { is_approved } = req.body;
    db.run("UPDATE service_reviews SET is_approved = ? WHERE id = ?", [is_approved ? 1 : 0, req.params.id],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        }
    );
});

// GET — bookings whose ACTIVE schedule total diverges from the booking total (reconciliation sweep)
router.get('/api/admin/payment-schedules/mismatches', requireAdmin, requireRole(['administrator', 'manager']), (req, res) => {
    db.all(
        `SELECT b.id, b.name, b.event_name, b.event_type, b.date, b.status, b.total_amount,
                (SELECT COALESCE(SUM(expected_amount),0) FROM payment_schedules ps
                 WHERE ps.booking_id=b.id AND LOWER(COALESCE(ps.status,'pending')) NOT IN ('superseded','cancelled')) AS scheduled_total
         FROM bookings b
         WHERE b.status NOT IN ('CANCELLED')
           AND b.total_amount > 0
           AND EXISTS (SELECT 1 FROM payment_schedules ps2 WHERE ps2.booking_id=b.id AND LOWER(COALESCE(ps2.status,'pending')) NOT IN ('superseded','cancelled'))`,
        [], (err, rows) => {
            if (err) return res.status(500).json({ success: false, message: err.message });
            const mismatches = (rows || [])
                .map(r => {
                    const total_amount = parseFloat(r.total_amount) || 0;
                    const scheduled_total = parseFloat(r.scheduled_total) || 0;
                    return { ...r, total_amount, scheduled_total, diff: Math.round((scheduled_total - total_amount) * 100) / 100 };
                })
                .filter(r => Math.abs(r.diff) > 0.01)
                .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
            res.json({ success: true, mismatches, count: mismatches.length });
        }
    );
});

// Note: the legacy POST /:id/reply endpoint was removed — no longer called by any client code,
// superseded by the direct_emails composer (POST/PUT /api/admin/direct-emails, POST /:id/send).

// --- Admin Compose (freeform outbound email) ---
router.post('/api/admin/compose', requireAdmin, async (req, res) => {
    const { to, subject, body } = req.body;
    if (!to || !body) return res.status(400).json({ error: 'Recipient and message body are required.' });

    // Bug fixed in passing: htmlTemplate was built here but never used — the send below passed the
    // raw body, so composed messages went out with NO wrapper/logo/shell at all.
    const { socialLinks } = await getEmailFooterContext();
    const composeBanner = await bannerRegistry.resolveBanner('direct_compose');
    const htmlTemplate = emailComponents.renderPremiumEmail({
        preheaderText: subject || 'A message from Thabiso Mhlongo Management.',
        bannerSrc: composeBanner?.src, bannerAlt: composeBanner?.alt, subtitle: composeBanner?.subtitle,
        headline: composeBanner?.headline || 'Direct Message',
        bodyHtml: body.replace(/\n/g, '<br>'),
        socialLinks
    });

    try {
        await sendEmail({
            to: to,
            subject: subject || 'Message from Thabiso Mhlongo Management',
            htmlContent: htmlTemplate,
            preWrapped: true,
            replyTo: process.env.EMAIL_USER || 'admin@thabisomhlongo.com',
            titleOverride: 'Direct Message',
            trigger_event: 'Admin: Direct Compose'
        });
        res.json({ success: true, message: 'Message sent successfully.' });
    } catch (error) {
        console.error("Error sending composed email:", error);
        res.status(500).json({ error: error.message });
    }
});

// Phase 5 (HOUSEKEEPING-NOTES.md): SITE_CONTENT_KEYS moved into routes/public/site-content.js as a
// single-consumer local alongside GET /api/public/site-content.







// Phase 5 (HOUSEKEEPING-NOTES.md): legacy admin route POST /api/admin/gdpr/delete moved to
// routes/admin/popia.js (batch 14) — it's a one-click wrapper around createPopiaRequest/
// approvePopiaRequest/processPopiaRequest/notifyPopiaCancellations/deletePopiaFiles, all of which
// live there now alongside the rest of the POPIA admin surface.









// --- Migration & System ---
/**
 * Admin-Only: Data Migration Tool (Legacy Bookings -> New Relational Schema)
 * This tool scans existing flat 'bookings' records and creates unique 'clients' and 'venues' 
 * entries, then updates the booking record with foreign key references.
 */
router.post('/api/admin/system/migrate-legacy-data', requireAdmin, requireRole(['administrator']), async (req, res) => {
    getAllBookingsFull(async (err, bookings) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        
        let stats = { processed: 0, clientsCreated: 0, venuesCreated: 0, updated: 0 };
        
        for (const booking of bookings) {
            stats.processed++;
            
            // 1. Resolve Client
            let clientId = await new Promise((resolve) => {
                db.get("SELECT id FROM clients WHERE LOWER(email) = LOWER(?)", [booking.email], (e, row) => resolve(row ? row.id : null));
            });
            
            if (!clientId) {
                clientId = await new Promise((resolve) => {
                    db.run("INSERT INTO clients (full_name, company_name, email, phone) VALUES (?, ?, ?, ?)",
                        [booking.name, booking.company, booking.email, booking.cell],
                        function() { resolve(this.lastID); }
                    );
                });
                stats.clientsCreated++;
            }
            
            // 2. Resolve Venue
            let venueId = null;
            if (booking.event_location || booking.venue_address) {
                const venueName = booking.event_location || 'Unknown Venue';
                venueId = await new Promise((resolve) => {
                    db.get("SELECT id FROM venues WHERE LOWER(name) = LOWER(?)", [venueName], (e, row) => resolve(row ? row.id : null));
                });
                
                if (!venueId) {
                    venueId = await new Promise((resolve) => {
                        db.run("INSERT INTO venues (name, address, city, country, capacity) VALUES (?, ?, ?, ?, ?)",
                            [venueName, booking.venue_address, booking.city, booking.country, booking.audience_size],
                            function() { resolve(this.lastID); }
                        );
                    });
                    stats.venuesCreated++;
                }
            }
            
            // 3. Update Booking with Foreign Keys
            await new Promise((resolve) => {
                updateBookingClientVenue(clientId, venueId, booking.id, () => resolve());
            });
            stats.updated++;
        }
        
        res.json({ success: true, message: 'Migration completed successfully.', stats });
    });
});

// Dynamic admin backgrounds debug logger
router.post('/api/debug', requireAdmin, (req, res) => {
    // SEC-2: gated behind admin auth — it was an open endpoint that logged arbitrary request bodies.
    console.log('[DEBUG API] Background configuration trace:', req.body);
    return res.status(200).json({ success: true });
});

module.exports = router;
