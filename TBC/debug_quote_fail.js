const path = require('path');
const db = require(path.join(__dirname, '..', 'database'));

function findOrCreateClient(name, email, phone, company, vat_number) {
    return new Promise((resolve, reject) => {
        db.run(
            "INSERT OR IGNORE INTO clients (full_name, email, phone, company_name, vat_number) VALUES (?, ?, ?, ?, ?)",
            [name || 'Unknown', email, phone || '0000000000', company || null, vat_number || null],
            function(insertErr) {
                if (insertErr) return reject(insertErr);
                db.get("SELECT id FROM clients WHERE LOWER(email) = LOWER(?)", [email], (err, row) => {
                    if (err || !row) return reject(err || new Error('Client record missing after upsert'));
                    resolve(row.id);
                });
            }
        );
    });
}

async function testQuoteFlow() {
    const bookingId = 68;
    console.log("Fetching booking details for ID:", bookingId);
    
    db.get(`
        SELECT b.*, c.full_name as client_name, c.email as client_email, c.phone as client_phone, c.company_name as client_company
        FROM bookings b
        LEFT JOIN clients c ON b.client_id = c.id
        WHERE b.id = ?
    `, [bookingId], async (err, booking) => {
        if (err || !booking) {
            console.error("Booking load failed:", err || "Not found");
            process.exit(1);
        }
        
        console.log("Loaded booking:", JSON.stringify(booking, null, 2));

        booking.name = booking.client_name || booking.name;
        booking.email = booking.client_email || booking.email;
        booking.cell = booking.client_phone || booking.cell;
        booking.company = booking.client_company || booking.company;

        let clientId = booking.client_id;
        if (!clientId) {
            console.log("Client ID is missing. Creating/Resolving client...");
            try {
                clientId = await findOrCreateClient(booking.name, booking.email, booking.cell, booking.company, booking.vat_number);
                console.log("Resolved clientId:", clientId);
                
                await new Promise((resolve, reject) => {
                    db.run("UPDATE bookings SET client_id = ? WHERE id = ?", [clientId, bookingId], err => {
                        if (err) reject(err);
                        else {
                            console.log("Updated booking client_id to:", clientId);
                            resolve();
                        }
                    });
                });
                booking.client_id = clientId;
            } catch (e) {
                console.error("Failed to resolve client:", e);
                process.exit(1);
            }
        } else {
            console.log("Booking already has client_id:", clientId);
        }

        // Test insertion of quote inside a transaction
        db.serialize(() => {
            db.run("BEGIN TRANSACTION");

            const pdfFileName = `QT-TEST-${Date.now()}.pdf`;
            const pdfNumber = `QT-${Date.now()}`;
            const quote_expiry_date = "2026-06-05";
            const finalTotal = 23000.00;
            const nextVersion = 1;

            console.log("Inserting quotation record with:");
            console.log(`bookingId: ${bookingId}`);
            console.log(`pdfNumber: ${pdfNumber}`);
            console.log(`clientId: ${booking.client_id}`);
            console.log(`quote_expiry_date: ${quote_expiry_date}`);
            console.log(`finalTotal: ${finalTotal}`);
            console.log(`pdfFileName: ${pdfFileName}`);
            console.log(`nextVersion: ${nextVersion}`);

            db.run(
                "INSERT INTO quotations (booking_id, quote_number, client_id, quote_date, expiry_date, total_amount, status, file_path, version, archived) VALUES (?, ?, ?, CURRENT_DATE, ?, ?, 'sent', ?, ?, 0)",
                [bookingId, pdfNumber, booking.client_id || 0, quote_expiry_date, finalTotal, pdfFileName, nextVersion],
                function(insErr) {
                    if (insErr) {
                        console.error("Failed to insert quotation:", insErr.message);
                        db.run("ROLLBACK");
                        process.exit(1);
                    } else {
                        console.log("Quotation inserted successfully! ID:", this.lastID);
                        db.run("COMMIT");
                        console.log("Transaction committed. Test PASSED!");
                        process.exit(0);
                    }
                }
            );
        });
    });
}

testQuoteFlow();
