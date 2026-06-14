const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const http = require('http');

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
        if (cookie) headers['Cookie'] = cookie;
        if (payload) headers['Content-Length'] = Buffer.byteLength(bodyStr);

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
        if (payload) req.write(bodyStr);
        req.end();
    });
}

async function runDebug() {
    console.log("Logging in...");
    const loginRes = await makeRequest('POST', '/api/admin/login', { username: 'admin', password: 'password123' });
    const cookie = loginRes.headers['set-cookie'][0].split(';')[0];

    console.log("Creating temporary booking...");
    const uniqueEmail = `debug_cancel_${Date.now()}@domain.com`;
    const insertResult = await runCommand(
        `INSERT INTO bookings (name, email, cell, date, status, message, event_name, event_type, event_location, city, budget_range, popia_consent) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        ["Test Debug Client", uniqueEmail, "0820000000", "2026-12-01", "QUOTED", "Test debug message", "Test Event", "Stand-Up Comedy", "Cape Town", "Cape Town", "R15000"]
    );
    const bookingId = insertResult.lastID;
    console.log(`Booking ID created: ${bookingId}`);

    console.log("Executing cancellation via API...");
    const cancelRes = await makeRequest('POST', `/api/admin/bookings/${bookingId}/cancel`, {
        reason: "Debug Reason",
        cancelled_by: "client",
        notes: "Debug Notes"
    }, cookie);
    console.log("Cancel API Response:", JSON.stringify(cancelRes.body, null, 2));

    console.log("Querying database cancellations table directly...");
    const cancellations = await runQuery("SELECT * FROM cancellations WHERE booking_id = ?", [bookingId]);
    console.log("Cancellations row in DB:", JSON.stringify(cancellations, null, 2));

    console.log("Querying details via API...");
    const detailsRes = await makeRequest('GET', `/api/admin/bookings/${bookingId}/details`, null, cookie);
    console.log("Details API Response:", JSON.stringify(detailsRes.body, null, 2));

    console.log("Cleaning up...");
    await runCommand("DELETE FROM cancellations WHERE booking_id = ?", [bookingId]);
    await runCommand("DELETE FROM bookings WHERE id = ?", [bookingId]);
    db.close();
}

runDebug().catch(console.error);
