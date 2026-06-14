const db = require('../database');

db.get("SELECT id FROM clients LIMIT 1", [], (err, client) => {
    if (err) throw err;
    if (!client) {
        console.error("No clients found in the database. Cannot create a test quote.");
        db.close();
        return;
    }
    const clientId = client.id;
    const quoteNo = 'QT-TEST-' + Math.floor(Math.random() * 100000);

    db.run(
        `INSERT INTO quotations (quote_number, client_id, status, subtotal, tax_amount, total_amount)
         VALUES (?, ?, 'draft', 35000, 0, 35000)`,
        [quoteNo, clientId],
        function(err) {
            if (err) throw err;
            const quoteId = this.lastID;
            console.log(`Created test draft quotation ID ${quoteId} with number ${quoteNo}`);

            db.run(
                `INSERT INTO quote_line_items (quotation_id, service_id, description, quantity, unit_price)
                 VALUES (?, 1, 'Stand-Up Comedy – Headline Set (60 min)', 1, 35000)`,
                [quoteId],
                function(err) {
                    if (err) throw err;
                    console.log(`Created test quote line item referencing service ID 1`);
                    db.close();
                }
            );
        }
    );
});
