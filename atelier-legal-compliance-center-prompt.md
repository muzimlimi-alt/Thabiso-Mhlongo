# Atelier — Legal & Compliance Management Center
## Agent Prompt: Redesign `#policiesAdmin` into a Full Legal Centre

**Target files:** `admin.html`, `server.js`, `database.js`
**Prompt version:** 1.0
**Prerequisites:** None — this prompt is self-contained.

---

## ⚠️ PRE-FLIGHT: CRITICAL DIVERGENCES FROM BRIEF

Before writing a single line of code, the agent MUST acknowledge and resolve the following gaps between the brief and the live codebase. These are not cosmetic — they affect database design, API scope, and what is realistically deliverable.

### Divergence 1 — `#cookieChoicesModal` does not exist
The brief states `#cookieChoicesModal` exists in the public site. **It does not.** The cookie system in `index.html` is a single custom vanilla JS modal (`#cookieModal`) with inline toggle switches for analytics/marketing/embeds. There is no separate choices modal ID anywhere in either file. The Cookie & Consent tab must reflect the actual implementation, not the described one.

### Divergence 2 — `consent_audit` is missing fields the brief assumes
The brief states `consent_audit` records Consent Type and Policy Version. **The actual table schema is:**
```sql
consent_audit (id, booking_id, ip_address, user_agent, consented_at)
```
It has no `consent_type`, no `policy_version`, no `email` or `name` field. It is also **only written to during the booking submission flow** — newsletter and contact form POPIA consents are written inline to `newsletter_subscribers.popia_consent` and `inquiries.popia_consent` respectively, not to `consent_audit` at all. The Consent Audit Centre must work with the actual data that exists, and the schema extension decision is a Decision Gate.

### Divergence 3 — No contract template system exists
The brief describes a "Booking Contract Templates" CMS. **What actually exists** is a booking-specific PDF upload/mark-as-signed workflow stored in the `contracts` table (one row per booking). There is no template engine, no placeholder substitution (`{{client_name}}` etc.), no `contract_templates` table. The Contract Registry tab in this prompt is limited to reading and displaying existing signed/draft contracts from the `contracts` table. Template generation is a separate future prompt.

### Divergence 4 — "Digital Signature Workflow" is PDF upload only
The brief describes digital signature capture, signature placement, and verification. **What actually exists** is: an admin uploads a pre-signed PDF → admin marks a `contracts` row as `status='signed'` with a signatory name. There is no client-facing e-signature capture, no canvas/pad, no cryptographic verification. The Digital Signatures tab is therefore scoped to a **Signature Audit Log** (reading the `contracts` table for signed rows), not a signatures management system.

