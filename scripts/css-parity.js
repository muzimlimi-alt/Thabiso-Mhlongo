/*
 * CSS refactor parity harness — see docs-internal/css-audit.md.
 *
 * Captures a deterministic screenshot set of the public site and every admin section, at every
 * breakpoint in the §15 test matrix, and records a SHA-256 per shot so later phases can be diffed
 * against the Phase 1 baseline without eyeballing 135 PNGs.
 *
 *   node scripts/css-parity.js capture <label>          → docs-internal/css-baseline/<label>/
 *   node scripts/css-parity.js compare <base> <other>   → prints changed/added/removed shots
 *
 * Puppeteer's bundled Chrome is broken on this machine (side-by-side configuration error), so we
 * point executablePath at system Chrome — same workaround as scratch_screenshot_inq.js.
 *
 * Animations and transitions are frozen during capture. That changes rendering, but it changes it
 * identically for baseline and comparison, which is what makes the hashes meaningful at all.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const puppeteer = require('puppeteer');

const BASE = process.env.PARITY_URL || 'http://localhost:3000';
// PARITY_OUT lets captures live off the OneDrive-synced project tree — 135 PNGs per run, once per
// phase, is not something to sync to the cloud (and C: is tight; see docs-internal/css-audit.md §10).
const OUT_ROOT = process.env.PARITY_OUT || path.join(__dirname, '..', 'docs-internal', 'css-baseline');
const EMAIL = process.env.PARITY_EMAIL || 'muzi.mlimi@gmail.com';
const PASSWORD = process.env.PARITY_PASSWORD || 'password123';

const CHROME = [
    process.env.CHROME_BIN,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean).find(p => { try { return fs.existsSync(p); } catch (e) { return false; } });

// PARITY_VIEWPORTS / PARITY_SECTIONS / PARITY_THEMES narrow a run for smoke-testing the harness
// itself. A real phase capture always runs the full matrix — leave them unset.
const ALL_VIEWPORTS = [
    { name: '375', width: 375, height: 812 },
    { name: '768', width: 768, height: 1024 },
    { name: '1440', width: 1440, height: 900 },
];
const VIEWPORTS = process.env.PARITY_VIEWPORTS
    ? ALL_VIEWPORTS.filter(v => process.env.PARITY_VIEWPORTS.split(',').includes(v.name))
    : ALL_VIEWPORTS;
const THEMES = (process.env.PARITY_THEMES || 'dark,light').split(',');

// The 22 real .admin-section panels switchTab() drives (admin.html:15305).
const ALL_ADMIN_SECTIONS = [
    'dashboardAdmin', 'bookingsAdmin', 'inquiriesAdmin', 'financeAdmin', 'eventsAdmin',
    'calendarAdmin', 'newsletterAdmin', 'emailLogsAdmin', 'usersAdmin', 'securityAdmin',
    'brandingAdmin', 'preferencesAdmin', 'policiesAdmin', 'servicesAdmin', 'galleryAdmin',
    'socialAdmin', 'testimonialsAdmin', 'footprintAdmin', 'careerAdmin', 'contactAdmin',
    'aboutAdmin', 'homeAdmin',
];
const ADMIN_SECTIONS = process.env.PARITY_SECTIONS
    ? process.env.PARITY_SECTIONS.split(',')
    : ALL_ADMIN_SECTIONS;

const FREEZE_CSS = `*,*::before,*::after{
  animation-duration:0s!important;animation-delay:0s!important;animation-iteration-count:1!important;
  transition-duration:0s!important;transition-delay:0s!important;caret-color:transparent!important}
html{scroll-behavior:auto!important}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);

/*
 * The admin shell scrolls inside .tm-admin-main, not on <body> (switchTab sets mainEl.scrollTop).
 * document.body stays viewport-height, so `fullPage: true` silently captures only the top ~900px of
 * every admin section. Growing the viewport to the inner container's scrollHeight is what actually
 * gets the whole section into the frame. Width is untouched, so no media query changes.
 */
async function fitAdminViewport(page, width) {
    const need = await page.evaluate(() => {
        const m = document.querySelector('.tm-admin-main');
        return Math.min((m ? m.scrollHeight : document.body.scrollHeight) + 120, 16000);
    });
    await page.setViewport({ width, height: Math.max(need, 600) });
    await sleep(1200);
    return need;
}

/*
 * Hash-first capture. C: runs at ~99.9% full, so retaining all 135 PNGs per phase (~67 MB, x8 phases,
 * inside a OneDrive-synced tree) isn't viable. Every shot is still captured and hashed, so detection
 * coverage is complete — the manifest tells you exactly which shots moved. Images are kept only for
 * the reference set below. To see HOW an unkept shot changed, re-capture its "before" from the
 * pre-change tree (git stash) and run compare again. PARITY_KEEP_ALL=1 overrides.
 */
