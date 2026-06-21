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
    v.name AS venue_name,
    v.city AS venue_city,
    v.capacity AS venue_capacity,
    v.contact_name AS venue_contact,
    v.contact_phone AS venue_contact_phone,
    v.green_room_notes AS venue_notes,
    CASE WHEN lq.total_amount IS NOT NULL
         THEN printf('%.2f', lq.total_amount)
         ELSE b.quote_amount
    END AS quote_amount,
    (SELECT status FROM invoices WHERE booking_id = b.id AND status != 'VOID'
     ORDER BY created_at DESC LIMIT 1) AS invoice_status,
    (SELECT invoice_number FROM invoices WHERE booking_id = b.id AND status != 'VOID'
     ORDER BY created_at DESC LIMIT 1) AS invoice_number,
    (SELECT id FROM invoices WHERE booking_id = b.id AND status != 'VOID'
     ORDER BY created_at DESC LIMIT 1) AS invoice_id
  FROM bookings b
  LEFT JOIN venues v ON b.venue_id = v.id
  LEFT JOIN clients c ON b.client_id = c.id
  LEFT JOIN quotations lq ON lq.id = (SELECT MAX(id) FROM quotations WHERE booking_id = b.id AND status != 'void')
  WHERE b.id = ?`;

db.get(sql, [78], (err, row) => {
    if (err) {
        console.error('Error querying database:', err);
    } else {
        console.log('Full Query result for Booking 78:');
        console.log(JSON.stringify(row, null, 2));
    }
    db.close();
});
