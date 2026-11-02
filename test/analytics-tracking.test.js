// The one-page site's analytics (tracker.js -> POST /api/public/analytics/track -> analytics_* tables -> the Dashboard's Traffic tab):
// section views are once per visit and never page views; only known sections / actions are stored; bad ids are dropped; the admin
// endpoints count visits per section, actions, the booking and ticket journeys, "Book Me" sources and new vs returning visitors.
const { api, pub, one, sleep } = require('./support');

module.exports = async function ({ check }) {
    const tag = Date.now().toString(36);
    const vid = 'zz-vis-' + tag, sid = 'zz-ses-' + tag, sid2 = 'zz-ses2-' + tag;
    const send = (body) => pub('POST', '/api/public/analytics/track', body);
    const waitFor = async (fn, ms = 5000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(100); } return v; };

    await send({ event: 'pageview', visitor_id: vid, session_id: sid, page: '/', referrer: '' });
    await send({ event: 'section_view', visitor_id: vid, session_id: sid, name: 'events' });
    await send({ event: 'section_view', visitor_id: vid, session_id: sid, name: 'events' });          // the same visit again: once
    await send({ event: 'section_view', visitor_id: vid, session_id: sid, name: 'contact' });
    await send({ event: 'section_view', visitor_id: vid, session_id: sid, name: 'bkExtrasCard' });     // not a page section: dropped
    await send({ event: 'interaction', visitor_id: vid, session_id: sid, name: 'booking_opened', detail: 'hero-cta' });
    await send({ event: 'interaction', visitor_id: vid, session_id: sid, name: 'booking_step', detail: '2' });
    await send({ event: 'interaction', visitor_id: vid, session_id: sid, name: 'booking_submitted' });
    await send({ event: 'interaction', visitor_id: vid, session_id: sid, name: 'event_opened', detail: '12' });
    await send({ event: 'interaction', visitor_id: vid, session_id: sid, name: 'not_a_thing' });       // unknown action: dropped
    await send({ event: 'interaction', visitor_id: 'x', session_id: sid, name: 'get_tickets' });       // bad visitor id: dropped
    await send({ event: 'interaction', visitor_id: vid, session_id: sid, name: 'event_opened', detail: '<script>alert(1)</script>' });
    // a second visit by the same browser
    await send({ event: 'pageview', visitor_id: vid, session_id: sid2, page: '/', referrer: 'https://www.google.com/' });
    await send({ event: 'section_view', visitor_id: vid, session_id: sid2, name: 'events' });

    const counted = await waitFor(async () => {
        const r = await one(`SELECT COUNT(*) AS n FROM analytics_events WHERE visitor_id = ?`, [vid]);
        return r.n >= 8 ? r : null;
    });
    const rows = (await require('./support').q(`SELECT event_type, name, detail, session_id FROM analytics_events WHERE visitor_id = ? ORDER BY id`, [vid]));
    const sv = rows.filter(r => r.event_type === 'section_view');
    check('section views: once per section per visit, page sections only (events twice in visit 1 -> once; a drawer <section> dropped)',
        !!counted && sv.filter(r => r.session_id === sid && r.name === 'events').length === 1 && sv.some(r => r.name === 'contact') && !sv.some(r => r.name === 'bkExtrasCard'), JSON.stringify(sv));
    const ia = rows.filter(r => r.event_type === 'interaction');
    check('actions: known names only, a bad visitor id dropped, the detail cleaned of markup',
        ia.length === 5 && !ia.some(r => r.name === 'not_a_thing' || r.name === 'get_tickets') && ia.filter(r => r.name === 'event_opened').every(r => !/[<>()]/.test(r.detail || '')), JSON.stringify(ia));
    const pv = await one(`SELECT COUNT(*) AS n FROM analytics_pageviews WHERE visitor_id = ?`, [vid]);
    check('section views and actions are not page views (2 page views for 2 visits)', pv.n === 2, JSON.stringify(pv));

    const today = new Date(Date.now() + 2 * 3600e3).toISOString().slice(0, 10);
    const R = `range=custom&from=${today}&to=${today}`;
    const sec = (await api('GET', '/api/admin/analytics/sections?' + R)).body;
    const ev = sec.rows && sec.rows.find(r => r.key === 'events');
    check('dashboard sections: Events reached in both visits, listed in page order with a friendly name and a share of visits',
        sec.success && ev && ev.visits >= 2 && ev.label === 'Events' && sec.rows[0].key === 'hero' && typeof ev.share === 'number', JSON.stringify(ev));
    const act = (await api('GET', '/api/admin/analytics/interactions?' + R)).body;
    check('dashboard actions: booking journey (opened -> step 2 -> sent) and where the form was opened ("Hero Make Booking")',
        act.success && act.booking[0].visits >= 1 && act.booking[1].visits >= 1 && act.booking[4].visits >= 1 &&
        act.bookingSources.some(s => s.label === 'Hero "Make Booking"') && act.tickets[0].visits >= 1, JSON.stringify(act).slice(0, 600));
    const mix = (await api('GET', '/api/admin/analytics/visitor-mix?' + R)).body;
    check('dashboard visitor mix answers (visitors, new + returning add up, engagement, browsers)', mix.success && mix.new + mix.returning === mix.visitors && Array.isArray(mix.browsers), JSON.stringify(mix));
    const cities = (await api('GET', '/api/admin/analytics/cities?' + R)).body;
    const countries = (await api('GET', '/api/admin/analytics/countries?' + R)).body;
    check('cities and countries answer (countries carry the total for each share)', cities.success && Array.isArray(cities.rows) && countries.success && countries.totalVisitors >= 1, JSON.stringify([cities, countries.totalVisitors]));
    // the cookie pop-up's answers: anonymous, counted for everyone
    const c0 = (await api('GET', '/api/admin/analytics/consent?' + R)).body;
    await pub('POST', '/api/public/analytics/consent', { choice: 'accept_all', analytics: true, functional: true, marketing: true, change: false });
    await pub('POST', '/api/public/analytics/consent', { choice: 'reject_all', analytics: false, functional: false, marketing: false, change: false });
    await pub('POST', '/api/public/analytics/consent', { choice: 'custom', analytics: false, functional: true, marketing: false, change: true });
    await pub('POST', '/api/public/analytics/consent', { choice: 'hack', analytics: true });                         // not a choice: dropped
    const c1 = await waitFor(async () => { const b = (await api('GET', '/api/admin/analytics/consent?' + R)).body; return b.answers >= c0.answers + 3 ? b : null; });
    check('cookie choices: each answer counted (yes / no to analytics, by button, changes) - an unknown choice dropped',
        !!c1 && c1.answers === c0.answers + 3 && c1.analyticsYes === c0.analyticsYes + 1 && c1.analyticsNo === c0.analyticsNo + 2 &&
        c1.byChoice.reject_all === c0.byChoice.reject_all + 1 && c1.changes === c0.changes + 1 && c1.changedToNo === c0.changedToNo + 1, JSON.stringify([c0, c1]));
    const cols = (await require('./support').q(`PRAGMA table_info(analytics_consent_choices)`)).map(c => c.name);
    check('a cookie choice stores nothing that identifies the visitor (no visitor id, session, IP or agent column)', !cols.some(c => /visitor|session|ip|agent|email/.test(c)), cols.join(','));

    const anon = await pub('GET', '/api/admin/analytics/sections?' + R);
    check('the dashboard figures need a login', anon.status === 401 || anon.status === 403, String(anon.status));
};
