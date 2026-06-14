const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, '..', 'database.sqlite');
const testDate = '2026-06-15';

async function runTests() {
    console.log('--- STARTING SCHEDULING TIGHTENING VERIFICATION TESTS ---');

    // 1. Clean database for the test date
    await new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbPath, (err) => {
            if (err) return reject(err);
            db.serialize(() => {
                db.run("DELETE FROM bookings WHERE date = ?", [testDate]);
                db.run("DELETE FROM date_holds WHERE hold_date = ?", [testDate]);
                db.run("DELETE FROM clients WHERE email = 'client@example.com'", () => {
                    db.close((closeErr) => {
                        if (closeErr) console.error('Error closing DB during clean:', closeErr);
                        resolve();
                    });
                });
            });
        });
    });
    console.log(`✓ Cleaned DB: Removed all bookings and holds on ${testDate}`);

    const baseUrl = 'http://localhost:3000';

    // 2. Fetch public booking config (GET /api/public/booking-config?dow=1)
    console.log('\n2. Testing public booking config GET...');
    const configRes = await fetch(`${baseUrl}/api/public/booking-config?dow=1`);
    const configJson = await configRes.json();
    console.log('GET /api/public/booking-config?dow=1 output:', JSON.stringify(configJson, null, 2));
    if (!configJson.working_hours_start || !configJson.working_hours_end) {
        throw new Error('Public booking config did not return working hours!');
    }

    // 3. Admin Login
    console.log('\n3. Testing Admin Login...');
    const loginRes = await fetch(`${baseUrl}/api/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'admin' })
    });
    const loginJson = await loginRes.json();
    console.log('Login response:', JSON.stringify(loginJson, null, 2));
    if (!loginRes.ok || !loginJson.success) {
        throw new Error('Admin login failed');
    }
    const cookie = loginRes.headers.get('set-cookie');
    if (!cookie) {
        throw new Error('Session cookie not returned by login endpoint');
    }
    console.log('✓ Successfully logged in as Admin. Session Cookie acquired.');

    // 4. Save working hours (PUT /api/admin/working-hours)
    console.log('\n4. Testing admin working hours save (PUT)...');
    const schedule = [
        { day_of_week: 0, start_time: '09:00', end_time: '22:00', is_working_day: true },
        { day_of_week: 1, start_time: '08:00', end_time: '20:00', is_working_day: true }, // Monday overridden
        { day_of_week: 2, start_time: '09:00', end_time: '22:00', is_working_day: true },
        { day_of_week: 3, start_time: '09:00', end_time: '22:00', is_working_day: true },
        { day_of_week: 4, start_time: '09:00', end_time: '22:00', is_working_day: true },
        { day_of_week: 5, start_time: '09:00', end_time: '22:00', is_working_day: true },
        { day_of_week: 6, start_time: '09:00', end_time: '22:00', is_working_day: true }
    ];
    const putRes = await fetch(`${baseUrl}/api/admin/working-hours`, {
        method: 'PUT',
        headers: {
            'Content-Type': 'application/json',
            'Cookie': cookie
        },
        body: JSON.stringify({ schedule, min_booking_gap_minutes: 30 })
    });
    const putJson = await putRes.json();
    console.log('PUT /api/admin/working-hours response:', JSON.stringify(putJson, null, 2));
    if (!putRes.ok || !putJson.success) {
        throw new Error('Failed to update working hours');
    }

    // Verify config was updated
    const verifyConfigRes = await fetch(`${baseUrl}/api/public/booking-config?dow=1`);
    const verifyConfigJson = await verifyConfigRes.json();
    console.log('Verify GET /api/public/booking-config?dow=1 output:', JSON.stringify(verifyConfigJson, null, 2));
    if (verifyConfigJson.working_hours_start !== '08:00' || verifyConfigJson.working_hours_end !== '20:00') {
        throw new Error('Working hours were not updated correctly!');
    }
    console.log('✓ Working hours successfully updated and verified.');

    // 5. Submit first booking (10:00 to 11:00)
    console.log('\n5. Submitting first booking request (10:00 - 11:00)...');
    const bookingBody1 = {
        name: 'Test Client',
        email: 'client@example.com',
        cell: '0821234567',
        event_name: 'First Test Event',
        event_date: testDate,
        event_start_time: '10:00',
        performance_duration: '60',
        event_location: 'Test Venue',
        event_type: 'Performance',
        message: 'This is test booking number one.',
        popia_consent: true,
        services: [{ service_id: 1, quantity_minutes: 60 }]
    };
    const bRes1 = await fetch(`${baseUrl}/api/public/bookings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bookingBody1)
    });
    const bJson1 = await bRes1.json();
    console.log('Booking 1 response:', JSON.stringify(bJson1, null, 2));
    if (!bRes1.ok || !bJson1.success) {
        throw new Error('First booking submission failed');
    }
    const bookingId1 = bJson1.booking_id;
    console.log(`✓ Booking 1 created with ID: ${bookingId1}`);

    // Verify performance_end_time in DB
    const bookingDbRow1 = await new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbPath, (err) => {
            if (err) return reject(err);
            db.get("SELECT event_start_time, performance_end_time FROM bookings WHERE id = ?", [bookingId1], (err, row) => {
                db.close();
                if (err) reject(err); else resolve(row);
            });
        });
    });
    console.log('Booking 1 DB Row:', JSON.stringify(bookingDbRow1, null, 2));
    if (bookingDbRow1.performance_end_time !== '11:30') {
        throw new Error(`Expected performance_end_time to be '11:30', got '${bookingDbRow1.performance_end_time}'`);
    }
    console.log('✓ performance_end_time successfully populated as 11:30.');

    // 6. Submit conflicting booking (10:30 - 11:30)
    console.log('\n6. Submitting conflicting booking request (10:30 - 11:30) - should fail with 409...');
    const bookingBody2 = {
        name: 'Conflict Client',
        email: 'conflict@example.com',
        cell: '0821234567',
        event_name: 'Conflicting Event',
        event_date: testDate,
        event_start_time: '10:30',
        performance_duration: '60',
        event_location: 'Test Venue',
        event_type: 'Performance',
        message: 'This booking should conflict and fail.',
        popia_consent: true,
        services: [{ service_id: 1, quantity_minutes: 60 }]
    };
    const bRes2 = await fetch(`${baseUrl}/api/public/bookings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bookingBody2)
    });
    const bJson2 = await bRes2.json();
    console.log(`Booking 2 response (Status ${bRes2.status}):`, JSON.stringify(bJson2, null, 2));
    if (bRes2.status !== 409) {
        throw new Error(`Expected status 409 for conflict, but got ${bRes2.status}`);
    }
    console.log('✓ Booking conflict correctly rejected with 409.');

    // 7. Submit same-client booking at different time on same day (14:00 - 15:00)
    console.log('\n7. Submitting second booking from the same client on the same day (14:00 - 15:00) - should succeed...');
    const bookingBody3 = {
        name: 'Test Client',
        email: 'client@example.com', // SAME EMAIL
        cell: '0821234567',
        event_name: 'Second Test Event',
        event_date: testDate, // SAME DATE
        event_start_time: '14:00',
        performance_duration: '60',
        event_location: 'Test Venue',
        event_type: 'Performance',
        message: 'This is the same client booking on the same day at a different time.',
        popia_consent: true,
        services: [{ service_id: 1, quantity_minutes: 60 }]
    };
    const bRes3 = await fetch(`${baseUrl}/api/public/bookings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bookingBody3)
    });
    const bJson3 = await bRes3.json();
    console.log('Booking 3 response:', JSON.stringify(bJson3, null, 2));
    if (!bRes3.ok || !bJson3.success) {
        throw new Error('Same-client same-day non-overlapping booking failed');
    }
    const bookingId3 = bJson3.booking_id;
    console.log(`✓ Booking 3 created successfully with ID: ${bookingId3}`);

    // 8. Verify admin calendar events endpoint GET /api/admin/calendar/events
    console.log('\n8. Verifying admin calendar events endpoint GET /api/admin/calendar/events...');
    const calRes = await fetch(`${baseUrl}/api/admin/calendar/events?start=${testDate}&end=${testDate}`, {
        method: 'GET',
        headers: { 'Cookie': cookie }
    });
    const calJson = await calRes.json();
    console.log('Calendar events returned:', JSON.stringify(calJson, null, 2));
    const bookingEvents = calJson.filter(e => e.extendedProps && e.extendedProps.dbId && (e.extendedProps.dbId.toString() === bookingId1.toString() || e.extendedProps.dbId.toString() === bookingId3.toString()));
    console.log('Filtered calendar events for our test bookings:', JSON.stringify(bookingEvents, null, 2));
    if (bookingEvents.length !== 2) {
        throw new Error(`Expected 2 calendar events for our bookings, but found ${bookingEvents.length}`);
    }
    bookingEvents.forEach(e => {
        if (!e.end) {
            throw new Error(`Calendar event for booking #${e.id} is missing 'end' property!`);
        }
    });
    console.log('✓ Calendar events correctly returned timed events with correct end times.');

    // 9. Verify drag-and-drop patching date AND time
    console.log('\n9. Testing PATCH /api/admin/bookings/:id/date with updated date and time...');
    const patchRes = await fetch(`${baseUrl}/api/admin/bookings/${bookingId3}/date`, {
        method: 'PATCH',
        headers: {
            'Content-Type': 'application/json',
            'Cookie': cookie
        },
        body: JSON.stringify({ date: testDate, time: '16:30' })
    });
    const patchJson = await patchRes.json();
    console.log('PATCH booking date/time response:', JSON.stringify(patchJson, null, 2));
    if (!patchRes.ok || !patchJson.success) {
        throw new Error('PATCH booking date/time failed');
    }
    // Verify changes in DB
    const bookingDbRow3 = await new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbPath, (err) => {
            if (err) return reject(err);
            db.get("SELECT event_start_time, performance_end_time FROM bookings WHERE id = ?", [bookingId3], (err, row) => {
                db.close();
                if (err) reject(err); else resolve(row);
            });
        });
    });
    console.log('Booking 3 DB Row after PATCH:', JSON.stringify(bookingDbRow3, null, 2));
    if (bookingDbRow3.event_start_time !== '16:30' || bookingDbRow3.performance_end_time !== '17:30') {
        throw new Error(`Expected start '16:30' and end '17:30', got start '${bookingDbRow3.event_start_time}' and end '${bookingDbRow3.performance_end_time}'`);
    }
    console.log('✓ Booking patch successfully updated date and start/end time.');

    console.log('\n--- ALL SCHEDULING TIGHTENING VERIFICATION TESTS PASSED SUCCESSFULLY! ---');
}

runTests().catch(err => {
    console.error('\n❌ TEST FAILED:', err);
    process.exit(1);
});
