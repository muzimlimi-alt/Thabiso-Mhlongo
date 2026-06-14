const path = require('path');
const http = require('http');
const assert = require('assert');

const projectDir = path.join(__dirname, '..');
const db = require(path.join(projectDir, 'database'));

function makePostRequest(url, payload) {
    return new Promise((resolve, reject) => {
        const bodyStr = JSON.stringify(payload);
        const req = http.request(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(bodyStr)
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, body: JSON.parse(data) });
                } catch(e) {
                    resolve({ status: res.statusCode, body: data });
                }
            });
        });
        req.on('error', reject);
        req.write(bodyStr);
        req.end();
    });
}

async function runTest() {
    console.log("Starting live API integration test...");

    const bookingId = 68; // Valid QUOTED booking in DB
    const email = "mliminho@yahoo.com";
    const testMessage = "I would like to request a revision for the performance length.";

    // 1. Check notes count before
    const notesBefore = await new Promise((resolve) => {
        db.all("SELECT id FROM booking_notes WHERE booking_id = ?", [bookingId], (err, rows) => {
            resolve(rows || []);
        });
    });
    console.log(`✓ Notes count before API call: ${notesBefore.length}`);

    // 2. Make live API request to server on port 3000
    console.log("Sending POST request to live server...");
    const url = `http://localhost:3000/api/public/bookings/${bookingId}/quote-revision-request`;
    const response = await makePostRequest(url, {
        email: email,
        request_type: 'revision',
        message: testMessage
    });

    console.log("Server responded with:", JSON.stringify(response, null, 2));

    // Assert successful response
    assert.strictEqual(response.status, 200, "Server should respond with status 200");
    assert.strictEqual(response.body.success, true, "Response payload should indicate success");

    // 3. Verify note is in database
    const notesAfter = await new Promise((resolve) => {
        db.all("SELECT * FROM booking_notes WHERE booking_id = ? ORDER BY id DESC", [bookingId], (err, rows) => {
            resolve(rows || []);
        });
    });
    
    console.log(`✓ Notes count after API call: ${notesAfter.length}`);
    assert.strictEqual(notesAfter.length, notesBefore.length + 1, "A new note should have been added");
    
    const latestNote = notesAfter[0];
    console.log("✓ Retrieved logged client note:", JSON.stringify(latestNote, null, 2));
    assert.strictEqual(latestNote.author, "Client");
    assert(latestNote.note.includes(testMessage), "Note text should contain the client's message");

    // 4. Clean up the inserted note
    await new Promise((resolve) => {
        db.run("DELETE FROM booking_notes WHERE id = ?", [latestNote.id], () => resolve());
    });
    console.log("✓ Cleaned up test note. Test PASSED!");
    process.exit(0);
}

runTest().catch(err => {
    console.error("Test FAILED:", err);
    process.exit(1);
});