### Divergence 5 — No RBAC role column exists on `admins` table
The brief prescribes Administrator/Manager/Assistant role gating. **The `admins` table has no `role` or `role_level` column.** The `requireAdmin` middleware is purely binary (session exists / doesn't exist). Until the RBAC prompt is executed, backend role checks cannot be enforced. See Decision Gate 4.

### Divergence 6 — `policy_version` is a hardcoded string
The booking submission route in `server.js` writes `policy_version: 'v2.2'` as a hardcoded literal. Newsletter subscription does the same. There is no CMS or database value driving this. See Decision Gate 5.

### Divergence 7 — Scope reduction from 11 tabs to 8
An 11-tab UI in one single-file codebase addition is unsustainable. Tabs deferred to a separate future prompt:
- **Contract Templates** (requires new template engine, placeholder substitution, and a `contract_templates` table — distinct from booking contracts)
- **Compliance Scorecard** (requires aggregate metrics not yet collected)

The 8 tabs implemented by this prompt are enumerated in Section 3.

---

## 1. FULL-STACK IMPACT ANALYSIS

| Layer | Component | Change Type | Risk |
|---|---|---|---|
| **DB** | `policies` table | Read/Write (existing, unchanged schema) | Low |
| **DB** | `legal_documents` (new) | CREATE TABLE | Low |
| **DB** | `legal_document_versions` (new) | CREATE TABLE | Low |
| **DB** | `consent_audit` | ALTER TABLE — add 3 columns | Medium (existing rows get NULLs) |
| **Backend** | `GET/PUT /api/admin/policies` | Unchanged — preserved as-is | None |
| **Backend** | 5 × `/api/admin/bookings/:id/contract*` | Unchanged — preserved as-is | None |
| **Backend** | `/api/admin/legal/*` | 9 new routes (all new namespace) | Low |
| **Frontend** | `#policiesAdmin` HTML | Full replacement with tab shell | Medium |
| **Frontend** | `loadPolicies()`, `savePolicies()`, `triggerReminderJob()` | Moved into Tab 6 panel — function bodies unchanged | Medium |
| **Frontend** | `polDeposit`, `polQuoteValidity`, `polPaymentTerms`, `polCancellation`, `polReminderDays1`, `polReminderDays2` | Preserved with identical IDs — only moved into new panel | Medium |
| **Frontend** | `#privacyModalAdmin`, `#termsModalAdmin` | Preserved in place — static modals remain | None |
| **Frontend** | `$('a[href="#policiesAdmin"]').on('shown.bs.tab')` | Triggers `loadPolicies()` → now also triggers `loadLegalOverview()` | Low |
| **Frontend** | New Quill instances | 2 new instances (`#legalPrivacyEditor`, `#legalTermsEditor`) | Medium |
| **Frontend** | Tab system (`initTabs()`) | No change to function — new `.atl-tab-btn`/`.um-panel` elements auto-register | None |

**Blast radius note:** All new JS functions MUST live inside the existing `$(document).ready()` closure. No global scope pollution. No modification of any function outside `#policiesAdmin`'s own handler block.

---

## 2. DEFECT / GAP INVENTORY

| # | Type | Location | Description |
|---|---|---|---|
| D-01 | Missing feature | `admin.html` | No way to edit Privacy Policy or Terms content — static HTML only |
| D-02 | Missing feature | `admin.html` | No version history for any legal document |
| D-03 | Missing feature | `server.js` | `policy_version` hardcoded as `'v2.2'` — not driven by any CMS |
| D-04 | Missing feature | `admin.html` | No read interface for `consent_audit` records |
| D-05 | Missing feature | `admin.html` | No way to view all `contracts` records across all bookings in one place |
| D-06 | Schema gap | `database.js` | `consent_audit` missing `consent_type`, `policy_version`, `source_email` fields |
| D-07 | UX gap | `admin.html` | `#policiesAdmin` section header says "Booking Policies / Configure deposit…" — will be replaced with Legal Centre header |
| D-08 | Silent failure | `admin.html` | `savePolicies()` has an empty `catch(e) {}` block — errors are swallowed |
| D-09 | Missing feature | `admin.html` | No compliance overview or activity summary for the legal domain |
| D-10 | UX gap | `admin.html` | Cookie consent wording is hardcoded in `index.html` — no admin editing interface |

---

## 3. PROPOSED TAB ARCHITECTURE

The `#policiesAdmin` section becomes **Legal & Compliance** (eyebrow label: `Legal`). Eight tabs replace the single card. The nav link text and icon in the sidebar are NOT changed — only the section content.

| Tab # | Tab ID (data-um-tab) | Panel ID | Title | Backend dependency |
|---|---|---|---|---|
| 1 | `lcOverview` | `lcPanelOverview` | Overview | New `GET /api/admin/legal/overview` |
| 2 | `lcPrivacy` | `lcPanelPrivacy` | Privacy Policy | New legal documents routes |
| 3 | `lcTerms` | `lcPanelTerms` | Terms of Use | New legal documents routes |
| 4 | `lcCookie` | `lcPanelCookie` | Cookie & Consent | New legal documents routes |
| 5 | `lcConsentAudit` | `lcPanelConsentAudit` | Consent Audit | New `GET /api/admin/legal/consent-audit` |
| 6 | `lcBookingPolicies` | `lcPanelBookingPolicies` | Booking Policies | Existing `GET/PUT /api/admin/policies` (unchanged) |
| 7 | `lcContracts` | `lcPanelContracts` | Contract Registry | New `GET /api/admin/legal/contracts` |
| 8 | `lcVersionHistory` | `lcPanelVersionHistory` | Version History | New `GET /api/admin/legal/documents/:type/history` |

---

## 4. DATABASE CHANGES

### 4A. New table — `legal_documents`

```sql
CREATE TABLE IF NOT EXISTS legal_documents (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    document_type       TEXT UNIQUE NOT NULL,
    title               TEXT NOT NULL,
    current_version_id  INTEGER,
    status              TEXT DEFAULT 'draft'
                            CHECK(status IN ('draft','published')),
    last_published_at   DATETIME,
    last_published_by   TEXT,
    created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at          DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

Seed immediately after CREATE:
```sql
INSERT OR IGNORE INTO legal_documents (document_type, title, status)
VALUES
    ('privacy_policy', 'Privacy Policy', 'published'),
    ('terms_of_use',   'Terms of Use',   'published'),
    ('cookie_policy',  'Cookie & Consent Policy', 'published');
```

### 4B. New table — `legal_document_versions`

```sql
CREATE TABLE IF NOT EXISTS legal_document_versions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id     INTEGER NOT NULL,
    version_number  TEXT NOT NULL,
    content_html    TEXT NOT NULL,
    change_summary  TEXT,
    is_published    INTEGER DEFAULT 0,
    published_at    DATETIME,
    published_by    TEXT,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (document_id) REFERENCES legal_documents(id) ON DELETE CASCADE
);
```

After creating this table, seed the initial published versions by reading the static HTML content from the existing `#privacyModalAdmin` and `#termsModalAdmin` modal bodies and inserting them as `version_number = '1.0'`, `is_published = 1`. This preserves existing legal content as the baseline history.

**After seeding version rows**, UPDATE `legal_documents` to set `current_version_id` to the seeded version IDs.

### 4C. ALTER TABLE `consent_audit`

**Decision Gate 2 controls whether this runs.** If confirmed, add three columns:

```sql
ALTER TABLE consent_audit ADD COLUMN consent_type TEXT DEFAULT 'booking';
ALTER TABLE consent_audit ADD COLUMN policy_version TEXT;
ALTER TABLE consent_audit ADD COLUMN source_email TEXT;
```

Existing rows will have `consent_type = 'booking'` by default (accurate), `policy_version = NULL`, `source_email = NULL`. No data loss.

### 4D. No changes to existing tables

The following tables are **read-only** for this prompt — schema must not be altered:
`policies`, `contracts`, `bookings`, `newsletter_subscribers`, `inquiries`, `admins`

---

## 5. API CHANGES (New Routes — `/api/admin/legal/*` namespace)

All new routes use `requireAdmin` middleware. Add immediately after the existing `PUT /api/admin/policies` route (server.js line ~5591).

### Route 1 — GET `/api/admin/legal/overview`
Returns aggregate stats for the Overview tab.

