const path = require('path');
const db = require(path.join(__dirname, '..', 'database'));

db.all("SELECT id, name, email, client_id, venue_id FROM bookings ORDER BY id DESC LIMIT 5", [], (err, rows) => {
    if (err) {
        console.error(err);
    } else {
        console.log("Bookings:", JSON.stringify(rows, null, 2));
    }
    db.all("SELECT id, full_name, email FROM clients ORDER BY id DESC LIMIT 5", [], (err2, clients) => {
        if (err2) {
            console.error(err2);
        } else {
            console.log("Clients:", JSON.stringify(clients, null, 2));
        }
        process.exit();
    });
});
