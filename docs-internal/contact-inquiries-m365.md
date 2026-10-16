# Contact form + Inquiries <-> Microsoft 365 (OAuth) - integration log

Living document for the 8-phase integration of the public **Contact** section (`index.html`) and the admin **Inquiries** section
(`admin.html`) with the Microsoft 365 mailbox `bookings@thabisomhlongo.com`. Each phase appends its own section when it is *verified*
(not merely written). The transport itself (OAuth sign-in, queue, attachments) is documented in [smtp-email.md](smtp-email.md).

> The repository is public: no tenant IDs, client IDs, secrets or tokens belong in this file. Placeholders only.

**Status (2026-10-16): phases 1-8 complete and verified; nothing committed or pushed yet.** Start with section 8 (what the owner must do, configuration, rollback, troubleshooting); the audit (section 1) lists what was wrong
(D1-D14; D15 and D16 were found while building: the Reply button never linked a reply to its inquiry, and the Inquiries screen showed entity-encoded names/subjects such as `O&#x27;Brien`).

## Phase 1 - Discovery and current-state audit (2026-10-15)

### 1.1 Architecture as found

```
VISITOR  index.html #contactForm -> js/myscript.js (submit handler, line ~112-200)
           POST /send-email                          routes/public/misc.js:193  (ipRateLimiter + bookingRateLimiter 5 / 15 min / IP)
             |- category contains "booking"  -> bookings row (legacy: PENDING, date 'TBD')      bookings.repository insertLegacyBookingFromContactForm
             |- every other category         -> inquiries row (status 'unread')                  inquiries.repository insertInquiry
             |- sendEmail() x2 (QUEUE ONLY)  -> notifications row (pending)  [outbox]           js/emailService.js:155
                                                  |- admin notification  to = body.recipientEmail || contact_info.email || sender
                                                  |- visitor receipt     to = body.email
             lib/background-clerk.js processNotificationQueue (every 20 s, 10 rows, 3 retries, systemic-fault pause, 24 h expiry)
             -> sendEmailDirectly -> deliver() -> nodemailer SMTP + XOAUTH2 (M365) -> email_logs ('success' = accepted by Exchange)

ADMIN    admin.html Inquiries -> js/admin/inquiries.js
           list/detail/status/assign/priority/category/notes/bulk/delete   routes/admin/inquiries.js  (requireAdmin + requireRole)
           reply composer = the generic "direct email" composer             routes/admin/direct-emails.js (requireAdmin + requireRoleForInquiryEmail)
             draft/schedule/send -> lib/direct-emails.js sendDirectEmail -> sendEmail() (QUEUE ONLY) -> same outbox
             success of the *queue insert* -> direct_emails.status = 'sent' and markInquiryReplied()  (status 'replied', responded_at once)
DB       inquiries (+ audit triggers, status/priority CHECK triggers, SLA overdue derived), inquiry_notes, direct_emails, notifications,
         email_logs, contact_info (single row, `email` = delivery address chosen in Admin -> Contact Details), audit_log
```

What already works and must be preserved: the outbox (durable, retried, pauses on systemic M365 faults, expires after 24 h), the OAuth
transport and queued attachments, RBAC on inquiry routes (status/assign/priority/bulk = manager+, delete = administrator, inquiry-linked
emails = manager+), audit triggers, POPIA consent capture, SLA "overdue" flag, notes, categories, convert-to-booking, the branded
templates (`renderSystemEmail` / `renderPremiumEmail`), Quill HTML sanitising (`sanitizeAboutHtml`) on reply bodies.

### 1.2 Defects found (ranked)