```javascript
app.get('/api/admin/legal/overview', requireAdmin, (req, res) => {
    // Run 4 parallel db queries:
    // 1. COUNT(*) FROM legal_document_versions WHERE is_published = 1  → published_versions
    // 2. SELECT COUNT(*) FROM legal_documents WHERE status = 'published' → active_documents
    // 3. COUNT(*) FROM consent_audit → total_consent_records
    // 4. SELECT COUNT(*) FROM contracts WHERE status = 'signed' → signed_contracts
    // 5. SELECT COUNT(*) FROM contracts WHERE status = 'draft' → draft_contracts
    // 6. SELECT lv.*, ld.document_type, ld.title FROM legal_document_versions lv
    //    JOIN legal_documents ld ON ld.id = lv.document_id
    //    ORDER BY lv.created_at DESC LIMIT 5 → recent_activity
    // Respond: { success, stats: { active_documents, published_versions, total_consent_records,
    //             signed_contracts, draft_contracts }, recent_activity: [...] }
});
```

### Route 2 — GET `/api/admin/legal/documents`
Returns all legal documents with their current version metadata.

```javascript
app.get('/api/admin/legal/documents', requireAdmin, (req, res) => {
    // SELECT ld.*, lv.version_number, lv.content_html, lv.published_at, lv.published_by,
    //        lv.change_summary
    // FROM legal_documents ld
    // LEFT JOIN legal_document_versions lv ON lv.id = ld.current_version_id
    // ORDER BY ld.document_type
    // Respond: { success, documents: [...] }
});
```

### Route 3 — GET `/api/admin/legal/documents/:type`
Returns a single document with its current published content and all versions.

```javascript
app.get('/api/admin/legal/documents/:type', requireAdmin, (req, res) => {
    // 1. SELECT from legal_documents WHERE document_type = req.params.type
    // 2. SELECT all versions for that document_id ordered by created_at DESC
    // Respond: { success, document: { ...doc, versions: [...] } }
    // 404 if type not found
});
```

### Route 4 — POST `/api/admin/legal/documents/:type/draft`
Saves a new draft version. Does NOT publish.

```javascript
app.post('/api/admin/legal/documents/:type/draft', requireAdmin, (req, res) => {
    // Validate: content_html required (non-empty after trim), max 500,000 chars
    // Validate: document_type must exist in legal_documents
    // Compute next version: query MAX(version_number) for this document and increment minor
    //   e.g. if current is '1.3' → new draft is '1.4-draft'
    // INSERT INTO legal_document_versions
    //   (document_id, version_number, content_html, change_summary, is_published)
    //   VALUES (..., ..., req.body.content_html, req.body.change_summary || null, 0)
    // UPDATE legal_documents SET status='draft', updated_at=CURRENT_TIMESTAMP WHERE type=...
    // Audit log entry
    // Respond: { success, version: { id, version_number, created_at } }
});
```

### Route 5 — POST `/api/admin/legal/documents/:type/publish`
Publishes the most recent draft version (or the version_id passed in body).

```javascript
app.post('/api/admin/legal/documents/:type/publish', requireAdmin, (req, res) => {
    // If req.body.version_id provided → use it; else use latest version for this document
    // Validate target version belongs to this document_type
    // UPDATE legal_document_versions SET is_published=1, published_at=CURRENT_TIMESTAMP,
    //   published_by = req.session.username WHERE id = versionId
    // UPDATE legal_documents SET status='published', current_version_id=versionId,
    //   last_published_at=CURRENT_TIMESTAMP, last_published_by=req.session.username
    // Audit log
    // Respond: { success, message: 'Document published.', version_number, published_at }
});
```

### Route 6 — POST `/api/admin/legal/documents/:type/restore/:versionId`
Creates a new draft from a previous version's content (does not publish immediately).

```javascript
app.post('/api/admin/legal/documents/:type/restore/:versionId', requireAdmin, (req, res) => {
    // Fetch old version's content_html; verify it belongs to this document_type
    // Create a new legal_document_versions row with is_published=0
    //   version_number = next increment, content_html = old version's content
    //   change_summary = 'Restored from version X.Y'
    // UPDATE legal_documents SET status='draft'
    // Audit log
    // Respond: { success, message: 'Restored as new draft.', new_version_id }
});
```

### Route 7 — GET `/api/admin/legal/consent-audit`
Paginated consent records from `consent_audit`, joined with booking name/email.

```javascript
app.get('/api/admin/legal/consent-audit', requireAdmin, (req, res) => {
    const page     = Math.max(1, parseInt(req.query.page)  || 1);
    const limit    = Math.min(50, parseInt(req.query.limit) || 20);
    const search   = (req.query.search || '').trim().substring(0, 100);
    const type     = req.query.type || 'all';      // booking | all (future: newsletter, contact)
    const offset   = (page - 1) * limit;

    // Base query: SELECT ca.id, ca.booking_id, ca.ip_address, ca.consented_at,
    //                    ca.consent_type, ca.policy_version, ca.source_email,
    //                    b.name AS booking_name, b.email AS booking_email
    //             FROM consent_audit ca
    //             LEFT JOIN bookings b ON b.id = ca.booking_id
    //             [WHERE search/type filters]
    //             ORDER BY ca.consented_at DESC
    //             LIMIT ? OFFSET ?
    // Run COUNT(*) query for total
    // Respond: { success, records: [...], total, page, limit, pages: Math.ceil(total/limit) }
});
```

### Route 8 — GET `/api/admin/legal/contracts`
All contracts across all bookings — for the Contract Registry tab.

```javascript
app.get('/api/admin/legal/contracts', requireAdmin, (req, res) => {
    const page   = Math.max(1, parseInt(req.query.page) || 1);
    const limit  = Math.min(50, parseInt(req.query.limit) || 20);
    const status = req.query.status || 'all';    // draft | signed | all
    const search = (req.query.search || '').trim().substring(0, 100);
    const offset = (page - 1) * limit;

    // SELECT c.id, c.booking_id, c.template_version, c.status, c.is_frozen,
    //        c.pdf_url, c.uploaded_by, c.signed_by, c.signed_date,
    //        c.sent_to_client_at, c.signed_by_client_at, c.created_at, c.updated_at,
    //        b.name AS client_name, b.email AS client_email,
    //        b.event_name, b.date AS event_date
    // FROM contracts c
    // LEFT JOIN bookings b ON b.id = c.booking_id
    // [WHERE status / search filters]
    // ORDER BY c.updated_at DESC
    // LIMIT ? OFFSET ?
    // Respond: { success, contracts: [...], total, page, limit }
});
```

