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
    console.log("Starting Google Places Venue Linking Integration Test...");

    // 1. Log in as admin to get session cookie
    console.log("Logging in as admin...");
    const loginRes = await makeRequest('POST', '/api/admin/login', { username: 'admin', password: 'password123' });
    assert.strictEqual(loginRes.status, 200, "Login should return 200");
    assert.strictEqual(loginRes.body.success, true, "Login should be successful");
    
    const setCookie = loginRes.headers['set-cookie'];
    assert(setCookie && setCookie.length > 0, "Should return session cookie");
    const cookie = setCookie[0].split(';')[0];
    console.log("✓ Logged in successfully.");

    // 2. Create a temporary booking in DB
    const uniqueEmail = `test_venue_${Date.now()}@domain.com`;
    const insertResult = await runCommand(
        `INSERT INTO bookings (name, email, cell, date, status, message, event_name, event_type, event_location, city, budget_range, popia_consent) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        ["Test Venue Client", uniqueEmail, "0820000000", "2026-12-05", "PENDING", "Test booking message", "Test Event", "Stand-Up Comedy", " Cape Town", "Cape Town", "R15000"]
    );
    const bookingId = insertResult.lastID;
    console.log(`✓ Temporary booking created with ID: ${bookingId}`);

    // 3. Link booking to a venue using Google Place details
    const testPlaceId = `test_place_linking_${Date.now()}`;
    const linkPayload = {
        place_id: testPlaceId,
        name: "Test Comedy Venue",
        address: "456 Gold St, Johannesburg",
        city: "Johannesburg",
        state: "Gauteng",
        country: "South Africa",
        latitude: -26.2041,
        longitude: 28.0473
    };

    console.log(`Sending PUT to /api/admin/bookings/${bookingId}/venue-google...`);
    const linkRes = await makeRequest('PUT', `/api/admin/bookings/${bookingId}/venue-google`, linkPayload, cookie);
    console.log("Response status:", linkRes.status);
    console.log("Response body:", JSON.stringify(linkRes.body, null, 2));

    assert.strictEqual(linkRes.status, 200, "Link request should return 200");
    assert.strictEqual(linkRes.body.success, true, "Link request should be successful");

    // 4. Verify venue creation and booking association in DB
    const venueRows = await runQuery("SELECT * FROM venues WHERE place_id = ?", [testPlaceId]);
    assert.strictEqual(venueRows.length, 1, "Venue should be created in venues table");
    const venue = venueRows[0];
    console.log("✓ Venue created in DB:", JSON.stringify(venue, null, 2));
    assert.strictEqual(venue.name, linkPayload.name);
    assert.strictEqual(venue.address, linkPayload.address);
    assert.strictEqual(venue.city, linkPayload.city);
    assert.strictEqual(venue.state, linkPayload.state);
    assert.strictEqual(venue.country, linkPayload.country);
    assert.strictEqual(venue.latitude, linkPayload.latitude);
    assert.strictEqual(venue.longitude, linkPayload.longitude);

    const bookingRows = await runQuery("SELECT * FROM bookings WHERE id = ?", [bookingId]);
    assert.strictEqual(bookingRows.length, 1, "Booking should exist");
    const booking = bookingRows[0];
    console.log("✓ Booking updated in DB:", JSON.stringify(booking, null, 2));
    assert.strictEqual(booking.venue_id, venue.id, "Booking venue_id should reference the resolved venue");
    assert.strictEqual(booking.venue_place_id, testPlaceId, "Booking venue_place_id should match");
    assert.strictEqual(booking.event_location, linkPayload.name, "Booking event_location should match venue name");
    assert.strictEqual(booking.venue_address, linkPayload.address, "Booking venue_address should match");
    assert.strictEqual(booking.city, linkPayload.city, "Booking city should match");
    assert.strictEqual(booking.country, linkPayload.country, "Booking country should match");

    // 5. Unlink venue from booking
    console.log(`Sending PUT to /api/admin/bookings/${bookingId}/venue with venue_id = null...`);
    const unlinkRes = await makeRequest('PUT', `/api/admin/bookings/${bookingId}/venue`, { venue_id: null }, cookie);
    console.log("Response status:", unlinkRes.status);
    console.log("Response body:", JSON.stringify(unlinkRes.body, null, 2));

    assert.strictEqual(unlinkRes.status, 200, "Unlink request should return 200");
    assert.strictEqual(unlinkRes.body.success, true, "Unlink request should be successful");

    // 6. Verify unlinked state in database
    const bookingRowsAfter = await runQuery("SELECT * FROM bookings WHERE id = ?", [bookingId]);
    const bookingAfter = bookingRowsAfter[0];
    console.log("✓ Booking state after unlinking:", JSON.stringify(bookingAfter, null, 2));
    assert.strictEqual(bookingAfter.venue_id, null, "venue_id should be NULL");
    assert.strictEqual(bookingAfter.venue_place_id, null, "venue_place_id should be NULL");
    assert.strictEqual(bookingAfter.venue_address, null, "venue_address should be NULL");
    assert.strictEqual(bookingAfter.city, null, "city should be NULL");
    assert.strictEqual(bookingAfter.country, null, "country should be NULL");

    // 7. Cleanup
    console.log("Cleaning up database test records...");
    await runCommand("DELETE FROM bookings WHERE id = ?", [bookingId]);
    await runCommand("DELETE FROM venues WHERE id = ?", [venue.id]);
    console.log("✓ Cleanup finished successfully.");

    console.log("\nALL TESTS PASSED SUCCESSFULLY!");
    process.exit(0);
}

runTest().catch(err => {
    console.error("Test FAILED:", err);
    process.exit(1);
});
