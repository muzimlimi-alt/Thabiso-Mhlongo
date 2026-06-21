# Atelier Obsidian — Five-Section Standardization Prompt
### Target sections: `#brandingAdmin` · `#preferencesAdmin` · `#usersAdmin` · `#securityAdmin` · `#emailLogsAdmin`

This prompt is grounded in a direct audit of `admin.html` (23,221 lines) and `server.js` (12,042 lines) as currently committed. Every claim below was verified with `grep -n` and direct line reads, not inferred from screenshots or assumed from naming conventions. Line numbers are accurate as of this audit — **re-locate by ID with `grep -n` before editing, since line numbers drift after any change.**

---

## 1. OBJECTIVE

`#usersAdmin` and `#emailLogsAdmin` already demonstrate the two reference UI patterns this product uses for tabbed/data-table sections. `#securityAdmin` is close but incomplete. `#preferencesAdmin` and `#brandingAdmin` are settings forms that have never been brought into the tabbed pattern at all.

The goal is **not** to invent a new design system — it's to finish rolling out the one that already exists in three of these five sections, onto the other two, and to close the specific functional gaps identified below. Where a requested control (search/filter/sort/bulk/pagination) doesn't make sense for a section's actual content (e.g. a settings form has no rows to sort), do not force it in — note that explicitly instead.

---

## 2. NON-NEGOTIABLE RULES

