# Email Copy Changes — Prompt 3 (PREMIUM rebuild)

Before/after copy for the most-changed emails. **All dynamic variables, subjects, recipients,
attachments, amounts, references and links are preserved** — only presentation and prose changed.
Rendered samples: `email-previews/premium/*.html`.

---

## 1. Booking Request Confirmation (client) — `sendBookingReceivedEmail` (client half)

- **Subject (unchanged):** `Booking Request Confirmation: Thabiso Mhlongo`
- **Trigger / recipient (unchanged):** public booking submitted → client; ICS invite still attached.

**Before:** bespoke `<p>` intro + a hand-rolled dark `<table>` "Booking Summary" + a centered
italic "keep your reference safe" line. No CTA. Depended on `createEmailWrapper` styles.

**After:** components — preheader, wordmark + text-headline, greeting, one intro paragraph, an
`infoCard` "Booking Summary · Ref #…", a **"Track Your Booking"** `ctaButton`, and the standard footer.

> After body: "Thank you for reaching out to book Thabiso Mhlongo for your upcoming **{event_type}**
> on **{event_date}**. Our management team has received your enquiry and will be in touch shortly to
> confirm availability and discuss pricing. Keep your booking reference **#{id}** safe — you'll need
> it to track your booking status."

---

## 2. Quotation — `sendQuoteEmail`

- **Subject (unchanged):** `Quotation for Booking #{id}` · **PDF attachment preserved.**
- **Amounts:** the computed `itemsHtml` service breakdown and `Total Quote: {amount}` are kept
  **verbatim** (no figure or calculation touched).

**Before:** `<p>` intro + terms + `itemsHtml` table + "Total Quote" + a raw gold `<a>` button.

**After:** components — preheader, headline "Your Quotation", greeting, an intro that folds the
"PDF attached" note into one warmer sentence, terms, the **unchanged** breakdown + total, and a
bulletproof **"Review & Accept Quote"** button (same `…&action=accept` URL).

> "We've prepared a formal quotation for your upcoming event, **{event}** on **{date}**. The full
> breakdown of services and terms is attached as a PDF for your records."

---

## 3. Quote Accepted / Invoice Issued — `sendQuoteAcceptedEmail`

- **Subject (unchanged, conditional):** `Invoice Issued – Booking #{id}` / `Quote Accepted – Booking #{id}`.
- **Amounts:** the `paymentScheduleHtml` schedule (with due dates + amounts) is kept **verbatim**.
  ICS invite preserved.

**Before:** `<p>` intro + a styled "Payment Schedule" table + a small grey due-date note.

