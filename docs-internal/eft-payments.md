# Manual EFT payments and proof-of-payment review

Added 2026-10-19 (migration 108). Manual EFT is an **alternative to PayFast, not a replacement**: a client can still pay by card through PayFast exactly as before
(`routes/public/payment.js`, unchanged). With EFT switched on they can also pay into the business bank account and send a proof of payment, which an
administrator verifies against the bank statement before it becomes a payment.

## The three rules everything else follows from

1. **A proof of payment is a claim, never money.** Uploading one writes a `pending` row and a file. It does not touch the booking, the invoice or the ledger. The
   only code that turns a proof into a payment is `approveSubmission()` in `lib/eft-approval.js`, run by an administrator or manager.
2. **Banking details are versioned.** Changing them retires the active row and inserts a new one. An invoice keeps the version it was issued with
   (`invoices.bank_details_id`) - the invoice PDF and the invoice e-mail show that snapshot, and old invoices are never redrawn.
3. **An approved proof is one ordinary ledger payment.** It lands in the same tables, through the same booking-credit statement, as a card payment, so every report,
   the reconciliation CSV, profit-and-loss and cancellation refunds see it - and it can never be recorded twice.

## What changes for whom

| Who | Sees |
|---|---|
| Administrator | Settings -> **Manual EFT & banking details** (switch, upload limit, banking details, version history); Finance -> **EFT Payments** (queue + review drawer) |
| Manager | Finance -> EFT Payments (review, approve, reject). Cannot read or change the banking details or the switches |
| Assistant | Nothing (403 on every EFT endpoint) |
| Client (verified with the e-mailed code) | A **Pay by EFT** panel in the tracking drawer: banking details, the reference to quote, an upload form, the status of their proofs. Only while the booking can still be paid |
| Anyone else | Nothing. No public, unauthenticated endpoint returns banking details |

## Files

| File | Role |
|---|---|
| `lib/eft-core.js` | Pure rules, no database: banking-detail validation, masking, file sniffing, claim/verification validation. Safe to `require` from tests |
| `lib/eft.js` | Database side: switches, banking-detail versions, `createSubmission()`, queue/detail queries, the tracking-page panel |
| `lib/eft-approval.js` | `approveSubmission`, `rejectSubmission`, `requestReplacement` - the only code that writes the ledger for EFT |
| `lib/eft-notifications.js` | The four e-mails (received, rejected / new proof needed, verified, owner alert) |
| `routes/admin/eft.js` | Admin API |
| `routes/public/eft.js` | Client upload + own-proof download |
| `js/pdfService.js` (section 5b) | The "PAY BY EFT" block on the invoice PDF |
| `lib/invoicing.js`, `lib/invoice-email.js` | Snapshot the details on a new invoice; show them in the invoice e-mail |
| `js/admin/eft.js`, `css/admin/eft.css`, `admin.html` | Admin UI |
| `index.html`, `css/public/tracking-modal.css` | Client panel (`renderEftPanel`) |
| `middleware/rate-limiters.js` `popUploadRateLimiter`, `middleware/booking-access.js` | Upload limiter; the access token may also arrive in the `x-booking-access-token` header |

## Data model (migration 108)

- `bank_details` - one row per VERSION: holder, bank, account number, type, branch code, optional SWIFT, reference note, instructions, `is_active`. A unique partial index
  allows exactly one active row. Stored as validated plain text (strict character set; no markup can be stored). **Not** in `settings`: that table's API is readable
  by every admin role and is copied into `process.env` at boot.
- `eft_settings` - one row: `enabled` (default OFF), `max_upload_mb` (1-15, default 5).
- `eft_payment_submissions` - the proof: booking, invoice, optional instalment, what the client claimed (amount, date, reference, note), the stored file (random
  name, detected type, size, SHA-256), status (`pending | approved | rejected | replacement_requested`), the details version shown, who/where from, what the
  administrator verified (amount, bank reference, date), reviewer, and `transaction_id` once approved. A unique partial index makes the link to the ledger 1:1.
- `eft_submission_events` - the history of each proof (submitted / approved / rejected / replacement_requested, who, when, note).
- `invoices.bank_details_id` - the version an invoice was issued with (NULL for invoices issued while EFT was off, and for all invoices before this migration).

Proof files live in the existing private store `docs/payment_proofs/` (disk, or R2 when configured) under `eft-<booking>-<24 random hex>.<ext>`; the extension
comes from the detected type. They are never served as static files.

## The flows

**Turning it on.** An administrator saves the banking details (validated; account number 6-16 digits, branch code 5-8 digits, optional SWIFT) and switches
Manual EFT on. It cannot be switched on without banking details. Both actions are audited (`audit_log`: `BANK_DETAILS_CHANGED`, `EFT_SETTINGS_CHANGED`) with the
account number **masked** (`*******4567`) in the old/new values.

