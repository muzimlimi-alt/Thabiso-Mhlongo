# admin.html Structural Map (Phase 1 — Read-Only Reconnaissance)

Generated as part of a housekeeping effort on `admin.html` (repo root), a single-page admin console.
This document is descriptive only — no source files were modified to produce it. Line numbers refer to the
current state of `admin.html` at the time of generation; re-run the extraction if the file changes materially.

File size: 36,233 lines.

---

## 1. Script / Style Blocks

Found **14** inline `<script>` blocks (baseline: 14) and **8** inline `<style>` blocks (baseline: 8) — block *counts* match baseline exactly.

Total inline script content: **1,249,410 chars** (baseline reported 1,228,396). Total inline style content: **291,343 chars** (baseline reported 285,657). The differences (~1.7% and ~2%) are most likely explained by the baseline measurement using a slightly different boundary convention (e.g. trimming or a different tag-matching regex) — the figures below were computed by exact-pairing every literal `<script>`/`<style>` open/close tag in the file (excluding `src=` external tags, and excluding 3 false-positive matches where the literal text `<script>` appears inside a `//` JS comment as prose, at lines 15879, 16594, 18291).

### Inline `<script>` blocks

| # | Start line | End line | Size (chars) |
|---|-----------|----------|---------------|
| 1 | 5 | 10 | 199 |
| 2 | 4967 | 4985 | 1,121 |
| 3 | 12114 | 12114 | 120 |
| 4 | 12116 | 25554 | 818,407 |
| 5 | 25555 | 25581 | 1,450 |
| 6 | 25582 | 25970 | 20,568 |
| 7 | 25972 | 26036 | 2,783 |
| 8 | 28440 | 28453 | 565 |
| 9 | 28454 | 30319 | 99,061 |
| 10 | 30325 | 31736 | 75,043 |
| 11 | 31738 | 31842 | 5,406 |
| 12 | 31848 | 34703 | 181,101 |
| 13 | 34728 | 34779 | 2,244 |
| 14 | 34909 | 35663 | 41,342 |

### Inline `<style>` blocks

| # | Start line | End line | Size (chars) |
|---|-----------|----------|---------------|
| 1 | 38 | 179 | 8,203 |
| 2 | 180 | 186 | 443 |
| 3 | 187 | 572 | 12,927 |
| 4 | 575 | 719 | 5,444 |
| 5 | 722 | 4951 | 221,387 |
| 6 | 5603 | 6044 | 22,525 |
| 7 | 6818 | 6865 | 4,612 |
| 8 | 28140 | 28433 | 15,802 |

### External `<script src=...>` references (not inline — no line-span/size, listed for completeness)

| # | Line | src |
|---|------|-----|
| 1 | 32 | `https://cdn.jsdelivr.net/npm/fullcalendar@6.1.15/index.global.min.js` |
| 2 | 33 | `https://cdn.jsdelivr.net/npm/apexcharts` |
| 3 | 36 | `https://cdn.jsdelivr.net/npm/jsvectormap@1.7.0/dist/jsvectormap.min.js` |
| 4 | 37 | `https://cdn.jsdelivr.net/npm/jsvectormap@1.7.0/dist/maps/world-merc.js` |
| 5 | 12110 | `https://ajax.googleapis.com/ajax/libs/jquery/1.11.1/jquery.min.js` |
| 6 | 12111 | `js/bootstrap.min.js` |
| 7 | 12112 | `https://cdn.jsdelivr.net/npm/flatpickr` |
| 8 | 12113 | `js/myscript.js?v=6` |
| 9 | 12115 | `https://cdnjs.cloudflare.com/ajax/libs/quill/1.3.7/quill.min.js` |
| 10 | 25971 | `https://cdnjs.cloudflare.com/ajax/libs/intl-tel-input/17.0.19/js/intlTelInput.min.js` |
| 11 | 28005 | `https://maps.googleapis.com/maps/api/js?key=AIzaSyD-abP7VjOF8d0Vsr2wJBKU8QeNTgC5osQ&libraries=places&callback=initEventsMap` |
| 12 | 34705 | `js/notificationService.js?v=2.0.2` |

---

## 2. Admin Sections

Found **22** top-level section containers, each a `<div class="admin-section" id="...">` inside the `.tab-content` wrapper (lines ~5100–12106). Visibility is toggled by `window.switchTab(sectionId)`, defined at line 28691, which is invoked from sidebar `.tm-nav-link` anchors (click-delegated at line 28836-28841), dashboard KPI cards, and numerous "jump to X" callbacks elsewhere in the JS.

**Important architectural note on endpoint mapping**: the HTML markup for these 22 sections all lives in one contiguous block (roughly lines 5100-12106), while essentially all of the application JavaScript lives in a handful of much larger `<script>` blocks positioned *after* that markup (from line 12116 onward) -- plus a large second zone of drawer/modal markup (forms, inputs) that is *also* physically separate from the section divs, positioned even later in the file (roughly lines 12200-36232) and shown/hidden via `openAtlDrawer('xDrawer')`/`closeAtlDrawer('xDrawer')`. So a section's "JS scope" is not a contiguous line range -- it is scattered. The endpoint lists below were produced by: (a) locating every literal-URL `fetch(`, the custom `apiCall(url, method, body)` wrapper (the dominant pattern here -- ~211 call sites, far more common than raw `fetch`), and one `XMLHttpRequest`; then (b) tracing each call's enclosing function back to the DOM ids it reads/writes (e.g. `$('#taglineInput')`) or the drawer it is wired to (e.g. `openAtlDrawer('heroDrawer')`), and (c) confirming that DOM id/drawer is only ever opened from within one section's HTML span. No `$.ajax(`/`axios.` calls exist in this file (grepped, zero matches).

| Section id | Sidebar label | Start line | End line (approx.) |
|---|---|---|---|
| `dashboardAdmin` | Dashboard | 5337 | 6048 |
| `usersAdmin` | User Management | 6049 | 6502 |
| `inquiriesAdmin` | Inquiries | 6503 | 6701 |
| `bookingsAdmin` | Bookings | 6702 | 7339 |
| `calendarAdmin` | Unified Calendar | 7340 | 7564 |
| `financeAdmin` | Financials | 7565 | 8200 |
| `servicesAdmin` | Services Catalogue | 8201 | 8682 |
| `policiesAdmin` | Booking Policies | 8683 | 9056 |
| `homeAdmin` | Home Slider | 9057 | 9171 |
| `aboutAdmin` | About Me | 9172 | 9401 |
| `careerAdmin` | Career Highlights | 9402 | 9516 |
| `footprintAdmin` | Footprint | 9517 | 9566 |
| `testimonialsAdmin` | Testimonials | 9567 | 9649 |
| `galleryAdmin` | Gallery | 9650 | 9756 |
| `socialAdmin` | Social Media | 9757 | 10127 |
| `eventsAdmin` | Upcoming Events | 10128 | 10289 |
| `contactAdmin` | Contact Me | 10290 | 10478 |
| `newsletterAdmin` | Newsletter | 10479 | 11002 |
| `preferencesAdmin` | System Settings | 11003 | 11243 |
| `brandingAdmin` | Branding | 11244 | 11654 |
| `emailLogsAdmin` | Email Logs | 11655 | 11825 |
| `securityAdmin` | Security & Audit | 11826 | 12109 |

### Endpoints per section

#### `dashboardAdmin` (Dashboard)
- GET /api/admin/analytics/summary?period=
- GET /api/admin/analytics/visits-over-time?period=
- GET /api/admin/analytics/traffic-sources?period=
- GET /api/admin/analytics/devices?period=
- GET /api/admin/analytics/countries?period=
- GET /api/admin/analytics/top-pages?period=
- GET /api/admin/analytics/bookings-trend?period=
- GET /api/admin/analytics/todays-schedule
- GET /api/admin/dashboard/social_kpis (read-only display widget; configured in Social Media section)

#### `usersAdmin` (User Management)
- GET /api/admin/users
- POST /api/admin/users
- PUT /api/admin/users/:id
- DELETE /api/admin/users/:id
- GET /api/admin/user-login-logs (Login Activity tab)

#### `inquiriesAdmin` (Inquiries)
- GET /api/admin/inquiries?page=&limit=
- GET/PUT/DELETE /api/admin/inquiries/:id
- PUT /api/admin/inquiries/bulk-status
- DELETE /api/admin/inquiries/bulk-delete
- GET /api/admin/inquiries/assignable-admins
- GET /api/admin/inquiries/categories
- GET/POST /api/admin/direct-emails, GET/PUT/DELETE /api/admin/direct-emails/:id
- POST /api/admin/direct-emails/preview
- POST /api/admin/direct-emails/upload (XMLHttpRequest, for progress bar — see line 18886)
- GET /api/admin/bookings/full (cross-reference when linking an inquiry to a booking)

#### `bookingsAdmin` (Bookings)
- GET /api/admin/bookings/ (list, pipeline/archive)
- GET /api/admin/bookings/full
- GET/PUT /api/admin/bookings/:id
- PUT /api/admin/bookings/:id/status
- PUT /api/admin/bookings/:id/disposition
- POST /api/admin/bookings/:id/complete
- POST /api/admin/bookings/:id/refund
- POST /api/admin/bookings/:id/cancel
- POST /api/admin/bookings/:id/contract/send
- GET /api/admin/bookings/:id/contract
- POST /api/admin/bookings/:id/contract (upload)
- POST /api/admin/bookings/:id/contract/remind
- POST /api/admin/bookings/:id/contract/sign
- POST /api/admin/bookings/:id/resend-quote
- POST /api/admin/bookings/:id/resend-confirmation
- POST /api/admin/bookings/:id/sync-calendar
- GET/POST/DELETE /api/admin/bookings/:id/notes, /notes/:noteId
- GET/POST /api/admin/bookings/:id/communications
- POST /api/admin/bookings/:id/review-request
- PATCH /api/admin/bookings/:id/venue
- PATCH /api/admin/bookings/:id/venue-google
- GET/PUT /api/admin/bookings/:id/public
- POST /api/admin/bookings/:id/reopen
- POST /api/admin/bookings/:id/book-again
- PUT /api/admin/bookings/:id/buffer
- GET/PUT /api/admin/bookings/:id/payment-schedules
- POST /api/admin/bookings/:id/manual-payment
- GET /api/admin/bookings/:id/cancellation-preview
- GET /api/admin/bookings/:bookingId/financials
- POST /api/admin/bookings/bulk-remind
- GET /api/admin/bookings/:id/quote
- GET/PUT /api/admin/advancing/run-of-show/:id, /api/admin/advancing/contacts/:id
- GET /api/admin/abandoned-bookings, /stats; PUT /api/admin/abandoned-bookings/:id/status (Booking Recovery tab)
- DELETE /api/admin/calendar/hold/:id (releasing a hold from booking flow)
- POST /upload (contract file attachments)

#### `calendarAdmin` (Unified Calendar)
- GET /api/admin/calendar/events
- POST /api/admin/calendar/hold
- DELETE /api/admin/calendar/hold/:id
- PUT /api/admin/calendar/hold/:id/date (drag-to-reschedule)
- PUT /api/admin/events/:id/date (drag-to-reschedule)
- PUT /api/admin/bookings/:id/date (drag-to-reschedule)
- GET/PUT /api/admin/working-hours
- GET /api/admin/services?active_only=1 (filter dropdown)

#### `financeAdmin` (Financials)
- GET/POST/PUT/DELETE /api/admin/expenses, /api/admin/expenses/:id
- POST /api/admin/expenses/upload-receipt
- POST /api/admin/bank-statement/import
- GET /api/admin/bank-statement/lines?
- DELETE /api/admin/bank-statement/batch/:id
- PUT/DELETE /api/admin/bank-statement/lines/:id
- POST /api/admin/transactions/manual
- PUT /api/admin/transactions/:txId/reconcile
- GET /api/admin/reconciliation, /api/admin/reconciliation/:bookingId/transactions
- POST /api/admin/bookings/:bookingId/reconcile/sync
- GET/POST /api/admin/invoices, GET/PUT /api/admin/invoices/:id
- POST /api/admin/invoices/bulk-send-unsent
- POST /api/admin/bookings/:bookingId/invoice/generate
- GET /api/admin/reminders?limit=200
- POST /api/admin/reminders/run
- GET/PUT /api/admin/bookings/:bookingId/payment-schedules
- GET /api/admin/payment-schedules/mismatches
- GET /api/admin/financials/stats?date_from=&date_to=
- GET /api/admin/financials/analytics
- GET /api/admin/bookings (dropdown for manual transaction linking)

#### `servicesAdmin` (Services Catalogue)
- GET /api/admin/services (?include_deleted=1)
- POST /api/admin/services
- PUT/DELETE /api/admin/services/:id

#### `policiesAdmin` (Booking Policies)
- GET/PUT /api/admin/policies
- GET/PUT /api/admin/legal/documents/:type
- GET /api/admin/legal/overview
- GET /api/admin/legal/consent-audit?page=
- GET /api/admin/legal/contracts?page=
- GET /api/admin/bookings/ (Contract Registry → view linked booking)

#### `homeAdmin` (Home Slider)
- GET/POST /api/admin/home-slider
- DELETE /api/admin/home-slider/:id
- PUT /api/admin/home-slider/reorder
- POST /upload (slide images)

#### `aboutAdmin` (About Me)
- GET/PUT /api/admin/about-me (photo + biography)
- GET/PUT /api/admin/site-content (hero tagline/subtitle, announcement bar, features strip, "What I Do" services teaser)
- GET /api/public/site-content (live-preview hydration)
- POST /upload (profile photo)

#### `careerAdmin` (Career Highlights)
- GET/POST /api/admin/highlights
- PUT/DELETE /api/admin/highlights/:id
- POST /upload (fallback image)

#### `footprintAdmin` (Footprint)
- GET/POST /api/admin/footprint
- PUT/DELETE /api/admin/footprint/:id
- POST /upload

#### `testimonialsAdmin` (Testimonials)
- GET/POST /api/admin/testimonials
- PUT/DELETE /api/admin/testimonials/:id

#### `galleryAdmin` (Gallery)
- GET/POST /api/admin/gallery
- PUT/DELETE /api/admin/gallery/:id
- PUT /api/admin/gallery/reorder
- GET /api/public/gallery (live-preview hydration)

#### `socialAdmin` (Social Media)
- GET/POST /api/admin/social_links
- PUT/DELETE /api/admin/social_links/:id
- GET/POST /api/admin/social_embeds
- PUT/DELETE /api/admin/social_embeds/:id
- GET/POST /api/admin/dashboard/social_kpis (configure follower counts shown on Dashboard)
- External (non-backend) oEmbed/metadata lookups for embed previews: https://noembed.com/embed, https://api.microlink.io, https://www.googleapis.com/youtube/v3/videos, https://api.vimeo.com/videos/:id, https://graph.facebook.com/v19.0/:id, https://www.tiktok.com/oembed

#### `eventsAdmin` (Upcoming Events)
- GET/POST /api/admin/events
- PUT/DELETE /api/admin/events/:id

#### `contactAdmin` (Contact Me)
- GET/PUT /api/admin/contact_info
- GET /api/public/contact_info (live-preview)
- GET/PUT /api/admin/manager
- GET /api/public/manager (live-preview)

