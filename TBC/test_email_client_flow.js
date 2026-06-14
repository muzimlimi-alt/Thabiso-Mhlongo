const puppeteer = require('puppeteer');

(async () => {
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: true,
            executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
        });
        const page = await browser.newPage();
        
        // Listen to console and error events
        page.on('console', msg => console.log('[BROWSER CONSOLE]', msg.type(), msg.text()));
        page.on('pageerror', err => console.error('[BROWSER PAGE ERROR]', err.stack || err.message));
        
        console.log("Navigating to admin portal...");
        await page.goto('http://localhost:3000/admin.html', { waitUntil: 'domcontentloaded' });
        
        console.log("Typing credentials...");
        await page.waitForSelector('#adminUsername', { visible: true });
        await page.type('#adminUsername', 'admin');
        await page.type('#adminPassword', 'password123');
        
        console.log("Clicking login...");
        await page.click('#loginBtn');
        
        console.log("Waiting for navigation/dashboard...");
        await page.waitForSelector('#dashboardSection', { timeout: 10000 });
        console.log("✓ Logged in and dashboard is visible!");
        
        console.log("Switching to Bookings tab...");
        await page.evaluate(() => {
            if (typeof switchTab === 'function') {
                switchTab('bookingsAdmin');
            } else {
                $('a[href="#bookingsAdmin"]').tab('show');
            }
        });
        
        console.log("Waiting for bookings list container...");
        await page.waitForSelector('#bookingsListContainer', { timeout: 5000 });
        
        // Wait for list to render
        await new Promise(r => setTimeout(r, 2000));
        
        console.log("Expanding details of first booking card...");
        await page.click('.atl-booking-card-header');
        await new Promise(r => setTimeout(r, 1000));
        
        // Click the "More" dropdown button
        console.log("Clicking the 'More' button to expand dropdown...");
        await page.evaluate(() => {
            const btn = document.querySelector('.bk-action-more');
            if (btn) btn.click();
        });
        await new Promise(r => setTimeout(r, 500));

        // Click the "Email Client" button
        console.log("Clicking the 'Email Client' button...");
        await page.evaluate(() => {
            const btn = document.querySelector('.bk-action-email');
            if (btn) btn.click();
        });
        
        // Wait for modal animation
        await new Promise(r => setTimeout(r, 2000));
        
        // Check HTML content of quill editor before template selection
        const infoBefore = await page.evaluate(() => {
            const container = document.getElementById('be-quill-container');
            const selectVal = document.getElementById('be-template').value;
            const bookingIdVal = document.getElementById('be-booking-id').value;
            return {
                containerExists: !!container,
                containerHtml: container ? container.innerHTML : '',
                selectValue: selectVal,
                bookingId: bookingIdVal,
                allBookingsCacheSize: typeof allBookingsCache !== 'undefined' ? allBookingsCache.length : 'undefined'
            };
        });
        console.log("State before template selection:", JSON.stringify(infoBefore, null, 2));

        // Select a template
        console.log("Selecting 'pricing' template in select dropdown...");
        await page.select('#be-template', 'pricing');
        await new Promise(r => setTimeout(r, 1000));
        
        // Check HTML content after template selection
        const infoAfter = await page.evaluate(() => {
            const container = document.getElementById('be-quill-container');
            const selectVal = document.getElementById('be-template').value;
            const editor = document.querySelector('#be-quill-container .ql-editor');
            return {
                containerHtml: container ? container.innerHTML : '',
                selectValue: selectVal,
                editorText: editor ? editor.innerText.trim() : 'no editor'
            };
        });
        console.log("State after template selection:", JSON.stringify(infoAfter, null, 2));
        
    } catch(e) {
        console.error("Test execution failed:", e);
    } finally {
        if (browser) await browser.close();
    }
})();
