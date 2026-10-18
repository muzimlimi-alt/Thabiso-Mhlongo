# Rate card 2026 - services catalogue update (living log)

Source of truth for the figures: `Thabiso_Mhlongo_Booking_Kit_2026.pdf` (updated September 2026, **valid until 31 December 2026**, ZAR,
all fees exclude VAT at 15%, travel, accommodation and rider). Work is done in phases; each phase appends its section when it is verified.

> The repository is public: nothing sensitive belongs in this file.

**Status (2026-10-18): phases 1-4 done and tested; nothing committed or deployed yet. Phase 5 next (booking / quote workflows), then
Phase 6 (invoices, payments, reports) and Phase 7 (verification, including a mandatory real end-to-end test of booking -> quotation ->
invoice -> payment).**

## Owner decisions (2026-10-17)

1. Old catalogue rows that are not on the rate card are **deactivated** (never deleted).
2. Travel / accommodation / rider / merchandise add-ons stay **active and unchanged**.
3. **Prices are never shown to the public.** A client sees a price only once the quotation has been sent to them. (Applies to the booking
   drawer, `/api/public/services`, the tracking view - Phases 4-5.)
4. The data migration may run on deploy, provided it was tested on a copy of the database first (it was - see Phase 2).

## The pricing model

One catalogue row = one service. `services.price_type` says how it is priced; **only a `fixed` price is an amount the system may
pre-fill on a booking or quote line.** Everything else is a *published figure*, never an agreed price, so `default_price` stays `0` and an
administrator must type the agreed amount on the quote.

| `price_type`  | Rate-card wording                 | Stored in                                   | Admin label (`price_label`)                |
|---------------|-----------------------------------|---------------------------------------------|--------------------------------------------|
| `fixed`       | R28,000                           | `default_price` (`base_price` if set)       | `R28,000`                                  |
| `range`       | R12,000 - R25,000                 | `price_min`, `price_max`                    | `R12,000 – R25,000`                        |
| `from`        | From R50,000                      | `price_min`                                 | `From R50,000`                             |
| `enquire`     | Enquire - WGSA rates              | nothing                                     | `Enquire`                                  |
| `enquire_min` | Enquire - minimum R15,000/session | `price_min`                                 | `Enquire – minimum R15,000 per session`    |

`price_unit` (`minute | hour | month | session | draft`) is the billing unit shown with the label. `pricing_model` keeps its old meaning
(`flat_fee | per_minute | per_hour` = how *quantity* works); only `fixed` services may be per-hour / per-minute. Writing - Consultation
(R2,500 per hour) is the one hourly rate-card service: `pricing_model = per_hour`, quantity = **hours**.

Other new columns: `is_featured` (the "Most Booked" flag, on the 7 Corporate and Events services) and `service_group`
(`club_theatre | corporate_events | private_functions | writing_creative | acting_voice_brand`, stored as a slug; labels live in
`lib/service-pricing.js` `GROUPS`). The legacy `category` column (Performance / Travel / Production / Other, a DB CHECK) is unchanged and
still set, so nothing that reads it breaks.

Rate-card conditions and validity are stored in `settings`: `rate_card_valid_until` (`2026-12-31`), `rate_card_currency`,
`rate_card_conditions` (the public wording), `rate_card_title`, `rate_card_updated`, `rate_card_featured_group`.

### Where the rules live

| File | Role |
|------|------|
| `lib/service-pricing.js` | **Single source of truth**: types/units/groups, `catalogueUnitPrice`, `describePrice`, `normalizeServicePricing`, `normalizeQuantityLimits`, `priceBandWarning`, `checkQuoteLinePricing` |
| `lib/rate-card-2026.js` | The 23 rate-card rows, the settings, and the **run-once atomic migration** (version 106) |
| `routes/admin/services.js` | Admin CRUD validated through the library; GET adds `price_label` / `quote_required` |
| `routes/admin/bookings.js` | Quote route refuses a non-fixed line with no explicit amount (400) and returns band warnings; manual booking snapshots via `catalogueUnitPrice` |
| `routes/public/bookings.js` | Public booking snapshots via `catalogueUnitPrice` (non-fixed -> 0) |
| `database.js` | Adds the columns, DB triggers that guard `price_type` / `price_unit`, and calls the migration |
| `test/service-pricing.test.js` | 168 checks (see below) |

## Phase 2 - the catalogue (verified on a copy of the dev database)

Result: **3 existing rows updated (ids kept), 20 created, 8 deactivated, 6 add-ons kept** - 23 live rate-card services.

Judgement mappings (clear on duration/type, flagged to the owner): the old 15-minute set -> Corporate 15 min; the old 60-minute headline set
-> Corporate 45-60 min; "MC & Host - Full Day" -> Corporate MC Duties Full Day (6+ Hours). The old voice-over (per spot / per minute),
TV/Film day rate, Podcast and Script Writing rows were **not** mapped (different unit) and are deactivated. A reused row is renamed, so an
old booking's *service name* now reads the new name; its stored price is untouched.

Migration safety: matches by name (production ids differ; entity-encoded legacy names such as `MC &amp; Host` are matched too); planned in
pure JS, applied as **one `BEGIN IMMEDIATE ... COMMIT` script** with the applied marker inside the same transaction - the server accepts
requests while it boots, so a stepwise migration briefly exposed a half-updated catalogue (found by a test). Failure rolls back completely.
The hook in `database.js` runs before init has finished, so `applyOnce` **waits for the tables and columns it needs** (it polls the real
schema, never assumes statement order - on a brand-new database the first version failed 6 times out of 6) and retries while another
transaction is open, without ever rolling back a transaction that is not its own.
Comparing all 80 tables of a database copy before/after: only `services`, `audit_log`, `settings`, `schema_migrations` changed - booking,
quote, invoice, payment and ledger tables are byte-identical.

## Phase 3 - model, validation, calculations

- **Admin API.** POST/PUT validate every combination (range needs min < max, `from` / minimum need an amount, units and groups are
  whitelisted, hourly/per-minute only for fixed prices). A PUT that does not mention `price_type` **keeps the stored pricing**, so an older
  admin screen cannot turn a range into a R0 fixed fee. Audit rows now hold old and new values. Hourly services may start at 1 hour (the
  old rule forced every non-flat model to >= 15, which blocked editing hourly rows); per-minute still needs >= 15.
- **Bookings.** Public and manual bookings snapshot a catalogue price only for `fixed` services; range / from / enquire services snapshot
  `0` (never their minimum or midpoint). A booking with no price yet is not marked paid (the auto-paid trigger needs `total_amount > 0`).
- **Latent bug fixed:** the manual-booking path stored an hourly line's quantity as *minutes* while the public path, Quote Builder, PDFs and
  emails all use *hours*; a pre-filled quote would have read "60 hr x R2,500". It now stores whole hours (ceil of minutes / 60). Rows already
  saved by the old code are not rewritten.