**After:** components — headline mirrors the state ("Invoice Sent — Awaiting Payment" / "Quote
Accepted"), greeting, one combined intro sentence, the **unchanged** schedule, the due-date note, and
a **"View Your Booking"** CTA (new, to the tracker).

---

## 4. Booking Under Review — `sendBookingUnderReviewEmail`

- **Subject (unchanged):** `Your Booking Is Under Review — Ref #{id}`.
- **Bug fixed in passing:** the old body referenced an undeclared `event_name` (never destructured),
  which threw a `ReferenceError` on every send — the email never actually went out. Now destructured
  and rendered as `event_name || event_type`.

**Before:** `<p>`s + a raw gold `<a>` "Track Your Booking" button.

**After:** components — preheader, headline, greeting, one paragraph, an `infoCard` (Event / Date /
Reference), and the bulletproof **"Track Your Booking"** button (same tracking URL).

---

## 5. Quote Expired — `sendQuoteExpiredEmail`

- **Subject (unchanged):** `Your Quote Has Expired – Booking #{id}`.

**Before:** two `<p>`s with an inline "submit a new enquiry" link; reference shown as a trailing line.

**After:** components — headline "Your Quote Has Expired", greeting, a warmer two-sentence body that
keeps the reference inline, and a **"Submit a New Enquiry"** CTA (same `/index.html#booking` link).

> "Your quote for **{event}** on **{date}** has expired and is no longer valid. If you're still
> interested in booking Thabiso Mhlongo, we'd be glad to prepare a fresh quote — just submit a new
> enquiry and we'll take it from there. (Booking reference #{id})"

---

### Also rebuilt in Batch 1 (minor copy change)

- **Quote Expires Tomorrow** (`sendQuoteExpiryWarningEmail`) — same message, now componentised with an
  **"Accept Your Quote"** CTA (same `/index.html#track` link).

---

# Batch 2 — confirm & lifecycle

All six componentised; subjects/recipients/attachments/figures preserved. Notable changes:

- **Event Date Updated** (`sendDateChangedEmail`) — *most-changed of the batch.* The old email used a
  **light-mode table** (`#f5f5f5` cells) inside the dark email — visually broken. Now a proper dark
  `infoCard` with the previous date struck through and the new date highlighted gold. Same track-URL
  CTA and `bookings@` contact line.
- **Booking Confirmed** (`sendBookingConfirmedEmail`) — performance details fold into a single
  "Confirmed Booking" `infoCard` (event/date/venue/slot/duration/ref); gains a **"View Your Booking"**
  CTA to the tracker. ICS attachment + 🎉 subject unchanged. Copy warmed ("Wonderful news…").
- **Booking Cancelled** (`sendCancellationEmail`) — the policy block becomes an `alertStrip`
  (force-majeure = gold "action", otherwise neutral); **refund figure `R {refund_due}` kept verbatim**,
  as are the no-refund and 5–7-business-days lines.
- **Event Completed** (`sendBookingCompletedEmail`) — services + financial summary become two
  `infoCard`s; **all amounts (subtotal/VAT/total/paid) render with the exact same computed strings**.
- **Review Request** (`sendReviewRequestEmail`) — same message; the mailto link becomes the
  **"Send Your Review"** CTA button (same mailto URL).
- **Enquiry Expired** (`sendPendingExpiredEmail`) — same message; gains a **"Submit a New Enquiry"**
  CTA (same `/index.html#booking` link).

*(Not in this batch: `sendPaidReceiptEmail` merely re-sends the invoice via `sendInvoiceEmail`, which
is payment-critical Batch 3.)*

---

# Batch 3 — payment-critical A

**Figures, references, and links are byte-identical** (locked by `test/email.test.js`, which asserts
the queued HTML contains the exact amount strings and exactly one shell). Changes are presentation
and prose only:

- **Invoice** (`sendInvoiceEmail`) — schedule table kept **verbatim**; PDF + `Invoice Reference: #{id}`
  unchanged; gains the standard **View Your Booking** CTA. Also covers `sendPaidReceiptEmail` (which
  re-sends the paid invoice through this function).
- **Invoice Pre-Due** (`sendInvoicePreDueEmail`) — the old summary card used `display:flex`, which many
  email clients (Outlook) ignore entirely; now a table-based `infoCard` (Invoice #, Due Date,
  `R {amount}` highlighted). Same **Pay Now** URL and day-pluralised subject.
- **Invoice Overdue** (`sendOverdueInvoiceEmail`) — same flex→infoCard fix, and the **red (#ef4444)
  text/button is replaced with the design system's amber** (`alertStrip`, severity `alert`) per the
  no-red-on-black HARD RULE. Amount/dates/URL identical.
- **Payment Received** (`sendPaymentReceivedEmail`) — the three figure strings keep their exact
  original format (`R{amount}` with **no space**, e.g. `R400.00`); conditional Partial/Full subject
  unchanged; remaining balance amber when > 0; gains the tracker CTA.

---

# Batch 4 — payment-critical B

Same rule as Batch 3: figures/references/links byte-identical, locked by the extended
`test/email.test.js` (now 64 assertions, incl. a live deposit → cancel → refund chain).

- **Deposit Received — Balance Due** (`sendDepositBalanceDueEmail`) — `R{outstanding}` (no space,
  in subject + body) verbatim; balance in an `infoCard`; **Settle Your Balance** CTA (same tracker link).
- **Payment Unsuccessful** (`sendPaymentFailedEmail`) — `R{displayTotal}` (no space) verbatim; gains a
  **Try Payment Again** CTA to the tracker (previously no CTA at all).
- **Refund Processed** (`sendRefundProcessedEmail`) — *most-changed of the batch.* Same defect as the
  earlier Date-Changed fix: the old table used **light-mode `#f5f5f5` cells inside the dark email**.
  Now a dark `infoCard`; `amtFormatted` (`R {amount}`, **space kept**) and the reference render verbatim.
- **Payment Reminder** (schedule cron, `runScheduleReminderJob`-family) — the old email built its
  **entire standalone HTML shell** (own `<div>` wrapper + attached `logo4.png`) rather than a body for
  the central wrapper; now uses `renderPremiumEmail` + `preWrapped:true`, so the CID logo attachment
  is redundant and dropped (the component header already renders the wordmark). `R {amount}` verbatim.
- **Quote Still Open** (`runQuoteFollowUpJob`) — `R {quote_amount}` verbatim; same accept-URL CTA.
- **Balance Payment Reminder** (event-approaching cron) — same `display:flex` defect fixed as the
  schedule reminder; `R {outstanding}` verbatim (both mentions); same Pay Balance Now URL.

---

# Batch 5 — contract & admin-triggered client

- **Your Booking Contract** (`sendContractEmail`) — PDF + sign URL unchanged; gains a proper
  **Review & Sign Contract** CTA button (was a plain link).
- **Contract Signature Reminder** — rebuilt at **both** call sites (`/contract/remind` route and the
  state-aware `remindBooking` used by bulk reminders). The bulk-reminder path gains a **Review & Sign
  Contract** CTA it never had (previously said "review and sign it from your booking page" with no
  actual link).
- **Request Received** (quote-revision/extension acknowledgement) — same message, componentised.
  (The paired admin notification is SYSTEM-track and untouched — Prompt 4.)
- **Inquiry Reply** and **Direct Message** (Admin Compose) — ***bug fixed, not just restyled.*** Both
  routes built a branded `htmlTemplate` (logo, dark shell, gold divider) that was **never actually
  used** — the `sendEmail()` call passed the raw, unwrapped `replyMessage`/`body` instead. Every inquiry
  reply and every admin-composed message has been going out as **plain unbranded text with no logo, no
  shell, nothing**. Now genuinely wrapped via `renderPremiumEmail` + `preWrapped:true`. Message content,
  recipient, subject and reply-to are all unchanged — only the previously-dead branding now actually
  applies. (The separate, newer "Direct Emails" system — `sendDirectEmail`, with scheduling/CC/BCC/
  per-email branding picker — already worked correctly and was left untouched.)
- **Booking Recovery Reminder** (abandoned draft) — booking-so-far becomes an `infoCard`; its bespoke
  opt-out link is now wired into the standard footer's unsubscribe slot (same purpose, existing
  component) instead of a separate inline sentence. Resume URL unchanged.

---

# Batch 6 — visitor & subscriber (closes out Prompt 3 — all 33 PREMIUM emails rebuilt)

- **Contact Auto-Reply** (visitor receipt) — same message, componentised. (The paired admin
  notification stays SYSTEM-track, untouched — Prompt 4.)
- **Newsletter Welcome** — ***bug fixed, not just restyled.*** Like the inquiry-reply/compose fix in
  Batch 5, this email's unsubscribe link **only ever worked when `EMAIL_OVERHAUL_ENABLED=true`** (the
  legacy wrapper looks up the subscriber's token; the raw fallback path — what's actually live — sends
  no link at all, and no wrapper). It now builds the unsubscribe URL directly from the token the
  subscribe request just created and always includes it, regardless of the flag.
