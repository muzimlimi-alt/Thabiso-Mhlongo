// "I am unable to view the generated quote on the live site": the admin screens (booking Files tab "Quote v1 - Active", the quote history
// list) linked straight to /docs/quotes/<file>.pdf, and the site deliberately refuses every /docs/ URL ("Forbidden: Direct access to this
// file/directory is restricted." - app.js), so the link could never open. Documents are served through authenticated routes only. Now:
//   A. every quote link the admin API hands out opens ITS OWN version's PDF through an authenticated route (v1 -> v1, v2 -> v2), and the
//      "current quote" route serves the CURRENT version (it used to serve whichever row SQLite returned first - the oldest);
//   B. the direct /docs/ block stays exactly as it was, and the new route is admin-only and confined to the booking in the URL;
//   C. no URL the server hands out (quote history, booking financials, the "quote sent" and "invoice generated" responses) is a blocked one.
//
// Date offsets 1320-1329 are reserved for this file (grep the WHOLE test folder before picking: service-visibility books through a helper,
// `mk(1200, ...)`, which a search for `future(` misses).
module.exports = async function ({ check, api, pub, one, q, future, sleep, apiBinary, getTrackingToken, extractPdfText, BASE }) {
    let seq = 0, day = 1320;
    const emails = new Map();
    const sClub = (await one("SELECT id FROM services WHERE name = 'Club – 10 min Set (Guest Spot)'")).id;   // fixed R5,000

    const manual = async (label) => {
        const email = `qdl.${Date.now()}.${seq++}@example.invalid`;
        const r = await api('POST', '/api/admin/bookings', {
            name: `QDL ${label}`, email, cell: '+27821234567', event_date: future(day++), event_name: `QDL ${label}`, event_type: 'Corporate', event_location: 'Quote Hall',
            message: 'Quote download integration test booking, over ten characters.', services: [{ service_id: sClub }], status: 'NEW', override_working_hours: true
        });
        if (r.body && r.body.booking_id) emails.set(r.body.booking_id, email);
        return r.body && r.body.booking_id;
    };
    const quote = async (id, price) => {
        const bk = await one('SELECT date FROM bookings WHERE id = ?', [id]);
        const expiry = new Date(Date.parse(bk.date) - 10 * 86400000).toISOString().slice(0, 10);
        return api('POST', `/api/admin/bookings/${id}/quote`, {
            quote_expiry_date: expiry, terms: 'Quote download terms apply.', apply_vat: false, discount: 0,
            items: [{ service_id: sClub, description: 'Club set', quantity: 1, unit_price: price, pricing_model: 'flat_fee' }]
        });
    };
    const isPdf = (d) => d.status === 200 && d.buffer.slice(0, 4).toString('latin1') === '%PDF';
    const text = (d) => extractPdfText(d.buffer).replace(/\s+/g, ' ');
    const history = async (id) => (await api('GET', `/api/admin/bookings/${id}/quote-history`)).body || [];

    // ═══ A. Every link opens its own version ═══
    const bA = await manual('versions');
    const r1 = await quote(bA, 5000);
    await sleep(1200);                                   // quote numbers resolve to the second
    const r2 = await quote(bA, 6500);
    const hist = await history(bA);                       // newest first
    const vNew = hist.find(x => x.version === 2), vOld = hist.find(x => x.version === 1);
    check('fixture: two quotation versions - v2 active, v1 superseded', r1.status === 200 && r2.status === 200 && hist.length === 2 && !!vNew && !!vOld && !vNew.archived && !!vOld.archived, JSON.stringify({ r1: r1.status, r2: r2.status, hist }));

    const dNew = await apiBinary('GET', vNew.pdf_url);
    const dOld = await apiBinary('GET', vOld.pdf_url);
    check('the link on the active quote (the Files tab chip) opens its PDF - not "Forbidden"', isPdf(dNew), `${vNew.pdf_url} -> ${dNew.status} ${dNew.buffer.toString('utf8', 0, 120)}`);
    check('...and it is v2: its quote number and R6,500.00', isPdf(dNew) && text(dNew).includes(vNew.quote_number) && /TOTAL AMOUNT R 6500\.00/.test(text(dNew)), isPdf(dNew) ? text(dNew).slice(0, 400) : '');
    check('the link on the superseded quote (the history list) opens ITS PDF: v1 and R5,000.00', isPdf(dOld) && text(dOld).includes(vOld.quote_number) && /TOTAL AMOUNT R 5000\.00/.test(text(dOld)), `${vOld.pdf_url} -> ${dOld.status}`);
    check('...served inline as a PDF, so it opens in the browser tab instead of being forced to download', /^application\/pdf/.test(dNew.contentType || '') && /^inline/i.test(dNew.disposition || ''), `${dNew.contentType} | ${dNew.disposition}`);

    const cur = await apiBinary('GET', `/api/admin/bookings/${bA}/quote/download`);
    check('the "current quote" download serves the CURRENT version (R6,500.00), not the oldest row it happened to find first',
        isPdf(cur) && text(cur).includes(vNew.quote_number) && /TOTAL AMOUNT R 6500\.00/.test(text(cur)), isPdf(cur) ? text(cur).slice(0, 300) : `${cur.status}`);

    // the client's own copy (the tracking page's "Download quote" button): it never depended on /docs/, and it serves the current quote
    const mine = await fetch(BASE + `/api/public/bookings/${bA}/quote/download`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ access_token: await getTrackingToken(bA, emails.get(bA)) })
    });
    const mineBuf = Buffer.from(await mine.arrayBuffer());
    check("the client's own quote download (tracking page) serves the current quote as well",
        mine.status === 200 && mineBuf.slice(0, 4).toString('latin1') === '%PDF' && /TOTAL AMOUNT R 6500\.00/.test(extractPdfText(mineBuf).replace(/\s+/g, ' ')), `${mine.status}`);

    // ═══ B. The /docs/ block stays; the new route is admin-only and confined to its booking ═══
    const row = await one('SELECT file_path FROM quotations WHERE id = ?', [vNew.id]);
    const direct = await apiBinary('GET', `/docs/quotes/${row.file_path}`);
    check('a direct /docs/quotes/ URL is still refused, exactly as before', direct.status === 403 && /Forbidden: Direct access/.test(direct.buffer.toString('utf8')), `${direct.status} ${direct.buffer.toString('utf8', 0, 100)}`);

    const bB = await manual('other booking');
    await quote(bB, 5000);
    const otherQuote = (await history(bB))[0];
    const cross = await apiBinary('GET', `/api/admin/bookings/${bA}/quote/${otherQuote.id}/download`);
    check("another booking's quotation cannot be fetched through this booking's URL (404)", cross.status === 404 && cross.buffer.slice(0, 4).toString('latin1') !== '%PDF', `${cross.status}`);
    const junk = await apiBinary('GET', `/api/admin/bookings/${bA}/quote/not-a-number/download`);
    check('a malformed quotation id is refused, not an error page (404)', junk.status === 404, `${junk.status}`);
    const anon = await pub('GET', vNew.pdf_url);
    check('the route is for signed-in admins only - an anonymous request gets no PDF', anon.status !== 200 && [301, 302, 303, 307, 401, 403].includes(anon.status), `${anon.status}`);

    // ═══ C. Nothing the server hands out is a blocked URL ═══
    check('the quote-sent response gives a working link', !!r2.body.pdfUrl && !/^\/docs\//.test(r2.body.pdfUrl), String(r2.body.pdfUrl));
    const dSent = r2.body.pdfUrl ? await apiBinary('GET', r2.body.pdfUrl) : { status: 0, buffer: Buffer.alloc(0) };
    check('...and it opens the PDF that was just generated (v2, R6,500.00)', isPdf(dSent) && /TOTAL AMOUNT R 6500\.00/.test(text(dSent)), `${r2.body.pdfUrl} -> ${dSent.status}`);

    await sleep(1200);
    const token = async (id) => getTrackingToken(id, emails.get(id));
    const acc = await pub('POST', `/api/public/bookings/${bB}/accept-quote`, { access_token: await token(bB), terms_agreed: true, installment_count: 2 });
    const gen = await api('POST', `/api/admin/bookings/${bB}/invoice/generate`, {});
    check('the invoice-generated response gives a working link', acc.status === 200 && gen.status === 200 && !!gen.body.pdfUrl && !/^\/docs\//.test(gen.body.pdfUrl), `${acc.status}/${gen.status} ${gen.body && gen.body.pdfUrl}`);
    const dInv = gen.body && gen.body.pdfUrl ? await apiBinary('GET', gen.body.pdfUrl) : { status: 0, buffer: Buffer.alloc(0) };
    check('...and it opens the invoice PDF', isPdf(dInv) && /INV-/.test(text(dInv)), `${gen.body && gen.body.pdfUrl} -> ${dInv.status}`);

    const fin = (await api('GET', `/api/admin/bookings/${bB}/financials`)).body || {};
    const fq = fin.quote && fin.quote.pdf_url ? await apiBinary('GET', fin.quote.pdf_url) : { status: 0, buffer: Buffer.alloc(0) };
    const fi = fin.invoice && fin.invoice.pdf_url ? await apiBinary('GET', fin.invoice.pdf_url) : { status: 0, buffer: Buffer.alloc(0) };
    check("the booking's financials give working links to its quote and its live invoice", isPdf(fq) && isPdf(fi) && /QT-/.test(text(fq)) && /INV-/.test(text(fi)), JSON.stringify({ q: fin.quote && fin.quote.pdf_url, i: fin.invoice && fin.invoice.pdf_url, qs: fq.status, is: fi.status }));
};