- **Converting to a fixed price.** Changing a range / "from" / enquiry service to `fixed` must supply a price above zero (otherwise the stored
  `0` would silently become a free service).
- **Quote guard.** A service-linked quote line for a non-fixed service must carry an explicit amount above zero or the quote is refused
  with a plain message. Amounts outside the published band (below a "from" price or minimum fee, outside a range) are allowed and returned
  as warnings - a tailored quote may legitimately differ. VAT/totals (`lib/document-totals.js`) are price-type agnostic and unchanged.
- **Tests** (`test/service-pricing.test.js`): pure rules; the catalogue against the PDF (the expected table is typed in the test, not
  imported); admin API for every price type incl. rejections and old-screen edits; DB guards; booking snapshots (fixed / range / from /
  enquire / minimum / hourly, public vs manual parity); quote guard, warnings, hourly totals and VAT once; **historical protection** (editing a
  fee leaves saved booking lines, quote lines and totals untouched); the migration plan on synthetic data (reuse, audit, atomic rollback,
  idempotent re-plan).

## Phase 4 - who sees which price (admin screens, public site, quotation)

**Public: never a price.** `/api/public/services` is now an *allowlist* (`PUBLIC_SERVICE_COLUMNS` in `lib/service-pricing.js`): no
price, price type, GL code, tax or cost field - only what the booking form needs plus the rate-card group and the Most Booked flag, in
rate-card order. The booking drawer (`js/myscript.js`) groups its service list as on the rate card ("Corporate & Events — Most Booked"),
stores no price on a row or in the saved draft, and the old "prices changed since you opened this form" check at submit is gone (with
no prices in the API it would have compared `NaN !== NaN` and blocked **every** booking). The public tracking response withholds the quote
amount, details, expiry, total, outstanding balance and every line price until a quotation exists
(`pricesRevealed()` in `lib/booking-tracking.js`: a quotation has been issued, or the status can only follow one). The script's `?v=` was
bumped so visitors load the new script with the new API. The stand-up and MC homepage cards no longer pre-select a service (there are now
several tiers each, so there is no single confident match); acting and voice-over still did at this point (superseded in Phase 5: the cards
became the five rate-card categories and none pre-selects).

**Quotation + emails carry the conditions** (`lib/pricing-conditions.js`). Printed as a PRICING CONDITIONS block between the totals and the
terms on quotation PDFs, and in the quotation email, its resend and the quote reminder. Wording follows the rate card, adapted only where the
quotation itself would make a sentence untrue: ZAR; VAT either "Fees exclude VAT. VAT at 15% is added in the totals above." or "VAT is not
included in the amounts above."; "Fees exclude travel, accommodation and rider unless they are itemised in this quotation."; a plain note
only when a line is for an individually priced service; and "Rates are valid until <date>." only while `rate_card_valid_until` has not
passed. Nothing else (no discounts, deposits, payment terms). The quote route builds the lines once so the PDF and the email cannot
disagree. Invoices are unchanged. `test/golden/quote.golden.txt` was regenerated for this (the pdf-golden test pins the validity date far
ahead so the golden never depends on today's date).

**Admin screens.**
- Services list: every card shows the price as published (`price_label`), a "Priced individually" note, a rate-card group badge and a
  Most Booked star; group pills (built from `GET /api/admin/services/meta`) replace the Performance/Travel/Production/Other pills; price-type
  filter; search also matches the displayed price and the group; sorted group by group.
- Edit drawer: a Pricing section (price type, billed-per, the amount fields that apply, quantity basis, group, Most Booked). A range
  needs both amounts, "From"/minimum need one, enquire none; converting a range/from/enquiry to fixed needs a real price. Quantity limits are
  minutes for per-minute services and **hours for hourly ones**; the old form forced every non-flat service to a 15 minimum, which blocked
  hourly services (the 1 hour minimum now saves). "Cost Price / Unit" was relabelled "Booking Rate Override" (it never was a cost price: when
  set, new bookings use it instead of the price).
- **Saving a service from the admin was broken** (`TypeError ... reading 'trim'`): the Advanced / Financial panel is commented out of
  `admin.html` but `saveService` still read its inputs. The form now sends only what exists and `PUT /api/admin/services/:id` keeps the stored
  value of any field it is not sent (GL code, crew, tax category, base unit, SAC code, cost centre, archived flag, ...).
- Rate-card banner above the stats: title, validity with days left (amber within 45 days, red once expired) and an editable "Rates valid
  until" date (`PUT /api/admin/services/rate-card`, administrator or manager, audited). Nothing switches off on that date; only the
  validity sentence disappears from new quotations.
- Quote Builder: the selector lists services grouped with their published price; a service priced individually is added with **no amount**,
  a published-band hint and an "Agreed amount" placeholder, and cannot be sent until an amount is entered (the server refuses a R0 line too).
  The two guessed-price fallbacks were removed (a hardcoded R20,000 "Main Performance" line, and pre-filling a service whose name merely
  contained the event type). Manual booking: the selector shows the published price, and the estimate never counts an individually priced
  service as R0 ("+ 1 service priced on the quote").
- Tests: `test/service-visibility.test.js` (63 checks: public allowlist, tracking gate before/after a quotation, conditions on PDF and
  emails incl. VAT / individually priced / expired, meta + validity endpoints and roles, saves keeping hidden fields);
  `test/quote-reminder.test.js` (+ `.child.js`, the real reminder job in a child process on a throwaway DB: conditions on the reminder, VAT
  added / not added / unreadable quote, validity dropped after expiry); and the real-browser `test/browser/service-pricing.js` (64 checks over
  the Services screen, every price type's drawer, the hourly minimum, the public form incl. a real submit through the form's handler, and the
  Quote Builder; set `SVC_SHOTS_DIR` for screenshots; needs `PUPPETEER_EXECUTABLE_PATH`). Tests that change shared state restore it
  (the pdf-golden test pins the rate-card validity and puts it back; service-pricing archives the fixtures it created) because the node suite
  shares one server and database.
- Existing browser tests that fail on this machine and are **not** caused by this work: `slots.js`, `form.js` (their helper uses real mouse
  clicks, and "Add Service" sits ~400px below the 900px viewport inside the tall drawer, so the wizard never leaves step 1), `calendar.js` and
  `date-status.js` (seeded dates not found in the calendar grid, date dependent), `public-sections.js` (gallery pager) and `accolades.js`.

## Phase 5 - bookings, the Quote Builder and the quotation (2026-10-18)

**The finding that shaped it.** `bookings.quote_amount` holds the catalogue **estimate** ("R 5000.00", or "R 0.00" when the services are
priced individually) until a quotation is issued, but the admin screens read its truthiness as "a quote exists". So every never-quoted
booking showed "Revise & Send Quote", the Quote Builder asked "This booking already has a quote" before the first one, the Quote card
and the "Quote Sent" panel appeared, the Needs-Action filter skipped PENDING bookings that had only an estimate, and the Deal View
ledger printed "Quoted total R NaN" (`parseFloat("R 5000.00")`). Fixed at the source, not screen by screen:
- Server (`routes/admin/bookings.js`, `QUOTE_STATE_SQL`): the list (`/full`), the paginated list and the detail return `has_quote` (a
  quotation row stands, or the booking was ever stamped `quoted_at`) and `unpriced_lines` (lines whose service is priced individually and
  that carry no agreed amount). The detail's service rows and `/details` line items also carry `price_type`, `price_label`,
  `quote_required`, `tax_class`, `catalogue_unit_price` (the only amount a screen may pre-fill: `base_price` over `default_price`, 0 for
  every non-fixed type) and `unpriced`. `GET /api/admin/services` adds `catalogue_unit_price`; `/services/meta` adds `vat_rate`.
- Browser: `bkHasQuote(row)` / `bkMoney(v)` (top of `js/admin/bookings-pipeline.js`). The pipeline row, next-step hints, Send/Revise buttons,
  Quote card, "Quote Sent" panel, Deal View chip and timeline, ledger and `bookingNeedsAction` all use them. Before a quote the Fee column
  shows the estimate marked "est.", or "To be quoted" when a line is individually priced (never R0.00 / R NaN / a bare dash); the Deal
  View says the same ("To be quoted" with the published band beside it, "Quoted total - Not yet quoted").

**Where each amount in the Quote Builder comes from.**

| Situation | Line amount |
|---|---|
| The booking already has a quotation | the booking's **saved** line amount (a revision starts from what was quoted; a saved R0 stays R0) |
| No quotation yet, fixed-price service | the **current** catalogue fee (`catalogue_unit_price`) - the booking's snapshot is only an estimate from when the service was added |
| No quotation yet, range / from / enquire / enquire-min | **empty**, with the published label as a hint; sending is blocked until an agreed amount is typed (the server refuses a R0 line too) |
| Quick-add from the selector | `catalogue_unit_price` (the old code used `default_price`, ignoring a booking-rate override) |
| A service retired since the booking | still described correctly from the booking's own service row (tax class, quantity limits, price type) |

The "already has a quote" prompt now appears only when a quotation really exists. **Totals:** the browser preview and the server run the
same file, `js/shared/document-totals.js` (re-exported by `lib/document-totals.js`; proven identical to the old function over 20,000 random
inputs): VAT on taxable lines only, exempt / zero-rated lines, the discount split in proportion, VAT then total rounded to the cent. The
preview takes its VAT rate from the server instead of a hard-coded 15% and each row's tax class from the catalogue (the browser never
sends a tax class; the server decides it).

