const path = require('path');
const fs = require('fs');
const assert = require('assert');

const projectDir = path.join(__dirname, '..');
const db = require(path.join(projectDir, 'database'));

function findOrCreateClient(name, email, phone, company, vat_number) {
    return new Promise((resolve, reject) => {
        db.run(
            "INSERT OR IGNORE INTO clients (full_name, email, phone, company_name, vat_number) VALUES (?, ?, ?, ?, ?)",
            [name || 'Unknown', email, phone || '0000000000', company || null, vat_number || null],
            function(insertErr) {
                if (insertErr) return reject(insertErr);
                db.get("SELECT id FROM clients WHERE LOWER(email) = LOWER(?)", [email], (err, row) => {
                    if (err || !row) return reject(err || new Error('Client record missing after upsert'));
                    if (company || vat_number) {
                        db.run("UPDATE clients SET company_name = COALESCE(?, company_name), vat_number = COALESCE(?, vat_number), updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                            [company, vat_number, row.id]);
                    }
                    resolve(row.id);
                });
            }
        );
    });
}

async function runTest() {
    console.log("Starting Manual Booking Relational Integrity Test...");

    // 1. Resolve a client
    const testEmail = `test_manual_${Date.now()}@domain.com`;
    const clientId = await findOrCreateClient("Test Manual Admin Client", testEmail, "0123456789", "Admin Corp", "1234567");
    console.log("✓ Successfully resolved/created client with ID:", clientId);
    assert(clientId > 0, "Client ID must be a positive integer");

    // 2. Insert manual booking using new fields
    const bookingPromise = new Promise((resolve, reject) => {
        db.run(
            `INSERT INTO bookings
                (name, company, email, cell, event_name, date, event_start_time,
                 event_type, event_location, city, venue_place_id, budget_range, message, status,
                 popia_consent, consent_timestamp, client_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'NEW', 1, CURRENT_TIMESTAMP, ?)`,
            [
                "Test Manual Admin Client", "Admin Corp", testEmail, "0123456789",
                "Private Show", "2026-10-10", "19:00", "Stand-Up Comedy",
                "Cape Town Comedy Club", "Cape Town", "ChIJw0vT-N9PzB0R...", "R20000",
                "Hello, I want to book Thabiso.", clientId
            ],
            function(err) {
                if (err) reject(err);
                else resolve(this.lastID);
            }
        );
    });

    const bookingId = await bookingPromise;
    console.log("✓ Successfully inserted manual booking with ID:", bookingId);
    assert(bookingId > 0, "Booking ID must be a positive integer");

    // 3. Verify that the booking is linked to the client in the database
    const bookingRow = await new Promise((resolve, reject) => {
        db.get("SELECT * FROM bookings WHERE id = ?", [bookingId], (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });

    console.log("✓ Verified database row has client_id:", bookingRow.client_id);
    assert.strictEqual(bookingRow.client_id, clientId, "Booking should be linked to the resolved client ID");

    // Clean up test data
    await new Promise((resolve) => {
        db.run("DELETE FROM bookings WHERE id = ?", [bookingId], () => {
            db.run("DELETE FROM clients WHERE id = ?", [clientId], () => {
                resolve();
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
