const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

// DB_PATH lets the integration tests point the whole app at a throwaway copy of the database
// instead of the real database.sqlite. Production/dev leave it unset and use the repo-root file.
const dbPath = process.env.DB_PATH
    ? path.resolve(process.env.DB_PATH)
    : path.resolve(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening database', err.message);
    } else {
        console.log('Connected to the SQLite database.');
        initializeDatabase();
    }
});

function initializeDatabase() {
    db.serialize(() => {
        // Enforce UTF-8 encoding and enable foreign keys
        db.run("PRAGMA encoding = 'UTF-8';");
        db.run('PRAGMA foreign_keys = ON;');
        db.run("PRAGMA journal_mode = WAL;");
        db.run("PRAGMA busy_timeout = 5000;");

        // 1. Admins Table
        db.run(`CREATE TABLE IF NOT EXISTS admins (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            email TEXT,
            password_hash TEXT NOT NULL,
            must_change_password INTEGER DEFAULT 0,
            role TEXT DEFAULT 'manager',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            created_by INTEGER REFERENCES admins(id),
            created_on DATETIME DEFAULT CURRENT_TIMESTAMP,
            modified_by INTEGER REFERENCES admins(id),
            modified_on DATETIME
        )`, (err) => {
            if (!err) {

                // Ensure legacy columns exist
                db.run("ALTER TABLE admins ADD COLUMN email TEXT", () => {
                    db.run("UPDATE admins SET email = 'admin@thabisomhlongo.com' WHERE username = 'admin' AND (email IS NULL OR email = '')", () => {});
                });
                db.run("ALTER TABLE admins ADD COLUMN must_change_password INTEGER DEFAULT 0", () => {});
                db.run("ALTER TABLE admins ADD COLUMN role TEXT DEFAULT 'manager'", () => {
                    db.run("UPDATE admins SET role = 'administrator' WHERE username = 'admin'", () => {});
                });

                // Comprehensive user management — profile/status fields.
                db.run("ALTER TABLE admins ADD COLUMN full_name TEXT", () => {});
                db.run("ALTER TABLE admins ADD COLUMN phone TEXT", () => {});
                db.run("ALTER TABLE admins ADD COLUMN is_active INTEGER DEFAULT 1", () => {});
                db.run("ALTER TABLE admins ADD COLUMN last_login_at DATETIME", () => {});
                db.run("UPDATE admins SET is_active = 1 WHERE is_active IS NULL", () => {});

                // Audit log fields for admin table
                db.run("ALTER TABLE admins ADD COLUMN created_by INTEGER", () => {});
                db.run("ALTER TABLE admins ADD COLUMN created_on DATETIME DEFAULT CURRENT_TIMESTAMP", () => {});
                db.run("ALTER TABLE admins ADD COLUMN modified_by INTEGER", () => {});
                db.run("ALTER TABLE admins ADD COLUMN modified_on DATETIME", () => {});

                // Email is the login identifier — enforce uniqueness.
                // Requires no duplicate/blank emails (pre-flight cleanup); logs + no-ops on failure.
                db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_admins_email_unique ON admins(email)", (err) => {
                    if (err) console.error('[migration] admins.email unique index failed — duplicate/blank emails remain:', err.message);
                });
            }
        });

        // 1.5. Password Reset Tokens Table
        db.run(`CREATE TABLE IF NOT EXISTS password_reset_tokens (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            admin_id INTEGER NOT NULL,
            token_hash TEXT NOT NULL,
            expires_at DATETIME NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (admin_id) REFERENCES admins (id) ON DELETE CASCADE
        )`);

        // 2. Inquiries Table (from Contact page)
        db.run(`CREATE TABLE IF NOT EXISTS inquiries (
            inquiry_id INTEGER PRIMARY KEY AUTOINCREMENT,
            sender_name TEXT NOT NULL,
            sender_email TEXT NOT NULL,
            receiver_email TEXT,
            sender_phone TEXT,
            category TEXT,
            subject TEXT,
            message_body TEXT NOT NULL,
            status TEXT DEFAULT 'unread',
            submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            routing_path TEXT,
            ip_address TEXT,
            user_agent TEXT
        )`, () => {
            db.all("PRAGMA table_info(inquiries)", (err, columns) => {
                if (err || !columns) return;
                const colNames = columns.map(c => c.name);
                
                if (colNames.includes('id') && !colNames.includes('inquiry_id')) {
                    // Try to migrate existing table
                    db.serialize(() => {
                        db.run("ALTER TABLE inquiries RENAME COLUMN id TO inquiry_id", function(err) {
                            if (!err) {
                                db.run("ALTER TABLE inquiries RENAME COLUMN name TO sender_name");
                                db.run("ALTER TABLE inquiries RENAME COLUMN email TO sender_email");
                                db.run("ALTER TABLE inquiries RENAME COLUMN cell TO sender_phone");
                                db.run("ALTER TABLE inquiries RENAME COLUMN message TO message_body");
                                db.run("ALTER TABLE inquiries RENAME COLUMN created_at TO submitted_at");
                                db.run("ALTER TABLE inquiries ADD COLUMN receiver_email TEXT");
                                db.run("ALTER TABLE inquiries ADD COLUMN category TEXT");
                                db.run("ALTER TABLE inquiries ADD COLUMN routing_path TEXT");
                                db.run("ALTER TABLE inquiries ADD COLUMN ip_address TEXT");
                                db.run("ALTER TABLE inquiries ADD COLUMN user_agent TEXT");
                            }
                        });
                    });
                } else if (!colNames.includes('id') && colNames.includes('inquiry_id')) {
                    // Ensure newer columns exist if somehow table was partially created
                    if (!colNames.includes('receiver_email')) db.run("ALTER TABLE inquiries ADD COLUMN receiver_email TEXT", () => {});
                    if (!colNames.includes('category')) db.run("ALTER TABLE inquiries ADD COLUMN category TEXT", () => {});
                    if (!colNames.includes('routing_path')) db.run("ALTER TABLE inquiries ADD COLUMN routing_path TEXT", () => {});
                    if (!colNames.includes('ip_address')) db.run("ALTER TABLE inquiries ADD COLUMN ip_address TEXT", () => {});
                    if (!colNames.includes('user_agent')) db.run("ALTER TABLE inquiries ADD COLUMN user_agent TEXT", () => {});
                    if (!colNames.includes('popia_consent')) db.run("ALTER TABLE inquiries ADD COLUMN popia_consent BOOLEAN DEFAULT 0", () => {});
                    if (!colNames.includes('consent_timestamp')) db.run("ALTER TABLE inquiries ADD COLUMN consent_timestamp DATETIME", () => {});
                }
            });
        });

        // Added synchronously (not inside the async PRAGMA callback above) and BEFORE any index/trigger
        // that references these columns, ignoring the "duplicate column" error on repeat boots — same
        // pattern used for contracts.signed_by etc. below. A column added only inside that async PRAGMA
        // callback isn't guaranteed to exist yet when a same-tick, synchronously-queued CREATE INDEX or
        // CREATE TRIGGER elsewhere in this file references it (SQLite validates column references at
        // trigger-creation time), which is exactly the race that broke chk/audit_inquiries_* on first boot.
        db.run("ALTER TABLE inquiries ADD COLUMN assigned_to INTEGER REFERENCES admins(id) ON DELETE SET NULL", (err) => { if (err && !err.message.includes('duplicate column name')) console.log("Note: inquiries.assigned_to already exists or error: " + err.message); });
        db.run("ALTER TABLE inquiries ADD COLUMN assigned_at DATETIME", (err) => { if (err && !err.message.includes('duplicate column name')) console.log("Note: inquiries.assigned_at already exists or error: " + err.message); });
        db.run("ALTER TABLE inquiries ADD COLUMN priority TEXT DEFAULT 'normal'", (err) => { if (err && !err.message.includes('duplicate column name')) console.log("Note: inquiries.priority already exists or error: " + err.message); });
        db.run("ALTER TABLE inquiries ADD COLUMN converted_booking_id INTEGER REFERENCES bookings(id) ON DELETE SET NULL", (err) => { if (err && !err.message.includes('duplicate column name')) console.log("Note: inquiries.converted_booking_id already exists or error: " + err.message); });
        db.run("ALTER TABLE inquiries ADD COLUMN responded_at DATETIME", (err) => { if (err && !err.message.includes('duplicate column name')) console.log("Note: inquiries.responded_at already exists or error: " + err.message); });

        db.run(`CREATE INDEX IF NOT EXISTS idx_inquiries_status ON inquiries(status)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_inquiries_submitted_at ON inquiries(submitted_at)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_inquiries_assigned_to ON inquiries(assigned_to)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_inquiries_priority ON inquiries(priority)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_inquiries_converted_booking_id ON inquiries(converted_booking_id)`);

        // 3. Bookings Table (from Booking page)
        db.run(`CREATE TABLE IF NOT EXISTS bookings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            company TEXT,
            email TEXT NOT NULL,
            cell TEXT NOT NULL,
            event_name TEXT,
            date TEXT NOT NULL,
            event_start_time TEXT,
            performance_slot TEXT,
            performance_duration TEXT,
            event_location TEXT NOT NULL,
            venue_address TEXT,
            city TEXT,
            country TEXT,
            venue_type TEXT,
            event_type TEXT NOT NULL,
            audience_size TEXT,
            audience_demographic TEXT,
            budget_range TEXT,
            travel_accommodation BOOLEAN DEFAULT 0,
            message TEXT NOT NULL,
            status TEXT DEFAULT 'NEW',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            quote_amount TEXT,
            quote_details TEXT,
            quote_expiry_date TEXT,
            payment_status TEXT DEFAULT 'UNPAID',
            total_amount REAL,
            amount_paid REAL DEFAULT 0,
            amount_outstanding REAL,
            last_payment_date DATETIME,
            payment_date DATETIME,
            quoted_at DATETIME,
            accepted_at DATETIME,
            confirmed_at DATETIME,
            completed_at DATETIME,
            cancelled_at DATETIME,
            policy_version TEXT
        )`, () => {
            // Failsafe schema updates in case the table was already created
            db.run("ALTER TABLE bookings ADD COLUMN status TEXT DEFAULT 'NEW'", () => {});
            db.run("ALTER TABLE bookings ADD COLUMN created_at DATETIME DEFAULT CURRENT_TIMESTAMP", () => {});
            db.run("ALTER TABLE bookings ADD COLUMN company TEXT", () => {});
            db.run("ALTER TABLE bookings ADD COLUMN event_name TEXT", () => {});
            db.run("ALTER TABLE bookings ADD COLUMN event_start_time TEXT", () => {});
            db.run("ALTER TABLE bookings ADD COLUMN performance_slot TEXT", () => {});
            db.run("ALTER TABLE bookings ADD COLUMN performance_duration TEXT", () => {});
            db.run("ALTER TABLE bookings ADD COLUMN event_location TEXT NOT NULL DEFAULT 'TBD'", () => {});
            db.run("ALTER TABLE bookings ADD COLUMN venue_address TEXT", () => {});
            db.run("ALTER TABLE bookings ADD COLUMN city TEXT", () => {});
            db.run("ALTER TABLE bookings ADD COLUMN country TEXT", () => {});
            db.run("ALTER TABLE bookings ADD COLUMN venue_type TEXT", () => {});
            db.run("ALTER TABLE bookings ADD COLUMN audience_size TEXT", () => {});
            db.run("ALTER TABLE bookings ADD COLUMN audience_demographic TEXT", () => {});
            db.run("ALTER TABLE bookings ADD COLUMN budget_range TEXT", () => {});
            db.run("ALTER TABLE bookings ADD COLUMN travel_accommodation BOOLEAN DEFAULT 0", () => {});
            db.run("ALTER TABLE bookings ADD COLUMN quote_amount TEXT", () => {});
            db.run("ALTER TABLE bookings ADD COLUMN quote_details TEXT", () => {});
            db.run("ALTER TABLE bookings ADD COLUMN quote_expiry_date TEXT", () => {});
            db.run("ALTER TABLE bookings ADD COLUMN payment_status TEXT DEFAULT 'UNPAID'", () => {});
            db.run("ALTER TABLE bookings ADD COLUMN payment_date DATETIME", () => {});
            db.run("ALTER TABLE bookings ADD COLUMN quoted_at DATETIME", () => {});
            db.run("ALTER TABLE bookings ADD COLUMN accepted_at DATETIME", () => {});
            db.run("ALTER TABLE bookings ADD COLUMN confirmed_at DATETIME", () => {});
            db.run("ALTER TABLE bookings ADD COLUMN completed_at DATETIME", () => {});
            db.run("ALTER TABLE bookings ADD COLUMN cancelled_at DATETIME", () => {});
            // PayFast payment audit columns
            db.run("ALTER TABLE bookings ADD COLUMN payment_amount TEXT", () => {});
            db.run("ALTER TABLE bookings ADD COLUMN payment_reference TEXT", () => {});
            db.run("ALTER TABLE bookings ADD COLUMN payment_signature TEXT", () => {});
            db.run("ALTER TABLE bookings ADD COLUMN payment_raw_data TEXT", () => {});
            db.run("ALTER TABLE bookings ADD COLUMN payment_method TEXT", () => {});
            
            // Decimal ledger migration
            db.run("ALTER TABLE bookings ADD COLUMN total_amount REAL", () => {});
            db.run("ALTER TABLE bookings ADD COLUMN amount_paid REAL DEFAULT 0", () => {});
            db.run("ALTER TABLE bookings ADD COLUMN amount_outstanding REAL", () => {});
            db.run("ALTER TABLE bookings ADD COLUMN last_payment_date DATETIME", () => {});
            db.run("ALTER TABLE bookings ADD COLUMN popia_consent BOOLEAN DEFAULT 0", () => {});
            db.run("ALTER TABLE bookings ADD COLUMN consent_timestamp DATETIME", () => {});
            db.run("ALTER TABLE bookings ADD COLUMN is_public INTEGER DEFAULT 0", () => {});
            db.run("ALTER TABLE bookings ADD COLUMN ticket_link TEXT", () => {});
            db.run("ALTER TABLE bookings ADD COLUMN policy_version TEXT", () => {});
            db.run("ALTER TABLE bookings ADD COLUMN source TEXT", () => {});
            db.run("ALTER TABLE bookings ADD COLUMN referrer TEXT", () => {});

            db.run("CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings(date)", () => {});
            db.run("CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status)", () => {});
            db.run("CREATE INDEX IF NOT EXISTS idx_bookings_date_status ON bookings(date, status)", () => {});
        });

        // 3.5 Payment Audit Logs Table
        db.run(`CREATE TABLE IF NOT EXISTS payment_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            booking_id INTEGER NOT NULL,
            event_type TEXT NOT NULL,
            raw_payload TEXT,
            signature_valid BOOLEAN,
            amount REAL,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(booking_id) REFERENCES bookings(id)
        )`);

        // 4. Newsletter Subscribers Table
        db.run(`CREATE TABLE IF NOT EXISTS newsletter_subscribers (
            subscriber_id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT UNIQUE NOT NULL,
            status TEXT DEFAULT 'active',
            subscribed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            created_on DATETIME DEFAULT CURRENT_TIMESTAMP,
            created_by INTEGER,
            modified_on DATETIME,
            modified_by INTEGER,
            ip_address TEXT,
            user_agent TEXT,
            source TEXT,
            policy_version TEXT
        )`, () => {
            // Apply fallback migrations if the legacy string "id" or "active" columns are found or missing fields
            db.all("PRAGMA table_info(newsletter_subscribers)", (err, columns) => {
                if (err || !columns) return;
                const colNames = columns.map(c => c.name);
                
                // If old schema existed
                if (colNames.includes('id') && !colNames.includes('subscriber_id')) {
                    db.serialize(() => {
                        db.run("ALTER TABLE newsletter_subscribers RENAME COLUMN id TO subscriber_id", () => {
                            if (!colNames.includes('status')) {
                                db.run("ALTER TABLE newsletter_subscribers ADD COLUMN status TEXT DEFAULT 'active'", () => {
                                    if (colNames.includes('active')) {
                                        db.run("UPDATE newsletter_subscribers SET status = CASE WHEN active = 1 THEN 'active' ELSE 'inactive' END", () => {});
                                    }
                                });
                            }
                            if (!colNames.includes('created_on')) db.run("ALTER TABLE newsletter_subscribers ADD COLUMN created_on DATETIME DEFAULT CURRENT_TIMESTAMP", () => {});
                            if (!colNames.includes('created_by')) db.run("ALTER TABLE newsletter_subscribers ADD COLUMN created_by INTEGER", () => {});
                            if (!colNames.includes('modified_on')) db.run("ALTER TABLE newsletter_subscribers ADD COLUMN modified_on DATETIME", () => {});
                            if (!colNames.includes('modified_by')) db.run("ALTER TABLE newsletter_subscribers ADD COLUMN modified_by INTEGER", () => {});
                            if (!colNames.includes('ip_address')) db.run("ALTER TABLE newsletter_subscribers ADD COLUMN ip_address TEXT", () => {});
                            if (!colNames.includes('user_agent')) db.run("ALTER TABLE newsletter_subscribers ADD COLUMN user_agent TEXT", () => {});
                            if (!colNames.includes('source')) db.run("ALTER TABLE newsletter_subscribers ADD COLUMN source TEXT", () => {});
                            if (!colNames.includes('policy_version')) db.run("ALTER TABLE newsletter_subscribers ADD COLUMN policy_version TEXT", () => {});
                        });
                    });
                } else if (!colNames.includes('id') && colNames.includes('subscriber_id')) {
                    // It's the new schema or already renamed - ensure columns exist just in case
                    if (!colNames.includes('status')) db.run("ALTER TABLE newsletter_subscribers ADD COLUMN status TEXT DEFAULT 'active'", () => {});
                    if (!colNames.includes('created_on')) db.run("ALTER TABLE newsletter_subscribers ADD COLUMN created_on DATETIME DEFAULT CURRENT_TIMESTAMP", () => {});
                    if (!colNames.includes('created_by')) db.run("ALTER TABLE newsletter_subscribers ADD COLUMN created_by INTEGER", () => {});
                    if (!colNames.includes('modified_on')) db.run("ALTER TABLE newsletter_subscribers ADD COLUMN modified_on DATETIME", () => {});
                    if (!colNames.includes('modified_by')) db.run("ALTER TABLE newsletter_subscribers ADD COLUMN modified_by INTEGER", () => {});
                    if (!colNames.includes('ip_address')) db.run("ALTER TABLE newsletter_subscribers ADD COLUMN ip_address TEXT", () => {});
                    if (!colNames.includes('user_agent')) db.run("ALTER TABLE newsletter_subscribers ADD COLUMN user_agent TEXT", () => {});
                    if (!colNames.includes('source')) db.run("ALTER TABLE newsletter_subscribers ADD COLUMN source TEXT", () => {});
                    if (!colNames.includes('popia_consent')) db.run("ALTER TABLE newsletter_subscribers ADD COLUMN popia_consent BOOLEAN DEFAULT 0", () => {});
                    if (!colNames.includes('consent_timestamp')) db.run("ALTER TABLE newsletter_subscribers ADD COLUMN consent_timestamp DATETIME", () => {});
                    if (!colNames.includes('policy_version')) db.run("ALTER TABLE newsletter_subscribers ADD COLUMN policy_version TEXT", () => {});
                }
            });
        });

        // 5. Newsletter Campaigns Table
        db.run(`CREATE TABLE IF NOT EXISTS newsletter_campaigns (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            subject TEXT NOT NULL,
            content TEXT NOT NULL,
            sent_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        // 5.5 Newsletter Drafts Table
        db.run(`CREATE TABLE IF NOT EXISTS newsletter_drafts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            subject TEXT,
            content TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        // 5.6 Scheduled Newsletters Table
        db.run(`CREATE TABLE IF NOT EXISTS scheduled_newsletters (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            subject TEXT,
            content TEXT NOT NULL,
            scheduled_at DATETIME NOT NULL,
            status TEXT DEFAULT 'pending',
            attachment_paths TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
        // Migration: add attachment_paths for existing databases (silently ignored if already present)
        db.run("ALTER TABLE scheduled_newsletters ADD COLUMN attachment_paths TEXT", () => {});

        // 6. Career Highlights Table
        db.run(`CREATE TABLE IF NOT EXISTS career_highlights (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            year TEXT,
            title TEXT NOT NULL,
            badge TEXT,
            location TEXT,
            description TEXT NOT NULL,
            image_path TEXT,
            display_order INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`, () => {
            // Failsafe schema updates in case the table was already created
            db.run("ALTER TABLE career_highlights ADD COLUMN year TEXT", () => {});
            db.run("ALTER TABLE career_highlights ADD COLUMN badge TEXT", () => {});
            db.run("ALTER TABLE career_highlights ADD COLUMN location TEXT", () => {});
            // Milestones redesign: per-entry icon badge (mic/tv/plane/etc.) — nullable, falls back
            // to a generic icon on the frontend for existing rows.
            db.run("ALTER TABLE career_highlights ADD COLUMN icon TEXT", () => {});
        });

        // Footprint — countries performed in, shown as a flag grid on the public site.
        // Modeled directly on career_highlights: same admin-managed list shape, no reorder UI.
        db.run(`CREATE TABLE IF NOT EXISTS footprint_countries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            country_name TEXT NOT NULL,
            flag_image_path TEXT NOT NULL,
            display_order INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`, () => {
            // One-time seed of the real countries from the Footprint prototype — only runs while
            // the table is empty, so an admin who later deletes all rows doesn't get them back.
            db.get("SELECT COUNT(*) AS c FROM footprint_countries", (err, row) => {
                if (err || !row || row.c > 0) return;
                const seed = [
                    ['South Africa', 'images/footprint/flag-south-africa.png'],
                    ['Eswatini', 'images/footprint/flag-eswatini.png'],
                    ['Lesotho', 'images/footprint/flag-lesotho.png'],
                    ['Cape Verde', 'images/footprint/flag-cape-verde.png'],
                    ['Spain', 'images/footprint/flag-spain.png'],
                    ['Japan', 'images/footprint/flag-japan.png'],
                ];
                seed.forEach(([country_name, flag_image_path]) => {
                    db.run("INSERT INTO footprint_countries (country_name, flag_image_path) VALUES (?, ?)", [country_name, flag_image_path]);
                });
            });
        });

        // Testimonials — visitor-submitted, admin-moderated. status gates public visibility;
        // no CHECK constraint, matching this project's established preference for status columns
        // (see the Newsletter double opt-in work for the same reasoning).
        db.run(`CREATE TABLE IF NOT EXISTS testimonials (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            designation TEXT,
            quote TEXT NOT NULL,
            image_path TEXT,
            status TEXT NOT NULL DEFAULT 'pending',
            submitted_by TEXT NOT NULL DEFAULT 'visitor',
            display_order INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`, () => {
            // One-time seed of the real testimonial quotes from the prototype, pre-approved since
            // they're the site owner's own vetted content. NOTE: the prototype's embedded "photos"
            // turned out to be unrelated event flyers, not real client headshots — seeded with
            // image_path NULL on purpose; the public carousel renders a monogram avatar for any
            // testimonial without a photo (real client photos can be added via the admin later).
            db.get("SELECT COUNT(*) AS c FROM testimonials", (err, row) => {
                if (err || !row || row.c > 0) return;
                const seed = [
                    ['Naledi Khumalo', 'Corporate Events Lead', "Thabiso hosted our year-end function and had the whole floor — interns to the CFO — crying with laughter. Professional, punctual, and impossibly funny."],
                    ['Sipho Maseko', 'Festival Director', "He switched between isiSwati and English mid-punchline and somehow the whole tent got the joke. We've booked him twice since — the crowd asks for him by name."],
                    ['Annelie Botha', 'Private Client', "From the first quote to the final bow, everything was effortless. He made my father's 60th feel like a sold-out theatre show."],
                ];
                seed.forEach(([name, designation, quote]) => {
                    db.run("INSERT INTO testimonials (name, designation, quote, status, submitted_by) VALUES (?, ?, ?, 'approved', 'admin')", [name, designation, quote]);
                });
            });
        });

        // 7. Gallery Images Table
        db.run(`CREATE TABLE IF NOT EXISTS gallery_images (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT,
            image_path TEXT NOT NULL,
            uploader_name TEXT,
            location TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`, () => {
            db.all("PRAGMA table_info(gallery_images)", (err, columns) => {
                if (err || !columns) return;
                const colNames = columns.map(c => c.name);
                if (!colNames.includes('uploader_name')) db.run("ALTER TABLE gallery_images ADD COLUMN uploader_name TEXT", () => {});
                if (!colNames.includes('location')) db.run("ALTER TABLE gallery_images ADD COLUMN location TEXT", () => {});
            });
        });
         // 8. Manager Details Table
        db.run(`CREATE TABLE IF NOT EXISTS manager_details (
            manager_id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            cell_number TEXT NOT NULL,
            whatsapp_number TEXT NOT NULL,
            email TEXT NOT NULL,
            whatsapp_link TEXT,
            created_on DATETIME DEFAULT CURRENT_TIMESTAMP,
            created_by INTEGER,
            modified_on DATETIME,
            modified_by INTEGER,
            FOREIGN KEY (created_by) REFERENCES admins (id),
            FOREIGN KEY (modified_by) REFERENCES admins (id)
        )`, () => {
             db.run("ALTER TABLE manager_details ADD COLUMN whatsapp_link TEXT", () => {});
             db.get("SELECT COUNT(*) AS count FROM manager_details", (err, row) => {
                 if (row && row.count === 0) {
                     db.run(`INSERT INTO manager_details (name, cell_number, whatsapp_number, email) 
                             VALUES ('Lindelwe Xulu', '+27 74 341 9681', '+27 84 323 5075', 'bookings@thabisomhlongo.com')`, (err) => {
                         if (!err) console.log('Default manager details seeded.');
                     });
                 }
             });
        });

        // 9. Contact Info Table (Quote, Signature, Target Email)
        db.run(`CREATE TABLE IF NOT EXISTS contact_info (
            quote_id INTEGER PRIMARY KEY AUTOINCREMENT,
            quote TEXT NOT NULL,
            signature TEXT NOT NULL,
            email TEXT NOT NULL,
            created_on DATETIME DEFAULT CURRENT_TIMESTAMP,
            created_by INTEGER,
            modified_on DATETIME,
            modified_by INTEGER
        )`, () => {
             db.get("SELECT COUNT(*) AS count FROM contact_info", (err, row) => {
                 if (row && row.count === 0) {
                     db.run(`INSERT INTO contact_info (quote, signature, email) 
                             VALUES ('I’m here to redefine comedy.', 'Thabiso Mhlongo', 'admin@thabisomhlongo.com')`, (err) => {
                         if (!err) console.log('Default contact info seeded.');
                     });
                 }
             });
        });

        // 10. Events Table
        db.run(`CREATE TABLE IF NOT EXISTS events (
            event_id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_title TEXT NOT NULL,
            event_description TEXT,
            event_datetime TEXT,
            venue_name TEXT,
            venue_map_link TEXT,
            ticket_sales_link TEXT,
            poster_image_path TEXT,
            event_status TEXT DEFAULT 'upcoming',
            created_on DATETIME DEFAULT CURRENT_TIMESTAMP,
            created_by INTEGER,
            modified_on DATETIME,
            modified_by INTEGER,
            ip_address TEXT,
            user_agent TEXT,
            FOREIGN KEY (created_by) REFERENCES admins (id),
            FOREIGN KEY (modified_by) REFERENCES admins (id)
        )`, () => {
            // Apply migrations just in case table exists and doesn't have these
            db.all("PRAGMA table_info(events)", (err, columns) => {
                if (err || !columns) return;
                const colNames = columns.map(c => c.name);
                if (!colNames.includes('venue_map_link')) db.run("ALTER TABLE events ADD COLUMN venue_map_link TEXT", () => {});
                if (!colNames.includes('ticket_sales_link')) db.run("ALTER TABLE events ADD COLUMN ticket_sales_link TEXT", () => {});
                if (!colNames.includes('ip_address')) db.run("ALTER TABLE events ADD COLUMN ip_address TEXT", () => {});
                if (!colNames.includes('user_agent')) db.run("ALTER TABLE events ADD COLUMN user_agent TEXT", () => {});
                if (!colNames.includes('google_calendar_event_id')) db.run("ALTER TABLE events ADD COLUMN google_calendar_event_id TEXT", () => {});
            });
        });
        
        // 11. Social Links Table
        db.run(`CREATE TABLE IF NOT EXISTS social_links (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            platform_name TEXT NOT NULL,
            platform_url TEXT NOT NULL,
            icon_class TEXT,
            display_order INTEGER DEFAULT 0,
            is_active BOOLEAN DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            created_by INTEGER,
            modified_at DATETIME,
            modified_by INTEGER,
            ip_address TEXT,
            user_agent TEXT,
            routing_path TEXT,
            FOREIGN KEY (created_by) REFERENCES admins (id),
            FOREIGN KEY (modified_by) REFERENCES admins (id)
        )`, () => {
            db.all("PRAGMA table_info(social_links)", (err, columns) => {
                if (err || !columns) return;
                const colNames = columns.map(c => c.name);
                
                if (colNames.includes('name') && !colNames.includes('platform_name')) db.run("ALTER TABLE social_links RENAME COLUMN name TO platform_name", () => {});
                if (colNames.includes('url') && !colNames.includes('platform_url')) db.run("ALTER TABLE social_links RENAME COLUMN url TO platform_url", () => {});
                
                if (!colNames.includes('is_active')) db.run("ALTER TABLE social_links ADD COLUMN is_active BOOLEAN DEFAULT 1", () => {});
                if (!colNames.includes('created_by')) db.run("ALTER TABLE social_links ADD COLUMN created_by INTEGER", () => {});
                if (!colNames.includes('modified_at')) db.run("ALTER TABLE social_links ADD COLUMN modified_at DATETIME", () => {});
                if (!colNames.includes('modified_by')) db.run("ALTER TABLE social_links ADD COLUMN modified_by INTEGER", () => {});
                if (!colNames.includes('ip_address')) db.run("ALTER TABLE social_links ADD COLUMN ip_address TEXT", () => {});
                if (!colNames.includes('user_agent')) db.run("ALTER TABLE social_links ADD COLUMN user_agent TEXT", () => {});
                if (!colNames.includes('routing_path')) db.run("ALTER TABLE social_links ADD COLUMN routing_path TEXT", () => {});
            });
        });

        // 12. Social Embeds Table
        db.run(`CREATE TABLE IF NOT EXISTS social_embeds (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            platform_name TEXT NOT NULL,
            embed_code TEXT NOT NULL,
            platform_api_key TEXT,
            metadata TEXT,
            display_order INTEGER DEFAULT 0,
            is_active BOOLEAN DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            created_by INTEGER,
            modified_at DATETIME,
            modified_by INTEGER,
            ip_address TEXT,
            user_agent TEXT,
            routing_path TEXT,
            FOREIGN KEY (created_by) REFERENCES admins (id),
            FOREIGN KEY (modified_by) REFERENCES admins (id)
        )`, () => {
            db.all("PRAGMA table_info(social_embeds)", (err, columns) => {
                if (err || !columns) return;
                const colNames = columns.map(c => c.name);
                
                if (colNames.includes('platform') && !colNames.includes('platform_name')) db.run("ALTER TABLE social_embeds RENAME COLUMN platform TO platform_name", () => {});
                if (colNames.includes('url') && !colNames.includes('embed_code')) db.run("ALTER TABLE social_embeds RENAME COLUMN url TO embed_code", () => {});
                if (colNames.includes('metadata_json') && !colNames.includes('metadata')) db.run("ALTER TABLE social_embeds RENAME COLUMN metadata_json TO metadata", () => {});
                
                if (!colNames.includes('platform_api_key')) db.run("ALTER TABLE social_embeds ADD COLUMN platform_api_key TEXT", () => {});
                if (!colNames.includes('is_active')) db.run("ALTER TABLE social_embeds ADD COLUMN is_active BOOLEAN DEFAULT 1", () => {});
                if (!colNames.includes('created_by')) db.run("ALTER TABLE social_embeds ADD COLUMN created_by INTEGER", () => {});
                if (!colNames.includes('modified_at')) db.run("ALTER TABLE social_embeds ADD COLUMN modified_at DATETIME", () => {});
                if (!colNames.includes('modified_by')) db.run("ALTER TABLE social_embeds ADD COLUMN modified_by INTEGER", () => {});
                if (!colNames.includes('ip_address')) db.run("ALTER TABLE social_embeds ADD COLUMN ip_address TEXT", () => {});
                if (!colNames.includes('user_agent')) db.run("ALTER TABLE social_embeds ADD COLUMN user_agent TEXT", () => {});
                if (!colNames.includes('routing_path')) db.run("ALTER TABLE social_embeds ADD COLUMN routing_path TEXT", () => {});
            });
        });
        
        // 12b. Social KPI Stats Table (cache and manual override values for dashboard KPI cards)
        db.run(`CREATE TABLE IF NOT EXISTS social_kpi_stats (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            platform_name TEXT NOT NULL UNIQUE,
            follower_count INTEGER DEFAULT 0,
            like_count INTEGER DEFAULT 0,
            trend_percentage REAL DEFAULT 0,
            trend_direction TEXT DEFAULT 'up',
            manual_override BOOLEAN DEFAULT 1,
            goal_target INTEGER DEFAULT 0,
            last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
        )`, () => {
             // Default progress-bar goals per platform (previously hardcoded in the dashboard JS).
             const defaultGoals = { 'Facebook': 20000, 'Instagram': 25000, 'X (Twitter)': 20000, 'YouTube': 25000, 'TikTok': 100000 };

             // Migration: add goal_target to existing DBs and backfill sensible defaults once.
             db.all("PRAGMA table_info(social_kpi_stats)", (err, columns) => {
                 if (err || !columns) return;
                 const colNames = columns.map(c => c.name);
                 if (!colNames.includes('goal_target')) {
                     db.run("ALTER TABLE social_kpi_stats ADD COLUMN goal_target INTEGER DEFAULT 0", () => {
                         Object.keys(defaultGoals).forEach(p => {
                             db.run("UPDATE social_kpi_stats SET goal_target = ? WHERE platform_name = ?", [defaultGoals[p], p], () => {});
                         });
                     });
                 }
             });

             db.get("SELECT COUNT(*) AS count FROM social_kpi_stats", (err, row) => {
                 if (row && row.count === 0) {
                     const defaultKPIs = [
                         ['Facebook', 12098, 12098, 22.9, 'up', 1, defaultGoals['Facebook']],
                         ['Instagram', 15080, 0, -27.4, 'down', 1, defaultGoals['Instagram']],
                         ['X (Twitter)', 12564, 0, 76.10, 'up', 1, defaultGoals['X (Twitter)']],
                         ['YouTube', 14890, 0, 62.08, 'up', 1, defaultGoals['YouTube']],
                         ['TikTok', 50230, 0, 120.5, 'up', 1, defaultGoals['TikTok']]
                     ];
                     const stmt = db.prepare("INSERT INTO social_kpi_stats (platform_name, follower_count, like_count, trend_percentage, trend_direction, manual_override, goal_target) VALUES (?, ?, ?, ?, ?, ?, ?)");
                     defaultKPIs.forEach(kpi => stmt.run(kpi));
                     stmt.finalize();
                     console.log('Default Social Media KPI items seeded.');
                 }
             });
        });

        // 13. Email Audit Logs Table (Modernization Phase 3+)
        db.run(`CREATE TABLE IF NOT EXISTS email_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            recipient_email TEXT NOT NULL,
            subject TEXT,
            trigger_event TEXT,
            status TEXT DEFAULT 'success',
            error_message TEXT,
            sent_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`, () => {
             db.all("PRAGMA table_info(email_logs)", (err, columns) => {
                if (err || !columns) return;
                const colNames = columns.map(c => c.name);
                if (!colNames.includes('error_message')) db.run("ALTER TABLE email_logs ADD COLUMN error_message TEXT", () => {});
                if (!colNames.includes('trigger_event')) db.run("ALTER TABLE email_logs ADD COLUMN trigger_event TEXT", () => {});
            });
        });

        // 14. Home Slider Table
        db.run(`CREATE TABLE IF NOT EXISTS home_slider (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            url TEXT NOT NULL,
            alt TEXT,
            file_name TEXT,
            file_size TEXT,
            uploader_name TEXT,
            display_order INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`, () => {
             db.get("SELECT COUNT(*) AS count FROM home_slider", (err, row) => {
                 if (row && row.count === 0) {
                     const defaultSliders = [
                         ['images/image-slider-1.jpg', 'Slider 1', 'image-slider-1.jpg', '850 KB', 'System Default', 0],
                         ['images/image-slider-2.jpg', 'Slider 2', 'image-slider-2.jpg', '1.2 MB', 'System Default', 1],
                         ['images/image-slider-3.jpg', 'Slider 3', 'image-slider-3.jpg', '980 KB', 'System Default', 2],
                         ['images/image-slider-4.jpg', 'Slider 4', 'image-slider-4.jpg', '1.1 MB', 'System Default', 3],
                         ['images/image-slider-5.jpg', 'Slider 5', 'image-slider-5.jpg', '920 KB', 'System Default', 4]
                     ];
                     const stmt = db.prepare("INSERT INTO home_slider (url, alt, file_name, file_size, uploader_name, display_order) VALUES (?, ?, ?, ?, ?, ?)");
                     defaultSliders.forEach(s => stmt.run(s));
                     stmt.finalize();
                     console.log('Default home slider items seeded.');
                 }
             });
        });

        // 15. About Me Table (singleton — always id = 1)
        db.run(`CREATE TABLE IF NOT EXISTS about_me (
            id INTEGER PRIMARY KEY DEFAULT 1,
            image_path TEXT,
            paragraph1 TEXT,
            paragraph2 TEXT,
            paragraph3 TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            created_by TEXT,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_by TEXT
        )`);

        // --- Evolution for Bookings (Phase 2 & 3 Integration) ---
        db.all("PRAGMA table_info(bookings)", [], (err, columns) => {
            if (err || !columns) return;
            const colNames = columns.map(c => c.name);
            if (!colNames.includes('client_id')) db.run("ALTER TABLE bookings ADD COLUMN client_id INTEGER REFERENCES clients(id)", (e) => { if (e) console.error("Error adding client_id:", e.message); });
            if (!colNames.includes('venue_id')) db.run("ALTER TABLE bookings ADD COLUMN venue_id INTEGER REFERENCES venues(id)", (e) => { if (e) console.error("Error adding venue_id:", e.message); });
            if (!colNames.includes('google_event_id')) db.run("ALTER TABLE bookings ADD COLUMN google_event_id TEXT", (e) => { if (e) console.error("Error adding google_event_id:", e.message); });
            if (!colNames.includes('quote_amount')) db.run("ALTER TABLE bookings ADD COLUMN quote_amount TEXT");
            if (!colNames.includes('total_amount')) db.run("ALTER TABLE bookings ADD COLUMN total_amount DECIMAL(10,2)");
            if (!colNames.includes('amount_outstanding')) db.run("ALTER TABLE bookings ADD COLUMN amount_outstanding DECIMAL(10,2)");
            if (!colNames.includes('payment_status')) db.run("ALTER TABLE bookings ADD COLUMN payment_status TEXT DEFAULT 'UNPAID'");
        });

        // ==========================================
        // PHASE 2: MODERN RELATIONAL SCHEMA
        // ==========================================

        // CORE ENTITIES
        db.run(`CREATE TABLE IF NOT EXISTS clients (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            full_name TEXT NOT NULL,
            company_name TEXT,
            email TEXT NOT NULL UNIQUE,
            phone TEXT NOT NULL,
            billing_address TEXT,
            tax_id TEXT,
            vat_number TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`, (err) => { if (err) console.error("Error creating clients table:", err.message); });

        db.run(`CREATE TABLE IF NOT EXISTS venues (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            address TEXT,
            city TEXT,
            state TEXT,
            postal_code TEXT,
            country TEXT,
            place_id TEXT UNIQUE,
            latitude REAL,
            longitude REAL,
            contact_name TEXT,
            contact_phone TEXT,
            contact_email TEXT,
            capacity INTEGER,
            load_in_time TEXT,
            green_room_notes TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`, () => {
            db.run("ALTER TABLE venues ADD COLUMN notes TEXT", () => {});
            db.run("ALTER TABLE venues ADD COLUMN negotiated_rates TEXT", () => {});
        });

        // Advancing Pack — show-day operations (run-of-show, technical rider, hospitality,
        // contacts, travel), editable from the Deal View's Advancing tab. 1:1 with a booking.
        db.run(`CREATE TABLE IF NOT EXISTS advancing_packs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            booking_id INTEGER NOT NULL UNIQUE REFERENCES bookings(id),
            status TEXT DEFAULT 'draft' CHECK(status IN ('draft','sent','confirmed')),
            mic_type TEXT, pa_spec TEXT, monitors TEXT, lighting TEXT,
            stage_layout TEXT, equipment_responsibility TEXT,
            green_room_notes TEXT, meals TEXT, dietary TEXT, parking_wifi TEXT,
            travel_type TEXT, flights TEXT, hotel TEXT, ground_transport TEXT,
            internal_notes TEXT, pdf_url TEXT,
            sent_to_client_at DATETIME, sent_to_venue_at DATETIME, confirmed_at DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`, (err) => { if (err) console.error("Error creating advancing_packs table:", err.message); });

        db.run(`CREATE TABLE IF NOT EXISTS run_of_show_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pack_id INTEGER NOT NULL REFERENCES advancing_packs(id) ON DELETE CASCADE,
            sort_order INTEGER DEFAULT 0,
            time_label TEXT,
            duration_minutes INTEGER,
            title TEXT NOT NULL,
            detail TEXT,
            responsible TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`, (err) => { if (err) console.error("Error creating run_of_show_items table:", err.message); });
        db.run(`CREATE INDEX IF NOT EXISTS idx_ros_pack ON run_of_show_items(pack_id)`);

        db.run(`CREATE TABLE IF NOT EXISTS advancing_contacts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pack_id INTEGER NOT NULL REFERENCES advancing_packs(id) ON DELETE CASCADE,
            role TEXT, name TEXT, phone TEXT, email TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`, (err) => { if (err) console.error("Error creating advancing_contacts table:", err.message); });
        db.run(`CREATE INDEX IF NOT EXISTS idx_advcontacts_pack ON advancing_contacts(pack_id)`);

        db.run(`CREATE TABLE IF NOT EXISTS comedians (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            stage_name TEXT NOT NULL,
            legal_name TEXT,
            email TEXT,
            phone TEXT,
            default_currency TEXT DEFAULT 'ZAR',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
        db.run(`INSERT OR IGNORE INTO comedians (id, stage_name, legal_name, email) VALUES (1, 'Thabiso Mhlongo', 'Thabiso Victor Mhlongo', 'bookings@thabisomhlongo.com')`);

        // SERVICES & TAX
        db.run(`CREATE TABLE IF NOT EXISTS services (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            description TEXT,
            default_price DECIMAL(10,2) NOT NULL,
            pricing_model TEXT DEFAULT 'flat_fee',
            base_price DECIMAL(10,2),
            min_quantity INTEGER DEFAULT 1,
            max_quantity INTEGER,
            display_unit TEXT DEFAULT 'unit',
            is_taxable BOOLEAN DEFAULT 1,
            category TEXT CHECK(category IN ('Performance','Travel','Production','Other')),
            service_type TEXT DEFAULT 'core',
            base_uom TEXT DEFAULT 'ea',
            pricing_group TEXT DEFAULT 'Standard',
            is_capital_asset BOOLEAN DEFAULT 0,
            tax_class TEXT DEFAULT 'standard',
            sac_code TEXT,
            availability_rule TEXT DEFAULT 'any_time',
            booking_lead_time_days INTEGER DEFAULT 0,
            setup_time_minutes INTEGER DEFAULT 0,
            performance_length_minutes INTEGER DEFAULT 0,
            travel_included BOOLEAN DEFAULT 0,
            preferred_resource_id INTEGER,
            cost_center TEXT,
            profit_center TEXT,
            internal_note TEXT,
            external_note TEXT,
            valid_from TEXT,
            valid_to TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        // Migrations for existing services table (direct in serialize flow)
        const addCol = (col, def) => {
            db.run(`ALTER TABLE services ADD COLUMN ${col} ${def}`, (err) => {
                if (err && !err.message.includes('duplicate column name')) {
                    // Ignore duplicate column errors
                }
            });
        };

        addCol('pricing_model', "TEXT DEFAULT 'flat_fee'");
        // Normalise legacy 'flat' values written before the dropdown used 'flat_fee'
        db.run("UPDATE services SET pricing_model = 'flat_fee' WHERE pricing_model = 'flat'");
        addCol('base_price', "DECIMAL(10,2)");
        addCol('min_quantity', "INTEGER DEFAULT 1");
        addCol('max_quantity', "INTEGER");
        addCol('display_unit', "TEXT DEFAULT 'unit'");
        addCol('service_type', "TEXT DEFAULT 'core'");
        addCol('base_uom', "TEXT DEFAULT 'ea'");
        addCol('pricing_group', "TEXT DEFAULT 'Standard'");
        addCol('is_capital_asset', "BOOLEAN DEFAULT 0");
        addCol('tax_class', "TEXT DEFAULT 'standard'");
        addCol('sac_code', "TEXT");
        addCol('availability_rule', "TEXT DEFAULT 'any_time'");
        addCol('booking_lead_time_days', "INTEGER DEFAULT 0");
        addCol('setup_time_minutes', "INTEGER DEFAULT 0");
        addCol('performance_length_minutes', "INTEGER DEFAULT 0");
        addCol('travel_included', "BOOLEAN DEFAULT 0");
        addCol('preferred_resource_id', "INTEGER");
        addCol('cost_center', "TEXT");
        addCol('profit_center', "TEXT");
        addCol('internal_note', "TEXT");
        addCol('external_note', "TEXT");
        addCol('valid_from', "TEXT");
        addCol('valid_to', "TEXT");
        // SAP-extended batch 2
        addCol('crew_required',      "INTEGER DEFAULT 1");
        addCol('financial_category', "TEXT DEFAULT NULL");
        addCol('legacy_code',        "TEXT DEFAULT NULL");
        addCol('is_deleted',         "INTEGER DEFAULT 0");
        addCol('revenue_gl_code',    "TEXT DEFAULT NULL");
        addCol('marketing_segment',  "TEXT DEFAULT NULL");
        addCol('item_category',      "TEXT DEFAULT 'DIEN'");
        addCol('tax_category',       "TEXT DEFAULT NULL");
        addCol('fulfillment_type',   "TEXT DEFAULT 'on_site'");



        db.run(`CREATE TABLE IF NOT EXISTS booking_services (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            booking_id INTEGER NOT NULL,
            service_id INTEGER NOT NULL,
            quantity_minutes INTEGER DEFAULT 1,
            unit_price REAL,
            total_price REAL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE,
            FOREIGN KEY (service_id) REFERENCES services(id)
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS tax_rates (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            rate DECIMAL(5,4) NOT NULL,
            effective_from DATE NOT NULL,
            effective_to DATE,
            is_default BOOLEAN DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
        db.run(`INSERT OR IGNORE INTO tax_rates (name, rate, effective_from, is_default) VALUES ('South Africa Standard VAT', 0.1500, '2019-01-01', 1)`);

        // BOOKING LINE ITEMS & QUOTATIONS
        db.run(`CREATE TABLE IF NOT EXISTS booking_line_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            booking_id INTEGER NOT NULL,
            service_id INTEGER,
            description TEXT NOT NULL,
            quantity INTEGER DEFAULT 1,
            unit_price DECIMAL(10,2) NOT NULL,
            tax_rate_id INTEGER,
            is_taxable BOOLEAN DEFAULT 1,
            total_price DECIMAL(10,2) GENERATED ALWAYS AS (quantity * unit_price) STORED,
            FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE,
            FOREIGN KEY (service_id) REFERENCES services(id),
            FOREIGN KEY (tax_rate_id) REFERENCES tax_rates(id)
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS quotations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            booking_id INTEGER,
            quote_number TEXT UNIQUE,
            client_id INTEGER NOT NULL,
            comedian_id INTEGER DEFAULT 1,
            quote_date DATE DEFAULT CURRENT_DATE,
            expiry_date DATE,
            event_date DATE,
            venue_name TEXT,
            subtotal DECIMAL(10,2),
            tax_amount DECIMAL(10,2),
            total_amount DECIMAL(10,2),
            status TEXT DEFAULT 'draft',
            notes TEXT,
            file_path TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (booking_id) REFERENCES bookings(id),
            FOREIGN KEY (client_id) REFERENCES clients(id),
            FOREIGN KEY (comedian_id) REFERENCES comedians(id)
        )`, () => {
            // Failsafe migration for quotations table
            db.all("PRAGMA table_info(quotations)", (err, columns) => {
                if (err || !columns) return;
                const colNames = columns.map(c => c.name);
                if (!colNames.includes('booking_id')) {
                    db.run("ALTER TABLE quotations ADD COLUMN booking_id INTEGER REFERENCES bookings(id)", (e) => {
                        if (e) console.error("Error adding booking_id to quotations:", e.message);
                    });
                }
                if (!colNames.includes('file_path')) {
                    db.run("ALTER TABLE quotations ADD COLUMN file_path TEXT", (e) => {
                        if (e) console.error("Error adding file_path to quotations:", e.message);
                    });
                }
                if (!colNames.includes('version'))
                    db.run("ALTER TABLE quotations ADD COLUMN version INTEGER DEFAULT 1");
                if (!colNames.includes('archived'))
                    db.run("ALTER TABLE quotations ADD COLUMN archived INTEGER DEFAULT 0");
                if (!colNames.includes('sent_at'))
                    db.run("ALTER TABLE quotations ADD COLUMN sent_at DATETIME");
            });
        });

        db.run(`CREATE TABLE IF NOT EXISTS quote_line_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            quotation_id INTEGER NOT NULL,
            service_id INTEGER,
            description TEXT NOT NULL,
            quantity INTEGER DEFAULT 1,
            unit_price DECIMAL(10,2) NOT NULL,
            total_price DECIMAL(10,2) GENERATED ALWAYS AS (quantity * unit_price) STORED,
            FOREIGN KEY (quotation_id) REFERENCES quotations(id) ON DELETE CASCADE,
            FOREIGN KEY (service_id) REFERENCES services(id)
        )`);

        // INVOICES & TRANSACTIONS
        db.run(`CREATE TABLE IF NOT EXISTS invoices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            booking_id INTEGER NOT NULL,
            client_id INTEGER NOT NULL,
            invoice_number TEXT UNIQUE NOT NULL,
            invoice_date DATE NOT NULL DEFAULT CURRENT_DATE,
            due_date DATE NOT NULL,
            subtotal DECIMAL(10,2) NOT NULL,
            tax_amount DECIMAL(10,2) DEFAULT 0,
            total_amount DECIMAL(10,2) NOT NULL,
            is_vat_inclusive BOOLEAN DEFAULT 1,
            status TEXT DEFAULT 'draft',
            void_reason TEXT,
            voided_at DATETIME,
            replacement_invoice_id INTEGER,
            file_path TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (booking_id) REFERENCES bookings(id),
            FOREIGN KEY (client_id) REFERENCES clients(id),
            FOREIGN KEY (replacement_invoice_id) REFERENCES invoices(id)
        )`, () => {
            // Failsafe migration: file_path added after initial schema was deployed
            db.run("ALTER TABLE invoices ADD COLUMN file_path TEXT", () => {});
            db.run("ALTER TABLE invoices ADD COLUMN notes TEXT", () => {});
            db.run("ALTER TABLE invoices ADD COLUMN sent_at DATETIME", () => {});
            db.run("ALTER TABLE invoices ADD COLUMN pre_due_reminded_at DATETIME", () => {});
            db.run("ALTER TABLE invoices ADD COLUMN overdue_reminded_at DATETIME", () => {});
        });

        db.run(`CREATE TABLE IF NOT EXISTS invoice_line_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            invoice_id INTEGER NOT NULL,
            description TEXT NOT NULL,
            quantity INTEGER DEFAULT 1,
            unit_price DECIMAL(10,2) NOT NULL,
            tax_rate_id INTEGER,
            is_taxable BOOLEAN DEFAULT 1,
            total_price DECIMAL(10,2) GENERATED ALWAYS AS (quantity * unit_price) STORED,
            FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE,
            FOREIGN KEY (tax_rate_id) REFERENCES tax_rates(id)
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            booking_id INTEGER NOT NULL,
            invoice_id INTEGER,
            amount DECIMAL(10,2) NOT NULL,
            transaction_date DATETIME DEFAULT CURRENT_TIMESTAMP,
            payment_method TEXT,
            reference TEXT, -- added for server.js compatibility
            reference_number TEXT,
            transaction_type TEXT,
            status TEXT DEFAULT 'pending',
            notes TEXT,
            pf_payment_id TEXT UNIQUE,
            pf_signature TEXT,
            pf_status TEXT,
            ip_address TEXT,
            is_verified INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (booking_id) REFERENCES bookings(id),
            FOREIGN KEY (invoice_id) REFERENCES invoices(id)
        )`, () => {
            // Failsafe migration: reference column added after initial schema deployment
            db.run("ALTER TABLE transactions ADD COLUMN reference TEXT", () => {});
        });

        // CANCELLATIONS & REFUNDS
        db.run(`CREATE TABLE IF NOT EXISTS cancellations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            booking_id INTEGER NOT NULL UNIQUE,
            cancelled_by TEXT CHECK(cancelled_by IN ('client','comedian','mutual','force_majeure')),
            reason TEXT,
            total_paid_to_date DECIMAL(10,2),
            refund_due DECIMAL(10,2),
            retention_amount DECIMAL(10,2),
            cancelled_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            refund_processed_at DATETIME,
            notes TEXT,
            FOREIGN KEY (booking_id) REFERENCES bookings(id)
        )`);

        // CONTRACTS
        db.run(`CREATE TABLE IF NOT EXISTS contracts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            booking_id INTEGER NOT NULL UNIQUE,
            template_version TEXT NOT NULL,
            content_html TEXT,
            content_hash TEXT,
            pdf_url TEXT,
            sent_to_client_at DATETIME,
            signed_by_client_at DATETIME,
            client_ip_address TEXT,
            client_signature_data TEXT,
            signed_by_comedian_at DATETIME,
            status TEXT DEFAULT 'draft',
            is_frozen BOOLEAN DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (booking_id) REFERENCES bookings(id)
        )`);

        // COMMUNICATION LOG
        db.run(`CREATE TABLE IF NOT EXISTS communication_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            booking_id INTEGER,
            client_id INTEGER,
            direction TEXT CHECK(direction IN ('incoming','outgoing')),
            channel TEXT,
            subject TEXT,
            content_snippet TEXT,
            sent_at DATETIME,
            received_at DATETIME,
            user_email TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (booking_id) REFERENCES bookings(id),
            FOREIGN KEY (client_id) REFERENCES clients(id)
        )`);

        // SCHEDULING: DATE HOLDS & PAYMENT SCHEDULES
        db.run(`CREATE TABLE IF NOT EXISTS date_holds (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            comedian_id INTEGER DEFAULT 1,
            client_id INTEGER,
            hold_date DATE NOT NULL,
            hold_expires_at DATETIME NOT NULL,
            status TEXT DEFAULT 'active',
            converted_to_booking_id INTEGER,
            notes TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (comedian_id) REFERENCES comedians(id),
            FOREIGN KEY (client_id) REFERENCES clients(id),
            FOREIGN KEY (converted_to_booking_id) REFERENCES bookings(id)
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS payment_schedules (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            booking_id INTEGER NOT NULL,
            invoice_id INTEGER,
            description TEXT NOT NULL,
            due_date DATE NOT NULL,
            expected_amount DECIMAL(10,2) NOT NULL,
            status TEXT DEFAULT 'pending',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (booking_id) REFERENCES bookings(id),
            FOREIGN KEY (invoice_id) REFERENCES invoices(id)
        )`);

        // S5-4: Threaded booking notes (replaces the single admin_notes text blob)
        db.run(`CREATE TABLE IF NOT EXISTS booking_notes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            booking_id INTEGER NOT NULL,
            note TEXT NOT NULL,
            author TEXT NOT NULL DEFAULT 'Admin',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (booking_id) REFERENCES bookings(id)
        )`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_booking_notes_booking ON booking_notes(booking_id)`);

        // Internal admin-only notes on an inquiry — structural mirror of booking_notes, with a
        // created_by FK (author is still stored as free text for display, but derived from the
        // session server-side rather than trusted from the client, unlike booking_notes' author).
        db.run(`CREATE TABLE IF NOT EXISTS inquiry_notes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            inquiry_id INTEGER NOT NULL REFERENCES inquiries(inquiry_id) ON DELETE CASCADE,
            note TEXT NOT NULL,
            author TEXT NOT NULL DEFAULT 'Admin',
            created_by INTEGER REFERENCES admins(id),
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_inquiry_notes_inquiry ON inquiry_notes(inquiry_id)`);

        // EXPENSES (SARS Mileage & Per Diem)
        db.run(`CREATE TABLE IF NOT EXISTS expenses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            booking_id INTEGER,
            expense_date DATE NOT NULL,
            category TEXT CHECK(category IN ('mileage','airfare','accommodation','meals','per_diem','parking_tolls','marketing','props','misc')),
            description TEXT NOT NULL,
            amount DECIMAL(10,2) NOT NULL,
            start_odometer INTEGER,
            end_odometer INTEGER,
            total_km INTEGER GENERATED ALWAYS AS (end_odometer - start_odometer) STORED,
            rate_per_km DECIMAL(6,2),
            per_diem_days DECIMAL(3,1),
            per_diem_rate DECIMAL(8,2),
            receipt_url TEXT,
            reimbursable BOOLEAN DEFAULT 0,
            reimbursed_amount DECIMAL(10,2) DEFAULT 0,
            vat_paid DECIMAL(10,2),
            is_personal_component BOOLEAN DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            deleted_at DATETIME DEFAULT NULL,
            FOREIGN KEY (booking_id) REFERENCES bookings(id)
        )`);

        // Expenses migrations — add columns that may not exist in older DB files
        db.run("ALTER TABLE expenses ADD COLUMN vat_rate DECIMAL(5,2) DEFAULT 15", (err) => { if (err && !err.message.includes('duplicate column name')) console.log('expenses.vat_rate migration note:', err.message); });
        db.run("ALTER TABLE expenses ADD COLUMN vendor TEXT", (err) => { if (err && !err.message.includes('duplicate column name')) console.log('expenses.vendor note:', err.message); });
        db.run("ALTER TABLE expenses ADD COLUMN deleted_at DATETIME DEFAULT NULL", (err) => { if (err && !err.message.includes('duplicate column name')) {} });

        // FINANCIAL AUDIT LOG table
        db.run(`CREATE TABLE IF NOT EXISTS financial_audit_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_type TEXT NOT NULL,
            entity_type TEXT NOT NULL,
            entity_id INTEGER NOT NULL,
            amount DECIMAL(10,2),
            changed_by TEXT NOT NULL,
            notes TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        // BANK STATEMENT LINES — for CSV import + manual matching
        db.run(`CREATE TABLE IF NOT EXISTS bank_statement_lines (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            import_batch TEXT NOT NULL,
            import_date DATE NOT NULL,
            statement_date DATE NOT NULL,
            description TEXT,
            amount DECIMAL(10,2) NOT NULL,
            reference TEXT,
            matched_transaction_id INTEGER,
            matched_booking_id INTEGER,
            match_note TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (matched_transaction_id) REFERENCES transactions(id),
            FOREIGN KEY (matched_booking_id) REFERENCES bookings(id)
        )`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_bsl_batch ON bank_statement_lines(import_batch)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_bsl_matched ON bank_statement_lines(matched_transaction_id)`);

        // POLICIES & SETTINGS
        db.run(`CREATE TABLE IF NOT EXISTS policies (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            policy_key TEXT UNIQUE NOT NULL,
            policy_value TEXT NOT NULL,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS settings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            setting_key TEXT UNIQUE NOT NULL,
            setting_value TEXT NOT NULL,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`, () => {
            // Seed editable homepage content (Hero paragraph + "What I Do" section) so the admin
            // editors are pre-populated and index.html renders from the DB. INSERT OR IGNORE keeps
            // any admin edits intact across restarts; absent values fall back to the static HTML.
            db.run(`INSERT OR IGNORE INTO settings (setting_key, setting_value) VALUES ('announcement_enabled', '1')`);
            db.run(`INSERT OR IGNORE INTO settings (setting_key, setting_value) VALUES ('announcement_rotate', '1')`);
            // Public homepage section visibility (JSON map); '{}' = every section visible by default.
            db.run(`INSERT OR IGNORE INTO settings (setting_key, setting_value) VALUES ('section_visibility', '{}')`);
            db.run(`INSERT OR IGNORE INTO settings (setting_key, setting_value) VALUES ('announcement_text', ?)`,
                ['<strong>Funny Business </strong> World Wide ']);
            db.run(`INSERT OR IGNORE INTO settings (setting_key, setting_value) VALUES ('hero_tagline', 'Officially funny since 2014')`);
            db.run(`INSERT OR IGNORE INTO settings (setting_key, setting_value) VALUES ('hero_subtitle', ?)`,
                ["An award winning South African stand-up comedian, writer, actor, podcaster and TV presenter from Barberton — bringing a decade of stage-craft, razor-sharp wit and premium entertainment to South Africa's biggest rooms."]);
            db.run(`INSERT OR IGNORE INTO settings (setting_key, setting_value) VALUES ('features_items', ?)`,
                [JSON.stringify([
                    { title: '10+ Years', description: 'On stage since 2014' },
                    { title: '200+ Shows', description: 'Live performances' },
                    { title: '15+ Credits', description: 'TV, film & voice-over' },
                    { title: '3 Languages', description: 'English, IsiSwati & Hilarious' }
                ])]);
            db.run(`INSERT OR IGNORE INTO settings (setting_key, setting_value) VALUES ('services_eyebrow', 'What I do')`);
            db.run(`INSERT OR IGNORE INTO settings (setting_key, setting_value) VALUES ('services_heading', 'From the mic to the <em>moment</em>')`);
            db.run(`INSERT OR IGNORE INTO settings (setting_key, setting_value) VALUES ('services_items', ?)`,
                [JSON.stringify([
                    { title: 'Stand-Up', description: 'Solo sets, festivals & comedy nights', image: '' },
                    { title: 'MC & Host', description: 'Galas, weddings & corporate events', image: '' },
                    { title: 'TV, Podcast & Film', description: 'Acting, presenting & writing', image: '' },
                    { title: 'Voice-Over', description: 'Radio & TV ads', image: '' }
                ])]);
        });



        // AUDIT LOG
        db.run(`CREATE TABLE IF NOT EXISTS audit_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            table_name TEXT NOT NULL,
            record_id INTEGER NOT NULL,
            action TEXT NOT NULL,
            user_email TEXT,
            ip_address TEXT,
            old_values TEXT,
            new_values TEXT,
            changed_by TEXT,
            changes_json TEXT,
            change_timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            reason TEXT
        )`);

        // PAYMENT REMINDERS LOG
        db.run(`CREATE TABLE IF NOT EXISTS reminders_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            booking_id INTEGER NOT NULL,
            schedule_id INTEGER,
            days_before INTEGER NOT NULL,
            due_date DATE NOT NULL,
            amount_due DECIMAL(10,2),
            recipient_email TEXT NOT NULL,
            sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            status TEXT DEFAULT 'sent',
            error_message TEXT,
            FOREIGN KEY (booking_id) REFERENCES bookings(id),
            FOREIGN KEY (schedule_id) REFERENCES payment_schedules(id),
            UNIQUE(booking_id, schedule_id, days_before)
        )`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_reminders_booking ON reminders_log(booking_id)`);
        // Reminders delivery tracking columns
        db.run("ALTER TABLE reminders_log ADD COLUMN delivered_at DATETIME", (err) => { if (err && !err.message.includes('duplicate column name')) {} });
        db.run("ALTER TABLE reminders_log ADD COLUMN opened_at DATETIME", (err) => { if (err && !err.message.includes('duplicate column name')) {} });
        db.run("ALTER TABLE reminders_log ADD COLUMN bounce_reason TEXT", (err) => { if (err && !err.message.includes('duplicate column name')) {} });

        // UNIFIED NOTIFICATIONS TABLE
        db.run(`CREATE TABLE IF NOT EXISTS notifications (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            type TEXT NOT NULL,
            channel TEXT NOT NULL DEFAULT 'email',
            status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'sending', 'sent', 'failed', 'read', 'dismissed')),
            priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
            recipient_email TEXT,
            recipient_name TEXT,
            subject TEXT,
            body TEXT,
            attachment_paths TEXT,
            related_entity TEXT,
            related_id INTEGER,
            scheduled_at DATETIME,
            sent_at DATETIME,
            read_at DATETIME,
            retry_count INTEGER DEFAULT 0,
            error_message TEXT,
            created_by INTEGER REFERENCES admins(id),
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`, () => {
            db.run("ALTER TABLE notifications ADD COLUMN attachment_paths TEXT", () => {});
        });
        db.run(`CREATE INDEX IF NOT EXISTS idx_notifications_status ON notifications(status)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_notifications_entity ON notifications(related_entity, related_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_notifications_scheduled ON notifications(scheduled_at)`);

        // DIRECT EMAILS (DRAFTS & SCHEDULED REPLIES/COMPOSITIONS)
        db.run(`CREATE TABLE IF NOT EXISTS direct_emails (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            inquiry_id INTEGER REFERENCES inquiries(inquiry_id) ON DELETE SET NULL,
            to_emails TEXT NOT NULL,
            cc_emails TEXT,
            bcc_emails TEXT,
            reply_to TEXT,
            subject TEXT,
            body TEXT NOT NULL,
            branding_option TEXT DEFAULT 'logo',
            selected_banner_url TEXT,
            attachment_paths TEXT,
            scheduled_at DATETIME,
            status TEXT DEFAULT 'draft' CHECK(status IN ('draft', 'scheduled', 'sent', 'failed', 'cancelled')),
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_direct_emails_status ON direct_emails(status)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_direct_emails_inquiry ON direct_emails(inquiry_id)`);

        // EMAIL BANNER REGISTRY (Prompt 5) — per-category banner images assignable to lifecycle
        // email templates. Independent of direct_emails.selected_banner_url (the separate Direct
        // Emails composer) and of js/emailAssets.js's single global CID banner (legacy wrapper path).
        db.run(`CREATE TABLE IF NOT EXISTS banners (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            category TEXT NOT NULL CHECK(category IN (
                'Booking Requests','Quotes & Proposals','Contracts & Signatures','Payments & Invoices',
                'Booking Confirmations','Event Reminders','Thank You & Reviews','Booking Recovery',
                'Contact & Support','Newsletters & Marketing','User Accounts & Security'
            )),
            image_url TEXT NOT NULL,
            alt_text TEXT NOT NULL,
            headline TEXT,
            subtitle TEXT,
            status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
            created_by INTEGER REFERENCES admins(id),
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_banners_category ON banners(category)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_banners_status ON banners(status)`);

        // One row per rebuilt lifecycle email's stable template_key (seeded by
        // scripts/seed-banner-templates.js, not user-created — assignment only).
        db.run(`CREATE TABLE IF NOT EXISTS email_template_banners (
            template_key TEXT PRIMARY KEY,
            category TEXT NOT NULL,
            banner_id INTEGER REFERENCES banners(id) ON DELETE SET NULL,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_email_template_banners_banner_id ON email_template_banners(banner_id)`);

        // Migration: add 'Birthday' to banners.category's CHECK constraint. SQLite can't ALTER a
        // CHECK constraint, so this is the one genuine table-rebuild in this codebase (everywhere
        // else is purely-additive ALTER TABLE ADD COLUMN). Guarded by inspecting the table's own
        // stored SQL — self-verifying, not a separate tracking flag that could drift from reality.
        // Written as explicit nested callbacks (not relying on serialize() queue ordering) since
        // each step must only run after the previous one actually succeeded.
        db.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='banners'", (sqlErr, row) => {
            if (sqlErr || !row || row.sql.includes("'Birthday'")) return;
            console.log('[migration] Adding Birthday category to banners.category CHECK constraint...');
            db.run("PRAGMA foreign_keys=OFF", () => {
                db.run("BEGIN TRANSACTION", (beginErr) => {
                    if (beginErr) { console.error('[migration] BEGIN failed:', beginErr.message); return; }
                    db.run(`CREATE TABLE banners_new (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        name TEXT NOT NULL,
                        category TEXT NOT NULL CHECK(category IN (
                            'Booking Requests','Quotes & Proposals','Contracts & Signatures','Payments & Invoices',
                            'Booking Confirmations','Event Reminders','Thank You & Reviews','Booking Recovery',
                            'Contact & Support','Newsletters & Marketing','User Accounts & Security','Birthday'
                        )),
                        image_url TEXT NOT NULL,
                        alt_text TEXT NOT NULL,
                        headline TEXT,
                        subtitle TEXT,
                        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
                        created_by INTEGER REFERENCES admins(id),
                        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                    )`, (createErr) => {
                        if (createErr) { console.error('[migration] create banners_new failed:', createErr.message); return db.run("ROLLBACK", () => db.run("PRAGMA foreign_keys=ON")); }
                        db.run("INSERT INTO banners_new SELECT * FROM banners", (copyErr) => {
                            if (copyErr) { console.error('[migration] copy banners failed:', copyErr.message); return db.run("ROLLBACK", () => db.run("PRAGMA foreign_keys=ON")); }
                            db.run("DROP TABLE banners", (dropErr) => {
                                if (dropErr) { console.error('[migration] drop banners failed:', dropErr.message); return db.run("ROLLBACK", () => db.run("PRAGMA foreign_keys=ON")); }
                                db.run("ALTER TABLE banners_new RENAME TO banners", (renameErr) => {
                                    if (renameErr) { console.error('[migration] rename banners_new failed:', renameErr.message); return db.run("ROLLBACK", () => db.run("PRAGMA foreign_keys=ON")); }
                                    db.run(`CREATE INDEX IF NOT EXISTS idx_banners_category ON banners(category)`);
                                    db.run(`CREATE INDEX IF NOT EXISTS idx_banners_status ON banners(status)`);
                                    db.run("COMMIT", (commitErr) => {
                                        db.run("PRAGMA foreign_keys=ON");
                                        if (commitErr) { console.error('[migration] commit failed:', commitErr.message); return; }
                                        console.log('[migration] Birthday category added successfully.');
                                    });
                                });
                            });
                        });
                    });
                });
            });
        });
        // Registers the Birthday newsletter template key (idempotent — mirrors the seeding scripts/
        // seed-banner-templates.js does for the other lifecycle template keys).
        db.run(`INSERT OR IGNORE INTO email_template_banners (template_key, category) VALUES ('subscriber_birthday', 'Birthday')`);
        // Registers the booking-tracker OTP email (2026-07-16) so it's a manageable citizen of the
        // banner registry like every other PREMIUM-track template — same idempotent pattern as above.
        // Grouped with password_reset/dashboard_invite: same "short security/utility email" shape.
        db.run(`INSERT OR IGNORE INTO email_template_banners (template_key, category) VALUES ('booking_verification_code', 'User Accounts & Security')`);

        // SCHEMA MIGRATIONS TRACKING TABLE
        db.run(`CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        // ==========================================
        // SCHEMA EVOLUTION: ALTER EXISTING TABLES
        // ==========================================
        db.run("ALTER TABLE bookings ADD COLUMN client_id INTEGER REFERENCES clients(id)", (err) => { if (err && !err.message.includes('duplicate column name')) console.log("Note: client_id already exists or error: " + err.message); });
        db.run("ALTER TABLE bookings ADD COLUMN venue_id INTEGER REFERENCES venues(id)", (err) => { if (err && !err.message.includes('duplicate column name')) console.log("Note: venue_id already exists or error: " + err.message); });
        db.run("ALTER TABLE bookings ADD COLUMN quotation_id INTEGER REFERENCES quotations(id)", (err) => { if (err && !err.message.includes('duplicate column name')) console.log("Note: quotation_id already exists or error: " + err.message); });
        db.run("ALTER TABLE bookings ADD COLUMN google_event_id TEXT", (err) => { if (err && !err.message.includes('duplicate column name')) console.log("Note: google_event_id already exists or error: " + err.message); });
        db.run("ALTER TABLE bookings ADD COLUMN cancellation_policy TEXT", (err) => { if (err && !err.message.includes('duplicate column name')) console.log("Note: cancellation_policy already exists or error: " + err.message); });
        db.run("ALTER TABLE bookings ADD COLUMN cancellation_deadline DATE", (err) => { if (err && !err.message.includes('duplicate column name')) console.log("Note: cancellation_deadline already exists or error: " + err.message); });
        db.run("ALTER TABLE bookings ADD COLUMN cancelled_by TEXT", (err) => { if (err && !err.message.includes('duplicate column name')) console.log("Note: cancelled_by already exists or error: " + err.message); });
        db.run("ALTER TABLE bookings ADD COLUMN cancellation_reason TEXT", (err) => { if (err && !err.message.includes('duplicate column name')) console.log("Note: cancellation_reason already exists or error: " + err.message); });
        db.run("ALTER TABLE bookings ADD COLUMN refund_amount DECIMAL(10,2)", (err) => { if (err && !err.message.includes('duplicate column name')) console.log("Note: refund_amount already exists or error: " + err.message); });
        db.run("ALTER TABLE bookings ADD COLUMN vat_number TEXT", (err) => { if (err && !err.message.includes('duplicate column name')) console.log("Note: vat_number already exists or error: " + err.message); });
        
        // Cancellation workflow columns
        db.run("ALTER TABLE cancellations ADD COLUMN admin_id INTEGER", (err) => { if (err && !err.message.includes('duplicate column name')) console.log("Note: admin_id already exists or error: " + err.message); });
        db.run("ALTER TABLE cancellations ADD COLUMN refund_status TEXT DEFAULT 'pending'", (err) => { if (err && !err.message.includes('duplicate column name')) console.log("Note: refund_status already exists or error: " + err.message); });

        // Unification of events and bookings
        db.run("ALTER TABLE events ADD COLUMN booking_id INTEGER REFERENCES bookings(id)", (err) => { if (err && !err.message.includes('duplicate column name')) console.log("Note: booking_id already exists or error: " + err.message); });
        db.run("ALTER TABLE events ADD COLUMN venue_id INTEGER REFERENCES venues(id) ON DELETE SET NULL", (err) => { if (err && !err.message.includes('duplicate column name')) console.log("Note: venue_id already exists or error: " + err.message); });
        db.run("ALTER TABLE events ADD COLUMN event_start_time TEXT", (err) => { if (err && !err.message.includes('duplicate column name')) console.log("Note: event_start_time already exists or error: " + err.message); });
        db.run("ALTER TABLE events ADD COLUMN event_end_time TEXT", (err) => { if (err && !err.message.includes('duplicate column name')) console.log("Note: event_end_time already exists or error: " + err.message); });
        db.run("ALTER TABLE bookings ADD COLUMN event_id INTEGER REFERENCES events(event_id)", (err) => { if (err && !err.message.includes('duplicate column name')) console.log("Note: event_id already exists or error: " + err.message); });
        db.run("ALTER TABLE bookings ADD COLUMN show_on_website BOOLEAN DEFAULT 0", (err) => { if (err && !err.message.includes('duplicate column name')) console.log("Note: show_on_website already exists or error: " + err.message); });
        db.run("ALTER TABLE events ADD COLUMN cancelled_at DATETIME", (err) => { if (err && !err.message.includes('duplicate column name')) console.log("Note: events.cancelled_at already exists or error: " + err.message); });
        db.run("ALTER TABLE events ADD COLUMN cancellation_reason TEXT", (err) => { if (err && !err.message.includes('duplicate column name')) console.log("Note: events.cancellation_reason already exists or error: " + err.message); });
        db.run("ALTER TABLE events ADD COLUMN event_type TEXT", (err) => { if (err && !err.message.includes('duplicate column name')) console.log("Note: events.event_type already exists or error: " + err.message); });
        db.run("ALTER TABLE events ADD COLUMN event_capacity INTEGER", (err) => { if (err && !err.message.includes('duplicate column name')) console.log("Note: events.event_capacity already exists or error: " + err.message); });
        db.run("ALTER TABLE events ADD COLUMN client_id INTEGER REFERENCES clients(id)", (err) => { if (err && !err.message.includes('duplicate column name')) console.log("Note: events.client_id already exists or error: " + err.message); });
        db.run("ALTER TABLE date_holds ADD COLUMN event_id INTEGER REFERENCES events(event_id)", (err) => { if (err && !err.message.includes('duplicate column name')) console.log("Note: event_id already exists or error: " + err.message); });
        db.run("ALTER TABLE date_holds ADD COLUMN start_time TEXT", (err) => { if (err && !err.message.includes('duplicate column name')) console.log("Note: date_holds.start_time already exists or error: " + err.message); });
        db.run("ALTER TABLE date_holds ADD COLUMN end_time TEXT", (err) => { if (err && !err.message.includes('duplicate column name')) console.log("Note: date_holds.end_time already exists or error: " + err.message); });
        db.run("ALTER TABLE date_holds ADD COLUMN block_type TEXT", (err) => { if (err && !err.message.includes('duplicate column name')) console.log("Note: date_holds.block_type already exists or error: " + err.message); });
        db.run("ALTER TABLE date_holds ADD COLUMN google_event_id TEXT", (err) => { if (err && !err.message.includes('duplicate column name')) console.log("Note: date_holds.google_event_id already exists or error: " + err.message); });

        // Refund tracking columns on cancellations
        db.run("ALTER TABLE cancellations ADD COLUMN refund_amount REAL DEFAULT 0", (err) => { if (err && !err.message.includes('duplicate column name')) console.log("Note: cancellations.refund_amount already exists."); });
        db.run("ALTER TABLE cancellations ADD COLUMN refund_reference TEXT", (err) => { if (err && !err.message.includes('duplicate column name')) console.log("Note: cancellations.refund_reference already exists."); });
        db.run("ALTER TABLE cancellations ADD COLUMN refund_notes TEXT", (err) => { if (err && !err.message.includes('duplicate column name')) console.log("Note: cancellations.refund_notes already exists."); });
        db.run("ALTER TABLE cancellations ADD COLUMN refunded_at DATETIME", (err) => { if (err && !err.message.includes('duplicate column name')) console.log("Note: cancellations.refunded_at already exists."); });

        // bookings.completed_at timestamp
        db.run("ALTER TABLE bookings ADD COLUMN completed_at DATETIME", (err) => { if (err && !err.message.includes('duplicate column name')) console.log("Note: bookings.completed_at already exists."); });

        // Newsletter subscribers: close schema drift — these two columns are read/written
        // throughout server.js but were only ever added to the live DB by a one-off standalone
        // migration script, never to this declarative schema. A fresh clone was missing them.
        db.run("ALTER TABLE newsletter_subscribers ADD COLUMN active INTEGER DEFAULT 1", (err) => { if (err && !err.message.includes('duplicate column name')) console.log('Note:', err.message); });
        db.run("ALTER TABLE newsletter_subscribers ADD COLUMN unsubscribe_token TEXT", (err) => { if (err && !err.message.includes('duplicate column name')) console.log('Note:', err.message); });
        // Newsletter subscribers: personalization foundation (first name + day/month-only birthday,
        // no year — used for recurring annual birthday automation and merge-field personalization)
        db.run("ALTER TABLE newsletter_subscribers ADD COLUMN first_name TEXT", (err) => { if (err && !err.message.includes('duplicate column name')) console.log('Note:', err.message); });
        db.run("ALTER TABLE newsletter_subscribers ADD COLUMN birthday_day INTEGER", (err) => { if (err && !err.message.includes('duplicate column name')) console.log('Note:', err.message); });
        db.run("ALTER TABLE newsletter_subscribers ADD COLUMN birthday_month INTEGER", (err) => { if (err && !err.message.includes('duplicate column name')) console.log('Note:', err.message); });
        db.run("ALTER TABLE newsletter_subscribers ADD COLUMN tags TEXT", (err) => { if (err && !err.message.includes('duplicate column name')) console.log('Note:', err.message); });
        db.run("ALTER TABLE newsletter_subscribers ADD COLUMN internal_notes TEXT", (err) => { if (err && !err.message.includes('duplicate column name')) console.log('Note:', err.message); });
        db.run(`CREATE INDEX IF NOT EXISTS idx_newsletter_subscribers_birthday ON newsletter_subscribers(birthday_month, birthday_day)`);

        // Double opt-in: audit timestamp for when a pending_confirmation subscriber actually
        // confirmed. Nullable — NULL for admin-added/CSV-imported subscribers (never pending)
        // and for anyone who hasn't confirmed yet. No CHECK constraint on `status` exists (by
        // design, see Phase 1), so the new 'pending_confirmation' status value needs no migration.
        db.run("ALTER TABLE newsletter_subscribers ADD COLUMN confirmed_at DATETIME", (err) => { if (err && !err.message.includes('duplicate column name')) console.log('Note:', err.message); });

        // Newsletter campaigns/scheduled sends: persist recipient/success/fail counts instead of
        // discarding them after the HTTP response (newsletter_campaigns) or overloading `status`
        // with a composite "sent (n/m)" string (scheduled_newsletters) — status stays a clean value.
        db.run("ALTER TABLE newsletter_campaigns ADD COLUMN recipient_count INTEGER", (err) => { if (err && !err.message.includes('duplicate column name')) console.log('Note:', err.message); });
        db.run("ALTER TABLE newsletter_campaigns ADD COLUMN success_count INTEGER", (err) => { if (err && !err.message.includes('duplicate column name')) console.log('Note:', err.message); });
        db.run("ALTER TABLE newsletter_campaigns ADD COLUMN fail_count INTEGER", (err) => { if (err && !err.message.includes('duplicate column name')) console.log('Note:', err.message); });
        db.run("ALTER TABLE scheduled_newsletters ADD COLUMN success_count INTEGER", (err) => { if (err && !err.message.includes('duplicate column name')) console.log('Note:', err.message); });
        db.run("ALTER TABLE scheduled_newsletters ADD COLUMN fail_count INTEGER", (err) => { if (err && !err.message.includes('duplicate column name')) console.log('Note:', err.message); });
        // Audience segmentation choice, persisted so a scheduled send still targets the segment
        // the admin picked at compose time, not just "all active" once the job actually fires.
        db.run("ALTER TABLE scheduled_newsletters ADD COLUMN segment TEXT", (err) => { if (err && !err.message.includes('duplicate column name')) console.log('Note:', err.message); });
        db.run("ALTER TABLE scheduled_newsletters ADD COLUMN segment_value TEXT", (err) => { if (err && !err.message.includes('duplicate column name')) console.log('Note:', err.message); });

        // bookings: admin notes + background clerk tracking columns
        db.run("ALTER TABLE bookings ADD COLUMN admin_notes TEXT", (err) => { if (err && !err.message.includes('duplicate column name')) console.log('Note:', err.message); });
        db.run("ALTER TABLE bookings ADD COLUMN quote_expiry_warned DATETIME", (err) => { if (err && !err.message.includes('duplicate column name')) console.log('Note:', err.message); });
        db.run("ALTER TABLE bookings ADD COLUMN pending_expiry_warned DATETIME", (err) => { if (err && !err.message.includes('duplicate column name')) console.log('Note:', err.message); });
        db.run("ALTER TABLE bookings ADD COLUMN overdue_reminded_at DATETIME", (err) => { if (err && !err.message.includes('duplicate column name')) console.log('Note:', err.message); });
        db.run("ALTER TABLE bookings ADD COLUMN quote_follow_up_sent_at DATETIME", (err) => { if (err && !err.message.includes('duplicate column name')) console.log('Note:', err.message); });
        // Audit-gap fixes: pending_at timestamp and venue place ID storage
        db.run("ALTER TABLE bookings ADD COLUMN pending_at DATETIME", (err) => { if (err && !err.message.includes('duplicate column name')) console.log('Note:', err.message); });
        db.run("ALTER TABLE bookings ADD COLUMN venue_place_id TEXT", (err) => { if (err && !err.message.includes('duplicate column name')) console.log('Note:', err.message); });
        // S3-4: Digital acceptance record — IP and timestamp of client quote acceptance
        db.run("ALTER TABLE bookings ADD COLUMN acceptance_ip TEXT", (err) => { if (err && !err.message.includes('duplicate column name')) console.log('Note:', err.message); });
        db.run("ALTER TABLE bookings ADD COLUMN acceptance_agreed_at DATETIME", (err) => { if (err && !err.message.includes('duplicate column name')) console.log('Note:', err.message); });
        // S4-1: Tracks when the DEPOSIT_PAID approaching-event reminder was last sent
        db.run("ALTER TABLE bookings ADD COLUMN deposit_balance_reminded_at DATETIME", (err) => { if (err && !err.message.includes('duplicate column name')) console.log('Note:', err.message); });
        db.run("ALTER TABLE bookings ADD COLUMN rebooked_from_id INTEGER", (err) => { if (err && !err.message.includes('duplicate column name')) console.log('Note:', err.message); });
        db.run("ALTER TABLE bookings ADD COLUMN source_inquiry_id INTEGER REFERENCES inquiries(inquiry_id) ON DELETE SET NULL", (err) => { if (err && !err.message.includes('duplicate column name')) console.log('Note:', err.message); });
        db.run(`CREATE INDEX IF NOT EXISTS idx_bookings_source_inquiry_id ON bookings(source_inquiry_id)`);
        // S6-1: Tracks when the post-event follow-up (review request) email was auto-sent
        db.run("ALTER TABLE bookings ADD COLUMN review_email_sent_at DATETIME", (err) => { if (err && !err.message.includes('duplicate column name')) console.log('Note:', err.message); });
        // X3: Structured performance time columns (parsed from free-text performance_slot on write)
        db.run("ALTER TABLE bookings ADD COLUMN performance_start_time TEXT", (err) => { if (err && !err.message.includes('duplicate column name')) console.log('Note:', err.message); });
        db.run("ALTER TABLE bookings ADD COLUMN performance_end_time TEXT", (err) => { if (err && !err.message.includes('duplicate column name')) console.log('Note:', err.message); });
        // Booking attachments: JSON array [{filename, original_name, mime_type, size}]
        db.run("ALTER TABLE bookings ADD COLUMN attachment_files TEXT", (err) => { if (err && !err.message.includes('duplicate column name')) console.log('Note:', err.message); });
        // SC-1: Structured reason code for client-initiated cancellations
        db.run("ALTER TABLE cancellations ADD COLUMN reason_code TEXT", (err) => { if (err && !err.message.includes('duplicate column name')) console.log('Note:', err.message); });
        // X2: Keep amount_outstanding in sync whenever amount_paid or total_amount changes
        db.run(`CREATE TRIGGER IF NOT EXISTS trg_recalc_outstanding
                AFTER UPDATE OF amount_paid, total_amount ON bookings
                FOR EACH ROW WHEN NEW.amount_outstanding != MAX(0, COALESCE(NEW.total_amount,0) - COALESCE(NEW.amount_paid,0))
                BEGIN
                    UPDATE bookings SET amount_outstanding = MAX(0, COALESCE(NEW.total_amount,0) - COALESCE(NEW.amount_paid,0)) WHERE id = NEW.id;
                END`, (err) => { if (err && !err.message.includes('already exists')) console.log('Note (trigger):', err.message); });

        // Auto-set payment_status='PAID' when amount_outstanding reaches 0
        db.run(`CREATE TRIGGER IF NOT EXISTS trg_auto_payment_status
                AFTER UPDATE OF amount_outstanding ON bookings
                FOR EACH ROW WHEN NEW.amount_outstanding = 0 AND COALESCE(NEW.total_amount, 0) > 0 AND NEW.payment_status != 'PAID'
                BEGIN
                    UPDATE bookings SET payment_status = 'PAID' WHERE id = NEW.id;
                END`, (err) => { if (err && !err.message.includes('already exists')) console.log('Note (trigger):', err.message); });

        // Seed initial schema_migrations entries (idempotent)
        db.run(`INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (1, 'initial_tables')`);
        db.run(`INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (2, 'add_clients_venues_quotations')`);
        db.run(`INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (3, 'add_events_audit_triggers_indexes')`);
        db.run(`INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (4, 'add_notifications_schema_migrations')`);
        // Versions 5-49: Retroactively document ALTER TABLE operations and audit remediation (2026-06-19).
        // All use INSERT OR IGNORE so re-running is safe (idempotent).
        db.run(`INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (5, 'add_contracts_signed_by_uploaded_by_signed_date')`);
        db.run(`INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (6, 'add_bookings_client_id_venue_id_google_event_id')`);
        db.run(`INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (7, 'add_quotations_version_archived_sent_at_file_path')`);
        db.run(`INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (8, 'add_invoices_file_path_notes_sent_at_reminders')`);
        db.run(`INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (9, 'add_transactions_source_is_duplicate_reconcile_reference')`);
        db.run(`INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (10, 'add_bookings_cancellation_fields_vat_admin_notes')`);
        db.run(`INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (11, 'add_cancellations_admin_id_refund_tracking')`);
        db.run(`INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (12, 'add_date_holds_event_block_type_google_event_id')`);
        db.run(`INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (13, 'add_bookings_event_id_show_on_website_acceptance_fields')`);
        db.run(`INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (14, 'add_bookings_deposit_balance_reminded_rebooked_from')`);
        db.run(`INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (15, 'add_bookings_performance_times_review_email_attachment')`);
        db.run(`INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (16, 'add_bookings_modified_on_buffer_minutes_quote_expiry_warned')`);
        db.run(`INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (17, 'add_working_hours_consent_audit_analytics_tables')`);
        db.run(`INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (18, 'add_booking_notes_reminders_log_payment_logs')`);
        db.run(`INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (19, 'add_sars_rates_expenses_service_reviews')`);
        db.run(`INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (20, 'add_bookings_payment_method_raw_data_popia')`);
        db.run(`INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (21, 'add_bookings_source_referrer_quotation_id')`);
        db.run(`INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (22, 'add_payment_schedules_invoice_id')`);
        db.run(`INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (23, 'add_invoices_replacement_invoice_id')`);
        db.run(`INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (24, 'add_booking_triggers_recalc_outstanding_auto_payment_status')`);
        db.run(`INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (25, 'audit_2026_status_check_constraint_triggers')`);
        db.run(`INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (26, 'audit_2026_orphan_protection_triggers')`);
        db.run(`INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (27, 'audit_2026_payment_status_machine_fix')`);
        db.run(`INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (28, 'audit_2026_remove_confirmed_from_manual_booking_creation')`);
        db.run(`INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (29, 'audit_2026_quote_line_item_delete_error_callbacks')`);
        db.run(`INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (30, 'audit_2026_invoice_guard_unaccepted_quote')`);
        db.run(`INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (31, 'audit_2026_complete_guard_outstanding_balance')`);
        db.run(`INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (32, 'audit_2026_admin_booking_performance_end_time')`);
        db.run(`INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (33, 'audit_2026_ledger_reconciliation_endpoint')`);
        db.run(`INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (34, 'audit_2026_stalled_booking_admin_alert_job')`);
        db.run(`INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (35, 'audit_2026_auto_event_creation_on_confirmed')`);
        db.run(`INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (36, 'audit_2026_quote_details_write_removed')`);
        db.run(`INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (37, 'audit_2026_invoice_status_casing_fix_admin_html')`);
        db.run(`INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (38, 'audit_2026_manual_booking_validation_admin_html')`);
        db.run(`INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (39, 'audit_2026_quote_builder_line_item_validation')`);
        db.run(`INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (40, 'audit_2026_complete_migrations_tracking')`);
        db.run(`INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (41, 'audit_2026_cancel_route_audit_log')`);
        db.run(`INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (42, 'audit_2026_complete_route_audit_log')`);
        db.run(`INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (43, 'inquiries_status_triggers_audit_indexes')`);
        db.run(`INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (44, 'inquiries_assignment')`);
        db.run(`INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (45, 'inquiries_priority')`);
        db.run(`INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (46, 'inquiry_notes')`);
        db.run(`INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (47, 'inquiries_bookings_conversion_link')`);
        db.run(`INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (48, 'inquiries_sla_response_tracking')`);
        db.run(`INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (99, 'full_schema_history_reconstructed_2026_06_19')`);
        // END schema_migrations seeds

        // Contract management columns
        db.run("ALTER TABLE contracts ADD COLUMN signed_by TEXT", (err) => { if (err && !err.message.includes('duplicate column name')) console.log("Note: contracts.signed_by already exists or error: " + err.message); });
        db.run("ALTER TABLE contracts ADD COLUMN uploaded_by TEXT", (err) => { if (err && !err.message.includes('duplicate column name')) console.log("Note: contracts.uploaded_by already exists or error: " + err.message); });
        db.run("ALTER TABLE contracts ADD COLUMN signed_date TEXT", (err) => { if (err && !err.message.includes('duplicate column name')) console.log("Note: contracts.signed_date already exists or error: " + err.message); });
        // Contract Builder: JSON snapshot of the last-submitted/resolved clause text (parties/fee/cancellation/etc.),
        // so re-opening the editor on an unsigned draft restores prior edits instead of resetting to raw defaults.
        db.run("ALTER TABLE contracts ADD COLUMN builder_clauses TEXT", (err) => { if (err && !err.message.includes('duplicate column name')) console.log("Note: contracts.builder_clauses already exists or error: " + err.message); });

        // Reconciliation columns for transactions
        db.run("ALTER TABLE transactions ADD COLUMN source TEXT DEFAULT 'manual'", (err) => { if (err && !err.message.includes('duplicate column name')) console.log("Note: transactions.source already exists or error: " + err.message); });
        db.run("ALTER TABLE transactions ADD COLUMN is_duplicate INTEGER DEFAULT 0", (err) => { if (err && !err.message.includes('duplicate column name')) console.log("Note: transactions.is_duplicate already exists or error: " + err.message); });
        db.run("ALTER TABLE transactions ADD COLUMN reconcile_note TEXT", (err) => { if (err && !err.message.includes('duplicate column name')) console.log("Note: transactions.reconcile_note already exists or error: " + err.message); });

        // Services catalogue — active/inactive toggle
        db.run("ALTER TABLE services ADD COLUMN is_active INTEGER DEFAULT 1", (err) => { if (err && !err.message.includes('duplicate column name')) console.log("Note: services.is_active already exists or error: " + err.message); });

        // C7: Client-submitted post-event reviews
        db.run(`CREATE TABLE IF NOT EXISTS service_reviews (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            booking_id INTEGER NOT NULL UNIQUE,
            client_name TEXT,
            rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
            review_text TEXT,
            is_approved INTEGER DEFAULT 0,
            submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(booking_id) REFERENCES bookings(id) ON DELETE CASCADE
        )`, (err) => { if (err) console.error('Error creating service_reviews table:', err.message); });

        // Audit log missing columns
        db.run("ALTER TABLE audit_log ADD COLUMN changed_by TEXT", (err) => { if (err && !err.message.includes('duplicate column name')) console.log("Note: audit_log.changed_by already exists or error: " + err.message); });
        db.run("ALTER TABLE audit_log ADD COLUMN changes_json TEXT", (err) => { if (err && !err.message.includes('duplicate column name')) console.log("Note: audit_log.changes_json already exists or error: " + err.message); });

        // Indexes for performance
        db.run(`CREATE INDEX IF NOT EXISTS idx_audit_table_record ON audit_log(table_name, record_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_transactions_booking ON transactions(booking_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_bookings_client ON bookings(client_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_bookings_venue ON bookings(venue_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_cancellations_booking ON cancellations(booking_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_communication_booking ON communication_log(booking_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_date_holds_active ON date_holds(comedian_id, hold_date) WHERE status = 'active'`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_bookings_email ON bookings(email)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_bookings_payment_status ON bookings(payment_status)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_invoices_booking ON invoices(booking_id)`);
        db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_services_name ON services(name)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_transactions_reference ON transactions(reference)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_transactions_source ON transactions(source)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_payment_logs_booking ON payment_logs(booking_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_events_datetime ON events(event_datetime)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_events_status ON events(event_status)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_events_booking ON events(booking_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_events_venue ON events(venue_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_events_gcal ON events(google_calendar_event_id)`);

        // booking_services had NO index despite ON DELETE CASCADE from bookings and frequent
        // joins on booking_id (invoice/quote generation, milestone reads).
        db.run(`CREATE INDEX IF NOT EXISTS idx_booking_services_booking ON booking_services(booking_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_booking_line_items_booking ON booking_line_items(booking_id)`);
        // The public-intake duplicate check filters on lower(email), which idx_bookings_email(email)
        // cannot serve — it was a full scan. This expression index matches the (lower(email), date) predicate.
        db.run(`CREATE INDEX IF NOT EXISTS idx_bookings_email_lower_date ON bookings(lower(email), date)`);
        // Intake-volume analytics and the recency ordering used across admin lists.
        db.run(`CREATE INDEX IF NOT EXISTS idx_bookings_created_at ON bookings(created_at)`);
        // Milestone reads/writes on the payment path.
        db.run(`CREATE INDEX IF NOT EXISTS idx_payment_schedules_booking ON payment_schedules(booking_id)`);
        // pf_payment_id is UNIQUE (auto-indexed), but the ITN dedupe pre-check also queries by reference+source.
        db.run(`CREATE INDEX IF NOT EXISTS idx_transactions_booking_source ON transactions(booking_id, source)`);

        // ==========================================
        // SEEDING DEFAULT DATA
        // ==========================================
        const defaultServices = [
            ['Stand-Up Performance (60 min)', 'Full headline set', 35000.00, 'flat', null, 1, 'unit', 1, 'Performance', 'core', 30, 60, 'per_day'],
            ['Stand-Up Performance (45 min)', 'Feature set', 25000.00, 'flat', null, 1, 'unit', 1, 'Performance', 'core', 30, 45, 'per_day'],
            ['Stand-Up Performance (30 min)', 'Opening set', 15000.00, 'flat', null, 1, 'unit', 1, 'Performance', 'core', 30, 30, 'any_time'],
            ['MC / Hosting', 'Event hosting and crowd work', 20000.00, 'flat', null, 1, 'unit', 1, 'Performance', 'core', 15, 120, 'any_time'],
            ['MC / Hosting (Per Minute)', 'Flexible duration hosting', 333.33, 'per_minute', null, 15, 'min', 1, 'Performance', 'core', 15, 15, 'any_time'],
            ['Travel Buyout (Gauteng)', 'Travel within Gauteng province', 2500.00, 'flat', null, 1, 'unit', 0, 'Travel', 'add-on', 0, 0, 'any_time'],
            ['Travel Buyout (National)', 'Travel anywhere in South Africa', 5000.00, 'flat', null, 1, 'unit', 0, 'Travel', 'add-on', 0, 0, 'any_time']
        ];
        defaultServices.forEach(s => {
            db.run(`INSERT OR IGNORE INTO services (name, description, default_price, pricing_model, base_price, min_quantity, display_unit, is_taxable, category, service_type, setup_time_minutes, performance_length_minutes, availability_rule) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, s);
        });

        const defaultPolicies = [
            ['cancellation_policy', 'Cancellations made 30+ days before the event receive a full refund minus a 10% admin fee. Cancellations 14-29 days receive 50% refund. Cancellations within 14 days are non-refundable.'],
            ['deposit_percentage', '50'],
            ['quote_validity_days', '7'],
            ['payment_terms', '50% non-refundable deposit due upon acceptance of quote. Remaining balance due 48 hours before the event.'],
            ['inquiry_response_sla_hours', '24']
        ];
        defaultPolicies.forEach(p => {
            db.run(`INSERT OR IGNORE INTO policies (policy_key, policy_value) VALUES (?, ?)`, p);
        });

        // ==========================================
        // AUDIT TRIGGERS
        // ==========================================
        db.run(`CREATE TRIGGER IF NOT EXISTS audit_bookings_insert AFTER INSERT ON bookings
        BEGIN
            INSERT INTO audit_log (table_name, record_id, action, new_values, changed_by, change_timestamp)
            VALUES ('bookings', NEW.id, 'INSERT',
                json_object('name', NEW.name, 'email', NEW.email, 'date', NEW.date, 'status', NEW.status),
                'public', CURRENT_TIMESTAMP);
        END`);

        db.run(`CREATE TRIGGER IF NOT EXISTS audit_bookings_update AFTER UPDATE ON bookings
        BEGIN
            INSERT INTO audit_log (table_name, record_id, action, old_values, new_values)
            VALUES ('bookings', NEW.id, 'UPDATE',
                json_object('status', OLD.status, 'total_fee', OLD.total_amount, 'event_date', OLD.date),
                json_object('status', NEW.status, 'total_fee', NEW.total_amount, 'event_date', NEW.date));
        END`);

        db.run(`CREATE TRIGGER IF NOT EXISTS audit_invoices_update AFTER UPDATE ON invoices
        BEGIN
            INSERT INTO audit_log (table_name, record_id, action, old_values, new_values)
            VALUES ('invoices', NEW.id, 'UPDATE',
                json_object('status', OLD.status, 'total_amount', OLD.total_amount),
                json_object('status', NEW.status, 'total_amount', NEW.total_amount));
        END`);

        db.run(`CREATE TRIGGER IF NOT EXISTS audit_transactions_insert AFTER INSERT ON transactions
        BEGIN
            INSERT INTO audit_log (table_name, record_id, action, new_values)
            VALUES ('transactions', NEW.id, 'INSERT',
                json_object('amount', NEW.amount, 'type', NEW.transaction_type, 'status', NEW.status));
        END`);

        db.run(`CREATE TRIGGER IF NOT EXISTS audit_cancellations_insert AFTER INSERT ON cancellations
        BEGIN
            INSERT INTO audit_log (table_name, record_id, action, new_values)
            VALUES ('cancellations', NEW.id, 'INSERT',
                json_object('booking_id', NEW.booking_id, 'cancelled_by', NEW.cancelled_by, 'refund_due', NEW.refund_due));
        END`, (err) => { if (err) console.error("Error creating audit_cancellations_insert trigger:", err.message); });

        db.run(`CREATE TRIGGER IF NOT EXISTS audit_events_insert AFTER INSERT ON events
        BEGIN
            INSERT INTO audit_log (table_name, record_id, action, new_values, changed_by, change_timestamp)
            VALUES ('events', NEW.event_id, 'INSERT',
                json_object('event_title', NEW.event_title, 'event_datetime', NEW.event_datetime, 'event_status', NEW.event_status, 'booking_id', NEW.booking_id),
                CAST(NEW.created_by AS TEXT), CURRENT_TIMESTAMP);
        END`, (err) => { if (err) console.error("Error creating audit_events_insert trigger:", err.message); });

        db.run(`CREATE TRIGGER IF NOT EXISTS audit_events_update AFTER UPDATE ON events
        BEGIN
            INSERT INTO audit_log (table_name, record_id, action, old_values, new_values, changed_by, change_timestamp)
            VALUES ('events', NEW.event_id, 'UPDATE',
                json_object('event_title', OLD.event_title, 'event_datetime', OLD.event_datetime, 'event_status', OLD.event_status),
                json_object('event_title', NEW.event_title, 'event_datetime', NEW.event_datetime, 'event_status', NEW.event_status),
                CAST(NEW.modified_by AS TEXT), CURRENT_TIMESTAMP);
        END`, (err) => { if (err) console.error("Error creating audit_events_update trigger:", err.message); });

        db.run(`CREATE TRIGGER IF NOT EXISTS audit_events_delete AFTER DELETE ON events
        BEGIN
            INSERT INTO audit_log (table_name, record_id, action, old_values, change_timestamp)
            VALUES ('events', OLD.event_id, 'DELETE',
                json_object('event_title', OLD.event_title, 'event_datetime', OLD.event_datetime, 'event_status', OLD.event_status, 'booking_id', OLD.booking_id),
                CURRENT_TIMESTAMP);
        END`, (err) => { if (err) console.error("Error creating audit_events_delete trigger:", err.message); });

        db.run(`CREATE TRIGGER IF NOT EXISTS audit_inquiries_insert AFTER INSERT ON inquiries
        BEGIN
            INSERT INTO audit_log (table_name, record_id, action, new_values, changed_by, change_timestamp)
            VALUES ('inquiries', NEW.inquiry_id, 'INSERT',
                json_object('sender_name', NEW.sender_name, 'sender_email', NEW.sender_email, 'subject', NEW.subject, 'status', NEW.status),
                'public', CURRENT_TIMESTAMP);
        END`, (err) => { if (err) console.error("Error creating audit_inquiries_insert trigger:", err.message); });

        db.run("DROP TRIGGER IF EXISTS audit_inquiries_update");
        db.run(`CREATE TRIGGER IF NOT EXISTS audit_inquiries_update AFTER UPDATE ON inquiries
        BEGIN
            INSERT INTO audit_log (table_name, record_id, action, old_values, new_values, change_timestamp)
            VALUES ('inquiries', NEW.inquiry_id, 'UPDATE',
                json_object('status', OLD.status, 'assigned_to', OLD.assigned_to, 'priority', OLD.priority),
                json_object('status', NEW.status, 'assigned_to', NEW.assigned_to, 'priority', NEW.priority),
                CURRENT_TIMESTAMP);
        END`, (err) => { if (err) console.error("Error creating audit_inquiries_update trigger:", err.message); });

        db.run(`CREATE TRIGGER IF NOT EXISTS audit_inquiries_delete AFTER DELETE ON inquiries
        BEGIN
            INSERT INTO audit_log (table_name, record_id, action, old_values, change_timestamp)
            VALUES ('inquiries', OLD.inquiry_id, 'DELETE',
                json_object('sender_name', OLD.sender_name, 'sender_email', OLD.sender_email, 'subject', OLD.subject, 'status', OLD.status),
                CURRENT_TIMESTAMP);
        END`, (err) => { if (err) console.error("Error creating audit_inquiries_delete trigger:", err.message); });

        // ==========================================
        // STATUS VALIDATION TRIGGERS (CHECK-constraint equivalents for SQLite)
        // These fire BEFORE INSERT/UPDATE on status columns to reject invalid values.
        // 'draft' variants are included as legacy-safe fallbacks for existing rows.
        // ==========================================

        // bookings.status
        db.run(`CREATE TRIGGER IF NOT EXISTS chk_bookings_status_insert
        BEFORE INSERT ON bookings
        WHEN NEW.status NOT IN ('NEW','PENDING','REVIEWED','QUOTED','ACCEPTED','CONFIRMED','COMPLETED','CANCELLED','EXPIRED')
        BEGIN SELECT RAISE(ABORT, 'Invalid bookings.status value'); END`);

        db.run(`CREATE TRIGGER IF NOT EXISTS chk_bookings_status_update
        BEFORE UPDATE OF status ON bookings
        WHEN NEW.status NOT IN ('NEW','PENDING','REVIEWED','QUOTED','ACCEPTED','CONFIRMED','COMPLETED','CANCELLED','EXPIRED')
        BEGIN SELECT RAISE(ABORT, 'Invalid bookings.status value'); END`);

        // bookings.payment_status
        db.run(`CREATE TRIGGER IF NOT EXISTS chk_bookings_payment_status_insert
        BEFORE INSERT ON bookings
        WHEN NEW.payment_status NOT IN ('UNPAID','DEPOSIT_PAID','PARTIALLY_PAID','PAID','REFUNDED','FAILED')
        BEGIN SELECT RAISE(ABORT, 'Invalid bookings.payment_status value'); END`);

        db.run(`CREATE TRIGGER IF NOT EXISTS chk_bookings_payment_status_update
        BEFORE UPDATE OF payment_status ON bookings
        WHEN NEW.payment_status NOT IN ('UNPAID','DEPOSIT_PAID','PARTIALLY_PAID','PAID','REFUNDED','FAILED')
        BEGIN SELECT RAISE(ABORT, 'Invalid bookings.payment_status value'); END`);

        // quotations.status (lowercase convention)
        db.run(`CREATE TRIGGER IF NOT EXISTS chk_quotations_status_insert
        BEFORE INSERT ON quotations
        WHEN NEW.status NOT IN ('draft','sent','accepted','expired','rejected','archived')
        BEGIN SELECT RAISE(ABORT, 'Invalid quotations.status value'); END`);

        db.run(`CREATE TRIGGER IF NOT EXISTS chk_quotations_status_update
        BEFORE UPDATE OF status ON quotations
        WHEN NEW.status NOT IN ('draft','sent','accepted','expired','rejected','archived')
        BEGIN SELECT RAISE(ABORT, 'Invalid quotations.status value'); END`);

        // invoices.status (mixed casing — UPPERCASE for new rows, 'draft' kept for legacy rows)
        db.run(`CREATE TRIGGER IF NOT EXISTS chk_invoices_status_insert
        BEFORE INSERT ON invoices
        WHEN NEW.status NOT IN ('draft','DRAFT','sent','SENT','overdue','OVERDUE','paid','PAID','void','VOID','partially_paid','PARTIALLY_PAID')
        BEGIN SELECT RAISE(ABORT, 'Invalid invoices.status value'); END`);

        db.run(`CREATE TRIGGER IF NOT EXISTS chk_invoices_status_update
        BEFORE UPDATE OF status ON invoices
        WHEN NEW.status NOT IN ('draft','DRAFT','sent','SENT','overdue','OVERDUE','paid','PAID','void','VOID','partially_paid','PARTIALLY_PAID')
        BEGIN SELECT RAISE(ABORT, 'Invalid invoices.status value'); END`);

        // transactions.status (lowercase convention)
        db.run(`CREATE TRIGGER IF NOT EXISTS chk_transactions_status_insert
        BEFORE INSERT ON transactions
        WHEN NEW.status NOT IN ('pending','completed','failed','cancelled','refunded')
        BEGIN SELECT RAISE(ABORT, 'Invalid transactions.status value'); END`);

        db.run(`CREATE TRIGGER IF NOT EXISTS chk_transactions_status_update
        BEFORE UPDATE OF status ON transactions
        WHEN NEW.status NOT IN ('pending','completed','failed','cancelled','refunded')
        BEGIN SELECT RAISE(ABORT, 'Invalid transactions.status value'); END`);

        // payment_schedules.status (lowercase convention)
        db.run("DROP TRIGGER IF EXISTS chk_payment_schedules_status_insert");
        db.run("DROP TRIGGER IF EXISTS chk_payment_schedules_status_update");

        db.run(`CREATE TRIGGER IF NOT EXISTS chk_payment_schedules_status_insert
        BEFORE INSERT ON payment_schedules
        WHEN NEW.status NOT IN ('pending','due_soon','overdue','paid','cancelled','superseded')
        BEGIN SELECT RAISE(ABORT, 'Invalid payment_schedules.status value'); END`);

        db.run(`CREATE TRIGGER IF NOT EXISTS chk_payment_schedules_status_update
        BEFORE UPDATE OF status ON payment_schedules
        WHEN NEW.status NOT IN ('pending','due_soon','overdue','paid','cancelled','superseded')
        BEGIN SELECT RAISE(ABORT, 'Invalid payment_schedules.status value'); END`);

        // date_holds.status (lowercase convention)
        db.run(`CREATE TRIGGER IF NOT EXISTS chk_date_holds_status_insert
        BEFORE INSERT ON date_holds
        WHEN NEW.status NOT IN ('active','expired','converted','cancelled')
        BEGIN SELECT RAISE(ABORT, 'Invalid date_holds.status value'); END`);

        db.run(`CREATE TRIGGER IF NOT EXISTS chk_date_holds_status_update
        BEFORE UPDATE OF status ON date_holds
        WHEN NEW.status NOT IN ('active','expired','converted','cancelled')
        BEGIN SELECT RAISE(ABORT, 'Invalid date_holds.status value'); END`);

        // contracts.status (lowercase convention)
        db.run(`CREATE TRIGGER IF NOT EXISTS chk_contracts_status_insert
        BEFORE INSERT ON contracts
        WHEN NEW.status NOT IN ('draft','sent','signed','active','expired','voided')
        BEGIN SELECT RAISE(ABORT, 'Invalid contracts.status value'); END`);

        db.run(`CREATE TRIGGER IF NOT EXISTS chk_contracts_status_update
        BEFORE UPDATE OF status ON contracts
        WHEN NEW.status NOT IN ('draft','sent','signed','active','expired','voided')
        BEGIN SELECT RAISE(ABORT, 'Invalid contracts.status value'); END`);

        // cancellations.refund_status (lowercase convention)
        db.run(`CREATE TRIGGER IF NOT EXISTS chk_cancellations_refund_status_insert
        BEFORE INSERT ON cancellations
        WHEN NEW.refund_status NOT IN ('pending','processing','processed','failed','cancelled')
        BEGIN SELECT RAISE(ABORT, 'Invalid cancellations.refund_status value'); END`);

        db.run(`CREATE TRIGGER IF NOT EXISTS chk_cancellations_refund_status_update
        BEFORE UPDATE OF refund_status ON cancellations
        WHEN NEW.refund_status NOT IN ('pending','processing','processed','failed','cancelled')
        BEGIN SELECT RAISE(ABORT, 'Invalid cancellations.refund_status value'); END`);

        // inquiries.status (lowercase convention)
        db.run(`CREATE TRIGGER IF NOT EXISTS chk_inquiries_status_insert
        BEFORE INSERT ON inquiries
        WHEN NEW.status NOT IN ('unread','read','replied','archived')
        BEGIN SELECT RAISE(ABORT, 'Invalid inquiries.status value'); END`);

        db.run(`CREATE TRIGGER IF NOT EXISTS chk_inquiries_status_update
        BEFORE UPDATE OF status ON inquiries
        WHEN NEW.status NOT IN ('unread','read','replied','archived')
        BEGIN SELECT RAISE(ABORT, 'Invalid inquiries.status value'); END`);

        // inquiries.priority (mirrors notifications.priority's enum for consistency)
        db.run(`CREATE TRIGGER IF NOT EXISTS chk_inquiries_priority_insert
        BEFORE INSERT ON inquiries
        WHEN NEW.priority NOT IN ('low','normal','high','urgent')
        BEGIN SELECT RAISE(ABORT, 'Invalid inquiries.priority value'); END`);

        db.run(`CREATE TRIGGER IF NOT EXISTS chk_inquiries_priority_update
        BEFORE UPDATE OF priority ON inquiries
        WHEN NEW.priority NOT IN ('low','normal','high','urgent')
        BEGIN SELECT RAISE(ABORT, 'Invalid inquiries.priority value'); END`);

        // ==========================================
        // ORPHAN PROTECTION TRIGGERS
        // SQLite cannot add ON DELETE RESTRICT after table creation, so these BEFORE DELETE
        // triggers prevent booking deletion when financial records exist, mirroring that intent.
        // ==========================================

        db.run(`CREATE TRIGGER IF NOT EXISTS protect_booking_delete_invoices
        BEFORE DELETE ON bookings
        WHEN (SELECT COUNT(*) FROM invoices WHERE booking_id = OLD.id) > 0
        BEGIN SELECT RAISE(ABORT, 'Cannot delete booking: financial records (invoices) exist. Void the invoice first.'); END`);

        db.run(`CREATE TRIGGER IF NOT EXISTS protect_booking_delete_transactions
        BEFORE DELETE ON bookings
        WHEN (SELECT COUNT(*) FROM transactions WHERE booking_id = OLD.id) > 0
        BEGIN SELECT RAISE(ABORT, 'Cannot delete booking: financial records (transactions) exist.'); END`);

        db.run(`CREATE TRIGGER IF NOT EXISTS protect_booking_delete_contracts
        BEFORE DELETE ON bookings
        WHEN (SELECT COUNT(*) FROM contracts WHERE booking_id = OLD.id) > 0
        BEGIN SELECT RAISE(ABORT, 'Cannot delete booking: a contract exists for this booking.'); END`);

        db.run(`CREATE TRIGGER IF NOT EXISTS protect_booking_delete_quotations
        BEFORE DELETE ON bookings
        WHEN (SELECT COUNT(*) FROM quotations WHERE booking_id = OLD.id) > 0
        BEGIN SELECT RAISE(ABORT, 'Cannot delete booking: quotation records exist for this booking.'); END`);

        // Booking scheduling defaults — only inserted once; admin can update via settings UI
        db.run(`INSERT OR IGNORE INTO settings (setting_key, setting_value) VALUES ('working_hours_start', '09:00')`);
        db.run(`INSERT OR IGNORE INTO settings (setting_key, setting_value) VALUES ('working_hours_end', '22:00')`);
        db.run(`INSERT OR IGNORE INTO settings (setting_key, setting_value) VALUES ('min_booking_gap_minutes', '30')`);

        // Per-day-of-week working hours (0=Sunday … 6=Saturday)
        db.run(`CREATE TABLE IF NOT EXISTS working_hours (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            day_of_week INTEGER NOT NULL CHECK(day_of_week BETWEEN 0 AND 6),
            start_time  TEXT NOT NULL DEFAULT '09:00',
            end_time    TEXT NOT NULL DEFAULT '22:00',
            is_working_day INTEGER NOT NULL DEFAULT 1,
            UNIQUE(day_of_week)
        )`, () => {
            // Seed defaults for all 7 days if not yet present
            const days = [0,1,2,3,4,5,6];
            days.forEach(d => {
                db.run(`INSERT OR IGNORE INTO working_hours (day_of_week, start_time, end_time, is_working_day)
                        VALUES (?, '09:00', '22:00', 1)`, [d]);
            });
        });

        // Immutable audit trail for POPIA/GDPR consent records
        db.run(`CREATE TABLE IF NOT EXISTS consent_audit (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            booking_id  INTEGER NOT NULL,
            ip_address  TEXT,
            user_agent  TEXT,
            policy_version TEXT,
            consented_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (booking_id) REFERENCES bookings(id)
        )`, () => {
            db.run("ALTER TABLE consent_audit ADD COLUMN policy_version TEXT", () => {});
        });
        db.run(`CREATE INDEX IF NOT EXISTS idx_consent_audit_booking ON consent_audit(booking_id)`);

        // ============================================================
        // Booking Recovery — abandoned booking drafts (abandoned-cart style)
        // Captures partial booking-wizard progress so admins can recover lost
        // opportunities. PII is minimised, auto-purged after 30 days (see
        // runAbandonedBookingPurgeJob), and reminder emails are consent-gated.
        // ============================================================
        db.run(`CREATE TABLE IF NOT EXISTS abandoned_bookings (
            id                   INTEGER PRIMARY KEY AUTOINCREMENT,
            draft_token          TEXT UNIQUE NOT NULL,   -- client-generated id, stable across autosaves
            resume_token         TEXT UNIQUE,            -- server-generated, used in resume/opt-out links
            name                 TEXT,
            company              TEXT,
            email                TEXT,
            cell                 TEXT,
            event_name           TEXT,
            event_date           TEXT,
            event_start_time     TEXT,
            performance_slot     TEXT,
            performance_duration TEXT,
            event_location       TEXT,
            venue_address        TEXT,
            city                 TEXT,
            country              TEXT,
            venue_type           TEXT,
            event_type           TEXT,
            message              TEXT,
            services_json        TEXT,                   -- snapshot: [{service_id,name,quantity}]
            current_step         INTEGER DEFAULT 1,
            furthest_step        INTEGER DEFAULT 1,
            consent_given        INTEGER DEFAULT 0,      -- ticked the Step-4 POPIA box? gates auto-email
            status               TEXT DEFAULT 'ABANDONED', -- ABANDONED|REMINDED|RECOVERED|WON|LOST|CLOSED
            reminders_sent       INTEGER DEFAULT 0,
            last_reminder_at     DATETIME,
            last_activity_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
            created_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
            converted_booking_id INTEGER,
            opt_out              INTEGER DEFAULT 0,
            source               TEXT,                   -- data-bk-source (which CTA opened the modal)
            ip_address           TEXT,
            user_agent           TEXT,
            est_value            REAL DEFAULT 0          -- estimated value of entered services (lost-revenue analytics)
        )`, () => {
            db.run(`CREATE INDEX IF NOT EXISTS idx_abandoned_status ON abandoned_bookings(status)`);
            db.run(`CREATE INDEX IF NOT EXISTS idx_abandoned_activity ON abandoned_bookings(last_activity_at)`);
            db.run(`CREATE INDEX IF NOT EXISTS idx_abandoned_resume ON abandoned_bookings(resume_token)`);
            db.run(`CREATE INDEX IF NOT EXISTS idx_abandoned_email ON abandoned_bookings(email)`);
        });

        // ============================================================
        // Public booking tracker — email-verification second factor.
        // Knowing a booking id + the email on file used to be sufficient to view the full
        // tracker (quote, payment status, contract, invoice) and to act on it (pay, accept,
        // cancel, sign). booking_access_codes holds short-lived OTP codes sent to the email on
        // file; booking_access_tokens holds the session issued once a code is verified, and is
        // what every tracking route now requires instead of trusting a client-supplied email.
        // ============================================================
        db.run(`CREATE TABLE IF NOT EXISTS booking_access_codes (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            booking_id  INTEGER NOT NULL REFERENCES bookings(id),
            email       TEXT NOT NULL,
            code_hash   TEXT NOT NULL,      -- bcrypt hash of the 6-digit code (low-entropy secret)
            attempts    INTEGER NOT NULL DEFAULT 0,
            consumed    INTEGER NOT NULL DEFAULT 0,
            expires_at  DATETIME NOT NULL,
            created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
        )`, () => {
            db.run(`CREATE INDEX IF NOT EXISTS idx_bac_booking ON booking_access_codes(booking_id, consumed)`);
        });

        db.run(`CREATE TABLE IF NOT EXISTS booking_access_tokens (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            booking_id    INTEGER NOT NULL REFERENCES bookings(id),
            email         TEXT NOT NULL,
            token_hash    TEXT NOT NULL UNIQUE, -- sha256 of the raw token (high-entropy: fast hash, indexed lookup)
            expires_at    DATETIME NOT NULL,
            created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_used_at  DATETIME
        )`, () => {
            db.run(`CREATE INDEX IF NOT EXISTS idx_bat_hash ON booking_access_tokens(token_hash)`);
            db.run(`CREATE INDEX IF NOT EXISTS idx_bat_booking ON booking_access_tokens(booking_id)`);
        });

        // Ensure performance_end_time column exists on bookings (failsafe for older DBs)
        db.run("ALTER TABLE bookings ADD COLUMN performance_end_time TEXT", (err) => { if (err && !err.message.includes('duplicate column name')) console.log('Note: bookings.performance_end_time already exists or error: ' + err.message); });
        db.run("ALTER TABLE bookings ADD COLUMN modified_on DATETIME", (err) => { if (err && !err.message.includes('duplicate column name')) console.log('Note: bookings.modified_on already exists.'); });
        db.run("ALTER TABLE bookings ADD COLUMN buffer_minutes INTEGER DEFAULT NULL", (err) => { if (err && !err.message.includes('duplicate column name')) console.log('Note: bookings.buffer_minutes migration:', err.message); });
        db.run("ALTER TABLE bookings ADD COLUMN consent_source TEXT DEFAULT 'public_form'", (err) => { if (err && !err.message.includes('duplicate column name')) {} });
        db.run("ALTER TABLE consent_audit ADD COLUMN consent_source TEXT DEFAULT 'public_form'", (err) => { if (err && !err.message.includes('duplicate column name')) {} });

        // ============================================================
        // Legal & Compliance Centre — legal documents + version history
        // ============================================================
        // (Gate 2 = schema only) consent_audit already has policy_version + consent_source;
        // add the two genuinely-missing columns. consent_type defaults to 'booking' (accurate for existing rows).
        db.run("ALTER TABLE consent_audit ADD COLUMN consent_type TEXT DEFAULT 'booking'", (err) => { if (err && !err.message.includes('duplicate column name')) {} });
        db.run("ALTER TABLE consent_audit ADD COLUMN source_email TEXT", (err) => { if (err && !err.message.includes('duplicate column name')) {} });

        db.run(`CREATE TABLE IF NOT EXISTS legal_documents (
            id                  INTEGER PRIMARY KEY AUTOINCREMENT,
            document_type       TEXT UNIQUE NOT NULL,
            title               TEXT NOT NULL,
            current_version_id  INTEGER,
            status              TEXT DEFAULT 'draft' CHECK(status IN ('draft','published')),
            last_published_at   DATETIME,
            last_published_by   TEXT,
            created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at          DATETIME DEFAULT CURRENT_TIMESTAMP
        )`, () => {
            db.run(`INSERT OR IGNORE INTO legal_documents (document_type, title, status) VALUES
                ('privacy_policy', 'Privacy Policy', 'published'),
                ('terms_of_use',   'Terms of Use',   'published'),
                ('cookie_policy',  'Cookie & Consent Policy', 'published')`);
        });

        db.run(`CREATE TABLE IF NOT EXISTS legal_document_versions (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            document_id     INTEGER NOT NULL,
            version_number  TEXT NOT NULL,
            content_html    TEXT NOT NULL,
            change_summary  TEXT,
            is_published    INTEGER DEFAULT 0,
            published_at    DATETIME,
            published_by    TEXT,
            created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (document_id) REFERENCES legal_documents(id) ON DELETE CASCADE
        )`, () => {
            // Seed the initial published version (1.0) once, from the existing static legal content.
            db.get("SELECT COUNT(*) AS c FROM legal_document_versions", (err, row) => {
                if (err || (row && row.c > 0)) return;
                const seeds = {
                    privacy_policy: `<h5>1. Introduction</h5>
<p>Welcome to the official website of <strong>Thabiso Mhlongo</strong>. We respect your privacy and are committed to protecting the personal information you share with us.</p>
<h5>2. Information We Collect</h5>
<ul>
<li><strong>Contact &amp; booking forms:</strong> Name, email, phone, event details, and notes.</li>
<li><strong>Newsletter subscriptions:</strong> Your email address.</li>
<li><strong>Technical/usage data:</strong> IP address, browser type, and pages visited via server logs.</li>
</ul>
<p>We do <strong>not</strong> collect payment card details &mdash; payments are processed securely by PayFast.</p>
<h5>3. How We Use Your Information</h5>
<ul>
<li>To respond to contact and booking requests.</li>
<li>To send newsletters to opted-in subscribers.</li>
<li>To generate booking quotes and email correspondence.</li>
<li>To improve website performance and security.</li>
<li>To comply with applicable legal obligations.</li>
</ul>
<h5>4. Cookies &amp; Local Storage</h5>
<ul>
<li><strong>Session cookies:</strong> Admin authentication sessions only.</li>
<li><strong>Local storage:</strong> Cookie consent preference and personalisation settings.</li>
<li><strong>Third-party embeds:</strong> YouTube, Instagram, TikTok, Facebook may set their own cookies.</li>
</ul>
<h5>5. Your Rights (POPIA)</h5>
<p>Under South Africa&rsquo;s <strong>POPIA</strong>, you have the right to access, correct, or delete your data, and to unsubscribe from newsletters at any time. Contact: <a href="mailto:bookings@thabisomhlongo.com">bookings@thabisomhlongo.com</a></p>
<h5>6. Data Security</h5>
<p>We implement bcrypt password hashing, session-based authentication, rate limiting on public forms, and duplicate submission prevention.</p>
<h5>7. Changes to This Policy</h5>
<p>We may update this policy at any time. Continued use of the website after changes constitutes acceptance of the revised policy.</p>`,
                    terms_of_use: `<h5>1. Introduction</h5>
<p>These Terms &amp; Conditions govern your use of the official website of <strong>Thabiso Mhlongo</strong>. By using this website, you agree to these Terms.</p>
<h5>2. Use of the Website</h5>
<ul>
<li>Do not access unauthorised areas or attempt to bypass security.</li>
<li>Do not use bots or scrapers to collect data without consent.</li>
<li>Do not interfere with or damage servers or infrastructure.</li>
<li>Do not impersonate others or use the site fraudulently.</li>
</ul>
<h5>3. Bookings &amp; Inquiries</h5>
<p>Submitting a booking request does <strong>not</strong> constitute a confirmed booking. All bookings are subject to availability, management review, and a separate written agreement confirmed only upon written confirmation and receipt of any required deposit.</p>
<h5>4. Intellectual Property</h5>
<p>All content is the exclusive property of Thabiso Mhlongo or licensed to him. You may not copy, reproduce, or use any content for commercial purposes without prior written consent.</p>
<h5>5. Limitation of Liability</h5>
<p>Thabiso Mhlongo and his management shall not be liable for any direct, indirect, or consequential damages arising from use of this website. The site is provided &ldquo;as is&rdquo; without warranties of any kind.</p>
<h5>6. Privacy</h5>
<p>Use of this website is also governed by our Privacy Policy, incorporated into these Terms by reference.</p>
<h5>7. Governing Law</h5>
<p>These Terms are governed by the laws of the <strong>Republic of South Africa</strong>.</p>
<h5>8. Contact</h5>
<p><a href="mailto:bookings@thabisomhlongo.com">bookings@thabisomhlongo.com</a> &mdash; WhatsApp: <a href="https://wa.me/27843235075" target="_blank">+27 84 323 5075</a></p>`,
                    cookie_policy: `<p>We use cookies to personalise content, analyse traffic, and enhance your experience on this site. Some are essential; others help us improve. Choose your preferences below &mdash; you can change them at any time via Cookie Settings in the footer.</p>`
                };
                Object.keys(seeds).forEach((type) => {
                    db.get("SELECT id FROM legal_documents WHERE document_type = ?", [type], (e2, doc) => {
                        if (e2 || !doc) return;
                        db.run(`INSERT INTO legal_document_versions
                            (document_id, version_number, content_html, change_summary, is_published, published_at, published_by)
                            VALUES (?, '1.0', ?, 'Initial seeded version', 1, CURRENT_TIMESTAMP, 'system')`,
                            [doc.id, seeds[type]], function () {
                                const vid = this.lastID;
                                db.run(`UPDATE legal_documents
                                        SET current_version_id = ?, status = 'published',
                                            last_published_at = CURRENT_TIMESTAMP, last_published_by = 'system'
                                        WHERE id = ?`, [vid, doc.id]);
                            });
                    });
                });
            });
        });
        db.run(`CREATE INDEX IF NOT EXISTS idx_legal_versions_doc ON legal_document_versions(document_id)`);

        db.run(`CREATE INDEX IF NOT EXISTS idx_working_hours_dow ON working_hours(day_of_week)`);

        // ── Analytics Tables ──────────────────────────────────────────────────────────

        // Individual page-view events (one row per visit to index.html)
        db.run(`CREATE TABLE IF NOT EXISTS analytics_pageviews (
            id              INTEGER  PRIMARY KEY AUTOINCREMENT,
            session_id      TEXT     NOT NULL,
            visitor_id      TEXT     NOT NULL,
            page            TEXT     NOT NULL DEFAULT '/',
            referrer        TEXT,
            referrer_host   TEXT,
            channel         TEXT,
            utm_source      TEXT,
            utm_medium      TEXT,
            utm_campaign    TEXT,
            country_code    TEXT,
            country_name    TEXT,
            device_type     TEXT,
            browser         TEXT,
            os              TEXT,
            dwell_seconds   INTEGER  DEFAULT 0,
            viewed_at       DATETIME DEFAULT CURRENT_TIMESTAMP
        )`, () => {
            db.run(`CREATE INDEX IF NOT EXISTS idx_apv_session  ON analytics_pageviews(session_id)`);
            db.run(`CREATE INDEX IF NOT EXISTS idx_apv_visitor  ON analytics_pageviews(visitor_id)`);
            db.run(`CREATE INDEX IF NOT EXISTS idx_apv_date     ON analytics_pageviews(viewed_at)`);
            db.run(`CREATE INDEX IF NOT EXISTS idx_apv_channel  ON analytics_pageviews(channel)`);
        });

        // One row per visitor session (30-minute inactivity window)
        db.run(`CREATE TABLE IF NOT EXISTS analytics_sessions (
            id                   INTEGER  PRIMARY KEY AUTOINCREMENT,
            session_id           TEXT     NOT NULL UNIQUE,
            visitor_id           TEXT     NOT NULL,
            started_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
            ended_at             DATETIME,
            entry_page           TEXT,
            exit_page            TEXT,
            page_count           INTEGER  DEFAULT 1,
            total_dwell_seconds  INTEGER  DEFAULT 0,
            is_bounce            INTEGER  DEFAULT 1,
            country_code         TEXT,
            country_name         TEXT,
            device_type          TEXT,
            browser              TEXT,
            os                   TEXT,
            channel              TEXT,
            referrer_host        TEXT,
            utm_source           TEXT,
            utm_medium           TEXT,
            utm_campaign         TEXT
        )`, () => {
            db.run(`CREATE INDEX IF NOT EXISTS idx_as_visitor ON analytics_sessions(visitor_id)`);
            db.run(`CREATE INDEX IF NOT EXISTS idx_as_date    ON analytics_sessions(started_at)`);
        });

        // Daily pre-aggregated summary for fast dashboard queries
        db.run(`CREATE TABLE IF NOT EXISTS analytics_daily (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            date             TEXT    NOT NULL UNIQUE,
            pageviews        INTEGER DEFAULT 0,
            unique_visitors  INTEGER DEFAULT 0,
            sessions         INTEGER DEFAULT 0,
            bounced_sessions INTEGER DEFAULT 0,
            total_dwell_secs INTEGER DEFAULT 0
        )`);

        // Admin login and activity logs table
        db.run(`CREATE TABLE IF NOT EXISTS admin_login_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            admin_id INTEGER NOT NULL,
            login_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            logout_at DATETIME,
            last_activity_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            duration_seconds INTEGER DEFAULT 0,
            ip_address TEXT,
            user_agent TEXT,
            FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE CASCADE
        )`, () => {
            db.run(`CREATE INDEX IF NOT EXISTS idx_admin_login_logs_admin ON admin_login_logs(admin_id)`);
        });


        // Status casing normalization migrations.
        // NOTE (Phase 2 Gap 4): 'RESPONDED' was a legacy status name that has been retired.
        // The migration below converts any stale RESPONDED/RESPOND rows back to PENDING on every
        // startup. The status is no longer set by any code path in server.js.
        db.run("UPDATE bookings SET status = 'PENDING' WHERE status IS NOT NULL AND UPPER(status) IN ('RESPONDED', 'RESPOND')");
        db.run("UPDATE bookings SET status = UPPER(status) WHERE status IS NOT NULL");
        db.run("UPDATE inquiries SET status = LOWER(status) WHERE status IS NOT NULL");
        db.run("UPDATE quotations SET status = LOWER(status) WHERE status IS NOT NULL");
        db.run("UPDATE invoices SET status = UPPER(status) WHERE status IS NOT NULL");
        db.run("UPDATE contracts SET status = LOWER(status) WHERE status IS NOT NULL");
        db.run("UPDATE payment_schedules SET status = LOWER(status) WHERE status IS NOT NULL");
        db.run("UPDATE date_holds SET status = LOWER(status) WHERE status IS NOT NULL");
        db.run("UPDATE transactions SET status = LOWER(status) WHERE status IS NOT NULL");

        db.run("INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (100, 'abandoned_booking_recovery_system')");

        console.log('Database tables initialized successfully.');
    });
}

module.exports = db;
