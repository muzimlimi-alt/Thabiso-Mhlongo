# Atelier Admin — Financial Ledger / Services Catalogue / Booking Policies Gap Audit & Fix Prompt

> **What this prompt is for.** Bring `#financeAdmin`, `#servicesAdmin`, and `#policiesAdmin` to
> the platform's error-handling, UX consistency, and token-based styling standard — without
> touching the booking/CRM pipeline, invoice generation logic, or any currently-working financial
> calculation.
>
> **Every finding was verified by direct file read with line numbers.** Nothing is assumed.
> Re-grep all cited line numbers before editing — prior prompt executions will have caused drift.

---

## 0. How to use this prompt

Execute one phase at a time in order (§6 → §7 → §8 → §9). Each is independently shippable.
§6 (shared foundation) must land first. Where §5 lists a decision gate, skip that specific item
until Muzi has confirmed; implement everything else in the phase.

---

## 1. What these three sections actually are (confirmed by line read)

| Section | Lines | Structure | Tab system |
|---|---|---|---|
| `#financeAdmin` | 5208–5519 | KPI tiles → net-profit banner → period selector → 5-tab ledger | **Bootstrap** `nav-tabs`/`tab-pane`/`data-toggle="tab"` (not `atl-tab-bar`) — see §5.1 |
| `#servicesAdmin` | 5520–5788 | Section header → collapsible add/edit form (`#serviceFormCard`, `.admin-card`) → services table | No tabs |
| `#policiesAdmin` | 5791–5851 | Single centred `.admin-card` with 6 fields and a Run Now button | No tabs |

Key contextual facts:
* `#financeAdmin`'s five tabs (Transactions, Invoices, Expenses, Reconciliation, Reminders) are
  Bootstrap tabs wired to lazy-load events via `$('a[href="#finXxx"]').on('shown.bs.tab', ...)` at
  admin.html 12867, 13047, 18451–18462. These **must not be broken** — any tab-system migration
  is a decision gate (§5.1).
* `loadFinancialStats()`, `loadExpensesTab()`, `loadReconciliation()`, `loadRemindersLog()`,
  `filterTransactions()`, `applyInvoiceFilter()` are all declared as `window.*` properties at the
  bottom of the file (~17960–18265) so they are callable from inline `onclick` attributes in the
  markup. This pattern must be preserved.
* `fmtCurr()` is defined at admin.html 17922 and used throughout the finance JS.
* Services form uses Bootstrap `row`/`col-md-*`/`form-group` throughout — not `um-form`/
  `um-field-group`. The global standardization pass (`atelier-admin-standardization-prompt.md`)
  owns the full migration; this prompt only fixes the hardcoded hex/rgba values inside that
  structure, not the structural classes themselves.
* `#policiesAdmin` uses Bootstrap `col-md-8 col-md-offset-2` centering (5802) — unique in the
  admin. This prompt fixes the layout inconsistency and the missing icon; the Bootstrap offset
  removal is a contained markup change.

---

## 2. Full-stack impact analysis

| Layer | `#financeAdmin` | `#servicesAdmin` | `#policiesAdmin` |
|---|---|---|---|
| **Database** | `transactions`, `invoices`, `expenses`, `bookings` — no schema change | `services` table — no schema change | `policies` key-value table — no schema change |
| **Backend** | server.js 5397 (CSV export), 5688–5731 (invoice send/void/mark-paid), 7525 (GET invoices), 7646 (GET stats), 7795–7942 (reconciliation), 8032–8049 (reminders GET/run). No new routes needed. | server.js 5444–5563 (GET/POST/PUT/DELETE). No changes needed. | server.js 5569–5598 (GET/PUT). No changes needed. |
| **Frontend markup** | admin.html 5208–5519 | admin.html 5520–5788 | admin.html 5791–5851 |
| **Frontend JS** | `loadFinancialStats` 17971, `renderTransactions` 18044, `filterTransactions` 18087, `renderInvoices` 18109, `applyInvoiceFilter` 18142, `loadRemindersLog` 18114, `loadExpensesTab` 12682, `loadReconciliation` 12873, `populateExpenseBookingList` ~12810, `saveReconNote` 13043 | `loadAdminServices` 18474, `toggleServiceForm` 18504, `saveService` 18582, `editService` 18540, `deleteService` 18640 | `loadPolicies` 18654, `savePolicies` 18669, `triggerReminderJob` 18684 |
| **Shared infra (no changes)** | `apiCall()`, `notificationService`, `fmtCurr()` 17922, Bootstrap tab system | `apiCall()`, `notificationService` | `apiCall()`, `notificationService` |

