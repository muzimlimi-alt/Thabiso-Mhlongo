// Patch admin.html: insert booking attachments panel after the message div
// Run with: node _patch_attachments.js
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'admin.html');
let content = fs.readFileSync(filePath, 'utf8');

const ANCHOR = "${row.message ? `<div class=\"bkr-message\">${row.message}</div>` : ''}";
const idx = content.indexOf(ANCHOR);
if (idx === -1) {
    console.error('ERROR: anchor string not found in admin.html — patch aborted');
    process.exit(1);
}

const attachBlock = `      \${(function() {
        try {
          const files = JSON.parse(row.attachment_files || '[]');
          if (!files.length) return '';
          return '<div class="bkr-attachments" style="margin-top:8px;">' +
            '<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.7px;color:#666;margin-bottom:6px;">Attached Files</div>' +
            '<div style="display:flex;flex-wrap:wrap;gap:6px;">' +
            files.map(f => '<a href="/api/admin/booking-attachments/' + encodeURIComponent(f.filename) + '" target="_blank" ' +
              'style="font-size:11px;color:#D4AF37;text-decoration:none;border:1px solid rgba(212,175,55,0.35);padding:4px 10px;border-radius:4px;display:inline-flex;align-items:center;gap:5px;">' +
              '<i class=\\"fa-solid fa-paperclip\\" style=\\"font-size:10px;\\"></i>' + f.original_name + '</a>'
            ).join('') +
            '</div></div>';
        } catch(e) { return ''; }
      })()}`;

const replacement = ANCHOR + '\n' + attachBlock;
content = content.slice(0, idx) + replacement + content.slice(idx + ANCHOR.length);

fs.writeFileSync(filePath, content, 'utf8');
console.log('Done — attachments panel inserted into admin.html');
