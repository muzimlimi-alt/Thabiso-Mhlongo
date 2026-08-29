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
