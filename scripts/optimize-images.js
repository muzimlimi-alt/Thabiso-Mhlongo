// One-off bandwidth clean-up of images that already exist. Dry run unless --apply is given.
//
//   node scripts/optimize-images.js                 report what the repo's images/ folder would save
//   node scripts/optimize-images.js --apply         recompress images/ in place; originals go to --backup-dir
//   node scripts/optimize-images.js --r2            report on the R2 bucket's images/ prefix (needs R2_* env vars)
//   node scripts/optimize-images.js --r2 --apply    recompress in R2; each original is first copied to originals/<key>
//
// Files keep their names and formats, so no URL changes. After an --r2 --apply run, purge the Cloudflare cache
// for /images/* so edge copies of the old large files are replaced (browsers refresh within the 7-day max-age).
// To roll back, copy originals/<key> back over <key> (or restore files from --backup-dir).
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { optimizeImageBuffer, formatForName } = require('../lib/image-optimize');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const R2 = args.includes('--r2');
const SKIP_DIRS = /(^|\/)(branding|icon|backgrounds?)(\/|$)/i; // logos, favicon, login art: keep pixel-exact
const bdIdx = args.indexOf('--backup-dir');
const ROOT = path.join(__dirname, '..', 'images');
const BACKUP_DIR = bdIdx > -1 ? path.resolve(args[bdIdx + 1]) : path.join(__dirname, '..', '..', 'image-originals-backup');

const mb = n => (n / 1048576).toFixed(2) + ' MB';
const totals = { files: 0, optimised: 0, before: 0, after: 0 };
function record(rel, r) {
    totals.files++;
    totals.before += r.before;
    totals.after += r.after;
    if (r.optimised) {
        totals.optimised++;
        console.log(`${APPLY ? 'OPTIMISED' : 'would save'}  ${rel}  ${mb(r.before)} -> ${mb(r.after)}  (${r.width}x${r.height})`);
    }
}

async function runLocal() {
    const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
        e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
    for (const file of walk(ROOT)) {
        const rel = path.relative(ROOT, file).split(path.sep).join('/');
        if (!formatForName(file) || SKIP_DIRS.test(rel)) continue;
        const original = fs.readFileSync(file);
        const r = await optimizeImageBuffer(original, file);
        record(rel, r);
        if (APPLY && r.optimised) {
            const backup = path.join(BACKUP_DIR, rel);
            fs.mkdirSync(path.dirname(backup), { recursive: true });
            if (!fs.existsSync(backup)) fs.writeFileSync(backup, original);
            fs.writeFileSync(file, r.buffer);
        }
    }
}

async function runR2() {
    const { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
    const { R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = process.env;
    if (!(R2_ENDPOINT && R2_BUCKET && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY)) throw new Error('R2_* environment variables are not set');
    const client = new S3Client({ region: 'auto', endpoint: R2_ENDPOINT, credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY } });
    let token;
    do {
        const page = await client.send(new ListObjectsV2Command({ Bucket: R2_BUCKET, Prefix: 'images/', ContinuationToken: token }));
        for (const obj of page.Contents || []) {
            const rel = obj.Key.slice('images/'.length);
            if (!formatForName(obj.Key) || SKIP_DIRS.test(rel)) continue;
            const got = await client.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: obj.Key }));
            const chunks = [];
            for await (const c of got.Body) chunks.push(c);
            const original = Buffer.concat(chunks);
            const r = await optimizeImageBuffer(original, obj.Key);
            record(rel, r);
            if (APPLY && r.optimised) {
                const meta = { Bucket: R2_BUCKET, ContentType: got.ContentType, CacheControl: got.CacheControl || 'public, max-age=604800' };
                await client.send(new PutObjectCommand({ ...meta, Key: 'originals/' + obj.Key, Body: original }));
                await client.send(new PutObjectCommand({ ...meta, Key: obj.Key, Body: r.buffer }));
            }
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
}

(async () => {
    console.log(`${APPLY ? 'APPLYING' : 'DRY RUN'} on ${R2 ? 'R2 bucket' : 'local ' + ROOT}`);
    await (R2 ? runR2() : runLocal());
    console.log(`\n${totals.optimised}/${totals.files} images changed; ${mb(totals.before)} -> ${mb(totals.after)} (saves ${mb(totals.before - totals.after)})`);
    if (!APPLY) console.log('Nothing was modified. Re-run with --apply to write.');
})().catch(e => { console.error(e.message); process.exit(1); });
