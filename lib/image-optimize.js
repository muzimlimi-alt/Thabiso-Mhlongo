// Bandwidth optimisation for public images. Same format in, same format out, so the stored URL and file
// extension never change and no database row or HTML needs touching. Used by the admin /upload route
// (so a 9 MB camera original can't reach the public site) and by scripts/optimize-images.js (existing files).
//
// - Resizes so the longest edge is at most MAX_EDGE (never enlarges): 2000px covers a full-width hero on a 1080p screen.
// - JPEG: mozjpeg q80, progressive. PNG: lossless, max compression (keeps transparency). WebP: q80.
// - GIF/SVG/ICO/PDF and anything sharp can't read are returned untouched.
// - EXIF orientation is applied, then metadata (including GPS) is dropped.
// - A result that isn't at least MIN_SAVING smaller is discarded and the original bytes are returned.
const sharp = require('sharp');

const MAX_EDGE = 2000;
const MIN_BYTES = 200 * 1024;      // below this, leave the file alone
const MIN_SAVING = 0.10;           // keep the optimised copy only if it saves 10% or more

const FORMATS = {
    '.jpg': 'jpeg', '.jpeg': 'jpeg', '.png': 'png', '.webp': 'webp'
};

function formatForName(name) {
    const m = /\.[^.\\/]+$/.exec(String(name || '').toLowerCase());
    return m ? FORMATS[m[0]] || null : null;
}

// Returns { buffer, optimised, before, after, width, height }. Never throws: on any failure the original comes back.
async function optimizeImageBuffer(buffer, filename, { maxEdge = MAX_EDGE } = {}) {
    const before = buffer.length;
    const unchanged = { buffer, optimised: false, before, after: before };
    const format = formatForName(filename);
    if (!format) return unchanged;
    try {
        const meta = await sharp(buffer).metadata();
        if (meta.pages && meta.pages > 1) return unchanged; // animated
        const needsResize = Math.max(meta.width || 0, meta.height || 0) > maxEdge;
        if (!needsResize && before < MIN_BYTES) return unchanged;

        let pipeline = sharp(buffer).rotate(); // apply EXIF orientation, then strip metadata
        if (needsResize) pipeline = pipeline.resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true });
        if (format === 'jpeg') pipeline = pipeline.jpeg({ quality: 80, mozjpeg: true, progressive: true });
        else if (format === 'png') pipeline = pipeline.png({ compressionLevel: 9, effort: 10 });
        else pipeline = pipeline.webp({ quality: 80 });

        const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
        if (data.length > before * (1 - MIN_SAVING) && !needsResize) return unchanged;
        if (data.length >= before) return unchanged;
        return { buffer: data, optimised: true, before, after: data.length, width: info.width, height: info.height };
    } catch (err) {
        return unchanged;
    }
}

module.exports = { optimizeImageBuffer, formatForName, MAX_EDGE };
