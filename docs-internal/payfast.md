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
- **PayFast cannot reach `localhost`**, so on a local run the buyer comes back but no notification does: the booking stays unpaid. To finish a payment locally run
  `ngrok http 3000` (installed at `C:\ngrok`), put the https address in `PAYFAST_BASE_URL`, restart, and pay. ngrok shows a notice page to browsers once.
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

## Tests

`test/payfast-signature.test.js` (both recipes against a literal port of PayFast's PHP, special characters, blank fields, legacy fallback),
`test/payfast-itn-signature.test.js` (the webhook through the real route, incl. special characters and the checkout fields), `test/payfast-base-url.test.js`,
`test/payment-callback.test.js`, `test/installment-plan.test.js`. The test server runs the sandbox with merchant 10000100 and no passphrase (`test/support.js`).
