// The one place that knows how the admin's chosen loading screen (js/tm-preloader.js) is written into a page before it is sent.
//
// Both pages that show a preloader carry the same token in a tiny #tmPreloaderBoot script in <head>, and both are served through a
// route that replaces it (routes/public/homepage.js for the homepage, routes/public/admin-page.js for the admin). That is what makes a
// change the admin saves show up for everyone on their very next page view: the page itself arrives already carrying the new choice, so
// nothing has to be fetched, and no stale copy in a visitor's browser can win.
//
// When the token is NOT replaced - only if the page is served as a plain file, or the database was too slow or unreachable - the boot
// script falls back to the last choice that browser was told about, and failing that to the loader's own default. That is a degraded
// path, not the normal one.
const TOKEN = '/*TM_PRELOADER*/null';

// Writes `preloader` ({ style, field }) in place of the token. Returns null if the page no longer has one, so the caller can say so
// rather than silently serving a page the setting cannot reach.
// '<' is escaped exactly as the section map's is: the JSON sits inside a <script> block, so nothing in it may close the tag.
function fillPreloaderToken(html, preloader) {
    const at = html.indexOf(TOKEN);
    if (at < 0) return null;
    const json = JSON.stringify(preloader).replace(/</g, '\\u003c');
    return html.slice(0, at) + json + html.slice(at + TOKEN.length);
}

module.exports = { PRELOADER_TOKEN: TOKEN, fillPreloaderToken };
