const assets = require('../js/emailAssets');
const fs = require('fs');

console.log('--- Phase 2 Asset Verification ---');
const brandAttachments = assets.getBrandAttachments();
console.log('Attachments to be added:', JSON.stringify(brandAttachments, null, 2));

const cids = assets.getBrandCids();
console.log('Brand CIDs:', JSON.stringify(cids, null, 2));

// Verify file existence manually through code
brandAttachments.forEach(att => {
    if (fs.existsSync(att.path)) {
        console.log(`✅ FOUND: ${att.filename} at ${att.path}`);
    } else {
        console.log(`❌ MISSING: ${att.filename} at ${att.path}`);
    }
});

console.log('---------------------------------');
