const puppeteer = require('puppeteer');
const path = require('path');

(async () => {
    try {
        console.log("Starting mini-calendar modal test...");
        const possiblePaths = [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
            'C:\\Users\\muzim\\.cache\\puppeteer\\chrome\\win64-147.0.7727.57\\chrome-win64\\chrome.exe'
        ];

        let browser;
        for (const p of possiblePaths) {
            try {
                browser = await puppeteer.launch({
                    executablePath: p,
                    headless: true,
                    args: ['--no-sandbox', '--disable-setuid-sandbox']
                });
                break;
            } catch (err) {}
        }

        if (!browser) {
            browser = await puppeteer.launch({
                headless: true,
                args: ['--no-sandbox', '--disable-setuid-sandbox']
            });
        }
        const page = await browser.newPage();
        await page.setViewport({ width: 1400, height: 900 });
        
        page.on('console', msg => console.log('[BROWSER CONSOLE]', msg.text()));
        page.on('pageerror', err => console.log('[BROWSER ERROR]', err.toString()));

        console.log("Navigating to admin.html...");
        await page.goto('http://localhost:3000/admin.html', { waitUntil: 'networkidle2' });
        
        console.log("Logging in...");
        await page.waitForSelector('#adminUsername', { visible: true });
        await page.type('#adminUsername', 'admin');
        await page.type('#adminPassword', 'password123');
        await page.click('#loginBtn');
        
        console.log("Waiting for dashboard...");
        await page.waitForSelector('#dashboardSection', { visible: true });
        
        console.log("Navigating to Calendar tab...");
        await page.click('a[href="#calendarAdmin"]');
        await new Promise(r => setTimeout(r, 1000));
        
        console.log("Clicking on the first day cell in the mini-calendar...");
        const clickStatus = await page.evaluate(() => {
            const body = document.getElementById('miniCalendarBody');
            if (!body) return { success: false, message: 'miniCalendarBody not found' };
            const cells = Array.from(body.querySelectorAll('td')).filter(c => c.textContent.trim() !== '');
            if (cells.length === 0) return { success: false, message: 'no day cells found' };
            
            console.log(`Found ${cells.length} cells. Clicking the first one: Day ${cells[0].textContent}`);
            cells[0].click();
            return { success: true };
        });
        
        console.log("Click Status:", JSON.stringify(clickStatus));
        await new Promise(r => setTimeout(r, 1500)); // wait for modal animation
        
        console.log("Checking if blockOutModal is visible...");
        const modalCheck = await page.evaluate(() => {
            const modal = document.getElementById('blockOutModal');
            if (!modal) return { exists: false };
            const style = window.getComputedStyle(modal);
            return {
                exists: true,
                className: modal.className,
                display: style.display,
                visibility: style.visibility,
                opacity: style.opacity
            };
        });
        console.log("Modal state:", JSON.stringify(modalCheck, null, 2));

        await browser.close();
        console.log("Done!");
    } catch (e) {
        console.error("Test failed:", e);
    }
})();
