const path = require('path');
const assert = require('assert');

const projectDir = path.join(__dirname, '..');
const db = require(path.join(projectDir, 'database'));

async function runTest() {
    console.log("Starting Revision Request Booking Note Test...");

    // 1. Create a dummy client and booking in QUOTED status
    const clientId = await new Promise((resolve, reject) => {
        db.run("INSERT INTO clients (full_name, email, phone) VALUES (?, ?, ?)",
            ["Revision Client", "revision@example.com", "0999999999"],
            function(err) {
                if (err) reject(err);
                else resolve(this.lastID);
            }
        );
    });
    console.log("✓ Created client with ID:", clientId);

    const bookingId = await new Promise((resolve, reject) => {
        db.run("INSERT INTO bookings (name, email, cell, date, event_name, event_type, event_location, message, status, client_id) VALUES (?, ?, ?, '2026-07-07', 'Revision Show', 'Corporate Show', 'V&A Waterfront', 'Test message', 'QUOTED', ?)",
            ["Revision Client", "revision@example.com", "0999999999", clientId],
            function(err) {
                if (err) reject(err);
                else resolve(this.lastID);
            }
        );
    });
    console.log("✓ Created booking with ID:", bookingId);

    // 2. Simulate inserting a revision note
    const typeLabel = "Quote Revision";
    const clientMessage = "I would like a 10% discount on the line items please.";
    const noteText = `[${typeLabel} Request]\n"${clientMessage}"`;

    await new Promise((resolve, reject) => {
        db.run(
            "INSERT INTO booking_notes (booking_id, note, author) VALUES (?, ?, 'Client')",
            [bookingId, noteText],
            function(err) {
                if (err) reject(err);
                else resolve();
            }
        );
    });
    console.log("✓ Inserted client revision note into booking_notes");

    // 3. Query notes for this booking and assert
    const notes = await new Promise((resolve, reject) => {
        db.all("SELECT * FROM booking_notes WHERE booking_id = ?", [bookingId], (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });

    console.log("✓ Retrieved notes from database:", JSON.stringify(notes, null, 2));
    assert.strictEqual(notes.length, 1);
    assert.strictEqual(notes[0].author, "Client");
    assert.strictEqual(notes[0].note, noteText);

    // 4. Clean up test data
    await new Promise((resolve) => {
        db.run("DELETE FROM booking_notes WHERE booking_id = ?", [bookingId], () => {
            db.run("DELETE FROM bookings WHERE id = ?", [bookingId], () => {
                db.run("DELETE FROM clients WHERE id = ?", [clientId], () => {
                    resolve();
                });
            });
        });
    });

    console.log("✓ Cleanup complete. Test PASSED!");
    process.exit(0);
}

runTest().catch(err => {
    console.error("Test FAILED:", err);
    process.exit(1);
});