**Changing the details.** `PUT /api/admin/eft/bank-details` creates version N+1 (an identical save creates nothing). The answer says how many unpaid invoices still show the
previous version, so the owner can re-send them. The live tracking page always shows the CURRENT details, with a notice when the client's invoice was issued
with earlier ones; the invoice PDF and e-mail they already hold are untouched.

**An invoice.** `lib/invoicing.js` asks `lib/eft.js` for the state: when EFT is on and details exist, the PDF gets a PAY BY EFT block (holder, bank, account number, type,
branch code, SWIFT if any, invoice number, booking reference, amount payable, payment reference = the invoice number, the owner's note, an instruction to upload the proof, and
"payment is subject to verification and confirmation of cleared funds") and the invoice row remembers the version. The invoice e-mail shows the same snapshot (without the
amount - its payment schedule sits just above). The client's booking page is the "invoice page": it shows the same block with an upload form. A quotation never carries banking details.
The block flows onto a new page when it does not fit.

**The admin preview.** Settings -> Manual EFT shows, as you type and before anything is saved, how the details will appear on an invoice (sample invoice number and amount).

**The client sends a proof** (`POST /api/public/bookings/:id/eft/proof`, multipart):
- the booking access token (the e-mailed-code session) is checked FIRST, from the `x-booking-access-token` header, before multer reads a byte of the file;
- the booking must be ACCEPTED or CONFIRMED and not fully paid; EFT must be on;
- the file is judged by its **bytes**, not its name or declared type: PDF, JPG or PNG only; the declared type must match; size capped by the administrator's limit (1-15 MB);
- the claim: amount > 0 and not more than is still outstanding; date optional, within 180 days, not in the future; free text refused if it contains `< > ` or backticks;
- caps, enforced in the database: at most 3 proofs waiting per booking, 10 uploads per booking per day; the same file twice for a booking is refused; the same file on a
  different booking is accepted but flagged to the reviewer; plus an IP limit of 10 uploads an hour;
- the response and the e-mail say **received and being checked, not yet a confirmation of payment**; nothing says "payment received". The owner is e-mailed that a proof is waiting.

**The administrator reviews** (Finance -> EFT Payments, or the API):
- sees the booking, what the client said, the file (through an authenticated route: `Content-Disposition`, `nosniff`, `no-store`, a sandboxing CSP), any warnings (same file elsewhere,
  amount above the balance, booking cancelled) and the history;
- **approve** needs the amount that reached the bank, the bank's reference and the date. In ONE transaction: the submission flips `pending -> approved` (the guard
  that makes a second approval impossible), ONE `transactions` row is written (`source = 'manual'`, `payment_method = 'bank_transfer'`, `transaction_date` = the day the money
  arrived, `proof_of_payment_path` = the file, `is_verified = 1`, `invoice_id`), the booking is credited with the shared credit statement
  (`applyPayfastPaymentToBooking`: `amount_paid`, `amount_outstanding`, `payment_status` from the schedule - PARTIALLY_PAID / DEPOSIT_PAID / PAID - and the booking moves to CONFIRMED),
  the invoice is marked PAID if that settles it, and the submission is linked to the ledger row. Any failure rolls all of it back. Afterwards, outside the transaction: calendar sync,
  the "payment verified" e-mail, the owner's payment notification, the balance-due / confirmed / paid-receipt e-mails, the auto-created event, and the payment-milestone waterfall;
- an amount above what is still owed is refused (stricter than the card path's R1 tolerance); a booking that is CANCELLED or EXPIRED refuses the payment; a payment with the same
  reference and amount already in the ledger asks for explicit confirmation (`confirm_duplicate`), and the override is on the record;
- **reject** and **request replacement** need a reason the client will read; neither credits anything; both e-mail the client; both are final for that proof (the client can
  upload a fresh one). A proof can be reviewed once.

**Partial payments.** Each approval credits only its verified amount. Three proofs of R1,000 / R1,500 / R2,500 against a R5,000 booking give PARTIALLY_PAID, then DEPOSIT_PAID
(R2,500 covers the first instalment and that milestone turns paid), then PAID with the invoice settled.

## Reconciliation

An approved proof is a `source = 'manual'`, `bank_transfer` transaction with its proof attached, so it appears as `Manual_Received` in the reconciliation CSV, in revenue (once), in the
booking's profit-and-loss, and is covered by the nightly ledger check and by cancellation refunds. The existing ledger "proof" link
(`GET /api/admin/transactions/:id/proof`) serves the same file. The existing admin "record a manual payment" route is unchanged.

## Privacy and retention

- Banking details: not in any public endpoint, not in `/api/admin/settings`, not in `process.env`; returned in full only to an administrator and to a client who has verified their booking
  (they must be able to pay into it). Every log and audit row masks the account number.
- Proof files are private documents. They are removed when an unpaid booking is deleted. POPIA erasure (`lib/popia.js`) clears the client's address, e-mail, note and file name from every
  submission; a proof that never became a payment also loses its file and the reviewer's note; an **approved** proof keeps its file, reference and amounts (a supporting financial record,
  like its transaction). The production test-data cleanup tool (`scripts/cleanup-test-data.js`) knows the new tables and lists proof files it leaves on disk.
