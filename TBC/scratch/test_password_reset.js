const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcrypt');
const dbPath = path.resolve(__dirname, '../database.sqlite');
const db = new sqlite3.Database(dbPath);

const BASE_URL = 'http://localhost:3000';
const TEST_EMAIL = 'muzi.mlimi@gmail.com'; // Corrected email
const TEST_TOKEN = 'test_token_raw_12345';
const NEW_PASS = 'new_password_secure_99';

async function runTests() {
    console.log('\n--- Test 4.1: Password Reset Request ---');
    try {
        await new Promise((resolve) => db.run("DELETE FROM password_reset_tokens", resolve));

        const forgotRes = await fetch(`${BASE_URL}/api/admin/forgot-password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: TEST_EMAIL })
        });
        const forgotData = await forgotRes.json();
        console.log('Forgot Password Response:', forgotData);
        
        // Wait 1 second for DB write
        await new Promise(r => setTimeout(r, 1000));

        const tokenRow = await new Promise((resolve) => {
            db.get("SELECT * FROM password_reset_tokens WHERE admin_id = (SELECT id FROM admins WHERE email = ? LIMIT 1)", [TEST_EMAIL], (err, row) => resolve(row));
        });

        if (tokenRow) {
            console.log('✅ Test 4.1 PASS: Token record created in DB.');
        } else {
            console.error('❌ Test 4.1 FAIL: No token record found.');
        }
    } catch (e) {
        console.error('❌ Test 4.1 ERROR:', e.message);
    }

    console.log('\n--- Test 4.2: Reset Password with Valid Token ---');
    try {
        const hash = await bcrypt.hash(TEST_TOKEN, 10);
        const expiresAt = new Date(Date.now() + 3600000).toISOString();
        
        await new Promise((resolve) => {
            db.run("INSERT INTO password_reset_tokens (admin_id, token_hash, expires_at) SELECT id, ?, ? FROM admins WHERE email = ? LIMIT 1", [hash, expiresAt, TEST_EMAIL], resolve);
        });

        const resetRes = await fetch(`${BASE_URL}/api/admin/reset-password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email: TEST_EMAIL,
                token: TEST_TOKEN,
                newPassword: NEW_PASS
            })
        });
        const resetData = await resetRes.json();
        
        console.log('Reset Password Response:', resetData);
        if (resetData.success) {
            console.log('✅ Test 4.2 PASS: Password reset successful with valid token.');
            
            // Verify token consumed
            const checkToken = await new Promise((resolve) => {
                db.get("SELECT * FROM password_reset_tokens", (err, row) => resolve(row));
            });
            if (!checkToken) console.log('✅ Test 4.2 PASS: Token consumed (deleted from DB).');
            else console.error('❌ Test 4.2 FAIL: Token still exists in DB.');
        } else {
            console.error('❌ Test 4.2 FAIL: Success response not received.');
        }
    } catch (e) {
        console.error('❌ Test 4.2 ERROR:', e.message);
    }

    console.log('\n--- Test 4.3: Invalid / Expired Token ---');
    try {
        // 4.3a: Invalid Token
        const invalidRes = await fetch(`${BASE_URL}/api/admin/reset-password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email: TEST_EMAIL,
                token: 'wrong_token',
                newPassword: 'some_pass'
            })
        });
        if (invalidRes.status === 400) console.log('✅ Test 4.3a PASS: Invalid token rejected (400).');
        else console.error('❌ Test 4.3a FAIL: Expected 400, got', invalidRes.status);

        // 4.3b: Expired Token
        const hash = await bcrypt.hash(TEST_TOKEN, 10);
        const expiredAt = "2000-01-01 00:00:00"; // Long ago
        await new Promise((resolve) => {
            db.run("INSERT INTO password_reset_tokens (admin_id, token_hash, expires_at) SELECT id, ?, ? FROM admins WHERE email = ? LIMIT 1", [hash, expiredAt, TEST_EMAIL], resolve);
        });

        const expiredRes = await fetch(`${BASE_URL}/api/admin/reset-password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email: TEST_EMAIL,
                token: TEST_TOKEN,
                newPassword: 'some_pass'
            })
        });
        if (expiredRes.status === 400) console.log('✅ Test 4.3b PASS: Expired token rejected (400).');
        else console.error('❌ Test 4.3b FAIL: Expected 400, got', expiredRes.status);
    } catch (e) {
        console.error('❌ Test 4.3 ERROR:', e.message);
    }

    // Reset password back
    const defaultHash = await bcrypt.hash('admin', 10);
    await new Promise(r => db.run("UPDATE admins SET password_hash = ? WHERE username = 'admin'", [defaultHash], r));
    console.log('\nCleanup: Reset admin password back to "admin".');

    db.close();
}

runTests();