const KEEP_ALL = process.env.PARITY_KEEP_ALL === '1';
const keepImage = name => KEEP_ALL || name.startsWith('public_') || name.endsWith('_dark_1440');

/*
 * Computed-style fingerprint — the actual pass/fail signal.
 *
 * A screenshot hash cannot tell a CSS regression from ordinary data drift, and this app drifts on
 * every run: tracker.js records a pageview each time the harness loads index.html, so dashboard
 * analytics move, and timestamps advance across email logs, audit tables and schedules. A first
 * pixel comparison flagged 100 of 135 views for exactly that reason. Screenshots are still captured
 * for human review — they just do not decide the outcome.
 *
 * Geometry is deliberately excluded below. width/height resolve to *used* values, so a longer client
 * name or one more booking row moves them. Everything probed is a specified value the stylesheet
 * controls directly.
 */
const PROBED_PROPS = [
    'display', 'position', 'z-index', 'box-sizing', 'overflow',
    'margin', 'padding', 'border', 'border-radius',
    'color', 'background-color', 'background-image', 'box-shadow', 'opacity',
    'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing',
    'text-align', 'text-transform', 'text-decoration',
    'flex-direction', 'justify-content', 'align-items', 'gap', 'grid-template-columns',
];

/*
 * A curated probe rather than a tree walk. Walking the DOM made the fingerprint as noisy as the
 * pixels — ApexCharts and jsvectormap regenerate their SVG subtrees on every render, so element
 * counts alone differed run to run. This instead asks a fixed set of questions with a fixed
 * cardinality: what are the design tokens currently resolving to, and how does the first instance of
 * each design-system component compute? Both are exactly what a cascade change perturbs, and neither
 * moves when the underlying data does.
 */
const PROBE_SELECTORS = [
    // page + typography
    'html', 'body', 'h1', 'h2', 'h3', 'h4', 'p', 'a', 'button', 'input', 'select', 'textarea', 'table', 'td', 'th',
    // admin shell (frozen, JS-bound — css-audit.md §6)
    '.tm-admin-wrapper', '.tm-admin-sidebar', '.tm-admin-main', '.tm-admin-sidebar-header',
    '.tm-nav-link', '.admin-sidebar', '.admin-sidebar li.active', '.admin-section',
    '.adm-header', '.adm-header__inner', '.adm-breadcrumb', '.adm-search', '.adm-search__input',
    '.adm-dropdown', '.adm-dropdown__menu', '.adm-icon-btn', '.adm-profile-btn',
    // shared components
    '.atl-card', '.atl-tab-bar', '.atl-tab-btn', '.um-panel', '.um-panel.active',
    '.atl-drawer', '.atl-badge', '.atl-pill-count', '.atl-grain', '.atl-theme-toggle',
    // bootstrap 3 surfaces the project overrides
    '.btn', '.btn-primary', '.form-control', '.panel', '.modal-content', '.nav', '.container',
    // notification system (frozen — js/notificationService.js)
    '.tm-toast', '.tm-modal', '#tm-toast-container',
    // public site
    '.tm-navbar', '.tm-section', '.tm-container', '.tm-eyebrow', '.tm-footer', '.tm-btn',
    '.ms-row', '.fp-grid', '#back-to-top', '.trk-btn', '#trackingDrawer', '#bookingDrawer',
    '.atl-drawer', '.atl-drawer__header', '.atl-drawer__close',
    // dashboard / booking surfaces named in the brief
    '.db-stat-card', '.db-summary-grid', '.db-social-grid', '.booking-card', '.deal-progress',
    /*
     * Vendor widget surfaces. Added for Phase 4 (overrides), because verifying an overrides move
     * with a probe blind to the overridden widgets would prove nothing. Several only exist once the
     * widget initialises or opens — a consistently ABSENT row is still a stable signal, and the ones
     * that do render (Quill on content sections, FullCalendar on calendarAdmin, intl-tel-input on
     * forms) give real coverage where the risk is.
     */
    '.ql-toolbar', '.ql-container', '.ql-editor', '.ql-snow',
    '.flatpickr-input', '.flatpickr-calendar', '.flatpickr-day',
    '.fc', '.fc-toolbar', '.fc-daygrid-day', '.fc-event', '.fc-col-header-cell',
    '.iti', '.iti__flag-container', '.iti__selected-flag',
    '.apexcharts-canvas', '.jvm-container',
];

