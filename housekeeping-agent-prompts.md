# Housekeeping Prompts — Thabiso Mhlongo Website

**A phased, safety-first prompt set for an agentic IDE (Antigravity).**

Repo: `muzimlimi-alt/Thabiso-Mhlongo` · Baseline commit: `e2a4fac`

---

## How to use this file

**Do not paste this whole file into the agent.** That is the same mistake as "refactor the whole application."

1. Paste **Section A (Standing Rules)** once, as the project's persistent rules file. In Antigravity, save it as `AGENTS.md` at the repo root so it is loaded into every agent session automatically. If you're unsure where your IDE reads rules from, paste it at the top of each session instead.
2. Then run **one phase at a time**, pasting only that phase's prompt block.
3. Between phases, **you** run the smoke checklist and decide whether to continue. The agent never advances a phase on its own.
4. Each phase assumes the previous one is finished and merged. Do not overlap them.

Expect this to take weeks, not a weekend. That is the point.

### Phase map

| Phase | Name | Who leads | Code changes |
|---|---|---|---|
| 0 | Containment | **You.** Agent read-only | None |
| 1 | Reconnaissance & reference map | Agent | **None** |
| 2 | Safety net: characterisation tests | Agent | Adds tests only |
| 3 | Runtime data out of the repo | Agent | Config + paths |
| 4 | Data-access extraction from `server.js` | Agent, one domain at a time | Move only |
| 5 | Route & middleware split | Agent | Move only |
| 6 | `admin.html` decomposition | Agent, one section at a time | Move only |
| 7 | Shared components & naming | Agent | Move + consolidate |
| 8 | Dead code removal | Agent | Quarantine, then delete |

Phase 8 is last for a specific reason: until Phases 4–7 are done, static analysis will report code as unused when it is actually reached indirectly. See Section A.4.

---

# Section A — Standing Rules

> Save as `AGENTS.md` in the repo root. Everything below applies to every phase, every session, without exception.

