// "Stored text" - the database holds user text entity-encoded once ("Tom &amp; Jerry&#x27;s", app.js deepEscapeBody).
// That form is right only for markup injected as HTML; every other consumer must decode it (lib/html-sanitize.js
// explains). Before this suite's fixes: client emails said "Hi O&#x27;Brien &amp; Sons", quotes/invoices printed
// "MC &amp; Host &quot;Premium&quot;", admin replies went out as literal "<p>…</p>" tags with "Re: Tom &amp; Jerry"
// subjects, and every admin edit of a highlight/testimonial/event stacked another encoding layer.
//
//   1. the helpers   2. the write boundary (JSON + multipart)   3. rich text kept raw   4. emails   5. PDFs
//   6. SMTP subject + Google Calendar (in an isolated child process, both stubbed)   7. the boot repair
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const sqlite3 = require('sqlite3');
const support = require('./support');
const { decodeStoredText, decodeStoredDeep, normalizeEncodedText, normalizeBodyFields, encodeEntities } = require('../lib/html-sanitize');
const { escapeEmailHtml } = require('../lib/email-escape');
const emailComponents = require('../js/emailComponents');

const rw = new sqlite3.Database(support.TEST_DB);
const run = (sql, params = []) => new Promise((res, rej) => rw.run(sql, params, function (e) { e ? rej(e) : res(this); }));

const RAW = 'Tom\'s "big" & <b>x</b>';
const ONCE = encodeEntities(RAW);
const STACKED = encodeEntities(encodeEntities(ONCE));