---

## 3. Confirmed defects (every one verified by direct read with line citation)

### 3.1 `#financeAdmin`

| # | Defect | Evidence |
|---|---|---|
| D1 | **Redundant outer Bootstrap wrapper.** The section opens `<div class="row"> > <div class="col-md-12"> > <div class="settings-panel"> > <div class="settings-panel-header">` before reaching `<div class="atl-section-hd">`. This nested wrapping exists only in `#financeAdmin` — every other section has `atl-section-hd` directly inside a plain `<div>`. A section-scoped override `#financeAdmin .settings-panel` (line 860) locks styling into this structure. | admin.html 5208–5213 |
| D2 | **`#finCustomDateRow` has `display:none` declared twice** in the same inline `style` attribute: `style="display:none;gap:6px;…;flex-wrap:wrap;display:none;"`. The flex properties between the two declarations have no effect. The JS correctly uses `$('#finCustomDateRow').css('display','flex')` to reveal the row, which overrides inline style — so this doesn't block function, but it is confusing dead markup and an outright attribute error. | admin.html 5305 |
| D3 | **`loadFinancialStats()` catch block is console-only.** `catch (e) { console.error('Finance Stats Error:', e); }` — no `notificationService` call. When the stats API fails, all tiles show R 0.00 with no user-visible explanation. | admin.html 18039–18041 |
| D4 | **Hardcoded `#666` in transaction and invoice empty states.** `style="color:#666;"` in `renderTransactions()` no-results row (18049) and `applyInvoiceFilter()` no-matches row (18162). Both break in light mode. | admin.html 18049, 18162 |
| D5 | **`#aaa` fallback in invoice status colour.** `statusColors[inv.status] || '#aaa'` at 18176 — unknown statuses render in hardcoded dark grey that breaks in light mode. Replace with `var(--atl-muted)`. | admin.html 18176 |
| D6 | **`reconTable` has inline `style="color:#eee;"`.** A hardcoded dark text colour on the entire table element. Breaks in light mode. Replace with `color:var(--atl-ink-dim)` to match all other finance tables. | admin.html 5460 |
| D7 | **Reconciliation "no results" row hardcoded `#666`** in `loadReconciliation()`: `style="color:#666;"` at 12909. Same light-mode failure as D4. | admin.html 12909 |
| D8 | **Reconciliation expanded-row chevron hardcoded `color:#666`** at 12928. | admin.html 12928 |
| D9 | **`populateExpenseBookingList()` has empty `catch(e) {}`** at 12818. If the bookings API fails, the booking select dropdown in the expense modal silently shows no options — the admin cannot associate an expense with a booking with no error surfaced. | admin.html 12818 |
| D10 | **`saveReconNote()` has empty `catch(e) {}`** at 13043. A failed reconciliation note save is completely silent. | admin.html 13043 |
| D11 | **`.fin-tile` CSS rule is defined twice** in the inline `<style>` block (lines 3038 and 3628) — duplicate rule sets with identical properties. The second is redundant. | admin.html 3038, 3628 |
| D12 | **No About tab.** No `financeAbout` panel or entry point anywhere. | grep confirms absence |

### 3.2 `#servicesAdmin`

| # | Defect | Evidence |
|---|---|---|
| D13 | **`atl-section-heading` missing icon.** `<h2 class="atl-section-heading">Services Catalogue</h2>` — no `<i class="fa-solid fa-...">` prefix, unlike every other section heading in the admin. | admin.html 5525 |
| D14 | **`loadAdminServices()` has empty `catch(e) {}`** at 18501. If the API fails, the table shows "Loading..." indefinitely with no user-visible error. | admin.html 18501 |
| D15 | **`saveService()` has empty `catch(e) {}`** at 18637. `cancelServiceForm()` runs inside the `try` (18634) so on success the form closes; on failure `apiCall()` throws, the catch fires silently, and the admin has no feedback — no toast, no form re-open, nothing. | admin.html 18631–18638 |
| D16 | **`deleteService()` has empty `catch(e) {}`** at 18650. A failed archive shows no error. | admin.html 18646–18651 |
| D17 | **Hardcoded hex in `loadAdminServices()` rendered table rows.** Loading state `color:#555` (18476), empty state `color:#555` (18480), pricing model text `color:#aaa` (18491), limits text `color:#666` (18493). Delete button: `background:rgba(248,113,113,0.10);color:#555;border:1px solid rgba(255,255,255,0.05)` (18498) — `color:#555` makes the delete button look greyed-out and disabled even when active. All break in light mode. | admin.html 18476–18498 |
| D18 | **`#svcAdvancedPanel` border uses `rgba(255,255,255,0.06)`** (5690) — hardcoded white-tinted separator that disappears in light mode. Replace with `var(--atl-line)`. | admin.html 5690 |
| D19 | **No search or filter on the services table.** With up to ~20 services, a simple client-side name/category filter is a high-value, low-effort addition. No backend change required. Decision gate §5.2. | admin.html 5776–5786 |
| D20 | **No About tab.** | grep confirms absence |

