// Coverage for the Prompt-5 banner registry: CRUD, image validation (mime/size/width), template
// assignment, and the send-time resolver's active/archived/unassigned fallback behaviour.
const support = require('./support');
const { api, upload, one, makeTestPng } = support;

// The resolver holds its own 60s in-memory cache. It's required directly into THIS process (pointed
// at the same isolated TEST_DB the child server process writes to via WAL) so we can assert its
// actual resolution logic, not just the raw rows — but that means its cache is independent of the
// one the server process invalidates on write. Always invalidate before resolving in this file so
// every assertion reads current DB state rather than a stale in-process cache entry.
process.env.DB_PATH = support.TEST_DB;
const bannerRegistry = require('../js/bannerRegistry');
const resolve = (key) => { bannerRegistry.invalidateCache(); return bannerRegistry.resolveBanner(key); };

const png = (w, h, opts) => ({ buffer: makeTestPng(w, h, opts), filename: 'banner.png', contentType: 'image/png' });

module.exports = async function ({ check }) {
    // ── Rejection guards (each posted before a valid banner exists, so none can accidentally pass
    // because an earlier row already satisfies a check) ──
    const validFields = { name: 'Test Banner', category: 'Booking Confirmations', alt_text: 'A test banner' };

    const rNoName = await upload('POST', '/api/admin/banners', { ...validFields, name: '' }, png(1300, 60));
    check('reject: missing name -> 400', rNoName.status === 400 && !rNoName.body.success, JSON.stringify(rNoName.body));

    const rBadCategory = await upload('POST', '/api/admin/banners', { ...validFields, category: 'Not A Real Category' }, png(1300, 60));
    check('reject: invalid category -> 400', rBadCategory.status === 400 && /category/i.test(rBadCategory.body.message), rBadCategory.body && rBadCategory.body.message);

    const rNoAlt = await upload('POST', '/api/admin/banners', { ...validFields, alt_text: '' }, png(1300, 60));
    check('reject: missing alt_text -> 400', rNoAlt.status === 400 && /alt text/i.test(rNoAlt.body.message), rNoAlt.body && rNoAlt.body.message);

    const rBadMime = await upload('POST', '/api/admin/banners', validFields, { buffer: Buffer.from('not an image'), filename: 'evil.gif', contentType: 'image/gif' });
    check('reject: wrong mime/extension -> 400', rBadMime.status === 400 && /JPG or PNG/i.test(rBadMime.body.message), rBadMime.body && rBadMime.body.message);

    const rCorrupt = await upload('POST', '/api/admin/banners', validFields, { buffer: Buffer.from([1, 2, 3, 4, 5]), filename: 'corrupt.png', contentType: 'image/png' });
    check('reject: corrupt PNG bytes -> 400 (image-size parse failure)', rCorrupt.status === 400 && /corrupt/i.test(rCorrupt.body.message), rCorrupt.body && rCorrupt.body.message);

    const rTooBig = await upload('POST', '/api/admin/banners', validFields, png(1300, 40, { random: true }));
    check('reject: >100KB -> 400 with size in message', rTooBig.status === 400 && /100KB/.test(rTooBig.body.message), rTooBig.body && rTooBig.body.message);

    const rTooNarrow = await upload('POST', '/api/admin/banners', validFields, png(999, 60));
    check('reject: width 999px (too narrow) -> 400 with width in message', rTooNarrow.status === 400 && /999px/.test(rTooNarrow.body.message), rTooNarrow.body && rTooNarrow.body.message);

    const rTooWide = await upload('POST', '/api/admin/banners', validFields, png(1500, 60));
    check('reject: width 1500px (too wide) -> 400 with width in message', rTooWide.status === 400 && /1500px/.test(rTooWide.body.message), rTooWide.body && rTooWide.body.message);

    // ── Create (valid path) ──
    const created = await upload('POST', '/api/admin/banners',
        { name: 'Guard Banner', category: 'Booking Confirmations', alt_text: 'Guard banner alt text', headline: 'Guard Headline', subtitle: 'Guard Subtitle' },
        png(1300, 60));
    check('create: 1300px/<100KB PNG -> 200 with active banner row',
        created.status === 200 && created.body.success && created.body.banner && created.body.banner.status === 'active' && created.body.banner.image_url.startsWith('/images/banners/'),
        JSON.stringify(created.body));
    const bannerId = created.body && created.body.banner && created.body.banner.id;

    if (bannerId) {
        // ── List: paginated envelope, usage_count starts at 0 ──
        const listRes = await api('GET', `/api/admin/banners?category=${encodeURIComponent('Booking Confirmations')}`);
        check('list: paginated envelope shape', listRes.status === 200 && listRes.body.success && Array.isArray(listRes.body.banners) && typeof listRes.body.total === 'number' && typeof listRes.body.pages === 'number', JSON.stringify(listRes.body).slice(0, 150));
        const listed = listRes.body.banners.find(b => b.id === bannerId);
        check('list: created banner present with usage_count 0', !!listed && listed.usage_count === 0, JSON.stringify(listed));

        // ── Get one: used_by empty before assignment ──
        const getRes = await api('GET', `/api/admin/banners/${bannerId}`);
        check('get: banner + empty used_by before assignment', getRes.status === 200 && getRes.body.success && Array.isArray(getRes.body.used_by) && getRes.body.used_by.length === 0, JSON.stringify(getRes.body));

        // ── Update: metadata-only (no new image) leaves image_url unchanged ──
        const updRes = await upload('PUT', `/api/admin/banners/${bannerId}`, { name: 'Guard Banner Renamed', subtitle: 'Updated subtitle' });
        check('update: metadata-only change, image unchanged',
            updRes.status === 200 && updRes.body.banner.name === 'Guard Banner Renamed' && updRes.body.banner.subtitle === 'Updated subtitle' && updRes.body.banner.image_url === created.body.banner.image_url,
            JSON.stringify(updRes.body));

        // ── Resolver: unassigned template_key resolves to null ──
        const beforeAssign = await resolve('booking_confirmed');
        check('resolve: unassigned template_key -> null', beforeAssign === null, JSON.stringify(beforeAssign));

        // ── Resolver: nonexistent template_key resolves to null ──
        const nonExistent = await resolve('does_not_exist_template_key');
        check('resolve: nonexistent template_key -> null', nonExistent === null, JSON.stringify(nonExistent));

        // ── Assign: reject unknown/inactive banner_id ──
        const rBadAssign = await api('PUT', '/api/admin/email-templates/assign', { template_keys: ['booking_confirmed'], banner_id: 999999 });
        check('assign: nonexistent banner_id -> 400', rBadAssign.status === 400 && /not found or not active/i.test(rBadAssign.body.message), JSON.stringify(rBadAssign.body));

        // ── Assign: valid banner to a real seeded template_key ──
        const templatesBefore = await api('GET', '/api/admin/email-templates');
        const hasSeededKey = templatesBefore.status === 200 && templatesBefore.body.success && templatesBefore.body.templates.some(t => t.template_key === 'booking_confirmed');
        check('email-templates: migration-seeded key present', hasSeededKey, JSON.stringify(templatesBefore.body).slice(0, 200));

        const assignRes = await api('PUT', '/api/admin/email-templates/assign', { template_keys: ['booking_confirmed'], banner_id: bannerId });
        check('assign: valid banner to template_key -> 200, updated 1', assignRes.status === 200 && assignRes.body.success && assignRes.body.updated === 1, JSON.stringify(assignRes.body));

        // ── Get one: used_by now includes the assigned template_key ──
        const getAfterAssign = await api('GET', `/api/admin/banners/${bannerId}`);
        check('get: used_by includes assigned template_key', getAfterAssign.status === 200 && getAfterAssign.body.used_by.some(u => u.template_key === 'booking_confirmed' && u.category === 'Booking Confirmations'), JSON.stringify(getAfterAssign.body.used_by));

        // ── List: usage_count now 1 ──
        const listRes2 = await api('GET', `/api/admin/banners?category=${encodeURIComponent('Booking Confirmations')}`);
        const listed2 = listRes2.body.banners.find(b => b.id === bannerId);
        check('list: usage_count now 1 after assignment', listed2 && listed2.usage_count === 1, JSON.stringify(listed2));

        // ── Resolver: assigned + active -> full shape, matches the banner's own fields ──
        const resolved = await resolve('booking_confirmed');
        check('resolve: assigned + active -> resolves with matching fields',
            !!resolved && resolved.alt === 'Guard banner alt text' && resolved.headline === 'Guard Headline' && resolved.subtitle === 'Updated subtitle' && resolved.src.endsWith(created.body.banner.image_url),
            JSON.stringify(resolved));

        // ── Archive: status flips, used_by_count reported, resolver now falls back to null ──
        const archiveRes = await api('PATCH', `/api/admin/banners/${bannerId}/archive`, {});
        check('archive: 200, status archived, used_by_count 1', archiveRes.status === 200 && archiveRes.body.status === 'archived' && archiveRes.body.used_by_count === 1, JSON.stringify(archiveRes.body));

        const resolvedAfterArchive = await resolve('booking_confirmed');
        check('resolve: archived banner -> null (bannerSlot text-headline fallback takes over)', resolvedAfterArchive === null, JSON.stringify(resolvedAfterArchive));

        // ── Restore: status flips back, resolver resolves again ──
        const restoreRes = await api('PATCH', `/api/admin/banners/${bannerId}/restore`, {});
        check('restore: 200, status active again', restoreRes.status === 200 && restoreRes.body.status === 'active', JSON.stringify(restoreRes.body));

        const resolvedAfterRestore = await resolve('booking_confirmed');
        check('resolve: restored banner -> resolves again', !!resolvedAfterRestore && resolvedAfterRestore.alt === 'Guard banner alt text', JSON.stringify(resolvedAfterRestore));

        // ── Unassign: bulk assign with banner_id:null -> resolver falls back to null again ──
        const unassignRes = await api('PUT', '/api/admin/email-templates/assign', { template_keys: ['booking_confirmed'], banner_id: null });
        check('unassign: banner_id null -> 200, updated 1', unassignRes.status === 200 && unassignRes.body.updated === 1, JSON.stringify(unassignRes.body));

        const resolvedAfterUnassign = await resolve('booking_confirmed');
        check('resolve: unassigned again -> null', resolvedAfterUnassign === null, JSON.stringify(resolvedAfterUnassign));

        const dbRow = await one('SELECT status FROM banners WHERE id = ?', [bannerId]);
        check('db: banner row still exists (archive/restore never hard-deletes)', !!dbRow && dbRow.status === 'active', JSON.stringify(dbRow));
    }
};
