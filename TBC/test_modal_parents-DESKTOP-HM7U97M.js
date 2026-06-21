const puppeteer = require('puppeteer');

(async () => {
    try {
        console.log("Starting diagnostic for parent displays...");
        const possiblePaths = [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
            'C:\\Users\\muzim\\.cache\\puppeteer\\chrome\\win64-147.0.7727.57\\chrome-win64\\chrome.exe'
        ];

        let browser;
        for (const p of possiblePaths) {
            try {
                browser = await puppeteer.launch({ executablePath: p, headless: true });
                break;
            } catch (err) {}
        }

        if (!browser) {
            browser = await puppeteer.launch({ headless: true });
        }
        const page = await browser.newPage();
        await page.goto('http://localhost:3000/admin.html', { waitUntil: 'networkidle2' });
        
        // Login
        await page.waitForSelector('#adminUsername');
        await page.type('#adminUsername', 'admin');
        await page.type('#adminPassword', 'password123');
        await page.click('#loginBtn');
        await page.waitForSelector('#dashboardSection');
        
        // Go to Calendar
        await page.click('a[href="#calendarAdmin"]');
        await new Promise(r => setTimeout(r, 1000));
        
        // Click day on mini calendar to show blockOutModal
        await page.evaluate(() => {
            const cells = Array.from(document.querySelectorAll('#miniCalendarBody td')).filter(c => c.textContent.trim() !== '');
            if (cells.length) cells[0].click();
        });
        await new Promise(r => setTimeout(r, 1000));
        
        // Trace parents
        const parentsInfo = await page.evaluate(() => {
            const modal = document.getElementById('blockOutModal');
            if (!modal) return { error: 'Modal not found' };
            
            const info = [];
            let current = modal;
            while (current) {
                const style = window.getComputedStyle(current);
                info.push({
                    tagName: current.tagName,
                    id: current.id,
                    className: current.className,
                    display: style.display
                });
                current = current.parentElement;
            }
            return { error: null, chain: info };
        });
        
        console.log("Parent Chain display styles:", JSON.stringify(parentsInfo, null, 2));
        
        await browser.close();
    } catch (e) {
        console.error(e);
    }
})();
