const http = require('http');

const payload = {
    name: 'Duplicate Test Bot',
    email: 'muzi.mlimi@gmail.com',
    cell: '+27821234567',
    event_name: 'Duplicate Show Test',
    event_date: '2026-12-25',
    event_location: 'Barberton Hall',
    event_type: 'Comedy Club',
    message: 'This is a duplicate test booking request to verify P1 disallow gating.',
    popia_consent: true,
    policy_version: 'v2.2'
};

const reqData = JSON.stringify(payload);

const options = {
    hostname: 'localhost',
    port: 3000,
    path: '/api/public/bookings',
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(reqData)
    }
};

console.log("Checking duplicate same-day booking disallow gating (Fix 1 / P1)...");

const req = http.request(options, (res) => {
    let data = '';
    res.on('data', (chunk) => {
        data += chunk;
    });
    res.on('end', () => {
        console.log(`Status Code: ${res.statusCode}`);
        console.log('Response Body:', data);
        try {
            const parsed = JSON.parse(data);
            if (res.statusCode === 409 && parsed.existing_id === 21) {
                console.log("✅ verified: duplicate check correctly blocked the request with 409 and matched existing ID 21.");
            } else {
                console.error("❌ Failed: duplicate check did not block the request as expected.");
            }
        } catch(e) {
            console.error("❌ Failed to parse response JSON:", e.message);
        }
        
        // Next: check RBAC gate on POST /api/admin/transactions/manual
        checkRbacGate();
    });
});

req.on('error', (err) => {
    console.error("❌ Network error connecting to localhost:3000:", err.message);
});

req.write(reqData);
req.end();

function checkRbacGate() {
    console.log("\nChecking RBAC gate on POST /api/admin/transactions/manual (Fix 4 / P3)...");
    
    const txPayload = JSON.stringify({
        booking_id: 21,
        amount: '100.00',
        transaction_type: 'payment'
    });
    
    const txOptions = {
        hostname: 'localhost',
        port: 3000,
        path: '/api/admin/transactions/manual',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(txPayload)
        }
    };
    
    const txReq = http.request(txOptions, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
            console.log(`Status Code: ${res.statusCode}`);
            console.log('Response Body:', data);
            if (res.statusCode === 401 || res.statusCode === 403) {
                console.log("✅ verified: unauthenticated manual transaction attempt rejected with auth error.");
            } else {
                console.error("❌ Failed: unauthenticated manual transaction attempt was not rejected.");
            }
        });
    });
    
    txReq.on('error', (err) => {
        console.error("❌ Network error checking RBAC gate:", err.message);
    });
    
    txReq.write(txPayload);
    txReq.end();
}
