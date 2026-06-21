const puppeteer = require('puppeteer');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const path = require('path');

const dbPath = path.join(__dirname, '..', 'database.sqlite');

async function setupTestUser() {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbPath);
        bcrypt.hash('admin123', 10, (err, hash) => {
            if (err) return reject(err);
            db.run(
                "UPDATE admins SET password_hash = ? WHERE username = 'tempadmin'",
                [hash],
                function(err2) {
                    db.close();
                    if (err2) return reject(err2);
                    console.log('Successfully updated tempadmin password to admin123');
                    resolve();
                }
            );
        });
    });
}

async function run() {
    await setupTestUser();

    console.log('Launching browser...');
    let executablePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    if (!require('fs').existsSync(executablePath)) {
        executablePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
    }
    if (!require('fs').existsSync(executablePath)) {
        executablePath = 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
    }

    const browser = await puppeteer.launch({
        headless: true,
        executablePath,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();

    const consoleLogs = [];
    const failedRequests = [];

    // Capture console messages
    page.on('console', msg => {
        const text = msg.text();
        consoleLogs.push(`[CONSOLE ${msg.type().toUpperCase()}] ${text}`);
    });

    // Capture network requests
    page.on('response', response => {
        const status = response.status();
        const url = response.url();
        if (status >= 400) {
            failedRequests.push(`[HTTP ${status}] ${url}`);
        }
    });

    console.log('Navigating to login page...');
    await page.goto('http://localhost:3000/admin.html', { waitUntil: 'networkidle2' });

    console.log('Logging in...');
    await page.type('#adminUsername', 'tempadmin');
    await page.type('#adminPassword', 'admin123');
    await page.click('#loginBtn');

    console.log('Waiting for dashboard load...');
    await new Promise(resolve => setTimeout(resolve, 5000));

    console.log('\n--- FAILED REQUESTS ---');
    if (failedRequests.length === 0) {
        console.log('No failed requests detected.');
    } else {
        failedRequests.forEach(req => console.log(req));
    }

    console.log('\n--- CONSOLE LOGS ---');
    consoleLogs.forEach(log => console.log(log));

    await browser.close();
}

run().catch(console.error);