- Rate limiting: `popUploadRateLimiter` (10 / hour / address) plus the per-booking caps above.

## Statuses (one source of truth each)

- **Money** stays on the booking: `bookings.payment_status` (`UNPAID -> PARTIALLY_PAID / DEPOSIT_PAID -> PAID`) and `bookings.status` (-> `CONFIRMED`) are written only by the shared credit
  statement, exactly as for a card payment. No second payment-status field was added.
- **A proof** has its own status, which is about the document, not the money: `pending` ("Awaiting verification" to the client, "Waiting for review" to the admin), `approved`
  ("Verified"), `rejected` ("Not accepted"), `replacement_requested` ("New proof needed"). The spec's "Under Review" was not made a separate state: a proof is either waiting or decided,
  and a second waiting state would only have given two ways to say the same thing.
- The client sees "Proof of payment submitted - awaiting verification" after an upload; it persists across refresh and sign-in because it is read from the database on every load.

## Decisions on points the brief left open

- **One bank account, versioned**, not several with a default. The brief said to add multiple accounts only if the architecture supports it safely and it is justified; one active
  account with a full version history covers "change the details without rewriting history" and avoids a second source of truth for which account an invoice used.
- **Which invoice a proof belongs to** is not a customer choice: a booking has one live (non-void) invoice, and the proof is recorded against it (and optionally the next instalment).
- **CSRF**: admin and public routes follow the existing model (session cookie `SameSite=Strict` in production; the client routes are authenticated by the e-mailed-code token sent as a
  header, which a cross-site form cannot set). No separate CSRF token exists in this application.

## Not done / deliberately out of scope

- No virus scanning of uploads (PDF, JPG, PNG only, content-sniffed, served `nosniff` with a sandboxing CSP).
- No automatic matching of a proof to the imported bank statement (the existing bank-statement import is unchanged and still matches by reference).
- WEBP is accepted by the admin "record a manual payment" route but not as a client proof (the requirement was PDF / JPG / PNG).
- With EFT off, the invoice e-mail keeps its existing sentence ("...or via bank transfer using the details in the invoice") although no details are printed; with EFT on it points at the block above it.

## Tests

`test/eft-core.test.js` (rules), `test/eft-invoice-pdf.test.js` (the PDF block), `test/eft-flow.test.js` (the whole flow against the real server: RBAC, versioning, snapshot, upload
validation, "an upload credits nothing", approve/reject/replacement, partial payments, double and concurrent approval, overpayment, reconciliation CSV, deletion, POPIA),
`test/rate-limiters.test.js` (the upload limiter, production vs test), `test/browser/eft.js` (the client panel, the review drawer and the settings card in headless Chrome,
including a 390px phone).

## Defects found while building this (not caused by it, not fixed)

- **`test/calendar.test.js` CP5 / CP6 / CP21 are a known timing flake** (already recorded before this work: they failed on the pushed code too, roughly every other run). CP5 failed in all three
  full runs made from inside the OneDrive folder and CP6 in two, yet the SAME code passed 2652/2652 from a copy outside it, the last pushed commit passed 2387/2387, and calendar.test.js passes
  alone and after the files that precede it. The test is timing-fragile by construction (`makeConfirmed` waits a fixed `sleep(200)` for the auto-created event, and CP5 reads the event straight
  after a response that does not wait for the event update). Untouched by the EFT work; the right fix is to poll in the test or await the write in the handler. Rerun the file before suspecting a change.
- **`DELETE /api/admin/bookings/:id` fails (HTTP 500, rolled back) for any booking that has a payment reminder on record.** Cause: `BOOKING_DELETE_PURGE` (routes/admin/bookings.js) deletes
  `payment_schedules` BEFORE `reminders_log`, and `reminders_log.schedule_id` references `payment_schedules`. It is not a race and retrying does not help; it only looks intermittent
  because a booking gets a reminder row once the reminder job has sent one. (I first took it for a race with the reminder job - wrong; another session found the real cause.) Not fixed here
  (unrelated, and the owner has not approved it): the fix is to move the `reminders_log` purge above `payment_schedules`. The failing statement is now named in the server log
  (`[Delete] Cascade failed ... [at: ...]`), and `test/eft-flow.test.js` keeps its test booking away from the reminder job so this check is about the proof, not about this bug.
- The invoice e-mail says "bank transfer using the details in the invoice" although invoices carried no banking details before this work (still true with EFT off).
