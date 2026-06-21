/* Server-side RBAC enforcement + admin manual booking creation.
 * Confirms the security boundary (requireRole) actually blocks non-admins,
 * independent of the client-side CSS hiding. Uses real session cookies. */
const BASE = 'http://localhost:3000';

const CREDS = {
  assistant: { user: 'assistant', pass: 'AssistantPassword123!' },
  manager:   { user: 'muzi',      pass: 'ManagerPassword123!' },
  admin:     { user: 'admin',     pass: 'AdminPassword123!' },
};

async function login(c) {
  const r = await fetch(`${BASE}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: c.user, password: c.pass }),
  });
  const setCookie = r.headers.get('set-cookie') || '';
  const cookie = setCookie.split(';')[0];
  const body = await r.json().catch(() => ({}));
  return { cookie, status: r.status, role: body.role };
}

async function call(cookie, method, path, body) {
  const opts = { method, headers: { Cookie: cookie } };
  if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const r = await fetch(`${BASE}${path}`, opts);
  let parsed; const txt = await r.text();
  try { parsed = JSON.parse(txt); } catch { parsed = txt.slice(0, 120); }
  return { status: r.status, body: parsed };
}

(async () => {
  const sessions = {};
  for (const [k, c] of Object.entries(CREDS)) sessions[k] = await login(c);
  console.log('=== LOGIN ===');
  for (const [k, s] of Object.entries(sessions)) console.log(` ${k}: status=${s.status} role=${s.role}`);

  // Authorization matrix (non-destructive: fake IDs; requireRole runs before handler)
  console.log('\n=== AUTHORIZATION MATRIX (status code) ===');
  const checks = [
    ['GET',    '/api/admin/users',                  null, { admin: 200, manager: 403, assistant: 403 }],
    ['GET',    '/api/admin/financial_audit_log',    null, { admin: 200, manager: 200, assistant: 403 }],
    ['DELETE', '/api/admin/bookings/999999999',     null, { manager: 403, assistant: 403 }],
    ['POST',   '/api/admin/invoices/999999/void',   { reason: 'rbac-probe' }, { manager: 403, assistant: 403 }],
  ];
  for (const [method, path, body, expect] of checks) {
    const line = [];
    for (const role of Object.keys(expect)) {
      const res = await call(sessions[role].cookie, method, path, body);
      const ok = res.status === expect[role] ? 'PASS' : `FAIL(exp ${expect[role]})`;
      line.push(`${role}=${res.status} ${ok}`);
    }
    console.log(` ${method} ${path}\n    ${line.join('  |  ')}`);
  }

  // Admin manual booking — conflict/override flow (plan Step 3)
  console.log('\n=== ADMIN MANUAL BOOKING (Step 3) ===');
  const payload = {
    name: 'Subagent Test Client', email: 'subagent@example.com', cell: '0821234567',
    company: '', event_name: 'Subagent Conflict Test', event_type: 'Corporate Event',
    event_location: 'Johannesburg', city: 'Johannesburg', country: 'South Africa',
    event_date: '2026-12-25', event_start_time: '10:00',
    message: 'This is a subagent conflict test.', status: 'NEW',
    services: [{ service_id: 24, quantity_minutes: 60 }, { service_id: 27, quantity_minutes: 1 }],
  };
  // First attempt: no overrides -> expect a guard (working_hours 400 / conflict 409 / duplicate 409)
  const first = await call(sessions.admin.cookie, 'POST', '/api/admin/bookings', payload);
  console.log(` 1st attempt (no override): status=${first.status} ->`,
    JSON.stringify(first.body).slice(0, 180));
  // Second attempt: accept the "confirm box" -> set overrides -> expect success
  const second = await call(sessions.admin.cookie, 'POST', '/api/admin/bookings',
    { ...payload, override_conflict: true, override_working_hours: true, override_duplicate: true });
  console.log(` 2nd attempt (overrides):   status=${second.status} ->`,
    JSON.stringify(second.body).slice(0, 220));

  // Confirm manager is ALSO allowed to create (parity), assistant is NOT
  console.log('\n=== CREATE-BOOKING ROLE PARITY (role check only, bad payload -> 400 if allowed, 403 if blocked) ===');
  for (const role of ['manager', 'assistant']) {
    const res = await call(sessions[role].cookie, 'POST', '/api/admin/bookings', { name: '', services: [] });
    const verdict = res.status === 403 ? 'BLOCKED (403)' : `ALLOWED past role-check (${res.status})`;
    console.log(` ${role}: ${verdict}`);
  }
})().catch(e => { console.error('FATAL', e); process.exit(1); });
