// FAQ - table definition and starter drafts (migration 121). lib/faq.js holds every rule; docs: the header of lib/faq.js.
//
// The starter questions describe how the website actually works today (booking -> quote -> accept -> invoice / contract; Track Booking with an
// e-mailed code; PayFast and bank transfer with proof of payment; up to four instalments; tickets with QR codes). They are seeded HIDDEN
// ('inactive'), once, and only into an empty table: nothing reaches the public site until the owner has read, edited and published it. No
// prices anywhere - the site never publishes prices before a quotation.

const MIGRATION_VERSION = 121;
const MIGRATION_NAME = 'faq';

const CREATE_SQL = [
    `CREATE TABLE IF NOT EXISTS faqs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        question TEXT NOT NULL,
        answer TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'general' CHECK (category IN ('bookings', 'payments', 'events', 'general')),
        display_order INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'inactive' CHECK (status IN ('active', 'inactive')),
        created_by INTEGER REFERENCES admins(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_by INTEGER REFERENCES admins(id) ON DELETE SET NULL,
        updated_at TEXT
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_faqs_question ON faqs(lower(question))`,
    `CREATE INDEX IF NOT EXISTS idx_faqs_public ON faqs(status, category, display_order)`
];

// "How can I pay?" - bank transfer is live (banking details entered 2026-10-19), so no "where offered" hedge. PAY_ANSWER_V1 is the first wording,
// replaced on existing databases only while it is still untouched (an owner's own edit is never overwritten).
const PAY_ANSWER = "You can pay online through PayFast, by card or instant EFT, or by bank transfer using the banking details on your invoice.\n\nAfter a bank transfer, upload your proof of payment under Track Booking. It is confirmed once we have matched it on our bank statement.";
const PAY_ANSWER_V1 = "You can pay online through PayFast, by card or instant EFT.\n\nWhere bank transfer is offered, use the banking details on your invoice and upload your proof of payment under Track Booking. A bank transfer is confirmed once we have matched it on our bank statement.";

const STARTERS = [
    ['bookings', 'How do I book Thabiso for my event?', "Use the Book Me button and tell us about your event: the date, the venue, the kind of event and what you have in mind.\n\nWe review every request and send you a quotation made for your event. When you accept it online, your invoice and contract follow, and your date is secured once the first payment is received."],
    ['bookings', "Why aren't prices listed on the website?", "Every event is different. The length of the set, the location, travel and the kind of performance all change what is involved, so each booking gets its own quotation rather than a fixed price list."],
    ['bookings', 'How long is my quotation valid?', "Your quotation shows its expiry date. If you need more time, or would like something changed, you can ask for an extension or a revision straight from your booking under Track Booking."],
    ['bookings', 'Can I check on my booking after I have sent it?', "Yes. Choose Track Booking, enter your booking number and e-mail address, and we will e-mail you a one-time code.\n\nFrom there you can follow your booking's progress, accept your quotation, pay, sign your contract and keep your contact details up to date."],
    ['payments', 'How can I pay?', PAY_ANSWER],
    ['payments', 'Can I pay in instalments?', "Yes. When you accept your quotation you can choose to pay in up to four instalments: a deposit first, then the balance split evenly. Your payment schedule shows each due date, and we send a reminder before each one."],
    ['bookings', 'What happens if I need to cancel?', "Please contact us as soon as you can. Cancellations follow the cancellation policy in your contract and our Terms of Use, and any refund due depends on how close to the event date the booking is cancelled."],
    ['events', 'How do I buy tickets for a show?', "Open the show under Events and choose Get tickets. You pay securely through PayFast, and your tickets, each with its own QR code, are e-mailed to you straight away."],
    ['events', "I haven't received my tickets. What should I do?", "First check your spam or promotions folder. If they are not there, contact us with your order reference and we will send them again."],
    ['general', 'How do I get in touch?', "Use the contact form on this page and we will reply by e-mail. For bookings, the Book Me form is the quickest way to reach us."]
];

function apply(db) {
    for (const sql of CREATE_SQL) db.run(sql);
    // starter drafts: once (before the marker exists) and only into an empty table
    const t = new Date().toISOString();
    STARTERS.forEach(([category, question, answer], i) => {
        db.run(`INSERT INTO faqs (question, answer, category, display_order, status, created_at)
                SELECT ?, ?, ?, ?, 'inactive', ?
                 WHERE NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = ?)
                   AND (SELECT COUNT(*) FROM faqs) < ?`,
            [question, answer, category, i + 1, t, MIGRATION_VERSION, STARTERS.length]);
    });
    db.run('INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (?, ?)', [MIGRATION_VERSION, MIGRATION_NAME]);
    // updated starter wording: only where the answer is still exactly the first version
    db.run("UPDATE faqs SET answer = ?, updated_at = ? WHERE question = 'How can I pay?' AND answer = ?", [PAY_ANSWER, new Date().toISOString(), PAY_ANSWER_V1]);
}

module.exports = { MIGRATION_VERSION, MIGRATION_NAME, CREATE_SQL, STARTERS, apply };
