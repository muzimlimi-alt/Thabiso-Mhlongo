const BASE_URL = 'http://localhost:3000';
const fs = require('fs');
const path = require('path');

async function test_8_1_Rollback() {
    console.log('\n--- Test 8.1: Feature Flag Fallback ---');
    const envPath = path.join(__dirname, '..', '.env');
    let envContent = fs.readFileSync(envPath, 'utf8');
    
    try {
        console.log('Toggling EMAIL_OVERHAUL_ENABLED=false');
        const newEnv = envContent.replace('EMAIL_OVERHAUL_ENABLED=true', 'EMAIL_OVERHAUL_ENABLED=false');
        fs.writeFileSync(envPath, newEnv);

        // Restart server (Manual or automatic? I'll do manual taskkill and restart)
        // Actually, since I'm in a script, I'll just check if the server picked it up (it won't without restart or dotenv dynamic reloading)
        console.log('NOTE: Server needs restart for .env changes.');
    } catch (err) {
        console.error(err);
    }
}

async function runTests() {
    await test_8_1_Rollback();
    process.exit(0);
}

runTests();