| # | Severity | Finding | Evidence |
|---|---|---|---|
| D1 | **High - live functional bug** | Contact notifications go to a **placeholder address**. The browser sends `recipientEmail` read from `localStorage.tm_contact_data`, falling back to `'thabiso@example.com'`; that key is only ever *written* by the admin Contact page (`js/admin/contact.js:84`), i.e. in the admin's own browser. For every real visitor the server therefore receives `thabiso@example.com`, and `receiver = recipientEmail \|\| contact_info.email` (`misc.js:236`) never reaches the configured address. | dev DB: 11 `Contact Form: Admin Notification` log rows to `thabiso@example.com`; 3 of 4 inquiries have `receiver_email = thabiso@example.com` |
| D2 | **High - security** | The server **trusts client-supplied recipients**: `recipientEmail` (anyone can set it) and `email`, which is used as the visitor-receipt `to`. `sanitizeEmailInput` strips only CR/LF, so `email = "a@x.com,b@y.com,..."` makes nodemailer send the branded receipt to every listed address. The site can be used to send attacker-chosen mail to arbitrary people from the official domain. | `misc.js:199-202,236,280,305` |
| D3 | Low (corrected in Phase 3) | **Output escaping relied on a global side effect**: the contact handler put `email`, `cell`, `name` and `subject` into HTML (`<a href="mailto:...">`, the visitor greeting) with no escaping of its own. It was *not* exploitable through the JSON form only because `app.js` `deepEscapeBody` happens to entity-encode every body string first; one exempted path or a changed middleware would have opened an HTML-injection route into mail sent to arbitrary addresses (see D2). | `misc.js:259-260,296-298` (old) |
| D4 | High - reliability | **Persistence is not guaranteed and success is unconditional**: the DB insert is fire-and-forget (callback only `console.error`s), the queue results of both `sendEmail()` calls are ignored, and the handler returns `{success:true}` regardless. A DB failure still tells the visitor "sent", and no reference number is returned. | `misc.js:243-253,304-314` |
| D5 | High - workflow | **"Booking Inquiry"** (first option of the dropdown) is routed to the legacy `bookings` table and **never creates an inquiry**: the admin cannot see or reply to it from Inquiries. Routing is decided by user-controlled free text (`category.includes('booking')`). | `misc.js:239-245`, `index.html:618` |
| D6 | **High - requirement violation** | **"Replied" is set when the reply is merely queued.** `sendEmail()` returns success after the `notifications` insert (`emailService.js:204`); `sendDirectEmail` then marks `direct_emails.status='sent'` and calls `markInquiryReplied()` (`lib/direct-emails.js:114-119`). If M365 later refuses the message (3 retries -> `notifications.failed`) the inquiry stays *replied/answered*, and the UI has already said "Message sent successfully". | code read; no notification->inquiry feedback path exists |
| D7 | Medium | **No conversation record / no delivery link**: no `Message-ID`, direction, source, `In-Reply-To`, delivery state or attempt count per message; `direct_emails` has no `notification_id`; `email_logs` rows are not linked to inquiries. The inquiry detail shows no reply history. | schema read |
| D8 | Medium - security | **Reply recipient and inquiry id are not bound**: `POST /api/admin/direct-emails` accepts any `inquiry_id` (not checked to exist) with any `to_emails`/`cc`/`bcc`/`reply_to` (no server-side format validation). A manager can send from the shared mailbox to arbitrary addresses labelled as a reply to inquiry N. | `routes/admin/direct-emails.js:76-108` |
| D9 | Medium | **No spam / duplicate control**: no honeypot, no minimum-fill-time check, no content de-duplication (double submit = 2 inquiries + 2 emails), the limiter is per-IP only and is *shared with booking submissions*, no per-address cap on the visitor receipt (a third party's inbox can be mail-bombed through the form). | `middleware/rate-limiters.js`, `misc.js` |
| D10 | Medium - privacy | `console.log('[DEBUG] /send-email body:', req.body)` writes name, email, phone and message text to the server log on every submission. | `misc.js:194` |
| D11 | Medium | **Weak server-side validation**: no email format check (`EMAIL_FORMAT_RE` exists in `lib/validation.js` but is unused here), no phone check, no length caps (name/subject/message bounded only by the JSON body limit), `category` is free text. | `misc.js:195-217` |
| D12 | Medium - product gap | **Customer replies are invisible to the portal.** Replies go out from `bookings@` with `Reply-To` = the same mailbox, so the customer's answer lands only in the Outlook inbox. There is no inbound path, no thread, no bounce (NDR) detection. | no inbound code exists |
| D13 | Low | After a successful reply the compose view closes and the list refreshes, but a *failed* `/send` surfaces only as "Sending failed. Saved as draft." from a 500; a queued-then-failed message is never surfaced to the admin at all. | `js/admin/inquiries.js:1395-1403` |
| D14 | Low | `contact_info` allows saving any text as the delivery email (no format validation) in `POST /api/admin/contact_info`. | `routes/admin/site-content.js:141-148` |

Not defects (verified): RBAC on every inquiries route is present and tested (CP6-CP12 in `test/inquiries.test.js`); inquiry notes take the author
from the session; inquiry list search/sort/status values are whitelisted; the admin UI escapes inquiry text when rendering (`openInquiry`).

### 1.3 Integration approach (decisions to confirm in Phase 2)

1. **One transport, keep it.** Outgoing mail stays on nodemailer + SMTP **XOAUTH2** (client-credentials) that is already live-verified. It reuses
   the outbox, attachments, `email_logs`, supports `In-Reply-To` / `References` (threading) and is already restricted to the single mailbox by
   the Exchange `FullAccess` grant. Graph `sendMail` would add a second transport and a tenant-wide `Mail.Send` application permission; Phase 2 evaluates
   it against Microsoft's documentation and records the verdict.
2. **Reading is the only thing that needs Graph** (Phase 5): `Mail.Read` (application) against **only** `bookings@`, delta-sync with a stored checkpoint.
   The feature ships **disabled by default** and is activated by the owner after consent + scoping (manual M365 steps are listed in Phase 8).
3. **Server-authoritative routing** for the contact form: recipient = `contact_info.email` (falls back to the configured M365 sender, i.e. `bookings@`);
   the client-sent `recipientEmail` is ignored. Visitor address appears only in `Reply-To` and in the stored record.
4. **Persist first, then notify, never lie**: awaited insert of the inquiry (also for "Booking Inquiry", which additionally keeps its legacy booking row and
   is linked to it), a reference number returned, notification queued through the outbox with `related_entity='inquiries'`. M365 being down never fails the
   submission - the outbox retries.
5. **Truthful reply state**: a reply is an `inquiry_messages` row (new table) tied to its `notifications` row; `inquiries.status='replied'` and
   `responded_at` are set **only when that notification reaches `sent`**; a failed reply stays visible as failed with its error and can be retried.
6. **Hardening on the way**: bound inquiry replies to the inquiry's own sender address, validate all addresses server-side, escape every value placed in
   HTML, honeypot + fill-time + content de-duplication + per-address caps, remove the PII debug log.
7. **Schema**: reuse `inquiries`, `inquiry_notes`, `direct_emails`, `notifications`, `email_logs`, `audit_log`; add only what has no home today -
   `inquiry_messages` (thread/audit/delivery), a few additive `inquiries` columns (source, de-dupe hash) and a mailbox-sync checkpoint (in `settings`).

### 1.4 Phase plan and acceptance gates

| Phase | Deliverable | Gate (must be verified before moving on) |
|---|---|---|
| 2 | Foundation: flow choice, Graph vs SMTP verdict from Microsoft docs, permission/scoping design, env vars, secure token handling (reuse `lib/smtp-oauth.js` with a second scope), safe diagnostics | token acquisition for `https://graph.microsoft.com/.default` tested against a fake authority; no secret in logs/responses; documented manual M365 steps |
| 3 | Contact form: validation, persist-then-notify, routing fix, anti-spam, dedupe, truthful responses | tests: invalid/injection/duplicate/spam/limit/outage cases; inquiry saved even when SMTP is down; recipient never from the client |
| 4 | Admin reply workflow: bound recipients, thread view, delivery-aware status, failure surfacing, retry | tests: failed send does not mark replied; forged id/recipient rejected; RBAC on every new endpoint |
| 5 | Mailbox sync (flagged off): Graph delta read, association to inquiries, dedupe by message id, throttling/retry, bounce detection | tests with a fake Graph server: pagination, dedupe, unrelated mail ignored, 429/5xx retry, checkpoint |
| 6 | Schema + audit: migrations, indexes, uniqueness, delivery-state model (queued / attempted / accepted / failed / received), retries | migrations idempotent on a copy of the real DB; unique(message-id); no tokens in logs |
| 7 | End-to-end + regression suite (mock mail only) | new tests green; existing 1259+ stay green apart from the 3 known environmental flakes |
| 8 | Handover doc: Entra/Exchange steps, env vars, dev vs prod, rollback, troubleshooting, outstanding manual actions, final report | owner can follow it without me |

### 1.5 Constraints carried through every phase

No secret/token in files, logs, DB rows shown to the UI, or commits (repo is public). No test mail to real customers: tests use the fake SMTP / token /
Graph servers only. Booking, quotation, invoice, payment, calendar and notification flows stay untouched except where this document says otherwise.

## Phase 2 - Microsoft 365 / OAuth foundation (2026-10-15)

### 2.1 Decisions (checked against Microsoft's documentation, 2026-10-15)

| Question | Decision | Why |
|---|---|---|
| OAuth flow | **Client credentials** (app-only), the flow already live for sending. No user sign-in, no refresh tokens, no mailbox password. | A website back end has no signed-in user; the same app registration and secret serve sending and reading. |
| Sending | **Keep SMTP + XOAUTH2** (`SMTP.SendAsApp`) in `js/emailService.js`. Do **not** add Graph `sendMail`. | It is verified live, restricted to one mailbox by the Exchange `FullAccess` grant, shares the outbox / attachments / `email_logs`, and supports `In-Reply-To` / `References` (threading). Graph `sendMail` accepts custom `internetMessageHeaders` only with an `x-` prefix (so no threading headers), would need a second transport and a tenant-wide `Mail.Send` unless separately scoped. SMTP **Basic** auth is being retired by Microsoft (disabled by default for existing tenants from the end of December 2026); SMTP **OAuth** is the supported replacement and is what this site uses. |
| Reading customer replies | **Microsoft Graph, `GET /users/{mailbox}/mailFolders/inbox/messages/delta`** with the **`Application Mail.Read`** role. | Delta query gives incremental changes, paging (`@odata.nextLink`) and a durable checkpoint (`@odata.deltaLink`); messages carry `internetMessageId` for de-duplication. Read-only, so least privilege. (`Mail.ReadBasic.All` is lower but has no body; the feature needs the body.) |
| Limiting reading to the one mailbox | **Exchange Online RBAC for Applications**: a management scope matching only `bookings@`, assigned to the app with the `Application Mail.Read` role. **Do not** also grant `Mail.Read` in Entra ID. | Microsoft: RBAC grants are *additive* to Entra consents; an unscoped Entra `Mail.Read` plus a scoped RBAC grant means no effective scoping. RBAC for Applications supports Microsoft Graph and replaces Application Access Policies. |
| Mock / dev / tests | Mail stays in mock mode (`SMTP_MOCK=true`): the Graph client refuses to contact Microsoft. Tests use `test/fake-graph.js`. | The dev database holds real pending notifications and real customer data. |

### 2.2 What was built

* `lib/smtp-oauth.js` - `getAccessToken(cfg, { scope })`: tokens are cached **per audience** (`SCOPE` for SMTP, new `GRAPH_SCOPE` = `https://graph.microsoft.com/.default`).
  Same credentials, same TLS verification, same plain-http-loopback-only test rule.
* `lib/m365-graph.js` - the Graph client:
  * credentials come from the **saved Email (SMTP) settings** (`resolveContext()`); there is no second place to store a secret;
  * the mailbox is **pinned**: callers give a path relative to `/users/<configured mailbox>`; stored `nextLink` / `deltaLink` URLs are refused unless they point at the
    same mailbox on Graph (`isOwnLink`), so a tampered database row cannot make the server call another mailbox or host;
  * **GET only** (read-only);
  * retries 429 / 5xx / network failures up to 4 attempts, honouring `Retry-After` (capped at 30 s), exponential back-off otherwise; a rejected token is renewed once;
  * never throws for expected failures: `{ ok:false, category, code, retryable, systemic, message }`. `systemic` means "an administrator must act" (credentials, missing
    Exchange role, mailbox) and tells the sync to stop; `retryable` failures are retried; `resync` means Microsoft dropped the checkpoint. Messages carry Graph's
    `request-id` (useful to Microsoft support) and never contain the error body, a token or the secret;
  * `diagnose()` = three plain-language checks (settings, Graph sign-in, inbox folder counters). It reads folder **counts only**, never a message.
* `POST /api/admin/settings/m365/test-mailbox-read` (administrator only) runs `diagnose()` on the **saved** settings. No form values, so no secret travels in the request.
  The Test button on the Email (SMTP) card is added in Phase 5 together with the sync switch.
* Tests: `test/graph.test.js` + `test/fake-graph.js` (47 checks: audience, token cache, mailbox pinning, link validation, 403/404/410/429/5xx/network/401 handling, back-off
  bounds, no secret/token in any result, production ignores the test base URL, RBAC on the endpoint, mock mode never contacts Microsoft).

### 2.3 Configuration

No new **production** environment variable: everything reuses the Email (SMTP) card / `SMTP_*` variables. Test-only (both ignored or restricted in production):
`SMTP_OAUTH_AUTHORITY` (fake sign-in server) and `M365_GRAPH_BASE_URL` (fake Graph server; plain http only on loopback, never in production).

Secret handling: the client secret is AES-256-GCM encrypted in `settings.smtp_oauth_secret` (or comes from `SMTP_OAUTH_CLIENT_SECRET`), is never returned by any API, never logged,
and access tokens live only in process memory (renewed two minutes before expiry; forced renewal on a 401). Use **separate app registrations and secrets for development and
production**, and never save the live secret on a developer machine; local runs stay in mock mode.

### 2.4 Manual Microsoft 365 steps (owner) - needed only when inbox reading is switched on in Phase 5

Sending needs nothing new. For reading (Exchange Online PowerShell, as a Global/Exchange administrator; the service principal pointer from the SMTP setup already exists):

```powershell
Connect-ExchangeOnline
Get-Mailbox bookings@thabisomhlongo.com | Format-List Alias, PrimarySmtpAddress          # note the Alias (normally "bookings")
New-ManagementScope -Name "Website mailbox only" -RecipientRestrictionFilter "Alias -eq 'bookings'"
New-ManagementRoleAssignment -Name "Website app reads bookings inbox" -App <enterprise-app-object-id> `
    -Role "Application Mail.Read" -CustomResourceScope "Website mailbox only"
Test-ServicePrincipalAuthorization -Identity <enterprise-app-object-id> -Resource bookings@thabisomhlongo.com    # InScope should be True
```

1. Do **not** add `Mail.Read` under *API permissions* in Entra (it would be tenant-wide and cancel the scoping). `SMTP.SendAsApp` stays as is.
2. Changes apply after 30 minutes to 2 hours (Microsoft's permission cache); `Test-ServicePrincipalAuthorization` bypasses that cache.
3. Confirm with the site's own check (Phase 5 button, or `POST /api/admin/settings/m365/test-mailbox-read`): all three steps green.
4. If the scoped grant does not take effect for Graph calls in your tenant (community reports disagree, Microsoft's page says Graph is supported), the documented legacy
   alternative is: grant `Mail.Read` (application) in Entra + admin consent, then restrict it with an *Application Access Policy*
   (`New-ApplicationAccessPolicy -AppId <client-id> -PolicyScopeGroupId <mail-enabled security group containing only bookings@> -AccessRight RestrictAccess`) and verify with
   `Test-ApplicationAccessPolicy`.

**Not verified live yet:** the Graph token request and the inbox read against the real tenant (needs the Exchange role above and the live card's secret). The code paths are
proven against the fake servers only; the live check is the button/endpoint above.

Sources: [RBAC for Applications in Exchange Online](https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac) ·
[message: delta](https://learn.microsoft.com/en-us/graph/api/message-delta?view=graph-rest-1.0) ·
[SMTP AUTH Basic retirement timeline](https://techcommunity.microsoft.com/blog/exchange/updated-exchange-online-smtp-auth-basic-authentication-deprecation-timeline/4489835).

## Phase 3 - Contact form integration (2026-10-15)

### 3.1 New flow

`POST /send-email` (`routes/public/misc.js`) is now a thin route over **`lib/contact-intake.js`** (pure rules in `lib/contact-validation.js`):

1. **Validate on the server** (the browser checks stay as a courtesy): name 2-100, **exactly one** valid address (no `,` `;` spaces `<>"()` or CR/LF - a list can no longer
   turn the receipt into a mass mailing), phone optional but 7-15 digits (normalised), subject empty or 3-150, message 10-5000, category a plain label up to 60
   characters, POPIA consent required. Wrong types (arrays/objects) are a clean 400. Errors name the field and describe only the visitor's own input.
