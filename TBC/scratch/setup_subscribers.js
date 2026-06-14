const db = require('../database');

async function setupSubscribers(count) {
    console.log(`Setting up ${count} test subscribers...`);
    const stmt = db.prepare("INSERT INTO newsletter_subscribers (email, status, active, unsubscribe_token) VALUES (?, 'active', 1, ?)");
    
    for (let i = 1; i <= count; i++) {
        const email = `testuser${i}@example.com`;
        const token = `token${i}`;
        await new Promise((resolve, reject) => {
            stmt.run([email, token], (err) => {
                if (err && !err.message.includes('UNIQUE')) reject(err);
                else resolve();
            });
        });
    }
    stmt.finalize();
    console.log('✅ Subscribers setup complete.');
}

async function main() {
    try {
        await setupSubscribers(100);
    } catch (err) {
        console.error(err);
    }
    process.exit(0);
}

main();
