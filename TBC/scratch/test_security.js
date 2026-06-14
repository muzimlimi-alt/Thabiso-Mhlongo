const BASE_URL = 'http://localhost:3000';

async function test_7_2_UnsubscribeRateLimit() {
    console.log('\n--- Test 7.2: Unsubscribe Rate Limiting ---');
    const requests = [];
    for (let i = 0; i < 15; i++) {
        requests.push(fetch(`${BASE_URL}/api/public/newsletter/unsubscribe`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: 'test@example.com', token: 'some-token' })
        }));
    }

    const results = await Promise.all(requests);
    let count429 = 0;
    for (const res of results) {
        if (res.status === 429) count429++;
    }
    console.log(`Received ${count429} 429 responses.`);
    if (count429 > 0) {
        console.log('✅ Test 7.2 PASS: Rate limiting triggered.');
    } else {
        console.log('❌ Test 7.2 FAIL: Rate limiting NOT triggered on unsubscribe.');
    }
}

async function test_7_3_HeaderInjection() {
    console.log('\n--- Test 7.3: Email Header Injection Attempt ---');
    const maliciousEmail = "muzi.mlimi@gmail.com\r\nBCC: spam@test.com";
    try {
        const response = await fetch(`${BASE_URL}/send-email`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: 'Hacker',
                email: maliciousEmail,
                subject: 'Header Injection Test',
                message: 'Should be safe.'
            })
        });
        const data = await response.json();
        console.log('Response:', data);
        
        // We'd need to check the logs to see if it was sanitized
        console.log('✅ Test 7.3: Request sent. Manual inspection of logs for CRLF removal required.');
    } catch (err) {
        console.error('❌ Test 7.3 ERROR:', err.message);
    }
}

async function runTests() {
    await test_7_2_UnsubscribeRateLimit();
    await test_7_3_HeaderInjection();
    process.exit(0);
}

runTests();
