# Atelier Admin — User Management & RBAC Hardening Prompt
### (Email-as-login, unique accounts, comprehensive profile fields, role-aware UI, attribution fix)

> **What this prompt is for.** The RBAC *enforcement* layer (`requireRole`, the three-role
> model, sidebar/page gating) is already live and was independently verified working. What's
> missing is the **data model and UI around the admin account itself**: emails aren't unique,
> login is by `username` instead of email, the "Manage Users" panel has no concept of role at
> all (can't set it on create, can't edit it on an existing user, displays a hardcoded label),
> and several admin-table fields worth having (full name, phone, active/suspended status,
> last login) don't exist yet. A real bug was also found during the audit — about a dozen
> attribution call sites silently log every action as performed by `'admin'` regardless of who's
> actually logged in — and is fixed here as part of the same body of work.
>
> This prompt touches **`database.js`**, **`server.js`**, and **`admin.html`**. It does not
> touch the booking pipeline, finance/invoicing logic, or any admin section other than the
> Users module, login screen, and header profile chip.

---

## 0. Full-stack impact analysis (read before changing anything)

| Layer | What changes | What must NOT change |
|---|---|---|
| **Database** (`database.js`) | `admins` table gains `full_name`, `phone`, `is_active`, `last_login_at` columns + a defensive `role` column migration; new `UNIQUE INDEX` on `email` | No existing column dropped; no other table touched |
| **Backend** (`server.js`) | Login route (email-based auth), `requireAdmin` (suspension re-check), `/api/admin/users` CRUD (uniqueness validation, new fields, last-administrator guard, admin-resets-other-user-password path), 12 attribution call sites | `requireRole` gating already on ~40 routes — untouched; booking/finance/invoice business logic — untouched |
| **Frontend** (`admin.html`) | Login form (email field), Manage Users panel (role + status UI, Edit capability, redesigned cards), My Profile panel (dynamic role label), header profile chip (bug fix) | `switchTab` role-gating logic, sidebar hide/show logic, `applyRoleGating()` — already correct, untouched |

---

## 1. Current state — confirmed via direct audit

Line numbers are cited for orientation only — **search by `id`/string before editing**, they drift.

### 1.1 RBAC enforcement (already correct — do not rework)

- `requireAdmin` (server.js ~L1510) — session + rate-limit gate, already redirects to forced
  password change when `must_change_password` is set.
- `requireRole(allowedRoles)` (server.js ~L1528) — checks `req.session.role`, defaults to
  `'assistant'` if unset (fail-closed, correct).
- ~40 routes already gated exactly per your permission table (`requireRole(['administrator'])`
  on delete/void/users/branding/settings; `requireRole(['administrator','manager'])` on finance).
- Frontend: `applyRoleGating()` (admin.html ~L15838) hides the System Settings sidebar group,
  Finance for assistants, and redirects via `switchTab()` (~L17322) if a restricted hash is
  opened directly. This was independently verified and is **out of scope** — leave it alone.

### 1.2 The `admins` table today

```sql
CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    email TEXT,                          -- nullable, NOT unique today
    password_hash TEXT NOT NULL,
    must_change_password INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)
```

`server.js` already `SELECT`s/`INSERT`s/`UPDATE`s a `role` column on this table in ~15 places.
**The copy of `database.js` available for this audit does not define that column or its
migration** — meaning either it was added in a version not included in this review, or the
migration genuinely doesn't exist yet and every `role`-touching query is one missed deploy away
from `no such column: role`. Task A below adds the migration defensively, idempotently, and
harmlessly either way — **verify against the live `database.js` before assuming it's missing**.

### 1.3 Manage Users panel today (`#usersAdmin`, admin.html ~L4752–4991)

