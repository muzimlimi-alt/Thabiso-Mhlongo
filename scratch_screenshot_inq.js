const fs = require('fs'), os = require('os'), path = require('path');
const puppeteer = require('puppeteer');

const OUT = 'C:\\Users\\muzim\\AppData\\Local\\Temp\\claude\\c--Users-muzim-OneDrive-Muzi-s-Office-Dev-Beast-Thabiso-Mhlongo-Official-Website-Thabiso-Mhlongo-Offcial-Website\\bdd739ec-8234-447a-a766-3dc4c75dea72\\scratchpad';
const sysChrome = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
                   'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'].find(fs.existsSync);
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pptr-'));

(async () => {
  const browser = await puppeteer.launch({
    headless: true, executablePath: sysChrome,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-gpu','--no-first-run','--no-default-browser-check','--user-data-dir='+profileDir]
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 1000 });
    await page.goto('http://localhost:3000/admin.html', { waitUntil: 'networkidle2' });
    await page.waitForSelector('#adminEmail', { timeout: 10000 });
    await page.evaluate(async () => {
      await fetch('/api/admin/login', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'muzi.mlimi@gmail.com', password: 'password123', remember_me: false })
      });
    });
    await page.reload({ waitUntil: 'networkidle2' });
    await new Promise(r => setTimeout(r, 1800));

    await page.evaluate(() => { if (typeof switchTab === 'function') switchTab('inquiriesAdmin'); });
    await new Promise(r => setTimeout(r, 1200));
    await page.screenshot({ path: path.join(OUT, 'inq_desktop_wide.png') });

    // Click first message to see reading pane
    const firstMsg = await page.$('.inq-list-body [role="listitem"], .inq-list-body .inq-msg-item, .inq-list-body > div:not(.inq-empty-state)');
    if (firstMsg) {
      await firstMsg.click();
      await new Promise(r => setTimeout(r, 900));
      await page.screenshot({ path: path.join(OUT, 'inq_reading_pane.png') });
    } else {
      console.log('No message item found to click - inbox may be empty or selector needs updating');
    }

    // Narrower viewport (tablet)
    await page.setViewport({ width: 1024, height: 900 });
    await new Promise(r => setTimeout(r, 500));
    await page.screenshot({ path: path.join(OUT, 'inq_tablet.png') });

    // Mobile viewport
    await page.setViewport({ width: 480, height: 900 });
    await new Promise(r => setTimeout(r, 500));
    await page.screenshot({ path: path.join(OUT, 'inq_mobile.png') });

  } finally {
    await browser.close();
  }
})().catch(e => { console.error('SCRIPT FAILED:', e); process.exit(1); });
