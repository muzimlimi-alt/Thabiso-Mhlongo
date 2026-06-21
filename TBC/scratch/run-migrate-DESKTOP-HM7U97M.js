const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('database.sqlite');

async function migrate() {
    db.all("SELECT * FROM bookings", [], async (err, bookings) => {
        if (err) {
            console.error(err);
            return;
        }
        
        let stats = { processed: 0, clientsCreated: 0, venuesCreated: 0, updated: 0 };
        
        for (const booking of bookings) {
            stats.processed++;
            
            // 1. Resolve Client
            let clientId = await new Promise((resolve) => {
                db.get("SELECT id FROM clients WHERE LOWER(email) = LOWER(?)", [booking.email], (e, row) => resolve(row ? row.id : null));
            });
            
            if (!clientId) {
                clientId = await new Promise((resolve) => {
                    db.run("INSERT INTO clients (full_name, company_name, email, phone) VALUES (?, ?, ?, ?)",
                        [booking.name, booking.company, booking.email, booking.cell],
                        function() { resolve(this.lastID); }
                    );
                });
                stats.clientsCreated++;
            }
            
            // 2. Resolve Venue
            let venueId = null;
            if (booking.event_location || booking.venue_address) {
                const venueName = booking.event_location || 'Unknown Venue';
                venueId = await new Promise((resolve) => {
                    db.get("SELECT id FROM venues WHERE LOWER(name) = LOWER(?)", [venueName], (e, row) => resolve(row ? row.id : null));
                });
                
                if (!venueId) {
                    venueId = await new Promise((resolve) => {
                        db.run("INSERT INTO venues (name, address, city, country, capacity) VALUES (?, ?, ?, ?, ?)",
                            [venueName, booking.venue_address, booking.city, booking.country, booking.audience_size],
                            function() { resolve(this.lastID); }
                        );
                    });
                    stats.venuesCreated++;
                }
            }
            
            // 3. Update Booking with Foreign Keys
            await new Promise((resolve) => {
                db.run("UPDATE bookings SET client_id = ?, venue_id = ? WHERE id = ?", [clientId, venueId, booking.id], () => resolve());
            });
            stats.updated++;
        }
        
        console.log('Migration completed successfully.', stats);
        db.close();
    });
}

migrate();
