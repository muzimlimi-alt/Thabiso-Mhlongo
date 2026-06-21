/**
 * Thabiso Mhlongo — Premium Email Template Engine v1.0
 * Centralized logic for 'Obsidian & Gold' branded emails.
 */

const fs = require('fs');
const path = require('path');

/**
 * Generates the base shell for all outgoing emails.
 */
function createEmailWrapper(content, title = "Thabiso Mhlongo Official Notification", unsubscribeUrl = null, bannerSrc = null, socialLinks = []) {
    const getIconName = (platform) => {
        const name = (platform || '').toLowerCase().trim();
        if (name.includes('instagram')) return 'instagram';
        if (name.includes('facebook')) return 'facebook';
        if (name.includes('linkedin')) return 'linkedin';
        if (name.includes('tiktok')) return 'tiktok';
        if (name.includes('whatsapp')) return 'whatsapp';
        if (name.includes('youtube')) return 'youtube';
        if (name.includes('twitter') || name === 'x') return 'x';
        return 'link';
    };

    const socialLinksHtml = socialLinks.length > 0
        ? socialLinks.map(link => {
            const iconName = getIconName(link.platform_name);
            return `<a href="${link.platform_url}" target="_blank" rel="noopener noreferrer" style="display: inline-block; margin: 0 8px; text-decoration: none; vertical-align: middle;" title="${link.platform_name}"><img src="https://img.icons8.com/ios-filled/40/D4AF37/${iconName}.png" alt="${link.platform_name}" width="24" height="24" style="display: block; width: 24px; height: 24px; border: 0;" /></a>`;
        }).join('')
        : `<a href="#" style="display: inline-block; margin: 0 8px; text-decoration: none; vertical-align: middle;" title="Instagram">
                <img src="https://img.icons8.com/ios-filled/40/D4AF37/instagram.png" alt="Instagram" width="24" height="24" style="display: block; width: 24px; height: 24px; border: 0;" />
            </a>
            <a href="#" style="display: inline-block; margin: 0 8px; text-decoration: none; vertical-align: middle;" title="Twitter">
                <img src="https://img.icons8.com/ios-filled/40/D4AF37/x.png" alt="Twitter" width="24" height="24" style="display: block; width: 24px; height: 24px; border: 0;" />
            </a>
            <a href="#" style="display: inline-block; margin: 0 8px; text-decoration: none; vertical-align: middle;" title="Facebook">
                <img src="https://img.icons8.com/ios-filled/40/D4AF37/facebook.png" alt="Facebook" width="24" height="24" style="display: block; width: 24px; height: 24px; border: 0;" />
            </a>`;
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600&display=swap');
        
        body, html { margin: 0; padding: 0; min-width: 100%; width: 100% !important; background-color: #0d0d0d; }
        * { box-sizing: border-box; }
        
        .email-container {
            max-width: 650px;
            margin: 40px auto;
            background-color: #0a0a0a;
            border: 1px solid rgba(255,255,255,0.12);
            font-family: 'Outfit', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
            overflow: hidden;
        }
        
        .email-header {
            padding: 40px 30px 30px;
            text-align: center;
        }
        
        .email-body {
            padding: 0 40px 40px;
            color: #e8e8e8;
            line-height: 1.6;
            font-size: 16px;
        }
        
        .email-footer {
            padding: 30px;
            background-color: #111111;
            text-align: center;
            border-top: 1px solid rgba(255,255,255,0.08);
        }
        
        h1, h2, h3 { 
            color: #D4AF37; 
            font-family: Georgia, 'Times New Roman', serif; /* Cormorant Garamond fallback */
            font-weight: 400; 
            letter-spacing: 1px;
            margin-top: 0;
        }
        
        .gold-divider {
            height: 2px;
            background-color: #D4AF37;
            width: 100%;
            margin: 0 0 30px 0;
            border: none;
        }
        
        .btn-luxe {
            display: inline-block;
            background-color: #D4AF37;
            color: #0a0a0a !important;
            padding: 16px 35px;
            text-decoration: none;
            font-weight: 700;
            font-size: 15px;
            text-transform: uppercase;
            letter-spacing: 1px;
            border-radius: 2px;
            margin: 20px 0;
        }
        
        .text-muted { color: #b0b0b0; }
        .text-gold { color: #D4AF37; }
        
        @media screen and (max-width: 600px) {
            .email-container { margin: 0 auto; width: 100% !important; border: none; }
            .email-body { padding: 0 25px 30px; }
        }
    </style>
</head>
<body>
    <div class="email-container">
        <div class="email-header" style="padding: 0;">
            ${bannerSrc ? `<img src="${bannerSrc}" alt="Thabiso Mhlongo" style="max-width: 100%; height: auto; display: block; margin: 0 auto;" />` : ''}
        </div>
        
        <div class="email-body">
            <div class="gold-divider" style="margin-top: 30px;"></div>
            ${title ? `<h1 style="font-size: 24px; text-align: center; margin-bottom: 30px;">${title}</h1>` : ''}
            ${content}
        </div>
        
        <div class="email-footer">
            <p style="font-size: 13px; color: #b0b0b0; margin-bottom: 20px;">
                <strong>Thabiso Mhlongo Management</strong><br>
                <em>Officially funny since 2014</em>
            </p>
            
            <div style="margin-bottom: 20px;">
                ${socialLinksHtml}
            </div>
            
            <p style="font-size: 11px; color: #707070;">
                &copy; ${new Date().getFullYear()} Thabiso Mhlongo. All rights reserved.<br>
                South Africa &bull; Nationwide
            </p>

            ${unsubscribeUrl ? `
            <div style="margin-top: 25px; padding-top: 15px; border-top: 1px solid rgba(255,255,255,0.05);">
                <p style="font-size: 10px; color: #555555;">
                    You are receiving this because you subscribed to receipt updates from Thabiso Mhlongo.<br>
                    <a href="${unsubscribeUrl}" style="color: #888; text-decoration: underline;">Unsubscribe from this list</a>
                </p>
            </div>
            ` : ''}
        </div>
    </div>
</body>
</html>
    `;
}

/**
 * Helper to generate a styled quote table.
 */
function createQuoteTable(rows) {
    let html = `<table style="width: 100%; border-collapse: collapse; margin: 25px 0; background-color: #1a1a1a; border-radius: 4px; overflow: hidden;">`;
    rows.forEach((row, idx) => {
        const isLast = idx === rows.length - 1;
        html += `
            <tr>
                <td style="padding: 18px 20px; border-bottom: ${isLast ? 'none' : '1px solid rgba(255,255,255,0.08)'}; color: #b0b0b0; width: 35%; font-size: 14px;">
                    <strong>${row.label}</strong>
                </td>
                <td style="padding: 18px 20px; border-bottom: ${isLast ? 'none' : '1px solid rgba(255,255,255,0.08)'}; color: ${row.highlight ? '#D4AF37' : '#ffffff'}; font-size: ${row.highlight ? '18px' : '15px'};">
                    ${row.value}
                </td>
            </tr>
        `;
    });
    html += `</table>`;
    return html;
}

module.exports = {
    createEmailWrapper,
    createQuoteTable
};
