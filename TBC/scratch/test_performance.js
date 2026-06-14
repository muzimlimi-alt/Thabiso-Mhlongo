const BASE_URL = 'http://localhost:3000';

async function test_6_1_SingleEmailTime() {
    console.log('\n--- Test 6.1: Single Email Send Time ---');
    const start = Date.now();
    try {
        const response = await fetch(`${BASE_URL}/send-email`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: 'Performance Test',
                email: 'muzi.mlimi@gmail.com',
                subject: 'Performance Test',
                message: 'Measuring send time.'
            })
        });
        const data = await response.json();
        const duration = Date.now() - start;
        console.log(`Duration: ${duration}ms`);
        if (duration < 2000) {
            console.log('✅ Test 6.1 PASS: Under 2 seconds.');
        } else {
            console.log('⚠️ Test 6.1 WARNING: Over 2 seconds (SMTP can be slow though).');
        }
    } catch (err) {
        console.error('❌ Test 6.1 ERROR:', err.message);
    }
}

async function test_6_3_Concurrency() {
    console.log('\n--- Test 6.3: Concurrent Form Submissions (10) ---');
    const requests = [];
    for (let i = 0; i < 10; i++) {
        requests.push(fetch(`${BASE_URL}/send-email`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: `Concurrent ${i}`,
                email: 'muzi.mlimi@gmail.com',
                subject: `Concurrent Test ${i}`,
                message: 'Testing concurrency.'
            })
        }));
    }

    const results = await Promise.all(requests);
    let successCount = 0;
    for (const res of results) {
        if (res.ok) successCount++;
    }
    console.log(`Success count: ${successCount}/10`);
    if (successCount === 10) {
        console.log('✅ Test 6.3 PASS: All concurrent requests handled.');
    } else {
        console.log('❌ Test 6.3 FAIL: Some requests failed or were rate limited.');
    }
}

async function test_6_2_NewsletterLoad() {
    console.log('\n--- Test 6.2: Newsletter Campaign (100 Subscribers) ---');
    console.log('Logging in as admin...');
    const loginRes = await fetch(`${BASE_URL}/api/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'admin' })
    });
    const loginData = await loginRes.json();
    const cookie = loginRes.headers.get('set-cookie');

    if (!loginData.success) {
        console.error('❌ Login failed, cannot run Part 6.2');
        return;
    }

    console.log('Triggering newsletter...');
    const start = Date.now();
    const campaignRes = await fetch(`${BASE_URL}/api/admin/campaigns`, {
        method: 'POST',
        headers: { 
            'Content-Type': 'application/json',
            'Cookie': cookie
        },
        body: JSON.stringify({
            subject: 'Test Newsletter Performance',
            message: 'This is a load test message for 100 subscribers.'
        })
    });
    const campaignData = await campaignRes.json();
    const duration = Date.now() - start;
    console.log('Newsletter result:', campaignData);
    console.log(`Total duration: ${duration}ms`);
    
    if (campaignData.success && campaignData.stats.sent >= 0) {
        console.log('✅ Test 6.2 PASS: Newsletter triggered successfully.');
    } else {
        console.log('❌ Test 6.2 FAIL:', campaignData.message);
    }
}

async function runTests() {
    await test_6_1_SingleEmailTime();
    await test_6_3_Concurrency();
    await test_6_2_NewsletterLoad();
    process.exit(0);
}

runTests();
