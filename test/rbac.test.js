// Characterisation test for RBAC across admin routes, per Phase 2 of the housekeeping plan:
// "for a representative sample of at least 30 /api/admin routes, assert the response status for
// each of administrator, manager, assistant, and unauthenticated." Routes and their documented
// role requirement come from docs-internal/routes.md (Phase 1 recon, read directly off each
// route's requireAdmin/requireRole([...]) middleware in server.js).
//
// requireAdmin (server.js ~line 1898) returns 401 for no/invalid session. requireRole (~line 1927)
// returns 403 for a valid session with the wrong role. Every route below is a GET with no path
// parameters, so a 200 for an allowed role reflects the RBAC gate only, not fixture data.
//
// Any actor/route pair below whose actual result doesn't match its documented "should" is a real
// finding, not a test bug — per AGENTS.md, a characterisation test asserts what the code actually
// does, and a mismatch here means the running code allows (or blocks) more than routes.md's static
// read of the middleware suggested. Such mismatches get flagged into HOUSEKEEPING-NOTES.md under
// "RBAC review needed", exactly as Phase 2 instructs, rather than silently encoded as "expected".
const { api, pub, loginAs } = require('./support');

// role: 'administrator' | 'manager' | 'assistant' | 'any' (no requireRole layered on top of requireAdmin)
const ROUTES = [
    // ── administrator only ──
    { method: 'GET', path: '/api/admin/users', role: 'administrator' },
    { method: 'GET', path: '/api/admin/user-login-logs', role: 'administrator' },
    // ── administrator + manager ──
    { method: 'GET', path: '/api/admin/financial_audit_log', role: 'manager' },
    { method: 'GET', path: '/api/admin/finance/export', role: 'manager' },
    { method: 'GET', path: '/api/admin/invoices', role: 'manager' },
    { method: 'GET', path: '/api/admin/payment-schedules/mismatches', role: 'manager' },
    { method: 'GET', path: '/api/admin/financials/analytics', role: 'manager' },
    { method: 'GET', path: '/api/admin/finance/pl', role: 'manager' },
    { method: 'GET', path: '/api/admin/expenses', role: 'manager' },
    { method: 'GET', path: '/api/admin/expenses/export', role: 'manager' },
    { method: 'GET', path: '/api/admin/financials/stats', role: 'manager' },
    { method: 'GET', path: '/api/admin/reconciliation', role: 'manager' },
    { method: 'GET', path: '/api/admin/bank-statement/lines', role: 'manager' },
    { method: 'GET', path: '/api/admin/reconciliation/export/csv', role: 'manager' },
    { method: 'GET', path: '/api/admin/banners', role: 'manager' },
    { method: 'GET', path: '/api/admin/email-templates', role: 'manager' },
    { method: 'GET', path: '/api/admin/popia/requests/export', role: 'manager' },
    // ── any authenticated admin role (no requireRole layered on top of requireAdmin) ──
    { method: 'GET', path: '/api/admin/analytics/summary', role: 'any' },
    { method: 'GET', path: '/api/admin/analytics/visits-over-time', role: 'any' },
    { method: 'GET', path: '/api/admin/analytics/traffic-sources', role: 'any' },
    { method: 'GET', path: '/api/admin/analytics/devices', role: 'any' },
    { method: 'GET', path: '/api/admin/analytics/countries', role: 'any' },
    { method: 'GET', path: '/api/admin/analytics/top-pages', role: 'any' },
    { method: 'GET', path: '/api/admin/analytics/bookings-trend', role: 'any' },
    { method: 'GET', path: '/api/admin/abandoned-bookings', role: 'any' },
    { method: 'GET', path: '/api/admin/abandoned-bookings/stats', role: 'any' },
    { method: 'GET', path: '/api/admin/working-hours', role: 'any' },
    { method: 'GET', path: '/api/admin/email-logs', role: 'any' },
    { method: 'GET', path: '/api/admin/newsletter/subscribers', role: 'any' },
    { method: 'GET', path: '/api/admin/audit_log', role: 'any' },
    { method: 'GET', path: '/api/admin/services', role: 'any' },
    { method: 'GET', path: '/api/admin/settings', role: 'any' },
];

function expectedStatus(routeRole, actor) {
    if (actor === 'unauthenticated') return 401;
    if (routeRole === 'any') return 200;
    if (routeRole === 'manager') return (actor === 'administrator' || actor === 'manager') ? 200 : 403;
    if (routeRole === 'administrator') return actor === 'administrator' ? 200 : 403;
    throw new Error(`unknown route role: ${routeRole}`);
}

module.exports = async function ({ check }) {
    check(`fixture: ${ROUTES.length} routes selected (>= 30 required by the plan)`, ROUTES.length >= 30, `${ROUTES.length}`);

    const asManager = await loginAs('manager');
    const asAssistant = await loginAs('assistant');
    const surprises = [];

    for (const route of ROUTES) {
        const actors = [
            ['administrator', () => api(route.method, route.path)],
            ['manager', () => asManager(route.method, route.path)],
            ['assistant', () => asAssistant(route.method, route.path)],
            ['unauthenticated', () => pub(route.method, route.path)],
        ];
        for (const [actor, call] of actors) {
            const expected = expectedStatus(route.role, actor);
            const res = await call();
            const label = `RBAC ${route.method} ${route.path} — ${actor} -> ${expected}`;
            const pass = res.status === expected;
            check(label, pass, `got ${res.status}`);
            if (!pass) surprises.push({ route: `${route.method} ${route.path}`, documentedRole: route.role, actor, expected, actual: res.status });
        }
    }

    if (surprises.length) {
        console.log('\n  RBAC surprises (documented role vs actual behaviour) — see HOUSEKEEPING-NOTES.md:');
        for (const s of surprises) console.log(`    ${s.route} (docs: ${s.documentedRole}) — ${s.actor}: expected ${s.expected}, got ${s.actual}`);
    }
};