### 3.3 `#policiesAdmin`

| # | Defect | Evidence |
|---|---|---|
| D21 | **`atl-section-heading` missing icon**, same as D13. `<h2 class="atl-section-heading">Booking Policies</h2>` — no `<i>` prefix. | admin.html 5796 |
| D22 | **`loadPolicies()` has empty `catch(e) {}`** at 18666. A failed load shows the form blank/stale with no explanation. | admin.html 18666 |
| D23 | **`savePolicies()` has empty `catch(e) {}`** at 18681. On success, `showSuccess()` fires (inside the try, 18680). On failure, `apiCall()` throws, catch fires silently — no error toast. | admin.html 18678–18682 |
| D24 | **No frontend validation before save.** `savePolicies()` sends whatever values the inputs hold — empty strings, out-of-range numbers (deposit > 100, reminder days = 0 or negative), unsanitized textarea text. The backend's `PUT /api/admin/policies` does no value validation either (it accepts any string per key via `INSERT OR REPLACE`). A deposit of 200 or -50 would silently persist and potentially corrupt downstream quote generation at line 11698. | admin.html 18669–18681; server.js 5577–5598 |
| D25 | **Bootstrap `col-md-8 col-md-offset-2` centering** (5802) — the only use of Bootstrap column offsets in the admin. Replace with a CSS-based centering approach consistent with the platform (`max-width` + `margin: 0 auto` on the card container). | admin.html 5802 |
| D26 | **No About tab.** | grep confirms absence |

---

## 4. Non-negotiable constraints

* **Do not touch Bootstrap tab wiring in `#financeAdmin`** — the `shown.bs.tab` lazy-load events
  at 12867, 13047, 18451–18462 are load-bearing. Any tab-system migration is gated by §5.1.
* **Do not touch `fmtCurr()` (17922)** or any financial calculation logic — these are in scope
  only for error handling improvements.
* **Do not change the services backend routes** — they are correctly validated, complete, and
  handle both soft-delete and hard-delete. The frontend sends exactly what the backend expects.
* **Do not change invoice PDF generation, the payment pipeline, PayFast integration, or any
  booking status transitions.** This prompt is scoped to display and error-surfacing only.
* **No new component classes.** All fixes use existing tokens and classes:
  empty states → `.atl-empty-state`/`.atl-empty-sub`; coloured text → `--atl-*` variables;
  borders → `var(--atl-line)`; About tab → the §6.1 skeleton.
* **All `window.*` function declarations must remain on `window`** — they are called from inline
  `onclick` attributes in the markup and from other script blocks.
* **`loadAdminServices()` must remain as `window.loadAdminServices`** — it is called from the
  `shown.bs.tab` handler at 18458.

---

## 5. Decision gates — confirm with Muzi before implementing

1. **`#financeAdmin` Bootstrap tabs vs `atl-tab-bar`:** The finance section uses Bootstrap
   `nav-tabs`/`tab-pane`/`data-toggle="tab"` while all other tabbed sections use the platform's
   `atl-tab-bar`/`um-panel` system. Migrating would require replacing all five `shown.bs.tab`
   event listeners with `initTabs()`-compatible lazy-load hooks — a high-risk, medium-effort
   change. The tabs work correctly today. **Confirm: migrate to `atl-tab-bar` (accept risk), add
   an "About" tab as a sixth Bootstrap tab (lower risk), or add an About entry point via a
   header icon button that opens a modal (lowest risk, consistent with `#inquiriesAdmin`
   approach from the previous prompt)?** Do not implement any About entry point for `#financeAdmin`
   until this is confirmed.