```markdown
# Standing rules for agents working in this repository

This is a live production system for a working business. Real bookings,
real invoices, real client contracts and real money flow through it.
There is currently no automated test coverage. Assume every change you
make is capable of breaking something that costs the owner money.

Your job in this repository is **housekeeping**, not improvement.

## 1. Protected surfaces

The following behaviours must work identically after your change as before
it. If you cannot verify that, you must stop and report rather than proceed.

- Booking workflow: inquiry → quote → acceptance → confirmation → completion
- Payment handling, payment callbacks, payment status transitions
- Google Calendar synchronisation
- Email automation: templates, merge fields, banners, scheduled sends
- PDF generation: invoices, quotes, contracts, signatures
- RBAC: administrator / manager / assistant role boundaries
- Finance: invoices, quotations, transactions, expenses, tax rates
- Database relationships and referential integrity

If a task would touch any of these and you are not certain the behaviour is
preserved, stop. Ask. Do not "improve while you're in there."

## 2. The move rule

During housekeeping you may **relocate** code. You may not **rewrite** it.

When you move a function, the moved body must be byte-identical to the
original except for:
- `require` / `module.exports` lines needed to make the move work
- indentation, if the nesting level genuinely changed

You may not, in the same change:
- rename variables, functions, columns, routes, tables or files
- change SQL, even to fix an obvious inefficiency
- change error handling, add validation, or "tidy" a callback into async/await
- reorder statements
- change a default value, a status string, or a date format
- upgrade or add a dependency

If you spot a genuine bug while moving code, **do not fix it**. Record it in
`HOUSEKEEPING-NOTES.md` under "Deferred fixes" and keep moving. Bug fixes are
a separate change with separate testing.

## 3. The no-delete rule

You never delete a file. You move it to `_quarantine/<original-path>` and
record the move in `HOUSEKEEPING-NOTES.md` with the evidence that it is unused.

Quarantined files soak for a minimum of two weeks of live production use
before a human deletes them. You do not delete from `_quarantine/`.

## 4. Indirect references — read this before calling anything unused

A grep for a filename or function name is **not** sufficient evidence that
something is unused in this repository. Known indirect reference paths:

- **Database-stored paths.** The `settings` table holds file paths in
  `site_logo`, `favicon`, `login_background` and `email_banner`. The
  `gallery_images`, `banners`, `home_slider`, `testimonials`,
  `footprint_countries` and `services` tables store image paths as rows.
  An image with zero references in source may be on the live site.
  You must query the database before declaring any asset unused.
- **Inline event handlers.** `admin.html` contains ~253 `on*=` attributes and
  ~1,526 `id=` attributes. Functions are called by name from markup strings,
  not from JS call sites.
- **Template-literal construction.** Selectors, table names, endpoint paths
  and file paths are built by string concatenation in several places. Search
  for fragments, not just whole strings.
- **Email and PDF templates.** These reference assets and merge fields by
  string. Check `js/emailComponents.js`, `js/emailTemplates.js`,
  `js/mergeFields.js`, `js/bannerRegistry.js` and `js/pdfService.js`.
- **CSS.** Classes are applied from JS strings inside `admin.html`, so a
  class can be live with no occurrence in any HTML file.
- **Static serving.** Express serves directories wholesale; a file can be
  reachable by URL with no source reference at all.

Rule: to call something unused you need **four** clean checks — source grep,
database query, template check, and a runtime check with the app running.
Three is not enough.

## 5. Branch, commit and rollback protocol

- One branch per phase: `housekeeping/phase-N-<slug>`
- One commit per logical move. A commit that moves two domains is too big.
- Maximum ~400 changed lines per commit. If a move exceeds that, split it.
- Never mix a schema change and a code change in the same commit.
- Every commit message states what moved, from where, to where, and
  explicitly: `Behaviour: unchanged`.
- Before each commit, confirm the rollback works: `git revert <sha>` must
  restore working behaviour without manual fixup.

## 6. Stop conditions

Stop immediately, revert nothing, and report to the human if:

- a test fails and you cannot explain exactly why in one sentence
- a change would alter behaviour on any protected surface in Section 1
- you need to modify code inside a payment, RBAC or calendar-sync path
- you cannot satisfy the four-check rule in Section 4
- a move would exceed 400 lines and cannot be split
- you find credentials, tokens, personal data or client documents in the
  working tree or in git history
- the task as described requires you to rewrite rather than relocate

Reporting a blocker is a successful outcome. Guessing is not.

## 7. What "done" means

A phase is done when: tests pass, the human has run the smoke checklist,
the branch is merged, and `HOUSEKEEPING-NOTES.md` records what moved.
Not when the code looks better.
```

---

# Section B — Phase prompts

Paste one block at a time.

---

## Phase 0 — Containment

> **You lead this phase.** The agent does not execute it. History rewriting and force-pushing are irreversible operations on a repository holding your only copy of some data; an agent should not run them, and no prompt should tell it to.
>
> Do these yourself, in this order, before any refactoring work begins:
>
> 1. Rotate the five API credentials stored in the `settings` table.
> 2. Force-reset the four admin passwords; clear `sessions.sqlite`.
> 3. Set the repository to private.
> 4. Back up `database.sqlite` and `docs/` outside the repo. Verify the backup opens.
> 5. Untrack and purge the runtime files from history.
>
> The agent's only role here is inventory. Paste this:

```markdown
Read-only task. Make no changes to any file.

Produce a report at HOUSEKEEPING-NOTES.md (create it) containing:

1. Every file currently tracked by git that matches: *.sqlite, *.sqlite-shm,
   *.sqlite-wal, or lives under docs/. Give the path, size, and the number of
   commits that touched it.
2. Every path in .gitignore, marked with whether it is currently still
   tracked by git (`git ls-files --error-unmatch <path>`).
3. Every location in source where a secret, token or API key is read —
   whether from process.env or from the `settings` database table. Report the
   key name and the file and line. Do not print any secret values.
4. Every place the application writes a file at runtime: generated PDFs,
   uploaded images, backups, logs. Give the code location and the directory
   it writes to.

Output the report only. Do not run git rm, git filter-repo, or any command
that modifies the repository or its history. If you believe such a command
is needed, say so in the report and stop.
```