2. **Silent spam traps**: hidden field `contact_hp` (real visitors never fill it) and `form_started_at` (a submit under 2.5 s after the form appeared). Both are answered
   with an ordinary-looking success and save/send nothing, so bots learn nothing. Caveat: a determined bot can fake the timestamp; the honeypot catches the common ones.
3. **Duplicates and per-address cap**: the same message from the same address within 24 h returns the *original* reference (no second row, no second e-mail); identical
   submissions in flight at the same instant share one outcome; one address may send **3 different messages per hour** (then 429, friendly text). Separate per-IP limiter
   `contactRateLimiter` (5 per 15 min) so contact messages and booking submissions no longer share a budget.
4. **Persist first** (awaited). If the database fails the visitor gets a 503 and an honest message - nothing is claimed that did not happen, nothing is queued.
5. **Notify through the outbox**: the notification and the visitor receipt are queued durably (retried by the existing worker, paused on systemic Microsoft 365 faults).
   A Microsoft 365 outage delays mail and loses nothing; if even the outbox insert fails the inquiry is still saved, the form still succeeds, and the visitor is not promised a
   confirmation that was never queued.

### 3.2 Routing and content decisions

* **Recipient is decided on the server only**: Admin > Contact Details (`contact_info.email`), else the configured Microsoft 365 mailbox (`bookings@...`), else
  `admin@thabisomhlongo.com`. Whatever the browser sends (`recipientEmail`, `to`, `cc`) is ignored. **D1 is fixed**: the placeholder `thabiso@example.com` fallback is gone
  from `js/myscript.js`.