### Route 9 — GET `/api/admin/legal/documents/:type/history`
Full version history for one document type.

```javascript
app.get('/api/admin/legal/documents/:type/history', requireAdmin, (req, res) => {
    // Verify document_type exists
    // SELECT lv.* FROM legal_document_versions lv
    // JOIN legal_documents ld ON ld.id = lv.document_id
    // WHERE ld.document_type = req.params.type
    // ORDER BY lv.created_at DESC
    // Respond: { success, document_type, versions: [...] }
});
```

---

## 6. NON-NEGOTIABLE CONSTRAINTS

The agent MUST NOT modify, rename, or remove any of the following:

### Preserved HTML element IDs (all must survive with identical IDs)
- `polDeposit` — deposit percentage input
- `polQuoteValidity` — quote validity input
- `polPaymentTerms` — payment terms textarea
- `polCancellation` — cancellation policy textarea
- `polReminderDays1` — first reminder days input
- `polReminderDays2` — final reminder days input

### Preserved JavaScript functions (bodies must be identical, only their call location may change)
- `window.loadPolicies()` — still calls `GET /api/admin/policies`
- `window.savePolicies()` — still calls `PUT /api/admin/policies`; fix the empty `catch(e) {}` to `catch(e) { window.notificationService.showError('Failed to save policies: ' + e.message); }`
- `window.triggerReminderJob()` — still calls `POST /api/admin/reminders/run`

### Preserved API routes (no changes to handler logic, method, or path)
- `GET /api/admin/policies`
- `PUT /api/admin/policies`
- `GET /api/admin/bookings/:id/contract`
- `POST /api/admin/bookings/:id/contract`
- `PUT /api/admin/bookings/:id/contract/sign`
- `GET /api/admin/bookings/:id/contract/download`
- `POST /api/admin/bookings/:id/contract/remind`

### Preserved modals (do not alter, move, or remove)
- `#privacyModalAdmin` (admin.html ~line 15232)
- `#termsModalAdmin` (admin.html ~line 15294)

### Preserved tab system
- `initTabs()` function body is unchanged
- All new tab buttons use `.atl-tab-btn` class with `data-um-tab="<panelId>"`
- All new panels use `.um-panel` class with matching `id="<panelId>"`
- First tab panel has class `um-panel active`

### Preserved section activation
The existing `$('a[href="#policiesAdmin"]').on('shown.bs.tab')` handler at ~line 18460 calls `loadPolicies()`. This must be updated to also call `loadLegalOverview()` — do not remove the `loadPolicies()` call.

---

## 7. DECISION GATES

The agent MUST stop and present these questions before writing any code. Do not unilaterally resolve them.

### Gate 1 — Initial content seeding strategy
The Privacy Policy and Terms of Use currently exist as static HTML inside `#privacyModalAdmin` and `#termsModalAdmin`. When the agent seeds the first `legal_document_versions` row, should it:

**Option A:** Extract the exact HTML from those modal bodies and insert it verbatim as version `1.0` content (preserves exact current wording, but is lengthy)
**Option B:** Insert placeholder content (`<!-- Seeded from static modal — replace via editor -->`) and require the admin to paste/paste their content on first use
**Option C:** Leave `content_html` as NULL for the initial seed and prompt the admin on first tab visit to import from existing modals

*Recommended: Option A — preserves history integrity. Confirm before proceeding.*

### Gate 2 — `consent_audit` schema extension
The `ALTER TABLE` additions (consent_type, policy_version, source_email) are backward-safe (existing rows get NULL/default values). However, the newsletter and contact form POPIA consents are currently NOT written to `consent_audit` — they are only in `newsletter_subscribers.popia_consent` and `inquiries.popia_consent`.

Should the agent:
**Option A:** Only extend the schema now; leave the newsletter/contact form write paths for a future patch
**Option B:** Also patch the newsletter subscription route (`/api/newsletter/subscribe`) and contact form route (`/send-email`) in `server.js` to write consent records to `consent_audit` with `consent_type = 'newsletter'` and `consent_type = 'contact'` respectively

*Option B is the correct long-term approach but touches public-facing routes — confirm before patching.*

### Gate 3 — `policy_version` hardcoding
`server.js` currently hardcodes `policy_version: 'v2.2'` in two places (booking submission ~line 2681, newsletter subscription ~line 4541). Should the agent:

**Option A:** Leave hardcoded values — dynamic lookup is a separate pass
**Option B:** Add a lightweight helper that queries `SELECT version_number FROM legal_document_versions WHERE document_id = (SELECT id FROM legal_documents WHERE document_type='privacy_policy') AND is_published=1 ORDER BY published_at DESC LIMIT 1` and use it in both routes (adds async complexity to synchronous callback routes)

*Recommended: Option A now, tracked as technical debt. Confirm.*

### Gate 4 — RBAC gating (no role column exists)
The brief requires Managers to have read-only access and Assistants to have no access. The `admins` table has no `role` column and the RBAC prompt has not been executed yet.

Until that prompt runs, the agent must choose:
**Option A:** All authenticated users can read and write (current `requireAdmin` behaviour)
**Option B:** Add `role` column to `admins` table now as `TEXT DEFAULT 'administrator'` so the legal routes can add role checks immediately, even if the rest of the system doesn't use them yet
**Option C:** Add UI-level placeholder notices ("Role-based access coming soon") with no backend enforcement

