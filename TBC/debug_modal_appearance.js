const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

(async () => {
    try {
        console.log("Starting visual debug for modal...");
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
        await page.setViewport({ width: 1920, height: 911 });

        console.log("Navigating to admin.html...");
        await page.goto('http://localhost:3000/admin.html', { waitUntil: 'domcontentloaded' });
        
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
        
        console.log("Opening Block Out modal...");
        await page.evaluate(() => {
            const body = document.getElementById('miniCalendarBody');
            const cells = Array.from(body.querySelectorAll('td')).filter(c => c.textContent.trim() !== '');
            if (cells.length) cells[0].click();
        });
        await new Promise(r => setTimeout(r, 1500)); // wait for modal transition

        console.log("Querying element styles...");
        const elementStyles = await page.evaluate(() => {
            function getStyles(el) {
                if (!el) return null;
                const style = window.getComputedStyle(el);
                return {
                    tagName: el.tagName,
                    id: el.id,
                    className: el.className,
                    display: style.display,
                    visibility: style.visibility,
                    opacity: style.opacity,
                    filter: style.filter,
                    backdropFilter: style.backdropFilter || style.webkitBackdropFilter,
                    zIndex: style.zIndex,
                    position: style.position,
                    backgroundColor: style.backgroundColor,
                    color: style.color
                };
            }

            const body = document.body;
            const modal = document.getElementById('blockOutModal');
            const dialog = modal ? modal.querySelector('.modal-dialog') : null;
            const content = modal ? modal.querySelector('.modal-content') : null;
            const backdrop = document.querySelector('.modal-backdrop');

            // Find any elements on the page with filter or backdrop-filter active
            const filteredElements = [];
            document.querySelectorAll('*').forEach(el => {
                const s = window.getComputedStyle(el);
                const hasFilter = s.filter && s.filter !== 'none';
                const hasBackdropFilter = (s.backdropFilter && s.backdropFilter !== 'none') || (s.webkitBackdropFilter && s.webkitBackdropFilter !== 'none');
                if (hasFilter || hasBackdropFilter) {
                    filteredElements.push({
                        tagName: el.tagName,
                        id: el.id,
                        className: el.className,
                        filter: s.filter,
                        backdropFilter: s.backdropFilter || s.webkitBackdropFilter
                    });
                }
            });

            return {
                body: getStyles(body),
                modal: getStyles(modal),
                dialog: getStyles(dialog),
                content: getStyles(content),
                backdrop: getStyles(backdrop),
                filteredElements: filteredElements
            };
        });

        console.log("Element Styles:\n", JSON.stringify(elementStyles, null, 2));

        // Save a screenshot to the scratch folder
        const scratchDir = path.join(__dirname, '..', 'scratch');
        if (!fs.existsSync(scratchDir)) {
            fs.mkdirSync(scratchDir);
        }
        const screenshotPath = path.join(scratchDir, 'modal_visual_debug.png');
        await page.screenshot({ path: screenshotPath });
        console.log(`Screenshot saved to ${screenshotPath}`);

        await browser.close();
    } catch (e) {
        console.error("Debug script failed:", e);
    }
})();
