// Official 2026 rate card (Thabiso_Mhlongo_Booking_Kit_2026.pdf, updated September 2026, valid until
// 31 December 2026) loaded into the existing `services` catalogue.
//
// - RATE_CARD is the data; applyOnce(db) is a RUN-ONCE migration (tracked in schema_migrations) so a
//   restart never overwrites fees the owner later edits in the admin.
// - Rows are matched by name (never by id — production ids differ from dev): first the new name, then
//   an explicit legacy name whose meaning is clearly the same service (`reuse`). Reused rows keep their
//   id, so every existing booking / quote / invoice relationship stays valid. Their stored prices are
//   untouched because those documents snapshot unit_price themselves.
// - Non-fixed prices (range / from / enquire / minimum) are NOT collapsed into one number:
//   default_price stays 0 and price_min / price_max / price_type / price_unit carry the real meaning.
//   Nothing may treat a range's min, max or midpoint as an agreed price.
// - Old catalogue rows that are not on the card are DEACTIVATED (is_active = 0), never deleted.
//   Travel / accommodation / rider / merchandise add-ons stay active and unchanged.
// - ATOMIC: the whole change is planned first (planRateCard — pure, no I/O) and then applied as ONE
//   BEGIN IMMEDIATE … COMMIT script (a single queued operation on the shared connection), with the
//   "applied" marker inside the same transaction. Requests never see a half-migrated catalogue, and a
//   crash or failure part-way leaves the old catalogue fully intact (the migration retries next start).
const MIGRATION_VERSION = 106;
const MIGRATION_NAME = 'rate_card_2026';

// The group registry and the pricing-type rules live in lib/service-pricing.js (the runtime source of truth).
const { GROUPS, FEATURED_GROUP } = require('./service-pricing');
const { withDbTransaction } = require('./db-transaction');
const { decodeStoredText } = require('./html-sanitize');

const WGSA = 'WGSA 2024–2026 escalated rates, highly experienced professional tier.';

