# Business profile, tax registration and letterhead (Oct 2026)

Living document. Phase 1 audit written 2026-10-23, before any code changed. Brief: `business_docs/business_settings_tax_and_invoice_prompt.md`
(gitignored - the repo is PUBLIC, so the owner's registration papers in `business_docs/` never ship).

## 1. What exists today (and stays as it is)

| Area | How it works now | Verdict |
|---|---|---|
| Company identity on documents | `js/pdfService.js` constructor: `COMPANY_NAME/ADDRESS/EMAIL/WEBSITE` env vars with hard-coded defaults ("Thabiso Mhlongo Management", "Johannesburg, South Africa"). None of them is set in `.env`. Used by quote, invoice, contract and advancing-pack headers/footers | HARDCODED - replace with the profile |
| Our VAT number | `OUR_VAT_REG = process.env.COMPANY_VAT_NUMBER` (unset). Printed in the header only when `isTaxInvoice`; also switches VAT ON for any invoice >= R5,000 (`applyVat = booking.apply_vat \|\| (isTaxInvoice && OUR_VAT_REG)`) | HARDCODED - replace |
| VAT on a quote | A per-quote tick box (`#qbApplyVat` -> `apply_vat` in `quote_details` JSON). Rate = `getVatRate()` (`tax_rates` default row, 15 %). Stored on the quote (`vat_rate`); invoices/contracts reuse the stored basis (`lib/approved-quote.js`) | KEEP - the engine is correct; add a gate in front of it |
| Document title | Quote PDF says QUOTE; invoice always says INVOICE (owner's 2026-10-19 decision; `test/invoice-title.test.js`) | EXTEND - QUOTATION; TAX INVOICE only when VAT-registered + verified + VAT charged |
| Issued PDFs | Written to disk once; downloads stream the stored file (`routes/admin/bookings.js`, `routes/public/bookings.js`). Regeneration creates a NEW revision (`INV-...-R2`) | KEEP - historical PDFs cannot change |
| Invoice/quote numbers | `INV-YYYY-NNNN[-Rn]`, `QT-<booking>-<stamp>[-Rn]` | KEEP, untouched |
| Banking | `bank_details` (versioned, one active row, `invoices.bank_details_id` remembers the version) + `eft_settings`; admin card on Finance > EFT Payments. Validation in `lib/eft-core.js` | KEEP - single source for banking; the profile page only DISPLAYS it |
| Settings | `settings` key/value table; `GET/PUT /api/admin/settings` has NO key whitelist and any admin role may write any key; GET returns every non-smtp key to every admin | NOT SAFE for tax/identity data - new dedicated route + table; generic PUT must refuse the new keys |
| Roles | `requireRole([...])`: administrator / manager / assistant (dev DB: 1 / 2 / 1) | reuse |
| Audit | `logAudit({tableName, recordId, action, req, oldValues, newValues})` -> `audit_log` | reuse |
| Secrets at rest | `lib/smtp-config.js` encryptSecret/decryptSecret | reuse for the director ID number |
| Stored text | request bodies are entity-encoded once by `deepEscapeBody`; Accolades/Team store DECODED text | follow Accolades/Team: decode on input, store decoded, render as text |
| Customer VAT number | `bookings.vat_number` (+ `clients.vat_number`), printed in the Bill-To box | KEEP; add address when present |
| Customer address | `clients.billing_address` exists but nothing captures it | follow-up (see section 6) |

Dev DB facts (read-only look, 2026-10-23): `bank_details` v1 active - holder, account number and SWIFT match the details supplied in the brief;
the stored branch code is `051001` (Standard Bank universal code) while the brief says `009953` - NOT changed, owner to confirm from the bank letter.
`tax_rates` has 618 identical VAT rows (pre-existing, +1 per boot; harmless to `getVatRate`, not fixed). 13 of 18 dev invoices carry tax.

## 2. Reused / extended / new

* Reused: settings route pattern, `requireAdmin` + `requireRole`, `logAudit`, `encryptSecret`, `computeDocumentTotals` + `getVatRate` (untouched), `bank_details`, the PDF generator and its brand look, the admin Settings tab + `atl-*` / `um-*` components, `notificationService.showConfirm`.
* Extended: `pdfService` header/footer/title/info cards (look kept), quote route (VAT gate + snapshot), `generateInvoice` (issuer + due date), Quote Builder (VAT box follows the profile), Settings (one new tab).
* New: table `business_profile` (one row), `lib/business-profile-core.js` (pure rules, shared by route/PDF/tests), `lib/business-profile.js` (DB), `routes/admin/business-profile.js`, `js/admin/business-profile.js`, `issuer_snapshot` column on `quotations` and `invoices`.

## 3. Regression risks and how they are covered

1. Quote/invoice money must not move -> totals code is untouched; tests compare stored totals before/after, `pdf-golden`, `quote-flow`, `financial-history`, `adjustments` suites re-run.
2. VAT gate must not break existing accepted quotes -> gate only on NEW quote creation; invoice/contract rebuild keep using the stored basis. Test: change registration after a quote and after an invoice; totals and files unchanged.
3. Legacy callers of `generateDocument` without an issuer -> fall back to the old env identity; tested.
4. Golden PDFs change (header band/footer/title) -> regenerate once, review the text diff by eye.
5. Generic settings route could overwrite profile keys -> profile is its own table; test that `PUT /api/admin/settings {business_*}` cannot touch it.

## 4. Legal / compliance verification (Phase 9) - what was checked and what was not

Checked against public SARS and Companies Act material on 2026-10-23 (secondary summaries of s20 VAT Act; SARS "Tax Invoices" checklist, 2016 version).
**Not legal advice - confirm with the accountant before turning VAT on.**

| Rule | Source / status | How it is implemented |
|---|---|---|
| Full tax invoice needed when the supply (incl. VAT) exceeds R5,000; abridged allowed R50-R5,000 (VAT Act s20) | SARS checklist (verified via search summary; the PDF itself could not be text-extracted here) | Not hard-coded as a block. Used only to raise a **warning** when a VAT-registered business issues an invoice over R5,000 without the customer's name/address/VAT number |
| Recipient's VAT number is required on a full tax invoice **when the recipient is a VAT vendor** | SARS checklist | Printed whenever captured; NEVER fabricated; absence = warning, not a blocker (individuals and non-vendors have none) |
| Supplier name, address and VAT number on a tax invoice | SARS | Header band + footer when VAT-registered and verified |
| Document may be called "tax invoice", "VAT invoice" or "invoice" | SARS checklist wording | TAX INVOICE is a presentation choice only when VAT is registered + verified + actually charged |
| Company name and registration number legible on invoices, letters, quotes (Companies Act s32) | lawlibrary.org.za consolidation (via search); contravention is an offence | Always printed for company profiles (header band + footer), independent of tax settings |
| VAT number = 10 digits starting 4 | secondary sources only | Format check only (`/^4\d{9}$/`); a separate "verified on SARS eFiling" attestation is required before VAT is used |
| Income-tax reference = 10 digits | SARS registration notice | Format check `^\d{10}$` |
| CIPC registration no. `YYYY/NNNNNN/07`; enterprise no. `K` + 10 digits | CIPC certificate in `business_docs/` | Format checks |
| VAT rate 15 % + effective date | `tax_rates` | Read-only display; engine unchanged |
| Income-tax registration does not imply VAT registration | SARS | Two independent switches; VAT requires the tax switch (a VAT vendor is a registered taxpayer) |

Quote validity: the brief suggests 30 days "if consistent with existing settings". Existing behaviour is 14 days (`QUOTE_VALIDITY_DAYS`, builder minimum 3 days) -> left at 14; owner can ask for 30.

## 5. Source documents vs the brief (checked by reading `business_docs/`)

* Registration no. 2025/575967/07, enterprise no. K2025575967, tracking no. 9439823846, registered 19/07/2025, private company, in business, FYE July, director Thabiso Mhlongo appointed 19/07/2025, address 59 Stone Crest, Frederick Street, Kengies, Fourways, Gauteng - match.
* SARS notice: registered name MTV CREATIVES, taxpayer reg. no. 2025/575967/07, reference on file with the owner, 2025-07-19, provisional tax from 202508, postal code 0059 - match. (Income tax only; no VAT registration appears in any document.)
* B-BBEE (EME, level 1): certificate number **9439823846 = the CIPC tracking number** (same value, as supplied), issued 19-Nov-2025, expires 18-Nov-2026 - match. EME certificate: no separate certificate number exists, so this is expected, but the two fields are kept separate.
* The bank letters returned no extractable text and no PDF renderer is installed here, so they could not be read - banking figures could only be compared with `bank_details` (match except branch code).


## 6. What was built (2026-10-23)

**Data.** Migration 110 (`lib/business-profile-schema.js`, hooked in `database.js`): table `business_profile` (single row, `CHECK (id = 1)`), plus `issuer_snapshot TEXT` on `quotations` and `invoices`. The seed holds only CIPC-public facts (legal name, registration / enterprise / tracking numbers, dates, registered address, director's NAME, B-BBEE certificate) and both registration switches OFF. It never contains the income-tax reference, the director's ID number, banking or a personal email. An existing `COMPANY_VAT_NUMBER` env setting is carried over once as VAT-active (that variable already made the old PDF code add VAT). `INSERT OR IGNORE`: restarts never overwrite an administrator's edits. Nothing is deleted or rewritten; existing quotations/invoices simply have `issuer_snapshot = NULL`.

**Rules (`lib/business-profile-core.js`, pure).** Validation shared by the route, the preview and the tests; `vatActive()`; `issuerView()` (the only thing a document may say about us); `documentTitle()`; `taxInvoiceAdvice()`.

| Setting | Effect |
|---|---|
| Tax registered = off | Nothing about VAT changes. The income-tax reference is not required, never printed, and stays on file. |
| Tax registered = on | Income-tax reference (10 digits) required. Still no VAT. Not printed on documents. |
| VAT registered = on (needs tax on) | VAT number (`4` + 9 digits) required. VAT is **active** only after "I have confirmed this VAT number with SARS" is ticked; changing the number resets that confirmation. |
| VAT active | Quote Builder VAT box usable (unticked by default, as before); header + footer show the VAT number; an invoice that charges VAT is titled **TAX INVOICE**; VAT row preceded by a "Subtotal (excl. VAT)" row. |
| VAT not active | `POST .../quote` with `apply_vat` -> 400 `VAT_NOT_ACTIVE`; Quote Builder box greyed out + explained; documents say "Not registered for VAT" when the owner has said so outright; invoices are **INVOICE**. |
| Individual | No CIPC number needed or printed; company details kept on file, not deleted. |

**Documents (`js/pdfService.js`).** One header band (legal name + `Reg No` + `VAT No`, registered address, customer-facing contact) and one footer (identity, registered office, contact) shared by quotation, invoice, agreement and advancing pack; the brand bar, cards, tables and colours are unchanged. Quotation: title QUOTATION, QUOTE DATE + VALID UNTIL (the chosen expiry, 14-day default unchanged), acceptance instruction as the first line of the terms. Invoice: INVOICE DATE, PAYMENT DUE (the stored due date, now passed in so the PDF and the record agree), QUOTE REF, customer address when one exists, "Paid to date" / "BALANCE DUE" when money had been received at issue. Removed: the amount-based "isTaxInvoice" guess and the `COMPANY_VAT_NUMBER` auto-VAT fallback. Spacing was tightened so a normal quotation still fits one page; a terms block that would run into the footer now moves to the next page.

**History.** PDFs are stored files and are never regenerated; downloads stream them. A new quotation freezes the issuer on its row; an invoice follows the issuer of the quotation it was built from (so a later VAT change cannot re-label an agreed document), and a regenerated invoice is a new `-Rn` revision whose number is never reused. Totals, VAT rate and tax classes of an approved quotation come from the stored basis (`lib/approved-quote.js`) exactly as before.

**API / security.** `GET/PUT /api/admin/business-profile`, `POST .../reveal-director-id`, `POST .../preview` (a real PDF from the unsaved form values, nothing saved). Administrator writes; manager reads (income-tax reference masked); assistant refused. Registration changes need `confirm_registration_change` (409 `CONFIRM_REQUIRED`); `version` guards concurrent edits (409 `STALE`); every save is in `audit_log` (old/new, reason); the director ID is encrypted (`SETTINGS_ENCRYPTION_KEY`/`SESSION_SECRET`), shown only by an audited reveal. The generic `PUT /api/admin/settings` cannot reach the profile (separate table). Managers cannot open Settings in the admin UI at all (sidebar), so the tab is administrator-only in practice.

**UI.** Business > Business Profile (own sidebar page since the 2026-10-23 reorganisation, six tabs; administrator edits, manager views, assistant has no access) (built by `js/admin/business-profile.js`): six cards (Business Profile, CIPC and Directors, Tax and VAT, Banking and Payments [read-only summary of `bank_details` + link], Addresses and Contact Details, B-BBEE and Compliance) + Letterhead preview. Drop-downs for type / enterprise type / status / year-end, `type=date` pickers, large tick boxes with plain-language explanations, a live "what this means for new documents" panel, a Save, a Discard and an "unsaved" indicator on EACH card (a card sends only its own fields; unsaved edits in other cards are kept and a registration confirmation lists only that card's changes), field errors from the server beside the field, 44 px controls and no sideways scroll at 390 px.

**Files.** New: `lib/business-profile-core.js`, `lib/business-profile.js`, `lib/business-profile-schema.js`, `routes/admin/business-profile.js`, `js/admin/business-profile.js`, `css/admin/business-profile.css`, `test/business-profile.test.js`, `test/browser/business-profile.js`. Changed: `database.js`, `app.js`, `admin.html`, `js/pdfService.js`, `js/admin/bookings-quote.js`, `lib/invoicing.js`, `lib/contracts.js`, `routes/admin/bookings.js`, `routes/admin/services.js` (`vat_active` in `/meta`), `routes/admin/advancing.js`, `test/support.js` (throwaway DB is a VAT vendor; `apiBinary` takes a body), `test/invoice-title.test.js`, `test/browser/run-all.js`, regenerated `test/golden/quote|invoice.golden.txt` (diff reviewed: letterhead, footer, title, date rows only).

## 7. Open items and things only the owner can settle

1. **VAT status.** No document in `business_docs/` shows a VAT registration (only income tax). The seed leaves VAT OFF, so on the live site VAT quotations are blocked until the owner ticks VAT, enters the number and confirms it with SARS. Dev data holds 13 of 18 invoices with VAT; if the business was never a VAT vendor, VAT charged on those is for the accountant.
2. **Income-tax reference** (as printed on the SARS notice) and the "registered for tax" tick must be entered on the live site (kept out of the public repo on purpose).
3. **Branch code.** Stored `051001` vs supplied `009953`; not changed (it would redirect client payments). Check the bank letter, then change it in the EFT card (a new version; issued invoices keep theirs).
4. **Customer address capture.** `clients.billing_address` exists but nothing fills it, so a VAT-registered invoice over R5,000 will only be *advised* (not blocked) about the missing customer address / VAT number. Capturing it on the booking form is the follow-up.
5. **Quote validity** stays 14 days (the brief suggested 30 "if consistent": it is not). One-line change if wanted.
6. `COMPANY_VAT_NUMBER` / `COMPANY_*` env vars on Render: the identity now comes from the profile; check the VAT variable is not set unintentionally (if it is, the first boot carries it over as VAT-active).
7. Email sign-offs still say "Thabiso Mhlongo Management" (brand voice, not the legal entity) - left as is.
8. Pre-existing and unrelated, found while testing: git tracks `test/.test(1).sqlite` (a 13 MB OneDrive duplicate, in a PUBLIC repo) and `cleanup-test-data` fails on it; `tax_rates` still gains a row on every boot (618).

## 8. Test results (2026-10-23, isolated test DB, ports 32xx)

* `test/business-profile.test.js`: 113 checks PASS; 7 deliberate mutations (VAT gate removed, TAX INVOICE without registration, VAT active without confirmation, invoice ignoring the quotation's snapshot, no confirmation on registration change, manager allowed to write, VAT number change keeping its confirmation) each made it fail, then were reverted.
* `test/browser/business-profile.js`: all checks PASS (desktop + 390 px phone, manager / assistant views, Quote Builder VAT box).
* Full node suite: 3080 / 3082. The 2 failures are NOT from this work: `cleanup-test-data` "no SQLite file tracked by git" (git tracks `test/.test(1).sqlite`) and the documented calendar timing flake (CP6; it was CP5/CP6/CP21 before - passes alone). One earlier run also failed the hourly-quote PDF check once with an empty extraction; it passed 3 more times (twice alone, once in the final full run) - treated as a timing flake, not reproduced.
* Full browser suite: every file passes except `public-sections` (Gallery "More") and `accolades` (15 s timeout), which fail identically on an untouched export of HEAD.
* NOT TESTED: real PayFast sandbox checkout against the new letterhead (the PayFast/EFT suites in the node run, 13/13 + EFT flows, pass and none of that code was touched); print rendering on paper; Windows/Mac PDF viewers other than Chrome's; a real SARS check of the VAT number.

## 9. Local dev database (2026-10-23)

At the owner's request the LOCAL `database.sqlite` was upgraded (migration 110 steps applied directly, not by booting the app) and filled from the brief: income-tax registered = ON with reference on file with the owner (from the SARS notice), VAT = OFF, bank details untouched (branch code question still open), no director ID stored. A backup of the files as they were is outside the repo (session scratchpad). Existing quotations/invoices were not touched (their `issuer_snapshot` is NULL = "issued before the profile existed"). The next normal start of the dev server re-runs the same idempotent statements. The LIVE site is not affected: it gets the table on its next deploy, with both switches OFF, and the same two entries (tick + reference) must be made there through Settings > Business Profile.

## 10. SARS number families (2026-10-23, owner's note)

All three are 10 digits; the first digit tells them apart: **VAT 4**, **PAYE 7**, **income tax 0 / 1 / 2 / 3 / 9** (several secondary guides agree; no official SARS page was found, and the company case rests on one guide). The rules therefore refuse only the clear mix-ups: an income-tax reference starting with 4 ("looks like a VAT number") or 7 ("looks like a PAYE reference"), and a VAT number starting with 0 / 1 / 2 / 3 / 9 ("looks like an income-tax reference"). Any other first digit is accepted for the income-tax reference so a genuine number is never turned away. PAYE / UIF / SDL references are not stored (nothing in the system uses them). Tests: `test/business-profile.test.js` "rules:" checks.

## 11. Is there a VAT number in the supplied documents? (checked 2026-10-23)

No. Every PDF in `business_docs/` was searched (page text and embedded streams) for a 10-digit number starting with 4. The only match is `4570229049`, which is the "organizationIdentifier" inside the LAWtrust digital-signature certificate stamped on Standard Bank's *Account Holder Record* - the e-signature provider's own identifier, not MTV CREATIVES'. The numbers that ARE MTV CREATIVES': registration 2025/575967/07, enterprise K2025575967, CIPC tracking / B-BBEE certificate 9439823846, CIPC name-reservation 9439823913, income-tax reference on file with the owner (starts with 9 = income tax), bank account 10254296341 (11 digits). Not checkable: the two bank confirmation letters are image-only scans with no text layer. The VAT number `4123456789` that appears in test data and the preview is the made-up example from `compliant_pty_ltd_invoice_template.pdf`, never a real number. Conclusion unchanged: nothing supports VAT registration, so VAT stays OFF and the VAT number stays blank until the owner holds a SARS VAT registration letter.

## 12. Quotation/invoice header redesign (2026-10-25)

Owner-supplied prompt asked for a clean, left-aligned, vertically-stacked header (one item per line: business name, Reg No, VAT No, address line(s), e-mail) and for the hard-coded "Thabiso"/"Mhlongo" wordmark - drawn as native PDF text in a dark rounded card, not an image, but functioning exactly as a fixed logo - to be removed from the quotation and invoice headers specifically and replaced with a name chosen dynamically from Business Profile.

**Scope kept to quotations and invoices**, per the prompt's own wording ("this requirement applies to the quotation and invoice document headers"). `js/pdfService.js` `_drawHeader(doc, type, ...)` now branches on `type`: for `'Quote'`/`'Invoice'` it skips the wordmark card entirely (gold bar stays, now plain) and calls the new `_drawIssuerBandStacked()`; for `'Agreement'`/`'Advancing Pack'` it is byte-identical to before (wordmark card, single crammed `legalName t/a tradingName · Reg No · VAT No` line) - unchanged on purpose, confirmed by `test/contract.test.js` (24/24) and a rendered preview.

**Name priority flipped.** The old header always led with `legalName`, with `tradingName` appended as `t/a ...`. `lib/business-profile-core.js` `documentBusinessName(issuer)` is the new, single rule (used by nothing else - the footer and the contract header keep printing `legalName` first, unchanged): trading name when meaningfully set (trimmed, non-blank - that is what the field is for), else the legal name, which for an individual/sole-proprietor profile already IS the business name the owner typed (the admin UI's own field label already says "Full legal name or trading name" for that business type). Registration number and VAT number are never dropped - they print on their own line(s) directly under the name, exactly as before, just no longer crammed onto the name's line.

**Address as separate lines.** `registered_address` (etc.) was already stored with one address component per line, but `issuerView()`'s `registeredOffice` collapses it to a single comma-joined line for every OTHER caller (contract footer, audit views) - still does. A new `addressLines` array on the issuer carries the un-collapsed lines (capped at 4, a defensive bound, not a real-world limit) for the header only. `lib/business-profile.js` `snapshotOf()`/`issuerFromSnapshot()` carry `addressLines` through the frozen `issuer_snapshot` too, so a FUTURE regeneration of a document issued from now on keeps its multi-line address; a snapshot frozen before this change has no `addressLines` and falls back to its one-lined `registeredOffice` as a single line (never a crash, never a blank line - and moot in practice, since an already-issued PDF is a stored file and is never re-rendered from its snapshot unless the owner explicitly regenerates it, per §1 "Issued PDFs... Regeneration creates a NEW revision").

**No field prints empty.** Reg No only for a company with one on file; VAT No only when VAT is active (same gate as before); address lines only the ones that exist; e-mail only if set. A business profile with nothing but a name renders a 1-line band, not a padded one.

**Admin UI**: the existing `trading_name` field (Settings > Business Profile; was already there, nothing new added) — its hint changed from "Printed as 't/a ...' next to the legal name" to "Shown as the business name at the top of quotations and invoices. Leave blank to use the registered company name there instead," and the card's own description dropped the now-inaccurate "the name here is the legal name printed on every document."

**Files touched:** `lib/business-profile-core.js` (`addressLines` field + helper, `documentBusinessName`), `lib/business-profile.js` (`snapshotOf`/`issuerFromSnapshot` carry `addressLines`), `js/pdfService.js` (`_drawHeader` branch, new `_drawIssuerBandStacked`), `js/admin/business-profile.js` (hint text). Regenerated `test/golden/quote.golden.txt` / `invoice.golden.txt` (diff reviewed: header lines only - the wordmark's "Thabiso Mhlongo" text is gone from the extracted text, the identity block is now one line per item; everything below BILL TO is byte-identical).

**Tests:** `test/business-profile.test.js` 120/120 (incl. the individual-profile and company-switch scenarios that check the prominent name), `test/pdf-golden.test.js` 22/22 against the regenerated goldens, `test/contract.test.js` 24/24 (confirms the untouched path). Visually reviewed via a direct `pdfService.generateDocument()` render (no DB) screenshotted through headless Chrome: trading name set, legal-name fallback with VAT off (no blank line where VAT would go), a long trading name + long single-line address (no overlap, no truncation), and no address/no e-mail at all (clean 3-line band, no gaps). NOT separately tested: print rendering on paper; PDF viewers other than Chrome's.

### 12b. Two-tier name, same day: gold bar = trading name, dark band = always the registered name

Owner's follow-up (reference screenshot, annotated): the gold bar's top-left (previously left blank once the logo was removed) should carry the SAME trading-name-or-registered-name the dark band's first line carried in §12 above - and that first dark-band line should change to ALWAYS be the registered company name, never the trading name. So the two rows now answer different questions instead of one of them repeating the other only when no trading name is set: gold bar = "who you're dealing with" (brand), dark band = "who this legally is" (registered entity), every time.

`_drawHeader` (quote/invoice only) now draws `documentBusinessName(issuer)` top-left of the gold bar (Helvetica-Bold 14, dark text on gold, width 206pt so it can never reach the title on the right, `height:42` so a long name wraps to two lines before `ellipsis:true` truncates a third). `_drawIssuerBandStacked`'s first line changed from `documentBusinessName(issuer)` to plain `issuer.legalName`. Gold bar height (68px, set in §12) was kept fixed rather than grown to fit a long name - deliberately, after §12's lesson about a taller header spilling a page; a long name wraps/truncates within the existing space instead.

**A real, unrelated defect found and fixed while verifying this:** `test/support.js`'s `extractPdfText()` (the test harness's own hand-rolled PDF text reader, used by every PDF-content test in the suite) found a stream's end by searching for the next literal `endstream` after it - which can appear BY CHANCE inside the preceding stream's own compressed binary bytes, truncating it and silently losing everything read after that point (no exception - the function just returns less text than the PDF actually has). A client's VAT number happened to push the BILL TO box's content stream a few hundred bytes past whatever threshold made this stream's compressed bytes contain that sequence, and `test/invoice-title.test.js`'s two VAT-number checks started coming back with an empty string - looked exactly like a real header regression for a while. Fixed to read each stream's own `/Length N` (PDFKit always writes one, a direct integer, immediately before `stream`) and take exactly that many bytes, falling back to the old delimiter search only for a stream whose `/Length` is an indirect reference (embedded font programs in the agreement/advancing-pack header, whose size isn't known until after they're written) - confirmed against `test/contract.test.js` (24/24, unchanged). This bug was dormant before today just because nothing had yet produced a content stream the wrong number of bytes to trigger it; it would have resurfaced on some future unrelated change regardless.

**Also found:** `test/support.js`'s own throwaway-DB reset (used by every test file, not just this one) fixes `business_profile.legal_name` and the tax/VAT fields to known values on every test run, but NOT `trading_name`, `registered_address`, `physical_address` or `postal_address` - a test that reads one of those without first setting it itself inherits whatever the OWNER currently has typed into the real dev database (found live today: the owner had set a trading name and flattened the address to one line through Settings while this work was in progress, breaking a brand-new test of mine that assumed the original seeded 3-line address - fixed by giving that check its own explicit fixture instead of reading the live row). Not fixed in `test/support.js` itself (a wider reset than this task needed); flagged here as a latent gap for whichever test next assumes a default trading name or a multi-line address without setting it explicitly.

Regenerated goldens again (diff: header lines only, same as §12). Final regression: node suite full run, `test/business-profile.test.js` 122/122 (incl. the two new pure-rule checks from §12, both updated and now immune to live-DB drift), `test/pdf-golden.test.js` 22/22, `test/contract.test.js` 24/24, `test/invoice-title.test.js` 7/7 (the two that exposed the extractor bug, now passing for the real reason).

### 12c. Gold-bar name sized and aligned to match the title (2026-10-25, later same day)

Owner's follow-up: make the gold bar's top-left name (added in §12b) as big as the `TAX INVOICE` / `QUOTATION` title and align it with that title, for both document types.

`_drawHeader` now measures the gold-bar name with a shrink-to-fit loop instead of a fixed 14pt: starting at 22pt (the title's own size) and stepping down (Helvetica-Bold, 1pt at a time, floor 11pt) until it fits the 206pt-wide column, then measures its wrapped height at that size (`doc.heightOfString`) to get `topNameH`. The gold bar's height becomes `Math.min(100, Math.max(68, 24 + topNameH + 10))` - still floored at the old 68px for a short one-line name, still capped at 100px so a very long name cannot push the document to a second page (the exact failure mode hit and fixed in §12), but now grows between those bounds for a medium name that needs 2 lines at a readable size. The name is drawn at `y:24` - the same y the title is drawn at - so a short name that stays at the full 22pt sits exactly level with the title; a name that has to shrink or wrap starts at the same top edge and grows downward into the bar instead of being vertically centred, which is what "aligned with the title" means here (both start the same distance from the top of the gold bar).

Visually verified via three rendered + screenshotted PDFs (short trading name "Thabiso Comedy" - full 22pt, level with the title; the registered name with no trading name set, medium length - shrinks to fit one line, still level with the title; a long made-up trading name - shrinks to 11pt and wraps to two lines, gold bar grows to accommodate, document still confirmed one page).

**Unrelated test-infrastructure gap found and fixed while verifying this:** `test/business-profile.test.js`'s browser counterpart (`test/browser/business-profile.js`, specifically "saving the Addresses card stores ITS fields only") started failing - not because of the font-size change, but because `test/support.js`'s DB reset (flagged as a gap in §12b, not fixed there) left `trading_name` and the address fields exactly as the owner had them typed in the live dev DB at the moment the throwaway copy was made, so the test's own before/after comparison no longer matched its hard-coded expectation. Fixed this time, properly: `test/support.js`'s reset block now also clears `trading_name` and resets `registered_address`/`postal_address` to the canonical 3-line seeded address (`physical_address` cleared), for every test file, closing the gap §12b only flagged.

**Final regression, run twice:** a scoped run (`invoice-title pdf-golden business-profile quote-flow contract installment-plan eft-flow adjustments`) - 441/441. A full `node test/run.js` run immediately after crashed mid-way with `TEST RUN ERROR: fetch failed` / `SQLITE_BUSY: database is locked` (the server process's own uncaught exception, not a test assertion) right after `graph.test.js` finished cleanly - matches the one-off SQLITE_BUSY flake class already on record (concurrent Claude sessions in this same folder; see memory `concurrent-sessions-warning` and `test-suite-timing-flakes`), not reproduced on an immediate rerun. Rerun of the full suite: **3147/3153**, and the 6 failures are the exact 6 already on record as pre-existing/unrelated as of today's earlier §12b baseline (3145/3151) - 2 more passing checks this time matches exactly the 2 new pure-rule checks added in §12. The 6: 2 nav-label mismatches (admin-nav-reorganisation session, unrelated), 1 "no SQLite file tracked by git" (`test/.test(1).sqlite`, pre-existing, §7 item 8), and 3 inbox-sync "off by default"/"verify-before-enable"/"Sync now while off" checks (another session's in-progress work leaking from the shared dev-DB copy, not reproduced in isolation). No new failure attributable to this change.