2. **Services table search/filter (D19):** Add a simple client-side search input above the
   services table filtering by name/category? Or is the catalogue small enough that this isn't
   needed? Confirm before adding — this is a low-risk addition but adds markup.
3. **`#financeAdmin` outer wrapper cleanup (D1):** Remove the redundant `row > col-md-12 >
   settings-panel > settings-panel-header` layers and the section-scoped CSS at lines 860–870?
   Or leave the wrapper layers in place and only remove the duplicate scoped CSS? Confirm before
   touching this — it affects the section's outer visual chrome.

---

## 6. Shared foundation (build first)

If `atelier-contact-social-newsletter-inquiries-prompt.md` or
`atelier-home-about-career-prompt.md` has already run, the About-tab skeleton and
`.um-pagination-btns` CSS are already in place. Only add what is still missing.

### 6.1 About-tab skeleton
Same pattern as previous prompts in this series. For each section with a tab bar (only
`#servicesAdmin` and `#policiesAdmin` get new tab bars here — `#financeAdmin`'s About entry
point is gated by §5.1):

```html
<div id="{section}AboutPanel" class="um-panel">
    <div class="atl-card">
        <div class="um-icon-header" style="margin-bottom:16px;">
            <div class="um-icon-header__icon"><i class="fa-solid fa-circle-info"></i></div>
            <div>
                <h4 class="um-section-label">About This Section</h4>
                <p class="um-section-desc">{one-line purpose}</p>
            </div>
        </div>
        <hr class="um-divider" style="margin-top:0;">
        <!-- purpose / controls / workflow / security note blocks -->
    </div>
</div>
```

### 6.2 Error-handling norm (carry-over)
Per the norm established in the prior prompts: every `catch` block touched in this prompt must
call `window.notificationService.showError('...')` alongside (not instead of) `console.error`.
The nine empty `catch(e) {}` blocks listed in §3 are the primary targets.

---

## 7. Phase 1 — `#financeAdmin` (most complex; strictly no tab changes without §5.1 confirmation)

### 7.1 Tasks

**T1 — Fix D1 (redundant outer wrapper) — per §5.3 decision.** If confirmed safe: remove the
`<div class="row">`, `<div class="col-md-12">`, `<div class="settings-panel">`, and
`<div class="settings-panel-header">` wrapper layers (admin.html 5209–5213) that wrap the
`atl-section-hd`. The closing `</div></div></div></div>` at 5511–5515 must be removed at the
same time. Also remove the section-scoped CSS overrides at lines 860–870:
```css
#financeAdmin .settings-panel { ... }
#financeAdmin .settings-panel-header { ... }
```
If not confirmed, leave the structure intact and only fix the other defects.

**T2 — Fix D2 (`#finCustomDateRow` duplicate `display:none`).** Remove the duplicate
`display:none` from the inline style attribute (5305), leaving:
```html
<div id="finCustomDateRow" style="display:none; gap:6px; align-items:center; flex-wrap:wrap;">
```
The JS at 17963 already correctly calls `.css('display','flex')` to reveal it.

**T3 — Fix D3 (`loadFinancialStats` catch).** Replace at admin.html 18039–18041:
```js
} catch (e) {
    console.error('Finance Stats Error:', e);
    window.notificationService.showError('Failed to load financial stats — please refresh.');
}
```

**T4 — Fix D4 + D5 + D6 + D7 + D8 (hardcoded hex in rendered cells).** These are all
single-token substitutions in JS template strings and one HTML attribute:
* `renderTransactions()` empty row (18049): `style="color:#666;"` → `style="color:var(--atl-muted-dim);"`
* `applyInvoiceFilter()` empty row (18162): `style="color:#666;"` → `style="color:var(--atl-muted-dim);"`
* `applyInvoiceFilter()` status fallback (18176): `|| '#aaa'` → `|| 'var(--atl-muted)'`
* `reconTable` (5460): `style="color:#eee; border-color:var(--atl-line);"` → `style="color:var(--atl-ink-dim); border-color:var(--atl-line);"`
* Reconciliation empty row (12909): `style="color:#666;"` → `style="color:var(--atl-muted-dim);"`
* Reconciliation chevron (12928): `style="font-size:10px;color:#666;..."` → `style="font-size:10px;color:var(--atl-muted-dim);..."`

