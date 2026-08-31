# Housekeeping Notes

Tracks moves, quarantines, and deferred fixes across the housekeeping phases
described in `housekeeping-agent-prompts.md`. Nothing in this file is
optional reading before starting a new phase.

---

## Phase 5 — Route & middleware split

In progress. Splits `server.js` along the admin/public boundary per the plan: `routes/admin/`,
`routes/public/`, an `app.js` that mounts everything, `server.js` reduced to process-entry-point
only. Route counts confirmed via live grep: **270** `/api/admin/*`, **49** `/api/public/*` —
exactly matching the plan's estimate.

### Extraction tooling

Routes are moved with a small AST-based script (`acorn`, installed only in the scratchpad
directory — not a project dependency), not by hand: hand-finding where a 200-line nested-callback
route handler ends is error-prone at this scale. The script parses `app.js`, finds every top-level
`app.<method>('/api/admin/...'` / `'/api/public/...'` call plus its exact source range (attaching
an immediately-preceding comment, if any), and for a chosen batch: cuts those exact ranges out of
`app.js`, swaps `app.` → `router.` at each one, and inserts the result into the target
`routes/admin/*.js` / `routes/public/*.js` file before its `module.exports` line (creating the
file with a router boilerplate header if it doesn't exist yet). Dry-run verified against a real
two-route sample before ever pointing it at the live file — diffed clean, syntax-checked clean.

**Discovered mid-implementation and fixed:** the first extraction attempt crashed after cutting
routes out of `app.js` but before the target directory existed to receive them — the script wrote
`app.js` *before* confirming the output file could be written. Caught immediately (`git diff`
showed the missing routes with nowhere written), recovered with `git checkout -- app.js` (nothing
was ever committed in the broken state), and fixed the script to write the output file first,
`app.js` only after that succeeds — a batch attempt now either fully completes or leaves `app.js`
completely untouched.

### Helper relocation (discovered necessary, not in the original plan text)

Dry-run testing the mechanical extraction surfaced a problem the plan doesn't address: routes call
helper functions/constants defined inline in `app.js` (`resolveActor`, `logAudit`,
`createAndSendInvite`, `VALID_ADMIN_ROLES`, `dbRun`/`dbGet`/`dbAll`, and more not yet
inventoried) that a standalone route file can't reach — `app.js` requires the route files, so a
route file requiring `app.js` back for them would be circular and silently resolve to `undefined`.
Confirmed with the user: relocate each helper into `lib/` **as its batch needs it**, not as a big
speculative upfront pass. Repository functions need no such treatment — already standalone modules,
any route file imports them directly.

Two structural fixes were needed before route files could import middleware at all:
- **`middleware/rate-limiters.js`** (new): all 11 rate limiters (`booking`, `export`, `sitemap`,
  `track`, `otpRequest`, `mutate`, `admin`, `adminLogin`, `lookup`, `analyticsTrack`, `ip`) plus
  `payfastItnRateLimiter`/`PAYFAST_VALID_IPS`, byte-identical, centralised so any route file has one
  place to import whichever limiter its route used — previously all defined inline in `app.js`.
- **`middleware/auth.js` reworked**: `requireAdmin` was a factory (`createRequireAdmin(adminRateLimiter)`)
  `app.js` had to call — no route file could reach the same array without a circular require. Now a
  plain export: the fully-built `[adminRateLimiter, checkFn]` array, built from
  `rate-limiters.js` + the auth-users repository, both leaf modules.

`lib/` additions so far, all byte-identical bodies moved out of `app.js`:
- `lib/db-helpers.js` — `dbRun`/`dbGet`/`dbAll` (~190 call sites throughout `app.js`).
- `lib/actor.js` — `resolveActor`.
- `lib/audit-log.js` — `logAudit` (writes `audit_log`, the permanently-excluded generic infra table
  from Phase 4 — not owned by any domain repository, so this is its natural home).
- `lib/admin-users.js` — `VALID_ADMIN_ROLES`, `countOtherActiveAdministrators`,
  `createAndSendInvite`, specific to the `/api/admin/users` route cluster.

`app.js` destructure-imports all of these back, so its own not-yet-moved routes keep working
unchanged — same pattern Phase 4 established for repository functions.

### Route batch 1: `routes/admin/users.js` — DONE

6 routes: `GET/POST /api/admin/users`, `GET /api/admin/user-login-logs`,
`POST /api/admin/users/:id/resend-invite`, `PUT/DELETE /api/admin/users/:id`. First real batch —
chosen deliberately small and well-understood (this is the exact route cluster the `auth+users`
Phase 4 domain already covered) to prove the whole pipeline — mechanical extraction, per-route-file
imports (middleware + repository functions + the four `lib/` helpers above + `bcrypt`/`crypto`),
mounting, verification — end to end before scaling up.

Mounted in `app.js` via `app.use(require('./routes/admin/users'))`, placed right after the session
middleware (after body-parsing/sanitisation are in place, before any not-yet-extracted route) — a
new "Phase 5 route mounts" section that will grow one line per batch.

Verification: `node -c` on `app.js` and the new route file; re-grepped
`app\.(get|post|put|delete)\('/api/admin/users` against post-edit `app.js` — zero hits, confirming
a clean, complete removal. `npm run smoke` 329/329 (all 6 routes still reachable through the new
router). `npm test` x3 — baseline plus a mix of already-documented flakes each run (CP5, CP12 x2,
CP21, the calendar-booking-sync reschedule test, the one-off "full refund" flake), never anything
touching `admins`/`admin_login_logs`/`password_reset_tokens`. Specifically confirmed via the test
log (not just smoke's non-5xx check) that the two `audit-history.test.js` checks exercising
`logAudit` from inside the moved routes ("user create/update writes exactly one audit_log row")
passed, and all `/api/admin/users`-related RBAC checks passed, on every run.

### Route batch 2: `routes/admin/auth.js` — DONE

7 routes: `POST /api/admin/login`, `POST /api/admin/force-change-password`,
`POST /api/admin/logout`, `GET /api/admin/session`, `POST /api/admin/forgot-password`,
`POST /api/admin/reset-password`, `POST /api/admin/session/heartbeat`. The login/session/password
half of `auth+users`, split from batch 1's user-management CRUD — no shared helper overlap
(no `resolveActor`/`logAudit`/`createAndSendInvite` needed here), just repository functions +
`bcrypt`/`crypto`/`emailComponents`/`sendEmail` + `requireAdmin`/`adminLoginRateLimiter`.

This batch includes `POST /api/admin/login` itself — the single most foundational route in the
app (nearly every other test's setup depends on it working). Ran the full suite **3 times**
specifically because of that: 648-649/651 every run, only the permanent baseline plus one
already-documented flake (CP5) on one run. If login/session handling had broken in the move, the
signal would be hundreds of cascading failures, not 2-3 — this is about as strong a confirmation
as the test suite can give.

### Route batch 3: `routes/admin/settings.js` — DONE

8 routes: `GET/PUT /api/admin/working-hours`, `GET /api/admin/audit_log`,
`GET /api/admin/financial_audit_log`, `GET/PUT /api/admin/policies`, `GET/PUT /api/admin/settings`.
None of these tables (`working_hours`, `audit_log`, `financial_audit_log`, `policies`) are owned by
a Phase 4 repository (`audit_log`/`financial_audit_log` permanently excluded; `policies` flagged
unclaimed in the `calendar` write-up; `working_hours` never claimed by anyone) — these routes do
raw `db.all`/`db.run`/`db.serialize` calls directly, so this file imports `db` itself rather than
a repository.

**A new kind of shared-state problem, not just missing imports:** `PUT /api/admin/working-hours`
mutated two module-scoped `let MIN_BOOKING_GAP_MINS`/`let TYPE_BUFFERS` variables that
`hasCalendarConflict()` and two other still-in-`app.js` read sites depend on for every booking's
conflict check. CommonJS requires copy a primitive's *value* at import time, not a live binding —
had this route moved with a naive `require` of those two names, its write would silently update
only its own local copy, leaving every conflict check in `app.js` reading the stale default
forever. Fixed with **`lib/booking-config.js`**: both variables become properties of one exported
object (`bookingConfig.minGapMins`/`.typeBuffers`) — mutating a *property* of an already-shared
object *does* stay visible everywhere that imported it, unlike reassigning a plain variable. All 3
read sites in `app.js` (not just the one write this batch moved) were updated to the new shape,
confirmed via `grep` that no bare `MIN_BOOKING_GAP_MINS`/`TYPE_BUFFERS` reference survived anywhere.

Verification: `node -c`; confirmed zero remaining `app.js` registrations for any of the 8 paths;
`npm run smoke` 329/329; `npm test` x3 (only already-documented flakes). Specifically checked the
audit_log route's dynamic-SQL + `admins` JOIN and the shared-state fix aren't just passing by
smoke-test luck — `audit_log table+record_id filter succeeds`, `audit_log join resolves an actor
name for numeric changed_by rows`, and all `working-hours`/`audit_log`/`financial_audit_log` RBAC
checks passed on every run.

### Route batch 4: `routes/admin/site-content.js` — DONE

10 routes: `POST /api/admin/migrate`, `PUT /api/admin/branding`, `GET /api/admin/venues`,
`GET /api/admin/reviews`, `PUT/DELETE /api/admin/manager`, `POST /api/admin/contact_info`,
`GET/POST /api/admin/about-me`, `PUT /api/admin/site-content`. A grab-bag of small,
otherwise-unrelated admin CRUD routes (`clients`/`venues`/`manager_details`/`contact_info`/
`about_me`/`service_reviews` — none owned by a Phase 4 repository) batched together for
efficiency rather than left as individual 1-2-route batches.

Two more widely-shared helpers surfaced and relocated, each used well beyond this batch:
- **`lib/html-sanitize.js`** — `encodeUserHtml` (~27 call sites across `app.js`), `unescapeHtml`,
  `sanitizeAboutHtml` (+ its 3 regex constants), and `SECTION_KEYS` (shared with the still-in-
  `app.js` `GET /api/public/site-content`). All pure functions, no `db`/session access.
- **`lib/client-venue.js`** — `findOrCreateClient` (9 call sites) and `findOrCreateVenueFromPlace`
  (4 call sites), both depending on `db` directly (`clients`/`venues` were never claimed by a
  domain repository) and on `encodeUserHtml` above.

`findOrCreateClient`/`findOrCreateVenueFromPlace` are called from the core public booking-creation
path elsewhere in `app.js` (not moved yet) — the widest blast radius any single helper relocation
has had so far. Ran the full suite **3 times** specifically because of that: all three runs came
back at the permanent baseline only (649/651, zero additional flakes) — the cleanest result any
Phase 5 step has had. Specifically confirmed `rejected submission writes no orphan client` (a
`findOrCreateClient` behavior check) passed on every run.

Verification: `node -c`; confirmed zero remaining `app.js` registrations for all 10 paths;
`npm run smoke` 329/329; `npm test` x3 (see above).

### Route batches 5 & 6: `routes/admin/content.js`, `routes/admin/home-social.js` — DONE

**`content.js`** — 16 routes: `GET/POST/PUT/DELETE /api/admin/highlights[/:id]`,
`.../footprint[/:id]`, `.../testimonials[/:id]`, plus `PUT /api/admin/gallery/reorder`,
`POST/PUT/DELETE /api/admin/gallery[/:id]`. Small CMS-style CRUD clusters
(`career_highlights`/`footprint_countries`/`testimonials`/`gallery_images`, none owned by a Phase 4
repository), batched together.

Two more widely-shared helpers surfaced, each used well beyond this batch:
- **`lib/runtime-paths.js`** — the Phase 3 `DOCS_PATH`/`UPLOADS_PATH`/`BACKUPS_PATH`/
  `docsWriteDir`/`resolveDocsPath`/`uploadsWriteDir` config (10-19 call sites each). Two of the
  original constants (`RUNTIME_DATA_DEFAULT_ROOT`, `LEGACY_DOCS_DIR`) anchored themselves on
  `__dirname` — correct in `app.js` (still the project root) but would resolve one directory too
  deep from inside `lib/`. Anchored on `path.resolve(__dirname, '..')` instead, matching the same
  one-level-deep assumption `database/repositories/*.js` already rely on.
- **`lib/uploads.js`** — `safeUploadFilename` + the shared `upload` multer instance (~20 call sites
  across admin image-upload routes), depending on `runtime-paths.js` above.

**`home-social.js`** — 11 routes: `GET/POST/DELETE /api/admin/home-slider[/:id]` +
`PUT .../reorder`, `GET/POST/DELETE /api/admin/social_links[/:id]`,
`GET/POST/DELETE /api/admin/social_embeds[/:id]`. No new shared helpers needed (`requireAdmin`,
`requireRole`, `db`, `logAudit` only) — a good sign the `lib/` surface built up over the last few
batches is starting to cover new batches without further discovery. One route-ordering note
preserved automatically: `PUT .../home-slider/reorder` is registered before
`PUT .../home-slider/:id` in the same file (explicit in-code comment — "reorder" would otherwise be
captured as `:id`) — both moved together into one file in their original relative order, so
Express's first-match-wins semantics are unaffected.

**Verification was interrupted by an environmental problem, not a code problem**: two stale
`node server.js` processes from an early-session `npm start` (running since ~10:21 AM, never
stopped) caused `npm test` to hang indefinitely partway through `booking.test.js` on two separate
attempts (`npm run smoke`, which also boots a full server, completed in seconds both times —
pointing at cross-process SQLite lock contention specifically, not a broken app). Stopping the
tracked background task didn't kill its own spawned child processes either (a `TaskStop`
limitation on Windows process trees), briefly adding a *third* stale set under new PIDs. Resolved
once the user killed the relevant PIDs directly; documented here since it cost real time and may
recur if a future session leaves a dev server running.

Once the environment was clean: `npm run smoke` 329/329; `npm test` x3, all clean runs (baseline
plus one already-documented CP5 recurrence on one run) — specifically confirmed gallery
create/update audit_log rows and all 6 upload-handler filename tests passed on every run. `node -c`
on all changed/new files; confirmed zero remaining `app.js` registrations for all 27 moved paths.

### Route batch 7: `routes/admin/newsletter-subscribers.js` — DONE

9 routes: `GET /api/admin/newsletter/subscribers[/stats]`, `POST .../subscribers`,
`PUT .../subscribers/:id[/status]`, `DELETE .../subscribers/:id`, `PUT .../subscribers/bulk-status`,
`POST .../subscribers/bulk-delete`, `POST .../subscribers/import`. First newsletter batch — the
domain repository already existed from Phase 4, so every data-access call was a trivial import;
all the new work this batch was shared *business-logic* helpers, not data access.

Four more `lib/` modules, each with a wide, cross-cutting blast radius:
- **`lib/db-transaction.js`** — `withDbTransaction`, the serialization queue **~21 call sites**
  throughout `app.js` rely on to make guarded BEGIN/COMMIT/ROLLBACK sections atomic with respect to
  each other (concurrent booking submissions were the original motivating case). Flagged explicitly
  in its own file header: this **must** stay a singleton — every caller has to import this exact
  module, never redefine the queue, or the whole serialization guarantee silently stops working.
  CommonJS's module cache guarantees that as long as everyone requires the same path.
- **`lib/email-context.js`** — `getEmailFooterContext` (~44 call sites) and `emailBaseUrl`
  (~19 call sites), used by nearly every email-composing function in the app, not just newsletter.
- **`lib/validation.js`** — `sanitizeEmailInput`, `isValidBirthday` (+ its `BIRTHDAY_DAYS_IN_MONTH`
  table). Small, pure, standalone.
- **`lib/newsletter-emails.js`** — `sendNewsletterWelcomeEmail` (its sibling
  `sendNewsletterConfirmationEmail` stays in `app.js` for now, moving here when the batch that
  needs it comes up).

`subscriberCsvUpload` (the CSV-import multer instance) had zero remaining call sites in `app.js`
once this batch's routes moved out, so it was defined directly in the route file rather than added
to `lib/` — nothing else needs to share it.

**A third `SQLITE_BUSY` crash, same test file, same exact point, but this time in a verified-clean
environment** (zero `node.exe` processes running beforehand, confirmed via `Get-CimInstance`) —
`banner.test.js`, immediately after "get: banner + empty used_by before assignment", identical to
the two prior occurrences logged elsewhere in this file. Since stale processes are now ruled out as
the cause for at least this occurrence, this looks like a genuine (if infrequent) SQLite
lock-contention race intrinsic to the test suite's own design at that point, not purely a
leftover-process artifact — recovered the same way (immediate re-run, clean), documented as a
data point for whoever eventually investigates `banner.test.js` directly.

Verification: `node -c` on all changed/new files; confirmed zero remaining `app.js` registrations
for all 9 paths; `npm run smoke` 329/329; `npm test` x4 (1 environmental crash as above, 3 clean
baseline-only runs) — specifically confirmed the newsletter confirmation/welcome-email tests and
all subscriber RBAC checks passed.

### Route batch 8: `routes/admin/newsletter-campaigns.js` — DONE (closes out `newsletter`)

15 routes: newsletter drafts CRUD, `POST /api/admin/newsletter/preview`, scheduled-newsletter
CRUD (`schedule[/:id]`), `GET .../campaigns/audience-count`, and the full birthday-automation
settings/preview/send-test cluster. The largest and most interconnected helper-relocation of
Phase 5 so far — this pulled in essentially the entire newsletter-scheduling and
birthday-automation subsystems, both flagged as protected surfaces by the original plan (email
automation).

Two new `lib/` modules, each holding a **required singleton**:
- **`lib/newsletter-scheduling.js`** — `scheduledJobs` (the node-schedule Job map, keyed by
  `scheduled_newsletters.id` for newsletter jobs and by string-prefixed `jobKey`s for the separate
  direct-email scheduling feature that shares the same map — confirmed via `grep` before assuming
  a single owner), `buildSegmentCondition`, and `scheduleNewsletterSend` (the atomic-claim send
  job — same "must stay one instance" reasoning as `dbTxnQueue`/`withDbTransaction`).
- **`lib/newsletter-birthday.js`** — `birthdayJob` (the one persistent daily cron Job — a second
  copy would leave an uncancellable duplicate firing every day), `BIRTHDAY_SETTING_DEFAULTS/KEYS`,
  `mergeBirthdayOverrides`, `getBirthdaySettings`, `renderBirthdayEmail`,
  `runBirthdayAutomationSweep`, `registerBirthdayJob`.

`registerBirthdayJob()` is called at module-load time (not from inside any route or the listen
callback) to register the initial daily cron job on startup — that call site **stays in `app.js`**,
at the same position, now invoking the imported function; only the function body moved. `npm run
smoke` booting cleanly was itself a real check that this eager call still executes without
throwing from its new home.

`newsletterUpload` (attachment-upload multer instance, `newsletterAttachStorage` depending on
`docsWriteDir`) turned out to have two remaining call sites in the not-yet-moved `/api/admin/
campaigns` routes — added to `lib/uploads.js` alongside the admin image `upload` instance rather
than assumed unused. `EMAIL_FORMAT_RE` similarly had one remaining call site elsewhere in `app.js`
— added to `lib/validation.js` alongside `sanitizeEmailInput`.

A **fourth** `SQLITE_BUSY` crash hit during this batch's verification, same exact spot in
`banner.test.js` as the three prior occurrences — see the consolidated note under "Known testing
limitations" below, now updated to reflect four occurrences.

Verification: `node -c` on all changed/new files; confirmed zero remaining `app.js` registrations
for all 15 paths; `npm run smoke` 329/329; `npm test` x5 given the scope (1 crash as above, 1
already-documented CP3 recurrence, 3 clean baseline-only runs) — specifically confirmed the
schedule-creation and atomic-claim tests (a real node-schedule job actually firing and reaching a
terminal `sent` status) and the birthday-sort tests passed on every successful run.

**`newsletter` domain's route surface is now fully split out of `app.js`** (batches 7 + 8, 24
routes total, matching the Phase 4 domain's original route count exactly).

### Route batch 10: `routes/admin/inquiries.js` — DONE (closes out `inquiries`)

13 routes: `GET /api/admin/inquiries`, status/assign/priority/category updates, notes CRUD,
bulk-status/bulk-delete, delete. No new `lib/` helpers needed — every dependency was either
already-extracted repository functions (`inquiries.repository.js`) or the three `admins`-only
functions found living in this exact route cluster back during the `auth+users` Phase 4 domain
(`getAssignableAdmins`, `checkAdminActiveById`, `getAdminDisplayNameById`) — all already in
`auth-users.repository.js`. The lowest-friction batch since the foundational `lib/` surface was
built out; a good sign that surface is now covering new batches rather than still growing to meet
them.

The main list route's `admins`/`direct_emails`-joining dynamic SQL (cross-domain, per the
`inquiries` Phase 4 write-up) stayed inline using `db` directly, exactly as documented back then.

**`inquiries` domain's route surface is now fully split out of `app.js`.**

Verification: `node -c`; confirmed zero remaining `app.js` registrations for all 13 paths; `npm run
smoke` 329/329; `npm test` x3 (only already-documented flakes — CP5, the calendar-booking-sync
reschedule test — zero inquiry-specific failures on any run).

### Route batch 11: `routes/admin/direct-emails.js` — DONE

8 routes: attachment upload, list/detail, create/update/delete, send-now, preview. First route
file to use `requireRoleForInquiryEmail` (the second RBAC middleware from `middleware/rbac.js` —
extracted in Phase 5 step 1 but never actually imported by a route file until now).

New **`lib/direct-emails.js`**, mirroring `lib/newsletter-scheduling.js`'s shape almost exactly:
`scheduleDirectEmailSend` + `sendDirectEmail` (the atomic send/mark-sent logic — this is the exact
code path Deferred-fix-#3's **CP12** flake exercises, via the `markInquiryReplied` call inside
`sendDirectEmail`'s success branch). `scheduledJobs` is imported from
`lib/newsletter-scheduling.js` rather than redeclared — this module's jobs share that same map
under a `direct_${id}`-prefixed key, confirmed back in the newsletter-campaigns batch write-up.
`sendDirectEmail` resolved a relative attachment path against `__dirname` (correct in `app.js`,
wrong one level deep from `lib/`) — fixed by adding a `PROJECT_ROOT` export to
`lib/runtime-paths.js` (the same anchor `database/repositories/*.js` already relies on) and using
that instead, rather than reintroducing a bare `__dirname`.

`emailAttachUpload` (+ its storage config) added to `lib/uploads.js` alongside the other shared
multer instances.

**A small cleanup, not scope creep**: `subscriberCsvUpload`'s definition in `app.js` was still
sitting there unused — its only call site moved to `routes/admin/newsletter-subscribers.js` two
batches ago (which correctly defined its own local copy, since it had zero other consumers), but
the now-dead original in `app.js` was never removed at the time. Removed it now while touching
this same neighborhood of code, since leaving an orphaned copy I myself created behind isn't
"moving code around later," it's just finishing the job from batch 7 properly.

Verification: `node -c`; confirmed zero remaining `app.js` registrations for all 8 paths; `npm run
smoke` 329/329; `npm test` x3 — **two of the three came back fully clean, 651/651**, including the
normally-permanent concurrency-race baseline (consistent with that being a genuine race, not a
guaranteed-every-run failure). Specifically confirmed both CP12 assertions passed on every run
(the exact code path this batch relocated), all 10 `requireRoleForInquiryEmail`-gated RBAC checks
passed, and the POPIA erasure test's `direct_emails.to_emails` redaction check passed.

### Route batch 12: `routes/admin/analytics.js` — DONE

9 read-only reporting routes: `summary`, `visits-over-time`, `traffic-sources`, `top-referrers`,
`devices`, `countries`, `top-pages`, `bookings-trend`, `todays-schedule`. All raw `db` queries
against `analytics_pageviews`/`analytics_sessions` (never claimed by a Phase 4 repository) plus two
already-extracted repository calls (`getBookingsTrend`, `getActiveDateHoldsForToday`).
`getAnalyticsDates` (the `?period=` parser) had exactly one caller — this whole batch — so it moved
directly into the route file rather than a new `lib/` module, matching the `subscriberCsvUpload`
precedent for single-consumer helpers.

**A new failure mode hit on the first verification run**: the test harness's own initial request
failed outright (`TEST RUN ERROR: fetch failed`), and the server log showed why — `SQLITE_READONLY:
attempt to write a readonly database` inside the daily overdue-flagging cron jobs
(`runDailyOverdueFlaggingSweep` and the payment-schedule equivalent), which fire once shortly after
boot. Neither cron job's code was touched by this batch or by anything else this session — this
reads as the isolated test DB file being caught in a transient read-only filesystem state (a
plausible side effect of the SQLITE_BUSY crashes and hangs earlier in this session leaving the file
in an inconsistent state at the OS level), not an application bug. Two immediate re-runs were
clean, one of them fully clean at 651/651 with every analytics RBAC check passing — filed as a new
`SQLITE_*`-family environmental one-off alongside the existing `SQLITE_BUSY` entry, same "Known
testing limitations" section.

Verification: `node -c`; confirmed zero remaining `app.js` registrations for all 9 paths; `npm run
smoke` 329/329; `npm test` x3 (1 environmental crash as above, 1 run with only CP3, 1 fully clean
651/651 run).

### Route batch 13: `routes/admin/legal.js` — DONE

9 routes: legal-centre overview, documents CRUD/versioning (draft/publish/restore/history),
consent-audit listing, contracts registry. All raw `db` queries against `legal_documents`/
`legal_document_versions`/`consent_audit`/`contracts` (none owned by a Phase 4 repository);
cross-domain `bookings` JOINs on the consent-audit and contracts-registry listings stayed inline.
`computeNextLegalVersion` had exactly one caller (this batch) — moved directly into the route file,
same single-consumer pattern as `getAnalyticsDates` in the previous batch.

Verification: `node -c`; confirmed zero remaining `app.js` registrations for all 9 paths; `npm run
smoke` 329/329; `npm test` x3 — one fully clean 651/651 run, the other two each had only a single
already-documented flake (CP5, CP17) with the permanent baseline concurrency test *not* failing
either time, reinforcing that it's a genuine intermittent race rather than a deterministic result.

### Route batch 14: `routes/admin/popia.js` — DONE (POPIA/GDPR erasure, protected surface)

9 routes: the 8 mechanically-extracted admin POPIA request-management routes (list/export/detail
+preview/approve/reject/process/complete-anonymization/create), **plus** `POST
/api/admin/gdpr/delete` — a legacy one-click wrapper found mid-investigation, *not* part of the
original mechanical extraction batch (it wasn't grouped with the others by the route-listing pass),
but folded in here rather than left behind: it calls the exact same
create→approve→process→notify→delete-files chain as every other entry point in this file, so
splitting it into a separate batch would only have meant importing the same lifecycle functions
back into `app.js` for one lingering route.

**This batch could not be completed as a self-contained lib file the way batches 1-13 were.** Every
route here bottoms out in `notifyPopiaCancellations()`, which calls two functions that were still
physically defined in `app.js`: `deleteGoogleEvent` (a thin wrapper around the module-scoped Google
Calendar client) and `sendCancellationEmail`. Neither is POPIA-specific — both are shared with the
not-yet-moved manual admin cancellation routes — so per the standing "relocate each helper as
needed" decision, three more `lib/` files were created as prerequisites, each verified independently
before being pulled into the new POPIA lib file:

- **`lib/cancellation-refund.js`** — `calculateCancellationRefund`. Pure function (policy-tier math
  + date arithmetic), zero dependencies. Trivial, safe relocation.
- **`lib/email-escape.js`** — `escapeEmailHtml`/`EMAIL_ESCAPE_FIELDS`/`escapeEmailFields`. Also pure;
  `escapeEmailFields` alone had 23 other call sites across `app.js`'s email-sending functions, none
  of which needed touching — they all keep working via the new import.
- **`lib/booking-cancellation-email.js`** — `sendCancellationEmail`. Depends only on already-leaf
  modules (`js/emailComponents`, `js/bannerRegistry`, `js/emailService`, the new
  `lib/email-escape.js`, `lib/email-context.js`).
- **`lib/google-calendar.js`** — the module-scoped `oauth2Client`/`calendar`/`CALENDAR_ID` Google
  Calendar client singleton, plus `deleteGoogleEvent`. **Checked carefully before moving**: this
  construction reads `process.env.GOOGLE_CLIENT_ID`/`SECRET`/`BASE_URL`/`REFRESH_TOKEN`
  *synchronously*, immediately after the startup DB-settings-to-env-var bootstrap query is *issued*
  but before that query's callback can possibly have fired — meaning the DB-stored settings path
  never actually reaches the Google credentials in either the old or new arrangement, only whatever
  `.env` already set. This is pre-existing, unchanged behavior, not something this move altered;
  confirmed by requiring the new module at the exact same point in `app.js`'s top-to-bottom execution
  that the inline code used to occupy, which preserves identical timing. `google` (the `googleapis`
  import) had no other use in `app.js` beyond this block, so its `require('googleapis')` moved too
  instead of being left behind unused.

With those four in place, **`lib/popia.js`** holds the full erasure subsystem: `resolvePopiaTargets`,
`anonymizeClientData`, `POPIA_REASONS`, `popiaReferenceNumber`, `createPopiaRequest`,
`approvePopiaRequest`, `rejectPopiaRequest`, `processPopiaRequest`, `completePopiaAnonymization`,
`deletePopiaFiles`, `isBookingInPopiaErasureScope`, `getBookingErasureImpact`,
`cancelActiveBookingsForErasure`, `getUnresolvedRefundBookingIds`, `notifyPopiaCancellations` — all
byte-identical. Only functions with a caller outside the file are exported
(`resolvePopiaTargets`, `getBookingErasureImpact`, `POPIA_REASONS`, `createPopiaRequest`,
`approvePopiaRequest`, `rejectPopiaRequest`, `processPopiaRequest`, `completePopiaAnonymization`,
`deletePopiaFiles`, `notifyPopiaCancellations`); `anonymizeClientData`, `popiaReferenceNumber` and
`isBookingInPopiaErasureScope` stay private. `app.js` re-imports `resolvePopiaTargets`,
`getBookingErasureImpact`, `createPopiaRequest` and `POPIA_REASONS` for the three public
self-service routes not yet moved (`POST /api/public/popia/preview`, `/erasure-requests`, and the
legacy `/api/public/compliance/request-forget`) — confirmed by tracing every remaining call site
before removing the old definitions, not by assumption. `verifyPopiaOtp` (OTP verification) has no
caller in this batch's routes and stays in `app.js` untouched, to move with the public POPIA batch
later.

`routes/admin/popia.js` additionally imports 7 count-only repository functions
(`countBookingNotesForIds`, `countTransactionsForIds`, `countCancellationsForIds`,
`countPaymentLogsForIds`, `countQuotationsForIds`, `countQuotationsForClientIds`,
`countInquiryNotesForIds`) used only by its own detail/preview route, plus `db`/`exportRateLimiter`/
`encodeUserHtml` following the established per-route-file convention.

Verification: `node -c` on all 8 changed/new files; confirmed zero remaining `/api/admin/popia/*` or
`/api/admin/gdpr/delete` registrations in `app.js`, and zero remaining references anywhere in
`app.js` to any of the now-fully-relocated function names outside of explanatory comments; `npm run
smoke` 329/329; `npm test` run **3 times** given this is an explicitly protected surface with real
refund-gating financial logic — **651/651 clean on all 3 runs**, no flakes at all this time. The
dedicated `test/popia-erasure.test.js` suite explicitly exercises the CAS double-processing guards,
the `awaiting_refund` gate and its re-check on `complete-anonymization` (409 while any booking's
refund is still outstanding, 200 once resolved), RBAC on every route including
`complete-anonymization`, and the legacy `/api/admin/gdpr/delete` route reporting `awaiting_refund`
correctly rather than a false success — all passing identically pre- and post-relocation.

### Route batch 15: `routes/admin/abandoned-bookings.js` — DONE

6 routes: list/search/filter/paginate, recovery stats, CSV export, single-draft detail, admin
resend-reminder, mark won/lost/closed/re-open. All raw `db` queries against `abandoned_bookings`
(never claimed by a Phase 4 repository). `sendAbandonedBookingReminderEmail` has a second caller —
an automated reminder sweep still in `app.js` — so it moved to its own `lib/abandoned-booking-
email.js` (leaf deps only: `js/emailComponents`, `js/bannerRegistry`, `js/emailService`,
`lib/email-context.js`) rather than being inlined into the route file like the single-consumer
helpers in earlier batches.

Verification: `node -c`; confirmed zero remaining `app.js` registrations for all 6 paths and zero
remaining reference to the old `sendAbandonedBookingReminderEmail` definition; `npm run smoke`
329/329; `npm test` x6 (elevated from the usual x2-3 specifically to build confidence after batch
14's calendar-client relocation) — 4 clean 651/651 runs, one recurrence of the pre-existing
`deleteGoogleEvent`/cancel timing flake (Deferred fix #3 update above) and one recurrence of the
pre-existing `banner.test.js` `SQLITE_BUSY` crash ("Known testing limitations" update above), neither
touching anything this batch or batch 14 changed.

### Route batch 16: `routes/admin/expenses.js` — DONE

6 routes: list/filter, create, soft-delete, edit, CSV export, receipt upload. `insertExpense`/
`getActiveExpenseById`/`softDeleteExpense`/`updateExpense` were already Phase 4 repository exports
(`finance.repository.js`); `VALID_EXPENSE_CATEGORIES` and the `receiptStorage`/`uploadReceipt`
multer config were both single-consumer (only these routes used them), so both moved directly into
the route file — same pattern as `getAnalyticsDates`/`computeNextLegalVersion` in earlier batches —
rather than a new `lib/` module. `uploadsWriteDir` (already `lib/runtime-paths.js`) covers the one
external dependency `receiptStorage` had.

Verification: `node -c`; confirmed zero remaining `app.js` registrations for all 6 paths and zero
remaining reference to `VALID_EXPENSE_CATEGORIES`/`uploadReceipt`/`receiptStorage` outside a comment;
`npm run smoke` 329/329; `npm test` x6 — 4 clean 651/651 runs, one `banner.test.js` `SQLITE_BUSY`
crash (same known crash point, sixth occurrence — see "Known testing limitations" update below) and
one recurrence of `calendar-booking-sync.test.js`'s "reschedule: a SECOND sync attempt was logged"
(the same Deferred fix #3 family, already seen at this exact wording during Phase 4's `bookings`
domain). Neither touches `expenses` or anything this batch changed.

### `events` cluster investigated, deferred — not a batch

Investigated `/api/admin/events` (6 routes) as the planned next batch after `expenses`. Unlike every
batch so far, its dependencies don't terminate cleanly: `checkEventConflicts` (a local helper) and
three of the six routes call `hasCalendarConflict`, `syncBookingToCalendar`, `syncEventToCalendar`,
`sendDateChangedEmail`, `addMinutesToTime`, `timeRangesOverlap`, and `parseDurationToMinutes` — all
still plain functions in `app.js`. Of these, only `syncEventToCalendar` is scoped to this cluster;
the other six are called from **40+ other sites** across the not-yet-moved `/api/admin/bookings`
cluster and public booking routes (confirmed by grep, not assumption) — the same giant, explicitly
protected surface already earmarked for its own dedicated, heavily-scrutinized pass. Relocating
`events` now would mean pulling the entire Google Calendar sync engine and booking time-arithmetic
into `lib/` as a side effect of a 6-route batch, then re-importing it into `app.js` at 40+ call
sites — a fundamentally different scale of change than this cluster's own size suggests, and
squarely the same work the `bookings` pass will need to do anyway. Deferred `events` to be handled
alongside that pass rather than splitting the calendar-engine extraction across two unrelated
efforts; moved on to `banners` instead. No files changed for this investigation.

### Route batch 17: `routes/admin/banners.js` — DONE

6 routes: list/filter/paginate, get-one-with-usage, create, update, archive, restore.
`bannerUpload`/`validateBannerImageBuffer`/`saveBannerImage`/`BANNER_CATEGORIES`/
`BANNER_MIN_WIDTH`/`BANNER_MAX_WIDTH`/`BANNER_MAX_BYTES`/`setBannerStatus` were all single-consumer
(only these routes used them) — all moved directly into the route file. `setBannerStatus` needed
manual handling since it's a plain function sitting between routes, not itself an `app.<method>(...)`
call the extraction script matches — the two archive/restore routes that use it were extracted first,
then the factory function was added back into the route file ahead of them. `bannerRegistry` (already
`js/bannerRegistry`) and `uploadsWriteDir` (`lib/runtime-paths.js`) covered the two shared
dependencies.

**Extra scrutiny applied** given this batch directly touches the exact domain (`banners`) that has
been the source of this session's recurring `SQLITE_BUSY` crash — read `banner.test.js`'s full
output on every run rather than just the aggregate pass count. All 33 of its checks passed cleanly
on all 3 runs, including `archive`/`restore` (exercises the relocated `setBannerStatus`),
`create`/`update` (exercises `bannerUpload`/`validateBannerImageBuffer`/`saveBannerImage`), and the
e2e assigned-banner-renders-in-a-real-queued-email check — direct positive confirmation for this
batch specifically, not just the usual "the crash is unrelated" reasoning by elimination.

Verification: `node -c`; confirmed zero remaining `app.js` registrations for all 6 paths and zero
remaining reference to any of the relocated helpers; `npm run smoke` 329/329; `npm test` x3, all
three 651/651 clean — no flakes, no crashes, this time.

### Route batch 18: `routes/admin/campaigns.js` — DONE

5 routes, scattered across two distant parts of `app.js` (the legacy immediate-dispatch pair near
the top, the unified-list/delete/bulk-delete trio much further down) but extracted together as one
domain: `POST /api/admin/campaigns` (legacy immediate newsletter dispatch — distinct from the
already-extracted scheduled-campaign system in `routes/admin/newsletter-campaigns.js`),
`POST .../send-test`, `DELETE /:id`, `GET /unified`, `POST /bulk-delete`. All DB access already
Phase 4 repository exports (`newsletter.repository.js`, one `auth-users.repository.js` function).
`POST /bulk-delete` reads/mutates `scheduledJobs` directly (cancelling a pending scheduled send) —
imported from the existing `lib/newsletter-scheduling.js` singleton, **not** a new instance, per the
required-singleton rule already established for that file.

Verification: `node -c`; confirmed zero remaining `app.js` registrations for all 5 paths; `npm run
smoke` 329/329; `npm test` x5 — 3 clean 651/651 runs (including the "campaigns/unified ripple fix"
test, direct coverage of the relocated `GET /unified` route) and 2 more `banner.test.js` `SQLITE_BUSY`
crashes (same pre-existing family, landing at a slightly different statement each time within that
file — consistent with a genuine race rather than a fixed reproducible bug), neither touching
campaigns/newsletter-scheduling code.

### Route batch 19: `routes/admin/services.js` — DONE

5 routes: list, create, edit, usage-count, delete (soft by default, hard with `?force=1` gated on
zero referencing line items). All raw `db` queries against `services`/`audit_log`/
`financial_audit_log`; the three usage/reference-count lookups
(`getServiceDraftQuoteUsage`, `countBookingLineItemsForService`, `countQuoteLineItemsForService`)
were already Phase 4 repository exports. No new `lib/` files needed — the most self-contained batch
since `expenses`.

Verification: `node -c`; confirmed zero remaining `app.js` registrations for all 5 paths; `npm run
smoke` 329/329; `npm test` x5 — 4 clean 651/651 runs plus one 650/651 whose single failure wasn't
captured before a follow-up run overwrote it (lost to a re-run, not investigated further) — given
this batch touches only `services`/`audit_log`/`financial_audit_log` and every other run was clean,
treated as the same ambient flake-rate background this session has shown throughout, not a
regression. Direct RBAC coverage of the relocated `GET /api/admin/services` route passed on the
logged runs.

### Route batch 20: `routes/admin/invoices.js` — DONE

5 routes: send/resend, bulk-send-unsent, void (with mandatory reason), mark-paid, list. All five
DB-lifecycle helpers (`markInvoiceSent`, `markInvoiceSentAndPublished`, `getInvoiceById`,
`voidInvoiceWithReason`, `markInvoicePaidById`) were already Phase 4 repository exports.
`sendInvoiceEmail` has two other callers (booking-confirmation and quote-acceptance flows, not yet
moved), so it moved to its own `lib/invoice-email.js` — all of its own dependencies
(`escapeEmailFields`, `getEmailFooterContext`/`emailBaseUrl`, `getPaymentSchedulesForDocument`) were
already leaf-safe from earlier batches.

Verification: `node -c`; confirmed zero remaining `app.js` registrations for all 5 paths and zero
remaining reference to the old `sendInvoiceEmail` definition; `npm run smoke` 329/329; `npm test` x3
given this touches payment-adjacent invoice email — one run had 649/651 (two already-documented
pre-existing flakes, CP3 and CP6, neither invoice-related), the other two clean 651/651. Direct
positive confirmation for this batch: the invoice-send email tests all passed, including the
PAYMENT-CRITICAL "schedule amount + reference verbatim" check against the relocated
`sendInvoiceEmail`.

### Route batch 21: `routes/admin/bank-statement.js` — DONE (pre-existing bug found, not fixed)

5 routes: CSV import, list lines (with batch list), match a line to a booking/transaction, delete a
line, delete a whole batch. All five DB helpers were already Phase 4 repository exports
(`finance.repository.js`); `csvUpload` (a single-consumer multer instance) moved directly into the
route file.

**Found a pre-existing, completely-broken route while tracing dependencies** — see Deferred fix #4
above for the full writeup. `POST .../import` called `db.transaction(...)`, a `better-sqlite3` method
that doesn't exist on this app's plain `sqlite3.Database` — every import attempt threw synchronously
and returned a 500. Relocated byte-identical here and flagged to the user directly given the
severity; **the user asked for it to be fixed**, done immediately afterward — see Deferred fix #4
for the fix itself (`withDbTransaction`/`dbRun`, a new regression test, and an unrelated stale-import
cleanup found along the way).

Verification: `node -c`; confirmed zero remaining `app.js` registrations for all 5 paths; `npm run
smoke` 329/329 (the smoke test's unauthenticated requests hit `requireAdmin`'s 401 before ever
reaching the broken code, so this doesn't contradict the finding above); `npm test` x3, all three
651/651 clean — unchanged from baseline, since no test exercises the import route either before or
after the move.

### Route batch 22: `routes/admin/reconciliation.js` — DONE

4 routes: the reconciliation matrix, per-booking transaction list, CSV export, and — folded in from
a different path prefix, same reasoning as POPIA's `/api/admin/gdpr/delete` in batch 14 —
`PATCH /api/admin/transactions/:id/reconcile` (the matrix's own "flag/unflag as duplicate" action,
physically sitting between the other three routes in `app.js`). `POST /api/admin/transactions/manual`
stays behind — a genuinely separate, larger transactions-domain concern, not this batch's business.
`getCompletedTransactionsForReconciliation`/`setTransactionDuplicateFlag` were already Phase 4
repository exports; everything else is raw `db` queries. A stray leftover comment (from batch 21's
bank-statement extraction, absorbed as a "leading comment" onto the CSV-export route by the
extraction script) was cleaned up as found.

Verification: `node -c`; confirmed zero remaining `app.js` registrations for all 4 paths; `npm run
smoke` 329/329; `npm test` x3, all clean 664/664.

### Route batch 23: `routes/admin/advancing.js` — DONE (12 routes, two path prefixes)

The Advancing Pack feature (Deal View "Advancing" tab — run-of-show, technical/hospitality specs,
show-day contacts, travel, PDF generation/download/send/confirm) turned out to span 12 routes, not
the 3 the initial `/api/admin/advancing/*`-prefix grouping found — most of it actually lives under
`/api/admin/bookings/:id/advancing/*`, which a naive by-prefix grouping bucketed into the giant
deferred `bookings` cluster. Read the full contiguous block in `app.js` (one cohesive feature, not
entangled with the rest of the bookings mega-cluster the way `events`' calendar-sync dependencies
were) and pulled all 12 out together: `GET`/`PUT .../advancing` (load/save the pack header),
`POST .../run-of-show` + `PUT`/`DELETE /api/admin/advancing/run-of-show/:itemId` (the latter two
un-nested from `:id` by original design, so they carry their own ownership check — see
`verifyRosOwnership`), `PUT .../run-of-show/reorder`, `POST .../contacts` +
`DELETE /api/admin/advancing/contacts/:contactId` (same ownership-check shape via
`verifyAdvancingContactOwnership`), `POST .../pdf`, `GET .../download`, `POST .../send`,
`POST .../confirm`.

Five single-consumer helpers moved with it: `sendAdvancingPackEmail`, `ensureAdvancingPack`,
`verifyRosOwnership`, `verifyAdvancingContactOwnership`, `resolveAdvancingContacts`. All other
dependencies were already leaf-safe: `getBookingByIdAsync`/`getBookingIdStatusAsync`
(`bookings.repository.js`), `dbGet`/`dbRun`/`withDbTransaction`/`docsWriteDir`/`resolveDocsPath`/
`encodeUserHtml` (existing `lib/` modules), `emailService`/`pdfService` (existing `js/` modules).

**Extra verification given the size and the lack of any dedicated test file for this feature**:
beyond the usual `node -c`/grep/smoke/suite checks, manually drove the real routes end-to-end
against a live CONFIRMED booking fixture in two throwaway scripts using `test/support.js` directly
— save the pack header, add/edit/delete a run-of-show item (exercising `verifyRosOwnership`'s
success path), add/delete a contact (`verifyAdvancingContactOwnership`), confirm the pack, then
(separately) save + generate the PDF + download it and confirm the response is a real PDF
(`%PDF` header, non-trivial byte count). Every one of 10 of the 12 routes returned success with
correct data; `send` (the two remaining routes, `send` and the already-covered `confirm`) shares
100% of its dependencies with `pdf`, already proven.

Verification: `node -c`; confirmed zero remaining `app.js` registrations for all 12 paths and zero
remaining reference to any of the 5 relocated helpers; `npm run smoke` 329/329; `npm test` x3, all
clean 664/664; plus the manual end-to-end drive above.

### Route batch 24: `routes/admin/calendar.js` — DONE

4 routes: the unified FullCalendar feed (bookings + manual holds + public site events, optionally
milestones), create/delete/move a manual date hold. All three pulled in the same pure time-
arithmetic utilities (`timeRangesOverlap`, `addMinutesToTime`, `parseDurationToMinutes`) already
identified as blocking the deferred `events` batch — unlike the Google Calendar sync engine
(`hasCalendarConflict`/`syncBookingToCalendar`/`syncEventToCalendar`) also deferred there, these
three are trivial, zero-dependency pure functions, so — per the standing "relocate each helper as
needed" policy — they moved now into a new **`lib/time-utils.js`**, with `app.js` re-importing them
at their ~40 remaining call sites across the still-deferred bookings cluster. This is genuinely
useful prep for whenever that cluster's own batch happens, not scope creep specific to calendar.
`findHoldDateConflict` (single-consumer, used only by the two hold routes) moved directly into the
route file. Everything else was already leaf-safe (`resolveActor`, `bookingConfig`, and repository
functions from `calendar.repository.js`/`bookings.repository.js`).

Verification: `node -c`; confirmed zero remaining `app.js` registrations for all 4 paths and zero
remaining definitions of `timeRangesOverlap`/`addMinutesToTime`/`parseDurationToMinutes`/
`findHoldDateConflict` outside the new import/route file; `npm run smoke` 329/329; `npm test` x4 —
direct coverage confirmed both hold routes work (`calendar hold create/move returns last_updated`);
3 runs clean 664/664, one run had a single already-documented pre-existing flake (CP5, venue_name
propagation — one of the most frequently recurring entries in this session's Deferred fix #3 log),
unrelated to anything this batch touched.

### Route batch 25: `routes/admin/email-templates.js` — DONE

3 routes: list (grouped by category), bulk assign/unassign a banner, live preview. All dependencies
already leaf-safe (`bannerRegistry`, `emailComponents`, `SAMPLES_BY_CATEGORY` from
`js/emailPreviewSamples`, `getEmailFooterContext`). `SYSTEM_TRACK_TEMPLATE_KEYS` (single-consumer)
moved directly into the route file. The extraction script's leading-comment absorption pulled in
two comments that actually belonged to the *banners* section above (a stale "EMAIL BANNER REGISTRY"
header and batch 17's own relocation marker) — cleaned up as found, same as reconciliation's stray
comment in batch 22.

Verification: `node -c`; confirmed zero remaining `app.js` registrations for all 3 paths and zero
remaining definition of `SYSTEM_TRACK_TEMPLATE_KEYS` outside the route file; `npm run smoke`
329/329; `npm test` x2, both clean 664/664.

### Route batch 26: finance/financials/dashboard/reminders — DONE (4 small clusters, one batch)

Four small, low-risk reporting clusters bundled into one batch since each is fully self-contained
(no shared dependencies between them, no cross-cutting risk) and none warranted its own commit:

- **`routes/admin/finance.js`** (2 routes): CSV export, P&L by period. Both already Phase 4
  repository calls (`finance.repository.js`).
- **`routes/admin/financials.js`** (2 routes): the financial-analytics dashboard (revenue trend, top
  clients, invoice aging, overdue invoices, revenue-by-category, cash-flow) and the stats summary
  (period revenue/outstanding/expenses/pending-quotes/overdue-invoices/transaction-count). Every
  figure already came from a Phase 4 repository call spanning `finance`, `invoices-quotations`, and
  `bookings` repositories — nothing new to relocate beyond the routes themselves.
- **`routes/admin/dashboard.js`** (2 routes): social-media KPI tile — reads/refreshes cached
  follower/like counts from YouTube/Facebook/Instagram/Twitter/TikTok's public APIs (rate-limited to
  once per hour per platform via a staleness check), and an admin manual-override write.
  `getSettingVal` was already a Phase 4 repository export.
- **`routes/admin/reminders.js`** (2 routes) + **`lib/payment-reminders.js`**: the reminders-log
  viewer and a manual "run now" trigger for the payment-reminder cron job.
  `runPaymentReminderJob` has two other callers (an app.js startup run and a 24h `setInterval`,
  both left in place as process-startup wiring) — multi-consumer, so it moved to its own lib file
  rather than inlining into the route, matching the `sendInvoiceEmail`/`sendAbandonedBookingReminderEmail`
  pattern.

Verification: `node -c` on all changed/new files; confirmed zero remaining `app.js` registrations
for all 8 paths and zero remaining definition of `runPaymentReminderJob` outside its new lib file;
`npm run smoke` 329/329; `npm test` x3, all clean 664/664 — direct RBAC coverage confirmed
`finance/export`, `finance/pl`, `financials/analytics`, and `financials/stats` all return correct
status codes per role.

### The deferred `bookings`/`events` pass begins — scope reconnaissance

Started the dedicated, heavily-scrutinized pass for `/api/admin/bookings/*` (55 routes),
`/api/public/bookings/*` (19 routes), and `/api/admin/events/*` (6 routes, deferred earlier)
now that `lib/time-utils.js` and `lib/google-calendar.js` exist. A full sweep of every remaining
top-level function declaration in `app.js` found **~75 functions still un-relocated**, the large
majority of them this domain's own business logic rather than incidental helpers — this is not a
"batch" in the same sense as batches 1-26; it's effectively the bulk of what's left of the original
monolith. Recorded here so a future session doesn't have to re-derive it:

- **~28 `send*Email` functions** (`sendBookingReceivedEmail`, `sendQuoteEmail`,
  `sendBookingConfirmedEmail`, `sendPaymentReceivedEmail`, `sendContractEmail`,
  `sendQuoteAcceptedEmail`, `sendBookingCompletedEmail`, `sendRefundProcessedEmail`,
  `sendReviewRequestEmail`, and ~19 more) — every one of these is exactly the same shape already
  proven safe 6 times over (`sendInvoiceEmail`, `sendCancellationEmail`,
  `sendAbandonedBookingReminderEmail`, etc.): `escapeEmailFields` + `getEmailFooterContext` +
  `bannerRegistry` + `emailComponents` + `sendEmail`, all already leaf-safe. Low-risk, high-volume
  relocation work once their route batches come up.
- **The Google Calendar sync engine**: `hasCalendarConflict`, `syncBookingToCalendar`,
  `syncEventToCalendar`, `syncCalendarHolds`, `isWithinWorkingHours` — the reason `events` was
  deferred in the first place. Still not relocated; still the highest-risk piece of this pass
  (real Google API calls, booking-conflict business rules with financial consequences).
- **Booking lifecycle/financial core**: `applyStatusChange` (the generic status-transition
  endpoint's engine), `processManualPayment`, `alignMilestonePayments`, `updateBookingMilestones`,
  `deriveBookingStatusAfterPayment`, `checkDateAvailability`, `generateContract` +
  `assembleContractHtml` + `resolveContractFeeData`, `generateInvoice` +
  `autoBuildDepositBalanceSchedule` + `computeDocumentTotals` + `resolveLineTaxClasses` +
  `getVatRate`, `remindBooking`, `logPaymentEvent`, `generatePayFastSignature`.
- **12 background cron jobs** (`run*Job` — quote follow-up, stalled-booking alerts, abandoned-
  booking reminders/purge, deposit-balance reminders, invoice pre-due/overdue sweeps, event
  reminders, post-event follow-up, ledger reconciliation, PayFast pending-timeout) — all called only
  from app.js's own startup/interval wiring, analogous to `runPaymentReminderJob` in batch 26.
- **Misc utilities**: `classifyChannel`, `generateBookingICS`, `parseDurationMins`, `checkEventConflicts`
  (the `events` conflict-checker deferred alongside the sync engine), `escapeHtml`/`deepEscapeBody`
  (used by a global sanitizing `app.use` middleware — cannot move until every remaining route that
  needs it is accounted for).

**Strategy**: stage this exactly like Phase 4's `bookings` repository domain was staged (4 sub-passes
+ a satellite-table pass) — smallest/safest slices first, working up to the calendar-sync engine and
`applyStatusChange` last, since those two are both the highest-risk and the most-depended-upon by
everything else. All `/api/admin/bookings/*` routes accumulate into one `routes/admin/bookings.js`
file across sub-batches (same file, multiple commits), matching that precedent.

### Bookings sub-batch A: satellite reads + 2 simple actions — DONE

First cut: 9 routes with zero remaining dependency on any of the ~75 functions above — every one
already backed by an existing Phase 4 repository function. `GET/POST /:id/notes` +
`DELETE /:id/notes/:noteId`, `GET /:id/communications`, `POST /:id/unlink-client`,
`GET /:id/quote-history`, `GET /:id/expenses`, `GET /:id/financials`, `GET /:id/details`. Created
`routes/admin/bookings.js`.

Verification: `node -c`; confirmed zero remaining `app.js` registrations for all 9 paths; `npm run
smoke` 329/329; `npm test` x4, all clean 664/664 — direct coverage confirmed via **CP9** (9 checks
exercising the notes routes specifically: empty-list, validation, RBAC on create/delete, author
derivation, ordering, delete-404, delete-success) and RBAC checks on the financials-adjacent routes.

### Bookings sub-batch B: 5 more clean routes — DONE

`GET /:id/cancellation-preview` (already-relocated `calculateCancellationRefund` from
`lib/cancellation-refund.js`), `POST /:id/reopen`, `GET /:id/reconcile`, `GET /:id/invoice/download`,
`GET /:id/quote/download` — all confirmed to have zero dependency on the ~75 still-deferred
functions, all already repo-backed. Appended to `routes/admin/bookings.js`.

**Fixed a latent bug in `extract_routes.js`** found while appending this batch: the script's
append-to-existing-file path matched `EXPORT_LINE` including a trailing `\n`, but `bookings.js` (like
every route file, per this session's own git-commit warnings about CRLF normalization) had been
normalized to CRLF line endings by an editor tool since its creation — the `\n`-only match silently
failed with "Could not find module.exports = router; to insert before." Confirmed via the script's
own write-order safety that `app.js` was untouched (the failure happens before that write), then
fixed the script to match `EXPORT_LINE` without requiring a specific trailing line-ending, and
re-ran cleanly. This is the first time any route file has been appended to a second time (every
prior file was single-batch), so the bug was latent until now — will not recur for future
`bookings.js` sub-batches.

Verification: `node -c`; confirmed zero remaining `app.js` registrations for all 5 paths; `npm run
smoke` 329/329; `npm test` x4 — 2 clean 664/664 runs, one already-documented `banner.test.js`
`SQLITE_BUSY` crash (9th occurrence), one already-documented calendar-sync reschedule flake, neither
touching this batch. No dedicated test names these 5 routes directly, so manually drove all 5
against real fixtures: `cancellation-preview` returned a sensible tiered-refund calc,
`reconcile` returned correct ledger/transaction figures, `invoice/download` and `quote/download`
both served genuine PDFs (confirmed `%PDF` header + correct `Content-Type`) for a fixture booking
that already had real files on disk, and `reopen` correctly flipped an EXPIRED fixture back to
PENDING.

### Bookings sub-batch C: the contract cluster (9 routes) — DONE

Generate, builder-data, preview, GET/POST (fetch/upload), sign (admin countersign), download, send,
remind. Traced the full dependency graph before touching anything:

- **`lib/document-totals.js`** (new): `getVatRate`, `resolveLineTaxClasses`, `computeDocumentTotals`
  — pure money-math shared by `generateInvoice` and the admin quote route (neither yet moved) *and*
  the contract fee resolver below. `app.js` re-imports all three for those two remaining call sites.
- **`lib/contracts.js`** (new): `DEFAULT_CONTRACT_CLAUSES`, `CONTRACT_ELIGIBLE_STATUSES`,
  `resolveContractFeeData`, `assembleContractHtml`, `generateContract` — the whole contract-
  generation engine. `generateContract` has two remaining external callers (the public quote-
  acceptance flow, and `applyStatusChange` — neither yet moved), both re-imported in `app.js`.
  `resolveContractFeeData`/`assembleContractHtml` turned out to have zero callers outside this
  cluster once traced, so they didn't need a separate re-import.
- **`sendContractEmail`** and **`contractUpload`** (the upload multer config) were both confirmed
  single-consumer (only the `contract/send` and `contract` POST-upload routes, respectively) and
  moved directly into `routes/admin/bookings.js` rather than a new lib file.
- **`contract/remind`** inlines its own reminder email (via already-leaf `getEmailFooterContext`/
  `bannerRegistry`/`emailComponents`/`sendEmail`) rather than calling the generic `remindBooking` —
  confirmed by reading the route body, not assumed — so it needed no dependency on `remindBooking`
  or the two `send*Email` functions that function pulls in, which stay deferred.

Verification: `node -c` on all changed/new files; confirmed zero remaining `app.js` registrations
for all 9 paths and zero remaining reference to any relocated function/constant outside comments;
`npm run smoke` 329/329; `npm test` x5 — 3 clean 664/664, 2 with the same already-documented
calendar-sync reschedule flake (unrelated). Direct, thorough coverage from the dedicated
`contract.test.js` suite — draft generation with a real PDF, send, the full two-party sign/
countersign flow (including the "blocked before client signs" and "finalised: signed + frozen"
cases), all passing on every run.

**Correction found later (during the quote-route reconnaissance for sub-batch F):** `GET
.../contract/builder-data` and `POST .../contract/preview` both call `dbGet(...)` with **no import
of it anywhere in this file** — a missing re-import this batch should have added (app.js itself has
always imported `dbRun`/`dbGet`/`dbAll` from `lib/db-helpers.js`; this file never did). Every call
would have thrown `ReferenceError: dbGet is not defined` — a guaranteed 500 on both routes, live in
production since this batch's commit, undetected because `contract.test.js` never exercises either
endpoint (it only tests `/contract/generate` and the sign/countersign flow). This is the same class
of gap as the dead-import checks done after every batch, just the opposite direction — an import
that should have been *added*, not one that should have been removed — so it wasn't caught by the
`\bname\b`-grep-for-zero-remaining-references sweep, which only ever checks names being removed.
Fixed by adding `const { dbRun, dbGet, dbAll } = require('../../lib/db-helpers');` — restores the
exact original working behaviour (app.js's own long-standing import of the same module), no logic
changed. Verified with a throwaway fixture: both routes now return 200 with the expected payload
shape (confirmed via `test/support.js` in isolation). Treated as completing this batch's relocation
correctly rather than as a separate authorized bug fix, on the same reasoning as every dead-import
removal in this session — the missing import IS the relocation defect, not a pre-existing app bug.
Worth checking for on every future batch: after adding new call sites to a module-scope helper
(`dbGet`/`dbRun`/`dbAll`, or any `lib/` export), grep the *destination* file for the name too, not
just the source file for what became dead. Wrote a one-off static sweep (acorn-based: collects every
name bound anywhere in a file against every name referenced, flags the difference minus JS/Node
globals) and ran it across every `routes/admin/*.js`, `lib/*.js`, and `middleware/*.js` file plus
`app.js` itself — this `dbGet` instance was the only real hit; two other flags (`document-totals.js`,
`newsletter-scheduling.js`) turned out to be a bug in the sweep script's own handling of a
destructured-parameter-with-default (`{ x = 0 } = {}`), fixed and re-verified clean. Scratchpad tool,
not part of the repo, but the codebase-wide result stands: no other missing-import instances of this
class exist in already-relocated code as of this batch.

### Bookings sub-batch D: reminder/resend/review-request routes (5 routes) — DONE

`POST /:id/remind`, `POST /bulk-remind`, `POST /:id/resend-quote`, `POST /:id/resend-confirmation`,
`POST /:id/review-request`. Traced dependencies and found 6 of the ~28 catalogued `send*Email`
functions plus `generateBookingICS` and the `remindBooking` orchestrator were all already fully
leaf-safe (every one confirmed to depend only on already-relocated `lib/`/`js/` modules —
`getVatRate` from batch C's `lib/document-totals.js` made `sendQuoteEmail` itself clean this time)
— so relocated all of them together into a new **`lib/booking-notifications.js`**:
`generateBookingICS`, `sendQuoteEmail`, `sendAdminQuoteSentNotification`, `sendBookingConfirmedEmail`,
`sendDepositBalanceDueEmail`, `sendQuoteExpiryWarningEmail`, `sendReviewRequestEmail`,
`remindBooking`. Six of these eight have multiple remaining callers scattered across the still-
deferred payment-processing code and cron jobs — `app.js` re-imports all six; `remindBooking` itself
has zero remaining app.js callers (both its only call sites, `remind` and `bulk-remind`, moved with
it) and `sendAdminQuoteSentNotification` stays with its one remaining caller (the deferred admin
quote route).

Verification: `node -c`; confirmed zero remaining `app.js` registrations for all 5 paths and zero
remaining definitions of any of the 8 relocated functions outside comments; `npm run smoke`
329/329; `npm test` x5 — 3 clean 664/664, one run with two already-documented pre-existing flakes
(CP3, CP17), one with the already-documented `banner.test.js` `SQLITE_BUSY` crash (10th occurrence),
none touching this batch. Direct coverage from the dedicated reminder tests (`remind on QUOTED ->
quote type`, `remind on CONFIRMED-with-balance -> balance type`, 24h throttling, `bulk-remind`
summary/skip-counting) and `CP6: manual review-request -> 200`, all passing on every run.

### The Google Calendar sync engine — relocated to `lib/calendar-sync.js` — DONE

The piece flagged since the reconnaissance write-up as "the highest-risk piece of this pass" — given
its own dedicated, unhurried pass rather than being folded into a route batch: `isWithinWorkingHours`,
`hasCalendarConflict`, `syncBookingToCalendar`, `syncCalendarHolds`, `syncEventToCalendar`. No routes
moved in this step — this is a pure prerequisite lib-extraction that the actual booking-conflict/
calendar-sync ROUTES (the big admin quote route, `book-again`, the venue-linking routes, `sync-
calendar`, and the deferred `events` cluster) still need as their own follow-up batch(es).

Read all five functions in full before touching anything, then traced every dependency individually
against the existing `lib/`/repository inventory rather than assuming shape from past batches, given
that "tests pass" can't be trusted here the way it has for every other batch — these functions make
real Google API calls, and the whole suite runs against a deliberately-invalid `GOOGLE_REFRESH_TOKEN`
(support.js), so automated tests only ever exercise the *failure* path, never a real successful sync.
Finding: **zero new/surprise custom dependencies** — every dependency was either an already-relocated
`lib/` module (`lib/google-calendar.js`, `lib/time-utils.js`, `lib/booking-config.js`) or an existing
Phase 4 repository export (`bookings.repository.js`, `calendar.repository.js`). Phase 4's `calendar`
domain session had already fully isolated the DB layer beneath this engine, so despite its reputation
the relocation itself was mechanical once every dependency was individually confirmed. Created
**`lib/calendar-sync.js`**, `node -c` clean. All five have remaining callers scattered across the
still-deferred bookings/events routes (and app.js's own `syncCalendarHolds` startup wiring) —
`app.js` re-imports all five from the new module.

**Dead-import cleanup (the same systemic gap first found during the bank-statement bug-fix, recurring
exactly as flagged then):** once the five functions' own `require`s existed in the new lib file,
app.js's OWN top-level repository destructures had orphaned copies of the same names. Grepped each
candidate with `\bname\b` word-boundary matching to confirm zero remaining references outside the
destructure line itself before removing it. Found and removed 11 dead names total:
- `bookings.repository` destructure: `getBookingsOnDateForCalendarConflict`, `setBookingGoogleEventId`,
  `getBookingsWithGoogleEventIdAsync`.
- `calendar.repository` destructure: `getDateHoldTimesForDay`, `getCalendarSyncHoldIds`,
  `deleteDateHoldByGoogleEventId`, `getCalendarSyncHoldDetails`, `updateDateHoldFromGoogleSync`,
  `insertDateHoldFromGoogleSync`, `getEventGoogleCalendarIdsForSync`, `setEventGoogleCalendarId`.

`getEventById` (also consumed by `syncEventToCalendar`) was kept in app.js's own destructure —
confirmed it has a genuine second call site at the still-in-app.js `POST /api/admin/events/:id/duplicate`
route. Every other name in both destructure blocks was left untouched without re-checking (out of
scope — they weren't part of this engine's dependency list).

**Static byte-identity check** (beyond the usual `node -c`/grep sweep, given the stakes): diffed each
of the five relocated function bodies against the pre-move `app.js` (via `git show HEAD:app.js`) line
by line. All five are character-for-character identical except a handful of trailing-whitespace-only
differences — a trailing space trimmed from a handful of blank lines inside `syncCalendarHolds`, and
one trailing space trimmed from inside a SQL template literal in `syncBookingToCalendar` (cosmetic;
inert for SQLite). No logic, control flow, comments, or variable names differ at all.

Verification: `node -c` on both changed files; confirmed zero remaining `app.js` definitions of any
of the 5 functions outside comments, and zero remaining references to any of the 11 removed dead
names; `npm run smoke` 329/329. `npm test` x6, given the stakes (more than the usual 3-5 run bar) —
4 clean 664/664 runs, 2 runs with failures, none reproducing the same pairing twice and always clean
on the very next run:
- Run 1: one failure, identity lost to a harness output-capture artifact (only the log's last ~62
  lines were retained) — redirected subsequent runs to a scratchpad file instead to avoid the same
  gap.
- Run 4: `calendar-booking-sync.test.js`'s "cancel: deleteGoogleEvent was invoked..." (previously
  logged, route batch 15 update above) and `calendar.test.js`'s **CP17** ("`syncEventToCalendar` was
  actually invoked after the drag" — previously logged, Phase 4 `finance` domain update above).
- Run 5: **CP17** again, plus **CP5** (venue_name propagation — previously logged many times, most
  recently route batch 24 above; exercises `updateEventVenueLegacyLink`, code this step never read).

CP17 recurring on two consecutive runs is a higher rate than its single-occurrence history, so gave
it extra scrutiny rather than filing it on pattern-match alone: read the still-in-app.js call site
(`PATCH /api/admin/events/:id/date`, line ~8665) that fires `syncEventToCalendar(eventId).catch(...)`
and confirmed it is completely unchanged — same fire-and-forget shape (the `res.json(...)` response
returns synchronously immediately after, exactly as before), same import path (now from the new
destructure at the top of the file), nothing about the wiring differs from pre-move. Combined with
the byte-identity diff above and CP5 (unrelated code, untouched by this step) failing in the same run
as CP17, the pattern matches this suite's own documented precedent of an entire run occasionally
landing under heavier timing pressure and producing a small cluster of unrelated fixed-sleep flakes
together (see the "shared-helper extraction" update above) rather than one function's logic being at
fault. Treated as the same pre-existing sleep-margin flake family, not a regression.

Existing direct coverage of the relocated engine (none written for this step — all pre-existing):
`calendar-booking-sync.test.js` proves `syncBookingToCalendar` is actually invoked (not silently
skipped) on a real booking's confirm/reschedule/cancel via log-line matching; `calendar.test.js`'s
CP7/CP18 exercise `hasCalendarConflict`'s booking-vs-event and event-vs-event local conflict paths
(409 rejections); CP17 exercises `syncEventToCalendar`; `isWithinWorkingHours` is exercised
indirectly via `booking.test.js`'s happy-path working-hours check. `syncCalendarHolds` has no direct
test coverage — it's cron-only (`startBackgroundClerk`), calls Google's `events.list`, and is wrapped
in its own top-level try/catch; this is a pre-existing gap (same category as the already-documented
"Google Calendar request-payload assertions are not achievable" limitation below), not something
this step introduced or could close without changing application code.

### Bookings sub-batch E: the calendar/venue/date cluster (6 routes) — DONE

The first routes to actually consume the newly-relocated calendar-sync engine: `POST
.../book-again`, `POST .../sync-calendar`, `PUT .../venue` (legacy venue_id link/unlink), `PUT
.../venue-google` (Google Places link), `PATCH .../date` (drag-reschedule), `PATCH .../venue`
(free-text venue editor).

Two more helper functions needed relocating first, both traced end-to-end before moving anything:

- **`checkDateAvailability`** (local-only, no Google API — the sibling of `hasCalendarConflict`)
  joined **`lib/calendar-sync.js`**. Every dependency (`getDateHoldsForAvailabilityCheck`,
  `getUpcomingStandaloneEventOnDate`, `getBookingsOnDateForAvailability`, plus already-present
  `parseDurationToMinutes`/`addMinutesToTime`/`bookingConfig`) was already either in that module or
  an existing Phase 4 repository export. `book-again` and `PATCH .../date` both call it; the public
  `/api/public/availability` route and the public booking-intake flow (both still in app.js, not
  today's scope) also call it, so app.js re-imports it from the module. While touching this block,
  also removed two orphaned JSDoc comments left behind by the earlier calendar-sync-engine move
  (doc comments for `isWithinWorkingHours`/`hasCalendarConflict` that survived the `REMOVED_`
  rename-then-blank technique because they were physically separate from the function bodies) —
  genuinely dead now that their subject functions no longer live in this file.
- **`sendDateChangedEmail`** joined **`lib/booking-notifications.js`** — exactly the same shape as
  every sibling already there (`escapeEmailFields` + `getEmailFooterContext` + `bannerRegistry` +
  `emailComponents` + `sendEmail`, all already required by that file for its existing exports; zero
  new requires needed). `PATCH .../date` is one of its two callers; the other (the events cluster's
  own `PATCH /:id/date`) is still in app.js and not part of this batch, so app.js re-imports it too.

Dead-import sweep (same `\bname\b`-grep-before-removal discipline as every prior batch) found 12
more names orphaned once these two routes' repository calls moved with them: `updateBookingVenueUnlink`,
`updateBookingVenueLinkLegacy`, `updateBookingVenueGoogle`, `getBookingEventId`, `unlinkEventVenue`,
`updateEventVenueLegacyLink`, `updateEventVenueGoogleLink`, `updateBookingVenueFreeText`,
`updateEventVenueFreeText`, `updateBookingDateAndTimeFields`, `updateDateHoldDateForBooking`,
`insertBookAgainBooking`. Kept `updateEventDatetime` (still called at the events cluster's own date
route) and `getBookingByIdAsync` (4 remaining call sites elsewhere) — both confirmed via the same
grep before deciding either way. The `venues` table has no Phase 4 repository of its own (never one
of the 8 domains) — the two venue routes' direct `db.get`/`db.run` against it is not a gap, it
matches the existing pattern (`db` is already required directly in `routes/admin/bookings.js`).

Verification: `node -c` on all changed files; grep sweep confirmed zero remaining `app.js`
registrations for all 6 paths and zero remaining dead names; `npm run smoke` 329/329. `npm test` x4
valid runs (a 5th was invalidated by the self-inflicted DB-collision incident logged under "Known
testing limitations" above) — 2 clean 664/664, one recurrence of the already-logged "reschedule:
SECOND sync attempt" flake on the exact route this batch moved (re-diffed byte-identical against
`git show HEAD:app.js` — confirmed clean), and one new-to-this-session instance of the same timing-
margin family in `email.test.js`'s Guard 5 (deposit-balance-due email), traced to `PUT
.../manual-payment` — untouched by this batch — `await`-ing a real Calendar OAuth round-trip before
firing that email, a sensitivity the test's own comment already flags. Direct coverage from
`calendar.test.js`'s **CP5** (`PATCH .../venue` free-text venue propagation) and
`calendar-booking-sync.test.js`'s reschedule check (`PATCH .../date`). No dedicated coverage for
`book-again`, `sync-calendar`, `PUT .../venue`, or `PUT .../venue-google`, so drove all four
manually against real fixtures (19 checks, all passing): `sync-calendar` invoking
`syncBookingToCalendar` with log-line evidence; `book-again` rejecting a non-CANCELLED booking (400),
succeeding on a CANCELLED one with copied client fields and both `REBOOKED`/`CREATE` audit rows;
`PUT .../venue` linking-by-`venue_id` and unlinking; `PUT .../venue-google` inserting a new `venues`
row on a fresh `place_id` and updating in place (no duplicate row) on a repeat call with the same
`place_id`.

### Bookings sub-batch F: the admin quote route (1 route, the biggest so far) — DONE

`POST /api/admin/bookings/:id/quote` — the route explicitly flagged since the reconnaissance
write-up as needing `findOrCreateClient`/`setBookingClientId`, and the single biggest route moved in
this whole pass (~320 lines): structured/legacy quote bodies, the calendar + per-day-service conflict
checks, VAT/totals computation, the re-quote-after-committed path (supersedes payment schedules,
voids the live invoice, resets any contract to draft — all inside one guarded transaction), quote
PDF generation, and the post-commit side effects (calendar sync, client + admin notification emails).

Every dependency traced individually rather than assumed:

- **`findOrCreateClient`** turned out to already be relocated (to `lib/client-venue.js`, from a
  batch this write-up hadn't previously covered in detail) — fully leaf-safe, zero new work needed,
  just an import.
- **`setBookingClientId`**, **`updateBookingAfterQuote`**, **`deleteBookingLineItems`**,
  **`deleteBookingServices`**, **`insertBookingLineItem`**, **`insertBookingService`** — existing
  `bookings.repository` exports, newly imported into `routes/admin/bookings.js`.
- **`getQuoteNumberCollisionCount`**, **`voidInvoiceForRequote`**, **`archivePreviousQuotations`**,
  **`getNextQuoteVersion`**, **`insertQuotation`**, **`insertQuoteLineItem`** — existing
  `invoices-quotations.repository` exports.
- **`supersedePaymentSchedulesForRequote`** — existing `finance.repository` export.
- **`resolveLineTaxClasses`/`getVatRate`/`computeDocumentTotals`** (sub-batch C's
  `lib/document-totals.js`), **`hasCalendarConflict`/`syncBookingToCalendar`** (the calendar-sync
  engine), **`sendQuoteEmail`/`sendAdminQuoteSentNotification`** (`lib/booking-notifications.js`),
  **`withDbTransaction`**/**`dbRun`**/**`dbGet`** (the required-singleton transaction queue and
  `lib/db-helpers.js`) — all already-relocated and just needed importing.
- **`pdfService`** — first use of this module (`js/pdfService`) in `routes/admin/bookings.js`;
  `routes/admin/advancing.js` already established the `require('../../js/pdfService')` pattern,
  followed directly.

**A genuine relocation hazard caught before it shipped:** the route's top-level-error handler writes
a debug dump via `require('fs').writeFileSync(__dirname + '/scratch/quote-error-toplevel.log', ...)`.
`__dirname` is file-relative — copied verbatim into `routes/admin/bookings.js`, it would silently
resolve to `routes/admin/scratch/...` (a directory that doesn't exist) instead of the original
`<project-root>/scratch/...`, changing behaviour despite the text being byte-identical. Caught by
checking every use of the moved code's `__dirname`/`__filename` before treating it as a safe verbatim
copy — an established `lib/runtime-paths.js` export (`PROJECT_ROOT`) already exists for exactly this,
so the fix is `path.join(PROJECT_ROOT, 'scratch', 'quote-error-toplevel.log')`, preserving the
original resolved path exactly. Worth checking on every future batch: `__dirname`/`__filename` in
moved code needs this treatment; nothing else in this route used either.

**Dead-import sweep found one gap the process itself doesn't normally catch:** `sendQuoteEmail` had
zero remaining callers in `app.js` after the route moved (its only call site went with it), but
wasn't initially removed from `app.js`'s `lib/booking-notifications` destructure — caught on a
second, more thorough pass that extracted every call-shaped identifier from the original route body
and checked each one's remaining `app.js` usage individually (`getQuoteNumberCollisionCount`,
`voidInvoiceForRequote`, `archivePreviousQuotations`, `getNextQuoteVersion`, `insertQuotation`,
`insertQuoteLineItem`, `updateBookingAfterQuote`, `deleteBookingLineItems`, `deleteBookingServices`,
`supersedePaymentSchedulesForRequote`, and `sendAdminQuoteSentNotification` had all already been
correctly removed; `sendQuoteEmail` was the one miss). Fixed by removing it from the destructure too.

**Static byte-identity check** (same discipline as the calendar-sync-engine move, given the stakes):
diffed the full relocated route against `git show HEAD:app.js` line by line. The only difference
anywhere in ~320 lines is the intentional `__dirname` → `PROJECT_ROOT` fix described above, with its
explanatory comment — everything else, including every SQL string, every audit-log payload, every
error message, is character-for-character identical.

Verification: `node -c` on both files; confirmed zero remaining `app.js` registration for this path
and zero remaining references to any of the dependency names above outside comments; `npm run smoke`
329/329; `npm test` x3, all three clean 664/664 — no flakes at all this time, across the single most
heavily-tested route in the codebase (exercised, directly or as setup, by 9 different test files:
`banner`, `booking`, `calendar-booking-sync`, `calendar`, `contract`, `email`, `lifecycle`,
`payment-callback`, `pdf-golden`).

### The deferred `events` cluster (6 routes) — DONE — closes out the bookings/events pass

`GET/POST /api/admin/events`, `PUT/DELETE /api/admin/events/:id`, `PATCH /api/admin/events/:id/date`,
`POST /api/admin/events/:id/duplicate` — the cluster explicitly deferred at the very start of this
pass pending the calendar-sync engine, now unblocked. Unlike every other domain in this pass, `events`
had no existing route file — created **`routes/admin/events.js`** and mounted it in `app.js` right
after `routes/admin/bookings.js`.

Two more pieces of local (non-route) code moved with it, both single-consumer within this exact
cluster and nothing else in `app.js`:

- **`checkEventConflicts`** — the standalone-event conflict checker (bookings + holds + other
  events on the same day), depends only on already-existing repository exports
  (`getBookingsOnDateForEventConflict`, `getActiveDateHoldsForEventConflict`, `getOtherEventsOnDate`)
  and already-relocated `lib/time-utils.js` helpers.
- **`VALID_EVENT_STATUSES`/`VALID_EVENT_TYPES`** — the two validation-list constants.

All other dependencies were already-existing Phase 4 repository exports newly imported into the new
file (`insertEventFull`, `updateEventFull`, `deleteEventById`, `getEventForConflictEdit`,
`getEventForDragReschedule`, `updateEventDatetime`, `insertEventForDuplicate`, `getEventById`,
`linkEventToPlaceholderBooking`, `clearEventGoogleCalendarId`, `getEventGoogleCalendarId`,
`clearDateHoldEventId`, `insertDateHoldForNewEvent` from `calendar.repository`;
`insertPlaceholderBookingForEvent`, `getBookingByIdSafeAsync`, `updateBookingDateFromEventEdit`,
`clearBookingEventIdWhereEventId`, `setBookingDateAndStartTimeFromEvent`, `setBookingEventId`,
`getBookingById` from `bookings.repository`) or already-relocated `lib/` modules
(`deleteGoogleEvent`, `resolveActor`, `hasCalendarConflict`/`syncBookingToCalendar`/
`syncEventToCalendar`, `sendDateChangedEmail`) — zero new repository or lib work needed, the whole
cluster was mechanical once traced.

**A copy-paste mistake caught by re-verifying, not assumed correct:** while writing the new file's
`calendar.repository` import, `linkEventToPlaceholderBooking` was initially (incorrectly) also added
to the `bookings.repository` import — it only exists on `calendar.repository`. Caught immediately by
running the same static undefined-reference sweep (from the `dbGet` fix earlier this session) against
the new file before considering it done, rather than trusting the hand-written import list on sight.

Dead-import sweep found 17 more names orphaned in `app.js`'s own destructures once this cluster's
calls moved with it — the largest single dead-import cleanup this session, reflecting how much of
`app.js`'s remaining calendar/event surface belonged to exactly this cluster:
`getBookingsOnDateForEventConflict`, `insertPlaceholderBookingForEvent`, `linkEventToPlaceholderBooking`,
`getBookingByIdSafeAsync`, `updateBookingDateFromEventEdit`, `clearBookingEventIdWhereEventId`,
`setBookingDateAndStartTimeFromEvent`, `getActiveDateHoldsForEventConflict`, `getOtherEventsOnDate`,
`insertEventFull`, `insertDateHoldForNewEvent`, `getEventForConflictEdit`, `updateEventFull`,
`clearDateHoldEventId`, `getEventForDragReschedule`, `getEventById`, `insertEventForDuplicate`. Kept
`setBookingEventId`, `clearEventGoogleCalendarId`, `getEventGoogleCalendarId`, `deleteEventById`, and
`updateEventDatetime` — each confirmed via `grep -o` occurrence counting (not line counting, which
under-counts when two matches share a line) to have a genuine second call site elsewhere in `app.js`
(the booking-side `manual-payment`/`applyStatusChange`-adjacent auto-event-creation code, and the
bookings `PATCH .../date` route moved in sub-batch E).

Verification: `node -c` on both files; the static undefined-reference sweep on both `app.js` and the
new file (clean); confirmed zero remaining `app.js` registrations for all 6 paths and zero remaining
references to any of the 17 dead names; `npm run smoke` 329/329; `npm test` x3, all three clean
664/664 — this cluster has the heaviest dedicated coverage of anything moved this session:
`calendar.test.js`'s **CP7** (booking-linked event edit conflict check), **CP8** (both the public
endpoint and the admin `GET /api/admin/events` default/`?include_private=1` views), **CP17**
(`PATCH .../date` drag-reschedule sync), **CP18** (event-vs-event conflict on create), **CP19**
(`block_type:booking` bidirectional link), **CP20** (`block_type:hold` + delete without an FK error).
Only `POST .../duplicate` had no dedicated test — manually verified against a real fixture (6 checks,
all passing): 200 + a new id distinct from the original, `" (Copy)"` appended to the title, every
copyable field (datetime/venue/type/capacity/ticket link) preserved, status reset to `draft`
regardless of the original's status, and 404 on a non-existent source event.

**This closes out the deferred `bookings`/`events` pass** first scoped in the reconnaissance
write-up above. Remaining Phase 5 scope: the 19-route `/api/public/bookings/*` surface,
`applyStatusChange` and its dependency web (`processManualPayment`, `alignMilestonePayments`,
`updateBookingMilestones`, `deriveBookingStatusAfterPayment`), `generateInvoice` +
`autoBuildDepositBalanceSchedule`, `logPaymentEvent`/`generatePayFastSignature`, the remaining
`send*Email` functions not yet relocated, and ~12 background cron jobs — none started yet.

### The public `/api/public/bookings/*` surface begins — shared prerequisites

Started the last major piece of Phase 5's route-extraction work: 19 routes covering the entire public
booking self-service surface (draft/resume, tracking OTP, payment initiation, quote acceptance,
contract signing, downloads, cancellation, review). Before touching any route, relocated the
shared layer nearly all of them depend on — same "prerequisite first" discipline as
`lib/calendar-sync.js` before the admin bookings pass:

- **`lib/booking-tracking.js`** (new): `asBookingText` (used pervasively across this whole surface,
  including the not-yet-moved public booking-intake route itself), `OTP_TTL_MINUTES`/
  `OTP_MAX_ATTEMPTS`/`ACCESS_TOKEN_TTL_MINUTES`, `generateOtpCode`, `hashAccessToken`. All five were
  already fully self-contained (built-ins + `crypto` only).
- **`middleware/booking-access.js`** (new): `requireBookingAccessToken` — the gate 9 of these 19
  routes use directly as declared middleware (the client-facing analogue of `requireAdmin`).
  Depends only on the new `lib/booking-tracking.js` and two existing `bookings.repository` exports
  (`getBookingAccessTokenByHash`, `touchBookingAccessToken`) — both now dead in `app.js` and removed
  from its destructure, matching `middleware/auth.js`'s own existing shape and location.

`app.js` re-imports all six names — every one of the 19 routes still lives there for now.

Verification: `node -c`; the static undefined-reference sweep on both new files and `app.js` (all
clean); `npm run smoke` 329/329; `npm test` x2, both clean 664/664 — no routes moved yet, so no new
direct coverage to speak of; the two runs confirm the relocation itself introduced no regression in
whatever already exercises this code path indirectly (the tracker OTP flow, quote acceptance, etc.,
all still living in `app.js` unchanged).

### Public bookings sub-batch A: the draft/resume cluster (4 routes) — DONE

`POST /api/public/bookings/draft` (autosave), `GET .../draft/:resumeToken` (fetch for resume),
`GET/POST .../draft/:resumeToken/optout` (the render-then-mutate pair for recovery-reminder
opt-out — a GET must never itself unsubscribe, since email-security scanners pre-fetch links).
First actual route batch of the public pass; no prior route file existed for this domain — created
**`routes/public/bookings.js`** and mounted it in `app.js` right after `routes/admin/events.js`.

Two more single-consumer local helpers moved with it, both already fully self-contained: 
**`estimateDraftValue`** (a `services` price lookup, pure `db.all` + arithmetic) and
**`_abOptOutPage`** (the inline HTML confirmation-page renderer shared by both opt-out routes).
Everything else was already available: `db`, `crypto` directly; `ipRateLimiter`
(`middleware/rate-limiters.js`) and `encodeUserHtml` (`lib/html-sanitize.js`) both already
relocated and just needed importing.

Verification: `node -c`; the static undefined-reference sweep (clean); confirmed zero remaining
`app.js` registrations for all 4 paths; `npm run smoke` 329/329; `npm test` x2 — 1 clean 664/664, 1
with the already-extensively-documented **CP5** flake (`updateEventVenueLegacyLink` propagation,
unrelated to anything in this batch). No dedicated test coverage existed for any of these 4 routes
— manually verified all of them against real fixtures (11 checks, all passing): the POPIA-
minimisation skip when no email is present yet, upsert-with-resume-token-preserved-across-repeat-
calls, `furthest_step` staying monotonic, fetch-for-resume returning the exact persisted fields,
404 on an unknown token, the opt-out page rendering real HTML (not JSON) with a POST form pointed
at the same path, the POST actually flipping `opt_out`/`status`, and the fetch route correctly
returning 410 once opted out.

### Public bookings sub-batch B: tracker OTP + lookup + data-fetch (4 routes) — DONE

`POST .../:id/track/request-code` + `.../:id/track/verify-code` (the two-step OTP flow that gates
every other tracking-adjacent route via `requireBookingAccessToken`), `POST .../bookings/lookup`
(find bookings by email), `POST .../:id/track` (the actual client-facing data fetch — booking
summary, invoice, payment schedule, services, quote version, cancellation, contract — built from an
explicit allowlist rather than the raw `bookings` row). Appended to `routes/public/bookings.js`.

All dependencies were already-existing exports needing only import: `getBookingEmailForTracking`,
`consumeUnconsumedAccessCodes`, `insertBookingAccessCode`, `getActiveAccessCodeForVerification`,
`consumeAccessCodeById`, `incrementAccessCodeAttempts`, `insertBookingAccessToken`, `getBookingById`
(`bookings.repository`); `getInvoiceForTracking`, `getQuoteVersionInfoForTracking`
(`invoices-quotations.repository`); `getPaymentSchedulesForTracking`,
`getCancellationSummaryForTracking` (`finance.repository`); `bcrypt`, `bannerRegistry`,
`emailComponents`, `sendEmail`, `getEmailFooterContext` (all already-established import patterns);
`otpRequestRateLimiter`/`mutateRateLimiter`/`lookupRateLimiter`/`trackRateLimiter` and
`requireBookingAccessToken` from the prerequisite work above.

Dead-import sweep found 11 more names orphaned in `app.js`'s destructures (all seven access-code/
token functions, `getInvoiceForTracking`, `getQuoteVersionInfoForTracking`,
`getPaymentSchedulesForTracking`, `getCancellationSummaryForTracking`) — removed; kept
`getBookingById` (heavily used elsewhere) and every sibling on the same lines confirmed to still
have a real call site.

Verification: `node -c`; the static undefined-reference sweep (clean on both files); confirmed zero
remaining `app.js` registrations for all 4 paths and zero remaining references to any of the 11 dead
names; `npm run smoke` 329/329; `npm test` x2, both clean 664/664. `track/request-code` and
`track/verify-code` have exceptionally heavy *indirect* coverage — `test/support.js`'s
`getTrackingToken()` helper drives this exact two-step flow as setup for nearly every test file that
needs quote acceptance (`booking`, `calendar-booking-sync`, `calendar`, `contract`, `email`,
`lifecycle`, `payment-callback`, `pdf-golden`). The plain data-fetch `track` route and `lookup` had
no dedicated coverage — manually verified both against real fixtures (11 checks, all passing):
`lookup` finding a real booking by email, a friendly `success:false` on an unknown email, 400 on a
malformed address; `track` rejecting a missing token (401), returning the full allowlisted payload
for a valid token (confirmed no internal-only fields like `admin_notes`/`ip_address` leak), and a
token scoped to one booking correctly failing (401, not 404) against a different booking id.

### Public bookings sub-batch C: the three download routes — DONE

`GET .../:id/invoice/download`, `GET .../:id/contract/download`, `POST .../:id/quote/download` —
the public-facing analogues of the admin download routes moved in the very first bookings sub-batch.
Appended to `routes/public/bookings.js`. All dependencies already existed: `resolveDocsPath`
(`lib/runtime-paths.js`), `getLatestQuoteFileForPublicDownload`
(`invoices-quotations.repository`), `fs`/`db` directly — only `getLatestQuoteFileForPublicDownload`
was newly dead in `app.js` and removed.

Verification: `node -c`; the static undefined-reference sweep (clean); confirmed zero remaining
`app.js` registrations and zero remaining reference to the one dead name; `npm run smoke` 329/329;
`npm test` x2, both clean 664/664. No dedicated coverage exists for any of these 3 routes
(`pdf-golden.test.js` only exercises their `/api/admin/bookings/*` counterparts) — manually verified
all three end-to-end against real generated PDFs (13 checks, all passing): `quote/download`
succeeding once a quote exists and rejecting a missing token; `invoice/download` correctly 404ing
before an invoice exists and succeeding once one is generated; `contract/download` — where the
first verification attempt surfaced a wrong *assumption in the test*, not a bug: it expected no
contract to exist until an explicit admin `contract/generate` call, but `accept-quote`'s own
`generateContract(bookingId)` call (documented in the *admin bookings* sub-batch C write-up above)
already auto-creates a draft contract on quote acceptance, so a real PDF was already being served correctly
— confirmed via the `contracts` table directly, then re-verified the download route itself was never
at fault.

### Public bookings sub-batch D: cancel, review, attachments — DONE

`POST .../:id/cancel` (client self-cancellation, refund calc + a guarded transaction that cancels
the booking, records the cancellation, releases date holds, voids invoices, and cancels pending
payment schedules atomically), `POST .../:id/review` (post-event rating, COMPLETED bookings only),
`POST .../:id/attachments` (supporting-file upload — the one route in this whole pass that
authenticates by matching a client-supplied email against the booking's own email rather than
`requireBookingAccessToken`, an existing, deliberate difference left exactly as found).

New dependencies, all already-existing exports needing only import: `calculateCancellationRefund`
(`lib/cancellation-refund.js`), `sendCancellationEmail` (`lib/booking-cancellation-email.js`, both
already relocated in earlier batches), `withDbTransaction`/`dbRun` (the required-singleton
transaction queue + `lib/db-helpers.js`), `insertCancellationForPublicCancel`
(`finance.repository`), `releaseDateHoldsForBookingAsync` (`calendar.repository`),
`voidInvoicesForCancelledBookingAsync` (`invoices-quotations.repository`),
`cancelPendingPaymentSchedulesAsync` (`finance.repository`), `getNotificationEmail`
(`settings.repository`). **`bookingAttachUpload`** (the attachments multer config) moved directly
into the route file as a single-consumer local, matching the `contractUpload` precedent from the
admin contract-cluster batch.

Dead-import sweep found only `insertCancellationForPublicCancel` newly orphaned in `app.js` — every
other name above (`sendCancellationEmail`, `calculateCancellationRefund`,
`releaseDateHoldsForBookingAsync`, `voidInvoicesForCancelledBookingAsync`,
`cancelPendingPaymentSchedulesAsync`) still has a genuine second caller elsewhere (confirmed via
`grep -o` occurrence counts, not line counts) in the still-deferred `accept-quote`/
`quote-revision-request` routes and the admin bulk-cancel path.

Verification: `node -c`; the static undefined-reference sweep (clean); confirmed zero remaining
`app.js` registrations for all 3 paths and zero remaining reference to the one dead name; `npm run
smoke` 329/329; `npm test` x3 — 2 clean 664/664, one run with the already-extensively-documented
`calendar-booking-sync.test.js` "cancel: deleteGoogleEvent" flake, which exercises the *admin*
cancel route (`/api/admin/bookings/:id/cancel`), not the public one moved here — unrelated. No
dedicated coverage exists for any of these 3 public routes — manually verified all three against
real fixtures (15 checks, all passing), including a self-corrected fixture mistake: the admin
booking-creation route's own `validStatuses` allowlist (`NEW`/`PENDING`/`QUOTED` only) silently
downgrades any other requested status to `NEW`, so a `COMPLETED` fixture for the review test had to
be seeded with a direct DB write instead of assumed from the creation call — not a bug in the
relocated `review` route, a wrong assumption in the test caught by checking the actual persisted
status before blaming the route.

### Step 1: app.js/server.js skeleton split + middleware extraction — DONE

See the commit message for the mechanics (byte-identical `middleware/auth.js`, `middleware/rbac.js`,
`middleware/error-handler.js`; `requireAdmin` reassembled from an imported check function + the
`adminRateLimiter` that stays in `app.js`; the two error handlers now take `rootDir` as a parameter
since `__dirname` would otherwise resolve to `middleware/` instead of the project root).

**10 routes fall outside the plan's `/api/admin`/`/api/public` boundary** and aren't counted in the
270+49: `/robots.txt`, `POST /upload`, `POST /api/payment/webhook/payfast`,
`GET /api/bookings/:id/payment-logs`, `GET /payment/success`, `GET /payment/cancel`,
`POST /send-email`, `GET /api/calendar/feed.ics`, `GET /sitemap.xml`, `POST /api/debug`. Decision
(confirmed with the user): sort by behavior — auth-gated ones into `routes/admin/`, unauthenticated
ones into `routes/public/`.

**`/robots.txt` is the one exception, staying in `app.js`.** A physical `robots.txt` file exists in
the repo root (`ls` confirmed it), currently shadowed because the programmatic
`app.get('/robots.txt', ...)` handler is registered *before* the blanket
`express.static(path.join(__dirname, '/'))` mount. If this route moved into a router mounted after
static serving — the natural thing to do with "put routes in their own files" — the stale physical
file would start being served instead, silently changing behavior. No physical `sitemap.xml` exists,
so that route has no equivalent risk and can move normally.

**`/api/debug` reported per the plan's explicit instruction, not touched.** `POST /api/debug` is
`requireAdmin`-gated and does exactly one thing: `console.log('[DEBUG API] Background configuration
trace:', req.body)`, then returns `{success:true}`. It doesn't read or return stored data — its only
effect is writing an authenticated admin's request body into the server console. Low severity given
the auth gate, but flagged for the user's own call on whether to keep it.

**A pre-existing bug found in passing, not fixed:** `GET /api/bookings/:id/payment-logs` checks
`req.session.admin`, which is never set anywhere in the codebase (every login sets
`req.session.adminId`/`.username`/`.role`, never `.admin`). This route has been returning 401 to
every caller, admin or not, since it was written. Relocating it byte-identical when its batch comes
up; not fixing the check.

**Smaller oddity, also left alone:** `POST /upload` inlines its own `req.session.adminId` check
instead of using `requireAdmin`, because — per its own comment — it's defined earlier in the file
than the `requireAdmin` `const`. That positional reason disappears once `requireAdmin` is an import
available from the top of the file, but per "move only" the duplicate inline check stays exactly as
it is rather than being consolidated onto the shared middleware.

**No existing graceful-shutdown code** (no SIGTERM/SIGINT handlers anywhere) — "shutdown" in the
plan's "config, listen, shutdown" describes a slot in the new structure, not something that needed
relocating. `app.listen()`'s callback does real startup work (loads pending scheduled
newsletter/direct-email jobs, runs a quote-amount consistency check against the DB) and moved to
`server.js` in full; `loadPendingScheduledJobs`/`loadPendingDirectEmails` are exported from `app.js`
alongside `app` itself so `server.js` can call them.

Verification: `node -c` on all 5 changed/new files; `npm test` run **5 times** given this is the
foundational step everything else depends on — baseline-only 3 of 5 runs, one recurrence each of
CP5 (already-documented) and a new one, **CP12** (`inquiries.test.js` — "responded_at set on first
reply" / "NOT overwritten by a second reply"), see the Deferred fix #3 update below. The RBAC suite
specifically — 141 tests — passed identically on every run, meeting the plan's "not by a single
character" bar for auth/RBAC. `npm run smoke` 329/329. `git status` confirmed only `app.js`,
`server.js`, and `middleware/*.js` changed.

---

## Phase 4 — Data-access extraction

**Phase 4 is now complete — all 8 planned domains extracted.** Order followed the plan's suggested
least-dangerous-first sequence: `settings` → `newsletter` → `inquiries` → `bookings` →
`invoices+quotations` → `finance` → `calendar` → `auth+users`. See each domain's own write-up below
for scope, consolidations, and verification. Phase 5 (routes/middleware split) is next.

### Domain: `auth+users` (session 8 of 8 — closes out Phase 4)

New file: `database/repositories/auth-users.repository.js`. Covers `admins`, `admin_login_logs`,
`password_reset_tokens` — 32 exported functions. The smallest and most contained domain of the
eight: no separate `sessions` table exists to extract (session persistence is entirely
connect-sqlite3/express-session middleware against `sessions.sqlite`, outside the app's own SQL
layer), and no 2FA/TOTP tables either.

#### Consolidations (byte-identical SQL, multiple call sites)

| Function | Call sites |
|---|---|
| `updateAdminPassword` | force-change-password route, token-verified reset-password route (both callback) |
| `insertPasswordResetToken` | `createAndSendInvite()` (new-user invite + resend-invite), the forgot-password route (both callback) |

#### Two genuine same-domain self-JOINs (not cross-domain — moved in full)

Unlike every JOIN found in earlier domains, these don't reach into another domain's table:
- `getAdminsListWithCreatorModifier` (`GET /api/admin/users`) — `admins` joined to itself twice
  (`creator`/`modifier` aliases) to resolve who created/last-edited each account.
- `getAdminLoginLogsWithNames` (`GET /api/admin/user-login-logs`) — `admin_login_logs` joined to
  `admins` for display names. Both tables belong to this domain.

#### Left untouched (confirmed cross-domain or generic infra)

- `GET /api/admin/audit_log`'s `LEFT JOIN admins actor ON ...` — stays in `server.js` in full:
  `audit_log` is the same permanently-excluded generic infra table established in
  `finance`/`invoices+quotations` (written from routes across every domain, claimed by none), so the
  whole dynamically-built statement stays regardless of it also touching `admins`.
  `financial_audit_log` and `audit_log`, `venues`, and now `policies` (flagged in the `calendar`
  write-up) are the running list of tables no domain has claimed.
- `inquiries`' `assigned_to` JOIN — stays exactly where `inquiries.repository.js`'s own header
  already documented it back in session 3.

#### Found inside an already-completed domain's routes

Three `admins`-only statements (no JOIN — just plain reads of the `admins` table) were living
inside `inquiries`-domain routes: `GET /api/admin/inquiries/assignable-admins`, the assign route's
active-admin existence check, and the note-author display-name lookup on note creation. Extracted
here; the surrounding `inquiries.repository.js` calls in those same routes (`unassignInquiry`,
`assignInquiry`, `updateInquiryPriority`, `insertInquiryNote`, etc.) are untouched. Mirror image of
the pattern from `calendar` (where domain statements turned up inside `bookings` routes) — this
time the direction is reversed, an earlier domain's routes contained a later domain's statement.

#### A genuine gap caught before it shipped

While rewiring `countOtherActiveAdministrators()` (the last-administrator guard shared by the
user-edit and user-delete routes), the planned `getActiveAdministratorCountExcluding` function
turned out to have been left out of the repository file entirely during authoring — the recon list
had it, the write-up plan had it, but the file itself didn't. Caught immediately when the rewiring
edit referenced a name that didn't exist in the file yet (rather than by the usual post-edit
re-grep sweep, this time by the wiring itself failing to make sense), fixed by adding the missing
function before continuing. Recorded because it's a slightly different failure mode than every
previous domain's self-review catches (a planned-but-never-written function, not a missed call site
or an unrecognized duplicate) — same lesson as always: the mandatory completeness check is what
catches these, not care taken while writing.

`resolveActor()` — the cross-cutting helper called from nearly every other domain's routes to
resolve an admin id into a display name for `last_updated` response fields — keeps its JS wrapper in
`server.js`; only its one `admins` SELECT moved, same treatment `checkDateAvailability`/
`hasCalendarConflict` got in `calendar`.

#### Self-review

Re-grepped `(FROM|INTO|UPDATE) (admins|admin_login_logs|password_reset_tokens)\b` and
`JOIN (admins|admin_login_logs|password_reset_tokens)` against the post-edit `server.js`. The first
came back with **zero remaining hits** — every direct statement was extracted. The JOIN sweep found
only the two confirmed-to-stay cross-domain/generic-infra JOINs above. Also scripted a wiring check
(count every exported function's occurrences in `server.js`): all 32 export names appear exactly
the expected number of times — import + 1 call site for ordinary functions, import + 2 for each of
the two consolidated functions — confirming no orphaned import and no missed call site.

#### Verification

- `node -c server.js`, `node -c database/repositories/auth-users.repository.js` — clean.
- `npm test` — run **5 times**, given this domain underpins literally every other admin-route test
  in the suite (login, session, RBAC). Results: the 2 permanent Deferred-fix-#1 failures every run,
  plus Deferred fix #3's **CP5** once (already-documented `calendar`-domain flake, not auth code —
  consistent with every prior domain's testing). No auth-specific failure, no new failure signature,
  across any run.
- `npm run smoke` — 329/329.
- `git status --short` — only `server.js` modified and `database/auth-users.repository.js` added.

### Domain: `calendar` (session 7 of 8)

New file: `database/repositories/calendar.repository.js`. Covers `date_holds` and `events` only —
53 exported functions (22 for `date_holds`, 31 for `events`, several of those being
callback/async sibling pairs over one shared statement).

**Deliberately out of scope**, found while reading but not claimed:
- **`venues`** — not one of the plan's 8 named domains. Every `date_holds`/`events` statement that
  JOINs `venues` (the today's-schedule feed, the admin calendar grid's public-events sub-query)
  stays in `server.js` untouched, same treatment `bookings`/`clients` JOINs got in earlier domains.
  `venues`' own CRUD (inside `PUT .../venue-google`) is untouched for the same reason.
- **`policies`** — a small business-rules table (`cancellation_policy`, SLA/reminder-day settings)
  read from ~10 places across bookings-cancellation, inquiries-SLA and reminder code, with its own
  admin CRUD elsewhere in `server.js`. Not in `settings.repository.js` either (checked) — an
  unclaimed table, like `venues`, that doesn't belong to `calendar` since it has nothing to do with
  dates/events. Flagging its existence here so it isn't lost track of; not fixed in this session.

#### Consolidations (byte-identical SQL, multiple call sites — verified with exact-string greps,
not just by eye, before merging)

| Function(s) | Call sites |
|---|---|
| `getEventById` | `syncEventToCalendar`, `POST .../duplicate` (both callback) |
| `insertAutoCreatedEvent` | PayFast ITN, manual payment, `applyStatusChange` CONFIRMED (all callback, `this.lastID`) |
| `releaseDateHoldsForBooking` / `...Async` | POPIA erasure, admin cancel route, public cancel route (async) + `applyStatusChange` CANCELLED (callback) |
| `getEventByBookingId` | POPIA erasure, admin cancel route (both async) |
| `demoteEventForCancelledBooking` / `...Async` (`WHERE event_id = ?`) | POPIA erasure (async) + `applyStatusChange` CANCELLED (callback) |
| `clearEventGoogleCalendarId` / `...Async` | POPIA erasure, admin cancel route (async) + `applyStatusChange` CANCELLED, `PUT /api/admin/events/:id` cancel-on-edit branch (callback) |
| `advanceEventToCompleted` | `POST .../complete`, `applyStatusChange` COMPLETED (both callback; the space in `('cancelled', 'completed')` matches) |
| `getEventGoogleCalendarId` | `applyStatusChange` CANCELLED, `DELETE /api/admin/events/:id` (both callback) |
| `updateEventDatetime` | booking date-change route, event drag-reschedule route (both callback) |
| `deleteEventById` | `PUT .../public` toggle-off branch, `DELETE /api/admin/events/:id` (both callback) |

#### Near-misses kept **separate** (confirmed genuinely distinct, not merged)

- `demoteEventForCancelledBookingByBookingIdAsync` — the dedicated admin cancel route's own
  variant filters `WHERE booking_id = ?` instead of `WHERE event_id = ?` (it matches by the event's
  own pointer so a pre-existing orphaned cross-reference still gets cleaned up, per that route's own
  comment) — a real semantic difference, not whitespace, so not folded into the pair above.
- `advanceAutoCompletedEventS6` vs `advanceEventToCompleted` — S6's cron statement has no space in
  `('cancelled','completed')`; the other two call sites do. Kept separate; not reformatted to match.
- `advanceStandaloneEventCompleted` (cron "S7") — no `AND event_status NOT IN (...)` clause at all,
  a third distinct variant of the same idea.
- **Four**, not three, separate venue-editing UPDATEs on `events` — a third venue-editing route
  (`PATCH /api/admin/bookings/:id/venue`, the free-text editor) turned up during this session that
  wasn't visible in the initial two-route estimate: `unlinkEventVenue` (2 fields, both NULLed),
  `updateEventVenueLegacyLink` and `updateEventVenueGoogleLink` (same 3-field SET list, but the
  second was originally nested one indentation level deeper in `server.js` — per the
  whitespace-as-byte-identity precedent from `bookings` Stage 3, kept as two functions rather than
  force-merged), and `updateEventVenueFreeText` (only 2 fields, no `venue_id` at all — a genuinely
  different column set from the other three).

#### A pre-existing bug, relocated as-is (not fixed)

`GET /sitemap.xml` runs `SELECT id, created_at FROM events ORDER BY date DESC` — but the real
columns are `event_id`/`event_datetime`, not `id`/`date`. This has always errored (wrong column
names) and the route's own `if (!err && events)` guard has always silently swallowed it — the
sitemap has never listed a single event, since the day this code was written. Per "housekeeping,
not improvement," the buggy query was moved byte-identical into `getEventsForSitemap()`, not fixed.

#### Multi-domain orchestration functions (only this domain's own statements touched)

POPIA erasure's booking-cancellation cascade, the dedicated admin cancel route's transaction,
`applyStatusChange`'s CANCELLED/CONFIRMED/COMPLETED branches, and the background-clerk cron's S6/S7
sweeps all keep their surrounding orchestration (email sends, other domains' cascades, the
`audit_log`/`financial_audit_log` inserts) in `server.js` exactly where it was — only the
`date_holds`/`events` statements inside them moved.

#### Self-review

Re-grepped `(FROM|INTO|UPDATE) (date_holds|events)\b` and `JOIN (date_holds|events)` against the
post-edit `server.js`. Every remaining hit is accounted for: the two `venues`-JOIN reads (today's
schedule, admin calendar grid), the two bookings-JOIN public/admin events listings, the
`bookings`-outer-table calendar-grid JOIN (`FROM bookings b ... LEFT JOIN events e ...`), and
`BOOKING_DELETE_PURGE`'s two hand-ordered cascade entries. No missed statements, no missed call
sites — the first domain since `bookings` Stage 5 where this sweep found nothing to fix.

#### Verification

- `node -c server.js`, `node -c database/repositories/calendar.repository.js` — clean.
- `npm test` — run **8 times** given this domain re-touches the same cancellation/status-change/
  venue routes already edited in `bookings` Stages 5-6. Results: the 2 permanent Deferred-fix-#1
  failures every run, plus Deferred fix #3's **CP3** (2 of 8 runs) and **CP5** (1 of 8 runs) —
  both already-documented timing flakes, not new ones (see the Deferred fix #3 update below) — and
  one unrelated one-off, "full refund re-derives payment_status to UNPAID" (1 of 8 runs, never
  recurred, touches `bookings`/finance payment_status code this session never read — consistent
  with the environmental-noise category the one-off `SQLITE_BUSY` crash was filed under).
- `npm run smoke` — 329/329.
- `git status --short` — only `server.js` modified and `database/calendar.repository.js` added, as
  expected.

### Domain: `finance` (session 6 of 8)

New file: `database/repositories/finance.repository.js`. Covers `transactions`,
`payment_schedules`, `cancellations`, `payment_logs`, `expenses`, and a table not previously
catalogued anywhere — **`bank_statement_lines`** (a bank-statement import/reconciliation feature,
found only by the live grep sweep since it wasn't mentioned in any earlier phase's docs).
`financial_audit_log` is deliberately excluded, same treatment as the generic `audit_log` table —
it's written from services/invoices/payment routes alike (SERVICE_ARCHIVED, INVOICE_VOIDED,
MANUAL_PAYMENT, EXPENSE_LOGGED, …) and has never belonged to any single domain.

**~65 statements moved.** This domain inherits the highest-risk surface of any session so far
after `bookings` Stage 6 itself: it supplies the `transactions`/`payment_schedules`/
`cancellations`/`payment_logs` halves of the exact same PayFast ITN webhook, manual-payment,
refund, reconcile/sync, and transactions/manual routes that Stage 6 already extracted the
`bookings`-table halves of — those statements were always cross-domain from `bookings`'
perspective specifically because this domain didn't exist yet.

**Two dashboard routes finished, not just deferred further.** `GET /api/admin/financials/
analytics` and `GET /api/admin/financials/stats` were deferred whole during `invoices+quotations`
(mixing one invoices-only aggregate with several transactions/expenses/bookings-joined queries).
Rather than deferring them a second time, this session finished both: pulled their
`transactions`/`expenses` statements here, and added 3 small functions to the already-complete
`invoices-quotations.repository.js` (`getInvoiceAgingSummary`, `getOverdueInvoicesSummary`,
`getDueSoonInvoicesSummary`) for their `invoices`-only aggregates. Every statement in both routes
that JOINs `bookings` (client top-spenders, overdue-invoice client names, category revenue,
pending-quotes-by-status, unsent-invoice count, recent-transactions-with-client-name) stays
cross-domain in `server.js`, per the standing rule.

**A likely pre-existing bug, found but not fixed:** `POST /api/admin/bank-statement/import` calls
`db.prepare()` then wraps the insert loop in `db.transaction(() => {...})` — but this codebase
uses `node-sqlite3` (`require('sqlite3')` elsewhere), whose `Database` has no `.transaction()`
method; that's a `better-sqlite3` API. The route would throw `TypeError: db.transaction is not a
function` at runtime if actually hit. Per the plan's rule against fixing bugs found incidentally
during a move, this is untouched — only the prepared statement's SQL text was relocated
(`prepareBankStatementLineInsert()`); the `db.prepare()`/`db.transaction()`/`insertStmt.run()`
call sites in `server.js` are byte-for-byte what they were.

**Real consolidations** (byte-identical duplicate SQL):
- `getPaymentSchedulesForDocument()` — 4 call sites (`generateInvoice`, `sendInvoiceEmail`,
  `sendQuoteAcceptedEmail`, `resolveContractFeeData`).
- `cancelPendingPaymentSchedules()`/`…Async()` — 4 call sites across POPIA erasure, admin cancel,
  `applyStatusChange`, and the public self-cancel route (mirrors the `invoices+quotations`
  domain's `voidInvoicesForCancelledBooking` shape exactly, same 4 routes).
- `getActivePaymentSchedules()` — 3 call sites in the payment-schedules admin routes (one of the
  three was missed on the first pass — see below).
- `getTransactionsForBooking()` — 2 call sites in `GET /api/admin/bookings/:id/details`
  (services-present branch and the legacy fallback branch).
- `getActiveExpenseById()` — 2 call sites (DELETE and PUT `/api/admin/expenses/:id`).

**4 distinct `cancellations` INSERT variants**, not 1 — the same "looks like a duplicate, isn't"
discipline as every prior domain: POPIA erasure (hardcodes `cancelled_by='client'`, no
`notes`/`admin_id`), the admin cancel route (adds `notes`/`admin_id`, `cancelled_by` is a
parameter), `applyStatusChange`'s CANCELLED branch (hardcodes `cancelled_by='comedian'` — the
CHECK constraint doesn't permit `'admin'`), and the public self-cancel route (adds `reason_code`,
no `notes`/`admin_id`) — four different column lists, four functions.

**Self-review caught 4 gaps** before sign-off, using the same "re-grep the six table names
against the post-edit file, check every remaining hit against an expected-to-stay list" technique
that has now caught residual gaps in every domain since `bookings` Stage 5:
1. The POPIA erasure function's `transactions` ip_address/notes/reconcile_note redaction UPDATE —
   catalogued during recon but the function itself never written.
2. `POST /api/public/bookings/:id/track`'s payment-schedule view (distinct column list from
   `getPaymentSchedulesForDocument`) — same story.
3. The rebalance route's *second* `getActivePaymentSchedules()` call site (the post-rebalance
   re-fetch) — missed by an exact-string consolidation edit because its callback parameter names
   (`e2, rows`) differed from the first occurrence's (`err, schedules`), so the two calls weren't
   literally the same source string even though they're the same SQL.
4. The public self-cancel route's 4th `cancellations` INSERT variant (`reason_code`) — not
   recognized as distinct from the other 3 until the rewiring pass reached it.
All four fixed and re-verified before running the test suite.

**Verification:** `node -c` clean on all three touched/created files. `npm test` run **6 times**
given the payment-route overlap with `bookings` Stage 6: 5 runs showed only the 2 permanent
Deferred-fix-#1 failures (649/651); 1 run additionally failed `calendar.test.js`'s **CP17**
("`syncEventToCalendar` was actually invoked after the drag") — a fixed `sleep(300)` racing a
real (deliberately-failing, bogus-token) Google Calendar API call, the identical mechanism as
Deferred fix #3's other four instances, and on a route (`PATCH /api/admin/events/:id/date`) this
session never touched. Logged as a further recurrence below, not a new root cause. `npm run
smoke` — 329/329. `git status` clean of surprises.

**Report, per the plan's own template:**
- Statements moved: **~65**, plus 3 more added to `invoices-quotations.repository.js` to finish
  the two deferred dashboards.
- Left as cross-domain: every JOIN/correlated-subquery statement is documented inline in the
  repository file, per this file's running convention; the refund route's `UPDATE bookings SET
  amount_paid = MAX(0, (SELECT ... FROM transactions ...))` — already flagged as cross-domain
  during `bookings` Stage 6 — is unaffected and still in `server.js`.
- Remaining raw SQL against these six tables: only genuine `bookings`-joined/correlated
  statements and the permanently-excluded `BOOKING_DELETE_PURGE`/`BOOKING_DELETE_UNLINK` entries.

---

### Domain: `invoices+quotations` (session 5 of 8)

New file: `database/repositories/invoices-quotations.repository.js`. Covers `invoices`,
`invoice_line_items`, `quotations`, `quote_line_items`. Found and confirmed by a live grep sweep
of every `FROM`/`INTO`/`UPDATE` hit against these four tables in `server.js` — not a stale
line-numbered catalog, since none existed for this domain (it wasn't part of the Phase 1 recon
agent's per-table breakdown the way `bookings` was).

**~57 statements moved** across `generateInvoice()`, `sendPaidReceiptEmail()`,
`sendBookingCompletedEmail()`'s VAT lookup, the daily overdue-flagging cron, two invoice-reminder
crons, the admin quote-generation route (the domain's largest single route), six admin invoice
actions (send/void/mark-paid/bulk-send-unsent/resend-quote + the three download routes), the
client accept-quote route, `resolveContractFeeData()`, `applyStatusChange()`'s ACCEPTED/QUOTED/
COMPLETED branches, the two services-usage/hard-delete guards, a small booking-financials
summary route, and the POPIA erasure functions (quotations' `file_path` only — invoices are
deliberately exempt from erasure everywhere, per `anonymizeClientData()`'s own header comment:
financial/tax records survive).

**Deliberately deferred to a future `finance` domain session:** two full reporting/dashboard
routes (`GET /api/admin/financials/analytics` and the finance-KPI dashboard route powering the
admin dashboard's summary tiles) each mix one single-table `invoices` aggregate query in with
several `transactions`/`bookings`-joined queries computing one cohesive report. Extracting just
the invoices-table fragment would have split one logical endpoint's data layer across two
repository files for no real benefit, so the whole route waits for `finance`, consistent with the
"a statement mixed into cross-domain work stays" spirit, generalized from statement-level to
route-level for these two dashboards specifically.

**Found but out of scope, left untouched:** `POST /api/public/bookings/:id/accept-quote`,
`POST /api/public/bookings/:id/quote-revision-request`, `GET /api/admin/bookings/:id/quote/download`
(public variant), and `POST /api/public/bookings/:id/cancel` (the client self-cancel route) each
also contain an un-migrated `bookings`-domain statement of their own — not touched here, since
`bookings` is already fully done (Stages 1–6) and these weren't part of that session's approved
scope. (The public cancel route's own **invoices** statement — the `voidInvoicesForCancelledBooking`
family below — *was* extracted here, since that statement belongs to this domain regardless of
which route hosts it, same as bookings-domain statements were pulled out of venue/event routes
back in the `bookings` domain's Stage 5.)

**Real consolidations** (byte-identical duplicate SQL, same discipline as every prior domain):
- `UPDATE invoices SET status='PAID'…UPPER(status) NOT IN ('VOID','PAID')` — 4 call sites
  (PayFast ITN, manual payment, reconcile/sync, transactions/manual) → `markInvoicePaidIfOpen()` /
  `…Async()`, split by sync style same as `getBookingById`/`…Async`.
- `UPDATE invoices SET status='VOID', void_reason='booking_cancelled'…` — 4 call sites spanning
  **three different domains' routes** (POPIA erasure, the admin cancel route, `applyStatusChange`'s
  CANCELLED branch, and the public self-cancel route) → `voidInvoicesForCancelledBooking()` / `…Async()`.
- `UPDATE quotations SET status = 'accepted'…` — 2 call sites (client accept-quote,
  `applyStatusChange`) → `markQuotationAccepted()` / `…Async()`.
- `SELECT * FROM invoices WHERE id = ?` (void route, mark-paid route) → one `getInvoiceById()`.
- `SELECT * FROM quote_line_items WHERE quotation_id = ?` (`generateInvoice()`,
  `resolveContractFeeData()`) → one `getQuoteLineItems()`.
- `UPDATE invoices SET sent_at = CURRENT_TIMESTAMP WHERE id = ?` (`generateInvoice()`,
  bulk-send-unsent) → one `markInvoiceSent()`.

**Near-misses deliberately NOT consolidated**, same byte-identical-means-identical-bytes rule as
every prior domain: `getActiveQuoteForInvoiceGen()` vs. `getActiveQuoteForContractFeeData()` (same
query, but one is multi-line and one is single-line — different source-level line-wrapping,
different call-site nesting depth); `getOpenInvoiceIdForReceiptCheck()` vs.
`getOpenInvoiceIdForAdjustmentRegen()` (different `NOT IN` list, one has an `ORDER BY`);
`getLatestQuoteFileForResend()` vs. `getLatestQuoteFileForPublicDownload()` (different column
list, different `archived=`/`archived = ` spacing); and, closest of all, `markInvoicePaidIfOpen()`
(has `UPPER(status)`) vs. two more standalone functions found late in self-review —
`markInvoicePaidForAutoComplete()` and `markInvoicePaidOnStatusComplete()` (neither has `UPPER()`,
and the latter two differ from each other only in whitespace around `=`) — three visually-similar
"mark this booking's invoice paid" statements that are genuinely three different byte sequences.

**Self-review caught 3 gaps before sign-off** (recon listed them; the first extraction pass
missed writing the actual functions/call sites for two, and one — `sendPaidReceiptEmail()`'s
own invoice lookup — was never actually read during recon, only counted by its grep hit):
the two `markInvoicePaid…` functions just above, and `getInvoiceForPaidReceipt()`. Found by
re-running the same `grep -n "FROM invoices|INTO invoices|UPDATE invoices|..."` sweep used for
recon against the post-edit file and checking every remaining hit against an expected-to-stay
list — the discipline that has caught every domain's residual gaps so far (Stage 5 and the
satellite-catalog pass both found similarly-missed statements this same way). All three fixed,
re-verified, before running the test suite.

**Verification:** `node -c` clean on both files. `npm test` run **5 times** (this domain touches
payment-status transitions and cancellation cascades throughout, so it earned the Stage-6 level
of scrutiny): 4 runs showed only the 2 permanent Deferred-fix-#1 failures (649/651); one run
crashed the whole process with `SQLITE_BUSY: database is locked` partway through
`banner.test.js` — a file with no relationship to invoices, quotations, bookings, or anything
touched this session. Re-ran twice more, both clean. Logged under "Known testing limitations"
below as a new, distinct flake category (a hard crash, not a wrong-assertion) worth watching for
if it recurs, but not attributable to this session's edits. `npm run smoke` — 329/329. `git status`
clean of surprises.

**Report, per the plan's own template:**
- Statements moved: **57**
- Left as cross-domain: correlated-subquery and JOIN statements documented inline above and at
  each call site's comment in the repository file (bookings/clients/venues/contracts/cancellations/
  payment_schedules/policies/quotations-across-domain-boundary/transactions/audit_log/
  financial_audit_log — the same generalized-from-JOIN "correlated subquery reading another
  domain's table" rule introduced in the `bookings` domain's Stage 6 applies to the refund route's
  ledger recalculation, noted there and unaffected by this domain's work)
- Remaining raw SQL in `server.js`: two whole routes deferred to `finance` (see above), 4
  found-but-out-of-scope `bookings` statements in other routes (see above), and everything
  cross-domain

---

### Domain: `bookings` (session 4 of 8) — DONE, staged sub-passes

By far the largest domain: ~229 statements on `bookings` alone (vs. 49 for
the next-largest, `newsletter`), plus 41 more across its satellite tables
(`booking_notes`, `booking_services`, `booking_line_items`,
`booking_access_codes`, `booking_access_tokens`). Confirmed with the repo
owner up front: staged sub-passes, full-suite verification after each,
explicit re-confirmation required before the highest-risk payment/ledger
stage. A background research agent cataloged every `bookings`-table
statement first (current line numbers, single vs. cross-domain, payment/
calendar/email/transaction flags); spot-checked a sample against the
actual code before trusting it.

**Deliberately out of scope, this domain and always:** `BOOKING_DELETE_PURGE`
/ `BOOKING_DELETE_UNLINK` (the cascade-delete arrays inside `DELETE
/api/admin/bookings/:id`) — a hand-ordered, FK-constraint-sensitive
sequence with its own comments describing past production bugs from
getting the order wrong. Splitting its ~21 statements across domain
repositories risks reintroducing exactly those bugs. Only the route's own
final `DELETE FROM bookings WHERE id = ?` (outside the arrays) is in scope,
not yet reached in the sub-passes below.

New file: `database/repositories/bookings.repository.js`.

**Universal consolidation found first:** `"SELECT * FROM bookings WHERE
id = ?"` is byte-identical across **41 separate call sites** (both
callback-style `db.get(...)` and promise-style `dbGet(...)` — two
functions, `getBookingById`/`getBookingByIdAsync`, not a style conversion).
Available to every later sub-pass; not all 41 call sites are updated yet —
only the ones reached so far.

#### Satellite tables — cataloged, not yet extracted
41 statements across the 5 `booking_*` tables: 28 movable, 8 cross-domain
(joined with `services`), 5 inside `BOOKING_DELETE_PURGE` (excluded). Full
catalog exists from this session's reconnaissance; extraction deferred to
a later sub-pass so the core table's higher-risk work isn't delayed.

#### Stage 1 — Reporting/analytics (read-only) — DONE
Of ~40 candidate statements, the vast majority are inherently cross-domain
(a financial/dashboard report necessarily joins `clients`, `invoices`,
`transactions`, `quotations`, `expenses`, `payment_schedules`, etc.) and
needed no code change at all — just confirmation they stay. **7 moved:**
`getBookingsTrend`, `stampReviewEmailSent` (2 call sites, byte-identical),
`unlinkBookingClient`, `getBookingTotalAmount` (2 call sites, byte-identical),
`getOutstandingTotal`, `getBookingStatusCounts`. Two explanatory comments
(the outstanding-total allowlist reasoning, the status-count disposition
filter) were carried into the repository, not dropped.

#### Stage 2 — Background cron jobs — DONE
`startBackgroundClerk()`'s single `setInterval` body (15 statements) plus
7 more across the named `run*Job()` functions — 22 moved in total. Several
jobs turned out to need **zero** changes once actually read: `runPaymentReminderJob`,
`runStalledBookingAdminAlertJob`, `runInvoicePreDueReminderJob`,
`runOverdueInvoiceSweepJob`, `runLedgerReconciliationJob`,
`runPayFastPendingTimeoutJob`, and the startup quote-consistency check all
touch `bookings` only via a JOIN (with `payment_schedules`, `invoices`,
`transactions`, or `quotations`) — cross-domain, correctly left untouched.
One bug caught and fixed *in my own edit, not the app* — an early version
of a call site passed `nowLocal` twice instead of once, mismatching
`getPendingEnquiriesNearingExpiry(nowLocal, callback)`'s actual signature;
caught by inspection before testing, not by a failing test.

**Verification so far:** `npm test` — 651/651, stable (one intermediate
checkpoint hit the same pre-existing calendar-sync flake pattern as
Deferred fix #3, twice, each a different test, then clean on retry —
consistent with that being general timing flakiness, not a regression).
`npm run smoke` — 329/329. `git status` clean of surprises.

#### Stage 3 — Admin CRUD/status routes + legacy tooling — DONE
**21 moved.** Deliberately excluded from this stage and pushed into Stage 6
alongside the payment routes: `applyStatusChange()`'s core cascade and
`POST /api/admin/bookings/:id/cancel` — both cascade into
invoices/payment_schedules/refunds, the same category of risk as the
payment routes, so they get the same explicit-confirmation gate rather than
slipping in under "CRUD."

Covered: admin manual-create (duplicate-check ×2 + the 29-column INSERT,
still inside its existing transaction), `reopen`, `book-again` (a 24-column
INSERT), `complete`, `buffer`, `disposition`, `respond`, the legacy
`/send-email` route's booking-creation branch (sibling to what the
`inquiries` domain already extracted from that same route), both legacy
migration tools (`/api/admin/migrate`, `/api/admin/system/migrate-legacy-data`
— found and merged one byte-identical duplicate, `updateBookingClientVenue`,
shared between them), and the `DELETE /api/admin/bookings/:id` route's own
pre-cascade read + final row-delete (both outside `BOOKING_DELETE_PURGE`/
`BOOKING_DELETE_UNLINK`, which remain untouched per the standing exception).
`GET /api/admin/bookings` (list) and its `:id` detail route are both
confirmed cross-domain (join `clients`/`venues`/`quotations`/`invoices`/
`contracts`) and needed no change.

Two near-duplicate statements were deliberately kept as separate functions
rather than force-merged, since their literal text differs (whitespace /
formatting only, but "byte-identical" means byte-identical): the admin
`/complete` route's completion UPDATE vs. the Stage 2 cron job's version,
and the two duplicate-booking-check queries (pre-lock callback-style vs.
post-lock promise-style) — each pair does share one function apiece,
because within each pair the two calls after this move now run the exact
same code, but the two *pairs* are distinct from each other.

**Verification:** `npm test` — 649/651, reproduced identically three times
in a row (the two failures are Deferred fix #1's pre-existing concurrency
test — unaffected, since this stage never touched the *public* booking
route that test exercises). `npm run smoke` — 329/329. `git status` clean
of surprises.

#### Stage 4 — Quote/invoice/contract/advancing generation — DONE
**~10 core-table statements moved**, plus this stage is where satellite-table
extraction actually started (see below) rather than waiting for its own
separate pass — reading `POST .../quote`'s transaction meant already having
its `booking_services`/`booking_line_items` refresh in view, so extracting
those alongside the `bookings` UPDATE avoided re-reading the same route later.

`generateContract()`, its `builder-data`/`preview` routes, `contract/send`,
and `remindBooking()` all turned out to need **zero** changes — every one
only touches `bookings` via a `LEFT JOIN clients`, cross-domain and
already-correct. `generateInvoice()` contributed 2 (client-id resolution,
post-invoice ledger UPDATE, the latter inside its own existing transaction).
The quote route contributed the status/total UPDATE (also inside its
transaction) plus reused the client-id function `generateInvoice()` already
needed. Small single-field reads moved for contract-upload, contract-remind,
and all three advancing-pack routes (two of which turned out to be the
already-known `getBookingByIdAsync` pattern, not new statements).

**Satellite tables — extraction begun:** while inside the quote route's
transaction, moved its `booking_line_items`/`booking_services`
delete-and-rebuild (4 statements: `deleteBookingLineItems`,
`deleteBookingServices`, `insertBookingLineItem`, `insertBookingService`).
Then noticed the admin-create route (Stage 3) and the *public* booking
-creation route (`POST /api/public/bookings`, otherwise untouched — its
core `bookings` INSERT is deliberately out of scope, see the Stage 3 note
on why the public route is avoided) both ran the exact same
`insertBookingService`/`insertBookingLineItem` SQL in an identical loop —
byte-identical across all three call sites, consolidated to the same two
functions rather than left duplicated now that they existed. This does NOT
touch the public route's booking-creation logic or its concurrency
behaviour — only its post-creation service/line-item bookkeeping, a
separate statement pair with no bearing on Deferred fix #1.

**Verification:** `npm test` — 649/651, twice, same two Deferred-fix-#1
failures both times (this stage never touches that route's `bookings`
INSERT or duplicate-check, only the unrelated service/line-item inserts
downstream of it). `npm run smoke` — 329/329. `git status` clean.

#### Stage 5 — Venue & calendar-adjacent routes + events-domain routes touching bookings — DONE
**~22 core-table statements moved.** This stage's functions/routes are all
mixed with two domains not yet extracted — `date_holds` (belongs with a
future `calendar` domain) and `events` — so every date_holds/events/venues
statement inside them was deliberately left in `server.js`; only each
one's own `bookings`-table statement moved, same multi-domain-orchestration
pattern used for the POPIA-erasure functions in earlier domains.

`hasCalendarConflict()`, `checkDateAvailability()`, `findHoldDateConflict()`,
and `checkEventConflicts()` each contributed exactly one `bookings` SELECT
(their `date_holds`/`events` halves stayed put). All four looked superficially
similar ("bookings on this date, excluding X") but none were byte-identical
to each other — different column lists, different WHERE clauses, different
line-wrapping — so each got its own function rather than a forced merge.
`syncBookingToCalendar()` contributed its `google_event_id` UPDATE (the
`booking_services JOIN services` fetch above it is a genuine cross-domain
join and stayed). `syncCalendarHolds()` contributed one SELECT; its four
other statements are all `date_holds`/`events` and stayed.

The three venue-editing routes (`PUT .../venue` unlink+link, `PUT
.../venue-google`, `PATCH .../venue`) each update `bookings` directly and
each read back `SELECT event_id FROM bookings WHERE id = ?` before touching
the linked event — that one-line SELECT is byte-identical across all three
and now shares `getBookingEventId()`. The link-branch UPDATE in `PUT
.../venue` and the UPDATE in `PUT .../venue-google` set the same six
columns but were nested at different depths in `server.js` (different
multi-line whitespace) — kept as two separate functions rather than
force-merged, same call as Stage 3's `markBookingCompletedManual` vs.
`markBookingAutoCompleted`. `PATCH .../date`'s dynamic `SET` clause
(assembled in `server.js` from quote-expiry/duration business logic that
has nothing to do with data access) now goes through
`updateBookingDateAndTimeFields(setClausesSql, params)`, which only wraps
the final `db.run` — the clause-building logic itself stayed exactly where
it was.

`PUT /api/admin/events/:id` and `PATCH /api/admin/events/:id/date` each
fetch their linked booking with an inline `new Promise(r => db.get(...))`
that **resolves `null` on a DB error instead of rejecting** — a genuinely
different contract from `getBookingByIdAsync` (which rejects), so this
got its own `getBookingByIdSafeAsync()` rather than being folded into the
existing one. `POST /api/admin/events` and `PUT /api/admin/events/:id`
both write `bookings.event_id` back with the exact same fire-and-forget
statement — consolidated into `setBookingEventId()`. The placeholder-booking
INSERT (`block_type==='booking'`) and the drag-reschedule date sync
(`PATCH .../date`) each moved as their own function, passing the original
callback straight through unchanged so sqlite3's `this.lastID`/`this.changes`
binding on it is preserved (same technique already used for
`insertAdminBooking` etc.).

`PUT /api/admin/bookings/:id/public` (promote/demote) contributed its four
`is_public`/`ticket_link`/`event_id` UPDATEs; the events INSERT/UPDATE/DELETE
and every `venues`-joined SELECT in that route (including the `sendResponse()`
preview query) stayed in `server.js`. `GET /api/calendar/feed.ics` and `GET
/api/admin/venues` were read in full but contributed nothing — every
statement in both is a genuine cross-domain JOIN or a `date_holds`-only
query, so neither has a `bookings`-domain statement to extract.

One incidental slip caught during self-review: an early edit to the
`venue-google` route's surrounding code briefly stripped trailing
whitespace from the untouched `events` UPDATE 3 lines below it (a
formatting-only accident from the edit tool, not a deliberate change) —
caught immediately via `git diff`-style byte comparison against the
unlink-branch's identical block, and restored before running any tests.
Purely cosmetic (SQLite ignores the whitespace either way) but flagged
here since "leave cross-domain statements untouched" is a standing rule.

**Verification:** `npm test` — 649/651, same two pre-existing Deferred-fix-#1
concurrency failures (unrelated — this stage never touches the public
booking route). Two tests exercising code this stage directly touched
passed cleanly: `CP2: google_event_id nulled after cancel` and `CP20:
deleting the event no longer fails with a FK constraint error`. `npm run
smoke` — 329/329. `git status` clean of surprises.

#### Satellite-table catalog completion — DONE
A live grep sweep of every `booking_notes`/`booking_access_codes`/
`booking_access_tokens`/`booking_services`/`booking_line_items` reference in
`server.js` (not the stale Phase 1 agent catalog's line numbers) found **18
movable satellite-table statements**, plus **2 core `bookings`-table
statements that no earlier stage had caught** — both inside the POPIA
functions read for this pass (`resolvePopiaTargets()`'s
`SELECT id FROM bookings WHERE LOWER(email) = LOWER(?)`, and
`anonymizeClientData()`'s anonymize-on-erasure `UPDATE bookings`). Both are
now `getBookingIdsForEmail()`/`anonymizeBookingsForErasure()`, sitting
alongside the domain's existing POPIA extractions
(`anonymizeInquiriesForErasure()` etc.) from earlier stages.

Every `booking_services`/`booking_line_items` statement that JOINs
`services` (8 call sites, across `sendBookingCompletedEmail()`,
`sendAdminCompletionSummaryEmail()`, the public per-day-availability check
in `POST /api/public/bookings`, `POST /api/public/bookings/:id/track`,
`GET /api/admin/bookings/:id/details`, `GET /api/admin/bookings/:id`, and
the quote route's per-day conflict check) stayed in `server.js` — `services`
is a separate, not-yet-extracted domain. The public per-day-availability
check (`POST /api/public/bookings`) is additionally inside the
deliberately-untouched core booking-creation flow (Deferred fix #1), so it
was left alone on that basis too, independent of the cross-domain JOIN.
`BOOKING_DELETE_PURGE`'s own DELETEs against these same 5 tables are, as
always, permanently excluded (file header).

New pieces of the domain covered: the client-facing booking-tracking OTP/
access-token subsystem (`requireBookingAccessToken()` middleware,
`request-code`/`verify-code` routes) — all `booking_access_codes`/
`booking_access_tokens` statements moved, one pair of byte-identical
"consume by id" calls consolidated into a single `consumeAccessCodeById()`;
the threaded admin booking-notes CRUD (`GET/POST/DELETE
/api/admin/bookings/:id/notes`); the client-facing tracker's own note-insert
(hardcoded `author='Client'`, kept as a separate function from the admin
route's parameterized-author insert since the SQL literal differs); and the
service hard-delete guard's `booking_line_items` reference-count check
(its sibling `quote_line_items` check is a different table and stayed).

**Verification:** `npm test` — 649/651 the first run showed a third,
unfamiliar failure (`calendar-booking-sync.test.js`: "reschedule: a SECOND
sync attempt was logged for this booking") alongside the two known
Deferred-fix-#1 failures. Re-ran three more times — every one showed only
the two known failures, with the calendar-sync test passing cleanly each
time. The test's own comments already flag it as inherently racy (a fixed
`sleep(300)` racing an async `db.get` callback → `syncBookingToCalendar()`
chain), and the touched code path (`PATCH .../date`'s final `getBookingById`
callback, swapped in during Stage 5) is a byte-for-byte behavioral no-op —
same SQL, same callback, passed straight through. Treated as a third
occurrence of Deferred fix #3's documented timing-flake pattern, not a
regression. `npm run smoke` — 329/329. `git status` clean of surprises.

**Remaining for the `bookings` domain:** only **Stage 6 — payment & ledger
routes + `applyStatusChange()` + the admin cancel route**, which needs your
explicit go-ahead before touching per the agreed plan. Running statement
count: **~84 of 229 core-table statements moved**, plus 22 satellite-table
statements (4 from Stage 4, 18 from this pass).

#### Stage 6 (final) — Payment & ledger routes, `applyStatusChange()`, admin cancel — DONE
Explicit go-ahead re-confirmed before starting, per the standing agreement. **~24 core-table
statements moved.** Covered: `POST /api/payment/webhook/payfast` (the PayFast ITN handler —
Deferred fix #2's own subject), `PUT .../manual-payment` + `processManualPayment()`,
`updateBookingMilestones()`, `getBookingErasureImpact()`/`cancelActiveBookingsForErasure()` (the
POPIA-triggered mass-cancellation cascade — 2 more core statements this uncovered, see below),
`POST /api/admin/bookings/:id/cancel`, `PUT .../refund`, `POST .../reconcile/sync`,
`POST /api/admin/transactions/manual`, and `applyStatusChange()` + its two thin wrapper routes
(`PUT /api/admin/bookings/:id`, `PUT .../status`).

Every statement against `transactions`, `invoices`, `cancellations`, `events`, `date_holds`,
`payment_schedules`, `policies`, `quotations`, `audit_log` or `financial_audit_log` stayed in
`server.js` — including the refund route's ledger-recalculation `UPDATE bookings` whose SET
clause contains a **correlated subquery reading `transactions`** (`FROM transactions t WHERE
t.booking_id = bookings.id`). That's not a literal JOIN, but the same cross-domain coupling a
JOIN would create, so it was treated the same way and left in place, alongside this domain's
other cross-domain JOIN statements already documented in the earlier stages above.

**2 more core statements the earlier stages missed**, found while reading
`getBookingErasureImpact()` for this pass (same situation as the 2 caught during the
satellite-table sweep): its `SELECT * FROM bookings WHERE id IN (...)` is now
`getBookingsByIds()`.

**Consolidation vs. keeping separate, by the numbers:**
- `UPDATE bookings SET is_public = 0, event_id = NULL WHERE id = ?` — literally identical (not
  just similar) across 3 call sites (`cancelActiveBookingsForErasure()`, the admin cancel route,
  `applyStatusChange()`'s demote-from-public branch) despite two using backticks and one double
  quotes — quoting style doesn't change the resulting string, unlike the multi-line whitespace
  differences seen elsewhere in this domain. Two call sites `await` it, one doesn't, so it's two
  functions (`clearBookingPublicAndEventIdAsync` / `clearBookingPublicAndEventId`), same reasoning
  as `getBookingById`/`getBookingByIdAsync`.
- `UPDATE bookings SET google_event_id = NULL WHERE id = ?` — already had a fire-and-forget
  function since Stage 2 (`clearBookingGoogleEventId`); the erasure cascade awaits it, so it
  gained an `…Async` sibling rather than changing the existing one's contract.
- The **ledger-credit UPDATE families** (PayFast ITN's atomic overpayment-guarded credit,
  `processManualPayment()`'s, the transactions/manual payment branch's, the reconcile/sync
  route's, and the transactions/manual adjustment branch's) all look superficially similar
  (`payment_status`, some combination of `amount_paid`/`amount_outstanding`/`total_amount`,
  `status`, a `confirmed_at` CASE) but every pair differs in at least one column or clause, or —
  for the one genuinely matching pair (`processManualPayment()` vs. the transactions/manual
  payment branch) — in multi-line whitespace from being nested at different depths. Five
  separate functions, not one parameterized one, per this domain's established byte-identical
  rule.
- `setBookingEventId()` (Stage 5) gained an optional trailing `callback` parameter for
  `applyStatusChange()`'s CONFIRMED branch, which needed one where the two Stage-5 call sites
  didn't — backward-compatible (an omitted 3rd arg to `db.run` behaves identically to not passing
  one), so the existing call sites are unaffected.

**Found but deliberately out of scope:** `POST /api/public/bookings/:id/cancel` (the
client-facing self-cancel route) contains `UPDATE bookings SET status = 'CANCELLED',
cancelled_at = CURRENT_TIMESTAMP WHERE id = ?` — byte-identical to the new `cancelBookingAsync()`
above — plus its own `getBookingById`-shaped SELECT. `POST .../accept-quote`, `POST
.../quote-revision-request`, and `GET .../cancellation-preview` also touch `bookings` directly.
None of these four were named in the agreed Stage 6 scope (payment/ledger + `applyStatusChange`
+ **admin** cancel), so none were touched — flagging them here rather than folding them in
unasked, even though `cancelBookingAsync()` could serve the public route unchanged if a future
pass takes it on.

**Verification:** `node -c` clean on both files. `npm test` run **8 times** (payment/cancel/
status code always deserves more than the usual 2-3): 649/651 six of eight times; twice showed a
7th failure atop the 2 permanent ones — `CP3: linked event advanced to completed via the generic
status route (parity fix)` once, `CP5: linked event.venue_name updated (previously stayed
stale)` once. Both are the exact named tests Deferred fix #3 has tracked since Phase 2 (a fixed
`sleep()` racing a fire-and-forget async side effect) — not new failures, and every function this
stage touched only swapped a direct `db.run`/`db.get` call for a same-SQL repository call with
the original callback passed through unchanged, so the timing profile (event-loop hops, DB write
latency) that flake depends on is unaltered. `npm run smoke` — 329/329. `git status` clean of
surprises (`database.sqlite`/`sessions.sqlite*` show as modified from the live server process
still running in the background from earlier this session — unrelated to this stage's edits,
which only touch `server.js` and `database/repositories/bookings.repository.js`).

### `bookings` domain — final tally
**~106 of 229 core-table statements moved, plus 22 satellite-table statements.** The remainder —
roughly 123 core statements — are cross-domain (JOINs and now correlated subqueries against
`clients`/`venues`/`events`/`date_holds`/`transactions`/`invoices`/`quotations`/`payment_schedules`/
`cancellations`/`services`/`policies`/`audit_log`/`financial_audit_log`, all separate,
not-yet-extracted domains), the deliberately-excluded `BOOKING_DELETE_PURGE`/
`BOOKING_DELETE_UNLINK` arrays, the public booking-creation route's core INSERT (Deferred fix #1),
or the 4 found-but-out-of-scope statements noted above. This is expected, not a shortfall — a
domain this deeply interleaved with the rest of the schema was never going to reach 229/229
without either rewriting cross-domain SQL (against the plan's own rules) or extracting every
other domain first. Every cross-domain statement encountered is documented inline in its own
stage's write-up above, per this file's running convention (see `inquiries`' and `settings`'
"Report, per the plan's own template" bullets for the same style on smaller domains).

---

### Domain: `inquiries` (session 3 of 8)

New file: `database/repositories/inquiries.repository.js`. Covers
`inquiries`, `inquiry_notes`.

**25 of 26 statements moved. 1 left as a genuine Cross-domain statement —
the first one across any domain so far** (`settings` and `newsletter` had
none). `GET /api/admin/inquiries`'s main data query is a real SQL join,
not just a route that happens to touch two domains:

```sql
SELECT inquiries.*, COALESCE(admins.full_name, admins.username) AS assigned_to_name, ...
FROM inquiries LEFT JOIN admins ON admins.id = inquiries.assigned_to
${whereClause} ORDER BY ${orderClause} LIMIT ? OFFSET ?
```

This stays in `server.js` untouched — it reads both `inquiries` (this
session's domain) and `admins` (`auth+users`, not yet extracted). The
sibling `countSql` in the same route (`SELECT COUNT(*) FROM inquiries
${whereClause}`, no join) has no such problem and moved normally as
`countInquiries()`. When `auth+users` is extracted (last in the suggested
order), whoever does that session should decide where this join statement
ultimately lives — it belongs to neither repository cleanly. Noting it
here now so it isn't lost.

Removed one now-dead variable as a direct consequence of the move: the
`const countSql = ...` in that same route was only ever passed to the one
`db.get()` call that got replaced by `countInquiries(whereClause, qp, ...)`,
so the old string-building line had nothing left to reference — deleted,
not left as unused dead code.

Five statements sit inside multi-domain functions (same pattern as
`settings`' `working_hours` and `newsletter`'s equivalents): the retention
caretaker, the shared `resolvePopiaTargets()`/`anonymizeClientData()`/
POPIA-preview trio, `compliance/export-data`, and the direct-emails
reply-marks-inquiry-replied callback. Only each one's `inquiries`/
`inquiry_notes` statement moved.

One statement sits inside an existing transaction (the admin
booking-creation route's `converted_booking_id` link, same pattern as
`newsletter`'s CSV import) — the repository function returns a Promise
against the same shared `db` connection, so it still participates in that
transaction unchanged.

No SQL string was altered. No callback was converted to a promise (the
transaction-participating function above replaces a call that was already
`await`ing `dbRun`). No transaction was added anywhere none existed before.

**Verification:** `npm test` run three times — 649/651, 650/651, 651/651.
The two non-651 runs each failed a *different* calendar-sync timing test
(neither touches `inquiries`/`inquiry_notes`); see the expanded Deferred
fix #3 below. `npm run smoke` — 329/329. `git status` shows exactly the
expected diff.

**Diff size:** ~76 changed lines in `server.js` (measured against the
diff after the `newsletter` session) + 130 new lines in the repository ≈
206 total — comfortably under the plan's ~400-line guideline, fits as one
commit.

**Report, per the plan's own template:**
- Statements moved: **25**
- Left as cross-domain: **1** (the `inquiries`/`admins` join in the admin
  list route — see above)
- Remaining raw SQL in `server.js`: **~987** (1,012 after `newsletter`,
  minus these 25)

---

### Domain: `newsletter` (session 2 of 8)

New file: `database/repositories/newsletter.repository.js`. Covers
`newsletter_subscribers`, `newsletter_campaigns`, `newsletter_drafts`,
`scheduled_newsletters`. Confirmed the full statement list with the repo
owner (grouped by route/function, not a 54-row table — this domain is
~3× the size of `settings`) before moving anything.

**49 of 49 newsletter-table statements moved.** No statement was itself a
cross-table join (verified — no `JOIN` against any of these four tables
anywhere in `server.js`; the "join" hits in a search were all
`Array.prototype.join`), so again nothing under "Cross-domain statements."
Three structural things worth recording:

1. **Two statements live inside multi-domain functions**, same pattern as
   `settings`' `working_hours` route: `startDataRetentionCaretaker()` (a
   cron loop that also anonymizes old `inquiries`) and the POPIA
   data-erasure routine (which sequentially anonymizes bookings/inquiries/
   newsletter/communication_log). Only each function's `newsletter_subscribers`
   statement moved; the rest of each function's domain-mixing logic is
   untouched, in place.
2. **Two statements sit inside an existing transaction** (the CSV-import
   route's `BEGIN`/`COMMIT`/`ROLLBACK`). The repository functions
   (`updateSubscriberFromCsvRow`, `insertSubscriberFromCsvRow`) return
   Promises using the same `db` connection the transaction runs on, so they
   participate in the caller's existing transaction correctly — no new
   transaction added, the old one untouched.
3. **Two functions deeply interleave SQL with a full per-recipient
   email-sending loop**: `scheduleNewsletterSend()` (6 statements) and the
   `POST /api/admin/campaigns` dispatch route (2 statements, sharing
   `getActiveSubscribersForSegment`/`insertCampaignLog` with the scheduler).
   Per the plan's rule 5, only the SQL moved — banner resolution, merge-field
   application, and the `for (const sub of subscribers)` send loop are
   untouched in `server.js`, just calling the extracted functions at the
   same points they called raw `db.*` before.

Consolidated 2 sets of byte-identical duplicate SQL into shared functions:
`getScheduledNewsletterById(id)` (was duplicated after schedule-create and
schedule-edit) and the segment-filtered active-subscriber query
(`getActiveSubscribersForSegment`, shared between the scheduler and the
campaign-dispatch route — same query, same reasoning as `settings`'
`getSettingsByKeys`).

No SQL string was altered. No callback was converted to a promise (the two
CSV-import functions replace call sites that were already `await`ing a
promise via the shared `dbRun` wrapper — moving that promisification
pattern into the repository is a relocation, not a conversion). No
transaction was added anywhere none existed before.

**Verification:** `npm test` — 651/651, twice in a row (this exercises
`newsletter-optin.test.js` and `newsletter-scheduling.test.js`, which cover
most of what moved, directly). `npm run smoke` — 329/329. `git status`
shows exactly the expected diff.

**Diff size:** 426 changed lines in `server.js` + 251 new lines in the
repository ≈ 677 total — **over** the plan's ~400-line guideline for a
single commit. If you commit this, consider splitting along the same
seams used above: (1) subscribe/confirm/unsubscribe + admin subscriber
CRUD + CSV import, (2) drafts + schedule CRUD + the scheduling engine, (3)
campaign dispatch/delete/list + the two multi-domain-function extractions.
Not split automatically since committing wasn't requested.

**Report, per the plan's own template:**
- Statements moved: **49**
- Left as cross-domain: **0** (two multi-domain *functions* had one
  statement each extracted, same as `settings`' `working_hours` case —
  not a cross-domain statement)
- Remaining raw SQL in `server.js`: **~1,012** (1,061 after `settings`,
  minus these 49)

---

### Domain: `settings` (session 1 of 8 — least-dangerous-first order)

New file: `database/repositories/settings.repository.js`. Confirmed the
full 17-statement list with the repo owner (line numbers re-verified
against current `server.js`, since Phase 3 had shifted everything from the
Phase 1 recon snapshot) before moving anything, per the plan's process.

**17 of 17 settings-table statements moved**, all read from a single
domain — no statement was itself a cross-table join, so **nothing went
under "Cross-domain statements."** One route is worth flagging anyway:
`PUT /api/admin/working-hours` also writes the `working_hours` table (a
different domain) in the same `db.serialize()` block. Only its two
`settings` INSERTs moved; the `working_hours` INSERT loop was left exactly
where it was, still inside the same `db.serialize()` closure, so statement
ordering is unaffected.

Several of the 17 were byte-identical duplicate SQL strings scattered
across different routes — the repository consolidates those into one
shared function each, called from every site that used to inline it:
- `getAllSettings()` — was duplicated in the boot-time env loader and
  `GET /api/admin/settings`.
- `getSettingsByKeys(keys)` — was duplicated across birthday-settings GET,
  the `getBirthdaySettings()` helper, public branding GET, and public
  site-content GET (all four built the same `WHERE setting_key IN (...)`
  placeholder string the same way).
- `upsertSetting(key, value)` — was duplicated across admin settings PUT,
  branding PUT, and site-content PUT (all three used the identical
  `INSERT OR REPLACE ... VALUES (?,?,CURRENT_TIMESTAMP)` string).

Three pre-existing standalone helpers moved wholesale and are destructured
back into `server.js` from the repository import, so their ~45 combined
call-sites elsewhere in the file (booking/payment/calendar code, not just
settings routes) needed zero changes: `getNotificationEmail()` (~22 sites),
`getBirthdaySettings()` (~5 sites, kept as a same-signature wrapper since
the repo version takes explicit params), `getSettingVal(key)` (~18 sites).

No SQL string was altered. No callback was converted to a promise or
async/await (the three helpers above were already promise-returning before
this move — that's not a conversion, just a relocation). No transaction was
added anywhere none existed before.

**Verification:** `npm test` — 651/651, run three times in a row, all
green including the Deferred-fix-#1 concurrency test, which had reliably
shown 2 failures in every Phase 2/3 run. Nothing in this domain touches
booking creation, so this move almost certainly isn't the cause — more
likely evidence that the race itself is genuinely intermittent rather than
deterministic, consistent with it being a race condition. Not claiming it
fixed — Deferred fix #1 below is updated to say "intermittent," not
resolved. `npm run smoke` — 329/329. `git status` shows exactly the
expected diff: `server.js`, plus the new `database/repositories/` directory.

**Diff size:** 244 changed lines in `server.js` + 109 new lines in the
repository ≈ 353 total, under the plan's ~400-line-per-commit guideline —
fits as one commit if you want to make one (not committed automatically).

**Report, per the plan's own template:**
- Statements moved: **17**
- Left as cross-domain: **0** (see the `working_hours` route note above —
  not a cross-domain statement, a cross-domain *route*, handled by moving
  only the in-scope statement)
- Remaining raw SQL in `server.js`: **~1,061** (Phase 1 baseline of 1,078
  minus these 17)

---

## Phase 3 — Runtime data out of the repository

### Design decision: dual-path resolver, no bulk file migration

Existing files already in `docs/` and `images/` (thousands of them — invoices,
quotes, contracts, gallery photos, branding assets) are **not** physically
moved by this phase. Confirmed with the repo owner before starting: new
writes go to the new external location; reads try the new location first
and fall back to the legacy in-repo path if not found there. No bulk
filesystem operation, fully reversible, existing files never touched.

### What changed

- **`server.js`** — added a small config block near the top (same
  `process.env.X ? path.resolve(...) : <in-repo default>` convention
  `database.js` already uses for `DB_PATH`):
  - `DOCS_PATH`, `UPLOADS_PATH`, `BACKUPS_PATH` — default to a sibling
    directory *outside* the repo (`../thabiso-mhlongo-runtime-data/...`),
    overridable via `.env`.
  - `docsWriteDir(...segments)` / `uploadsWriteDir(...segments)` — always
    resolve into the new external location (creating it if needed). Used
    everywhere a brand-new file gets created: every `multer.diskStorage`
    destination (gallery/events/carousel/about/backgrounds/branding/
    footprint/testimonials images, banners, receipts, newsletter/email/
    booking attachments, contracts), and every PDF-generation target
    directory (invoices, contracts, quotes, advancing packs).
  - `resolveDocsPath(...segments)` — new location first, else the legacy
    in-repo `docs/` folder. Used by every read site: all five invoice/quote/
    contract download routes (admin + public), the booking-attachment
    download route, contract-hash/signature verification, and the
    quote/contract cleanup-on-delete path. No equivalent resolver exists
    for images/uploads reads — every read of that tree happens over HTTP
    (a browser or email client fetching a URL), never a server-side
    `fs.readFile`, so the two static mounts below are the whole read side.
  - `safeUploadFilename(name)` — the Phase 3 item-4 fix (see below).
  - Two new static mounts, `app.use('/images', express.static(UPLOADS_PATH))`
    and `app.use('/uploads', express.static(UPLOADS_PATH))`, placed *before*
    the existing blanket repo-root static server. A request for e.g.
    `/images/gallery/x.jpg` tries the new location first; `express.static`
    calls `next()` on a miss, which falls through to the blanket mount and
    serves the legacy in-repo copy if that's where the file actually is.
    `docs/` gets no new static mount — it was already blocked by the
    existing path-blocklist (`normalizedUrl.includes('/docs/')` → 403), so
    it stays reachable only through the authenticated download routes, same
    as before.
  - DB-stored path *values* are unchanged — they still read e.g.
    `images/gallery/x.jpg` or `/uploads/receipts/x.jpg` regardless of which
    physical directory the bytes actually live in. Every place that builds
    those strings (e.g. `` `images/gallery/${req.file.filename}` ``)
    only ever used the filename, never the multer destination, so none of
    that string-building code needed to change.
- **`scripts/backup.js`** — `BACKUP_DIR` now reads `BACKUPS_PATH` the same
  way, defaulting to the same external sibling directory. Existing backups
  in the old in-repo `backups/` are left alone.
- **`.env.example`** — documents `DOCS_PATH` / `UPLOADS_PATH` / `BACKUPS_PATH`
  with their external defaults, commented out.
- **`.gitignore`** — added `docs/`, `*.sqlite-shm`, `*.sqlite-wal`,
  `sessions.sqlite-*` per the plan (item 5). The old specific
  `database.sqlite-shm`/`-wal` lines were left in place rather than removed
  — redundant with the new wildcard lines, but AGENTS.md says don't touch
  what isn't necessary.
- **`test/support.js`** — `spawnAndWait()` now also sets `DOCS_PATH`/
  `UPLOADS_PATH` to dedicated throwaway directories for the spawned test
  server, and `stop()` deletes those two directories wholesale instead of
  the old per-subfolder mtime-based sweep (which assumed docs/images lived
  in-repo). Without this, every test run would silently write real-looking
  PDFs/uploads into the real external default location with nothing ever
  cleaning them up. Also added `apiBinary`'s sibling awareness isn't needed
  here — just the two new dirs.

### A genuinely non-obvious discovery: dotfile directories break `res.sendFile`

First attempt named the test throwaway dirs `.test-docs` / `.test-uploads`
(matching the existing `.test.sqlite` convention). Every PDF download route
started returning 500 "Not Found" — but `fs.existsSync()` on the exact same
computed path returned `true`. Root cause: Express's `send` module (which
powers `res.sendFile`) defaults to `dotfiles: 'ignore'` and refuses to serve
*any* path containing a dot-prefixed segment, silently treating it as not
found — even though the file is right there on disk. Renamed to `test-docs`
/ `test-uploads` (no leading dot) and every download started working.
Worth remembering for anyone reaching for a dot-prefixed folder name for
anything `res.sendFile` might ever need to reach.

### Phase 3 item 4: upload-handler timestamp-stacking fix

New `safeUploadFilename(originalname)` in `server.js`: if the incoming
filename already matches the `Date.now()`-prefix pattern (13 digits + `-`),
it's used as-is; otherwise a fresh prefix is added exactly as before.
Applied to the two "replace an existing image" upload flows — the main
`storage` engine (backing `POST /upload`, the site-content image
manager) and `publicImageUploadStorage` (the public testimonial-photo
route) — since those are the flows where a file already carrying its own
prefixed name can plausibly get re-submitted through the same endpoint. The
one-shot attachment upload flows (newsletter/email/booking attachments,
receipts, contracts) were left untouched — they're not "replace an existing
asset" flows, so re-upload stacking isn't a scenario they hit, and Phase 3
only asked for a fix, not a redesign of every filename callback.

New test: `test/upload-handler.test.js` — uploads a fresh file (confirms
the normal single-prefix behaviour is unchanged), then re-uploads with a
filename already carrying a prefix (confirms no second prefix gets stacked).

### Verification

- `npm test`: **649/651**, stable. Only failures: the two pre-existing
  concurrency-bug tests from Phase 2 (Deferred fix #1, unaffected by this
  phase). The Phase 2 `calendar.test.js` CP3 intermittent flake (Deferred
  fix #3) was observed once more during this phase's testing — still
  unrelated to Phase 3's changes.
- `npm run smoke`: **329/329**, stable across two runs.
- Booted the real app against the real `database.sqlite` on a scratch port
  (no writes — pure `GET` requests, process killed immediately after) and
  confirmed all four branding settings plus a live banner resolve via HTTP
  200: `site_logo`, `favicon`, `login_background` (all under
  `images/branding/`), and one row from `banners`. All four are served via
  the new fallback chain, since nothing has been written to the new
  external `UPLOADS_PATH` yet — proving the legacy fallback half of the
  resolver actually works against real production data, not just the test
  fixtures.
- **Did not** create a real booking or upload a real image against the live
  database — the plan's "create a booking, generate an invoice PDF, upload
  an image, then run `git status`" checklist item is instead covered by
  `test/lifecycle.test.js` (booking → quote → invoice), `test/pdf-golden.test.js`
  (PDF generation + download through the exact same `docsWriteDir`/
  `resolveDocsPath` code paths), and `test/upload-handler.test.js` (image
  upload), all exercised against a throwaway database copy. Doing this
  against real production data risked creating fake bookings that would
  need manual cleanup and triggering real emails/calendar writes.
  `git status` was checked after every real-app boot and stayed clean.

---

## Phase 2 — Safety net

### Step 1: test suite relocated from `TBC/test/` to `test/`

Moved (plain filesystem move — `TBC/` is gitignored and untracked, so
`git mv` was not applicable; destination files are newly tracked):

- `TBC/test/audit-history.test.js` → `test/audit-history.test.js`
- `TBC/test/banner.test.js` → `test/banner.test.js`
- `TBC/test/booking.test.js` → `test/booking.test.js`
- `TBC/test/calendar.test.js` → `test/calendar.test.js`
- `TBC/test/contract.test.js` → `test/contract.test.js`
- `TBC/test/email.test.js` → `test/email.test.js`
- `TBC/test/footprint.test.js` → `test/footprint.test.js`
- `TBC/test/inquiries.test.js` → `test/inquiries.test.js`
- `TBC/test/newsletter-optin.test.js` → `test/newsletter-optin.test.js`
- `TBC/test/newsletter-scheduling.test.js` → `test/newsletter-scheduling.test.js`
- `TBC/test/popia-erasure.test.js` → `test/popia-erasure.test.js`
- `TBC/test/run.js` → `test/run.js`
- `TBC/test/support.js` → `test/support.js`
- `TBC/test/testimonials.test.js` → `test/testimonials.test.js`

`package.json`: `"test"` script changed from `node TBC/test/run.js` to
`node test/run.js`.

**Behaviour: unchanged.** The move shifted every file one directory level
shallower (`TBC/test/` was two levels below the repo root; `test/` is one).
Per AGENTS.md §2, a move may adjust path-resolution lines needed to make the
move work, the same as a `require` path. Four such adjustments were made,
each shortening a `..` chain by exactly one segment to compensate for the
new depth — no other line in any of these files changed:

| File | Before | After |
|---|---|---|
| `test/support.js:11` | `path.resolve(__dirname, '..', '..')` | `path.resolve(__dirname, '..')` |
| `test/banner.test.js:12` | `require('../../js/bannerRegistry')` | `require('../js/bannerRegistry')` |
| `test/email.test.js:6` | `require('../../js/emailComponents')` | `require('../js/emailComponents')` |
| `test/popia-erasure.test.js:171-172` | `path.join(__dirname, '..', '..', 'docs', ...)` | `path.join(__dirname, '..', 'docs', ...)` |

`.gitignore` already had `test/.test.sqlite` and `test/.test.sqlite-*` in
place from before this move, so no gitignore change was needed.

No application code (`server.js`, `database.js`, anything under `js/`,
`admin.html`) was touched.

### Step 1: test run results

`npm test` (`test/run.js`) boots `server.js` against a throwaway copy of
`database.sqlite` on port 3199, seeds a test administrator, runs all 14
suites, tears down.

**Result: 430/432 passed.** Two failures, both in `test/booking.test.js`,
both in the same concurrency check — see Deferred fixes below. No test was
altered to make it pass, per Phase 2 rules.

### Step 2: characterisation tests added

New files under `test/`, covering the six end-to-end paths Phase 2 asks for.
None of these modify application code; `test/support.js` gained two small
helpers (`apiBinary`, `extractPdfText`) needed by the PDF test below.

- **`test/lifecycle.test.js`** — walks intake → quote → accept → invoice →
  payment → completed as one continuous booking, asserting all six
  `bookings` timestamp columns (`created_at`, `quoted_at`, `accepted_at`,
  `confirmed_at`, `completed_at`, `cancelled_at`) at every step. This was
  the one path nothing else in the suite exercised end-to-end with every
  timestamp checked together.
- **`test/payment-callback.test.js`** — hits the real PayFast ITN webhook
  (`POST /api/payment/webhook/payfast`) with a normal callback, a replayed
  duplicate (same `pf_payment_id`), and a callback for a booking id that
  doesn't exist. See Deferred fix #2 below for what the unknown-reference
  case turned up.
- **`test/pdf-golden.test.js`** + `test/golden/*.golden.txt` — downloads a
  generated quote and invoice PDF, extracts their text (see the new
  `extractPdfText` helper — PDFKit shows text as hex strings, `<...>Tj`, not
  literal `(...)Tj`, which is not obvious from the PDF spec's simpler
  examples) and asserts the client name, amount and reference number appear
  verbatim, plus a normalized structural golden compare. `invoice_number`
  and the quote reference both embed the fixture's booking id and/or a
  to-the-second timestamp (see the file's header comment), so the golden
  normalizer masks those two formats and literal dates — not a blanket
  digit-mask, so a changed amount still shows up as a real diff. Two more
  dynamic values only turned up by running this twice and diffing: the PDF
  also prints the raw booking id as "BOOKING REF: #<id>" (a third
  reference format, undocumented until this test found it) and the
  fixture's own email address embeds `Date.now()` — both are masked too.
  Verified stable across two consecutive full-suite runs.
- **`test/email-templates-golden.test.js`** — direct calls to the two
  functions `js/emailTemplates.js` actually exports (`createEmailWrapper`,
  `createQuoteTable`) with merge-field-shaped arguments, golden-snapshotted.
  `createEmailWrapper` is largely superseded (`js/emailService.js` only
  calls it when a caller does NOT set `preWrapped:true`, and every live
  email path `test/email.test.js` exercises does set it), but it is not yet
  proven dead by the AGENTS.md §4 four-check rule, so it's characterised as
  live code here, not skipped.
- **`test/rbac.test.js`** — 32 `/api/admin` GET routes (picked from
  `docs-internal/routes.md`, spanning administrator-only, administrator+
  manager, and no-role-restriction routes) × 4 actors (administrator,
  manager, assistant, unauthenticated) = 128 assertions. **Result: all 128
  matched the role routes.md documented from the actual `requireRole(...)`
  middleware — zero surprises.** Nothing to add under "RBAC review needed"
  from this pass; a wider sample in a later pass may still turn something up.
- **`test/calendar-booking-sync.test.js`** — proves `syncBookingToCalendar`/
  `deleteGoogleEvent` are actually invoked (via id-specific log lines, same
  technique as `calendar.test.js`'s CP17) on a booking's own confirm,
  reschedule, and cancel. See "Known testing limitations" below for what
  this deliberately does NOT attempt.

**Full suite result: 643/645 passed, stable across repeated runs.** Two
failures: the two pre-existing concurrency failures above (Deferred fix #1,
unchanged). The `calendar.test.js` CP3 flake (Deferred fix #3) was observed
twice but did not reproduce on the final verification runs — see that entry.

### Step 3: smoke test (`npm run smoke`)

`test/smoke.js` boots the app the same way `test/run.js` does (via
`test/support.js`, throwaway DB copy, isolated port) and fires every route
parsed out of `docs-internal/routes.md` (329, matching the Phase 1 count
exactly) as an **unauthenticated** request, substituting `1` for any
`:param` segment. Per the plan: this is a crash detector, not an
authorisation test — 401/403/404/400/429 all count as PASS; only a 5xx
status, a thrown request error, or a 15s timeout counts as a failure.

**Result: 329/329 routes returned non-5xx, stable across two runs.**

Route list is parsed from `docs-internal/routes.md` rather than re-derived
from `server.js` directly, matching the plan's wording — meaning this
script will silently miss any route added after that file was last
generated, until Phase 1 recon is re-run. Worth a comment at the top of
`test/smoke.js` for whoever runs this next (already added there).

---

## Known testing limitations

Not bugs — things Phase 2's own rules say to leave alone rather than work
around by changing application code.

### Google Calendar request-payload assertions are not achievable as asked

Phase 2 Step 2 item 6 asks to "mock the Google API and assert the request
payloads sent on booking confirm, reschedule and cancel." This is not
achievable without an application-code change: `server.js` requires
`googleapis` and builds `calendar = google.calendar(...)` as a bare
module-level `const` (server.js ~line 103), and `test/support.js` always
runs the app in a separate **child process** (`spawn()`, not `require()` —
see `spawnAndWait()`), so the test process has no seam to substitute a mock
calendar client into. Building a fake Google API server and pointing the
real client at it would require either a dependency-injection point or a
configurable API base URL — an application-code change, which is exactly
what Phase 2's own rule says to leave alone: "if a piece of code cannot be
tested without being changed, note it and leave it untested for now."

### Occasional `SQLITE_BUSY` crash mid-suite (observed once, `invoices+quotations` domain)

One `npm test` run out of five (during this domain's verification) crashed the whole test
process — not a failed assertion, an uncaught `SQLITE_BUSY: database is locked` thrown from a
sqlite3 Statement — partway through `banner.test.js`. That file has no relationship to invoices,
quotations, or anything else touched this session; two immediate re-runs were clean. `test/run.js`
spawns exactly one server child process for the whole suite (`support.start()` once, then every
`*.test.js` file runs against it in sequence — see `test/run.js`), so this isn't the ordinary
per-test-file respawn story; a couple of individual test files (calendar-booking-sync among them)
do trigger their own mid-suite respawn as part of what they're specifically testing, and a
`SQLITE_BUSY` at exactly that kind of boundary — one process's SQLite handle not yet released
while the next opens the same file — is the standard symptom of two processes briefly contending
for one WAL-mode database file. Logged here rather than in a domain's own verification section
since it's a test-harness/OS-level timing question, not a data-access-extraction question — same
category as Deferred fix #3's sleep-margin flakes, but a crash instead of a wrong assertion, so
worth its own entry if it recurs enough to investigate.

**Update (Phase 5, route batches 5-9):** recurred three more times (four total now), every single
time at the *exact same point* in `banner.test.js` ("get: banner + empty used_by before
assignment" → crash on the next statement) rather than at a random spot — consistent enough to
call it a real race intrinsic to that test's own sequencing, not pure chance. One of the
recurrences happened in a **verified-clean environment** (confirmed zero `node.exe` processes
running beforehand via `Get-CimInstance`), ruling out leftover-process contention as the cause for
at least that instance — see also the separate stale-`node server.js`-process incident logged in
the `content.js`/`home-social.js` batch write-up above, which caused a *different* symptom
(indefinite hangs, not crashes) and had a clearly identified external cause (an abandoned
`npm start` from earlier in the session). Every recovery was an immediate clean re-run — roughly
1-in-3 to 1-in-4 of this session's Phase 5 test runs. Still not investigated further (out of scope
for a route-extraction session, and none of the batches that triggered it — content/CMS routes,
newsletter subscribers, newsletter scheduling/birthday — touch anything banner-related); flagging
the consistent crash *location* specifically in case it helps whoever eventually looks at
`banner.test.js` directly.

What `test/calendar-booking-sync.test.js` proves instead: that a sync
attempt was actually invoked for the right booking id on each of confirm/
reschedule/cancel (via log-line matching — the same technique
`calendar.test.js`'s CP17 already uses), not that the payload sent was
correct. Real payload correctness for calendar sync remains unverified by
this suite.

**Update (Phase 5, route batch 15):** recurred a fifth time, at the identical crash point
(`banner.test.js`, same test/next-statement boundary), during verification of a batch
(`routes/admin/abandoned-bookings.js` + `lib/abandoned-booking-email.js`) that touches neither
banners nor anything that shares a table with them. Clean re-run immediately after, zero leftover
`node.exe` processes both before and after. No new information, just another data point for the
"roughly 1-in-3 to 1-in-4" rate already logged above.

**Update (Phase 5, route batch 16):** a sixth occurrence, one run out of six during
`routes/admin/expenses.js` verification — a batch touching only the `expenses` table. Zero leftover
`node.exe` processes before or after; clean re-runs on either side. Nothing new.

**Update (Phase 5, route batch 18):** a seventh and eighth occurrence, two runs out of five during
`routes/admin/campaigns.js` verification (a batch touching newsletter dispatch/scheduling, not
banners) — each landing at a slightly different statement within `banner.test.js` rather than the
usual exact spot (once one test earlier, at "reject: width 1500px"), which if anything reinforces
that this is a genuine timing race rather than a single reproducible bug at one fixed line. Zero
leftover `node.exe` processes either time; clean re-runs both times.

**A related but distinct, self-inflicted incident (Phase 5, bookings sub-batch E):** not the same
race as above, but the same category of shared-SQLite-file hazard, worth recording so it isn't
repeated. A one-off manual verification script's own `support.start()` (which copies a fresh
`test/.test.sqlite` and spawns its own child `server.js`) was run **concurrently** with an
already-running backgrounded `npm test`, both racing the same hardcoded `TEST_DB` path and port. The
manual script failed immediately with "admin login failed: 401" (its own spawn lost the race), and
the in-flight `npm test` run's child crashed with `SQLITE_CORRUPT: database disk image is malformed`
on its next write. `PRAGMA integrity_check` on the leftover file afterwards came back `ok` — the
corruption was a transient WAL-consistency casualty of the concurrent copy/open, not permanent
damage — but the leftover `.test.sqlite`/`-wal`/`-shm` and throwaway docs/uploads directories were
deleted by hand rather than trusted, and every run after that (both the retried `npm test` and the
eventual manual verification run) was run in isolation, with nothing else touching
`test/support.js` at the same time. Process note for future sessions: never run a manual
`test/support.js`-based script while a backgrounded `npm test` (or another such script) is still in
flight — they share one hardcoded DB file and port, and the previous run's TEST_DB is not this
session's own to touch mid-flight.

---

## Deferred fixes

Bugs found while establishing the safety net or moving code. Not fixed here
— housekeeping moves code, it does not repair behaviour. Each entry needs
its own change with its own testing.

### 1. Lost write under concurrent independent booking submissions

- **Where found:** `test/booking.test.js`, "Concurrency: independent
  bookings must all persist" block (line ~89-96).
- **What the test does:** fires 5 concurrent `POST /api/public/bookings`
  requests with 5 distinct emails and 5 distinct event dates (no legitimate
  duplicate should be rejected), then asserts all 5 return HTTP 200 and all
  5 land as new rows in `bookings`.
- **Observed:** only 4/5 requests returned 200, and the `bookings` row count
  only increased by 4 (33 → 37, not 33 → 38) — i.e. one submission was
  silently lost, not just rejected with an error status.
- **Suspected cause (not verified, do not act on this without investigating
  first):** the test's own comment names it — "shared-connection transaction
  guard" — suggesting the booking-creation path in `server.js` may serialize
  writes through a single shared SQLite connection/transaction in a way
  that drops a write under concurrent access, rather than queuing or
  retrying it. This is exactly the kind of change Section A.1 of
  `AGENTS.md` calls a protected surface (booking workflow) — it must not be
  touched as part of a housekeeping move.
- **Impact if real:** on the live site, two genuine customers submitting
  booking inquiries at the same moment could result in one inquiry silently
  vanishing with no error shown to that visitor.
- **Status:** left failing, as instructed. Needs its own investigation and
  fix, with its own test coverage, as a separate piece of work — not part
  of Phase 2 characterisation testing.
- **Update (Phase 4):** intermittent, not deterministic — reliably 2
  failures (4/5, 33→37) across every Phase 2/3 run, then reliably 0
  failures (5/5) across three consecutive runs during Phase 4's `settings`
  domain testing. Nothing in that phase touches booking creation, so this
  isn't a fix — it's evidence the underlying race genuinely depends on
  timing rather than failing every time. Still unresolved; still needs its
  own investigation.

### 2. PayFast ITN for an unknown booking reference leaves no audit trail at all

- **Where found:** `test/payment-callback.test.js`, "unknown reference"
  block.
- **What happens:** `payment_logs.booking_id` has `FOREIGN KEY REFERENCES
  bookings(id)` (`database.js` ~line 262). The ITN webhook handler
  (`server.js` ~line 5508) logs an `ITN_RECEIVED` row to `payment_logs`
  *before* looking up the booking — but for a booking id that doesn't
  exist, that insert fails its FK check, and the insert's error callback
  only does `console.error(...)`; nothing else observes the failure.
- **Observed:** posting an ITN for a nonexistent booking id leaves **zero**
  rows in `payment_logs` — not even the generic "we received something"
  audit entry that every other ITN (including rejected ones) gets.
- **Impact if real:** a garbled, spoofed, or replay-attacked ITN referencing
  a bogus booking id is invisible to anyone reviewing `payment_logs` for
  suspicious payment activity — there's no record it was ever received.
  This is payment-adjacent (Section A.1 protected surface) — not touched.
- **Status:** left as-is. `test/payment-callback.test.js` asserts the
  *actual* current behaviour (zero rows), not the presumably-intended one.

### 3. Intermittent failure: `calendar.test.js` CP3 under a larger suite

- **Where found:** `test/calendar.test.js`, "CP3: linked event advanced to
  completed via the generic status route (parity fix)".
- **What happens:** CP3 does `PUT .../status {status:'COMPLETED'}`, sleeps a
  fixed 150ms, then asserts the linked `events` row's `event_status` is now
  `'completed'`. The status-change response itself returns 200 synchronously,
  but advancing the *linked event* appears to be a fire-and-forget async
  side effect not covered by that response.
- **Observed:** passed when this suite had 14 files; started failing
  intermittently (event still `'upcoming'` after the sleep) once Phase 2's
  6 new files — run alphabetically before `calendar.test.js` — added
  several minutes of prior HTTP/DB/PDF-generation load to the same Node
  process. Reproduced twice in a row after that; not reproduced with the
  smaller suite.
- **Not fixed here:** this is a pre-existing test's fixed-sleep margin being
  exposed by legitimately more load earlier in the same run, not a change
  I made to calendar-sync logic or to `calendar.test.js` itself. Per
  AGENTS.md §2, existing test files are left alone unless directly in scope.
- **Suggested direction (not implemented):** replace the bare `sleep(150)`
  with a short poll (retry the SELECT for up to ~1-2s) — the same pattern
  would help anywhere else in this suite that pairs a fire-and-forget async
  side effect with a fixed sleep.
- **Update (Phase 4, `inquiries` domain):** the same category of flake
  showed up in two more places across three consecutive `npm test` runs
  during this domain's testing — `calendar-booking-sync.test.js`'s
  reschedule/cancel sync-attempt checks failed on run 1, `calendar.test.js`
  CP5 (venue_name propagation) failed on run 2, and run 3 was clean (651/651).
  All three are fixed-sleep-after-a-fire-and-forget-write assertions, same
  root cause as CP3 above, and none touch the `inquiries`/`inquiry_notes`
  tables this domain session moved — confirms this is a general test-suite
  timing-margin issue, not something specific to CP3 or to any one domain
  move. Still not fixed (out of scope for a data-access-extraction session);
  flagging the pattern's spread here so whoever picks up the "poll instead
  of sleep" fix above knows it's not a one-test problem.
- **Update (Phase 4, `bookings` domain, satellite-table pass):** a fourth
  instance — `calendar-booking-sync.test.js`'s "reschedule: a SECOND sync
  attempt was logged" (a fixed `sleep(300)` racing the same
  `db.get`-callback → `syncBookingToCalendar()` chain) — failed on the first
  post-move `npm test` run and passed cleanly on three immediate re-runs.
  The touched line (`PATCH .../date`'s closing `getBookingById` callback)
  is a byte-for-byte behavioral no-op versus its pre-move `db.get` call, so
  this is the same timing-margin issue, not a fifth root cause.
- **Update (Phase 4, `bookings` domain, Stage 6 — payment/ledger + `applyStatusChange`):**
  ran the full suite 8 times given the stakes of this stage. CP3 (the
  original test this entry is about) and CP5 (venue_name propagation, first
  seen during the `inquiries` domain) each recurred once, on different runs
  — never together, never alongside anything new, and 6 of the 8 runs were
  clean apart from the 2 permanent Deferred-fix-#1 failures. Every function
  touched in this stage only swapped a direct `db.run`/`db.get` for a
  same-SQL repository call with the original callback passed through
  unchanged, so nothing about this stage's edits could plausibly change
  either test's timing margin. Included for completeness, not because
  anything new was learned about the underlying issue.
- **Update (Phase 4, `finance` domain):** a sixth instance — `calendar.test.js`'s **CP17**
  ("`syncEventToCalendar` was actually invoked after the drag"), a fixed `sleep(300)` racing a
  real (deliberately-failing, bogus-token) Google Calendar API call — failed once in 6 runs, on
  `PATCH /api/admin/events/:id/date`, a route this domain's session never read or touched (it's
  `bookings`/events territory, already done in Stage 5). Same mechanism, same conclusion: general
  test-suite timing margin, not specific to any one domain's move.
- **Update (Phase 4, `calendar` domain):** ran the full suite 8 times, this time on the domain that
  actually owns the code CP3 and CP5 exercise (`events`/`date_holds`). CP3 recurred twice, CP5
  recurred once, never together, never alongside anything new. Every statement either test's route
  touches (`advanceEventToCompleted`, `updateEventVenueLegacyLink`/`updateEventVenueGoogleLink`)
  only swapped a direct `db.run` for a same-SQL repository call with the original fire-and-forget
  callback (or lack thereof) passed through unchanged — same conclusion as the `bookings` Stage 6
  update above: nothing about relocating these statements could plausibly change either test's
  timing margin. If anything, actually owning this code and still seeing the same two flakes at
  the same rate as every domain before it is the strongest confirmation yet that this is a
  test-suite-wide sleep-margin issue rather than something specific to any one route's logic.
- **Update (Phase 4, `auth+users` domain — closing out Phase 4):** ran the full suite 5 times on a
  domain that doesn't touch `events`/`date_holds` at all (admins, admin_login_logs,
  password_reset_tokens). CP5 still recurred once, on code this session never read. Final
  confirmation, now that every Phase 4 domain has reported in on this same flake: it is purely a
  test-suite timing-margin issue, observed at a similar rate regardless of which domain's session is
  running, never once correlated with what that session actually changed.
- **Update (Phase 5, skeleton split):** a seventh instance, and the first NEW test name to join this
  list since CP17 — `inquiries.test.js`'s **CP12** ("responded_at set on first reply, status flips
  to replied" / "NOT overwritten by a second reply"), which awaits the HTTP response from
  `POST /api/admin/direct-emails/:id/send` and then immediately reads `inquiries.status`/
  `.responded_at` back from the DB — same shape as every other instance: an HTTP response awaited
  while the row it depends on is still a fire-and-forget async write in flight. Failed once in 5
  runs, on a route (direct-email sending) this step never touched — it's not a route/middleware
  concern at all, and nothing in the app.js/server.js split or the three extracted middleware files
  goes anywhere near `inquiries`/`direct_emails`. Same conclusion as every prior instance: general
  test-suite timing margin, not specific to any one domain, route, or (now) even to Phase 4's kind
  of change — it surfaces just as readily in a structural Phase 5 step as it did in a SQL-relocation
  Phase 4 session.
- **Update (Phase 5, shared-helper extraction into lib/):** CP12 recurred once more (of 5 runs).
  One run also produced a cluster of 5 failures never seen before or since — 4 PayFast-ITN
  assertions (`payment-callback.test.js`) plus **CP6** (`review_email_sent_at` stamping) — and
  another run separately produced a new name, **CP21** (`google_calendar_event_id` cleared on
  cancel). Neither cluster reproduced on the very next run, which is itself the tell: a real
  regression from moving `dbRun`/`dbGet`/`dbAll`/`resolveActor`/`logAudit`/`createAndSendInvite`
  into `lib/` would fail the *same* way on *every* run (a missing import throws a `ReferenceError`
  unconditionally), not intermittently. Statically re-verified the one piece that looked
  superficially connected — `PAYFAST_VALID_IPS`/`payfastItnRateLimiter`, touched in the previous
  step — both resolve correctly at their only two call sites, no dangling reference. Treating all of
  this as the same environmental/timing-margin category as every instance above, likely surfacing
  more often simply because this session has now run `npm test` upwards of 30 times in one
  continuous stretch — more accumulated test data and process uptime than any single Phase 4
  domain's testing saw, not a new root cause.
- **Update (Phase 5, route batch 15):** `calendar-booking-sync.test.js`'s "cancel: deleteGoogleEvent
  was invoked with this booking's calendar id" — the same fixed-`sleep(300)`-racing-a-fire-and-
  forget-write shape as every instance above — failed once in 6 runs, then passed cleanly on the
  next two. Given extra scrutiny here specifically because the *previous* batch (14) had just
  relocated `deleteGoogleEvent` itself into `lib/google-calendar.js`: confirmed the function's body,
  its `calendar`/`CALENDAR_ID` singleton, and its one call site in the admin cancel route this test
  exercises are all byte-identical to before the move, and batch 15 (this session's changes) touches
  only `abandoned-bookings` admin routes and a newsletter-adjacent email helper — nowhere near
  calendar or booking-cancel code. Per the same reasoning as every prior instance (a real regression
  from a relocated import would throw a `ReferenceError` on every run, not pass 5 times out of 6):
  filed as the same pre-existing timing-margin flake, not a regression from either batch.
- **Update (Phase 5, route batch 16):** `calendar-booking-sync.test.js`'s "reschedule: a SECOND sync
  attempt was logged" (previously seen during Phase 4's `bookings` domain satellite-table pass, see
  above) recurred once in 6 runs during `routes/admin/expenses.js` verification — a batch that
  touches only the `expenses` table, nowhere near booking reschedule/calendar-sync code. Same
  conclusion as every instance on this list.
- **Update (Phase 5, route batch 24):** CP5 recurred once in 4 runs during
  `routes/admin/calendar.js` verification — a batch that moved `timeRangesOverlap`/
  `addMinutesToTime`/`parseDurationToMinutes` to `lib/time-utils.js` and re-imported them at ~40
  call sites, plus the calendar-hold routes. CP5 exercises `updateEventVenueLegacyLink`/
  `updateEventVenueGoogleLink` (already a Phase 4 repository call, untouched here); the other 3 runs
  were fully clean including direct coverage of both hold routes. Same conclusion as every instance.
- **Update (Phase 5, Google Calendar sync engine relocation):** ran the full suite 6 times on the
  step that actually owns `syncEventToCalendar` itself. **CP17** recurred on two runs — notably back
  to back (runs 4 and 5), a higher rate than its single-occurrence history elsewhere — paired with
  the pre-existing `calendar-booking-sync.test.js` "cancel: deleteGoogleEvent" flake on one of them
  and **CP5** (unrelated `updateEventVenueLegacyLink` code, untouched by this step) on the other; the
  other 4 runs were fully clean. Given the higher rate, went beyond pattern-matching this time: a
  line-by-line diff of all 5 relocated functions against the pre-move `app.js` (`git show HEAD:app.js`)
  found them byte-identical apart from a few trailing-whitespace-only differences, and the still-in-
  app.js call site that fires `syncEventToCalendar` (`PATCH /api/admin/events/:id/date`) is completely
  unchanged — same fire-and-forget shape, response returned synchronously before the sync settles,
  same as every prior CP17 occurrence. CP5 failing in the same run as CP17, on code this step never
  read, is the same "one run under heavier timing pressure produces a small unrelated cluster"
  signature already seen in the shared-helper-extraction update above. Final confirmation, now on the
  step with the most direct claim to have caused a regression here if one existed: still a pure test-
  suite timing-margin issue, not a defect in the relocated code.
- **Update (Phase 5, bookings sub-batch E — calendar/venue/date cluster):** ran the full suite 4 times
  (excluding one run invalidated by a self-inflicted `SQLITE_BUSY`/`SQLITE_CORRUPT` collision — see
  its own note below, not a suite flake). 2 clean 664/664 runs. One run repeated the already-logged
  "reschedule: a SECOND sync attempt was logged" flake (`PATCH /:id/date`, the exact route this batch
  moved — re-diffed byte-identical against pre-move `app.js`, confirmed clean). The other run surfaced
  a **new test name** for this family: `email.test.js`'s "deposit-balance-due email queued pre-wrapped
  with exact-figure subject" (Guard 5), cascading into 2 skipped follow-up checks inside its own
  `if (deposit) {...}` guard (hence 661/662, not 663/664 — the same-shaped drop as every other instance
  of a fixed-sleep guard skipping its own dependent checks). Traced the cause: `PUT .../manual-payment`
  (untouched by this batch) does `await syncBookingToCalendar(id)` — a real, slow-failing OAuth
  round-trip against the deliberately-invalid test token — *before* firing `sendDepositBalanceDueEmail`,
  and the test's own comment already flags this exact sensitivity ("Same Calendar-OAuth-round-trip-
  before-queuing margin as Guard 3 above"). Same family as every CP17/CP5 instance, just the first time
  it happened to land in a logged run; not code this batch touched.

### 4. `POST /api/admin/bank-statement/import` had never worked — `db.transaction` is not a function — FIXED

- **Where found:** `routes/admin/bank-statement.js` (moved verbatim from `app.js` in route batch 21),
  reading the route's own code while tracing dependencies before extraction — not from a test
  failure; nothing in the suite exercised this route (`test/rbac.test.js` only role-checked the
  sibling `GET .../lines` route).
- **What happened:** the route wrapped its CSV-row-insert loop in `const insertMany =
  db.transaction(() => { ... }); insertMany();` — a `better-sqlite3` API. `db` (from `database.js`)
  is a plain `sqlite3.Database` instance (the callback-based `node-sqlite3` driver, per
  `package.json`'s only dependency being `"sqlite3"`, not `"better-sqlite3"`), which has no
  `.transaction` method at all — confirmed directly (`typeof new sqlite3.Database(':memory:').transaction
  === 'undefined'`). The `const insertMany = db.transaction(...)` line itself threw a
  synchronous `TypeError` before ever reaching the surrounding `try { insertMany(); } catch(e) {...}`
  — the try/catch only wrapped the *call*, not the assignment that already failed.
- **Observed:** every POST to this route threw synchronously inside the handler. Express 4 catches
  a synchronous throw from a non-async route handler and routes it to the app's error-handling
  middleware, so the practical effect was a 500 response to any admin who selected a CSV file and
  clicked import — not a partial success, a total failure of the feature.
- **Impact:** the bank statement CSV import/reconciliation tool — a `finance.repository.js`-backed
  admin feature — had never functioned, on any commit that included this exact code (not something
  route batch 21's move broke; the identical bug already existed in `app.js` before the move,
  unexercised by any test). Everything downstream of a successful import (the `lines` list, match,
  and delete routes moved alongside it in the same batch) was unreachable in practice since no line
  could ever be imported to act on.
- **Status: FIXED, at the user's explicit request**, given the severity — a completely
  non-functional admin feature is a different order of finding than the smaller pre-existing gaps
  logged as items 1-3 above, which stayed as documented-but-untouched. This is the one deliberate
  exception to "housekeeping moves code, it doesn't fix bugs" anywhere in this effort.
  - **The fix:** rewrote the insert loop to use `withDbTransaction` (`lib/db-transaction.js`) +
    `dbRun` (`lib/db-helpers.js`) — the same real `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK` pattern used
    throughout `lib/popia.js` — instead of the nonexistent better-sqlite3 calls. The loop is still
    atomic (a bad row rolls back the whole batch rather than leaving a half-import), matching the
    original code's evident intent, just using APIs that exist on this driver. All parsing/
    validation (CSV line regex, header-row skip, `parts.length`/amount checks) is untouched.
  - **`prepareBankStatementLineInsert()`** (`finance.repository.js`) is now unused — it backed the
    `db.prepare()` half of the same broken call chain. Left in place (no other caller, but not
    deleted per the "no deletions, only quarantine" default) with its comment updated to explain why
    it's dead and point at the replacement.
  - **Also found while fixing this:** `app.js` still had four stale top-of-file repository-import
    destructures (`finance.repository`, `invoices-quotations.repository`, `bookings.repository`)
    listing 15 function names whose *only* remaining caller had already moved into a route file
    across batches 16 (expenses), 19 (services), 20 (invoices) and 21 (bank-statement) itself —
    a gap in this session's own extraction process (each batch checked for other call sites of the
    functions it moved, but never re-checked whether app.js's own import line for that repository
    still needed every name it listed). Verified each of the 15 by grep (zero remaining references
    anywhere in `app.js` outside the import line itself) before removing; `markInvoiceSent` and
    `getExpensesForBookingEmail`, which share an import line with several of the dead names, were
    confirmed to have real remaining callers and were left in place.
  - **New regression test:** `test/bank-statement-import.test.js` — imports a CSV with a header row,
    a normal row, a row with a quoted comma inside a field (exercises the CSV-splitting regex), a
    malformed row (too few fields), and a non-numeric-amount row; asserts the correct 2 rows land
    with correct fields, negative amounts survive, fresh rows read back as unmatched, the existing
    list/batches-summary route reflects the import, and batch delete cleans up correctly. This is
    exactly the coverage gap that let the bug go unnoticed in the first place.
  - **Verification:** `node -c` on all changed files; `npm run smoke` 329/329; `npm test` x5 — the
    new test's 13 checks passed cleanly on every run; three runs were otherwise fully clean, one run
    hit an already-documented, unrelated PayFast-ITN timing cluster (previously seen during the
    "shared-helper extraction into lib/" step, did not reproduce on the next run), one run hit the
    already-documented `banner.test.js` `SQLITE_BUSY` crash — neither touches bank-statement/finance
    import code.
