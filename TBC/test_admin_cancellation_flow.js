const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const http = require('http');
const assert = require('assert');

const projectDir = path.join(__dirname, '..');
const dbPath = path.resolve(projectDir, 'database.sqlite');
const db = new sqlite3.Database(dbPath);

function runQuery(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

function runCommand(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function(err) {
            if (err) reject(err);
            else resolve(this);
        });
    });
}

function makeRequest(method, urlPath, payload = null, cookie = null) {
    return new Promise((resolve, reject) => {
        const bodyStr = payload ? JSON.stringify(payload) : '';
        const headers = {
            'Content-Type': 'application/json'
        };
        if (cookie) {
            headers['Cookie'] = cookie;
        }
        if (payload) {
            headers['Content-Length'] = Buffer.byteLength(bodyStr);
        }

        const req = http.request({
            hostname: 'localhost',
            port: 3000,
            path: urlPath,
            method: method,
            headers: headers
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                const responseHeaders = res.headers;
                try {
                    resolve({ status: res.statusCode, body: JSON.parse(data), headers: responseHeaders });
                } catch(e) {
                    resolve({ status: res.statusCode, body: data, headers: responseHeaders });
                }
            });
        });
        req.on('error', reject);
        if (payload) {
            req.write(bodyStr);
        }
        req.end();
    });
}

async function runTest() {
    console.log("Starting Admin Cancellation Flow Integration Test...");

    // 1. Log in as admin to get session cookie
    console.log("Logging in as admin...");
    const loginRes = await makeRequest('POST', '/api/admin/login', { username: 'admin', password: 'password123' });
    assert.strictEqual(loginRes.status, 200, "Login should return 200");
    assert.strictEqual(loginRes.body.success, true, "Login should be successful");
    
    const setCookie = loginRes.headers['set-cookie'];
    assert(setCookie && setCookie.length > 0, "Should return session cookie");
    const cookie = setCookie[0].split(';')[0];
    console.log("✓ Logged in. Session cookie acquired:", cookie);

    // 2. Create a temporary booking in DB (status: 'PENDING' or 'QUOTED')
    const uniqueEmail = `test_cancel_${Date.now()}@domain.com`;
    const insertResult = await runCommand(
        `INSERT INTO bookings (name, email, cell, date, status, message, event_name, event_type, event_location, city, budget_range, popia_consent) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        ["Test Cancel Client", uniqueEmail, "0820000000", "2026-12-01", "QUOTED", "Test booking message", "Test Event", "Stand-Up Comedy", "Cape Town", "Cape Town", "R15000"]
    );
    const bookingId = insertResult.lastID;
    console.log(`✓ Temporary booking created with ID: ${bookingId}`);

    // 3. Trigger cancellation via POST /api/admin/bookings/:id/cancel
    const cancelPayload = {
        reason: "Test Cancellation Reason",
        cancelled_by: "client",
        notes: "Test cancellation notes for audit logs"
    };
    console.log(`Sending cancellation POST request for Booking #${bookingId}...`);
    const cancelRes = await makeRequest('POST', `/api/admin/bookings/${bookingId}/cancel`, cancelPayload, cookie);
    console.log("Cancellation response status:", cancelRes.status);
    console.log("Cancellation response body:", JSON.stringify(cancelRes.body, null, 2));

    assert.strictEqual(cancelRes.status, 200, "Cancel request should return 200");
    assert.strictEqual(cancelRes.body.success, true, "Cancel request should indicate success");

    // 4. Verify booking status in database is 'CANCELLED'
    const bookings = await runQuery("SELECT status FROM bookings WHERE id = ?", [bookingId]);
    assert(bookings.length > 0, "Booking should exist in DB");
    console.log("✓ Checked booking status in DB:", bookings[0].status);
    assert.strictEqual(bookings[0].status, 'CANCELLED', "Booking status should be CANCELLED");

    // 5. Fetch booking details via GET /api/admin/bookings/:id/details
    console.log(`Fetching booking details for Booking #${bookingId}...`);
    const detailsRes = await makeRequest('GET', `/api/admin/bookings/${bookingId}/details`, null, cookie);
    console.log("Details response status:", detailsRes.status);
    console.log("Details response body has cancellation:", !!detailsRes.body.cancellation);

    assert.strictEqual(detailsRes.status, 200, "Details request should return 200");
    const cancellation = detailsRes.body.cancellation;
    assert(cancellation, "Details response must contain cancellation object");
    console.log("✓ Cancellation details returned:", JSON.stringify(cancellation, null, 2));
    assert.strictEqual(cancellation.booking_id, bookingId, "Cancellation booking_id should match");
    assert.strictEqual(cancellation.cancelled_by, "client", "Cancellation cancelled_by should match");
    assert.strictEqual(cancellation.reason, "Test Cancellation Reason", "Cancellation reason should match");
    assert.strictEqual(cancellation.notes, "Test cancellation notes for audit logs", "Cancellation notes should match");

    // 6. Clean up temporary records
    console.log("Cleaning up temporary records...");
    await runCommand("DELETE FROM cancellations WHERE booking_id = ?", [bookingId]);
    await runCommand("DELETE FROM bookings WHERE id = ?", [bookingId]);
    console.log("✓ Cleanup finished.");

    console.log("\nALL TESTS PASSED SUCCESSFULLY! DOWNSTREAM VERIFICATION DONE.");
    process.exit(0);
}

runTest().catch(err => {
    console.error("Test FAILED:", err);
    process.exit(1);
});
