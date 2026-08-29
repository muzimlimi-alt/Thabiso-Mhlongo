// Settings domain repository — Phase 4 of the housekeeping effort (HOUSEKEEPING-NOTES.md).
// Every SQL string below is byte-identical to where it lived in server.js before this move; see
// HOUSEKEEPING-NOTES.md for the full old-line -> new-function mapping. No req/res, no email
// sending, no PDF generation, no calendar calls — pure data access, exactly as extracted.
const db = require('../../database');

// Was: db.all("SELECT setting_key, setting_value FROM settings", [], ...) — two identical
// call sites (server.js's boot-time env loader, and GET /api/admin/settings).
function getAllSettings(callback) {
    db.all("SELECT setting_key, setting_value FROM settings", [], callback);
}

// Was inline in getNotificationEmail() (server.js).
function getNotificationEmail() {
    return new Promise((resolve) => {
        db.get("SELECT setting_value FROM settings WHERE setting_key = 'notification_email'", [], (err, row) => {
            if (!err && row && row.setting_value) return resolve(row.setting_value);
            resolve(process.env.NOTIFICATION_EMAIL || process.env.EMAIL_USER || 'muzi.mlimi@gmail.com');
        });
    });
}

// Was: db.all(`SELECT setting_key, setting_value FROM settings WHERE setting_key IN (${ph})`, keys, ...)
// — four identical call sites (birthday-settings GET, getBirthdaySettings() helper, public
// branding GET, public site-content GET), each building `ph` from `keys` the same way.
function getSettingsByKeys(keys, callback) {
    const ph = keys.map(() => '?').join(',');
    db.all(`SELECT setting_key, setting_value FROM settings WHERE setting_key IN (${ph})`, keys, callback);
}

// Was inline in getBirthdaySettings() (server.js) — now delegates its SQL to getSettingsByKeys()
// above (byte-identical query/params), keeping its own Promise wrapper and defaulting logic as-is.
function getBirthdaySettings(BIRTHDAY_SETTING_KEYS, BIRTHDAY_SETTING_DEFAULTS) {
    return new Promise((resolve, reject) => {
        getSettingsByKeys(BIRTHDAY_SETTING_KEYS, (err, rows) => {
            if (err) return reject(err);
            const map = {};
            (rows || []).forEach(r => { map[r.setting_key] = r.setting_value; });
            const result = {};
            BIRTHDAY_SETTING_KEYS.forEach(k => { result[k] = map[k] != null ? map[k] : BIRTHDAY_SETTING_DEFAULTS[k]; });
            resolve(result);
        });
    });
}

// Was: db.get("SELECT setting_value FROM settings WHERE setting_key = 'min_booking_gap_minutes'", [], ...)
// — two identical call sites (public booking-config, admin working-hours GET).
function getMinBookingGapSetting(callback) {
    db.get("SELECT setting_value FROM settings WHERE setting_key = 'min_booking_gap_minutes'", [], callback);
}

// Was: db.get("SELECT setting_value FROM settings WHERE setting_key = 'type_buffers'", [], ...)
// — admin working-hours GET.
function getTypeBuffersSetting(callback) {
    db.get("SELECT setting_value FROM settings WHERE setting_key = 'type_buffers'", [], callback);
}

// Was inline in PUT /api/admin/working-hours (server.js) — the key is a literal in the SQL, not a
// parameter, exactly as it was.
function saveMinBookingGapMinutes(gapStr, callback) {
    db.run(`INSERT INTO settings (setting_key, setting_value) VALUES ('min_booking_gap_minutes', ?)
            ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value`, [gapStr], callback);
}

// Was inline in PUT /api/admin/working-hours (server.js) — same shape as saveMinBookingGapMinutes,
// different literal key.
function saveTypeBuffers(jsonStr, callback) {
    db.run(`INSERT INTO settings (setting_key, setting_value) VALUES ('type_buffers', ?)
            ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value`, [jsonStr], callback);
}

// Was inline in the PUT /api/admin/newsletter/birthday-settings loop (server.js) — the
// ON CONFLICT...updated_at variant, distinct from upsertSetting()'s INSERT OR REPLACE below.
function upsertSettingWithConflictClause(key, value, callback) {
    db.run(`INSERT INTO settings (setting_key, setting_value) VALUES (?, ?)
            ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_at = CURRENT_TIMESTAMP`,
        [key, value], callback);
}

// Was: db.run("INSERT OR REPLACE INTO settings (setting_key, setting_value, updated_at) VALUES (?,?,CURRENT_TIMESTAMP)", ...)
// — three identical call sites (admin settings PUT loop, branding PUT loop, site-content PUT loop).
function upsertSetting(key, value, callback) {
    db.run("INSERT OR REPLACE INTO settings (setting_key, setting_value, updated_at) VALUES (?,?,CURRENT_TIMESTAMP)",
        [key, value], callback);
}

// Was: const getSettingVal = (key) => { ... } (server.js) — generic single-key lookup, ~18 call
// sites throughout the file.
function getSettingVal(key) {
    return new Promise(resolve => {
        db.get("SELECT setting_value FROM settings WHERE setting_key = ?", [key], (err, row) => {
            resolve(row ? row.setting_value : null);
        });
    });
}

module.exports = {
    getAllSettings,
    getNotificationEmail,
    getSettingsByKeys,
    getBirthdaySettings,
    getMinBookingGapSetting,
    getTypeBuffersSetting,
    saveMinBookingGapMinutes,
    saveTypeBuffers,
    upsertSettingWithConflictClause,
    upsertSetting,
    getSettingVal,
};
