// admin.html, sent with the admin's chosen loading screen already in it (lib/admin-page-render.js).
// Mounted in app.js BEFORE express.static, which would otherwise serve the plain file.
// Caching: exactly what the static server gave this file before (no-cache, no-store, must-revalidate) - unchanged, so nothing about how
// the admin page is cached is different; only the one token in it is now filled.
// No login and no session are involved: this is the page that CONTAINS the sign-in screen, and the only thing filled into it is which
// loading screen to draw, which is not private.
const express = require('express');
const { renderAdminPage } = require('../../lib/admin-page-render');
const router = express.Router();

router.get('/admin.html', async (req, res, next) => {
    try {
        const html = await renderAdminPage();
        res.set({
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0',
            'Content-Type': 'text/html; charset=utf-8'
        });
        res.send(html);
    } catch (err) {
        next();   // the file could not even be read: let express.static try it
    }
});

module.exports = router;
