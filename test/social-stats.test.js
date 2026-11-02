// lib/social-stats.js: the real upload date, channel and view count shown on the public Social cards.
// No network, no database: the platform pages are faked and the "save" is a spy, so every case is exact.
const J = JSON.stringify;

const YT_PAGE = (o) => `<html><script>var x = {"videoDetails":{"viewCount":"${o.views}","author":"${o.author}"},` +
    `"microformat":{"playerMicroformatRenderer":{"uploadDate":"${o.date}","publishDate":"${o.date}"}}};</script></html>`;
const okText = (t) => async () => ({ ok: true, status: 200, text: async () => t });
const failing = async () => ({ ok: false, status: 429, text: async () => '' });

const row = (id, platform, code, meta) => ({ id, platform_name: platform, embed_code: code, metadata: meta === undefined ? '' : J(meta) });
const YT_CODE = '<iframe src="https://www.youtube.com/embed/QwN-SlsemXQ"></iframe>';

module.exports = async function ({ check }) {
    let S;
    try { S = require('../lib/social-stats'); } catch (e) { check('social-stats: module loads', false, e.stack); return; }

    // Added on 12 March 2026 with no API key: today's date as "publishDate" and 0 views (what the admin used to save).
    const stored = { title: 'T', channelName: 'MacG', publishDate: '2026-03-12T15:11:07.581Z', viewCount: 0, thumbnail: 'x' };

    // ══════════ YouTube ══════════
    {
        const saved = [];
        const r = await S.refreshEmbed(row(3, 'YouTube', YT_CODE, stored), {
            fetchFn: okText(YT_PAGE({ views: 354554, author: 'MacG', date: '2025-03-13T06:00:07-07:00' })),
            save: async (id, m) => { saved.push([id, m]); }
        });
        const m = JSON.parse(r.metadata);
        check('YouTube: the real upload date replaces the day the embed was added', m.publishDate === '2025-03-13T13:00:07.000Z', m.publishDate);
        check('YouTube: the view count is stored', m.viewCount === 354554, String(m.viewCount));
        check('YouTube: other stored fields (title, thumbnail) are untouched', m.title === 'T' && m.thumbnail === 'x', J(m));
        check('YouTube: it is saved against the right embed and stamped as fetched', saved.length === 1 && saved[0][0] === 3 && !!saved[0][1].statsFetchedAt, J(saved));
    }
    {
        const r = await S.refreshEmbed(row(3, 'YouTube', YT_CODE, stored), {
            fetchFn: okText(YT_PAGE({ views: 1, author: 'Caf\\u00e9 \\"Live\\"', date: '2025-01-09T05:00:06-08:00' })), save: async () => {}
        });
        check('YouTube: a channel name with JSON escapes (accent, quotes) is decoded', JSON.parse(r.metadata).channelName === 'Café "Live"', JSON.parse(r.metadata).channelName);
    }
    {
        let saves = 0;
        const r = await S.refreshEmbed(row(3, 'YouTube', YT_CODE, stored), { fetchFn: failing, save: async () => { saves++; } });
        check('YouTube blocked / failing: the stored row comes back unchanged, nothing is written, no throw', r.metadata === J(stored) && saves === 0, r.metadata);
        const r2 = await S.refreshEmbed(row(3, 'YouTube', YT_CODE, stored), { fetchFn: okText('<html>no data here</html>'), save: async () => { saves++; } });
        check('YouTube page without the data (layout change): nothing is written', r2.metadata === J(stored) && saves === 0, '');
        const r3 = await S.refreshEmbed(row(3, 'YouTube', YT_CODE, stored), { fetchFn: async () => { throw new Error('boom'); }, save: async () => { saves++; } });
        check('YouTube network error: swallowed, row unchanged', r3.metadata === J(stored) && saves === 0, '');
    }

    // ══════════ Vimeo and the platforms with nothing public ══════════
    {
        const body = J({ upload_date: '2023-05-04 10:30:00', author_name: 'A Studio' });
        const r = await S.refreshEmbed(row(5, 'Vimeo', 'https://vimeo.com/123456', { viewCount: 0 }), { fetchFn: okText(body), save: async () => {} });
        const m = JSON.parse(r.metadata);
        check('Vimeo: upload date and channel from oEmbed; no invented view count', m.publishDate === '2023-05-04T10:30:00.000Z' && m.channelName === 'A Studio' && m.viewCount === 0, J(m));
    }
    {
        let calls = 0;
        const fetchFn = async () => { calls++; return { ok: true, text: async () => '' }; };
        for (const p of ['TikTok', 'Facebook', 'Instagram']) await S.refreshEmbed(row(9, p, 'https://example.com/x', stored), { fetchFn, save: async () => {} });
        check('TikTok / Facebook / Instagram: never looked up (nothing public to read)', calls === 0, String(calls));
        check('lookupFor: a YouTube embed without a video id has no lookup', S.lookupFor(row(1, 'YouTube', '<iframe src="https://example.com"></iframe>'), fetch) === null, '');
    }

    // ══════════ merging and staleness ══════════
    {
        const m = S.mergeStats({ channelName: 'Keep', publishDate: '2024-01-01T00:00:00.000Z', viewCount: 5 }, { viewCount: 9 }, '2026-11-02T10:00:00.000Z');
        check('mergeStats: a value the platform did not give never erases a stored one', m.channelName === 'Keep' && m.publishDate === '2024-01-01T00:00:00.000Z' && m.viewCount === 9 && m.statsFetchedAt === '2026-11-02T10:00:00.000Z', J(m));
        const NOW = Date.parse('2026-11-02T12:00:00Z');
        check('isStale: never fetched = stale; 5 h old = fresh; 7 h old = stale',
            S.isStale({}, NOW) && S.isStale(null, NOW) && !S.isStale({ statsFetchedAt: '2026-11-02T07:00:00Z' }, NOW) && S.isStale({ statsFetchedAt: '2026-11-02T05:00:00Z' }, NOW), '');
    }

    // ══════════ the public list ══════════
    {
        const saves = [];
        const rows = [
            row(1, 'YouTube', YT_CODE, stored), // never fetched: waited for, so the first visitor sees the real date
            row(2, 'YouTube', YT_CODE, Object.assign({}, stored, { statsFetchedAt: '2026-11-02T11:00:00Z', viewCount: 77 })), // fresh: untouched
            row(3, 'TikTok', 'https://tiktok.com/x', stored)
        ];
        const out = await S.enrichEmbeds(rows, {
            now: Date.parse('2026-11-02T12:00:00Z'),
            fetchFn: okText(YT_PAGE({ views: 500, author: 'MacG', date: '2025-03-13T06:00:07-07:00' })),
            save: async (id, m) => { saves.push(id); }
        });
        check('enrichEmbeds: a never-fetched embed comes back with the real views and date',
            JSON.parse(out[0].metadata).viewCount === 500 && JSON.parse(out[0].metadata).publishDate.startsWith('2025-03-13'), out[0].metadata);
        check('enrichEmbeds: a fresh embed and a TikTok are returned as stored, and only the first was saved', out[1] === rows[1] && out[2] === rows[2] && saves.join() === '1', saves.join());
    }
};