* The visitor's address is only the notification's **Reply-To** and the single recipient of their own receipt.
* "Booking Inquiry" (matched exactly, no longer "contains booking") **now creates an inquiry as well**, and still creates the legacy PENDING booking row (the booking pipeline
  is unchanged). The two are linked both ways (`inquiries.converted_booking_id` / `bookings.source_inquiry_id`) so Convert-to-Booking is not offered twice. D5 fixed.
* Mail content: same templates; the notification subject is `Website Inquiry: <subject> [INQ-000123]` and its card gains a **Reference** row; the receipt quotes the reference.
  Subjects are decoded plain text; every value placed in HTML is escaped by the handler itself (D3). Stored text follows the single-layer encoded convention.
* Outbox rows carry `related_entity` = `inquiry_intake` (notification) / `inquiry_receipt` (receipt) and `related_id` = the inquiry, so **persistence** (the inquiry row) and
  **delivery** (the `notifications` row status + `email_logs`) are separate, queryable facts. Admin replies keep using `inquiries`.
* The `[DEBUG] /send-email body` log (name, e-mail, phone, message on every submission) is gone; the intake logs `[contact] INQ-000123 saved ...` with no personal data.
* `js/myscript.js` (cache-bust `?v=1.9.7`): no recipient, no localStorage lookup, sends the trap fields, shows the server's reason for a 400/429/503 and the reference on success.

### 3.3 Verification

`test/contact-intake.test.js` (86 checks): validation rules (pure), the endpoint against the isolated test server (persist, routing, injection, header smuggling, escaping /
no double encoding, spam traps, duplicates + concurrency, per-address cap, Booking Inquiry link, no personal data in the log) and failure injection in a throwaway-DB child
(database failure, outbox failure, Microsoft 365 unreachable: both mails stay pending, attempts logged as failed, inquiry untouched), plus source scans. The existing
`test/inquiries.test.js` still passes (one seed message lengthened to the 10-character rule the form always had).

Known limits: the spam traps and the per-address cap do not replace a CAPTCHA (Cloudflare Turnstile would be the next step if abuse appears); the queue worker still logs
recipient addresses in its operational lines (`Successfully sent email #n to ...`).

## Phase 4 - Admin inquiries and reply workflow (2026-10-15)

### 4.1 What changed (D6, D7, D8, D13 fixed; D15 found and fixed)

* **D15 (found while testing in a real browser): the Reply button never linked the reply to its inquiry.** `js/admin/inquiries.js` set the inquiry context and *then* called
  `showInqComposeView()`, which reset it, so every reply written from this screen was saved with `inquiry_id = NULL` - a plain message. Consequences that had been silently true
  since the Inquiries screen was built: the inquiry was never marked replied by a real reply, `responded_at` / the SLA "overdue" flag never cleared, and the manager-only rule for
  inquiry replies did not apply (an assistant could send one). Fixed: the inquiry is passed in and set after the reset.
