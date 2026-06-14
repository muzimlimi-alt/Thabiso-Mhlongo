const db = require('../database');

db.all("SELECT id, name, default_price FROM services LIMIT 5", [], (err, services) => {
    if (err) throw err;
    console.log("Services in DB:", services);

    db.all("SELECT id, quote_number, status, total_amount FROM quotations WHERE status = 'draft' LIMIT 5", [], (err, quotes) => {
        if (err) throw err;
        console.log("Draft quotations in DB:", quotes);

        db.all("SELECT qli.id, qli.quotation_id, qli.service_id, qli.description, qli.unit_price FROM quote_line_items qli JOIN quotations q ON qli.quotation_id = q.id WHERE q.status = 'draft' LIMIT 5", [], (err, items) => {
            if (err) throw err;
            console.log("Quote line items for draft quotes:", items);
            db.close();
        });
    });
});
