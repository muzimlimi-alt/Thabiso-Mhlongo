/* RBAC UI verification via Puppeteer (system Chrome).
 * Drives admin.html for each role and reports computed visibility of gated UI.
 * Captures BOTH the fresh-login state and the post-reload (session-path) state,
 * because the login-success handler does not apply role gating. */
const puppeteer = require('puppeteer');

const BASE = 'http://localhost:3000/admin.html';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const ROLES = [
  { user: 'assistant', pass: 'AssistantPassword123!', expect: 'assistant' },
  { user: 'muzi',      pass: 'ManagerPassword123!',   expect: 'manager' },
  { user: 'admin',     pass: 'AdminPassword123!',     expect: 'administrator' },
];

// Runs in page context: returns visibility snapshot of gated elements.
function snapshot() {
  const disp = (sel) => {
    const a = document.querySelector(sel);
    const li = a ? a.parentElement : null;
    if (!li) return 'MISSING';
    return getComputedStyle(li).display;
  };
  const groupTitle = (text) => {
    const el = Array.from(document.querySelectorAll('.tm-sidebar-group-title'))
      .find(e => e.textContent.includes(text));
    if (!el) return 'MISSING';
    return getComputedStyle(el).display;
  };
  // CSS probe: inject buttons with the real gated classes, read computed display.
  const probe = (cls) => {
    const b = document.createElement('button');
    b.className = cls;
    b.textContent = 'probe';
    document.body.appendChild(b);
    const d = getComputedStyle(b).display;
    b.remove();
    return d;
  };
  return {
    bodyClass: document.body.className.match(/role-\S+/)?.[0] || '(none)',
    financeLink: disp('a[href="#financeAdmin"]'),
    financeGroupTitle: groupTitle('Finance'),
    systemSettingsTitle: groupTitle('System Settings'),
    usersLink: disp('a[href="#usersAdmin"]'),
    securityLink: disp('a[href="#securityAdmin"]'),
    brandingLink: disp('a[href="#brandingAdmin"]'),
    voidBtnProbe: probe('btn-void-invoice'),
    deleteBtnProbe: probe('delete-btn'),
    bkDeleteNoteProbe: probe('bk-delete-note-btn'),
  };
}

// Runs in page context: tests switchTab gating to a restricted section.
function tryNavigate(sectionId) {
  if (typeof window.switchTab !== 'function') return { ok: false, reason: 'no switchTab' };
  let errorShown = null;
  const orig = window.notificationService && window.notificationService.showError;
  if (orig) {
    window.notificationService.showError = (m) => { errorShown = m; };
  }
  window.switchTab(sectionId);
  if (orig) window.notificationService.showError = orig;
  const target = document.getElementById(sectionId);
  const dash = document.getElementById('dashboardAdmin');
  return {
    requestedVisible: target ? getComputedStyle(target).display : 'MISSING',
    dashboardVisible: dash ? getComputedStyle(dash).display : 'MISSING',
    errorShown,
  };
}

async function waitDashboard(page) {
  await page.waitForFunction(
    () => document.getElementById('dashboardSection') &&
          getComputedStyle(document.getElementById('dashboardSection')).display !== 'none',
    { timeout: 15000 }
  );
}

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: CHROME,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const out = {};
  for (const r of ROLES) {
    const ctx = (await browser.createBrowserContext?.()) || browser.defaultBrowserContext();
    const page = await ctx.newPage();
    const dialogs = [];
    page.on('dialog', async (d) => { dialogs.push({ type: d.type(), message: d.message() }); await d.accept(); });
    const res = { dialogs };
    try {
      await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 20000 });
      await page.waitForSelector('#adminUsername', { timeout: 10000 });
      await page.type('#adminUsername', r.user);
      await page.type('#adminPassword', r.pass);
      await page.click('#loginBtn');
      await waitDashboard(page);
      // State immediately after fresh login (no reload)
      res.freshLogin = await page.evaluate(snapshot);
      // Reload -> session path applies gating
      await page.reload({ waitUntil: 'networkidle2', timeout: 20000 });
      await waitDashboard(page);
      res.afterReload = await page.evaluate(snapshot);
      res.navFinance = await page.evaluate(tryNavigate, 'financeAdmin');
      res.navUsers = await page.evaluate(tryNavigate, 'usersAdmin');
    } catch (e) {
      res.error = e.message.split('\n')[0];
    } finally {
      await page.close();
      if (ctx !== browser.defaultBrowserContext()) await ctx.close();
    }
    out[r.user] = res;
  }
  await browser.close();
  console.log(JSON.stringify(out, null, 2));
})().catch(e => { console.error('FATAL', e); process.exit(1); });
