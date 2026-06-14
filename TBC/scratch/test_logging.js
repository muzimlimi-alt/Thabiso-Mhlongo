const emailService = require('../js/emailService');
const db = require('../database');

async function test() {
    console.log("Starting test email...");
    const result = await emailService.sendEmail({
        to: 'test@example.com',
        subject: 'Scratch Test Email',
        htmlContent: '<p>Test message</p>',
        trigger_event: 'Scratch Test'
    });
    console.log("Send result:", result);
    
    // Check DB manually with a delay
    setTimeout(() => {
        db.all("SELECT * FROM email_logs", [], (err, rows) => {
            if (err) console.error("Query Error:", err);
            console.log("Email Logs entries:", rows);
            process.exit(0);
        });
    }, 2000);
}

test();
