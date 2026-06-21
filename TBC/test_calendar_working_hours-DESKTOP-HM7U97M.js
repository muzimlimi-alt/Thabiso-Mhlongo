const puppeteer = require('puppeteer');

(async () => {
    console.log("Starting Calendar Working Hours Programmatic Verification...");
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        const page = await browser.newPage();
        
        page.on('console', msg => {
            const txt = msg.text();
            if (!txt.includes('DOMTokenList')) {
                console.log('[BROWSER]', txt);
            }
        });

        // 1. Go to admin portal
        console.log("Navigating to http://localhost:3000/admin.html...");
        await page.goto('http://localhost:3000/admin.html', { waitUntil: 'networkidle2' });

        // 2. Log in
        console.log("Typing login credentials...");
        await page.type('#adminUsername', 'admin');
        await page.type('#adminPassword', 'password123');
        await page.click('#loginBtn');

        // Wait for login to complete and dashboard to show
        console.log("Waiting for dashboard section...");
        await page.waitForSelector('#dashboardSection', { timeout: 10000 });
        console.log("✓ Login successful, dashboard loaded.");

        // 3. Switch to calendar section (which triggers initAdminCalendar)
        console.log("Switching to Calendar section...");
        await page.evaluate(() => {
            // Simulate clicking the Calendar link in sidebar
            const calLink = document.querySelector('a[href="#calendarAdmin"]');
            if (calLink) {
                calLink.click();
            } else {
                console.error("Could not find calendar link!");
            }
        });

        // Wait for #calendar to render
        await page.waitForSelector('#calendar', { timeout: 10000 });
        console.log("✓ Calendar container found.");

        // Wait 3 seconds for loadWorkingHours to execute and populate calendar options
        console.log("Waiting for working hours to be loaded and applied...");
        await new Promise(resolve => setTimeout(resolve, 3000));

        // 4. Retrieve businessHours from the calendar object
        const calendarOptions = await page.evaluate(() => {
            if (typeof adminCalendar !== 'undefined' && adminCalendar) {
                return {
                    businessHours: adminCalendar.getOption('businessHours'),
                    initialView: adminCalendar.getOption('initialView')
                };
            }
            return null;
        });

        console.log("Calendar Options returned:", JSON.stringify(calendarOptions, null, 2));

        if (!calendarOptions) {
            throw new Error("adminCalendar object is not defined on the window!");
        }

        const bh = calendarOptions.businessHours;
        if (!bh || !Array.isArray(bh) || bh.length === 0) {
            throw new Error("businessHours option is empty or not configured!");
        }

        console.log("✓ Success: calendar.businessHours is successfully populated with:", JSON.stringify(bh));
        console.log("✓ Verification test passed successfully!");
        
        await browser.close();
        process.exit(0);
    } catch(e) {
        console.error("❌ Test failed:", e.message);
        if (browser) await browser.close();
        process.exit(1);
    }
})();