#### `newsletterAdmin` (Newsletter)
- GET /api/admin/newsletter/subscribers?, GET stats, PUT bulk-status, DELETE bulk-delete
- GET/PUT/DELETE /api/admin/newsletter/subscribers/:id, /:id/status
- POST /api/admin/newsletter/subscribers/import
- GET/POST /api/admin/newsletter/birthday-settings
- POST /api/admin/newsletter/birthday-settings/preview
- POST /api/admin/newsletter/birthday-settings/send-test
- GET/POST /api/admin/newsletter/drafts, PUT /api/admin/newsletter/drafts/:id
- POST /api/admin/newsletter/preview
- PUT /api/admin/newsletter/schedule/:id
- GET /api/admin/campaigns (unified list, ?page=&status=&sort=&search=)
- POST /api/admin/campaigns
- POST /api/admin/campaigns/send-test
- POST /api/admin/campaigns/bulk-delete
- GET /api/admin/newsletter/campaigns/audience-count?
- GET /api/admin/email-logs?search=, ?trigger= (per-campaign delivery log lookups)

#### `preferencesAdmin` (System Settings)
- GET/PUT /api/admin/settings (System Settings tab)
- POST /api/admin/settings/test-notification
- GET/PUT /api/admin/site-content (section_visibility toggles — Website Sections tab; shares the endpoint used by About Me’s content editors)

#### `brandingAdmin` (Branding)
- GET/PUT /api/admin/branding (identity + site settings)
- GET/POST /api/admin/banners, GET/PUT/DELETE /api/admin/banners/:id
- GET/POST /api/admin/email-templates, GET /api/admin/email-templates/:key/preview, PUT /api/admin/email-templates/assign
- POST /upload (logo, favicon, login background)

#### `emailLogsAdmin` (Email Logs)
- GET /api/admin/email-logs?... (paginated listing with search/trigger/date filters)

#### `securityAdmin` (Security & Audit)
- GET /api/admin/audit_log?table=&record_id=&limit=, ?... (bulk query builder)
- GET /api/admin/popia/requests?..., ?status=pending&limit=1

#### Global / cross-cutting (not owned by one section)

- POST /api/admin/login
- POST /api/admin/logout
- GET /api/admin/session
- GET /api/admin/session/heartbeat
- POST /api/admin/forgot-password
- POST /api/admin/force-change-password (forced password reset modal, shown pre-admin-shell)
- GET /api/public/branding (site branding used for the login screen and admin header/favicon)
- POST /upload (generic multipart upload endpoint reused by many sections above; Multer route keyed by a "section" form field)

---

## 3. Inline-Script Functions

