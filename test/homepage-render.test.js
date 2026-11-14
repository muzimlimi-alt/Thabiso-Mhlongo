// Server-filled homepage (lib/homepage-render.js, lib/homepage-content.js, routes/public/homepage.js).
//   A. the real index.html: every element the browser script fills is found by the server too (guards the template's structure)
//   B. the fill does what js/myscript.js does: text escaped, HTML fields as stored, cards / badge / image, announcement, about, contact,
//      manager; switched-off sections hidden in the markup and the map handed to the head script; nothing else touched
//   C. robustness: commented-out copies ignored, a missing element skipped (the rest still filled), no data = the plain file
//   D. the running server: / and /index.html carry the current content, an admin edit shows on the next view, ETag 304, the public API
//      answers exactly as before (one shared reader)
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');
const { BASE, TEST_DB } = require('./support');
const render = require('../lib/homepage-render');

const KEYS = ['announcement_text', 'announcement_enabled', 'announcement_rotate', 'announcement_speed', 'hero_tagline', 'hero_subtitle', 'services_eyebrow', 'services_heading', 'services_items', 'features_items', 'section_visibility'];

module.exports = async function ({ check, api, pub, q }) {
    const tpl = fs.readFileSync(render.INDEX_FILE, 'utf8');
    const allOn = Object.fromEntries(Object.keys(render.SECTION_SELECTORS).map((k) => [k, true]));
    const site = (over = {}) => Object.assign({
        success: true,
        announcement: { text: '<strong>Big</strong> news', enabled: true, rotate: true, speed: 10 },
        hero_tagline: 'Tag <b>line</b> & co',
        hero_subtitle: 'Sub with <em>emphasis</em>',
        services: {
            eyebrow: 'What we do', heading: 'Heading <em>here</em>',
            items: [
                { title: 'One <img src=x onerror=alert(1)>', description: 'First & best', image: '', featured: false },
                { title: 'Two', description: 'Second', image: '', featured: false },
                { title: 'Three', description: 'Third', image: 'images/x "y".jpg', featured: true },
                { title: 'Four', description: 'Fourth', image: '', featured: false },
                { title: 'Five', description: 'Fifth', image: '', featured: false }
            ]
        },
        features: { items: [{ title: '1 Year', description: 'On stage' }, { title: '2 Shows', description: 'Live' }, { title: '3 Credits', description: 'TV' }, { title: '4 Languages', description: 'Many' }] },
        sections: Object.assign({}, allOn, { events: false, team: false, features: false })
    }, over);
    const full = () => ({
        site: site(),
        about: { image_path: 'images/about/new.jpg', paragraph1: '<p>Para one</p>', paragraph2: '<p>Para two</p>', paragraph3: '' },
        contact: { quote: 'Say <em>hello</em>', signature: 'Sig & Co' },
        manager: { name: 'Mgr <x>', cell_number: '+27 11 000 0000', whatsapp_number: '+27 82 000 0000', whatsapp_link: '', email: 'm@example.invalid' }
    });
    const textOf = (html, re) => { const m = re.exec(html); return m ? m[1] : null; };

    // ── A. the real template ───────────────────────────────────────────────────────────────────────────────────────────────────────
    const a = render.fill(tpl, full());
    check('A every element the browser script fills is found in index.html (none missed)', a.missed.length === 0, JSON.stringify(a.missed));
    check('A the head script carries the section token', tpl.includes(render.SECTIONS_TOKEN), '');

    // ── B. what gets written ───────────────────────────────────────────────────────────────────────────────────────────────────────
    const h = a.html;
    check('B hero tagline is text (escaped)', textOf(h, /<p class="tm-hero__tagline">([\s\S]*?)<\/p>/) === 'Tag &lt;b&gt;line&lt;/b&gt; &amp; co', textOf(h, /<p class="tm-hero__tagline">([\s\S]*?)<\/p>/));
    check('B hero subtitle is HTML (as stored)', textOf(h, /<p class="tm-hero__subtitle">([\s\S]*?)<\/p>/) === 'Sub with <em>emphasis</em>', '');
    check('B services eyebrow + heading', /<p class="tm-eyebrow">What we do<\/p>\s*<h2 id="servicesTitle">Heading <em>here<\/em><\/h2>/.test(h), '');
    const titles = [...h.matchAll(/<h3 class="tm-service__title">([^<]*)<\/h3>/g)].map((m) => m[1]);
    check('B all five card titles, text-escaped (a tag in a title cannot run)', titles.length === 5 && titles[0] === 'One &lt;img src=x onerror=alert(1)&gt;' && titles[4] === 'Five' && !h.includes('<img src=x'), JSON.stringify(titles));
    check('B card descriptions', /<p class="tm-service__desc">First &amp; best<\/p>/.test(h), '');
    const tags = [...h.matchAll(/tm-service__tag/g)].length;
    const thirdCard = h.slice(h.indexOf('tm-service__bg--3'), h.indexOf('tm-service__bg--4'));
    check('B "Most Booked" follows the admin\'s choice: exactly one badge, on card 3', tags === 1 && thirdCard.includes('<span class="tm-service__tag">Most Booked</span>'), tags);
    check('B a card image becomes its background (quotes stripped, attribute escaped)', /class="tm-service__bg tm-service__bg--3" style="background-image: url\(&quot;images\/x y\.jpg&quot;\);"/.test(h), (h.match(/tm-service__bg--3"[^>]*>/) || [])[0]);
    check('B feature titles + descriptions', /<h4 class="tm-feature__title">1 Year<\/h4>\s*<p class="tm-feature__desc">On stage<\/p>/.test(h) && h.includes('<h4 class="tm-feature__title">4 Languages</h4>'), '');
    check('B announcement text (HTML) + speed (90 / 10 = 9 s)', /<div class="tm-announce-marquee" style="animation-duration: 9s;"><strong>Big<\/strong> news<\/div>/.test(h), (h.match(/<div class="tm-announce-marquee[^>]*>[^\n]*/) || [])[0]);
    check('B About photo + paragraphs', /class="about-img" src="images\/about\/new\.jpg"/.test(h) && /<div class="about-text-card"[^>]*><p>Para one<\/p><p>Para two<\/p><\/div>/.test(h), '');
    check('B contact quote (HTML) + signature (text)', /<blockquote id="dynamicContactQuote">\s*<p>Say <em>hello<\/em><\/p>/.test(h) && h.includes('<b id="dynamicContactName">Sig &amp; Co</b>'), '');
    check('B manager name (escaped), cell, email + mailto', h.includes('<td id="dynamicManagerName">Mgr &lt;x&gt;</td>') && h.includes('<td id="dynamicManagerCell">+27 11 000 0000</td>') && h.includes('<a id="dynamicManagerEmail" href="mailto:m@example.invalid">m@example.invalid</a>'), '');
    check('B WhatsApp without a link falls back to wa.me/<digits>', h.includes('<td id="dynamicManagerWhatsApp"><a href="https://wa.me/27820000000" target="_blank">+27 82 000 0000</a></td>'), (h.match(/<td id="dynamicManagerWhatsApp">[^\n]*/) || [])[0]);
    check('B switched-off sections are hidden in the markup', /<section class="tm-section tm-events tm-section-hidden" id="events"/.test(h) && /class="tm-features tm-section-hidden"/.test(h) && /id="team"/.test(h) && /<section[^>]*tm-section-hidden[^>]*id="team"|<section[^>]*id="team"[^>]*tm-section-hidden/.test(h), '');
    check('B ...and only those (gallery stays visible)', !/<section[^>]*id="gallery"[^>]*tm-section-hidden/.test(h) && !/<section[^>]*tm-section-hidden[^>]*id="gallery"/.test(h), '');
    const boot = textOf(h, /var v = ([^;]*);/);
    let bootMap = null; try { bootMap = JSON.parse(boot); } catch (e) {}
    check('B the head script gets the section map (authoritative)', bootMap && bootMap.events === false && bootMap.gallery === true, boot);
    const xss = render.fill(tpl, { site: site({ sections: Object.assign({}, allOn, { '</script><script>alert(1)</script>': false }) }) }).html;
    check('B the map cannot close the script tag', !xss.includes('</script><script>alert(1)'), '');
    // nothing outside the filled elements changes
    const strip = (s) => s.replace(/<p class="tm-hero__(tagline|subtitle)">[\s\S]*?<\/p>/g, '').replace(/<section class="tm-section tm-services"[\s\S]*?<\/section>/, '').replace(/<section class="tm-features[\s\S]*?<\/section>/, '')
        .replace(/<div class="tm-announcement[\s\S]*?<\/div>\s*<\/div>/, '').replace(/<section class="tm-section tm-about"[\s\S]*?<\/section>/, '').replace(/<aside class="tm-contact__aside[\s\S]*?<\/aside>/, '')
        .replace(/var v = [^;]*;/, '').replace(/<(section|footer)\b[^>]*>/g, '');
    check('B nothing else in the page is touched', strip(h) === strip(tpl), (() => { const x = strip(h), y = strip(tpl); let i = 0; while (i < x.length && x[i] === y[i]) i++; return x.slice(i - 80, i + 80) + ' ||| ' + y.slice(i - 80, i + 80); })());

    const none = render.fill(tpl, { site: site({ services: { eyebrow: '', heading: '', items: [{ title: 'A', description: 'a', image: '', featured: false }] } }) }).html;
    check('B "Most Booked" chosen as none: no badge at all', !none.includes('tm-service__tag'), '');
    const never = render.fill(tpl, { site: site({ services: { eyebrow: '', heading: '', items: ['A', 'B', 'C', 'D', 'E'].map((t) => ({ title: t, description: t, image: '' })) } }) }).html;
    check('B "Most Booked" never chosen: the page keeps its built-in badge', (never.match(/tm-service__tag/g) || []).length === (tpl.match(/tm-service__tag/g) || []).length, '');
    // the admin adds and deletes cards: the page shows exactly the stored count
    const cardsOf = (html) => { const g = html.slice(html.indexOf('class="tm-services__grid"'), html.indexOf('<!-- ============== ABOUT')); return { g, n: (g.match(/<a href="#"[^>]*class="tm-service tm-reveal/g) || []).length }; };
    const one1 = cardsOf(render.fill(tpl, { site: site({ services: { eyebrow: '', heading: '', items: [{ title: 'Only', description: 'one', image: '', featured: true }] } }) }).html);
    check('B one stored card: the page shows one card (with its badge), and lays out one per row', one1.n === 1 && one1.g.includes('>Only</h3>') && (one1.g.match(/tm-service__tag/g) || []).length === 1 && one1.g.includes('--svc-cols-lg: 1; --svc-cols-xl: 1;'), one1.g.slice(0, 300));
    const seven = Array.from({ length: 7 }, (_, i) => ({ title: 'Card ' + (i + 1) + (i === 6 ? ' <b>x</b>' : ''), description: 'd' + i, image: i === 6 ? 'images/n "q".jpg' : '', featured: i === 6 }));
    const s7 = cardsOf(render.fill(tpl, { site: site({ services: { eyebrow: '', heading: '', items: seven } }) }).html);
    check('B seven stored cards: five filled + two built, numbered 06 and 07, rows of 3 / 4', s7.n === 7 && s7.g.includes('<span class="tm-service__label">06</span><h3 class="tm-service__title">Card 6</h3>') && s7.g.includes('--svc-cols-lg: 3; --svc-cols-xl: 4;'), s7.g.slice(-900));
    check('B a built card is escaped like the others and carries its image and badge', s7.g.includes('<h3 class="tm-service__title">Card 7 &lt;b&gt;x&lt;/b&gt;</h3>') && s7.g.includes('class="tm-service__bg tm-service__bg--custom" style="background-image: url(&quot;images/n q.jpg&quot;);"') && (s7.g.match(/tm-service__tag/g) || []).length === 1 && /data-bk-source="service-custom"><div class="tm-service__bg tm-service__bg--custom" style="[^"]*"><\/div><div class="tm-service__overlay"><\/div><span class="tm-service__tag">/.test(s7.g.slice(s7.g.lastIndexOf('<a href'))), s7.g.slice(-700));
    const del = render.fill(tpl, { site: site({ services: { eyebrow: '', heading: '', items: [{ title: 'A', description: 'a', image: '', featured: false }] } }) }).html;
    const delSec = del.slice(del.indexOf('<section class="tm-section tm-services"'), del.indexOf('<!-- ============== ABOUT'));
    check('B deleting cards leaves well-formed markup (every <a> and <div> in the section still closes)', (delSec.match(/<a\b/g) || []).length === (delSec.match(/<\/a>/g) || []).length && (delSec.match(/<div\b/g) || []).length === (delSec.match(/<\/div>/g) || []).length && /<\/section>\s*$/.test(delSec), '');
    const off = render.fill(tpl, { site: site({ announcement: { text: '', enabled: false, rotate: false, speed: 5 } }) }).html;
    check('B announcement switched off / not rotating', /<div class="tm-announcement no-rotate" role="status" style="display: none;">|<div class="tm-announcement no-rotate"[^>]*style="display: none;"/.test(off), (off.match(/<div class="tm-announcement[^>]*>/) || [])[0]);
    const link = render.fill(tpl, { manager: { name: 'M', whatsapp_link: 'https://wa.me/qr/ABC"x', whatsapp_number: '1' } }).html;
    check('B a WhatsApp link is used as given (attribute-escaped)', link.includes('<a href="https://wa.me/qr/ABC&quot;x" target="_blank">1</a>'), '');

    // ── C. robustness ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
    const mini = '<!-- <p class="tm-hero__tagline">old</p> --><script>var s = \'<p class="tm-hero__tagline">x</p>\';</script><p class="tm-hero__tagline">real</p>';
    const c1 = render.fill(mini, { site: site() });
    check('C a commented-out or scripted copy is ignored; the live one is filled', c1.html.startsWith('<!-- <p class="tm-hero__tagline">old</p> --><script>var s = \'<p class="tm-hero__tagline">x</p>\';</script><p class="tm-hero__tagline">Tag &lt;b&gt;line'), c1.html.slice(0, 200));
    check('C missing elements are reported and skipped, never thrown', c1.missed.includes('.tm-hero__subtitle') && c1.missed.includes('#tmSectionsBoot token'), JSON.stringify(c1.missed));
    check('C no data: the page is exactly the plain file', render.fill(tpl, {}).html === tpl, '');
    const empty = render.fill(tpl, { site: { announcement: { text: '', enabled: true, rotate: true, speed: 5 }, hero_tagline: '', hero_subtitle: '', services: { eyebrow: '', heading: '', items: [] }, features: { items: [] }, sections: allOn } });
    check('C nothing stored yet: the built-in text stays (only the section map and the default speed are written)', empty.missed.length === 0 && strip(empty.html) === strip(tpl) && textOf(empty.html, /<p class="tm-hero__tagline">([\s\S]*?)<\/p>/) === textOf(tpl, /<p class="tm-hero__tagline">([\s\S]*?)<\/p>/), JSON.stringify(empty.missed));

    // ── D. the running server ──────────────────────────────────────────────────────────────────────────────────────────────────────
    const saved = await q(`SELECT setting_key, setting_value FROM settings WHERE setting_key IN (${KEYS.map(() => '?').join(',')})`, KEYS);
    try {
        const apiBefore = {};
        for (const u of ['/api/public/site-content', '/api/public/manager', '/api/public/contact_info', '/api/public/about-me']) apiBefore[u] = (await pub('GET', u));
        check('D the public API still answers (one shared reader)', Object.values(apiBefore).every((r) => r.status === 200) && apiBefore['/api/public/site-content'].body.success === true && apiBefore['/api/public/site-content'].body.sections && 'image_path' in apiBefore['/api/public/about-me'].body, JSON.stringify(Object.values(apiBefore).map((r) => r.status)));

        const mark = 'Tagline ' + Date.now().toString(36);
        await api('PUT', '/api/admin/site-content', { hero_tagline: mark, section_visibility: Object.assign({}, allOn, { events: false }) });
        const r1 = await fetch(BASE + '/');
        const body1 = await r1.text();
        check('D GET / is HTML, revalidated every view (no-cache)', r1.status === 200 && /text\/html/.test(r1.headers.get('content-type')) && r1.headers.get('cache-control') === 'no-cache', r1.status + ' ' + r1.headers.get('content-type') + ' ' + r1.headers.get('cache-control'));
        check('D an admin edit is in the very next page view', body1.includes('<p class="tm-hero__tagline">' + mark + '</p>'), textOf(body1, /<p class="tm-hero__tagline">([\s\S]*?)<\/p>/));
        check('D a switched-off section arrives hidden', /<section[^>]*tm-section-hidden[^>]*id="events"|<section[^>]*id="events"[^>]*tm-section-hidden/.test(body1) && /var v = \{[^;]*"events":false/.test(body1), '');
        const etag = r1.headers.get('etag');
        // a browser revalidating sends max-age=0; Node's fetch would otherwise add "Cache-Control: no-cache" to any conditional request,
        // which tells Express to send the full page
        const revalidate = { 'If-None-Match': etag || '', 'Cache-Control': 'max-age=0' };
        const r2 = await fetch(BASE + '/', { headers: revalidate });
        check('D an unchanged page answers 304 (ETag)', !!etag && r2.status === 304, etag + ' ' + r2.status);
        const r3 = await fetch(BASE + '/index.html');
        check('D /index.html is filled the same way', r3.status === 200 && (await r3.text()).includes(mark), r3.status);
        await api('PUT', '/api/admin/site-content', { hero_tagline: mark + ' v2' });
        const r4 = await fetch(BASE + '/', { headers: revalidate });
        check('D after an edit the old copy is not reused (200 with the new text)', r4.status === 200 && (await r4.text()).includes(mark + ' v2'), r4.status);
        const site2 = (await pub('GET', '/api/public/site-content')).body;
        check('D the page and the API agree', site2.hero_tagline === mark + ' v2' && site2.sections.events === false, JSON.stringify(site2.sections));
    } finally {
        // put the shared test database back exactly as it was (other suites read these settings). Written directly: the admin API would
        // turn "never chose a Most Booked card" into "chose none". q() is read-only, so a writable handle, closed straight after.
        const rw = new sqlite3.Database(TEST_DB);
        const run = (sql, params) => new Promise((resolve, reject) => rw.run(sql, params, (e) => (e ? reject(e) : resolve())));
        try {
            await run(`DELETE FROM settings WHERE setting_key IN (${KEYS.map(() => '?').join(',')})`, KEYS);
            for (const r of saved) await run('INSERT INTO settings (setting_key, setting_value) VALUES (?, ?)', [r.setting_key, r.setting_value]);
        } finally { await new Promise((resolve) => rw.close(() => resolve())); }
    }
};
