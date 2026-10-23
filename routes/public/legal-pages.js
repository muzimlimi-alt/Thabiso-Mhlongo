// Public, standalone Privacy Policy and Terms & Conditions pages: /privacy and /terms (text from the homepage pop-ups - see lib/legal-pages.js).
// Mounted from routes/public/site-content.js. No login, no cookies, nothing personal: safe to cache and to index.
const express = require('express');
const legal = require('../../lib/legal-pages');
const router = express.Router();

for (const key of Object.keys(legal.DOCS)) {
    router.get(legal.DOCS[key].path, (req, res, next) => {
        let page;
        try { page = legal.pages()[key]; }
        catch (e) { console.error('legal page failed:', e.message); return next(e); }
        // Revalidate on every view (an edit to the policy shows at once) but let the browser answer from its copy with a 304 via the ETag.
        res.set({ 'Cache-Control': 'no-cache', 'Content-Type': 'text/html; charset=utf-8' });
        res.send(page);
    });
}

// Names people (and some services) guess for the same two pages.
const ALIASES = {
    '/privacy-policy': '/privacy', '/privacy.html': '/privacy',
    '/terms-and-conditions': '/terms', '/terms-conditions': '/terms', '/terms-of-use': '/terms', '/terms-of-service': '/terms', '/terms.html': '/terms'
};
for (const [from, to] of Object.entries(ALIASES)) router.get(from, (req, res) => res.redirect(301, to));

module.exports = router;
