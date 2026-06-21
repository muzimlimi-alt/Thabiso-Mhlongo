# Atelier Admin — Contact / Social / Inquiries / Newsletter Gap Audit & Fix Prompt

> **What this prompt is for.** Bring `#contactAdmin`, `#socialAdmin`, `#inquiriesAdmin`, and
> `#newsletterAdmin` up to the same functional and UX standard as the platform's most mature
> sections — without a full visual re-skin (that is `atelier-admin-standardization-prompt.md`'s
> job) and without touching the booking/CRM pipeline.
>
> **This prompt supersedes a looser draft brief** that asked for "search/filter/sort/bulk/
> pagination on all four sections, matching `#usersAdmin`, with `#inquiriesAdmin` redesigned into
> side-panel drawers." A direct read of `admin.html` and `server.js` shows that brief doesn't match
> the live code in three important ways — see §1. This prompt is grounded in the **actual**
> current state, confirmed by line number, not the draft brief's assumptions.

---

## 0. How to use this prompt

* Execute **one phase at a time**, in the order given (§7 → §10). Each phase is scoped to a
  single `.admin-section` and is independently shippable.
* Every phase opens with **"Current state (confirmed)"** — re-verify line numbers with `grep -n`
  before editing, since they will have drifted after Phase 1 lands.
* Do not start a phase until the prior phase's acceptance criteria (§12) are checked off.
* §6 (shared foundation) must land **first** — every later phase consumes its CSS and the
  About-tab skeleton.
* Where a task touches `server.js`, the relevant routes are quoted verbatim with line numbers so
  you are not guessing at request/response shape.

---

## 1. Reference standard — what "matching `#usersAdmin`" actually means today

Direct reads of `admin.html` surface three corrections to the original brief. State these
divergences plainly when you report back; do not silently paper over them.

1. **`#usersAdmin`'s own "Manage Users" panel (lines 4702–4775) has search only** — no filter, no
   sort, no bulk select, no pagination. It cannot be the literal template for those four
   capabilities because it doesn't have them. The actual best-built examples of each capability,
   confirmed by line number, are:
   * **Search + empty/loading state** → `#usersAdmin` `.um-search-wrap` (line 4761) and
     `#emailLogsAdmin`'s `#emailLogsEmpty` (line 7398, class `.um-empty-state`).
   * **Filter + sort + bulk-select + bulk-actions + real server-side pagination, all four at
     once** → the **Campaigns** sub-panel already inside `#newsletterAdmin` (lines 6873–6926,
     backed by `GET /api/admin/campaigns/unified`, server.js line 8501). This is the gold-standard
     pattern to copy from, not `#usersAdmin`.
   * **Tab bar + panel switching** → `#usersAdmin` (lines 4552–4563) and `#socialAdmin` (lines
     6258–6265), both driven by the generic `initTabs()` (admin.html line 17154). It is markup-only:
     a new `.atl-tab-btn[data-um-tab="x"]` plus a sibling `.um-panel#x` is all `initTabs()` needs —
     confirmed by reading the function, it has no per-section logic except one hardcoded
     `umPanelUsers` lazy-load exception.
2. **`#socialAdmin` already has the "Social Links" / "Media Embeds" tab split** the brief asked
   for (lines 6258–6265, `#socialTabBar`). Only the third "About" tab is genuinely missing. Do not
   rebuild what already exists.
3. **`#inquiriesAdmin` is already a three-pane email-client layout** (folder nav → message list →
   detail/reply/compose panel, lines 4792–4951) with working search, status-folder filtering, and
   a sort dropdown. It is **not** the cramped single-pane view the brief describes, and it already
   has a detail panel functionally equivalent to the "side-panel drawer" the brief asks for. The
   real gaps are narrower: no bulk select, no bulk actions, no pagination, no About tab — see §9.

`#contactAdmin` (single-record settings form, no list) and `#newsletterAdmin` (three dense
sub-panels in one two-column layout) match the brief's framing reasonably well; their phases
proceed close to as originally scoped, plus the defects in §3.

---

## 2. Full-stack impact analysis