// type: fixed | range | from | enquire | enquire_min     unit: null | hour | month | session | draft
// cat: legacy catalogue category; mins: performance_length_minutes (0 = not a timed service)
const RATE_CARD = [
    // ── Club and Theatre ──
    { group: 'club_theatre', name: 'Club – 10 min Set (Guest Spot)',  type: 'fixed', price: 5000,  mins: 10,  cat: 'Performance' },
    { group: 'club_theatre', name: 'Club – 20 min Set (Support)',     type: 'fixed', price: 10000, mins: 20,  cat: 'Performance' },
    { group: 'club_theatre', name: 'Club – 45 min Headline',          type: 'fixed', price: 18000, mins: 45,  cat: 'Performance' },
    { group: 'club_theatre', name: 'Club – MC Club Night',            type: 'fixed', price: 12000, mins: 120, cat: 'Performance' },
    // ── Corporate and Events (Most Booked) ──
    { group: 'corporate_events', name: 'Corporate – 15 min Comedic Performance',       type: 'fixed', price: 28000, mins: 15,  cat: 'Performance',
      reuse: 'Stand-Up Comedy – Short Set (15 min)' },
    { group: 'corporate_events', name: 'Corporate – 30 min Comedic Performance',       type: 'fixed', price: 42000, mins: 30,  cat: 'Performance' },
    { group: 'corporate_events', name: 'Corporate – 45–60 min Comedic Performance',    type: 'fixed', price: 55000, mins: 60,  cat: 'Performance',
      reuse: 'Stand-Up Comedy – Headline Set (60 min)' },
    { group: 'corporate_events', name: 'Corporate – MC Duties 1–2 Hours',              type: 'fixed', price: 30000, mins: 120, cat: 'Performance' },
    { group: 'corporate_events', name: 'Corporate – MC Duties 2–4 Hours',              type: 'fixed', price: 45000, mins: 240, cat: 'Performance' },
    { group: 'corporate_events', name: 'Corporate – MC Duties 4–6 Hours',              type: 'fixed', price: 60000, mins: 360, cat: 'Performance' },
    { group: 'corporate_events', name: 'Corporate – MC Duties Full Day (6+ Hours)',    type: 'fixed', price: 75000, mins: 480, cat: 'Performance',
      reuse: 'MC & Host – Full Day' },
    // ── Private functions, weddings, year-end ──
    { group: 'private_functions', name: 'Private – MC 1–3 Hours',            type: 'fixed', price: 30000, mins: 180, cat: 'Performance' },
    { group: 'private_functions', name: 'Private – MC 3–5 Hours',            type: 'fixed', price: 42000, mins: 300, cat: 'Performance' },
    { group: 'private_functions', name: 'Private – Performance + MC Combo',  type: 'from',  min: 50000,   mins: 0,   cat: 'Performance' },
    // ── Writing and creative ──
    { group: 'writing_creative', name: 'Writing – Copywriting / Roast Writing / Joke Pack', type: 'range', min: 12000, max: 25000, cat: 'Production', desc: WGSA },
    { group: 'writing_creative', name: 'Writing – TV Script (30 min Episode)',              type: 'range', min: 18000, max: 35000, cat: 'Production', desc: WGSA },
    { group: 'writing_creative', name: 'Writing – Film / Telenovela Script (per draft)',    type: 'enquire', unit: 'draft', cat: 'Production', desc: WGSA + ' Enquire – WGSA rates.' },
    { group: 'writing_creative', name: 'Writing – Head Writer (per month)',                 type: 'range', min: 90000, max: 140000, unit: 'month', cat: 'Production', desc: WGSA },
    { group: 'writing_creative', name: 'Writing – Script Editor (per month)',               type: 'range', min: 45000, max: 65000,  unit: 'month', cat: 'Production', desc: WGSA },
    // Consultation is a true hourly rate: the one existing per_hour model, quantity = hours.
    { group: 'writing_creative', name: 'Writing – Consultation', type: 'fixed', price: 2500, unit: 'hour', model: 'per_hour', cat: 'Production', desc: WGSA },
    // ── Acting, voice-over, brand campaigns ──
    { group: 'acting_voice_brand', name: 'Acting – Per SAGA',                         type: 'enquire_min', min: 15000, unit: 'session', cat: 'Production' },
    { group: 'acting_voice_brand', name: 'Voice-Over – Per SAGA/SAG',                 type: 'enquire_min', min: 15000, unit: 'session', cat: 'Production' },
    { group: 'acting_voice_brand', name: 'Brand Campaign / Content Day Rate + Usage', type: 'from',        min: 60000, cat: 'Production' }
];

const RATE_CARD_SETTINGS = {
    rate_card_title: 'Booking Kit 2026',
    rate_card_updated: 'September 2026',
    rate_card_valid_until: '2026-12-31',
    rate_card_currency: 'ZAR',
    rate_card_featured_group: FEATURED_GROUP,
    rate_card_conditions: 'All fees are quoted in South African rand (ZAR) and exclude VAT at 15%, travel, accommodation, and rider. ' +
        "Rates are valid until 31 December 2026. Services marked 'Enquire' or 'From' may require a tailored quotation."
};

// Columns this feature adds to `services` (all nullable / defaulted — additive, non-destructive).
const NEW_COLUMNS = [
    ['price_type',    "TEXT DEFAULT 'fixed'"],
    ['price_min',     'DECIMAL(10,2)'],
    ['price_max',     'DECIMAL(10,2)'],
    ['price_unit',    'TEXT'],
    ['is_featured',   'INTEGER DEFAULT 0'],
    ['service_group', 'TEXT']
];

const get = (db, sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => e ? rej(e) : res(r)));
const all = (db, sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => e ? rej(e) : res(r || [])));
const exec = (db, sql) => new Promise((res, rej) => db.exec(sql, (e) => e ? rej(e) : res()));

