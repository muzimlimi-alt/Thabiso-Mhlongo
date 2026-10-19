// Phase 5 (HOUSEKEEPING-NOTES.md): relocated from app.js verbatim. Shared by the admin invoice
// send/bulk-send routes (routes/admin/invoices.js) and the not-yet-moved booking-confirmation and
// quote-acceptance flows still in app.js.
const fs = require('fs');
const path = require('path');
const emailComponents = require('../js/emailComponents');
const bannerRegistry = require('../js/bannerRegistry');
const { sendEmail } = require('../js/emailService');
const { escapeEmailFields, escapeEmailHtml } = require('./email-escape');
const { dbGet } = require('./db-helpers');
const eftData = require('./eft');
const eftCore = require('./eft-core');
const { getEmailFooterContext, emailBaseUrl } = require('./email-context');
const objectStorage = require('./object-storage');
const { getPaymentSchedulesForDocument } = require('../database/repositories/finance.repository');

async function sendInvoiceEmail(booking, invoicePdfPath) {
    booking = escapeEmailFields(booking);
    const { id, name, email, event_name, event_type, date } = booking;

    let attachments = [];
    if (invoicePdfPath && await objectStorage.fileExists(invoicePdfPath)) {
        attachments.push({
            filename: `Invoice_${id}_Thabiso_Mhlongo.pdf`,
            content: await objectStorage.readFile(invoicePdfPath),
            contentType: 'application/pdf'
        });
    }

    const schedules = await getPaymentSchedulesForDocument(id);

    const scheduleTableRows = schedules.length > 0
        ? schedules.map(s => `
            <tr>
                <td style="padding:8px 12px;border-bottom:1px solid #333;color:#ccc;">${s.description}</td>
                <td style="padding:8px 12px;border-bottom:1px solid #333;color:#ccc;">${s.due_date}</td>
                <td style="padding:8px 12px;border-bottom:1px solid #333;color:#D4AF37;font-weight:600;">R ${parseFloat(s.expected_amount).toFixed(2)}</td>
            </tr>`).join('')
        : `<tr><td colspan="3" style="padding:8px 12px;color:#888;text-align:center;">Payment details are in the attached invoice PDF.</td></tr>`;

    const paymentScheduleHtml = `
        <div style="margin:20px 0;">
            <h3 style="color:#D4AF37;font-size:14px;letter-spacing:1px;text-transform:uppercase;margin-bottom:10px;">Payment Schedule</h3>
            <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:#111;border:1px solid #333;border-radius:4px;">
                <thead>
                    <tr style="background:#1a1a1a;">
                        <th style="padding:8px 12px;text-align:left;color:#D4AF37;font-size:11px;text-transform:uppercase;letter-spacing:1px;">Description</th>
                        <th style="padding:8px 12px;text-align:left;color:#D4AF37;font-size:11px;text-transform:uppercase;letter-spacing:1px;">Due Date</th>
                        <th style="padding:8px 12px;text-align:left;color:#D4AF37;font-size:11px;text-transform:uppercase;letter-spacing:1px;">Amount</th>
                    </tr>
                </thead>
                <tbody>${scheduleTableRows}</tbody>
            </table>
        </div>`;

    // Manual EFT: the banking details THIS invoice was issued with (invoices.bank_details_id - a snapshot, so changing the details later never
    // alters an invoice that already went out). An invoice issued while EFT was off carries none, and its e-mail reads exactly as before.
    let eftHtml = '';
    try {
        const inv = invoicePdfPath
            ? await dbGet('SELECT invoice_number, bank_details_id FROM invoices WHERE booking_id = ? AND file_path = ? ORDER BY id DESC LIMIT 1', [id, path.basename(invoicePdfPath)])
            : null;
        const bank = inv && inv.bank_details_id ? await eftData.getBankDetailsById(inv.bank_details_id) : null;
        if (bank) {
            const p = eftCore.printableBankDetails(bank, eftCore.paymentReference(id, inv.invoice_number));
            const row = (label, value, strong) => `<tr><td style="padding:6px 12px;border-bottom:1px solid #333;color:#999;font-size:12px;">${label}</td>` +
                `<td style="padding:6px 12px;border-bottom:1px solid #333;color:${strong ? '#D4AF37' : '#ECECEC'};font-weight:600;font-size:13px;">${escapeEmailHtml(value)}</td></tr>`;
            const note = [p.referenceNote, p.paymentInstructions].filter(Boolean).map(escapeEmailHtml).join('<br>');
            eftHtml = `
        <div style="margin:20px 0;">
            <h3 style="color:#D4AF37;font-size:14px;letter-spacing:1px;text-transform:uppercase;margin-bottom:10px;">Pay by EFT (Bank Transfer)</h3>
            <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:#111;border:1px solid #333;border-radius:4px;">
                <tbody>${row('Account holder', p.accountHolder)}${row('Bank', p.bankName)}${row('Account number', p.accountNumber)}${row('Account type', p.accountType)}${row('Branch code', p.branchCode)}${p.swiftCode ? row('SWIFT / BIC', p.swiftCode) : ''}${row('Invoice number', inv.invoice_number)}${row('Booking reference', '#' + id)}${row('Payment reference', p.reference, true)}</tbody>
            </table>
            ${note ? `<p style="margin:8px 0 0;color:#B0B0B0;font-size:12px;">${note}</p>` : ''}
            <p style="margin:8px 0 0;color:#B0B0B0;font-size:12px;">After you have paid, upload your proof of payment from your booking page. Payment is subject to verification and confirmation of cleared funds in our bank account.</p>
        </div>`;
        }
    } catch (eftErr) { console.error('[EFT] Could not add the banking details to the invoice e-mail:', eftErr.message); }

    // PAYMENT-CRITICAL: paymentScheduleHtml (amounts/due dates) kept verbatim; PDF + reference unchanged.
    const { socialLinks } = await getEmailFooterContext();
    const banner = await bannerRegistry.resolveBanner('invoice');
    const html = emailComponents.renderPremiumEmail({
        preheaderText: `Your invoice for booking #${id} is attached.`,
        bannerSrc: banner?.src, bannerAlt: banner?.alt, subtitle: banner?.subtitle,
        headline: banner?.headline || 'Your Invoice',
        greeting: `Hi ${name},`,
        bodyHtml:
            `Your formal invoice is ready for <strong style="color:#FAFAFA;">${event_name || event_type}</strong> on <strong style="color:#FAFAFA;">${date}</strong>. Please find the attached PDF for the full service breakdown.` +
            paymentScheduleHtml +
            eftHtml +
            `<p style="margin:12px 0 0;"><strong style="color:#D4AF37;">Terms &amp; Policies:</strong><br>${booking.terms || 'Standard cancellation policy applies.'}</p>` +
            (eftHtml
                ? `<p style="margin:10px 0 0; color:#E6E6E6;">Payment can be made via the secure link sent in our previous communications or by EFT using the banking details above.</p>`
                : `<p style="margin:10px 0 0; color:#E6E6E6;">Payment can be made via the secure link sent in our previous communications or via bank transfer using the details in the invoice.</p>`) +
            `<p style="margin:10px 0 0; color:#B0B0B0; font-size:13px;">Invoice Reference: <strong style="color:#D4AF37;">#${id}</strong></p>`,
        cta: { label: 'View Your Booking', url: `${emailBaseUrl()}/?track=${id}&email=${encodeURIComponent(email)}` },
        socialLinks
    });

    const result = await sendEmail({
        to: email,
        subject: `Invoice for Booking #${id}`,
        htmlContent: html,
        preWrapped: true,
        attachments: attachments,
        titleOverride: 'Your Invoice',
        trigger_event: 'Booking: Invoice Generated'
    });

    return result.success;
}

module.exports = { sendInvoiceEmail };
