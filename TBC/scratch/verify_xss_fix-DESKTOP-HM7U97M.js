const http = require('http');

async function testXSS() {
    const payload = JSON.stringify({
        name: 'XSS Final Fix Test',
        email: 'xss@test.com',
        cell: '0123456789',
        category: 'General',
        subject: 'XSS Test',
        message: '<script>alert("XSS")</script>',
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

testXSS();