**Your gate before Phase 1:** a fresh clone into a new directory contains no `.sqlite` file and no `docs/`, and the app boots against a database created by `database.js`.

---

## Phase 1 — Reconnaissance & reference map

> This phase writes no code. Its output is what makes every later phase safe.

```markdown
Read-only task. You may create files under docs-internal/ only. Change no
existing file.

Build a reference map of this application. Produce these four documents
under docs-internal/:

### 1. docs-internal/routes.md
Every route registered in server.js. For each: HTTP verb, path, the line
number, whether it sits behind authentication middleware, which role(s) it
requires if any, and a one-line description of what it does. Group by
/api/admin, /api/public, and other. There are approximately 329 routes —
list all of them; do not sample or summarise.

### 2. docs-internal/data-access.md
Every SQL statement in server.js. For each: line number, the tables it
touches, and the operation. Then aggregate: for each of the 72 tables, list
which routes read it and which routes write it. Flag any table written from
more than five distinct routes.

### 3. docs-internal/admin-html-map.md
A structural map of admin.html:
- each <script> and <style> block: start line, end line, size
- each admin section: its container id, roughly which lines it spans, and
  which API endpoints it calls
- every function defined in an inline script, with the line it is defined on
- every function that is called from an on*= attribute rather than from JS
- every id referenced from JavaScript

### 4. docs-internal/asset-references.md
For every file under images/: list where it is referenced. You must check
all four sources — source files, the database (query the tables named in
AGENTS.md section 4), email/PDF templates, and CSS. Mark each asset as
REFERENCED, DB-ONLY, or NO-REFERENCE-FOUND. Do not use the word "unused".
Also list byte-identical duplicate groups by content hash.

Do not draw conclusions about what should be deleted or restructured.
This phase produces facts only.
```

**Your gate:** spot-check ten entries against the real code yourself. If the map is wrong, everything built on it is wrong.

---

## Phase 2 — Safety net

> Nothing after this phase is safe without it. The existing test suite lives in a gitignored `TBC/` directory and is not in the repository.

```markdown
Task: establish automated test coverage for this application. Add tests
only — change no application code.

Step 1. Move the existing test suite from TBC/test/ into a tracked test/
directory. Update package.json so "test" points at it. Report which of
those tests pass, fail, or cannot run, without fixing the application to
make them pass. If a test fails because the application is broken, record
it under "Deferred fixes" in HOUSEKEEPING-NOTES.md and leave it failing.

Step 2. Write characterisation tests — tests that capture what the system
currently does, including any behaviour that looks wrong. Do not write tests
for what the code should do. If current behaviour is odd, the test asserts
the odd behaviour and gets a comment explaining why.

Cover these end-to-end paths, each against a throwaway database seeded from
a schema created by database.js:

1. Booking lifecycle: inquiry created → quote issued → quote accepted →
   booking confirmed → invoice generated → payment recorded → completed.
   Assert the row state after each transition, including every timestamp
   column that gets set.
2. Payment callback handling, including a duplicate callback and a callback
   for an unknown reference.
3. Invoice and quote PDF generation. Assert the PDF is produced and its
   text content contains the expected reference number, amounts and client
   name. Store a golden copy under test/golden/ for byte comparison of
   structure, not of timestamps.
4. Email rendering for each template in js/emailTemplates.js, with merge
   fields populated. Snapshot the rendered HTML to test/golden/.
5. RBAC: for a representative sample of at least 30 /api/admin routes,
   assert the response status for each of administrator, manager, assistant,
   and unauthenticated. Include the routes that currently allow more access
   than you would expect — assert the current behaviour and flag them in
   HOUSEKEEPING-NOTES.md under "RBAC review needed".
6. Calendar sync: mock the Google API and assert the request payloads sent
   on booking confirm, reschedule and cancel.

Step 3. Add a smoke script, npm run smoke, that boots the app against a
temporary database and asserts every route in docs-internal/routes.md
returns a non-5xx status for an unauthenticated request. This is a crash
detector, not an authorisation test.

Do not refactor anything to make testing easier. If a piece of code cannot
be tested without being changed, note it and leave it untested for now.
```

