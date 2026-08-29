// Phase 2 Step 3 (housekeeping-agent-prompts.md): a crash detector, not an authorisation test.
// Boots the app against a throwaway database copy (via test/support.js — the same isolated port,
// sandboxed PayFast/Google env vars, and cleanup as the main suite) and fires every route listed
// in docs-internal/routes.md, unauthenticated, asserting only that none of them return a 5xx.
// A 401/403/404/400/429 is a PASS here — those are the app behaving correctly for an
// unauthenticated caller. Only >=500 (or a request that errors/times out, which usually means the
// process crashed or hung) counts as a failure.
//
// Route list is parsed from docs-internal/routes.md rather than re-derived from server.js, per the
// plan's wording. That means this script can drift from server.js if routes.md isn't refreshed
// after a later route change — it is a snapshot from Phase 1 recon, not a live source of truth.
// Run with: npm run smoke
const fs = require('fs');
const path = require('path');
const support = require('./support');

const ROUTES_MD = path.join(__dirname, '..', 'docs-internal', 'routes.md');
const REQUEST_TIMEOUT_MS = 15000;

function parseRoutes(mdText) {
    const routes = [];
    const rowRe = /^\|\s*(GET|POST|PUT|PATCH|DELETE)\s*\|\s*(\S+)\s*\|/gm;
    let m;
    while ((m = rowRe.exec(mdText))) {
        routes.push({ method: m[1], path: m[2] });
    }
    return routes;
}

// Route params are substituted with a placeholder, not a real fixture id — this is a crash
// detector, so "the id doesn't exist" (-> 404/400) is exactly as valid a pass as "it does".
function substituteParams(routePath) {
    return routePath.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, '1');
}

async function fireOne(method, urlPath) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const r = await fetch(support.BASE + urlPath, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: method === 'GET' ? undefined : '{}',
            signal: controller.signal,
        });
        return { status: r.status };
    } catch (e) {
        return { status: null, error: e.name === 'AbortError' ? 'TIMEOUT' : e.message };
    } finally {
        clearTimeout(timer);
    }
}

async function main() {
    if (!fs.existsSync(ROUTES_MD)) {
        console.error(`Cannot find ${ROUTES_MD}. Run Phase 1 recon first (docs-internal/routes.md).`);
        process.exit(2);
    }
    const routes = parseRoutes(fs.readFileSync(ROUTES_MD, 'utf8'));
    if (routes.length === 0) {
        console.error('Parsed zero routes out of docs-internal/routes.md — check its table format hasn\'t changed.');
        process.exit(2);
    }

    console.log(`Booting app on isolated test DB... (${routes.length} routes parsed from docs-internal/routes.md)`);
    await support.start();
    console.log('Ready.\n');

    const failures = [];
    let passed = 0;
    try {
        for (const { method, path: routePath } of routes) {
            const resolvedPath = substituteParams(routePath);
            const result = await fireOne(method, resolvedPath);
            const ok = result.status !== null && result.status < 500;
            if (ok) {
                passed++;
            } else {
                failures.push({ method, routePath, resolvedPath, status: result.status, error: result.error });
                console.log(`  FAIL  ${method} ${routePath}${resolvedPath !== routePath ? ` (as ${resolvedPath})` : ''} -> ${result.status || result.error}`);
            }
        }
    } finally {
        await support.stop();
    }

    console.log('='.repeat(72));
    console.log(`${passed}/${routes.length} routes returned non-5xx`);
    if (failures.length) {
        console.log(`\n${failures.length} route(s) returned 5xx or errored:`);
        for (const f of failures) console.log(`  ${f.method} ${f.routePath} -> ${f.status || f.error}`);
    }
    process.exit(failures.length ? 1 : 0);
}

main().catch(async (e) => {
    console.error('\nSMOKE RUN ERROR:', e.message);
    try {
        console.error('\n--- SERVER LOGS START ---');
        console.error(support.getChildLog());
        console.error('--- SERVER LOGS END ---');
    } catch (_) {}
    try { await support.stop(); } catch (_) {}
    process.exit(2);
});