*Recommended: Option B — safe migration, consistent with future RBAC prompt. Confirm.*

### Gate 5 — Quill editor for Cookie & Consent tab
The cookie consent banner wording (`#cookieModal` in `index.html`) is hardcoded in the public site's HTML. Editing it via the admin Quill editor would require:
- Storing the edited content in `legal_documents` as `document_type = 'cookie_policy'`
- The public site reading that content via a new `GET /api/public/legal/cookie-policy` endpoint
- Replacing the static HTML with a dynamic fetch on page load

This is a significant public-site change. Should the agent:
**Option A:** Build the Quill editor for cookie policy wording and wire up the public-site dynamic fetch
**Option B:** Build the Quill editor and save to DB but leave `index.html` static for now (content would be saved but not reflected on the public site until a separate patch)
**Option C:** Replace the Cookie & Consent tab's editor with a read-only display of current wording + a notice that the public site must be manually updated

*Recommended: Option B — editor built, public sync deferred. Confirm.*

---

## 8. PHASED WORK ORDER (Simplest → Highest Risk)

### Phase 1 — Database schema (database.js)
1. Add `CREATE TABLE IF NOT EXISTS legal_documents` with seed INSERT statements (Gate 1 resolution determines seed content)
2. Add `CREATE TABLE IF NOT EXISTS legal_document_versions` with seed INSERT for initial versions
3. If Gate 2 = Option B: `ALTER TABLE consent_audit ADD COLUMN ...` (×3) with error suppression pattern matching existing migrations
4. If Gate 4 = Option B: `ALTER TABLE admins ADD COLUMN role TEXT DEFAULT 'administrator'`
5. After all DDL: UPDATE `legal_documents.current_version_id` to point to seeded version rows

*Verification: Start server, confirm no crash, confirm tables exist via `.tables` in sqlite3 CLI.*

### Phase 2 — Backend routes (server.js)
1. Add all 9 new `GET/POST /api/admin/legal/*` routes after line ~5591 (after existing policies routes)
2. If Gate 2 = Option B: patch `/api/newsletter/subscribe` and `/send-email` to write to `consent_audit`
3. If Gate 4 = Option B: add role-checking helper function above the routes

*Verification: Test each route with curl or Postman. Confirm 200 for happy path, 400 for missing required fields, 404 for unknown document_type.*

### Phase 3 — HTML shell (admin.html — inside `#policiesAdmin`)
Replace the entire `#policiesAdmin` div content (lines 5792–5851) with:
1. Updated section header (eyebrow: "Legal", heading: "Legal & Compliance", sub: "Manage legal documents, consent records, booking policies, and contract history.")
2. `atl-section-rule` divider
3. Tab bar div with 8 `.atl-tab-btn` buttons (first one `.active`)
4. 8 `.um-panel` divs (first one `.active`)
5. All panels initially contain only a skeleton loading state (`<div class="lc-panel-inner"><p class="text-muted">Loading…</p></div>`) — content added per-panel in later phases

*Verification: Open admin, click Policies in sidebar, confirm 8 tab buttons render, clicking tabs switches active states.*

### Phase 4 — Tab 6: Booking Policies (admin.html)
Migrate the existing single card into `#lcPanelBookingPolicies`. This is the lowest-risk tab since the backend is unchanged.
1. Cut the existing card HTML (fields: `polDeposit`, `polQuoteValidity`, `polPaymentTerms`, `polCancellation`, `polReminderDays1`, `polReminderDays2` + Save button + Run Now button)
2. Paste it inside `#lcPanelBookingPolicies` wrapped in a `<div class="lc-panel-inner">`
3. `loadPolicies()` and `savePolicies()` body unchanged — only their trigger location changes
4. Fix `savePolicies()` silent error swallowing (D-08): replace `catch(e) {}` with `catch(e) { window.notificationService.showError('Failed to save policies: ' + e.message); }`

*Verification: Click Booking Policies tab, confirm all 6 inputs load with saved values, edit one, Save, confirm success notification.*

### Phase 5 — Tab 1: Overview (admin.html)
Build the `#lcPanelOverview` content:
1. Stat cards row using `.db-stat-card` pattern: Active Documents (3), Published Versions, Consent Records, Signed Contracts, Draft Contracts
2. Recent Legal Activity list (last 5 version events from `recent_activity` array)
3. Quick Actions row: "Edit Privacy Policy" → activates `lcPrivacy` tab; "Edit Terms" → `lcTerms` tab; "View Consent Audit" → `lcConsentAudit` tab; "View Contracts" → `lcContracts` tab
4. `loadLegalOverview()` function: calls `GET /api/admin/legal/overview`, populates stat values, renders activity list

*Verification: Stat cards show real numbers from DB. Activity list shows version creation timestamps.*

### Phase 6 — Tabs 2, 3, 4: Document Editors (admin.html)
Implement the Privacy Policy (Tab 2), Terms of Use (Tab 3), and Cookie & Consent (Tab 4) panels. All three follow an identical layout pattern:

**Panel layout per document editor:**
```
[ Left column (col-md-8) ]
  Document Status badge (Published / Draft)
  Current version label + last published by/at
  Quill editor wrapper (.atl-quill-wrap) — ID: legalPrivacyEditor / legalTermsEditor / legalCookieEditor
  Change summary input (atl-input, placeholder: "Brief description of changes…")
  Action row:
    [Save as Draft]  [Publish Now]

[ Right column (col-md-4) ]
  Version History mini-list (last 5 versions for this document)
  Each row: version number | published/draft badge | date | [Restore] button
  [View Full History →] link → activates lcVersionHistory tab with filter pre-set
```

