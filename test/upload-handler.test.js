// Characterisation test for the main content-image upload handler (POST /upload), covering Phase 3
// item 4 of the housekeeping plan: re-uploading a file must not stack a new Date.now() prefix onto
// a filename that already has one. See safeUploadFilename() in server.js.
const { upload, makeTestPng } = require('./support');

module.exports = async function ({ check }) {
    const png = makeTestPng(20, 20);

    // ── A genuinely new upload still gets a fresh timestamp prefix (unchanged behaviour) ──
    const first = await upload('POST', '/upload', { section: 'gallery' }, { buffer: png, filename: 'my-photo.jpg', contentType: 'image/jpeg' }, 'file');
    check('new upload: 200', first.status === 200 && first.body.success, JSON.stringify(first.body));
    check('new upload: filename gets exactly one timestamp prefix', /^\d{13}-my-photo\.jpg$/.test(first.body.filename), first.body.filename);
    check('new upload: filePath uses the requested section', first.body.filePath === `images/gallery/${first.body.filename}`, first.body.filePath);

    // ── Re-uploading a file whose name is ALREADY prefixed (e.g. re-submitting an
    // already-uploaded image) must not stack a second prefix on top ──
    const alreadyPrefixedName = first.body.filename; // e.g. "1787800000000-my-photo.jpg"
    const second = await upload('POST', '/upload', { section: 'gallery' }, { buffer: png, filename: alreadyPrefixedName, contentType: 'image/jpeg' }, 'file');
    check('re-upload: 200', second.status === 200 && second.body.success, JSON.stringify(second.body));
    check('re-upload: filename is NOT double-prefixed', second.body.filename === alreadyPrefixedName, `got ${second.body.filename}, expected unchanged ${alreadyPrefixedName}`);
    check('re-upload: no stacked-timestamp pattern (two 13-digit runs)', !/^\d{13}-\d{13}-/.test(second.body.filename), second.body.filename);
};