**The quotation PDF** (`js/pdfService.js`): "VALID UNTIL" and the footer now show the expiry chosen on the quote (the date the tracker
enforces), not today + 14 days; the blank second page is gone (the footer's last line was drawn below PDFKit's bottom margin);
VAT and the total are rounded exactly as the stored total is (they could differ by a cent); and - found while testing - a **flat-fee line
with quantity above 1 was printed at the unit price only**, so "Accommodation x 2 nights" showed R2,200 and the printed subtotal / VAT /
total disagreed with the stored quotation (R4,400 + ...); the email and the invoice already multiplied. The `unit_price || default_price`
fallback is gone, so a regenerated document can never pick up today's catalogue fee for a stored line. Invoices keep their footer text.
`test/golden/quote.golden.txt` was regenerated (only the footer sentence changed).

**Two more places did their own VAT sum, and disagreed with the stored quotation whenever a line was VAT-exempt** (travel buyouts and
accommodation are exempt in this catalogue, so this is a common quote): the **quotation email's** "Service Breakdown" (it charged 15% on
every line: R1,650.00 VAT and R12,650.00 total beside "Total Quote: 11693.28" in the same email) and the **admin Quote / Invoice cards**
(a flat 15% rounded to whole rand, printed above the real stored total). The email now uses `computeDocumentTotals` (and marks exempt lines
"(VAT exempt)", like the PDF's "[EXEMPT]"); the admin cards show the VAT stored with the quotation (`quote_details.vat`) and recompute with
the shared function only for a record that predates the field (`bkStoredVat`). The public tracking modal already displayed stored figures.

**Homepage cards.** "What I do" now has five cards, one per rate-card category (titles are the category names; Corporate & Events carries
"Most Booked"; no prices). `lib/homepage-service-cards.js` holds the default text (used by the database seed, the migration and checked
against `index.html` and `js/admin/about.js` by a test). Migration **107** replaces the stored `services_items` **only while it is still
byte-for-byte the four shipped cards**, once; cards an owner edited are never overwritten (the admin editor pads a stored four-card set with
the defaults so the fifth card is editable too). No card pre-selects a service in the booking drawer (each category holds several).
Only four photographs exist, so the fifth card re-uses the stage shot mirrored - upload a dedicated image under About Me > Homepage content.
Layout: five across from 1280px, a centred 3 + 2 from 1024px, two columns with a full-width fifth card on tablets, one column on phones.

**Historical protection (tested end to end).** Raising a service fee leaves the saved booking, its lines, the quotation, its line items,
`quote_details`, the downloaded quote PDF and the **invoice generated after the rise** untouched (invoice and milestones are the quoted
R1,000, not today's R1,500). A new booking uses the current fee. Milestones add up to the quote total to the cent for 2 and 3 instalments,
with VAT, an exempt line, a discount, a flat line x 2, an hourly line and a range service quoted at an agreed amount.

**Tests added.** `test/quote-flow.test.js` (67: quote state on the lists / detail / line items, every pricing type, VAT and exempt maths typed
by hand, the PDF **and the quotation email**, historical protection through the invoice, milestones); `test/homepage-services.test.js` (19:
the five cards, the three copies of the default text, the migration on throwaway databases incl. "edited cards are never overwritten" and
"runs once"); `test/browser/quote-builder.js` (70: the Bookings screen and Deal View before / after a quote, builder prefill rules, preview
equals the stored total, the Quote / Invoice cards' VAT, retired service, quick-add, the homepage at 4 widths and a card click);
`pdf-golden` gained page-count and valid-until checks. Mutation-checked: with the footer-margin, flat-quantity and email-totals fixes
removed, the page-count, quantity and email-VAT checks fail.

**Local database note.** The migration for this rate card (version 106) ran on the real local `database.sqlite` on 2026-10-18 (a syntax
check that `require()`d a route file booted `database.js`, which runs the end-of-init hook): 3 services updated, 20 created, 8 deactivated,
6 add-ons kept, soft-deleted rows untouched, no booking / quotation / invoice changed. It is the result any start of the server would
give. New rate-card services have ids 2929-2948 there (the sequence had advanced), so nothing may hard-code ids: look services up by name.

## Phase 6 - downstream money: invoices, contracts, payments, reports, notifications (2026-10-18)

**What depends on service data or the VAT rate, and what was done.** Invoice and contract *amounts* were never taken from the service
catalogue - the lines and prices are copied from the approved quotation (`quote_line_items`). Two inputs, though, were re-read from
**today's** data every time an invoice or contract was (re)generated:
- each line's **tax class** (`resolveLineTaxClasses` read the service's *current* `tax_class`), and
- the **VAT rate** (`getVatRate()` = today's default rate).

So editing a service's tax class - or a change to the national VAT rate - silently moved the VAT and total of a quotation the client had
already approved the next time its invoice or contract was regenerated (re-quote, admin "Generate Invoice", manual adjustment, contract
rebuild). Proven on the unfixed code: an approved R1,650.00 quotation regenerated to R1,575.00 after two services swapped tax class, to
R1,660.00 after VAT went to 16%, and a 16% quotation accepted after the rate went back was invoiced R1,150.00 instead of R1,160.00 (so
its payment milestones, built from the quote, no longer matched its invoice).
- `lib/approved-quote.js` (`approvedQuoteBasis`): the quotation's own lines, **each line's tax class as issued**
  (`quote_details.items[].tax_class`, same order as the quote lines), discount, VAT switch and **the VAT rate it was issued at**
  (`quote_details.vat_rate`, now written by the quote route). Used by `lib/invoicing.js` and `lib/contracts.js`. A quotation issued before
  this change (no stored rate / class) falls back, field by field, to the old behaviour. `sendQuoteEmail`'s resend and the quote reminder
  also use the stored rate for their "VAT at x%" sentence. A warning is logged if an invoice total ever differs from its quotation's.
- Not touched, assessed: payment milestones / deposits / balances (built from the quote total at acceptance), the PayFast init and ITN
  handlers, manual payments and refunds, transactions, the ledger and reconciliation jobs, overdue sweeps, deposit-balance and event
  reminders (all status-gated, none read a service), audit logs, the Services admin screens' write path.

**Reports and exports: a published rate is not revenue.** `bookings.total_amount` / `quote_amount` / `amount_outstanding` hold the
catalogue ESTIMATE until a quotation exists, so a rate-card change moves them for every open enquiry. Revenue, P&L, receivables, AR aging
and "revenue by category" were already safe (they read completed transactions, invoices, and accepted bookings only - an earlier fix made
receivables an allowlist). Five other places listed the estimate as money and now use one rule (`lib/booking-amounts.js`: a booking carries an
agreed amount when a quotation stands for it, it was ever quoted, or its status is QUOTED / ACCEPTED / CONFIRMED / COMPLETED):
the **reconciliation screen and its summary** ("Total quoted" no longer includes enquiries), the **reconciliation CSV for the accountant**,
the **finance CSV** (Total Amount / Outstanding are 0 for an unquoted enquiry; both CSVs gain a last column, `Amount Basis`: "Quoted" /
"No quotation yet"), the **calendar popover** (no "Outstanding R5,000" on a new enquiry), and in the admin the **Deal View chip and ledger**,
**Financial Controls** drawer and the pipeline's **bulk CSV** (blank total / outstanding + `amount_basis`). Amount Paid is always real.

**A renamed service no longer re-titles a past booking.** The rate card renamed the three re-used services (ids 1, 4, 5). `booking_services`
keeps only the service id, so live joins showed the NEW name beside the OLD amount. `lib/booking-lines.js` pairs each line with
`booking_line_items.description` (the name when booked / the quotation's own wording once quoted); used by the Deal View line items, the
booking detail the Quote Builder revises from (a revision keeps the quoted description; a first quote uses today's name and fee), and the
client's "Event Completed" email and the admin completion summary. The public tracking page only ever showed the stored quote lines.

**Assessed, no change needed:** admin calendar sync takes event length from the *current* service durations when it re-syncs; the re-used
services keep the durations their old names state (15 / 60 / 480 minutes). Abandoned-booking `est_value` is labelled an estimate and counts
fixed-price services only. Pre-quote client emails ("request received", "under review") carry no amounts. The public tracking API already
withholds every amount before a quotation exists.

**The six "baseline" PayFast ITN test failures were environmental, and they pointed at something the owner should know.** At startup
`app.js` copies the `settings` table over `process.env`, *including* `payfast_url`, the merchant id and key from Admin > Settings. The local
`database.sqlite` holds **live** PayFast settings (`payfast_url` = `https://www.payfast.co.za…`, a real merchant id and key, saved
2026-10-16 - while `.env` still says "URL still points at sandbox on purpose"), and the test harness runs against a copy of that database, so
every test server was silently configured as production: a test ITN with the wrong merchant id and a bad signature was (rightly) dropped.
`test/support.js` now deletes those four settings from the **throwaway copy only** and pins PayFast's public sandbox test account (merchant
10000100, key 46f0cd694581a, no passphrase) in the server environment, so a test server can never carry live gateway settings; the real
database and `.env` were not touched. `payment-callback.test.js` is 13/13 again (credit once, duplicate ITN ignored, unknown booking). No test
path submits anything to PayFast (the ITN tests stop at the signature check; payment init only builds the form), so no real charge was possible.
**A local `npm start` against this database talks to the LIVE PayFast host.** If that is not intended, set Admin > Settings back to the sandbox.

**Tests.** `test/financial-history.test.js` (45): approved invoice / contract amounts through tax-class swaps, price, name and active-flag
changes and a VAT-rate change (and the other direction), a legacy quotation, nothing historical moved, exactly one live invoice and no
stray milestones or transactions; the enquiry's estimate excluded from the reconciliation screen / CSV, finance CSV, calendar and
receivables, and counted once quoted; a rate change leaves report rows untouched; a renamed service on a quoted and an unquoted booking
(detail, Deal View lines, the real "Event Completed" email, payments untouched). Written first: run against the code as it was before this
phase, 20 of its first 35 checks failed (the rename section was added afterwards and was mutation-checked on its own).
`test/browser/quote-builder.js` now has 81 checks (Deal View chip / ledger, Financial Controls, bulk CSV, reconciliation rows,
rename behaviour in the builder and Deal View).

### Phase 6 follow-up - five pre-existing defects fixed at the owner's request (2026-10-18)

After the Phase 6 report the owner said "Yes" to fixing the clear-cut defects found along the way. The manual-adjustment rule below is *not*
among them: it is a business decision, not a bug with one right answer. Each fix was written test-first - the new checks failed on the unfixed
code (10 node checks, 7 browser checks, each for the bug it targets) and pass now.

1. **Dashboard "Pending quotes"** (`routes/admin/financials.js`) summed `quotations.total` (no such column; the error was swallowed) and always
   showed R0 / 0. It now sums `total_amount` of each QUOTED booking's *standing* quotation (not archived, not void), so a revision replaces
   the figure instead of adding to it. A failing query is now logged instead of silently reading as zero.
2. **Per-booking Profit & Loss revenue** (`GET /api/admin/bookings/:id/expenses`, shown in Financial Controls) had the same wrong column and
   always read R0. Revenue is now the booking's *agreed* amount (`lib/booking-amounts.js`): the standing quotation's `total_amount` (VAT
   included - the quotation total as issued, as the original query intended), else `bookings.total_amount` for a booking entered straight at
   CONFIRMED, and **R0 for an enquiry that was never quoted** - a plain column rename would have printed the catalogue ESTIMATE as revenue,
   which a test now guards. A failed lookup is now a 500, not R0.
3. **Finance CSV** (`/api/admin/finance/export`) joined every invoice a booking ever had, so a booking whose invoice was regenerated (the
   earlier ones are VOID) came out once per invoice with the same Total Amount. It is now one row per booking, carrying its live (latest
   non-VOID) invoice number or "N/A"; voided invoice numbers no longer appear in this export.
4. **Quote Builder terms text** (`js/admin/bookings-quote.js`). The deposit/balance summary the builder keeps at the top of the terms was
   removed with a pattern that matched only "50% Deposit", so every edit left a fragment behind (measured: four stale fragments with outdated
   amounts after four edits) and took "50% Deposit" out of the owner's own payment-terms policy line - all of it printed on the quotation PDF.
   The summary is now built and recognised by the same two definitions (`_qbDepositSummary` / `QB_DEPOSIT_SUMMARY_RE`), so only exactly what
   was injected is removed. The same inputs always give the same text; a clause the owner typed is kept; a zero deposit removes the summary;
   switching the terms source to the payment milestones and back restores the original. Terms already stored on quotations issued before this
   fix are history and are not touched.
5. **Invoice footer** (`js/pdfService.js` `_drawFooter`) printed the quotation's "Quotes are valid for 14 days." on every invoice. The invoice
   footer now just thanks the client - no payment terms were invented. The quotation footer is unchanged. `test/golden/invoice.golden.txt`
   was regenerated: the only difference is that sentence.

Tests added: `test/financial-history.test.js` +12 (now 57: pending quotes incl. the revision case, Profit & Loss revenue incl. the
"estimate is not revenue" guard, an expense coming off it, and "a rate change never moves it", one finance-CSV row per booking),
`test/pdf-golden.test.js` +1 (22), `test/browser/quote-builder.js` +9 (90: terms summary once, policy untouched, four edits leave no
fragments, identical text for identical inputs, zero deposit, owner's clause kept, milestone-terms round trip). Cache-bust:
`bookings-quote.js?v=5`.

**Verification of the follow-up (all executed).** Node suite: 2242 of 2243 on the second full run - the one failure is `/favicon.ico`
(unchanged). The first full run on the same code showed `calendar.test.js` CP5 / CP6 / CP21 failing together; they are the documented
timing flake (those handlers do `db.run(...)` without waiting and respond, the test reads straight back; CP5 also failed 1 of 3 solo runs on
identical code; no hunk of this work's diff touches those handlers) and passed on the rerun. Browser suite: 369 pass / 15 fail, the 15
failing check names identical to the Phase 4 baseline (six pre-existing files: slots, form, calendar, date-status, public-sections,
accolades); `quote-builder.js` 90/90, `service-pricing.js` 65/65. One earlier full browser run was invalid: the C: drive had **0 MB free**
(writes silently not persisting, a 25 s wait timing out); it was discarded, my own temp leftovers were cleared, and the files passed on
rerun - check free space before trusting a red browser run.

### Phase 6 follow-up (2) - manual adjustments survive an invoice rebuild (owner: "Change it", 2026-10-18)

The owner was asked whether a manual adjustment (`POST /api/admin/transactions/manual`, type `adjustment`, credit / debit) should survive
the invoice being rebuilt, and said "Change it". It used to last only until the next rebuild - which the adjustment itself triggers: the
route lowered / raised `bookings.total_amount`, then rebuilt the open invoice from the approved quotation alone, and
`updateBookingLedgerAfterInvoice` wrote that total straight back (R5,000 quote, R1,000 credit: total R4,000, then R5,000 again; the payment
schedule never moved off R2,500 + R2,500). Proven on the unfixed code by `test/adjustments.test.js` (20 of its first 32 checks failed).

The rules now (one source: `lib/booking-adjustments.js`, pure; query in `finance.repository.js` `getStandingAdjustmentRows`):
- **Invoice = the approved quotation PLUS the adjustments logged since that quotation was issued**, applied in the order logged with the
  ledger's own arithmetic (a credit stops at R0, so its line shows what was really taken off). Each adjustment is its own signed line in
  `invoice_line_items` and its own row in the PDF totals ("Total before adjustments", "Adjustment (credit) - R 1000.00", ...), with the reason
  printed under the totals; the stored subtotal is the sum of the lines; the invoice total, `bookings.total_amount` / `amount_outstanding` and
  the payment schedule agree. The approved quotation, its lines, the voided invoices and the payments are never touched.
- **VAT is NOT recalculated for an adjustment** - the ledger never did (an adjustment only ever changed the amount payable), so the quoted
  VAT stays exactly as quoted (R1,150 quote with a R100 credit -> VAT R150.00, total R1,050.00). Whether a credit should also reduce VAT is an
  accounting decision for the owner / accountant; changing it means feeding the adjustment into `computeDocumentTotals` instead of adding it
  after.
- **A new quotation starts fresh**: adjustments made before it was issued do not carry over (they stay in the books as history). This is also
  what a re-quote did before. The scope is `transactions.created_at >= the standing quotation's created_at` (UTC, second resolution).
- **Duplicate-flagged adjustments (`is_duplicate`) and non-completed ones are ignored.**
- **The payment schedule follows the new total** (`lib/payment-processing.js` `rebalanceScheduleAfterAdjustment`, algorithm in
  `lib/schedule-rebalance.js` = the explicit "Rebalance" route): pending milestones are rescaled proportionally, paid ones never change - but
  ONLY when the live schedule added up to the old total (a schedule an admin set up to differ is left alone), and never when the paid
  milestones already exceed the new total (a refund decision). It runs before the milestones are re-aligned with payments and before the invoice
  is rebuilt, and writes a `REBALANCE_SCHEDULE` audit row (reason "manual adjustment"). The route's own comment says "money only changes on this
  explicit action" - here the adjustment IS that explicit action; a parity test runs the real route and the planner on the same data.
- **An adjustment logged before the client accepts** is honoured by the first invoice and by the schedule the client is given (the public
  accept route builds it from the adjusted total; with no adjustments that is exactly the quoted total, as before).
- **A regenerated DRAFT contract states the fee as it now stands** (`resolveContractFeeData`), so its fee, its deposit / balance wording and
  its schedule rows agree. A signed / frozen contract is never regenerated.
- Admin: the Deal View invoice card shows a "Manual adjustments" row (the difference between the quoted total and the booking total) so the
  card still adds up; `admin.html` cache-bust `bookings-pipeline.js?v=5`.

Tests: `test/adjustments.test.js` (48 checks: credit / debit / manual rebuild, VAT, new quotation, adjustment before acceptance, duplicate
flag, contract, a credit bigger than what is still owed, the pure maths and planner, route parity; a mutation check proved the contract check
fails when the line is removed), `test/browser/quote-builder.js` +3 (93: the card row for a credit and a debit, none when the totals agree).
The over-credit scenario passes without any extra code because a database trigger ("X2" in `database.js`) already keeps
`amount_outstanding` at `MAX(0, total - paid)` on every update - it is there as a guard, not a fix; with R2,500 paid and a R3,000 credit on a
R5,000 booking the total is R2,000, the balance R0 and the booking PAID, the invoice carries the full -R3,000 line and the schedule is left
alone for the admin (a refund decision). The PDF was also rendered and looked
at (credit + debit, and a VAT invoice). Not changed: `routes/admin/transactions.js` still derives the booking's `payment_status` after an
adjustment with a flat 50% threshold (pre-existing, ignores 3-way plans).

### Phase 6 follow-up (3) - an adjustment is never money received (owner: "Yes", 2026-10-18)

Found while doing the adjustments work and approved by the owner: several places summed EVERY completed transaction as money received, so a
manual adjustment (a change to what is OWED) was counted as a payment. `tx_paid`, `getTransactionsPaidSumForReconcile` and the reconciliation
screen's row query already counted adjustments as 0; these were the outliers. Each is fixed, with a failing test written first (9 of the 61
new server checks failed before; the browser test failed with the old numbers when the old summing was put back):
- **Nightly ledger check** (`lib/ledger-reconciliation-job.js`, now exporting `findLedgerDiscrepancies()` so the query is testable): a credit
  raised a false "ledger discrepancy" alert and, worse, an adjustment could COVER a real shortfall (recorded R2,000 against R1,500 paid, plus a
  R500 credit, was not flagged). The alert's "transaction sum" also ignored the refund sign its own check used (it printed R2,500 for R2,000 paid
  less R500 refunded); both now use one expression.
- **Cancellation refund** (`routes/admin/bookings.js`, `PUT /api/admin/bookings/:id/refund`) recomputes `amount_paid` / `amount_outstanding`
  from the transactions: R2,000 paid, a R500 credit, a R300 refund read R2,200 paid; it is R1,700.
- **Revenue**: the dashboard "Revenue" stat (`getPeriodRevenue`), the 12-month trend and cash flow (`getTransactionRevenueTrend`), revenue by
  category and top clients (`routes/admin/financials.js`) and the P&L (`routes/admin/finance.js`) all added adjustments as revenue (R2,000 paid
  plus a R2,800 credit and a R100 debit read +R4,900).
- **Accountant reconciliation CSV** (`routes/admin/reconciliation.js`): "Manual_Received" / "Effective_Received" included adjustments and the
  "OverpaymentWarning" fired falsely.
- **Admin Transactions tab "Net"** (`js/admin/financials.js`, `admin.html` cache-bust `financials.js?v=2`) added adjustments to the net total.
One shared definition now: `receivedAmountSql()` in `lib/booking-amounts.js` (payment counts, refund / chargeback come off, adjustment = 0).
Tests: `test/ledger-adjustments.test.js` + `.child.js` (the real query in a child process on a throwaway DB), section H of
`test/adjustments.test.js`, `test/browser/transactions-net.js` (registered in `run-all.js`; mutation-checked).

### Phase 6 follow-up (4) - "I am unable to view the generated quote on the live site" (owner, 2026-10-18)

The booking's Files tab chip ("Quote v1 - Active") and the quote history list's "View PDF" linked straight to
`/docs/quotes/QT-....pdf`. `app.js` (the "Protect sensitive files and directories" middleware, unchanged since 2026-08-29) refuses EVERY URL
containing `/docs/` with "Forbidden: Direct access to this file/directory is restricted.", so those links could never open - on the live site
or locally (the link came from `GET /api/admin/bookings/:id/quote-history`, written in June). The quote itself was fine and was emailed; the
Pipeline card's "Download Quote PDF" and Financial Controls' "View Generated Quote" worked because they use the authenticated
`/api/admin/bookings/:id/quote/download`. Fixed (server-side only - the pages take the link from the API):
- New authenticated route `GET /api/admin/bookings/:id/quote/:quoteId/download` serves ONE quotation version inline (opens in the browser tab);
  the id must belong to the booking in the URL (another booking's quote id is a 404), admin sessions only. `quote-history` and
  `/financials` now return that URL (and the live-invoice route for the invoice) instead of `/docs/...`.
- The "quote sent" response and the "invoice generated" results (`pdfUrl`) handed out the same blocked URLs; they now give the working routes.
  Nothing in the app read those fields, so nothing else changes.
- Found on the way: `GET /api/admin/bookings/:id/quote/download` had no ORDER BY and served the OLDEST quotation row for a booking with
  revisions (v1 although v2 was active). It now serves the active (newest) version.
- The `/docs/` block is untouched (a test asserts a direct `/docs/quotes/...` URL is still refused). The client's own quote download on the
  tracking page never used `/docs/` and was already correct (covered by a check now).
Tests: `test/quote-download.test.js` (16; failed 10 of 15 before, reproducing the 403 and the "oldest version" bug) and `test/browser/quote-builder.js`
(+1: opens every quote link the Deal View renders and requires a 200 PDF). **Not live until deployed**; until then the working routes above are
the way to open a quote.

Still open (owner decisions): `tax_rates` growth, VAT on adjustments (above), and the local live-PayFast settings.

### Phase 6 follow-up (5) - one more payment gap closed, and the double-recorded payment fixed (decided under the owner's overnight authority, 2026-10-18)

- **A payment logged through "Log Transaction" is now ONE transaction** (`routes/admin/transactions.js`: `logPaymentEvent(..., { auditOnly: true })`,
  the option the PayFast handler already uses). It wrote a second `payfast`-labelled twin; existing duplicate rows in a real database are NOT removed
  by this (they need a one-off clean-up that the owner should decide on). Tests: `test/manual-transaction.test.js` (10; failed 3 before).
- **"Pay in full" charges the booking's current total, not the quotation** (`routes/public/bookings.js`, the legacy `FULL` / no-schedule path took
  `quote_amount`): after a R1,000 credit the client would still have been sent to PayFast for the quoted R5,000 and overpaid by the credit. The
  schedule-based and deposit paths already followed the rescaled milestones. Test: `test/adjustments.test.js` (failed before: "R5000.00").

## Phase 7 - end-to-end gate and final audit (2026-10-18)

**Fresh comparison with the PDF** (`Thabiso_Mhlongo_Booking_Kit_2026.pdf`, re-read in full): all 23 published rows match the live catalogue - group, name, fee /
band / "from" / enquiry-only, unit (per month, per hour, per draft, per session), "Most Booked" on the seven Corporate rows, and the "WGSA 2024-2026
escalated, highly experienced" qualification (kept in each Writing service's description; the film-script row adds "Enquire - WGSA rates"). The PDF has
23 rows (4 + 7 + 3 + 6 + 3), not the 24 in the plan. Nothing invented, nothing mapped to an unrelated service, no range / "from" / enquiry row has a fixed fee.

**End-to-end journey** (`test/rate-card-e2e.test.js`, 53 checks, reference `SERVICE-RATE-E2E-2026`, isolated database copy, run three times in a row plus once
verbosely - all green): E1 public booking request -> E2 admin review and the customer seeing no price -> E3 quotation (stored row, PDF, e-mail, customer view,
re-download, pricing conditions) -> E4 acceptance, 2-payment plan, contract, ONE invoice with the approved amounts and VAT once, no duplicate on repeat ->
E5 deposit and balance through the payment route and a SIMULATED PayFast notification (replay ignored; FAILED and CANCELLED notifications logged and not
credited) -> E6 quotation = invoice = booking total = plan = money received to the cent, dashboard revenue +exactly the amount paid once, reconciliation row,
audit trail, completion changes no amount -> E7 every pre-existing booking / quotation / invoice / transaction has identical amounts afterwards and the service
catalogue is untouched -> E8 a range, a "from", an enquiry-only and an enquiry-minimum service: saved with no price, refused by the Quote Builder without an
agreed amount, an out-of-band amount allowed with a warning, the quotation is exactly the typed amount, the PDF says "priced individually" -> E9 the real
database file was not written to; the server logged no exception; the project's clean-up tool's dry run and rehearsal pass on a private copy and plan to remove
every booking of the journey. **Not tested, and why:** (a) a notification for the WRONG AMOUNT (also a bad signature, an unknown source IP, a failed gateway
confirmation): `routes/public/payment.js` hard-rejects those in PRODUCTION only and logs-and-continues in sandbox mode, so a wrong-amount notification IS
credited by every test server (an early version of this test posted R1.00 against a R2,875.00 request and watched R1.00 land on the booking) - this cannot be
shown without a production-mode server, which also needs PayFast's own IP addresses; (b) a CONFIRMED gateway sandbox transaction (needs PayFast sandbox
credentials, a public notify URL and a buyer checkout) - the notification is a simulation posted to our own webhook; (c) the clean-up tool was not
EXECUTED (only its dry run + rehearsal): the journey ran on a throwaway copy; note that a payment intent counts as PayFast evidence, so by default the tool
would HOLD such bookings - clearing journey data from a real database needs `--payfast-hold release --confirm-payfast-verified`.

**Regression / data integrity** (read-only checks on the migrated development database): `PRAGMA integrity_check` ok; no duplicate live service names; no
booking line, booking service or invoice line points at a missing service; every live rate-card row is consistent with its price type (fixed rows have a fee,
the others have none and carry their band); the 6 add-ons the owner chose to keep are still active; 8 old rows deactivated, not deleted; migration 106
recorded once. `PRAGMA foreign_key_check` reports 29 orphan rows that are all OLD and not caused by this work (the migration never deletes): 20 login-log rows
for deleted admins, 1 payment log for a deleted booking, 1 quotation whose client is gone (June), and 7 quote lines (May) for service ids 746 / 769 / 774 that no
longer exist. Suites on the final code: see "Final pass" below.

### Final pass - favicon, Google Places and a test-suite trap (owner, 2026-10-18: "Fix the favicon issue and push the lib/places.js change as well", then "The favicon got moved to images/icon/favicon.ico and that is the one that is meant to be used")

- **Favicon.** The owner had replaced the root `favicon.ico` with `images/icon/favicon.ico` (15 Oct), so `/favicon.ico` answered 404 - the one red node
  test since Phase 2. `app.js` now serves that file at `/favicon.ico`; every page head carries ONE link (`/favicon.ico?v=3`); the gold-microphone PNG icons
  are no longer linked (the files stay on disk). Also fixed: a Branding favicon whose file is missing used to cover every public page with the full-page
  "Page Not Found" overlay (the probe in `js/applyBranding.js` was turned into that overlay by the global fetch wrapper) - which also made most of the
  public browser tests die early on the local database. How it works, the Google 48 px caveat and the Cloudflare purge step: `docs-internal/favicon.md`.
- **Google Places (`lib/places.js`).** A bare Google 403 ("The caller does not have permission" - the 2026-10-17 live failure) is reported as
  `ACCESS_DENIED` (check that billing is active and that the key is a plain API key) instead of `KEY_RESTRICTED`, which sent the owner looking at
  referrer / IP restrictions. `places-service` passes 43/43 against a fake Google; no real Google call is made, so the live outage itself still has to
  be fixed in the Google Cloud project.
- **A shared 10-call budget in the test suite** - see "Known pre-existing issues" (FIXED): the tracking limiter is bypassed under `NODE_ENV=test`
  (`test/rate-limiters.test.js` proves production still enforces it).
- **Verification on the code that ships.** Node suite: 56 files, **2388 of 2388** pass (no crash, no rate-limit 429). Browser suite: 546 checks pass.
  The failures that remain - `slots.js` (2 checks and an error), `date-status.js` (3), `form.js` and `accolades.js` (one error each) - depend on the
  development database (its working hours put the suggested date on a Saturday and offer no 09:00 slot) and fail IDENTICALLY, line for line, on a
  pristine checkout of GitHub's `main` that has only the `applyBranding.js` fix. Without that fix the same files die earlier behind the overlay, and in
  the previous full run `calendar.js` (2 checks) and `public-sections.js` (13) failed too; they pass now.

## Known pre-existing issues found (not part of this work)

Entries marked **FIXED** were fixed afterwards at the owner's request - see "Phase 6 follow-up" above.

- **FIXED (Phase 6 follow-up 3).** The nightly ledger job and the cancellation-refund recalculation counted `adjustment` rows as payments.
- **FIXED going forward (Phase 6 follow-up 5), existing rows NOT cleaned - a payment logged through "Log Adjustment / Manual Transaction" (type
  Payment, `POST /api/admin/transactions/manual`) was recorded TWICE.** The route inserted the transaction itself (`insertManualTransaction`) and
  then called `logPaymentEvent(..., 'MANUAL_PAYMENT_RECORDED')`, which inserted another `transactions` row for the same payment (a different
  reference, `MANUAL-<booking>-<timestamp>`, method `payfast`); `bookings.amount_paid` went up once. Every transaction-based figure doubled it
  (dashboard revenue, trend, P&L, the reconciliation CSV), the nightly ledger check flagged the booking, and a cancellation refund recomputed
  `amount_paid` from the doubled rows. **Any payment already logged this way in a real database still has its twin** (a `transactions` row with
  `reference LIKE 'MANUAL-%'`, `payment_method = 'payfast'` beside a row with the admin's reference, same booking and amount): count them before
  deciding on a one-off clean-up.
- **Found, verified by running it, NOT fixed (owner to decide) - a REFUND adds to the dashboard revenue.** Refunds are stored as positive
  amounts, and `getPeriodRevenue` / `getTransactionRevenueTrend` / the analytics queries sum `amount` with no refund handling: after a R2,000
  payment and a R400 refund the dashboard and the 12-month trend read +R2,400 (net would be +R1,600), while the P&L ignores refunds and reads
  +R2,000. The accountant CSV's `Effective_Received` has the same refund problem; the reconciliation screen's row query nets refunds correctly.
- **Observed in the rendered PDFs, not investigated:** an invoice for a quotation WITHOUT VAT still carries the "TAX INVOICE" title and the
  sentence "This is a valid Tax Invoice for VAT purposes in terms of section 20..." (`isTaxInvoice` in `js/pdfService.js` depends on the amount,
  not on whether VAT is charged).

- **FIXED.** **Dashboard "Pending quotes" is always R0 / 0, and the Financial Controls P&L "gross revenue" is always R0**: both queries
  (`routes/admin/financials.js`, `GET /api/admin/bookings/:id/expenses` in `routes/admin/bookings.js`) read `quotations.total`, a column that
  does not exist (it is `total_amount`); the SQL error is swallowed by the callback. One-word fix each.
- **FIXED (Phase 6 follow-up 2).** **A manual adjustment is undone by the invoice regeneration it triggers.** `POST /api/admin/transactions/manual` (adjustment) changes
  `bookings.total_amount`, then regenerates the open invoice from the quote lines; the new invoice is for the quoted total and the booking
  ledger snaps back (R5,000 quote, R1,000 credit: total R4,000, then R5,000 again, invoice -R2 for R5,000). Independent of the rate card.
- **FIXED.** The finance CSV lists a booking once **per invoice including VOID ones** (`LEFT JOIN invoices`), so a regenerated invoice repeats the
  booking's Total Amount on several rows.

- **FIXED.** **The Quote Builder's "Notes / Terms" text accumulates stale deposit fragments.** `calcQuoteTotal` strips the previous deposit lines with
  `/^\d+% Deposit.*?\n?/im` - lazy `.*?` followed by an optional `\n?` matches only the words "50% Deposit" - so each edit of a price,
  quantity or the discount leaves a leftover "(R x) required to secure the booking. / R y" block behind a fresh one. Measured on a one-line
  quote: 2 fragments on opening, 6 after four price edits, four of them with outdated amounts, and the "Payment terms" line loses its
  "50% Deposit" words. That text is printed on the quotation PDF and stored in `quote_details.terms`. Unchanged since before this work.
- **FIXED (final pass).** A missing branding / favicon file made every public page raise the full-page "404 Page Not Found" overlay:
  `js/applyBranding.js` probes the file with `fetch`, and `notificationService`'s global fetch wrapper turns any non-API 404 into that overlay.
  The probe now passes `bypassInterceptor`. The local database's `favicon` setting still points at `images/branding/1791828268902-logo5.png`,
  which is not on disk - the page now just keeps the default icon (see `docs-internal/favicon.md`).
- **FIXED.** Invoices (the shared footer) said "Quotes are valid for 14 days."
- The Quote Builder's row totals use the en-ZA format ("4 400,00") while the summary uses "4400.00".
- `GET /api/admin/bookings/full` picks a booking's latest quotation that is not VOID; the paginated list and the detail pick the latest that is
  not archived. They agree in practice but are two definitions.

- `tax_rates` gains one identical VAT row on **every server start** (607 rows): the seed uses `INSERT OR IGNORE` with no unique key.
  Harmless to VAT maths (all rows identical) but unbounded.
- `lib/document-totals.js` `resolveLineTaxClasses` reads the **current** `tax_class` of a service when a document is regenerated.
- **Test-suite flakes (timing, not logic).** `test/inbox-sync.test.js`'s child process starts its scenario as soon as its polled tables exist,
  while `database.js` init is still inside the banners table-rebuild transaction; when that rebuild hits `SQLITE_LOCKED` it rolls back and
  takes the child's first inserts with it ("FOREIGN KEY constraint failed"). Reproduced about 1 run in 12 under parallel load, identically with
  and without the rate-card migration. `booking.test.js` "full refund re-derives payment_status" failed once in a full run and passed 4 of 4
  alone. Baseline failures that are always red today: the six PayFast ITN checks in `payment-callback.test.js` (`/favicon.ico` was fixed in the
  final pass - see `docs-internal/favicon.md`).
- **FIXED (final pass) - the tracking limiter was a shared 10-call budget in the test suite.** `trackRateLimiter` (public booking tracking and
  document downloads: 10 per 15 minutes per address) was the only hand-tuned limiter that was not switched off under `NODE_ENV=test`. All test
  files share one server and one address, a full run makes 11 such calls, so the 11th got a 429 and `service-visibility.test.js` crashed with
  "Cannot read properties of undefined (reading 'quote_amount')" - and because a crash stops the runner, every test file after it silently never
  ran. It passed earlier only because the count happened to be 10. The limiter is bypassed under `NODE_ENV=test` like its siblings;
  `test/rate-limiters.test.js` runs the real limiter in a child process and proves production still refuses the 11th call.
- The suite runner cannot run a single file; a scratch runner that boots `test/support.js` and requires the named test works.

## Maintaining the rate card

The card is valid until **31 December 2026**. When it expires or a new card is issued: edit the fees in **Admin -> Services** (they are
ordinary rows; changing a fee never alters saved bookings, quotes or invoices - those snapshot their own prices), update
`rate_card_valid_until` / `rate_card_updated` in `settings`, and add a new `lib/rate-card-YYYY.js` migration only if services are being
added, renamed or removed in bulk. Nothing switches off automatically on 31 December.
