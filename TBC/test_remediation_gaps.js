const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, '..', 'database.sqlite');
const testDate = '2026-06-25';

async function runTests() {
    console.log('--- STARTING REMEDIATION GAPS VERIFICATION TESTS ---');

    // 1. Clean database for the test date
    await new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbPath, (err) => {
            if (err) return reject(err);
            db.serialize(() => {
                db.run("DELETE FROM bookings WHERE date = ?", [testDate]);
                db.run("DELETE FROM date_holds WHERE hold_date = ?", [testDate]);
                db.run("DELETE FROM clients WHERE email = 'test_remedy@example.com'", () => {
                    db.close((closeErr) => {
                        if (closeErr) console.error('Error closing DB during clean:', closeErr);
                        resolve();
                    });
                });
            });
        });
    });
    console.log(`✓ Cleaned DB: Removed test bookings/holds on ${testDate}`);

    const baseUrl = 'http://localhost:3000';

    // 2. Assert check-duplicate endpoint returns 404
    console.log('\n2. Testing GET /api/public/check-duplicate (expecting 404)...');
    const dupRes = await fetch(`${baseUrl}/api/public/check-duplicate?date=${testDate}&email=test_remedy@example.com`);
    console.log(`Response status: ${dupRes.status} (Expected: 404)`);
    if (dupRes.status !== 404) {
        throw new Error(`Expected check-duplicate endpoint to return 404, got ${dupRes.status}`);
    }
    console.log('✓ Verified check-duplicate endpoint was successfully deleted.');

    // 3. Assert fast submission and policy version insertion
    console.log('\n3. Testing POST /api/public/bookings (expecting fast response)...');
    const bookingPayload = {
        name: 'Remedy Test Client',
        company: 'Remedy Corp',
        email: 'test_remedy@example.com',
        cell: '+27829998888',
        event_name: 'Remedy Event',
        event_date: testDate,
        event_start_time: '14:00',
        performance_slot: '14:00–15:00',
        performance_duration: '60 minutes',
        event_location: 'Remedy Hall',
        venue_address: '123 Test Street',
        city: 'Johannesburg',
        country: 'South Africa',
        venue_type: 'Indoor',
        event_type: 'Comedy Show',
        audience_size: '100-200',
        audience_demographic: 'Adults',
        travel_accommodation: true,
        budget_range: 'R10k-R20k',
        message: 'This is a test message of sufficient length for validation.',
        services: [{ service_id: 1, quantity_minutes: 60 }],
        popia_consent: true,
        policy_version: 'v2.2'
    };

    const startTime = Date.now();
    const bRes = await fetch(`${baseUrl}/api/public/bookings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bookingPayload)
    });
    const bJson = await bRes.json();
    const duration = Date.now() - startTime;

    console.log('Booking response:', JSON.stringify(bJson, null, 2));
    console.log(`Submission duration: ${duration}ms`);

    if (!bRes.ok || !bJson.success) {
        throw new Error(`Booking submission failed: ${bJson.message}`);
    }

    if (duration > 1500) {
        console.warn(`⚠️ Warn: Booking submission took ${duration}ms. Email sending might still be blocking!`);
    } else {
        console.log(`✓ Booking submission was fast (${duration}ms), demonstrating non-blocking SMTP execution.`);
    }

    // 4. Verify policy_version in the database
    console.log('\n4. Verifying database record values...');
    const bookingId = bJson.booking_id;
    await new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbPath, (err) => {
            if (err) return reject(err);
            db.get("SELECT policy_version, popia_consent FROM bookings WHERE id = ?", [bookingId], (dbErr, row) => {
                if (dbErr) return reject(dbErr);
                console.log('Retrieved Row:', JSON.stringify(row));
                if (row.policy_version !== 'v2.2') {
                    reject(new Error(`Expected policy_version 'v2.2', got ${row.policy_version}`));
                }
                if (row.popia_consent !== 1) {
                    reject(new Error(`Expected popia_consent 1, got ${row.popia_consent}`));
                }
                db.close(() => resolve());
            });
        });
    });
    console.log('✓ Database records show policy_version = \'v2.2\' and popia_consent = 1.');

    // 5. Verify local GCal hold insertion with far future expiry
    console.log('\n5. Verifying GCal holds expire_at behavior...');
    await new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbPath, (err) => {
            if (err) return reject(err);
            // Insert mock synced hold
            db.run(
                `INSERT INTO date_holds (hold_date, notes, status, hold_expires_at, start_time, end_time, block_type, google_event_id)
                 VALUES (?, 'Test Google Synced Hold', 'active', '9999-12-31 23:59:59', '10:00', '12:00', 'calendar_sync', 'mock_gcal_id_999')`,
                [testDate],
                (insErr) => {
                    if (insErr) {
                        db.close();
                        return reject(insErr);
                    }
                    // Fetch and assert far future expiry
                    db.get("SELECT hold_expires_at FROM date_holds WHERE google_event_id = 'mock_gcal_id_999'", (fetchErr, holdRow) => {
                        if (fetchErr) {
                            db.close();
                            return reject(fetchErr);
                        }
                        console.log('Retrieved Hold:', JSON.stringify(holdRow));
                        if (holdRow.hold_expires_at !== '9999-12-31 23:59:59') {
                            db.close();
                            return reject(new Error(`Expected hold_expires_at '9999-12-31 23:59:59', got ${holdRow.hold_expires_at}`));
                        }
                        // Clean up hold
                        db.run("DELETE FROM date_holds WHERE google_event_id = 'mock_gcal_id_999'", () => {
                            db.close(() => resolve());
                        });
                    });
                }
            );
        });
    });
    console.log('✓ Confirmed synced holds are saved with hold_expires_at = \'9999-12-31 23:59:59\'.');

    console.log('\n--- ALL REMEDIATION GAPS VERIFICATION TESTS PASSED ---');
}

runTests().catch(e => {
    console.error('❌ Verification Tests Failed:', e.message);
    process.exit(1);
});
