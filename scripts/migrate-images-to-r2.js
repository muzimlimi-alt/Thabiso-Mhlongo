// One-off: copy the images the repo ships (git ls-files images/) into the R2 bucket under the same keys
// the site already uses (images/<path>). Files already in the bucket are skipped, so it is safe to re-run.
// Needs the R2_* variables in the environment or .env:
//   node scripts/migrate-images-to-r2.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const objectStorage = require('../lib/object-storage');
const { PROJECT_ROOT } = require('../lib/runtime-paths');

const CONTENT_TYPES = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
    '.webp': 'image/webp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf'
};

async function main() {
    if (!objectStorage.enabled) {
        console.error('R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY must all be set.');
        process.exit(1);
    }
    const files = execFileSync('git', ['ls-files', 'images'], { cwd: PROJECT_ROOT }).toString()
        .split('\n').filter(Boolean).filter(rel => !rel.startsWith('images/receipts/'));
    let copied = 0;
    let skipped = 0;
    for (const key of files) {
        if (await objectStorage.objectExists(key)) { skipped++; continue; }
        const body = fs.readFileSync(path.join(PROJECT_ROOT, key));
        const contentType = CONTENT_TYPES[path.extname(key).toLowerCase()] || 'application/octet-stream';
        await objectStorage.putBuffer(key, body, contentType);
        copied++;
        console.log('copied', key);
    }
    console.log(`Done: ${copied} copied, ${skipped} already in the bucket.`);
}

main().catch(err => { console.error(err); process.exit(1); });