**Your gate:** `git clone && npm ci && npm test` passes on a clean machine. Until that is true, stop here — do not proceed to Phase 3.

---

## Phase 3 — Runtime data out of the repository

```markdown
Task: make the application read and write runtime data outside the working
tree, so generated files can never re-enter git.

1. Add configuration for storage locations, defaulting to paths outside the
   repository: DOCS_PATH, UPLOADS_PATH, BACKUPS_PATH. Add them to
   .env.example with safe defaults. Do not commit a .env.
2. Update every write location identified in the Phase 0 report to use the
   new configuration instead of a hard-coded relative path.
3. Update every read location — including paths stored in the database.
   Existing rows contain relative paths; add a resolver that maps a stored
   path to the configured directory. Do not migrate the stored values.
4. Fix the upload handler so that re-uploading a file does not prefix a new
   timestamp onto an already-prefixed filename. Preserve the existing naming
   scheme for new uploads; do not rename anything already stored.
5. Add to .gitignore: docs/, *.sqlite-shm, *.sqlite-wal, sessions.sqlite-*

Verification before you report done:
- npm test passes
- run the app, create a booking, generate an invoice PDF, upload an image,
  then run `git status` — it must be clean
- existing branding still resolves: site logo, favicon, login background and
  email banner all render

Do not deduplicate any images in this phase. Deduplication happens only
after the upload handler is fixed and verified, and only for groups listed
as byte-identical in docs-internal/asset-references.md.
```

**Your gate:** run through a full booking on a staging copy. Logo, banners, gallery and generated PDFs all still appear.

---

## Phase 4 — Data-access extraction

> This is the big one. `server.js` holds ~1,085 SQL statements and ~786 `db.*` calls. **One domain per session.** Do not let the agent take two.

```markdown
Task: extract the data-access layer for ONE domain out of server.js.

Domain for this session: <bookings | invoices+quotations | newsletter |
auth+users | calendar | finance | inquiries | settings>

Work strictly as a move, per AGENTS.md section 2. SQL strings must be
byte-identical after the move.

1. Create database/repositories/<domain>.repository.js.
2. Using docs-internal/data-access.md, find every SQL statement in server.js
   that touches this domain's tables. List them for me with line numbers
   BEFORE you move anything, and wait for my confirmation.
3. Move each one into a named function on the repository. The function takes
   explicit parameters and returns the result; it contains no HTTP concerns,
   no res/req, no email sending, no PDF generation.
4. Replace the original site with a call to the repository function.
5. Where a route mixes SQL with email, PDF or calendar calls, move ONLY the
   SQL. Leave the rest in place in server.js. It moves in a later phase.

Constraints:
- If a statement touches this domain's tables AND another domain's tables,
  do not move it. List it under "Cross-domain statements" in
  HOUSEKEEPING-NOTES.md and leave it in server.js.
- Do not convert callbacks to promises or async/await.
- Do not add transactions where none existed, even where one obviously
  should exist. Note it under "Deferred fixes".
- Commit after each group of at most 400 changed lines. Run npm test before
  every commit; do not commit on a red test.

Report at the end: how many statements moved, how many were left as
cross-domain, and the remaining count of raw SQL in server.js.
```

**Suggested domain order** — least to most dangerous, so your confidence in the process is built on the cheap ones:

1. `settings` 2. `newsletter` 3. `inquiries` 4. `bookings` 5. `invoices + quotations` 6. `finance` 7. `calendar` 8. `auth + users`

**Your gate after each domain:** full smoke checklist (Section C), not just `npm test`.

---

## Phase 5 — Route & middleware split

```markdown
Task: split server.js routes along the admin/public boundary. Move only.

Per docs-internal/routes.md there are ~270 routes under /api/admin and ~49
under /api/public. That boundary is also the authentication boundary, which
is why we split there first rather than by domain.

1. Create routes/admin/ and routes/public/ and an app.js that mounts them.
   server.js becomes the process entry point only: config, listen, shutdown.
2. Move routes in batches of at most 20, grouped by URL prefix. After each
   batch: npm test, npm run smoke, commit.
3. Extract middleware into middleware/: auth.js, rbac.js, error-handler.js.
   These are moves. The auth and RBAC logic must not change by a single
   character — Phase 2 has tests asserting current role behaviour, including
   the cases flagged as "RBAC review needed". Those tests must still pass
   unchanged. If one starts passing differently, you have altered behaviour:
   stop and report.
4. Do not split by domain yet. routes/admin/ can be a flat directory at the
   end of this phase.
5. /api/debug: do not remove it. Report what it exposes and let me decide.

Middleware ordering is behaviour. Preserve the exact registration order of
helmet, cors, rate limiting, session, sanitisation and body parsing. If a
move changes the order, revert it and report.
```

