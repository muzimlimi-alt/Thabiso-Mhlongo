const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

const dbPath = path.resolve(__dirname, 'database.sqlite');
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
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`, (err) => {
            if (!err) {

                // Ensure legacy columns exist
                db.run("ALTER TABLE admins ADD COLUMN email TEXT", () => {
                    db.run("UPDATE admins SET email = 'admin@thabisomhlongo.com' WHERE username = 'admin' AND (email IS NULL OR email = '')", () => {});
                });
                db.run("ALTER TABLE admins ADD COLUMN must_change_password INTEGER DEFAULT 0", () => {});
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
        });

        // 7. Gallery Images Table
        db.run(`CREATE TABLE IF NOT EXISTS gallery_images (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT,
            image_path TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
         // 8. Manager Details Table
        db.run(`CREATE TABLE IF NOT EXISTS manager_details (
            manager_id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            cell_number TEXT NOT NULL,
            whatsapp_number TEXT NOT NULL,
            email TEXT NOT NULL,
            created_on DATETIME DEFAULT CURRENT_TIMESTAMP,
            created_by INTEGER,
            modified_on DATETIME,
            modified_by INTEGER,
            FOREIGN KEY (created_by) REFERENCES admins (id),
            FOREIGN KEY (modified_by) REFERENCES admins (id)
        )`, () => {
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

        // 1.2 Create the service_uoms table
        db.run(`CREATE TABLE IF NOT EXISTS service_uoms (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            service_id INTEGER NOT NULL,
            uom_code TEXT NOT NULL,          -- e.g., 'ea', 'min', 'hr'
            conversion_factor REAL DEFAULT 1.0, -- e.g., 1 hr = 60 min
            is_base_uom BOOLEAN DEFAULT 0,
            FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE CASCADE,
            UNIQUE(service_id, uom_code)
        )`);

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
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS sars_rates (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            rate_type TEXT CHECK(rate_type IN ('mileage','per_diem_local','per_diem_international')),
            rate_amount DECIMAL(8,2) NOT NULL,
            effective_from DATE NOT NULL,
            effective_to DATE,
            notes TEXT
        )`);
        db.run(`INSERT OR IGNORE INTO sars_rates (rate_type, rate_amount, effective_from) VALUES ('mileage', 4.84, '2026-03-01')`);
        db.run(`INSERT OR IGNORE INTO sars_rates (rate_type, rate_amount, effective_from) VALUES ('per_diem_local', 522.00, '2026-03-01')`);

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
            status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'sent', 'failed', 'read', 'dismissed')),
            priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
            recipient_email TEXT,
            recipient_name TEXT,
            subject TEXT,
            body TEXT,
            related_entity TEXT,
            related_id INTEGER,
            scheduled_at DATETIME,
            sent_at DATETIME,
            read_at DATETIME,
            retry_count INTEGER DEFAULT 0,
            error_message TEXT,
            created_by INTEGER REFERENCES admins(id),
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_notifications_status ON notifications(status)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_notifications_entity ON notifications(related_entity, related_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_notifications_scheduled ON notifications(scheduled_at)`);

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

        // bookings: admin notes + background clerk tracking columns
        db.run("ALTER TABLE bookings ADD COLUMN admin_notes TEXT", (err) => { if (err && !err.message.includes('duplicate column name')) console.log('Note:', err.message); });
        db.run("ALTER TABLE bookings ADD COLUMN quote_expiry_warned DATETIME", (err) => { if (err && !err.message.includes('duplicate column name')) console.log('Note:', err.message); });
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

        // Contract management columns
        db.run("ALTER TABLE contracts ADD COLUMN signed_by TEXT", (err) => { if (err && !err.message.includes('duplicate column name')) console.log("Note: contracts.signed_by already exists or error: " + err.message); });
        db.run("ALTER TABLE contracts ADD COLUMN uploaded_by TEXT", (err) => { if (err && !err.message.includes('duplicate column name')) console.log("Note: contracts.uploaded_by already exists or error: " + err.message); });
        db.run("ALTER TABLE contracts ADD COLUMN signed_date TEXT", (err) => { if (err && !err.message.includes('duplicate column name')) console.log("Note: contracts.signed_date already exists or error: " + err.message); });

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
            ['payment_terms', '50% non-refundable deposit due upon acceptance of quote. Remaining balance due 48 hours before the event.']
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
            consented_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (booking_id) REFERENCES bookings(id)
        )`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_consent_audit_booking ON consent_audit(booking_id)`);

        // Ensure performance_end_time column exists on bookings (failsafe for older DBs)
        db.run("ALTER TABLE bookings ADD COLUMN performance_end_time TEXT", (err) => { if (err && !err.message.includes('duplicate column name')) console.log('Note: bookings.performance_end_time already exists or error: ' + err.message); });
        db.run("ALTER TABLE bookings ADD COLUMN modified_on DATETIME", (err) => { if (err && !err.message.includes('duplicate column name')) console.log('Note: bookings.modified_on already exists.'); });
        db.run("ALTER TABLE bookings ADD COLUMN buffer_minutes INTEGER DEFAULT NULL", (err) => { if (err && !err.message.includes('duplicate column name')) console.log('Note: bookings.buffer_minutes migration:', err.message); });

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

        console.log('Database tables initialized successfully.');
    });
}

module.exports = db;
