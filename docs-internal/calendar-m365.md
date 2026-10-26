# Admin Calendar <-> Microsoft 365 (bookings@thabisomhlongo.com)

Status (2026-10-17): **Phases 1-9 built, all automated tests pass against a FAKE Microsoft Graph. The real Microsoft 365 tenant has NOT been exercised yet, so "two-way synchronisation" is built but is NOT claimed as verified - section 9 is the checklist that proves it live. The integration is switched OFF until an administrator switches it on.**
Everything below under "Audit" was read from the code, not observed on the live site; where that matters it says so.

---------------------------------------------------------------------------------------------------

## 1. Audit - how the calendar works today

### 1.1 Where calendar data lives (source of truth = the website database)

| Thing | Table / column | Notes |
|---|---|---|
| Bookings | `bookings` (`date`, `event_start_time`, `performance_end_time`, `performance_duration`, `status`, `google_event_id`, `event_id`) | Times are **wall-clock strings** in the business zone (no offset stored). |
| Public / standalone events | `events` (`event_datetime`, `event_start_time`, `event_end_time`, `event_status`, `booking_id`, `google_calendar_event_id`) | A **CONFIRMED booking auto-creates a shadow `events` row** (`booking_id` set). |
| Manual blocks / holds | `date_holds` (`hold_date`, `start_time`, `end_time`, `block_type`, `status`, `google_event_id`, `event_id`) | `block_type`: `unavailable/personal/travel/maintenance/hold/calendar_sync`. |
| Working hours | `working_hours` (per weekday) | Used by booking intake and the public slot picker. |
| Quotes / invoices / payments | `quotations`, `invoices`, `payment_schedules`, `transactions` | Reach the calendar only as read-only "milestone" markers (quote expiry, payment due). |

Booking status machine (`lib/booking-status.js`): NEW -> PENDING -> QUOTED -> ACCEPTED -> CONFIRMED -> COMPLETED, plus CANCELLED / EXPIRED.
Every status except CANCELLED and EXPIRED holds the date (`bookings.repository.js`). CONFIRMED creates the shadow event row. Cancel releases holds.

### 1.2 What the admin sees

* `admin.html` `#calendarAdmin` -> `js/admin/calendar.js` (FullCalendar 6.1.15 from jsDelivr), `css/admin/calendar.css`.
* One endpoint feeds it: `GET /api/admin/calendar/events` (`routes/admin/calendar.js`) = bookings (status != CANCELLED) + active holds + standalone public events (+ milestones when `?include=milestones`).
* Filters: four toggle buttons (Bookings / Holds / Events / Milestones) in `_calFilterState`, applied client-side.
* Interactions: click -> popup per type; drag a booking/hold/public event -> `PATCH` date endpoints with conflict checks; drag-select -> block-out modal; mini-calendar; "Upcoming" list; **Copy Feed URL** (ICS) and **Refresh**.
* Auth: every calendar route is `requireAdmin` (any admin role); `DELETE /api/admin/events/:id` is administrator-only. Roles: administrator / manager / assistant.

### 1.3 Existing integrations

**Google Calendar (the only calendar integration that exists).** `lib/google-calendar.js` (refresh token from env, calendar `primary`) and `lib/calendar-sync.js`:

* `syncBookingToCalendar(booking)` - create-or-update one Google event per booking, id stored in `bookings.google_event_id`. Called from ~30 places (admin and public booking routes, payment processing, status changes, event reschedule), always **fire-and-forget**; failure returns `null`, nothing is recorded or retried.
* `syncEventToCalendar(eventId)` - same for `events` (`[PUBLIC] title`, fixed 2 h length).
* `deleteGoogleEvent(id)` - on cancel / quote expiry / self-cancel / POPIA erasure; errors swallowed; the local id is cleared even when the delete failed.
* `syncCalendarHolds()` - every 15 min (`lib/background-clerk.js`): lists the **next 90 days** of the primary calendar and mirrors every foreign Google event as a `date_holds` row (`block_type='calendar_sync'`), deleting mirrors that vanished.
* `hasCalendarConflict` - checks holds, bookings (with buffers) and Google free/busy.

**Microsoft 365 (already built by this project, mail only).** SMTP + OAuth client-credentials (`lib/smtp-oauth.js`, `lib/smtp-config.js`), Graph mailbox client (`lib/m365-graph.js`, GET-only, pinned to `/users/<bookings@>`), inbox sync (`lib/inbox-sync.js`, `routes/admin/inbox-sync.js`, `inbox_sync_state`), fake Graph for tests (`test/fake-graph.js`). **There is no Microsoft calendar code.** Exchange RBAC for Applications currently grants `Application Mail.Read` (scope "Website mailbox only", `Alias -eq 'bookings'`); no Calendars role has been granted.

**Other outbound calendar surfaces:** the token-protected ICS feed `GET /api/calendar/feed.ics` (bookings ACCEPTED/CONFIRMED/COMPLETED + all active holds) and `.ics` invitation attachments on client emails (`lib/booking-notifications.js`).