**Your gate:** log in as each of the three roles and confirm each still sees exactly what it saw before.

---

## Phase 6 — `admin.html` decomposition

> 1.23 MB of inline JS, 286 KB of inline CSS, 253 inline `on*` handlers, 1,526 IDs. **One section per session.**

```markdown
Task: extract ONE section of admin.html into its own files. Move only.

Section for this session: <dashboard | bookings | calendar | events |
inquiries | newsletter | gallery | testimonials | footprint | career |
settings>

Before starting: state which lines of admin.html you will touch and which
functions from docs-internal/admin-html-map.md belong to this section. Wait
for my confirmation.

1. Move this section's JavaScript into js/admin/<section>.js. Byte-identical
   bodies. Functions called from on*= attributes must remain reachable —
   attach them to window explicitly rather than converting the markup to
   addEventListener. Converting handlers is a behaviour change and belongs
   to a later pass.
2. Move this section's CSS into css/admin/<section>.css. Do not merge,
   deduplicate or reorder rules — CSS order is behaviour, and this file has
   ~286 KB of inline styles whose cascade is load-bearing. Preserve the
   original order exactly and load the extracted file at the same point in
   the document where the <style> block sat.
3. Leave the markup in admin.html for now. Splitting markup into partials
   requires a build step or server-side includes; that is a separate
   decision I have not made yet.
4. Do not touch any function that docs-internal/admin-html-map.md shows as
   called from more than one section. List those under "Shared candidates"
   in HOUSEKEEPING-NOTES.md — they become Phase 7 components.

Verification: open the admin console, exercise every control in this
section — every button, filter, search box, modal, drawer, tab and
pagination control — and confirm no console errors and no changed output.
Report anything you could not exercise.
```

**Your gate:** click through the section yourself. Console open. Then check that *other* sections still work — shared functions are how this phase breaks things.

---

## Phase 7 — Shared components & naming

```markdown
Task: consolidate duplicated UI implementations into shared components.

Work only from the "Shared candidates" list in HOUSEKEEPING-NOTES.md.
Start with these five, in this order, one per session — they account for
most of the repetition across the admin sections:

  1. DataTable   2. Pagination   3. Modal   4. Drawer   5. FilterBar

For each:
1. List every existing implementation with its file and line range, and the
   ways they differ. Wait for my confirmation before writing anything.
2. Build the shared version so it can reproduce EVERY existing variant
   through configuration. Where two implementations differ, the shared one
   supports both — do not standardise the difference away. If a difference
   looks like a bug, keep it and note it under "Deferred fixes".
3. Migrate call sites one at a time, committing after each.
4. Leave the old implementation in place until every call site is migrated,
   then move it to _quarantine/.

Naming: propose a single convention and apply it ONLY to files created
during this housekeeping work. Do not rename any pre-existing file in this
phase — renames break DB-stored paths, cached URLs and bookmarks, and they
make every future git blame harder. Renaming existing files is its own
change, done later, one file at a time, with a redirect where it is served.
```

---

## Phase 8 — Dead code removal

> Last, deliberately. Run this only after Phases 4–7 are merged and the app has run in production for at least two weeks on the new structure.

