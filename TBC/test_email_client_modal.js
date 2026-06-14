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
        await page.goto('http://localhost:3000/admin.html', { waitUntil: 'networkidle2' });
        
        console.log("Typing credentials...");
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
        
        const cardCount = await page.$$eval('.atl-booking-card', el => el.length);
        console.log(`Found ${cardCount} bookings.`);
        
        console.log("Expanding details of first booking card...");
        await page.click('.atl-booking-card-header');
        await new Promise(r => setTimeout(r, 1000));
        
        // Click the "More" dropdown button
        console.log("Clicking the 'More' button to expand dropdown...");
        await page.evaluate(() => {
            const btn = document.querySelector('.bk-action-more');
            if (btn) {
                btn.click();
                console.log("Clicked bk-action-more button");
            } else {
                console.log("bk-action-more button not found!");
            }
        });
        await new Promise(r => setTimeout(r, 500));

        // Click the "Email Client" button
        console.log("Clicking the 'Email Client' button...");
        await page.evaluate(() => {
            const btn = document.querySelector('.bk-action-email');
            if (btn) {
                btn.click();
                console.log("Clicked bk-action-email button");
            } else {
                console.log("bk-action-email button not found!");
            }
        });
        
        // Wait for modal animation
        await new Promise(r => setTimeout(r, 2000));
        
        // Check if modal exists and is visible
        const modalInfo = await page.evaluate(() => {
            const modal = document.querySelector('#bookingEmailModal');
            if (!modal) return { exists: false };
            const style = window.getComputedStyle(modal);
            const bodyStyle = window.getComputedStyle(document.body);
            return {
                exists: true,
                className: modal.className,
                display: style.display,
                visibility: style.visibility,
                opacity: style.opacity,
                bodyHasClassModalOpen: document.body.classList.contains('modal-open'),
                bodyZIndex: bodyStyle.zIndex,
                modalZIndex: style.zIndex,
                parentTag: modal.parentElement ? modal.parentElement.tagName : 'none',
                parentClass: modal.parentElement ? modal.parentElement.className : '',
                parentId: modal.parentElement ? modal.parentElement.id : ''
            };
        });
        console.log("Modal state in browser:", JSON.stringify(modalInfo, null, 2));
        
    } catch(e) {
        console.error("Test execution failed:", e);
    } finally {
        if (browser) await browser.close();
    }
})();
