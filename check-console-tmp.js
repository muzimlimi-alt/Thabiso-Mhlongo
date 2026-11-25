const puppeteer = require('puppeteer');

(async () => {
    const browser = await puppeteer.launch({
        executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        args: ['--no-sandbox', '--disable-setuid-sandbox', `--user-data-dir=C:\\Users\\muzim\\AppData\\Local\\Temp\\puppeteer-check-${Date.now()}`],
        headless: 'new'
    });
    const page = await browser.newPage();

    const errors = [];
    const warnings = [];
    page.on('console', msg => {
        if (msg.type() === 'error') errors.push('CONSOLE ERROR: ' + msg.text());
        if (msg.type() === 'warning') warnings.push('CONSOLE WARN: ' + msg.text());
    });
    page.on('pageerror', err => errors.push('PAGE ERROR: ' + err.message));

    console.log('Navigating to admin.html...');
    await page.goto('http://localhost:3000/admin.html', { waitUntil: 'networkidle2', timeout: 20000 });

    // Wait a bit for any boot-time errors
    await new Promise(r => setTimeout(r, 4000));

    console.log('--- Console errors after 4s (unauthenticated) ---');
    errors.forEach(e => console.log(e));
    if (errors.length === 0) console.log('No errors captured');

    await browser.close();
    process.exit(0);
})().catch(err => { console.error('Script error:', err.message); process.exit(1); });