**T5 — Fix D9 + D10 (empty catches in finance utilities).**
* `populateExpenseBookingList()` catch at 12818: add `window.notificationService.showError('Could not load bookings for expense association — the dropdown will be empty.')` and `console.error(e)`.
* `saveReconNote()` catch at 13043: add `window.notificationService.showError('Failed to save reconciliation note.')` and `console.error(e)`.

**T6 — Fix D11 (duplicate `.fin-tile` CSS).** Locate both definitions (lines 3038 and 3628).
Verify they are identical; if so, delete the second definition block (3628 onwards). If they
differ in any property, merge into one definition keeping the more specific rules. Do not delete
without comparing line by line.

**T7 — About tab for `#financeAdmin` — implement per §5.1 decision.** Three options confirmed
in §5.1; implement whichever Muzi selects:
* *Option A (Bootstrap sixth tab):* Add `<li role="presentation"><a href="#finAbout"
  aria-controls="finAbout" role="tab" data-toggle="tab"><i class="fa-solid fa-circle-info"
  style="margin-right:5px;"></i>About</a></li>` to the nav-tabs list (after Reminders, 5327),
  and a matching `<div role="tabpanel" class="tab-pane" id="finAbout">` with the §6.1 content
  to the tab-content block.
* *Option B (header info button → modal):* Add an `<i class="fa-solid fa-circle-info">` info
  button to the `atl-section-hd` actions row (5219) that calls `showAtelierModal()` with the
  §6.1 content in the modal body. Same pattern as `#inquiriesAdmin`'s About approach.
* *Option C (migrate to `atl-tab-bar`):* Full tab system migration — only if Muzi confirms
  accepting the risk; test every lazy-load event after migration.

About tab content for `#financeAdmin`: the 5 ledger tabs and what each shows; how the period
selector works and that "Net Profit" is Revenue minus Expenses for the selected period; how
overdue tile and due-soon tile are clickable shortcuts; Expenses must be manually logged via
"Log Expense"; Reconciliation compares quoted amounts against PayFast + manual payments and
flags discrepancies; Reminder timings are configured in Booking Policies.

### 7.2 Hard constraints specific to this phase
* All five `shown.bs.tab` lazy-load events (12867, 13047, 18451–18462) must continue to fire
  correctly after any markup change.
* `#finTransactions`, `#finInvoices`, `#finExpenses`, `#finReconciliation`, `#finReminders`,
  `#txSearchInput`, `#txTypeFilter`, `#txDateFrom`, `#txDateTo`, `#invoiceStatusFilter`,
  `#expenseCategoryFilter`, `#expenseDateFrom`, `#expenseDateTo`, `#reconWarnFilter`,
  `#finRemindersList`, `#finTransactionsList`, `#finInvoicesList`, `#finExpensesList`,
  `#reconTableBody`, `#reconSummary` — all IDs unchanged.
* `#finStat-*`, `#finTile-*`, `#finPeriodPreset`, `#finCustomDateRow`, `#finDateFrom`,
  `#finDateTo`, `#finPeriodLabel`, `#finStat-PeriodLabel` — all IDs unchanged.

---

## 8. Phase 2 — `#servicesAdmin`

### 8.1 Tasks

**T1 — Fix D13 (missing heading icon).** Add an icon to the `atl-section-heading` at 5525:
```html
<h2 class="atl-section-heading"><i class="fa-solid fa-list-check"></i> Services Catalogue</h2>
```
`fa-list-check` matches the icon already used in the nav sidebar at line 3870 and in the
dashboard About block at 15884.

**T2 — Fix D14 (empty `loadAdminServices` catch).** Replace at 18501:
```js
} catch(e) {
    console.error('Failed to load services:', e);
    window.notificationService.showError('Could not load services — please refresh.');
    $('#servicesTableBody').html(
        '<tr><td colspan="7" class="text-center" style="padding:30px;"><div class="atl-empty-state"><i class="fa-solid fa-circle-exclamation"></i><p>Failed to load services.</p></div></td></tr>'
    );
}
```