| Layer | `#contactAdmin` | `#socialAdmin` | `#inquiriesAdmin` | `#newsletterAdmin` |
|---|---|---|---|---|
| **Database** | `contact_info`, `manager_details` (no schema change) | `social_links`, `social_embeds` (no schema change; `is_active` column already exists, unused by UI) | `inquiries` (no schema change) | `newsletter_subscribers`, `newsletter_campaigns` (no schema change) |
| **Backend routes** | `server.js` 8690–8773 (manager + contact_info) — validation gap, see §3 | `server.js` 8784–8937 (social_links + social_embeds) | `server.js` 8585–8649 — **new** bulk routes required (§9) | `server.js` 4653–4767 (subscribers), 8487–8650 (campaigns) — duplicate route + dead route, see §3 |
| **Frontend markup** | `admin.html` 6658–6760 | `admin.html` 6235–6397 | `admin.html` 4782–4953 | `admin.html` 6763–7008 — needs tab restructuring (§10) |
| **Frontend JS** | `loadContactData()` 9358, `loadManagerData()` 9371, form handlers 9409–9500 | `renderSocialList()` 9694, `renderEmbedList()` 9839, form handlers 9771–10030, dead `loadSocialData()` 8496 | `loadInquiries()` 10366, `renderInqList()` 10400, `openInquiry()` 10452 | `renderSubscribersList()` 13660, bulk handlers 13767–13830, `loadCampaigns()` 14318 |
| **Shared infra (no changes needed)** | `apiCall()` (admin.html ~10297), `notificationService` (6 methods), `initTabs()` (17154), `.atl-tab-bar`/`.um-panel` CSS (admin.html 1708–1720) | same | same | same |

❗ Per the project's standing rule: business logic and `server.js` are touched **only** where a
confirmed defect (§3) or an explicitly-scoped new capability (bulk endpoints, pagination params)
requires it. Nothing else in `server.js` changes.

---

## 3. Confirmed defects found during this audit

These are real, not hypothetical — each was read directly in the file at the cited line. Fix them
as part of the phase for their section; do not defer them.

| # | Section | Defect | Evidence |
|---|---|---|---|
| D1 | `#contactAdmin` | `#managerAdminForm` submit handler and `#managerClearBtn` click handler call raw `fetch()` instead of `apiCall()`, and **never check `res.ok` or parse the JSON body**. A failed save or clear (validation error, 500, DB constraint) on the backend is reported to the admin as **"Saved Successfully!" / "Cleared!"** — a silent-failure bug, not a cosmetic gap. | admin.html 9462–9477, 9487–9498 |
| D2 | `#contactAdmin` | `loadContactData()` and `loadManagerData()` have `catch (e) { console.error(...) }` only — no `notificationService` call. On load failure the form just looks blank/stale with no explanation. | admin.html 9366–9368, 9386–9388 |
| D3 | `#contactAdmin` (backend) | `PUT /api/admin/manager` and `DELETE /api/admin/manager` perform **no server-side validation** of `name`/`email`/`cell_number`/`whatsapp_number` — they trust the client entirely, violating the platform's "never trust frontend data" rule. | server.js 8697–8728 |
| D4 | `#socialAdmin` | `renderSocialList()` and `renderEmbedList()` catch blocks only `console.error`/`console.log` — list silently appears stale/empty on failure, no `notificationService` surfaced. | admin.html 9732–9734, 9927–9929 |
| D5 | `#socialAdmin` | The `.remove-social-action` delete handler's catch block is empty except for a comment claiming it is "handled securely" — it is not; no error is shown to the admin if the delete fails. | admin.html 9817–9819 |
| D6 | `#socialAdmin` | `is_active` is fully supported server-side (column persisted on every insert/update, see server.js 8804/8811/8918/8925) but the frontend **hardcodes `is_active: true` on every save** and never renders or lets the admin toggle it. Frontend-only gap — no backend work needed to fix. | admin.html 9791, 10010 |
| D7 | `#socialAdmin` | Dead code: a duplicate, stale `loadSocialData()` (lines 8496–8509) targets fields that no longer exist in the markup (`#socFb`, `#socIg`, `#socTw`, `#socYt`, `#socGp`, `#socVn`, `#socYtEmbed`, `#socIgEmbed`) and an orphaned `#socialForm` submit handler writes to `localStorage('tm_social_data')`. JS hoisting means the *second* definition (line 10272) is the one that actually runs, so this isn't live-breaking today, but it's ~40 lines of dead/misleading code. | admin.html 8493–8522 |
| D8 | `#socialAdmin` | `#clearSocialBtn` ("Clear All Links") exists in markup with `style="display:none"` and has **no click handler anywhere in the file** — dead UI, never shown, never wired. | admin.html 6390–6392 |
| D9 | `#newsletterAdmin` (backend) | `DELETE /api/admin/newsletter/subscribers/:id` is registered **twice** (server.js 4687 and 4716) with different behavior — the second adds a 404-on-no-change check the first lacks. Express dispatches to the first match only, so the better-behaved second copy is permanently dead. | server.js 4687–4695, 4716–4724 |
| D10 | `#newsletterAdmin` | `function loadSentCampaigns() {}` is an empty no-op, apparently superseded by `loadCampaigns()`/the unified endpoint but left in the file. | admin.html 14299 |
| D11 | `#newsletterAdmin` (backend) | `GET /api/admin/campaigns` (non-unified, server.js 8487) appears superseded by `GET /api/admin/campaigns/unified` (8501) — confirmed the frontend's `loadCampaigns()` only ever calls the unified route. Flag as a removal candidate; **do not delete** without confirming no other caller (decision gate, §5). | server.js 8487–8500, admin.html 14323 |
| D12 | `#newsletterAdmin` | Subscriber status badge and the activate/deactivate button use legacy Bootstrap classes (`label label-success`, `label label-default`, `btn btn-sm btn-warning`/`btn-success`) instead of the platform's `.atl-badge`/`.atl-btn` system used everywhere else in this prompt's scope. | admin.html 13709–13715 |
| D13 | All four sections | Error handling is inconsistent: some catches are silent-console-only (D2, D4), some call `notificationService`, none follow one documented rule. Standardize per §6.3. | — |

