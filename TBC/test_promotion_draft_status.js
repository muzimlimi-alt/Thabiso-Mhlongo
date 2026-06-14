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
    console.log("Starting Booking Promotion Draft Status Integration Test...");

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
    const uniqueEmail = `test_draft_${Date.now()}@domain.com`;
    const insertResult = await runCommand(
        `INSERT INTO bookings (name, email, cell, date, status, message, event_name, event_type, event_location, city, budget_range, popia_consent) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        ["Test Draft Promo", uniqueEmail, "0821111111", "2026-12-10", "ACCEPTED", "Test draft promo message", "Comedian Special", "Stand-Up Comedy", "Johannesburg Theatre", "Johannesburg", "R20000"]
    );
    const bookingId = insertResult.lastID;
    console.log(`✓ Temporary booking created with ID: ${bookingId}`);

    // 3. Promote booking (Toggle ON) -> Should create event with status = 'draft'
    console.log(`Sending PUT to /api/admin/bookings/${bookingId}/public to promote...`);
    const promoteRes = await makeRequest('PUT', `/api/admin/bookings/${bookingId}/public`, { is_public: 1, ticket_link: "https://tickets.example.com/draft-show" }, cookie);
    assert.strictEqual(promoteRes.status, 200, "Promote should return 200");
    assert.strictEqual(promoteRes.body.success, true, "Promote should succeed");
    
    // 4. Retrieve and verify created event status in DB
    const bookingRows = await runQuery("SELECT event_id FROM bookings WHERE id = ?", [bookingId]);
    const eventId = bookingRows[0].event_id;
    assert(eventId, "Booking should have a linked event_id");
    
    const eventRows = await runQuery("SELECT * FROM events WHERE event_id = ?", [eventId]);
    const event = eventRows[0];
    console.log("✓ Event created in DB:", JSON.stringify(event, null, 2));
    assert.strictEqual(event.event_status, 'draft', "Newly promoted event status should be 'draft'");

    // 5. Query public events endpoint -> draft event should NOT be present
    console.log("Fetching public events feed from /api/public/events...");
    const publicEventsRes = await makeRequest('GET', '/api/public/events');
    assert.strictEqual(publicEventsRes.status, 200, "Public feed should return 200");
    const publicEvents = publicEventsRes.body;
    const isPresentInPublic = publicEvents.some(e => e.event_id === eventId && e.source === 'event');
    console.log("✓ Is event present in public feed?", isPresentInPublic);
    assert.strictEqual(isPresentInPublic, false, "Draft event must not appear on public feed");

    // 6. Update the event status to 'upcoming' (Simulate editing and saving in events manager)
    console.log(`Sending PUT to /api/admin/events/${eventId} to publish...`);
    const updatePayload = {
        event_title: "Comedian Special Live",
        event_description: "Thabiso Mhlongo special comedy show.",
        event_datetime: "2026-12-10T20:00",
        venue_name: "Johannesburg Theatre",
        venue_id: null,
        venue_map_link: "https://maps.google.com/?q=Johannesburg+Theatre",
        ticket_sales_link: "https://tickets.example.com/draft-show",
        poster_image_path: "images/events/test_poster.jpg",
        event_status: "upcoming",
        booking_id: bookingId
    };
    const updateRes = await makeRequest('PUT', `/api/admin/events/${eventId}`, updatePayload, cookie);
    assert.strictEqual(updateRes.status, 200, "Update should return 200");
    assert.strictEqual(updateRes.body.success, true, "Update should succeed");

    // 7. Verify status in DB is now 'upcoming'
    const eventRowsAfter = await runQuery("SELECT * FROM events WHERE event_id = ?", [eventId]);
    console.log("✓ Event status in DB after update:", eventRowsAfter[0].event_status);
    assert.strictEqual(eventRowsAfter[0].event_status, 'upcoming', "Event status should be updated to 'upcoming'");

    // 8. Query public events endpoint again -> event should now be present
    console.log("Re-fetching public events feed...");
    const publicEventsResAfter = await makeRequest('GET', '/api/public/events');
    const publicEventsAfter = publicEventsResAfter.body;
    const isPresentInPublicAfter = publicEventsAfter.some(e => e.event_id === eventId && e.source === 'event');
    console.log("✓ Is event present in public feed after update?", isPresentInPublicAfter);
    assert.strictEqual(isPresentInPublicAfter, true, "Published event must appear in public feed");

    // 9. Cleanup
    console.log("Cleaning up database test records...");
    await runCommand("DELETE FROM bookings WHERE id = ?", [bookingId]);
    await runCommand("DELETE FROM events WHERE event_id = ?", [eventId]);
    console.log("✓ Cleanup finished successfully.");

    console.log("\nALL DRAFT PROMOTION TESTS PASSED SUCCESSFULLY!");
    process.exit(0);
}

runTest().catch(err => {
    console.error("Test FAILED:", err);
    process.exit(1);
});
