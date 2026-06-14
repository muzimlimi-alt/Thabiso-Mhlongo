const db = require('../database');

function clearLogs() {
    return new Promise((resolve, reject) => {
        db.run('DELETE FROM email_logs', (err) => {
            if (err) reject(err);
            else resolve();
        });
    });
}

async function main() {
    console.log('--- Email Overhaul Test Prep ---');
    try {
        await clearLogs();
        console.log('✅ email_logs table cleared.');
    } catch (err) {
        console.error('❌ Error clearing logs:', err);
    }
    process.exit(0);
}

main();