- **Add User form (`#umAddUserForm`)** captures Username, Email, Password only — **no role
  field**. Every user created through this UI today silently lands on `role = 'manager'`
  (the backend's fallback when `role` is omitted from the POST body — server.js L6333).
- **No Edit affordance exists for other users at all.** `renderUserCards()` (admin.html
  ~L19204) only renders a Delete button (hidden for the logged-in user's own card) — there is
  no path in the UI to change an existing user's role, email, or name.
- **My Profile hero hardcodes `"Super Administrator"`** (admin.html L4789) for every account
  regardless of actual role.
- `.um-user-name` / `.um-user-role` CSS classes already exist (admin.html ~L3241–3248, JetBrains
  Mono styling for role text) but are **never used** in the card markup — built for this, never
  wired up.
- Several classes the card template already references — `.um-avatar-sm`, `.um-user-card__top`,
  `.um-user-card__name`, `.um-user-card__email`, `.um-user-card__meta`, `.um-user-card__joined`,
  `.um-user-card__badge`, `.um-user-card__badge--you`, `.um-user-card__actions`,
  `.um-user-card__confirm`, `.um-user-card__confirm.visible` — **have no CSS rules anywhere in
  the file.** The cards are partially unstyled today; this prompt defines them.
- `.um-input-wrap .iti.iti--separate-dial-code` is already styled (admin.html L2709) —
  intl-tel-input inside `.um-input-wrap` was clearly anticipated for this module. Use it for the
  new phone field (matches the existing `#managerCell` pattern, server.js-adjacent, admin.html
  ~L10021: `intlTelInput(input, { utilsScript: …, separateDialCode: true, initialCountry: "za" })`).

### 1.4 Login today (server.js ~L1900–1927, admin.html `#adminLoginForm` ~L3961–4000)

- Authenticates via `SELECT * FROM admins WHERE username = ?`.
- Form field: `id="adminUsername" name="username"`, label "Username".
- "Remember me" persists the typed value to `localStorage['admin_saved_username']` and
  restores it on page load (admin.html ~L15977–16032).
- Forgot-password is **already** email-based (server.js ~L1988) and unaffected by this prompt's
  login change — but note it already silently picks whichever row `db.get` returns first when
  emails collide, which Task A's unique index permanently closes.

### 1.5 Two bugs found during audit, both fixed by this prompt

**Bug 1 — header name doesn't live-refresh.** `umProfileForm`'s save handler (admin.html
L18978) queries `qs('#adm-profile-name')` — the actual element is `id="admProfileName"`
(admin.html L4247, no hyphens). The selector never matches; the header silently fails to update
after a profile save. Fix: call the existing `updateProfileDisplay()` (admin.html L17461)
instead of hand-rolling a second, broken update.

**Bug 2 — actions are attributed to `'admin'` no matter who performed them.** Twelve call sites
read `req.session?.adminUser?.username || 'admin'` — but `req.session.adminUser` is **never
assigned anywhere in the codebase**. Login only ever sets `req.session.username` directly
(server.js L1916). Every one of these expressions therefore always evaluates to the literal
string `'admin'`:

| Line (server.js) | Variable | Writes into |
|---|---|---|
| ~L5282 | `uploadedBy` | `contracts` (PDF upload) |
| ~L5325 | `signedBy` | `contracts` (mark signed) |
| ~L6585 | `adminUser` | `audit_log` + `financial_audit_log` (service create) |
| ~L6659 | `adminUser` | `audit_log` + `financial_audit_log` (service update) |
| ~L6692 | `adminUser` | `audit_log` (service archive) |
| ~L6907 | `adminUser` | invoice void trail |
| ~L6938 | `adminUser` | invoice mark-paid trail |
| ~L9390 | `addedBy` | `audit_log` + `financial_audit_log` (expense create) |
| ~L9429 | `addedBy` | `audit_log` (expense delete) |
| ~L9454 | `addedBy` | expense update |
| ~L9573 | `adminUser` | `financial_audit_log` (manual transaction) |
| ~L9947 | `adminUser` | transaction reconciliation note |

One call site nearby (server.js L4193, manual payment) already does this **correctly** via
`req.session.adminId` — left as-is; it's a different (numeric) attribution style and is out of
scope here, but is the same class of inconsistency worth a future cleanup pass.

---

## 2. Decisions locked in for this prompt (stakeholder sign-off received)

1. **Keep the `username` column.** Do not rename it or strip it from the schema. On every
   create/update, `username` is silently auto-set equal to the (lowercased) email. This means
   the ~15 existing reads of `row.username` / `data.username` / `req.session.username`
   throughout both files keep working unmodified — they'll simply display an email going
   forward. Login authenticates against `email`, not `username`.
2. **New `admins` columns:** `full_name`, `phone`, `is_active` (Active/Suspended), plus
   `last_login_at` (recommended addition, bundled in — low-risk, directly useful for the
   Security & Audit page, no UI controversy).
3. **The attribution bug (12 sites) is in scope** and fixed as Task D below.

---

## 3. Task A — Database schema (`database.js`)

Add immediately after the existing `admins` table block (the one with the `email` /
`must_change_password` `ALTER TABLE` failsafes), following the exact idempotent,
error-swallowing pattern already used there and for `services.is_active`:

```js
// Defensive role-column migration — safe no-op if already present.
db.run("ALTER TABLE admins ADD COLUMN role TEXT DEFAULT 'manager'", () => {});

// Comprehensive user management — new profile/status fields.
db.run("ALTER TABLE admins ADD COLUMN full_name TEXT", () => {});
db.run("ALTER TABLE admins ADD COLUMN phone TEXT", () => {});
db.run("ALTER TABLE admins ADD COLUMN is_active INTEGER DEFAULT 1", () => {});
db.run("ALTER TABLE admins ADD COLUMN last_login_at DATETIME", () => {});

// Backfill: the original bootstrap admin account must remain a full administrator.
db.run("UPDATE admins SET role = 'administrator' WHERE username = 'admin' AND (role IS NULL OR role = '')", () => {});
db.run("UPDATE admins SET is_active = 1 WHERE is_active IS NULL", () => {});

// Email uniqueness. MUST run after a pre-flight duplicate check (see §6.1) —
// CREATE UNIQUE INDEX fails outright if any two existing rows already share an email.
db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_admins_email_unique ON admins(email)", (err) => {
    if (err) console.error('[migration] admins.email unique index failed — duplicate emails likely exist, see audit step:', err.message);
});
```

**Before running this migration**, execute the pre-flight check in §6.1 against the live
database and resolve any duplicate/blank emails — the index creation will silently fail (logged,
not thrown) if it can't be applied, leaving the app running without the uniqueness guarantee
this whole prompt exists to add.

---

## 4. Task B — Backend: login, session, suspension enforcement (`server.js`)

### 4.1 Login route (~L1900)

```js
app.post('/api/admin/login', adminLoginRateLimiter, (req, res) => {
    const { email, password, remember_me } = req.body;

    if (!email || !password) {
        return res.status(400).json({ success: false, message: 'Email and password are required.' });
    }
    const normalizedEmail = String(email).trim().toLowerCase();

    db.get("SELECT * FROM admins WHERE email = ?", [normalizedEmail], (err, row) => {
        if (err) return res.status(500).json({ success: false, message: 'Database error' });
        if (!row) return res.status(401).json({ success: false, message: 'Invalid credentials' });

        bcrypt.compare(password, row.password_hash, (err, isMatch) => {
            if (err) return res.status(500).json({ success: false, message: 'Error checking password' });
            if (!isMatch) return res.status(401).json({ success: false, message: 'Invalid credentials' });
            if (row.is_active === 0) {
                return res.status(403).json({ success: false, message: 'This account has been suspended. Contact an administrator.' });
            }

            req.session.adminId = row.id;
            req.session.username = row.username;
            req.session.role = row.role || 'manager';
            req.session.must_change_password = row.must_change_password ? true : false;
            req.session.cookie.maxAge = remember_me ? 1000 * 60 * 60 * 24 * 30 : null;

            db.run("UPDATE admins SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?", [row.id], () => {});

            return res.json({ success: true, message: 'Login successful', role: row.role || 'manager', must_change_password: row.must_change_password ? true : false });
        });
    });
});
```

### 4.2 `requireAdmin` — re-check suspension on every request (~L1510)

A session issued before a suspension must stop working immediately, not just block future
logins. Add one DB check inside the existing handler, preserving the `must_change_password`
branch exactly as-is:

```js
const requireAdmin = [
    adminRateLimiter,
    (req, res, next) => {
        if (req.session && req.session.adminId) {
            if (req.session.must_change_password) {
                const allowedRoutes = ['/force-change-password', '/logout', '/session'];
                const isAllowed = allowedRoutes.some(route => req.path.endsWith(route));
                if (!isAllowed) {
                    return res.status(403).json({ success: false, message: 'Password change required.', must_change_password: true });
                }
            }
            // SECURITY NOTE (accepted cost): one extra indexed lookup per admin request, so a
            // suspension takes effect immediately instead of only blocking the next login.
            db.get("SELECT is_active FROM admins WHERE id = ?", [req.session.adminId], (err, row) => {
                if (err) return res.status(500).json({ success: false, message: 'Database error.' });
                if (!row || row.is_active === 0) {
                    return req.session.destroy(() => {
                        res.status(403).json({ success: false, message: 'This account has been suspended. Contact an administrator.' });
                    });
                }
                return next();
            });
            return;
        }
        return res.status(401).json({ success: false, message: 'Unauthorized. Please log in.' });
    }
];
```

### 4.3 `/api/admin/session` — return the new fields (~L1957)

Extend every `SELECT` and every response object in this route to include
`full_name, phone, is_active, last_login_at` alongside the existing `id, username, email, role,
created_at`. No behavioural change otherwise — same fallback chain (ID → session username).

---

## 5. Task C — Backend: `/api/admin/users` CRUD (`server.js` ~L6321–6398)

Define once, near `requireRole` (~L1528), to remove the duplicated inline role-literal array:

```js
const VALID_ADMIN_ROLES = ['administrator', 'manager', 'assistant'];

function countOtherActiveAdministrators(excludeUserId, callback) {
    db.get(
        "SELECT COUNT(*) AS count FROM admins WHERE role = 'administrator' AND is_active = 1 AND id != ?",
        [excludeUserId], callback
    );
}
```

### 5.1 `GET /api/admin/users`

```js
app.get('/api/admin/users', requireAdmin, requireRole(['administrator']), (req, res) => {
    db.all("SELECT id, username, email, full_name, phone, role, is_active, last_login_at, created_at FROM admins ORDER BY created_at DESC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});
```

### 5.2 `POST /api/admin/users` (create)

```js
app.post('/api/admin/users', requireAdmin, requireRole(['administrator']), (req, res) => {
    const { email, password, full_name, phone, role } = req.body;
    if (!email || !password) {
        return res.status(400).json({ success: false, message: 'Email and password are required.' });
    }
    if (password.length < 8) {
        return res.status(400).json({ success: false, message: 'Password must be at least 8 characters.' });
    }
    const normalizedEmail = String(email).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
        return res.status(400).json({ success: false, message: 'Enter a valid email address.' });
    }
    const targetRole = VALID_ADMIN_ROLES.includes(role) ? role : 'manager';

    bcrypt.hash(password, 10, (err, hash) => {
        if (err) return res.status(500).json({ success: false, message: 'Error hashing password' });

        // username is auto-synced to email (Decision §2.1) — not user-supplied.
        db.run(
            "INSERT INTO admins (username, email, password_hash, role, full_name, phone, is_active, must_change_password) VALUES (?, ?, ?, ?, ?, ?, 1, 1)",
            [normalizedEmail, normalizedEmail, hash, targetRole, (full_name || '').trim() || null, (phone || '').trim() || null],
            function (err) {
                if (err) {
                    if (err.message.includes('UNIQUE')) {
                        return res.status(400).json({ success: false, message: 'An account with that email already exists.' });
                    }
                    return res.status(500).json({ success: false, error: err.message });
                }
                res.json({ success: true, id: this.lastID, message: 'User created successfully.' });
            }
        );
    });
});
```

Note `must_change_password` is set to `1` on creation — the admin sets a temporary password,
the new user is forced to choose their own on first login. This reuses the existing
force-change-password flow untouched.

### 5.3 `PUT /api/admin/users/:id` (edit — self **and** other-user paths)

The existing route requires `currentPassword` to change a password — correct for self-service,
wrong for an administrator resetting *someone else's* password (they shouldn't need to know
that person's old password). Branch on whether the editor is editing their own row:

```js
app.put('/api/admin/users/:id', requireAdmin, requireRole(['administrator']), (req, res) => {
    const { email, password, currentPassword, full_name, phone, role, is_active } = req.body;
    const userId = parseInt(req.params.id, 10);
    const isEditingSelf = userId === req.session.adminId;

    if (!email) return res.status(400).json({ success: false, message: 'Email is required.' });
    const normalizedEmail = String(email).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
        return res.status(400).json({ success: false, message: 'Enter a valid email address.' });
    }
    const targetRole = VALID_ADMIN_ROLES.includes(role) ? role : 'manager';
    const targetIsActive = (is_active === false || is_active === 0) ? 0 : 1;

    db.get("SELECT role, is_active FROM admins WHERE id = ?", [userId], (selErr, existing) => {
        if (selErr || !existing) return res.status(404).json({ success: false, message: 'User not found.' });

        // Last-administrator guard (§7.1)
        const wasActiveAdmin = existing.role === 'administrator' && existing.is_active !== 0;
        const willStopBeingActiveAdmin = targetRole !== 'administrator' || targetIsActive === 0;
        const proceedWithUpdate = (otherAdminCount) => {
            if (wasActiveAdmin && willStopBeingActiveAdmin && otherAdminCount === 0) {
                return res.status(403).json({ success: false, message: 'Cannot remove the last remaining administrator account.' });
            }
            applyUpdate();
        };
        if (wasActiveAdmin && willStopBeingActiveAdmin) {
            countOtherActiveAdministrators(userId, (cntErr, cntRow) => proceedWithUpdate(cntErr ? 1 : cntRow.count));
        } else {
            applyUpdate();
        }

        function applyUpdate() {
            const fields = { username: normalizedEmail, email: normalizedEmail, full_name: (full_name || '').trim() || null, phone: (phone || '').trim() || null, role: targetRole, is_active: targetIsActive };

            if (password && password.trim() !== '') {
                if (isEditingSelf) {
                    if (!currentPassword) {
                        return res.status(400).json({ success: false, message: 'Current password is required to set a new password.' });
                    }
                    return db.get("SELECT password_hash FROM admins WHERE id = ?", [userId], (err, row) => {
                        bcrypt.compare(currentPassword, row.password_hash, (err, isMatch) => {
                            if (!isMatch) return res.status(401).json({ success: false, message: 'Current password is incorrect.' });
                            hashAndSave(fields, password);
                        });
                    });
                }
                // Administrator resetting another user's password — no currentPassword needed.
                return hashAndSave(fields, password);
            }
            saveFields(fields, null);
        }

        function hashAndSave(fields, newPassword) {
            bcrypt.hash(newPassword, 10, (err, hash) => {
                if (err) return res.status(500).json({ success: false, message: 'Error hashing password' });
                saveFields(fields, hash);
            });
        }

        function saveFields(fields, passwordHash) {
            const setPwd = passwordHash ? ", password_hash = ?, must_change_password = 0" : "";
            const params = [fields.username, fields.email, fields.full_name, fields.phone, fields.role, fields.is_active];
            if (passwordHash) params.push(passwordHash);
            params.push(userId);

            db.run(
                `UPDATE admins SET username = ?, email = ?, full_name = ?, phone = ?, role = ?, is_active = ?${setPwd} WHERE id = ?`,
                params,
                function (err) {
                    if (err) {
                        if (err.message.includes('UNIQUE')) {
                            return res.status(400).json({ success: false, message: 'An account with that email already exists.' });
                        }
                        return res.status(500).json({ success: false, error: err.message });
                    }
                    res.json({ success: true, message: 'User updated successfully.' });
                }
            );
        }
    });
});
```

> The existing `umProfileForm` / `umPasswordForm` (self-service panels, §8.3) still call this
> same route with `id === req.session.adminId`, so `isEditingSelf` is always true for them —
> they keep requiring `currentPassword` exactly as before. No change needed on those forms
> beyond removing the now-redundant `username` body field (auto-synced server-side).

### 5.4 `DELETE /api/admin/users/:id` — extend the existing self-delete guard

```js
app.delete('/api/admin/users/:id', requireAdmin, requireRole(['administrator']), (req, res) => {
    const targetUserId = parseInt(req.params.id, 10);
    const currentUserId = req.session.adminId;

    if (targetUserId === currentUserId) {
        return res.status(403).json({ success: false, message: 'You cannot delete your own account while logged in.' });
    }

    db.get("SELECT role, is_active FROM admins WHERE id = ?", [targetUserId], (selErr, existing) => {
        if (selErr || !existing) return res.status(404).json({ success: false, message: 'User not found.' });
        const isActiveAdmin = existing.role === 'administrator' && existing.is_active !== 0;

        const proceed = () => {
            db.run("DELETE FROM admins WHERE id = ?", targetUserId, function (err) {
                if (err) return res.status(500).json({ success: false, error: err.message });
                res.json({ success: true, message: 'User deleted.' });
            });
        };

        if (!isActiveAdmin) return proceed();
        countOtherActiveAdministrators(targetUserId, (cntErr, cntRow) => {
            if (!cntErr && cntRow.count === 0) {
                return res.status(403).json({ success: false, message: 'Cannot delete the last remaining administrator account.' });
            }
            proceed();
        });
    });
});
```

---

## 6. Task D — Backend: fix the broken attribution bug (server.js, 12 sites)

At every line listed in §1.5's table, replace:

```js
req.session?.adminUser?.username || 'admin'
```

with:

```js
req.session.username || 'system'
```

This is a pure one-line swap at each site — no surrounding logic, SQL, or response shape
changes. `req.session.username` is already correctly populated at login (§4.1) and, per
Decision §2.1, will read as the acting admin's email going forward. The `'system'` fallback
(rather than `'admin'`) is deliberately honest about the edge case where a session somehow lacks
a username, rather than misattributing it to one specific account.

Leave server.js L4193 (`req.session.adminId || 'admin'`) untouched — it's a working, just
differently-styled, call site and out of this prompt's scope.

---

## 7. Edge case handling

### 7.1 Last-administrator protection

Covered in Task C §5.3 (demote/suspend) and §5.4 (delete). Three independent guards, same
underlying check: never let the system reach zero `role='administrator' AND is_active=1` rows.
This does **not** prevent an administrator from editing/suspending/deleting themselves via the
*self-delete* path — that's still blocked outright regardless of how many other admins exist
(existing behaviour, unchanged).

### 7.2 Duplicate / colliding emails

- **Pre-existing data**: before §3's `CREATE UNIQUE INDEX` runs, query for collisions:
  `SELECT email, COUNT(*) c FROM admins GROUP BY LOWER(email) HAVING c > 1` (also check for
  blank/NULL emails — every account needs one once email *is* the login). Resolve manually
  before deploying; the index creation logs and no-ops on failure rather than crashing the app,
  so a missed pre-check fails silently, not loudly — don't skip it.
- **New collisions at write time**: both `POST` and `PUT` catch `UNIQUE` constraint errors and
  return a friendly 400 rather than a raw SQL error (§5.2, §5.3).
- **Case sensitivity**: all emails are lowercased at every write site (`POST`, `PUT`, login) so
  the unique index — and login lookups — behave case-insensitively without needing
  `COLLATE NOCASE`.

### 7.3 Suspending a user who's currently logged in

Handled by the `requireAdmin` DB check in §4.2 — their very next API call gets a 403 and their
session is destroyed server-side. There is a small window (their current in-flight request)
where the old session is still valid; this is an accepted, standard limitation, not a gap to
close in this prompt.

### 7.4 Blank optional fields

`full_name` and `phone` are optional. Blank input stores `NULL`, not an empty string (cleaner
for `is_active`-style `IS NULL` checks and avoids ugly empty rendering — see §8.2's display
fallback to the email local-part when `full_name` is absent).

### 7.5 Self-row in the Manage Users grid

The existing precedent (Delete hidden for `isSelf`) extends to Edit: **neither Edit nor Delete
renders on the logged-in user's own card.** Self-service email/name/password changes stay on
the My Profile / Change Password panels, which already correctly hit this same `PUT` route with
`id === self` and correctly still require `currentPassword`. This sidesteps any "can an admin
demote or suspend themselves from the grid" ambiguity entirely — they simply can't reach that
path from here.

### 7.6 Editing your own role/status indirectly

Not reachable per §7.5 — no decision needed.

---

## 8. Task E — Frontend: login form → email-based (`admin.html`)

### 8.1 Markup (`#adminLoginForm`, ~L3961–3972)

```html
<div class="tm-form-group">
    <label class="tm-form-label" for="adminEmail">Email Address</label>
    <input
        class="tm-form-input"
        type="email"
        id="adminEmail"
        name="email"
        placeholder="you@example.com"
        autocomplete="username"
        required>
</div><br>
```

(`autocomplete="username"` is intentionally kept — it's the correct WHATWG token for the
generic login-identifier field even when its value is an email; browsers and password managers
key off it, not off the field's `type`.)

### 8.2 JS (~L15977–16032) — three call sites to update together

```js
// Pre-fill saved email on page load
(function() {
    var saved = localStorage.getItem('admin_saved_email');
    if (saved) {
        var eField = document.getElementById('adminEmail');
        var cb = document.getElementById('rememberMe');
        if (eField) eField.value = saved;
        if (cb) cb.checked = true;
    }
})();
```

```js
body: JSON.stringify({
    email: document.getElementById('adminEmail').value.trim().toLowerCase(),
    password: document.getElementById('adminPassword').value,
    remember_me: rememberMe
})
```

```js
if (rememberMe) {
    localStorage.setItem('admin_saved_email', document.getElementById('adminEmail').value.trim().toLowerCase());
} else {
    localStorage.removeItem('admin_saved_email');
}
```

Update the two error-path messages elsewhere on this screen that say "Username and password are
required." → "Email and password are required." for consistency with the new backend message.

---

## 9. Task F — Frontend: Manage Users module rebuild (`admin.html`)

### 9.1 Unified Add/Edit drawer

Repurpose the existing `#umAddUserDrawer` to serve both create and edit, toggled by a hidden
`#umDrawerUserId` field (empty = create mode). Add Full Name, Phone (intl-tel-input, mirroring
the `#managerCell` pattern at ~L10021), Role (`<select class="um-input">` — already styled, see
§1.3), and Status toggle:

```html
<div class="um-drawer" id="umAddUserDrawer" aria-hidden="true">
  <div class="um-drawer__inner">
    <div class="um-drawer__header">
      <h5 id="umDrawerTitle"><i class="fa-solid fa-user-plus"></i> Create New Admin Account</h5>
      <button class="um-drawer__close" id="umDrawerClose" aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
    </div>
    <form id="umAddUserForm" class="um-form" autocomplete="off">
      <input type="hidden" id="umDrawerUserId" value="">
      <div class="um-form-grid">
        <div class="um-field-group">
          <label class="um-label" for="umNewUserEmail">Email Address</label>
          <div class="um-input-wrap">
            <i class="fa-regular fa-envelope um-input-icon"></i>
            <input type="email" class="um-input" id="umNewUserEmail" placeholder="admin@example.com" required autocomplete="off">
          </div>
        </div>
        <div class="um-field-group">
          <label class="um-label" for="umNewUserFullName">Full Name</label>
          <div class="um-input-wrap">
            <i class="fa-regular fa-id-card um-input-icon"></i>
            <input type="text" class="um-input" id="umNewUserFullName" placeholder="Optional" autocomplete="off">
          </div>
        </div>
        <div class="um-field-group">
          <label class="um-label" for="umNewUserPhone">Phone</label>
          <div class="um-input-wrap">
            <input type="tel" class="um-input" id="umNewUserPhone" placeholder="Optional">
          </div>
        </div>
        <div class="um-field-group">
          <label class="um-label" for="umNewUserRole">Role</label>
          <div class="um-input-wrap">
            <i class="fa-solid fa-shield-halved um-input-icon"></i>
            <select class="um-input" id="umNewUserRole">
              <option value="assistant">Assistant</option>
              <option value="manager" selected>Manager</option>
              <option value="administrator">Administrator</option>
            </select>
          </div>
        </div>
        <div class="um-field-group" id="umNewUserStatusGroup" style="display:none;">
          <label class="um-label" for="umNewUserStatus">Status</label>
          <div class="um-input-wrap">
            <select class="um-input" id="umNewUserStatus">
              <option value="1" selected>Active</option>
              <option value="0">Suspended</option>
            </select>
          </div>
        </div>
        <div class="um-field-group" id="umNewUserPwdGroup">
          <label class="um-label" for="umNewUserPwd"><span id="umPwdLabelText">Password</span></label>
          <div class="um-input-wrap">
            <i class="fa-solid fa-lock um-input-icon"></i>
            <input type="password" class="um-input" id="umNewUserPwd" placeholder="Minimum 8 characters" autocomplete="new-password">
            <button type="button" class="um-eye-btn" data-target="umNewUserPwd" aria-label="Toggle visibility"><i class="fa-regular fa-eye"></i></button>
          </div>
        </div>
      </div>
      <div class="um-form-actions">
        <button type="submit" class="atl-btn atl-btn--primary" id="umAddUserSubmit"><i class="fa-solid fa-user-plus"></i> Create Account</button>
        <button type="button" class="atl-btn atl-btn--ghost" id="umAddUserCancel">Cancel</button>
      </div>
      <div class="um-feedback" id="umAddUserFeedback" role="status" aria-live="polite"></div>
    </form>
  </div>
</div>
```

**Edit mode** (triggered by a new "Edit" button per non-self card, §9.2): set
`#umDrawerUserId`, populate all fields from `allUsersCache`, change the header title to "Edit
Admin Account", reveal `#umNewUserStatusGroup`, change the password field's label to "New
Password (leave blank to keep current)" and drop its `required`. **Create mode** keeps the
password field required and the status group hidden (new accounts are always created Active —
matches Task C §5.2's hardcoded `is_active = 1`).

`initManageUsers()`'s submit handler branches on whether `#umDrawerUserId` has a value: empty →
`POST /api/admin/users`; populated → `PUT /api/admin/users/{id}`. Initialize intl-tel-input on
`#umNewUserPhone` exactly per the `#managerCell` pattern (admin.html ~L10021); read its value
via `.getNumber()` on submit, set via `.setNumber()` when entering edit mode.

### 9.2 Card template — `renderUserCards()` (admin.html ~L19204)

Add a role badge (reusing the dormant `.um-user-role` class, §1.3), a status badge, full-name
display, and an Edit button alongside the existing Delete flow:

```js
return '<div class="um-user-card" data-user-id="' + esc(u.id) + '" data-username="' + esc(u.username) + '" data-email="' + esc(u.email) + '">' +
    '<div class="um-user-card__top">' +
        '<div class="um-avatar-sm">' + initial(u.full_name || u.username) + '</div>' +
        '<div style="flex:1;min-width:0;">' +
            '<p class="um-user-card__name">' + esc(u.full_name || u.username) + '</p>' +
            '<p class="um-user-card__email">' + esc(u.email || '—') + '</p>' +
        '</div>' +
        '<span class="um-user-role um-role-badge um-role-badge--' + esc(u.role || 'manager') + '">' + esc((u.role || 'manager')) + '</span>' +
    '</div>' +
    '<div class="um-user-card__meta">' +
        '<span class="um-user-card__joined"><i class="fa-regular fa-calendar" style="margin-right:4px;"></i>' + fmtDate(u.created_at) + '</span>' +
        '<span class="um-status-badge um-status-badge--' + (u.is_active === 0 ? 'suspended' : 'active') + '">' + (u.is_active === 0 ? 'Suspended' : 'Active') + '</span>' +
        (isSelf ? '<span class="um-user-card__badge um-user-card__badge--you">You</span>' : '') +
    '</div>' +
    '<div class="um-user-card__actions">' +
        (!isSelf
            ? '<button class="um-btn um-btn--ghost um-btn--sm um-edit-btn" data-id="' + esc(u.id) + '"><i class="fa-solid fa-pen"></i> Edit</button>' +
              '<button class="um-btn um-btn--danger um-btn--sm um-del-btn" data-id="' + esc(u.id) + '" data-name="' + esc(u.email) + '"><i class="fa-solid fa-trash-can"></i> Delete</button>' +
              '<div class="um-user-card__confirm" id="umConfirm-' + esc(u.id) + '">' +
                  '<span>Confirm delete?</span>' +
                  '<button class="um-btn um-btn--danger-solid um-btn--sm um-confirm-del-btn" data-id="' + esc(u.id) + '">Yes, Delete</button>' +
                  '<button class="um-btn um-btn--ghost um-btn--sm um-cancel-del-btn" data-id="' + esc(u.id) + '">Cancel</button>' +
              '</div>'
            : '<span style="font-size:11px;color:var(--atl-muted);">Use My Profile to edit your own account.</span>'
        ) +
    '</div>' +
'</div>';
```

Wire `.um-edit-btn` click → open the drawer in edit mode (§9.1). `data-id`/`data-name` on the
delete button already flow into the existing confirm/cancel/confirm-delete handlers unchanged.

### 9.3 New CSS — card sub-elements (currently undefined, §1.3) + badges

Add near the existing `.um-user-card` / `.um-avatar-xl` rules (~L3202–3248):

```css
.um-avatar-sm {
    width: 36px; height: 36px; border-radius: var(--atl-r-pill);
    background: var(--atl-amber-dim) !important; border: 1px solid var(--atl-amber-border) !important;
    color: var(--atl-amber) !important; font-family: 'Outfit', sans-serif; font-weight: 700;
    display: flex; align-items: center; justify-content: center; flex-shrink: 0;
}
.um-user-card__top { display: flex; align-items: center; gap: 10px; }
.um-user-card__name { font-family: 'Outfit', sans-serif; color: var(--atl-ink); margin: 0; font-weight: 600; }
.um-user-card__email { font-family: 'JetBrains Mono', monospace; font-size: 11px; color: var(--atl-muted); margin: 0; }
.um-user-card__meta { display: flex; align-items: center; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
.um-user-card__joined { font-family: 'JetBrains Mono', monospace; font-size: 10px; color: var(--atl-muted-dim); }
.um-user-card__badge { font-size: 10px; padding: 2px 8px; border-radius: var(--atl-r-pill); background: var(--atl-surface2); color: var(--atl-muted); }
.um-user-card__badge--you { background: var(--atl-amber-dim); color: var(--atl-amber); border: 1px solid var(--atl-amber-border); }
.um-user-card__actions { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; align-items: center; }
.um-user-card__confirm { display: none; align-items: center; gap: 6px; font-size: 12px; color: var(--atl-muted); }
.um-user-card__confirm.visible { display: flex; }

.um-role-badge { font-family: 'JetBrains Mono', monospace !important; font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; padding: 3px 9px; border-radius: var(--atl-r-pill); border: 1px solid transparent; flex-shrink: 0; }
.um-role-badge--administrator { color: var(--atl-amber); background: var(--atl-amber-dim); border-color: var(--atl-amber-border); }
.um-role-badge--manager       { color: var(--atl-blue);  background: rgba(96,165,250,0.12);  border-color: rgba(96,165,250,0.25); }
.um-role-badge--assistant     { color: var(--atl-muted); background: var(--atl-surface2);     border-color: var(--atl-line); }

.um-status-badge { font-size: 10px; padding: 2px 8px; border-radius: var(--atl-r-pill); }
.um-status-badge--active    { color: var(--atl-sage); background: rgba(74,222,128,0.10); }
.um-status-badge--suspended { color: var(--atl-clay); background: rgba(248,113,113,0.10); }
```

---

## 10. Task G — Frontend: My Profile panel + header chip fixes

### 10.1 Dynamic role label (replace L4789's hardcoded text)

```html
<span class="um-profile-hero__role" id="umMyRoleLabel"><i class="fa-solid fa-shield-halved"></i> <span id="umMyRoleText">—</span></span>
```

In `initProfile()`'s session-load callback (~L18911), set
`qs('#umMyRoleText').textContent = data.role.charAt(0).toUpperCase() + data.role.slice(1)`
(`'administrator'` → `"Administrator"`, etc.).

### 10.2 Header chip live-refresh bug (Bug 1, §1.5)

In `umProfileForm`'s submit success handler (~L18978), replace the broken
`qs('#adm-profile-name')` block with a call to the already-correct, already-existing function:

```js
if (typeof updateProfileDisplay === 'function') updateProfileDisplay();
```

(`updateProfileDisplay()` at L17461 already correctly targets `#admProfileName` and
`.adm-avatar` — just wasn't being invoked from this success path.)

### 10.3 My Profile form — add full name / phone (optional, low-risk, consistent with §2.2)

Extend `#umProfileForm` with the same Full Name / Phone fields as the Add/Edit drawer (§9.1),
submitting them alongside `email` to the same `PUT /api/admin/users/:id` self-edit path.

---

## 11. Hard constraints (non-negotiable)

- **Do not rename or remove the `username` column.** Decision §2.1 keeps it; it is silently
  auto-synced to email server-side. No form anywhere should expose a manually-editable
  "Username" field anymore — email *is* the identifier now.
- **Do not change the role string values.** `'administrator' | 'manager' | 'assistant'` are
  used verbatim in ~40 already-gated routes and in `applyRoleGating()` / `switchTab()` on the
  frontend — any typo or casing change silently breaks existing access control.
- **Do not touch `requireRole`, `applyRoleGating()`, `switchTab()`'s restriction arrays, or the
  sidebar hide/show logic.** Independently verified correct; out of scope.
- **Do not touch booking pipeline, finance, invoice, or quote logic** in `server.js`, or any
  admin section other than `#usersAdmin`, the login screen, and the header profile chip in
  `admin.html`.
- **Preserve every existing JS-bound ID** referenced throughout: `adminLoginForm`,
  `loginBtn`, `loginError`, `rememberMe`, `umProfileForm`, `umMyUserId`, `umMyEmail`,
  `umMyDisplayName`, `umMyAvatarHero`, `umMyJoinDate`, `umPasswordForm`, `umCurrentPwd`,
  `umNewPwd`, `umConfirmPwd`, `umAddUserToggle`, `umAddUserDrawer`, `umDrawerClose`,
  `umAddUserForm`, `umAddUserCancel`, `umUserSearch`, `umUsersGrid`, `umUserCount`,
  `admProfileName`, `admProfileCardName`. Add new IDs; don't repurpose existing ones for
  different meanings.
- **`#umMyUsername` is removed from the My Profile form markup** (Decision §2.1 — no manual
  username editing) — but the *backend* `username` column stays. Don't confuse "remove the
  input field" with "remove the column."
- **No new hardcoded hex.** Every colour in §9.3's new CSS routes through an existing `--atl-*`
  token, consistent with the rest of the file.
- **`CREATE UNIQUE INDEX` must not run against unvetted data** — §6.1's pre-flight duplicate
  check is a precondition, not optional cleanup.
- **Don't generalize the password-reset-without-currentPassword path** beyond
  administrator-edits-other-user (§5.3). Self-service password changes (My Profile,
  `isEditingSelf === true`) must keep requiring `currentPassword`, no exceptions.

---

## 12. Acceptance criteria

- [ ] Login authenticates by email; `username`/email login no longer accepted as separate
      concepts — they're the same value.
- [ ] Two admins cannot share an email; attempting to creates/edits into a colliding email
      returns a friendly 400, not a raw SQL error or a silent overwrite.
- [ ] Creating a user via the Manage Users panel lets you set role, full name, and phone; new
      accounts default to Active and force a password change on first login.
- [ ] Existing users can be edited (email, full name, phone, role, status, optionally password)
      via a new Edit button — except your own card, which still routes to My Profile.
- [ ] An administrator can reset another user's password without knowing their old one;
      self-service password change still requires the current password.
- [ ] Suspending a user (a) blocks their next login and (b) invalidates their current session on
      their very next request.
- [ ] The system refuses to leave itself with zero active administrators via demote, suspend,
      or delete — each independently tested.
- [ ] Role badge (gold/blue/muted by role) and status badge (sage/clay) render correctly on
      every user card; previously-unstyled card sub-elements now have real layout/spacing.
- [ ] My Profile's role label reflects the actual logged-in user's role, not a hardcoded string.
- [ ] Header profile name updates immediately after a profile save (no reload required).
- [ ] All 12 attribution sites in §1.5/§6 log the real acting admin's email, not the literal
      string `'admin'`; verified by checking `audit_log.changed_by` /
      `financial_audit_log.changed_by` after performing each action as a non-`admin` user.
- [ ] `applyRoleGating()`, `switchTab()`, and all existing `requireRole(...)` gates behave
      identically to before this prompt — zero regression in access control.

---

## 13. Test matrix

**Normal flow**
- Log in with email/password → dashboard loads; role-correct sidebar.
- Administrator creates a manager account with full name + phone → appears in grid with correct
  badges → new user logs in with temp password → forced to change it.
- Administrator edits another user's role from manager → assistant → their next request is
  correctly re-gated (Finance disappears for them).
- Administrator resets another user's password (no currentPassword) → that user can log in with
  the new password immediately.

**Edge cases**
- Suspend a user who's actively browsing the admin panel → their next click gets a 403 and they're
  bounced to login.
- Attempt to create a second account with an email that already exists → friendly error, no new
  row.
- Attempt to demote/suspend/delete the *only* active administrator → blocked with a clear
  message, in all three paths independently.
- Submit the Add User form with mixed-case email (`Foo@Example.com`) → stored lowercase; login
  with any casing succeeds.
- Leave Full Name and Phone blank on create → card displays the email's local part, no layout
  break.

**Failure cases**
- `CREATE UNIQUE INDEX` run against data with an existing duplicate email (pre-migration) →
  confirm it's caught by §7.2's pre-flight query *before* this ships, not discovered via a
  silent index-creation failure in production.
- Database error mid-update (simulate) → user-facing 500 with no partial write (existing
  per-route error handling preserved).

**Regression**
- Every previously-working `requireRole`-gated route still returns 403 for the wrong role and
  200 for the right one (spot-check one route per role tier).
- Self-delete is still blocked exactly as before.
- Existing self-service My Profile / Change Password panels still work end-to-end with
  `currentPassword` required.
- The 12 fixed attribution sites still perform their primary function (contract sign, invoice
  void, expense log, etc.) — only the `changed_by` value should differ, nothing else.

---

## 14. Suggested order of work

1. **§6 pre-flight** — query live `admins` for duplicate/blank emails; resolve manually.
2. **Task A** (database.js) — run the migration; confirm `role`/`full_name`/`phone`/`is_active`/
   `last_login_at` exist and the unique index applied cleanly.
3. **Task B** (login/session/suspension) — get email-based auth working end-to-end before
   touching the UI that depends on it.
4. **Task C** (CRUD) — create/edit/delete with all new fields and the last-administrator guards.
5. **Task D** (attribution fix) — mechanical, low-risk, do in one pass across all 12 sites.
6. **Task E** (login form) — switch the UI to match Task B.
7. **Task F** (Manage Users rebuild) — drawer, cards, CSS.
8. **Task G** (My Profile + header chip) — smallest, do last.
9. Full §12/§13 pass.

> Deliver a short change log: migration applied cleanly Y/N (and what the pre-flight check
> found), final field list confirmed against live schema, and confirmation each of the 12
> attribution sites now logs a real email in a manual smoke test.
