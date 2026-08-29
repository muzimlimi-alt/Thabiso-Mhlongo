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

function findOrCreateVenueFromPlace(venueName, address, city, country, placeId) {
    // ADMIN-XSS: encode HTML in stored venue text (rendered unescaped in admin venue/booking views).
    // placeId was the one field here missed by the original pass — it's client-supplied (the public
    // booking form's Google Places autocomplete) and stored/rendered exactly like its siblings.
    venueName = encodeUserHtml(venueName);
    address = encodeUserHtml(address);
    city = encodeUserHtml(city);
    country = encodeUserHtml(country);
    placeId = encodeUserHtml(placeId);
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
                // Update any missing fields on the existing record
                db.run("UPDATE venues SET city = COALESCE(city, ?), country = COALESCE(country, ?), place_id = COALESCE(place_id, ?), updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                    [city || null, country || null, placeId || null, row.id]);
                return resolve(row.id);
            }
            db.run("INSERT INTO venues (name, address, city, country, place_id) VALUES (?, ?, ?, ?, ?)",
                [searchName || 'Unknown Venue', address || null, city || null, country || null, placeId || null], function(err) {
                    if (err) return reject(err);
                    resolve(this.lastID);
            });
        });
    });
}

module.exports = { findOrCreateClient, findOrCreateVenueFromPlace };
