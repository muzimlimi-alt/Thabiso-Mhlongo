const server = require('../server'); // We might need to mock some things or just test the functions directly if exported
const { sendEmail } = require('../js/emailService');

async function verifyPhase4() {
    console.log('--- Phase 4: Systematic Verification ---');
    
    // Enabling overhaul for this test
    process.env.EMAIL_OVERHAUL_ENABLED = 'true';

    console.log('[Test 1] Simulating Inquiry Notification (Admin)...');
    const adminRes = await sendEmail({
        to: 'admin-test@example.com',
        subject: 'Website Inquiry: Corporate Booking',
        htmlContent: '<p>Name: John Doe<br>Message: Testing Phase 4 migration.</p>',
        replyTo: 'visitor-test@example.com',
        titleOverride: 'New Website Inquiry'
    });
    console.log('Admin Notify Result:', adminRes);

    console.log('\n[Test 2] Simulating Inquiry Receipt (Visitor)...');
    const visitorRes = await sendEmail({
        to: 'visitor-test@example.com',
        subject: 'Thank you for your message, John!',
        htmlContent: '<p>We have received your inquiry and will review it shortly.</p>',
        titleOverride: "We've Received Your Message!"
    });
    console.log('Visitor Receipt Result:', visitorRes);

    console.log('\n--- Phase 4 Verification Complete ---');
    process.exit(0);
}

verifyPhase4();
