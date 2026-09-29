// Find-or-create helpers for clients/venues — Phase 5 of the housekeeping effort
// (HOUSEKEEPING-NOTES.md). Moved out of the app.js monolith byte-identical. `clients`/`venues`
// were never claimed by a Phase 4 domain repository, so these use `db` directly rather than a
// repository function.
const db = require('../database');
const { encodeUserHtml } = require('./html-sanitize');

// --- Database Migration Helpers (Phase 2) ---
function findOrCreateClient(name, email, phone, company, vat_number) {
    // ADMIN-XSS: encode HTML in the stored client name/company (rendered unescaped in the admin
    // client views). No-op for normal names; email/phone are validated and left raw.
    name = encodeUserHtml(name);
    company = encodeUserHtml(company);
    return new Promise((resolve, reject) => {
        // INSERT OR IGNORE exploits the UNIQUE constraint on clients.email, eliminating the
        // SELECT-then-INSERT race that produced duplicate client rows under concurrent submissions.
        db.run(
            "INSERT OR IGNORE INTO clients (full_name, email, phone, company_name, vat_number) VALUES (?, ?, ?, ?, ?)",
            [name || 'Unknown', email, phone || '0000000000', company || null, vat_number || null],
            function(insertErr) {
                if (insertErr) return reject(insertErr);
                const wasInserted = this.changes > 0;
                db.get("SELECT id, full_name FROM clients WHERE LOWER(email) = LOWER(?)", [email], (err, row) => {
                    if (err || !row) return reject(err || new Error('Client record missing after upsert'));
                    if (!wasInserted && name && row.full_name &&
                        row.full_name.toLowerCase() !== name.toLowerCase()) {
                        console.warn(`[findOrCreateClient] Email collision: existing="${row.full_name}" new="${name}" email="${email}". Updating client name to "${name}" to resolve collision.`);
                        db.run("UPDATE clients SET full_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [name, row.id]);
                        row.full_name = name;
                    }
                    if (company || vat_number) {
                        db.run("UPDATE clients SET company_name = COALESCE(?, company_name), vat_number = COALESCE(?, vat_number), updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                            [company, vat_number, row.id]);
                    }
                    resolve(row.id);
                });
            }
        );
    });
}

// The ONE place a venue gets written from a Google Place (or a plain manual name/address) — every
// booking-creation path (public and admin) and the admin "link a venue to an existing booking" flow
// all call this instead of each upserting `venues` themselves (2026-09-29 location-search
// consolidation audit: the admin venue-google endpoint used to run its own copy of this exact
// upsert, missing from THIS function's older, narrower field set — state/postal_code/latitude/
// longitude — even though `venues` has had those columns since its original CREATE TABLE).
//
// Accepts an options object rather than positional args: this now has nine optional fields (name/
// address/city/state/postalCode/country/placeId/latitude/longitude) and positional args of that
// length are unreadable at every call site and easy to pass in the wrong order.
//
// Merge semantics on an existing row (matched by place_id when given, else by name-or-address):
// COALESCE(new, old) per field — a fresh, non-blank value from this call overwrites what was
// stored (Google's answer is presumed fresher/more accurate), but a field this call doesn't supply
// leaves whatever was already there untouched. (Two previous copies of this upsert disagreed here —
// the original helper only ever filled in fields that were still blank, while the admin venue-google
// endpoint's inline copy always overwrote unconditionally, including with blanks; COALESCE(new, old)
// is the one behaviour that can't regress either caller: it refreshes stale data like the admin path
// did, without the public path's risk of blanking a field a caller simply didn't ask about.)
function findOrCreateVenueFromPlace(opts) {
    opts = opts || {};
    // ADMIN-XSS: encode HTML in stored venue text (rendered unescaped in admin venue/booking views).
    const venueName = encodeUserHtml(opts.name);
    const address = encodeUserHtml(opts.address);
    const city = encodeUserHtml(opts.city);
    const state = encodeUserHtml(opts.state);
    const postalCode = encodeUserHtml(opts.postalCode);
    const country = encodeUserHtml(opts.country);
    const placeId = encodeUserHtml(opts.placeId);
    // Coordinates aren't user-rendered text — no HTML to encode — but a non-numeric value (or the
    // empty string a cleared form field submits) must not silently become the number 0 (a real
    // coordinate, off the coast of Ghana) instead of "we don't have this".
    const latitude = (opts.latitude === '' || opts.latitude == null || isNaN(opts.latitude)) ? null : Number(opts.latitude);
    const longitude = (opts.longitude === '' || opts.longitude == null || isNaN(opts.longitude)) ? null : Number(opts.longitude);

    return new Promise((resolve, reject) => {
        if (!venueName && !address) return resolve(null);
        const searchName = venueName || address;
        // Prefer matching by place_id when available for accuracy
        const query = placeId
            ? "SELECT id FROM venues WHERE place_id = ?"
            : "SELECT id FROM venues WHERE name = ? OR address = ?";
        const params = placeId ? [placeId] : [searchName, address];
        db.get(query, params, (err, row) => {
            if (err) return reject(err);
            if (row) {
                db.run(
                    `UPDATE venues SET
                        name = COALESCE(?, name), address = COALESCE(?, address),
                        city = COALESCE(?, city), state = COALESCE(?, state), postal_code = COALESCE(?, postal_code),
                        country = COALESCE(?, country), place_id = COALESCE(?, place_id),
                        latitude = COALESCE(?, latitude), longitude = COALESCE(?, longitude),
                        updated_at = CURRENT_TIMESTAMP
                     WHERE id = ?`,
                    [venueName || null, address || null, city || null, state || null, postalCode || null,
                     country || null, placeId || null, latitude, longitude, row.id],
                    (upErr) => upErr ? reject(upErr) : resolve(row.id)
                );
                return;
            }
            db.run(
                "INSERT INTO venues (name, address, city, state, postal_code, country, place_id, latitude, longitude) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                [searchName || 'Unknown Venue', address || null, city || null, state || null, postalCode || null,
                 country || null, placeId || null, latitude, longitude],
                function(insErr) {
                    if (insErr) return reject(insErr);
                    resolve(this.lastID);
                }
            );
        });
    });
}

module.exports = { findOrCreateClient, findOrCreateVenueFromPlace };