```markdown
Task: identify unused code and assets. Quarantine only — delete nothing.

For every candidate you must satisfy all four checks from AGENTS.md
section 4 and show the evidence for each:
  1. source grep, including partial-string and template-literal matches
  2. database query — check the settings table and every table that stores
     a path or a template reference
  3. email and PDF template check
  4. runtime check — run the app, exercise the smoke script, and confirm the
     code path is never entered

Candidates, in this order:
  1. Assets marked NO-REFERENCE-FOUND in docs-internal/asset-references.md.
     Assets marked DB-ONLY are NOT candidates — they are live.
  2. Byte-identical duplicate image groups: keep one canonical copy, but
     only after updating every database row that points at the copies you
     are quarantining. Update the rows first, verify the site renders, then
     quarantine.
  3. Routes in docs-internal/routes.md that the runtime check never reached.
     Treat these with the most suspicion — a route can be reached by an
     external system, a saved bookmark, an email link, or a webhook. Do not
     quarantine any route that appears in an email template, a PDF, or a
     stored URL. Report them; I decide.
  4. CSS rules with no matching selector. Remember classes are applied from
     JS strings, so grep the JS for the class name as a fragment.
  5. Root-level leftovers: scratch_screenshot_inq.js, tracker.js.

Move each to _quarantine/<original-path>. Record in HOUSEKEEPING-NOTES.md:
path, date quarantined, and the evidence from all four checks.

Delete nothing. Empty nothing. After two weeks of live use with no issues,
I will delete _quarantine/ myself.
```

---

# Section C — Your smoke checklist

Run this yourself between every phase, and after every domain in Phase 4 and every section in Phase 6. The agent cannot do this for you — most of it needs a human looking at a screen.

- [ ] Submit an inquiry from the public site; it appears in admin
- [ ] Issue a quote; the quote PDF generates and the email arrives
- [ ] Accept a quote as a client; booking status transitions correctly
- [ ] Confirm a booking; the Google Calendar event appears
- [ ] Generate an invoice; PDF correct, numbering correct
- [ ] Record a payment; amounts, outstanding balance and status all update
- [ ] Cancel a booking; calendar event removed, cancellation recorded
- [ ] Send a newsletter to a test address; banner and merge fields render
- [ ] Log in as administrator, manager and assistant — each sees exactly what it saw before
- [ ] Upload an image in admin; it appears on the public site
- [ ] Public site: logo, favicon, login background, gallery, testimonials all render
- [ ] Browser console clean on public site and on every admin section
- [ ] `git status` clean after all of the above

If any line fails, revert the last commit before diagnosing. Diagnose from a known-good state.

---

# Section D — Things to say to the agent when it goes wrong

Keep these to hand. Agentic IDEs drift toward doing more than asked, and the drift is usually polite and reasonable-sounding.

- *"That is a rewrite, not a move. Revert it and move the code unchanged."*
- *"You changed behaviour to make a test pass. Revert. The test documents current behaviour; if it fails, your move was wrong."*
- *"Stop. You have taken on two domains in one session. Revert to the last commit and do only the first."*
- *"You have not satisfied the four-check rule. Show me the database query."*
- *"Do not fix that. Add it to Deferred fixes and continue."*
- *"You are proposing a rename. Renames are out of scope until Phase 7, and pre-existing files are never renamed."*

---

# Appendix — Baseline measurements

Recorded at commit `e2a4fac`, 27 Aug 2026. Use these to confirm progress and to detect a phase that changed more than it should have.

| Measure | Baseline |
|---|---:|
| `server.js` | 1.11 MB / 19,261 lines |
| Routes in `server.js` | 329 (270 admin, 49 public, 10 other) |
| Raw SQL statements in `server.js` | ~1,085 |
| Direct `db.*` calls in `server.js` | 786 |
| `admin.html` | 2.33 MB / 36,233 lines |
| — inline JS | 1,228,396 chars across 14 blocks |
| — inline CSS | 285,657 chars across 8 blocks |
| — inline `on*=` handlers | 253 |
| — `id=` attributes | 1,526 |
| `database.js` | 182 KB — 72 CREATE TABLE, 272 ALTER TABLE, 79 CREATE INDEX |
| `js/myscript.js` | 185 KB / 3,721 lines, 636 jQuery calls |
| `css/redesign.css` | 203 KB |
| Repo on disk | 136 MB (65 MB images, 53 MB `.git`, ~4.6 MB source) |
| Byte-identical duplicate image groups | 8 |

A phase that changes any of these by more than it set out to has done something it was not asked to do.