* **A reply is "sent" only when Microsoft 365 took it (D6).** `sendEmail()` only queues. `lib/direct-emails.js` now records the reply in the new **`inquiry_messages`** table
  (state *queued*, tied to its outbox row) and does **not** touch the inquiry. `lib/inquiry-messages.js reconcileDelivery()` - run after every outbox sweep and whenever a
  conversation is read - derives the state from the outbox: *sent* -> **accepted** (and only now the inquiry becomes **replied**, `responded_at` on the first reply, credited to the
  admin who wrote it); a failed try that will retry -> **attempted**; retries exhausted / 24-hour expiry / corrupt row / missing attachment -> **failed** (with the reason; the composer item
  is flagged *failed* so it can be sent again). A failed reply never changes the inquiry's status. Deriving from the outbox (rather than hooking each place the worker can succeed or fail)
  covers every path. Vocabulary: `queued, attempted, accepted, failed, bounced, received`. *"Confirmed in the inbox" does not exist* - an e-mail system cannot prove that; `accepted`
  (Microsoft 365 returned its 250 OK, recorded in `email_logs`) is the honest ceiling.
* **Recipients and ids cannot be forged (D8).** For a reply, `POST/PUT /api/admin/direct-emails` verifies the inquiry exists (404 / 400 otherwise) and **replaces To with the inquiry's own
  sender** - and `sendDirectEmail` enforces it again at send time, so even a hand-edited draft goes nowhere else. Cc/Bcc/Reply-To stay available but **every address on every compose** is
  validated server-side (exactly one mailbox per entry; no lists, display names or line breaks; max 20). An item already handed to the outbox is read-only (409) and cannot be sent twice.
* **Threading and matching**: the subject gets `[INQ-000123]`; the mail carries a Message-ID chosen in advance (stored on the conversation row), `In-Reply-To` / `References` once the thread has a
  known message, and `X-TM-Inquiry-Id`; Reply-To is the shared mailbox so the customer's answer arrives where the portal reads it (Phase 5).
* **History and audit (D7)**: each reply row records who sent it (`sent_by`, `sent_by_name`; a scheduled send credits whoever wrote the draft - `direct_emails.created_by`), when, the
  recipients, the Message-ID, attempts, last error and delivery state. The inquiry's `replied` change is audited by the existing trigger with the admin credited.
* **Failure is visible (D13)**: the composer says "queued", not "sent"; the conversation under the original message shows each reply with a badge (Queued / Retrying / Sent (accepted by
  Microsoft 365) / Failed + reason) and refreshes by itself while anything is pending; the list flags an inquiry whose last reply failed; managers/administrators get **Send again** (same
  conversation row, new outbox entry, same Message-ID). The composer locks the To box for a reply and escapes addresses in chips.
* **Endpoints and RBAC**: `GET /api/admin/inquiries/:id/messages` (any signed-in admin, like reading the inquiry); `POST /api/admin/inquiries/:id/messages/:mid/retry` (administrator/manager;
  the pair must belong together, else 404; only a *failed* reply, else 409); existing rules unchanged (status/assign/priority/bulk = manager+, delete = administrator, inquiry-linked
  compose/send = manager+). The inquiry list gains `last_reply_status`, `inbound_count` and `source`.
* **POPIA**: erasure requests, the 2-year retention sweep and the data-subject export all cover `inquiry_messages` (content and addresses redacted; the row, direction and delivery state stay
  for the audit trail; the export omits staff-side fields).

### 4.2 Verification

`test/inquiry-replies.test.js` (60 checks): a **child process with a throwaway DB, the real worker and a fake SMTP server** proves the delivery truth - happy path (forged To ignored, only the
sender received it, subject/Message-ID/X-TM-Inquiry-Id on the wire, accepted -> replied), recipient refused with retries exhausted (failed, inquiry still unread, every attempt in `email_logs`
as failed), *Send again* succeeding, an outage with automatic recovery, the 24-hour expiry, overlapping reconciles acting once (one `replied` in the audit trail), POPIA redaction - plus the HTTP
layer (forged ids, address validation, RBAC on every new endpoint, forged inquiry/message pairs, state rules, list flag, data export). `test/inquiries.test.js` CP12 now asserts the truthful
behaviour (not replied when merely queued, replied once accepted). `test/browser/contact-inquiries.js` (31 checks, real Chrome): public form -> reference -> admin list/source -> conversation ->
locked reply composer -> queued -> accepted -> Replied; a failed reply with reason and *Send again* (managers only); list flag; phone width.

## Phase 5 - Incoming mailbox sync (2026-10-15)

### 5.1 Decision

**Required, so built - but shipped OFF.** A reply sent from Admin > Inquiries goes out with Reply-To = the shared mailbox, so without this the customer's answer exists only in Outlook and
the conversation in the portal is half a conversation. It is implemented behind an administrator-controlled switch (default **off**) because turning it on needs a one-time Microsoft 365
permission only the owner can grant (section 2.4). Until then nothing contacts Microsoft for reading and nothing changes.

### 5.2 How it works (`lib/inbox-sync.js`, `lib/m365-graph.js`, `routes/admin/inbox-sync.js`)

* **Graph delta query** on the Inbox (`GET /users/{mailbox}/mailFolders/inbox/messages/delta`), `Prefer: odata.maxpagesize=25, outlook.body-content-type="text"` (plain text only - never HTML from a
  stranger), `$select` without attachments. The first run asks only for mail received **after the switch was flipped** (minus 15 minutes) - the mailbox's history is never imported. Graph's own
  checkpoint (`deltaLink`) is saved after every run in `inbox_sync_state`; a run cut off by the page budget (20 pages) saves the `nextLink` and continues next time; a lost checkpoint (410)
  triggers a harmless rescan from the baseline (message ids are unique, nothing is stored twice). The checkpoint belongs to one mailbox: pointing the site at another mailbox discards it.
  A stored checkpoint URL is refused unless it points at the same mailbox on Graph (so a tampered row cannot make the server call another host/mailbox).
* **Matching** (never on a tag alone): a `[INQ-000123]` tag in the subject attaches the message only if the **sender is that inquiry's customer or someone we wrote to** - a stranger quoting
  a tag cannot write into someone else's conversation (it becomes a new inquiry). With no usable tag, the sender's **one** open (not archived) inquiry from the last 60 days receives it; two or more
  is ambiguous, so a **new** inquiry (source `email`, category *Email*) is created rather than guessing. A customer replying again sets the inquiry **unread** (an archived one is reopened).
  Tags reach customers in the reply subject, the intake notification and the confirmation e-mail's subject.
