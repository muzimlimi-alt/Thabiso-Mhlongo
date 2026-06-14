const http = require('http');

function makeRequest(method, urlPath, payload = null, cookie = null) {
    return new Promise((resolve, reject) => {
        const bodyStr = payload ? JSON.stringify(payload) : '';
        const headers = { 'Content-Type': 'application/json' };
        if (cookie) headers['Cookie'] = cookie;
        if (payload) headers['Content-Length'] = Buffer.byteLength(bodyStr);

        const req = http.request({
            hostname: 'localhost',
            port: 3000,
            path: urlPath,
            method: method,
            headers: headers
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                resolve({ status: res.statusCode, body: data, headers: res.headers });
            });
        });
        req.on('error', reject);
        if (payload) req.write(bodyStr);
        req.end();
    });
}

async function run() {
    console.log("Logging in...");
    const loginRes = await makeRequest('POST', '/api/admin/login', { username: 'admin', password: 'password123' });
    const cookie = loginRes.headers['set-cookie'][0].split(';')[0];

    console.log("Requesting raw details for booking 9999...");
    const detailsRes = await makeRequest('GET', '/api/admin/bookings/9999/details', null, cookie);
    console.log("Status:", detailsRes.status);
    console.log("Raw Response Body:", detailsRes.body);
    process.exit(0);
}

run().catch(console.error);
