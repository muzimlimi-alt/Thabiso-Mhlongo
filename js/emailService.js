/**
 * Thabiso Mhlongo — Unified Email Sending Service v1.0
 * Implementation of Phased Overhaul Phase 3.
 */

const nodemailer = require('nodemailer');
const emailTemplates = require('./emailTemplates');
const emailAssets = require('./emailAssets');
const db = require('../database');
require('dotenv').config();

// Create a reusable transporter
// Moved from server.js to maintain a single instance while supporting new service logic
// Create a reusable transporter
// Moved from server.js to maintain a single instance while supporting new service logic
let transporter;
if (process.env.SMTP_MOCK === 'true') {
    console.log('⚠️ [EMAIL SERVICE] SMTP Mocking Enabled. No real emails will be sent.');
    transporter = {
        sendMail: async (options) => {
            // Simulate 50ms network delay
            await new Promise(r => setTimeout(r, 50));
            return { messageId: 'mock-id-' + Date.now(), response: '250 OK' };
        }
    };
} else {
    transporter = nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 587,
        secure: false, 
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS
        },
        connectionTimeout: 30000, // 30 seconds
        greetingTimeout: 30000, // 30 seconds
        socketTimeout: 45000, // 45 seconds
        tls: {
            rejectUnauthorized: false
        }
    });
}

/**
 * Strips HTML tags and normalizes whitespace for text-only fallback.
 */
function htmlToPlainText(html) {
    if (!html) return '';
    return html
        .replace(/<style[^>]*>.*<\/style>/gms, '') // Remove styles
        .replace(/<[^>]+>/g, ' ')                  // Strip tags
        .replace(/\s\s+/g, ' ')                    // Normalize spaces
        .trim();
}

/**
 * Detects base64 inline images, converts them to buffer attachments with CIDs,
 * and updates the img src attributes.
 */
function extractInlineImages(htmlContent) {
    const inlineAttachments = [];
    if (!htmlContent) return { html: '', attachments: [] };

    let imageCounter = 0;
    // Regex matches <img src="data:image/[a-zA-Z0-9.-+];base64,[^"']+" ...> case-insensitively
    const updatedHtml = htmlContent.replace(/<img([^>]+)src=["'](data:image\/([a-zA-Z0-9\+\-\.]+);base64,([^"'>]+))["']([^>]*)/gi, (match, beforeSrc, fullUri, mimeType, base64Data, afterSrc) => {
        imageCounter++;
        const cid = `inlineImage_${imageCounter}_${Date.now()}`;
        const buffer = Buffer.from(base64Data, 'base64');
        const extension = mimeType === 'svg+xml' ? 'svg' : mimeType;

        inlineAttachments.push({
            filename: `inline_image_${imageCounter}.${extension}`,
            content: buffer,
            cid: cid
        });

        // Reconstruct img tag with cid reference
        return `<img${beforeSrc}src="cid:${cid}"${afterSrc}`;
    });

    return {
        html: updatedHtml,
        attachments: inlineAttachments
    };
}

/**
 * Unified async function to send emails with professional branding and logging.
 */
