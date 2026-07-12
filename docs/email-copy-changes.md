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
