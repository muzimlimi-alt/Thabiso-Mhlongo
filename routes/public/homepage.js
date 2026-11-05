// The public homepage (/ and /index.html), sent with the admin's current content already in it (lib/homepage-render.js).
// Mounted in app.js BEFORE express.static, which would otherwise serve the plain file. Same caching as the static file had: "no-cache" =
// revalidate every view, and Express's ETag answers an unchanged page with a tiny 304. No login, no cookies, nothing personal.
const express = require('express');
const { renderHomepage } = require('../../lib/homepage-render');
const router = express.Router();

router.get(['/', '/index.html'], async (req, res, next) => {
    try {
        const html = await renderHomepage();
        res.set({ 'Cache-Control': 'no-cache', 'Content-Type': 'text/html; charset=utf-8' });
        res.send(html);
    } catch (err) {
        next(); // the template could not even be read: let express.static try the file
    }
});

module.exports = router;
