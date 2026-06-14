const puppeteer = require('puppeteer');
const path = require('path');

(async () => {
    try {
        console.log("Starting calendar verification...");
        const possiblePaths = [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
            'C:\\Users\\muzim\\.cache\\puppeteer\\chrome\\win64-147.0.7727.57\\chrome-win64\\chrome.exe'
        ];

        let browser;
        for (const p of possiblePaths) {
            try {
                console.log(`Trying Chrome at path: ${p}`);
                browser = await puppeteer.launch({
                    executablePath: p,
                    headless: true,
                    args: ['--no-sandbox', '--disable-setuid-sandbox']
                });
                console.log(`Successfully launched browser using path: ${p}`);
                break;
            } catch (err) {
                console.log(`Failed to launch browser using path: ${p}`);
            }
        }

        if (!browser) {
            console.log("Attempting default launch...");
            browser = await puppeteer.launch({
                headless: true,
                args: ['--no-sandbox', '--disable-setuid-sandbox']
            });
        }
        const page = await browser.newPage();
        await page.setViewport({ width: 1400, height: 900 });
        
        page.on('console', msg => console.log('[BROWSER CONSOLE]', msg.text()));

        console.log("Navigating to admin.html...");
        await page.goto('http://localhost:3000/admin.html', { waitUntil: 'networkidle2' });
        
        console.log("Logging in...");
        await page.waitForSelector('#adminUsername', { visible: true });
        await page.evaluate(() => {
            document.getElementById('adminUsername').value = '';
            document.getElementById('adminPassword').value = '';
        });
        await page.type('#adminUsername', 'admin');
        await page.type('#adminPassword', 'password123');
        
        const typedVals = await page.evaluate(() => {
            return {
                u: document.getElementById('adminUsername').value,
                p: document.getElementById('adminPassword').value
            };
        });
        console.log("Typed values before click:", JSON.stringify(typedVals));
        
        await page.click('#loginBtn');
        
        console.log("Waiting for dashboard to load...");
        await page.waitForSelector('#dashboardSection', { visible: true });
        
        console.log("Navigating to Calendar tab...");
        // Click on the calendar link in the sidebar
        await page.click('a[href="#calendarAdmin"]');
        await new Promise(r => setTimeout(r, 1000)); // Wait for tab switch animation
        console.log("Waiting for schedule list to finish loading...");
        await page.waitForFunction(() => {
            const el = document.getElementById('upcomingScheduleList');
            return el && !el.innerText.includes('Loading upcoming events...');
        }, { timeout: 10000 });

        console.log("Inspecting Copy Feed URL button...");
        const btnStyles = await page.evaluate(() => {
            const btn = document.getElementById('btnCopyIcsFeed');
            if (!btn) return 'Button not found';
            const style = window.getComputedStyle(btn);
            return {
                text: btn.innerText.trim(),
                backgroundColor: style.backgroundColor,
                color: style.color,
                borderColor: style.borderColor,
                borderRadius: style.borderRadius
            };
        });
        console.log("Button Styles:", JSON.stringify(btnStyles, null, 2));

        console.log("Inspecting Upcoming Events list...");
        const events = await page.evaluate(() => {
            const list = document.getElementById('upcomingScheduleList');
            if (!list) return [];
            return Array.from(list.querySelectorAll('.schedule-item')).map(item => {
                const title = item.querySelector('.schedule-item-title')?.innerText || '';
                const time = item.querySelector('.schedule-item-time')?.innerText || '';
                const meta = item.querySelector('.schedule-item-meta')?.innerText || '';
                return { title, time, meta };
            });
        });
        console.log("Upcoming Events found:", JSON.stringify(events, null, 2));

        console.log("Testing click redirection on Booking Event in sidebar...");
        const clickResult = await page.evaluate(() => {
            const list = document.getElementById('upcomingScheduleList');
            if (!list) return { success: false, message: 'list not found' };
            const clickableItem = list.querySelector('.schedule-item.clickable');
            if (!clickableItem) return { success: false, message: 'no clickable booking item found' };
            
            const onclickText = clickableItem.getAttribute('onclick');
            const dbIdMatch = onclickText.match(/bookingDetail-(\d+)/);
            if (!dbIdMatch) return { success: false, message: 'failed to match dbId in onclick' };
            const dbId = dbIdMatch[1];
            
            clickableItem.click();
            return { success: true, dbId };
        });

        if (clickResult.success) {
            console.log(`Successfully clicked booking item with dbId: ${clickResult.dbId}`);
            await new Promise(r => setTimeout(r, 1500)); // Wait for transitions and scrolling
            
            const bookingsCheck = await page.evaluate((dbId) => {
                const bookingsSection = document.getElementById('bookingsAdmin');
                const isSectionVisible = window.getComputedStyle(bookingsSection).display !== 'none';
                
                const detailCard = document.getElementById(`bookingDetail-${dbId}`);
                const isCardExpanded = detailCard ? (detailCard.classList.contains('show') || detailCard.classList.contains('in')) : false;
                
                return { isSectionVisible, isCardExpanded };
            }, clickResult.dbId);
            
            console.log("Bookings Redirection Check:", JSON.stringify(bookingsCheck));
        } else {
            console.log("Click test skipped/failed:", clickResult.message);
        }

        // Take a screenshot of the calendar panel (now booking detail view if clicked)
        const screenshotPath = path.resolve('C:\\Users\\muzim\\.gemini\\antigravity-ide\\brain\\68492eac-bd8e-4668-a9f3-87abe070fe95\\calendar_verification.png');
        console.log(`Saving screenshot to ${screenshotPath}...`);
        await page.screenshot({ path: screenshotPath });

        await browser.close();
        console.log("Verification finished successfully!");
    } catch(e) {
        console.error("Verification failed:", e);
        process.exit(1);
    }
})();
