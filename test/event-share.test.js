// Share a show: the short link /e/<event_id> (routes/public/site-content.js) against the real server. WhatsApp / Facebook read its Open
// Graph tags (poster, title, date, "Tickets on sale now"), people are sent on to /?event=<id>; a draft, cancelled or unknown event is not
// shareable (straight to the homepage's events). Text is escaped exactly once.
// Date offsets 1990-1994 are reserved for this file. Every event it creates is cancelled before it ends.
const { api, future, BASE } = require('./support');

const get = async (path) => { const r = await fetch(BASE + path, { redirect: 'manual' }); return { status: r.status, location: r.headers.get('location'), cache: r.headers.get('cache-control'), text: await r.text() }; };
const meta = (html, prop) => { const m = html.match(new RegExp(`<meta (?:property|name)="${prop}" content="([^"]*)"`)); return m ? m[1] : null; };

module.exports = async function ({ check }) {
    const made = [];
    try {
        const mk = async (offset, title, extra) => {
            const when = `${future(offset)}T20:00`;
            const ev = (await api('POST', '/api/admin/events', { event_title: title, event_datetime: when, venue_name: 'The Big Hall', event_status: 'upcoming', sync_to_gcal: false, ...extra })).body;
            made.push({ id: ev.id, title, when });
            return { id: ev.id, when };
        };
        const s = await mk(1990, 'ZZ Share & <Friends>', { poster_image_path: 'images/events/share-test.jpg' });
        await api('POST', `/api/admin/events/${s.id}/ticket-types`, { name: 'General', price: '100', is_active: true, capacity: 10 });
        const r = await get(`/e/${s.id}`);
        check('the share link answers with a page (200), cached for 5 minutes, that sends people on to /?event=<id>',
            r.status === 200 && /max-age=300/.test(r.cache) && r.text.includes(`<meta http-equiv="refresh" content="0; url=/?event=${s.id}">`) && r.text.includes(`href="/?event=${s.id}"`), r.status + ' ' + r.text.slice(0, 300));
        check('og:title is the show\'s name, escaped exactly once (& and < > never doubled, never raw)',
            meta(r.text, 'og:title') === 'ZZ Share &amp; &lt;Friends&gt;' && !r.text.includes('<Friends>') && !r.text.includes('&amp;amp;'), meta(r.text, 'og:title'));
        const desc = meta(r.text, 'og:description') || '';
        check('og:description: the date, the venue and "Tickets on sale now"', /20:00/.test(desc) && /The Big Hall/.test(desc) && /Tickets on sale now/.test(desc), desc);
        check('og:image is the poster as a full https address; og:url is the share link itself (so Facebook keeps this preview)',
            /^https?:\/\/[^/]+\/images\/events\/share-test\.jpg$/.test(meta(r.text, 'og:image') || '') && new RegExp(`/e/${s.id}$`).test(meta(r.text, 'og:url') || '') && meta(r.text, 'twitter:card') === 'summary_large_image',
            [meta(r.text, 'og:image'), meta(r.text, 'og:url')].join(' | '));
        check('the share page itself stays out of search results (noindex)', meta(r.text, 'robots') === 'noindex, follow', meta(r.text, 'robots'));

        const plain = await mk(1991, 'ZZ Share Plain Show');
        const p = await get(`/e/${plain.id}`);
        check('a show without tickets sold here: still shareable, the default image, no "Tickets on sale now"',
            p.status === 200 && /\/images\/image-slider-1\.jpg$/.test(meta(p.text, 'og:image') || '') && !/Tickets on sale/.test(meta(p.text, 'og:description') || ''), meta(p.text, 'og:description'));

        const draft = await mk(1992, 'ZZ Share Draft Show', { event_status: 'draft' });
        const d = await get(`/e/${draft.id}`);
        await api('PUT', `/api/admin/events/${plain.id}`, { event_title: 'ZZ Share Plain Show', event_datetime: plain.when, event_status: 'cancelled', sync_to_gcal: false });
        const c = await get(`/e/${plain.id}`);
        const none = await get('/e/999999999');
        const junk = await get('/e/abc');
        check('a draft, a cancelled, an unknown or a malformed id is NOT shareable: straight to the homepage\'s events (302 /#events), nothing about the show',
            [d, c, none, junk].every(x => x.status === 302 && x.location === '/#events') && !d.text.includes('ZZ Share Draft Show'), JSON.stringify([d.status, c.status, none.status, junk.status, d.location]));
    } finally {
        for (const ev of made) await api('PUT', `/api/admin/events/${ev.id}`, { event_title: ev.title, event_datetime: ev.when, event_status: 'cancelled', sync_to_gcal: false }).catch(() => {});
    }
};
