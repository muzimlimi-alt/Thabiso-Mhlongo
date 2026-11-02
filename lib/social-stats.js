// Real upload date, channel name and view count for the video cards in the public "Social" section.
//
// The admin page saves an embed's metadata from the browser, and without a platform API key that metadata has no
// real date or views (the date used to be the day the embed was added). The server fills those in here:
//   YouTube  reads the public watch page (no API key needed): channel, upload date, view count.
//   Vimeo    reads the public oEmbed endpoint: channel and upload date (Vimeo shares no view count publicly).
//   Others   (TikTok, Facebook, Instagram) share nothing public beyond what the admin already stored, so are left alone.
// Results are written back into the embed's own `metadata` JSON (the same column the cards already read), so the
// site keeps working from the stored copy if a platform is slow or blocks us. Views change, so a stored copy is
// refreshed in the background when it is older than STALE_MS.
// (The database is required lazily, inside saveMeta, so the pure parts of this file can be tested without opening it.)

const STALE_MS = 6 * 60 * 60 * 1000;
const FIRST_FETCH_WAIT_MS = 5000;
const REQUEST_TIMEOUT_MS = 6000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const YT_ID_RE = /(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=|shorts\/))([\w-]{11})/;

// Tests and scratch runs must never reach the real platforms.
const disabled = () => process.env.SOCIAL_STATS_MOCK === 'true';

const inFlight = new Map();

function parseMeta(row) {
    try { return row.metadata ? JSON.parse(row.metadata) : null; } catch (e) { return null; }
}

function jsonUnescape(s) {
    try { return JSON.parse('"' + s + '"'); } catch (e) { return s; }
}

async function getText(url, fetchFn, headers) {
    const res = await fetchFn(url, { headers: headers || {}, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.text();
}

async function fetchYouTubeStats(videoId, fetchFn) {
    const html = await getText('https://www.youtube.com/watch?v=' + encodeURIComponent(videoId) + '&hl=en', fetchFn, {
        'user-agent': UA, 'accept-language': 'en-US,en;q=0.9', cookie: 'CONSENT=YES+1; SOCS=CAI'
    });
    const pick = (re) => { const m = html.match(re); return m ? m[1] : null; };
    const views = pick(/"viewCount":"(\d+)"/);
    const date = pick(/"uploadDate":"([^"]+)"/) || pick(/"publishDate":"([^"]+)"/);
    const author = pick(/"author":"((?:[^"\\]|\\.)+)"/);
    const out = {};
    if (views !== null) out.viewCount = parseInt(views, 10);
    if (date && !isNaN(new Date(date))) out.publishDate = new Date(date).toISOString();
    if (author) out.channelName = jsonUnescape(author);
    return Object.keys(out).length ? out : null;
}

async function fetchVimeoStats(url, fetchFn) {
    const body = await getText('https://vimeo.com/api/oembed.json?url=' + encodeURIComponent(url), fetchFn);
    const j = JSON.parse(body);
    const out = {};
    if (j.upload_date) {
        const d = new Date(String(j.upload_date).replace(' ', 'T') + 'Z');
        if (!isNaN(d)) out.publishDate = d.toISOString();
    }
    if (j.author_name) out.channelName = j.author_name;
    return Object.keys(out).length ? out : null;
}

// Which platform lookup applies to this embed, or null when there is nothing public to read.
function lookupFor(row, fetchFn) {
    const code = row.embed_code || '';
    if (row.platform_name === 'YouTube') {
        const m = code.match(YT_ID_RE);
        return m ? () => fetchYouTubeStats(m[1], fetchFn) : null;
    }
    if (row.platform_name === 'Vimeo') {
        const m = code.match(/vimeo\.com\/(?:video\/)?(\d+)/);
        return m ? () => fetchVimeoStats('https://vimeo.com/' + m[1], fetchFn) : null;
    }
    return null;
}

// Pure: the stored metadata with fresh values laid over it. A value the platform did not give never erases a stored one.
function mergeStats(meta, stats, nowIso) {
    const base = Object.assign({}, meta || {});
    if (stats) {
        if (stats.channelName) base.channelName = stats.channelName;
        if (stats.publishDate) base.publishDate = stats.publishDate;
        if (typeof stats.viewCount === 'number') base.viewCount = stats.viewCount;
    }
    base.statsFetchedAt = nowIso;
    return base;
}

function isStale(meta, now) {
    const t = meta && meta.statsFetchedAt ? Date.parse(meta.statsFetchedAt) : NaN;
    return isNaN(t) || (now - t) > STALE_MS;
}

function saveMeta(id, metaObj) {
    const db = require('../database');
    return new Promise((resolve, reject) => {
        db.run('UPDATE social_embeds SET metadata = ? WHERE id = ?', [JSON.stringify(metaObj), id], (err) => err ? reject(err) : resolve());
    });
}

// Look the embed up, write the result into its metadata and resolve with the updated row. Never rejects: on any failure
// the stored row is returned untouched (and statsFetchedAt is left alone so the next visit tries again).
function refreshEmbed(row, opts) {
    const o = opts || {};
    const fetchFn = o.fetchFn || fetch;
    if (disabled() && !o.fetchFn) return Promise.resolve(row);
    const lookup = lookupFor(row, fetchFn);
    if (!lookup) return Promise.resolve(row);
    if (inFlight.has(row.id)) return inFlight.get(row.id).then(() => row);
    const job = (async () => {
        try {
            const stats = await lookup();
            if (!stats) return row;
            const merged = mergeStats(parseMeta(row), stats, new Date().toISOString());
            await (o.save || saveMeta)(row.id, merged);
            return Object.assign({}, row, { metadata: JSON.stringify(merged) });
        } catch (e) {
            console.warn('[social-stats] could not refresh embed #' + row.id + ': ' + e.message);
            return row;
        } finally {
            inFlight.delete(row.id);
        }
    })();
    inFlight.set(row.id, job);
    return job;
}

// For the public list. A card that has never been looked up waits (briefly) so the first visitor already sees the real
// date; one that is merely stale is served as stored while a refresh runs in the background.
async function enrichEmbeds(rows, opts) {
    const o = opts || {};
    const now = o.now || Date.now();
    const out = await Promise.all(rows.map(async (row) => {
        if (!lookupFor(row, o.fetchFn || fetch)) return row;
        const meta = parseMeta(row);
        if (!isStale(meta, now)) return row;
        const work = refreshEmbed(row, o);
        if (meta && meta.statsFetchedAt) return row;
        return Promise.race([work, new Promise((r) => setTimeout(() => r(row), FIRST_FETCH_WAIT_MS))]);
    }));
    return out;
}

module.exports = { enrichEmbeds, refreshEmbed, mergeStats, isStale, lookupFor, STALE_MS };