### 1.4 Findings that matter for the integration

1. **Do bookings create duplicate events today? Yes, in two ways (from code; not reproduced live).**
   * *Booking + shadow event.* `syncEventToCalendar` has no `booking_id` guard. A CONFIRMED booking therefore gets `[CONFIRMED] ...` from `syncBookingToCalendar` **and** `[PUBLIC] ...` as soon as its shadow event is saved or dragged (`routes/admin/events.js` PUT and `PATCH /:id/date` both call it). The code comment at events.js:371 acknowledges these are two separate Google entries.
   * *Insert race.* `syncBookingToCalendar` inserts whenever the booking object it was handed has no `google_event_id`. Callers often hold an older copy of the row, so two close calls can both insert; the second id overwrites the first, which is orphaned on Google.
2. **No sync state anywhere.** No status, last-success time, error, retry or queue. A Google outage silently loses the update. `isCalSynced` in the calendar API is **always false** (the query never selects `google_event_id`).
3. **Over-publishing.** Every non-cancelled booking - including NEW / PENDING / QUOTED - is pushed to Google with client email, phone and notes in the description. The ICS feed (the existing "what may appear in an external calendar" rule) is stricter: ACCEPTED / CONFIRMED / COMPLETED only.
4. **Time handling.** The server pins `moment.tz.setDefault('Africa/Johannesburg')` (app.js:144) and hard-codes the zone string in sync code; there is no setting. A booking without a start time is pushed to Google as a timed event at 18:00 (an all-day booking silently becomes a timed one). South Africa has no DST (UTC+2 all year), so offsets are stable, but the code must not rely on the host's TZ (Render runs UTC).
5. **Inbound Google mirrors are raw and lossy.** The event summary is stored un-encoded in `date_holds.notes`; multi-day all-day events only block their first day; the window is 90 days. `renderWorkingSchedule()` writes `ev.title` into `innerHTML` **unescaped**, so an externally-controlled calendar title is a script-injection vector for an admin. (Fix planned in Phase 5 because Microsoft titles would flow through the same path.)
6. **Loop / echo risks if a second calendar is added.** The ICS feed publishes `calendar_sync` holds, so anything mirrored from outside is echoed back out to subscribers. Subscribing the M365 calendar to the ICS feed **and** pushing via Graph would duplicate every event.
7. **Date holds drive public availability.** Anything that should block public booking must exist as an active `date_holds` row (or a booking). That is the lowest-risk way for Microsoft events to block dates.
8. **Stored-text convention.** Database text is entity-encoded once; plain-text sinks (calendar bodies, subjects) must decode (`decodeStoredText`). Incoming Microsoft text is stored encoded and decoded again on the way out.

---------------------------------------------------------------------------------------------------

## 2. Integration plan

### 2.1 Responsibilities (the owner's design, adopted)

| | Website database | Microsoft 365 calendar |
|---|---|---|
| Booking status, quotes, invoices, payments, client data | **authoritative, never written from a calendar change** | not stored (only a short title, time, place and a link back) |
| When / where an eligible engagement happens | authoritative for booking-linked events | shared view; edits are **detected and flagged**, not applied silently |
| Other people's appointments | read-only copy | authoritative |

### 2.2 Design decisions (defaults; each is reversible)