* **Not customer messages**: our own mail (the intake alert lands in this inbox too), drafts, out-of-office / automatic replies, and delivery-failure notices. A failure notice that names one of our
  replies (Message-ID or tag) marks that reply **bounced** with the diagnostic line; unmatched notices are ignored.
* **Stored safely**: plain text, quoted history cut (conservative markers only), 20 000 characters at most, a note when the mail had attachments (they are not copied). Unique `message_id` /
  `graph_id`. The origin message of an email inquiry carries no text of its own in the conversation (it is the inquiry body), only its ids.
* **Polite and bounded**: one run at a time, every minute the scheduler checks whether a run is due (every 2 minutes; nothing when off), Graph `Retry-After` honoured, bounded retries
  (`lib/m365-graph.js`), then back-off: throttling 5 min, permission/credentials/mailbox problems 15 min, other failures 2-60 min exponential; last error and counters recorded. Logs carry counts
  only - never an address, subject or text.
* **Read-only and mailbox-pinned**: GET only; the mailbox is whatever the OAuth settings say and nothing else can be addressed. Nothing is ever marked read, moved or deleted in Outlook.

### 5.3 Administrator controls (Email (SMTP) card -> "Customer replies (inbox)"; all administrator-only)

`GET/PUT /api/admin/inbox-sync`, `POST /api/admin/inbox-sync/run`, plus the existing **Test inbox access** (`POST /api/admin/settings/m365/test-mailbox-read`). **Switching on is verify-before-enable**: it runs the three checks
(settings, Graph sign-in, inbox read) and refuses - with the failed step in plain words - if any fails. The change is audited (`audit_log`, who/when). The status shows last check, what the last run did,
and the last problem with when it will retry. The state lives in its own table, so the generic settings API (readable and writable by every admin role) cannot see or change it.

### 5.4 Verification

`test/inbox-sync.test.js` (45 checks): a child process with a throwaway DB, the real engine and a fake Microsoft sign-in + Graph server - matching rules (tag + owner, tag from a stranger, one open inquiry,
ambiguity, archived), ignored kinds, bounce marking, duplicates, HTML bodies, attachment note, request shape (baseline filter, text bodies, no expand, GET-only, mailbox-pinned), checkpoint + idempotence +
incremental pick-up, throttling/permission/server/410 handling with back-off, tampered checkpoint, mailbox change, 50-message paging over two runs, configuration resolved from the saved Email (SMTP)
settings end to end, mock mode refusing to contact Microsoft, no secret/token/checkpoint anywhere visible; plus the HTTP controls (roles, verify-before-enable, audit). Browser: the card's controls and an
inbound message rendered as plain text (`test/browser/contact-inquiries.js`).

**Not verified live**: the real Graph delta call against the owner's tenant (needs the Exchange role of section 2.4). The first live action is the card's *Test inbox access*.

## Phase 6 - Database, audit and reliability (2026-10-15)

### 6.1 Schema (all additive; nothing existing was altered)

| Object | Purpose |
|---|---|
| `inquiry_messages` (new) | One row per e-mail in a conversation: `direction` (`out` admin reply / `in` customer), `source` (`admin_reply` / `mailbox`), RFC `message_id`, Graph `graph_id`, `in_reply_to`, addresses, subject, `body_html` (sanitised, outbound) / `body_text` (plain, inbound), `direct_email_id`, `notification_id`, `delivery_status`, `attempts`, `last_error`, `sent_by` / `sent_by_name`, `occurred_at`, `accepted_at`. |
| constraints | CHECKs on direction/source/status and on the combination (outbound is never `received`, inbound is always `received`); UNIQUE `message_id` and UNIQUE `graph_id` (partial: only where set); FK to the inquiry (CASCADE), to the outbox row and composer item (SET NULL), to the admin (SET NULL). |
| indexes | `(inquiry_id, occurred_at)`, `(notification_id)`, partial `(delivery_status)` for open rows, the two unique indexes. |
| `inbox_sync_state` (new) | Single row (CHECK id = 1): switch, mailbox, checkpoint, baseline, last run/success/error, failure count, retry-after, last stats, who enabled it. |
| `inquiries.source` (column) | `web_form` (also what older rows read as) or `email`. |
| `direct_emails.created_by` (column) | Who wrote the draft (a scheduled send has no session). |
| `notifications.related_entity` values | `inquiry_intake`, `inquiry_receipt` (new), `inquiries` (replies, existing) - the outbox rows are the delivery record of the intake mails; indexed already (`related_entity, related_id`). |
| migrations | 102 `inquiry_messages_conversation_and_delivery`, 103 `inquiries_source_and_direct_emails_created_by`, 104 `inbox_sync_state` - `CREATE ... IF NOT EXISTS` / duplicate-column-tolerant `ALTER`, safe at every boot. |

### 6.2 Delivery-state model

`queued` (in the outbox) -> `attempted` (a try failed, will retry) -> `accepted` (Microsoft 365 took it - recorded with its own reply in `email_logs`) | `failed` (gave up: 3 tries, 24-hour expiry, corrupt row,
missing attachment) | `bounced` (a delivery-failure notice came back); inbound rows are `received`. There is deliberately **no "confirmed in the inbox"**: e-mail cannot prove that. Persistence (the inquiry row)
and delivery (the outbox rows) are separate facts and are shown separately: the conversation panel shows the state of the alert to the booking mailbox and the confirmation to the sender next to the replies.

### 6.3 Reliability and audit

* Retries are safe: the outbox retries 3 times (existing), pauses on systemic Microsoft 365 faults and resumes when settings are saved; a failed reply is re-sent through the *same* conversation row and Message-ID
  (*Send again*); every attempt is in `email_logs` (failed attempts are never logged as success); reconciliation transitions are guarded so overlapping runs act once.
* Audit: the inquiry's `replied`/`unread` changes go through the existing audit trigger with the acting admin; replies record sender and time on the row; the sync switch is audited; the intake record carries
  consent, timestamp, IP and user agent (existing columns).
* Privacy: `inquiry_messages` is covered by the POPIA erasure, the 2-year retention sweep and the data-subject export; no token, secret, checkpoint URL or message text is logged or returned by any status API.

### 6.4 Verification

