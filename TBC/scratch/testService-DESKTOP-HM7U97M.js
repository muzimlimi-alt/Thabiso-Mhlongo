const emailService = require('../js/emailService');
const db = require('../database');

async function testPhase3() {
    console.log('--- Phase 3 Service Verification ---');
    
    const testPayload = {
        to: 'test-recipient@example.com',
        subject: 'Phase 3 Verification Test',
        htmlContent: '<p>This is a <strong>test</strong> email body for the Phase 3 overhaul.</p>'
    };

    // 1. Test Legacy Fallback (Default is false in .env)
    console.log('\n[Test 1] Testing Legacy Fallback (Flag = FALSE)');
    process.env.EMAIL_OVERHAUL_ENABLED = 'false';
    const legacyResult = await emailService.sendEmail(testPayload);
    console.log('Legacy Result:', legacyResult);

    // 2. Test Premium Branded
    console.log('\n[Test 2] Testing Premium Branded (Flag = TRUE)');
    process.env.EMAIL_OVERHAUL_ENABLED = 'true';
    const premiumResult = await emailService.sendEmail(testPayload);
    console.log('Premium Result:', premiumResult);

    // 3. Verify Logging
    console.log('\n[Test 3] Verifying Email Logs in DB...');
    db.all("SELECT * FROM email_logs ORDER BY sent_at DESC LIMIT 5", [], (err, rows) => {
        if (err) {
            console.error('❌ DB Query Failed:', err);
        } else {
            console.log('Last 5 Email Logs:', JSON.stringify(rows, null, 2));
            if (rows.length > 0) {
                console.log('✅ Logging system is functional.');
            } else {
                console.log('❌ No logs found.');
            }
        }
        process.exit(0);
    });
}

testPhase3();