* **Additive and off by default.** The Google sync is **not touched**. Microsoft sync sits behind a switch (`calendar_sync_state.enabled`, default off) that can only be turned on after a live access check - same pattern as the inbox sync. With the switch off the site behaves exactly as today.
* **Which items are published** (reuses the ICS-feed rule, not Google's): booking **ACCEPTED -> tentative**, **CONFIRMED -> busy**; COMPLETED keeps an existing event unchanged; **NEW / PENDING / QUOTED never**; **CANCELLED / EXPIRED -> the event is removed**. Standalone public events (`booking_id IS NULL`) with status upcoming / live / sold_out are published; draft / cancelled / postponed / completed are not. Booking shadow events are **never** published separately (this removes the duplicate described in 1.4.1 for Microsoft). Manual holds are not published.
* **Privacy:** the Microsoft event carries title, time, venue and an admin deep link only - no client email, phone or notes. No attendees, so Microsoft never emails the client (the existing invitation emails stay the only client-facing invite).
* **Identity:** a provider-neutral link table `calendar_links` (source type + id <-> Graph event id) is the only mapping. Creates are idempotent (link row + token written *before* the POST, Graph `transactionId` = token), so a retry after a crash cannot duplicate.
* **Website -> Microsoft** is *desired-state reconciliation*: compare a hash of what the event should look like with what was last sent; create / patch / delete accordingly. This catches every change without editing the ~30 existing call sites; a debounced "nudge" from the central booking-status and calendar-sync functions makes it near-immediate, and a periodic pass is the safety net.
* **Microsoft -> website** uses Graph `calendarView/delta` over a rolling window (past 30 days to next 365), polled (no webhooks: they need a public HTTPS endpoint and renewals - not justified here). Recurring series arrive expanded and read-only.
  * Event is **ours** (in `calendar_links`): unchanged change-key = our own write (ignored, this is the loop break); changed = **conflict** (flagged, nothing overwritten); deleted = **externally deleted** (flagged, never auto-recreated, the booking is never deleted).
  * Event is **foreign**: cached in `calendar_external_events`; Busy / Out-of-office events also create an `m365_sync` hold so the public form cannot double-book that time. Free / tentative / working-elsewhere events are shown but do not block. Foreign events are never pushed back.
* **Conflict policy:** website wins by default but never silently. An external edit marks the link `conflict`; an administrator chooses "Keep website version" (re-push) or "Use the Microsoft 365 time" (goes through the existing booking/event date-change path with its conflict check and client notice). Financial and booking records are never changed by the sync itself.
* **Auth:** reuse the existing app registration, secret and token cache (`lib/smtp-oauth.js`); no second auth system. Least privilege = Exchange RBAC role **`Application Calendars.ReadWrite`** on the same management scope "Website mailbox only" (no tenant-wide Entra `Calendars.ReadWrite`).
* **Time zone:** events are written in the business zone using the wall-clock strings the site already stores (never converted through the host's TZ); no-time bookings become **all-day** events. Business zone is one named constant, verified at start-up and in tests (UTC+2, no DST). `Prefer: outlook.timezone` makes Graph return times in the same zone.
* **Reliability:** `calendar_links` doubles as the recoverable queue (`pending` / `error` rows with exponential back-off and `next_attempt_at`); systemic failures (auth / permission) pause the whole run and surface in the UI; `calendar_sync_log` records every attempt (who / what / outcome, redacted) with 90-day retention.
* **Honesty rule:** "two-way" is only claimed after a change made in each system has been observed arriving in the other. Until the Exchange role is granted and the live tenant tested, results are against a fake Graph server and are labelled as such.

### 2.3 Phases and what each one proves

| Phase | Deliverable | Verified by |
|---|---|---|
| 2 | Graph client gains POST / PATCH / DELETE (still mailbox-pinned, retry/throttle aware); calendar access diagnostic; settings test button; Entra / Exchange setup doc | fake-Graph tests: 401/403/404/429/5xx/network/token-revoked paths, no secret in any message |
| 3 | Schema (`calendar_sync_state`, `calendar_links`, `calendar_external_events`, `calendar_sync_log`, `date_holds.m365_event_id`); push + pull engine; loop prevention; conflicts; delta + resync | engine tests against fake Graph incl. both directions, repeated runs, crash-before-link-write |
| 4 | Eligibility + status mapping wired to the real booking lifecycle (nudges); no-duplicate guarantees | lifecycle tests: confirm / reschedule / cancel / reject / partial failure / retry |
| 5 | Admin UX: source + sync indicators, status strip, filters, per-event sync panel (retry, error text, open in Outlook, resolve conflict), settings card; escape fix | browser test (Puppeteer) at desktop + phone width |
| 6 | Time-zone / all-day / recurrence / availability rules | unit tests (zone, edge dates, all-day end-exclusive), availability regression |
| 7 | RBAC, validation, audit, redaction, retention | rbac + audit tests |
| 8 | Full regression (`npm test` baseline 1096/1096, browser suite) | results recorded below |
| 9 | Handover doc + final report | this file |

### 2.4 Owner actions that code cannot do

1. In Exchange Online PowerShell (same session pattern as the Mail.Read grant): `New-ManagementRoleAssignment -App <service principal> -Role "Application Calendars.ReadWrite" -CustomResourceScope "Website mailbox only"` (exact command and the 30 min - 2 h cache delay are documented in Phase 2).
2. Make sure the Microsoft 365 calendar named in Settings is the one the team actually uses, and **do not** also subscribe it to the website ICS feed.
3. After Phase 3: switch the sync on in Admin -> Calendar -> Details -> "Switch sharing on" (it refuses until the live check passes).

Open questions for the owner (defaults above stand until answered): keep the Google sync running alongside, or retire it once Microsoft sync is proven; whether ACCEPTED (client accepted, deposit pending) should appear as tentative.

---------------------------------------------------------------------------------------------------

## 3. Phase 2 - Microsoft 365 sign-in, permissions and the Graph client (built 2026-10-17)

### 3.1 Decisions

* **Designated account / calendar:** `bookings@thabisomhlongo.com` (the same mailbox that sends and receives the site's mail; its address is the SMTP user in
  Admin -> System -> Email Setup). The calendar used is that mailbox's **default calendar**.
* **OAuth flow:** OAuth 2.0 **client credentials** (app-only), because the sync runs in the background with nobody signed in. A delegated flow would need a person's
  refresh token that expires or is revoked with their password/MFA. This reuses the existing app registration, tenant id, application id and client secret and the
  existing token cache (`lib/smtp-oauth.js`, token audience `https://graph.microsoft.com/.default`). **No second auth system was added.**
* **Least privilege:** Exchange **RBAC for Applications**, role `Application Calendars.ReadWrite`, limited to the management scope "Website mailbox only" (just `bookings@`).
  Do **not** add `Calendars.ReadWrite` under *API permissions* in Entra ID: that is tenant-wide (every mailbox) and would cancel the scoping.
* **Secrets:** server-side only (the settings table / environment). The browser never receives the secret; every message the client produces is passed through a redactor
  (secret, bearer tokens, JWTs) and Microsoft's error bodies are never copied into results or logs.

### 3.2 What changed in code

* `lib/m365-graph.js` - new `graphRequest()` (GET / POST / PATCH / DELETE, JSON body, still pinned to `/users/<bookings@>`); `graphGet()` is now a thin wrapper with its old signature.
  New error category `notfound` (event-level 404, not systemic); the 403 text names the **calendar** role when the caller says `resource:'calendar'`.
  New `diagnoseCalendar()`: sign-in -> read the calendar -> write probe (create one invisible free event dated 2001, then delete it). The probe is the only proof that
  write permission is really in force; nothing else is created, nobody is invited or notified.
* **Retry rules for writes:** 429 is always retried (Microsoft did not process it); PATCH / DELETE are retried on 5xx / network (repeating them is harmless); a **POST is
  retried only when the caller marks it idempotent** (it sends a Graph `transactionId`, so a repeat returns the same event instead of creating a second). A POST whose answer
  was lost and which is not idempotent is **not** repeated and comes back flagged `unconfirmed`.
* **Bug found and fixed in the inbox sync (committed earlier, never run against the real service):** Graph writes its own `@odata.nextLink` / `deltaLink` as
  `/users('<id>')/mailFolders('<id>')/...`, not `/users/<address>/...`, so the old "link must be inside the same mailbox path" check would have refused every real link after
  the first page. Links are now followed by taking **only their query string** (the checkpoint tokens) and rebuilding the request on the pinned mailbox path, after checking
  the link points at Graph itself (same scheme and host, no embedded credentials). A tampered link can still never steer a call to another mailbox or host.
* `POST /api/admin/calendar-sync/test` (administrator only; `routes/admin/calendar-sync.js`) runs `diagnoseCalendar()` against the **saved** settings.
* `test/fake-graph.js` now also fakes the calendar (events with `transactionId` de-duplication, PATCH, DELETE, `calendarView/delta` with paging, `deltaLink`, `@removed`,
  write-only 403, lost-answer modes) with real-shaped links; `test/calendar-graph.test.js` has 37 checks, `test/graph.test.js` was updated for the link rule.

### 3.3 Owner steps (Exchange Online PowerShell, Global or Exchange administrator)

The "Website mailbox only" scope and the service-principal pointer already exist from the inbox set-up. Add the calendar role to the same app and scope:

```powershell
Connect-ExchangeOnline
New-ManagementRoleAssignment -Name "Website app edits bookings calendar" -App <enterprise-app-object-id> `
    -Role "Application Calendars.ReadWrite" -CustomResourceScope "Website mailbox only"
Test-ServicePrincipalAuthorization -Identity <enterprise-app-object-id> -Resource bookings@thabisomhlongo.com    # the Calendars.ReadWrite line should show InScope True
```

Changes can take 30 minutes to 2 hours to apply (Exchange's permission cache; `Test-ServicePrincipalAuthorization` bypasses it). If the scoped grant does not take effect in your
tenant, the documented alternative is Entra `Calendars.ReadWrite` (application) + admin consent restricted with an *Application Access Policy* to a mail-enabled security
group containing only `bookings@` (same pattern as the note in `contact-inquiries-m365.md` section 2.4).

### 3.4 What happens when something is wrong (all verified against the fake)

| Situation | What the client reports | What an administrator sees / does |
|---|---|---|
| Client secret expired / wrong | category `auth`, systemic, Microsoft's AADSTS code, no secret | sync pauses; save a new secret in Email (SMTP) settings |
| Token expired or revoked mid-run | one fresh token is requested and the call repeated once; if rejected again -> `auth`, systemic | as above |
| Role not granted / consent revoked / not yet propagated | `permission`, systemic, names `Application Calendars.ReadWrite` | grant the role (3.3), wait up to 2 h, press *Test calendar access* |
| Read works, write does not (read-only role) | `write` step fails with the same role name | grant ReadWrite, not Read |
| Throttled (429) | waits `Retry-After` (capped at 30 s), up to 4 attempts, then `throttled` (retryable) | nothing; the next run retries later |
| Microsoft down (5xx) / network drop | bounded retries for GET / PATCH / DELETE; a POST is not blindly repeated | nothing; the queued change is retried with back-off |
| Answer to a create is lost | idempotent create is repeated and returns the same event; otherwise flagged `unconfirmed` | nothing |
| Event no longer exists (deleted in Outlook) | `notfound`, not systemic | shown on the event as "removed in Microsoft 365" |
| Checkpoint expired (410) | `resync` | the next run re-reads the window; nothing is lost |

Verification status: **fake Graph only.** The real tenant has not been exercised for the calendar; the first live proof is the *Test calendar access* result after the role is granted.

---------------------------------------------------------------------------------------------------

## 4. How the sync works (Phases 3-4)

### 4.1 Pieces

| File | Role |
|---|---|
| `lib/calendar-m365-model.js` | Pure rules, no database / network: what is published, how an entry looks, time handling, reading a Microsoft event back, recognising a change, which days a foreign event blocks. |
| `lib/calendar-m365.js` | The engine: state, run (pull then push), link table as queue, conflicts, retries, status, administrator actions, data for the calendar screen. |
| `lib/m365-graph.js` | Graph transport (Phase 2). |
| `lib/booking-reschedule.js` | The booking date-change rules, extracted unchanged from `PATCH /api/admin/bookings/:id/date` so "use the Microsoft 365 time" applies the same checks. |
| `routes/admin/calendar-sync.js` | HTTP controls (roles below). Mounted by `routes/admin/calendar.js`. |
| `lib/background-clerk.js` | Calls `runIfDue()` every minute (a no-op while switched off; a run happens at most every 2 minutes). |
| `lib/calendar-sync.js`, `lib/google-calendar.js` | One-line, never-failing "something changed" nudges (`requestSync`) added to `syncBookingToCalendar`, `syncEventToCalendar` and `deleteGoogleEvent`, which every create / edit / status change / reschedule / payment / cancellation already calls. No call site was edited. |
| `js/admin/calendar-m365.js`, `css/admin/calendar.css`, `admin.html` | The admin calendar screen additions (Phase 5). |

### 4.2 Tables (migration 105, created automatically at start-up)

* `calendar_sync_state` - one row: on/off switch (**off by default**), checkpoint (server-side only), window, last run / success / error, failure count, back-off, last stats.
* `calendar_links` - the ONLY mapping between a website record and its Microsoft event, and the recoverable queue: `source_type` (booking / event), `source_id`, `graph_event_id`, `create_token` (= the Graph `transactionId`), `sync_status` (pending / synced / error / conflict / external_deleted / removed), what was last sent (hash + comparable JSON), change key, attempts, `next_attempt_at`, last error, conflict snapshot, timestamps, who acted. Unique per record and per Microsoft event.
* `calendar_external_events` - other people's appointments, read-only (text stored entity-encoded once).
* `calendar_sync_log` - every attempt and decision (who / what / outcome / redacted reason), kept 90 days.
* `date_holds.m365_event_id` (+ unique index per event and day) - the hold that lets a Busy / Out-of-office Outlook appointment block the public booking form (`block_type = 'm365_sync'`).

No table has a foreign key to `bookings` or `events`, so the sync can never block or cascade a delete of a website record.

### 4.3 What is published (website -> Microsoft)

| Website record | Microsoft 365 |
|---|---|
| Booking **CONFIRMED** | one event, shown as **busy** |
| Booking **ACCEPTED** | one event, shown as **tentative**, title prefixed `[Tentative]` |
| Booking NEW / PENDING / REVIEWED / QUOTED | **never** published (enquiries) |
| Booking COMPLETED | an existing event is left as it is; none is created |
| Booking CANCELLED / EXPIRED / erased | the event is **removed** (the booking is never touched) |
| Public event upcoming / live / sold_out (not tied to a booking) | one busy event |
| The shadow `events` row a confirmed booking creates | **never** published (the booking's own event represents it - this is what prevents the booking + shadow-event duplicate the Google sync has) |
| Draft / cancelled / postponed events, manual holds, milestones | not published |

The entry carries the title (`event - client`), time, venue, the category **Website**, a short note and a link back to the admin. It **never** carries the client's e-mail, phone number or notes, and has **no attendees** (Microsoft never e-mails anybody; the existing invitation e-mails remain the only client-facing invite). Only bookings dated within 7 days of today (or already linked) are considered, so history is not back-filled.

### 4.4 The run (every ~2 minutes, and a few seconds after a change)

1. **Pull first** (`calendarView/delta` over past 30 days .. next 365 days, `Prefer: outlook.timezone="South Africa Standard Time"`): a saved checkpoint is followed incrementally; once a day (or after Microsoft drops the checkpoint, HTTP 410) the window is read afresh and anything missing is tidied (a full read that runs out of its page budget resumes next run and never sweeps).
   * an event we published, unchanged -> nothing; our own write coming back is recognised by its change key, or - when Exchange re-stamps the key - by identical title / time / place / availability (**no false conflict, no loop**);
   * an event we published, **changed in Outlook** -> link becomes `conflict`, the Outlook version is stored for the screen, **nothing is overwritten on either side**;
   * an event we published, **deleted in Outlook** -> `external_deleted`; **not re-created** unless an administrator or manager asks; the booking is untouched;
   * anybody else's appointment -> mirrored read-only; if **Busy / Out of office** it also holds the date (the exact days / hours) for the public form. Free, tentative and working-elsewhere appointments are shown but do not block. Recurring series arrive as read-only occurrences. Cancelled or unreadable events are skipped (counted).
2. **Push**: for every eligible record the desired entry is recomputed from the database and compared (hash) with what was last sent: create / update in place / remove. At most 60 writes per run (the rest are queued, nothing is lost). A record in `conflict` or `external_deleted` is **not** pushed over.
3. A failure on one record is recorded on that record (attempts, plain reason, next try 1 min -> 5 min -> 15 min -> 1 h -> 6 h) and the run continues. A sign-in / permission failure (`systemic`) stops the run, is shown in the screen, and backs off 15 minutes. If the calendar cannot be read, **nothing is pushed** (an Outlook edit must be seen before the website writes).

### 4.5 No duplicates, no loops (how, and how it is tested)

* The link row and a random `create_token` are written **before** the create; the token is Graph's `transactionId`, so a retry after a crash, a timeout or a lost answer returns the same event. A create whose answer was lost and which cannot be proven idempotent is never repeated blindly (`unconfirmed`).
* One link per record (unique), one Microsoft id per link (unique).
* Pulled data never feeds the push (only database rows do); foreign events are never sent back; mirror holds are not publishable.
* The ICS feed excludes the mirrored Outlook appointments (they would leak colleagues' slots and echo back if subscribed).

### 4.6 Conflict rules (the website database stays authoritative)

| Situation | What happens |
|---|---|
| Booking status, quote, invoice, payment, client data | Never written from a calendar change. Verified: the booking row is byte-identical after publish / conflict / deletion. |
| Outlook edit of title / time / place / availability of a published entry | Flagged `conflict`. A **manager or administrator** chooses: **Keep website version** (re-sent; overwrites the Outlook edit on purpose, asks for confirmation) or **Use Microsoft 365 time** (bookings only: goes through the normal date-change path - clash check against bookings, holds and other Outlook appointments, quote-expiry rule, linked event / holds follow, audit row naming the person, client e-mailed if the date changes; refused with the usual message on a clash; refused for multi-day). For a public event: change the date on the Events screen, then choose Keep website version. |
| Outlook edit of body / categories / reminders only | Ignored. |
| Website change while an entry is in conflict | Not pushed (waits for the decision). |
| Outlook delete | Flagged `external_deleted`; **Re-create in Microsoft 365** is an explicit action. If the booking is then cancelled, the entry just becomes `removed`. |
| Website cancel / erase | Event removed from Outlook. |

The only unguarded moment is the few seconds between a pull and a push in one run (no ETag / If-Match is used); an Outlook edit made inside that window would be overwritten once and could be reverted from Outlook's version history.

## 5. Admin calendar screen (Phase 5)

* A **status strip** above the filters: off / connected and when it last synced / can't sync (with the plain reason) / N need attention; **Sync now** (manager + administrator) and **Details**.
* **Details**: shared calendar, time zone, last sync, counts; for administrators **Test calendar access**, **Switch sharing on / off** (refused unless the access test passes) and **Recent activity** (the sync log); "what is shared / what is not".
* A small **marker on each item** (icon shape and colour, with a text label): synced (tick), waiting (hourglass), could not sync (!), changed in Microsoft 365 (compare arrows), deleted in Microsoft 365 (broken link), and a Microsoft logo on appointments that live only in Outlook (hatched, dashed edge, not draggable). Website-only items (enquiries) have no marker.
* The **popup** of a booking / public event gets a Microsoft 365 section: state, last synced, error explanation, what Outlook now says next to what the website has, and the actions (Retry sync, Keep website version, Use Microsoft 365 time, Re-create in Microsoft 365, Open in Outlook). Outlook-only appointments open a read-only popup (when, where, shown as, **blocks the booking form: yes / no**, join link, Open in Outlook).
* **Filters**: a Microsoft 365 toggle (source) and a **Sync** select - All / Synced / Waiting / Needs attention / Website only. Both appear only once the integration is in use.
* Roles: everybody who can open the calendar sees status and markers; administrator + manager may act; administrator only switches on / off, tests and reads the log. The server enforces this; hidden buttons are cosmetic.
* Existing design, tokens, light / dark theme and drawers are reused; verified at desktop and phone width (no sideways scroll, 44px touch targets).
* Security fixes found on the way: titles that come from outside (Google / Outlook) were written into `innerHTML` unescaped in the popup and in the Upcoming list (script injection); all titles are now escaped.

## 6. Time zones, all-day, recurrence, availability (Phase 6)

* Business zone **Africa/Johannesburg** (Windows name **South Africa Standard Time** for Graph) is one named constant, asserted at load (constant UTC+2, no daylight saving) and in tests. Booking times are stored as wall-clock strings and are sent / read back as wall-clock strings together with the zone **name** - never through the host machine's time zone (a Render server runs UTC; tests prove Johannesburg, Los Angeles and UTC hosts give identical results). Responses in other zones (UTC or an IANA name) are converted through the named zone; an unknown zone is skipped, never guessed.
* A booking with **no start time is published as an all-day event** (the Google sync turns it into a timed 18:00 event); overnight (22:00 -> 01:00) ends the next day; all-day end is the next midnight, as Graph requires; an all-day event stays all-day when read back.
* **Recurrence**: read-only. Series arrive from Graph as individual occurrences and are shown / block like any appointment; the website never creates a recurring event.
* **Availability**: a calendar entry is never a booking, an event or an open slot. Only another person's Busy / Out-of-office appointment holds time (exact hours; whole days for all-day; first 60 days of a long one), through the existing `date_holds` rules, so the public form, the month view and the admin conflict checks all agree. Verified on the real server: the whole day is refused, a booking at another time that day is accepted, a booking that overlaps is refused, releasing the hold reopens the date, no booking / event is created from an appointment.
* A Microsoft event we publish does not change a booking's availability either.

## 7. Reliability, security, audit (Phase 7)

* Auth: every endpoint is `requireAdmin` + role (table in 5); input is validated server-side (ids, choice, booleans, filters); a bad filter is ignored, never concatenated into SQL.
* Secrets: server-side only; the status API returns no checkpoint, token, create token or Microsoft id; every message is redacted (secret, bearer tokens, JWTs); the sync log and link table contain no client e-mail / phone / notes (tested).
* Audit: `calendar_sync_log` (who via `actor_id`, what, which record, outcome, redacted reason) for every create / update / delete / conflict / external delete / retry / resolve / switch; switching on / off also writes the standard `audit_log`; the booking date change writes the standard audit row naming the person.
* Retries: exponential back-off per record, capped at 6 h; 429 honours Retry-After; a POST is never repeated unless idempotent.
* An outage cannot silently discard website changes: the entry stays queued (`pending` / `error`) and is sent when Microsoft is back. The queue is visible (Needs attention filter, Details counts).
* Deleting in one system never deletes an unrelated record in the other (an erased booking removes only its own event; a Microsoft deletion only flags).

## 8. Test evidence and honest limits

Automated (all against a fake Microsoft sign-in + Graph on loopback, throwaway databases, no real customer data):

| Suite | Checks | What it proves |
|---|---|---|
| `test/calendar-graph.test.js` | 36 | Graph client writes, retry / idempotency rules, permission texts, calendar access diagnostic incl. write probe, delta paging with Graph-style links, 410 |
| `test/graph.test.js` | 46 | (updated) link handling, existing read paths unchanged |
| `test/calendar-m365-model.test.js` | 43 | eligibility, privacy of the entry, time zones (3 host zones), all-day / overnight, change detection, multi-day holds |
| `test/calendar-m365.test.js` (+ `.child.js`) | 127 | publish / update / cancel / erase, loop prevention, conflicts (keep / accept / clash / overnight / multi-day / all-day), external deletion, foreign appointments + holds, permission and outage failures + recovery, crash window, lost answers, 410, volume cap, resumable read, nudges through the existing hooks, log hygiene, retention, HTTP roles |
| `test/calendar-m365-availability.test.js` | 12 | availability on the real server, ICS feed exclusion |
| `test/browser/calendar-m365.js` | 52 | the real admin page: strip, markers, popups, actions, escaping of hostile titles, filters, roles, phone layout |

Regression: see section 10.

**Not verified - needs the real tenant (section 9):** that Exchange accepts the `Application Calendars.ReadWrite` scoped role for Graph in this tenant; Graph's real behaviour for `calendarView/delta` with the `Prefer` headers, `users('<id>')` links, the `transactionId` de-duplication and its change keys; that Outlook's time-zone handling matches the fake. The fake was written from Microsoft's documentation, so a difference is possible; the first live check is the *Test calendar access* result, then the checklist.

Known limits / decisions to be aware of:
* The **Google Calendar sync still runs** and was not changed. It has two pre-existing duplicate causes (a booking and its shadow event; an insert race) and publishes enquiries with client contact details. Do not make Google and Microsoft feed each other. Retire the Google sync once the Microsoft one is proven.
* Switching on **creates events for every upcoming ACCEPTED / CONFIRMED booking** (60 per run, so ~2 minutes per 60). Do it deliberately, ideally outside busy hours.
* Client **names appear in the event titles** of the shared calendar (anyone with access to it sees them); their contact details and notes never do.
* Only the **default calendar** of the booking mailbox is used.
* "Use the Microsoft 365 time" is for bookings; for public events change the date on the Events screen first.
* An online (Teams) meeting is shown if the Outlook appointment has one; the website does not create meetings.
* Pre-existing, noticed, **not changed**: the admin calendar's `isCalSynced / isAccepted / isPopiaDone / hasAttachments` flags are always false (their columns are never selected); `parseDurationToMinutes('3 hours')` returns 3 (stored durations are numbers or "N min", which work).

## 9. Deployment and handover

### 9.1 Already in place
Entra app registration, tenant, client id and client secret (Admin > System > Email Setup), the `bookings@` mailbox, SMTP.SendAsApp + FullAccess, the Exchange management scope "Website mailbox only" and the `Application Mail.Read` role. **No new environment variable.** (`BASE_URL` is used only for the link back to the admin; `M365_GRAPH_BASE_URL` / `SMTP_OAUTH_AUTHORITY` exist for tests and are ignored in production.)

### 9.2 Owner steps
1. **Exchange Online PowerShell** - grant the calendar role (section 3.3). Wait up to 2 hours (`Test-ServicePrincipalAuthorization` bypasses the cache).
2. Deploy this code (migration 105 runs by itself at start-up; nothing to run by hand). Commit / push as usual.
3. Admin > Calendar > **Details > Test calendar access**. All four steps must be green (sign-in, calendar read, calendar write). If "write" fails it names the role to grant.
4. Make sure that Microsoft 365 calendar is **not** also subscribed to the website's iCalendar feed.
5. **Switch sharing on** (Details). It refuses unless step 3 passes. Watch the strip; the first runs publish the upcoming bookings.
6. Live checklist (this is what turns "built" into "verified two-way"; tick each):
   * [ ] a CONFIRMED booking appears in Outlook (busy, right time, no client contact details);
   * [ ] an ACCEPTED booking appears as tentative; a QUOTED one does not;
   * [ ] rescheduling a booking on the website moves the same Outlook event (no second one);
   * [ ] cancelling removes it;
   * [ ] changing its time in Outlook shows **Changed in Microsoft 365** on the calendar and changes nothing on the booking; both choices work;
   * [ ] deleting it in Outlook shows **Deleted in Microsoft 365**; Re-create works;
   * [ ] adding a **busy** appointment in Outlook shows it (hatched) and blocks that time on the public booking form; a **free** one does not block;
   * [ ] with sharing on, no event appears twice.
7. Calendar a reminder for the **client secret's expiry** (when it expires every Microsoft feature, mail included, stops).

### 9.3 Diagnosing and recovering
| Symptom | Likely cause | What to do |
|---|---|---|
| Strip: "can't sync right now - ... isn't allowed" (permission) | the Exchange calendar role is missing, not yet applied, or Read only | grant `Application Calendars.ReadWrite` (3.3), wait, *Test calendar access* |
| ... "Signing in failed" (auth) | client secret expired / changed | save the new secret (System > Email Setup); sync resumes by itself |
| ... "isn't set up" (config) | no OAuth settings (or the site is in mail mock mode) | System > Email Setup |
| ... "could not be reached" / "temporary problem" / "slow down" | Microsoft outage / throttling | nothing: automatic retries with back-off |
| One item shows "Couldn't sync" | that entry failed (reason in its popup, technical text under it, and in Details > Recent activity) | fix the cause, then **Retry sync** on the item (or wait) |
| Item shows **Changed in Microsoft 365** | someone edited it in Outlook | open it, compare, choose |
| Item shows **Deleted in Microsoft 365** | someone deleted it in Outlook | Re-create, or ignore (the booking is fine) |
| Event appears twice in Outlook | the Google sync is also writing to that calendar, or the calendar subscribes to the ICS feed | stop that other source; the Microsoft sync never creates a second event for one booking |
| Everything is stuck | switch sharing **off** (nothing is deleted anywhere), fix, switch **on** (a fresh read; entries are matched by the link table, not re-created) |
| Need to start over for one booking | set its link to `removed` is not needed: cancelling and re-confirming re-creates; or delete the event in Outlook and press Re-create |

Switching off is always safe and immediate; switching on again re-reads the calendar. Nothing the sync does is destructive on the website side.

## 10. Results (2026-10-17)

* Full integration suite (`node test/run.js`, 51 suites): **1844 / 1851 passed**. The 7 failures are not caused by this work:
  * 6 `payment-callback` PayFast ITN checks - the dev database now stores `payfast_url = https://www.payfast.co.za/eng/process`; the test server loads settings from that copy, so it is no longer in sandbox mode and rejects the test's placeholder signature (`app.js` copies the `payfast_url` setting over `PAYFAST_URL`). The suite passes against a database without that setting. None of the PayFast files are touched by this work.
  * 1 `seo-crawl-files` check - `favicon.ico` is deleted in the working tree by another change.
* All new suites above pass; the existing calendar, availability, booking, lifecycle, RBAC, inbox-sync, inquiry and stored-text suites pass unchanged.
* Browser suites that load `admin.html` (smtp-settings, contact-inquiries, accolades, stored-text, admin-venue-autocomplete, calendar-m365): all pass.
* Known flake seen once: `calendar.test.js` CP5 (reads the database right after a response; passes 39/39 on re-run - documented in the test-suite notes).
* Hazard: running tests while the dev server (`npm start`) is writing the dev database can copy a torn database (one browser run reported SQLITE_CORRUPT on the throwaway copy; the dev database itself passes `PRAGMA integrity_check`). Stop the dev server for a clean run.
* **Everything above ran against a fake Microsoft Graph. The real tenant has not been exercised - section 9.2 is how that is done.**
