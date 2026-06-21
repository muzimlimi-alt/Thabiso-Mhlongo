const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, '../database.sqlite');
const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
    if (err) {
        console.error('Error opening database:', err);
        process.exit(1);
    }
});

const sql = `SELECT b.*,
    COALESCE(c.full_name, b.name) AS name,
    COALESCE(c.email, b.email) AS email,
    COALESCE(c.phone, b.cell) AS cell,
    COALESCE(c.company_name, b.company) AS company,
    COALESCE(v.name, b.event_location) AS event_location,
    COALESCE(v.address, b.venue_address) AS venue_address,
    COALESCE(v.city, b.city) AS city,
    COALESCE(v.country, b.country) AS country,
    CASE WHEN lq.total_amount IS NOT NULL
         THEN printf('%.2f', lq.total_amount)
         ELSE b.quote_amount
    END AS quote_amount,
    v.green_room_notes,
    v.notes AS venue_notes,
    v.negotiated_rates AS venue_negotiated_rates
  FROM bookings b
  LEFT JOIN venues v ON b.venue_id = v.id
  LEFT JOIN clients c ON b.client_id = c.id
  LEFT JOIN quotations lq ON lq.id = (SELECT MAX(id) FROM quotations WHERE booking_id = b.id)
  WHERE b.id = ?`;

db.get(sql, [78], (err, row) => {
    if (err) {
        console.error('Error querying database:', err);
    } else {
        console.log('Query result:');
        console.log(JSON.stringify(row, null, 2));
    }
    db.close();
});
