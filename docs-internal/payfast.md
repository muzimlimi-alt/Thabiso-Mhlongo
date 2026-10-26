# PayFast - configuration, how it works, what testing against the real sandbox found

## Local = sandbox, never live

A local run must talk to PayFast's **sandbox**. The owner's own sandbox account (free: https://sandbox.payfast.co.za, enter an e-mail) gives a merchant id, key and
passphrase; they go in the local `.env` as `PAYFAST_URL=https://sandbox.payfast.co.za/eng/process`, `PAYFAST_MERCHANT_ID`, `PAYFAST_MERCHANT_KEY`,
`PAYFAST_PASSPHRASE`. The live values stay in `.env` only as commented lines (`# LIVE (disabled for local use ...)`).

- `app.js` copies the `settings` table (`payfast_url`, `payfast_merchant_id`, `payfast_merchant_key`, `payfast_passphrase`) over the environment at start-up
  when a value is non-empty, so the settings rows in the local database must agree with `.env` (a stale live row would win).
  `PUT /api/admin/settings` (administrators only) applies a change to the running process immediately; a direct edit needs a restart.
- The ITN handler decides sandbox vs production from `PAYFAST_URL` containing `sandbox`. In sandbox mode it logs a signature / source-IP / confirmation
  failure and carries on; in production each of those is a hard reject. The app refuses to start with `NODE_ENV=production` and a sandbox URL.
- **`BASE_URL` names the LIVE site in the local `.env`** (it feeds e-mail links). PayFast's return, cancel and notify URLs used to be built from it, so a local
  sandbox payment sent its notification - and the buyer - to production. They now come from `PAYFAST_BASE_URL` when it is set (`lib/payfast-signature.js`
  `payfastBaseUrl`), otherwise `BASE_URL`, otherwise the request's own host. Locally set it to `http://localhost:3000`.
- **PayFast cannot reach `localhost`**, so on a local run the buyer comes back, PayFast says "payment successful", but no notification arrives: the booking stays unpaid
  (symptom: the booking has a `payfast_payment_intents` row and NO `payment_logs` row). The buyer's browser can reach localhost; PayFast's servers cannot.
  **To finish a payment locally** run `node scripts/dev-itn-forwarder.js --write-env`, then restart the site and pay again. It starts an ngrok tunnel (installed at `C:\ngrok`)
  to a tiny forwarder that passes ONLY PayFast's form POST to `/api/payment/webhook/payfast` to the local site - the site, the admin, the customer pages and every other API
  answer 404 through the tunnel, so the local database is never exposed - and writes `PAYFAST_NOTIFY_BASE_URL=<tunnel>` into `.env`. That setting overrides the notification
  URL only (`payfastNotifyBaseUrl`); the return and cancel pages keep using `PAYFAST_BASE_URL=http://localhost:3000`. Leave the window open while testing; the tunnel address
  changes every time it starts (run the script, restart the site). A payment made BEFORE the tunnel was up is not recorded retroactively (PayFast does not re-send to a dead
  address): pay again. Tested by `test/itn-forwarder.test.js`. Never set `PAYFAST_NOTIFY_BASE_URL` on the live site.
  (The older way - `ngrok http 3000` and the https address in `PAYFAST_BASE_URL` - still works but exposes the whole local site to the internet.)
- **Live site:** none of this applies; PayFast reaches Render directly. If a notification is ever missed there (a deploy at that moment, PayFast retries exhausted) the
  client has paid and the booking would stay unpaid - the **safety net** below finds such a payment in PayFast's own records and records it.
- PayFast's **shared test merchant (10000100) is not usable for a signed checkout**: its passphrase is unknown, so PayFast refuses every signature we send
  ("Generated signature does not match submitted signature") although it accepts an unsigned form. Use your own sandbox account.

## The two signatures (PayFast's documented recipes, `lib/payfast-signature.js`)

| | checkout form we post | notification (ITN) PayFast posts to `/api/payment/webhook/payfast` |
|---|---|---|
| fields | every NON-blank variable, in PayFast's documented order | EVERY posted field except `signature`, in the order received, blank ones included |
| values | trimmed, PHP `urlencode` | not trimmed, PHP `urlencode` |
| passphrase | `&passphrase=` + urlencoded, when set | the same |

PHP's `urlencode` encodes `! ' ( ) * ~` which JavaScript's `encodeURIComponent` leaves alone (`phpUrlencode`).

## What testing against the real sandbox found (2026-10-19, owner's sandbox merchant)

1. **The ITN was verified with the checkout recipe, which drops blank fields.** Every real ITN carries 11 blank fields (`item_description`, `custom_str1-5`,
   `custom_int1-5`), so the signature could never match. In production that is a hard reject: every genuine payment would have been thrown away (client charged,
   booking left unpaid). Sandbox mode hid it by carrying on. Now verified with PayFast's own recipe; a real ITN verifies (proved against PayFast), the old check
   does not.
2. **The old signature was refused by PayFast whenever a name or e-mail contained `'`, `(`, `)`, `*`, `!` or `~`** (e.g. "D'Souza"); the PHP-style encoding is accepted.
   `& + % . space` and non-ASCII were fine both ways.
3. **`app.js` entity-encodes every request body** (`D'Souza` -> `D&#x27;Souza`), so the ITN's values no longer matched what PayFast signed, and PayFast's server
   confirmation (`/eng/query/validate`) was sent the encoded copy. The route now keeps the body as posted (`req.pfRawBody`, set in `app.js`) for the signature check
   and the confirmation call; everything stored is still the encoded copy.
4. PayFast was sent stored text: a client shown as `O&#x27;Brien`, an event "Smith &amp; Sons" as `Smith amp Sons`, and "50% Deposit" as "50 Deposit". Now decoded first;
   `%` is kept.
5. PayFast's `query/validate` ignores the signature (it checks the data against its own record): a wrong or missing signature still answers VALID. It is not a
   substitute for the signature check.

Verified end to end with the real sandbox: signed checkout accepted, buyer pays, a REAL ITN reaches the app through a tunnel and is recorded once with PayFast's
payment id and a VALID confirmation, a cancelled payment records nothing, and the old recipe fails the same ITN. The run used an isolated copy of the app on a fresh
synthetic database (no customer data was exposed through the tunnel) that was deleted afterwards.

## The safety net - a payment PayFast received but never told us about (2026-10-20)

The notification (ITN) is the only way the site learns of a payment. If it is lost (local site, a deploy at that moment, retries exhausted) the client has paid and the
booking stays unpaid. The safety net asks PayFast's **own transaction history** and records what it finds. The one rule: *a payment is recorded only when PayFast's records
show it AND it matches a payment attempt of ours exactly; anything else is reported to a person, never credited.*

**What counts as a match** (`planRecovery` in `lib/payfast-api.js`, pure and DB-free): the row is money RECEIVED (`FUNDS_RECEIVED`, `CREDIT`), in ZAR, its reference
(`m_payment_id`) equals a still-pending attempt in `payfast_payment_intents` exactly, its amount equals the attempt's amount to the cent, it was made no earlier than the
attempt began (2 min allowance for clocks), and its PayFast id is not already in the ledger. The earliest matching row is recovered; a second matching row is a
`duplicate_payment` finding (the client may have paid twice and be owed a refund). Anything else with that reference is a `mismatch` finding (wrong amount, other currency, made
before this attempt). If recording would breach a rule (the booking would exceed its total, the reference names another booking) it is a `blocked` finding.
**An instalment that is already settled another way is never credited again**: when the attempt's instalment (`..._SCHED<id>`) is already `paid` - an EFT approved, a payment recorded by
hand - or, for the older deposit / full-amount attempts, the booking is already DEPOSIT_PAID / PAID, PayFast's money is a second payment for it and is reported as a
`duplicate_payment` finding ("the client may have paid twice and be owed a refund, or the other payment may have been recorded in error"). It is checked in the preview too
(`alreadySettledReason`, and again inside the recording transaction). This is the real case of booking 100054 on the owner's dev database: an EFT proof had been approved for the same
R10,350 instalment that PayFast also took.

**Recording** (`recordRecovered` in `lib/payfast-reconcile.js`) is one `BEGIN IMMEDIATE` transaction and is the same payment the notification records: one `transactions`
row (`source = 'payfast'`, `pf_payment_id` = `reference` = PayFast's id, method from PayFast's funding type), the booking credit through `applyPayfastPaymentToBooking`
(so the shared overpayment guard applies), the intent marked `fulfilled`, the invoice PAID when the booking is paid in full. The ledger's UNIQUE `pf_payment_id` makes it
safe against the notification arriving at the same moment or later (the late notification is ignored as a duplicate - proved in both orders). After the commit the usual
follow-up runs (payment-received e-mail, balance-due / confirmed / receipt e-mails, calendar sync, auto event, milestone alignment) and the owner is e-mailed that a payment
had to be recovered (a sign notifications are not arriving). A booking cancelled in the meantime is still recorded (it is real money) and the e-mail says a refund may be due.

**When it runs**
- every 5 minutes in the background (first run 2 minutes after start): attempts older than 10 minutes and younger than 21 days; costs one tiny query when none are waiting;
- when a buyer returns from PayFast (`?payment=success` on the booking page): `POST /api/public/bookings/:id/payment-check` (`routes/public/payfast-check.js`) - behind the
  booking's e-mailed-code session for THAT booking, once per 30 s per booking, only attempts at least 30 s old, answers a status word only (`recorded|waiting|busy|nothing|unavailable`);
  the page looks right away, then about 35 s and 90 s later;
- an administrator: Finance -> Reconciliation -> **PayFast safety net** panel: *Check PayFast now*, *Preview* (says what would be recorded and changes nothing - no credit, no
  finding, no state, no e-mail), the findings list and *Mark dealt with* (a note is required; audited). Administrators and managers only
  (`/api/admin/payfast/reconcile`, `.../run`, `.../findings/:id/resolve`). Resolving a finding never credits anything.

**PayFast API facts** (`lib/payfast-api.js`, verified against PayFast's PHP SDK and the real sandbox): `GET https://api.payfast.co.za/transactions/history?from&to&offset&limit`
(sandbox: same host with `testing=true`, which is not signed), headers `merchant-id`, `version: v1`, `timestamp` (South African time, `+0200`) and `signature` = md5 of ALL header and query
values sorted alphabetically plus `&passphrase=` when the account has one - a different recipe from the checkout's. The answer is CSV (`204` = nothing). `401` = credentials
refused, `429` = slow down (honours `Retry-After`).

**Failure behaviour:** PayFast unreachable / refusing / answering nonsense changes NOTHING; the failure is stored (`payfast_reconcile_state`), shown on the panel (category, count, when
it will try again), the background run backs off (5 min doubling to 1 h; credentials refused: 1 h) and the owner is e-mailed once (straight away for refused credentials, after 3 in a
row otherwise). Success clears it. A live account whose API access is not set up shows as that credentials failure - it is harmless, and the e-mail says what to check.

**Settings:** it uses the PayFast settings already there (`PAYFAST_MERCHANT_ID`, `PAYFAST_PASSPHRASE`, sandbox vs live from `PAYFAST_URL`). `PAYFAST_RECONCILE=off` switches it off;
`PAYFAST_API_URL` (tests) and `PAYFAST_RECONCILE_MIN_GAP_MS` are for the test server only. Tables: `payfast_reconcile_state` (one row) and `payfast_reconcile_findings` (migration 109);
both are in the booking-delete purge and the production test-data cleanup tool.

## Tests

`test/payfast-signature.test.js` (both recipes against a literal port of PayFast's PHP, special characters, blank fields, legacy fallback),
`test/payfast-itn-signature.test.js` (the webhook through the real route, incl. special characters and the checkout fields), `test/payfast-base-url.test.js`,
`test/payment-callback.test.js`, `test/installment-plan.test.js`, `test/itn-forwarder.test.js`. The safety net: `test/payfast-api.test.js` (signature vs a literal PHP port,
CSV from real sandbox rows, paging, error mapping, the matching rules incl. the real booking-100054 case), `test/payfast-reconcile.test.js` (the real server against
`test/fake-payfast-api.js`, a stand-in for PayFast's API as strict about the signature as PayFast), `test/browser/payfast-reconcile.js` (the buyer's return page and the admin panel).
The test server runs the sandbox with merchant 10000100 and no passphrase (`test/support.js`) and points `PAYFAST_API_URL` at the fake, so no test can reach PayFast.