**T3 — Fix D15 (empty `saveService` catch).** The issue: `cancelServiceForm()` runs inside
the `try` (18634), so on success the form closes. On failure, the form must stay open. Move
`cancelServiceForm()` to AFTER the `notificationService.showSuccess()`, and add a real catch:
```js
try {
    if (id) { await apiCall('/api/admin/services/' + id, 'PUT', body); }
    else { await apiCall('/api/admin/services', 'POST', body); }
    await loadAdminServices();
    window.notificationService.showSuccess('Service saved successfully.');
    cancelServiceForm(); // moved here — only runs on success
} catch(e) {
    console.error('Failed to save service:', e);
    window.notificationService.showError('Could not save service — please check your input and try again.');
    // form stays open for the admin to retry
}
```

**T4 — Fix D16 (empty `deleteService` catch).** Replace at 18650:
```js
} catch(e) {
    console.error('Failed to archive service:', e);
    window.notificationService.showError('Could not archive service — please try again.');
}
```

**T5 — Fix D17 (hardcoded hex in rendered table rows).** In `loadAdminServices()` (18476–18498):
* Loading state (18476): `style="padding:20px;color:#555;"` → `style="padding:20px;color:var(--atl-muted-dim);"`
* Empty state (18480): `style="padding:20px;color:#555;"` → `style="padding:20px;color:var(--atl-muted-dim);"`
* Model text (18491): `style="color:#aaa; font-size:11px;"` → `style="color:var(--atl-muted); font-size:11px;"`
* Limits text (18493): `style="color:#666; font-size:11px;"` → `style="color:var(--atl-muted-dim); font-size:11px;"`
* Delete button (18498): replace `style="background:rgba(248,113,113,0.10);color:#555;border:1px solid rgba(255,255,255,0.05);"` with the existing `.atl-btn--danger` class variant, which is already token-based:
  ```html
  <button class="atl-btn atl-btn--danger btn-svc-delete" data-id="${s.id}">
  ```
  Remove the inline style entirely — `.atl-btn--danger` provides the correct token-based red styling. The `btn-svc-delete` event handler at 19264 fires on the class, not an ID — preserved.

**T6 — Fix D18 (`#svcAdvancedPanel` border).** On admin.html 5690, change:
`border-top:1px solid rgba(255,255,255,0.06)` → `border-top:1px solid var(--atl-line)`

**T7 — Add search/filter to services table (D19) — per §5.2 decision.** If confirmed: add a
`.um-search-wrap` row above the services table with a text input (`#svcSearch`) and a category
filter select (`#svcCategoryFilter`), matching the visual pattern already used in
`#usersAdmin`'s search bar (admin.html 4761–4767). Wire client-side filtering in a new
`window.filterServicesTable()` function that operates on `allServicesCache` (18473) and
re-calls the `$body.html(...)` render logic — do not refetch from the API on each keystroke.
Debounce the search input at ≥250ms.

**T8 — Add tab bar + About tab.** `#servicesAdmin` currently has no tab bar. Wrap the
existing content (form card + table card) as `<div id="servicesConfigPanel" class="um-panel active">`,
add `<div id="servicesAboutPanel" class="um-panel">` (§6.1 skeleton), insert `.atl-tab-bar`.