---

## 4. Non-negotiable constraints

* **Do not rename or remove any existing `id`, `name`, `data-*` attribute, or JS function name**
  unless it is explicitly listed as dead code in §3 and the phase task says to remove it.
* **Do not change booking/CRM business logic, pricing, or anything in `server.js` outside the
  routes named in §2/§3** for this prompt's four sections.
* **Reuse existing components — do not invent new ones.** Tabs = `.atl-tab-bar` / `.atl-tab-btn` /
  `.um-panel` (already global, already token-based). Buttons = `.atl-btn`/`.um-btn` variants
  already in use in each section. Confirm/destructive dialogs = `window.notificationService.showConfirm()`.
  Errors = `window.notificationService.showError()`. Do not write a parallel implementation of any
  of these.
* **All new bulk/pagination backend endpoints must require `requireAdmin`** and follow the
  existing response shape conventions (`{ success, message }` for mutations; bare array or
  `{ data/campaigns, total, pages }` for paginated reads — mirror `/api/admin/campaigns/unified`
  exactly for any new paginated list route).
* **Preserve every workflow that currently works.** Nothing in §3's defect list is "broken" in the
  sense of throwing visible errors today (except D1, D9, D11 are dead/duplicate code, not active
  breakage) — these are silent-failure and dead-code issues. Fix them without changing the happy
  path's behavior or copy unless the fix requires it (e.g. D1 necessarily changes what happens on
  a *failed* save).
* **No assumptions.** If a selector, function, or route referenced here doesn't match what you
  find when you re-grep, stop and report the discrepancy — don't guess a substitute.

---

## 5. Decision gates — confirm with Muzi before implementing

1. **D7 (dead `loadSocialData()` + orphaned `#socialForm`)** — confirm safe to delete outright
   (it appears to be fully superseded), versus archiving the code in a comment block first.
2. **D8 (`#clearSocialBtn`)** — remove the dead button entirely, or implement and wire it as a
   real "delete all social links" bulk action (with a destructive `showConfirm()`)? Document 2's
   "bulk actions where appropriate" suggests the latter; confirm before building it.
3. **D11 (legacy `GET /api/admin/campaigns`)** — confirm no other caller (search the whole repo,
   not just `admin.html`) before removing; if unconfirmed, leave it in place and just stop
   referencing it.
4. **Platform API keys in `localStorage`** (`tm_api_key_${platform}`, admin.html 9995/10027) —
   flagged as a security observation during this audit, not in scope to silently change. Confirm
   whether moving these server-side is in scope for a future prompt before touching this code.
5. **New bulk-action backend routes for `#inquiriesAdmin`** (§9.3) and **pagination params for
   `GET /api/admin/inquiries` and `GET /api/admin/newsletter/subscribers`** (§9.4, §10.4) are new
   server surface area, not bug fixes. Confirm the page-size default (this prompt suggests 25,
   matching nothing in particular — pick a number and confirm) before implementing.

---

## 6. Shared foundation (build first, all four phases depend on it)

### 6.1 Pagination component CSS — currently does not exist anywhere

`.um-pagination-btns` is used today only by `#emailLogsAdmin` (`#logPagination`, admin.html 7409)
and **has zero CSS rules in any file** (`style.css`, `redesign.css`, or the inline `<style>` block
all return no matches). Define it once, token-based, reusable by every phase below and by
`#emailLogsAdmin`'s existing usage:

```css
.um-pagination-btns {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
}
.um-pagination-btns .um-page-btn {
    /* reuse .um-btn .um-btn--ghost .um-btn--sm sizing/spacing — do not redefine button chrome */
}
.um-pagination-info {
    font-size: 12px;
    color: var(--atl-muted-dim);
    white-space: nowrap;
}
.um-pagination-btns .um-page-btn:disabled,
.um-pagination-btns .um-page-btn[aria-disabled="true"] {
    opacity: 0.4;
    cursor: not-allowed;
}
```

