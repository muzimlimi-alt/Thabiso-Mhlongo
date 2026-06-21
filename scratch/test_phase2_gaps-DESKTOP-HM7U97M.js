'use strict';
/**
 * Phase 2 Gap Closure — Integration Test Suite
 * Tests: Gap 2 (invoice soft-guard), Gap 3 (re-quote reconciliation), Gap 4 (RESPONDED retired)
 * Run: node scratch/test_phase2_gaps.js
 */
const http = require('http');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const BASE = 'http://localhost:3000';
const DB_PATH = path.resolve(__dirname, '..', 'database.sqlite');
const delay = ms => new Promise(r => setTimeout(r, ms));

// ─── helpers ──────────────────────────────────────────────────────────────────
function req(method, urlPath, body, cookie) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const opts = {
            method,
            host: 'localhost',
            port: 3000,
            path: urlPath,
            headers: {
                'Content-Type': 'application/json',
                ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
                ...(cookie ? { 'Cookie': cookie } : {}),
            },
        };
        const r = http.request(opts, (res) => {
            let raw = '';
            res.on('data', d => raw += d);
            res.on('end', () => {
                try { resolve({ status: res.statusCode, body: JSON.parse(raw), headers: res.headers }); }
                catch { resolve({ status: res.statusCode, body: raw, headers: res.headers }); }
            });
        });
        r.on('error', reject);
        if (data) r.write(data);
        r.end();
    });
}

function dbRun(db, sql, params = []) {
    return new Promise((resolve, reject) => db.run(sql, params, function(err) { err ? reject(err) : resolve(this); }));
}
function dbGet(db, sql, params = []) {
    return new Promise((resolve, reject) => db.get(sql, params, (err, row) => err ? reject(err) : resolve(row)));
}
function dbAll(db, sql, params = []) {
    return new Promise((resolve, reject) => db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows || [])));
}
function openDb() {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(DB_PATH, (err) => err ? reject(err) : resolve(db));
    });
}

let passed = 0, failed = 0;
function assert(label, condition, detail = '') {
    if (condition) { console.log(`  ✓ ${label}`); passed++; }
    else { console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); failed++; }
}

// ─── admin login ──────────────────────────────────────────────────────────────
async function adminLogin() {
    const r = await req('POST', '/api/admin/login', { username: 'admin', password: 'password123' });
    if (!r.body?.success) throw new Error(`Admin login failed (HTTP ${r.status}): ${JSON.stringify(r.body)}`);
    const setCookie = r.headers['set-cookie'];
    if (!setCookie) throw new Error('Admin login OK but no session cookie returned');
    return setCookie.map(c => c.split(';')[0]).join('; ');
}

