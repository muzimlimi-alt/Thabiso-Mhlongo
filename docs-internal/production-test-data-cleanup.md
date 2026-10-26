# Production test-data clean-up - runbook

Tool: `scripts/cleanup-test-data.js` (tests: `test/cleanup-test-data.test.js`).
Purpose: remove test transactional data from **Bookings, Calendar/Events, Finance and Logs** in a controlled, reversible,
verifiable way, without touching clients, users, settings, services, venues, inquiries (beyond one link), newsletter,
public site content or public web analytics.

> This file is in a public repository. Keep booking ids, payment ids, e-mail addresses and the contents of any manifest
> out of it. Manifests and backups contain personal data: they are written only outside the project folder.

## What the tool does

| | |
|---|---|
| **Dry run (default)** | Read-only on the real database. Builds the plan, then **rehearses** it: copies the database to a private temp file, runs the identical delete code there, verifies it, prints before/after figures, discards the copy. Prints a **plan fingerprint**. |
| **`--execute --plan <fingerprint>`** | Refuses unless the fingerprint matches a plan recomputed *inside the write lock*. Takes a **verified online backup** (SQLite backup API, WAL-safe), deletes in **one transaction**, and rolls back on any anomaly (row count differs from plan, new FK violation, leftover reference, any change to a table it must not touch). |
| **`--post-check <manifest>`** | Read-only follow-up: cleanup marker present, no removed Google event came back as a hold, no removed booking id reappeared. |

Rules, not id lists: production may hold rows the development copy never had. A mandatory **`--cutoff`** keeps everything
created after it, and anything those newer rows depend on.

### What is deleted, kept and held

* **Deleted**: bookings (and notes, services, line items, access codes/tokens, communications, consent records, cancellations,
  contracts, advancing packs, reviews), quotations, invoices (+lines), payment schedules, reminders, transactions, expenses,
  payment intents, events and date holds tied to those bookings, abandoned-booking leads, and (by `--logs-scope`) payment /
  financial / e-mail / audit / login logs and sent notifications.
* **Unlinked, not deleted**: `inquiries.converted_booking_id` (the inquiry stays), `bank_statement_lines` match columns
  (imported bank data stays), and kept date holds / recovery leads that pointed at a removed booking.
* **Held (default `--payfast-hold keep`)**: every booking, transaction and payment log with PayFast evidence - a *numeric*
  `pf_payment_id`, `source`/`payment_method` = `payfast`, or a payment intent - plus everything attached to them. Hand-made
  fixtures (`TEST` merchants, `PF-TEST-...` ids) are not evidence.
* **Kept by default**: events with no booking (they are the **public tour-dates page**), date holds mirrored from Google
  Calendar (`block_type='calendar_sync'`), unsent/pending notifications, notifications linked to inquiries, all client
  records, and anything created after the cutoff.
* **Never touched**: users/admin accounts, clients, settings (payment gateway and e-mail configuration), services, venues,
  tax rates, policies, legal documents, newsletter, site content, public web analytics. Proved with a before/after content
  hash of every other table. Triggers are never dropped or disabled.

## Before you run it

1. **PayFast.** Open the PayFast dashboard and check every id in the dry run's "CHECK THESE ON THE PAYFAST DASHBOARD"
   table. Note ids the app *rejected* (status "REJECTED by the app"): if PayFast actually received that money, it is not in
   the books. Only if everything is genuinely test, re-run later with `--payfast-hold release --confirm-payfast-verified`.
2. **Google Calendar.** The dry run lists the Google event ids carried by removed rows (the manifest has them under
   `plan.googleEvents`; bookings appear as `[STATUS] Thabiso Mhlongo: <type>`, events as `[PUBLIC] <title>`). Delete those
   events in Google Calendar **before** running. Otherwise the 15-minute calendar sync re-imports future ones as blocking
   date holds, and the booking engine's Google free/busy check keeps those dates "busy".
3. **Pick one literal cutoff** (an instant after which data might be genuine, e.g. the time you approve the plan) and use the
   same value for the dry run and the real run. The fingerprint includes it.
4. **Quiet moment.** The write lock is held for a few seconds (backup + delete); the live site waits, it does not fail.
   Check the database size printed by the dry run: the backup is taken under the lock.
5. **Disk space**: roughly 1x the database size free on `/var/data` (the backup) and 1x in `/tmp` (the rehearsal copy,
   removed afterwards). Check with `df -h /var/data /tmp` and `ls -l /var/data/database.sqlite`.