Model the actual prev/next/page-info markup on `#newsletterAdmin`'s existing
`#campaignsPagination` block (admin.html 6919–6924) — it already has the right structure
(`#campaignsPrevBtn` / `#campaignsPageInfo` / `#campaignsNextBtn`); just give it a class instead
of relying on inline `style="display:flex"`.

### 6.2 About-tab skeleton (reused by all four phases, content changes per section)

```html
<div id="{section}AboutPanel" class="um-panel">
    <div class="atl-card">
        <div class="um-icon-header" style="margin-bottom:16px;">
            <div class="um-icon-header__icon"><i class="fa-solid fa-circle-info"></i></div>
            <div>
                <h4 class="um-section-label">About This Section</h4>
                <p class="um-section-desc">{one-line purpose statement}</p>
            </div>
        </div>
        <hr class="um-divider" style="margin-top:0;">

        <h5 class="um-section-label" style="font-size:13px;">What this section does</h5>
        <p class="um-section-desc">{2–3 sentences}</p>

        <h5 class="um-section-label" style="font-size:13px; margin-top:18px;">Available controls</h5>
        <ul class="um-security-tips" style="list-style:none; padding-left:0;">
            <!-- one <li> per control, plain language, no jargon -->
        </ul>

        <h5 class="um-section-label" style="font-size:13px; margin-top:18px;">Typical workflow</h5>
        <ol style="color:var(--atl-muted); font-size:13px; line-height:1.7;">
            <!-- numbered steps -->
        </ol>

        <div class="um-security-tips" style="margin-top:18px;">
            <i class="fa-solid fa-shield-halved"></i>
            <span>{any security/operational note specific to this section, or omit the block}</span>
        </div>
    </div>
</div>
```

Add a matching `<button class="atl-tab-btn" data-um-tab="{section}AboutPanel">About</button>` to
each section's tab bar, **always last**. No JS changes required — `initTabs()` already handles
any `.atl-tab-btn` / `.um-panel` pair inside the same container (confirmed §1.1).

### 6.3 Error-handling norm for this prompt's scope

For every `catch` block touched in §7–§10 (fixing D1–D5, D13): replace silent
`console.error`-only catches with a call to `window.notificationService.showError('<specific,
human-readable message>')`, in addition to (not instead of) the `console.error` for debugging.
Do not add a global `window.onerror` listener here — that is an open decision gate in a separate,
already-existing error-handling prompt; this section-level fix is narrower and does not require
that sign-off.

---

## 7. Phase 1 — `#contactAdmin` (simplest; do first)

### 7.1 Current state (confirmed)
Single-record settings form, two cards (Contact Message & Delivery / Manager Details), no list,
no search/filter/sort/bulk/pagination needed — this section genuinely doesn't have multiple
records to manage. Markup: admin.html 6658–6760.

### 7.2 Tasks

**T1 — Fix D1 (silent save/clear failure).** Replace the raw `fetch()` calls in the
`#managerAdminForm` submit handler (9434–9478) and `#managerClearBtn` click handler (9480–9499)
with `apiCall('/api/admin/manager', 'PUT', data)` and `apiCall('/api/admin/manager', 'DELETE')`
respectively, matching the pattern already used correctly by `#contactAdminForm` (9427). Keep the
existing button-text/disabled-state choreography (`Saving...` → `Saved Successfully!` / `Error!`)
— only the underlying call and its error path change.

**T2 — Fix D2 (silent load failure).** In `loadContactData()` (9358) and `loadManagerData()`
(9371), add `window.notificationService.showError('Could not load contact settings — please
refresh.')` / `'...manager details...'` to each catch block, alongside the existing
`console.error`.

**T3 — Backend validation (D3).** Add minimal server-side required-field checks to
`PUT /api/admin/manager` (server.js 8697) mirroring the pattern already used by
`POST /api/admin/contact_info` (8743: `if (!email || !quote || !signature) return res.status(400)...`).
Validate `name`, `email`, `cell_number`, `whatsapp_number` are present and non-empty; return
`400` with a clear `message` on failure. Do not add phone-format validation server-side — that
already happens client-side via `intl-tel-input` (9442–9449) and duplicating it risks
disagreement between the two.

**T4 — About tab.** This section currently has **no tab bar at all** (it's two cards side by
side). Wrap the existing two-card layout in a `socialLinksPanel`-style first tab (call it
`contactConfigPanel`), add the About skeleton (§6.2) as a second tab. Content for the About tab:
explain the Contact form delivery email/quote/signature fields, the Manager Details fields, and
that the "Clear Details" button is destructive and immediate.

