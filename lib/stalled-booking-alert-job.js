// Phase 5 (HOUSEKEEPING-NOTES.md): relocated from app.js verbatim, alongside its own startup/
// scheduling wiring — registerStalledBookingAlertJob() is called once from app.js at the same
// module-load-time position the inline setTimeout used to sit at.
const db = require('../database');
const emailComponents = require('../js/emailComponents');
const { sendEmail } = require('../js/emailService');
const { getNotificationEmail } = require('../database/repositories/settings.repository');

// S3: Stalled-booking admin alert — ACCEPTED with no invoice after 3 days
async function runStalledBookingAdminAlertJob() {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 3);
    const cutoffStr = cutoff.toISOString().split('T')[0];

    const stalled = await new Promise(resolve =>
        db.all(
            `SELECT b.id, b.name, b.email, b.event_name, b.event_type, b.date, b.accepted_at
             FROM bookings b
             LEFT JOIN invoices i ON i.booking_id = b.id AND UPPER(i.status) != 'VOID'
             WHERE b.status = 'ACCEPTED'
               AND DATE(b.accepted_at) <= ?
               AND i.id IS NULL`,
            [cutoffStr], (err, rows) => resolve(err ? [] : (rows || []))
        )
    );

    if (stalled.length === 0) return;

    const adminEmail = await getNotificationEmail();
    if (!adminEmail) return;

    const body = emailComponents.renderSystemEmail({
        preheaderText: `${stalled.length} ACCEPTED booking(s) missing an invoice.`,
        category: 'Payments & Invoices',
        severity: 'action',
        leadFact: `The following bookings have been in <strong style="color:#D4AF37;">ACCEPTED</strong> status for more than 3 days with no invoice generated.`,
        bodyHtml: `<p style="margin:0; color:#B0B0B0; font-size:12px;">Log in to the admin portal to generate invoices for these bookings.</p>`,
        cards: [{
            title: 'Stalled Bookings',
            rows: stalled.map(b => ({
                label: `#${b.id} — ${b.name}`,
                value: `${b.event_name || b.event_type} · Event: ${b.date} · Accepted: ${b.accepted_at ? b.accepted_at.slice(0, 10) : 'N/A'}`,
                mono: false
            }))
        }]
    });

    await sendEmail({
        to: adminEmail,
        subject: `Action Required: ${stalled.length} ACCEPTED booking(s) missing invoice`,
        htmlContent: body,
        preWrapped: true,
        titleOverride: 'Stalled Bookings Alert',
        trigger_event: 'Admin: Stalled Booking Alert'
    }).catch(e => console.error('[Stalled Booking Alert] Email failed:', e.message));

    console.log(`[Stalled Booking Alert] Notified admin of ${stalled.length} stalled booking(s).`);
}

function registerStalledBookingAlertJob() {
    setTimeout(() => {
        runStalledBookingAdminAlertJob().catch(e => console.error('[Stalled Booking Alert] Startup run failed:', e.message));
        setInterval(() => {
            runStalledBookingAdminAlertJob().catch(e => console.error('[Stalled Booking Alert] Scheduled run failed:', e.message));
        }, 24 * 60 * 60 * 1000);
    }, 30000);
}

module.exports = { runStalledBookingAdminAlertJob, registerStalledBookingAlertJob };
