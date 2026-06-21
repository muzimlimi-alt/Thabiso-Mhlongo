const db = require('../database');

function checkUsage(serviceId, expectedCount) {
    return new Promise((resolve, reject) => {
        const sql = `
            SELECT COUNT(DISTINCT q.id) AS draft_count 
            FROM quotations q
            JOIN quote_line_items qli ON q.id = qli.quotation_id
            WHERE qli.service_id = ? AND q.status = 'draft' AND COALESCE(q.archived, 0) = 0
        `;
        db.get(sql, [serviceId], (err, row) => {
            if (err) return reject(err);
            const count = row ? row.draft_count : 0;
            console.log(`Service ID ${serviceId}: draft_count = ${count} (Expected: ${expectedCount})`);
            if (count === expectedCount) {
                console.log(`✅ Verification passed for Service ID ${serviceId}`);
                resolve();
            } else {
                console.error(`❌ Verification failed for Service ID ${serviceId}. Got ${count}, expected ${expectedCount}`);
                reject(new Error("Mismatch"));
            }
        });
    });
}

async function run() {
    try {
        console.log("Starting service usage query verification...");
        await checkUsage(1, 1);
        await checkUsage(2, 0);
        console.log("All queries executed and verified successfully.");
    } catch (e) {
        console.error("Verification error:", e);
    } finally {
        db.close();
    }
}

run();
