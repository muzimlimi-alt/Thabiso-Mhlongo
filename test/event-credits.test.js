// Featuring / Organiser on an event (routes/admin/events.js saveEventCredits): optional text set in the admin event editor and shown in the
// public event pop-up (js/myscript.js). Saved on create and edit, kept when an edit does not send them (cancel modal, bulk actions),
// cleared by an empty value, copied by Duplicate, on the public events list, length-checked. Text is stored entity-encoded once.
// Date offsets 2050-2052 are reserved for this file. Every event it creates is cancelled before it ends.
const { api, pub, one, future } = require('./support');

module.exports = async function ({ check }) {
    const made = [];
    try {
        const when = `${future(2050)}T20:00`;
        const title = 'ZZ Credits Show';
        const ev = (await api('POST', '/api/admin/events', { event_title: title, event_datetime: when, venue_name: 'Credits Hall', event_status: 'upcoming', sync_to_gcal: false,
            event_featuring: '  Thabiso Mhlongo & Friends  ', event_organiser: 'TM Management' })).body;
        made.push({ id: ev.id, title, when });
        const row = () => one('SELECT event_featuring, event_organiser FROM events WHERE event_id = ?', [ev.id]);
        let r = await row();
        check('create: Featuring and Organiser are saved (trimmed, stored entity-encoded once)',
            r && r.event_featuring === 'Thabiso Mhlongo &amp; Friends' && r.event_organiser === 'TM Management', JSON.stringify(r));

        const list = (await pub('GET', '/api/public/events')).body;
        const listed = Array.isArray(list) && list.find(e => e.event_id === ev.id);
        check('the public events list carries both (the pop-up reads them from there)',
            !!listed && listed.event_featuring === 'Thabiso Mhlongo &amp; Friends' && listed.event_organiser === 'TM Management', JSON.stringify(listed && { f: listed.event_featuring, o: listed.event_organiser }));

        // an edit that does not send the fields (the cancel modal, bulk actions, older callers) leaves them alone
        await api('PUT', `/api/admin/events/${ev.id}`, { event_title: title, event_datetime: when, venue_name: 'Credits Hall', event_status: 'upcoming', sync_to_gcal: false });
        r = await row();
        check('an edit without the fields keeps them as they were', r.event_featuring === 'Thabiso Mhlongo &amp; Friends' && r.event_organiser === 'TM Management', JSON.stringify(r));

        // the editor sends both: a change and a blank
        const put = await api('PUT', `/api/admin/events/${ev.id}`, { event_title: title, event_datetime: when, venue_name: 'Credits Hall', event_status: 'upcoming', sync_to_gcal: false,
            event_featuring: 'Skhumba Hlophe', event_organiser: '   ' });
        r = await row();
        check('an edit changes Featuring, and a blank Organiser clears it (the pop-up then leaves that panel out)',
            put.status === 200 && r.event_featuring === 'Skhumba Hlophe' && r.event_organiser === null, JSON.stringify([put.status, r]));

        const long = await api('PUT', `/api/admin/events/${ev.id}`, { event_title: title, event_datetime: when, venue_name: 'Credits Hall', event_status: 'upcoming', sync_to_gcal: false, event_featuring: 'x'.repeat(700) });
        const notText = await api('PUT', `/api/admin/events/${ev.id}`, { event_title: title, event_datetime: when, venue_name: 'Credits Hall', event_status: 'upcoming', sync_to_gcal: false, event_organiser: { a: 1 } });
        r = await row();
        check('far too long, or not text, is refused (400) and nothing changes',
            long.status === 400 && notText.status === 400 && r.event_featuring === 'Skhumba Hlophe', JSON.stringify([long.status, notText.status, r]));

        const dup = (await api('POST', `/api/admin/events/${ev.id}/duplicate`, {})).body;
        if (dup && dup.id) made.push({ id: dup.id, title: title + ' (Copy)', when });
        const d = dup && dup.id && await one('SELECT event_featuring, event_organiser FROM events WHERE event_id = ?', [dup.id]);
        check('Duplicate copies Featuring and Organiser', !!d && d.event_featuring === 'Skhumba Hlophe' && d.event_organiser === null, JSON.stringify([dup, d]));
    } finally {
        for (const ev of made) await api('PUT', `/api/admin/events/${ev.id}`, { event_title: ev.title, event_datetime: ev.when, event_status: 'cancelled', sync_to_gcal: false }).catch(() => {});
    }
};