**Quill toolbar for all document editors:**
```javascript
const legalDocToolbar = [
    [{ header: [1, 2, 3, false] }],
    ['bold', 'italic', 'underline'],
    [{ list: 'ordered' }, { list: 'bullet' }],
    ['link', 'blockquote'],
    ['clean']
];
```

**JS functions required:**
- `loadLegalDocument(type)` — calls `GET /api/admin/legal/documents/:type`, populates Quill, updates status badge, renders mini version list
- `saveLegalDraft(type)` — calls `POST /api/admin/legal/documents/:type/draft` with `{ content_html: quill.root.innerHTML, change_summary }`
- `publishLegalDocument(type)` — shows `notificationService.showConfirm` → calls `POST /api/admin/legal/documents/:type/publish`
- `restoreLegalVersion(type, versionId)` — shows confirm → calls `POST /api/admin/legal/documents/:type/restore/:versionId`

**Quill instance IDs:**
- Tab 2: `legalPrivacyEditor` (Quill instance: `window.lcPrivacyQuill`)
- Tab 3: `legalTermsEditor` (Quill instance: `window.lcTermsQuill`)
- Tab 4: `legalCookieEditor` (Quill instance: `window.lcCookieQuill`)

Lazy-initialise each Quill instance only when its tab is first activated (to avoid three simultaneous Quill mounts on section load). Use a flag per editor: `window.lcPrivacyQuillInit`, etc.

*Verification: Click Privacy Policy tab → Quill loads with current content → Edit text → Save Draft → version row appears in mini-list → Publish → status badge changes to "Published".*

### Phase 7 — Tab 5: Consent Audit Centre (admin.html)
Build `#lcPanelConsentAudit`:

**Layout:**
```
Search bar (lc-consent-search) | Type filter (lc-consent-type: All/Booking) | Per-page select
[ Table ]
  #  | Date/Time | Source | Name/Email | IP Address | Consent Type | Policy Version
[ Pagination: Prev | Page X of Y | Next ]
[ Export CSV button ]
```

**Table element IDs:**
- `lcConsentTable` — `<tbody>` for rows
- `lcConsentEmpty` — empty state div
- `lcConsentPrev`, `lcConsentNext` — pagination buttons
- `lcConsentPageInfo` — "Page X of Y" span

**JS functions required:**
- `loadConsentAudit(resetPage)` — calls `GET /api/admin/legal/consent-audit?page=&limit=&search=&type=`, renders rows or empty state
- `exportConsentCsv()` — calls same endpoint with `limit=10000`, converts JSON array to CSV, triggers download via Blob URL

**Table row template:**
```javascript
`<tr>
  <td>${record.id}</td>
  <td>${formatDate(record.consented_at)}</td>
  <td><span class="atl-badge atl-badge--info">Booking</span></td>
  <td>${record.booking_name || '—'}<br><small style="color:var(--atl-muted)">${record.booking_email || '—'}</small></td>
  <td style="font-family:var(--atl-mono);font-size:11px">${record.ip_address || '—'}</td>
  <td>${record.consent_type || 'booking'}</td>
  <td>${record.policy_version || '—'}</td>
</tr>`
```

*Verification: Tab opens → table shows rows from consent_audit → Search filters → Export generates valid CSV.*

### Phase 8 — Tab 7: Contract Registry (admin.html)
Build `#lcPanelContracts`:

**Layout:**
```
Search bar (lc-contract-search) | Status filter (all/draft/signed) | per-page select
[ Table ]
  ID | Client | Event | Event Date | Contract Status | Template Version | Signed By | Signed Date | Actions
[ Pagination ]
```

**Table element IDs:**
- `lcContractsTbody`, `lcContractsEmpty`, `lcContractsPrev`, `lcContractsNext`, `lcContractsPageInfo`

**Status badge mapping:**
- `draft` → `.atl-badge atl-badge--pending`
- `signed` → `.atl-badge atl-badge--confirmed`

**Actions column:** Single `[View Booking]` button per row that calls `switchTab('bookingsAdmin')` and opens the booking detail card for that `booking_id`.

**JS function:** `loadLegalContracts(resetPage)` — calls `GET /api/admin/legal/contracts?page=&status=&search=`.

*Verification: Tab shows all contracts across all bookings. Status filter works. "View Booking" navigates to correct booking.*

### Phase 9 — Tab 8: Version History (admin.html)
Build `#lcPanelVersionHistory`:

**Layout:**
```
Document type filter (all/privacy_policy/terms_of_use/cookie_policy) | Search bar
[ Chronological list — newest first ]
  Each row:
    [Document type icon]  Privacy Policy — v1.3  [Published badge / Draft badge]
    Published by: admin  |  Date: 2026-03-31  |  "Initial seeded version"
    [Preview]  [Restore as Draft]
```

**JS function:** `loadLegalVersionHistory(resetPage)` — for each doc type, calls `GET /api/admin/legal/documents/:type/history`, merges results, sorts by `created_at` DESC. If "all" selected, run 3 calls in parallel via `Promise.all`.

**Preview:** Clicking [Preview] opens `#privacyModalAdmin` (if privacy_policy), `#termsModalAdmin` (if terms_of_use), or a generic `#lcPreviewModal` for cookie policy — with the version's `content_html` injected into the modal body before opening.