async function styleFingerprint(page) {
    return page.evaluate((selectors, props) => {
        const lines = [];
        // 1. Every custom property resolving on :root — the design system's actual current values.
        const rootCS = getComputedStyle(document.documentElement);
        const customs = [];
        for (let i = 0; i < rootCS.length; i++) {
            const p = rootCS[i];
            if (p.startsWith('--')) customs.push(p);
        }
        customs.sort();
        for (const p of customs) lines.push('TOKEN ' + p + ' = ' + rootCS.getPropertyValue(p).trim());
        lines.push('TOKEN count = ' + customs.length);
        // 2. First instance of each design-system component.
        let found = 0;
        for (const sel of selectors) {
            let el = null;
            try { el = document.querySelector(sel); } catch (e) { /* invalid selector */ }
            if (!el) { lines.push(sel + ' | ABSENT'); continue; }
            found++;
            const cs = getComputedStyle(el);
            lines.push(sel + ' | ' + props.map(p => cs.getPropertyValue(p)).join(' | '));
        }
        return { n: found, tokens: customs.length, body: lines.join('\n') };
    }, PROBE_SELECTORS, PROBED_PROPS);
}

async function shoot(page, dir, name, manifest, styleDir) {
    const buf = await page.screenshot({ fullPage: true });
    const kept = keepImage(name);
    if (kept) fs.writeFileSync(path.join(dir, name + '.png'), buf);
    const fp = await styleFingerprint(page);
    // The full fingerprint text is retained (a few KB each) so a failing phase can be diffed line by
    // line — "which property on which component moved" — instead of just "this view changed".
    fs.writeFileSync(path.join(styleDir, name + '.txt'), fp.body);
    manifest[name] = {
        sha: sha(buf), bytes: buf.length, img: kept,
        styleSha: sha(Buffer.from(fp.body, 'utf8')),
        probesFound: fp.n, tokens: fp.tokens,
    };
    process.stdout.write(kept ? 'O' : '.');
}

async function capture(label) {
    if (!CHROME) throw new Error('No system Chrome found. Set CHROME_BIN.');
    const dir = path.join(OUT_ROOT, label);
    fs.mkdirSync(dir, { recursive: true });
    const styleDir = path.join(dir, 'styles');
    fs.mkdirSync(styleDir, { recursive: true });
    const manifest = {};
    const notes = [];
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-'));

    const browser = await puppeteer.launch({
        headless: true,
        executablePath: CHROME,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--no-first-run',
               '--no-default-browser-check', '--hide-scrollbars', '--force-device-scale-factor=1',
               '--user-data-dir=' + profileDir],
    });

    try {
        const page = await browser.newPage();
        page.on('pageerror', e => notes.push('pageerror: ' + e.message));
        page.on('response', r => { if (r.status() >= 400) notes.push(r.status() + ' ' + r.url()); });

        // ---- Public site (dark-only: index.html never sets data-theme) ----
        console.log('\npublic index.html');
        for (const vp of VIEWPORTS) {
            await page.setViewport({ width: vp.width, height: vp.height });
            await page.goto(BASE + '/index.html', { waitUntil: 'networkidle2', timeout: 90000 });
            await page.addStyleTag({ content: FREEZE_CSS });
            await sleep(1200);
            await page.evaluate(() => window.scrollTo(0, 0));
            await shoot(page, dir, `public_index_${vp.name}`, manifest, styleDir);
        }

        // ---- Admin: log in once, then walk every section in both themes ----
        console.log('\nadmin login');
        await page.setViewport({ width: 1440, height: 900 });
        await page.goto(BASE + '/admin.html', { waitUntil: 'networkidle2', timeout: 90000 });
        const loggedIn = await page.evaluate(async (email, password) => {
            const r = await fetch('/api/admin/login', {
                method: 'POST', credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password, remember_me: false }),
            });
            return r.ok;
        }, EMAIL, PASSWORD);
        if (!loggedIn) throw new Error('Admin login failed — set PARITY_EMAIL / PARITY_PASSWORD.');

        for (const theme of THEMES) {
            for (const vp of VIEWPORTS) {
                await page.setViewport({ width: vp.width, height: vp.height });
                // admin.html:7 reads 'atl-theme' before paint; set it so the reload starts in-theme.
                await page.evaluate(t => { try { localStorage.setItem('atl-theme', t); } catch (e) {} }, theme);
                await page.goto(BASE + '/admin.html', { waitUntil: 'networkidle2', timeout: 90000 });
                await page.evaluate(t => document.documentElement.setAttribute('data-theme', t), theme);
                await page.addStyleTag({ content: FREEZE_CSS });
                await sleep(5000); // admin bootstraps a lot of async data before it settles
                console.log(`\nadmin ${theme} @${vp.name}`);
                for (const section of ADMIN_SECTIONS) {
                    await page.setViewport({ width: vp.width, height: vp.height });
                    const ok = await page.evaluate(s => {
                        if (typeof switchTab !== 'function') return false;
                        if (!document.getElementById(s)) return false;
                        switchTab(s); return true;
                    }, section);
                    if (!ok) { notes.push(`section unreachable: ${section} (${theme}/${vp.name})`); continue; }
                    await sleep(2200); // let the section's own fetch/render finish
                    await fitAdminViewport(page, vp.width);
                    // Fingerprint the whole shell, not just the panel — the sidebar, header and
                    // drawer chrome are as much at risk from a cascade change as the section body.
                    await shoot(page, dir, `admin_${section}_${theme}_${vp.name}`, manifest, styleDir);
                }
            }
        }
    } finally {
        await browser.close();
        // Chrome writes ~80 MB of profile data per run into the temp dir. Leaving them behind
        // accumulated 1.8 GB across 22 runs and repeatedly filled the disk mid-capture — the
        // capture then dies with ENOSPC halfway through and the run is wasted. Always clean up.
        try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) { /* best effort */ }
    }

    const kept = Object.values(manifest).filter(m => m.img).length;
    const meta = { label, capturedAt: new Date().toISOString(), shots: Object.keys(manifest).length,
                   imagesKept: kept, keepAll: KEEP_ALL, manifest, notes };
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(meta, null, 2));
    const onDisk = Object.values(manifest).filter(m => m.img).reduce((a, m) => a + m.bytes, 0);
    console.log(`\n\n${meta.shots} shots hashed, ${kept} images kept (${(onDisk / 1048576).toFixed(1)} MB) → ${path.relative(process.cwd(), dir)}`);
    if (notes.length) {
        const uniq = [...new Set(notes)];
        console.log(`\n${uniq.length} note(s) recorded in manifest.json:`);
        uniq.slice(0, 15).forEach(n => console.log('   ' + n));
        if (uniq.length > 15) console.log(`   …and ${uniq.length - 15} more`);
    }
}

