// The public website's visual theme (Onyx or Bone), written into index.html before it is sent.
// Same pattern as lib/preloader-choice.js — a token in the page is replaced server-side so the
// first paint is already correct and no visitor ever sees one theme flash into the other.
const TOKEN = '/*TM_THEME*/null';

function fillThemeToken(html, theme) {
    const at = html.indexOf(TOKEN);
    if (at < 0) return null;
    const json = JSON.stringify(theme).replace(/</g, '\\u003c');
    return html.slice(0, at) + json + html.slice(at + TOKEN.length);
}

module.exports = { THEME_TOKEN: TOKEN, fillThemeToken };