module.exports = async function ({ check, api, pub, one, q, future, sleep, apiBinary, extractPdfText, loginAs }) {
    // ══════════ 1. the helpers ══════════
    check('decodeStoredText: one layer, three layers and raw text all give the same plain text', decodeStoredText(ONCE) === RAW && decodeStoredText(STACKED) === RAW && decodeStoredText(RAW) === RAW, decodeStoredText(STACKED));
    check('decodeStoredText: null/undefined pass through, empty stays empty', decodeStoredText(null) === null && decodeStoredText(undefined) === undefined && decodeStoredText('') === '', '');
    check('decodeStoredDeep decodes every string in nested objects and arrays, and leaves numbers/null alone',
        JSON.stringify(decodeStoredDeep({ a: ONCE, n: 3, z: null, l: [{ s: STACKED }, 'plain'] })) === JSON.stringify({ a: RAW, n: 3, z: null, l: [{ s: RAW }, 'plain'] }), JSON.stringify(decodeStoredDeep({ a: ONCE })));
    check('normalizeEncodedText is idempotent across raw / once / stacked input', [RAW, ONCE, STACKED].every(v => normalizeEncodedText(v) === ONCE) && normalizeEncodedText(normalizeEncodedText(STACKED)) === ONCE, '');
    const body = { name: RAW, note: STACKED, untouched: RAW, n: 5 };
    normalizeBodyFields(['name', 'note', 'missing', 'n'])({ body }, {}, () => {});
    check('normalizeBodyFields normalises only the named string fields', body.name === ONCE && body.note === ONCE && body.untouched === RAW && body.n === 5, JSON.stringify(body));
    check('escapeEmailHtml decodes the stored form first (no "&amp;#x27;") and is idempotent',
        escapeEmailHtml('O&#x27;Brien &amp; Sons') === "O'Brien &amp; Sons" && escapeEmailHtml(escapeEmailHtml('A & <b> "q"')) === 'A &amp; &lt;b&gt; &quot;q&quot;', escapeEmailHtml('O&#x27;Brien &amp; Sons'));
    const premium = emailComponents.renderPremiumEmail({ preheaderText: 'p', headline: 'Hi O&#x27;Brien &amp; Sons', bodyHtml: '' });
    check('the premium email components decode stored text before escaping it', !/&amp;#x27;|&amp;amp;/.test(premium) && /O&#39;Brien &amp; Sons/.test(premium), (premium.match(/Hi O[^<]{0,30}/) || [''])[0]);

    // ══════════ 2. the write boundary ══════════
    // JSON create (encoded once by deepEscapeBody), then a client that echoes the stored text straight back
    // (what an admin editor that loads encoded text into its boxes does) must not add a layer.
    const t = await api('POST', '/api/admin/testimonials', { name: RAW, designation: RAW, quote: RAW });
    const tid = t.body.id;
    const tGet = async () => (await api('GET', '/api/admin/testimonials')).body.find(r => r.id === tid);
    let tRow = await tGet();
    check('JSON create stores one layer', tRow && tRow.name === ONCE && tRow.quote === ONCE, JSON.stringify(tRow));
    await api('PUT', `/api/admin/testimonials/${tid}`, { name: tRow.name, designation: tRow.designation, quote: tRow.quote });
    await api('PUT', `/api/admin/testimonials/${tid}`, { name: (await tGet()).name, designation: (await tGet()).designation, quote: (await tGet()).quote });
    tRow = await tGet();
    check('echoing the stored text back twice (an old editor) adds no layer', tRow.name === ONCE && tRow.designation === ONCE && tRow.quote === ONCE, JSON.stringify(tRow));
    await api('PUT', `/api/admin/testimonials/${tid}`, { name: STACKED, designation: ONCE, quote: RAW });
    tRow = await tGet();
    check('stacked or raw input is collapsed to one layer on save', tRow.name === ONCE && tRow.designation === ONCE && tRow.quote === ONCE, JSON.stringify(tRow));
    await api('DELETE', `/api/admin/testimonials/${tid}`);

    // Multipart create (the admin UI's create path) skips deepEscapeBody - it used to store the RAW text.
    const cookie = (await fetch(support.BASE + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'test.runner@example.invalid', password: 'TestRunnerPass1!' }) })).headers.get('set-cookie').split(';')[0];
    const multipart = async (url, fields) => { const fd = new FormData(); for (const [k, v] of Object.entries(fields)) fd.append(k, v); const r = await fetch(support.BASE + url, { method: 'POST', headers: { Cookie: cookie }, body: fd }); return (await r.json()); };
    const mt = await multipart('/api/admin/testimonials', { name: RAW, designation: RAW, quote: RAW });
    const mtRow = await one('SELECT name, designation, quote FROM testimonials WHERE id = ?', [mt.id]);
    check('multipart testimonial create stores one layer, not raw text', mtRow && mtRow.name === ONCE && mtRow.designation === ONCE && mtRow.quote === ONCE, JSON.stringify(mtRow));
    const mg = await multipart('/api/admin/gallery', { title: RAW, fallback_url: 'images/gallery/x.jpg', uploader_name: RAW, location: RAW });
    const mgRow = await one('SELECT title, uploader_name, location FROM gallery_images WHERE id = ?', [mg.id]);
    check('multipart gallery create stores one layer, not raw text', mgRow && mgRow.title === ONCE && mgRow.uploader_name === ONCE && mgRow.location === ONCE, JSON.stringify(mgRow));
    const mf = await multipart('/api/admin/footprint', { country_name: RAW, fallback_url: 'images/footprint/x.png' });
    const mfRow = await one('SELECT country_name FROM footprint_countries WHERE id = ?', [mf.id]);
    check('multipart footprint create stores one layer, not raw text', mfRow && mfRow.country_name === ONCE, JSON.stringify(mfRow));
    await api('DELETE', `/api/admin/testimonials/${mt.id}`); await api('DELETE', `/api/admin/gallery/${mg.id}`); await api('DELETE', `/api/admin/footprint/${mf.id}`);

    // Events: the same echo cycle through the other admin editor that loads stored text into its boxes.
    const ev = await api('POST', '/api/admin/events', { event_title: RAW, event_description: RAW, event_datetime: `${future(500)}T18:00`, event_type: 'Corporate Event', venue_name: RAW, ticket_sales_link: 'https://t.example.test/e?a=1&b=2', status: 'upcoming' });
    const evId = ev.body.event_id || (ev.body.event && ev.body.event.event_id) || ev.body.id;
    const evRow = async () => one('SELECT event_title, event_description, venue_name, ticket_sales_link FROM events WHERE event_id = ?', [evId]);
    let e1 = await evRow();
    check('event create stores one layer (incl. a URL with & in it)', e1 && e1.event_title === ONCE && e1.venue_name === ONCE && e1.ticket_sales_link === 'https://t.example.test/e?a=1&amp;b=2', JSON.stringify(e1));
    for (let i = 0; i < 2; i++) { const cur = await evRow(); await api('PUT', `/api/admin/events/${evId}`, { event_title: cur.event_title, event_description: cur.event_description, event_datetime: `${future(500)}T18:00`, event_type: 'Corporate Event', venue_name: cur.venue_name, ticket_sales_link: cur.ticket_sales_link }); }
    e1 = await evRow();
    check('echoing an event back twice adds no layer', e1.event_title === ONCE && e1.event_description === ONCE && e1.venue_name === ONCE && e1.ticket_sales_link === 'https://t.example.test/e?a=1&amp;b=2', JSON.stringify(e1));
    await api('DELETE', `/api/admin/events/${evId}`);

    // ══════════ 3. rich text stays HTML ══════════
    const HTML = '<p>Hello <b>World</b> &amp; co</p><script>alert(1)</script><p onclick="x()">tail</p>';
    const de = await api('POST', '/api/admin/direct-emails', { to_emails: 'someone@example.invalid', subject: "Tom & Jerry's", body: HTML, status: 'draft' });
    const deId = de.body.email.id;
    const deRow = await one('SELECT subject, body FROM direct_emails WHERE id = ?', [deId]);
    check('a direct email body is stored as real HTML (not "&lt;p&gt;…"), with scripts and handlers stripped', deRow.body.startsWith('<p>Hello <b>World</b> &amp; co</p>') && !/<script|onclick/i.test(deRow.body) && !/&lt;p&gt;/.test(deRow.body), deRow.body);
    check('...while its subject (plain text) keeps the stored single-layer form', deRow.subject === 'Tom &amp; Jerry&#x27;s', deRow.subject);
    await api('PUT', `/api/admin/direct-emails/${deId}`, { to_emails: 'someone@example.invalid', subject: deRow.subject, body: deRow.body, status: 'draft' });
    const deRow2 = await one('SELECT subject, body FROM direct_emails WHERE id = ?', [deId]);
    check('saving the draft again (Quill hands back the stored HTML) changes nothing', deRow2.body === deRow.body && deRow2.subject === deRow.subject, JSON.stringify(deRow2));
    const prev = await api('POST', '/api/admin/direct-emails/preview', { body: HTML, subject: 'x' });
    check('the preview renders the HTML, not literal tags', prev.body.success && prev.body.html.includes('<b>World</b>') && !prev.body.html.includes('&lt;b&gt;World'), (prev.body.html || '').slice(0, 80));

    const legalType = (await q('SELECT document_type FROM legal_documents'))[0].document_type;
    const lg = await api('POST', `/api/admin/legal/documents/${legalType}/draft`, { content_html: '<h5>1. Intro</h5><p>We use <b>cookies</b> &amp; more</p><script>alert(1)</script>', change_summary: 'stored-text test' });
    const lgRow = await one('SELECT content_html FROM legal_document_versions WHERE version_number = ? ORDER BY id DESC', [lg.body.version.version_number]);
    check('a legal document draft is stored as real HTML, scripts stripped', lgRow.content_html.startsWith('<h5>1. Intro</h5><p>We use <b>cookies</b> &amp; more</p>') && !/<script/i.test(lgRow.content_html), lgRow.content_html);
    await run('DELETE FROM legal_document_versions WHERE version_number = ? AND is_published = 0', [lg.body.version.version_number]);

    // ══════════ 4. emails (the notifications queue records exactly what would be sent) ══════════
    const queued = async (recipient, subjectLike) => {
        const row = await one("SELECT subject, body FROM notifications WHERE type='email' AND recipient_email = ? AND subject LIKE ? ORDER BY id DESC LIMIT 1", [recipient, subjectLike]);
        let html = ''; try { html = JSON.parse(row.body).htmlContent || ''; } catch (e) {}
        return { subject: row && row.subject, html };
    };
    const em = `st.${Date.now()}@example.invalid`;
    const NAME = "O'Brien & Sons", EVENT = "Tom & Jerry's \"Show\"";
    const bk = await pub('POST', '/api/public/bookings', { name: NAME, email: em, cell: '+27821234567', event_date: future(70), event_name: EVENT, event_location: 'Hall & Garden', event_type: 'Corporate', message: 'It\'s a "big" night & more.', services: [{ service_id: 15 }], popia_consent: true });
    check('public booking with apostrophes/ampersands/quotes is accepted', bk.status === 200 && bk.body.success, JSON.stringify(bk.body));
    let confirm = null;
    for (let i = 0; i < 20 && !confirm; i++) { const r = await one("SELECT body FROM notifications WHERE type='email' AND recipient_email = ? ORDER BY id DESC LIMIT 1", [em]); if (r) { try { confirm = JSON.parse(r.body).htmlContent; } catch (e) {} } if (!confirm) await sleep(250); }
    check('the client confirmation says "Hi O\'Brien & Sons" - one decode of the HTML source, no "&#x27;" / "&amp;amp;" junk', !!confirm && /Hi O(&#39;|')Brien &amp; Sons/.test(confirm) && !/&amp;(#x27|#39|amp|quot);/.test(confirm), (confirm || '').replace(/<[^>]+>/g, '|').match(/Hi O[^|]{0,40}/));
    const adminMail = await one("SELECT body FROM notifications WHERE type='email' AND subject LIKE 'NEW BOOKING REQUEST%' ORDER BY id DESC LIMIT 1");
    const adminHtml = JSON.parse(adminMail.body).htmlContent;
    check('the admin notification shows the names/event once-decoded too', /O(&#39;|')Brien &amp; Sons/.test(adminHtml) && /Tom &amp; Jerry(&#39;|')s &quot;Show&quot;/.test(adminHtml) && !/&amp;(#x27|#39|amp|quot);/.test(adminHtml), (adminHtml.replace(/<[^>]+>/g, '|').match(/Tom[^|]{0,40}/) || [''])[0]);

    const bkId = (await one('SELECT id FROM bookings WHERE email = ? ORDER BY id DESC', [em])).id;
    await api('POST', `/api/admin/direct-emails/${deId}/send`, {});
    const rs = await api('POST', `/api/admin/bookings/${bkId}/respond`, { email: em, subject: "Re: Tom & Jerry's", message: '<p>Thanks, <strong>see you</strong> &amp; enjoy</p>' });
    check('POST /respond succeeds', rs.status === 200 && rs.body.success, JSON.stringify(rs.body));
    let direct = null, respond = null;
    for (let i = 0; i < 20 && !(direct && respond); i++) { await sleep(250); direct = (await one("SELECT body FROM notifications WHERE type='email' AND recipient_email = ? AND body LIKE '%Hello%' ORDER BY id DESC LIMIT 1", ['someone@example.invalid'])); respond = (await one("SELECT body FROM notifications WHERE type='email' AND recipient_email = ? AND body LIKE '%see you%' ORDER BY id DESC LIMIT 1", [em])); }
    const directHtml = direct && JSON.parse(direct.body).htmlContent, respondHtml = respond && JSON.parse(respond.body).htmlContent;
    check('a sent direct email carries real HTML ( <b>World</b> ), not literal tags', !!directHtml && directHtml.includes('<b>World</b>') && !directHtml.includes('&lt;b&gt;World'), (directHtml || '').slice(0, 80));
    check('a booking reply carries real HTML ( <strong>see you</strong> ), not literal tags', !!respondHtml && respondHtml.includes('<strong>see you</strong>') && !respondHtml.includes('&lt;strong&gt;'), (respondHtml || '').slice(0, 80));
    await api('DELETE', `/api/admin/direct-emails/${deId}`);

    // ══════════ 5. PDFs ══════════
    const pdfEm = `st.pdf.${Date.now()}@example.invalid`;
    const pb = await api('POST', '/api/admin/bookings', { name: NAME, company: 'Tom & Jerry "Ltd"', email: pdfEm, cell: '+27821234567', event_date: future(210), event_name: EVENT, event_type: 'Corporate', event_location: 'Hall & Garden', message: 'x'.repeat(20), services: [{ service_id: 15 }], status: 'NEW', override_working_hours: true });
    const pid = pb.body.booking_id; await sleep(80);
    const pdate = (await one('SELECT date FROM bookings WHERE id=?', [pid])).date;
    await api('POST', `/api/admin/bookings/${pid}/quote`, { quote_expiry_date: new Date(Date.parse(pdate) - 10 * 86400000).toISOString().slice(0, 10), terms: 'T', apply_vat: false, discount: 0, items: [{ service_id: 15, description: 'MC & Host "Premium"', quantity: 1, unit_price: 1000 }] });
    const dl = await apiBinary('GET', `/api/admin/bookings/${pid}/quote/download`);
    const pdfText = extractPdfText(dl.buffer);
    check('the quote PDF prints the client, company and line item as typed', pdfText.includes("O'Brien & Sons") && pdfText.includes('Tom & Jerry "Ltd"') && pdfText.includes('MC & Host "Premium"'), pdfText.slice(0, 160));
    check('...with no entity text anywhere in it', !/&(amp|lt|gt|quot|#x27|#39);/.test(pdfText), (pdfText.match(/.{0,20}&(amp|quot|#x27);.{0,20}/) || [''])[0]);

    // ══════════ 6. SMTP subject and Google Calendar (isolated child, both stubbed) ══════════
    const tmpDb = path.join(os.tmpdir(), `stored-text-${process.pid}-${Date.now()}.sqlite`);
    const child = spawnSync(process.execPath, [path.join(__dirname, 'stored-text.child.js')], { env: { ...process.env, DB_PATH: tmpDb, NODE_ENV: 'test', R2_ENDPOINT: '', R2_BUCKET: '', R2_ACCESS_KEY_ID: '', R2_SECRET_ACCESS_KEY: '', GOOGLE_REFRESH_TOKEN: 'test-mode-invalid-refresh-token', SMTP_MOCK: 'false', EMAIL_OVERHAUL_ENABLED: '' }, encoding: 'utf8', timeout: 60000 });
    for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + suffix); } catch (e) {} }
    const line = (child.stdout || '').split('\n').find(l => l.startsWith('RESULT:'));
    check('the stubbed child ran (SMTP + Google Calendar captured)', !!line, (child.stdout || '') + (child.stderr || '').slice(-300));
    const out = line ? JSON.parse(line.slice(7)) : { sent: [], events: [] };
    const mail = out.sent[0] || {}, cal = out.events[0] || {};
    check('the SMTP subject header is plain text ("Re: Tom & Jerry\'s \\"quote\\""), not the stored entities', mail.subject === 'Re: Tom & Jerry\'s "quote"', JSON.stringify(mail.subject));
    check('the text/plain part of an email has real characters, not entities', /O'Brien & Sons <3/.test(mail.text || ''), JSON.stringify(mail.text));
    check('the Google Calendar event (location, description) is plain text', cal.location === "Tom & Jerry's Hall" && /Client: O'Brien & Sons/.test(cal.description || '') && /Notes: Bring "the A-team" & more/.test(cal.description || ''), JSON.stringify(cal));

    // ══════════ 7. boot repair of rich text that was saved entity-encoded ══════════
    const legacyEmail = await run("INSERT INTO direct_emails (to_emails, subject, body, status) VALUES ('[\"x@example.invalid\"]', 'legacy', ?, 'draft')", [encodeEntities('<p>Hi <b>there</b></p>')]);
    const goodEmail = await run("INSERT INTO direct_emails (to_emails, subject, body, status) VALUES ('[\"x@example.invalid\"]', 'ok', ?, 'draft')", ['<p>Already <b>HTML</b> &lt;3</p>']);
    await support.restart();
    let fixed = null;
    for (let i = 0; i < 20; i++) { fixed = await one('SELECT body FROM direct_emails WHERE id = ?', [legacyEmail.lastID]); if (fixed && fixed.body.startsWith('<p>')) break; await sleep(250); }
    check('boot repair turns an entity-encoded rich-text body back into HTML', fixed.body === '<p>Hi <b>there</b></p>', JSON.stringify(fixed));
    const good = await one('SELECT body FROM direct_emails WHERE id = ?', [goodEmail.lastID]);
    check('...and leaves a body that is already HTML (even one that contains "&lt;") untouched', good.body === '<p>Already <b>HTML</b> &lt;3</p>', JSON.stringify(good));
    for (const id of [legacyEmail.lastID, goodEmail.lastID]) await run('DELETE FROM direct_emails WHERE id = ?', [id]);
    rw.close();
};