Found **528** function-definition matches (**512** distinct names — some names are defined more than once across the file's separate `<script>` scopes, e.g. re-declared per block) across the 14 inline `<script>` blocks, using patterns: `function name(...)`, `const/let/var name = function...`, `const/let/var name = (...) => `, `const/let/var name = x =>`, `window.name = function...`, and `window.name = (...) =>`.

<details><summary>Full list of function definitions (click to expand — large table)</summary>

| Line | Name | Definition style |
|---|---|---|
| 12118 | `qs` | window.x = (..) => |
| 12119 | `qsa` | window.x = (..) => |
| 12120 | `escHtml` | window.x = (..) => |
| 12127 | `renderMetaFooterHtml` | window.x = function |
| 12147 | `showMetaFooter` | window.x = function |
| 12178 | `applyLastUpdatedMeta` | window.x = function |
| 12198 | `showAtelierModal` | window.x = function |
| 12274 | `focusables` | const/let/var = (..) => |
| 12310 | `hideAtelierModal` | window.x = function |
| 12363 | `statusColors` | window.x = function |
| 12390 | `updatePills` | window.x = function |
| 12449 | `initThemeToggleUI` | function decl |
| 12467 | `renderInlineContractPanel` | function decl |
| 12476 | `genBtn` | const/let/var = function |
| 12480 | `sendBtn` | const/let/var = function |
| 12553 | `ctbField` | function decl |
| 12559 | `ctbCollectClauses` | function decl |
| 12571 | `buildContractEditorPanel` | function decl |
| 12576 | `money` | const/let/var = function |
| 12743 | `renderInlineCancellationPanel` | function decl |
| 12765 | `loadDealViewTimelineData` | function decl |
| 12789 | `advReloadPanel` | function decl |
| 12811 | `loadDealViewAdvancingData` | function decl |
| 12815 | `advCollectFields` | function decl |
| 12825 | `dvActivateTab` | function decl |
| 13035 | `toggleBookingDetail` | window.x = function |
| 13057 | `dvRenderFromRow` | function decl |
| 13288 | `fmtTlWhen` | const/let/var = function |
| 13356 | `refreshDealView` | window.x = function |
| 13382 | `initBookingVenueAutocomplete` | window.x = function |
| 13462 | `uploadFileToServer` | function decl |
| 13478 | `uploadHomeFiles` | function decl |
| 13522 | `fetchHomeSlider` | function decl |
| 13532 | `renderHomeList` | function decl |
| 13584 | `initDraggableSlider` | function decl |
| 13636 | `resetHomeForm` | function decl |
| 13647 | `applyHomeToEditor` | function decl |
| 13660 | `openHomeCreateDrawer` | window.x = function |
| 13665 | `openHomeEditDrawer` | window.x = function |
| 13672 | `homeCancelEdit` | window.x = function |
| 13780 | `updateAboutPreview` | function decl |
| 13797 | `loadAboutData` | function decl |
| 13932 | `siteEsc` | function decl |
| 13934 | `loadSiteContent` | function decl |
| 13964 | `buildSvcCardEditors` | function decl |
| 13982 | `collectSvcItems` | function decl |
| 13994 | `renderHeroPreview` | function decl |
| 14001 | `renderAnnouncePreview` | function decl |
| 14015 | `renderSvcPreview` | function decl |
| 14034 | `buildFeatEditors` | function decl |
| 14047 | `collectFeatItems` | function decl |
| 14058 | `renderFeatPreview` | function decl |
| 14161 | `secEsc` | function decl |
| 14163 | `renderSectionsUI` | function decl |
| 14191 | `secSetToggle` | function decl |
| 14198 | `loadSectionVisibility` | function decl |
| 14219 | `secFilter` | function decl |
| 14240 | `saveSectionVisibility` | function decl |
| 14312 | `getEventsData` | function decl |
| 14322 | `renderEventsList` | function decl |
| 14503 | `eventsApplySearch` | function decl |
| 14515 | `evtGetSelectedIds` | function decl |
| 14518 | `evtUpdateBulkBar` | function decl |
| 14660 | `openCancelEventModal` | window.x = function |
| 14693 | `applyEventToEditor` | function decl |
| 14783 | `atlActivateDrawerTab` | window.x = function |
| 14796 | `resetEventForm` | function decl |
| 14815 | `openEvtCreateDrawer` | window.x = function |
| 14824 | `openEvtEditDrawer` | window.x = function |
| 14832 | `cancelEventEdit` | function decl |
| 14910 | `submitAPIEvent` | const/let/var = function |
| 15053 | `initEventsPickers` | window.x = function |
| 15098 | `_fpDate` | function decl |
| 15102 | `_fpTime` | function decl |
| 15106 | `_fpDateTime` | function decl |
| 15113 | `initAdminDateTimePickers` | window.x = function |
| 15125 | `initEventsMap` | window.x = function |
| 15152 | `initCareerYears` | function decl |
| 15168 | `loadHighlights` | function decl |
| 15244 | `resetCareerForm` | function decl |
| 15262 | `applyCareerToEditor` | function decl |
| 15305 | `openCareerCreateDrawer` | window.x = function |
| 15311 | `openCareerEditDrawer` | window.x = function |
| 15320 | `careerCancelEdit` | window.x = function |
| 15672 | `resetFootprintForm` | function decl |
| 15685 | `openFootprintEditor` | function decl |
| 15705 | `loadFootprint` | function decl |
| 15843 | `resetTestimonialsForm` | function decl |
| 15859 | `openTestimonialEditor` | function decl |
| 15880 | `tsThumbFallback` | window.x = function |
| 15891 | `loadTestimonials` | function decl |
| 16123 | `isValidEmail` | function decl |
| 16131 | `loadContactData` | function decl |
| 16145 | `loadManagerData` | function decl |
| 16285 | `loadGallery` | function decl |
| 16363 | `initDraggableGallery` | function decl |
| 16432 | `resetGalleryForm` | function decl |
| 16448 | `applyGalleryToEditor` | function decl |
| 16466 | `openGalleryCreateDrawer` | window.x = function |
| 16471 | `openGalleryEditDrawer` | window.x = function |
| 16478 | `galleryCancelEdit` | window.x = function |
| 16613 | `initBnrLibrary` | window.x = function |
| 16631 | `showBnrView` | window.x = function |
| 16649 | `setBnrPreviewWidth` | window.x = function |
| 16656 | `loadBnrPreview` | window.x = function |
| 16674 | `onBnrSearchInput` | window.x = function |
| 16679 | `clearBnrFilters` | window.x = function |
| 16686 | `reloadBnrBanners` | window.x = function |
| 16692 | `loadMoreBnrBanners` | window.x = function |
| 16697 | `loadBnrBanners` | function decl |
| 16718 | `bnrStatusBadgeHtml` | function decl |
| 16724 | `renderBnrCards` | function decl |
| 16762 | `resetBnrForm` | function decl |
| 16774 | `openBnrCreateDrawer` | window.x = function |
| 16779 | `openBnrEditDrawer` | window.x = function |
| 16798 | `onBnrImageFileChange` | window.x = function |
| 16902 | `archiveBnrBanner` | window.x = function |
| 16923 | `restoreBnrBanner` | window.x = function |
| 16940 | `openBnrAssignDrawer` | window.x = function |
| 16982 | `applyBnrAssignments` | window.x = function |
| 17032 | `renderSocialList` | function decl |
| 17111 | `openSocialLinkDrawer` | window.x = function |
| 17195 | `umFilterSocialList` | function decl |
| 17207 | `renderEmbedList` | function decl |
| 17218 | `escapeHtml` | function decl |
| 17328 | `openSocialEmbedDrawer` | window.x = function |
| 17376 | `finishSave` | function decl |
| 17401 | `generateMockMetadata` | function decl |
| 17424 | `fetchNoEmbedFallback` | function decl |
| 17461 | `fetchMicrolinkFallback` | function decl |
| 17651 | `loadSocialData` | function decl |
| 17657 | `loadSocialKpiSettings` | function decl |
| 17674 | `secret` | function decl |
| 17805 | `toggleKpiFields` | window.x = function |
| 17839 | `saveSocialKpiSettings` | window.x = function |
| 17965 | `abEsc` | function decl |
| 17966 | `abStageLabel` | function decl |
| 17967 | `abStatusBadge` | function decl |
| 17980 | `abTimeAgo` | function decl |
| 17993 | `abSetTabCount` | function decl |
| 17999 | `updateAbTabCount` | function decl |
| 18006 | `abRenderFunnel` | function decl |
| 18024 | `loadAbandonedStats` | function decl |
| 18038 | `loadAbandonedBookings` | function decl |
| 18064 | `renderAbandonedTable` | function decl |
| 18090 | `abCloseDrawer` | window.x = function |
| 18096 | `openAbandonedDetail` | function decl |
| 18193 | `apiCall` | function decl |
| 18237 | `loadInqAssignableAdmins` | function decl |
| 18254 | `loadInqCategories` | function decl |
| 18269 | `inqIsToday` | function decl |
| 18274 | `inqFormatDate` | function decl |
| 18282 | `inqStatusBadgeClass` | function decl |
| 18286 | `inqStatusLabel` | function decl |
| 18294 | `loadInquiries` | function decl |
| 18364 | `inqAdjustCounts` | function decl |
| 18370 | `renderInqCounts` | function decl |
| 18382 | `renderDirectEmailsList` | function decl |
| 18429 | `inqUpdatePagination` | function decl |
| 18442 | `renderInqList` | function decl |
| 18503 | `openInquiry` | function decl |
| 18593 | `showInqComposeView` | function decl |
| 18673 | `initInqComposeQuill` | function decl |
| 18753 | `setupInqChipInput` | function decl |
| 18786 | `addRecipientChip` | function decl |
| 18794 | `removeRecipientChip` | function decl |
| 18802 | `renderRecipientChips` | function decl |
| 18822 | `initInqAttachmentUpload` | function decl |
| 18857 | `handleInqFiles` | function decl |
| 18864 | `uploadInqAttachment` | function decl |
| 18932 | `renderInqAttachments` | function decl |
| 18962 | `initInqSchedulePicker` | function decl |
| 18977 | `autosaveInqDraft` | function decl |
| 19015 | `openDirectEmailDraft` | function decl |
| 19098 | `applyInqTemplate` | function decl |
| 19120 | `closeEmailPreviewModal` | window.x = function |
| 19124 | `inqCloseDetail` | function decl |
| 19214 | `getSelectedInqIds` | function decl |
| 19218 | `updateInqBulkBar` | function decl |
| 19238 | `inqBulkStatus` | function decl |
| 19354 | `renderInqNotes` | function decl |
| 19377 | `loadInqNotes` | function decl |
| 19514 | `previewComposedEmail` | function decl |
| 19544 | `sendOrScheduleComposedEmail` | function decl |
| 19635 | `loadBookings` | function decl |
| 19675 | `formatQuoteDetails` | function decl |
| 19695 | `formatQuoteDetailsAtelier` | function decl |
| 19783 | `formatInvoiceDetailsAtelier` | function decl |
| 19881 | `computeNextStepHint` | function decl |
| 19911 | `hint` | const/let/var = (..) => |
| 19973 | `renderNextStepCallout` | function decl |
| 19993 | `renderSubmissionAgeLine` | function decl |
| 20011 | `computeDaysUntilEventBadge` | function decl |
| 20030 | `computeBookingProgressChecklist` | function decl |
| 20077 | `buildProgressTagsCard` | function decl |
| 20122 | `buildProgressPanel` | function decl |
| 20134 | `renderGroup` | function decl |
| 20154 | `buildOverviewPanel` | function decl |
| 20400 | `buildOfferPanel` | function decl |
| 20430 | `buildInvoicesPanel` | function decl |
| 20473 | `buildTimelinePanel` | function decl |
| 20582 | `formatFileSize` | function decl |
| 20591 | `attachmentIcon` | function decl |
| 20603 | `buildFilesPanel` | function decl |
| 20657 | `buildAdvancingStub` | function decl |
| 20680 | `advField` | function decl |
| 20691 | `buildAdvancingPanel` | function decl |
| 20810 | `renderBookingsTable` | function decl |
| 21108 | `saveQuoteDraft` | window.x = function |
| 21153 | `triggerAutoSave` | window.x = function |
| 21226 | `sleep` | const/let/var = x => |
| 21292 | `fmtAmt` | const/let/var = x => |
| 21293 | `fmtDate` | const/let/var = x => |
| 21389 | `formatDuration` | function decl |
| 21399 | `_applyQbTermsSource` | function decl |
| 21425 | `fetchServicesForQuote` | function decl |
| 21500 | `addQuoteItem` | window.x = function |
| 21570 | `calcQuoteTotal` | function decl |
| 21615 | `_fmtR` | const/let/var = x => |
| 21616 | `_fmtDate` | const/let/var = x => |
| 21723 | `performQuoteSubmit` | function decl |
| 21778 | `bkContractFinalised` | function decl |
| 21781 | `bkUnsignedContractNote` | function decl |
| 22131 | `renderCommsThread` | function decl |
| 22159 | `renderNotesThread` | function decl |
| 22305 | `renderContractStatus` | function decl |
| 22556 | `loadExpensesTab` | window.x = function |
| 22612 | `hexToRgb` | function decl |
| 22618 | `deleteExpense` | window.x = function |
| 22639 | `loadBookingPL` | function decl |
| 22667 | `openExpenseModal` | window.x = function |
| 22687 | `populateExpenseBookingList` | function decl |
| 22732 | `calcMileageAmount` | function decl |
| 22744 | `calcPerDiemAmount` | function decl |
| 22827 | `editExpense` | window.x = function |
| 22954 | `loadBankLines` | window.x = function |
| 23049 | `deleteBankLine` | window.x = function |
| 23055 | `unmatchBankLine` | window.x = function |
| 23061 | `openBankMatchRow` | window.x = function |
| 23081 | `confirmBankMatch` | window.x = function |
| 23092 | `R_FMT` | const/let/var = (..) => |
| 23094 | `loadReconciliation` | window.x = function |
| 23179 | `toggleReconDetail` | window.x = function |
| 23267 | `syncBookingLedger` | window.x = function |
| 23303 | `saveReconNote` | window.x = function |
| 23312 | `updatePromotePanel` | function decl |
| 23485 | `bookingNeedsAction` | function decl |
| 23510 | `bkFeeValue` | function decl |
| 23519 | `bkEventDateValue` | function decl |
| 23522 | `bkSortRows` | function decl |
| 23550 | `bkPaginate` | function decl |
| 23561 | `applyBookingFilter` | function decl |
| 23638 | `applyArchiveFilter` | function decl |
| 23710 | `bkSelectedIds` | function decl |
| 23713 | `bkUpdateBulkCount` | function decl |
| 23738 | `esc` | const/let/var = function |
| 24168 | `subscribersEmptyState` | function decl |
| 24172 | `renderSubscribersList` | function decl |
| 24229 | `renderSubscribersPaginationNumbered` | function decl |
| 24261 | `toggleSubscriberSort` | window.x = function |
| 24272 | `updateSortIconsSubscribers` | function decl |
| 24280 | `loadSubscriberStats` | function decl |
| 24291 | `injectSubscribers` | function decl |
| 24371 | `updateBulkBar` | function decl |
| 24440 | `getCheckedIds` | function decl |
| 24447 | `_setImportFile` | function decl |
| 24458 | `_resetImportModal` | function decl |
| 24584 | `exportSubscribersCSV` | function decl |
| 24662 | `populateSubscriberBirthdaySelects` | function decl |
| 24743 | `initBirthdayBodyQuill` | function decl |
| 24749 | `collectBirthdayFormData` | function decl |
| 24761 | `loadBirthdaySettings` | window.x = function |
| 24784 | `loadBirthdayRecentSends` | function decl |
| 24886 | `insertMergeField` | function decl |
| 24920 | `getSelectedAudience` | function decl |
| 24929 | `audienceLabel` | function decl |
| 24933 | `updateAudienceValueVisibility` | function decl |
| 24945 | `refreshAudienceCount` | function decl |
| 25070 | `loadDraftsList` | function decl |
| 25136 | `renderAttachmentChips` | function decl |
| 25278 | `loadScheduledList` | function decl |
| 25284 | `updateCampaignsBulkBar` | function decl |
| 25298 | `loadCampaigns` | function decl |
| 25350 | `renderCampaignsPaginationNumbered` | function decl |
| 25418 | `viewCampaignDeliveryLog` | function decl |
| 25513 | `pad` | const/let/var = x => |
| 25597 | `loadDashboardKPIs` | function decl |
| 25653 | `applyRoleGating` | function decl |
| 25925 | `autoLogout` | function decl |
| 25939 | `resetTimer` | function decl |
| 25952 | `onbeforeunload` | window.x = function |
| 25958 | `startAdminHeartbeat` | function decl |
| 25960 | `sendHeartbeat` | const/let/var = (..) => |
| 25973 | `toggleForgotPassword` | function decl |
| 28441 | `showOverdueInvoices` | function decl |
| 28445 | `showDueSoonInvoices` | function decl |
| 28449 | `showUnsentInvoices` | function decl |
| 28459 | `qs` | function decl |
| 28460 | `qsa` | function decl |
| 28467 | `toggleSidebar` | function decl |
| 28494 | `openMobileSidebar` | function decl |
| 28502 | `closeMobileSidebar` | function decl |
| 28537 | `timeAgo` | function decl |
| 28557 | `positionDropdown` | function decl |
| 28580 | `closeAllDropdowns` | function decl |
| 28591 | `menuItems` | function decl |
| 28691 | `switchTab` | window.x = function |
| 28821 | `updateBreadcrumb` | function decl |
| 28853 | `updateProfileDisplay` | function decl |
| 28895 | `_calSwitchToList` | window.x = function |
| 28899 | `_applyCalFilter` | function decl |
| 28908 | `handleRemoveHold` | window.x = function |
| 28926 | `showCalEventPopup` | function decl |
| 29003 | `dismiss` | function decl |
| 29006 | `initAdminCalendar` | function decl |
| 29236 | `initMiniCalendar` | function decl |
| 29243 | `render` | function decl |
| 29279 | `activateCell` | const/let/var = (..) => |
| 29295 | `refreshEventDots` | function decl |
| 29312 | `renderWorkingSchedule` | function decl |
| 29431 | `loadServicesForManualBooking` | function decl |
| 29442 | `addMbServiceRow` | function decl |
| 29495 | `recalcMbTotals` | function decl |
| 29591 | `inqConvertToBooking` | window.x = function |
| 29645 | `showMbAlert` | const/let/var = function |
| 29727 | `performSubmit` | function decl |
| 29869 | `boLoadCustomCategories` | function decl |
| 29872 | `boSaveCustomCategories` | function decl |
| 29875 | `boPopulateCategorySelect` | function decl |
| 29890 | `openBlockOutModal` | function decl |
| 30028 | `buildNotifications` | function decl |
| 30206 | `runSearch` | function decl |
| 30314 | `escHtml` | function decl |
| 30326 | `initUserManagement` | function decl |
| 30330 | `qs` | function decl |
| 30331 | `qsa` | function decl |
| 30332 | `esc` | function decl |
| 30333 | `initial` | function decl |
| 30334 | `fmtDate` | function decl |
| 30340 | `showFeedback` | function decl |
| 30359 | `initTabs` | function decl |
| 30393 | `initProfile` | function decl |
| 30505 | `initPasswordPanel` | function decl |
| 30536 | `checkMatch` | function decl |
| 30545 | `updateStrength` | function decl |
| 30612 | `umCloseDrawer` | function decl |
| 30617 | `umResetDrawer` | function decl |
| 30631 | `umSetFieldErr` | function decl |
| 30635 | `umClearUserFieldErrs` | function decl |
| 30640 | `umRenderStrength` | function decl |
| 30663 | `umOpenDrawer` | function decl |
| 30736 | `initManageUsers` | function decl |
| 30857 | `umDisplayName` | function decl |
| 30859 | `loadAllUsers` | function decl |
| 30875 | `getUsersView` | function decl |
| 30908 | `renderUsersTable` | function decl |
| 31073 | `renderUserPagination` | function decl |
| 31104 | `toggleUserSort` | window.x = function |
| 31115 | `updateSortIconsUsers` | function decl |
| 31122 | `eligibleIdsOnPage` | function decl |
| 31125 | `updateSelectAllState` | function decl |
| 31133 | `selectedCount` | function decl |
| 31134 | `updateBulkBar` | function decl |
| 31142 | `deleteUsers` | function decl |
| 31173 | `umUpdateUser` | function decl |
| 31200 | `umBulkSetActive` | function decl |
| 31239 | `initUsersBulkControls` | function decl |
| 31285 | `loadEmailLogs` | window.x = function |
| 31331 | `escape` | const/let/var = (..) => |
| 31368 | `renderLogPagination` | function decl |
| 31408 | `toggleLogSort` | window.x = function |
| 31419 | `updateSortIcons` | function decl |
| 31431 | `applyLogFilters` | window.x = function |
| 31438 | `debounceLogSearch` | window.x = function |
| 31454 | `initManageLogs` | function decl |
| 31484 | `loadAllLogs` | function decl |
| 31500 | `getLogsView` | function decl |
| 31534 | `formatDuration` | function decl |
| 31549 | `formatUserAgent` | function decl |
| 31569 | `formatDateTimeLocal` | function decl |
| 31573 | `pad` | const/let/var = function |
| 31581 | `renderLogsTable` | function decl |
| 31636 | `renderLogPagination` | function decl |
| 31665 | `toggleLogSort` | window.x = function |
| 31676 | `updateSortIconsLogs` | function decl |
| 31688 | `initEmailLogs` | function decl |
| 31700 | `bootstrap` | function decl |
| 31849 | `initFinanceManagement` | function decl |
| 31859 | `fmtCurr` | function decl |
| 31864 | `getPeriodDates` | function decl |
| 31897 | `onFinPeriodPresetChange` | window.x = function |
| 31908 | `loadFinancialStats` | window.x = function |
| 32014 | `renderTransactions` | function decl |
| 32067 | `filterTransactions` | window.x = function |
| 32089 | `renderInvoices` | function decl |
| 32094 | `loadRemindersLog` | window.x = function |
| 32133 | `applyInvoiceFilter` | window.x = function |
| 32187 | `sendInvoice` | window.x = function |
| 32214 | `sendQuoteFromCard` | window.x = function |
| 32222 | `resendQuoteFromCard` | window.x = function |
| 32230 | `sendOrResendInvoiceFromCard` | window.x = function |
| 32234 | `voidInvoice` | window.x = function |
| 32255 | `markInvoicePaid` | window.x = function |
| 32276 | `generateInvoice` | window.x = function |
| 32299 | `openGenerateInvoiceModal` | window.x = function |
| 32361 | `loadFinAnalytics` | window.x = function |
| 32472 | `finApexBase` | function decl |
| 32481 | `finEsc` | function decl |
| 32489 | `renderFinExtraCharts` | function decl |
| 32551 | `loadBookingPaymentSchedule` | window.x = function |
| 32656 | `loadScheduleMismatches` | window.x = function |
| 32668 | `money` | const/let/var = function |
| 32669 | `esc` | const/let/var = function |
| 32693 | `showPaymentScheduleEditor` | window.x = function |
| 32773 | `addMilestoneRow` | window.x = function |
| 32800 | `removeMilestoneRow` | window.x = function |
| 32805 | `updateEditorTotalSum` | window.x = function |
| 32813 | `applySchedulePreset` | window.x = function |
| 32822 | `getDueDateStr` | function decl |
| 32871 | `auditSectionLabel` | function decl |
| 32877 | `prettyFieldKey` | function decl |
| 32880 | `formatAuditFieldValue` | function decl |
| 32897 | `buildAuditDiffHtml` | function decl |
| 32934 | `loadChangeHistoryCard` | window.x = function |
| 32966 | `loadAuditLogs` | window.x = function |
| 33027 | `renderAuditPagination` | function decl |
| 33055 | `toggleAuditSort` | window.x = function |
| 33062 | `updateAuditSortIcons` | function decl |
| 33074 | `debounceAuditSearch` | window.x = function |
| 33096 | `popiaFetch` | function decl |
| 33105 | `popiaQueryParams` | function decl |
| 33115 | `loadPopiaRequests` | window.x = function |
| 33147 | `renderPopiaRow` | function decl |
| 33171 | `renderPopiaPagination` | function decl |
| 33199 | `debouncePopiaSearch` | window.x = function |
| 33204 | `updatePopiaPendingBadge` | function decl |
| 33216 | `openPopiaRequestDrawer` | function decl |
| 33316 | `popiaApprove` | function decl |
| 33324 | `popiaReject` | function decl |
| 33332 | `popiaProcess` | function decl |
| 33342 | `popiaCompleteAnonymization` | function decl |
| 33351 | `popiaExportCsv` | window.x = function |
| 33454 | `updateSessionTimer` | function decl |
| 33520 | `_updateSvcStats` | function decl |
| 33535 | `clearSvcFilters` | window.x = function |
| 33544 | `toggleArchivedServices` | window.x = function |
| 33555 | `restoreService` | window.x = function |
| 33565 | `loadAdminServices` | window.x = function |
| 33586 | `filterServicesTable` | window.x = function |
| 33646 | `svcDrawerOpen` | function decl |
| 33654 | `toggleServiceForm` | window.x = function |
| 33676 | `togglePricingFields` | window.x = function |
| 33687 | `cancelServiceForm` | window.x = function |
| 33711 | `atlDrawerPush` | function decl |
| 33718 | `atlDrawerPop` | function decl |
| 33726 | `atlDrawerFocusEntry` | function decl |
| 33738 | `openAtlDrawer` | window.x = function |
| 33748 | `closeAtlDrawer` | window.x = function |
| 33759 | `openQuoteDrawer` | window.x = function |
| 33769 | `closeQuoteDrawer` | window.x = function |
| 33780 | `editService` | window.x = function |
| 33823 | `saveService` | window.x = function |
| 33919 | `deleteService` | window.x = function |
| 33936 | `loadPolicies` | window.x = function |
| 33955 | `savePolicies` | window.x = function |
| 33997 | `formatDate` | window.x = function |
| 34005 | `esc` | function decl |
| 34006 | `lcIsAdmin` | function decl |
| 34007 | `lcDebounce` | function decl |
| 34010 | `lcActivateTab` | window.x = function |
| 34036 | `lcApplyEditorGating` | function decl |
| 34058 | `lcInitEditor` | window.x = function |
| 34068 | `lcRenderMiniVersions` | function decl |
| 34082 | `loadLegalDocument` | window.x = function |
| 34101 | `saveLegalDraft` | window.x = function |
| 34115 | `publishLegalDocument` | window.x = function |
| 34125 | `restoreLegalVersion` | window.x = function |
| 34138 | `loadLegalOverview` | window.x = function |
| 34162 | `loadConsentAudit` | window.x = function |
| 34187 | `exportConsentCsv` | window.x = function |
| 34208 | `loadLegalContracts` | window.x = function |
| 34249 | `lcViewBooking` | window.x = function |
| 34258 | `lcSendContract` | window.x = function |
| 34282 | `loadLegalVersionHistory` | window.x = function |
| 34305 | `lcPreviewVersion` | window.x = function |
| 34320 | `triggerReminderJob` | window.x = function |
| 34338 | `loadSystemSettings` | window.x = function |
| 34370 | `saveSystemSettings` | window.x = function |
| 34387 | `_fe` | const/let/var = (..) => |
| 34411 | `loadWorkingHours` | window.x = function |
| 34477 | `saveWorkingHours` | window.x = function |
| 34514 | `uploadBrandingAsset` | window.x = function |
| 34550 | `updateBrandPreview` | function decl |
| 34557 | `updateBrandFontPreview` | window.x = function |
| 34563 | `updateBrandColorPreview` | window.x = function |
| 34570 | `resetBrandColor` | window.x = function |
| 34580 | `resetBrandFont` | window.x = function |
| 34587 | `resetLoginBackground` | window.x = function |
| 34593 | `loadBrandingSettings` | window.x = function |
| 34615 | `saveBranding` | window.x = function |
| 34622 | `_fe` | const/let/var = (..) => |
| 34672 | `sendTestNotification` | window.x = function |
| 34693 | `_globalErrToast` | function decl |
| 34946 | `validateCancelForm` | function decl |
| 35077 | `dbApexBase` | function decl |
| 35091 | `dbFmtDuration` | function decl |
| 35097 | `dbFmtNum` | function decl |
| 35102 | `dbSetPeriod` | function decl |
| 35116 | `dbLoadSocialKPIs` | function decl |
| 35179 | `dbLoadKpiSummary` | function decl |
| 35184 | `el` | const/let/var = function |
| 35196 | `dbUpdateSparklines` | function decl |
| 35236 | `dbLoadVisitorsChart` | function decl |
| 35276 | `dbLoadSourcesChart` | function decl |
| 35316 | `dbLoadDevicesChart` | function decl |
| 35356 | `dbEsc` | function decl |
| 35362 | `dbCountryFlag` | function decl |
| 35370 | `dbPrettyPage` | function decl |
| 35380 | `dbRenderRankList` | function decl |
| 35403 | `dbLoadCountries` | function decl |
| 35417 | `dbLoadTopPages` | function decl |
| 35433 | `dbLoadCountryMap` | function decl |
| 35454 | `amberShade` | function decl |
| 35505 | `dbLoadBookingsChart` | function decl |
| 35546 | `loadTodaysSchedule` | function decl |
| 35590 | `loadAnalyticsDashboard` | function decl |
| 35612 | `applyDashboardSocialVisibility` | function decl |
| 35618 | `initDashboardSocialPref` | function decl |

</details>

### Functions invoked from `on*=` markup attributes

Found **255** raw `on\w+=` attribute matches via regex (baseline: 253; the file itself has 255 real HTML `on*=` attributes by the same regex, one of which — an inline `onerror=""` with empty value — is included; a further match on the JS variable name `onclickAttr = ...` at line 29354 was excluded as a false positive since it is not an HTML attribute). The small delta from baseline (255 vs 253) is attributable to differing regex/parsing methodology and is not a discrepancy in the underlying markup.

<details><summary>Full list of on*= handler attributes (click to expand — large table)</summary>

| Line | Attribute | Value | Extracted call(s) |
|---|---|---|---|
| 5052 | `onclick` | `toggleForgotPassword(event)` | toggleForgotPassword |
| 5083 | `onclick` | `toggleForgotPassword(event)` | toggleForgotPassword |
| 5194 | `onsubmit` | `return false;` |  |
| 5316 | `onsubmit` | `return false;` |  |
| 5414 | `onclick` | `switchTab('bookingsAdmin');` | switchTab |
| 5421 | `onclick` | `switchTab('inquiriesAdmin');` | switchTab |
| 5428 | `onclick` | `switchTab('financeAdmin');` | switchTab |
| 5435 | `onclick` | `switchTab('eventsAdmin');` | switchTab |
| 5442 | `onclick` | `switchTab('calendarAdmin');` | switchTab |
| 5449 | `onclick` | `switchTab('bookingsAdmin'); setTimeout(()=>{ $('#bookingStatusFilter').val('NEEDS_ACTION').trigger('change'); }, 300);` | switchTab, setTimeout, val, trigger |
| 5465 | `onclick` | `loadAnalyticsDashboard()` | loadAnalyticsDashboard |
| 6267 | `onclick` | `window.toggleUserSort('id')` | window.toggleUserSort |
| 6270 | `onclick` | `window.toggleUserSort('name')` | window.toggleUserSort |
| 6273 | `onclick` | `window.toggleUserSort('email')` | window.toggleUserSort |
| 6276 | `onclick` | `window.toggleUserSort('role')` | window.toggleUserSort |
| 6279 | `onclick` | `window.toggleUserSort('last_login_at')` | window.toggleUserSort |
| 6282 | `onclick` | `window.toggleUserSort('status')` | window.toggleUserSort |
| 6466 | `onclick` | `window.toggleLogSort('name')` | window.toggleLogSort |
| 6469 | `onclick` | `window.toggleLogSort('login_at')` | window.toggleLogSort |
| 6472 | `onclick` | `window.toggleLogSort('last_activity_at')` | window.toggleLogSort |
| 6475 | `onclick` | `window.toggleLogSort('duration')` | window.toggleLogSort |
| 6478 | `onclick` | `window.toggleLogSort('ip_address')` | window.toggleLogSort |
| 7577 | `onclick` | `loadFinancialStats()` | loadFinancialStats |
| 7626 | `onclick` | `showOverdueInvoices()` | showOverdueInvoices |
| 7635 | `onclick` | `showDueSoonInvoices()` | showDueSoonInvoices |
| 7644 | `onclick` | `showUnsentInvoices()` | showUnsentInvoices |
| 7677 | `onchange` | `onFinPeriodPresetChange()` | onFinPeriodPresetChange |
| 7689 | `onclick` | `loadFinancialStats()` | loadFinancialStats |
| 7719 | `oninput` | `filterTransactions()` | filterTransactions |
| 7721 | `onchange` | `filterTransactions()` | filterTransactions |
| 7727 | `onchange` | `filterTransactions()` | filterTransactions |
| 7728 | `onchange` | `filterTransactions()` | filterTransactions |
| 7759 | `onchange` | `applyInvoiceFilter()` | applyInvoiceFilter |
| 7767 | `onclick` | `window.openGenerateInvoiceModal()` | window.openGenerateInvoiceModal |
| 7800 | `onchange` | `loadExpensesTab()` | loadExpensesTab |
| 7812 | `onchange` | `loadExpensesTab()` | loadExpensesTab |
| 7813 | `onchange` | `loadExpensesTab()` | loadExpensesTab |
| 7819 | `onclick` | `openAtlDrawer('expenseDrawer')` | openAtlDrawer |
| 7896 | `onchange` | `loadReconciliation()` | loadReconciliation |
| 7939 | `onclick` | `loadRemindersLog()` | loadRemindersLog |
| 7966 | `onclick` | `loadFinAnalytics()` | loadFinAnalytics |
| 8210 | `onclick` | `toggleServiceForm()` | toggleServiceForm |
| 8280 | `oninput` | `filterServicesTable()` | filterServicesTable |
| 8282 | `onchange` | `filterServicesTable()` | filterServicesTable |
| 8288 | `onchange` | `filterServicesTable()` | filterServicesTable |
| 8293 | `onclick` | `clearSvcFilters()` | clearSvcFilters |
| 8295 | `onclick` | `toggleArchivedServices()` | toggleArchivedServices |
| 8394 | `onclick` | `cancelServiceForm()` | cancelServiceForm |
| 8403 | `onclick` | `cancelServiceForm()` | cancelServiceForm |
| 8445 | `onchange` | `window.togglePricingFields()` | window.togglePricingFields |
| 8607 | `onclick` | `$('#svcAdvancedPanel').slideToggle(200);` | slideToggle |
| 8673 | `onclick` | `saveService()` | saveService |
| 8676 | `onclick` | `cancelServiceForm()` | cancelServiceForm |
| 8721 | `onclick` | `lcActivateTab('lcPanelPrivacy')` | lcActivateTab |
| 8722 | `onclick` | `lcActivateTab('lcPanelTerms')` | lcActivateTab |
| 8723 | `onclick` | `lcActivateTab('lcPanelConsentAudit')` | lcActivateTab |
| 8724 | `onclick` | `lcActivateTab('lcPanelContracts')` | lcActivateTab |
| 8741 | `onclick` | `saveLegalDraft('privacy_policy')` | saveLegalDraft |
| 8742 | `onclick` | `publishLegalDocument('privacy_policy')` | publishLegalDocument |
| 8748 | `onclick` | `lcActivateTab('lcPanelVersionHistory'); return false;` | lcActivateTab |
| 8766 | `onclick` | `saveLegalDraft('terms_of_use')` | saveLegalDraft |
| 8767 | `onclick` | `publishLegalDocument('terms_of_use')` | publishLegalDocument |
| 8773 | `onclick` | `lcActivateTab('lcPanelVersionHistory'); return false;` | lcActivateTab |
| 8795 | `onclick` | `saveLegalDraft('cookie_policy')` | saveLegalDraft |
| 8796 | `onclick` | `publishLegalDocument('cookie_policy')` | publishLegalDocument |
| 8802 | `onclick` | `lcActivateTab('lcPanelVersionHistory'); return false;` | lcActivateTab |
| 8816 | `onclick` | `exportConsentCsv()` | exportConsentCsv |
| 8908 | `onclick` | `triggerReminderJob(this)` | triggerReminderJob |
| 8911 | `onclick` | `savePolicies()` | savePolicies |
| 9200 | `onclick` | `if(window.openAtlDrawer)openAtlDrawer('aboutDrawer')` | openAtlDrawer |
| 9229 | `onclick` | `if(window.openAtlDrawer)openAtlDrawer('servicesDrawer')` | openAtlDrawer |
| 9249 | `onclick` | `if(window.openAtlDrawer)openAtlDrawer('featuresDrawer')` | openAtlDrawer |
| 9267 | `onclick` | `if(window.openAtlDrawer)openAtlDrawer('heroDrawer')` | openAtlDrawer |
| 9286 | `onclick` | `if(window.openAtlDrawer)openAtlDrawer('announceDrawer')` | openAtlDrawer |
| 9792 | `onclick` | `openSocialLinkDrawer()` | openSocialLinkDrawer |
| 9814 | `onclick` | `openSocialEmbedDrawer()` | openSocialEmbedDrawer |
| 9852 | `onclick` | `saveSocialKpiSettings()` | saveSocialKpiSettings |
| 10771 | `onclick` | `window.toggleSubscriberSort('first_name')` | window.toggleSubscriberSort |
| 10772 | `onclick` | `window.toggleSubscriberSort('email')` | window.toggleSubscriberSort |
| 10773 | `onclick` | `window.toggleSubscriberSort('subscribed_at')` | window.toggleSubscriberSort |
| 10774 | `onclick` | `window.toggleSubscriberSort('birthday')` | window.toggleSubscriberSort |
| 10775 | `onclick` | `window.toggleSubscriberSort('status')` | window.toggleSubscriberSort |
| 11102 | `onclick` | `sendTestNotification()` | sendTestNotification |
| 11112 | `onclick` | `saveSystemSettings(this)` | saveSystemSettings |
| 11148 | `onclick` | `saveSectionVisibility(this)` | saveSectionVisibility |
| 11281 | `onchange` | `uploadBrandingAsset('brandLogoFile','brandLogoUrl','brandLogoPreview')` | uploadBrandingAsset |
| 11291 | `oninput` | `updateBrandPreview('brandLogoUrl','brandLogoPreview')` | updateBrandPreview |
| 11308 | `onchange` | `uploadBrandingAsset('brandFaviconFile','brandFaviconUrl','brandFaviconPreview')` | uploadBrandingAsset |
| 11318 | `oninput` | `updateBrandPreview('brandFaviconUrl','brandFaviconPreview')` | updateBrandPreview |
| 11338 | `oninput` | `$('#brandColorHex').val(this.value); updateBrandColorPreview()` | val, updateBrandColorPreview |
| 11341 | `oninput` | `if(/^#[0-9a-fA-F]{6}$/.test(this.value)){$('#brandPrimaryColor').val(this.value)}; updateBrandColorPreview()` | test, val, updateBrandColorPreview |
| 11349 | `onclick` | `resetBrandColor()` | resetBrandColor |
| 11364 | `onchange` | `updateBrandFontPreview()` | updateBrandFontPreview |
| 11393 | `onclick` | `resetBrandFont()` | resetBrandFont |
| 11404 | `onclick` | `saveBranding('identity')` | saveBranding |
| 11424 | `onclick` | `showBnrView('library')` | showBnrView |
| 11425 | `onclick` | `showBnrView('preview')` | showBnrView |
| 11426 | `onclick` | `showBnrView('about')` | showBnrView |
| 11437 | `onclick` | `openBnrCreateDrawer()` | openBnrCreateDrawer |
| 11446 | `oninput` | `onBnrSearchInput()` | onBnrSearchInput |
| 11448 | `onchange` | `reloadBnrBanners()` | reloadBnrBanners |
| 11451 | `onchange` | `reloadBnrBanners()` | reloadBnrBanners |
| 11456 | `onclick` | `clearBnrFilters()` | clearBnrFilters |
| 11461 | `onclick` | `loadMoreBnrBanners()` | loadMoreBnrBanners |
| 11474 | `onchange` | `loadBnrPreview()` | loadBnrPreview |
| 11478 | `onclick` | `setBnrPreviewWidth(375)` | setBnrPreviewWidth |
| 11479 | `onclick` | `setBnrPreviewWidth(600)` | setBnrPreviewWidth |
| 11542 | `onchange` | `uploadBrandingAsset('brandLoginBgFile','brandLoginBgUrl','brandLoginBgPreview')` | uploadBrandingAsset |
| 11552 | `oninput` | `updateBrandPreview('brandLoginBgUrl','brandLoginBgPreview')` | updateBrandPreview |
| 11555 | `onclick` | `resetLoginBackground()` | resetLoginBackground |
| 11568 | `onclick` | `saveBranding('site')` | saveBranding |
| 11664 | `onclick` | `loadEmailLogs()` | loadEmailLogs |
| 11693 | `oninput` | `debounceLogSearch()` | debounceLogSearch |
| 11696 | `onchange` | `applyLogFilters()` | applyLogFilters |
| 11704 | `onchange` | `applyLogFilters()` | applyLogFilters |
| 11723 | `onclick` | `toggleLogSort('sent_at')` | toggleLogSort |
| 11726 | `onclick` | `toggleLogSort('recipient_email')` | toggleLogSort |
| 11729 | `onclick` | `toggleLogSort('subject')` | toggleLogSort |
| 11732 | `onclick` | `toggleLogSort('trigger_event')` | toggleLogSort |
| 11735 | `onclick` | `toggleLogSort('status')` | toggleLogSort |
| 11835 | `onclick` | `loadAuditLogs()` | loadAuditLogs |
| 11907 | `oninput` | `debounceAuditSearch()` | debounceAuditSearch |
| 11930 | `onclick` | `auditState.page=1; loadAuditLogs()` | loadAuditLogs |
| 11936 | `onclick` | `toggleAuditSort('table_name')` | toggleAuditSort |
| 11938 | `onclick` | `toggleAuditSort('action')` | toggleAuditSort |
| 11942 | `onclick` | `toggleAuditSort('change_timestamp')` | toggleAuditSort |
| 11977 | `oninput` | `debouncePopiaSearch()` | debouncePopiaSearch |
| 11979 | `onchange` | `popiaState.page=1; loadPopiaRequests();` | loadPopiaRequests |
| 11988 | `onchange` | `popiaState.page=1; loadPopiaRequests();` | loadPopiaRequests |
| 11993 | `onchange` | `popiaState.page=1; loadPopiaRequests();` | loadPopiaRequests |
| 11994 | `onchange` | `popiaState.page=1; loadPopiaRequests();` | loadPopiaRequests |
| 11995 | `onclick` | `popiaState.page=1; loadPopiaRequests()` | loadPopiaRequests |
| 11996 | `onclick` | `popiaExportCsv()` | popiaExportCsv |
| 11997 | `onclick` | `openAtlDrawer('popiaAnonymizeNowDrawer')` | openAtlDrawer |
| 13558 | `onerror` | `this.onerror=null;this.src='https://placehold.co/72x100/1a1a1a/D4AF37?text=No+Image';` |  |
| 13566 | `onclick` | `window.openHomeEditDrawer(${item.id})` | window.openHomeEditDrawer |
| 14404 | `onerror` | `this.onerror=null;this.src='https://placehold.co/72x100/1a1a1a/D4AF37?text=No+Image';` |  |
| 14416 | `onclick` | `window.openEvtEditDrawer(${item.event_id})` | window.openEvtEditDrawer |
| 15209 | `onerror` | `this.onerror=null;this.src='data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';` |  |
| 15218 | `onclick` | `window.openCareerEditDrawer(${item.id})` | window.openCareerEditDrawer |
| 15724 | `onerror` | `this.style.opacity='0.2';` |  |
| 15878 | `onerror` | `` |  |
| 15918 | `onerror` | `window.tsThumbFallback(this)` | window.tsThumbFallback |
| 16312 | `onerror` | `this.onerror=null;this.src='https://placehold.co/72x100/1a1a1a/D4AF37?text=No+Image';` |  |
| 16334 | `onclick` | `window.openGalleryEditDrawer(${item.id})` | window.openGalleryEditDrawer |
| 16735 | `onclick` | `archiveBnrBanner(' + b.id + ')` | archiveBnrBanner |
| 16736 | `onclick` | `restoreBnrBanner(' + b.id + ')` | restoreBnrBanner |
| 16742 | `onerror` | `this.onerror=null;this.src=\'https://placehold.co/72x100/1a1a1a/D4AF37?text=No+Image\';` |  |
| 16750 | `onclick` | `openBnrEditDrawer(' + b.id + ')` | openBnrEditDrawer |
| 16751 | `onclick` | `openBnrAssignDrawer(' + b.id + ')` | openBnrAssignDrawer |
| 17263 | `onerror` | `this.src='data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';` |  |
| 17763 | `onclick` | `toggleKpiFields(this)` | toggleKpiFields |
| 17764 | `onclick` | `toggleKpiFields(this)` | toggleKpiFields |
| 18113 | `onclick` | `abCloseDrawer()` | abCloseDrawer |
| 18115 | `onclick` | `abCloseDrawer()` | abCloseDrawer |
| 18130 | `onclick` | `abCloseDrawer()` | abCloseDrawer |
| 19775 | `onclick` | `' + qSendFn + '` |  |
| 19857 | `onclick` | `sendOrResendInvoiceFromCard(' + invoiceId + ')` | sendOrResendInvoiceFromCard |
| 22590 | `onclick` | `editExpense(${e.id})` | editExpense |
| 22591 | `onclick` | `deleteExpense(${e.id})` | deleteExpense |
| 22985 | `onclick` | `unmatchBankLine(' + l.id + ')` | unmatchBankLine |
| 22986 | `onclick` | `openBankMatchRow(' + l.id + ', this)` | openBankMatchRow |
| 22993 | `onclick` | `deleteBankLine(' + l.id + ')` | deleteBankLine |
| 23073 | `onclick` | `confirmBankMatch(' + id + ')` | confirmBankMatch |
| 23074 | `onclick` | `loadBankLines()` | loadBankLines |
| 23208 | `onclick` | `window.syncBookingLedger(${bookingId}, this)` | window.syncBookingLedger |
| 26219 | `onclick` | `cancelEventEdit();` | cancelEventEdit |
| 26486 | `onclick` | `careerCancelEdit();` | careerCancelEdit |
| 26729 | `onclick` | `galleryCancelEdit();` | galleryCancelEdit |
| 26751 | `onclick` | `closeAtlDrawer('bnrDrawer')` | closeAtlDrawer |
| 26796 | `onchange` | `onBnrImageFileChange()` | onBnrImageFileChange |
| 26805 | `onclick` | `closeAtlDrawer('bnrDrawer')` | closeAtlDrawer |
| 26820 | `onclick` | `closeAtlDrawer('bnrAssignDrawer')` | closeAtlDrawer |
| 26836 | `onclick` | `closeAtlDrawer('bnrAssignDrawer')` | closeAtlDrawer |
| 26837 | `onclick` | `applyBnrAssignments()` | applyBnrAssignments |
| 26894 | `onclick` | `homeCancelEdit();` | homeCancelEdit |
| 26912 | `onclick` | `closeAtlDrawer('inqDetailDrawer')` | closeAtlDrawer |
| 27159 | `onclick` | `closeEmailPreviewModal()` | closeEmailPreviewModal |
| 27160 | `onclick` | `event.stopPropagation()` | event.stopPropagation |
| 27163 | `onclick` | `closeEmailPreviewModal()` | closeEmailPreviewModal |
| 27174 | `onclick` | `closeAtlDrawer('socialLinkDrawer')` | closeAtlDrawer |
| 27178 | `onclick` | `closeAtlDrawer('socialLinkDrawer')` | closeAtlDrawer |
| 27221 | `onchange` | `document.getElementById('socActiveLabel').textContent = this.checked ? 'Active (visible on site)' : 'Inactive (hidden)';` | document.getElementById, Active, Inactive |
| 27233 | `onclick` | `closeAtlDrawer('socialEmbedDrawer')` | closeAtlDrawer |
| 27237 | `onclick` | `closeAtlDrawer('socialEmbedDrawer')` | closeAtlDrawer |
| 27291 | `onchange` | `document.getElementById('embedActiveLabel').textContent = this.checked ? 'Active (visible on site)' : 'Inactive (hidden)';` | document.getElementById, Active, Inactive |
| 27303 | `onclick` | `closeAtlDrawer('umAddUserDrawer')` | closeAtlDrawer |
| 27415 | `onclick` | `closeAtlDrawer('editSubscriberDrawer')` | closeAtlDrawer |
| 27419 | `onclick` | `closeAtlDrawer('editSubscriberDrawer')` | closeAtlDrawer |
| 27471 | `onclick` | `closeAtlDrawer('editSubscriberDrawer')` | closeAtlDrawer |
| 27479 | `onclick` | `closeAtlDrawer('recordPaymentDrawer')` | closeAtlDrawer |
| 27484 | `onclick` | `closeAtlDrawer('recordPaymentDrawer')` | closeAtlDrawer |
| 27503 | `onclick` | `closeAtlDrawer('recordPaymentDrawer')` | closeAtlDrawer |
| 27554 | `onclick` | `closeAtlDrawer('contractDrawer')` | closeAtlDrawer |
| 27559 | `onclick` | `closeAtlDrawer('contractDrawer')` | closeAtlDrawer |
| 27577 | `onclick` | `document.getElementById('contractFileInput').click()` | document.getElementById, click |
| 27584 | `onclick` | `event.preventDefault();document.getElementById('contractFileInput').value='';document.getElementById('contractFilePreview').style.display='none';` | event.preventDefault, document.getElementById, document.getElementById |
| 27614 | `onclick` | `closeAtlDrawer('contractDrawer')` | closeAtlDrawer |
| 27632 | `onclick` | `closeAtlDrawer('expenseDrawer')` | closeAtlDrawer |
| 27637 | `onclick` | `closeAtlDrawer('expenseDrawer')` | closeAtlDrawer |
| 27744 | `onclick` | `closeAtlDrawer('expenseDrawer')` | closeAtlDrawer |
| 27752 | `onclick` | `closeAtlDrawer('manualTxDrawer')` | closeAtlDrawer |
| 27757 | `onclick` | `closeAtlDrawer('manualTxDrawer')` | closeAtlDrawer |
| 27817 | `onclick` | `closeAtlDrawer('manualTxDrawer')` | closeAtlDrawer |
| 27825 | `onclick` | `closeQuoteDrawer()` | closeQuoteDrawer |
| 27838 | `onclick` | `closeQuoteDrawer()` | closeQuoteDrawer |
| 27996 | `onclick` | `closeQuoteDrawer()` | closeQuoteDrawer |
| 28944 | `onclick` | `document.getElementById(\'calEventPopup\').remove()` | document.getElementById, remove |
| 28963 | `onclick` | `switchTab(\'bookingsAdmin\'); $(\'#bookingStatusFilter\').val(\'All\').trigger(\'change\'); setTimeout(() => { const el = document.getElementById(\'bookingDetail-\' + \'' + props.dbId + '\'); if(el) {` | switchTab, val, trigger, setTimeout, document.getElementById, collapse, el.scrollIntoView, document.getElementById, remove |
| 28964 | `onclick` | `navigator.clipboard.writeText(\'' + props.clientPhone.replace(/'/g, '') + '\').then(function(){window.notificationService&&window.notificationService.showSuccess(\'Phone copied\')});` | navigator.clipboard.writeText, props.clientPhone.replace, then, window.notificationService.showSuccess |
| 28974 | `onclick` | `document.getElementById(\'calEventPopup\').remove()` | document.getElementById, remove |
| 28981 | `onclick` | `switchTab(\'bookingsAdmin\'); $(\'#bookingStatusFilter\').val(\'All\').trigger(\'change\'); setTimeout(() => { const el = document.getElementById(\'bookingDetail-' + props.dbId + '\'); if(el) { $(el).` | switchTab, val, trigger, setTimeout, document.getElementById, collapse, el.scrollIntoView, document.getElementById, remove |
| 28985 | `onclick` | `document.getElementById(\'calEventPopup\').remove()` | document.getElementById, remove |
| 28993 | `onclick` | `switchTab(\'eventsAdmin\'); setTimeout(() => { if(typeof window.openEvtEditDrawer===\'function\'){ window.openEvtEditDrawer(' + props.dbId + '); var $c=$(\'.atl-event-card[data-id=&quot;' + props.dbId` | switchTab, setTimeout, window.openEvtEditDrawer, animate, c.offset, document.getElementById, remove |
| 28998 | `onclick` | `document.getElementById(\'calEventPopup\').remove()` | document.getElementById, remove |
| 29367 | `onclick` | `switchTab('bookingsAdmin'); $('#bookingStatusFilter').val('All').trigger('change'); setTimeout(() => { if (typeof window.toggleBookingDetail === 'function') window.toggleBookingDetail(${ev.extendedPro` | switchTab, val, trigger, setTimeout, window.toggleBookingDetail |
| 29395 | `onclick` | `event.preventDefault(); window._calSwitchToList && window._calSwitchToList();` | event.preventDefault, window._calSwitchToList |
| 32179 | `onclick` | `markInvoicePaid(${inv.id},'${inv.invoice_number}')` | markInvoicePaid |
| 32180 | `onclick` | `sendInvoice(${inv.id})` | sendInvoice |
| 32181 | `onclick` | `voidInvoice(${inv.id},'${inv.invoice_number}')` | voidInvoice |
| 32593 | `onclick` | `showPaymentScheduleEditor(${bookingId}, ${totalAmount}, ${JSON.stringify(schedules).replace(/` | showPaymentScheduleEditor, JSON.stringify, replace |
| 32618 | `onclick` | `showPaymentScheduleEditor(${bookingId}, ${totalAmount}, [])` | showPaymentScheduleEditor |
| 32704 | `onclick` | `applySchedulePreset(${bookingId}, ${totalAmount}, '50-50')` | applySchedulePreset |
| 32705 | `onclick` | `applySchedulePreset(${bookingId}, ${totalAmount}, '30-70')` | applySchedulePreset |
| 32706 | `onclick` | `applySchedulePreset(${bookingId}, ${totalAmount}, '30-30-40')` | applySchedulePreset |
| 32707 | `onclick` | `applySchedulePreset(${bookingId}, ${totalAmount}, 'custom')` | applySchedulePreset |
| 32719 | `onclick` | `loadBookingPaymentSchedule(${bookingId})` | loadBookingPaymentSchedule |
| 32785 | `oninput` | `updateEditorTotalSum(${bookingId})` | updateEditorTotalSum |
| 32787 | `onclick` | `removeMilestoneRow('${rowId}', ${bookingId})` | removeMilestoneRow |
| 33574 | `onclick` | `toggleServiceForm()` | toggleServiceForm |
| 33600 | `onclick` | `clearSvcFilters()` | clearSvcFilters |
| 33631 | `onclick` | `restoreService(${s.id})` | restoreService |
| 34076 | `onclick` | `restoreLegalVersion(\'' + type + '\',' + v.id + ')` | restoreLegalVersion |
| 34223 | `onclick` | `lcViewBooking(' + c.booking_id + ')` | lcViewBooking |
| 34225 | `onclick` | `lcSendContract(' + c.booking_id + ', this)` | lcSendContract |
| 34300 | `onclick` | `lcPreviewVersion(' + v.id + ',\'' + v.__type + '\')` | lcPreviewVersion |
| 34301 | `onclick` | `restoreLegalVersion(\'' + v.__type + '\',' + v.id + ')` | restoreLegalVersion |
| 35735 | `onclick` | `closeAtlDrawer('blockOutDrawer')` | closeAtlDrawer |
| 35740 | `onclick` | `closeAtlDrawer('blockOutDrawer')` | closeAtlDrawer |
| 35803 | `onclick` | `closeAtlDrawer('blockOutDrawer')` | closeAtlDrawer |
| 35858 | `onclick` | `closeAtlDrawer('bookingInfoDrawer')` | closeAtlDrawer |
| 35866 | `onclick` | `closeAtlDrawer('bookingInfoDrawer')` | closeAtlDrawer |
| 35907 | `onclick` | `closeAtlDrawer('bookingInfoDrawer')` | closeAtlDrawer |
| 35915 | `onclick` | `closeAtlDrawer('bookingFinancialsDrawer')` | closeAtlDrawer |
| 35923 | `onclick` | `closeAtlDrawer('bookingFinancialsDrawer')` | closeAtlDrawer |
| 35968 | `onclick` | `closeAtlDrawer('bookingFinancialsDrawer')` | closeAtlDrawer |
| 36020 | `onclick` | `closeAtlDrawer('bookingEmailDrawer')` | closeAtlDrawer |
| 36028 | `onclick` | `closeAtlDrawer('bookingEmailDrawer')` | closeAtlDrawer |
| 36058 | `onclick` | `closeAtlDrawer('bookingEmailDrawer')` | closeAtlDrawer |
| 36070 | `onclick` | `closeAtlDrawer('dealViewDrawer')` | closeAtlDrawer |
| 36075 | `onclick` | `closeAtlDrawer('dealViewDrawer')` | closeAtlDrawer |
| 36106 | `onclick` | `closeAtlDrawer('manualBookingDrawer')` | closeAtlDrawer |
| 36111 | `onclick` | `closeAtlDrawer('manualBookingDrawer')` | closeAtlDrawer |
| 36224 | `onclick` | `closeAtlDrawer('manualBookingDrawer')` | closeAtlDrawer |

</details>

### Cross-reference: markup-invoked entry points vs. definitions

Of the raw extracted call tokens, **107** are genuine application-defined function names invoked from markup (after excluding JS/DOM built-ins and string-literal artifacts picked up by the naive regex — `document.getElementById`, `navigator.clipboard.writeText`, jQuery method calls like `.val()`/`.trigger()`/`.animate()`, and a few false positives such as `Active(`/`Inactive(` matched inside quoted UI strings). For `window.foo(...)` call sites the `window.` prefix is stripped before matching against the definitions list, since most of these are declared as `window.foo = function(){...}`.

| Function (as called from markup) | First on*= call site (line) | Defined at line(s) |
|---|---|---|
| `_calSwitchToList` | 29395 | 28895 |
| `abCloseDrawer` | 18113 | 18090 |
| `applyBnrAssignments` | 26837 | 16982 |
| `applyInvoiceFilter` | 7759 | 32133 |
| `applyLogFilters` | 11696 | 31431 |
| `applySchedulePreset` | 32704 | 32813 |
| `archiveBnrBanner` | 16735 | 16902 |
| `cancelEventEdit` | 26219 | 14832 |
| `cancelServiceForm` | 8394 | 33687 |
| `careerCancelEdit` | 26486 | 15320 |
| `clearBnrFilters` | 11456 | 16679 |
| `clearSvcFilters` | 8293 | 33535 |
| `closeAtlDrawer` | 26751 | 33748 |
| `closeEmailPreviewModal` | 27159 | 19120 |
| `closeQuoteDrawer` | 27825 | 33769 |
| `confirmBankMatch` | 23073 | 23081 |
| `debounceAuditSearch` | 11907 | 33074 |
| `debounceLogSearch` | 11693 | 31438 |
| `debouncePopiaSearch` | 11977 | 33199 |
| `deleteBankLine` | 22993 | 23049 |
| `deleteExpense` | 22591 | 22618 |
| `editExpense` | 22590 | 22827 |
| `exportConsentCsv` | 8816 | 34187 |
| `filterServicesTable` | 8280 | 33586 |
| `filterTransactions` | 7719 | 32067 |
| `galleryCancelEdit` | 26729 | 16478 |
| `homeCancelEdit` | 26894 | 13672 |
| `lcActivateTab` | 8721 | 34010 |
| `lcPreviewVersion` | 34300 | 34305 |
| `lcSendContract` | 34225 | 34258 |
| `lcViewBooking` | 34223 | 34249 |
| `loadAnalyticsDashboard` | 5465 | 35590 |
| `loadAuditLogs` | 11835 | 32966 |
| `loadBankLines` | 23074 | 22954 |
| `loadBnrPreview` | 11474 | 16656 |
| `loadBookingPaymentSchedule` | 32719 | 32551 |
| `loadEmailLogs` | 11664 | 31285 |
| `loadExpensesTab` | 7800 | 22556 |
| `loadFinAnalytics` | 7966 | 32361 |
| `loadFinancialStats` | 7577 | 31908 |
| `loadMoreBnrBanners` | 11461 | 16692 |
| `loadPopiaRequests` | 11979 | 33115 |
| `loadReconciliation` | 7896 | 23094 |
| `loadRemindersLog` | 7939 | 32094 |
| `markInvoicePaid` | 32179 | 32255 |
| `onBnrImageFileChange` | 26796 | 16798 |
| `onBnrSearchInput` | 11446 | 16674 |
| `onFinPeriodPresetChange` | 7677 | 31897 |
| `openAtlDrawer` | 7819 | 33738 |
| `openBankMatchRow` | 22986 | 23061 |
| `openBnrAssignDrawer` | 16751 | 16940 |
| `openBnrCreateDrawer` | 11437 | 16774 |
| `openBnrEditDrawer` | 16750 | 16779 |
| `openCareerEditDrawer` | 15218 | 15311 |
| `openEvtEditDrawer` | 14416 | 14824 |
| `openGalleryEditDrawer` | 16334 | 16471 |
| `openGenerateInvoiceModal` | 7767 | 32299 |
| `openHomeEditDrawer` | 13566 | 13665 |
| `openSocialEmbedDrawer` | 9814 | 17328 |
| `openSocialLinkDrawer` | 9792 | 17111 |
| `popiaExportCsv` | 11996 | 33351 |
| `publishLegalDocument` | 8742 | 34115 |
| `reloadBnrBanners` | 11448 | 16686 |
| `removeMilestoneRow` | 32787 | 32800 |
| `resetBrandColor` | 11349 | 34570 |
| `resetBrandFont` | 11393 | 34580 |
| `resetLoginBackground` | 11555 | 34587 |
| `restoreBnrBanner` | 16736 | 16923 |
| `restoreLegalVersion` | 34076 | 34125 |
| `restoreService` | 33631 | 33555 |
| `saveBranding` | 11404 | 34615 |
| `saveLegalDraft` | 8741 | 34101 |
| `savePolicies` | 8911 | 33955 |
| `saveSectionVisibility` | 11148 | 14240 |
| `saveService` | 8673 | 33823 |
| `saveSocialKpiSettings` | 9852 | 17839 |
| `saveSystemSettings` | 11112 | 34370 |
| `sendInvoice` | 32180 | 32187 |
| `sendOrResendInvoiceFromCard` | 19857 | 32230 |
| `sendTestNotification` | 11102 | 34672 |
| `setBnrPreviewWidth` | 11478 | 16649 |
| `showBnrView` | 11424 | 16631 |
| `showDueSoonInvoices` | 7635 | 28445 |
| `showOverdueInvoices` | 7626 | 28441 |
| `showPaymentScheduleEditor` | 32593 | 32693 |
| `showUnsentInvoices` | 7644 | 28449 |
| `switchTab` | 5414 | 28691 |
| `syncBookingLedger` | 23208 | 23267 |
| `toggleArchivedServices` | 8295 | 33544 |
| `toggleAuditSort` | 11936 | 33055 |
| `toggleBookingDetail` | 29367 | 13035 |
| `toggleForgotPassword` | 5052 | 25973 |
| `toggleKpiFields` | 17763 | 17805 |
| `toggleLogSort` | 6466 | 31408, 31665 |
| `togglePricingFields` | 8445 | 33676 |
| `toggleServiceForm` | 8210 | 33654 |
| `toggleSubscriberSort` | 10771 | 24261 |
| `toggleUserSort` | 6267 | 31104 |
| `triggerReminderJob` | 8908 | 34320 |
| `tsThumbFallback` | 15918 | 15880 |
| `unmatchBankLine` | 22985 | 23055 |
| `updateBrandColorPreview` | 11338 | 34563 |
| `updateBrandFontPreview` | 11364 | 34557 |
| `updateBrandPreview` | 11291 | 34550 |
| `updateEditorTotalSum` | 32785 | 32805 |
| `uploadBrandingAsset` | 11281 | 34514 |
| `voidInvoice` | 32181 | 32234 |

---

## 4. ID Cross-Reference (JS-Referenced IDs)

A literal `id="` scan finds **1,701** occurrences file-wide. Splitting that by location: **1,465** sit in static HTML markup (outside any `<script>` block) -- this is the figure directly comparable to the baseline's **1,526**, and the small remaining gap is most likely accounted for by differences in exactly which lines each method classifies as "inside a script block" plus a handful of edge cases (e.g. `id='...'` with single quotes, of which there are 4). The other **236** occurrences of `id="` are inside the 14 inline `<script>` blocks themselves -- these are dynamically-constructed ids baked into JS template-literal/string-concatenation HTML (e.g. a table-row or card renderer emitting `<div id="...">` as a string), not static markup, so they were excluded from the baseline's count of markup attributes but are real ids that end up in the DOM at runtime.

Of all these ids, **921** distinct id values (or id name-patterns, for dynamically-constructed ids) could be confirmed as referenced from JavaScript via `document.getElementById(...)`, `$('#id')`, `querySelector('#id')`/`querySelectorAll('#id')`, or a template literal building an id from a static prefix + a dynamic suffix (shown below as `prefix${...}`).

**Method / limitation note**: this list is a complete enumeration of everything the four regex patterns above matched across the whole file (not a sample) — but it is not exhaustive of every possible way JS can reference an id. It will miss: ids built by pure string concatenation without a template literal (e.g. `document.getElementById('row-' + id)` — style used in a handful of spots; grep for `getElementById\(.*\+` to find these directly if needed), ids passed through a variable that was itself assigned elsewhere (`var sel = 'foo'; $('#'+sel)`), and ids referenced only from the two external local scripts `js/myscript.js` and `js/notificationService.js` (out of scope — those are separate files, not inline blocks of admin.html). Each row shows only the *first* line the id was matched on; most ids are referenced many more times.

<details><summary>Full list of distinct ids referenced from JS (click to expand — large table)</summary>

| ID (as referenced from JS) | First JS reference line |
|---|---|
| `${rowId}` | 32801 |
| `abCell` | 23872 |
| `abCompany` | 23871 |
| `abDrawerWrap` | 18092 |
| `abEmail` | 23872 |
| `abFunnel` | 18011 |
| `abName` | 23871 |
| `abNextBtn` | 18055 |
| `aboutDrawer` | 13830 |
| `aboutFile` | 13790 |
| `aboutForm` | 13841 |
| `aboutSubmitBtn` | 13846 |
| `aboutUploadText` | 13889 |
| `aboutUploadZone` | 13906 |
| `aboutUrl` | 13784 |
| `aboutVideoWarning` | 13850 |
| `abPageInfo` | 18053 |
| `abPagination` | 18056 |
| `abPrevBtn` | 18054 |
| `abStatConversion` | 18031 |
| `abStatLostValue` | 18032 |
| `abStatOpen` | 18029 |
| `abStatRecovered` | 18030 |
| `abTabCount` | 17994 |
| `abTableBody` | 18039 |
| `addMediaForm` | 16433 |
| `addSubscriberForm` | 24629 |
| `admGlobalSearch` | 22062 |
| `admin-year` | 12114 |
| `adminBookingModal` | 21222 |
| `adminCareerList` | 15169 |
| `adminEmail` | 25801 |
| `adminEmbedList` | 17210 |
| `adminFooter` | 25734 |
| `adminFootprintList` | 15706 |
| `adminForgotForm` | 26001 |
| `adminGalleryList` | 16286 |
| `adminHeader` | 25730 |
| `adminHomeList` | 13533 |
| `adminLoginForm` | 25808 |
| `adminPassword` | 25828 |
| `adminPastEventsList` | 14326 |
| `adminSocialList` | 17035 |
| `adminTestimonialsList` | 15892 |
| `adminUpcomingEventsList` | 14325 |
| `admProfileTrigger` | 28568 |
| `announceEnabled` | 13947 |
| `announceInput` | 13946 |
| `announcePrev` | 14005 |
| `announcePrevMotion` | 14008 |
| `announcePrevOff` | 14007 |
| `announcePrevWrap` | 14006 |
| `announceRotate` | 13948 |
| `announceSubmitBtn` | 14124 |
| `apiKeyGroup` | 17296 |
| `atl-paymentschedule-${...}` | 32552 |
| `atl-paymentschedule-${bookingId}` | 32552 |
| `atlModalOverlay` | 12203 |
| `atlThemeToggle` | 12452 |
| `atlThemeToggleIcon` | 12427 |
| `attachmentList` | 25137 |
| `bankBatchSelect` | 22955 |
| `bankDeleteBatchBtn` | 22969 |
| `bankImportStatus` | 22997 |
| `bankLinesList` | 22974 |
| `bankLinesSection` | 22973 |
| `bdayCtaLabel` | 24754 |
| `bdayCtaUrl` | 24755 |
| `bdayEnabled` | 24767 |
| `bdayFooterNote` | 24756 |
| `bdayHeading` | 24752 |
| `bdayPreviewBtn` | 24842 |
| `bdayRecentSendsEmpty` | 24786 |
| `bdayRecentSendsList` | 24785 |
| `bdaySaveBtn` | 24813 |
| `bdaySendTestBtn` | 24858 |
| `bdaySendTime` | 24769 |
| `bdaySubject` | 24751 |
| `bdayTestMode` | 24768 |
| `bdayTestRecipient` | 24757 |
| `be-alert` | 24006 |
| `be-booking-id` | 24001 |
| `be-send-btn` | 24098 |
| `be-subject` | 24004 |
| `be-template` | 24005 |
| `be-to` | 24003 |
| `bf-btn-expense` | 23963 |
| `bf-btn-invoice` | 23958 |
| `bf-btn-quote` | 23957 |
| `bf-doc-links` | 23942 |
| `bf-last-payment` | 23910 |
| `bf-modal-title` | 23897 |
| `bf-outstanding` | 23906 |
| `bf-paid` | 23905 |
| `bf-pay-status` | 23903 |
| `bf-pl-card` | 23916 |
| `bf-total` | 23904 |
| `bi-address` | 23843 |
| `bi-audience` | 23848 |
| `bi-budget` | 23850 |
| `bi-cell` | 23833 |
| `bi-company` | 23831 |
| `bi-date` | 23837 |
| `bi-demographic` | 23849 |
| `bi-duration` | 23840 |
| `bi-email` | 23832 |
| `bi-event-name` | 23836 |
| `bi-location` | 23841 |
| `bi-message` | 23868 |
| `bi-modal-title` | 23827 |
| `bi-name` | 23830 |
| `bi-slot` | 23839 |
| `bi-start-time` | 23838 |
| `bi-travel` | 23856 |
| `bi-type` | 23844 |
| `bi-venue-notes` | 23865 |
| `bi-venue-type` | 23845 |
| `birthdaySettingsForm` | 24811 |
| `bk-buf-${...}` | 22240 |
| `bk-buf-${id}` | 22240 |
| `bk-buf-hint-${...}` | 22241 |
| `bk-buf-hint-${id}` | 22241 |
| `bkArchivePageNext` | 23698 |
| `bkArchivePagePrev` | 23694 |
| `bkArchiveResultCount` | 23661 |
| `bkArchiveSearchInput` | 23639 |
| `bkArchiveSortSelect` | 23640 |
| `bkArchiveStat-All` | 23654 |
| `bkBulkBar` | 23721 |
| `bkBulkCancel` | 23747 |
| `bkBulkCount` | 23715 |
| `bkBulkExport` | 23733 |
| `bkBulkRemind` | 23774 |
| `bkPageNext` | 23623 |
| `bkPagePrev` | 23619 |
| `bkPLCard-${...}` | 22646 |
| `bkPLCard-${bookingId}` | 22646 |
| `bkResultCount` | 23596 |
| `bkSearchInput` | 21962 |
| `bkSelectAll` | 23717 |
| `bkSelectToggle` | 23719 |
| `bkSortSelect` | 23565 |
| `bkStat-${...}` | 19661 |
| `bkStat-${s}` | 19661 |
| `bnrAltText` | 16786 |
| `bnrAssignApplyBtn` | 16992 |
| `bnrAssignCategory` | 16946 |
| `bnrAssignList` | 16947 |
| `bnrAssignName` | 16945 |
| `bnrAssignThumb` | 16944 |
| `bnrCardGrid` | 16713 |
| `bnrCategory` | 16617 |
| `bnrCategoryFilter` | 16616 |
| `bnrDrawerTitle` | 16770 |
| `bnrExistingImagePreview` | 16789 |
| `bnrExistingImageRow` | 16767 |
| `bnrForm` | 16765 |
| `bnrHeadline` | 16787 |
| `bnrImageError` | 16766 |
| `bnrImageFile` | 16799 |
| `bnrImageRequiredMark` | 16769 |
| `bnrLoadMoreBtn` | 16710 |
| `bnrName` | 16784 |
| `bnrNewImagePreview` | 16827 |
| `bnrNewImagePreviewWrap` | 16768 |
| `bnrPreviewDesktopBtn` | 16653 |
| `bnrPreviewIframe` | 16651 |
| `bnrPreviewMobileBtn` | 16652 |
| `bnrPreviewStatus` | 16658 |
| `bnrPreviewTemplateSelect` | 16644 |
| `bnrSearchInput` | 16680 |
| `bnrStatusFilter` | 16682 |
| `bnrSubmitBtn` | 16771 |
| `bnrSubtitle` | 16788 |
| `boAllDay` | 29904 |
| `boCategory` | 29876 |
| `boDate` | 29892 |
| `boDuration` | 29963 |
| `boEndDate` | 29894 |
| `boNewCategoryColor` | 29930 |
| `boNewCategoryForm` | 29906 |
| `boNewCategoryName` | 29908 |
| `bookingDispositionFilter` | 21971 |
| `bookingEmailClientName` | 24002 |
| `bookingFinancialsDrawer` | 23894 |
| `bookingsAdmin` | 22065 |
| `bookingsListContainer` | 19636 |
| `bookingStatusFilter` | 5449 |
| `boTime` | 29962 |
| `boTimeFields` | 29905 |
| `brandColorHex` | 11338 |
| `brandColorSample` | 34566 |
| `brandColorSwatch` | 34565 |
| `brandFaviconUrl` | 34601 |
| `brandFontPreview` | 34559 |
| `brandLoginBgUrl` | 34588 |
| `brandLogoUrl` | 34600 |
| `brandPrimaryColor` | 11341 |
| `brandThemeFont` | 34558 |
| `btnCopyIcsFeed` | 29544 |
| `btnNewManualBooking` | 29564 |
| `btnPromoteBookingYes` | 34990 |
| `btnRefreshBookings` | 29616 |
| `btnRefreshCalendar` | 29409 |
| `btnSaveSystemSettings` | 34371 |
| `btnSaveWorkingHours` | 34478 |
| `bulkDeleteBtn` | 24413 |
| `bulkExportSelectedBtn` | 24428 |
| `bulkSelectedCount` | 24374 |
| `bulkSetActiveBtn` | 24383 |
| `bulkSetInactiveBtn` | 24398 |
| `calendar` | 28900 |
| `calEventPopup` | 28915 |
| `campaignDeliveryLogEmpty` | 25421 |
| `campaignDeliveryLogList` | 25420 |
| `campaignDeliveryLogModal` | 25424 |
| `campaignDeliveryLogViewAll` | 25445 |
| `campaignsBulkBar` | 25289 |
| `campaignsBulkCount` | 25288 |
| `campaignsBulkDeleteBtn` | 25466 |
| `campaignsNextBtn` | 25412 |
| `campaignsPagination` | 25311 |
| `campaignsPrevBtn` | 25411 |
| `campaignsSearchInput` | 25385 |
| `campaignsSortSelect` | 25393 |
| `campaignsTableBody` | 25300 |
| `cancelBookingId` | 21988 |
| `cancelBookingModal` | 22005 |
| `cancelCancelledBy` | 21998 |
| `cancelConfirmCheck` | 34917 |
| `cancelEventId` | 14661 |
| `cancelEventLabel` | 14662 |
| `cancelEventModal` | 14664 |
| `cancelEventReason` | 14663 |
| `cancelModal` | 34922 |
| `cancelModalMsg` | 22009 |
| `cancelNotes` | 22000 |
| `cancelPreviewArea` | 34920 |
| `cancelPreviewLoading` | 34921 |
| `cancelReason` | 21997 |
| `cancelReasonDropdown` | 34914 |
| `cancelReasonInput` | 34915 |
| `cancelRefundAmount` | 21999 |
| `career-tab-history` | 15256 |
| `careerAddNewBtn` | 15326 |
| `careerBadge` | 15268 |
| `careerDesc` | 15270 |
| `careerDrawerTitle` | 15258 |
| `careerFile` | 15246 |
| `careerForm` | 15245 |
| `careerLocation` | 15269 |
| `careerPosterPreview` | 15249 |
| `careerPosterPreviewImg` | 15249 |
| `careerSubmitBtn` | 15259 |
| `careerTitle` | 15267 |
| `careerUploadText` | 15252 |
| `careerUploadZone` | 15446 |
| `careerUrl` | 15271 |
| `careerVideoWarning` | 15248 |
| `careerYear` | 15153 |
| `clearCareerBtn` | 15180 |
| `clearGalleryBtn` | 16297 |
| `clearHomeBtn` | 13543 |
| `contactAdminForm` | 16185 |
| `contactDeliveryEmail` | 16135 |
| `contactQuote` | 16136 |
| `contactSig` | 16137 |
| `contactSubmitBtn` | 16202 |
| `contractBookingId` | 12685 |
| `contractConfirmSignBtn` | 22481 |
| `contractCurrentStatus` | 22307 |
| `contractDownloadBtn` | 22332 |
| `contractDrawer` | 22523 |
| `contractDropZone` | 22405 |
| `contractFileInput` | 22383 |
| `contractFileName` | 22437 |
| `contractFilePreview` | 22384 |
| `contractFileSize` | 22438 |
| `contractModalMsg` | 22385 |
| `contractRemindBtn` | 22335 |
| `contractSendBtn` | 22337 |
| `contractSignatoryName` | 22387 |
| `contractSignedDate` | 22388 |
| `contractSignForm` | 22308 |
| `contractSignMsg` | 22386 |
| `contractUploadBtn` | 22444 |
| `csvFileInput` | 24460 |
| `dashboardAdmin` | 35592 |
| `dashboardSection` | 18206 |
| `dashNeedsActionCount` | 25644 |
| `dashSocialCardsToggle` | 35625 |
| `db-chartDevices` | 35317 |
| `db-chartSources` | 35277 |
| `db-chartVisitors` | 35237 |
| `db-listCountries` | 35404 |
| `db-listPages` | 35418 |
| `db-mapCountries` | 35434 |
| `dbScheduleEmpty` | 35549 |
| `dbScheduleList` | 35547 |
| `dbScheduleSpinner` | 35548 |
| `dealViewDrawer` | 12836 |
| `draftDeleteBtn` | 25087 |
| `draftLoadSelect` | 25073 |
| `draftSaveBtn` | 25026 |
| `draftStatus` | 25014 |
| `draftUpdateBtn` | 25050 |
| `dv-panel-advancing` | 12794 |
| `dv-panel-files` | 13112 |
| `dv-panel-invoices` | 13103 |
| `dv-panel-offer` | 13102 |
| `dv-panel-overview` | 13100 |
| `dv-panel-progress` | 13101 |
| `dv-panel-timeline` | 13111 |
| `dv-tab-overview` | 13117 |
| `dvActions` | 13091 |
| `dvBreadcrumbCur` | 13070 |
| `dvChips` | 13087 |
| `dvRefreshBtn` | 13359 |
| `dvStatusRow` | 13074 |
| `dvSubtitle` | 13072 |
| `dvTabs` | 12827 |
| `dvTitle` | 13071 |
| `editSubscriberBirthdayDay` | 24660 |
| `editSubscriberBirthdayMonth` | 24666 |
| `editSubscriberEmail` | 24678 |
| `editSubscriberFeedback` | 24687 |
| `editSubscriberFirstName` | 24679 |
| `editSubscriberForm` | 24694 |
| `editSubscriberId` | 24677 |
| `editSubscriberNotes` | 24685 |
| `editSubscriberSubmit` | 24720 |
| `editSubscriberTags` | 24684 |
| `embedActive` | 17332 |
| `embedActiveLabel` | 17333 |
| `embedIconPreviewDisplay` | 17291 |
| `embedPlatform` | 17331 |
| `embedUrlCode` | 17342 |
| `err-footprintForm` | 15677 |
| `err-newsletterContent` | 24984 |
| `err-newsletterSubject` | 24971 |
| `err-testimonialsForm` | 15848 |
| `errBrandColor` | 34574 |
| `errEditSubscriberBirthday` | 24686 |
| `eventsAddNewBtn` | 14820 |
| `eventsAdmin` | 14526 |
| `eventsBlockType` | 14751 |
| `eventsBookingId` | 14725 |
| `eventsCapacity` | 14716 |
| `eventsConflictResolutionGroup` | 14750 |
| `eventsDate` | 14703 |
| `eventsDesc` | 14696 |
| `eventsEndTime` | 14734 |
| `eventsFallbackUrl` | 14718 |
| `eventsFile` | 14870 |
| `eventsForm` | 14797 |
| `eventsGcalLink` | 14758 |
| `eventsGcalLinkBadge` | 14759 |
| `eventsGcalSync` | 14763 |
| `eventsId` | 14694 |
| `eventsLinkedBookingBadge` | 14742 |
| `eventsLinkedBookingLink` | 14743 |
| `eventsSearchInput` | 14447 |
| `eventsStatus` | 14726 |
| `eventsSubmitBtn` | 14765 |
| `eventsTicketUrl` | 14717 |
| `eventsTitle` | 14695 |
| `eventsType` | 14727 |
| `eventsUploadText` | 15015 |
| `eventsUploadZone` | 15040 |
| `eventsVenue` | 14714 |
| `eventsVenueMapLink` | 14715 |
| `eventsVenueSearch` | 15126 |
| `eventVideoWarning` | 14961 |
| `evt-tab-history` | 14774 |
| `evtBulkBar` | 14521 |
| `evtBulkCancel` | 14545 |
| `evtBulkCancelEvt` | 14605 |
| `evtBulkComplete` | 14642 |
| `evtBulkCount` | 14520 |
| `evtBulkDelete` | 14589 |
| `evtBulkPostpone` | 14624 |
| `evtBulkPublish` | 14553 |
| `evtBulkToggle` | 14525 |
| `evtBulkUnpublish` | 14571 |
| `evtCancelEventBtn` | 14767 |
| `evtCountPast` | 14444 |
| `evtCountUpcoming` | 14443 |
| `evtDrawerTitle` | 14764 |
| `evtPosterPreview` | 14721 |
| `evtPosterPreviewImg` | 14720 |
| `expEndOdo` | 22734 |
| `expenseAmount` | 22669 |
| `expenseBookingSelect` | 22679 |
| `expenseCategory` | 22668 |
| `expenseCategoryFilter` | 22557 |
| `expenseCategoryTotals` | 22574 |
| `expenseDate` | 22671 |
| `expenseDateFrom` | 22558 |
| `expenseDateTo` | 22559 |
| `expenseDescription` | 22670 |
| `expenseDrawer` | 22803 |
| `expenseDrawerLabel` | 22810 |
| `expenseEditId` | 22781 |
| `expenseModalBookingId` | 22674 |
| `expenseModalMsg` | 22673 |
| `expenseReceiptFile` | 22818 |
| `expenseReceiptUrl` | 22672 |
| `expensesGrandTotal` | 22573 |
| `expenseVendor` | 22768 |
| `expMileageBlock` | 22729 |
| `exportSubscribersBtn` | 24610 |
| `expPerDiemBlock` | 22730 |
| `expPerDiemDays` | 22745 |
| `expPerDiemRate` | 22746 |
| `expRatePerKm` | 22735 |
| `expReceiptUploadStatus` | 22707 |
| `expStartOdo` | 22733 |
| `expTotalKm` | 22738 |
| `expVatPaid` | 22774 |
| `expVatRate` | 22775 |
| `fbAppId` | 17314 |
| `fbAppSecret` | 17315 |
| `fbTokenGenerator` | 17302 |
| `featCardsEditor` | 14044 |
| `featPrevGrid` | 14066 |
| `featuresSubmitBtn` | 14107 |
| `finAging30Count` | 32434 |
| `finAging30Val` | 32435 |
| `finAging60Count` | 32437 |
| `finAging60Val` | 32438 |
| `finAging90Count` | 32440 |
| `finAging90Val` | 32441 |
| `finAgingCurrentCount` | 32431 |
| `finAgingCurrentVal` | 32432 |
| `finAnalyticsOverdueListBody` | 32363 |
| `finAnalyticsTopClientsList` | 32362 |
| `finCustomDateRow` | 31900 |
| `finDateFrom` | 31886 |
| `finDateTo` | 31887 |
| `finExpensesList` | 22565 |
| `finInvoicesList` | 32134 |
| `finNetProfitDelta` | 31983 |
| `finPeriodLabel` | 31918 |
| `finPeriodPreset` | 31898 |
| `finRemindersList` | 32095 |
| `finSchedMismatchBody` | 32657 |
| `finSchedMismatchCount` | 32663 |
| `finStat-DueSoon` | 31946 |
| `finStat-Expenses` | 31956 |
| `finStat-ExpensesPeriod` | 31957 |
| `finStat-Margin` | 31964 |
| `finStat-NetProfit` | 31960 |
| `finStat-Outstanding` | 31931 |
| `finStat-Overdue` | 31940 |
| `finStat-Pending` | 31934 |
| `finStat-PendingCount` | 31935 |
| `finStat-PeriodLabel` | 31919 |
| `finStat-RevenueInline` | 31928 |
| `finStat-TotalRevenue` | 31927 |
| `finStat-Unsent` | 31951 |
| `finTile-DueSoon` | 31947 |
| `finTile-Overdue` | 31941 |
| `finTile-Unsent` | 31952 |
| `finTransactionsList` | 32015 |
| `footprint-tab-history` | 15679 |
| `footprintCountrySelect` | 15674 |
| `footprintDrawerTitle` | 15681 |
| `footprintFlagPreview` | 15675 |
| `footprintFlagPreviewImg` | 15676 |
| `footprintForm` | 15673 |
| `footprintSubmitBtn` | 15682 |
| `forceConfirmPwd` | 34734 |
| `forceNewPwd` | 34733 |
| `forcePasswordChangeOverlay` | 25760 |
| `forcePwdBtn` | 34731 |
| `forcePwdError` | 34732 |
| `forcePwdForm` | 34729 |
| `forgotBtn` | 26005 |
| `forgotEmail` | 26003 |
| `forgotMessage` | 25980 |
| `forgotPasswordCard` | 25976 |
| `gallery-tab-history` | 16443 |
| `galleryAddNewBtn` | 16482 |
| `galleryDrawerTitle` | 16445 |
| `galleryImageFields` | 16435 |
| `galleryPreview` | 16441 |
| `galleryPreviewImg` | 16441 |
| `galleryUploadText` | 16420 |
| `galleryUploadZone` | 17015 |
| `generateInvoiceModal` | 32346 |
| `giBookingDetails` | 32310 |
| `giBookingSelect` | 32300 |
| `giClientName` | 32330 |
| `giEventDate` | 32331 |
| `giSubmitBtn` | 32311 |
| `giTotalAmount` | 32332 |
| `heroInput` | 13950 |
| `heroPrev` | 13998 |
| `heroSubmitBtn` | 14091 |
| `home-tab-history` | 13642 |
| `homeAddNewBtn` | 13676 |
| `homeAlt` | 13649 |
| `homeDrawerTitle` | 13644 |
| `homeFile` | 13518 |
| `homeForm` | 13637 |
| `homePreview` | 13504 |
| `homePreviewImg` | 13504 |
| `homeSubmitBtn` | 13645 |
| `homeUploadText` | 13499 |
| `homeUploadZone` | 13512 |
| `homeUrl` | 13650 |
| `iconPreviewDisplay` | 17101 |
| `importFileName` | 24450 |
| `importProgress` | 24463 |
| `importProgressBar` | 24464 |
| `importResult` | 24466 |
| `importStatus` | 24465 |
| `importSubscribersBtn` | 24473 |
| `importSubscribersModal` | 24475 |
| `inqAssignSelect` | 18245 |
| `inqAttachmentFileInput` | 18824 |
| `inqAttachmentsList` | 18933 |
| `inqBrowseLink` | 18826 |
| `inqBulkArchiveBtn` | 19252 |
| `inqBulkBar` | 19224 |
| `inqBulkCount` | 19223 |
| `inqBulkDeleteBtn` | 19253 |
| `inqBulkReadBtn` | 19251 |
| `inqCategoryInput` | 18535 |
| `inqCategoryList` | 18262 |
| `inqCcRow` | 18616 |
| `inqComposeBtn` | 19177 |
| `inqComposeReplyTo` | 18607 |
| `inqComposerTitle` | 18605 |
| `inqComposeSendBtn` | 19576 |
| `inqComposeSubject` | 18606 |
| `inqComposeToInput` | 18663 |
| `inqComposeView` | 18559 |
| `inqConvertedLink` | 18541 |
| `inqConvertedLinkText` | 18540 |
| `inqConvertToBookingBtn` | 18539 |
| `inqCount-all` | 18372 |
| `inqCount-archived` | 18376 |
| `inqCount-drafts` | 18377 |
| `inqCount-mine` | 18379 |
| `inqCount-read` | 18374 |
| `inqCount-replied` | 18375 |
| `inqCount-scheduled` | 18378 |
| `inqCount-unread` | 18373 |
| `inqDragDropZone` | 18823 |
| `inqFolderTitle` | 19194 |
| `inqListBody` | 18296 |
| `inqNextBtn` | 18435 |
| `inqNoteInput` | 18552 |
| `inqNotesBody` | 18548 |
| `inqNotesCount` | 18551 |
| `inqNotesList` | 18550 |
| `inqNotesToggle` | 18549 |
| `inqOverdueBadge` | 18518 |
| `inqPageInfo` | 18433 |
| `inqPagination` | 18326 |
| `inqPrevBtn` | 18434 |
| `inqPreviewBackdrop` | 19121 |
| `inqPreviewIframe` | 19527 |
| `inqPrioritySelect` | 18533 |
| `inqProgressBarFill` | 18877 |
| `inqReadAvatar` | 18510 |
| `inqReadBody` | 18556 |
| `inqReadChips` | 18526 |
| `inqReadDate` | 18514 |
| `inqReadFrom` | 18512 |
| `inqReadFromEmail` | 18513 |
| `inqReadStatusBadge` | 18515 |
| `inqReadSubject` | 18511 |
| `inqReadView` | 18560 |
| `inqRefreshBtn` | 19170 |
| `inqSchedulePicker` | 18627 |
| `inqScheduleSendRow` | 18626 |
| `inqSearchInput` | 18298 |
| `inqSelectAll` | 19195 |
| `inqSendDropdownMenu` | 19483 |
| `inqSortSelect` | 18297 |
| `inqTemplateSelect` | 18620 |
| `inqUploadFileName` | 18876 |
| `inqUploadProgressBox` | 18874 |
| `inqUploadProgressPercent` | 18875 |
| `invoiceStatusFilter` | 28442 |
| `kpiSettingsContainer` | 17662 |
| `lcConsentEmpty` | 34171 |
| `lcConsentLimit` | 34166 |
| `lcConsentNext` | 34184 |
| `lcConsentPageInfo` | 34182 |
| `lcConsentPrev` | 34183 |
| `lcConsentSearch` | 34164 |
| `lcConsentTable` | 34170 |
| `lcConsentType` | 34165 |
| `lcContractLimit` | 34212 |
| `lcContractSearch` | 34210 |
| `lcContractsEmpty` | 34217 |
| `lcContractsNext` | 34246 |
| `lcContractsPageInfo` | 34244 |
| `lcContractsPrev` | 34245 |
| `lcContractStatus` | 34211 |
| `lcContractsTbody` | 34216 |
| `lcPanelVersionHistory` | 34132 |
| `lcPreviewModal` | 34313 |
| `lcPreviewModalBody` | 34312 |
| `lcPreviewModalTitle` | 34311 |
| `lcRecentActivity` | 34149 |
| `lcStatConsent` | 34145 |
| `lcStatDocs` | 34143 |
| `lcStatDraft` | 34147 |
| `lcStatSigned` | 34146 |
| `lcStatVersions` | 34144 |
| `lcVhList` | 34284 |
| `lcVhSearch` | 34292 |
| `lcVhType` | 34283 |
| `loginBtn` | 25810 |
| `loginCard` | 25975 |
| `loginError` | 25783 |
| `loginSection` | 18208 |
| `logoutBtn` | 25908 |
| `logSearch` | 25450 |
| `logTriggerFilter` | 25449 |
| `managerAdminForm` | 16159 |
| `managerClearBtn` | 16260 |
| `managerEmail` | 16150 |
| `managerName` | 16149 |
| `managerSubmitBtn` | 16242 |
| `managerWhatsAppLink` | 16151 |
| `manualBookingAlert` | 29567 |
| `manualTxAmount` | 22889 |
| `manualTxBooking` | 22894 |
| `manualTxDate` | 22888 |
| `manualTxDirBlock` | 22908 |
| `manualTxDirection` | 22891 |
| `manualTxMethod` | 22892 |
| `manualTxMethodBlock` | 22909 |
| `manualTxMsg` | 22893 |
| `manualTxNotes` | 22926 |
| `manualTxReference` | 22925 |
| `manualTxType` | 22890 |
| `mbAddress` | 29579 |
| `mbBudget` | 29576 |
| `mbCity` | 29578 |
| `mbCompany` | 29596 |
| `mbCountry` | 29580 |
| `mbDate` | 29572 |
| `mbEmail` | 29594 |
| `mbEstDuration` | 29536 |
| `mbEstPrice` | 29537 |
| `mbEventName` | 29597 |
| `mbEventType` | 29574 |
| `mbLocation` | 29598 |
| `mbMessage` | 29599 |
| `mbName` | 29593 |
| `mbPhone` | 29595 |
| `mbPlaceId` | 29577 |
| `mbServicesContainer` | 29443 |
| `mbSourceInquiryId` | 29581 |
| `mbStatus` | 29575 |
| `mbTime` | 29573 |
| `mbTotalsDisplay` | 29533 |
| `mediaAlt` | 16454 |
| `mediaFile` | 16434 |
| `mediaUrl` | 16452 |
| `miniCalendarBody` | 29237 |
| `miniMonthYearDisplay` | 29238 |
| `newsletterAdmin` | 25518 |
| `newsletterAttachments` | 25153 |
| `newsletterAudienceCount` | 24947 |
| `newsletterAudienceDays` | 24926 |
| `newsletterAudienceMonth` | 24923 |
| `newsletterAudienceSelect` | 24921 |
| `newsletterAudienceSource` | 24925 |
| `newsletterAudienceTag` | 24924 |
| `newsletterAudienceValueIcon` | 24939 |
| `newsletterAudienceValueWrap` | 24937 |
| `newsletterEditor` | 31762 |
| `newsletterEditorContainer` | 24973 |
| `newsletterForm` | 24968 |
| `newsletterMessage` | 24990 |
| `newsletterPreviewBtn` | 25166 |
| `newsletterPreviewFrame` | 24849 |
| `newsletterPreviewModal` | 24850 |
| `newsletterScheduleBtn` | 25125 |
| `newsletterSendTestBtn` | 25188 |
| `newsletterSubject` | 24972 |
| `newsletterSubmitBtn` | 24991 |
| `newsletterUploadText` | 25145 |
| `newSubscriberEmail` | 24631 |
| `newSubscriberFirstName` | 24632 |
| `nextMiniMonth` | 29240 |
| `note-input-${...}` | 22207 |
| `note-input-${id}` | 22207 |
| `notes-thread-${...}` | 12771 |
| `notes-thread-${bookingId}` | 12771 |
| `notes-thread-${id}` | 22161 |
| `platformApiKey` | 17298 |
| `polCancellation` | 21283 |
| `polDeposit` | 21278 |
| `polInquirySlaHours` | 33947 |
| `polPaymentTerms` | 21282 |
| `polQuoteValidity` | 33942 |
| `polReminderDays1` | 33945 |
| `polReminderDays2` | 33946 |
| `previewAboutImg` | 13791 |
| `previewAboutP1` | 13786 |
| `previewAboutP2` | 13787 |
| `previewAboutP3` | 13788 |
| `prevMiniMonth` | 29239 |
| `prevPolicy` | 34930 |
| `prevRefund` | 34932 |
| `prevRetention` | 34931 |
| `prevTotalPaid` | 34929 |
| `promote-${...}` | 23389 |
| `promote-${id}` | 23389 |
| `promote-badge-${...}` | 23313 |
| `promote-badge-${id}` | 23313 |
| `promote-preview-${...}` | 23314 |
| `promote-preview-${id}` | 23314 |
| `promote-ticket-${...}` | 23352 |
| `promote-ticket-${id}` | 23352 |
| `promote-ticket-msg-${...}` | 23390 |
| `promote-ticket-msg-${id}` | 23390 |
| `promoteBookingModal` | 21839 |
| `promoteBookingModalDate` | 21837 |
| `promoteBookingModalId` | 21835 |
| `promoteBookingModalName` | 21836 |
| `promoteBookingModalVenue` | 21838 |
| `qbApplyVat` | 21130 |
| `qbClientEmail` | 21242 |
| `qbClientName` | 21241 |
| `qbDepositAmount` | 21611 |
| `qbDepositPercentage` | 21129 |
| `qbDiscount` | 21128 |
| `qbDrawerBackdrop` | 33764 |
| `qbEventDate` | 21244 |
| `qbEventName` | 21243 |
| `qbFinalTotal` | 21607 |
| `qbItemsBody` | 21320 |
| `qbRadioGlobal` | 21361 |
| `qbRadioLocal` | 21631 |
| `qbSaveStatus` | 21112 |
| `qbServiceSelector` | 21427 |
| `qbSubtotal` | 21605 |
| `qbSvcPreviewAdmin` | 21461 |
| `qbTermsBadge` | 21405 |
| `qbTermsBadgeText` | 21404 |
| `qbTermsOptMilestones` | 21408 |
| `qbTermsOptPolicies` | 21407 |
| `qbVatAmount` | 21606 |
| `quoteDrawer` | 21163 |
| `quoteModalBookingId` | 21109 |
| `quoteModalDetails` | 21132 |
| `quoteModalExpiry` | 21127 |
| `quoteModalMsg` | 21385 |
| `recon-detail-${...}` | 23180 |
| `recon-detail-${bookingId}` | 23180 |
| `recon-detail-inner-${...}` | 23182 |
| `recon-detail-inner-${bookingId}` | 23182 |
| `reconSummary` | 23096 |
| `reconTableBody` | 23095 |
| `reconWarnFilter` | 23099 |
| `rememberMe` | 25802 |
| `rfAmount` | 21933 |
| `rfNotes` | 21935 |
| `rfReference` | 21934 |
| `rpAmountPaid` | 21982 |
| `rpBookingId` | 21980 |
| `rpBookingLabel` | 21981 |
| `rpPaymentStatus` | 21983 |
| `saveKpiSettingsBtn` | 17840 |
| `schedule-edit-form-${...}` | 32737 |
| `schedule-edit-form-${bookingId}` | 32737 |
| `schedule-editor-total-sum-${...}` | 32810 |
| `schedule-editor-total-sum-${bookingId}` | 32810 |
| `schedule-milestones-list-${...}` | 32742 |
| `schedule-milestones-list-${bookingId}` | 32742 |
| `scheduledDateTime` | 15119 |
| `scheduleFields` | 25123 |
| `scheduleToggle` | 25121 |
| `secEmpty` | 14227 |
| `secLoading` | 14201 |
| `secSearch` | 14220 |
| `sectionsList` | 14165 |
| `selectAllCampaigns` | 25293 |
| `selectAllSubscribers` | 24361 |
| `servicesSubmitBtn` | 14268 |
| `socActive` | 17115 |
| `socActiveLabel` | 17116 |
| `socialEmbedDrawerTitle` | 17335 |
| `socialEmbedForm` | 17329 |
| `socialEmbedSaveBtn` | 17334 |
| `socialIconForm` | 17112 |
| `socialIconSubmitBtn` | 17117 |
| `socialLinkDrawerTitle` | 17118 |
| `socName` | 17124 |
| `socUrl` | 17125 |
| `startImportBtn` | 24451 |
| `stNotificationEmail` | 34360 |
| `stPayfastId` | 34344 |
| `stPayfastKey` | 34345 |
| `stPayfastPass` | 34348 |
| `stPayfastUrl` | 34354 |
| `stSmtpFrom` | 34359 |
| `stSmtpHost` | 34355 |
| `stSmtpPass` | 34358 |
| `stSmtpPort` | 34356 |
| `stSmtpUser` | 34357 |
| `subKpiActive` | 24285 |
| `subKpiNew7d` | 24286 |
| `subKpiTotal` | 24284 |
| `submitBtn` | 16446 |
| `submitCancelBtn` | 34918 |
| `subscriberBulkBar` | 24376 |
| `subscriberCount` | 24175 |
| `subscriberCountLabel` | 24209 |
| `subscriberListBody` | 24174 |
| `subscriberListEmpty` | 24176 |
| `subscriberSearch` | 24351 |
| `subscribersPagination` | 24181 |
| `svcActive` | 33659 |
| `svcAdvancedPanel` | 8607 |
| `svcAvailabilityRule` | 33661 |
| `svcBasePrice` | 33791 |
| `svcCardGrid` | 33566 |
| `svcCardsEditor` | 13979 |
| `svcCategory` | 33657 |
| `svcCrewRequired` | 33668 |
| `svcDesc` | 33783 |
| `svcDrawer` | 33649 |
| `svcDrawerBackdrop` | 33648 |
| `svcDrawerTitle` | 33671 |
| `svcEditId` | 33656 |
| `svcExternalNote` | 33810 |
| `svcEyebrow` | 13951 |
| `svcFilterCount` | 33575 |
| `svcFinancialCategory` | 33665 |
| `svcFulfillmentType` | 33666 |
| `svcHeading` | 13952 |
| `svcInternalNote` | 33669 |
| `svcIsDeleted` | 33668 |
| `svcItemCategory` | 33666 |
| `svcLeadTime` | 33661 |
| `svcLegacyCode` | 33807 |
| `svcMarketingSegment` | 33801 |
| `svcMaxQty` | 33658 |
| `svcMinQty` | 33658 |
| `svcModelFilter` | 33537 |
| `svcName` | 33656 |
| `svcPerfLength` | 33662 |
| `svcPill-All` | 33531 |
| `svcPrevEyebrow` | 14016 |
| `svcPrevGrid` | 14031 |
| `svcPrevHeading` | 14017 |
| `svcPrice` | 33784 |
| `svcPriceLabel` | 33680 |
| `svcPricingGroup` | 33660 |
| `svcPricingModel` | 33657 |
| `svcRevenueGlCode` | 33667 |
| `svcSearchInput` | 33536 |
| `svcSetupTime` | 33662 |
| `svcShowArchivedBtn` | 33546 |
| `svcStat-Active` | 33527 |
| `svcStat-Archived` | 33529 |
| `svcStat-Inactive` | 33528 |
| `svcStat-Total` | 33526 |
| `svcStatusFilter` | 33589 |
| `svcTaxable` | 33659 |
| `svcTaxCategory` | 33804 |
| `svcTaxClass` | 33663 |
| `svcTimeFields` | 33679 |
| `svcTravelIncluded` | 33663 |
| `svcType` | 33660 |
| `svcUnit` | 33786 |
| `svcValidFrom` | 33670 |
| `svcValidTo` | 33812 |
| `taglineInput` | 13949 |
| `taglinePrev` | 13996 |
| `testimonialDesignation` | 15863 |
| `testimonialFile` | 15845 |
| `testimonialName` | 15862 |
| `testimonialPhotoPreview` | 15846 |
| `testimonialPhotoPreviewImg` | 15847 |
| `testimonialQuote` | 15864 |
| `testimonials-tab-history` | 15853 |
| `testimonialsDrawerTitle` | 15855 |
| `testimonialsForm` | 15844 |
| `testimonialsPendingBadge` | 15903 |
| `testimonialsStatusFilter` | 15895 |
| `testimonialsSubmitBtn` | 15856 |
| `testimonialUploadText` | 15851 |
| `testimonialUploadZone` | 16045 |
| `testNotifBtn` | 34673 |
| `toggleCcBccBtn` | 18617 |
| `togglePass` | 25988 |
| `txCountBadge` | 32021 |
| `txDateFrom` | 32070 |
| `txDateTo` | 32071 |
| `txGrandTotal` | 32020 |
| `txSearchInput` | 32068 |
| `txTypeFilter` | 32069 |
| `upcomingScheduleList` | 29313 |
| `venue-addr-${...}` | 22286 |
| `venue-addr-${id}` | 22286 |
| `venue-city-${...}` | 22287 |
| `venue-city-${id}` | 22287 |
| `venue-country-${...}` | 22288 |
| `venue-country-${id}` | 22288 |
| `venue-edit-row-${...}` | 22270 |
| `venue-edit-row-${id}` | 22270 |
| `venue-loc-${...}` | 22282 |
| `venue-loc-${id}` | 22282 |
| `venueLinkGoogle-${...}` | 13383 |
| `venueLinkGoogle-${bookingId}` | 13383 |
| `venueLinkGoogleBtn-${...}` | 13398 |
| `venueLinkGoogleBtn-${bookingId}` | 13398 |
| `videoWarning` | 16417 |
| `whGapMinutes` | 34430 |
| `workingHoursTbody` | 34412 |

</details>

---

## Summary vs. baseline

| Metric | Baseline | Found |
|---|---|---|
| Inline `<script>` blocks | 14 | 14 |
| Inline `<style>` blocks | 8 | 8 |
| Inline script chars (total) | 1,228,396 | 1,249,410 |
| Inline style chars (total) | 285,657 | 291,343 |
| `on*=` inline handler attributes | 253 | 255 |
| `id=` attributes in static markup (outside inline scripts) | 1,526 | 1,465 |
| `id=` occurrences inside inline `<script>` blocks (dynamic HTML strings) | - | 236 |
| Distinct ids referenced from JS | — | 921 |
| Admin sections (`.admin-section` divs) | — | 22 |
| Distinct function definitions found | — | 512 (528 total matches) |