### 7.3 Hard constraints specific to this phase
* `#contactDeliveryEmail`, `#contactQuote`, `#contactSig`, `#managerName`, `#managerCell`,
  `#managerWhatsApp`, `#managerEmail` keep their exact IDs — `intl-tel-input` is bound to
  `#managerCell`/`#managerWhatsApp` by element reference (9392–9403); moving them into a new tab
  wrapper is fine, renaming them is not.
* Leave the `localStorage.setItem('tm_contact_data', ...)` line (9424) in place — it's flagged in
  §5 as a decision-gate item, not something to remove unilaterally here.

---

## 8. Phase 2 — `#socialAdmin`

### 8.1 Current state (confirmed)
Tabs already split into Social Links / Media Embeds (6258–6265). Right-column "Current Social
Items" card (6367–6394) sits outside the tab system and lists both link and embed items via
`renderSocialList()` (9694) / `renderEmbedList()` (9839), each backed by real CRUD routes
(server.js 8784–8937).

### 8.2 Tasks

**T1 — Fix D4 + D5 (silent failures).** Add `notificationService.showError(...)` to the catch
blocks in `renderSocialList()` (9732), `renderEmbedList()` (9927), and the `.remove-social-action`
delete handler (9817) — replace the misleading "handled securely" comment with an actual error
surface.

**T2 — Fix D6 (expose `is_active`).** Add an active/inactive toggle to both the add/edit forms
(`#socialIconForm`, `#socialEmbedForm`) and send the real value instead of the hardcoded `true`
(9791, 10010). Render a status badge (`.atl-badge` variant, not a new component) on each list item
in `renderSocialList()`/`renderEmbedList()` reflecting `item.is_active`. This is a frontend-only
fix — the backend already persists and round-trips this field correctly (server.js 8804, 8811,
8918, 8925).