- **Scheduled Newsletter** and **Newsletter Broadcast ("Send Now")** — ***same defect, same fix,
  affecting every campaign ever sent to every subscriber.*** Both dispatch loops passed the admin's
  authored HTML straight to `sendEmail()` raw — no wrapper, no per-recipient unsubscribe link, unless
  the flag was on. **The admin's campaign content itself is rendered completely unchanged** — it is
  the message body verbatim, not rewritten copy — but it now always gets the brand shell and a
  genuine per-recipient unsubscribe link (looked up alongside each subscriber's email, one query,
  no extra DB round-trips). Subject, attachments, and the 200ms anti-spam pacing are unchanged.

New guard in `test/email.test.js` (Guard 7): subscribes a fresh test address, confirms the welcome
email is queued pre-wrapped and its unsubscribe link contains **that exact subscriber's token** — not
a shared or missing one. Suite: 68/68.

---
---

# Prompt 4 — SYSTEM-track rebuild (internal admin/ops)

SYSTEM emails use `renderSystemEmail` (compact mono `systemHeader`, no photographic banner, no
social/unsubscribe footer — internal mail) instead of `renderPremiumEmail`. Structure: header → an
`alertStrip` leading with the key fact → body → `infoCard`(s) → minimal footer. Rendered samples:
`email-previews/system/*.html`.

## Batch 1 — booking lifecycle notices

All seven use the exact prose from their originals; the change is presentation (proper table-based
`infoCard`s instead of ad-hoc inline tables/paragraphs) and — same defect class found repeatedly in
Prompt 3 — most of these bodies previously relied on styling that only existed in the legacy
`createEmailWrapper`'s `<style>` block, which is **not present at all** on the live raw path.