1. **Do not rename or remove** any existing `id`, `onclick` handler, or globally-exposed function: `loadAuditLogs`, `loadEmailLogs`, `toggleLogSort`, `applyLogFilters`, `debounceLogSearch`, `toggleUserSort`, `loadSystemSettings`, `saveSystemSettings`, `loadBrandingSettings`, `saveBranding`, `uploadBrandingAsset`, `updateBrandPreview`, `sendTestNotification`, `btnGdprDelete` handler.
2. **Two separate tab systems exist — do not conflate them:**
   - **Outer section tabs** (sidebar `<a href="#brandingAdmin">` etc., Bootstrap `shown.bs.tab`, wired at admin.html ~line 21340–21359) switch between the 20 major admin sections and fire each section's data-load function (`loadSystemSettings()`, `loadBrandingSettings()`, `loadAuditLogs()`, `loadEmailLogs()`). **Leave these handlers exactly where they are.**
   - **Inner panel tabs** (`.atl-tab-bar` / `.atl-tab-btn[data-um-tab]` / `.um-panel`) switch between sub-views *within* a section (e.g. usersAdmin's My Profile / Change Password / Manage Users / About). This system is already generic and global — see `initTabs()` at admin.html line 19189. **Do not write new tab-switching JS.** Adding inner tabs to a section is a markup-only change: a `.atl-tab-bar` with buttons carrying `data-um-tab="someId"`, and sibling `.um-panel` divs with matching `id="someId"`. `initTabs()` will pick them up automatically because it queries `qsa('.atl-tab-bar')` globally.
3. **RBAC is untouched.** All five sections are administrator-only via the `restrictedSidebar` array in `applyRoleGating()` (admin.html ~line 16064–16070). Do not add any code path that renders these tabs' content for `manager` or `assistant` roles.
4. **Reuse existing global classes** rather than writing new ones: `.atl-tab-bar`, `.atl-tab-btn`, `.um-panel`, `.um-icon-header`, `.um-section-label`, `.um-section-desc`, `.um-divider`, `.um-input-wrap`, `.um-input`, `.um-label`, `.um-feedback`, `.um-bulk-bar`, `.um-check`, `.atl-empty-state` (+ `.atl-empty-mono`, `.atl-empty-display`, `.atl-empty-sub`), `.atl-spinner`. These are confirmed global (not scoped to `#bookingsAdmin` or `#usersAdmin`) — see Section 4.
5. **Colour tokens only.** No new hardcoded hex/rgba. Section 5 lists every confirmed hardcoded colour instance in these five sections with its exact replacement.
6. **`server.js` is in scope for exactly two possible changes, both conditional on sign-off:** `/api/admin/audit_log`, only if Decision Gate A (Section 6) is resolved in favour of server-side pagination; and the error-response branches of `/api/admin/settings`, `/api/admin/branding`, and `/api/admin/users*`, only if Decision Gate B2 (Section 14.3) is resolved in favour of message sanitisation. Every other route requires **zero** backend changes; their endpoints already support what the UI needs (see Section 4 endpoint audit).
7. **No new font families.** Use only Cormorant Garamond / Outfit / JetBrains Mono — already loaded.
8. **Work section by section**, validate visually (both `data-theme="dark"` and `data-theme="light"`) before moving to the next.
9. **Minimum 44×44px tap targets** on every interactive control added, on mobile.
10. **Do not re-implement or rename `apiCall()` (admin.html line 11156), `showFeedback()` (line 19171), or any `window.notificationService.*` method.** These are the existing centralised mechanisms — see Section 15. New error-handling work *uses* them, it doesn't replace them.
11. **Do not build a second toast/banner/modal system.** `window.notificationService` (`js/notificationService.js`, loaded line 22009) already exposes `showSuccess`, `showError`, `showWarning`, `showInfo`, `showConfirm`, and `showPrompt` — confirmed by their actual call sites throughout admin.html. Every new piece of user-facing feedback in these five sections must route through this service or the existing `.um-feedback` / `.atl-field-error` classes, not a bespoke `alert()`, custom `<div>`, or inline `style` block.

---

## 3. CONFIRMED CURRENT-STATE MATRIX

| Capability | `#usersAdmin` | `#securityAdmin` | `#emailLogsAdmin` | `#preferencesAdmin` | `#brandingAdmin` |
|---|---|---|---|---|---|
| Inner tab navigation | ✅ 4 tabs | ✅ 3 tabs | ❌ none (flat) | ❌ none (flat) | ❌ none (flat) |
| About tab | ✅ `#umPanelAbout` | ❌ missing | ❌ missing | ❌ missing | ❌ missing |
| Free-text search | ✅ `#umUserSearch` (client-side) | ❌ none | ✅ `#logSearch` (server-side, debounced) | n/a — settings form, no rows | n/a — settings form, no rows |
| Filter controls | n/a (3 fixed roles) | ✅ table / date-from / date-to | ✅ status / trigger-event dropdowns | n/a | n/a |
| Sortable columns | ✅ 4 cols via `toggleUserSort()` | ❌ static headers, no sort | ✅ 5 cols via `toggleLogSort()` | n/a | n/a |
| Bulk select + actions | ✅ checkbox col + `.um-bulk-bar` (activate/deactivate/delete) | n/a — read-only log | ❌ none | n/a | n/a |
| Pagination UI | ✅ `#umUserPagination`, client-side over cached set | ❌ none — flat `limit=100` fetch, no page controls | ✅ `#logPagination`, server-driven | n/a | n/a |
| Backend pagination support | n/a — `/api/admin/users` returns full list, fine at current scale | ❌ `/api/admin/audit_log` accepts `limit`/`offset` but returns **no `total` count** — a real page UI cannot be built without it | ✅ `/api/admin/email-logs` returns `total`, `page`, `totalPages` | n/a | n/a |
| Empty state | ✅ (table degrades gracefully) | ⚠️ plain inline-styled text row, not `.atl-empty-state` | ⚠️ `#emailLogsEmpty` is a bespoke inline-styled block, not `.atl-empty-state` | n/a | n/a |
| Loading state on open | ✅ spinner row | ✅ spinner row | ✅ spinner row | ❌ none while `loadSystemSettings()` runs | ❌ none while `loadBrandingSettings()` runs |
| Save feedback | ✅ inline `.um-feedback` (Profile/Password) | n/a (POPIA action uses `notificationService` toast — correct pattern for a destructive one-off action) | n/a | toast only (`notificationService`) — **this is an established, valid pattern elsewhere in the app, not a defect** | toast only — same note |
| Form field pattern (`um-input-wrap` + icon + `.um-label`) | ✅ | n/a (no forms) | n/a | ❌ raw Bootstrap `.form-group` / `<label>` / `.atl-input`, no icons | ✅ already compliant |
| Section heading typography | ✅ `.atl-section-heading` | ✅ | ✅ | ⚠️ inner card still has a raw `<h2>System Settings</h2>` and three raw `<h5>` sub-headers (line ~7705, 7707, 7724, 7744) instead of `.um-icon-header`/`.um-section-label` | ✅ |
| Hardcoded colour debt | none found | **13 instances**, see Section 5 | none found | none found | none functional (one `#D4AF37` is a legitimate default attribute value, not a bug) |
| RBAC sidebar gating | ✅ admin-only | ✅ admin-only | ✅ admin-only | ✅ admin-only | ✅ admin-only |

**Things that are already correct and must not be "fixed":** `#usersAdmin` fully meets the target standard — no changes needed there; it is the reference. The toast-based save feedback in Preferences/Branding/POPIA is an intentional, already-established pattern alongside the inline `.um-feedback` pattern used in Profile/Password — both are valid, don't force one onto the other. The `.um-shell` class wraps `#usersAdmin` but has **no CSS rule defined anywhere** — it's a no-op; don't propagate it to other sections.

**A structural class-system gap that benefits all five sections (and the rest of the app):** `.um-search-wrap`, `.um-pagination-btns`, and `.um-empty-state` are used as class names at every call site but **have no actual CSS rule defined for them anywhere in the file** — confirmed by exhaustive search. Every usage (e.g. admin.html lines 5078, 8080, 8091, 8956, 9264–9266) re-implements its own layout via a duplicated, slightly-different inline `style="..."` attribute instead. This is why spacing/padding is already inconsistent between sections that look similar. Fixing this once (Task F1) removes a recurring source of drift.

---

## 4. FULL-STACK IMPACT ANALYSIS

| Layer | Affected? | Detail |
|---|---|---|
| **Database** | No schema changes | `settings` table (key/value, backs Preferences + Branding), `admins` table (Users), `audit_log` table (Security), `email_logs` table (Email Logs) — all existing tables are adequate as-is. |
| **Backend** | Two conditional changes | `/api/admin/audit_log` (server.js line 6534) currently has no `total` count in its response, so a real pagination footer can't be built — see Decision Gate A. Separately, the `PUT`/error branches of `/api/admin/settings`, `/api/admin/branding`, and `/api/admin/users*` currently return raw `err.message` to the client — see Decision Gate B2. **No other route needs to change** — `/api/admin/email-logs` (line 5641) already supports `page`, `limit`, `search`, `status`, `trigger`, `sort`, `order` and returns `total`/`totalPages`; the GET endpoints for users/settings/branding are sufficient for their current and target UI. |
| **Frontend** | Primary scope | All work is in `admin.html`: markup restructuring (tabs), CSS (token replacement, filling the three undefined shared classes), JS for Security's new sort/search/pagination (mirroring `toggleLogSort`/`debounceLogSearch` from Email Logs), and the error-handling wiring in Task Group G / Section 14 — routing `loadBrandingSettings()`, `loadAuditLogs()`, `loadEmailLogs()`, `loadAllUsers()`, and the Add/Edit User submit through the existing `apiCall()`/`notificationService` infrastructure, plus a possible page-level browser-error listener pending Decision Gate B1. |

---

## 5. HARDCODED COLOUR INSTANCES TO REPLACE (`#securityAdmin` only — all others are clean)

All 13 instances are in the **System Integrity** panel (`#secPanelIntegrity`, ~lines 8138–8158) and the **POPIA Data Erasure** panel (~lines 8224–8226). They currently render fine in dark mode by coincidence but **break legibility in light mode** (`#eee`/`#aaa` near-white text on a light surface) — confirmed `[data-theme="light"]` overrides exist elsewhere in the file (line 809) but these rows aren't covered by them.

| Line (approx.) | Current | Replace with |
|---|---|---|
| 8140, 8144, 8148 | `color: #eee` | `color: var(--atl-ink-dim)` |
| 8139, 8143 | `background: rgba(52,211,153,0.1); border-color: rgba(52,211,153,0.2)` | `background: color-mix(in srgb, var(--atl-green) 10%, transparent); border-color: color-mix(in srgb, var(--atl-green) 20%, transparent)` |
| 8141, 8145 | `background: rgba(52,211,153,0.15)` (badge bg) | `background: color-mix(in srgb, var(--atl-green) 15%, transparent)` |
| 8147 | `background: rgba(251,146,60,0.1); border-color: rgba(251,146,60,0.2)` | `background: color-mix(in srgb, var(--atl-orange) 10%, transparent); border-color: color-mix(in srgb, var(--atl-orange) 20%, transparent)` |
| 8149 | `background: rgba(251,146,60,0.15)` | `background: color-mix(in srgb, var(--atl-orange) 15%, transparent)` |
| 8225, 8226 | `color:#aaa` (×2, inside `<strong>`) | `color: var(--atl-muted-dim)` (matches the sibling wrapper at line 8224, which already uses this token) |

The `color-mix(in srgb, var(--atl-X) N%, transparent)` pattern is not new — it's already used at admin.html line 3284 for `.um-icon-btn--danger:hover`. There are no pre-built `--atl-green-dim`/`--atl-orange-dim` tokens, so `color-mix` is the correct mechanism here, not an invented one.

---

## 6. DECISION GATE A — Audit Trail Pagination (resolve before writing Task Group A's pagination work)

`/api/admin/audit_log` has no row-count query, so two paths exist:

**Option A — Server-side pagination (matches the Email Logs pattern exactly).**
Add a `COUNT(*)` query and return `total`/`page`/`totalPages`, mirroring `/api/admin/email-logs` line-for-line. Also add a `search` param (e.g. `LIKE` over `table_name`, `action`, `changed_by`). Pros: identical UX to Email Logs, scales if the audit log grows large, consistent backend pattern. Cons: touches `server.js`, however the change is additive and low-risk — it only adds a query, doesn't alter existing `table`/`date_from`/`date_to`/`limit`/`offset`/`include_financial` behaviour.

**Option B — Frontend-only "Load more" pagination.**
Keep the endpoint as-is; increment `offset` client-side on a "Load more" button instead of numbered pages, and skip free-text search (keep the existing table/date filters only). Pros: zero backend risk, ships faster. Cons: audit trail won't have the same numbered-page UX as Email Logs, and there's no way to show "Showing X–Y of Z" without a total count.

**Recommendation:** Option A, since it brings Security in line with the established Email Logs pattern and the change is small and isolated. **Wait for Muzi's sign-off before implementing either.**

---

## 7. REFERENCE MARKUP PATTERNS (copy these structures, don't reinvent)

**Inner tab bar + panel** (from `#usersAdmin`, line ~4846):
```html
<div class="atl-tab-bar" role="tablist">
    <button class="atl-tab-btn active" data-um-tab="xxPanelOne" role="tab" aria-selected="true">
        <i class="fa-solid fa-ICON"></i>  Tab Label
    </button>
    <button class="atl-tab-btn" data-um-tab="xxPanelAbout" role="tab" aria-selected="false">
        <i class="fa-solid fa-circle-info"></i>  About
    </button>
</div>
<div class="um-panel active" id="xxPanelOne"> ... </div>
<div class="um-panel" id="xxPanelAbout"> ... </div>
```

**Search input** (from `#emailLogsAdmin`, line ~8024):
```html
<div class="um-input-wrap" style="flex:1; min-width:250px;">
    <i class="fa-solid fa-magnifying-glass um-input-icon"></i>
    <input type="text" id="xxSearch" placeholder="Search by …" class="um-input" oninput="debounceXxSearch()">
</div>
```

**Sortable column header** (from `#emailLogsAdmin`, line ~8055):
```html
<th onclick="toggleXxSort('column_name')" style="cursor:pointer; color: var(--atl-amber);">
    Label <i class="fa-solid fa-sort" id="sort-column_name" style="font-size:10px; margin-left:5px; opacity:0.5;"></i>
</th>
```

**Empty state — use the real global class, not an ad hoc block:**
```html
<div class="atl-empty-state">
    <i class="fa-solid fa-ICON" style="font-size:32px; color:var(--atl-muted); opacity:0.4;"></i>
    <p class="atl-empty-display">No results found</p>
    <p class="atl-empty-sub">Try adjusting your filters.</p>
</div>
```

**About tab body** (model: `#umPanelAbout`, line ~5086–5153) — a `.um-icon-header` intro, one or two `.um-section-desc` paragraphs, then structured content specific to the section (Section 9 below specifies what each one should cover).

---

## 8. IMPLEMENTATION TASKS

### Task Group A — `#securityAdmin`
- **A1.** Add a fourth inner tab, `secPanelAbout`, using the reference pattern. Content per Section 9.
- **A2.** Add a free-text search box to the Audit Trail panel header row, next to the existing `auditTableFilter`/date inputs. Wire to a new `debounceAuditSearch()` mirroring `debounceLogSearch()` (line 20157) — debounce 300–400ms, call `loadAuditLogs()`.
- **A3.** Make the four Audit Trail column headers (`Event`, `Section`, `Action`, `Timestamp`) sortable using the `toggleLogSort()` pattern (line 20127), renamed appropriately, sorting by the underlying fields (`table_name`, `action`, `change_timestamp`).
- **A4.** Add a pagination footer to Audit Trail matching `#logPaginationContainer`'s structure (line 8087) — implementation depends on Decision Gate A's outcome.
- **A5.** Apply the colour token replacements in Section 5.
- **A6.** Replace the plain-text "No audit events recorded yet" row (line 21202) and the loading row with the `.atl-empty-state` / existing spinner pattern respectively.
- **A7 (optional, flag for Muzi, don't auto-implement):** `loadAuditLogs()` currently fires on the *outer* section's `shown.bs.tab` (line 21344), meaning it loads even if the visitor lands on "System Integrity" first rather than "Audit Trail." Consider lazy-loading only when the Audit Trail inner tab opens, mirroring the `umPanelUsers` lazy-load precedent in `initTabs()` (line 19207).

### Task Group B — `#emailLogsAdmin`
- **B1.** Wrap the existing content in an inner tab structure: `logPanelHistory` (current content, unchanged) + `logPanelAbout` (new). This section currently has zero tabs, so this is additive, not a rewrite.
- **B2.** Replace `#emailLogsEmpty`'s bespoke inline block (line 8080) with the `.atl-empty-state` pattern.
- **B3 (optional, flag for Muzi — do not assume):** Email Logs has no bulk select. A bulk "Export selected" or similar could be added, but logs are read-only and there's no clear destructive/bulk action need yet — confirm with Muzi before adding checkboxes that have no action behind them.

### Task Group C — `#usersAdmin`
- No changes. Confirmed compliant with the target standard already (Section 3).

### Task Group D — `#preferencesAdmin`
- **D1.** Restructure into inner tabs: `prefPanelGateway` (PayFast + SMTP, i.e. current "System Settings" card content), `prefPanelNotifications` (Notifications sub-section, currently the third `<h5>` block), `prefPanelAbout` (new). Splitting these out of one long scroll into tabs mirrors how every other multi-concern section in this audit is organized.
- **D2.** Replace the raw `<h2>System Settings</h2>` and the three raw `<h5 style="color: var(--atl-amber)...">` sub-headers (lines ~7705, 7707, 7724, 7744) with `.um-icon-header` + `.um-section-label` blocks, one per new tab.
- **D3.** Convert every `.form-group` / bare `<label>` / `.atl-input` field to the `.um-input-wrap` + leading icon + `.um-label` pattern used in `#usersAdmin` and already used in `#brandingAdmin`. Suggested icons: `fa-id-badge` (Merchant ID), `fa-key` (Merchant Key/Passphrase), `fa-link` (Gateway URL), `fa-server` (SMTP Host), `fa-ethernet` (Port), `fa-envelope` (From Address/Notifications Email), `fa-user` (SMTP User), `fa-lock` (SMTP Password).
- **D4.** Add a loading indicator (reuse `.atl-spinner`) shown while `loadSystemSettings()` is in flight, since the form currently appears with empty fields with no affordance during the fetch.
- **D5.** Populate the About tab per Section 9.

### Task Group E — `#brandingAdmin`
- **E1.** Restructure into inner tabs: `brandPanelIdentity` (Logo, Favicon, Accent Colour, Theme Font cards), `brandPanelEmail` (Email Branding card), `brandPanelSite` (Website Preferences + Admin Backgrounds cards), `brandPanelAbout` (new). The existing `.um-grid-2`/`.atl-card`/`.um-icon-header` markup inside each card is already compliant — this task is about grouping, not rebuilding.
- **E2.** Add a loading indicator while `loadBrandingSettings()` is in flight, same rationale as D4.
- **E3.** Populate the About tab per Section 9.
- **E4 (flag only, do not auto-resolve):** The "Website Preferences" and "Admin Backgrounds" cards currently live inside `#brandingAdmin` even though they save via their own separate forms (`#preferencesForm`, `#adminBgForm`) distinct from `saveBranding()`. This is a content-ownership overlap between Branding and Preferences that predates this task. Group them under `brandPanelSite` as instructed in E1, but don't move them into `#preferencesAdmin` itself or merge their save logic — that's an information-architecture decision for Muzi, not something to resolve unilaterally here.

### Task Group F — Shared fixes (apply once)
- **F1.** Define real CSS rules for `.um-search-wrap`, `.um-pagination-btns`, and `.um-empty-state` (currently undefined everywhere, per Section 3), then remove the duplicated inline `style` attributes at each existing call site (lines 5023, 5076, 5078, 8087, 8091, 8080) so they inherit from the class instead. This is the single highest-leverage fix in this task list — it benefits all five sections plus every other section reusing these class names.
- **F2 (flag for Muzi, larger blast radius — confirm before doing):** The focus-visible and `::selection` rules (admin.html lines 1776–1788) are still scoped to `#bookingsAdmin` only. None of these five sections get the gold focus ring or selection colour. Extending this is straightforward (drop the `#bookingsAdmin` prefix or add the five new section IDs to the selector list) but touches a global rule, so confirm scope before changing it.

### Task Group G — Centralised error & messaging handling (all five sections)
Full grounding, decision gate, and per-function detail is in **Section 15**. Summary of the work:
- **G1.** `loadBrandingSettings()` (line 21959) has a fully silent `catch(e) {}` — zero feedback on failure. Add a `notificationService.showError()` call and a visible fallback state in the form.
- **G2.** `loadAuditLogs()` (Security, line 21183) only `console.error`s on failure — add `notificationService.showError()` plus the `.atl-empty-state`/error-state treatment already specified in Task A6.
- **G3.** `loadEmailLogs()` (line 20005) and `loadAllUsers()` (line 19622) already show an inline fallback row but never call `notificationService` — add the toast alongside the existing inline row so failures are visible even if the user has scrolled away from the table.
- **G4.** The Add/Edit User form submit handler (line 19588) uses a raw `fetch()` instead of `apiCall()`, so a 401 mid-submit doesn't trigger the proper re-login flow. Route it through `apiCall()` instead, preserving its existing `showFeedback()` banner for validation/success/error text.
- **G5.** Add inline per-field validation using the existing, currently-unused `.atl-field-error` class (line 1685) to the Add/Edit User form and the Preferences/Branding forms, alongside (not replacing) the existing banner/toast feedback.
- **G6.** Resolve Decision Gate B (Section 15) before touching server.js error messages or adding a page-level browser error listener.

---

## 9. ABOUT TAB CONTENT — PER SECTION (grounded in actual functionality, do not invent capabilities)

- **Security & Audit `secPanelAbout`:** What System Integrity, Audit Trail, and POPIA Erasure each do; that audit entries are immutable system records (bookings/invoices/transactions/cancellations/quotations); that POPIA erasure is irreversible and retains financial records per the 5-year SARS requirement while anonymizing personal identifiers (mirror the existing copy at line 8225–8226, don't restate it differently).
- **Email Logs `logPanelAbout`:** What gets logged (the 7 trigger-event categories already enumerated in `#logTriggerFilter`, line 8038–8045), what the three statuses (success/failed/pending) mean, and that this is a read-only audit view.
- **Preferences `prefPanelAbout`:** That PayFast fields drive live payment processing, SMTP fields drive all outgoing system email, and that the Notifications Email is where new-booking alerts are delivered. Note that saved values take effect immediately without a server restart (existing copy already says this at line 7706).
- **Branding `brandPanelAbout`:** That logo/favicon/accent colour/theme font changes apply across both the public site and the admin dashboard; that the Email Branding banner appears in outgoing email; and that Admin Backgrounds only affect the admin login/dashboard, not the public site.

---

## 10. ACCESSIBILITY & RESPONSIVENESS REQUIREMENTS

- New tab buttons: `role="tab"`, `aria-selected`, keep using `.atl-tab-bar`'s existing `flex-wrap: wrap` (already global) so they don't overflow on narrow viewports.
- New sort headers: keep the existing `<i class="fa-solid fa-sort">` visual indicator, but add an `aria-sort` attribute (`ascending`/`descending`/`none`) updated alongside the icon swap, since the current Email Logs/Users implementations don't set this — bring all sortable headers (new and existing) up to the same bar while you're in there.
- Every new input keeps a `<label for="...">`/`id` pairing — the new D3 fields especially, since the current raw `<label>Merchant ID</label>` has no `for` attribute tying it to `#stPayfastId`.
- 44×44px minimum tap targets on all new buttons/tabs on mobile, consistent with Rule 9.
- All new markup must render correctly under both `[data-theme="dark"]` (default) and `[data-theme="light"]` — this is precisely why Section 5's colour fixes matter.

---

## 11. EDGE CASES TO HANDLE

- Audit Trail / Email Logs: zero results after search+filter combination → `.atl-empty-state`, not a blank table.
- Audit Trail / Email Logs: search and filter and sort applied simultaneously → confirm query params compose correctly (Email Logs already does this server-side; Audit Trail will need the same once Decision Gate A is resolved).
- Preferences / Branding: `loadSystemSettings()` / `loadBrandingSettings()` network failure → loading state must clear and show an error state, not hang indefinitely.
- Mobile viewport: 3–4 tab buttons per section bar must wrap, not overflow off-screen.
- Light mode: every previously-hardcoded colour in Section 5 must remain legible after the token swap.
- RBAC: confirm manager/assistant accounts still cannot see any of these five sections or their new tabs after the changes — gating happens at the sidebar-link level (line 16064), not per-tab, so this should be unaffected, but verify.

---

## 12. ACCEPTANCE CRITERIA

- [ ] All five sections have a consistent inner `.atl-tab-bar` structure, each ending with an About tab.
- [ ] No existing `id`, handler, or API route was renamed or removed.
- [ ] Security's Audit Trail has search, sort, and pagination matching the resolved Decision Gate A option.
- [ ] Email Logs has tabs added without disturbing its existing search/filter/sort/pagination.
- [ ] Preferences and Branding form fields use the `.um-input-wrap`/icon/`.um-label` pattern throughout.
- [ ] All 13 hardcoded colour instances in Security are replaced with tokens per Section 5's table.
- [ ] `.um-search-wrap`, `.um-pagination-btns`, `.um-empty-state` have real CSS rules; redundant inline styles at their call sites are removed.
- [ ] Every section renders correctly in both dark and light theme.
- [ ] No regressions in `#usersAdmin` (left untouched) or any of the other 15 admin sections.
- [ ] Manager/assistant accounts still cannot access any of the five sections.
- [ ] `loadBrandingSettings()` no longer fails silently — a load failure produces a visible toast and a non-empty fallback state in the form (Task G1).
- [ ] `loadAuditLogs()`, `loadEmailLogs()`, and `loadAllUsers()` all call `notificationService.showError()` on failure, in addition to their existing inline fallback (Tasks G2–G3).
- [ ] The Add/Edit User form submit uses `apiCall()` instead of a raw `fetch()`, so session expiry mid-submit is handled correctly (Task G4).
- [ ] Inline per-field validation using `.atl-field-error` is present on the Add/Edit User form and the Preferences/Branding forms (Task G5).
- [ ] No new bespoke alert/toast/banner markup was introduced — everything routes through `notificationService` or the existing `.um-feedback`/`.atl-field-error` classes (Rule 11).
- [ ] Decision Gate B (global error listener, server-side message sanitisation) was resolved with Muzi before any global or server.js error-handling change was made.

---

## 13. TEST MATRIX

| Scenario | Section(s) | Expected Result |
|---|---|---|
| **Normal** — open each section as administrator | All 5 | Tabs render, default tab active, data loads, no console errors |
| **Normal** — search "payment" in Audit Trail | Security | Matching rows only, pagination recalculates |
| **Normal** — sort Email Logs by Recipient asc/desc | Email Logs | Existing behaviour unchanged, sort icon updates |
| **Normal** — switch theme toggle while on Security tab | Security | All status rows remain legible (Section 5 fix) |
| **Edge** — search Audit Trail with zero matches | Security | `.atl-empty-state` shown, not blank table |
| **Edge** — load Preferences on slow network | Preferences | Loading indicator shown, then form populates |
| **Edge** — narrow mobile viewport (360px) on Branding | Branding | Tab bar wraps, all tap targets ≥44px |
| **Failure** — `/api/admin/audit_log` returns 500 | Security | Error state shown via `notificationService.showError()`, not an infinite spinner or silent console-only log |
| **Failure** — `loadBrandingSettings()` network error | Branding | Toast shown (Task G1), loading indicator clears, form does not appear empty without explanation |
| **Failure** — `loadEmailLogs()` / `loadAllUsers()` server error | Email Logs / Users | Existing inline row still shows, plus a toast now fires alongside it |
| **Failure** — submit Add User form after session has expired (401) | Users | Redirects to login via `apiCall()`'s existing 401 handling, not a generic "Network error" message |
| **Failure** — submit Add User form with missing/invalid email | Users | Inline `.atl-field-error` appears next to the Email field, in addition to the existing banner |
| **Failure** — disconnect network entirely, trigger any save in these 5 sections | All 5 | A clear "check your connection" message, not a raw `TypeError: Failed to fetch` string |
| **Regression** — `#usersAdmin` Manage Users tab | Users | Search/sort/bulk/pagination all behave exactly as before |
| **Regression** — manager-role login | All 5 | Sidebar links for all five remain hidden |
| **Regression** — `#bookingsAdmin` untouched | Bookings | No visual or functional change |
| **Regression** — `saveSystemSettings()`, `saveBranding()`, `sendTestNotification()`, POPIA erasure | Preferences / Branding / Security | Existing `apiCall()`/`notificationService` behaviour unchanged (Task Group G doesn't touch these) |

---

## 14. CENTRALISED ERROR & MESSAGING HANDLING (notificationService.js)

This section grounds Task Group G. It was audited the same way as the rest of this document — every claim below is a confirmed line reference, not an assumption about what "should" exist.

### 14.1 Existing infrastructure — confirm before building anything new

- **`window.notificationService`** is a global service loaded from `js/notificationService.js?v=2.0.2` (admin.html line 22009). Its real method surface, confirmed by actual call sites across the file, is: `showSuccess()`, `showError()`, `showWarning()`, `showInfo()`, `showConfirm()`, `showPrompt()`. All four toast *types* (error/success/warning/info) exist in `notifications.css` with distinct accent colours, icons, and auto-dismiss progress bars.
- **`notifications.css`** also defines a complete, unused full-page **HTTP error overlay** component: `#tm-http-error-root`, `.tm-http-error__code` (large numeral, e.g. "500"), `__title`, `__message`, `__actions` with primary/secondary buttons. This is built specifically for prominently surfacing 4xx/5xx codes — **confirmed zero call sites reference it anywhere in admin.html.** It's dormant, not broken.
- **`.atl-field-error`** (admin.html line 1685) is a defined, ready-to-use CSS class for inline per-field validation text (small, clay-coloured). **Confirmed zero usages anywhere in the markup.** Also dormant.
- **`apiCall(url, method, body)`** (line 11156) is the existing centralised fetch wrapper. It already: redirects to login on `401`; throws and auto-calls `notificationService.showError("API Error: " + message)` for any other non-OK response or `data.error`. Many functions already benefit from this for free simply by calling `apiCall()` instead of raw `fetch()`.
- **`showFeedback(el, msg, type, autoClear)`** (line 19171) is the helper behind the inline `.um-feedback` banners (Users' Profile/Password/Add-User forms).

**The work in this section is almost entirely about wiring existing, dormant, or partially-used infrastructure to the five target sections — not inventing a new error system.**

### 14.2 Confirmed gaps, by function

| Function | Section | Current behaviour | Gap |
|---|---|---|---|
| `loadBrandingSettings()` (21959) | Branding | `catch(e) {}` | **Fully silent.** No console log, no toast, no inline message. Worst case found. |
| `loadAuditLogs()` (21183) | Security | `catch(e) { console.error(...) }` | Console-only. Nothing visible to the user. |
| `loadEmailLogs()` (20005) | Email Logs | Inline table-row message, generic "Session may have expired" regardless of real cause | No `notificationService` call; doesn't distinguish network failure / 5xx / actual session expiry |
| `loadAllUsers()` (19622) | Users | Inline table-row message | No `notificationService` call; no HTTP-status differentiation |
| Add/Edit User submit (19588) | Users | Raw `fetch()`, not `apiCall()` | A 401 mid-submit shows a generic "Network error" instead of triggering proper re-login |
| `loadSystemSettings()`, `saveSystemSettings()`, `saveBranding()`, `sendTestNotification()`, POPIA erasure | Preferences / Branding / Security | Already use `apiCall()` and/or explicit `notificationService` calls | **None — already compliant, do not modify.** |
| All five sections | — | No function distinguishes 4xx (client/validation) from 5xx (server) in its messaging | `apiCall()` surfaces the backend's `error`/`message` field verbatim for every non-401 failure |
| Settings/Branding/Users `PUT` handlers (server.js ~6924, ~6947, and similar) | — | `res.status(500).json({ error: err.message })` | Raw SQLite error text reaches the admin's toast — low severity since this is an admin-only panel, but still not a clean user-facing message, and not logged separately from what's shown |
| Whole page | — | No `window.onerror` / `unhandledrejection` listener anywhere in admin.html | Uncaught browser-level JS errors (the "browser activity" category) currently produce zero user-facing signal |
| Add/Edit User form | Users | One shared `.um-feedback` banner near the submit button | Not literally "near the respective input field" as requested — acceptable today, but Task G5 adds true per-field messages via the dormant `.atl-field-error` class |

### 14.3 Decision Gate B — scope of the page-level and backend pieces

Two parts of this request have a larger blast radius than "these five sections" and need Muzi's sign-off before implementation:

**B1 — Global browser-error listener.** A `window.addEventListener('error', ...)` / `('unhandledrejection', ...)` pair is inherently page-wide; it can't be scoped to only fire inside five `<div>`s. Recommendation: add it once, globally, routed through `notificationService.showError()` with a generic "Something went wrong" message (never the raw `error.message`, to avoid leaking internals) and a `console.error` for the real detail. This satisfies the request for these five sections as a side effect of being global, but it will also silently start catching errors elsewhere in the 23,000-line file that may currently be failing unnoticed — worth a heads-up, not a blocker.

**B2 — Server-side message sanitisation.** Should `server.js` handlers backing these five sections' endpoints (`/api/admin/settings`, `/api/admin/branding`, `/api/admin/users*`, `/api/admin/audit_log`) stop returning raw `err.message` and instead return a generic message (e.g. `"Unable to save settings. Please try again."`) while logging the real error server-side via `console.error`? This is a `server.js` change, scoped only to these five endpoints' `catch`/error branches — not a rewrite of error handling elsewhere in the 12,000-line file. Recommended: yes, scoped narrowly as described. **Wait for sign-off before touching server.js for this.**

### 14.4 Implementation guidance

- For 4xx responses where the backend already returns a clear validation message (e.g. `"Email and password are required."`), surface it as-is via `showError()` — these are already user-appropriate.
- For 5xx responses, prefer a generic actionable message ("Something went wrong saving your changes. Please try again or contact support if this continues.") over surfacing `err.message` directly, pending Decision Gate B2.
- For network failures specifically (`fetch()` rejecting before a response is received, typically `TypeError: Failed to fetch`), detect this case in `apiCall()` and show "Network error — check your connection and try again" instead of the raw browser error text, which is not actionable for a non-technical admin.
- Loading states: every one of the five sections already has *some* loading affordance except Preferences and Branding (Tasks D4/E2 already cover this) — make sure the loading state always has a corresponding terminal state (success, empty, or error), never left spinning indefinitely on failure.
- Success confirmations: already consistent (`showSuccess()` used correctly in Preferences/Branding/Users saves) — no changes needed there beyond what Task Group G specifies.


---

## 15. DELIVERABLE FORMAT

On completion, provide:
1. Confirmation of which Decision Gate A option (Section 6) and Decision Gate B option(s) (Section 14.3) were implemented.
2. A short before/after note per section (one or two lines each is enough — the matrix in Section 3 and the gap table in 14.2 already document the gaps).
3. List of every file/line range touched, for review.
4. Any items flagged in Tasks A7, B3, E4, F2, or the Decision Gate B sign-offs that were intentionally left for Muzi's decision rather than auto-resolved.