// SQL literal for a value THIS module produced (constants above, or values read back from the database) —
// never request input, so quote-doubling is all the escaping a string needs.
const lit = (v) => {
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
    if (typeof v === 'boolean') return v ? '1' : '0';
    return "'" + String(v).replace(/'/g, "''") + "'";
};

// The column values one rate-card row writes.
function rowValues(r) {
    const model = r.model || 'flat_fee';
    const isFixed = r.type === 'fixed';
    return {
        description: r.desc || null,
        default_price: isFixed ? r.price : 0,                    // non-fixed -> 0, never a guessed amount
        // base_price is an optional booking-rate OVERRIDE that wins over default_price when set; leaving it empty
        // means editing the fee in the admin changes what new bookings snapshot (a pre-set copy would go stale).
        base_price: null,
        pricing_model: model,
        min_quantity: 1, max_quantity: model === 'per_hour' ? null : 1,
        display_unit: model === 'per_hour' ? 'hr' : 'unit',
        is_taxable: 1, tax_class: 'standard', category: r.cat,
        performance_length_minutes: r.mins || 0,
        // A fixed price lives ONLY in default_price (price_min/max are for published bands), so the two can never drift.
        price_type: r.type, price_min: r.min != null ? r.min : null, price_max: r.max != null ? r.max : null,
        price_unit: r.unit || null, is_featured: r.group === FEATURED_GROUP ? 1 : 0, service_group: r.group
    };
}

// PURE: from the current `services` rows, decide everything the migration does and return it as one
// atomic SQL script plus a summary. No I/O, so it is unit-testable against any set of rows.
function planRateCard(rows) {
    // Match on the plain text of a name: the admin saves entity-encoded text ("MC &amp; Host"), seeded rows
    // may be raw ("MC & Host") — either must find the same legacy service.
    const byName = new Map(rows.map(x => [decodeStoredText(x.name), x]));
    const summary = { updated: [], created: [], deactivated: [], kept: [] };
    const touched = new Set();
    const stmts = [];
    const audit = (idSql, action, oldV, newV) => stmts.push(
        `INSERT INTO audit_log (table_name, record_id, action, changed_by, old_values, new_values, reason) VALUES ('services', ${idSql}, ${lit(action)}, 'system', ${lit(oldV ? JSON.stringify(oldV) : null)}, ${lit(newV ? JSON.stringify(newV) : null)}, 'Rate card 2026 migration')`);
    const before = (x) => ({ name: x.name, default_price: x.default_price, base_price: x.base_price, pricing_model: x.pricing_model, category: x.category, is_active: x.is_active, is_deleted: x.is_deleted });

    for (const r of RATE_CARD) {
        const vals = rowValues(r);
        const cols = Object.keys(vals);
        let row = byName.get(r.name);
        if (!row && r.reuse) { const cand = byName.get(r.reuse); if (cand && !cand.is_deleted) row = cand; }
        if (row) {
            stmts.push(`UPDATE services SET name = ${lit(r.name)}, is_active = 1, is_deleted = 0, ${cols.map(c => c + ' = ' + lit(vals[c])).join(', ')} WHERE id = ${Number(row.id)}`);
            audit(Number(row.id), 'RATE_CARD_2026_UPDATE', before(row), { name: r.name, ...vals });
            touched.add(row.id);
            summary.updated.push({ id: row.id, from: row.name, to: r.name });
        } else {
            stmts.push(`INSERT INTO services (name, service_type, is_active, setup_time_minutes, availability_rule, ${cols.join(', ')}) VALUES (${lit(r.name)}, 'core', 1, ${r.mins ? 30 : 0}, 'any_time', ${cols.map(c => lit(vals[c])).join(', ')})`);
            audit('last_insert_rowid()', 'RATE_CARD_2026_CREATE', null, { name: r.name, ...vals });
            summary.created.push({ name: r.name });
        }
    }

    // Deactivate (never delete) live rows that are not on the card — except travel / accommodation /
    // rider / merchandise add-ons, which stay active as agreed.
    for (const s of rows) {
        const deleted = !!s.is_deleted;
        const active = (s.is_active === null || s.is_active === undefined) ? true : !!s.is_active;
        if (deleted || !active || touched.has(s.id)) continue;
        if (s.service_type === 'add-on' && (s.category === 'Travel' || s.category === 'Other')) { summary.kept.push({ id: s.id, name: s.name }); continue; }
        stmts.push(`UPDATE services SET is_active = 0 WHERE id = ${Number(s.id)}`);
        audit(Number(s.id), 'RATE_CARD_2026_DEACTIVATE', { is_active: 1 }, { is_active: 0 });
        summary.deactivated.push({ id: s.id, name: s.name });
    }

    for (const [k, v] of Object.entries(RATE_CARD_SETTINGS)) {
        stmts.push(`INSERT INTO settings (setting_key, setting_value) VALUES (${lit(k)}, ${lit(v)}) ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value`);
    }
    // The marker is part of the same transaction: applied completely or not at all.
    stmts.push(`INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (${MIGRATION_VERSION}, ${lit(MIGRATION_NAME)})`);

    return { sql: 'BEGIN IMMEDIATE;\n' + stmts.join(';\n') + ';\nCOMMIT;', summary };
}

// Plan from the live rows, then run the script as one operation. On failure it is rolled back (unless
// the BEGIN itself failed — then another transaction is open and it is not ours to roll back).
async function applyRateCard(db) {
    const { sql, summary } = planRateCard(await all(db, 'SELECT * FROM services'));
    try {
        await exec(db, sql);
    } catch (e) {
        if (!/within a transaction/i.test(e.message || '')) await exec(db, 'ROLLBACK').catch(() => {});
        throw e;
    }
    return summary;
}

const REQUIRED_TABLES = ['services', 'audit_log', 'settings', 'schema_migrations'];
const RETRY_MS = 250;
const MAX_ATTEMPTS = 240; // ~60 s — init of a brand-new database takes a few seconds, not a minute

// One attempt. 'not-ready' = the tables / columns this needs have not been created yet (init is still
// running — never assume statement order, look at the real schema); 'busy' = another transaction is
// open on the shared connection right now; 'already' = the marker says this database is done.
async function tryApply(db) {
    const tables = (await all(db, "SELECT name FROM sqlite_master WHERE type = 'table'")).map(r => r.name);
    if (!REQUIRED_TABLES.every(t => tables.includes(t))) return { status: 'not-ready' };
    const cols = (await all(db, 'PRAGMA table_info(services)')).map(c => c.name);
    if (!NEW_COLUMNS.every(([c]) => cols.includes(c))) return { status: 'not-ready' };
    try {
        return await withDbTransaction(async () => {
            if (await get(db, 'SELECT 1 AS x FROM schema_migrations WHERE version = ?', [MIGRATION_VERSION])) return { status: 'already' };
            return { status: 'applied', summary: await applyRateCard(db) };
        });
    } catch (e) {
        if (/within a transaction|database is locked|SQLITE_BUSY/i.test(e.message || '')) return { status: 'busy' };
        throw e;
    }
}

// Run once per database. Called from database.js at the end of the init chain, but init's later steps
// (and a brand-new database's table creation) are still in flight at that moment, so this waits for the
// schema it needs and retries while a transaction is open. Failure is logged, rolled back, and retried
// on the next start; it never takes the server down.
function applyOnce(db, done) {
    let attempts = 0;
    const tick = async () => {
        attempts++;
        try {
            const r = await tryApply(db);
            if (r.status === 'not-ready' || r.status === 'busy') {
                if (attempts >= MAX_ATTEMPTS) throw new Error(`gave up after ${attempts} attempts (${r.status})`);
                const t = setTimeout(tick, RETRY_MS);
                if (t.unref) t.unref(); // a waiting migration must never keep a short-lived script alive
                return;
            }
            const s = r.summary || null;
            if (s) console.log(`Rate card 2026 applied: ${s.updated.length} updated, ${s.created.length} created, ${s.deactivated.length} deactivated, ${s.kept.length} add-ons kept.`);
            if (done) done(null, s);
        } catch (e) {
            console.error('Rate card 2026 migration failed and was rolled back (it retries on the next start):', e.message);
            if (done) done(e);
        }
    };
    tick();
}

module.exports = { RATE_CARD, RATE_CARD_SETTINGS, GROUPS, FEATURED_GROUP, NEW_COLUMNS, MIGRATION_VERSION, planRateCard, applyRateCard, applyOnce };
