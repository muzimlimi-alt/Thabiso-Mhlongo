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
        
        // Wait a bit for list to render
        await new Promise(r => setTimeout(r, 2000));
        
        // Let's check if there are any booking cards
        const cardCount = await page.$$eval('.atl-booking-card', el => el.length);
        console.log(`Found ${cardCount} bookings.`);
        
        if (cardCount === 0) {
            console.log("No bookings found. Cannot test.");
            await browser.close();
            return;
        }
        
        // Find the first booking and expand it
        console.log("Expanding details of first booking card...");
        await page.click('.atl-booking-card-header');
        await new Promise(r => setTimeout(r, 1000));
        
        // Let's look for any button inside the card with text "Payment" or "Record Payment"
        const buttons = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('.bk-action-record-payment')).map(b => ({
                text: b.innerText.trim(),
                visible: b.offsetWidth > 0 && b.offsetHeight > 0,
                id: b.getAttribute('data-id')
            }));
        });
        console.log("Available Payment buttons in DOM:", buttons);
        
        const activeBtnIndex = buttons.findIndex(b => b.visible);
        if (activeBtnIndex === -1) {
            console.log("No visible Payment button found. We might need to click on some status first or mock it.");
            // Let's manually trigger click on first button even if it's hidden, or trigger it via eval
            console.log("Forcing click via page.evaluate on the first payment button...");
            await page.evaluate(() => {
                const btn = document.querySelector('.bk-action-record-payment');
                if (btn) btn.click();
            });
        } else {
            console.log(`Clicking the visible payment button at index ${activeBtnIndex}...`);
            const paymentBtns = await page.$$('.bk-action-record-payment');
            await paymentBtns[activeBtnIndex].click();
        }
        
        // Wait for modal to render
        await new Promise(r => setTimeout(r, 1000));
        
        // Check if modal or overlay exists
        const modalInfo = await page.evaluate(() => {
            const overlay = document.querySelector('.atl-modal-overlay');
            const modal = document.querySelector('#recordPaymentModal');
            return {
                overlayExists: !!overlay,
                overlayVisible: overlay ? (overlay.offsetWidth > 0 && overlay.offsetHeight > 0) : false,
                modalExists: !!modal,
                modalVisible: modal ? (modal.offsetWidth > 0 && modal.offsetHeight > 0) : false,
                modalParent: modal ? modal.parentElement.tagName + ' (class: ' + modal.parentElement.className + ')' : 'none'
            };
        });
        console.log("Modal state in browser:", modalInfo);
        
    } catch(e) {
        console.error("Test execution failed:", e);
    } finally {
        if (browser) await browser.close();
    }
})();
