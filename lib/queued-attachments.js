// Attachments for QUEUED emails. sendEmail() (js/emailService.js) does not send - it stores the email in `notifications` and the
// background worker sends it later, possibly minutes later and after the caller has finished (the newsletter code even deletes its
// source files right after queueing). So an attachment has to be copied into the queue entry itself.
//
// Until 2026-10 only string file paths survived the queue: every { filename, content: <Buffer> } attachment (quote / invoice / contract
// PDFs, the advancing pack, .ics invites, direct-email and campaign attachments) was silently dropped, and path attachments lost their
// display name. Now:
//   store()    copies the bytes of each in-memory attachment into `notification_attachments`, CONTENT-ADDRESSED by sha256 (one PDF sent to
//              500 subscribers is stored once), and returns the JSON for notifications.attachment_paths. Each entry keeps its filename and
//              content type: { filename, contentType?, cid?, blob: <sha256> }  or  { filename, contentType?, path } for a file on disk.
//   load()     rebuilds the nodemailer attachments. If a stored attachment's bytes are gone it THROWS - an email must never go out without
//              the attachment it promises ("please review the attached contract").
//   release()  deletes bytes that no PENDING email references any more (called once an email is sent / finally failed).
//   sweepOrphans() hourly safety net for bytes left behind by a crash, an anonymised row or an expired row.
// Rows queued before this change hold a plain JSON array of path strings; load() still understands that form.
'use strict';
const crypto = require('crypto');
const path = require('path');
const db = require('../database');
const { PROJECT_ROOT } = require('./runtime-paths');

const MAX_TOTAL_BYTES = 25 * 1024 * 1024;   // per email; Exchange Online's submission limit is in the same range - fail loudly here rather than at the server

const run = (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, function (err) { err ? reject(err) : resolve(this); }));
const get = (sql, params = []) => new Promise((resolve, reject) => db.get(sql, params, (err, row) => err ? reject(err) : resolve(row)));
const all = (sql, params = []) => new Promise((resolve, reject) => db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows || [])));

function toBuffer(content, encoding) {
    if (Buffer.isBuffer(content)) return content;
    if (content instanceof Uint8Array) return Buffer.from(content);
    if (typeof content === 'string') return Buffer.from(content, encoding || 'utf8');
    throw new Error('Unsupported attachment content (use a Buffer or a string)');
}

function extras(a) {
    const out = {};
    if (a.contentType) out.contentType = String(a.contentType);
    if (a.cid) out.cid = String(a.cid);
    if (a.contentDisposition) out.contentDisposition = String(a.contentDisposition);
    return out;
}

// attachments (as given to sendEmail) -> JSON string for notifications.attachment_paths, or null when there are none. Throws when an
// attachment cannot be queued (too big, unsupported) so the caller reports a failure instead of queueing an email that lost its file.
async function store(attachments) {
    if (!Array.isArray(attachments) || attachments.length === 0) return null;
    const entries = [];
    const blobs = new Map();
    let total = 0;
    for (const a of attachments) {
        if (!a) continue;
        const filename = a.filename ? String(a.filename) : null;
        if (a.content !== undefined && a.content !== null) {
            const buf = toBuffer(a.content, a.encoding);
            total += buf.length;
            if (total > MAX_TOTAL_BYTES) throw new Error(`attachments are larger than the ${MAX_TOTAL_BYTES / 1024 / 1024} MB limit`);
            const sha = crypto.createHash('sha256').update(buf).digest('hex');
            blobs.set(sha, buf);
            entries.push(Object.assign({ filename: filename || 'attachment', blob: sha }, extras(a)));
        } else if (a.path && typeof a.path === 'string') {
            entries.push(Object.assign({ filename: filename || path.basename(a.path), path: a.path }, extras(a)));
        } else {
            throw new Error('unsupported attachment (it needs content or a path)');
        }
    }
    for (const [sha, buf] of blobs) {
        await run('INSERT OR IGNORE INTO notification_attachments (sha256, size, data) VALUES (?, ?, ?)', [sha, buf.length, buf]);
        await run('UPDATE notification_attachments SET created_at = CURRENT_TIMESTAMP WHERE sha256 = ?', [sha]);   // "touch": keeps the orphan sweep away from bytes we are about to reference
    }
    return entries.length ? JSON.stringify(entries) : null;
}

const resolvePath = (p) => path.isAbsolute(p) ? p : path.join(PROJECT_ROOT, p);

// JSON from notifications.attachment_paths -> nodemailer attachments. Throws (code EATTACHMENT) if stored bytes are missing.
async function load(json) {
    if (!json) return [];
    let entries;
    try { entries = JSON.parse(json); } catch (e) { throw Object.assign(new Error('the attachment list is not valid JSON'), { code: 'EATTACHMENT' }); }
    if (!Array.isArray(entries)) return [];
    const out = [];
    for (const e of entries) {
        if (typeof e === 'string') {                    // legacy rows: a plain file path
            out.push({ filename: path.basename(e), path: resolvePath(e) });
        } else if (e && e.blob) {
            const row = await get('SELECT data FROM notification_attachments WHERE sha256 = ?', [e.blob]);
            if (!row) throw Object.assign(new Error(`the attachment "${e.filename || 'attachment'}" is no longer stored`), { code: 'EATTACHMENT' });
            const a = { filename: e.filename, content: Buffer.from(row.data) };
            if (e.contentType) a.contentType = e.contentType;
            if (e.cid) a.cid = e.cid;
            if (e.contentDisposition) a.contentDisposition = e.contentDisposition;
            out.push(a);
        } else if (e && e.path) {
            const a = { filename: e.filename || path.basename(e.path), path: resolvePath(e.path) };
            if (e.contentType) a.contentType = e.contentType;
            out.push(a);
        }
    }
    return out;
}

function blobHashes(json) {
    if (!json) return [];
    try { const entries = JSON.parse(json); return Array.isArray(entries) ? entries.filter(e => e && e.blob).map(e => e.blob) : []; }
    catch (e) { return []; }
}

// Called when an email has been sent or has finally failed: delete the bytes unless another PENDING email still needs them (a newsletter's
// other recipients). `excludeRowId` = the row that just finished (its status update may not have landed yet).
async function release(json, excludeRowId) {
    let deleted = 0;
    for (const sha of new Set(blobHashes(json))) {
        const still = await get(
            "SELECT 1 AS x FROM notifications WHERE status = 'pending' AND id != ? AND attachment_paths LIKE ? LIMIT 1",
            [excludeRowId || 0, `%"blob":"${sha}"%`]);       // sha is hex, so it carries no LIKE wildcards
        if (!still) { await run('DELETE FROM notification_attachments WHERE sha256 = ?', [sha]); deleted++; }
    }
    return deleted;
}

// Bytes older than an hour that no pending email references: crash leftovers, anonymised (POPIA) rows, rows expired behind a mail-server fault.
async function sweepOrphans() {
    const old = await all("SELECT sha256 FROM notification_attachments WHERE created_at < datetime('now', '-1 hour')");
    if (!old.length) return 0;
    const referenced = new Set();
    (await all("SELECT attachment_paths FROM notifications WHERE status = 'pending' AND attachment_paths IS NOT NULL"))
        .forEach(r => blobHashes(r.attachment_paths).forEach(h => referenced.add(h)));
    let deleted = 0;
    for (const { sha256 } of old) {
        if (!referenced.has(sha256)) { await run('DELETE FROM notification_attachments WHERE sha256 = ?', [sha256]); deleted++; }
    }
    return deleted;
}

module.exports = { MAX_TOTAL_BYTES, store, load, release, sweepOrphans };
