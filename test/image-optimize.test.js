// Bandwidth: oversized uploads are shrunk in place (same URL, same format); small files, branding files
// and non-image files are left alone. Unit checks on lib/image-optimize plus the real /upload route.
const sharp = require('sharp');
const { optimizeImageBuffer } = require('../lib/image-optimize');

async function bigJpeg(w, h) {
    const raw = Buffer.alloc(w * h * 3);
    for (let i = 0; i < raw.length; i++) raw[i] = (i * 7 + ((i / 3) | 0) % 251 + (Math.random() * 40)) & 255;
    return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 98 }).toBuffer();
}

module.exports = async function ({ check, upload, BASE }) {
    const big = await bigJpeg(3200, 2400);

    // --- unit ---
    const r = await optimizeImageBuffer(big, 'photo.jpg');
    const rm = await sharp(r.buffer).metadata();
    check('optimiser shrinks an oversized JPEG and keeps it a JPEG', r.optimised && r.after < r.before && rm.format === 'jpeg', JSON.stringify({ before: r.before, after: r.after, fmt: rm.format }));
    check('optimiser limits the longest edge to 2000px, aspect ratio kept', Math.max(rm.width, rm.height) === 2000 && Math.abs(rm.width / rm.height - 4 / 3) < 0.01, `${rm.width}x${rm.height}`);

    const small = await sharp({ create: { width: 300, height: 200, channels: 3, background: '#888' } }).jpeg().toBuffer();
    const rs = await optimizeImageBuffer(small, 'small.jpg');
    check('optimiser leaves a small image untouched (same bytes)', !rs.optimised && rs.buffer === small, 'was modified');

    const png = await sharp({ create: { width: 3000, height: 2000, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 0.5 } } }).png().toBuffer();
    const rp = await optimizeImageBuffer(png, 'logo.png');
    const pm = await sharp(rp.buffer).metadata();
    check('optimiser keeps PNG format and its alpha channel', pm.format === 'png' && pm.hasAlpha === true && Math.max(pm.width, pm.height) === 2000, JSON.stringify(pm));

    const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
    check('optimiser ignores GIF/SVG and corrupt data (original returned, no throw)',
        !(await optimizeImageBuffer(gif, 'a.gif')).optimised
        && !(await optimizeImageBuffer(Buffer.from('<svg/>'), 'a.svg')).optimised
        && !(await optimizeImageBuffer(Buffer.from('not an image'.repeat(30000)), 'bad.jpg')).optimised, 'unexpected result');

    // --- through the real admin upload route ---
    const up = await upload('POST', '/upload', { section: 'gallery' }, { buffer: big, filename: 'optimize-test-big.jpg', contentType: 'image/jpeg' }, 'file');
    check('upload of an oversized photo succeeds and returns the same-format path', up.status === 200 && up.body.success && /^images\/gallery\/.*optimize-test-big\.jpg$/.test(up.body.filePath), JSON.stringify(up.body));
    const served = Buffer.from(await (await fetch(`${BASE}/${up.body.filePath}`)).arrayBuffer());
    const sm = await sharp(served).metadata();
    check('the public URL serves the shrunken image, not the original', served.length < big.length / 2 && Math.max(sm.width, sm.height) === 2000, `served ${served.length} vs original ${big.length}, ${sm.width}x${sm.height}`);

    const brand = await upload('POST', '/upload', { section: 'branding' }, { buffer: big, filename: 'optimize-test-brand.jpg', contentType: 'image/jpeg' }, 'file');
    const brandServed = Buffer.from(await (await fetch(`${BASE}/${brand.body.filePath}`)).arrayBuffer());
    check('branding uploads are stored pixel-exact (not optimised)', brandServed.equals(big), `served ${brandServed.length} vs ${big.length}`);
};