- **Booking Received (admin half)** — *most-changed.* The 13-row details table becomes a proper
  `infoCard`; "Additional Notes" and the "Open in Admin" button are preserved verbatim in content and
  URL. **Bug fixed:** the admin body and the separate "Open Booking in Admin" button HTML were
  concatenated as two strings (`adminHtmlTemplate + adminLinkHtml`) — now that the body is a complete
  HTML document, the button is folded inside it instead of appended after `</html>`, where it would
  have been silently dropped by every email client.
- **Quote Sent, Payment Received, Quote Accepted notifications** — same content, now `infoCard` tables
  instead of inline `<table>`/`<p>` markup. Figures (quote amount, amount paid) kept verbatim.
- **Client Cancelled notice** — reason + `R{refund_due}` figure kept verbatim, now in a card.
- **New Review notice** — rating and review text (already HTML-safe via `encodeUserHtml` at intake)
  unchanged; review quote becomes a styled blockquote.
- **Contract Signed notice** — same two-sentence message, componentised.

`test/email.test.js` Guard 4 (isolation) retargeted from the now-migrated "NEW BOOKING REQUEST" to
`/api/admin/forgot-password` (still legacy until Batch 5) so it keeps proving un-migrated SYSTEM email
stay byte-identical. Suite: 68/68 (unchanged count — no new live-triggerable paths this batch beyond
what's already exercised).

## Batch 2 — ops alerts & completion

- **Calendar Sync Failure, Custom Request Alert, Website Inquiry (admin)** — same prose and figures,
  now `infoCard`s. Website Inquiry also drops the `class="text-gold"`/`class="text-muted"` dead-styling
  pattern (same class of bug as elsewhere).
- **Completion Summary** — *most-changed.* Services / Expenses / Profit & Loss become three separate
  `infoCard`s instead of three ad-hoc inline `<table>`s; all figures (quoted, collected, expenses, net
  revenue) render with the exact same computed strings.
- **Stuck-Notification Alert** — the `<ul><li>` list of stuck notification IDs becomes a proper
  `infoCard` table (`#id — status` / `To email · timestamp`), the digest-table pattern the pack asks
  for in Prompt 4. Still dispatched via `sendEmailDirectly` (bypassing the queue — a queue watchdog
  can't queue behind a possibly-stuck queue) with `skipBrandAttachments` preserved.
- **Test Notification** — the old bespoke Arial `<div>` (audit's own example of inconsistent styling)
  is now a standard `renderSystemEmail` call; the "Sent at" timestamp becomes the `systemHeader`'s
  built-in timestamp slot.

Suite: 68/68 (unchanged — no new live-triggerable paths this batch beyond what's already exercised).

## Batch 3 — digests (table-in-card rebuild)

Per the pack's Prompt 4 requirement: digest-style emails get "a compact table layout inside info_card,
one row per item." All five previously built either a `<br>`-joined `<p>` list or a bespoke multi-column
`<table>` with light-on-dark styling; all now use a real `infoCard`. **Every count/total in the subject
line and every per-row figure is kept verbatim.**

- **Enquiries Expiring** — `<br>`-joined list → one card row per enquiry.
- **Overdue Payments** — `<br>`-joined list → one card row per booking; `R{total}` in the subject and
  each row's `R{amount} outstanding` unchanged.
- **Stalled Bookings** — was a genuine 5-column `<table>`; condensed to `infoCard`'s label/value shape
  (`#id — client` / `event · Event: date · Accepted: date`) — no column header is lost, just reflowed.
- **Ledger Discrepancy** — was a 6-column `<table>` (booking/client/event/recorded/tx-sum/drift); same
  condensation, one row per booking, all three dollar figures (`Recorded`, `Tx Sum`, `Drift`) verbatim.
- **PayFast Pending Timeout** — was a 4-column `<table>`; one row per stuck transaction, amount and
  start timestamp verbatim.

New Guard 8 in `test/email.test.js`: since these are cron-only jobs with no admin-triggerable endpoint,
the guard renders through the *exact* `renderSystemEmail`/`infoCard` row-shape used in the server.js
rebuild and asserts (a) the output is a real `<table>`, not a `<br>`-joined list, (b) each row's figure
string appears verbatim, (c) the shell is single and dark-mode-safe. Suite: 71/71.
