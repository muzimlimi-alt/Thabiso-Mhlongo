const http = require('http');

function sendRequest(i) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify({
            name: 'Rate Limit Test',
            email: 'test@example.com',
            cell: '0123456789',
            category: 'General',
            subject: 'Test',
            message: 'Test message',
            popia_consent: true
        });

        const options = {
            hostname: 'localhost',
            port: 3000,
            path: '/send-email',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': data.length
            }
        };

        const req = http.request(options, (res) => {
            if (res.statusCode === 429) {
                console.log(`Request ${i}: FAILED - Status: 429 (Rate Limited)`);
                resolve('limited');
            } else if (res.statusCode === 200) {
                if (i % 10 === 0) console.log(`Request ${i}: Success`);
                resolve('success');
            } else {
                console.log(`Request ${i}: FAILED - Status: ${res.statusCode}`);
                resolve('other');
            }
        });

        req.on('error', (e) => {
            console.error(`Request ${i}: Problem with request: ${e.message}`);
            reject(e);
        });

        req.write(data);
        req.end();
    });
}

async function runTest() {
    console.log('Sending 110 requests to test IP rate limiter (limit is 100 per hour)...');
    for (let i = 1; i <= 110; i++) {
        const result = await sendRequest(i);
        if (result === 'limited') {
            console.log('✅ Rate limiter caught the requests!');
            process.exit(0);
        }
    }
    console.log('❌ Rate limiter did NOT catch the requests after 110 attempts.');
    process.exit(1);
}

runTest();