6. The script must be deployed to Render (it is not run from the OneDrive copy). Commit it and let Render deploy.

## Run it (Render Shell, **fresh** shell session)

```sh
cd /opt/render/project/src
OPTS="--db /var/data/database.sqlite --cutoff 2026-10-17T14:00:00Z --out-dir /var/data/cleanup-2026-10-17 \
      --payfast-hold keep --logs-scope everything"

# 1. dry run + rehearsal - changes nothing. Review everything it prints.
node scripts/cleanup-test-data.js $OPTS

# 2. real run - only with the fingerprint it printed, and the acknowledgements it asked for
node scripts/cleanup-test-data.js $OPTS --execute --plan <fingerprint> --acknowledge <tokens it asked for>
```

Review checklist for the dry run:

* "NEWEST ROW IN EACH DELETE SET" - if you see recent dates (after you started going live), stop: those may be genuine.
* "NEEDS YOUR ACKNOWLEDGEMENT" - public-site events, future-dated calendar blocks and upcoming ACCEPTED/CONFIRMED
  bookings that will be removed. Each is a real-world effect; read the list.
* "MANUAL / NON-PAYFAST MONEY RECORDS IN THE DELETE SET" - cash/EFT payments and bank-transfer refunds that will be
  removed. The tool cannot tell if they were real; you can.
* The BEFORE -> AFTER table is what the admin screens will show (they are live queries; nothing is cached).

`--logs-scope`: `booking-finance` (default; only logs tied to removed records) | `all` (every e-mail, audit, payment and
financial log - **including Contact Form and Newsletter delivery history**) | `everything` (also admin login-activity).

## Afterwards

1. `node scripts/cleanup-test-data.js --db /var/data/database.sqlite --post-check /var/data/cleanup-2026-10-17/cleanup-manifest-<...>.json`
   - run it once straight away and again ~20 minutes later (after a calendar sync). Any `FAIL ... came back as date_holds`
   means that Google event still exists: delete it in Google Calendar and the next sync drops the hold.
2. Admin: Bookings, Calendar, Events, Finance (all tabs), Dashboard, Email Logs, Security & Audit load and show the
   remaining records. Public site: the home page, tour dates, booking drawer and contact form work. Send one test enquiry
   and confirm it appears under Inquiries.
3. Keep the backup (`pre-cleanup-*.sqlite` + `.sha256`) until you are satisfied; it holds personal data - do not copy it
   into the repository or e-mail it.
4. Not done by the tool, by design: files on disk / object storage referenced by removed rows (listed under
   `plan.filesLeftInPlace`), client records left without any booking (count printed), and the Google Calendar.

## Undo

The backup is a complete SQLite file. Never swap a database file under a running service. Instead:

```sh
cp /var/data/cleanup-2026-10-17/pre-cleanup-database.sqlite-<stamp>.sqlite /var/data/restored-<stamp>.sqlite
sha256sum /var/data/cleanup-2026-10-17/pre-cleanup-database.sqlite-<stamp>.sqlite   # compare with the .sha256 file
```

then set `DB_PATH=/var/data/restored-<stamp>.sqlite` in the service Environment and redeploy. The original backup stays
untouched. (The same mechanism as the 2026-10-12 move to the persistent disk.) If the tool *fails*, it rolls back and prints
`ROLLED BACK`; the database is then exactly as before and the backup (if already taken) can simply be deleted.

## How the test data got into production, and prevention

Evidence: `database.sqlite` was **tracked in git** for 39 commits (July - 12 Oct 2026), so every push carried the working
development database - test bookings, hand-made PayFast fixtures, automated-test artefacts - to Render and replaced the live
file; it was untracked on 2026-10-12 and moved to a persistent disk, so the data that was then on the disk became "production".

Recommended controls (none of these were implemented as part of the clean-up):

1. Keep `*.sqlite` ignored (a test now fails if any database file is tracked).
2. Separate environments: a staging Render service with its own disk and its own sandbox PayFast merchant; promote code, never data.
3. **Refuse to start a non-production environment with the live PayFast URL** (the app only guards the opposite direction: production with a sandbox URL).
   The development `.env` should use the sandbox merchant and URL.
4. Tag test fixtures (a name prefix or an `is_test` column) so a future clean-up is one predicate; hand-made payment ids must
   stay non-numeric (the tool relies on that to tell fixtures from the real gateway).
5. Seed/test scripts should refuse when `NODE_ENV=production` or `DB_PATH` is under `/var/data`.
6. Use this tool as the only sanctioned clean-up path; keep its dry-run output with the change record.