function compare(a, b) {
    const load = l => JSON.parse(fs.readFileSync(path.join(OUT_ROOT, l, 'manifest.json'), 'utf8')).manifest;
    const A = load(a), B = load(b);
    const keys = [...new Set([...Object.keys(A), ...Object.keys(B)])].sort();
    const styleChanged = [], pixelOnly = [], added = [], removed = [];
    for (const k of keys) {
        if (!(k in A)) { added.push(k); continue; }
        if (!(k in B)) { removed.push(k); continue; }
        const styleMoved = A[k].styleSha !== B[k].styleSha;
        const pixelMoved = A[k].sha !== B[k].sha;
        if (styleMoved) styleChanged.push(k);
        else if (pixelMoved) pixelOnly.push(k);
    }
    const haveStyles = Object.values(A).some(v => v.styleSha) && Object.values(B).some(v => v.styleSha);
    console.log(`${a} → ${b}`);
    if (!haveStyles) console.log('  (one side predates style fingerprinting — pixel hashes only, expect data-drift noise)');
    console.log(`  views compared            : ${keys.length}`);
    console.log(`  STYLE CHANGED (verdict)   : ${styleChanged.length}`);
    styleChanged.forEach(k => {
        const img = A[k].img && B[k].img ? '' : '   [no image kept — re-capture from the pre-change tree to eyeball it]';
        console.log('      ' + k + img);
    });
    console.log(`  pixels-only (data drift)  : ${pixelOnly.length}   ← analytics counters / timestamps, not CSS`);
    if (added.length) { console.log(`  added   : ${added.length}`); added.forEach(k => console.log('      ' + k)); }
    if (removed.length) { console.log(`  removed : ${removed.length}`); removed.forEach(k => console.log('      ' + k)); }
    const fails = styleChanged.length + added.length + removed.length;
    if (fails === 0) console.log('\n  PARITY HELD — no computed-style differences.');
    else console.log('\n  Every STYLE CHANGED / added / removed entry must be explained in\n  docs-internal/css-refactor-log.md before the next phase.');
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'capture' && rest[0]) capture(rest[0]).catch(e => { console.error('\nFAILED:', e.message); process.exit(1); });
else if (cmd === 'compare' && rest[1]) compare(rest[0], rest[1]);
else { console.error('usage: css-parity.js capture <label> | compare <base> <other>'); process.exit(1); }