**`#lcPreviewModal`** — add a new minimal modal at the bottom of admin.html (before the closing `</body>`):
```html
<div class="modal fade" id="lcPreviewModal" tabindex="-1" role="dialog">
  <div class="modal-dialog modal-lg" role="document">
    <div class="modal-content" style="background:var(--atl-paper);color:var(--atl-ink-dim);border:1px solid var(--atl-line);">
      <div class="modal-header" style="background:var(--atl-topbar-bg);border-bottom:1px solid var(--atl-amber-border);padding:18px 24px;">
        <h4 class="modal-title" id="lcPreviewModalTitle" style="color:var(--atl-ink);font-weight:600;"></h4>
        <button type="button" class="close" data-dismiss="modal"><svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg></button>
      </div>
      <div class="modal-body" id="lcPreviewModalBody" style="max-height:65vh;overflow-y:auto;padding:28px 30px;"></div>
      <div class="modal-footer" style="border-top:1px solid var(--atl-line);padding:14px 24px;">
        <button type="button" class="atl-btn atl-btn--primary" data-dismiss="modal">Close</button>
      </div>
    </div>
  </div>
</div>
```

*Verification: History tab shows all versions across all document types. Filter by type works. Preview opens modal with correct HTML content.*

---

## 9. SHARED FOUNDATION

### New CSS classes (add to the `<style>` block inside `admin.html`, scoped to `#policiesAdmin`)

```css
/* Legal Centre panel wrapper */
#policiesAdmin .lc-panel-inner {
    padding: 24px 0;
}

/* Document status badge */
.lc-doc-status {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 12px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.5px;
    text-transform: uppercase;
}
.lc-doc-status--published {
    background: rgba(52,211,153,0.12);
    color: #34d399;
    border: 1px solid rgba(52,211,153,0.2);
}
.lc-doc-status--draft {
    background: rgba(212,175,55,0.12);
    color: var(--atl-amber);
    border: 1px solid var(--atl-amber-border);
}

/* Version history mini-list item */
.lc-version-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    border-radius: 6px;
    border: 1px solid var(--atl-line);
    background: var(--atl-surface2);
    margin-bottom: 6px;
    gap: 8px;
}
.lc-version-item:last-child { margin-bottom: 0; }
.lc-version-num {
    font-family: var(--atl-mono);
    font-size: 12px;
    color: var(--atl-amber);
    font-weight: 700;
    flex-shrink: 0;
}
.lc-version-meta {
    flex: 1;
    min-width: 0;
    font-size: 11px;
    color: var(--atl-muted);
}

/* Overview quick-actions bar */
.lc-quick-actions {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    margin-top: 20px;
}

/* Consent/Contract table wrapper */
.lc-table-wrap {
    overflow-x: auto;
    border-radius: 8px;
    border: 1px solid var(--atl-line);
}
.lc-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
}
.lc-table th {
    padding: 10px 14px;
    text-align: left;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.6px;
    text-transform: uppercase;
    color: var(--atl-muted);
    background: var(--atl-surface2);
    border-bottom: 1px solid var(--atl-line);
    white-space: nowrap;
}
.lc-table td {
    padding: 10px 14px;
    border-bottom: 1px solid var(--atl-line);
    color: var(--atl-ink-dim);
    vertical-align: middle;
}
.lc-table tbody tr:hover { background: var(--atl-paper-hover, rgba(255,255,255,0.02)); }
.lc-table tbody tr:last-child td { border-bottom: none; }
```

### Light-mode overrides (add inside the existing `.admin-light-mode` CSS block)
```css
.admin-light-mode .lc-version-item {
    background: var(--atl-surface2);
    border-color: var(--atl-line);
}
.admin-light-mode .lc-table th { background: #f5f5f5; }
.admin-light-mode .lc-table td { color: var(--atl-ink-dim); }
```

### Utility function — `formatDate(dateStr)`
If not already defined in the admin.html JS scope, add:
```javascript
function formatDate(dateStr) {
    if (!dateStr) return '—';
    const d = new Date(dateStr);
    return isNaN(d.getTime()) ? dateStr :
        d.toLocaleDateString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric' }) +
        ' ' + d.toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' });
}
```
Check `grep -n "function formatDate"` before adding — if it already exists, skip.

---

## 10. ACCEPTANCE CRITERIA

- [ ] `#policiesAdmin` section renders with 8 tab buttons; all tab switches work without page reload
- [ ] Tab 6 (Booking Policies) contains all 6 original inputs (`polDeposit`, `polQuoteValidity`, `polPaymentTerms`, `polCancellation`, `polReminderDays1`, `polReminderDays2`), Save button, and Run Now button — all functional
- [ ] `GET/PUT /api/admin/policies` respond correctly (unchanged)
- [ ] All 5 existing `/api/admin/bookings/:id/contract*` routes respond correctly (unchanged)
- [ ] `#privacyModalAdmin` and `#termsModalAdmin` still open correctly from wherever they're referenced
- [ ] Tab 1 (Overview) stat cards populate with real counts from DB
- [ ] Tab 2 (Privacy Policy) Quill editor loads current published content; Save Draft creates a new `legal_document_versions` row with `is_published=0`; Publish sets `is_published=1` and updates `legal_documents.current_version_id`
- [ ] Tab 3 (Terms of Use) — same as Tab 2 for `document_type='terms_of_use'`
- [ ] Tab 4 (Cookie & Consent) — Quill loads content; Save Draft works; Publish works
- [ ] Tab 5 (Consent Audit) table renders rows from `consent_audit`; pagination works; Export CSV downloads a valid file
- [ ] Tab 7 (Contract Registry) table shows all `contracts` rows joined with booking names; status filter works
- [ ] Tab 8 (Version History) shows all `legal_document_versions` sorted newest first; Preview opens modal with correct HTML
- [ ] Quill instances for Tabs 2/3/4 are lazy-initialised (not all three on section open)
- [ ] No console errors on any tab open
- [ ] All new `.lc-*` CSS classes apply correctly in both dark and light mode
- [ ] `window.notificationService.showSuccess/showError` used for all async outcomes
- [ ] `window.notificationService.showConfirm` used before all destructive actions (Publish, Restore)
- [ ] `savePolicies()` silent error catch fixed — error is now surfaced to UI

