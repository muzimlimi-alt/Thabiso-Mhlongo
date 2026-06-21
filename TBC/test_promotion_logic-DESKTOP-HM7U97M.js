const path = require('path');
const assert = require('assert');

const projectDir = path.join(__dirname, '..');
const db = require(path.join(projectDir, 'database'));

// Helper to run a query wrapped in a Promise
const runQuery = (sql, params = []) => {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function(err) {
            if (err) reject(err);
            else resolve(this);
        });
    });
};

const getRow = (sql, params = []) => {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
};

async function runTest() {
    console.log("Starting Booking Promotion Database Logic Test...");

    // 1. Insert a mock booking
    const bookingResult = await runQuery(
        `INSERT INTO bookings (name, company, email, cell, event_name, date, event_start_time, event_type, event_location, status, is_public, message)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACCEPTED', 0, ?)`,
        ["Promo Test Client", "Promo Corp", "test@promo.com", "0123456789", "Big Comedy Night", "2026-12-25", "20:00", "Stand-Up", "Soweto Theatre", "Test message"]
    );
    const bookingId = bookingResult.lastID;
    console.log(`✓ Inserted mock booking #${bookingId}`);

    // --- TEST 1: Toggle Promotion ON ---
    console.log("Testing Toggle Promotion ON...");
    const booking = await getRow("SELECT * FROM bookings WHERE id = ?", [bookingId]);
    assert(booking, "Booking must exist");

    const eventTime = booking.event_start_time || '19:00:00';
    const formattedTime = eventTime.includes(':') ? (eventTime.split(':').length === 2 ? `${eventTime}:00` : eventTime) : `${eventTime}:00:00`;
    const eventDatetime = `${booking.date}T${formattedTime}`;
    const venueName = booking.event_location || 'TBA';
    const eventTitle = booking.event_name || booking.event_type || 'Comedy Show';
    const eventDesc = booking.admin_notes || booking.notes || 'Public show';
    const ticketLink = "https://tickets.example.com/promo-test";

    // Simulate PUT /api/admin/bookings/:id/public (Toggling ON)
    const insertEventResult = await runQuery(
        `INSERT INTO events (event_title, event_description, event_datetime, venue_name, ticket_sales_link, booking_id, event_status)
         VALUES (?, ?, ?, ?, ?, ?, 'upcoming')`,
        [eventTitle, eventDesc, eventDatetime, venueName, ticketLink, bookingId]
    );
    const newEventId = insertEventResult.lastID;
    await runQuery(
        "UPDATE bookings SET is_public = 1, ticket_link = ?, event_id = ? WHERE id = ?",
        [ticketLink, newEventId, bookingId]
    );

    // Verify event row exists and has correct booking_id
    const eventRow = await getRow("SELECT * FROM events WHERE event_id = ?", [newEventId]);
    assert(eventRow, "Event row should exist");
    assert.strictEqual(eventRow.booking_id, bookingId, "Event should link to booking");
    assert.strictEqual(eventRow.ticket_sales_link, ticketLink, "Ticket link should match");

    // Verify booking row is updated
    const updatedBooking = await getRow("SELECT * FROM bookings WHERE id = ?", [bookingId]);
    assert.strictEqual(updatedBooking.is_public, 1, "Booking is_public should be 1");
    assert.strictEqual(updatedBooking.event_id, newEventId, "Booking event_id should link to event");
    console.log("✓ Toggle ON test passed.");

    // --- TEST 2: Toggle Promotion OFF ---
    console.log("Testing Toggle Promotion OFF...");
    // Simulate PUT /api/admin/bookings/:id/public (Toggling OFF)
    const bookingBeforeOff = await getRow("SELECT * FROM bookings WHERE id = ?", [bookingId]);
    if (bookingBeforeOff.event_id) {
        await runQuery("UPDATE bookings SET is_public = 0, ticket_link = NULL, event_id = NULL WHERE id = ?", [bookingId]);
        await runQuery("DELETE FROM events WHERE event_id = ?", [bookingBeforeOff.event_id]);
    }

    // Verify event is deleted
    const deletedEventRow = await getRow("SELECT * FROM events WHERE event_id = ?", [newEventId]);
    assert(!deletedEventRow, "Event row should be deleted");

    // Verify booking fields are cleared
    const bookingAfterOff = await getRow("SELECT * FROM bookings WHERE id = ?", [bookingId]);
    assert.strictEqual(bookingAfterOff.is_public, 0, "Booking is_public should be 0");
    assert.strictEqual(bookingAfterOff.event_id, null, "Booking event_id should be null");
    console.log("✓ Toggle OFF test passed.");

    // --- TEST 3: Status Transition Cleanup (e.g. CANCELLED) ---
    console.log("Testing Status Transition Cleanup...");
    // Toggle ON again to set up state
    const insertEventResult2 = await runQuery(
        `INSERT INTO events (event_title, event_description, event_datetime, venue_name, ticket_sales_link, booking_id, event_status)
         VALUES (?, ?, ?, ?, ?, ?, 'upcoming')`,
        [eventTitle, eventDesc, eventDatetime, venueName, ticketLink, bookingId]
    );
    const newEventId2 = insertEventResult2.lastID;
    await runQuery(
        "UPDATE bookings SET is_public = 1, ticket_link = ?, event_id = ? WHERE id = ?",
        [ticketLink, newEventId2, bookingId]
    );

    // Simulate status change cleanup like applyStatusChange:
    // "if (b.event_id && !['ACCEPTED', 'CONFIRMED', 'COMPLETED'].includes(requestedStatus))"
    const bookingBeforeCancel = await getRow("SELECT * FROM bookings WHERE id = ?", [bookingId]);
    const requestedStatus = 'CANCELLED';
    if (bookingBeforeCancel.event_id && !['ACCEPTED', 'CONFIRMED', 'COMPLETED'].includes(requestedStatus)) {
        await runQuery("UPDATE bookings SET is_public = 0, event_id = NULL WHERE id = ?", [bookingId]);
        await runQuery("DELETE FROM events WHERE event_id = ?", [bookingBeforeCancel.event_id]);
    }

    // Verify event is deleted
    const deletedEventRow2 = await getRow("SELECT * FROM events WHERE event_id = ?", [newEventId2]);
    assert(!deletedEventRow2, "Event row should be deleted on cancellation");

    // Verify booking fields are cleared
    const bookingAfterCancel = await getRow("SELECT * FROM bookings WHERE id = ?", [bookingId]);
    assert.strictEqual(bookingAfterCancel.is_public, 0, "Booking is_public should be 0 on cancellation");
    assert.strictEqual(bookingAfterCancel.event_id, null, "Booking event_id should be null on cancellation");
    console.log("✓ Status transition cleanup test passed.");

    // --- TEST 4: Delete Booking Cascade ---
    console.log("Testing Delete Booking Cascade...");
    // Toggle ON again to set up state
    const insertEventResult3 = await runQuery(
        `INSERT INTO events (event_title, event_description, event_datetime, venue_name, ticket_sales_link, booking_id, event_status)
         VALUES (?, ?, ?, ?, ?, ?, 'upcoming')`,
        [eventTitle, eventDesc, eventDatetime, venueName, ticketLink, bookingId]
    );
    const newEventId3 = insertEventResult3.lastID;
    await runQuery(
        "UPDATE bookings SET is_public = 1, ticket_link = ?, event_id = ? WHERE id = ?",
        [ticketLink, newEventId3, bookingId]
    );

    // Simulate DELETE route cascade targets:
    // "DELETE FROM events WHERE booking_id = ?"
    // "DELETE FROM bookings WHERE id = ?"
    await runQuery("UPDATE bookings SET event_id = NULL WHERE id = ?", [bookingId]);
    await runQuery("DELETE FROM events WHERE booking_id = ?", [bookingId]);
    await runQuery("DELETE FROM bookings WHERE id = ?", [bookingId]);

    // Verify event is deleted
    const deletedEventRow3 = await getRow("SELECT * FROM events WHERE event_id = ?", [newEventId3]);
    assert(!deletedEventRow3, "Event row should be cascade-deleted");

    // Verify booking is deleted
    const deletedBookingRow = await getRow("SELECT * FROM bookings WHERE id = ?", [bookingId]);
    assert(!deletedBookingRow, "Booking row should be deleted");
    console.log("✓ Delete booking cascade test passed.");

    console.log("ALL TESTS PASSED SUCCESSFULLY!");
    process.exit(0);
}

runTest().catch(err => {
    console.error("Test FAILED:", err);
    process.exit(1);
});
