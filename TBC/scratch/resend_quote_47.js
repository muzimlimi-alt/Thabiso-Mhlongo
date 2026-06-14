const sqlite = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const emailService = require('../js/emailService');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '../.env') });

const db = new sqlite.Database(path.join(__dirname, '../database.sqlite'));

db.get("SELECT * FROM bookings WHERE id = 47", (err, booking) => {
    if (err) {
        console.error("Booking Error:", err);
        return;
    }
    if (!booking) {
        console.log("Booking #47 not found.");
        return;
    }
    
    db.get("SELECT * FROM quotations WHERE booking_id = 47 ORDER BY id DESC LIMIT 1", (err, quote) => {
        if (err) {
            console.error("Quotation Error:", err);
            return;
        }
        if (!quote) {
            console.log("No quotation found for booking #47.");
            return;
        }
        
        console.log("Found Quotation:", quote.quote_number);
        
        const details = JSON.parse(booking.quote_details);
        const items = details.items || [];
        const pdfPath = path.join(__dirname, '../docs/quotes', quote.file_path);
        
        console.log("Checking PDF path:", pdfPath);
        if (!fs.existsSync(pdfPath)) {
            console.error("PDF file does not exist at path:", pdfPath);
            return;
        }
        
        console.log("Attempting to resend quote email...");
        
        // We replicate the logic of sendQuoteEmail here or try to call it if we could import it.
        // Since we can't easily import from server.js, we use emailService.sendEmail directly!
        
        let attachments = [{
            filename: quote.file_path,
            path: pdfPath,
            contentType: 'application/pdf'
        }];
        
        let itemsHtml = '';
        if (items && items.length > 0) {
            itemsHtml = '<div style="margin: 20px 0; padding: 15px; background: #111; border-radius: 4px;">';
            itemsHtml += '<h3 style="margin-top:0; font-size:14px; color:#D4AF37;">Service Breakdown:</h3>';
            itemsHtml += '<table style="width:100%; font-size:13px; color:#ccc;">';
            items.forEach(it => {
                const qty = parseFloat(it.quantity_minutes) || parseFloat(it.quantity) || 0;
                const p = parseFloat(it.unit_price) || 0;
                const total = (qty === 0) ? p : (qty * p); // Simplified
                const desc = it.description || 'Service';
                
                itemsHtml += `<tr>
                    <td style="padding:4px 0;">${desc}</td>
                    <td style="padding:4px 0; text-align:right;">${qty > 0 ? `${qty} min × R ${p.toFixed(2)}` : 'Flat Fee'}</td>
                    <td style="padding:4px 0; text-align:right; color:#fff;">R ${total.toFixed(2)}</td>
                </tr>`;
            });
            itemsHtml += '</table></div>';
        }
        
        const emailBody = `
            <p>Hi <strong>${booking.name}</strong>,</p>
            <p>We've prepared a formal quotation for your upcoming event: <strong style="color:#ffffff;">${booking.event_name || booking.event_type}</strong> on <strong style="color:#ffffff;">${booking.date}</strong>.</p>
            <p>Please find the attached PDF for the full breakdown of services and terms.</p>
            <p><strong>Terms & Policies:</strong><br/>
            ${booking.terms || 'Standard cancellation policy applies.'}</p>
            ${itemsHtml}
            <p><strong style="color:#ffffff;">Total Quote: ${booking.quote_amount}</strong></p>
            <p>To secure this date, please review and accept the quotation via your tracking portal, or reply directly to this email within 14 days.</p>
            <p style="margin: 20px 0;">
                <a href="https://www.thabisomhlongo.com/?track=${booking.id}&email=${encodeURIComponent(booking.email)}" style="display:inline-block; padding:12px 24px; background:#D4AF37; color:#000; text-decoration:none; font-weight:bold; border-radius:4px;">Access Tracking Portal</a>
            </p>
            <p class="text-gold">Booking Reference: <strong>#${booking.id}</strong></p>
        `;
        
        emailService.sendEmail({
            to: booking.email,
            subject: `Quotation for Booking #${booking.id} (Resend)`,
            htmlContent: emailBody,
            attachments: attachments,
            titleOverride: 'Your Quotation',
            trigger_event: 'Booking: Quote Resend'
        }).then(result => {
            console.log("Email Result:", result);
            db.close();
        }).catch(err => {
            console.error("Email Error:", err);
            db.close();
        });
    });
});