async function sendEmail({ 
    to, 
    subject, 
    htmlContent, 
    plainTextAlternative = null, 
    attachments = [], 
    fromName = "Thabiso Mhlongo Management", 
    replyTo = null,
    skipBrandAttachments = false,
    titleOverride = null,
    trigger_event = 'System Communication'
}) {
    const isOverhaulEnabled = process.env.EMAIL_OVERHAUL_ENABLED === 'true';

    // 1. Fallback Logic (Feature Flag Restricted)
    if (!isOverhaulEnabled) {
        try {
            const processedContent = extractInlineImages(htmlContent);
            const mailOptions = {
                from: `${fromName} <${process.env.EMAIL_USER}>`,
                to,
                subject,
                html: processedContent.html
            };
            if (replyTo) mailOptions.replyTo = replyTo;
            const merged = [...processedContent.attachments, ...attachments];
            if (merged.length > 0) mailOptions.attachments = merged;

            const res = await transporter.sendMail(mailOptions);
            return { success: true, messageId: res.messageId };
        } catch (error) {
            console.error('❌ Legacy Email Fallback Failed:', error);
            return { success: false, error };
        }
    }

    // 2. New Branded Logic
    try {
        // Extract inline base64 images from htmlContent
        const processedContent = extractInlineImages(htmlContent);
        const emailBody = processedContent.html;
        const inlineAttachments = processedContent.attachments;

        // Fetch Unsubscribe Token if applicable
        let unsubscribeUrl = null;
        console.log(`[DEBUG] Checking unsubscribe token for ${to}...`);
        const subRow = await new Promise((resolve) => {
            db.get("SELECT unsubscribe_token FROM newsletter_subscribers WHERE LOWER(email) = LOWER(?)", [to], (err, row) => {
                console.log(`[DEBUG] Token check error:`, err);
                resolve(row);
            });
        });
        console.log(`[DEBUG] subRow:`, subRow);
        
        if (subRow && subRow.unsubscribe_token) {
            const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
            unsubscribeUrl = `${baseUrl}/unsubscribe.html?token=${subRow.unsubscribe_token}&email=${encodeURIComponent(to)}`;
        }

        // Fetch social links for footer
        const socialLinks = await new Promise((resolve) => {
            db.all(
                "SELECT platform_name, platform_url FROM social_links WHERE is_active = 1 ORDER BY display_order ASC",
                [],
                (err, rows) => resolve(err ? [] : (rows || []))
            );
        });

        // Prepare brand assets
        const brandAttachments = skipBrandAttachments ? [] : emailAssets.getBrandAttachments();
        const mergedAttachments = [...brandAttachments, ...inlineAttachments, ...attachments];

        // Format HTML with brand wrapper (pass dynamic unsubscribe link and social links)
        const hasBanner = brandAttachments.some(a => a.cid === 'thabisoBanner');
        const bannerSrc = hasBanner ? 'cid:thabisoBanner' : (process.env.EMAIL_BANNER || null);
        const finalHtml = emailTemplates.createEmailWrapper(emailBody, titleOverride || subject, unsubscribeUrl, bannerSrc, socialLinks);
        
        // Generate plain-text if not provided
        const finalPlainText = plainTextAlternative || htmlToPlainText(emailBody);

        const mailOptions = {
            from: `"${fromName}" <${process.env.EMAIL_USER}>`,
            to,
            subject,
            html: finalHtml,
            text: finalPlainText,
            attachments: mergedAttachments
        };

        if (replyTo) mailOptions.replyTo = replyTo;

        console.log(`[DEBUG] Sending email to ${to}...`);
        
        // --- ASYNC LOGGING (Don't wait for DB insert to start SMTP) ---
        let logId = null;
        db.run("INSERT INTO email_logs (recipient_email, subject, trigger_event, status) VALUES (?, ?, ?, ?)", 
            [to, subject, trigger_event, 'pending'], function(err) {
                if (!err) logId = this.lastID;
            }
        );

        const info = await transporter.sendMail(mailOptions);
        console.log(`[DEBUG] Email sent:`, info.messageId);
        
        // Update Log to Success
        if (logId) {
            db.run("UPDATE email_logs SET status = 'success' WHERE id = ?", [logId]);
        } else {
            // Fallback if logId wasn't ready (race condition)
            db.run("INSERT INTO email_logs (recipient_email, subject, trigger_event, status) VALUES (?, ?, ?, ?)", 
                [to, subject, trigger_event, 'success']);
        }

        return { success: true, messageId: info.messageId };
    } catch (error) {
        console.error('❌ Premium Email Service Failed:', error);
        
        // Log Failure to DB
        db.run("INSERT INTO email_logs (recipient_email, subject, trigger_event, status, error_message) VALUES (?, ?, ?, ?, ?)", 
            [to, subject, trigger_event, 'failed', error.message]
        );

        return { success: false, error: error.message };
    }
}

module.exports = {
    transporter,
    sendEmail,
    htmlToPlainText,
    extractInlineImages
};
