const puppeteer = require('puppeteer');

(async () => {
    try {
        const browser = await puppeteer.launch();
        const page = await browser.newPage();
        
        page.on('console', msg => console.log('[BROWSER CONSOLE]', msg.type(), msg.text()));
        
        page.on('requestfailed', request => {
            const errInfo = request.failure() ? request.failure().errorText : 'No error text';
            console.log(`[REQUEST FAILED] ${request.url()} - ${errInfo}`);
        });

        page.on('response', response => {
            if (!response.ok()) {
                console.log(`[RESPONSE KO] ${response.url()} status ${response.status()}`);
            }
        });

        await page.goto('http://localhost:3000/admin.html');
        
        console.log("Typing credentials...");
        await page.type('#adminUsername', 'admin');
        await page.type('#adminPassword', 'admin');
        
        console.log("Clicking login...");
        await page.click('#loginBtn');
        
        // Wait for page reload or network idle
        await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 5000 }).catch(e => console.log("No navigation or timed out."));

        // Let's scrape the #loginError text
        const errorText = await page.$eval('#loginError', el => el.innerText).catch(() => '');
        console.log("Error Div Text:", errorText);

        const isDashboardVisible = await page.$eval('#dashboardSection', el => window.getComputedStyle(el).display !== 'none').catch(() => false);
        console.log("Is dashboard visible?", isDashboardVisible);

        const cookies = await page.cookies();
        console.log("Cookies available to page:", cookies);

        await browser.close();
    } catch(e) {
        console.error("Puppeteer Exception:", e);
        process.exit(1);
    }
})();
