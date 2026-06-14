const http = require('http');
const assert = require('assert');

function testValidation() {
    console.log("=== STARTING BACKEND VALIDATION RESPONSE TESTS ===");

    const testPayload = JSON.stringify({
        // missing name, email, etc.
        company: "Test Corp",
        message: "Hello"
    });

    const options = {
        hostname: 'localhost',
        port: 3000,
        path: '/api/public/bookings',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(testPayload)
        }
    };

    const req = http.request(options, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => {
            console.log(`Response Status Code: ${res.statusCode}`);
            assert.strictEqual(res.statusCode, 400, "Validation failure should return HTTP status 400");
            
            try {
                const data = JSON.parse(body);
                console.log("Response Body:", data);
                assert.strictEqual(data.success, false, "Response success should be false");
                assert(data.message.includes("Missing required booking fields.") || data.message.includes("Name must be") || data.message.includes("Invalid"), "Error message should explain the validation failure");
                console.log("✓ Test Case 1 Passed: Validation correctly rejected by server.");
                process.exit(0);
            } catch(e) {
                console.error("Failed to parse JSON response:", e);
                process.exit(1);
            }
        });
    });

    req.on('error', (err) => {
        console.error("Request failed:", err);
        process.exit(1);
    });

    req.write(testPayload);
    req.end();
}

testValidation();