`test/m365-schema.test.js` (22 checks): objects, uniqueness, CHECK and FK behaviour (cascade / set-null) enforced by the database itself, query plans use the indexes, and **booting the server again on the same database
leaves the schema, migration rows and data untouched** (plus foreign-key and integrity checks).

## Phase 7 - End-to-end tests and regression (2026-10-16)

### 7.1 Coverage against the brief (all mocked: fake SMTP / sign-in / Graph servers and throwaway databases - no real customer, mailbox or tenant is ever contacted)

| Area in the brief | Where it is proven |
|---|---|
| Validation, injection, header smuggling, escaping | `contact-intake.test.js` (pure rules + endpoint), `inquiry-replies.test.js` (address validation on every compose) |
| Spam, duplicates, rate limits | `contact-intake.test.js`: honeypot, too-fast, replay, concurrent identical submits, 3-per-hour cap |
| Microsoft 365 auth / consent / token expiry / API failures | `graph.test.js` (403 missing role, 404, 410, 429 + Retry-After, 5xx, network drop, 401 renewal once, wrong secret), `inbox-sync.test.js` (back-off, systemic faults), `smtp.test.js` (existing OAuth transport: 157 checks) |
| Admin roles | RBAC on every new endpoint (`graph`, `inquiry-replies`, `inbox-sync` suites) + existing `rbac.test.js` / `inquiries.test.js` |
| Replies, status, history, failure handling | `inquiry-replies.test.js` (child with the real worker + fake SMTP: accepted -> replied, refused -> failed and never replied, Send again, outage + recovery, 24-hour expiry), `test/browser/contact-inquiries.js` in real Chrome |
| Inbound sync, dedupe, paging, checkpoints | `inbox-sync.test.js` (45 checks) |
| Database failure / network / retry | `contact-intake.test.js` child: DB failure -> 503 and nothing queued; outbox failure -> inquiry still saved; Microsoft 365 unreachable -> mails stay pending |
| Templates, sender, Reply-To | child S1: From (name + mailbox), Reply-To, subject tag, Message-ID, `X-TM-Inquiry-Id` on the wire; intake mail content and escaping in `contact-intake.test.js` |
| Audit and sensitive data | no secret/token/checkpoint in any result or status; no submitted text in the server log; `replied` audited once with the admin; switch audited; POPIA erasure/retention/export cover the conversation |
| Schema and migrations | `m365-schema.test.js` (22 checks) incl. restart on the same database |
| Existing booking / quote / invoice / payment / calendar / notification flows | the complete existing suite, unchanged except where noted below |

### 7.2 Results

* **Backend, full suite (1523 checks, stored-text run with the date shift described below): 1521 passed on the last complete run.** The two failures were `GET /favicon.ico` (`favicon.ico` was deleted from the working
  tree by another session - not part of this work) and one assertion in my own `graph.test.js` that compared two randomly-jittered back-off waits. That assertion was rewritten to bound each wait by its own doubling step and the
  suite re-run five times in a row (235/235), so everything passes except the favicon check.
