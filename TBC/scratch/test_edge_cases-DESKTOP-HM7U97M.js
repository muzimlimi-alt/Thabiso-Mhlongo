// No axios, use native fetch (available in Node 24)
const fs = require('fs');
const path = require('path');

const BASE_URL = 'http://localhost:3000';

async function test_5_1_5_2_MissingAssets() {
    console.log('\n--- Test 5.1 & 5.2: Missing Banner/Logo ---');
    const bannerPath = path.join(__dirname, '..', 'images', 'banner', 'banner_3_contemplation.png');
    const logoPath = path.join(__dirname, '..', 'images', 'logo4.png');
    
    const bannerBackup = bannerPath + '.bak';
    const logoBackup = logoPath + '.bak';

    try {
        // Rename both
        if (fs.existsSync(bannerPath)) fs.renameSync(bannerPath, bannerBackup);
        if (fs.existsSync(logoPath)) fs.renameSync(logoPath, logoBackup);
        console.log('Renamed assets to .bak');

        const response = await fetch(`${BASE_URL}/send-email`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: 'Test Visitor',
                email: 'muzi.mlimi@gmail.com',
                subject: 'Test Missing Assets',
                message: 'Testing if email sends without banner and logo.'
            })
        });

        const data = await response.json();
        console.log('Email Send Response:', data);
        if (data.success) {
            console.log('✅ Test 5.1 & 5.2 PASS: Email sent despite missing assets.');
        } else {
            console.log('❌ Test 5.1 & 5.2 FAIL:', data.message);
        }
    } catch (err) {
        console.error('❌ Test 5.1 & 5.2 ERROR:', err.message);
    } finally {
        // Restore
        if (fs.existsSync(bannerBackup)) fs.renameSync(bannerBackup, bannerPath);
        if (fs.existsSync(logoBackup)) fs.renameSync(logoBackup, logoPath);
        console.log('Restored assets');
    }
}

async function test_5_3_InvalidRecipient() {
    console.log('\n--- Test 5.3: Invalid Recipient Email ---');
    try {
        const response = await fetch(`${BASE_URL}/api/public/bookings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: 'Chaos Monkey',
                email: 'invalid-email-format',
                cell: '1234567890',
                event_date: '2026-12-25',
                event_location: 'Nowhere',
                event_type: 'Test',
                message: 'This should fail validation or send logic.'
            })
        });
        const data = await response.json();
        console.log('Response Status:', response.status);
        console.log('Response Data:', data);
        if (!response.ok) {
            console.log('✅ Test 5.3 PASS: Server returned error for invalid email.');
        } else {
            console.log('❌ Test 5.3 FAIL: Server accepted invalid email format.');
        }
    } catch (err) {
        console.log('❌ Test 5.3 ERROR:', err.message);
    }
}

async function test_5_5_LongMessage() {
    console.log('\n--- Test 5.5: Long Message (10,000 chars) ---');
    const longMsg = 'A'.repeat(10000);
    try {
        const response = await fetch(`${BASE_URL}/send-email`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: 'Long Winded',
                email: 'muzi.mlimi@gmail.com',
                subject: 'Test Long Message',
                message: longMsg
            })
        });
        const data = await response.json();
        if (data.success) {
            console.log('✅ Test 5.5 PASS: Long message sent successfully.');
        } else {
            console.log('❌ Test 5.5 FAIL:', data.message);
        }
    } catch (err) {
        console.error('❌ Test 5.5 ERROR:', err.message);
    }
}

async function runTests() {
    await test_5_1_5_2_MissingAssets();
    await test_5_3_InvalidRecipient();
    await test_5_5_LongMessage();
    process.exit(0);
}

runTests();