About tab content for `#servicesAdmin`: what a service is (a catalogue item used when building
quotes and invoices for bookings); the three pricing models (Flat Fee, Per Minute, Per Hour) and
when to use each; what Active vs Inactive does (inactive services don't appear in new booking
quotes but don't affect existing ones); the Advanced/Financial Fields panel — SAP codes, GL
codes, crew requirements — are optional and exist for accounting integration; soft-delete
(Archive) vs hard-delete: archiving is reversible via the API `force=1` param, deleting a
service referenced by booking line items will be rejected by the backend.

### 8.2 Hard constraints specific to this phase
* `#serviceFormCard`, `#svcEditId`, `#servicesTableBody`, and all `#svc*` input IDs — unchanged.
* `window.toggleServiceForm`, `window.saveService`, `window.cancelServiceForm`,
  `window.togglePricingFields`, `window.editService`, `window.deleteService`,
  `window.loadAdminServices` — all remain on `window`.
* `allServicesCache` (18473) is module-scope state shared between `loadAdminServices()`,
  `editService()`, and any new filter function — do not move it or re-declare it.
* T3 (fixing `saveService`) moves `cancelServiceForm()` from inside the try to after
  `showSuccess()`. Verify the edit flow: if editing, `cancelServiceForm()` correctly hides
  `#serviceFormCard` and clears `#svcEditId` — confirm this is still called on both create
  and edit success paths.

---

## 9. Phase 3 — `#policiesAdmin` (simplest; do last)

### 9.1 Tasks

**T1 — Fix D21 (missing heading icon).** Add to the `atl-section-heading` at 5796:
```html
<h2 class="atl-section-heading"><i class="fa-solid fa-gavel"></i> Booking Policies</h2>
```

**T2 — Fix D22 (empty `loadPolicies` catch).** Replace at 18666:
```js
} catch(e) {
    console.error('Failed to load policies:', e);
    window.notificationService.showError('Could not load booking policies — please refresh.');
}
```

**T3 — Fix D23 (empty `savePolicies` catch).** Replace at 18681:
```js
} catch(e) {
    console.error('Failed to save policies:', e);
    window.notificationService.showError('Could not save policies — please try again.');
}
```

**T4 — Fix D24 (no frontend validation in `savePolicies`).** Add before the `try` block at
18678:
```js
const deposit = parseFloat($('#polDeposit').val());
const quoteValidity = parseInt($('#polQuoteValidity').val());
const rem1 = parseInt($('#polReminderDays1').val());
const rem2 = parseInt($('#polReminderDays2').val());

if (!$('#polDeposit').val() || isNaN(deposit) || deposit < 0 || deposit > 100) {
    window.notificationService.showError('Deposit percentage must be a number between 0 and 100.');
    return;
}
if (!$('#polQuoteValidity').val() || isNaN(quoteValidity) || quoteValidity < 1) {
    window.notificationService.showError('Quote validity must be at least 1 day.');
    return;
}
if (!$('#polPaymentTerms').val().trim()) {
    window.notificationService.showError('Payment Terms are required.');
    return;
}
if (rem1 && rem2 && rem1 <= rem2) {
    window.notificationService.showError('First reminder must be more days before due date than Final reminder (e.g. 7 days vs 2 days).');
    return;
}
```
This prevents nonsensical values from reaching the DB and corrupting downstream quote
generation (line 11698 reads `polDeposit` directly via `$('#polDeposit').val()`).

**T5 — Fix D25 (Bootstrap column offset).** Replace the centering layout at 5801–5802:
```html
<!-- BEFORE -->
<div class="row">
    <div class="col-md-8 col-md-offset-2">
        <div class="admin-card">

<!-- AFTER -->
<div style="max-width:740px; margin:0 auto;">
    <div class="admin-card">
```
Remove the closing `</div></div>` for the row and col that are being replaced. The `admin-card`
content (5803–5848) is unchanged. This removes the last Bootstrap `col-md-offset-*` usage in
the admin.

**T6 — Add tab bar + About tab.** Wrap the `admin-card` block as
`<div id="policiesConfigPanel" class="um-panel active">`, add
`<div id="policiesAboutPanel" class="um-panel">` (§6.1 skeleton), insert `.atl-tab-bar`.

About tab content for `#policiesAdmin`: what each field controls (Deposit % is used as the
default when generating quotes via the Quote Builder — changing this affects all future quotes,
not existing ones; Quote Validity is how many days a quote PDF is valid; Payment Terms and
Cancellation Policy are included verbatim in invoice and quote PDFs); Reminder Timings (the
first reminder triggers X days before each scheduled payment due date, the final reminder Y
days before — both are automated and suppressed if already sent; "Run Now" sends reminders
immediately for any currently due/overdue payments); security note — the deposit percentage is
read directly by the Quote Builder UI (line 11698), so an invalid value here (e.g. 200%) will
pre-fill quotes incorrectly until corrected.

### 9.2 Hard constraints specific to this phase
* `#polDeposit`, `#polQuoteValidity`, `#polPaymentTerms`, `#polCancellation`,
  `#polReminderDays1`, `#polReminderDays2` — all IDs unchanged.
* `window.savePolicies`, `window.loadPolicies`, `window.triggerReminderJob` — all remain on `window`.
* `triggerReminderJob()` (18684) is working correctly — do not touch it (it already has full
  error handling and button-state management).
* Line 11698 reads `$('#polDeposit').val()` directly — the validation in T4 ensures this value
  is always a valid number before it reaches the DB.

---

## 10. Acceptance criteria

- [ ] **`#financeAdmin`:** `loadFinancialStats()` failure is surfaced via `notificationService`.
      All `#666`/`#aaa`/`#eee` hardcoded colours in rendered cells replaced with `--atl-*` tokens.
      Duplicate `display:none` on `#finCustomDateRow` removed. Both empty catches (D9, D10) surface
      errors. Duplicate `.fin-tile` CSS rule collapsed to one. About entry point present per §5.1
      decision.
- [ ] **`#servicesAdmin`:** `atl-section-heading` has icon. All three empty catches (D14, D15, D16)
      surface errors. `saveService` only calls `cancelServiceForm()` on success — form stays open
      on failure. All hardcoded hex in table rows replaced with tokens. Delete button uses
      `.atl-btn--danger` (no inline `color:#555`). `#svcAdvancedPanel` border uses `var(--atl-line)`.
      Search/filter added per §5.2 decision. Tab bar + About tab present.
- [ ] **`#policiesAdmin`:** `atl-section-heading` has icon. Both empty catches (D22, D23) surface
      errors. `savePolicies()` validates all inputs before sending. Bootstrap column offset removed.
      Tab bar + About tab present.
- [ ] **Zero functional regressions** — all five finance tabs still lazy-load correctly; invoice
      send/void/mark-paid all still work; services add/edit/delete all still work; policies
      save/load/run-reminders all still work.
- [ ] No new hardcoded hex in any edited block. All new CSS uses `--atl-*` tokens.
- [ ] All §5 decision gates resolved with Muzi's input or left in current state pending that input.

---

## 11. Test matrix

| Scenario | `#financeAdmin` | `#servicesAdmin` | `#policiesAdmin` |
|---|---|---|---|
| **Normal** | Switch all 5 tabs; set period to "Custom Range" and verify date row appears; click overdue tile to jump to Invoices tab filtered to OVERDUE | Add a service with Flat Fee; add another with Per Minute; edit the first; archive the second | Load section, verify fields pre-populated; change deposit to 30, save, reload, confirm 30 persists |
| **Validation** | N/A | Leave Name empty, click Save — client error fires; enter price = abc, click Save — client error fires | Enter deposit = 150, click Save — error fires. Leave Payment Terms blank — error fires. Set Reminder 1 = 2, Reminder 2 = 7 (wrong order) — error fires |
| **Failure** | Force 500 from `GET /api/admin/financials/stats` — error toast fires, tiles show R 0.00 (D3 regression test). Force 500 from recon note save — error toast fires (D10 test) | Force 500 from `POST /api/admin/services` — error toast fires, form stays open (D15 regression test — form must NOT close). Force 500 from `DELETE` — error toast fires (D16 test) | Force 500 from `PUT /api/admin/policies` — error toast fires, no success toast (D23 regression test) |
| **Regression** | Invoice "Mark as Paid", "Resend", "Void" buttons still work. Expense "Log Expense" button opens modal. Run Reminders button completes and shows sent/skipped count | `.btn-svc-edit` and `.btn-svc-delete` event handlers still fire after T5 (delete button markup change) | "Run Now" reminder job completes successfully and shows counts |
| **Theme** | Finance tiles, table cells, and reconciliation chevrons re-theme in light mode — no `#666`/`#eee` remaining | Services table rows re-theme — loading/empty states, model text, limits visible in light mode. Delete button shows red in both themes (no `color:#555` override) | N/A (policies form already uses tokens) |

---

## 12. Suggested order of work

1. **§6 Shared foundation** — verify pagination CSS and About skeleton are in place from prior
   prompts; add if not.
2. **§9 `#policiesAdmin`** — smallest, most self-contained. Validates the catch-block migration
   pattern and the validation-before-send pattern at lowest risk.
3. **§8 `#servicesAdmin`** — medium risk. T3 (`saveService` restructure) is the highest-risk
   task and should be tested in isolation before proceeding to T5–T8.
4. **§7 `#financeAdmin`** — most defects, most cross-references. Recommended sub-order:
   T2 (duplicate `display:none`) → T4 (hex tokens) → T3 (stats catch) → T5 (utility catches) →
   T6 (duplicate CSS) → T1 (wrapper, if gated) → T7 (About, per §5.1 resolution).
5. **Full §10 + §11 pass** before declaring done.

> **Pair with:** `atelier-contact-social-newsletter-inquiries-prompt.md` and
> `atelier-home-about-career-prompt.md` (share the same About-tab skeleton, error-handling norm,
> and foundation CSS). `atelier-admin-standardization-prompt.md` owns the full Bootstrap
> `form-group`/`col-md-*` migration in `#servicesAdmin` and `#policiesAdmin` — run it after all
> functional-gap prompts have landed.