* **Browser (real Chrome)**: `contact-inquiries.js` 31/31 (public form incl. hidden trap field, server-side refusal shown to the visitor, reference, admin list/source, conversation, locked reply recipient, queued -> accepted -> Replied, failed reply with reason and Send again for managers only, plain-text rendering of a customer's answer, the Customer-replies controls, phone width); `smtp-settings.js` 31/31 (the Email card still works with the new block).
* **Browser failures that are NOT from this work** (reproduced on a pure checkout of HEAD using the same development database): `slots.js` and `form.js` stop at the booking drawer's step 2 button, `calendar.js` 2 "reserved date" checks, `public-sections.js` 13 gallery-pagination checks - all depend on the content of the development database (its WAL holds newer live data than its main file); `favicon.js` 2 checks (the deleted `favicon.ico`).
* **Date-dependent existing test**: `stored-text.test.js` books today + 70 days. On 2026-10-16 that is 25 December 2026, a date the development database already holds CONFIRMED bookings on, so the suite throws (and `test/run.js` then aborts the remaining suites). Run with that one date shifted by a day (scratch copy) it passes 34/34; it will pass unmodified again from 2026-10-17.

### 7.3 Existing tests changed, and why

* `test/inquiries.test.js`: one seed message lengthened to the 10-character minimum the form always enforced (the server now enforces it too); CP12 now asserts the truthful behaviour - a reply does **not** mark the inquiry replied when merely queued, and does once the outbox has accepted it (the outbox row is flipped directly so the test does not depend on how long the queue is; the real worker path is proven in `inquiry-replies.test.js`).
* `test/fake-smtp.js`: new optional `rejectRcpt` (refuse a recipient like Exchange does); `test/browser/run-all.js`: lists the new browser test.

### 7.4 Defects the tests caught while this was being built (all fixed)

The Reply button never linked a reply to its inquiry (D15); the Inquiries screen showed entity-encoded text (`O&#x27;Brien`); the queue worker's outcome writes were fire-and-forget, so an immediate read of the outbox could still see `pending`; a test cleanup left dangling links (raw handle without foreign keys); my own suites would have left ~60 pending mails in front of later suites; a blocking `spawnSync` starved the shared keep-alive sockets (`fetch failed`).

## Phase 8 - Deployment and handover (2026-10-16)

### 8.1 The finished picture

```
Visitor -> index.html #contactForm -> POST /send-email
             validate (server) -> spam traps -> duplicate / per-address checks
             -> SAVE inquiry (awaited; 503 if it cannot be saved)  [+ legacy booking row, linked, for "Booking Inquiry"]
             -> queue 2 mails in the outbox: alert to Admin > Contact Details (else the Microsoft 365 mailbox) with Reply-To = visitor, and a confirmation to the visitor
Outbox worker (every 20 s) -> SMTP + XOAUTH2 to smtp.office365.com as bookings@ -> email_logs (accepted / failed)
Admin > Inquiries -> Conversation (replies: queued / retrying / sent (accepted by Microsoft 365) / failed / bounced; customer answers) -> Reply (To locked to the sender)
Inbox sync (OFF by default; administrator switch, verify-before-enable) -> Graph delta, read-only, one mailbox -> answers attach to their inquiry, new mail becomes an inquiry (source Email)
```

### 8.2 What the owner must do in Microsoft 365 / on the live site

| # | Where | Action | Needed for |
|---|---|---|---|
| 1 | Live admin > System Settings > Email (SMTP) | Choose **Microsoft 365 OAuth**, enter mailbox, tenant ID, application ID and a **new** client secret (the earlier one was pasted in chat - create a new one, delete the old), Test Connection, Save, Send Test. Until this is saved, live mail still uses the legacy Gmail pair. | everything that sends |
| 2 | Live admin > Contact Details | Set the email to **bookings@thabisomhlongo.com** (the website alert goes to this address; if it is empty or invalid the site falls back to the Microsoft 365 mailbox, then `admin@thabisomhlongo.com`). | alerts to the booking mailbox |
| 3 | Calendar | Put the client secret's **expiry date** in a calendar (when it expires all mail stops; the card says "client secret has expired"). | continuity |
| 4 | Exchange Online PowerShell (only if you want customer replies in the portal) | The four commands in section 2.4 (management scope for `bookings@` only, `Application Mail.Read` role assignment to the existing service principal, `Test-ServicePrincipalAuthorization`). **Do not** add `Mail.Read` in Entra API permissions. Wait up to 2 hours. | inbox sync |
| 5 | Live admin > Email (SMTP) card > Customer replies (inbox) | **Test inbox access** (all three steps green), then **Switch on**. | inbox sync |
| 6 | Gmail (or any outside mailbox) | Open a delivered message > Show original: SPF, DKIM and DMARC should read PASS (DNS and DKIM were set up earlier). | confidence in deliverability |

### 8.3 Configuration reference (no secrets)

* **No new production environment variable.** Sending and reading use the Email (SMTP) card (`settings.smtp_*`, secret AES-256-GCM encrypted with `SETTINGS_ENCRYPTION_KEY`, falling back to `SESSION_SECRET`) or the existing `SMTP_*` variables from `.env.example`:
  ```
  SMTP_HOST=smtp.office365.com   SMTP_PORT=587   SMTP_SECURE=starttls
  SMTP_USER=bookings@<your-domain>   SMTP_FROM=bookings@<your-domain>   SMTP_FROM_NAME=<display name>
  SMTP_AUTH=oauth   SMTP_OAUTH_TENANT_ID=<tenant GUID>   SMTP_OAUTH_CLIENT_ID=<application GUID>   SMTP_OAUTH_CLIENT_SECRET=<secret value>
  ```
* Test-only (ignored or restricted in production): `SMTP_OAUTH_AUTHORITY`, `M365_GRAPH_BASE_URL`, `SMTP_MOCK=true`.
* **Development vs production**: keep them apart. Local runs use `SMTP_MOCK=true` (the Graph client and the sync refuse to contact Microsoft in mock mode); never save the live secret on a developer machine or in `.env`; if a development tenant is ever used, give it its own app registration and secret. The dev database holds real pending notifications - never point it at the live mailbox.
* Graph permissions: **none consented in Entra**. Sending = `SMTP.SendAsApp` + Exchange `FullAccess` on the one mailbox (done). Reading = Exchange RBAC `Application Mail.Read` scoped to the one mailbox (section 2.4).

### 8.4 Deploying, migrating, rolling back

* **Deploy**: push; Render restarts; the additive migrations (102-104) run at boot (`CREATE ... IF NOT EXISTS`, duplicate-column-tolerant `ALTER`). Nothing is rewritten; existing inquiries read as source `web_form`. Browsers pick up the changed scripts through new cache-bust parameters (`myscript.js?v=1.9.7`, `inquiries.js?v=2`, `system-settings.js?v=smtp3`).
* **Order of switching on**: (1) Email card saved + tested, (2) Contact Details, (3) submit the website form with your own address and check both mails, (4) reply from Inquiries and watch the conversation reach *Sent (accepted by Microsoft 365)*, (5) only then the optional inbox sync.
* **Rollback**: revert the commit. The new tables/columns are harmless to older code and can stay; replies already queued remain in `notifications`. To stop reading the mailbox without a deploy: Email card > Switch off (or `UPDATE inbox_sync_state SET enabled = 0`). Dropping `inquiry_messages` / `inbox_sync_state` is possible but loses the reply history.

### 8.5 Verifying it live, and troubleshooting

| Symptom | Likely cause / what to check |
|---|---|
| A website message appears in Inquiries but no alert reaches the booking mailbox | The conversation panel's "Alert to ..." badge says why (Failed + reason, or Queued while the mail server is down). Check Admin > Email Logs; check the Email card status; check Contact Details address. |
| Badge stays *Queued* | The outbox pauses on a mail-server fault the administrator must fix (credentials, secret expired, SMTP AUTH disabled): the Email card status and Email Logs say which. It resumes when the settings are saved. |
| Reply shows *Failed* with `5.7.60` / `5.7.57` | The mailbox may not send as the From address / authenticated SMTP disabled for the mailbox - see docs-internal/smtp-email.md error map. Fix, then **Send again**. |
| Reply shows *Bounced* | The customer's server refused it after Microsoft accepted it (a delivery-failure notice was read from the inbox): check the address. |
| Test inbox access: step 2 fails | Microsoft would not issue a Graph token: wrong tenant/application ID, expired or wrong secret (the message carries the AADSTS code). |
| Test inbox access: step 3 fails with 403 | The Exchange role is missing or not yet applied (allow 2 hours); run `Test-ServicePrincipalAuthorization`; make sure Entra has no unscoped `Mail.Read` if scoping is wanted. |
| A customer's answer shows up as a **new** inquiry instead of in the conversation | Their reply came from a different address than the one they wrote with, or they have two open inquiries and the subject tag was removed - deliberately never guessed. |
| Sync says *throttled* / *server* | Temporary; it backs off and retries by itself. |
| Sync keeps saying the checkpoint was dropped | Harmless: it rescans from the baseline; nothing is stored twice. |

### 8.6 Known limitations and next steps

* Spam control is honeypot + timing + limits + duplicates, not a CAPTCHA (Cloudflare Turnstile is the next step if abuse appears).
* "Delivered to the inbox" cannot be proven; *accepted by Microsoft 365* is the honest ceiling, plus *bounced* when a failure notice comes back.
* The inbox sync is verified against fake servers only until the owner completes the Exchange step and runs *Test inbox access* live.
* The queue worker's operational log lines still print recipient addresses (existing behaviour).
* Attachments from customers are not copied into the portal (a note says they exist; open them in Outlook).
* The stored-text suite books today + 70 days and collides with an existing booking on 25 December 2026 (a date-dependent test fragility that will clear by itself; unrelated to this work).