---

## 11. TEST MATRIX

### Normal Flow

| Scenario | Steps | Expected Result |
|---|---|---|
| Load section | Click Policies in sidebar | 8 tabs render; Overview tab is active; stat cards populate |
| Edit Privacy Policy | Click Privacy Policy tab → edit Quill → Save Draft | New version row in DB (`is_published=0`); mini-list shows new draft entry |
| Publish Privacy Policy | Click Publish Now → confirm | `legal_documents.status='published'`; status badge updates to Published; `current_version_id` updated |
| Restore old version | Click Restore on version row → confirm | New draft version created with old content; mini-list updates |
| Save operational policies | Change deposit % → Save Policies | `policies.deposit_percentage` updated; success toast |
| View consent records | Click Consent Audit tab | Table populates with consent_audit rows joined with booking names |
| Filter consent by type | Select "Booking" from type filter | Only rows with consent_type='booking' shown |
| Export consent CSV | Click Export CSV | File downloads with correct headers and all records |
| View contract registry | Click Contract Registry tab | All contracts from all bookings visible with client names |
| Filter contracts by status | Select "Signed" from status filter | Only signed contracts shown |
| Preview version | Click Preview on version history row | Modal opens with that version's HTML content |

### Edge Cases

| Scenario | Expected Result |
|---|---|
| Privacy Policy editor — empty content on Publish | Validation error: "Content cannot be empty"; no API call made |
| Change summary > 500 chars | Truncated to 500 before API call |
| Consent Audit — no records in DB | Empty state shown: "No consent records found." |
| Contract Registry — booking deleted | Orphaned contract row shows "Deleted Booking" for client name column |
| Version History — document type has 0 versions | Empty state per document type |
| Restore on currently published version | Confirm modal warns "This is the current published version. Restore will create a draft copy." |

### Failure Cases

| Scenario | Expected Result |
|---|---|
| `GET /api/admin/legal/overview` returns 500 | Stat cards show "—" with error toast |
| Publish succeeds but UI fails to re-fetch | On next tab activation, `loadLegalDocument()` called fresh — data is consistent |
| `POST /api/admin/legal/documents/:type/draft` 400 (invalid type) | `showError('Unknown document type')` |
| Save Draft while Quill content is loading | Save button disabled during load; re-enabled after load |
| Export CSV endpoint timeout | `showError('Export failed — try again or reduce date range')` |

### Regression Tests

| Area | Verify |
|---|---|
| Bookings section | Open bookings, check a booking contract upload — still works |
| Policy reminder job | Click Run Now in Booking Policies tab — runs correctly |
| Newsletter subscription | Submit newsletter form on `index.html` — POPIA consent still recorded |
| Login flow | Log out and back in — `#policiesAdmin` section still activates correctly |
| Light/dark mode | Toggle theme — all Legal Centre tabs render correctly in both modes |
| Existing legal modals | Trigger `#privacyModalAdmin` from footer link — still opens |

---

## APPENDIX A — Confirmed Line Number References (as of audit)

| Reference | Location | Line(s) |
|---|---|---|
| `#policiesAdmin` section div | admin.html | 5791–5851 |
| `#privacyModalAdmin` modal | admin.html | 15232–15289 |
| `#termsModalAdmin` modal | admin.html | 15294–15344 |
| `loadPolicies()` function | admin.html | 18654–18667 |
| `savePolicies()` function | admin.html | 18669–18682 |
| `triggerReminderJob()` function | admin.html | 18684–18699 |
| `shown.bs.tab` handler for policiesAdmin | admin.html | 18460–18462 |
| `GET /api/admin/policies` route | server.js | 5569–5576 |
| `PUT /api/admin/policies` route | server.js | 5577–5591 |
| `policies` table CREATE | database.js | 967–972 |
| `policies` default seed data | database.js | 1214–1222 |
| `contracts` table CREATE | database.js | 865–882 |
| `consent_audit` table CREATE | database.js | 1313–1321 |
| `policy_version` hardcoded 'v2.2' (booking route) | server.js | ~2681 |
| `policy_version` hardcoded 'v2.2' (newsletter route) | server.js | 4541 |
| `Quill` library import | admin.html | line 23 |
| `.atl-quill-wrap` CSS definition | admin.html | line 31 |
| `initTabs()` function | admin.html | 17154–17178 |
| `apiCall()` function | admin.html | 10310–10333 |
| `notificationService` (showConfirm pattern) | admin.html | various (e.g. 8664) |
| `db-stat-card` HTML pattern | admin.html | 4153–4188 |

---

## APPENDIX B — Deferred to Future Prompts

The following items are explicitly out of scope for this prompt and should NOT be partially implemented:

1. **Contract Templates CMS** — requires new `contract_templates` table, placeholder engine (`{{client_name}}` etc.), template cloning, and a template editor distinct from the booking-specific `contracts` table.
2. **Client-side digital signature capture** — requires a canvas-based signature pad library and a separate `digital_signatures` table with cryptographic audit trails.
3. **Compliance Scorecard** — requires aggregate health metrics (POPIA consent rate, document freshness alerts, missing policy detection) that depend on the consent_audit schema extension (Gate 2) being fully deployed.
4. **Public-site sync for Privacy Policy and Terms** — making `#privacyModal` / `#termsModal` on `index.html` dynamically fetch content from the new legal CMS requires a public-facing `GET /api/public/legal/:type` route and modifications to `index.html` page load logic.
5. **Dynamic `policy_version` in booking/newsletter routes** — deferred pending Gate 3 decision.
