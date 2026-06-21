const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, '..', 'database.sqlite');
const testDate = `2027-11-${String(Math.floor(Math.random() * 18) + 10)}`;
const clientEmail = 'test_phase1_admin@example.com';
const baseUrl = 'http://localhost:3000';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function runTests() {
    console.log('=== STARTING PHASE 1 INTAKE GAPS VERIFICATION ===');

    // 1. Clean database for the test date
    await new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbPath, (err) => {
            if (err) return reject(err);
            db.serialize(() => {
                db.run("DELETE FROM bookings WHERE date = ?", [testDate]);
                db.run("DELETE FROM consent_audit WHERE booking_id IN (SELECT id FROM bookings WHERE date = ?)", [testDate]);
                db.run("DELETE FROM clients WHERE email IN (?, 'manual_test_email@example.com', 'late_test_email@example.com')", [clientEmail], () => {
                    db.close((closeErr) => {
                        if (closeErr) console.error('Error closing DB during clean:', closeErr);
                        resolve();
                    });
                });
            });
        });
    });
    console.log(`✓ Cleaned database for date: ${testDate}`);

    // 2. Submit valid booking via public route
    console.log('\n--- 2. Testing public booking creation ---');
    const publicPayload = {
        name: 'Public Test User',
        email: clientEmail,
        cell: '+27821112222',
        event_name: 'Public Event',
        event_date: testDate,
        event_start_time: '18:00',
        performance_slot: '18:00–19:00',
        performance_duration: '60 minutes',
        event_location: 'Public Arena',
        event_type: 'Comedy Club',
        message: 'This is a test message of sufficient length.',
        services: [{ service_id: 1, quantity_minutes: 60 }],
        popia_consent: true,
        policy_version: 'v2.2'
    };

    const pubRes = await fetch(`${baseUrl}/api/public/bookings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(publicPayload)
    });
    const pubJson = await pubRes.json();
    console.log('Public route response status:', pubRes.status);
    console.log('Public route response body:', pubJson);

    if (!pubRes.ok || !pubJson.success) {
        throw new Error('Public booking creation failed!');
    }

    const publicBookingId = pubJson.booking_id;
    console.log(`✓ Public booking created with ID: ${publicBookingId}`);

    // Verify DB fields for public booking
    await delay(100);
    await new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbPath, (err) => {
            if (err) return reject(err);
            db.get("SELECT popia_consent, consent_source, policy_version FROM bookings WHERE id = ?", [publicBookingId], (err, row) => {
                if (err) return reject(err);
                console.log('DB public booking check:', row);
                if (row.consent_source !== 'public_form') {
                    return reject(new Error(`Expected consent_source 'public_form', got ${row.consent_source}`));
                }
                if (row.popia_consent !== 1) {
                    return reject(new Error('Expected popia_consent 1'));
                }
                db.get("SELECT consent_source FROM consent_audit WHERE booking_id = ?", [publicBookingId], (err2, auditRow) => {
                    if (err2) return reject(err2);
                    console.log('DB public consent_audit check:', auditRow);
                    if (!auditRow || auditRow.consent_source !== 'public_form') {
                        return reject(new Error(`Expected consent_audit source 'public_form', got ${auditRow?.consent_source}`));
                    }
                    db.close(() => resolve());
                });
            });
        });
    });
    console.log('✓ Public booking DB verification passed.');

    // 3. Authenticate as admin to get session cookie
    console.log('\n--- 3. Authenticating as admin ---');
    const loginRes = await fetch(`${baseUrl}/api/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'password123' })
    });
    const loginJson = await loginRes.json();
    console.log('Login status:', loginRes.status);
    if (!loginRes.ok || !loginJson.success) {
        throw new Error('Admin login failed');
    }
    const cookie = loginRes.headers.get('set-cookie');
    console.log('✓ Admin authenticated successfully.');

    // 4. Test blocking of direct CONFIRMED manual creation
    console.log('\n--- 4. Testing block of manual booking creation with status: CONFIRMED ---');
    const confirmedPayload = {
        name: 'Confirmed Manual User',
        email: clientEmail,
        cell: '+27823334444',
        event_name: 'Confirmed Manual Event',
        event_date: testDate,
        event_start_time: '18:00',
        event_location: 'Confirmed Manual Hall',
        event_type: 'Comedy Club',
        status: 'CONFIRMED',
        message: 'This manual booking should be blocked due to status CONFIRMED.',
        services: [{ service_id: 1, quantity_minutes: 60 }]
    };

    const confRes = await fetch(`${baseUrl}/api/admin/bookings`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Cookie': cookie
        },
        body: JSON.stringify(confirmedPayload)
    });
    const confJson = await confRes.json();
    console.log('Block CONFIRMED response status:', confRes.status);
    console.log('Block CONFIRMED response body:', confJson);
    if (confRes.status !== 400 || confJson.success !== false) {
        throw new Error('Expected 400 Bad Request when creating CONFIRMED manual booking.');
    }
    console.log('✓ Verified: Manual creation with status: CONFIRMED was blocked.');

    // 5. Create a valid manual booking (should succeed)
    console.log('\n--- 5. Creating a valid manual booking ---');
    const validManualPayload = {
        name: 'Manual Test User',
        email: 'manual_test_email@example.com',
        cell: '+27823334444',
        event_name: 'Manual Event',
        event_date: testDate,
        event_start_time: '12:00',
        event_location: 'Manual Hall',
        event_type: 'Comedy Club',
        status: 'PENDING',
        message: 'This is a valid manual booking request.',
        services: [{ service_id: 1, quantity_minutes: 60 }],
        popia_consent: true
    };

    const valRes = await fetch(`${baseUrl}/api/admin/bookings`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Cookie': cookie
        },
        body: JSON.stringify(validManualPayload)
    });
    const valJson = await valRes.json();
    console.log('Valid manual response status:', valRes.status);
    console.log('Valid manual response body:', valJson);

    if (!valRes.ok || !valJson.success) {
        throw new Error('Failed to create valid manual booking');
    }
    const adminBookingId = valJson.booking_id;
    console.log(`✓ Manual booking created with ID: ${adminBookingId}`);

    // Verify DB fields for manual booking
    await delay(100);
    await new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbPath, (err) => {
            if (err) return reject(err);
            db.get("SELECT popia_consent, consent_source, status FROM bookings WHERE id = ?", [adminBookingId], (err, row) => {
                if (err) return reject(err);
                console.log('DB manual booking check:', row);
                if (row.consent_source !== 'admin_recorded') {
                    return reject(new Error(`Expected consent_source 'admin_recorded', got ${row.consent_source}`));
                }
                if (row.popia_consent !== 1) {
                    return reject(new Error('Expected popia_consent 1'));
                }
                if (row.status !== 'PENDING') {
                    return reject(new Error(`Expected status 'PENDING', got ${row.status}`));
                }
                db.get("SELECT consent_source FROM consent_audit WHERE booking_id = ?", [adminBookingId], (err2, auditRow) => {
                    if (err2) return reject(err2);
                    console.log('DB manual consent_audit check:', auditRow);
                    if (!auditRow || auditRow.consent_source !== 'admin_recorded') {
                        return reject(new Error(`Expected consent_audit source 'admin_recorded', got ${auditRow?.consent_source}`));
                    }
                    db.close(() => resolve());
                });
            });
        });
    });
    console.log('✓ Manual booking DB verification passed.');

    // 6. Test duplicate validation on manual booking (should return 409)
    console.log('\n--- 6. Testing duplicate validation on manual booking ---');
    const dupManualPayload = {
        name: 'Duplicate Manual User',
        email: clientEmail,
        cell: '+27823334444',
        event_name: 'Duplicate Event',
        event_date: testDate,
        event_start_time: '14:00',
        event_location: 'Manual Hall',
        event_type: 'Comedy Club',
        status: 'PENDING',
        message: 'This duplicate manual booking request should fail.',
        services: [{ service_id: 1, quantity_minutes: 60 }]
    };

    const dupManualRes = await fetch(`${baseUrl}/api/admin/bookings`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Cookie': cookie
        },
        body: JSON.stringify(dupManualPayload)
    });
    const dupManualJson = await dupManualRes.json();
    console.log('Duplicate manual response status:', dupManualRes.status);
    console.log('Duplicate manual response body:', dupManualJson);

    if (dupManualRes.status !== 409 || dupManualJson.duplicate !== true) {
        throw new Error('Expected 409 conflict duplicate booking error.');
    }
    console.log('✓ Verified: Duplicate manual booking was correctly rejected with 409.');

    // 7. Test overriding duplicate check (should succeed)
    console.log('\n--- 7. Testing duplicate override on manual booking ---');
    const overrideDupPayload = {
        ...dupManualPayload,
        override_duplicate: true
    };

    const ovDupRes = await fetch(`${baseUrl}/api/admin/bookings`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Cookie': cookie
        },
        body: JSON.stringify(overrideDupPayload)
    });
    const ovDupJson = await ovDupRes.json();
    console.log('Duplicate override response status:', ovDupRes.status);
    console.log('Duplicate override response body:', ovDupJson);

    if (!ovDupRes.ok || !ovDupJson.success) {
        throw new Error('Failed to create manual booking with duplicate override.');
    }
    const overriddenBookingId = ovDupJson.booking_id;
    console.log(`✓ Manual booking created with override ID: ${overriddenBookingId}`);

    // Verify audit log has the overrides saved
    await delay(100);
    await new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbPath, (err) => {
            if (err) return reject(err);
            db.get("SELECT new_values FROM audit_log WHERE record_id = ? AND action = 'CREATE'", [overriddenBookingId], (err, row) => {
                if (err) return reject(err);
                console.log('Audit log new_values payload:', row?.new_values);
                const parsed = JSON.parse(row?.new_values || '{}');
                if (!parsed.overrides || parsed.overrides.duplicate !== true) {
                    return reject(new Error('Audit log overrides was not logged correctly.'));
                }
                db.close(() => resolve());
            });
        });
    });
    console.log('✓ Audit log verification for duplicate override passed.');

    // 8. Test working hours validation on manual booking (e.g. 3am event_start_time)
    console.log('\n--- 8. Testing working hours validation on manual booking (3am start) ---');
    const badTimePayload = {
        name: 'Late Manual User',
        email: 'late_test_email@example.com',
        cell: '+27823334444',
        event_name: 'Late Event',
        event_date: testDate,
        event_start_time: '03:00',
        event_location: 'Manual Hall',
        event_type: 'Comedy Club',
        status: 'PENDING',
        message: 'This booking start time is 3am, which is outside working hours.',
        services: [{ service_id: 1, quantity_minutes: 60 }]
    };

    const badTimeRes = await fetch(`${baseUrl}/api/admin/bookings`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Cookie': cookie
        },
        body: JSON.stringify(badTimePayload)
    });
    const badTimeJson = await badTimeRes.json();
    console.log('Bad time response status:', badTimeRes.status);
    console.log('Bad time response body:', badTimeJson);

    if (badTimeRes.status !== 400 || badTimeJson.working_hours_violation !== true) {
        throw new Error('Expected 400 working hours violation response.');
    }
    console.log('✓ Verified: 3am manual booking was rejected with 400 due to working hours.');

    // 9. Test overriding working hours check (should succeed)
    console.log('\n--- 9. Testing working hours override on manual booking ---');
    const overrideTimePayload = {
        ...badTimePayload,
        override_working_hours: true,
        override_duplicate: true // date is duplicate as well
    };

    const ovTimeRes = await fetch(`${baseUrl}/api/admin/bookings`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Cookie': cookie
        },
        body: JSON.stringify(overrideTimePayload)
    });
    const ovTimeJson = await ovTimeRes.json();
    console.log('Working hours override response status:', ovTimeRes.status);
    console.log('Working hours override response body:', ovTimeJson);

    if (!ovTimeRes.ok || !ovTimeJson.success) {
        throw new Error('Failed to create manual booking with working hours override.');
    }
    const overriddenTimeBookingId = ovTimeJson.booking_id;
    console.log(`✓ Manual booking created with working hours override ID: ${overriddenTimeBookingId}`);

    // Verify audit log has the overrides saved
    await delay(100);
    await new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbPath, (err) => {
            if (err) return reject(err);
            db.get("SELECT new_values FROM audit_log WHERE record_id = ? AND action = 'CREATE'", [overriddenTimeBookingId], (err, row) => {
                if (err) return reject(err);
                console.log('Audit log new_values payload:', row?.new_values);
                const parsed = JSON.parse(row?.new_values || '{}');
                if (!parsed.overrides || parsed.overrides.working_hours !== true || parsed.overrides.duplicate !== true) {
                    return reject(new Error('Audit log overrides was not logged correctly.'));
                }
                db.close(() => resolve());
            });
        });
    });
    console.log('✓ Audit log verification for working hours override passed.');

    console.log('\n=== ALL PHASE 1 INTAKE GAPS VERIFICATION TESTS PASSED ===');
}

runTests().catch(err => {
    console.error('❌ Tests failed:', err.message);
    process.exit(1);
});