// ─── DB setup: create a QUOTED booking directly ───────────────────────────────
async function createQuotedBooking(db, overrides = {}) {
    const unique = `p2test_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const email = overrides.email || `${unique}@example.com`;
    const eventDate = overrides.date || new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
    const expiryDate = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);

    const result = await dbRun(db, `
        INSERT INTO bookings (name, email, cell, event_type, event_name, date, event_start_time,
            event_location, audience_size, message, status, quote_amount, quote_expiry_date,
            total_amount, amount_outstanding, popia_consent)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'QUOTED', ?, ?, ?, ?, 1)
    `, [
        overrides.name || 'Phase2 Test Client',
        email,
        '0812345678',
        'Corporate',
        overrides.event_name || 'Phase2 Test Event',
        eventDate,
        '18:00',
        'Test Venue',
        50,
        'Automated Phase 2 test booking.',
        overrides.quote_amount || '2000.00',
        overrides.quote_expiry_date || expiryDate,
        overrides.total_amount || 2000,
        overrides.amount_outstanding || 2000,
    ]);

    return { id: result.lastID, email };
}

// ─── test 1: RESPONDED retired from endpoint guards ───────────────────────────
async function testRespondedRetired() {
    console.log('\n── Gap 4: RESPONDED retired from endpoint guards ───────────────────────');
    const db = await openDb();
    try {
        // Create a booking and verify that setting status = RESPONDED is blocked by DB trigger
        const { id, email } = await createQuotedBooking(db);
        let updateThrew = false;
        try {
            await dbRun(db, "UPDATE bookings SET status = 'RESPONDED' WHERE id = ?", [id]);
        } catch (e) {
            updateThrew = true;
            assert('Updating status to RESPONDED is blocked by DB constraint trigger', e.message.includes('Invalid bookings.status value'));
        }
        assert('DB update to RESPONDED threw error', updateThrew);

        // Also test that accept-quote rejects PENDING status (which is a valid DB status, but invalid for quote acceptance)
        await dbRun(db, "UPDATE bookings SET status = 'PENDING' WHERE id = ?", [id]);
        const acceptR = await req('POST', `/api/public/bookings/${id}/accept-quote`, { email, terms_agreed: true });
        assert('accept-quote rejects PENDING (HTTP 400)', acceptR.status === 400,
            `got ${acceptR.status}: ${JSON.stringify(acceptR.body)}`);
        assert('accept-quote error message does NOT mention RESPONDED', !acceptR.body?.message?.toLowerCase().includes('responded'),
            `message: ${acceptR.body?.message}`);

        // quote-revision-request should also reject it
        const revR = await req('POST', `/api/public/bookings/${id}/quote-revision-request`, {
            email, request_type: 'revision', message: 'Please revise the scope for the test case.'
        });
        assert('quote-revision-request rejects PENDING (HTTP 400)', revR.status === 400,
            `got ${revR.status}: ${JSON.stringify(revR.body)}`);

        // Cleanup
        await dbRun(db, 'DELETE FROM bookings WHERE id = ?', [id]);
    } finally {
        db.close();
    }
}

// ─── test 2: Invoice soft-guard ───────────────────────────────────────────────
async function testInvoiceSoftGuard() {
    console.log('\n── Gap 2: Invoice soft-guard — normal acceptance ───────────────────────');
    const db = await openDb();
    try {
        const { id, email } = await createQuotedBooking(db, { quote_amount: '500.00', total_amount: 500, amount_outstanding: 500 });

        const r = await req('POST', `/api/public/bookings/${id}/accept-quote`, { email, terms_agreed: true });
        assert('Normal acceptance returns HTTP 200', r.status === 200, `got ${r.status}: ${JSON.stringify(r.body)}`);
        assert('Response has success: true', r.body?.success === true);
        assert('Response includes invoice_generated flag', typeof r.body?.invoice_generated === 'boolean',
            `invoice_generated = ${JSON.stringify(r.body?.invoice_generated)}`);
        if (r.body?.invoice_generated) {
            assert('When invoice generated: message mentions invoice', r.body.message.includes('invoice'),
                `"${r.body.message}"`);
        } else {
            assert('When invoice failed: message is neutral (no false promise)', !r.body.message.includes('invoice has been generated'),
                `"${r.body.message}"`);
        }
        console.log(`  [info] invoice_generated=${r.body?.invoice_generated}, message="${r.body?.message}"`);

        // Verify booking is ACCEPTED in DB
        await delay(300);
        const row = await dbGet(db, 'SELECT status, accepted_at FROM bookings WHERE id = ?', [id]);
        assert('Booking status is ACCEPTED in DB', row?.status === 'ACCEPTED', `got ${row?.status}`);
        assert('accepted_at is set', !!row?.accepted_at);

        // Audit log entry
        const auditRow = await dbGet(db, "SELECT * FROM audit_log WHERE record_id = ? AND action = 'QUOTE_ACCEPTED'", [String(id)]);
        assert('Audit log entry created for QUOTE_ACCEPTED', !!auditRow, 'no audit log entry found');

        // Cleanup
        await dbRun(db, 'DELETE FROM invoices WHERE booking_id = ?', [id]);
        await dbRun(db, 'DELETE FROM payment_schedules WHERE booking_id = ?', [id]);
        await dbRun(db, 'DELETE FROM audit_log WHERE record_id = ?', [String(id)]);
        await dbRun(db, 'DELETE FROM bookings WHERE id = ?', [id]);
    } finally {
        db.close();
    }
}

// ─── test 3: Custom milestones preserved on first acceptance ──────────────────
async function testCustomMilestonesPreserved() {
    console.log('\n── Normal: Custom milestones preserved on acceptance ────────────────────');
    const db = await openDb();
    try {
        const { id, email } = await createQuotedBooking(db, { quote_amount: '3000.00', total_amount: 3000, amount_outstanding: 3000 });
        const eventDate = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);

        // Insert 3 custom payment schedule rows before acceptance
        await dbRun(db, "INSERT INTO payment_schedules (booking_id, description, due_date, expected_amount) VALUES (?,?,?,?)",
            [id, 'Deposit (30%)', new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10), 900]);
        await dbRun(db, "INSERT INTO payment_schedules (booking_id, description, due_date, expected_amount) VALUES (?,?,?,?)",
            [id, 'Milestone (40%)', new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10), 1200]);
        await dbRun(db, "INSERT INTO payment_schedules (booking_id, description, due_date, expected_amount) VALUES (?,?,?,?)",
            [id, 'Balance (30%)', new Date(Date.now() + 50 * 86400000).toISOString().slice(0, 10), 900]);

        const r = await req('POST', `/api/public/bookings/${id}/accept-quote`, { email, terms_agreed: true });
        assert('Acceptance with custom milestones returns HTTP 200', r.status === 200, `got ${r.status}`);

        await delay(500);
        // Only rows that are not superseded
        const schedules = await dbAll(db, "SELECT * FROM payment_schedules WHERE booking_id = ? AND LOWER(COALESCE(status,'pending')) != 'superseded'", [id]);
        console.log(`  [info] Active schedule rows: ${schedules.map(s => s.description).join(', ')}`);
        assert('Exactly 3 custom milestones preserved (no 50/50 added)', schedules.length === 3,
            `found ${schedules.length} active rows`);
        assert('No 50% Deposit row added', !schedules.some(s => s.description === '50% Deposit'));

        // Cleanup
        await dbRun(db, 'DELETE FROM invoices WHERE booking_id = ?', [id]);
        await dbRun(db, 'DELETE FROM payment_schedules WHERE booking_id = ?', [id]);
        await dbRun(db, 'DELETE FROM audit_log WHERE record_id = ?', [String(id)]);
        await dbRun(db, 'DELETE FROM bookings WHERE id = ?', [id]);
    } finally {
        db.close();
    }
}

// ─── test 4: Re-quote reconciliation ─────────────────────────────────────────
async function testReQuoteReconciliation(cookie) {
    console.log('\n── Gap 3: Re-quote reconciliation after ACCEPTED ────────────────────────');
    const db = await openDb();
    try {
        // Create booking via public API so it gets created correctly
        const unique = `p2rq_${Date.now()}`;
        const email = `${unique}@example.com`;
        const eventDate = new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10);
        const { id } = await createQuotedBooking(db, { email, quote_amount: '2000.00', total_amount: 2000, amount_outstanding: 2000, date: eventDate });

        // Accept the quote (creates 50/50 schedule)
        const acceptR = await req('POST', `/api/public/bookings/${id}/accept-quote`, { email, terms_agreed: true });
        assert('Initial acceptance returns HTTP 200', acceptR.status === 200, `got ${acceptR.status}: ${JSON.stringify(acceptR.body)}`);
        await delay(600);

        const statusAfterAccept = (await dbGet(db, 'SELECT status FROM bookings WHERE id = ?', [id]))?.status;
        assert('Booking is ACCEPTED after acceptance', statusAfterAccept === 'ACCEPTED', `got ${statusAfterAccept}`);

        const schedsBefore = await dbAll(db, "SELECT * FROM payment_schedules WHERE booking_id = ?", [id]);
        console.log(`  [info] Schedules before re-quote: ${schedsBefore.length} rows`);

        // Now re-quote (admin API) with a different amount
        const expiryDate = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
        const reQuoteR = await req('POST', `/api/admin/bookings/${id}/quote`, {
            items: [{ description: 'Revised Service', quantity: 1, unit_price: 3500 }],
            quote_expiry_date: expiryDate,
            discount: 0,
            apply_vat: false,
        }, cookie);
        assert('Re-quote on ACCEPTED booking returns HTTP 200', reQuoteR.status === 200,
            `got ${reQuoteR.status}: ${JSON.stringify(reQuoteR.body)}`);
        await delay(500);

        // Booking should be QUOTED again
        const statusAfterReQuote = (await dbGet(db, 'SELECT status, quote_amount FROM bookings WHERE id = ?', [id]));
        assert('Booking reverts to QUOTED after re-quote', statusAfterReQuote?.status === 'QUOTED',
            `got ${statusAfterReQuote?.status}`);
        assert('Quote amount updated to new total', parseFloat(statusAfterReQuote?.quote_amount) === 3500,
            `got ${statusAfterReQuote?.quote_amount}`);

        // Old schedules should be superseded
        const schedsAfter = await dbAll(db, "SELECT * FROM payment_schedules WHERE booking_id = ?", [id]);
        const nonSuperseded = schedsAfter.filter(s => (s.status || '').toLowerCase() !== 'superseded' && (s.status || '').toLowerCase() !== 'paid');
        console.log(`  [info] Schedules after re-quote: ${schedsAfter.map(s => s.description + ':' + s.status).join(', ')}`);
        assert('Old payment schedules are superseded', nonSuperseded.length === 0,
            `${nonSuperseded.length} non-superseded rows: ${nonSuperseded.map(s => s.description + ':' + s.status)}`);

        // Old invoice should be voided
        const invoices = await dbAll(db, "SELECT * FROM invoices WHERE booking_id = ?", [id]);
        const nonVoid = invoices.filter(i => !['VOID','PAID'].includes((i.status || '').toUpperCase()));
        console.log(`  [info] Invoices: ${invoices.map(i => i.invoice_number + ':' + i.status).join(', ')}`);
        assert('Old invoice is voided after re-quote', nonVoid.length === 0,
            `${nonVoid.length} non-void invoices remain`);

        // Audit log for REQUOTE_AFTER_ACCEPTED
        const auditRow = await dbGet(db, "SELECT * FROM audit_log WHERE record_id = ? AND action = 'REQUOTE_AFTER_ACCEPTED'", [String(id)]);
        assert('Audit log entry created for REQUOTE_AFTER_ACCEPTED', !!auditRow);

        // Re-accept with new total
        const reAcceptR = await req('POST', `/api/public/bookings/${id}/accept-quote`, { email, terms_agreed: true });
        assert('Re-acceptance after re-quote returns HTTP 200', reAcceptR.status === 200,
            `got ${reAcceptR.status}: ${JSON.stringify(reAcceptR.body)}`);
        await delay(600);

        // Fresh schedules should be based on R3500
        const freshScheds = await dbAll(db, "SELECT * FROM payment_schedules WHERE booking_id = ? AND LOWER(COALESCE(status,'pending')) != 'superseded'", [id]);
        console.log(`  [info] Fresh schedules: ${freshScheds.map(s => s.description + ':R' + s.expected_amount).join(', ')}`);
        assert('New payment schedule rows created after re-acceptance', freshScheds.length >= 1,
            `found ${freshScheds.length} rows`);
        if (freshScheds.length >= 2) {
            const total = freshScheds.reduce((sum, s) => sum + parseFloat(s.expected_amount || 0), 0);
            assert('New schedule sums to new total (R3500)', Math.abs(total - 3500) < 1, `got R${total.toFixed(2)}`);
        }

        // Cleanup
        await dbRun(db, 'DELETE FROM payment_schedules WHERE booking_id = ?', [id]);
        await dbRun(db, 'DELETE FROM invoices WHERE booking_id = ?', [id]);
        await dbRun(db, 'DELETE FROM quotations WHERE booking_id = ?', [id]);
        await dbRun(db, 'DELETE FROM quote_line_items WHERE quotation_id NOT IN (SELECT id FROM quotations)');
        await dbRun(db, 'DELETE FROM audit_log WHERE record_id = ?', [String(id)]);
        await dbRun(db, 'DELETE FROM bookings WHERE id = ?', [id]);
    } finally {
        db.close();
    }
}

// ─── main ──────────────────────────────────────────────────────────────────────
(async () => {
    console.log('═══════════════════════════════════════════');
    console.log(' Phase 2 Gap Closure — Integration Tests   ');
    console.log('═══════════════════════════════════════════');

    let cookie;
    try {
        cookie = await adminLogin();
        console.log('✓ Admin login successful');
    } catch (e) {
        console.error('✗ Admin login failed:', e.message);
        process.exit(1);
    }

    try { await testRespondedRetired(); } catch (e) { console.error('  [ERROR] testRespondedRetired:', e.message, e.stack); failed++; }
    try { await testInvoiceSoftGuard(); } catch (e) { console.error('  [ERROR] testInvoiceSoftGuard:', e.message, e.stack); failed++; }
    try { await testCustomMilestonesPreserved(); } catch (e) { console.error('  [ERROR] testCustomMilestonesPreserved:', e.message, e.stack); failed++; }
    try { await testReQuoteReconciliation(cookie); } catch (e) { console.error('  [ERROR] testReQuoteReconciliation:', e.message, e.stack); failed++; }

    console.log('\n═══════════════════════════════════════════');
    console.log(` Results: ${passed} passed, ${failed} failed`);
    console.log('═══════════════════════════════════════════');
    process.exit(failed > 0 ? 1 : 0);
})();