**T3 — Search for list items.** Add a single `.um-search-wrap` search input above each of
"Current Social Items"'s two lists (Social Links, Media Embeds), client-side filtering on
`platform_name` — these lists are small (≤ 19 platforms by the dropdown's own option count) so
client-side filtering is appropriate; do not add a backend search param here.

**T4 — Clean up dead code.** Per the decision in §5.1, either delete D7 (stale `loadSocialData()`
+ orphaned `#socialForm` handler, 8493–8522) outright, or wrap it in a clearly labeled
`/* DEPRECATED — superseded by loadSocialData() at line ~10272, scheduled for removal */` comment
block if Muzi prefers to archive first. Per §5.2, either remove `#clearSocialBtn` (6390–6392) or
implement it as a real bulk "delete all" action with `showConfirm({isDestructive:true})` — follow
whichever the decision gate resolves to.

**T5 — About tab.** Add a third tab to the existing `#socialTabBar` (6258), `data-um-tab="socialAboutPanel"`,
using the §6.2 skeleton. Cover: how platform icons map automatically from the dropdown
(`platformIconMap`, 9737), the embed-code domain-validation rule (9970–9990), and that API keys
typed into the embed form are stored in the browser (flag this plainly to the admin — see §5.4 —
even before any architecture change is made, the About copy should be honest about current
behavior).

### 8.3 Hard constraints specific to this phase
* Do not touch `platformIconMap` or the domain-validation list in `#socialEmbedForm`'s submit
  handler (9970–9990) — out of scope, working correctly.
* `globalSocialData` / `globalEmbedData` array-index-based edit lookups (9825, e.g.) must keep
  working — if you add filtering/search to the rendered list (T3), make sure the `data-index`
  attributes still resolve against the **unfiltered** `globalSocialData`/`globalEmbedData` array,
  not a filtered subset, or edit actions will silently target the wrong item.

---

## 9. Phase 3 — `#inquiriesAdmin`

### 9.1 Current state (confirmed)
Three-pane email client (folder nav / message list / detail panel), 4782–4953. Already has
search (`#inqSearchInput`), folder-based status filtering (All/Unread/Read/Replied/Archived), and
a sort dropdown (`#inqSortSelect`) — all client-side over one full fetch from
`GET /api/admin/inquiries` (no limit/offset, server.js 8585). Genuinely missing: bulk select,
bulk actions, pagination, About tab.

### 9.2 Tasks

**T1 — Bulk select in the message list.** Add a checkbox to each `.inq-row` (rendered in
`renderInqList()`, 10424–10447) and a "select all visible" control in the list toolbar
(`.inq-list-toolbar`, 4835–4849). Model the selection-count bulk bar visually on
`#newsletterAdmin`'s existing `#subscriberBulkBar` (6966–6974) — same `{n} selected` chip +
action buttons pattern, scoped to the inquiries list instead.

**T2 — Bulk actions.** Wire bulk **Mark as Read**, **Archive**, and **Delete** to the selection.
Mark-as-read and Archive both map to the existing single-item
`PUT /api/admin/inquiries/:id/status` route (8592) — call it once per selected ID client-side
**unless** T3 below adds a true bulk route, in which case prefer the bulk route. Delete must use
`window.notificationService.showConfirm({ isDestructive: true })` before firing, matching every
other destructive bulk action in the app (e.g. `#bulkDeleteBtn` in newsletter, 13809–13821).

**T3 — New backend bulk routes (full-stack, not frontend-only).** Add
`PUT /api/admin/inquiries/bulk-status` and `POST /api/admin/inquiries/bulk-delete` to server.js,
directly modeled on the newsletter subscriber bulk routes that already exist and work
(`PUT /api/admin/newsletter/subscribers/bulk-status` and
`POST /api/admin/newsletter/subscribers/bulk-delete`, server.js 4727 / 4750) — same `{ ids: [...] }`
request shape, same `requireAdmin` guard, same `{ success, message }` response shape. This avoids
N sequential single-item calls from the client for bulk operations.

**T4 — Pagination.** Add `page`/`limit`/`status`/`search`/`sort` query-param support to
`GET /api/admin/inquiries`, mirroring `GET /api/admin/campaigns/unified`'s contract exactly
(server.js 8501 — same param names, same `{ data, total, pages }`-shaped response so the frontend
pagination component from §6.1 can be reused without a second contract to learn). On the frontend,
add a `.um-pagination-btns` control (§6.1) below `#inqListBody`. Default page size: confirm with
Muzi per §5.5; this prompt suggests 25.

**T5 — Fix the inconsistent error surfacing.** `loadInquiries()` (10366) already shows an inline
empty-state message on failure (10372/10376) but never calls `notificationService` — add it
alongside the existing inline message so a failure is visible even if the admin isn't looking at
the message-list pane specifically (e.g. they're mid-reply in the detail panel).

**T6 — About tab.** `#inquiriesAdmin` has no tab bar at all today (it's a fixed 3-pane layout, not
a panel-switched one). Do **not** wrap the whole 3-pane client in a tab system — that would be a
disruptive rebuild of a working, non-broken layout. Instead, add a small "About" entry point: a
single `?`/info icon button in `.inq-list-toolbar-right` (4839–4848) that opens the existing
`showAtelierModal()` transformer with the §6.2 content (adapted to a modal body instead of a
`.um-panel`, since there's no tab bar here to attach a panel to). This keeps the fix proportional
to the actual gap instead of restructuring a section that isn't broken.

### 9.3 Hard constraints specific to this phase
* Do not change the 3-pane layout, the folder/status model, or any of `openInquiry()` /
  `showInqComposeView()` / the reply-strip behavior (4860–4948, 10452 onward) — none of that is in
  scope or broken.
* `currentInqFilter`, `currentInqId`, and `allInquiriesCache` (the client-side full-list cache)
  remain — pagination (T4) changes what `loadInquiries()` fetches per page, but the
  filter/search/sort logic in `renderInqList()` (10400) should keep working against whatever page
  of data is currently loaded; don't try to make client-side search/sort operate across
  un-fetched pages — that's a bigger feature than this prompt scopes.

---

## 10. Phase 4 — `#newsletterAdmin` (most complex; do last)

### 10.1 Current state (confirmed)
The most genuinely "crammed" section, confirmed: three functionally dense sub-blocks (Compose,
Campaigns history, Subscriber management) stacked in a raw Bootstrap `row`/`col-md-7`/`col-md-5`
grid (6776–7003) with `data-toggle="collapse"` accordions — not the `.atl-tab-bar`/`.um-panel`
system used everywhere else in this prompt's scope. The Campaigns sub-block (6873–6926) already
has full search/sort/bulk-select/bulk-delete/server-pagination via
`GET /api/admin/campaigns/unified`. The Subscribers sub-block (6930–7000) has search (client-side
DOM filtering only) and bulk select/activate/deactivate/delete/export-CSV against real backend
routes, but **no pagination and no sort**.

### 10.2 Tasks

**T1 — Restructure into tabs (the highest-risk task in this whole prompt).** Replace the
`row`/`col-md-7`/`col-md-5` + collapse-accordion structure with the standard
`.atl-tab-bar` + `.um-panel` pattern (§1.1), three tabs: **Compose**, **Campaigns**,
**Subscribers**, plus a fourth **About** tab (§6.2). Critically:
* Move the *existing* inner markup of each block into its new `.um-panel` wrapper **verbatim** —
  every `id` referenced by JS (`#newsletterForm`, `#newsletterSubject`, `#newsletterEditor`,
  `#campaignsTableBody`, `#subscriberListBody`, `#selectAllSubscribers`, all bulk-bar IDs, etc.)
  must end up unchanged inside its new panel. None of `renderSubscribersList()`,
  `loadCampaigns()`, or the newsletter compose/send handlers should need a single line changed —
  if they do, the restructuring moved an ID it shouldn't have.
  * Remove the now-redundant `data-toggle="collapse"` accordion headers (6788–6791, 6946–6949,
    6874–6879) — the tab system replaces their job. Keep the **content** of `#collapseCampaigns`
    (6880–6925) as the Campaigns panel's body, not the collapse wrapper itself.
* Replace the raw `row`/`col-md-7`/`col-md-5` grid with the token-based `um-grid-2` system already
  used by `#contactAdmin` and `#socialAdmin` (e.g. `um-grid-2 um-grid-2--1-1`) **inside** the
  Compose tab if a two-column compose layout is still wanted, or drop to single-column per tab if
  not — confirm visual intent with Muzi before deciding, but do not leave the raw Bootstrap grid
  classes in place either way (consistency gap noted in §2).

**T2 — Fix D9 (duplicate backend route).** Delete the first, weaker
`DELETE /api/admin/newsletter/subscribers/:id` definition (server.js 4687–4695) and keep the
second one (4716–4724), which adds the `this.changes === 0 → 404` check. Confirm no other code
depends on the first definition's exact response shape (`{ success, message: 'Subscriber removed
successfully' }` vs. the second's `{ success, message: 'Subscriber deleted permanently' }`) before
deleting — check the frontend's delete handler for any string-matching on the message (a quick
grep of `'removed successfully'` / `'deleted permanently'` in admin.html will confirm either way).

**T3 — Fix D10 (dead stub).** Remove `function loadSentCampaigns() {}` (14299) and its
now-unnecessary call site at 14298 (`function loadScheduledList() { loadCampaigns(); }` — confirm
whether `loadScheduledList` itself is still called anywhere before removing it too; if it's dead,
remove it alongside `loadSentCampaigns`).

**T4 — Subscriber pagination + sort.** Add `page`/`limit`/`search`/`sort` query params to
`GET /api/admin/newsletter/subscribers` (server.js 4653), mirroring the
`GET /api/admin/campaigns/unified` contract exactly (same as §9.2/T4's instruction for inquiries —
reuse one contract shape across both new paginated endpoints). Add a sort `<select>`
(Newest/Oldest/Email A–Z/Status) next to the existing `#subscriberSearch` input, and a
`.um-pagination-btns` control (§6.1) below the subscriber table. Keep the existing client-side
`#subscriberSearch` `.each()`/`.hide()` filtering (13744–13754) working **within the currently
loaded page** — full server-side search integration (debounced, re-fetching per keystroke) is a
reasonable stretch goal but not required; if you implement it, debounce at ≥300ms and reuse
`apiCall()`.

**T5 — Fix D12 (legacy badge/button classes).** In `injectSubscribers()` (13701–13740), replace
`label label-success`/`label label-default` with `.atl-badge` + the existing `--active`/`--inactive`-style
status variant already used elsewhere (reuse, don't invent a new badge variant), and replace the
raw `btn btn-sm btn-warning`/`btn-success` toggle button with `.atl-btn`/`.um-btn` equivalents,
preserving the same active/inactive icon-and-title logic (13713–13715).

**T6 — Decision-gated cleanup (D11).** Per §5.3, once confirmed safe, remove the legacy
non-unified `GET /api/admin/campaigns` (server.js 8487–8492). If not confirmed, leave it and just
ensure no new code references it.

### 10.3 Hard constraints specific to this phase
* This phase touches the most shared state of any phase (`campaignsPage`, `campaignsStatus`,
  `campaignsSort`, `campaignsSearch`, `subscribersData`, `window.subscribersData` — confirmed
  globals referenced across 13660–14450). Do the tab-restructuring (T1) **first** and verify every
  existing button/handler still fires correctly in the browser before starting T2–T6 — a markup
  move that silently breaks a `$('#selector')` binding is the single most likely regression in
  this entire prompt.
* Quill editor initialization (`#newsletterEditor`, referenced near the compose form) must still
  target the same container ID after the tab restructuring — Quill binds to the DOM node, not a
  logical reference, so if the panel is hidden via `display:none` at init time (as `.um-panel`
  panels are when inactive), confirm Quill still initializes correctly on a hidden container, or
  initialize it lazily on first tab-open the same way `initTabs()` already lazy-loads
  `umPanelUsers` (17172–17175) — follow that exact precedent if a fix is needed.

---

## 11. Acceptance criteria

- [ ] **Shared foundation (§6):** `.um-pagination-btns` styled and visually consistent wherever
      used (new + existing `#emailLogsAdmin` usage); About-tab skeleton in place verbatim in all
      four sections; every catch block touched in this prompt calls `notificationService.showError`.
- [ ] **`#contactAdmin`:** Manager save/clear failures are now visibly reported, never silently
      reported as success (D1 fixed and manually verified by forcing a 500 from the backend).
      Backend rejects incomplete manager-detail payloads with 400 (D3). About tab present.
- [ ] **`#socialAdmin`:** List-load and delete failures are visible (D4/D5 fixed).
      Active/inactive is settable in the UI and round-trips through the backend correctly (D6).
      Dead code resolved per the §5 decision (D7/D8). About tab present.
- [ ] **`#inquiriesAdmin`:** Bulk select + bulk mark-read/archive/delete work end-to-end against
      real backend routes. Pagination works and matches the campaigns/unified contract shape.
      About entry point present (modal, not a tab — confirmed appropriate per §9.2/T6).
- [ ] **`#newsletterAdmin`:** All three sub-panels are real tabs; every previously-working
      handler (compose/send/schedule/draft, campaigns search/sort/bulk/paginate, subscriber
      add/search/bulk/export/import) still works identically after the restructuring. Duplicate
      route (D9) and dead stub (D10) removed. Subscriber list has sort + pagination + token-based
      badges (D12). About tab present.
- [ ] **Zero functional regressions** anywhere in these four sections — every workflow that
      worked before this prompt still works after it.
- [ ] No new hardcoded hex colors introduced; all new UI uses existing `.atl-*`/`.um-*`
      classes and `--atl-*` tokens (no new bespoke component classes invented).
- [ ] All decision-gate items in §5 were either explicitly resolved with Muzi or left untouched
      pending resolution — none were decided unilaterally.

---

## 12. Test matrix

| Scenario type | `#contactAdmin` | `#socialAdmin` | `#inquiriesAdmin` | `#newsletterAdmin` |
|---|---|---|---|---|
| **Normal** | Save contact config; save manager details; clear manager details — all show correct success state | Add/edit/delete a social link and an embed; toggle active/inactive | Select 3 messages, bulk-archive them; paginate to page 2 | Compose+send a newsletter; switch all 4 tabs; paginate campaigns and subscribers |
| **Edge** | Submit manager form with only some fields filled (client-side blocks it — confirm server also blocks a direct API call with missing fields) | Add a social link with a URL that doesn't match any known domain pattern | Bulk-select across a page boundary, then paginate — confirm selection behavior is intentional (cleared or preserved — pick one, document it) | Switch tabs mid-compose with unsaved draft text — confirm it isn't lost |
| **Failure** | Force a 500 from `PUT /api/admin/manager` — confirm the UI now shows an error, not "Saved Successfully!" (this is the D1 regression test) | Force a 500 from `DELETE /api/admin/social_links/:id` — confirm an error toast appears (D5 regression test) | Force a 500 from the new bulk-status route — confirm partial-failure is communicated, not silently swallowed | Force a 500 from the new paginated subscribers endpoint — confirm error state, not an infinite loading spinner |
| **Regression** | Re-verify `intl-tel-input` still validates phone numbers after any markup move (T4) | Re-verify `platformIconMap` preview and embed domain validation still fire | Re-verify reply/compose/archive single-item actions (pre-existing, not touched) still work | Re-verify Quill editor, file attachments, draft save/load/delete, and schedule-send all still work post-restructuring |

---

## 13. Suggested order of work

1. **§6 Shared foundation** — pagination CSS, About-tab skeleton, error-handling norm. Nothing
   else should start before this lands, since every phase consumes it.
2. **§7 `#contactAdmin`** — smallest surface area, validates the apiCall-migration and
   About-tab patterns cheaply before they're reused three more times.
3. **§8 `#socialAdmin`** — slightly larger, same patterns plus a real backend-already-supports-it
   frontend fix (D6) as a template for similar work elsewhere.
4. **§9 `#inquiriesAdmin`** — introduces the new bulk-route pattern and the pagination contract
   that Phase 4 will reuse.
5. **§10 `#newsletterAdmin`** — last and largest because it both consumes the pagination contract
   proven in Phase 3 and carries the highest structural-regression risk (T1). Do not attempt this
   phase first even though the source brief led with it.
6. **Full §11 + §12 pass** across all four sections together, in both themes if time allows
   (visual theme parity is `atelier-admin-standardization-prompt.md`'s job, but a quick light/dark
   sanity check here costs little and catches obvious breakage early).

> **Pair with:** `atelier-admin-standardization-prompt.md` for the full visual/token migration of
> these same four sections (out of scope here by design) and the existing centralised
> error-handling prompt for the broader `window.onerror` decision gate referenced in §6.3.
