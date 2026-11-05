// FAQ (lib/faq.js, routes/admin/faq.js, GET /api/public/faqs) against the running test server.
//   A. migration 121: ten starter questions, all HIDDEN - nothing public until published; no prices in them
//   B. validation: lengths, topic, duplicates (case-insensitive); text stored as typed (apostrophes, ampersands, tags); paragraphs kept
//   C. publishing: hidden by default, published shows with ONLY the public fields, website order = topic order then position
//   D. move up / down within a topic; audit trail
//   E. roles: every admin role may add / edit / publish; only an administrator deletes; signed-out refused (public list is open)
//   F. the Homepage Sections switch
const MARK = 'FAQT' + Date.now().toString(36);

module.exports = async function ({ check, api, pub, one, q, loginAs }) {
    const adminView = async () => (await api('GET', '/api/admin/faqs')).body;
    const publicList = async () => (await pub('GET', '/api/public/faqs')).body;

    // ── A. starters ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
    const starters = await q(`SELECT * FROM faqs WHERE created_by IS NULL ORDER BY id LIMIT 10`);
    check('A migration 121 seeded ten starter questions', starters.length === 10, starters.length);
    // seeded HIDDEN (lib/faq-schema.js inserts them 'inactive'); the test database is a copy of the real one, where the owner may since have
    // published some, so the seed itself is checked rather than today's status
    check('A every starter is seeded HIDDEN (nothing reaches the website unpublished)', /'inactive'/.test(require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'faq-schema.js'), 'utf8')), 'lib/faq-schema.js no longer seeds the starters as inactive');
    check('A no starter answer mentions a price (the site never publishes prices)', starters.every((s) => !/R\s?\d|\bR\d|rand|\$\d|price list:/i.test(s.answer)), JSON.stringify(starters.map((s) => s.answer.slice(0, 40))));
    const pub0 = await publicList();
    check('A the public list contains only published questions', Array.isArray(pub0) && pub0.every((f) => !f.question.startsWith(MARK)) && pub0.every((f) => { const s = starters.find((x) => x.id === f.id); return !s || s.status === 'active'; }), JSON.stringify(pub0).slice(0, 200));

    // ── B. validation and text ─────────────────────────────────────────────────────────────────────────────────────────────────────
    const bad = await api('POST', '/api/admin/faqs', { question: 'Hm?', answer: 'x', category: 'nope' });
    check('B too-short question / answer and an unknown topic are refused with field errors', bad.status === 400 && bad.body.errors.question && bad.body.errors.answer && bad.body.errors.category, JSON.stringify(bad.body));
    const long = await api('POST', '/api/admin/faqs', { question: `${MARK} ` + 'x'.repeat(220), answer: 'A fine answer.', category: 'general' });
    check('B an over-long question is refused', long.status === 400 && /under 200/.test(long.body.errors.question || ''), JSON.stringify(long.body));
    const qText = `${MARK} Don't you & your team "travel" <b>far</b>?`;
    const aText = 'First paragraph line one.\r\nLine two of it.\r\n\r\n\r\n\r\nSecond   paragraph.';
    const made = await api('POST', '/api/admin/faqs', { question: qText, answer: aText, category: 'bookings' });
    check('B a valid question is saved', made.status === 200 && made.body.id, JSON.stringify(made.body).slice(0, 300));
    const row = await one('SELECT * FROM faqs WHERE id = ?', [made.body.id]);
    check('B the question is stored exactly as typed - apostrophes, ampersands, quotes and tags (never entity-encoded)', row && row.question === qText, row && row.question);
    check('B the answer keeps its paragraphs: Windows line breaks normalised, extra blank lines collapsed, spaces tidied', row && row.answer === 'First paragraph line one.\nLine two of it.\n\nSecond paragraph.', JSON.stringify(row && row.answer));
    check('B a new question starts Hidden', row && row.status === 'inactive');
    const dup = await api('POST', '/api/admin/faqs', { question: qText.toUpperCase(), answer: 'Another answer here.', category: 'general' });
    check('B the same question again (any capitalisation) is refused', dup.status === 400 && /already/.test(dup.body.errors.question || ''), JSON.stringify(dup.body));

    // ── C. publishing ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
    check('C a hidden question is not on the website', !(await publicList()).some((f) => f.id === made.body.id));
    const p1 = await api('PUT', `/api/admin/faqs/${made.body.id}`, { status: 'active' });
    check('C publishing (status only) keeps everything else', p1.status === 200 && (await one('SELECT question, status FROM faqs WHERE id = ?', [made.body.id])).question === qText, JSON.stringify(p1.body).slice(0, 200));
    const live = (await publicList()).find((f) => f.id === made.body.id);
    check('C once published it is on the website', !!live, '');
    check('C the website receives ONLY id, question, answer, topic and its label (no status, order or who/when)', live && Object.keys(live).sort().join(',') === 'answer,category,category_label,id,question', JSON.stringify(live));
    const g1 = await api('POST', '/api/admin/faqs', { question: `${MARK} General question one?`, answer: 'General answer one.', category: 'general', status: 'active' });
    const pay1 = await api('POST', '/api/admin/faqs', { question: `${MARK} Payment question one?`, answer: 'Payment answer one.', category: 'payments', status: 'active' });
    const b2 = await api('POST', '/api/admin/faqs', { question: `${MARK} Booking question two?`, answer: 'Booking answer two.', category: 'bookings', status: 'active' });
    const mine = (await publicList()).filter((f) => f.question.startsWith(MARK));
    check('C website order: Bookings, then Payments, then General; within a topic by position (new ones go last)',
        mine.map((f) => f.id).join(',') === [made.body.id, b2.body.id, pay1.body.id, g1.body.id].join(','), JSON.stringify(mine.map((f) => [f.category, f.question.slice(-24)])));

    // ── D. move ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
    const mv = await api('POST', `/api/admin/faqs/${b2.body.id}/move`, { direction: 'up' });
    const after = (await publicList()).filter((f) => f.category === 'bookings' && f.question.startsWith(MARK)).map((f) => f.id);
    check('D moving a question up swaps it with the one above (within its topic)', mv.status === 200 && mv.body.moved === true && after[0] === b2.body.id && after[1] === made.body.id, JSON.stringify([mv.body.moved, after]));
    const allBookings = (await adminView()).items.filter((i) => i.category === 'bookings');
    const firstId = allBookings[0].id;
    const edge = await api('POST', `/api/admin/faqs/${firstId}/move`, { direction: 'up' });
    check('D moving the first question up does nothing (and says so)', edge.status === 200 && edge.body.moved === false, JSON.stringify(edge.body).slice(0, 120));
    const orders = (await q(`SELECT display_order FROM faqs WHERE category = 'bookings' ORDER BY display_order`)).map((r) => r.display_order);
    check('D positions stay unique and gap-free after a move', orders.every((o, i) => o === i + 1), JSON.stringify(orders));
    check('D an unknown direction is refused', (await api('POST', `/api/admin/faqs/${firstId}/move`, { direction: 'sideways' })).status === 400);
    const moved = await api('PUT', `/api/admin/faqs/${g1.body.id}`, { category: 'events' });
    const evts = (await adminView()).items.filter((i) => i.category === 'events');
    check('D changing a question\'s topic puts it at the end of that topic', moved.status === 200 && evts[evts.length - 1].id === g1.body.id, JSON.stringify(evts.map((e) => e.id)));
    const audits = await q(`SELECT action FROM audit_log WHERE table_name = 'faqs' AND record_id = ?`, [b2.body.id]);
    check('D create, update and reorder are in the audit log', ['create', 'reorder'].every((a) => audits.some((r) => r.action === a)) && (await q(`SELECT 1 FROM audit_log WHERE table_name = 'faqs' AND record_id = ? AND action = 'update'`, [made.body.id])).length > 0, JSON.stringify(audits));

    // ── E. roles ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
    check('E signed-out admin requests are refused', [401, 403].includes((await pub('GET', '/api/admin/faqs')).status));
    for (const r of ['manager', 'assistant']) {
        const as = await loginAs(r);
        const c = await as('POST', '/api/admin/faqs', { question: `${MARK} ${r} question?`, answer: `${r} answer text.`, category: 'general' });
        const e = c.body && c.body.id ? await as('PUT', `/api/admin/faqs/${c.body.id}`, { status: 'active' }) : { status: 0 };
        const d = c.body && c.body.id ? await as('DELETE', `/api/admin/faqs/${c.body.id}`) : { status: 0 };
        check(`E a ${r} can add and publish questions`, c.status === 200 && e.status === 200, JSON.stringify([c.status, e.status]));
        check(`E a ${r} cannot delete (403) and the question survives`, d.status === 403 && !!(await one('SELECT id FROM faqs WHERE id = ?', [c.body && c.body.id])), d.status);
    }
    const del = await api('DELETE', `/api/admin/faqs/${pay1.body.id}`);
    check('E an administrator deletes; it leaves the website and is audited', del.status === 200 && !(await publicList()).some((f) => f.id === pay1.body.id)
        && (await q(`SELECT 1 FROM audit_log WHERE table_name = 'faqs' AND record_id = ? AND action = 'delete'`, [pay1.body.id])).length === 1, del.status);
    check('E deleting it again is a 404', (await api('DELETE', `/api/admin/faqs/${pay1.body.id}`)).status === 404);
    check('E a non-numeric id is a 404', (await api('PUT', '/api/admin/faqs/abc', { status: 'active' })).status === 404);

    // ── F. Homepage Sections switch ────────────────────────────────────────────────────────────────────────────────────────────────
    const before = (await pub('GET', '/api/public/site-content')).body.sections || {};
    const off = await api('PUT', '/api/admin/site-content', { section_visibility: Object.assign({}, before, { faq: false }) });
    const offSite = (await pub('GET', '/api/public/site-content')).body.sections;
    check('F switching the FAQ section off: the admin is told, and the site hides it', off.status === 200 && (await adminView()).section_visible === false && offSite.faq === false, JSON.stringify(offSite));
    await api('PUT', '/api/admin/site-content', { section_visibility: before });
    check('F switching it back on is reflected', (await adminView()).section_visible === true);

    // tidy
    await api('DELETE', `/api/admin/faqs/${made.body.id}`); await api('DELETE', `/api/admin/faqs/${b2.body.id}`); await api('DELETE', `/api/admin/faqs/${g1.body.id}`);
    for (const r of await q(`SELECT id FROM faqs WHERE question LIKE ?`, [`${MARK}%`])) await api('DELETE', `/api/admin/faqs/${r.id}`);
};
