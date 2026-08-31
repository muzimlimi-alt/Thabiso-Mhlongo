// Phase 5 (HOUSEKEEPING-NOTES.md): relocated from app.js verbatim. Shared by the admin
// POST /api/admin/reminders/run route (routes/admin/reminders.js) and app.js's own startup/daily
// scheduling of the same job.
const db = require('../database');
const emailComponents = require('../js/emailComponents');
const bannerRegistry = require('../js/bannerRegistry');
const { sendEmail } = require('../js/emailService');
const { getEmailFooterContext } = require('./email-context');

async function runPaymentReminderJob() {
    const result = { sent: 0, skipped: 0, errors: 0 };

    const policyRow1 = await new Promise(resolve => db.get("SELECT policy_value FROM policies WHERE policy_key = 'reminder_days_1'", [], (err, row) => resolve(row)));
    const policyRow2 = await new Promise(resolve => db.get("SELECT policy_value FROM policies WHERE policy_key = 'reminder_days_2'", [], (err, row) => resolve(row)));
    const days1 = parseInt((policyRow1 && policyRow1.policy_value) || '7');
    const days2 = parseInt((policyRow2 && policyRow2.policy_value) || '2');

    const windows = [days1, days2].filter((d, i, a) => d > 0 && a.indexOf(d) === i);

    for (const daysBefore of windows) {
        const targetDate = new Date();
        targetDate.setDate(targetDate.getDate() + daysBefore);
        const targetStr = targetDate.toISOString().split('T')[0];

        const dueSched = await new Promise((resolve, reject) => {
            db.all(`
                SELECT ps.id AS schedule_id, ps.booking_id, ps.description, ps.due_date,
                       ps.expected_amount, ps.status,
                       b.name AS client_name, b.email AS client_email, b.event_name
                FROM payment_schedules ps
                JOIN bookings b ON b.id = ps.booking_id
                WHERE ps.due_date = ? AND ps.status = 'pending'
                  AND b.status NOT IN ('CANCELLED')
            `, [targetStr], (err, rows) => {
                if (err) reject(err); else resolve(rows || []);
            });
        });

        for (const sched of dueSched) {
            const alreadySent = await new Promise(resolve => {
                db.get("SELECT id FROM reminders_log WHERE booking_id = ? AND schedule_id = ? AND days_before = ?",
                    [sched.booking_id, sched.schedule_id, daysBefore], (err, row) => resolve(!!row));
            });
            if (alreadySent) { result.skipped++; continue; }

            const paymentUrl = `${process.env.SITE_URL || 'http://localhost:3000'}/?track=${sched.booking_id}&email=${encodeURIComponent(sched.client_email)}`;
            // PAYMENT-CRITICAL: `R ${parseFloat(sched.expected_amount).toFixed(2)}` kept verbatim.
            const { socialLinks: schedSocialLinks } = await getEmailFooterContext();
            const banner = await bannerRegistry.resolveBanner('schedule_payment_reminder');
            const htmlContent = emailComponents.renderPremiumEmail({
                preheaderText: `Payment reminder: ${sched.description} due ${sched.due_date}.`,
                bannerSrc: banner?.src, bannerAlt: banner?.alt, subtitle: banner?.subtitle,
                headline: banner?.headline || 'Payment Reminder',
                greeting: `Hi ${sched.client_name},`,
                bodyHtml: `This is a friendly reminder that a payment is due in <strong style="color:#D4AF37;">${daysBefore} day${daysBefore !== 1 ? 's' : ''}</strong> for your upcoming event booking.`,
                cards: [{
                    title: 'Payment Details',
                    rows: [
                        { label: 'Booking', value: sched.event_name || ('Booking #' + sched.booking_id), mono: false },
                        { label: 'Description', value: sched.description, mono: false },
                        { label: 'Due Date', value: sched.due_date },
                        { label: 'Amount', value: `R ${parseFloat(sched.expected_amount).toFixed(2)}`, highlight: true }
                    ]
                }],
                cta: { label: 'Make Payment Now', url: paymentUrl },
                socialLinks: schedSocialLinks
            });

            try {
                await sendEmail({
                    to: sched.client_email,
                    subject: `Payment Reminder — ${sched.description} due ${sched.due_date}`,
                    htmlContent,
                    preWrapped: true,
                    titleOverride: 'Payment Reminder',
                    trigger_event: 'Payment Reminder'
                });
                db.run("INSERT OR IGNORE INTO reminders_log (booking_id, schedule_id, days_before, due_date, amount_due, recipient_email, status) VALUES (?,?,?,?,?,?,'sent')",
                    [sched.booking_id, sched.schedule_id, daysBefore, sched.due_date, sched.expected_amount, sched.client_email]);
                result.sent++;
            } catch (emailErr) {
                console.error(`[Reminder Job] Failed to send reminder for schedule ${sched.schedule_id}:`, emailErr.message);
                db.run("INSERT OR IGNORE INTO reminders_log (booking_id, schedule_id, days_before, due_date, amount_due, recipient_email, status, error_message) VALUES (?,?,?,?,?,?,'failed',?)",
                    [sched.booking_id, sched.schedule_id, daysBefore, sched.due_date, sched.expected_amount, sched.client_email, emailErr.message]);
                result.errors++;
            }
        }
    }

    console.log(`[Reminder Job] Done — sent: ${result.sent}, skipped: ${result.skipped}, errors: ${result.errors}`);
    return result;
}

// Phase 5 (HOUSEKEEPING-NOTES.md): the setTimeout/setInterval startup wiring that used to sit
// inline in app.js right after this module's re-import, wrapped here to match every other
// scheduled job's registerXJob() convention. Run reminder job daily at 09:00 local time
// (simplified: every 24h after first run at startup + 10s) — unchanged from the original.
function registerPaymentReminderJob() {
    setTimeout(() => {
        runPaymentReminderJob().catch(err => console.error('[Reminder Job] Startup run failed:', err.message));
        setInterval(() => {
            runPaymentReminderJob().catch(err => console.error('[Reminder Job] Scheduled run failed:', err.message));
        }, 24 * 60 * 60 * 1000);
    }, 10000);
}

module.exports = { runPaymentReminderJob, registerPaymentReminderJob };
