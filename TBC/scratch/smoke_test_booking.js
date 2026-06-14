const http = require('http');

async function testBooking() {
    const payload = JSON.stringify({
        name: 'Smoke Test User',
        email: 'smoke@test.com',
        cell: '0123456789',
        category: 'Private Booking',
        subject: 'Performance Request',
        message: 'Looking for a show.',
        popia_consent: true
    });

    const options = {
        hostname: 'localhost',
        port: 3000,
        path: '/send-email',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': payload.length
        }
    };

    const req = http.request(options, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => console.log('Response:', body));
    });

    req.on('error', (e) => console.error(e));
    req.write(payload);
    req.end();
}

testBooking();
